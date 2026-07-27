import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalPipelineJson } from "../pipeline/canonicalPipeline.js";
import {
  type AdapterExecutionFact,
  type ExecutionFactEnvelope,
  type ExecutionFactReceipt,
  type ExecutionFactSinkOptions,
  type ExecutionInspection,
} from "./contract.js";

export class ExecutionFactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionFactError";
  }
}

export const executionFactHash = (fact: AdapterExecutionFact): string =>
  createHash("sha256").update(canonicalPipelineJson(fact)).digest("hex");

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ExecutionFactError(
      "EXECUTION_FACT_INVALID",
      `${description} is invalid JSON: ${String(error)}`,
    );
  }
};

const terminalKinds = new Set([
  "not-started",
  "completed",
  "failed",
  "cancelled",
]);

const validateFact = (fact: AdapterExecutionFact): void => {
  if (
    fact.adapterSchemaVersion !== 1 ||
    fact.schemaVersion !== 1 ||
    !fact.factId.trim() ||
    !Number.isInteger(fact.ordinal) ||
    fact.ordinal <= 0 ||
    !Array.isArray(fact.evidenceRefs) ||
    fact.evidenceRefs.some((ref) => typeof ref !== "string")
  ) {
    throw new ExecutionFactError(
      "EXECUTION_FACT_INVALID",
      "Execution Fact envelope fields are invalid.",
    );
  }
};

const readFact = (row: Record<string, unknown>): ExecutionFactEnvelope => ({
  id: String(row.id),
  operationKey: String(row.operationKey),
  target: {
    kind: row.targetKind as "node-attempt" | "interaction-turn",
    id: String(row.targetId),
  },
  leaseId: String(row.leaseId),
  leaseKind: row.leaseKind as "execution" | "reconciliation",
  executionEpoch: Number(row.executionEpoch),
  fenceToken: String(row.fenceToken),
  adapterSchemaVersion: Number(row.adapterSchemaVersion),
  factId: String(row.factId),
  ordinal: Number(row.ordinal),
  kind: row.kind as AdapterExecutionFact["kind"],
  schemaVersion: Number(row.schemaVersion),
  payload: parseJson(
    String(row.payloadJson),
    `Execution Fact ${String(row.id)} payload`,
  ),
  evidenceRefs: parseJson(
    String(row.evidenceRefsJson),
    `Execution Fact ${String(row.id)} evidence`,
  ) as string[],
  canonicalPayloadHash: String(row.canonicalPayloadHash),
  status: row.status as "accepted" | "duplicate" | "stale" | "conflict",
  effectIds: parseJson(
    String(row.effectIdsJson),
    `Execution Fact ${String(row.id)} effects`,
  ) as string[],
  createdAt: String(row.createdAt),
});

const factSelect = `
  SELECT id, operation_key AS operationKey, target_kind AS targetKind,
         target_id AS targetId,
         lease_id AS leaseId, lease_kind AS leaseKind,
         execution_epoch AS executionEpoch, fence_token AS fenceToken,
         adapter_schema_version AS adapterSchemaVersion, fact_id AS factId,
         ordinal, kind, schema_version AS schemaVersion,
         payload_json AS payloadJson, evidence_refs_json AS evidenceRefsJson,
         canonical_payload_hash AS canonicalPayloadHash, status,
         effect_ids_json AS effectIdsJson, created_at AS createdAt
    FROM execution_facts`;

