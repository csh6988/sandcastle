import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-product-runtime-"));

const humanActor = {
  type: "human" as const,
  id: "local-user",
  authenticatedBy: "local-session" as const,
};

const prepareAwaitingProposal = (
  database: ReturnType<typeof openCompanyDatabase>,
  content: {
    readonly goal: string;
    readonly users: string[];
    readonly scope: string[];
    readonly nonGoals: string[];
    readonly acceptanceCriteria: string[];
    readonly constraints: string[];
    readonly risks: string[];
    readonly openQuestions: string[];
  } = {
    goal: "Ship a safer checkout",
    users: ["Store customers"],
    scope: ["Checkout confirmation"],
    nonGoals: ["Payment provider migration"],
    acceptanceCriteria: ["A duplicate submission creates one order"],
    constraints: ["Remain local-first"],
    risks: ["Retry races"],
    openQuestions: [],
  },
) => {
  const project = database.catalog.createProject({
    name: "Checkout",
    goal: content.goal,
  });
  const session = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: "product-planner-member",
    role: "product-manager",
  });
  const revised = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `${project.id}-revise`,
    actor: humanActor,
    consumerId: "desktop-window-1",
    expectedRevision: 0,
    command: {
      type: "product.proposal.revise",
      projectId: project.id,
      producerSessionId: session.id,
      content,
    },
  });
  assert.equal(revised.status, "succeeded");
  if (revised.status !== "succeeded") throw new Error("unreachable");
  const awaiting = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `${project.id}-awaiting`,
    actor: humanActor,
    consumerId: "desktop-window-1",
    expectedRevision: revised.value.proposal!.revision,
    command: {
      type: "product.proposal.mark-awaiting-confirmation",
      projectId: project.id,
      proposalRevisionId: revised.value.proposal!.currentRevision.id,
      proposalHash: revised.value.proposal!.currentRevision.hash,
    },
  });
  assert.equal(awaiting.status, "succeeded");
  if (awaiting.status !== "succeeded") throw new Error("unreachable");
  return { project, session, awaiting };
};

