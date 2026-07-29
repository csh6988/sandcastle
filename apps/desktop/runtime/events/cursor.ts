import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorRef, EventEnvelope, QueryResult } from "../interface.js";
import type { RuntimeEventOutbox } from "./outbox.js";

export class RuntimeEventCursorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeEventCursorError";
  }
}

export interface RuntimeSubscriptionHandle {
  readonly subscriptionId: string;
  readonly subscriptionGeneration: number;
  readonly barrierSequence: number;
}

export interface RuntimeSubscriptionBatch {
  readonly events: readonly EventEnvelope[];
  readonly nextSequence: number;
  readonly hasMore: boolean;
}

export interface RuntimeEventCursorStore {
  readonly openSubscription: (input: {
    readonly principal: ActorRef;
    readonly consumerId: string;
  }) => RuntimeSubscriptionHandle;
  readonly readSubscription: (
    input: Pick<
      RuntimeSubscriptionHandle,
      "subscriptionId" | "subscriptionGeneration"
    > & {
      readonly principal: ActorRef;
      readonly limit: number;
    },
  ) => RuntimeSubscriptionBatch;
  readonly closeSubscription: (
    input: Pick<
      RuntimeSubscriptionHandle,
      "subscriptionId" | "subscriptionGeneration"
    > & { readonly principal: ActorRef },
  ) => void;
  readonly acknowledge: (input: {
    readonly consumerId: string;
    readonly principal: ActorRef;
    readonly sequence: number;
    readonly subscriptionGeneration?: number;
    readonly viewSyncToken?: string;
    readonly commandId?: string;
  }) => {
    readonly acknowledged: true;
    readonly subscriptionGeneration: number;
    readonly barrierSequence: number;
    readonly auditId: string;
  };
  readonly acknowledgeInTransaction: RuntimeEventCursorStore["acknowledge"];
  readonly querySnapshot: <View>(input: {
    readonly principal: ActorRef;
    readonly consumerId: string;
    readonly queryHash: string;
    readonly view?: View;
    readonly read: () => View;
  }) => QueryResult<View> & { readonly viewSyncToken: string };
}

interface CursorRow {
  readonly consumerId: string;
  readonly sequence: number;
  readonly ownerPrincipalJson: string | null;
  readonly activeSubscriptionId: string | null;
  readonly subscriptionGeneration: number;
  readonly lastDeliveredSequence: number;
  readonly barrierSequence: number;
  readonly retiredAt: string | null;
}

