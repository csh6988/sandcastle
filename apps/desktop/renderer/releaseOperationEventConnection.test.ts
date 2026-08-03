import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventFrame } from "../preload/bridge.js";
import { connectReleaseOperationEventStream } from "./releaseOperationEventConnection.js";

const frame = (generation: number, sequence: number): RuntimeEventFrame =>
  ({
    subscriptionId: "release-subscription",
    subscriptionGeneration: generation,
    barrierSequence: 10,
    value: {
      kind: "event",
      event: {
        registryVersion: 19,
        schemaVersion: 1,
        sequence,
        eventId: `release-event-${sequence}`,
        type: "delivery.release-operation.created",
        companyId: "company-1",
        projectId: "project-1",
        runId: "run-1",
        deliveryCandidateId: "candidate-1",
        releaseOperationId: "operation-1",
        payload: {},
        timestamp: "2026-08-03T00:00:00.000Z",
      },
    },
  }) as RuntimeEventFrame;

describe("Release operation Runtime event connection", () => {
  it("applies Query views, acknowledges their barrier, replays the open generation, drops stale frames, and reloads the same authority", async () => {
    const steps: string[] = [];
    const snapshots: Array<{
      readonly authority: { readonly authorityHash: string } | null;
      readonly operations: readonly unknown[];
    }> = [];
    let queryCount = 0;
    let sink!: (value: RuntimeEventFrame) => void | Promise<void>;
    const bridge = {
      query: async (query: { readonly type: string }) => {
        steps.push(`query:${query.type}`);
        queryCount += 1;
        if (query.type === "delivery-candidates.inspect") {
          return {
            view: {
              id: "candidate-1",
              projection: "accepted",
              manifestHash: "a".repeat(64),
            },
            asOfSequence: queryCount < 4 ? 10 : 20,
            viewSyncToken:
              queryCount < 4 ? "candidate-token-10" : "candidate-token-20",
          };
        }
        if (query.type === "accepted-delivery-authority.inspect") {
          return {
            view: {
              candidateId: "candidate-1",
              authorityHash: (queryCount < 4 ? "b" : "c").repeat(64),
            },
            asOfSequence: queryCount < 4 ? 11 : 21,
            viewSyncToken:
              queryCount < 4 ? "authority-token-11" : "authority-token-21",
          };
        }
        return {
          view: [
            {
              id: "operation-1",
              aggregateState: queryCount < 7 ? "pending" : "succeeded",
            },
          ],
          asOfSequence: queryCount < 4 ? 12 : 22,
          viewSyncToken:
            queryCount < 4 ? "operation-token-12" : "operation-token-22",
        };
      },
      execute: async (input: {
        readonly command: {
          readonly sequence: number;
          readonly viewSyncToken?: string;
        };
      }) => {
        steps.push(
          input.command.viewSyncToken
            ? `ack-view:${input.command.sequence}`
            : `ack-event:${input.command.sequence}`,
        );
        return {
          status: "succeeded" as const,
          value: {
            acknowledged: true,
            subscriptionGeneration: input.command.viewSyncToken ? 6 : 7,
            barrierSequence: input.command.sequence,
            auditId: "audit-1",
          },
          effectIds: [],
        };
      },
      openEventStream: async (
        nextSink: (value: RuntimeEventFrame) => void | Promise<void>,
      ) => {
        steps.push("open");
        sink = nextSink;
        await nextSink(frame(7, 11));
        return {
          subscriptionId: "release-subscription",
          subscriptionGeneration: 7,
          barrierSequence: 10,
        };
      },
      closeEventStream: async () => undefined,
    } as unknown as Parameters<
      typeof connectReleaseOperationEventStream
    >[0]["bridge"];

    const connection = await connectReleaseOperationEventStream({
      bridge,
      candidateId: "candidate-1",
      onInitialViews: (view) => snapshots.push(view),
      onViews: (view) => snapshots.push(view),
      onDiagnostic: () => undefined,
    });

    assert.deepEqual(steps.slice(0, 5), [
      "query:delivery-candidates.inspect",
      "query:accepted-delivery-authority.inspect",
      "query:release-operations.list",
      "ack-view:10",
      "open",
    ]);
    assert.equal(snapshots.at(-1)?.operations.length, 1);
    const queriesAfterReplay = queryCount;
    await sink(frame(7, 11));
    assert.equal(queryCount, queriesAfterReplay);
    await sink(frame(6, 12));
    assert.equal(queryCount, queriesAfterReplay);
    await connection.resync();
    assert.equal(snapshots.at(-1)?.authority?.authorityHash, "c".repeat(64));
    assert.match(steps.join(" "), /ack-view:20/);
    await connection.close();
  });
});
