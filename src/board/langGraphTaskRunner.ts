import {
  createRunRecorder,
  type BoardRole,
  type BoardStore,
  type BoardTaskApprovedPlanAction,
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
  WorkspaceTaskRepositoryResult,
} from "../runWorkspaceTask.js";
import type { BoardTaskVerificationStatus } from "./taskVerification.js";
import {
  boardPlanToWorkspacePlan,
  handleImportedWorkspacePlanApproval,
  isImportedWorkspacePlanAwaitingApproval,
} from "./importedPlanApproval.js";
import { executeApprovedBoardPlan } from "./approvedPlanExecution.js";
import type { BoardTaskEvaluator } from "./taskEvaluator.js";

type ApprovalDecision = "approve" | "reject";
type WorkflowStatus = BoardTaskWorkflowStatus;

interface WorkflowState {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly plan?: WorkspaceTaskPlan;
  readonly repositories: Record<string, WorkspaceTaskRepositoryResult>;
  readonly retryCount: number;
  readonly status: WorkflowStatus;
  readonly error?: string;
  readonly verificationStatus?: BoardTaskVerificationStatus;
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
  readonly maxRepoRetries?: number;
  readonly planningOnly?: boolean;
  readonly exportApprovedPlan?: (args: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly plan: WorkspaceTaskPlan;
  }) => Promise<void>;
  readonly onPhaseStarted?: (args: {
    readonly taskId: string;
    readonly phase: BoardTaskWorkflowPhase;
  }) => void;
  readonly requestPhaseRepair?: (args: {
    readonly taskId: string;
    readonly phase: BoardTaskWorkflowPhase;
    readonly message: string;
  }) => Promise<void> | void;
  readonly maxWorkspacePlanRepairAttempts?: number;
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
  readonly evaluate?: BoardTaskEvaluator;
}

const workflowNow = () => new Date().toISOString();

export const workspacePlanToBoardPlan = (
  plan: WorkspaceTaskPlan,
): BoardTaskPlan => ({
  ...(plan.alignment
    ? {
        alignment: {
          summary: plan.alignment.summary,
          ...(plan.alignment.assumptions
            ? { assumptions: [...plan.alignment.assumptions] }
            : {}),
          ...(plan.alignment.openQuestions
            ? { openQuestions: [...plan.alignment.openQuestions] }
            : {}),
          ...(plan.alignment.domainTerms
            ? {
                domainTerms: plan.alignment.domainTerms.map((term) => ({
                  term: term.term,
                  meaning: term.meaning,
                })),
              }
            : {}),
          ...(plan.alignment.adrCandidates
            ? {
                adrCandidates: plan.alignment.adrCandidates.map(
                  (candidate) => ({
                    title: candidate.title,
                    reason: candidate.reason,
                  }),
                ),
              }
            : {}),
        },
      }
    : {}),
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

const WORKFLOW_PHASES = new Set<string>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
  "awaiting-approval",
  "running",
  "verifying",
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
    /Verification failed/i.test(message) ||
    /Verification needs recovery/i.test(message) ||
    /Interrupted when the board server stopped or restarted/i.test(message) ||
    /Task cancelled/i.test(message)
  );
};

const isFailedExecutionWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.currentPhase === "running" ||
    task.workflow?.currentPhase === "verifying" ||
    task.workflow?.status === "running" ||
    task.workflow?.status === "verifying" ||
    task.workflow?.status === "retrying" ||
    task.workflow?.verificationStatus === "failed" ||
    task.workflow?.verificationStatus === "needs-recovery" ||
    isExecutionRecoveryMessage(task));

const recoveredExecutionPrompt = (
  originalPrompt: string,
  progressMarkdown?: string,
  verificationMarkdown?: string,
): string => `Continue the approved Board workspace execution after an interruption.

Board role: Generator. Stay inside the Generator responsibility boundary.

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

Board verification report:
${verificationMarkdown ?? "No Board verification report was available. Use the progress document and repository state to decide what remains."}

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

const workspacePlanRepairPrompt = (error: string): string => `
The Board could not import a valid workspace plan from this phase.

Import error:
${error}

