import { MODEL_ONLY_CONTEXT_SCHEMA_HASH } from "../execution/contract.js";
import type {
  AdapterExecutionFact,
  ExecutionAdapterCapabilities,
  ExecutionCompletion,
  ExecutionEventSink,
  ExecutionLeaseContext,
  InteractionExecutionRequest,
  ModelOnlyInteractionContext,
  ReconcileResult,
} from "../execution/contract.js";
export interface TrustedModelTransport {
  readonly complete: (input: {
    readonly model: string;
    readonly context: ModelOnlyInteractionContext;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly providerExecutionRef: string;
    readonly response: string;
    readonly usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    };
  }>;
}

export const createHttpModelTransport = (input: {
  readonly endpoint: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}): TrustedModelTransport => {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    complete: async ({ model, context, signal }) => {
      const response = await fetchImpl(input.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.credential}`,
        },
        body: JSON.stringify({ model, context }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Model transport returned HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as {
        readonly providerExecutionRef?: unknown;
        readonly response?: unknown;
        readonly usage?: {
          readonly inputTokens?: unknown;
          readonly outputTokens?: unknown;
          readonly totalTokens?: unknown;
        };
      };
      if (
        typeof payload.providerExecutionRef !== "string" ||
        typeof payload.response !== "string"
      ) {
        throw new Error("Model transport returned an invalid completion.");
      }
      const usage = payload.usage;
      return {
        providerExecutionRef: payload.providerExecutionRef,
        response: payload.response,
        ...(usage &&
        typeof usage.inputTokens === "number" &&
        typeof usage.outputTokens === "number" &&
        typeof usage.totalTokens === "number"
          ? {
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              },
            }
          : {}),
      };
    },
  };
};

export interface ModelOnlyInteractionExecutionAdapter {
  readonly capabilities: ExecutionAdapterCapabilities & {
    readonly enforceNoSideEffects: {
      readonly mechanism: "model-only";
      readonly mechanismVersion: string;
      readonly policySchemaHash: string;
    };
  };
  readonly execute: (
    request: InteractionExecutionRequest,
    sink: ExecutionEventSink,
    signal: AbortSignal,
  ) => Promise<ExecutionCompletion>;
  readonly cancel: (
    operationKey: string,
  ) => Promise<"cancelled" | "not-found" | "unknown">;
  readonly reconcile?: (
    input: {
      readonly operationKey: string;
      readonly reconciliationLease: ExecutionLeaseContext & {
        readonly leaseKind: "reconciliation";
      };
    },
    sink: ExecutionEventSink,
  ) => Promise<ReconcileResult>;
  readonly reattach?: (
    request: InteractionExecutionRequest,
    providerExecutionRef: string,
    sink: ExecutionEventSink,
    signal: AbortSignal,
  ) => Promise<ExecutionCompletion>;
}

const persistFact = async (
  sink: ExecutionEventSink,
  fact: AdapterExecutionFact,
) => {
  const receipt = await sink.record(fact);
  if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
    throw new Error(
      `Interaction Execution Fact ${fact.factId} was ${receipt.status}.`,
    );
  }
  return receipt;
};

export const createModelOnlyInteractionExecutionAdapter = (
  transport: TrustedModelTransport,
): ModelOnlyInteractionExecutionAdapter => {
  const active = new Map<string, AbortController>();
  return {
    capabilities: {
      reattachRunningOperation: false,
      strongExecutionFence: false,
      enforceNoSideEffects: {
        mechanism: "model-only",
        mechanismVersion: "1",
        policySchemaHash: MODEL_ONLY_CONTEXT_SCHEMA_HASH,
      },
    },
    execute: async (request, sink, signal) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      active.set(request.operationKey, controller);
      try {
        const result = await transport.complete({
          model: request.model,
          context: request.immutableContext,
          signal: controller.signal,
        });
        await persistFact(sink, {
          adapterSchemaVersion: 1,
          factId: "provider-started",
          ordinal: 1,
          kind: "provider-started",
          schemaVersion: 1,
          payload: { providerExecutionRef: result.providerExecutionRef },
          evidenceRefs: [],
        });
        await persistFact(sink, {
          adapterSchemaVersion: 1,
          factId: "message",
          ordinal: 2,
          kind: "message",
          schemaVersion: 1,
          payload: { content: result.response },
          evidenceRefs: [],
        });
        let ordinal = 3;
        if (result.usage) {
          await persistFact(sink, {
            adapterSchemaVersion: 1,
            factId: "usage",
            ordinal,
            kind: "usage",
            schemaVersion: 1,
            payload: result.usage,
            evidenceRefs: [],
          });
          ordinal += 1;
        }
        const terminal = await persistFact(sink, {
          adapterSchemaVersion: 1,
          factId: "completed",
          ordinal,
          kind: "completed",
          schemaVersion: 1,
          payload: {},
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: terminal.executionFactId,
          status: "succeeded",
          evidenceRefs: [],
        };
      } catch {
        const cancelled = controller.signal.aborted;
        const terminal = await persistFact(sink, {
          adapterSchemaVersion: 1,
          factId: cancelled ? "cancelled" : "failed",
          ordinal: 1,
          kind: cancelled ? "cancelled" : "failed",
          schemaVersion: 1,
          payload: cancelled
            ? { code: "MODEL_CANCELLED" }
            : { code: "MODEL_TRANSPORT_FAILED" },
          evidenceRefs: [],
        });
        return {
          operationKey: request.operationKey,
          terminalExecutionFactId: terminal.executionFactId,
          status: cancelled ? "cancelled" : "failed",
          evidenceRefs: [],
        };
      } finally {
        active.delete(request.operationKey);
        signal.removeEventListener("abort", abort);
      }
    },
    cancel: async (operationKey) => {
      const controller = active.get(operationKey);
      if (!controller) return "not-found";
      controller.abort();
      return "cancelled";
    },
    reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
    reattach: async () => {
      throw new Error(
        "Model transport does not support operation reattachment.",
      );
    },
  };
};
