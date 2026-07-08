import type { RuntimeEvent } from "./RuntimeEvent.js";

export type AgUiEvent =
  | {
      readonly type: "RUN_STARTED";
      readonly runId: string;
      readonly timestamp: string;
      readonly name?: string;
      readonly agent?: string;
      readonly model?: string;
      readonly sandbox?: string;
      readonly branch?: string;
    }
  | {
      readonly type: "RUN_FINISHED";
      readonly runId: string;
      readonly timestamp: string;
      readonly completionSignal?: string;
      readonly iterationsRun: number;
    }
  | {
      readonly type: "RUN_ERROR";
      readonly runId: string;
      readonly timestamp: string;
      readonly message: string;
    }
  | {
      readonly type: "STEP_STARTED";
      readonly runId: string;
      readonly timestamp: string;
      readonly stepName: string;
      readonly iteration: number;
    }
  | {
      readonly type: "STEP_FINISHED";
      readonly runId: string;
      readonly timestamp: string;
      readonly stepName: string;
      readonly iteration: number;
      readonly sessionId?: string;
    }
  | {
      readonly type: "TEXT_MESSAGE_CONTENT";
      readonly runId: string;
      readonly timestamp: string;
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "TOOL_CALL_START";
      readonly runId: string;
      readonly timestamp: string;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "TOOL_CALL_ARGS";
      readonly runId: string;
      readonly timestamp: string;
      readonly toolCallId: string;
      readonly args: string;
    }
  | {
      readonly type: "TOOL_CALL_END";
      readonly runId: string;
      readonly timestamp: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: "RAW";
      readonly runId: string;
      readonly timestamp: string;
      readonly line: string;
    }
  | {
      readonly type: "CUSTOM";
      readonly runId: string;
      readonly timestamp: string;
      readonly name: "sandcastle.commits.created" | "sandcastle.usage.recorded";
      readonly value: unknown;
    };

const timestamp = (event: RuntimeEvent): string =>
  event.timestamp.toISOString();

export const runtimeEventToAgUiEvents = (
  event: RuntimeEvent,
): readonly AgUiEvent[] => {
  if (event.type === "run.started") {
    return [
      {
        type: "RUN_STARTED",
        runId: event.runId,
        timestamp: timestamp(event),
        name: event.name,
        agent: event.agent,
        model: event.model,
        sandbox: event.sandbox,
        branch: event.branch,
      },
    ];
  }
  if (event.type === "run.finished") {
    return [
      ...(event.commits.length > 0
        ? [
            {
              type: "CUSTOM" as const,
              runId: event.runId,
              timestamp: timestamp(event),
              name: "sandcastle.commits.created" as const,
              value: { commits: event.commits },
            },
          ]
        : []),
      {
        type: "RUN_FINISHED",
        runId: event.runId,
        timestamp: timestamp(event),
        completionSignal: event.completionSignal,
        iterationsRun: event.iterationsRun,
      },
    ];
  }
  if (event.type === "run.error") {
    return [
      {
        type: "RUN_ERROR",
        runId: event.runId,
        timestamp: timestamp(event),
        message: event.message,
      },
    ];
  }
  if (event.type === "iteration.started") {
    return [
      {
        type: "STEP_STARTED",
        runId: event.runId,
        timestamp: timestamp(event),
        stepName: `iteration.${event.iteration}`,
        iteration: event.iteration,
      },
    ];
  }
  if (event.type === "iteration.finished") {
    return [
      {
        type: "STEP_FINISHED",
        runId: event.runId,
        timestamp: timestamp(event),
        stepName: `iteration.${event.iteration}`,
        iteration: event.iteration,
        sessionId: event.sessionId,
      },
    ];
  }
  if (event.type === "message.delta") {
    return [
      {
        type: "TEXT_MESSAGE_CONTENT",
        runId: event.runId,
        timestamp: timestamp(event),
        messageId: event.messageId,
        delta: event.text,
      },
    ];
  }
  if (event.type === "tool.call") {
    return [
      {
        type: "TOOL_CALL_START",
        runId: event.runId,
        timestamp: timestamp(event),
        toolCallId: event.toolCallId,
        toolName: event.name,
      },
      {
        type: "TOOL_CALL_ARGS",
        runId: event.runId,
        timestamp: timestamp(event),
        toolCallId: event.toolCallId,
        args: event.args,
      },
      {
        type: "TOOL_CALL_END",
        runId: event.runId,
        timestamp: timestamp(event),
        toolCallId: event.toolCallId,
      },
    ];
  }
  if (event.type === "raw") {
    return [
      {
        type: "RAW",
        runId: event.runId,
        timestamp: timestamp(event),
        line: event.line,
      },
    ];
  }
  if (event.type === "usage.recorded") {
    return [
      {
        type: "CUSTOM",
        runId: event.runId,
        timestamp: timestamp(event),
        name: "sandcastle.usage.recorded",
        value: {
          iteration: event.iteration,
          model: event.model,
          usage: event.usage,
        },
      },
    ];
  }
  if (event.type === "commit.created") {
    return [
      {
        type: "CUSTOM",
        runId: event.runId,
        timestamp: timestamp(event),
        name: "sandcastle.commits.created",
        value: { commits: [{ sha: event.sha }] },
      },
    ];
  }
  return [];
};
