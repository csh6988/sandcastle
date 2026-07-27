import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CommandEnvelopeSchema,
  CommandResultSchema,
  type AckRuntimeEventsEnvelopeCommand,
  type ActorRef,
  type CommandEnvelope,
  type CommandResult,
  type EventEnvelope,
  type QueryResult,
} from "../interface.js";
import {
  openRuntimeEventCursorStore,
  RuntimeEventCursorError,
  type RuntimeEventCursorStore,
  type RuntimeSubscriptionBatch,
  type RuntimeSubscriptionHandle,
} from "./cursor.js";
import { openRuntimeEventOutbox, type RuntimeEventOutbox } from "./outbox.js";
import type { RuntimeEventScope } from "./registry.js";

export interface RuntimeEvents {
  readonly append: RuntimeEventOutbox["append"];
  readonly latestSequence: RuntimeEventOutbox["latestSequence"];
  readonly earliestSequence: RuntimeEventOutbox["earliestSequence"];
  readonly openSubscription: RuntimeEventCursorStore["openSubscription"];
  readonly readSubscription: RuntimeEventCursorStore["readSubscription"];
  readonly closeSubscription: RuntimeEventCursorStore["closeSubscription"];
  readonly acknowledge: RuntimeEventCursorStore["acknowledge"];
  readonly acknowledgeInTransaction: RuntimeEventCursorStore["acknowledgeInTransaction"];
  readonly executeAck: (
    input: CommandEnvelope<AckRuntimeEventsEnvelopeCommand>,
    clock?: () => Date,
  ) => CommandResult<RuntimeEventAcknowledgement>;
  readonly querySnapshot: RuntimeEventCursorStore["querySnapshot"];
  readonly readAfter: (
    sequence: number,
    limit: number,
  ) => readonly EventEnvelope[];
}

export type {
  RuntimeEventScope,
  RuntimeSubscriptionBatch,
  RuntimeSubscriptionHandle,
  QueryResult,
};

export interface RuntimeEventAcknowledgement {
  readonly acknowledged: true;
  readonly subscriptionGeneration: number;
  readonly barrierSequence: number;
  readonly auditId: string;
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

const commandIdReuse = (
  commandId: string,
): CommandResult<RuntimeEventAcknowledgement> => ({
  status: "rejected",
  error: {
    code: "COMMAND_ID_REUSE",
    message: `Command ${commandId} was already used for a different request.`,
  },
  effectIds: [],
});

export const executeAckRuntimeEventsCommand = (
  database: DatabaseSync,
  events: RuntimeEvents,
  input: CommandEnvelope<AckRuntimeEventsEnvelopeCommand>,
  clock: () => Date = () => new Date(),
): CommandResult<RuntimeEventAcknowledgement> => {
  const envelope = CommandEnvelopeSchema.parse(
    input,
  ) as CommandEnvelope<AckRuntimeEventsEnvelopeCommand>;
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
      ) as CommandResult<RuntimeEventAcknowledgement>;
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

    let result: CommandResult<RuntimeEventAcknowledgement>;
    try {
      const value = events.acknowledgeInTransaction({
        consumerId: envelope.consumerId ?? "",
        principal: envelope.actor,
        sequence: envelope.command.sequence,
        subscriptionGeneration: envelope.command.subscriptionGeneration,
        viewSyncToken: envelope.command.viewSyncToken,
        commandId: envelope.commandId,
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
      result = { status: "succeeded", value, effectIds };
    } catch (error) {
      if (!(error instanceof RuntimeEventCursorError)) throw error;
      result = {
        status: "rejected",
        error: { code: error.code, message: error.message },
        effectIds: [],
      };
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
      throw new RuntimeEventCursorError(
        "STORE_BUSY",
        "Company database is busy; retry the same Command ID.",
      );
    }
    throw error;
  }
};

export const openRuntimeEvents = (
  database: DatabaseSync,
  options: {
    readonly clock?: () => Date;
    readonly tokenTtlMs?: number;
    readonly signingKey?: Buffer;
  } = {},
): RuntimeEvents => {
  const outbox = openRuntimeEventOutbox(database, options);
  const cursors = openRuntimeEventCursorStore(database, outbox, options);
  const events: RuntimeEvents = {
    append: outbox.append,
    latestSequence: outbox.latestSequence,
    earliestSequence: outbox.earliestSequence,
    readAfter: outbox.readAfter,
    openSubscription: cursors.openSubscription,
    readSubscription: cursors.readSubscription,
    closeSubscription: cursors.closeSubscription,
    acknowledge: cursors.acknowledge,
    acknowledgeInTransaction: cursors.acknowledgeInTransaction,
    executeAck: (input, clock) =>
      executeAckRuntimeEventsCommand(database, events, input, clock),
    querySnapshot: cursors.querySnapshot,
  };
  return events;
};
