import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type {
  CandidateQualityGateView,
  DeliveryCandidateView,
  IntegrationGenerationView,
} from "../runtime/interface.js";
import { connectReviewsEventStream } from "./reviewsEventConnection.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe("Reviews Runtime event connection", () => {
  it("applies all stage Queries atomically and replays every event after the earliest View token", async () => {
    let eventSink!: (frame: RuntimeEventFrame) => void | Promise<void>;
    let openCount = 0;
    const queries: string[] = [];
    const acknowledgements: unknown[] = [];
    const steps: string[] = [];
    let integrationQueryCount = 0;
    let deliveryQueryCount = 0;
    const initialViews: Array<{
      readonly integrationGenerations: readonly IntegrationGenerationView[];
      readonly candidateQuality: CandidateQualityGateView | null;
      readonly deliveryCandidate: DeliveryCandidateView | null;
    }> = [];
    const views: Array<{
      readonly generation: number;
      readonly integrationGenerations: readonly IntegrationGenerationView[];
      readonly candidateQuality: CandidateQualityGateView | null;
      readonly deliveryCandidate: DeliveryCandidateView | null;
    }> = [];
    const frame = (
      sequence: number,
      type: "integration.generation.completed" | "delivery.candidate.created",
    ) =>
      ({
        subscriptionId: "reviews-subscription-1",
        subscriptionGeneration: 7,
        barrierSequence: 10,
        value: {
          kind: "event" as const,
          event: {
            registryVersion: 18,
            schemaVersion: 1 as const,
            sequence,
            eventId: `reviews-event-${sequence}`,
            type,
            companyId: "company-1",
            projectId: "project-1",
            runId: "run-1",
            ...(type === "delivery.candidate.created"
              ? {
                  deliveryCandidateInputId: "candidate-input-1",
                  deliveryCandidateId: "candidate-1",
                }
              : {}),
            payload: {},
            timestamp: "2026-08-03T00:00:00.000Z",
          },
        },
      }) satisfies RuntimeEventFrame;
    const bridge = {
      query: async (query: { readonly type: string }) => {
        queries.push(query.type);
        steps.push(`query:${query.type}`);
        if (query.type === "integration-generations.inspect") {
          integrationQueryCount += 1;
          return {
            view: [
              {
                id: "generation-1",
                state: integrationQueryCount === 1 ? "running" : "passed",
              },
            ],
            asOfSequence: integrationQueryCount === 1 ? 10 : 12,
            viewSyncToken:
              integrationQueryCount === 1
                ? "integration-token-10"
                : "integration-token-12",
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
            asOfSequence: 11,
            viewSyncToken: "quality-token-11",
          };
        }
        deliveryQueryCount += 1;
        return {
          view: {
            id: "candidate-1",
            manifestHash: (deliveryQueryCount === 1 ? "a" : "b").repeat(64),
            projection:
              deliveryQueryCount === 1 ? "assembling" : "awaiting-decision",
            decision: null,
          },
          asOfSequence: deliveryQueryCount === 1 ? 11 : 12,
          viewSyncToken:
            deliveryQueryCount === 1
              ? "delivery-token-11"
              : "delivery-token-12",
        };
      },
      execute: async (input: unknown) => {
        acknowledgements.push(input);
        const command = (
          input as { readonly command: { readonly sequence: number } }
        ).command;
        steps.push(
          "viewSyncToken" in command
            ? `ack-view:${command.sequence}`
            : `ack-event:${command.sequence}`,
        );
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: "viewSyncToken" in command ? 6 : 7,
            barrierSequence: command.sequence,
            auditId: `audit-${acknowledgements.length}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        openCount += 1;
        steps.push("open");
        eventSink = sink;
        await sink(frame(11, "integration.generation.completed"));
        await sink(frame(12, "delivery.candidate.created"));
        return {
          subscriptionId: "reviews-subscription-1",
          subscriptionGeneration: 7,
          barrierSequence: 10,
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
      onInitialViews: (view) => {
        steps.push("apply");
        initialViews.push(view);
      },
      onViews: (view) => views.push(view),
      onDiagnostic: () => undefined,
    });

    assert.equal(openCount, 1);
    assert.equal(initialViews[0]?.integrationGenerations[0]?.state, "running");
    assert.equal(
      initialViews[0]?.candidateQuality?.authority?.id,
      "candidate-authority-1",
    );
    assert.equal(initialViews[0]?.deliveryCandidate?.projection, "assembling");
    assert.deepEqual(
      (acknowledgements[0] as { readonly command: unknown }).command,
      {
        type: "ack-runtime-events",
        sequence: 10,
        viewSyncToken: "integration-token-10",
      },
    );
    assert.equal(views.at(-1)?.integrationGenerations[0]?.state, "passed");
    assert.equal(views.at(-1)?.deliveryCandidate?.manifestHash, "b".repeat(64));
    assert.equal(
      views.at(-1)?.deliveryCandidate?.projection,
      "awaiting-decision",
    );
    assert.deepEqual(steps.slice(0, 6), [
      "query:integration-generations.inspect",
      "query:quality-gates.inspect",
      "query:delivery-candidates.inspect",
      "apply",
      "ack-view:10",
      "open",
    ]);
    assert.deepEqual(
      acknowledgements
        .slice(1)
        .map(
          (entry) =>
            (entry as { readonly command: { readonly sequence: number } })
              .command.sequence,
        ),
      [11, 12],
    );
    await eventSink(frame(12, "delivery.candidate.created"));
    assert.equal(
      queries.filter((type) => type === "delivery-candidates.inspect").length,
      2,
    );
    assert.equal(acknowledgements.length, 3);
    await connection.close();
  });

  it("fences callbacks from an old subscription generation after resync", async () => {
    const eventSinks: Array<
      (frame: RuntimeEventFrame) => void | Promise<void>
    > = [];
    const acknowledgements: unknown[] = [];
    const steps: string[] = [];
    let generation = 4;
    const bridge = {
      query: async (query: { readonly type: string }) => {
        steps.push(`query:${query.type}:${generation}`);
        return {
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
        };
      },
      execute: async (input: unknown) => {
        acknowledgements.push(input);
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: generation - 1,
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
      closeEventStream: async (handle: {
        readonly subscriptionGeneration: number;
      }) => {
        steps.push(`close:${handle.subscriptionGeneration}`);
      },
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectReviewsEventStream({
      bridge,
      runId: "run-1",
      candidateInputId: "candidate-input-1",
      candidateId: "candidate-1",
      onInitialViews: () => undefined,
      onViews: () => undefined,
      onDiagnostic: () => undefined,
    });
    steps.length = 0;
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
    assert.equal(steps[0], "close:4");
    assert.equal(
      steps.slice(1, 4).every((step) => step.endsWith(":5")),
      true,
    );
    await connection.close();
  });

  it("serializes overlapping resync calls and closes each old stream before replacement Queries", async () => {
    const firstResyncQueriesStarted = deferred();
    const releaseFirstResyncQueries = deferred();
    const steps: string[] = [];
    const activeHandles = new Set<number>();
    let maximumActiveHandles = 0;
    let queryCount = 0;
    let acknowledgementCount = 0;
    let openCount = 0;
    const bridge = {
      query: async (query: { readonly type: string }) => {
        const batch = Math.floor(queryCount / 3);
        queryCount += 1;
        steps.push(`query:${batch}:${query.type}`);
        if (batch === 1) {
          firstResyncQueriesStarted.resolve();
          await releaseFirstResyncQueries.promise;
        }
        return {
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
          viewSyncToken: `view-token-${batch}`,
        };
      },
      execute: async () => {
        acknowledgementCount += 1;
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: acknowledgementCount,
            barrierSequence: 20,
            auditId: `audit-${acknowledgementCount}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async () => {
        openCount += 1;
        const generation = openCount + 1;
        activeHandles.add(generation);
        maximumActiveHandles = Math.max(
          maximumActiveHandles,
          activeHandles.size,
        );
        steps.push(`open:${generation}`);
        return {
          subscriptionId: `subscription-${generation}`,
          subscriptionGeneration: generation,
          barrierSequence: 20,
        };
      },
      closeEventStream: async (handle: {
        readonly subscriptionGeneration: number;
      }) => {
        steps.push(`close:${handle.subscriptionGeneration}`);
        activeHandles.delete(handle.subscriptionGeneration);
      },
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectReviewsEventStream({
      bridge,
      runId: "run-1",
      candidateInputId: "candidate-input-1",
      candidateId: "candidate-1",
      onInitialViews: () => undefined,
      onViews: () => undefined,
      onDiagnostic: () => undefined,
    });
    steps.length = 0;

    const firstResync = connection.resync();
    await firstResyncQueriesStarted.promise;
    const secondResync = connection.resync();
    await new Promise((resolve) => setImmediate(resolve));
    const queryCountWhileFirstBlocked = queryCount;
    releaseFirstResyncQueries.resolve();
    await Promise.all([firstResync, secondResync]);

    assert.equal(queryCountWhileFirstBlocked, 6);
    assert.equal(maximumActiveHandles, 1);
    assert.deepEqual([...activeHandles], [4]);
    assert.ok(
      steps.indexOf("close:2") <
        steps.indexOf("query:1:integration-generations.inspect"),
    );
    assert.ok(
      steps.indexOf("close:3") <
        steps.indexOf("query:2:integration-generations.inspect"),
    );

    await connection.close();
    assert.equal(activeHandles.size, 0);
  });

  it("replays buffered frames before a queued resync replaces the stream", async () => {
    const firstReplacementOpenBlocked = deferred();
    const releaseFirstReplacementOpen = deferred();
    const activeHandles = new Set<number>();
    const acknowledgedEventSequences: number[] = [];
    const initialManifestHashes: string[] = [];
    const eventViews: Array<{
      readonly generation: number;
      readonly manifestHash: string | undefined;
    }> = [];
    let maximumActiveHandles = 0;
    let synchronizationBatch = -1;
    let viewAcknowledgementCount = 0;
    let openCount = 0;
    const frame = (
      sequence: number,
      subscriptionGeneration: number,
      barrierSequence: number,
    ) =>
      ({
        subscriptionId: `subscription-${subscriptionGeneration}`,
        subscriptionGeneration,
        barrierSequence,
        value: {
          kind: "event" as const,
          event: {
            registryVersion: 18,
            schemaVersion: 1 as const,
            sequence,
            eventId: `event-${sequence}`,
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
      }) satisfies RuntimeEventFrame;
    const bridge = {
      query: async (query: { readonly type: string }) => {
        const activeGeneration = [...activeHandles][0];
        if (
          activeGeneration === undefined &&
          query.type === "integration-generations.inspect"
        ) {
          synchronizationBatch += 1;
        }
        const manifestHash = (
          activeGeneration === 3
            ? "d"
            : activeGeneration === 4
              ? "e"
              : ["a", "b", "c"][synchronizationBatch]
        )!.repeat(64);
        return {
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
                    manifestHash,
                    projection: "awaiting-decision",
                    decision: null,
                  },
          asOfSequence: synchronizationBatch === 2 ? 21 : 20,
          viewSyncToken: `view-token-${synchronizationBatch}`,
        };
      },
      execute: async (input: unknown) => {
        const command = (
          input as {
            readonly command: {
              readonly sequence: number;
              readonly subscriptionGeneration?: number;
              readonly viewSyncToken?: string;
            };
          }
        ).command;
        if (command.viewSyncToken) {
          viewAcknowledgementCount += 1;
          return {
            status: "succeeded",
            value: {
              acknowledged: true,
              subscriptionGeneration: viewAcknowledgementCount,
              barrierSequence: command.sequence,
              auditId: `view-audit-${viewAcknowledgementCount}`,
            },
            effectIds: [],
          };
        }
        acknowledgedEventSequences.push(command.sequence);
        return {
          status: "succeeded",
          value: {
            acknowledged: true,
            subscriptionGeneration: command.subscriptionGeneration,
            barrierSequence: command.sequence,
            auditId: `event-audit-${command.sequence}`,
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        sink: (frame: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        openCount += 1;
        const openedGeneration = openCount + 1;
        activeHandles.add(openedGeneration);
        maximumActiveHandles = Math.max(
          maximumActiveHandles,
          activeHandles.size,
        );
        if (openedGeneration === 3) {
          await sink(frame(21, 3, 20));
          firstReplacementOpenBlocked.resolve();
          await releaseFirstReplacementOpen.promise;
        }
        if (openedGeneration === 4) {
          await sink(frame(22, 4, 21));
        }
        return {
          subscriptionId: `subscription-${openedGeneration}`,
          subscriptionGeneration: openedGeneration,
          barrierSequence: openedGeneration === 4 ? 21 : 20,
        };
      },
      closeEventStream: async (handle: {
        readonly subscriptionGeneration: number;
      }) => {
        activeHandles.delete(handle.subscriptionGeneration);
      },
    } as unknown as Pick<
      SandcastleBridge,
      "query" | "execute" | "openEventStream" | "closeEventStream"
    >;

    const connection = await connectReviewsEventStream({
      bridge,
      runId: "run-1",
      candidateInputId: "candidate-input-1",
      candidateId: "candidate-1",
      onInitialViews: (views) => {
        initialManifestHashes.push(views.deliveryCandidate!.manifestHash);
      },
      onViews: (views) => {
        eventViews.push({
          generation: views.generation,
          manifestHash: views.deliveryCandidate?.manifestHash,
        });
      },
      onDiagnostic: () => undefined,
    });

    const firstResync = connection.resync();
    await firstReplacementOpenBlocked.promise;
    const secondResync = connection.resync();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(synchronizationBatch, 1);
    assert.equal(openCount, 2);
    assert.deepEqual(acknowledgedEventSequences, []);

    releaseFirstReplacementOpen.resolve();
    await Promise.all([firstResync, secondResync]);

    assert.equal(maximumActiveHandles, 1);
    assert.deepEqual([...activeHandles], [4]);
    assert.deepEqual(acknowledgedEventSequences, [21, 22]);
    assert.deepEqual(initialManifestHashes, [
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]);
    assert.deepEqual(eventViews, [
      { generation: 3, manifestHash: "d".repeat(64) },
      { generation: 4, manifestHash: "e".repeat(64) },
    ]);

    await connection.close();
    assert.equal(activeHandles.size, 0);
  });
});
