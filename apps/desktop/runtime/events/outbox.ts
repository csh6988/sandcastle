import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "../interface.js";
import {
  createRuntimeEventRegistry,
  type RuntimeEventRegistry,
  type RuntimeEventScope,
} from "./registry.js";

export interface RuntimeEventOutbox {
  readonly append: (input: {
    readonly type: string;
    readonly scope: RuntimeEventScope;
    readonly payload: unknown;
    readonly schemaVersion?: number;
    readonly eventId?: string;
    readonly timestamp?: string;
  }) => EventEnvelope;
  readonly readAfter: (
    sequence: number,
    limit: number,
  ) => readonly EventEnvelope[];
  readonly latestSequence: () => number;
  readonly earliestSequence: () => number | undefined;
}

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${description} is invalid JSON: ${String(error)}`);
  }
};

export const openRuntimeEventOutbox = (
  database: DatabaseSync,
  options: {
    readonly clock?: () => Date;
    readonly registry?: RuntimeEventRegistry;
  } = {},
): RuntimeEventOutbox => {
  const clock = options.clock ?? (() => new Date());
  const registry = options.registry ?? createRuntimeEventRegistry();

  const readAfter: RuntimeEventOutbox["readAfter"] = (sequence, limit) => {
    const rows = database
      .prepare(
        `SELECT sequence,
                event_id AS eventId,
                type,
                registry_version AS registryVersion,
                event_schema_version AS schemaVersion,
                company_id AS companyId,
                project_id AS projectId,
                run_id AS runId,
                node_run_id AS nodeRunId,
                scope_json AS scopeJson,
                payload_json AS payloadJson,
                created_at AS timestamp
           FROM runtime_event_outbox
          WHERE sequence > ?
          ORDER BY sequence
          LIMIT ?`,
      )
      .all(
        Math.max(0, Math.floor(sequence)),
        Math.min(1_000, Math.max(1, Math.floor(limit))),
      ) as Array<{
      readonly sequence: number;
      readonly eventId: string;
      readonly type: string;
      readonly registryVersion: number;
      readonly schemaVersion: number;
      readonly companyId: string;
      readonly projectId: string | null;
      readonly runId: string | null;
      readonly nodeRunId: string | null;
      readonly scopeJson: string | null;
      readonly payloadJson: string;
      readonly timestamp: string;
    }>;
    return rows.map((row) => {
      const storedScope =
        row.scopeJson === null
          ? {}
          : (parseJson(row.scopeJson, `Runtime event ${row.eventId} scope`) as
              | Record<string, unknown>
              | undefined);
      return {
        registryVersion: Number(row.registryVersion),
        schemaVersion: Number(row.schemaVersion),
        sequence: Number(row.sequence),
        eventId: row.eventId,
        type: row.type,
        companyId: row.companyId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.nodeRunId ? { nodeRunId: row.nodeRunId } : {}),
        ...(storedScope ?? {}),
        timestamp: row.timestamp,
        payload: parseJson(row.payloadJson, `Runtime event ${row.eventId}`),
      } as EventEnvelope;
    });
  };

  return {
    append: (input) => {
      const definition = registry.validate(input);
      const eventId = input.eventId ?? randomUUID();
      const timestamp = input.timestamp ?? clock().toISOString();
      const result = database
        .prepare(
          `INSERT INTO runtime_event_outbox(
             event_id, type, registry_version, event_schema_version,
             company_id, project_id, run_id, node_run_id, scope_json,
             payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          input.type,
          registry.version,
          input.schemaVersion ?? definition.schemaVersion,
          input.scope.companyId,
          input.scope.projectId ?? null,
          input.scope.runId ?? null,
          input.scope.nodeRunId ?? null,
          JSON.stringify(input.scope),
          JSON.stringify(input.payload),
          timestamp,
        );
      const sequence = Number(result.lastInsertRowid);
      return readAfter(sequence - 1, 1)[0]!;
    },
    readAfter,
    latestSequence: () => {
      const row = database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_event_outbox",
        )
        .get() as { readonly sequence: number };
      return Number(row.sequence);
    },
    earliestSequence: () => {
      const row = database
        .prepare("SELECT MIN(sequence) AS sequence FROM runtime_event_outbox")
        .get() as { readonly sequence: number | null };
      return row.sequence === null ? undefined : Number(row.sequence);
    },
  };
};
