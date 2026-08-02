import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CommandEnvelopeSchema,
  CommandResultSchema,
  ApplicationViewSchema,
  TechnicalReviewStateViewSchema,
  WorkspaceAllocationViewSchema,
  WorkPackageGraphViewSchema,
  ProjectEditorViewSchema,
  ProductDiscoveryViewSchema,
  ProductReviewStateViewSchema,
  ReviewTopicViewSchema,
  CodeReviewViewSchema,
  IntegrationGenerationViewSchema,
  TestCaseRevisionViewSchema,
  TestRunViewSchema,
  type CommandEnvelope,
  type CommandResult,
  type ApplicationView,
  type TechnicalReviewStateView,
  type WorkspaceAllocationView,
  type WorkspaceEnvelopeCommand,
  type WorkPackageEnvelopeCommand,
  type WorkPackageGraphView,
  type EnvelopeCommand,
  type EnvelopeCommandResult,
  type ProjectEditorView,
  type ProductDiscoveryView,
  type ProductReviewStateView,
  type ReviewTopicView,
  type ReviewEnvelopeCommand,
  type CodeReviewEnvelopeCommand,
  type CodeReviewView,
  type IntegrationEnvelopeCommand,
  type IntegrationGenerationView,
  type TestEnvelopeCommand,
  type TestCaseRevisionView,
  type TestRunView,
  DeliveryCandidateInputViewSchema,
  CandidateGateInputViewSchema,
  CandidateGateExecutionViewSchema,
  CandidateGateResultViewSchema,
  DeliveryCandidateInputGateAuthoritySchema,
  CriticalRiskEscalationDecisionSchema,
  type DeliveryQualityEnvelopeCommand,
  DeliveryCandidateViewSchema,
  type DeliveryEnvelopeCommand,
  type MemoryEnvelopeCommand,
  MemoryCandidateViewSchema,
  MemoryDecisionViewSchema,
  RunMemorySelectionViewSchema,
  InteractionTurnViewSchema,
  type InteractionTurnView,
  RunSupervisionViewSchema,
  type RunSupervisionView,
  PermissionRequestViewSchema,
  type PermissionRequestView,
} from "./interface.js";
import {
  ProjectConfigurationError,
  type ProjectConfiguration,
} from "./project/projectConfiguration.js";
import {
  ArtifactRegistryError,
  type ArtifactRegistry,
} from "./artifactRegistry.js";
import {
  ProductRuntimeError,
  type ProductConfirmationFailurePoint,
  type ProductRuntime,
} from "./product/productRuntime.js";
import {
  PipelineRuntimeError,
  type PipelineRuntime,
} from "./pipeline/pipelineRuntime.js";
import {
  RuntimeInteractionError,
  type RuntimeInteraction,
} from "./interaction.js";
import {
  ReviewRuntimeError,
  type ReviewRuntime,
} from "./review/reviewRuntime.js";
import {
  ProductReviewRuntimeError,
  type ProductGatePromotionFailurePoint,
  type ProductReviewRuntime,
} from "./product/productReviewRuntime.js";
import {
  TechnicalReviewRuntimeError,
  type TechnicalGatePromotionFailurePoint,
  type TechnicalReviewRuntime,
} from "./project/technicalReviewRuntime.js";
import {
  WorkspaceRuntimeError,
  type WorkspaceRuntime,
} from "./workspaces/workspaceRuntime.js";
import type { RuntimeSupervision } from "./runSupervision.js";
import { RuntimeMemoryError, type RuntimeMemory } from "./memory.js";
import {
  WorkPackageRuntimeError,
  type WorkPackageRuntime,
} from "./workspaces/workPackages.js";
import {
  CodeReviewRuntimeError,
  type CodeReviewRuntime,
} from "./review/codeReviewRuntime.js";
import {
  IntegrationRuntimeError,
  type IntegrationRuntime,
} from "./integration/integrationRuntime.js";
import { TestRuntimeError, type TestRuntime } from "./testing/testRuntime.js";
import {
  CandidateInputRuntimeError,
  type CandidateInputRuntime,
} from "./delivery/candidateInputRuntime.js";
import {
  QualityGateRuntimeError,
  type QualityGateRuntime,
} from "./quality/qualityGateRuntime.js";
import {
  DeliveryRuntimeError,
  type DeliveryRuntime,
} from "./delivery/deliveryRuntime.js";

export interface CompanyCommandRegistry {
  readonly execute: <Command extends EnvelopeCommand>(
    envelope: CommandEnvelope<Command>,
  ) => CommandResult<EnvelopeCommandResult<Command>>;
}

export class CompanyCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyCommandError";
  }
}

export type MemoryCommandFailurePoint = "before-receipt" | "before-commit";

export const companyCommandDefinitions = {
  "project.update": {
    primaryAggregate: "project",
    expectedRevisionRequired: true,
  },
  "application.register": {
    primaryAggregate: "application",
    expectedRevisionRequired: true,
  },
  "application-spec.revise": {
    primaryAggregate: "application-spec",
    expectedRevisionRequired: true,
  },
  "technical-baseline-proposal.revise": {
    primaryAggregate: "technical-baseline-proposal",
    expectedRevisionRequired: true,
  },
  "technical-review.start": {
    primaryAggregate: "technical-baseline-proposal",
    expectedRevisionRequired: true,
  },
  "technical-gate.promote": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "product.proposal.revise": {
    primaryAggregate: "product-proposal",
    expectedRevisionRequired: true,
  },
  "product.proposal.mark-awaiting-confirmation": {
    primaryAggregate: "product-proposal",
    expectedRevisionRequired: true,
  },
  "confirm-product-baseline": {
    primaryAggregate: "product-proposal",
    expectedRevisionRequired: true,
  },
  "fork-department-run": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "project-spec.revise": {
    primaryAggregate: "project-spec",
    expectedRevisionRequired: true,
  },
  "product-review.start": {
    primaryAggregate: "project-spec",
    expectedRevisionRequired: true,
  },
  "product-readiness.record": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "product-gate.promote": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "artifact.version.register": {
    primaryAggregate: "artifact",
    expectedRevisionRequired: false,
  },
  "artifact.version.finalize": {
    primaryAggregate: "artifact",
    expectedRevisionRequired: false,
  },
  "artifact.version.supersede": {
    primaryAggregate: "artifact",
    expectedRevisionRequired: false,
  },
  "review.topic.create": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.finding.submit": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.finding.disposition": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.discussion.open": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.discussion.close": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.revision.submit": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "review.recheck.submit": {
    primaryAggregate: "review-topic",
    expectedRevisionRequired: true,
  },
  "code-review.start": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "code-review.converge": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "integration.generation.start": {
    primaryAggregate: "integration-generation",
    expectedRevisionRequired: false,
  },
  "integration.validation.record": {
    primaryAggregate: "integration-generation",
    expectedRevisionRequired: false,
  },
  "integration.aggregate-review.record": {
    primaryAggregate: "integration-generation",
    expectedRevisionRequired: false,
  },
  "workspace-allocation.provision": {
    primaryAggregate: "workspace-allocation",
    expectedRevisionRequired: true,
  },
  "source-import.execute": {
    primaryAggregate: "workspace-allocation",
    expectedRevisionRequired: true,
  },
  "workspace-allocation.cleanup": {
    primaryAggregate: "workspace-allocation",
    expectedRevisionRequired: true,
  },
  "memory.candidate.propose": {
    primaryAggregate: "memory-candidate",
    expectedRevisionRequired: false,
  },
  "memory.review.start": {
    primaryAggregate: "memory-candidate",
    expectedRevisionRequired: true,
  },
  "memory.candidate.decide": {
    primaryAggregate: "memory-candidate-revision",
    expectedRevisionRequired: false,
  },
  "memory.entry.select-for-run": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "work-package.generate": {
    primaryAggregate: "department-run",
    expectedRevisionRequired: true,
  },
  "work-package.version": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "work-package.assign": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "work-package.start": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "work-package.rework": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "work-package.self-check": {
    primaryAggregate: "work-package",
    expectedRevisionRequired: true,
  },
  "delivery.candidate-input.freeze": {
    primaryAggregate: "delivery-candidate-input",
    expectedRevisionRequired: false,
  },
  "quality-gate.input.prepare": {
    primaryAggregate: "candidate-gate-input",
    expectedRevisionRequired: false,
  },
  "quality-gate.execution.accept": {
    primaryAggregate: "candidate-gate-execution",
    expectedRevisionRequired: false,
  },
  "quality-gate.execution.reconcile": {
    primaryAggregate: "candidate-gate-execution",
    expectedRevisionRequired: false,
  },
  "quality-gate.result.finalize": {
    primaryAggregate: "candidate-gate-result",
    expectedRevisionRequired: false,
  },
  "delivery.candidate-input.authorize": {
    primaryAggregate: "delivery-candidate-input",
    expectedRevisionRequired: false,
  },
  "quality-gate.critical-escalation.decide": {
    primaryAggregate: "critical-risk-escalation",
    expectedRevisionRequired: false,
  },
  "delivery.candidate.assemble": {
    primaryAggregate: "delivery-candidate",
    expectedRevisionRequired: false,
  },
  "delivery.release.decide": {
    primaryAggregate: "human-release-decision",
    expectedRevisionRequired: false,
  },
  "delivery.release.recover": {
    primaryAggregate: "human-release-decision",
    expectedRevisionRequired: false,
  },
} as const;

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

