import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvents } from "../events/subscription.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";

export class TestRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TestRuntimeError";
  }
}

export type TestCaseRevisionManifestInput = {
  readonly schemaVersion: 1;
  readonly ownerPositionId: string;
  readonly requirementIds: readonly string[];
  readonly workPackageVersions: readonly {
    readonly workPackageId: string;
    readonly workPackageVersionId: string;
    readonly manifestHash: string;
  }[];
  readonly preconditions: readonly string[];
  readonly uiActions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly target: string;
    readonly input?: unknown;
  }[];
  readonly assertions: readonly {
    readonly id: string;
    readonly ui: { readonly kind: string; readonly expected: unknown };
    readonly runtime: { readonly kind: string; readonly expected: unknown };
  }[];
  readonly fixture: {
    readonly id: string;
    readonly scriptHashes: readonly string[];
  };
  readonly evidencePolicy: {
    readonly retentionClass: "transient" | "standard" | "durable";
    readonly redactionProfile: string;
    readonly requiredKinds: readonly string[];
  };
  readonly cleanup: { readonly policy: string; readonly required: boolean };
};

export type TestCaseRevisionManifest = TestCaseRevisionManifestInput & {
  readonly testCaseId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly supersedesRevisionId: string | null;
};

export type TestCaseRevisionView = {
  readonly id: string;
  readonly testCaseId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly supersedesRevisionId: string | null;
  readonly manifest: TestCaseRevisionManifest;
  readonly manifestHash: string;
  readonly createdAt: string;
};

export type TestRunManifestInput = {
  readonly testRunId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly sessionId: string;
  readonly testCaseRevisions: readonly {
    readonly id: string;
    readonly hash: string;
  }[];
  readonly integrationAuthority: {
    readonly generationId: string;
    readonly manifestHash: string;
    readonly passAuthorityHash: string;
    readonly repositoryCommits: readonly {
      readonly repositoryReference: string;
      readonly commit: string;
    }[];
  };
  readonly build: {
    readonly artifactVersionId: string;
    readonly digest: string;
  };
  readonly executionProfile: { readonly id: string; readonly hash: string };
  readonly companyDirectoryFingerprint: string;
  readonly fixture: {
    readonly id: string;
    readonly scriptHashes: readonly string[];
  };
  readonly clock: { readonly instant: string; readonly seed: string };
  readonly environment: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
};

export type TestRunManifest = TestRunManifestInput & {
  readonly schemaVersion: 1;
  readonly coverageHash: string;
  readonly integrationCoverage: {
    readonly coverageId: string;
    readonly coverageNodeRunId: string;
    readonly coverageNodeAttemptId: string;
    readonly coverageHash: string;
    readonly packageAuthorities: readonly {
      readonly workPackageId: string;
      readonly workPackageVersionId: string;
      readonly authorityId: string;
      readonly qualityGateResultId: string;
      readonly sourceCommit: string;
      readonly diffHash: string;
    }[];
    readonly aggregateReviewId: string;
    readonly aggregateGateResultId: string;
    readonly aggregateInputHash: string;
    readonly evidenceRefs: readonly string[];
  };
};

export type TestAssertionCorrelation = {
  readonly commandId: string;
  readonly eventSequence: number;
  readonly queryAsOfSequence: number;
  readonly queryViewHash: string;
  readonly snapshotRevisionId: string;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly sessionId: string;
  readonly artifactVersionIds: readonly string[];
};

