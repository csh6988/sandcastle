import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type { DeliveryCandidateView } from "../runtime/interface.js";
import { connectDeliveryCandidate } from "./deliveryCandidateView.js";

const view = (
  projection: DeliveryCandidateView["projection"],
): DeliveryCandidateView =>
  ({
    id: "delivery-candidate-1",
    requestId: "delivery-candidate-request-1",
    manifest: {},
    manifestHash: "1".repeat(64),
    projection,
    decision: null,
    supersededByCandidateId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  }) as DeliveryCandidateView;

describe("Delivery Candidate renderer projection", () => {
  it("rebuilds the authoritative Candidate/decision View after an invalidating Runtime Event", async () => {
    let queryCount = 0;
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    const views: DeliveryCandidateView[] = [];
    const bridge = {
      query: async () => {
        queryCount += 1;
        return {
          view: view(queryCount > 1 ? "accepted" : "awaiting-decision"),
          asOfSequence: queryCount,
          viewSyncToken: `delivery-candidate-token-${queryCount}`,
        };
      },
      execute: async () => ({
        status: "succeeded",
        value: {
          acknowledged: true,
          subscriptionGeneration: 18,
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
          subscriptionId: "subscription-delivery-candidate",
          subscriptionGeneration: 18,
          barrierSequence: 1,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectDeliveryCandidate({
      bridge,
      candidateId: "delivery-candidate-1",
      onView: (next) => views.push(next),
      onDiagnostic: () => undefined,
    });
    assert.equal(views.at(-1)?.projection, "awaiting-decision");
    await eventSink({
      subscriptionId: "subscription-delivery-candidate",
      subscriptionGeneration: 18,
      barrierSequence: 1,
      value: {
        kind: "event",
        event: {
          registryVersion: 18,
          schemaVersion: 1,
          sequence: 2,
          eventId: "event-release-accepted",
          type: "delivery.release.accepted",
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          deliveryCandidateInputId: "candidate-input-1",
          deliveryCandidateId: "delivery-candidate-1",
          releaseDecisionId: "release-decision-1",
          commandId: "command-release-1",
          payload: {},
          timestamp: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    assert.equal(queryCount, 2);
    assert.equal(views.at(-1)?.projection, "accepted");
    await connection.close();
  });
});
