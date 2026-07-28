import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import {
  IntegrationRuntimeError,
  openIntegrationRuntime,
  type CompletedCodeReviewCoverage,
  type GitIntegrationAdapter,
  type GitIntegrationRequest,
} from "./integrationRuntime.js";

const commit = (digit: string): string => digit.repeat(40);
const hash = (digit: string): string => digit.repeat(64);
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : entry,
  );

const coverage = (
  overrides: Partial<CompletedCodeReviewCoverage> = {},
): CompletedCodeReviewCoverage => ({
  coverageId: "review-attempt-1",
  coverageHash: hash("a"),
  projectId: "project-1",
  runId: "run-1",
  snapshotRevisionId: "snapshot-1",
  nodeRunId: "code-review-node-1",
  nodeAttemptId: "review-attempt-1",
  packages: [
    {
      workPackageId: "package-api",
      workPackageVersionId: "package-api-v1",
      applicationId: "application-api",
      repositoryReference: "/repositories/api",
      baseCommit: commit("1"),
      sourceBranch: "sandcastle/run-1/package-api-v1/attempt-1",
      sourceCommit: commit("2"),
      diffHash: hash("b"),
      authorityId: "authority-api",
      qualityGateResultId: "gate-api",
      dependencies: [],
      contractVersions: [{ id: "contract-api", version: "1", hash: hash("c") }],
      integrationConditions: ["npm test"],
    },
    {
      workPackageId: "package-web",
      workPackageVersionId: "package-web-v1",
      applicationId: "application-web",
      repositoryReference: "/repositories/web",
      baseCommit: commit("3"),
      sourceBranch: "sandcastle/run-1/package-web-v1/attempt-1",
      sourceCommit: commit("4"),
      diffHash: hash("d"),
      authorityId: "authority-web",
      qualityGateResultId: "gate-web",
      dependencies: [
        {
          predecessorWorkPackageVersionId: "package-api-v1",
          kind: "contract",
          contractId: "contract-api",
          contractVersion: "1",
          evidenceRef: "contract-evidence-1",
        },
      ],
      contractVersions: [{ id: "contract-api", version: "1", hash: hash("c") }],
      integrationConditions: ["npm run test:e2e"],
    },
  ],
  ...overrides,
});

const runtimeActor = {
  type: "runtime-worker" as const,
  id: "integration-node-handler",
  authenticatedBy: "runtime" as const,
};

