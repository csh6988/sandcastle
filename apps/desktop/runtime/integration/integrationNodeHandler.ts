import {
  CompanyCommandError,
  type CompanyCommandRegistry,
} from "../commandRegistry.js";
import type { ActorRef } from "../interface.js";
import type {
  IntegrationGenerationManifest,
  IntegrationGenerationView,
  IntegrationRuntime,
} from "./integrationRuntime.js";
import { IntegrationRuntimeError } from "./integrationRuntime.js";

export type IntegrationValidationInput = {
  readonly operationKey: string;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly repositoryReference: string;
  readonly integratedCommit: string;
  readonly responsibleWorkPackageVersionIds: readonly string[];
  readonly validation: IntegrationGenerationManifest["requiredValidations"][number];
};

export type IntegrationValidationResult =
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
  readonly execute: (
    input: IntegrationValidationInput,
  ) => Promise<IntegrationValidationResult>;
  readonly reconcile: (
    input: IntegrationValidationInput,
  ) => Promise<IntegrationValidationResult>;
}

export type AggregateIntegrationReviewInput = {
  readonly operationKey: string;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly topicId: string;
  readonly repositoryCommits: readonly {
    readonly repositoryId: string;
    readonly commit: string;
  }[];
  readonly acceptanceCriteria: readonly string[];
};

export type AggregateIntegrationReviewResult =
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
    input: AggregateIntegrationReviewInput,
  ) => Promise<AggregateIntegrationReviewResult>;
  readonly reconcile: (
    input: AggregateIntegrationReviewInput,
  ) => Promise<AggregateIntegrationReviewResult>;
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

export const openIntegrationNodeHandler = (options: {
  readonly commandRegistry: CompanyCommandRegistry;
  readonly integrations: IntegrationRuntime;
  readonly validationExecutor: IntegrationValidationExecutor;
  readonly aggregateReviewExecutor: AggregateIntegrationReviewExecutor;
}): IntegrationNodeHandler => {
  const validationExecutor = options.validationExecutor;
  const aggregateReviewExecutor = options.aggregateReviewExecutor;

  const executeCommand = (input: {
    readonly generationId: string;
    readonly phase: "start" | "validation" | "aggregate-review";
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

  const blockStart = (input: {
    readonly generationId: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly code: string;
    readonly message: string;
    readonly commandId: string;
  }): void => {
    options.integrations.blockStart({
      generationId: input.generationId,
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      failure: {
        code: input.code,
        message: input.message,
        evidence: { phase: "start", commandId: input.commandId },
      },
    });
  };

  const executeGeneration = async (generationId: string): Promise<void> => {
    let generation: IntegrationGenerationView;
    try {
      generation = options.integrations.executePending(generationId);
    } catch (error) {
      if (!(error instanceof IntegrationRuntimeError)) throw error;
      options.integrations.blockPending(generationId, {
        code: error.code,
        message: error.message,
        evidence: { phase: "execution", generationId },
      });
      return;
    }
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
        const input: IntegrationValidationInput = {
          operationKey: `${generation.id}:validation:${required.id}`,
          generationId: generation.id,
          manifestHash: generation.manifestHash,
          repositoryReference: repository.repositoryReference,
          integratedCommit: repository.integratedCommit!,
          responsibleWorkPackageVersionIds:
            required.responsibleWorkPackageVersionIds,
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
    const input: AggregateIntegrationReviewInput = {
      operationKey: `${generation.id}:aggregate-review`,
      generationId: generation.id,
      manifestHash: generation.manifestHash,
      projectId: generation.manifest.projectId,
      runId: generation.manifest.runId,
      nodeRunId: generation.manifest.nodeRunId,
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
        const commandId = `integration:${runId}:${nodeRunId}:g${generationNumber}:start`;
        try {
          const result = options.commandRegistry.execute({
            schemaVersion: 1,
            commandId,
            actor,
            consumerId: "integration-node-handler",
            command: {
              type: "integration.generation.start",
              generationId,
              runId,
              nodeRunId,
            },
          });
          if (result.status !== "succeeded") {
            if (result.error.code === "STORE_BUSY") return;
            blockStart({
              generationId,
              runId,
              nodeRunId,
              code: result.error.code,
              message: result.error.message,
              commandId,
            });
            return;
          }
        } catch (error) {
          if (
            error instanceof CompanyCommandError &&
            error.code === "STORE_BUSY"
          ) {
            return;
          }
          blockStart({
            generationId,
            runId,
            nodeRunId,
            code:
              error instanceof CompanyCommandError
                ? error.code
                : "INTEGRATION_COMMAND_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Integration Generation start failed.",
            commandId,
          });
          return;
        }
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
