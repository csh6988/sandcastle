import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CommandEnvelopeSchema,
  CommandResultSchema,
  ProjectEditorViewSchema,
  type CommandEnvelope,
  type CommandResult,
  type ProjectEditorView,
} from "./interface.js";
import {
  ProjectConfigurationError,
  type ProjectConfiguration,
} from "./project/projectConfiguration.js";

export interface CompanyCommandRegistry {
  readonly execute: (
    envelope: CommandEnvelope,
  ) => CommandResult<ProjectEditorView>;
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

export const companyCommandDefinitions = {
  "project.update": {
    primaryAggregate: "project",
    expectedRevisionRequired: true,
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

const commandIdReuse = (
  commandId: string,
): CommandResult<ProjectEditorView> => ({
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
  if (error instanceof ProjectConfigurationError) {
    return { code: error.code, message: error.message };
  }
  if (
    error instanceof Error &&
    /^Project .+ was not found\.$/.test(error.message)
  ) {
    return { code: "PROJECT_NOT_FOUND", message: error.message };
  }
  return undefined;
};

export const openCompanyCommandRegistry = (
  database: DatabaseSync,
  projectConfiguration: ProjectConfiguration,
  clock: () => Date = () => new Date(),
): CompanyCommandRegistry => ({
  execute: (input) => {
    const envelope = CommandEnvelopeSchema.parse(input) as CommandEnvelope;
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
  },
});
