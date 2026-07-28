import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import type { WorkPackageGraphView } from "../workspaces/workPackages.js";
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
      contractVersions: [
        {
          id: "contract-api",
          version: "1",
          hash: hash("c"),
          producerApplicationId: "application-api",
          consumerApplicationId: "application-web",
          testCommands: ["npm run test:contract"],
          evidenceRefs: ["contract-fixture"],
        },
      ],
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
      contractVersions: [
        {
          id: "contract-api",
          version: "1",
          hash: hash("c"),
          producerApplicationId: "application-api",
          consumerApplicationId: "application-web",
          testCommands: ["npm run test:contract"],
          evidenceRefs: ["contract-fixture"],
        },
      ],
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
    readonly workPackages?: Parameters<
      typeof openIntegrationRuntime
    >[1]["workPackages"];
    readonly recordPipelineAudit?: boolean;
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
  const recordPipelineAudit = (input: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly runId: string;
    readonly nodeRunId: string;
  }) => {
    if (!options.recordPipelineAudit) return;
    const context = database
      .prepare(
        `SELECT command_id AS commandId, actor_type AS actorType,
                actor_id AS actorId, authenticated_by AS authenticatedBy,
                consumer_id AS consumerId
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as {
      readonly commandId: string;
      readonly actorType: string;
      readonly actorId: string;
      readonly authenticatedBy: string;
      readonly consumerId: string;
    };
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${context.commandId}:pipeline-audit`,
        input.action,
        input.entityType,
        input.entityId,
        input.runId,
        input.nodeRunId,
        "2026-07-28T00:00:00.000Z",
        context.commandId,
        context.actorType,
        context.actorId,
        context.authenticatedBy,
        context.consumerId,
      );
  };
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
      startIntegrationInTransaction: (input) =>
        pipelineCalls.push({ kind: "start", ...input }),
      blockIntegrationInTransaction: (input) => {
        pipelineCalls.push({ kind: "block", ...input });
        recordPipelineAudit({
          action: "run.integration-blocked",
          entityType: "department-run",
          entityId: input.runId,
          runId: input.runId,
          nodeRunId: input.nodeRunId,
        });
      },
      failIntegrationInTransaction: (input) =>
        pipelineCalls.push({ kind: "fail", ...input }),
      completeIntegrationInTransaction: (input) =>
        pipelineCalls.push({ kind: "complete", ...input }),
      requeueIntegrationRecoveryInTransaction: (input) =>
        pipelineCalls.push({ kind: "requeue", ...input }),
    },
    gitAdapter,
    ...(options.reviewRuntime ? { reviewRuntime: options.reviewRuntime } : {}),
    ...(options.workPackages ? { workPackages: options.workPackages } : {}),
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
  try {
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
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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
    const contractValidation = view.manifest.requiredValidations.find(
      (validation) => validation.kind === "contract",
    );
    assert.deepEqual(contractValidation?.commands, [
      ["npm", "run", "test:contract"],
    ]);
    assert.deepEqual(contractValidation?.evidenceRefs, ["contract-fixture"]);
    assert.deepEqual(contractValidation?.responsibleWorkPackageVersionIds, [
      "package-api-v1",
      "package-web-v1",
    ]);
    assert.deepEqual(
      view.manifest.requiredValidations
        .filter((validation) => validation.kind === "build-test")
        .map((validation) => validation.responsibleWorkPackageVersionIds),
      [["package-api-v1"], ["package-web-v1"]],
    );
    assert.equal(view.state, "pending");
  });

  it("fails closed before Git when frozen Contract validation commands are empty", () => {
    const invalid = coverage({
      packages: coverage().packages.map((entry) => ({
        ...entry,
        contractVersions: entry.contractVersions.map((contract) => ({
          ...contract,
          testCommands: [],
        })),
      })),
    });
    const { database, runtime, gitCalls } = setup(invalid);

    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        runtime.dispatchInTransaction({
          commandId: "integration-start-empty-contract-command",
          actor: runtimeActor,
          command: {
            type: "integration.generation.start",
            generationId: "generation-empty-contract-command",
            runId: "run-1",
            nodeRunId: "integration-node-1",
          },
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_VALIDATION_COMMANDS_REQUIRED",
    );
    database.exec("ROLLBACK");
    assert.deepEqual(gitCalls, []);
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
        { type: "integration.operation.intent-recorded" },
        { type: "integration.operation.finalized" },
        { type: "integration.operation.intent-recorded" },
        { type: "integration.operation.finalized" },
        { type: "integration.generation.validating" },
        { type: "integration.validation.recorded" },
        { type: "integration.validation.recorded" },
        { type: "integration.validation.recorded" },
        { type: "integration.generation.aggregate-review" },
      ],
    );
  });

  it("records Integration operation intent and finalization as replayable Runtime UoWs", () => {
    const { database, runtime, eventCalls } = setup();
    start(database, runtime, "generation-operation-uow");

    const integrated = runtime.executePending("generation-operation-uow");

    assert.equal(integrated.state, "validating");
    const receipts = database
      .prepare(
        `SELECT command_id AS commandId, effect_ids_json AS effectIdsJson
           FROM command_deduplication
          WHERE command_id LIKE 'integration-operation:generation-operation-uow:%'
          ORDER BY command_id`,
      )
      .all() as Array<{
      readonly commandId: string;
      readonly effectIdsJson: string;
    }>;
    assert.equal(receipts.length, 4);
    assert.equal(
      receipts.filter((entry) => entry.commandId.endsWith(":intent")).length,
      2,
    );
    assert.equal(
      receipts.filter((entry) => entry.commandId.endsWith(":finalize")).length,
      2,
    );
    assert.deepEqual(
      receipts
        .map(
          (entry) =>
            (JSON.parse(entry.effectIdsJson) as readonly string[]).length,
        )
        .sort(),
      [1, 1, 1, 2],
    );
    const auditActions = database
      .prepare(
        `SELECT action FROM runtime_audit_records
          WHERE command_id LIKE 'integration-operation:generation-operation-uow:%'`,
      )
      .all()
      .map((entry) => String(entry.action))
      .sort();
    assert.deepEqual(auditActions, [
      "integration.generation-validating",
      "integration.operation.finalized",
      "integration.operation.finalized",
      "integration.operation.intent-recorded",
      "integration.operation.intent-recorded",
    ]);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM runtime_unit_of_work_context")
        .get()!.count,
      0,
    );
    assert.deepEqual(
      eventCalls.filter((event) =>
        event.type.startsWith("integration.operation"),
      ),
      [
        { type: "integration.operation.intent-recorded" },
        { type: "integration.operation.finalized" },
        { type: "integration.operation.intent-recorded" },
        { type: "integration.operation.finalized" },
      ],
    );
  });

  it("rolls back an operation intent UoW before executing Git and retries cleanly", () => {
    let failIntent = true;
    const { database, runtime, gitCalls } = setup(coverage(), {
      failureInjection: (point) => {
        if (point === "during-operation-intent" && failIntent) {
          failIntent = false;
          throw new Error("intent transaction interrupted");
        }
      },
    });
    start(database, runtime, "generation-intent-uow-rollback");

    assert.throws(
      () => runtime.executePending("generation-intent-uow-rollback"),
      /intent transaction interrupted/,
    );
    assert.deepEqual(gitCalls, []);
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM integration_operations
            WHERE generation_id = 'generation-intent-uow-rollback'`,
        )
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM command_deduplication
            WHERE command_id LIKE 'integration-operation:generation-intent-uow-rollback:%'`,
        )
        .get()!.count,
      0,
    );

    assert.equal(
      runtime.executePending("generation-intent-uow-rollback").state,
      "validating",
    );
    assert.equal(gitCalls.length, 2);
  });

  it("does not execute Git twice when another worker wins the operation intent race", () => {
    let raced = false;
    let executeCount = 0;
    let runtime!: ReturnType<typeof openIntegrationRuntime>;
    const initialized = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      {
        gitAdapter: {
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
        },
        failureInjection: (point) => {
          if (point === "before-operation-intent" && !raced) {
            raced = true;
            runtime.executePending("generation-intent-race");
          }
        },
      },
    );
    runtime = initialized.runtime;
    start(initialized.database, runtime, "generation-intent-race");

    assert.equal(
      runtime.executePending("generation-intent-race").state,
      "validating",
    );
    assert.equal(executeCount, 1);
    assert.equal(
      initialized.database
        .prepare(
          `SELECT COUNT(*) AS count FROM command_deduplication
            WHERE command_id =
              'integration-operation:generation-intent-race:package-api-v1:intent'`,
        )
        .get()!.count,
      1,
    );
  });

  it("reconciles a raced intent receipt in the same invocation", () => {
    let raced = false;
    let crashInner = true;
    let executeCount = 0;
    let runtime!: ReturnType<typeof openIntegrationRuntime>;
    const initialized = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      {
        gitAdapter: {
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
        },
        failureInjection: (point) => {
          if (point === "before-operation-intent" && !raced) {
            raced = true;
            assert.throws(
              () => runtime.executePending("generation-intent-race-crash"),
              /inner worker stopped after intent/,
            );
          }
          if (point === "after-intent" && crashInner) {
            crashInner = false;
            throw new Error("inner worker stopped after intent");
          }
        },
      },
    );
    runtime = initialized.runtime;
    start(initialized.database, runtime, "generation-intent-race-crash");

    assert.equal(
      runtime.executePending("generation-intent-race-crash").state,
      "validating",
    );
    assert.equal(executeCount, 1);
  });

  it("fails closed when a raced intent receipt has inconsistent effect IDs", () => {
    let raced = false;
    let crashInner = true;
    let executeCount = 0;
    let runtime!: ReturnType<typeof openIntegrationRuntime>;
    const initialized = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      {
        gitAdapter: {
          execute: () => {
            executeCount += 1;
            return { status: "not-applied" } as never;
          },
          reconcile: () => ({ status: "not-applied" }),
        },
        failureInjection: (point) => {
          if (point === "before-operation-intent" && !raced) {
            raced = true;
            assert.throws(
              () => runtime.executePending("generation-intent-receipt-drift"),
              /inner worker stopped after intent/,
            );
            initialized.database
              .prepare(
                `UPDATE command_deduplication SET effect_ids_json = '["forged"]'
                  WHERE command_id =
                    'integration-operation:generation-intent-receipt-drift:package-api-v1:intent'`,
              )
              .run();
          }
          if (point === "after-intent" && crashInner) {
            crashInner = false;
            throw new Error("inner worker stopped after intent");
          }
        },
      },
    );
    runtime = initialized.runtime;
    start(initialized.database, runtime, "generation-intent-receipt-drift");

    assert.throws(
      () => runtime.executePending("generation-intent-receipt-drift"),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONFLICT",
    );
    assert.equal(executeCount, 0);
  });

  it("rolls back operation finalization and recovers the Git effect without re-execution", () => {
    let failFinalize = true;
    const executedSources: string[] = [];
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        executedSources.push(input.sourceCommit);
        return {
          status: "succeeded",
          beforeTip: input.expectedTip,
          afterTip: input.sourceCommit,
          resultingCommit: input.sourceCommit,
          receipt: { applied: input.sourceCommit },
        };
      },
      reconcile: (input) => ({
        status: "succeeded",
        beforeTip: input.expectedTip,
        afterTip: input.sourceCommit,
        resultingCommit: input.sourceCommit,
        receipt: { reconciled: input.sourceCommit },
      }),
    };
    const { database, runtime } = setup(coverage(), {
      gitAdapter: adapter,
      failureInjection: (point) => {
        if (point === "during-operation-finalization" && failFinalize) {
          failFinalize = false;
          throw new Error("finalization transaction interrupted");
        }
      },
    });
    start(database, runtime, "generation-finalize-uow-rollback");

    assert.throws(
      () => runtime.executePending("generation-finalize-uow-rollback"),
      /finalization transaction interrupted/,
    );
    assert.deepEqual(executedSources, [commit("2")]);
    assert.equal(
      database
        .prepare(
          `SELECT state FROM integration_operations
            WHERE generation_id = 'generation-finalize-uow-rollback'`,
        )
        .get()!.state,
      "running",
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM command_deduplication
            WHERE command_id LIKE 'integration-operation:generation-finalize-uow-rollback:%:finalize:%'`,
        )
        .get()!.count,
      0,
    );

    assert.equal(
      runtime.executePending("generation-finalize-uow-rollback").state,
      "validating",
    );
    assert.deepEqual(executedSources, [commit("2"), commit("4")]);
  });

  it("fails the whole generation on partial multi-Repository failure and never continues it", () => {
    const calls: string[] = [];
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        calls.push(input.sourceCommit);
        return input.repositoryReference.endsWith("/web")
          ? {
              status: "conflict",
              writeStatus: "not-started",
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

  it("returns an attributable Integration failure to Work Package rework and admits only fresh reviewed coverage", () => {
    const uiPackage: CompletedCodeReviewCoverage["packages"][number] = {
      workPackageId: "package-ui",
      workPackageVersionId: "package-ui-v1",
      applicationId: "application-ui",
      repositoryReference: "/repositories/ui",
      baseCommit: commit("5"),
      sourceBranch: "sandcastle/run-1/package-ui-v1/attempt-1",
      sourceCommit: commit("6"),
      diffHash: hash("e"),
      authorityId: "authority-ui",
      qualityGateResultId: "gate-ui",
      dependencies: [
        {
          predecessorWorkPackageVersionId: "package-web-v1",
          kind: "commit",
          contractId: null,
          contractVersion: null,
          evidenceRef: null,
        },
      ],
      contractVersions: [],
      integrationConditions: ["npm test"],
    };
    let currentCoverage = coverage({
      packages: [...coverage().packages, uiPackage],
    });
    const versionCalls: unknown[] = [];
    const assignCalls: unknown[] = [];
    const manifest = {
      objective: "Recover Integration",
      acceptanceCriteria: ["Fresh review passes"],
      moduleScope: ["src"],
      allowedPermissions: ["repository:write"],
      specRefs: ["spec-1"],
      harnessRefs: ["harness-1"],
      assignmentCriteria: { positionIds: [] },
      expectedArtifacts: ["diff"],
      selfCheckCommands: ["npm test"],
      codeReviewConditions: ["PASS"],
      integrationConditions: ["npm test"],
      riskTier: "medium" as const,
      recoveryPolicy: "retry",
      execution: {
        profileId: "software-rnd-local-isolated-git" as const,
        branchStrategy: "branch" as const,
        gitRefWriteIsolation: true as const,
        runtimeImportOnly: true as const,
      },
    };
    const { execution: _execution, ...versionManifest } = manifest;
    const workPackageGraph: {
      projectId: string;
      runId: string;
      technicalBaselineId: string;
      packages: Array<{
        id: string;
        revision: number;
        state?: string;
        versions: Array<{
          id: string;
          version: number;
          status: "ready" | "superseded";
          manifest: typeof manifest;
          dependencies: Array<{
            predecessorWorkPackageVersionId: string;
            kind: "contract" | "commit";
            contractId: string | null;
            contractVersion: string | null;
            evidenceRef: string | null;
          }>;
        }>;
      }>;
    } = {
      projectId: "project-1",
      runId: "run-1",
      technicalBaselineId: "baseline-1",
      packages: [
        {
          id: "package-api",
          revision: 4,
          versions: [
            {
              id: "package-api-v1",
              version: 1,
              status: "ready" as const,
              manifest,
              dependencies: [],
            },
          ],
        },
        {
          id: "package-web",
          revision: 6,
          versions: [
            {
              id: "package-web-v1",
              version: 1,
              status: "ready" as const,
              manifest,
              dependencies: [
                {
                  predecessorWorkPackageVersionId: "package-api-v1",
                  kind: "contract",
                  contractId: "contract-api",
                  contractVersion: "1",
                  evidenceRef: null,
                },
              ],
            },
          ],
        },
        {
          id: "package-ui",
          revision: 8,
          versions: [
            {
              id: "package-ui-v1",
              version: 1,
              status: "ready" as const,
              manifest,
              dependencies: [
                {
                  predecessorWorkPackageVersionId: "package-web-v1",
                  kind: "commit",
                  contractId: null,
                  contractVersion: null,
                  evidenceRef: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const adapter: GitIntegrationAdapter = {
      execute: () => ({
        status: "conflict",
        writeStatus: "not-started",
        code: "INTEGRATION_GIT_CONFLICT",
        message: "api conflict",
        evidence: { conflictFiles: ["api.ts"] },
      }),
      reconcile: () => ({ status: "not-applied" }),
    };
    let database!: DatabaseSync;
    let reworkAuditSequence = 0;
    const appendReworkAudit = (
      commandId: string,
      action: string,
      entityId: string,
    ) => {
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, ?, 'work-package', ?, 'run-1', 'integration-node-1',
                     NULL, '{}', ?, ?, ?, ?, ?, 'integration-node-handler')`,
        )
        .run(
          `${commandId}:rework-audit:${++reworkAuditSequence}`,
          action,
          entityId,
          "2026-07-28T00:00:00.000Z",
          commandId,
          runtimeActor.type,
          runtimeActor.id,
          runtimeActor.authenticatedBy,
        );
    };
    const initialized = setup(currentCoverage, {
      gitAdapter: adapter,
      readCoverage: () => currentCoverage,
      workPackages: {
        inspect: () => workPackageGraph as unknown as WorkPackageGraphView,
        versionInTransaction: (input) => {
          versionCalls.push(input);
          appendReworkAudit(
            input.commandId,
            "work-package.version",
            input.workPackageId,
          );
          const workPackage = workPackageGraph.packages.find(
            (entry) => entry.id === input.workPackageId,
          )!;
          const active = workPackage.versions.find(
            (entry) => entry.status === "ready",
          )!;
          active.status = "superseded";
          workPackage.versions.push({
            id: input.versionId,
            version: 2,
            status: "ready",
            manifest: {
              ...manifest,
              ...input.manifest,
              execution: manifest.execution,
            } as typeof manifest,
            dependencies: input.dependencies.map((dependency) => ({
              predecessorWorkPackageVersionId:
                dependency.predecessorWorkPackageVersionId,
              kind: dependency.kind as "contract" | "commit",
              contractId: dependency.contractId ?? null,
              contractVersion: dependency.contractVersion ?? null,
              evidenceRef: dependency.evidenceRef ?? null,
            })),
          });
          workPackage.revision += 1;
          return workPackageGraph as unknown as WorkPackageGraphView;
        },
        assignInTransaction: (input) => {
          assignCalls.push(input);
          appendReworkAudit(
            input.commandId,
            "work-package.assign",
            input.workPackageId,
          );
          const workPackage = workPackageGraph.packages.find(
            (entry) => entry.id === input.workPackageId,
          )!;
          workPackage.revision += 1;
          workPackage.state = "assigned";
          return workPackageGraph as unknown as WorkPackageGraphView;
        },
      },
    });
    database = initialized.database;
    const { runtime, pipelineCalls } = initialized;
    start(database, runtime, "generation-rework");

    const failed = runtime.executePending("generation-rework");

    assert.equal(failed.state, "failed");
    assert.equal(versionCalls.length, 3);
    assert.deepEqual(versionCalls[0], {
      commandId:
        "integration-operation:generation-rework:package-api-v1:finalize",
      actor: runtimeActor,
      expectedRevision: 4,
      workPackageId: "package-api",
      versionId: "integration-rework:generation-rework:package-api:v2",
      dependencies: [],
      manifest: {
        ...versionManifest,
        recoveryPolicy:
          "Integration Generation generation-rework failed: INTEGRATION_GIT_CONFLICT",
      },
    });
    assert.deepEqual(versionCalls[1], {
      commandId:
        "integration-operation:generation-rework:package-api-v1:finalize",
      actor: runtimeActor,
      expectedRevision: 6,
      workPackageId: "package-web",
      versionId: "integration-rework:generation-rework:package-web:v2",
      dependencies: [
        {
          predecessorWorkPackageVersionId:
            "integration-rework:generation-rework:package-api:v2",
          kind: "contract",
          contractId: "contract-api",
          contractVersion: "1",
        },
      ],
      manifest: {
        ...versionManifest,
        recoveryPolicy:
          "Integration Generation generation-rework failed: INTEGRATION_GIT_CONFLICT",
      },
    });
    assert.deepEqual(versionCalls[2], {
      commandId:
        "integration-operation:generation-rework:package-api-v1:finalize",
      actor: runtimeActor,
      expectedRevision: 8,
      workPackageId: "package-ui",
      versionId: "integration-rework:generation-rework:package-ui:v2",
      dependencies: [
        {
          predecessorWorkPackageVersionId:
            "integration-rework:generation-rework:package-web:v2",
          kind: "commit",
        },
      ],
      manifest: {
        ...versionManifest,
        recoveryPolicy:
          "Integration Generation generation-rework failed: INTEGRATION_GIT_CONFLICT",
      },
    });
    assert.deepEqual(assignCalls, [
      {
        commandId:
          "integration-operation:generation-rework:package-api-v1:finalize",
        actor: runtimeActor,
        expectedRevision: 5,
        workPackageId: "package-api",
        baseCommit: commit("1"),
      },
    ]);
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM runtime_audit_records AS audit
             LEFT JOIN command_deduplication AS receipt
               ON receipt.command_id = audit.command_id
            WHERE audit.action IN ('work-package.version', 'work-package.assign')
              AND audit.command_id IS NOT NULL
              AND receipt.command_id IS NULL`,
        )
        .get()!.count,
      0,
    );
    assert.equal(
      pipelineCalls.some(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "kind" in call &&
          call.kind === "fail",
      ),
      false,
    );
    assert.equal(
      pipelineCalls.some(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "kind" in call &&
          call.kind === "requeue",
      ),
      true,
    );

    assert.throws(
      () => start(database, runtime, "generation-rework-stale"),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_REWORK_COVERAGE_STALE",
    );

    currentCoverage = coverage({
      coverageId: "review-attempt-2",
      coverageHash: hash("9"),
      nodeAttemptId: "review-attempt-2",
      packages: [
        {
          ...coverage().packages[0]!,
          workPackageVersionId:
            "integration-rework:generation-rework:package-api:v2",
          sourceBranch: "sandcastle/wp/package-api/attempt-2",
          sourceCommit: commit("9"),
          diffHash: hash("9"),
          authorityId: "authority-api-v2",
          qualityGateResultId: "gate-api-v2",
        },
        {
          ...coverage().packages[1]!,
          workPackageVersionId:
            "integration-rework:generation-rework:package-web:v2",
          sourceBranch: "sandcastle/wp/package-web/attempt-2",
          sourceCommit: commit("8"),
          diffHash: hash("8"),
          authorityId: "authority-web-v2",
          qualityGateResultId: "gate-web-v2",
          dependencies: [
            {
              ...coverage().packages[1]!.dependencies[0]!,
              predecessorWorkPackageVersionId:
                "integration-rework:generation-rework:package-api:v2",
            },
          ],
        },
        {
          ...uiPackage,
          workPackageVersionId:
            "integration-rework:generation-rework:package-ui:v2",
          sourceBranch: "sandcastle/wp/package-ui/attempt-2",
          sourceCommit: commit("7"),
          diffHash: hash("7"),
          authorityId: "authority-ui-v2",
          qualityGateResultId: "gate-ui-v2",
          dependencies: [
            {
              ...uiPackage.dependencies[0]!,
              predecessorWorkPackageVersionId:
                "integration-rework:generation-rework:package-web:v2",
            },
          ],
        },
      ],
    });
    const fresh = start(database, runtime, "generation-rework-fresh");

    assert.equal(fresh.manifest.generation, 2);
    assert.equal(fresh.state, "pending");
    assert.equal(runtime.inspect("run-1")[0]!.state, "failed");
    assert.ok(
      runtime.inspect("run-1")[0]!.defects.every((d) => d.status === "closed"),
    );
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
        writeStatus: "not-started",
        code: "INTEGRATION_GIT_CONFLICT",
        message: "conflict",
        evidence: { conflictFiles: ["api.ts"] },
      }),
      reconcile: () => ({
        status: "conflict",
        writeStatus: "not-started",
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

  it("includes a committed pending Generation in startup reconciliation", () => {
    const { database, runtime } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
    );
    start(database, runtime, "generation-pending-restart");

    assert.deepEqual(
      runtime.inspectPending().map((generation) => generation.id),
      ["generation-pending-restart"],
    );
  });

  it("finalizes a known pre-write Git rejection without leaving an intent hanging", () => {
    const adapter: GitIntegrationAdapter = {
      execute: () => ({
        status: "failed",
        writeStatus: "not-started",
        code: "INTEGRATION_SOURCE_DRIFT",
        message: "source branch drifted",
        evidence: { preWriteProven: true },
      }),
      reconcile: () => ({ status: "not-applied" }),
    };
    const { database, runtime } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      { gitAdapter: adapter },
    );
    start(database, runtime, "generation-source-drift");

    const failed = runtime.executePending("generation-source-drift");

    assert.equal(failed.state, "failed");
    assert.equal(failed.operations[0]?.state, "failed");
    assert.equal(
      failed.operations[0]?.failure?.code,
      "INTEGRATION_SOURCE_DRIFT",
    );
    assert.equal(failed.defects.length, 1);
  });

  it("reconciles a previously unknown Git outcome when the exact result later becomes provable", () => {
    let executeCount = 0;
    let reconcileCount = 0;
    let provable = false;
    const adapter: GitIntegrationAdapter = {
      execute: (input) => {
        executeCount += 1;
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "provider receipt unavailable",
          evidence: { queryable: false },
        };
      },
      reconcile: (input) => {
        reconcileCount += 1;
        return provable
          ? {
              status: "succeeded",
              beforeTip: input.expectedTip,
              afterTip: input.sourceCommit,
              resultingCommit: input.sourceCommit,
              receipt: { reconciled: true },
            }
          : {
              status: "unknown",
              code: "RECONCILE_UNKNOWN",
              message: "provider receipt unavailable",
              evidence: { queryable: false },
            };
      },
    };
    const { database, runtime } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      { gitAdapter: adapter },
    );
    start(database, runtime, "generation-unknown");
    const blocked = runtime.executePending("generation-unknown");
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.operations[0]?.state, "unknown");
    assert.deepEqual(
      database
        .prepare(
          `SELECT command_id AS commandId FROM command_deduplication
            WHERE command_id LIKE 'integration-operation:generation-unknown:%'
            ORDER BY command_id`,
        )
        .all()
        .map((entry) => String(entry.commandId)),
      [
        "integration-operation:generation-unknown:package-api-v1:intent",
        "integration-operation:generation-unknown:package-api-v1:unknown",
      ],
    );
    assert.equal(runtime.reconcilePending(), 1);
    assert.equal(runtime.inspect("run-1")[0]?.state, "blocked");
    provable = true;
    assert.equal(runtime.reconcilePending(), 1);
    const recovered = runtime.inspect("run-1")[0]!;
    assert.equal(recovered.state, "validating");
    assert.equal(recovered.operations[0]?.state, "succeeded");
    assert.equal(
      recovered.defects.filter((defect) => defect.status === "open").length,
      0,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT command_id AS commandId FROM command_deduplication
            WHERE command_id LIKE 'integration-operation:generation-unknown:%'
            ORDER BY command_id`,
        )
        .all()
        .map((entry) => String(entry.commandId)),
      [
        "integration-operation:generation-unknown:package-api-v1:finalize",
        "integration-operation:generation-unknown:package-api-v1:intent",
        "integration-operation:generation-unknown:package-api-v1:unknown",
      ],
    );
    assert.equal(executeCount, 1);
    assert.equal(reconcileCount, 2);
    assert.equal(
      runtime.executePending("generation-unknown").state,
      "validating",
    );
    assert.equal(reconcileCount, 2);
  });

  it("rejects changed unknown reconciliation evidence under the stable receipt identity", () => {
    let reconciliation = 0;
    const adapter: GitIntegrationAdapter = {
      execute: () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "provider receipt unavailable",
        evidence: { attempt: 1 },
      }),
      reconcile: () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "provider receipt unavailable",
        evidence: { attempt: ++reconciliation + 1 },
      }),
    };
    const { database, runtime } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      { gitAdapter: adapter },
    );
    start(database, runtime, "generation-unknown-conflict");
    assert.equal(
      runtime.executePending("generation-unknown-conflict").state,
      "blocked",
    );

    assert.throws(
      () => runtime.reconcilePending(),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONFLICT",
    );
    assert.equal(runtime.inspect("run-1")[0]?.operations[0]?.state, "unknown");
  });

  it("persists replayable blockPending state with Integration and Pipeline audit effects", () => {
    const { database, runtime, eventCalls } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      { recordPipelineAudit: true },
    );
    start(database, runtime, "generation-block-pending");
    const failure = {
      code: "INTEGRATION_PROVIDER_UNKNOWN",
      message: "provider state cannot be proven",
      evidence: { providerReceipt: null },
    };

    assert.equal(
      runtime.blockPending("generation-block-pending", failure).state,
      "blocked",
    );
    assert.equal(
      runtime.blockPending("generation-block-pending", failure).state,
      "blocked",
    );
    const commandId =
      "integration-generation:generation-block-pending:block-pending";
    const receipt = database
      .prepare(
        `SELECT effect_ids_json AS effectIdsJson FROM command_deduplication
          WHERE command_id = ?`,
      )
      .get(commandId) as { readonly effectIdsJson: string };
    assert.equal(
      (JSON.parse(receipt.effectIdsJson) as readonly string[]).length,
      2,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT action FROM runtime_audit_records
            WHERE command_id = ? ORDER BY action`,
        )
        .all(commandId)
        .map((entry) => String(entry.action)),
      ["integration.generation-blocked", "run.integration-blocked"],
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM runtime_unit_of_work_context")
        .get()!.count,
      0,
    );
    assert.equal(
      eventCalls.filter(
        (event) => event.type === "integration.generation.blocked",
      ).length,
      1,
    );
    database
      .prepare(
        "UPDATE command_deduplication SET effect_ids_json = '[\"forged\"]' WHERE command_id = ?",
      )
      .run(commandId);
    assert.throws(
      () => runtime.blockPending("generation-block-pending", failure),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONFLICT",
    );
    assert.throws(
      () =>
        runtime.blockPending("generation-block-pending", {
          ...failure,
          evidence: { providerReceipt: "changed" },
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_CONFLICT",
    );
  });

  it("rejects blockPending for terminal Generations without writing evidence", () => {
    for (const state of ["passed", "failed"] as const) {
      const { database, runtime, eventCalls } = setup(
        coverage({ packages: [coverage().packages[0]!] }),
        { recordPipelineAudit: true },
      );
      const generationId = `generation-block-terminal-${state}`;
      start(database, runtime, generationId);
      database
        .prepare("UPDATE integration_generations SET state = ? WHERE id = ?")
        .run(state, generationId);
      const before = {
        defects: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM integration_defects")
            .get()!.count,
        ),
        audits: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
            .get()!.count,
        ),
        receipts: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
            .get()!.count,
        ),
        events: eventCalls.length,
      };

      assert.throws(
        () =>
          runtime.blockPending(generationId, {
            code: "INTEGRATION_PROVIDER_UNKNOWN",
            message: "provider state cannot be proven",
            evidence: { state },
          }),
        (error: unknown) =>
          error instanceof IntegrationRuntimeError &&
          error.code === "INTEGRATION_GENERATION_TERMINAL",
      );
      assert.deepEqual(
        {
          defects: Number(
            database
              .prepare("SELECT COUNT(*) AS count FROM integration_defects")
              .get()!.count,
          ),
          audits: Number(
            database
              .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
              .get()!.count,
          ),
          receipts: Number(
            database
              .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
              .get()!.count,
          ),
          events: eventCalls.length,
        },
        before,
      );
      assert.equal(runtime.inspect("run-1")[0]?.state, state);
    }
  });

  it("rolls back blockPending when the Generation transition affects no row", () => {
    const { database, runtime, eventCalls } = setup(
      coverage({ packages: [coverage().packages[0]!] }),
      { recordPipelineAudit: true },
    );
    start(database, runtime, "generation-block-ignored");
    database.exec(`
      CREATE TRIGGER ignore_generation_block
      BEFORE UPDATE ON integration_generations
      WHEN OLD.id = 'generation-block-ignored'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);
    const before = {
      defects: Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM integration_defects")
          .get()!.count,
      ),
      audits: Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
          .get()!.count,
      ),
      receipts: Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
          .get()!.count,
      ),
      events: eventCalls.length,
    };

    assert.throws(
      () =>
        runtime.blockPending("generation-block-ignored", {
          code: "INTEGRATION_PROVIDER_UNKNOWN",
          message: "provider state cannot be proven",
          evidence: {},
        }),
      (error: unknown) =>
        error instanceof IntegrationRuntimeError &&
        error.code === "INTEGRATION_GENERATION_TERMINAL",
    );
    assert.deepEqual(
      {
        defects: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM integration_defects")
            .get()!.count,
        ),
        audits: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
            .get()!.count,
        ),
        receipts: Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
            .get()!.count,
        ),
        events: eventCalls.length,
      },
      before,
    );
    assert.equal(runtime.inspect("run-1")[0]?.state, "pending");
  });

  it("persists blockStart context, audits, event, and receipt atomically", () => {
    const { database, runtime, eventCalls } = setup(coverage(), {
      recordPipelineAudit: true,
    });
    database
      .prepare(
        `INSERT INTO department_runs(
           id, project_id, department_id, status, created_at
         ) VALUES ('run-block-start', 'project-1', 'department-1', 'ready', ?)`,
      )
      .run("2026-07-28T00:00:00.000Z");
    const input = {
      generationId: "generation-block-start",
      runId: "run-block-start",
      nodeRunId: "integration-node-block-start",
      failure: {
        code: "INTEGRATION_COVERAGE_STALE",
        message: "coverage changed before generation start",
        evidence: { coverageId: "coverage-stale" },
      },
    };

    runtime.blockStart(input);
    runtime.blockStart(input);

    const commandId =
      "integration-generation:generation-block-start:block-start";
    const receipt = database
      .prepare(
        `SELECT effect_ids_json AS effectIdsJson FROM command_deduplication
          WHERE command_id = ?`,
      )
      .get(commandId) as { readonly effectIdsJson: string };
    assert.equal(
      (JSON.parse(receipt.effectIdsJson) as readonly string[]).length,
      2,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT action FROM runtime_audit_records
            WHERE command_id = ? ORDER BY action`,
        )
        .all(commandId)
        .map((entry) => String(entry.action)),
      ["integration.generation-blocked", "run.integration-blocked"],
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM runtime_unit_of_work_context")
        .get()!.count,
      0,
    );
    assert.equal(
      eventCalls.filter(
        (event) => event.type === "integration.generation.blocked",
      ).length,
      1,
    );
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