describe("Product Runtime", () => {
  it("requires a new confirmed Proposal revision and exact child Fork for a Baseline boundary change", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const prepared = prepareAwaitingProposal(database);
      const root = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "baseline-boundary-root",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: prepared.awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: prepared.project.id,
          departmentId: "software-rnd",
          proposalRevisionId:
            prepared.awaiting.value.proposal!.currentRevision.id,
          proposalHash: prepared.awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(root.status, "succeeded");
      if (root.status !== "succeeded") return;
      const originalBaseline = root.value.baselines[0]!;

      const revised = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "baseline-boundary-revise",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: root.value.proposal!.revision,
        command: {
          type: "product.proposal.revise",
          projectId: prepared.project.id,
          producerSessionId: prepared.session.id,
          content: {
            ...root.value.proposal!.currentRevision.content,
            scope: ["Checkout confirmation", "Order receipt"],
          },
        },
      });
      assert.equal(revised.status, "succeeded");
      if (revised.status !== "succeeded") return;
      const awaiting = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "baseline-boundary-awaiting",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: revised.value.proposal!.revision,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: prepared.project.id,
          proposalRevisionId: revised.value.proposal!.currentRevision.id,
          proposalHash: revised.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(awaiting.status, "succeeded");
      if (awaiting.status !== "succeeded") return;

      const missingFork = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "baseline-boundary-missing-fork",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: prepared.project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(missingFork.status, "rejected");
      if (missingFork.status === "rejected") {
        assert.equal(missingFork.error.code, "BASELINE_FORK_REQUIRED");
      }

      const child = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "baseline-boundary-child",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: prepared.project.id,
          departmentId: "software-rnd",
          forkSourceRunId: originalBaseline.runId,
          forkSourceSnapshotRevisionId: originalBaseline.snapshotRevisionId,
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(child.status, "succeeded");
      if (child.status !== "succeeded") return;
      assert.equal(child.value.baselines.length, 2);
      assert.equal(child.value.baselines[0]?.id, originalBaseline.id);
      assert.equal(child.value.baselines[0]?.hash, originalBaseline.hash);
      const childRun = child.value.formalRuns.at(-1)!;
      assert.equal(childRun.parentRunId, originalBaseline.runId);
      assert.equal(
        childRun.forkedFromSnapshotRevisionId,
        originalBaseline.snapshotRevisionId,
      );
      assert.notEqual(childRun.productBaselineId, originalBaseline.id);
    } finally {
      database.close();
    }
  });

  it("quarantines an orphan formal Run on startup without fabricating Snapshot r1", () => {
    const companyDir = tempCompanyDir();
    const initial = openCompanyDatabase(companyDir);
    const { project, awaiting } = prepareAwaitingProposal(initial);
    const confirmed = initial.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "orphan-confirm-1",
      actor: humanActor,
      consumerId: "desktop-window-1",
      expectedRevision: awaiting.value.proposal!.revision,
      command: {
        type: "confirm-product-baseline",
        projectId: project.id,
        departmentId: "software-rnd",
        proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
        proposalHash: awaiting.value.proposal!.currentRevision.hash,
      },
    });
    assert.equal(confirmed.status, "succeeded");
    if (confirmed.status !== "succeeded") {
      initial.close();
      return;
    }
    const baseline = confirmed.value.baselines[0]!;
    const databasePath = initial.path;
    initial.close();

    const corrupt = new DatabaseSync(databasePath);
    corrupt.exec("PRAGMA foreign_keys = OFF");
    corrupt
      .prepare("DELETE FROM run_snapshot_revisions WHERE id = ?")
      .run(baseline.snapshotRevisionId);
    corrupt.close();

    const reopened = openCompanyDatabase(companyDir);
    try {
      assert.throws(
        () => reopened.pipelineRuntime.inspectRun(baseline.runId),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_SNAPSHOT_INVALID",
      );
      assert.equal(
        reopened.product.inspect(project.id).baselines[0]?.snapshotRevisionId,
        baseline.snapshotRevisionId,
      );
      const evidence = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const quarantine = evidence
          .prepare(
            `SELECT reason FROM runtime_run_quarantines
              WHERE run_id = ? AND snapshot_revision_id = ?`,
          )
          .get(baseline.runId, baseline.snapshotRevisionId) as
          | { readonly reason: string }
          | undefined;
        assert.equal(quarantine?.reason, "active-snapshot-missing");
        const snapshot = evidence
          .prepare("SELECT id FROM run_snapshot_revisions WHERE id = ?")
          .get(baseline.snapshotRevisionId);
        assert.equal(snapshot, undefined);
      } finally {
        evidence.close();
      }
    } finally {
      reopened.close();
    }
  });

  it("starts only an already formalized Run and never creates a missing Snapshot", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Formal start",
        goal: "Schedule only after confirmation",
      });
      assert.throws(
        () =>
          database.pipelineRuntime.startFormalizedRun({
            projectId: project.id,
            departmentId: "software-rnd",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RUN_NOT_FORMALIZED",
      );
      assert.deepEqual(
        database.pipelineRuntime.listRuns({ projectId: project.id }),
        [],
      );

      const prepared = prepareAwaitingProposal(database);
      const confirmed = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "formal-start-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: prepared.awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: prepared.project.id,
          departmentId: "software-rnd",
          proposalRevisionId:
            prepared.awaiting.value.proposal!.currentRevision.id,
          proposalHash: prepared.awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(confirmed.status, "succeeded");
      if (confirmed.status !== "succeeded") return;
      const baseline = confirmed.value.baselines[0]!;
      const before = database.pipelineRuntime.inspectRun(baseline.runId);
      assert.deepEqual(before.nodes, []);

      const started = database.pipelineRuntime.startFormalizedRun({
        projectId: prepared.project.id,
        departmentId: "software-rnd",
      });
      assert.equal(started.run.id, before.run.id);
      assert.equal(started.snapshot.id, before.snapshot.id);
      assert.equal(
        started.nodes.length,
        before.snapshot.payload.pipelineVersion.graph.nodes.length,
      );
    } finally {
      database.close();
    }
  });

  it("forks a child Department Run by replaying an exact Snapshot with the same Product Baseline", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const { project, awaiting } = prepareAwaitingProposal(database);
      const confirmed = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "fork-source-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(confirmed.status, "succeeded");
      if (confirmed.status !== "succeeded") return;
      const baseline = confirmed.value.baselines[0]!;
      const source = database.pipelineRuntime.inspectRun(baseline.runId);

      const forked = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "replay-fork-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: source.run.revision,
        command: {
          type: "fork-department-run",
          sourceRunId: source.run.id,
          sourceSnapshotRevisionId: source.snapshot.id,
          reason: "Replay the confirmed execution contract",
        },
      });

      assert.equal(forked.status, "succeeded");
      if (forked.status !== "succeeded") return;
      const child = forked.value.formalRuns.find(
        (run) => run.parentRunId === source.run.id,
      );
      assert.ok(child);
      assert.equal(child.productBaselineId, baseline.id);
      assert.equal(child.forkedFromSnapshotRevisionId, source.snapshot.id);
      const childRun = database.pipelineRuntime.inspectRun(child.runId);
      assert.equal(childRun.run.status, "ready");
      assert.equal(childRun.run.productBaselineId, baseline.id);
      assert.equal(childRun.snapshot.revision, 1);
      assert.equal(
        childRun.snapshot.canonicalJson,
        source.snapshot.canonicalJson,
      );
      assert.equal(childRun.snapshot.hash, source.snapshot.hash);
      assert.deepEqual(childRun.nodes, []);
      assert.deepEqual(
        database.pipelineRuntime.inspectRun(source.run.id),
        source,
      );
    } finally {
      database.close();
    }
  });

  it("rolls back every confirmation write checkpoint without partial formal state", () => {
    const checkpoints = [
      "before-baseline",
      "before-run",
      "before-snapshot",
      "before-audit",
      "before-outbox",
      "before-receipt",
      "before-commit",
    ] as const;

    for (const checkpoint of checkpoints) {
      let armed = true;
      const database = openCompanyDatabase(tempCompanyDir(), {
        productRuntime: {
          confirmationFailure: (current) => {
            if (armed && current === checkpoint) {
              throw new Error(`injected ${checkpoint}`);
            }
          },
        },
      });
      try {
        const { project, awaiting } = prepareAwaitingProposal(database);
        const eventSequence = database.eventSequence();
        const auditCount = database.pipelineRuntime.auditRecords({
          limit: 1_000,
        }).length;
        const envelope = {
          schemaVersion: 1 as const,
          commandId: `failure-${checkpoint}`,
          actor: humanActor,
          consumerId: "desktop-window-1",
          expectedRevision: awaiting.value.proposal!.revision,
          command: {
            type: "confirm-product-baseline" as const,
            projectId: project.id,
            departmentId: "software-rnd",
            proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
            proposalHash: awaiting.value.proposal!.currentRevision.hash,
          },
        };

        assert.throws(
          () => database.commandRegistry.execute(envelope),
          new RegExp(`injected ${checkpoint}`),
        );
        assert.equal(database.eventSequence(), eventSequence, checkpoint);
        assert.equal(
          database.pipelineRuntime.auditRecords({ limit: 1_000 }).length,
          auditCount,
          checkpoint,
        );
        const state = database.product.inspect(project.id);
        assert.equal(
          state.proposal?.status,
          "awaiting-confirmation",
          checkpoint,
        );
        assert.deepEqual(state.baselines, [], checkpoint);
        assert.deepEqual(
          database.pipelineRuntime.listRuns({ projectId: project.id }),
          [],
          checkpoint,
        );

        armed = false;
        const retried = database.commandRegistry.execute(envelope);
        assert.equal(retried.status, "succeeded", checkpoint);
      } finally {
        database.close();
      }
    }
  });

  it("rolls back formalization when Department or Pipeline resolution fails", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const { project, awaiting } = prepareAwaitingProposal(database);
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "missing-pipeline-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline" as const,
          projectId: project.id,
          departmentId: "missing-department",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      };
      const rejected = database.commandRegistry.execute(envelope);
      assert.equal(rejected.status, "rejected");
      if (rejected.status !== "rejected") return;
      assert.equal(rejected.error.code, "DEPARTMENT_NOT_FOUND");
      assert.deepEqual(database.commandRegistry.execute(envelope), rejected);
      const state = database.product.inspect(project.id);
      assert.equal(state.proposal?.status, "awaiting-confirmation");
      assert.deepEqual(state.baselines, []);
      assert.deepEqual(
        database.pipelineRuntime.listRuns({ projectId: project.id }),
        [],
      );
    } finally {
      database.close();
    }
  });

  it("rejects Product Baseline confirmation from an unverified or producer actor", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const { project, awaiting } = prepareAwaitingProposal(database);
      const rejected = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "producer-self-confirm-1",
        actor: {
          type: "runtime-worker",
          id: "product-planner-member",
          authenticatedBy: "runtime",
        },
        consumerId: "runtime-worker-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(rejected.status, "rejected");
      if (rejected.status !== "rejected") return;
      assert.equal(rejected.error.code, "BASELINE_ACTOR_INVALID");
      assert.deepEqual(database.product.inspect(project.id).baselines, []);
      assert.deepEqual(
        database.pipelineRuntime.listRuns({ projectId: project.id }),
        [],
      );
    } finally {
      database.close();
    }
  });

  it("persists BASELINE_INCOMPLETE without creating formal state and leaves the Proposal editable", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const { project, session, awaiting } = prepareAwaitingProposal(database, {
        goal: "Ship a safer checkout",
        users: ["Store customers"],
        scope: ["Checkout confirmation"],
        nonGoals: [],
        acceptanceCriteria: ["A duplicate submission creates one order"],
        constraints: ["Remain local-first"],
        risks: ["Retry races"],
        openQuestions: ["Which retry window is accepted?"],
      });
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "incomplete-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline" as const,
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      };

      const rejected = database.commandRegistry.execute(envelope);
      assert.deepEqual(rejected, {
        status: "rejected",
        error: {
          code: "BASELINE_INCOMPLETE",
          message:
            "Product Proposal is incomplete and cannot form a Product Baseline.",
        },
        effectIds: [],
      });
      assert.deepEqual(database.commandRegistry.execute(envelope), rejected);
      assert.deepEqual(database.product.inspect(project.id).baselines, []);
      assert.deepEqual(
        database.pipelineRuntime.listRuns({ projectId: project.id }),
        [],
      );

      const revised = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "incomplete-revise-2",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "product.proposal.revise",
          projectId: project.id,
          producerSessionId: session.id,
          content: {
            ...awaiting.value.proposal!.currentRevision.content,
            openQuestions: [],
          },
        },
      });
      assert.equal(revised.status, "succeeded");
      if (revised.status !== "succeeded") return;
      assert.equal(revised.value.proposal?.status, "clarifying");
    } finally {
      database.close();
    }
  });

  it("confirms an exact complete Product Proposal into an immutable Baseline and formal Run/r1", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship a safer checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "product-manager",
      });
      const revised = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-confirm-revise-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: 0,
        command: {
          type: "product.proposal.revise",
          projectId: project.id,
          producerSessionId: session.id,
          content: {
            goal: "Ship a safer checkout",
            users: ["Store customers"],
            scope: ["Checkout confirmation"],
            nonGoals: ["Payment provider migration"],
            acceptanceCriteria: ["A duplicate submission creates one order"],
            constraints: ["Remain local-first"],
            risks: ["Retry races"],
            openQuestions: [],
          },
        },
      });
      assert.equal(revised.status, "succeeded");
      if (revised.status !== "succeeded") return;
      const awaiting = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-confirm-awaiting-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: revised.value.proposal!.revision,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: project.id,
          proposalRevisionId: revised.value.proposal!.currentRevision.id,
          proposalHash: revised.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(awaiting.status, "succeeded");
      if (awaiting.status !== "succeeded") return;

      const confirmed = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });

      assert.equal(confirmed.status, "succeeded");
      if (confirmed.status !== "succeeded") return;
      assert.equal(confirmed.value.proposal?.status, "confirmed");
      assert.equal(confirmed.value.baselines.length, 1);
      const baseline = confirmed.value.baselines[0]!;
      assert.deepEqual(
        baseline.content,
        awaiting.value.proposal!.currentRevision.content,
      );
      assert.deepEqual(baseline.confirmedBy, humanActor);
      assert.equal(baseline.confirmationCommandId, "proposal-confirm-1");
      assert.equal(
        baseline.sourceProposalRevisionId,
        awaiting.value.proposal!.currentRevision.id,
      );
      assert.equal(
        baseline.sourceProposalHash,
        awaiting.value.proposal!.currentRevision.hash,
      );

      const run = database.pipelineRuntime.inspectRun(baseline.runId);
      assert.equal(run.run.status, "ready");
      assert.equal(run.run.productBaselineId, baseline.id);
      assert.equal(run.snapshot.id, baseline.snapshotRevisionId);
      assert.equal(run.snapshot.revision, 1);
      assert.equal(run.snapshot.payload.productBaseline!.id, baseline.id);
      assert.equal(run.snapshot.payload.productBaseline!.hash, baseline.hash);
      assert.deepEqual(run.nodes, []);

      assert.deepEqual(
        database.events
          .readAfter(0, 100)
          .filter((event) => event.projectId === project.id)
          .map((event) => event.type),
        [
          "project.created",
          "product.proposal.revised",
          "product.proposal.awaiting-confirmation",
          "product.baseline.confirmed",
          "department-run.formalized",
        ],
      );

      const replay = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-confirm-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.deepEqual(replay, confirmed);

      const duplicate = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-confirm-2",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: awaiting.value.proposal!.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: project.id,
          departmentId: "software-rnd",
          proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
          proposalHash: awaiting.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(duplicate.status, "succeeded");
      if (duplicate.status !== "succeeded") return;
      assert.deepEqual(duplicate.value.baselines, confirmed.value.baselines);
      assert.equal(
        database.pipelineRuntime.listRuns({ projectId: project.id }).length,
        1,
      );
    } finally {
      database.close();
    }
  });

  it("revises an exact Product Proposal and marks it awaiting confirmation through authoritative Runtime state", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship a safer checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      database.interaction.addParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "product-manager",
      });

      const revised = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-revise-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: 0,
        command: {
          type: "product.proposal.revise",
          projectId: project.id,
          producerSessionId: session.id,
          content: {
            goal: "Ship a safer checkout",
            users: ["Store customers"],
            scope: ["Checkout confirmation"],
            nonGoals: ["Payment provider migration"],
            acceptanceCriteria: ["A duplicate submission creates one order"],
            constraints: ["Remain local-first"],
            risks: ["Retry races"],
            openQuestions: [],
          },
        },
      });
      assert.equal(revised.status, "succeeded");
      if (revised.status !== "succeeded") return;
      assert.equal(revised.value.proposal?.status, "clarifying");
      assert.equal(revised.value.proposal?.revision, 1);
      assert.equal(
        revised.value.proposal?.currentRevision.producer.aiMemberId,
        "product-planner-member",
      );
      assert.equal(
        revised.value.proposal?.currentRevision.producer.sessionId,
        session.id,
      );

      const awaiting = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "proposal-awaiting-1",
        actor: humanActor,
        consumerId: "desktop-window-1",
        expectedRevision: 1,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: project.id,
          proposalRevisionId: revised.value.proposal!.currentRevision.id,
          proposalHash: revised.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(awaiting.status, "succeeded");
      if (awaiting.status !== "succeeded") return;
      assert.equal(awaiting.value.proposal?.status, "awaiting-confirmation");
      assert.equal(awaiting.value.proposal?.revision, 2);

      assert.deepEqual(database.product.inspect(project.id), awaiting.value);
      assert.deepEqual(
        database.events
          .readAfter(0, 100)
          .filter((event) => event.projectId === project.id)
          .map((event) => event.type),
        [
          "project.created",
          "product.proposal.revised",
          "product.proposal.awaiting-confirmation",
        ],
      );
    } finally {
      database.close();
    }
  });
});