const commandIdReuse = (commandId: string): CommandResult<unknown> => ({
  status: "rejected",
  error: {
    code: "COMMAND_ID_REUSE",
    message: `Command ${commandId} was already used for a different request.`,
  },
  effectIds: [],
});

const deterministicError = (
  error: unknown,
): { readonly code: string; readonly message: string } | undefined => {
  if (error instanceof CompanyCommandError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ProjectConfigurationError) {
    return { code: error.code, message: error.message };
  }
  if (
    error instanceof Error &&
    /^Project .+ was not found\.$/.test(error.message)
  ) {
    return { code: "PROJECT_NOT_FOUND", message: error.message };
  }
  if (error instanceof ArtifactRegistryError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ProductRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ProductReviewRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof TechnicalReviewRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof WorkspaceRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof WorkPackageRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof PipelineRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RuntimeInteractionError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ReviewRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof CodeReviewRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof IntegrationRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof TestRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof CandidateInputRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof QualityGateRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DeliveryRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RuntimeMemoryError) {
    return { code: error.code, message: error.message };
  }
  return undefined;
};

const executeReviewCommand = (
  database: DatabaseSync,
  reviewRuntime: ReviewRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<ReviewTopicView> => {
  if (!envelope.command.type.startsWith("review.")) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Review command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<ReviewTopicView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<ReviewTopicView>;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<ReviewTopicView>;
    database.exec("SAVEPOINT review_command");
    try {
      const value = reviewRuntime.dispatchInTransaction({
        commandId: envelope.commandId,
        actor: envelope.actor,
        expectedRevision: envelope.expectedRevision,
        command: envelope.command as ReviewEnvelopeCommand,
      });
      database.exec("RELEASE review_command");
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = {
        status: "succeeded",
        value: ReviewTopicViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO review_command");
      database.exec("RELEASE review_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeCodeReviewCommand = (
  database: DatabaseSync,
  codeReviews: CodeReviewRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<CodeReviewView> => {
  if (!envelope.command.type.startsWith("code-review.")) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Code Review command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<CodeReviewView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<CodeReviewView>;
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<CodeReviewView>;
    database.exec("SAVEPOINT code_review_command");
    try {
      const value = codeReviews.dispatchInTransaction({
        commandId: envelope.commandId,
        actor: envelope.actor,
        expectedRevision: envelope.expectedRevision,
        command: envelope.command as CodeReviewEnvelopeCommand,
      });
      database.exec("RELEASE code_review_command");
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = {
        status: "succeeded",
        value: CodeReviewViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO code_review_command");
      database.exec("RELEASE code_review_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeIntegrationCommand = (
  database: DatabaseSync,
  integrations: IntegrationRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<IntegrationGenerationView> => {
  if (!envelope.command.type.startsWith("integration.")) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not an Integration command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, status,
                result_json AS resultJson, result_hash AS resultHash,
                effect_ids_json AS effectIdsJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly status: string;
          readonly resultJson: string;
          readonly resultHash: string;
          readonly effectIdsJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      if (!sameRequest) {
        database.exec("COMMIT");
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<IntegrationGenerationView>;
      }
      try {
        if (
          receipt.status !== "completed" ||
          sha256(receipt.resultJson) !== receipt.resultHash
        ) {
          throw new Error("receipt status or result hash is invalid");
        }
        const parsed = CommandResultSchema.parse(
          JSON.parse(receipt.resultJson),
        );
        const replay = (
          parsed.status === "succeeded"
            ? {
                ...parsed,
                value: IntegrationGenerationViewSchema.parse(parsed.value),
              }
            : parsed
        ) as CommandResult<IntegrationGenerationView>;
        const storedEffectIds = JSON.parse(receipt.effectIdsJson) as unknown;
        const actualEffectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        if (
          canonicalJson(replay) !== receipt.resultJson ||
          !Array.isArray(storedEffectIds) ||
          !storedEffectIds.every((effectId) => typeof effectId === "string") ||
          canonicalJson(replay.effectIds) !== canonicalJson(storedEffectIds) ||
          canonicalJson(storedEffectIds) !== canonicalJson(actualEffectIds)
        ) {
          throw new Error("receipt effect IDs are invalid");
        }
        database.exec("COMMIT");
        return replay;
      } catch {
        throw new CompanyCommandError(
          "COMMAND_RECEIPT_INVALID",
          `Command ${envelope.commandId} has an invalid completed receipt.`,
        );
      }
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<IntegrationGenerationView>;
    database.exec("SAVEPOINT integration_command");
    try {
      const value = integrations.dispatchInTransaction({
        commandId: envelope.commandId,
        actor: envelope.actor,
        command: envelope.command as IntegrationEnvelopeCommand,
      });
      database.exec("RELEASE integration_command");
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = {
        status: "succeeded",
        value: IntegrationGenerationViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO integration_command");
      database.exec("RELEASE integration_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  }
};

const executeTestCommand = (
  database: DatabaseSync,
  testRuntime: TestRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<TestCaseRevisionView | TestRunView> => {
  if (!envelope.command.type.startsWith("test.")) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Test command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, status,
                result_json AS resultJson, result_hash AS resultHash,
                effect_ids_json AS effectIdsJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly status: string;
          readonly resultJson: string;
          readonly resultHash: string;
          readonly effectIdsJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      if (!sameRequest) {
        database.exec("COMMIT");
        return commandIdReuse(envelope.commandId) as CommandResult<
          TestCaseRevisionView | TestRunView
        >;
      }
      try {
        if (
          receipt.status !== "completed" ||
          sha256(receipt.resultJson) !== receipt.resultHash
        )
          throw new Error("receipt integrity invalid");
        const parsed = CommandResultSchema.parse(
          JSON.parse(receipt.resultJson),
        );
        const replay = (
          parsed.status === "succeeded"
            ? {
                ...parsed,
                value:
                  envelope.command.type === "test.case-revision.register"
                    ? TestCaseRevisionViewSchema.parse(parsed.value)
                    : TestRunViewSchema.parse(parsed.value),
              }
            : parsed
        ) as CommandResult<TestCaseRevisionView | TestRunView>;
        const storedEffectIds = JSON.parse(receipt.effectIdsJson) as unknown;
        const actualEffectIds = (
          database
            .prepare(
              "SELECT id FROM runtime_audit_records WHERE command_id = ? ORDER BY created_at, id",
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        if (
          !Array.isArray(storedEffectIds) ||
          canonicalJson(replay) !== receipt.resultJson ||
          canonicalJson(replay.effectIds) !== canonicalJson(storedEffectIds) ||
          canonicalJson(storedEffectIds) !== canonicalJson(actualEffectIds)
        )
          throw new Error("receipt effect IDs invalid");
        database.exec("COMMIT");
        return replay;
      } catch {
        throw new CompanyCommandError(
          "COMMAND_RECEIPT_INVALID",
          `Command ${envelope.commandId} has an invalid completed receipt.`,
        );
      }
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<TestCaseRevisionView | TestRunView>;
    database.exec("SAVEPOINT test_command");
    try {
      const command = envelope.command as TestEnvelopeCommand;
      const value = (() => {
        switch (command.type) {
          case "test.case-revision.register":
            return testRuntime.registerCaseRevision({
              testCaseId: command.testCaseId,
              revisionId: command.revisionId,
              projectId: command.projectId,
              ...(command.supersedesRevisionId
                ? { supersedesRevisionId: command.supersedesRevisionId }
                : {}),
              manifest: command.manifest as Parameters<
                TestRuntime["registerCaseRevision"]
              >[0]["manifest"],
            });
          case "test.run.create":
            return testRuntime.createRun(command.input);
          case "test.rework.create":
            return testRuntime.createReworkRun({
              defectId: command.defectId,
              input: command.input,
              successorAssertions: command.successorAssertions,
            }).run;
          case "test.defect.record":
            return testRuntime.recordDefect({
              id: command.id,
              testRunId: command.testRunId,
              testCaseRevisionId: command.testCaseRevisionId,
              ...(command.assertionId
                ? { assertionId: command.assertionId }
                : {}),
              responsibility: command.responsibility,
              evidence: command.evidence,
            });
          case "test.defect.close":
            return testRuntime.closeDefect({
              defectId: command.defectId,
              resolutionId: command.resolutionId,
              resolution: command.resolution,
            });
          case "test.run.complete":
            return testRuntime.complete(command.testRunId);
        }
      })();
      database.exec("RELEASE test_command");
      const effectIds = (
        database
          .prepare(
            "SELECT id FROM runtime_audit_records WHERE command_id = ? ORDER BY created_at, id",
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = {
        status: "succeeded",
        value:
          command.type === "test.case-revision.register"
            ? TestCaseRevisionViewSchema.parse(value)
            : TestRunViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO test_command");
      database.exec("RELEASE test_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  }
};

const executeInteractionPrompt = (
  database: DatabaseSync,
  interaction: RuntimeInteraction,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<InteractionTurnView> => {
  if (envelope.command.type !== "interaction.prompt") {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not an Interaction Prompt command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<InteractionTurnView>;
      }
      const replay = CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<InteractionTurnView>;
      if (replay.status === "succeeded") {
        return {
          ...replay,
          value: interaction.inspectTurn(replay.value.id),
        };
      }
      return replay;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<InteractionTurnView>;
    database.exec("SAVEPOINT interaction_prompt");
    try {
      const value = interaction.acceptPromptInTransaction({
        commandId: envelope.commandId,
        actor: envelope.actor,
        sessionId: envelope.command.sessionId,
        participantId: envelope.command.participantId,
        content: envelope.command.content,
      });
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      database.exec("RELEASE interaction_prompt");
      result = {
        status: "succeeded",
        value: InteractionTurnViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO interaction_prompt");
      database.exec("RELEASE interaction_prompt");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executePermissionDecision = (
  database: DatabaseSync,
  pipelineRuntime: PipelineRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<PermissionRequestView> => {
  if (envelope.command.type !== "permission.decide") {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Permission Decision command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<PermissionRequestView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<PermissionRequestView>;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<PermissionRequestView>;
    database.exec("SAVEPOINT permission_decision");
    try {
      const value = pipelineRuntime.decidePermissionInTransaction({
        ...envelope.command,
        actor: envelope.actor,
        commandId: envelope.commandId,
      });
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      database.exec("RELEASE permission_decision");
      result = {
        status: "succeeded",
        value: PermissionRequestViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO permission_decision");
      database.exec("RELEASE permission_decision");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeInteractionTurnCancellation = (
  database: DatabaseSync,
  interaction: RuntimeInteraction,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<InteractionTurnView> => {
  if (envelope.command.type !== "interaction.turn.cancel") {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not an Interaction Turn cancellation command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<InteractionTurnView>;
      }
      const replay = CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<InteractionTurnView>;
      return replay.status === "succeeded"
        ? { ...replay, value: interaction.inspectTurn(replay.value.id) }
        : replay;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<InteractionTurnView>;
    database.exec("SAVEPOINT interaction_turn_cancel");
    try {
      const value = interaction.requestTurnCancellationInTransaction({
        sessionId: envelope.command.sessionId,
        turnId: envelope.command.turnId,
        actor: envelope.actor,
        commandId: envelope.commandId,
      });
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      database.exec("RELEASE interaction_turn_cancel");
      result = {
        status: "succeeded",
        value: InteractionTurnViewSchema.parse(value),
        effectIds,
      };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO interaction_turn_cancel");
      database.exec("RELEASE interaction_turn_cancel");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeProductCommand = (
  database: DatabaseSync,
  productRuntime: ProductRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
  failureInjection?: (point: ProductConfirmationFailurePoint) => void,
): CommandResult<ProductDiscoveryView> => {
  const command = envelope.command;
  if (
    command.type !== "product.proposal.revise" &&
    command.type !== "product.proposal.mark-awaiting-confirmation" &&
    command.type !== "confirm-product-baseline" &&
    command.type !== "fork-department-run"
  ) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${command.type} is not a Product command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<ProductDiscoveryView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<ProductDiscoveryView>;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<ProductDiscoveryView>;
    if (envelope.expectedRevision === undefined) {
      result = {
        status: "rejected",
        error: {
          code: "EXPECTED_REVISION_REQUIRED",
          message: `${command.type} requires an expected product-proposal revision.`,
        },
        effectIds: [],
      };
    } else {
      database.exec("SAVEPOINT product_command");
      try {
        const value =
          command.type === "product.proposal.revise"
            ? productRuntime.reviseProposalInTransaction({
                commandId: envelope.commandId,
                actor: envelope.actor,
                expectedRevision: envelope.expectedRevision,
                projectId: command.projectId,
                producerSessionId: command.producerSessionId,
                content: command.content,
              })
            : command.type === "product.proposal.mark-awaiting-confirmation"
              ? productRuntime.markAwaitingConfirmationInTransaction({
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision,
                  projectId: command.projectId,
                  proposalRevisionId: command.proposalRevisionId,
                  proposalHash: command.proposalHash,
                })
              : command.type === "confirm-product-baseline"
                ? productRuntime.confirmProductBaselineInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision,
                    projectId: command.projectId,
                    departmentId: command.departmentId,
                    agentOverrideId: command.agentOverrideId,
                    forkSourceRunId: command.forkSourceRunId,
                    forkSourceSnapshotRevisionId:
                      command.forkSourceSnapshotRevisionId,
                    proposalRevisionId: command.proposalRevisionId,
                    proposalHash: command.proposalHash,
                  })
                : productRuntime.forkDepartmentRunInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision,
                    sourceRunId: command.sourceRunId,
                    sourceSnapshotRevisionId: command.sourceSnapshotRevisionId,
                    reason: command.reason,
                  });
        database.exec("RELEASE product_command");
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = {
          status: "succeeded",
          value: ProductDiscoveryViewSchema.parse(value),
          effectIds,
        };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        database.exec("ROLLBACK TO product_command");
        database.exec("RELEASE product_command");
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    if (command.type === "confirm-product-baseline") {
      failureInjection?.("before-receipt");
    }
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    if (command.type === "confirm-product-baseline") {
      failureInjection?.("before-commit");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeProductReviewCommand = (
  database: DatabaseSync,
  productReviewRuntime: ProductReviewRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
  promotionFailure?: (point: ProductGatePromotionFailurePoint) => void,
): CommandResult<ProductReviewStateView> => {
  const command = envelope.command;
  if (
    command.type !== "project-spec.revise" &&
    command.type !== "product-review.start" &&
    command.type !== "product-readiness.record" &&
    command.type !== "product-gate.promote"
  ) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${command.type} is not a Product Review command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<ProductReviewStateView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<ProductReviewStateView>;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<ProductReviewStateView>;
    if (envelope.expectedRevision === undefined) {
      result = {
        status: "rejected",
        error: {
          code: "EXPECTED_REVISION_REQUIRED",
          message: `${command.type} requires an expected Project Spec revision.`,
        },
        effectIds: [],
      };
    } else {
      database.exec("SAVEPOINT product_review_command");
      try {
        const value =
          command.type === "project-spec.revise"
            ? productReviewRuntime.reviseSpecInTransaction({
                commandId: envelope.commandId,
                actor: envelope.actor,
                expectedRevision: envelope.expectedRevision,
                runId: command.runId,
                producerSessionId: command.producerSessionId,
                content: command.content,
              })
            : command.type === "product-review.start"
              ? productReviewRuntime.startReviewInTransaction({
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision,
                  runId: command.runId,
                  topicId: command.topicId,
                  projectSpecRevisionId: command.projectSpecRevisionId,
                  projectSpecHash: command.projectSpecHash,
                  participants: command.participants,
                  quorum: command.quorum,
                  budget: command.budget,
                })
              : command.type === "product-readiness.record"
                ? productReviewRuntime.recordReadinessInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision,
                    runId: command.runId,
                    evidenceId: command.evidenceId,
                    projectSpecRevisionId: command.projectSpecRevisionId,
                    projectSpecHash: command.projectSpecHash,
                    producerSessionId: command.producerSessionId,
                    checkKey: command.checkKey,
                    status: command.status,
                    summary: command.summary,
                    evidenceRefs: command.evidenceRefs,
                  })
                : productReviewRuntime.promoteGateInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision,
                    runId: command.runId,
                    topicId: command.topicId,
                    projectSpecRevisionId: command.projectSpecRevisionId,
                    projectSpecHash: command.projectSpecHash,
                    readinessEvidenceIds: command.readinessEvidenceIds,
                  });
        database.exec("RELEASE product_review_command");
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = {
          status: "succeeded",
          value: ProductReviewStateViewSchema.parse(value),
          effectIds,
        };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        database.exec("ROLLBACK TO product_review_command");
        database.exec("RELEASE product_review_command");
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }

    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    if (command.type === "product-gate.promote") {
      promotionFailure?.("before-receipt");
    }
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    if (command.type === "product-gate.promote") {
      promotionFailure?.("before-commit");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

type TechnicalReviewCommandValue = ApplicationView | TechnicalReviewStateView;

const executeTechnicalReviewCommand = (
  database: DatabaseSync,
  technicalReviewRuntime: TechnicalReviewRuntime,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
  promotionFailure?: (point: TechnicalGatePromotionFailurePoint) => void,
): CommandResult<TechnicalReviewCommandValue> => {
  const command = envelope.command;
  if (
    command.type !== "application.register" &&
    command.type !== "application-spec.revise" &&
    command.type !== "technical-baseline-proposal.revise" &&
    command.type !== "technical-review.start" &&
    command.type !== "technical-gate.promote"
  ) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${command.type} is not a Technical Review command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<TechnicalReviewCommandValue>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<TechnicalReviewCommandValue>;
    }

    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );

    let result: CommandResult<TechnicalReviewCommandValue>;
    if (envelope.expectedRevision === undefined) {
      result = {
        status: "rejected",
        error: {
          code: "EXPECTED_REVISION_REQUIRED",
          message: `${command.type} requires an expected Application revision.`,
        },
        effectIds: [],
      };
    } else {
      database.exec("SAVEPOINT technical_review_command");
      try {
        const value =
          command.type === "application.register"
            ? technicalReviewRuntime.registerApplicationInTransaction({
                commandId: envelope.commandId,
                actor: envelope.actor,
                expectedRevision: envelope.expectedRevision,
                applicationId: command.applicationId,
                projectId: command.projectId,
                repositoryReference: command.repositoryReference,
                applicationKey: command.applicationKey,
                ownership: command.ownership,
                buildCommand: command.buildCommand,
                testCommand: command.testCommand,
              })
            : command.type === "application-spec.revise"
              ? technicalReviewRuntime.reviseApplicationSpecInTransaction({
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision,
                  runId: command.runId,
                  applicationId: command.applicationId,
                  promotedProjectSpecRevisionId:
                    command.promotedProjectSpecRevisionId,
                  promotedProjectSpecHash: command.promotedProjectSpecHash,
                  producerSessionId: command.producerSessionId,
                  content: command.content,
                })
              : command.type === "technical-baseline-proposal.revise"
                ? technicalReviewRuntime.reviseProposalInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision,
                    runId: command.runId,
                    producerSessionId: command.producerSessionId,
                    applicationSpecRevisions: command.applicationSpecRevisions,
                    content: command.content,
                  })
                : command.type === "technical-review.start"
                  ? technicalReviewRuntime.startReviewInTransaction({
                      commandId: envelope.commandId,
                      actor: envelope.actor,
                      expectedRevision: envelope.expectedRevision,
                      runId: command.runId,
                      topicId: command.topicId,
                      technicalBaselineProposalId:
                        command.technicalBaselineProposalId,
                      technicalBaselineProposalHash:
                        command.technicalBaselineProposalHash,
                      priorQualityGateResultId:
                        command.priorQualityGateResultId,
                      participants: command.participants,
                      quorum: command.quorum,
                      budget: command.budget,
                    })
                  : technicalReviewRuntime.promoteGateInTransaction({
                      commandId: envelope.commandId,
                      actor: envelope.actor,
                      expectedRevision: envelope.expectedRevision,
                      runId: command.runId,
                      parentSnapshotRevisionId:
                        command.parentSnapshotRevisionId,
                      gateResultId: command.gateResultId,
                    });
        database.exec("RELEASE technical_review_command");
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = {
          status: "succeeded",
          value:
            command.type === "application.register"
              ? ApplicationViewSchema.parse(value)
              : TechnicalReviewStateViewSchema.parse(value),
          effectIds,
        };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        database.exec("ROLLBACK TO technical_review_command");
        database.exec("RELEASE technical_review_command");
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }

    const resultJson = canonicalJson(result);
    if (command.type === "technical-gate.promote") {
      promotionFailure?.("before-receipt");
    }
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    if (command.type === "technical-gate.promote") {
      promotionFailure?.("before-commit");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (
      error instanceof Error &&
      (("errcode" in error && error.errcode === 5) ||
        /database (?:is )?(?:locked|busy)/i.test(error.message))
    ) {
      throw new CompanyCommandError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

const executeMemoryCommand = (
  database: DatabaseSync,
  memory: RuntimeMemory,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
  failureInjection?: (point: MemoryCommandFailurePoint) => void,
): CommandResult<unknown> => {
  if (!envelope.command.type.startsWith("memory.")) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Memory command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) return commandIdReuse(envelope.commandId);
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<unknown>;
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<unknown>;
    database.exec("SAVEPOINT memory_command");
    try {
      const command = envelope.command as MemoryEnvelopeCommand;
      const value =
        command.type === "memory.candidate.propose"
          ? MemoryCandidateViewSchema.parse(
              memory.proposeCandidateInTransaction({
                commandId: envelope.commandId,
                actor: envelope.actor,
                command,
              }),
            )
          : command.type === "memory.review.start"
            ? MemoryCandidateViewSchema.parse(
                memory.startReviewInTransaction({
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision ?? -1,
                  command,
                }),
              )
            : command.type === "memory.candidate.decide"
              ? MemoryDecisionViewSchema.parse(
                  memory.decideCandidateInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    command,
                  }),
                )
              : RunMemorySelectionViewSchema.parse(
                  memory.selectEntriesForRunInTransaction({
                    commandId: envelope.commandId,
                    actor: envelope.actor,
                    expectedRevision: envelope.expectedRevision ?? -1,
                    command,
                  }),
                );
      database.exec("RELEASE memory_command");
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = { status: "succeeded", value, effectIds };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO memory_command");
      database.exec("RELEASE memory_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    if (envelope.command.type === "memory.candidate.decide") {
      failureInjection?.("before-receipt");
    }
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    if (envelope.command.type === "memory.candidate.decide") {
      failureInjection?.("before-commit");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const executeArtifactCommand = (
  database: DatabaseSync,
  artifactRegistry: ArtifactRegistry,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<unknown> => {
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let managedFileWrite:
    | { readonly registrationId: string; readonly bytes: Buffer }
    | undefined;
  let result!: CommandResult<unknown>;
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) return commandIdReuse(envelope.commandId);
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<unknown>;
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    try {
      const command = envelope.command;
      const value = (() => {
        if (command.type === "artifact.version.register") {
          const bytes =
            command.content.kind === "managed-file"
              ? Buffer.from(command.content.data, "base64")
              : undefined;
          const registration = artifactRegistry.registerInTransaction({
            projectId: command.projectId,
            type: command.artifactType,
            schemaVersion: command.artifactSchemaVersion,
            logicalName: command.logicalName,
            content:
              command.content.kind === "managed-file"
                ? {
                    kind: "managed-file",
                    bytes: bytes!,
                    mediaType: command.content.mediaType,
                  }
                : command.content,
            producer: command.producer,
            inputVersionIds: command.inputVersionIds,
          });
          if (bytes && !registration.finalized) {
            managedFileWrite = {
              registrationId: registration.registrationId,
              bytes,
            };
          }
          return registration;
        }
        if (command.type === "artifact.version.finalize") {
          return artifactRegistry.finalizeInTransaction({
            registrationId: command.registrationId,
          });
        }
        if (command.type === "artifact.version.supersede") {
          return artifactRegistry.supersedeInTransaction({
            versionId: command.versionId,
            supersededByVersionId: command.supersededByVersionId,
          });
        }
        throw new CompanyCommandError(
          "COMMAND_UNSUPPORTED",
          `Command ${command.type} is not an Artifact command.`,
        );
      })();
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(envelope.commandId) as Array<{ readonly id: string }>
      ).map((row) => row.id);
      result = { status: "succeeded", value, effectIds };
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (managedFileWrite && result.status === "succeeded") {
    try {
      artifactRegistry.completeManagedFileWrite(managedFileWrite);
    } catch {
      // The committed journal is reconciled on Runtime restart or finalize retry.
    }
  }
  return result;
};

const executeWorkspaceCommand = (
  database: DatabaseSync,
  workspaceRuntime: WorkspaceRuntime,
  envelope: CommandEnvelope<WorkspaceEnvelopeCommand>,
  clock: () => Date,
): CommandResult<WorkspaceAllocationView> => {
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy, consumer_id AS consumerId,
                schema_version AS schemaVersion, request_hash AS requestHash,
                result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<WorkspaceAllocationView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<WorkspaceAllocationView>;
    }

    let result: CommandResult<WorkspaceAllocationView>;
    if (envelope.expectedRevision === undefined) {
      result = {
        status: "rejected",
        error: {
          code: "EXPECTED_REVISION_REQUIRED",
          message: `${envelope.command.type} requires an expected workspace-allocation revision.`,
        },
        effectIds: [],
      };
    } else {
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.commandId,
          envelope.actor.type,
          envelope.actor.id,
          envelope.actor.authenticatedBy,
          envelope.consumerId ?? null,
          envelope.schemaVersion,
        );
      try {
        const value =
          envelope.command.type === "workspace-allocation.provision"
            ? workspaceRuntime.planProvisionInTransaction({
                ...envelope.command,
                commandId: envelope.commandId,
                actor: envelope.actor,
                expectedRevision: envelope.expectedRevision,
              })
            : envelope.command.type === "source-import.execute"
              ? workspaceRuntime.planImportInTransaction({
                  ...envelope.command,
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision,
                })
              : workspaceRuntime.planCleanupInTransaction({
                  ...envelope.command,
                  commandId: envelope.commandId,
                  actor: envelope.actor,
                  expectedRevision: envelope.expectedRevision,
                });
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = {
          status: "succeeded",
          value: WorkspaceAllocationViewSchema.parse(value),
          effectIds,
        };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }

    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    const resultJson = canonicalJson(result);
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  }
};

const executeSupervisionCommand = (
  database: DatabaseSync,
  pipelineRuntime: PipelineRuntime,
  interaction: RuntimeInteraction,
  supervision: RuntimeSupervision,
  envelope: CommandEnvelope<EnvelopeCommand>,
  clock: () => Date,
): CommandResult<RunSupervisionView> => {
  if (
    ![
      "node-attempt.cancel",
      "interaction-turn.cancel",
      "run.governed-intervention",
    ].includes(envelope.command.type)
  ) {
    throw new CompanyCommandError(
      "COMMAND_UNSUPPORTED",
      `Command ${envelope.command.type} is not a Run Supervision command.`,
    );
  }
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let dispatch: (() => void) | undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database
      .prepare(
        `SELECT request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | { readonly requestHash: string; readonly resultJson: string }
      | undefined;
    if (receipt) {
      database.exec("COMMIT");
      return receipt.requestHash === requestHash
        ? (CommandResultSchema.parse(
            JSON.parse(receipt.resultJson),
          ) as CommandResult<RunSupervisionView>)
        : (commandIdReuse(
            envelope.commandId,
          ) as CommandResult<RunSupervisionView>);
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<RunSupervisionView>;
    let runId: string;
    database.exec("SAVEPOINT supervision_command");
    try {
      if (envelope.command.type === "node-attempt.cancel") {
        runId = envelope.command.runId;
        if (envelope.expectedRevision === undefined) {
          throw new CompanyCommandError(
            "EXPECTED_REVISION_REQUIRED",
            "node-attempt.cancel requires the Department Run revision.",
          );
        }
        pipelineRuntime.requestNodeAttemptCancellationInTransaction({
          runId: envelope.command.runId,
          attemptId: envelope.command.attemptId,
          expectedRevision: envelope.expectedRevision,
        });
        dispatch = () => {
          void pipelineRuntime.dispatchNodeAttemptCancellation(
            envelope.command.type === "node-attempt.cancel"
              ? envelope.command.attemptId
              : "",
          );
        };
      } else if (envelope.command.type === "interaction-turn.cancel") {
        runId = envelope.command.runId;
        const turn = interaction.inspectTurn(envelope.command.turnId);
        const session = interaction.inspectSession(turn.sessionId).session;
        if (session.runId !== envelope.command.runId) {
          throw new RuntimeInteractionError(
            "INTERACTION_TURN_RUN_MISMATCH",
            `Interaction Turn ${turn.id} does not belong to Run ${envelope.command.runId}.`,
          );
        }
        const cancelled =
          interaction.requestInteractionTurnCancellationInTransaction(turn.id);
        if (cancelled.status !== "cancelled") {
          dispatch = () => {
            void interaction.dispatchInteractionTurnCancellation(turn.id);
          };
        }
      } else if (envelope.command.type === "run.governed-intervention") {
        const command = envelope.command;
        runId = command.runId;
        if (envelope.expectedRevision === undefined) {
          throw new CompanyCommandError(
            "EXPECTED_REVISION_REQUIRED",
            "run.governed-intervention requires the Department Run revision.",
          );
        }
        const activeAttempt = pipelineRuntime
          .inspectRun(command.runId)
          .nodes.find((node) => node.id === command.nodeRunId)
          ?.attempts.at(-1);
        pipelineRuntime.applyGovernedIntervention({
          ...command,
          expectedRevision: envelope.expectedRevision,
          actorId: envelope.actor.id,
        });
        if (
          activeAttempt &&
          ["running", "reconciling"].includes(activeAttempt.status)
        ) {
          dispatch = () => {
            void pipelineRuntime.dispatchNodeAttemptCancellation(
              activeAttempt.id,
            );
          };
        }
      } else {
        throw new CompanyCommandError(
          "COMMAND_UNSUPPORTED",
          `Command ${envelope.command.type} is not a Run Supervision command.`,
        );
      }
      result = {
        status: "succeeded",
        value: RunSupervisionViewSchema.parse(supervision.inspect(runId)),
        effectIds: (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id),
      };
      database.exec("RELEASE supervision_command");
    } catch (error) {
      const rejection = deterministicError(error);
      if (!rejection) throw error;
      database.exec("ROLLBACK TO supervision_command");
      database.exec("RELEASE supervision_command");
      result = { status: "rejected", error: rejection, effectIds: [] };
    }
    const resultJson = canonicalJson(result);
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    dispatch?.();
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Receipt replay may already have committed the transaction.
    }
    throw error;
  }
};

const executeWorkPackageCommand = (
  database: DatabaseSync,
  workPackageRuntime: WorkPackageRuntime,
  envelope: CommandEnvelope<WorkPackageEnvelopeCommand>,
  clock: () => Date,
): CommandResult<WorkPackageGraphView> => {
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy, consumer_id AS consumerId,
                schema_version AS schemaVersion, request_hash AS requestHash,
                result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) {
        return commandIdReuse(
          envelope.commandId,
        ) as CommandResult<WorkPackageGraphView>;
      }
      return CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<WorkPackageGraphView>;
    }

    let result: CommandResult<WorkPackageGraphView>;
    if (envelope.expectedRevision === undefined) {
      result = {
        status: "rejected",
        error: {
          code: "EXPECTED_REVISION_REQUIRED",
          message: `${envelope.command.type} requires an expected aggregate revision.`,
        },
        effectIds: [],
      };
    } else {
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.commandId,
          envelope.actor.type,
          envelope.actor.id,
          envelope.actor.authenticatedBy,
          envelope.consumerId ?? null,
          envelope.schemaVersion,
        );
      try {
        const shared = {
          commandId: envelope.commandId,
          actor: envelope.actor,
          expectedRevision: envelope.expectedRevision,
        };
        const command = envelope.command;
        const value =
          command.type === "work-package.generate"
            ? workPackageRuntime.generateInTransaction({
                ...shared,
                ...command,
              })
            : command.type === "work-package.version"
              ? workPackageRuntime.versionInTransaction({
                  ...shared,
                  ...command,
                })
              : command.type === "work-package.assign"
                ? workPackageRuntime.assignInTransaction({
                    ...shared,
                    ...command,
                  })
                : command.type === "work-package.start"
                  ? workPackageRuntime.startInTransaction({
                      ...shared,
                      ...command,
                    })
                  : command.type === "work-package.rework"
                    ? workPackageRuntime.reworkInTransaction({
                        ...shared,
                        ...command,
                      })
                    : workPackageRuntime.recordSelfCheckInTransaction({
                        ...shared,
                        ...command,
                      });
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = {
          status: "succeeded",
          value: WorkPackageGraphViewSchema.parse(value),
          effectIds,
        };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    const resultJson = canonicalJson(result);
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
        requestHash,
        resultJson,
        sha256(resultJson),
        canonicalJson(result.effectIds),
        clock().toISOString(),
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  }
};

const executeDeliveryQualityCommand = (
  database: DatabaseSync,
  candidateInputs: CandidateInputRuntime,
  qualityGates: QualityGateRuntime,
  envelope: CommandEnvelope<DeliveryQualityEnvelopeCommand>,
  clock: () => Date,
): CommandResult<unknown> => {
  const criticalEscalation =
    envelope.command.type === "quality-gate.critical-escalation.decide";
  const validRuntimeActor =
    envelope.actor.type === "runtime-worker" &&
    envelope.actor.authenticatedBy === "runtime";
  const validHumanActor =
    envelope.actor.type === "human" &&
    envelope.actor.authenticatedBy === "local-session";
  const validActor = criticalEscalation ? validHumanActor : validRuntimeActor;
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const priorResult = CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<unknown>;
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) return commandIdReuse(envelope.commandId);
      return priorResult;
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<unknown>;
    database.exec("SAVEPOINT delivery_quality_command");
    if (!validActor) {
      database.exec("ROLLBACK TO delivery_quality_command");
      database.exec("RELEASE delivery_quality_command");
      result = {
        status: "rejected",
        error: {
          code: criticalEscalation
            ? "QUALITY_GATE_HUMAN_ESCALATION_ACTOR_INVALID"
            : "DELIVERY_QUALITY_ACTOR_INVALID",
          message: criticalEscalation
            ? "Critical-risk escalation requires actor {type:'human', authenticatedBy:'local-session'}."
            : "Delivery Candidate Input and Quality Gate Commands require actor {type:'runtime-worker', authenticatedBy:'runtime'}.",
        },
        effectIds: [],
      };
    } else
      try {
        const command = envelope.command;
        const value =
          command.type === "quality-gate.critical-escalation.decide"
            ? CriticalRiskEscalationDecisionSchema.parse(
                qualityGates.decideCriticalEscalation({
                  ...command,
                  actor: envelope.actor,
                }),
              )
            : command.type === "delivery.candidate-input.freeze"
              ? DeliveryCandidateInputViewSchema.parse(
                  candidateInputs.freeze({
                    candidateInputId: command.candidateInputId,
                    requestId: command.requestId,
                    projectId: command.projectId,
                    runId: command.runId,
                    snapshotRevisionId: command.snapshotRevisionId,
                    nodeRunId: command.nodeRunId,
                    nodeAttemptId: command.nodeAttemptId,
                    producer: command.producer,
                    requiredTestRunIds: command.requiredTestRunIds,
                    environment: command.environment,
                    evidencePolicy: command.evidencePolicy,
                  }),
                )
              : command.type === "quality-gate.input.prepare"
                ? CandidateGateInputViewSchema.parse(
                    qualityGates.prepare({
                      ...command,
                      actor: envelope.actor,
                    }),
                  )
                : command.type === "quality-gate.execution.accept"
                  ? CandidateGateExecutionViewSchema.parse(
                      qualityGates.acceptExecution({
                        executionId: command.executionId,
                        gateInputId: command.gateInputId,
                        operationKey: command.operationKey,
                        request: command.request,
                      }),
                    )
                  : command.type === "quality-gate.execution.reconcile"
                    ? CandidateGateExecutionViewSchema.parse(
                        qualityGates.reconcileExecution({
                          executionId: command.executionId,
                          observation:
                            "receiptHash" in command.observation
                              ? {
                                  state: command.observation.state,
                                  fact: command.observation.fact,
                                  receiptHash: command.observation.receiptHash,
                                }
                              : {
                                  state: command.observation.state,
                                },
                        }),
                      )
                    : command.type === "quality-gate.result.finalize"
                      ? CandidateGateResultViewSchema.parse(
                          qualityGates.finalize(command),
                        )
                      : DeliveryCandidateInputGateAuthoritySchema.parse(
                          qualityGates.authorize(command),
                        );
        database.exec("RELEASE delivery_quality_command");
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = { status: "succeeded", value, effectIds };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        database.exec("ROLLBACK TO delivery_quality_command");
        database.exec("RELEASE delivery_quality_command");
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    const resultJson = canonicalJson(result);
    if (validActor) {
      database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          envelope.commandId,
          envelope.actor.type,
          envelope.actor.id,
          envelope.actor.authenticatedBy,
          envelope.consumerId ?? null,
          envelope.schemaVersion,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(result.effectIds),
          clock().toISOString(),
        );
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const executeDeliveryCommand = (
  database: DatabaseSync,
  delivery: DeliveryRuntime,
  envelope: CommandEnvelope<DeliveryEnvelopeCommand>,
  clock: () => Date,
): CommandResult<unknown> => {
  const assemble = envelope.command.type === "delivery.candidate.assemble";
  const validActor = assemble
    ? envelope.actor.type === "runtime-worker" &&
      envelope.actor.authenticatedBy === "runtime" &&
      envelope.command.type === "delivery.candidate.assemble" &&
      envelope.command.workerId === envelope.actor.id
    : envelope.actor.type === "human" &&
      envelope.actor.authenticatedBy === "local-session";
  const requestHash = sha256(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      actor: envelope.actor,
      consumerId: envelope.consumerId ?? null,
      expectedRevision: envelope.expectedRevision ?? null,
      command: envelope.command,
    }),
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy,
                consumer_id AS consumerId, schema_version AS schemaVersion,
                request_hash AS requestHash, result_json AS resultJson
           FROM command_deduplication WHERE command_id = ?`,
      )
      .get(envelope.commandId) as
      | {
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
          readonly schemaVersion: number;
          readonly requestHash: string;
          readonly resultJson: string;
        }
      | undefined;
    if (receipt) {
      const priorResult = CommandResultSchema.parse(
        JSON.parse(receipt.resultJson),
      ) as CommandResult<unknown>;
      const sameRequest =
        receipt.actorType === envelope.actor.type &&
        receipt.actorId === envelope.actor.id &&
        receipt.authenticatedBy === envelope.actor.authenticatedBy &&
        receipt.consumerId === (envelope.consumerId ?? null) &&
        receipt.schemaVersion === envelope.schemaVersion &&
        receipt.requestHash === requestHash;
      database.exec("COMMIT");
      if (!sameRequest) return commandIdReuse(envelope.commandId);
      return priorResult;
    }
    database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.actor.type,
        envelope.actor.id,
        envelope.actor.authenticatedBy,
        envelope.consumerId ?? null,
        envelope.schemaVersion,
      );
    let result: CommandResult<unknown>;
    database.exec("SAVEPOINT delivery_command");
    if (!validActor) {
      database.exec("ROLLBACK TO delivery_command");
      database.exec("RELEASE delivery_command");
      result = {
        status: "rejected",
        error: {
          code: assemble
            ? "DELIVERY_CANDIDATE_ACTOR_INVALID"
            : "RELEASE_DECISION_ACTOR_INVALID",
          message: assemble
            ? "Delivery Candidate assembly requires a trusted Runtime worker."
            : "Human release requires a verified local-session human.",
        },
        effectIds: [],
      };
    } else {
      try {
        const command = envelope.command;
        const value = DeliveryCandidateViewSchema.parse(
          command.type === "delivery.candidate.assemble"
            ? delivery.assemble(command)
            : command.type === "delivery.release.decide"
              ? delivery.decide({ ...command, actor: envelope.actor })
              : delivery.recover({ ...command, actor: envelope.actor }),
        );
        database.exec("RELEASE delivery_command");
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(envelope.commandId) as Array<{ readonly id: string }>
        ).map((row) => row.id);
        result = { status: "succeeded", value, effectIds };
      } catch (error) {
        const rejection = deterministicError(error);
        if (!rejection) throw error;
        database.exec("ROLLBACK TO delivery_command");
        database.exec("RELEASE delivery_command");
        result = { status: "rejected", error: rejection, effectIds: [] };
      }
    }
    database
      .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
      .run();
    const resultJson = canonicalJson(result);
    if (validActor) {
      database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          envelope.commandId,
          envelope.actor.type,
          envelope.actor.id,
          envelope.actor.authenticatedBy,
          envelope.consumerId ?? null,
          envelope.schemaVersion,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(result.effectIds),
          clock().toISOString(),
        );
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const openCompanyCommandRegistry = (
  database: DatabaseSync,
  projectConfiguration: ProjectConfiguration,
  artifactRegistryOrClock?: ArtifactRegistry | (() => Date),
  clock: () => Date = () => new Date(),
  productRuntime?: ProductRuntime,
  failureInjection?: (point: ProductConfirmationFailurePoint) => void,
  interaction?: RuntimeInteraction,
  pipelineRuntime?: PipelineRuntime,
  supervision?: RuntimeSupervision,
  reviewRuntime?: ReviewRuntime,
  productReviewRuntime?: ProductReviewRuntime,
  promotionFailure?: (point: ProductGatePromotionFailurePoint) => void,
  technicalReviewRuntime?: TechnicalReviewRuntime,
  technicalPromotionFailure?: (
    point: TechnicalGatePromotionFailurePoint,
  ) => void,
  workspaceRuntime?: WorkspaceRuntime,
  memory?: RuntimeMemory,
  memoryFailure?: (point: MemoryCommandFailurePoint) => void,
  workPackageRuntime?: WorkPackageRuntime,
  codeReviewRuntime?: CodeReviewRuntime,
  integrationRuntime?: IntegrationRuntime,
  testRuntime?: TestRuntime,
  candidateInputs?: CandidateInputRuntime,
  qualityGates?: QualityGateRuntime,
  delivery?: DeliveryRuntime,
): CompanyCommandRegistry => ({
  execute: ((input: CommandEnvelope<EnvelopeCommand>) => {
    const envelope = CommandEnvelopeSchema.parse(
      input,
    ) as CommandEnvelope<EnvelopeCommand>;
    if (
      envelope.command.type === "delivery.candidate.assemble" ||
      envelope.command.type === "delivery.release.decide" ||
      envelope.command.type === "delivery.release.recover"
    ) {
      if (!delivery) {
        throw new CompanyCommandError(
          "DELIVERY_RUNTIME_UNAVAILABLE",
          "Delivery Runtime is unavailable for this Command Registry.",
        );
      }
      return executeDeliveryCommand(
        database,
        delivery,
        envelope as CommandEnvelope<DeliveryEnvelopeCommand>,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type.startsWith("delivery.candidate-input.") ||
      envelope.command.type.startsWith("quality-gate.")
    ) {
      if (!candidateInputs || !qualityGates) {
        throw new CompanyCommandError(
          "DELIVERY_QUALITY_RUNTIME_UNAVAILABLE",
          "Delivery Candidate Input and Quality Gate Runtimes are unavailable.",
        );
      }
      return executeDeliveryQualityCommand(
        database,
        candidateInputs,
        qualityGates,
        envelope as CommandEnvelope<DeliveryQualityEnvelopeCommand>,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("work-package.")) {
      if (!workPackageRuntime) {
        throw new CompanyCommandError(
          "WORK_PACKAGE_RUNTIME_UNAVAILABLE",
          "Work Package Runtime is unavailable for this Command Registry.",
        );
      }
      return executeWorkPackageCommand(
        database,
        workPackageRuntime,
        envelope as CommandEnvelope<WorkPackageEnvelopeCommand>,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("code-review.")) {
      if (!codeReviewRuntime) {
        throw new CompanyCommandError(
          "CODE_REVIEW_RUNTIME_UNAVAILABLE",
          "Code Review Runtime is unavailable for this Command Registry.",
        );
      }
      return executeCodeReviewCommand(
        database,
        codeReviewRuntime,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("integration.")) {
      if (!integrationRuntime) {
        throw new CompanyCommandError(
          "INTEGRATION_RUNTIME_UNAVAILABLE",
          "Integration Runtime is unavailable for this Command Registry.",
        );
      }
      return executeIntegrationCommand(
        database,
        integrationRuntime,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("test.")) {
      if (!testRuntime) {
        throw new CompanyCommandError(
          "TEST_RUNTIME_UNAVAILABLE",
          "Test Runtime is unavailable for this Command Registry.",
        );
      }
      return executeTestCommand(
        database,
        testRuntime,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type === "workspace-allocation.provision" ||
      envelope.command.type === "source-import.execute" ||
      envelope.command.type === "workspace-allocation.cleanup"
    ) {
      if (!workspaceRuntime) {
        throw new CompanyCommandError(
          "WORKSPACE_RUNTIME_UNAVAILABLE",
          "Workspace Runtime is unavailable for this Command Registry.",
        );
      }
      return executeWorkspaceCommand(
        database,
        workspaceRuntime,
        envelope as CommandEnvelope<WorkspaceEnvelopeCommand>,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type === "node-attempt.cancel" ||
      envelope.command.type === "interaction-turn.cancel" ||
      envelope.command.type === "run.governed-intervention"
    ) {
      if (!interaction || !pipelineRuntime || !supervision) {
        throw new CompanyCommandError(
          "RUN_SUPERVISION_RUNTIME_UNAVAILABLE",
          "Run Supervision Runtime is unavailable for this Command Registry.",
        );
      }
      return executeSupervisionCommand(
        database,
        pipelineRuntime,
        interaction,
        supervision,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("memory.")) {
      if (!memory) {
        throw new CompanyCommandError(
          "MEMORY_RUNTIME_UNAVAILABLE",
          "Memory Runtime is unavailable for this Command Registry.",
        );
      }
      return executeMemoryCommand(
        database,
        memory,
        envelope,
        clock,
        memoryFailure,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("review.")) {
      if (!reviewRuntime) {
        throw new CompanyCommandError(
          "REVIEW_RUNTIME_UNAVAILABLE",
          "Review Runtime is unavailable for this Command Registry.",
        );
      }
      return executeReviewCommand(
        database,
        reviewRuntime,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type.startsWith("artifact.version.")) {
      const artifactRegistry =
        typeof artifactRegistryOrClock === "function"
          ? undefined
          : artifactRegistryOrClock;
      if (!artifactRegistry) {
        throw new CompanyCommandError(
          "ARTIFACT_REGISTRY_UNAVAILABLE",
          "Artifact Registry is unavailable for this Command Registry.",
        );
      }
      return executeArtifactCommand(
        database,
        artifactRegistry,
        envelope,
        clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type === "application.register" ||
      envelope.command.type === "application-spec.revise" ||
      envelope.command.type === "technical-baseline-proposal.revise" ||
      envelope.command.type === "technical-review.start" ||
      envelope.command.type === "technical-gate.promote"
    ) {
      if (!technicalReviewRuntime) {
        throw new CompanyCommandError(
          "TECHNICAL_REVIEW_RUNTIME_UNAVAILABLE",
          "Technical Review Runtime is unavailable for this Command Registry.",
        );
      }
      return executeTechnicalReviewCommand(
        database,
        technicalReviewRuntime,
        envelope,
        clock,
        technicalPromotionFailure,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type === "project-spec.revise" ||
      envelope.command.type === "product-review.start" ||
      envelope.command.type === "product-readiness.record" ||
      envelope.command.type === "product-gate.promote"
    ) {
      if (!productReviewRuntime) {
        throw new CompanyCommandError(
          "PRODUCT_REVIEW_RUNTIME_UNAVAILABLE",
          "Product Review Runtime is unavailable for this Command Registry.",
        );
      }
      return executeProductReviewCommand(
        database,
        productReviewRuntime,
        envelope,
        clock,
        promotionFailure,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (
      envelope.command.type.startsWith("product.proposal.") ||
      envelope.command.type === "confirm-product-baseline" ||
      envelope.command.type === "fork-department-run"
    ) {
      if (!productRuntime) {
        throw new CompanyCommandError(
          "PRODUCT_RUNTIME_UNAVAILABLE",
          "Product Runtime is unavailable for this Command Registry.",
        );
      }
      return executeProductCommand(
        database,
        productRuntime,
        envelope,
        clock,
        failureInjection,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type === "interaction.prompt") {
      if (!interaction) {
        throw new CompanyCommandError(
          "INTERACTION_RUNTIME_UNAVAILABLE",
          "Interaction Runtime is unavailable for this Command Registry.",
        );
      }
      return executeInteractionPrompt(
        database,
        interaction,
        envelope,
        typeof artifactRegistryOrClock === "function"
          ? artifactRegistryOrClock
          : clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type === "interaction.turn.cancel") {
      if (!interaction) {
        throw new CompanyCommandError(
          "INTERACTION_RUNTIME_UNAVAILABLE",
          "Interaction Runtime is unavailable for Turn cancellation.",
        );
      }
      return executeInteractionTurnCancellation(
        database,
        interaction,
        envelope,
        typeof artifactRegistryOrClock === "function"
          ? artifactRegistryOrClock
          : clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type === "permission.decide") {
      if (!pipelineRuntime) {
        throw new CompanyCommandError(
          "PERMISSION_RUNTIME_UNAVAILABLE",
          "Pipeline Runtime is unavailable for Permission decisions.",
        );
      }
      return executePermissionDecision(
        database,
        pipelineRuntime,
        envelope,
        typeof artifactRegistryOrClock === "function"
          ? artifactRegistryOrClock
          : clock,
      ) as CommandResult<EnvelopeCommandResult<typeof envelope.command>>;
    }
    if (envelope.command.type !== "project.update") {
      throw new CompanyCommandError(
        "COMMAND_UNSUPPORTED",
        `Command ${envelope.command.type} is handled by another Runtime registry.`,
      );
    }
    const effectiveClock =
      typeof artifactRegistryOrClock === "function"
        ? artifactRegistryOrClock
        : clock;
    const definition = companyCommandDefinitions[envelope.command.type];
    const requestHash = sha256(
      canonicalJson({
        schemaVersion: envelope.schemaVersion,
        actor: envelope.actor,
        consumerId: envelope.consumerId ?? null,
        expectedRevision: envelope.expectedRevision ?? null,
        command: envelope.command,
      }),
    );

    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const receipt = database
        .prepare(
          `SELECT actor_type AS actorType,
                  actor_id AS actorId,
                  authenticated_by AS authenticatedBy,
                  consumer_id AS consumerId,
                  schema_version AS schemaVersion,
                  request_hash AS requestHash,
                  result_json AS resultJson
             FROM command_deduplication
            WHERE command_id = ?`,
        )
        .get(envelope.commandId) as
        | {
            readonly actorType: string;
            readonly actorId: string;
            readonly authenticatedBy: string;
            readonly consumerId: string | null;
            readonly schemaVersion: number;
            readonly requestHash: string;
            readonly resultJson: string;
          }
        | undefined;
      if (receipt) {
        const sameRequest =
          receipt.actorType === envelope.actor.type &&
          receipt.actorId === envelope.actor.id &&
          receipt.authenticatedBy === envelope.actor.authenticatedBy &&
          receipt.consumerId === (envelope.consumerId ?? null) &&
          receipt.schemaVersion === envelope.schemaVersion &&
          receipt.requestHash === requestHash;
        database.exec("COMMIT");
        if (!sameRequest) return commandIdReuse(envelope.commandId);
        return CommandResultSchema.parse(
          JSON.parse(receipt.resultJson),
        ) as CommandResult<ProjectEditorView>;
      }

      let result: CommandResult<ProjectEditorView>;
      if (envelope.expectedRevision === undefined) {
        result = {
          status: "rejected",
          error: {
            code: "EXPECTED_REVISION_REQUIRED",
            message: `${envelope.command.type} requires an expected ${definition.primaryAggregate} revision.`,
          },
          effectIds: [],
        };
      } else {
        database
          .prepare(
            `INSERT INTO runtime_unit_of_work_context(
               slot, command_id, actor_type, actor_id, authenticated_by,
               consumer_id, schema_version
             ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            envelope.commandId,
            envelope.actor.type,
            envelope.actor.id,
            envelope.actor.authenticatedBy,
            envelope.consumerId ?? null,
            envelope.schemaVersion,
          );
        try {
          const value = projectConfiguration.updateInTransaction({
            ...envelope.command,
            expectedRevision: envelope.expectedRevision,
          });
          const effectIds = (
            database
              .prepare(
                `SELECT id
                   FROM runtime_audit_records
                  WHERE command_id = ?
               ORDER BY created_at, id`,
              )
              .all(envelope.commandId) as Array<{ readonly id: string }>
          ).map((row) => row.id);
          result = {
            status: "succeeded",
            value: ProjectEditorViewSchema.parse(value),
            effectIds,
          };
        } catch (error) {
          const rejection = deterministicError(error);
          if (!rejection) throw error;
          result = { status: "rejected", error: rejection, effectIds: [] };
        }
      }

      const resultJson = canonicalJson(result);
      database
        .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
        .run();
      database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          envelope.commandId,
          envelope.actor.type,
          envelope.actor.id,
          envelope.actor.authenticatedBy,
          envelope.consumerId ?? null,
          envelope.schemaVersion,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(result.effectIds),
          effectiveClock().toISOString(),
        );
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (transactionStarted) database.exec("ROLLBACK");
      if (
        error instanceof Error &&
        (("errcode" in error && error.errcode === 5) ||
          /database (?:is )?(?:locked|busy)/i.test(error.message))
      ) {
        throw new CompanyCommandError(
          "STORE_BUSY",
          "Company database is busy; retry the same Command ID.",
        );
      }
      throw error;
    }
  }) as CompanyCommandRegistry["execute"],
});