export const createExecutionFactSink = (options: ExecutionFactSinkOptions) => ({
  record: async (fact: AdapterExecutionFact): Promise<ExecutionFactReceipt> => {
    validateFact(fact);
    if (fact.kind === "not-started") {
      const payload =
        typeof fact.payload === "object" &&
        fact.payload !== null &&
        !Array.isArray(fact.payload)
          ? (fact.payload as Record<string, unknown>)
          : undefined;
      if (
        options.lease.leaseKind !== "reconciliation" ||
        typeof payload?.providerReceipt !== "string" ||
        !payload.providerReceipt.trim() ||
        fact.evidenceRefs.length === 0 ||
        fact.evidenceRefs.some((ref) => !ref.trim())
      ) {
        throw new ExecutionFactError(
          "EXECUTION_FACT_INVALID",
          "A not-started Fact requires an active reconciliation Lease and Provider receipt evidence.",
        );
      }
    }
    const now = options.now().toISOString();
    const hash = executionFactHash(fact);
    databaseBegin(options.database);
    try {
      const byIdentity = options.database
        .prepare(
          `${factSelect}
             WHERE operation_key = ? AND fact_id = ?
          ORDER BY created_at, id
             LIMIT 1`,
        )
        .get(options.lease.operationKey, fact.factId) as
        | Record<string, unknown>
        | undefined;
      if (byIdentity) {
        const existing = readFact(byIdentity);
        if (existing.canonicalPayloadHash !== hash) {
          const conflict = appendDiagnostic(
            options,
            fact,
            hash,
            "conflict",
            now,
          );
          databaseCommit(options.database);
          throw new ExecutionFactError(
            "EXECUTION_FACT_CONFLICT",
            `Execution Fact ${fact.factId} conflicts with its original payload.`,
          );
        }
        databaseCommit(options.database);
        return {
          status: "duplicate",
          executionFactId: existing.id,
          effectIds: existing.effectIds,
          canonicalPayloadHash: hash,
        };
      }

      const byOrdinal = options.database
        .prepare(
          `${factSelect}
             WHERE operation_key = ? AND execution_epoch = ? AND ordinal = ?
          ORDER BY created_at, id
             LIMIT 1`,
        )
        .get(
          options.lease.operationKey,
          options.lease.executionEpoch,
          fact.ordinal,
        ) as Record<string, unknown> | undefined;
      if (byOrdinal) {
        const existing = readFact(byOrdinal);
        if (existing.canonicalPayloadHash !== hash) {
          appendDiagnostic(options, fact, hash, "conflict", now);
          databaseCommit(options.database);
          throw new ExecutionFactError(
            "EXECUTION_FACT_CONFLICT",
            `Execution Fact ordinal ${fact.ordinal} conflicts with its original payload.`,
          );
        }
        databaseCommit(options.database);
        return {
          status: "duplicate",
          executionFactId: existing.id,
          effectIds: existing.effectIds,
          canonicalPayloadHash: hash,
        };
      }

      if (terminalKinds.has(fact.kind)) {
        const existingTerminal = options.database
          .prepare(
            `${factSelect}
               WHERE operation_key = ? AND execution_epoch = ?
                 AND status = 'accepted'
                 AND kind IN ('not-started', 'completed', 'failed', 'cancelled')
            ORDER BY created_at, id
               LIMIT 1`,
          )
          .get(options.lease.operationKey, options.lease.executionEpoch) as
          | Record<string, unknown>
          | undefined;
        if (existingTerminal) {
          appendDiagnostic(options, fact, hash, "conflict", now);
          databaseCommit(options.database);
          throw new ExecutionFactError(
            "EXECUTION_FACT_CONFLICT",
            `Execution operation ${options.lease.operationKey} already has a terminal fact.`,
          );
        }
      }

      const activeLease = options.database
        .prepare(
          `SELECT id
             FROM execution_leases
            WHERE id = ? AND operation_key = ? AND target_kind = ?
              AND target_id = ?
              AND lease_kind = ? AND execution_epoch = ? AND fence_token = ?
              AND released_at IS NULL AND expires_at > ?`,
        )
        .get(
          options.lease.leaseId,
          options.lease.operationKey,
          options.target.kind,
          options.target.id,
          options.lease.leaseKind,
          options.lease.executionEpoch,
          options.lease.fenceToken,
          now,
        );
      if (!activeLease) {
        const stale = appendDiagnostic(options, fact, hash, "stale", now);
        databaseCommit(options.database);
        return {
          status: "stale",
          executionFactId: stale,
          effectIds: [],
          canonicalPayloadHash: hash,
        };
      }

      const id = randomUUID();
      options.database
        .prepare(
          `INSERT INTO execution_facts(
             id, operation_key, target_kind, target_id, lease_id, lease_kind,
             execution_epoch, fence_token, adapter_schema_version, fact_id,
             ordinal, kind, schema_version, payload_json, evidence_refs_json,
             canonical_payload_hash, status, effect_ids_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
        )
        .run(
          id,
          options.lease.operationKey,
          options.target.kind,
          options.target.id,
          options.lease.leaseId,
          options.lease.leaseKind,
          options.lease.executionEpoch,
          options.lease.fenceToken,
          fact.adapterSchemaVersion,
          fact.factId,
          fact.ordinal,
          fact.kind,
          fact.schemaVersion,
          JSON.stringify(fact.payload),
          JSON.stringify(fact.evidenceRefs),
          hash,
          JSON.stringify([]),
          now,
        );
      const envelope: ExecutionFactEnvelope = {
        id,
        ...fact,
        operationKey: options.lease.operationKey,
        target: options.target,
        leaseId: options.lease.leaseId,
        leaseKind: options.lease.leaseKind,
        executionEpoch: options.lease.executionEpoch,
        fenceToken: options.lease.fenceToken,
        canonicalPayloadHash: hash,
        status: "accepted",
        effectIds: [],
        createdAt: now,
      };
      const effectIds =
        options.applyAcceptedFact?.({
          fact,
          envelope,
          now,
        }) ?? [];
      options.database
        .prepare("UPDATE execution_facts SET effect_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(effectIds), id);
      options.appendEvent?.({
        type: "execution.fact.accepted",
        payload: {
          operationKey: options.lease.operationKey,
          executionFactId: id,
          factId: fact.factId,
          ordinal: fact.ordinal,
          kind: fact.kind,
          status: "accepted",
        },
        timestamp: now,
      });
      databaseCommit(options.database);
      return {
        status: "accepted",
        executionFactId: id,
        effectIds,
        canonicalPayloadHash: hash,
      };
    } catch (error) {
      databaseRollback(options.database);
      throw error;
    }
  },
});

const appendDiagnostic = (
  options: ExecutionFactSinkOptions,
  fact: AdapterExecutionFact,
  hash: string,
  status: "stale" | "conflict",
  now: string,
): string => {
  const id = randomUUID();
  options.database
    .prepare(
      `INSERT INTO execution_facts(
         id, operation_key, target_kind, target_id, lease_id, lease_kind,
         execution_epoch, fence_token, adapter_schema_version, fact_id,
         ordinal, kind, schema_version, payload_json, evidence_refs_json,
         canonical_payload_hash, status, effect_ids_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    )
    .run(
      id,
      options.lease.operationKey,
      options.target.kind,
      options.target.id,
      options.lease.leaseId,
      options.lease.leaseKind,
      options.lease.executionEpoch,
      options.lease.fenceToken,
      fact.adapterSchemaVersion,
      fact.factId,
      fact.ordinal,
      fact.kind,
      fact.schemaVersion,
      JSON.stringify(fact.payload),
      JSON.stringify(fact.evidenceRefs),
      hash,
      status,
      now,
    );
  options.appendEvent?.({
    type: `execution.fact.${status}`,
    payload: {
      operationKey: options.lease.operationKey,
      executionFactId: id,
      factId: fact.factId,
      ordinal: fact.ordinal,
      kind: fact.kind,
      status,
    },
    timestamp: now,
  });
  return id;
};

const databaseBegin = (database: DatabaseSync): void =>
  database.exec("BEGIN IMMEDIATE");
const databaseCommit = (database: DatabaseSync): void =>
  database.exec("COMMIT");
const databaseRollback = (database: DatabaseSync): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may already have been committed before an error escaped.
  }
};

export const inspectExecution = (
  database: DatabaseSync,
  input: { readonly operationKey: string },
): ExecutionInspection => {
  const leaseRows = database
    .prepare(
      `SELECT id AS leaseId, target_kind AS targetKind,
              target_id AS targetId, lease_kind AS leaseKind,
              execution_epoch AS executionEpoch, fence_token AS fenceToken,
              worker_id AS workerId, issued_at AS issuedAt,
              expires_at AS expiresAt, renewed_at AS renewedAt,
              released_at AS releasedAt, cancel_requested AS cancelRequested
         FROM execution_leases
        WHERE operation_key = ?
     ORDER BY execution_epoch, issued_at, id`,
    )
    .all(input.operationKey) as Array<Record<string, unknown>>;
  const factRows = database
    .prepare(
      `${factSelect}
         WHERE operation_key = ?
      ORDER BY ordinal,
               CASE status WHEN 'accepted' THEN 0 ELSE 1 END,
               created_at, id`,
    )
    .all(input.operationKey) as Array<Record<string, unknown>>;
  const first = factRows[0];
  const targetKind = (first?.targetKind ??
    (leaseRows[0] as Record<string, unknown> | undefined)?.targetKind ??
    "node-attempt") as "node-attempt" | "interaction-turn";
  const targetId = String(
    first?.targetId ??
      (leaseRows[0] as Record<string, unknown> | undefined)?.targetId ??
      "",
  );
  return {
    operationKey: input.operationKey,
    target: { kind: targetKind, id: targetId },
    terminalFactId:
      factRows
        .map(readFact)
        .find(
          (fact) => fact.status === "accepted" && terminalKinds.has(fact.kind),
        )?.id ?? null,
    leases: leaseRows.map((row) => ({
      leaseId: String(row.leaseId),
      leaseKind: row.leaseKind as "execution" | "reconciliation",
      executionEpoch: Number(row.executionEpoch),
      fenceToken: String(row.fenceToken),
      workerId: String(row.workerId),
      issuedAt: String(row.issuedAt),
      expiresAt: String(row.expiresAt),
      renewedAt: row.renewedAt === null ? null : String(row.renewedAt),
      releasedAt: row.releasedAt === null ? null : String(row.releasedAt),
      cancelRequested: Number(row.cancelRequested) === 1,
    })),
    facts: factRows.map(readFact),
  };
};
