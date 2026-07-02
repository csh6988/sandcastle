import { basename, dirname } from "node:path";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";
import {
  type BoardStore,
  type BoardTaskApprovedPlanAction,
  type BoardTaskRecord,
} from "./BoardStore.js";
import { workspacePlanToBoardPlan } from "./langGraphTaskRunner.js";

const workflowNow = () => new Date().toISOString();

export const importedWorkspacePlanTitle = (planFile: string): string => {
  const parent = basename(dirname(planFile));
  const file = basename(planFile);
  const label = parent && parent !== "." ? parent : file;
  return `Imported workspace plan: ${label}`;
};

export const createImportedWorkspacePlanTask = (
  store: BoardStore,
  input: {
    readonly plan: WorkspaceTaskPlan;
    readonly planFile: string;
    readonly title?: string;
    readonly planningOnly?: boolean;
  },
): BoardTaskRecord => {
  const title = input.title ?? importedWorkspacePlanTitle(input.planFile);
  const approvedPlanAction: BoardTaskApprovedPlanAction = input.planningOnly
    ? "export-artifacts"
    : "execute";
  const task = store.createTask({
    title,
    prompt: `Execute approved workspace plan from ${input.planFile}.`,
  });
  return (
    store.updateTask(task.id, {
      status: "running",
      source: {
        type: "workspace-plan",
        planFile: input.planFile,
      },
      plan: workspacePlanToBoardPlan(input.plan),
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        approvedPlanAction,
        checkpointThreadId: task.id,
        message: "Imported workspace plan is waiting for approval.",
        updatedAt: workflowNow(),
      },
    }) ?? task
  );
};
