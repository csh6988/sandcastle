import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvents } from "../events/subscription.js";
import {
  StatisticsRuntimeError,
  type StatisticsRuntime,
} from "../statistics/statisticsRuntime.js";
import type {
  StatisticsEvidenceSnapshotView,
  StatisticsMetricObservation,
} from "../statistics/statisticsContracts.js";
import {
  ImprovementApplicationApplyRequestSchema,
  ImprovementApplicationValidateRequestSchema,
  ImprovementApplicationObservationSchema,
  ImprovementApplicationOperationViewSchema,
  ImprovementApplicationReceiptSchema,
  ImprovementApplicationReconciliationSchema,
  ImprovementApplicationRollbackRequestSchema,
  ImprovementApplicationRollbackViewSchema,
  ImprovementApplicationValidationSchema,
  ImprovementProposalRevisionContentSchema,
  ImprovementTargetSchema,
  type ImprovementApplicationApplyRequest,
  type ImprovementApplicationEffectAdapter,
  type ImprovementApplicationOperationView,
  type ImprovementApplicationRollbackRequest,
  type ImprovementApplicationState,
  type ImprovementApplicationValidateRequest,
  type ImprovementValidationActor,
  type ImprovementTarget,
} from "./improvementProposalContracts.js";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));
const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ImprovementApplicationRuntimeError(
      "STORAGE_CORRUPT",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

export class ImprovementApplicationRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImprovementApplicationRuntimeError";
  }
}

export interface ImprovementApplicationRuntime {
  readonly createInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementApplicationApplyRequest;
  }) => ImprovementApplicationOperationView;
  readonly validateInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementApplicationValidateRequest;
  }) => ImprovementApplicationOperationView;
  readonly rollbackInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementApplicationRollbackRequest;
  }) => ImprovementApplicationOperationView;
  readonly inspect: (
    operationId: string,
  ) => ImprovementApplicationOperationView;
  readonly list: (
    projectId: string,
  ) => readonly ImprovementApplicationOperationView[];
  readonly dispatch: (
    operationId: string,
  ) => Promise<ImprovementApplicationOperationView>;
  readonly reconcilePending: () => Promise<
    readonly ImprovementApplicationOperationView[]
  >;
  readonly prepareForShutdown: () => Promise<void>;
}

