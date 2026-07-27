import type { DatabaseSync } from "node:sqlite";

export const MODEL_ONLY_CONTEXT_SCHEMA_HASH =
  "4413c19036e14de9de5d1a7ecb492671b62d18bec760ad2c78f535954dab5c0a";

export type ExecutionTarget =
  | {
      readonly kind: "node-attempt";
      readonly id: string;
    }
  | {
      readonly kind: "interaction-turn";
      readonly id: string;
    };

export type ExecutionLeaseKind = "execution" | "reconciliation";

export interface ExecutionLeaseContext {
  readonly leaseId: string;
  readonly leaseKind: ExecutionLeaseKind;
  readonly operationKey: string;
  readonly target: ExecutionTarget;
  readonly executionEpoch: number;
  readonly fenceToken: string;
}

export type AdapterExecutionFactKind =
  | "provider-started"
  | "agent-session"
  | "message"
  | "tool-call"
  | "tool-result"
  | "permission-request"
  | "checkpoint"
  | "artifact"
  | "commit"
  | "usage"
  | "not-started"
  | "completed"
  | "failed"
  | "cancelled";

export interface AdapterExecutionFact {
  readonly adapterSchemaVersion: number;
  readonly factId: string;
  readonly ordinal: number;
  readonly kind: AdapterExecutionFactKind;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly evidenceRefs: readonly string[];
}

export interface ExecutionFactEnvelope extends AdapterExecutionFact {
  readonly id: string;
  readonly operationKey: string;
  readonly target: ExecutionTarget;
  readonly leaseId: string;
  readonly leaseKind: ExecutionLeaseKind;
  readonly executionEpoch: number;
  readonly fenceToken: string;
  readonly canonicalPayloadHash: string;
  readonly status: "accepted" | "duplicate" | "stale" | "conflict";
  readonly effectIds: readonly string[];
  readonly createdAt: string;
}

export interface ExecutionFactReceipt {
  readonly status: "accepted" | "duplicate" | "stale" | "conflict";
  readonly executionFactId: string;
  readonly effectIds: readonly string[];
  readonly canonicalPayloadHash: string;
}

export interface ExecutionEventSink {
  readonly record: (
    fact: AdapterExecutionFact,
  ) => Promise<ExecutionFactReceipt>;
}

interface ExecutionRequestBase {
  readonly operationKey: string;
  readonly target: ExecutionTarget;
  readonly lease: ExecutionLeaseContext;
  readonly agentAdapterId: string;
  readonly completionSignal: "execution-fact";
  readonly timeoutSeconds: number;
}

export interface FormalExecutionRequest extends ExecutionRequestBase {
  readonly target: Extract<ExecutionTarget, { readonly kind: "node-attempt" }>;
  readonly lease: ExecutionLeaseContext & {
    readonly target: Extract<
      ExecutionTarget,
      { readonly kind: "node-attempt" }
    >;
  };
  readonly permissionScope: string;
  readonly sideEffectPolicy: "formal";
  readonly immutableContext: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly snapshotRevisionId: string;
    readonly handlerKindId: string;
    readonly workPackage?: {
      readonly id: string;
      readonly versionId: string;
      readonly applicationId: string;
      readonly repositoryReference: string;
      readonly positionId: string;
      readonly aiMemberId: string;
      readonly allowedPermissions: readonly string[];
      readonly allocationId: string;
      readonly executionTreePath: string;
      readonly sourceBranch: string;
      readonly interactionSessionId: string;
      readonly sandboxIdentity: string;
      readonly evidenceScope: string;
    };
  };
}

export interface ModelOnlyInteractionContext {
  readonly schemaVersion: 1;
  readonly schemaHash: string;
  readonly contextHash: string;
  readonly mechanism: "model-only";
  readonly mechanismVersion: string;
  readonly session: {
    readonly id: string;
    readonly mode: "consultation";
  };
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
  };
  readonly aiMember: {
    readonly id: string;
    readonly displayName: string;
    readonly profile: string;
  };
  readonly position: {
    readonly id: string;
    readonly name: string;
    readonly responsibility: string;
  };
  readonly history: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
  readonly prompt: string;
}

export interface InteractionExecutionRequest extends ExecutionRequestBase {
  readonly target: Extract<
    ExecutionTarget,
    { readonly kind: "interaction-turn" }
  >;
  readonly lease: ExecutionLeaseContext & {
    readonly target: Extract<
      ExecutionTarget,
      { readonly kind: "interaction-turn" }
    >;
  };
  readonly model: string;
  readonly permissionScope: "none";
  readonly sideEffectPolicy: "none";
  readonly immutableContext: ModelOnlyInteractionContext;
}

export type ExecutionRequest =
  | FormalExecutionRequest
  | InteractionExecutionRequest;

export interface ExecutionCompletion {
  readonly operationKey: string;
  readonly terminalExecutionFactId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly evidenceRefs: readonly string[];
}

export type ReconcileResult =
  | {
      readonly status: "not-started";
      readonly terminalExecutionFactId: string;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly status: "running"; readonly providerExecutionRef: string }
  | {
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly terminalExecutionFactId: string;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly status: "unknown"; readonly evidenceRefs: readonly string[] };

export interface ExecutionAdapterCapabilities {
  readonly reattachRunningOperation: boolean;
  readonly strongExecutionFence: boolean;
  readonly enforceNoSideEffects:
    | false
    | {
        readonly mechanism: "model-only" | "sandbox-policy";
        readonly mechanismVersion: string;
        readonly policySchemaHash: string;
      };
}

export interface ExecutionInspection {
  readonly operationKey: string;
  readonly target: ExecutionTarget;
  readonly terminalFactId: string | null;
  readonly leases: readonly {
    readonly leaseId: string;
    readonly leaseKind: ExecutionLeaseKind;
    readonly executionEpoch: number;
    readonly fenceToken: string;
    readonly workerId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly renewedAt: string | null;
    readonly releasedAt: string | null;
    readonly cancelRequested: boolean;
  }[];
  readonly facts: readonly ExecutionFactEnvelope[];
}

export interface ExecutionFactSinkOptions {
  readonly database: DatabaseSync;
  readonly lease: ExecutionLeaseContext;
  readonly target: ExecutionTarget;
  readonly runId?: string;
  readonly nodeRunId?: string;
  readonly attemptId?: string;
  readonly now: () => Date;
  readonly appendEvent?: (input: {
    readonly type: string;
    readonly payload: unknown;
    readonly timestamp: string;
  }) => void;
  readonly applyAcceptedFact?: (input: {
    readonly fact: AdapterExecutionFact;
    readonly envelope: ExecutionFactEnvelope;
    readonly now: string;
  }) => readonly string[];
}
