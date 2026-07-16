import assert from "node:assert/strict";
import type {
  DepartmentInspect,
  DepartmentPipelineEditorView,
} from "../interface.js";

export const scriptedSoftwareRndDepartment: DepartmentInspect = {
  id: "software-rnd",
  name: "Software R&D",
  description:
    "Turns product goals into reviewed and verified software delivery.",
  status: "active",
  revision: 0,
  builtIn: true,
  activeRuns: 0,
  createdAt: "2026-07-14T00:00:00.000Z",
  inputArtifactContracts: [],
  outputArtifactContracts: [],
  defaultExecutionProfileId: "software-rnd-default",
  executionProfiles: [
    {
      id: "software-rnd-default",
      departmentId: "software-rnd",
      name: "Software R&D Default",
      providerRef: "default-agent",
      model: "default",
      sandboxRef: "no-sandbox",
      branchStrategy: "head",
      limits: {
        timeoutSeconds: 1800,
        maxIterations: 10,
        maxTokens: null,
      },
      retryPolicy: { maxAttempts: 1 },
      permissionPolicy: "ask",
      secretReferenceIds: [],
      revision: 0,
      status: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      archivedAt: null,
    },
  ],
  secretReferences: [],
  positions: [
    {
      id: "product-planner",
      name: "Product Planner",
      responsibility:
        "Aligns product goals and turns requirements into reviewed plan inputs.",
      defaultAgentId: "codex",
      revision: 0,
      status: "active",
      aiMember: {
        id: "product-planner-member",
        displayName: "Product Planner",
        profile: "",
        responsibilityMetadata: {},
        status: "active",
        positionId: "product-planner",
      },
    },
    {
      id: "software-architect",
      name: "Software Architect",
      responsibility:
        "Produces the technical plan and repository-level delivery shape.",
      defaultAgentId: "codex",
      revision: 0,
      status: "active",
      aiMember: {
        id: "software-architect-member",
        displayName: "Software Architect",
        profile: "",
        responsibilityMetadata: {},
        status: "active",
        positionId: "software-architect",
      },
    },
    {
      id: "software-engineer",
      name: "Software Engineer",
      responsibility: "Implements and tests the approved delivery plan.",
      defaultAgentId: "codex",
      revision: 0,
      status: "active",
      aiMember: {
        id: "software-engineer-member",
        displayName: "Software Engineer",
        profile: "",
        responsibilityMetadata: {},
        status: "active",
        positionId: "software-engineer",
      },
    },
    {
      id: "reviewer",
      name: "Reviewer",
      responsibility: "Independently reviews implementation and delivery risk.",
      defaultAgentId: "codex",
      revision: 0,
      status: "active",
      aiMember: {
        id: "reviewer-member",
        displayName: "Reviewer",
        profile: "",
        responsibilityMetadata: {},
        status: "active",
        positionId: "reviewer",
      },
    },
    {
      id: "evaluator",
      name: "Evaluator",
      responsibility: "Verifies acceptance criteria against recorded evidence.",
      defaultAgentId: "codex",
      revision: 0,
      status: "active",
      aiMember: {
        id: "evaluator-member",
        displayName: "Evaluator",
        profile: "",
        responsibilityMetadata: {},
        status: "active",
        positionId: "evaluator",
      },
    },
  ],
  pipeline: {
    id: "software-rnd-pipeline-production-v1",
    version: 2,
    status: "published",
    publishedAt: "2026-07-15T00:00:00.000Z",
    nodes: [
      { id: "start", type: "start", name: "Start" },
      {
        id: "product-alignment",
        type: "ai-task",
        name: "Product alignment",
        positionId: "product-planner",
      },
      {
        id: "technical-plan",
        type: "ai-task",
        name: "Technical plan",
        positionId: "software-architect",
      },
      {
        id: "plan-approval",
        type: "human-approval",
        name: "Plan approval",
        positionId: "product-planner",
      },
      {
        id: "repository-execution",
        type: "parallel",
        name: "Repository execution",
      },
      {
        id: "implementation",
        type: "ai-task",
        name: "Implementation",
        positionId: "software-engineer",
      },
      { id: "join", type: "join", name: "Join" },
      {
        id: "review",
        type: "ai-task",
        name: "Review",
        positionId: "reviewer",
      },
      {
        id: "verification",
        type: "ai-task",
        name: "Verification",
        positionId: "evaluator",
      },
      {
        id: "human-acceptance",
        type: "human-approval",
        name: "Human acceptance",
        positionId: "evaluator",
      },
      { id: "complete", type: "complete", name: "Complete" },
    ],
    edges: [
      { from: "start", to: "product-alignment" },
      { from: "product-alignment", to: "technical-plan" },
      { from: "technical-plan", to: "plan-approval" },
      { from: "plan-approval", to: "repository-execution" },
      { from: "repository-execution", to: "implementation" },
      { from: "implementation", to: "join" },
      { from: "join", to: "review" },
      { from: "review", to: "verification" },
      { from: "verification", to: "human-acceptance" },
      { from: "human-acceptance", to: "complete" },
    ],
  },
};

