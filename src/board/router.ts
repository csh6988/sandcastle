import type {
  BoardStore,
  BoardTaskRecord,
  BoardTaskWorkflowPhase,
} from "./BoardStore.js";
import { boardTaskView } from "./BoardStore.js";
import { recoverableFailedTaskPhase } from "./langGraphTaskRunner.js";
import {
  listBoardTaskBranchMergeOptions,
  mergeBoardTaskBranch,
} from "./taskBranchMerge.js";
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
export interface TaskPhaseCompletionOptions {
  readonly workspacePlanText?: string;
}
/** Completes an interactive workflow phase and advances the workflow. */
export type TaskPhaseCompleter = (
  task: BoardTaskRecord,
  phase: BoardTaskWorkflowPhase,
  options?: TaskPhaseCompletionOptions,
) => void;
/** Recovers a failed task whose persisted failure is a workflow phase pause. */
export type TaskRecoverer = (task: BoardTaskRecord) => void;
/** Cancels a running workflow task. */
export type TaskCanceler = (task: BoardTaskRecord) => void;
/** Starts an agent run that resolves a conflicted Board branch merge. */
export type TaskBranchMergeConflictResolver = (
  task: BoardTaskRecord,
  args: {
    readonly repository: string;
    readonly targetBranch: string;
  },
) => void;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});

const WORKFLOW_PHASES = new Set<string>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
  "awaiting-approval",
  "running",
  "verifying",
]);

