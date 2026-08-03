import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AcceptedDeliveryCandidateAuthoritySnapshotSchema,
  ReleaseOperationCreateRequestSchema,
  ReleaseOperationReconcileRequestSchema,
  ReleaseOperationViewSchema,
  type AcceptedDeliveryCandidateAuthoritySnapshot,
  type ReleaseOperationCreateCommandInput,
  type ReleaseOperationCreateRequest,
  type ReleaseOperationEffectAdapter,
  type ReleaseOperationEffectRequest,
  type ReleaseOperationItemFinalize,
  type ReleaseOperationReconcileObservation,
  type ReleaseOperationReconcileRequest,
  type ReleaseOperationView,
} from "./releaseOperationContracts.js";

type ArtifactMetadata = {
  readonly contentKind: "managed-file" | "repository-object" | "external-reference";
  readonly integrityStatus: "verified" | "unavailable" | "failed";
  readonly digest: string;
};

export interface ReleaseOperationArtifactReader {
  readonly metadata: (artifactVersionId: string) => ArtifactMetadata;
  /** Kept as an explicit seam for export adapters that must read the artifact. */
  readonly read?: (artifactVersionId: string) => Uint8Array;
}

export interface ReleaseOperationAuditEvent {
  readonly operationId: string;
  readonly candidateId: string;
  readonly aggregateState: ReleaseOperationView["aggregateState"];
  readonly acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshot;
}

export interface ReleaseOperationRuntimeOptions {
  readonly acceptedAuthority: (
    candidateId: string,
  ) => AcceptedDeliveryCandidateAuthoritySnapshot;
  readonly artifacts: ReleaseOperationArtifactReader;
  readonly adapter: ReleaseOperationEffectAdapter;
  readonly clock?: () => Date;
  readonly id?: () => string;
  /** This is called inside the state transaction, so an outbox/audit bridge is atomic. */
  readonly invalidate?: (event: ReleaseOperationAuditEvent) => void;
  /** Test-only crash point; production wiring leaves it unset. */
  readonly failureInjection?: (point: "after-intent" | "after-effect-before-finalize") => void;
}

export interface ReleaseOperationRuntime {
  readonly create: (
    input: ReleaseOperationCreateRequest | ReleaseOperationCreateCommandInput,
    actor: { readonly type: "human"; readonly id: string; readonly authenticatedBy: "local-session" },
  ) => ReleaseOperationView;
  readonly inspect: (operationId: string) => ReleaseOperationView;
  readonly list: (candidateId: string) => readonly ReleaseOperationView[];
  readonly dispatch: (operationId: string) => Promise<ReleaseOperationView>;
  readonly reconcile: (
    input: Omit<ReleaseOperationReconcileRequest, "actor">,
    actor: { readonly type: "human"; readonly id: string; readonly authenticatedBy: "local-session" },
  ) => Promise<ReleaseOperationView>;
  readonly requestReconciliation: (
    input: Omit<ReleaseOperationReconcileRequest, "actor">,
    actor: { readonly type: "human"; readonly id: string; readonly authenticatedBy: "local-session" },
  ) => ReleaseOperationView;
  readonly reconcilePending: () => Promise<readonly ReleaseOperationView[]>;
  readonly prepareForShutdown: () => Promise<void>;
}

export class ReleaseOperationRuntimeError extends Error {
  constructor(
    readonly code:
      | "RELEASE_OPERATION_NOT_FOUND"
      | "RELEASE_OPERATION_ID_REUSE"
      | "RELEASE_AUTHORITY_CONFLICT"
      | "RELEASE_ARTIFACT_NOT_AUTHORIZED"
      | "RELEASE_ARTIFACT_UNREADABLE"
      | "RELEASE_DESTINATION_CONFLICT"
      | "RELEASE_OPERATION_BLOCKED"
      | "RELEASE_RECONCILIATION_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseOperationRuntimeError";
  }
}

