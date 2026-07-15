import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { DepartmentPipelineDraftGraphSchema } from "../interface.js";
import { PipelineConfigurationError } from "./pipelineConfiguration.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-pipeline-configuration-"));

describe("Pipeline Configuration", () => {
  it("inspects the built-in published Pipeline as an editable revision zero Draft", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const editor = database.pipelineConfiguration.inspect("software-rnd");

      assert.equal(editor.department.id, "software-rnd");
      assert.equal(editor.department.name, "Software R&D");
      assert.equal(editor.draft.revision, 0);
      assert.equal(editor.draft.updatedAt, null);
      assert.deepEqual(
        editor.draft.graph.nodes.map((node) => node.id),
        editor.published?.graph.nodes.map((node) => node.id),
      );
      assert.equal(editor.validation.valid, true);
      assert.deepEqual(editor.validation.issues, []);
      assert.equal(editor.published?.version, 2);
      assert.match(editor.published?.hash ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(
        editor.history.map((version) => version.version),
        [2, 1],
      );
    } finally {
      database.close();
    }
  });

  it("saves a persistent Draft revision without changing the published Pipeline Version", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const before = database.pipelineConfiguration.inspect("software-rnd");
      const graph = {
        ...before.draft.graph,
        nodes: before.draft.graph.nodes.map((node) =>
          node.id === "technical-plan"
            ? { ...node, name: "Architecture plan" }
            : node,
        ),
      };

      const saved = database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });

      assert.equal(saved.draft.revision, 1);
      assert.equal(
        saved.draft.graph.nodes.find((node) => node.id === "technical-plan")
          ?.name,
        "Architecture plan",
      );
      assert.ok(saved.draft.updatedAt);
      assert.deepEqual(saved.published, before.published);
      assert.equal(
        database.pipelineConfiguration.inspect("software-rnd").draft.revision,
        1,
      );
    } finally {
      database.close();
    }
  });

  it("returns stable validation codes for invalid graph structure and Position references", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const unsupported = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [{ id: "mystery", type: "script", name: "Mystery" }],
          edges: [{ from: "missing-source", to: "missing-target" }],
        },
      });
      assert.deepEqual(
        unsupported.issues.map((issue) => issue.code),
        [
          "START_COUNT_INVALID",
          "COMPLETE_REQUIRED",
          "NODE_TYPE_UNSUPPORTED",
          "EDGE_SOURCE_NOT_FOUND",
          "EDGE_TARGET_NOT_FOUND",
          "NODE_UNREACHABLE",
          "NODE_CANNOT_REACH_COMPLETE",
        ],
      );
      assert.equal(
        unsupported.issues.every(
          (issue) =>
            issue.messageKey.startsWith("pipeline.validation.") &&
            !issue.messageKey.includes(" "),
        ),
        true,
      );
      assert.deepEqual(unsupported.issues[3]?.edge, {
        from: "missing-source",
        to: "missing-target",
      });

      const cycle = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "a",
              type: "ai-task",
              name: "A",
              positionId: "software-engineer",
            },
            {
              id: "b",
              type: "human-approval",
              name: "B",
              positionId: "reviewer",
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "a" },
            { from: "a", to: "b" },
            { from: "b", to: "a" },
            { from: "b", to: "complete" },
          ],
        },
      });
      assert.deepEqual(
        cycle.issues.map((issue) => issue.code),
        ["CYCLE_NOT_ALLOWED"],
      );

      const positions = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            { id: "task", type: "ai-task", name: "Task" },
            {
              id: "approval",
              type: "human-approval",
              name: "Approval",
              positionId: "missing-position",
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "task" },
            { from: "task", to: "approval" },
            { from: "approval", to: "complete" },
          ],
        },
      });
      assert.deepEqual(
        positions.issues.map((issue) => issue.code),
        ["POSITION_REQUIRED", "POSITION_NOT_FOUND"],
      );

      const copied = database.catalog.copyDepartment({
        departmentId: "software-rnd",
        name: "Delivery",
      });
      const outsidePosition = database.pipelineConfiguration.validate({
        departmentId: copied.id,
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "task",
              type: "ai-task",
              name: "Task",
              positionId: "software-engineer",
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "task" },
            { from: "task", to: "complete" },
          ],
        },
      });
      assert.deepEqual(
        outsidePosition.issues.map((issue) => issue.code),
        ["POSITION_OUTSIDE_DEPARTMENT"],
      );

      const parallel = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            { id: "parallel", type: "parallel", name: "Parallel" },
            { id: "join", type: "join", name: "Join" },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "parallel" },
            { from: "parallel", to: "complete" },
          ],
        },
      });
      assert.deepEqual(
        parallel.issues
          .map((issue) => issue.code)
          .filter((code) => code.includes("PARALLEL") || code.includes("JOIN")),
        ["PARALLEL_JOIN_REQUIRED", "JOIN_BRANCHES_REQUIRED"],
      );
    } finally {
      database.close();
    }
  });

  it("publishes a new immutable Pipeline Version with a canonical graph hash", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const before = database.pipelineConfiguration.inspect("software-rnd");
      const graph = {
        ...before.draft.graph,
        nodes: before.draft.graph.nodes.map((node) =>
          node.id === "review" ? { ...node, name: "Delivery review" } : node,
        ),
      };
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });

      const published = database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });

      assert.equal(published.draft.revision, 1);
      assert.equal(published.published?.version, 3);
      assert.notEqual(published.published?.id, before.published?.id);
      assert.match(published.published?.hash ?? "", /^[a-f0-9]{64}$/);
      assert.equal(
        published.published?.graph.nodes.find((node) => node.id === "review")
          ?.name,
        "Delivery review",
      );
      assert.deepEqual(
        published.history.map((version) => version.version),
        [3, 2, 1],
      );
      assert.deepEqual(published.history[1], {
        id: before.published?.id,
        version: before.published?.version,
        graph: before.published?.graph,
        hash: before.published?.hash,
        publishedAt: before.published?.publishedAt,
        nodeCount: before.published?.graph.nodes.length,
        edgeCount: before.published?.graph.edges.length,
      });
    } finally {
      database.close();
    }
  });

  it("rejects stale Draft saves with VERSION_CONFLICT without overwriting the current revision", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const graph =
        database.pipelineConfiguration.inspect("software-rnd").draft.graph;
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });

      assert.throws(
        () =>
          database.pipelineConfiguration.saveDraft({
            departmentId: "software-rnd",
            expectedRevision: 0,
            graph: {
              ...graph,
              nodes: graph.nodes.map((node) => ({
                ...node,
                name: `Overwritten ${node.name}`,
              })),
            },
          }),
        (error: unknown) =>
          error instanceof PipelineConfigurationError &&
          error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        database.pipelineConfiguration.inspect("software-rnd").draft.revision,
        1,
      );
    } finally {
      database.close();
    }
  });

  it("revalidates on publish and preserves the active version when the Draft is invalid", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: {
          nodes: [{ id: "complete", type: "complete", name: "Complete" }],
          edges: [],
        },
      });

      assert.throws(
        () =>
          database.pipelineConfiguration.publish({
            departmentId: "software-rnd",
            expectedRevision: 1,
          }),
        (error: unknown) =>
          error instanceof PipelineConfigurationError &&
          error.code === "PIPELINE_INVALID",
      );
      const editor = database.pipelineConfiguration.inspect("software-rnd");
      assert.equal(editor.published?.version, 2);
      assert.deepEqual(
        editor.history.map((version) => version.version),
        [2, 1],
      );
    } finally {
      database.close();
    }
  });

  it("publishes an optional AI Task Skill Flow selection without rewriting the previous Version", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const before = database.pipelineConfiguration.inspect("software-rnd");
      const alternateFlow = database.skillConfiguration
        .saveSkillFlow({
          departmentId: "software-rnd",
          positionId: "software-engineer",
          expectedRevision: 0,
          name: "Alternate implementation",
          instructions: "Use an alternate implementation workflow.",
          skillIds: ["tdd"],
        })
        .skillFlows.find((flow) => flow.name === "Alternate implementation");
      assert.ok(alternateFlow);
      assert.equal(
        before.published?.graph.nodes.find(
          (node) => node.id === "implementation",
        )?.skillFlowId,
        "implementation-flow",
      );
      const graph = {
        ...before.draft.graph,
        nodes: before.draft.graph.nodes.map((node) =>
          node.id === "implementation"
            ? { ...node, skillFlowId: alternateFlow.id }
            : node,
        ),
      };

      const saved = database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });
      assert.equal(saved.validation.valid, true);
      assert.equal(
        saved.draft.graph.nodes.find((node) => node.id === "implementation")
          ?.skillFlowId,
        alternateFlow.id,
      );

      const published = database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });
      assert.equal(
        published.published?.graph.nodes.find(
          (node) => node.id === "implementation",
        )?.skillFlowId,
        alternateFlow.id,
      );
      assert.equal(
        published.history[1]?.graph.nodes.find(
          (node) => node.id === "implementation",
        )?.skillFlowId,
        "implementation-flow",
      );
    } finally {
      database.close();
    }
  });

  it("freezes the selected Skill Flow configuration and Phase 1 AI Task fields in each published Version", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      database.catalog.updateDepartment({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Software R&D",
        description:
          "Turns product goals into reviewed and verified software delivery.",
        inputArtifactContracts: [
          {
            id: "task-input",
            name: "Task input",
            artifactType: "application/vnd.sandcastle.task+json",
            schemaVersion: "1",
            required: true,
          },
        ],
        outputArtifactContracts: [
          {
            id: "verified-delivery",
            name: "Verified delivery",
            artifactType: "application/vnd.sandcastle.delivery+json",
            schemaVersion: "1",
            required: true,
          },
        ],
        defaultExecutionProfileId: "software-rnd-default",
      });
      const before = database.pipelineConfiguration.inspect("software-rnd");
      const graph = {
        ...before.draft.graph,
        nodes: before.draft.graph.nodes.map((node) =>
          node.id === "implementation"
            ? {
                ...node,
                skillFlowId: "implementation-flow",
                instructions: "Implement the approved vertical slice.",
                executionProfileId: "software-rnd-default",
                inputContractRefs: ["task-input"],
                outputContractRefs: ["verified-delivery"],
                timeoutSeconds: 900,
                retryMaxAttempts: 2,
                maxIterations: 8,
                maxTokens: 100_000,
              }
            : node,
        ),
      };
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });
      const firstPublish = database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });
      const firstVersion = firstPublish.history.find(
        (version) => version.version === 3,
      );
      const firstTask = firstVersion?.graph.nodes.find(
        (node) => node.id === "implementation",
      );
      assert.deepEqual(firstTask?.skillFlowSnapshot, {
        id: "implementation-flow",
        revision: 0,
        name: "Implementation",
        instructions:
          "Implement one verified vertical behavior at a time and diagnose failures before fixing them.",
        skillIds: ["tdd", "diagnosing-bugs"],
      });
      assert.equal(firstTask?.executionProfileId, "software-rnd-default");
      assert.equal(firstTask?.timeoutSeconds, 900);
      const firstHash = firstVersion?.hash;

      database.skillConfiguration.saveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: "implementation-flow",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Implementation v2",
        instructions: "Use the updated implementation guidance.",
        skillIds: ["tdd"],
      });
      const afterFlowEdit =
        database.pipelineConfiguration.inspect("software-rnd");
      const historicalTask = afterFlowEdit.history
        .find((version) => version.version === 3)
        ?.graph.nodes.find((node) => node.id === "implementation");
      assert.deepEqual(
        historicalTask?.skillFlowSnapshot,
        firstTask?.skillFlowSnapshot,
      );
      assert.equal(
        afterFlowEdit.history.find((version) => version.version === 3)?.hash,
        firstHash,
      );

      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 1,
        graph,
      });
      const secondPublish = database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 2,
      });
      assert.equal(
        secondPublish.published?.graph.nodes.find(
          (node) => node.id === "implementation",
        )?.skillFlowSnapshot?.revision,
        1,
      );
      assert.notEqual(secondPublish.published?.hash, firstHash);

      const copied = database.catalog.copyDepartment({
        departmentId: "software-rnd",
        name: "Copied delivery",
      });
      const copiedTask = copied.pipeline?.nodes.find(
        (node) => node.id === "implementation",
      );
      assert.notEqual(copiedTask?.skillFlowId, "implementation-flow");
      assert.equal(copiedTask?.skillFlowSnapshot?.id, copiedTask?.skillFlowId);
      assert.equal(
        copiedTask?.skillFlowSnapshot?.instructions,
        "Use the updated implementation guidance.",
      );
    } finally {
      database.close();
    }
  });

  it("validates Phase 1 node configuration with stable codes and rejects arbitrary Condition JavaScript", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const validation = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "task",
              type: "ai-task",
              name: "Task",
              positionId: "software-engineer",
              executionProfileId: "missing-profile",
              inputContractRefs: ["missing-input"],
              outputContractRefs: ["missing-output"],
              timeoutSeconds: 0,
              retryMaxAttempts: -1,
              maxIterations: 0,
              maxTokens: 0,
            },
            {
              id: "approval",
              type: "human-approval",
              name: "Approval",
              positionId: "reviewer",
              approvalTitle: "Review delivery",
            },
            {
              id: "condition",
              type: "condition",
              name: "Check result",
              condition: {
                leftReference: "nodes.task.result.status",
                operator: "equals",
                value: "passed",
                branches: [
                  { id: "passed", label: "Passed", kind: "match" },
                  { id: "fallback", label: "Fallback", kind: "default" },
                ],
              },
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "task" },
            { from: "task", to: "approval" },
            { from: "approval", to: "condition" },
            { from: "condition", to: "complete", branchId: "unknown" },
          ],
        },
      });
      assert.deepEqual(
        validation.issues.map((issue) => issue.code),
        [
          "EXECUTION_PROFILE_NOT_FOUND",
          "INPUT_CONTRACT_NOT_FOUND",
          "OUTPUT_CONTRACT_NOT_FOUND",
          "TIMEOUT_INVALID",
          "RETRY_POLICY_INVALID",
          "LIMITS_INVALID",
          "LIMITS_INVALID",
          "APPROVAL_CONFIGURATION_INCOMPLETE",
          "CONDITION_BRANCH_NOT_FOUND",
        ],
      );

      assert.equal(
        DepartmentPipelineDraftGraphSchema.safeParse({
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "condition",
              type: "condition",
              name: "Unsafe",
              condition: {
                leftReference: "task.status",
                operator: "equals",
                value: "passed",
                branches: [
                  { id: "passed", label: "Passed", kind: "match" },
                  { id: "fallback", label: "Fallback", kind: "default" },
                ],
                javascript: "return process.env.SECRET",
              },
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "condition" },
            { from: "condition", to: "complete", branchId: "passed" },
          ],
        }).success,
        false,
      );
    } finally {
      database.close();
    }
  });

  it("rejects ambiguous Condition branch kinds and invalid references before publish", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const validation = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "condition",
              type: "condition",
              name: "Condition",
              condition: {
                leftReference: "result.ok",
                operator: "exists",
                branches: [
                  { id: "first", label: "First", kind: "match" },
                  { id: "second", label: "Second", kind: "match" },
                  { id: "fallback", label: "Fallback", kind: "default" },
                ],
              },
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "condition" },
            { from: "condition", to: "complete", branchId: "first" },
          ],
        },
      });

      assert.deepEqual(
        validation.issues.map((issue) => issue.code),
        ["CONDITION_REFERENCE_INVALID", "CONDITION_BRANCH_KIND_DUPLICATE"],
      );
    } finally {
      database.close();
    }
  });

  it("rejects Skill Flow selections on non-AI Pipeline nodes", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const validation = database.pipelineConfiguration.validate({
        departmentId: "software-rnd",
        graph: {
          nodes: [
            {
              id: "start",
              type: "start",
              name: "Start",
              skillFlowId: "implementation-flow",
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [{ from: "start", to: "complete" }],
        },
      });

      assert.deepEqual(
        validation.issues.map((issue) => issue.code),
        ["SKILL_FLOW_NOT_ALLOWED"],
      );
      assert.equal(validation.issues[0]?.nodeId, "start");
    } finally {
      database.close();
    }
  });

  it("returns stable validation codes for invalid AI Task Skill Flow references", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    const graphWith = (positionId: string, skillFlowId: string) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        {
          id: "task",
          type: "ai-task",
          name: "Task",
          positionId,
          skillFlowId,
        },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "task" },
        { from: "task", to: "complete" },
      ],
    });

    try {
      assert.deepEqual(
        database.pipelineConfiguration
          .validate({
            departmentId: "software-rnd",
            graph: graphWith("software-engineer", "missing-flow"),
          })
          .issues.map((issue) => issue.code),
        ["SKILL_FLOW_NOT_FOUND"],
      );
      assert.deepEqual(
        database.pipelineConfiguration
          .validate({
            departmentId: "software-rnd",
            graph: graphWith("reviewer", "implementation-flow"),
          })
          .issues.map((issue) => issue.code),
        ["SKILL_FLOW_POSITION_MISMATCH"],
      );

      const copied = database.catalog.copyDepartment({
        departmentId: "software-rnd",
        name: "Copied delivery",
      });
      assert.deepEqual(
        database.pipelineConfiguration
          .validate({
            departmentId: copied.id,
            graph: graphWith(
              copied.positions.find(
                (position) => position.name === "Software Engineer",
              )?.id ?? "missing-position",
              "implementation-flow",
            ),
          })
          .issues.map((issue) => issue.code),
        ["SKILL_FLOW_OUTSIDE_DEPARTMENT"],
      );

      const created = database.skillConfiguration
        .saveSkillFlow({
          departmentId: "software-rnd",
          positionId: "software-engineer",
          expectedRevision: 0,
          name: "Archived flow",
          instructions: "This flow is archived before Pipeline selection.",
          skillIds: ["tdd"],
        })
        .skillFlows.find((flow) => flow.name === "Archived flow");
      assert.ok(created);
      database.skillConfiguration.archiveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: created.id,
        expectedRevision: 0,
      });
      assert.deepEqual(
        database.pipelineConfiguration
          .validate({
            departmentId: "software-rnd",
            graph: graphWith("software-engineer", created.id),
          })
          .issues.map((issue) => issue.code),
        ["SKILL_FLOW_ARCHIVED"],
      );
    } finally {
      database.close();
    }
  });
});
