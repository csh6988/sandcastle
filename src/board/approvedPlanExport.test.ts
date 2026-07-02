import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { exportApprovedBoardPlan } from "./approvedPlanExport.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

describe("exportApprovedBoardPlan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-approved-plan-export-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes planning artifacts and records a board-visible manifest", () => {
    const store = new BoardStore(join(dir, ".sandcastle", "board"));
    const task = store.createTask({
      title: "Reviewed workspace plan",
      prompt: "Export the plan after approval.",
    });
    const plan: WorkspaceTaskPlan = {
      alignment: { summary: "Keep the approved plan inspectable." },
      technicalPlan: "1. Export artifacts.\n2. Stop before execution.",
      repositories: [
        {
          name: "api",
          task: "Write the API issue.",
          issue: {
            title: "API issue",
            body: "status: ready-for-agent\n\nShip the API change.",
          },
        },
        {
          name: "web/app",
          task: "Write the web issue.",
        },
      ],
    };

    exportApprovedBoardPlan({
      store,
      cwd: dir,
      taskId: task.id,
      artifactsDir: join(dir, "exports", "reviewed-plan"),
      plan,
      createdAt: "2026-06-30T00:00:00.000Z",
    });

    expect(
      readFileSync(
        join(dir, "exports", "reviewed-plan", "workspace-plan.json"),
        "utf8",
      ),
    ).toBe(`${JSON.stringify(plan, null, 2)}\n`);
    expect(
      store.listTaskArtifacts(task.id).map((artifact) => ({
        kind: artifact.kind,
        displayPath: artifact.displayPath,
        createdAt: artifact.createdAt,
      })),
    ).toEqual([
      {
        kind: "workspace-plan",
        displayPath: "exports/reviewed-plan/workspace-plan.json",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      {
        kind: "alignment",
        displayPath: "exports/reviewed-plan/alignment.md",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      {
        kind: "technical-plan",
        displayPath: "exports/reviewed-plan/technical-plan.md",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      {
        kind: "issue",
        displayPath: "exports/reviewed-plan/issues/api.md",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      {
        kind: "issue",
        displayPath: "exports/reviewed-plan/issues/web-app.md",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
    ]);
  });
});
