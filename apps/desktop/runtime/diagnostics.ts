import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createRuntimeEventRegistry,
  type RuntimeEventRegistry,
} from "./events/registry.js";

export interface RuntimeDiagnosticsView {
  readonly schemaVersion: number;
  readonly sqliteIntegrity: string;
  readonly databaseBytes: number;
  readonly runtimeEventCount: number;
  readonly pendingRuntimeEventCount: number;
  readonly auditRecordCount: number;
  readonly activeLeaseCount: number;
  readonly cursorCount: number;
}

/**
 * Authority for a runtime-event compaction. Compaction is a single-writer,
 * explicitly-triggered Command; the authorizing actor and the triggering
 * Command id are recorded on the append-only checkpoint so every prune has a
 * durable, attributable proof. Authority is Runtime-injected (derived from the
 * authenticated principal) rather than carried on the Command envelope.
 */
export interface RuntimeCompactionAuthority {
  readonly actor: {
    readonly type: "human" | "runtime-worker";
    readonly id: string;
    readonly authenticatedBy: "local-session" | "runtime";
  };
  readonly commandId: string;
}

export interface RuntimeDiagnostics {
  readonly inspect: () => RuntimeDiagnosticsView;
  readonly compactRuntimeEvents: (
    input: { readonly retainLast: number } & RuntimeCompactionAuthority,
  ) => {
    readonly deleted: number;
    readonly retained: number;
  };
  readonly exportRedacted: () => RuntimeDiagnosticsView;
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

const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

export const openRuntimeDiagnostics = (
  database: DatabaseSync,
  databasePath: string,
  options: {
    readonly registry?: RuntimeEventRegistry;
    readonly clock?: () => Date;
  } = {},
): RuntimeDiagnostics => {
  const registry = options.registry ?? createRuntimeEventRegistry();
  const clock = options.clock ?? (() => new Date());
  const schemaVersion = (): number => {
    const row = database
      .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
      .get() as { readonly value: string };
    return Number(row.value);
  };
  const count = (sql: string): number => {
    const row = database.prepare(sql).get() as { readonly count: number };
    return Number(row.count);
  };
  const inspect = (): RuntimeDiagnosticsView => {
    const integrity = database.prepare("PRAGMA quick_check").get() as {
      readonly quick_check: string;
    };
    return {
      schemaVersion: schemaVersion(),
      sqliteIntegrity: integrity.quick_check,
      databaseBytes: statSync(databasePath).size,
      runtimeEventCount: count(
        "SELECT COUNT(*) AS count FROM runtime_event_outbox",
      ),
      pendingRuntimeEventCount: count(
        "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE delivered_at IS NULL",
      ),
      auditRecordCount: count(
        "SELECT COUNT(*) AS count FROM runtime_audit_records",
      ),
      activeLeaseCount: count(
        "SELECT COUNT(*) AS count FROM node_attempts WHERE status = 'running' AND lease_expires_at > datetime('now')",
      ),
      cursorCount: count("SELECT COUNT(*) AS count FROM runtime_event_cursors"),
    };
  };

  // Only non-durable runtime events (transient/standard) are eligible for
  // compaction; durable business facts are retained regardless of consumer
  // acknowledgement. The eligible-type set is derived from the registry so the
  // retention class stays the single source of truth.
  const compactableTypes = (): readonly string[] =>
    registry
      .list()
      .filter((definition) => definition.retentionClass !== "durable")
      .map((definition) => definition.type);

  const compactRuntimeEvents: RuntimeDiagnostics["compactRuntimeEvents"] = (
    input,
  ) => {
    const retainLast = Math.max(0, Math.floor(input.retainLast));
    const eligibleTypes = compactableTypes();
    const retained = (): number =>
      count("SELECT COUNT(*) AS count FROM runtime_event_outbox");

    if (eligibleTypes.length === 0) {
      return { deleted: 0, retained: retained() };
    }

    const placeholders = eligibleTypes.map(() => "?").join(", ");
    database.exec("BEGIN IMMEDIATE");
    try {
      // Ack gate: never prune past the slowest acknowledged consumer cursor.
      // With no cursors the watermark is 0, so nothing is eligible yet.
      const lastAcknowledged = database
        .prepare(
          "SELECT COALESCE(MIN(sequence), 0) AS sequence FROM runtime_event_cursors",
        )
        .get() as { readonly sequence: number };
      const maxSequence = database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_event_outbox",
        )
        .get() as { readonly sequence: number };
      const cutoff = Math.min(
        Number(lastAcknowledged.sequence),
        Math.max(0, Number(maxSequence.sequence) - retainLast),
      );

      const doomed = database
        .prepare(
          `SELECT sequence, event_id AS eventId, type
             FROM runtime_event_outbox
            WHERE sequence <= ?
              AND type IN (${placeholders})
            ORDER BY sequence`,
        )
        .all(cutoff, ...eligibleTypes) as unknown as ReadonlyArray<{
        readonly sequence: number;
        readonly eventId: string;
        readonly type: string;
      }>;

      if (doomed.length === 0) {
        database.exec("COMMIT");
        return { deleted: 0, retained: retained() };
      }

      const preCompactionIntegrityHash = sha256(
        doomed.map((row) => ({
          sequence: Number(row.sequence),
          eventId: row.eventId,
          type: row.type,
        })),
      );
      const fromSequence = Number(doomed[0]!.sequence);
      const throughSequence = Number(doomed.at(-1)!.sequence);

      const result = database
        .prepare(
          `DELETE FROM runtime_event_outbox
            WHERE sequence <= ?
              AND type IN (${placeholders})`,
        )
        .run(cutoff, ...eligibleTypes);

      database
        .prepare(
          `INSERT INTO runtime_event_compaction_checkpoints(
             id, compacted_from_sequence, compacted_through_sequence,
             retained_watermark_sequence, pre_compaction_integrity_hash,
             compacted_event_count, authorized_by_actor_type,
             authorized_by_actor_id, authorized_by_authenticated_by,
             command_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          fromSequence,
          throughSequence,
          cutoff,
          preCompactionIntegrityHash,
          Number(result.changes),
          input.actor.type,
          input.actor.id,
          input.actor.authenticatedBy,
          input.commandId,
          clock().toISOString(),
        );

      database.exec("COMMIT");
      return { deleted: Number(result.changes), retained: retained() };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    inspect,
    compactRuntimeEvents,
    exportRedacted: inspect,
  };
};
