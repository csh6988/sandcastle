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
  /**
   * The authority pairs are a discriminated union rather than two independent
   * unions so an invalid pairing (e.g. a human authenticated by "runtime") is
   * unrepresentable in the type system instead of being caught late by the
   * checkpoint CHECK constraint after the prune has already been staged.
   */
  readonly actor:
    | {
        readonly type: "human";
        readonly id: string;
        readonly authenticatedBy: "local-session";
      }
    | {
        readonly type: "runtime-worker";
        readonly id: string;
        readonly authenticatedBy: "runtime";
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
      // Locale-independent byte order so the integrity hash is reproducible
      // across hosts (localeCompare would make the ordering ICU-dependent).
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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

  // Compaction contract (T27 Phase B). Explicit, single-writer prune inside one
  // transaction; there is no background writer. Design decisions recorded here
  // so the behavior is unambiguous:
  //   - Selective by retention class: only non-durable events are deleted, so
  //     the retained log is intentionally NON-CONTIGUOUS (durable events remain
  //     at their original sequences with holes where non-durable events were).
  //     Live consumers advance an ack-gated cursor and never re-read below it,
  //     so they never observe a hole; the checkpoint records the prune for audit.
  //   - compacted_from/through_sequence are the min/max sequences of the DELETED
  //     rows — a span that may still enclose retained durable events — not a
  //     solid deleted interval. compacted_event_count is the authoritative count
  //     of what was removed.
  //   - pre_compaction_integrity_hash proves WHICH events (sequence, eventId,
  //     type) were present immediately before the prune. It deliberately omits
  //     payload: the durable business facts (and their content) are retained in
  //     the outbox and their own append-only fact tables, so the checkpoint only
  //     needs to attest the identity of the compacted non-durable slice.
  //   - Not idempotent: each invocation prunes whatever is currently eligible.
  //     command_id is UNIQUE to prevent duplicate checkpoint identity, not to
  //     dedupe user retries (a repeat simply compacts the next eligible slice,
  //     or nothing). A no-op prune writes no checkpoint by design — there is
  //     nothing removed to attribute.
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
        // `.all()` is typed as Record<string, SQLOutputValue>[]; the double cast
        // is required because the strict desktop tsconfig rejects a direct
        // structural assertion over that index signature.
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
