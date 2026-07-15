import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface MemoryCandidateView {
  readonly id: string;
  readonly projectId: string;
  readonly scope: "project" | "ai-member";
  readonly aiMemberId: string | null;
  readonly sourceSessionId: string | null;
  readonly sourceRunId: string | null;
  readonly sourceArtifactVersionId: string | null;
  readonly summary: string;
  readonly status: "pending" | "approved" | "discarded";
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export interface MemoryRecordView {
  readonly id: string;
  readonly candidateId: string;
  readonly projectId: string;
  readonly scope: "project" | "ai-member";
  readonly ownerId: string;
  readonly version: number;
  readonly content: string;
  readonly status: "active" | "revoked";
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface RuntimeMemory {
  readonly createCandidate: (input: {
    readonly projectId: string;
    readonly scope: "project" | "ai-member";
    readonly aiMemberId?: string;
    readonly sourceSessionId?: string;
    readonly sourceRunId?: string;
    readonly sourceArtifactVersionId?: string;
    readonly summary: string;
  }) => MemoryCandidateView;
  readonly reviewCandidate: (input: {
    readonly candidateId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "discarded";
  }) => {
    readonly candidate: MemoryCandidateView;
    readonly record: MemoryRecordView | null;
  };
  readonly listCandidates: (
    projectId: string,
  ) => readonly MemoryCandidateView[];
  readonly listRecords: (projectId: string) => readonly MemoryRecordView[];
}

export class RuntimeMemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeMemoryError";
  }
}

const containsSensitiveMaterial = (value: string): boolean =>
  /(?:\btoken\s*=|\bpassword\s*=|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,})/i.test(
    value,
  );

