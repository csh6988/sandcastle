import type { RunSnapshotPayload } from "../interface.js";
import type {
  ExecutionAdapter,
  ExecutionAdapterInput,
  ExecutionFact,
} from "./scriptedExecutionAdapter.js";
import type {
  AdapterExecutionFact,
  ExecutionCompletion,
  ExecutionEventSink,
  FormalExecutionRequest,
} from "../execution/contract.js";

export type SoftwareDevelopmentHandler =
  | "product-goal-alignment"
  | "technical-plan"
  | "repository-implementation"
  | "independent-review"
  | "delivery-verification";

export interface SoftwareDevelopmentExecutionInput {
  readonly handler: SoftwareDevelopmentHandler;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly signal: AbortSignal;
  readonly node: RunSnapshotPayload["pipelineVersion"]["graph"]["nodes"][number];
  readonly project: RunSnapshotPayload["project"];
  readonly department: RunSnapshotPayload["department"];
  readonly position: RunSnapshotPayload["positions"][number];
  readonly aiMember: RunSnapshotPayload["positions"][number]["aiMember"];
  readonly skillFlow: RunSnapshotPayload["skillFlows"][number] & {
    readonly positionId: string;
  };
  readonly executionProfile: RunSnapshotPayload["executionProfiles"][number];
  readonly memoryEntries: ExecutionAdapterInput["memoryEntries"];
  readonly agentAdapterId: string;
  readonly attempt: ExecutionAdapterInput["attempt"];
  readonly request?: FormalExecutionRequest;
}

export interface SoftwareDevelopmentExecutionPort {
  readonly execute: (
    input: SoftwareDevelopmentExecutionInput,
  ) => Promise<ExecutionFact>;
}

const handlerByNodeId: Readonly<Record<string, SoftwareDevelopmentHandler>> = {
  "product-alignment": "product-goal-alignment",
  "technical-plan": "technical-plan",
  implementation: "repository-implementation",
  review: "independent-review",
  verification: "delivery-verification",
};

const failure = (code: string, message: string): ExecutionFact => ({
  kind: "failed",
  code,
  message,
});

export const createProductionExecutionAdapter = (
  port: SoftwareDevelopmentExecutionPort,
): ExecutionAdapter => {
  const runPort = async (
    input: ExecutionAdapterInput,
  ): Promise<ExecutionFact> => {
    const handler = handlerByNodeId[input.node.id];
    const formalRequest =
      input.request?.sideEffectPolicy === "formal" ? input.request : undefined;
    const resolvedHandler = formalRequest?.immutableContext.workPackage
      ? "repository-implementation"
      : handler;
    if (!resolvedHandler) {
      return failure(
        "PRODUCTION_NODE_HANDLER_NOT_FOUND",
        `No Software Development handler is registered for Pipeline node ${input.node.id}.`,
      );
    }
    const assignment = formalRequest?.immutableContext.workPackage;
    const position = input.snapshot.positions.find((candidate) =>
      assignment
        ? candidate.id === assignment.positionId &&
          candidate.aiMember.id === assignment.aiMemberId
        : candidate.id === input.node.positionId,
    );
    if (!position || position.aiMember.status !== "active") {
      return failure(
        "PRODUCTION_NODE_CONFIGURATION_INVALID",
        `Pipeline node ${input.node.id} has no active Position and AI Member in the Snapshot.`,
      );
    }
    const executionProfileId =
      input.node.executionProfileId ??
      input.snapshot.department.defaultExecutionProfileId;
    const executionProfile = input.snapshot.executionProfiles.find(
      (candidate) => candidate.id === executionProfileId,
    );
    if (!executionProfile) {
      return failure(
        "PRODUCTION_NODE_CONFIGURATION_INVALID",
        `Pipeline node ${input.node.id} has no Execution Profile in the Snapshot.`,
      );
    }
    const skillFlowSnapshot = input.node.skillFlowSnapshot;
    if (!skillFlowSnapshot) {
      return failure(
        "PRODUCTION_NODE_CONFIGURATION_INVALID",
        `Pipeline node ${input.node.id} has no frozen Skill Flow in the Snapshot.`,
      );
    }
    try {
      return await port.execute({
        handler: resolvedHandler,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        signal: input.signal,
        node: input.node,
        project: input.snapshot.project,
        department: input.snapshot.department,
        position,
        aiMember: position.aiMember,
        skillFlow: { ...skillFlowSnapshot, positionId: position.id },
        executionProfile,
        memoryEntries: input.memoryEntries,
        agentAdapterId:
          formalRequest?.agentAdapterId ?? executionProfile.providerRef,
        attempt: input.attempt,
        ...(formalRequest ? { request: formalRequest } : {}),
      });
    } catch {
      return failure(
        "PRODUCTION_EXECUTION_FAILED",
        `Software Development handler ${resolvedHandler} failed without exposing provider output.`,
      );
    }
  };

  const persistFact = async (
    sink: ExecutionEventSink,
    fact: AdapterExecutionFact,
  ) => {
    const receipt = await sink.record(fact);
    if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
      throw new Error(
        `Production Execution Fact ${fact.factId} was ${receipt.status}.`,
      );
    }
    return receipt;
  };

  return {
    maxConcurrentNodes: 4,
    capabilities: {
      reattachRunningOperation: false,
      strongExecutionFence: false,
      enforceNoSideEffects: false,
    },
    execute: async (input, sink) => {
      if (!input.request || !sink) return runPort(input);
      await persistFact(sink, {
        adapterSchemaVersion: 1,
        factId: "provider-started",
        ordinal: 1,
        kind: "provider-started",
        schemaVersion: 1,
        payload: { providerExecutionRef: input.request.operationKey },
        evidenceRefs: [],
      });
      const result = await runPort(input);
      const terminal: AdapterExecutionFact =
        result.kind === "succeeded"
          ? {
              adapterSchemaVersion: 1,
              factId: "terminal",
              ordinal: 2,
              kind: "completed",
              schemaVersion: 1,
              payload: {
                structuredResult: result.structuredResult,
                artifacts: result.artifacts,
              },
              evidenceRefs: [],
            }
          : {
              adapterSchemaVersion: 1,
              factId: "terminal",
              ordinal: 2,
              kind: "failed",
              schemaVersion: 1,
              payload: { code: result.code, message: result.message },
              evidenceRefs: [],
            };
      const receipt = await persistFact(sink, terminal);
      return {
        operationKey: input.request.operationKey,
        terminalExecutionFactId: receipt.executionFactId,
        status: result.kind === "succeeded" ? "succeeded" : "failed",
        evidenceRefs: terminal.evidenceRefs,
      } satisfies ExecutionCompletion;
    },
    cancel: async () => "unknown",
    fence: async () => ({ status: "unsupported" }),
    reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
    reattach: async () => {
      throw new Error(
        "Production execution port does not support reattachment.",
      );
    },
  };
};
