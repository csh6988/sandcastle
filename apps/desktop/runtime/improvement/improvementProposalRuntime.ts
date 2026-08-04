import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvents } from "../events/subscription.js";
import {
  ImprovementProposalCreateRequestSchema,
  ImprovementProposalDecideRequestSchema,
  ImprovementProposalDecisionSchema,
  ImprovementProposalRequestDecisionRequestSchema,
  ImprovementProposalReviseRequestSchema,
  ImprovementProposalRevisionContentSchema,
  ImprovementProposalTransitionRequestSchema,
  ImprovementProposalViewSchema,
  type ImprovementProposalCreateRequest,
  type ImprovementProposalDecideRequest,
  type ImprovementProposalRequestDecisionRequest,
  type ImprovementProposalRevisionContent,
  type ImprovementProposalReviseRequest,
  type ImprovementProposalState,
  type ImprovementProposalTransitionRequest,
  type ImprovementProposalView,
} from "./improvementProposalContracts.js";
import {
  StatisticsRuntimeError,
  type StatisticsRuntime,
} from "../statistics/statisticsRuntime.js";

export class ImprovementProposalRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImprovementProposalRuntimeError";
  }
}

export interface ImprovementProposalRuntime {
  readonly createInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementProposalCreateRequest;
  }) => ImprovementProposalView;
  readonly reviseInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementProposalReviseRequest;
  }) => ImprovementProposalView;
  readonly transitionInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementProposalTransitionRequest;
    readonly state: "proposed" | "awaiting-human";
  }) => ImprovementProposalView;
  readonly requestDecisionInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementProposalRequestDecisionRequest;
  }) => ImprovementProposalView;
  readonly decideInTransaction: (input: {
    readonly commandId: string;
    readonly request: ImprovementProposalDecideRequest;
  }) => ImprovementProposalView;
  readonly inspect: (proposalId: string) => ImprovementProposalView;
  readonly list: (projectId: string) => readonly ImprovementProposalView[];
}

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

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ImprovementProposalRuntimeError(
      "STORAGE_CORRUPT",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

export const openImprovementProposalRuntime = (
  database: DatabaseSync,
  options: {
    readonly statistics: StatisticsRuntime;
    readonly events: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): ImprovementProposalRuntime => {
  const clock = options.clock ?? (() => new Date());

  const validateEvidence = (
    projectId: string,
    content: ImprovementProposalRevisionContent,
  ): ImprovementProposalRevisionContent => {
    const parsed = ImprovementProposalRevisionContentSchema.parse(content);
    let frozen;
    try {
      frozen = options.statistics.inspectEvidence(parsed.evidence.id);
    } catch (error) {
      if (
        error instanceof StatisticsRuntimeError &&
        error.code === "STATISTICS_EVIDENCE_NOT_FOUND"
      ) {
        throw new ImprovementProposalRuntimeError(
          "STATISTICS_EVIDENCE_STALE",
          `Statistics evidence ${parsed.evidence.id} is not an authoritative frozen snapshot.`,
        );
      }
      throw error;
    }
    if (
      frozen.query.projectId !== projectId ||
      canonicalJson(frozen) !== canonicalJson(parsed.evidence)
    ) {
      throw new ImprovementProposalRuntimeError(
        "STATISTICS_EVIDENCE_STALE",
        `Statistics evidence ${parsed.evidence.id} does not match the authoritative frozen snapshot.`,
      );
    }
    const requiredMetricIds = new Set([
      ...parsed.expectedMetrics.map((metric) => metric.metricId),
      ...parsed.validationPolicy.metricIds,
    ]);
    const unavailableRequiredMetricIds = [...requiredMetricIds].filter(
      (metricId) =>
        frozen.observations.find(
          (observation) => observation.metricId === metricId,
        )?.status !== "available",
    );
    if (unavailableRequiredMetricIds.length > 0) {
      throw new ImprovementProposalRuntimeError(
        "STATISTICS_EVIDENCE_UNAVAILABLE",
        `Statistics evidence ${parsed.evidence.id} does not contain available observations for ${unavailableRequiredMetricIds.join(
          ", ",
        )}.`,
      );
    }
    return parsed;
  };

  const appendAuditAndInvalidation = (input: {
    readonly commandId: string;
    readonly action: string;
    readonly proposalId: string;
    readonly proposalRevisionId: string;
    readonly projectId: string;
    readonly actor: ImprovementProposalCreateRequest["actor"];
    readonly createdAt: string;
    readonly before: unknown;
    readonly after: unknown;
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
         ) VALUES (?, ?, 'improvement-proposal', ?, NULL, NULL, ?, ?, ?, ?, ?,
                   ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.proposalId,
        input.before === null ? null : canonicalJson(input.before),
        canonicalJson(input.after),
        input.createdAt,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
        context?.consumerId ?? null,
      );
    options.events.append({
      type: "improvement.proposal.invalidated",
      scope: {
        companyId: "company",
        projectId: input.projectId,
        improvementProposalId: input.proposalId,
        commandId: input.commandId,
      },
      payload: {
        proposalId: input.proposalId,
        proposalRevisionId: input.proposalRevisionId,
      },
      timestamp: input.createdAt,
    });
  };

  const inspect = (proposalId: string): ImprovementProposalView => {
    const proposal = database
      .prepare(
        `SELECT id, project_id AS projectId, department_id AS departmentId,
                current_revision_id AS currentRevisionId, state,
                created_at AS createdAt, updated_at AS updatedAt
           FROM improvement_proposals WHERE id = ?`,
      )
      .get(proposalId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly departmentId: string | null;
          readonly currentRevisionId: string;
          readonly state: ImprovementProposalState;
          readonly createdAt: string;
          readonly updatedAt: string;
        }
      | undefined;
    if (!proposal) {
      throw new ImprovementProposalRuntimeError(
        "IMPROVEMENT_PROPOSAL_NOT_FOUND",
        `Improvement proposal ${proposalId} was not found.`,
      );
    }
    const revisions = (
      database
        .prepare(
          `SELECT id, revision, supersedes_revision_id AS supersedesRevisionId,
                  content_json AS contentJson, content_hash AS contentHash,
                  authored_by_actor_type AS actorType,
                  authored_by_actor_id AS actorId,
                  authored_by_authenticated_by AS authenticatedBy,
                  created_at AS createdAt
             FROM improvement_proposal_revisions
            WHERE proposal_id = ? ORDER BY revision, id`,
        )
        .all(proposalId) as Array<{
        readonly id: string;
        readonly revision: number;
        readonly supersedesRevisionId: string | null;
        readonly contentJson: string;
        readonly contentHash: string;
        readonly actorType: "human" | "runtime-worker";
        readonly actorId: string;
        readonly authenticatedBy: "local-session" | "runtime";
        readonly createdAt: string;
      }>
    ).map((revision) => {
      const content = ImprovementProposalRevisionContentSchema.parse(
        parseJson(
          revision.contentJson,
          "Improvement proposal revision content",
        ),
      );
      const lifecycle = database
        .prepare(
          `SELECT state, confirmation, created_at AS createdAt
             FROM improvement_proposal_lifecycle
            WHERE proposal_revision_id = ? ORDER BY rowid`,
        )
        .all(revision.id) as Array<{
        readonly state: "draft" | "proposed" | "awaiting-human";
        readonly confirmation: string | null;
        readonly createdAt: string;
      }>;
      const decisionRow = database
        .prepare(
          `SELECT id, proposal_revision_hash AS proposalRevisionHash,
                  evidence_snapshot_id AS evidenceSnapshotId,
                  evidence_snapshot_hash AS evidenceSnapshotHash,
                  decision, confirmation, actor_id AS actorId, reason,
                  evidence_refs_json AS evidenceRefsJson,
                  decision_hash AS decisionHash, created_at AS createdAt
             FROM improvement_decisions WHERE proposal_revision_id = ?`,
        )
        .get(revision.id) as
        | {
            readonly id: string;
            readonly proposalRevisionHash: string;
            readonly evidenceSnapshotId: string;
            readonly evidenceSnapshotHash: string;
            readonly decision: "approved" | "rejected";
            readonly confirmation: string;
            readonly actorId: string;
            readonly reason: string;
            readonly evidenceRefsJson: string;
            readonly decisionHash: string;
            readonly createdAt: string;
          }
        | undefined;
      const decision = decisionRow
        ? ImprovementProposalDecisionSchema.parse({
            id: decisionRow.id,
            proposalId,
            proposalRevisionId: revision.id,
            proposalRevisionHash: decisionRow.proposalRevisionHash,
            evidenceSnapshotId: decisionRow.evidenceSnapshotId,
            evidenceSnapshotHash: decisionRow.evidenceSnapshotHash,
            target: content.target,
            decision: decisionRow.decision,
            confirmation: decisionRow.confirmation,
            actor: {
              type: "human",
              id: decisionRow.actorId,
              authenticatedBy: "local-session",
            },
            reason: decisionRow.reason,
            evidenceRefs: parseJson(
              decisionRow.evidenceRefsJson,
              "Improvement decision evidence refs",
            ),
            hash: decisionRow.decisionHash,
            createdAt: decisionRow.createdAt,
          })
        : null;
      return {
        id: revision.id,
        revision: revision.revision,
        supersedesRevisionId: revision.supersedesRevisionId,
        content,
        hash: revision.contentHash,
        authoredBy: {
          type: revision.actorType,
          id: revision.actorId,
          authenticatedBy: revision.authenticatedBy,
        },
        lifecycle,
        decision,
        createdAt: revision.createdAt,
      };
    });
    const nextActions =
      proposal.state === "draft"
        ? (["revise", "propose"] as const)
        : proposal.state === "proposed"
          ? (["revise", "request-decision"] as const)
          : proposal.state === "awaiting-human"
            ? (["revise", "approve", "reject"] as const)
            : proposal.state === "approved"
              ? (["revise", "apply"] as const)
              : (["revise"] as const);
    return ImprovementProposalViewSchema.parse({
      id: proposal.id,
      projectId: proposal.projectId,
      departmentId: proposal.departmentId,
      currentRevisionId: proposal.currentRevisionId,
      currentState: proposal.state,
      revisions,
      nextActions,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
    });
  };

  const list = (projectId: string): readonly ImprovementProposalView[] => {
    const ids = database
      .prepare(
        `SELECT id FROM improvement_proposals
          WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId) as Array<{ readonly id: string }>;
    return ids.map((row) => inspect(row.id));
  };

  const insertRevision = (input: {
    readonly proposalId: string;
    readonly projectId: string;
    readonly revisionId: string;
    readonly revision: number;
    readonly supersedesRevisionId: string | null;
    readonly content: ImprovementProposalRevisionContent;
    readonly actor: ImprovementProposalCreateRequest["actor"];
    readonly commandId: string;
    readonly createdAt: string;
  }): string => {
    const contentJson = canonicalJson(input.content);
    const contentHash = sha256(contentJson);
    database
      .prepare(
        `INSERT INTO improvement_proposal_revisions(
           id, proposal_id, project_id, revision, supersedes_revision_id,
           evidence_snapshot_id, evidence_snapshot_hash, target_kind,
           target_owner_id, governed_head_revision_id,
           governed_head_revision_hash, content_json, content_hash,
           authored_by_actor_type, authored_by_actor_id,
           authored_by_authenticated_by, command_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.revisionId,
        input.proposalId,
        input.projectId,
        input.revision,
        input.supersedesRevisionId,
        input.content.evidence.id,
        input.content.evidence.hash,
        input.content.target.targetKind,
        input.content.target.ownerId,
        input.content.target.governedHead.revisionId,
        input.content.target.governedHead.revisionHash,
        contentJson,
        contentHash,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
        input.commandId,
        input.createdAt,
      );
    database
      .prepare(
        `INSERT INTO improvement_proposal_lifecycle(
           id, proposal_id, proposal_revision_id, state, actor_type, actor_id,
           authenticated_by, confirmation, command_id, created_at
         ) VALUES (?, ?, ?, 'draft', ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.proposalId,
        input.revisionId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
        `${input.commandId}:draft`,
        input.createdAt,
      );
    return contentHash;
  };

  const createInTransaction: ImprovementProposalRuntime["createInTransaction"] =
    (input) => {
      const request = ImprovementProposalCreateRequestSchema.parse(
        input.request,
      );
      if (
        !database
          .prepare("SELECT 1 AS present FROM projects WHERE id = ?")
          .get(request.projectId)
      ) {
        throw new ImprovementProposalRuntimeError(
          "PROJECT_NOT_FOUND",
          `Project ${request.projectId} was not found.`,
        );
      }
      if (
        database
          .prepare(
            "SELECT 1 AS present FROM improvement_proposals WHERE id = ?",
          )
          .get(request.proposalId)
      ) {
        throw new ImprovementProposalRuntimeError(
          "CONFLICT",
          `Improvement proposal ${request.proposalId} already exists.`,
        );
      }
      const content = validateEvidence(request.projectId, request.content);
      const createdAt = clock().toISOString();
      database
        .prepare(
          `INSERT INTO improvement_proposals(
           id, project_id, department_id, current_revision_id, revision, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)`,
        )
        .run(
          request.proposalId,
          request.projectId,
          request.departmentId,
          request.revisionId,
          createdAt,
          createdAt,
        );
      const contentHash = insertRevision({
        proposalId: request.proposalId,
        projectId: request.projectId,
        revisionId: request.revisionId,
        revision: 1,
        supersedesRevisionId: null,
        content,
        actor: request.actor,
        commandId: input.commandId,
        createdAt,
      });
      appendAuditAndInvalidation({
        commandId: input.commandId,
        action: "improvement.proposal.create",
        proposalId: request.proposalId,
        proposalRevisionId: request.revisionId,
        projectId: request.projectId,
        actor: request.actor,
        createdAt,
        before: null,
        after: { revisionId: request.revisionId, contentHash, state: "draft" },
      });
      return inspect(request.proposalId);
    };

  const reviseInTransaction: ImprovementProposalRuntime["reviseInTransaction"] =
    (input) => {
      const request = ImprovementProposalReviseRequestSchema.parse(
        input.request,
      );
      const current = inspect(request.proposalId);
      const currentRevision = current.revisions.find(
        (revision) => revision.id === current.currentRevisionId,
      );
      if (
        !currentRevision ||
        currentRevision.id !== request.supersedesRevisionId ||
        currentRevision.hash !== request.expectedSupersededRevisionHash
      ) {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_PROPOSAL_SUPERSEDED",
          `Improvement proposal ${request.proposalId} no longer has the expected current revision.`,
        );
      }
      const content = validateEvidence(current.projectId, request.content);
      const createdAt = clock().toISOString();
      const revision = currentRevision.revision + 1;
      const contentHash = insertRevision({
        proposalId: request.proposalId,
        projectId: current.projectId,
        revisionId: request.revisionId,
        revision,
        supersedesRevisionId: currentRevision.id,
        content,
        actor: request.actor,
        commandId: input.commandId,
        createdAt,
      });
      database
        .prepare(
          `UPDATE improvement_proposals
            SET current_revision_id = ?, revision = ?, state = 'draft',
                updated_at = ?
          WHERE id = ?`,
        )
        .run(request.revisionId, revision, createdAt, request.proposalId);
      appendAuditAndInvalidation({
        commandId: input.commandId,
        action: "improvement.proposal.revise",
        proposalId: request.proposalId,
        proposalRevisionId: request.revisionId,
        projectId: current.projectId,
        actor: request.actor,
        createdAt,
        before: {
          revisionId: currentRevision.id,
          contentHash: currentRevision.hash,
        },
        after: { revisionId: request.revisionId, contentHash, state: "draft" },
      });
      return inspect(request.proposalId);
    };

  const transitionInTransaction: ImprovementProposalRuntime["transitionInTransaction"] =
    (input) => {
      const request = ImprovementProposalTransitionRequestSchema.parse(
        input.request,
      );
      const current = inspect(request.proposalId);
      const revision = current.revisions.find(
        (entry) => entry.id === current.currentRevisionId,
      );
      const expectedState = input.state === "proposed" ? "draft" : "proposed";
      if (
        !revision ||
        revision.id !== request.proposalRevisionId ||
        revision.hash !== request.expectedProposalRevisionHash
      ) {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_PROPOSAL_SUPERSEDED",
          `Improvement proposal ${request.proposalId} no longer has the expected current revision.`,
        );
      }
      if (current.currentState !== expectedState) {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_INVALID_STATE",
          `Improvement proposal ${request.proposalId} is ${current.currentState}, not ${expectedState}.`,
        );
      }
      const createdAt = clock().toISOString();
      database
        .prepare(
          `INSERT INTO improvement_proposal_lifecycle(
           id, proposal_id, proposal_revision_id, state, actor_type, actor_id,
           authenticated_by, confirmation, command_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          request.proposalId,
          request.proposalRevisionId,
          input.state,
          request.actor.type,
          request.actor.id,
          request.actor.authenticatedBy,
          input.commandId,
          createdAt,
        );
      database
        .prepare(
          `UPDATE improvement_proposals SET state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.state, createdAt, request.proposalId);
      appendAuditAndInvalidation({
        commandId: input.commandId,
        action: `improvement.proposal.${input.state === "proposed" ? "propose" : "request-decision"}`,
        proposalId: request.proposalId,
        proposalRevisionId: request.proposalRevisionId,
        projectId: current.projectId,
        actor: request.actor,
        createdAt,
        before: { state: current.currentState },
        after: { state: input.state },
      });
      return inspect(request.proposalId);
    };

  const currentRevisionForExactTransition = (input: {
    readonly proposalId: string;
    readonly proposalRevisionId: string;
    readonly expectedProposalRevisionHash: string;
    readonly expectedState: ImprovementProposalState;
  }) => {
    const current = inspect(input.proposalId);
    const revision = current.revisions.find(
      (entry) => entry.id === current.currentRevisionId,
    );
    if (
      !revision ||
      revision.id !== input.proposalRevisionId ||
      revision.hash !== input.expectedProposalRevisionHash
    ) {
      throw new ImprovementProposalRuntimeError(
        "IMPROVEMENT_PROPOSAL_SUPERSEDED",
        `Improvement proposal ${input.proposalId} no longer has the expected current revision.`,
      );
    }
    if (current.currentState !== input.expectedState) {
      throw new ImprovementProposalRuntimeError(
        "IMPROVEMENT_INVALID_STATE",
        `Improvement proposal ${input.proposalId} is ${current.currentState}, not ${input.expectedState}.`,
      );
    }
    return { current, revision };
  };

  const requestDecisionInTransaction: ImprovementProposalRuntime["requestDecisionInTransaction"] =
    (input) => {
      const request = ImprovementProposalRequestDecisionRequestSchema.parse(
        input.request,
      );
      const { current } = currentRevisionForExactTransition({
        proposalId: request.proposalId,
        proposalRevisionId: request.proposalRevisionId,
        expectedProposalRevisionHash: request.expectedProposalRevisionHash,
        expectedState: "proposed",
      });
      const createdAt = clock().toISOString();
      database
        .prepare(
          `INSERT INTO improvement_proposal_lifecycle(
             id, proposal_id, proposal_revision_id, state, actor_type, actor_id,
             authenticated_by, confirmation, command_id, created_at
           ) VALUES (?, ?, ?, 'awaiting-human', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          request.proposalId,
          request.proposalRevisionId,
          request.actor.type,
          request.actor.id,
          request.actor.authenticatedBy,
          request.confirmation,
          input.commandId,
          createdAt,
        );
      database
        .prepare(
          `UPDATE improvement_proposals
              SET state = 'awaiting-human', updated_at = ? WHERE id = ?`,
        )
        .run(createdAt, request.proposalId);
      appendAuditAndInvalidation({
        commandId: input.commandId,
        action: "improvement.proposal.request-decision",
        proposalId: request.proposalId,
        proposalRevisionId: request.proposalRevisionId,
        projectId: current.projectId,
        actor: request.actor,
        createdAt,
        before: { state: current.currentState },
        after: { state: "awaiting-human", confirmation: request.confirmation },
      });
      return inspect(request.proposalId);
    };

  const decideInTransaction: ImprovementProposalRuntime["decideInTransaction"] =
    (input) => {
      const request = ImprovementProposalDecideRequestSchema.parse(
        input.request,
      );
      const current = inspect(request.proposalId);
      const revision = current.revisions.find(
        (entry) => entry.id === current.currentRevisionId,
      );
      if (
        !revision ||
        revision.id !== request.proposalRevisionId ||
        revision.hash !== request.expectedProposalRevisionHash
      ) {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_PROPOSAL_SUPERSEDED",
          `Improvement proposal ${request.proposalId} no longer has the expected current revision.`,
        );
      }
      if (revision.decision) {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_DECISION_EXISTS",
          `Improvement proposal revision ${revision.id} already has an exact decision.`,
        );
      }
      if (current.currentState !== "awaiting-human") {
        throw new ImprovementProposalRuntimeError(
          "IMPROVEMENT_INVALID_STATE",
          `Improvement proposal ${request.proposalId} is ${current.currentState}, not awaiting-human.`,
        );
      }
      const requestedConfirmation = revision.lifecycle.at(-1)?.confirmation;
      if (requestedConfirmation !== request.confirmation) {
        throw new ImprovementProposalRuntimeError(
          "CONFLICT",
          `Improvement proposal revision ${revision.id} requires the exact requested confirmation.`,
        );
      }
      const createdAt = clock().toISOString();
      const decisionWithoutHash = {
        id: request.decisionId,
        proposalId: current.id,
        proposalRevisionId: revision.id,
        proposalRevisionHash: revision.hash,
        evidenceSnapshotId: revision.content.evidence.id,
        evidenceSnapshotHash: revision.content.evidence.hash,
        target: revision.content.target,
        decision: request.decision,
        confirmation: request.confirmation,
        actor: request.actor,
        reason: request.reason,
        evidenceRefs: request.evidenceRefs,
        createdAt,
      };
      const decisionHash = sha256(canonicalJson(decisionWithoutHash));
      database
        .prepare(
          `INSERT INTO improvement_decisions(
             id, proposal_id, proposal_revision_id, proposal_revision_hash,
             evidence_snapshot_id, evidence_snapshot_hash, target_kind,
             target_owner_id, governed_head_revision_id,
             governed_head_revision_hash, decision, confirmation, actor_type,
             actor_id, authenticated_by, reason, evidence_refs_json,
             decision_hash, command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?,
                     'local-session', ?, ?, ?, ?, ?)`,
        )
        .run(
          request.decisionId,
          current.id,
          revision.id,
          revision.hash,
          revision.content.evidence.id,
          revision.content.evidence.hash,
          revision.content.target.targetKind,
          revision.content.target.ownerId,
          revision.content.target.governedHead.revisionId,
          revision.content.target.governedHead.revisionHash,
          request.decision,
          request.confirmation,
          request.actor.id,
          request.reason,
          canonicalJson(request.evidenceRefs),
          decisionHash,
          input.commandId,
          createdAt,
        );
      database
        .prepare(
          `UPDATE improvement_proposals SET state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(request.decision, createdAt, current.id);
      appendAuditAndInvalidation({
        commandId: input.commandId,
        action: "improvement.proposal.decide",
        proposalId: current.id,
        proposalRevisionId: revision.id,
        projectId: current.projectId,
        actor: request.actor,
        createdAt,
        before: { state: current.currentState },
        after: {
          state: request.decision,
          decisionId: request.decisionId,
          decisionHash,
        },
      });
      return inspect(current.id);
    };

  return {
    createInTransaction,
    reviseInTransaction,
    transitionInTransaction,
    requestDecisionInTransaction,
    decideInTransaction,
    inspect,
    list,
  };
};
