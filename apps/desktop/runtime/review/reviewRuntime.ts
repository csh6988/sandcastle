import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ReviewInputManifestSchema,
  ReviewTopicViewSchema,
  type ActorRef,
  type ReviewInputManifest,
  type ReviewEnvelopeCommand,
  type ReviewParticipantInput,
  type ReviewTopicView,
} from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";

export class ReviewRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewRuntimeError";
  }
}

export type ReviewMutationFailurePoint = "after-topic-mutation";

export interface ReviewRuntime {
  readonly inspect: (topicId: string) => ReviewTopicView;
  readonly list: (input: {
    readonly projectId?: string;
    readonly runId?: string;
  }) => readonly ReviewTopicView[];
  readonly dispatchInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: ReviewEnvelopeCommand;
  }) => ReviewTopicView;
  readonly transitionIndependentExecutionInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly topicId: string;
    readonly state: "blocked" | "active";
  }) => ReviewTopicView;
  readonly recordAggregateExecutionInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly topicId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly manifest: Extract<
      ReviewInputManifest,
      { readonly scope: "aggregate" }
    >;
    readonly producer: {
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
    };
    readonly reviewer: {
      readonly participantId: string;
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
    };
    readonly terminalExecutionFactId: string;
    readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
    readonly conditions: readonly string[];
    readonly evidenceRefs: readonly string[];
  }) => ReviewTopicView;
}

