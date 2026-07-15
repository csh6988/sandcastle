import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type ArtifactVersionStatus =
  | "draft"
  | "produced"
  | "accepted"
  | "rejected"
  | "superseded";

export interface ArtifactVersionView {
  readonly id: string;
  readonly artifactId: string;
  readonly projectId: string;
  readonly type: string;
  readonly schemaVersion: string;
  readonly logicalName: string;
  readonly version: number;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly status: ArtifactVersionStatus;
  readonly producer: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly snapshotRevisionId: string;
    readonly aiMemberId: string;
  };
  readonly createdAt: string;
}

export interface ArtifactRegistry {
  readonly registerVersion: (input: {
    readonly projectId: string;
    readonly type: string;
    readonly schemaVersion: string;
    readonly logicalName: string;
    readonly content: string | Uint8Array;
    readonly status: ArtifactVersionStatus;
    readonly producer: ArtifactVersionView["producer"];
    readonly inputVersionIds?: readonly string[];
  }) => ArtifactVersionView;
  readonly registerVersionInTransaction: (
    input: Parameters<ArtifactRegistry["registerVersion"]>[0],
  ) => ArtifactVersionView;
  readonly listVersions: (projectId: string) => readonly ArtifactVersionView[];
  readonly listVersionsForRun: (
    runId: string,
  ) => readonly ArtifactVersionView[];
  readonly inspect: (versionId: string) => {
    readonly version: ArtifactVersionView;
    readonly inputs: readonly {
      readonly versionId: string;
      readonly relation: string;
    }[];
  };
  readonly setStatus: (input: {
    readonly versionId: string;
    readonly expectedStatus: ArtifactVersionStatus;
    readonly status: ArtifactVersionStatus;
  }) => ArtifactVersionView;
  readonly lineage: (
    versionId: string,
  ) => readonly { readonly versionId: string; readonly relation: string }[];
}

export class ArtifactRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRegistryError";
  }
}

const asStatus = (value: string): ArtifactVersionStatus => {
  if (
    !["draft", "produced", "accepted", "rejected", "superseded"].includes(value)
  ) {
    throw new ArtifactRegistryError(
      "ARTIFACT_STATUS_INVALID",
      `Artifact Version status ${value} is invalid.`,
    );
  }
  return value as ArtifactVersionStatus;
};