const parseWorkflowPhase = (
  value: string,
): BoardTaskWorkflowPhase | undefined =>
  WORKFLOW_PHASES.has(value) ? (value as BoardTaskWorkflowPhase) : undefined;

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
  completePhase?: TaskPhaseCompleter,
  recoverTask?: TaskRecoverer,
  cancelTask?: TaskCanceler,
  defaultRepoDir: string = process.cwd(),
  resolveBranchMergeConflict?: TaskBranchMergeConflictResolver,
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
    return json(200, store.listTasks().map(boardTaskView));
  }

  const taskProgressMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/progress$/);
  if (method === "GET" && taskProgressMatch) {
    const id = decodeURIComponent(taskProgressMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    const markdown = store.readTaskProgress(id);
    return markdown !== undefined
      ? json(200, { markdown })
      : json(404, { error: "task progress not found" });
  }

  const taskVerificationMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/verification$/,
  );
  if (method === "GET" && taskVerificationMatch) {
    const id = decodeURIComponent(taskVerificationMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    const markdown = store.readTaskVerification(id);
    return markdown !== undefined
      ? json(200, { markdown })
      : json(404, { error: "task verification not found" });
  }

  const taskArtifactsMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/artifacts$/,
  );
  if (method === "GET" && taskArtifactsMatch) {
    const id = decodeURIComponent(taskArtifactsMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    return json(200, { artifacts: store.listTaskArtifacts(id) });
  }

  const taskBranchMergeMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/branch-merge$/,
  );
  if (taskBranchMergeMatch) {
    const id = decodeURIComponent(taskBranchMergeMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (method === "GET") {
      try {
        return json(
          200,
          listBoardTaskBranchMergeOptions({
            task,
            runs: store.listRuns().filter((run) => run.taskId === task.id),
            defaultRepoDir,
          }),
        );
      } catch (error) {
        return json(409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (method === "POST") {
      let payload: unknown;
      try {
        payload = await parseBody();
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const { repository, targetBranch } = (payload ?? {}) as {
        repository?: unknown;
        targetBranch?: unknown;
      };
      if (typeof repository !== "string" || repository.trim().length === 0) {
        return json(400, { error: "repository is required" });
      }
      if (
        typeof targetBranch !== "string" ||
        targetBranch.trim().length === 0
      ) {
        return json(400, { error: "targetBranch is required" });
      }
      try {
        return json(
          200,
          mergeBoardTaskBranch({
            task,
            runs: store.listRuns().filter((run) => run.taskId === task.id),
            repository: repository.trim(),
            targetBranch: targetBranch.trim(),
            defaultRepoDir,
          }),
        );
      } catch (error) {
        return json(409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return json(405, { error: "method not allowed" });
  }

  const taskBranchMergeResolveMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/branch-merge\/resolve$/,
  );
  if (taskBranchMergeResolveMatch) {
    const id = decodeURIComponent(taskBranchMergeResolveMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (method !== "POST") return json(405, { error: "method not allowed" });
    if (!resolveBranchMergeConflict) {
      return json(409, {
        error: "branch merge conflict resolution is not enabled",
      });
    }
    let payload: unknown;
    try {
      payload = await parseBody();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const { repository, targetBranch } = (payload ?? {}) as {
      repository?: unknown;
      targetBranch?: unknown;
    };
    if (typeof repository !== "string" || repository.trim().length === 0) {
      return json(400, { error: "repository is required" });
    }
    if (typeof targetBranch !== "string" || targetBranch.trim().length === 0) {
      return json(400, { error: "targetBranch is required" });
    }
    try {
      resolveBranchMergeConflict(task, {
        repository: repository.trim(),
        targetBranch: targetBranch.trim(),
      });
    } catch (error) {
      return json(409, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return json(202, { status: "started" });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const id = decodeURIComponent(taskMatch[1]!);
    const task = store.getTask(id);
    return task
      ? json(200, boardTaskView(task))
      : json(404, { error: "task not found" });
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

  const taskRecoverMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/recover$/);
  if (method === "POST" && taskRecoverMatch) {
    const id = decodeURIComponent(taskRecoverMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    const phase = recoverableFailedTaskPhase(task);
    if (!phase) return json(409, { error: "task failure is not recoverable" });
    if (!recoverTask) {
      return json(409, { error: "task recovery is not enabled" });
    }
    recoverTask(task);
    return json(202, { status: "recovering", phase });
  }

  const taskCancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (method === "POST" && taskCancelMatch) {
    const id = decodeURIComponent(taskCancelMatch[1]!);
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (task.status !== "running") {
      return json(409, { error: "task is not running" });
    }
    if (!cancelTask) {
      return json(409, { error: "task cancellation is not enabled" });
    }
    cancelTask(task);
    return json(202, { status: "cancelling" });
  }

  const phaseTerminalMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/phases\/([^/]+)\/terminal(\/resize)?$/,
  );
  if (phaseTerminalMatch) {
    const id = decodeURIComponent(phaseTerminalMatch[1]!);
    const phase = parseWorkflowPhase(
      decodeURIComponent(phaseTerminalMatch[2]!),
    );
    if (!phase) return json(404, { error: "phase not found" });
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (!terminalManager) {
      return json(409, { error: "interactive terminal is not enabled" });
    }
    if (method === "GET" && !phaseTerminalMatch[3]) {
      return json(
        200,
        terminalManager.getPhase(id, phase) ?? { status: "not-started" },
      );
    }
    if (method === "POST" && phaseTerminalMatch[3] === "/resize") {
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
      return terminalManager.resizePhase(id, phase, cols, rows)
        ? json(202, { status: "resized" })
        : json(409, { error: "terminal session is not running" });
    }
    return json(405, { error: "method not allowed" });
  }

  const phaseCompleteMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/phases\/([^/]+)\/complete$/,
  );
  if (method === "POST" && phaseCompleteMatch) {
    const id = decodeURIComponent(phaseCompleteMatch[1]!);
    const phase = parseWorkflowPhase(
      decodeURIComponent(phaseCompleteMatch[2]!),
    );
    if (!phase) return json(404, { error: "phase not found" });
    const task = store.getTask(id);
    if (!task) return json(404, { error: "task not found" });
    if (!completePhase) {
      return json(409, { error: "phase completion is not enabled" });
    }
    let payload: unknown;
    try {
      payload = await parseBody();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const body = (payload ?? {}) as {
      workspacePlan?: unknown;
      workspacePlanText?: unknown;
    };
    const workspacePlanText =
      typeof body.workspacePlanText === "string"
        ? body.workspacePlanText
        : body.workspacePlan !== undefined
          ? `<workspace_plan>${JSON.stringify(body.workspacePlan)}</workspace_plan>`
          : undefined;
    completePhase(task, phase, { workspacePlanText });
    return json(202, { status: "completing" });
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
    return json(201, boardTaskView(task));
  }

  return json(404, { error: "not found" });
};
