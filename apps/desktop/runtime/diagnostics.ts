import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

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

export interface RuntimeDiagnostics {
  readonly inspect: () => RuntimeDiagnosticsView;
  readonly compactRuntimeEvents: (input: { readonly retainLast: number }) => {
    readonly deleted: number;
    readonly retained: number;
  };
  readonly exportRedacted: () => RuntimeDiagnosticsView;
}

export const openRuntimeDiagnostics = (
  database: DatabaseSync,
  databasePath: string,
): RuntimeDiagnostics => {
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

  const compactRuntimeEvents = (input: {
    readonly retainLast: number;
  }): { readonly deleted: number; readonly retained: number } => {
    const retainLast = Math.max(0, Math.floor(input.retainLast));
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
    const result = database
      .prepare("DELETE FROM runtime_event_outbox WHERE sequence <= ?")
      .run(cutoff);
    return {
      deleted: Number(result.changes),
      retained: count("SELECT COUNT(*) AS count FROM runtime_event_outbox"),
    };
  };

  return {
    inspect,
    compactRuntimeEvents,
    exportRedacted: inspect,
  };
};