Repair the creating-issues output now:
- produce one valid <workspace_plan> block using the required JSON shape;
- include each repository name at most once;
- if the phase prompt provided a workspace plan file path, write the exact JSON object to that file;
- do not implement the task or start repository execution.

When the repaired plan is ready, print this exact marker on its own line:
<sandcastle-phase>complete</sandcastle-phase>
`;

export const createLangGraphTaskWorkflow = (
  options: CreateLangGraphTaskWorkflowOptions,
): LangGraphTaskWorkflow => {
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
  const maxWorkspacePlanRepairAttempts =
    options.maxWorkspacePlanRepairAttempts ?? 2;
  const approvedPlanAction: BoardTaskApprovedPlanAction = options.planningOnly
    ? "export-artifacts"
    : "execute";

  const roleFor = (
    status: WorkflowStatus,
    currentPhase?: BoardTaskWorkflowPhase,
  ): BoardRole => {
    if (currentPhase === "verifying") return "evaluator";
    if (
      currentPhase === "running" ||
      status === "approved" ||
      status === "running" ||
      status === "retrying"
    ) {
      return "generator";
    }
    return "planner";
  };

  const updateWorkflow = (
    taskId: string,
    patch: {
      readonly status: WorkflowStatus;
      readonly currentPhase?: BoardTaskWorkflowPhase;
      readonly role?: BoardRole;
      readonly retryCount?: number;
      readonly workspacePlanRepairAttempts?: number;
      readonly substatus?: BoardTaskWorkflowSubstatus;
      readonly verificationStatus?: BoardTaskVerificationStatus;
      readonly message?: string;
      readonly error?: string;
    },
  ) => {
    const previous = options.store.getTask(taskId)?.workflow;
    const {
      substatus: previousSubstatus,
      message: previousMessage,
      error: previousError,
      ...previousWithoutSubstatus
    } = previous ?? {};
    const shouldRetainPreviousMessage =
      !("message" in patch) && !("error" in patch);
    const currentPhase = patch.currentPhase ?? previous?.currentPhase;
    const nextWorkflow: BoardTaskWorkflow = {
      ...previousWithoutSubstatus,
      status: patch.status,
      currentPhase,
      role: patch.role ?? roleFor(patch.status, currentPhase),
      approvedPlanAction: previous?.approvedPlanAction ?? approvedPlanAction,
      checkpointThreadId: previous?.checkpointThreadId ?? taskId,
      ...(patch.retryCount !== undefined
        ? { retryCount: patch.retryCount }
        : {}),
      ...(patch.workspacePlanRepairAttempts !== undefined
        ? { workspacePlanRepairAttempts: patch.workspacePlanRepairAttempts }
        : previous?.workspacePlanRepairAttempts !== undefined
          ? {
              workspacePlanRepairAttempts: previous.workspacePlanRepairAttempts,
            }
          : {}),
      ...(patch.verificationStatus !== undefined
        ? { verificationStatus: patch.verificationStatus }
        : previous?.verificationStatus
          ? { verificationStatus: previous.verificationStatus }
          : {}),
      ...("substatus" in patch && patch.substatus !== undefined
        ? { substatus: patch.substatus }
        : "substatus" in patch
          ? {}
          : previous?.substatus
            ? { substatus: previousSubstatus }
            : {}),
      ...(shouldRetainPreviousMessage && previousMessage
        ? { message: previousMessage }
        : {}),
      ...(shouldRetainPreviousMessage && previousError
        ? { error: previousError }
        : {}),
      ...("message" in patch && patch.message
        ? { message: patch.message }
        : {}),
      ...("error" in patch && patch.error ? { error: patch.error } : {}),
      updatedAt: workflowNow(),
    };
    options.store.updateTask(taskId, {
      workflow: nextWorkflow,
    });
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
    Pick<
      WorkflowState,
      "repositories" | "retryCount" | "status" | "error" | "verificationStatus"
    >
  > =>
    executeApprovedBoardPlan({
      store: options.store,
      state,
      callbacks,
      maxRepoRetries,
      abortControllersByTask,
      throwIfCancelled,
      updateWorkflow: (workflow) => updateWorkflow(state.taskId, workflow),
      execute: options.execute,
      evaluate: options.evaluate,
      onPlanChanged: (plan) => {
        options.store.updateTask(state.taskId, {
          plan: workspacePlanToBoardPlan(plan),
        });
      },
    });

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

  const phaseMessages: Record<BoardTaskWorkflowPhase, string> = {
    classifying: "Classifying the board task stage.",
    "aligning-prd": "Aligning the PRD with the current workspace.",
    "technical-planning": "Preparing the technical plan.",
    "creating-issues": "Creating board issues from the technical plan.",
    "awaiting-approval": "Board issues are waiting for approval.",
    running: "Executing approved workspace plan.",
    verifying: "Verifying completed repository executions.",
  };

  const nextInteractivePhase: Partial<
    Record<BoardTaskWorkflowPhase, BoardTaskWorkflowPhase>
  > = {
    classifying: "aligning-prd",
    "aligning-prd": "technical-planning",
    "technical-planning": "creating-issues",
  };

  const run: TaskRunner = async (args) => {
    callbacksByTask.set(args.taskId, {
      onPlan: args.onPlan,
      onRepoRunEvent: args.onRepoRunEvent,
    });
    try {
      throwIfCancelled(args.taskId);
      enterInteractivePhase(
        {
          taskId: args.taskId,
          title: args.title,
          prompt: args.prompt,
          repositories: {},
          retryCount: 0,
          status: "planning",
        },
        "classifying",
        phaseMessages.classifying,
      );
      return pausedResult(args.taskId);
    } catch (error) {
      updateWorkflow(args.taskId, {
        status: "failed",
        error: errorMessage(error),
      });
      throw error;
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
    try {
      const currentPhase = task.workflow?.currentPhase;
      if (currentPhase && currentPhase !== phase) {
        throw new Error(
          `Cannot complete ${phase} while ${currentPhase} is active.`,
        );
      }
      const nextPhase = nextInteractivePhase[phase];
      if (nextPhase) {
        enterInteractivePhase(
          {
            taskId: task.id,
            title: task.title,
            prompt: task.prompt,
            repositories: {},
            retryCount: 0,
            status: phase,
          },
          nextPhase,
          phaseMessages[nextPhase],
        );
        return pausedResult(taskId);
      }
      if (phase !== "creating-issues") return pausedResult(taskId);

      updateWorkflow(taskId, {
        status: "planning",
        currentPhase: "creating-issues",
        role: "planner",
        substatus: "validating-workspace-plan",
        message: "Importing workspace plan from the completed phase.",
      });
      const imported = await importPhaseWorkspacePlan({
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        repositories: {},
        retryCount: 0,
        status: phase,
      });
      const result = imported.result;
      if (!result) {
        const importError = imported.error ?? workspacePlanImportFailureMessage;
        const repairAttempts = task.workflow?.workspacePlanRepairAttempts ?? 0;
        updateWorkflow(taskId, {
          status: "creating-issues",
          currentPhase: "creating-issues",
          role: "planner",
          substatus: "fixing-workspace-plan",
          workspacePlanRepairAttempts:
            repairAttempts < maxWorkspacePlanRepairAttempts
              ? repairAttempts + 1
              : repairAttempts,
          message: importError,
        });
        if (repairAttempts < maxWorkspacePlanRepairAttempts) {
          try {
            await options.requestPhaseRepair?.({
              taskId,
              phase: "creating-issues",
              message: workspacePlanRepairPrompt(importError),
            });
          } catch {
            // Stay in the manual repair state if the phase terminal cannot accept input.
          }
        }
        return pausedResult(taskId);
      }
      throwIfCancelled(taskId);
      const boardPlan = workspacePlanToBoardPlan(result.plan);
      callbacksByTask.get(taskId)?.onPlan(boardPlan);
      options.store.updateTask(taskId, { plan: boardPlan });
      updateWorkflow(taskId, {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        role: "planner",
        substatus: undefined,
        message: "Board issues are waiting for approval.",
      });
      return pausedResult(taskId, { plan: result.plan });
    } catch (error) {
      const message = errorMessage(error);
      updateWorkflow(taskId, { status: "failed", error: message });
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: message,
      });
      throw error;
    }
  };

  const resume = async (
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskRunResult | undefined> => {
    const task = options.store.getTask(taskId);
    if (!task) return undefined;
    throwIfCancelled(taskId);
    const importedResult = await handleImportedWorkspacePlanApproval({
      store: options.store,
      task,
      decision,
      planningOnly: options.planningOnly,
      exportApprovedPlan: options.exportApprovedPlan,
      updateWorkflow: (workflow) => updateWorkflow(taskId, workflow),
      failTask: (message) => {
        updateWorkflow(taskId, { status: "failed", error: message });
        options.store.updateTask(taskId, {
          status: "failed",
          finishedAt: workflowNow(),
          error: message,
        });
      },
      executeApprovedPlan: async (plan) => {
        const callbacks = createStoreCallbacks(taskId);
        callbacksByTask.set(taskId, callbacks);
        try {
          const result = await executeApprovedPlan(
            {
              taskId,
              title: task.title,
              prompt: task.prompt,
              plan,
              repositories: {},
              retryCount: task.workflow?.retryCount ?? 0,
              status: "approved",
              error: undefined,
            },
            callbacks,
          );
          return (
            finishTask(taskId, {
              taskId,
              title: task.title,
              prompt: task.prompt,
              plan,
              repositories: result.repositories,
              retryCount: result.retryCount,
              status: result.status,
              error: result.error,
              verificationStatus: result.verificationStatus,
            }) ?? { repositories: result.repositories }
          );
        } finally {
          callbacksByTask.delete(taskId);
        }
      },
    });
    if (importedResult) return importedResult;

    try {
      if (decision === "reject") {
        updateWorkflow(taskId, {
          status: "rejected",
          role: "planner",
          substatus: undefined,
          message: "Workspace plan was rejected.",
        });
        options.store.updateTask(taskId, {
          status: "failed",
          finishedAt: workflowNow(),
          error: "Workspace plan was rejected.",
        });
        return { repositories: {} };
      }
      if (!task.plan) {
        throw new Error("Cannot execute a board task before planning.");
      }
      const plan = boardPlanToWorkspacePlan(task.plan);
      updateWorkflow(taskId, {
        status: "approved",
        currentPhase: options.planningOnly ? "awaiting-approval" : "running",
        role: options.planningOnly ? "planner" : "generator",
        substatus: undefined,
        message: "Workspace plan was approved.",
      });
      if (options.planningOnly) {
        await options.exportApprovedPlan?.({
          taskId,
          title: task.title,
          prompt: task.prompt,
          plan,
        });
        updateWorkflow(taskId, {
          status: "succeeded",
          currentPhase: "awaiting-approval",
          role: "planner",
          substatus: undefined,
          message: "Approved workspace plan artifacts were exported.",
        });
        options.store.updateTask(taskId, {
          status: "succeeded",
          finishedAt: workflowNow(),
        });
        return { repositories: {} };
      }
      const callbacks = createStoreCallbacks(taskId);
      callbacksByTask.set(taskId, callbacks);
      try {
        const result = await executeApprovedPlan(
          {
            taskId,
            title: task.title,
            prompt: task.prompt,
            plan,
            repositories: {},
            retryCount: task.workflow?.retryCount ?? 0,
            status: "approved",
            error: undefined,
          },
          callbacks,
        );
        return (
          finishTask(taskId, {
            taskId,
            title: task.title,
            prompt: task.prompt,
            plan,
            repositories: result.repositories,
            retryCount: result.retryCount,
            status: result.status,
            error: result.error,
            verificationStatus: result.verificationStatus,
          }) ?? { repositories: result.repositories }
        );
      } finally {
        callbacksByTask.delete(taskId);
      }
    } catch (error) {
      const message = errorMessage(error);
      updateWorkflow(taskId, { status: "failed", error: message });
      options.store.updateTask(taskId, {
        status: "failed",
        finishedAt: workflowNow(),
        error: message,
      });
      throw error;
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
      role: roleFor(phase, phase),
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
      const verificationMarkdown = options.store.readTaskVerification(taskId);
      const recoverPrompt = recoveredExecutionPrompt(
        task.prompt,
        progressMarkdown,
        verificationMarkdown,
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
            verificationStatus: result.verificationStatus,
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