interface ViewSyncClaims {
  readonly nonce: string;
  readonly consumerId: string;
  readonly principalHash: string;
  readonly queryHash: string;
  readonly viewHash: string;
  readonly sequence: number;
  readonly expiresAt: string;
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

export const runtimeQueryViewHash = (value: unknown): string =>
  sha256(canonicalJson(value));

const principalJson = (principal: ActorRef): string => canonicalJson(principal);
const principalHash = (principal: ActorRef): string =>
  sha256(principalJson(principal));

const readCursor = (
  database: DatabaseSync,
  consumerId: string,
): CursorRow | undefined =>
  database
    .prepare(
      `SELECT consumer_id AS consumerId,
              sequence,
              owner_principal_json AS ownerPrincipalJson,
              active_subscription_id AS activeSubscriptionId,
              subscription_generation AS subscriptionGeneration,
              last_delivered_sequence AS lastDeliveredSequence,
              barrier_sequence AS barrierSequence,
              retired_at AS retiredAt
         FROM runtime_event_cursors
        WHERE consumer_id = ?`,
    )
    .get(consumerId) as CursorRow | undefined;

const assertOwner = (row: CursorRow, principal: ActorRef): void => {
  if (
    row.ownerPrincipalJson !== null &&
    row.ownerPrincipalJson !== principalJson(principal)
  ) {
    throw new RuntimeEventCursorError(
      "SUBSCRIPTION_OWNER_MISMATCH",
      `Runtime event consumer ${row.consumerId} belongs to another principal.`,
    );
  }
};

const assertActiveGeneration = (
  row: CursorRow,
  input: {
    readonly subscriptionId?: string;
    readonly subscriptionGeneration?: number;
  },
): void => {
  if (
    row.activeSubscriptionId === null ||
    row.activeSubscriptionId !== input.subscriptionId ||
    row.subscriptionGeneration !== input.subscriptionGeneration
  ) {
    throw new RuntimeEventCursorError(
      "SUBSCRIPTION_SUPERSEDED",
      `Runtime event subscription generation ${String(input.subscriptionGeneration)} is no longer active.`,
    );
  }
};

export const openRuntimeEventCursorStore = (
  database: DatabaseSync,
  outbox: RuntimeEventOutbox,
  options: {
    readonly clock?: () => Date;
    readonly tokenTtlMs?: number;
    readonly signingKey?: Buffer;
  } = {},
): RuntimeEventCursorStore => {
  const clock = options.clock ?? (() => new Date());
  const tokenTtlMs = options.tokenTtlMs ?? 60_000;
  const signingKey = options.signingKey ?? randomBytes(32);

  const sign = (claims: ViewSyncClaims): string => {
    const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
    const signature = createHmac("sha256", signingKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  };

  const verify = (token: string): ViewSyncClaims => {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      throw new RuntimeEventCursorError(
        "VIEW_SYNC_TOKEN_INVALID",
        "View sync token is malformed.",
      );
    }
    const expected = createHmac("sha256", signingKey).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      actual = Buffer.alloc(0);
    }
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new RuntimeEventCursorError(
        "VIEW_SYNC_TOKEN_INVALID",
        "View sync token signature is invalid.",
      );
    }
    let claims: ViewSyncClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new RuntimeEventCursorError(
        "VIEW_SYNC_TOKEN_INVALID",
        "View sync token payload is invalid.",
      );
    }
    return claims;
  };

  const assertCursorBoundary = (sequence: number): void => {
    const earliest = outbox.earliestSequence();
    const latest = outbox.latestSequence();
    if (sequence > latest) {
      throw new RuntimeEventCursorError(
        "CURSOR_AHEAD",
        `Runtime event cursor ${sequence} is ahead of sequence ${latest}.`,
      );
    }
    if (earliest !== undefined && sequence < earliest - 1) {
      throw new RuntimeEventCursorError(
        "CURSOR_EXPIRED",
        `Runtime event cursor ${sequence} is older than retained sequence ${earliest}.`,
      );
    }
  };

  const cursorStore: RuntimeEventCursorStore = {
    openSubscription: (input) => {
      if (!input.consumerId.trim()) {
        throw new RuntimeEventCursorError(
          "RUNTIME_EVENT_CURSOR_INVALID",
          "Runtime event consumer ID must not be empty.",
        );
      }
      const now = clock().toISOString();
      const subscriptionId = randomUUID();
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = readCursor(database, input.consumerId);
        if (existing) {
          assertOwner(existing, input.principal);
          if (existing.retiredAt !== null) {
            throw new RuntimeEventCursorError(
              "RUNTIME_EVENT_CURSOR_RETIRED",
              `Runtime event consumer ${input.consumerId} is retired.`,
            );
          }
          assertCursorBoundary(Number(existing.sequence));
          database
            .prepare(
              `UPDATE runtime_event_cursors
                  SET owner_principal_json = ?,
                      active_subscription_id = ?,
                      subscription_generation = subscription_generation + 1,
                      last_delivered_sequence = sequence,
                      barrier_sequence = sequence,
                      updated_at = ?,
                      last_seen_at = ?
                WHERE consumer_id = ?`,
            )
            .run(
              principalJson(input.principal),
              subscriptionId,
              now,
              now,
              input.consumerId,
            );
        } else {
          assertCursorBoundary(0);
          database
            .prepare(
              `INSERT INTO runtime_event_cursors(
                 consumer_id, sequence, updated_at, owner_principal_json,
                 active_subscription_id, subscription_generation,
                 last_delivered_sequence, barrier_sequence, last_seen_at
               ) VALUES (?, 0, ?, ?, ?, 1, 0, 0, ?)`,
            )
            .run(
              input.consumerId,
              now,
              principalJson(input.principal),
              subscriptionId,
              now,
            );
        }
        const current = readCursor(database, input.consumerId)!;
        database.exec("COMMIT");
        return {
          subscriptionId,
          subscriptionGeneration: Number(current.subscriptionGeneration),
          barrierSequence: Number(current.barrierSequence),
        };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    readSubscription: (input) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const selected = database
          .prepare(
            `SELECT consumer_id AS consumerId,
                      sequence,
                      owner_principal_json AS ownerPrincipalJson,
                      active_subscription_id AS activeSubscriptionId,
                      subscription_generation AS subscriptionGeneration,
                      last_delivered_sequence AS lastDeliveredSequence,
                      barrier_sequence AS barrierSequence,
                      retired_at AS retiredAt
                 FROM runtime_event_cursors
                WHERE active_subscription_id = ?`,
          )
          .get(input.subscriptionId) as CursorRow | undefined;
        if (!selected) {
          throw new RuntimeEventCursorError(
            "SUBSCRIPTION_SUPERSEDED",
            `Runtime event subscription ${input.subscriptionId} is no longer active.`,
          );
        }
        assertOwner(selected, input.principal);
        assertActiveGeneration(selected, input);
        const after = Number(selected.lastDeliveredSequence);
        assertCursorBoundary(after);
        const events = outbox.readAfter(after, input.limit);
        const nextSequence = events.at(-1)?.sequence ?? after;
        const hasMore = nextSequence < outbox.latestSequence();
        database
          .prepare(
            `UPDATE runtime_event_cursors
                SET last_delivered_sequence = ?, last_seen_at = ?, updated_at = ?
              WHERE consumer_id = ?
                AND active_subscription_id = ?
                AND subscription_generation = ?`,
          )
          .run(
            nextSequence,
            clock().toISOString(),
            clock().toISOString(),
            selected.consumerId,
            input.subscriptionId,
            input.subscriptionGeneration,
          );
        database.exec("COMMIT");
        return { events, nextSequence, hasMore };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    closeSubscription: (input) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database
          .prepare(
            `SELECT consumer_id AS consumerId,
                    sequence,
                    owner_principal_json AS ownerPrincipalJson,
                    active_subscription_id AS activeSubscriptionId,
                    subscription_generation AS subscriptionGeneration,
                    last_delivered_sequence AS lastDeliveredSequence,
                    barrier_sequence AS barrierSequence,
                    retired_at AS retiredAt
               FROM runtime_event_cursors
              WHERE active_subscription_id = ?`,
          )
          .get(input.subscriptionId) as CursorRow | undefined;
        if (!row) {
          throw new RuntimeEventCursorError(
            "SUBSCRIPTION_SUPERSEDED",
            `Runtime event subscription ${input.subscriptionId} is no longer active.`,
          );
        }
        assertOwner(row, input.principal);
        assertActiveGeneration(row, input);
        database
          .prepare(
            `UPDATE runtime_event_cursors
                SET active_subscription_id = NULL, last_seen_at = ?, updated_at = ?
              WHERE consumer_id = ?`,
          )
          .run(clock().toISOString(), clock().toISOString(), row.consumerId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    acknowledgeInTransaction: (input) => {
      const now = clock().toISOString();
      let row = readCursor(database, input.consumerId);
      if (row) assertOwner(row, input.principal);
      const before = row
        ? {
            sequence: Number(row.sequence),
            subscriptionGeneration: Number(row.subscriptionGeneration),
          }
        : null;
      if (input.viewSyncToken) {
        if (input.subscriptionGeneration !== undefined) {
          throw new RuntimeEventCursorError(
            "VIEW_SYNC_TOKEN_INVALID",
            "View-sync acknowledgement must not include a subscription generation.",
          );
        }
        const claims = verify(input.viewSyncToken);
        if (
          claims.consumerId !== input.consumerId ||
          claims.principalHash !== principalHash(input.principal) ||
          claims.sequence !== input.sequence
        ) {
          throw new RuntimeEventCursorError(
            "VIEW_SYNC_TOKEN_INVALID",
            "View sync token does not match the consumer, principal, or sequence.",
          );
        }
        if (Date.parse(claims.expiresAt) <= clock().getTime()) {
          throw new RuntimeEventCursorError(
            "VIEW_SYNC_TOKEN_EXPIRED",
            "View sync token has expired.",
          );
        }
        assertCursorBoundary(input.sequence);
        const tokenHash = sha256(input.viewSyncToken);
        const consumed = database
          .prepare(
            `INSERT OR IGNORE INTO consumed_view_sync_tokens(
                 token_hash, nonce_hash, consumer_id, principal_hash,
                 query_hash, view_hash, sequence, expires_at, consumed_at,
                 command_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tokenHash,
            sha256(claims.nonce),
            input.consumerId,
            claims.principalHash,
            claims.queryHash,
            claims.viewHash,
            input.sequence,
            claims.expiresAt,
            now,
            input.commandId ?? null,
          );
        if (Number(consumed.changes) !== 1) {
          throw new RuntimeEventCursorError(
            "VIEW_SYNC_TOKEN_USED",
            "View sync token has already been consumed.",
          );
        }
        if (row) {
          database
            .prepare(
              `UPDATE runtime_event_cursors
                    SET sequence = ?,
                        active_subscription_id = NULL,
                        subscription_generation = subscription_generation + 1,
                        last_delivered_sequence = ?,
                        barrier_sequence = ?,
                        last_seen_at = ?,
                        updated_at = ?
                  WHERE consumer_id = ?`,
            )
            .run(
              input.sequence,
              input.sequence,
              input.sequence,
              now,
              now,
              input.consumerId,
            );
        } else {
          database
            .prepare(
              `INSERT INTO runtime_event_cursors(
                   consumer_id, sequence, updated_at, owner_principal_json,
                   active_subscription_id, subscription_generation,
                   last_delivered_sequence, barrier_sequence, last_seen_at
                 ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
            )
            .run(
              input.consumerId,
              input.sequence,
              now,
              principalJson(input.principal),
              input.sequence,
              input.sequence,
              now,
            );
        }
      } else {
        if (!row) {
          throw new RuntimeEventCursorError(
            "RUNTIME_EVENT_CURSOR_INVALID",
            `Runtime event consumer ${input.consumerId} has no active subscription.`,
          );
        }
        if (input.subscriptionGeneration === undefined) {
          throw new RuntimeEventCursorError(
            "SUBSCRIPTION_GENERATION_REQUIRED",
            "Normal acknowledgement requires the active subscription generation.",
          );
        }
        assertActiveGeneration(row, {
          subscriptionId: row.activeSubscriptionId ?? undefined,
          subscriptionGeneration: input.subscriptionGeneration,
        });
        assertCursorBoundary(input.sequence);
        if (input.sequence > Number(row.lastDeliveredSequence)) {
          throw new RuntimeEventCursorError(
            "RUNTIME_EVENT_ACK_NOT_DELIVERED",
            `Runtime event sequence ${input.sequence} exceeds the contiguous delivered boundary ${row.lastDeliveredSequence}.`,
          );
        }
        if (input.sequence < Number(row.sequence)) {
          throw new RuntimeEventCursorError(
            "CURSOR_AHEAD",
            `Runtime event cursor is already at ${row.sequence}.`,
          );
        }
        database
          .prepare(
            `UPDATE runtime_event_cursors
                  SET sequence = ?, barrier_sequence = ?, last_seen_at = ?, updated_at = ?
                WHERE consumer_id = ?`,
          )
          .run(input.sequence, input.sequence, now, now, input.consumerId);
      }
      row = readCursor(database, input.consumerId)!;
      const auditId = randomUUID();
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
               id, action, entity_type, entity_id, run_id, node_run_id,
               before_json, after_json, created_at, command_id, actor_type,
               actor_id, authenticated_by, consumer_id
             ) VALUES (?, 'runtime.events.acknowledged', 'runtime-event-cursor', ?,
                       NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          auditId,
          input.consumerId,
          before === null ? null : canonicalJson(before),
          canonicalJson({
            sequence: Number(row.sequence),
            subscriptionGeneration: Number(row.subscriptionGeneration),
          }),
          now,
          input.commandId ?? null,
          input.principal.type,
          input.principal.id,
          input.principal.authenticatedBy,
          input.consumerId,
        );
      return {
        acknowledged: true,
        subscriptionGeneration: Number(row.subscriptionGeneration),
        barrierSequence: Number(row.sequence),
        auditId,
      };
    },
    acknowledge: (input) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = cursorStore.acknowledgeInTransaction(input);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    querySnapshot: (input) => {
      database.exec("BEGIN");
      try {
        const view = input.read();
        const sequence = outbox.latestSequence();
        const expiresAt = new Date(
          clock().getTime() + tokenTtlMs,
        ).toISOString();
        const token = sign({
          nonce: randomUUID(),
          consumerId: input.consumerId,
          principalHash: principalHash(input.principal),
          queryHash: input.queryHash,
          viewHash: runtimeQueryViewHash(view),
          sequence,
          expiresAt,
        });
        database.exec("COMMIT");
        return {
          view,
          asOfSequence: sequence,
          viewSyncToken: token,
        };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return cursorStore;
};
