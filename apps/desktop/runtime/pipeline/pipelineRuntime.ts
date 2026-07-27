import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRegisteredCompanyAgentId } from "../agent/agentCatalog.js";
import type {
  ExecutionAdapter,
  ExecutionMemoryEntry,
} from "../adapters/scriptedExecutionAdapter.js";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type {
  PermissionRequestView,
  RuntimeInteraction,
} from "../interaction.js";
import {
  createExecutionFactSink,
  ExecutionFactError,
  inspectExecution,
} from "../execution/executionFacts.js";
import type {
  ExecutionCompletion,
  ExecutionFactEnvelope,
  ExecutionInspection,
  ExecutionLeaseContext,
  ExecutionRequest,
} from "../execution/contract.js";
import {
  ArtifactContractSchema,
  DepartmentPipelineGraphSchema,
  DepartmentRunViewSchema,
  RunSnapshotPayloadSchema,
  type ActorRef,
  type DepartmentRunView,
  type RunSnapshotPayload,
} from "../interface.js";
import { canonicalPipelineJson, pipelineHash } from "./canonicalPipeline.js";
import {
  defaultNodeHandlerRegistry,
  type NodeHandlerRegistry,
} from "./nodeHandlerRegistry.js";

export class PipelineRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineRuntimeError";
  }
}

export type ReadyAttemptClaim =
  | {
      readonly kind: "claimed";
      readonly attemptId: string;
      readonly nodeRunId: string;
      readonly snapshotRevisionId: string;
      readonly leaseId: string;
      readonly leaseOwner: string;
      readonly leaseExpiresAt: string;
      readonly operationKey: string;
      readonly executionEpoch: number;
      readonly fenceToken: string;
    }
  | {
      readonly kind: "no-work";
      readonly reason: "no-ready-attempt" | "concurrency-limit";
    };

export type AttemptLeaseRenewal =
  | {
      readonly kind: "renewed";
      readonly leaseExpiresAt: string;
    }
  | {
      readonly kind: "lost";
      readonly reason: "lease-not-owned";
    };

export interface RuntimeAuditRecord {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly runId: string | null;
  readonly nodeRunId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

export interface RuntimeEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: string;
  readonly runId: string | null;
  readonly nodeRunId: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface PipelineRuntime {
  readonly formalizeRunInTransaction: (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly projectId: string;
    readonly departmentId: string;
    readonly productBaseline: {
      readonly id: string;
      readonly sourceProposalRevisionId: string;
      readonly hash: string;
    };
    readonly agentOverrideId?: string;
    readonly parentRunId?: string;
    readonly forkedFromSnapshotRevisionId?: string;
    readonly checkpoint?: (point: "before-run" | "before-snapshot") => void;
  }) => DepartmentRunView;
  readonly replayForkInTransaction: (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly sourceRunId: string;
    readonly sourceSnapshotRevisionId: string;
    readonly productBaselineId: string;
  }) => DepartmentRunView;
  readonly recordProductReadinessInTransaction: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly blocked: boolean;
  }) => DepartmentRunView;
  readonly promoteProductGateInTransaction: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly sourceSnapshotRevisionId: string;
    readonly snapshotRevisionId: string;
    readonly topicId: string;
    readonly qualityGateResultId: string;
    readonly projectSpecRevisionId: string;
    readonly projectSpecHash: string;
    readonly readinessEvidenceIds: readonly string[];
    readonly promotedAt: string;
    readonly checkpoint?: (point: "before-snapshot" | "after-snapshot") => void;
  }) => DepartmentRunView;
  readonly promoteTechnicalGateInTransaction: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly sourceSnapshotRevisionId: string;
    readonly snapshotRevisionId: string;
    readonly qualityGateResultId: string;
    readonly technicalBaselineId: string;
    readonly technicalBaselineHash: string;
    readonly applicationSpecRevisions: readonly {
      readonly applicationId: string;
      readonly id: string;
      readonly hash: string;
    }[];
    readonly promotedAt: string;
    readonly checkpoint?: (point: "before-snapshot" | "after-snapshot") => void;
  }) => DepartmentRunView;
  readonly promoteMemorySelectionInTransaction: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly sourceSnapshotRevisionId: string;
    readonly snapshotRevisionId: string;
    readonly entries: readonly {
      readonly entryId: string;
      readonly entryVersion: number;
      readonly entryHash: string;
      readonly scope: "project" | "ai-member";
      readonly ownerId: string;
      readonly targetProjectId: string;
    }[];
    readonly selectionReason: string;
    readonly policyHash: string;
    readonly selectedAt: string;
  }) => DepartmentRunView;
  readonly startFormalizedRun: (input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly checkpoint?: (point: "before-commit") => void;
  }) => DepartmentRunView;
  readonly startRun: (input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
  }) => DepartmentRunView;
  readonly forkRun: (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly fromNodeRunId: string;
    readonly mode?: "replay" | "reconfigure";
  }) => DepartmentRunView;
  readonly executeReady: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }) => Promise<DepartmentRunView>;
  readonly controlRun: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly action: "pause" | "resume" | "cancel";
  }) => Promise<DepartmentRunView>;
  readonly cancelNodeAttempt: (input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
  }) => Promise<DepartmentRunView>;
  readonly requestNodeAttemptCancellationInTransaction: (input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
  }) => DepartmentRunView;
  readonly dispatchNodeAttemptCancellation: (
    attemptId: string,
  ) => Promise<void>;
  readonly applyGovernedIntervention: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
    readonly feedback: string;
    readonly outcome: "feedback" | "new-attempt";
  }) => DepartmentRunView;
  readonly recoverRun: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly override: {
      readonly providerRef?: string;
      readonly model?: string;
      readonly sandboxRef?: string;
      readonly timeoutSeconds?: number;
      readonly maxIterations?: number;
      readonly maxTokens?: number | null;
      readonly secretReferenceIds?: readonly string[];
    };
  }) => DepartmentRunView;
  readonly claimReadyAttempt: (input: {
    readonly runId: string;
    readonly nodeRunId?: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }) => ReadyAttemptClaim;
  readonly recoverExpiredLeases: () => number;
  readonly reconcilePendingExecutions: () => Promise<number>;
  readonly prepareForShutdown: () => Promise<void>;
  readonly recoverExpiredApprovals: () => number;
  readonly renewAttemptLease: (input: {
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
    readonly checkpoint?: unknown;
  }) => AttemptLeaseRenewal;
  readonly completeClaimedAttempt: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly terminalExecutionFactId?: string;
    readonly result?: unknown;
    readonly artifacts?: readonly {
      readonly type: string;
      readonly schemaVersion: string;
      readonly logicalName: string;
      readonly content: string;
      readonly status?: "draft" | "produced";
      readonly inputVersionIds?: readonly string[];
    }[];
    readonly artifactProducer?: {
      readonly snapshotRevisionId: string;
      readonly aiMemberId: string;
    };
  }) => DepartmentRunView;
  readonly failClaimedAttempt: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly terminalExecutionFactId?: string;
    readonly failure: {
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };
  }) => DepartmentRunView;
  readonly releaseClaimedAttempt: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
  }) => DepartmentRunView;
  readonly decideApproval: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
    readonly actor?: ActorRef;
    readonly commandId?: string;
  }) => DepartmentRunView;
  readonly retryApproval: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly actor: ActorRef;
  }) => DepartmentRunView;
  readonly retryNode: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly feedback?: string;
  }) => DepartmentRunView;
  readonly decidePermission: (input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
    readonly actor: ActorRef;
    readonly commandId: string;
  }) => PermissionRequestView;
  readonly inspectRun: (runId: string) => DepartmentRunView;
  readonly listRuns: (input?: {
    readonly projectId?: string;
  }) => readonly DepartmentRunView[];
  readonly auditRecords: (input?: {
    readonly runId?: string;
    readonly limit?: number;
  }) => readonly RuntimeAuditRecord[];
  readonly runtimeEvents: (input: {
    readonly afterSequence: number;
    readonly limit: number;
  }) => readonly RuntimeEventRecord[];
  readonly runtimeEventsForConsumer: (input: {
    readonly consumerId: string;
    readonly limit: number;
  }) => readonly RuntimeEventRecord[];
  readonly acknowledgeRuntimeEvents: (input: {
    readonly consumerId: string;
    readonly sequence: number;
  }) => void;
  readonly inspectExecution: (input: {
    readonly operationKey?: string;
    readonly attemptId?: string;
  }) => ExecutionInspection;
}

interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly departmentId: string;
  readonly pipelineVersionId: string | null;
  readonly snapshotRevisionId: string | null;
  readonly productBaselineId: string | null;
  readonly status: string;
  readonly pausedFromStatus: string | null;
  readonly parentRunId: string | null;
  readonly forkedFromSnapshotRevisionId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface NodeRow {
  readonly id: string;
  readonly runId: string;
  readonly pipelineNodeId: string;
  readonly nodeType: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number]["type"];
  readonly handlerKindId: string | null;
  readonly inputSchemaHash: string | null;
  readonly outputSchemaHash: string | null;
  readonly status: string;
  readonly attemptCount: number;
  readonly requiredDependencyIdsJson: string;
  readonly resultJson: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AttemptRow {
  readonly id: string;
  readonly nodeRunId: string;
  readonly attemptNumber: number;
  readonly snapshotRevisionId: string;
  readonly reason: "initial" | "request-changes" | "retry" | "recovery";
  readonly status:
    | "ready"
    | "running"
    | "reconciling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly structuredResultJson: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly recoverable: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

interface FeedbackRow {
  readonly id: string;
  readonly targetAttemptId: string;
  readonly sourceApprovalId: string | null;
  readonly kind: "request-changes" | "retry";
  readonly content: string;
  readonly createdAt: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly nodeRunId: string;
  readonly cycle: number;
  readonly status: "pending" | "decided" | "expired" | "cancelled";
  readonly decision: "approve" | "request-changes" | "reject" | null;
  readonly requestedAction: string;
  readonly inputManifestHash: string | null;
  readonly eligibleHumanPolicyJson: string;
  readonly expiresAt: string | null;
  readonly decisionActorType: ActorRef["type"] | null;
  readonly decisionActorId: string | null;
  readonly decisionActorAuthenticatedBy: ActorRef["authenticatedBy"] | null;
  readonly decisionCommandId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly expiredAt: string | null;
}

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new PipelineRuntimeError(
      "RUN_SNAPSHOT_INVALID",
      `${description} is not valid JSON: ${String(error)}`,
    );
  }
};

const unique = <Value>(values: readonly Value[]): Value[] => [
  ...new Set(values),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonPrimitive = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const reachableNodeIds = (
  graph: RunSnapshotPayload["pipelineVersion"]["graph"],
  initialIds: readonly string[],
): Set<string> => {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const reached = new Set<string>();
  const pending = [...initialIds];
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId || reached.has(nodeId)) continue;
    reached.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return reached;
};

