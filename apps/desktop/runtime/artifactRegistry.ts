import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pipelineHash } from "./pipeline/canonicalPipeline.js";
import type { RuntimeEvents } from "./events/subscription.js";

export type ArtifactVersionStatus =
  | "draft"
  | "produced"
  | "accepted"
  | "rejected"
  | "superseded";

export type ArtifactContentKind =
  | "managed-file"
  | "repository-object"
  | "external-reference";

export type ArtifactIntegrityStatus = "verified" | "unavailable" | "failed";

export type ArtifactLifecycle = "finalized" | "superseded";

export interface ArtifactProducerContext {
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly aiMemberId: string;
  readonly positionId?: string;
  readonly sessionId?: string;
  readonly workPackageId?: string;
  readonly interactionTurnId?: string;
}

export type ArtifactRegistrationContent =
  | {
      readonly kind: "managed-file";
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    }
  | {
      readonly kind: "repository-object";
      readonly repositoryRef: string;
      readonly commitId: string;
      readonly objectId: string;
      readonly objectKind: "commit" | "tree" | "blob" | "tag";
    }
  | {
      readonly kind: "external-reference";
      readonly provider: string;
      readonly namespace: string;
      readonly objectId: string;
      readonly providerVersion?: string;
      readonly etag?: string;
      readonly digest?: string;
      readonly retrievalRef: string;
      readonly verifierMetadata?: unknown;
    };

export interface ArtifactRegistrationView {
  readonly registrationId: string;
  readonly versionId: string;
  readonly artifactId: string;
  readonly projectId: string;
  readonly version: number;
  readonly contentKind: ArtifactContentKind;
  readonly journalState:
    | "prepared"
    | "written"
    | "renamed"
    | "finalized"
    | "failed";
  readonly finalized: boolean;
}

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
  readonly contentKind: ArtifactContentKind;
  readonly integrityStatus: ArtifactIntegrityStatus;
  readonly lifecycle: ArtifactLifecycle;
  readonly identityHash: string;
  readonly integrityDescriptor: unknown;
  readonly status: ArtifactVersionStatus;
  readonly producer: Omit<ArtifactProducerContext, "projectId">;
  readonly createdAt: string;
}

export interface ArtifactRegistry {
  readonly register: (input: {
    readonly projectId: string;
    readonly type: string;
    readonly schemaVersion: string;
    readonly logicalName: string;
    readonly content: ArtifactRegistrationContent;
    readonly producer: ArtifactProducerContext;
    readonly inputVersionIds?: readonly string[];
  }) => ArtifactRegistrationView;
  readonly registerInTransaction: (
    input: Parameters<ArtifactRegistry["register"]>[0],
  ) => ArtifactRegistrationView;
  readonly completeManagedFileWrite: (input: {
    readonly registrationId: string;
    readonly bytes: Uint8Array;
  }) => ArtifactRegistrationView;
  readonly finalize: (input: {
    readonly registrationId: string;
  }) => ArtifactVersionView;
  readonly finalizeInTransaction: (
    input: Parameters<ArtifactRegistry["finalize"]>[0],
  ) => ArtifactVersionView;
  readonly supersede: (input: {
    readonly versionId: string;
    readonly supersededByVersionId: string;
  }) => ArtifactVersionView;
  readonly supersedeInTransaction: (
    input: Parameters<ArtifactRegistry["supersede"]>[0],
  ) => ArtifactVersionView;
  readonly verify: (versionId: string) => ArtifactIntegrityStatus;
  readonly readContent: (versionId: string) => Buffer;
  readonly reconcile: () => void;
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
  readonly inspectLineage: (versionId: string) => {
    readonly rootVersionId: string;
    readonly versions: readonly ArtifactVersionView[];
    readonly edges: readonly {
      readonly fromVersionId: string;
      readonly toVersionId: string;
      readonly relation: string;
    }[];
  };
}

export type ManagedFileCrashPoint =
  | "after-prepared"
  | "after-temp-fsync"
  | "after-written"
  | "after-rename"
  | "after-directory-fsync"
  | "after-renamed";

