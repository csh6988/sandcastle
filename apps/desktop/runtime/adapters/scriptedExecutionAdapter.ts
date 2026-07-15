import type { RunSnapshotPayload } from "../interface.js";

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

export interface ExecutionAdapterInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly signal: AbortSignal;
  readonly node: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number];
  readonly snapshot: RunSnapshotPayload;
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
}

export interface ExecutionAdapter {
  readonly maxConcurrentNodes?: number;
  readonly execute: (input: ExecutionAdapterInput) => Promise<ExecutionFact>;
}

export interface ScriptedExecutionAdapterOptions {
  readonly script?: Readonly<Record<string, readonly ExecutionFact[]>>;
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
  const defaultFact: ExecutionFact = options.defaultFact ?? {
    kind: "succeeded",
  };

  return {
    execute: async (input) => {
      options.onExecute?.(input);
      return script.get(input.node.id)?.shift() ?? defaultFact;
    },
  };
};
