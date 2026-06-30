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
  type BoardTaskRecord,
  type BoardTaskWorkflow,
  type BoardTaskWorkflowPhase,
  type BoardTaskWorkflowSubstatus,
  type BoardTaskWorkflowStatus,
} from "./BoardStore.js";
import type { TaskRunner, TaskRunResult } from "./launchTask.js";
import type { RunEvent } from "../RunEvent.js";
import { assertUniqueWorkspaceTaskPlanRepositories } from "../runWorkspaceTask.js";
import type {
  WorkspaceTaskPlan,
  WorkspaceTaskRepositoryOptions,
  WorkspaceTaskRepositoryResult,
} from "../runWorkspaceTask.js";

type ApprovalDecision = "approve" | "reject";
type WorkflowStatus = BoardTaskWorkflowStatus;
type PhaseCompletion = {
  readonly type: "complete-phase";
  readonly phase: BoardTaskWorkflowPhase;
};
type WorkflowResume = ApprovalDecision | PhaseCompletion;

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
  completePhase(
    taskId: string,
    phase: BoardTaskWorkflowPhase,
  ): Promise<TaskRunResult | undefined>;
  resume(
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskRunResult | undefined>;
  recoverPhase(taskId: string): Promise<TaskRunResult | undefined>;
  cancel(taskId: string): Promise<void>;
}

export interface CreateLangGraphTaskWorkflowOptions {
  readonly store: BoardStore;
  readonly checkpointPath: string;
  readonly maxRepoRetries?: number;
  readonly onPhaseStarted?: (args: {
    readonly taskId: string;
    readonly phase: BoardTaskWorkflowPhase;
  }) => void;
  readonly plan: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly onPlannerRunEvent: (event: RunEvent) => void;
  }) => Promise<LangGraphPlanResult>;
  readonly planFromPhase?: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly phase: BoardTaskWorkflowPhase;
  }) => Promise<LangGraphPlanResult | undefined>;
  readonly execute: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly plan: WorkspaceTaskPlan;
    readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
    readonly signal: AbortSignal;
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
              ? { copyToWorktree: [...repo.copyToWorktree] }
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
    ...(repo.issue ? { issue: repo.issue } : {}),
  })),
});

const boardPlanToWorkspacePlan = (plan: BoardTaskPlan): WorkspaceTaskPlan => ({
  ...(plan.alignmentSummary
    ? { alignment: { summary: plan.alignmentSummary } }
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
              ? { copyToWorktree: [...repo.copyToWorktree] }
              : {}),
            ...(repo.branchStrategy
              ? {
                  branchStrategy:
                    repo.branchStrategy as WorkspaceTaskRepositoryOptions["branchStrategy"],
                }
              : {}),
          })),
        },
      }
    : {}),
  repositories: plan.repositories.map((repo) => ({
    name: repo.name,
    task: repo.task,
    ...(repo.reason ? { reason: repo.reason } : {}),
    ...(repo.issue ? { issue: repo.issue } : {}),
  })),
});

const combineIssueBodies = (
  entries: ReadonlyArray<WorkspaceTaskPlan["repositories"][number]>,
): WorkspaceTaskPlan["repositories"][number]["issue"] | undefined => {
  const issues = entries
    .map((entry) => entry.issue)
    .filter((issue): issue is NonNullable<typeof issue> => issue !== undefined);
  if (issues.length === 0) return undefined;
  if (issues.length === 1 && entries.length === 1) return issues[0];
  return {
    title: `Combined issues for ${entries[0]!.name}`,
    body: issues
      .map(
        (issue, index) =>
          `## Issue ${index + 1}: ${issue.title}\n\n${issue.body}`,
      )
      .join("\n\n---\n\n"),
  };
};

const combineText = (label: string, values: ReadonlyArray<string>): string =>
  values.length === 1
    ? values[0]!
    : values
        .map((value, index) => `## ${label} ${index + 1}\n\n${value}`)
        .join("\n\n---\n\n");