export interface ArtifactRegistryOptions {
  readonly managedFileCrash?: (
    point: ManagedFileCrashPoint,
    registrationId: string,
  ) => void;
  readonly externalVerifier?: (
    input: Extract<ArtifactRegistrationContent, { kind: "external-reference" }>,
  ) => {
    readonly status: ArtifactIntegrityStatus;
    readonly verifierMetadata: unknown;
    readonly evidence: unknown;
  };
  readonly events?: Pick<RuntimeEvents, "append">;
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
  options: ArtifactRegistryOptions = {},
): ArtifactRegistry => {
  const artifactRoot = join(companyDir, ".sandcastle", "artifacts");
  const canonicalJson = (value: unknown): string =>
    JSON.stringify(
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, entry]) => entry !== undefined)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, entry]),
          )
        : value,
    );
  const hash = (value: unknown): string => pipelineHash(value);
  const parseJson = (value: string): unknown => JSON.parse(value);
  const safeContentRef = (
    value: string,
    artifactId: string,
    version: number,
    contentKind: ArtifactContentKind,
  ): string => {
    if (contentKind !== "managed-file") return value;
    const root = resolve(artifactRoot);
    const candidate = resolve(
      isAbsolute(value) ? value : join(companyDir, value),
    );
    const relativeValue = relative(root, candidate);
    return !relativeValue.startsWith("..") && !isAbsolute(relativeValue)
      ? relative(companyDir, candidate)
      : `artifact:${artifactId}/v${version}`;
  };
  const controlledManagedPath = (value: string): string => {
    const root = resolve(artifactRoot);
    const candidate = resolve(
      isAbsolute(value) ? value : join(companyDir, value),
    );
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      throw new ArtifactRegistryError(
        "ARTIFACT_STORAGE_REF_INVALID",
        "Managed Artifact storage reference is outside the Company Directory.",
      );
    }
    return candidate;
  };
  const safeIntegrityDescriptor = (
    contentKind: ArtifactContentKind,
    value: string,
  ): unknown => {
    const descriptor = parseJson(value) as Record<string, unknown>;
    if (contentKind === "repository-object") {
      const { repositoryRef, ...safe } = descriptor;
      return {
        ...safe,
        repositoryKey:
          typeof repositoryRef === "string"
            ? hash(repositoryRef).slice(0, 16)
            : undefined,
      };
    }
    if (contentKind === "external-reference") {
      const { retrievalRef: _retrievalRef, verification, ...safe } = descriptor;
      return {
        ...safe,
        verifierMetadata:
          verification && typeof verification === "object"
            ? (verification as { readonly verifierMetadata?: unknown })
                .verifierMetadata
            : descriptor.verifierMetadata,
      };
    }
    return descriptor;
  };
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
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, 'artifact-version', ?, ?, ?, ?, ?, ?,
           (SELECT command_id FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT actor_type FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT actor_id FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT authenticated_by FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1)
         )`,
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
    const payload = {
      ...(typeof input.after === "object" && input.after !== null
        ? input.after
        : { value: input.after }),
      artifactId: input.version.artifactId,
      artifactVersionId: input.version.id,
    };
    const scope = {
      companyId: "company",
      projectId: input.version.projectId,
      artifactId: input.version.artifactId,
      artifactVersionId: input.version.id,
      ...(input.version.producer.runId
        ? { runId: input.version.producer.runId }
        : {}),
      ...(input.version.producer.nodeRunId
        ? { nodeRunId: input.version.producer.nodeRunId }
        : {}),
      ...(input.version.producer.nodeAttemptId
        ? { nodeAttemptId: input.version.producer.nodeAttemptId }
        : {}),
      ...(input.version.producer.sessionId
        ? { sessionId: input.version.producer.sessionId }
        : {}),
      ...(input.version.producer.interactionTurnId
        ? { interactionTurnId: input.version.producer.interactionTurnId }
        : {}),
    };
    if (options.events) {
      options.events.append({
        type: input.eventType,
        scope,
        payload,
        timestamp: input.createdAt,
      });
    } else {
      database
        .prepare(
          `INSERT INTO runtime_event_outbox(
             event_id, type, registry_version, event_schema_version,
             company_id, project_id, run_id, node_run_id, scope_json,
             payload_json, created_at
           ) VALUES (?, ?, 1, 1, 'company', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.eventType,
          input.version.projectId,
          input.version.producer.runId || null,
          input.version.producer.nodeRunId || null,
          JSON.stringify(scope),
          JSON.stringify(payload),
          input.createdAt,
        );
    }
  };
  const appendRegistrationMutation = (input: {
    readonly registrationId: string;
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly projectId: string;
    readonly contentKind: ArtifactContentKind;
    readonly producer: ArtifactProducerContext;
    readonly createdAt: string;
  }): void => {
    const payload = {
      registrationId: input.registrationId,
      artifactId: input.artifactId,
      artifactVersionId: input.artifactVersionId,
      contentKind: input.contentKind,
    };
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, 'artifact.version.register', 'artifact-registration', ?, ?, ?, NULL, ?, ?,
           (SELECT command_id FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT actor_type FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT actor_id FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT authenticated_by FROM runtime_unit_of_work_context WHERE slot = 1),
           (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1)
         )`,
      )
      .run(
        randomUUID(),
        input.registrationId,
        input.producer.runId,
        input.producer.nodeRunId,
        JSON.stringify(payload),
        input.createdAt,
      );
    options.events?.append({
      type: "artifact.registered",
      scope: {
        companyId: "company",
        projectId: input.projectId,
        artifactId: input.artifactId,
        artifactVersionId: input.artifactVersionId,
        runId: input.producer.runId,
        nodeRunId: input.producer.nodeRunId,
        nodeAttemptId: input.producer.nodeAttemptId,
        ...(input.producer.sessionId
          ? { sessionId: input.producer.sessionId }
          : {}),
        ...(input.producer.interactionTurnId
          ? { interactionTurnId: input.producer.interactionTurnId }
          : {}),
      },
      payload,
      timestamp: input.createdAt,
    });
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
                artifact_versions.content_kind AS contentKind,
                artifact_versions.identity_hash AS identityHash,
                artifact_versions.producer_context_json AS producerContextJson,
                artifact_versions.integrity_descriptor_json AS integrityDescriptorJson,
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
          readonly contentKind: ArtifactContentKind;
          readonly identityHash: string;
          readonly producerContextJson: string;
          readonly integrityDescriptorJson: string;
          readonly status: string;
          readonly runId: string | null;
          readonly nodeRunId: string | null;
          readonly nodeAttemptId: string | null;
          readonly snapshotRevisionId: string | null;
          readonly aiMemberId: string | null;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new ArtifactRegistryError(
        "ARTIFACT_VERSION_NOT_FOUND",
        `Artifact Version ${versionId} was not found.`,
      );
    }
    const latestIntegrity = database
      .prepare(
        `SELECT status
           FROM artifact_integrity_observations
          WHERE artifact_version_id = ?
       ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get(versionId) as
      | { readonly status: ArtifactIntegrityStatus }
      | undefined;
    const producerContext = parseJson(row.producerContextJson) as Record<
      string,
      unknown
    >;
    const superseded = database
      .prepare(
        "SELECT 1 FROM artifact_supersessions WHERE superseded_version_id = ?",
      )
      .get(versionId);
    return {
      id: row.id,
      artifactId: row.artifactId,
      projectId: row.projectId,
      type: row.type,
      schemaVersion: row.schemaVersion,
      logicalName: row.logicalName,
      version: Number(row.version),
      contentRef: safeContentRef(
        row.contentRef,
        row.artifactId,
        Number(row.version),
        row.contentKind,
      ),
      contentHash: row.contentHash,
      byteSize: Number(row.byteSize),
      contentKind: row.contentKind,
      integrityStatus: latestIntegrity?.status ?? "verified",
      lifecycle: superseded ? "superseded" : "finalized",
      identityHash: row.identityHash,
      integrityDescriptor: safeIntegrityDescriptor(
        row.contentKind,
        row.integrityDescriptorJson,
      ),
      status: asStatus(row.status),
      producer: {
        runId: String(producerContext.runId ?? row.runId ?? ""),
        nodeRunId: String(producerContext.nodeRunId ?? row.nodeRunId ?? ""),
        nodeAttemptId: String(
          producerContext.nodeAttemptId ?? row.nodeAttemptId ?? "",
        ),
        snapshotRevisionId: String(
          producerContext.snapshotRevisionId ?? row.snapshotRevisionId ?? "",
        ),
        aiMemberId: String(producerContext.aiMemberId ?? row.aiMemberId ?? ""),
        ...(typeof producerContext.positionId === "string"
          ? { positionId: producerContext.positionId }
          : {}),
        ...(typeof producerContext.sessionId === "string"
          ? { sessionId: producerContext.sessionId }
          : {}),
        ...(typeof producerContext.workPackageId === "string"
          ? { workPackageId: producerContext.workPackageId }
          : {}),
        ...(typeof producerContext.interactionTurnId === "string"
          ? { interactionTurnId: producerContext.interactionTurnId }
          : {}),
      },
      createdAt: row.createdAt,
    };
  };

  const readRegistration = (
    registrationId: string,
  ): ArtifactRegistrationView => {
    const row = database
      .prepare(
        `SELECT r.id AS registrationId,
                r.version_id AS versionId,
                r.artifact_id AS artifactId,
                r.project_id AS projectId,
                r.version AS version,
                r.content_kind AS contentKind,
                CASE
                  WHEN j.state IS NULL AND r.state = 'ready' THEN 'renamed'
                  ELSE COALESCE(j.state, 'finalized')
                END AS journalState,
                r.state AS state
           FROM artifact_registrations r
      LEFT JOIN artifact_write_journal j ON j.registration_id = r.id
          WHERE r.id = ?`,
      )
      .get(registrationId) as
      | {
          readonly registrationId: string;
          readonly versionId: string;
          readonly artifactId: string;
          readonly projectId: string;
          readonly version: number;
          readonly contentKind: ArtifactContentKind;
          readonly journalState: ArtifactRegistrationView["journalState"];
          readonly state: string;
        }
      | undefined;
    if (!row) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REGISTRATION_NOT_FOUND",
        `Artifact registration ${registrationId} was not found.`,
      );
    }
    return {
      registrationId: row.registrationId,
      versionId: row.versionId,
      artifactId: row.artifactId,
      projectId: row.projectId,
      version: Number(row.version),
      contentKind: row.contentKind,
      journalState: row.journalState,
      finalized: row.state === "finalized",
    };
  };

  const validateProject = (projectId: string): void => {
    if (
      !database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(projectId)
    ) {
      throw new ArtifactRegistryError(
        "PROJECT_NOT_FOUND",
        `Active Project ${projectId} was not found.`,
      );
    }
  };

  const validateRepositoryReference = (
    projectId: string,
    repositoryRef: string,
  ): void => {
    const configured = (
      database
        .prepare(
          `SELECT repository_ref AS repositoryRef
             FROM project_repository_references
            WHERE project_id = ?`,
        )
        .all(projectId) as Array<{ readonly repositoryRef: string }>
    ).some(
      (reference) =>
        resolve(reference.repositoryRef) === resolve(repositoryRef),
    );
    if (!configured) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REPOSITORY_NOT_REGISTERED",
        `Repository object source is not registered on Project ${projectId}.`,
      );
    }
  };

  const artifactFor = (input: {
    readonly projectId: string;
    readonly type: string;
    readonly logicalName: string;
    readonly schemaVersion: string;
    readonly createdAt: string;
  }): { readonly id: string } => {
    const existing = database
      .prepare(
        `SELECT id FROM artifacts
          WHERE project_id = ? AND type = ? AND logical_name = ?`,
      )
      .get(input.projectId, input.type, input.logicalName) as
      | { readonly id: string }
      | undefined;
    if (existing) return existing;
    const artifact = { id: randomUUID() };
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
        input.createdAt,
      );
    return artifact;
  };

  const nextVersion = (artifactId: string): number => {
    const row = database
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM (
             SELECT version FROM artifact_versions WHERE artifact_id = ?
             UNION ALL
             SELECT version FROM artifact_registrations WHERE artifact_id = ?
           )`,
      )
      .get(artifactId, artifactId) as { readonly version: number };
    return Number(row.version);
  };

  const producerJson = (producer: ArtifactProducerContext): string =>
    canonicalJson({
      projectId: producer.projectId,
      runId: producer.runId,
      snapshotRevisionId: producer.snapshotRevisionId,
      nodeRunId: producer.nodeRunId,
      nodeAttemptId: producer.nodeAttemptId,
      aiMemberId: producer.aiMemberId,
      positionId: producer.positionId,
      sessionId: producer.sessionId,
      workPackageId: producer.workPackageId,
      interactionTurnId: producer.interactionTurnId,
    });

  const validateProducer = (
    producer: ArtifactProducerContext,
    projectId: string,
  ): void => {
    if (
      producer.projectId !== projectId ||
      !producer.runId.trim() ||
      !producer.snapshotRevisionId.trim() ||
      !producer.nodeRunId.trim() ||
      !producer.nodeAttemptId.trim() ||
      !producer.aiMemberId.trim()
    ) {
      throw new ArtifactRegistryError(
        "ARTIFACT_PRODUCER_INVALID",
        "Artifact producer context is incomplete or belongs to another Project.",
      );
    }
  };

  const gitOutput = (
    repositoryRef: string,
    args: readonly string[],
  ): string => {
    try {
      return execFileSync("git", ["-C", repositoryRef, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REPOSITORY_UNAVAILABLE",
        `Repository object verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const repositoryDescriptor = (
    content: Extract<
      ArtifactRegistrationContent,
      { kind: "repository-object" }
    >,
  ) => {
    const commit = gitOutput(content.repositoryRef, [
      "rev-parse",
      "--verify",
      `${content.commitId}^{commit}`,
    ]);
    if (commit !== content.commitId) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REPOSITORY_IDENTITY_MISMATCH",
        "Repository commit identity did not resolve to the requested commit.",
      );
    }
    const objectKind = gitOutput(content.repositoryRef, [
      "cat-file",
      "-t",
      content.objectId,
    ]);
    if (objectKind !== content.objectKind) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REPOSITORY_IDENTITY_MISMATCH",
        `Repository object kind ${objectKind} does not match ${content.objectKind}.`,
      );
    }
    const reachable = gitOutput(content.repositoryRef, [
      "rev-list",
      "--objects",
      content.commitId,
    ]).split("\n");
    if (!reachable.some((line) => line.split(" ")[0] === content.objectId)) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REPOSITORY_IDENTITY_MISMATCH",
        "Repository object is not reachable from the requested commit.",
      );
    }
    const raw = execFileSync(
      "git",
      [
        "-C",
        content.repositoryRef,
        "cat-file",
        content.objectKind,
        content.objectId,
      ],
      { encoding: "buffer" },
    );
    return {
      kind: "repository-object" as const,
      repositoryRef: content.repositoryRef,
      commitId: content.commitId,
      objectId: content.objectId,
      objectKind: content.objectKind,
      contentHash: createHash("sha256").update(raw).digest("hex"),
      byteSize: raw.byteLength,
      bytes: raw,
    };
  };

  const externalDescriptor = (
    content: Extract<
      ArtifactRegistrationContent,
      { kind: "external-reference" }
    >,
  ) => {
    const canonical = {
      kind: "external-reference" as const,
      provider: content.provider,
      namespace: content.namespace,
      objectId: content.objectId,
      providerVersion: content.providerVersion,
      etag: content.etag,
      digest: content.digest,
      retrievalRef: content.retrievalRef,
    };
    const verification = options.externalVerifier?.(content) ?? {
      status: "unavailable" as const,
      verifierMetadata: { verifier: "not-configured" },
      evidence: { reason: "external verifier is not configured" },
    };
    return {
      canonical,
      verification,
      contentHash:
        content.digest &&
        /^[a-f0-9]{64}$/i.test(content.digest.replace(/^sha256:/, ""))
          ? content.digest.replace(/^sha256:/, "")
          : hash(canonical),
      byteSize: 0,
    };
  };

  const registerArtifactInternal = (
    input: Parameters<ArtifactRegistry["register"]>[0],
    ownsTransaction: boolean,
    advanceFile: boolean,
  ): ArtifactRegistrationView => {
    if (!input.type.trim() || !input.logicalName.trim()) {
      throw new ArtifactRegistryError(
        "ARTIFACT_INPUT_INVALID",
        "Artifact type and logical name are required.",
      );
    }
    validateProject(input.projectId);
    validateProducer(input.producer, input.projectId);
    if (input.content.kind === "repository-object") {
      validateRepositoryReference(input.projectId, input.content.repositoryRef);
    }
    const repository =
      input.content.kind === "repository-object"
        ? repositoryDescriptor(input.content)
        : undefined;
    const external =
      input.content.kind === "external-reference"
        ? externalDescriptor(input.content)
        : undefined;
    const bytes =
      input.content.kind === "managed-file"
        ? Buffer.from(input.content.bytes)
        : repository?.bytes;
    const contentHash =
      input.content.kind === "managed-file"
        ? createHash("sha256").update(bytes!).digest("hex")
        : (repository?.contentHash ?? external!.contentHash);
    const byteSize =
      input.content.kind === "managed-file"
        ? bytes!.byteLength
        : (repository?.byteSize ?? external!.byteSize);
    const identity =
      input.content.kind === "managed-file"
        ? {
            kind: "managed-file" as const,
            contentHash,
            byteSize,
            mediaType: input.content.mediaType ?? "application/octet-stream",
          }
        : input.content.kind === "repository-object"
          ? {
              kind: "repository-object" as const,
              repositoryRef: input.content.repositoryRef,
              commitId: input.content.commitId,
              objectId: input.content.objectId,
              objectKind: input.content.objectKind,
            }
          : external!.canonical;
    const integrityDescriptor =
      input.content.kind === "managed-file"
        ? {
            algorithm: "sha256",
            digest: contentHash,
            byteSize,
            mediaType: input.content.mediaType ?? "application/octet-stream",
          }
        : input.content.kind === "repository-object"
          ? {
              repositoryRef: input.content.repositoryRef,
              commitId: input.content.commitId,
              objectId: input.content.objectId,
              objectKind: input.content.objectKind,
            }
          : {
              ...external!.canonical,
              verifierMetadata: input.content.verifierMetadata,
              verification: external!.verification,
            };
    const identityJson = canonicalJson(identity);
    const identityHash = hash(identity);
    const producerContextJson = producerJson(input.producer);
    const producerContextHash = hash(JSON.parse(producerContextJson));
    const now = new Date().toISOString();
    const registrationId = randomUUID();
    const versionId = randomUUID();
    let tempRef = "";
    let finalRef = "";
    let registration!: ArtifactRegistrationView;
    if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      const artifact = artifactFor({
        projectId: input.projectId,
        type: input.type,
        logicalName: input.logicalName,
        schemaVersion: input.schemaVersion,
        createdAt: now,
      });
      const existingRegistration = database
        .prepare(
          `SELECT id
             FROM artifact_registrations
            WHERE artifact_id = ?
              AND identity_hash = ?
              AND producer_context_hash = ?
              AND state <> 'failed'
         ORDER BY version
            LIMIT 1`,
        )
        .get(artifact.id, identityHash, producerContextHash) as
        | { readonly id: string }
        | undefined;
      if (existingRegistration) {
        if (ownsTransaction) database.exec("COMMIT");
        return readRegistration(existingRegistration.id);
      }
      const existing = database
        .prepare(
          `SELECT id, registration_id AS registrationId,
                  content_kind AS contentKind, version
             FROM artifact_versions
            WHERE artifact_id = ? AND identity_hash = ? AND producer_context_hash = ?
         ORDER BY version
            LIMIT 1`,
        )
        .get(artifact.id, identityHash, producerContextHash) as
        | {
            readonly id: string;
            readonly registrationId: string | null;
            readonly contentKind: ArtifactContentKind;
            readonly version: number;
          }
        | undefined;
      if (existing) {
        if (ownsTransaction) database.exec("COMMIT");
        return existing.registrationId
          ? readRegistration(existing.registrationId)
          : {
              registrationId: existing.id,
              versionId: existing.id,
              artifactId: artifact.id,
              projectId: input.projectId,
              version: Number(existing.version),
              contentKind: existing.contentKind,
              journalState: "finalized",
              finalized: true,
            };
      }
      const version = nextVersion(artifact.id);
      finalRef =
        input.content.kind === "managed-file"
          ? `.sandcastle/artifacts/${input.projectId}/${artifact.id}/v${version}/${versionId}.bin`
          : input.content.kind === "repository-object"
            ? `repository-object:${hash(input.content.repositoryRef).slice(0, 16)}/${input.content.objectId}`
            : `external-reference:${input.content.provider}/${input.content.namespace}/${input.content.objectId}`;
      tempRef = `${finalRef}.tmp-${registrationId}`;
      database
        .prepare(
          `INSERT INTO artifact_registrations(
             id, version_id, artifact_id, project_id, version, content_kind,
             canonical_identity_json, identity_hash, producer_context_json,
             producer_context_hash, lineage_json, integrity_descriptor_json,
             content_ref, content_hash, byte_size, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          registrationId,
          versionId,
          artifact.id,
          input.projectId,
          version,
          input.content.kind,
          identityJson,
          identityHash,
          producerContextJson,
          producerContextHash,
          JSON.stringify(input.inputVersionIds ?? []),
          JSON.stringify(integrityDescriptor),
          finalRef,
          contentHash,
          byteSize,
          input.content.kind === "managed-file" ? "registered" : "ready",
          now,
          now,
        );
      if (input.content.kind === "managed-file") {
        database
          .prepare(
            `INSERT INTO artifact_write_journal(
               registration_id, state, expected_hash, expected_size,
               temp_ref, final_ref, created_at, updated_at
             ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            registrationId,
            contentHash,
            byteSize,
            tempRef,
            finalRef,
            now,
            now,
          );
      }
      appendRegistrationMutation({
        registrationId,
        artifactId: artifact.id,
        artifactVersionId: versionId,
        projectId: input.projectId,
        contentKind: input.content.kind,
        producer: input.producer,
        createdAt: now,
      });
      if (ownsTransaction) database.exec("COMMIT");
      registration = readRegistration(registrationId);
    } catch (error) {
      if (ownsTransaction) database.exec("ROLLBACK");
      throw error;
    }
    if (!advanceFile || input.content.kind !== "managed-file") {
      return registration;
    }
    options.managedFileCrash?.("after-prepared", registration.registrationId);

    if (input.content.kind !== "managed-file")
      return readRegistration(registration.registrationId);
    const absoluteTemp = join(companyDir, tempRef);
    const absoluteFinal = join(companyDir, finalRef);
    mkdirSync(join(absoluteFinal, ".."), { recursive: true, mode: 0o700 });
    const fd = openSync(absoluteTemp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes!);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    options.managedFileCrash?.("after-temp-fsync", registration.registrationId);
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          "UPDATE artifact_write_journal SET state = 'written', updated_at = ? WHERE registration_id = ? AND state = 'prepared'",
        )
        .run(new Date().toISOString(), registration.registrationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    options.managedFileCrash?.("after-written", registration.registrationId);
    renameSync(absoluteTemp, absoluteFinal);
    options.managedFileCrash?.("after-rename", registration.registrationId);
    const dirFd = openSync(join(absoluteFinal, ".."), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    options.managedFileCrash?.(
      "after-directory-fsync",
      registration.registrationId,
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          "UPDATE artifact_write_journal SET state = 'renamed', updated_at = ? WHERE registration_id = ? AND state = 'written'",
        )
        .run(new Date().toISOString(), registration.registrationId);
      database
        .prepare(
          "UPDATE artifact_registrations SET state = 'ready', updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), registration.registrationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    options.managedFileCrash?.("after-renamed", registration.registrationId);
    return readRegistration(registration.registrationId);
  };

  const registerArtifact: ArtifactRegistry["register"] = (input) =>
    registerArtifactInternal(input, true, true);
  const registerArtifactInTransaction: ArtifactRegistry["registerInTransaction"] =
    (input) => registerArtifactInternal(input, false, false);
  const completeManagedFileWrite: ArtifactRegistry["completeManagedFileWrite"] =
    ({ registrationId, bytes }) => {
      const row = database
        .prepare(
          `SELECT j.state, j.expected_hash AS expectedHash,
                j.expected_size AS expectedSize, j.temp_ref AS tempRef,
                j.final_ref AS finalRef
           FROM artifact_write_journal j
          WHERE j.registration_id = ?`,
        )
        .get(registrationId) as
        | {
            readonly state: string;
            readonly expectedHash: string;
            readonly expectedSize: number;
            readonly tempRef: string;
            readonly finalRef: string;
          }
        | undefined;
      if (!row) return readRegistration(registrationId);
      if (row.state === "renamed" || row.state === "finalized") {
        return readRegistration(registrationId);
      }
      const expected = Buffer.from(bytes);
      const actualHash = createHash("sha256").update(expected).digest("hex");
      if (
        actualHash !== row.expectedHash ||
        expected.byteLength !== Number(row.expectedSize)
      ) {
        throw new ArtifactRegistryError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Managed Artifact ${registrationId} content does not match its journal.`,
        );
      }
      const absoluteTemp = join(companyDir, row.tempRef);
      const absoluteFinal = join(companyDir, row.finalRef);
      mkdirSync(join(absoluteFinal, ".."), { recursive: true, mode: 0o700 });
      if (!existsSync(absoluteTemp) && !existsSync(absoluteFinal)) {
        const fd = openSync(absoluteTemp, "wx", 0o600);
        try {
          writeFileSync(fd, expected);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      if (row.state === "prepared") {
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              "UPDATE artifact_write_journal SET state = 'written', updated_at = ? WHERE registration_id = ? AND state = 'prepared'",
            )
            .run(new Date().toISOString(), registrationId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      if (!existsSync(absoluteFinal)) renameSync(absoluteTemp, absoluteFinal);
      fsyncDirectory(join(absoluteFinal, ".."));
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            "UPDATE artifact_write_journal SET state = 'renamed', updated_at = ? WHERE registration_id = ?",
          )
          .run(new Date().toISOString(), registrationId);
        database
          .prepare(
            "UPDATE artifact_registrations SET state = 'ready', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), registrationId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return readRegistration(registrationId);
    };

  const linkLineage = (
    fromVersionId: string,
    toVersionId: string,
    relation: string,
    createdAt: string,
  ): void => {
    if (
      !database
        .prepare("SELECT id FROM artifact_versions WHERE id = ?")
        .get(fromVersionId) ||
      !database
        .prepare("SELECT id FROM artifact_versions WHERE id = ?")
        .get(toVersionId)
    ) {
      throw new ArtifactRegistryError(
        "ARTIFACT_LINEAGE_VERSION_NOT_FOUND",
        "Artifact lineage references an unknown Artifact Version.",
      );
    }
    const cycle = database
      .prepare(
        `WITH RECURSIVE ancestors(id) AS (
           SELECT to_version_id FROM artifact_links WHERE from_version_id = ?
           UNION
           SELECT artifact_links.to_version_id
             FROM artifact_links
             JOIN ancestors ON ancestors.id = artifact_links.from_version_id
        )
        SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
      )
      .get(toVersionId, fromVersionId);
    if (cycle || fromVersionId === toVersionId) {
      throw new ArtifactRegistryError(
        "ARTIFACT_LINEAGE_CYCLE",
        "Artifact lineage cannot contain a cycle.",
      );
    }
    database
      .prepare(
        `INSERT INTO artifact_links(
           from_version_id, to_version_id, relation, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(fromVersionId, toVersionId, relation, createdAt);
  };

  const finalizeArtifactInternal = (
    { registrationId }: Parameters<ArtifactRegistry["finalize"]>[0],
    ownsTransaction: boolean,
  ): ArtifactVersionView => {
    const registration = readRegistration(registrationId);
    if (registration.finalized) return readVersion(registration.versionId);
    const row = database
      .prepare(
        `SELECT r.version_id AS versionId,
                r.artifact_id AS artifactId,
                r.project_id AS projectId,
                r.version AS version,
                r.producer_context_json AS producerContextJson,
                r.canonical_identity_json AS canonicalIdentityJson,
                r.identity_hash AS identityHash,
                r.integrity_descriptor_json AS integrityDescriptorJson,
                r.content_ref AS contentRef,
                r.content_hash AS contentHash,
                r.byte_size AS byteSize,
                r.lineage_json AS lineageJson,
                j.state AS journalState, j.final_ref AS finalRef,
                j.expected_hash AS expectedHash, j.expected_size AS expectedSize
           FROM artifact_registrations r
      LEFT JOIN artifact_write_journal j ON j.registration_id = r.id
          WHERE r.id = ?`,
      )
      .get(registrationId) as
      | {
          readonly versionId: string;
          readonly artifactId: string;
          readonly projectId: string;
          readonly version: number;
          readonly producerContextJson: string;
          readonly canonicalIdentityJson: string;
          readonly identityHash: string;
          readonly integrityDescriptorJson: string;
          readonly contentRef: string;
          readonly contentHash: string;
          readonly byteSize: number;
          readonly lineageJson: string;
          readonly journalState: string | null;
          readonly finalRef: string | null;
          readonly expectedHash: string | null;
          readonly expectedSize: number | null;
        }
      | undefined;
    if (!row) {
      throw new ArtifactRegistryError(
        "ARTIFACT_REGISTRATION_NOT_FOUND",
        `Artifact registration ${registrationId} was not found.`,
      );
    }
    let file: Buffer | undefined;
    let actualHash = row.contentHash;
    let actualByteSize = Number(row.byteSize);
    let integrityStatus: ArtifactIntegrityStatus = "verified";
    if (row.journalState !== null) {
      if (
        row.journalState !== "renamed" ||
        !row.finalRef ||
        !row.expectedHash ||
        row.expectedSize === null
      ) {
        throw new ArtifactRegistryError(
          "ARTIFACT_NOT_READY",
          `Artifact registration ${registrationId} is not ready to finalize.`,
        );
      }
      const absoluteFinal = join(companyDir, row.finalRef);
      if (!existsSync(absoluteFinal)) {
        throw new ArtifactRegistryError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Managed Artifact final file ${registrationId} is missing.`,
        );
      }
      file = readFileSync(absoluteFinal);
      actualHash = createHash("sha256").update(file).digest("hex");
      if (
        actualHash !== row.expectedHash ||
        file.byteLength !== Number(row.expectedSize)
      ) {
        throw new ArtifactRegistryError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Managed Artifact ${registrationId} does not match its journal hash.`,
        );
      }
      actualByteSize = file.byteLength;
    } else {
      const descriptor = parseJson(row.integrityDescriptorJson) as {
        readonly verification?: {
          readonly status?: ArtifactIntegrityStatus;
          readonly verifierMetadata?: unknown;
          readonly evidence?: unknown;
        };
      };
      integrityStatus = descriptor.verification?.status ?? "verified";
    }
    const createdAt = new Date().toISOString();
    if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO artifact_versions(
             id, artifact_id, version, content_ref, content_hash, byte_size,
             status, producing_run_id, producing_node_run_id,
             producing_node_attempt_id, snapshot_revision_id, ai_member_id,
             created_at, content_kind, canonical_identity_json, identity_hash,
             producer_context_json, producer_context_hash, integrity_descriptor_json,
             registration_id, finalized_at
           )
             SELECT version_id, artifact_id, version, content_ref, content_hash,
                  byte_size, 'produced', NULL, NULL, NULL, NULL, NULL, created_at,
                  content_kind, canonical_identity_json, identity_hash,
                  producer_context_json, producer_context_hash,
                  integrity_descriptor_json, id, ?
             FROM artifact_registrations
            WHERE id = ?`,
        )
        .run(createdAt, registrationId);
      const producer = parseJson(row.producerContextJson) as {
        readonly runId?: string;
        readonly nodeRunId?: string;
      };
      database
        .prepare(
          "UPDATE artifact_write_journal SET state = 'finalized', updated_at = ? WHERE registration_id = ?",
        )
        .run(createdAt, registrationId);
      database
        .prepare(
          "UPDATE artifact_registrations SET state = 'finalized', finalized_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(createdAt, createdAt, registrationId);
      database
        .prepare(
          `INSERT INTO artifact_integrity_observations(
             id, artifact_version_id, status, verifier_metadata_json,
             evidence_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          row.versionId,
          integrityStatus,
          integrityStatus === "verified"
            ? JSON.stringify({ algorithm: "sha256" })
            : JSON.stringify(
                (
                  parseJson(row.integrityDescriptorJson) as {
                    readonly verification?: {
                      readonly verifierMetadata?: unknown;
                    };
                  }
                ).verification?.verifierMetadata ?? {},
              ),
          JSON.stringify(
            integrityStatus === "verified"
              ? { hash: actualHash, byteSize: actualByteSize }
              : ((
                  parseJson(row.integrityDescriptorJson) as {
                    readonly verification?: { readonly evidence?: unknown };
                  }
                ).verification?.evidence ?? {}),
          ),
          createdAt,
        );
      const version = readVersion(row.versionId);
      appendMutation({
        action: "artifact.version.finalize",
        eventType: "artifact.finalized",
        version,
        after: {
          artifactId: version.artifactId,
          artifactVersionId: version.id,
          contentKind: version.contentKind,
          integrityStatus: version.integrityStatus,
          ...(producer.runId ? { runId: producer.runId } : {}),
          ...(producer.nodeRunId ? { nodeRunId: producer.nodeRunId } : {}),
        },
        createdAt,
      });
      if (version.integrityStatus !== "verified") {
        const descriptor = parseJson(row.integrityDescriptorJson) as {
          readonly verification?: { readonly evidence?: unknown };
        };
        appendMutation({
          action: "artifact.integrity.failed",
          eventType: "artifact.integrity-failed",
          version,
          after: {
            artifactId: version.artifactId,
            artifactVersionId: version.id,
            contentKind: version.contentKind,
            integrityStatus: version.integrityStatus,
            evidence: descriptor.verification?.evidence ?? {},
          },
          createdAt,
        });
      }
      const inputVersionIds = parseJson(row.lineageJson) as string[];
      for (const inputVersionId of inputVersionIds) {
        if (inputVersionId === version.id) {
          throw new ArtifactRegistryError(
            "ARTIFACT_LINEAGE_CYCLE",
            "Artifact lineage cannot reference itself.",
          );
        }
        linkLineage(version.id, inputVersionId, "input", createdAt);
      }
      if (ownsTransaction) database.exec("COMMIT");
      return readVersion(version.id);
    } catch (error) {
      if (ownsTransaction) database.exec("ROLLBACK");
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: artifact_versions/.test(error.message)
      ) {
        return readVersion(row.versionId);
      }
      throw error;
    }
  };
  const finalizeArtifact: ArtifactRegistry["finalize"] = (input) =>
    finalizeArtifactInternal(input, true);

  const verifyArtifact = (versionId: string): ArtifactIntegrityStatus => {
    const row = database
      .prepare(
        `SELECT content_kind AS contentKind, content_ref AS contentRef,
                content_hash AS contentHash, byte_size AS byteSize,
                integrity_descriptor_json AS integrityDescriptorJson
           FROM artifact_versions
          WHERE id = ?`,
      )
      .get(versionId) as
      | {
          readonly contentKind: ArtifactContentKind;
          readonly contentRef: string;
          readonly contentHash: string;
          readonly byteSize: number;
          readonly integrityDescriptorJson: string;
        }
      | undefined;
    if (!row) {
      throw new ArtifactRegistryError(
        "ARTIFACT_VERSION_NOT_FOUND",
        `Artifact Version ${versionId} was not found.`,
      );
    }
    let status: ArtifactIntegrityStatus = "verified";
    let evidence: unknown;
    let verifierMetadata: unknown = {};
    if (row.contentKind === "managed-file") {
      const absolutePath = controlledManagedPath(row.contentRef);
      if (!existsSync(absolutePath)) {
        status = "failed";
        evidence = { code: "MANAGED_FILE_MISSING" };
      } else {
        const content = readFileSync(absolutePath);
        const actualHash = createHash("sha256").update(content).digest("hex");
        status =
          actualHash === row.contentHash &&
          content.byteLength === Number(row.byteSize)
            ? "verified"
            : "failed";
        evidence = { actualHash, byteSize: content.byteLength };
      }
    } else if (row.contentKind === "repository-object") {
      const descriptor = parseJson(row.integrityDescriptorJson) as Extract<
        ArtifactRegistrationContent,
        { kind: "repository-object" }
      >;
      try {
        const verified = repositoryDescriptor({
          kind: "repository-object",
          repositoryRef: descriptor.repositoryRef,
          commitId: descriptor.commitId,
          objectId: descriptor.objectId,
          objectKind: descriptor.objectKind,
        });
        status =
          verified.contentHash === row.contentHash &&
          verified.byteSize === Number(row.byteSize)
            ? "verified"
            : "failed";
        evidence = {
          commitId: verified.commitId,
          objectId: verified.objectId,
          contentHash: verified.contentHash,
        };
      } catch (error) {
        status =
          error instanceof ArtifactRegistryError &&
          error.code === "ARTIFACT_REPOSITORY_UNAVAILABLE"
            ? "unavailable"
            : "failed";
        evidence = {
          code:
            error instanceof ArtifactRegistryError
              ? error.code
              : "ARTIFACT_REPOSITORY_VERIFY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      const descriptor = parseJson(row.integrityDescriptorJson) as {
        readonly provider: string;
        readonly namespace: string;
        readonly objectId: string;
        readonly providerVersion?: string;
        readonly etag?: string;
        readonly digest?: string;
        readonly retrievalRef: string;
        readonly verifierMetadata?: unknown;
      };
      const verification = options.externalVerifier?.({
        kind: "external-reference",
        provider: descriptor.provider,
        namespace: descriptor.namespace,
        objectId: descriptor.objectId,
        providerVersion: descriptor.providerVersion,
        etag: descriptor.etag,
        digest: descriptor.digest,
        retrievalRef: descriptor.retrievalRef,
        verifierMetadata: descriptor.verifierMetadata,
      }) ?? {
        status: "unavailable" as const,
        verifierMetadata: { verifier: "not-configured" },
        evidence: { reason: "external verifier is not configured" },
      };
      status = verification.status;
      verifierMetadata = verification.verifierMetadata;
      evidence = verification.evidence;
    }
    const latest = readVersion(versionId).integrityStatus;
    if (latest !== status) {
      const observedAt = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO artifact_integrity_observations(
             id, artifact_version_id, status, verifier_metadata_json,
             evidence_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          versionId,
          status,
          JSON.stringify(verifierMetadata),
          JSON.stringify(evidence),
          observedAt,
        );
      if (status !== "verified") {
        const version = readVersion(versionId);
        appendMutation({
          action: "artifact.integrity.failed",
          eventType: "artifact.integrity-failed",
          version,
          before: { integrityStatus: latest },
          after: {
            artifactId: version.artifactId,
            artifactVersionId: version.id,
            contentKind: version.contentKind,
            integrityStatus: status,
            evidence,
          },
          createdAt: observedAt,
        });
      }
    }
    return status;
  };

  const readContent = (versionId: string): Buffer => {
    const version = readVersion(versionId);
    if (version.contentKind === "external-reference") {
      throw new ArtifactRegistryError(
        "ARTIFACT_CONTENT_UNREADABLE",
        `External Artifact Version ${versionId} has no Runtime-managed bytes.`,
      );
    }
    if (verifyArtifact(versionId) !== "verified") {
      throw new ArtifactRegistryError(
        "ARTIFACT_INTEGRITY_FAILED",
        `Artifact Version ${versionId} failed integrity verification.`,
      );
    }
    const row = database
      .prepare(
        `SELECT content_ref AS contentRef,
                integrity_descriptor_json AS integrityDescriptorJson
           FROM artifact_versions WHERE id = ?`,
      )
      .get(versionId) as {
      readonly contentRef: string;
      readonly integrityDescriptorJson: string;
    };
    if (version.contentKind === "repository-object") {
      const descriptor = parseJson(row.integrityDescriptorJson) as {
        readonly repositoryRef: string;
        readonly objectId: string;
        readonly objectKind: "commit" | "tree" | "blob" | "tag";
      };
      return execFileSync(
        "git",
        [
          "-C",
          descriptor.repositoryRef,
          "cat-file",
          descriptor.objectKind,
          descriptor.objectId,
        ],
        { encoding: "buffer" },
      );
    }
    return readFileSync(controlledManagedPath(row.contentRef));
  };

  const supersedeArtifactInternal = (
    input: Parameters<ArtifactRegistry["supersede"]>[0],
    ownsTransaction: boolean,
  ): ArtifactVersionView => {
    const current = readVersion(input.versionId);
    const replacement = readVersion(input.supersededByVersionId);
    if (current.artifactId !== replacement.artifactId) {
      throw new ArtifactRegistryError(
        "ARTIFACT_SUPERSEDE_INVALID",
        "Artifact Versions can only supersede versions of the same Artifact.",
      );
    }
    const createdAt = new Date().toISOString();
    if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      linkLineage(replacement.id, current.id, "supersedes", createdAt);
      database
        .prepare(
          `INSERT INTO artifact_supersessions(
             superseded_version_id, superseding_version_id, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(current.id, replacement.id, createdAt);
      appendMutation({
        action: "artifact.version.supersede",
        eventType: "artifact.superseded",
        version: replacement,
        before: { superseded: false },
        after: {
          artifactId: replacement.artifactId,
          artifactVersionId: replacement.id,
          supersededArtifactVersionId: current.id,
        },
        createdAt,
      });
      if (ownsTransaction) database.exec("COMMIT");
      return readVersion(current.id);
    } catch (error) {
      if (ownsTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };
  const supersedeArtifact: ArtifactRegistry["supersede"] = (input) =>
    supersedeArtifactInternal(input, true);

  const verifyManagedFile = (
    path: string,
    expectedHash: string,
    expectedSize: number,
  ): boolean => {
    if (!existsSync(path)) return false;
    const content = readFileSync(path);
    return (
      content.byteLength === expectedSize &&
      createHash("sha256").update(content).digest("hex") === expectedHash
    );
  };

  const fsyncDirectory = (path: string): void => {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const quarantine = (input: {
    readonly registrationId: string;
    readonly paths: readonly string[];
    readonly evidence: unknown;
  }): void => {
    const quarantineDir = join(artifactRoot, ".quarantine");
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    let quarantineRef: string | null = null;
    for (const path of input.paths) {
      if (!existsSync(path)) continue;
      const destination = join(
        quarantineDir,
        `${input.registrationId}-${randomUUID()}-${basename(path)}`,
      );
      renameSync(path, destination);
      quarantineRef ??= relative(companyDir, destination);
    }
    fsyncDirectory(quarantineDir);
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `UPDATE artifact_write_journal
              SET state = 'failed', quarantine_ref = ?,
                  reconcile_evidence_json = ?, updated_at = ?
            WHERE registration_id = ?`,
        )
        .run(
          quarantineRef,
          JSON.stringify(input.evidence),
          now,
          input.registrationId,
        );
      database
        .prepare(
          `UPDATE artifact_registrations
              SET state = 'failed', failure_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(JSON.stringify(input.evidence), now, input.registrationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const quarantineOrphanFiles = (): void => {
    if (!existsSync(artifactRoot)) return;
    const knownPaths = new Set(
      (
        database
          .prepare(
            `SELECT content_ref AS contentRef
               FROM artifact_versions
              WHERE content_kind = 'managed-file'
              UNION
             SELECT content_ref
               FROM artifact_registrations
              WHERE content_kind = 'managed-file'
              UNION
             SELECT temp_ref FROM artifact_write_journal
              UNION
             SELECT final_ref FROM artifact_write_journal`,
          )
          .all() as Array<{ readonly contentRef: string }>
      ).map((row) =>
        resolve(
          isAbsolute(row.contentRef)
            ? row.contentRef
            : join(companyDir, row.contentRef),
        ),
      ),
    );
    const quarantineDir = join(artifactRoot, ".quarantine");
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
      )) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (path !== quarantineDir) visit(path);
          continue;
        }
        files.push(path);
      }
    };
    visit(artifactRoot);
    const orphans = files.filter((path) => !knownPaths.has(resolve(path)));
    if (orphans.length === 0) return;
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const sourceDirectories = new Set<string>();
    for (const path of orphans) {
      const relativePath = relative(artifactRoot, path);
      const destination = join(
        quarantineDir,
        `orphan-${hash(relativePath)}-${basename(path)}`,
      );
      renameSync(path, destination);
      sourceDirectories.add(dirname(path));
    }
    for (const directory of sourceDirectories) fsyncDirectory(directory);
    fsyncDirectory(quarantineDir);
  };

  const reconcile = (): void => {
    const pending = database
      .prepare(
        `SELECT j.registration_id AS registrationId, j.state,
                j.expected_hash AS expectedHash,
                j.expected_size AS expectedSize,
                j.temp_ref AS tempRef, j.final_ref AS finalRef
           FROM artifact_write_journal j
          WHERE j.state IN ('prepared', 'written', 'renamed')
       ORDER BY j.created_at, j.registration_id`,
      )
      .all() as Array<{
      readonly registrationId: string;
      readonly state: "prepared" | "written" | "renamed";
      readonly expectedHash: string;
      readonly expectedSize: number;
      readonly tempRef: string;
      readonly finalRef: string;
    }>;
    for (const journal of pending) {
      const tempPath = join(companyDir, journal.tempRef);
      const finalPath = join(companyDir, journal.finalRef);
      const finalMatches = verifyManagedFile(
        finalPath,
        journal.expectedHash,
        Number(journal.expectedSize),
      );
      const tempMatches = verifyManagedFile(
        tempPath,
        journal.expectedHash,
        Number(journal.expectedSize),
      );
      if (existsSync(finalPath) && !finalMatches) {
        quarantine({
          registrationId: journal.registrationId,
          paths: [finalPath, tempPath],
          evidence: {
            action: "quarantine",
            reason: "final-hash-mismatch",
            priorState: journal.state,
          },
        });
        continue;
      }
      if (finalMatches) {
        database
          .prepare(
            `UPDATE artifact_write_journal
                SET state = 'renamed', reconcile_evidence_json = ?, updated_at = ?
              WHERE registration_id = ?`,
          )
          .run(
            JSON.stringify({
              action: "adopt-final",
              priorState: journal.state,
            }),
            new Date().toISOString(),
            journal.registrationId,
          );
        database
          .prepare(
            "UPDATE artifact_registrations SET state = 'ready', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), journal.registrationId);
        finalizeArtifact({ registrationId: journal.registrationId });
        continue;
      }
      if (existsSync(tempPath) && !tempMatches) {
        quarantine({
          registrationId: journal.registrationId,
          paths: [tempPath],
          evidence: {
            action: "quarantine",
            reason: "temp-hash-mismatch",
            priorState: journal.state,
          },
        });
        continue;
      }
      if (tempMatches) {
        mkdirSync(join(finalPath, ".."), { recursive: true, mode: 0o700 });
        renameSync(tempPath, finalPath);
        fsyncDirectory(join(finalPath, ".."));
        database
          .prepare(
            `UPDATE artifact_write_journal
                SET state = 'renamed', reconcile_evidence_json = ?, updated_at = ?
              WHERE registration_id = ?`,
          )
          .run(
            JSON.stringify({ action: "adopt-temp", priorState: journal.state }),
            new Date().toISOString(),
            journal.registrationId,
          );
        database
          .prepare(
            "UPDATE artifact_registrations SET state = 'ready', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), journal.registrationId);
        finalizeArtifact({ registrationId: journal.registrationId });
        continue;
      }
      quarantine({
        registrationId: journal.registrationId,
        paths: [],
        evidence: {
          action: "quarantine",
          reason: "journal-content-missing",
          priorState: journal.state,
        },
      });
    }
    quarantineOrphanFiles();
    const versions = database
      .prepare("SELECT id FROM artifact_versions ORDER BY created_at, id")
      .all() as Array<{ readonly id: string }>;
    for (const version of versions) verifyArtifact(version.id);
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
    const producerContext = {
      projectId: input.projectId,
      ...input.producer,
    };
    validateProducer(producerContext, input.projectId);
    const producerContextJson = producerJson(producerContext);
    const producerContextHash = createHash("sha256")
      .update(producerContextJson)
      .digest("hex");
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
             created_at, producer_context_json, producer_context_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          producerContextJson,
          producerContextHash,
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

  const inspectLineage: ArtifactRegistry["inspectLineage"] = (versionId) => {
    readVersion(versionId);
    const edges = database
      .prepare(
        `WITH RECURSIVE lineage(from_version_id, to_version_id, relation) AS (
           SELECT from_version_id, to_version_id, relation
             FROM artifact_links
            WHERE from_version_id = ?
           UNION
           SELECT links.from_version_id, links.to_version_id, links.relation
             FROM artifact_links links
             JOIN lineage ON lineage.to_version_id = links.from_version_id
        )
        SELECT from_version_id AS fromVersionId,
               to_version_id AS toVersionId,
               relation
          FROM lineage
      ORDER BY from_version_id, to_version_id, relation`,
      )
      .all(versionId) as Array<{
      readonly fromVersionId: string;
      readonly toVersionId: string;
      readonly relation: string;
    }>;
    const versionIds = new Set<string>([versionId]);
    for (const edge of edges) {
      versionIds.add(edge.fromVersionId);
      versionIds.add(edge.toVersionId);
    }
    return {
      rootVersionId: versionId,
      versions: [...versionIds].map(readVersion),
      edges,
    };
  };

  return {
    register: registerArtifact,
    registerInTransaction: registerArtifactInTransaction,
    completeManagedFileWrite,
    finalize: finalizeArtifact,
    finalizeInTransaction: (input) => finalizeArtifactInternal(input, false),
    supersede: supersedeArtifact,
    supersedeInTransaction: (input) => supersedeArtifactInternal(input, false),
    verify: verifyArtifact,
    readContent,
    reconcile,
    registerVersion,
    registerVersionInTransaction,
    listVersions,
    listVersionsForRun,
    setStatus,
    lineage,
    inspectLineage,
    inspect: (versionId) => ({
      version: readVersion(versionId),
      inputs: lineage(versionId),
    }),
  };
};