export type TestRunView = {
  readonly id: string;
  readonly requestId: string;
  readonly manifest: TestRunManifest;
  readonly manifestHash: string;
  readonly viewHash: string;
  readonly state:
    | "scheduled"
    | "running"
    | "reconciling"
    | "unknown"
    | "passed"
    | "failed"
    | "blocked"
    | "cancelled";
  readonly passAuthorityHash: string | null;
  readonly assertions: readonly {
    readonly id: string;
    readonly testCaseRevisionId: string;
    readonly assertionId: string;
    readonly required: boolean;
    readonly uiStatus: "passed" | "failed" | "missing" | "unknown";
    readonly runtimeStatus: "passed" | "failed" | "missing" | "unknown";
    readonly correlation: TestAssertionCorrelation;
    readonly resultHash: string;
  }[];
  readonly evidence: readonly TestEvidence[];
  readonly defects: readonly TestDefect[];
  readonly obligations: readonly {
    readonly id: string;
    readonly status: "open" | "closed";
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TestEvidence = {
  readonly id: string;
  readonly testRunId: string;
  readonly testCaseRevisionId: string | null;
  readonly assertionId: string | null;
  readonly kind:
    | "ui"
    | "runtime"
    | "screenshot"
    | "log"
    | "payload"
    | "receipt"
    | "cleanup";
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly artifactVersionId: string | null;
  readonly redactionProfile: string;
  readonly retentionClass: "transient" | "standard" | "durable";
  readonly locator: string | null;
  readonly metadata: unknown;
  readonly createdAt: string;
};

export type TestDefectResponsibility =
  | {
      readonly kind: "work-package";
      readonly workPackageId: string;
      readonly workPackageVersionId: string;
    }
  | {
      readonly kind: "contract";
      readonly contractId: string;
      readonly version: string;
      readonly producerApplicationId: string;
      readonly consumerApplicationId: string;
      readonly candidateWorkPackageVersionIds: readonly string[];
    }
  | {
      readonly kind: "aggregate";
      readonly candidateWorkPackageVersionIds: readonly string[];
    }
  | {
      readonly kind: "ui-runtime-contract";
      readonly owner: "ui" | "runtime" | "shared";
    }
  | {
      readonly kind: "unknown";
      readonly candidateWorkPackageVersionIds: readonly string[];
      readonly reason: string;
    };

export type TestDefect = {
  readonly id: string;
  readonly testRunId: string;
  readonly testCaseRevisionId: string;
  readonly assertionId: string | null;
  readonly integrationGenerationId: string;
  readonly responsibility: TestDefectResponsibility;
  readonly evidence: unknown;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
};

export type TestExecutionRequest = {
  readonly operationId: string;
  readonly operationKey: string;
  readonly testRunId: string;
  readonly requestHash: string;
  readonly input: unknown;
};

export type TestExecutionFact = {
  readonly state:
    | "not-started"
    | "accepted"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
  readonly providerReceipt?: unknown;
  readonly evidenceRef?: string;
  readonly result?: unknown;
};

export interface TestExecutionAdapter {
  readonly execute: (
    request: TestExecutionRequest,
  ) => TestExecutionFact | Promise<TestExecutionFact>;
  readonly reconcile: (
    request: TestExecutionRequest,
  ) => TestExecutionFact | Promise<TestExecutionFact>;
  readonly cancel?: (
    request: TestExecutionRequest,
  ) => TestExecutionFact | Promise<TestExecutionFact>;
}

export interface TestRuntime {
  readonly registerCaseRevision: (input: {
    readonly testCaseId: string;
    readonly revisionId: string;
    readonly projectId: string;
    readonly supersedesRevisionId?: string;
    readonly manifest: TestCaseRevisionManifestInput;
  }) => TestCaseRevisionView;
  readonly inspectCase: (testCaseId: string) => readonly TestCaseRevisionView[];
  readonly createRun: (input: TestRunManifestInput) => TestRunView;
  readonly inspect: (testRunId: string) => TestRunView;
  readonly execute: (input: {
    readonly testRunId: string;
    readonly operationId: string;
    readonly input: unknown;
    readonly adapter: TestExecutionAdapter;
    readonly failureInjection?: (
      point: "after-intent" | "after-effect",
    ) => void;
  }) => Promise<TestRunView>;
  readonly reconcile: (input: {
    readonly testRunId: string;
    readonly operationId: string;
    readonly adapter: TestExecutionAdapter;
  }) => Promise<TestRunView>;
  readonly cancel: (input: {
    readonly testRunId: string;
    readonly operationId: string;
    readonly adapter: TestExecutionAdapter;
  }) => Promise<TestRunView>;
  readonly recordAssertion: (input: {
    readonly testRunId: string;
    readonly testCaseRevisionId: string;
    readonly assertionId: string;
    readonly required?: boolean;
    readonly uiStatus: "passed" | "failed" | "missing" | "unknown";
    readonly runtimeStatus: "passed" | "failed" | "missing" | "unknown";
    readonly correlation: TestAssertionCorrelation;
  }) => TestRunView;
  readonly recordEvidence: (
    input: Omit<TestEvidence, "createdAt">,
  ) => TestRunView;
  readonly recordDefect: (input: {
    readonly id: string;
    readonly testRunId: string;
    readonly testCaseRevisionId: string;
    readonly assertionId?: string;
    readonly responsibility: TestDefectResponsibility;
    readonly evidence: unknown;
  }) => TestRunView;
  readonly closeDefect: (input: {
    readonly defectId: string;
    readonly resolutionId: string;
    readonly resolution: unknown;
  }) => TestRunView;
  readonly complete: (testRunId: string) => TestRunView;
  readonly downstreamAuthority: (testRunId: string) => {
    readonly testRunId: string;
    readonly manifestHash: string;
    readonly passAuthorityHash: string;
    readonly integrationAuthority: TestRunManifest["integrationAuthority"];
    readonly testCaseRevisions: TestRunManifest["testCaseRevisions"];
    readonly coverageHash: string;
    readonly build: TestRunManifest["build"];
    readonly snapshotRevisionId: string;
    readonly executionProfile: TestRunManifest["executionProfile"];
    readonly companyDirectoryFingerprint: string;
    readonly fixture: TestRunManifest["fixture"];
    readonly environment: TestRunManifest["environment"];
    readonly capabilities: TestRunManifest["capabilities"];
    readonly assertionResultHashes: readonly string[];
    readonly evidenceHashes: readonly string[];
    readonly openDefectIds: readonly [];
    readonly openObligationIds: readonly [];
  };
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
const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const sortedUnique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort();

const ensureHash = (value: string, label: string): void => {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new TestRuntimeError(
      "TEST_MANIFEST_INVALID",
      `${label} must be a SHA-256 hash.`,
    );
};

export const openTestRuntime = (
  database: DatabaseSync,
  options: {
    readonly integrationAuthority: {
      readonly readPassAuthority: (
        generationId: string,
      ) => IntegrationGenerationView;
    };
    readonly events?: Pick<RuntimeEvents, "append" | "latestSequence">;
    readonly clock?: () => Date;
  },
): TestRuntime => {
  const clock = options.clock ?? (() => new Date());
  const inTransaction = <Value>(operation: () => Value): Value => {
    const ownsTransaction =
      database
        .prepare(
          "SELECT 1 AS present FROM runtime_unit_of_work_context WHERE slot = 1",
        )
        .get() === undefined;
    if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      if (ownsTransaction) database.exec("COMMIT");
      return value;
    } catch (error) {
      if (ownsTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };
  const appendEvent = (input: {
    readonly type: string;
    readonly projectId: string;
    readonly runId?: string;
    readonly nodeRunId?: string;
    readonly testRunId?: string;
    readonly testCaseRevisionId?: string;
    readonly defectId?: string;
    readonly payload: unknown;
    readonly timestamp: string;
  }): void => {
    const context = database
      .prepare(
        "SELECT command_id AS commandId, actor_type AS actorType, actor_id AS actorId, authenticated_by AS authenticatedBy, consumer_id AS consumerId FROM runtime_unit_of_work_context WHERE slot = 1",
      )
      .get() as
      | {
          readonly commandId: string;
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
        }
      | undefined;
    if (context) {
      const entityId =
        input.defectId ??
        input.testRunId ??
        input.testCaseRevisionId ??
        input.projectId;
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.type,
          input.defectId
            ? "test-defect"
            : input.testRunId
              ? "test-run"
              : "test-case-revision",
          entityId,
          input.runId ?? null,
          input.nodeRunId ?? null,
          canonicalJson(input.payload),
          input.timestamp,
          context.commandId,
          context.actorType,
          context.actorId,
          context.authenticatedBy,
          context.consumerId,
        );
    }
    options.events?.append({
      type: input.type,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
        ...(input.testRunId ? { testRunId: input.testRunId } : {}),
        ...(input.testCaseRevisionId
          ? { testCaseRevisionId: input.testCaseRevisionId }
          : {}),
        ...(input.defectId ? { defectId: input.defectId } : {}),
      },
      payload: input.payload,
      timestamp: input.timestamp,
    });
  };

  const readCaseRevision = (revisionId: string): TestCaseRevisionView => {
    const row = database
      .prepare(
        `SELECT revisions.id, revisions.test_case_id AS testCaseId, cases.project_id AS projectId,
      revisions.revision, revisions.supersedes_revision_id AS supersedesRevisionId, revisions.manifest_json AS manifestJson,
      revisions.manifest_hash AS manifestHash, revisions.created_at AS createdAt
      FROM test_case_revisions AS revisions JOIN test_cases AS cases ON cases.id = revisions.test_case_id WHERE revisions.id = ?`,
      )
      .get(revisionId) as Record<string, unknown> | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_CASE_REVISION_NOT_FOUND",
        `Test Case revision ${revisionId} was not found.`,
      );
    return {
      id: String(row.id),
      testCaseId: String(row.testCaseId),
      projectId: String(row.projectId),
      revision: Number(row.revision),
      supersedesRevisionId: row.supersedesRevisionId
        ? String(row.supersedesRevisionId)
        : null,
      manifest: parseJson(String(row.manifestJson)),
      manifestHash: String(row.manifestHash),
      createdAt: String(row.createdAt),
    };
  };

  const registerCaseRevision: TestRuntime["registerCaseRevision"] = (input) => {
    const now = clock().toISOString();
    const existingById = database
      .prepare(
        "SELECT test_case_id AS testCaseId, revision, supersedes_revision_id AS supersedesRevisionId, manifest_hash AS manifestHash FROM test_case_revisions WHERE id = ?",
      )
      .get(input.revisionId) as
      | {
          readonly testCaseId: string;
          readonly revision: number;
          readonly supersedesRevisionId: string | null;
          readonly manifestHash: string;
        }
      | undefined;
    const previous = database
      .prepare(
        "SELECT id, revision FROM test_case_revisions WHERE test_case_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(input.testCaseId) as
      | { readonly id: string; readonly revision: number }
      | undefined;
    const revision = existingById
      ? Number(existingById.revision)
      : previous
        ? Number(previous.revision) + 1
        : 1;
    const supersedesRevisionId = existingById
      ? existingById.supersedesRevisionId
      : (input.supersedesRevisionId ?? previous?.id ?? null);
    if (
      !existingById &&
      supersedesRevisionId &&
      supersedesRevisionId !== previous?.id
    )
      throw new TestRuntimeError(
        "TEST_CASE_SUPERSESSION_CONFLICT",
        "A Test Case revision may supersede only the current immutable revision.",
      );
    const manifest: TestCaseRevisionManifest = {
      ...input.manifest,
      testCaseId: input.testCaseId,
      revisionId: input.revisionId,
      revision,
      supersedesRevisionId,
      requirementIds: sortedUnique(input.manifest.requirementIds),
      preconditions: sortedUnique(input.manifest.preconditions),
      assertions: [...input.manifest.assertions].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      workPackageVersions: [...input.manifest.workPackageVersions].sort(
        (a, b) => a.workPackageVersionId.localeCompare(b.workPackageVersionId),
      ),
      fixture: {
        ...input.manifest.fixture,
        scriptHashes: sortedUnique(input.manifest.fixture.scriptHashes),
      },
      evidencePolicy: {
        ...input.manifest.evidencePolicy,
        requiredKinds: sortedUnique(
          input.manifest.evidencePolicy.requiredKinds,
        ),
      },
    };
    const manifestHash = sha256(manifest);
    if (existingById) {
      if (
        existingById.testCaseId !== input.testCaseId ||
        existingById.manifestHash !== manifestHash
      )
        throw new TestRuntimeError(
          "TEST_CASE_REVISION_CONFLICT",
          `Test Case revision ${input.revisionId} already has different immutable input.`,
        );
      return readCaseRevision(input.revisionId);
    }
    inTransaction(() => {
      database
        .prepare(
          "INSERT OR IGNORE INTO test_cases(id, project_id, created_at) VALUES (?, ?, ?)",
        )
        .run(input.testCaseId, input.projectId, now);
      const owner = database
        .prepare("SELECT project_id AS projectId FROM test_cases WHERE id = ?")
        .get(input.testCaseId) as { readonly projectId: string };
      if (owner.projectId !== input.projectId)
        throw new TestRuntimeError(
          "TEST_CASE_PROJECT_CONFLICT",
          `Test Case ${input.testCaseId} belongs to another Project.`,
        );
      database
        .prepare(
          "INSERT INTO test_case_revisions(id, test_case_id, revision, supersedes_revision_id, manifest_json, manifest_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.revisionId,
          input.testCaseId,
          revision,
          supersedesRevisionId,
          canonicalJson(manifest),
          manifestHash,
          now,
        );
      appendEvent({
        type: "test.case.revised",
        projectId: input.projectId,
        testCaseRevisionId: input.revisionId,
        payload: {
          testCaseRevisionId: input.revisionId,
          manifestHash,
        },
        timestamp: now,
      });
    });
    return readCaseRevision(input.revisionId);
  };

  const inspectCase = (testCaseId: string): readonly TestCaseRevisionView[] => {
    const rows = database
      .prepare(
        "SELECT id FROM test_case_revisions WHERE test_case_id = ? ORDER BY revision, id",
      )
      .all(testCaseId) as Array<{ readonly id: string }>;
    return rows.map((row) => readCaseRevision(row.id));
  };

  const readRun = (testRunId: string): TestRunView => {
    const row = database
      .prepare(
        "SELECT request_id AS requestId, manifest_json AS manifestJson, manifest_hash AS manifestHash, state, pass_authority_hash AS passAuthorityHash, created_at AS createdAt, updated_at AS updatedAt FROM test_runs WHERE id = ?",
      )
      .get(testRunId) as Record<string, unknown> | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_RUN_NOT_FOUND",
        `Test Run ${testRunId} was not found.`,
      );
    const assertionRows = database
      .prepare(
        "SELECT id, test_case_revision_id AS testCaseRevisionId, assertion_id AS assertionId, required, ui_status AS uiStatus, runtime_status AS runtimeStatus, correlation_json AS correlationJson, result_hash AS resultHash FROM test_assertion_results WHERE test_run_id = ? ORDER BY test_case_revision_id, assertion_id",
      )
      .all(testRunId) as Array<Record<string, unknown>>;
    const evidenceRows = database
      .prepare(
        "SELECT id, test_case_revision_id AS testCaseRevisionId, assertion_id AS assertionId, kind, media_type AS mediaType, content_hash AS contentHash, byte_size AS byteSize, artifact_version_id AS artifactVersionId, redaction_profile AS redactionProfile, retention_class AS retentionClass, locator, metadata_json AS metadataJson, created_at AS createdAt FROM test_evidence WHERE test_run_id = ? ORDER BY created_at, id",
      )
      .all(testRunId) as Array<Record<string, unknown>>;
    const defectRows = database
      .prepare(
        "SELECT id, test_case_revision_id AS testCaseRevisionId, assertion_id AS assertionId, integration_generation_id AS integrationGenerationId, responsibility_json AS responsibilityJson, evidence_json AS evidenceJson, status, created_at AS createdAt, closed_at AS closedAt FROM test_defects WHERE test_run_id = ? ORDER BY created_at, id",
      )
      .all(testRunId) as Array<Record<string, unknown>>;
    const obligationRows = database
      .prepare(
        "SELECT id, status FROM test_run_obligations WHERE test_run_id = ? ORDER BY id",
      )
      .all(testRunId) as Array<{
      readonly id: string;
      readonly status: "open" | "closed";
    }>;
    const view = {
      id: testRunId,
      requestId: String(row.requestId),
      manifest: parseJson<TestRunManifest>(String(row.manifestJson)),
      manifestHash: String(row.manifestHash),
      state: String(row.state) as TestRunView["state"],
      passAuthorityHash: row.passAuthorityHash
        ? String(row.passAuthorityHash)
        : null,
      assertions: assertionRows.map((entry) => ({
        id: String(entry.id),
        testCaseRevisionId: String(entry.testCaseRevisionId),
        assertionId: String(entry.assertionId),
        required: Number(entry.required) === 1,
        uiStatus: String(
          entry.uiStatus,
        ) as TestRunView["assertions"][number]["uiStatus"],
        runtimeStatus: String(
          entry.runtimeStatus,
        ) as TestRunView["assertions"][number]["runtimeStatus"],
        correlation: parseJson<TestAssertionCorrelation>(
          String(entry.correlationJson),
        ),
        resultHash: String(entry.resultHash),
      })),
      evidence: evidenceRows.map((entry) => ({
        id: String(entry.id),
        testRunId,
        testCaseRevisionId: entry.testCaseRevisionId
          ? String(entry.testCaseRevisionId)
          : null,
        assertionId: entry.assertionId ? String(entry.assertionId) : null,
        kind: String(entry.kind) as TestEvidence["kind"],
        mediaType: String(entry.mediaType),
        contentHash: String(entry.contentHash),
        byteSize: Number(entry.byteSize),
        artifactVersionId: entry.artifactVersionId
          ? String(entry.artifactVersionId)
          : null,
        redactionProfile: String(entry.redactionProfile),
        retentionClass: String(
          entry.retentionClass,
        ) as TestEvidence["retentionClass"],
        locator: entry.locator ? String(entry.locator) : null,
        metadata: parseJson(String(entry.metadataJson)),
        createdAt: String(entry.createdAt),
      })),
      defects: defectRows.map((entry) => ({
        id: String(entry.id),
        testRunId,
        testCaseRevisionId: String(entry.testCaseRevisionId),
        assertionId: entry.assertionId ? String(entry.assertionId) : null,
        integrationGenerationId: String(entry.integrationGenerationId),
        responsibility: parseJson<TestDefectResponsibility>(
          String(entry.responsibilityJson),
        ),
        evidence: parseJson(String(entry.evidenceJson)),
        status: String(entry.status) as "open" | "closed",
        createdAt: String(entry.createdAt),
        closedAt: entry.closedAt ? String(entry.closedAt) : null,
      })),
      obligations: obligationRows,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
    return { ...view, viewHash: sha256(view) };
  };

  const validateAuthority = (
    input: TestRunManifestInput,
  ): IntegrationGenerationView => {
    const authority = options.integrationAuthority.readPassAuthority(
      input.integrationAuthority.generationId,
    );
    const commits = authority.repositoryResults
      .map((entry) => ({
        repositoryReference: entry.repositoryReference,
        commit: entry.integratedCommit ?? "",
      }))
      .sort((a, b) =>
        a.repositoryReference.localeCompare(b.repositoryReference),
      );
    const expectedCommits = [
      ...input.integrationAuthority.repositoryCommits,
    ].sort((a, b) =>
      a.repositoryReference.localeCompare(b.repositoryReference),
    );
    const eligible =
      authority.state === "passed" &&
      authority.passAuthorityHash !== null &&
      authority.passAuthorityHash ===
        input.integrationAuthority.passAuthorityHash &&
      authority.manifestHash === input.integrationAuthority.manifestHash &&
      authority.aggregateReview?.result === "PASS" &&
      authority.defects.every((defect) => defect.status === "closed") &&
      authority.repositoryResults.every(
        (repository) =>
          repository.state === "succeeded" &&
          repository.integratedCommit !== null &&
          repository.validationRecords.every(
            (record) => record.status === "passed",
          ),
      ) &&
      authority.operations.every(
        (operation) => operation.state === "succeeded",
      ) &&
      canonicalJson(commits) === canonicalJson(expectedCommits);
    if (!eligible)
      throw new TestRuntimeError(
        "INTEGRATION_AUTHORITY_INELIGIBLE",
        `Integration Generation ${input.integrationAuthority.generationId} is not the exact closed PASS authority.`,
      );
    return authority;
  };

  const createRun: TestRuntime["createRun"] = (input) => {
    const authority = validateAuthority(input);
    const pipelineRun = database
      .prepare(
        "SELECT snapshot_revision_id AS snapshotRevisionId FROM department_runs WHERE id = ?",
      )
      .get(input.runId) as { readonly snapshotRevisionId: string } | undefined;
    if (pipelineRun) {
      const pipelineContext = database
        .prepare(
          `SELECT node_attempts.id AS nodeAttemptId
             FROM node_runs
             JOIN node_attempts ON node_attempts.node_run_id = node_runs.id
            WHERE node_runs.id = ? AND node_runs.run_id = ?
              AND node_runs.handler_kind_id = 'test@1'
              AND node_runs.status IN ('running', 'blocked')
              AND node_attempts.id = ?
              AND node_attempts.snapshot_revision_id = ?
              AND node_attempts.status IN ('running', 'reconciling')`,
        )
        .get(
          input.nodeRunId,
          input.runId,
          input.nodeAttemptId,
          input.snapshotRevisionId,
        );
      if (
        !pipelineContext ||
        pipelineRun.snapshotRevisionId !== input.snapshotRevisionId ||
        input.testRunId !== `test:${input.runId}:${input.nodeRunId}`
      ) {
        throw new TestRuntimeError(
          "TEST_PIPELINE_CONTEXT_INVALID",
          "A Test Run must bind the exact running test@1 Node Attempt owned by Pipeline Runtime.",
        );
      }
    }
    for (const entry of input.testCaseRevisions) {
      const revision = readCaseRevision(entry.id);
      if (
        revision.projectId !== input.projectId ||
        revision.manifestHash !== entry.hash
      )
        throw new TestRuntimeError(
          "TEST_CASE_COVERAGE_CONFLICT",
          `Test Case revision ${entry.id} does not match its frozen coverage hash.`,
        );
    }
    const testCaseRevisions = [...input.testCaseRevisions].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    if (testCaseRevisions.length === 0)
      throw new TestRuntimeError(
        "TEST_CASE_COVERAGE_INCOMPLETE",
        "A Test Run requires at least one Test Case revision.",
      );
    [
      input.integrationAuthority.manifestHash,
      input.integrationAuthority.passAuthorityHash,
      input.build.digest,
      input.executionProfile.hash,
      input.companyDirectoryFingerprint,
      ...input.fixture.scriptHashes,
    ].forEach((value, index) =>
      ensureHash(value, `manifest hash ${index + 1}`),
    );
    const manifest: TestRunManifest = {
      ...input,
      schemaVersion: 1,
      testCaseRevisions,
      integrationAuthority: {
        ...input.integrationAuthority,
        repositoryCommits: [
          ...input.integrationAuthority.repositoryCommits,
        ].sort((a, b) =>
          a.repositoryReference.localeCompare(b.repositoryReference),
        ),
      },
      fixture: {
        ...input.fixture,
        scriptHashes: sortedUnique(input.fixture.scriptHashes),
      },
      capabilities: sortedUnique(input.capabilities),
      coverageHash: sha256(testCaseRevisions),
      integrationCoverage: {
        coverageId: authority.manifest.coverageId,
        coverageNodeRunId: authority.manifest.coverageNodeRunId,
        coverageNodeAttemptId: authority.manifest.coverageNodeAttemptId,
        coverageHash: authority.manifest.coverageHash,
        packageAuthorities: authority.manifest.packages
          .map((entry) => ({
            workPackageId: entry.workPackageId,
            workPackageVersionId: entry.workPackageVersionId,
            authorityId: entry.authorityId,
            qualityGateResultId: entry.qualityGateResultId,
            sourceCommit: entry.sourceCommit,
            diffHash: entry.diffHash,
          }))
          .sort((a, b) =>
            a.workPackageVersionId.localeCompare(b.workPackageVersionId),
          ),
        aggregateReviewId: authority.aggregateReview!.id,
        aggregateGateResultId: authority.aggregateReview!.qualityGateResultId,
        aggregateInputHash: authority.aggregateReview!.inputHash,
        evidenceRefs: [...authority.aggregateReview!.evidence].sort(),
      },
    };
    const manifestHash = sha256(manifest);
    const requestHash = sha256({ requestId: input.requestId, manifestHash });
    const existing = database
      .prepare(
        "SELECT id, request_hash AS requestHash FROM test_runs WHERE id = ? OR request_id = ?",
      )
      .get(input.testRunId, input.requestId) as
      | { readonly id: string; readonly requestHash: string }
      | undefined;
    if (existing) {
      if (
        existing.id !== input.testRunId ||
        existing.requestHash !== requestHash
      )
        throw new TestRuntimeError(
          "TEST_RUN_REQUEST_CONFLICT",
          `Test Run request ${input.requestId} already has different immutable input.`,
        );
      return readRun(existing.id);
    }
    const now = clock().toISOString();
    inTransaction(() => {
      database
        .prepare(
          `INSERT INTO test_runs(id, request_id, project_id, run_id, snapshot_revision_id, node_run_id, node_attempt_id, session_id, integration_generation_id, integration_manifest_hash, integration_pass_authority_hash, manifest_json, manifest_hash, request_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        )
        .run(
          input.testRunId,
          input.requestId,
          input.projectId,
          input.runId,
          input.snapshotRevisionId,
          input.nodeRunId,
          input.nodeAttemptId,
          input.sessionId,
          input.integrationAuthority.generationId,
          input.integrationAuthority.manifestHash,
          input.integrationAuthority.passAuthorityHash,
          canonicalJson(manifest),
          manifestHash,
          requestHash,
          now,
          now,
        );
      const insertCoverage = database.prepare(
        "INSERT INTO test_run_case_revisions(test_run_id, test_case_revision_id, manifest_hash, ordinal) VALUES (?, ?, ?, ?)",
      );
      testCaseRevisions.forEach((entry, ordinal) =>
        insertCoverage.run(input.testRunId, entry.id, entry.hash, ordinal),
      );
      appendEvent({
        type: "test.run.accepted",
        projectId: input.projectId,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        testRunId: input.testRunId,
        payload: {
          testRunId: input.testRunId,
          state: "scheduled",
          manifestHash,
        },
        timestamp: now,
      });
    });
    return readRun(input.testRunId);
  };

  const operationRequest = (
    run: TestRunView,
    operationId: string,
    input: unknown,
  ): TestExecutionRequest => {
    const requestHash = sha256({
      testRunManifestHash: run.manifestHash,
      operationId,
      input,
    });
    return {
      operationId,
      operationKey: `test:${run.id}:${operationId}:${requestHash}`,
      testRunId: run.id,
      requestHash,
      input,
    };
  };

  const persistFact = (
    request: TestExecutionRequest,
    fact: TestExecutionFact,
  ): void => {
    const now = clock().toISOString();
    const factHash = sha256(fact);
    const nextState =
      fact.state === "succeeded"
        ? "succeeded"
        : fact.state === "failed"
          ? "failed"
          : fact.state === "cancelled"
            ? "cancelled"
            : fact.state === "unknown"
              ? "unknown"
              : fact.state === "not-started"
                ? "intent"
                : "reconciling";
    inTransaction(() => {
      database
        .prepare(
          "INSERT OR IGNORE INTO test_execution_facts(id, operation_id, state, fact_json, fact_hash, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          request.operationId,
          fact.state,
          canonicalJson(fact),
          factHash,
          fact.evidenceRef ?? null,
          now,
        );
      database
        .prepare(
          "UPDATE test_execution_operations SET state = ?, fact_json = ?, fact_hash = ?, receipt_json = ?, receipt_hash = ?, updated_at = ? WHERE id = ? AND request_hash = ?",
        )
        .run(
          nextState,
          canonicalJson(fact),
          factHash,
          fact.providerReceipt === undefined
            ? null
            : canonicalJson(fact.providerReceipt),
          fact.providerReceipt === undefined
            ? null
            : sha256(fact.providerReceipt),
          now,
          request.operationId,
          request.requestHash,
        );
      database
        .prepare(
          "UPDATE test_runs SET state = ?, updated_at = ? WHERE id = ? AND state NOT IN ('passed', 'failed', 'blocked', 'cancelled')",
        )
        .run(
          nextState === "succeeded"
            ? "running"
            : nextState === "intent"
              ? "reconciling"
              : nextState,
          now,
          request.testRunId,
        );
      const eventRun = readRun(request.testRunId);
      appendEvent({
        type:
          nextState === "unknown"
            ? "test.run.unknown"
            : nextState === "reconciling"
              ? "test.run.reconciling"
              : nextState === "failed"
                ? "test.run.failed"
                : nextState === "cancelled"
                  ? "test.run.cancelled"
                  : "test.run.started",
        projectId: eventRun.manifest.projectId,
        runId: eventRun.manifest.runId,
        nodeRunId: eventRun.manifest.nodeRunId,
        testRunId: eventRun.id,
        payload: {
          testRunId: eventRun.id,
          state:
            nextState === "succeeded"
              ? "running"
              : nextState === "intent"
                ? "reconciling"
                : nextState,
          operationId: request.operationId,
        },
        timestamp: now,
      });
    });
  };

  const execute: TestRuntime["execute"] = async (input) => {
    const run = readRun(input.testRunId);
    if (["passed", "failed", "blocked", "cancelled"].includes(run.state))
      return run;
    const request = operationRequest(run, input.operationId, input.input);
    const existing = database
      .prepare(
        "SELECT request_hash AS requestHash, state, fact_json AS factJson FROM test_execution_operations WHERE id = ? OR operation_key = ?",
      )
      .get(input.operationId, request.operationKey) as
      | {
          readonly requestHash: string;
          readonly state: string;
          readonly factJson: string | null;
        }
      | undefined;
    if (existing) {
      if (existing.requestHash !== request.requestHash)
        throw new TestRuntimeError(
          "TEST_EXECUTION_CONFLICT",
          `Test execution ${input.operationId} already has different immutable input.`,
        );
      if (["succeeded", "failed", "cancelled"].includes(existing.state))
        return readRun(input.testRunId);
      const reconciledNotStarted =
        existing.state === "intent" &&
        existing.factJson !== null &&
        parseJson<TestExecutionFact>(existing.factJson).state === "not-started";
      if (!reconciledNotStarted)
        throw new TestRuntimeError(
          "TEST_EXECUTION_RECONCILIATION_REQUIRED",
          `Test execution ${input.operationId} must be reconciled before another effect can run.`,
        );
      const fact = await input.adapter.execute(request);
      input.failureInjection?.("after-effect");
      persistFact(request, fact);
      return readRun(input.testRunId);
    }
    const now = clock().toISOString();
    inTransaction(() => {
      database
        .prepare(
          "INSERT INTO test_execution_operations(id, test_run_id, operation_key, request_json, request_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)",
        )
        .run(
          input.operationId,
          input.testRunId,
          request.operationKey,
          canonicalJson(request),
          request.requestHash,
          now,
          now,
        );
      database
        .prepare(
          "UPDATE test_runs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'scheduled'",
        )
        .run(now, input.testRunId);
    });
    input.failureInjection?.("after-intent");
    const fact = await input.adapter.execute(request);
    input.failureInjection?.("after-effect");
    persistFact(request, fact);
    return readRun(input.testRunId);
  };

  const reconcile: TestRuntime["reconcile"] = async (input) => {
    const run = readRun(input.testRunId);
    const row = database
      .prepare(
        "SELECT request_json AS requestJson, state FROM test_execution_operations WHERE id = ? AND test_run_id = ?",
      )
      .get(input.operationId, input.testRunId) as
      | { readonly requestJson: string; readonly state: string }
      | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_EXECUTION_NOT_FOUND",
        `Test execution ${input.operationId} was not found.`,
      );
    if (["succeeded", "failed", "cancelled"].includes(row.state)) return run;
    const request = parseJson<TestExecutionRequest>(row.requestJson);
    database
      .prepare(
        "UPDATE test_execution_operations SET state = 'reconciling', updated_at = ? WHERE id = ?",
      )
      .run(clock().toISOString(), input.operationId);
    const fact = await input.adapter.reconcile(request);
    persistFact(request, fact);
    return readRun(input.testRunId);
  };

  const cancel: TestRuntime["cancel"] = async (input) => {
    const row = database
      .prepare(
        "SELECT request_json AS requestJson, state FROM test_execution_operations WHERE id = ? AND test_run_id = ?",
      )
      .get(input.operationId, input.testRunId) as
      | { readonly requestJson: string; readonly state: string }
      | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_EXECUTION_NOT_FOUND",
        `Test execution ${input.operationId} was not found.`,
      );
    if (["succeeded", "failed", "cancelled"].includes(row.state))
      return readRun(input.testRunId);
    const request = parseJson<TestExecutionRequest>(row.requestJson);
    const fact = input.adapter.cancel
      ? await input.adapter.cancel(request)
      : { state: "unknown" as const };
    persistFact(request, fact);
    return readRun(input.testRunId);
  };

  const recordAssertion: TestRuntime["recordAssertion"] = (input) => {
    const run = readRun(input.testRunId);
    const covered = run.manifest.testCaseRevisions.some(
      (entry) => entry.id === input.testCaseRevisionId,
    );
    const revision = covered
      ? readCaseRevision(input.testCaseRevisionId)
      : null;
    const declared = revision?.manifest.assertions.some(
      (entry) => entry.id === input.assertionId,
    );
    if (!covered || !declared)
      throw new TestRuntimeError(
        "TEST_ASSERTION_NOT_DECLARED",
        `Assertion ${input.assertionId} is not in the frozen Test Run manifest.`,
      );
    const latestSequence = options.events?.latestSequence();
    if (
      input.correlation.runId !== run.manifest.runId ||
      input.correlation.snapshotRevisionId !==
        run.manifest.snapshotRevisionId ||
      input.correlation.nodeRunId !== run.manifest.nodeRunId ||
      input.correlation.nodeAttemptId !== run.manifest.nodeAttemptId ||
      input.correlation.sessionId !== run.manifest.sessionId ||
      input.correlation.eventSequence < 0 ||
      input.correlation.queryAsOfSequence !== input.correlation.eventSequence ||
      (latestSequence !== undefined &&
        input.correlation.queryAsOfSequence !== latestSequence) ||
      input.correlation.queryViewHash !== run.viewHash
    )
      throw new TestRuntimeError(
        "TEST_ASSERTION_CORRELATION_INVALID",
        "Test assertion correlation does not bind the current authoritative Query View, event sequence, and frozen Runtime lineage.",
      );
    ensureHash(input.correlation.queryViewHash, "queryViewHash");
    const result = {
      testRunId: input.testRunId,
      testCaseRevisionId: input.testCaseRevisionId,
      assertionId: input.assertionId,
      required: input.required ?? true,
      uiStatus: input.uiStatus,
      runtimeStatus: input.runtimeStatus,
      correlation: input.correlation,
    };
    const resultHash = sha256(result);
    const existing = database
      .prepare(
        "SELECT result_hash AS resultHash FROM test_assertion_results WHERE test_run_id = ? AND test_case_revision_id = ? AND assertion_id = ?",
      )
      .get(input.testRunId, input.testCaseRevisionId, input.assertionId) as
      | { readonly resultHash: string }
      | undefined;
    if (existing) {
      if (existing.resultHash !== resultHash)
        throw new TestRuntimeError(
          "TEST_ASSERTION_CONFLICT",
          `Assertion ${input.assertionId} already has a different immutable result.`,
        );
      return readRun(input.testRunId);
    }
    database
      .prepare(
        "INSERT INTO test_assertion_results(id, test_run_id, test_case_revision_id, assertion_id, required, ui_status, runtime_status, correlation_json, result_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.testRunId,
        input.testCaseRevisionId,
        input.assertionId,
        input.required === false ? 0 : 1,
        input.uiStatus,
        input.runtimeStatus,
        canonicalJson(input.correlation),
        resultHash,
        clock().toISOString(),
      );
    appendEvent({
      type: "test.assertion.recorded",
      projectId: run.manifest.projectId,
      runId: run.manifest.runId,
      nodeRunId: run.manifest.nodeRunId,
      testRunId: run.id,
      testCaseRevisionId: input.testCaseRevisionId,
      payload: {
        testRunId: run.id,
        testCaseRevisionId: input.testCaseRevisionId,
        assertionId: input.assertionId,
      },
      timestamp: clock().toISOString(),
    });
    return readRun(input.testRunId);
  };

  const recordEvidence: TestRuntime["recordEvidence"] = (input) => {
    const run = readRun(input.testRunId);
    ensureHash(input.contentHash, "evidence contentHash");
    if (input.assertionId !== null && input.testCaseRevisionId === null) {
      throw new TestRuntimeError(
        "TEST_EVIDENCE_SCOPE_INVALID",
        "Assertion evidence must identify its Test Case revision.",
      );
    }
    if (input.testCaseRevisionId !== null) {
      const covered = run.manifest.testCaseRevisions.some(
        (entry) => entry.id === input.testCaseRevisionId,
      );
      const declared =
        covered && input.assertionId !== null
          ? readCaseRevision(input.testCaseRevisionId).manifest.assertions.some(
              (assertion) => assertion.id === input.assertionId,
            )
          : true;
      if (!covered || !declared) {
        throw new TestRuntimeError(
          "TEST_EVIDENCE_SCOPE_INVALID",
          "Test evidence must bind a frozen Test Case revision and declared assertion in the Test Run.",
        );
      }
    }
    const existing = database
      .prepare(
        `SELECT test_run_id AS testRunId,
                test_case_revision_id AS testCaseRevisionId,
                assertion_id AS assertionId, kind, media_type AS mediaType,
                content_hash AS contentHash, byte_size AS byteSize,
                artifact_version_id AS artifactVersionId,
                redaction_profile AS redactionProfile,
                retention_class AS retentionClass, locator,
                metadata_json AS metadataJson
           FROM test_evidence WHERE id = ?`,
      )
      .get(input.id) as
      | {
          readonly testRunId: string;
          readonly testCaseRevisionId: string | null;
          readonly assertionId: string | null;
          readonly kind: TestEvidence["kind"];
          readonly mediaType: string;
          readonly contentHash: string;
          readonly byteSize: number;
          readonly artifactVersionId: string | null;
          readonly redactionProfile: string;
          readonly retentionClass: TestEvidence["retentionClass"];
          readonly locator: string | null;
          readonly metadataJson: string;
        }
      | undefined;
    if (existing) {
      const storedInput = {
        id: input.id,
        testRunId: existing.testRunId,
        testCaseRevisionId: existing.testCaseRevisionId,
        assertionId: existing.assertionId,
        kind: existing.kind,
        mediaType: existing.mediaType,
        contentHash: existing.contentHash,
        byteSize: existing.byteSize,
        artifactVersionId: existing.artifactVersionId,
        redactionProfile: existing.redactionProfile,
        retentionClass: existing.retentionClass,
        locator: existing.locator,
        metadata: parseJson(existing.metadataJson),
      };
      if (canonicalJson(storedInput) !== canonicalJson(input))
        throw new TestRuntimeError(
          "TEST_EVIDENCE_CONFLICT",
          `Test evidence ${input.id} already has different immutable input.`,
        );
      return readRun(input.testRunId);
    }
    database
      .prepare(
        "INSERT INTO test_evidence(id, test_run_id, test_case_revision_id, assertion_id, kind, media_type, content_hash, byte_size, artifact_version_id, redaction_profile, retention_class, locator, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.testRunId,
        input.testCaseRevisionId,
        input.assertionId,
        input.kind,
        input.mediaType,
        input.contentHash,
        input.byteSize,
        input.artifactVersionId,
        input.redactionProfile,
        input.retentionClass,
        input.locator,
        canonicalJson(input.metadata),
        clock().toISOString(),
      );
    appendEvent({
      type: "test.evidence.recorded",
      projectId: run.manifest.projectId,
      runId: run.manifest.runId,
      nodeRunId: run.manifest.nodeRunId,
      testRunId: run.id,
      payload: { testRunId: run.id, evidenceId: input.id },
      timestamp: clock().toISOString(),
    });
    return readRun(input.testRunId);
  };

  const recordDefect: TestRuntime["recordDefect"] = (input) => {
    const run = readRun(input.testRunId);
    const covered = run.manifest.testCaseRevisions.some(
      (entry) => entry.id === input.testCaseRevisionId,
    );
    const declared =
      covered && input.assertionId !== undefined
        ? readCaseRevision(input.testCaseRevisionId).manifest.assertions.some(
            (assertion) => assertion.id === input.assertionId,
          )
        : true;
    if (!covered || !declared) {
      throw new TestRuntimeError(
        "TEST_DEFECT_SCOPE_INVALID",
        "A Test defect must bind a frozen Test Case revision and declared assertion in the Test Run.",
      );
    }
    const existing = database
      .prepare(
        "SELECT test_run_id AS testRunId, test_case_revision_id AS testCaseRevisionId, assertion_id AS assertionId, responsibility_json AS responsibilityJson, evidence_json AS evidenceJson FROM test_defects WHERE id = ?",
      )
      .get(input.id) as
      | {
          readonly testRunId: string;
          readonly testCaseRevisionId: string;
          readonly assertionId: string | null;
          readonly responsibilityJson: string;
          readonly evidenceJson: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.testRunId !== input.testRunId ||
        existing.testCaseRevisionId !== input.testCaseRevisionId ||
        existing.assertionId !== (input.assertionId ?? null) ||
        existing.responsibilityJson !== canonicalJson(input.responsibility) ||
        existing.evidenceJson !== canonicalJson(input.evidence)
      )
        throw new TestRuntimeError(
          "TEST_DEFECT_CONFLICT",
          `Test defect ${input.id} already has different immutable input.`,
        );
      return run;
    }
    database
      .prepare(
        "INSERT INTO test_defects(id, test_run_id, test_case_revision_id, assertion_id, integration_generation_id, responsibility_json, evidence_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      )
      .run(
        input.id,
        input.testRunId,
        input.testCaseRevisionId,
        input.assertionId ?? null,
        run.manifest.integrationAuthority.generationId,
        canonicalJson(input.responsibility),
        canonicalJson(input.evidence),
        clock().toISOString(),
      );
    appendEvent({
      type: "test.defect.created",
      projectId: run.manifest.projectId,
      runId: run.manifest.runId,
      nodeRunId: run.manifest.nodeRunId,
      testRunId: run.id,
      defectId: input.id,
      payload: { testRunId: run.id, defectId: input.id },
      timestamp: clock().toISOString(),
    });
    return readRun(input.testRunId);
  };

  const closeDefect: TestRuntime["closeDefect"] = (input) => {
    const row = database
      .prepare(
        "SELECT test_run_id AS testRunId, status FROM test_defects WHERE id = ?",
      )
      .get(input.defectId) as
      | { readonly testRunId: string; readonly status: string }
      | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_DEFECT_NOT_FOUND",
        `Test defect ${input.defectId} was not found.`,
      );
    const resolution = input.resolution as {
      readonly evidenceRefs?: unknown;
    } | null;
    if (
      resolution === null ||
      typeof resolution !== "object" ||
      !Array.isArray(resolution.evidenceRefs) ||
      resolution.evidenceRefs.length === 0 ||
      resolution.evidenceRefs.some(
        (reference) => typeof reference !== "string" || reference.trim() === "",
      )
    ) {
      throw new TestRuntimeError(
        "TEST_DEFECT_RESOLUTION_INVALID",
        "Closing a Test defect requires non-empty passing evidence references.",
      );
    }
    const now = clock().toISOString();
    const resolutionHash = sha256(input.resolution);
    const existingResolution = database
      .prepare(
        "SELECT defect_id AS defectId, resolution_hash AS resolutionHash FROM test_defect_resolutions WHERE id = ?",
      )
      .get(input.resolutionId) as
      | { readonly defectId: string; readonly resolutionHash: string }
      | undefined;
    if (existingResolution) {
      if (
        existingResolution.defectId !== input.defectId ||
        existingResolution.resolutionHash !== resolutionHash
      )
        throw new TestRuntimeError(
          "TEST_DEFECT_RESOLUTION_CONFLICT",
          `Test defect resolution ${input.resolutionId} already has different immutable input.`,
        );
      return readRun(row.testRunId);
    }
    inTransaction(() => {
      database
        .prepare(
          "INSERT INTO test_defect_resolutions(id, defect_id, resolution_json, resolution_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.resolutionId,
          input.defectId,
          canonicalJson(input.resolution),
          resolutionHash,
          now,
        );
      database
        .prepare(
          "UPDATE test_defects SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(now, input.defectId);
      const run = readRun(row.testRunId);
      appendEvent({
        type: "test.defect.closed",
        projectId: run.manifest.projectId,
        runId: run.manifest.runId,
        nodeRunId: run.manifest.nodeRunId,
        testRunId: run.id,
        defectId: input.defectId,
        payload: { testRunId: run.id, defectId: input.defectId },
        timestamp: now,
      });
    });
    return readRun(row.testRunId);
  };

  const complete: TestRuntime["complete"] = (testRunId) => {
    const run = readRun(testRunId);
    if (["passed", "failed", "blocked", "cancelled"].includes(run.state))
      return run;
    const requiredAssertions = run.manifest.testCaseRevisions.flatMap((entry) =>
      readCaseRevision(entry.id).manifest.assertions.map(
        (assertion) => `${entry.id}:${assertion.id}`,
      ),
    );
    const assertionByKey = new Map(
      run.assertions.map((entry) => [
        `${entry.testCaseRevisionId}:${entry.assertionId}`,
        entry,
      ]),
    );
    const missing = requiredAssertions.filter(
      (key) => !assertionByKey.has(key),
    );
    const failing = run.assertions.filter(
      (entry) =>
        entry.required &&
        (entry.uiStatus !== "passed" || entry.runtimeStatus !== "passed"),
    );
    const evidenceKindsFor = (
      testCaseRevisionId: string,
      assertionId?: string,
    ): ReadonlySet<TestEvidence["kind"]> =>
      new Set(
        run.evidence
          .filter(
            (entry) =>
              entry.testCaseRevisionId === testCaseRevisionId &&
              (assertionId === undefined || entry.assertionId === assertionId),
          )
          .map((entry) => entry.kind),
      );
    const satisfiesEvidenceKind = (
      kinds: ReadonlySet<TestEvidence["kind"]>,
      requiredKind: string,
    ): boolean =>
      requiredKind === "ui"
        ? kinds.has("ui") || kinds.has("screenshot")
        : requiredKind === "runtime"
          ? kinds.has("runtime") || kinds.has("payload") || kinds.has("receipt")
          : kinds.has(requiredKind as TestEvidence["kind"]);
    const incompleteEvidence =
      run.assertions.some((assertion) => {
        if (!assertion.required) return false;
        const matchingEvidence = run.evidence.filter(
          (entry) =>
            entry.testCaseRevisionId === assertion.testCaseRevisionId &&
            entry.assertionId === assertion.assertionId,
        );
        const kinds = new Set(matchingEvidence.map((entry) => entry.kind));
        const artifactVersionIds = new Set(
          matchingEvidence.flatMap((entry) =>
            entry.artifactVersionId === null ? [] : [entry.artifactVersionId],
          ),
        );
        return (
          !satisfiesEvidenceKind(kinds, "ui") ||
          !satisfiesEvidenceKind(kinds, "runtime") ||
          assertion.correlation.artifactVersionIds.length === 0 ||
          assertion.correlation.artifactVersionIds.some(
            (artifactVersionId) => !artifactVersionIds.has(artifactVersionId),
          )
        );
      }) ||
      run.manifest.testCaseRevisions.some((entry) => {
        const kinds = evidenceKindsFor(entry.id);
        return readCaseRevision(
          entry.id,
        ).manifest.evidencePolicy.requiredKinds.some(
          (requiredKind) => !satisfiesEvidenceKind(kinds, requiredKind),
        );
      });
    const openDefects = run.defects.filter(
      (defect) => defect.status === "open",
    );
    const openObligations = run.obligations.filter(
      (obligation) => obligation.status === "open",
    );
    if (
      missing.length > 0 ||
      failing.length > 0 ||
      incompleteEvidence ||
      openDefects.length > 0 ||
      openObligations.length > 0
    )
      throw new TestRuntimeError(
        "TEST_RUN_PASS_INCOMPLETE",
        "A Test Run cannot PASS without complete paired assertions, immutable evidence, and closed defects and obligations.",
      );
    const passAuthorityHash = sha256({
      schemaVersion: 1,
      testRunId,
      manifestHash: run.manifestHash,
      integrationAuthority: run.manifest.integrationAuthority,
      coverageHash: run.manifest.coverageHash,
      assertionResultHashes: run.assertions
        .map((entry) => entry.resultHash)
        .sort(),
      evidenceHashes: run.evidence.map((entry) => entry.contentHash).sort(),
      closedDefectIds: run.defects.map((entry) => entry.id).sort(),
    });
    database
      .prepare(
        "UPDATE test_runs SET state = 'passed', pass_authority_hash = ?, updated_at = ? WHERE id = ? AND state NOT IN ('passed', 'failed', 'blocked', 'cancelled')",
      )
      .run(passAuthorityHash, clock().toISOString(), testRunId);
    appendEvent({
      type: "test.run.completed",
      projectId: run.manifest.projectId,
      runId: run.manifest.runId,
      nodeRunId: run.manifest.nodeRunId,
      testRunId: run.id,
      payload: {
        testRunId: run.id,
        state: "passed",
        manifestHash: run.manifestHash,
        passAuthorityHash,
      },
      timestamp: clock().toISOString(),
    });
    return readRun(testRunId);
  };

  const downstreamAuthority: TestRuntime["downstreamAuthority"] = (
    testRunId,
  ) => {
    const run = readRun(testRunId);
    if (run.state !== "passed" || !run.passAuthorityHash)
      throw new TestRuntimeError(
        "TEST_RUN_NOT_PASS_AUTHORITY",
        `Test Run ${testRunId} is not an immutable PASS authority.`,
      );
    return {
      testRunId,
      manifestHash: run.manifestHash,
      passAuthorityHash: run.passAuthorityHash,
      integrationAuthority: run.manifest.integrationAuthority,
      testCaseRevisions: run.manifest.testCaseRevisions,
      coverageHash: run.manifest.coverageHash,
      build: run.manifest.build,
      snapshotRevisionId: run.manifest.snapshotRevisionId,
      executionProfile: run.manifest.executionProfile,
      companyDirectoryFingerprint: run.manifest.companyDirectoryFingerprint,
      fixture: run.manifest.fixture,
      environment: run.manifest.environment,
      capabilities: run.manifest.capabilities,
      assertionResultHashes: run.assertions
        .map((entry) => entry.resultHash)
        .sort(),
      evidenceHashes: run.evidence.map((entry) => entry.contentHash).sort(),
      openDefectIds: [],
      openObligationIds: [],
    };
  };

  return {
    registerCaseRevision,
    inspectCase,
    createRun,
    inspect: readRun,
    execute,
    reconcile,
    cancel,
    recordAssertion,
    recordEvidence,
    recordDefect,
    closeDefect,
    complete,
    downstreamAuthority,
  };
};
