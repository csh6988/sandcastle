import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import type { ActorRef } from "../interface.js";
import { RuntimeEventCursorError } from "./cursor.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-runtime-events-"));

const principal: ActorRef = {
  type: "test-driver",
  id: "events-test",
  authenticatedBy: "runtime",
};

describe("durable Runtime Event subscription", () => {
  it("starts at the durable cursor, fences stale generations, and acknowledges contiguously", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const first = database.events.openSubscription({
        principal,
        consumerId: "consumer-1",
      });
      const initial = database.events.readSubscription({
        ...first,
        principal,
        limit: 100,
      });
      database.events.acknowledge({
        consumerId: "consumer-1",
        principal,
        subscriptionGeneration: first.subscriptionGeneration,
        sequence: initial.nextSequence,
      });
      const second = database.events.openSubscription({
        principal,
        consumerId: "consumer-1",
      });
      database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 1 },
      });
      database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 2 },
      });

      const delivered = database.events.readSubscription({
        ...second,
        principal,
        limit: 1,
      });
      assert.deepEqual(
        delivered.events.map((event) => event.type),
        ["project.updated"],
      );
      assert.equal(delivered.hasMore, true);
      assert.throws(
        () =>
          database.events.acknowledge({
            consumerId: "consumer-1",
            principal,
            subscriptionGeneration: second.subscriptionGeneration,
            sequence: database.events.latestSequence(),
          }),
        /contiguous|delivered/i,
      );

      const third = database.events.openSubscription({
        principal,
        consumerId: "consumer-1",
      });
      assert.notEqual(
        third.subscriptionGeneration,
        second.subscriptionGeneration,
      );
      assert.throws(
        () =>
          database.events.readSubscription({
            ...second,
            principal,
            limit: 10,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "SUBSCRIPTION_SUPERSEDED",
      );

      database.events.acknowledge({
        consumerId: "consumer-1",
        principal,
        subscriptionGeneration: third.subscriptionGeneration,
        sequence: initial.nextSequence,
      });
    } finally {
      database.close();
    }
  });

  it("consumes a view-sync token once and does not append an Ack event", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const query = database.events.querySnapshot({
        principal,
        consumerId: "consumer-2",
        queryHash: "query-hash",
        view: { projects: [] },
        read: () => ({ projects: [] }),
      });
      const beforeAck = database.events.latestSequence();
      const acknowledged = database.events.acknowledge({
        consumerId: "consumer-2",
        principal,
        viewSyncToken: query.viewSyncToken,
        sequence: query.asOfSequence,
      });
      assert.equal(acknowledged.acknowledged, true);
      assert.equal(database.events.latestSequence(), beforeAck);
      assert.throws(
        () =>
          database.events.acknowledge({
            consumerId: "consumer-2",
            principal,
            viewSyncToken: query.viewSyncToken,
            sequence: query.asOfSequence,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "VIEW_SYNC_TOKEN_USED",
      );
    } finally {
      database.close();
    }
  });

  it("binds cursors and View-sync tokens to actor identity without authorization metadata", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    const actor: ActorRef = {
      type: "human",
      id: "local-user",
      authenticatedBy: "local-session",
    };
    const projectReader = {
      ...actor,
      projectReadAuthority: ["project-1"],
    };
    try {
      const query = database.events.querySnapshot({
        principal: projectReader,
        consumerId: "consumer-reader",
        queryHash: "query-hash",
        read: () => ({ projects: [] }),
      });
      assert.equal(
        database.events.acknowledge({
          consumerId: "consumer-reader",
          principal: actor,
          viewSyncToken: query.viewSyncToken,
          sequence: query.asOfSequence,
        }).acknowledged,
        true,
      );
      database.events.openSubscription({
        principal: projectReader,
        consumerId: "consumer-reader",
      });
      assert.throws(
        () =>
          database.events.openSubscription({
            principal: { ...actor, id: "different-user" },
            consumerId: "consumer-reader",
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "SUBSCRIPTION_OWNER_MISMATCH",
      );
    } finally {
      database.close();
    }
  });

  it("rejects expired or principal-mismatched View-sync tokens", () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => now,
    });
    try {
      const query = database.events.querySnapshot({
        principal,
        consumerId: "consumer-token",
        queryHash: "query-hash",
        read: () => ({ projects: [] }),
      });
      assert.throws(
        () =>
          database.events.acknowledge({
            consumerId: "consumer-token",
            principal: { ...principal, id: "different-principal" },
            viewSyncToken: query.viewSyncToken,
            sequence: query.asOfSequence,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "VIEW_SYNC_TOKEN_INVALID",
      );

      now = new Date("2026-07-15T00:01:01.000Z");
      assert.throws(
        () =>
          database.events.acknowledge({
            consumerId: "consumer-token",
            principal,
            viewSyncToken: query.viewSyncToken,
            sequence: query.asOfSequence,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "VIEW_SYNC_TOKEN_EXPIRED",
      );
    } finally {
      database.close();
    }
  });

  it("rejects cursors ahead of the outbox and behind compacted history", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir);
    try {
      for (let revision = 1; revision <= 3; revision += 1) {
        database.events.append({
          type: "project.updated",
          scope: { companyId: "company", projectId: "project-1" },
          payload: { projectId: "project-1", revision },
        });
      }
      const subscription = database.events.openSubscription({
        principal,
        consumerId: "consumer-ahead",
      });
      assert.throws(
        () =>
          database.events.acknowledge({
            consumerId: "consumer-ahead",
            principal,
            subscriptionGeneration: subscription.subscriptionGeneration,
            sequence: database.events.latestSequence() + 1,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "CURSOR_AHEAD",
      );
    } finally {
      database.close();
    }

    const sqlite = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    sqlite
      .prepare("DELETE FROM runtime_event_outbox WHERE sequence <= 1")
      .run();
    sqlite.close();

    database = openCompanyDatabase(companyDir);
    try {
      assert.throws(
        () =>
          database.events.openSubscription({
            principal,
            consumerId: "consumer-expired",
          }),
        (error: unknown) =>
          error instanceof RuntimeEventCursorError &&
          error.code === "CURSOR_EXPIRED",
      );
    } finally {
      database.close();
    }
  });
});
