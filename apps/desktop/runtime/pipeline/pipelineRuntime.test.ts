import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCompanyDatabase } from "../storage/sqlite.js";
import type { DepartmentPipelineDraftGraph } from "../interface.js";
import type { ExecutionEventSink } from "../execution/contract.js";
import {
  createScriptedExecutionAdapter,
  type ExecutionAdapterInput,
} from "../adapters/scriptedExecutionAdapter.js";
import { canonicalPipelineJson, pipelineHash } from "./canonicalPipeline.js";
import { createNodeHandlerRegistry } from "./nodeHandlerRegistry.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-pipeline-runtime-"));

const setup = (
  adapter = createScriptedExecutionAdapter(),
  buildGraph?: (positionId: string) => DepartmentPipelineDraftGraph,
  clock?: () => Date,
) => {
  const companyDir = tempCompanyDir();
  const database = openCompanyDatabase(companyDir, {
    executionAdapter: adapter,
    clock,
  });
  const project = database.catalog.createProject({
    name: "Checkout",
    goal: "Ship the checkout redesign",
  });
  const department = database.catalog.createDepartment({ name: "Delivery" });
  const position = database.catalog.createPosition({
    departmentId: department.id,
    name: "Engineer",
    responsibility: "Ships the change.",
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
    permissionPolicy: "deny",
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
  const graph: DepartmentPipelineDraftGraph = buildGraph?.(position.id) ?? {
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
  return {
    companyDir,
    database,
    project,
    department,
    position,
    graph,
    profile,
  };
};

const projectSpecGraph = (
  positionId: string,
): DepartmentPipelineDraftGraph => ({
  nodes: [
    {
      id: "start",
      type: "start",
      name: "Start",
      handlerKindId: "run-start@1",
    },
    {
      id: "project-spec",
      type: "ai-task",
      name: "Project Spec",
      positionId,
      handlerKindId: "project-spec@1",
    },
    {
      id: "complete",
      type: "complete",
      name: "Complete",
      handlerKindId: "run-complete@1",
    },
  ],
  edges: [
    { from: "start", to: "project-spec" },
    { from: "project-spec", to: "complete" },
  ],
});

const formalizeAndStart = (input: {
  readonly database: ReturnType<typeof openCompanyDatabase>;
  readonly projectId: string;
  readonly departmentId: string;
  readonly schedulingCheckpoint?: (point: "before-commit") => void;
}) => {
  const actor = {
    type: "human" as const,
    id: "pipeline-test-human",
    authenticatedBy: "local-session" as const,
  };
  const session = input.database.interaction.createSession({
    projectId: input.projectId,
    mode: "consultation",
  });
  input.database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: "product-planner-member",
    role: "product-manager",
  });
  const revised = input.database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `revise:${input.projectId}`,
    actor,
    consumerId: "pipeline-runtime-test",
    expectedRevision: 0,
    command: {
      type: "product.proposal.revise",
      projectId: input.projectId,
      producerSessionId: session.id,
      content: {
        goal: "Execute the deterministic Pipeline",
        users: ["Delivery operator"],
        scope: ["The published no-Agent graph"],
        nonGoals: ["Agent execution"],
        acceptanceCriteria: ["The Run completes from Snapshot r1"],
        constraints: ["Pipeline Runtime remains authoritative"],
        risks: ["Scheduler restart"],
        openQuestions: [],
      },
    },
  });
  assert.equal(revised.status, "succeeded");
  if (revised.status !== "succeeded" || !revised.value.proposal) {
    throw new Error("Product Proposal was not created.");
  }
  const proposal = revised.value.proposal;
  const awaiting = input.database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `awaiting:${input.projectId}`,
    actor,
    consumerId: "pipeline-runtime-test",
    expectedRevision: proposal.revision,
    command: {
      type: "product.proposal.mark-awaiting-confirmation",
      projectId: input.projectId,
      proposalRevisionId: proposal.currentRevision.id,
      proposalHash: proposal.currentRevision.hash,
    },
  });
  assert.equal(awaiting.status, "succeeded");
  if (awaiting.status !== "succeeded" || !awaiting.value.proposal) {
    throw new Error("Product Proposal was not marked awaiting confirmation.");
  }
  const exact = awaiting.value.proposal;
  const confirmed = input.database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `confirm:${input.projectId}`,
    actor,
    consumerId: "pipeline-runtime-test",
    expectedRevision: exact.revision,
    command: {
      type: "confirm-product-baseline",
      projectId: input.projectId,
      departmentId: input.departmentId,
      proposalRevisionId: exact.currentRevision.id,
      proposalHash: exact.currentRevision.hash,
    },
  });
  assert.equal(confirmed.status, "succeeded");
  if (confirmed.status !== "succeeded") {
    throw new Error("Product Baseline was not confirmed.");
  }
  const formalized = confirmed.value.formalRuns.at(-1);
  assert.ok(formalized);
  const beforeStart = input.database.pipelineRuntime.inspectRun(
    formalized.runId,
  );
  const started = input.database.pipelineRuntime.startFormalizedRun({
    projectId: input.projectId,
    departmentId: input.departmentId,
    checkpoint: input.schedulingCheckpoint,
  });
  return { actor, beforeStart, started };
};

