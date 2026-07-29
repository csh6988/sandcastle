import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type { TestRunView } from "../runtime/interface.js";
import { connectTestRun } from "./testRunView.js";

const view = (state: TestRunView["state"], viewHash: string) =>
  ({ id: "test-run-1", state, viewHash }) as TestRunView;

describe("Test Run renderer projection", () => {
  it("rebuilds from the authoritative Query View on reload and uses Runtime Events only as invalidation", async () => {
    let queryCount = 0;
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    const views: TestRunView[] = [];
    const bridge = {
      query: async () => {
        queryCount += 1;
        return {
          view: view(
            queryCount === 1 ? "running" : "passed",
            String(queryCount).repeat(64),
          ),
          asOfSequence: queryCount,
          viewSyncToken: `view-token-${queryCount}`,
        };
      },
      execute: async () => ({
        status: "succeeded",
        value: {
          acknowledged: true,
          subscriptionGeneration: 7,
          barrierSequence: queryCount,
          auditId: `audit-${queryCount}`,
        },
        effectIds: [],
      }),
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        eventSink = sink;
        return {
          subscriptionId: "subscription-test",
          subscriptionGeneration: 7,
          barrierSequence: 1,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectTestRun({
      bridge,
      testRunId: "test-run-1",
      onView: (next) => views.push(next),
      onDiagnostic: () => undefined,
    });
    assert.equal(views.at(-1)?.state, "running");
    await eventSink({
      subscriptionId: "subscription-test",
      subscriptionGeneration: 7,
      barrierSequence: 1,
      value: {
        kind: "event",
        event: {
          schemaVersion: 1,
          sequence: 2,
          eventId: "event-test-2",
          type: "test.run.completed",
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          nodeRunId: "test-node-1",
          testRunId: "test-run-1",
          payload: { testRunId: "test-run-1", state: "passed" },
          timestamp: "2026-07-29T00:00:00.000Z",
        },
      },
    });
    assert.equal(queryCount, 2);
    assert.equal(views.at(-1)?.state, "passed");

    await connection.resync();
    assert.equal(queryCount, 3);
    assert.equal(views.at(-1)?.viewHash, "3".repeat(64));
    await connection.close();
  });
});