const setup = (
  completedCoverage = coverage(),
  options: {
    readonly gitAdapter?: GitIntegrationAdapter;
    readonly readCoverage?: () => CompletedCodeReviewCoverage;
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
  } = {},
) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const gitCalls: unknown[] = [];
  const gitAdapter: GitIntegrationAdapter = options.gitAdapter ?? {
    execute: (input) => {
      gitCalls.push(input);
      return {
        status: "succeeded",
        beforeTip: input.expectedTip,
        afterTip: input.sourceCommit,
        resultingCommit: input.sourceCommit,
        receipt: { fixture: true },
      };
    },
    reconcile: () => ({ status: "not-applied" }),
  };
  const pipelineCalls: unknown[] = [];
  const eventCalls: Array<{ readonly type: string }> = [];
  const runtime = openIntegrationRuntime(database, {
    events: {
      append: (input) => {
        eventCalls.push({ type: input.type });
        return undefined;
      },
    },
    codeReviews: {
      readCompletedCoverage: options.readCoverage ?? (() => completedCoverage),
    },
    pipelineRuntime: {
      startIntegrationInTransaction: (input) => pipelineCalls.push(input),
      blockIntegrationInTransaction: (input) => pipelineCalls.push(input),
      failIntegrationInTransaction: (input) => pipelineCalls.push(input),
      completeIntegrationInTransaction: (input) => pipelineCalls.push(input),
    },
    gitAdapter,
    ...(options.reviewRuntime ? { reviewRuntime: options.reviewRuntime } : {}),
    ...(options.failureInjection
      ? { failureInjection: options.failureInjection }
      : {}),
    clock: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  return { database, runtime, gitCalls, pipelineCalls, eventCalls };
};

const start = (
  database: DatabaseSync,
  runtime: ReturnType<typeof openIntegrationRuntime>,
  generationId: string,
) => {
  database.exec("BEGIN IMMEDIATE");
  const view = runtime.dispatchInTransaction({
    commandId: `${generationId}:start`,
    actor: runtimeActor,
    command: {
      type: "integration.generation.start",
      generationId,
      runId: "run-1",
      nodeRunId: "integration-node-1",
    },
  });
  database.exec("COMMIT");
  return view;
};

const validateAll = (
  database: DatabaseSync,
  runtime: ReturnType<typeof openIntegrationRuntime>,
  generationId: string,
) => {
  const view = runtime
    .inspect("run-1")
    .find((entry) => entry.id === generationId)!;
  for (const [
    index,
    validation,
  ] of view.manifest.requiredValidations.entries()) {
    database.exec("BEGIN IMMEDIATE");
    runtime.dispatchInTransaction({
      commandId: `${generationId}:validate:${index}`,
      actor: runtimeActor,
      command: {
        type: "integration.validation.record",
        generationId,
        validationId: validation.id,
        repositoryReference: validation.repositoryReference,
        status: "passed",
        kind: validation.kind,
        evidenceRefs: [`validation-${index}`],
        responsibleWorkPackageVersionIds: [],
      },
    });
    database.exec("COMMIT");
  }
};

const aggregateManifest = (
  view: ReturnType<ReturnType<typeof openIntegrationRuntime>["executePending"]>,
  topicId: string,
) => ({
  scope: "aggregate",
  topicId,
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
  repositoryCommits: view.repositoryResults.map((repository) => ({
    repositoryId: repository.repositoryReference,
    commit: repository.integratedCommit!,
  })),
});

describe("Integration Runtime generation manifest", () => {
  it("freezes exact completed Code Review coverage in producer-first repository operations", () => {
    const { database, runtime } = setup();

    database.exec("BEGIN IMMEDIATE");
    const view = runtime.dispatchInTransaction({
      commandId: "integration-start-1",
      actor: runtimeActor,
      command: {
        type: "integration.generation.start",
        generationId: "generation-1",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    database.exec("COMMIT");

    assert.equal(view.manifest.coverageId, "review-attempt-1");
    assert.equal(view.manifest.coverageHash, hash("a"));
    assert.deepEqual(
      view.manifest.repositories.map((repository) => ({
        repositoryReference: repository.repositoryReference,
        baseCommit: repository.baseCommit,
        branch: repository.integrationBranch,
      })),
      [
        {
          repositoryReference: "/repositories/api",
          baseCommit: commit("1"),
          branch: "integration/run-1/g1",
        },
        {
          repositoryReference: "/repositories/web",
          baseCommit: commit("3"),
          branch: "integration/run-1/g1",
        },
      ],
    );
    assert.deepEqual(
      view.operations.map((operation) => operation.workPackageVersionId),
      ["package-api-v1", "package-web-v1"],
    );
    assert.match(view.manifestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      view.manifest.requiredValidations.map((validation) => validation.kind),
      ["build-test", "contract", "build-test"],
    );
    assert.equal(view.state, "pending");
  });

  it("fails closed before Git writes when one Repository coverage has different base commits", () => {
    const inconsistent = coverage({
      packages: [
        coverage().packages[0]!,
        {
          ...coverage().packages[1]!,
          repositoryReference: "/repositories/api",
          baseCommit: commit("9"),
        },
      ],
    });
    const { database, runtime, gitCalls } = setup(inconsistent);

    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        runtime.dispatchInTransaction({
          commandId: "integration-start-base-conflict",
          actor: runtimeActor,
          command: {
            type: "integration.generation.start",
            generationId: "generation-base-conflict",
            runId: "run-1",
            nodeRunId: "integration-node-1",
          },
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_BASE_CONFLICT",
    );
    database.exec("ROLLBACK");

    assert.deepEqual(gitCalls, []);
  });

  it("persists operation receipts in dependency order and waits for every Repository validation", () => {
    const { database, runtime, gitCalls, eventCalls } = setup();
    database.exec("BEGIN IMMEDIATE");
    runtime.dispatchInTransaction({
      commandId: "integration-start-execution",
      actor: runtimeActor,
      command: {
        type: "integration.generation.start",
        generationId: "generation-execution",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    database.exec("COMMIT");

    const integrated = runtime.executePending("generation-execution");
    assert.equal(integrated.state, "validating");
    assert.deepEqual(
      (gitCalls as Array<{ readonly sourceCommit: string }>).map(
        (call) => call.sourceCommit,
      ),
      [commit("2"), commit("4")],
    );
    assert.ok(
      integrated.operations.every(
        (operation) => operation.state === "succeeded",
      ),
    );

    database.exec("BEGIN IMMEDIATE");
    const firstValidation = runtime.dispatchInTransaction({
      commandId: "validate-api",
      actor: runtimeActor,
      command: {
        type: "integration.validation.record",
        generationId: "generation-execution",
        validationId: integrated.manifest.requiredValidations.find(
          (validation) =>
            validation.repositoryReference === "/repositories/api",
        )!.id,
        repositoryReference: "/repositories/api",
        status: "passed",
        kind: "build-test",
        evidenceRefs: ["api-build-log"],
        responsibleWorkPackageVersionIds: [],
      },
    });
    database.exec("COMMIT");
    assert.equal(firstValidation.state, "validating");

    database.exec("BEGIN IMMEDIATE");
    const secondValidation = runtime.dispatchInTransaction({
      commandId: "validate-web",
      actor: runtimeActor,
      command: {
        type: "integration.validation.record",
        generationId: "generation-execution",
        validationId: integrated.manifest.requiredValidations.find(
          (validation) =>
            validation.repositoryReference === "/repositories/web" &&
            validation.kind === "build-test",
        )!.id,
        repositoryReference: "/repositories/web",
        status: "passed",
        kind: "build-test",
        evidenceRefs: ["contract-fixture", "runtime-evidence"],
        responsibleWorkPackageVersionIds: [],
      },
    });
    database.exec("COMMIT");
    assert.equal(secondValidation.state, "validating");

    database.exec("BEGIN IMMEDIATE");
    const fullyValidated = runtime.dispatchInTransaction({
      commandId: "validate-contract",
      actor: runtimeActor,
      command: {
        type: "integration.validation.record",
        generationId: "generation-execution",
        validationId: integrated.manifest.requiredValidations.find(
          (validation) => validation.kind === "contract",
        )!.id,
        repositoryReference: "/repositories/web",
        status: "passed",
        kind: "contract",
        evidenceRefs: ["contract-fixture", "runtime-evidence"],
        responsibleWorkPackageVersionIds: [],
      },
    });
    database.exec("COMMIT");
    assert.equal(fullyValidated.state, "aggregate-review");
    assert.equal(
      fullyValidated.repositoryResults.find(
        (repository) => repository.repositoryReference === "/repositories/web",
      )?.validationRecords.length,
      2,
    );
    assert.deepEqual(
      eventCalls.filter((event) => event.type.startsWith("integration.")),
      [
        { type: "integration.generation.started" },
        { type: "integration.generation.validating" },
        { type: "integration.validation.recorded" },
        { type: "integration.validation.recorded" },
        { type: "integration.validation.recorded" },
        { type: "integration.generation.aggregate-review" },
      ],
    );
  });

  it("fails the whole generation on partial multi-Repository failure and never continues it", () => {
    const calls: string[] = [];
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        calls.push(input.sourceCommit);
        return input.repositoryReference.endsWith("/web")
          ? {
              status: "conflict",
              code: "INTEGRATION_GIT_CONFLICT",
              message: "web conflict",
              evidence: { conflictFiles: ["contract.ts"] },
            }
          : {
              status: "succeeded",
              beforeTip: input.expectedTip,
              afterTip: input.sourceCommit,
              resultingCommit: input.sourceCommit,
              receipt: { applied: input.sourceCommit },
            };
      },
      reconcile: () => ({ status: "not-applied" }),
    };
    const { database, runtime } = setup(coverage(), { gitAdapter: adapter });
    database.exec("BEGIN IMMEDIATE");
    runtime.dispatchInTransaction({
      commandId: "integration-start-partial",
      actor: runtimeActor,
      command: {
        type: "integration.generation.start",
        generationId: "generation-partial",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    database.exec("COMMIT");

    const failed = runtime.executePending("generation-partial");
    assert.equal(failed.state, "failed");
    assert.equal(failed.operations[0]?.state, "succeeded");
    assert.equal(failed.operations[1]?.state, "failed");
    assert.equal(failed.defects[0]?.kind, "git-conflict");
    assert.throws(
      () => runtime.executePending("generation-partial"),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_GENERATION_TERMINAL",
    );
    assert.deepEqual(calls, [commit("2"), commit("4")]);
  });

  it("reconciles an effect committed before receipt finalization without reissuing it", () => {
    const applied = new Map<string, GitIntegrationRequest>();
    let failAfterEffect = true;
    let executeCount = 0;
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        executeCount += 1;
        applied.set(input.operationId, input);
        return {
          status: "succeeded",
          beforeTip: input.expectedTip,
          afterTip: input.sourceCommit,
          resultingCommit: input.sourceCommit,
          receipt: { operationId: input.operationId },
        };
      },
      reconcile: (input) =>
        applied.has(input.operationId)
          ? {
              status: "succeeded",
              beforeTip: input.expectedTip,
              afterTip: input.sourceCommit,
              resultingCommit: input.sourceCommit,
              receipt: { operationId: input.operationId },
            }
          : { status: "not-applied" },
    };
    const { database, runtime } = setup(coverage(), {
      gitAdapter: adapter,
      failureInjection: (point) => {
        if (point === "after-effect" && failAfterEffect) {
          failAfterEffect = false;
          throw new Error("simulated crash after Git effect");
        }
      },
    });
    database.exec("BEGIN IMMEDIATE");
    runtime.dispatchInTransaction({
      commandId: "integration-start-reconcile",
      actor: runtimeActor,
      command: {
        type: "integration.generation.start",
        generationId: "generation-reconcile",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    database.exec("COMMIT");

    assert.throws(
      () => runtime.executePending("generation-reconcile"),
      /simulated crash/,
    );
    assert.equal(runtime.inspect("run-1")[0]?.operations[0]?.state, "running");
    assert.equal(runtime.reconcilePending(), 1);
    assert.equal(runtime.inspect("run-1")[0]?.state, "validating");
    assert.equal(executeCount, 2);
  });

  it("reconciles a frozen started request after mutable Code Review coverage is superseded", () => {
    let currentCoverage = coverage({ packages: [coverage().packages[0]!] });
    let applied: GitIntegrationRequest | undefined;
    let crash = true;
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        applied = input;
        return {
          status: "succeeded",
          beforeTip: input.expectedTip,
          afterTip: input.sourceCommit,
          resultingCommit: input.sourceCommit,
          receipt: { operationId: input.operationId },
        };
      },
      reconcile: (input) =>
        applied
          ? {
              status: "succeeded",
              beforeTip: input.expectedTip,
              afterTip: input.sourceCommit,
              resultingCommit: input.sourceCommit,
              receipt: { operationId: input.operationId },
            }
          : { status: "not-applied" },
    };
    const { database, runtime } = setup(currentCoverage, {
      gitAdapter: adapter,
      readCoverage: () => currentCoverage,
      failureInjection: (point) => {
        if (point === "after-effect" && crash) {
          crash = false;
          throw new Error("crash after effect");
        }
      },
    });
    start(database, runtime, "generation-superseded-reconcile");
    assert.throws(
      () => runtime.executePending("generation-superseded-reconcile"),
      /crash after effect/,
    );
    currentCoverage = coverage({
      coverageId: "review-attempt-2",
      coverageHash: hash("9"),
      packages: [coverage().packages[0]!],
    });

    assert.equal(runtime.reconcilePending(), 1);
    assert.equal(runtime.inspect("run-1")[0]?.state, "validating");
  });

  it("rolls back the complete failure finalization UoW and recovers it on restart", () => {
    let crash = true;
    const adapter: GitIntegrationAdapter = {
      execute: () => ({
        status: "conflict",
        code: "INTEGRATION_GIT_CONFLICT",
        message: "conflict",
        evidence: { conflictFiles: ["api.ts"] },
      }),
      reconcile: () => ({
        status: "conflict",
        code: "INTEGRATION_CONFLICT",
        message: "conflict",
        evidence: { conflictFiles: ["api.ts"] },
      }),
    };
    const { database, runtime } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      {
        gitAdapter: adapter,
        failureInjection: (point) => {
          if (point === "during-failure-finalization" && crash) {
            crash = false;
            throw new Error("crash during failure finalization");
          }
        },
      },
    );
    start(database, runtime, "generation-failure-uow");
    assert.throws(
      () => runtime.executePending("generation-failure-uow"),
      /crash during failure finalization/,
    );
    const preRestart = runtime.inspect("run-1")[0]!;
    assert.equal(preRestart.state, "running");
    assert.equal(preRestart.operations[0]?.state, "running");
    assert.deepEqual(preRestart.defects, []);

    assert.equal(runtime.reconcilePending(), 1);
    const recovered = runtime.inspect("run-1")[0]!;
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.operations[0]?.state, "failed");
    assert.equal(recovered.defects.length, 1);
  });

  it("replays an identical generation manifest and rejects changed coverage for the same identity", () => {
    let currentCoverage = coverage();
    const { database, runtime } = setup(currentCoverage, {
      readCoverage: () => currentCoverage,
    });
    const first = start(database, runtime, "generation-replay");

    database.exec("BEGIN IMMEDIATE");
    const replay = runtime.dispatchInTransaction({
      commandId: "generation-replay:start-again",
      actor: runtimeActor,
      command: {
        type: "integration.generation.start",
        generationId: "generation-replay",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    database.exec("COMMIT");
    assert.equal(replay.manifestHash, first.manifestHash);
    assert.equal(replay.manifest.generation, 1);

    currentCoverage = coverage({ coverageHash: hash("9") });
    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        runtime.dispatchInTransaction({
          commandId: "generation-replay:changed",
          actor: runtimeActor,
          command: {
            type: "integration.generation.start",
            generationId: "generation-replay",
            runId: "run-1",
            nodeRunId: "integration-node-1",
          },
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONFLICT",
    );
    database.exec("ROLLBACK");
  });

  it("reconciles a crash after intent before effect and executes each operation only once", () => {
    let crash = true;
    let executeCount = 0;
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        executeCount += 1;
        return {
          status: "succeeded",
          beforeTip: input.expectedTip,
          afterTip: input.sourceCommit,
          resultingCommit: input.sourceCommit,
          receipt: { operationId: input.operationId },
        };
      },
      reconcile: () => ({ status: "not-applied" }),
    };
    const { database, runtime } = setup(coverage(), {
      gitAdapter: adapter,
      failureInjection: (point) => {
        if (point === "after-intent" && crash) {
          crash = false;
          throw new Error("simulated crash after intent");
        }
      },
    });
    start(database, runtime, "generation-intent-crash");
    assert.throws(
      () => runtime.executePending("generation-intent-crash"),
      /simulated crash after intent/,
    );
    assert.equal(executeCount, 0);
    assert.equal(runtime.reconcilePending(), 1);
    assert.equal(executeCount, 2);
    assert.equal(runtime.inspect("run-1")[0]?.state, "validating");
  });

  it("keeps an unknown Git outcome blocked without blind re-execution", () => {
    let executeCount = 0;
    const adapter: GitIntegrationAdapter = {
      execute: () => {
        executeCount += 1;
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "Git outcome cannot be proven.",
          evidence: { queryable: false },
        };
      },
      reconcile: () => {
        throw new Error(
          "blocked operations must not be reconciled automatically",
        );
      },
    };
    const { database, runtime } = setup(coverage(), { gitAdapter: adapter });
    start(database, runtime, "generation-unknown");
    const blocked = runtime.executePending("generation-unknown");
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.operations[0]?.state, "unknown");
    assert.equal(runtime.reconcilePending(), 0);
    assert.equal(executeCount, 1);
  });

  it("records producer and consumer responsibility for cross-application Contract failure", () => {
    const { database, runtime } = setup();
    start(database, runtime, "generation-contract-failure");
    runtime.executePending("generation-contract-failure");

    database.exec("BEGIN IMMEDIATE");
    const failed = runtime.dispatchInTransaction({
      commandId: "generation-contract-failure:validate",
      actor: runtimeActor,
      command: {
        type: "integration.validation.record",
        generationId: "generation-contract-failure",
        validationId: runtime
          .inspect("run-1")[0]!
          .manifest.requiredValidations.find(
            (validation) => validation.kind === "contract",
          )!.id,
        repositoryReference: "/repositories/web",
        status: "failed",
        kind: "contract",
        evidenceRefs: ["contract-fixture", "runtime-evidence"],
        responsibleWorkPackageVersionIds: ["package-api-v1", "package-web-v1"],
        contractFailure: {
          producerApplicationId: "application-api",
          consumerApplicationId: "application-web",
          contractId: "contract-api",
          contractVersion: "1",
          fixtureRef: "contract-fixture",
          runtimeEvidenceRef: "runtime-evidence",
        },
      },
    });
    database.exec("COMMIT");

    assert.equal(failed.state, "failed");
    assert.equal(failed.defects[0]?.kind, "contract");
    assert.deepEqual(
      (
        failed.defects[0]?.responsibility as {
          readonly workPackageVersionIds: readonly string[];
        }
      ).workPackageVersionIds,
      ["package-api-v1", "package-web-v1"],
    );
  });

  it("rejects contract failure evidence on passed or build-test validation records", () => {
    const { database, runtime } = setup();
    start(database, runtime, "generation-invalid-contract-evidence");
    const integrated = runtime.executePending(
      "generation-invalid-contract-evidence",
    );
    const buildValidation = integrated.manifest.requiredValidations.find(
      (validation) => validation.kind === "build-test",
    )!;
    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        runtime.dispatchInTransaction({
          commandId: "invalid-contract-evidence",
          actor: runtimeActor,
          command: {
            type: "integration.validation.record",
            generationId: integrated.id,
            validationId: buildValidation.id,
            repositoryReference: buildValidation.repositoryReference,
            status: "passed",
            kind: "build-test",
            evidenceRefs: ["evidence"],
            responsibleWorkPackageVersionIds: [],
            contractFailure: {
              producerApplicationId: "application-api",
              consumerApplicationId: "application-web",
              contractId: "contract-api",
              contractVersion: "1",
              fixtureRef: "fixture",
              runtimeEvidenceRef: "runtime",
            },
          },
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONTRACT_EVIDENCE_INVALID",
    );
    database.exec("ROLLBACK");
  });

  it("binds aggregate independent PASS to exact integrated commits and creates downstream authority", () => {
    let gateResult: {
      readonly gateResult: {
        readonly id: string;
        readonly kind: string;
        readonly manifest: unknown;
        readonly manifestHash: string;
        readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
        readonly conditions: readonly string[];
        readonly evidenceRefs: readonly string[];
      } | null;
    } = { gateResult: null };
    const { database, runtime, pipelineCalls } = setup(coverage(), {
      reviewRuntime: { inspect: () => gateResult },
    });
    start(database, runtime, "generation-pass");
    const integrated = runtime.executePending("generation-pass");
    validateAll(database, runtime, "generation-pass");
    const manifest = aggregateManifest(integrated, "aggregate-topic");
    gateResult = {
      gateResult: {
        id: "aggregate-gate-pass",
        kind: "aggregate",
        manifest,
        manifestHash: createHash("sha256")
          .update(canonicalJson(manifest))
          .digest("hex"),
        result: "PASS",
        conditions: [],
        evidenceRefs: ["aggregate-review-evidence"],
      },
    };
    database.exec("BEGIN IMMEDIATE");
    const passed = runtime.dispatchInTransaction({
      commandId: "generation-pass:aggregate",
      actor: runtimeActor,
      command: {
        type: "integration.aggregate-review.record",
        generationId: "generation-pass",
        topicId: "aggregate-topic",
        qualityGateResultId: "aggregate-gate-pass",
      },
    });
    database.exec("COMMIT");
    assert.equal(passed.state, "passed");
    assert.match(passed.passAuthorityHash!, /^[a-f0-9]{64}$/);
    assert.equal(
      passed.aggregateReview?.qualityGateResultId,
      "aggregate-gate-pass",
    );
    assert.deepEqual(passed.aggregateReview?.input, manifest);
    assert.equal(
      pipelineCalls.some(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "passAuthorityHash" in call,
      ),
      true,
    );
  });

  it("fails the generation when aggregate review is not an unconditional PASS", () => {
    let gateResult: {
      readonly gateResult: {
        readonly id: string;
        readonly kind: string;
        readonly manifest: unknown;
        readonly manifestHash: string;
        readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
        readonly conditions: readonly string[];
        readonly evidenceRefs: readonly string[];
      } | null;
    } = { gateResult: null };
    const { database, runtime } = setup(coverage(), {
      reviewRuntime: { inspect: () => gateResult },
    });
    start(database, runtime, "generation-conditional");
    const integrated = runtime.executePending("generation-conditional");
    validateAll(database, runtime, "generation-conditional");
    const manifest = aggregateManifest(
      integrated,
      "aggregate-topic-conditional",
    );
    gateResult = {
      gateResult: {
        id: "aggregate-gate-conditional",
        kind: "aggregate",
        manifest,
        manifestHash: createHash("sha256")
          .update(canonicalJson(manifest))
          .digest("hex"),
        result: "CONDITIONAL_PASS",
        conditions: ["Resolve the aggregate defect."],
        evidenceRefs: ["aggregate-review-evidence"],
      },
    };
    database.exec("BEGIN IMMEDIATE");
    const failed = runtime.dispatchInTransaction({
      commandId: "generation-conditional:aggregate",
      actor: runtimeActor,
      command: {
        type: "integration.aggregate-review.record",
        generationId: "generation-conditional",
        topicId: "aggregate-topic-conditional",
        qualityGateResultId: "aggregate-gate-conditional",
      },
    });
    database.exec("COMMIT");
    assert.equal(failed.state, "failed");
    assert.equal(failed.passAuthorityHash, null);
    assert.equal(failed.defects[0]?.kind, "aggregate");
  });
});
