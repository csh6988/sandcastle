import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompanyCommandRegistry } from "../commandRegistry.js";
import { openIntegrationNodeHandler } from "./integrationNodeHandler.js";
import type {
  AggregateIntegrationReviewExecutor,
  IntegrationValidationExecutor,
} from "./integrationNodeHandler.js";
import type {
  IntegrationGenerationView,
  IntegrationRuntime,
} from "./integrationRuntime.js";
import { IntegrationRuntimeError } from "./integrationRuntime.js";

const validation = {
  id: `validation:${"a".repeat(64)}`,
  repositoryReference: "/repositories/api",
  kind: "build-test" as const,
  identityHash: "a".repeat(64),
  condition: "npm test",
  commands: [["npm", "test"]],
  evidenceRefs: [],
  responsibleWorkPackageVersionIds: ["package-v1"],
};

const unusedValidationExecutor: IntegrationValidationExecutor = {
  reconcile: async () => ({ status: "not-applied" }),
  execute: async () => {
    throw new Error("validation executor must not run");
  },
};

const unusedAggregateReviewExecutor: AggregateIntegrationReviewExecutor = {
  reconcile: async () => ({ status: "not-applied" }),
  execute: async () => {
    throw new Error("aggregate Review executor must not run");
  },
};

const generation = (
  state: IntegrationGenerationView["state"],
  validationRecorded = false,
) =>
  ({
    id: "integration:run-1:g1",
    state,
    manifestHash: "b".repeat(64),
    manifest: {
      schemaVersion: 1,
      generationId: "integration:run-1:g1",
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node-1",
      packages: [
        {
          workPackageVersionId: "package-v1",
          repositoryReference: "/repositories/api",
          reviewContext: {
            codeReviewManifestId: "code-review-1",
            codeReviewManifestHash: "c".repeat(64),
            diffArtifactVersionId: "diff-1",
            specRevisionIds: ["spec-1"],
            harnessSnapshotIds: ["harness-1"],
            acceptanceCriteria: ["The accepted API behavior remains valid."],
            selfCheckEvidenceRefs: ["self-check-1"],
          },
        },
      ],
      integrationConditions: ["npm test"],
      requiredValidations: [validation],
    },
    repositoryResults: [
      {
        repositoryReference: "/repositories/api",
        integratedCommit: "1".repeat(40),
        validationRecords: validationRecorded
          ? [{ validationId: validation.id }]
          : [],
      },
    ],
  }) as unknown as IntegrationGenerationView;