export const openImprovementApplicationRuntime = (
  database: DatabaseSync,
  options: {
    readonly statistics: StatisticsRuntime;
    readonly adapter: ImprovementApplicationEffectAdapter;
    readonly events: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
    readonly failureInjection?: (
      point: "after-intent" | "after-effect-before-finalize",
    ) => void;
  },
): ImprovementApplicationRuntime => {
  const clock = options.clock ?? (() => new Date());
  const active = new Map<
    string,
    Promise<ImprovementApplicationOperationView>
  >();
  let stopping = false;

  const transaction = <Value>(work: () => Value): Value => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const invalidate = (input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly proposalId: string;
    readonly state: ImprovementApplicationState;
    readonly timestamp: string;
    readonly commandId: string;
  }): void => {
    options.events.append({
      type: "improvement.application.invalidated",
      scope: {
        companyId: "company",
        projectId: input.projectId,
        improvementProposalId: input.proposalId,
        improvementApplicationOperationId: input.operationId,
        commandId: input.commandId,
      },
      payload: {
        applicationOperationId: input.operationId,
        proposalId: input.proposalId,
      },
      timestamp: input.timestamp,
    });
  };

  const appendAudit = (input: {
    readonly action: string;
    readonly operationId: string;
    readonly actor:
      | ImprovementApplicationApplyRequest["actor"]
      | ImprovementValidationActor;
    readonly before: unknown;
    readonly after: unknown;
    readonly timestamp: string;
    readonly commandId: string;
  }): void => {
    const context = database
      .prepare(
        `SELECT consumer_id AS consumerId
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as { readonly consumerId: string | null } | undefined;
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, 'improvement-application', ?, NULL, NULL, ?, ?, ?, ?,
                   ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.operationId,
        input.before === null ? null : canonicalJson(input.before),
        canonicalJson(input.after),
        input.timestamp,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
        context?.consumerId ?? null,
      );
  };

  const inspect = (
    operationId: string,
  ): ImprovementApplicationOperationView => {
    const row = database
      .prepare(
        `SELECT operation.id, operation.project_id AS projectId,
                operation.proposal_id AS proposalId,
                operation.proposal_revision_id AS proposalRevisionId,
                operation.proposal_revision_hash AS proposalRevisionHash,
                operation.approved_decision_id AS approvedDecisionId,
                operation.approved_decision_hash AS approvedDecisionHash,
                operation.target_kind AS targetKind,
                operation.target_owner_id AS targetOwnerId,
                operation.governed_head_revision_id AS governedHeadRevisionId,
                operation.governed_head_revision_hash AS governedHeadRevisionHash,
                operation.target_content_json AS targetContentJson,
                operation.canonical_request_hash AS canonicalRequestHash,
                operation.deterministic_effect_id AS deterministicEffectId,
                operation.confirmation, operation.reason,
                operation.evidence_refs_json AS evidenceRefsJson,
                operation.actor_id AS actorId,
                operation.created_at AS createdAt,
                projection.state, projection.latest_error_code AS latestErrorCode,
                projection.latest_error_message AS latestErrorMessage,
                projection.updated_at AS updatedAt
           FROM improvement_application_operations operation
           JOIN improvement_application_projections projection
             ON projection.operation_id = operation.id
          WHERE operation.id = ?`,
      )
      .get(operationId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly proposalId: string;
          readonly proposalRevisionId: string;
          readonly proposalRevisionHash: string;
          readonly approvedDecisionId: string;
          readonly approvedDecisionHash: string;
          readonly targetKind: ImprovementTarget["targetKind"];
          readonly targetOwnerId: string;
          readonly governedHeadRevisionId: string | null;
          readonly governedHeadRevisionHash: string | null;
          readonly targetContentJson: string;
          readonly canonicalRequestHash: string;
          readonly deterministicEffectId: string;
          readonly confirmation: string;
          readonly reason: string;
          readonly evidenceRefsJson: string;
          readonly actorId: string;
          readonly createdAt: string;
          readonly state: ImprovementApplicationState;
          readonly latestErrorCode: string | null;
          readonly latestErrorMessage: string | null;
          readonly updatedAt: string;
        }
      | undefined;
    if (!row) {
      throw new ImprovementApplicationRuntimeError(
        "IMPROVEMENT_APPLICATION_NOT_FOUND",
        `Improvement application operation ${operationId} was not found.`,
      );
    }
    const target = ImprovementTargetSchema.parse({
      targetKind: row.targetKind,
      ownerId: row.targetOwnerId,
      governedHead: {
        revisionId: row.governedHeadRevisionId,
        revisionHash: row.governedHeadRevisionHash,
      },
      content: parseJson(
        row.targetContentJson,
        `Improvement application ${operationId} target content`,
      ),
    });
    const receipts = (
      database
        .prepare(
          `SELECT id, phase, disposition,
                  target_revision_id AS targetRevisionId,
                  target_revision_hash AS targetRevisionHash,
                  evidence_refs_json AS evidenceRefsJson,
                  receipt_hash AS hash, created_at AS createdAt
             FROM improvement_application_receipts
            WHERE operation_id = ? ORDER BY created_at, rowid`,
        )
        .all(operationId) as Array<{
        readonly id: string;
        readonly phase: "apply" | "rollback";
        readonly disposition: "applied" | "no-op" | "failed";
        readonly targetRevisionId: string | null;
        readonly targetRevisionHash: string | null;
        readonly evidenceRefsJson: string;
        readonly hash: string;
        readonly createdAt: string;
      }>
    ).map((receipt) =>
      ImprovementApplicationReceiptSchema.parse({
        id: receipt.id,
        phase: receipt.phase,
        disposition: receipt.disposition,
        targetRevision:
          receipt.targetRevisionId && receipt.targetRevisionHash
            ? {
                revisionId: receipt.targetRevisionId,
                revisionHash: receipt.targetRevisionHash,
              }
            : null,
        evidenceRefs: parseJson(
          receipt.evidenceRefsJson,
          `Improvement application receipt ${receipt.id} evidence`,
        ),
        hash: receipt.hash,
        createdAt: receipt.createdAt,
      }),
    );
    const observations = (
      database
        .prepare(
          `SELECT id, phase, outcome, evidence_refs_json AS evidenceRefsJson,
                  observation_hash AS hash, observed_at AS observedAt
             FROM improvement_application_observations
            WHERE operation_id = ? ORDER BY observed_at, rowid`,
        )
        .all(operationId) as Array<{
        readonly id: string;
        readonly phase: "apply" | "rollback";
        readonly outcome:
          | "exact-match"
          | "proven-absent"
          | "conflict"
          | "insufficient-evidence";
        readonly evidenceRefsJson: string;
        readonly hash: string;
        readonly observedAt: string;
      }>
    ).map((observation) =>
      ImprovementApplicationObservationSchema.parse({
        id: observation.id,
        phase: observation.phase,
        outcome: observation.outcome,
        evidenceRefs: parseJson(
          observation.evidenceRefsJson,
          `Improvement application observation ${observation.id} evidence`,
        ),
        hash: observation.hash,
        observedAt: observation.observedAt,
      }),
    );
    const reconciliations = (
      database
        .prepare(
          `SELECT id, phase, result, evidence_refs_json AS evidenceRefsJson,
                  reconciliation_hash AS hash, created_at AS createdAt
             FROM improvement_application_reconciliations
            WHERE operation_id = ? ORDER BY created_at, rowid`,
        )
        .all(operationId) as Array<{
        readonly id: string;
        readonly phase: "apply" | "rollback";
        readonly result: "finalized" | "retry-permitted" | "unknown";
        readonly evidenceRefsJson: string;
        readonly hash: string;
        readonly createdAt: string;
      }>
    ).map((reconciliation) =>
      ImprovementApplicationReconciliationSchema.parse({
        id: reconciliation.id,
        phase: reconciliation.phase,
        result: reconciliation.result,
        evidenceRefs: parseJson(
          reconciliation.evidenceRefsJson,
          `Improvement application reconciliation ${reconciliation.id} evidence`,
        ),
        hash: reconciliation.hash,
        createdAt: reconciliation.createdAt,
      }),
    );
    const validations = (
      database
        .prepare(
          `SELECT id, before_evidence_snapshot_id AS beforeEvidenceId,
                  after_evidence_snapshot_id AS afterEvidenceId, outcome,
                  actor_type AS actorType, actor_id AS actorId,
                  authenticated_by AS authenticatedBy,
                  validation_hash AS hash, created_at AS createdAt
             FROM improvement_application_validations
            WHERE operation_id = ? ORDER BY created_at, rowid`,
        )
        .all(operationId) as Array<{
        readonly id: string;
        readonly beforeEvidenceId: string;
        readonly afterEvidenceId: string;
        readonly outcome: "improved" | "unchanged" | "regressed";
        readonly actorType: "human" | "runtime-worker";
        readonly actorId: string;
        readonly authenticatedBy: "local-session" | "runtime";
        readonly hash: string;
        readonly createdAt: string;
      }>
    ).map((validation) =>
      ImprovementApplicationValidationSchema.parse({
        id: validation.id,
        beforeEvidence: options.statistics.inspectEvidence(
          validation.beforeEvidenceId,
        ),
        afterEvidence: options.statistics.inspectEvidence(
          validation.afterEvidenceId,
        ),
        outcome: validation.outcome,
        hash: validation.hash,
        validatedBy: {
          type: validation.actorType,
          id: validation.actorId,
          authenticatedBy: validation.authenticatedBy,
        },
        createdAt: validation.createdAt,
      }),
    );
    const rollbacks = (
      database
        .prepare(
          `SELECT id, applied_revision_id AS appliedRevisionId,
                  applied_revision_hash AS appliedRevisionHash,
                  source_revision_id AS sourceRevisionId,
                  source_revision_hash AS sourceRevisionHash,
                  expected_governed_head_revision_id AS expectedHeadRevisionId,
                  expected_governed_head_revision_hash AS expectedHeadRevisionHash,
                  restoring_revision_id AS restoringRevisionId,
                  restoring_revision_hash AS restoringRevisionHash, state,
                  confirmation, reason,
                  evidence_refs_json AS evidenceRefsJson,
                  rollback_hash AS hash, actor_id AS actorId,
                  created_at AS createdAt
             FROM improvement_application_rollbacks
            WHERE operation_id = ? ORDER BY created_at, rowid`,
        )
        .all(operationId) as Array<{
        readonly id: string;
        readonly appliedRevisionId: string;
        readonly appliedRevisionHash: string;
        readonly sourceRevisionId: string;
        readonly sourceRevisionHash: string;
        readonly expectedHeadRevisionId: string;
        readonly expectedHeadRevisionHash: string;
        readonly restoringRevisionId: string | null;
        readonly restoringRevisionHash: string | null;
        readonly state: "requested" | "rolled-back" | "failed" | "unknown";
        readonly confirmation: string;
        readonly reason: string;
        readonly evidenceRefsJson: string;
        readonly hash: string;
        readonly actorId: string;
        readonly createdAt: string;
      }>
    ).map((rollback) =>
      ImprovementApplicationRollbackViewSchema.parse({
        id: rollback.id,
        appliedRevision: {
          revisionId: rollback.appliedRevisionId,
          revisionHash: rollback.appliedRevisionHash,
        },
        sourceRevision: {
          revisionId: rollback.sourceRevisionId,
          revisionHash: rollback.sourceRevisionHash,
        },
        expectedGovernedHead: {
          revisionId: rollback.expectedHeadRevisionId,
          revisionHash: rollback.expectedHeadRevisionHash,
        },
        restoringRevision:
          rollback.restoringRevisionId && rollback.restoringRevisionHash
            ? {
                revisionId: rollback.restoringRevisionId,
                revisionHash: rollback.restoringRevisionHash,
              }
            : null,
        state: rollback.state,
        confirmation: rollback.confirmation,
        reason: rollback.reason,
        evidenceRefs: parseJson(
          rollback.evidenceRefsJson,
          `Improvement application rollback ${rollback.id} evidence`,
        ),
        hash: rollback.hash,
        requestedBy: {
          type: "human",
          id: rollback.actorId,
          authenticatedBy: "local-session",
        },
        createdAt: rollback.createdAt,
      }),
    );
    const nextActions =
      row.state === "applied"
        ? (["validate", "rollback"] as const)
        : row.state === "validated"
          ? (["rollback"] as const)
          : row.state === "unknown" || row.state === "reconciling"
            ? (["reconcile"] as const)
            : ([] as const);
    return ImprovementApplicationOperationViewSchema.parse({
      id: row.id,
      projectId: row.projectId,
      proposalId: row.proposalId,
      proposalRevisionId: row.proposalRevisionId,
      proposalRevisionHash: row.proposalRevisionHash,
      approvedDecisionId: row.approvedDecisionId,
      approvedDecisionHash: row.approvedDecisionHash,
      target,
      canonicalRequestHash: row.canonicalRequestHash,
      state: row.state,
      deterministicEffectId: row.deterministicEffectId,
      confirmation: row.confirmation,
      reason: row.reason,
      evidenceRefs: parseJson(
        row.evidenceRefsJson,
        `Improvement application ${operationId} evidence`,
      ),
      appliedBy: {
        type: "human",
        id: row.actorId,
        authenticatedBy: "local-session",
      },
      latestError:
        row.latestErrorCode && row.latestErrorMessage
          ? { code: row.latestErrorCode, message: row.latestErrorMessage }
          : null,
      receipts,
      observations,
      reconciliations,
      validations,
      rollbacks,
      nextActions,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  };

  const list = (
    projectId: string,
  ): readonly ImprovementApplicationOperationView[] =>
    (
      database
        .prepare(
          `SELECT id FROM improvement_application_operations
            WHERE project_id = ? ORDER BY created_at, id`,
        )
        .all(projectId) as Array<{ readonly id: string }>
    ).map((row) => inspect(row.id));

  const createInTransaction: ImprovementApplicationRuntime["createInTransaction"] =
    (input) => {
      const request = ImprovementApplicationApplyRequestSchema.parse(
        input.request,
      );
      const { reconciliation, ...canonicalRequest } = request;
      const canonicalRequestJson = canonicalJson(canonicalRequest);
      const canonicalRequestHash = sha256(canonicalRequestJson);
      const existing = database
        .prepare(
          `SELECT canonical_request_hash AS canonicalRequestHash
             FROM improvement_application_operations WHERE id = ?`,
        )
        .get(request.operationId) as
        | { readonly canonicalRequestHash: string }
        | undefined;
      if (existing) {
        if (existing.canonicalRequestHash === canonicalRequestHash) {
          const operation = inspect(request.operationId);
          if (!reconciliation) return operation;
          if (reconciliation.expectedOperationHash !== canonicalRequestHash) {
            throw new ImprovementApplicationRuntimeError(
              "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
              `Improvement application ${operation.id} does not match the expected immutable operation hash.`,
            );
          }
          if (operation.state !== "unknown") {
            throw new ImprovementApplicationRuntimeError(
              "IMPROVEMENT_INVALID_STATE",
              `Improvement application ${operation.id} cannot reconcile from ${operation.state}.`,
            );
          }
          const reconciledAt = clock().toISOString();
          appendReconciliation({
            operationId: operation.id,
            result: "unknown",
            evidenceRefs: reconciliation.evidenceRefs,
            createdAt: reconciledAt,
          });
          setProjection({
            operationId: operation.id,
            state: "reconciling",
            error: null,
            updatedAt: reconciledAt,
          });
          appendAudit({
            action: "improvement.application.reconcile",
            operationId: operation.id,
            actor: request.actor,
            before: { state: operation.state },
            after: {
              state: "reconciling",
              reason: reconciliation.reason,
              evidenceRefs: reconciliation.evidenceRefs,
            },
            timestamp: reconciledAt,
            commandId: input.commandId,
          });
          invalidate({
            operationId: operation.id,
            projectId: operation.projectId,
            proposalId: operation.proposalId,
            state: "reconciling",
            timestamp: reconciledAt,
            commandId: input.commandId,
          });
          return inspect(operation.id);
        }
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
          `Improvement application operation ${request.operationId} already binds different input.`,
        );
      }
      if (reconciliation) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_INVALID_STATE",
          `Improvement application ${request.operationId} must exist in unknown state before reconciliation.`,
        );
      }
      const proposal = database
        .prepare(
          `SELECT project_id AS projectId, current_revision_id AS currentRevisionId,
                  state
             FROM improvement_proposals WHERE id = ?`,
        )
        .get(request.proposalId) as
        | {
            readonly projectId: string;
            readonly currentRevisionId: string;
            readonly state: string;
          }
        | undefined;
      if (!proposal) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_NOT_APPROVED",
          `Improvement proposal ${request.proposalId} was not found.`,
        );
      }
      if (
        proposal.currentRevisionId !== request.proposalRevisionId ||
        proposal.state !== "approved"
      ) {
        throw new ImprovementApplicationRuntimeError(
          proposal.currentRevisionId !== request.proposalRevisionId
            ? "IMPROVEMENT_PROPOSAL_SUPERSEDED"
            : "IMPROVEMENT_NOT_APPROVED",
          `Improvement proposal ${request.proposalId} is not the exact approved current revision.`,
        );
      }
      const revision = database
        .prepare(
          `SELECT content_json AS contentJson, content_hash AS contentHash
             FROM improvement_proposal_revisions
            WHERE proposal_id = ? AND id = ?`,
        )
        .get(request.proposalId, request.proposalRevisionId) as
        | { readonly contentJson: string; readonly contentHash: string }
        | undefined;
      if (
        !revision ||
        revision.contentHash !== request.expectedProposalRevisionHash
      ) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_PROPOSAL_SUPERSEDED",
          `Improvement proposal revision ${request.proposalRevisionId} no longer matches the approved hash.`,
        );
      }
      const revisionContent = parseJson(
        revision.contentJson,
        `Improvement proposal revision ${request.proposalRevisionId}`,
      ) as { readonly target?: unknown };
      const approvedTarget = ImprovementTargetSchema.parse(
        revisionContent.target,
      );
      if (canonicalJson(approvedTarget) !== canonicalJson(request.target)) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          "Improvement application target does not match the approved proposal revision.",
        );
      }
      const decision = database
        .prepare(
          `SELECT id, decision_hash AS decisionHash, decision
             FROM improvement_decisions
            WHERE proposal_id = ? AND proposal_revision_id = ?`,
        )
        .get(request.proposalId, request.proposalRevisionId) as
        | {
            readonly id: string;
            readonly decisionHash: string;
            readonly decision: "approved" | "rejected";
          }
        | undefined;
      if (
        !decision ||
        decision.decision !== "approved" ||
        decision.id !== request.approvedDecisionId ||
        decision.decisionHash !== request.expectedApprovedDecisionHash
      ) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_NOT_APPROVED",
          `Improvement proposal revision ${request.proposalRevisionId} lacks the exact approved decision.`,
        );
      }
      const createdAt = clock().toISOString();
      const deterministicEffectId = `improvement-effect:${sha256({
        operationId: request.operationId,
        targetKind: request.target.targetKind,
        phase: "apply",
      }).slice(0, 48)}`;
      database
        .prepare(
          `INSERT INTO improvement_application_operations(
             id, project_id, proposal_id, proposal_revision_id,
             proposal_revision_hash, approved_decision_id,
             approved_decision_hash, target_kind, target_owner_id,
             governed_head_revision_id, governed_head_revision_hash,
             target_content_json, target_content_hash, canonical_request_json,
             canonical_request_hash, deterministic_effect_id, confirmation,
             reason, evidence_refs_json, actor_type, actor_id, authenticated_by,
             command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'human', ?, 'local-session', ?, ?)`,
        )
        .run(
          request.operationId,
          proposal.projectId,
          request.proposalId,
          request.proposalRevisionId,
          request.expectedProposalRevisionHash,
          request.approvedDecisionId,
          request.expectedApprovedDecisionHash,
          request.target.targetKind,
          request.target.ownerId,
          request.target.governedHead.revisionId,
          request.target.governedHead.revisionHash,
          canonicalJson(request.target.content),
          sha256(request.target.content),
          canonicalRequestJson,
          canonicalRequestHash,
          deterministicEffectId,
          request.confirmation,
          request.reason,
          canonicalJson(request.evidenceRefs),
          request.actor.id,
          input.commandId,
          createdAt,
        );
      database
        .prepare(
          `INSERT INTO improvement_application_projections(
             operation_id, state, latest_error_code, latest_error_message,
             revision, updated_at
           ) VALUES (?, 'applying', NULL, NULL, 0, ?)`,
        )
        .run(request.operationId, createdAt);
      appendAudit({
        action: "improvement.application.apply",
        operationId: request.operationId,
        actor: request.actor,
        before: null,
        after: { state: "applying", deterministicEffectId },
        timestamp: createdAt,
        commandId: input.commandId,
      });
      invalidate({
        operationId: request.operationId,
        projectId: proposal.projectId,
        proposalId: request.proposalId,
        state: "applying",
        timestamp: createdAt,
        commandId: input.commandId,
      });
      return inspect(request.operationId);
    };

  const measurementValue = (
    observation: Extract<
      StatisticsMetricObservation,
      { readonly status: "available" }
    >,
  ): number => {
    switch (observation.measurement.kind) {
      case "count":
        return observation.measurement.value;
      case "duration":
        return observation.measurement.milliseconds;
      case "rate":
        return observation.measurement.value;
      case "concurrency":
        return observation.measurement.maximum;
    }
  };

  const windowDuration = (start: string, end: string): number =>
    new Date(end).getTime() - new Date(start).getTime();

  const comparableEvidence = (
    before: StatisticsEvidenceSnapshotView,
    after: StatisticsEvidenceSnapshotView,
  ): boolean =>
    before.query.catalogVersion === after.query.catalogVersion &&
    before.query.projectId === after.query.projectId &&
    canonicalJson(before.query.filters) ===
      canonicalJson(after.query.filters) &&
    canonicalJson(before.query.cohort) === canonicalJson(after.query.cohort) &&
    canonicalJson(before.query.comparisonSet) ===
      canonicalJson(after.query.comparisonSet) &&
    before.query.window.kind === after.query.window.kind &&
    windowDuration(
      before.query.window.startInclusive,
      before.query.window.endExclusive,
    ) ===
      windowDuration(
        after.query.window.startInclusive,
        after.query.window.endExclusive,
      );

  const validateInTransaction: ImprovementApplicationRuntime["validateInTransaction"] =
    (input) => {
      const request = ImprovementApplicationValidateRequestSchema.parse(
        input.request,
      );
      const operation = inspect(request.operationId);
      if (operation.canonicalRequestHash !== request.expectedOperationHash) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
          `Improvement application ${operation.id} does not match the expected immutable operation hash.`,
        );
      }
      if (operation.state !== "applied") {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_INVALID_STATE",
          `Improvement application ${operation.id} cannot be validated from ${operation.state}.`,
        );
      }
      const proposalRow = database
        .prepare(
          `SELECT content_json AS contentJson
             FROM improvement_proposal_revisions
            WHERE proposal_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.proposalId,
          operation.proposalRevisionId,
          operation.proposalRevisionHash,
        ) as { readonly contentJson: string } | undefined;
      if (!proposalRow) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_NOT_APPROVED",
          `Approved proposal revision ${operation.proposalRevisionId} is unavailable.`,
        );
      }
      const content = ImprovementProposalRevisionContentSchema.parse(
        parseJson(
          proposalRow.contentJson,
          `Improvement proposal revision ${operation.proposalRevisionId}`,
        ),
      );
      const beforeEvidence = content.evidence;
      let afterEvidence;
      try {
        afterEvidence = options.statistics.freezeInTransaction({
          commandId: input.commandId,
          evidenceSnapshotId: request.afterEvidenceSnapshotId,
          query: {
            catalogVersion: beforeEvidence.query.catalogVersion,
            projectId: beforeEvidence.query.projectId,
            filters: beforeEvidence.query.filters,
            window: request.afterWindow,
            cohort: beforeEvidence.query.cohort,
            comparisonSet: beforeEvidence.query.comparisonSet,
          },
          actor: request.actor,
        });
      } catch (error) {
        if (error instanceof StatisticsRuntimeError) {
          throw new ImprovementApplicationRuntimeError(
            error.code,
            error.message,
          );
        }
        throw error;
      }
      if (!comparableEvidence(beforeEvidence, afterEvidence)) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE",
          "Before and after Statistics evidence do not share the exact catalog, metric set, comparison set, cohort, filters, and window policy.",
        );
      }
      const directions = new Map(
        content.expectedMetrics.map((metric) => [
          metric.metricId,
          metric.direction,
        ]),
      );
      let improved = 0;
      let regressed = 0;
      for (const metricId of content.validationPolicy.metricIds) {
        const before = beforeEvidence.observations.find(
          (observation) => observation.metricId === metricId,
        );
        const after = afterEvidence.observations.find(
          (observation) => observation.metricId === metricId,
        );
        const direction = directions.get(metricId);
        if (
          !before ||
          !after ||
          before.status !== "available" ||
          after.status !== "available" ||
          !direction
        ) {
          throw new ImprovementApplicationRuntimeError(
            "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE",
            `Metric ${metricId} is not exactly comparable in both evidence snapshots.`,
          );
        }
        const beforeValue = measurementValue(before);
        const afterValue = measurementValue(after);
        if (direction === "hold") {
          if (afterValue !== beforeValue) regressed += 1;
        } else if (
          (direction === "increase" && afterValue > beforeValue) ||
          (direction === "decrease" && afterValue < beforeValue)
        ) {
          improved += 1;
        } else if (afterValue !== beforeValue) {
          regressed += 1;
        }
      }
      if (
        content.validationPolicy.metricIds.length <
        content.validationPolicy.minimumComparableObservations
      ) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE",
          "Comparable metric evidence does not satisfy the approved minimum.",
        );
      }
      const outcome =
        regressed > 0
          ? ("regressed" as const)
          : improved > 0
            ? ("improved" as const)
            : ("unchanged" as const);
      const createdAt = clock().toISOString();
      const record = {
        id: `improvement-validation:${randomUUID()}`,
        beforeEvidence,
        afterEvidence,
        outcome,
        validatedBy: request.actor,
        reason: request.reason,
        evidenceRefs: request.evidenceRefs,
        createdAt,
      };
      database
        .prepare(
          `INSERT INTO improvement_application_validations(
             id, operation_id, before_evidence_snapshot_id,
             before_evidence_snapshot_hash, after_evidence_snapshot_id,
             after_evidence_snapshot_hash, outcome, actor_type, actor_id,
             authenticated_by, validation_hash, command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          operation.id,
          beforeEvidence.id,
          beforeEvidence.hash,
          afterEvidence.id,
          afterEvidence.hash,
          outcome,
          request.actor.type,
          request.actor.id,
          request.actor.authenticatedBy,
          sha256(record),
          input.commandId,
          createdAt,
        );
      setProjection({
        operationId: operation.id,
        state: "validated",
        error: null,
        updatedAt: createdAt,
      });
      appendAudit({
        action: "improvement.application.validate",
        operationId: operation.id,
        actor: request.actor,
        before: { state: operation.state },
        after: {
          state: "validated",
          outcome,
          afterEvidenceHash: afterEvidence.hash,
        },
        timestamp: createdAt,
        commandId: input.commandId,
      });
      invalidate({
        operationId: operation.id,
        projectId: operation.projectId,
        proposalId: operation.proposalId,
        state: "validated",
        timestamp: createdAt,
        commandId: input.commandId,
      });
      return inspect(operation.id);
    };

  const appendObservation = (input: {
    readonly operationId: string;
    readonly phase?: "apply" | "rollback";
    readonly outcome:
      | "exact-match"
      | "proven-absent"
      | "conflict"
      | "insufficient-evidence";
    readonly evidenceRefs: readonly string[];
    readonly observedAt: string;
  }): void => {
    const record = {
      id: `improvement-observation:${randomUUID()}`,
      phase: input.phase ?? "apply",
      outcome: input.outcome,
      evidenceRefs: [...input.evidenceRefs],
      observedAt: input.observedAt,
    };
    database
      .prepare(
        `INSERT INTO improvement_application_observations(
           id, operation_id, phase, outcome, evidence_refs_json,
           observation_hash, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        input.operationId,
        record.phase,
        record.outcome,
        canonicalJson(record.evidenceRefs),
        sha256(record),
        record.observedAt,
      );
  };

  const appendReconciliation = (input: {
    readonly operationId: string;
    readonly phase?: "apply" | "rollback";
    readonly result: "finalized" | "retry-permitted" | "unknown";
    readonly evidenceRefs: readonly string[];
    readonly createdAt: string;
  }): void => {
    const record = {
      id: `improvement-reconciliation:${randomUUID()}`,
      phase: input.phase ?? "apply",
      result: input.result,
      evidenceRefs: [...input.evidenceRefs],
      createdAt: input.createdAt,
    };
    database
      .prepare(
        `INSERT INTO improvement_application_reconciliations(
           id, operation_id, phase, result, evidence_refs_json,
           reconciliation_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        input.operationId,
        record.phase,
        record.result,
        canonicalJson(record.evidenceRefs),
        sha256(record),
        record.createdAt,
      );
  };

  const appendReceipt = (input: {
    readonly operationId: string;
    readonly phase?: "apply" | "rollback";
    readonly disposition: "applied" | "no-op" | "failed";
    readonly targetRevision: {
      readonly revisionId: string;
      readonly revisionHash: string;
    } | null;
    readonly evidenceRefs: readonly string[];
    readonly createdAt: string;
  }): void => {
    const record = {
      id: `improvement-receipt:${randomUUID()}`,
      phase: input.phase ?? "apply",
      disposition: input.disposition,
      targetRevision: input.targetRevision,
      evidenceRefs: [...input.evidenceRefs],
      createdAt: input.createdAt,
    };
    database
      .prepare(
        `INSERT INTO improvement_application_receipts(
           id, operation_id, phase, disposition, target_revision_id,
           target_revision_hash, evidence_refs_json, receipt_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        input.operationId,
        record.phase,
        record.disposition,
        record.targetRevision?.revisionId ?? null,
        record.targetRevision?.revisionHash ?? null,
        canonicalJson(record.evidenceRefs),
        sha256(record),
        record.createdAt,
      );
  };

  const setProjection = (input: {
    readonly operationId: string;
    readonly state: ImprovementApplicationState;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly updatedAt: string;
  }): void => {
    database
      .prepare(
        `UPDATE improvement_application_projections
            SET state = ?, latest_error_code = ?, latest_error_message = ?,
                revision = revision + 1, updated_at = ?
          WHERE operation_id = ?`,
      )
      .run(
        input.state,
        input.error?.code ?? null,
        input.error?.message ?? null,
        input.updatedAt,
        input.operationId,
      );
  };

  const appendRollbackRecord = (input: {
    readonly operationId: string;
    readonly appliedRevision: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
    readonly sourceRevision: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
    readonly expectedGovernedHead: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
    readonly restoringRevision: {
      readonly revisionId: string;
      readonly revisionHash: string;
    } | null;
    readonly state: "requested" | "rolled-back" | "failed" | "unknown";
    readonly confirmation: string;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly actor: ImprovementApplicationRollbackRequest["actor"];
    readonly commandId: string;
    readonly createdAt: string;
  }): void => {
    const record = {
      id: `improvement-rollback:${randomUUID()}`,
      appliedRevision: input.appliedRevision,
      sourceRevision: input.sourceRevision,
      expectedGovernedHead: input.expectedGovernedHead,
      restoringRevision: input.restoringRevision,
      state: input.state,
      confirmation: input.confirmation,
      reason: input.reason,
      evidenceRefs: [...input.evidenceRefs],
      requestedBy: input.actor,
      createdAt: input.createdAt,
    };
    database
      .prepare(
        `INSERT INTO improvement_application_rollbacks(
           id, operation_id, applied_revision_id, applied_revision_hash,
           source_revision_id, source_revision_hash,
           expected_governed_head_revision_id,
           expected_governed_head_revision_hash, restoring_revision_id,
           restoring_revision_hash, state, confirmation, reason,
           evidence_refs_json, rollback_hash, actor_type, actor_id,
           authenticated_by, command_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?,
                   'local-session', ?, ?)`,
      )
      .run(
        record.id,
        input.operationId,
        record.appliedRevision.revisionId,
        record.appliedRevision.revisionHash,
        record.sourceRevision.revisionId,
        record.sourceRevision.revisionHash,
        record.expectedGovernedHead.revisionId,
        record.expectedGovernedHead.revisionHash,
        record.restoringRevision?.revisionId ?? null,
        record.restoringRevision?.revisionHash ?? null,
        record.state,
        record.confirmation,
        record.reason,
        canonicalJson(record.evidenceRefs),
        sha256(record),
        record.requestedBy.id,
        input.commandId,
        record.createdAt,
      );
  };

  const rollbackTarget = (
    operation: ImprovementApplicationOperationView,
    sourceRevision: {
      readonly revisionId: string;
      readonly revisionHash: string;
    },
  ): ImprovementTarget => {
    if (operation.target.targetKind === "project-spec") {
      const source = database
        .prepare(
          `SELECT content_json AS contentJson
             FROM project_spec_revisions
            WHERE project_spec_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.target.ownerId,
          sourceRevision.revisionId,
          sourceRevision.revisionHash,
        ) as { readonly contentJson: string } | undefined;
      if (!source) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Rollback source ${sourceRevision.revisionId} is not an exact Project Spec Revision.`,
        );
      }
      return ImprovementTargetSchema.parse({
        ...operation.target,
        content: parseJson(
          source.contentJson,
          `Project Spec rollback source ${sourceRevision.revisionId}`,
        ),
      });
    }
    if (operation.target.targetKind === "application-spec") {
      const source = database
        .prepare(
          `SELECT application_id AS applicationId, project_id AS projectId,
                  promoted_project_spec_revision_id AS promotedProjectSpecRevisionId,
                  promoted_project_spec_hash AS promotedProjectSpecHash,
                  content_json AS contentJson
             FROM application_spec_revisions
            WHERE application_spec_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.target.ownerId,
          sourceRevision.revisionId,
          sourceRevision.revisionHash,
        ) as
        | {
            readonly applicationId: string;
            readonly projectId: string;
            readonly promotedProjectSpecRevisionId: string;
            readonly promotedProjectSpecHash: string;
            readonly contentJson: string;
          }
        | undefined;
      if (!source) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Rollback source ${sourceRevision.revisionId} is not an exact Application Spec Revision.`,
        );
      }
      return ImprovementTargetSchema.parse({
        ...operation.target,
        content: {
          lineage: {
            projectId: source.projectId,
            applicationId: source.applicationId,
            promotedProjectSpecRevisionId: source.promotedProjectSpecRevisionId,
            promotedProjectSpecHash: source.promotedProjectSpecHash,
          },
          content: parseJson(
            source.contentJson,
            `Application Spec rollback source ${sourceRevision.revisionId}`,
          ),
        },
      });
    }
    if (operation.target.targetKind === "template") {
      const source = database
        .prepare(
          `SELECT manifest_json AS manifestJson
             FROM runtime_template_revisions
            WHERE owner_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.target.ownerId,
          sourceRevision.revisionId,
          sourceRevision.revisionHash,
        ) as { readonly manifestJson: string } | undefined;
      if (!source) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Rollback source ${sourceRevision.revisionId} is not an exact Runtime template revision.`,
        );
      }
      return ImprovementTargetSchema.parse({
        ...operation.target,
        content: {
          manifest: parseJson(
            source.manifestJson,
            `Runtime template rollback source ${sourceRevision.revisionId}`,
          ),
        },
      });
    }
    if (operation.target.targetKind === "skill-flow") {
      const source = database
        .prepare(
          `SELECT position_id AS positionId, name, instructions,
                  skill_ids_json AS skillIdsJson
             FROM governed_skill_flow_revisions
            WHERE owner_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.target.ownerId,
          sourceRevision.revisionId,
          sourceRevision.revisionHash,
        ) as
        | {
            readonly positionId: string;
            readonly name: string;
            readonly instructions: string;
            readonly skillIdsJson: string;
          }
        | undefined;
      if (!source) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          `Rollback source ${sourceRevision.revisionId} is not an exact governed Skill Flow revision.`,
        );
      }
      return ImprovementTargetSchema.parse({
        ...operation.target,
        content: {
          positionId: source.positionId,
          name: source.name,
          instructions: source.instructions,
          skillIds: parseJson(
            source.skillIdsJson,
            `Governed Skill Flow rollback source ${sourceRevision.revisionId}`,
          ),
        },
      });
    }
    const source = database
      .prepare(
        `SELECT content_json AS contentJson
           FROM governed_harness_revisions
          WHERE owner_id = ? AND id = ? AND content_hash = ?`,
      )
      .get(
        operation.target.ownerId,
        sourceRevision.revisionId,
        sourceRevision.revisionHash,
      ) as { readonly contentJson: string } | undefined;
    if (!source) {
      throw new ImprovementApplicationRuntimeError(
        "IMPROVEMENT_TARGET_CONFLICT",
        `Rollback source ${sourceRevision.revisionId} is not an exact governed Harness revision.`,
      );
    }
    return ImprovementTargetSchema.parse({
      ...operation.target,
      content: parseJson(
        source.contentJson,
        `Governed Harness rollback source ${sourceRevision.revisionId}`,
      ),
    });
  };

  const rollbackInTransaction: ImprovementApplicationRuntime["rollbackInTransaction"] =
    (input) => {
      const request = ImprovementApplicationRollbackRequestSchema.parse(
        input.request,
      );
      const operation = inspect(request.operationId);
      if (operation.canonicalRequestHash !== request.expectedOperationHash) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
          `Improvement application ${operation.id} does not match the expected immutable operation hash.`,
        );
      }
      const existing = operation.rollbacks.find(
        (rollback) => rollback.state === "requested",
      );
      if (existing) {
        const sameRequest =
          canonicalJson({
            appliedRevision: existing.appliedRevision,
            expectedGovernedHead: existing.expectedGovernedHead,
            rollbackSource: existing.sourceRevision,
            confirmation: existing.confirmation,
            reason: existing.reason,
            evidenceRefs: existing.evidenceRefs,
          }) ===
          canonicalJson({
            appliedRevision: request.appliedRevision,
            expectedGovernedHead: request.expectedGovernedHead,
            rollbackSource: request.rollbackSource,
            confirmation: request.confirmation,
            reason: request.reason,
            evidenceRefs: request.evidenceRefs,
          });
        if (!sameRequest) {
          throw new ImprovementApplicationRuntimeError(
            "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
            `Improvement application ${operation.id} already binds different rollback input.`,
          );
        }
        if (operation.state === "unknown") {
          const updatedAt = clock().toISOString();
          setProjection({
            operationId: operation.id,
            state: "reconciling",
            error: null,
            updatedAt,
          });
          invalidate({
            operationId: operation.id,
            projectId: operation.projectId,
            proposalId: operation.proposalId,
            state: "reconciling",
            timestamp: updatedAt,
            commandId: input.commandId,
          });
        }
        return inspect(operation.id);
      }
      if (operation.state !== "applied" && operation.state !== "validated") {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_INVALID_STATE",
          `Improvement application ${operation.id} cannot roll back from ${operation.state}.`,
        );
      }
      const appliedRevision = [...operation.receipts]
        .reverse()
        .find(
          (receipt) =>
            receipt.phase === "apply" && receipt.targetRevision !== null,
        )?.targetRevision;
      if (
        !appliedRevision ||
        canonicalJson(appliedRevision) !==
          canonicalJson(request.appliedRevision) ||
        canonicalJson(appliedRevision) !==
          canonicalJson(request.expectedGovernedHead)
      ) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          "Rollback must bind the exact applied revision as the expected governed head.",
        );
      }
      const proposalRow = database
        .prepare(
          `SELECT content_json AS contentJson
             FROM improvement_proposal_revisions
            WHERE proposal_id = ? AND id = ? AND content_hash = ?`,
        )
        .get(
          operation.proposalId,
          operation.proposalRevisionId,
          operation.proposalRevisionHash,
        ) as { readonly contentJson: string } | undefined;
      const proposalContent = proposalRow
        ? ImprovementProposalRevisionContentSchema.parse(
            parseJson(
              proposalRow.contentJson,
              `Improvement proposal revision ${operation.proposalRevisionId}`,
            ),
          )
        : null;
      if (
        !proposalContent ||
        canonicalJson(proposalContent.rollbackSource) !==
          canonicalJson(request.rollbackSource)
      ) {
        throw new ImprovementApplicationRuntimeError(
          "IMPROVEMENT_TARGET_CONFLICT",
          "Rollback source does not match the exact approved proposal revision.",
        );
      }
      rollbackTarget(operation, request.rollbackSource);
      const createdAt = clock().toISOString();
      appendRollbackRecord({
        operationId: operation.id,
        appliedRevision: request.appliedRevision,
        sourceRevision: request.rollbackSource,
        expectedGovernedHead: request.expectedGovernedHead,
        restoringRevision: null,
        state: "requested",
        confirmation: request.confirmation,
        reason: request.reason,
        evidenceRefs: request.evidenceRefs,
        actor: request.actor,
        commandId: input.commandId,
        createdAt,
      });
      setProjection({
        operationId: operation.id,
        state: "rollback-requested",
        error: null,
        updatedAt: createdAt,
      });
      appendAudit({
        action: "improvement.application.rollback",
        operationId: operation.id,
        actor: request.actor,
        before: { state: operation.state },
        after: {
          state: "rollback-requested",
          appliedRevision: request.appliedRevision,
          rollbackSource: request.rollbackSource,
        },
        timestamp: createdAt,
        commandId: input.commandId,
      });
      invalidate({
        operationId: operation.id,
        projectId: operation.projectId,
        proposalId: operation.proposalId,
        state: "rollback-requested",
        timestamp: createdAt,
        commandId: input.commandId,
      });
      return inspect(operation.id);
    };

  const applyWorker = async (
    operationId: string,
  ): Promise<ImprovementApplicationOperationView> => {
    const view = inspect(operationId);
    if (!["applying", "reconciling"].includes(view.state)) return view;
    if (stopping) return view;
    options.failureInjection?.("after-intent");
    const observation = await options.adapter.inspectEffect({
      operationId,
      target: view.target,
      phase: "apply",
    });
    const observedAt = clock().toISOString();
    if (observation.outcome === "exact-match") {
      return transaction(() => {
        appendObservation({
          operationId,
          outcome: observation.outcome,
          evidenceRefs: observation.evidenceRefs,
          observedAt,
        });
        appendReconciliation({
          operationId,
          result: "finalized",
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        appendReceipt({
          operationId,
          disposition: "no-op",
          targetRevision: observation.revision,
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        setProjection({
          operationId,
          state: "applied",
          error: null,
          updatedAt: observedAt,
        });
        invalidate({
          operationId,
          projectId: view.projectId,
          proposalId: view.proposalId,
          state: "applied",
          timestamp: observedAt,
          commandId: `${operationId}:reconcile-apply`,
        });
        return inspect(operationId);
      });
    }
    if (
      observation.outcome === "conflict" ||
      observation.outcome === "insufficient-evidence"
    ) {
      return transaction(() => {
        appendObservation({
          operationId,
          outcome: observation.outcome,
          evidenceRefs: observation.evidenceRefs,
          observedAt,
        });
        appendReconciliation({
          operationId,
          result: "unknown",
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        setProjection({
          operationId,
          state: "unknown",
          error: {
            code: "IMPROVEMENT_APPLICATION_UNKNOWN",
            message:
              "The governed target effect cannot be proven exactly and was not resent.",
          },
          updatedAt: observedAt,
        });
        invalidate({
          operationId,
          projectId: view.projectId,
          proposalId: view.proposalId,
          state: "unknown",
          timestamp: observedAt,
          commandId: `${operationId}:unknown-apply`,
        });
        return inspect(operationId);
      });
    }
    transaction(() => {
      appendObservation({
        operationId,
        outcome: "proven-absent",
        evidenceRefs: observation.evidenceRefs,
        observedAt,
      });
      appendReconciliation({
        operationId,
        result: "retry-permitted",
        evidenceRefs: observation.evidenceRefs,
        createdAt: observedAt,
      });
    });
    let result;
    try {
      result = await options.adapter.appendRevision({
        operationId,
        target: view.target,
        phase: "apply",
        expectedGovernedHead: view.target.governedHead,
      });
    } catch (error) {
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "IMPROVEMENT_TARGET_CONFLICT";
      const message =
        error instanceof Error
          ? error.message
          : "Governed revision append failed.";
      return transaction(() => {
        const failedAt = clock().toISOString();
        appendReceipt({
          operationId,
          disposition: "failed",
          targetRevision: null,
          evidenceRefs: observation.evidenceRefs,
          createdAt: failedAt,
        });
        setProjection({
          operationId,
          state: "apply-failed",
          error: { code, message },
          updatedAt: failedAt,
        });
        invalidate({
          operationId,
          projectId: view.projectId,
          proposalId: view.proposalId,
          state: "apply-failed",
          timestamp: failedAt,
          commandId: `${operationId}:failed-apply`,
        });
        return inspect(operationId);
      });
    }
    options.failureInjection?.("after-effect-before-finalize");
    return transaction(() => {
      const completedAt = clock().toISOString();
      appendReceipt({
        operationId,
        disposition: result.disposition,
        targetRevision: result.revision,
        evidenceRefs: result.evidenceRefs,
        createdAt: completedAt,
      });
      setProjection({
        operationId,
        state: "applied",
        error: null,
        updatedAt: completedAt,
      });
      invalidate({
        operationId,
        projectId: view.projectId,
        proposalId: view.proposalId,
        state: "applied",
        timestamp: completedAt,
        commandId: `${operationId}:completed-apply`,
      });
      return inspect(operationId);
    });
  };

  const rollbackWorker = async (
    operationId: string,
  ): Promise<ImprovementApplicationOperationView> => {
    const view = inspect(operationId);
    const rollback = [...view.rollbacks]
      .reverse()
      .find(
        (entry) => entry.state === "requested" || entry.state === "unknown",
      );
    if (!rollback || stopping) return view;
    let target: ImprovementTarget;
    try {
      target = rollbackTarget(view, rollback.sourceRevision);
    } catch (error) {
      const failedAt = clock().toISOString();
      return transaction(() => {
        appendRollbackRecord({
          operationId,
          appliedRevision: rollback.appliedRevision,
          sourceRevision: rollback.sourceRevision,
          expectedGovernedHead: rollback.expectedGovernedHead,
          restoringRevision: null,
          state: "failed",
          confirmation: rollback.confirmation,
          reason: rollback.reason,
          evidenceRefs: rollback.evidenceRefs,
          actor: rollback.requestedBy,
          commandId: `${operationId}:failed-rollback-source`,
          createdAt: failedAt,
        });
        setProjection({
          operationId,
          state: "rollback-failed",
          error: {
            code:
              error instanceof ImprovementApplicationRuntimeError
                ? error.code
                : "IMPROVEMENT_TARGET_CONFLICT",
            message:
              error instanceof Error
                ? error.message
                : "Rollback source is unavailable.",
          },
          updatedAt: failedAt,
        });
        return inspect(operationId);
      });
    }
    const observation = await options.adapter.inspectEffect({
      operationId,
      target,
      phase: "rollback",
    });
    const observedAt = clock().toISOString();
    if (observation.outcome === "exact-match") {
      return transaction(() => {
        appendObservation({
          operationId,
          phase: "rollback",
          outcome: observation.outcome,
          evidenceRefs: observation.evidenceRefs,
          observedAt,
        });
        appendReconciliation({
          operationId,
          phase: "rollback",
          result: "finalized",
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        appendReceipt({
          operationId,
          phase: "rollback",
          disposition: "no-op",
          targetRevision: observation.revision,
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        appendRollbackRecord({
          operationId,
          appliedRevision: rollback.appliedRevision,
          sourceRevision: rollback.sourceRevision,
          expectedGovernedHead: rollback.expectedGovernedHead,
          restoringRevision: observation.revision,
          state: "rolled-back",
          confirmation: rollback.confirmation,
          reason: rollback.reason,
          evidenceRefs: observation.evidenceRefs,
          actor: rollback.requestedBy,
          commandId: `${operationId}:reconciled-rollback`,
          createdAt: observedAt,
        });
        setProjection({
          operationId,
          state: "rolled-back",
          error: null,
          updatedAt: observedAt,
        });
        invalidate({
          operationId,
          projectId: view.projectId,
          proposalId: view.proposalId,
          state: "rolled-back",
          timestamp: observedAt,
          commandId: `${operationId}:reconciled-rollback`,
        });
        return inspect(operationId);
      });
    }
    if (
      observation.outcome === "conflict" ||
      observation.outcome === "insufficient-evidence"
    ) {
      return transaction(() => {
        appendObservation({
          operationId,
          phase: "rollback",
          outcome: observation.outcome,
          evidenceRefs: observation.evidenceRefs,
          observedAt,
        });
        appendReconciliation({
          operationId,
          phase: "rollback",
          result: "unknown",
          evidenceRefs: observation.evidenceRefs,
          createdAt: observedAt,
        });
        appendRollbackRecord({
          operationId,
          appliedRevision: rollback.appliedRevision,
          sourceRevision: rollback.sourceRevision,
          expectedGovernedHead: rollback.expectedGovernedHead,
          restoringRevision: null,
          state: "unknown",
          confirmation: rollback.confirmation,
          reason: rollback.reason,
          evidenceRefs: observation.evidenceRefs,
          actor: rollback.requestedBy,
          commandId: `${operationId}:unknown-rollback:${randomUUID()}`,
          createdAt: observedAt,
        });
        setProjection({
          operationId,
          state: "unknown",
          error: {
            code: "IMPROVEMENT_APPLICATION_UNKNOWN",
            message:
              "The restoring revision cannot be proven exactly and was not resent.",
          },
          updatedAt: observedAt,
        });
        return inspect(operationId);
      });
    }
    transaction(() => {
      appendObservation({
        operationId,
        phase: "rollback",
        outcome: "proven-absent",
        evidenceRefs: observation.evidenceRefs,
        observedAt,
      });
      appendReconciliation({
        operationId,
        phase: "rollback",
        result: "retry-permitted",
        evidenceRefs: observation.evidenceRefs,
        createdAt: observedAt,
      });
    });
    let result;
    try {
      result = await options.adapter.appendRevision({
        operationId,
        target,
        phase: "rollback",
        expectedGovernedHead: rollback.expectedGovernedHead,
      });
    } catch (error) {
      const failedAt = clock().toISOString();
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "IMPROVEMENT_TARGET_CONFLICT";
      const message =
        error instanceof Error ? error.message : "Restoring revision failed.";
      return transaction(() => {
        appendReceipt({
          operationId,
          phase: "rollback",
          disposition: "failed",
          targetRevision: null,
          evidenceRefs: observation.evidenceRefs,
          createdAt: failedAt,
        });
        appendRollbackRecord({
          operationId,
          appliedRevision: rollback.appliedRevision,
          sourceRevision: rollback.sourceRevision,
          expectedGovernedHead: rollback.expectedGovernedHead,
          restoringRevision: null,
          state: "failed",
          confirmation: rollback.confirmation,
          reason: rollback.reason,
          evidenceRefs: observation.evidenceRefs,
          actor: rollback.requestedBy,
          commandId: `${operationId}:failed-rollback`,
          createdAt: failedAt,
        });
        setProjection({
          operationId,
          state: "rollback-failed",
          error: { code, message },
          updatedAt: failedAt,
        });
        return inspect(operationId);
      });
    }
    options.failureInjection?.("after-effect-before-finalize");
    return transaction(() => {
      const completedAt = clock().toISOString();
      appendReceipt({
        operationId,
        phase: "rollback",
        disposition: result.disposition,
        targetRevision: result.revision,
        evidenceRefs: result.evidenceRefs,
        createdAt: completedAt,
      });
      appendRollbackRecord({
        operationId,
        appliedRevision: rollback.appliedRevision,
        sourceRevision: rollback.sourceRevision,
        expectedGovernedHead: rollback.expectedGovernedHead,
        restoringRevision: result.revision,
        state: "rolled-back",
        confirmation: rollback.confirmation,
        reason: rollback.reason,
        evidenceRefs: result.evidenceRefs,
        actor: rollback.requestedBy,
        commandId: `${operationId}:completed-rollback`,
        createdAt: completedAt,
      });
      setProjection({
        operationId,
        state: "rolled-back",
        error: null,
        updatedAt: completedAt,
      });
      invalidate({
        operationId,
        projectId: view.projectId,
        proposalId: view.proposalId,
        state: "rolled-back",
        timestamp: completedAt,
        commandId: `${operationId}:completed-rollback`,
      });
      return inspect(operationId);
    });
  };

  const worker = (
    operationId: string,
  ): Promise<ImprovementApplicationOperationView> => {
    const view = inspect(operationId);
    const rollback = view.rollbacks.at(-1);
    return view.state === "rollback-requested" ||
      ((view.state === "reconciling" || view.state === "unknown") &&
        rollback !== undefined)
      ? rollbackWorker(operationId)
      : applyWorker(operationId);
  };

  const dispatch = (
    operationId: string,
  ): Promise<ImprovementApplicationOperationView> => {
    const existing = active.get(operationId);
    if (existing) return existing;
    const run = worker(operationId).finally(() => active.delete(operationId));
    active.set(operationId, run);
    return run;
  };

  const reconcilePending = async (): Promise<
    readonly ImprovementApplicationOperationView[]
  > => {
    const ids = database
      .prepare(
        `SELECT operation_id AS id FROM improvement_application_projections
          WHERE state IN ('applying', 'rollback-requested', 'reconciling')
          ORDER BY updated_at, operation_id`,
      )
      .all() as Array<{ readonly id: string }>;
    const views: ImprovementApplicationOperationView[] = [];
    for (const row of ids) views.push(await dispatch(row.id));
    return views;
  };

  const prepareForShutdown = async (): Promise<void> => {
    stopping = true;
    for (const operationId of active.keys()) {
      transaction(() => {
        const view = inspect(operationId);
        if (view.state === "applying" || view.state === "rollback-requested") {
          const updatedAt = clock().toISOString();
          setProjection({
            operationId,
            state: "reconciling",
            error: null,
            updatedAt,
          });
          invalidate({
            operationId,
            projectId: view.projectId,
            proposalId: view.proposalId,
            state: "reconciling",
            timestamp: updatedAt,
            commandId: `${operationId}:shutdown-reconcile`,
          });
        }
      });
    }
    await Promise.all([...active.values()]);
  };

  return {
    createInTransaction,
    validateInTransaction,
    rollbackInTransaction,
    inspect,
    list,
    dispatch,
    reconcilePending,
    prepareForShutdown,
  };
};
