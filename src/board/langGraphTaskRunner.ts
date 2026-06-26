import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  createRunRecorder,
  type BoardStore,
  type BoardTaskPlan,
} from "./BoardStore.js";
import type { TaskRunner, TaskRunResult } from "./launchTask.js";
import type { RunEvent } from "../RunEvent.js";
import type {
  WorkspaceTaskPlan,
  WorkspaceTaskRepositoryResult,
} from "../runWorkspaceTask.js";

type ApprovalDecision = "approve" | "reject";
type WorkflowStatus =
  | "planning"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed";

interface WorkflowState {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly plan?: WorkspaceTaskPlan;
  readonly repositories: Record<string, WorkspaceTaskRepositoryResult>;
  readonly retryCount: number;
  readonly status: WorkflowStatus;
  readonly error?: string;
}

interface WorkflowCallbacks {
  readonly onPlan: (plan: BoardTaskPlan) => void;
  readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
}

export interface LangGraphPlanResult {
  readonly plan: WorkspaceTaskPlan;
  readonly plannerStdout: string;
}

export interface LangGraphTaskWorkflow {
  readonly run: TaskRunner;
  resume(
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskRunResult | undefined>;
}

export interface CreateLangGraphTaskWorkflowOptions {
  readonly store: BoardStore;
  readonly checkpointPath: string;
  readonly maxRepoRetries?: number;
  readonly plan: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly onPlannerRunEvent: (event: RunEvent) => void;
  }) => Promise<LangGraphPlanResult>;
  readonly execute: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly plan: WorkspaceTaskPlan;
    readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
  }) => Promise<Record<string, WorkspaceTaskRepositoryResult>>;
}

const workflowNow = () => new Date().toISOString();

export const workspacePlanToBoardPlan = (
  plan: WorkspaceTaskPlan,
): BoardTaskPlan => ({
  ...(plan.alignment?.summary
    ? { alignmentSummary: plan.alignment.summary }
    : {}),
  ...(plan.technicalPlan ? { technicalPlan: plan.technicalPlan } : {}),
  ...(plan.workspace
    ? {
        workspace: {
          ...(plan.workspace.branchPrefix
            ? { branchPrefix: plan.workspace.branchPrefix }
            : {}),
          ...(plan.workspace.maxIterations !== undefined
            ? { maxIterations: plan.workspace.maxIterations }
            : {}),
          repositories: plan.workspace.repositories.map((repo) => ({
            name: repo.name,
            cwd: repo.cwd,
            ...(repo.kind ? { kind: repo.kind } : {}),
            ...(repo.description ? { description: repo.description } : {}),
            ...(repo.copyToWorktree
              ? { copyToWorktree: repo.copyToWorktree }
              : {}),
            ...(repo.branchStrategy
              ? { branchStrategy: repo.branchStrategy }
              : {}),
          })),
        },
      }
    : {}),
  repositories: plan.repositories.map((repo) => ({
    name: repo.name,
    task: repo.task,
    ...(repo.reason ? { reason: repo.reason } : {}),
  })),
});

