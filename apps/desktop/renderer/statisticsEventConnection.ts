import type { RuntimeEventFrame, SandcastleBridge } from "../preload/bridge.js";
import type {
  RuntimeSubscriptionHandle,
  ImprovementProposalView,
  StatisticsEvidenceSnapshotView,
  StatisticsInspectInput,
  StatisticsView,
} from "../runtime/interface.js";

type StatisticsEventBridge = Pick<
  SandcastleBridge,
  "query" | "execute" | "openEventStream" | "closeEventStream"
>;

export interface StatisticsEventConnection {
  readonly resync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const connectStatisticsEventStream = async (input: {
  readonly bridge: StatisticsEventBridge;
  readonly projectId: string;
  readonly query: StatisticsInspectInput;
  readonly evidenceSnapshotId: string | null;
  readonly onViews: (views: {
    readonly statistics: StatisticsView;
    readonly evidence: StatisticsEvidenceSnapshotView | null;
    readonly proposals: readonly ImprovementProposalView[];
  }) => void;
  readonly onDiagnostic: (diagnostic: string | null) => void;
}): Promise<StatisticsEventConnection> => {
  let closed = false;
  let handle: RuntimeSubscriptionHandle | null = null;
  let acknowledgedSequence = 0;
  let queue = Promise.resolve();
  let openingFrames: RuntimeEventFrame[] | null = null;

  const closeActive = async (): Promise<void> => {
    const active = handle;
    handle = null;
    if (active) await input.bridge.closeEventStream(active);
  };

  const queryViews = async () => {
    const [statistics, evidence, proposals] = await Promise.all([
      input.bridge.query({
        type: "statistics.inspect" as const,
        projectId: input.projectId,
        query: input.query,
      }),
      input.evidenceSnapshotId
        ? input.bridge.query({
            type: "statistics-evidence.inspect" as const,
            evidenceSnapshotId: input.evidenceSnapshotId,
          })
        : Promise.resolve(null),
      input.bridge.query({
        type: "improvement-proposals.list" as const,
        projectId: input.projectId,
      }),
    ]);
    return { statistics, evidence, proposals };
  };

  const acknowledge = async (inputSequence: {
    readonly sequence: number;
    readonly viewSyncToken?: string;
    readonly subscriptionGeneration?: number;
  }): Promise<void> => {
    const result = await input.bridge.execute({
      commandId: globalThis.crypto.randomUUID(),
      command: {
        type: "ack-runtime-events",
        sequence: inputSequence.sequence,
        ...(inputSequence.viewSyncToken
          ? { viewSyncToken: inputSequence.viewSyncToken }
          : {}),
        ...(inputSequence.subscriptionGeneration === undefined
          ? {}
          : {
              subscriptionGeneration: inputSequence.subscriptionGeneration,
            }),
      },
    });
    if (result.status === "rejected") throw new Error(result.error.message);
    acknowledgedSequence = inputSequence.sequence;
  };

  const refresh = async (): Promise<void> => {
    const next = await queryViews();
    if (closed) return;
    input.onViews({
      statistics: next.statistics.view,
      evidence: next.evidence?.view ?? null,
      proposals: next.proposals.view,
    });
  };

  const synchronize = async (): Promise<void> => {
    await closeActive();
    const next = await queryViews();
    if (closed) return;
    const anchor =
      next.evidence && next.evidence.asOfSequence < next.statistics.asOfSequence
        ? next.evidence
        : next.statistics;
    if (!anchor.viewSyncToken) {
      throw new Error(
        "Statistics synchronization requires an authoritative View token.",
      );
    }
    input.onViews({
      statistics: next.statistics.view,
      evidence: next.evidence?.view ?? null,
      proposals: next.proposals.view,
    });
    await acknowledge({
      sequence: anchor.asOfSequence,
      viewSyncToken: anchor.viewSyncToken,
    });
    if (closed) return;
    const onFrame = (frame: RuntimeEventFrame): Promise<void> => {
      if (openingFrames !== null && handle === null) {
        openingFrames.push(frame);
        return Promise.resolve();
      }
      queue = queue.then(async () => {
        if (
          closed ||
          !handle ||
          frame.subscriptionGeneration !== handle.subscriptionGeneration ||
          frame.value.kind !== "event"
        ) {
          return;
        }
        const event = frame.value.event;
        if (event.sequence <= acknowledgedSequence) return;
        if (event.sequence !== acknowledgedSequence + 1) {
          throw new Error(
            `Runtime event sequence ${event.sequence} is not contiguous after ${acknowledgedSequence}.`,
          );
        }
        if (
          (event.type === "statistics.evidence.invalidated" ||
            event.type === "improvement.proposal.invalidated") &&
          event.projectId === input.projectId
        ) {
          await refresh();
        }
        await acknowledge({
          sequence: event.sequence,
          subscriptionGeneration: frame.subscriptionGeneration,
        });
        input.onDiagnostic(null);
      });
      void queue.catch(async (error: unknown) => {
        input.onDiagnostic(
          error instanceof Error
            ? `Runtime unavailable; Statistics resync required: ${error.message}`
            : "Runtime unavailable; Statistics resync required.",
        );
        await closeActive();
      });
      return queue;
    };
    openingFrames = [];
    handle = await input.bridge.openEventStream(onFrame);
    const pendingFrames = openingFrames;
    openingFrames = null;
    for (const frame of pendingFrames) await onFrame(frame);
  };

  await synchronize();
  return {
    resync: synchronize,
    close: async () => {
      closed = true;
      await queue;
      await closeActive();
    },
  };
};