type EligibilityReason =
  | "role-excluded"
  | "producer-ai-member"
  | "producer-position"
  | "producer-session"
  | "session-not-independent"
  | "session-not-found"
  | "session-project-mismatch"
  | "position-member-mismatch";

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
    throw new ReviewRuntimeError(
      "REVIEW_DATA_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

const ensureOneRole = (
  participants: readonly ReviewParticipantInput[],
  role: "owner-participant" | "moderator",
): void => {
  if (
    participants.filter((participant) => participant.role === role).length !== 1
  ) {
    throw new ReviewRuntimeError(
      "REVIEW_PARTICIPANT_ROLES_INVALID",
      `Review Topic requires exactly one ${role}.`,
    );
  }
};

export const openReviewRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
    readonly mutationFailure?: (point: ReviewMutationFailurePoint) => void;
  },
): ReviewRuntime => {
  const clock = options.clock ?? (() => new Date());

  const appendMutation = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly topicId: string;
    readonly projectId: string;
    readonly runId?: string | null;
    readonly eventType: string;
    readonly payload: unknown;
    readonly createdAt: string;
    readonly reviewFindingId?: string;
    readonly qualityGateResultId?: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.entityType,
        input.entityId,
        input.runId ?? null,
        canonicalJson(input.payload),
        input.createdAt,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    options.events.append({
      type: input.eventType,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        ...(input.runId ? { runId: input.runId } : {}),
        topicId: input.topicId,
        ...(input.reviewFindingId
          ? { reviewFindingId: input.reviewFindingId }
          : {}),
        ...(input.qualityGateResultId
          ? { qualityGateResultId: input.qualityGateResultId }
          : {}),
        commandId: input.commandId,
      },
      payload: input.payload,
      timestamp: input.createdAt,
    });
  };

  const inspect = (topicId: string): ReviewTopicView => {
    const topic = database
      .prepare(
        `SELECT id, project_id AS projectId, run_id AS runId, title, kind,
                status, revision, manifest_json AS manifestJson,
                manifest_hash AS manifestHash,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId, quorum,
                budget_json AS budgetJson, rounds_used AS roundsUsed,
                duration_seconds_used AS durationSecondsUsed,
                tokens_used AS tokensUsed, cost_cents_used AS costCentsUsed,
                stop_condition AS stopCondition,
                escalation_policy AS escalationPolicy,
                created_at AS createdAt, updated_at AS updatedAt
           FROM review_topics WHERE id = ?`,
      )
      .get(topicId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly runId: string | null;
          readonly title: string;
          readonly kind: string;
          readonly status: string;
          readonly revision: number;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly producerAiMemberId: string;
          readonly producerPositionId: string;
          readonly producerSessionId: string;
          readonly quorum: number;
          readonly budgetJson: string;
          readonly roundsUsed: number;
          readonly durationSecondsUsed: number;
          readonly tokensUsed: number;
          readonly costCentsUsed: number;
          readonly stopCondition: string;
          readonly escalationPolicy: string;
          readonly createdAt: string;
          readonly updatedAt: string;
        }
      | undefined;
    if (!topic) {
      throw new ReviewRuntimeError(
        "REVIEW_TOPIC_NOT_FOUND",
        `Review Topic ${topicId} was not found.`,
      );
    }

    const participants = database
      .prepare(
        `SELECT id, role, ai_member_id AS aiMemberId,
                position_id AS positionId, session_id AS sessionId,
                eligible, eligibility_reasons_json AS reasonsJson,
                eligibility_snapshot_hash AS snapshotHash
           FROM review_participants
          WHERE topic_id = ? ORDER BY rowid`,
      )
      .all(topicId)
      .map((row) => {
        const participant = row as {
          readonly id: string;
          readonly role: string;
          readonly aiMemberId: string;
          readonly positionId: string;
          readonly sessionId: string;
          readonly eligible: number;
          readonly reasonsJson: string;
          readonly snapshotHash: string;
        };
        return {
          id: participant.id,
          role: participant.role,
          aiMemberId: participant.aiMemberId,
          positionId: participant.positionId,
          sessionId: participant.sessionId,
          eligibility: {
            eligible: participant.eligible === 1,
            reasons: parseJson(
              participant.reasonsJson,
              `Review participant ${participant.id} eligibility reasons`,
            ),
            snapshotHash: participant.snapshotHash,
          },
        };
      });
    const findings = database
      .prepare(
        `SELECT id, topic_id AS topicId,
                reviewer_participant_id AS reviewerParticipantId,
                reviewer_session_id AS reviewerSessionId, severity, summary,
                rationale, impact, evidence_refs_json AS evidenceRefsJson,
                suggested_owner AS suggestedOwner, blocking,
                scope_impact AS scopeImpact,
                created_at AS createdAt
           FROM review_findings
          WHERE topic_id = ? ORDER BY created_at, id`,
      )
      .all(topicId)
      .map((row) => {
        const finding = row as Record<string, unknown>;
        return {
          ...finding,
          blocking: finding.blocking === 1,
          evidenceRefs: parseJson(
            String(finding.evidenceRefsJson),
            `Review Finding ${String(finding.id)} evidence`,
          ),
          evidenceRefsJson: undefined,
        };
      });
    const resolutions = database
      .prepare(
        `SELECT id, topic_id AS topicId, finding_id AS findingId,
                participant_id AS participantId, disposition, response,
                evidence_refs_json AS evidenceRefsJson,
                revised_subject_id AS revisedSubjectId,
                revised_subject_hash AS revisedSubjectHash,
                created_at AS createdAt
           FROM review_resolutions
          WHERE topic_id = ? ORDER BY created_at, id`,
      )
      .all(topicId)
      .map((row) => {
        const resolution = row as Record<string, unknown>;
        return {
          ...resolution,
          evidenceRefs: parseJson(
            String(resolution.evidenceRefsJson),
            `Review resolution ${String(resolution.id)} evidence`,
          ),
          evidenceRefsJson: undefined,
        };
      });
    const discussions = database
      .prepare(
        `SELECT id, topic_id AS topicId, round, status,
                conflict_finding_ids_json AS conflictFindingIdsJson,
                bounded_prompt AS boundedPrompt, tokens_used AS tokensUsed,
                cost_cents_used AS costCentsUsed,
                duration_seconds AS durationSeconds, stop_reason AS stopReason,
                opened_at AS openedAt, closed_at AS closedAt
           FROM review_discussions
          WHERE topic_id = ? ORDER BY round, id`,
      )
      .all(topicId)
      .map((row) => {
        const discussion = row as Record<string, unknown>;
        return {
          ...discussion,
          conflictFindingIds: parseJson(
            String(discussion.conflictFindingIdsJson),
            `Review discussion ${String(discussion.id)} conflict set`,
          ),
          conflictFindingIdsJson: undefined,
        };
      });
    const revisions = database
      .prepare(
        `SELECT id, topic_id AS topicId, subject_kind AS subjectKind,
                subject_id AS subjectId, subject_hash AS subjectHash,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId,
                evidence_refs_json AS evidenceRefsJson,
                created_at AS createdAt
           FROM review_revisions
          WHERE topic_id = ? ORDER BY created_at, id`,
      )
      .all(topicId)
      .map((row) => {
        const revision = row as Record<string, unknown>;
        return {
          ...revision,
          evidenceRefs: parseJson(
            String(revision.evidenceRefsJson),
            `Review revision ${String(revision.id)} evidence`,
          ),
          evidenceRefsJson: undefined,
        };
      });
    const rechecks = database
      .prepare(
        `SELECT id, topic_id AS topicId, revision_id AS revisionId,
                reviewer_participant_id AS reviewerParticipantId,
                reviewer_session_id AS reviewerSessionId, result,
                conditions_json AS conditionsJson,
                evidence_refs_json AS evidenceRefsJson,
                eligibility_snapshot_hash AS eligibilitySnapshotHash,
                created_at AS createdAt
           FROM review_rechecks
          WHERE topic_id = ? ORDER BY created_at, id`,
      )
      .all(topicId)
      .map((row) => {
        const recheck = row as Record<string, unknown>;
        return {
          ...recheck,
          conditions: parseJson(
            String(recheck.conditionsJson),
            `Review recheck ${String(recheck.id)} conditions`,
          ),
          evidenceRefs: parseJson(
            String(recheck.evidenceRefsJson),
            `Review recheck ${String(recheck.id)} evidence`,
          ),
          conditionsJson: undefined,
          evidenceRefsJson: undefined,
        };
      });
    const gate = database
      .prepare(
        `SELECT id, topic_id AS topicId, kind, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, revision_id AS revisionId,
                result, conditions_json AS conditionsJson,
                recheck_ids_json AS recheckIdsJson,
                evidence_refs_json AS evidenceRefsJson,
                created_at AS createdAt
           FROM quality_gate_results WHERE topic_id = ?`,
      )
      .get(topicId) as Record<string, unknown> | undefined;

    return ReviewTopicViewSchema.parse({
      topic: {
        id: topic.id,
        projectId: topic.projectId,
        title: topic.title,
        kind: topic.kind,
        status: topic.status,
        revision: Number(topic.revision),
        manifest: ReviewInputManifestSchema.parse(
          parseJson(topic.manifestJson, `Review Topic ${topic.id} manifest`),
        ),
        manifestHash: topic.manifestHash,
        producer: {
          aiMemberId: topic.producerAiMemberId,
          positionId: topic.producerPositionId,
          sessionId: topic.producerSessionId,
        },
        quorum: Number(topic.quorum),
        budget: parseJson(topic.budgetJson, `Review Topic ${topic.id} budget`),
        budgetUsed: {
          rounds: Number(topic.roundsUsed),
          durationSeconds: Number(topic.durationSecondsUsed),
          tokens: Number(topic.tokensUsed),
          costCents: Number(topic.costCentsUsed),
        },
        stopCondition: topic.stopCondition,
        escalationPolicy: topic.escalationPolicy,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      },
      participants,
      findings,
      resolutions,
      discussions,
      revisions,
      rechecks,
      gateResult: gate
        ? {
            id: gate.id,
            topicId: gate.topicId,
            kind: gate.kind,
            manifest: parseJson(
              String(gate.manifestJson),
              `Quality Gate Result ${String(gate.id)} manifest`,
            ),
            manifestHash: gate.manifestHash,
            revisionId: gate.revisionId,
            result: gate.result,
            satisfiesProductionContract: gate.result === "PASS",
            conditions: parseJson(
              String(gate.conditionsJson),
              `Quality Gate Result ${String(gate.id)} conditions`,
            ),
            recheckIds: parseJson(
              String(gate.recheckIdsJson),
              `Quality Gate Result ${String(gate.id)} rechecks`,
            ),
            evidenceRefs: parseJson(
              String(gate.evidenceRefsJson),
              `Quality Gate Result ${String(gate.id)} evidence`,
            ),
            createdAt: gate.createdAt,
          }
        : null,
    });
  };

  const list: ReviewRuntime["list"] = (input) => {
    const filters: string[] = [];
    const parameters: string[] = [];
    if (input.projectId) {
      filters.push("project_id = ?");
      parameters.push(input.projectId);
    }
    if (input.runId) {
      filters.push("run_id = ?");
      parameters.push(input.runId);
    }
    const rows = database
      .prepare(
        `SELECT id FROM review_topics
         ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
         ORDER BY created_at, id`,
      )
      .all(...parameters) as Array<{ readonly id: string }>;
    return rows.map((row) => inspect(row.id));
  };

  const ensureTopicRevision = (
    topicId: string,
    expectedRevision: number | undefined,
  ): { readonly projectId: string; readonly runId: string | null } => {
    const topic = database
      .prepare(
        "SELECT project_id AS projectId, run_id AS runId, revision FROM review_topics WHERE id = ?",
      )
      .get(topicId) as
      | {
          readonly projectId: string;
          readonly runId: string | null;
          readonly revision: number;
        }
      | undefined;
    if (!topic) {
      throw new ReviewRuntimeError(
        "REVIEW_TOPIC_NOT_FOUND",
        `Review Topic ${topicId} was not found.`,
      );
    }
    if (expectedRevision === undefined) {
      throw new ReviewRuntimeError(
        "EXPECTED_REVISION_REQUIRED",
        "Review Commands require expectedRevision.",
      );
    }
    if (Number(topic.revision) !== expectedRevision) {
      throw new ReviewRuntimeError(
        "REVISION_CONFLICT",
        `Review Topic ${topicId} is at revision ${topic.revision}, not ${expectedRevision}.`,
      );
    }
    return topic;
  };

  const createTopic = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.topic.create" }
    >;
  }): ReviewTopicView => {
    if (input.expectedRevision !== 0) {
      throw new ReviewRuntimeError(
        "REVISION_CONFLICT",
        "A new Review Topic requires expectedRevision 0.",
      );
    }
    const command = input.command;
    if (command.manifest.topicId !== command.topicId) {
      throw new ReviewRuntimeError(
        "REVIEW_MANIFEST_TOPIC_MISMATCH",
        "Review input manifest topicId must match the Review Topic ID.",
      );
    }
    if (
      database
        .prepare("SELECT 1 FROM review_topics WHERE id = ?")
        .get(command.topicId)
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_TOPIC_EXISTS",
        `Review Topic ${command.topicId} already exists.`,
      );
    }
    if (
      !database
        .prepare("SELECT 1 FROM projects WHERE id = ?")
        .get(command.projectId)
    ) {
      throw new ReviewRuntimeError(
        "PROJECT_NOT_FOUND",
        `Project ${command.projectId} was not found.`,
      );
    }
    ensureOneRole(command.participants, "owner-participant");
    ensureOneRole(command.participants, "moderator");
    if (
      command.participants.filter(
        (participant) => participant.role === "reviewer-participant",
      ).length === 0
    ) {
      throw new ReviewRuntimeError(
        "REVIEWER_REQUIRED",
        "Review Topic requires at least one reviewer-participant.",
      );
    }
    const ids = new Set<string>();
    for (const participant of command.participants) {
      if (ids.has(participant.id)) {
        throw new ReviewRuntimeError(
          "REVIEW_PARTICIPANT_DUPLICATE",
          `Review participant ${participant.id} is duplicated.`,
        );
      }
      ids.add(participant.id);
    }

    const now = clock().toISOString();
    const participantSnapshots = command.participants.map((participant) => {
      const reasons: EligibilityReason[] = [];
      if (participant.role !== "reviewer-participant") {
        reasons.push("role-excluded");
      } else {
        if (participant.aiMemberId === command.producer.aiMemberId) {
          reasons.push("producer-ai-member");
        }
        if (participant.positionId === command.producer.positionId) {
          reasons.push("producer-position");
        }
        if (participant.sessionId === command.producer.sessionId) {
          reasons.push("producer-session");
        }
      }
      const position = database
        .prepare(
          "SELECT ai_member_id AS aiMemberId FROM positions WHERE id = ?",
        )
        .get(participant.positionId) as
        | { readonly aiMemberId: string }
        | undefined;
      if (!position || position.aiMemberId !== participant.aiMemberId) {
        reasons.push("position-member-mismatch");
      }
      const session = database
        .prepare(
          `SELECT project_id AS projectId
             FROM interaction_sessions WHERE id = ?`,
        )
        .get(participant.sessionId) as
        | { readonly projectId: string }
        | undefined;
      if (!session) {
        reasons.push("session-not-found");
      } else {
        if (session.projectId !== command.projectId) {
          reasons.push("session-project-mismatch");
        }
        const sessionParticipant = database
          .prepare(
            `SELECT 1 FROM session_participants
              WHERE session_id = ? AND participant_type = 'ai-member'
                AND participant_ref = ?`,
          )
          .get(participant.sessionId, participant.aiMemberId);
        if (!sessionParticipant) reasons.push("session-not-independent");
      }
      const uniqueReasons = [...new Set(reasons)];
      const snapshot = {
        topicId: command.topicId,
        participantId: participant.id,
        role: participant.role,
        aiMemberId: participant.aiMemberId,
        positionId: participant.positionId,
        sessionId: participant.sessionId,
        producer: command.producer,
        projectId: command.projectId,
        eligible: uniqueReasons.length === 0,
        reasons: uniqueReasons,
      };
      return {
        participant,
        eligible: uniqueReasons.length === 0,
        reasons: uniqueReasons,
        snapshot,
        snapshotHash: sha256(canonicalJson(snapshot)),
      };
    });
    const eligibleCount = participantSnapshots.filter(
      (entry) => entry.eligible,
    ).length;
    const quorum = command.quorum ?? Math.max(1, eligibleCount);
    const status = eligibleCount >= quorum ? "independent-review" : "blocked";
    const manifestJson = canonicalJson(command.manifest);
    database
      .prepare(
        `INSERT INTO review_topics(
           id, project_id, run_id, title, kind, status, revision,
           manifest_json, manifest_hash, producer_ai_member_id,
           producer_position_id, producer_session_id, quorum, budget_json,
           stop_condition, escalation_policy, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.topicId,
        command.projectId,
        command.runId ?? null,
        command.title,
        command.manifest.scope,
        status,
        manifestJson,
        sha256(manifestJson),
        command.producer.aiMemberId,
        command.producer.positionId,
        command.producer.sessionId,
        quorum,
        canonicalJson(command.budget),
        command.stopCondition,
        command.escalationPolicy,
        now,
        now,
      );
    const insertParticipant = database.prepare(
      `INSERT INTO review_participants(
         id, topic_id, role, ai_member_id, position_id, session_id, eligible,
         eligibility_reasons_json, eligibility_snapshot_json,
         eligibility_snapshot_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of participantSnapshots) {
      insertParticipant.run(
        entry.participant.id,
        command.topicId,
        entry.participant.role,
        entry.participant.aiMemberId,
        entry.participant.positionId,
        entry.participant.sessionId,
        entry.eligible ? 1 : 0,
        canonicalJson(entry.reasons),
        canonicalJson(entry.snapshot),
        entry.snapshotHash,
        now,
      );
    }
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.topic.created",
      entityType: "review-topic",
      entityId: command.topicId,
      topicId: command.topicId,
      projectId: command.projectId,
      runId: command.runId,
      eventType: "review.scheduled",
      payload: {
        topicId: command.topicId,
        kind: command.manifest.scope,
        status,
        revision: 1,
        manifestHash: sha256(manifestJson),
        eligibleReviewerCount: eligibleCount,
        quorum,
      },
      createdAt: now,
    });
    options.mutationFailure?.("after-topic-mutation");
    return inspect(command.topicId);
  };

  const recordAggregateExecutionInTransaction: ReviewRuntime["recordAggregateExecutionInTransaction"] =
    (input) => {
      const manifest = ReviewInputManifestSchema.parse(input.manifest);
      if (
        manifest.scope !== "aggregate" ||
        manifest.topicId !== input.topicId
      ) {
        throw new ReviewRuntimeError(
          "REVIEW_MANIFEST_TOPIC_MISMATCH",
          "Aggregate Review execution must bind its exact Topic manifest.",
        );
      }
      const manifestJson = canonicalJson(manifest);
      const manifestHash = sha256(manifestJson);
      const generation = database
        .prepare(
          `SELECT project_id AS projectId, run_id AS runId,
                  node_run_id AS nodeRunId, manifest_hash AS manifestHash
             FROM integration_generations WHERE id = ?`,
        )
        .get(manifest.integrationGenerationId) as
        | {
            readonly projectId: string;
            readonly runId: string;
            readonly nodeRunId: string;
            readonly manifestHash: string;
          }
        | undefined;
      if (
        !generation ||
        generation.projectId !== input.projectId ||
        generation.runId !== input.runId ||
        generation.manifestHash !== manifest.integrationManifestHash
      ) {
        throw new ReviewRuntimeError(
          "REVIEW_AGGREGATE_EXECUTION_CONFLICT",
          "Aggregate Review execution does not bind the exact Integration Generation authority.",
        );
      }
      const producerLineage = database
        .prepare(
          `SELECT integration_operations.work_package_version_id AS workPackageVersionId,
                  work_package_assignments.ai_member_id AS aiMemberId,
                  work_package_assignments.position_id AS positionId,
                  work_package_assignments.interaction_session_id AS sessionId
             FROM integration_operations
             JOIN work_package_assignments
               ON work_package_assignments.work_package_version_id =
                  integration_operations.work_package_version_id
            WHERE integration_operations.generation_id = ?
            ORDER BY aiMemberId, positionId, sessionId, workPackageVersionId`,
        )
        .all(manifest.integrationGenerationId) as Array<{
        readonly workPackageVersionId: string;
        readonly aiMemberId: string;
        readonly positionId: string;
        readonly sessionId: string;
      }>;
      const canonicalProducer = producerLineage[0];
      if (
        !canonicalProducer ||
        canonicalProducer.aiMemberId !== input.producer.aiMemberId ||
        canonicalProducer.positionId !== input.producer.positionId ||
        canonicalProducer.sessionId !== input.producer.sessionId
      ) {
        throw new ReviewRuntimeError(
          "REVIEW_AGGREGATE_EXECUTION_CONFLICT",
          "Aggregate Review execution does not bind the canonical producer lineage.",
        );
      }
      if (
        producerLineage.some(
          (producer) =>
            producer.aiMemberId === input.reviewer.aiMemberId ||
            producer.positionId === input.reviewer.positionId ||
            producer.sessionId === input.reviewer.sessionId,
        )
      ) {
        throw new ReviewRuntimeError(
          "REVIEWER_INELIGIBLE",
          "Aggregate Review execution requires a Reviewer independent from every Integration producer.",
        );
      }
      const reviewerAuthority = database
        .prepare(
          `SELECT interaction_sessions.project_id AS projectId,
                  interaction_sessions.run_id AS runId,
                  interaction_sessions.node_run_id AS nodeRunId,
                  interaction_sessions.mode,
                  interaction_sessions.status,
                  session_participants.participant_ref AS aiMemberId,
                  session_participants.role,
                  positions.ai_member_id AS positionAiMemberId
             FROM interaction_sessions
             JOIN session_participants
               ON session_participants.session_id = interaction_sessions.id
              AND session_participants.id = ?
              AND session_participants.participant_type = 'ai-member'
             JOIN positions ON positions.id = ?
            WHERE interaction_sessions.id = ?`,
        )
        .get(
          input.reviewer.participantId,
          input.reviewer.positionId,
          input.reviewer.sessionId,
        ) as
        | {
            readonly projectId: string;
            readonly runId: string | null;
            readonly nodeRunId: string | null;
            readonly mode: string;
            readonly status: string;
            readonly aiMemberId: string;
            readonly role: string;
            readonly positionAiMemberId: string;
          }
        | undefined;
      if (
        !reviewerAuthority ||
        reviewerAuthority.projectId !== input.projectId ||
        reviewerAuthority.runId !== input.runId ||
        reviewerAuthority.nodeRunId !== generation.nodeRunId ||
        reviewerAuthority.mode !== "run-collaboration" ||
        reviewerAuthority.status !== "active" ||
        reviewerAuthority.aiMemberId !== input.reviewer.aiMemberId ||
        reviewerAuthority.positionAiMemberId !== input.reviewer.aiMemberId ||
        reviewerAuthority.role !==
          `aggregate-reviewer:${manifest.integrationGenerationId}`
      ) {
        throw new ReviewRuntimeError(
          "REVIEWER_SESSION_INVALID",
          "Aggregate Review execution requires an exact fresh Reviewer identity and Session.",
        );
      }
      const existing = database
        .prepare(
          `SELECT review_topics.project_id AS projectId,
                  review_topics.run_id AS runId,
                  review_topics.manifest_json AS manifestJson,
                  review_topics.manifest_hash AS manifestHash,
                  review_topics.producer_ai_member_id AS producerAiMemberId,
                  review_topics.producer_position_id AS producerPositionId,
                  review_topics.producer_session_id AS producerSessionId,
                  review_participants.id AS reviewerParticipantId,
                  review_participants.ai_member_id AS reviewerAiMemberId,
                  review_participants.position_id AS reviewerPositionId,
                  review_participants.session_id AS reviewerSessionId,
                  quality_gate_results.id AS gateId,
                  quality_gate_results.result AS result,
                  quality_gate_results.conditions_json AS conditionsJson,
                  quality_gate_results.evidence_refs_json AS evidenceRefsJson
             FROM review_topics
             LEFT JOIN review_participants
               ON review_participants.topic_id = review_topics.id
              AND review_participants.role = 'reviewer-participant'
             LEFT JOIN quality_gate_results
               ON quality_gate_results.topic_id = review_topics.id
              AND quality_gate_results.kind = 'aggregate'
            WHERE review_topics.id = ?`,
        )
        .get(input.topicId) as
        | {
            readonly projectId: string;
            readonly runId: string;
            readonly manifestJson: string;
            readonly manifestHash: string;
            readonly producerAiMemberId: string;
            readonly producerPositionId: string;
            readonly producerSessionId: string;
            readonly reviewerParticipantId: string | null;
            readonly reviewerAiMemberId: string | null;
            readonly reviewerPositionId: string | null;
            readonly reviewerSessionId: string | null;
            readonly gateId: string | null;
            readonly result: string | null;
            readonly conditionsJson: string | null;
            readonly evidenceRefsJson: string | null;
          }
        | undefined;
      if (existing) {
        if (
          existing.projectId !== input.projectId ||
          existing.runId !== input.runId ||
          existing.manifestJson !== manifestJson ||
          existing.manifestHash !== manifestHash ||
          existing.producerAiMemberId !== input.producer.aiMemberId ||
          existing.producerPositionId !== input.producer.positionId ||
          existing.producerSessionId !== input.producer.sessionId ||
          existing.reviewerParticipantId !== input.reviewer.participantId ||
          existing.reviewerAiMemberId !== input.reviewer.aiMemberId ||
          existing.reviewerPositionId !== input.reviewer.positionId ||
          existing.reviewerSessionId !== input.reviewer.sessionId ||
          existing.gateId !== `quality-gate-${input.topicId}` ||
          existing.result !== input.result ||
          existing.conditionsJson !== canonicalJson(input.conditions) ||
          existing.evidenceRefsJson !== canonicalJson(input.evidenceRefs) ||
          !input.evidenceRefs.includes(
            `execution-fact:${input.terminalExecutionFactId}`,
          )
        ) {
          throw new ReviewRuntimeError(
            "REVIEW_AGGREGATE_EXECUTION_CONFLICT",
            `Aggregate Review Topic ${input.topicId} already binds different execution authority.`,
          );
        }
        return inspect(input.topicId);
      }
      const now = clock().toISOString();
      database
        .prepare(
          `INSERT INTO review_topics(
             id, project_id, run_id, title, kind, status, revision,
             manifest_json, manifest_hash, producer_ai_member_id,
             producer_position_id, producer_session_id, quorum, budget_json,
             stop_condition, escalation_policy, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'aggregate', ?, 1, ?, ?, ?, ?, ?, 1, ?,
                     'blocking-findings-dispositioned', 'fail-with-evidence', ?, ?)`,
        )
        .run(
          input.topicId,
          input.projectId,
          input.runId,
          `Aggregate Integration Review ${manifest.integrationGenerationId}`,
          input.result,
          manifestJson,
          manifestHash,
          input.producer.aiMemberId,
          input.producer.positionId,
          input.producer.sessionId,
          canonicalJson({
            maxRounds: 1,
            maxDurationSeconds: 3600,
            maxTokens: 0,
            maxCostCents: 0,
          }),
          now,
          now,
        );
      const eligibility = {
        topicId: input.topicId,
        participantId: input.reviewer.participantId,
        role: "reviewer-participant",
        aiMemberId: input.reviewer.aiMemberId,
        positionId: input.reviewer.positionId,
        reviewerSessionId: input.reviewer.sessionId,
        integrationGenerationId: manifest.integrationGenerationId,
        integrationManifestHash: manifest.integrationManifestHash,
        producerLineage,
        eligible: true,
        reasons: [],
      };
      database
        .prepare(
          `INSERT INTO review_participants(
             id, topic_id, role, ai_member_id, position_id, session_id,
             eligible, eligibility_reasons_json, eligibility_snapshot_json,
             eligibility_snapshot_hash, created_at
           ) VALUES (?, ?, 'reviewer-participant', ?, ?, ?, 1, '[]', ?, ?, ?)`,
        )
        .run(
          input.reviewer.participantId,
          input.topicId,
          input.reviewer.aiMemberId,
          input.reviewer.positionId,
          input.reviewer.sessionId,
          canonicalJson(eligibility),
          sha256(canonicalJson(eligibility)),
          now,
        );
      const gateId = `quality-gate-${input.topicId}`;
      database
        .prepare(
          `INSERT INTO quality_gate_results(
             id, topic_id, kind, manifest_json, manifest_hash, revision_id,
             result, conditions_json, recheck_ids_json, evidence_refs_json,
             created_at
           ) VALUES (?, ?, 'aggregate', ?, ?, NULL, ?, ?, '[]', ?, ?)`,
        )
        .run(
          gateId,
          input.topicId,
          manifestJson,
          manifestHash,
          input.result,
          canonicalJson(input.conditions),
          canonicalJson(input.evidenceRefs),
          now,
        );
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "review.aggregate-execution.recorded",
        entityType: "review-topic",
        entityId: input.topicId,
        topicId: input.topicId,
        projectId: input.projectId,
        runId: input.runId,
        eventType: "review.scheduled",
        payload: {
          topicId: input.topicId,
          kind: "aggregate",
          status: input.result,
          revision: 1,
          manifestHash,
          eligibleReviewerCount: 1,
          quorum: 1,
        },
        createdAt: now,
      });
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "quality-gate.completed",
        entityType: "quality-gate-result",
        entityId: gateId,
        topicId: input.topicId,
        projectId: input.projectId,
        runId: input.runId,
        eventType: "quality-gate.completed",
        qualityGateResultId: gateId,
        payload: {
          topicId: input.topicId,
          qualityGateResultId: gateId,
          result: input.result,
          manifestHash,
          revisionId: null,
        },
        createdAt: now,
      });
      return inspect(input.topicId);
    };

  const topicRow = (topicId: string) => {
    const topic = database
      .prepare(
        `SELECT id, project_id AS projectId, run_id AS runId, status,
                revision, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, kind, quorum,
                budget_json AS budgetJson, rounds_used AS roundsUsed,
                duration_seconds_used AS durationSecondsUsed,
                tokens_used AS tokensUsed, cost_cents_used AS costCentsUsed,
                producer_session_id AS producerSessionId
           FROM review_topics WHERE id = ?`,
      )
      .get(topicId) as
      | {
          readonly id: string;
          readonly projectId: string;
          readonly runId: string | null;
          readonly status: string;
          readonly revision: number;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly kind: string;
          readonly quorum: number;
          readonly budgetJson: string;
          readonly roundsUsed: number;
          readonly durationSecondsUsed: number;
          readonly tokensUsed: number;
          readonly costCentsUsed: number;
          readonly producerSessionId: string;
        }
      | undefined;
    if (!topic) {
      throw new ReviewRuntimeError(
        "REVIEW_TOPIC_NOT_FOUND",
        `Review Topic ${topicId} was not found.`,
      );
    }
    return topic;
  };

  const participantRow = (topicId: string, participantId: string) => {
    const participant = database
      .prepare(
        `SELECT id, role, ai_member_id AS aiMemberId,
                position_id AS positionId, session_id AS sessionId, eligible
           FROM review_participants
          WHERE topic_id = ? AND id = ?`,
      )
      .get(topicId, participantId) as
      | {
          readonly id: string;
          readonly role:
            | "owner-participant"
            | "reviewer-participant"
            | "moderator";
          readonly aiMemberId: string;
          readonly positionId: string;
          readonly sessionId: string;
          readonly eligible: number;
        }
      | undefined;
    if (!participant) {
      throw new ReviewRuntimeError(
        "REVIEW_PARTICIPANT_NOT_FOUND",
        `Review participant ${participantId} was not found in Topic ${topicId}.`,
      );
    }
    return participant;
  };

  const requireStatus = (
    topic: ReturnType<typeof topicRow>,
    allowed: readonly string[],
  ): void => {
    if (!allowed.includes(topic.status)) {
      throw new ReviewRuntimeError(
        "REVIEW_STATE_INVALID",
        `Review Topic ${topic.id} is ${topic.status}; expected ${allowed.join(" or ")}.`,
      );
    }
  };

  const requireParticipantActor = (
    actor: ActorRef,
    participant: ReturnType<typeof participantRow>,
  ): void => {
    if (actor.type === "test-driver") return;
    if (
      actor.type === "runtime-worker" &&
      (actor.id === participant.aiMemberId ||
        actor.id === participant.sessionId)
    ) {
      return;
    }
    throw new ReviewRuntimeError(
      "REVIEW_ACTOR_MISMATCH",
      `Actor ${actor.type}:${actor.id} cannot act as Review participant ${participant.id}.`,
    );
  };

  const updateTopic = (input: {
    readonly topicId: string;
    readonly status?: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
    readonly roundsUsed?: number;
    readonly durationSecondsUsed?: number;
    readonly tokensUsed?: number;
    readonly costCentsUsed?: number;
  }): void => {
    const result = database
      .prepare(
        `UPDATE review_topics
            SET status = COALESCE(?, status), revision = revision + 1,
                rounds_used = COALESCE(?, rounds_used),
                duration_seconds_used = COALESCE(?, duration_seconds_used),
                tokens_used = COALESCE(?, tokens_used),
                cost_cents_used = COALESCE(?, cost_cents_used),
                updated_at = ?
          WHERE id = ? AND revision = ?`,
      )
      .run(
        input.status ?? null,
        input.roundsUsed ?? null,
        input.durationSecondsUsed ?? null,
        input.tokensUsed ?? null,
        input.costCentsUsed ?? null,
        input.updatedAt,
        input.topicId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new ReviewRuntimeError(
        "REVISION_CONFLICT",
        `Review Topic ${input.topicId} changed concurrently.`,
      );
    }
  };

  const ensureSessionForReviewer = (input: {
    readonly projectId: string;
    readonly participant: ReturnType<typeof participantRow>;
    readonly sessionId: string;
  }): void => {
    const session = database
      .prepare(
        `SELECT project_id AS projectId, status
           FROM interaction_sessions WHERE id = ?`,
      )
      .get(input.sessionId) as
      | { readonly projectId: string; readonly status: string }
      | undefined;
    const member = database
      .prepare(
        `SELECT 1 FROM session_participants
          WHERE session_id = ? AND participant_type = 'ai-member'
            AND participant_ref = ?`,
      )
      .get(input.sessionId, input.participant.aiMemberId);
    if (
      !session ||
      session.projectId !== input.projectId ||
      session.status !== "active" ||
      !member
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_SESSION_INELIGIBLE",
        `Session ${input.sessionId} is not an active independent Session for reviewer ${input.participant.id}.`,
      );
    }
  };

  const submitFinding = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.finding.submit" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["independent-review"]);
    const participant = participantRow(
      topic.id,
      input.command.reviewerParticipantId,
    );
    requireParticipantActor(input.actor, participant);
    if (
      participant.role !== "reviewer-participant" ||
      participant.eligible !== 1
    ) {
      throw new ReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        `Review participant ${participant.id} is not an eligible reviewer.`,
      );
    }
    if (input.command.reviewerSessionId !== participant.sessionId) {
      throw new ReviewRuntimeError(
        "REVIEW_SESSION_MISMATCH",
        `Independent Finding must use participant ${participant.id}'s frozen Session.`,
      );
    }
    if (
      database
        .prepare("SELECT 1 FROM review_findings WHERE id = ?")
        .get(input.command.findingId)
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_FINDING_EXISTS",
        `Review Finding ${input.command.findingId} already exists.`,
      );
    }
    if (topic.kind === "product" && input.command.scopeImpact === undefined) {
      throw new ReviewRuntimeError(
        "PRODUCT_FINDING_SCOPE_IMPACT_REQUIRED",
        "An eligible reviewer must classify every Product Finding as scope-preserving or scope-changing.",
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO review_findings(
           id, topic_id, reviewer_participant_id, reviewer_session_id,
           severity, summary, rationale, impact, evidence_refs_json,
           suggested_owner, blocking, scope_impact, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.command.findingId,
        topic.id,
        participant.id,
        input.command.reviewerSessionId,
        input.command.severity,
        input.command.summary,
        input.command.rationale,
        input.command.impact,
        canonicalJson(input.command.evidenceRefs),
        input.command.suggestedOwner,
        input.command.blocking ? 1 : 0,
        input.command.scopeImpact ?? null,
        now,
      );
    updateTopic({
      topicId: topic.id,
      expectedRevision: topic.revision,
      updatedAt: now,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.finding.created",
      entityType: "review-finding",
      entityId: input.command.findingId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.finding.created",
      reviewFindingId: input.command.findingId,
      payload: {
        topicId: topic.id,
        findingId: input.command.findingId,
        reviewerParticipantId: participant.id,
        severity: input.command.severity,
        blocking: input.command.blocking,
        scopeImpact: input.command.scopeImpact ?? null,
      },
      createdAt: now,
    });
    return inspect(topic.id);
  };

  const dispositionFinding = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.finding.disposition" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["independent-review", "discussion", "revision"]);
    const participant = participantRow(topic.id, input.command.participantId);
    requireParticipantActor(input.actor, participant);
    if (
      participant.role !== "owner-participant" &&
      participant.role !== "moderator"
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_RESPONSE_FORBIDDEN",
        "Only an owner-participant or moderator may disposition a Finding.",
      );
    }
    const finding = database
      .prepare("SELECT 1 FROM review_findings WHERE id = ? AND topic_id = ?")
      .get(input.command.findingId, topic.id);
    if (!finding) {
      throw new ReviewRuntimeError(
        "REVIEW_FINDING_NOT_FOUND",
        `Review Finding ${input.command.findingId} was not found in Topic ${topic.id}.`,
      );
    }
    if (
      input.command.disposition === "resolved" &&
      (input.command.evidenceRefs.length === 0 ||
        !input.command.revisedSubjectId ||
        !input.command.revisedSubjectHash)
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_RESOLUTION_EVIDENCE_REQUIRED",
        "A resolved Finding requires evidence and an exact revised subject ID/hash.",
      );
    }
    if (
      database
        .prepare("SELECT 1 FROM review_resolutions WHERE id = ?")
        .get(input.command.resolutionId)
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_RESOLUTION_EXISTS",
        `Review resolution ${input.command.resolutionId} already exists.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO review_resolutions(
           id, topic_id, finding_id, participant_id, disposition, response,
           evidence_refs_json, revised_subject_id, revised_subject_hash,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.command.resolutionId,
        topic.id,
        input.command.findingId,
        participant.id,
        input.command.disposition,
        input.command.response,
        canonicalJson(input.command.evidenceRefs),
        input.command.revisedSubjectId ?? null,
        input.command.revisedSubjectHash ?? null,
        now,
      );
    updateTopic({
      topicId: topic.id,
      expectedRevision: topic.revision,
      updatedAt: now,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.finding.dispositioned",
      entityType: "review-resolution",
      entityId: input.command.resolutionId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.finding.dispositioned",
      reviewFindingId: input.command.findingId,
      payload: {
        topicId: topic.id,
        findingId: input.command.findingId,
        resolutionId: input.command.resolutionId,
        disposition: input.command.disposition,
      },
      createdAt: now,
    });
    return inspect(topic.id);
  };

  const openDiscussion = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.discussion.open" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["independent-review", "revision"]);
    const moderator = participantRow(
      topic.id,
      input.command.moderatorParticipantId,
    );
    requireParticipantActor(input.actor, moderator);
    if (moderator.role !== "moderator") {
      throw new ReviewRuntimeError(
        "REVIEW_MODERATOR_REQUIRED",
        "Only the frozen moderator may open a Review discussion round.",
      );
    }
    const budget = parseJson(
      topic.budgetJson,
      `Review Topic ${topic.id} budget`,
    ) as {
      readonly maxRounds: number;
    };
    const round = topic.roundsUsed + 1;
    if (round > budget.maxRounds) {
      throw new ReviewRuntimeError(
        "REVIEW_BUDGET_EXHAUSTED",
        `Review Topic ${topic.id} has exhausted its discussion-round budget.`,
      );
    }
    for (const findingId of input.command.conflictFindingIds) {
      const candidate = database
        .prepare(
          `SELECT severity,
                  (SELECT disposition FROM review_resolutions
                    WHERE finding_id = findings.id
                 ORDER BY created_at DESC, id DESC LIMIT 1) AS disposition
             FROM review_findings AS findings
            WHERE id = ? AND topic_id = ?`,
        )
        .get(findingId, topic.id) as
        | { readonly severity: string; readonly disposition: string | null }
        | undefined;
      if (
        !candidate ||
        (candidate.severity !== "high" &&
          candidate.severity !== "critical" &&
          candidate.disposition !== "disputed")
      ) {
        throw new ReviewRuntimeError(
          "REVIEW_DISCUSSION_SCOPE_INVALID",
          `Finding ${findingId} is not disputed or high/critical.`,
        );
      }
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO review_discussions(
           id, topic_id, round, status, conflict_finding_ids_json,
           bounded_prompt, opened_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        input.command.discussionId,
        topic.id,
        round,
        canonicalJson(input.command.conflictFindingIds),
        input.command.boundedPrompt,
        now,
      );
    updateTopic({
      topicId: topic.id,
      status: "discussion",
      expectedRevision: topic.revision,
      updatedAt: now,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.discussion.opened",
      entityType: "review-discussion",
      entityId: input.command.discussionId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.discussion.round",
      payload: {
        topicId: topic.id,
        discussionId: input.command.discussionId,
        round,
        status: "open",
        conflictFindingIds: input.command.conflictFindingIds,
      },
      createdAt: now,
    });
    return inspect(topic.id);
  };

  const closeDiscussion = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.discussion.close" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["discussion"]);
    const moderator = participantRow(
      topic.id,
      input.command.moderatorParticipantId,
    );
    requireParticipantActor(input.actor, moderator);
    if (moderator.role !== "moderator") {
      throw new ReviewRuntimeError(
        "REVIEW_MODERATOR_REQUIRED",
        "Only the frozen moderator may close a Review discussion round.",
      );
    }
    const discussion = database
      .prepare(
        `SELECT round FROM review_discussions
          WHERE id = ? AND topic_id = ? AND status = 'open'`,
      )
      .get(input.command.discussionId, topic.id) as
      | { readonly round: number }
      | undefined;
    if (!discussion) {
      throw new ReviewRuntimeError(
        "REVIEW_DISCUSSION_NOT_OPEN",
        `Review discussion ${input.command.discussionId} is not open.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE review_discussions
            SET status = 'closed', tokens_used = ?, cost_cents_used = ?,
                duration_seconds = ?, stop_reason = ?, closed_at = ?
          WHERE id = ? AND status = 'open'`,
      )
      .run(
        input.command.tokensUsed,
        input.command.costCentsUsed,
        input.command.durationSeconds,
        input.command.stopReason ?? null,
        now,
        input.command.discussionId,
      );
    const roundsUsed = topic.roundsUsed + 1;
    const durationSecondsUsed =
      topic.durationSecondsUsed + input.command.durationSeconds;
    const tokensUsed = topic.tokensUsed + input.command.tokensUsed;
    const costCentsUsed = topic.costCentsUsed + input.command.costCentsUsed;
    const budget = parseJson(
      topic.budgetJson,
      `Review Topic ${topic.id} budget`,
    ) as {
      readonly maxRounds: number;
      readonly maxDurationSeconds: number;
      readonly maxTokens: number;
      readonly maxCostCents: number;
    };
    const exhausted =
      roundsUsed >= budget.maxRounds ||
      durationSecondsUsed > budget.maxDurationSeconds ||
      tokensUsed > budget.maxTokens ||
      costCentsUsed > budget.maxCostCents;
    updateTopic({
      topicId: topic.id,
      status: exhausted ? "FAIL" : "revision",
      expectedRevision: topic.revision,
      updatedAt: now,
      roundsUsed,
      durationSecondsUsed,
      tokensUsed,
      costCentsUsed,
    });
    const gateId = exhausted ? `quality-gate-${topic.id}` : undefined;
    if (gateId) {
      database
        .prepare(
          `INSERT INTO quality_gate_results(
             id, topic_id, kind, manifest_json, manifest_hash, revision_id,
             result, conditions_json, recheck_ids_json, evidence_refs_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'FAIL', '[]', '[]', ?, ?)`,
        )
        .run(
          gateId,
          topic.id,
          topic.kind,
          topic.manifestJson,
          topic.manifestHash,
          canonicalJson([
            "review-budget-exhausted",
            `discussion:${input.command.discussionId}`,
          ]),
          now,
        );
    }
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.discussion.closed",
      entityType: "review-discussion",
      entityId: input.command.discussionId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.discussion.round",
      payload: {
        topicId: topic.id,
        discussionId: input.command.discussionId,
        round: Number(discussion.round),
        status: "closed",
        exhausted,
        stopReason:
          input.command.stopReason ??
          (exhausted ? "review-budget-exhausted" : null),
      },
      createdAt: now,
    });
    if (gateId) {
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "quality-gate.completed",
        entityType: "quality-gate-result",
        entityId: gateId,
        topicId: topic.id,
        projectId: topic.projectId,
        runId: topic.runId,
        eventType: "quality-gate.completed",
        qualityGateResultId: gateId,
        payload: {
          topicId: topic.id,
          qualityGateResultId: gateId,
          result: "FAIL",
          manifestHash: topic.manifestHash,
          reason: "review-budget-exhausted",
        },
        createdAt: now,
      });
    }
    return inspect(topic.id);
  };

  const submitRevision = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.revision.submit" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["independent-review", "revision"]);
    const owner = participantRow(topic.id, input.command.ownerParticipantId);
    requireParticipantActor(input.actor, owner);
    if (owner.role !== "owner-participant") {
      throw new ReviewRuntimeError(
        "REVIEW_OWNER_REQUIRED",
        "Only the frozen owner-participant may submit a Review revision.",
      );
    }
    if (
      owner.aiMemberId !== input.command.producerAiMemberId ||
      owner.positionId !== input.command.producerPositionId ||
      owner.sessionId !== input.command.producerSessionId
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_REVISION_PRODUCER_MISMATCH",
        "Review revision producer must match the frozen owner participant.",
      );
    }
    const unresolved = database
      .prepare(
        `SELECT findings.id
           FROM review_findings AS findings
          WHERE findings.topic_id = ? AND findings.blocking = 1
            AND COALESCE((
              SELECT resolutions.disposition
                FROM review_resolutions AS resolutions
               WHERE resolutions.finding_id = findings.id
            ORDER BY resolutions.created_at DESC, resolutions.id DESC LIMIT 1
            ), 'open') NOT IN ('resolved', 'rejected')`,
      )
      .all(topic.id) as Array<{ readonly id: string }>;
    if (unresolved.length > 0) {
      throw new ReviewRuntimeError(
        "REVIEW_BLOCKING_FINDINGS_OPEN",
        `Review Topic ${topic.id} has unresolved blocking Findings.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO review_revisions(
           id, topic_id, subject_kind, subject_id, subject_hash,
           producer_ai_member_id, producer_position_id, producer_session_id,
           evidence_refs_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.command.revisionId,
        topic.id,
        input.command.subjectKind,
        input.command.subjectId,
        input.command.subjectHash,
        input.command.producerAiMemberId,
        input.command.producerPositionId,
        input.command.producerSessionId,
        canonicalJson(input.command.evidenceRefs),
        now,
      );
    updateTopic({
      topicId: topic.id,
      status: "re-review",
      expectedRevision: topic.revision,
      updatedAt: now,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.revision.created",
      entityType: "review-revision",
      entityId: input.command.revisionId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.revision.created",
      payload: {
        topicId: topic.id,
        revisionId: input.command.revisionId,
        subjectId: input.command.subjectId,
        subjectHash: input.command.subjectHash,
        status: "re-review",
      },
      createdAt: now,
    });
    return inspect(topic.id);
  };

  const submitRecheck = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      ReviewEnvelopeCommand,
      { type: "review.recheck.submit" }
    >;
  }): ReviewTopicView => {
    const topic = topicRow(input.command.topicId);
    ensureTopicRevision(topic.id, input.expectedRevision);
    requireStatus(topic, ["re-review"]);
    const participant = participantRow(
      topic.id,
      input.command.reviewerParticipantId,
    );
    requireParticipantActor(input.actor, participant);
    if (
      participant.role !== "reviewer-participant" ||
      participant.eligible !== 1
    ) {
      throw new ReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        `Review participant ${participant.id} is not an eligible reviewer.`,
      );
    }
    const revision = database
      .prepare(
        `SELECT id, producer_session_id AS producerSessionId
           FROM review_revisions
          WHERE id = ? AND topic_id = ?
            AND created_at = (
              SELECT MAX(created_at) FROM review_revisions WHERE topic_id = ?
            )`,
      )
      .get(input.command.revisionId, topic.id, topic.id) as
      | { readonly id: string; readonly producerSessionId: string }
      | undefined;
    if (!revision) {
      throw new ReviewRuntimeError(
        "REVIEW_REVISION_MISMATCH",
        "Re-review must bind the latest immutable Review revision.",
      );
    }
    if (
      input.command.reviewerSessionId === participant.sessionId ||
      input.command.reviewerSessionId === topic.producerSessionId ||
      input.command.reviewerSessionId === revision.producerSessionId
    ) {
      throw new ReviewRuntimeError(
        "FRESH_REVIEW_SESSION_REQUIRED",
        "Re-review must use a new independent Session.",
      );
    }
    ensureSessionForReviewer({
      projectId: topic.projectId,
      participant,
      sessionId: input.command.reviewerSessionId,
    });
    if (
      input.command.result === "PASS" &&
      input.command.conditions.length > 0
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_PASS_CONDITIONS_INVALID",
        "A PASS vote cannot carry conditions.",
      );
    }
    if (
      input.command.result === "CONDITIONAL_PASS" &&
      input.command.conditions.length === 0
    ) {
      throw new ReviewRuntimeError(
        "REVIEW_CONDITIONS_REQUIRED",
        "A CONDITIONAL_PASS vote requires machine-checkable conditions.",
      );
    }
    const now = clock().toISOString();
    const eligibilitySnapshot = {
      topicId: topic.id,
      revisionId: revision.id,
      participantId: participant.id,
      aiMemberId: participant.aiMemberId,
      positionId: participant.positionId,
      initialSessionId: participant.sessionId,
      reviewerSessionId: input.command.reviewerSessionId,
      producerSessionIds: [topic.producerSessionId, revision.producerSessionId],
      manifestHash: topic.manifestHash,
      eligible: true,
    };
    database
      .prepare(
        `INSERT INTO review_rechecks(
           id, topic_id, revision_id, reviewer_participant_id,
           reviewer_session_id, result, conditions_json, evidence_refs_json,
           eligibility_snapshot_json, eligibility_snapshot_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.command.recheckId,
        topic.id,
        revision.id,
        participant.id,
        input.command.reviewerSessionId,
        input.command.result,
        canonicalJson(input.command.conditions),
        canonicalJson(input.command.evidenceRefs),
        canonicalJson(eligibilitySnapshot),
        sha256(canonicalJson(eligibilitySnapshot)),
        now,
      );

    const votes = database
      .prepare(
        `SELECT id, reviewer_participant_id AS reviewerParticipantId, result,
                conditions_json AS conditionsJson,
                evidence_refs_json AS evidenceRefsJson
           FROM review_rechecks WHERE revision_id = ?
       ORDER BY created_at, id`,
      )
      .all(revision.id) as Array<{
      readonly id: string;
      readonly reviewerParticipantId: string;
      readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
      readonly conditionsJson: string;
      readonly evidenceRefsJson: string;
    }>;
    let terminalResult: "PASS" | "CONDITIONAL_PASS" | "FAIL" | undefined;
    let gateId: string | undefined;
    if (votes.length >= topic.quorum) {
      const hasFreshReviewer = votes.some((vote) => {
        const initialFinding = database
          .prepare(
            `SELECT 1 FROM review_findings
              WHERE topic_id = ? AND reviewer_participant_id = ? LIMIT 1`,
          )
          .get(topic.id, vote.reviewerParticipantId);
        return !initialFinding;
      });
      if (!hasFreshReviewer) {
        throw new ReviewRuntimeError(
          "FRESH_REVIEWER_REQUIRED",
          "Final re-review quorum must include an eligible reviewer who did not submit an initial Finding.",
        );
      }
      const unresolvedBlocking = database
        .prepare(
          `SELECT 1
             FROM review_findings AS findings
            WHERE findings.topic_id = ? AND findings.blocking = 1
              AND COALESCE((
                SELECT resolutions.disposition
                  FROM review_resolutions AS resolutions
                 WHERE resolutions.finding_id = findings.id
              ORDER BY resolutions.created_at DESC, resolutions.id DESC LIMIT 1
              ), 'open') NOT IN ('resolved', 'rejected')
            LIMIT 1`,
        )
        .get(topic.id);
      terminalResult = votes.some((vote) => vote.result === "FAIL")
        ? "FAIL"
        : unresolvedBlocking
          ? "FAIL"
          : votes.some((vote) => vote.result === "CONDITIONAL_PASS")
            ? "CONDITIONAL_PASS"
            : "PASS";
      const conditions = votes.flatMap(
        (vote) =>
          parseJson(
            vote.conditionsJson,
            `Review recheck ${vote.id} conditions`,
          ) as string[],
      );
      const evidenceRefs = votes.flatMap(
        (vote) =>
          parseJson(
            vote.evidenceRefsJson,
            `Review recheck ${vote.id} evidence`,
          ) as string[],
      );
      gateId = `quality-gate-${topic.id}`;
      database
        .prepare(
          `INSERT INTO quality_gate_results(
             id, topic_id, kind, manifest_json, manifest_hash, revision_id,
             result, conditions_json, recheck_ids_json, evidence_refs_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          gateId,
          topic.id,
          topic.kind,
          topic.manifestJson,
          topic.manifestHash,
          revision.id,
          terminalResult,
          canonicalJson(conditions),
          canonicalJson(votes.map((vote) => vote.id)),
          canonicalJson(evidenceRefs),
          now,
        );
    }
    updateTopic({
      topicId: topic.id,
      status: terminalResult,
      expectedRevision: topic.revision,
      updatedAt: now,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "review.recheck.completed",
      entityType: "review-recheck",
      entityId: input.command.recheckId,
      topicId: topic.id,
      projectId: topic.projectId,
      runId: topic.runId,
      eventType: "review.recheck.completed",
      payload: {
        topicId: topic.id,
        recheckId: input.command.recheckId,
        revisionId: revision.id,
        result: input.command.result,
        quorum: topic.quorum,
        voteCount: votes.length,
      },
      createdAt: now,
    });
    if (terminalResult && gateId) {
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "quality-gate.completed",
        entityType: "quality-gate-result",
        entityId: gateId,
        topicId: topic.id,
        projectId: topic.projectId,
        runId: topic.runId,
        eventType: "quality-gate.completed",
        qualityGateResultId: gateId,
        payload: {
          topicId: topic.id,
          qualityGateResultId: gateId,
          result: terminalResult,
          manifestHash: topic.manifestHash,
          revisionId: revision.id,
        },
        createdAt: now,
      });
    }
    return inspect(topic.id);
  };

  const unsupported = (command: ReviewEnvelopeCommand): never => {
    throw new ReviewRuntimeError(
      "REVIEW_COMMAND_NOT_IMPLEMENTED",
      `Review Command ${command.type} is not implemented yet.`,
    );
  };

  const dispatchInTransaction: ReviewRuntime["dispatchInTransaction"] = (
    input,
  ) => {
    if (input.command.type === "review.topic.create") {
      return createTopic({ ...input, command: input.command });
    }
    if (input.command.type === "review.finding.submit") {
      return submitFinding({ ...input, command: input.command });
    }
    if (input.command.type === "review.finding.disposition") {
      return dispositionFinding({ ...input, command: input.command });
    }
    if (input.command.type === "review.discussion.open") {
      return openDiscussion({ ...input, command: input.command });
    }
    if (input.command.type === "review.discussion.close") {
      return closeDiscussion({ ...input, command: input.command });
    }
    if (input.command.type === "review.revision.submit") {
      return submitRevision({ ...input, command: input.command });
    }
    if (input.command.type === "review.recheck.submit") {
      return submitRecheck({ ...input, command: input.command });
    }
    return unsupported(input.command);
  };

  const transitionIndependentExecutionInTransaction: ReviewRuntime["transitionIndependentExecutionInTransaction"] =
    (input) => {
      const topic = topicRow(input.topicId);
      const from = input.state === "blocked" ? "independent-review" : "blocked";
      const to = input.state === "blocked" ? "blocked" : "independent-review";
      if (topic.status !== from) {
        throw new ReviewRuntimeError(
          "REVIEW_STATUS_INVALID",
          `Review Topic ${topic.id} must be ${from} before it becomes ${to}.`,
        );
      }
      const now = clock().toISOString();
      const updated = database
        .prepare(
          `UPDATE review_topics SET status = ?, revision = revision + ?,
                  updated_at = ?
            WHERE id = ? AND status = ?`,
        )
        .run(to, input.state === "active" ? 1 : 0, now, topic.id, from);
      if (updated.changes !== 1) {
        throw new ReviewRuntimeError(
          "REVIEW_STATUS_CONFLICT",
          `Review Topic ${topic.id} changed before its independent execution transition.`,
        );
      }
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action:
          input.state === "blocked"
            ? "review.topic.blocked"
            : "review.topic.activated",
        entityType: "review-topic",
        entityId: topic.id,
        topicId: topic.id,
        projectId: topic.projectId,
        runId: topic.runId,
        eventType: "review.scheduled",
        payload: {
          topicId: topic.id,
          status: to,
          reason: "independent-code-review-execution",
        },
        createdAt: now,
      });
      return inspect(topic.id);
    };

  return {
    inspect,
    list,
    dispatchInTransaction,
    transitionIndependentExecutionInTransaction,
    recordAggregateExecutionInTransaction,
  };
};
