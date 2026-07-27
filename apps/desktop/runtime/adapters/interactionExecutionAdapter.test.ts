import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdapterExecutionFact,
  ExecutionEventSink,
  InteractionExecutionRequest,
} from "../execution/contract.js";
import {
  createModelOnlyInteractionExecutionAdapter,
  type TrustedModelTransport,
} from "./interactionExecutionAdapter.js";

const request = (): InteractionExecutionRequest => ({
  operationKey: "interaction-turn:turn-1",
  target: { kind: "interaction-turn", id: "turn-1" },
  lease: {
    leaseId: "lease-1",
    leaseKind: "execution",
    operationKey: "interaction-turn:turn-1",
    target: { kind: "interaction-turn", id: "turn-1" },
    executionEpoch: 1,
    fenceToken: "fence-1",
  },
  agentAdapterId: "model-only:test",
  model: "test-model",
  permissionScope: "none",
  sideEffectPolicy: "none",
  completionSignal: "execution-fact",
  timeoutSeconds: 60,
  immutableContext: {
    schemaVersion: 1,
    schemaHash: "a".repeat(64),
    contextHash: "b".repeat(64),
    mechanism: "model-only",
    mechanismVersion: "1",
    session: { id: "session-1", mode: "consultation" },
    project: {
      id: "project-1",
      name: "Checkout",
      goal: "Ship checkout",
      sharedContext: "Preserve payments.",
    },
    aiMember: {
      id: "member-1",
      displayName: "Ada",
      profile: "Careful planner.",
    },
    position: {
      id: "position-1",
      name: "Product manager",
      responsibility: "Clarify product goals.",
    },
    history: [{ role: "user", content: "What is the main risk?" }],
    prompt: "How should we reduce it?",
  },
});

describe("Model-only Interaction Execution Adapter", () => {
  it("passes only redacted model context to trusted transport and returns its terminal Fact receipt", async () => {
    let received: Parameters<TrustedModelTransport["complete"]>[0] | undefined;
    const submitted: AdapterExecutionFact[] = [];
    const transport: TrustedModelTransport = {
      complete: async (input) => {
        received = input;
        return {
          providerExecutionRef: "provider-turn-1",
          response: "Use a smaller first release.",
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
        };
      },
    };
    const sink: ExecutionEventSink = {
      record: async (fact) => {
        submitted.push(fact);
        return {
          status: "accepted",
          executionFactId: `persisted:${fact.factId}`,
          effectIds: [],
          canonicalPayloadHash: "c".repeat(64),
        };
      },
    };

    const adapter = createModelOnlyInteractionExecutionAdapter(transport);
    const completion = await adapter.execute(
      request(),
      sink,
      new AbortController().signal,
    );

    assert.equal(
      adapter.capabilities.enforceNoSideEffects?.mechanism,
      "model-only",
    );
    assert.equal(received?.model, "test-model");
    assert.equal(received?.context.prompt, "How should we reduce it?");
    assert.equal("cwd" in (received ?? {}), false);
    assert.equal("sandbox" in (received ?? {}), false);
    assert.equal("worktree" in (received ?? {}), false);
    assert.equal("toolRegistry" in (received ?? {}), false);
    assert.deepEqual(
      submitted.map((fact) => fact.kind),
      ["provider-started", "message", "usage", "completed"],
    );
    assert.deepEqual(completion, {
      operationKey: "interaction-turn:turn-1",
      terminalExecutionFactId: "persisted:completed",
      status: "succeeded",
      evidenceRefs: [],
    });
  });

  it("turns transport cancellation into a terminal cancelled Fact", async () => {
    const submitted: AdapterExecutionFact[] = [];
    const adapter = createModelOnlyInteractionExecutionAdapter({
      complete: ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const completion = adapter.execute(
      request(),
      {
        record: async (fact) => {
          submitted.push(fact);
          return {
            status: "accepted",
            executionFactId: `persisted:${fact.factId}`,
            effectIds: [],
            canonicalPayloadHash: "c".repeat(64),
          };
        },
      },
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await adapter.cancel(request().operationKey), "cancelled");
    const result = await completion;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(
      submitted.map((fact) => fact.kind),
      ["cancelled"],
    );
  });
});
