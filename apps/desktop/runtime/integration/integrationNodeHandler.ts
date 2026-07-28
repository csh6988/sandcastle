import {
  CompanyCommandError,
  type CompanyCommandRegistry,
} from "../commandRegistry.js";
import type { ActorRef } from "../interface.js";
import type {
  IntegrationGenerationManifest,
  IntegrationRuntime,
} from "./integrationRuntime.js";

type ValidationInput = {
  readonly operationKey: string;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly repositoryReference: string;
  readonly integratedCommit: string;
  readonly validation: IntegrationGenerationManifest["requiredValidations"][number];
};

type ValidationResult =
  | { readonly status: "not-applied" }
  | {
      readonly status: "passed" | "failed";
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
      readonly status: "unknown";
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    };

export interface IntegrationValidationExecutor {
  readonly execute: (input: ValidationInput) => Promise<ValidationResult>;
  readonly reconcile: (input: ValidationInput) => Promise<ValidationResult>;
}

type AggregateReviewInput = {
  readonly operationKey: string;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly topicId: string;
  readonly repositoryCommits: readonly {
    readonly repositoryId: string;
    readonly commit: string;
  }[];
  readonly acceptanceCriteria: readonly string[];
};

type AggregateReviewResult =
  | { readonly status: "not-applied" }
  | {
      readonly status: "completed";
      readonly topicId: string;
      readonly qualityGateResultId: string;
    }
  | {
      readonly status: "unknown";
      readonly code: string;
      readonly message: string;
      readonly evidence: unknown;
    };

export interface AggregateIntegrationReviewExecutor {
  readonly execute: (
    input: AggregateReviewInput,
  ) => Promise<AggregateReviewResult>;
  readonly reconcile: (
    input: AggregateReviewInput,
  ) => Promise<AggregateReviewResult>;
}

export interface IntegrationNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly reconcilePending: () => Promise<number>;
}

const actor: ActorRef = {
  type: "runtime-worker",
  id: "integration-node-handler",
  authenticatedBy: "runtime",
};

const unavailableValidationExecutor: IntegrationValidationExecutor = {
  execute: async () => ({
    status: "unknown",
    code: "INTEGRATION_VALIDATION_EXECUTOR_UNAVAILABLE",
    message:
      "The Runtime-owned Integration validation executor is unavailable.",
    evidence: { configured: false },
  }),
  reconcile: async () => ({ status: "not-applied" }),
};

const unavailableAggregateReviewExecutor: AggregateIntegrationReviewExecutor = {
  execute: async () => ({
    status: "unknown",
    code: "INTEGRATION_AGGREGATE_REVIEW_EXECUTOR_UNAVAILABLE",
    message:
      "The Runtime-owned aggregate independent Review executor is unavailable.",
    evidence: { configured: false },
  }),
  reconcile: async () => ({ status: "not-applied" }),
};

