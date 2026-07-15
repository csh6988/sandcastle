import type { RunSnapshotPayload } from "../interface.js";
import type {
  ExecutionAdapter,
  ExecutionAdapterInput,
  ExecutionFact,
} from "./scriptedExecutionAdapter.js";

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
  readonly attempt: ExecutionAdapterInput["attempt"];
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
): ExecutionAdapter => ({
  maxConcurrentNodes: 4,
  execute: async (input) => {
    const handler = handlerByNodeId[input.node.id];
    if (!handler) {
      return failure(
        "PRODUCTION_NODE_HANDLER_NOT_FOUND",
        `No Software Development handler is registered for Pipeline node ${input.node.id}.`,
      );
    }
    const position = input.snapshot.positions.find(
      (candidate) => candidate.id === input.node.positionId,
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
        handler,
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
        attempt: input.attempt,
      });
    } catch {
      return failure(
        "PRODUCTION_EXECUTION_FAILED",
        `Software Development handler ${handler} failed without exposing provider output.`,
      );
    }
  },
});
