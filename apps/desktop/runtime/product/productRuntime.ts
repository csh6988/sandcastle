import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ProductDiscoveryViewSchema,
  ProductBaselineViewSchema,
  ProductProposalContentSchema,
  type ActorRef,
  type ProductDiscoveryView,
  type ProductProposalContent,
} from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";

export type ProductConfirmationFailurePoint =
  | "before-baseline"
  | "before-run"
  | "before-snapshot"
  | "before-audit"
  | "before-outbox"
  | "before-receipt"
  | "before-commit";

export class ProductRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductRuntimeError";
  }
}

export interface ProductRuntime {
  readonly inspect: (projectId: string) => ProductDiscoveryView;
  readonly reviseProposalInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly projectId: string;
    readonly producerSessionId: string;
    readonly content: ProductProposalContent;
  }) => ProductDiscoveryView;
  readonly markAwaitingConfirmationInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly projectId: string;
    readonly proposalRevisionId: string;
    readonly proposalHash: string;
  }) => ProductDiscoveryView;
  readonly confirmProductBaselineInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
    readonly forkSourceRunId?: string;
    readonly forkSourceSnapshotRevisionId?: string;
    readonly proposalRevisionId: string;
    readonly proposalHash: string;
  }) => ProductDiscoveryView;
  readonly forkDepartmentRunInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly sourceRunId: string;
    readonly sourceSnapshotRevisionId: string;
    readonly reason: string;
  }) => ProductDiscoveryView;
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
    throw new ProductRuntimeError(
      "PRODUCT_DATA_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

export const openProductRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      "formalizeRunInTransaction" | "replayForkInTransaction" | "inspectRun"
    >;
    readonly clock?: () => Date;
    readonly confirmationFailure?: (
      point: ProductConfirmationFailurePoint,
    ) => void;
  },
): ProductRuntime => {
  const clock = options.clock ?? (() => new Date());

  const inspect = (projectId: string): ProductDiscoveryView => {
    const project = database
      .prepare(
        `SELECT id, name, goal, revision
           FROM projects
          WHERE id = ?`,
      )
      .get(projectId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly goal: string;
          readonly revision: number;
        }
      | undefined;
    if (!project) {
      throw new ProductRuntimeError(
        "PROJECT_NOT_FOUND",
        `Project ${projectId} was not found.`,
      );
    }
    const proposal = database
      .prepare(
        `SELECT product_proposals.id,
                product_proposals.project_id AS projectId,
                product_proposals.status,
                product_proposals.revision,
                product_proposals.created_at AS createdAt,
                product_proposals.updated_at AS updatedAt,
                revisions.id AS revisionId,
                revisions.revision AS contentRevision,
                revisions.content_json AS contentJson,
                revisions.content_hash AS contentHash,
                revisions.producer_ai_member_id AS producerAiMemberId,
                revisions.producer_position_id AS producerPositionId,
                revisions.producer_session_id AS producerSessionId,
                revisions.edited_by_type AS editedByType,
                revisions.edited_by_id AS editedById,
                revisions.edited_by_authenticated_by AS editedByAuthenticatedBy,
                revisions.created_at AS revisionCreatedAt
           FROM product_proposals
           JOIN product_proposal_revisions AS revisions
             ON revisions.id = product_proposals.current_revision_id
          WHERE product_proposals.project_id = ?`,
      )
      .get(projectId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly status: string;
          readonly revision: number;
          readonly createdAt: string;
          readonly updatedAt: string;
          readonly revisionId: string;
          readonly contentRevision: number;
          readonly contentJson: string;
          readonly contentHash: string;
          readonly producerAiMemberId: string;
          readonly producerPositionId: string;
          readonly producerSessionId: string;
          readonly editedByType: ActorRef["type"];
          readonly editedById: string;
          readonly editedByAuthenticatedBy: ActorRef["authenticatedBy"];
          readonly revisionCreatedAt: string;
        }
      | undefined;

    const baselineRows = database
      .prepare(
        `SELECT id, project_id AS projectId,
                source_proposal_revision_id AS sourceProposalRevisionId,
                source_proposal_hash AS sourceProposalHash,
                content_json AS contentJson, canonical_hash AS hash,
                confirmed_by_type AS confirmedByType,
                confirmed_by_id AS confirmedById,
                confirmed_by_authenticated_by AS confirmedByAuthenticatedBy,
                confirmation_command_id AS confirmationCommandId,
                run_id AS runId, snapshot_revision_id AS snapshotRevisionId,
                confirmed_at AS confirmedAt
           FROM product_baselines
          WHERE project_id = ?
       ORDER BY confirmed_at, id`,
      )
      .all(projectId) as Array<{
      readonly id: string;
      readonly projectId: string;
      readonly sourceProposalRevisionId: string;
      readonly sourceProposalHash: string;
      readonly contentJson: string;
      readonly hash: string;
      readonly confirmedByType: ActorRef["type"];
      readonly confirmedById: string;
      readonly confirmedByAuthenticatedBy: ActorRef["authenticatedBy"];
      readonly confirmationCommandId: string;
      readonly runId: string;
      readonly snapshotRevisionId: string;
      readonly confirmedAt: string;
    }>;
    const formalRuns = database
      .prepare(
        `SELECT id AS runId, product_baseline_id AS productBaselineId,
                snapshot_revision_id AS snapshotRevisionId,
                parent_run_id AS parentRunId,
                forked_from_snapshot_revision_id AS forkedFromSnapshotRevisionId,
                status, created_at AS createdAt
           FROM department_runs
          WHERE project_id = ? AND product_baseline_id IS NOT NULL
       ORDER BY created_at, id`,
      )
      .all(projectId);

    return ProductDiscoveryViewSchema.parse({
      project: { ...project, revision: Number(project.revision) },
      proposal: proposal
        ? {
            id: proposal.id,
            projectId: proposal.projectId,
            status: proposal.status,
            revision: Number(proposal.revision),
            currentRevision: {
              id: proposal.revisionId,
              revision: Number(proposal.contentRevision),
              hash: proposal.contentHash,
              content: ProductProposalContentSchema.parse(
                parseJson(
                  proposal.contentJson,
                  `Product Proposal Revision ${proposal.revisionId}`,
                ),
              ),
              producer: {
                aiMemberId: proposal.producerAiMemberId,
                positionId: proposal.producerPositionId,
                sessionId: proposal.producerSessionId,
              },
              editedBy: {
                type: proposal.editedByType,
                id: proposal.editedById,
                authenticatedBy: proposal.editedByAuthenticatedBy,
              },
              createdAt: proposal.revisionCreatedAt,
            },
            createdAt: proposal.createdAt,
            updatedAt: proposal.updatedAt,
          }
        : null,
      baselines: baselineRows.map((baseline) =>
        ProductBaselineViewSchema.parse({
          id: baseline.id,
          projectId: baseline.projectId,
          sourceProposalRevisionId: baseline.sourceProposalRevisionId,
          sourceProposalHash: baseline.sourceProposalHash,
          content: ProductProposalContentSchema.parse(
            parseJson(baseline.contentJson, `Product Baseline ${baseline.id}`),
          ),
          hash: baseline.hash,
          confirmedBy: {
            type: baseline.confirmedByType,
            id: baseline.confirmedById,
            authenticatedBy: baseline.confirmedByAuthenticatedBy,
          },
          confirmationCommandId: baseline.confirmationCommandId,
          confirmedAt: baseline.confirmedAt,
          runId: baseline.runId,
          snapshotRevisionId: baseline.snapshotRevisionId,
        }),
      ),
      formalRuns,
    });
  };

  const resolveProducer = (input: {
    readonly projectId: string;
    readonly sessionId: string;
  }): {
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  } => {
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
      throw new ProductRuntimeError(
        "PRODUCT_PRODUCER_INVALID",
        "Product Proposal producer must resolve from an active Product manager Consultation Session.",
      );
    }
    return producer;
  };

  const appendAudit = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly proposalId: string;
    readonly entityType?: string;
    readonly runId?: string;
    readonly before: unknown;
    readonly after: unknown;
    readonly createdAt: string;
  }): string => {
    const auditId = randomUUID();
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        auditId,
        input.action,
        input.entityType ?? "product-proposal",
        input.proposalId,
        input.runId ?? null,
        input.before === null ? null : canonicalJson(input.before),
        canonicalJson(input.after),
        input.createdAt,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    return auditId;
  };

  const reviseProposalInTransaction: ProductRuntime["reviseProposalInTransaction"] =
    (input) => {
      const content = ProductProposalContentSchema.parse(input.content);
      const producer = resolveProducer({
        projectId: input.projectId,
        sessionId: input.producerSessionId,
      });
      const current = database
        .prepare(
          `SELECT id, status, revision, current_revision_id AS currentRevisionId
             FROM product_proposals
            WHERE project_id = ?`,
        )
        .get(input.projectId) as
        | {
            readonly id: string;
            readonly status: string;
            readonly revision: number;
            readonly currentRevisionId: string;
          }
        | undefined;
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new ProductRuntimeError(
          "VERSION_CONFLICT",
          `Product Proposal revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const now = clock().toISOString();
      const proposalId = current?.id ?? randomUUID();
      const proposalRevisionId = randomUUID();
      const nextRevision = currentRevision + 1;
      const contentJson = canonicalJson(content);
      const contentHash = sha256(contentJson);
      if (!current) {
        database
          .prepare(
            `INSERT INTO product_proposals(
               id, project_id, status, revision, current_revision_id,
               created_at, updated_at
             ) VALUES (?, ?, 'clarifying', ?, ?, ?, ?)`,
          )
          .run(
            proposalId,
            input.projectId,
            nextRevision,
            proposalRevisionId,
            now,
            now,
          );
      }
      database
        .prepare(
          `INSERT INTO product_proposal_revisions(
             id, proposal_id, revision, content_json, content_hash,
             producer_ai_member_id, producer_position_id, producer_session_id,
             edited_by_type, edited_by_id, edited_by_authenticated_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposalRevisionId,
          proposalId,
          nextRevision,
          contentJson,
          contentHash,
          producer.aiMemberId,
          producer.positionId,
          producer.sessionId,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
          now,
        );
      if (current) {
        database
          .prepare(
            `UPDATE product_proposals
                SET status = 'clarifying', revision = ?, current_revision_id = ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(nextRevision, proposalRevisionId, now, proposalId);
      }
      appendAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "product.proposal.revised",
        proposalId,
        before: current
          ? { status: current.status, revision: currentRevision }
          : null,
        after: {
          status: "clarifying",
          revision: nextRevision,
          proposalRevisionId,
          proposalHash: contentHash,
        },
        createdAt: now,
      });
      options.events.append({
        type: "product.proposal.revised",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          productProposalId: proposalId,
          commandId: input.commandId,
        },
        payload: {
          productProposalId: proposalId,
          proposalRevisionId,
          proposalRevision: nextRevision,
          proposalHash: contentHash,
          status: "clarifying",
        },
        timestamp: now,
      });
      return inspect(input.projectId);
    };

  const markAwaitingConfirmationInTransaction: ProductRuntime["markAwaitingConfirmationInTransaction"] =
    (input) => {
      const current = inspect(input.projectId).proposal;
      if (!current) {
        throw new ProductRuntimeError(
          "PRODUCT_PROPOSAL_NOT_FOUND",
          `Project ${input.projectId} has no Product Proposal.`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ProductRuntimeError(
          "VERSION_CONFLICT",
          `Product Proposal revision ${input.expectedRevision} does not match current revision ${current.revision}.`,
        );
      }
      if (
        current.currentRevision.id !== input.proposalRevisionId ||
        current.currentRevision.hash !== input.proposalHash
      ) {
        throw new ProductRuntimeError(
          "PRODUCT_PROPOSAL_MISMATCH",
          "Product Proposal confirmation request does not match the current exact revision.",
        );
      }
      const nextRevision = current.revision + 1;
      const now = clock().toISOString();
      database
        .prepare(
          `UPDATE product_proposals
              SET status = 'awaiting-confirmation', revision = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(nextRevision, now, current.id);
      appendAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "product.proposal.awaiting-confirmation",
        proposalId: current.id,
        before: { status: current.status, revision: current.revision },
        after: {
          status: "awaiting-confirmation",
          revision: nextRevision,
          proposalRevisionId: current.currentRevision.id,
          proposalHash: current.currentRevision.hash,
        },
        createdAt: now,
      });
      options.events.append({
        type: "product.proposal.awaiting-confirmation",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          productProposalId: current.id,
          commandId: input.commandId,
        },
        payload: {
          productProposalId: current.id,
          proposalRevisionId: current.currentRevision.id,
          proposalRevision: current.currentRevision.revision,
          proposalHash: current.currentRevision.hash,
          status: "awaiting-confirmation",
        },
        timestamp: now,
      });
      return inspect(input.projectId);
    };

  const confirmProductBaselineInTransaction: ProductRuntime["confirmProductBaselineInTransaction"] =
    (input) => {
      if (
        input.actor.type !== "human" ||
        input.actor.authenticatedBy !== "local-session"
      ) {
        throw new ProductRuntimeError(
          "BASELINE_ACTOR_INVALID",
          "Product Baseline confirmation requires a verified human actor.",
        );
      }
      const current = inspect(input.projectId).proposal;
      if (!current) {
        throw new ProductRuntimeError(
          "PRODUCT_PROPOSAL_NOT_FOUND",
          `Project ${input.projectId} has no Product Proposal.`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ProductRuntimeError(
          "VERSION_CONFLICT",
          `Product Proposal revision ${input.expectedRevision} does not match current revision ${current.revision}.`,
        );
      }
      if (
        current.currentRevision.id !== input.proposalRevisionId ||
        current.currentRevision.hash !== input.proposalHash
      ) {
        throw new ProductRuntimeError(
          "PRODUCT_PROPOSAL_MISMATCH",
          "Product Baseline confirmation request does not match the exact Proposal revision.",
        );
      }
      const existing = database
        .prepare(
          `SELECT id FROM product_baselines
            WHERE project_id = ? AND source_proposal_revision_id = ?`,
        )
        .get(input.projectId, input.proposalRevisionId) as
        | { readonly id: string }
        | undefined;
      if (existing) return inspect(input.projectId);
      if (current.status !== "awaiting-confirmation") {
        throw new ProductRuntimeError(
          "PRODUCT_PROPOSAL_MISMATCH",
          "Product Baseline confirmation requires an awaiting Proposal revision.",
        );
      }
      const content = current.currentRevision.content;
      if (
        content.users.length === 0 ||
        content.scope.length === 0 ||
        content.acceptanceCriteria.length === 0 ||
        content.constraints.length === 0 ||
        content.risks.length === 0 ||
        content.openQuestions.length > 0
      ) {
        throw new ProductRuntimeError(
          "BASELINE_INCOMPLETE",
          "Product Proposal is incomplete and cannot form a Product Baseline.",
        );
      }

      const priorBaseline = database
        .prepare(
          `SELECT id FROM product_baselines
            WHERE project_id = ? LIMIT 1`,
        )
        .get(input.projectId) as { readonly id: string } | undefined;
      const hasForkSource =
        input.forkSourceRunId !== undefined ||
        input.forkSourceSnapshotRevisionId !== undefined;
      if (
        hasForkSource &&
        (!input.forkSourceRunId || !input.forkSourceSnapshotRevisionId)
      ) {
        throw new ProductRuntimeError(
          "FORK_SOURCE_INVALID",
          "Baseline-changing confirmation requires both source Run and source Snapshot Revision.",
        );
      }
      if (priorBaseline && !hasForkSource) {
        throw new ProductRuntimeError(
          "BASELINE_FORK_REQUIRED",
          "A new Product Baseline must be confirmed as a child Fork of the existing Run.",
        );
      }
      if (hasForkSource) {
        const source = options.pipelineRuntime.inspectRun(
          input.forkSourceRunId!,
        );
        const sourceSnapshot = database
          .prepare(
            `SELECT id FROM run_snapshot_revisions
              WHERE id = ? AND run_id = ?`,
          )
          .get(input.forkSourceSnapshotRevisionId!, input.forkSourceRunId!);
        if (
          source.run.projectId !== input.projectId ||
          source.run.departmentId !== input.departmentId ||
          !sourceSnapshot ||
          !source.run.productBaselineId
        ) {
          throw new ProductRuntimeError(
            "FORK_SOURCE_INVALID",
            "Baseline-changing confirmation requires an exact formal Run/Snapshot from the same Project and Department.",
          );
        }
      }

      const baselineId = randomUUID();
      const runId = randomUUID();
      const snapshotRevisionId = randomUUID();
      const now = clock().toISOString();
      options.confirmationFailure?.("before-baseline");
      database
        .prepare(
          `INSERT INTO product_baselines(
             id, project_id, source_proposal_revision_id, source_proposal_hash,
             content_json, canonical_hash, confirmed_by_type, confirmed_by_id,
             confirmed_by_authenticated_by, confirmation_command_id, run_id,
             snapshot_revision_id, confirmed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          baselineId,
          input.projectId,
          input.proposalRevisionId,
          input.proposalHash,
          canonicalJson(content),
          input.proposalHash,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
          input.commandId,
          runId,
          snapshotRevisionId,
          now,
        );
      options.pipelineRuntime.formalizeRunInTransaction({
        runId,
        snapshotRevisionId,
        projectId: input.projectId,
        departmentId: input.departmentId,
        productBaseline: {
          id: baselineId,
          sourceProposalRevisionId: input.proposalRevisionId,
          hash: input.proposalHash,
        },
        agentOverrideId: input.agentOverrideId,
        parentRunId: input.forkSourceRunId,
        forkedFromSnapshotRevisionId: input.forkSourceSnapshotRevisionId,
        checkpoint: options.confirmationFailure,
      });
      database
        .prepare(
          `UPDATE product_proposals
              SET status = 'confirmed', updated_at = ?
            WHERE id = ?`,
        )
        .run(now, current.id);
      options.confirmationFailure?.("before-audit");
      appendAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "product.baseline.confirmed",
        proposalId: baselineId,
        entityType: "product-baseline",
        before: { proposalRevisionId: input.proposalRevisionId },
        after: {
          baselineId,
          runId,
          snapshotRevisionId,
          agentOverrideId: input.agentOverrideId ?? null,
        },
        createdAt: now,
      });
      appendAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "department-run.formalized",
        proposalId: runId,
        entityType: "department-run",
        runId,
        before: null,
        after: {
          status: "ready",
          baselineId,
          snapshotRevisionId,
          agentOverrideId: input.agentOverrideId ?? null,
        },
        createdAt: now,
      });
      options.confirmationFailure?.("before-outbox");
      options.events.append({
        type: "product.baseline.confirmed",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          productBaselineId: baselineId,
          snapshotRevisionId,
          commandId: input.commandId,
        },
        payload: {
          productBaselineId: baselineId,
          sourceProposalRevisionId: input.proposalRevisionId,
          sourceProposalHash: input.proposalHash,
          runId,
          snapshotRevisionId,
          confirmedBy: input.actor,
          agentOverrideId: input.agentOverrideId ?? null,
          ...(input.forkSourceRunId
            ? {
                parentRunId: input.forkSourceRunId,
                forkedFromSnapshotRevisionId:
                  input.forkSourceSnapshotRevisionId,
              }
            : {}),
        },
        timestamp: now,
      });
      options.events.append({
        type: "department-run.formalized",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          departmentId: input.departmentId,
          productBaselineId: baselineId,
          runId,
          snapshotRevisionId,
          commandId: input.commandId,
        },
        payload: {
          runId,
          productBaselineId: baselineId,
          snapshotRevisionId,
          status: "ready",
          agentOverrideId: input.agentOverrideId ?? null,
          ...(input.forkSourceRunId
            ? {
                parentRunId: input.forkSourceRunId,
                forkedFromSnapshotRevisionId:
                  input.forkSourceSnapshotRevisionId,
              }
            : {}),
        },
        timestamp: now,
      });
      return inspect(input.projectId);
    };

  const forkDepartmentRunInTransaction: ProductRuntime["forkDepartmentRunInTransaction"] =
    (input) => {
      if (
        input.actor.type !== "human" ||
        input.actor.authenticatedBy !== "local-session"
      ) {
        throw new ProductRuntimeError(
          "FORK_ACTOR_INVALID",
          "Department Run fork requires a verified human actor.",
        );
      }
      const source = options.pipelineRuntime.inspectRun(input.sourceRunId);
      if (source.run.revision !== input.expectedRevision) {
        throw new ProductRuntimeError(
          "VERSION_CONFLICT",
          `Department Run revision ${input.expectedRevision} does not match current revision ${source.run.revision}.`,
        );
      }
      if (!source.run.productBaselineId) {
        throw new ProductRuntimeError(
          "PRODUCT_BASELINE_NOT_FOUND",
          `Department Run ${input.sourceRunId} has no Product Baseline.`,
        );
      }
      const runId = randomUUID();
      const snapshotRevisionId = randomUUID();
      const now = clock().toISOString();
      const child = options.pipelineRuntime.replayForkInTransaction({
        runId,
        snapshotRevisionId,
        sourceRunId: input.sourceRunId,
        sourceSnapshotRevisionId: input.sourceSnapshotRevisionId,
        productBaselineId: source.run.productBaselineId,
      });
      appendAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "department-run.formalized",
        proposalId: runId,
        entityType: "department-run",
        runId,
        before: {
          sourceRunId: input.sourceRunId,
          sourceSnapshotRevisionId: input.sourceSnapshotRevisionId,
        },
        after: {
          status: "ready",
          productBaselineId: source.run.productBaselineId,
          snapshotRevisionId,
          reason: input.reason,
        },
        createdAt: now,
      });
      options.events.append({
        type: "department-run.formalized",
        scope: {
          companyId: "company",
          projectId: child.run.projectId,
          departmentId: child.run.departmentId,
          productBaselineId: source.run.productBaselineId,
          runId,
          snapshotRevisionId,
          commandId: input.commandId,
        },
        payload: {
          runId,
          productBaselineId: source.run.productBaselineId,
          snapshotRevisionId,
          status: "ready",
          parentRunId: input.sourceRunId,
          forkedFromSnapshotRevisionId: input.sourceSnapshotRevisionId,
        },
        timestamp: now,
      });
      return inspect(child.run.projectId);
    };

  return {
    inspect,
    reviseProposalInTransaction,
    markAwaitingConfirmationInTransaction,
    confirmProductBaselineInTransaction,
    forkDepartmentRunInTransaction,
  };
};
