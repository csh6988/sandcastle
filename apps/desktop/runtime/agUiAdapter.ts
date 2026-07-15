import type { RuntimeEventRecord } from "./pipeline/pipelineRuntime.js";

export interface AgUiEvent {
  readonly type:
    | "RUN_STARTED"
    | "RUN_FINISHED"
    | "RUN_ERROR"
    | "STEP_STARTED"
    | "STEP_FINISHED"
    | "TEXT_MESSAGE_CONTENT"
    | "PERMISSION_REQUESTED"
    | "PERMISSION_DECIDED"
    | "ARTIFACT_CREATED"
    | "RAW_RUNTIME_EVENT";
  readonly runId: string | null;
  readonly eventId: string;
  readonly sequence: number;
  readonly payload: unknown;
}

export class AgUiCursorExpiredError extends Error {
  readonly code = "AG_UI_CURSOR_EXPIRED";

  constructor(afterSequence: number, earliestSequence: number) {
    super(
      `AG-UI cursor ${afterSequence} is older than the retained Runtime event sequence ${earliestSequence}.`,
    );
    this.name = "AgUiCursorExpiredError";
  }
}

const typeByRuntimeEvent: Readonly<Record<string, AgUiEvent["type"]>> = {
  "run.created": "RUN_STARTED",
  "run.completed": "RUN_FINISHED",
  "run.failed": "RUN_ERROR",
  "run.paused": "STEP_FINISHED",
  "run.resumed": "STEP_STARTED",
  "session.message.created": "TEXT_MESSAGE_CONTENT",
  "session.message.delta": "TEXT_MESSAGE_CONTENT",
  "permission.requested": "PERMISSION_REQUESTED",
  "permission.decided": "PERMISSION_DECIDED",
  "artifact.version.created": "ARTIFACT_CREATED",
};

export const runtimeEventToAgUi = (event: RuntimeEventRecord): AgUiEvent => ({
  type: typeByRuntimeEvent[event.type] ?? "RAW_RUNTIME_EVENT",
  runId: event.runId,
  eventId: event.eventId,
  sequence: event.sequence,
  payload: event.payload,
});

export const replayRuntimeEventsAsAgUi = (
  events: readonly RuntimeEventRecord[],
  input: {
    readonly afterSequence: number;
    readonly earliestRetainedSequence?: number;
  },
): { readonly events: readonly AgUiEvent[]; readonly nextSequence: number } => {
  const sorted = [...events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const earliest = input.earliestRetainedSequence ?? sorted[0]?.sequence;
  if (
    earliest !== undefined &&
    input.afterSequence < earliest - 1 &&
    input.afterSequence !== 0
  ) {
    throw new AgUiCursorExpiredError(input.afterSequence, earliest);
  }
  const selected = sorted.filter(
    (event) => event.sequence > input.afterSequence,
  );
  const batched = selected.reduce<RuntimeEventRecord[]>((result, event) => {
    if (event.type !== "session.message.delta") {
      result.push(event);
      return result;
    }
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : null;
    const previous = result.at(-1);
    const previousPayload =
      previous?.type === "session.message.delta" &&
      typeof previous.payload === "object" &&
      previous.payload !== null
        ? (previous.payload as Record<string, unknown>)
        : null;
    const sameStream =
      previousPayload &&
      payload &&
      previousPayload.sessionId === payload.sessionId &&
      previousPayload.participantId === payload.participantId &&
      typeof previousPayload.content === "string" &&
      typeof payload.content === "string";
    if (!sameStream || !previous) {
      result.push(event);
      return result;
    }
    result[result.length - 1] = {
      ...event,
      payload: {
        ...payload,
        content: `${previousPayload.content}${payload.content}`,
      },
    };
    return result;
  }, []);
  return {
    events: batched.map(runtimeEventToAgUi),
    nextSequence: selected.at(-1)?.sequence ?? input.afterSequence,
  };
};
