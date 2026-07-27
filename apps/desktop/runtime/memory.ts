import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MemoryCandidateViewSchema,
  MemoryDecisionViewSchema,
  MemoryEntryViewSchema,
  LegacyMemoryRecordViewSchema,
  RunMemorySelectionViewSchema,
  type ActorRef,
  type MemoryCandidateView,
  type MemoryDecisionView,
  type MemoryEntryView,
  type LegacyMemoryRecordView,
  type MemoryEnvelopeCommand,
  type RunSnapshotPayload,
  type RunMemorySelectionView,
} from "./interface.js";
import type { ArtifactRegistry } from "./artifactRegistry.js";
import type { ExecutionMemoryEntry } from "./adapters/scriptedExecutionAdapter.js";
import type { RuntimeEvents } from "./events/subscription.js";
import type { PipelineRuntime } from "./pipeline/pipelineRuntime.js";
import type { ReviewRuntime } from "./review/reviewRuntime.js";

export class RuntimeMemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeMemoryError";
  }
}

export interface RuntimeMemory {
  readonly inspectCandidate: (candidateId: string) => MemoryCandidateView;
  readonly listCandidates: (
    projectId: string,
  ) => readonly MemoryCandidateView[];
  readonly listEntries: (projectId: string) => readonly MemoryEntryView[];
  readonly listSelections: (runId: string) => readonly RunMemorySelectionView[];
  readonly listLegacyRecords: (
    projectId: string,
  ) => readonly LegacyMemoryRecordView[];
  readonly resolveEntriesForExecution: (input: {
    readonly projectId: string;
    readonly aiMemberId: string | null;
    readonly selections: NonNullable<RunSnapshotPayload["memorySelections"]>;
  }) => readonly ExecutionMemoryEntry[];
  readonly proposeCandidateInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: Extract<
      MemoryEnvelopeCommand,
      { type: "memory.candidate.propose" }
    >;
  }) => MemoryCandidateView;
  readonly startReviewInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly command: Extract<
      MemoryEnvelopeCommand,
      { type: "memory.review.start" }
    >;
  }) => MemoryCandidateView;
  readonly decideCandidateInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: Extract<
      MemoryEnvelopeCommand,
      { type: "memory.candidate.decide" }
    >;
  }) => MemoryDecisionView;
  readonly selectEntriesForRunInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly command: Extract<
      MemoryEnvelopeCommand,
      { type: "memory.entry.select-for-run" }
    >;
  }) => RunMemorySelectionView;
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
    throw new RuntimeMemoryError(
      "MEMORY_DATA_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

const MEMORY_REDACTION_POLICIES = {
  "redaction-v1":
    "7f2b38422f7e1c4f6432eaceff54447166018186464fb3801e27b89f8409fe44",
} as const;

const sensitiveMaterialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:password|passwd|pwd|token|api[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const containsSensitiveMaterial = (value: string): boolean =>
  sensitiveMaterialPatterns.some((pattern) => pattern.test(value));

export const openRuntimeMemory = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly artifacts: Pick<ArtifactRegistry, "inspect">;
    readonly reviewRuntime: Pick<
      ReviewRuntime,
      "dispatchInTransaction" | "inspect"
    >;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      "inspectRun" | "promoteMemorySelectionInTransaction"
    >;
    readonly clock?: () => Date;
  },
): RuntimeMemory => {
  const clock = options.clock ?? (() => new Date());

  const appendMutation = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly projectId: string;
    readonly runId?: string;
    readonly memoryCandidateId?: string;
    readonly memoryEntryId?: string;
    readonly snapshotRevisionId?: string;
    readonly topicId?: string;
    readonly qualityGateResultId?: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
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
        ...(input.snapshotRevisionId
          ? { snapshotRevisionId: input.snapshotRevisionId }
          : {}),
        ...(input.topicId ? { topicId: input.topicId } : {}),
        ...(input.qualityGateResultId
          ? { qualityGateResultId: input.qualityGateResultId }
          : {}),
        ...(input.memoryCandidateId
          ? { memoryCandidateId: input.memoryCandidateId }
          : {}),
        ...(input.memoryEntryId ? { memoryEntryId: input.memoryEntryId } : {}),
        commandId: input.commandId,
      },
      payload: input.payload,
      timestamp: input.createdAt,
    });
  };

  const readCandidate = (candidateId: string): MemoryCandidateView => {
    const row = database
      .prepare(
        `SELECT candidates.id, candidates.project_id AS projectId,
                candidates.scope, candidates.ai_member_id AS aiMemberId,
                candidates.status, candidates.revision,
                candidates.review_topic_id AS reviewTopicId,
                candidates.created_at AS createdAt,
                candidates.updated_at AS updatedAt,
                revisions.id AS revisionId,
                revisions.revision AS revisionNumber,
                revisions.supersedes_revision_id AS supersedesRevisionId,
                revisions.content, revisions.content_hash AS contentHash,
                revisions.redaction_policy_version AS redactionPolicyVersion,
                revisions.redaction_policy_hash AS redactionPolicyHash,
                revisions.source_artifact_versions_json AS sourceArtifactsJson,
                revisions.source_event_ranges_json AS sourceEventRangesJson,
                revisions.producer_ai_member_id AS producerAiMemberId,
                revisions.producer_position_id AS producerPositionId,
                revisions.producer_session_id AS producerSessionId,
                revisions.created_at AS revisionCreatedAt,
                decisions.id AS decisionId,
                decisions.candidate_revision_id AS decisionCandidateRevisionId,
                decisions.candidate_revision_hash AS decisionCandidateRevisionHash,
                decisions.quality_gate_result_id AS decisionQualityGateResultId,
                decisions.decision AS decisionValue,
                decisions.actor_type AS decisionActorType,
                decisions.actor_id AS decisionActorId,
                decisions.authenticated_by AS decisionAuthenticatedBy,
                decisions.created_at AS decisionCreatedAt,
                entries.id AS decisionEntryId
           FROM reviewed_memory_candidates AS candidates
           JOIN reviewed_memory_candidate_revisions AS revisions
             ON revisions.id = candidates.current_revision_id
           LEFT JOIN reviewed_memory_decisions AS decisions
             ON decisions.candidate_revision_id = revisions.id
           LEFT JOIN reviewed_memory_entries AS entries
             ON entries.decision_id = decisions.id
          WHERE candidates.id = ?`,
      )
      .get(candidateId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new RuntimeMemoryError(
        "MEMORY_CANDIDATE_NOT_FOUND",
        `Memory Candidate ${candidateId} was not found.`,
      );
    }
    return MemoryCandidateViewSchema.parse({
      id: row.id,
      projectId: row.projectId,
      scope: row.scope,
      aiMemberId: row.aiMemberId,
      status: row.status,
      revision: Number(row.revision),
      currentRevision: {
        id: row.revisionId,
        revision: Number(row.revisionNumber),
        supersedesRevisionId: row.supersedesRevisionId,
        content: row.content,
        hash: row.contentHash,
        redactionPolicy: {
          version: row.redactionPolicyVersion,
          hash: row.redactionPolicyHash,
        },
        sourceArtifactVersions: parseJson(
          String(row.sourceArtifactsJson),
          `Memory Candidate Revision ${String(row.revisionId)} source Artifacts`,
        ),
        sourceEventRanges: parseJson(
          String(row.sourceEventRangesJson),
          `Memory Candidate Revision ${String(row.revisionId)} source Events`,
        ),
        producer: {
          aiMemberId: row.producerAiMemberId,
          positionId: row.producerPositionId,
          sessionId: row.producerSessionId,
        },
        createdAt: row.revisionCreatedAt,
      },
      reviewTopicId: row.reviewTopicId,
      decision:
        row.decisionId === null
          ? null
          : {
              id: row.decisionId,
              candidateRevisionId: row.decisionCandidateRevisionId,
              candidateRevisionHash: row.decisionCandidateRevisionHash,
              qualityGateResultId: row.decisionQualityGateResultId,
              decision: row.decisionValue,
              decidedBy: {
                type: row.decisionActorType,
                id: row.decisionActorId,
                authenticatedBy: row.decisionAuthenticatedBy,
              },
              createdAt: row.decisionCreatedAt,
              entryId: row.decisionEntryId,
            },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  };

  const readEntry = (entryId: string): MemoryEntryView => {
    const row = database
      .prepare(
        `SELECT entries.id,
                entries.candidate_revision_id AS candidateRevisionId,
                entries.project_id AS projectId, entries.scope,
                entries.owner_id AS ownerId, entries.version,
                entries.content, entries.content_hash AS hash,
                entries.redaction_policy_version AS redactionPolicyVersion,
                entries.redaction_policy_hash AS redactionPolicyHash,
                entries.quality_gate_result_id AS qualityGateResultId,
                entries.decision_id AS decisionId,
                entries.created_at AS createdAt
           FROM reviewed_memory_entries AS entries WHERE entries.id = ?`,
      )
      .get(entryId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new RuntimeMemoryError(
        "MEMORY_ENTRY_NOT_FOUND",
        `Memory Entry ${entryId} was not found.`,
      );
    }
    return MemoryEntryViewSchema.parse({
      ...row,
      version: Number(row.version),
      redactionPolicy: {
        version: row.redactionPolicyVersion,
        hash: row.redactionPolicyHash,
      },
    });
  };

  const resolveEntriesForExecution: RuntimeMemory["resolveEntriesForExecution"] =
    (input) =>
      input.selections.flatMap((selection) => {
        const entry = readEntry(selection.entryId);
        if (
          selection.targetProjectId !== input.projectId ||
          entry.projectId !== input.projectId ||
          selection.entryVersion !== entry.version ||
          selection.entryHash !== entry.hash ||
          selection.scope !== entry.scope ||
          selection.ownerId !== entry.ownerId
        ) {
          throw new RuntimeMemoryError(
            "MEMORY_ENTRY_CONTRACT_MISMATCH",
            `Selected Memory Entry ${selection.entryId} does not match the exact Snapshot contract.`,
          );
        }
        if (entry.scope === "ai-member" && entry.ownerId !== input.aiMemberId) {
          return [];
        }
        return [
          {
            id: entry.id,
            version: entry.version,
            hash: entry.hash,
            scope: entry.scope,
            ownerId: entry.ownerId,
            content: entry.content,
            redactionPolicy: entry.redactionPolicy,
          },
        ];
      });

  const verifyProducer = (input: {
    readonly projectId: string;
    readonly actor: ActorRef;
    readonly producer: {
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
    };
  }): void => {
    if (
      input.actor.type !== "runtime-worker" ||
      input.actor.authenticatedBy !== "runtime" ||
      input.actor.id !== input.producer.aiMemberId
    ) {
      throw new RuntimeMemoryError(
        "MEMORY_PRODUCER_ACTOR_INVALID",
        "Memory Candidate producer must be the bound Runtime worker.",
      );
    }
    const binding = database
      .prepare(
        `SELECT 1
           FROM positions
           JOIN interaction_sessions ON interaction_sessions.id = ?
          WHERE positions.id = ? AND positions.ai_member_id = ?
            AND interaction_sessions.project_id = ?
            AND EXISTS (
              SELECT 1 FROM session_participants
               WHERE session_id = interaction_sessions.id
                 AND participant_type = 'ai-member' AND participant_ref = ?
            )`,
      )
      .get(
        input.producer.sessionId,
        input.producer.positionId,
        input.producer.aiMemberId,
        input.projectId,
        input.producer.aiMemberId,
      );
    if (!binding) {
      throw new RuntimeMemoryError(
        "MEMORY_PRODUCER_INVALID",
        "Memory Candidate producer Position, AI Member, Session, and Project must match.",
      );
    }
  };

  const verifySources = (
    command: Extract<
      MemoryEnvelopeCommand,
      { type: "memory.candidate.propose" }
    >,
  ): void => {
    for (const source of command.sourceArtifactVersions) {
      const artifact = options.artifacts.inspect(source.id).version;
      if (
        artifact.projectId !== command.projectId ||
        artifact.contentHash !== source.hash ||
        artifact.integrityStatus !== "verified" ||
        artifact.lifecycle !== "finalized"
      ) {
        throw new RuntimeMemoryError(
          artifact.projectId !== command.projectId
            ? "MEMORY_SOURCE_PROJECT_MISMATCH"
            : "MEMORY_SOURCE_INVALID",
          `Artifact Version ${source.id} is not exact verified evidence for Project ${command.projectId}.`,
        );
      }
    }
    for (const range of command.sourceEventRanges) {
      if (range.fromSequence > range.toSequence) {
        throw new RuntimeMemoryError(
          "MEMORY_SOURCE_INVALID",
          "Memory source Event range must be ordered.",
        );
      }
      const run = database
        .prepare(
          "SELECT project_id AS projectId FROM department_runs WHERE id = ?",
        )
        .get(range.runId) as { readonly projectId: string } | undefined;
      if (!run || run.projectId !== command.projectId) {
        throw new RuntimeMemoryError(
          "MEMORY_SOURCE_PROJECT_MISMATCH",
          `Run ${range.runId} is not owned by Project ${command.projectId}.`,
        );
      }
      const evidence = database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(sequence) AS minimum,
                  MAX(sequence) AS maximum
             FROM runtime_event_outbox
            WHERE sequence BETWEEN ? AND ? AND run_id = ? AND project_id = ?`,
        )
        .get(
          range.fromSequence,
          range.toSequence,
          range.runId,
          command.projectId,
        ) as {
        readonly count: number;
        readonly minimum: number | null;
        readonly maximum: number | null;
      };
      const expectedCount = range.toSequence - range.fromSequence + 1;
      if (
        Number(evidence.count) !== expectedCount ||
        Number(evidence.minimum) !== range.fromSequence ||
        Number(evidence.maximum) !== range.toSequence
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_SOURCE_INVALID",
          `Runtime Event range ${range.fromSequence}-${range.toSequence} is missing, non-contiguous, or crosses scope.`,
        );
      }
    }
  };

  const proposeCandidateInTransaction: RuntimeMemory["proposeCandidateInTransaction"] =
    (input) => {
      const command = input.command;
      const content = command.content.trim();
      if (
        MEMORY_REDACTION_POLICIES[
          command.redactionPolicy
            .version as keyof typeof MEMORY_REDACTION_POLICIES
        ] !== command.redactionPolicy.hash
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_REDACTION_POLICY_UNSUPPORTED",
          "Memory Candidate redaction policy version/hash is not registered by this Runtime.",
        );
      }
      if (containsSensitiveMaterial(content)) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_SENSITIVE",
          "Memory Candidate appears to contain sensitive material.",
        );
      }
      if (command.scope === "ai-member" && !command.aiMemberId) {
        throw new RuntimeMemoryError(
          "MEMORY_SCOPE_INVALID",
          "AI Member Memory requires an AI Member ID.",
        );
      }
      verifyProducer({
        projectId: command.projectId,
        actor: input.actor,
        producer: command.producer,
      });
      verifySources(command);
      const existing = database
        .prepare(
          `SELECT project_id AS projectId, scope,
                  ai_member_id AS aiMemberId, revision,
                  current_revision_id AS currentRevisionId, status
             FROM reviewed_memory_candidates WHERE id = ?`,
        )
        .get(command.candidateId) as
        | {
            readonly projectId: string;
            readonly scope: string;
            readonly aiMemberId: string | null;
            readonly revision: number;
            readonly currentRevisionId: string;
            readonly status: string;
          }
        | undefined;
      if (existing && ["accepted", "rejected"].includes(existing.status)) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_TERMINAL",
          "A decided Memory Candidate cannot be revised; create a new Candidate.",
        );
      }
      if (
        existing &&
        (existing.projectId !== command.projectId ||
          existing.scope !== command.scope ||
          existing.aiMemberId !== (command.aiMemberId ?? null))
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_IDENTITY_CONFLICT",
          "A Memory Candidate revision cannot change its Project, scope, or owner.",
        );
      }
      const expectedSupersedes = existing?.currentRevisionId;
      if ((command.supersedesRevisionId ?? undefined) !== expectedSupersedes) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_REVISION_CONFLICT",
          "Memory Candidate revision must supersede the exact current revision.",
        );
      }
      const revision = existing ? Number(existing.revision) + 1 : 1;
      const now = clock().toISOString();
      const revisionManifest = {
        candidateId: command.candidateId,
        revision,
        projectId: command.projectId,
        scope: command.scope,
        aiMemberId: command.aiMemberId ?? null,
        content,
        redactionPolicy: command.redactionPolicy,
        sourceArtifactVersions: command.sourceArtifactVersions,
        sourceEventRanges: command.sourceEventRanges,
        producer: command.producer,
        supersedesRevisionId: command.supersedesRevisionId ?? null,
      };
      const contentHash = sha256(canonicalJson(revisionManifest));
      if (!existing) {
        database
          .prepare(
            `INSERT INTO reviewed_memory_candidates(
               id, project_id, scope, ai_member_id, current_revision_id,
               revision, status, review_topic_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, 'draft', NULL, ?, ?)`,
          )
          .run(
            command.candidateId,
            command.projectId,
            command.scope,
            command.aiMemberId ?? null,
            command.revisionId,
            now,
            now,
          );
      }
      database
        .prepare(
          `INSERT INTO reviewed_memory_candidate_revisions(
             id, candidate_id, project_id, scope, ai_member_id, revision,
             supersedes_revision_id, content, content_hash,
             redaction_policy_version, redaction_policy_hash,
             source_artifact_versions_json, source_event_ranges_json,
             producer_ai_member_id, producer_position_id,
             producer_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.revisionId,
          command.candidateId,
          command.projectId,
          command.scope,
          command.aiMemberId ?? null,
          revision,
          command.supersedesRevisionId ?? null,
          content,
          contentHash,
          command.redactionPolicy.version,
          command.redactionPolicy.hash,
          canonicalJson(command.sourceArtifactVersions),
          canonicalJson(command.sourceEventRanges),
          command.producer.aiMemberId,
          command.producer.positionId,
          command.producer.sessionId,
          now,
        );
      if (existing) {
        database
          .prepare(
            `UPDATE reviewed_memory_candidates
                SET current_revision_id = ?, revision = ?, status = 'draft',
                    review_topic_id = NULL, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(
            command.revisionId,
            revision,
            now,
            command.candidateId,
            existing.revision,
          );
      }
      const candidate = readCandidate(command.candidateId);
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "memory.candidate.proposed",
        entityType: "memory-candidate-revision",
        entityId: command.revisionId,
        projectId: command.projectId,
        memoryCandidateId: command.candidateId,
        eventType: "memory.candidate.created",
        payload: {
          candidateId: command.candidateId,
          candidateRevisionId: command.revisionId,
          candidateRevisionHash: contentHash,
          scope: command.scope,
          status: "draft",
          redactionPolicyVersion: command.redactionPolicy.version,
        },
        createdAt: now,
      });
      return candidate;
    };

  const startReviewInTransaction: RuntimeMemory["startReviewInTransaction"] = (
    input,
  ) => {
    const candidate = readCandidate(input.command.candidateId);
    if (
      candidate.revision !== input.expectedRevision ||
      candidate.status !== "draft" ||
      candidate.currentRevision.id !== input.command.candidateRevisionId ||
      candidate.currentRevision.hash !== input.command.candidateRevisionHash
    ) {
      throw new RuntimeMemoryError(
        "MEMORY_CANDIDATE_REVISION_CONFLICT",
        "Memory Review must bind the exact current draft Candidate revision.",
      );
    }
    if (
      input.actor.type !== "runtime-worker" ||
      input.actor.authenticatedBy !== "runtime" ||
      input.actor.id !== candidate.currentRevision.producer.aiMemberId
    ) {
      throw new RuntimeMemoryError(
        "MEMORY_PRODUCER_ACTOR_INVALID",
        "Only the Candidate producer Runtime worker may start Memory Review.",
      );
    }
    if (
      candidate.aiMemberId &&
      input.command.participants.some(
        (participant) =>
          participant.role === "reviewer-participant" &&
          participant.aiMemberId === candidate.aiMemberId,
      )
    ) {
      throw new RuntimeMemoryError(
        "MEMORY_REVIEWER_SELF_APPROVAL",
        "The AI Member targeted by a Memory Candidate cannot review or vote on that Candidate.",
      );
    }
    const topic = options.reviewRuntime.dispatchInTransaction({
      commandId: input.commandId,
      actor: input.actor,
      expectedRevision: 0,
      command: {
        type: "review.topic.create",
        topicId: input.command.topicId,
        projectId: candidate.projectId,
        title: `Memory Review: ${candidate.id}`,
        manifest: {
          scope: "memory",
          topicId: input.command.topicId,
          supportingArtifactVersionIds:
            candidate.currentRevision.sourceArtifactVersions.map(
              (source) => source.id,
            ),
          supportingSpecRevisionIds: [],
          harnessSnapshotIds: [],
          acceptanceCriteria: [
            "The proposed Memory is durable, redacted, reusable, and scoped without leaking another Project.",
          ],
          excludedContext: [
            "hidden-prompts",
            "prior-reviewer-opinions",
            "private-transcripts",
            "provider-session-history",
            "credential-values",
          ],
          memoryCandidateId: candidate.id,
          memoryCandidateRevisionId: candidate.currentRevision.id,
          memoryCandidateRevisionHash: candidate.currentRevision.hash,
          targetScope: candidate.scope,
          targetProjectId: candidate.projectId,
          targetAiMemberId: candidate.aiMemberId,
          redactionPolicyVersion:
            candidate.currentRevision.redactionPolicy.version,
          redactionPolicyHash: candidate.currentRevision.redactionPolicy.hash,
          sourceArtifactVersions:
            candidate.currentRevision.sourceArtifactVersions,
          sourceEventRanges: candidate.currentRevision.sourceEventRanges,
        },
        producer: candidate.currentRevision.producer,
        participants: input.command.participants,
        quorum: input.command.quorum,
        budget: input.command.budget,
        stopCondition: "blocking-findings-dispositioned",
        escalationPolicy: "fail-with-evidence",
      },
    });
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO reviewed_memory_review_topics(
             topic_id, candidate_revision_id, created_at
           ) VALUES (?, ?, ?)`,
      )
      .run(input.command.topicId, candidate.currentRevision.id, now);
    database
      .prepare(
        `UPDATE reviewed_memory_candidates
              SET status = 'review', review_topic_id = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND status = 'draft'`,
      )
      .run(topic.topic.id, now, candidate.id, input.expectedRevision);
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "memory.review.started",
      entityType: "memory-candidate",
      entityId: candidate.id,
      projectId: candidate.projectId,
      memoryCandidateId: candidate.id,
      topicId: topic.topic.id,
      eventType: "memory.review.started",
      payload: {
        candidateId: candidate.id,
        candidateRevisionId: candidate.currentRevision.id,
        candidateRevisionHash: candidate.currentRevision.hash,
        topicId: topic.topic.id,
        status: "review",
      },
      createdAt: now,
    });
    return readCandidate(candidate.id);
  };

  const decideCandidateInTransaction: RuntimeMemory["decideCandidateInTransaction"] =
    (input) => {
      if (
        input.actor.type !== "human" ||
        input.actor.authenticatedBy !== "local-session"
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_HUMAN_DECISION_REQUIRED",
          "Memory promotion requires a verified human decision.",
        );
      }
      const candidate = readCandidate(input.command.candidateId);
      if (
        candidate.status !== "review" ||
        candidate.reviewTopicId !== input.command.topicId ||
        candidate.currentRevision.id !== input.command.candidateRevisionId ||
        candidate.currentRevision.hash !== input.command.candidateRevisionHash
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_REVISION_CONFLICT",
          "Memory decision must bind the exact reviewed Candidate revision.",
        );
      }
      const topic = options.reviewRuntime.inspect(input.command.topicId);
      if (
        topic.topic.kind !== "memory" ||
        topic.topic.manifest.scope !== "memory" ||
        topic.topic.manifest.memoryCandidateRevisionId !==
          candidate.currentRevision.id ||
        topic.topic.manifest.memoryCandidateRevisionHash !==
          candidate.currentRevision.hash ||
        !topic.gateResult
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_REVIEW_MISMATCH",
          "Memory decision requires exact independent Review evidence.",
        );
      }
      if (
        input.command.decision === "accepted" &&
        (topic.gateResult.result !== "PASS" ||
          !topic.gateResult.satisfiesProductionContract)
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_REVIEW_NOT_PASS",
          "Only an exact PASS Memory Review may be accepted.",
        );
      }
      const reviewedRevision = topic.revisions.find(
        (revision) => revision.id === topic.gateResult?.revisionId,
      );
      if (
        !reviewedRevision ||
        reviewedRevision.subjectKind !== "memory-candidate" ||
        reviewedRevision.subjectId !== candidate.currentRevision.id ||
        reviewedRevision.subjectHash !== candidate.currentRevision.hash
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_REVIEW_MISMATCH",
          "Memory Review Gate must bind the exact Candidate revision and hash.",
        );
      }
      const now = clock().toISOString();
      const decisionId = randomUUID();
      database
        .prepare(
          `INSERT INTO reviewed_memory_decisions(
             id, candidate_revision_id, candidate_revision_hash, topic_id,
             quality_gate_result_id, decision, actor_type, actor_id,
             authenticated_by, command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decisionId,
          candidate.currentRevision.id,
          candidate.currentRevision.hash,
          topic.topic.id,
          topic.gateResult.id,
          input.command.decision,
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
          input.commandId,
          now,
        );
      let entry: MemoryEntryView | null = null;
      if (input.command.decision === "accepted") {
        const ownerId =
          candidate.scope === "project"
            ? candidate.projectId
            : candidate.aiMemberId;
        if (!ownerId) {
          throw new RuntimeMemoryError(
            "MEMORY_SCOPE_INVALID",
            "Accepted AI Member Memory requires an owner.",
          );
        }
        const versionRow = database
          .prepare(
            `SELECT COALESCE(MAX(version), 0) + 1 AS version
               FROM reviewed_memory_entries WHERE scope = ? AND owner_id = ?`,
          )
          .get(candidate.scope, ownerId) as { readonly version: number };
        const entryId = randomUUID();
        const entryHash = sha256(
          canonicalJson({
            candidateRevisionId: candidate.currentRevision.id,
            candidateRevisionHash: candidate.currentRevision.hash,
            projectId: candidate.projectId,
            scope: candidate.scope,
            ownerId,
            version: Number(versionRow.version),
            content: candidate.currentRevision.content,
            redactionPolicy: candidate.currentRevision.redactionPolicy,
            qualityGateResultId: topic.gateResult.id,
          }),
        );
        database
          .prepare(
            `INSERT INTO reviewed_memory_entries(
               id, decision_id, candidate_revision_id, project_id, scope,
               owner_id, version, content, content_hash,
               redaction_policy_version, redaction_policy_hash,
               quality_gate_result_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entryId,
            decisionId,
            candidate.currentRevision.id,
            candidate.projectId,
            candidate.scope,
            ownerId,
            Number(versionRow.version),
            candidate.currentRevision.content,
            entryHash,
            candidate.currentRevision.redactionPolicy.version,
            candidate.currentRevision.redactionPolicy.hash,
            topic.gateResult.id,
            now,
          );
        entry = readEntry(entryId);
      }
      database
        .prepare(
          `UPDATE reviewed_memory_candidates
              SET status = ?, updated_at = ?
            WHERE id = ? AND status = 'review'`,
        )
        .run(input.command.decision, now, candidate.id);
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "memory.review.completed",
        entityType: "review-topic",
        entityId: topic.topic.id,
        projectId: candidate.projectId,
        memoryCandidateId: candidate.id,
        topicId: topic.topic.id,
        qualityGateResultId: topic.gateResult.id,
        eventType: "memory.reviewed",
        payload: {
          candidateId: candidate.id,
          candidateRevisionId: candidate.currentRevision.id,
          candidateRevisionHash: candidate.currentRevision.hash,
          topicId: topic.topic.id,
          qualityGateResultId: topic.gateResult.id,
          result: topic.gateResult.result,
        },
        createdAt: now,
      });
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: `memory.${input.command.decision}`,
        entityType: "memory-decision",
        entityId: decisionId,
        projectId: candidate.projectId,
        memoryCandidateId: candidate.id,
        ...(entry ? { memoryEntryId: entry.id } : {}),
        topicId: topic.topic.id,
        qualityGateResultId: topic.gateResult.id,
        eventType:
          input.command.decision === "accepted"
            ? "memory.accepted"
            : "memory.rejected",
        payload: {
          decisionId,
          candidateId: candidate.id,
          candidateRevisionId: candidate.currentRevision.id,
          candidateRevisionHash: candidate.currentRevision.hash,
          qualityGateResultId: topic.gateResult.id,
          decision: input.command.decision,
          entryId: entry?.id ?? null,
          entryHash: entry?.hash ?? null,
        },
        createdAt: now,
      });
      return MemoryDecisionViewSchema.parse({
        candidate: readCandidate(candidate.id),
        decision: {
          id: decisionId,
          candidateRevisionId: candidate.currentRevision.id,
          candidateRevisionHash: candidate.currentRevision.hash,
          qualityGateResultId: topic.gateResult.id,
          decision: input.command.decision,
          decidedBy: input.actor,
          createdAt: now,
          entryId: entry?.id ?? null,
        },
        entry,
      });
    };

  const selectEntriesForRunInTransaction: RuntimeMemory["selectEntriesForRunInTransaction"] =
    (input) => {
      if (
        input.actor.type !== "human" ||
        input.actor.authenticatedBy !== "local-session"
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_SELECTION_HUMAN_REQUIRED",
          "Selecting Memory into a future Snapshot requires a verified human.",
        );
      }
      const run = options.pipelineRuntime.inspectRun(input.command.runId);
      if (
        run.run.revision !== input.expectedRevision ||
        run.run.snapshotRevisionId !== input.command.sourceSnapshotRevisionId
      ) {
        throw new RuntimeMemoryError(
          "MEMORY_SELECTION_RUN_CONFLICT",
          "Memory selection must extend the exact current Run Snapshot.",
        );
      }
      const entries = input.command.entryRefs.map((ref) => {
        const entry = readEntry(ref.id);
        if (entry.version !== ref.version || entry.hash !== ref.hash) {
          throw new RuntimeMemoryError(
            "MEMORY_ENTRY_CONTRACT_MISMATCH",
            `Memory Entry ${ref.id} does not match the selected version/hash.`,
          );
        }
        if (entry.projectId !== run.run.projectId) {
          throw new RuntimeMemoryError(
            "MEMORY_SCOPE_PROJECT_MISMATCH",
            `Memory Entry ${ref.id} is not reviewed for Project ${run.run.projectId}.`,
          );
        }
        if (
          entry.scope === "ai-member" &&
          !run.snapshot.payload.positions.some(
            (position) => position.aiMember.id === entry.ownerId,
          )
        ) {
          throw new RuntimeMemoryError(
            "MEMORY_SCOPE_OWNER_MISMATCH",
            `AI Member Memory Entry ${ref.id} is not owned by a member in the target Snapshot.`,
          );
        }
        return entry;
      });
      const selectedEntryIds = new Set<string>();
      for (const entry of entries) {
        if (selectedEntryIds.has(entry.id)) {
          throw new RuntimeMemoryError(
            "MEMORY_SELECTION_DUPLICATE",
            `Memory Entry ${entry.id} was selected more than once.`,
          );
        }
        selectedEntryIds.add(entry.id);
      }
      const existingEntryIds = new Set(
        (run.snapshot.payload.memorySelections ?? []).map(
          (selection) => selection.entryId,
        ),
      );
      const repeatedEntry = entries.find((entry) =>
        existingEntryIds.has(entry.id),
      );
      if (repeatedEntry) {
        throw new RuntimeMemoryError(
          "MEMORY_SELECTION_DUPLICATE",
          `Memory Entry ${repeatedEntry.id} is already frozen in the current Snapshot.`,
        );
      }
      const now = clock().toISOString();
      const snapshotRevisionId = randomUUID();
      const promoted =
        options.pipelineRuntime.promoteMemorySelectionInTransaction({
          runId: input.command.runId,
          expectedRevision: input.expectedRevision,
          sourceSnapshotRevisionId: input.command.sourceSnapshotRevisionId,
          snapshotRevisionId,
          entries: entries.map((entry) => ({
            entryId: entry.id,
            entryVersion: entry.version,
            entryHash: entry.hash,
            scope: entry.scope,
            ownerId: entry.ownerId,
            targetProjectId: run.run.projectId,
          })),
          selectionReason: input.command.selectionReason,
          policyHash: input.command.policyHash,
          selectedAt: now,
        });
      for (const entry of entries) {
        database
          .prepare(
            `INSERT INTO run_memory_selections(
               id, project_id, run_id, source_snapshot_revision_id,
               snapshot_revision_id, entry_id, entry_version, entry_hash,
               selection_reason, policy_hash, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            run.run.projectId,
            run.run.id,
            input.command.sourceSnapshotRevisionId,
            snapshotRevisionId,
            entry.id,
            entry.version,
            entry.hash,
            input.command.selectionReason,
            input.command.policyHash,
            now,
          );
        appendMutation({
          commandId: input.commandId,
          actor: input.actor,
          action: "memory.selected",
          entityType: "run-memory-selection",
          entityId: `${snapshotRevisionId}:${entry.id}`,
          projectId: run.run.projectId,
          runId: run.run.id,
          snapshotRevisionId,
          memoryEntryId: entry.id,
          eventType: "memory.selected",
          payload: {
            sourceSnapshotRevisionId: input.command.sourceSnapshotRevisionId,
            snapshotRevisionId,
            snapshotHash: promoted.snapshot.hash,
            entryId: entry.id,
            entryVersion: entry.version,
            entryHash: entry.hash,
            selectionReason: input.command.selectionReason,
            policyHash: input.command.policyHash,
          },
          createdAt: now,
        });
      }
      return RunMemorySelectionViewSchema.parse({
        snapshotRevisionId,
        snapshotHash: promoted.snapshot.hash,
        selections: entries.map((entry) => ({
          entryId: entry.id,
          entryVersion: entry.version,
          entryHash: entry.hash,
          selectionReason: input.command.selectionReason,
          policyHash: input.command.policyHash,
        })),
      });
    };

  const listCandidates = (projectId: string): readonly MemoryCandidateView[] =>
    (
      database
        .prepare(
          `SELECT id FROM reviewed_memory_candidates
            WHERE project_id = ? ORDER BY created_at, id`,
        )
        .all(projectId) as Array<{ readonly id: string }>
    ).map((row) => readCandidate(row.id));

  const listEntries = (projectId: string): readonly MemoryEntryView[] =>
    (
      database
        .prepare(
          `SELECT id FROM reviewed_memory_entries
            WHERE project_id = ? ORDER BY scope, owner_id, version`,
        )
        .all(projectId) as Array<{ readonly id: string }>
    ).map((row) => readEntry(row.id));

  const listSelections = (runId: string): readonly RunMemorySelectionView[] => {
    const rows = database
      .prepare(
        `SELECT snapshot_revision_id AS snapshotRevisionId,
                entry_id AS entryId, entry_version AS entryVersion,
                entry_hash AS entryHash, selection_reason AS selectionReason,
                policy_hash AS policyHash
           FROM run_memory_selections WHERE run_id = ?
       ORDER BY created_at, id`,
      )
      .all(runId) as Array<{
      readonly snapshotRevisionId: string;
      readonly entryId: string;
      readonly entryVersion: number;
      readonly entryHash: string;
      readonly selectionReason: string;
      readonly policyHash: string;
    }>;
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      grouped.set(row.snapshotRevisionId, [
        ...(grouped.get(row.snapshotRevisionId) ?? []),
        row,
      ]);
    }
    return [...grouped.entries()].map(([snapshotRevisionId, selections]) => {
      const snapshot = database
        .prepare("SELECT hash FROM run_snapshot_revisions WHERE id = ?")
        .get(snapshotRevisionId) as { readonly hash: string };
      return RunMemorySelectionViewSchema.parse({
        snapshotRevisionId,
        snapshotHash: snapshot.hash,
        selections,
      });
    });
  };

  const listLegacyRecords = (
    projectId: string,
  ): readonly LegacyMemoryRecordView[] =>
    LegacyMemoryRecordViewSchema.array().parse(
      database
        .prepare(
          `SELECT id, candidate_id AS candidateId, project_id AS projectId,
                  scope, owner_id AS ownerId, version, content, status,
                  created_at AS createdAt, revoked_at AS revokedAt
             FROM memory_records WHERE project_id = ?
         ORDER BY scope, owner_id, version`,
        )
        .all(projectId),
    );

  return {
    inspectCandidate: readCandidate,
    listCandidates,
    listEntries,
    listSelections,
    listLegacyRecords,
    resolveEntriesForExecution,
    proposeCandidateInTransaction,
    startReviewInTransaction,
    decideCandidateInTransaction,
    selectEntriesForRunInTransaction,
  };
};
