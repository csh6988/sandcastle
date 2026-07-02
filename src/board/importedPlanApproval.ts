import type {
  BoardStore,
  BoardTaskPlan,
  BoardTaskRecord,
  BoardTaskWorkflowPhase,
  BoardTaskWorkflowStatus,
  BoardTaskWorkflowSubstatus,
} from "./BoardStore.js";
import type { TaskRunResult } from "./launchTask.js";
import type {
  WorkspaceTaskPlan,
  WorkspaceTaskRepositoryOptions,
} from "../runWorkspaceTask.js";

export type ImportedWorkspacePlanApprovalDecision = "approve" | "reject";

export type ExportImportedWorkspacePlan = (args: {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly plan: WorkspaceTaskPlan;
}) => Promise<void>;

export interface ImportedWorkspacePlanWorkflowPatch {
  readonly status: BoardTaskWorkflowStatus;
  readonly currentPhase?: BoardTaskWorkflowPhase;
  readonly substatus?: BoardTaskWorkflowSubstatus;
  readonly message?: string;
  readonly error?: string;
}

export const boardPlanToWorkspacePlan = (
  plan: BoardTaskPlan,
): WorkspaceTaskPlan => ({
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
    : plan.alignmentSummary
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

const workflowNow = () => new Date().toISOString();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAwaitingApprovalWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.status === "awaiting-approval" ||
    task.workflow?.currentPhase === "awaiting-approval");

export const isImportedWorkspacePlanAwaitingApproval = (
  task: BoardTaskRecord,
): boolean =>
  task.source?.type === "workspace-plan" && isAwaitingApprovalWithPlan(task);

export const handleImportedWorkspacePlanApproval = async (opts: {
  readonly store: BoardStore;
  readonly task: BoardTaskRecord;
  readonly decision: ImportedWorkspacePlanApprovalDecision;
  readonly planningOnly?: boolean;
  readonly updateWorkflow: (
    workflow: ImportedWorkspacePlanWorkflowPatch,
  ) => void;
  readonly failTask: (message: string) => void;
  readonly exportApprovedPlan?: ExportImportedWorkspacePlan;
  readonly executeApprovedPlan: (
    plan: WorkspaceTaskPlan,
  ) => Promise<TaskRunResult | undefined>;
  readonly now?: () => string;
}): Promise<TaskRunResult | undefined> => {
  if (!isImportedWorkspacePlanAwaitingApproval(opts.task) || !opts.task.plan) {
    return undefined;
  }

  const now = opts.now ?? workflowNow;

  try {
    if (opts.decision === "reject") {
      opts.updateWorkflow({
        status: "rejected",
        substatus: undefined,
        message: "Workspace plan was rejected.",
      });
      opts.store.updateTask(opts.task.id, {
        status: "failed",
        finishedAt: now(),
        error: "Workspace plan was rejected.",
      });
      return { repositories: {} };
    }

    const plan = boardPlanToWorkspacePlan(opts.task.plan);
    if (opts.planningOnly) {
      await opts.exportApprovedPlan?.({
        taskId: opts.task.id,
        title: opts.task.title,
        prompt: opts.task.prompt,
        plan,
      });
      opts.updateWorkflow({
        status: "succeeded",
        currentPhase: "awaiting-approval",
        substatus: undefined,
        message: "Approved workspace plan artifacts were exported.",
      });
      opts.store.updateTask(opts.task.id, {
        status: "succeeded",
        finishedAt: now(),
      });
      return { repositories: {} };
    }

    return opts.executeApprovedPlan(plan);
  } catch (error) {
    opts.failTask(errorMessage(error));
    throw error;
  }
};
