import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ApplicationViewSchema,
  ApplicationSpecContentSchema,
  CrossApplicationContractRevisionViewSchema,
  TechnicalBaselineManifestSchema,
  TechnicalBaselineProposalContentSchema,
  TechnicalBaselineProposalRevisionViewSchema,
  TechnicalReviewStateViewSchema,
  type ActorRef,
  type ApplicationSpecContent,
  type ApplicationView,
  type ReviewParticipantInput,
  type TechnicalBaselineProposalContent,
  type TechnicalReviewStateView,
} from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ReviewRuntime } from "../review/reviewRuntime.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";

export type TechnicalGatePromotionFailurePoint =
  | "before-baseline"
  | "before-snapshot"
  | "after-snapshot"
  | "before-promotion"
  | "before-audit"
  | "before-outbox"
  | "before-receipt"
  | "before-commit";

export class TechnicalReviewRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TechnicalReviewRuntimeError";
  }
}

export interface TechnicalReviewRuntime {
  readonly listApplications: (projectId: string) => readonly ApplicationView[];
  readonly inspect: (runId: string) => TechnicalReviewStateView;
  readonly registerApplicationInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly applicationId: string;
    readonly projectId: string;
    readonly repositoryReference: string;
    readonly applicationKey: string;
    readonly ownership: string;
    readonly buildCommand: string;
    readonly testCommand: string;
  }) => ApplicationView;
  readonly reviseApplicationSpecInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly applicationId: string;
    readonly promotedProjectSpecRevisionId: string;
    readonly promotedProjectSpecHash: string;
    readonly producerSessionId: string;
    readonly content: ApplicationSpecContent;
  }) => TechnicalReviewStateView;
  readonly reviseProposalInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly producerSessionId: string;
    readonly applicationSpecRevisions: readonly {
      readonly id: string;
      readonly hash: string;
    }[];
    readonly content: TechnicalBaselineProposalContent;
  }) => TechnicalReviewStateView;
  readonly startReviewInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly topicId: string;
    readonly technicalBaselineProposalId: string;
    readonly technicalBaselineProposalHash: string;
    readonly priorQualityGateResultId?: string;
    readonly participants: readonly ReviewParticipantInput[];
    readonly quorum?: number;
    readonly budget: {
      readonly maxRounds: number;
      readonly maxDurationSeconds: number;
      readonly maxTokens: number;
      readonly maxCostCents: number;
    };
  }) => TechnicalReviewStateView;
  readonly promoteGateInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly parentSnapshotRevisionId: string;
    readonly gateResultId: string;
  }) => TechnicalReviewStateView;
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

