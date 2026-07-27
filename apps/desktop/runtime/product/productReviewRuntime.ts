import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ProductReviewStateViewSchema,
  ProjectSpecContentSchema,
  type ActorRef,
  type ProductReviewStateView,
  type ProjectSpecContent,
  type ReviewParticipantInput,
} from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ReviewRuntime } from "../review/reviewRuntime.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";

export type ProductGatePromotionFailurePoint =
  | "before-snapshot"
  | "after-snapshot"
  | "before-promotion"
  | "before-audit"
  | "before-outbox"
  | "before-receipt"
  | "before-commit";

export class ProductReviewRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductReviewRuntimeError";
  }
}

export interface ProductReviewRuntime {
  readonly inspect: (runId: string) => ProductReviewStateView;
  readonly reviseSpecInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly producerSessionId: string;
    readonly content: ProjectSpecContent;
  }) => ProductReviewStateView;
  readonly startReviewInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly topicId: string;
    readonly projectSpecRevisionId: string;
    readonly projectSpecHash: string;
    readonly participants: readonly ReviewParticipantInput[];
    readonly quorum?: number;
    readonly budget: {
      readonly maxRounds: number;
      readonly maxDurationSeconds: number;
      readonly maxTokens: number;
      readonly maxCostCents: number;
    };
  }) => ProductReviewStateView;
  readonly recordReadinessInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly evidenceId: string;
    readonly projectSpecRevisionId: string;
    readonly projectSpecHash: string;
    readonly producerSessionId: string;
    readonly checkKey: string;
    readonly status: "ready" | "blocked";
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
  }) => ProductReviewStateView;
  readonly promoteGateInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly topicId: string;
    readonly projectSpecRevisionId: string;
    readonly projectSpecHash: string;
    readonly readinessEvidenceIds: readonly string[];
  }) => ProductReviewStateView;
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
    throw new ProductReviewRuntimeError(
      "PRODUCT_REVIEW_DATA_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

export const openProductReviewRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly reviewRuntime: Pick<
      ReviewRuntime,
      "dispatchInTransaction" | "list"
    >;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      | "inspectRun"
      | "recordProductReadinessInTransaction"
      | "promoteProductGateInTransaction"
    >;
    readonly clock?: () => Date;
    readonly promotionFailure?: (
      point: ProductGatePromotionFailurePoint,
    ) => void;
  },
): ProductReviewRuntime => {
  const clock = options.clock ?? (() => new Date());

  const resolveFormalRun = (runId: string) => {
    const run = database
      .prepare(
        `SELECT runs.id AS runId, runs.project_id AS projectId,
                runs.product_baseline_id AS productBaselineId,
                baselines.canonical_hash AS productBaselineHash
           FROM department_runs AS runs
           JOIN product_baselines AS baselines
             ON baselines.id = runs.product_baseline_id
            AND baselines.run_id = runs.id
          WHERE runs.id = ?`,
      )
      .get(runId) as
      | {
          readonly runId: string;
          readonly projectId: string;
          readonly productBaselineId: string;
          readonly productBaselineHash: string;
        }
      | undefined;
    if (!run) {
      throw new ProductReviewRuntimeError(
        "PRODUCT_RUN_NOT_FORMAL",
        `Run ${runId} is not bound to an exact Product Baseline.`,
      );
    }
    return run;
  };

  const inspect = (runId: string): ProductReviewStateView => {
    const run = resolveFormalRun(runId);
    const revisions = database
      .prepare(
        `SELECT revisions.id,
                revisions.project_spec_id AS projectSpecId,
                revisions.project_id AS projectId,
                revisions.run_id AS runId,
                revisions.product_baseline_id AS productBaselineId,
                revisions.product_baseline_hash AS productBaselineHash,
                revisions.revision,
                revisions.supersedes_revision_id AS supersedesRevisionId,
                revisions.content_json AS contentJson,
                revisions.content_hash AS contentHash,
                revisions.producer_ai_member_id AS producerAiMemberId,
                revisions.producer_position_id AS producerPositionId,
                revisions.producer_session_id AS producerSessionId,
                revisions.created_at AS createdAt
           FROM project_spec_revisions AS revisions
          WHERE revisions.run_id = ?
          ORDER BY revisions.revision, revisions.id`,
      )
      .all(runId) as Array<{
      readonly id: string;
      readonly projectSpecId: string;
      readonly projectId: string;
      readonly runId: string;
      readonly productBaselineId: string;
      readonly productBaselineHash: string;
      readonly revision: number;
      readonly supersedesRevisionId: string | null;
      readonly contentJson: string;
      readonly contentHash: string;
      readonly producerAiMemberId: string;
      readonly producerPositionId: string;
      readonly producerSessionId: string;
      readonly createdAt: string;
    }>;
    const readinessEvidence = database
      .prepare(
        `SELECT id, check_key AS checkKey, status, summary,
                evidence_refs_json AS evidenceRefsJson,
                project_spec_revision_id AS projectSpecRevisionId,
                project_spec_hash AS projectSpecHash,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId,
                created_at AS createdAt
           FROM product_readiness_evidence
          WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as Array<{
      readonly id: string;
      readonly checkKey: string;
      readonly status: "ready" | "blocked";
      readonly summary: string;
      readonly evidenceRefsJson: string;
      readonly projectSpecRevisionId: string;
      readonly projectSpecHash: string;
      readonly producerAiMemberId: string;
      readonly producerPositionId: string;
      readonly producerSessionId: string;
      readonly createdAt: string;
    }>;
    const promotion = database
      .prepare(
        `SELECT id, topic_id AS topicId,
                quality_gate_result_id AS qualityGateResultId,
                project_spec_revision_id AS projectSpecRevisionId,
                project_spec_hash AS projectSpecHash,
                readiness_evidence_ids_json AS readinessEvidenceIdsJson,
                source_snapshot_revision_id AS sourceSnapshotRevisionId,
                snapshot_revision_id AS snapshotRevisionId,
                snapshot_hash AS snapshotHash, created_at AS createdAt
           FROM product_gate_promotions WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          readonly id: string;
          readonly topicId: string;
          readonly qualityGateResultId: string;
          readonly projectSpecRevisionId: string;
          readonly projectSpecHash: string;
          readonly readinessEvidenceIdsJson: string;
          readonly sourceSnapshotRevisionId: string;
          readonly snapshotRevisionId: string;
          readonly snapshotHash: string;
          readonly createdAt: string;
        }
      | undefined;
    const snapshotLineage = database
      .prepare(
        `SELECT id, revision, parent_revision AS parentRevision, hash
           FROM run_snapshot_revisions
          WHERE run_id = ? ORDER BY revision, id`,
      )
      .all(runId)
      .map((row) => {
        const snapshot = row as Record<string, unknown>;
        return {
          id: String(snapshot.id),
          revision: Number(snapshot.revision),
          parentRevision:
            snapshot.parentRevision === null
              ? null
              : Number(snapshot.parentRevision),
          hash: String(snapshot.hash),
        };
      });
    return ProductReviewStateViewSchema.parse({
      projectId: run.projectId,
      runId: run.runId,
      productBaselineId: run.productBaselineId,
      productBaselineHash: run.productBaselineHash,
      specRevisions: revisions.map((revision) => ({
        id: revision.id,
        projectSpecId: revision.projectSpecId,
        projectId: revision.projectId,
        runId: revision.runId,
        productBaselineId: revision.productBaselineId,
        productBaselineHash: revision.productBaselineHash,
        revision: Number(revision.revision),
        supersedesRevisionId: revision.supersedesRevisionId,
        content: ProjectSpecContentSchema.parse(
          parseJson(
            revision.contentJson,
            `Project Spec Revision ${revision.id}`,
          ),
        ),
        hash: revision.contentHash,
        producer: {
          aiMemberId: revision.producerAiMemberId,
          positionId: revision.producerPositionId,
          sessionId: revision.producerSessionId,
        },
        createdAt: revision.createdAt,
      })),
      reviewTopics: options.reviewRuntime.list({ runId }),
      readinessEvidence: readinessEvidence.map((evidence) => ({
        id: evidence.id,
        checkKey: evidence.checkKey,
        status: evidence.status,
        summary: evidence.summary,
        evidenceRefs: parseJson(
          evidence.evidenceRefsJson,
          `Readiness Evidence ${evidence.id}`,
        ),
        projectSpecRevisionId: evidence.projectSpecRevisionId,
        projectSpecHash: evidence.projectSpecHash,
        producer: {
          aiMemberId: evidence.producerAiMemberId,
          positionId: evidence.producerPositionId,
          sessionId: evidence.producerSessionId,
        },
        createdAt: evidence.createdAt,
      })),
      readinessBlockers: readinessEvidence
        .filter((evidence) => evidence.status === "blocked")
        .map((evidence) => evidence.id),
      promotion: promotion
        ? {
            id: promotion.id,
            topicId: promotion.topicId,
            qualityGateResultId: promotion.qualityGateResultId,
            projectSpecRevisionId: promotion.projectSpecRevisionId,
            projectSpecHash: promotion.projectSpecHash,
            readinessEvidenceIds: parseJson(
              promotion.readinessEvidenceIdsJson,
              `Product Gate Promotion ${promotion.id}`,
            ),
            sourceSnapshotRevisionId: promotion.sourceSnapshotRevisionId,
            snapshotRevisionId: promotion.snapshotRevisionId,
            snapshotHash: promotion.snapshotHash,
            createdAt: promotion.createdAt,
          }
        : null,
      snapshotLineage,
    });
  };

  const resolveProducer = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly actor: ActorRef;
  }) => {
    const producer = database
      .prepare(
        `SELECT participants.participant_ref AS aiMemberId,
                positions.id AS positionId,
                sessions.id AS sessionId
           FROM interaction_sessions AS sessions
           JOIN session_participants AS participants
             ON participants.session_id = sessions.id
            AND participants.participant_type = 'ai-member'
            AND participants.role = 'product-manager'
           JOIN positions ON positions.ai_member_id = participants.participant_ref
          WHERE sessions.id = ?
            AND sessions.project_id = ?
            AND sessions.mode = 'consultation'
            AND sessions.status = 'active'
          ORDER BY participants.created_at, participants.id
          LIMIT 1`,
      )
      .get(input.sessionId, input.projectId) as
      | {
          readonly aiMemberId: string;
          readonly positionId: string;
          readonly sessionId: string;
        }
      | undefined;
    if (!producer) {
      throw new ProductReviewRuntimeError(
        "PROJECT_SPEC_PRODUCER_INVALID",
        "Project Spec producer must resolve from an active Product manager Consultation Session.",
      );
    }
    if (
      input.actor.type !== "runtime-worker" ||
      input.actor.authenticatedBy !== "runtime" ||
      input.actor.id !== producer.aiMemberId
    ) {
      throw new ProductReviewRuntimeError(
        "PROJECT_SPEC_ACTOR_INVALID",
        "Project Spec revision must be submitted by the bound Product manager Runtime worker.",
      );
    }
    return producer;
  };

  const reviseSpecInTransaction: ProductReviewRuntime["reviseSpecInTransaction"] =
    (input) => {
      const run = resolveFormalRun(input.runId);
      const content = ProjectSpecContentSchema.parse(input.content);
      const producer = resolveProducer({
        projectId: run.projectId,
        sessionId: input.producerSessionId,
        actor: input.actor,
      });
      const current = database
        .prepare(
          `SELECT id, current_revision_id AS currentRevisionId, revision
             FROM project_specs
            WHERE run_id = ?`,
        )
        .get(input.runId) as
        | {
            readonly id: string;
            readonly currentRevisionId: string | null;
            readonly revision: number;
          }
        | undefined;
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new ProductReviewRuntimeError(
          "VERSION_CONFLICT",
          `Project Spec revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }

      const now = clock().toISOString();
      const projectSpecId = current?.id ?? randomUUID();
      const projectSpecRevisionId = randomUUID();
      const nextRevision = currentRevision + 1;
      const contentJson = canonicalJson(content);
      const contentHash = sha256(contentJson);

      if (!current) {
        database
          .prepare(
            `INSERT INTO project_specs(
               id, project_id, run_id, product_baseline_id,
               current_revision_id, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`,
          )
          .run(
            projectSpecId,
            run.projectId,
            run.runId,
            run.productBaselineId,
            now,
            now,
          );
      }
      database
        .prepare(
          `INSERT INTO project_spec_revisions(
             id, project_spec_id, project_id, run_id, product_baseline_id,
             product_baseline_hash, revision, supersedes_revision_id,
             content_json, content_hash, producer_ai_member_id,
             producer_position_id, producer_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectSpecRevisionId,
          projectSpecId,
          run.projectId,
          run.runId,
          run.productBaselineId,
          run.productBaselineHash,
          nextRevision,
          current?.currentRevisionId ?? null,
          contentJson,
          contentHash,
          producer.aiMemberId,
          producer.positionId,
          producer.sessionId,
          now,
        );
      database
        .prepare(
          `UPDATE project_specs
              SET current_revision_id = ?, revision = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(projectSpecRevisionId, nextRevision, now, projectSpecId);

      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'project-spec.revised', 'project-spec-revision', ?, ?, NULL,
                     ?, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          projectSpecRevisionId,
          run.runId,
          current
            ? canonicalJson({
                revision: currentRevision,
                projectSpecRevisionId: current.currentRevisionId,
              })
            : null,
          canonicalJson({
            revision: nextRevision,
            projectSpecRevisionId,
            projectSpecHash: contentHash,
            productBaselineId: run.productBaselineId,
            productBaselineHash: run.productBaselineHash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.events.append({
        type: "spec.revised",
        scope: {
          companyId: "company",
          projectId: run.projectId,
          productBaselineId: run.productBaselineId,
          projectSpecRevisionId,
          runId: run.runId,
          commandId: input.commandId,
        },
        payload: {
          projectSpecId,
          projectSpecRevisionId,
          projectSpecRevision: nextRevision,
          projectSpecHash: contentHash,
          productBaselineId: run.productBaselineId,
          productBaselineHash: run.productBaselineHash,
          supersedesRevisionId: current?.currentRevisionId ?? null,
        },
        timestamp: now,
      });
      return inspect(input.runId);
    };

  const startReviewInTransaction: ProductReviewRuntime["startReviewInTransaction"] =
    (input) => {
      const state = inspect(input.runId);
      const spec = state.specRevisions.find(
        (revision) => revision.id === input.projectSpecRevisionId,
      );
      if (!spec || spec.hash !== input.projectSpecHash) {
        throw new ProductReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Product Review must bind an existing exact Project Spec Revision and hash.",
        );
      }
      const currentRevision = state.specRevisions.at(-1)?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw new ProductReviewRuntimeError(
          "VERSION_CONFLICT",
          `Project Spec revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const owner = input.participants.filter(
        (participant) => participant.role === "owner-participant",
      );
      if (
        owner.length !== 1 ||
        owner[0]?.aiMemberId !== spec.producer.aiMemberId ||
        owner[0]?.positionId !== spec.producer.positionId ||
        owner[0]?.sessionId !== spec.producer.sessionId
      ) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_REVIEW_OWNER_INVALID",
          "Product Review owner-participant must be the exact Product manager who produced the Project Spec Revision.",
        );
      }
      options.reviewRuntime.dispatchInTransaction({
        commandId: input.commandId,
        actor: input.actor,
        expectedRevision: 0,
        command: {
          type: "review.topic.create",
          topicId: input.topicId,
          projectId: state.projectId,
          runId: state.runId,
          title: `Product Review for Project Spec r${spec.revision}`,
          manifest: {
            scope: "product",
            topicId: input.topicId,
            supportingArtifactVersionIds: [],
            supportingSpecRevisionIds: [spec.id],
            harnessSnapshotIds: [],
            acceptanceCriteria: spec.content.acceptanceCriteria,
            excludedContext: [
              "hidden-prompts",
              "prior-reviewer-opinions",
              "private-transcripts",
              "provider-session-history",
              "credential-values",
            ],
            productBaselineId: state.productBaselineId,
            productBaselineHash: state.productBaselineHash,
            projectSpecRevisionId: spec.id,
            projectSpecHash: spec.hash,
          },
          producer: {
            aiMemberId: spec.producer.aiMemberId,
            positionId: spec.producer.positionId,
            sessionId: spec.producer.sessionId,
          },
          participants: [...input.participants],
          quorum: input.quorum,
          budget: input.budget,
          stopCondition: "blocking-findings-dispositioned",
          escalationPolicy: "fail-with-evidence",
        },
      });
      return inspect(input.runId);
    };

  const recordReadinessInTransaction: ProductReviewRuntime["recordReadinessInTransaction"] =
    (input) => {
      const state = inspect(input.runId);
      const run = options.pipelineRuntime.inspectRun(input.runId);
      if (run.run.revision !== input.expectedRevision) {
        throw new ProductReviewRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${run.run.revision}.`,
        );
      }
      const spec = state.specRevisions.find(
        (revision) => revision.id === input.projectSpecRevisionId,
      );
      if (!spec || spec.hash !== input.projectSpecHash) {
        throw new ProductReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Readiness Evidence must bind an existing exact Project Spec Revision and hash.",
        );
      }
      const producer = resolveProducer({
        projectId: state.projectId,
        sessionId: input.producerSessionId,
        actor: input.actor,
      });
      if (
        database
          .prepare("SELECT 1 FROM product_readiness_evidence WHERE id = ?")
          .get(input.evidenceId)
      ) {
        throw new ProductReviewRuntimeError(
          "READINESS_EVIDENCE_EXISTS",
          `Readiness Evidence ${input.evidenceId} already exists.`,
        );
      }
      const now = clock().toISOString();
      database
        .prepare(
          `INSERT INTO product_readiness_evidence(
             id, project_id, run_id, product_baseline_id,
             product_baseline_hash, project_spec_revision_id,
             project_spec_hash, check_key, status, summary,
             evidence_refs_json, producer_ai_member_id,
             producer_position_id, producer_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.evidenceId,
          state.projectId,
          state.runId,
          state.productBaselineId,
          state.productBaselineHash,
          spec.id,
          spec.hash,
          input.checkKey,
          input.status,
          input.summary,
          canonicalJson(input.evidenceRefs),
          producer.aiMemberId,
          producer.positionId,
          producer.sessionId,
          now,
        );
      options.pipelineRuntime.recordProductReadinessInTransaction({
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        blocked: input.status === "blocked",
      });
      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'product-readiness.recorded', 'readiness-evidence', ?, ?, NULL,
                     NULL, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          input.evidenceId,
          input.runId,
          canonicalJson({
            evidenceId: input.evidenceId,
            checkKey: input.checkKey,
            status: input.status,
            projectSpecRevisionId: spec.id,
            projectSpecHash: spec.hash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.events.append({
        type: "product-readiness.recorded",
        scope: {
          companyId: "company",
          projectId: state.projectId,
          productBaselineId: state.productBaselineId,
          projectSpecRevisionId: spec.id,
          runId: state.runId,
          commandId: input.commandId,
        },
        payload: {
          evidenceId: input.evidenceId,
          checkKey: input.checkKey,
          status: input.status,
          projectSpecRevisionId: spec.id,
          projectSpecHash: spec.hash,
          evidenceRefs: [...input.evidenceRefs],
        },
        timestamp: now,
      });
      return inspect(input.runId);
    };

  const promoteGateInTransaction: ProductReviewRuntime["promoteGateInTransaction"] =
    (input) => {
      const state = inspect(input.runId);
      if (state.promotion) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_GATE_ALREADY_PROMOTED",
          `Run ${input.runId} already has a Product Gate Promotion.`,
        );
      }
      const run = options.pipelineRuntime.inspectRun(input.runId);
      if (run.run.revision !== input.expectedRevision) {
        throw new ProductReviewRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${run.run.revision}.`,
        );
      }
      const topic = state.reviewTopics.find(
        (candidate) => candidate.topic.id === input.topicId,
      );
      if (
        !topic ||
        topic.topic.kind !== "product" ||
        topic.topic.manifest.scope !== "product" ||
        topic.topic.manifest.productBaselineId !== state.productBaselineId ||
        topic.topic.manifest.productBaselineHash !==
          state.productBaselineHash ||
        topic.gateResult?.result !== "PASS" ||
        !topic.gateResult.satisfiesProductionContract
      ) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_GATE_NOT_PASS",
          "Product Gate promotion requires an exact PASS Product Quality Gate Result for this Run and Product Baseline.",
        );
      }
      const spec = state.specRevisions.find(
        (revision) => revision.id === input.projectSpecRevisionId,
      );
      const gateRevision = topic.revisions.find(
        (revision) => revision.id === topic.gateResult?.revisionId,
      );
      if (
        !spec ||
        spec.hash !== input.projectSpecHash ||
        !gateRevision ||
        gateRevision.subjectKind !== "project-spec" ||
        gateRevision.subjectId !== spec.id ||
        gateRevision.subjectHash !== spec.hash
      ) {
        throw new ProductReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Promoted Project Spec does not match the exact revision accepted by the Product Quality Gate.",
        );
      }
      if (
        input.actor.type !== "runtime-worker" ||
        input.actor.authenticatedBy !== "runtime" ||
        input.actor.id !== spec.producer.aiMemberId
      ) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_GATE_ACTOR_INVALID",
          "Product Gate promotion must be submitted by the bound Product manager Runtime worker.",
        );
      }
      const scopeChangingFinding = database
        .prepare(
          `SELECT findings.id
             FROM review_findings AS findings
             JOIN review_topics AS topics ON topics.id = findings.topic_id
            WHERE topics.run_id = ? AND topics.kind = 'product'
              AND findings.scope_impact = 'scope-changing'
            LIMIT 1`,
        )
        .get(input.runId) as { readonly id: string } | undefined;
      if (scopeChangingFinding) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_SCOPE_CHANGE_RECONFIRM_REQUIRED",
          `Scope-changing Finding ${scopeChangingFinding.id} permanently blocks promotion in this Run; confirm a new Product Proposal and child Fork.`,
        );
      }
      if (state.readinessBlockers.length > 0) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_READINESS_BLOCKED",
          "Persistent Readiness Evidence blocks Product Gate promotion for this Run.",
        );
      }
      const requestedEvidence = new Set(input.readinessEvidenceIds);
      if (requestedEvidence.size === 0) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_READINESS_INCOMPLETE",
          "Product Gate promotion requires readiness evidence.",
        );
      }
      const readiness = state.readinessEvidence.filter((evidence) =>
        requestedEvidence.has(evidence.id),
      );
      if (
        readiness.length !== requestedEvidence.size ||
        readiness.some(
          (evidence) =>
            evidence.status !== "ready" ||
            evidence.projectSpecRevisionId !== spec.id ||
            evidence.projectSpecHash !== spec.hash,
        )
      ) {
        throw new ProductReviewRuntimeError(
          "PRODUCT_READINESS_INCOMPLETE",
          "All promoted readiness evidence must be ready and bind the exact accepted Project Spec Revision.",
        );
      }

      const now = clock().toISOString();
      const promotionId = randomUUID();
      const snapshotRevisionId = randomUUID();
      const promotedRun =
        options.pipelineRuntime.promoteProductGateInTransaction({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          sourceSnapshotRevisionId: run.run.snapshotRevisionId,
          snapshotRevisionId,
          topicId: input.topicId,
          qualityGateResultId: topic.gateResult.id,
          projectSpecRevisionId: spec.id,
          projectSpecHash: spec.hash,
          readinessEvidenceIds: [...input.readinessEvidenceIds],
          promotedAt: now,
          checkpoint: (point) => options.promotionFailure?.(point),
        });
      options.promotionFailure?.("before-promotion");
      database
        .prepare(
          `INSERT INTO product_gate_promotions(
             id, project_id, run_id, topic_id, quality_gate_result_id,
             project_spec_revision_id, project_spec_hash,
             readiness_evidence_ids_json, source_snapshot_revision_id,
             snapshot_revision_id, snapshot_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          promotionId,
          state.projectId,
          state.runId,
          input.topicId,
          topic.gateResult.id,
          spec.id,
          spec.hash,
          canonicalJson(input.readinessEvidenceIds),
          run.run.snapshotRevisionId,
          snapshotRevisionId,
          promotedRun.snapshot.hash,
          now,
        );
      options.promotionFailure?.("before-audit");
      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'product-gate.promoted', 'product-gate-promotion', ?, ?, NULL,
                     ?, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          promotionId,
          state.runId,
          canonicalJson({ snapshotRevisionId: run.run.snapshotRevisionId }),
          canonicalJson({
            qualityGateResultId: topic.gateResult.id,
            projectSpecRevisionId: spec.id,
            projectSpecHash: spec.hash,
            readinessEvidenceIds: [...input.readinessEvidenceIds],
            snapshotRevisionId,
            snapshotHash: promotedRun.snapshot.hash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.promotionFailure?.("before-outbox");
      for (const event of [
        {
          type: "product-gate.passed",
          payload: {
            promotionId,
            topicId: input.topicId,
            qualityGateResultId: topic.gateResult.id,
            projectSpecRevisionId: spec.id,
            projectSpecHash: spec.hash,
            readinessEvidenceIds: [...input.readinessEvidenceIds],
          },
        },
        {
          type: "snapshot.promoted",
          payload: {
            promotionId,
            sourceSnapshotRevisionId: run.run.snapshotRevisionId,
            snapshotRevisionId,
            snapshotHash: promotedRun.snapshot.hash,
          },
        },
      ]) {
        options.events.append({
          type: event.type,
          scope: {
            companyId: "company",
            projectId: state.projectId,
            productBaselineId: state.productBaselineId,
            projectSpecRevisionId: spec.id,
            runId: state.runId,
            snapshotRevisionId,
            topicId: input.topicId,
            qualityGateResultId: topic.gateResult.id,
            commandId: input.commandId,
          },
          payload: event.payload,
          timestamp: now,
        });
      }
      return inspect(input.runId);
    };

  return {
    inspect,
    reviseSpecInTransaction,
    startReviewInTransaction,
    recordReadinessInTransaction,
    promoteGateInTransaction,
  };
};
