import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEventRecord } from "./pipeline/pipelineRuntime.js";
import {
  AgUiCursorExpiredError,
  replayRuntimeEventsAsAgUi,
  runtimeEventToAgUi,
} from "./agUiAdapter.js";

const event = (
  type: string,
  sequence: number,
  payload: unknown,
): RuntimeEventRecord => ({
  sequence,
  eventId: `event-${sequence}`,
  type,
  runId: "run-1",
  nodeRunId: null,
  payload,
  createdAt: "2026-07-15T00:00:00.000Z",
});

describe("AG-UI Runtime Adapter", () => {
  it("maps protocol-neutral Runtime events without changing their cursor", () => {
    assert.deepEqual(
      runtimeEventToAgUi(event("run.created", 1, { status: "ready" })),
      {
        type: "RUN_STARTED",
        runId: "run-1",
        eventId: "event-1",
        sequence: 1,
        payload: { status: "ready" },
      },
    );
    assert.equal(
      runtimeEventToAgUi(
        event("session.message.created", 2, {
          sessionId: "session-1",
          content: "hello",
        }),
      ).type,
      "TEXT_MESSAGE_CONTENT",
    );
  });

  it("replays from a durable cursor and rejects a cursor older than retained events", () => {
    const events = [
      event("run.created", 10, {}),
      event("permission.requested", 11, { scope: "repository.write" }),
    ];
    assert.deepEqual(replayRuntimeEventsAsAgUi(events, { afterSequence: 10 }), {
      events: [runtimeEventToAgUi(events[1]!)],
      nextSequence: 11,
    });
    assert.throws(
      () => replayRuntimeEventsAsAgUi(events, { afterSequence: 1 }),
      (error: unknown) => error instanceof AgUiCursorExpiredError,
    );
  });

  it("batches adjacent text deltas without crossing Permission events", () => {
    const events = [
      event("session.message.delta", 1, {
        sessionId: "session-1",
        participantId: "member-1",
        content: "Hel",
      }),
      event("session.message.delta", 2, {
        sessionId: "session-1",
        participantId: "member-1",
        content: "lo",
      }),
      event("permission.requested", 3, { scope: "repository.write" }),
      event("session.message.delta", 4, {
        sessionId: "session-1",
        participantId: "member-1",
        content: "!",
      }),
    ];

    const replay = replayRuntimeEventsAsAgUi(events, { afterSequence: 0 });

    assert.deepEqual(
      replay.events.map((item) => ({
        type: item.type,
        sequence: item.sequence,
        content: (item.payload as { content?: string }).content,
      })),
      [
        { type: "TEXT_MESSAGE_CONTENT", sequence: 2, content: "Hello" },
        { type: "PERMISSION_REQUESTED", sequence: 3, content: undefined },
        { type: "TEXT_MESSAGE_CONTENT", sequence: 4, content: "!" },
      ],
    );
    assert.equal(replay.nextSequence, 4);
  });
});
