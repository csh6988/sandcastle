import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type { CandidateQualityGateView } from "../runtime/interface.js";
import { connectCandidateQualityGates } from "./candidateQualityGateView.js";

const view = (authority: boolean): CandidateQualityGateView =>
  ({
    candidateInput: { id: "candidate-input-1" },
    criticalEscalation: authority
      ? {
          id: "critical-escalation-1",
          decision: "authorize-gate-continuation",
        }
      : null,
    gateInputs: [],
    gateResults: [],
    authority: authority ? { id: "candidate-authority-1" } : null,
  }) as unknown as CandidateQualityGateView;

describe("Candidate Quality Gate renderer projection", () => {
  it("rebuilds from the authoritative Query View on reload and treats Runtime Events as invalidation", async () => {
    let queryCount = 0;
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    const views: CandidateQualityGateView[] = [];
    const bridge = {
      query: async () => {
        queryCount += 1;
        return {
          view: view(queryCount > 1),
          asOfSequence: queryCount,
          viewSyncToken: `candidate-view-token-${queryCount}`,
        };
      },
      execute: async () => ({
        status: "succeeded",
        value: {
          acknowledged: true,
          subscriptionGeneration: 17,
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
          subscriptionId: "subscription-candidate",
          subscriptionGeneration: 17,
          barrierSequence: 1,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectCandidateQualityGates({
      bridge,
      candidateInputId: "candidate-input-1",
      onView: (next) => views.push(next),
      onDiagnostic: () => undefined,
    });
    assert.equal(views.at(-1)?.authority, null);
    assert.equal(views.at(-1)?.criticalEscalation, null);
    await eventSink({
      subscriptionId: "subscription-candidate",
      subscriptionGeneration: 17,
      barrierSequence: 1,
      value: {
        kind: "event",
        event: {
          registryVersion: 17,
          schemaVersion: 1,
          sequence: 2,
          eventId: "event-candidate-2",
          type: "delivery.candidate-input.authorized",
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateInputId: "candidate-input-1",
          payload: {
            deliveryCandidateInputId: "candidate-input-1",
            authorityId: "candidate-authority-1",
          },
          timestamp: "2026-07-30T00:00:00.000Z",
        },
      },
    });
    assert.equal(queryCount, 2);
    assert.equal(views.at(-1)?.authority?.id, "candidate-authority-1");
    assert.equal(views.at(-1)?.criticalEscalation?.id, "critical-escalation-1");

    await connection.resync();
    assert.equal(queryCount, 3);
    await connection.close();
  });
});
