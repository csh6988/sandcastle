import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { CURRENT_SCHEMA_VERSION } from "./storage/migrations.js";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-diagnostics-"));

const companySqlitePath = (companyDir: string): string =>
  join(companyDir, ".sandcastle", "company.sqlite");

const localSessionAuthority = {
  actor: {
    type: "human" as const,
    id: "local-desktop-user",
    authenticatedBy: "local-session" as const,
  },
  commandId: "compact-command-1",
};

const liveSubscriber = {
  type: "human" as const,
  id: "live-desktop-subscriber",
  authenticatedBy: "local-session" as const,
};

interface CheckpointRow {
  readonly compacted_from_sequence: number;
  readonly compacted_through_sequence: number;
  readonly retained_watermark_sequence: number;
  readonly pre_compaction_integrity_hash: string;
  readonly compacted_event_count: number;
  readonly authorized_by_actor_type: string;
  readonly authorized_by_actor_id: string;
  readonly authorized_by_authenticated_by: string;
  readonly command_id: string;
}

const readCheckpoints = (companyDir: string): readonly CheckpointRow[] => {
  const sqlite = new DatabaseSync(companySqlitePath(companyDir));
  try {
    return sqlite
      .prepare(
        `SELECT compacted_from_sequence,
                compacted_through_sequence,
                retained_watermark_sequence,
                pre_compaction_integrity_hash,
                compacted_event_count,
                authorized_by_actor_type,
                authorized_by_actor_id,
                authorized_by_authenticated_by,
                command_id
           FROM runtime_event_compaction_checkpoints
          ORDER BY compacted_through_sequence, id`,
      )
      .all() as unknown as readonly CheckpointRow[];
  } finally {
    sqlite.close();
  }
};