type IntentRecord = {
  readonly request: ReleaseOperationCreateRequest;
  readonly acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshot;
};

type ItemRow = {
  readonly databaseId: string;
  readonly itemKey: string;
  readonly requestJson: string;
  readonly state: string;
  readonly receiptJson: string | null;
  readonly evidenceJson: string;
  readonly updatedAt: string;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const parseJson = <Value>(value: string, label: string): Value => {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new ReleaseOperationRuntimeError("RELEASE_OPERATION_BLOCKED", `${label} is invalid persisted JSON: ${String(error)}`);
  }
};

const bounded = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") {
    const redacted = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted]");
    return redacted.length > 1_000 ? `${redacted.slice(0, 1_000)}…[truncated]` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => bounded(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, item]) => [key, bounded(item, depth + 1)]));
  }
  return value;
};

export const openReleaseOperationRuntime = (
  database: DatabaseSync,
  options: ReleaseOperationRuntimeOptions,
): ReleaseOperationRuntime => {
  const now = (): string => (options.clock?.() ?? new Date()).toISOString();
  const nextId = options.id ?? randomUUID;
  const active = new Map<string, Promise<ReleaseOperationView>>();
  let stopping = false;
  let savepointSequence = 0;

  const transaction = <Value>(work: () => Value): Value => {
    const savepoint = `release_operation_${++savepointSequence}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = work();
      database.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      try {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
      } catch {
        // The outer transaction owner is responsible for its final rollback.
      }
      throw error;
    }
  };

  const destinationKeyFor = (request: ReleaseOperationCreateRequest, item: ReleaseOperationCreateRequest["items"][number]): string =>
    request.kind === "merge"
      ? `merge:${(item as Extract<typeof item, { repositoryReference: string }>).repositoryReference}:${(item as Extract<typeof item, { destination: { targetBranch: string } }>).destination.targetBranch}`
      : `export:${(item as Extract<typeof item, { destination: { canonicalRoot: string; relativePath: string } }>).destination.canonicalRoot}/${(item as Extract<typeof item, { destination: { relativePath: string } }>).destination.relativePath}`;

  const itemEffect = (view: ReleaseOperationView, item: ReleaseOperationCreateRequest["items"][number]): ReleaseOperationEffectRequest => {
    if (view.request.kind === "merge") {
      return { operationId: view.id, canonicalRequestHash: view.canonicalRequestHash, acceptedAuthority: view.acceptedAuthority, kind: "merge", item: item as Extract<typeof item, { repositoryReference: string }> };
    }
    const artifactId = (item as Extract<typeof item, { artifactVersionId: string }>).artifactVersionId;
    if (!view.acceptedAuthority.artifactVersionIds.includes(artifactId)) {
      throw new ReleaseOperationRuntimeError("RELEASE_ARTIFACT_NOT_AUTHORIZED", `Artifact ${artifactId} is not in the accepted Delivery candidate authority.`);
    }
    const metadata = options.artifacts.metadata(artifactId);
    if ((metadata.contentKind !== "managed-file" && metadata.contentKind !== "repository-object") || metadata.integrityStatus !== "verified" || !/^[a-f0-9]{64}$/.test(metadata.digest)) {
      throw new ReleaseOperationRuntimeError("RELEASE_ARTIFACT_UNREADABLE", `Artifact ${artifactId} is not a verified exportable artifact.`);
    }
    return { operationId: view.id, canonicalRequestHash: view.canonicalRequestHash, acceptedAuthority: view.acceptedAuthority, kind: "export", item: item as Extract<typeof item, { artifactVersionId: string }>, artifact: { contentKind: metadata.contentKind, integrityStatus: "verified", digest: metadata.digest } };
  };

  const aggregateFor = (states: readonly string[]): ReleaseOperationView["aggregateState"] => {
    const counts = (state: string) => states.filter((candidate) => candidate === state).length;
    if (counts("unknown") > 0) return "blocked";
    if (counts("reconciling") > 0) return "reconciling";
    if (counts("running") > 0) return "running";
    if (counts("pending") > 0) return "pending";
    if (counts("succeeded") === states.length) return "succeeded";
    if (counts("succeeded") > 0) return "partially-succeeded";
    return "failed";
  };

  const updateAggregate = (operationId: string, changedAt: string): void => {
    const rows = database.prepare("SELECT state FROM release_operation_items WHERE operation_id = ? ORDER BY ordinal").all(operationId) as Array<{ readonly state: string }>;
    database.prepare("UPDATE release_operations SET aggregate_state = ?, updated_at = ? WHERE id = ?").run(aggregateFor(rows.map((row) => row.state)), changedAt, operationId);
  };

  const inspect = (operationId: string): ReleaseOperationView => {
    const row = database.prepare(
      `SELECT id, request_json AS requestJson, canonical_request_hash AS canonicalRequestHash,
              aggregate_state AS aggregateState, created_at AS createdAt, updated_at AS updatedAt
         FROM release_operations WHERE id = ?`,
    ).get(operationId) as { readonly id: string; readonly requestJson: string; readonly canonicalRequestHash: string; readonly aggregateState: string; readonly createdAt: string; readonly updatedAt: string } | undefined;
    if (!row) throw new ReleaseOperationRuntimeError("RELEASE_OPERATION_NOT_FOUND", `Release operation ${operationId} was not found.`);
    const intent = parseJson<IntentRecord>(row.requestJson, `Release operation ${operationId}`);
    const itemRows = database.prepare(
      `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state,
              receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
         FROM release_operation_items WHERE operation_id = ? ORDER BY ordinal, id`,
    ).all(operationId) as ItemRow[];
    const states = itemRows.map((item) => item.state);
    const counts = Object.fromEntries(["pending", "running", "reconciling", "succeeded", "failed", "destination-conflict", "unknown"].map((state) => [state === "destination-conflict" ? "destinationConflict" : state, states.filter((value) => value === state).length])) as ReleaseOperationView["counts"];
    const aggregateState = aggregateFor(states);
    const nextActions: ReleaseOperationView["nextActions"] = [];
    if (states.some((state) => state === "unknown" || state === "reconciling")) nextActions.push("reconcile");
    if (states.some((state) => state === "failed" || state === "destination-conflict")) nextActions.push("create-new-operation");
    return ReleaseOperationViewSchema.parse({
      id: row.id,
      request: intent.request,
      acceptedAuthority: intent.acceptedAuthority,
      canonicalRequestHash: row.canonicalRequestHash,
      aggregateState,
      counts,
      nextActions,
      items: itemRows.map((item) => ({ ...parseJson<Record<string, unknown>>(item.requestJson, `Release item ${item.itemKey}`), state: item.state, receipt: item.receiptJson ? parseJson(item.receiptJson, `Release item receipt ${item.itemKey}`) : null, evidence: parseJson(item.evidenceJson, `Release item evidence ${item.itemKey}`), updatedAt: item.updatedAt })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  };

  const invalidate = (operationId: string): void => {
    const view = inspect(operationId);
    options.invalidate?.({
      operationId,
      candidateId: view.request.candidateId,
      aggregateState: view.aggregateState,
      acceptedAuthority: view.acceptedAuthority,
    });
  };

  const appendObservation = (input: { readonly operationId: string; readonly itemDatabaseId: string; readonly kind: "execution" | "receipt" | "failure" | "destination-conflict" | "unknown" | "reconcile"; readonly observation: unknown; readonly at: string }): void => {
    database.prepare(
      `INSERT INTO release_operation_item_observations(id, operation_id, item_id, kind, observation_json, observation_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nextId(), input.operationId, input.itemDatabaseId, input.kind, canonicalJson(bounded(input.observation)), digest(bounded(input.observation)), input.at);
  };

  const releaseClaim = (operationId: string, itemDatabaseId: string, at: string): void => {
    const claim = database.prepare("SELECT id FROM release_operation_destination_claims WHERE operation_id = ? AND item_id = ? AND is_active = 1").get(operationId, itemDatabaseId) as { readonly id: string } | undefined;
    if (!claim) return;
    database.prepare("UPDATE release_operation_destination_claims SET is_active = 0, released_at = ? WHERE id = ?").run(at, claim.id);
    database.prepare("INSERT INTO release_operation_destination_claim_events(id, claim_id, action, evidence_json, created_at) VALUES (?, ?, 'released', ?, ?)").run(nextId(), claim.id, canonicalJson({ reason: "terminal-state" }), at);
  };

  const acquireClaim = (operationId: string, itemDatabaseId: string, at: string): boolean => {
    const claim = database.prepare("SELECT id, is_active AS isActive FROM release_operation_destination_claims WHERE operation_id = ? AND item_id = ?").get(operationId, itemDatabaseId) as { readonly id: string; readonly isActive: number } | undefined;
    if (!claim || claim.isActive === 1) return Boolean(claim);
    try {
      database.prepare("UPDATE release_operation_destination_claims SET is_active = 1, released_at = NULL WHERE id = ?").run(claim.id);
      database.prepare("INSERT INTO release_operation_destination_claim_events(id, claim_id, action, evidence_json, created_at) VALUES (?, ?, 'acquired', ?, ?)").run(nextId(), claim.id, canonicalJson({ reason: "retry" }), at);
      return true;
    } catch {
      return false;
    }
  };

  type ReconciliationIntent = {
    readonly id: string;
    readonly actorId: string;
    readonly evidenceRefs: readonly string[];
  };

  const appendReconciliation = (input: {
    readonly operationId: string;
    readonly itemDatabaseId: string;
    readonly actorId: string;
    readonly evidenceRefs: readonly string[];
    readonly observation: unknown;
    readonly at: string;
  }): string => {
    const id = nextId();
    database.prepare(
      `INSERT INTO release_operation_reconciliations(id, operation_id, item_id, actor_id, authenticated_by, evidence_refs_json, observation_json, observation_hash, created_at)
       VALUES (?, ?, ?, ?, 'local-session', ?, ?, ?, ?)`,
    ).run(
      id,
      input.operationId,
      input.itemDatabaseId,
      input.actorId,
      canonicalJson(input.evidenceRefs),
      canonicalJson(bounded(input.observation)),
      digest(bounded(input.observation)),
      input.at,
    );
    return id;
  };

  const pendingReconciliationIntent = (itemDatabaseId: string): ReconciliationIntent | null => {
    const rows = database.prepare(
      `SELECT id, actor_id AS actorId, evidence_refs_json AS evidenceRefsJson,
              observation_json AS observationJson
         FROM release_operation_reconciliations
        WHERE item_id = ? ORDER BY created_at, id`,
    ).all(itemDatabaseId) as Array<{
      readonly id: string;
      readonly actorId: string;
      readonly evidenceRefsJson: string;
      readonly observationJson: string;
    }>;
    const completed = new Set<string>();
    const intents: ReconciliationIntent[] = [];
    for (const row of rows) {
      const observation = parseJson<Record<string, unknown>>(row.observationJson, `Release reconciliation ${row.id}`);
      if (observation.phase === "observation" && typeof observation.intentId === "string") {
        completed.add(observation.intentId);
      } else if (observation.phase === "intent") {
        intents.push({
          id: row.id,
          actorId: row.actorId,
          evidenceRefs: parseJson<string[]>(row.evidenceRefsJson, `Release reconciliation evidence ${row.id}`),
        });
      }
    }
    return [...intents].reverse().find((intent) => !completed.has(intent.id)) ?? null;
  };

  const setItemInTransaction = (input: { readonly operationId: string; readonly item: ItemRow; readonly state: string; readonly kind: "execution" | "receipt" | "failure" | "destination-conflict" | "unknown" | "reconcile"; readonly observation: unknown; readonly receipt?: unknown | null; readonly release?: boolean; readonly reconciliation?: ReconciliationIntent }): ReleaseOperationView => {
    const at = now();
    const current = database.prepare("SELECT evidence_json AS evidenceJson FROM release_operation_items WHERE id = ?").get(input.item.databaseId) as { readonly evidenceJson: string } | undefined;
    if (!current) throw new ReleaseOperationRuntimeError("RELEASE_OPERATION_NOT_FOUND", `Release item ${input.item.itemKey} was not found.`);
    const oldEvidence = parseJson<unknown[]>(current.evidenceJson, `Release item evidence ${input.item.itemKey}`);
    const evidence = [...oldEvidence, bounded(input.observation)];
    database.prepare(
      `UPDATE release_operation_items
          SET state = ?, receipt_json = ?, receipt_hash = ?, evidence_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.state, input.receipt ? canonicalJson(bounded(input.receipt)) : null, input.receipt ? digest(bounded(input.receipt)) : null, canonicalJson(evidence), at, input.item.databaseId);
    appendObservation({ operationId: input.operationId, itemDatabaseId: input.item.databaseId, kind: input.kind, observation: input.observation, at });
    if (input.reconciliation) {
      appendReconciliation({
        operationId: input.operationId,
        itemDatabaseId: input.item.databaseId,
        actorId: input.reconciliation.actorId,
        evidenceRefs: input.reconciliation.evidenceRefs,
        observation: {
          phase: "observation",
          intentId: input.reconciliation.id,
          result: bounded(input.observation),
        },
        at,
      });
    }
    if (input.release) releaseClaim(input.operationId, input.item.databaseId, at);
    updateAggregate(input.operationId, at);
    invalidate(input.operationId);
    return inspect(input.operationId);
  };

  const setItem = (input: Parameters<typeof setItemInTransaction>[0]): ReleaseOperationView =>
    transaction(() => setItemInTransaction(input));

  const finalize = (operationId: string, item: ItemRow, result: ReleaseOperationItemFinalize, reconciliation?: ReconciliationIntent): ReleaseOperationView => {
    if (result.state === "succeeded") return setItem({ operationId, item, state: "succeeded", kind: "receipt", observation: result.receipt, receipt: result.receipt, release: true, ...(reconciliation ? { reconciliation } : {}) });
    if (result.state === "destination-conflict") return setItem({ operationId, item, state: "destination-conflict", kind: "destination-conflict", observation: result.conflict, release: true, ...(reconciliation ? { reconciliation } : {}) });
    if (result.state === "failed") return setItem({ operationId, item, state: "failed", kind: "failure", observation: result.failure, release: true, ...(reconciliation ? { reconciliation } : {}) });
    return setItem({ operationId, item, state: "unknown", kind: "unknown", observation: result.unknown, release: false, ...(reconciliation ? { reconciliation } : {}) });
  };

  const validateAuthority = (request: ReleaseOperationCreateRequest): AcceptedDeliveryCandidateAuthoritySnapshot => {
    const authority = AcceptedDeliveryCandidateAuthoritySnapshotSchema.parse(options.acceptedAuthority(request.candidateId));
    if (authority.candidateId !== request.candidateId || authority.authorityHash !== request.expectedAcceptedAuthorityHash) throw new ReleaseOperationRuntimeError("RELEASE_AUTHORITY_CONFLICT", "The accepted Delivery candidate authority no longer matches this Release operation request.");
    if (request.kind === "merge") {
      const expected = new Map(authority.repositoryCommits.map((item) => [item.repositoryReference, item.commit]));
      if (request.items.length !== expected.size || request.items.some((item) => expected.get(item.repositoryReference) !== item.sourceCommit) || new Set(request.items.map((item) => item.repositoryReference)).size !== request.items.length) {
        throw new ReleaseOperationRuntimeError("RELEASE_AUTHORITY_CONFLICT", "Merge Release operation items must exactly and completely match accepted authority repository commits.");
      }
    } else if (request.items.length === 0 || request.items.some((item) => !authority.artifactVersionIds.includes(item.artifactVersionId))) {
      throw new ReleaseOperationRuntimeError("RELEASE_ARTIFACT_NOT_AUTHORIZED", "Export Release operation items must be a non-empty subset of accepted authority artifacts.");
    }
    return authority;
  };

  const create: ReleaseOperationRuntime["create"] = (input, actor) => {
    if (actor.type !== "human" || actor.authenticatedBy !== "local-session" || actor.id.trim() === "") throw new ReleaseOperationRuntimeError("RELEASE_OPERATION_BLOCKED", "Release operation creation requires a verified local-session human actor.");
    const request = ReleaseOperationCreateRequestSchema.parse({ ...input, authorization: { ...input.authorization, actor } });
    const authority = validateAuthority(request);
    const requestHash = digest({ request, authorityHash: authority.authorityHash });
    let inserted = false;
    let created: ReleaseOperationView;
    try {
      created = transaction(() => {
      const existing = database.prepare("SELECT canonical_request_hash AS requestHash FROM release_operations WHERE id = ?").get(request.operationId) as { readonly requestHash: string } | undefined;
      if (existing) {
        if (existing.requestHash === requestHash) return inspect(request.operationId);
        throw new ReleaseOperationRuntimeError("RELEASE_OPERATION_ID_REUSE", `Release operation ID ${request.operationId} was already used for a different canonical request.`);
      }
      const at = now();
      inserted = true;
      database.prepare(
        `INSERT INTO release_operations(id, idempotency_key, candidate_id, accepted_authority_id, kind, authorization_json, authorization_hash, request_json, canonical_request_hash, aggregate_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(request.operationId, request.operationId, request.candidateId, authority.id, request.kind, canonicalJson(request.authorization), digest(request.authorization), canonicalJson({ request, acceptedAuthority: authority }), requestHash, at, at);
      for (const [ordinal, item] of request.items.entries()) {
        const itemDatabaseId = `release-item:${request.operationId}:${item.id}`;
        database.prepare(
          `INSERT INTO release_operation_items(id, operation_id, item_key, ordinal, kind, request_json, request_hash, state, receipt_json, receipt_hash, failure_code, failure_message, evidence_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, '[]', ?, ?)`,
        ).run(itemDatabaseId, request.operationId, item.id, ordinal, request.kind, canonicalJson(item), digest(item), at, at);
        const claimId = `release-claim:${request.operationId}:${item.id}`;
        database.prepare(
          `INSERT INTO release_operation_destination_claims(id, operation_id, item_id, destination_key, fence_token, is_active, created_at, released_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
        ).run(claimId, request.operationId, itemDatabaseId, destinationKeyFor(request, item), nextId(), at);
        database.prepare("INSERT INTO release_operation_destination_claim_events(id, claim_id, action, evidence_json, created_at) VALUES (?, ?, 'acquired', ?, ?)").run(nextId(), claimId, canonicalJson({ reason: "intent" }), at);
      }
      invalidate(request.operationId);
      return inspect(request.operationId);
      });
    } catch (error) {
      if (String(error).includes("release_operation_destination_claims_active_destination_idx") || String(error).includes("release_operation_destination_claims.destination_key")) {
        throw new ReleaseOperationRuntimeError("RELEASE_DESTINATION_CONFLICT", "Another Release operation already holds an active claim for one of these destinations.");
      }
      throw error;
    }
    // A process can die after immutable intent commits but before the worker is
    // dispatched.  Deliberately keep this hook outside the SQLite unit of work.
    if (inserted) options.failureInjection?.("after-intent");
    return created;
  };

  const resolveReconciliation = (operationId: string, item: ItemRow, observation: ReleaseOperationReconcileObservation, reconciliation?: ReconciliationIntent): ReleaseOperationView => {
    if (observation.state === "succeeded") return finalize(operationId, item, { state: "succeeded", receipt: observation.receipt }, reconciliation);
    if (observation.state === "failed") return finalize(operationId, item, { state: "failed", failure: observation.failure }, reconciliation);
    if (observation.state === "destination-conflict") return finalize(operationId, item, { state: "destination-conflict", conflict: observation.conflict }, reconciliation);
    if (observation.state === "unknown") return finalize(operationId, item, { state: "unknown", unknown: observation.unknown }, reconciliation);
    return setItem({ operationId, item, state: observation.state, kind: "reconcile", observation, release: false, ...(reconciliation ? { reconciliation } : {}) });
  };

  const worker = async (operationId: string): Promise<ReleaseOperationView> => {
    let view = inspect(operationId);
    const orderedItems = database.prepare(
      `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state, receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
         FROM release_operation_items WHERE operation_id = ? ORDER BY ordinal, id`,
    ).all(operationId) as ItemRow[];
    for (const originalRow of orderedItems) {
      const row = database.prepare(
        `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state, receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
           FROM release_operation_items WHERE operation_id = ? AND item_key = ?`,
      ).get(operationId, originalRow.itemKey) as ItemRow;
      if (row.state === "unknown") break;
      const requestItem = parseJson<ReleaseOperationCreateRequest["items"][number]>(row.requestJson, `Release item ${row.itemKey}`);
      const current = inspect(operationId);
      const effect = itemEffect(current, requestItem);
      if (row.state === "running" || row.state === "reconciling") {
        const reconciliation = row.state === "reconciling" ? pendingReconciliationIntent(row.databaseId) : null;
        if (row.state === "running") {
          setItem({ operationId, item: row, state: "reconciling", kind: "reconcile", observation: { state: "reconciling" }, release: false });
        }
        let observation: ReleaseOperationReconcileObservation;
        try { observation = await options.adapter.reconcile(effect, reconciliation?.evidenceRefs ?? []); } catch (error) { observation = { state: "unknown", unknown: { code: "RECONCILE_ERROR", message: String(error), observedAt: now() } }; }
        view = resolveReconciliation(operationId, row, observation, reconciliation ?? undefined);
        if (observation.state === "unknown") break;
        if (observation.state !== "pending") continue;
      }
      const refreshed = database.prepare(
        `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state, receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
           FROM release_operation_items WHERE operation_id = ? AND item_key = ?`,
      ).get(operationId, originalRow.itemKey) as ItemRow;
      if (refreshed.state !== "pending") continue;
      if (!transaction(() => acquireClaim(operationId, refreshed.databaseId, now()))) {
        view = finalize(operationId, refreshed, { state: "destination-conflict", conflict: { code: "RELEASE_DESTINATION_CONFLICT", message: "Another Release operation holds the destination claim.", observedDestinationState: null, observedAt: now() } });
        continue;
      }
      setItem({ operationId, item: refreshed, state: "running", kind: "execution", observation: { state: "running" }, release: false });
      let result: ReleaseOperationItemFinalize;
      try { result = await options.adapter.execute(effect); } catch (error) { result = { state: "unknown", unknown: { code: "RELEASE_EFFECT_ERROR", message: String(error), observedAt: now() } }; }
      options.failureInjection?.("after-effect-before-finalize");
      view = finalize(operationId, refreshed, result);
      if (result.state === "unknown") break;
    }
    return inspect(operationId);
  };

  const dispatch: ReleaseOperationRuntime["dispatch"] = (operationId) => {
    if (stopping) return Promise.reject(new ReleaseOperationRuntimeError("RELEASE_OPERATION_BLOCKED", "Release operation dispatch is stopping."));
    const existing = active.get(operationId);
    if (existing) return existing;
    const run = worker(operationId).finally(() => active.delete(operationId));
    active.set(operationId, run);
    return run;
  };

  const requestReconciliation: ReleaseOperationRuntime["requestReconciliation"] = (input, actor) => {
    const request = ReleaseOperationReconcileRequestSchema.parse({ ...input, actor });
    if (actor.type !== "human" || actor.authenticatedBy !== "local-session") throw new ReleaseOperationRuntimeError("RELEASE_RECONCILIATION_INVALID", "Release reconciliation requires a verified local-session human actor.");
    const view = inspect(request.operationId);
    if (view.canonicalRequestHash !== request.expectedOperationHash) throw new ReleaseOperationRuntimeError("RELEASE_RECONCILIATION_INVALID", "Release reconciliation expected operation hash does not match immutable intent.");
    const row = database.prepare(
      `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state, receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
         FROM release_operation_items WHERE operation_id = ? AND item_key = ?`,
    ).get(request.operationId, request.itemId) as ItemRow | undefined;
    if (!row || (row.state !== "unknown" && row.state !== "reconciling")) throw new ReleaseOperationRuntimeError("RELEASE_RECONCILIATION_INVALID", "Only unknown or reconciling Release operation items may be reconciled.");
    if (pendingReconciliationIntent(row.databaseId)) {
      throw new ReleaseOperationRuntimeError("RELEASE_RECONCILIATION_INVALID", "Release operation item already has a pending verified-human reconciliation intent.");
    }
    return transaction(() => {
      const at = now();
      appendReconciliation({
        operationId: request.operationId,
        itemDatabaseId: row.databaseId,
        actorId: actor.id,
        evidenceRefs: request.evidenceRefs.map((ref) => ref.trim()),
        observation: {
          phase: "intent",
          evidenceRefs: request.evidenceRefs.map((ref) => ref.trim()),
        },
        at,
      });
      const requested = setItemInTransaction({
        operationId: request.operationId,
        item: row,
        state: "reconciling",
        kind: "reconcile",
        observation: { state: "reconciling", authority: "verified-human" },
        release: false,
      });
      return requested;
    });
  };

  const reconcile: ReleaseOperationRuntime["reconcile"] = async (input, actor) => {
    const requested = requestReconciliation(input, actor);
    return dispatch(requested.id);
  };

  const reconcilePending: ReleaseOperationRuntime["reconcilePending"] = async () => {
    const operations = database.prepare(
      `SELECT id FROM release_operations WHERE aggregate_state IN ('pending', 'running', 'reconciling') ORDER BY created_at, id`,
    ).all() as Array<{ readonly id: string }>;
    const views: ReleaseOperationView[] = [];
    for (const operation of operations) views.push(await dispatch(operation.id));
    return views;
  };

  const prepareForShutdown: ReleaseOperationRuntime["prepareForShutdown"] = async () => {
    stopping = true;
    for (const operationId of active.keys()) {
      transaction(() => {
        const rows = database.prepare(
          `SELECT id AS databaseId, item_key AS itemKey, request_json AS requestJson, state, receipt_json AS receiptJson, evidence_json AS evidenceJson, updated_at AS updatedAt
             FROM release_operation_items WHERE operation_id = ? AND state = 'running'`,
        ).all(operationId) as ItemRow[];
        for (const row of rows) {
          const at = now();
          database.prepare("UPDATE release_operation_items SET state = 'reconciling', updated_at = ? WHERE id = ?").run(at, row.databaseId);
          appendObservation({ operationId, itemDatabaseId: row.databaseId, kind: "reconcile", observation: { state: "reconciling", advisory: "shutdown" }, at });
        }
        updateAggregate(operationId, now());
        invalidate(operationId);
      });
    }
    await Promise.all([...active.values()]);
  };

  return { create, inspect, list: (candidateId) => (database.prepare("SELECT id FROM release_operations WHERE candidate_id = ? ORDER BY created_at, id").all(candidateId) as Array<{ readonly id: string }>).map((row) => inspect(row.id)), dispatch, reconcile, requestReconciliation, reconcilePending, prepareForShutdown };
};
