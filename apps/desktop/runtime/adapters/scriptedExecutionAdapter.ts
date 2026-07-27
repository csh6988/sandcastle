import type { RunSnapshotPayload } from "../interface.js";
import type {
  AdapterExecutionFact,
  ExecutionAdapterCapabilities,
  ExecutionCompletion,
  ExecutionEventSink,
  ExecutionLeaseContext,
  ExecutionRequest,
  ReconcileResult,
} from "../execution/contract.js";

export type ExecutionFact =
  | {
      readonly kind: "succeeded";
      readonly structuredResult?: unknown;
      readonly artifacts?: readonly {
        readonly type: string;
        readonly schemaVersion: string;
        readonly logicalName: string;
        readonly content: string;
        readonly status?: "draft" | "produced";
        readonly inputVersionIds?: readonly string[];
      }[];
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface ExecutionMemoryEntry {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly scope: "project" | "ai-member";
  readonly ownerId: string;
  readonly content: string;
  readonly redactionPolicy: {
    readonly version: string;
    readonly hash: string;
  };
}

export interface ExecutionAdapterInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly signal: AbortSignal;
  readonly node: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number];
  readonly snapshot: RunSnapshotPayload;
  readonly memoryEntries: readonly ExecutionMemoryEntry[];
  readonly attempt: {
    readonly id: string;
    readonly attemptNumber: number;
    readonly snapshotRevisionId: string;
    readonly reason: "initial" | "request-changes" | "retry" | "recovery";
    readonly feedback: readonly {
      readonly id: string;
      readonly kind: "request-changes" | "retry";
      readonly content: string;
    }[];
    readonly previousResult: unknown;
    readonly previousFailure: {
      readonly code: string;
      readonly message: string;
    } | null;
  };
  readonly request?: ExecutionRequest;
}

export type LegacyExecutionFact = ExecutionFact;

export interface ExecutionAdapter {
  readonly maxConcurrentNodes?: number;
  readonly capabilities?: ExecutionAdapterCapabilities;
  readonly execute: (
    input: ExecutionAdapterInput,
    sink?: ExecutionEventSink,
    signal?: AbortSignal,
  ) => Promise<ExecutionCompletion | ExecutionFact>;
  readonly cancel?: (
    operationKey: string,
  ) => Promise<"cancelled" | "not-found" | "unknown">;
  readonly fence?: (
    operationKey: string,
  ) => Promise<
    | { readonly status: "fenced"; readonly evidenceRef: string }
    | { readonly status: "unsupported" | "unknown" }
  >;
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
    input: ExecutionAdapterInput,
    providerExecutionRef: string,
    sink: ExecutionEventSink,
    signal: AbortSignal,
  ) => Promise<ExecutionCompletion>;
}

export interface ScriptedExecutionAdapterOptions {
  readonly script?: Readonly<Record<string, readonly ExecutionFact[]>>;
  readonly facts?: Readonly<Record<string, readonly AdapterExecutionFact[]>>;
  readonly defaultFact?: ExecutionFact;
  readonly onExecute?: (input: ExecutionAdapterInput) => void;
}

export const createScriptedExecutionAdapter = (
  options: ScriptedExecutionAdapterOptions = {},
): ExecutionAdapter => {
  const script = new Map(
    Object.entries(options.script ?? {}).map(([nodeId, facts]) => [
      nodeId,
      [...facts],
    ]),
  );
  const factScript = new Map(
    Object.entries(options.facts ?? {}).map(([nodeId, facts]) => [
      nodeId,
      [...facts],
    ]),
  );
  const defaultFact: ExecutionFact = options.defaultFact ?? {
    kind: "succeeded",
  };

  return {
    capabilities: {
      reattachRunningOperation: false,
      strongExecutionFence: true,
      enforceNoSideEffects: false,
    },
    execute: async (input, sink) => {
      options.onExecute?.(input);
      const facts = factScript.get(input.node.id);
      if (facts && input.request) {
        if (!input.request || !input.request.operationKey) {
          throw new Error("Scripted execution requires a Runtime request.");
        }
        let terminal:
          | { readonly fact: AdapterExecutionFact; readonly receiptId: string }
          | undefined;
        for (const fact of facts) {
          const receipt = await sink?.record(fact);
          if (!receipt) {
            throw new Error("Scripted execution requires a Runtime fact sink.");
          }
          if (receipt.status === "accepted" || receipt.status === "duplicate") {
            if (
              fact.kind === "completed" ||
              fact.kind === "failed" ||
              fact.kind === "cancelled"
            ) {
              terminal = {
                fact,
                receiptId: receipt.executionFactId,
              };
            }
          }
        }
        if (!terminal) {
          throw new Error(
            "Scripted execution did not produce an accepted terminal Execution Fact.",
          );
        }
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: terminal.receiptId,
          status:
            terminal.fact.kind === "completed"
              ? "succeeded"
              : terminal.fact.kind === "failed"
                ? "failed"
                : "cancelled",
          evidenceRefs: terminal.fact.evidenceRefs,
        } satisfies ExecutionCompletion;
      }
      return script.get(input.node.id)?.shift() ?? defaultFact;
    },
    cancel: async () => "not-found",
    fence: async () => ({ status: "fenced", evidenceRef: "scripted-fence" }),
    reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
    reattach: async () => {
      throw new Error(
        "Scripted execution has no running operation to reattach.",
      );
    },
  };
};