export const openArtifactRegistry = (
  database: DatabaseSync,
  companyDir: string,
): ArtifactRegistry => {
  const appendMutation = (input: {
    readonly action: string;
    readonly eventType: string;
    readonly version: ArtifactVersionView;
    readonly before?: unknown;
    readonly after: unknown;
    readonly createdAt: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at
         ) VALUES (?, ?, 'artifact-version', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.action,
        input.version.id,
        input.version.producer.runId,
        input.version.producer.nodeRunId,
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
        input.version.producer.runId,
        input.version.producer.nodeRunId,
        JSON.stringify(input.after),
        input.createdAt,
      );
  };
  const readVersion = (versionId: string): ArtifactVersionView => {
    const row = database
      .prepare(
        `SELECT artifact_versions.id AS id,
                artifact_versions.artifact_id AS artifactId,
                artifacts.project_id AS projectId,
                artifacts.type AS type,
                artifacts.schema_version AS schemaVersion,
                artifacts.logical_name AS logicalName,
                artifact_versions.version AS version,
                artifact_versions.content_ref AS contentRef,
                artifact_versions.content_hash AS contentHash,
                artifact_versions.byte_size AS byteSize,
                artifact_versions.status AS status,
                artifact_versions.producing_run_id AS runId,
                artifact_versions.producing_node_run_id AS nodeRunId,
                artifact_versions.producing_node_attempt_id AS nodeAttemptId,
                artifact_versions.snapshot_revision_id AS snapshotRevisionId,
                artifact_versions.ai_member_id AS aiMemberId,
                artifact_versions.created_at AS createdAt
           FROM artifact_versions
           JOIN artifacts ON artifacts.id = artifact_versions.artifact_id
          WHERE artifact_versions.id = ?`,
      )
      .get(versionId) as
      | {
          readonly id: string;
          readonly artifactId: string;
          readonly projectId: string;
          readonly type: string;
          readonly schemaVersion: string;
          readonly logicalName: string;
          readonly version: number;
          readonly contentRef: string;
          readonly contentHash: string;
          readonly byteSize: number;
          readonly status: string;
          readonly runId: string;
          readonly nodeRunId: string;
          readonly nodeAttemptId: string;
          readonly snapshotRevisionId: string;
          readonly aiMemberId: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new ArtifactRegistryError(
        "ARTIFACT_VERSION_NOT_FOUND",
        `Artifact Version ${versionId} was not found.`,
      );
    }
    return {
      ...row,
      version: Number(row.version),
      byteSize: Number(row.byteSize),
      status: asStatus(row.status),
      producer: {
        runId: row.runId,
        nodeRunId: row.nodeRunId,
        nodeAttemptId: row.nodeAttemptId,
        snapshotRevisionId: row.snapshotRevisionId,
        aiMemberId: row.aiMemberId,
      },
    };
  };

  const registerVersionInternal = (
    input: Parameters<ArtifactRegistry["registerVersion"]>[0],
    ownsTransaction: boolean,
  ): ArtifactVersionView => {
    if (
      !input.projectId.trim() ||
      !input.logicalName.trim() ||
      !input.type.trim()
    ) {
      throw new ArtifactRegistryError(
        "ARTIFACT_INPUT_INVALID",
        "Artifact project, type, and logical name are required.",
      );
    }
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const createdAt = new Date().toISOString();
    let finalPath: string | undefined;
    let temporaryPath: string | undefined;
    if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      const project = database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(input.projectId);
      if (!project) {
        throw new ArtifactRegistryError(
          "PROJECT_NOT_FOUND",
          `Active Project ${input.projectId} was not found.`,
        );
      }
      let artifact = database
        .prepare(
          `SELECT id FROM artifacts
            WHERE project_id = ? AND type = ? AND logical_name = ?`,
        )
        .get(input.projectId, input.type, input.logicalName) as
        | { readonly id: string }
        | undefined;
      if (!artifact) {
        artifact = { id: randomUUID() };
        database
          .prepare(
            `INSERT INTO artifacts(
               id, project_id, type, logical_name, status, schema_version, created_at
             ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            artifact.id,
            input.projectId,
            input.type,
            input.logicalName,
            input.schemaVersion,
            createdAt,
          );
      }
      const versionRow = database
        .prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifact_versions WHERE artifact_id = ?",
        )
        .get(artifact.id) as { readonly version: number };
      const version = Number(versionRow.version);
      const artifactDirectory = join(
        companyDir,
        ".sandcastle",
        "artifacts",
        artifact.id,
      );
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      finalPath = join(artifactDirectory, `${version}-${contentHash}.bin`);
      temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
      writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, finalPath);
      temporaryPath = undefined;

      const versionId = randomUUID();
      database
        .prepare(
          `INSERT INTO artifact_versions(
             id, artifact_id, version, content_ref, content_hash, byte_size,
             status, producing_run_id, producing_node_run_id,
             producing_node_attempt_id, snapshot_revision_id, ai_member_id,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          artifact.id,
          version,
          finalPath,
          contentHash,
          bytes.byteLength,
          input.status,
          input.producer.runId,
          input.producer.nodeRunId,
          input.producer.nodeAttemptId,
          input.producer.snapshotRevisionId,
          input.producer.aiMemberId,
          createdAt,
        );
      for (const inputVersionId of input.inputVersionIds ?? []) {
        const inputVersion = database
          .prepare(
            `SELECT artifact_versions.id
               FROM artifact_versions
               JOIN artifacts ON artifacts.id = artifact_versions.artifact_id
              WHERE artifact_versions.id = ? AND artifacts.project_id = ?`,
          )
          .get(inputVersionId, input.projectId);
        if (!inputVersion) {
          throw new ArtifactRegistryError(
            "ARTIFACT_INPUT_VERSION_INVALID",
            `Input Artifact Version ${inputVersionId} is not in Project ${input.projectId}.`,
          );
        }
        database
          .prepare(
            `INSERT INTO artifact_links(
               from_version_id, to_version_id, relation, created_at
             ) VALUES (?, ?, 'input', ?)`,
          )
          .run(versionId, inputVersionId, createdAt);
      }
      const versionView = readVersion(versionId);
      appendMutation({
        action: "artifact.version.register",
        eventType: "artifact.version.created",
        version: versionView,
        after: {
          artifactId: versionView.artifactId,
          versionId: versionView.id,
          version: versionView.version,
          type: versionView.type,
          schemaVersion: versionView.schemaVersion,
          status: versionView.status,
          contentHash: versionView.contentHash,
          byteSize: versionView.byteSize,
          inputVersionIds: [...(input.inputVersionIds ?? [])],
        },
        createdAt,
      });
      if (ownsTransaction) database.exec("COMMIT");
      return versionView;
    } catch (error) {
      if (ownsTransaction) database.exec("ROLLBACK");
      if (temporaryPath) unlinkSync(temporaryPath);
      if (finalPath) unlinkSync(finalPath);
      throw error;
    }
  };

  const registerVersion: ArtifactRegistry["registerVersion"] = (input) =>
    registerVersionInternal(input, true);
  const registerVersionInTransaction: ArtifactRegistry["registerVersionInTransaction"] =
    (input) => registerVersionInternal(input, false);

  const listVersions = (projectId: string): readonly ArtifactVersionView[] => {
    const rows = database
      .prepare(
        `SELECT artifact_versions.id
           FROM artifact_versions
           JOIN artifacts ON artifacts.id = artifact_versions.artifact_id
          WHERE artifacts.project_id = ?
          ORDER BY artifact_versions.version, artifact_versions.id`,
      )
      .all(projectId) as Array<{ readonly id: string }>;
    return rows.map((row) => readVersion(row.id));
  };

  const listVersionsForRun = (
    runId: string,
  ): readonly ArtifactVersionView[] => {
    const rows = database
      .prepare(
        `SELECT id FROM artifact_versions
          WHERE producing_run_id = ?
          ORDER BY version, id`,
      )
      .all(runId) as Array<{ readonly id: string }>;
    return rows.map((row) => readVersion(row.id));
  };

  const setStatus = (input: {
    readonly versionId: string;
    readonly expectedStatus: ArtifactVersionStatus;
    readonly status: ArtifactVersionStatus;
  }): ArtifactVersionView => {
    const current = readVersion(input.versionId);
    const allowed = new Map<
      ArtifactVersionStatus,
      readonly ArtifactVersionStatus[]
    >([
      ["draft", ["produced", "rejected"]],
      ["produced", ["accepted", "rejected", "superseded"]],
      ["accepted", ["superseded"]],
      ["rejected", ["superseded"]],
      ["superseded", []],
    ]);
    if (
      current.status !== input.expectedStatus ||
      !allowed.get(current.status)?.includes(input.status)
    ) {
      throw new ArtifactRegistryError(
        "ARTIFACT_STATUS_TRANSITION_INVALID",
        `Artifact Version ${input.versionId} cannot transition from ${current.status} to ${input.status}.`,
      );
    }
    const createdAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const updated = database
        .prepare(
          "UPDATE artifact_versions SET status = ? WHERE id = ? AND status = ?",
        )
        .run(input.status, input.versionId, input.expectedStatus);
      if (Number(updated.changes) !== 1) {
        throw new ArtifactRegistryError(
          "ARTIFACT_STATUS_TRANSITION_INVALID",
          `Artifact Version ${input.versionId} changed before its status transition.`,
        );
      }
      const next = readVersion(input.versionId);
      appendMutation({
        action: "artifact.version.status",
        eventType: "artifact.version.status.changed",
        version: next,
        before: { status: current.status },
        after: { versionId: next.id, status: next.status },
        createdAt,
      });
      database.exec("COMMIT");
      return next;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const lineage = (
    versionId: string,
  ): readonly { readonly versionId: string; readonly relation: string }[] =>
    (
      database
        .prepare(
          `SELECT to_version_id AS versionId, relation
             FROM artifact_links
            WHERE from_version_id = ?
            ORDER BY created_at, to_version_id`,
        )
        .all(versionId) as Array<{
        readonly versionId: string;
        readonly relation: string;
      }>
    ).map((row) => ({ ...row }));

  return {
    registerVersion,
    registerVersionInTransaction,
    listVersions,
    listVersionsForRun,
    setStatus,
    lineage,
    inspect: (versionId) => ({
      version: readVersion(versionId),
      inputs: lineage(versionId),
    }),
  };
};
