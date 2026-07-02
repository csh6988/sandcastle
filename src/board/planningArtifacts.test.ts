import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWorkspacePlanningArtifacts } from "./planningArtifacts.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

describe("writeWorkspacePlanningArtifacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-planning-artifacts-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the same deterministic artifact set as workspace planning", () => {
    const plan: WorkspaceTaskPlan = {
      alignment: {
        summary: "Ship the migration in two repos.",
        assumptions: ["The API owns persistence."],
        openQuestions: ["Confirm rollout date."],
      },
      technicalPlan: "1. Update API.\n2. Update web.",
      workspace: {
        branchPrefix: "codex/migration",
        maxIterations: 2,
        repositories: [
          { name: "api", cwd: "/repos/api", kind: "backend" },
          { name: "web/app", cwd: "/repos/web", kind: "frontend" },
        ],
      },
      repositories: [
        {
          name: "api",
          task: "Add the persistence migration.",
          reason: "The API owns writes.",
          issue: {
            title: "Migrate persistence",
            body: "status: ready-for-agent\n\nAdd the persistence migration.",
          },
        },
        {
          name: "web/app",
          task: "Update the settings UI.",
        },
      ],
    };

    const artifacts = writeWorkspacePlanningArtifacts(dir, plan);

    expect(artifacts.issuePaths.map((path) => path.replace(dir, ""))).toEqual([
      "/issues/api.md",
      "/issues/web-app.md",
    ]);
    expect(readFileSync(artifacts.planJsonPath, "utf8")).toBe(
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    expect(readFileSync(artifacts.alignmentPath, "utf8")).toContain(
      "# Workspace PRD Alignment",
    );
    expect(readFileSync(artifacts.alignmentPath, "utf8")).toContain(
      "- The API owns persistence.",
    );
    expect(readFileSync(artifacts.technicalPlanPath, "utf8")).toContain(
      "1. Update API.\n2. Update web.",
    );
    expect(readFileSync(artifacts.issuePaths[0]!, "utf8"))
      .toBe(`# Migrate persistence

status: ready-for-agent

Add the persistence migration.
`);
    expect(readFileSync(artifacts.issuePaths[1]!, "utf8")).toContain(
      "# web/app: Update the settings UI.",
    );
  });
});
