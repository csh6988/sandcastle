import type {
  BoardStore,
  BoardTaskWorkflowPhase,
  BoardTaskWorkflowStatus,
  BoardTaskWorkflowSubstatus,
} from "./BoardStore.js";
import type { RunEvent } from "../RunEvent.js";
import type {
  WorkspaceTaskPlan,
  WorkspaceTaskRepositoryResult,
} from "../runWorkspaceTask.js";
import {
  renderTaskVerificationReport,
  type BoardTaskVerificationStatus,
} from "./taskVerification.js";
import {
  repositoryAgentWorkWasRecorded,
  renderEvaluatedVerificationMarkdown,
  type BoardTaskEvaluator,
} from "./taskEvaluator.js";

export interface ApprovedPlanExecutionWorkflowPatch {
  readonly status: BoardTaskWorkflowStatus;
  readonly currentPhase?: BoardTaskWorkflowPhase;
  readonly retryCount?: number;
  readonly substatus?: BoardTaskWorkflowSubstatus;
  readonly verificationStatus?: BoardTaskVerificationStatus;
  readonly message?: string;
  readonly error?: string;
}

export interface ApprovedPlanExecutionState {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly plan: WorkspaceTaskPlan;
  readonly repositories: Record<string, WorkspaceTaskRepositoryResult>;
  readonly retryCount: number;
  readonly status: BoardTaskWorkflowStatus;
  readonly error?: string;
}

export interface ApprovedPlanExecutionCallbacks {
  readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
}

export interface ApprovedPlanExecutionResult {
  readonly repositories: Record<string, WorkspaceTaskRepositoryResult>;
  readonly retryCount: number;
  readonly status: BoardTaskWorkflowStatus;
  readonly verificationStatus: BoardTaskVerificationStatus;
  readonly error?: string;
}

export type ApprovedPlanExecutor = (args: {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly plan: WorkspaceTaskPlan;
  readonly onRepoRunEvent: (repo: string, event: RunEvent) => void;
  readonly signal: AbortSignal;
}) => Promise<Record<string, WorkspaceTaskRepositoryResult>>;

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

