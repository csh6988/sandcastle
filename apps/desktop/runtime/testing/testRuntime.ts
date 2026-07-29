import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ArtifactRegistry } from "../artifactRegistry.js";
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
    readonly operationId: string;
    readonly ui: { readonly kind: string; readonly expected: unknown };
    readonly runtime: { readonly kind: string; readonly expected: unknown };
  }[];
  readonly fixture: {
    readonly id: string;
    readonly scriptHashes: readonly string[];
  };
  readonly executionOperations: readonly {
    readonly id: string;
    readonly kind: "runtime" | "contract" | "build" | "electron" | "cleanup";
    readonly adapterId: string;
    readonly input: unknown;
    readonly inputHash: string;
  }[];
  readonly evidencePolicy: {
    readonly retentionClass: "transient" | "standard" | "durable";
    readonly redactionProfile: string;
    readonly requiredKinds: readonly string[];
  };
  readonly cleanup: {
    readonly policy: string;
    readonly required: boolean;
    readonly operationId: string;
    readonly rootFingerprint: string;
    readonly targets: readonly {
      readonly kind: "repository" | "worktree";
      readonly pathFingerprint: string;
    }[];
  };
};

export type TestCleanupReceipt = {
  readonly schemaVersion: 1;
  readonly kind: "cleanup";
  readonly receiptId: string;
  readonly fixtureId: string;
  readonly operationKey: string;
  readonly rootFingerprint: string;
  readonly targets: readonly {
    readonly kind: "repository" | "worktree";
    readonly pathFingerprint: string;
    readonly state: "absent";
  }[];
  readonly artifactVersionId: string;
  readonly contentHash: string;
};

