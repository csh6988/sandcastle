import type { RunEvent } from "../RunEvent.js";
import {
  BoardStore,
  createRunRecorder,
  type BoardTaskPlan,
  type BoardTaskRecord,
} from "./BoardStore.js";
import type { TaskLauncher } from "./router.js";

/** Minimal result shape the launcher needs from a workspace task run. */
export interface TaskRunResult {
  readonly repositories: Record<string, { readonly status: string }>;
  /** The workspace plan, when the runner produced one. */
  readonly plan?: BoardTaskPlan;
  /** Non-terminal result used by workflow-backed tasks that paused. */
  readonly status?: "awaiting-approval";
}

/**
 * Runs a board task as a multi-repo workspace task. Injected so the board
 * stays decoupled from the orchestration core: the CLI binds the real
 * `runWorkspaceTask` (with the resolved agent, sandbox, and repositories)
 * and forwards per-repo run events via `onRepoRunEvent`.
 */
export type TaskRunner = (args: {
  readonly taskId: string;
  readonly prompt: string;
  readonly title: string;
  readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
  /** Invoked as soon as the planner produces a plan, before execution. */
  readonly onPlan: (plan: BoardTaskPlan) => void;
}) => Promise<TaskRunResult>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Build a {@link TaskLauncher} that, on task creation, kicks off a workspace
 * task run, records each repository's run-event stream into the store (linked
 * to the task), and folds the final outcome back into the task status.
 *
 * The run is fire-and-forget: the board API responds as soon as the task is
 * created, and progress streams in over SSE.
 */
export const createTaskLauncher = (deps: {
  readonly store: BoardStore;
  readonly run: TaskRunner;
}): TaskLauncher => {
  return (task: BoardTaskRecord) => {
    deps.store.updateTask(task.id, { status: "running" });

    const recorders = new Map<string, (event: RunEvent) => void>();
    const onRepoRunEvent = (repo: string, event: RunEvent) => {
      let recorder = recorders.get(repo);
      if (!recorder) {
        recorder = createRunRecorder(deps.store, { taskId: task.id, repo });
        recorders.set(repo, recorder);
      }
      recorder(event);
    };

    const onPlan = (plan: BoardTaskPlan) => {
      deps.store.updateTask(task.id, { plan });
    };

    deps
      .run({
        taskId: task.id,
        prompt: task.prompt,
        title: task.title,
        onRepoRunEvent,
        onPlan,
      })
      .then((result) => {
        if (result.status === "awaiting-approval") {
          deps.store.updateTask(task.id, {
            workflow: {
              status: "awaiting-approval",
              checkpointThreadId: task.id,
              message: "Workspace plan is waiting for approval.",
              updatedAt: new Date().toISOString(),
            },
            ...(result.plan ? { plan: result.plan } : {}),
          });
          return;
        }

        const failed = Object.values(result.repositories).some(
          (r) => r.status === "failed",
        );
        deps.store.updateTask(task.id, {
          status: failed ? "failed" : "succeeded",
          finishedAt: new Date().toISOString(),
          ...(result.plan ? { plan: result.plan } : {}),
        });
      })
      .catch((error: unknown) => {
        deps.store.updateTask(task.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: errorMessage(error),
        });
      });
  };
};
