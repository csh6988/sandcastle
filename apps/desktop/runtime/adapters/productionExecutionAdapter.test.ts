import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import {
  createProductionExecutionAdapter,
  type SoftwareDevelopmentExecutionInput,
} from "./productionExecutionAdapter.js";
import type { ExecutionAdapterInput } from "./scriptedExecutionAdapter.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-production-adapter-"));

describe("Production Execution Adapter", () => {
  it("routes a package-bound development Node through repository implementation with its allocation request", async () => {
    const calls: SoftwareDevelopmentExecutionInput[] = [];
    const adapter = createProductionExecutionAdapter({
      execute: async (input) => {
        calls.push(input);
        return { kind: "succeeded", structuredResult: { implemented: true } };
      },
    });
    const node = {
      id: "package-a",
      type: "ai-task" as const,
      name: "Package A",
      positionId: "engineer",
      executionProfileId: "software-rnd-local-isolated-git",
      skillFlowSnapshot: {
        id: "implementation-flow",
        revision: 1,
        name: "Implementation",
        instructions: "Implement the Work Package.",
        skillIds: ["tdd"],
      },
    };
    const request = {
      operationKey: "work-package-attempt:attempt-1",
      target: { kind: "node-attempt" as const, id: "attempt-1" },
      lease: {
        leaseId: "lease-1",
        leaseKind: "execution" as const,
        target: { kind: "node-attempt" as const, id: "attempt-1" },
        executionEpoch: 1,
        fenceToken: "fence-1",
      },
      agentAdapterId: "codex",
      permissionScope: "ask",
      sideEffectPolicy: "formal" as const,
      completionSignal: "execution-fact" as const,
      timeoutSeconds: 60,
      immutableContext: {
        runId: "run-1",
        nodeRunId: "node-package-a",
        nodeAttemptId: "attempt-1",
        snapshotRevisionId: "snapshot-1",
        handlerKindId: "development@1",
        workPackage: {
          id: "package-a",
          versionId: "package-a-v1",
          applicationId: "application-a",
          repositoryReference: "/host/repository-a",
          positionId: "engineer",
          aiMemberId: "member-engineer",
          allowedPermissions: ["repository.write"],
          allocationId: "allocation-a",
          executionTreePath: "/allocations/a/execution-tree",
          sourceBranch: "sandcastle/wp/package-a/attempt-1",
          interactionSessionId: "session-a",
          sandboxIdentity: "sandbox:a",
          evidenceScope: "evidence:a",
        },
      },
    };
    const input = {
      runId: "run-1",
      nodeRunId: "node-package-a",
      signal: new AbortController().signal,
      node,
      snapshot: {
        project: {
          id: "project-1",
          revision: 1,
          name: "Project",
          goal: "Ship package A",
          sharedContext: "",
          repositoryReferences: ["/host/repository-a", "/host/repository-b"],
        },
        department: {
          id: "software-rnd",
          revision: 1,
          name: "Software R&D",
          description: "",
          inputArtifactContracts: [],
          outputArtifactContracts: [],
          defaultExecutionProfileId: "software-rnd-local-isolated-git",
        },
        positions: [
          {
            id: "engineer",
            revision: 1,
            name: "Engineer",
            responsibility: "Implement packages",
            defaultAgentId: "codex",
            resolvedAgentId: "codex",
            agentSource: "position-default" as const,
            skillIds: ["tdd"],
            aiMember: {
              id: "member-engineer",
              displayName: "Engineer",
              profile: "Developer",
              responsibilityMetadata: {},
              status: "active" as const,
            },
          },
        ],
        skillFlows: [],
        executionProfiles: [
          {
            id: "software-rnd-local-isolated-git",
            revision: 1,
            name: "Local isolated Git",
            providerRef: "codex",
            model: "default",
            sandboxRef: "docker",
            branchStrategy: "branch" as const,
            limits: { timeoutSeconds: 60, maxIterations: 10, maxTokens: null },
            retryPolicy: { maxAttempts: 1 },
            permissionPolicy: "ask" as const,
            secretReferenceIds: [],
          },
        ],
        pipelineVersion: { graph: { nodes: [node], edges: [] } },
      },
      attempt: {
        id: "attempt-1",
        attemptNumber: 1,
        snapshotRevisionId: "snapshot-1",
        reason: "initial" as const,
        feedback: [],
        previousResult: null,
        previousFailure: null,
      },
      request,
    } as unknown as ExecutionAdapterInput;

    const result = await adapter.execute(input);

    assert.deepEqual(result, {
      kind: "succeeded",
      structuredResult: { implemented: true },
    });
    assert.equal(calls[0]?.handler, "repository-implementation");
    assert.equal(
      calls[0]?.request?.immutableContext.workPackage?.executionTreePath,
      "/allocations/a/execution-tree",
    );
  });

  it("runs the built-in Software R&D Pipeline without republishing its frozen Skill Flows", async () => {
    const calls: SoftwareDevelopmentExecutionInput[] = [];
    const adapter = createProductionExecutionAdapter({
      execute: async (input) => {
        calls.push(input);
        return {
          kind: "failed",
          code: "TEST_STOP_AFTER_ALIGNMENT",
          message: "Stop after proving the built-in Pipeline is executable.",
        };
      },
    });
    const database = openCompanyDatabase(tempCompanyDir(), {
      executionAdapter: adapter,
    });
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });

      const stopped = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(stopped.run.status, "failed");
      assert.equal(calls[0]?.handler, "product-goal-alignment");
      assert.equal(calls[0]?.skillFlow.id, "product-alignment-flow");
      assert.ok(calls[0]?.skillFlow.instructions.length);
      assert.equal(
        stopped.nodes.find(
          (node) => node.pipelineNodeId === "product-alignment",
        )?.failure?.code,
        "TEST_STOP_AFTER_ALIGNMENT",
      );
    } finally {
      database.close();
    }
  });

  it("runs Product goal alignment from the frozen Skill Flow and persists its fact", async () => {
    const calls: SoftwareDevelopmentExecutionInput[] = [];
    const adapter = createProductionExecutionAdapter({
      execute: async (input) => {
        calls.push(input);
        if (input.handler === "product-goal-alignment") {
          return {
            kind: "succeeded",
            structuredResult: {
              summary: "Ship a reviewed checkout redesign.",
              acceptanceCriteria: ["Checkout remains available during deploy."],
            },
          };
        }
        return {
          kind: "failed",
          code: "TEST_STOP_AFTER_ALIGNMENT",
          message: "Stop after the first production tracer.",
        };
      },
    });
    const database = openCompanyDatabase(tempCompanyDir(), {
      executionAdapter: adapter,
    });
    try {
      const editor = database.pipelineConfiguration.inspect("software-rnd");
      const draft = database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: editor.draft.revision,
        graph: {
          ...editor.draft.graph,
          nodes: editor.draft.graph.nodes.map((node) =>
            node.id === "product-alignment"
              ? { ...node, skillFlowId: "product-alignment-flow" }
              : node.id === "technical-plan"
                ? { ...node, skillFlowId: "technical-planning-flow" }
                : node,
          ),
        },
      });
      database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: draft.draft.revision,
      });
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });

      const stopped = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(stopped.run.status, "failed");
      assert.equal(calls[0]?.handler, "product-goal-alignment");
      assert.equal(calls[0]?.project.goal, "Ship the checkout redesign");
      assert.equal(calls[0]?.position.id, "product-planner");
      assert.equal(calls[0]?.aiMember.id, "product-planner-member");
      assert.equal(calls[0]?.skillFlow.positionId, "product-planner");
      assert.ok(calls[0]?.skillFlow.instructions.length);
      assert.deepEqual(
        stopped.nodes.find(
          (node) => node.pipelineNodeId === "product-alignment",
        )?.result,
        {
          summary: "Ship a reviewed checkout redesign.",
          acceptanceCriteria: ["Checkout remains available during deploy."],
        },
      );
      assert.equal(
        stopped.nodes.find((node) => node.pipelineNodeId === "technical-plan")
          ?.failure?.code,
        "TEST_STOP_AFTER_ALIGNMENT",
      );
    } finally {
      database.close();
    }
  });
});
