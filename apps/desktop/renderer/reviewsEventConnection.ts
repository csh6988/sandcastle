import type {
  AcceptedDeliveryCandidateAuthorityView,
  CandidateQualityGateView,
  DeliveryCandidateView,
  IntegrationGenerationView,
  ReleaseOperationView,
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
  readonly acceptedDeliveryAuthority: AcceptedDeliveryCandidateAuthorityView | null;
  readonly releaseOperations: readonly ReleaseOperationView[];
};

export type ReviewsStageSnapshot = Omit<ReviewsStageViews, "generation">;

export interface ReviewsEventConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectReviewsEventStream = async (input: {
  readonly bridge: ReviewsEventBridge;
  readonly runId: string;
  readonly candidateInputId: string | null;
  readonly candidateId: string | null;
  readonly onInitialViews: (views: ReviewsStageSnapshot) => void;
  readonly onViews: (views: ReviewsStageViews) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<ReviewsEventConnection> => {
  let closed = false;
  let generation = 0;
  let acknowledgedSequence = 0;
  let handle: RuntimeSubscriptionHandle | null = null;
  let eventQueue = Promise.resolve();
  let synchronizationQueue = Promise.resolve();
  let openingFrames: RuntimeEventFrame[] | null = null;
  let latest: Omit<ReviewsStageViews, "generation"> = {
    integrationGenerations: [],
    candidateQuality: null,
    deliveryCandidate: null,
    acceptedDeliveryAuthority: null,
    releaseOperations: [],
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
  const queryRelease = async (candidate: DeliveryCandidateView | null) => {
    if (!candidate || candidate.projection !== "accepted") {
      return { authority: null, operations: null };
    }
    const [authority, operations] = await Promise.all([
      input.bridge.query({
        type: "accepted-delivery-authority.inspect" as const,
        candidateId: candidate.id,
      }),
      input.bridge.query({
        type: "release-operations.list" as const,
        candidateId: candidate.id,
      }),
    ]);
    return { authority, operations };
  };

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
    const nextDeliveryCandidate =
      deliveryCandidate === null
        ? latest.deliveryCandidate
        : (deliveryCandidate?.view ?? null);
    const release = stages.deliveryCandidate
      ? await queryRelease(nextDeliveryCandidate)
      : { authority: null, operations: null };
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
      acceptedDeliveryAuthority:
        release.authority === null
          ? stages.deliveryCandidate
            ? null
            : latest.acceptedDeliveryAuthority
          : release.authority.view,
      releaseOperations:
        release.operations === null
          ? stages.deliveryCandidate
            ? []
            : latest.releaseOperations
          : release.operations.view,
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
    if (openingFrames !== null && handle === null) {
      openingFrames.push(frame);
      return Promise.resolve();
    }
    eventQueue = eventQueue.then(() => applyEventFrame(frame));
    return eventQueue;
  };

  const synchronize = async (): Promise<void> => {
    await closeActive();
    await eventQueue;
    if (closed) return;
    const [integration, candidateQuality, deliveryCandidate] =
      await Promise.all([
        queryIntegration(),
        queryCandidateQuality(),
        queryDeliveryCandidate(),
      ]);
    const release = await queryRelease(deliveryCandidate?.view ?? null);
    if (closed) return;
    const snapshots = [
      integration,
      candidateQuality,
      deliveryCandidate,
      release.authority,
      release.operations,
    ].filter(
      (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
    );
    const anchor = snapshots.reduce((earliest, snapshot) =>
      snapshot.asOfSequence < earliest.asOfSequence ? snapshot : earliest,
    );
    if (!anchor.viewSyncToken) {
      throw new Error(
        "Reviews synchronization requires a View token for the earliest stage Query.",
      );
    }
    latest = {
      integrationGenerations: integration.view,
      candidateQuality: candidateQuality?.view ?? null,
      deliveryCandidate: deliveryCandidate?.view ?? null,
      acceptedDeliveryAuthority: release.authority?.view ?? null,
      releaseOperations: release.operations?.view ?? [],
    };
    input.onInitialViews(latest);
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
    const acknowledgedGeneration = acknowledgement.value.subscriptionGeneration;
    acknowledgedSequence = acknowledgement.value.barrierSequence;
    openingFrames = [];
    let opened: RuntimeSubscriptionHandle;
    try {
      opened = await input.bridge.openEventStream(handleEventFrame);
    } finally {
      if (closed) openingFrames = null;
    }
    if (closed) {
      await input.bridge.closeEventStream(opened);
      return;
    }
    if (
      opened.subscriptionGeneration !== acknowledgedGeneration + 1 ||
      opened.barrierSequence !== acknowledgedSequence
    ) {
      openingFrames = null;
      await input.bridge.closeEventStream(opened);
      throw new Error(
        `Reviews event stream opened at generation ${opened.subscriptionGeneration} / barrier ${opened.barrierSequence} after View acknowledgement generation ${acknowledgedGeneration} / barrier ${acknowledgedSequence}.`,
      );
    }
    handle = opened;
    generation = opened.subscriptionGeneration;
    if (openingFrames === null) {
      throw new Error(
        "Reviews event stream opening buffer was unavailable after open.",
      );
    }
    const bufferedFrames = openingFrames;
    openingFrames = null;
    for (const frame of bufferedFrames) void handleEventFrame(frame);
    await eventQueue;
    input.onDiagnostic(null);
  };

  const queueSynchronization = (): Promise<void> => {
    const result = synchronizationQueue.then(synchronize);
    synchronizationQueue = result.catch(() => undefined);
    return result;
  };

  await queueSynchronization();
  return {
    resync: async () => {
      try {
        await queueSynchronization();
      } catch (error) {
        await fail(error);
      }
    },
    close: async () => {
      closed = true;
      await synchronizationQueue;
      await closeActive();
      await eventQueue;
    },
  };
};
