import type {
  IntegrationGenerationView,
  RuntimeSubscriptionHandle,
} from "../runtime/interface.js";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";

export type IntegrationGenerationFrame = {
  readonly generation: number;
  readonly view: readonly IntegrationGenerationView[];
};

export type IntegrationGenerationState = {
  readonly generation: number;
  readonly view: readonly IntegrationGenerationView[];
};

export const applyIntegrationGenerationFrame = (
  state: IntegrationGenerationState,
  frame: IntegrationGenerationFrame,
): IntegrationGenerationState =>
  frame.generation < state.generation
    ? state
    : { generation: frame.generation, view: frame.view };

type IntegrationGenerationBridge = Pick<
  SandcastleBridge,
  "query" | "execute" | "openEventStream" | "closeEventStream"
>;

export interface IntegrationGenerationConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectIntegrationGenerations = async (input: {
  readonly bridge: IntegrationGenerationBridge;
  readonly runId: string;
  readonly onFrame: (frame: IntegrationGenerationFrame) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<IntegrationGenerationConnection> => {
  let closed = false;
  let generation = 0;
  let handle: RuntimeSubscriptionHandle | null = null;
  let latestView: readonly IntegrationGenerationView[] = [];
  let acknowledgedSequence = 0;
  let eventQueue = Promise.resolve();

  const diagnosticMessage = (error: unknown): string =>
    error instanceof Error
      ? `Runtime unavailable; Integration resync required: ${error.message}`
      : "Runtime unavailable; Integration resync required.";

  const queryView = async (
    frameGeneration: number,
    frameSequence?: number,
  ): Promise<void> => {
    const result = await input.bridge.query({
      type: "integration-generations.inspect",
      runId: input.runId,
    });
    if (
      closed ||
      frameGeneration !== generation ||
      (frameSequence !== undefined &&
        frameSequence !== acknowledgedSequence + 1)
    ) {
      return;
    }
    latestView = result.view;
    input.onFrame({ generation: frameGeneration, view: result.view });
  };

  const terminateStream = async (
    frameGeneration: number,
    error: unknown,
  ): Promise<void> => {
    if (closed || frameGeneration !== generation) return;
    const active = handle;
    handle = null;
    input.onDiagnostic(diagnosticMessage(error));
    if (active) await input.bridge.closeEventStream(active);
  };

  const applyEventFrame = async (frame: RuntimeEventFrame): Promise<void> => {
    if (closed || !handle || frame.subscriptionGeneration !== generation) {
      return;
    }
    if (frame.value.kind === "control") {
      if (frame.value.control.type === "runtime.disconnected") {
        input.onDiagnostic(
          `${frame.value.control.code}: ${frame.value.control.message} Integration resync required.`,
        );
      }
      return;
    }
    const sequence = frame.value.event.sequence;
    if (sequence <= acknowledgedSequence) return;
    if (sequence !== acknowledgedSequence + 1) {
      await terminateStream(
        frame.subscriptionGeneration,
        new Error(
          `Runtime event sequence ${sequence} is not contiguous after ${acknowledgedSequence}.`,
        ),
      );
      return;
    }
    try {
      if (frame.value.event.runId === input.runId) {
        await queryView(frame.subscriptionGeneration, sequence);
      }
      if (
        closed ||
        !handle ||
        frame.subscriptionGeneration !== generation ||
        sequence !== acknowledgedSequence + 1
      ) {
        return;
      }
      const acknowledgement = await input.bridge.execute({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "ack-runtime-events",
          sequence,
          subscriptionGeneration: frame.subscriptionGeneration,
        },
      });
      if (acknowledgement.status === "rejected") {
        throw new Error(acknowledgement.error.message);
      }
      if (
        acknowledgement.value.subscriptionGeneration !==
        frame.subscriptionGeneration
      ) {
        throw new Error(
          "Runtime event acknowledgement changed the active subscription generation.",
        );
      }
      acknowledgedSequence = sequence;
      input.onDiagnostic(null);
    } catch (error) {
      await terminateStream(frame.subscriptionGeneration, error);
    }
  };

  const handleEventFrame = (frame: RuntimeEventFrame): Promise<void> => {
    eventQueue = eventQueue.then(() => applyEventFrame(frame));
    return eventQueue;
  };

  const synchronize = async (): Promise<void> => {
    const previous = handle;
    handle = null;
    if (previous) await input.bridge.closeEventStream(previous);
    if (closed) return;

    const result = await input.bridge.query({
      type: "integration-generations.inspect",
      runId: input.runId,
    });
    if (closed) return;
    latestView = result.view;
    const provisionalGeneration = generation + 1;
    input.onFrame({ generation: provisionalGeneration, view: result.view });

    if (result.viewSyncToken) {
      const acknowledgement = await input.bridge.execute({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "ack-runtime-events",
          sequence: result.asOfSequence,
          viewSyncToken: result.viewSyncToken,
        },
      });
      if (acknowledgement.status === "rejected") {
        throw new Error(acknowledgement.error.message);
      }
      generation = acknowledgement.value.subscriptionGeneration;
      input.onFrame({ generation, view: result.view });
    } else {
      generation = provisionalGeneration;
    }

    const opened = await input.bridge.openEventStream(handleEventFrame);
    if (closed) {
      await input.bridge.closeEventStream(opened);
      return;
    }
    handle = opened;
    generation = opened.subscriptionGeneration;
    acknowledgedSequence = opened.barrierSequence;
    input.onFrame({ generation, view: latestView });
    input.onDiagnostic(null);
  };

  await synchronize();
  return {
    resync: async () => {
      try {
        await synchronize();
      } catch (error) {
        input.onDiagnostic(diagnosticMessage(error));
      }
    },
    close: async () => {
      closed = true;
      const active = handle;
      handle = null;
      if (active) await input.bridge.closeEventStream(active);
    },
  };
};
