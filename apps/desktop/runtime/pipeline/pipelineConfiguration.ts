import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DepartmentPipelineDraftGraphSchema,
  DepartmentPipelineGraphSchema,
  type DepartmentPipelineDraftGraph,
  type DepartmentPipelineEditorView,
  type PipelineValidationResult,
} from "../interface.js";
import type { SkillConfiguration } from "../skill/skillConfiguration.js";
import { canonicalPipelineJson, pipelineHash } from "./canonicalPipeline.js";

export class PipelineConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineConfigurationError";
  }
}

export interface PipelineConfiguration {
  readonly inspect: (departmentId: string) => DepartmentPipelineEditorView;
  readonly validate: (input: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => PipelineValidationResult;
  readonly saveDraft: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly graph: DepartmentPipelineDraftGraph;
  }) => DepartmentPipelineEditorView;
  readonly publish: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => DepartmentPipelineEditorView;
}

const defaultGraph = (): DepartmentPipelineDraftGraph => ({
  nodes: [
    { id: "start", type: "start", name: "Start" },
    { id: "complete", type: "complete", name: "Complete" },
  ],
  edges: [{ from: "start", to: "complete" }],
});

export const openPipelineConfiguration = (
  database: DatabaseSync,
  skillConfiguration: SkillConfiguration,
): PipelineConfiguration => {
  const validate = ({
    departmentId,
    graph,
  }: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }): PipelineValidationResult => {
    const parsedGraph = DepartmentPipelineDraftGraphSchema.parse(graph);
    const issues: PipelineValidationResult["issues"] = [];
    const addIssue = (
      code: string,
      messageKey: string,
      details: {
        readonly nodeId?: string;
        readonly edge?: { readonly from: string; readonly to: string };
      } = {},
    ): void => {
      issues.push({ code, messageKey, ...details });
    };
    const nodesById = new Map(parsedGraph.nodes.map((node) => [node.id, node]));
    const starts = parsedGraph.nodes.filter((node) => node.type === "start");
    const completes = parsedGraph.nodes.filter(
      (node) => node.type === "complete",
    );
    if (starts.length !== 1) {
      addIssue("START_COUNT_INVALID", "pipeline.validation.startCount");
    }
    if (completes.length === 0) {
      addIssue("COMPLETE_REQUIRED", "pipeline.validation.completeRequired");
    }

    const allowedTypes = new Set([
      "start",
      "ai-task",
      "human-approval",
      "condition",
      "parallel",
      "join",
      "complete",
    ]);
    for (const node of parsedGraph.nodes) {
      if (!allowedTypes.has(node.type)) {
        addIssue(
          "NODE_TYPE_UNSUPPORTED",
          "pipeline.validation.nodeTypeUnsupported",
          { nodeId: node.id },
        );
      }
      if (node.skillFlowId && node.type !== "ai-task") {
        addIssue(
          "SKILL_FLOW_NOT_ALLOWED",
          "pipeline.validation.skillFlowNotAllowed",
          { nodeId: node.id },
        );
      }
    }

    const validEdges = parsedGraph.edges.filter((edge) => {
      const sourceExists = nodesById.has(edge.from);
      const targetExists = nodesById.has(edge.to);
      if (!sourceExists) {
        addIssue(
          "EDGE_SOURCE_NOT_FOUND",
          "pipeline.validation.edgeSourceNotFound",
          { edge },
        );
      }
      if (!targetExists) {
        addIssue(
          "EDGE_TARGET_NOT_FOUND",
          "pipeline.validation.edgeTargetNotFound",
          { edge },
        );
      }
      return sourceExists && targetExists;
    });
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const edge of validEdges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    }
    const reachableFrom = (initialIds: readonly string[]): Set<string> => {
      const reached = new Set<string>();
      const queue = [...initialIds];
      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId || reached.has(nodeId)) continue;
        reached.add(nodeId);
        queue.push(...(outgoing.get(nodeId) ?? []));
      }
      return reached;
    };
    const reachableFromStart = reachableFrom(starts.map((node) => node.id));
    for (const node of parsedGraph.nodes) {
      if (!reachableFromStart.has(node.id)) {
        addIssue("NODE_UNREACHABLE", "pipeline.validation.nodeUnreachable", {
          nodeId: node.id,
        });
      }
    }
    const canReachComplete = new Set<string>();
    const reverseQueue = completes.map((node) => node.id);
    while (reverseQueue.length > 0) {
      const nodeId = reverseQueue.shift();
      if (!nodeId || canReachComplete.has(nodeId)) continue;
      canReachComplete.add(nodeId);
      reverseQueue.push(...(incoming.get(nodeId) ?? []));
    }
    for (const node of parsedGraph.nodes) {
      if (node.type !== "complete" && !canReachComplete.has(node.id)) {
        addIssue(
          "NODE_CANNOT_REACH_COMPLETE",
          "pipeline.validation.nodeCannotReachComplete",
          { nodeId: node.id },
        );
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    let cycleNodeId: string | undefined;
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) {
        cycleNodeId = nodeId;
        return true;
      }
      if (visited.has(nodeId)) return false;
      visiting.add(nodeId);
      for (const next of outgoing.get(nodeId) ?? []) {
        if (visit(next)) return true;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };
    if (parsedGraph.nodes.some((node) => visit(node.id))) {
      addIssue("CYCLE_NOT_ALLOWED", "pipeline.validation.cycleNotAllowed", {
        ...(cycleNodeId ? { nodeId: cycleNodeId } : {}),
      });
    }

    const positions = database
      .prepare("SELECT id, department_id AS departmentId FROM positions")
      .all() as Array<{
      readonly id: string;
      readonly departmentId: string;
    }>;
    const positionDepartments = new Map(
      positions.map((position) => [position.id, position.departmentId]),
    );
    const positionStatuses = new Map(
      (
        database.prepare("SELECT id, status FROM positions").all() as Array<{
          readonly id: string;
          readonly status: "active" | "archived";
        }>
      ).map((position) => [position.id, position.status]),
    );
    const departmentConfiguration = database
      .prepare(
        `SELECT input_artifact_contracts_json AS inputContractsJson,
                output_artifact_contracts_json AS outputContractsJson
           FROM departments
          WHERE id = ?`,
      )
      .get(departmentId) as
      | {
          readonly inputContractsJson: string;
          readonly outputContractsJson: string;
        }
      | undefined;
    const contractIds = new Set<string>([
      ...(
        JSON.parse(
          departmentConfiguration?.inputContractsJson ?? "[]",
        ) as Array<{ readonly id: string }>
      ).map((contract) => contract.id),
      ...(
        JSON.parse(
          departmentConfiguration?.outputContractsJson ?? "[]",
        ) as Array<{ readonly id: string }>
      ).map((contract) => contract.id),
    ]);
    for (const node of parsedGraph.nodes) {
      if (node.type !== "ai-task" && node.type !== "human-approval") continue;
      if (!node.positionId) {
        addIssue("POSITION_REQUIRED", "pipeline.validation.positionRequired", {
          nodeId: node.id,
        });
        continue;
      }
      const ownerDepartmentId = positionDepartments.get(node.positionId);
      if (!ownerDepartmentId) {
        addIssue("POSITION_NOT_FOUND", "pipeline.validation.positionNotFound", {
          nodeId: node.id,
        });
      } else if (ownerDepartmentId !== departmentId) {
        addIssue(
          "POSITION_OUTSIDE_DEPARTMENT",
          "pipeline.validation.positionOutsideDepartment",
          { nodeId: node.id },
        );
      } else if (positionStatuses.get(node.positionId) === "archived") {
        addIssue("POSITION_ARCHIVED", "pipeline.validation.positionArchived", {
          nodeId: node.id,
        });
      }
      if (node.type === "ai-task" && node.skillFlowId && node.positionId) {
        const code = skillConfiguration.validatePipelineSelection({
          departmentId,
          positionId: node.positionId,
          skillFlowId: node.skillFlowId,
        });
        if (code) {
          const messageKeys = {
            SKILL_FLOW_NOT_FOUND: "pipeline.validation.skillFlowNotFound",
            SKILL_FLOW_ARCHIVED: "pipeline.validation.skillFlowArchived",
            SKILL_FLOW_OUTSIDE_DEPARTMENT:
              "pipeline.validation.skillFlowOutsideDepartment",
            SKILL_FLOW_POSITION_MISMATCH:
              "pipeline.validation.skillFlowPositionMismatch",
          } as const;
          addIssue(code, messageKeys[code], { nodeId: node.id });
        }
      }
      if (node.type === "ai-task") {
        if (node.executionProfileId) {
          const profile = database
            .prepare(
              `SELECT department_id AS departmentId, status
                 FROM execution_profiles
                WHERE id = ?`,
            )
            .get(node.executionProfileId) as
            | {
                readonly departmentId: string;
                readonly status: "active" | "archived";
              }
            | undefined;
          if (!profile) {
            addIssue(
              "EXECUTION_PROFILE_NOT_FOUND",
              "pipeline.validation.executionProfileNotFound",
              { nodeId: node.id },
            );
          } else if (profile.departmentId !== departmentId) {
            addIssue(
              "EXECUTION_PROFILE_OUTSIDE_DEPARTMENT",
              "pipeline.validation.executionProfileOutsideDepartment",
              { nodeId: node.id },
            );
          } else if (profile.status === "archived") {
            addIssue(
              "EXECUTION_PROFILE_ARCHIVED",
              "pipeline.validation.executionProfileArchived",
              { nodeId: node.id },
            );
          }
        }
        for (const contractId of node.inputContractRefs ?? []) {
          if (!contractIds.has(contractId)) {
            addIssue(
              "INPUT_CONTRACT_NOT_FOUND",
              "pipeline.validation.inputContractNotFound",
              { nodeId: node.id },
            );
          }
        }
        for (const contractId of node.outputContractRefs ?? []) {
          if (!contractIds.has(contractId)) {
            addIssue(
              "OUTPUT_CONTRACT_NOT_FOUND",
              "pipeline.validation.outputContractNotFound",
              { nodeId: node.id },
            );
          }
        }
        if (node.timeoutSeconds !== undefined && node.timeoutSeconds <= 0) {
          addIssue("TIMEOUT_INVALID", "pipeline.validation.timeoutInvalid", {
            nodeId: node.id,
          });
        }
        if (node.retryMaxAttempts !== undefined && node.retryMaxAttempts < 0) {
          addIssue(
            "RETRY_POLICY_INVALID",
            "pipeline.validation.retryPolicyInvalid",
            { nodeId: node.id },
          );
        }
        if (node.maxIterations !== undefined && node.maxIterations <= 0) {
          addIssue("LIMITS_INVALID", "pipeline.validation.limitsInvalid", {
            nodeId: node.id,
          });
        }
        if (
          node.maxTokens !== undefined &&
          node.maxTokens !== null &&
          node.maxTokens <= 0
        ) {
          addIssue("LIMITS_INVALID", "pipeline.validation.limitsInvalid", {
            nodeId: node.id,
          });
        }
      }
      if (node.type === "human-approval") {
        const approvalFields = [
          node.approvalTitle,
          node.approvalPolicy,
          node.approverReference,
        ];
        if (
          approvalFields.some((value) => value !== undefined) &&
          approvalFields.some(
            (value) => value === undefined || String(value).trim() === "",
          )
        ) {
          addIssue(
            "APPROVAL_CONFIGURATION_INCOMPLETE",
            "pipeline.validation.approvalConfigurationIncomplete",
            { nodeId: node.id },
          );
        }
      }
    }

    for (const node of parsedGraph.nodes) {
      if (node.type !== "condition") {
        if (node.condition) {
          addIssue(
            "CONDITION_CONFIGURATION_NOT_ALLOWED",
            "pipeline.validation.conditionConfigurationNotAllowed",
            { nodeId: node.id },
          );
        }
        continue;
      }
      if (!node.condition) {
        addIssue(
          "CONDITION_CONFIGURATION_REQUIRED",
          "pipeline.validation.conditionConfigurationRequired",
          { nodeId: node.id },
        );
        continue;
      }
      const snapshotReference =
        /^snapshot\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(
          node.condition.leftReference,
        );
      const nodeReference = node.condition.leftReference.match(
        /^nodes\.([A-Za-z0-9_-]+)\.result\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
      );
      if (
        !snapshotReference &&
        (!nodeReference ||
          !nodesById.has(nodeReference[1]!) ||
          !reachableFrom([nodeReference[1]!]).has(node.id))
      ) {
        addIssue(
          "CONDITION_REFERENCE_INVALID",
          "pipeline.validation.conditionReferenceInvalid",
          { nodeId: node.id },
        );
      }
      const branchIds = node.condition.branches.map((branch) => branch.id);
      if (new Set(branchIds).size !== branchIds.length) {
        addIssue(
          "CONDITION_BRANCH_DUPLICATE",
          "pipeline.validation.conditionBranchDuplicate",
          { nodeId: node.id },
        );
      }
      const branchKinds = node.condition.branches.map((branch) => branch.kind);
      if (new Set(branchKinds).size !== branchKinds.length) {
        addIssue(
          "CONDITION_BRANCH_KIND_DUPLICATE",
          "pipeline.validation.conditionBranchKindDuplicate",
          { nodeId: node.id },
        );
      }
      if (
        !node.condition.branches.some((branch) => branch.kind === "default")
      ) {
        addIssue(
          "CONDITION_DEFAULT_BRANCH_REQUIRED",
          "pipeline.validation.conditionDefaultBranchRequired",
          { nodeId: node.id },
        );
      }
      for (const edge of validEdges.filter((edge) => edge.from === node.id)) {
        if (!edge.branchId) {
          addIssue(
            "CONDITION_BRANCH_REQUIRED",
            "pipeline.validation.conditionBranchRequired",
            { nodeId: node.id, edge },
          );
        } else if (!branchIds.includes(edge.branchId)) {
          addIssue(
            "CONDITION_BRANCH_NOT_FOUND",
            "pipeline.validation.conditionBranchNotFound",
            { nodeId: node.id, edge },
          );
        }
      }
    }

    const joinIds = parsedGraph.nodes
      .filter((node) => node.type === "join")
      .map((node) => node.id);
    for (const node of parsedGraph.nodes) {
      if (node.type === "parallel") {
        const branches = outgoing.get(node.id) ?? [];
        if (branches.length < 1) {
          addIssue(
            "PARALLEL_BRANCHES_REQUIRED",
            "pipeline.validation.parallelBranchesRequired",
            { nodeId: node.id },
          );
        } else {
          const branchReachability = branches.map((branch) =>
            reachableFrom([branch]),
          );
          const hasSharedJoin = joinIds.some((joinId) =>
            branchReachability.every((reached) => reached.has(joinId)),
          );
          if (!hasSharedJoin) {
            addIssue(
              "PARALLEL_JOIN_REQUIRED",
              "pipeline.validation.parallelJoinRequired",
              { nodeId: node.id },
            );
          }
        }
      }
      if (node.type === "join" && (incoming.get(node.id) ?? []).length < 1) {
        addIssue(
          "JOIN_BRANCHES_REQUIRED",
          "pipeline.validation.joinBranchesRequired",
          { nodeId: node.id },
        );
      }
    }

    return { valid: issues.length === 0, issues };
  };

  const inspect = (departmentId: string): DepartmentPipelineEditorView => {
    const department = database
      .prepare(
        "SELECT id, name, active_pipeline_version_id AS activePipelineVersionId FROM departments WHERE id = ?",
      )
      .get(departmentId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly activePipelineVersionId: string | null;
        }
      | undefined;
    if (!department) {
      throw new Error(`Department ${departmentId} was not found.`);
    }

    const positions = (
      database
        .prepare(
          "SELECT id, name FROM positions WHERE department_id = ? ORDER BY sort_order, id",
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly name: string;
      }>
    ).map((position) => ({ ...position }));
    const versions = (
      database
        .prepare(
          `SELECT id, version, graph_json AS graphJson, hash, published_at AS publishedAt
             FROM pipeline_versions
            WHERE department_id = ?
         ORDER BY version DESC`,
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly version: number;
        readonly graphJson: string;
        readonly hash: string;
        readonly publishedAt: string;
      }>
    ).map((version) => ({
      ...version,
      graph: DepartmentPipelineGraphSchema.parse(JSON.parse(version.graphJson)),
    }));
    const current = versions.find(
      (version) => version.id === department.activePipelineVersionId,
    );
    const draftRow = database
      .prepare(
        "SELECT revision, graph_json AS graphJson, updated_at AS updatedAt FROM pipeline_drafts WHERE department_id = ?",
      )
      .get(departmentId) as
      | {
          readonly revision: number;
          readonly graphJson: string;
          readonly updatedAt: string;
        }
      | undefined;
    const draftGraph = draftRow
      ? DepartmentPipelineDraftGraphSchema.parse(JSON.parse(draftRow.graphJson))
      : (current?.graph ?? defaultGraph());
    const validation = validate({ departmentId, graph: draftGraph });

    return {
      department: { id: department.id, name: department.name },
      positions,
      draft: {
        revision: Number(draftRow?.revision ?? 0),
        graph: draftGraph,
        updatedAt: draftRow?.updatedAt ?? null,
      },
      validation,
      published: current
        ? {
            id: current.id,
            version: Number(current.version),
            graph: current.graph,
            hash: current.hash,
            publishedAt: current.publishedAt,
          }
        : null,
      history: versions.map((version) => ({
        id: version.id,
        version: Number(version.version),
        graph: version.graph,
        hash: version.hash,
        publishedAt: version.publishedAt,
        nodeCount: version.graph.nodes.length,
        edgeCount: version.graph.edges.length,
      })),
    };
  };

  return {
    inspect,
    validate,
    saveDraft: ({ departmentId, expectedRevision, graph }) => {
      inspect(departmentId);
      const parsedGraph = DepartmentPipelineDraftGraphSchema.parse(graph);
      const current = database
        .prepare("SELECT revision FROM pipeline_drafts WHERE department_id = ?")
        .get(departmentId) as { readonly revision: number } | undefined;
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== expectedRevision) {
        throw new PipelineConfigurationError(
          "VERSION_CONFLICT",
          `Pipeline Draft revision ${expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }

      const nextRevision = currentRevision + 1;
      const updatedAt = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO pipeline_drafts(
             department_id, revision, graph_json, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(department_id) DO UPDATE SET
             revision = excluded.revision,
             graph_json = excluded.graph_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          departmentId,
          nextRevision,
          canonicalPipelineJson(parsedGraph),
          updatedAt,
        );
      return inspect(departmentId);
    },
    publish: ({ departmentId, expectedRevision }) => {
      const draft = database
        .prepare(
          "SELECT revision, graph_json AS graphJson FROM pipeline_drafts WHERE department_id = ?",
        )
        .get(departmentId) as
        | { readonly revision: number; readonly graphJson: string }
        | undefined;
      if (!draft) {
        throw new PipelineConfigurationError(
          "DRAFT_NOT_FOUND",
          `Department ${departmentId} has no saved Pipeline Draft.`,
        );
      }
      const currentRevision = Number(draft.revision);
      if (currentRevision !== expectedRevision) {
        throw new PipelineConfigurationError(
          "VERSION_CONFLICT",
          `Pipeline Draft revision ${expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const draftGraph = DepartmentPipelineDraftGraphSchema.parse(
        JSON.parse(draft.graphJson),
      );
      const validation = validate({ departmentId, graph: draftGraph });
      if (!validation.valid) {
        throw new PipelineConfigurationError(
          "PIPELINE_INVALID",
          "Pipeline Draft failed server-side validation.",
        );
      }
      const skillFlows = skillConfiguration.inspect(departmentId).skillFlows;
      const graph = DepartmentPipelineGraphSchema.parse({
        ...draftGraph,
        nodes: draftGraph.nodes.map((node) => {
          if (node.type !== "ai-task" || !node.skillFlowId) return node;
          const flow = skillFlows.find(
            (candidate) => candidate.id === node.skillFlowId,
          );
          if (!flow || flow.status !== "active") {
            throw new PipelineConfigurationError(
              "PIPELINE_INVALID",
              `Skill Flow ${node.skillFlowId} could not be frozen for publication.`,
            );
          }
          return {
            ...node,
            skillFlowSnapshot: {
              id: flow.id,
              revision: flow.revision,
              name: flow.name,
              instructions: flow.instructions,
              skillIds: flow.skillIds,
            },
          };
        }),
      });
      const graphJson = canonicalPipelineJson(graph);
      const hash = pipelineHash(graph);
      const id = randomUUID();
      const publishedAt = new Date().toISOString();

      database.exec("BEGIN IMMEDIATE");
      try {
        const currentDraft = database
          .prepare(
            "SELECT revision FROM pipeline_drafts WHERE department_id = ?",
          )
          .get(departmentId) as { readonly revision: number } | undefined;
        if (Number(currentDraft?.revision ?? 0) !== expectedRevision) {
          throw new PipelineConfigurationError(
            "VERSION_CONFLICT",
            `Pipeline Draft revision ${expectedRevision} changed before publish.`,
          );
        }
        const nextVersion =
          Number(
            (
              database
                .prepare(
                  "SELECT MAX(version) AS version FROM pipeline_versions WHERE department_id = ?",
                )
                .get(departmentId) as { readonly version: number | null }
            ).version ?? 0,
          ) + 1;
        database
          .prepare(
            `INSERT INTO pipeline_versions(
               id, department_id, version, status, graph_json, published_at, hash
             ) VALUES (?, ?, ?, 'published', ?, ?, ?)`,
          )
          .run(id, departmentId, nextVersion, graphJson, publishedAt, hash);
        database
          .prepare(
            "UPDATE departments SET active_pipeline_version_id = ? WHERE id = ?",
          )
          .run(id, departmentId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(departmentId);
    },
  };
};
