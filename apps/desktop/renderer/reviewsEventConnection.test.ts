import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type {
  CandidateQualityGateView,
  DeliveryCandidateView,
  IntegrationGenerationView,
} from "../runtime/interface.js";
import { connectReviewsEventStream } from "./reviewsEventConnection.js";

describe("Reviews Runtime event connection", () => {
  it("uses one stage-aware stream and acknowledges each Runtime event sequence once", async () => {
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    let openCount = 0;
    const queries: string[] = [];
    const acknowledgements: unknown[] = [];
    const views: Array<{
      readonly generation: number;
      readonly integrationGenerations: readonly IntegrationGenerationView[];
      readonly candidateQuality: CandidateQualityGateView | null;
      readonly deliveryCandidate: DeliveryCandidateView | null;
    }> = [];
    const bridge = {
      query: async (query: { readonly type: string }) => {
        queries.push(query.type);
        if (query.type === "integration-generations.inspect") {
          return {
            view: [{ id: "generation-1", state: "passed" }],
            asOfSequence: 12,
            viewSyncToken: "integration-token-12",
          };
        }
        if (query.type === "quality-gates.inspect") {
          return {
            view: {
              candidateInput: { id: "candidate-input-1" },
              criticalEscalation: null,
              gateInputs: [],
              gateResults: [],
              authority: { id: "candidate-authority-1" },
            },
            asOfSequence: 12,
            viewSyncToken: "quality-token-12",
          };
        }
        return {
          view: {
            id: "candidate-1",
            manifestHash: "a".repeat(64),
            projection: "awaiting-decision",
            decision: null,
          },
          asOfSequence: 12,
          viewSyncToken: "delivery-token-12",
        };
      },
      execute: async (input: unknown) => {
        acknowledgements.push(input);
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: 7,
            barrierSequence: 12,
            auditId: `audit-${acknowledgements.length}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        openCount += 1;
        eventSink = sink;
        return {
          subscriptionId: "reviews-subscription-1",
          subscriptionGeneration: 7,
          barrierSequence: 12,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectReviewsEventStream({
      bridge,
      runId: "run-1",
      candidateInputId: "candidate-input-1",
      candidateId: "candidate-1",
      onViews: (view) => views.push(view),
      onDiagnostic: () => undefined,
    });

    assert.equal(openCount, 1);
    assert.equal(
      views.at(-1)?.candidateQuality?.authority?.id,
      "candidate-authority-1",
    );
    assert.equal(
      views.at(-1)?.deliveryCandidate?.projection,
      "awaiting-decision",
    );
    assert.deepEqual(
      (acknowledgements[0] as { readonly command: unknown }).command,
      {
        type: "ack-runtime-events",
        sequence: 12,
        viewSyncToken: "delivery-token-12",
      },
    );

    const frame = {
      subscriptionId: "reviews-subscription-1",
      subscriptionGeneration: 7,
      barrierSequence: 12,
      value: {
        kind: "event" as const,
        event: {
          registryVersion: 18,
          schemaVersion: 1 as const,
          sequence: 13,
          eventId: "candidate-event-13",
          type: "delivery.candidate.created",
          companyId: "company-1",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateInputId: "candidate-input-1",
          deliveryCandidateId: "candidate-1",
          payload: {},
          timestamp: "2026-08-03T00:00:00.000Z",
        },
      },
    } satisfies RuntimeEventFrame;
    await eventSink(frame);
    await eventSink(frame);

    assert.equal(
      queries.filter((type) => type === "delivery-candidates.inspect").length,
      2,
    );
    assert.equal(acknowledgements.length, 2);
    assert.deepEqual(
      (acknowledgements[1] as { readonly command: unknown }).command,
      {
        type: "ack-runtime-events",
        sequence: 13,
        subscriptionGeneration: 7,
      },
    );
    await connection.close();
  });

  it("fences callbacks from an old subscription generation after resync", async () => {
    const eventSinks: Array<
      (frame: RuntimeEventFrame) => void | Promise<void>
    > = [];
    const acknowledgements: unknown[] = [];
    let generation = 4;
    const bridge = {
      query: async (query: { readonly type: string }) => ({
        view:
          query.type === "integration-generations.inspect"
            ? []
            : query.type === "quality-gates.inspect"
              ? {
                  candidateInput: { id: "candidate-input-1" },
                  criticalEscalation: null,
                  gateInputs: [],
                  gateResults: [],
                  authority: null,
                }
              : {
                  id: "candidate-1",
                  manifestHash: "a".repeat(64),
                  projection: "awaiting-decision",
                  decision: null,
                },
        asOfSequence: 20,
        viewSyncToken: `view-token-${generation}`,
      }),
      execute: async (input: unknown) => {
        acknowledgements.push(input);
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: generation,
            barrierSequence: 20,
            auditId: `audit-${acknowledgements.length}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        eventSinks.push(sink);
        return {
          subscriptionId: `reviews-subscription-${generation}`,
          subscriptionGeneration: generation,
          barrierSequence: 20,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectReviewsEventStream({
      bridge,
      runId: "run-1",
      candidateInputId: "candidate-input-1",
      candidateId: "candidate-1",
      onViews: () => undefined,
      onDiagnostic: () => undefined,
    });
    generation = 5;
    await connection.resync();

    const staleFrame = {
      subscriptionId: "reviews-subscription-4",
      subscriptionGeneration: 4,
      barrierSequence: 20,
      value: {
        kind: "event" as const,
        event: {
          registryVersion: 18,
          schemaVersion: 1 as const,
          sequence: 21,
          eventId: "stale-event-21",
          type: "delivery.candidate.created",
          companyId: "company-1",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateInputId: "candidate-input-1",
          deliveryCandidateId: "candidate-1",
          payload: {},
          timestamp: "2026-08-03T00:00:00.000Z",
        },
      },
    } satisfies RuntimeEventFrame;
    await eventSinks[0]!(staleFrame);

    assert.equal(eventSinks.length, 2);
    assert.equal(acknowledgements.length, 2);
    await connection.close();
  });
});
