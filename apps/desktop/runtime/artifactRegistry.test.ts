import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-artifact-registry-"));

describe("Artifact Registry", () => {
  it("registers immutable Artifact Versions with content integrity and input lineage", async () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const node = waiting.nodes.find(
        (candidate) => candidate.pipelineNodeId === "product-alignment",
      );
      const attempt = node?.attempts[0];
      assert.ok(node && attempt);
      const position = waiting.snapshot.payload.positions.find(
        (candidate) => candidate.id === "product-planner",
      );
      assert.ok(position);

      const first = database.artifactRegistry.registerVersion({
        projectId: project.id,
        type: "verification-report",
        schemaVersion: "1",
        logicalName: "checkout-verification",
        content: "evidence",
        status: "produced",
        producer: {
          runId: started.run.id,
          nodeRunId: node.id,
          nodeAttemptId: attempt.id,
          snapshotRevisionId: waiting.snapshot.id,
          aiMemberId: position.aiMember.id,
        },
      });
      const second = database.artifactRegistry.registerVersion({
        projectId: project.id,
        type: "verification-report",
        schemaVersion: "1",
        logicalName: "checkout-verification",
        content: "evidence v2",
        status: "produced",
        producer: {
          runId: started.run.id,
          nodeRunId: node.id,
          nodeAttemptId: attempt.id,
          snapshotRevisionId: waiting.snapshot.id,
          aiMemberId: position.aiMember.id,
        },
        inputVersionIds: [first.id],
      });
      const accepted = database.artifactRegistry.setStatus({
        versionId: second.id,
        expectedStatus: "produced",
        status: "accepted",
      });

      assert.equal(first.version, 1);
      assert.equal(second.version, 2);
      assert.equal(accepted.status, "accepted");
      assert.equal(
        first.contentHash,
        "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e",
      );
      assert.equal(readFileSync(first.contentRef, "utf8"), "evidence");
      assert.equal(existsSync(first.contentRef), true);
      assert.deepEqual(database.artifactRegistry.lineage(second.id), [
        { versionId: first.id, relation: "input" },
      ]);
      assert.deepEqual(
        database.artifactRegistry
          .listVersions(project.id)
          .map((version) => version.version),
        [1, 2],
      );
    } finally {
      database.close();
    }
  });
});