const hasFailedRepository = (
  repositories: Record<string, WorkspaceTaskRepositoryResult>,
): boolean =>
  Object.values(repositories).some((repo) => repo.status === "failed");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createLangGraphTaskWorkflow = (
  options: CreateLangGraphTaskWorkflowOptions,
): LangGraphTaskWorkflow => {
  const checkpointer = SqliteSaver.fromConnString(options.checkpointPath);
  const callbacksByTask = new Map<string, WorkflowCallbacks>();
  const maxRepoRetries = options.maxRepoRetries ?? 1;

  const updateWorkflow = (
    taskId: string,
    patch: {
      readonly status: WorkflowStatus;
      readonly retryCount?: number;
      readonly message?: string;
      readonly error?: string;
    },
  ) => {
    options.store.updateTask(taskId, {
      workflow: {
        status: patch.status,
        checkpointThreadId: taskId,
        ...(patch.retryCount !== undefined
          ? { retryCount: patch.retryCount }
          : {}),
        ...(patch.message ? { message: patch.message } : {}),
        ...(patch.error ? { error: patch.error } : {}),
        updatedAt: workflowNow(),
      },
    });
  };

  const createStoreCallbacks = (taskId: string): WorkflowCallbacks => {
    const recorders = new Map<string, (event: RunEvent) => void>();
    const onRepoRunEvent = (repo: string, event: RunEvent) => {
      let recorder = recorders.get(repo);
      if (!recorder) {
        recorder = createRunRecorder(options.store, { taskId, repo });
        recorders.set(repo, recorder);
      }
      recorder(event);
    };
    return {
      onPlan: (plan) => options.store.updateTask(taskId, { plan }),
      onRepoRunEvent,
    };
  };

  const State = Annotation.Root({
    taskId: Annotation<string>(),
    title: Annotation<string>(),
    prompt: Annotation<string>(),
    plan: Annotation<WorkspaceTaskPlan | undefined>(),
    repositories: Annotation<Record<string, WorkspaceTaskRepositoryResult>>(),
    retryCount: Annotation<number>(),
    status: Annotation<WorkflowStatus>(),
    error: Annotation<string | undefined>(),
  });

  const graph = new StateGraph(State)
    .addNode("planTask", async (state: typeof State.State) => {
      updateWorkflow(state.taskId, {
        status: "planning",
        message: "Planning workspace task.",
      });
      const callbacks = callbacksByTask.get(state.taskId);
      const result = await options.plan({
        taskId: state.taskId,
        title: state.title,
        prompt: state.prompt,
        onPlannerRunEvent: (event) =>
          callbacks?.onRepoRunEvent("(planner)", event),
      });
      const boardPlan = workspacePlanToBoardPlan(result.plan);
      callbacks?.onPlan(boardPlan);
      options.store.updateTask(state.taskId, { plan: boardPlan });
      updateWorkflow(state.taskId, {
        status: "awaiting-approval",
        message: "Workspace plan is waiting for approval.",
      });
      return {
        plan: result.plan,
        repositories: {},
        retryCount: 0,
        status: "awaiting-approval" as const,
      };
    })
    .addNode(
      "approveTask",
      (state: typeof State.State) => {
        const decision = interrupt<
          { readonly taskId: string; readonly title: string },
          ApprovalDecision
        >({
          taskId: state.taskId,
          title: state.title,
        });
        if (decision === "reject") {
          updateWorkflow(state.taskId, {
            status: "rejected",
            message: "Workspace plan was rejected.",
          });
          return new Command({
            goto: "rejectTask",
            update: {
              status: "rejected",
              error: "Workspace plan was rejected.",
            },
          });
        }
        updateWorkflow(state.taskId, {
          status: "approved",
          message: "Workspace plan was approved.",
        });
        return new Command({
          goto: "executeTask",
          update: { status: "approved" },
        });
      },
      { ends: ["executeTask", "rejectTask"] },
    )
    .addNode("executeTask", async (state: typeof State.State) => {
      if (!state.plan) {
        throw new Error("Cannot execute a board task before planning.");
      }
      const callbacks =
        callbacksByTask.get(state.taskId) ?? createStoreCallbacks(state.taskId);
      let retryCount = state.retryCount;
      let repositories: Record<string, WorkspaceTaskRepositoryResult> = {};

      while (retryCount <= maxRepoRetries) {
        updateWorkflow(state.taskId, {
          status: retryCount === 0 ? "running" : "retrying",
          retryCount,
          message:
            retryCount === 0
              ? "Executing approved workspace plan."
              : "Retrying failed repository execution.",
        });
        repositories = await options.execute({
          taskId: state.taskId,
          title: state.title,
          prompt: state.prompt,
          plan: state.plan,
          onRepoRunEvent: callbacks.onRepoRunEvent,
        });
        if (!hasFailedRepository(repositories)) break;
        retryCount += 1;
        if (retryCount > maxRepoRetries) break;
      }

      const status = hasFailedRepository(repositories) ? "failed" : "succeeded";
      updateWorkflow(state.taskId, {
        status,
        retryCount,
        ...(status === "failed"
          ? { error: "One or more repository executions failed." }
          : { message: "Workspace task completed." }),
      });
      return { repositories, retryCount, status };
    })
    .addNode("rejectTask", (state: typeof State.State) => ({
      repositories: {},
      status: "rejected" as const,
      error: state.error ?? "Workspace plan was rejected.",
    }))
    .addEdge(START, "planTask")
    .addEdge("planTask", "approveTask")
    .addEdge("executeTask", END)
    .addEdge("rejectTask", END)
    .compile({ checkpointer });

  const config = (taskId: string) => ({
    configurable: { thread_id: taskId, checkpoint_ns: "" },
  });

  const finishTask = (
    taskId: string,
    state: WorkflowState,
  ): TaskRunResult | undefined => {
    if (state.status === "rejected") {
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: state.error ?? "Workspace plan was rejected.",
      });
      return { repositories: {} };
    }
    if (state.status !== "succeeded" && state.status !== "failed") {
      return undefined;
    }
    options.store.updateTask(taskId, {
      status: state.status,
      finishedAt: workflowNow(),
      ...(state.error ? { error: state.error } : {}),
    });
    return { repositories: state.repositories };
  };

  const run: TaskRunner = async (args) => {
    callbacksByTask.set(args.taskId, {
      onPlan: args.onPlan,
      onRepoRunEvent: args.onRepoRunEvent,
    });
    try {
      const result = (await graph.invoke(
        {
          taskId: args.taskId,
          title: args.title,
          prompt: args.prompt,
          plan: undefined,
          repositories: {},
          retryCount: 0,
          status: "planning",
          error: undefined,
        } satisfies WorkflowState,
        config(args.taskId),
      )) as WorkflowState & { readonly __interrupt__?: unknown };
      if (result.__interrupt__ !== undefined) {
        return {
          repositories: {},
          plan: result.plan ? workspacePlanToBoardPlan(result.plan) : undefined,
          status: "awaiting-approval",
        };
      }
      return finishTask(args.taskId, result) ?? { repositories: {} };
    } catch (error) {
      updateWorkflow(args.taskId, {
        status: "failed",
        error: errorMessage(error),
      });
      throw error;
    } finally {
      callbacksByTask.delete(args.taskId);
    }
  };

  const resume = async (
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskRunResult | undefined> => {
    const task = options.store.getTask(taskId);
    if (!task) return undefined;
    callbacksByTask.set(taskId, createStoreCallbacks(taskId));
    try {
      const result = (await graph.invoke(
        new Command({ resume: decision }),
        config(taskId),
      )) as WorkflowState;
      return finishTask(taskId, result);
    } catch (error) {
      const message = errorMessage(error);
      updateWorkflow(taskId, { status: "failed", error: message });
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: message,
      });
      throw error;
    } finally {
      callbacksByTask.delete(taskId);
    }
  };

  return { run, resume };
};