const mergeDuplicateWorkspacePlanRepositories = (
  plan: WorkspaceTaskPlan,
): { readonly plan: WorkspaceTaskPlan; readonly changed: boolean } => {
  const grouped = new Map<
    string,
    WorkspaceTaskPlan["repositories"][number][]
  >();
  const order: string[] = [];
  for (const repo of plan.repositories) {
    if (!grouped.has(repo.name)) {
      grouped.set(repo.name, []);
      order.push(repo.name);
    }
    grouped.get(repo.name)!.push(repo);
  }
  const changed = [...grouped.values()].some((entries) => entries.length > 1);
  if (!changed) return { plan, changed: false };

  return {
    changed: true,
    plan: {
      ...plan,
      repositories: order.map((name) => {
        const entries = grouped.get(name)!;
        const reasons = entries.flatMap((entry) =>
          entry.reason ? [entry.reason] : [],
        );
        const issue = combineIssueBodies(entries);
        return {
          name,
          task: combineText(
            "Approved task",
            entries.map((entry) => entry.task),
          ),
          ...(reasons.length > 0
            ? { reason: combineText("Reason", reasons) }
            : {}),
          ...(issue ? { issue } : {}),
        };
      }),
    },
  };
};

const hasFailedRepository = (
  repositories: Record<string, WorkspaceTaskRepositoryResult>,
): boolean =>
  Object.values(repositories).some((repo) => repo.status === "failed");

const WORKFLOW_PHASES = new Set<string>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
  "awaiting-approval",
  "running",
]);

const INTERACTIVE_PHASES = new Set<BoardTaskWorkflowPhase>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
]);

export const langGraphInterruptPhase = (
  error: unknown,
): BoardTaskWorkflowPhase | undefined => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  let parsed: unknown = error;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = error;
    }
  }
  const interrupts = Array.isArray(parsed) ? parsed : undefined;
  if (!interrupts || interrupts.length === 0) return undefined;
  const phase = (interrupts[0] as { value?: { phase?: unknown } } | undefined)
    ?.value?.phase;
  return typeof phase === "string" && WORKFLOW_PHASES.has(phase)
    ? (phase as BoardTaskWorkflowPhase)
    : undefined;
};

const latestInteractivePhaseSession = (
  task: BoardTaskRecord,
): BoardTaskWorkflowPhase | undefined => {
  const sessions = Object.values(task.workflow?.phaseSessions ?? {});
  const latest = sessions
    .filter(
      (session) =>
        session !== undefined && INTERACTIVE_PHASES.has(session.phase),
    )
    .sort((a, b) =>
      (b.exitedAt ?? b.startedAt).localeCompare(a.exitedAt ?? a.startedAt),
    )[0];
  return latest?.phase;
};

const isPlannerTransientFailure = (task: BoardTaskRecord): boolean => {
  const message = `${task.error ?? ""}\n${task.workflow?.error ?? ""}`;
  return (
    /Agent idle for \d+ seconds/i.test(message) &&
    (/runWorkspace repository failed/i.test(message) ||
      /planner/i.test(message))
  );
};

const isAwaitingApprovalWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.status === "awaiting-approval" ||
    task.workflow?.currentPhase === "awaiting-approval");

const isExecutionRecoveryMessage = (task: BoardTaskRecord): boolean => {
  const message = [
    task.error,
    task.workflow?.error,
    task.workflow?.message,
    task.workflow?.status,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (
    /Executing approved workspace plan/i.test(message) ||
    /Retrying failed repository execution/i.test(message) ||
    /One or more repository executions failed/i.test(message) ||
    /Interrupted when the board server stopped or restarted/i.test(message) ||
    /Task cancelled/i.test(message)
  );
};

const isFailedExecutionWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.currentPhase === "running" ||
    task.workflow?.status === "running" ||
    task.workflow?.status === "retrying" ||
    isExecutionRecoveryMessage(task));

const recoveredExecutionPrompt = (
  originalPrompt: string,
  progressMarkdown?: string,
): string => `Continue the approved Board workspace execution after an interruption.

The workspace plan has already been reviewed and approved. Do not re-plan, do not regenerate Board issues, and do not ask for approval again.

Resume execution from the Board progress document below. It is model-agnostic and is the source of truth for what was already attempted.

Recovery rules:
- inspect any previous branches, commits, worktrees, and preserved changes before editing;
- compare the progress document with the actual repository diff before deciding what remains;
- continue or repair the approved repository tasks only;
- do not duplicate repositories or acceptance criteria already marked succeeded unless verification proves they regressed;
- continue repositories marked pending, in_progress, or needs_recovery;
- commit the final repository changes when each task is complete.

Board progress document:
${progressMarkdown ?? "No Board progress document was available. Reconstruct progress from the existing repository state and run history before editing."}

Original task prompt:
${originalPrompt}`;