export const assertSoftwareRndDepartmentContract = (
  department: DepartmentInspect,
): void => {
  assert.equal(department.id, "software-rnd");
  assert.equal(department.builtIn, true);
  assert.deepEqual(
    department.positions.map((position) => ({
      id: position.id,
      memberPositionId: position.aiMember.positionId,
    })),
    scriptedSoftwareRndDepartment.positions.map((position) => ({
      id: position.id,
      memberPositionId: position.id,
    })),
  );
  assert.ok(department.pipeline);
  assert.ok(scriptedSoftwareRndDepartment.pipeline);
  assert.equal(department.pipeline.id, "software-rnd-pipeline-production-v1");
  assert.equal(department.pipeline.version, 2);
  assert.equal(department.pipeline.status, "published");
  assert.deepEqual(
    department.pipeline.nodes.map((node) => node.id),
    scriptedSoftwareRndDepartment.pipeline.nodes.map((node) => node.id),
  );
  assert.deepEqual(
    department.pipeline.edges,
    scriptedSoftwareRndDepartment.pipeline.edges,
  );
};

const scriptedPipelineGraph = scriptedSoftwareRndDepartment.pipeline
  ? {
      nodes: scriptedSoftwareRndDepartment.pipeline.nodes,
      edges: scriptedSoftwareRndDepartment.pipeline.edges,
    }
  : { nodes: [], edges: [] };

export const scriptedSoftwareRndPipelineEditor: DepartmentPipelineEditorView = {
  department: { id: "software-rnd", name: "Software R&D" },
  positions: scriptedSoftwareRndDepartment.positions.map((position) => ({
    id: position.id,
    name: position.name,
  })),
  draft: { revision: 0, graph: scriptedPipelineGraph, updatedAt: null },
  validation: { valid: true, issues: [] },
  published: {
    id: "software-rnd-pipeline-production-v1",
    version: 2,
    graph: scriptedPipelineGraph,
    hash: "a".repeat(64),
    publishedAt: "2026-07-15T00:00:00.000Z",
  },
  history: [
    {
      id: "software-rnd-pipeline-production-v1",
      version: 2,
      graph: scriptedPipelineGraph,
      hash: "a".repeat(64),
      publishedAt: "2026-07-15T00:00:00.000Z",
      nodeCount: scriptedPipelineGraph.nodes.length,
      edgeCount: scriptedPipelineGraph.edges.length,
    },
    {
      id: "software-rnd-pipeline-v1",
      version: 1,
      graph: scriptedPipelineGraph,
      hash: "a".repeat(64),
      publishedAt: "2026-07-14T00:00:00.000Z",
      nodeCount: scriptedPipelineGraph.nodes.length,
      edgeCount: scriptedPipelineGraph.edges.length,
    },
  ],
};
