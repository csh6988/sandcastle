import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const sourceHarnessContent = JSON.stringify({
  principles: ["Preserve governed history."],
  constitution: "Restore only exact governed revisions.",
  rules: ["Require an exact rollback source."],
  examples: { positive: [], negative: [] },
  impactScope: ["project:improvements"],
});
const sourceRevision = {
  revisionId: "harness:review:source",
  revisionHash: createHash("sha256").update(sourceHarnessContent).digest("hex"),
};

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-improvement-proposal-runtime-"));

const seedProject = (path: string): void => {
  const database = new DatabaseSync(path);
  database.exec(`
    INSERT INTO projects(id, company_id, name, goal, status, created_at)
    VALUES (
      'project:improvements', 'company', 'Improvements',
      'Govern evidence-backed improvements', 'active', '${timestamp}'
    );
  `);
  database.close();
};

const seedGovernedHarnessSource = (
  path: string,
  input: {
    readonly revisionId?: string;
    readonly ownerId?: string;
  } = {},
): void => {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON;");
  database
    .prepare(
      `INSERT INTO governed_harness_revisions(
         id, owner_id, revision, supersedes_revision_id, content_json,
         content_hash, operation_id, phase, created_at
       ) VALUES (?, ?, 1, NULL, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      input.revisionId ?? sourceRevision.revisionId,
      input.ownerId ?? "harness:review",
      sourceHarnessContent,
      sourceRevision.revisionHash,
      timestamp,
    );
  database.close();
};

const freezeEvidence = (
  database: ReturnType<typeof openCompanyDatabase>,
  input: {
    readonly commandId: string;
    readonly evidenceSnapshotId: string;
    readonly metricId:
      | "review-finding-count"
      | "security-operability-high-risk-closure-rate";
    readonly includeUnsupported?: boolean;
  },
): StatisticsEvidenceSnapshotView => {
  const result = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: input.commandId,
    actor: {
      type: "runtime-worker",
      id: "runtime-worker:improvements",
      authenticatedBy: "runtime",
    },
    command: {
      type: "statistics.evidence.freeze",
      evidenceSnapshotId: input.evidenceSnapshotId,
      query: {
        projectId: "project:improvements",
        window: {
          kind: "explicit-utc-half-open",
          startInclusive: "2026-08-01T00:00:00.000Z",
          endExclusive: "2026-08-02T00:00:00.000Z",
        },
        cohort: { id: "cohort:proposal-before" },
        comparisonSet: {
          id: `comparison:${input.metricId}`,
          metricIds: input.includeUnsupported
            ? [input.metricId, "security-operability-high-risk-closure-rate"]
            : [input.metricId],
        },
      },
    },
  });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") assert.fail("freeze must succeed");
  return result.value;
};

const proposalContent = (
  evidence: StatisticsEvidenceSnapshotView,
  rootCauseHypothesis = "The governed review Harness does not require exact frozen evidence.",
): ImprovementProposalRevisionContent => {
  const metricId = evidence.query.comparisonSet.metricIds[0];
  if (!metricId) assert.fail("proposal evidence must contain one metric");
  return {
    evidence,
    target: {
      targetKind: "harness",
      ownerId: "harness:review",
      governedHead: { revisionId: null, revisionHash: null },
      content: {
        principles: ["Prefer exact frozen evidence over inference."],
        constitution: "Review against immutable production contracts.",
        rules: ["Bind every recommendation to frozen Statistics evidence."],
        examples: {
          positive: ["Cite one exact evidence snapshot and comparison set."],
          negative: ["Use a moving dashboard query as approval evidence."],
        },
        impactScope: ["project:improvements"],
      },
    },
    rootCauseHypothesis,
    impactScope: {
      projectIds: ["project:improvements"],
      departmentIds: [],
      positionIds: [],
    },
    expectedMetrics: [{ metricId, direction: "decrease" }],
    validationPolicy: {
      metricIds: [metricId],
      minimumComparableObservations: 1,
    },
    rolloutNotes: "Validate against the next comparable Project cohort.",
    rollbackSource: sourceRevision,
  };
};

describe("Improvement Proposal Runtime", () => {
  it("creates, revises, proposes, replays, and restarts one immutable evidence-backed proposal without target effects", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedProject(database.path);
    seedGovernedHarnessSource(database.path);
    const evidence = freezeEvidence(database, {
      commandId: "command:freeze-proposal-evidence",
      evidenceSnapshotId: "statistics-evidence:proposal-before",
      metricId: "review-finding-count",
      includeUnsupported: true,
    });
    assert.equal(evidence.completeness.status, "unavailable");
    const createEnvelope = {
      schemaVersion: 1 as const,
      commandId: "command:create-improvement-proposal",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.proposal.create" as const,
        proposal: {
          proposalId: "improvement-proposal:1",
          revisionId: "improvement-proposal-revision:1",
          projectId: "project:improvements",
          departmentId: null,
          content: proposalContent(evidence),
        },
      },
    };

    const created = database.commandRegistry.execute(createEnvelope);
    const replay = database.commandRegistry.execute(createEnvelope);
    assert.equal(created.status, "succeeded");
    assert.deepEqual(replay, created);
    if (created.status !== "succeeded") assert.fail("create must succeed");
    assert.equal(created.value.currentState, "draft");
    assert.deepEqual(created.value.nextActions, ["revise", "propose"]);
    assert.equal(created.value.revisions.length, 1);
    assert.equal(
      created.value.revisions[0]?.content.evidence.hash,
      evidence.hash,
    );
    assert.deepEqual(
      database.improvementProposals.inspect("improvement-proposal:1"),
      created.value,
    );
    assert.deepEqual(
      database.improvementProposals.list("project:improvements"),
      [created.value],
    );

    const changedInputReplay = database.commandRegistry.execute({
      ...createEnvelope,
      command: {
        ...createEnvelope.command,
        proposal: {
          ...createEnvelope.command.proposal,
          content: proposalContent(
            evidence,
            "Changed request under one command ID.",
          ),
        },
      },
    });
    assert.equal(changedInputReplay.status, "rejected");
    if (changedInputReplay.status !== "rejected") {
      assert.fail("changed input replay must be rejected");
    }
    assert.equal(changedInputReplay.error.code, "COMMAND_ID_REUSE");

    const firstRevision = created.value.revisions[0];
    if (!firstRevision) assert.fail("first revision must exist");
    const revised = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:revise-improvement-proposal",
      actor: createEnvelope.actor,
      command: {
        type: "improvement.proposal.revise",
        proposal: {
          proposalId: created.value.id,
          revisionId: "improvement-proposal-revision:2",
          supersedesRevisionId: firstRevision.id,
          expectedSupersededRevisionHash: firstRevision.hash,
          content: proposalContent(
            evidence,
            "Review guidance does not require a stable evidence identity.",
          ),
        },
      },
    });
    assert.equal(revised.status, "succeeded");
    if (revised.status !== "succeeded") assert.fail("revise must succeed");
    assert.equal(
      revised.value.currentRevisionId,
      "improvement-proposal-revision:2",
    );
    assert.equal(revised.value.currentState, "draft");
    assert.equal(revised.value.revisions.length, 2);
    assert.deepEqual(revised.value.revisions[0], firstRevision);

    const secondRevision = revised.value.revisions[1];
    if (!secondRevision) assert.fail("second revision must exist");
    const proposed = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:propose-improvement-proposal",
      actor: createEnvelope.actor,
      command: {
        type: "improvement.proposal.propose",
        proposalId: revised.value.id,
        proposalRevisionId: secondRevision.id,
        expectedProposalRevisionHash: secondRevision.hash,
      },
    });
    assert.equal(proposed.status, "succeeded");
    if (proposed.status !== "succeeded") assert.fail("propose must succeed");
    assert.equal(proposed.value.currentState, "proposed");
    assert.deepEqual(proposed.value.nextActions, [
      "revise",
      "request-decision",
    ]);

    const decisionConfirmation =
      "I confirm this exact proposal revision, evidence, target head, and Harness content.";
    const requestDecisionEnvelope = {
      schemaVersion: 1,
      commandId: "command:request-improvement-proposal-decision",
      actor: createEnvelope.actor,
      command: {
        type: "improvement.proposal.request-decision",
        proposalId: proposed.value.id,
        proposalRevisionId: secondRevision.id,
        expectedProposalRevisionHash: secondRevision.hash,
        confirmation: decisionConfirmation,
      },
    } as const;
    const awaitingHuman = database.commandRegistry.execute(
      requestDecisionEnvelope,
    );
    const awaitingHumanReplay = database.commandRegistry.execute(
      requestDecisionEnvelope,
    );
    assert.equal(awaitingHuman.status, "succeeded");
    assert.deepEqual(awaitingHumanReplay, awaitingHuman);
    if (awaitingHuman.status !== "succeeded") {
      assert.fail("request decision must succeed");
    }
    assert.equal(awaitingHuman.value.currentState, "awaiting-human");
    assert.deepEqual(awaitingHuman.value.revisions[1]?.lifecycle.at(-1), {
      state: "awaiting-human",
      confirmation: decisionConfirmation,
      createdAt: timestamp,
    });

    const changedRequestDecision = database.commandRegistry.execute({
      ...requestDecisionEnvelope,
      command: {
        ...requestDecisionEnvelope.command,
        confirmation: "A changed confirmation under the same Command ID.",
      },
    });
    assert.equal(changedRequestDecision.status, "rejected");
    if (changedRequestDecision.status !== "rejected") {
      assert.fail("changed request-decision input must be rejected");
    }
    assert.equal(changedRequestDecision.error.code, "COMMAND_ID_REUSE");

    const unauthorizedDecision = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:runtime-worker-cannot-decide-improvement-proposal",
      actor: createEnvelope.actor,
      command: {
        type: "improvement.proposal.decide",
        proposalId: awaitingHuman.value.id,
        proposalRevisionId: secondRevision.id,
        expectedProposalRevisionHash: secondRevision.hash,
        decision: "approved",
        confirmation: decisionConfirmation,
        reason: "A Runtime worker cannot grant human authority.",
        evidenceRefs: [evidence.id],
      },
    });
    assert.equal(unauthorizedDecision.status, "rejected");
    if (unauthorizedDecision.status !== "rejected") {
      assert.fail("Runtime worker decision must be rejected");
    }
    assert.equal(unauthorizedDecision.error.code, "FORBIDDEN");

    const mismatchedConfirmation = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:mismatched-improvement-confirmation",
      actor: {
        type: "human",
        id: "human:improvement-reviewer",
        authenticatedBy: "local-session",
      },
      command: {
        type: "improvement.proposal.decide",
        proposalId: awaitingHuman.value.id,
        proposalRevisionId: secondRevision.id,
        expectedProposalRevisionHash: secondRevision.hash,
        decision: "approved",
        confirmation: "I confirm a different proposal boundary.",
        reason: "This confirmation must not drift.",
        evidenceRefs: [evidence.id],
      },
    });
    assert.equal(mismatchedConfirmation.status, "rejected");
    if (mismatchedConfirmation.status !== "rejected") {
      assert.fail("mismatched confirmation must be rejected");
    }
    assert.equal(mismatchedConfirmation.error.code, "CONFLICT");

    const decideEnvelope = {
      schemaVersion: 1 as const,
      commandId: "command:approve-improvement-proposal",
      actor: {
        type: "human" as const,
        id: "human:improvement-reviewer",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.proposal.decide" as const,
        proposalId: awaitingHuman.value.id,
        proposalRevisionId: secondRevision.id,
        expectedProposalRevisionHash: secondRevision.hash,
        decision: "approved" as const,
        confirmation: decisionConfirmation,
        reason: "The frozen evidence and proposed Harness revision are exact.",
        evidenceRefs: [evidence.id],
      },
    };
    const approved = database.commandRegistry.execute(decideEnvelope);
    const approvedReplay = database.commandRegistry.execute(decideEnvelope);
    assert.equal(approved.status, "succeeded");
    assert.deepEqual(approvedReplay, approved);
    if (approved.status !== "succeeded") assert.fail("approve must succeed");
    assert.equal(approved.value.currentState, "approved");
    assert.deepEqual(approved.value.nextActions, ["revise", "apply"]);
    assert.equal(
      approved.value.revisions[1]?.decision?.proposalRevisionHash,
      secondRevision.hash,
    );
    assert.equal(
      approved.value.revisions[1]?.decision?.evidenceSnapshotHash,
      evidence.hash,
    );
    assert.deepEqual(
      approved.value.revisions[1]?.decision?.target,
      secondRevision.content.target,
    );
    assert.equal(
      approved.value.revisions[1]?.decision?.confirmation,
      decisionConfirmation,
    );

    const secondDecision = database.commandRegistry.execute({
      ...decideEnvelope,
      commandId: "command:reject-already-decided-improvement-proposal",
      command: { ...decideEnvelope.command, decision: "rejected" as const },
    });
    assert.equal(secondDecision.status, "rejected");
    if (secondDecision.status !== "rejected") {
      assert.fail("a second decision must be rejected");
    }
    assert.equal(secondDecision.error.code, "IMPROVEMENT_DECISION_EXISTS");

    const sqlite = new DatabaseSync(database.path);
    for (const table of [
      "governed_harness_revisions",
      "runtime_template_revisions",
      "governed_skill_flow_revisions",
      "improvement_application_operations",
    ]) {
      assert.equal(
        (
          sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            readonly count: number;
          }
        ).count,
        table === "governed_harness_revisions" ? 1 : 0,
        table,
      );
    }
    sqlite.close();
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(
      database.improvementProposals.inspect("improvement-proposal:1"),
      approved.value,
    );
    database.close();
  });

  it("rejects stale, unavailable, superseded, and unauthorized proposal authoring", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedProject(database.path);
    seedGovernedHarnessSource(database.path);
    const availableEvidence = freezeEvidence(database, {
      commandId: "command:freeze-available-evidence",
      evidenceSnapshotId: "statistics-evidence:available",
      metricId: "review-finding-count",
    });
    const unavailableEvidence = freezeEvidence(database, {
      commandId: "command:freeze-unavailable-evidence",
      evidenceSnapshotId: "statistics-evidence:unavailable",
      metricId: "security-operability-high-risk-closure-rate",
    });
    const create = (input: {
      readonly commandId: string;
      readonly proposalId: string;
      readonly revisionId: string;
      readonly evidence: StatisticsEvidenceSnapshotView;
      readonly actor: {
        readonly type: "runtime-worker" | "electron-main" | "test-driver";
        readonly id: string;
        readonly authenticatedBy: "runtime" | "ipc-token";
      };
    }) =>
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: input.commandId,
        actor: input.actor,
        command: {
          type: "improvement.proposal.create",
          proposal: {
            proposalId: input.proposalId,
            revisionId: input.revisionId,
            projectId: "project:improvements",
            departmentId: null,
            content: proposalContent(input.evidence),
          },
        },
      });

    const unavailable = create({
      commandId: "command:create-unavailable-proposal",
      proposalId: "improvement-proposal:unavailable",
      revisionId: "improvement-proposal-revision:unavailable",
      evidence: unavailableEvidence,
      actor: {
        type: "runtime-worker",
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime",
      },
    });
    assert.equal(unavailable.status, "rejected");
    if (unavailable.status !== "rejected")
      assert.fail("must reject unavailable");
    assert.equal(unavailable.error.code, "STATISTICS_EVIDENCE_UNAVAILABLE");

    const staleEvidence = {
      ...availableEvidence,
      asOfSequence: availableEvidence.asOfSequence + 1,
    };
    const stale = create({
      commandId: "command:create-stale-proposal",
      proposalId: "improvement-proposal:stale",
      revisionId: "improvement-proposal-revision:stale",
      evidence: staleEvidence,
      actor: {
        type: "runtime-worker",
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime",
      },
    });
    assert.equal(stale.status, "rejected");
    if (stale.status !== "rejected") assert.fail("must reject stale evidence");
    assert.equal(stale.error.code, "STATISTICS_EVIDENCE_STALE");

    for (const actor of [
      {
        type: "electron-main" as const,
        id: "electron-main",
        authenticatedBy: "ipc-token" as const,
      },
      {
        type: "test-driver" as const,
        id: "test-driver",
        authenticatedBy: "runtime" as const,
      },
    ]) {
      const unauthorized = create({
        commandId: `command:create-unauthorized:${actor.type}`,
        proposalId: `improvement-proposal:unauthorized:${actor.type}`,
        revisionId: `improvement-proposal-revision:unauthorized:${actor.type}`,
        evidence: availableEvidence,
        actor,
      });
      assert.equal(unauthorized.status, "rejected");
      if (unauthorized.status !== "rejected") {
        assert.fail("unauthorized author must be rejected");
      }
      assert.equal(unauthorized.error.code, "FORBIDDEN");
    }

    const created = create({
      commandId: "command:create-current-proposal",
      proposalId: "improvement-proposal:current",
      revisionId: "improvement-proposal-revision:current:1",
      evidence: availableEvidence,
      actor: {
        type: "runtime-worker",
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime",
      },
    });
    assert.equal(created.status, "succeeded");
    if (created.status !== "succeeded") assert.fail("create must succeed");
    const revision = created.value.revisions[0];
    if (!revision) assert.fail("revision must exist");
    const superseded = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:revise-stale-proposal",
      actor: {
        type: "runtime-worker",
        id: "runtime-worker:improvements",
        authenticatedBy: "runtime",
      },
      command: {
        type: "improvement.proposal.revise",
        proposal: {
          proposalId: created.value.id,
          revisionId: "improvement-proposal-revision:current:2",
          supersedesRevisionId: revision.id,
          expectedSupersededRevisionHash: "b".repeat(64),
          content: proposalContent(availableEvidence, "A revised hypothesis."),
        },
      },
    });
    assert.equal(superseded.status, "rejected");
    if (superseded.status !== "rejected")
      assert.fail("must reject stale revision");
    assert.equal(superseded.error.code, "IMPROVEMENT_PROPOSAL_SUPERSEDED");
    database.close();
  });

  it("rejects rollback sources that are missing or do not match the target owner and hash", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedProject(database.path);
    seedGovernedHarnessSource(database.path);
    seedGovernedHarnessSource(database.path, {
      revisionId: "harness:other:source",
      ownerId: "harness:other",
    });
    const evidence = freezeEvidence(database, {
      commandId: "command:freeze-rollback-source-evidence",
      evidenceSnapshotId: "statistics-evidence:rollback-source",
      metricId: "review-finding-count",
    });

    for (const [caseId, rollbackSource] of [
      [
        "missing",
        {
          revisionId: "harness:review:missing",
          revisionHash: sourceRevision.revisionHash,
        },
      ],
      [
        "wrong-owner",
        {
          revisionId: "harness:other:source",
          revisionHash: sourceRevision.revisionHash,
        },
      ],
      [
        "wrong-hash",
        { revisionId: sourceRevision.revisionId, revisionHash: "b".repeat(64) },
      ],
    ] as const) {
      const result = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `command:create-proposal:${caseId}`,
        actor: {
          type: "runtime-worker",
          id: "runtime-worker:improvements",
          authenticatedBy: "runtime",
        },
        command: {
          type: "improvement.proposal.create",
          proposal: {
            proposalId: `improvement-proposal:${caseId}`,
            revisionId: `improvement-proposal-revision:${caseId}`,
            projectId: "project:improvements",
            departmentId: null,
            content: {
              ...proposalContent(evidence),
              rollbackSource,
            },
          },
        },
      });
      assert.equal(result.status, "rejected", caseId);
      if (result.status !== "rejected") assert.fail(`${caseId} must reject`);
      assert.equal(result.error.code, "IMPROVEMENT_TARGET_CONFLICT", caseId);
    }
    assert.deepEqual(
      database.improvementProposals.list("project:improvements"),
      [],
    );
    database.close();
  });
});