export const recoverableFailedTaskPhase = (
  task: BoardTaskRecord,
): BoardTaskWorkflowPhase | undefined => {
  if (task.status !== "failed") return undefined;
  const interruptPhase =
    langGraphInterruptPhase(task.error) ??
    langGraphInterruptPhase(task.workflow?.error);
  if (interruptPhase) return interruptPhase;
  if (isAwaitingApprovalWithPlan(task)) return "awaiting-approval";
  if (isFailedExecutionWithPlan(task)) return "running";
  if (task.plan) return undefined;
  const currentPhase = task.workflow?.currentPhase;
  if (currentPhase && INTERACTIVE_PHASES.has(currentPhase)) {
    return currentPhase;
  }
  if (task.workflow?.status === "failed") {
    const latestPhase = latestInteractivePhaseSession(task);
    if (latestPhase) return latestPhase;
  }
  if (isPlannerTransientFailure(task)) return "creating-issues";
  return undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspacePlanImportFailureMessage =
  "Board could not import a workspace plan from this phase. Fix the <workspace_plan> block, then complete the phase again.";

export const createLangGraphTaskWorkflow = (
  options: CreateLangGraphTaskWorkflowOptions,
): LangGraphTaskWorkflow => {
  const checkpointer = SqliteSaver.fromConnString(options.checkpointPath);
  const callbacksByTask = new Map<string, WorkflowCallbacks>();
  const cancelledTasks = new Set<string>();
  const abortControllersByTask = new Map<string, AbortController>();

  const cancellationError = () => new Error("Task cancelled.");

  const throwIfCancelled = (taskId: string): void => {
    if (cancelledTasks.has(taskId)) {
      throw cancellationError();
    }
  };
  const maxRepoRetries = options.maxRepoRetries ?? 1;

  const updateWorkflow = (
    taskId: string,
    patch: {
      readonly status: WorkflowStatus;
      readonly currentPhase?: BoardTaskWorkflowPhase;
      readonly retryCount?: number;
      readonly substatus?: BoardTaskWorkflowSubstatus;
      readonly message?: string;
      readonly error?: string;
    },
  ) => {
    const previous = options.store.getTask(taskId)?.workflow;
    const { substatus: previousSubstatus, ...previousWithoutSubstatus } =
      previous ?? {};
    const nextWorkflow: BoardTaskWorkflow = {
      ...previousWithoutSubstatus,
      status: patch.status,
      currentPhase: patch.currentPhase ?? previous?.currentPhase,
      checkpointThreadId: previous?.checkpointThreadId ?? taskId,
      ...(patch.retryCount !== undefined
        ? { retryCount: patch.retryCount }
        : {}),
      ...("substatus" in patch && patch.substatus !== undefined
        ? { substatus: patch.substatus }
        : "substatus" in patch
          ? {}
          : previous?.substatus
            ? { substatus: previousSubstatus }
            : {}),
      ...(patch.message ? { message: patch.message } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      updatedAt: workflowNow(),
    };
    options.store.updateTask(taskId, {
      workflow: nextWorkflow,
    });
  };

  const waitForPhaseCompletion = (
    state: WorkflowState,
    phase: BoardTaskWorkflowPhase,
  ): void => {
    const completion = interrupt<
      {
        readonly taskId: string;
        readonly title: string;
        readonly phase: string;
      },
      PhaseCompletion
    >({
      taskId: state.taskId,
      title: state.title,
      phase,
    });
    if (completion.type !== "complete-phase" || completion.phase !== phase) {
      throw new Error(
        `Cannot complete ${phase} with a different phase signal.`,
      );
    }
  };

  const importPhaseWorkspacePlan = async (
    state: WorkflowState,
  ): Promise<{
    readonly result?: LangGraphPlanResult;
    readonly error?: string;
  }> => {
    const result = await options.planFromPhase?.({
      taskId: state.taskId,
      title: state.title,
      prompt: state.prompt,
      phase: "creating-issues",
    });
    if (!result) return {};
    try {
      assertUniqueWorkspaceTaskPlanRepositories(result.plan);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    return { result };
  };

  const executeApprovedPlan = async (
    state: Omit<WorkflowState, "plan"> & { readonly plan: WorkspaceTaskPlan },
    callbacks: WorkflowCallbacks,
  ): Promise<
    Pick<WorkflowState, "repositories" | "retryCount" | "status" | "error">
  > => {
    let retryCount = state.retryCount;
    let repositories: Record<string, WorkspaceTaskRepositoryResult> = {};
    const executionPlan = mergeDuplicateWorkspacePlanRepositories(state.plan);
    if (executionPlan.changed) {
      options.store.updateTask(state.taskId, {
        plan: workspacePlanToBoardPlan(executionPlan.plan),
      });
    }

    while (retryCount <= maxRepoRetries) {
      throwIfCancelled(state.taskId);
      updateWorkflow(state.taskId, {
        status: retryCount === 0 ? "running" : "retrying",
        currentPhase: "running",
        substatus: undefined,
        retryCount,
        message:
          retryCount === 0
            ? "Executing approved workspace plan."
            : "Retrying failed repository execution.",
      });
      const controller = new AbortController();
      abortControllersByTask.set(state.taskId, controller);
      try {
        repositories = await options.execute({
          taskId: state.taskId,
          title: state.title,
          prompt: state.prompt,
          plan: executionPlan.plan,
          onRepoRunEvent: callbacks.onRepoRunEvent,
          signal: controller.signal,
        });
        throwIfCancelled(state.taskId);
        if (!hasFailedRepository(repositories)) break;
        retryCount += 1;
        if (retryCount > maxRepoRetries) break;
      } finally {
        if (abortControllersByTask.get(state.taskId) === controller) {
          abortControllersByTask.delete(state.taskId);
        }
      }
    }

    throwIfCancelled(state.taskId);
    const status = hasFailedRepository(repositories) ? "failed" : "succeeded";
    const error =
      status === "failed"
        ? "One or more repository executions failed."
        : undefined;
    updateWorkflow(state.taskId, {
      status,
      substatus: undefined,
      retryCount,
      ...(error ? { error } : { message: "Workspace task completed." }),
    });
    return { repositories, retryCount, status, ...(error ? { error } : {}) };
  };

  const enterInteractivePhase = (
    state: WorkflowState,
    phase: BoardTaskWorkflowPhase,
    message: string,
  ): void => {
    const previousPhase = options.store.getTask(state.taskId)?.workflow
      ?.currentPhase;
    updateWorkflow(state.taskId, {
      status: phase,
      currentPhase: phase,
      substatus: undefined,
      message,
    });
    if (previousPhase !== phase) {
      options.onPhaseStarted?.({ taskId: state.taskId, phase });
    }
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
    .addNode("classifyTask", (state: typeof State.State) => {
      enterInteractivePhase(
        state,
        "classifying",
        "Classifying the board task stage.",
      );
      waitForPhaseCompletion(state, "classifying");
      return {
        status: "classifying" as const,
        repositories: state.repositories ?? {},
        retryCount: state.retryCount ?? 0,
      };
    })
    .addNode("alignPrd", async (state: typeof State.State) => {
      enterInteractivePhase(
        state,
        "aligning-prd",
        "Aligning the PRD with the current workspace.",
      );
      waitForPhaseCompletion(state, "aligning-prd");
      return {
        repositories: {},
        retryCount: 0,
        status: "aligning-prd" as const,
      };
    })
    .addNode("createTechnicalPlan", (state: typeof State.State) => {
      enterInteractivePhase(
        state,
        "technical-planning",
        "Preparing the technical plan.",
      );
      waitForPhaseCompletion(state, "technical-planning");
      return { status: "technical-planning" as const };
    })
    .addNode("createBoardIssues", async (state: typeof State.State) => {
      enterInteractivePhase(
        state,
        "creating-issues",
        "Creating board issues from the technical plan.",
      );
      waitForPhaseCompletion(state, "creating-issues");
      updateWorkflow(state.taskId, {
        status: "planning",
        currentPhase: "creating-issues",
        substatus: "validating-workspace-plan",
        message: "Importing workspace plan from the completed phase.",
      });
      const callbacks = callbacksByTask.get(state.taskId);
      let imported = await importPhaseWorkspacePlan(state);
      let result = imported.result;
      while (!result) {
        updateWorkflow(state.taskId, {
          status: "creating-issues",
          currentPhase: "creating-issues",
          substatus: "fixing-workspace-plan",
          message: imported.error ?? workspacePlanImportFailureMessage,
        });
        waitForPhaseCompletion(state, "creating-issues");
        updateWorkflow(state.taskId, {
          status: "planning",
          currentPhase: "creating-issues",
          substatus: "validating-workspace-plan",
          message: "Importing workspace plan from the completed phase.",
        });
        imported = await importPhaseWorkspacePlan(state);
        result = imported.result;
      }
      if (cancelledTasks.has(state.taskId)) {
        throw new Error("Task cancelled.");
      }
      const boardPlan = workspacePlanToBoardPlan(result.plan);
      callbacks?.onPlan(boardPlan);
      options.store.updateTask(state.taskId, { plan: boardPlan });
      updateWorkflow(state.taskId, {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        substatus: undefined,
        message: "Board issues are waiting for approval.",
      });
      return { plan: result.plan, status: "awaiting-approval" as const };
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
            substatus: undefined,
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
          currentPhase: "running",
          substatus: undefined,
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
      return executeApprovedPlan(
        {
          taskId: state.taskId,
          title: state.title,
          prompt: state.prompt,
          plan: state.plan,
          repositories: state.repositories ?? {},
          retryCount: state.retryCount ?? 0,
          status: state.status,
          error: state.error,
        },
        callbacks,
      );
    })
    .addNode("rejectTask", (state: typeof State.State) => ({
      repositories: {},
      status: "rejected" as const,
      error: state.error ?? "Workspace plan was rejected.",
    }))
    .addEdge(START, "classifyTask")
    .addEdge("classifyTask", "alignPrd")
    .addEdge("alignPrd", "createTechnicalPlan")
    .addEdge("createTechnicalPlan", "createBoardIssues")
    .addEdge("createBoardIssues", "approveTask")
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
    if (cancelledTasks.has(taskId)) {
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: "Task cancelled.",
      });
      return { repositories: {} };
    }
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

  const pausedResult = (
    taskId: string,
    state?: Partial<WorkflowState>,
  ): TaskRunResult => {
    const task = options.store.getTask(taskId);
    const phase =
      task?.workflow?.currentPhase ??
      (task?.workflow?.status === "awaiting-approval"
        ? "awaiting-approval"
        : undefined);
    if (task?.workflow?.status === "awaiting-approval") {
      return {
        repositories: {},
        plan:
          state?.plan || task.plan
            ? state?.plan
              ? workspacePlanToBoardPlan(state.plan)
              : task.plan
            : undefined,
        status: "awaiting-approval",
      };
    }
    return {
      repositories: {},
      ...(state?.plan ? { plan: workspacePlanToBoardPlan(state.plan) } : {}),
      status: "awaiting-phase-completion",
      ...(phase ? { phase } : {}),
    };
  };

  const run: TaskRunner = async (args) => {
    let keepCallbacks = false;
    callbacksByTask.set(args.taskId, {
      onPlan: args.onPlan,
      onRepoRunEvent: args.onRepoRunEvent,
    });
    try {
      throwIfCancelled(args.taskId);
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
        const paused = pausedResult(args.taskId, result);
        keepCallbacks = paused.status === "awaiting-phase-completion";
        return paused;
      }
      return finishTask(args.taskId, result) ?? { repositories: {} };
    } catch (error) {
      const interruptedPhase = langGraphInterruptPhase(error);
      if (interruptedPhase) {
        const paused = pausedResult(args.taskId);
        keepCallbacks = paused.status === "awaiting-phase-completion";
        return paused;
      }
      updateWorkflow(args.taskId, {
        status: "failed",
        error: errorMessage(error),
      });
      throw error;
    } finally {
      if (!keepCallbacks) callbacksByTask.delete(args.taskId);
    }
  };

  const completePhase = async (
    taskId: string,
    phase: BoardTaskWorkflowPhase,
  ): Promise<TaskRunResult | undefined> => {
    const task = options.store.getTask(taskId);
    if (!task) return undefined;
    throwIfCancelled(taskId);
    if (!callbacksByTask.has(taskId)) {
      callbacksByTask.set(taskId, createStoreCallbacks(taskId));
    }
    let keepCallbacks = false;
    try {
      const result = (await graph.invoke(
        new Command({ resume: { type: "complete-phase", phase } }),
        config(taskId),
      )) as WorkflowState & { readonly __interrupt__?: unknown };
      if (result.__interrupt__ !== undefined) {
        const paused = pausedResult(taskId, result);
        keepCallbacks = paused.status === "awaiting-phase-completion";
        return paused;
      }
      return finishTask(taskId, result);
    } catch (error) {
      const interruptedPhase = langGraphInterruptPhase(error);
      if (interruptedPhase) {
        const paused = pausedResult(taskId);
        keepCallbacks = paused.status === "awaiting-phase-completion";
        return paused;
      }
      const message = errorMessage(error);
      updateWorkflow(taskId, { status: "failed", error: message });
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: message,
      });
      throw error;
    } finally {
      if (!keepCallbacks) callbacksByTask.delete(taskId);
    }
  };

  const resume = async (
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskRunResult | undefined> => {
    const task = options.store.getTask(taskId);
    if (!task) return undefined;
    throwIfCancelled(taskId);
    callbacksByTask.set(taskId, createStoreCallbacks(taskId));
    try {
      const result = (await graph.invoke(
        new Command({ resume: decision }),
        config(taskId),
      )) as WorkflowState;
      return finishTask(taskId, result);
    } catch (error) {
      const interruptedPhase = langGraphInterruptPhase(error);
      if (interruptedPhase) {
        return pausedResult(taskId);
      }
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

  const recoverPhase = async (
    taskId: string,
  ): Promise<TaskRunResult | undefined> => {
    const task = options.store.getTask(taskId);
    if (!task) return undefined;
    const phase = recoverableFailedTaskPhase(task);
    if (!phase) return undefined;
    cancelledTasks.delete(taskId);
    const checkpointThreadId = task.workflow?.checkpointThreadId ?? task.id;
    const workflow: BoardTaskWorkflow = {
      status: phase,
      currentPhase: phase,
      ...(task.workflow?.phaseSessions
        ? { phaseSessions: task.workflow.phaseSessions }
        : {}),
      checkpointThreadId,
      ...(task.workflow?.retryCount !== undefined
        ? { retryCount: task.workflow.retryCount }
        : {}),
      message: "Recovered failed workflow phase.",
      updatedAt: workflowNow(),
    };
    options.store.updateTask(taskId, {
      status: "running",
      finishedAt: undefined,
      error: undefined,
      workflow,
    });
    if (phase === "running") {
      if (!task.plan) return undefined;
      const plan = boardPlanToWorkspacePlan(task.plan);
      const progressMarkdown =
        options.store.readTaskProgress(taskId) ??
        options.store.refreshTaskProgress(taskId);
      const recoverPrompt = recoveredExecutionPrompt(
        task.prompt,
        progressMarkdown,
      );
      const callbacks = createStoreCallbacks(taskId);
      callbacksByTask.set(taskId, callbacks);
      try {
        const result = await executeApprovedPlan(
          {
            taskId,
            title: task.title,
            prompt: recoverPrompt,
            plan,
            repositories: {},
            retryCount: task.workflow?.retryCount ?? 0,
            status: "running",
            error: undefined,
          },
          callbacks,
        );
        return (
          finishTask(taskId, {
            taskId,
            title: task.title,
            prompt: recoverPrompt,
            plan,
            repositories: result.repositories,
            retryCount: result.retryCount,
            status: result.status,
            error: result.error,
          }) ?? { repositories: result.repositories }
        );
      } catch (error) {
        const message = errorMessage(error);
        updateWorkflow(taskId, {
          status: "failed",
          currentPhase: "running",
          error: message,
        });
        options.store.updateTask(taskId, {
          status: "failed",
          finishedAt: workflowNow(),
          error: message,
        });
        return undefined;
      } finally {
        callbacksByTask.delete(taskId);
      }
    }
    if (phase === "awaiting-approval") {
      return {
        repositories: {},
        ...(task.plan ? { plan: task.plan } : {}),
        status: "awaiting-approval",
      };
    }
    options.onPhaseStarted?.({ taskId, phase });
    return {
      repositories: {},
      status: "awaiting-phase-completion",
      phase,
    };
  };

  const cancel = async (taskId: string): Promise<void> => {
    const task = options.store.getTask(taskId);
    if (!task) return;
    cancelledTasks.add(taskId);
    abortControllersByTask.get(taskId)?.abort(cancellationError());
    const message = "Task cancelled.";
    updateWorkflow(taskId, {
      status: "failed",
      currentPhase: task.workflow?.currentPhase,
      error: message,
    });
    options.store.updateTask(taskId, {
      status: "failed",
      finishedAt: workflowNow(),
      error: message,
    });
  };

  return { run, completePhase, resume, recoverPhase, cancel };
};