export const openRuntimeMemory = (database: DatabaseSync): RuntimeMemory => {
  const readCandidate = (candidateId: string): MemoryCandidateView => {
    const row = database
      .prepare(
        `SELECT id, project_id AS projectId, scope,
                ai_member_id AS aiMemberId,
                source_session_id AS sourceSessionId,
                source_run_id AS sourceRunId,
                source_artifact_version_id AS sourceArtifactVersionId,
                summary, status, created_at AS createdAt,
                reviewed_at AS reviewedAt
           FROM memory_candidates WHERE id = ?`,
      )
      .get(candidateId) as MemoryCandidateView | undefined;
    if (!row) {
      throw new RuntimeMemoryError(
        "MEMORY_CANDIDATE_NOT_FOUND",
        `Memory Candidate ${candidateId} was not found.`,
      );
    }
    return row;
  };

  const readRecord = (recordId: string): MemoryRecordView => {
    const row = database
      .prepare(
        `SELECT id, candidate_id AS candidateId, project_id AS projectId,
                scope, owner_id AS ownerId, version, content, status,
                created_at AS createdAt, revoked_at AS revokedAt
           FROM memory_records WHERE id = ?`,
      )
      .get(recordId) as MemoryRecordView | undefined;
    if (!row) {
      throw new RuntimeMemoryError(
        "MEMORY_RECORD_NOT_FOUND",
        `Memory Record ${recordId} was not found.`,
      );
    }
    return { ...row, version: Number(row.version) };
  };

  const appendMutation = (input: {
    readonly action: string;
    readonly eventType: string;
    readonly candidate: MemoryCandidateView;
    readonly payload: unknown;
    readonly createdAt: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at
         ) VALUES (?, ?, 'memory-candidate', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.candidate.id,
        input.candidate.sourceRunId,
        JSON.stringify(input.payload),
        input.createdAt,
      );
    database
      .prepare(
        `INSERT INTO runtime_event_outbox(
           event_id, type, run_id, node_run_id, payload_json, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.eventType,
        input.candidate.sourceRunId,
        JSON.stringify(input.payload),
        input.createdAt,
      );
  };

  const createCandidate: RuntimeMemory["createCandidate"] = (input) => {
    const summary = input.summary.trim();
    if (!summary || summary.length > 20_000) {
      throw new RuntimeMemoryError(
        "MEMORY_CANDIDATE_INVALID",
        "Memory Candidate summary must contain between 1 and 20000 characters.",
      );
    }
    if (containsSensitiveMaterial(summary)) {
      throw new RuntimeMemoryError(
        "MEMORY_CANDIDATE_SENSITIVE",
        "Memory Candidate appears to contain sensitive material.",
      );
    }
    if (input.scope === "ai-member" && !input.aiMemberId) {
      throw new RuntimeMemoryError(
        "MEMORY_SCOPE_INVALID",
        "AI Member Memory requires an AI Member ID.",
      );
    }
    if (
      !input.sourceSessionId &&
      !input.sourceRunId &&
      !input.sourceArtifactVersionId
    ) {
      throw new RuntimeMemoryError(
        "MEMORY_SOURCE_INVALID",
        "Memory Candidate requires Session, Run, or Artifact Version provenance.",
      );
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      const project = database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(input.projectId);
      if (!project) {
        throw new RuntimeMemoryError(
          "PROJECT_NOT_FOUND",
          `Active Project ${input.projectId} was not found.`,
        );
      }
      database
        .prepare(
          `INSERT INTO memory_candidates(
             id, project_id, scope, ai_member_id, source_session_id,
             source_run_id, source_artifact_version_id, summary, status,
             created_at, reviewed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
        )
        .run(
          id,
          input.projectId,
          input.scope,
          input.aiMemberId ?? null,
          input.sourceSessionId ?? null,
          input.sourceRunId ?? null,
          input.sourceArtifactVersionId ?? null,
          summary,
          now,
        );
      const candidate = readCandidate(id);
      appendMutation({
        action: "memory.candidate.create",
        eventType: "memory.candidate.created",
        candidate,
        payload: {
          candidateId: id,
          projectId: input.projectId,
          scope: input.scope,
          status: "pending",
        },
        createdAt: now,
      });
      database.exec("COMMIT");
      return candidate;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const reviewCandidate: RuntimeMemory["reviewCandidate"] = (input) => {
    const current = readCandidate(input.candidateId);
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const updated = database
        .prepare(
          `UPDATE memory_candidates SET status = ?, reviewed_at = ?
            WHERE id = ? AND status = ?`,
        )
        .run(input.decision, now, input.candidateId, input.expectedStatus);
      if (Number(updated.changes) !== 1) {
        throw new RuntimeMemoryError(
          "MEMORY_CANDIDATE_STATE_INVALID",
          `Memory Candidate ${input.candidateId} is not pending.`,
        );
      }
      let record: MemoryRecordView | null = null;
      if (input.decision === "approved") {
        const ownerId =
          current.scope === "project" ? current.projectId : current.aiMemberId;
        if (!ownerId) {
          throw new RuntimeMemoryError(
            "MEMORY_SCOPE_INVALID",
            "Approved AI Member Memory requires an owner.",
          );
        }
        const versionRow = database
          .prepare(
            `SELECT COALESCE(MAX(version), 0) + 1 AS version
               FROM memory_records WHERE scope = ? AND owner_id = ?`,
          )
          .get(current.scope, ownerId) as { readonly version: number };
        const recordId = randomUUID();
        database
          .prepare(
            `INSERT INTO memory_records(
               id, candidate_id, project_id, scope, owner_id, version,
               content, status, created_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            recordId,
            current.id,
            current.projectId,
            current.scope,
            ownerId,
            Number(versionRow.version),
            current.summary,
            now,
          );
        record = readRecord(recordId);
      }
      const candidate = readCandidate(current.id);
      appendMutation({
        action: "memory.candidate.review",
        eventType: "memory.candidate.reviewed",
        candidate,
        payload: {
          candidateId: candidate.id,
          status: candidate.status,
          recordId: record?.id ?? null,
        },
        createdAt: now,
      });
      database.exec("COMMIT");
      return { candidate, record };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const listCandidates = (projectId: string): readonly MemoryCandidateView[] =>
    (
      database
        .prepare(
          `SELECT id FROM memory_candidates
            WHERE project_id = ? ORDER BY created_at, id`,
        )
        .all(projectId) as Array<{ readonly id: string }>
    ).map((row) => readCandidate(row.id));

  const listRecords = (projectId: string): readonly MemoryRecordView[] =>
    (
      database
        .prepare(
          `SELECT id FROM memory_records
            WHERE project_id = ? ORDER BY scope, owner_id, version`,
        )
        .all(projectId) as Array<{ readonly id: string }>
    ).map((row) => readRecord(row.id));

  return { createCandidate, reviewCandidate, listCandidates, listRecords };
};
