import { createHash } from "node:crypto";
import { canonicalPipelineJson } from "./canonicalPipeline.js";

export type PipelineNodeType =
  | "start"
  | "ai-task"
  | "human-approval"
  | "condition"
  | "parallel"
  | "join"
  | "complete";

export interface NodeHandlerDefinition {
  readonly handlerKindId: string;
  readonly nodeType: PipelineNodeType;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
}

export interface NodeHandlerRegistry {
  readonly version: number;
  readonly hash: string;
  readonly definitions: readonly NodeHandlerDefinition[];
  readonly resolve: (
    nodeType: PipelineNodeType,
    handlerKindId?: string,
  ) => NodeHandlerDefinition | undefined;
}

const schemaHash = (handlerKindId: string, direction: "input" | "output") =>
  createHash("sha256")
    .update(`sandcastle.pipeline.${handlerKindId}.${direction}`)
    .digest("hex");

const handler = (
  handlerKindId: string,
  nodeType: PipelineNodeType,
  hashes: Partial<
    Pick<NodeHandlerDefinition, "inputSchemaHash" | "outputSchemaHash">
  > = {},
): NodeHandlerDefinition => ({
  handlerKindId,
  nodeType,
  inputSchemaHash: hashes.inputSchemaHash ?? schemaHash(handlerKindId, "input"),
  outputSchemaHash:
    hashes.outputSchemaHash ?? schemaHash(handlerKindId, "output"),
});

const definitions = [
  handler("run-start@1", "start", {
    inputSchemaHash:
      "7cf6ccb929565b4ee33d61da9495b90346ca6fd51af2f0b951afc267ad185a9d",
    outputSchemaHash:
      "054457d8154bfb5834b25b4527d67289fd4e1a433f57725a75c7f1eb3c3e7015",
  }),
  handler("ai-task@1", "ai-task"),
  handler("project-spec@1", "ai-task"),
  handler("review-topic@1", "ai-task"),
  handler("readiness@1", "ai-task"),
  handler("technical-design@1", "ai-task"),
  handler("development@1", "ai-task"),
  handler("code-review@1", "ai-task"),
  handler("integration@1", "ai-task"),
  handler("test@1", "ai-task"),
  handler("delivery-candidate-input@1", "ai-task"),
  handler("security-review@1", "ai-task"),
  handler("operability-review@1", "ai-task"),
  handler("delivery-candidate@1", "ai-task"),
  handler("human-approval@1", "human-approval"),
  handler("human-release@1", "human-approval"),
  handler("governed-intervention@1", "human-approval"),
  handler("gate-route@1", "condition"),
  handler("risk-route@1", "condition"),
  handler("contract-route@1", "condition"),
  handler("work-package-fan-out@1", "parallel"),
  handler("package-join@1", "join"),
  handler("integration-join@1", "join"),
  handler("quality-join@1", "join"),
  handler("run-complete@1", "complete", {
    inputSchemaHash:
      "d2f68f16780c653b4d5741c571ac8ff7cc8819f2e9f5cc48623a8e986118d0d6",
    outputSchemaHash:
      "43ca94b560c403b3826f61fe67d6893762fc538cf6f7834502b9b43adbe30da0",
  }),
] as const satisfies readonly NodeHandlerDefinition[];

const defaultHandlerKinds: Readonly<Record<PipelineNodeType, string>> = {
  start: "run-start@1",
  "ai-task": "ai-task@1",
  "human-approval": "human-approval@1",
  condition: "gate-route@1",
  parallel: "work-package-fan-out@1",
  join: "package-join@1",
  complete: "run-complete@1",
};

export const createNodeHandlerRegistry = (
  availableHandlerKindIds: readonly string[] = definitions.map(
    (definition) => definition.handlerKindId,
  ),
): NodeHandlerRegistry => {
  const available = new Set(availableHandlerKindIds);
  const registered = definitions.filter((definition) =>
    available.has(definition.handlerKindId),
  );
  const byId = new Map(
    registered.map((definition) => [definition.handlerKindId, definition]),
  );
  return {
    version: 1,
    hash: createHash("sha256")
      .update(canonicalPipelineJson(registered))
      .digest("hex"),
    definitions: registered,
    resolve: (nodeType, handlerKindId) => {
      const definition = byId.get(
        handlerKindId ?? defaultHandlerKinds[nodeType],
      );
      return definition?.nodeType === nodeType ? definition : undefined;
    },
  };
};

export const defaultNodeHandlerRegistry = createNodeHandlerRegistry();
