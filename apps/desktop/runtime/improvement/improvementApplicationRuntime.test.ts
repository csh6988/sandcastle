import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import type {
  ImprovementProposalRevisionContent,
  StatisticsEvidenceSnapshotView,
} from "../interface.js";

const timestamp = "2026-08-04T00:00:00.000Z";
const hash = "a".repeat(64);

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-improvement-application-runtime-"));

const createApprovedHarnessProposal = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix = "1",
): {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly decisionId: string;
  readonly decisionHash: string;
  readonly content: ImprovementProposalRevisionContent;
} => {
  const project = database.catalog.createProject({
    name: "Harness improvement",
    goal: "Apply one governed Harness revision",
  });
  const actor = {
    type: "human" as const,
    id: "human:improvement-owner",
    authenticatedBy: "local-session" as const,
  };
  const frozen = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:freeze-harness-application-evidence:${suffix}`,
    actor,
    command: {
      type: "statistics.evidence.freeze",
      evidenceSnapshotId: `statistics-evidence:harness-application:${suffix}`,
      query: {
        projectId: project.id,
        window: {
          kind: "explicit-utc-half-open",
          startInclusive: "2026-08-01T00:00:00.000Z",
          endExclusive: "2026-08-02T00:00:00.000Z",
        },
        cohort: { id: `cohort:harness-application:${suffix}` },
        comparisonSet: {
          id: `comparison:harness-application:${suffix}`,
          metricIds: ["review-finding-count"],
        },
      },
    },
  });
  assert.equal(frozen.status, "succeeded");
  if (frozen.status !== "succeeded") assert.fail("freeze must succeed");
  const evidence: StatisticsEvidenceSnapshotView = frozen.value;
  const content: ImprovementProposalRevisionContent = {
    evidence,
    target: {
      targetKind: "harness",
      ownerId: "harness:software-rnd-review",
      governedHead: { revisionId: null, revisionHash: null },
      content: {
        principles: ["Use exact frozen evidence."],
        constitution: "Review immutable production contracts.",
        rules: ["Bind every recommendation to exact evidence."],
        examples: {
          positive: ["Cite the frozen evidence identity."],
          negative: ["Use a moving dashboard result."],
        },
        impactScope: [project.id],
      },
    },
    rootCauseHypothesis: "Review guidance permits moving evidence.",
    impactScope: {
      projectIds: [project.id],
      departmentIds: [],
      positionIds: [],
    },
    expectedMetrics: [
      { metricId: "review-finding-count", direction: "decrease" },
    ],
    validationPolicy: {
      metricIds: ["review-finding-count"],
      minimumComparableObservations: 1,
    },
    rolloutNotes: "Validate against the next comparable cohort.",
    rollbackSource: {
      revisionId: "harness:software-rnd-review:source",
      revisionHash: hash,
    },
  };
  const created = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:create-harness-application-proposal:${suffix}`,
    actor,
    command: {
      type: "improvement.proposal.create",
      proposal: {
        proposalId: `improvement-proposal:harness-application:${suffix}`,
        revisionId: `improvement-proposal-revision:harness-application:${suffix}:1`,
        projectId: project.id,
        departmentId: null,
        content,
      },
    },
  });
  assert.equal(created.status, "succeeded");
  if (created.status !== "succeeded") assert.fail("create must succeed");
  const revision = created.value.revisions[0];
  if (!revision) assert.fail("proposal revision must exist");
  const proposed = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:propose-harness-application:${suffix}`,
    actor,
    command: {
      type: "improvement.proposal.propose",
      proposalId: created.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
    },
  });
  assert.equal(proposed.status, "succeeded");
  if (proposed.status !== "succeeded") assert.fail("propose must succeed");
  const confirmation =
    "I confirm this exact proposal revision, evidence, target head, and Harness content.";
  const requested = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:request-harness-application-decision:${suffix}`,
    actor,
    command: {
      type: "improvement.proposal.request-decision",
      proposalId: proposed.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
      confirmation,
    },
  });
  assert.equal(requested.status, "succeeded");
  if (requested.status !== "succeeded") {
    assert.fail("request decision must succeed");
  }
  const approved = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:approve-harness-application:${suffix}`,
    actor,
    command: {
      type: "improvement.proposal.decide",
      proposalId: requested.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
      decision: "approved",
      confirmation,
      reason: "The Harness revision is exact and bounded.",
      evidenceRefs: [evidence.id],
    },
  });
  assert.equal(approved.status, "succeeded");
  if (approved.status !== "succeeded") assert.fail("approve must succeed");
  const decision = approved.value.revisions[0]?.decision;
  if (!decision) assert.fail("approved decision must exist");
  return {
    proposalId: approved.value.id,
    revisionId: revision.id,
    revisionHash: revision.hash,
    decisionId: decision.id,
    decisionHash: decision.hash,
    content,
  };
};

const harnessApplyEnvelope = (
  approved: ReturnType<typeof createApprovedHarnessProposal>,
  input: {
    readonly operationId: string;
    readonly commandId: string;
    readonly actor?: {
      readonly type: "human" | "runtime-worker";
      readonly id: string;
      readonly authenticatedBy: "local-session" | "runtime";
    };
  },
) => ({
  schemaVersion: 1 as const,
  commandId: input.commandId,
  actor: input.actor ?? {
    type: "human" as const,
    id: "human:improvement-owner",
    authenticatedBy: "local-session" as const,
  },
  command: {
    type: "improvement.application.apply" as const,
    application: {
      operationId: input.operationId,
      proposalId: approved.proposalId,
      proposalRevisionId: approved.revisionId,
      expectedProposalRevisionHash: approved.revisionHash,
      approvedDecisionId: approved.decisionId,
      expectedApprovedDecisionHash: approved.decisionHash,
      target: approved.content.target,
      confirmation: "I confirm applying this exact approved Harness revision.",
      reason: "Apply the bounded reviewed Harness improvement.",
      evidenceRefs: [approved.content.evidence.id, approved.decisionId],
    },
  },
});

describe("Improvement Application Runtime", () => {
  it("commits Harness apply intent before one deterministic append-only effect and replays without duplication", async () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    const approved = createApprovedHarnessProposal(database);
    const applyEnvelope = harnessApplyEnvelope(approved, {
      operationId: "improvement-application:harness:1",
      commandId: "command:apply-harness-improvement",
    });

    const intent = database.commandRegistry.execute(applyEnvelope);
    const intentReplay = database.commandRegistry.execute(applyEnvelope);
    assert.equal(intent.status, "succeeded");
    assert.deepEqual(intentReplay, intent);
    if (intent.status !== "succeeded") assert.fail("apply intent must succeed");
    assert.equal(intent.value.state, "applying");
    assert.match(intent.value.deterministicEffectId, /^improvement-effect:/);

    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    sqlite.close();

    const applied = await database.improvementApplications.dispatch(
      intent.value.id,
    );
    assert.equal(applied.state, "applied");
    assert.equal(applied.receipts.length, 1);
    assert.equal(applied.receipts[0]?.disposition, "applied");
    assert.match(
      applied.receipts[0]?.targetRevision?.revisionHash ?? "",
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(applied.nextActions, ["validate", "rollback"]);

    const operationReplay = database.commandRegistry.execute({
      ...applyEnvelope,
      commandId: "command:apply-harness-improvement-replay",
    });
    assert.equal(operationReplay.status, "succeeded");
    if (operationReplay.status !== "succeeded") {
      assert.fail("operation replay must succeed");
    }
    assert.deepEqual(operationReplay.value, applied);
    await database.improvementApplications.dispatch(intent.value.id);

    const after = new DatabaseSync(database.path);
    assert.equal(
      (
        after
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      1,
    );
    const governedRevision = after
      .prepare(
        `SELECT id, content_hash AS contentHash
           FROM governed_harness_revisions`,
      )
      .get() as { readonly id: string; readonly contentHash: string };
    assert.equal(
      governedRevision.id,
      applied.receipts[0]?.targetRevision?.revisionId,
    );
    assert.equal(
      governedRevision.contentHash,
      applied.receipts[0]?.targetRevision?.revisionHash,
    );
    for (const table of [
      "department_runs",
      "run_snapshot_revisions",
      "runtime_template_revisions",
      "governed_skill_flow_revisions",
    ]) {
      const beforeCount = (
        after.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
      assert.equal(beforeCount, 0, table);
    }
    after.close();

    const changedInput = database.commandRegistry.execute({
      ...applyEnvelope,
      commandId: "command:apply-harness-improvement-conflict",
      command: {
        ...applyEnvelope.command,
        application: {
          ...applyEnvelope.command.application,
          reason: "Changed input under the same operation ID.",
        },
      },
    });
    assert.equal(changedInput.status, "rejected");
    if (changedInput.status !== "rejected") {
      assert.fail("changed operation input must be rejected");
    }
    assert.equal(
      changedInput.error.code,
      "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
    );
    database.close();
  });

  it("reconciles an exact Harness effect after restart without blindly appending a second revision", async () => {
    const companyDir = tempCompanyDir();
    let injectCrash = true;
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
      improvementApplicationRuntime: {
        failureInjection: (point) => {
          if (point === "after-effect-before-finalize" && injectCrash) {
            injectCrash = false;
            throw new Error("simulated crash after Harness append");
          }
        },
      },
    });
    const approved = createApprovedHarnessProposal(database, "restart");
    const envelope = harnessApplyEnvelope(approved, {
      operationId: "improvement-application:harness:restart",
      commandId: "command:apply-harness-improvement-restart",
    });
    const intent = database.commandRegistry.execute(envelope);
    assert.equal(intent.status, "succeeded");
    if (intent.status !== "succeeded") assert.fail("apply intent must succeed");
    await assert.rejects(
      () => database.improvementApplications.dispatch(intent.value.id),
      /simulated crash after Harness append/,
    );
    assert.equal(
      database.improvementApplications.inspect(intent.value.id).state,
      "applying",
    );
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    const reconciled = await database.improvementApplications.dispatch(
      intent.value.id,
    );
    assert.equal(reconciled.state, "applied");
    assert.equal(reconciled.receipts.length, 1);
    assert.equal(reconciled.receipts[0]?.disposition, "no-op");
    assert.equal(reconciled.observations.at(-1)?.outcome, "exact-match");
    assert.equal(reconciled.reconciliations.at(-1)?.result, "finalized");
    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      1,
    );
    sqlite.close();
    database.close();
  });

  it("fails closed for unauthorized apply and insufficient target evidence without invoking append", async () => {
    const companyDir = tempCompanyDir();
    let appendCalls = 0;
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
      improvementApplicationRuntime: {
        adapter: {
          inspectEffect: async () => ({
            outcome: "insufficient-evidence",
            evidenceRefs: ["target-inspection:insufficient"],
          }),
          appendRevision: async () => {
            appendCalls += 1;
            throw new Error("append must not be called");
          },
        },
      },
    });
    const approved = createApprovedHarnessProposal(database, "unknown");
    const unauthorized = database.commandRegistry.execute(
      harnessApplyEnvelope(approved, {
        operationId: "improvement-application:harness:unauthorized",
        commandId: "command:apply-harness-improvement-unauthorized",
        actor: {
          type: "runtime-worker",
          id: "runtime-worker:improvements",
          authenticatedBy: "runtime",
        },
      }),
    );
    assert.equal(unauthorized.status, "rejected");
    if (unauthorized.status !== "rejected") {
      assert.fail("Runtime worker apply must be rejected");
    }
    assert.equal(unauthorized.error.code, "FORBIDDEN");

    const intent = database.commandRegistry.execute(
      harnessApplyEnvelope(approved, {
        operationId: "improvement-application:harness:unknown",
        commandId: "command:apply-harness-improvement-unknown",
      }),
    );
    assert.equal(intent.status, "succeeded");
    if (intent.status !== "succeeded") assert.fail("apply intent must succeed");
    const unknown = await database.improvementApplications.dispatch(
      intent.value.id,
    );
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.latestError?.code, "IMPROVEMENT_APPLICATION_UNKNOWN");
    assert.deepEqual(unknown.nextActions, ["reconcile"]);
    assert.equal(appendCalls, 0);
    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    sqlite.close();
    database.close();
  });

  it("rejects superseded authority and records exact governed-head conflicts without a second Harness revision", async () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    const first = createApprovedHarnessProposal(database, "head-1");
    const firstIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(first, {
        operationId: "improvement-application:harness:head-1",
        commandId: "command:apply-harness-head-1",
      }),
    );
    assert.equal(firstIntent.status, "succeeded");
    if (firstIntent.status !== "succeeded") {
      assert.fail("first apply intent must succeed");
    }
    assert.equal(
      (await database.improvementApplications.dispatch(firstIntent.value.id))
        .state,
      "applied",
    );

    const staleHead = createApprovedHarnessProposal(database, "head-2");
    const staleIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(staleHead, {
        operationId: "improvement-application:harness:head-2",
        commandId: "command:apply-harness-head-2",
      }),
    );
    assert.equal(staleIntent.status, "succeeded");
    if (staleIntent.status !== "succeeded") {
      assert.fail("stale-head intent must still persist before effect");
    }
    const failed = await database.improvementApplications.dispatch(
      staleIntent.value.id,
    );
    assert.equal(failed.state, "apply-failed");
    assert.equal(failed.latestError?.code, "IMPROVEMENT_TARGET_CONFLICT");

    const superseded = createApprovedHarnessProposal(database, "superseded");
    const revised = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:revise-approved-harness-proposal",
      actor: {
        type: "human",
        id: "human:improvement-owner",
        authenticatedBy: "local-session",
      },
      command: {
        type: "improvement.proposal.revise",
        proposal: {
          proposalId: superseded.proposalId,
          revisionId:
            "improvement-proposal-revision:harness-application:superseded:2",
          supersedesRevisionId: superseded.revisionId,
          expectedSupersededRevisionHash: superseded.revisionHash,
          content: {
            ...superseded.content,
            rootCauseHypothesis:
              "A newer exact proposal revision supersedes the approved one.",
          },
        },
      },
    });
    assert.equal(revised.status, "succeeded");
    const rejected = database.commandRegistry.execute(
      harnessApplyEnvelope(superseded, {
        operationId: "improvement-application:harness:superseded",
        commandId: "command:apply-superseded-harness-proposal",
      }),
    );
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") {
      assert.fail("superseded proposal apply must be rejected");
    }
    assert.equal(rejected.error.code, "IMPROVEMENT_PROPOSAL_SUPERSEDED");

    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      1,
    );
    sqlite.close();
    database.close();
  });
});