export const openPipelineRuntime = (
  database: DatabaseSync,
  executionAdapter: ExecutionAdapter,
  options: {
    readonly clock?: () => Date;
    readonly artifactRegistry?: ArtifactRegistry;
    readonly handlerRegistry?: NodeHandlerRegistry;
    readonly events?: Pick<RuntimeEvents, "append">;
    readonly interaction?: RuntimeInteraction;
    readonly resolveMemoryEntries?: (input: {
      readonly projectId: string;
      readonly aiMemberId: string | null;
      readonly selections: NonNullable<RunSnapshotPayload["memorySelections"]>;
    }) => readonly ExecutionMemoryEntry[];
  } = {},
): PipelineRuntime => {
  const clock = options.clock ?? (() => new Date());
  const handlerRegistry = options.handlerRegistry ?? defaultNodeHandlerRegistry;
  const resolveMemoryEntries = (
    snapshot: RunSnapshotPayload,
    node: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number],
  ): readonly ExecutionMemoryEntry[] => {
    const position = snapshot.positions.find(
      (candidate) => candidate.id === node.positionId,
    );
    return (
      options.resolveMemoryEntries?.({
        projectId: snapshot.project.id,
        aiMemberId: position?.aiMember.id ?? null,
        selections: snapshot.memorySelections ?? [],
      }) ?? []
    );
  };
  const activeExecutions = new Map<
    string,
    {
      readonly attemptId: string;
      readonly runId: string;
      readonly controller: AbortController;
      readonly done: Promise<void>;
    }
  >();
  const appendRuntimeMutation = (input: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly eventType: string;
    readonly additionalEventType?: string;
    readonly runId?: string;
    readonly nodeRunId?: string;
    readonly before?: unknown;
    readonly after: unknown;
    readonly createdAt: string;
    readonly audit?: boolean;
  }): void => {
    if (input.audit !== false) {
      const commandContext = database
        .prepare(
          `SELECT command_id AS commandId, actor_type AS actorType,
                  actor_id AS actorId, authenticated_by AS authenticatedBy
             FROM runtime_unit_of_work_context WHERE slot = 1`,
        )
        .get() as
        | {
            readonly commandId: string;
            readonly actorType: string;
            readonly actorId: string;
            readonly authenticatedBy: string;
          }
        | undefined;
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.action,
          input.entityType,
          input.entityId,
          input.runId ?? null,
          input.nodeRunId ?? null,
          input.before === undefined ? null : JSON.stringify(input.before),
          JSON.stringify(input.after),
          input.createdAt,
          commandContext?.commandId ?? null,
          commandContext?.actorType ?? null,
          commandContext?.actorId ?? null,
          commandContext?.authenticatedBy ?? null,
        );
    }
    const runScope = input.runId
      ? (database
          .prepare(
            `SELECT project_id AS projectId, department_id AS departmentId,
                    snapshot_revision_id AS snapshotRevisionId,
                    pipeline_version_id AS pipelineVersionId
               FROM department_runs
              WHERE id = ?`,
          )
          .get(input.runId) as
          | {
              readonly projectId: string;
              readonly departmentId: string;
              readonly snapshotRevisionId: string | null;
              readonly pipelineVersionId: string | null;
            }
          | undefined)
      : undefined;
    const appendEvent = (type: string): void => {
      if (options.events && input.runId && runScope) {
        options.events.append({
          type,
          scope: {
            companyId: "company",
            projectId: runScope.projectId,
            departmentId: runScope.departmentId,
            runId: input.runId,
            ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
            ...(runScope.snapshotRevisionId
              ? { snapshotRevisionId: runScope.snapshotRevisionId }
              : {}),
          },
          payload: input.after,
          timestamp: input.createdAt,
        });
        return;
      }
      database
        .prepare(
          `INSERT INTO runtime_event_outbox(
             event_id, type, run_id, node_run_id, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          type,
          input.runId ?? null,
          input.nodeRunId ?? null,
          JSON.stringify(input.after),
          input.createdAt,
        );
    };
    appendEvent(input.eventType);
    if (input.additionalEventType) appendEvent(input.additionalEventType);
  };

  const appendExecutionEvent = (input: {
    readonly type: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }): void => {
    const scope = database
      .prepare(
        `SELECT project_id AS projectId, department_id AS departmentId,
                snapshot_revision_id AS snapshotRevisionId
           FROM department_runs
          WHERE id = ?`,
      )
      .get(input.runId) as
      | {
          readonly projectId: string;
          readonly departmentId: string;
          readonly snapshotRevisionId: string | null;
        }
      | undefined;
    if (options.events && scope) {
      options.events.append({
        type: input.type,
        scope: {
          companyId: "company",
          projectId: scope.projectId,
          departmentId: scope.departmentId,
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          nodeAttemptId: input.attemptId,
          ...(scope.snapshotRevisionId
            ? { snapshotRevisionId: scope.snapshotRevisionId }
            : {}),
        },
        payload: input.payload,
        timestamp: input.createdAt,
      });
    }
  };

  const auditRecords = (
    input: {
      readonly runId?: string;
      readonly limit?: number;
    } = {},
  ): readonly RuntimeAuditRecord[] => {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000);
    const rows = database
      .prepare(
        `SELECT id, action, entity_type AS entityType, entity_id AS entityId,
                run_id AS runId, node_run_id AS nodeRunId,
                before_json AS beforeJson, after_json AS afterJson,
                created_at AS createdAt
           FROM runtime_audit_records
          WHERE (? IS NULL OR run_id = ?)
          ORDER BY created_at, id
          LIMIT ?`,
      )
      .all(input.runId ?? null, input.runId ?? null, limit) as Array<{
      readonly id: string;
      readonly action: string;
      readonly entityType: string;
      readonly entityId: string;
      readonly runId: string | null;
      readonly nodeRunId: string | null;
      readonly beforeJson: string | null;
      readonly afterJson: string | null;
      readonly createdAt: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      runId: row.runId,
      nodeRunId: row.nodeRunId,
      before:
        row.beforeJson === null
          ? null
          : parseJson(row.beforeJson, `Audit record ${row.id} before state`),
      after:
        row.afterJson === null
          ? null
          : parseJson(row.afterJson, `Audit record ${row.id} after state`),
      createdAt: row.createdAt,
    }));
  };

  const runtimeEvents = (input: {
    readonly afterSequence: number;
    readonly limit: number;
  }): readonly RuntimeEventRecord[] => {
    const afterSequence = Math.max(Math.floor(input.afterSequence), 0);
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 1_000);
    const rows = database
      .prepare(
        `SELECT sequence, event_id AS eventId, type, run_id AS runId,
                node_run_id AS nodeRunId, payload_json AS payloadJson,
                created_at AS createdAt
           FROM runtime_event_outbox
          WHERE sequence > ?
          ORDER BY sequence
          LIMIT ?`,
      )
      .all(afterSequence, limit) as unknown as Array<{
      readonly sequence: number;
      readonly eventId: string;
      readonly type: string;
      readonly runId: string | null;
      readonly nodeRunId: string | null;
      readonly payloadJson: string;
      readonly createdAt: string;
    }>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventId: row.eventId,
      type: row.type,
      runId: row.runId,
      nodeRunId: row.nodeRunId,
      payload: parseJson(row.payloadJson, `Runtime event ${row.eventId}`),
      createdAt: row.createdAt,
    }));
  };

  const runtimeEventsForConsumer = (input: {
    readonly consumerId: string;
    readonly limit: number;
  }): readonly RuntimeEventRecord[] => {
    if (!input.consumerId.trim()) {
      throw new PipelineRuntimeError(
        "RUNTIME_EVENT_CURSOR_INVALID",
        "Runtime event consumer ID must not be empty.",
      );
    }
    const cursor = database
      .prepare(
        "SELECT sequence FROM runtime_event_cursors WHERE consumer_id = ?",
      )
      .get(input.consumerId) as { readonly sequence: number } | undefined;
    return runtimeEvents({
      afterSequence: Number(cursor?.sequence ?? 0),
      limit: input.limit,
    });
  };

  const acknowledgeRuntimeEvents = (input: {
    readonly consumerId: string;
    readonly sequence: number;
  }): void => {
    if (
      !input.consumerId.trim() ||
      !Number.isInteger(input.sequence) ||
      input.sequence < 0
    ) {
      throw new PipelineRuntimeError(
        "RUNTIME_EVENT_CURSOR_INVALID",
        "Runtime event acknowledgement requires a consumer ID and non-negative sequence.",
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO runtime_event_cursors(consumer_id, sequence, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(consumer_id) DO UPDATE SET
           sequence = MAX(runtime_event_cursors.sequence, excluded.sequence),
           updated_at = excluded.updated_at`,
      )
      .run(input.consumerId, input.sequence, now);
  };

  const inspectExecutionForRuntime: PipelineRuntime["inspectExecution"] = (
    input,
  ) => {
    const operationKey =
      input.operationKey ??
      (input.attemptId
        ? ((
            database
              .prepare(
                "SELECT execution_operation_key AS operationKey FROM node_attempts WHERE id = ?",
              )
              .get(input.attemptId) as
              | { readonly operationKey: string | null }
              | undefined
          )?.operationKey ?? null)
        : null);
    if (!operationKey) {
      throw new PipelineRuntimeError(
        "EXECUTION_NOT_FOUND",
        "Execution inspection requires an operation key or an Attempt with one.",
      );
    }
    return inspectExecution(database, { operationKey });
  };
  const readRunRow = (runId: string): RunRow => {
    const row = database
      .prepare(
        `SELECT id,
                project_id AS projectId,
                department_id AS departmentId,
                pipeline_version_id AS pipelineVersionId,
                snapshot_revision_id AS snapshotRevisionId,
                product_baseline_id AS productBaselineId,
                status,
                paused_from_status AS pausedFromStatus,
                parent_run_id AS parentRunId,
                forked_from_snapshot_revision_id AS forkedFromSnapshotRevisionId,
                revision,
                created_at AS createdAt,
                updated_at AS updatedAt
           FROM department_runs
          WHERE id = ?`,
      )
      .get(runId) as RunRow | undefined;
    if (!row) {
      throw new PipelineRuntimeError(
        "RUN_NOT_FOUND",
        `Department Run ${runId} was not found.`,
      );
    }
    return { ...row, revision: Number(row.revision) };
  };

  const inspectRun = (runId: string): DepartmentRunView => {
    const run = readRunRow(runId);
    if (!run.pipelineVersionId || !run.snapshotRevisionId) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Department Run ${runId} has no active Snapshot Revision.`,
      );
    }
    const snapshot = database
      .prepare(
        `SELECT id, revision, parent_revision AS parentRevision,
                canonical_json AS canonicalJson, hash
           FROM run_snapshot_revisions
          WHERE id = ? AND run_id = ?`,
      )
      .get(run.snapshotRevisionId, runId) as
      | {
          readonly id: string;
          readonly revision: number;
          readonly parentRevision: number | null;
          readonly canonicalJson: string;
          readonly hash: string;
        }
      | undefined;
    if (!snapshot) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${run.snapshotRevisionId} was not found.`,
      );
    }
    const payload = RunSnapshotPayloadSchema.parse(
      parseJson(snapshot.canonicalJson, `Snapshot Revision ${snapshot.id}`),
    );
    if (
      canonicalPipelineJson(payload) !== snapshot.canonicalJson ||
      pipelineHash(payload) !== snapshot.hash
    ) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${snapshot.id} failed its SHA-256 integrity check.`,
      );
    }
    const nodeRows = database
      .prepare(
        `SELECT id,
                run_id AS runId,
                pipeline_node_id AS pipelineNodeId,
                node_type AS nodeType,
                handler_kind_id AS handlerKindId,
                input_schema_hash AS inputSchemaHash,
                output_schema_hash AS outputSchemaHash,
                status,
                attempt_count AS attemptCount,
                required_dependency_ids_json AS requiredDependencyIdsJson,
                result_json AS resultJson,
                failure_code AS failureCode,
                failure_message AS failureMessage,
                created_at AS createdAt,
                updated_at AS updatedAt
           FROM node_runs
          WHERE run_id = ?`,
      )
      .all(runId) as unknown as NodeRow[];
    const attemptRows = database
      .prepare(
        `SELECT node_attempts.id,
                node_attempts.node_run_id AS nodeRunId,
                node_attempts.attempt_number AS attemptNumber,
                node_attempts.snapshot_revision_id AS snapshotRevisionId,
                node_attempts.reason,
                node_attempts.status,
                node_attempts.structured_result_json AS structuredResultJson,
                node_attempts.failure_code AS failureCode,
                node_attempts.failure_message AS failureMessage,
                node_attempts.recoverable AS recoverable,
                node_attempts.created_at AS createdAt,
                node_attempts.started_at AS startedAt,
                node_attempts.completed_at AS completedAt
           FROM node_attempts
           JOIN node_runs ON node_runs.id = node_attempts.node_run_id
          WHERE node_runs.run_id = ?
          ORDER BY node_attempts.attempt_number`,
      )
      .all(runId) as unknown as AttemptRow[];
    const feedbackRows = database
      .prepare(
        `SELECT node_feedback.id,
                node_feedback.target_attempt_id AS targetAttemptId,
                node_feedback.source_approval_id AS sourceApprovalId,
                node_feedback.kind,
                node_feedback.content,
                node_feedback.created_at AS createdAt
           FROM node_feedback
          WHERE node_feedback.run_id = ?
          ORDER BY node_feedback.created_at, node_feedback.id`,
      )
      .all(runId) as unknown as FeedbackRow[];
    const approvalRows = database
      .prepare(
        `SELECT id, node_run_id AS nodeRunId, cycle, status, decision,
                requested_action AS requestedAction,
                input_manifest_hash AS inputManifestHash,
                eligible_human_policy_json AS eligibleHumanPolicyJson,
                expires_at AS expiresAt,
                decision_actor_type AS decisionActorType,
                decision_actor_id AS decisionActorId,
                decision_actor_authenticated_by AS decisionActorAuthenticatedBy,
                decision_command_id AS decisionCommandId,
                created_at AS createdAt, decided_at AS decidedAt,
                expired_at AS expiredAt
           FROM approvals
          WHERE run_id = ?
          ORDER BY cycle, id`,
      )
      .all(runId) as unknown as ApprovalRow[];
    const feedbackByAttemptId = new Map<string, FeedbackRow[]>();
    for (const feedback of feedbackRows) {
      feedbackByAttemptId.set(feedback.targetAttemptId, [
        ...(feedbackByAttemptId.get(feedback.targetAttemptId) ?? []),
        feedback,
      ]);
    }
    const attemptsByNodeRunId = new Map<string, AttemptRow[]>();
    for (const attempt of attemptRows) {
      attemptsByNodeRunId.set(attempt.nodeRunId, [
        ...(attemptsByNodeRunId.get(attempt.nodeRunId) ?? []),
        attempt,
      ]);
    }
    const approvalsByNodeRunId = new Map<string, ApprovalRow[]>();
    for (const approval of approvalRows) {
      approvalsByNodeRunId.set(approval.nodeRunId, [
        ...(approvalsByNodeRunId.get(approval.nodeRunId) ?? []),
        approval,
      ]);
    }
    const nodeOrder = new Map(
      payload.pipelineVersion.graph.nodes.map((node, index) => [
        node.id,
        index,
      ]),
    );
    const continuationPlanRow = database
      .prepare(
        `SELECT id, kind, source_run_id AS sourceRunId,
                target_run_id AS targetRunId,
                source_snapshot_revision_id AS sourceSnapshotRevisionId,
                target_snapshot_revision_id AS targetSnapshotRevisionId,
                target_node_run_id AS targetNodeRunId, mode,
                run_revision AS runRevision, canonical_json AS canonicalJson,
                hash, created_at AS createdAt
           FROM continuation_plans
          WHERE target_run_id = ?
       ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(runId) as
      | {
          readonly id: string;
          readonly kind: "recovery" | "fork";
          readonly sourceRunId: string;
          readonly targetRunId: string;
          readonly sourceSnapshotRevisionId: string;
          readonly targetSnapshotRevisionId: string;
          readonly targetNodeRunId: string | null;
          readonly mode: "recovery" | "replay" | "reconfigure";
          readonly runRevision: number;
          readonly canonicalJson: string;
          readonly hash: string;
          readonly createdAt: string;
        }
      | undefined;
    const continuationItems = continuationPlanRow
      ? (database
          .prepare(
            `SELECT ordinal, pipeline_node_id AS pipelineNodeId,
                    source_node_run_id AS sourceNodeRunId,
                    target_node_run_id AS targetNodeRunId, disposition,
                    evidence_refs_json AS evidenceRefsJson, reason
               FROM continuation_plan_items
              WHERE plan_id = ? ORDER BY ordinal`,
          )
          .all(continuationPlanRow.id) as Array<{
          readonly ordinal: number;
          readonly pipelineNodeId: string;
          readonly sourceNodeRunId: string | null;
          readonly targetNodeRunId: string;
          readonly disposition: "rerun" | "reuse-evidence" | "skip" | "blocked";
          readonly evidenceRefsJson: string;
          readonly reason: string;
        }>)
      : [];
    if (
      continuationPlanRow &&
      pipelineHash(
        parseJson(continuationPlanRow.canonicalJson, "Continuation Plan"),
      ) !== continuationPlanRow.hash
    ) {
      throw new PipelineRuntimeError(
        "CONTINUATION_PLAN_INVALID",
        `Continuation Plan ${continuationPlanRow.id} failed its SHA-256 integrity check.`,
      );
    }

    return DepartmentRunViewSchema.parse({
      run: {
        id: run.id,
        projectId: run.projectId,
        departmentId: run.departmentId,
        pipelineVersionId: run.pipelineVersionId,
        snapshotRevisionId: run.snapshotRevisionId,
        productBaselineId: run.productBaselineId,
        parentRunId: run.parentRunId,
        forkedFromSnapshotRevisionId: run.forkedFromSnapshotRevisionId,
        status: run.status,
        revision: run.revision,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      },
      snapshot: {
        id: snapshot.id,
        revision: Number(snapshot.revision),
        parentRevision:
          snapshot.parentRevision === null
            ? null
            : Number(snapshot.parentRevision),
        hash: snapshot.hash,
        canonicalJson: snapshot.canonicalJson,
        payload,
      },
      continuationPlan: continuationPlanRow
        ? {
            id: continuationPlanRow.id,
            kind: continuationPlanRow.kind,
            sourceRunId: continuationPlanRow.sourceRunId,
            targetRunId: continuationPlanRow.targetRunId,
            sourceSnapshotRevisionId:
              continuationPlanRow.sourceSnapshotRevisionId,
            targetSnapshotRevisionId:
              continuationPlanRow.targetSnapshotRevisionId,
            targetNodeRunId: continuationPlanRow.targetNodeRunId,
            mode: continuationPlanRow.mode,
            runRevision: Number(continuationPlanRow.runRevision),
            hash: continuationPlanRow.hash,
            createdAt: continuationPlanRow.createdAt,
            items: continuationItems.map((item) => ({
              ordinal: Number(item.ordinal),
              pipelineNodeId: item.pipelineNodeId,
              sourceNodeRunId: item.sourceNodeRunId,
              targetNodeRunId: item.targetNodeRunId,
              disposition: item.disposition,
              evidenceRefs: parseJson(
                item.evidenceRefsJson,
                `Continuation Plan item ${item.pipelineNodeId} evidence`,
              ),
              reason: item.reason,
            })),
          }
        : null,
      nodes: nodeRows
        .map((node) => ({
          id: node.id,
          runId: node.runId,
          pipelineNodeId: node.pipelineNodeId,
          nodeType: node.nodeType,
          ...(node.handlerKindId &&
          node.inputSchemaHash &&
          node.outputSchemaHash
            ? {
                handler: {
                  nodeId: node.pipelineNodeId,
                  handlerKindId: node.handlerKindId,
                  inputSchemaHash: node.inputSchemaHash,
                  outputSchemaHash: node.outputSchemaHash,
                },
              }
            : {}),
          status: node.status,
          attemptCount: Number(node.attemptCount),
          attempts: (attemptsByNodeRunId.get(node.id) ?? []).map((attempt) => ({
            id: attempt.id,
            attemptNumber: Number(attempt.attemptNumber),
            snapshotRevisionId: attempt.snapshotRevisionId,
            reason: attempt.reason,
            status: attempt.status,
            recoverable: Number(attempt.recoverable) === 1,
            result:
              attempt.structuredResultJson === null
                ? null
                : parseJson(
                    attempt.structuredResultJson,
                    `Node Attempt ${attempt.id} result`,
                  ),
            failure:
              attempt.failureCode === null || attempt.failureMessage === null
                ? null
                : {
                    code: attempt.failureCode,
                    message: attempt.failureMessage,
                  },
            feedback: (feedbackByAttemptId.get(attempt.id) ?? []).map(
              (feedback) => ({
                id: feedback.id,
                kind: feedback.kind,
                content: feedback.content,
                sourceApprovalId: feedback.sourceApprovalId,
                createdAt: feedback.createdAt,
              }),
            ),
            createdAt: attempt.createdAt,
            startedAt: attempt.startedAt,
            completedAt: attempt.completedAt,
          })),
          approvals: (approvalsByNodeRunId.get(node.id) ?? []).map(
            (approval) => ({
              id: approval.id,
              cycle: Number(approval.cycle),
              status: approval.status,
              decision: approval.decision,
              requestedAction: approval.requestedAction,
              inputManifestHash: approval.inputManifestHash,
              eligibleHumanPolicy: parseJson(
                approval.eligibleHumanPolicyJson,
                `Approval ${approval.id} eligible Human policy`,
              ),
              expiresAt: approval.expiresAt,
              decisionActor:
                approval.decisionActorType &&
                approval.decisionActorId &&
                approval.decisionActorAuthenticatedBy
                  ? {
                      type: approval.decisionActorType,
                      id: approval.decisionActorId,
                      authenticatedBy: approval.decisionActorAuthenticatedBy,
                    }
                  : null,
              decisionCommandId: approval.decisionCommandId,
              createdAt: approval.createdAt,
              decidedAt: approval.decidedAt,
              expiredAt: approval.expiredAt,
            }),
          ),
          requiredDependencyIds: parseJson(
            node.requiredDependencyIdsJson,
            `Node Run ${node.id} dependencies`,
          ),
          result:
            node.resultJson === null
              ? null
              : parseJson(node.resultJson, `Node Run ${node.id} result`),
          failure:
            node.failureCode === null || node.failureMessage === null
              ? null
              : { code: node.failureCode, message: node.failureMessage },
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        }))
        .sort(
          (left, right) =>
            (nodeOrder.get(left.pipelineNodeId) ?? Number.MAX_SAFE_INTEGER) -
            (nodeOrder.get(right.pipelineNodeId) ?? Number.MAX_SAFE_INTEGER),
        ),
    });
  };

  const listRuns = (
    input: { readonly projectId?: string } = {},
  ): readonly DepartmentRunView[] => {
    const rows = input.projectId
      ? database
          .prepare(
            `SELECT id
               FROM department_runs
              WHERE project_id = ? AND snapshot_revision_id IS NOT NULL
           ORDER BY created_at DESC, id DESC`,
          )
          .all(input.projectId)
      : database
          .prepare(
            `SELECT id
               FROM department_runs
              WHERE snapshot_revision_id IS NOT NULL
           ORDER BY created_at DESC, id DESC`,
          )
          .all();
    return (rows as Array<{ readonly id: string }>).map((row) =>
      inspectRun(row.id),
    );
  };

  const buildSnapshot = (input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
    readonly productBaseline?: {
      readonly id: string;
      readonly sourceProposalRevisionId: string;
      readonly hash: string;
    };
  }): RunSnapshotPayload => {
    if (
      input.agentOverrideId !== undefined &&
      !isRegisteredCompanyAgentId(input.agentOverrideId)
    ) {
      throw new PipelineRuntimeError(
        "AGENT_NOT_REGISTERED",
        `Company Agent Adapter ${input.agentOverrideId} is not registered.`,
      );
    }
    const project = database
      .prepare(
        `SELECT id, name, goal, status, revision, shared_context AS sharedContext
           FROM projects
          WHERE id = ?`,
      )
      .get(input.projectId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly goal: string;
          readonly status: "active" | "archived";
          readonly revision: number;
          readonly sharedContext: string;
        }
      | undefined;
    if (!project || project.status !== "active") {
      throw new PipelineRuntimeError(
        "PROJECT_NOT_FOUND",
        `Active Project ${input.projectId} was not found.`,
      );
    }
    const repositoryReferences = (
      database
        .prepare(
          `SELECT repository_ref AS repositoryReference
             FROM project_repository_references
            WHERE project_id = ?
         ORDER BY sort_order`,
        )
        .all(project.id) as Array<{ readonly repositoryReference: string }>
    ).map((row) => row.repositoryReference);

    const department = database
      .prepare(
        `SELECT id,
                name,
                description,
                status,
                revision,
                input_artifact_contracts_json AS inputArtifactContractsJson,
                output_artifact_contracts_json AS outputArtifactContractsJson,
                default_execution_profile_id AS defaultExecutionProfileId,
                active_pipeline_version_id AS activePipelineVersionId
           FROM departments
          WHERE id = ?`,
      )
      .get(input.departmentId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly description: string;
          readonly status: "active" | "archived";
          readonly revision: number;
          readonly inputArtifactContractsJson: string;
          readonly outputArtifactContractsJson: string;
          readonly defaultExecutionProfileId: string | null;
          readonly activePipelineVersionId: string | null;
        }
      | undefined;
    if (!department) {
      throw new PipelineRuntimeError(
        "DEPARTMENT_NOT_FOUND",
        `Department ${input.departmentId} was not found.`,
      );
    }
    if (
      department.status !== "active" ||
      department.activePipelineVersionId === null
    ) {
      throw new PipelineRuntimeError(
        "PIPELINE_VERSION_NOT_ACTIVE",
        `Department ${input.departmentId} has no active Pipeline Version.`,
      );
    }
    const pipelineVersion = database
      .prepare(
        `SELECT id, department_id AS departmentId, version, status,
                graph_json AS graphJson, hash,
                handler_registry_version AS handlerRegistryVersion,
                handler_registry_hash AS handlerRegistryHash
           FROM pipeline_versions
          WHERE id = ?`,
      )
      .get(department.activePipelineVersionId) as
      | {
          readonly id: string;
          readonly departmentId: string;
          readonly version: number;
          readonly status: string;
          readonly graphJson: string;
          readonly hash: string;
          readonly handlerRegistryVersion: number;
          readonly handlerRegistryHash: string;
        }
      | undefined;
    if (!pipelineVersion) {
      throw new PipelineRuntimeError(
        "PIPELINE_VERSION_NOT_FOUND",
        `Pipeline Version ${department.activePipelineVersionId} was not found.`,
      );
    }
    if (pipelineVersion.status !== "published") {
      throw new PipelineRuntimeError(
        "PIPELINE_VERSION_NOT_ACTIVE",
        `Pipeline Version ${pipelineVersion.id} is not published.`,
      );
    }
    if (pipelineVersion.departmentId !== department.id) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Pipeline Version ${pipelineVersion.id} belongs to another Department.`,
      );
    }

    const graph = DepartmentPipelineGraphSchema.parse(
      parseJson(
        pipelineVersion.graphJson,
        `Pipeline Version ${pipelineVersion.id}`,
      ),
    );
    if (pipelineHash(graph) !== pipelineVersion.hash) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Pipeline Version ${pipelineVersion.id} failed its SHA-256 integrity check.`,
      );
    }
    const handlers = (
      database
        .prepare(
          `SELECT node_id AS nodeId, handler_kind_id AS handlerKindId,
                  input_schema_hash AS inputSchemaHash,
                  output_schema_hash AS outputSchemaHash
             FROM pipeline_version_handlers
            WHERE pipeline_version_id = ?
         ORDER BY node_order`,
        )
        .all(pipelineVersion.id) as Array<{
        readonly nodeId: string;
        readonly handlerKindId: string;
        readonly inputSchemaHash: string;
        readonly outputSchemaHash: string;
      }>
    ).map((binding) => ({ ...binding }));

    const positionIds = unique(
      graph.nodes.flatMap((node) => (node.positionId ? [node.positionId] : [])),
    );
    const positions = positionIds.map((positionId) => {
      const position = database
        .prepare(
          `SELECT positions.id,
                  positions.department_id AS departmentId,
                  positions.name,
                  positions.responsibility,
                  positions.default_agent_id AS defaultAgentId,
                  positions.revision,
                  positions.status,
                  ai_members.id AS aiMemberId,
                  ai_members.department_id AS aiMemberDepartmentId,
                  ai_members.display_name AS aiMemberDisplayName,
                  ai_members.profile AS aiMemberProfile,
                  ai_members.responsibility_metadata_json AS responsibilityMetadataJson,
                  ai_members.status AS aiMemberStatus
             FROM positions
             JOIN ai_members ON ai_members.id = positions.ai_member_id
            WHERE positions.id = ?`,
        )
        .get(positionId) as
        | {
            readonly id: string;
            readonly departmentId: string;
            readonly name: string;
            readonly responsibility: string;
            readonly defaultAgentId: string;
            readonly revision: number;
            readonly status: "active" | "archived";
            readonly aiMemberId: string;
            readonly aiMemberDepartmentId: string;
            readonly aiMemberDisplayName: string;
            readonly aiMemberProfile: string;
            readonly responsibilityMetadataJson: string;
            readonly aiMemberStatus: "active" | "inactive";
          }
        | undefined;
      if (
        !position ||
        position.departmentId !== department.id ||
        position.aiMemberDepartmentId !== department.id ||
        position.status !== "active" ||
        position.aiMemberStatus !== "active"
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Position ${positionId} is missing, archived, inactive, or outside Department ${department.id}.`,
        );
      }
      const skillSnapshots = database
        .prepare(
          `SELECT position_skill_bindings.skill_id AS id,
                  skills.version
             FROM position_skill_bindings
             JOIN skills ON skills.id = position_skill_bindings.skill_id
            WHERE position_skill_bindings.position_id = ?
         ORDER BY position_skill_bindings.skill_id`,
        )
        .all(position.id) as Array<{
        readonly id: string;
        readonly version: string;
      }>;
      return {
        id: position.id,
        revision: Number(position.revision),
        name: position.name,
        responsibility: position.responsibility,
        defaultAgentId: position.defaultAgentId,
        resolvedAgentId: input.agentOverrideId ?? position.defaultAgentId,
        agentSource: input.agentOverrideId
          ? ("run-override" as const)
          : ("position-default" as const),
        skillIds: skillSnapshots.map((skill) => skill.id),
        skillSnapshots,
        aiMember: {
          id: position.aiMemberId,
          displayName: position.aiMemberDisplayName,
          profile: position.aiMemberProfile,
          responsibilityMetadata: parseJson(
            position.responsibilityMetadataJson,
            `AI Member ${position.aiMemberId} responsibility metadata`,
          ),
          status: position.aiMemberStatus,
        },
      };
    });

    const profileIds = unique([
      ...(department.defaultExecutionProfileId
        ? [department.defaultExecutionProfileId]
        : []),
      ...graph.nodes.flatMap((node) =>
        node.executionProfileId ? [node.executionProfileId] : [],
      ),
    ]);
    for (const node of graph.nodes) {
      if (
        node.type === "ai-task" &&
        !node.executionProfileId &&
        !department.defaultExecutionProfileId
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `AI Task ${node.id} has no resolved Execution Profile.`,
        );
      }
      if (
        node.type === "ai-task" &&
        node.skillFlowId &&
        !node.skillFlowSnapshot
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `AI Task ${node.id} has no frozen Skill Flow snapshot.`,
        );
      }
    }
    const executionProfiles = profileIds.map((profileId) => {
      const profile = database
        .prepare(
          `SELECT id, department_id AS departmentId, name, provider_ref AS providerRef,
                  model, sandbox_ref AS sandboxRef, branch_strategy AS branchStrategy,
                  timeout_seconds AS timeoutSeconds,
                  max_iterations AS maxIterations,
                  max_tokens AS maxTokens,
                  retry_max_attempts AS retryMaxAttempts,
                  permission_policy AS permissionPolicy,
                  revision, status
             FROM execution_profiles
            WHERE id = ?`,
        )
        .get(profileId) as
        | {
            readonly id: string;
            readonly departmentId: string;
            readonly name: string;
            readonly providerRef: string;
            readonly model: string;
            readonly sandboxRef: string;
            readonly branchStrategy: "head" | "merge-to-head" | "branch";
            readonly timeoutSeconds: number;
            readonly maxIterations: number;
            readonly maxTokens: number | null;
            readonly retryMaxAttempts: number;
            readonly permissionPolicy: "ask" | "allow-safe" | "deny";
            readonly revision: number;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (
        !profile ||
        profile.departmentId !== department.id ||
        profile.status !== "active"
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Execution Profile ${profileId} is missing, archived, or outside Department ${department.id}.`,
        );
      }
      const secretReferenceIds = (
        database
          .prepare(
            `SELECT secret_reference_id AS secretReferenceId
               FROM execution_profile_secret_references
              WHERE execution_profile_id = ?
           ORDER BY sort_order`,
          )
          .all(profileId) as Array<{ readonly secretReferenceId: string }>
      ).map((row) => row.secretReferenceId);
      for (const secretReferenceId of secretReferenceIds) {
        const reference = database
          .prepare(
            `SELECT 1 AS present
               FROM secret_references
              WHERE id = ? AND company_id = 'company' AND status = 'active'`,
          )
          .get(secretReferenceId);
        if (!reference) {
          throw new PipelineRuntimeError(
            "RUN_SNAPSHOT_INVALID",
            `Secret Reference ${secretReferenceId} is missing or archived.`,
          );
        }
      }
      return {
        id: profile.id,
        revision: Number(profile.revision),
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        limits: {
          timeoutSeconds: Number(profile.timeoutSeconds),
          maxIterations: Number(profile.maxIterations),
          maxTokens:
            profile.maxTokens === null ? null : Number(profile.maxTokens),
        },
        retryPolicy: { maxAttempts: Number(profile.retryMaxAttempts) },
        permissionPolicy: profile.permissionPolicy,
        secretReferenceIds,
      };
    });

    const skillFlows = unique(
      graph.nodes.flatMap((node) =>
        node.skillFlowSnapshot ? [node.skillFlowSnapshot.id] : [],
      ),
    ).map((skillFlowId) => {
      const snapshot = graph.nodes.find(
        (node) => node.skillFlowSnapshot?.id === skillFlowId,
      )?.skillFlowSnapshot;
      if (!snapshot) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Frozen Skill Flow ${skillFlowId} was not found in the Pipeline Version.`,
        );
      }
      return snapshot;
    });

    return RunSnapshotPayloadSchema.parse({
      schemaVersion: 1,
      ...(input.productBaseline
        ? { productBaseline: input.productBaseline }
        : {}),
      project: {
        id: project.id,
        revision: Number(project.revision),
        name: project.name,
        goal: project.goal,
        sharedContext: project.sharedContext,
        repositoryReferences,
      },
      department: {
        id: department.id,
        revision: Number(department.revision),
        name: department.name,
        description: department.description,
        inputArtifactContracts: ArtifactContractSchema.array().parse(
          parseJson(
            department.inputArtifactContractsJson,
            `Department ${department.id} input Artifact Contracts`,
          ),
        ),
        outputArtifactContracts: ArtifactContractSchema.array().parse(
          parseJson(
            department.outputArtifactContractsJson,
            `Department ${department.id} output Artifact Contracts`,
          ),
        ),
        defaultExecutionProfileId: department.defaultExecutionProfileId,
      },
      pipelineVersion: {
        id: pipelineVersion.id,
        version: Number(pipelineVersion.version),
        hash: pipelineVersion.hash,
        graph,
        handlerRegistry: {
          version: Number(pipelineVersion.handlerRegistryVersion),
          hash: pipelineVersion.handlerRegistryHash,
        },
        handlers,
      },
      skillFlows,
      positions,
      executionProfiles,
      runLimits: {
        maxActiveNodes: Math.max(
          1,
          Math.min(32, Math.floor(executionAdapter.maxConcurrentNodes ?? 1)),
        ),
      },
    });
  };

  const formalizeRunInTransaction = (
    input: Parameters<PipelineRuntime["formalizeRunInTransaction"]>[0],
  ): DepartmentRunView => {
    const payload = buildSnapshot(input);
    const canonicalJson = canonicalPipelineJson(payload);
    const hash = pipelineHash(payload);
    const now = clock().toISOString();
    input.checkpoint?.("before-run");
    database
      .prepare(
        `INSERT INTO department_runs(
           id, project_id, department_id, status, created_at,
           pipeline_version_id, snapshot_revision_id, revision, updated_at,
           parent_run_id, forked_from_snapshot_revision_id, product_baseline_id
         ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.projectId,
        input.departmentId,
        now,
        payload.pipelineVersion.id,
        input.snapshotRevisionId,
        now,
        input.parentRunId ?? null,
        input.forkedFromSnapshotRevisionId ?? null,
        input.productBaseline.id,
      );
    input.checkpoint?.("before-snapshot");
    database
      .prepare(
        `INSERT INTO run_snapshot_revisions(
           id, run_id, revision, parent_revision, schema_version,
           canonical_json, hash, created_at
         ) VALUES (?, ?, 1, NULL, 1, ?, ?, ?)`,
      )
      .run(input.snapshotRevisionId, input.runId, canonicalJson, hash, now);
    return inspectRun(input.runId);
  };

  const recordProductReadinessInTransaction: PipelineRuntime["recordProductReadinessInTransaction"] =
    (input) => {
      const run = database
        .prepare("SELECT revision FROM department_runs WHERE id = ?")
        .get(input.runId) as { readonly revision: number } | undefined;
      if (!run) {
        throw new PipelineRuntimeError(
          "RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      if (Number(run.revision) !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${Number(run.revision)}.`,
        );
      }
      database
        .prepare(
          `UPDATE department_runs
              SET status = CASE WHEN ? = 1 THEN 'blocked' ELSE status END,
                  revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.blocked ? 1 : 0, clock().toISOString(), input.runId);
      return inspectRun(input.runId);
    };

  const promoteProductGateInTransaction: PipelineRuntime["promoteProductGateInTransaction"] =
    (input) => {
      const run = database
        .prepare(
          `SELECT revision, snapshot_revision_id AS snapshotRevisionId
             FROM department_runs WHERE id = ?`,
        )
        .get(input.runId) as
        | { readonly revision: number; readonly snapshotRevisionId: string }
        | undefined;
      if (!run) {
        throw new PipelineRuntimeError(
          "RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      if (Number(run.revision) !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${Number(run.revision)}.`,
        );
      }
      if (run.snapshotRevisionId !== input.sourceSnapshotRevisionId) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_CONFLICT",
          "Product Gate promotion must extend the Run's current Snapshot Revision.",
        );
      }
      const source = database
        .prepare(
          `SELECT revision, canonical_json AS canonicalJson, hash
             FROM run_snapshot_revisions
            WHERE id = ? AND run_id = ?`,
        )
        .get(input.sourceSnapshotRevisionId, input.runId) as
        | {
            readonly revision: number;
            readonly canonicalJson: string;
            readonly hash: string;
          }
        | undefined;
      if (!source) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} was not found.`,
        );
      }
      const sourcePayload = RunSnapshotPayloadSchema.parse(
        parseJson(
          source.canonicalJson,
          `Snapshot Revision ${input.sourceSnapshotRevisionId}`,
        ),
      );
      if (
        canonicalPipelineJson(sourcePayload) !== source.canonicalJson ||
        pipelineHash(sourcePayload) !== source.hash
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} failed its SHA-256 integrity check.`,
        );
      }
      const payload = RunSnapshotPayloadSchema.parse({
        ...sourcePayload,
        productGatePromotion: {
          topicId: input.topicId,
          qualityGateResultId: input.qualityGateResultId,
          acceptedProjectSpecRevisionId: input.projectSpecRevisionId,
          acceptedProjectSpecHash: input.projectSpecHash,
          readinessEvidenceIds: [...input.readinessEvidenceIds],
          promotedAt: input.promotedAt,
        },
      });
      const canonicalJson = canonicalPipelineJson(payload);
      const hash = pipelineHash(payload);
      input.checkpoint?.("before-snapshot");
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.snapshotRevisionId,
          input.runId,
          Number(source.revision) + 1,
          Number(source.revision),
          canonicalJson,
          hash,
          input.promotedAt,
        );
      input.checkpoint?.("after-snapshot");
      database
        .prepare(
          `UPDATE department_runs
              SET snapshot_revision_id = ?, revision = revision + 1,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(input.snapshotRevisionId, input.promotedAt, input.runId);
      return inspectRun(input.runId);
    };

  const promoteTechnicalGateInTransaction: PipelineRuntime["promoteTechnicalGateInTransaction"] =
    (input) => {
      const run = database
        .prepare(
          `SELECT revision, snapshot_revision_id AS snapshotRevisionId
             FROM department_runs WHERE id = ?`,
        )
        .get(input.runId) as
        | { readonly revision: number; readonly snapshotRevisionId: string }
        | undefined;
      if (!run) {
        throw new PipelineRuntimeError(
          "RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      if (Number(run.revision) !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${Number(run.revision)}.`,
        );
      }
      if (run.snapshotRevisionId !== input.sourceSnapshotRevisionId) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_CONFLICT",
          "Technical Gate promotion must extend the Run's current Snapshot Revision.",
        );
      }
      const source = database
        .prepare(
          `SELECT revision, canonical_json AS canonicalJson, hash
             FROM run_snapshot_revisions
            WHERE id = ? AND run_id = ?`,
        )
        .get(input.sourceSnapshotRevisionId, input.runId) as
        | {
            readonly revision: number;
            readonly canonicalJson: string;
            readonly hash: string;
          }
        | undefined;
      if (!source) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} was not found.`,
        );
      }
      const sourcePayload = RunSnapshotPayloadSchema.parse(
        parseJson(
          source.canonicalJson,
          `Snapshot Revision ${input.sourceSnapshotRevisionId}`,
        ),
      );
      if (
        canonicalPipelineJson(sourcePayload) !== source.canonicalJson ||
        pipelineHash(sourcePayload) !== source.hash
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} failed its SHA-256 integrity check.`,
        );
      }
      const payload = RunSnapshotPayloadSchema.parse({
        ...sourcePayload,
        technicalGatePromotion: {
          qualityGateResultId: input.qualityGateResultId,
          acceptedTechnicalBaselineId: input.technicalBaselineId,
          acceptedTechnicalBaselineHash: input.technicalBaselineHash,
          acceptedApplicationSpecRevisions: [...input.applicationSpecRevisions],
          promotedAt: input.promotedAt,
        },
      });
      const canonicalJson = canonicalPipelineJson(payload);
      const hash = pipelineHash(payload);
      input.checkpoint?.("before-snapshot");
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.snapshotRevisionId,
          input.runId,
          Number(source.revision) + 1,
          Number(source.revision),
          canonicalJson,
          hash,
          input.promotedAt,
        );
      input.checkpoint?.("after-snapshot");
      database
        .prepare(
          `UPDATE department_runs
              SET snapshot_revision_id = ?, revision = revision + 1,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(input.snapshotRevisionId, input.promotedAt, input.runId);
      return inspectRun(input.runId);
    };

  const promoteMemorySelectionInTransaction: PipelineRuntime["promoteMemorySelectionInTransaction"] =
    (input) => {
      const run = database
        .prepare(
          `SELECT revision, snapshot_revision_id AS snapshotRevisionId
             FROM department_runs WHERE id = ?`,
        )
        .get(input.runId) as
        | { readonly revision: number; readonly snapshotRevisionId: string }
        | undefined;
      if (!run) {
        throw new PipelineRuntimeError(
          "RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      if (Number(run.revision) !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${Number(run.revision)}.`,
        );
      }
      if (run.snapshotRevisionId !== input.sourceSnapshotRevisionId) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_CONFLICT",
          "Memory selection must extend the Run's current Snapshot Revision.",
        );
      }
      const source = database
        .prepare(
          `SELECT revision, canonical_json AS canonicalJson, hash
             FROM run_snapshot_revisions
            WHERE id = ? AND run_id = ?`,
        )
        .get(input.sourceSnapshotRevisionId, input.runId) as
        | {
            readonly revision: number;
            readonly canonicalJson: string;
            readonly hash: string;
          }
        | undefined;
      if (!source) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} was not found.`,
        );
      }
      const sourcePayload = RunSnapshotPayloadSchema.parse(
        parseJson(
          source.canonicalJson,
          `Snapshot Revision ${input.sourceSnapshotRevisionId}`,
        ),
      );
      if (
        canonicalPipelineJson(sourcePayload) !== source.canonicalJson ||
        pipelineHash(sourcePayload) !== source.hash
      ) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Snapshot Revision ${input.sourceSnapshotRevisionId} failed its SHA-256 integrity check.`,
        );
      }
      const existing = sourcePayload.memorySelections ?? [];
      const selected = input.entries.map((entry) => ({
        ...entry,
        selectionReason: input.selectionReason,
        policyHash: input.policyHash,
        selectedAt: input.selectedAt,
      }));
      const payload = RunSnapshotPayloadSchema.parse({
        ...sourcePayload,
        memorySelections: [...existing, ...selected],
      });
      const canonicalJson = canonicalPipelineJson(payload);
      const hash = pipelineHash(payload);
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.snapshotRevisionId,
          input.runId,
          Number(source.revision) + 1,
          Number(source.revision),
          canonicalJson,
          hash,
          input.selectedAt,
        );
      database
        .prepare(
          `UPDATE department_runs
              SET snapshot_revision_id = ?, revision = revision + 1,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(input.snapshotRevisionId, input.selectedAt, input.runId);
      return inspectRun(input.runId);
    };

  const replayForkInTransaction: PipelineRuntime["replayForkInTransaction"] = (
    input,
  ) => {
    const source = inspectRun(input.sourceRunId);
    if (source.run.productBaselineId !== input.productBaselineId) {
      throw new PipelineRuntimeError(
        "PRODUCT_BASELINE_MISMATCH",
        `Department Run ${input.sourceRunId} does not use Product Baseline ${input.productBaselineId}.`,
      );
    }
    const selected = database
      .prepare(
        `SELECT canonical_json AS canonicalJson, hash
             FROM run_snapshot_revisions
            WHERE id = ? AND run_id = ?`,
      )
      .get(input.sourceSnapshotRevisionId, input.sourceRunId) as
      | { readonly canonicalJson: string; readonly hash: string }
      | undefined;
    if (!selected) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${input.sourceSnapshotRevisionId} was not found for Run ${input.sourceRunId}.`,
      );
    }
    const payload = RunSnapshotPayloadSchema.parse(
      parseJson(
        selected.canonicalJson,
        `Snapshot Revision ${input.sourceSnapshotRevisionId}`,
      ),
    );
    if (
      canonicalPipelineJson(payload) !== selected.canonicalJson ||
      pipelineHash(payload) !== selected.hash
    ) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${input.sourceSnapshotRevisionId} failed its SHA-256 integrity check.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO department_runs(
             id, project_id, department_id, status, created_at,
             pipeline_version_id, snapshot_revision_id, revision, updated_at,
             parent_run_id, forked_from_snapshot_revision_id, product_baseline_id
           ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        source.run.projectId,
        source.run.departmentId,
        now,
        source.run.pipelineVersionId,
        input.snapshotRevisionId,
        now,
        source.run.id,
        input.sourceSnapshotRevisionId,
        input.productBaselineId,
      );
    database
      .prepare(
        `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, 1, NULL, 1, ?, ?, ?)`,
      )
      .run(
        input.snapshotRevisionId,
        input.runId,
        selected.canonicalJson,
        selected.hash,
        now,
      );
    return inspectRun(input.runId);
  };

  const startFormalizedRun: PipelineRuntime["startFormalizedRun"] = (input) => {
    const row = database
      .prepare(
        `SELECT id
           FROM department_runs
          WHERE project_id = ? AND department_id = ?
            AND product_baseline_id IS NOT NULL
            AND snapshot_revision_id IS NOT NULL
       ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(input.projectId, input.departmentId) as
      | { readonly id: string }
      | undefined;
    if (!row) {
      throw new PipelineRuntimeError(
        "RUN_NOT_FORMALIZED",
        `Project ${input.projectId} has no formalized Department Run for Department ${input.departmentId}.`,
      );
    }
    const current = inspectRun(row.id);
    if (current.nodes.length > 0) return current;
    const dependenciesByNode = new Map<string, string[]>();
    for (const node of current.snapshot.payload.pipelineVersion.graph.nodes) {
      dependenciesByNode.set(node.id, []);
    }
    for (const edge of current.snapshot.payload.pipelineVersion.graph.edges) {
      dependenciesByNode.get(edge.to)?.push(edge.from);
    }
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const alreadyScheduled = database
        .prepare("SELECT 1 AS present FROM node_runs WHERE run_id = ? LIMIT 1")
        .get(current.run.id);
      if (alreadyScheduled) {
        database.exec("COMMIT");
        return inspectRun(current.run.id);
      }
      const insertNode = database.prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, handler_kind_id,
           input_schema_hash, output_schema_hash, status, attempt_count,
           required_dependency_ids_json, result_json, failure_code,
           failure_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)`,
      );
      for (const node of current.snapshot.payload.pipelineVersion.graph.nodes) {
        const dependencies = dependenciesByNode.get(node.id) ?? [];
        const handler = current.snapshot.payload.pipelineVersion.handlers?.find(
          (binding) => binding.nodeId === node.id,
        );
        const nodeRunId = randomUUID();
        const status = dependencies.length === 0 ? "ready" : "queued";
        insertNode.run(
          nodeRunId,
          current.run.id,
          node.id,
          node.type,
          handler?.handlerKindId ?? null,
          handler?.inputSchemaHash ?? null,
          handler?.outputSchemaHash ?? null,
          status,
          JSON.stringify(dependencies),
          now,
          now,
        );
        appendRuntimeMutation({
          action: "node.queue",
          entityType: "node-run",
          entityId: nodeRunId,
          eventType: "node.queued",
          runId: current.run.id,
          nodeRunId,
          after: {
            status,
            pipelineNodeId: node.id,
            handlerKindId: handler?.handlerKindId ?? null,
          },
          createdAt: now,
          audit: false,
        });
      }
      appendRuntimeMutation({
        action: "run.start",
        entityType: "department-run",
        entityId: current.run.id,
        eventType: "run.started",
        runId: current.run.id,
        after: {
          status: current.run.status,
          snapshotRevisionId: current.snapshot.id,
        },
        createdAt: now,
      });
      input.checkpoint?.("before-commit");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(current.run.id);
  };

  const startRun = (input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
  }): DepartmentRunView => {
    const payload = buildSnapshot(input);
    const canonicalJson = canonicalPipelineJson(payload);
    const hash = pipelineHash(payload);
    const runId = randomUUID();
    const snapshotRevisionId = randomUUID();
    const now = new Date().toISOString();
    const dependenciesByNode = new Map<string, string[]>();
    for (const node of payload.pipelineVersion.graph.nodes) {
      dependenciesByNode.set(node.id, []);
    }
    for (const edge of payload.pipelineVersion.graph.edges) {
      dependenciesByNode.get(edge.to)?.push(edge.from);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO department_runs(
             id, project_id, department_id, status, created_at,
             pipeline_version_id, snapshot_revision_id, revision, updated_at
           ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 0, ?)`,
        )
        .run(
          runId,
          input.projectId,
          input.departmentId,
          now,
          payload.pipelineVersion.id,
          snapshotRevisionId,
          now,
        );
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, 1, NULL, 1, ?, ?, ?)`,
        )
        .run(snapshotRevisionId, runId, canonicalJson, hash, now);
      const insertNode = database.prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, handler_kind_id,
           input_schema_hash, output_schema_hash, status, attempt_count,
           required_dependency_ids_json, result_json, failure_code,
           failure_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)`,
      );
      for (const node of payload.pipelineVersion.graph.nodes) {
        const dependencies = dependenciesByNode.get(node.id) ?? [];
        const handler = payload.pipelineVersion.handlers?.find(
          (binding) => binding.nodeId === node.id,
        );
        insertNode.run(
          randomUUID(),
          runId,
          node.id,
          node.type,
          handler?.handlerKindId ?? null,
          handler?.inputSchemaHash ?? null,
          handler?.outputSchemaHash ?? null,
          dependencies.length === 0 ? "ready" : "queued",
          JSON.stringify(dependencies),
          now,
          now,
        );
      }
      appendRuntimeMutation({
        action: "run.start",
        entityType: "department-run",
        entityId: runId,
        eventType: "run.created",
        runId,
        after: {
          status: "ready",
          revision: 0,
          agentOverrideId: input.agentOverrideId ?? null,
          agentSource: input.agentOverrideId
            ? "run-override"
            : "position-default",
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(runId);
  };

  const insertContinuationPlanInTransaction = (input: {
    readonly kind: "recovery" | "fork";
    readonly sourceRunId: string;
    readonly targetRunId: string;
    readonly sourceSnapshotRevisionId: string;
    readonly targetSnapshotRevisionId: string;
    readonly targetNodeRunId: string | null;
    readonly mode: "recovery" | "replay" | "reconfigure";
    readonly runRevision: number;
    readonly createdAt: string;
    readonly items: readonly {
      readonly pipelineNodeId: string;
      readonly sourceNodeRunId: string | null;
      readonly targetNodeRunId: string;
      readonly disposition: "rerun" | "reuse-evidence" | "skip" | "blocked";
      readonly evidenceRefs: readonly string[];
      readonly reason: string;
    }[];
  }): { readonly id: string; readonly hash: string } => {
    const id = randomUUID();
    const manifest = {
      schemaVersion: 1,
      kind: input.kind,
      sourceRunId: input.sourceRunId,
      targetRunId: input.targetRunId,
      sourceSnapshotRevisionId: input.sourceSnapshotRevisionId,
      targetSnapshotRevisionId: input.targetSnapshotRevisionId,
      targetNodeRunId: input.targetNodeRunId,
      mode: input.mode,
      runRevision: input.runRevision,
      items: input.items.map((item, ordinal) => ({ ordinal, ...item })),
    };
    const canonicalJson = canonicalPipelineJson(manifest);
    const hash = pipelineHash(manifest);
    database
      .prepare(
        `INSERT INTO continuation_plans(
           id, kind, source_run_id, target_run_id,
           source_snapshot_revision_id, target_snapshot_revision_id,
           target_node_run_id, mode, run_revision, canonical_json, hash,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.sourceRunId,
        input.targetRunId,
        input.sourceSnapshotRevisionId,
        input.targetSnapshotRevisionId,
        input.targetNodeRunId,
        input.mode,
        input.runRevision,
        canonicalJson,
        hash,
        input.createdAt,
      );
    const insertItem = database.prepare(
      `INSERT INTO continuation_plan_items(
         id, plan_id, ordinal, pipeline_node_id, source_node_run_id,
         target_node_run_id, disposition, evidence_refs_json, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.items.forEach((item, ordinal) => {
      insertItem.run(
        randomUUID(),
        id,
        ordinal,
        item.pipelineNodeId,
        item.sourceNodeRunId,
        item.targetNodeRunId,
        item.disposition,
        JSON.stringify(item.evidenceRefs),
        item.reason,
      );
    });
    return { id, hash };
  };

  const forkRun = (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly fromNodeRunId: string;
    readonly mode?: "replay" | "reconfigure";
  }): DepartmentRunView => {
    const source = inspectRun(input.runId);
    const selectedSnapshot = database
      .prepare(
        `SELECT canonical_json AS canonicalJson, hash, revision
           FROM run_snapshot_revisions
          WHERE id = ? AND run_id = ?`,
      )
      .get(input.snapshotRevisionId, input.runId) as
      | {
          readonly canonicalJson: string;
          readonly hash: string;
          readonly revision: number;
        }
      | undefined;
    if (!selectedSnapshot) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${input.snapshotRevisionId} was not found for Run ${input.runId}.`,
      );
    }
    const selectedPayload = RunSnapshotPayloadSchema.parse(
      parseJson(
        selectedSnapshot.canonicalJson,
        `Snapshot Revision ${input.snapshotRevisionId}`,
      ),
    );
    if (
      canonicalPipelineJson(selectedPayload) !==
        selectedSnapshot.canonicalJson ||
      pipelineHash(selectedPayload) !== selectedSnapshot.hash
    ) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Snapshot Revision ${input.snapshotRevisionId} failed its SHA-256 integrity check.`,
      );
    }
    const forkPoint = source.nodes.find(
      (node) => node.id === input.fromNodeRunId,
    );
    if (!forkPoint) {
      throw new PipelineRuntimeError(
        "NODE_NOT_FOUND",
        `Node Run ${input.fromNodeRunId} was not found in Run ${input.runId}.`,
      );
    }
    const requiredByNode = new Map(
      source.nodes.map((node) => [
        node.pipelineNodeId,
        node.requiredDependencyIds,
      ]),
    );
    const preservedIds = new Set<string>();
    const pending = [...forkPoint.requiredDependencyIds];
    while (pending.length > 0) {
      const pipelineNodeId = pending.shift();
      if (!pipelineNodeId || preservedIds.has(pipelineNodeId)) continue;
      preservedIds.add(pipelineNodeId);
      pending.push(...(requiredByNode.get(pipelineNodeId) ?? []));
    }
    const runId = randomUUID();
    const snapshotId = randomUUID();
    const now = clock().toISOString();
    const dependenciesByNode = new Map<string, string[]>();
    const targetNodeRunIds = new Map<string, string>();
    for (const node of selectedPayload.pipelineVersion.graph.nodes) {
      dependenciesByNode.set(node.id, []);
    }
    for (const edge of selectedPayload.pipelineVersion.graph.edges) {
      dependenciesByNode.get(edge.to)?.push(edge.from);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO department_runs(
             id, project_id, department_id, status, created_at,
             pipeline_version_id, snapshot_revision_id, revision, updated_at,
             parent_run_id, forked_from_snapshot_revision_id
           ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          runId,
          source.run.projectId,
          source.run.departmentId,
          now,
          source.run.pipelineVersionId,
          snapshotId,
          now,
          source.run.id,
          input.snapshotRevisionId,
        );
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, 1, NULL, 1, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          runId,
          selectedSnapshot.canonicalJson,
          selectedSnapshot.hash,
          now,
        );
      const insertNode = database.prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, handler_kind_id,
           input_schema_hash, output_schema_hash, status, attempt_count,
           required_dependency_ids_json, result_json, failure_code,
           failure_message, created_at, updated_at, source_node_run_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
      );
      for (const node of selectedPayload.pipelineVersion.graph.nodes) {
        const sourceNode = source.nodes.find(
          (candidate) => candidate.pipelineNodeId === node.id,
        );
        const preserved =
          preservedIds.has(node.id) &&
          ["succeeded", "skipped"].includes(sourceNode?.status ?? "");
        const dependencies = dependenciesByNode.get(node.id) ?? [];
        const ready =
          !preserved &&
          dependencies.every((dependencyId) => preservedIds.has(dependencyId));
        const targetNodeRunId = randomUUID();
        targetNodeRunIds.set(node.id, targetNodeRunId);
        const handler = selectedPayload.pipelineVersion.handlers?.find(
          (binding) => binding.nodeId === node.id,
        );
        insertNode.run(
          targetNodeRunId,
          runId,
          node.id,
          node.type,
          handler?.handlerKindId ?? null,
          handler?.inputSchemaHash ?? null,
          handler?.outputSchemaHash ?? null,
          preserved ? sourceNode!.status : ready ? "ready" : "queued",
          JSON.stringify(dependencies),
          preserved ? JSON.stringify(sourceNode?.result ?? null) : null,
          now,
          now,
          preserved ? sourceNode!.id : null,
        );
      }
      const continuationItems = selectedPayload.pipelineVersion.graph.nodes.map(
        (node) => {
          const sourceNode = source.nodes.find(
            (candidate) => candidate.pipelineNodeId === node.id,
          );
          const targetNodeRunId = targetNodeRunIds.get(node.id);
          if (!targetNodeRunId) {
            throw new PipelineRuntimeError(
              "CONTINUATION_PLAN_INVALID",
              `Fork target Node ${node.id} has no persisted Node Run.`,
            );
          }
          const preserved =
            preservedIds.has(node.id) &&
            ["succeeded", "skipped"].includes(sourceNode?.status ?? "");
          const targetNode = database
            .prepare("SELECT status FROM node_runs WHERE id = ?")
            .get(targetNodeRunId) as { readonly status: string };
          const terminal = sourceNode
            ? (database
                .prepare(
                  `SELECT terminal_execution_fact_id AS terminalFactId
                     FROM node_attempts
                    WHERE node_run_id = ? AND terminal_execution_fact_id IS NOT NULL
                 ORDER BY attempt_number DESC LIMIT 1`,
                )
                .get(sourceNode.id) as
                | { readonly terminalFactId: string }
                | undefined)
            : undefined;
          const disposition = preserved
            ? sourceNode?.status === "skipped"
              ? ("skip" as const)
              : ("reuse-evidence" as const)
            : targetNode.status === "ready"
              ? ("rerun" as const)
              : ("blocked" as const);
          return {
            pipelineNodeId: node.id,
            sourceNodeRunId: sourceNode?.id ?? null,
            targetNodeRunId,
            disposition,
            evidenceRefs: terminal
              ? [terminal.terminalFactId]
              : sourceNode?.status === "skipped"
                ? [`node-run:${sourceNode.id}:skipped`]
                : [],
            reason:
              disposition === "reuse-evidence"
                ? "Exact upstream terminal evidence is reusable in the selected Snapshot."
                : disposition === "skip"
                  ? "The source Node was skipped by the graph-defined branch decision."
                  : disposition === "rerun"
                    ? "The Node is inside the explicit Fork replay boundary."
                    : "The Node remains blocked until its rerun dependencies produce evidence.",
          };
        },
      );
      const continuationPlan = insertContinuationPlanInTransaction({
        kind: "fork",
        sourceRunId: source.run.id,
        targetRunId: runId,
        sourceSnapshotRevisionId: input.snapshotRevisionId,
        targetSnapshotRevisionId: snapshotId,
        targetNodeRunId: targetNodeRunIds.get(forkPoint.pipelineNodeId) ?? null,
        mode: input.mode ?? "replay",
        runRevision: 0,
        createdAt: now,
        items: continuationItems,
      });
      const superseded = database
        .prepare(
          `UPDATE department_runs
              SET status = 'superseded', revision = revision + 1,
                  updated_at = ?
            WHERE id = ? AND revision = ? AND status <> 'superseded'`,
        )
        .run(now, source.run.id, source.run.revision);
      if (superseded.changes !== 1) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Source Run ${source.run.id} changed before Fork supersession.`,
        );
      }
      appendRuntimeMutation({
        action: "run.fork",
        entityType: "department-run",
        entityId: runId,
        eventType: "run.forked",
        runId,
        before: {
          parentRunId: source.run.id,
          snapshotRevisionId: input.snapshotRevisionId,
          fromNodeRunId: input.fromNodeRunId,
        },
        after: {
          status: "ready",
          parentStatus: "superseded",
          continuationPlanId: continuationPlan.id,
          continuationPlanHash: continuationPlan.hash,
          preservedPipelineNodeIds: [...preservedIds],
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(runId);
  };

  const claimReadyAttempt = (input: {
    readonly runId: string;
    readonly nodeRunId?: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): ReadyAttemptClaim => {
    if (!input.workerId.trim()) {
      throw new PipelineRuntimeError(
        "LEASE_INVALID",
        "Scheduler worker ID must not be empty.",
      );
    }
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new PipelineRuntimeError(
        "LEASE_INVALID",
        "Scheduler lease duration must be greater than zero.",
      );
    }
    const current = inspectRun(input.runId);
    const now = clock();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + Math.floor(input.leaseDurationMs),
    ).toISOString();
    const leaseId = randomUUID();

    database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = database
        .prepare(
          `SELECT node_attempts.id AS attemptId,
                  node_attempts.node_run_id AS nodeRunId,
                  node_attempts.snapshot_revision_id AS snapshotRevisionId,
                  node_attempts.execution_operation_key AS executionOperationKey
             FROM node_attempts
             JOIN node_runs ON node_runs.id = node_attempts.node_run_id
             JOIN department_runs ON department_runs.id = node_runs.run_id
            WHERE node_runs.run_id = ?
              AND (? IS NULL OR node_runs.id = ?)
              AND department_runs.status IN ('ready', 'running', 'recovering')
              AND node_runs.status = 'ready'
              AND node_attempts.status = 'ready'
              AND (
                node_attempts.lease_id IS NULL OR
                node_attempts.lease_expires_at IS NULL OR
                node_attempts.lease_expires_at <= ?
              )
            ORDER BY node_runs.created_at, node_runs.id,
                     node_attempts.attempt_number
            LIMIT 1`,
        )
        .get(
          input.runId,
          input.nodeRunId ?? null,
          input.nodeRunId ?? null,
          nowIso,
        ) as
        | {
            readonly attemptId: string;
            readonly nodeRunId: string;
            readonly snapshotRevisionId: string;
            readonly executionOperationKey: string | null;
          }
        | undefined;
      if (!candidate) {
        database.exec("COMMIT");
        return { kind: "no-work", reason: "no-ready-attempt" };
      }
      const active = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM node_attempts
             JOIN node_runs ON node_runs.id = node_attempts.node_run_id
            WHERE node_runs.run_id = ?
              AND node_attempts.status = 'running'
              AND node_attempts.lease_expires_at > ?`,
        )
        .get(input.runId, nowIso) as { readonly count: number };
      if (
        Number(active.count) >=
        current.snapshot.payload.runLimits.maxActiveNodes
      ) {
        database.exec("COMMIT");
        return { kind: "no-work", reason: "concurrency-limit" };
      }
      const claimed = database
        .prepare(
          `UPDATE node_attempts
              SET status = 'running', lease_id = ?, lease_owner = ?,
                  lease_expires_at = ?, started_at = COALESCE(started_at, ?),
                  execution_operation_key = COALESCE(execution_operation_key, ?)
            WHERE id = ?
              AND status = 'ready'
              AND (
                lease_id IS NULL OR
                lease_expires_at IS NULL OR
                lease_expires_at <= ?
              )`,
        )
        .run(
          leaseId,
          input.workerId,
          leaseExpiresAt,
          nowIso,
          candidate.executionOperationKey ??
            `node-attempt:${candidate.attemptId}`,
          candidate.attemptId,
          nowIso,
        );
      if (claimed.changes !== 1) {
        database.exec("COMMIT");
        return { kind: "no-work", reason: "no-ready-attempt" };
      }
      const claimedNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'running', updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'ready'`,
        )
        .run(nowIso, candidate.nodeRunId, input.runId);
      const claimedRun = database
        .prepare(
          `UPDATE department_runs
              SET status = 'running', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status IN ('ready', 'running', 'recovering')`,
        )
        .run(nowIso, input.runId);
      if (claimedNode.changes !== 1 || claimedRun.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_CONFLICT",
          `Ready Node Attempt ${candidate.attemptId} changed before it could be claimed.`,
        );
      }
      const operationKey =
        candidate.executionOperationKey ??
        `node-attempt:${candidate.attemptId}`;
      const executionEpoch =
        Number(
          (
            database
              .prepare(
                `SELECT COALESCE(MAX(execution_epoch), 0) AS executionEpoch
                   FROM execution_leases
                  WHERE operation_key = ?`,
              )
              .get(operationKey) as { readonly executionEpoch: number }
          ).executionEpoch,
        ) + 1;
      const fenceToken = randomUUID();
      database
        .prepare(
          `INSERT INTO execution_leases(
             id, target_kind, target_id, lease_kind, operation_key,
             execution_epoch, fence_token, worker_id, issued_at, expires_at,
             renewed_at, released_at, cancel_requested
           ) VALUES (?, 'node-attempt', ?, 'execution', ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
        )
        .run(
          leaseId,
          candidate.attemptId,
          operationKey,
          executionEpoch,
          fenceToken,
          input.workerId,
          nowIso,
          leaseExpiresAt,
        );
      appendExecutionEvent({
        type: "execution.leased",
        runId: input.runId,
        nodeRunId: candidate.nodeRunId,
        attemptId: candidate.attemptId,
        payload: {
          operationKey,
          status: "leased",
          leaseId,
          leaseKind: "execution",
          executionEpoch,
        },
        createdAt: nowIso,
      });
      appendRuntimeMutation({
        action: "attempt.claim",
        entityType: "node-attempt",
        entityId: candidate.attemptId,
        eventType: "attempt.started",
        runId: input.runId,
        nodeRunId: candidate.nodeRunId,
        before: { status: "ready" },
        after: { status: "running", leaseExpiresAt },
        createdAt: nowIso,
      });
      database.exec("COMMIT");
      return {
        kind: "claimed",
        attemptId: candidate.attemptId,
        nodeRunId: candidate.nodeRunId,
        snapshotRevisionId: candidate.snapshotRevisionId,
        leaseId,
        leaseOwner: input.workerId,
        leaseExpiresAt,
        operationKey,
        executionEpoch,
        fenceToken,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const renewAttemptLease = (input: {
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
    readonly checkpoint?: unknown;
  }): AttemptLeaseRenewal => {
    if (
      !input.workerId.trim() ||
      !input.leaseId.trim() ||
      !Number.isFinite(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new PipelineRuntimeError(
        "LEASE_INVALID",
        "Lease renewal requires ownership and a positive duration.",
      );
    }
    const now = clock();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + Math.floor(input.leaseDurationMs),
    ).toISOString();
    database.exec("BEGIN IMMEDIATE");
    let renewed: { readonly changes: number | bigint };
    try {
      renewed = database
        .prepare(
          `UPDATE node_attempts
              SET lease_expires_at = ?,
                  checkpoint_json = COALESCE(?, checkpoint_json)
            WHERE id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          leaseExpiresAt,
          input.checkpoint === undefined
            ? null
            : JSON.stringify(input.checkpoint),
          input.attemptId,
          input.leaseId,
          input.workerId,
          nowIso,
        );
      if (Number(renewed.changes) === 1) {
        const lease = database
          .prepare(
            `UPDATE execution_leases
                SET expires_at = ?, renewed_at = ?
              WHERE id = ? AND worker_id = ? AND released_at IS NULL
                AND expires_at > ?`,
          )
          .run(leaseExpiresAt, nowIso, input.leaseId, input.workerId, nowIso);
        if (lease.changes !== 1) {
          throw new PipelineRuntimeError(
            "LEASE_OWNERSHIP_INVALID",
            `Execution Lease ${input.leaseId} is no longer active.`,
          );
        }
        appendRuntimeMutation({
          action: "attempt.lease-renew",
          entityType: "node-attempt",
          entityId: input.attemptId,
          eventType: "attempt.lease.renewed",
          after: { status: "running", leaseExpiresAt },
          createdAt: nowIso,
        });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return Number(renewed.changes) === 1
      ? { kind: "renewed", leaseExpiresAt }
      : { kind: "lost", reason: "lease-not-owned" };
  };

  const completeClaimedAttempt = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly terminalExecutionFactId?: string;
    readonly result?: unknown;
    readonly artifacts?: readonly {
      readonly type: string;
      readonly schemaVersion: string;
      readonly logicalName: string;
      readonly content: string;
      readonly status?: "draft" | "produced";
      readonly inputVersionIds?: readonly string[];
    }[];
    readonly artifactProducer?: {
      readonly snapshotRevisionId: string;
      readonly aiMemberId: string;
    };
  }): DepartmentRunView => {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const completedAttempt = database
        .prepare(
          `UPDATE node_attempts
              SET status = 'succeeded', structured_result_json = ?,
                  failure_code = NULL, failure_message = NULL,
                  recoverable = 0, completed_at = ?,
                  terminal_execution_fact_id = COALESCE(?, terminal_execution_fact_id)
            WHERE id = ? AND node_run_id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          input.result === undefined ? null : JSON.stringify(input.result),
          now,
          input.terminalExecutionFactId ?? null,
          input.attemptId,
          input.nodeRunId,
          input.leaseId,
          input.workerId,
          now,
        );
      if (completedAttempt.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_OWNERSHIP_INVALID",
          `Node Attempt ${input.attemptId} is no longer owned by this scheduler worker.`,
        );
      }
      const completedNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'succeeded', result_json = ?, failure_code = NULL,
                  failure_message = NULL, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(
          input.result === undefined ? null : JSON.stringify(input.result),
          now,
          input.nodeRunId,
          input.runId,
        );
      if (completedNode.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_OWNERSHIP_INVALID",
          `Node Run ${input.nodeRunId} is no longer owned by this scheduler worker.`,
        );
      }
      refreshQueuedNodes(input.runId, now);
      const updatedRun = database
        .prepare(
          `UPDATE department_runs
              SET status = 'running', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(now, input.runId);
      if (updatedRun.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_OWNERSHIP_INVALID",
          `Department Run ${input.runId} cannot accept the completed Attempt.`,
        );
      }
      if (input.artifacts?.length) {
        if (!options.artifactRegistry || !input.artifactProducer) {
          throw new PipelineRuntimeError(
            "ARTIFACT_PRODUCER_INVALID",
            "Artifact facts require the Artifact Registry and complete producer provenance.",
          );
        }
        const run = readRunRow(input.runId);
        for (const artifact of input.artifacts) {
          options.artifactRegistry.registerVersionInTransaction({
            projectId: run.projectId,
            type: artifact.type,
            schemaVersion: artifact.schemaVersion,
            logicalName: artifact.logicalName,
            content: artifact.content,
            status: artifact.status ?? "produced",
            producer: {
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              nodeAttemptId: input.attemptId,
              snapshotRevisionId: input.artifactProducer.snapshotRevisionId,
              aiMemberId: input.artifactProducer.aiMemberId,
            },
            inputVersionIds: artifact.inputVersionIds,
          });
        }
      }
      database
        .prepare(
          `UPDATE execution_leases
              SET released_at = ?
            WHERE id = ? AND worker_id = ? AND released_at IS NULL`,
        )
        .run(now, input.leaseId, input.workerId);
      appendRuntimeMutation({
        action: "attempt.complete",
        entityType: "node-attempt",
        entityId: input.attemptId,
        eventType: "attempt.succeeded",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: { status: "running" },
        after: { status: "succeeded", result: input.result ?? null },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(input.runId);
  };

  const failClaimedAttempt = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
    readonly terminalExecutionFactId?: string;
    readonly failure: {
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };
  }): DepartmentRunView => {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const failedAttempt = database
        .prepare(
          `UPDATE node_attempts
              SET status = 'failed', structured_result_json = NULL,
                  failure_code = ?, failure_message = ?, recoverable = ?,
                  completed_at = ?,
                  terminal_execution_fact_id = COALESCE(?, terminal_execution_fact_id)
            WHERE id = ? AND node_run_id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          input.failure.code,
          input.failure.message,
          input.failure.recoverable ? 1 : 0,
          now,
          input.terminalExecutionFactId ?? null,
          input.attemptId,
          input.nodeRunId,
          input.leaseId,
          input.workerId,
          now,
        );
      if (failedAttempt.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_OWNERSHIP_INVALID",
          `Node Attempt ${input.attemptId} is no longer owned by this scheduler worker.`,
        );
      }
      const failedNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'failed', result_json = NULL, failure_code = ?,
                  failure_message = ?, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(
          input.failure.code,
          input.failure.message,
          now,
          input.nodeRunId,
          input.runId,
        );
      const pipelineNode = database
        .prepare(
          `SELECT pipeline_node_id AS pipelineNodeId
             FROM node_runs
            WHERE id = ? AND run_id = ?`,
        )
        .get(input.nodeRunId, input.runId) as
        | { readonly pipelineNodeId: string }
        | undefined;
      const joins = database
        .prepare(
          `SELECT id, required_dependency_ids_json AS requiredDependencyIdsJson
             FROM node_runs
            WHERE run_id = ? AND node_type = 'join'
              AND status IN ('queued', 'ready')`,
        )
        .all(input.runId) as Array<{
        readonly id: string;
        readonly requiredDependencyIdsJson: string;
      }>;
      const failJoin = database.prepare(
        `UPDATE node_runs
            SET status = 'failed', failure_code = 'JOIN_DEPENDENCY_FAILED',
                failure_message = ?, updated_at = ?
          WHERE id = ? AND run_id = ? AND status IN ('queued', 'ready')`,
      );
      for (const join of joins) {
        const dependencies = parseJson(
          join.requiredDependencyIdsJson,
          `Join Node Run ${join.id} dependencies`,
        );
        if (
          pipelineNode &&
          Array.isArray(dependencies) &&
          dependencies.includes(pipelineNode.pipelineNodeId)
        ) {
          failJoin.run(
            `Join dependency ${pipelineNode.pipelineNodeId} failed.`,
            now,
            join.id,
            input.runId,
          );
        }
      }
      const failedRun = database
        .prepare(
          `UPDATE department_runs
              SET status = 'failed', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(now, input.runId);
      if (failedNode.changes !== 1 || failedRun.changes !== 1) {
        throw new PipelineRuntimeError(
          "LEASE_OWNERSHIP_INVALID",
          `Department Run ${input.runId} cannot accept the failed Attempt.`,
        );
      }
      database
        .prepare(
          `UPDATE execution_leases
              SET released_at = ?
            WHERE id = ? AND worker_id = ? AND released_at IS NULL`,
        )
        .run(now, input.leaseId, input.workerId);
      appendRuntimeMutation({
        action: "attempt.fail",
        entityType: "node-attempt",
        entityId: input.attemptId,
        eventType: "attempt.failed",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: { status: "running" },
        after: { status: "failed", failure: input.failure },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(input.runId);
  };

  const releaseClaimedAttempt = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
  }): DepartmentRunView =>
    failClaimedAttempt({
      ...input,
      failure: {
        code: "ATTEMPT_LEASE_RELEASED",
        message: "The scheduler worker released the Node Attempt lease.",
        recoverable: true,
      },
    });

  const recoverExpiredLeases = (): number => {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const expired = database
        .prepare(
          `SELECT node_attempts.id AS attemptId,
                  node_attempts.node_run_id AS nodeRunId,
                  node_runs.run_id AS runId,
                  node_attempts.execution_operation_key AS operationKey
             FROM node_attempts
             JOIN node_runs ON node_runs.id = node_attempts.node_run_id
            WHERE node_attempts.status = 'running'
              AND node_runs.status = 'running'
              AND node_attempts.lease_expires_at IS NOT NULL
              AND node_attempts.lease_expires_at <= ?
            ORDER BY node_attempts.lease_expires_at, node_attempts.id`,
        )
        .all(now) as unknown as Array<{
        readonly attemptId: string;
        readonly nodeRunId: string;
        readonly runId: string;
        readonly operationKey: string | null;
      }>;
      const failure = {
        code: "EXECUTION_RECONCILIATION_REQUIRED",
        message:
          "The execution Lease expired before the Node Attempt reached a proven terminal state.",
      };
      const reconcileAttempt = database.prepare(
        `UPDATE node_attempts
            SET status = 'reconciling', recoverable = 1, failure_code = ?,
                failure_message = ?, completed_at = NULL
          WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
      );
      const releaseExecutionLease = database.prepare(
        `UPDATE execution_leases
            SET released_at = ?
          WHERE target_kind = 'node-attempt' AND target_id = ?
            AND released_at IS NULL AND expires_at <= ?`,
      );
      const blockNode = database.prepare(
        `UPDATE node_runs
            SET status = 'blocked', failure_code = ?, failure_message = ?,
                updated_at = ?
          WHERE id = ? AND run_id = ? AND status = 'running'`,
      );
      const affectedRunIds = new Set<string>();
      let recovered = 0;
      for (const item of expired) {
        const attempt = reconcileAttempt.run(
          failure.code,
          failure.message,
          item.attemptId,
          now,
        );
        if (attempt.changes !== 1) continue;
        const node = blockNode.run(
          failure.code,
          failure.message,
          now,
          item.nodeRunId,
          item.runId,
        );
        if (node.changes !== 1) {
          throw new PipelineRuntimeError(
            "LEASE_CONFLICT",
            `Expired Node Attempt ${item.attemptId} lost its Node Run ownership.`,
          );
        }
        releaseExecutionLease.run(now, item.attemptId, now);
        appendExecutionEvent({
          type: "execution.lease.lost",
          runId: item.runId,
          nodeRunId: item.nodeRunId,
          attemptId: item.attemptId,
          payload: {
            operationKey: item.operationKey ?? `node-attempt:${item.attemptId}`,
            status: "lease-lost",
            failureCode: failure.code,
          },
          createdAt: now,
        });
        appendRuntimeMutation({
          action: "attempt.lease-expire",
          entityType: "node-attempt",
          entityId: item.attemptId,
          eventType: "attempt.reconciling",
          runId: item.runId,
          nodeRunId: item.nodeRunId,
          before: { status: "running" },
          after: { status: "reconciling", recoverable: true, failure },
          createdAt: now,
        });
        recovered += 1;
        affectedRunIds.add(item.runId);
      }
      const blockRun = database.prepare(
        `UPDATE department_runs
            SET status = 'blocked', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'recovering')`,
      );
      for (const runId of affectedRunIds) {
        if (blockRun.run(now, runId).changes !== 1) {
          throw new PipelineRuntimeError(
            "LEASE_CONFLICT",
            `Department Run ${runId} changed before lease expiry recovery completed.`,
          );
        }
      }
      database.exec("COMMIT");
      for (const item of expired)
        activeExecutions.get(item.attemptId)?.controller.abort();
      return recovered;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const registerExecutionArtifacts = (input: {
    readonly payload: Record<string, unknown>;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attemptId: string;
    readonly snapshotRevisionId: string;
    readonly aiMemberId: string | undefined;
  }): string[] => {
    const artifacts = Array.isArray(input.payload.artifacts)
      ? (input.payload.artifacts as Array<Record<string, unknown>>)
      : [];
    if (artifacts.length === 0) return [];
    if (!options.artifactRegistry || !input.aiMemberId) {
      throw new PipelineRuntimeError(
        "ARTIFACT_PRODUCER_INVALID",
        "Execution Artifact facts require complete producer provenance.",
      );
    }
    const run = readRunRow(input.runId);
    const artifactEffectIds: string[] = [];
    for (const artifact of artifacts) {
      if (
        typeof artifact.type !== "string" ||
        typeof artifact.schemaVersion !== "string" ||
        typeof artifact.logicalName !== "string" ||
        typeof artifact.content !== "string"
      ) {
        throw new PipelineRuntimeError(
          "EXECUTION_ADAPTER_PROTOCOL",
          "Execution Artifact payload is invalid.",
        );
      }
      const registered = options.artifactRegistry.registerVersionInTransaction({
        projectId: run.projectId,
        type: artifact.type,
        schemaVersion: artifact.schemaVersion,
        logicalName: artifact.logicalName,
        content: artifact.content,
        status: artifact.status === "draft" ? "draft" : "produced",
        producer: {
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          nodeAttemptId: input.attemptId,
          snapshotRevisionId: input.snapshotRevisionId,
          aiMemberId: input.aiMemberId,
        },
        inputVersionIds: Array.isArray(artifact.inputVersionIds)
          ? artifact.inputVersionIds.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
      });
      artifactEffectIds.push(registered.id);
    }
    return artifactEffectIds;
  };

  const reconcilePendingExecutions = async (): Promise<number> => {
    const candidates = database
      .prepare(
        `SELECT node_attempts.id AS attemptId,
                node_attempts.node_run_id AS nodeRunId,
                node_attempts.execution_operation_key AS operationKey,
                node_runs.run_id AS runId
           FROM node_attempts
           JOIN node_runs ON node_runs.id = node_attempts.node_run_id
           JOIN department_runs ON department_runs.id = node_runs.run_id
          WHERE node_attempts.status = 'reconciling'
            AND node_runs.status = 'blocked'
            AND department_runs.status = 'blocked'
            AND NOT EXISTS (
              SELECT 1 FROM execution_leases
               WHERE target_kind = 'node-attempt'
                 AND target_id = node_attempts.id
                 AND released_at IS NULL
            )
       ORDER BY node_attempts.created_at, node_attempts.id`,
      )
      .all() as Array<{
      readonly attemptId: string;
      readonly nodeRunId: string;
      readonly operationKey: string | null;
      readonly runId: string;
    }>;
    let reconciled = 0;
    for (const candidate of candidates) {
      const operationKey =
        candidate.operationKey ?? `node-attempt:${candidate.attemptId}`;
      const issuedAt = clock();
      const issuedAtIso = issuedAt.toISOString();
      const leaseId = randomUUID();
      const executionEpoch =
        Number(
          (
            database
              .prepare(
                `SELECT COALESCE(MAX(execution_epoch), 0) AS executionEpoch
                   FROM execution_leases
                  WHERE operation_key = ?`,
              )
              .get(operationKey) as { readonly executionEpoch: number }
          ).executionEpoch,
        ) + 1;
      const fenceToken = randomUUID();
      const expiresAt = new Date(issuedAt.getTime() + 60_000).toISOString();
      const target = {
        kind: "node-attempt" as const,
        id: candidate.attemptId,
      };
      const lease: ExecutionLeaseContext & {
        readonly target: typeof target;
        readonly leaseKind: "reconciliation";
      } = {
        leaseId,
        leaseKind: "reconciliation",
        operationKey,
        target,
        executionEpoch,
        fenceToken,
      };

      database.exec("BEGIN IMMEDIATE");
      try {
        const claimed = database
          .prepare(
            `UPDATE node_attempts
                SET lease_id = ?, lease_owner = 'reconciliation-worker',
                    lease_expires_at = ?, execution_operation_key = ?
              WHERE id = ? AND status = 'reconciling'
                AND NOT EXISTS (
                  SELECT 1 FROM execution_leases
                   WHERE target_kind = 'node-attempt' AND target_id = ?
                     AND released_at IS NULL
                )`,
          )
          .run(
            leaseId,
            expiresAt,
            operationKey,
            candidate.attemptId,
            candidate.attemptId,
          );
        if (claimed.changes !== 1) {
          database.exec("COMMIT");
          continue;
        }
        database
          .prepare(
            `INSERT INTO execution_leases(
               id, target_kind, target_id, lease_kind, operation_key,
               execution_epoch, fence_token, worker_id, issued_at, expires_at,
               renewed_at, released_at, cancel_requested
             ) VALUES (?, 'node-attempt', ?, 'reconciliation', ?, ?, ?,
                       'reconciliation-worker', ?, ?, NULL, NULL, 0)`,
          )
          .run(
            leaseId,
            candidate.attemptId,
            operationKey,
            executionEpoch,
            fenceToken,
            issuedAtIso,
            expiresAt,
          );
        appendExecutionEvent({
          type: "execution.leased",
          runId: candidate.runId,
          nodeRunId: candidate.nodeRunId,
          attemptId: candidate.attemptId,
          payload: {
            operationKey,
            status: "leased",
            leaseId,
            leaseKind: "reconciliation",
            executionEpoch,
          },
          createdAt: issuedAtIso,
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const factSink = createExecutionFactSink({
        database,
        lease,
        target,
        runId: candidate.runId,
        nodeRunId: candidate.nodeRunId,
        attemptId: candidate.attemptId,
        now: clock,
        appendEvent: (event) =>
          appendExecutionEvent({
            ...event,
            runId: candidate.runId,
            nodeRunId: candidate.nodeRunId,
            attemptId: candidate.attemptId,
            payload: event.payload,
            createdAt: event.timestamp,
          }),
        applyAcceptedFact: ({ fact, envelope, now }) => {
          if (
            fact.kind !== "not-started" &&
            fact.kind !== "completed" &&
            fact.kind !== "failed" &&
            fact.kind !== "cancelled"
          ) {
            return [];
          }
          const attemptStatus =
            fact.kind === "not-started"
              ? "interrupted"
              : fact.kind === "completed"
                ? "succeeded"
                : fact.kind === "cancelled"
                  ? "cancelled"
                  : "failed";
          const nodeStatus =
            attemptStatus === "succeeded"
              ? "succeeded"
              : attemptStatus === "interrupted"
                ? "blocked"
                : attemptStatus;
          const runStatus =
            attemptStatus === "succeeded"
              ? "running"
              : attemptStatus === "interrupted"
                ? "blocked"
                : attemptStatus;
          const payload =
            typeof fact.payload === "object" &&
            fact.payload !== null &&
            !Array.isArray(fact.payload)
              ? (fact.payload as Record<string, unknown>)
              : {};
          const failureCode =
            attemptStatus === "succeeded"
              ? null
              : typeof payload.code === "string"
                ? payload.code
                : fact.kind === "not-started"
                  ? "EXECUTION_NOT_STARTED"
                  : fact.kind === "cancelled"
                    ? "EXECUTION_CANCELLED"
                    : "EXECUTION_FAILED";
          const failureMessage =
            attemptStatus === "succeeded"
              ? null
              : typeof payload.message === "string"
                ? payload.message
                : fact.kind === "not-started"
                  ? "Provider evidence proves the external execution never started."
                  : fact.kind === "cancelled"
                    ? "Provider evidence proves the execution was cancelled."
                    : "Provider reconciliation reported a failed execution.";
          const result =
            attemptStatus === "succeeded" && "structuredResult" in payload
              ? payload.structuredResult
              : null;
          const reconcilingView = inspectRun(candidate.runId);
          const reconcilingNode = reconcilingView.nodes.find(
            (node) => node.id === candidate.nodeRunId,
          );
          const reconcilingAttempt = reconcilingNode?.attempts.find(
            (attempt) => attempt.id === candidate.attemptId,
          );
          const pipelineNode =
            reconcilingView.snapshot.payload.pipelineVersion.graph.nodes.find(
              (node) => node.id === reconcilingNode?.pipelineNodeId,
            );
          const producer = pipelineNode?.positionId
            ? reconcilingView.snapshot.payload.positions.find(
                (position) => position.id === pipelineNode.positionId,
              )
            : undefined;
          if (!reconcilingNode || !reconcilingAttempt || !pipelineNode) {
            throw new PipelineRuntimeError(
              "NODE_STATE_INVALID",
              `Node Attempt ${candidate.attemptId} cannot be reconstructed for reconciliation.`,
            );
          }
          const updatedAttempt = database
            .prepare(
              `UPDATE node_attempts
                  SET status = ?, structured_result_json = ?, failure_code = ?,
                      failure_message = ?, recoverable = ?, completed_at = ?,
                      terminal_execution_fact_id = ?
                WHERE id = ? AND status = 'reconciling' AND lease_id = ?`,
            )
            .run(
              attemptStatus,
              result === null ? null : JSON.stringify(result),
              failureCode,
              failureMessage,
              attemptStatus === "failed" || attemptStatus === "interrupted"
                ? 1
                : 0,
              now,
              envelope.id,
              candidate.attemptId,
              leaseId,
            );
          const updatedNode = database
            .prepare(
              `UPDATE node_runs
                  SET status = ?, result_json = ?, failure_code = ?,
                      failure_message = ?, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'blocked'`,
            )
            .run(
              nodeStatus,
              result === null ? null : JSON.stringify(result),
              failureCode,
              failureMessage,
              now,
              candidate.nodeRunId,
              candidate.runId,
            );
          const updatedRun = database
            .prepare(
              `UPDATE department_runs
                  SET status = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'blocked'`,
            )
            .run(runStatus, now, candidate.runId);
          if (
            updatedAttempt.changes !== 1 ||
            updatedNode.changes !== 1 ||
            updatedRun.changes !== 1
          ) {
            throw new PipelineRuntimeError(
              "EXECUTION_TERMINAL_CONFLICT",
              `Node Attempt ${candidate.attemptId} cannot accept the reconciliation terminal Fact.`,
            );
          }
          const artifactEffectIds =
            attemptStatus === "succeeded"
              ? registerExecutionArtifacts({
                  payload,
                  runId: candidate.runId,
                  nodeRunId: candidate.nodeRunId,
                  attemptId: candidate.attemptId,
                  snapshotRevisionId: reconcilingAttempt.snapshotRevisionId,
                  aiMemberId: producer?.aiMember.id,
                })
              : [];
          if (attemptStatus === "succeeded") {
            refreshQueuedNodes(candidate.runId, now);
          }
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(now, leaseId);
          appendRuntimeMutation({
            action: `attempt.reconcile.${fact.kind}`,
            entityType: "node-attempt",
            entityId: candidate.attemptId,
            eventType:
              attemptStatus === "succeeded"
                ? "attempt.succeeded"
                : attemptStatus === "interrupted"
                  ? "attempt.interrupted"
                  : attemptStatus === "cancelled"
                    ? "attempt.interrupted"
                    : "attempt.failed",
            runId: candidate.runId,
            nodeRunId: candidate.nodeRunId,
            before: { status: "reconciling" },
            after: {
              status: attemptStatus,
              terminalExecutionFactId: envelope.id,
              failure:
                failureCode === null
                  ? null
                  : { code: failureCode, message: failureMessage },
            },
            createdAt: now,
          });
          appendExecutionEvent({
            type:
              attemptStatus === "succeeded"
                ? "execution.completed"
                : attemptStatus === "interrupted"
                  ? "execution.interrupted"
                  : attemptStatus === "cancelled"
                    ? "execution.cancelled"
                    : "execution.failed",
            runId: candidate.runId,
            nodeRunId: candidate.nodeRunId,
            attemptId: candidate.attemptId,
            payload: {
              operationKey,
              executionFactId: envelope.id,
              status: attemptStatus,
              ...(failureCode ? { failureCode } : {}),
            },
            createdAt: now,
          });
          return artifactEffectIds;
        },
      });

      const reattachRunning = async (
        providerExecutionRef: string,
      ): Promise<boolean> => {
        if (
          executionAdapter.capabilities?.reattachRunningOperation !== true ||
          !executionAdapter.reattach
        ) {
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(clock().toISOString(), leaseId);
          return false;
        }
        const blockedView = inspectRun(candidate.runId);
        const blockedNode = blockedView.nodes.find(
          (node) => node.id === candidate.nodeRunId,
        );
        const blockedAttempt = blockedNode?.attempts.find(
          (attempt) => attempt.id === candidate.attemptId,
        );
        const pipelineNode =
          blockedView.snapshot.payload.pipelineVersion.graph.nodes.find(
            (node) => node.id === blockedNode?.pipelineNodeId,
          );
        if (!blockedNode || !blockedAttempt || !pipelineNode) {
          throw new PipelineRuntimeError(
            "NODE_STATE_INVALID",
            `Node Attempt ${candidate.attemptId} cannot be reconstructed for reattachment.`,
          );
        }
        const profileId =
          pipelineNode.executionProfileId ??
          blockedView.snapshot.payload.department.defaultExecutionProfileId;
        const profile = blockedView.snapshot.payload.executionProfiles.find(
          (entry) => entry.id === profileId,
        );
        if (!profile) {
          throw new PipelineRuntimeError(
            "RUN_SNAPSHOT_INVALID",
            `Node Attempt ${candidate.attemptId} has no frozen Execution Profile.`,
          );
        }
        const reattachNow = clock();
        const reattachNowIso = reattachNow.toISOString();
        const executionLeaseId = randomUUID();
        const executionFenceToken = randomUUID();
        const reattachEpoch = executionEpoch + 1;
        const executionExpiresAt = new Date(
          reattachNow.getTime() + profile.limits.timeoutSeconds * 1_000,
        ).toISOString();
        const executionLease: ExecutionLeaseContext & {
          readonly target: typeof target;
          readonly leaseKind: "execution";
        } = {
          leaseId: executionLeaseId,
          leaseKind: "execution",
          operationKey,
          target,
          executionEpoch: reattachEpoch,
          fenceToken: executionFenceToken,
        };
        database.exec("BEGIN IMMEDIATE");
        try {
          const released = database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(reattachNowIso, leaseId);
          const resumedAttempt = database
            .prepare(
              `UPDATE node_attempts
                  SET status = 'running', lease_id = ?,
                      lease_owner = 'reattach-worker', lease_expires_at = ?,
                      provider_execution_ref = ?, failure_code = NULL,
                      failure_message = NULL
                WHERE id = ? AND status = 'reconciling' AND lease_id = ?`,
            )
            .run(
              executionLeaseId,
              executionExpiresAt,
              providerExecutionRef,
              candidate.attemptId,
              leaseId,
            );
          const resumedNode = database
            .prepare(
              `UPDATE node_runs
                  SET status = 'running', failure_code = NULL,
                      failure_message = NULL, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'blocked'`,
            )
            .run(reattachNowIso, candidate.nodeRunId, candidate.runId);
          const resumedRun = database
            .prepare(
              `UPDATE department_runs
                  SET status = 'running', revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'blocked'`,
            )
            .run(reattachNowIso, candidate.runId);
          if (
            released.changes !== 1 ||
            resumedAttempt.changes !== 1 ||
            resumedNode.changes !== 1 ||
            resumedRun.changes !== 1
          ) {
            throw new PipelineRuntimeError(
              "LEASE_CONFLICT",
              `Node Attempt ${candidate.attemptId} changed before reattachment.`,
            );
          }
          database
            .prepare(
              `INSERT INTO execution_leases(
                 id, target_kind, target_id, lease_kind, operation_key,
                 execution_epoch, fence_token, worker_id, issued_at, expires_at,
                 renewed_at, released_at, cancel_requested
               ) VALUES (?, 'node-attempt', ?, 'execution', ?, ?, ?,
                         'reattach-worker', ?, ?, NULL, NULL, 0)`,
            )
            .run(
              executionLeaseId,
              candidate.attemptId,
              operationKey,
              reattachEpoch,
              executionFenceToken,
              reattachNowIso,
              executionExpiresAt,
            );
          appendExecutionEvent({
            type: "execution.reattached",
            runId: candidate.runId,
            nodeRunId: candidate.nodeRunId,
            attemptId: candidate.attemptId,
            payload: {
              operationKey,
              status: "reattached",
              providerExecutionRef,
              leaseId: executionLeaseId,
              leaseKind: "execution",
              executionEpoch: reattachEpoch,
            },
            createdAt: reattachNowIso,
          });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }

        const request: ExecutionRequest = {
          operationKey,
          target,
          lease: executionLease,
          agentAdapterId: profile.providerRef,
          permissionScope: profile.permissionPolicy,
          sideEffectPolicy: "formal",
          completionSignal: "execution-fact",
          timeoutSeconds: profile.limits.timeoutSeconds,
          immutableContext: {
            runId: candidate.runId,
            nodeRunId: candidate.nodeRunId,
            nodeAttemptId: candidate.attemptId,
            snapshotRevisionId: blockedAttempt.snapshotRevisionId,
            handlerKindId: blockedNode.handler?.handlerKindId ?? "unknown",
          },
        };
        const previousAttempts = blockedNode.attempts.filter(
          (attempt) => attempt.attemptNumber < blockedAttempt.attemptNumber,
        );
        const previousSucceeded = [...previousAttempts]
          .reverse()
          .find((attempt) => attempt.status === "succeeded");
        const previousFailed = [...previousAttempts]
          .reverse()
          .find((attempt) => attempt.status === "failed");
        const controller = new AbortController();
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        activeExecutions.set(candidate.attemptId, {
          attemptId: candidate.attemptId,
          runId: candidate.runId,
          controller,
          done,
        });
        const reattachSink = createExecutionFactSink({
          database,
          lease: executionLease,
          target,
          runId: candidate.runId,
          nodeRunId: candidate.nodeRunId,
          attemptId: candidate.attemptId,
          now: clock,
          appendEvent: (event) =>
            appendExecutionEvent({
              ...event,
              runId: candidate.runId,
              nodeRunId: candidate.nodeRunId,
              attemptId: candidate.attemptId,
              payload: event.payload,
              createdAt: event.timestamp,
            }),
          applyAcceptedFact: ({ fact, envelope, now }) => {
            if (!["completed", "failed", "cancelled"].includes(fact.kind)) {
              return [];
            }
            const payload =
              typeof fact.payload === "object" &&
              fact.payload !== null &&
              !Array.isArray(fact.payload)
                ? (fact.payload as Record<string, unknown>)
                : {};
            const succeeded = fact.kind === "completed";
            const terminalStatus = succeeded
              ? "succeeded"
              : fact.kind === "cancelled"
                ? "cancelled"
                : "failed";
            const structuredResult = succeeded
              ? (payload.structuredResult ?? null)
              : null;
            const failureCode = succeeded
              ? null
              : typeof payload.code === "string"
                ? payload.code
                : fact.kind === "cancelled"
                  ? "EXECUTION_CANCELLED"
                  : "EXECUTION_FAILED";
            const failureMessage = succeeded
              ? null
              : typeof payload.message === "string"
                ? payload.message
                : fact.kind === "cancelled"
                  ? "Execution was cancelled after reattachment."
                  : "Execution failed after reattachment.";
            const attemptUpdate = database
              .prepare(
                `UPDATE node_attempts
                    SET status = ?, structured_result_json = ?,
                        failure_code = ?, failure_message = ?, recoverable = ?,
                        completed_at = ?, terminal_execution_fact_id = ?
                  WHERE id = ? AND status = 'running' AND lease_id = ?`,
              )
              .run(
                terminalStatus,
                structuredResult === null
                  ? null
                  : JSON.stringify(structuredResult),
                failureCode,
                failureMessage,
                terminalStatus === "failed" ? 1 : 0,
                now,
                envelope.id,
                candidate.attemptId,
                executionLeaseId,
              );
            const nodeUpdate = database
              .prepare(
                `UPDATE node_runs
                    SET status = ?, result_json = ?, failure_code = ?,
                        failure_message = ?, updated_at = ?
                  WHERE id = ? AND run_id = ? AND status = 'running'`,
              )
              .run(
                terminalStatus,
                structuredResult === null
                  ? null
                  : JSON.stringify(structuredResult),
                failureCode,
                failureMessage,
                now,
                candidate.nodeRunId,
                candidate.runId,
              );
            const runUpdate = database
              .prepare(
                `UPDATE department_runs
                    SET status = ?, revision = revision + 1, updated_at = ?
                  WHERE id = ? AND status = 'running'`,
              )
              .run(
                succeeded ? "running" : terminalStatus,
                now,
                candidate.runId,
              );
            if (
              attemptUpdate.changes !== 1 ||
              nodeUpdate.changes !== 1 ||
              runUpdate.changes !== 1
            ) {
              throw new PipelineRuntimeError(
                "EXECUTION_TERMINAL_CONFLICT",
                `Reattached Node Attempt ${candidate.attemptId} cannot accept another terminal Fact.`,
              );
            }
            const artifactEffectIds = succeeded
              ? registerExecutionArtifacts({
                  payload,
                  runId: candidate.runId,
                  nodeRunId: candidate.nodeRunId,
                  attemptId: candidate.attemptId,
                  snapshotRevisionId: blockedAttempt.snapshotRevisionId,
                  aiMemberId: pipelineNode.positionId
                    ? blockedView.snapshot.payload.positions.find(
                        (position) => position.id === pipelineNode.positionId,
                      )?.aiMember.id
                    : undefined,
                })
              : [];
            if (succeeded) refreshQueuedNodes(candidate.runId, now);
            database
              .prepare(
                "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
              )
              .run(now, executionLeaseId);
            appendRuntimeMutation({
              action: succeeded ? "attempt.complete" : "attempt.fail",
              entityType: "node-attempt",
              entityId: candidate.attemptId,
              eventType: succeeded ? "attempt.succeeded" : "attempt.failed",
              runId: candidate.runId,
              nodeRunId: candidate.nodeRunId,
              before: { status: "running" },
              after: {
                status: terminalStatus,
                ...(failureCode ? { failureCode } : {}),
              },
              createdAt: now,
            });
            appendExecutionEvent({
              type: succeeded
                ? "execution.completed"
                : fact.kind === "cancelled"
                  ? "execution.cancelled"
                  : "execution.failed",
              runId: candidate.runId,
              nodeRunId: candidate.nodeRunId,
              attemptId: candidate.attemptId,
              payload: {
                operationKey,
                executionFactId: envelope.id,
                status: terminalStatus,
                ...(failureCode ? { failureCode } : {}),
              },
              createdAt: now,
            });
            return artifactEffectIds;
          },
        });
        try {
          const completion = await executionAdapter.reattach(
            {
              runId: candidate.runId,
              nodeRunId: candidate.nodeRunId,
              signal: controller.signal,
              node: pipelineNode,
              snapshot: blockedView.snapshot.payload,
              memoryEntries: resolveMemoryEntries(
                blockedView.snapshot.payload,
                pipelineNode,
              ),
              attempt: {
                id: blockedAttempt.id,
                attemptNumber: blockedAttempt.attemptNumber,
                snapshotRevisionId: blockedAttempt.snapshotRevisionId,
                reason: blockedAttempt.reason,
                feedback: blockedAttempt.feedback.map((entry) => ({
                  id: entry.id,
                  kind: entry.kind,
                  content: entry.content,
                })),
                previousResult: previousSucceeded?.result ?? null,
                previousFailure: previousFailed?.failure ?? null,
              },
              request,
            },
            providerExecutionRef,
            reattachSink,
            controller.signal,
          );
          const accepted = database
            .prepare(
              `SELECT kind FROM execution_facts
                WHERE id = ? AND operation_key = ? AND lease_id = ?
                  AND execution_epoch = ? AND status = 'accepted'`,
            )
            .get(
              completion.terminalExecutionFactId,
              operationKey,
              executionLeaseId,
              reattachEpoch,
            ) as { readonly kind: string } | undefined;
          const expectedKind =
            completion.status === "succeeded" ? "completed" : completion.status;
          if (!accepted || accepted.kind !== expectedKind) {
            throw new PipelineRuntimeError(
              "EXECUTION_ADAPTER_PROTOCOL",
              `Reattachment for ${operationKey} did not reference its accepted ${expectedKind} Fact.`,
            );
          }
          return true;
        } finally {
          activeExecutions.delete(candidate.attemptId);
          resolveDone();
        }
      };

      try {
        if (!executionAdapter.reconcile) {
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(clock().toISOString(), leaseId);
          continue;
        }
        const result = await executionAdapter.reconcile(
          { operationKey, reconciliationLease: lease },
          factSink,
        );
        if (result.status === "running") {
          await reattachRunning(result.providerExecutionRef);
        } else if (result.status === "unknown") {
          database
            .prepare(
              "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
            )
            .run(clock().toISOString(), leaseId);
        } else {
          const accepted = database
            .prepare(
              `SELECT kind, evidence_refs_json AS evidenceRefsJson
                 FROM execution_facts
                WHERE id = ? AND operation_key = ? AND lease_id = ?
                  AND execution_epoch = ? AND status = 'accepted'`,
            )
            .get(
              result.terminalExecutionFactId,
              operationKey,
              leaseId,
              executionEpoch,
            ) as
            | { readonly kind: string; readonly evidenceRefsJson: string }
            | undefined;
          const expectedKind =
            result.status === "not-started"
              ? "not-started"
              : result.status === "succeeded"
                ? "completed"
                : result.status;
          if (!accepted || accepted.kind !== expectedKind) {
            throw new PipelineRuntimeError(
              "EXECUTION_ADAPTER_PROTOCOL",
              `Reconciliation for ${operationKey} did not reference its accepted ${expectedKind} Fact.`,
            );
          }
          if (
            result.status === "not-started" &&
            (result.evidenceRefs.length === 0 ||
              (JSON.parse(accepted.evidenceRefsJson) as string[]).length === 0)
          ) {
            throw new PipelineRuntimeError(
              "EXECUTION_ADAPTER_PROTOCOL",
              `Reconciliation for ${operationKey} returned not-started without Provider evidence.`,
            );
          }
        }
        reconciled += 1;
      } catch (error) {
        database
          .prepare(
            "UPDATE execution_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
          )
          .run(clock().toISOString(), leaseId);
        if (
          error instanceof PipelineRuntimeError ||
          error instanceof ExecutionFactError ||
          error instanceof Error
        ) {
          reconciled += 1;
          continue;
        }
        throw error;
      }
    }
    return reconciled;
  };

  const prepareForShutdown = async (): Promise<void> => {
    const active = [...activeExecutions.values()];
    for (const execution of active) execution.controller.abort();
    await Promise.all(active.map((execution) => execution.done));
    const now = clock().toISOString();
    const running = database
      .prepare(
        `SELECT node_attempts.id AS attemptId,
                node_attempts.node_run_id AS nodeRunId,
                node_runs.run_id AS runId,
                node_attempts.execution_operation_key AS operationKey
           FROM node_attempts
           JOIN node_runs ON node_runs.id = node_attempts.node_run_id
          WHERE node_attempts.status = 'running'
            AND node_runs.status = 'running'`,
      )
      .all() as Array<{
      readonly attemptId: string;
      readonly nodeRunId: string;
      readonly runId: string;
      readonly operationKey: string | null;
    }>;
    if (running.length === 0) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      const affectedRuns = new Set<string>();
      for (const item of running) {
        const attempt = database
          .prepare(
            `UPDATE node_attempts
                SET status = 'reconciling', recoverable = 1,
                    failure_code = 'RUNTIME_SHUTDOWN',
                    failure_message = 'Runtime drained before the external execution reached a proven terminal state.',
                    completed_at = NULL
              WHERE id = ? AND status = 'running'`,
          )
          .run(item.attemptId);
        if (attempt.changes !== 1) continue;
        database
          .prepare(
            `UPDATE node_runs
                SET status = 'blocked', failure_code = 'RUNTIME_SHUTDOWN',
                    failure_message = 'Runtime drained with execution reconciliation required.',
                    updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(now, item.nodeRunId);
        database
          .prepare(
            `UPDATE execution_leases SET released_at = ?
              WHERE target_kind = 'node-attempt' AND target_id = ?
                AND released_at IS NULL`,
          )
          .run(now, item.attemptId);
        appendRuntimeMutation({
          action: "attempt.runtime-shutdown",
          entityType: "node-attempt",
          entityId: item.attemptId,
          eventType: "attempt.reconciling",
          runId: item.runId,
          nodeRunId: item.nodeRunId,
          before: { status: "running" },
          after: {
            status: "reconciling",
            operationKey: item.operationKey ?? `node-attempt:${item.attemptId}`,
            failureCode: "RUNTIME_SHUTDOWN",
          },
          createdAt: now,
        });
        affectedRuns.add(item.runId);
      }
      for (const runId of affectedRuns) {
        database
          .prepare(
            `UPDATE department_runs
                SET status = 'blocked', revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(now, runId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const recoverExpiredApprovals = (): number => {
    const now = clock().toISOString();
    const expired = database
      .prepare(
        `SELECT approvals.id, approvals.run_id AS runId,
                approvals.node_run_id AS nodeRunId
           FROM approvals
           JOIN node_runs ON node_runs.id = approvals.node_run_id
           JOIN department_runs ON department_runs.id = approvals.run_id
          WHERE approvals.status = 'pending'
            AND approvals.expires_at IS NOT NULL
            AND approvals.expires_at <= ?
            AND node_runs.status = 'waiting-approval'
            AND department_runs.status = 'waiting-approval'
       ORDER BY approvals.expires_at, approvals.id`,
      )
      .all(now) as Array<{
      readonly id: string;
      readonly runId: string;
      readonly nodeRunId: string;
    }>;
    if (expired.length === 0) return 0;

    database.exec("BEGIN IMMEDIATE");
    try {
      const expireRequest = database.prepare(
        `UPDATE approvals
            SET status = 'expired', expired_at = ?
          WHERE id = ? AND status = 'pending'
            AND expires_at IS NOT NULL AND expires_at <= ?`,
      );
      const failNode = database.prepare(
        `UPDATE node_runs
            SET status = 'failed', failure_code = 'APPROVAL_EXPIRED',
                failure_message = 'The Human Approval request expired.',
                updated_at = ?
          WHERE id = ? AND run_id = ? AND status = 'waiting-approval'`,
      );
      const blockRun = database.prepare(
        `UPDATE department_runs
            SET status = 'blocked', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'waiting-approval'`,
      );
      let recovered = 0;
      for (const request of expired) {
        if (
          expireRequest.run(now, request.id, now).changes !== 1 ||
          failNode.run(now, request.nodeRunId, request.runId).changes !== 1 ||
          blockRun.run(now, request.runId).changes !== 1
        ) {
          throw new PipelineRuntimeError(
            "APPROVAL_STATE_INVALID",
            `Approval ${request.id} changed before expiry recovery completed.`,
          );
        }
        appendRuntimeMutation({
          action: "approval.expire",
          entityType: "approval",
          entityId: request.id,
          eventType: "approval.expired",
          runId: request.runId,
          nodeRunId: request.nodeRunId,
          before: { status: "pending" },
          after: { status: "expired", failureCode: "APPROVAL_EXPIRED" },
          createdAt: now,
        });
        recovered += 1;
      }
      database.exec("COMMIT");
      return recovered;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const refreshQueuedNodes = (runId: string, now: string): void => {
    const nodes = database
      .prepare(
        `SELECT id, pipeline_node_id AS pipelineNodeId, status,
                required_dependency_ids_json AS requiredDependencyIdsJson
           FROM node_runs
          WHERE run_id = ?`,
      )
      .all(runId) as Array<{
      readonly id: string;
      readonly pipelineNodeId: string;
      readonly status: string;
      readonly requiredDependencyIdsJson: string;
    }>;
    const statusByPipelineNodeId = new Map(
      nodes.map((node) => [node.pipelineNodeId, node.status]),
    );
    const makeReady = database.prepare(
      `UPDATE node_runs SET status = 'ready', updated_at = ?
        WHERE id = ? AND run_id = ? AND status = 'queued'`,
    );
    for (const node of nodes) {
      if (node.status !== "queued") continue;
      const dependencyIds = parseJson(
        node.requiredDependencyIdsJson,
        `Node Run ${node.id} dependencies`,
      );
      if (
        Array.isArray(dependencyIds) &&
        dependencyIds.every(
          (dependencyId) =>
            typeof dependencyId === "string" &&
            ["succeeded", "skipped"].includes(
              statusByPipelineNodeId.get(dependencyId) ?? "",
            ),
        )
      ) {
        makeReady.run(now, node.id, runId);
      }
    }
  };

  const approvalRequestDetails = (
    runId: string,
    nodeRunId: string,
    createdAt: string,
  ) => {
    const view = inspectRun(runId);
    const nodeRun = view.nodes.find((node) => node.id === nodeRunId);
    const node = nodeRun
      ? view.snapshot.payload.pipelineVersion.graph.nodes.find(
          (candidate) => candidate.id === nodeRun.pipelineNodeId,
        )
      : undefined;
    if (!nodeRun || node?.type !== "human-approval") {
      throw new PipelineRuntimeError(
        "APPROVAL_STATE_INVALID",
        `Node Run ${nodeRunId} is not a Human Approval Node.`,
      );
    }
    const dependencyManifest = nodeRun.requiredDependencyIds.map(
      (pipelineNodeId) => {
        const dependency = view.nodes.find(
          (candidate) => candidate.pipelineNodeId === pipelineNodeId,
        );
        return {
          pipelineNodeId,
          status: dependency?.status ?? "missing",
          result: dependency?.result ?? null,
        };
      },
    );
    const inputManifestHash = pipelineHash({
      runId,
      nodeRunId,
      snapshotRevisionId: view.snapshot.id,
      dependencies: dependencyManifest,
    });
    const eligibleHumanPolicy = {
      policy: node.approvalPolicy ?? "any",
      approverReference: node.approverReference ?? null,
    };
    const expiresAt = new Date(
      new Date(createdAt).getTime() +
        (node.approvalExpiresAfterSeconds ?? 86_400) * 1_000,
    ).toISOString();
    return {
      snapshotRevisionId: view.snapshot.id,
      requestedAction: node.approvalTitle ?? node.name,
      inputManifestHash,
      eligibleHumanPolicy,
      expiresAt,
    };
  };

  const insertApprovalRequest = (input: {
    readonly id: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly cycle: number;
    readonly createdAt: string;
  }): void => {
    const details = approvalRequestDetails(
      input.runId,
      input.nodeRunId,
      input.createdAt,
    );
    database
      .prepare(
        `INSERT INTO approvals(
           id, run_id, node_run_id, cycle, snapshot_revision_id, status,
           decision, requested_action, input_manifest_hash,
           eligible_human_policy_json, expires_at, created_at, decided_at,
           expired_at, decision_actor_type, decision_actor_id,
           decision_actor_authenticated_by, decision_command_id, decision_hash
         ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        input.id,
        input.runId,
        input.nodeRunId,
        input.cycle,
        details.snapshotRevisionId,
        details.requestedAction,
        details.inputManifestHash,
        JSON.stringify(details.eligibleHumanPolicy),
        details.expiresAt,
        input.createdAt,
      );
  };

  const mutateNode = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedNodeStatus: "ready" | "running" | "waiting-approval";
    readonly nextNodeStatus:
      | "running"
      | "succeeded"
      | "failed"
      | "waiting-approval";
    readonly nextRunStatus:
      | "running"
      | "completed"
      | "failed"
      | "waiting-approval";
    readonly incrementAttempt?: boolean;
    readonly completeAttempt?: boolean;
    readonly approvalDecision?: "approve" | "reject";
    readonly approvalActor?: ActorRef;
    readonly approvalCommandId?: string;
    readonly approvalDecisionHash?: string;
    readonly result?: unknown;
    readonly failure?: { readonly code: string; readonly message: string };
  }): void => {
    const now = clock().toISOString();
    let createdApprovalId: string | undefined;
    database.exec("BEGIN IMMEDIATE");
    try {
      const readyAttempt = input.incrementAttempt
        ? (database
            .prepare(
              `SELECT id
                 FROM node_attempts
                WHERE node_run_id = ? AND status = 'ready'
                ORDER BY attempt_number DESC
                LIMIT 1`,
            )
            .get(input.nodeRunId) as { readonly id: string } | undefined)
        : undefined;
      const result = database
        .prepare(
          `UPDATE node_runs
              SET status = ?,
                  attempt_count = attempt_count + ?,
                  result_json = ?,
                  failure_code = ?,
                  failure_message = ?,
                  updated_at = ?
            WHERE id = ? AND run_id = ? AND status = ?`,
        )
        .run(
          input.nextNodeStatus,
          input.incrementAttempt && !readyAttempt ? 1 : 0,
          input.result === undefined ? null : JSON.stringify(input.result),
          input.failure?.code ?? null,
          input.failure?.message ?? null,
          now,
          input.nodeRunId,
          input.runId,
          input.expectedNodeStatus,
        );
      if (result.changes === 0) {
        throw new PipelineRuntimeError(
          "NODE_STATE_INVALID",
          `Node Run ${input.nodeRunId} cannot transition from ${input.expectedNodeStatus} to ${input.nextNodeStatus}.`,
        );
      }
      if (input.incrementAttempt) {
        if (readyAttempt) {
          database
            .prepare(
              `UPDATE node_attempts SET status = 'running', started_at = ?
                WHERE id = ? AND node_run_id = ? AND status = 'ready'`,
            )
            .run(now, readyAttempt.id, input.nodeRunId);
        } else {
          const attempt = database
            .prepare(
              `SELECT node_runs.attempt_count AS attemptNumber,
                      department_runs.snapshot_revision_id AS snapshotRevisionId
                 FROM node_runs
                 JOIN department_runs ON department_runs.id = node_runs.run_id
                WHERE node_runs.id = ? AND node_runs.run_id = ?`,
            )
            .get(input.nodeRunId, input.runId) as
            | {
                readonly attemptNumber: number;
                readonly snapshotRevisionId: string | null;
              }
            | undefined;
          if (!attempt?.snapshotRevisionId) {
            throw new PipelineRuntimeError(
              "RUN_SNAPSHOT_INVALID",
              `Node Run ${input.nodeRunId} has no active Snapshot Revision.`,
            );
          }
          database
            .prepare(
              `INSERT INTO node_attempts(
                 id, node_run_id, attempt_number, snapshot_revision_id, reason,
                 status, structured_result_json, failure_code, failure_message,
                 created_at, started_at, completed_at
               ) VALUES (?, ?, ?, ?, 'initial', 'running', NULL, NULL, NULL, ?, ?, NULL)`,
            )
            .run(
              randomUUID(),
              input.nodeRunId,
              Number(attempt.attemptNumber),
              attempt.snapshotRevisionId,
              now,
              now,
            );
        }
      }
      if (input.completeAttempt) {
        const completedAttempt = database
          .prepare(
            `UPDATE node_attempts
                SET status = ?, structured_result_json = ?, failure_code = ?,
                    failure_message = ?, completed_at = ?
              WHERE id = (
                SELECT id FROM node_attempts
                 WHERE node_run_id = ? AND status = 'running'
                 ORDER BY attempt_number DESC
                 LIMIT 1
              )`,
          )
          .run(
            input.nextNodeStatus,
            input.result === undefined ? null : JSON.stringify(input.result),
            input.failure?.code ?? null,
            input.failure?.message ?? null,
            now,
            input.nodeRunId,
          );
        if (completedAttempt.changes === 0) {
          throw new PipelineRuntimeError(
            "NODE_STATE_INVALID",
            `Node Run ${input.nodeRunId} has no Running Node Attempt.`,
          );
        }
      }
      if (input.nextNodeStatus === "succeeded") {
        refreshQueuedNodes(input.runId, now);
      }
      if (input.nextNodeStatus === "waiting-approval") {
        const cycle = database
          .prepare(
            `SELECT COALESCE(MAX(cycle), 0) + 1 AS nextCycle
               FROM approvals
              WHERE node_run_id = ?`,
          )
          .get(input.nodeRunId) as { readonly nextCycle: number };
        createdApprovalId = randomUUID();
        insertApprovalRequest({
          id: createdApprovalId,
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          cycle: Number(cycle.nextCycle),
          createdAt: now,
        });
      }
      if (input.approvalDecision) {
        const decided = database
          .prepare(
            `UPDATE approvals
                SET status = 'decided', decision = ?, decided_at = ?,
                    decision_actor_type = ?, decision_actor_id = ?,
                    decision_actor_authenticated_by = ?,
                    decision_command_id = ?, decision_hash = ?
              WHERE id = (
                SELECT id FROM approvals
                 WHERE node_run_id = ? AND status = 'pending'
                 ORDER BY cycle DESC
                 LIMIT 1
              ) AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .run(
            input.approvalDecision,
            now,
            input.approvalActor?.type ?? null,
            input.approvalActor?.id ?? null,
            input.approvalActor?.authenticatedBy ?? null,
            input.approvalCommandId ?? null,
            input.approvalDecisionHash ?? null,
            input.nodeRunId,
            now,
          );
        if (decided.changes === 0) {
          throw new PipelineRuntimeError(
            "APPROVAL_STATE_INVALID",
            `Node Run ${input.nodeRunId} has no pending Approval.`,
          );
        }
      }
      if (input.nextNodeStatus === "failed") {
        const failedNode = database
          .prepare(
            `SELECT pipeline_node_id AS pipelineNodeId
               FROM node_runs
              WHERE id = ? AND run_id = ?`,
          )
          .get(input.nodeRunId, input.runId) as
          | { readonly pipelineNodeId: string }
          | undefined;
        const joins = database
          .prepare(
            `SELECT id, required_dependency_ids_json AS requiredDependencyIdsJson
               FROM node_runs
              WHERE run_id = ? AND node_type = 'join'
                AND status IN ('queued', 'ready')`,
          )
          .all(input.runId) as Array<{
          readonly id: string;
          readonly requiredDependencyIdsJson: string;
        }>;
        const failJoin = database.prepare(
          `UPDATE node_runs
              SET status = 'failed', failure_code = 'JOIN_DEPENDENCY_FAILED',
                  failure_message = ?, updated_at = ?
            WHERE id = ? AND run_id = ? AND status IN ('queued', 'ready')`,
        );
        for (const join of joins) {
          const dependencies = parseJson(
            join.requiredDependencyIdsJson,
            `Join Node Run ${join.id} dependencies`,
          );
          if (
            failedNode &&
            Array.isArray(dependencies) &&
            dependencies.includes(failedNode.pipelineNodeId)
          ) {
            failJoin.run(
              `Join dependency ${failedNode.pipelineNodeId} failed.`,
              now,
              join.id,
              input.runId,
            );
          }
        }
      }
      database
        .prepare(
          `UPDATE department_runs
              SET status = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.nextRunStatus, now, input.runId);
      appendRuntimeMutation({
        action: input.approvalDecision ? "approval.decide" : "node.transition",
        entityType: input.approvalDecision ? "approval" : "node-run",
        entityId: input.nodeRunId,
        eventType: input.approvalDecision
          ? "approval.decided"
          : "node.status.changed",
        additionalEventType: input.approvalDecision
          ? undefined
          : input.nextNodeStatus === "running"
            ? "node.started"
            : input.nextNodeStatus === "waiting-approval"
              ? "node.waiting-approval"
              : input.nextNodeStatus === "succeeded"
                ? "node.succeeded"
                : input.nextNodeStatus === "failed"
                  ? "node.failed"
                  : undefined,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: { status: input.expectedNodeStatus },
        after: {
          status: input.nextNodeStatus,
          runStatus: input.nextRunStatus,
          ...(input.approvalDecision
            ? { decision: input.approvalDecision }
            : {}),
        },
        createdAt: now,
      });
      if (createdApprovalId) {
        appendRuntimeMutation({
          action: "approval.request",
          entityType: "approval",
          entityId: createdApprovalId,
          eventType: "approval.requested",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          after: { status: "pending", approvalId: createdApprovalId },
          createdAt: now,
        });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const failCondition = (
    runId: string,
    nodeRunId: string,
    code: string,
    message: string,
  ): never => {
    mutateNode({
      runId,
      nodeRunId,
      expectedNodeStatus: "ready",
      nextNodeStatus: "failed",
      nextRunStatus: "failed",
      failure: { code, message },
    });
    throw new PipelineRuntimeError(code, message);
  };

  const executeCondition = (
    view: DepartmentRunView,
    nodeRunId: string,
    node: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number],
  ): void => {
    const configuration = node.condition;
    if (!configuration) {
      return failCondition(
        view.run.id,
        nodeRunId,
        "CONDITION_CONFIGURATION_INVALID",
        `Condition ${node.id} has no declarative configuration.`,
      );
    }

    const graph = view.snapshot.payload.pipelineVersion.graph;
    const upstream = new Set<string>();
    const pending = [node.id];
    while (pending.length > 0) {
      const target = pending.shift();
      if (!target) continue;
      for (const edge of graph.edges.filter(
        (candidate) => candidate.to === target,
      )) {
        if (upstream.has(edge.from)) continue;
        upstream.add(edge.from);
        pending.push(edge.from);
      }
    }

    const resolvePath = (
      root: unknown,
      path: readonly string[],
    ): { readonly found: boolean; readonly value?: unknown } => {
      let current = root;
      for (const segment of path) {
        if (!isRecord(current) || !Object.hasOwn(current, segment)) {
          return { found: false };
        }
        current = current[segment];
      }
      return { found: true, value: current };
    };

    let resolved: { readonly found: boolean; readonly value?: unknown } = {
      found: false,
    };
    const snapshotMatch = configuration.leftReference.match(
      /^snapshot\.([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/,
    );
    const nodeMatch = configuration.leftReference.match(
      /^nodes\.([A-Za-z0-9_-]+)\.result\.([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/,
    );
    if (snapshotMatch) {
      resolved = resolvePath(
        view.snapshot.payload,
        snapshotMatch[1]!.split("."),
      );
    } else if (nodeMatch) {
      const referencedNodeId = nodeMatch[1]!;
      if (!upstream.has(referencedNodeId)) {
        failCondition(
          view.run.id,
          nodeRunId,
          "CONDITION_REFERENCE_INVALID",
          `Condition ${node.id} references non-upstream Node ${referencedNodeId}.`,
        );
      }
      const referencedNode = view.nodes.find(
        (candidate) => candidate.pipelineNodeId === referencedNodeId,
      );
      if (!referencedNode) {
        failCondition(
          view.run.id,
          nodeRunId,
          "CONDITION_REFERENCE_INVALID",
          `Condition ${node.id} references unknown Node ${referencedNodeId}.`,
        );
      }
      resolved = resolvePath(referencedNode!.result, nodeMatch[2]!.split("."));
    } else {
      failCondition(
        view.run.id,
        nodeRunId,
        "CONDITION_REFERENCE_INVALID",
        `Condition ${node.id} has invalid reference ${configuration.leftReference}.`,
      );
    }

    let matched = false;
    switch (configuration.operator) {
      case "exists":
        matched = resolved.found;
        break;
      case "not-exists":
        matched = !resolved.found;
        break;
      case "equals":
      case "not-equals": {
        if (!resolved.found) {
          failCondition(
            view.run.id,
            nodeRunId,
            "CONDITION_VALUE_MISSING",
            `Condition ${node.id} reference ${configuration.leftReference} did not resolve.`,
          );
        }
        if (
          !isJsonPrimitive(resolved.value) ||
          !isJsonPrimitive(configuration.value)
        ) {
          failCondition(
            view.run.id,
            nodeRunId,
            "CONDITION_VALUE_INVALID",
            `Condition ${node.id} requires JSON primitive values for ${configuration.operator}.`,
          );
        }
        const equals = resolved.value === configuration.value;
        matched = configuration.operator === "equals" ? equals : !equals;
        break;
      }
      case "in":
        if (!resolved.found) {
          failCondition(
            view.run.id,
            nodeRunId,
            "CONDITION_VALUE_MISSING",
            `Condition ${node.id} reference ${configuration.leftReference} did not resolve.`,
          );
        }
        const allowedValues = configuration.value;
        if (
          typeof resolved.value !== "string" ||
          !Array.isArray(allowedValues) ||
          !allowedValues.every((value: unknown) => typeof value === "string")
        ) {
          failCondition(
            view.run.id,
            nodeRunId,
            "CONDITION_VALUE_INVALID",
            `Condition ${node.id} requires a string left value and string-array configuration for in.`,
          );
        }
        matched = (allowedValues as string[]).includes(
          resolved.value as string,
        );
        break;
    }

    const branchKinds = new Map<string, number>();
    for (const branch of configuration.branches) {
      branchKinds.set(branch.kind, (branchKinds.get(branch.kind) ?? 0) + 1);
    }
    if ([...branchKinds.values()].some((count) => count > 1)) {
      failCondition(
        view.run.id,
        nodeRunId,
        "CONDITION_CONFIGURATION_INVALID",
        `Condition ${node.id} has duplicate branch kinds.`,
      );
    }
    const desiredKind = matched ? "match" : "no-match";
    const selectedBranch =
      configuration.branches.find((branch) => branch.kind === desiredKind) ??
      configuration.branches.find((branch) => branch.kind === "default");
    if (!selectedBranch) {
      return failCondition(
        view.run.id,
        nodeRunId,
        "CONDITION_BRANCH_NOT_FOUND",
        `Condition ${node.id} has no ${desiredKind} or default branch.`,
      );
    }

    const outgoing = graph.edges.filter((edge) => edge.from === node.id);
    const selectedTargets = outgoing
      .filter((edge) => edge.branchId === selectedBranch.id)
      .map((edge) => edge.to);
    if (selectedTargets.length === 0) {
      failCondition(
        view.run.id,
        nodeRunId,
        "CONDITION_BRANCH_NOT_FOUND",
        `Condition ${node.id} selected branch ${selectedBranch.id} without an outgoing edge.`,
      );
    }
    const unselectedTargets = outgoing
      .filter((edge) => edge.branchId !== selectedBranch.id)
      .map((edge) => edge.to);
    const selectedReachability = reachableNodeIds(graph, selectedTargets);
    const skippedNodeIds = [
      ...reachableNodeIds(graph, unselectedTargets),
    ].filter((nodeId) => !selectedReachability.has(nodeId));

    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const changed = database
        .prepare(
          `UPDATE node_runs
              SET status = 'succeeded', result_json = ?, failure_code = NULL,
                  failure_message = NULL, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'ready'`,
        )
        .run(
          JSON.stringify({
            selectedBranchId: selectedBranch.id,
            ...(resolved.found ? { leftValue: resolved.value } : {}),
          }),
          now,
          nodeRunId,
          view.run.id,
        );
      if (changed.changes === 0) {
        throw new PipelineRuntimeError(
          "NODE_STATE_INVALID",
          `Condition Node Run ${nodeRunId} is not Ready.`,
        );
      }
      const skipNode = database.prepare(
        `UPDATE node_runs
            SET status = 'skipped', result_json = ?, updated_at = ?
          WHERE run_id = ? AND pipeline_node_id = ?
            AND status IN ('queued', 'ready')`,
      );
      for (const skippedNodeId of skippedNodeIds) {
        skipNode.run(
          JSON.stringify({
            reason: "condition-not-selected",
            conditionNodeId: node.id,
            selectedBranchId: selectedBranch.id,
          }),
          now,
          view.run.id,
          skippedNodeId,
        );
      }
      refreshQueuedNodes(view.run.id, now);
      database
        .prepare(
          `UPDATE department_runs
              SET status = 'running', revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, view.run.id);
      appendRuntimeMutation({
        action: "condition.select",
        entityType: "node-run",
        entityId: nodeRunId,
        eventType: "node.condition.selected",
        runId: view.run.id,
        nodeRunId,
        before: { status: "ready" },
        after: {
          status: "succeeded",
          selectedBranchId: selectedBranch.id,
          skippedNodeIds,
        },
        createdAt: now,
      });
      for (const skippedNodeId of skippedNodeIds) {
        const skipped = database
          .prepare(
            `SELECT id FROM node_runs
              WHERE run_id = ? AND pipeline_node_id = ?`,
          )
          .get(view.run.id, skippedNodeId) as
          | { readonly id: string }
          | undefined;
        if (skipped) {
          appendRuntimeMutation({
            action: "node.skip",
            entityType: "node-run",
            entityId: skipped.id,
            eventType: "node.skipped",
            runId: view.run.id,
            nodeRunId: skipped.id,
            after: {
              status: "skipped",
              reason: "condition-not-selected",
              conditionNodeId: node.id,
              selectedBranchId: selectedBranch.id,
            },
            createdAt: now,
          });
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const requestNodeAttemptCancellationInTransaction: PipelineRuntime["requestNodeAttemptCancellationInTransaction"] =
    (input) => {
      const current = readRunRow(input.runId);
      if (current.revision !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Department Run revision ${input.expectedRevision} does not match current revision ${current.revision}.`,
        );
      }
      const candidate = database
        .prepare(
          `SELECT node_attempts.node_run_id AS nodeRunId,
                node_attempts.status,
                COALESCE(node_attempts.execution_operation_key,
                         'node-attempt:' || node_attempts.id) AS operationKey
           FROM node_attempts
           JOIN node_runs ON node_runs.id = node_attempts.node_run_id
          WHERE node_attempts.id = ? AND node_runs.run_id = ?`,
        )
        .get(input.attemptId, input.runId) as
        | {
            readonly nodeRunId: string;
            readonly status: string;
            readonly operationKey: string;
          }
        | undefined;
      if (
        !candidate ||
        !["running", "reconciling"].includes(candidate.status)
      ) {
        throw new PipelineRuntimeError(
          "ATTEMPT_CANCEL_STATE_INVALID",
          `Node Attempt ${input.attemptId} is not active in Department Run ${input.runId}.`,
        );
      }
      const now = clock().toISOString();
      database
        .prepare(
          `UPDATE node_attempts
              SET status = 'reconciling', recoverable = 1,
                  failure_code = 'EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED',
                  failure_message = 'Cancellation was requested, but external termination still requires reconciliation.',
                  completed_at = NULL
            WHERE id = ? AND status IN ('running', 'reconciling')`,
        )
        .run(input.attemptId);
      database
        .prepare(
          `UPDATE execution_leases
              SET cancel_requested = 1, released_at = COALESCE(released_at, ?)
            WHERE target_kind = 'node-attempt' AND target_id = ?
              AND released_at IS NULL`,
        )
        .run(now, input.attemptId);
      database
        .prepare(
          `UPDATE node_runs SET status = 'blocked',
                  failure_code = 'EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED',
                  failure_message = 'Cancellation was requested, but external termination still requires reconciliation.',
                  updated_at = ?
            WHERE id = ? AND status IN ('running', 'blocked')`,
        )
        .run(now, candidate.nodeRunId);
      const changed = database
        .prepare(
          `UPDATE department_runs SET status = 'blocked',
                  revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?
              AND status NOT IN ('completed', 'cancelled')`,
        )
        .run(now, input.runId, input.expectedRevision);
      if (changed.changes !== 1) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Department Run ${input.runId} changed before cancellation was recorded.`,
        );
      }
      appendRuntimeMutation({
        action: "attempt.cancel.request",
        entityType: "node-attempt",
        entityId: input.attemptId,
        eventType: "attempt.reconciling",
        runId: input.runId,
        nodeRunId: candidate.nodeRunId,
        before: { status: candidate.status },
        after: {
          status: "reconciling",
          operationKey: candidate.operationKey,
          failureCode: "EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED",
        },
        createdAt: now,
      });
      return inspectRun(input.runId);
    };

  const dispatchNodeAttemptCancellation: PipelineRuntime["dispatchNodeAttemptCancellation"] =
    async (attemptId) => {
      const candidate = database
        .prepare(
          `SELECT COALESCE(execution_operation_key, 'node-attempt:' || id)
                    AS operationKey
             FROM node_attempts WHERE id = ?`,
        )
        .get(attemptId) as { readonly operationKey: string } | undefined;
      if (!candidate) return;
      try {
        await executionAdapter.cancel?.(candidate.operationKey);
      } catch {
        // Cancellation is advisory; reconciliation remains authoritative.
      }
      const active = [...activeExecutions.values()].filter(
        (execution) => execution.attemptId === attemptId,
      );
      for (const execution of active) execution.controller.abort();
      await Promise.all(active.map((execution) => execution.done));
    };

  const cancelNodeAttempt: PipelineRuntime["cancelNodeAttempt"] = async (
    input,
  ) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      requestNodeAttemptCancellationInTransaction(input);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await dispatchNodeAttemptCancellation(input.attemptId);
    return inspectRun(input.runId);
  };

  const controlRun = async (input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly action: "pause" | "resume" | "cancel";
  }): Promise<DepartmentRunView> => {
    const current = readRunRow(input.runId);
    if (current.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.revision}.`,
      );
    }
    const now = clock().toISOString();
    const active = [...activeExecutions.values()].filter(
      (execution) => execution.runId === input.runId,
    );
    const cancellationCandidates =
      input.action === "cancel"
        ? (database
            .prepare(
              `SELECT node_attempts.id AS attemptId,
                      node_attempts.node_run_id AS nodeRunId,
                      COALESCE(
                        node_attempts.execution_operation_key,
                        'node-attempt:' || node_attempts.id
                      ) AS operationKey
                 FROM node_attempts
                 JOIN node_runs ON node_runs.id = node_attempts.node_run_id
                WHERE node_runs.run_id = ?
                  AND node_attempts.status = 'running'`,
            )
            .all(input.runId) as Array<{
            readonly attemptId: string;
            readonly nodeRunId: string;
            readonly operationKey: string;
          }>)
        : [];
    database.exec("BEGIN IMMEDIATE");
    try {
      if (input.action === "pause") {
        if (
          ![
            "ready",
            "running",
            "waiting-approval",
            "blocked",
            "recovering",
          ].includes(current.status)
        ) {
          throw new PipelineRuntimeError(
            "RUN_CONTROL_STATE_INVALID",
            `Department Run ${input.runId} cannot pause from ${current.status}.`,
          );
        }
        const paused = database
          .prepare(
            `UPDATE department_runs
                SET status = 'paused', paused_from_status = status,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ? AND status = ?`,
          )
          .run(now, input.runId, input.expectedRevision, current.status);
        if (paused.changes !== 1) {
          throw new PipelineRuntimeError(
            "VERSION_CONFLICT",
            `Department Run ${input.runId} changed before Pause was recorded.`,
          );
        }
      } else if (input.action === "resume") {
        if (current.status !== "paused" || !current.pausedFromStatus) {
          throw new PipelineRuntimeError(
            "RUN_CONTROL_STATE_INVALID",
            `Department Run ${input.runId} is not paused.`,
          );
        }
        const resumed = database
          .prepare(
            `UPDATE department_runs
                SET status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM node_attempts
                    JOIN node_runs ON node_runs.id = node_attempts.node_run_id
                     WHERE node_runs.run_id = department_runs.id
                       AND node_attempts.status = 'reconciling'
                  ) THEN 'blocked'
                  WHEN EXISTS (
                    SELECT 1 FROM node_runs
                     WHERE node_runs.run_id = department_runs.id
                       AND node_runs.status = 'failed'
                  ) THEN 'recovering'
                  ELSE paused_from_status
                END,
                    paused_from_status = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ? AND status = 'paused'
                AND paused_from_status IS NOT NULL`,
          )
          .run(now, input.runId, input.expectedRevision);
        if (resumed.changes !== 1) {
          throw new PipelineRuntimeError(
            "VERSION_CONFLICT",
            `Department Run ${input.runId} changed before Resume was recorded.`,
          );
        }
      } else {
        if (["completed", "cancelled"].includes(current.status)) {
          throw new PipelineRuntimeError(
            "RUN_CONTROL_STATE_INVALID",
            `Department Run ${input.runId} cannot cancel from ${current.status}.`,
          );
        }
        database
          .prepare(
            `UPDATE node_attempts
                SET status = 'cancelled', recoverable = 0,
                    failure_code = NULL, failure_message = NULL,
                    completed_at = COALESCE(completed_at, ?)
              WHERE node_run_id IN (
                SELECT id FROM node_runs WHERE run_id = ?
              ) AND status = 'ready'`,
          )
          .run(now, input.runId);
        database
          .prepare(
            `UPDATE node_attempts
                SET status = 'reconciling', recoverable = 1,
                    failure_code = 'EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED',
                    failure_message = 'Cancellation was requested, but external termination still requires reconciliation.',
                    completed_at = NULL
              WHERE node_run_id IN (
                SELECT id FROM node_runs WHERE run_id = ?
              ) AND status = 'running'`,
          )
          .run(input.runId);
        database
          .prepare(
            `UPDATE execution_leases
                SET cancel_requested = 1, released_at = COALESCE(released_at, ?)
              WHERE target_kind = 'node-attempt'
                AND target_id IN (
                  SELECT node_attempts.id
                    FROM node_attempts
                    JOIN node_runs ON node_runs.id = node_attempts.node_run_id
                   WHERE node_runs.run_id = ?
                     AND node_attempts.status = 'reconciling'
                )
                AND released_at IS NULL`,
          )
          .run(now, input.runId);
        database
          .prepare(
            `UPDATE node_runs
                SET status = 'cancelled', updated_at = ?
              WHERE run_id = ? AND status IN (
                'queued', 'ready', 'waiting-permission',
                'waiting-approval', 'paused'
              )`,
          )
          .run(now, input.runId);
        database
          .prepare(
            `UPDATE node_runs
                SET status = 'blocked',
                    failure_code = 'EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED',
                    failure_message = 'Cancellation was requested, but external termination still requires reconciliation.',
                    updated_at = ?
              WHERE run_id = ? AND status = 'running'`,
          )
          .run(now, input.runId);
        const cancelled = database
          .prepare(
            `UPDATE department_runs
                SET status = CASE
                      WHEN EXISTS (
                        SELECT 1 FROM node_attempts
                        JOIN node_runs ON node_runs.id = node_attempts.node_run_id
                        WHERE node_runs.run_id = department_runs.id
                          AND node_attempts.status = 'reconciling'
                      ) THEN 'blocked'
                      ELSE 'cancelled'
                    END,
                    paused_from_status = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?
                AND status NOT IN ('completed', 'cancelled')`,
          )
          .run(now, input.runId, input.expectedRevision);
        if (cancelled.changes !== 1) {
          throw new PipelineRuntimeError(
            "VERSION_CONFLICT",
            `Department Run ${input.runId} changed before Cancel was recorded.`,
          );
        }
        for (const candidate of cancellationCandidates) {
          appendRuntimeMutation({
            action: "attempt.cancel.request",
            entityType: "node-attempt",
            entityId: candidate.attemptId,
            eventType: "attempt.reconciling",
            runId: input.runId,
            nodeRunId: candidate.nodeRunId,
            before: { status: "running" },
            after: {
              status: "reconciling",
              operationKey: candidate.operationKey,
              failureCode: "EXECUTION_CANCELLATION_RECONCILIATION_REQUIRED",
            },
            createdAt: now,
          });
        }
      }
      const next = readRunRow(input.runId);
      appendRuntimeMutation({
        action: `run.${input.action}`,
        entityType: "department-run",
        entityId: input.runId,
        eventType: `run.${
          input.action === "resume"
            ? "resumed"
            : input.action === "pause"
              ? "paused"
              : next.status === "blocked"
                ? "blocked"
                : "cancelled"
        }`,
        runId: input.runId,
        before: { status: current.status, revision: current.revision },
        after: { status: next.status, revision: next.revision },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (input.action === "pause" || input.action === "cancel") {
      if (input.action === "cancel") {
        await Promise.all(
          cancellationCandidates.map(async (candidate) => {
            try {
              await executionAdapter.cancel?.(candidate.operationKey);
            } catch {
              // Adapter cancellation is advisory; reconciliation owns truth.
            }
          }),
        );
      }
      for (const execution of active) execution.controller.abort();
      await Promise.all(active.map((execution) => execution.done));
      if (input.action === "pause" && active.length > 0) {
        const nowAfterAbort = clock().toISOString();
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const execution of active) {
            const pausedAttempt = database
              .prepare(
                `UPDATE node_attempts
                    SET status = 'reconciling', recoverable = 1,
                        failure_code = 'EXECUTION_PAUSE_RECONCILIATION_REQUIRED',
                        failure_message = 'Pause aborted the local worker, but external termination still requires reconciliation.',
                        completed_at = NULL
                  WHERE id = ? AND status = 'running'`,
              )
              .run(execution.attemptId);
            const pausedNode = database
              .prepare(
                `UPDATE node_runs
                    SET status = 'blocked',
                        failure_code = 'EXECUTION_PAUSE_RECONCILIATION_REQUIRED',
                        failure_message = 'Pause aborted the local worker, but external termination still requires reconciliation.',
                        updated_at = ?
                  WHERE id = (
                    SELECT node_run_id FROM node_attempts WHERE id = ?
                  ) AND status = 'running'`,
              )
              .run(nowAfterAbort, execution.attemptId);
            if (pausedAttempt.changes !== 1 || pausedNode.changes !== 1) {
              continue;
            }
            database
              .prepare(
                `UPDATE execution_leases SET released_at = ?
                  WHERE target_kind = 'node-attempt' AND target_id = ?
                    AND released_at IS NULL`,
              )
              .run(nowAfterAbort, execution.attemptId);
            const evidence = database
              .prepare(
                `SELECT node_run_id AS nodeRunId,
                        COALESCE(
                          execution_operation_key,
                          'node-attempt:' || id
                        ) AS operationKey
                   FROM node_attempts WHERE id = ?`,
              )
              .get(execution.attemptId) as {
              readonly nodeRunId: string;
              readonly operationKey: string;
            };
            appendRuntimeMutation({
              action: "attempt.pause.request",
              entityType: "node-attempt",
              entityId: execution.attemptId,
              eventType: "attempt.reconciling",
              runId: input.runId,
              nodeRunId: evidence.nodeRunId,
              before: { status: "running" },
              after: {
                status: "reconciling",
                operationKey: evidence.operationKey,
                failureCode: "EXECUTION_PAUSE_RECONCILIATION_REQUIRED",
              },
              createdAt: nowAfterAbort,
            });
          }
          database
            .prepare(
              `UPDATE department_runs
                  SET revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'paused'`,
            )
            .run(nowAfterAbort, input.runId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    }
    return inspectRun(input.runId);
  };

  const applyGovernedIntervention: PipelineRuntime["applyGovernedIntervention"] =
    (input) => {
      const current = inspectRun(input.runId);
      if (current.run.revision !== input.expectedRevision) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
        );
      }
      const node = current.nodes.find(
        (candidate) => candidate.id === input.nodeRunId,
      );
      const attempt = node?.attempts.at(-1);
      if (
        !node ||
        !attempt ||
        !["failed", "interrupted", "cancelled"].includes(attempt.status)
      ) {
        throw new PipelineRuntimeError(
          "INTERVENTION_TERMINATION_UNPROVEN",
          `Node Run ${input.nodeRunId} has no proven terminal Attempt.`,
        );
      }
      const reason = input.reason.trim();
      const feedback = input.feedback.trim();
      if (
        !reason ||
        reason.length > 1_000 ||
        !feedback ||
        feedback.length > 10_000
      ) {
        throw new PipelineRuntimeError(
          "INTERVENTION_INPUT_INVALID",
          "Governed intervention requires a reason and feedback within their limits.",
        );
      }
      const now = clock().toISOString();
      const interventionId = randomUUID();
      const nextAttemptId =
        input.outcome === "new-attempt" ? randomUUID() : null;
      database.exec("SAVEPOINT governed_intervention");
      try {
        if (nextAttemptId) {
          database
            .prepare(
              `INSERT INTO node_attempts(
                 id, node_run_id, attempt_number, snapshot_revision_id, reason,
                 status, structured_result_json, failure_code, failure_message,
                 created_at, started_at, completed_at
               ) VALUES (?, ?, ?, ?, 'retry', 'ready', NULL, NULL, NULL, ?, NULL, NULL)`,
            )
            .run(
              nextAttemptId,
              input.nodeRunId,
              node.attemptCount + 1,
              current.snapshot.id,
              now,
            );
          database
            .prepare(
              `INSERT INTO node_feedback(
                 id, run_id, node_run_id, source_approval_id,
                 target_attempt_id, kind, content, created_at
               ) VALUES (?, ?, ?, NULL, ?, 'retry', ?, ?)`,
            )
            .run(
              randomUUID(),
              input.runId,
              input.nodeRunId,
              nextAttemptId,
              feedback,
              now,
            );
          database
            .prepare(
              `UPDATE node_runs
                  SET status = 'ready', attempt_count = attempt_count + 1,
                      result_json = NULL, failure_code = NULL,
                      failure_message = NULL, updated_at = ?
                WHERE id = ? AND run_id = ?`,
            )
            .run(now, input.nodeRunId, input.runId);
        }
        database
          .prepare(
            `INSERT INTO governed_interventions(
               id, run_id, node_run_id, attempt_id, snapshot_revision_id,
               actor_id, reason, feedback, outcome, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            interventionId,
            input.runId,
            input.nodeRunId,
            attempt.id,
            current.snapshot.id,
            input.actorId,
            reason,
            feedback,
            input.outcome,
            now,
          );
        const paused = database
          .prepare(
            `UPDATE department_runs
                SET status = 'paused', paused_from_status = ?,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?
                AND status NOT IN ('completed', 'cancelled', 'superseded')`,
          )
          .run(
            nextAttemptId ? "recovering" : current.run.status,
            now,
            input.runId,
            input.expectedRevision,
          );
        if (paused.changes !== 1) {
          throw new PipelineRuntimeError(
            "VERSION_CONFLICT",
            `Department Run ${input.runId} changed before intervention was recorded.`,
          );
        }
        appendRuntimeMutation({
          action: "run.governed-intervention",
          entityType: "governed-intervention",
          entityId: interventionId,
          eventType: "run.intervention.recorded",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          before: {
            runStatus: current.run.status,
            attemptId: attempt.id,
            snapshotRevisionId: current.snapshot.id,
          },
          after: {
            status: "paused",
            outcome: input.outcome,
            attemptId: nextAttemptId ?? attempt.id,
            snapshotRevisionId: current.snapshot.id,
          },
          createdAt: now,
        });
        database.exec("RELEASE governed_intervention");
      } catch (error) {
        database.exec("ROLLBACK TO governed_intervention");
        database.exec("RELEASE governed_intervention");
        throw error;
      }
      return inspectRun(input.runId);
    };

  const ensureReadyAttempt = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly snapshotRevisionId: string;
  }): void => {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare(
          `SELECT id FROM node_attempts
            WHERE node_run_id = ? AND status IN ('ready', 'running')
            ORDER BY attempt_number DESC LIMIT 1`,
        )
        .get(input.nodeRunId) as { readonly id: string } | undefined;
      if (existing) {
        database.exec("COMMIT");
        return;
      }
      const node = database
        .prepare(
          `SELECT attempt_count AS attemptCount, status
             FROM node_runs
            WHERE id = ? AND run_id = ?`,
        )
        .get(input.nodeRunId, input.runId) as
        | { readonly attemptCount: number; readonly status: string }
        | undefined;
      if (!node || node.status !== "ready") {
        throw new PipelineRuntimeError(
          "NODE_STATE_INVALID",
          `Node Run ${input.nodeRunId} is not Ready for an initial Attempt.`,
        );
      }
      const updated = database
        .prepare(
          `UPDATE node_runs
              SET attempt_count = attempt_count + 1, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'ready'`,
        )
        .run(now, input.nodeRunId, input.runId);
      if (updated.changes !== 1) {
        throw new PipelineRuntimeError(
          "NODE_STATE_INVALID",
          `Node Run ${input.nodeRunId} changed before its initial Attempt was recorded.`,
        );
      }
      const attemptId = randomUUID();
      database
        .prepare(
          `INSERT INTO node_attempts(
             id, node_run_id, attempt_number, snapshot_revision_id, reason,
             status, structured_result_json, failure_code, failure_message,
             created_at, started_at, completed_at
           ) VALUES (?, ?, ?, ?, 'initial', 'ready', NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          attemptId,
          input.nodeRunId,
          Number(node.attemptCount) + 1,
          input.snapshotRevisionId,
          now,
        );
      appendRuntimeMutation({
        action: "attempt.ready",
        entityType: "node-attempt",
        entityId: attemptId,
        eventType: "attempt.ready",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: null,
        after: {
          status: "ready",
          attemptNumber: Number(node.attemptCount) + 1,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const recoverRun = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly override: {
      readonly providerRef?: string;
      readonly model?: string;
      readonly sandboxRef?: string;
      readonly timeoutSeconds?: number;
      readonly maxIterations?: number;
      readonly maxTokens?: number | null;
      readonly secretReferenceIds?: readonly string[];
    };
  }): DepartmentRunView => {
    const current = inspectRun(input.runId);
    if (current.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
      );
    }
    if (!Object.keys(input.override).length) {
      throw new PipelineRuntimeError(
        "RECOVERY_OVERRIDE_INVALID",
        "Recovery requires at least one allowed execution-setting override.",
      );
    }
    const nodeRun = current.nodes.find((node) => node.id === input.nodeRunId);
    const pipelineNode = nodeRun
      ? current.snapshot.payload.pipelineVersion.graph.nodes.find(
          (node) => node.id === nodeRun.pipelineNodeId,
        )
      : undefined;
    if (
      !["failed", "blocked", "recovering"].includes(current.run.status) ||
      !nodeRun ||
      !["failed", "blocked"].includes(nodeRun.status) ||
      pipelineNode?.type !== "ai-task"
    ) {
      throw new PipelineRuntimeError(
        "RECOVERY_STATE_INVALID",
        `Node Run ${input.nodeRunId} is not an AI Task eligible for Recovery Override.`,
      );
    }
    const profileId =
      pipelineNode.executionProfileId ??
      current.snapshot.payload.department.defaultExecutionProfileId;
    const profileIndex = current.snapshot.payload.executionProfiles.findIndex(
      (profile) => profile.id === profileId,
    );
    if (profileIndex < 0) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `AI Task ${pipelineNode.id} has no resolved Execution Profile.`,
      );
    }
    if (input.override.secretReferenceIds) {
      for (const secretReferenceId of input.override.secretReferenceIds) {
        const reference = database
          .prepare(
            `SELECT id FROM secret_references
              WHERE id = ? AND department_id = ? AND status = 'active'`,
          )
          .get(secretReferenceId, current.run.departmentId);
        if (!reference) {
          throw new PipelineRuntimeError(
            "RECOVERY_SECRET_REFERENCE_INVALID",
            `Secret Reference ${secretReferenceId} is not active for this Department.`,
          );
        }
      }
    }
    const payload = JSON.parse(
      JSON.stringify(current.snapshot.payload),
    ) as RunSnapshotPayload;
    const profile = payload.executionProfiles[profileIndex];
    if (!profile) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `Execution Profile ${profileId} is missing from the Run Snapshot.`,
      );
    }
    payload.executionProfiles[profileIndex] = {
      ...profile,
      ...(input.override.providerRef
        ? { providerRef: input.override.providerRef }
        : {}),
      ...(input.override.model ? { model: input.override.model } : {}),
      ...(input.override.sandboxRef
        ? { sandboxRef: input.override.sandboxRef }
        : {}),
      limits: {
        ...profile.limits,
        ...(input.override.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: input.override.timeoutSeconds }),
        ...(input.override.maxIterations === undefined
          ? {}
          : { maxIterations: input.override.maxIterations }),
        ...(input.override.maxTokens === undefined
          ? {}
          : { maxTokens: input.override.maxTokens }),
      },
      ...(input.override.secretReferenceIds
        ? { secretReferenceIds: [...input.override.secretReferenceIds] }
        : {}),
    };
    const canonicalJson = canonicalPipelineJson(payload);
    const hash = pipelineHash(payload);
    const now = clock().toISOString();
    const snapshotId = randomUUID();
    const attemptId = randomUUID();
    const affectedNodeIds = reachableNodeIds(
      current.snapshot.payload.pipelineVersion.graph,
      [pipelineNode.id],
    );
    const continuationItems = current.nodes.map((node) => {
      const terminal = database
        .prepare(
          `SELECT terminal_execution_fact_id AS terminalFactId
             FROM node_attempts
            WHERE node_run_id = ? AND terminal_execution_fact_id IS NOT NULL
         ORDER BY attempt_number DESC LIMIT 1`,
        )
        .get(node.id) as { readonly terminalFactId: string } | undefined;
      const disposition =
        node.id === input.nodeRunId
          ? ("rerun" as const)
          : affectedNodeIds.has(node.pipelineNodeId)
            ? ("blocked" as const)
            : node.status === "succeeded"
              ? ("reuse-evidence" as const)
              : node.status === "skipped"
                ? ("skip" as const)
                : ("blocked" as const);
      return {
        pipelineNodeId: node.pipelineNodeId,
        sourceNodeRunId: node.id,
        targetNodeRunId: node.id,
        disposition,
        evidenceRefs: terminal
          ? [terminal.terminalFactId]
          : node.status === "skipped"
            ? [`node-run:${node.id}:skipped`]
            : [],
        reason:
          disposition === "rerun"
            ? "Recovery creates a new Attempt under the target Snapshot revision."
            : disposition === "reuse-evidence"
              ? "The upstream immutable terminal evidence remains outside the invalidation closure."
              : disposition === "skip"
                ? "The upstream graph-defined skip remains outside the invalidation closure."
                : "The Node is in or depends on the Recovery invalidation closure.",
      };
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      const run = database
        .prepare(
          `UPDATE department_runs
              SET status = 'recovering', snapshot_revision_id = ?,
                  revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?
              AND status IN ('failed', 'blocked', 'recovering')`,
        )
        .run(snapshotId, now, input.runId, input.expectedRevision);
      if (run.changes !== 1) {
        throw new PipelineRuntimeError(
          "VERSION_CONFLICT",
          `Department Run ${input.runId} changed before Recovery Override was recorded.`,
        );
      }
      database
        .prepare(
          `INSERT INTO run_snapshot_revisions(
             id, run_id, revision, parent_revision, schema_version,
             canonical_json, hash, created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          input.runId,
          current.snapshot.revision + 1,
          current.snapshot.revision,
          canonicalJson,
          hash,
          now,
        );
      const resetNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'ready', attempt_count = attempt_count + 1,
                  result_json = NULL, failure_code = NULL,
                  failure_message = NULL, updated_at = ?
            WHERE id = ? AND run_id = ? AND status IN ('failed', 'blocked')`,
        )
        .run(now, input.nodeRunId, input.runId);
      if (resetNode.changes !== 1) {
        throw new PipelineRuntimeError(
          "RECOVERY_STATE_INVALID",
          `Node Run ${input.nodeRunId} changed before Recovery Override was recorded.`,
        );
      }
      database
        .prepare(
          `INSERT INTO node_attempts(
             id, node_run_id, attempt_number, snapshot_revision_id, reason,
             status, structured_result_json, failure_code, failure_message,
             created_at, started_at, completed_at
           ) VALUES (?, ?, ?, ?, 'recovery', 'ready', NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          attemptId,
          input.nodeRunId,
          nodeRun.attemptCount + 1,
          snapshotId,
          now,
        );
      const continuationPlan = insertContinuationPlanInTransaction({
        kind: "recovery",
        sourceRunId: input.runId,
        targetRunId: input.runId,
        sourceSnapshotRevisionId: current.snapshot.id,
        targetSnapshotRevisionId: snapshotId,
        targetNodeRunId: input.nodeRunId,
        mode: "recovery",
        runRevision: current.run.revision + 1,
        createdAt: now,
        items: continuationItems,
      });
      appendRuntimeMutation({
        action: "run.recover",
        entityType: "snapshot-revision",
        entityId: snapshotId,
        eventType: "snapshot.revision.created",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: {
          snapshotRevisionId: current.snapshot.id,
          revision: current.snapshot.revision,
        },
        after: {
          snapshotRevisionId: snapshotId,
          revision: current.snapshot.revision + 1,
          parentRevision: current.snapshot.revision,
          attemptId,
          continuationPlanId: continuationPlan.id,
          continuationPlanHash: continuationPlan.hash,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(input.runId);
  };

  type PipelineNode =
    RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number];
  type ReadyNodeView = DepartmentRunView["nodes"][number];

  const ensureHandlerAvailable = (
    view: DepartmentRunView,
    nodeRun: ReadyNodeView,
    node: PipelineNode,
  ): void => {
    const frozenRegistry =
      view.snapshot.payload.pipelineVersion.handlerRegistry;
    const frozen = view.snapshot.payload.pipelineVersion.handlers?.find(
      (binding) => binding.nodeId === node.id,
    );
    const available = frozen
      ? handlerRegistry.resolve(node.type, frozen.handlerKindId)
      : undefined;
    const matches =
      frozenRegistry?.version === handlerRegistry.version &&
      frozenRegistry.hash === handlerRegistry.hash &&
      frozen !== undefined &&
      nodeRun.handler?.handlerKindId === frozen.handlerKindId &&
      nodeRun.handler.inputSchemaHash === frozen.inputSchemaHash &&
      nodeRun.handler.outputSchemaHash === frozen.outputSchemaHash &&
      available?.inputSchemaHash === frozen.inputSchemaHash &&
      available?.outputSchemaHash === frozen.outputSchemaHash;
    if (matches) return;

    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const failedNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'failed',
                  failure_code = 'HANDLER_VERSION_UNAVAILABLE',
                  failure_message = ?, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'ready'`,
        )
        .run(
          `Handler ${frozen?.handlerKindId ?? "unknown"} is unavailable for Node ${node.id}.`,
          now,
          nodeRun.id,
          view.run.id,
        );
      const blockedRun = database
        .prepare(
          `UPDATE department_runs
              SET status = 'blocked', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status IN ('ready', 'running', 'recovering')`,
        )
        .run(now, view.run.id);
      if (failedNode.changes !== 1 || blockedRun.changes !== 1) {
        throw new PipelineRuntimeError(
          "HANDLER_VERSION_UNAVAILABLE",
          `Handler availability changed while blocking Node ${node.id}.`,
        );
      }
      appendRuntimeMutation({
        action: "node.handler-unavailable",
        entityType: "node-run",
        entityId: nodeRun.id,
        eventType: "node.failed",
        runId: view.run.id,
        nodeRunId: nodeRun.id,
        before: { status: "ready" },
        after: {
          status: "failed",
          runStatus: "blocked",
          failureCode: "HANDLER_VERSION_UNAVAILABLE",
          handlerKindId: frozen?.handlerKindId ?? null,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    throw new PipelineRuntimeError(
      "HANDLER_VERSION_UNAVAILABLE",
      `Handler ${frozen?.handlerKindId ?? "unknown"} is unavailable for Node ${node.id}.`,
    );
  };

  const executeAiTask = async (input: {
    readonly runId: string;
    readonly view: DepartmentRunView;
    readonly ready: ReadyNodeView;
    readonly node: PipelineNode;
  }): Promise<DepartmentRunView> => {
    const profileId =
      input.node.executionProfileId ??
      input.view.snapshot.payload.department.defaultExecutionProfileId;
    const profile = input.view.snapshot.payload.executionProfiles.find(
      (candidate) => candidate.id === profileId,
    );
    if (!profile) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `AI Task ${input.node.id} has no resolved Execution Profile.`,
      );
    }
    ensureReadyAttempt({
      runId: input.runId,
      nodeRunId: input.ready.id,
      snapshotRevisionId: input.view.snapshot.id,
    });
    const workerId = `execute-ready:${randomUUID()}`;
    const claim = claimReadyAttempt({
      runId: input.runId,
      nodeRunId: input.ready.id,
      workerId,
      leaseDurationMs: profile.limits.timeoutSeconds * 1_000,
    });
    if (claim.kind !== "claimed") {
      if (claim.reason === "concurrency-limit") {
        throw new PipelineRuntimeError(
          "SCHEDULER_CONCURRENCY_LIMIT",
          `Department Run ${input.runId} reached its active Node limit.`,
        );
      }
      throw new PipelineRuntimeError(
        "LEASE_CONFLICT",
        `Node Run ${input.ready.id} changed before its Ready Attempt could be claimed.`,
      );
    }
    const runningView = inspectRun(input.runId);
    const runningNode = runningView.nodes.find(
      (candidate) => candidate.id === input.ready.id,
    );
    const runningAttempt = runningNode?.attempts.find(
      (attempt) => attempt.id === claim.attemptId,
    );
    if (!runningNode || !runningAttempt) {
      throw new PipelineRuntimeError(
        "NODE_STATE_INVALID",
        `Node Run ${input.ready.id} has no Running Node Attempt.`,
      );
    }
    const previousAttempts = runningNode.attempts.filter(
      (attempt) => attempt.attemptNumber < runningAttempt.attemptNumber,
    );
    const previousSucceeded = [...previousAttempts]
      .reverse()
      .find((attempt) => attempt.status === "succeeded");
    const previousFailed = [...previousAttempts]
      .reverse()
      .find((attempt) => attempt.status === "failed");
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    activeExecutions.set(claim.attemptId, {
      attemptId: claim.attemptId,
      runId: input.runId,
      controller,
      done,
    });
    const leaseDurationMs = profile.limits.timeoutSeconds * 1_000;
    const leaseRenewalInterval = setInterval(
      () => {
        try {
          const renewed = renewAttemptLease({
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
            workerId,
            leaseDurationMs,
          });
          if (renewed.kind === "lost") controller.abort();
        } catch {
          controller.abort();
        }
      },
      Math.max(100, Math.floor(leaseDurationMs / 3)),
    );
    leaseRenewalInterval.unref?.();
    const target = { kind: "node-attempt" as const, id: claim.attemptId };
    const lease: ExecutionLeaseContext & { readonly target: typeof target } = {
      leaseId: claim.leaseId,
      leaseKind: "execution",
      operationKey: claim.operationKey,
      target,
      executionEpoch: claim.executionEpoch,
      fenceToken: claim.fenceToken,
    };
    const request: ExecutionRequest = {
      operationKey: claim.operationKey,
      target: lease.target,
      lease,
      agentAdapterId: profile.providerRef,
      permissionScope: profile.permissionPolicy,
      sideEffectPolicy: "formal",
      completionSignal: "execution-fact",
      timeoutSeconds: profile.limits.timeoutSeconds,
      immutableContext: {
        runId: input.runId,
        nodeRunId: input.ready.id,
        nodeAttemptId: claim.attemptId,
        snapshotRevisionId: runningAttempt.snapshotRevisionId,
        handlerKindId: runningNode.handler?.handlerKindId ?? "unknown",
      },
    };
    const applyAcceptedExecutionFact = (
      fact: ExecutionFactEnvelope,
    ): string[] => {
      const payload =
        typeof fact.payload === "object" &&
        fact.payload !== null &&
        !Array.isArray(fact.payload)
          ? (fact.payload as Record<string, unknown>)
          : {};
      if (fact.kind === "permission-request") {
        const scope =
          typeof payload.scope === "string" ? payload.scope.trim() : "";
        if (
          !scope ||
          scope === "*" ||
          scope.endsWith(".*") ||
          /[\s,]/.test(scope)
        ) {
          throw new ExecutionFactError(
            "PERMISSION_SCOPE_INVALID",
            "Permission Fact scope must identify one exact capability.",
          );
        }
        const safeRead = scope.split(".").at(-1) === "read";
        if (profile.permissionPolicy === "allow-safe" && safeRead) return [];
        if (!options.interaction) {
          throw new ExecutionFactError(
            "PERMISSION_RUNTIME_UNAVAILABLE",
            "Runtime Permission handling is unavailable.",
          );
        }
        if (profile.permissionPolicy === "deny") {
          const deniedAttempt = database
            .prepare(
              `UPDATE node_attempts
                  SET status = 'failed', failure_code = 'PERMISSION_DENIED',
                      failure_message = ?, recoverable = 0, completed_at = ?
                WHERE id = ? AND status = 'running'
                  AND lease_id = ? AND lease_owner = ?`,
            )
            .run(
              `Execution Profile denied Permission scope ${scope}.`,
              fact.createdAt,
              claim.attemptId,
              claim.leaseId,
              workerId,
            );
          const deniedNode = database
            .prepare(
              `UPDATE node_runs
                  SET status = 'failed', failure_code = 'PERMISSION_DENIED',
                      failure_message = ?, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running'`,
            )
            .run(
              `Execution Profile denied Permission scope ${scope}.`,
              fact.createdAt,
              input.ready.id,
              input.runId,
            );
          const deniedRun = database
            .prepare(
              `UPDATE department_runs
                  SET status = 'failed', revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'running'`,
            )
            .run(fact.createdAt, input.runId);
          if (
            deniedAttempt.changes !== 1 ||
            deniedNode.changes !== 1 ||
            deniedRun.changes !== 1
          ) {
            throw new PipelineRuntimeError(
              "EXECUTION_TERMINAL_CONFLICT",
              `Node Attempt ${claim.attemptId} cannot apply Permission denial.`,
            );
          }
          database
            .prepare(
              `UPDATE execution_leases SET released_at = ?
                WHERE id = ? AND released_at IS NULL`,
            )
            .run(fact.createdAt, claim.leaseId);
          appendRuntimeMutation({
            action: "attempt.permission-denied",
            entityType: "node-attempt",
            entityId: claim.attemptId,
            eventType: "attempt.failed",
            runId: input.runId,
            nodeRunId: input.ready.id,
            before: { status: "running" },
            after: {
              status: "failed",
              failure: { code: "PERMISSION_DENIED", scope },
            },
            createdAt: fact.createdAt,
          });
          return [];
        }
        const permission =
          options.interaction.requestExecutionPermissionInTransaction({
            projectId: runningView.run.projectId,
            runId: input.runId,
            nodeRunId: input.ready.id,
            scope,
          });
        const waitingNode = database
          .prepare(
            `UPDATE node_runs
                SET status = 'waiting-permission', updated_at = ?
              WHERE id = ? AND run_id = ? AND status = 'running'`,
          )
          .run(fact.createdAt, input.ready.id, input.runId);
        const waitingRun = database
          .prepare(
            `UPDATE department_runs
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(fact.createdAt, input.runId);
        if (waitingNode.changes !== 1 || waitingRun.changes !== 1) {
          throw new PipelineRuntimeError(
            "PERMISSION_STATE_INVALID",
            `Node Attempt ${claim.attemptId} cannot wait for Permission.`,
          );
        }
        database
          .prepare(
            `UPDATE execution_leases SET released_at = ?
              WHERE id = ? AND released_at IS NULL`,
          )
          .run(fact.createdAt, claim.leaseId);
        appendRuntimeMutation({
          action: "node.permission-request",
          entityType: "node-run",
          entityId: input.ready.id,
          eventType: "node.status.changed",
          runId: input.runId,
          nodeRunId: input.ready.id,
          before: { status: "running" },
          after: {
            status: "waiting-permission",
            permissionId: permission.id,
            scope,
          },
          createdAt: fact.createdAt,
        });
        return [permission.id];
      }
      if (fact.kind === "checkpoint") {
        database
          .prepare(
            `UPDATE node_attempts
                SET checkpoint_json = ?
              WHERE id = ? AND status = 'running'
                AND lease_id = ? AND lease_owner = ?`,
          )
          .run(
            JSON.stringify(payload.checkpoint ?? payload),
            claim.attemptId,
            claim.leaseId,
            workerId,
          );
        return [];
      }
      if (!["completed", "failed", "cancelled"].includes(fact.kind)) {
        return [];
      }

      const activeLease = database
        .prepare(
          `SELECT 1 AS present
             FROM execution_leases
            WHERE id = ? AND operation_key = ? AND execution_epoch = ?
              AND fence_token = ? AND released_at IS NULL AND expires_at > ?`,
        )
        .get(
          claim.leaseId,
          claim.operationKey,
          claim.executionEpoch,
          claim.fenceToken,
          fact.createdAt,
        );
      if (!activeLease) {
        throw new PipelineRuntimeError(
          "EXECUTION_LEASE_LOST",
          `Execution Lease ${claim.leaseId} is no longer active.`,
        );
      }

      if (fact.kind === "completed") {
        const result = payload.structuredResult;
        const completedAttempt = database
          .prepare(
            `UPDATE node_attempts
                SET status = 'succeeded', structured_result_json = ?,
                    failure_code = NULL, failure_message = NULL,
                    recoverable = 0, completed_at = ?,
                    terminal_execution_fact_id = ?
              WHERE id = ? AND node_run_id = ? AND status = 'running'
                AND lease_id = ? AND lease_owner = ?
                AND lease_expires_at > ?`,
          )
          .run(
            result === undefined ? null : JSON.stringify(result),
            fact.createdAt,
            fact.id,
            claim.attemptId,
            input.ready.id,
            claim.leaseId,
            workerId,
            fact.createdAt,
          );
        const completedNode = database
          .prepare(
            `UPDATE node_runs
                SET status = 'succeeded', result_json = ?, failure_code = NULL,
                    failure_message = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND status = 'running'`,
          )
          .run(
            result === undefined ? null : JSON.stringify(result),
            fact.createdAt,
            input.ready.id,
            input.runId,
          );
        if (completedAttempt.changes !== 1 || completedNode.changes !== 1) {
          throw new PipelineRuntimeError(
            "EXECUTION_TERMINAL_CONFLICT",
            `Node Attempt ${claim.attemptId} cannot accept another terminal fact.`,
          );
        }
        const producer = input.node.positionId
          ? runningView.snapshot.payload.positions.find(
              (position) => position.id === input.node.positionId,
            )
          : undefined;
        const artifactEffectIds = registerExecutionArtifacts({
          payload,
          runId: input.runId,
          nodeRunId: input.ready.id,
          attemptId: claim.attemptId,
          snapshotRevisionId: runningAttempt.snapshotRevisionId,
          aiMemberId: producer?.aiMember.id,
        });
        refreshQueuedNodes(input.runId, fact.createdAt);
        const updatedRun = database
          .prepare(
            `UPDATE department_runs
                SET status = 'running', revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(fact.createdAt, input.runId);
        if (updatedRun.changes !== 1) {
          throw new PipelineRuntimeError(
            "EXECUTION_TERMINAL_CONFLICT",
            `Department Run ${input.runId} cannot accept the terminal fact.`,
          );
        }
        database
          .prepare(
            `UPDATE execution_leases SET released_at = ?
              WHERE id = ? AND released_at IS NULL`,
          )
          .run(fact.createdAt, claim.leaseId);
        appendRuntimeMutation({
          action: "attempt.complete",
          entityType: "node-attempt",
          entityId: claim.attemptId,
          eventType: "attempt.succeeded",
          runId: input.runId,
          nodeRunId: input.ready.id,
          before: { status: "running" },
          after: { status: "succeeded", result: result ?? null },
          createdAt: fact.createdAt,
        });
        appendExecutionEvent({
          type: "execution.completed",
          runId: input.runId,
          nodeRunId: input.ready.id,
          attemptId: claim.attemptId,
          payload: {
            operationKey: claim.operationKey,
            executionFactId: fact.id,
            status: "succeeded",
          },
          createdAt: fact.createdAt,
        });
        return artifactEffectIds;
      }

      const failure = {
        code:
          typeof payload.code === "string"
            ? payload.code
            : fact.kind === "cancelled"
              ? "EXECUTION_CANCELLED"
              : "EXECUTION_FAILED",
        message:
          typeof payload.message === "string"
            ? payload.message
            : fact.kind === "cancelled"
              ? "Execution was cancelled."
              : "Execution Adapter reported a failed operation.",
        recoverable: fact.kind !== "cancelled",
      };
      const terminalStatus = fact.kind === "cancelled" ? "cancelled" : "failed";
      const failedAttempt = database
        .prepare(
          `UPDATE node_attempts
              SET status = ?, structured_result_json = NULL,
                  failure_code = ?, failure_message = ?, recoverable = ?,
                  completed_at = ?, terminal_execution_fact_id = ?
            WHERE id = ? AND node_run_id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          terminalStatus,
          failure.code,
          failure.message,
          failure.recoverable ? 1 : 0,
          fact.createdAt,
          fact.id,
          claim.attemptId,
          input.ready.id,
          claim.leaseId,
          workerId,
          fact.createdAt,
        );
      const failedNode = database
        .prepare(
          `UPDATE node_runs
              SET status = ?, result_json = NULL, failure_code = ?,
                  failure_message = ?, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(
          terminalStatus,
          failure.code,
          failure.message,
          fact.createdAt,
          input.ready.id,
          input.runId,
        );
      const failedRun = database
        .prepare(
          `UPDATE department_runs
              SET status = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(terminalStatus, fact.createdAt, input.runId);
      if (
        failedAttempt.changes !== 1 ||
        failedNode.changes !== 1 ||
        failedRun.changes !== 1
      ) {
        throw new PipelineRuntimeError(
          "EXECUTION_TERMINAL_CONFLICT",
          `Node Attempt ${claim.attemptId} cannot accept another terminal fact.`,
        );
      }
      database
        .prepare(
          `UPDATE execution_leases SET released_at = ?
            WHERE id = ? AND released_at IS NULL`,
        )
        .run(fact.createdAt, claim.leaseId);
      appendRuntimeMutation({
        action: fact.kind === "cancelled" ? "attempt.cancel" : "attempt.fail",
        entityType: "node-attempt",
        entityId: claim.attemptId,
        eventType:
          fact.kind === "cancelled" ? "attempt.interrupted" : "attempt.failed",
        runId: input.runId,
        nodeRunId: input.ready.id,
        before: { status: "running" },
        after: { status: terminalStatus, failure },
        createdAt: fact.createdAt,
      });
      appendExecutionEvent({
        type:
          fact.kind === "cancelled"
            ? "execution.cancelled"
            : "execution.failed",
        runId: input.runId,
        nodeRunId: input.ready.id,
        attemptId: claim.attemptId,
        payload: {
          operationKey: claim.operationKey,
          executionFactId: fact.id,
          status: fact.kind === "cancelled" ? "cancelled" : "failed",
          failureCode: failure.code,
        },
        createdAt: fact.createdAt,
      });
      return [];
    };
    const factSink = createExecutionFactSink({
      database,
      lease,
      target: lease.target,
      runId: input.runId,
      nodeRunId: input.ready.id,
      attemptId: claim.attemptId,
      now: clock,
      appendEvent: (event) =>
        appendExecutionEvent({
          ...event,
          runId: input.runId,
          nodeRunId: input.ready.id,
          attemptId: claim.attemptId,
          payload: event.payload,
          createdAt: event.timestamp,
        }),
      applyAcceptedFact: ({ envelope }) => applyAcceptedExecutionFact(envelope),
    });
    const sink = {
      record: async (fact: Parameters<typeof factSink.record>[0]) => {
        const receipt = await factSink.record(fact);
        if (fact.kind === "permission-request") {
          const permissionId = receipt.effectIds[0];
          const permission =
            permissionId && options.interaction
              ? options.interaction.inspectPermission(permissionId)
              : undefined;
          if (permission?.status === "pending") {
            throw new PipelineRuntimeError(
              "EXECUTION_PERMISSION_REQUIRED",
              `Execution is waiting for Permission ${permission.id}.`,
            );
          }
          const attempt = database
            .prepare(
              "SELECT status, failure_code AS failureCode FROM node_attempts WHERE id = ?",
            )
            .get(claim.attemptId) as
            | { readonly status: string; readonly failureCode: string | null }
            | undefined;
          if (
            attempt?.status === "failed" &&
            attempt.failureCode === "PERMISSION_DENIED"
          ) {
            throw new PipelineRuntimeError(
              "PERMISSION_DENIED",
              "Execution Profile denied the requested Permission.",
            );
          }
        }
        return receipt;
      },
    };
    let executionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const executionPromise = executionAdapter.execute(
        {
          runId: input.runId,
          nodeRunId: input.ready.id,
          node: input.node,
          signal: controller.signal,
          snapshot: runningView.snapshot.payload,
          memoryEntries: resolveMemoryEntries(
            runningView.snapshot.payload,
            input.node,
          ),
          request,
          attempt: {
            id: runningAttempt.id,
            attemptNumber: runningAttempt.attemptNumber,
            snapshotRevisionId: runningAttempt.snapshotRevisionId,
            reason: runningAttempt.reason,
            feedback: runningAttempt.feedback.map((feedback) => ({
              id: feedback.id,
              kind: feedback.kind,
              content: feedback.content,
            })),
            previousResult: previousSucceeded?.result ?? null,
            previousFailure: previousFailed?.failure ?? null,
          },
        },
        sink,
        controller.signal,
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        executionTimeoutHandle = setTimeout(() => {
          controller.abort();
          reject(
            new PipelineRuntimeError(
              "EXECUTION_TIMEOUT",
              `Execution exceeded the ${profile.limits.timeoutSeconds}s timeout.`,
            ),
          );
        }, profile.limits.timeoutSeconds * 1_000);
      });
      const fact = await Promise.race([executionPromise, timeoutPromise]);
      if (executionTimeoutHandle) clearTimeout(executionTimeoutHandle);
      if ("terminalExecutionFactId" in fact) {
        if (fact.operationKey !== request.operationKey) {
          throw new PipelineRuntimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "Execution Adapter returned a completion for another operation key.",
          );
        }
        const execution = inspectExecution(database, {
          operationKey: request.operationKey,
        });
        const terminal = execution.facts.find(
          (candidate) => candidate.id === fact.terminalExecutionFactId,
        );
        if (
          !terminal ||
          terminal.status !== "accepted" ||
          !["completed", "failed", "cancelled"].includes(terminal.kind) ||
          (fact.status === "succeeded" && terminal.kind !== "completed") ||
          (fact.status === "failed" && terminal.kind !== "failed") ||
          (fact.status === "cancelled" && terminal.kind !== "cancelled")
        ) {
          throw new PipelineRuntimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "Execution Adapter completion did not reference an accepted terminal Execution Fact.",
          );
        }
        return inspectRun(input.runId);
      }
      if (fact.kind === "failed") {
        return failClaimedAttempt({
          runId: input.runId,
          nodeRunId: input.ready.id,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          workerId,
          failure: {
            code: fact.code,
            message: fact.message,
            recoverable: true,
          },
        });
      }
      return completeClaimedAttempt({
        runId: input.runId,
        nodeRunId: input.ready.id,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerId,
        result: fact.structuredResult,
        artifacts: fact.artifacts,
        artifactProducer: input.node.positionId
          ? {
              snapshotRevisionId: runningAttempt.snapshotRevisionId,
              aiMemberId:
                runningView.snapshot.payload.positions.find(
                  (position) => position.id === input.node.positionId,
                )?.aiMember.id ?? "",
            }
          : undefined,
      });
    } catch (error) {
      if (error instanceof ExecutionFactError) {
        const currentAttempt = database
          .prepare("SELECT status FROM node_attempts WHERE id = ?")
          .get(claim.attemptId) as { readonly status: string } | undefined;
        if (currentAttempt?.status === "running") {
          failClaimedAttempt({
            runId: input.runId,
            nodeRunId: input.ready.id,
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
            workerId,
            failure: {
              code: error.code,
              message: error.message,
              recoverable: true,
            },
          });
        }
        throw error;
      }
      if (
        error instanceof PipelineRuntimeError &&
        error.code === "EXECUTION_TIMEOUT"
      ) {
        return failClaimedAttempt({
          runId: input.runId,
          nodeRunId: input.ready.id,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          workerId,
          failure: {
            code: "EXECUTION_TIMEOUT",
            message: error.message,
            recoverable: true,
          },
        });
      }
      if (
        error instanceof PipelineRuntimeError &&
        error.code === "EXECUTION_ADAPTER_PROTOCOL"
      ) {
        const currentAttempt = database
          .prepare("SELECT status FROM node_attempts WHERE id = ?")
          .get(claim.attemptId) as { readonly status: string } | undefined;
        if (currentAttempt?.status === "running") {
          failClaimedAttempt({
            runId: input.runId,
            nodeRunId: input.ready.id,
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
            workerId,
            failure: {
              code: error.code,
              message: error.message,
              recoverable: true,
            },
          });
        }
        throw error;
      }
      if (
        error instanceof PipelineRuntimeError &&
        ["EXECUTION_PERMISSION_REQUIRED", "PERMISSION_DENIED"].includes(
          error.code,
        )
      ) {
        return inspectRun(input.runId);
      }
      throw error;
    } finally {
      if (executionTimeoutHandle) clearTimeout(executionTimeoutHandle);
      clearInterval(leaseRenewalInterval);
      activeExecutions.delete(claim.attemptId);
      resolveDone();
    }
  };

  const executeReady = async (input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentRunView> => {
    const initial = inspectRun(input.runId);
    if (initial.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${initial.run.revision}.`,
      );
    }
    if (
      ["completed", "failed", "cancelled", "paused"].includes(
        initial.run.status,
      )
    ) {
      throw new PipelineRuntimeError(
        "RUN_STATE_INVALID",
        `Department Run ${input.runId} cannot execute from ${initial.run.status}.`,
      );
    }

    while (true) {
      const view = inspectRun(input.runId);
      if (
        ["completed", "failed", "waiting-approval"].includes(view.run.status)
      ) {
        return view;
      }
      const readyNodes = view.nodes.filter((node) => node.status === "ready");
      const ready = readyNodes[0];
      if (!ready) {
        throw new PipelineRuntimeError(
          "NODE_STATE_INVALID",
          `Department Run ${input.runId} has no Ready Node run.`,
        );
      }
      const node = view.snapshot.payload.pipelineVersion.graph.nodes.find(
        (candidate) => candidate.id === ready.pipelineNodeId,
      );
      if (!node) {
        throw new PipelineRuntimeError(
          "RUN_SNAPSHOT_INVALID",
          `Pipeline node ${ready.pipelineNodeId} is missing from the Run Snapshot.`,
        );
      }
      ensureHandlerAvailable(view, ready, node);

      if ((executionAdapter.maxConcurrentNodes ?? 1) > 1) {
        const concurrent = readyNodes
          .map((candidate) => ({
            ready: candidate,
            node: view.snapshot.payload.pipelineVersion.graph.nodes.find(
              (pipelineNode) => pipelineNode.id === candidate.pipelineNodeId,
            ),
          }))
          .filter(
            (
              candidate,
            ): candidate is {
              ready: ReadyNodeView;
              node: PipelineNode;
            } => candidate.node?.type === "ai-task",
          )
          .slice(0, view.snapshot.payload.runLimits.maxActiveNodes);
        if (concurrent.length > 1) {
          const results = await Promise.all(
            concurrent.map((candidate) =>
              executeAiTask({
                runId: input.runId,
                view,
                ready: candidate.ready,
                node: candidate.node,
              }),
            ),
          );
          const failed = results.find(
            (result) => result.run.status === "failed",
          );
          if (failed) return failed;
          continue;
        }
      }

      if (node.type === "start") {
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "succeeded",
          nextRunStatus: "running",
        });
        continue;
      }
      if (node.type === "complete") {
        const requiredContracts =
          view.snapshot.payload.department.outputArtifactContracts.filter(
            (contract) => contract.required,
          );
        const producedVersions =
          options.artifactRegistry?.listVersionsForRun(input.runId) ?? [];
        const missingContracts = requiredContracts.filter(
          (contract) =>
            !producedVersions.some(
              (version) =>
                version.type === contract.artifactType &&
                version.schemaVersion === contract.schemaVersion &&
                ["produced", "accepted"].includes(version.status),
            ),
        );
        if (missingContracts.length > 0) {
          const failure = {
            code: "ARTIFACT_CONTRACT_UNSATISFIED",
            message: `Complete requires Artifact Contracts: ${missingContracts
              .map((contract) => contract.id)
              .join(", ")}.`,
          };
          mutateNode({
            runId: input.runId,
            nodeRunId: ready.id,
            expectedNodeStatus: "ready",
            nextNodeStatus: "failed",
            nextRunStatus: "failed",
            failure,
          });
          return inspectRun(input.runId);
        }
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "succeeded",
          nextRunStatus: "completed",
        });
        return inspectRun(input.runId);
      }
      if (node.type === "human-approval") {
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "waiting-approval",
          nextRunStatus: "waiting-approval",
        });
        return inspectRun(input.runId);
      }
      if (node.type === "condition") {
        executeCondition(view, ready.id, node);
        continue;
      }
      if (node.type === "parallel") {
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "succeeded",
          nextRunStatus: "running",
        });
        continue;
      }
      if (node.type === "join") {
        const statuses = new Map(
          view.nodes.map((candidate) => [
            candidate.pipelineNodeId,
            candidate.status,
          ]),
        );
        const failedDependencyId = ready.requiredDependencyIds.find(
          (dependencyId) => statuses.get(dependencyId) === "failed",
        );
        if (failedDependencyId) {
          const failure = {
            code: "JOIN_DEPENDENCY_FAILED",
            message: `Join ${node.id} dependency ${failedDependencyId} failed.`,
          };
          mutateNode({
            runId: input.runId,
            nodeRunId: ready.id,
            expectedNodeStatus: "ready",
            nextNodeStatus: "failed",
            nextRunStatus: "failed",
            failure,
          });
          throw new PipelineRuntimeError(failure.code, failure.message);
        }
        if (
          !ready.requiredDependencyIds.every((dependencyId) =>
            ["succeeded", "skipped"].includes(statuses.get(dependencyId) ?? ""),
          )
        ) {
          throw new PipelineRuntimeError(
            "NODE_STATE_INVALID",
            `Join ${node.id} still has unfinished dependencies.`,
          );
        }
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "succeeded",
          nextRunStatus: "running",
        });
        continue;
      }
      if (node.type !== "ai-task") {
        const failure = {
          code: "NODE_STATE_INVALID",
          message: `Node type ${node.type} is outside the Phase 2 slice 1 tracer.`,
        };
        mutateNode({
          runId: input.runId,
          nodeRunId: ready.id,
          expectedNodeStatus: "ready",
          nextNodeStatus: "failed",
          nextRunStatus: "failed",
          failure,
        });
        throw new PipelineRuntimeError(failure.code, failure.message);
      }

      const result = await executeAiTask({
        runId: input.runId,
        view,
        ready,
        node,
      });
      if (
        ["failed", "cancelled"].includes(result.run.status) ||
        result.nodes.some(
          (candidate) => candidate.status === "waiting-permission",
        )
      ) {
        return result;
      }
    }
  };

  const defaultApprovalActor: ActorRef = {
    type: "human",
    id: "local-desktop-user",
    authenticatedBy: "local-session",
  };

  const assertEligibleApprovalActor = (
    approval: DepartmentRunView["nodes"][number]["approvals"][number],
    actor: ActorRef,
  ): void => {
    if (actor.type !== "human" || actor.authenticatedBy !== "local-session") {
      throw new PipelineRuntimeError(
        "APPROVAL_ACTOR_INVALID",
        "Human Approval decisions require a verified Human actor.",
      );
    }
    const policy = isRecord(approval.eligibleHumanPolicy)
      ? approval.eligibleHumanPolicy
      : {};
    if (
      policy.policy === "named" &&
      typeof policy.approverReference === "string" &&
      policy.approverReference !== actor.id
    ) {
      throw new PipelineRuntimeError(
        "APPROVAL_ACTOR_INELIGIBLE",
        `Human ${actor.id} is not eligible to decide Approval ${approval.id}.`,
      );
    }
  };

  const decideApproval = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
    readonly actor?: ActorRef;
    readonly commandId?: string;
  }): DepartmentRunView => {
    recoverExpiredApprovals();
    const current = inspectRun(input.runId);
    const approval = current.nodes.find((node) => node.id === input.nodeRunId);
    const latestRequest = approval?.approvals.at(-1);
    if (latestRequest?.status === "expired") {
      throw new PipelineRuntimeError(
        "APPROVAL_EXPIRED",
        `Approval ${latestRequest.id} expired before the decision was recorded.`,
      );
    }
    const actor = input.actor ?? defaultApprovalActor;
    const decisionHash = pipelineHash({
      decision: input.decision,
      feedback: input.feedback?.trim() ?? null,
      actor,
    });
    if (latestRequest?.status === "decided") {
      if (
        latestRequest.decision === input.decision &&
        (latestRequest.decisionCommandId === input.commandId ||
          latestRequest.decisionCommandId === null ||
          input.commandId === undefined)
      ) {
        return current;
      }
      throw new PipelineRuntimeError(
        "APPROVAL_DECISION_EXISTS",
        `Approval ${latestRequest.id} already has decision ${latestRequest.decision}.`,
      );
    }
    if (current.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
      );
    }
    if (
      current.run.status !== "waiting-approval" ||
      approval?.nodeType !== "human-approval" ||
      approval.status !== "waiting-approval"
    ) {
      throw new PipelineRuntimeError(
        "APPROVAL_STATE_INVALID",
        `Node Run ${input.nodeRunId} is not awaiting an approval decision.`,
      );
    }
    if (!latestRequest || latestRequest.status !== "pending") {
      throw new PipelineRuntimeError(
        "APPROVAL_STATE_INVALID",
        `Node Run ${input.nodeRunId} has no pending Approval.`,
      );
    }
    assertEligibleApprovalActor(latestRequest, actor);

    if (input.decision !== "request-changes" && input.feedback !== undefined) {
      throw new PipelineRuntimeError(
        "NODE_FEEDBACK_INVALID",
        "Feedback is only accepted with Request Changes.",
      );
    }

    if (input.decision === "request-changes") {
      const feedback = input.feedback?.trim() ?? "";
      if (feedback.length === 0 || feedback.length > 10_000) {
        throw new PipelineRuntimeError(
          "NODE_FEEDBACK_INVALID",
          "Request Changes feedback must contain between 1 and 10000 characters.",
        );
      }
      const targets = approval.requiredDependencyIds
        .map((dependencyId) =>
          current.nodes.find((node) => node.pipelineNodeId === dependencyId),
        )
        .filter((node) => node !== undefined);
      const target = targets.length === 1 ? targets[0] : undefined;
      if (
        !target ||
        target.nodeType !== "ai-task" ||
        target.status !== "succeeded"
      ) {
        throw new PipelineRuntimeError(
          "REQUEST_CHANGES_TARGET_INVALID",
          `Approval Node Run ${input.nodeRunId} must have one succeeded direct AI Task dependency.`,
        );
      }
      const pendingApproval = latestRequest;
      if (!pendingApproval) {
        throw new PipelineRuntimeError(
          "APPROVAL_STATE_INVALID",
          `Node Run ${input.nodeRunId} has no pending Approval.`,
        );
      }

      const now = clock().toISOString();
      const attemptId = randomUUID();
      const feedbackId = randomUUID();
      database.exec("BEGIN IMMEDIATE");
      try {
        const decided = database
          .prepare(
            `UPDATE approvals
                SET status = 'decided', decision = 'request-changes', decided_at = ?,
                    decision_actor_type = ?, decision_actor_id = ?,
                    decision_actor_authenticated_by = ?,
                    decision_command_id = ?, decision_hash = ?
              WHERE id = ? AND node_run_id = ? AND status = 'pending'
                AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .run(
            now,
            actor.type,
            actor.id,
            actor.authenticatedBy,
            input.commandId ?? null,
            decisionHash,
            pendingApproval.id,
            approval.id,
            now,
          );
        const targetReset = database
          .prepare(
            `UPDATE node_runs
                SET status = 'ready', attempt_count = attempt_count + 1,
                    result_json = NULL, failure_code = NULL,
                    failure_message = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND status = 'succeeded'`,
          )
          .run(now, target.id, input.runId);
        const approvalReset = database
          .prepare(
            `UPDATE node_runs
                SET status = 'queued', result_json = NULL,
                    failure_code = NULL, failure_message = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND status = 'waiting-approval'`,
          )
          .run(now, approval.id, input.runId);
        const runReset = database
          .prepare(
            `UPDATE department_runs
                SET status = 'running', revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ? AND status = 'waiting-approval'`,
          )
          .run(now, input.runId, input.expectedRevision);
        if (
          decided.changes === 0 ||
          targetReset.changes === 0 ||
          approvalReset.changes === 0 ||
          runReset.changes === 0
        ) {
          throw new PipelineRuntimeError(
            "APPROVAL_STATE_INVALID",
            `Department Run ${input.runId} changed before Request Changes could be recorded.`,
          );
        }
        database
          .prepare(
            `INSERT INTO node_attempts(
               id, node_run_id, attempt_number, snapshot_revision_id, reason,
               status, structured_result_json, failure_code, failure_message,
               created_at, started_at, completed_at
             ) VALUES (?, ?, ?, ?, 'request-changes', 'ready', NULL, NULL, NULL, ?, NULL, NULL)`,
          )
          .run(
            attemptId,
            target.id,
            target.attemptCount + 1,
            current.snapshot.id,
            now,
          );
        database
          .prepare(
            `INSERT INTO node_feedback(
               id, run_id, node_run_id, source_approval_id,
               target_attempt_id, kind, content, created_at
             ) VALUES (?, ?, ?, ?, ?, 'request-changes', ?, ?)`,
          )
          .run(
            feedbackId,
            input.runId,
            target.id,
            pendingApproval.id,
            attemptId,
            feedback,
            now,
          );
        appendRuntimeMutation({
          action: "approval.request-changes",
          entityType: "approval",
          entityId: pendingApproval.id,
          eventType: "approval.request-changes",
          runId: input.runId,
          nodeRunId: approval.id,
          before: { status: "pending" },
          after: {
            status: "decided",
            decision: "request-changes",
            targetNodeRunId: target.id,
            targetAttemptId: attemptId,
          },
          createdAt: now,
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectRun(input.runId);
    }

    mutateNode({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      expectedNodeStatus: "waiting-approval",
      nextNodeStatus: input.decision === "approve" ? "succeeded" : "failed",
      nextRunStatus: input.decision === "approve" ? "running" : "failed",
      approvalDecision: input.decision,
      approvalActor: actor,
      approvalCommandId: input.commandId,
      approvalDecisionHash: decisionHash,
      result: { decision: input.decision },
    });
    return inspectRun(input.runId);
  };

  const retryApproval: PipelineRuntime["retryApproval"] = (input) => {
    recoverExpiredApprovals();
    const current = inspectRun(input.runId);
    if (current.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
      );
    }
    const nodeRun = current.nodes.find((node) => node.id === input.nodeRunId);
    const expiredRequest = nodeRun?.approvals.at(-1);
    if (
      current.run.status !== "blocked" ||
      nodeRun?.nodeType !== "human-approval" ||
      nodeRun.status !== "failed" ||
      nodeRun.failure?.code !== "APPROVAL_EXPIRED" ||
      expiredRequest?.status !== "expired"
    ) {
      throw new PipelineRuntimeError(
        "APPROVAL_STATE_INVALID",
        `Node Run ${input.nodeRunId} has no expired Approval to retry.`,
      );
    }
    assertEligibleApprovalActor(expiredRequest, input.actor);
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const resetNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'waiting-approval', result_json = NULL,
                  failure_code = NULL, failure_message = NULL, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'failed'
              AND failure_code = 'APPROVAL_EXPIRED'`,
        )
        .run(now, input.nodeRunId, input.runId);
      const resetRun = database
        .prepare(
          `UPDATE department_runs
              SET status = 'waiting-approval', revision = revision + 1,
                  updated_at = ?
            WHERE id = ? AND revision = ? AND status = 'blocked'`,
        )
        .run(now, input.runId, input.expectedRevision);
      if (resetNode.changes !== 1 || resetRun.changes !== 1) {
        throw new PipelineRuntimeError(
          "APPROVAL_STATE_INVALID",
          `Department Run ${input.runId} changed before Approval retry.`,
        );
      }
      insertApprovalRequest({
        id: randomUUID(),
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        cycle: expiredRequest.cycle + 1,
        createdAt: now,
      });
      appendRuntimeMutation({
        action: "approval.retry",
        entityType: "approval",
        entityId: expiredRequest.id,
        eventType: "approval.requested",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: { status: "expired", cycle: expiredRequest.cycle },
        after: { status: "pending", cycle: expiredRequest.cycle + 1 },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(input.runId);
  };

  const retryNode = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly feedback?: string;
  }): DepartmentRunView => {
    const current = inspectRun(input.runId);
    if (current.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
      );
    }
    const nodeRun = current.nodes.find((node) => node.id === input.nodeRunId);
    const pipelineNode = nodeRun
      ? current.snapshot.payload.pipelineVersion.graph.nodes.find(
          (node) => node.id === nodeRun.pipelineNodeId,
        )
      : undefined;
    if (
      !["failed", "blocked"].includes(current.run.status) ||
      !nodeRun ||
      !["failed", "blocked"].includes(nodeRun.status) ||
      nodeRun.nodeType !== "ai-task" ||
      pipelineNode?.type !== "ai-task" ||
      !["failed", "interrupted"].includes(nodeRun.attempts.at(-1)?.status ?? "")
    ) {
      throw new PipelineRuntimeError(
        "RETRY_STATE_INVALID",
        `Node Run ${input.nodeRunId} is not a failed AI Task eligible for Retry.`,
      );
    }
    const feedback = input.feedback?.trim();
    if (
      input.feedback !== undefined &&
      (!feedback || feedback.length > 10_000)
    ) {
      throw new PipelineRuntimeError(
        "NODE_FEEDBACK_INVALID",
        "Retry feedback must contain between 1 and 10000 characters.",
      );
    }
    const profileId =
      pipelineNode.executionProfileId ??
      current.snapshot.payload.department.defaultExecutionProfileId;
    const profile = current.snapshot.payload.executionProfiles.find(
      (candidate) => candidate.id === profileId,
    );
    if (!profile) {
      throw new PipelineRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        `AI Task ${pipelineNode.id} has no resolved Execution Profile.`,
      );
    }
    const retryCount = nodeRun.attempts.filter(
      (attempt) => attempt.reason === "retry",
    ).length;
    const maxRetries =
      pipelineNode.retryMaxAttempts ?? profile.retryPolicy.maxAttempts;
    if (retryCount >= maxRetries) {
      throw new PipelineRuntimeError(
        "RETRY_LIMIT_EXCEEDED",
        `Node Run ${input.nodeRunId} has exhausted its ${maxRetries} Retry attempts.`,
      );
    }

    const now = new Date().toISOString();
    const attemptId = randomUUID();
    const feedbackId = feedback ? randomUUID() : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      const resetNode = database
        .prepare(
          `UPDATE node_runs
              SET status = 'ready', attempt_count = attempt_count + 1,
                  result_json = NULL, failure_code = NULL,
                  failure_message = NULL, updated_at = ?
            WHERE id = ? AND run_id = ? AND status IN ('failed', 'blocked')`,
        )
        .run(now, input.nodeRunId, input.runId);
      const joins = database
        .prepare(
          `SELECT id, required_dependency_ids_json AS requiredDependencyIdsJson
             FROM node_runs
            WHERE run_id = ? AND node_type = 'join' AND status = 'failed'
              AND failure_code = 'JOIN_DEPENDENCY_FAILED'`,
        )
        .all(input.runId) as Array<{
        readonly id: string;
        readonly requiredDependencyIdsJson: string;
      }>;
      const resetJoin = database.prepare(
        `UPDATE node_runs
            SET status = 'queued', failure_code = NULL,
                failure_message = NULL, updated_at = ?
          WHERE id = ? AND run_id = ? AND status = 'failed'`,
      );
      for (const join of joins) {
        const dependencies = parseJson(
          join.requiredDependencyIdsJson,
          `Join Node Run ${join.id} dependencies`,
        );
        if (
          Array.isArray(dependencies) &&
          dependencies.includes(nodeRun.pipelineNodeId)
        ) {
          resetJoin.run(now, join.id, input.runId);
        }
      }
      const run = database
        .prepare(
          `UPDATE department_runs
              SET status = 'recovering', revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ? AND status IN ('failed', 'blocked')`,
        )
        .run(now, input.runId, input.expectedRevision);
      if (resetNode.changes === 0 || run.changes === 0) {
        throw new PipelineRuntimeError(
          "RETRY_STATE_INVALID",
          `Department Run ${input.runId} changed before Retry could be recorded.`,
        );
      }
      database
        .prepare(
          `INSERT INTO node_attempts(
             id, node_run_id, attempt_number, snapshot_revision_id, reason,
             status, structured_result_json, failure_code, failure_message,
             created_at, started_at, completed_at
           ) VALUES (?, ?, ?, ?, 'retry', 'ready', NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          attemptId,
          input.nodeRunId,
          nodeRun.attemptCount + 1,
          current.snapshot.id,
          now,
        );
      if (feedbackId && feedback) {
        database
          .prepare(
            `INSERT INTO node_feedback(
               id, run_id, node_run_id, source_approval_id,
               target_attempt_id, kind, content, created_at
             ) VALUES (?, ?, ?, NULL, ?, 'retry', ?, ?)`,
          )
          .run(
            feedbackId,
            input.runId,
            input.nodeRunId,
            attemptId,
            feedback,
            now,
          );
      }
      appendRuntimeMutation({
        action: "node.retry",
        entityType: "node-attempt",
        entityId: attemptId,
        eventType: "attempt.ready",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        before: { nodeStatus: "failed", runStatus: "failed" },
        after: {
          status: "ready",
          reason: "retry",
          attemptNumber: nodeRun.attemptCount + 1,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return inspectRun(input.runId);
  };

  const decidePermission = (input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
    readonly actor: ActorRef;
    readonly commandId: string;
  }): PermissionRequestView => {
    if (!options.interaction) {
      throw new PipelineRuntimeError(
        "PERMISSION_RUNTIME_UNAVAILABLE",
        "Runtime Permission handling is unavailable.",
      );
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const permission =
        options.interaction.decidePermissionInTransaction(input);
      if (permission.runId && permission.nodeRunId) {
        const now = clock().toISOString();
        const waiting = database
          .prepare(
            `SELECT node_runs.status AS nodeStatus,
                    node_attempts.id AS attemptId,
                    node_attempts.status AS attemptStatus
               FROM node_runs
               JOIN node_attempts
                 ON node_attempts.node_run_id = node_runs.id
                AND node_attempts.attempt_number = (
                  SELECT MAX(attempt_number)
                    FROM node_attempts latest
                   WHERE latest.node_run_id = node_runs.id
                )
              WHERE node_runs.id = ? AND node_runs.run_id = ?`,
          )
          .get(permission.nodeRunId, permission.runId) as
          | {
              readonly nodeStatus: string;
              readonly attemptId: string;
              readonly attemptStatus: string;
            }
          | undefined;
        if (waiting?.nodeStatus === "waiting-permission") {
          if (permission.status === "approved") {
            const resetAttempt = database
              .prepare(
                `UPDATE node_attempts
                    SET status = 'ready', lease_id = NULL, lease_owner = NULL,
                        lease_expires_at = NULL, failure_code = NULL,
                        failure_message = NULL, recoverable = 0,
                        completed_at = NULL
                  WHERE id = ? AND status = 'running'`,
              )
              .run(waiting.attemptId);
            const resetNode = database
              .prepare(
                `UPDATE node_runs
                    SET status = 'ready', failure_code = NULL,
                        failure_message = NULL, updated_at = ?
                  WHERE id = ? AND status = 'waiting-permission'`,
              )
              .run(now, permission.nodeRunId);
            const resetRun = database
              .prepare(
                `UPDATE department_runs
                    SET status = 'running', revision = revision + 1,
                        updated_at = ?
                  WHERE id = ? AND status = 'running'`,
              )
              .run(now, permission.runId);
            if (
              resetAttempt.changes !== 1 ||
              resetNode.changes !== 1 ||
              resetRun.changes !== 1
            ) {
              throw new PipelineRuntimeError(
                "PERMISSION_STATE_INVALID",
                `Permission ${permission.id} changed before execution could resume.`,
              );
            }
            appendRuntimeMutation({
              action: "node.permission-approved",
              entityType: "node-run",
              entityId: permission.nodeRunId,
              eventType: "node.status.changed",
              runId: permission.runId,
              nodeRunId: permission.nodeRunId,
              before: { status: "waiting-permission" },
              after: { status: "ready", permissionId: permission.id },
              createdAt: now,
            });
          } else {
            const failAttempt = database
              .prepare(
                `UPDATE node_attempts
                    SET status = 'failed', failure_code = 'PERMISSION_DENIED',
                        failure_message = ?, recoverable = 0, completed_at = ?
                  WHERE id = ? AND status = 'running'`,
              )
              .run(
                `Permission ${permission.scope} was denied.`,
                now,
                waiting.attemptId,
              );
            const failNode = database
              .prepare(
                `UPDATE node_runs
                    SET status = 'failed', failure_code = 'PERMISSION_DENIED',
                        failure_message = ?, updated_at = ?
                  WHERE id = ? AND status = 'waiting-permission'`,
              )
              .run(
                `Permission ${permission.scope} was denied.`,
                now,
                permission.nodeRunId,
              );
            const failRun = database
              .prepare(
                `UPDATE department_runs
                    SET status = 'failed', revision = revision + 1,
                        updated_at = ?
                  WHERE id = ? AND status = 'running'`,
              )
              .run(now, permission.runId);
            if (
              failAttempt.changes !== 1 ||
              failNode.changes !== 1 ||
              failRun.changes !== 1
            ) {
              throw new PipelineRuntimeError(
                "PERMISSION_STATE_INVALID",
                `Permission ${permission.id} changed before denial could be applied.`,
              );
            }
            appendRuntimeMutation({
              action: "node.permission-denied",
              entityType: "node-run",
              entityId: permission.nodeRunId,
              eventType: "node.failed",
              runId: permission.runId,
              nodeRunId: permission.nodeRunId,
              before: { status: "waiting-permission" },
              after: {
                status: "failed",
                failure: { code: "PERMISSION_DENIED", scope: permission.scope },
              },
              createdAt: now,
            });
          }
        }
      }
      database.exec("COMMIT");
      return permission;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    formalizeRunInTransaction,
    replayForkInTransaction,
    recordProductReadinessInTransaction,
    promoteProductGateInTransaction,
    promoteTechnicalGateInTransaction,
    promoteMemorySelectionInTransaction,
    startFormalizedRun,
    startRun,
    forkRun,
    executeReady,
    controlRun,
    cancelNodeAttempt,
    requestNodeAttemptCancellationInTransaction,
    dispatchNodeAttemptCancellation,
    applyGovernedIntervention,
    recoverRun,
    claimReadyAttempt,
    recoverExpiredLeases,
    reconcilePendingExecutions,
    prepareForShutdown,
    recoverExpiredApprovals,
    renewAttemptLease,
    completeClaimedAttempt,
    failClaimedAttempt,
    releaseClaimedAttempt,
    decideApproval,
    retryApproval,
    retryNode,
    decidePermission,
    inspectRun,
    listRuns,
    auditRecords,
    runtimeEvents,
    runtimeEventsForConsumer,
    acknowledgeRuntimeEvents,
    inspectExecution: inspectExecutionForRuntime,
  };
};
