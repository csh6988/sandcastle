import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { createImportedWorkspacePlanTask } from "./workspacePlanImport.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

describe("createImportedWorkspacePlanTask", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-plan-import-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates an awaiting-approval board task from an existing workspace plan", () => {
    const plan: WorkspaceTaskPlan = {
      alignment: { summary: "Reviewed PRD alignment." },
      technicalPlan: "Implement the imported plan.",
      workspace: {
        branchPrefix: "sandcastle/imported",
        repositories: [{ name: "web", cwd: "/repos/web" }],
      },
      repositories: [
        {
          name: "web",
          task: "Add the imported page",
          issue: {
            title: "Add imported page",
            body: "status: ready-for-agent\n\nImplement the page.",
          },
        },
      ],
    };

    const task = createImportedWorkspacePlanTask(store, {
      plan,
      planFile: "/tmp/my-feature/workspace-plan.json",
    });

    expect(task).toMatchObject({
      title: "Imported workspace plan: my-feature",
      prompt:
        "Execute approved workspace plan from /tmp/my-feature/workspace-plan.json.",
      status: "running",
      source: {
        type: "workspace-plan",
        planFile: "/tmp/my-feature/workspace-plan.json",
      },
      plan: {
        alignmentSummary: "Reviewed PRD alignment.",
        technicalPlan: "Implement the imported plan.",
        workspace: {
          branchPrefix: "sandcastle/imported",
          repositories: [{ name: "web", cwd: "/repos/web" }],
        },
        repositories: [
          {
            name: "web",
            task: "Add the imported page",
            issue: { title: "Add imported page" },
          },
        ],
      },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
      },
    });
    expect(store.readTaskProgress(task.id)).toContain(
      "# Board Execution Progress",
    );
    expect(store.readTaskIssue(task.id, "web")).toContain(
      "status: ready-for-agent",
    );
  });

  it("records artifact export approval action for planning-only imported plans", () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [{ name: "web", task: "Export the reviewed task" }],
    };

    const task = createImportedWorkspacePlanTask(store, {
      plan,
      planFile: "/tmp/workspace-plan.json",
      planningOnly: true,
    });

    expect(task.workflow).toMatchObject({
      status: "awaiting-approval",
      approvedPlanAction: "export-artifacts",
    });
  });

  it("initializes default issue markdown when the imported plan has no issue body", () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [
        {
          name: "api/service",
          task: "Add the imported API behavior",
          reason: "The backend owns the behavior.",
        },
      ],
    };

    const task = createImportedWorkspacePlanTask(store, {
      plan,
      planFile: "/tmp/workspace-plan.json",
    });

    expect(store.readTaskIssue(task.id, "api/service"))
      .toBe(`# api/service: Add the imported API behavior

status: ready-for-agent

## What to build

Add the imported API behavior
`);
    expect(store.readTaskProgress(task.id)).toContain(
      "Reason: The backend owns the behavior.",
    );
  });
});
