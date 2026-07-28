import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorRef } from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type {
  CodeReviewRuntime,
  CompletedCodeReviewCoverage,
} from "../review/codeReviewRuntime.js";

export type { CompletedCodeReviewCoverage } from "../review/codeReviewRuntime.js";

export class IntegrationRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationRuntimeError";
  }
}

type CompletedCodeReviewCoveragePackage =
  CompletedCodeReviewCoverage["packages"][number];

type RequiredIntegrationValidation =
  IntegrationGenerationManifest["requiredValidations"][number];

export type GitIntegrationRequest = {
  readonly operationId: string;
  readonly generationId: string;
  readonly repositoryReference: string;
  readonly integrationBranch: string;
  readonly baseCommit: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly expectedTip: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
};

export type GitIntegrationResult =
  | {
      readonly status: "succeeded";
      readonly beforeTip: string;
      readonly afterTip: string;
      readonly resultingCommit: string;
      readonly receipt: unknown;
    }
  | {
      readonly status: "conflict" | "failed";
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    }
  | {
      readonly status: "unknown";
      readonly code: "RECONCILE_UNKNOWN";
      readonly message: string;
      readonly evidence: unknown;
    };

export type GitIntegrationReconciliation =
  | { readonly status: "not-applied" }
  | Extract<GitIntegrationResult, { readonly status: "succeeded" }>
  | Extract<GitIntegrationResult, { readonly status: "unknown" }>
  | {
      readonly status: "conflict";
      readonly code: "INTEGRATION_CONFLICT";
      readonly message: string;
      readonly evidence: unknown;
    };

export interface GitIntegrationAdapter {
  readonly execute: (input: GitIntegrationRequest) => GitIntegrationResult;
  readonly reconcile: (
    input: GitIntegrationRequest,
  ) => GitIntegrationReconciliation;
}

export type IntegrationGenerationManifest = {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly generation: number;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly nodeRunId: string;
  readonly coverageId: string;
  readonly coverageNodeRunId: string;
  readonly coverageNodeAttemptId: string;
  readonly coverageHash: string;
  readonly repositories: readonly {
    readonly repositoryReference: string;
    readonly baseCommit: string;
    readonly integrationBranch: string;
  }[];
  readonly packages: readonly CompletedCodeReviewCoveragePackage[];
  readonly dependencyOrder: readonly string[];
  readonly contractVersions: readonly {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  }[];
  readonly integrationConditions: readonly string[];
  readonly requiredValidations: readonly {
    readonly id: string;
    readonly repositoryReference: string;
    readonly kind: "build-test" | "contract";
    readonly identityHash: string;
    readonly condition?: string;
    readonly contract?: {
      readonly id: string;
      readonly version: string;
      readonly hash: string;
      readonly producerApplicationId: string;
      readonly consumerApplicationId: string;
    };
  }[];
};

export type IntegrationOperationView = {
  readonly id: string;
  readonly repositoryReference: string;
  readonly integrationBranch: string;
  readonly workPackageId: string;
  readonly workPackageVersionId: string;
  readonly authorityId: string;
  readonly qualityGateResultId: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly diffHash: string;
  readonly state:
    | "pending"
    | "intent"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "blocked";
  readonly expectedTip: string | null;
  readonly resultingCommit: string | null;
  readonly requestHash: string | null;
  readonly receiptHash: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
};

export type IntegrationGenerationView = {
  readonly id: string;
  readonly manifest: IntegrationGenerationManifest;
  readonly manifestHash: string;
  readonly state:
    | "pending"
    | "running"
    | "validating"
    | "aggregate-review"
    | "blocked"
    | "failed"
    | "passed";
  readonly repositoryResults: readonly {
    readonly id: string;
    readonly repositoryReference: string;
    readonly baseCommit: string;
    readonly integrationBranch: string;
    readonly state:
      | "pending"
      | "running"
      | "validating"
      | "succeeded"
      | "failed"
      | "blocked";
    readonly expectedTip: string;
    readonly integratedCommit: string | null;
    readonly validationRecords: readonly {
      readonly validationId: string;
      readonly kind: "build-test" | "contract";
      readonly status: "passed" | "failed";
      readonly recordHash: string;
      readonly evidenceRefs: readonly string[];
      readonly responsibleWorkPackageVersionIds: readonly string[];
      readonly contractFailure: unknown | null;
    }[];
  }[];
  readonly operations: readonly IntegrationOperationView[];
  readonly defects: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: "open" | "closed";
    readonly responsibility: unknown;
    readonly evidence: unknown;
  }[];
  readonly aggregateReview: {
    readonly id: string;
    readonly topicId: string;
    readonly qualityGateResultId: string;
    readonly input: unknown;
    readonly inputHash: string;
    readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
    readonly evidence: readonly string[];
  } | null;
  readonly passAuthorityHash: string | null;
};

export type IntegrationEnvelopeCommand =
  | {
      readonly type: "integration.generation.start";
      readonly generationId: string;
      readonly runId: string;
      readonly nodeRunId: string;
    }
  | {
      readonly type: "integration.validation.record";
      readonly generationId: string;
      readonly validationId: string;
      readonly repositoryReference: string;
      readonly status: "passed" | "failed";
      readonly kind: "build-test" | "contract";
      readonly evidenceRefs: readonly string[];
      readonly responsibleWorkPackageVersionIds: readonly string[];
      readonly contractFailure?: {
        readonly producerApplicationId: string;
        readonly consumerApplicationId: string;
        readonly contractId: string;
        readonly contractVersion: string;
        readonly fixtureRef: string;
        readonly runtimeEvidenceRef: string;
      };
    }
  | {
      readonly type: "integration.aggregate-review.record";
      readonly generationId: string;
      readonly topicId: string;
      readonly qualityGateResultId: string;
    };

export interface IntegrationRuntime {
  readonly inspect: (runId: string) => readonly IntegrationGenerationView[];
  readonly inspectPending: () => readonly IntegrationGenerationView[];
  readonly dispatchInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: IntegrationEnvelopeCommand;
  }) => IntegrationGenerationView;
  readonly executePending: (generationId: string) => IntegrationGenerationView;
  readonly reconcilePending: () => number;
  readonly blockPending: (
    generationId: string,
    failure: {
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    },
  ) => IntegrationGenerationView;
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

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const assertRuntimeActor = (actor: ActorRef): void => {
  if (actor.type !== "runtime-worker" || actor.authenticatedBy !== "runtime") {
    throw new IntegrationRuntimeError(
      "PERMISSION_DENIED",
      "Integration Commands require a Runtime worker actor.",
    );
  }
};

const assertSha = (value: string, length: 40 | 64, label: string): void => {
  const pattern = length === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!pattern.test(value)) {
    throw new IntegrationRuntimeError(
      "INTEGRATION_INPUT_INVALID",
      `${label} must be a lowercase ${length}-character hexadecimal identity.`,
    );
  }
};