export const openTechnicalReviewRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly reviewRuntime: Pick<
      ReviewRuntime,
      "list" | "dispatchInTransaction"
    >;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      "inspectRun" | "promoteTechnicalGateInTransaction"
    >;
    readonly clock?: () => Date;
    readonly promotionFailure?: (
      point: TechnicalGatePromotionFailurePoint,
    ) => void;
  },
): TechnicalReviewRuntime => {
  const clock = options.clock ?? (() => new Date());

  const listApplications = (projectId: string): readonly ApplicationView[] =>
    database
      .prepare(
        `SELECT id, project_id AS projectId,
                repository_reference AS repositoryReference,
                application_key AS applicationKey, ownership,
                build_command AS buildCommand, test_command AS testCommand,
                revision, created_at AS createdAt
           FROM application_references
          WHERE project_id = ?
       ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ApplicationViewSchema.parse(row));

  const inspect = (runId: string): TechnicalReviewStateView => {
    const run = database
      .prepare(
        "SELECT project_id AS projectId FROM department_runs WHERE id = ?",
      )
      .get(runId) as { readonly projectId: string } | undefined;
    if (!run) {
      throw new TechnicalReviewRuntimeError(
        "RUN_NOT_FOUND",
        `Department Run ${runId} was not found.`,
      );
    }
    const applicationSpecRevisions = database
      .prepare(
        `SELECT id, application_spec_id AS applicationSpecId,
                application_id AS applicationId, project_id AS projectId,
                run_id AS runId,
                promoted_project_spec_revision_id AS promotedProjectSpecRevisionId,
                promoted_project_spec_hash AS promotedProjectSpecHash,
                revision, supersedes_revision_id AS supersedesRevisionId,
                content_json AS contentJson, content_hash AS hash,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId,
                created_at AS createdAt
           FROM application_spec_revisions
          WHERE run_id = ?
       ORDER BY application_id, revision`,
      )
      .all(runId)
      .map((row) => {
        const revision = row as {
          readonly id: string;
          readonly applicationSpecId: string;
          readonly applicationId: string;
          readonly projectId: string;
          readonly runId: string;
          readonly promotedProjectSpecRevisionId: string;
          readonly promotedProjectSpecHash: string;
          readonly revision: number;
          readonly supersedesRevisionId: string | null;
          readonly contentJson: string;
          readonly hash: string;
          readonly producerAiMemberId: string;
          readonly producerPositionId: string;
          readonly producerSessionId: string;
          readonly createdAt: string;
        };
        return {
          id: revision.id,
          applicationSpecId: revision.applicationSpecId,
          applicationId: revision.applicationId,
          projectId: revision.projectId,
          runId: revision.runId,
          promotedProjectSpecRevisionId: revision.promotedProjectSpecRevisionId,
          promotedProjectSpecHash: revision.promotedProjectSpecHash,
          revision: Number(revision.revision),
          supersedesRevisionId: revision.supersedesRevisionId,
          content: ApplicationSpecContentSchema.parse(
            JSON.parse(revision.contentJson),
          ),
          hash: revision.hash,
          producer: {
            aiMemberId: revision.producerAiMemberId,
            positionId: revision.producerPositionId,
            sessionId: revision.producerSessionId,
          },
          createdAt: revision.createdAt,
        };
      });
    const proposalRows = database
      .prepare(
        `SELECT id,
                technical_baseline_proposal_id AS technicalBaselineProposalId,
                project_id AS projectId, run_id AS runId,
                promoted_project_spec_revision_id AS promotedProjectSpecRevisionId,
                promoted_project_spec_hash AS promotedProjectSpecHash,
                readiness_evidence_json AS readinessEvidenceJson,
                application_spec_revisions_json AS applicationSpecRevisionsJson,
                revision, supersedes_revision_id AS supersedesRevisionId,
                content_json AS contentJson, content_hash AS hash,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId,
                created_at AS createdAt
           FROM technical_baseline_proposal_revisions
          WHERE run_id = ? ORDER BY revision`,
      )
      .all(runId)
      .map((row) => {
        const proposal = row as {
          readonly id: string;
          readonly technicalBaselineProposalId: string;
          readonly projectId: string;
          readonly runId: string;
          readonly promotedProjectSpecRevisionId: string;
          readonly promotedProjectSpecHash: string;
          readonly readinessEvidenceJson: string;
          readonly applicationSpecRevisionsJson: string;
          readonly revision: number;
          readonly supersedesRevisionId: string | null;
          readonly contentJson: string;
          readonly hash: string;
          readonly producerAiMemberId: string;
          readonly producerPositionId: string;
          readonly producerSessionId: string;
          readonly createdAt: string;
        };
        return TechnicalBaselineProposalRevisionViewSchema.parse({
          id: proposal.id,
          technicalBaselineProposalId: proposal.technicalBaselineProposalId,
          projectId: proposal.projectId,
          runId: proposal.runId,
          promotedProjectSpecRevisionId: proposal.promotedProjectSpecRevisionId,
          promotedProjectSpecHash: proposal.promotedProjectSpecHash,
          readinessEvidence: JSON.parse(proposal.readinessEvidenceJson),
          applicationSpecRevisions: JSON.parse(
            proposal.applicationSpecRevisionsJson,
          ),
          revision: Number(proposal.revision),
          supersedesRevisionId: proposal.supersedesRevisionId,
          content: JSON.parse(proposal.contentJson),
          hash: proposal.hash,
          producer: {
            aiMemberId: proposal.producerAiMemberId,
            positionId: proposal.producerPositionId,
            sessionId: proposal.producerSessionId,
          },
          createdAt: proposal.createdAt,
        });
      });
    const applicationContracts = database
      .prepare(
        `SELECT contracts.contract_id AS id, contracts.version,
                contracts.producer_application_id AS producerApplicationId,
                contracts.consumer_application_id AS consumerApplicationId,
                contracts.kind, contracts.schema_text AS schema,
                contracts.compatibility_policy AS compatibilityPolicy,
                contracts.compatibility,
                contracts.evidence_refs_json AS evidenceRefsJson,
                contracts.test_commands_json AS testCommandsJson,
                contracts.content_hash AS hash
           FROM cross_application_contract_revisions AS contracts
           JOIN technical_baseline_proposal_revisions AS proposals
             ON proposals.id = contracts.proposal_revision_id
          WHERE proposals.run_id = ?
       ORDER BY proposals.revision, contracts.contract_id, contracts.version`,
      )
      .all(runId)
      .map((row) => {
        const contract = row as {
          readonly id: string;
          readonly version: string;
          readonly producerApplicationId: string;
          readonly consumerApplicationId: string;
          readonly kind: string;
          readonly schema: string;
          readonly compatibilityPolicy: string;
          readonly compatibility: string;
          readonly evidenceRefsJson: string;
          readonly testCommandsJson: string;
          readonly hash: string;
        };
        return CrossApplicationContractRevisionViewSchema.parse({
          id: contract.id,
          version: contract.version,
          producerApplicationId: contract.producerApplicationId,
          consumerApplicationId: contract.consumerApplicationId,
          kind: contract.kind,
          schema: contract.schema,
          compatibilityPolicy: contract.compatibilityPolicy,
          compatibility: contract.compatibility,
          evidenceRefs: JSON.parse(contract.evidenceRefsJson),
          testCommands: JSON.parse(contract.testCommandsJson),
          hash: contract.hash,
        });
      });
    const conditionalObligations = database
      .prepare(
        `SELECT gates.id AS qualityGateResultId,
                gates.conditions_json AS conditionsJson,
                next_topics.topic_id AS nextTopicId
           FROM quality_gate_results AS gates
           JOIN technical_review_topics AS source_topics
             ON source_topics.topic_id = gates.topic_id
      LEFT JOIN technical_review_topics AS next_topics
             ON next_topics.prior_quality_gate_result_id = gates.id
          WHERE source_topics.run_id = ?
            AND gates.result = 'CONDITIONAL_PASS'
       ORDER BY gates.created_at, gates.id`,
      )
      .all(runId)
      .map((row) => {
        const obligation = row as {
          readonly qualityGateResultId: string;
          readonly conditionsJson: string;
          readonly nextTopicId: string | null;
        };
        return {
          qualityGateResultId: obligation.qualityGateResultId,
          conditions: JSON.parse(obligation.conditionsJson),
          nextTopicId: obligation.nextTopicId,
        };
      });
    const acceptedBaselineRow = database
      .prepare(
        `SELECT id, project_id AS projectId, run_id AS runId,
                proposal_revision_id AS proposalRevisionId,
                manifest_json AS manifestJson, manifest_hash AS hash,
                created_at AS createdAt
           FROM technical_baselines WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly runId: string;
          readonly proposalRevisionId: string;
          readonly manifestJson: string;
          readonly hash: string;
          readonly createdAt: string;
        }
      | undefined;
    const promotionRow = database
      .prepare(
        `SELECT id, topic_id AS topicId,
                quality_gate_result_id AS qualityGateResultId,
                technical_baseline_id AS technicalBaselineId,
                technical_baseline_hash AS technicalBaselineHash,
                proposal_revision_id AS proposalRevisionId,
                proposal_revision_hash AS proposalRevisionHash,
                source_snapshot_revision_id AS sourceSnapshotRevisionId,
                snapshot_revision_id AS snapshotRevisionId,
                snapshot_hash AS snapshotHash, created_at AS createdAt
           FROM technical_gate_promotions WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          readonly id: string;
          readonly topicId: string;
          readonly qualityGateResultId: string;
          readonly technicalBaselineId: string;
          readonly technicalBaselineHash: string;
          readonly proposalRevisionId: string;
          readonly proposalRevisionHash: string;
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
    return TechnicalReviewStateViewSchema.parse({
      projectId: run.projectId,
      runId,
      applications: listApplications(run.projectId),
      applicationSpecRevisions,
      technicalBaselineProposals: proposalRows,
      applicationContracts,
      reviewTopics: options.reviewRuntime.list({ runId }),
      conditionalObligations,
      acceptedBaseline: acceptedBaselineRow
        ? {
            id: acceptedBaselineRow.id,
            projectId: acceptedBaselineRow.projectId,
            runId: acceptedBaselineRow.runId,
            proposalRevisionId: acceptedBaselineRow.proposalRevisionId,
            manifest: JSON.parse(acceptedBaselineRow.manifestJson),
            hash: acceptedBaselineRow.hash,
            createdAt: acceptedBaselineRow.createdAt,
          }
        : null,
      promotion: promotionRow ?? null,
      snapshotLineage,
    });
  };

  const registerApplicationInTransaction: TechnicalReviewRuntime["registerApplicationInTransaction"] =
    (input) => {
      if (input.expectedRevision !== 0) {
        throw new TechnicalReviewRuntimeError(
          "VERSION_CONFLICT",
          "A new Application registration requires expectedRevision 0.",
        );
      }
      if (
        !database
          .prepare("SELECT 1 FROM projects WHERE id = ?")
          .get(input.projectId)
      ) {
        throw new TechnicalReviewRuntimeError(
          "PROJECT_NOT_FOUND",
          `Project ${input.projectId} was not found.`,
        );
      }
      if (
        !database
          .prepare(
            `SELECT 1 FROM project_repository_references
              WHERE project_id = ? AND repository_ref = ?`,
          )
          .get(input.projectId, input.repositoryReference)
      ) {
        throw new TechnicalReviewRuntimeError(
          "APPLICATION_REPOSITORY_NOT_LINKED",
          `Repository ${input.repositoryReference} is not linked to Project ${input.projectId}.`,
        );
      }
      if (
        database
          .prepare("SELECT 1 FROM application_references WHERE id = ?")
          .get(input.applicationId)
      ) {
        throw new TechnicalReviewRuntimeError(
          "APPLICATION_ALREADY_REGISTERED",
          `Application ${input.applicationId} is already registered.`,
        );
      }

      const now = clock().toISOString();
      database
        .prepare(
          `INSERT INTO application_references(
             id, project_id, repository_reference, application_key,
             ownership, build_command, test_command, revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.applicationId,
          input.projectId,
          input.repositoryReference,
          input.applicationKey,
          input.ownership,
          input.buildCommand,
          input.testCommand,
          now,
        );

      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'application.registered', 'application', ?, NULL, NULL,
                     NULL, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          input.applicationId,
          JSON.stringify({
            projectId: input.projectId,
            repositoryReference: input.repositoryReference,
            applicationKey: input.applicationKey,
            revision: 1,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.events.append({
        type: "application.registered",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          applicationId: input.applicationId,
          commandId: input.commandId,
        },
        payload: {
          applicationId: input.applicationId,
          repositoryReference: input.repositoryReference,
          applicationKey: input.applicationKey,
          revision: 1,
        },
        timestamp: now,
      });

      const registered = listApplications(input.projectId).find(
        (application) => application.id === input.applicationId,
      );
      if (!registered) {
        throw new TechnicalReviewRuntimeError(
          "APPLICATION_REGISTRATION_FAILED",
          `Application ${input.applicationId} was not readable after registration.`,
        );
      }
      return registered;
    };

  const reviseApplicationSpecInTransaction: TechnicalReviewRuntime["reviseApplicationSpecInTransaction"] =
    (input) => {
      const run = database
        .prepare(
          "SELECT project_id AS projectId FROM department_runs WHERE id = ?",
        )
        .get(input.runId) as { readonly projectId: string } | undefined;
      if (!run) {
        throw new TechnicalReviewRuntimeError(
          "RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      const application = database
        .prepare(
          "SELECT project_id AS projectId FROM application_references WHERE id = ?",
        )
        .get(input.applicationId) as { readonly projectId: string } | undefined;
      if (!application || application.projectId !== run.projectId) {
        throw new TechnicalReviewRuntimeError(
          "APPLICATION_NOT_FOUND",
          `Application ${input.applicationId} was not found in Project ${run.projectId}.`,
        );
      }
      const promotion = database
        .prepare(
          `SELECT project_spec_revision_id AS projectSpecRevisionId,
                  project_spec_hash AS projectSpecHash
             FROM product_gate_promotions WHERE run_id = ?`,
        )
        .get(input.runId) as
        | {
            readonly projectSpecRevisionId: string;
            readonly projectSpecHash: string;
          }
        | undefined;
      if (
        !promotion ||
        promotion.projectSpecRevisionId !==
          input.promotedProjectSpecRevisionId ||
        promotion.projectSpecHash !== input.promotedProjectSpecHash
      ) {
        throw new TechnicalReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Application Spec must bind the exact Project Spec Revision promoted by the Product Gate.",
        );
      }
      const architect = database
        .prepare(
          `SELECT ai_member_id AS aiMemberId
             FROM positions WHERE id = 'software-architect'`,
        )
        .get() as { readonly aiMemberId: string } | undefined;
      const session = database
        .prepare(
          `SELECT project_id AS projectId FROM interaction_sessions WHERE id = ?`,
        )
        .get(input.producerSessionId) as
        | { readonly projectId: string }
        | undefined;
      const participant = architect
        ? database
            .prepare(
              `SELECT 1 FROM session_participants
                WHERE session_id = ? AND participant_type = 'ai-member'
                  AND participant_ref = ?`,
            )
            .get(input.producerSessionId, architect.aiMemberId)
        : undefined;
      if (
        !architect ||
        input.actor.type !== "runtime-worker" ||
        input.actor.authenticatedBy !== "runtime" ||
        input.actor.id !== architect.aiMemberId ||
        !session ||
        session.projectId !== run.projectId ||
        !participant
      ) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_OWNER_INVALID",
          "Application Spec revisions must be produced by the bound Software architect Runtime worker and Session.",
        );
      }
      const content = ApplicationSpecContentSchema.parse(input.content);
      const current = database
        .prepare(
          `SELECT id, current_revision_id AS currentRevisionId, revision
             FROM application_specs
            WHERE run_id = ? AND application_id = ?`,
        )
        .get(input.runId, input.applicationId) as
        | {
            readonly id: string;
            readonly currentRevisionId: string | null;
            readonly revision: number;
          }
        | undefined;
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new TechnicalReviewRuntimeError(
          "VERSION_CONFLICT",
          `Application Spec revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }

      const now = clock().toISOString();
      const applicationSpecId = current?.id ?? randomUUID();
      const revisionId = randomUUID();
      const nextRevision = currentRevision + 1;
      const contentJson = canonicalJson(content);
      const contentHash = sha256(
        canonicalJson({
          applicationId: input.applicationId,
          promotedProjectSpecRevisionId: input.promotedProjectSpecRevisionId,
          promotedProjectSpecHash: input.promotedProjectSpecHash,
          content,
        }),
      );
      if (!current) {
        database
          .prepare(
            `INSERT INTO application_specs(
               id, application_id, project_id, run_id, current_revision_id,
               revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`,
          )
          .run(
            applicationSpecId,
            input.applicationId,
            run.projectId,
            input.runId,
            now,
            now,
          );
      }
      database
        .prepare(
          `INSERT INTO application_spec_revisions(
             id, application_spec_id, application_id, project_id, run_id,
             promoted_project_spec_revision_id, promoted_project_spec_hash,
             revision, supersedes_revision_id, content_json, content_hash,
             producer_ai_member_id, producer_position_id,
             producer_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'software-architect', ?, ?)`,
        )
        .run(
          revisionId,
          applicationSpecId,
          input.applicationId,
          run.projectId,
          input.runId,
          input.promotedProjectSpecRevisionId,
          input.promotedProjectSpecHash,
          nextRevision,
          current?.currentRevisionId ?? null,
          contentJson,
          contentHash,
          architect.aiMemberId,
          input.producerSessionId,
          now,
        );
      database
        .prepare(
          `UPDATE application_specs
              SET current_revision_id = ?, revision = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(revisionId, nextRevision, now, applicationSpecId);

      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'application-spec.revised', 'application-spec-revision',
                     ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          revisionId,
          input.runId,
          current
            ? canonicalJson({
                revision: currentRevision,
                applicationSpecRevisionId: current.currentRevisionId,
              })
            : null,
          canonicalJson({
            applicationId: input.applicationId,
            applicationSpecId,
            applicationSpecRevisionId: revisionId,
            revision: nextRevision,
            hash: contentHash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.events.append({
        type: "application-spec.revised",
        scope: {
          companyId: "company",
          projectId: run.projectId,
          applicationId: input.applicationId,
          applicationSpecRevisionId: revisionId,
          projectSpecRevisionId: input.promotedProjectSpecRevisionId,
          runId: input.runId,
          commandId: input.commandId,
        },
        payload: {
          applicationSpecId,
          applicationSpecRevisionId: revisionId,
          applicationSpecRevision: nextRevision,
          applicationSpecHash: contentHash,
          promotedProjectSpecRevisionId: input.promotedProjectSpecRevisionId,
          promotedProjectSpecHash: input.promotedProjectSpecHash,
          supersedesRevisionId: current?.currentRevisionId ?? null,
        },
        timestamp: now,
      });
      return inspect(input.runId);
    };

  const resolveArchitect = (input: {
    readonly projectId: string;
    readonly actor: ActorRef;
    readonly producerSessionId: string;
  }): { readonly aiMemberId: string; readonly sessionId: string } => {
    const architect = database
      .prepare(
        `SELECT ai_member_id AS aiMemberId
           FROM positions WHERE id = 'software-architect'`,
      )
      .get() as { readonly aiMemberId: string } | undefined;
    const session = database
      .prepare(
        `SELECT project_id AS projectId FROM interaction_sessions WHERE id = ?`,
      )
      .get(input.producerSessionId) as
      | { readonly projectId: string }
      | undefined;
    const participant = architect
      ? database
          .prepare(
            `SELECT 1 FROM session_participants
              WHERE session_id = ? AND participant_type = 'ai-member'
                AND participant_ref = ?`,
          )
          .get(input.producerSessionId, architect.aiMemberId)
      : undefined;
    if (
      !architect ||
      input.actor.type !== "runtime-worker" ||
      input.actor.authenticatedBy !== "runtime" ||
      input.actor.id !== architect.aiMemberId ||
      !session ||
      session.projectId !== input.projectId ||
      !participant
    ) {
      throw new TechnicalReviewRuntimeError(
        "TECHNICAL_OWNER_INVALID",
        "Technical design revisions must be produced by the bound Software architect Runtime worker and Session.",
      );
    }
    return {
      aiMemberId: architect.aiMemberId,
      sessionId: input.producerSessionId,
    };
  };

  const promotedInputs = (runId: string) => {
    const promotion = database
      .prepare(
        `SELECT promotions.project_id AS projectId,
                promotions.project_spec_revision_id AS projectSpecRevisionId,
                promotions.project_spec_hash AS projectSpecHash,
                promotions.readiness_evidence_ids_json AS readinessEvidenceIdsJson
           FROM product_gate_promotions AS promotions
          WHERE promotions.run_id = ?`,
      )
      .get(runId) as
      | {
          readonly projectId: string;
          readonly projectSpecRevisionId: string;
          readonly projectSpecHash: string;
          readonly readinessEvidenceIdsJson: string;
        }
      | undefined;
    if (!promotion) {
      throw new TechnicalReviewRuntimeError(
        "PRODUCT_GATE_NOT_PROMOTED",
        `Department Run ${runId} has no Product Gate Promotion.`,
      );
    }
    const readinessIds = JSON.parse(
      promotion.readinessEvidenceIdsJson,
    ) as string[];
    const readinessEvidence = readinessIds.map((id) => {
      const row = database
        .prepare(
          `SELECT id, product_baseline_id AS productBaselineId,
                  product_baseline_hash AS productBaselineHash,
                  project_spec_revision_id AS projectSpecRevisionId,
                  project_spec_hash AS projectSpecHash, check_key AS checkKey,
                  status, summary, evidence_refs_json AS evidenceRefsJson,
                  producer_ai_member_id AS producerAiMemberId,
                  producer_position_id AS producerPositionId,
                  producer_session_id AS producerSessionId,
                  created_at AS createdAt
             FROM product_readiness_evidence WHERE id = ? AND run_id = ?`,
        )
        .get(id, runId) as Record<string, unknown> | undefined;
      if (!row) {
        throw new TechnicalReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          `Promoted Readiness Evidence ${id} is missing.`,
        );
      }
      const manifest = {
        ...row,
        evidenceRefs: JSON.parse(String(row.evidenceRefsJson)),
      };
      delete (manifest as { evidenceRefsJson?: unknown }).evidenceRefsJson;
      return { id, hash: sha256(canonicalJson(manifest)) };
    });
    return { ...promotion, readinessEvidence };
  };

  const reviseProposalInTransaction: TechnicalReviewRuntime["reviseProposalInTransaction"] =
    (input) => {
      const upstream = promotedInputs(input.runId);
      const architect = resolveArchitect({
        projectId: upstream.projectId,
        actor: input.actor,
        producerSessionId: input.producerSessionId,
      });
      const content = TechnicalBaselineProposalContentSchema.parse(
        input.content,
      );
      const currentSpecs = database
        .prepare(
          `SELECT revisions.id, revisions.application_id AS applicationId,
                  revisions.content_hash AS hash,
                  revisions.content_json AS contentJson,
                  revisions.promoted_project_spec_revision_id AS projectSpecRevisionId,
                  revisions.promoted_project_spec_hash AS projectSpecHash
             FROM application_specs AS specs
             JOIN application_spec_revisions AS revisions
               ON revisions.id = specs.current_revision_id
            WHERE specs.run_id = ?
         ORDER BY revisions.application_id`,
        )
        .all(input.runId) as Array<{
        readonly id: string;
        readonly applicationId: string;
        readonly hash: string;
        readonly contentJson: string;
        readonly projectSpecRevisionId: string;
        readonly projectSpecHash: string;
      }>;
      const applications = listApplications(upstream.projectId);
      const requested = new Map(
        input.applicationSpecRevisions.map((reference) => [
          reference.id,
          reference.hash,
        ]),
      );
      if (
        requested.size !== input.applicationSpecRevisions.length ||
        currentSpecs.length !== applications.length ||
        currentSpecs.length !== requested.size ||
        currentSpecs.some(
          (spec) =>
            requested.get(spec.id) !== spec.hash ||
            spec.projectSpecRevisionId !== upstream.projectSpecRevisionId ||
            spec.projectSpecHash !== upstream.projectSpecHash,
        )
      ) {
        throw new TechnicalReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Technical Baseline Proposal must bind the current exact Application Spec Revision/hash for every registered Application.",
        );
      }
      const specContent = new Map(
        currentSpecs.map((spec) => [
          spec.applicationId,
          ApplicationSpecContentSchema.parse(JSON.parse(spec.contentJson)),
        ]),
      );
      const contractKeys = new Set<string>();
      const contractRows = content.contracts.map((contract) => {
        const key = `${contract.id}:${contract.version}`;
        const producer = specContent.get(contract.producerApplicationId);
        const consumer = specContent.get(contract.consumerApplicationId);
        if (
          contractKeys.has(key) ||
          !producer?.contractRefs.some(
            (reference) =>
              reference.id === contract.id &&
              reference.version === contract.version,
          ) ||
          !consumer?.contractRefs.some(
            (reference) =>
              reference.id === contract.id &&
              reference.version === contract.version,
          )
        ) {
          throw new TechnicalReviewRuntimeError(
            "CONTRACT_REFERENCE_MISMATCH",
            `Cross-Application Contract ${key} must be referenced by its producer and consumer Application Specs.`,
          );
        }
        contractKeys.add(key);
        const hash = sha256(
          canonicalJson({
            id: contract.id,
            version: contract.version,
            producerApplicationId: contract.producerApplicationId,
            consumerApplicationId: contract.consumerApplicationId,
            kind: contract.kind,
            schema: contract.schema,
            compatibilityPolicy: contract.compatibilityPolicy,
            testCommands: contract.testCommands,
          }),
        );
        return { ...contract, hash };
      });
      const current = database
        .prepare(
          `SELECT id, current_revision_id AS currentRevisionId, revision
             FROM technical_baseline_proposals WHERE run_id = ?`,
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
        throw new TechnicalReviewRuntimeError(
          "VERSION_CONFLICT",
          `Technical Baseline Proposal revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const applicationSpecRefs = currentSpecs.map((spec) => ({
        applicationId: spec.applicationId,
        id: spec.id,
        hash: spec.hash,
      }));
      const now = clock().toISOString();
      const proposalId = current?.id ?? randomUUID();
      const proposalRevisionId = randomUUID();
      const nextRevision = currentRevision + 1;
      const proposalHash = sha256(
        canonicalJson({
          promotedProjectSpecRevisionId: upstream.projectSpecRevisionId,
          promotedProjectSpecHash: upstream.projectSpecHash,
          readinessEvidence: upstream.readinessEvidence,
          applicationSpecRevisions: applicationSpecRefs,
          content,
        }),
      );
      if (!current) {
        database
          .prepare(
            `INSERT INTO technical_baseline_proposals(
               id, project_id, run_id, current_revision_id, revision,
               created_at, updated_at
             ) VALUES (?, ?, ?, NULL, 0, ?, ?)`,
          )
          .run(proposalId, upstream.projectId, input.runId, now, now);
      }
      database
        .prepare(
          `INSERT INTO technical_baseline_proposal_revisions(
             id, technical_baseline_proposal_id, project_id, run_id,
             promoted_project_spec_revision_id, promoted_project_spec_hash,
             readiness_evidence_json, application_spec_revisions_json,
             revision, supersedes_revision_id, content_json, content_hash,
             producer_ai_member_id, producer_position_id,
             producer_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'software-architect', ?, ?)`,
        )
        .run(
          proposalRevisionId,
          proposalId,
          upstream.projectId,
          input.runId,
          upstream.projectSpecRevisionId,
          upstream.projectSpecHash,
          canonicalJson(upstream.readinessEvidence),
          canonicalJson(applicationSpecRefs),
          nextRevision,
          current?.currentRevisionId ?? null,
          canonicalJson(content),
          proposalHash,
          architect.aiMemberId,
          architect.sessionId,
          now,
        );
      const insertContract = database.prepare(
        `INSERT INTO cross_application_contract_revisions(
           proposal_revision_id, contract_id, version,
           producer_application_id, consumer_application_id, kind,
           schema_text, compatibility_policy, compatibility,
           evidence_refs_json, test_commands_json, content_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const contract of contractRows) {
        insertContract.run(
          proposalRevisionId,
          contract.id,
          contract.version,
          contract.producerApplicationId,
          contract.consumerApplicationId,
          contract.kind,
          contract.schema,
          contract.compatibilityPolicy,
          contract.compatibility,
          canonicalJson(contract.evidenceRefs),
          canonicalJson(contract.testCommands),
          contract.hash,
          now,
        );
      }
      database
        .prepare(
          `UPDATE technical_baseline_proposals
              SET current_revision_id = ?, revision = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(proposalRevisionId, nextRevision, now, proposalId);
      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, 'technical-proposal.revised',
                     'technical-baseline-proposal-revision', ?, ?, NULL,
                     ?, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          proposalRevisionId,
          input.runId,
          current
            ? canonicalJson({
                revision: currentRevision,
                proposalRevisionId: current.currentRevisionId,
              })
            : null,
          canonicalJson({
            technicalBaselineProposalId: proposalId,
            proposalRevisionId,
            revision: nextRevision,
            hash: proposalHash,
          }),
          now,
          input.commandId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
        );
      options.events.append({
        type: "technical-proposal.revised",
        scope: {
          companyId: "company",
          projectId: upstream.projectId,
          projectSpecRevisionId: upstream.projectSpecRevisionId,
          technicalBaselineProposalId: proposalId,
          runId: input.runId,
          commandId: input.commandId,
        },
        payload: {
          technicalBaselineProposalId: proposalId,
          proposalRevisionId,
          proposalRevision: nextRevision,
          proposalHash,
          promotedProjectSpecRevisionId: upstream.projectSpecRevisionId,
          promotedProjectSpecHash: upstream.projectSpecHash,
          applicationSpecRevisionIds: applicationSpecRefs.map((ref) => ref.id),
          contractRefs: contractRows.map((contract) => ({
            id: contract.id,
            version: contract.version,
            hash: contract.hash,
          })),
          supersedesRevisionId: current?.currentRevisionId ?? null,
        },
        timestamp: now,
      });
      return inspect(input.runId);
    };

  const startReviewInTransaction: TechnicalReviewRuntime["startReviewInTransaction"] =
    (input) => {
      const state = inspect(input.runId);
      const proposal = state.technicalBaselineProposals.find(
        (candidate) => candidate.id === input.technicalBaselineProposalId,
      );
      const currentProposal = state.technicalBaselineProposals.at(-1);
      const currentSpecs = state.applicationSpecRevisions.filter((revision) =>
        state.applicationSpecRevisions.every(
          (candidate) =>
            candidate.applicationId !== revision.applicationId ||
            candidate.revision <= revision.revision,
        ),
      );
      if (
        !proposal ||
        proposal !== currentProposal ||
        proposal.hash !== input.technicalBaselineProposalHash ||
        proposal.revision !== input.expectedRevision ||
        proposal.applicationSpecRevisions.length !== currentSpecs.length ||
        proposal.applicationSpecRevisions.some((reference) => {
          const current = currentSpecs.find(
            (revision) => revision.applicationId === reference.applicationId,
          );
          return (
            !current ||
            current.id !== reference.id ||
            current.hash !== reference.hash
          );
        })
      ) {
        throw new TechnicalReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Technical Review must bind the current exact Proposal and Application Spec revisions.",
        );
      }
      const owner = input.participants.find(
        (participant) => participant.role === "owner-participant",
      );
      if (
        !owner ||
        owner.aiMemberId !== proposal.producer.aiMemberId ||
        owner.positionId !== proposal.producer.positionId ||
        owner.sessionId !== proposal.producer.sessionId
      ) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_OWNER_INVALID",
          "Technical Review owner-participant must be the exact Software architect proposal producer.",
        );
      }
      const openConditional = database
        .prepare(
          `SELECT gates.id, gates.result,
                  source_topics.proposal_revision_id AS proposalRevisionId
             FROM quality_gate_results AS gates
             JOIN technical_review_topics AS source_topics
               ON source_topics.topic_id = gates.topic_id
        LEFT JOIN technical_review_topics AS next_topics
               ON next_topics.prior_quality_gate_result_id = gates.id
            WHERE source_topics.run_id = ?
              AND gates.result = 'CONDITIONAL_PASS'
              AND next_topics.topic_id IS NULL
         ORDER BY gates.created_at DESC, gates.id DESC LIMIT 1`,
        )
        .get(input.runId) as
        | {
            readonly id: string;
            readonly result: "CONDITIONAL_PASS";
            readonly proposalRevisionId: string;
          }
        | undefined;
      if (
        openConditional &&
        input.priorQualityGateResultId !== openConditional.id
      ) {
        throw new TechnicalReviewRuntimeError(
          "CONDITIONAL_OBLIGATIONS_LINK_REQUIRED",
          `Technical Review must link unresolved conditional Gate ${openConditional.id}.`,
        );
      }
      if (!openConditional && input.priorQualityGateResultId) {
        throw new TechnicalReviewRuntimeError(
          "CONDITIONAL_OBLIGATIONS_MISMATCH",
          `Conditional Gate ${input.priorQualityGateResultId} is not an unresolved Technical Review obligation for this Run.`,
        );
      }
      if (
        openConditional &&
        proposal.supersedesRevisionId !== openConditional.proposalRevisionId
      ) {
        throw new TechnicalReviewRuntimeError(
          "CONDITIONAL_OBLIGATIONS_MISMATCH",
          "A conditional re-review must use the Proposal revision that supersedes the conditionally reviewed Proposal.",
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
          runId: input.runId,
          title: "Technical Review",
          manifest: {
            scope: "technical",
            topicId: input.topicId,
            supportingArtifactVersionIds: [],
            supportingSpecRevisionIds: [
              proposal.promotedProjectSpecRevisionId,
              ...proposal.applicationSpecRevisions.map(
                (reference) => reference.id,
              ),
            ],
            harnessSnapshotIds: [],
            acceptanceCriteria: currentSpecs.flatMap(
              (revision) => revision.content.acceptanceCriteria,
            ),
            excludedContext: [
              "hidden-prompts",
              "prior-reviewer-opinions",
              "private-transcripts",
              "provider-session-history",
              "credential-values",
            ],
            promotedProjectSpecRevisionId:
              proposal.promotedProjectSpecRevisionId,
            promotedProjectSpecHash: proposal.promotedProjectSpecHash,
            readinessEvidence: proposal.readinessEvidence,
            applicationSpecRevisions: proposal.applicationSpecRevisions,
            technicalBaselineProposalId: proposal.id,
            technicalBaselineProposalHash: proposal.hash,
            crossApplicationContracts: proposal.content.contracts
              .map((contract) => {
                const found = state.applicationContracts.find(
                  (candidate) =>
                    candidate.id === contract.id &&
                    candidate.version === contract.version,
                );
                if (!found) {
                  throw new TechnicalReviewRuntimeError(
                    "CONTRACT_REFERENCE_MISMATCH",
                    `Contract ${contract.id}:${contract.version} is missing.`,
                  );
                }
                return {
                  id: found.id,
                  version: found.version,
                  hash: found.hash,
                };
              })
              .sort((left, right) =>
                `${left.id}:${left.version}`.localeCompare(
                  `${right.id}:${right.version}`,
                ),
              ),
          },
          producer: proposal.producer,
          participants: [...input.participants],
          quorum: input.quorum,
          budget: input.budget,
          stopCondition: "blocking-findings-dispositioned",
          escalationPolicy: "fail-with-evidence",
        },
      });
      database
        .prepare(
          `INSERT INTO technical_review_topics(
             topic_id, run_id, proposal_revision_id,
             prior_quality_gate_result_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.topicId,
          input.runId,
          proposal.id,
          input.priorQualityGateResultId ?? null,
          clock().toISOString(),
        );
      return inspect(input.runId);
    };

  const promoteGateInTransaction: TechnicalReviewRuntime["promoteGateInTransaction"] =
    (input) => {
      const state = inspect(input.runId);
      if (state.promotion) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_GATE_ALREADY_PROMOTED",
          `Run ${input.runId} already has a Technical Gate Promotion.`,
        );
      }
      const run = options.pipelineRuntime.inspectRun(input.runId);
      if (run.run.revision !== input.expectedRevision) {
        throw new TechnicalReviewRuntimeError(
          "VERSION_CONFLICT",
          `Run revision ${input.expectedRevision} does not match current revision ${run.run.revision}.`,
        );
      }
      if (run.run.snapshotRevisionId !== input.parentSnapshotRevisionId) {
        throw new TechnicalReviewRuntimeError(
          "RUN_SNAPSHOT_CONFLICT",
          "Technical Gate promotion must extend the current Snapshot Revision.",
        );
      }
      const coordinator = database
        .prepare(
          `SELECT ai_member_id AS aiMemberId
             FROM positions WHERE id = 'delivery-coordinator'`,
        )
        .get() as { readonly aiMemberId: string } | undefined;
      if (
        !coordinator ||
        input.actor.type !== "runtime-worker" ||
        input.actor.authenticatedBy !== "runtime" ||
        input.actor.id !== coordinator.aiMemberId
      ) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_GATE_ACTOR_INVALID",
          "Technical Gate promotion must be submitted by the bound Delivery coordinator Runtime worker.",
        );
      }
      const topic = state.reviewTopics.find(
        (candidate) => candidate.gateResult?.id === input.gateResultId,
      );
      const topicManifest = topic?.topic.manifest;
      if (
        !topic ||
        topic.topic.kind !== "technical" ||
        topicManifest?.scope !== "technical" ||
        topic.gateResult?.result !== "PASS" ||
        !topic.gateResult.satisfiesProductionContract
      ) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_GATE_NOT_PASS",
          "Technical Gate promotion requires a fresh exact PASS Technical Quality Gate Result for this Run.",
        );
      }
      const proposal = state.technicalBaselineProposals.find(
        (candidate) =>
          candidate.id === topicManifest.technicalBaselineProposalId,
      );
      const currentProposal = state.technicalBaselineProposals.at(-1);
      const gateRevision = topic.revisions.find(
        (revision) => revision.id === topic.gateResult?.revisionId,
      );
      const upstream = promotedInputs(input.runId);
      const currentSpecs = database
        .prepare(
          `SELECT revisions.application_id AS applicationId,
                  revisions.id, revisions.content_hash AS hash
             FROM application_specs AS specs
             JOIN application_spec_revisions AS revisions
               ON revisions.id = specs.current_revision_id
            WHERE specs.run_id = ?
         ORDER BY revisions.application_id`,
        )
        .all(input.runId) as Array<{
        readonly applicationId: string;
        readonly id: string;
        readonly hash: string;
      }>;
      if (
        !proposal ||
        proposal !== currentProposal ||
        proposal.hash !== topicManifest.technicalBaselineProposalHash ||
        proposal.promotedProjectSpecRevisionId !==
          upstream.projectSpecRevisionId ||
        proposal.promotedProjectSpecHash !== upstream.projectSpecHash ||
        canonicalJson(proposal.readinessEvidence) !==
          canonicalJson(upstream.readinessEvidence) ||
        canonicalJson(proposal.applicationSpecRevisions) !==
          canonicalJson(currentSpecs) ||
        !gateRevision ||
        gateRevision.subjectKind !== "technical-baseline-proposal" ||
        gateRevision.subjectId !== proposal.id ||
        gateRevision.subjectHash !== proposal.hash
      ) {
        throw new TechnicalReviewRuntimeError(
          "SPEC_CONTRACT_MISMATCH",
          "Technical Gate promotion inputs no longer match the exact passed Proposal, promoted Product inputs, and current Application Specs.",
        );
      }
      const contracts = database
        .prepare(
          `SELECT contract_id AS id, version, content_hash AS hash,
                  compatibility, evidence_refs_json AS evidenceRefsJson
             FROM cross_application_contract_revisions
            WHERE proposal_revision_id = ?
         ORDER BY contract_id, version`,
        )
        .all(proposal.id) as Array<{
        readonly id: string;
        readonly version: string;
        readonly hash: string;
        readonly compatibility: "compatible" | "incompatible";
        readonly evidenceRefsJson: string;
      }>;
      const incompatible = contracts.find(
        (contract) => contract.compatibility === "incompatible",
      );
      if (incompatible) {
        throw new TechnicalReviewRuntimeError(
          "TECHNICAL_CONTRACT_INCOMPATIBLE",
          `Cross-Application Contract ${incompatible.id}:${incompatible.version} is incompatible; evidence ${incompatible.evidenceRefsJson} remains attached to the Proposal.`,
        );
      }
      const manifest = TechnicalBaselineManifestSchema.parse({
        schemaVersion: 1,
        promotedProjectSpecRevisionId: proposal.promotedProjectSpecRevisionId,
        promotedProjectSpecHash: proposal.promotedProjectSpecHash,
        readinessEvidence: proposal.readinessEvidence,
        applicationSpecRevisions: proposal.applicationSpecRevisions,
        proposalRevisionId: proposal.id,
        proposalRevisionHash: proposal.hash,
        crossApplicationContracts: contracts.map(({ id, version, hash }) => ({
          id,
          version,
          hash,
        })),
        architecture: proposal.content.architecture,
        dependencyGraph: proposal.content.dependencyGraph,
        riskPolicy: proposal.content.riskPolicy,
        permissionPolicy: proposal.content.permissionPolicy,
        testStrategy: proposal.content.testStrategy,
      });
      const now = clock().toISOString();
      const technicalBaselineId = randomUUID();
      const technicalBaselineHash = sha256(canonicalJson(manifest));
      const snapshotRevisionId = randomUUID();
      const promotionId = randomUUID();
      options.promotionFailure?.("before-baseline");
      database
        .prepare(
          `INSERT INTO technical_baselines(
             id, project_id, run_id, proposal_revision_id,
             manifest_json, manifest_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          technicalBaselineId,
          state.projectId,
          input.runId,
          proposal.id,
          canonicalJson(manifest),
          technicalBaselineHash,
          now,
        );
      const promotedRun =
        options.pipelineRuntime.promoteTechnicalGateInTransaction({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          sourceSnapshotRevisionId: input.parentSnapshotRevisionId,
          snapshotRevisionId,
          qualityGateResultId: topic.gateResult.id,
          technicalBaselineId,
          technicalBaselineHash,
          applicationSpecRevisions: proposal.applicationSpecRevisions,
          promotedAt: now,
          checkpoint: (point) => options.promotionFailure?.(point),
        });
      options.promotionFailure?.("before-promotion");
      database
        .prepare(
          `INSERT INTO technical_gate_promotions(
             id, project_id, run_id, topic_id, quality_gate_result_id,
             technical_baseline_id, technical_baseline_hash,
             proposal_revision_id, proposal_revision_hash,
             source_snapshot_revision_id, snapshot_revision_id,
             snapshot_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          promotionId,
          state.projectId,
          input.runId,
          topic.topic.id,
          topic.gateResult.id,
          technicalBaselineId,
          technicalBaselineHash,
          proposal.id,
          proposal.hash,
          input.parentSnapshotRevisionId,
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
           ) VALUES (?, 'technical-gate.promoted', 'technical-gate-promotion',
                     ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
                     (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
        )
        .run(
          auditId,
          promotionId,
          input.runId,
          canonicalJson({ snapshotRevisionId: input.parentSnapshotRevisionId }),
          canonicalJson({
            qualityGateResultId: topic.gateResult.id,
            technicalBaselineId,
            technicalBaselineHash,
            proposalRevisionId: proposal.id,
            proposalRevisionHash: proposal.hash,
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
          type: "technical-gate.passed",
          payload: {
            promotionId,
            topicId: topic.topic.id,
            qualityGateResultId: topic.gateResult.id,
            proposalRevisionId: proposal.id,
            proposalRevisionHash: proposal.hash,
          },
        },
        {
          type: "technical-baseline.accepted",
          payload: {
            promotionId,
            technicalBaselineId,
            technicalBaselineHash,
            applicationSpecRevisionIds: proposal.applicationSpecRevisions.map(
              (reference) => reference.id,
            ),
          },
        },
        {
          type: "snapshot.promoted",
          payload: {
            promotionId,
            sourceSnapshotRevisionId: input.parentSnapshotRevisionId,
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
            projectSpecRevisionId: proposal.promotedProjectSpecRevisionId,
            technicalBaselineProposalId: proposal.technicalBaselineProposalId,
            technicalBaselineId,
            runId: input.runId,
            snapshotRevisionId,
            topicId: topic.topic.id,
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
    listApplications,
    inspect,
    registerApplicationInTransaction,
    reviseApplicationSpecInTransaction,
    reviseProposalInTransaction,
    startReviewInTransaction,
    promoteGateInTransaction,
  };
};
