import type { BoardStore, BoardTaskRecord } from "./BoardStore.js";
import type { BoardTerminalManager } from "./terminalSession.js";

/** A resolved JSON API response. */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Launches a board task into per-repo runs. Injected to keep the router decoupled from the orchestration core. */
export type TaskLauncher = (task: BoardTaskRecord) => void;
/** Resumes a paused board task workflow after a human decision. */
export type TaskResumer = (
  task: BoardTaskRecord,
  decision: "approve" | "reject",
) => void;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});

/**
 * Route a board API request. Pure with respect to I/O beyond the store and the
 * injected launcher, so it can be tested without a live socket.
 *
 * Returns `undefined` for paths the API does not own (e.g. static asset
 * requests), letting the HTTP layer fall through to serving the frontend.
 */
export const routeApi = async (
  store: BoardStore,
  method: string,
  pathname: string,
  parseBody: () => Promise<unknown>,
  launchTask?: TaskLauncher,
  resumeTask?: TaskResumer,
  terminalManager?: BoardTerminalManager,
): Promise<ApiResponse | undefined> => {
  if (!pathname.startsWith("/api/")) return undefined;

  if (method === "GET" && pathname === "/api/runs") {
    return json(200, store.listRuns());
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)(\/events|\/usage)?$/);
  if (method === "GET" && runMatch) {
    const id = decodeURIComponent(runMatch[1]!);
    const run = store.getRun(id);
    if (!run) return json(404, { error: "run not found" });
    if (runMatch[2] === "/events") {
      return json(200, store.getEvents(id));
    }
    if (runMatch[2] === "/usage") {
      return json(200, store.aggregateUsageByModel(id));
    }
    return json(200, run);
  }

  if (method === "GET" && pathname === "/api/tasks") {
    return json(200, store.listTasks());
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const id = decodeURIComponent(taskMatch[1]!);
    const task = store.getTask(id);
    return task ? json(200, task) : json(404, { error: "task not found" });
  }

  const taskResumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  if (method === "POST" && taskResumeMatch) {
    const id = decodeURIComponent(taskResumeMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (!resumeTask) return json(409, { error: "task resume is not enabled" });
    let payload: unknown;
    try {
      payload = await parseBody();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const decision = (payload as { decision?: unknown } | undefined)?.decision;
    if (decision !== "approve" && decision !== "reject") {
      return json(400, { error: "decision must be approve or reject" });
    }
    resumeTask(task, decision);
    return json(202, { status: "resuming" });
  }

  const taskTerminalMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/terminal(\/resize)?$/,
  );
  if (taskTerminalMatch) {
    const id = decodeURIComponent(taskTerminalMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (!terminalManager) {
      return json(409, { error: "interactive terminal is not enabled" });
    }
    if (method === "GET" && !taskTerminalMatch[2]) {
      return json(200, terminalManager.get(id) ?? { status: "not-started" });
    }
    if (method === "POST" && taskTerminalMatch[2] === "/resize") {
      let payload: unknown;
      try {
        payload = await parseBody();
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const { cols, rows } = (payload ?? {}) as {
        cols?: unknown;
        rows?: unknown;
      };
      if (typeof cols !== "number" || typeof rows !== "number") {
        return json(400, { error: "cols and rows must be numbers" });
      }
      return terminalManager.resize(id, cols, rows)
        ? json(202, { status: "resized" })
        : json(409, { error: "terminal session is not running" });
    }
    return json(405, { error: "method not allowed" });
  }

  if (method === "POST" && pathname === "/api/tasks") {
    let payload: unknown;
    try {
      payload = await parseBody();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const { title, prompt } = (payload ?? {}) as {
      title?: unknown;
      prompt?: unknown;
    };
    if (typeof title !== "string" || title.trim().length === 0) {
      return json(400, { error: "title is required" });
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return json(400, { error: "prompt is required" });
    }
    const task = store.createTask({ title: title.trim(), prompt });
    if (launchTask) {
      try {
        launchTask(task);
      } catch {
        // Launch failures are reflected via task status updates, not here.
      }
    }
    return json(201, task);
  }

  return json(404, { error: "not found" });
};
