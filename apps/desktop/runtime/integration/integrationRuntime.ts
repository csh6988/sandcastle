import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorRef } from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type {
  CodeReviewRuntime,
  CompletedCodeReviewCoverage,
} from "../review/codeReviewRuntime.js";
import type { WorkPackageRuntime } from "../workspaces/workPackages.js";
import { aggregateEvidencePolicy } from "./integrationAggregateEvidence.js";
import { aggregateReviewManifestFor } from "./integrationAggregateManifest.js";

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
      readonly writeStatus: "not-started";
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
      readonly writeStatus: "not-started";
      readonly code: "INTEGRATION_CONFLICT";
      readonly message: string;
      readonly evidence: unknown;
    };

export interface GitIntegrationAdapter {
  readonly execute: (
    input: GitIntegrationRequest,
  ) => GitIntegrationResult | Promise<GitIntegrationResult>;
  readonly reconcile: (
    input: GitIntegrationRequest,
  ) => GitIntegrationReconciliation | Promise<GitIntegrationReconciliation>;
  readonly cancel?: (operationId: string) => Promise<void>;
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
    readonly producerApplicationId: string;
    readonly consumerApplicationId: string;
    readonly testCommands: readonly string[];
    readonly evidenceRefs: readonly string[];
  }[];
  readonly integrationConditions: readonly string[];
  readonly requiredValidations: readonly {
    readonly id: string;
    readonly repositoryReference: string;
    readonly kind: "build-test" | "contract";
    readonly identityHash: string;
    readonly commands: readonly (readonly string[])[];
    readonly evidenceRefs: readonly string[];
    readonly responsibleWorkPackageVersionIds: readonly string[];
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
  readonly nextGenerationNumber: (runId: string, nodeRunId: string) => number;
  readonly inspectPending: () => readonly IntegrationGenerationView[];
  readonly dispatchInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly command: IntegrationEnvelopeCommand;
  }) => IntegrationGenerationView;
  readonly executePending: (
    generationId: string,
  ) => Promise<IntegrationGenerationView>;
  readonly reconcilePending: () => Promise<number>;
  readonly cancelPendingGit?: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly claimExecutionStage: (input: {
    readonly generationId: string;
    readonly operationKey: string;
    readonly phase: "validation" | "aggregate-review";
    readonly targetKey: string;
    readonly request: unknown;
    readonly createIfMissing: boolean;
  }) =>
    | { readonly mode: "execute" | "reconcile" }
    | { readonly mode: "terminal"; readonly result: unknown }
    | { readonly mode: "missing" };
  readonly recordExecutionStageResult: (input: {
    readonly operationKey: string;
    readonly request: unknown;
    readonly state: "unknown" | "succeeded" | "failed";
    readonly result: unknown;
  }) => void;
  readonly inspectExecutionStageRequests: (generationId: string) => readonly {
    readonly operationKey: string;
    readonly phase: "validation" | "aggregate-review";
    readonly request: unknown;
    readonly state: "running" | "reconciling" | "unknown";
  }[];
  readonly blockPending: (
    generationId: string,
    failure: {
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    },
  ) => IntegrationGenerationView;
  readonly blockStart: (input: {
    readonly generationId: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly failure: {
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    };
  }) => void;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const assertTerminalExecutionStageResult = (input: {
  readonly operationKey: string;
  readonly phase: "validation" | "aggregate-review";
  readonly state: string;
  readonly request: unknown;
  readonly resultJson: string;
  readonly resultHash: string | null;
}): unknown => {
  if (sha256(input.resultJson) !== input.resultHash) {
    throw new IntegrationRuntimeError(
      "INTEGRATION_CONFLICT",
      `Terminal Integration execution stage ${input.operationKey} has a corrupted result authority.`,
    );
  }
  let result: unknown;
  try {
    result = parseJson<unknown>(input.resultJson);
  } catch {
    throw new IntegrationRuntimeError(
      "INTEGRATION_CONFLICT",
      `Terminal Integration execution stage ${input.operationKey} has invalid result JSON.`,
    );
  }
  if (!isRecord(result) || !isRecord(input.request)) {
    throw new IntegrationRuntimeError(
      "INTEGRATION_CONFLICT",
      `Terminal Integration execution stage ${input.operationKey} has an invalid result shape.`,
    );
  }
  if (input.phase === "validation") {
    const status = input.state === "succeeded" ? "passed" : "failed";
    const contractFailure = result.contractFailure;
    if (
      result.status !== status ||
      !isStringArray(result.evidenceRefs) ||
      !isStringArray(result.responsibleWorkPackageVersionIds) ||
      (contractFailure !== undefined &&
        (!isRecord(contractFailure) ||
          ![
            "producerApplicationId",
            "consumerApplicationId",
            "contractId",
            "contractVersion",
            "fixtureRef",
            "runtimeEvidenceRef",
          ].every((key) => typeof contractFailure[key] === "string")))
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_CONFLICT",
        `Terminal Integration validation stage ${input.operationKey} does not match its phase result contract.`,
      );
    }
    return result;
  }
  if (
    input.state !== "succeeded" ||
    result.status !== "completed" ||
    typeof result.topicId !== "string" ||
    result.topicId !== input.request.topicId ||
    typeof result.qualityGateResultId !== "string" ||
    result.qualityGateResultId.length === 0
  ) {
    throw new IntegrationRuntimeError(
      "INTEGRATION_CONFLICT",
      `Terminal aggregate Integration Review stage ${input.operationKey} does not match its frozen request identity.`,
    );
  }
  return result;
};

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
    CompletedCodeReviewCoveragePackage["contractVersions"][number]
  >,
): readonly RequiredIntegrationValidation[] => {
  const commandFor = (value: string): readonly string[] | null => {
    const tokens = value.trim().split(/\s+/);
    if (
      tokens.length < 2 ||
      !["npm", "pnpm", "yarn", "bun"].includes(tokens[0]!) ||
      tokens.some((token) => !/^[A-Za-z0-9._:@/=-]+$/.test(token))
    ) {
      return null;
    }
    if (tokens[1] === "test") return tokens;
    if (tokens[1] === "run" && tokens.length >= 3) return tokens;
    return null;
  };
  const freezeCommands = (
    values: readonly string[],
    label: string,
  ): readonly (readonly string[])[] => {
    const commands = values.map(commandFor);
    if (commands.length === 0 || commands.some((command) => command === null)) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_VALIDATION_COMMANDS_REQUIRED",
        `${label} must freeze one or more exact allowlisted package-manager test commands.`,
      );
    }
    return commands as readonly (readonly string[])[];
  };
  const items: RequiredIntegrationValidation[] = [];
  const repositories = new Map<string, Set<string>>();
  for (const entry of ordered) {
    const conditions = repositories.get(entry.repositoryReference) ?? new Set();
    for (const condition of entry.integrationConditions)
      conditions.add(condition);
    repositories.set(entry.repositoryReference, conditions);
  }
  for (const [repositoryReference, configured] of repositories) {
    const conditions = [...configured];
    if (conditions.length === 0) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_VALIDATION_COMMANDS_REQUIRED",
        `Repository ${repositoryReference} has no frozen Integration validation command.`,
      );
    }
    for (const condition of conditions) {
      const commands = freezeCommands(
        [condition],
        `Repository ${repositoryReference} Integration condition`,
      );
      const identity = {
        kind: "build-test" as const,
        repositoryReference,
        condition,
        commands,
        evidenceRefs: [] as readonly string[],
        responsibleWorkPackageVersionIds: ordered
          .filter(
            (entry) =>
              entry.repositoryReference === repositoryReference &&
              entry.integrationConditions.includes(condition),
          )
          .map((entry) => entry.workPackageVersionId)
          .sort(),
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
      if (
        contract.producerApplicationId !== producer.applicationId ||
        contract.consumerApplicationId !== consumer.applicationId
      ) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_CONTRACT_MISMATCH",
          `Cross-application Contract ${contract.id}@${contract.version} does not bind the reviewed producer and consumer Applications.`,
        );
      }
      const commands = freezeCommands(
        contract.testCommands,
        `Cross-application Contract ${contract.id}@${contract.version}`,
      );
      const identity = {
        kind: "contract" as const,
        repositoryReference: consumer.repositoryReference,
        commands,
        evidenceRefs: [...contract.evidenceRefs].sort(),
        responsibleWorkPackageVersionIds: [
          producer.workPackageVersionId,
          consumer.workPackageVersionId,
        ].sort(),
        contract: {
          id: contract.id,
          version: contract.version,
          hash: contract.hash,
          producerApplicationId: contract.producerApplicationId,
          consumerApplicationId: contract.consumerApplicationId,
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
      readonly resumeIntegrationInTransaction?: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
      }) => void;
      readonly failIntegrationInTransaction: (input: {
        readonly runId: string;
        readonly nodeRunId: string;
        readonly generationId: string;
        readonly failure: { readonly code: string; readonly message: string };
      }) => void;
      readonly requeueIntegrationRecoveryInTransaction: (input: {
        readonly runId: string;
        readonly integrationNodeRunId: string;
        readonly generationId: string;
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
    readonly workPackages?: Pick<
      WorkPackageRuntime,
      "inspect" | "reworkInTransaction"
    >;
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
      point:
        | "after-intent"
        | "after-effect"
        | "before-operation-intent"
        | "during-operation-intent"
        | "during-operation-finalization"
        | "during-failure-finalization",
      operationId: string,
    ) => void;
    readonly clock?: () => Date;
  },
): IntegrationRuntime => {
  const clock = options.clock ?? (() => new Date());
  const activeGitExecutions = new Map<string, Promise<GitIntegrationResult>>();

  const appendIntegrationAudit = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly before?: unknown;
    readonly after: unknown;
    readonly now: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        randomUUID(),
        input.action,
        input.entityType,
        input.entityId,
        input.runId,
        input.nodeRunId,
        input.before === undefined ? null : canonicalJson(input.before),
        canonicalJson(input.after),
        input.now,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
  };

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

  const integrationWorkerActor: ActorRef = {
    type: "runtime-worker",
    id: "integration-node-handler",
    authenticatedBy: "runtime",
  };

  const nextGenerationNumber = (runId: string, nodeRunId: string): number => {
    const persisted = database
      .prepare(
        `SELECT COALESCE(MAX(generation), 0) AS highest
           FROM integration_generations
          WHERE run_id = ? AND node_run_id = ?`,
      )
      .get(runId, nodeRunId) as { readonly highest: number };
    const blockedIdentities = database
      .prepare(
        `SELECT entity_id AS id FROM runtime_audit_records
          WHERE run_id = ? AND node_run_id = ?
            AND action = 'integration.generation-blocked'`,
      )
      .all(runId, nodeRunId) as Array<{
      readonly id: string;
    }>;
    const highestBlocked = blockedIdentities.reduce((current, entry) => {
      const match = /:g(\d+)$/.exec(entry.id);
      return match ? Math.max(current, Number(match[1])) : current;
    }, 0);
    return Math.max(Number(persisted.highest), highestBlocked) + 1;
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
    const runAuthority = database
      .prepare(
        `SELECT project_id AS projectId,
                snapshot_revision_id AS snapshotRevisionId
           FROM department_runs WHERE id = ?`,
      )
      .get(input.command.runId) as
      | { readonly projectId: string; readonly snapshotRevisionId: string }
      | undefined;
    if (
      reviewedCoverage.runId !== input.command.runId ||
      !runAuthority ||
      reviewedCoverage.projectId !== runAuthority.projectId
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_COVERAGE_CONFLICT",
        "Completed Code Review coverage belongs to a different Department Run.",
      );
    }
    if (
      reviewedCoverage.snapshotRevisionId !== runAuthority.snapshotRevisionId
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_COVERAGE_STALE",
        "Completed Code Review coverage does not bind the current Run Snapshot.",
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
    const recoveryDefects = database
      .prepare(
        `SELECT integration_defects.id,
                integration_defects.responsibility_json AS responsibilityJson,
                integration_generations.manifest_json AS manifestJson
           FROM integration_defects
           JOIN integration_generations
             ON integration_generations.id = integration_defects.generation_id
          WHERE integration_generations.run_id = ?
            AND integration_generations.state = 'failed'
            AND integration_defects.status = 'open'
          ORDER BY integration_generations.generation, integration_defects.created_at,
                   integration_defects.id`,
      )
      .all(input.command.runId) as Array<{
      readonly id: string;
      readonly responsibilityJson: string;
      readonly manifestJson: string;
    }>;
    const activeWorkPackages = options.workPackages?.inspect(
      input.command.runId,
    );
    for (const defect of recoveryDefects) {
      const responsibility = parseJson<{
        readonly workPackageVersionIds?: readonly string[];
      }>(defect.responsibilityJson);
      const priorManifest = parseJson<IntegrationGenerationManifest>(
        defect.manifestJson,
      );
      for (const priorVersionId of responsibility.workPackageVersionIds ?? []) {
        const priorPackage = priorManifest.packages.find(
          (entry) => entry.workPackageVersionId === priorVersionId,
        );
        const replacement = priorPackage
          ? ordered.find(
              (entry) =>
                entry.workPackageId === priorPackage.workPackageId &&
                entry.workPackageVersionId !== priorVersionId,
            )
          : undefined;
        const activeVersion = priorPackage
          ? activeWorkPackages?.packages
              .find((entry) => entry.id === priorPackage.workPackageId)
              ?.versions.find((entry) => entry.status === "ready")
          : undefined;
        if (
          !priorPackage ||
          !replacement ||
          (activeVersion &&
            activeVersion.id !== replacement.workPackageVersionId)
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_REWORK_COVERAGE_STALE",
            "A fresh Integration Generation requires replacement Work Package Versions with fresh exact Code Review coverage for every open Integration defect.",
          );
        }
      }
    }
    const repositoryBases = new Map<string, string>();
    const contractVersions = new Map<
      string,
      CompletedCodeReviewCoveragePackage["contractVersions"][number]
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
        if (prior && canonicalJson(prior) !== canonicalJson(contract)) {
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
      : nextGenerationNumber(input.command.runId, input.command.nodeRunId);
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
    for (const defect of recoveryDefects) {
      database
        .prepare(
          `UPDATE integration_defects SET status = 'closed', closed_at = ?
            WHERE id = ? AND status = 'open'`,
        )
        .run(now, defect.id);
    }
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
    appendIntegrationAudit({
      commandId: input.commandId,
      actor: input.actor,
      action: "integration.generation-started",
      entityType: "integration-generation",
      entityId: manifest.generationId,
      runId: manifest.runId,
      nodeRunId: manifest.nodeRunId,
      after: {
        generationId: manifest.generationId,
        generation: manifest.generation,
        coverageId: manifest.coverageId,
        coverageHash: manifest.coverageHash,
        manifestHash,
        state: "pending",
      },
      now,
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

  const reworkResponsiblePackages = (input: {
    readonly commandId: string;
    readonly view: IntegrationGenerationView;
    readonly code: string;
    readonly responsibility: unknown;
  }): void => {
    if (!options.workPackages) return;
    const responsibleVersionIds =
      typeof input.responsibility === "object" &&
      input.responsibility !== null &&
      "workPackageVersionIds" in input.responsibility &&
      Array.isArray(input.responsibility.workPackageVersionIds)
        ? input.responsibility.workPackageVersionIds.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
    if (responsibleVersionIds.length === 0) return;
    const affectedVersionIds = new Set(responsibleVersionIds);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const manifestPackage of input.view.manifest.packages) {
        if (
          !affectedVersionIds.has(manifestPackage.workPackageVersionId) &&
          manifestPackage.dependencies.some((dependency) =>
            affectedVersionIds.has(dependency.predecessorWorkPackageVersionId),
          )
        ) {
          affectedVersionIds.add(manifestPackage.workPackageVersionId);
          expanded = true;
        }
      }
    }
    let graph = options.workPackages.inspect(input.view.manifest.runId);
    const replacements: Record<string, string> = {};
    for (const manifestPackage of input.view.manifest.packages) {
      if (!affectedVersionIds.has(manifestPackage.workPackageVersionId)) {
        continue;
      }
      const workPackage = graph.packages.find(
        (entry) => entry.id === manifestPackage.workPackageId,
      );
      const activeVersion = workPackage?.versions.find(
        (entry) => entry.status === "ready",
      );
      if (!workPackage || !activeVersion) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_REWORK_TARGET_INVALID",
          `Responsible Work Package ${manifestPackage.workPackageId} has no active Version to rework.`,
        );
      }
      if (activeVersion.id !== manifestPackage.workPackageVersionId) {
        replacements[manifestPackage.workPackageVersionId] = activeVersion.id;
        continue;
      }
      const versionId = `integration-rework:${input.view.id}:${manifestPackage.workPackageId}:v${activeVersion.version + 1}`;
      graph = options.workPackages.reworkInTransaction({
        commandId: input.commandId,
        actor: integrationWorkerActor,
        expectedRevision: workPackage.revision,
        workPackageId: manifestPackage.workPackageId,
        versionId,
        baseCommit: manifestPackage.baseCommit,
        recoveryReason: `Integration Generation ${input.view.id} failed: ${input.code}`,
        dependencyVersionReplacements: { ...replacements },
      });
      replacements[manifestPackage.workPackageVersionId] = versionId;
    }
  };

  const failGeneration = (input: {
    readonly commandId: string;
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
    const transition = database
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
    if (transition.changes !== 1) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_GENERATION_TERMINAL",
        `Integration Generation ${input.view.id} cannot transition from ${input.view.state} to ${input.blocked ? "blocked" : "failed"}.`,
      );
    }
    createDefect({
      generationId: input.view.id,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      kind: input.kind,
      responsibility: input.responsibility,
      evidence: input.evidence,
      now,
    });
    const pipelineFailure = {
      runId: input.view.manifest.runId,
      nodeRunId: input.view.manifest.nodeRunId,
      generationId: input.view.id,
      failure: { code: input.code, message: input.message },
    };
    options.pipelineRuntime.blockIntegrationInTransaction(pipelineFailure);
    if (!input.blocked) {
      reworkResponsiblePackages(input);
      options.pipelineRuntime.requeueIntegrationRecoveryInTransaction({
        runId: input.view.manifest.runId,
        integrationNodeRunId: input.view.manifest.nodeRunId,
        generationId: input.view.id,
      });
    }
    appendIntegrationAudit({
      commandId: input.commandId,
      actor: integrationWorkerActor,
      action: input.blocked
        ? "integration.generation-blocked"
        : "integration.generation-failed",
      entityType: "integration-generation",
      entityId: input.view.id,
      runId: input.view.manifest.runId,
      nodeRunId: input.view.manifest.nodeRunId,
      before: { state: input.view.state },
      after: {
        state: input.blocked ? "blocked" : "failed",
        code: input.code,
        message: input.message,
      },
      now,
    });
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
        commandId: input.commandId,
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

  const persistOperationUnitOfWork = (input: {
    readonly commandId: string;
    readonly request: unknown;
    readonly view: IntegrationGenerationView;
    readonly operationId: string;
    readonly action:
      | "integration.operation.intent-recorded"
      | "integration.operation.finalized";
    readonly payload: Readonly<Record<string, unknown>> & {
      readonly generationId: string;
      readonly state: IntegrationGenerationView["state"];
    };
    readonly failurePoint?:
      | "during-operation-intent"
      | "during-operation-finalization"
      | "during-failure-finalization";
    readonly mutate: (now: string) => void;
    readonly appendAfterOperation?: (now: string) => void;
  }):
    | {
        readonly kind: "applied";
        readonly receipt: {
          readonly status: "succeeded";
          readonly value: {
            readonly operationId: string;
            readonly action: string;
            readonly payload: Readonly<Record<string, unknown>>;
          };
          readonly effectIds: readonly string[];
        };
      }
    | {
        readonly kind: "replayed";
        readonly receipt: {
          readonly status: "succeeded";
          readonly value: {
            readonly operationId: string;
            readonly action: string;
            readonly payload: Readonly<Record<string, unknown>>;
          };
          readonly effectIds: readonly string[];
        };
      } => {
    const now = clock().toISOString();
    const requestHash = sha256(
      canonicalJson({
        schemaVersion: 1,
        actor: integrationWorkerActor,
        consumerId: "integration-node-handler",
        request: input.request,
      }),
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare(
          `SELECT actor_type AS actorType, actor_id AS actorId,
                  authenticated_by AS authenticatedBy,
                  consumer_id AS consumerId, schema_version AS schemaVersion,
                  request_hash AS requestHash, status,
                  result_json AS resultJson, result_hash AS resultHash,
                  effect_ids_json AS effectIdsJson
             FROM command_deduplication WHERE command_id = ?`,
        )
        .get(input.commandId) as
        | {
            readonly actorType: string;
            readonly actorId: string;
            readonly authenticatedBy: string;
            readonly consumerId: string;
            readonly schemaVersion: number;
            readonly requestHash: string;
            readonly status: string;
            readonly resultJson: string;
            readonly resultHash: string;
            readonly effectIdsJson: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.actorType !== integrationWorkerActor.type ||
          existing.actorId !== integrationWorkerActor.id ||
          existing.authenticatedBy !== integrationWorkerActor.authenticatedBy ||
          existing.consumerId !== "integration-node-handler" ||
          Number(existing.schemaVersion) !== 1 ||
          existing.requestHash !== requestHash ||
          existing.status !== "completed" ||
          sha256(existing.resultJson) !== existing.resultHash
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONFLICT",
            `Integration worker Unit of Work ${input.commandId} was reused with changed identity or result.`,
          );
        }
        const receipt = parseJson<{
          readonly status: string;
          readonly value: unknown;
          readonly effectIds: unknown;
        }>(existing.resultJson);
        const storedEffectIds = parseJson<unknown>(existing.effectIdsJson);
        const actualEffectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(input.commandId) as Array<{ readonly id: string }>
        ).map((entry) => entry.id);
        const expectedValue = {
          operationId: input.operationId,
          action: input.action,
          payload: input.payload,
        };
        if (
          receipt.status !== "succeeded" ||
          canonicalJson(receipt.value) !== canonicalJson(expectedValue) ||
          !Array.isArray(receipt.effectIds) ||
          !receipt.effectIds.every(
            (effectId) => typeof effectId === "string",
          ) ||
          !Array.isArray(storedEffectIds) ||
          !storedEffectIds.every((effectId) => typeof effectId === "string") ||
          canonicalJson(receipt.effectIds) !== canonicalJson(storedEffectIds) ||
          canonicalJson(storedEffectIds) !== canonicalJson(actualEffectIds)
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONFLICT",
            `Integration worker Unit of Work ${input.commandId} has an invalid stored receipt authority.`,
          );
        }
        database.exec("COMMIT");
        return {
          kind: "replayed",
          receipt: {
            status: "succeeded",
            value: expectedValue,
            effectIds: actualEffectIds,
          },
        };
      }
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, 'integration-node-handler', 1)`,
        )
        .run(
          input.commandId,
          integrationWorkerActor.type,
          integrationWorkerActor.id,
          integrationWorkerActor.authenticatedBy,
        );
      input.mutate(now);
      const auditId = `${input.commandId}:audit`;
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, ?, 'integration-operation', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?,
                     'integration-node-handler')`,
        )
        .run(
          auditId,
          input.action,
          input.operationId,
          input.view.manifest.runId,
          input.view.manifest.nodeRunId,
          canonicalJson(input.payload),
          now,
          input.commandId,
          integrationWorkerActor.type,
          integrationWorkerActor.id,
          integrationWorkerActor.authenticatedBy,
        );
      options.events.append({
        type: input.action,
        scope: {
          companyId: "company",
          projectId: input.view.manifest.projectId,
          runId: input.view.manifest.runId,
          nodeRunId: input.view.manifest.nodeRunId,
          integrationGenerationId: input.view.id,
          integrationOperationId: input.operationId,
          commandId: input.commandId,
        },
        payload: input.payload,
        timestamp: now,
      });
      input.appendAfterOperation?.(now);
      if (input.failurePoint) {
        options.failureInjection?.(input.failurePoint, input.operationId);
      }
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(input.commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      const receiptJson = canonicalJson({
        status: "succeeded",
        value: {
          operationId: input.operationId,
          action: input.action,
          payload: input.payload,
        },
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
           ) VALUES (?, ?, ?, ?, 'integration-node-handler', 1, ?, 'completed',
                     ?, ?, ?, ?)`,
        )
        .run(
          input.commandId,
          integrationWorkerActor.type,
          integrationWorkerActor.id,
          integrationWorkerActor.authenticatedBy,
          requestHash,
          receiptJson,
          sha256(receiptJson),
          canonicalJson(effectIds),
          now,
        );
      database.exec("COMMIT");
      return {
        kind: "applied",
        receipt: {
          status: "succeeded",
          value: {
            operationId: input.operationId,
            action: input.action,
            payload: input.payload,
          },
          effectIds,
        },
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const persistGenerationBlockUnitOfWork = (input: {
    readonly commandId: string;
    readonly prepareInTransaction: () => {
      readonly request: unknown;
      readonly projectId: string;
      readonly runId: string;
      readonly nodeRunId: string;
      readonly generationId: string;
      readonly before: unknown;
      readonly after: Readonly<Record<string, unknown>> & {
        readonly generationId: string;
        readonly state: "blocked";
        readonly code: string;
        readonly message: string;
      };
      readonly mutationOwnsEvidence?: boolean;
      readonly assertApplicable?: () => void;
      readonly mutate: (now: string) => void;
    };
  }): void => {
    const now = clock().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const prepared = input.prepareInTransaction();
      const requestHash = sha256(
        canonicalJson({
          schemaVersion: 1,
          actor: integrationWorkerActor,
          consumerId: "integration-node-handler",
          request: prepared.request,
        }),
      );
      const existing = database
        .prepare(
          `SELECT actor_type AS actorType, actor_id AS actorId,
                  authenticated_by AS authenticatedBy,
                  consumer_id AS consumerId, schema_version AS schemaVersion,
                  request_hash AS requestHash, status,
                  result_json AS resultJson, result_hash AS resultHash,
                  effect_ids_json AS effectIdsJson
             FROM command_deduplication WHERE command_id = ?`,
        )
        .get(input.commandId) as
        | {
            readonly actorType: string;
            readonly actorId: string;
            readonly authenticatedBy: string;
            readonly consumerId: string;
            readonly schemaVersion: number;
            readonly requestHash: string;
            readonly status: string;
            readonly resultJson: string;
            readonly resultHash: string;
            readonly effectIdsJson: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.actorType !== integrationWorkerActor.type ||
          existing.actorId !== integrationWorkerActor.id ||
          existing.authenticatedBy !== integrationWorkerActor.authenticatedBy ||
          existing.consumerId !== "integration-node-handler" ||
          Number(existing.schemaVersion) !== 1 ||
          existing.requestHash !== requestHash ||
          existing.status !== "completed" ||
          sha256(existing.resultJson) !== existing.resultHash
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONFLICT",
            `Integration generation Unit of Work ${input.commandId} was reused with changed identity or result.`,
          );
        }
        const receipt = parseJson<{
          readonly status: string;
          readonly value: unknown;
          readonly effectIds: unknown;
        }>(existing.resultJson);
        const storedEffectIds = parseJson<unknown>(existing.effectIdsJson);
        const actualEffectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(input.commandId) as Array<{ readonly id: string }>
        ).map((entry) => entry.id);
        if (
          receipt.status !== "succeeded" ||
          canonicalJson(receipt.value) !==
            canonicalJson({
              generationId: prepared.generationId,
              state: "blocked",
            }) ||
          !Array.isArray(receipt.effectIds) ||
          !receipt.effectIds.every(
            (effectId) => typeof effectId === "string",
          ) ||
          !Array.isArray(storedEffectIds) ||
          !storedEffectIds.every((effectId) => typeof effectId === "string") ||
          canonicalJson(receipt.effectIds) !== canonicalJson(storedEffectIds) ||
          canonicalJson(storedEffectIds) !== canonicalJson(actualEffectIds)
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONFLICT",
            `Integration generation Unit of Work ${input.commandId} has an invalid stored receipt authority.`,
          );
        }
        database.exec("COMMIT");
        return;
      }
      prepared.assertApplicable?.();
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, 'integration-node-handler', 1)`,
        )
        .run(
          input.commandId,
          integrationWorkerActor.type,
          integrationWorkerActor.id,
          integrationWorkerActor.authenticatedBy,
        );
      prepared.mutate(now);
      if (!prepared.mutationOwnsEvidence) {
        appendIntegrationAudit({
          commandId: input.commandId,
          actor: integrationWorkerActor,
          action: "integration.generation-blocked",
          entityType: "integration-generation",
          entityId: prepared.generationId,
          runId: prepared.runId,
          nodeRunId: prepared.nodeRunId,
          before: prepared.before,
          after: prepared.after,
          now,
        });
        options.events.append({
          type: "integration.generation.blocked",
          scope: {
            companyId: "company",
            projectId: prepared.projectId,
            runId: prepared.runId,
            nodeRunId: prepared.nodeRunId,
            integrationGenerationId: prepared.generationId,
            commandId: input.commandId,
          },
          payload: prepared.after,
          timestamp: now,
        });
      }
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(input.commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      const resultJson = canonicalJson({
        status: "succeeded",
        value: { generationId: prepared.generationId, state: "blocked" },
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
           ) VALUES (?, ?, ?, ?, 'integration-node-handler', 1, ?, 'completed',
                     ?, ?, ?, ?)`,
        )
        .run(
          input.commandId,
          integrationWorkerActor.type,
          integrationWorkerActor.id,
          integrationWorkerActor.authenticatedBy,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(effectIds),
          now,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
    database
      .prepare(
        `UPDATE integration_operations SET state = 'running', updated_at = ?
          WHERE id = ? AND state = 'intent'`,
      )
      .run(now, input.request.operationId);
  };

  const finalizeSucceededOperation = (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly request: GitIntegrationRequest;
    readonly result: Extract<
      GitIntegrationResult,
      { readonly status: "succeeded" }
    >;
  }): boolean => {
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
            AND state IN ('intent', 'running', 'unknown')`,
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
            SET state = 'running', expected_tip = ?, integrated_commit = ?,
                failure_code = NULL, failure_message = NULL, updated_at = ?
          WHERE generation_id = ? AND repository_reference = ?`,
      )
      .run(
        input.result.resultingCommit,
        input.result.resultingCommit,
        now,
        input.view.id,
        input.entry.repositoryReference,
      );
    database
      .prepare(
        `UPDATE integration_generations
            SET state = 'running', failure_code = NULL,
                failure_message = NULL, updated_at = ?
          WHERE id = ? AND state = 'blocked'`,
      )
      .run(now, input.view.id);
    database
      .prepare(
        `UPDATE integration_defects SET status = 'closed', closed_at = ?
          WHERE generation_id = ? AND integration_operation_id = ?
            AND kind = 'reconciliation' AND status = 'open'`,
      )
      .run(now, input.view.id, input.request.operationId);
    const succeeded = database
      .prepare(
        `SELECT COUNT(*) AS count FROM integration_operations
          WHERE generation_id = ? AND state = 'succeeded'`,
      )
      .get(input.view.id) as { readonly count: number };
    if (succeeded.count === input.view.manifest.packages.length) {
      database
        .prepare(
          `UPDATE integration_repository_results
              SET state = 'validating', updated_at = ?
            WHERE generation_id = ? AND state = 'running'`,
        )
        .run(now, input.view.id);
      const advanced = database
        .prepare(
          `UPDATE integration_generations
              SET state = 'validating', updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .run(now, input.view.id);
      return advanced.changes === 1;
    }
    return false;
  };

  const adapterFailure = (
    error: unknown,
  ): Extract<GitIntegrationResult, { status: "unknown" }> => {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    const message =
      error instanceof Error
        ? error.message
        : "The Integration Git Adapter failed without a provable result.";
    return {
      status: "unknown",
      code: "RECONCILE_UNKNOWN",
      message,
      evidence: { causeCode: code ?? "INTEGRATION_ADAPTER_ERROR" },
    };
  };

  const executeGit = (
    request: GitIntegrationRequest,
  ): Promise<GitIntegrationResult> => {
    const active = activeGitExecutions.get(request.operationId);
    if (active) return active;
    const execution = (async () => {
      try {
        return await options.gitAdapter.execute(request);
      } catch (error) {
        return adapterFailure(error);
      }
    })();
    activeGitExecutions.set(request.operationId, execution);
    void execution.finally(() => {
      if (activeGitExecutions.get(request.operationId) === execution) {
        activeGitExecutions.delete(request.operationId);
      }
    });
    return execution;
  };

  const resolveOperation = async (input: {
    readonly view: IntegrationGenerationView;
    readonly entry: CompletedCodeReviewCoveragePackage;
    readonly request: GitIntegrationRequest;
    readonly ordinal: number;
  }): Promise<boolean> => {
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
      const active = activeGitExecutions.get(input.request.operationId);
      if (active) result = await active;
      else
        try {
          result = await options.gitAdapter.reconcile(input.request);
        } catch (error) {
          result = adapterFailure(error);
        }
      if (result.status === "not-applied") {
        if (persisted.state === "unknown") return false;
        result = await executeGit(input.request);
      }
    } else {
      options.failureInjection?.(
        "before-operation-intent",
        input.request.operationId,
      );
      const intent = persistOperationUnitOfWork({
        commandId: `integration-operation:${input.request.operationId}:intent`,
        request: input.request,
        view: input.view,
        operationId: input.request.operationId,
        action: "integration.operation.intent-recorded",
        payload: {
          generationId: input.view.id,
          state: "running",
          operationId: input.request.operationId,
          repositoryReference: input.entry.repositoryReference,
          workPackageVersionId: input.entry.workPackageVersionId,
          requestHash: input.request.requestHash,
        },
        failurePoint: "during-operation-intent",
        mutate: () => persistIntent(input),
      });
      if (intent.kind === "replayed") {
        return resolveOperation({ ...input, view: readOne(input.view.id) });
      }
      options.failureInjection?.("after-intent", input.request.operationId);
      result = await executeGit(input.request);
      options.failureInjection?.("after-effect", input.request.operationId);
    }
    if (result.status === "succeeded") {
      const outcomeHash = sha256(canonicalJson(result));
      let advancedToValidation = false;
      persistOperationUnitOfWork({
        commandId: `integration-operation:${input.request.operationId}:finalize`,
        request: { requestHash: input.request.requestHash, result },
        view: input.view,
        operationId: input.request.operationId,
        action: "integration.operation.finalized",
        payload: {
          generationId: input.view.id,
          state: "running",
          operationId: input.request.operationId,
          operationState: "succeeded",
          repositoryReference: input.entry.repositoryReference,
          resultingCommit: result.resultingCommit,
          outcomeHash,
        },
        failurePoint: "during-operation-finalization",
        mutate: () => {
          advancedToValidation = finalizeSucceededOperation({
            view: input.view,
            entry: input.entry,
            request: input.request,
            result,
          });
          if (input.view.state === "blocked") {
            options.pipelineRuntime.resumeIntegrationInTransaction?.({
              runId: input.view.manifest.runId,
              nodeRunId: input.view.manifest.nodeRunId,
              generationId: input.view.id,
            });
          }
        },
        appendAfterOperation: (now) => {
          if (!advancedToValidation) return;
          appendIntegrationAudit({
            commandId: `integration-operation:${input.request.operationId}:finalize`,
            actor: integrationWorkerActor,
            action: "integration.generation-validating",
            entityType: "integration-generation",
            entityId: input.view.id,
            runId: input.view.manifest.runId,
            nodeRunId: input.view.manifest.nodeRunId,
            before: { state: "running" },
            after: {
              state: "validating",
              manifestHash: input.view.manifestHash,
            },
            now,
          });
          options.events.append({
            type: "integration.generation.validating",
            scope: {
              companyId: "company",
              projectId: input.view.manifest.projectId,
              runId: input.view.manifest.runId,
              nodeRunId: input.view.manifest.nodeRunId,
              integrationGenerationId: input.view.id,
              commandId: `integration-operation:${input.request.operationId}:finalize`,
            },
            payload: {
              generationId: input.view.id,
              state: "validating",
              manifestHash: input.view.manifestHash,
            },
            timestamp: now,
          });
        },
      });
      return true;
    }
    const now = clock().toISOString();
    const isUnknown = result.status === "unknown";
    const outcomeHash = sha256(canonicalJson(result));
    const finalizeCommandId = `integration-operation:${input.request.operationId}:${isUnknown ? "unknown" : "finalize"}`;
    persistOperationUnitOfWork({
      commandId: finalizeCommandId,
      request: { requestHash: input.request.requestHash, result },
      view: input.view,
      operationId: input.request.operationId,
      action: "integration.operation.finalized",
      payload: {
        generationId: input.view.id,
        state: isUnknown ? "blocked" : "failed",
        operationId: input.request.operationId,
        operationState: isUnknown ? "unknown" : "failed",
        repositoryReference: input.entry.repositoryReference,
        failureCode: result.code,
        outcomeHash,
      },
      failurePoint: isUnknown
        ? "during-operation-finalization"
        : "during-failure-finalization",
      mutate: () => {
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
        failGeneration({
          commandId: finalizeCommandId,
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
      },
    });
    return false;
  };

  const executePending = async (
    generationId: string,
    reconcileBlocked = false,
  ): Promise<IntegrationGenerationView> => {
    let view = readOne(generationId);
    if (["failed", "passed"].includes(view.state)) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_GENERATION_TERMINAL",
        `Integration Generation ${generationId} cannot continue from ${view.state}.`,
      );
    }
    if (view.state === "blocked" && !reconcileBlocked) return view;
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
      if (!(await resolveOperation({ view, entry, request, ordinal }))) {
        return readOne(generationId);
      }
    }
    return readOne(generationId);
  };

  const resumeBlockedExecutionStage = (input: {
    readonly view: IntegrationGenerationView;
    readonly operationKey: string;
    readonly phase: "validation" | "aggregate-review";
  }): IntegrationGenerationView => {
    if (input.view.state !== "blocked") return input.view;
    const stage = database
      .prepare(
        `SELECT state FROM integration_execution_stages
          WHERE operation_key = ? AND generation_id = ? AND phase = ?`,
      )
      .get(input.operationKey, input.view.id, input.phase) as
      | { readonly state: string }
      | undefined;
    if (!stage || !["succeeded", "failed"].includes(stage.state)) {
      return input.view;
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE integration_generations
            SET state = ?, failure_code = NULL, failure_message = NULL,
                updated_at = ?
          WHERE id = ? AND state = 'blocked'`,
      )
      .run(
        input.phase === "validation" ? "validating" : "aggregate-review",
        now,
        input.view.id,
      );
    options.pipelineRuntime.resumeIntegrationInTransaction?.({
      runId: input.view.manifest.runId,
      nodeRunId: input.view.manifest.nodeRunId,
      generationId: input.view.id,
    });
    database
      .prepare(
        `UPDATE integration_defects SET status = 'closed', closed_at = ?
          WHERE generation_id = ? AND kind = 'reconciliation' AND status = 'open'`,
      )
      .run(now, input.view.id);
    return readOne(input.view.id);
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
    let view = readOne(input.command.generationId);
    view = resumeBlockedExecutionStage({
      view,
      operationKey: `${view.id}:validation:${input.command.validationId}`,
      phase: "validation",
    });
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
        commandId: input.commandId,
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
      appendIntegrationAudit({
        commandId: input.commandId,
        actor: input.actor,
        action: "integration.generation-aggregate-review",
        entityType: "integration-generation",
        entityId: view.id,
        runId: view.manifest.runId,
        nodeRunId: view.manifest.nodeRunId,
        before: { state: "validating" },
        after: { state: "aggregate-review", manifestHash: view.manifestHash },
        now,
      });
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
    let view = readOne(input.command.generationId);
    view = resumeBlockedExecutionStage({
      view,
      operationKey: `${view.id}:aggregate-review`,
      phase: "aggregate-review",
    });
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
    const aggregateManifest = aggregateReviewManifestFor({
      generationId: view.id,
      manifestHash: view.manifestHash,
      generationManifest: view.manifest,
      topicId: input.command.topicId,
      repositoryCommits,
    });
    const aggregateManifestHash = sha256(canonicalJson(aggregateManifest));
    const evidencePolicy = aggregateEvidencePolicy({
      generationManifest: view.manifest,
      manifestHash: view.manifestHash,
      repositoryCommits,
    });
    const gateEvidence = gate ? [...gate.evidenceRefs] : [];
    const executionEvidence = gateEvidence.filter((ref) =>
      ref.startsWith("execution-fact:"),
    );
    const evidenceIsExact =
      new Set(gateEvidence).size === gateEvidence.length &&
      executionEvidence.length === 1 &&
      gateEvidence.every(
        (ref) =>
          ref === executionEvidence[0] || evidencePolicy.allowed.has(ref),
      ) &&
      evidencePolicy.required.every((ref) => gateEvidence.includes(ref));
    if (
      !gate ||
      gate.id !== input.command.qualityGateResultId ||
      gate.kind !== "aggregate" ||
      canonicalJson(gate.manifest) !== canonicalJson(aggregateManifest) ||
      gate.manifestHash !== aggregateManifestHash ||
      !evidenceIsExact
    ) {
      throw new IntegrationRuntimeError(
        "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
        "Aggregate Review Gate does not bind the exact Integration manifest and integrated commits.",
      );
    }
    const now = clock().toISOString();
    const evidence = gateEvidence.sort();
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
    const aggregateReviewId = randomUUID();
    database
      .prepare(
        `INSERT INTO integration_aggregate_reviews(
           id, generation_id, topic_id, quality_gate_result_id, input_json,
           input_hash, result, evidence_json, pass_authority_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        aggregateReviewId,
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
    appendIntegrationAudit({
      commandId: input.commandId,
      actor: input.actor,
      action: "integration.aggregate-review-recorded",
      entityType: "integration-aggregate-review",
      entityId: aggregateReviewId,
      runId: view.manifest.runId,
      nodeRunId: view.manifest.nodeRunId,
      after: {
        generationId: view.id,
        inputHash: aggregateManifestHash,
        result: gate.result,
        evidence,
        passAuthorityHash,
      },
      now,
    });
    if (!passAuthorityHash) {
      failGeneration({
        commandId: input.commandId,
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
    appendIntegrationAudit({
      commandId: input.commandId,
      actor: input.actor,
      action: "integration.generation-passed",
      entityType: "integration-generation",
      entityId: view.id,
      runId: view.manifest.runId,
      nodeRunId: view.manifest.nodeRunId,
      before: { state: "aggregate-review" },
      after: { state: "passed", passAuthorityHash },
      now,
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
    nextGenerationNumber,
    inspectPending: () => {
      const ids = database
        .prepare(
          `SELECT id FROM integration_generations
            WHERE state IN ('pending', 'running', 'validating', 'aggregate-review')
               OR (
                 state = 'blocked' AND EXISTS (
                   SELECT 1 FROM integration_execution_stages
                    WHERE integration_execution_stages.generation_id = integration_generations.id
                      AND integration_execution_stages.state IN ('running', 'reconciling', 'unknown')
                 )
               )
            ORDER BY updated_at, id`,
        )
        .all() as Array<{ readonly id: string }>;
      return ids.map((entry) => readOne(entry.id));
    },
    dispatchInTransaction,
    executePending,
    reconcilePending: async () => {
      const ids = database
        .prepare(
          `SELECT DISTINCT generation_id AS id FROM integration_operations
            WHERE state IN ('intent', 'running', 'unknown') ORDER BY updated_at, id`,
        )
        .all() as Array<{ readonly id: string }>;
      for (const entry of ids) await executePending(entry.id, true);
      return ids.length;
    },
    cancelPendingGit: async ({ runId, nodeRunId }) => {
      if (!options.gitAdapter.cancel) return;
      const operations = database
        .prepare(
          `SELECT integration_operations.id
             FROM integration_operations
             JOIN integration_generations
               ON integration_generations.id = integration_operations.generation_id
            WHERE integration_generations.run_id = ?
              AND integration_generations.node_run_id = ?
              AND integration_operations.state IN ('intent', 'running')`,
        )
        .all(runId, nodeRunId) as Array<{ readonly id: string }>;
      await Promise.all(
        operations.map(async (operation) => {
          try {
            await options.gitAdapter.cancel!(operation.id);
          } catch {
            // Cancellation is advisory; exact Git reconciliation owns truth.
          }
        }),
      );
    },
    claimExecutionStage: (input) => {
      const requestJson = canonicalJson(input.request);
      const requestHash = sha256(requestJson);
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = database
          .prepare(
            `SELECT generation_id AS generationId, phase,
                    target_key AS targetKey, request_json AS requestJson,
                    request_hash AS requestHash, state,
                    result_json AS resultJson, result_hash AS resultHash
               FROM integration_execution_stages WHERE operation_key = ?`,
          )
          .get(input.operationKey) as
          | {
              readonly generationId: string;
              readonly phase: string;
              readonly targetKey: string;
              readonly requestJson: string;
              readonly requestHash: string;
              readonly state: string;
              readonly resultJson: string | null;
              readonly resultHash: string | null;
            }
          | undefined;
        if (!existing) {
          if (!input.createIfMissing) {
            database.exec("COMMIT");
            return { mode: "missing" } as const;
          }
          const now = clock().toISOString();
          database
            .prepare(
              `INSERT INTO integration_execution_stages(
                 id, operation_key, generation_id, phase, target_key,
                 request_json, request_hash, state, result_json, result_hash,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)`,
            )
            .run(
              randomUUID(),
              input.operationKey,
              input.generationId,
              input.phase,
              input.targetKey,
              requestJson,
              requestHash,
              now,
              now,
            );
          database.exec("COMMIT");
          return { mode: "execute" } as const;
        }
        if (
          existing.generationId !== input.generationId ||
          existing.phase !== input.phase ||
          existing.targetKey !== input.targetKey ||
          existing.requestHash !== requestHash ||
          existing.requestJson !== requestJson
        ) {
          throw new IntegrationRuntimeError(
            "INTEGRATION_CONFLICT",
            `Integration execution stage ${input.operationKey} was reused with changed frozen input.`,
          );
        }
        if (existing.state === "succeeded" || existing.state === "failed") {
          if (!existing.resultJson) {
            throw new IntegrationRuntimeError(
              "INTEGRATION_CONFLICT",
              `Terminal Integration execution stage ${input.operationKey} has no result authority.`,
            );
          }
          const result = assertTerminalExecutionStageResult({
            operationKey: input.operationKey,
            phase: input.phase,
            state: existing.state,
            request: input.request,
            resultJson: existing.resultJson,
            resultHash: existing.resultHash,
          });
          database.exec("COMMIT");
          return {
            mode: "terminal",
            result,
          } as const;
        }
        database
          .prepare(
            `UPDATE integration_execution_stages
                SET state = 'reconciling', updated_at = ?
              WHERE operation_key = ? AND state IN ('running', 'reconciling', 'unknown')`,
          )
          .run(clock().toISOString(), input.operationKey);
        database.exec("COMMIT");
        return { mode: "reconcile" } as const;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    recordExecutionStageResult: (input) => {
      const requestJson = canonicalJson(input.request);
      const requestHash = sha256(requestJson);
      const resultJson = canonicalJson(input.result);
      const resultHash = sha256(resultJson);
      database.exec("BEGIN IMMEDIATE");
      try {
        const updated = database
          .prepare(
            `UPDATE integration_execution_stages
                SET state = ?, result_json = ?, result_hash = ?, updated_at = ?
              WHERE operation_key = ? AND request_hash = ? AND request_json = ?
                AND state IN ('running', 'reconciling', 'unknown')`,
          )
          .run(
            input.state,
            resultJson,
            resultHash,
            clock().toISOString(),
            input.operationKey,
            requestHash,
            requestJson,
          );
        if (Number(updated.changes) !== 1) {
          const existing = database
            .prepare(
              `SELECT state, result_hash AS resultHash
                 FROM integration_execution_stages WHERE operation_key = ?`,
            )
            .get(input.operationKey) as
            | { readonly state: string; readonly resultHash: string | null }
            | undefined;
          if (
            !existing ||
            existing.state !== input.state ||
            existing.resultHash !== resultHash
          ) {
            throw new IntegrationRuntimeError(
              "INTEGRATION_CONFLICT",
              `Integration execution stage ${input.operationKey} result conflicts with its frozen authority.`,
            );
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    inspectExecutionStageRequests: (generationId) =>
      (
        database
          .prepare(
            `SELECT operation_key AS operationKey, phase, request_json AS requestJson,
                    state
               FROM integration_execution_stages
              WHERE generation_id = ?
                AND state IN ('running', 'reconciling', 'unknown')
              ORDER BY created_at, operation_key`,
          )
          .all(generationId) as Array<{
          readonly operationKey: string;
          readonly phase: "validation" | "aggregate-review";
          readonly requestJson: string;
          readonly state: "running" | "reconciling" | "unknown";
        }>
      ).map((entry) => ({
        operationKey: entry.operationKey,
        phase: entry.phase,
        request: parseJson<unknown>(entry.requestJson),
        state: entry.state,
      })),
    blockPending: (generationId, failure) => {
      const commandId = `integration-generation:${generationId}:block-pending`;
      persistGenerationBlockUnitOfWork({
        commandId,
        prepareInTransaction: () => {
          const view = readOne(generationId);
          return {
            request: {
              generationId,
              manifestHash: view.manifestHash,
              failure,
            },
            projectId: view.manifest.projectId,
            runId: view.manifest.runId,
            nodeRunId: view.manifest.nodeRunId,
            generationId,
            before: { state: view.state },
            after: {
              generationId,
              state: "blocked" as const,
              code: failure.code,
              message: failure.message,
              evidence: failure.evidence,
            },
            mutationOwnsEvidence: true,
            assertApplicable: () => {
              if (view.state === "passed" || view.state === "failed") {
                throw new IntegrationRuntimeError(
                  "INTEGRATION_GENERATION_TERMINAL",
                  `Integration Generation ${generationId} is already ${view.state}.`,
                );
              }
              if (view.state === "blocked") {
                throw new IntegrationRuntimeError(
                  "INTEGRATION_GENERATION_STATE_INVALID",
                  `Blocked Integration Generation ${generationId} has no matching block receipt.`,
                );
              }
            },
            mutate: () => {
              failGeneration({
                commandId,
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
            },
          };
        },
      });
      return readOne(generationId);
    },
    blockStart: (input) => {
      const run = database
        .prepare(
          `SELECT project_id AS projectId FROM department_runs WHERE id = ?`,
        )
        .get(input.runId) as { readonly projectId: string } | undefined;
      if (!run) {
        throw new IntegrationRuntimeError(
          "INTEGRATION_RUN_NOT_FOUND",
          `Department Run ${input.runId} was not found.`,
        );
      }
      const commandId = `integration-generation:${input.generationId}:block-start`;
      persistGenerationBlockUnitOfWork({
        commandId,
        prepareInTransaction: () => ({
          request: input,
          projectId: run.projectId,
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          generationId: input.generationId,
          before: { state: "not-started" },
          after: {
            generationId: input.generationId,
            state: "blocked" as const,
            code: input.failure.code,
            message: input.failure.message,
            evidence: input.failure.evidence,
          },
          mutate: () => {
            options.pipelineRuntime.blockIntegrationInTransaction({
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              generationId: input.generationId,
              failure: {
                code: input.failure.code,
                message: input.failure.message,
              },
            });
          },
        }),
      });
    },
  };
};
