import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventEnvelope } from "./interface.js";
import {
  AgUiCursorExpiredError,
  AgUiProtocolDiagnosticError,
  replayRuntimeEventsAsAgUi,
  runtimeEventToAgUi,
} from "./agUiAdapter.js";
import { RUNTIME_EVENT_REGISTRY_VERSION } from "./events/registry.js";

const envelope = (
  type: string,
  sequence: number,
  payload: unknown,
): EventEnvelope => ({
  registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
  schemaVersion: 1,
  sequence,
  eventId: `event-${sequence}`,
  type,
  companyId: "company",
  projectId: "project-1",
  runId: "run-1",
  nodeRunId: "node-1",
  nodeAttemptId: "attempt-1",
  sessionId: "session-1",
  interactionTurnId: "turn-1",
  timestamp: "2026-07-15T00:00:00.000Z",
  payload,
});

const assertSource = (sequence: number) => ({
  eventId: `event-${sequence}`,
  sequence,
  registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
  schemaVersion: 1,
  companyId: "company",
  projectId: "project-1",
  runId: "run-1",
  nodeRunId: "node-1",
  nodeAttemptId: "attempt-1",
  sessionId: "session-1",
  interactionTurnId: "turn-1",
});

describe("AG-UI Runtime Adapter", () => {
  it("maps a canonical message delta without changing Runtime event identity", () => {
    const runtimeEvent: EventEnvelope = {
      registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
      schemaVersion: 1,
      sequence: 21,
      eventId: "event-21",
      type: "message.delta",
      companyId: "company",
      projectId: "project-1",
      sessionId: "session-1",
      interactionTurnId: "turn-1",
      timestamp: "2026-07-15T00:00:00.000Z",
      payload: { messageId: "message-1", content: "hello" },
    };

    assert.deepEqual(runtimeEventToAgUi(runtimeEvent), [
      {
        type: "TEXT_MESSAGE_CONTENT",
        runId: null,
        eventId: "event-21",
        sequence: 21,
        payload: {
          messageId: "message-1",
          delta: "hello",
          source: {
            eventId: "event-21",
            sequence: 21,
            registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
            schemaVersion: 1,
            companyId: "company",
            projectId: "project-1",
            sessionId: "session-1",
            interactionTurnId: "turn-1",
          },
        },
      },
    ]);
  });

  it("canonicalizes and redacts structured tool results into string content", () => {
    const [mapped] = runtimeEventToAgUi(
      envelope("tool.result", 22, {
        toolCallId: "tool-1",
        content: {
          zeta: 2,
          token: "sk-secret-value",
          alpha: { password: "hunter2", ok: true },
          privateReasoning: "hidden chain of thought",
        },
      }),
    );

    assert.ok(mapped);
    assert.equal(mapped.type, "TOOL_CALL_RESULT");
    assert.deepEqual(mapped.payload, {
      toolCallId: "tool-1",
      content:
        '{"alpha":{"ok":true,"password":"[REDACTED]"},"privateReasoning":"[REDACTED]","token":"[REDACTED]","zeta":2}',
      source: {
        eventId: "event-22",
        sequence: 22,
        registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
        schemaVersion: 1,
        companyId: "company",
        projectId: "project-1",
        runId: "run-1",
        nodeRunId: "node-1",
        nodeAttemptId: "attempt-1",
        sessionId: "session-1",
        interactionTurnId: "turn-1",
      },
    });
  });

  it("surfaces an unsupported Runtime event schema as a retryable protocol diagnostic", () => {
    const unsupported = {
      ...envelope("message.delta", 23, {
        messageId: "message-2",
        content: "later",
      }),
      schemaVersion: 2,
    } as unknown as EventEnvelope;

    assert.throws(
      () => runtimeEventToAgUi(unsupported),
      (error: unknown) =>
        error instanceof AgUiProtocolDiagnosticError &&
        error.code === "AG_UI_RUNTIME_EVENT_SCHEMA_UNSUPPORTED" &&
        error.retryable === true &&
        error.eventId === "event-23" &&
        error.sequence === 23,
    );
  });

  it("reads retained events from known registry versions and rejects future versions", () => {
    const [retained] = runtimeEventToAgUi({
      ...envelope("message.delta", 24, {
        messageId: "message-retained",
        content: "retained",
      }),
      registryVersion: 1,
    });

    assert.ok(retained);
    assert.equal(retained.type, "TEXT_MESSAGE_CONTENT");
    assert.throws(
      () =>
        runtimeEventToAgUi({
          ...envelope("message.delta", 25, {
            messageId: "message-future",
            content: "future",
          }),
          registryVersion: RUNTIME_EVENT_REGISTRY_VERSION + 1,
        }),
      (error: unknown) =>
        error instanceof AgUiProtocolDiagnosticError &&
        error.code === "AG_UI_RUNTIME_EVENT_REGISTRY_UNSUPPORTED" &&
        error.retryable === true,
    );
  });

  it("keeps explicitly unmapped Runtime events visible as redacted custom events", () => {
    const [mapped] = runtimeEventToAgUi({
      ...envelope("project.updated", 24, {
        projectId: "project-1",
        revision: 3,
        token: "sk-do-not-leak",
      }),
      sessionId: undefined,
      interactionTurnId: undefined,
      nodeRunId: undefined,
      nodeAttemptId: undefined,
    });

    assert.ok(mapped);
    assert.equal(mapped.type, "CUSTOM");
    assert.deepEqual(mapped.payload, {
      name: "sandcastle.runtime-event.unmapped",
      value: {
        payload: {
          projectId: "project-1",
          revision: 3,
          token: "[REDACTED]",
        },
        runtimeEventType: "project.updated",
      },
      source: {
        eventId: "event-24",
        sequence: 24,
        registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
        schemaVersion: 1,
        companyId: "company",
        projectId: "project-1",
        runId: "run-1",
      },
    });
  });

  it("deduplicates by event ID without merging distinct Runtime event sequences", () => {
    const first = envelope("message.delta", 25, {
      messageId: "message-3",
      content: "Hel",
    });
    const second = envelope("message.delta", 26, {
      messageId: "message-3",
      content: "lo",
    });

    const replay = replayRuntimeEventsAsAgUi([first, first, second], {
      afterSequence: 24,
      earliestRetainedSequence: 25,
    });

    assert.deepEqual(
      replay.events.map((item) => ({
        type: item.type,
        sequence: item.sequence,
        delta: (item.payload as { delta?: string }).delta,
      })),
      [
        { type: "TEXT_MESSAGE_CONTENT", sequence: 25, delta: "Hel" },
        { type: "TEXT_MESSAGE_CONTENT", sequence: 26, delta: "lo" },
      ],
    );
    assert.equal(replay.nextSequence, 26);
  });

  it("rejects a duplicate event ID whose canonical envelope conflicts", () => {
    const original = envelope("message.delta", 27, {
      messageId: "message-conflict",
      content: "first",
    });

    assert.throws(
      () =>
        replayRuntimeEventsAsAgUi(
          [
            original,
            {
              ...original,
              payload: { messageId: "message-conflict", content: "second" },
            },
          ],
          { afterSequence: 26, earliestRetainedSequence: 1 },
        ),
      (error: unknown) =>
        error instanceof AgUiProtocolDiagnosticError &&
        error.code === "AG_UI_RUNTIME_EVENT_DUPLICATE_CONFLICT" &&
        error.retryable === true,
    );
  });

  it("surfaces a sequence gap instead of advancing the proposed cursor", () => {
    assert.throws(
      () =>
        replayRuntimeEventsAsAgUi(
          [
            envelope("message.delta", 28, {
              messageId: "message-4",
              content: "missing sequence 27",
            }),
          ],
          { afterSequence: 26, earliestRetainedSequence: 1 },
        ),
      (error: unknown) =>
        error instanceof AgUiProtocolDiagnosticError &&
        error.code === "AG_UI_RUNTIME_EVENT_SEQUENCE_GAP" &&
        error.retryable === true &&
        error.sequence === 28,
    );
  });

  it("expands one tool call Runtime event into ordered AG-UI call events", () => {
    const replay = replayRuntimeEventsAsAgUi(
      [
        envelope("tool.call", 29, {
          toolCallId: "tool-2",
          name: "read_file",
          args: { path: "/tmp/demo", token: "sk-hidden" },
        }),
      ],
      { afterSequence: 28, earliestRetainedSequence: 1 },
    );

    assert.deepEqual(
      replay.events.map((item) => ({
        type: item.type,
        sequence: item.sequence,
        payload: item.payload,
      })),
      [
        {
          type: "TOOL_CALL_START",
          sequence: 29,
          payload: {
            toolCallId: "tool-2",
            toolName: "read_file",
            source: assertSource(29),
          },
        },
        {
          type: "TOOL_CALL_ARGS",
          sequence: 29,
          payload: {
            toolCallId: "tool-2",
            args: '{"path":"/tmp/demo","token":"[REDACTED]"}',
            source: assertSource(29),
          },
        },
        {
          type: "TOOL_CALL_END",
          sequence: 29,
          payload: {
            toolCallId: "tool-2",
            source: assertSource(29),
          },
        },
      ],
    );
  });

  it("preserves permission, reconciliation, failure, and terminal order", () => {
    const replay = replayRuntimeEventsAsAgUi(
      [
        {
          ...envelope("permission.requested", 30, {
            permissionId: "permission-1",
            scope: "repository.write",
            status: "pending",
          }),
          permissionRequestId: "permission-1",
        },
        {
          ...envelope("permission.decided", 31, {
            permissionId: "permission-1",
            scope: "repository.write",
            status: "denied",
          }),
          permissionRequestId: "permission-1",
        },
        envelope("interaction.turn.reconciling", 32, {
          status: "reconciling",
          operationKey: "interaction-turn:turn-1",
        }),
        envelope("interaction.turn.failed", 33, {
          status: "failed",
          operationKey: "interaction-turn:turn-1",
          failureCode: "PERMISSION_DENIED",
        }),
      ],
      { afterSequence: 29, earliestRetainedSequence: 1 },
    );

    assert.deepEqual(
      replay.events.map((item) => [
        item.sequence,
        item.type,
        (item.payload as { name?: string }).name,
      ]),
      [
        [30, "CUSTOM", "sandcastle.permission.requested"],
        [31, "CUSTOM", "sandcastle.permission.decided"],
        [32, "CUSTOM", "sandcastle.interaction.turn.reconciling"],
        [33, "RUN_ERROR", undefined],
      ],
    );
    assert.equal(replay.nextSequence, 33);
  });

  it("rejects a cursor older than retained Runtime events", () => {
    assert.throws(
      () =>
        replayRuntimeEventsAsAgUi(
          [
            envelope("message.delta", 10, {
              messageId: "message-5",
              content: "hello",
            }),
          ],
          { afterSequence: 1, earliestRetainedSequence: 10 },
        ),
      (error: unknown) => error instanceof AgUiCursorExpiredError,
    );
  });
});
