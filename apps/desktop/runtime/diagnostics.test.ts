import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-diagnostics-"));

describe("Runtime Diagnostics", () => {
  it("reports integrity and compacts only acknowledged Runtime events", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Private product goal",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const events = database.pipelineRuntime.runtimeEvents({
        afterSequence: 0,
        limit: 100,
      });
      assert.ok(events[0]);
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "diagnostics-test",
        sequence: events.at(-1)!.sequence,
      });
      const before = database.diagnostics.inspect();
      const compacted = database.diagnostics.compactRuntimeEvents({
        retainLast: 0,
      });
      const after = database.diagnostics.inspect();

      assert.equal(before.sqliteIntegrity, "ok");
      assert.equal(before.schemaVersion, 23);
      assert.ok(compacted.deleted >= 1);
      assert.equal(after.runtimeEventCount, 0);
      assert.ok(after.auditRecordCount >= 1);
      assert.equal(
        JSON.stringify(database.diagnostics.exportRedacted()).includes(
          "Private product goal",
        ),
        false,
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(started.run.id).snapshot.hash,
        started.snapshot.hash,
      );
    } finally {
      database.close();
    }
  });
});