export type TestScopeRiskInput = {
  readonly schemaVersion: 1;
  readonly policy: {
    readonly revisionId: string;
    readonly rules: readonly {
      readonly factorId: string;
      readonly minimumTier: "low" | "medium" | "high" | "critical";
    }[];
    readonly hash: string;
  };
  readonly factors: readonly {
    readonly id: string;
    readonly present: boolean;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly computedTier: "low" | "medium" | "high" | "critical";
  readonly evidenceRefs: readonly string[];
  readonly inputHash: string;
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
  readonly executionOperations: readonly {
    readonly id: string;
    readonly kind: "runtime" | "contract" | "build" | "electron" | "cleanup";
    readonly adapterId: string;
    readonly input: unknown;
    readonly inputHash: string;
  }[];
  readonly clock: { readonly instant: string; readonly seed: string };
  readonly environment: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  readonly risk: TestScopeRiskInput;
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
  readonly runtimeEventType: string;
  readonly queryAsOfSequence: number;
  readonly queryViewHash: string;
  readonly viewSyncTokenHash: string;
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
  readonly executions: readonly {
    readonly id: string;
    readonly state:
      | "intent"
      | "running"
      | "reconciling"
      | "not-started"
      | "unknown"
      | "succeeded"
      | "failed"
      | "cancelled";
    readonly requestHash: string;
    readonly receiptHash: string | null;
  }[];
  readonly assertions: readonly {
    readonly id: string;
    readonly operationId: string;
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
  readonly operationId: string;
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

export type TestDefectEvidence =
  | {
      readonly schemaVersion: 1;
      readonly kind: "assertion";
      readonly assertion: {
        readonly testCaseRevisionId: string;
        readonly assertionId: string;
        readonly resultHash: string;
      };
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "execution";
      readonly operationId: string;
      readonly operationKey: string;
      readonly requestHash: string;
      readonly factHash: string;
      readonly evidenceRefs: readonly string[];
      readonly providerReceiptHash: string | null;
    };

export type TestDefectResolution = {
  readonly schemaVersion: 1;
  readonly resolvedByTestRunId: string;
  readonly passAuthorityHash: string;
  readonly assertions: readonly {
    readonly testCaseRevisionId: string;
    readonly assertionId: string;
    readonly resultHash: string;
    readonly evidenceRefs: readonly string[];
  }[];
};

export type TestDefect = {
  readonly id: string;
  readonly testRunId: string;
  readonly testCaseRevisionId: string;
  readonly assertionId: string | null;
  readonly integrationGenerationId: string;
  readonly responsibility: TestDefectResponsibility;
  readonly evidence: TestDefectEvidence;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
};

export type TestReworkRoute =
  | {
      readonly destination: "work-package";
      readonly workPackageId: string;
      readonly workPackageVersionId: string;
    }
  | {
      readonly destination: "contract";
      readonly contractId: string;
      readonly version: string;
      readonly producerApplicationId: string;
      readonly consumerApplicationId: string;
      readonly candidateWorkPackageVersionIds: readonly string[];
    }
  | {
      readonly destination: "triage";
      readonly responsibility: "aggregate" | "unknown";
      readonly candidateWorkPackageVersionIds: readonly string[];
      readonly reason?: string;
    }
  | {
      readonly destination: "ui-runtime-contract";
      readonly owner: "ui" | "runtime" | "shared";
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

const TestAssertionCorrelationSchema = z
  .object({
    commandId: z.string().trim().min(1),
    eventSequence: z.number().int().nonnegative(),
    runtimeEventType: z.string().trim().min(1),
    queryAsOfSequence: z.number().int().nonnegative(),
    queryViewHash: z.string().regex(/^[a-f0-9]{64}$/),
    viewSyncTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotRevisionId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    nodeAttemptId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    artifactVersionIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const TestDefectEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("assertion"),
      assertion: z
        .object({
          testCaseRevisionId: z.string().trim().min(1),
          assertionId: z.string().trim().min(1),
          resultHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      evidenceRefs: z.array(z.string().trim().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("execution"),
      operationId: z.string().trim().min(1),
      operationKey: z.string().trim().min(1),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      factHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceRefs: z.array(z.string().trim().min(1)).min(1),
      providerReceiptHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .strict(),
]);

const TestDefectResolutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    resolvedByTestRunId: z.string().trim().min(1),
    passAuthorityHash: z.string().regex(/^[a-f0-9]{64}$/),
    assertions: z
      .array(
        z
          .object({
            testCaseRevisionId: z.string().trim().min(1),
            assertionId: z.string().trim().min(1),
            resultHash: z.string().regex(/^[a-f0-9]{64}$/),
            evidenceRefs: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const TestCleanupReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("cleanup"),
    receiptId: z.string().trim().min(1),
    fixtureId: z.string().trim().min(1),
    operationKey: z.string().trim().min(1),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    targets: z.array(
      z
        .object({
          kind: z.enum(["repository", "worktree"]),
          pathFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          state: z.literal("absent"),
        })
        .strict(),
    ),
    artifactVersionId: z.string().trim().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const TestExecutionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    assertions: z.array(
      z
        .object({
          testCaseRevisionId: z.string().trim().min(1),
          assertionId: z.string().trim().min(1),
          uiStatus: z.enum(["passed", "failed", "missing", "unknown"]),
          runtimeStatus: z.enum(["passed", "failed", "missing", "unknown"]),
          correlation: TestAssertionCorrelationSchema,
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          testCaseRevisionId: z.string().trim().min(1),
          assertionId: z.string().trim().min(1).nullable(),
          kind: z.enum([
            "ui",
            "runtime",
            "screenshot",
            "log",
            "payload",
            "receipt",
            "cleanup",
          ]),
          mediaType: z.string().trim().min(1),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          byteSize: z.number().int().nonnegative(),
          artifactVersionId: z.string().trim().min(1).nullable(),
          redactionProfile: z.string().trim().min(1),
          retentionClass: z.enum(["transient", "standard", "durable"]),
          locator: z.string().trim().min(1).nullable(),
          metadata: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();

export type TestExecutionResult = z.infer<typeof TestExecutionResultSchema>;

export interface TestExecutionAdapter {
  readonly id: string;
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

export interface TestFixtureAuthority {
  readonly read: (fixtureId: string) => {
    readonly fixtureId: string;
    readonly companyDirectoryFingerprint: string;
    readonly scriptHashes: readonly string[];
    readonly adapterIds: readonly string[];
  };
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
    readonly cancelOperationId: string;
    readonly kind?: "pause" | "cancel";
    readonly testRunId: string;
    readonly operationId: string;
    readonly adapter: TestExecutionAdapter;
    readonly failureInjection?: (
      point: "after-cancel-intent" | "after-cancel-effect",
    ) => void;
  }) => Promise<TestRunView>;
  readonly recordAssertion: (input: {
    readonly operationId: string;
    readonly testRunId: string;
    readonly testCaseRevisionId: string;
    readonly assertionId: string;
    readonly required?: boolean;
    readonly uiStatus: "passed" | "failed" | "missing" | "unknown";
    readonly runtimeStatus: "passed" | "failed" | "missing" | "unknown";
    readonly correlation: TestAssertionCorrelation;
  }) => TestRunView;
  readonly recordEvidence: (
    input: Omit<TestEvidence, "createdAt"> & { readonly operationId: string },
  ) => TestRunView;
  readonly recordDefect: (input: {
    readonly id: string;
    readonly testRunId: string;
    readonly testCaseRevisionId: string;
    readonly assertionId?: string;
    readonly responsibility: TestDefectResponsibility;
    readonly evidence: TestDefectEvidence;
  }) => TestRunView;
  readonly closeDefect: (input: {
    readonly defectId: string;
    readonly resolutionId: string;
    readonly resolution: TestDefectResolution;
  }) => TestRunView;
  readonly createReworkRun: (input: {
    readonly defectId: string;
    readonly input: TestRunManifestInput;
  }) => {
    readonly run: TestRunView;
    readonly route: TestReworkRoute;
    readonly lineage: {
      readonly priorTestRunId: string;
      readonly priorManifestHash: string;
      readonly integrationAuthority:
        | "reuse-exact-pass"
        | "fresh-pass-authority";
      readonly priorIntegrationGenerationId: string;
      readonly nextIntegrationGenerationId: string;
    };
  };
  readonly complete: (testRunId: string) => TestRunView;
  readonly downstreamAuthority: (testRunId: string) => {
    readonly schemaVersion: 1;
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
    readonly risk: TestRunManifest["risk"];
    readonly assertionResultHashes: readonly string[];
    readonly evidence: readonly {
      readonly id: string;
      readonly contentHash: string;
      readonly artifactVersionId: string | null;
      readonly locator: string | null;
    }[];
    readonly evidenceHashes: readonly string[];
    readonly defectResolutions: readonly {
      readonly defectId: string;
      readonly resolutionId: string;
      readonly resolutionHash: string;
    }[];
    readonly obligations: readonly {
      readonly id: string;
      readonly status: "closed";
    }[];
    readonly openDefectIds: readonly string[];
    readonly openObligationIds: readonly string[];
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
const executionStorageId = (testRunId: string, operationId: string): string =>
  `test-execution:${sha256({ testRunId, operationId })}`;
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
    readonly fixtureAuthority?: TestFixtureAuthority;
    readonly artifacts?: Pick<ArtifactRegistry, "verify" | "readContent"> &
      Partial<Pick<ArtifactRegistry, "inspect">>;
    readonly events?: Pick<RuntimeEvents, "append" | "latestSequence">;
    readonly clock?: () => Date;
    readonly nextId?: () => string;
    readonly workerFailureInjection?: (
      point: "after-state" | "after-event",
      commandId: string,
    ) => void;
  },
): TestRuntime => {
  const clock = options.clock ?? (() => new Date());
  const nextId = options.nextId ?? randomUUID;
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
          nextId(),
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
  const workerActor = {
    type: "runtime-worker",
    id: "test-runtime",
    authenticatedBy: "company-runtime",
  } as const;
  const workerUnitOfWork = <Value>(input: {
    readonly commandId: string;
    readonly request: unknown;
    readonly result: (value: Value) => unknown;
    readonly operation: () => Value;
  }): Value => {
    const requestJson = canonicalJson(input.request);
    const requestHash = sha256(requestJson);
    const existing = database
      .prepare(
        `SELECT request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(input.commandId) as
      | { readonly requestHash: string; readonly resultJson: string }
      | undefined;
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new TestRuntimeError(
          "TEST_WORKER_COMMAND_CONFLICT",
          `Trusted Test worker command ${input.commandId} was reused with different immutable input.`,
        );
      return parseJson<{ readonly value: Value }>(existing.resultJson).value;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, 'test-runtime', 1)`,
        )
        .run(
          input.commandId,
          workerActor.type,
          workerActor.id,
          workerActor.authenticatedBy,
        );
      const value = input.operation();
      options.workerFailureInjection?.("after-state", input.commandId);
      const effectIds = (
        database
          .prepare(
            "SELECT id FROM runtime_audit_records WHERE command_id = ? ORDER BY created_at, id",
          )
          .all(input.commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      options.workerFailureInjection?.("after-event", input.commandId);
      const resultJson = canonicalJson({
        status: "succeeded",
        value: input.result(value),
        effectIds,
      });
      database
        .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
        .run();
      database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, 'test-runtime', 1, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          input.commandId,
          workerActor.type,
          workerActor.id,
          workerActor.authenticatedBy,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(effectIds),
          clock().toISOString(),
        );
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
    const duplicateId = (values: readonly string[]): string | undefined =>
      values.find((value, index) => values.indexOf(value) !== index);
    const duplicateAction = duplicateId(
      input.manifest.uiActions.map((entry) => entry.id),
    );
    const duplicateAssertion = duplicateId(
      input.manifest.assertions.map((entry) => entry.id),
    );
    const duplicateOperation = duplicateId(
      input.manifest.executionOperations.map((entry) => entry.id),
    );
    const operationIds = new Set(
      input.manifest.executionOperations.map((entry) => entry.id),
    );
    const cleanupTargetKinds = input.manifest.cleanup.targets
      .map((entry) => entry.kind)
      .sort();
    if (
      duplicateAction ||
      duplicateAssertion ||
      duplicateOperation ||
      input.manifest.assertions.some(
        (assertion) => !operationIds.has(assertion.operationId),
      ) ||
      input.manifest.executionOperations.some(
        (operation) => operation.inputHash !== sha256(operation.input),
      ) ||
      !operationIds.has(input.manifest.cleanup.operationId) ||
      input.manifest.assertions.some(
        (assertion) =>
          assertion.operationId === input.manifest.cleanup.operationId,
      ) ||
      input.manifest.executionOperations.find(
        (operation) => operation.id === input.manifest.cleanup.operationId,
      )?.kind !== "cleanup" ||
      !/^[a-f0-9]{64}$/.test(input.manifest.cleanup.rootFingerprint) ||
      canonicalJson(cleanupTargetKinds) !==
        canonicalJson(["repository", "worktree"]) ||
      input.manifest.cleanup.targets.some(
        (target) => !/^[a-f0-9]{64}$/.test(target.pathFingerprint),
      )
    ) {
      throw new TestRuntimeError(
        "TEST_CASE_MANIFEST_INVALID",
        "A Test Case revision requires unique action/assertion/operation identities, exact operation input hashes, and a declared cleanup operation.",
      );
    }
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
      executionOperations: [...input.manifest.executionOperations].sort(
        (left, right) => left.id.localeCompare(right.id),
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
        `SELECT results.id, operations.request_json AS operationRequestJson,
                results.test_case_revision_id AS testCaseRevisionId,
                results.assertion_id AS assertionId, results.required,
                results.ui_status AS uiStatus,
                results.runtime_status AS runtimeStatus,
                results.correlation_json AS correlationJson,
                results.result_hash AS resultHash
           FROM test_assertion_results AS results
           JOIN test_execution_operations AS operations
             ON operations.id = results.operation_id
          WHERE results.test_run_id = ?
          ORDER BY results.test_case_revision_id, results.assertion_id`,
      )
      .all(testRunId) as Array<Record<string, unknown>>;
    const executionRows = database
      .prepare(
        `SELECT request_json AS requestJson, state, request_hash AS requestHash,
                receipt_hash AS receiptHash
           FROM test_execution_operations
          WHERE test_run_id = ? ORDER BY created_at, id`,
      )
      .all(testRunId) as Array<Record<string, unknown>>;
    const evidenceRows = database
      .prepare(
        `SELECT evidence.id, operations.request_json AS operationRequestJson,
                evidence.test_case_revision_id AS testCaseRevisionId,
                evidence.assertion_id AS assertionId, evidence.kind,
                evidence.media_type AS mediaType,
                evidence.content_hash AS contentHash,
                evidence.byte_size AS byteSize,
                evidence.artifact_version_id AS artifactVersionId,
                evidence.redaction_profile AS redactionProfile,
                evidence.retention_class AS retentionClass, evidence.locator,
                evidence.metadata_json AS metadataJson,
                evidence.created_at AS createdAt
           FROM test_evidence AS evidence
           JOIN test_execution_operations AS operations
             ON operations.id = evidence.operation_id
          WHERE evidence.test_run_id = ?
          ORDER BY evidence.created_at, evidence.id`,
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
      executions: executionRows.map((entry) => ({
        id: parseJson<TestExecutionRequest>(String(entry.requestJson))
          .operationId,
        state: String(
          entry.state,
        ) as TestRunView["executions"][number]["state"],
        requestHash: String(entry.requestHash),
        receiptHash: entry.receiptHash ? String(entry.receiptHash) : null,
      })),
      assertions: assertionRows.map((entry) => ({
        id: String(entry.id),
        operationId: parseJson<TestExecutionRequest>(
          String(entry.operationRequestJson),
        ).operationId,
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
        operationId: parseJson<TestExecutionRequest>(
          String(entry.operationRequestJson),
        ).operationId,
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
        evidence: parseJson<TestDefectEvidence>(String(entry.evidenceJson)),
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
    if (
      authority.manifest.projectId !== input.projectId ||
      authority.manifest.runId !== input.runId ||
      authority.manifest.snapshotRevisionId !== input.snapshotRevisionId
    ) {
      throw new TestRuntimeError(
        "INTEGRATION_AUTHORITY_LINEAGE_MISMATCH",
        "A Test Run must bind the exact Project, Run, and Snapshot Revision frozen by its Integration Generation.",
      );
    }
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
    const coveredRevisions = input.testCaseRevisions.map((entry) => {
      const revision = readCaseRevision(entry.id);
      if (
        revision.projectId !== input.projectId ||
        revision.manifestHash !== entry.hash
      )
        throw new TestRuntimeError(
          "TEST_CASE_COVERAGE_CONFLICT",
          `Test Case revision ${entry.id} does not match its frozen coverage hash.`,
        );
      return revision;
    });
    const testCaseRevisions = [...input.testCaseRevisions].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    if (testCaseRevisions.length === 0)
      throw new TestRuntimeError(
        "TEST_CASE_COVERAGE_INCOMPLETE",
        "A Test Run requires at least one Test Case revision.",
      );
    if (
      input.executionOperations.length === 0 ||
      new Set(input.executionOperations.map((operation) => operation.id))
        .size !== input.executionOperations.length
    ) {
      throw new TestRuntimeError(
        "TEST_EXECUTION_CHECKLIST_INVALID",
        "A Test Run requires a non-empty frozen checklist with unique operation IDs.",
      );
    }
    const derivedFixture = coveredRevisions[0]!.manifest.fixture;
    if (
      coveredRevisions.some(
        (revision) =>
          canonicalJson(revision.manifest.fixture) !==
          canonicalJson(derivedFixture),
      ) ||
      canonicalJson({
        ...input.fixture,
        scriptHashes: sortedUnique(input.fixture.scriptHashes),
      }) !== canonicalJson(derivedFixture)
    ) {
      throw new TestRuntimeError(
        "TEST_FIXTURE_MANIFEST_CONFLICT",
        "The Test Run fixture must be derived exactly from its frozen Test Case revisions.",
      );
    }
    const derivedOperations = coveredRevisions
      .flatMap((revision) => revision.manifest.executionOperations)
      .sort((left, right) => left.id.localeCompare(right.id));
    const operationById = new Map<string, (typeof derivedOperations)[number]>();
    for (const operation of derivedOperations) {
      const existing = operationById.get(operation.id);
      if (existing && canonicalJson(existing) !== canonicalJson(operation)) {
        throw new TestRuntimeError(
          "TEST_EXECUTION_CHECKLIST_CONFLICT",
          `Frozen Test Case revisions disagree about operation ${operation.id}.`,
        );
      }
      operationById.set(operation.id, operation);
    }
    const canonicalDerivedOperations = [...operationById.values()].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    const canonicalInputOperations = [...input.executionOperations].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    if (
      canonicalJson(canonicalInputOperations) !==
      canonicalJson(canonicalDerivedOperations)
    ) {
      throw new TestRuntimeError(
        "TEST_EXECUTION_CHECKLIST_CONFLICT",
        "The Test Run operation checklist must be derived exactly from its frozen Test Case revisions.",
      );
    }
    const fixtureAuthority = options.fixtureAuthority?.read(input.fixture.id);
    if (
      !fixtureAuthority ||
      fixtureAuthority.fixtureId !== input.fixture.id ||
      fixtureAuthority.companyDirectoryFingerprint !==
        input.companyDirectoryFingerprint ||
      canonicalJson(sortedUnique(fixtureAuthority.scriptHashes)) !==
        canonicalJson(sortedUnique(input.fixture.scriptHashes)) ||
      canonicalJson(sortedUnique(fixtureAuthority.adapterIds)) !==
        canonicalJson(
          sortedUnique(
            input.executionOperations.map((entry) => entry.adapterId),
          ),
        )
    ) {
      throw new TestRuntimeError(
        "TEST_FIXTURE_AUTHORITY_INVALID",
        "The Test Run fixture and Company Directory fingerprint must resolve from trusted Runtime fixture authority.",
      );
    }
    const tierRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
    const rules = [...input.risk.policy.rules].sort((left, right) =>
      left.factorId.localeCompare(right.factorId),
    );
    const factors = [...input.risk.factors]
      .map((factor) => ({
        ...factor,
        evidenceRefs: sortedUnique(factor.evidenceRefs),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const policyHash = sha256({
      schemaVersion: 1,
      revisionId: input.risk.policy.revisionId,
      rules,
    });
    const computedTier = factors
      .filter((factor) => factor.present)
      .reduce<TestScopeRiskInput["computedTier"]>((tier, factor) => {
        const rule = rules.find(
          (candidate) => candidate.factorId === factor.id,
        );
        if (!rule) return tier;
        return tierRank[rule.minimumTier] > tierRank[tier]
          ? rule.minimumTier
          : tier;
      }, "low");
    const riskInputHash = sha256({
      schemaVersion: 1,
      policyRevisionId: input.risk.policy.revisionId,
      policyHash,
      factors,
      evidenceRefs: sortedUnique(input.risk.evidenceRefs),
    });
    if (
      input.risk.schemaVersion !== 1 ||
      input.risk.policy.hash !== policyHash ||
      input.risk.inputHash !== riskInputHash ||
      input.risk.computedTier !== computedTier ||
      new Set(rules.map((rule) => rule.factorId)).size !== rules.length ||
      new Set(factors.map((factor) => factor.id)).size !== factors.length ||
      factors.some((factor) =>
        factor.present ? factor.evidenceRefs.length === 0 : false,
      )
    ) {
      throw new TestRuntimeError(
        "TEST_SCOPE_RISK_INVALID",
        "The Test scope risk input must carry the exact policy hash, deterministic factors, computed tier, and evidence.",
      );
    }
    const snapshot = database
      .prepare(
        "SELECT run_id AS runId, canonical_json AS canonicalJson FROM run_snapshot_revisions WHERE id = ?",
      )
      .get(input.snapshotRevisionId) as
      | { readonly runId: string; readonly canonicalJson: string }
      | undefined;
    if (!snapshot || snapshot.runId !== input.runId) {
      throw new TestRuntimeError(
        "TEST_SNAPSHOT_AUTHORITY_INVALID",
        "A Test Run must bind an existing Snapshot Revision owned by the exact Department Run.",
      );
    }
    const snapshotPayload = parseJson<{
      readonly executionProfiles?: readonly unknown[];
    }>(snapshot.canonicalJson);
    const frozenProfile = snapshotPayload.executionProfiles?.find(
      (profile) =>
        profile !== null &&
        typeof profile === "object" &&
        "id" in profile &&
        (profile as { readonly id: unknown }).id === input.executionProfile.id,
    );
    if (
      !frozenProfile ||
      sha256(frozenProfile) !== input.executionProfile.hash
    ) {
      throw new TestRuntimeError(
        "TEST_EXECUTION_PROFILE_INVALID",
        "The Test Run Execution Profile must be derived from the exact frozen Snapshot Revision.",
      );
    }
    const build = database
      .prepare(
        `SELECT versions.content_hash AS contentHash, versions.status,
                versions.producing_run_id AS producingRunId,
                versions.snapshot_revision_id AS snapshotRevisionId,
                artifacts.project_id AS projectId, artifacts.type
           FROM artifact_versions AS versions
           JOIN artifacts ON artifacts.id = versions.artifact_id
          WHERE versions.id = ?`,
      )
      .get(input.build.artifactVersionId) as
      | {
          readonly contentHash: string;
          readonly status: string;
          readonly producingRunId: string | null;
          readonly snapshotRevisionId: string | null;
          readonly projectId: string;
          readonly type: string;
        }
      | undefined;
    const authoritativeBuild = (() => {
      if (!options.artifacts?.inspect) return null;
      try {
        return options.artifacts.inspect(input.build.artifactVersionId).version;
      } catch {
        return null;
      }
    })();
    if (
      !build ||
      build.projectId !== input.projectId ||
      build.type !== "build" ||
      !["produced", "accepted"].includes(build.status) ||
      build.contentHash !== input.build.digest ||
      (authoritativeBuild?.producer.runId ?? build.producingRunId) !==
        input.runId ||
      (authoritativeBuild?.producer.snapshotRevisionId ??
        build.snapshotRevisionId) !== input.snapshotRevisionId
    ) {
      throw new TestRuntimeError(
        "TEST_BUILD_AUTHORITY_INVALID",
        "The Test Run build identity must resolve to an exact produced Artifact Version for the same Run and Snapshot Revision.",
      );
    }
    const tester = database
      .prepare(
        `SELECT sessions.project_id AS projectId, sessions.run_id AS runId,
                sessions.node_run_id AS nodeRunId, sessions.status,
                participants.participant_ref AS aiMemberId,
                positions.id AS positionId
           FROM interaction_sessions AS sessions
           JOIN session_participants AS participants
             ON participants.session_id = sessions.id
            AND participants.participant_type = 'ai-member'
            AND participants.role = 'test-engineer'
           JOIN positions ON positions.ai_member_id = participants.participant_ref
          WHERE sessions.id = ?`,
      )
      .get(input.sessionId) as
      | {
          readonly projectId: string;
          readonly runId: string | null;
          readonly nodeRunId: string | null;
          readonly status: string;
          readonly aiMemberId: string;
          readonly positionId: string;
        }
      | undefined;
    const ownerPositionIds = new Set(
      coveredRevisions.map((revision) => revision.manifest.ownerPositionId),
    );
    if (
      !tester ||
      tester.projectId !== input.projectId ||
      tester.runId !== input.runId ||
      tester.nodeRunId !== input.nodeRunId ||
      tester.status !== "active" ||
      !ownerPositionIds.has(tester.positionId)
    ) {
      throw new TestRuntimeError(
        "TEST_ENGINEER_SESSION_INELIGIBLE",
        "A Test Run requires an active independent Test engineer Session owned by the frozen Test Case revisions.",
      );
    }
    const packageByVersion = new Map(
      authority.manifest.packages.map((entry) => [
        entry.workPackageVersionId,
        entry,
      ]),
    );
    const casePackageCoverage = new Map(
      coveredRevisions.flatMap((revision) =>
        revision.manifest.workPackageVersions.map(
          (entry) => [entry.workPackageVersionId, entry] as const,
        ),
      ),
    );
    const uncoveredPackage = [...packageByVersion.keys()].find(
      (versionId) => !casePackageCoverage.has(versionId),
    );
    const requiredAcceptanceCriteria = sortedUnique(
      authority.manifest.packages.flatMap(
        (entry) => entry.reviewContext.acceptanceCriteria,
      ),
    );
    const coveredRequirements = new Set(
      coveredRevisions.flatMap((revision) => revision.manifest.requirementIds),
    );
    const uncoveredRequirement = requiredAcceptanceCriteria.find(
      (requirement) => !coveredRequirements.has(requirement),
    );
    if (uncoveredPackage || uncoveredRequirement) {
      throw new TestRuntimeError(
        "TEST_CASE_COVERAGE_INCOMPLETE",
        `Frozen Test Case revisions do not cover ${uncoveredPackage ?? uncoveredRequirement}.`,
      );
    }
    for (const [versionId, coverage] of casePackageCoverage) {
      if (!packageByVersion.has(versionId)) continue;
      const persisted = database
        .prepare(
          "SELECT manifest_hash AS manifestHash FROM work_package_versions WHERE id = ?",
        )
        .get(versionId) as { readonly manifestHash: string } | undefined;
      if (!persisted || persisted.manifestHash !== coverage.manifestHash) {
        throw new TestRuntimeError(
          "TEST_CASE_COVERAGE_CONFLICT",
          `Test Case coverage for Work Package Version ${versionId} does not match its immutable manifest.`,
        );
      }
    }
    const producerCollision =
      authority.manifest.packages.length === 0
        ? undefined
        : database
            .prepare(
              `SELECT assignments.id
                 FROM work_package_assignments AS assignments
                WHERE assignments.work_package_version_id IN (${authority.manifest.packages.map(() => "?").join(",")})
                  AND (assignments.ai_member_id = ? OR assignments.interaction_session_id = ?)
                LIMIT 1`,
            )
            .get(
              ...authority.manifest.packages.map(
                (entry) => entry.workPackageVersionId,
              ),
              tester.aiMemberId,
              input.sessionId,
            );
    if (producerCollision) {
      throw new TestRuntimeError(
        "TEST_ENGINEER_NOT_INDEPENDENT",
        "The Test engineer Session must be independent from every implementation Agent and Session in the Integration Generation.",
      );
    }
    [
      input.integrationAuthority.manifestHash,
      input.integrationAuthority.passAuthorityHash,
      input.build.digest,
      input.executionProfile.hash,
      input.companyDirectoryFingerprint,
      input.risk.policy.hash,
      input.risk.inputHash,
      ...input.fixture.scriptHashes,
      ...input.executionOperations.map((operation) => operation.inputHash),
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
      executionOperations: [...input.executionOperations].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      capabilities: sortedUnique(input.capabilities),
      risk: {
        ...input.risk,
        policy: { ...input.risk.policy, rules },
        factors,
        evidenceRefs: sortedUnique(input.risk.evidenceRefs),
      },
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
    adapterId: string,
  ): TestExecutionRequest => {
    const declared = run.manifest.executionOperations.find(
      (operation) => operation.id === operationId,
    );
    if (
      !declared ||
      declared.adapterId !== adapterId ||
      declared.inputHash !== sha256(input) ||
      canonicalJson(declared.input) !== canonicalJson(input)
    ) {
      throw new TestRuntimeError(
        "TEST_EXECUTION_NOT_DECLARED",
        `Test execution ${operationId} does not match the frozen operation checklist.`,
      );
    }
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
    if (
      (fact.state === "succeeded" && fact.providerReceipt === undefined) ||
      (["cancelled", "not-started"].includes(fact.state) &&
        (fact.providerReceipt === undefined || !fact.evidenceRef?.trim()))
    ) {
      throw new TestRuntimeError(
        "TEST_EXECUTION_RECEIPT_MISSING",
        `Terminal Test execution ${request.operationId} requires an exact provider receipt and evidence reference.`,
      );
    }
    let executionResult: TestExecutionResult | undefined;
    if (fact.state === "succeeded" && fact.result !== undefined) {
      const parsed = TestExecutionResultSchema.safeParse(fact.result);
      if (!parsed.success) {
        throw new TestRuntimeError(
          "TEST_EXECUTION_RESULT_INVALID",
          `Succeeded Test execution ${request.operationId} returned an invalid versioned result.`,
        );
      }
      executionResult = parsed.data;
    }
    const run = readRun(request.testRunId);
    const declaredOperation = run.manifest.executionOperations.find(
      (operation) => operation.id === request.operationId,
    );
    if (fact.state === "succeeded" && declaredOperation?.kind === "cleanup") {
      const receipt = TestCleanupReceiptSchema.safeParse(fact.providerReceipt);
      const cleanupContracts = run.manifest.testCaseRevisions
        .map((entry) => readCaseRevision(entry.id))
        .filter(
          (revision) =>
            revision.manifest.cleanup.operationId === request.operationId,
        )
        .map((revision) => revision.manifest.cleanup);
      const cleanup = cleanupContracts[0];
      const expectedTargets = cleanup?.targets
        .map((target) => ({ ...target, state: "absent" as const }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
      const receiptTargets = receipt.success
        ? [...receipt.data.targets].sort((left, right) =>
            left.kind.localeCompare(right.kind),
          )
        : [];
      const cleanupEvidence = executionResult?.evidence.filter(
        (entry) => entry.kind === "cleanup",
      );
      if (
        !receipt.success ||
        !cleanup ||
        cleanupContracts.some(
          (candidate) => canonicalJson(candidate) !== canonicalJson(cleanup),
        ) ||
        receipt.data.fixtureId !== run.manifest.fixture.id ||
        receipt.data.operationKey !== request.operationKey ||
        receipt.data.rootFingerprint !== cleanup.rootFingerprint ||
        canonicalJson(receiptTargets) !== canonicalJson(expectedTargets) ||
        !cleanupEvidence ||
        cleanupEvidence.length !== cleanupContracts.length ||
        cleanupEvidence.some(
          (entry) =>
            entry.artifactVersionId !== receipt.data.artifactVersionId ||
            entry.contentHash !== receipt.data.contentHash,
        )
      ) {
        throw new TestRuntimeError(
          "TEST_CLEANUP_FACT_INVALID",
          "A cleanup operation requires an exact Runtime-owned terminal post-delete receipt and matching Artifact evidence for every frozen cleanup contract.",
        );
      }
    }
    const now = clock().toISOString();
    const factHash = sha256(fact);
    const storageId = executionStorageId(
      request.testRunId,
      request.operationId,
    );
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
                ? "not-started"
                : "reconciling";
    workerUnitOfWork({
      commandId: `${request.operationKey}:fact:${factHash}`,
      request: { request, factHash },
      result: () => ({ operationId: request.operationId, state: nextState }),
      operation: () => {
        database
          .prepare(
            "INSERT OR IGNORE INTO test_execution_facts(id, operation_id, state, fact_json, fact_hash, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            nextId(),
            storageId,
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
            storageId,
            request.requestHash,
          );
        if (executionResult) {
          materializeExecutionResult(request, executionResult);
        }
        if (nextState === "failed") {
          const failedRun = readRun(request.testRunId);
          const firstRevision = failedRun.manifest.testCaseRevisions[0];
          const firstAssertion = firstRevision
            ? readCaseRevision(firstRevision.id).manifest.assertions[0]
            : undefined;
          if (!firstRevision) {
            throw new TestRuntimeError(
              "TEST_CASE_COVERAGE_INCOMPLETE",
              "A failed Test execution cannot be attributed without frozen Test Case coverage.",
            );
          }
          const defectId = `test-defect:${request.operationId}`;
          const responsibility: TestDefectResponsibility = {
            kind: "unknown",
            candidateWorkPackageVersionIds:
              failedRun.manifest.integrationCoverage.packageAuthorities
                .map((entry) => entry.workPackageVersionId)
                .sort(),
            reason:
              "Terminal Test execution failed before responsibility could be uniquely proven.",
          };
          const evidence: TestDefectEvidence = {
            schemaVersion: 1,
            kind: "execution",
            operationId: request.operationId,
            operationKey: request.operationKey,
            requestHash: request.requestHash,
            factHash,
            evidenceRefs: [fact.evidenceRef ?? `execution-fact:${factHash}`],
            providerReceiptHash:
              fact.providerReceipt === undefined
                ? null
                : sha256(fact.providerReceipt),
          };
          const insertedDefect = database
            .prepare(
              `INSERT OR IGNORE INTO test_defects(
               id, test_run_id, test_case_revision_id, assertion_id,
               integration_generation_id, responsibility_json, evidence_json,
               status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            )
            .run(
              defectId,
              request.testRunId,
              firstRevision.id,
              firstAssertion?.id ?? null,
              failedRun.manifest.integrationAuthority.generationId,
              canonicalJson(responsibility),
              canonicalJson(evidence),
              now,
            );
          const obligationId = `test-obligation:${request.operationId}`;
          database
            .prepare(
              `INSERT OR IGNORE INTO test_run_obligations(
               id, test_run_id, description, evidence_json, status, created_at
             ) VALUES (?, ?, ?, ?, 'open', ?)`,
            )
            .run(
              obligationId,
              request.testRunId,
              "Resolve the terminal Test execution failure with fresh evidence and rerun the affected Test Case revision.",
              canonicalJson(evidence),
              now,
            );
          if (Number(insertedDefect.changes) === 1) {
            appendEvent({
              type: "test.defect.created",
              projectId: failedRun.manifest.projectId,
              runId: failedRun.manifest.runId,
              nodeRunId: failedRun.manifest.nodeRunId,
              testRunId: failedRun.id,
              defectId,
              payload: {
                testRunId: failedRun.id,
                defectId,
                operationId: request.operationId,
              },
              timestamp: now,
            });
          }
        }
        database
          .prepare(
            "UPDATE test_runs SET state = ?, updated_at = ? WHERE id = ? AND state NOT IN ('passed', 'failed', 'blocked', 'cancelled')",
          )
          .run(
            nextState === "succeeded"
              ? "running"
              : nextState === "not-started"
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
              : nextState === "reconciling" || nextState === "not-started"
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
                : nextState === "not-started"
                  ? "reconciling"
                  : nextState,
            operationId: request.operationId,
          },
          timestamp: now,
        });
      },
    });
  };

  const markExecutionDispatched = (request: TestExecutionRequest): void => {
    const now = clock().toISOString();
    workerUnitOfWork({
      commandId: `${request.operationKey}:dispatch`,
      request: { requestHash: request.requestHash, state: "running" },
      result: () => ({ operationId: request.operationId, state: "running" }),
      operation: () => {
        const updated = database
          .prepare(
            `UPDATE test_execution_operations
                SET state = 'running', updated_at = ?
              WHERE id = ? AND request_hash = ? AND state IN ('intent', 'not-started')`,
          )
          .run(
            now,
            executionStorageId(request.testRunId, request.operationId),
            request.requestHash,
          );
        if (updated.changes !== 1) {
          throw new TestRuntimeError(
            "TEST_EXECUTION_RECONCILIATION_REQUIRED",
            `Test execution ${request.operationId} is not safe to dispatch.`,
          );
        }
        const run = readRun(request.testRunId);
        appendEvent({
          type: "test.run.started",
          projectId: run.manifest.projectId,
          runId: run.manifest.runId,
          nodeRunId: run.manifest.nodeRunId,
          testRunId: run.id,
          payload: {
            testRunId: run.id,
            state: "running",
            operationId: request.operationId,
          },
          timestamp: now,
        });
      },
    });
  };

  const execute: TestRuntime["execute"] = async (input) => {
    const run = readRun(input.testRunId);
    if (["passed", "failed", "blocked", "cancelled"].includes(run.state))
      return run;
    const request = operationRequest(
      run,
      input.operationId,
      input.input,
      input.adapter.id,
    );
    const existing = database
      .prepare(
        "SELECT request_hash AS requestHash, state, fact_json AS factJson FROM test_execution_operations WHERE id = ? OR operation_key = ?",
      )
      .get(
        executionStorageId(input.testRunId, input.operationId),
        request.operationKey,
      ) as
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
        existing.state === "not-started" &&
        existing.factJson !== null &&
        parseJson<TestExecutionFact>(existing.factJson).state === "not-started";
      if (!reconciledNotStarted)
        throw new TestRuntimeError(
          "TEST_EXECUTION_RECONCILIATION_REQUIRED",
          `Test execution ${input.operationId} must be reconciled before another effect can run.`,
        );
      markExecutionDispatched(request);
      const fact = await input.adapter.execute(request);
      input.failureInjection?.("after-effect");
      persistFact(request, fact);
      return readRun(input.testRunId);
    }
    const now = clock().toISOString();
    workerUnitOfWork({
      commandId: `${request.operationKey}:intent`,
      request: { request },
      result: () => ({ operationId: request.operationId, state: "intent" }),
      operation: () => {
        database
          .prepare(
            "INSERT INTO test_execution_operations(id, test_run_id, operation_key, request_json, request_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)",
          )
          .run(
            executionStorageId(input.testRunId, input.operationId),
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
        const intentRun = readRun(input.testRunId);
        appendEvent({
          type: "test.run.started",
          projectId: intentRun.manifest.projectId,
          runId: intentRun.manifest.runId,
          nodeRunId: intentRun.manifest.nodeRunId,
          testRunId: intentRun.id,
          payload: {
            testRunId: intentRun.id,
            state: "running",
            operationId: request.operationId,
          },
          timestamp: now,
        });
      },
    });
    input.failureInjection?.("after-intent");
    markExecutionDispatched(request);
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
      .get(
        executionStorageId(input.testRunId, input.operationId),
        input.testRunId,
      ) as { readonly requestJson: string; readonly state: string } | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_EXECUTION_NOT_FOUND",
        `Test execution ${input.operationId} was not found.`,
      );
    if (["succeeded", "failed", "cancelled"].includes(row.state)) return run;
    const request = parseJson<TestExecutionRequest>(row.requestJson);
    operationRequest(
      readRun(input.testRunId),
      request.operationId,
      request.input,
      input.adapter.id,
    );
    database
      .prepare(
        "UPDATE test_execution_operations SET state = 'reconciling', updated_at = ? WHERE id = ?",
      )
      .run(
        clock().toISOString(),
        executionStorageId(input.testRunId, input.operationId),
      );
    const fact = await input.adapter.reconcile(request);
    persistFact(request, fact);
    return readRun(input.testRunId);
  };

  const cancel: TestRuntime["cancel"] = async (input) => {
    const row = database
      .prepare(
        "SELECT request_json AS requestJson, state FROM test_execution_operations WHERE id = ? AND test_run_id = ?",
      )
      .get(
        executionStorageId(input.testRunId, input.operationId),
        input.testRunId,
      ) as { readonly requestJson: string; readonly state: string } | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_EXECUTION_NOT_FOUND",
        `Test execution ${input.operationId} was not found.`,
      );
    if (["succeeded", "failed", "cancelled"].includes(row.state))
      return readRun(input.testRunId);
    const request = parseJson<TestExecutionRequest>(row.requestJson);
    operationRequest(
      readRun(input.testRunId),
      request.operationId,
      request.input,
      input.adapter.id,
    );
    const controlRequest = {
      schemaVersion: 1 as const,
      cancelOperationId: input.cancelOperationId,
      operationId: request.operationId,
      kind: input.kind ?? "cancel",
      operationKey: `${request.operationKey}:${input.kind ?? "cancel"}:${input.cancelOperationId}`,
      requestHash: sha256({
        cancelOperationId: input.cancelOperationId,
        kind: input.kind ?? "cancel",
        operationKey: request.operationKey,
      }),
    };
    const existing = database
      .prepare(
        `SELECT id, request_hash AS requestHash, state
           FROM test_execution_control_operations
          WHERE id = ? OR operation_key = ?`,
      )
      .get(input.cancelOperationId, controlRequest.operationKey) as
      | {
          readonly id: string;
          readonly requestHash: string;
          readonly state: string;
        }
      | undefined;
    if (existing && existing.requestHash !== controlRequest.requestHash) {
      throw new TestRuntimeError(
        "TEST_CANCEL_CONFLICT",
        `Test cancel operation ${input.cancelOperationId} already has different immutable input.`,
      );
    }
    if (existing?.state === "cancelled") return readRun(input.testRunId);
    if (!existing) {
      const now = clock().toISOString();
      workerUnitOfWork({
        commandId: `${controlRequest.operationKey}:intent`,
        request: controlRequest,
        result: () => ({
          cancelOperationId: input.cancelOperationId,
          state: "intent",
        }),
        operation: () => {
          database
            .prepare(
              `INSERT INTO test_execution_control_operations(
                 id, operation_id, kind, operation_key, request_json,
                 request_hash, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
            )
            .run(
              input.cancelOperationId,
              executionStorageId(input.testRunId, input.operationId),
              input.kind ?? "cancel",
              controlRequest.operationKey,
              canonicalJson(controlRequest),
              controlRequest.requestHash,
              now,
              now,
            );
          database
            .prepare(
              `UPDATE test_execution_operations SET state = 'reconciling', updated_at = ?
                WHERE id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
            )
            .run(now, executionStorageId(input.testRunId, input.operationId));
          database
            .prepare(
              `UPDATE test_runs SET state = 'reconciling', updated_at = ?
                WHERE id = ? AND state NOT IN ('passed', 'failed', 'blocked', 'cancelled')`,
            )
            .run(now, input.testRunId);
          const cancelRun = readRun(input.testRunId);
          appendEvent({
            type: "test.run.reconciling",
            projectId: cancelRun.manifest.projectId,
            runId: cancelRun.manifest.runId,
            nodeRunId: cancelRun.manifest.nodeRunId,
            testRunId: cancelRun.id,
            payload: {
              testRunId: cancelRun.id,
              state: "reconciling",
              operationId: request.operationId,
            },
            timestamp: now,
          });
        },
      });
      input.failureInjection?.("after-cancel-intent");
    }
    const currentState = existing?.state ?? "intent";
    const fact =
      currentState === "not-started"
        ? input.adapter.cancel
          ? await input.adapter.cancel(request)
          : ({ state: "unknown" } as const)
        : existing
          ? await input.adapter.reconcile(request)
          : input.adapter.cancel
            ? await input.adapter.cancel(request)
            : ({ state: "unknown" } as const);
    input.failureInjection?.("after-cancel-effect");
    if (
      ["cancelled", "not-started"].includes(fact.state) &&
      (fact.providerReceipt === undefined || !fact.evidenceRef?.trim())
    ) {
      throw new TestRuntimeError(
        "TEST_CANCEL_RECEIPT_MISSING",
        `Test cancel operation ${input.cancelOperationId} requires an exact provider receipt and evidence reference.`,
      );
    }
    const factHash = sha256(fact);
    const nextControlState =
      fact.state === "cancelled"
        ? "cancelled"
        : fact.state === "not-started"
          ? "not-started"
          : fact.state === "unknown"
            ? "unknown"
            : "reconciling";
    const now = clock().toISOString();
    workerUnitOfWork({
      commandId: `${controlRequest.operationKey}:fact:${factHash}`,
      request: { controlRequest, factHash },
      result: () => ({
        cancelOperationId: input.cancelOperationId,
        state: nextControlState,
      }),
      operation: () => {
        database
          .prepare(
            `UPDATE test_execution_control_operations
                SET state = ?, fact_json = ?, fact_hash = ?, receipt_json = ?,
                    receipt_hash = ?, updated_at = ?
              WHERE id = ? AND request_hash = ?`,
          )
          .run(
            nextControlState,
            canonicalJson(fact),
            factHash,
            fact.providerReceipt === undefined
              ? null
              : canonicalJson(fact.providerReceipt),
            fact.providerReceipt === undefined
              ? null
              : sha256(fact.providerReceipt),
            now,
            input.cancelOperationId,
            controlRequest.requestHash,
          );
        database
          .prepare(
            `UPDATE test_execution_operations
                SET state = ?, fact_json = ?, fact_hash = ?, receipt_json = ?,
                    receipt_hash = ?, updated_at = ?
              WHERE id = ? AND request_hash = ?`,
          )
          .run(
            nextControlState === "cancelled"
              ? "cancelled"
              : nextControlState === "unknown"
                ? "unknown"
                : "reconciling",
            canonicalJson(fact),
            factHash,
            fact.providerReceipt === undefined
              ? null
              : canonicalJson(fact.providerReceipt),
            fact.providerReceipt === undefined
              ? null
              : sha256(fact.providerReceipt),
            now,
            executionStorageId(request.testRunId, request.operationId),
            request.requestHash,
          );
        const nextRunState =
          nextControlState === "cancelled" &&
          (input.kind ?? "cancel") === "cancel"
            ? "cancelled"
            : nextControlState === "unknown"
              ? "unknown"
              : "reconciling";
        database
          .prepare(
            `UPDATE test_runs SET state = ?, updated_at = ?
              WHERE id = ? AND state NOT IN ('passed', 'failed', 'blocked', 'cancelled')`,
          )
          .run(nextRunState, now, input.testRunId);
        const cancelRun = readRun(input.testRunId);
        appendEvent({
          type:
            nextRunState === "cancelled"
              ? "test.run.cancelled"
              : nextRunState === "unknown"
                ? "test.run.unknown"
                : "test.run.reconciling",
          projectId: cancelRun.manifest.projectId,
          runId: cancelRun.manifest.runId,
          nodeRunId: cancelRun.manifest.nodeRunId,
          testRunId: cancelRun.id,
          payload: {
            testRunId: cancelRun.id,
            state: nextRunState,
            operationId: request.operationId,
          },
          timestamp: now,
        });
      },
    });
    return readRun(input.testRunId);
  };

  const requireSucceededOperation = (
    testRunId: string,
    operationId: string,
  ): void => {
    const operation = database
      .prepare(
        `SELECT state, receipt_hash AS receiptHash
           FROM test_execution_operations
          WHERE id = ? AND test_run_id = ?`,
      )
      .get(executionStorageId(testRunId, operationId), testRunId) as
      | { readonly state: string; readonly receiptHash: string | null }
      | undefined;
    if (
      !operation ||
      operation.state !== "succeeded" ||
      operation.receiptHash === null
    ) {
      throw new TestRuntimeError(
        "TEST_OBSERVATION_SOURCE_INVALID",
        "Test assertions and evidence may only be written by an exact succeeded execution operation with a terminal receipt.",
      );
    }
  };

  let materializeExecutionResult = (
    _request: TestExecutionRequest,
    _result: TestExecutionResult,
  ): void => {
    throw new TestRuntimeError(
      "TEST_EXECUTION_RESULT_UNAVAILABLE",
      "Test execution result materialization is unavailable.",
    );
  };

  const recordAssertion: TestRuntime["recordAssertion"] = (input) => {
    const run = readRun(input.testRunId);
    if (input.required === false) {
      throw new TestRuntimeError(
        "TEST_ASSERTION_REQUIREDNESS_FROZEN",
        "Assertion requiredness is frozen by the Test Case revision and cannot be overridden by a result writer.",
      );
    }
    requireSucceededOperation(input.testRunId, input.operationId);
    const covered = run.manifest.testCaseRevisions.some(
      (entry) => entry.id === input.testCaseRevisionId,
    );
    const revision = covered
      ? readCaseRevision(input.testCaseRevisionId)
      : null;
    const declared = revision?.manifest.assertions.find(
      (entry) => entry.id === input.assertionId,
    );
    if (!covered || !declared)
      throw new TestRuntimeError(
        "TEST_ASSERTION_NOT_DECLARED",
        `Assertion ${input.assertionId} is not in the frozen Test Run manifest.`,
      );
    if (declared.operationId !== input.operationId) {
      throw new TestRuntimeError(
        "TEST_ASSERTION_OPERATION_MISMATCH",
        `Assertion ${input.assertionId} is owned by frozen Test operation ${declared.operationId}.`,
      );
    }
    const receipt = database
      .prepare(
        "SELECT status, result_json AS resultJson FROM command_deduplication WHERE command_id = ?",
      )
      .get(input.correlation.commandId) as
      | { readonly status: string; readonly resultJson: string }
      | undefined;
    const audit = database
      .prepare(
        `SELECT 1 AS present FROM runtime_audit_records
          WHERE command_id = ? AND run_id = ? AND node_run_id = ? LIMIT 1`,
      )
      .get(
        input.correlation.commandId,
        run.manifest.runId,
        run.manifest.nodeRunId,
      );
    const event = database
      .prepare(
        `SELECT type, run_id AS runId, node_run_id AS nodeRunId,
                project_id AS projectId, scope_json AS scopeJson
           FROM runtime_event_outbox WHERE sequence = ?`,
      )
      .get(input.correlation.eventSequence) as
      | {
          readonly type: string;
          readonly runId: string | null;
          readonly nodeRunId: string | null;
          readonly projectId: string | null;
          readonly scopeJson: string | null;
        }
      | undefined;
    const token = database
      .prepare(
        `SELECT view_hash AS viewHash, sequence
           FROM consumed_view_sync_tokens WHERE token_hash = ?`,
      )
      .get(input.correlation.viewSyncTokenHash) as
      | { readonly viewHash: string; readonly sequence: number }
      | undefined;
    const scope = event?.scopeJson
      ? parseJson<Record<string, unknown>>(event.scopeJson)
      : {};
    const commandSucceeded = (() => {
      if (!receipt || receipt.status !== "completed") return false;
      try {
        return (
          parseJson<{ readonly status?: unknown }>(receipt.resultJson)
            .status === "succeeded"
        );
      } catch {
        return false;
      }
    })();
    if (
      !commandSucceeded ||
      !audit ||
      !event ||
      event.type !== input.correlation.runtimeEventType ||
      event.projectId !== run.manifest.projectId ||
      event.runId !== run.manifest.runId ||
      event.nodeRunId !== run.manifest.nodeRunId ||
      scope.testRunId !== run.id ||
      !token ||
      token.viewHash !== input.correlation.queryViewHash ||
      Number(token.sequence) !== input.correlation.queryAsOfSequence ||
      input.correlation.runId !== run.manifest.runId ||
      input.correlation.snapshotRevisionId !==
        run.manifest.snapshotRevisionId ||
      input.correlation.nodeRunId !== run.manifest.nodeRunId ||
      input.correlation.nodeAttemptId !== run.manifest.nodeAttemptId ||
      input.correlation.sessionId !== run.manifest.sessionId ||
      input.correlation.eventSequence < 0 ||
      input.correlation.queryAsOfSequence < input.correlation.eventSequence
    )
      throw new TestRuntimeError(
        "TEST_ASSERTION_CORRELATION_INVALID",
        "Test assertion correlation does not bind the current authoritative Query View, event sequence, and frozen Runtime lineage.",
      );
    ensureHash(input.correlation.queryViewHash, "queryViewHash");
    const result = {
      testRunId: input.testRunId,
      operationId: input.operationId,
      testCaseRevisionId: input.testCaseRevisionId,
      assertionId: input.assertionId,
      required: true,
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
        "INSERT INTO test_assertion_results(id, test_run_id, operation_id, test_case_revision_id, assertion_id, required, ui_status, runtime_status, correlation_json, result_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.testRunId,
        executionStorageId(input.testRunId, input.operationId),
        input.testCaseRevisionId,
        input.assertionId,
        1,
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
    requireSucceededOperation(input.testRunId, input.operationId);
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
          ? readCaseRevision(input.testCaseRevisionId).manifest.assertions.find(
              (assertion) => assertion.id === input.assertionId,
            )
          : undefined;
      if (!covered || (input.assertionId !== null && !declared)) {
        throw new TestRuntimeError(
          "TEST_EVIDENCE_SCOPE_INVALID",
          "Test evidence must bind a frozen Test Case revision and declared assertion in the Test Run.",
        );
      }
      if (
        input.assertionId !== null &&
        declared?.operationId !== input.operationId
      ) {
        throw new TestRuntimeError(
          "TEST_EVIDENCE_OPERATION_MISMATCH",
          `Evidence for assertion ${input.assertionId} must come from frozen Test operation ${declared?.operationId}.`,
        );
      }
      const cleanup = readCaseRevision(input.testCaseRevisionId).manifest
        .cleanup;
      if (
        input.kind === "cleanup" &&
        (input.assertionId !== null ||
          input.operationId !== cleanup.operationId ||
          input.artifactVersionId === null)
      ) {
        throw new TestRuntimeError(
          "TEST_CLEANUP_EVIDENCE_INVALID",
          "Cleanup evidence must be produced by the frozen cleanup operation and resolve to a verified Artifact Version.",
        );
      }
      if (input.kind === "cleanup") {
        const operation = database
          .prepare(
            `SELECT receipt_json AS receiptJson
               FROM test_execution_operations
              WHERE id = ? AND test_run_id = ? AND state = 'succeeded'`,
          )
          .get(
            executionStorageId(input.testRunId, input.operationId),
            input.testRunId,
          ) as { readonly receiptJson: string | null } | undefined;
        const receipt = operation?.receiptJson
          ? TestCleanupReceiptSchema.safeParse(parseJson(operation.receiptJson))
          : undefined;
        if (
          !receipt?.success ||
          receipt.data.artifactVersionId !== input.artifactVersionId ||
          receipt.data.contentHash !== input.contentHash ||
          receipt.data.rootFingerprint !== cleanup.rootFingerprint
        ) {
          throw new TestRuntimeError(
            "TEST_CLEANUP_EVIDENCE_INVALID",
            "Cleanup evidence must match the exact Runtime-owned terminal post-delete receipt.",
          );
        }
      }
      const policy = readCaseRevision(input.testCaseRevisionId).manifest
        .evidencePolicy;
      if (
        input.redactionProfile !== policy.redactionProfile ||
        input.retentionClass !== policy.retentionClass
      ) {
        throw new TestRuntimeError(
          "TEST_EVIDENCE_POLICY_MISMATCH",
          "Test evidence retention and redaction must match the frozen Test Case revision policy.",
        );
      }
    }
    const artifact = input.artifactVersionId
      ? (database
          .prepare(
            `SELECT versions.content_ref AS contentRef,
                    versions.content_hash AS contentHash,
                    versions.byte_size AS byteSize, versions.status,
                    versions.producing_run_id AS producingRunId,
                    versions.snapshot_revision_id AS snapshotRevisionId,
                    artifacts.project_id AS projectId
               FROM artifact_versions AS versions
               JOIN artifacts ON artifacts.id = versions.artifact_id
              WHERE versions.id = ?`,
          )
          .get(input.artifactVersionId) as
          | {
              readonly contentRef: string;
              readonly contentHash: string;
              readonly byteSize: number;
              readonly status: string;
              readonly producingRunId: string | null;
              readonly snapshotRevisionId: string | null;
              readonly projectId: string;
            }
          | undefined)
      : undefined;
    const verifiedBytes = (() => {
      if (!input.artifactVersionId || !options.artifacts) return null;
      try {
        if (options.artifacts.verify(input.artifactVersionId) !== "verified")
          return null;
        return Buffer.from(
          options.artifacts.readContent(input.artifactVersionId),
        );
      } catch {
        return null;
      }
    })();
    const authoritativeArtifact = (() => {
      if (!input.artifactVersionId || !options.artifacts?.inspect) return null;
      try {
        return options.artifacts.inspect(input.artifactVersionId).version;
      } catch {
        return null;
      }
    })();
    const authoritativeContentRef = options.artifacts?.inspect
      ? authoritativeArtifact?.contentRef
      : artifact?.contentRef;
    const authoritativeProducer = authoritativeArtifact?.producer;
    if (
      !artifact ||
      artifact.projectId !== run.manifest.projectId ||
      (authoritativeProducer?.runId ?? artifact.producingRunId) !==
        run.manifest.runId ||
      (authoritativeProducer?.snapshotRevisionId ??
        artifact.snapshotRevisionId) !== run.manifest.snapshotRevisionId ||
      !["produced", "accepted"].includes(artifact.status) ||
      artifact.contentHash !== input.contentHash ||
      Number(artifact.byteSize) !== input.byteSize ||
      authoritativeContentRef !== input.locator ||
      (options.artifacts !== undefined &&
        (verifiedBytes === null ||
          verifiedBytes.byteLength !== input.byteSize ||
          createHash("sha256").update(verifiedBytes).digest("hex") !==
            input.contentHash))
    ) {
      throw new TestRuntimeError(
        "TEST_EVIDENCE_ARTIFACT_INVALID",
        "Test evidence must resolve to an exact produced and verified Artifact Version.",
      );
    }
    const existing = database
      .prepare(
        `SELECT evidence.test_run_id AS testRunId,
                operations.request_json AS operationRequestJson,
                test_case_revision_id AS testCaseRevisionId,
                assertion_id AS assertionId, kind, media_type AS mediaType,
                content_hash AS contentHash, byte_size AS byteSize,
                artifact_version_id AS artifactVersionId,
                redaction_profile AS redactionProfile,
                retention_class AS retentionClass, locator,
                metadata_json AS metadataJson
           FROM test_evidence AS evidence
           JOIN test_execution_operations AS operations
             ON operations.id = evidence.operation_id
          WHERE evidence.id = ?`,
      )
      .get(input.id) as
      | {
          readonly testRunId: string;
          readonly operationRequestJson: string;
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
        operationId: parseJson<TestExecutionRequest>(
          existing.operationRequestJson,
        ).operationId,
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
        "INSERT INTO test_evidence(id, test_run_id, operation_id, test_case_revision_id, assertion_id, kind, media_type, content_hash, byte_size, artifact_version_id, redaction_profile, retention_class, locator, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.testRunId,
        executionStorageId(input.testRunId, input.operationId),
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

  materializeExecutionResult = (request, result) => {
    for (const evidence of result.evidence) {
      recordEvidence({
        ...evidence,
        operationId: request.operationId,
        testRunId: request.testRunId,
        metadata: evidence.metadata,
      });
    }
    for (const assertion of result.assertions) {
      recordAssertion({
        ...assertion,
        operationId: request.operationId,
        testRunId: request.testRunId,
      });
    }
  };

  const validateDefectResponsibility = (
    run: TestRunView,
    responsibility: TestDefectResponsibility,
  ): void => {
    const authority = options.integrationAuthority.readPassAuthority(
      run.manifest.integrationAuthority.generationId,
    );
    const packages = new Map(
      authority.manifest.packages.map((entry) => [
        entry.workPackageVersionId,
        entry.workPackageId,
      ]),
    );
    const validateCandidates = (candidateIds: readonly string[]): void => {
      if (
        candidateIds.length === 0 ||
        new Set(candidateIds).size !== candidateIds.length ||
        candidateIds.some((candidateId) => !packages.has(candidateId))
      ) {
        throw new TestRuntimeError(
          "TEST_DEFECT_RESPONSIBILITY_INVALID",
          "Test defect responsibility candidates must be unique Work Package Versions frozen by the exact Integration Generation.",
        );
      }
    };
    switch (responsibility.kind) {
      case "work-package":
        if (
          packages.get(responsibility.workPackageVersionId) !==
          responsibility.workPackageId
        ) {
          throw new TestRuntimeError(
            "TEST_DEFECT_RESPONSIBILITY_INVALID",
            "Test defect Work Package responsibility must resolve from the exact Integration Generation lineage.",
          );
        }
        return;
      case "contract": {
        validateCandidates(responsibility.candidateWorkPackageVersionIds);
        const contract = authority.manifest.contractVersions.find(
          (entry) =>
            entry.id === responsibility.contractId &&
            entry.version === responsibility.version &&
            entry.producerApplicationId ===
              responsibility.producerApplicationId &&
            entry.consumerApplicationId ===
              responsibility.consumerApplicationId,
        );
        if (!contract) {
          throw new TestRuntimeError(
            "TEST_DEFECT_RESPONSIBILITY_INVALID",
            "Test defect Contract responsibility must resolve from the exact Integration Generation lineage.",
          );
        }
        return;
      }
      case "aggregate":
      case "unknown":
        validateCandidates(responsibility.candidateWorkPackageVersionIds);
        return;
      case "ui-runtime-contract":
        return;
    }
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
    const evidence = TestDefectEvidenceSchema.safeParse(input.evidence);
    const assertion =
      input.assertionId === undefined
        ? undefined
        : run.assertions.find(
            (entry) =>
              entry.testCaseRevisionId === input.testCaseRevisionId &&
              entry.assertionId === input.assertionId,
          );
    if (
      !evidence.success ||
      input.assertionId === undefined ||
      !assertion ||
      (assertion.uiStatus === "passed" &&
        assertion.runtimeStatus === "passed") ||
      evidence.data.kind !== "assertion" ||
      evidence.data.assertion.testCaseRevisionId !== input.testCaseRevisionId ||
      evidence.data.assertion.assertionId !== input.assertionId ||
      evidence.data.assertion.resultHash !== assertion.resultHash ||
      evidence.data.evidenceRefs.some(
        (reference) =>
          !run.evidence.some(
            (entry) =>
              (entry.id === reference ||
                entry.artifactVersionId === reference) &&
              entry.testCaseRevisionId === input.testCaseRevisionId &&
              entry.assertionId === input.assertionId,
          ),
      )
    ) {
      throw new TestRuntimeError(
        "TEST_DEFECT_EVIDENCE_INVALID",
        "A Test defect requires versioned evidence bound to one non-passing frozen assertion result.",
      );
    }
    validateDefectResponsibility(run, input.responsibility);
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
    const parsedResolution = TestDefectResolutionSchema.safeParse(
      input.resolution,
    );
    if (!parsedResolution.success) {
      throw new TestRuntimeError(
        "TEST_DEFECT_RESOLUTION_INVALID",
        "Closing a Test defect requires a versioned resolution bound to a fresh PASS Test Run.",
      );
    }
    const resolution = parsedResolution.data;
    if (resolution.resolvedByTestRunId === row.testRunId) {
      throw new TestRuntimeError(
        "TEST_DEFECT_RESOLUTION_EVIDENCE_INVALID",
        "A Test defect cannot be resolved by evidence from the failed Test Run itself.",
      );
    }
    const rerun = readRun(resolution.resolvedByTestRunId);
    const original = readRun(row.testRunId);
    const invalidRerun =
      rerun.manifest.projectId !== original.manifest.projectId ||
      rerun.state !== "passed" ||
      rerun.passAuthorityHash !== resolution.passAuthorityHash ||
      authorityHashFor(rerun) !== resolution.passAuthorityHash;
    const invalidAssertion = resolution.assertions.some((entry) => {
      const assertion = rerun.assertions.find(
        (candidate) =>
          candidate.testCaseRevisionId === entry.testCaseRevisionId &&
          candidate.assertionId === entry.assertionId,
      );
      return (
        !assertion ||
        assertion.uiStatus !== "passed" ||
        assertion.runtimeStatus !== "passed" ||
        assertion.resultHash !== entry.resultHash ||
        entry.evidenceRefs.some(
          (reference) =>
            !rerun.evidence.some(
              (evidence) =>
                (evidence.id === reference ||
                  evidence.artifactVersionId === reference) &&
                evidence.testCaseRevisionId === entry.testCaseRevisionId &&
                evidence.assertionId === entry.assertionId,
            ),
        )
      );
    });
    if (invalidRerun || invalidAssertion) {
      throw new TestRuntimeError(
        "TEST_DEFECT_RESOLUTION_EVIDENCE_INVALID",
        "Test defect resolution must match paired passing assertions and immutable evidence from the exact fresh PASS Test Run authority.",
      );
    }
    const now = clock().toISOString();
    const resolutionHash = sha256(resolution);
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
          canonicalJson(resolution),
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

  const reworkRoute = (
    responsibility: TestDefectResponsibility,
  ): TestReworkRoute => {
    switch (responsibility.kind) {
      case "work-package":
        return {
          destination: "work-package",
          workPackageId: responsibility.workPackageId,
          workPackageVersionId: responsibility.workPackageVersionId,
        };
      case "contract":
        return {
          destination: "contract",
          contractId: responsibility.contractId,
          version: responsibility.version,
          producerApplicationId: responsibility.producerApplicationId,
          consumerApplicationId: responsibility.consumerApplicationId,
          candidateWorkPackageVersionIds: sortedUnique(
            responsibility.candidateWorkPackageVersionIds,
          ),
        };
      case "aggregate":
        return {
          destination: "triage",
          responsibility: "aggregate",
          candidateWorkPackageVersionIds: sortedUnique(
            responsibility.candidateWorkPackageVersionIds,
          ),
        };
      case "unknown":
        return {
          destination: "triage",
          responsibility: "unknown",
          candidateWorkPackageVersionIds: sortedUnique(
            responsibility.candidateWorkPackageVersionIds,
          ),
          reason: responsibility.reason,
        };
      case "ui-runtime-contract":
        return {
          destination: "ui-runtime-contract",
          owner: responsibility.owner,
        };
    }
  };

  const frozenIntegrationAuthority = (
    authority: TestRunManifestInput["integrationAuthority"],
  ) => ({
    ...authority,
    repositoryCommits: [...authority.repositoryCommits].sort((left, right) =>
      left.repositoryReference.localeCompare(right.repositoryReference),
    ),
  });

  const createReworkRun: TestRuntime["createReworkRun"] = (input) => {
    const row = database
      .prepare("SELECT test_run_id AS testRunId FROM test_defects WHERE id = ?")
      .get(input.defectId) as { readonly testRunId: string } | undefined;
    if (!row)
      throw new TestRuntimeError(
        "TEST_DEFECT_NOT_FOUND",
        `Test defect ${input.defectId} was not found.`,
      );
    const prior = readRun(row.testRunId);
    const defect = prior.defects.find((entry) => entry.id === input.defectId)!;
    if (!["failed", "blocked", "cancelled"].includes(prior.state)) {
      throw new TestRuntimeError(
        "TEST_REWORK_SOURCE_NOT_TERMINAL",
        `Test Run ${prior.id} must be failed, blocked, or cancelled before rework.`,
      );
    }
    if (
      input.input.testRunId === prior.id ||
      input.input.requestId === prior.requestId
    ) {
      throw new TestRuntimeError(
        "TEST_REWORK_HISTORY_IMMUTABLE",
        "Test rework must create a fresh Test Run and request identity.",
      );
    }
    const sameGeneration =
      input.input.integrationAuthority.generationId ===
      prior.manifest.integrationAuthority.generationId;
    if (
      sameGeneration &&
      canonicalJson(
        frozenIntegrationAuthority(input.input.integrationAuthority),
      ) !==
        canonicalJson(
          frozenIntegrationAuthority(prior.manifest.integrationAuthority),
        )
    ) {
      throw new TestRuntimeError(
        "TEST_REWORK_FRESH_INTEGRATION_REQUIRED",
        "Changed code or Integration input requires fresh Code Review coverage, a fresh PASS Integration Generation, and a fresh Test Run.",
      );
    }
    const run = createRun(input.input);
    return {
      run,
      route: reworkRoute(defect.responsibility),
      lineage: {
        priorTestRunId: prior.id,
        priorManifestHash: prior.manifestHash,
        integrationAuthority: sameGeneration
          ? "reuse-exact-pass"
          : "fresh-pass-authority",
        priorIntegrationGenerationId:
          prior.manifest.integrationAuthority.generationId,
        nextIntegrationGenerationId:
          run.manifest.integrationAuthority.generationId,
      },
    };
  };

  const authorityHashFor = (run: TestRunView): string => {
    const defectResolutions = database
      .prepare(
        `SELECT resolutions.id AS resolutionId, resolutions.defect_id AS defectId,
                resolutions.resolution_hash AS resolutionHash
           FROM test_defect_resolutions AS resolutions
           JOIN test_defects AS defects ON defects.id = resolutions.defect_id
          WHERE defects.test_run_id = ?
          ORDER BY resolutions.defect_id, resolutions.id`,
      )
      .all(run.id) as Array<{
      readonly resolutionId: string;
      readonly defectId: string;
      readonly resolutionHash: string;
    }>;
    const executionOperations = database
      .prepare(
        `SELECT id, request_hash AS requestHash, fact_hash AS factHash,
                receipt_hash AS receiptHash, state
           FROM test_execution_operations WHERE test_run_id = ? ORDER BY id`,
      )
      .all(run.id);
    return sha256({
      schemaVersion: 1,
      testRunId: run.id,
      manifestHash: run.manifestHash,
      integrationAuthority: run.manifest.integrationAuthority,
      coverageHash: run.manifest.coverageHash,
      executionOperations,
      assertionResultHashes: run.assertions
        .map((entry) => entry.resultHash)
        .sort(),
      evidence: run.evidence
        .map((entry) => ({
          id: entry.id,
          contentHash: entry.contentHash,
          artifactVersionId: entry.artifactVersionId,
          locator: entry.locator,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      closedDefects: run.defects
        .map((entry) => ({ id: entry.id, status: entry.status }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      defectResolutions,
      obligations: run.obligations,
    });
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
    const missingCleanup = run.manifest.testCaseRevisions.some((entry) => {
      const revision = readCaseRevision(entry.id);
      return (
        revision.manifest.cleanup.required &&
        !run.evidence.some(
          (evidence) =>
            evidence.testCaseRevisionId === entry.id &&
            evidence.kind === "cleanup" &&
            evidence.operationId === revision.manifest.cleanup.operationId &&
            evidence.artifactVersionId !== null,
        )
      );
    });
    const openDefects = run.defects.filter(
      (defect) => defect.status === "open",
    );
    const openObligations = run.obligations.filter(
      (obligation) => obligation.status === "open",
    );
    const incompleteOperations = run.manifest.executionOperations.filter(
      (operation) => {
        const row = database
          .prepare(
            `SELECT operations.state, operations.receipt_hash AS receiptHash,
                    facts.state AS factState
               FROM test_execution_operations AS operations
               LEFT JOIN test_execution_facts AS facts
                 ON facts.operation_id = operations.id
                AND facts.fact_hash = operations.fact_hash
              WHERE operations.id = ? AND operations.test_run_id = ?`,
          )
          .get(executionStorageId(testRunId, operation.id), testRunId) as
          | {
              readonly state: string;
              readonly receiptHash: string | null;
              readonly factState: string | null;
            }
          | undefined;
        return (
          !row ||
          row.state !== "succeeded" ||
          row.factState !== "succeeded" ||
          row.receiptHash === null
        );
      },
    );
    if (
      missing.length > 0 ||
      failing.length > 0 ||
      incompleteEvidence ||
      missingCleanup ||
      incompleteOperations.length > 0 ||
      openDefects.length > 0 ||
      openObligations.length > 0
    )
      throw new TestRuntimeError(
        "TEST_RUN_PASS_INCOMPLETE",
        "A Test Run cannot PASS without complete paired assertions, immutable evidence, and closed defects and obligations.",
      );
    const passAuthorityHash = authorityHashFor(run);
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
    validateAuthority(run.manifest);
    const openDefectIds = run.defects
      .filter((entry) => entry.status === "open")
      .map((entry) => entry.id)
      .sort();
    const openObligationIds = run.obligations
      .filter((entry) => entry.status === "open")
      .map((entry) => entry.id)
      .sort();
    if (run.state !== "passed" || !run.passAuthorityHash)
      throw new TestRuntimeError(
        "TEST_RUN_NOT_PASS_AUTHORITY",
        `Test Run ${testRunId} is not an immutable PASS authority.`,
      );
    if (openDefectIds.length > 0 || openObligationIds.length > 0)
      throw new TestRuntimeError(
        "TEST_RUN_AUTHORITY_INVALIDATED",
        `Test Run ${testRunId} has open defects or obligations and cannot be consumed downstream.`,
      );
    if (authorityHashFor(run) !== run.passAuthorityHash) {
      throw new TestRuntimeError(
        "TEST_RUN_AUTHORITY_HASH_MISMATCH",
        `Test Run ${testRunId} no longer matches its immutable PASS authority hash.`,
      );
    }
    const defectResolutions = database
      .prepare(
        `SELECT resolutions.id AS resolutionId, resolutions.defect_id AS defectId,
                resolutions.resolution_hash AS resolutionHash
           FROM test_defect_resolutions AS resolutions
           JOIN test_defects AS defects ON defects.id = resolutions.defect_id
          WHERE defects.test_run_id = ?
          ORDER BY resolutions.defect_id, resolutions.id`,
      )
      .all(testRunId) as Array<{
      readonly resolutionId: string;
      readonly defectId: string;
      readonly resolutionHash: string;
    }>;
    return {
      schemaVersion: 1,
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
      risk: run.manifest.risk,
      assertionResultHashes: run.assertions
        .map((entry) => entry.resultHash)
        .sort(),
      evidence: run.evidence
        .map((entry) => ({
          id: entry.id,
          contentHash: entry.contentHash,
          artifactVersionId: entry.artifactVersionId,
          locator: entry.locator,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      evidenceHashes: run.evidence.map((entry) => entry.contentHash).sort(),
      defectResolutions,
      obligations: run.obligations.map((entry) => ({
        id: entry.id,
        status: "closed" as const,
      })),
      openDefectIds,
      openObligationIds,
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
    createReworkRun,
    complete,
    downstreamAuthority,
  };
};
