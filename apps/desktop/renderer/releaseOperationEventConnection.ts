import type {
  AcceptedDeliveryCandidateAuthorityView,
  DeliveryCandidateView,
  ReleaseOperationView,
  RuntimeSubscriptionHandle,
} from "../runtime/interface.js";
import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";

type ReleaseOperationBridge = Pick<
  SandcastleBridge,
  "execute" | "openEventStream" | "closeEventStream"
> & {
  readonly query: {
    (query: {
      readonly type: "delivery-candidates.inspect";
      readonly candidateId: string;
    }): Promise<{
      readonly view: DeliveryCandidateView;
      readonly asOfSequence: number;
      readonly viewSyncToken?: string;
    }>;
    (query: {
      readonly type: "accepted-delivery-authority.inspect";
      readonly candidateId: string;
    }): Promise<{
      readonly view: AcceptedDeliveryCandidateAuthorityView;
      readonly asOfSequence: number;
      readonly viewSyncToken?: string;
    }>;
    (query: {
      readonly type: "release-operations.list";
      readonly candidateId: string;
    }): Promise<{
      readonly view: readonly ReleaseOperationView[];
      readonly asOfSequence: number;
      readonly viewSyncToken?: string;
    }>;
  };
};

export type ReleaseOperationStageSnapshot = {
  readonly candidate: DeliveryCandidateView;
  readonly authority: AcceptedDeliveryCandidateAuthorityView | null;
  readonly operations: readonly ReleaseOperationView[];
};

export type ReleaseOperationStageViews = ReleaseOperationStageSnapshot & {
  readonly generation: number;
};

