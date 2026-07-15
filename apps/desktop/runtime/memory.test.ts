import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-memory-"));

describe("Runtime Memory", () => {
  it("promotes an explicit Project Memory Candidate only after approval", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const candidate = database.memory.createCandidate({
        projectId: project.id,
        scope: "project",
        sourceSessionId: session.id,
        summary:
          "Checkout deploys require payment-provider compatibility checks.",
      });

      assert.equal(database.memory.listRecords(project.id).length, 0);
      const approved = database.memory.reviewCandidate({
        candidateId: candidate.id,
        expectedStatus: "pending",
        decision: "approved",
      });

      assert.equal(approved.candidate.status, "approved");
      assert.equal(approved.record?.version, 1);
      assert.equal(
        database.memory.listRecords(project.id)[0]?.content,
        candidate.summary,
      );
    } finally {
      database.close();
    }
  });

  it("rejects likely secret material before a Candidate is persisted", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      assert.throws(
        () =>
          database.memory.createCandidate({
            projectId: project.id,
            scope: "project",
            summary: "token=super-secret-value",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "MEMORY_CANDIDATE_SENSITIVE",
      );
    } finally {
      database.close();
    }
  });
});
