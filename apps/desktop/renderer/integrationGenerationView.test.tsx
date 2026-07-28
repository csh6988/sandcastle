import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type { IntegrationGenerationView } from "../runtime/interface.js";
import {
  applyIntegrationGenerationFrame,
  connectIntegrationGenerations,
} from "./integrationGenerationView.js";

const generationView = (state: IntegrationGenerationView["state"]) =>
  ({ id: "generation-1", state }) as IntegrationGenerationView;

describe("Integration Generation renderer projection", () => {
  it("rebuilds from the authoritative Query View and treats Runtime Events only as invalidation", async () => {
    let queryCount = 0;
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    const frames: Array<{
      readonly generation: number;
      readonly view: readonly IntegrationGenerationView[];
    }> = [];
    const bridge = {
      query: async () => {
        queryCount += 1;
        return {
          view: [generationView(queryCount === 1 ? "running" : "validating")],
          asOfSequence: queryCount,
          viewSyncToken: `view-token-${queryCount}`,
        };
      },
      execute: async () => ({
        status: "succeeded",
        value: {
          acknowledged: true,
          subscriptionGeneration: 4,
          barrierSequence: 1,
          auditId: "audit-1",
        },
        effectIds: [],
      }),
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        eventSink = sink;
        return {
          subscriptionId: "subscription-1",
          subscriptionGeneration: 4,
          barrierSequence: 1,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectIntegrationGenerations({
      bridge,
      runId: "run-1",
      onFrame: (frame) => frames.push(frame),
      onDiagnostic: () => undefined,
    });
    assert.equal(frames.at(-1)?.view[0]?.state, "running");

    await eventSink({
      subscriptionId: "subscription-1",
      subscriptionGeneration: 4,
      barrierSequence: 1,
      value: {
        kind: "event",
        event: {
          schemaVersion: 1,
          sequence: 2,
          eventId: "event-2",
          type: "integration.validation.recorded",
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          nodeRunId: "integration-node-1",
          integrationGenerationId: "generation-1",
          payload: {
            generationId: "generation-1",
            validationId: "validation-1",
            state: "passed",
          },
          timestamp: "2026-07-28T00:00:00.000Z",
        },
      },
    });
    assert.equal(queryCount, 2);
    assert.equal(frames.at(-1)?.view[0]?.state, "validating");

    const current = applyIntegrationGenerationFrame(
      { generation: 4, view: [generationView("validating")] },
      { generation: 3, view: [generationView("running")] },
    );
    assert.equal(current.view[0]?.state, "validating");
    await connection.close();
  });
});