export interface ReleaseOperationEventConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectReleaseOperationEventStream = async (input: {
  readonly bridge: ReleaseOperationBridge;
  readonly candidateId: string;
  readonly onInitialViews: (views: ReleaseOperationStageSnapshot) => void;
  readonly onViews: (views: ReleaseOperationStageViews) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<ReleaseOperationEventConnection> => {
  let closed = false;
  let generation = 0;
  let acknowledgedSequence = 0;
  let handle: RuntimeSubscriptionHandle | null = null;
  let openingFrames: RuntimeEventFrame[] | null = null;
  let eventQueue = Promise.resolve();
  let synchronizationQueue = Promise.resolve();
  let latest: ReleaseOperationStageSnapshot | null = null;

  const closeActive = async (): Promise<void> => {
    const active = handle;
    handle = null;
    if (active) await input.bridge.closeEventStream(active);
  };
  const diagnostic = (error: unknown): string =>
    error instanceof Error
      ? `Runtime unavailable; Release operation resync required: ${error.message}`
      : "Runtime unavailable; Release operation resync required.";
  const fail = async (error: unknown): Promise<void> => {
    input.onDiagnostic(diagnostic(error));
    await closeActive();
  };
  const queryAll = async () => {
    const candidate = await input.bridge.query({
      type: "delivery-candidates.inspect" as const,
      candidateId: input.candidateId,
    });
    const [authority, operations] = await Promise.all([
      candidate.view.projection === "accepted"
        ? input.bridge.query({
            type: "accepted-delivery-authority.inspect" as const,
            candidateId: input.candidateId,
          })
        : Promise.resolve(null),
      input.bridge.query({
        type: "release-operations.list" as const,
        candidateId: input.candidateId,
      }),
    ]);
    return { candidate, authority, operations };
  };
  const toSnapshot = (
    result: Awaited<ReturnType<typeof queryAll>>,
  ): ReleaseOperationStageSnapshot => ({
    candidate: result.candidate.view,
    authority: result.authority?.view ?? null,
    operations: result.operations.view,
  });
  const refresh = async (
    frameGeneration: number,
    sequence: number,
  ): Promise<void> => {
    const result = await queryAll();
    if (
      closed ||
      !handle ||
      generation !== frameGeneration ||
      sequence !== acknowledgedSequence + 1
    )
      return;
    latest = toSnapshot(result);
    input.onViews({ generation: frameGeneration, ...latest });
  };
  const applyFrame = async (frame: RuntimeEventFrame): Promise<void> => {
    if (closed || !handle || frame.subscriptionGeneration !== generation)
      return;
    if (frame.value.kind === "control") {
      if (frame.value.control.type === "runtime.disconnected") {
        input.onDiagnostic(
          `${frame.value.control.code}: ${frame.value.control.message} Release operation resync required.`,
        );
      }
      return;
    }
    const { sequence } = frame.value.event;
    if (sequence <= acknowledgedSequence) return;
    if (sequence !== acknowledgedSequence + 1) {
      await fail(
        new Error(
          `Runtime event sequence ${sequence} is not contiguous after ${acknowledgedSequence}.`,
        ),
      );
      return;
    }
    try {
      await refresh(frame.subscriptionGeneration, sequence);
      if (
        closed ||
        !handle ||
        frame.subscriptionGeneration !== generation ||
        sequence !== acknowledgedSequence + 1
      )
        return;
      const acknowledgement = await input.bridge.execute({
        commandId: globalThis.crypto.randomUUID(),
        command: {
          type: "ack-runtime-events",
          sequence,
          subscriptionGeneration: frame.subscriptionGeneration,
        },
      });
      if (acknowledgement.status === "rejected")
        throw new Error(acknowledgement.error.message);
      if (
        acknowledgement.value.subscriptionGeneration !==
        frame.subscriptionGeneration
      ) {
        throw new Error(
          "Runtime event acknowledgement changed the active Release operation subscription generation.",
        );
      }
      acknowledgedSequence = sequence;
      input.onDiagnostic(null);
    } catch (error) {
      await fail(error);
    }
  };
  const handleFrame = (frame: RuntimeEventFrame): Promise<void> => {
    if (openingFrames !== null && handle === null) {
      openingFrames.push(frame);
      return Promise.resolve();
    }
    eventQueue = eventQueue.then(() => applyFrame(frame));
    return eventQueue;
  };
  const synchronize = async (): Promise<void> => {
    await closeActive();
    await eventQueue;
    if (closed) return;
    const result = await queryAll();
    if (closed) return;
    const snapshots = [
      result.candidate,
      result.operations,
      result.authority,
    ].filter(
      (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
    );
    const anchor = snapshots.reduce((earliest, snapshot) =>
      snapshot.asOfSequence < earliest.asOfSequence ? snapshot : earliest,
    );
    if (!anchor.viewSyncToken)
      throw new Error(
        "Release operation synchronization requires a View token for the earliest Query.",
      );
    latest = toSnapshot(result);
    input.onInitialViews(latest);
    const acknowledgement = await input.bridge.execute({
      commandId: globalThis.crypto.randomUUID(),
      command: {
        type: "ack-runtime-events",
        sequence: anchor.asOfSequence,
        viewSyncToken: anchor.viewSyncToken,
      },
    });
    if (acknowledgement.status === "rejected")
      throw new Error(acknowledgement.error.message);
    const acknowledgedGeneration = acknowledgement.value.subscriptionGeneration;
    acknowledgedSequence = acknowledgement.value.barrierSequence;
    openingFrames = [];
    const opened = await input.bridge.openEventStream(handleFrame);
    if (closed) {
      openingFrames = null;
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
        `Release operation event stream opened at generation ${opened.subscriptionGeneration} / barrier ${opened.barrierSequence} after View acknowledgement generation ${acknowledgedGeneration} / barrier ${acknowledgedSequence}.`,
      );
    }
    handle = opened;
    generation = opened.subscriptionGeneration;
    if (openingFrames === null)
      throw new Error(
        "Release operation event stream opening buffer was unavailable after open.",
      );
    const bufferedFrames = openingFrames;
    openingFrames = null;
    for (const frame of bufferedFrames) void handleFrame(frame);
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