export const openIntegrationNodeHandler = (options: {
  readonly commandRegistry: CompanyCommandRegistry;
  readonly integrations: IntegrationRuntime;
  readonly validationExecutor?: IntegrationValidationExecutor;
  readonly aggregateReviewExecutor?: AggregateIntegrationReviewExecutor;
}): IntegrationNodeHandler => {
  const validationExecutor =
    options.validationExecutor ?? unavailableValidationExecutor;
  const aggregateReviewExecutor =
    options.aggregateReviewExecutor ?? unavailableAggregateReviewExecutor;

  const executeCommand = (input: {
    readonly generationId: string;
    readonly phase: "validation" | "aggregate-review";
    readonly commandId: string;
    readonly command: Parameters<
      CompanyCommandRegistry["execute"]
    >[0]["command"];
  }): boolean => {
    try {
      const result = options.commandRegistry.execute({
        schemaVersion: 1,
        commandId: input.commandId,
        actor,
        consumerId: "integration-node-handler",
        command: input.command,
      });
      if (result.status === "succeeded") return true;
      if (result.error.code === "STORE_BUSY") return false;
      options.integrations.blockPending(input.generationId, {
        code: result.error.code,
        message: result.error.message,
        evidence: { phase: input.phase, commandId: input.commandId },
      });
      return false;
    } catch (error) {
      if (error instanceof CompanyCommandError && error.code === "STORE_BUSY") {
        return false;
      }
      const failure =
        error instanceof Error
          ? { code: "INTEGRATION_COMMAND_FAILED", message: error.message }
          : {
              code: "INTEGRATION_COMMAND_FAILED",
              message: "Integration Command execution failed.",
            };
      options.integrations.blockPending(input.generationId, {
        ...failure,
        evidence: { phase: input.phase, commandId: input.commandId },
      });
      return false;
    }
  };

  const executeGeneration = async (generationId: string): Promise<void> => {
    let generation = options.integrations.executePending(generationId);
    if (generation.state === "validating") {
      for (const required of generation.manifest.requiredValidations) {
        generation = options.integrations
          .inspect(generation.manifest.runId)
          .find((candidate) => candidate.id === generationId)!;
        const repository = generation.repositoryResults.find(
          (candidate) =>
            candidate.repositoryReference === required.repositoryReference,
        )!;
        if (
          repository.validationRecords.some(
            (record) => record.validationId === required.id,
          )
        ) {
          continue;
        }
        const input: ValidationInput = {
          operationKey: `${generation.id}:validation:${required.id}`,
          generationId: generation.id,
          manifestHash: generation.manifestHash,
          repositoryReference: repository.repositoryReference,
          integratedCommit: repository.integratedCommit!,
          validation: required,
        };
        let result = await validationExecutor.reconcile(input);
        if (result.status === "not-applied") {
          result = await validationExecutor.execute(input);
        }
        if (result.status === "not-applied") {
          options.integrations.blockPending(generation.id, {
            code: "INTEGRATION_VALIDATION_RESULT_MISSING",
            message: "Validation execution returned no authoritative result.",
            evidence: { operationKey: input.operationKey },
          });
          return;
        }
        if (result.status === "unknown") {
          options.integrations.blockPending(generation.id, {
            code: result.code,
            message: result.message,
            evidence: result.evidence,
          });
          return;
        }
        const commandId = `${input.operationKey}:${result.status}`;
        if (
          !executeCommand({
            generationId: generation.id,
            phase: "validation",
            commandId,
            command: {
              type: "integration.validation.record",
              generationId: generation.id,
              validationId: required.id,
              repositoryReference: repository.repositoryReference,
              status: result.status,
              kind: required.kind,
              evidenceRefs: [...result.evidenceRefs],
              responsibleWorkPackageVersionIds: [
                ...result.responsibleWorkPackageVersionIds,
              ],
              ...(result.contractFailure
                ? { contractFailure: result.contractFailure }
                : {}),
            },
          })
        )
          return;
        if (result.status === "failed") return;
      }
    }
    generation = options.integrations
      .inspect(generation.manifest.runId)
      .find((candidate) => candidate.id === generationId)!;
    if (generation.state !== "aggregate-review") return;
    const topicId = `integration-review:${generation.id}`;
    const input: AggregateReviewInput = {
      operationKey: `${generation.id}:aggregate-review`,
      generationId: generation.id,
      manifestHash: generation.manifestHash,
      topicId,
      repositoryCommits: generation.repositoryResults.map((repository) => ({
        repositoryId: repository.repositoryReference,
        commit: repository.integratedCommit!,
      })),
      acceptanceCriteria: generation.manifest.integrationConditions,
    };
    let result = await aggregateReviewExecutor.reconcile(input);
    if (result.status === "not-applied") {
      result = await aggregateReviewExecutor.execute(input);
    }
    if (result.status === "not-applied") {
      options.integrations.blockPending(generation.id, {
        code: "INTEGRATION_AGGREGATE_REVIEW_RESULT_MISSING",
        message: "Aggregate Review execution returned no authoritative result.",
        evidence: { operationKey: input.operationKey },
      });
      return;
    }
    if (result.status === "unknown") {
      options.integrations.blockPending(generation.id, {
        code: result.code,
        message: result.message,
        evidence: result.evidence,
      });
      return;
    }
    const commandId = `${input.operationKey}:completed`;
    executeCommand({
      generationId: generation.id,
      phase: "aggregate-review",
      commandId,
      command: {
        type: "integration.aggregate-review.record",
        generationId: generation.id,
        topicId: result.topicId,
        qualityGateResultId: result.qualityGateResultId,
      },
    });
  };

  return {
    executeReady: async ({ runId, nodeRunId }) => {
      let generation = options.integrations
        .inspect(runId)
        .find(
          (candidate) =>
            candidate.manifest.nodeRunId === nodeRunId &&
            !["failed", "passed"].includes(candidate.state),
        );
      if (!generation) {
        const generationNumber = options.integrations.inspect(runId).length + 1;
        const generationId = `integration:${runId}:g${generationNumber}`;
        const result = options.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `integration:${runId}:${nodeRunId}:g${generationNumber}:start`,
          actor,
          command: {
            type: "integration.generation.start",
            generationId,
            runId,
            nodeRunId,
          },
        });
        if (result.status !== "succeeded") return;
        generation = options.integrations
          .inspect(runId)
          .find((candidate) => candidate.id === generationId);
        if (!generation) return;
      }
      if (!["blocked", "failed", "passed"].includes(generation.state)) {
        await executeGeneration(generation.id);
      }
    },
    reconcilePending: async () => {
      const operationCount = options.integrations.reconcilePending();
      const generations = options.integrations.inspectPending();
      for (const generation of generations) {
        await executeGeneration(generation.id);
      }
      return operationCount + generations.length;
    },
  };
};
