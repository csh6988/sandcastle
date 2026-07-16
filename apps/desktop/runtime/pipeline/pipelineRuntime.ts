import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRegisteredCompanyAgentId } from "../agent/agentCatalog.js";
import type { ExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import {
  ArtifactContractSchema,
  DepartmentPipelineGraphSchema,
  DepartmentRunViewSchema,
  RunSnapshotPayloadSchema,
  type DepartmentRunView,
  type RunSnapshotPayload,
} from "../interface.js";
import { canonicalPipelineJson, pipelineHash } from "./canonicalPipeline.js";

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
  readonly startRun: (input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
  }) => DepartmentRunView;
  readonly forkRun: (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly fromNodeRunId: string;
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
  }) => DepartmentRunView;
  readonly retryNode: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly feedback?: string;
  }) => DepartmentRunView;
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
}

interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly departmentId: string;
  readonly pipelineVersionId: string | null;
  readonly snapshotRevisionId: string | null;
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
  readonly status: "ready" | "running" | "succeeded" | "failed" | "cancelled";
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
  readonly status: "pending" | "decided";
  readonly decision: "approve" | "request-changes" | "reject" | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
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
  } = {},
): PipelineRuntime => {
  const clock = options.clock ?? (() => new Date());
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
    readonly runId?: string;
    readonly nodeRunId?: string;
    readonly before?: unknown;
    readonly after: unknown;
    readonly createdAt: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    database
      .prepare(
        `INSERT INTO runtime_event_outbox(
           event_id, type, run_id, node_run_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.eventType,
        input.runId ?? null,
        input.nodeRunId ?? null,
        JSON.stringify(input.after),
        input.createdAt,
      );
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
  const readRunRow = (runId: string): RunRow => {
    const row = database
      .prepare(
        `SELECT id,
                project_id AS projectId,
                department_id AS departmentId,
                pipeline_version_id AS pipelineVersionId,
                snapshot_revision_id AS snapshotRevisionId,
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
                created_at AS createdAt, decided_at AS decidedAt
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

    return DepartmentRunViewSchema.parse({
      run: {
        id: run.id,
        projectId: run.projectId,
        departmentId: run.departmentId,
        pipelineVersionId: run.pipelineVersionId,
        snapshotRevisionId: run.snapshotRevisionId,
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
      nodes: nodeRows
        .map((node) => ({
          id: node.id,
          runId: node.runId,
          pipelineNodeId: node.pipelineNodeId,
          nodeType: node.nodeType,
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
              createdAt: approval.createdAt,
              decidedAt: approval.decidedAt,
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
                graph_json AS graphJson, hash
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
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, result_json, failure_code,
           failure_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)`,
      );
      for (const node of payload.pipelineVersion.graph.nodes) {
        const dependencies = dependenciesByNode.get(node.id) ?? [];
        insertNode.run(
          randomUUID(),
          runId,
          node.id,
          node.type,
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

  const forkRun = (input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly fromNodeRunId: string;
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
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, result_json, failure_code,
           failure_message, created_at, updated_at, source_node_run_id
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
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
        insertNode.run(
          randomUUID(),
          runId,
          node.id,
          node.type,
          preserved ? sourceNode!.status : ready ? "ready" : "queued",
          JSON.stringify(dependencies),
          preserved ? JSON.stringify(sourceNode?.result ?? null) : null,
          now,
          now,
          preserved ? sourceNode!.id : null,
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
        after: { status: "ready", preservedPipelineNodeIds: [...preservedIds] },
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
                  node_attempts.snapshot_revision_id AS snapshotRevisionId
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
                  lease_expires_at = ?, started_at = COALESCE(started_at, ?)
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
                  recoverable = 0, completed_at = ?
            WHERE id = ? AND node_run_id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          input.result === undefined ? null : JSON.stringify(input.result),
          now,
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
                  completed_at = ?
            WHERE id = ? AND node_run_id = ? AND status = 'running'
              AND lease_id = ? AND lease_owner = ?
              AND lease_expires_at > ?`,
        )
        .run(
          input.failure.code,
          input.failure.message,
          input.failure.recoverable ? 1 : 0,
          now,
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
                  node_runs.run_id AS runId
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
      }>;
      const failure = {
        code: "ATTEMPT_LEASE_EXPIRED",
        message:
          "The scheduler lease expired before the Node Attempt completed.",
      };
      const failAttempt = database.prepare(
        `UPDATE node_attempts
            SET status = 'failed', recoverable = 1, failure_code = ?,
                failure_message = ?, completed_at = ?
          WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
      );
      const failNode = database.prepare(
        `UPDATE node_runs
            SET status = 'failed', failure_code = ?, failure_message = ?,
                updated_at = ?
          WHERE id = ? AND run_id = ? AND status = 'running'`,
      );
      const affectedRunIds = new Set<string>();
      let recovered = 0;
      for (const item of expired) {
        const attempt = failAttempt.run(
          failure.code,
          failure.message,
          now,
          item.attemptId,
          now,
        );
        if (attempt.changes !== 1) continue;
        const node = failNode.run(
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
        appendRuntimeMutation({
          action: "attempt.lease-expire",
          entityType: "node-attempt",
          entityId: item.attemptId,
          eventType: "attempt.failed",
          runId: item.runId,
          nodeRunId: item.nodeRunId,
          before: { status: "running" },
          after: { status: "failed", recoverable: true, failure },
          createdAt: now,
        });
        recovered += 1;
        affectedRunIds.add(item.runId);
      }
      const failRun = database.prepare(
        `UPDATE department_runs
            SET status = 'failed', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'recovering')`,
      );
      for (const runId of affectedRunIds) {
        if (failRun.run(now, runId).changes !== 1) {
          throw new PipelineRuntimeError(
            "LEASE_CONFLICT",
            `Department Run ${runId} changed before lease expiry recovery completed.`,
          );
        }
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
    readonly result?: unknown;
    readonly failure?: { readonly code: string; readonly message: string };
  }): void => {
    const now = new Date().toISOString();
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
        database
          .prepare(
            `INSERT INTO approvals(
               id, run_id, node_run_id, cycle, status, decision,
               created_at, decided_at
             ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
          )
          .run(
            randomUUID(),
            input.runId,
            input.nodeRunId,
            Number(cycle.nextCycle),
            now,
          );
      }
      if (input.approvalDecision) {
        const decided = database
          .prepare(
            `UPDATE approvals
                SET status = 'decided', decision = ?, decided_at = ?
              WHERE id = (
                SELECT id FROM approvals
                 WHERE node_run_id = ? AND status = 'pending'
                 ORDER BY cycle DESC
                 LIMIT 1
              )`,
          )
          .run(input.approvalDecision, now, input.nodeRunId);
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
        `UPDATE node_runs SET status = 'skipped', updated_at = ?
          WHERE run_id = ? AND pipeline_node_id = ?
            AND status IN ('queued', 'ready')`,
      );
      for (const skippedNodeId of skippedNodeIds) {
        skipNode.run(now, view.run.id, skippedNodeId);
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
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
              ) AND status IN ('ready', 'running')`,
          )
          .run(now, input.runId);
        database
          .prepare(
            `UPDATE node_runs
                SET status = 'cancelled', updated_at = ?
              WHERE run_id = ? AND status IN (
                'queued', 'ready', 'running', 'waiting-permission',
                'waiting-approval', 'paused'
              )`,
          )
          .run(now, input.runId);
        const cancelled = database
          .prepare(
            `UPDATE department_runs
                SET status = 'cancelled', paused_from_status = NULL,
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
      for (const execution of active) execution.controller.abort();
      await Promise.all(active.map((execution) => execution.done));
      if (input.action === "pause" && active.length > 0) {
        const nowAfterAbort = clock().toISOString();
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const execution of active) {
            database
              .prepare(
                `UPDATE node_attempts
                    SET status = 'failed', recoverable = 1,
                        failure_code = 'ATTEMPT_PAUSED',
                        failure_message = 'The Node Attempt was paused before completion.',
                        completed_at = ?
                  WHERE id = ? AND status = 'running'`,
              )
              .run(nowAfterAbort, execution.attemptId);
            database
              .prepare(
                `UPDATE node_runs
                    SET status = 'failed',
                        failure_code = 'ATTEMPT_PAUSED',
                        failure_message = 'The Node Attempt was paused before completion.',
                        updated_at = ?
                  WHERE id = (
                    SELECT node_run_id FROM node_attempts WHERE id = ?
                  ) AND status = 'running'`,
              )
              .run(nowAfterAbort, execution.attemptId);
          }
          database
            .prepare(
              `UPDATE department_runs
                  SET revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'paused'`,
            )
            .run(nowAfterAbort, input.runId);
          appendRuntimeMutation({
            action: "run.pause.interrupt",
            entityType: "department-run",
            entityId: input.runId,
            eventType: "attempt.interrupted",
            runId: input.runId,
            before: { activeAttempts: active.map((item) => item.attemptId) },
            after: { status: "paused", failureCode: "ATTEMPT_PAUSED" },
            createdAt: nowAfterAbort,
          });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
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
      !["failed", "recovering"].includes(current.run.status) ||
      !nodeRun ||
      nodeRun.status !== "failed" ||
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
    database.exec("BEGIN IMMEDIATE");
    try {
      const run = database
        .prepare(
          `UPDATE department_runs
              SET status = 'recovering', snapshot_revision_id = ?,
                  revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ? AND status IN ('failed', 'recovering')`,
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
            WHERE id = ? AND run_id = ? AND status = 'failed'`,
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
    try {
      const fact = await executionAdapter.execute({
        runId: input.runId,
        nodeRunId: input.ready.id,
        node: input.node,
        signal: controller.signal,
        snapshot: runningView.snapshot.payload,
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
      });
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
    } finally {
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
      if (result.run.status === "failed") return result;
    }
  };

  const decideApproval = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
  }): DepartmentRunView => {
    const current = inspectRun(input.runId);
    if (current.run.revision !== input.expectedRevision) {
      throw new PipelineRuntimeError(
        "VERSION_CONFLICT",
        `Department Run revision ${input.expectedRevision} does not match current revision ${current.run.revision}.`,
      );
    }
    const approval = current.nodes.find((node) => node.id === input.nodeRunId);
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
      const pendingApproval = approval.approvals.find(
        (candidate) => candidate.status === "pending",
      );
      if (!pendingApproval) {
        throw new PipelineRuntimeError(
          "APPROVAL_STATE_INVALID",
          `Node Run ${input.nodeRunId} has no pending Approval.`,
        );
      }

      const now = new Date().toISOString();
      const attemptId = randomUUID();
      const feedbackId = randomUUID();
      database.exec("BEGIN IMMEDIATE");
      try {
        const decided = database
          .prepare(
            `UPDATE approvals
                SET status = 'decided', decision = 'request-changes', decided_at = ?
              WHERE id = ? AND node_run_id = ? AND status = 'pending'`,
          )
          .run(now, pendingApproval.id, approval.id);
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
      result: { decision: input.decision },
    });
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
      current.run.status !== "failed" ||
      !nodeRun ||
      nodeRun.status !== "failed" ||
      nodeRun.nodeType !== "ai-task" ||
      pipelineNode?.type !== "ai-task"
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
            WHERE id = ? AND run_id = ? AND status = 'failed'`,
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
            WHERE id = ? AND revision = ? AND status = 'failed'`,
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

  return {
    startRun,
    forkRun,
    executeReady,
    controlRun,
    recoverRun,
    claimReadyAttempt,
    recoverExpiredLeases,
    renewAttemptLease,
    completeClaimedAttempt,
    failClaimedAttempt,
    releaseClaimedAttempt,
    decideApproval,
    retryNode,
    inspectRun,
    listRuns,
    auditRecords,
    runtimeEvents,
    runtimeEventsForConsumer,
    acknowledgeRuntimeEvents,
  };
};
