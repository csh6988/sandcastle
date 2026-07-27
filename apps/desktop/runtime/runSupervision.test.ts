import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";
import type { DepartmentPipelineDraftGraph } from "./interface.js";
import { openCompanyDatabase } from "./storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-run-supervision-"));

describe("Run supervision", () => {
  it("rebuilds Graph, Timeline, Agent Activity, and interaction boundaries from Runtime state", () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      interactionExecutionAdapter: createModelOnlyInteractionExecutionAdapter({
        complete: async () => ({
          providerExecutionRef: "provider-turn",
          response: "response",
        }),
      }),
    });
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const department = database.catalog.createDepartment({
        name: "Delivery",
      });
      const position = database.catalog.createPosition({
        departmentId: department.id,
        name: "Engineer",
        responsibility: "Ship the change.",
        aiMemberDisplayName: "Ada",
        aiMemberProfile: "A careful engineer.",
        aiMemberResponsibilityMetadata: { focus: "delivery" },
      }).positions[0];
      assert.ok(position);
      const profile = database.catalog.saveExecutionProfile({
        departmentId: department.id,
        expectedRevision: 0,
        name: "Scripted default",
        providerRef: "scripted",
        model: "scripted-v1",
        sandboxRef: "no-sandbox",
        branchStrategy: "head",
        timeoutSeconds: 60,
        maxIterations: 1,
        maxTokens: null,
        retryMaxAttempts: 0,
        permissionPolicy: "ask",
        secretReferenceIds: [],
      }).executionProfiles[0];
      assert.ok(profile);
      database.catalog.updateDepartment({
        departmentId: department.id,
        expectedRevision: 0,
        name: department.name,
        description: "A delivery department.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: profile.id,
      });
      const graph: DepartmentPipelineDraftGraph = {
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "implement",
            type: "ai-task",
            name: "Implement",
            positionId: position.id,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "implement" },
          { from: "implement", to: "complete" },
        ],
      };
      const draft = database.pipelineConfiguration.saveDraft({
        departmentId: department.id,
        expectedRevision: 0,
        graph,
      });
      database.pipelineConfiguration.publish({
        departmentId: department.id,
        expectedRevision: draft.draft.revision,
      });
      const run = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const implement = run.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(implement);
      const collaboration = database.interaction.createSession({
        projectId: project.id,
        mode: "run-collaboration",
        runId: run.run.id,
        nodeRunId: implement.id,
      });
      const consultation = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
        runId: run.run.id,
      });
      const human = database.interaction.addParticipant({
        sessionId: consultation.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      database.interaction.addParticipant({
        sessionId: consultation.id,
        participantType: "ai-member",
        participantRef: position.aiMember.id,
        role: "collaborator",
      });
      const prompted = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "prompt:cancel-before-start",
        actor: {
          type: "human",
          id: "user-local",
          authenticatedBy: "local-session",
        },
        command: {
          type: "interaction.prompt",
          sessionId: consultation.id,
          participantId: human.id,
          content: "Stop this turn.",
        },
      });
      if (prompted.status !== "succeeded")
        assert.fail(`Prompt was rejected: ${JSON.stringify(prompted.error)}`);
      const cancelledTurn = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "cancel-turn-1",
        actor: {
          type: "human",
          id: "user-local",
          authenticatedBy: "local-session",
        },
        command: {
          type: "interaction-turn.cancel",
          runId: run.run.id,
          turnId: prompted.value.id,
        },
      });
      assert.equal(cancelledTurn.status, "succeeded");
      if (cancelledTurn.status !== "succeeded") {
        assert.fail("Turn cancellation was rejected.");
      }
      assert.equal(cancelledTurn.effectIds.length, 1);
      assert.equal(
        cancelledTurn.value.interactions
          .flatMap((entry) => entry.turns)
          .find((turn) => turn.id === prompted.value.id)?.status,
        "cancelled",
      );

      for (let revision = 1; revision <= 1_001; revision += 1) {
        database.events.append({
          type: "project.updated",
          scope: { companyId: "company", projectId: "noise-project" },
          payload: { projectId: "noise-project", revision },
        });
      }
      database.events.append({
        type: "run.intervention.recorded",
        scope: {
          companyId: "company",
          projectId: project.id,
          departmentId: department.id,
          runId: run.run.id,
        },
        payload: { status: "late-supervision-evidence" },
        eventId: "late-supervision-event",
      });

      const view = database.supervision.inspect(run.run.id);

      assert.equal(view.run.id, run.run.id);
      assert.deepEqual(
        view.graph.nodes.map((node) => [node.pipelineNodeId, node.status]),
        [
          ["start", "ready"],
          ["implement", "queued"],
          ["complete", "queued"],
        ],
      );
      assert.deepEqual(view.graph.edges, graph.edges);
      assert.equal(view.timeline[0]?.type, "run.created");
      assert.equal(
        view.timeline.some(
          (event) => event.eventId === "late-supervision-event",
        ),
        true,
      );
      const cancellationEvent = view.timeline.find(
        (event) =>
          event.payload !== null &&
          typeof event.payload === "object" &&
          "turnId" in event.payload &&
          event.payload.turnId === prompted.value.id,
      );
      assert.equal(cancellationEvent?.type, "interaction.turn.cancelled");
      assert.deepEqual(cancellationEvent?.payload, {
        sessionId: consultation.id,
        turnId: prompted.value.id,
        status: "cancelled",
        failureCode: "TURN_CANCELLED_BEFORE_EXECUTION",
      });
      const activity = view.agentActivities.find(
        (candidate) => candidate.nodeRunId === implement.id,
      );
      assert.equal(activity?.aiMemberId, position.aiMember.id);
      assert.equal(activity?.positionId, position.id);
      assert.equal(activity?.agentAdapterId, "scripted");
      assert.equal(activity?.model, "scripted-v1");
      assert.equal(activity?.sessionId, collaboration.id);
      assert.equal(activity?.status, "queued");
      assert.equal(activity?.nextAction, "wait-for-dependencies");
      assert.deepEqual(
        view.interactions.map((entry) => [entry.session.id, entry.boundary]),
        [
          [collaboration.id, "run-collaboration"],
          [consultation.id, "consultation"],
        ],
      );
      assert.equal(view.allowedCommands.pause, true);
      assert.equal(view.allowedCommands.resume, false);
      assert.equal(view.allowedCommands.cancelAttemptIds.length, 0);
      assert.equal(view.allowedCommands.cancelTurnIds.length, 0);
    } finally {
      database.close();
    }
  });
});