const topologicalOrder = (
  packages: readonly CompletedCodeReviewCoveragePackage[],
): readonly CompletedCodeReviewCoveragePackage[] => {
  const byVersion = new Map<string, CompletedCodeReviewCoveragePackage>();
  const byPackage = new Set<string>();
  for (const entry of packages) {
    if (
      byVersion.has(entry.workPackageVersionId) ||
      byPackage.has(entry.workPackageId)
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_COVERAGE_DUPLICATE",
        "Completed Code Review coverage contains a duplicate Work Package or Version.",
      );
    }
    byVersion.set(entry.workPackageVersionId, entry);
    byPackage.add(entry.workPackageId);
  }
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(
    packages.map((entry) => [entry.workPackageVersionId, 0]),
  );
  for (const entry of packages) {
    for (const dependency of entry.dependencies) {
      if (!byVersion.has(dependency.predecessorWorkPackageVersionId)) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_DEPENDENCY_MISSING",
          `Work Package Version ${entry.workPackageVersionId} depends on missing reviewed Version ${dependency.predecessorWorkPackageVersionId}.`,
        );
      }
      outgoing.set(dependency.predecessorWorkPackageVersionId, [
        ...(outgoing.get(dependency.predecessorWorkPackageVersionId) ?? []),
        entry.workPackageVersionId,
      ]);
      indegree.set(
        entry.workPackageVersionId,
        (indegree.get(entry.workPackageVersionId) ?? 0) + 1,
      );
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: CompletedCodeReviewCoveragePackage[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byVersion.get(id)!);
    for (const consumer of [...(outgoing.get(id) ?? [])].sort()) {
      const next = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, next);
      if (next === 0) {
        ready.push(consumer);
        ready.sort();
      }
    }
  }
  if (ordered.length !== packages.length) {
    throw new IntegrationRuntimeError(
      "INTEGRATION_DEPENDENCY_CYCLE",
      "Completed Code Review coverage contains a Work Package dependency cycle.",
    );
  }
  return ordered;
};

const requiredValidationsFor = (
  ordered: readonly CompletedCodeReviewCoveragePackage[],
  contractVersions: ReadonlyMap<
    string,
    { readonly id: string; readonly version: string; readonly hash: string }
  >,
): readonly RequiredIntegrationValidation[] => {
  const items: RequiredIntegrationValidation[] = [];
  const repositories = new Map<string, Set<string>>();
  for (const entry of ordered) {
    const conditions = repositories.get(entry.repositoryReference) ?? new Set();
    for (const condition of entry.integrationConditions)
      conditions.add(condition);
    repositories.set(entry.repositoryReference, conditions);
  }
  for (const [repositoryReference, configured] of repositories) {
    const conditions =
      configured.size > 0 ? [...configured] : ["repository build and test"];
    for (const condition of conditions) {
      const identity = {
        kind: "build-test" as const,
        repositoryReference,
        condition,
      };
      const identityHash = sha256(canonicalJson(identity));
      items.push({
        id: `validation:${identityHash}`,
        ...identity,
        identityHash,
      });
    }
  }
  for (const consumer of ordered) {
    for (const dependency of consumer.dependencies.filter(
      (entry) => entry.kind === "contract",
    )) {
      const producer = ordered.find(
        (entry) =>
          entry.workPackageVersionId ===
          dependency.predecessorWorkPackageVersionId,
      )!;
      const contract = contractVersions.get(dependency.contractId!)!;
      const identity = {
        kind: "contract" as const,
        repositoryReference: consumer.repositoryReference,
        contract: {
          id: contract.id,
          version: contract.version,
          hash: contract.hash,
          producerApplicationId: producer.applicationId,
          consumerApplicationId: consumer.applicationId,
        },
      };
      const identityHash = sha256(canonicalJson(identity));
      items.push({
        id: `validation:${identityHash}`,
        ...identity,
        identityHash,
      });
    }
  }
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
};