describe("Integration Node Handler", () => {
  it("runs validation and aggregate independent review to Pipeline-owned completion", async () => {
    let view = generation("validating");
    const commands: Array<{ readonly command: { readonly type: string } }> = [];
    const validationInputs: unknown[] = [];
    const aggregateInputs: unknown[] = [];
    const integrations = {
      inspect: () => [view],
      inspectPending: () => [view],
      executePending: () => view,
      reconcilePending: () => 0,
      blockPending: () => {
        throw new Error("must not block");
      },
    } as unknown as IntegrationRuntime;
    const commandRegistry = {
      execute: (envelope: { readonly command: { readonly type: string } }) => {
        commands.push(envelope);
        if (envelope.command.type === "integration.validation.record") {
          view = generation("aggregate-review", true);
        } else if (
          envelope.command.type === "integration.aggregate-review.record"
        ) {
          view = generation("passed", true);
        }
        return { status: "succeeded", value: view, effectIds: [] };
      },
    } as unknown as CompanyCommandRegistry;
    const handler = openIntegrationNodeHandler({
      commandRegistry,
      integrations,
      validationExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async (input) => {
          validationInputs.push(input);
          return {
            status: "passed",
            evidenceRefs: ["build-log"],
            responsibleWorkPackageVersionIds: [],
          };
        },
      },
      aggregateReviewExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async (input) => {
          aggregateInputs.push(input);
          return {
            status: "completed",
            topicId: "integration-review:integration:run-1:g1",
            qualityGateResultId: "aggregate-gate-1",
          };
        },
      },
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(validationInputs.length, 1);
    assert.deepEqual(validationInputs, [
      {
        operationKey:
          "integration:run-1:g1:validation:validation:" + "a".repeat(64),
        generationId: "integration:run-1:g1",
        manifestHash: "b".repeat(64),
        repositoryReference: "/repositories/api",
        integratedCommit: "1".repeat(40),
        responsibleWorkPackageVersionIds: ["package-v1"],
        validation,
      },
    ]);
    assert.deepEqual(aggregateInputs, [
      {
        operationKey: "integration:run-1:g1:aggregate-review",
        generationId: "integration:run-1:g1",
        manifestHash: "b".repeat(64),
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: "integration-node-1",
        topicId: "integration-review:integration:run-1:g1",
        repositoryCommits: [
          { repositoryId: "/repositories/api", commit: "1".repeat(40) },
        ],
        acceptanceCriteria: ["The accepted API behavior remains valid."],
        generationManifest: generation("aggregate-review", true).manifest,
      },
    ]);
    assert.deepEqual(
      commands.map((entry) => entry.command.type),
      ["integration.validation.record", "integration.aggregate-review.record"],
    );
    assert.equal(view.state, "passed");
  });

  it("does not start validation while the Run is paused and continues after resume", async () => {
    let paused = true;
    let view = generation("validating");
    let validationExecutions = 0;
    const stageClaims: boolean[] = [];
    const handler = openIntegrationNodeHandler({
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        isRunPaused: () => paused,
        claimExecutionStage: (input: { readonly createIfMissing: boolean }) => {
          stageClaims.push(input.createIfMissing);
          return input.createIfMissing
            ? ({ mode: "execute" } as const)
            : ({ mode: "missing" } as const);
        },
        recordExecutionStageResult: () => undefined,
        blockPending: () => {
          throw new Error("must not block");
        },
      } as unknown as IntegrationRuntime,
      commandRegistry: {
        execute: () => {
          view = generation("passed", true);
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      validationExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async () => {
          validationExecutions += 1;
          return {
            status: "passed",
            evidenceRefs: ["validation-terminal"],
            responsibleWorkPackageVersionIds: ["package-v1"],
          };
        },
      },
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });
    assert.equal(validationExecutions, 0);
    assert.deepEqual(stageClaims, [false]);

    paused = false;
    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });
    assert.equal(validationExecutions, 1);
    assert.deepEqual(stageClaims, [false, true]);
  });

  it("uses frozen producer and consumer responsibility for Contract failure", async () => {
    const contractValidation = {
      id: `validation:${"c".repeat(64)}`,
      repositoryReference: "/repositories/web",
      kind: "contract" as const,
      identityHash: "c".repeat(64),
      commands: [["npm", "run", "test:contract"]],
      evidenceRefs: ["contract-fixture"],
      responsibleWorkPackageVersionIds: ["package-api-v1", "package-web-v1"],
      contract: {
        id: "contract-api",
        version: "1",
        hash: "d".repeat(64),
        producerApplicationId: "application-api",
        consumerApplicationId: "application-web",
      },
    };
    let view = {
      ...generation("validating"),
      manifest: {
        ...generation("validating").manifest,
        packages: [
          {
            workPackageVersionId: "package-api-v1",
            repositoryReference: "/repositories/api",
          },
          {
            workPackageVersionId: "package-web-v1",
            repositoryReference: "/repositories/web",
          },
          {
            workPackageVersionId: "package-web-unrelated-v1",
            repositoryReference: "/repositories/web",
          },
        ],
        requiredValidations: [contractValidation],
      },
      repositoryResults: [
        {
          repositoryReference: "/repositories/web",
          integratedCommit: "2".repeat(40),
          validationRecords: [],
        },
      ],
    } as unknown as IntegrationGenerationView;
    const validationInputs: Array<{
      readonly responsibleWorkPackageVersionIds: readonly string[];
    }> = [];
    const commands: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        blockPending: () => {
          throw new Error("must not block");
        },
      } as unknown as IntegrationRuntime,
      commandRegistry: {
        execute: (envelope: {
          readonly command: {
            readonly responsibleWorkPackageVersionIds: readonly string[];
          };
        }) => {
          commands.push(envelope.command);
          view = { ...view, state: "failed" };
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      validationExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async (input) => {
          validationInputs.push(input);
          return {
            status: "failed",
            evidenceRefs: ["contract-fixture", "runtime-evidence"],
            responsibleWorkPackageVersionIds: [
              ...input.responsibleWorkPackageVersionIds,
            ],
            contractFailure: {
              producerApplicationId: "application-api",
              consumerApplicationId: "application-web",
              contractId: "contract-api",
              contractVersion: "1",
              fixtureRef: "contract-fixture",
              runtimeEvidenceRef: "runtime-evidence",
            },
          };
        },
      },
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.deepEqual(validationInputs[0]?.responsibleWorkPackageVersionIds, [
      "package-api-v1",
      "package-web-v1",
    ]);
    assert.deepEqual(
      (
        commands[0] as {
          readonly responsibleWorkPackageVersionIds: readonly string[];
        }
      ).responsibleWorkPackageVersionIds,
      ["package-api-v1", "package-web-v1"],
    );
  });

  it("blocks through the Integration Runtime when executor reconciliation is unknown", async () => {
    const view = generation("validating");
    const blocked: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: { execute: () => ({ status: "succeeded" }) } as never,
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        blockPending: (_id: string, failure: unknown) => {
          blocked.push(failure);
          return view;
        },
      } as unknown as IntegrationRuntime,
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
      validationExecutor: {
        reconcile: async () => ({
          status: "unknown",
          code: "VALIDATION_UNKNOWN",
          message: "validation outcome unknown",
          evidence: { operation: "validation" },
        }),
        execute: async () => {
          throw new Error("must not resend");
        },
      },
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });
    assert.deepEqual(blocked, [
      {
        code: "VALIDATION_UNKNOWN",
        message: "validation outcome unknown",
        evidence: { operation: "validation" },
      },
    ]);
  });

  it("reconciles a durable blocked validation stage without repeating execution", async () => {
    let view = generation("blocked");
    let reconcileCount = 0;
    let executeCount = 0;
    const stageResults: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: () => {
          view = generation("passed", true);
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        claimExecutionStage: () => ({ mode: "reconcile" }),
        recordExecutionStageResult: (input: unknown) =>
          stageResults.push(input),
        blockPending: () => {
          throw new Error("terminal reconciliation must not block");
        },
      } as unknown as IntegrationRuntime,
      validationExecutor: {
        reconcile: async () => {
          reconcileCount += 1;
          return {
            status: "passed",
            evidenceRefs: ["provider-terminal"],
            responsibleWorkPackageVersionIds: [],
          };
        },
        execute: async () => {
          executeCount += 1;
          throw new Error("must not reissue validation");
        },
      },
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.reconcilePending();

    assert.equal(reconcileCount, 1);
    assert.equal(executeCount, 0);
    assert.equal(stageResults.length, 1);
    assert.equal(
      (stageResults[0] as { readonly state: string }).state,
      "succeeded",
    );
  });

  it("reconciles a durable blocked aggregate stage without repeating Reviewer execution", async () => {
    let view = generation("blocked", true);
    let reconcileCount = 0;
    let executeCount = 0;
    const stageResults: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: () => {
          view = generation("passed", true);
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        claimExecutionStage: () => ({ mode: "reconcile" }),
        recordExecutionStageResult: (input: unknown) =>
          stageResults.push(input),
        blockPending: () => {
          throw new Error("terminal reconciliation must not block");
        },
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: {
        reconcile: async () => {
          reconcileCount += 1;
          return {
            status: "completed",
            topicId: "integration-review:integration:run-1:g1",
            qualityGateResultId: "aggregate-gate-1",
          };
        },
        execute: async () => {
          executeCount += 1;
          throw new Error("must not repeat aggregate Reviewer execution");
        },
      },
    });

    await handler.reconcilePending();

    assert.equal(reconcileCount, 1);
    assert.equal(executeCount, 0);
    assert.equal(stageResults.length, 1);
    assert.equal(
      (stageResults[0] as { readonly state: string }).state,
      "succeeded",
    );
  });

  it("defers a reconciled aggregate PASS until the paused Run resumes", async () => {
    let paused = true;
    let view = generation("aggregate-review", true);
    let stageTerminal = false;
    let reconcileCount = 0;
    let executeCount = 0;
    const stageClaims: boolean[] = [];
    const stageResults: unknown[] = [];
    const commands: Array<{ readonly commandId: string }> = [];
    const terminalResult = {
      status: "completed" as const,
      topicId: "integration-review:integration:run-1:g1",
      qualityGateResultId: "aggregate-gate-1",
    };
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: (envelope: { readonly commandId: string }) => {
          commands.push(envelope);
          view = generation("passed", true);
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => view,
        reconcilePending: () => 0,
        isRunPaused: () => paused,
        claimExecutionStage: (input: { readonly createIfMissing: boolean }) => {
          stageClaims.push(input.createIfMissing);
          return stageTerminal
            ? ({ mode: "terminal", result: terminalResult } as const)
            : ({ mode: "reconcile" } as const);
        },
        recordExecutionStageResult: (input: unknown) => {
          stageResults.push(input);
          stageTerminal = true;
        },
        blockPending: () => {
          throw new Error("terminal reconciliation must not block");
        },
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: {
        reconcile: async () => {
          reconcileCount += 1;
          return terminalResult;
        },
        execute: async () => {
          executeCount += 1;
          throw new Error("must not repeat aggregate Reviewer execution");
        },
      },
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(view.state, "aggregate-review");
    assert.equal(reconcileCount, 1);
    assert.equal(executeCount, 0);
    assert.deepEqual(stageClaims, [false]);
    assert.equal(stageResults.length, 1);
    assert.equal(
      (stageResults[0] as { readonly state: string }).state,
      "succeeded",
    );
    assert.equal(commands.length, 0);

    paused = false;
    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(reconcileCount, 1);
    assert.equal(executeCount, 0);
    assert.deepEqual(stageClaims, [false, true]);
    assert.equal(stageResults.length, 1);
    assert.deepEqual(
      commands.map((entry) => entry.commandId),
      ["integration:run-1:g1:aggregate-review:completed"],
    );
    assert.equal(view.state, "passed");
  });

  it("dispatches cancellation to the durable validation provider operation", async () => {
    const view = generation("validating");
    const request = {
      operationKey: `${view.id}:validation:${validation.id}`,
      generationId: view.id,
      manifestHash: view.manifestHash,
      repositoryReference: "/repositories/api",
      integratedCommit: "1".repeat(40),
      responsibleWorkPackageVersionIds: ["package-v1"],
      validation,
    };
    const cancellations: unknown[] = [];
    const stageResults: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: {} as CompanyCommandRegistry,
      integrations: {
        inspect: () => [view],
        inspectExecutionStageRequests: () => [
          {
            operationKey: request.operationKey,
            phase: "validation",
            request,
            state: "running",
          },
        ],
        recordExecutionStageResult: (input: unknown) =>
          stageResults.push(input),
      } as unknown as IntegrationRuntime,
      validationExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async () => ({ status: "not-applied" }),
        cancel: async (input) => {
          cancellations.push(input);
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message: "cancellation requires reconciliation",
            evidence: { cancellation: "cancelled" },
          };
        },
      },
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.cancelPending({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.deepEqual(cancellations, [request]);
    assert.equal(stageResults.length, 1);
    assert.equal(
      (stageResults[0] as { readonly state: string }).state,
      "unknown",
    );
  });

  for (const phase of ["validation", "aggregate-review"] as const) {
    it(`blocks with evidence when the ${phase} Command is deterministically rejected`, async () => {
      const view = generation(
        phase === "validation" ? "validating" : "aggregate-review",
        phase === "aggregate-review",
      );
      const blocked: unknown[] = [];
      const handler = openIntegrationNodeHandler({
        commandRegistry: {
          execute: () => ({
            status: "rejected",
            error: { code: "COMMAND_REJECTED", message: `${phase} rejected` },
            effectIds: [],
          }),
        } as unknown as CompanyCommandRegistry,
        integrations: {
          inspect: () => [view],
          inspectPending: () => [view],
          executePending: () => view,
          reconcilePending: () => 0,
          blockPending: (_id: string, failure: unknown) => {
            blocked.push(failure);
            return view;
          },
        } as unknown as IntegrationRuntime,
        validationExecutor: {
          reconcile: async () => ({ status: "not-applied" }),
          execute: async () => ({
            status: "passed",
            evidenceRefs: ["evidence"],
            responsibleWorkPackageVersionIds: [],
          }),
        },
        aggregateReviewExecutor: {
          reconcile: async () => ({ status: "not-applied" }),
          execute: async () => ({
            status: "completed",
            topicId: "integration-review:integration:run-1:g1",
            qualityGateResultId: "gate-1",
          }),
        },
      });
      await handler.executeReady({
        runId: "run-1",
        nodeRunId: "integration-node-1",
      });
      assert.equal(blocked.length, 1);
      const failure = blocked[0] as {
        readonly code: string;
        readonly message: string;
        readonly evidence: {
          readonly phase: string;
          readonly commandId: string;
        };
      };
      assert.equal(failure.code, "COMMAND_REJECTED");
      assert.equal(failure.message, `${phase} rejected`);
      assert.equal(failure.evidence.phase, phase);
      assert.match(failure.evidence.commandId, /integration:run-1:g1/);
    });
  }

  it("durably blocks a deterministic generation start rejection with consumer evidence", async () => {
    const blocked: unknown[] = [];
    const envelopes: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: (envelope: unknown) => {
          envelopes.push(envelope);
          return {
            status: "rejected",
            error: {
              code: "INTEGRATION_COVERAGE_INCOMPLETE",
              message: "coverage is incomplete",
            },
            effectIds: [],
          };
        },
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => [],
        inspectPending: () => [],
        executePending: () => {
          throw new Error("must not execute");
        },
        reconcilePending: () => 0,
        blockPending: () => {
          throw new Error("no Generation was created");
        },
        blockStart: (input: unknown) => blocked.push(input),
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0], {
      generationId: "integration:run-1:g1",
      runId: "run-1",
      nodeRunId: "integration-node-1",
      failure: {
        code: "INTEGRATION_COVERAGE_INCOMPLETE",
        message: "coverage is incomplete",
        evidence: {
          phase: "start",
          commandId: "integration:run-1:integration-node-1:g1:start",
        },
      },
    });
    assert.equal(
      (envelopes[0] as { readonly consumerId?: string }).consumerId,
      "integration-node-handler",
    );
  });

  it("uses a fresh Generation identity after a durable start block", async () => {
    let nextGeneration = 1;
    let view: IntegrationGenerationView | undefined;
    const commands: string[] = [];
    const blocked: string[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: (envelope: {
          readonly commandId: string;
          readonly command: { readonly generationId?: string };
        }) => {
          commands.push(envelope.commandId);
          if (envelope.command.generationId?.endsWith(":g1")) {
            nextGeneration = 2;
            return {
              status: "rejected",
              error: {
                code: "INTEGRATION_COVERAGE_STALE",
                message: "old Snapshot coverage is stale",
              },
              effectIds: [],
            };
          }
          view = generation("passed") as IntegrationGenerationView;
          Object.assign(view, {
            id: "integration:run-1:g2",
            manifest: {
              ...view.manifest,
              runId: "run-1",
              nodeRunId: "integration-node-1",
            },
          });
          return { status: "succeeded", value: view, effectIds: [] };
        },
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => (view ? [view] : []),
        nextGenerationNumber: () => nextGeneration,
        inspectPending: () => [],
        executePending: () => view!,
        reconcilePending: () => 0,
        blockStart: (input: { readonly generationId: string }) =>
          blocked.push(input.generationId),
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });
    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.deepEqual(blocked, ["integration:run-1:g1"]);
    assert.deepEqual(commands, [
      "integration:run-1:integration-node-1:g1:start",
      "integration:run-1:integration-node-1:g2:start",
    ]);
  });

  it("leaves a STORE_BUSY generation start retryable without blocking", async () => {
    let blocked = false;
    const handler = openIntegrationNodeHandler({
      commandRegistry: {
        execute: () => ({
          status: "rejected",
          error: { code: "STORE_BUSY", message: "retry later" },
          effectIds: [],
        }),
      } as unknown as CompanyCommandRegistry,
      integrations: {
        inspect: () => [],
        inspectPending: () => [],
        executePending: () => {
          throw new Error("must not execute");
        },
        reconcilePending: () => 0,
        blockPending: () => {
          throw new Error("must not block");
        },
        blockStart: () => {
          blocked = true;
        },
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.equal(blocked, false);
  });

  it("converts deterministic execution errors into durable blocked evidence", async () => {
    const view = generation("pending");
    const blocked: unknown[] = [];
    const handler = openIntegrationNodeHandler({
      commandRegistry: { execute: () => ({ status: "succeeded" }) } as never,
      integrations: {
        inspect: () => [view],
        inspectPending: () => [view],
        executePending: () => {
          throw new IntegrationRuntimeError(
            "INTEGRATION_COVERAGE_STALE",
            "coverage changed before the Git effect",
          );
        },
        reconcilePending: () => 0,
        blockPending: (_generationId: string, failure: unknown) => {
          blocked.push(failure);
          return generation("blocked");
        },
      } as unknown as IntegrationRuntime,
      validationExecutor: unusedValidationExecutor,
      aggregateReviewExecutor: unusedAggregateReviewExecutor,
    });

    await handler.executeReady({
      runId: "run-1",
      nodeRunId: "integration-node-1",
    });

    assert.deepEqual(blocked, [
      {
        code: "INTEGRATION_COVERAGE_STALE",
        message: "coverage changed before the Git effect",
        evidence: {
          phase: "execution",
          generationId: "integration:run-1:g1",
        },
      },
    ]);
  });
});