export const mergeDuplicateWorkspacePlanRepositories = (
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

export const executeApprovedBoardPlan = async (opts: {
  readonly store: BoardStore;
  readonly state: ApprovedPlanExecutionState;
  readonly callbacks: ApprovedPlanExecutionCallbacks;
  readonly maxRepoRetries: number;
  readonly abortControllersByTask: Map<string, AbortController>;
  readonly throwIfCancelled: (taskId: string) => void;
  readonly updateWorkflow: (
    workflow: ApprovedPlanExecutionWorkflowPatch,
  ) => void;
  readonly execute: ApprovedPlanExecutor;
  readonly evaluate?: BoardTaskEvaluator;
  readonly onPlanChanged?: (plan: WorkspaceTaskPlan) => void;
}): Promise<ApprovedPlanExecutionResult> => {
  let retryCount = opts.state.retryCount;
  let repositories: Record<string, WorkspaceTaskRepositoryResult> = {};
  const executionPlan = mergeDuplicateWorkspacePlanRepositories(
    opts.state.plan,
  );
  if (executionPlan.changed) {
    opts.onPlanChanged?.(executionPlan.plan);
  }

  // Retries only re-execute the repositories that failed; earlier successful
  // repository results are kept instead of being re-run (and possibly undone).
  // Always execute at least once: a recovered task carries the cumulative
  // retry count of its previous execution, which may already exceed the retry
  // budget -- that must not skip the recovery attempt itself.
  let attemptPlan = executionPlan.plan;
  let firstAttempt = true;
  while (firstAttempt || retryCount <= opts.maxRepoRetries) {
    firstAttempt = false;
    opts.throwIfCancelled(opts.state.taskId);
    opts.updateWorkflow({
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
    opts.abortControllersByTask.set(opts.state.taskId, controller);
    try {
      const attemptResults = await opts.execute({
        taskId: opts.state.taskId,
        title: opts.state.title,
        prompt: opts.state.prompt,
        plan: attemptPlan,
        onRepoRunEvent: opts.callbacks.onRepoRunEvent,
        signal: controller.signal,
      });
      repositories = { ...repositories, ...attemptResults };
      opts.throwIfCancelled(opts.state.taskId);
      if (!hasFailedRepository(repositories)) break;
      retryCount += 1;
      if (retryCount > opts.maxRepoRetries) break;
      const failedRepositories = new Set(
        Object.entries(repositories)
          .filter(([, repo]) => repo.status === "failed")
          .map(([name]) => name),
      );
      attemptPlan = {
        ...executionPlan.plan,
        repositories: executionPlan.plan.repositories.filter((repo) =>
          failedRepositories.has(repo.name),
        ),
      };
    } finally {
      if (opts.abortControllersByTask.get(opts.state.taskId) === controller) {
        opts.abortControllersByTask.delete(opts.state.taskId);
      }
    }
  }

  opts.throwIfCancelled(opts.state.taskId);
  opts.updateWorkflow({
    status: "verifying",
    currentPhase: "verifying",
    substatus: undefined,
    retryCount,
    message: "Preparing deterministic verification evidence.",
  });
  const task = opts.store.getTask(opts.state.taskId);
  if (!task) {
    throw new Error(`Board task "${opts.state.taskId}" was not found.`);
  }
  const runs = opts.store
    .listRuns()
    .filter(
      (run) =>
        run.taskId === opts.state.taskId &&
        run.repo !== "(planner)" &&
        run.repo !== "(evaluator)",
    )
    .map((run) => ({ run, events: opts.store.getEvents(run.id) }));
  const { report, markdown } = renderTaskVerificationReport({
    task,
    repositoryResults: repositories,
    runs,
  });
  const progressMarkdown =
    opts.store.readTaskProgress(opts.state.taskId) ??
    opts.store.refreshTaskProgress(opts.state.taskId);
  let finalStatus = report.status;
  let finalMarkdown = markdown;
  let evaluatorIssueStatuses:
    | Parameters<typeof opts.store.syncTaskIssueStatuses>[1]
    | undefined;
  const hasAgentWork = repositoryAgentWorkWasRecorded(runs, repositories);
  if (opts.evaluate && hasAgentWork) {
    opts.updateWorkflow({
      status: "verifying",
      currentPhase: "verifying",
      substatus: undefined,
      retryCount,
      message: "Running Evaluator agent verification.",
    });
    const controller = new AbortController();
    opts.abortControllersByTask.set(opts.state.taskId, controller);
    try {
      const evaluation = await opts.evaluate({
        task,
        repositoryResults: repositories,
        runs,
        deterministicReport: report,
        deterministicMarkdown: markdown,
        progressMarkdown,
        signal: controller.signal,
      });
      finalStatus = evaluation.status;
      evaluatorIssueStatuses = evaluation.repositoryStatuses;
      finalMarkdown = renderEvaluatedVerificationMarkdown({
        task,
        status: finalStatus,
        deterministicMarkdown: markdown,
        evaluator: {
          kind: "completed",
          markdown: evaluation.markdown,
        },
      });
    } catch (error) {
      finalStatus = "failed";
      finalMarkdown = renderEvaluatedVerificationMarkdown({
        task,
        status: finalStatus,
        deterministicMarkdown: markdown,
        evaluator: {
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      evaluatorIssueStatuses = Object.fromEntries(
        (task.plan?.repositories ?? []).map((repo) => [
          repo.name,
          "verification-failed",
        ]),
      );
    } finally {
      if (opts.abortControllersByTask.get(opts.state.taskId) === controller) {
        opts.abortControllersByTask.delete(opts.state.taskId);
      }
    }
  } else if (opts.evaluate && !hasAgentWork) {
    finalMarkdown = renderEvaluatedVerificationMarkdown({
      task,
      status: finalStatus,
      deterministicMarkdown: markdown,
      evaluator: {
        kind: "skipped",
        reason:
          "no repository agent activity was recorded, so there was no delivery evidence for an Evaluator agent to review.",
      },
    });
  }
  opts.store.writeTaskVerification(opts.state.taskId, finalMarkdown);
  opts.store.syncTaskIssueStatuses(
    opts.state.taskId,
    evaluatorIssueStatuses ??
      Object.fromEntries(
        report.repositories.map((repo) => [repo.name, repo.issueStatus]),
      ),
  );
  const status: BoardTaskWorkflowStatus =
    finalStatus === "passed" || finalStatus === "infra-warning"
      ? "succeeded"
      : "failed";
  const infrastructureFailure = report.infrastructureFailures[0];
  const error =
    status === "failed"
      ? finalStatus === "needs-recovery"
        ? infrastructureFailure
          ? `Verification needs recovery: repository execution failed before the agent produced any work. ${infrastructureFailure}`
          : "Verification needs recovery: repository execution results were missing."
        : finalStatus === "needs-verification"
          ? "Verification incomplete: PRD acceptance criteria still need recorded integration or manual evidence."
          : infrastructureFailure
            ? `Verification failed: one or more repositories did not pass delivery checks. ${infrastructureFailure}`
            : "Verification failed: one or more repositories did not pass delivery checks."
      : undefined;
  opts.updateWorkflow({
    status,
    currentPhase: "verifying",
    substatus: undefined,
    retryCount,
    verificationStatus: finalStatus,
    ...(error
      ? { error }
      : {
          message:
            finalStatus === "infra-warning"
              ? "Workspace task verified with infrastructure warnings."
              : "Workspace task verified.",
        }),
  });
  return {
    repositories,
    retryCount,
    status,
    verificationStatus: finalStatus,
    ...(error ? { error } : {}),
  };
};