describe("Runtime Diagnostics", () => {
  it("reports integrity and compacts only acknowledged Runtime events", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Private product goal",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const events = database.pipelineRuntime.runtimeEvents({
        afterSequence: 0,
        limit: 100,
      });
      assert.ok(events[0]);
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "diagnostics-test",
        sequence: events.at(-1)!.sequence,
      });
      const before = database.diagnostics.inspect();
      const compacted = database.diagnostics.compactRuntimeEvents({
        retainLast: 0,
        ...localSessionAuthority,
      });
      const after = database.diagnostics.inspect();

      assert.equal(before.sqliteIntegrity, "ok");
      assert.equal(before.schemaVersion, CURRENT_SCHEMA_VERSION);
      // startRun emits only durable business-fact events, which are retained
      // regardless of acknowledgement, so nothing is deleted here.
      assert.equal(compacted.deleted, 0);
      assert.equal(after.runtimeEventCount, before.runtimeEventCount);
      assert.ok(after.auditRecordCount >= 1);
      assert.equal(
        JSON.stringify(database.diagnostics.exportRedacted()).includes(
          "Private product goal",
        ),
        false,
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(started.run.id).snapshot.hash,
        started.snapshot.hash,
      );
    } finally {
      database.close();
    }
  });

  it("compacts acknowledged non-durable events but retains durable facts", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      // Two durable events (retained) interleaved with three standard-class
      // streaming events (compactable once acknowledged).
      const durableA = database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 1 },
      });
      const toolCallScope = {
        companyId: "company",
        projectId: "project-1",
        sessionId: "session-1",
        interactionTurnId: "turn-1",
      };
      database.events.append({
        type: "tool.call",
        scope: toolCallScope,
        payload: { toolCallId: "call-1", name: "search", args: {} },
      });
      database.events.append({
        type: "tool.result",
        scope: toolCallScope,
        payload: { toolCallId: "call-1", content: "ok" },
      });
      const durableB = database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 2 },
      });
      const lastStandard = database.events.append({
        type: "tool.call",
        scope: toolCallScope,
        payload: { toolCallId: "call-2", name: "read", args: {} },
      });

      const watermark = lastStandard.sequence;
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "diagnostics-standard-test",
        sequence: watermark,
      });

      const compacted = database.diagnostics.compactRuntimeEvents({
        retainLast: 0,
        ...localSessionAuthority,
      });

      // The three standard events at/below the watermark are swept; every
      // durable event (including durable startup catalog events) remains
      // readable, so no durable sequence is ever removed.
      assert.equal(compacted.deleted, 3);
      const remaining = database.events.readAfter(0, 100);
      const remainingSequences = remaining.map((event) => event.sequence);
      assert.ok(remainingSequences.includes(durableA.sequence));
      assert.ok(remainingSequences.includes(durableB.sequence));
      assert.equal(
        remaining.some((event) => event.type === "tool.call"),
        false,
      );
      assert.equal(
        remaining.some((event) => event.type === "tool.result"),
        false,
      );

      const checkpoints = readCheckpoints(companyDir);
      assert.equal(checkpoints.length, 1);
      const checkpoint = checkpoints[0]!;
      assert.equal(checkpoint.compacted_event_count, 3);
      // Watermark is the acknowledged boundary; the compacted range never
      // crosses it and the retained watermark records it.
      assert.equal(checkpoint.retained_watermark_sequence, watermark);
      assert.ok(
        checkpoint.compacted_through_sequence <=
          checkpoint.retained_watermark_sequence,
      );
      assert.ok(
        checkpoint.compacted_from_sequence <=
          checkpoint.compacted_through_sequence,
      );
      assert.match(checkpoint.pre_compaction_integrity_hash, /^[a-f0-9]{64}$/);
      assert.equal(checkpoint.authorized_by_actor_type, "human");
      assert.equal(checkpoint.authorized_by_actor_id, "local-desktop-user");
      assert.equal(checkpoint.authorized_by_authenticated_by, "local-session");
      assert.equal(checkpoint.command_id, "compact-command-1");
    } finally {
      database.close();
    }
  });

  it("never compacts past the slowest consumer cursor", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const toolCallScope = {
        companyId: "company",
        projectId: "project-1",
        sessionId: "session-1",
        interactionTurnId: "turn-1",
      };
      const first = database.events.append({
        type: "tool.call",
        scope: toolCallScope,
        payload: { toolCallId: "call-1", name: "search", args: {} },
      });
      database.events.append({
        type: "tool.call",
        scope: toolCallScope,
        payload: { toolCallId: "call-2", name: "read", args: {} },
      });
      database.events.append({
        type: "tool.call",
        scope: toolCallScope,
        payload: { toolCallId: "call-3", name: "write", args: {} },
      });

      // Fast consumer acknowledged everything; slow consumer only the first.
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "fast-consumer",
        sequence: database.events.latestSequence(),
      });
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "slow-consumer",
        sequence: first.sequence,
      });

      const compacted = database.diagnostics.compactRuntimeEvents({
        retainLast: 0,
        ...localSessionAuthority,
      });

      // Only the event at/below the slowest cursor may be swept.
      assert.equal(compacted.deleted, 1);
      const checkpoints = readCheckpoints(companyDir);
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0]!.retained_watermark_sequence, first.sequence);
    } finally {
      database.close();
    }
  });

  it("delivers a gap-free stream to a live subscriber across a compacted hole", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      // Interleave durable facts with compactable streaming events so a
      // selective prune leaves a NON-CONTIGUOUS hole among retained durables.
      const durableA = database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 1 },
      });
      const toolScope = {
        companyId: "company",
        projectId: "project-1",
        sessionId: "session-1",
        interactionTurnId: "turn-1",
      };
      const standardA = database.events.append({
        type: "tool.call",
        scope: toolScope,
        payload: { toolCallId: "call-1", name: "search", args: {} },
      });
      const standardB = database.events.append({
        type: "tool.result",
        scope: toolScope,
        payload: { toolCallId: "call-1", content: "ok" },
      });
      const durableB = database.events.append({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 2 },
      });

      // A live subscriber drains and acknowledges the whole stream, so its
      // cursor sits at the tail — above the range compaction may sweep.
      const opened = database.events.openSubscription({
        principal: liveSubscriber,
        consumerId: "live-subscriber",
      });
      const drained = database.events.readSubscription({
        ...opened,
        principal: liveSubscriber,
        limit: 100,
      });
      const deliveredBefore = drained.events.map((event) => event.sequence);
      assert.ok(deliveredBefore.includes(standardA.sequence));
      assert.ok(deliveredBefore.includes(standardB.sequence));
      database.events.acknowledge({
        consumerId: "live-subscriber",
        principal: liveSubscriber,
        subscriptionGeneration: opened.subscriptionGeneration,
        sequence: drained.nextSequence,
      });

      const earliestBefore = database.events.earliestSequence();
      const compacted = database.diagnostics.compactRuntimeEvents({
        retainLast: 0,
        ...localSessionAuthority,
      });
      // The two standard events are gone, leaving a hole between durableA and
      // durableB; durable facts are retained at their original sequences.
      assert.equal(compacted.deleted, 2);
      const retained = database.events.readAfter(0, 100);
      const retainedSequences = retained.map((event) => event.sequence);
      assert.ok(retainedSequences.includes(durableA.sequence));
      assert.ok(retainedSequences.includes(durableB.sequence));
      assert.equal(retainedSequences.includes(standardA.sequence), false);
      assert.equal(retainedSequences.includes(standardB.sequence), false);
      // The retained floor is unchanged: selective compaction removed interior
      // events, never a prefix, so no live cursor is expired.
      assert.equal(database.events.earliestSequence(), earliestBefore);

      // Re-opening the SAME consumer after the prune neither expires the cursor
      // (its watermark is above the hole) nor re-reads any swept sequence: the
      // live subscriber observes a gap-free forward stream.
      const reopened = database.events.openSubscription({
        principal: liveSubscriber,
        consumerId: "live-subscriber",
      });
      const afterCompaction = database.events.readSubscription({
        ...reopened,
        principal: liveSubscriber,
        limit: 100,
      });
      assert.equal(
        afterCompaction.events.some(
          (event) =>
            event.sequence === standardA.sequence ||
            event.sequence === standardB.sequence,
        ),
        false,
      );
    } finally {
      database.close();
    }
  });
});
