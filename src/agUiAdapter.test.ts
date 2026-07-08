import { describe, expect, it } from "vitest";
import { runtimeEventToAgUiEvents } from "./agUiAdapter.js";
import type { RuntimeEvent } from "./RuntimeEvent.js";

const at = new Date("2026-01-02T03:04:05.000Z");

describe("runtimeEventToAgUiEvents", () => {
  it("maps run lifecycle events", () => {
    const started: RuntimeEvent = {
      type: "run.started",
      runId: "run-1",
      name: "demo",
      agent: "claude-code",
      model: "opus",
      sandbox: "docker",
      branch: "main",
      timestamp: at,
    };
    const finished: RuntimeEvent = {
      type: "run.finished",
      runId: "run-1",
      completionSignal: "<promise>COMPLETE</promise>",
      iterationsRun: 1,
      commits: [{ sha: "abc123" }],
      timestamp: at,
    };

    expect(runtimeEventToAgUiEvents(started)).toEqual([
      {
        type: "RUN_STARTED",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        name: "demo",
        agent: "claude-code",
        model: "opus",
        sandbox: "docker",
        branch: "main",
      },
    ]);
    expect(runtimeEventToAgUiEvents(finished)).toEqual([
      {
        type: "CUSTOM",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        name: "sandcastle.commits.created",
        value: { commits: [{ sha: "abc123" }] },
      },
      {
        type: "RUN_FINISHED",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        completionSignal: "<promise>COMPLETE</promise>",
        iterationsRun: 1,
      },
    ]);
  });

  it("maps message, tool call, step, error, and raw events", () => {
    const events: RuntimeEvent[] = [
      {
        type: "iteration.started",
        runId: "run-1",
        iteration: 2,
        timestamp: at,
      },
      {
        type: "iteration.finished",
        runId: "run-1",
        iteration: 2,
        sessionId: "session-1",
        timestamp: at,
      },
      {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-1",
        text: "hello",
        timestamp: at,
      },
      {
        type: "tool.call",
        runId: "run-1",
        toolCallId: "tool-1",
        name: "Bash",
        args: "npm test",
        timestamp: at,
      },
      {
        type: "raw",
        runId: "run-1",
        line: '{"type":"debug"}',
        timestamp: at,
      },
      {
        type: "run.error",
        runId: "run-1",
        message: "boom",
        timestamp: at,
      },
    ];

    expect(events.flatMap((event) => runtimeEventToAgUiEvents(event))).toEqual([
      {
        type: "STEP_STARTED",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        stepName: "iteration.2",
        iteration: 2,
      },
      {
        type: "STEP_FINISHED",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        stepName: "iteration.2",
        iteration: 2,
        sessionId: "session-1",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        messageId: "msg-1",
        delta: "hello",
      },
      {
        type: "TOOL_CALL_START",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        toolCallId: "tool-1",
        toolName: "Bash",
      },
      {
        type: "TOOL_CALL_ARGS",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        toolCallId: "tool-1",
        args: "npm test",
      },
      {
        type: "TOOL_CALL_END",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        toolCallId: "tool-1",
      },
      {
        type: "RAW",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        line: '{"type":"debug"}',
      },
      {
        type: "RUN_ERROR",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        message: "boom",
      },
    ]);
  });

  it("maps usage and standalone commit events to custom AG-UI events", () => {
    const usage: RuntimeEvent = {
      type: "usage.recorded",
      runId: "run-1",
      iteration: 3,
      model: "opus",
      usage: {
        inputTokens: 10,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        outputTokens: 4,
      },
      timestamp: at,
    };
    const commit: RuntimeEvent = {
      type: "commit.created",
      runId: "run-1",
      iteration: 3,
      sha: "def456",
      timestamp: at,
    };

    expect(
      [usage, commit].flatMap((event) => runtimeEventToAgUiEvents(event)),
    ).toEqual([
      {
        type: "CUSTOM",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        name: "sandcastle.usage.recorded",
        value: {
          iteration: 3,
          model: "opus",
          usage: {
            inputTokens: 10,
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 3,
            outputTokens: 4,
          },
        },
      },
      {
        type: "CUSTOM",
        runId: "run-1",
        timestamp: "2026-01-02T03:04:05.000Z",
        name: "sandcastle.commits.created",
        value: { commits: [{ sha: "def456" }] },
      },
    ]);
  });
});
