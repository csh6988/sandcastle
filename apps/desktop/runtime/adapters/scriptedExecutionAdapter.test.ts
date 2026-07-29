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
  it("derives a terminal legacy fact from a trusted per-execution test hook", async () => {
    const adapter = createScriptedExecutionAdapter({
      onExecute: () => ({
        kind: "succeeded" as const,
        structuredResult: { commits: [{ sha: "a".repeat(40) }] },
      }),
    });

    assert.deepEqual(
      await adapter.execute({ node: { id: "development" } } as never),
      {
        kind: "succeeded",
        structuredResult: { commits: [{ sha: "a".repeat(40) }] },
      },
    );
  });

  it("allows a trusted per-execution hook to persist a dynamic terminal fact", async () => {
    const submitted: AdapterExecutionFact[] = [];
    const sink: ExecutionEventSink = {
      record: async (fact) => {
        submitted.push(fact);
        return {
          status: "accepted",
          executionFactId: `persisted:${fact.factId}`,
          effectIds: ["source-import-1"],
          canonicalPayloadHash: "b".repeat(64),
        };
      },
    };
    const adapter = createScriptedExecutionAdapter({
      onExecute: async (input, eventSink) => {
        assert.ok(eventSink);
        assert.ok(input.request);
        const fact: AdapterExecutionFact = {
          adapterSchemaVersion: 1,
          factId: `${input.request.operationKey}:completed`,
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: { structuredResult: { commits: [{ sha: "c".repeat(40) }] } },
          evidenceRefs: ["fixture:private-branch-tip"],
        };
        const receipt = await eventSink.record(fact);
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded" as const,
          evidenceRefs: fact.evidenceRefs,
        };
      },
    });
    const request = {
      operationKey: "node-attempt:dynamic-1",
    };

    const completion = await adapter.execute(
      { node: { id: "development" }, request } as never,
      sink,
    );

    assert.equal(submitted.length, 1);
    assert.deepEqual(completion, {
      operationKey: request.operationKey,
      terminalExecutionFactId: `${request.operationKey}:completed`.replace(
        /^/,
        "persisted:",
      ),
      status: "succeeded",
      evidenceRefs: ["fixture:private-branch-tip"],
    });
  });

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
        memoryEntries: [],
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