describe("Pipeline Runtime", () => {
  it("persists Run creation audit and Runtime event records in the start transaction", () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });

      assert.deepEqual(
        database.pipelineRuntime
          .auditRecords({ runId: started.run.id })
          .map((record) => ({
            action: record.action,
            entityType: record.entityType,
            entityId: record.entityId,
            after: record.after,
          })),
        [
          {
            action: "run.start",
            entityType: "department-run",
            entityId: started.run.id,
            after: {
              status: "ready",
              revision: 0,
              agentOverrideId: null,
              agentSource: "position-default",
            },
          },
        ],
      );
      assert.deepEqual(
        database.pipelineRuntime
          .runtimeEvents({ afterSequence: 0, limit: 100 })
          .filter((event) => event.runId === started.run.id)
          .map((event) => ({
            type: event.type,
            runId: event.runId,
            payload: event.payload,
          })),
        [
          {
            type: "run.created",
            runId: started.run.id,
            payload: {
              status: "ready",
              revision: 0,
              agentOverrideId: null,
              agentSource: "position-default",
            },
          },
        ],
      );
    } finally {
      database.close();
    }
  });

  it("replays Runtime events from a durable per-consumer cursor", async () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      const initial = database.pipelineRuntime.runtimeEventsForConsumer({
        consumerId: "desktop-window-1",
        limit: 100,
      });
      assert.deepEqual(
        new Set(
          initial
            .filter((event) => event.runId === started.run.id)
            .map((event) => event.type),
        ),
        new Set([
          "run.created",
          "node.status.changed",
          "node.succeeded",
          "attempt.ready",
          "execution.leased",
          "attempt.started",
          "attempt.succeeded",
        ]),
      );
      const acknowledged = initial[2];
      assert.ok(acknowledged);
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "desktop-window-1",
        sequence: acknowledged.sequence,
      });
      database.pipelineRuntime.acknowledgeRuntimeEvents({
        consumerId: "desktop-window-1",
        sequence: 1,
      });

      const replayed = database.pipelineRuntime.runtimeEventsForConsumer({
        consumerId: "desktop-window-1",
        limit: 100,
      });
      assert.equal(
        replayed.every((event) => event.sequence > acknowledged.sequence),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("registers explicit Execution Adapter Artifact facts with complete producer lineage", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "succeeded",
          structuredResult: { accepted: true },
          artifacts: [
            {
              type: "verification-report",
              schemaVersion: "1",
              logicalName: "checkout-verification",
              content: "verification evidence",
            },
          ],
        },
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const node = completed.nodes.find(
        (candidate) => candidate.pipelineNodeId === "implement",
      );
      const versions = database.artifactRegistry.listVersions(project.id);
      assert.equal(versions.length, 1);
      assert.deepEqual(versions[0]?.producer, {
        runId: started.run.id,
        nodeRunId: node?.id,
        nodeAttemptId: node?.attempts[0]?.id,
        snapshotRevisionId: completed.snapshot.id,
        aiMemberId: completed.snapshot.payload.positions.find(
          (position) =>
            position.id ===
            completed.snapshot.payload.pipelineVersion.graph.nodes.find(
              (pipelineNode) => pipelineNode.id === "implement",
            )?.positionId,
        )?.aiMember.id,
      });
    } finally {
      database.close();
    }
  });

  it("blocks Complete when a required output Artifact Contract is unsatisfied", async () => {
    const { database, project, department } = setup();
    try {
      const inspected = database.catalog.inspectDepartment(department.id);
      database.catalog.updateDepartment({
        departmentId: department.id,
        expectedRevision: inspected.revision,
        name: inspected.name,
        description: inspected.description,
        inputArtifactContracts: [],
        outputArtifactContracts: [
          {
            id: "verification",
            name: "Verification Report",
            artifactType: "verification-report",
            schemaVersion: "1",
            required: true,
          },
        ],
        defaultExecutionProfileId: inspected.defaultExecutionProfileId,
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(failed.run.status, "failed");
      assert.equal(
        failed.nodes.find((node) => node.pipelineNodeId === "complete")?.failure
          ?.code,
        "ARTIFACT_CONTRACT_UNSATISFIED",
      );
    } finally {
      database.close();
    }
  });

  it("forks a Run from an explicit Snapshot Revision and preserves valid upstream work", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          { id: "plan", type: "ai-task", name: "Plan", positionId },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "plan" },
          { from: "plan", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);

      const forked = database.pipelineRuntime.forkRun({
        runId: waiting.run.id,
        snapshotRevisionId: waiting.snapshot.id,
        fromNodeRunId: approval.id,
      });

      assert.notEqual(forked.run.id, waiting.run.id);
      assert.equal(forked.run.parentRunId, waiting.run.id);
      assert.equal(
        forked.run.forkedFromSnapshotRevisionId,
        waiting.snapshot.id,
      );
      assert.equal(forked.snapshot.hash, waiting.snapshot.hash);
      assert.equal(
        forked.nodes.find((node) => node.pipelineNodeId === "plan")?.status,
        "succeeded",
      );
      assert.equal(
        forked.nodes.find((node) => node.pipelineNodeId === "approval")?.status,
        "ready",
      );
      assert.equal(
        forked.nodes.find((node) => node.pipelineNodeId === "complete")?.status,
        "queued",
      );
      assert.equal(
        forked.nodes.some((node) =>
          waiting.nodes.some((source) => source.id === node.id),
        ),
        false,
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(waiting.run.id).run.status,
        "superseded",
      );
      assert.equal(forked.continuationPlan?.kind, "fork");
      assert.equal(forked.continuationPlan?.mode, "replay");
      assert.deepEqual(
        forked.continuationPlan?.items.map((item) => [
          item.pipelineNodeId,
          item.disposition,
        ]),
        [
          ["start", "reuse-evidence"],
          ["plan", "reuse-evidence"],
          ["approval", "rerun"],
          ["complete", "blocked"],
        ],
      );
      const continuationPlanId = forked.continuationPlan?.id;
      assert.ok(continuationPlanId);
      const persisted = new DatabaseSync(database.path);
      try {
        assert.throws(
          () =>
            persisted
              .prepare(
                "DELETE FROM continuation_plan_items WHERE plan_id = ? AND ordinal = 0",
              )
              .run(continuationPlanId),
          /continuation plan item is immutable/,
        );
        assert.throws(
          () =>
            persisted
              .prepare("DELETE FROM continuation_plans WHERE id = ?")
              .run(continuationPlanId),
          /continuation plan is immutable/,
        );
      } finally {
        persisted.close();
      }
    } finally {
      database.close();
    }
  });

  it("approves a waiting Human Approval and advances the persisted Run", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      const approved = database.pipelineRuntime.decideApproval({
        runId: waiting.run.id,
        nodeRunId: waiting.nodes.find(
          (node) => node.pipelineNodeId === "approval",
        )!.id,
        expectedRevision: waiting.run.revision,
        decision: "approve",
      });

      assert.equal(approved.run.status, "running");
      assert.deepEqual(
        approved.nodes.find((node) => node.pipelineNodeId === "approval")
          ?.result,
        { decision: "approve" },
      );
      assert.equal(
        approved.nodes.find((node) => node.pipelineNodeId === "complete")
          ?.status,
        "ready",
      );
      const completed = await database.pipelineRuntime.executeReady({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });
      assert.equal(completed.run.status, "completed");
    } finally {
      database.close();
    }
  });

  it("rejects a waiting Human Approval into an immutable failed terminal state", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);

      const rejected = database.pipelineRuntime.decideApproval({
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "reject",
      });

      assert.equal(rejected.run.status, "failed");
      assert.equal(
        rejected.nodes.find((node) => node.id === approval.id)?.status,
        "failed",
      );
      assert.deepEqual(
        rejected.nodes.find((node) => node.id === approval.id)?.result,
        { decision: "reject" },
      );
      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            runId: rejected.run.id,
            nodeRunId: approval.id,
            expectedRevision: rejected.run.revision,
            decision: "approve",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "APPROVAL_DECISION_EXISTS",
      );
      assert.deepEqual(
        database.pipelineRuntime
          .inspectRun(rejected.run.id)
          .nodes.find((node) => node.id === approval.id)?.result,
        { decision: "reject" },
      );
    } finally {
      database.close();
    }
  });

  it("rejects stale and non-waiting Approval decisions with stable codes", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const approval = started.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);
      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            runId: started.run.id,
            nodeRunId: approval.id,
            expectedRevision: started.run.revision,
            decision: "approve",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "APPROVAL_STATE_INVALID",
      );
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            runId: waiting.run.id,
            nodeRunId: approval.id,
            expectedRevision: started.run.revision,
            decision: "approve",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(waiting.run.id).run.status,
        "waiting-approval",
      );
    } finally {
      database.close();
    }
  });

  it("requests changes from a single direct AI Task and preserves every attempt", async () => {
    const executions: Array<{
      readonly reason: string;
      readonly feedback: readonly string[];
      readonly previousResult: unknown;
    }> = [];
    const { database, project, department } = setup(
      createScriptedExecutionAdapter({
        script: {
          implement: [
            { kind: "succeeded", structuredResult: { draft: "v1" } },
            { kind: "succeeded", structuredResult: { draft: "v2" } },
          ],
        },
        onExecute: (input) => {
          executions.push({
            reason: input.attempt.reason,
            feedback: input.attempt.feedback.map((item) => item.content),
            previousResult: input.attempt.previousResult,
          });
        },
      }),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "implement",
            type: "ai-task",
            name: "Implement",
            positionId,
          },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "implement" },
          { from: "implement", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);

      const requested = database.pipelineRuntime.decideApproval({
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "request-changes",
        feedback: "Add a recovery section.",
      });

      assert.equal(requested.run.status, "running");
      assert.equal(
        requested.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.status,
        "ready",
      );
      assert.equal(
        requested.nodes.find((node) => node.pipelineNodeId === "approval")
          ?.status,
        "queued",
      );
      assert.deepEqual(
        requested.nodes
          .find((node) => node.pipelineNodeId === "implement")
          ?.attempts.map((attempt) => ({
            attemptNumber: attempt.attemptNumber,
            reason: attempt.reason,
            status: attempt.status,
            result: attempt.result,
            feedback: attempt.feedback.map((item) => item.content),
          })),
        [
          {
            attemptNumber: 1,
            reason: "initial",
            status: "succeeded",
            result: { draft: "v1" },
            feedback: [],
          },
          {
            attemptNumber: 2,
            reason: "request-changes",
            status: "ready",
            result: null,
            feedback: ["Add a recovery section."],
          },
        ],
      );

      const waitingAgain = await database.pipelineRuntime.executeReady({
        runId: requested.run.id,
        expectedRevision: requested.run.revision,
      });
      assert.equal(waitingAgain.run.status, "waiting-approval");
      assert.deepEqual(executions, [
        { reason: "initial", feedback: [], previousResult: null },
        {
          reason: "request-changes",
          feedback: ["Add a recovery section."],
          previousResult: { draft: "v1" },
        },
      ]);
      assert.deepEqual(
        waitingAgain.nodes
          .find((node) => node.pipelineNodeId === "approval")
          ?.approvals.map((item) => ({
            cycle: item.cycle,
            status: item.status,
            decision: item.decision,
          })),
        [
          { cycle: 1, status: "decided", decision: "request-changes" },
          { cycle: 2, status: "pending", decision: null },
        ],
      );
    } finally {
      database.close();
    }
  });

  it("rejects invalid Approval feedback and ambiguous Request Changes targets", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);

      for (const input of [
        { decision: "approve" as const, feedback: "Must not be accepted." },
        { decision: "request-changes" as const, feedback: "   " },
      ]) {
        assert.throws(
          () =>
            database.pipelineRuntime.decideApproval({
              runId: waiting.run.id,
              nodeRunId: approval.id,
              expectedRevision: waiting.run.revision,
              ...input,
            }),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "NODE_FEEDBACK_INVALID",
        );
      }
      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            runId: waiting.run.id,
            nodeRunId: approval.id,
            expectedRevision: waiting.run.revision,
            decision: "request-changes",
            feedback: "Please revise.",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "REQUEST_CHANGES_TARGET_INVALID",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(waiting.run.id).run.status,
        "waiting-approval",
      );
    } finally {
      database.close();
    }
  });

  it("retries a failed AI Task with the frozen Snapshot and explicit feedback", async () => {
    const executions: Array<{
      readonly reason: string;
      readonly feedback: readonly string[];
      readonly previousFailure: {
        readonly code: string;
        readonly message: string;
      } | null;
    }> = [];
    const { database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        script: {
          implement: [
            {
              kind: "failed",
              code: "SCRIPTED_AGENT_FAILED",
              message: "The first attempt failed.",
            },
            { kind: "succeeded", structuredResult: { recovered: true } },
          ],
        },
        onExecute: (input) => {
          executions.push({
            reason: input.attempt.reason,
            feedback: input.attempt.feedback.map((item) => item.content),
            previousFailure: input.attempt.previousFailure,
          });
        },
      }),
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = failed.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);
      assert.equal(failed.run.status, "failed");

      const recovering = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: failedNode.id,
        expectedRevision: failed.run.revision,
        feedback: "Retry with the smaller input.",
      });
      assert.equal(recovering.run.status, "recovering");
      assert.equal(
        recovering.nodes.find((node) => node.id === failedNode.id)?.status,
        "ready",
      );
      assert.equal(
        recovering.nodes.find((node) => node.id === failedNode.id)?.attempts[1]
          ?.reason,
        "retry",
      );

      const completed = await database.pipelineRuntime.executeReady({
        runId: recovering.run.id,
        expectedRevision: recovering.run.revision,
      });
      assert.equal(completed.run.status, "completed");
      assert.deepEqual(executions, [
        { reason: "initial", feedback: [], previousFailure: null },
        {
          reason: "retry",
          feedback: ["Retry with the smaller input."],
          previousFailure: {
            code: "SCRIPTED_AGENT_FAILED",
            message: "The first attempt failed.",
          },
        },
      ]);
      assert.deepEqual(
        completed.nodes
          .find((node) => node.id === failedNode.id)
          ?.attempts.map((attempt) => ({
            attemptNumber: attempt.attemptNumber,
            reason: attempt.reason,
            status: attempt.status,
          })),
        [
          { attemptNumber: 1, reason: "initial", status: "failed" },
          { attemptNumber: 2, reason: "retry", status: "succeeded" },
        ],
      );
    } finally {
      database.close();
    }
  });

  it("allows only one scheduler worker to claim the same Ready Node Attempt", async () => {
    const { companyDir, database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "The first attempt failed.",
        },
      }),
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });
    const secondWorkerDatabase = openCompanyDatabase(companyDir);
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = failed.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);
      const recovering = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: failedNode.id,
        expectedRevision: failed.run.revision,
      });
      const readyAttempt = recovering.nodes
        .find((node) => node.id === failedNode.id)
        ?.attempts.find((attempt) => attempt.status === "ready");
      assert.ok(readyAttempt);

      const results = await Promise.all([
        Promise.resolve().then(() =>
          database.pipelineRuntime.claimReadyAttempt({
            runId: recovering.run.id,
            workerId: "scheduler-worker-a",
            leaseDurationMs: 30_000,
          }),
        ),
        Promise.resolve().then(() =>
          secondWorkerDatabase.pipelineRuntime.claimReadyAttempt({
            runId: recovering.run.id,
            workerId: "scheduler-worker-b",
            leaseDurationMs: 30_000,
          }),
        ),
      ]);

      assert.deepEqual(results.map((result) => result.kind).sort(), [
        "claimed",
        "no-work",
      ]);
      const claimed = results.find((result) => result.kind === "claimed");
      assert.ok(claimed && claimed.kind === "claimed");
      assert.equal(claimed.attemptId, readyAttempt.id);
      assert.equal(claimed.nodeRunId, failedNode.id);
      assert.ok(claimed.leaseId.length > 0);
      assert.ok(claimed.leaseExpiresAt.length > 0);
      assert.deepEqual(
        results.find((result) => result.kind === "no-work"),
        { kind: "no-work", reason: "no-ready-attempt" },
      );
    } finally {
      secondWorkerDatabase.close();
      database.close();
    }
  });

  it("diagnoses an expired running lease as recoverable after Runtime restart", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const clock = () => new Date(now);
    const { companyDir, database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "Prepare a recoverable Retry Attempt.",
        },
      }),
      undefined,
      clock,
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });

    const started = database.pipelineRuntime.startRun({
      projectId: project.id,
      departmentId: department.id,
    });
    const failed = await database.pipelineRuntime.executeReady({
      runId: started.run.id,
      expectedRevision: started.run.revision,
    });
    const failedNode = failed.nodes.find(
      (node) => node.pipelineNodeId === "implement",
    );
    assert.ok(failedNode);
    const recovering = database.pipelineRuntime.retryNode({
      runId: failed.run.id,
      nodeRunId: failedNode.id,
      expectedRevision: failed.run.revision,
    });
    const claim = database.pipelineRuntime.claimReadyAttempt({
      runId: recovering.run.id,
      workerId: "scheduler-worker-a",
      leaseDurationMs: 30_000,
    });
    assert.equal(claim.kind, "claimed");
    database.close();

    now = new Date("2026-07-15T00:00:31.000Z");
    const restarted = openCompanyDatabase(companyDir, { clock });
    try {
      const recovered = restarted.pipelineRuntime.inspectRun(recovering.run.id);
      const recoveredNode = recovered.nodes.find(
        (node) => node.id === failedNode.id,
      );
      const recoveredAttempt = recoveredNode?.attempts.at(-1);

      assert.equal(recovered.run.status, "blocked");
      assert.equal(recoveredNode?.status, "blocked");
      assert.equal(recoveredAttempt?.status, "reconciling");
      assert.equal(recoveredAttempt?.recoverable, true);
      assert.equal(
        recoveredAttempt?.failure?.code,
        "EXECUTION_RECONCILIATION_REQUIRED",
      );
      assert.deepEqual(
        restarted.pipelineRuntime.claimReadyAttempt({
          runId: recovered.run.id,
          workerId: "scheduler-worker-b",
          leaseDurationMs: 30_000,
        }),
        { kind: "no-work", reason: "no-ready-attempt" },
      );
    } finally {
      restarted.close();
    }
  });

  it("renews and completes a claimed Attempt only with its lease ownership", async () => {
    const { database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "Prepare a Ready Retry Attempt.",
        },
      }),
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = failed.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);
      const recovering = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: failedNode.id,
        expectedRevision: failed.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: recovering.run.id,
        workerId: "scheduler-worker-a",
        leaseDurationMs: 30_000,
      });
      assert.equal(claim.kind, "claimed");

      assert.deepEqual(
        database.pipelineRuntime.renewAttemptLease({
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          workerId: "scheduler-worker-b",
          leaseDurationMs: 30_000,
        }),
        { kind: "lost", reason: "lease-not-owned" },
      );
      const renewed = database.pipelineRuntime.renewAttemptLease({
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerId: "scheduler-worker-a",
        leaseDurationMs: 60_000,
      });
      assert.equal(renewed.kind, "renewed");

      const completed = database.pipelineRuntime.completeClaimedAttempt({
        runId: recovering.run.id,
        nodeRunId: claim.nodeRunId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerId: "scheduler-worker-a",
        result: { recovered: true },
      });
      assert.equal(
        completed.nodes.find((node) => node.id === claim.nodeRunId)?.status,
        "succeeded",
      );
      assert.equal(
        completed.nodes
          .find((node) => node.id === claim.nodeRunId)
          ?.attempts.at(-1)?.status,
        "succeeded",
      );
      assert.deepEqual(
        completed.nodes.find((node) => node.id === claim.nodeRunId)?.result,
        { recovered: true },
      );
      assert.throws(
        () =>
          database.pipelineRuntime.completeClaimedAttempt({
            runId: recovering.run.id,
            nodeRunId: claim.nodeRunId,
            attemptId: claim.attemptId,
            leaseId: "stale-lease",
            workerId: "scheduler-worker-a",
            result: { overwritten: true },
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "LEASE_OWNERSHIP_INVALID",
      );
    } finally {
      database.close();
    }
  });

  it("renews the lease while a Node Handler is still executing", async () => {
    const adapter = {
      maxConcurrentNodes: 1,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { kind: "succeeded" as const, structuredResult: { ok: true } };
      },
    };
    const { database, project, department, profile } = setup(adapter);
    try {
      database.catalog.saveExecutionProfile({
        departmentId: department.id,
        executionProfileId: profile.id,
        expectedRevision: profile.revision,
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        timeoutSeconds: 2,
        maxIterations: profile.limits.maxIterations,
        maxTokens: profile.limits.maxTokens,
        retryMaxAttempts: profile.retryPolicy.maxAttempts,
        permissionPolicy: profile.permissionPolicy,
        secretReferenceIds: profile.secretReferenceIds,
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });

      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.equal(
        database.pipelineRuntime
          .auditRecords()
          .some((record) => record.action === "attempt.lease-renew"),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("fails and releases claimed Attempts without allowing silent re-execution", async () => {
    const { database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "Prepare a Ready Retry Attempt.",
        },
      }),
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const firstFailure = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = firstFailure.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);
      const recovering = database.pipelineRuntime.retryNode({
        runId: firstFailure.run.id,
        nodeRunId: failedNode.id,
        expectedRevision: firstFailure.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: recovering.run.id,
        workerId: "scheduler-worker-a",
        leaseDurationMs: 30_000,
      });
      assert.equal(claim.kind, "claimed");

      assert.throws(
        () =>
          database.pipelineRuntime.failClaimedAttempt({
            runId: recovering.run.id,
            nodeRunId: claim.nodeRunId,
            attemptId: claim.attemptId,
            leaseId: "stale-lease",
            workerId: "scheduler-worker-a",
            failure: {
              code: "PROVIDER_UNAVAILABLE",
              message: "The provider became unavailable.",
              recoverable: true,
            },
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "LEASE_OWNERSHIP_INVALID",
      );
      const released = database.pipelineRuntime.releaseClaimedAttempt({
        runId: recovering.run.id,
        nodeRunId: claim.nodeRunId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerId: "scheduler-worker-a",
      });
      const releasedAttempt = released.nodes
        .find((node) => node.id === claim.nodeRunId)
        ?.attempts.at(-1);
      assert.equal(released.run.status, "failed");
      assert.equal(releasedAttempt?.status, "failed");
      assert.equal(releasedAttempt?.recoverable, true);
      assert.equal(releasedAttempt?.failure?.code, "ATTEMPT_LEASE_RELEASED");
      assert.deepEqual(
        database.pipelineRuntime.claimReadyAttempt({
          runId: released.run.id,
          workerId: "scheduler-worker-b",
          leaseDurationMs: 30_000,
        }),
        { kind: "no-work", reason: "no-ready-attempt" },
      );
    } finally {
      database.close();
    }
  });

  it("routes execute-ready through a durable lease that recovers after interruption", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const clock = () => new Date(now);
    const { companyDir, database, project, department } = setup(
      {
        execute: async () => {
          now = new Date("2026-07-15T00:01:01.000Z");
          throw new Error("Simulated Runtime interruption");
        },
      },
      undefined,
      clock,
    );
    const started = database.pipelineRuntime.startRun({
      projectId: project.id,
      departmentId: department.id,
    });
    await assert.rejects(
      () =>
        database.pipelineRuntime.executeReady({
          runId: started.run.id,
          expectedRevision: started.run.revision,
        }),
      /Simulated Runtime interruption/,
    );
    database.close();

    const restarted = openCompanyDatabase(companyDir, { clock });
    try {
      const recovered = restarted.pipelineRuntime.inspectRun(started.run.id);
      const interrupted = recovered.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.equal(recovered.run.status, "blocked");
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
      assert.equal(interrupted?.attempts.at(-1)?.recoverable, true);
      assert.equal(
        interrupted?.attempts.at(-1)?.failure?.code,
        "EXECUTION_RECONCILIATION_REQUIRED",
      );
    } finally {
      restarted.close();
    }
  });

  it("enforces the frozen Run concurrency limit before executing another Parallel branch", async () => {
    let branchBExecuted = false;
    const { database, project, department } = setup(
      {
        execute: async (input) => {
          if (input.node.id === "branch-a") {
            throw new Error("Keep Branch A leased");
          }
          branchBExecuted = true;
          return { kind: "succeeded" };
        },
      },
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          { id: "parallel", type: "parallel", name: "Parallel" },
          {
            id: "branch-a",
            type: "ai-task",
            name: "Branch A",
            positionId,
          },
          {
            id: "branch-b",
            type: "ai-task",
            name: "Branch B",
            positionId,
          },
          { id: "join", type: "join", name: "Join" },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "parallel" },
          { from: "parallel", to: "branch-a" },
          { from: "parallel", to: "branch-b" },
          { from: "branch-a", to: "join" },
          { from: "branch-b", to: "join" },
          { from: "join", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        /Keep Branch A leased/,
      );
      const interrupted = database.pipelineRuntime.inspectRun(started.run.id);
      assert.equal(
        interrupted.nodes.find((node) => node.pipelineNodeId === "branch-a")
          ?.status,
        "running",
      );
      assert.equal(
        interrupted.nodes.find((node) => node.pipelineNodeId === "branch-b")
          ?.status,
        "ready",
      );

      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: interrupted.run.id,
            expectedRevision: interrupted.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "SCHEDULER_CONCURRENCY_LIMIT",
      );
      assert.equal(branchBExecuted, false);
    } finally {
      database.close();
    }
  });

  it("pauses, resumes, and cancels a Run with optimistic concurrency", async () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const paused = await database.pipelineRuntime.controlRun({
        runId: started.run.id,
        expectedRevision: started.run.revision,
        action: "pause",
      });
      assert.equal(paused.run.status, "paused");
      await assert.rejects(
        () =>
          database.pipelineRuntime.controlRun({
            runId: paused.run.id,
            expectedRevision: started.run.revision,
            action: "resume",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "VERSION_CONFLICT",
      );
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: paused.run.id,
            expectedRevision: paused.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_STATE_INVALID",
      );

      const resumed = await database.pipelineRuntime.controlRun({
        runId: paused.run.id,
        expectedRevision: paused.run.revision,
        action: "resume",
      });
      assert.equal(resumed.run.status, "ready");
      const cancelled = await database.pipelineRuntime.controlRun({
        runId: resumed.run.id,
        expectedRevision: resumed.run.revision,
        action: "cancel",
      });
      assert.equal(cancelled.run.status, "cancelled");
      assert.equal(
        cancelled.nodes.every((node) => node.status === "cancelled"),
        true,
      );
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: cancelled.run.id,
            expectedRevision: cancelled.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_STATE_INVALID",
      );
    } finally {
      database.close();
    }
  });

  it("keeps an active Node Attempt reconciling when cancellation is unknown", async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const startedExecuting = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { database, project, department } = setup({
      execute: async (input) => {
        receivedSignal = input.signal;
        markStarted();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { kind: "succeeded" };
      },
      cancel: async () => "unknown",
      reconcile: async (_input, sink: ExecutionEventSink) => {
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-cancelled-after-request",
          ordinal: 1,
          kind: "cancelled",
          schemaVersion: 1,
          payload: {
            code: "EXECUTION_CANCELLED",
            message: "Provider confirmed cancellation.",
          },
          evidenceRefs: ["provider-receipt:cancelled"],
        });
        return {
          status: "cancelled" as const,
          terminalExecutionFactId: receipt.executionFactId,
          evidenceRefs: ["provider-receipt:cancelled"],
        };
      },
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const executing = database.pipelineRuntime
        .executeReady({
          runId: started.run.id,
          expectedRevision: started.run.revision,
        })
        .catch((error: unknown) => error);
      await startedExecuting;
      const running = database.pipelineRuntime.inspectRun(started.run.id);

      const cancelled = await database.pipelineRuntime.controlRun({
        runId: running.run.id,
        expectedRevision: running.run.revision,
        action: "cancel",
      });

      assert.equal(receivedSignal?.aborted, true);
      assert.equal(cancelled.run.status, "blocked");
      const interrupted = cancelled.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
      const attemptId = interrupted?.attempts.at(-1)?.id;
      assert.ok(attemptId);
      const execution = database.pipelineRuntime.inspectExecution({
        attemptId,
      });
      assert.equal(execution.leases.at(-1)?.cancelRequested, true);
      assert.equal(execution.leases.at(-1)?.releasedAt !== null, true);
      assert.throws(
        () =>
          database.pipelineRuntime.retryNode({
            runId: cancelled.run.id,
            nodeRunId: interrupted.id,
            expectedRevision: cancelled.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RETRY_STATE_INVALID",
      );
      const executionResult = await executing;
      assert.equal(
        executionResult instanceof Error &&
          "code" in executionResult &&
          executionResult.code,
        "LEASE_OWNERSHIP_INVALID",
      );
      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      const settled = database.pipelineRuntime.inspectRun(cancelled.run.id);
      const settledNode = settled.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.equal(settled.run.status, "cancelled");
      assert.equal(settledNode?.status, "cancelled");
      assert.equal(settledNode?.attempts.at(-1)?.status, "cancelled");
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId }).facts.at(-1)
          ?.kind,
        "cancelled",
      );
    } finally {
      database.close();
    }
  });

  it("keeps an unproven paused Node Attempt in reconciliation", async () => {
    let markStarted!: () => void;
    const startedExecuting = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { database, project, department } = setup({
      execute: async (input) => {
        markStarted();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { kind: "succeeded" };
      },
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const executing = database.pipelineRuntime
        .executeReady({
          runId: started.run.id,
          expectedRevision: started.run.revision,
        })
        .catch((error: unknown) => error);
      await startedExecuting;
      const running = database.pipelineRuntime.inspectRun(started.run.id);

      const paused = await database.pipelineRuntime.controlRun({
        runId: running.run.id,
        expectedRevision: running.run.revision,
        action: "pause",
      });
      const interrupted = paused.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.equal(paused.run.status, "paused");
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.recoverable, true);
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
      assert.equal(
        interrupted?.attempts.at(-1)?.failure?.code,
        "EXECUTION_PAUSE_RECONCILIATION_REQUIRED",
      );
      const attemptId = interrupted?.attempts.at(-1)?.id;
      assert.ok(attemptId);
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId }).leases.at(-1)
          ?.releasedAt !== null,
        true,
      );
      const executionResult = await executing;
      assert.equal(
        executionResult instanceof Error &&
          "code" in executionResult &&
          executionResult.code,
        "LEASE_OWNERSHIP_INVALID",
      );
      const resumed = await database.pipelineRuntime.controlRun({
        runId: paused.run.id,
        expectedRevision: paused.run.revision,
        action: "resume",
      });
      assert.equal(resumed.run.status, "blocked");
    } finally {
      database.close();
    }
  });

  it("drains an unproven active Node Attempt into reconciliation", async () => {
    let markStarted!: () => void;
    const startedExecuting = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { database, project, department } = setup({
      execute: async (input) => {
        markStarted();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("external execution state remains unproven");
      },
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const executing = database.pipelineRuntime
        .executeReady({
          runId: started.run.id,
          expectedRevision: started.run.revision,
        })
        .catch((error: unknown) => error);
      await startedExecuting;

      await database.pipelineRuntime.prepareForShutdown();

      const drained = database.pipelineRuntime.inspectRun(started.run.id);
      const interrupted = drained.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.equal(drained.run.status, "blocked");
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
      assert.equal(
        interrupted?.attempts.at(-1)?.failure?.code,
        "RUNTIME_SHUTDOWN",
      );
      const attemptId = interrupted?.attempts.at(-1)?.id;
      assert.ok(attemptId);
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId }).leases.at(-1)
          ?.releasedAt !== null,
        true,
      );
      assert.equal((await executing) instanceof Error, true);
    } finally {
      database.close();
    }
  });

  it("creates Snapshot Revision r2 for an allowed Recovery Override", async () => {
    const { database, project, department, profile } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "The configured provider failed.",
        },
      }),
    );
    database.catalog.saveExecutionProfile({
      departmentId: department.id,
      executionProfileId: profile.id,
      expectedRevision: profile.revision,
      name: profile.name,
      providerRef: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      branchStrategy: profile.branchStrategy,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
      maxTokens: profile.limits.maxTokens,
      retryMaxAttempts: 1,
      permissionPolicy: profile.permissionPolicy,
      secretReferenceIds: profile.secretReferenceIds,
    });
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = failed.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);

      const recovered = database.pipelineRuntime.recoverRun({
        runId: failed.run.id,
        nodeRunId: failedNode.id,
        expectedRevision: failed.run.revision,
        override: {
          providerRef: "recovery-provider",
          model: "recovery-model",
          sandboxRef: "isolated",
          timeoutSeconds: 120,
          maxIterations: 2,
          maxTokens: 8_000,
        },
      });
      assert.equal(recovered.snapshot.revision, 2);
      assert.equal(recovered.snapshot.parentRevision, 1);
      assert.notEqual(recovered.snapshot.hash, started.snapshot.hash);
      assert.equal(
        recovered.snapshot.payload.project.goal,
        started.snapshot.payload.project.goal,
      );
      assert.equal(
        recovered.snapshot.payload.pipelineVersion.hash,
        started.snapshot.payload.pipelineVersion.hash,
      );
      const profileAfter = recovered.snapshot.payload.executionProfiles.find(
        (candidate) => candidate.id === profile.id,
      );
      assert.equal(profileAfter?.providerRef, "recovery-provider");
      assert.equal(profileAfter?.model, "recovery-model");
      assert.equal(profileAfter?.sandboxRef, "isolated");
      assert.equal(profileAfter?.limits.timeoutSeconds, 120);
      assert.equal(
        recovered.nodes.find((node) => node.id === failedNode.id)?.status,
        "ready",
      );
      assert.equal(
        recovered.nodes
          .find((node) => node.id === failedNode.id)
          ?.attempts.at(-1)?.snapshotRevisionId,
        recovered.snapshot.id,
      );
      assert.equal(
        recovered.nodes
          .find((node) => node.id === failedNode.id)
          ?.attempts.at(-1)?.reason,
        "recovery",
      );
      assert.equal(recovered.continuationPlan?.kind, "recovery");
      assert.equal(
        recovered.continuationPlan?.targetSnapshotRevisionId,
        recovered.snapshot.id,
      );
      assert.equal(
        recovered.continuationPlan?.items.find(
          (item) => item.pipelineNodeId === failedNode.pipelineNodeId,
        )?.disposition,
        "rerun",
      );
    } finally {
      database.close();
    }
  });

  it("rejects Retry when the frozen retry budget is exhausted", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter({
        defaultFact: {
          kind: "failed",
          code: "SCRIPTED_AGENT_FAILED",
          message: "Always fails.",
        },
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const failedNode = failed.nodes.find(
        (node) => node.pipelineNodeId === "implement",
      );
      assert.ok(failedNode);
      assert.throws(
        () =>
          database.pipelineRuntime.retryNode({
            runId: failed.run.id,
            nodeRunId: failedNode.id,
            expectedRevision: failed.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RETRY_LIMIT_EXCEEDED",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(failed.run.id).run.status,
        "failed",
      );
    } finally {
      database.close();
    }
  });

  it("selects a Condition branch from a persisted upstream structured result", async () => {
    const executed: string[] = [];
    const adapter = createScriptedExecutionAdapter({
      script: {
        classify: [
          {
            kind: "succeeded",
            structuredResult: { verdict: "ship" },
          },
        ],
      },
      onExecute: ({ node }) => executed.push(node.id),
    });
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        {
          id: "classify",
          type: "ai-task",
          name: "Classify",
          positionId,
        },
        {
          id: "condition",
          type: "condition",
          name: "Condition",
          condition: {
            leftReference: "nodes.classify.result.verdict",
            operator: "equals",
            value: "ship",
            branches: [
              { id: "ship", label: "Ship", kind: "match" },
              { id: "hold", label: "Hold", kind: "no-match" },
              { id: "fallback", label: "Fallback", kind: "default" },
            ],
          },
        },
        {
          id: "ship-task",
          type: "ai-task",
          name: "Ship task",
          positionId,
        },
        {
          id: "hold-task",
          type: "ai-task",
          name: "Hold task",
          positionId,
        },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "classify" },
        { from: "classify", to: "condition" },
        { from: "condition", to: "ship-task", branchId: "ship" },
        { from: "condition", to: "hold-task", branchId: "hold" },
        { from: "ship-task", to: "complete" },
        { from: "hold-task", to: "complete" },
      ],
    }));
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.deepEqual(executed, ["classify", "ship-task"]);
      assert.deepEqual(
        completed.nodes.find((node) => node.pipelineNodeId === "condition")
          ?.result,
        {
          selectedBranchId: "ship",
          leftValue: "ship",
        },
      );
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "hold-task")
          ?.status,
        "skipped",
      );
    } finally {
      database.close();
    }
  });

  it("evaluates every declared Condition operator with strict JSON semantics", async () => {
    const cases = [
      {
        operator: "not-equals" as const,
        structuredResult: { value: 1 },
        value: 2,
        reference: "nodes.source.result.value",
      },
      {
        operator: "exists" as const,
        structuredResult: { value: true },
        value: undefined,
        reference: "nodes.source.result.value",
      },
      {
        operator: "not-exists" as const,
        structuredResult: {},
        value: undefined,
        reference: "nodes.source.result.missing",
      },
      {
        operator: "in" as const,
        structuredResult: { value: "beta" },
        value: ["alpha", "beta"],
        reference: "nodes.source.result.value",
      },
    ];

    for (const conditionCase of cases) {
      const adapter = createScriptedExecutionAdapter({
        script: {
          source: [
            {
              kind: "succeeded",
              structuredResult: conditionCase.structuredResult,
            },
          ],
        },
      });
      const { database, project, department } = setup(
        adapter,
        (positionId) => ({
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "source",
              type: "ai-task",
              name: "Source",
              positionId,
            },
            {
              id: "condition",
              type: "condition",
              name: "Condition",
              condition: {
                leftReference: conditionCase.reference,
                operator: conditionCase.operator,
                ...(conditionCase.value === undefined
                  ? {}
                  : { value: conditionCase.value }),
                branches: [
                  { id: "yes", label: "Yes", kind: "match" },
                  { id: "no", label: "No", kind: "no-match" },
                  { id: "fallback", label: "Fallback", kind: "default" },
                ],
              },
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "source" },
            { from: "source", to: "condition" },
            { from: "condition", to: "complete", branchId: "yes" },
          ],
        }),
      );
      try {
        const started = database.pipelineRuntime.startRun({
          projectId: project.id,
          departmentId: department.id,
        });
        const completed = await database.pipelineRuntime.executeReady({
          runId: started.run.id,
          expectedRevision: 0,
        });
        assert.equal(completed.run.status, "completed");
        assert.equal(
          completed.nodes.find((node) => node.pipelineNodeId === "condition")
            ?.result &&
            (
              completed.nodes.find(
                (node) => node.pipelineNodeId === "condition",
              )!.result as { selectedBranchId: string }
            ).selectedBranchId,
          "yes",
          conditionCase.operator,
        );
      } finally {
        database.close();
      }
    }
  });

  it("selects no-match and falls back to default deterministically", async () => {
    const cases = [
      {
        selectedBranchId: "no",
        branches: [
          { id: "yes", label: "Yes", kind: "match" as const },
          { id: "no", label: "No", kind: "no-match" as const },
          { id: "fallback", label: "Fallback", kind: "default" as const },
        ],
      },
      {
        selectedBranchId: "fallback",
        branches: [
          { id: "yes", label: "Yes", kind: "match" as const },
          { id: "fallback", label: "Fallback", kind: "default" as const },
        ],
      },
    ];
    for (const conditionCase of cases) {
      const executed: string[] = [];
      const { database, project, department } = setup(
        createScriptedExecutionAdapter({
          script: {
            source: [{ kind: "succeeded", structuredResult: { value: 1 } }],
          },
          onExecute: ({ node }) => executed.push(node.id),
        }),
        (positionId) => ({
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "source",
              type: "ai-task",
              name: "Source",
              positionId,
            },
            {
              id: "condition",
              type: "condition",
              name: "Condition",
              condition: {
                leftReference: "nodes.source.result.value",
                operator: "equals",
                value: 2,
                branches: conditionCase.branches,
              },
            },
            {
              id: "match-task",
              type: "ai-task",
              name: "Match",
              positionId,
            },
            {
              id: "other-task",
              type: "ai-task",
              name: "Other",
              positionId,
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "source" },
            { from: "source", to: "condition" },
            { from: "condition", to: "match-task", branchId: "yes" },
            {
              from: "condition",
              to: "other-task",
              branchId: conditionCase.selectedBranchId,
            },
            { from: "match-task", to: "complete" },
            { from: "other-task", to: "complete" },
          ],
        }),
      );
      try {
        const started = database.pipelineRuntime.startRun({
          projectId: project.id,
          departmentId: department.id,
        });
        const completed = await database.pipelineRuntime.executeReady({
          runId: started.run.id,
          expectedRevision: 0,
        });
        assert.equal(completed.run.status, "completed");
        assert.deepEqual(executed, ["source", "other-task"]);
        assert.equal(
          (
            completed.nodes.find((node) => node.pipelineNodeId === "condition")
              ?.result as { selectedBranchId: string }
          ).selectedBranchId,
          conditionCase.selectedBranchId,
        );
      } finally {
        database.close();
      }
    }
  });

  it("uses the frozen Snapshot when resolving a Condition reference", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      () => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "condition",
            type: "condition",
            name: "Condition",
            condition: {
              leftReference: "snapshot.project.goal",
              operator: "equals",
              value: "Ship the checkout redesign",
              branches: [
                { id: "original", label: "Original", kind: "match" },
                { id: "changed", label: "Changed", kind: "no-match" },
                { id: "fallback", label: "Fallback", kind: "default" },
              ],
            },
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "condition" },
          { from: "condition", to: "complete", branchId: "original" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: 0,
        name: project.name,
        goal: "Changed after the Run started",
        sharedContext: "",
        repositoryReferences: [],
      });

      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });
      assert.equal(completed.run.status, "completed");
      assert.deepEqual(
        completed.nodes.find((node) => node.pipelineNodeId === "condition")
          ?.result,
        {
          selectedBranchId: "original",
          leftValue: "Ship the checkout redesign",
        },
      );
    } finally {
      database.close();
    }
  });

  it("persists stable Condition failures for missing and invalid values", async () => {
    const cases = [
      {
        code: "CONDITION_VALUE_MISSING",
        structuredResult: {},
        operator: "equals" as const,
        value: "ready",
      },
      {
        code: "CONDITION_VALUE_INVALID",
        structuredResult: { value: 42 },
        operator: "in" as const,
        value: ["ready"],
      },
    ];
    for (const conditionCase of cases) {
      const { database, project, department } = setup(
        createScriptedExecutionAdapter({
          script: {
            source: [
              {
                kind: "succeeded",
                structuredResult: conditionCase.structuredResult,
              },
            ],
          },
        }),
        (positionId) => ({
          nodes: [
            { id: "start", type: "start", name: "Start" },
            {
              id: "source",
              type: "ai-task",
              name: "Source",
              positionId,
            },
            {
              id: "condition",
              type: "condition",
              name: "Condition",
              condition: {
                leftReference: "nodes.source.result.value",
                operator: conditionCase.operator,
                value: conditionCase.value,
                branches: [
                  { id: "yes", label: "Yes", kind: "match" },
                  { id: "fallback", label: "Fallback", kind: "default" },
                ],
              },
            },
            { id: "complete", type: "complete", name: "Complete" },
          ],
          edges: [
            { from: "start", to: "source" },
            { from: "source", to: "condition" },
            { from: "condition", to: "complete", branchId: "yes" },
          ],
        }),
      );
      try {
        const started = database.pipelineRuntime.startRun({
          projectId: project.id,
          departmentId: department.id,
        });
        await assert.rejects(
          () =>
            database.pipelineRuntime.executeReady({
              runId: started.run.id,
              expectedRevision: 0,
            }),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === conditionCase.code,
        );
        const failed = database.pipelineRuntime.inspectRun(started.run.id);
        assert.equal(failed.run.status, "failed");
        assert.equal(
          failed.nodes.find((node) => node.pipelineNodeId === "condition")
            ?.failure?.code,
          conditionCase.code,
        );
      } finally {
        database.close();
      }
    }
  });

  it("fails a historical Condition with no matching or default branch", async () => {
    const adapter = createScriptedExecutionAdapter({
      script: {
        source: [{ kind: "succeeded", structuredResult: { value: 1 } }],
      },
    });
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        {
          id: "source",
          type: "ai-task",
          name: "Source",
          positionId,
        },
        {
          id: "condition",
          type: "condition",
          name: "Condition",
          condition: {
            leftReference: "nodes.source.result.value",
            operator: "equals",
            value: 2,
            branches: [
              { id: "yes", label: "Yes", kind: "match" },
              { id: "fallback", label: "Fallback", kind: "default" },
            ],
          },
        },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "source" },
        { from: "source", to: "condition" },
        { from: "condition", to: "complete", branchId: "yes" },
        { from: "condition", to: "complete", branchId: "fallback" },
      ],
    }));
    try {
      const published = database.pipelineConfiguration.inspect(
        department.id,
      ).published;
      assert.ok(published);
      const historicalGraph = {
        ...published.graph,
        nodes: published.graph.nodes.map((node) =>
          node.id === "condition" && node.condition
            ? {
                ...node,
                condition: {
                  ...node.condition,
                  branches: node.condition.branches.filter(
                    (branch) => branch.kind === "match",
                  ),
                },
              }
            : node,
        ),
        edges: published.graph.edges.filter(
          (edge) => edge.branchId !== "fallback",
        ),
      };
      const fault = new DatabaseSync(database.path);
      try {
        fault
          .prepare(
            "UPDATE pipeline_versions SET graph_json = ?, hash = ? WHERE id = ?",
          )
          .run(
            canonicalPipelineJson(historicalGraph),
            pipelineHash(historicalGraph),
            published.id,
          );
      } finally {
        fault.close();
      }
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "CONDITION_BRANCH_NOT_FOUND",
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(started.run.id)
          .nodes.find((node) => node.pipelineNodeId === "condition")?.failure
          ?.code,
        "CONDITION_BRANCH_NOT_FOUND",
      );
    } finally {
      database.close();
    }
  });

  it("activates logical Parallel branches together and executes them in frozen graph order", async () => {
    const executed: string[] = [];
    let inspectDuringFirstBranch: (() => void) | undefined;
    const adapter = createScriptedExecutionAdapter({
      onExecute: ({ node }) => {
        executed.push(node.id);
        if (node.id === "branch-b") inspectDuringFirstBranch?.();
      },
    });
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "parallel", type: "parallel", name: "Parallel" },
        {
          id: "branch-b",
          type: "ai-task",
          name: "Branch B",
          positionId,
        },
        {
          id: "branch-a",
          type: "ai-task",
          name: "Branch A",
          positionId,
        },
        { id: "join", type: "join", name: "Join" },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "parallel" },
        { from: "parallel", to: "branch-a" },
        { from: "parallel", to: "branch-b" },
        { from: "branch-a", to: "join" },
        { from: "branch-b", to: "join" },
        { from: "join", to: "complete" },
      ],
    }));
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      inspectDuringFirstBranch = () => {
        const current = database.pipelineRuntime.inspectRun(started.run.id);
        assert.equal(
          current.nodes.find((node) => node.pipelineNodeId === "branch-b")
            ?.status,
          "running",
        );
        assert.equal(
          current.nodes.find((node) => node.pipelineNodeId === "branch-a")
            ?.status,
          "ready",
        );
        assert.equal(
          current.nodes.find((node) => node.pipelineNodeId === "join")?.status,
          "queued",
        );
      };

      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.deepEqual(executed, ["branch-b", "branch-a"]);
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "join")?.status,
        "succeeded",
      );
    } finally {
      database.close();
    }
  });

  it("executes Parallel AI Tasks concurrently when the Execution Adapter declares capacity", async () => {
    let active = 0;
    let maximumActive = 0;
    const adapter = {
      maxConcurrentNodes: 2,
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { kind: "succeeded" as const };
      },
    };
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "parallel", type: "parallel", name: "Parallel" },
        {
          id: "branch-a",
          type: "ai-task",
          name: "Branch A",
          positionId,
        },
        {
          id: "branch-b",
          type: "ai-task",
          name: "Branch B",
          positionId,
        },
        { id: "join", type: "join", name: "Join" },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "parallel" },
        { from: "parallel", to: "branch-a" },
        { from: "parallel", to: "branch-b" },
        { from: "branch-a", to: "join" },
        { from: "branch-b", to: "join" },
        { from: "join", to: "complete" },
      ],
    }));
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });

      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.equal(completed.snapshot.payload.runLimits.maxActiveNodes, 2);
      assert.equal(maximumActive, 2);
    } finally {
      database.close();
    }
  });

  it("completes the deterministic Approval → Condition → Parallel/Join tracer", async () => {
    const executed: string[] = [];
    const adapter = createScriptedExecutionAdapter({
      script: {
        classify: [
          {
            kind: "succeeded",
            structuredResult: { route: "ship" },
          },
        ],
      },
      onExecute: ({ node }) => executed.push(node.id),
    });
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        { id: "start", type: "start", name: "Start" },
        {
          id: "classify",
          type: "ai-task",
          name: "Classify",
          positionId,
        },
        {
          id: "approval",
          type: "human-approval",
          name: "Approval",
          positionId,
        },
        {
          id: "condition",
          type: "condition",
          name: "Condition",
          condition: {
            leftReference: "nodes.classify.result.route",
            operator: "equals",
            value: "ship",
            branches: [
              { id: "ship", label: "Ship", kind: "match" },
              { id: "hold", label: "Hold", kind: "no-match" },
              { id: "fallback", label: "Fallback", kind: "default" },
            ],
          },
        },
        { id: "parallel", type: "parallel", name: "Parallel" },
        {
          id: "branch-a",
          type: "ai-task",
          name: "Branch A",
          positionId,
        },
        {
          id: "branch-b",
          type: "ai-task",
          name: "Branch B",
          positionId,
        },
        { id: "hold-task", type: "ai-task", name: "Hold", positionId },
        { id: "join", type: "join", name: "Join" },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [
        { from: "start", to: "classify" },
        { from: "classify", to: "approval" },
        { from: "approval", to: "condition" },
        { from: "condition", to: "parallel", branchId: "ship" },
        { from: "condition", to: "hold-task", branchId: "hold" },
        { from: "parallel", to: "branch-a" },
        { from: "parallel", to: "branch-b" },
        { from: "branch-a", to: "join" },
        { from: "branch-b", to: "join" },
        { from: "hold-task", to: "join" },
        { from: "join", to: "complete" },
      ],
    }));
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });
      assert.equal(waiting.run.status, "waiting-approval");
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);

      const approved = database.pipelineRuntime.decideApproval({
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "approve",
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.deepEqual(executed, ["classify", "branch-a", "branch-b"]);
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "hold-task")
          ?.status,
        "skipped",
      );
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "join")?.status,
        "succeeded",
      );
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "complete")
          ?.status,
        "succeeded",
      );
    } finally {
      database.close();
    }
  });

  it("fails Join and never reaches Complete when a required Parallel branch fails", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter({
        script: {
          "branch-a": [
            {
              kind: "failed",
              code: "SCRIPTED_BRANCH_FAILED",
              message: "Branch A failed.",
            },
          ],
        },
      }),
      (positionId) => ({
        nodes: [
          { id: "start", type: "start", name: "Start" },
          { id: "parallel", type: "parallel", name: "Parallel" },
          {
            id: "branch-a",
            type: "ai-task",
            name: "Branch A",
            positionId,
          },
          {
            id: "branch-b",
            type: "ai-task",
            name: "Branch B",
            positionId,
          },
          { id: "join", type: "join", name: "Join" },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "parallel" },
          { from: "parallel", to: "branch-a" },
          { from: "parallel", to: "branch-b" },
          { from: "branch-a", to: "join" },
          { from: "branch-b", to: "join" },
          { from: "join", to: "complete" },
        ],
      }),
    );
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });

      assert.equal(failed.run.status, "failed");
      assert.equal(
        failed.nodes.find((node) => node.pipelineNodeId === "join")?.status,
        "failed",
      );
      assert.equal(
        failed.nodes.find((node) => node.pipelineNodeId === "join")?.failure
          ?.code,
        "JOIN_DEPENDENCY_FAILED",
      );
      assert.equal(
        failed.nodes.find((node) => node.pipelineNodeId === "complete")?.status,
        "queued",
      );
    } finally {
      database.close();
    }
  });

  it("creates an immutable r1 Snapshot and initial Ready/Queued Node runs", () => {
    const { database, project, department, profile } = setup();
    try {
      const reference = database.catalog.createSecretReference({
        departmentId: department.id,
        name: "Provider credential reference",
        providerScope: "credential-scope-never-snapshot",
      }).secretReferences[0];
      assert.ok(reference);
      database.catalog.saveExecutionProfile({
        departmentId: department.id,
        executionProfileId: profile.id,
        expectedRevision: 0,
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        timeoutSeconds: profile.limits.timeoutSeconds,
        maxIterations: profile.limits.maxIterations,
        maxTokens: profile.limits.maxTokens,
        retryMaxAttempts: profile.retryPolicy.maxAttempts,
        permissionPolicy: profile.permissionPolicy,
        secretReferenceIds: [reference.id],
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });

      assert.equal(started.run.status, "ready");
      assert.equal(started.run.revision, 0);
      assert.equal(started.snapshot.revision, 1);
      assert.match(started.snapshot.hash, /^[a-f0-9]{64}$/);
      assert.equal(
        started.snapshot.hash,
        createHash("sha256")
          .update(started.snapshot.canonicalJson)
          .digest("hex"),
      );
      assert.notEqual(started.nodes[0]?.id, "start");
      assert.equal(
        started.nodes.find((node) => node.pipelineNodeId === "start")?.status,
        "ready",
      );
      assert.equal(
        started.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.status,
        "queued",
      );
      assert.equal(
        started.nodes.find((node) => node.pipelineNodeId === "complete")
          ?.status,
        "queued",
      );
      assert.equal(started.snapshot.payload.pipelineVersion.version, 1);
      assert.equal(
        started.snapshot.payload.executionProfiles[0]?.providerRef,
        "scripted",
      );
      assert.deepEqual(
        started.snapshot.payload.executionProfiles[0]?.secretReferenceIds,
        [reference.id],
      );
      assert.equal(
        started.snapshot.canonicalJson.includes(reference.name),
        false,
      );
      assert.equal(
        started.snapshot.canonicalJson.includes(reference.providerScope),
        false,
      );
      assert.equal(JSON.stringify(started).includes("secretValue"), false);
      assert.equal(JSON.stringify(started).includes("apiKey"), false);
    } finally {
      database.close();
    }
  });

  it("records an explicit temporary Agent override and Position Skills in the Run Snapshot", () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
        agentOverrideId: "claude-code",
      });
      const position = started.snapshot.payload.positions[0];
      assert.ok(position);
      assert.equal(position.defaultAgentId, "codex");
      assert.equal(position.resolvedAgentId, "claude-code");
      assert.equal(position.agentSource, "run-override");
      assert.deepEqual(position.skillIds, []);
      const audit = database.pipelineRuntime.auditRecords({
        runId: started.run.id,
      });
      assert.equal(
        JSON.stringify(audit).includes('"agentOverrideId":"claude-code"'),
        true,
      );
      const events = database.pipelineRuntime.runtimeEvents({
        afterSequence: 0,
        limit: 100,
      });
      assert.equal(
        JSON.stringify(events).includes('"agentOverrideId":"claude-code"'),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("freezes Position Skill versions in the Run Snapshot", () => {
    const { database, project, department, position } = setup();
    try {
      const configuration = database.skillConfiguration.inspect(department.id);
      const saved = database.skillConfiguration.saveSkill({
        departmentId: department.id,
        expectedRevision: configuration.revision,
        name: "Release Review",
        description: "Reviews release evidence.",
        source: "company-skills",
        version: "sha256:release-review-v1",
        locationReference: "/company-skills/release-review/SKILL.md",
      });
      const skill = saved.activeSkills.find(
        (candidate) => candidate.name === "Release Review",
      );
      assert.ok(skill);
      database.skillConfiguration.setPositionSkills({
        departmentId: department.id,
        positionId: position.id,
        expectedRevision: saved.revision,
        skillIds: [skill.id],
      });

      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const snapshotPosition = started.snapshot.payload.positions.find(
        (candidate) => candidate.id === position.id,
      );
      assert.ok(snapshotPosition);
      assert.deepEqual(snapshotPosition.skillSnapshots, [
        { id: skill.id, version: "sha256:release-review-v1" },
      ]);
    } finally {
      database.close();
    }
  });

  it("executes the injected adapter and reloads the completed read model", async () => {
    const facts: string[] = [];
    const adapter = createScriptedExecutionAdapter({
      defaultFact: {
        kind: "succeeded",
        structuredResult: { summary: "implemented" },
      },
      onExecute: ({ node }) => {
        facts.push(node.id);
      },
    });
    const { database, project, department } = setup(adapter);
    const companyDir = database.path.slice(
      0,
      -"/.sandcastle/company.sqlite".length,
    );
    let snapshotHash = "";
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      snapshotHash = started.snapshot.hash;
      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.deepEqual(facts, ["implement"]);
      assert.deepEqual(
        completed.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.result,
        { summary: "implemented" },
      );
      assert.equal(
        completed.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.attemptCount,
        1,
      );
      assert.deepEqual(
        completed.nodes
          .find((node) => node.pipelineNodeId === "implement")
          ?.attempts.map((attempt) => ({
            attemptNumber: attempt.attemptNumber,
            reason: attempt.reason,
            status: attempt.status,
            snapshotRevisionId: attempt.snapshotRevisionId,
            result: attempt.result,
            feedback: attempt.feedback,
          })),
        [
          {
            attemptNumber: 1,
            reason: "initial",
            status: "succeeded",
            snapshotRevisionId: completed.snapshot.id,
            result: { summary: "implemented" },
            feedback: [],
          },
        ],
      );
    } finally {
      database.close();
    }

    const reloaded = openCompanyDatabase(companyDir);
    try {
      const run = reloaded.pipelineRuntime.listRuns({
        projectId: project.id,
      })[0];
      assert.ok(run);
      assert.equal(run.run.status, "completed");
      assert.equal(run.snapshot.hash, snapshotHash);
    } finally {
      reloaded.close();
    }
  });

  it("runs one project-spec AI Task through fenced Scripted Execution Facts", async () => {
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "scripted-started",
            ordinal: 1,
            kind: "provider-started",
            schemaVersion: 1,
            payload: { providerExecutionRef: "scripted:project-spec" },
            evidenceRefs: ["receipt:scripted:project-spec"],
          },
          {
            adapterSchemaVersion: 1,
            factId: "scripted-message",
            ordinal: 2,
            kind: "message",
            schemaVersion: 1,
            payload: { text: "Project specification prepared." },
            evidenceRefs: [],
          },
          {
            adapterSchemaVersion: 1,
            factId: "scripted-started",
            ordinal: 1,
            kind: "provider-started",
            schemaVersion: 1,
            payload: { providerExecutionRef: "scripted:project-spec" },
            evidenceRefs: ["receipt:scripted:project-spec"],
          },
          {
            adapterSchemaVersion: 1,
            factId: "scripted-completed",
            ordinal: 3,
            kind: "completed",
            schemaVersion: 1,
            payload: {
              structuredResult: { summary: "Project specification prepared." },
              artifacts: [
                {
                  type: "project-spec",
                  schemaVersion: "1",
                  logicalName: "checkout-project-spec",
                  content: "Project specification prepared.",
                },
              ],
            },
            evidenceRefs: ["receipt:scripted:project-spec"],
          },
        ],
      },
    });
    const { database, project, department, position } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      assert.deepEqual(
        completed.nodes.find((node) => node.pipelineNodeId === "project-spec")
          ?.result,
        { summary: "Project specification prepared." },
      );
      const attempt = completed.nodes
        .find((node) => node.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.ok(attempt);
      const execution = database.pipelineRuntime.inspectExecution({
        attemptId: attempt.id,
      });
      assert.equal(execution.operationKey, `node-attempt:${attempt.id}`);
      assert.equal(execution.facts.length, 3);
      assert.equal(execution.facts[0]?.target.id, attempt.id);
      assert.equal(execution.facts[0]?.leaseId, execution.leases[0]?.leaseId);
      assert.equal(execution.facts[0]?.executionEpoch, 1);
      assert.equal(execution.facts[0]?.fenceToken.length > 0, true);
      assert.equal(
        execution.facts[0]?.canonicalPayloadHash,
        "ffc380e751000aff1a9ca7a6e8db42adcb06eec0686e8cde463169f335432c1f",
      );
      assert.deepEqual(
        execution.facts.map((fact) => [fact.ordinal, fact.kind, fact.status]),
        [
          [1, "provider-started", "accepted"],
          [2, "message", "accepted"],
          [3, "completed", "accepted"],
        ],
      );
      assert.equal(execution.leases[0]?.leaseKind, "execution");
      assert.equal(execution.leases[0]?.releasedAt !== null, true);
      assert.equal(execution.terminalFactId, execution.facts.at(-1)?.id);
      const artifact = database.artifactRegistry.listVersions(project.id)[0];
      assert.ok(artifact);
      assert.deepEqual(artifact.producer, {
        runId: completed.run.id,
        nodeRunId: completed.nodes.find(
          (node) => node.pipelineNodeId === "project-spec",
        )?.id,
        nodeAttemptId: attempt.id,
        snapshotRevisionId: completed.snapshot.id,
        aiMemberId: completed.snapshot.payload.positions.find(
          (candidate) => candidate.id === position.id,
        )?.aiMember.id,
      });
      assert.deepEqual(execution.facts.at(-1)?.effectIds, [artifact.id]);
      assert.equal(position.id.length > 0, true);
    } finally {
      database.close();
    }
  });

  it("rejects a conflicting Execution Fact identity without overwriting the Attempt", async () => {
    let attemptId = "";
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "same-fact",
            ordinal: 1,
            kind: "provider-started",
            schemaVersion: 1,
            payload: { providerExecutionRef: "scripted:first" },
            evidenceRefs: [],
          },
          {
            adapterSchemaVersion: 1,
            factId: "same-fact",
            ordinal: 1,
            kind: "provider-started",
            schemaVersion: 1,
            payload: { providerExecutionRef: "scripted:conflict" },
            evidenceRefs: [],
          },
        ],
      },
      onExecute: (input) => {
        attemptId = input.attempt.id;
      },
    });
    const { database, project, department } = setup(adapter, (positionId) => ({
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          handlerKindId: "run-start@1",
        },
        {
          id: "project-spec",
          type: "ai-task",
          name: "Project Spec",
          positionId,
          handlerKindId: "project-spec@1",
        },
        {
          id: "complete",
          type: "complete",
          name: "Complete",
          handlerKindId: "run-complete@1",
        },
      ],
      edges: [
        { from: "start", to: "project-spec" },
        { from: "project-spec", to: "complete" },
      ],
    }));
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_FACT_CONFLICT",
      );

      const failed = database.pipelineRuntime.inspectRun(started.run.id);
      const attempt = failed.nodes
        .find((node) => node.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.equal(failed.run.status, "failed");
      assert.equal(attempt?.id, attemptId);
      assert.equal(attempt?.failure?.code, "EXECUTION_FACT_CONFLICT");
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId })
          .facts.map((fact) => fact.status),
        ["accepted", "conflict"],
      );
    } finally {
      database.close();
    }
  });

  it("rejects a conflicting Execution Fact ordinal with a different fact identity", async () => {
    let attemptId = "";
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "first-fact",
            ordinal: 1,
            kind: "provider-started",
            schemaVersion: 1,
            payload: { providerExecutionRef: "scripted:first" },
            evidenceRefs: [],
          },
          {
            adapterSchemaVersion: 1,
            factId: "different-fact",
            ordinal: 1,
            kind: "message",
            schemaVersion: 1,
            payload: { text: "Conflicting ordinal." },
            evidenceRefs: [],
          },
        ],
      },
      onExecute: (input) => {
        attemptId = input.attempt.id;
      },
    });
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });

      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_FACT_CONFLICT",
      );

      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId })
          .facts.map((fact) => [fact.factId, fact.ordinal, fact.status]),
        [
          ["first-fact", 1, "accepted"],
          ["different-fact", 1, "conflict"],
        ],
      );
    } finally {
      database.close();
    }
  });

  it("rejects a second terminal Execution Fact through terminal CAS", async () => {
    let attemptId = "";
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "completed-first",
            ordinal: 1,
            kind: "completed",
            schemaVersion: 1,
            payload: { structuredResult: { accepted: true } },
            evidenceRefs: [],
          },
          {
            adapterSchemaVersion: 1,
            factId: "failed-second",
            ordinal: 2,
            kind: "failed",
            schemaVersion: 1,
            payload: { code: "LATE_FAILURE", message: "Too late." },
            evidenceRefs: [],
          },
        ],
      },
      onExecute: (input) => {
        attemptId = input.attempt.id;
      },
    });
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });

      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_FACT_CONFLICT",
      );

      const execution = database.pipelineRuntime.inspectExecution({
        attemptId,
      });
      assert.equal(execution.terminalFactId, execution.facts[0]?.id);
      assert.deepEqual(
        execution.facts.map((fact) => [fact.factId, fact.status]),
        [
          ["completed-first", "accepted"],
          ["failed-second", "conflict"],
        ],
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(started.run.id)
          .nodes.find((node) => node.pipelineNodeId === "project-spec")?.status,
        "succeeded",
      );
    } finally {
      database.close();
    }
  });

  it("applies a cancelled terminal Execution Fact as a cancelled Attempt and Run", async () => {
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "cancelled",
            ordinal: 1,
            kind: "cancelled",
            schemaVersion: 1,
            payload: { code: "USER_CANCELLED", message: "Cancelled by user." },
            evidenceRefs: ["provider-receipt:cancelled"],
          },
        ],
      },
    });
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const cancelled = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const node = cancelled.nodes.find(
        (candidate) => candidate.pipelineNodeId === "project-spec",
      );

      assert.equal(cancelled.run.status, "cancelled");
      assert.equal(node?.status, "cancelled");
      assert.equal(node?.attempts.at(-1)?.status, "cancelled");
      assert.equal(node?.attempts.at(-1)?.failure?.code, "USER_CANCELLED");
    } finally {
      database.close();
    }
  });

  it("applies a failed terminal Execution Fact as a recoverable failed Attempt", async () => {
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "failed",
            ordinal: 1,
            kind: "failed",
            schemaVersion: 1,
            payload: { code: "SCRIPTED_FAILURE", message: "Scripted failure." },
            evidenceRefs: ["provider-receipt:failed"],
          },
        ],
      },
    });
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const attempt = failed.nodes
        .find((candidate) => candidate.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);

      assert.equal(failed.run.status, "failed");
      assert.equal(attempt?.status, "failed");
      assert.equal(attempt?.recoverable, true);
      assert.equal(attempt?.failure?.code, "SCRIPTED_FAILURE");
    } finally {
      database.close();
    }
  });

  it("rejects an Adapter completion whose status disagrees with the accepted terminal Fact", async () => {
    let attemptId = "";
    const adapter = {
      execute: async (
        input: Parameters<
          ReturnType<typeof createScriptedExecutionAdapter>["execute"]
        >[0],
        sink: Parameters<
          ReturnType<typeof createScriptedExecutionAdapter>["execute"]
        >[1],
      ) => {
        assert.ok(input.request);
        assert.ok(sink);
        attemptId = input.attempt.id;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "completed",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: { structuredResult: { authoritative: true } },
          evidenceRefs: [],
        });
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "failed" as const,
          evidenceRefs: [],
        };
      },
    };
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });

      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_ADAPTER_PROTOCOL",
      );

      const authoritative = database.pipelineRuntime.inspectRun(started.run.id);
      const attempt = authoritative.nodes
        .find((candidate) => candidate.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.equal(attempt?.id, attemptId);
      assert.equal(attempt?.status, "succeeded");
      assert.deepEqual(attempt?.result, { authoritative: true });
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId }).terminalFactId,
        attempt?.id === attemptId
          ? database.pipelineRuntime.inspectExecution({ attemptId }).facts[0]
              ?.id
          : null,
      );
    } finally {
      database.close();
    }
  });

  it("fails a Running Attempt recoverably when Adapter completion has no persisted terminal Fact", async () => {
    let attemptId = "";
    const adapter = {
      execute: async (
        input: Parameters<
          ReturnType<typeof createScriptedExecutionAdapter>["execute"]
        >[0],
      ) => {
        assert.ok(input.request);
        attemptId = input.attempt.id;
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: "missing-terminal-fact",
          status: "succeeded" as const,
          evidenceRefs: [],
        };
      },
    };
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });

      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_ADAPTER_PROTOCOL",
      );

      const failed = database.pipelineRuntime.inspectRun(started.run.id);
      const attempt = failed.nodes
        .find((candidate) => candidate.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.equal(attempt?.id, attemptId);
      assert.equal(attempt?.status, "failed");
      assert.equal(attempt?.recoverable, true);
      assert.equal(attempt?.failure?.code, "EXECUTION_ADAPTER_PROTOCOL");
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId }).leases[0]
          ?.releasedAt !== null,
        true,
      );
    } finally {
      database.close();
    }
  });

  it("pauses an ask-scoped Execution on an exact Permission and resumes only after a verified decision", async () => {
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "permission",
            ordinal: 1,
            kind: "permission-request",
            schemaVersion: 1,
            payload: { scope: "repository.write" },
            evidenceRefs: [],
          },
          {
            adapterSchemaVersion: 1,
            factId: "completed",
            ordinal: 2,
            kind: "completed",
            schemaVersion: 1,
            payload: { structuredResult: { permitted: true } },
            evidenceRefs: [],
          },
        ],
      },
    });
    const { database, project, department, profile } = setup(
      adapter,
      projectSpecGraph,
    );
    try {
      database.catalog.saveExecutionProfile({
        departmentId: department.id,
        executionProfileId: profile.id,
        expectedRevision: profile.revision,
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        timeoutSeconds: profile.limits.timeoutSeconds,
        maxIterations: profile.limits.maxIterations,
        maxTokens: profile.limits.maxTokens,
        retryMaxAttempts: profile.retryPolicy.maxAttempts,
        permissionPolicy: "ask",
        secretReferenceIds: profile.secretReferenceIds,
      });
      const { actor, started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const waitingNode = waiting.nodes.find(
        (candidate) => candidate.pipelineNodeId === "project-spec",
      );
      const permission = database.interaction
        .listSessions(project.id)
        .flatMap((session) => session.permissions)
        .at(-1);
      assert.ok(permission);
      assert.equal(waiting.run.status, "running");
      assert.equal(waitingNode?.status, "waiting-permission");
      assert.equal(permission.scope, "repository.write");
      assert.equal(permission.status, "pending");
      const waitingAttempt = waitingNode?.attempts.at(-1);
      assert.ok(waitingAttempt);
      const waitingExecution = database.pipelineRuntime.inspectExecution({
        attemptId: waitingAttempt.id,
      });
      assert.deepEqual(waitingExecution.facts[0]?.effectIds, [permission.id]);
      assert.equal(
        database.pipelineRuntime
          .auditRecords({ runId: started.run.id })
          .some((record) => record.action === "permission.request"),
        true,
      );
      assert.equal(
        database.pipelineRuntime
          .runtimeEvents({ afterSequence: 0, limit: 1_000 })
          .some(
            (event) =>
              event.runId === started.run.id &&
              event.type === "execution.fact.accepted",
          ),
        true,
      );
      assert.throws(
        () =>
          database.pipelineRuntime.decidePermission({
            permissionId: permission.id,
            expectedStatus: "pending",
            decision: "approved",
            actor: {
              type: "test-driver",
              id: "forged-human",
              authenticatedBy: "runtime",
            },
            commandId: "permission:forged",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PERMISSION_ACTOR_INVALID",
      );

      const decision = database.pipelineRuntime.decidePermission({
        permissionId: permission.id,
        expectedStatus: "pending",
        decision: "approved",
        actor,
        commandId: "permission:approved",
      });
      assert.equal(decision.status, "approved");
      const ready = database.pipelineRuntime.inspectRun(started.run.id);
      assert.equal(
        ready.nodes.find(
          (candidate) => candidate.pipelineNodeId === "project-spec",
        )?.status,
        "ready",
      );

      const completed = await database.pipelineRuntime.executeReady({
        runId: ready.run.id,
        expectedRevision: ready.run.revision,
      });
      const attempt = completed.nodes
        .find((candidate) => candidate.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.equal(completed.run.status, "completed");
      assert.deepEqual(attempt?.result, { permitted: true });
      assert.ok(attempt);
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: attempt.id })
          .facts.map((fact) => [fact.kind, fact.status, fact.executionEpoch]),
        [
          ["permission-request", "accepted", 1],
          ["completed", "accepted", 2],
        ],
      );
    } finally {
      database.close();
    }
  });

  it("denies a scripted Permission Fact when the frozen Execution Profile policy is deny", async () => {
    const adapter = createScriptedExecutionAdapter({
      facts: {
        "project-spec": [
          {
            adapterSchemaVersion: 1,
            factId: "permission",
            ordinal: 1,
            kind: "permission-request",
            schemaVersion: 1,
            payload: { scope: "repository.write" },
            evidenceRefs: [],
          },
        ],
      },
    });
    const { database, project, department } = setup(adapter, projectSpecGraph);
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const denied = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const attempt = denied.nodes
        .find((candidate) => candidate.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);

      assert.equal(denied.run.status, "failed");
      assert.equal(attempt?.failure?.code, "PERMISSION_DENIED");
      assert.equal(
        database.interaction
          .listSessions(project.id)
          .flatMap((session) => session.permissions).length,
        0,
      );
    } finally {
      database.close();
    }
  });

  it("records an old-fence terminal Fact as stale after lease loss", async () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const clock = () => new Date(now);
    let releaseAdapter!: () => void;
    let adapterStarted!: () => void;
    const startedByAdapter = new Promise<void>((resolve) => {
      adapterStarted = resolve;
    });
    const adapterRelease = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const adapter = {
      execute: async (
        input: Parameters<
          ReturnType<typeof createScriptedExecutionAdapter>["execute"]
        >[0],
        sink: Parameters<
          ReturnType<typeof createScriptedExecutionAdapter>["execute"]
        >[1],
      ) => {
        adapterStarted();
        await adapterRelease;
        assert.ok(input.request);
        assert.ok(sink);
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "late-terminal",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: { structuredResult: { late: true } },
          evidenceRefs: [],
        });
        assert.equal(receipt.status, "stale");
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded" as const,
          evidenceRefs: [],
        };
      },
    };
    const { database, project, department } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
      clock,
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const executing = database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      await startedByAdapter;
      now = new Date("2026-07-24T00:01:01.000Z");
      assert.equal(database.pipelineRuntime.recoverExpiredLeases(), 1);
      releaseAdapter();
      await assert.rejects(
        () => executing,
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EXECUTION_ADAPTER_PROTOCOL",
      );

      const failed = database.pipelineRuntime.inspectRun(started.run.id);
      const attempt = failed.nodes
        .find((node) => node.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.ok(attempt);
      assert.equal(attempt.failure?.code, "EXECUTION_RECONCILIATION_REQUIRED");
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: attempt.id })
          .facts.map((fact) => [fact.kind, fact.status]),
        [["completed", "stale"]],
      );
    } finally {
      database.close();
    }
  });

  it("reconciles an expired Node execution as not-started before allowing replacement work", async () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const clock = () => new Date(now);
    let reconciliationCalls = 0;
    const adapter = {
      execute: async () => ({
        kind: "failed" as const,
        code: "SCRIPTED_PREPARE_RETRY",
        message: "Prepare a Retry Attempt for lease reconciliation.",
      }),
      reconcile: async (
        input: {
          readonly operationKey: string;
          readonly reconciliationLease: {
            readonly operationKey: string;
            readonly leaseKind: "reconciliation";
          };
        },
        sink: ExecutionEventSink,
      ) => {
        reconciliationCalls += 1;
        assert.equal(input.reconciliationLease.leaseKind, "reconciliation");
        assert.equal(
          input.reconciliationLease.operationKey,
          input.operationKey,
        );
        if (reconciliationCalls === 1) {
          return {
            status: "unknown" as const,
            evidenceRefs: ["provider-receipt:unknown"],
          };
        }
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-not-started",
          ordinal: 1,
          kind: "not-started",
          schemaVersion: 1,
          payload: { providerReceipt: "provider-receipt:not-started" },
          evidenceRefs: ["provider-receipt:not-started"],
        });
        return {
          status: "not-started" as const,
          terminalExecutionFactId: receipt.executionFactId,
          evidenceRefs: ["provider-receipt:not-started"],
        };
      },
    };
    const { database, project, department } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
            retryMaxAttempts: 1,
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
      clock,
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const projectSpec = failed.nodes.find(
        (node) => node.pipelineNodeId === "project-spec",
      );
      assert.ok(projectSpec);
      const retrying = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: projectSpec.id,
        expectedRevision: failed.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        workerId: "execution-worker",
        leaseDurationMs: 60_000,
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") assert.fail("Attempt was not claimed.");

      now = new Date("2026-07-24T00:01:01.000Z");
      assert.equal(database.pipelineRuntime.recoverExpiredLeases(), 1);
      const expired = database.pipelineRuntime.inspectRun(retrying.run.id);
      const reconcilingAttempt = expired.nodes
        .find((node) => node.id === projectSpec.id)
        ?.attempts.at(-1);
      assert.equal(expired.run.status, "blocked");
      assert.equal(reconcilingAttempt?.status, "reconciling");

      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      const unknown = database.pipelineRuntime.inspectRun(retrying.run.id);
      assert.equal(unknown.run.status, "blocked");
      assert.equal(
        unknown.nodes
          .find((node) => node.id === projectSpec.id)
          ?.attempts.at(-1)?.status,
        "reconciling",
      );
      assert.throws(
        () =>
          database.pipelineRuntime.retryNode({
            runId: unknown.run.id,
            nodeRunId: projectSpec.id,
            expectedRevision: unknown.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RETRY_STATE_INVALID",
      );
      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      const reconciled = database.pipelineRuntime.inspectRun(retrying.run.id);
      const interruptedAttempt = reconciled.nodes
        .find((node) => node.id === projectSpec.id)
        ?.attempts.at(-1);
      assert.equal(interruptedAttempt?.id, claim.attemptId);
      assert.equal(interruptedAttempt?.status, "interrupted");
      assert.equal(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .facts.at(-1)?.kind,
        "not-started",
      );
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .leases.map((lease) => [lease.leaseKind, lease.executionEpoch]),
        [
          ["execution", 1],
          ["reconciliation", 2],
          ["reconciliation", 3],
        ],
      );
    } finally {
      database.close();
    }
  });

  it("registers reconciled completion Artifacts before releasing downstream work", async () => {
    let now = new Date("2026-07-24T00:30:00.000Z");
    const clock = () => new Date(now);
    const adapter = {
      execute: async () => ({
        kind: "failed" as const,
        code: "SCRIPTED_PREPARE_RECONCILIATION",
        message: "Prepare an expired Attempt for completed reconciliation.",
      }),
      reconcile: async (_input: unknown, sink: ExecutionEventSink) => {
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-reconciled-completion",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {
            structuredResult: { reconciled: true },
            artifacts: [
              {
                type: "project-spec",
                schemaVersion: "1",
                logicalName: "checkout-project-spec",
                content: "Reconciled project specification.",
              },
            ],
          },
          evidenceRefs: ["provider-receipt:reconciled-completion"],
        });
        return {
          status: "succeeded" as const,
          terminalExecutionFactId: receipt.executionFactId,
          evidenceRefs: ["provider-receipt:reconciled-completion"],
        };
      },
    };
    const { database, project, department, position } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
            retryMaxAttempts: 1,
          },
          {
            id: "verify",
            type: "ai-task",
            name: "Verify",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "verify" },
          { from: "verify", to: "complete" },
        ],
      }),
      clock,
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const projectSpec = failed.nodes.find(
        (node) => node.pipelineNodeId === "project-spec",
      );
      assert.ok(projectSpec);
      const retrying = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: projectSpec.id,
        expectedRevision: failed.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        workerId: "execution-worker",
        leaseDurationMs: 60_000,
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") assert.fail("Attempt was not claimed.");

      now = new Date("2026-07-24T00:31:01.000Z");
      assert.equal(database.pipelineRuntime.recoverExpiredLeases(), 1);
      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );

      const reconciled = database.pipelineRuntime.inspectRun(retrying.run.id);
      const reconciledNode = reconciled.nodes.find(
        (node) => node.id === projectSpec.id,
      );
      const verifyNode = reconciled.nodes.find(
        (node) => node.pipelineNodeId === "verify",
      );
      assert.equal(reconciled.run.status, "running");
      assert.equal(reconciledNode?.status, "succeeded");
      assert.equal(reconciledNode?.attempts.at(-1)?.id, claim.attemptId);
      assert.equal(reconciledNode?.attempts.at(-1)?.status, "succeeded");
      assert.deepEqual(reconciledNode?.result, { reconciled: true });
      assert.equal(verifyNode?.status, "ready");

      const artifact = database.artifactRegistry.listVersions(project.id)[0];
      assert.ok(artifact);
      assert.deepEqual(artifact.producer, {
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        nodeAttemptId: claim.attemptId,
        snapshotRevisionId: retrying.snapshot.id,
        aiMemberId: position.aiMember.id,
      });
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .facts.at(-1)?.effectIds,
        [artifact.id],
      );
    } finally {
      database.close();
    }
  });

  it("retries reconciliation errors and unsupported reattachment under new fences", async () => {
    let now = new Date("2026-07-24T00:45:00.000Z");
    const clock = () => new Date(now);
    let reconciliationCalls = 0;
    const adapter = {
      execute: async () => ({
        kind: "failed" as const,
        code: "SCRIPTED_PREPARE_RECONCILIATION",
        message: "Prepare an expired Attempt for reconciliation retries.",
      }),
      reconcile: async (_input: unknown, sink: ExecutionEventSink) => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) {
          throw new Error("provider reconciliation temporarily unavailable");
        }
        if (reconciliationCalls === 2) {
          return {
            status: "running" as const,
            providerExecutionRef: "provider-execution:unattachable",
          };
        }
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-reconciled-failure",
          ordinal: 1,
          kind: "failed",
          schemaVersion: 1,
          payload: {
            code: "PROVIDER_EXECUTION_FAILED",
            message: "Provider confirmed execution failure.",
          },
          evidenceRefs: ["provider-receipt:failed"],
        });
        return {
          status: "failed" as const,
          terminalExecutionFactId: receipt.executionFactId,
          evidenceRefs: ["provider-receipt:failed"],
        };
      },
    };
    const { database, project, department } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
            retryMaxAttempts: 1,
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
      clock,
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const projectSpec = failed.nodes.find(
        (node) => node.pipelineNodeId === "project-spec",
      );
      assert.ok(projectSpec);
      const retrying = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: projectSpec.id,
        expectedRevision: failed.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        workerId: "execution-worker",
        leaseDurationMs: 60_000,
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") assert.fail("Attempt was not claimed.");

      now = new Date("2026-07-24T00:46:01.000Z");
      assert.equal(database.pipelineRuntime.recoverExpiredLeases(), 1);
      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(retrying.run.id)
          .nodes.find((node) => node.id === projectSpec.id)
          ?.attempts.at(-1)?.status,
        "reconciling",
      );

      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(retrying.run.id)
          .nodes.find((node) => node.id === projectSpec.id)
          ?.attempts.at(-1)?.status,
        "reconciling",
      );

      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      const settled = database.pipelineRuntime.inspectRun(retrying.run.id);
      const settledAttempt = settled.nodes
        .find((node) => node.id === projectSpec.id)
        ?.attempts.at(-1);
      assert.equal(settled.run.status, "failed");
      assert.equal(settledAttempt?.id, claim.attemptId);
      assert.equal(settledAttempt?.status, "failed");
      assert.equal(settledAttempt?.failure?.code, "PROVIDER_EXECUTION_FAILED");
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .leases.map((lease) => [
            lease.leaseKind,
            lease.executionEpoch,
            lease.releasedAt !== null,
          ]),
        [
          ["execution", 1, true],
          ["reconciliation", 2, true],
          ["reconciliation", 3, true],
          ["reconciliation", 4, true],
        ],
      );
    } finally {
      database.close();
    }
  });

  it("reattaches a proven running Node execution under a new execution fence", async () => {
    let now = new Date("2026-07-24T01:00:00.000Z");
    const clock = () => new Date(now);
    let reattachedProviderRef = "";
    const adapter = {
      capabilities: {
        reattachRunningOperation: true,
        strongExecutionFence: true,
        enforceNoSideEffects: false as const,
      },
      execute: async () => ({
        kind: "failed" as const,
        code: "SCRIPTED_PREPARE_REATTACH",
        message: "Prepare a Retry Attempt for running reconciliation.",
      }),
      reconcile: async () => ({
        status: "running" as const,
        providerExecutionRef: "provider-execution:running",
      }),
      reattach: async (
        input: ExecutionAdapterInput,
        providerExecutionRef: string,
        sink: ExecutionEventSink,
      ) => {
        assert.ok(input.request);
        assert.equal(input.request.lease.leaseKind, "execution");
        assert.equal(input.request.lease.executionEpoch, 3);
        reattachedProviderRef = providerExecutionRef;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: "provider-completed-after-reattach",
          ordinal: 1,
          kind: "completed",
          schemaVersion: 1,
          payload: {
            structuredResult: { reattached: true },
            artifacts: [
              {
                type: "project-spec",
                schemaVersion: "1",
                logicalName: "reattached-project-spec",
                content: "Reattached project specification.",
              },
            ],
          },
          evidenceRefs: ["provider-receipt:reattached"],
        });
        return {
          operationKey: input.request.operationKey,
          terminalExecutionFactId: receipt.executionFactId,
          status: "succeeded" as const,
          evidenceRefs: ["provider-receipt:reattached"],
        };
      },
    };
    const { database, project, department, position } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
            retryMaxAttempts: 1,
          },
          {
            id: "verify",
            type: "ai-task",
            name: "Verify",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "verify" },
          { from: "verify", to: "complete" },
        ],
      }),
      clock,
    );
    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const projectSpec = failed.nodes.find(
        (node) => node.pipelineNodeId === "project-spec",
      );
      assert.ok(projectSpec);
      const retrying = database.pipelineRuntime.retryNode({
        runId: failed.run.id,
        nodeRunId: projectSpec.id,
        expectedRevision: failed.run.revision,
      });
      const claim = database.pipelineRuntime.claimReadyAttempt({
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        workerId: "execution-worker",
        leaseDurationMs: 60_000,
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") assert.fail("Attempt was not claimed.");

      now = new Date("2026-07-24T01:01:01.000Z");
      assert.equal(database.pipelineRuntime.recoverExpiredLeases(), 1);
      assert.equal(
        await database.pipelineRuntime.reconcilePendingExecutions(),
        1,
      );
      const reattached = database.pipelineRuntime.inspectRun(retrying.run.id);
      const attempt = reattached.nodes
        .find((node) => node.id === projectSpec.id)
        ?.attempts.at(-1);
      assert.equal(reattachedProviderRef, "provider-execution:running");
      assert.equal(attempt?.id, claim.attemptId);
      assert.equal(attempt?.status, "succeeded");
      assert.deepEqual(attempt?.result, { reattached: true });
      assert.equal(
        reattached.nodes.find((node) => node.pipelineNodeId === "verify")
          ?.status,
        "ready",
      );
      const artifact = database.artifactRegistry.listVersions(project.id)[0];
      assert.ok(artifact);
      assert.deepEqual(artifact.producer, {
        runId: retrying.run.id,
        nodeRunId: projectSpec.id,
        nodeAttemptId: claim.attemptId,
        snapshotRevisionId: retrying.snapshot.id,
        aiMemberId: position.aiMember.id,
      });
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .facts.at(-1)?.effectIds,
        [artifact.id],
      );
      assert.deepEqual(
        database.pipelineRuntime
          .inspectExecution({ attemptId: claim.attemptId })
          .leases.map((lease) => [lease.leaseKind, lease.executionEpoch]),
        [
          ["execution", 1],
          ["reconciliation", 2],
          ["execution", 3],
        ],
      );
    } finally {
      database.close();
    }
  });

  it("recovers a committed terminal Fact without creating a duplicate Attempt", async () => {
    let adapterCalls = 0;
    const { companyDir, database, project, department } = setup(
      {
        execute: async (input, sink) => {
          adapterCalls += 1;
          assert.ok(input.request);
          assert.ok(sink);
          await sink.record({
            adapterSchemaVersion: 1,
            factId: "committed-terminal",
            ordinal: 1,
            kind: "completed",
            schemaVersion: 1,
            payload: { structuredResult: { recovered: true } },
            evidenceRefs: ["provider-receipt:committed"],
          });
          throw new Error("simulated crash after terminal commit");
        },
      },
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
    );
    const { started } = formalizeAndStart({
      database,
      projectId: project.id,
      departmentId: department.id,
    });
    await assert.rejects(
      () =>
        database.pipelineRuntime.executeReady({
          runId: started.run.id,
          expectedRevision: started.run.revision,
        }),
      /simulated crash after terminal commit/,
    );
    const committed = database.pipelineRuntime.inspectRun(started.run.id);
    assert.equal(
      committed.nodes.find((node) => node.pipelineNodeId === "project-spec")
        ?.status,
      "succeeded",
    );
    database.close();

    const reopened = openCompanyDatabase(companyDir, {
      executionAdapter: {
        execute: async () => {
          adapterCalls += 1;
          throw new Error("The recovered AI Task executed twice.");
        },
      },
    });
    try {
      const recovered = reopened.pipelineRuntime.inspectRun(started.run.id);
      const completed = await reopened.pipelineRuntime.executeReady({
        runId: recovered.run.id,
        expectedRevision: recovered.run.revision,
      });
      const projectSpec = completed.nodes.find(
        (node) => node.pipelineNodeId === "project-spec",
      );
      assert.equal(completed.run.status, "completed");
      assert.equal(adapterCalls, 1);
      assert.equal(projectSpec?.attemptCount, 1);
      assert.deepEqual(projectSpec?.result, { recovered: true });
      assert.equal(
        reopened.pipelineRuntime.inspectExecution({
          attemptId: projectSpec!.attempts[0]!.id,
        }).facts.length,
        1,
      );
    } finally {
      reopened.close();
    }
  });

  it("times out a scripted AI Task and releases its Execution Lease", async () => {
    const { database, project, department, profile } = setup(
      {
        execute: async () => new Promise<never>(() => undefined),
      },
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "project-spec",
            type: "ai-task",
            name: "Project Spec",
            positionId,
            handlerKindId: "project-spec@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "project-spec" },
          { from: "project-spec", to: "complete" },
        ],
      }),
    );
    try {
      database.catalog.saveExecutionProfile({
        departmentId: department.id,
        executionProfileId: profile.id,
        expectedRevision: profile.revision,
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        timeoutSeconds: 1,
        maxIterations: profile.limits.maxIterations,
        maxTokens: profile.limits.maxTokens,
        retryMaxAttempts: profile.retryPolicy.maxAttempts,
        permissionPolicy: profile.permissionPolicy,
        secretReferenceIds: profile.secretReferenceIds,
      });
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const attempt = failed.nodes
        .find((node) => node.pipelineNodeId === "project-spec")
        ?.attempts.at(-1);
      assert.ok(attempt);
      assert.equal(failed.run.status, "failed");
      assert.equal(attempt.failure?.code, "EXECUTION_TIMEOUT");
      assert.equal(attempt.recoverable, true);
      assert.equal(
        database.pipelineRuntime.inspectExecution({ attemptId: attempt.id })
          .leases[0]?.releasedAt !== null,
        true,
      );
    } finally {
      database.close();
    }
  });

  it("rejects stale execution without changing the persisted Run", async () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: 1,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(started.run.id).run.revision,
        0,
      );
    } finally {
      database.close();
    }
  });

  it("rejects missing configuration before writing a Run", () => {
    const { database, project } = setup();
    try {
      assert.throws(
        () =>
          database.pipelineRuntime.startRun({
            projectId: project.id,
            departmentId: "missing-department",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "DEPARTMENT_NOT_FOUND",
      );
      assert.deepEqual(
        database.pipelineRuntime.listRuns({ projectId: project.id }),
        [],
      );
    } finally {
      database.close();
    }
  });

  it("keeps the historical Snapshot unchanged after live configuration edits", () => {
    const { database, project, department, graph, profile } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      database.catalog.updateDepartment({
        departmentId: department.id,
        expectedRevision: 1,
        name: "Renamed Delivery",
        description: "Changed after the Run started.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: profile.id,
      });
      database.catalog.saveExecutionProfile({
        departmentId: department.id,
        executionProfileId: profile.id,
        expectedRevision: 0,
        name: "Changed profile",
        providerRef: "changed-provider",
        model: "changed-model",
        sandboxRef: "docker",
        branchStrategy: "branch",
        timeoutSeconds: 120,
        maxIterations: 2,
        maxTokens: 1_000,
        retryMaxAttempts: 1,
        permissionPolicy: "ask",
        secretReferenceIds: [],
      });
      const changedGraph = {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "implement" ? { ...node, name: "Changed" } : node,
        ),
      };
      const saved = database.pipelineConfiguration.saveDraft({
        departmentId: department.id,
        expectedRevision: 1,
        graph: changedGraph,
      });
      database.pipelineConfiguration.publish({
        departmentId: department.id,
        expectedRevision: saved.draft.revision,
      });

      const historical = database.pipelineRuntime.inspectRun(started.run.id);
      assert.equal(historical.snapshot.hash, started.snapshot.hash);
      assert.equal(
        historical.snapshot.canonicalJson,
        started.snapshot.canonicalJson,
      );
      assert.equal(historical.snapshot.payload.department.name, "Delivery");
      assert.equal(
        historical.snapshot.payload.executionProfiles[0]?.providerRef,
        "scripted",
      );
      assert.equal(
        historical.snapshot.payload.pipelineVersion.graph.nodes.find(
          (node) => node.id === "implement",
        )?.name,
        "Implement",
      );
    } finally {
      database.close();
    }
  });

  it("does not leave a partial Run when no active Pipeline Version exists", () => {
    const { database, project } = setup();
    try {
      const department = database.catalog.createDepartment({ name: "Draft" });
      assert.throws(
        () =>
          database.pipelineRuntime.startRun({
            projectId: project.id,
            departmentId: department.id,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PIPELINE_VERSION_NOT_ACTIVE",
      );
      assert.equal(
        database.pipelineRuntime.listRuns({ projectId: project.id }).length,
        0,
      );
    } finally {
      database.close();
    }
  });

  it("returns PROJECT_NOT_FOUND and PIPELINE_VERSION_NOT_FOUND before writing a Run", () => {
    const first = setup();
    try {
      assert.throws(
        () =>
          first.database.pipelineRuntime.startRun({
            projectId: "missing-project",
            departmentId: first.department.id,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PROJECT_NOT_FOUND",
      );
      assert.deepEqual(first.database.pipelineRuntime.listRuns(), []);
    } finally {
      first.database.close();
    }

    const second = setup();
    try {
      const fault = new DatabaseSync(second.database.path);
      try {
        fault
          .prepare(
            "UPDATE departments SET active_pipeline_version_id = 'missing-version' WHERE id = ?",
          )
          .run(second.department.id);
      } finally {
        fault.close();
      }
      assert.throws(
        () =>
          second.database.pipelineRuntime.startRun({
            projectId: second.project.id,
            departmentId: second.department.id,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PIPELINE_VERSION_NOT_FOUND",
      );
      assert.deepEqual(second.database.pipelineRuntime.listRuns(), []);
    } finally {
      second.database.close();
    }
  });

  it("returns RUN_SNAPSHOT_INVALID for an archived referenced configuration", () => {
    const { database, project, department, profile } = setup();
    try {
      const fault = new DatabaseSync(database.path);
      try {
        fault
          .prepare(
            "UPDATE execution_profiles SET status = 'archived' WHERE id = ?",
          )
          .run(profile.id);
      } finally {
        fault.close();
      }
      assert.throws(
        () =>
          database.pipelineRuntime.startRun({
            projectId: project.id,
            departmentId: department.id,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_SNAPSHOT_INVALID",
      );
      assert.deepEqual(database.pipelineRuntime.listRuns(), []);
    } finally {
      database.close();
    }
  });

  it("persists a Scripted Execution Adapter failure without running a real Agent", async () => {
    const adapter = createScriptedExecutionAdapter({
      script: {
        implement: [
          {
            kind: "failed",
            code: "SCRIPTED_FAILURE",
            message: "The scripted node failed.",
          },
        ],
      },
    });
    const { database, project, department } = setup(adapter);
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const failed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });

      assert.equal(failed.run.status, "failed");
      assert.deepEqual(
        failed.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.failure,
        {
          code: "SCRIPTED_FAILURE",
          message: "The scripted node failed.",
        },
      );
    } finally {
      database.close();
    }
  });

  it("returns stable errors for invalid Run and Node state transitions", async () => {
    const { database, project, department } = setup();
    try {
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: 0,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: completed.run.id,
            expectedRevision: completed.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_STATE_INVALID",
      );

      const draft = database.pipelineConfiguration.inspect(department.id).draft;
      const conditionGraph: DepartmentPipelineDraftGraph = {
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "condition",
            type: "condition",
            name: "Condition",
            condition: {
              leftReference: "nodes.start.result.ok",
              operator: "equals",
              value: true,
              branches: [{ id: "default", label: "Default", kind: "default" }],
            },
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "condition" },
          { from: "condition", to: "complete", branchId: "default" },
        ],
      };
      const saved = database.pipelineConfiguration.saveDraft({
        departmentId: department.id,
        expectedRevision: draft.revision,
        graph: conditionGraph,
      });
      database.pipelineConfiguration.publish({
        departmentId: department.id,
        expectedRevision: saved.draft.revision,
      });
      const invalid = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: department.id,
      });
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: invalid.run.id,
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "CONDITION_VALUE_MISSING",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(invalid.run.id).run.status,
        "failed",
      );
    } finally {
      database.close();
    }
  });

  it("executes a versioned deterministic no-Agent graph from the existing Snapshot r1", async () => {
    let agentCalls = 0;
    const adapter = {
      ...createScriptedExecutionAdapter(),
      maxConcurrentNodes: 4,
      execute: async () => {
        agentCalls += 1;
        throw new Error("The no-Agent graph invoked the Execution Adapter.");
      },
    };
    const { database, project, department, position } = setup(
      adapter,
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "route",
            type: "condition",
            name: "Route",
            handlerKindId: "gate-route@1",
            condition: {
              leftReference: "snapshot.project.revision",
              operator: "equals",
              value: 0,
              branches: [
                { id: "selected", label: "Selected", kind: "match" },
                { id: "fallback", label: "Fallback", kind: "default" },
              ],
            },
          },
          {
            id: "parallel",
            type: "parallel",
            name: "Parallel",
            handlerKindId: "work-package-fan-out@1",
          },
          {
            id: "branch-a",
            type: "join",
            name: "Branch A",
            handlerKindId: "package-join@1",
          },
          {
            id: "branch-b",
            type: "join",
            name: "Branch B",
            handlerKindId: "package-join@1",
          },
          {
            id: "not-selected",
            type: "join",
            name: "Not selected",
            handlerKindId: "package-join@1",
          },
          {
            id: "join",
            type: "join",
            name: "Join",
            handlerKindId: "package-join@1",
          },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
            handlerKindId: "human-approval@1",
            approvalTitle: "Approve deterministic completion",
            approvalPolicy: "named",
            approverReference: "pipeline-test-human",
            approvalExpiresAfterSeconds: 300,
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "route" },
          { from: "route", to: "parallel", branchId: "selected" },
          { from: "route", to: "not-selected", branchId: "fallback" },
          { from: "parallel", to: "branch-a" },
          { from: "parallel", to: "branch-b" },
          { from: "branch-a", to: "join" },
          { from: "branch-b", to: "join" },
          { from: "not-selected", to: "join" },
          { from: "join", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );

    try {
      const { actor, beforeStart, started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      assert.equal(beforeStart.snapshot.revision, 1);
      assert.equal(beforeStart.nodes.length, 0);
      assert.equal(started.snapshot.hash, beforeStart.snapshot.hash);
      assert.equal(
        started.snapshot.canonicalJson,
        beforeStart.snapshot.canonicalJson,
      );
      assert.equal(
        started.snapshot.payload.pipelineVersion.handlerRegistry?.version,
        1,
      );
      assert.equal(
        started.snapshot.payload.pipelineVersion.handlers?.length,
        9,
      );

      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      assert.equal(waiting.run.status, "waiting-approval");
      assert.equal(agentCalls, 0);
      assert.deepEqual(
        waiting.nodes.find((node) => node.pipelineNodeId === "not-selected")
          ?.result,
        {
          reason: "condition-not-selected",
          conditionNodeId: "route",
          selectedBranchId: "selected",
        },
      );
      assert.equal(
        waiting.nodes.find((node) => node.pipelineNodeId === "join")?.status,
        "succeeded",
      );
      assert.deepEqual(
        waiting.nodes.find((node) => node.pipelineNodeId === "approval")
          ?.handler,
        waiting.snapshot.payload.pipelineVersion.handlers?.find(
          (handler) => handler.nodeId === "approval",
        ),
      );

      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);
      const approved = database.pipelineRuntime.decideApproval({
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "approve",
        actor,
        commandId: "approve:no-agent-graph",
      });
      const completed = await database.pipelineRuntime.executeReady({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });
      assert.equal(completed.run.status, "completed");
      assert.equal(completed.snapshot.hash, beforeStart.snapshot.hash);
      assert.equal(agentCalls, 0);
    } finally {
      database.close();
    }
  });

  it("accepts one eligible Human Approval decision and replays it without another mutation", async () => {
    const { database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
            handlerKindId: "human-approval@1",
            approvalTitle: "Approve completion",
            approvalPolicy: "named",
            approverReference: "eligible-human",
            approvalExpiresAfterSeconds: 300,
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
    );

    try {
      const { started } = formalizeAndStart({
        database,
        projectId: project.id,
        departmentId: department.id,
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);
      assert.equal(approval.approvals[0]?.status, "pending");
      assert.equal(
        approval.approvals[0]?.requestedAction,
        "Approve completion",
      );
      assert.match(
        approval.approvals[0]?.inputManifestHash ?? "",
        /^[a-f0-9]{64}$/,
      );
      assert.ok(approval.approvals[0]?.expiresAt);

      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            runId: waiting.run.id,
            nodeRunId: approval.id,
            expectedRevision: waiting.run.revision,
            decision: "approve",
            actor: {
              type: "human",
              id: "ineligible-human",
              authenticatedBy: "local-session",
            },
            commandId: "approval-decision-ineligible",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "APPROVAL_ACTOR_INELIGIBLE",
      );

      const decision = {
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "approve" as const,
        actor: {
          type: "human" as const,
          id: "eligible-human",
          authenticatedBy: "local-session" as const,
        },
        commandId: "approval-decision-1",
      };
      const approved = database.pipelineRuntime.decideApproval(decision);
      const replayed = database.pipelineRuntime.decideApproval(decision);
      assert.deepEqual(replayed, approved);
      assert.equal(
        database.pipelineRuntime
          .runtimeEvents({ afterSequence: 0, limit: 1_000 })
          .filter(
            (event) =>
              event.runId === waiting.run.id &&
              event.type === "approval.decided",
          ).length,
        1,
      );
      assert.throws(
        () =>
          database.pipelineRuntime.decideApproval({
            ...decision,
            expectedRevision: approved.run.revision,
            decision: "reject",
            commandId: "approval-decision-2",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "APPROVAL_DECISION_EXISTS",
      );
    } finally {
      database.close();
    }
  });

  it("expires Human Approval durably on restart and requires an explicit new request", async () => {
    let currentTime = new Date("2026-07-24T00:00:00.000Z");
    const clock = () => currentTime;
    const { companyDir, database, project, department } = setup(
      createScriptedExecutionAdapter(),
      (positionId) => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId,
            handlerKindId: "human-approval@1",
            approvalTitle: "Approve completion",
            approvalPolicy: "named",
            approverReference: "eligible-human",
            approvalExpiresAfterSeconds: 60,
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      }),
      clock,
    );

    const { started } = formalizeAndStart({
      database,
      projectId: project.id,
      departmentId: department.id,
    });
    const waiting = await database.pipelineRuntime.executeReady({
      runId: started.run.id,
      expectedRevision: started.run.revision,
    });
    const approval = waiting.nodes.find(
      (node) => node.pipelineNodeId === "approval",
    );
    assert.ok(approval);
    database.close();

    currentTime = new Date("2026-07-24T00:01:01.000Z");
    const reopened = openCompanyDatabase(companyDir, { clock });
    try {
      const expired = reopened.pipelineRuntime.inspectRun(waiting.run.id);
      assert.equal(expired.run.status, "blocked");
      assert.equal(
        expired.nodes.find((node) => node.id === approval.id)?.failure?.code,
        "APPROVAL_EXPIRED",
      );
      assert.equal(
        expired.nodes.find((node) => node.id === approval.id)?.approvals[0]
          ?.status,
        "expired",
      );
      assert.throws(
        () =>
          reopened.pipelineRuntime.decideApproval({
            runId: expired.run.id,
            nodeRunId: approval.id,
            expectedRevision: expired.run.revision,
            decision: "approve",
            actor: {
              type: "human",
              id: "eligible-human",
              authenticatedBy: "local-session",
            },
            commandId: "late-approval",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "APPROVAL_EXPIRED",
      );

      const retried = reopened.pipelineRuntime.retryApproval({
        runId: expired.run.id,
        nodeRunId: approval.id,
        expectedRevision: expired.run.revision,
        actor: {
          type: "human",
          id: "eligible-human",
          authenticatedBy: "local-session",
        },
      });
      assert.equal(retried.run.status, "waiting-approval");
      assert.deepEqual(
        retried.nodes
          .find((node) => node.id === approval.id)
          ?.approvals.map((request) => request.status),
        ["expired", "pending"],
      );
    } finally {
      reopened.close();
    }
  });

  it("blocks a historical Node when its exact Handler version is unavailable", async () => {
    const { companyDir, database, project, department } = setup(
      createScriptedExecutionAdapter(),
      () => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [{ from: "start", to: "complete" }],
      }),
    );
    const { started } = formalizeAndStart({
      database,
      projectId: project.id,
      departmentId: department.id,
    });
    database.close();

    const reopened = openCompanyDatabase(companyDir, {
      pipelineRuntime: {
        handlerRegistry: createNodeHandlerRegistry(["run-complete@1"]),
      },
    });
    try {
      await assert.rejects(
        () =>
          reopened.pipelineRuntime.executeReady({
            runId: started.run.id,
            expectedRevision: started.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "HANDLER_VERSION_UNAVAILABLE",
      );
      const blocked = reopened.pipelineRuntime.inspectRun(started.run.id);
      assert.equal(blocked.run.status, "blocked");
      assert.equal(
        blocked.nodes.find((node) => node.pipelineNodeId === "start")?.failure
          ?.code,
        "HANDLER_VERSION_UNAVAILABLE",
      );
    } finally {
      reopened.close();
    }
  });

  it("recovers an interrupted formal Run scheduling transaction without duplicate Node Runs", () => {
    const { companyDir, database, project, department, graph } = setup(
      createScriptedExecutionAdapter(),
      () => ({
        nodes: [
          {
            id: "start",
            type: "start",
            name: "Start",
            handlerKindId: "run-start@1",
          },
          {
            id: "parallel",
            type: "parallel",
            name: "Parallel",
            handlerKindId: "work-package-fan-out@1",
          },
          {
            id: "join",
            type: "join",
            name: "Join",
            handlerKindId: "package-join@1",
          },
          {
            id: "complete",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          { from: "start", to: "parallel" },
          { from: "parallel", to: "join" },
          { from: "join", to: "complete" },
        ],
      }),
    );
    assert.throws(
      () =>
        formalizeAndStart({
          database,
          projectId: project.id,
          departmentId: department.id,
          schedulingCheckpoint: () => {
            throw new Error("scheduler-interrupted-before-commit");
          },
        }),
      /scheduler-interrupted-before-commit/,
    );
    database.close();

    const reopened = openCompanyDatabase(companyDir);
    try {
      const started = reopened.pipelineRuntime.startFormalizedRun({
        projectId: project.id,
        departmentId: department.id,
      });
      assert.equal(started.nodes.length, graph.nodes.length);
      assert.equal(
        new Set(started.nodes.map((node) => node.pipelineNodeId)).size,
        graph.nodes.length,
      );
      assert.equal(
        reopened.pipelineRuntime.startFormalizedRun({
          projectId: project.id,
          departmentId: department.id,
        }).nodes.length,
        graph.nodes.length,
      );
    } finally {
      reopened.close();
    }
  });
});
