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

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-production-adapter-"));

describe("Production Execution Adapter", () => {
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
