import type {
  CandidateQualityGateView,
  RuntimeSubscriptionHandle,
} from "../runtime/interface.js";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";

type CandidateQualityGateBridge = Pick<
  SandcastleBridge,
  "query" | "execute" | "openEventStream" | "closeEventStream"
>;

export interface CandidateQualityGateConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectCandidateQualityGates = async (input: {
  readonly bridge: CandidateQualityGateBridge;
  readonly candidateInputId: string;
  readonly onView: (view: CandidateQualityGateView) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<CandidateQualityGateConnection> => {
  let closed = false;
  let generation = 0;
  let acknowledgedSequence = 0;
  let handle: RuntimeSubscriptionHandle | null = null;
  let eventQueue = Promise.resolve();

  const closeActive = async (): Promise<void> => {
    const active = handle;
    handle = null;
    if (active) await input.bridge.closeEventStream(active);
  };

  const fail = async (error: unknown): Promise<void> => {
    input.onDiagnostic(
      error instanceof Error
        ? `Runtime unavailable; Candidate Quality Gate resync required: ${error.message}`
        : "Runtime unavailable; Candidate Quality Gate resync required.",
    );
    await closeActive();
  };

  const queryView = () =>
    input.bridge.query({
      type: "quality-gates.inspect" as const,
      candidateInputId: input.candidateInputId,
    });

  const synchronize = async (): Promise<void> => {
    await closeActive();
    if (closed) return;
    const result = await queryView();
    if (closed) return;
    input.onView(result.view);
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
    } else {
      generation += 1;
    }
    const opened = await input.bridge.openEventStream((frame) => {
      eventQueue = eventQueue.then(async () => {
        if (
          closed ||
          !handle ||
          frame.subscriptionGeneration !== generation ||
          frame.value.kind === "control"
        ) {
          return;
        }
        const event = frame.value.event;
        if (event.sequence <= acknowledgedSequence) return;
        if (event.sequence !== acknowledgedSequence + 1) {
          await fail(
            new Error(
              `Runtime event sequence ${event.sequence} is not contiguous after ${acknowledgedSequence}.`,
            ),
          );
          return;
        }
        try {
          if (event.deliveryCandidateInputId === input.candidateInputId) {
            const refreshed = await queryView();
            if (closed || frame.subscriptionGeneration !== generation) return;
            input.onView(refreshed.view);
          }
          const acknowledgement = await input.bridge.execute({
            commandId: globalThis.crypto.randomUUID(),
            command: {
              type: "ack-runtime-events",
              sequence: event.sequence,
              subscriptionGeneration: frame.subscriptionGeneration,
            },
          });
          if (acknowledgement.status === "rejected") {
            throw new Error(acknowledgement.error.message);
          }
          acknowledgedSequence = event.sequence;
          input.onDiagnostic(null);
        } catch (error) {
          await fail(error);
        }
      });
      return eventQueue;
    });
    if (closed) {
      await input.bridge.closeEventStream(opened);
      return;
    }
    handle = opened;
    generation = opened.subscriptionGeneration;
    acknowledgedSequence = opened.barrierSequence;
    input.onDiagnostic(null);
  };

  await synchronize();
  return {
    resync: async () => {
      try {
        await synchronize();
      } catch (error) {
        await fail(error);
      }
    },
    close: async () => {
      closed = true;
      await closeActive();
    },
  };
};
