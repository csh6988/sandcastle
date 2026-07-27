import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdapterExecutionFact,
  ExecutionEventSink,
} from "../execution/contract.js";
import { createScriptedExecutionAdapter } from "./scriptedExecutionAdapter.js";

const facts: readonly AdapterExecutionFact[] = [
  {
    adapterSchemaVersion: 1,
    factId: "started",
    ordinal: 1,
    kind: "provider-started",
    schemaVersion: 1,
    payload: { providerExecutionRef: "scripted:project-spec" },
    evidenceRefs: ["provider-receipt"],
  },
  {
    adapterSchemaVersion: 1,
    factId: "completed",
    ordinal: 2,
    kind: "completed",
    schemaVersion: 1,
    payload: { structuredResult: { summary: "Prepared." } },
    evidenceRefs: ["provider-receipt"],
  },
];

describe("Scripted Execution Adapter", () => {
  it("submits only Adapter Execution Facts and returns the persisted terminal receipt", async () => {
    const submitted: AdapterExecutionFact[] = [];
    const sink: ExecutionEventSink = {
      record: async (fact) => {
        submitted.push(fact);
        return {
          status: "accepted",
          executionFactId: `persisted:${fact.factId}`,
          effectIds: [],
          canonicalPayloadHash: "a".repeat(64),
        };
      },
    };
    const adapter = createScriptedExecutionAdapter({
      facts: { "project-spec": facts },
    });
    const signal = new AbortController().signal;
    const completion = await adapter.execute(
      {
        runId: "run-1",
        nodeRunId: "node-run-1",
        signal,
        node: {
          id: "project-spec",
          type: "ai-task",
          name: "Project Spec",
          handlerKindId: "project-spec@1",
          positionId: "product-manager",
        },
        snapshot: {} as never,
        request: {
          operationKey: "node-attempt:attempt-1",
          target: { kind: "node-attempt", id: "attempt-1" },
          lease: {
            leaseId: "lease-1",
            leaseKind: "execution",
            operationKey: "node-attempt:attempt-1",
            target: { kind: "node-attempt", id: "attempt-1" },
            executionEpoch: 1,
            fenceToken: "fence-1",
          },
          agentAdapterId: "scripted",
          permissionScope: "deny",
          sideEffectPolicy: "formal",
          completionSignal: "execution-fact",
          timeoutSeconds: 60,
          immutableContext: {
            runId: "run-1",
            nodeRunId: "node-run-1",
            nodeAttemptId: "attempt-1",
            snapshotRevisionId: "snapshot-1",
            handlerKindId: "project-spec@1",
          },
        },
        attempt: {
          id: "attempt-1",
          attemptNumber: 1,
          snapshotRevisionId: "snapshot-1",
          reason: "initial",
          feedback: [],
          previousResult: null,
          previousFailure: null,
        },
      },
      sink,
      signal,
    );

    assert.deepEqual(submitted, facts);
    assert.deepEqual(completion, {
      operationKey: "node-attempt:attempt-1",
      terminalExecutionFactId: "persisted:completed",
      status: "succeeded",
      evidenceRefs: ["provider-receipt"],
    });
  });
});
