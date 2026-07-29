import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { TestRunView, TestRuntime } from "./testRuntime.js";
import { openTestNodeHandler } from "./testNodeHandler.js";

const runView = (state: TestRunView["state"]): TestRunView =>
  ({
    id: "test:run-1:node-1",
    state,
    passAuthorityHash: state === "passed" ? "a".repeat(64) : null,
    manifest: { runId: "run-1", nodeRunId: "node-1" },
  }) as TestRunView;

describe("Test Node Handler", () => {
  it("requests only Pipeline-owned start, reconcile, and completion transitions", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    const transitions: string[] = [];
    let state: TestRunView["state"] | null = null;
    const pipelineRuntime = {
      startTestInTransaction: () => {
        transitions.push("start");
        return { nodeAttemptId: "attempt-1" };
      },
      blockTestInTransaction: () => transitions.push("block"),
      resumeTestInTransaction: () => transitions.push("resume"),
      failTestInTransaction: () => transitions.push("fail"),
      completeTestInTransaction: () => transitions.push("complete"),
    } as Pick<
      PipelineRuntime,
      | "startTestInTransaction"
      | "blockTestInTransaction"
      | "resumeTestInTransaction"
      | "failTestInTransaction"
      | "completeTestInTransaction"
    >;
    const tests = {
      inspect: () => runView(state ?? "scheduled"),
    } as Pick<TestRuntime, "inspect">;
    const handler = openTestNodeHandler({ database, pipelineRuntime, tests });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "unknown";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "running";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "passed";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(transitions, ["start", "block", "resume", "complete"]);
    database.close();
  });
});