export const openIntegrationRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: {
      readonly append: (
        input: Parameters<RuntimeEvents["append"]>[0],
      ) => unknown;
    };
    readonly codeReviews: Pick<CodeReviewRuntime, "readCompletedCoverage">;
    readonly pipelineRuntime: {
      readonly startIntegrationInTransaction: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
      }) => void;
      readonly blockIntegrationInTransaction: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
        readonly failure: { readonly code: string; readonly message: string };
      }) => void;
      readonly failIntegrationInTransaction: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
        readonly failure: { readonly code: string; readonly message: string };
      }) => void;
      readonly completeIntegrationInTransaction: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
        readonly passAuthorityHash: string;
        readonly repositoryCommits: readonly {
          readonly repositoryReference: string;
          readonly commit: string;
        }[];
      }) => void;
    };
    readonly gitAdapter: GitIntegrationAdapter;
    readonly reviewRuntime?: {
      readonly inspect: (topicId: string) => {
        readonly gateResult: {
          readonly id: string;
          readonly kind: string;
          readonly manifest: unknown;
          readonly manifestHash: string;
          readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
          readonly conditions: readonly string[];
          readonly evidenceRefs: readonly string[];
        } | null;
      };
    };
    readonly failureInjection?: (
      point: "after-intent" | "after-effect" | "during-failure-finalization",
      operationId: string,
    ) => void;
    readonly clock?: () => Date;
  },
): IntegrationRuntime => {
  const clock = options.clock ?? (() => new Date());

  const readOne = (generationId: string): IntegrationGenerationView => {
    const row = database
      .prepare(
        `SELECT id, manifest_json AS manifestJson, manifest_hash AS manifestHash,
                state, pass_authority_hash AS passAuthorityHash
           FROM integration_generations WHERE id = ?`,
      )
      .get(generationId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_GENERATION_NOT_FOUND",
        `Integration Generation ${generationId} was not found.`,
      );
    }
    const manifest = parseJson<IntegrationGenerationManifest>(
      String(row.manifestJson),
    );
    const repositoryResults = database
      .prepare(
        `SELECT id, repository_reference AS repositoryReference,
                base_commit AS baseCommit, integration_branch AS integrationBranch,
                state, expected_tip AS expectedTip,
                integrated_commit AS integratedCommit
           FROM integration_repository_results
          WHERE generation_id = ? ORDER BY repository_reference`,
      )
      .all(generationId) as Array<Record<string, unknown>>;
    const validationRecords = database
      .prepare(
        `SELECT repository_result_id AS repositoryResultId,
                validation_id AS validationId, kind, status,
                record_hash AS recordHash, evidence_json AS evidenceJson,
                responsibility_json AS responsibilityJson,
                contract_failure_json AS contractFailureJson
           FROM integration_validation_records
          WHERE generation_id = ? ORDER BY validation_id`,
      )
      .all(generationId) as Array<Record<string, unknown>>;
    const persistedOperations = database
      .prepare(
        `SELECT id, work_package_version_id AS workPackageVersionId, state,
                expected_tip AS expectedTip, resulting_commit AS resultingCommit,
                request_hash AS requestHash, receipt_hash AS receiptHash,
                failure_code AS failureCode, failure_message AS failureMessage
           FROM integration_operations WHERE generation_id = ?`,
      )
      .all(generationId) as Array<Record<string, unknown>>;
    const operationByVersion = new Map(
      persistedOperations.map((operation) => [
        String(operation.workPackageVersionId),
        operation,
      ]),
    );
    const repositoryByReference = new Map(
      repositoryResults.map((repository) => [
        String(repository.repositoryReference),
        repository,
      ]),
    );
    const operations = manifest.packages.map((entry) => {
      const persisted = operationByVersion.get(entry.workPackageVersionId);
      const repository = repositoryByReference.get(entry.repositoryReference)!;
      return {
        id: persisted
          ? String(persisted.id)
          : `${generationId}:${entry.workPackageVersionId}`,
        repositoryReference: entry.repositoryReference,
        integrationBranch: String(repository.integrationBranch),
        workPackageId: entry.workPackageId,
        workPackageVersionId: entry.workPackageVersionId,
        authorityId: entry.authorityId,
        qualityGateResultId: entry.qualityGateResultId,
        sourceBranch: entry.sourceBranch,
        sourceCommit: entry.sourceCommit,
        diffHash: entry.diffHash,
        state: persisted
          ? (String(persisted.state) as IntegrationOperationView["state"])
          : "pending",
        expectedTip: persisted?.expectedTip
          ? String(persisted.expectedTip)
          : null,
        resultingCommit: persisted?.resultingCommit
          ? String(persisted.resultingCommit)
          : null,
        requestHash: persisted?.requestHash
          ? String(persisted.requestHash)
          : null,
        receiptHash: persisted?.receiptHash
          ? String(persisted.receiptHash)
          : null,
        failure:
          persisted?.failureCode && persisted?.failureMessage
            ? {
                code: String(persisted.failureCode),
                message: String(persisted.failureMessage),
              }
            : null,
      } satisfies IntegrationOperationView;
    });
    const defects = database
      .prepare(
        `SELECT id, kind, status, responsibility_json AS responsibilityJson,
                evidence_json AS evidenceJson
           FROM integration_defects WHERE generation_id = ?
          ORDER BY created_at, id`,
      )
      .all(generationId) as Array<Record<string, unknown>>;
    const aggregate = database
      .prepare(
        `SELECT id, topic_id AS topicId,
                quality_gate_result_id AS qualityGateResultId,
                input_json AS inputJson, input_hash AS inputHash, result,
                evidence_json AS evidenceJson
           FROM integration_aggregate_reviews WHERE generation_id = ?`,
      )
      .get(generationId) as Record<string, unknown> | undefined;
    return {
      id: String(row.id),
      manifest,
      manifestHash: String(row.manifestHash),
      state: String(row.state) as IntegrationGenerationView["state"],
      repositoryResults: repositoryResults.map((repository) => ({
        id: String(repository.id),
        repositoryReference: String(repository.repositoryReference),
        baseCommit: String(repository.baseCommit),
        integrationBranch: String(repository.integrationBranch),
        state: String(
          repository.state,
        ) as IntegrationGenerationView["repositoryResults"][number]["state"],
        expectedTip: String(repository.expectedTip),
        integratedCommit: repository.integratedCommit
          ? String(repository.integratedCommit)
          : null,
        validationRecords: validationRecords
          .filter(
            (record) =>
              String(record.repositoryResultId) === String(repository.id),
          )
          .map((record) => ({
            validationId: String(record.validationId),
            kind: String(record.kind) as "build-test" | "contract",
            status: String(record.status) as "passed" | "failed",
            recordHash: String(record.recordHash),
            evidenceRefs: parseJson<readonly string[]>(
              String(record.evidenceJson),
            ),
            responsibleWorkPackageVersionIds: parseJson<readonly string[]>(
              String(record.responsibilityJson),
            ),
            contractFailure: record.contractFailureJson
              ? parseJson(String(record.contractFailureJson))
              : null,
          })),
      })),
      operations,
      defects: defects.map((defect) => ({
        id: String(defect.id),
        kind: String(defect.kind),
        status: String(defect.status) as "open" | "closed",
        responsibility: parseJson(String(defect.responsibilityJson)),
        evidence: parseJson(String(defect.evidenceJson)),
      })),
      aggregateReview: aggregate
        ? {
            id: String(aggregate.id),
            topicId: String(aggregate.topicId),
            qualityGateResultId: String(aggregate.qualityGateResultId),
            input: parseJson(String(aggregate.inputJson)),
            inputHash: String(aggregate.inputHash),
            result: String(aggregate.result) as
              | "PASS"
              | "CONDITIONAL_PASS"
              | "FAIL",
            evidence: parseJson<readonly string[]>(
              String(aggregate.evidenceJson),
            ),
          }
        : null,
      passAuthorityHash: row.passAuthorityHash
        ? String(row.passAuthorityHash)
        : null,
    };
  };

  const inspect = (runId: string): readonly IntegrationGenerationView[] => {
    const ids = database
      .prepare(
        `SELECT id FROM integration_generations
          WHERE run_id = ? ORDER BY generation, created_at, id`,
      )
      .all(runId) as Array<{ readonly id: string }>;
    return ids.map((entry) => readOne(entry.id));
  };

  const startGeneration = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: Extract<
      IntegrationEnvelopeCommand,
      { readonly type: "integration.generation.start" }
    >;
  }): IntegrationGenerationView => {
    assertRuntimeActor(input.actor);
    const existing = database
      .prepare(
        `SELECT manifest_hash AS manifestHash, generation
           FROM integration_generations WHERE id = ?`,
      )
      .get(input.command.generationId) as
      | { readonly manifestHash: string; readonly generation: number }
      | undefined;
    const reviewedCoverage = options.codeReviews.readCompletedCoverage(
      input.command.runId,
    );
    if (reviewedCoverage.runId !== input.command.runId) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_COVERAGE_CONFLICT",
        "Completed Code Review coverage belongs to a different Department Run.",
      );
    }
    if (reviewedCoverage.packages.length === 0) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_COVERAGE_INCOMPLETE",
        "Completed Code Review coverage contains no Work Package authorities.",
      );
    }
    assertSha(reviewedCoverage.coverageHash, 64, "Code Review coverage hash");
    const ordered = topologicalOrder(reviewedCoverage.packages);
    const repositoryBases = new Map<string, string>();
    const contractVersions = new Map<
      string,
      { readonly id: string; readonly version: string; readonly hash: string }
    >();
    for (const entry of ordered) {
      assertSha(entry.baseCommit, 40, "Repository base commit");
      assertSha(entry.sourceCommit, 40, "approved source commit");
      assertSha(entry.diffHash, 64, "approved Diff hash");
      const priorBase = repositoryBases.get(entry.repositoryReference);
      if (priorBase && priorBase !== entry.baseCommit) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_BASE_CONFLICT",
          `Repository ${entry.repositoryReference} has reviewed Work Packages from different frozen base commits. Create a new Work Package Attempt from one common base and obtain fresh independent Code Review coverage.`,
        );
      }
      repositoryBases.set(entry.repositoryReference, entry.baseCommit);
      for (const contract of entry.contractVersions) {
        assertSha(contract.hash, 64, "Contract hash");
        const prior = contractVersions.get(contract.id);
        if (
          prior &&
          (prior.version !== contract.version || prior.hash !== contract.hash)
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONTRACT_MISMATCH",
            `Cross-application Contract ${contract.id} has incompatible reviewed versions.`,
          );
        }
        contractVersions.set(contract.id, contract);
      }
    }
    const generation = existing
      ? Number(existing.generation)
      : Number(
          (
            database
              .prepare(
                "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM integration_generations WHERE run_id = ?",
              )
              .get(input.command.runId) as { readonly generation: number }
          ).generation,
        );
    const integrationBranch = `integration/${input.command.runId}/g${generation}`;
    const manifest: IntegrationGenerationManifest = {
      schemaVersion: 1,
      generationId: input.command.generationId,
      generation,
      projectId: reviewedCoverage.projectId,
      runId: reviewedCoverage.runId,
      snapshotRevisionId: reviewedCoverage.snapshotRevisionId,
      nodeRunId: input.command.nodeRunId,
      coverageId: reviewedCoverage.coverageId,
      coverageNodeRunId: reviewedCoverage.nodeRunId,
      coverageNodeAttemptId: reviewedCoverage.nodeAttemptId,
      coverageHash: reviewedCoverage.coverageHash,
      repositories: [...repositoryBases.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repositoryReference, baseCommit]) => ({
          repositoryReference,
          baseCommit,
          integrationBranch,
        })),
      packages: ordered.map((entry) => ({
        ...entry,
        dependencies: [...entry.dependencies].sort((left, right) =>
          `${left.predecessorWorkPackageVersionId}:${left.kind}`.localeCompare(
            `${right.predecessorWorkPackageVersionId}:${right.kind}`,
          ),
        ),
        contractVersions: [...entry.contractVersions].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        integrationConditions: [...entry.integrationConditions].sort(),
      })),
      dependencyOrder: ordered.map((entry) => entry.workPackageVersionId),
      contractVersions: [...contractVersions.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      integrationConditions: [
        ...new Set(ordered.flatMap((entry) => entry.integrationConditions)),
      ].sort(),
      requiredValidations: requiredValidationsFor(ordered, contractVersions),
    };
    const manifestJson = canonicalJson(manifest);
    const manifestHash = sha256(manifestJson);
    if (existing) {
      if (existing.manifestHash !== manifestHash) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_CONFLICT",
          "Integration Generation identity was reused with changed coverage or manifest input.",
        );
      }
      return readOne(input.command.generationId);
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO integration_generations(
           id, project_id, run_id, snapshot_revision_id, node_run_id,
           generation, coverage_id, coverage_node_run_id,
           coverage_node_attempt_id, coverage_hash, manifest_json,
           manifest_hash, state, pass_authority_hash, failure_code,
           failure_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.command.generationId,
        manifest.projectId,
        manifest.runId,
        manifest.snapshotRevisionId,
        manifest.nodeRunId,
        generation,
        manifest.coverageId,
        manifest.coverageNodeRunId,
        manifest.coverageNodeAttemptId,
        manifest.coverageHash,
        manifestJson,
        manifestHash,
        now,
        now,
      );
    const insertRepository = database.prepare(
      `INSERT INTO integration_repository_results(
         id, generation_id, repository_reference, base_commit,
         integration_branch, state, expected_tip, integrated_commit,
         validation_json, failure_code, failure_message, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)`,
    );
    for (const repository of manifest.repositories) {
      insertRepository.run(
        sha256(`${manifest.generationId}:${repository.repositoryReference}`),
        manifest.generationId,
        repository.repositoryReference,
        repository.baseCommit,
        repository.integrationBranch,
        repository.baseCommit,
        now,
        now,
      );
    }
    options.pipelineRuntime.startIntegrationInTransaction({
      runId: manifest.runId,
      nodeRunId: manifest.nodeRunId,
      generationId: manifest.generationId,
    });
    options.events.append({
      type: "integration.generation.started",
      scope: {
        companyId: "company",
        projectId: manifest.projectId,
        runId: manifest.runId,
        nodeRunId: manifest.nodeRunId,
        integrationGenerationId: manifest.generationId,
        commandId: input.commandId,
      },
      payload: {
        generationId: manifest.generationId,
        generation: manifest.generation,
        coverageId: manifest.coverageId,
        coverageHash: manifest.coverageHash,
        manifestHash,
        state: "pending",
      },
      timestamp: now,
    });
    return readOne(manifest.generationId);
  };

  const createDefect = (input: {
    readonly generationId: string;
    readonly operationId?: string;
    readonly kind:
      | "git-conflict"
      | "build-test"
      | "contract"
      | "aggregate"
      | "reconciliation";
    readonly responsibility: unknown;
    readonly evidence: unknown;
    readonly now: string;
  }): string => {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO integration_defects(
           id, generation_id, integration_operation_id, kind,
           responsibility_json, evidence_json, status, created_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
      )
      .run(
        id,
        input.generationId,
        input.operationId ?? null,
        input.kind,
        canonicalJson(input.responsibility),
        canonicalJson(input.evidence),
        input.now,
      );
    return id;
  };

  const failGeneration = (input: {
    readonly view: IntegrationGenerationView;
    readonly operationId?: string;
    readonly kind:
      | "git-conflict"
      | "build-test"
      | "contract"
      | "aggregate"
      | "reconciliation";
    readonly code: string;
    readonly message: string;
    readonly responsibility: unknown;
    readonly evidence: unknown;
    readonly blocked?: boolean;
  }): void => {
    const now = clock().toISOString();
    createDefect({
      generationId: input.view.id,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      kind: input.kind,
      responsibility: input.responsibility,
      evidence: input.evidence,
      now,
    });
    database
      .prepare(
        `UPDATE integration_generations
            SET state = ?, failure_code = ?, failure_message = ?, updated_at = ?
          WHERE id = ? AND state NOT IN ('failed', 'passed')`,
      )
      .run(
        input.blocked ? "blocked" : "failed",
        input.code,
        input.message,
        now,
        input.view.id,
      );
    const pipelineFailure = {
      runId: input.view.manifest.runId,
      nodeRunId: input.view.manifest.nodeRunId,
      generationId: input.view.id,
      failure: { code: input.code, message: input.message },
    };
    if (input.blocked) {
      options.pipelineRuntime.blockIntegrationInTransaction(pipelineFailure);
    } else {
      options.pipelineRuntime.failIntegrationInTransaction(pipelineFailure);
    }
    options.events.append({
      type: input.blocked
        ? "integration.generation.blocked"
        : "integration.generation.failed",
      scope: {
        companyId: "company",
        projectId: input.view.manifest.projectId,
        runId: input.view.manifest.runId,
        nodeRunId: input.view.manifest.nodeRunId,
        integrationGenerationId: input.view.id,
        ...(input.operationId
          ? { integrationOperationId: input.operationId }
          : {}),
      },
      payload: {
        generationId: input.view.id,
        state: input.blocked ? "blocked" : "failed",
        code: input.code,
        message: input.message,
      },
      timestamp: now,
    });
  };

  const currentCoverageIsExact = (
    manifest: IntegrationGenerationManifest,
  ): boolean => {
    try {
      const current = options.codeReviews.readCompletedCoverage(manifest.runId);
      const packages = topologicalOrder(current.packages).map((entry) => ({
        ...entry,
        dependencies: [...entry.dependencies].sort((left, right) =>
          `${left.predecessorWorkPackageVersionId}:${left.kind}`.localeCompare(
            `${right.predecessorWorkPackageVersionId}:${right.kind}`,
          ),
        ),
        contractVersions: [...entry.contractVersions].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        integrationConditions: [...entry.integrationConditions].sort(),
      }));
      return (
        current.coverageId === manifest.coverageId &&
        current.coverageHash === manifest.coverageHash &&
        current.projectId === manifest.projectId &&
        current.runId === manifest.runId &&
        current.snapshotRevisionId === manifest.snapshotRevisionId &&
        current.nodeRunId === manifest.coverageNodeRunId &&
        current.nodeAttemptId === manifest.coverageNodeAttemptId &&
        canonicalJson(packages) === canonicalJson(manifest.packages)
      );
    } catch {
      return false;
    }
  };

  const operationRequest = (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly expectedTip: string;
  }): GitIntegrationRequest => {
    const repository = input.view.manifest.repositories.find(
      (candidate) =>
        candidate.repositoryReference === input.entry.repositoryReference,
    )!;
    const operationId = `${input.view.id}:${input.entry.workPackageVersionId}`;
    const requestBody = {
      schemaVersion: 1,
      operationId,
      generationId: input.view.id,
      generationManifestHash: input.view.manifestHash,
      coverageId: input.view.manifest.coverageId,
      coverageHash: input.view.manifest.coverageHash,
      repositoryReference: input.entry.repositoryReference,
      integrationBranch: repository.integrationBranch,
      baseCommit: repository.baseCommit,
      sourceBranch: input.entry.sourceBranch,
      sourceCommit: input.entry.sourceCommit,
      expectedTip: input.expectedTip,
      authorityId: input.entry.authorityId,
      qualityGateResultId: input.entry.qualityGateResultId,
      diffHash: input.entry.diffHash,
      validationInput: {
        contractVersions: input.entry.contractVersions,
        integrationConditions: input.entry.integrationConditions,
      },
    };
    return {
      operationId,
      generationId: input.view.id,
      repositoryReference: input.entry.repositoryReference,
      integrationBranch: repository.integrationBranch,
      baseCommit: repository.baseCommit,
      sourceBranch: input.entry.sourceBranch,
      sourceCommit: input.entry.sourceCommit,
      expectedTip: input.expectedTip,
      requestHash: sha256(canonicalJson(requestBody)),
      idempotencyKey: `integration:${input.view.id}:${input.entry.workPackageVersionId}`,
    };
  };

  const persistIntent = (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly request: GitIntegrationRequest;
    readonly ordinal: number;
  }): void => {
    const repository = input.view.repositoryResults.find(
      (candidate) =>
        candidate.repositoryReference === input.entry.repositoryReference,
    )!;
    const now = clock().toISOString();
    const requestJson = canonicalJson({
      ...input.request,
      diffHash: input.entry.diffHash,
      authorityId: input.entry.authorityId,
      qualityGateResultId: input.entry.qualityGateResultId,
      integrationConditions: input.entry.integrationConditions,
      contractVersions: input.entry.contractVersions,
    });
    database
      .prepare(
        `INSERT INTO integration_operations(
           id, generation_id, repository_result_id, work_package_id,
           work_package_version_id, authority_id, quality_gate_result_id,
           ordinal, source_branch, source_commit, diff_hash, expected_tip,
           request_json, request_hash, idempotency_key, state, receipt_json,
           receipt_hash, resulting_commit, failure_code, failure_message,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent',
                   NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.request.operationId,
        input.view.id,
        repository.id,
        input.entry.workPackageId,
        input.entry.workPackageVersionId,
        input.entry.authorityId,
        input.entry.qualityGateResultId,
        input.ordinal,
        input.entry.sourceBranch,
        input.entry.sourceCommit,
        input.entry.diffHash,
        input.request.expectedTip,
        requestJson,
        input.request.requestHash,
        input.request.idempotencyKey,
        now,
        now,
      );
    database
      .prepare(
        `UPDATE integration_repository_results
            SET state = 'running', updated_at = ? WHERE id = ?`,
      )
      .run(now, repository.id);
    database
      .prepare(
        `UPDATE integration_generations
            SET state = 'running', updated_at = ?
          WHERE id = ? AND state IN ('pending', 'running')`,
      )
      .run(now, input.view.id);
  };

  const finalizeSucceededOperation = (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly request: GitIntegrationRequest;
    readonly result: Extract<
      GitIntegrationResult,
      { readonly status: "succeeded" }
    >;
  }): void => {
    if (
      input.result.beforeTip !== input.request.expectedTip ||
      input.result.afterTip !== input.result.resultingCommit ||
      !/^[a-f0-9]{40}$/.test(input.result.resultingCommit)
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_RECEIPT_INVALID",
        "Git Integration receipt does not bind the exact expected and resulting commits.",
      );
    }
    const now = clock().toISOString();
    const receiptJson = canonicalJson(input.result.receipt);
    database
      .prepare(
        `UPDATE integration_operations
            SET state = 'succeeded', receipt_json = ?, receipt_hash = ?,
                resulting_commit = ?, failure_code = NULL,
                failure_message = NULL, updated_at = ?
          WHERE id = ? AND request_hash = ?
            AND state IN ('intent', 'running')`,
      )
      .run(
        receiptJson,
        sha256(receiptJson),
        input.result.resultingCommit,
        now,
        input.request.operationId,
        input.request.requestHash,
      );
    database
      .prepare(
        `UPDATE integration_repository_results
            SET expected_tip = ?, integrated_commit = ?, updated_at = ?
          WHERE generation_id = ? AND repository_reference = ?`,
      )
      .run(
        input.result.resultingCommit,
        input.result.resultingCommit,
        now,
        input.view.id,
        input.entry.repositoryReference,
      );
  };

  const resolveOperation = (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly request: GitIntegrationRequest;
    readonly ordinal: number;
  }): boolean => {
    const planned = input.view.operations.find(
      (operation) =>
        operation.workPackageVersionId === input.entry.workPackageVersionId,
    );
    const persisted = planned?.state === "pending" ? undefined : planned;
    if (persisted?.state === "succeeded") return true;
    let result: GitIntegrationResult | GitIntegrationReconciliation;
    if (persisted) {
      if (
        persisted.requestHash !== input.request.requestHash ||
        persisted.expectedTip !== input.request.expectedTip
      ) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_CONFLICT",
          `Integration operation ${persisted.id} has changed immutable input.`,
        );
      }
      result = options.gitAdapter.reconcile(input.request);
      if (result.status === "not-applied") {
        result = options.gitAdapter.execute(input.request);
      }
    } else {
      database.exec("BEGIN IMMEDIATE");
      try {
        persistIntent(input);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      options.failureInjection?.("after-intent", input.request.operationId);
      database
        .prepare(
          `UPDATE integration_operations SET state = 'running', updated_at = ?
            WHERE id = ? AND state = 'intent'`,
        )
        .run(clock().toISOString(), input.request.operationId);
      result = options.gitAdapter.execute(input.request);
      options.failureInjection?.("after-effect", input.request.operationId);
    }
    if (result.status === "succeeded") {
      database.exec("BEGIN IMMEDIATE");
      try {
        finalizeSucceededOperation({
          view: input.view,
          entry: input.entry,
          request: input.request,
          result,
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return true;
    }
    const now = clock().toISOString();
    const isUnknown = result.status === "unknown";
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `UPDATE integration_operations
              SET state = ?, failure_code = ?, failure_message = ?, updated_at = ?
            WHERE id = ? AND state IN ('intent', 'running')`,
        )
        .run(
          isUnknown ? "unknown" : "failed",
          result.code,
          result.message,
          now,
          input.request.operationId,
        );
      database
        .prepare(
          `UPDATE integration_repository_results
              SET state = ?, failure_code = ?, failure_message = ?, updated_at = ?
            WHERE generation_id = ? AND repository_reference = ?`,
        )
        .run(
          isUnknown ? "blocked" : "failed",
          result.code,
          result.message,
          now,
          input.view.id,
          input.entry.repositoryReference,
        );
      options.failureInjection?.(
        "during-failure-finalization",
        input.request.operationId,
      );
      failGeneration({
        view: input.view,
        operationId: input.request.operationId,
        kind:
          result.status === "conflict"
            ? "git-conflict"
            : isUnknown
              ? "reconciliation"
              : "git-conflict",
        code: result.code,
        message: result.message,
        responsibility: {
          workPackageIds: [input.entry.workPackageId],
          workPackageVersionIds: [input.entry.workPackageVersionId],
        },
        evidence: result.evidence,
        blocked: isUnknown,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return false;
  };

  const executePending = (generationId: string): IntegrationGenerationView => {
    let view = readOne(generationId);
    if (["failed", "passed"].includes(view.state)) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_GENERATION_TERMINAL",
        `Integration Generation ${generationId} cannot continue from ${view.state}.`,
      );
    }
    if (view.state === "blocked") return view;
    for (const [ordinal, entry] of view.manifest.packages.entries()) {
      view = readOne(generationId);
      const repository = view.repositoryResults.find(
        (candidate) =>
          candidate.repositoryReference === entry.repositoryReference,
      )!;
      const request = operationRequest({
        view,
        entry,
        expectedTip: repository.expectedTip,
      });
      const planned = view.operations.find(
        (operation) =>
          operation.workPackageVersionId === entry.workPackageVersionId,
      );
      if (
        planned?.state === "pending" &&
        !currentCoverageIsExact(view.manifest)
      ) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_COVERAGE_STALE",
          "The exact completed Code Review coverage is no longer eligible; no new Git effect was attempted.",
        );
      }
      if (!resolveOperation({ view, entry, request, ordinal })) {
        return readOne(generationId);
      }
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE integration_repository_results
            SET state = 'validating', updated_at = ?
          WHERE generation_id = ? AND state = 'running'`,
      )
      .run(now, generationId);
    database
      .prepare(
        `UPDATE integration_generations
            SET state = 'validating', updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .run(now, generationId);
    options.events.append({
      type: "integration.generation.validating",
      scope: {
        companyId: "company",
        projectId: view.manifest.projectId,
        runId: view.manifest.runId,
        nodeRunId: view.manifest.nodeRunId,
        integrationGenerationId: view.id,
      },
      payload: {
        generationId: view.id,
        state: "validating",
        manifestHash: view.manifestHash,
      },
      timestamp: now,
    });
    return readOne(generationId);
  };

  const recordValidation = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: Extract<
      IntegrationEnvelopeCommand,
      { readonly type: "integration.validation.record" }
    >;
  }): IntegrationGenerationView => {
    assertRuntimeActor(input.actor);
    const view = readOne(input.command.generationId);
    if (view.state !== "validating") {
      throw new IntegrationRuntimeError(
        "INTEGRATION_VALIDATION_STATE_INVALID",
        `Integration Generation ${view.id} is not awaiting validation.`,
      );
    }
    const repository = view.repositoryResults.find(
      (candidate) =>
        candidate.repositoryReference === input.command.repositoryReference,
    );
    if (!repository || repository.state !== "validating") {
      throw new IntegrationRuntimeError(
        "INTEGRATION_REPOSITORY_NOT_FOUND",
        "The validation result does not target a pending Repository result.",
      );
    }
    const repositoryMembers = new Set(
      view.manifest.packages
        .filter(
          (entry) =>
            entry.repositoryReference === input.command.repositoryReference,
        )
        .map((entry) => entry.workPackageVersionId),
    );
    const generationMembers = new Set(
      view.manifest.packages.map((entry) => entry.workPackageVersionId),
    );
    const allowedMembers =
      input.command.kind === "contract" ? generationMembers : repositoryMembers;
    const requiredValidation = view.manifest.requiredValidations.find(
      (validation) =>
        validation.id === input.command.validationId &&
        validation.repositoryReference === input.command.repositoryReference &&
        validation.kind === input.command.kind,
    );
    if (!requiredValidation) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_VALIDATION_NOT_REQUIRED",
        "The validation record does not match an exact item frozen in the Integration manifest.",
      );
    }
    if (
      input.command.responsibleWorkPackageVersionIds.some(
        (id) => !allowedMembers.has(id),
      )
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_RESPONSIBILITY_INVALID",
        "Validation responsibility must name reviewed Work Package Versions in the permitted validation scope.",
      );
    }
    if (
      input.command.kind === "contract" &&
      input.command.status === "failed" &&
      !input.command.contractFailure
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_CONTRACT_EVIDENCE_INVALID",
        "A failed cross-application Contract validation requires producer, consumer, fixture, and Runtime evidence.",
      );
    }
    if (
      input.command.contractFailure &&
      (input.command.kind !== "contract" || input.command.status !== "failed")
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_CONTRACT_EVIDENCE_INVALID",
        "Contract failure evidence is allowed only on a failed Contract validation.",
      );
    }
    if (input.command.contractFailure) {
      const failure = input.command.contractFailure;
      const producer = view.manifest.packages.find(
        (entry) => entry.applicationId === failure.producerApplicationId,
      );
      const consumer = view.manifest.packages.find(
        (entry) => entry.applicationId === failure.consumerApplicationId,
      );
      const contract = view.manifest.contractVersions.find(
        (entry) =>
          entry.id === failure.contractId &&
          entry.version === failure.contractVersion,
      );
      if (
        !producer ||
        !consumer ||
        !contract ||
        producer === consumer ||
        requiredValidation.contract?.id !== failure.contractId ||
        requiredValidation.contract.version !== failure.contractVersion ||
        requiredValidation.contract.producerApplicationId !==
          failure.producerApplicationId ||
        requiredValidation.contract.consumerApplicationId !==
          failure.consumerApplicationId
      ) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_CONTRACT_EVIDENCE_INVALID",
          "Contract failure evidence does not bind reviewed producer and consumer Applications to the frozen Contract version.",
        );
      }
    }
    const now = clock().toISOString();
    const validation = {
      validationId: input.command.validationId,
      status: input.command.status,
      kind: input.command.kind,
      evidenceRefs: [...input.command.evidenceRefs].sort(),
      responsibleWorkPackageVersionIds: [
        ...input.command.responsibleWorkPackageVersionIds,
      ].sort(),
      contractFailure: input.command.contractFailure ?? null,
    };
    const validationJson = canonicalJson(validation);
    const recordHash = sha256(validationJson);
    const existingRecord = database
      .prepare(
        `SELECT record_hash AS recordHash
           FROM integration_validation_records
          WHERE generation_id = ? AND validation_id = ?`,
      )
      .get(view.id, input.command.validationId) as
      | { readonly recordHash: string }
      | undefined;
    if (existingRecord) {
      if (existingRecord.recordHash !== recordHash) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_CONFLICT",
          "A frozen validation identity was reused with changed evidence.",
        );
      }
      return readOne(view.id);
    }
    database
      .prepare(
        `INSERT INTO integration_validation_records(
           id, generation_id, repository_result_id, validation_id, kind,
           status, evidence_json, responsibility_json, contract_failure_json,
           record_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        view.id,
        repository.id,
        input.command.validationId,
        input.command.kind,
        input.command.status,
        canonicalJson(validation.evidenceRefs),
        canonicalJson(validation.responsibleWorkPackageVersionIds),
        validation.contractFailure
          ? canonicalJson(validation.contractFailure)
          : null,
        recordHash,
        now,
      );
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, 'integration.validation-record', 'integration-validation',
                   ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        randomUUID(),
        `${view.id}:${input.command.validationId}`,
        view.manifest.runId,
        view.manifest.nodeRunId,
        validationJson,
        now,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    options.events.append({
      type: "integration.validation.recorded",
      scope: {
        companyId: "company",
        projectId: view.manifest.projectId,
        runId: view.manifest.runId,
        nodeRunId: view.manifest.nodeRunId,
        integrationGenerationId: view.id,
        commandId: input.commandId,
      },
      payload: {
        generationId: view.id,
        state: input.command.status === "passed" ? "validating" : "failed",
        repositoryReference: input.command.repositoryReference,
        validationId: input.command.validationId,
        kind: input.command.kind,
        status: input.command.status,
        recordHash,
      },
      timestamp: now,
    });
    if (input.command.status === "failed") {
      database
        .prepare(
          `UPDATE integration_repository_results
              SET state = 'failed', validation_json = ?, failure_code = ?,
                  failure_message = ?, updated_at = ?
            WHERE id = ? AND state = 'validating'`,
        )
        .run(
          validationJson,
          input.command.kind === "contract"
            ? "INTEGRATION_CONTRACT_FAILED"
            : "INTEGRATION_VALIDATION_FAILED",
          "Integration validation failed with recorded evidence.",
          now,
          repository.id,
        );
      failGeneration({
        view,
        kind: input.command.kind,
        code:
          input.command.kind === "contract"
            ? "INTEGRATION_CONTRACT_FAILED"
            : "INTEGRATION_VALIDATION_FAILED",
        message: "Integration validation failed with recorded evidence.",
        responsibility: {
          workPackageVersionIds:
            input.command.responsibleWorkPackageVersionIds.length > 0
              ? input.command.responsibleWorkPackageVersionIds
              : input.command.contractFailure
                ? view.manifest.packages
                    .filter(
                      (entry) =>
                        entry.applicationId ===
                          input.command.contractFailure
                            ?.producerApplicationId ||
                        entry.applicationId ===
                          input.command.contractFailure?.consumerApplicationId,
                    )
                    .map((entry) => entry.workPackageVersionId)
                    .sort()
                : [...repositoryMembers].sort(),
          ...(input.command.contractFailure
            ? { contractFailure: input.command.contractFailure }
            : {}),
        },
        evidence: validation,
      });
      return readOne(view.id);
    }
    const requiredForRepository = view.manifest.requiredValidations.filter(
      (validation) =>
        validation.repositoryReference === input.command.repositoryReference,
    ).length;
    const passedForRepository = Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM integration_validation_records
              WHERE generation_id = ? AND repository_result_id = ?
                AND status = 'passed'`,
          )
          .get(view.id, repository.id) as { readonly count: number }
      ).count,
    );
    if (passedForRepository === requiredForRepository) {
      database
        .prepare(
          `UPDATE integration_repository_results
              SET state = 'succeeded', validation_json = ?, updated_at = ?
            WHERE id = ? AND state = 'validating'`,
        )
        .run(
          canonicalJson({
            requiredValidationIds: view.manifest.requiredValidations
              .filter(
                (validation) =>
                  validation.repositoryReference ===
                  input.command.repositoryReference,
              )
              .map((validation) => validation.id),
          }),
          now,
          repository.id,
        );
    }
    const remaining = Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM integration_repository_results
              WHERE generation_id = ? AND state <> 'succeeded'`,
          )
          .get(view.id) as { readonly count: number }
      ).count,
    );
    if (remaining === 0) {
      database
        .prepare(
          `UPDATE integration_generations
              SET state = 'aggregate-review', updated_at = ?
            WHERE id = ? AND state = 'validating'`,
        )
        .run(now, view.id);
      options.events.append({
        type: "integration.generation.aggregate-review",
        scope: {
          companyId: "company",
          projectId: view.manifest.projectId,
          runId: view.manifest.runId,
          nodeRunId: view.manifest.nodeRunId,
          integrationGenerationId: view.id,
          commandId: input.commandId,
        },
        payload: {
          generationId: view.id,
          state: "aggregate-review",
          manifestHash: view.manifestHash,
        },
        timestamp: now,
      });
    }
    return readOne(view.id);
  };

  const recordAggregateReview = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: Extract<
      IntegrationEnvelopeCommand,
      { readonly type: "integration.aggregate-review.record" }
    >;
  }): IntegrationGenerationView => {
    assertRuntimeActor(input.actor);
    if (!options.reviewRuntime) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_AGGREGATE_REVIEW_UNAVAILABLE",
        "Aggregate independent Review Runtime is unavailable.",
      );
    }
    const view = readOne(input.command.generationId);
    if (view.state !== "aggregate-review") {
      throw new IntegrationRuntimeError(
        "INTEGRATION_AGGREGATE_REVIEW_STATE_INVALID",
        `Integration Generation ${view.id} is not awaiting aggregate review.`,
      );
    }
    if (view.defects.some((defect) => defect.status === "open")) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_DEFECT_OPEN",
        "Aggregate review cannot pass while an Integration defect is open.",
      );
    }
    const topic = options.reviewRuntime.inspect(input.command.topicId);
    const gate = topic.gateResult;
    const repositoryCommits = view.repositoryResults.map((repository) => ({
      repositoryId: repository.repositoryReference,
      commit: repository.integratedCommit!,
    }));
    const aggregateManifest = {
      scope: "aggregate",
      topicId: input.command.topicId,
      supportingArtifactVersionIds: [],
      supportingSpecRevisionIds: [],
      harnessSnapshotIds: [],
      acceptanceCriteria: view.manifest.integrationConditions,
      excludedContext: [
        "hidden-prompts",
        "prior-reviewer-opinions",
        "private-transcripts",
      ],
      integrationGenerationId: view.id,
      integrationManifestHash: view.manifestHash,
      repositoryCommits,
    };
    const aggregateManifestHash = sha256(canonicalJson(aggregateManifest));
    if (
      !gate ||
      gate.id !== input.command.qualityGateResultId ||
      gate.kind !== "aggregate" ||
      canonicalJson(gate.manifest) !== canonicalJson(aggregateManifest) ||
      gate.manifestHash !== aggregateManifestHash
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
        "Aggregate Review Gate does not bind the exact Integration manifest and integrated commits.",
      );
    }
    const now = clock().toISOString();
    const evidence = [...gate.evidenceRefs].sort();
    const passAuthorityHash =
      gate.result === "PASS" && gate.conditions.length === 0
        ? sha256(
            canonicalJson({
              schemaVersion: 1,
              integrationGenerationId: view.id,
              integrationManifestHash: view.manifestHash,
              repositoryCommits,
              aggregateQualityGateResultId: gate.id,
              aggregateManifestHash,
              evidence,
            }),
          )
        : null;
    database
      .prepare(
        `INSERT INTO integration_aggregate_reviews(
           id, generation_id, topic_id, quality_gate_result_id, input_json,
           input_hash, result, evidence_json, pass_authority_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        view.id,
        input.command.topicId,
        gate.id,
        canonicalJson(aggregateManifest),
        aggregateManifestHash,
        gate.result,
        canonicalJson(evidence),
        passAuthorityHash,
        now,
      );
    if (!passAuthorityHash) {
      failGeneration({
        view,
        kind: "aggregate",
        code: "INTEGRATION_AGGREGATE_REVIEW_FAILED",
        message:
          "Aggregate independent review did not produce an unconditional PASS.",
        responsibility: {
          workPackageVersionIds: view.manifest.dependencyOrder,
        },
        evidence: {
          qualityGateResultId: gate.id,
          result: gate.result,
          conditions: gate.conditions,
          evidence,
        },
      });
      return readOne(view.id);
    }
    database
      .prepare(
        `UPDATE integration_generations
            SET state = 'passed', pass_authority_hash = ?,
                failure_code = NULL, failure_message = NULL, updated_at = ?
          WHERE id = ? AND state = 'aggregate-review'`,
      )
      .run(passAuthorityHash, now, view.id);
    options.pipelineRuntime.completeIntegrationInTransaction({
      runId: view.manifest.runId,
      nodeRunId: view.manifest.nodeRunId,
      generationId: view.id,
      passAuthorityHash,
      repositoryCommits: view.repositoryResults.map((repository) => ({
        repositoryReference: repository.repositoryReference,
        commit: repository.integratedCommit!,
      })),
    });
    options.events.append({
      type: "integration.generation.completed",
      scope: {
        companyId: "company",
        projectId: view.manifest.projectId,
        runId: view.manifest.runId,
        nodeRunId: view.manifest.nodeRunId,
        integrationGenerationId: view.id,
        qualityGateResultId: gate.id,
        commandId: input.commandId,
      },
      payload: {
        generationId: view.id,
        state: "passed",
        manifestHash: view.manifestHash,
        passAuthorityHash,
        repositoryCommits,
      },
      timestamp: now,
    });
    return readOne(view.id);
  };

  const dispatchInTransaction: IntegrationRuntime["dispatchInTransaction"] = (
    input,
  ) => {
    if (input.command.type === "integration.generation.start") {
      return startGeneration({
        commandId: input.commandId,
        actor: input.actor,
        command: input.command,
      });
    }
    if (input.command.type === "integration.validation.record") {
      return recordValidation({
        commandId: input.commandId,
        actor: input.actor,
        command: input.command,
      });
    }
    if (input.command.type === "integration.aggregate-review.record") {
      return recordAggregateReview({
        commandId: input.commandId,
        actor: input.actor,
        command: input.command,
      });
    }
    throw new IntegrationRuntimeError(
      "INTEGRATION_COMMAND_UNSUPPORTED",
      "Integration Command is not implemented.",
    );
  };

  return {
    inspect,
    inspectPending: () => {
      const ids = database
        .prepare(
          `SELECT id FROM integration_generations
            WHERE state IN ('running', 'validating', 'aggregate-review')
            ORDER BY updated_at, id`,
        )
        .all() as Array<{ readonly id: string }>;
      return ids.map((entry) => readOne(entry.id));
    },
    dispatchInTransaction,
    executePending,
    reconcilePending: () => {
      const ids = database
        .prepare(
          `SELECT DISTINCT generation_id AS id FROM integration_operations
            WHERE state IN ('intent', 'running') ORDER BY updated_at, id`,
        )
        .all() as Array<{ readonly id: string }>;
      for (const entry of ids) executePending(entry.id);
      return ids.length;
    },
    blockPending: (generationId, failure) => {
      const view = readOne(generationId);
      database.exec("BEGIN IMMEDIATE");
      try {
        failGeneration({
          view,
          kind: "reconciliation",
          code: failure.code,
          message: failure.message,
          responsibility: {
            workPackageVersionIds: view.manifest.dependencyOrder,
          },
          evidence: failure.evidence,
          blocked: true,
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return readOne(generationId);
    },
  };
};
