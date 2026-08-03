import type {
  CandidateQualityGateView,
  DeliveryCandidateView,
  IntegrationGenerationView,
  RuntimeSubscriptionHandle,
} from "../runtime/interface.js";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";

type ReviewsEventBridge = Pick<
  SandcastleBridge,
  "query" | "execute" | "openEventStream" | "closeEventStream"
>;

export type ReviewsStageViews = {
  readonly generation: number;
  readonly integrationGenerations: readonly IntegrationGenerationView[];
  readonly candidateQuality: CandidateQualityGateView | null;
  readonly deliveryCandidate: DeliveryCandidateView | null;
};

export interface ReviewsEventConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectReviewsEventStream = async (input: {
  readonly bridge: ReviewsEventBridge;
  readonly runId: string;
  readonly candidateInputId: string | null;
  readonly candidateId: string | null;
  readonly onViews: (views: ReviewsStageViews) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<ReviewsEventConnection> => {
  let closed = false;
  let generation = 0;
  let acknowledgedSequence = 0;
  let handle: RuntimeSubscriptionHandle | null = null;
  let eventQueue = Promise.resolve();
  let latest: Omit<ReviewsStageViews, "generation"> = {
    integrationGenerations: [],
    candidateQuality: null,
    deliveryCandidate: null,
  };

  const closeActive = async (): Promise<void> => {
    const active = handle;
    handle = null;
    if (active) await input.bridge.closeEventStream(active);
  };

  const diagnosticMessage = (error: unknown): string =>
    error instanceof Error
      ? `Runtime unavailable; Reviews resync required: ${error.message}`
      : "Runtime unavailable; Reviews resync required.";

  const fail = async (error: unknown): Promise<void> => {
    input.onDiagnostic(diagnosticMessage(error));
    await closeActive();
  };

  const queryIntegration = () =>
    input.bridge.query({
      type: "integration-generations.inspect" as const,
      runId: input.runId,
    });
  const queryCandidateQuality = () =>
    input.candidateInputId
      ? input.bridge.query({
          type: "quality-gates.inspect" as const,
          candidateInputId: input.candidateInputId,
        })
      : Promise.resolve(null);
  const queryDeliveryCandidate = () =>
    input.candidateId
      ? input.bridge.query({
          type: "delivery-candidates.inspect" as const,
          candidateId: input.candidateId,
        })
      : Promise.resolve(null);

  const refreshViews = async (
    frameGeneration: number,
    stages: {
      readonly integration: boolean;
      readonly candidateQuality: boolean;
      readonly deliveryCandidate: boolean;
    },
  ): Promise<void> => {
    const [integration, candidateQuality, deliveryCandidate] =
      await Promise.all([
        stages.integration ? queryIntegration() : null,
        stages.candidateQuality ? queryCandidateQuality() : null,
        stages.deliveryCandidate ? queryDeliveryCandidate() : null,
      ]);
    if (closed || frameGeneration !== generation || !handle) return;
    latest = {
      integrationGenerations:
        integration?.view ?? latest.integrationGenerations,
      candidateQuality:
        candidateQuality === null
          ? latest.candidateQuality
          : candidateQuality.view,
      deliveryCandidate:
        deliveryCandidate === null
          ? latest.deliveryCandidate
          : deliveryCandidate.view,
    };
    input.onViews({ generation: frameGeneration, ...latest });
  };

  const applyEventFrame = async (frame: RuntimeEventFrame): Promise<void> => {
    if (closed || !handle || frame.subscriptionGeneration !== generation) {
      return;
    }
    if (frame.value.kind === "control") {
      if (frame.value.control.type === "runtime.disconnected") {
        input.onDiagnostic(
          `${frame.value.control.code}: ${frame.value.control.message} Reviews resync required.`,
        );
      }
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
      await refreshViews(frame.subscriptionGeneration, {
        integration: event.runId === input.runId,
        candidateQuality:
          input.candidateInputId !== null &&
          event.deliveryCandidateInputId === input.candidateInputId,
        deliveryCandidate:
          input.candidateId !== null &&
          event.deliveryCandidateId === input.candidateId,
      });
      if (
        closed ||
        !handle ||
        frame.subscriptionGeneration !== generation ||
        event.sequence !== acknowledgedSequence + 1
      ) {
        return;
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
      if (
        acknowledgement.value.subscriptionGeneration !==
        frame.subscriptionGeneration
      ) {
        throw new Error(
          "Runtime event acknowledgement changed the active Reviews subscription generation.",
        );
      }
      acknowledgedSequence = event.sequence;
      input.onDiagnostic(null);
    } catch (error) {
      await fail(error);
    }
  };

  const handleEventFrame = (frame: RuntimeEventFrame): Promise<void> => {
    eventQueue = eventQueue.then(() => applyEventFrame(frame));
    return eventQueue;
  };

  const synchronize = async (): Promise<void> => {
    await closeActive();
    if (closed) return;
    const anchorStage = input.candidateId
      ? "delivery-candidate"
      : input.candidateInputId
        ? "candidate-quality"
        : "integration";
    const anchor =
      anchorStage === "delivery-candidate"
        ? await queryDeliveryCandidate()
        : anchorStage === "candidate-quality"
          ? await queryCandidateQuality()
          : await queryIntegration();
    if (closed || anchor === null) return;
    if (anchor.viewSyncToken) {
      const acknowledgement = await input.bridge.execute({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "ack-runtime-events",
          sequence: anchor.asOfSequence,
          viewSyncToken: anchor.viewSyncToken,
        },
      });
      if (acknowledgement.status === "rejected") {
        throw new Error(acknowledgement.error.message);
      }
      generation = acknowledgement.value.subscriptionGeneration;
    } else {
      generation += 1;
    }
    const opened = await input.bridge.openEventStream(handleEventFrame);
    if (closed) {
      await input.bridge.closeEventStream(opened);
      return;
    }
    handle = opened;
    generation = opened.subscriptionGeneration;
    acknowledgedSequence = opened.barrierSequence;
    latest =
      anchorStage === "delivery-candidate"
        ? {
            ...latest,
            deliveryCandidate: anchor.view as DeliveryCandidateView,
          }
        : anchorStage === "candidate-quality"
          ? {
              ...latest,
              candidateQuality: anchor.view as CandidateQualityGateView,
            }
          : {
              ...latest,
              integrationGenerations:
                anchor.view as readonly IntegrationGenerationView[],
            };
    await refreshViews(generation, {
      integration: anchorStage !== "integration",
      candidateQuality:
        input.candidateInputId !== null && anchorStage !== "candidate-quality",
      deliveryCandidate:
        input.candidateId !== null && anchorStage !== "delivery-candidate",
    });
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
