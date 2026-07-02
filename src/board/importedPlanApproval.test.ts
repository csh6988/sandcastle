import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import {
  handleImportedWorkspacePlanApproval,
  isImportedWorkspacePlanAwaitingApproval,
} from "./importedPlanApproval.js";
import { workspacePlanToBoardPlan } from "./langGraphTaskRunner.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

describe("handleImportedWorkspacePlanApproval", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-imported-plan-approval-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const createImportedTask = (plan: WorkspaceTaskPlan) => {
    const task = store.createTask({
      title: "Imported workspace plan",
      prompt: "Execute approved workspace plan from /tmp/workspace-plan.json.",
    });
    return store.updateTask(task.id, {
      status: "running",
      source: {
        type: "workspace-plan",
        planFile: "/tmp/workspace-plan.json",
      },
      plan: workspacePlanToBoardPlan(plan),
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    })!;
  };

  it("rejects an imported workspace plan without entering graph execution", async () => {
    const task = createImportedTask({
      repositories: [{ name: "api", task: "Ship API work." }],
    });
    const workflowUpdates: unknown[] = [];
    let executeCalls = 0;

    const result = await handleImportedWorkspacePlanApproval({
      store,
      task,
      decision: "reject",
      planningOnly: false,
      updateWorkflow: (workflow) => workflowUpdates.push(workflow),
      failTask: () => {},
      executeApprovedPlan: async () => {
        executeCalls++;
        return { repositories: {} };
      },
    });

    expect(result).toEqual({ repositories: {} });
    expect(executeCalls).toBe(0);
    expect(workflowUpdates).toContainEqual({
      status: "rejected",
      substatus: undefined,
      message: "Workspace plan was rejected.",
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "Workspace plan was rejected.",
    });
  });

  it("exports an imported workspace plan in planning-only mode without execution", async () => {
    const plan: WorkspaceTaskPlan = {
      technicalPlan: "Export only.",
      repositories: [{ name: "api", task: "Ship API work." }],
    };
    const task = createImportedTask(plan);
    const workflowUpdates: unknown[] = [];
    const exportedPlans: WorkspaceTaskPlan[] = [];
    let executeCalls = 0;

    const result = await handleImportedWorkspacePlanApproval({
      store,
      task,
      decision: "approve",
      planningOnly: true,
      updateWorkflow: (workflow) => workflowUpdates.push(workflow),
      failTask: () => {},
      exportApprovedPlan: async ({ plan }) => {
        exportedPlans.push(plan);
      },
      executeApprovedPlan: async () => {
        executeCalls++;
        return { repositories: {} };
      },
    });

    expect(result).toEqual({ repositories: {} });
    expect(executeCalls).toBe(0);
    expect(exportedPlans).toMatchObject([plan]);
    expect(workflowUpdates).toContainEqual({
      status: "succeeded",
      currentPhase: "awaiting-approval",
      substatus: undefined,
      message: "Approved workspace plan artifacts were exported.",
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      finishedAt: expect.any(String),
    });
  });
});

describe("isImportedWorkspacePlanAwaitingApproval", () => {
  it("only matches imported plan tasks that still have a plan awaiting approval", () => {
    const task = storeFixture({
      source: { type: "workspace-plan", planFile: "/tmp/plan.json" },
      plan: { repositories: [] },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    expect(isImportedWorkspacePlanAwaitingApproval(task)).toBe(true);
    expect(
      isImportedWorkspacePlanAwaitingApproval(
        storeFixture({ source: undefined, plan: task.plan }),
      ),
    ).toBe(false);
  });
});

const storeFixture = (
  overrides: Partial<ReturnType<BoardStore["createTask"]>>,
): ReturnType<BoardStore["createTask"]> => ({
  id: "task-1",
  title: "Task",
  prompt: "Prompt",
  status: "running",
  createdAt: "2026-06-30T00:00:00.000Z",
  runIds: [],
  ...overrides,
});
