import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureCompanyDirectory } from "../main/companyDirectory.js";
import {
  acceptDelivery,
  confirmDesign,
  confirmPrd,
  createProject,
  listProjects,
  markRdVerified,
  readProject,
  rejectDelivery,
  requestChanges,
  skipDesign,
  startRdExecution,
} from "../main/projectStore.js";

const tempCompanyDir = (): string => {
  const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-projects-"));
  ensureCompanyDirectory(companyDir);
  return companyDir;
};

describe("project store", () => {
  it("creates a project delivery object in the local AI company directory", () => {
    const companyDir = tempCompanyDir();

    const project = createProject(companyDir, {
      name: "Checkout Redesign",
      summary: "Improve the checkout flow.",
      repositories: ["/repo/app"],
    });

    assert.equal(project.name, "Checkout Redesign");
    assert.equal(project.summary, "Improve the checkout flow.");
    assert.equal(project.status, "draft");
    assert.equal(project.prd.status, "draft");
    assert.equal(project.design.status, "draft");
    assert.deepEqual(project.rd.repositories, ["/repo/app"]);
    assert.equal(project.prd.path, "prd/prd.md");
    assert.equal(project.design.path, "design/design.md");

    const stored = readProject(companyDir, project.id);
    assert.deepEqual(stored, project);
    assert.deepEqual(listProjects(companyDir), [project]);

    const index = JSON.parse(
      readFileSync(
        join(companyDir, ".sandcastle", "project-index.json"),
        "utf8",
      ),
    );
    assert.deepEqual(index, {
      projects: [{ id: project.id, path: `projects/${project.id}` }],
    });
  });

  it("guards R&D execution until PRD and Design are confirmed", () => {
    const companyDir = tempCompanyDir();
    const project = createProject(companyDir, {
      name: "Guarded Delivery",
      summary: "Ship only after human confirmation.",
      repositories: ["/repo/app"],
    });

    assert.throws(
      () => startRdExecution(companyDir, project.id, "task-1"),
      /PRD is not confirmed/,
    );

    writeFileSync(
      join(companyDir, "projects", project.id, project.prd.path),
      "# PRD\n",
    );
    const prdConfirmed = confirmPrd(companyDir, project.id);
    assert.equal(prdConfirmed.status, "prd-confirmed");
    assert.equal(prdConfirmed.prd.status, "confirmed");

    assert.throws(
      () => startRdExecution(companyDir, project.id, "task-1"),
      /Design is neither confirmed nor skipped/,
    );

    writeFileSync(
      join(companyDir, "projects", project.id, project.design.path),
      "# Design\n",
    );
    const designConfirmed = confirmDesign(companyDir, project.id);
    assert.equal(designConfirmed.status, "design-ready");
    assert.equal(designConfirmed.design.status, "confirmed");

    const inRd = startRdExecution(companyDir, project.id, "task-1");
    assert.equal(inRd.status, "in-rd");
    assert.equal(inRd.rd.currentBoardTaskId, "task-1");
  });

  it("allows Design to be skipped only with a reason", () => {
    const companyDir = tempCompanyDir();
    const project = createProject(companyDir, {
      name: "Skip Design",
      summary: "Use PRD only.",
    });
    writeFileSync(
      join(companyDir, "projects", project.id, project.prd.path),
      "# PRD\n",
    );
    confirmPrd(companyDir, project.id);

    assert.throws(
      () => skipDesign(companyDir, project.id, " "),
      /Design skip reason is required/,
    );

    const skipped = skipDesign(
      companyDir,
      project.id,
      "Small copy-only change.",
    );
    assert.equal(skipped.status, "design-ready");
    assert.equal(skipped.design.status, "skipped");
    assert.equal(skipped.design.skippedReason, "Small copy-only change.");

    const inRd = startRdExecution(companyDir, project.id, "task-1");
    assert.equal(inRd.status, "in-rd");
  });

  it("marks a confirmed PRD as stale after an external edit", () => {
    const companyDir = tempCompanyDir();
    const project = createProject(companyDir, {
      name: "Stale PRD",
      summary: "Detect changed requirements.",
    });
    const prdPath = join(companyDir, "projects", project.id, project.prd.path);
    writeFileSync(prdPath, "# PRD\n");
    confirmPrd(companyDir, project.id);

    writeFileSync(prdPath, "# PRD changed outside Desktop\n");

    const stale = readProject(companyDir, project.id);
    assert.equal(stale.status, "draft");
    assert.equal(stale.prd.status, "stale");
    assert.throws(
      () => startRdExecution(companyDir, project.id, "task-1"),
      /PRD is not confirmed/,
    );
  });

  it("marks a confirmed Design as stale after an external edit", () => {
    const companyDir = tempCompanyDir();
    const project = createProject(companyDir, {
      name: "Stale Design",
      summary: "Detect changed design.",
    });
    writeFileSync(
      join(companyDir, "projects", project.id, project.prd.path),
      "# PRD\n",
    );
    confirmPrd(companyDir, project.id);
    const designPath = join(
      companyDir,
      "projects",
      project.id,
      project.design.path,
    );
    writeFileSync(designPath, "# Design\n");
    confirmDesign(companyDir, project.id);

    writeFileSync(designPath, "# Design changed outside Desktop\n");

    const stale = readProject(companyDir, project.id);
    assert.equal(stale.status, "prd-confirmed");
    assert.equal(stale.design.status, "stale");
    assert.throws(
      () => startRdExecution(companyDir, project.id, "task-1"),
      /Design is neither confirmed nor skipped/,
    );
  });

  it("moves from verified R&D into human review decisions", () => {
    const companyDir = tempCompanyDir();
    const project = createProject(companyDir, {
      name: "Review Flow",
      summary: "Finish through review.",
    });
    writeFileSync(
      join(companyDir, "projects", project.id, project.prd.path),
      "# PRD\n",
    );
    confirmPrd(companyDir, project.id);
    skipDesign(companyDir, project.id, "No design needed.");
    startRdExecution(companyDir, project.id, "task-1");

    const ready = markRdVerified(companyDir, project.id);
    assert.equal(ready.status, "ready-for-review");
    assert.equal(ready.rd.currentBoardTaskId, null);
    assert.deepEqual(ready.rd.history, ["task-1"]);

    const changes = requestChanges(companyDir, project.id, "Rerun R&D only");
    assert.equal(changes.status, "changes-requested");
    const rerun = startRdExecution(companyDir, project.id, "task-2");
    assert.equal(rerun.status, "in-rd");
    markRdVerified(companyDir, project.id);
    assert.equal(acceptDelivery(companyDir, project.id).status, "accepted");

    const rejectedProject = createProject(companyDir, {
      name: "Reject Flow",
      summary: "Exercise rejection.",
    });
    writeFileSync(
      join(
        companyDir,
        "projects",
        rejectedProject.id,
        rejectedProject.prd.path,
      ),
      "# PRD\n",
    );
    confirmPrd(companyDir, rejectedProject.id);
    skipDesign(companyDir, rejectedProject.id, "No design needed.");
    startRdExecution(companyDir, rejectedProject.id, "task-3");
    markRdVerified(companyDir, rejectedProject.id);
    assert.equal(
      rejectDelivery(companyDir, rejectedProject.id).status,
      "rejected",
    );
  });
});
