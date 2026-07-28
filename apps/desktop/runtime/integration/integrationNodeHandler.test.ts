import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompanyCommandRegistry } from "../commandRegistry.js";
import { openIntegrationNodeHandler } from "./integrationNodeHandler.js";
import type {
  IntegrationGenerationView,
  IntegrationRuntime,
} from "./integrationRuntime.js";

const validation = {
  id: `validation:${"a".repeat(64)}`,
  repositoryReference: "/repositories/api",
  kind: "build-test" as const,
  identityHash: "a".repeat(64),
  condition: "npm test",
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
      runId: "run-1",
      nodeRunId: "integration-node-1",
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
    assert.deepEqual(aggregateInputs, [
      {
        operationKey: "integration:run-1:g1:aggregate-review",
        generationId: "integration:run-1:g1",
        manifestHash: "b".repeat(64),
        topicId: "integration-review:integration:run-1:g1",
        repositoryCommits: [
          { repositoryId: "/repositories/api", commit: "1".repeat(40) },
        ],
        acceptanceCriteria: ["npm test"],
      },
    ]);
    assert.deepEqual(
      commands.map((entry) => entry.command.type),
      ["integration.validation.record", "integration.aggregate-review.record"],
    );
    assert.equal(view.state, "passed");
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
});
