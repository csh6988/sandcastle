import type { BoardStore, BoardTaskRecord } from "./BoardStore.js";

/** A resolved JSON API response. */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Launches a board task into per-repo runs. Injected to keep the router decoupled from the orchestration core. */
export type TaskLauncher = (task: BoardTaskRecord) => void;

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
