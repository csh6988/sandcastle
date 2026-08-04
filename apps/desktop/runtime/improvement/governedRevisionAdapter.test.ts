import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import {
  deterministicGovernedRevisionId,
  GovernedRevisionAdapterError,
  openSqliteGovernedRevisionAdapter,
} from "./governedRevisionAdapter.js";

const target = {
  targetKind: "harness" as const,
  ownerId: "harness:review",
  governedHead: { revisionId: null, revisionHash: null },
  content: {
    principles: ["Use exact evidence."],
    constitution: "Review immutable contracts.",
    rules: ["Bind every recommendation to frozen evidence."],
    examples: { positive: [], negative: [] },
    impactScope: ["project-1"],
  },
};

const createApplyIntent = (
  company: ReturnType<typeof openCompanyDatabase>,
  operationId: string,
) => {
  const project = company.catalog.createProject({
    name: "Harness Adapter",
    goal: "Exercise the governed revision Adapter seam",
  });
  const actor = {
    type: "human" as const,
    id: "human:adapter-test",
    authenticatedBy: "local-session" as const,
  };
  const frozen = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-freeze",
    actor,
    command: {
      type: "statistics.evidence.freeze",
      evidenceSnapshotId: "statistics-evidence:adapter",
      query: {
        projectId: project.id,
        window: {
          kind: "explicit-utc-half-open",
          startInclusive: "2026-08-01T00:00:00.000Z",
          endExclusive: "2026-08-02T00:00:00.000Z",
        },
        cohort: { id: "cohort:adapter" },
        comparisonSet: {
          id: "comparison:adapter",
          metricIds: ["review-finding-count"],
        },
      },
    },
  });
  assert.equal(frozen.status, "succeeded");
  if (frozen.status !== "succeeded") assert.fail("freeze must succeed");
  const proposal = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-proposal",
    actor,
    command: {
      type: "improvement.proposal.create",
      proposal: {
        proposalId: "improvement-proposal:adapter",
        revisionId: "improvement-proposal-revision:adapter:1",
        projectId: project.id,
        departmentId: null,
        content: {
          evidence: frozen.value,
          target: {
            ...target,
            content: { ...target.content, impactScope: [project.id] },
          },
          rootCauseHypothesis: "Review guidance can drift.",
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
          rolloutNotes: "Validate the next cohort.",
          rollbackSource: {
            revisionId: "harness:adapter:source",
            revisionHash: "a".repeat(64),
          },
        },
      },
    },
  });
  assert.equal(proposal.status, "succeeded");
  if (proposal.status !== "succeeded") assert.fail("proposal must succeed");
  const revision = proposal.value.revisions[0];
  if (!revision) assert.fail("proposal revision must exist");
  const proposed = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-propose",
    actor,
    command: {
      type: "improvement.proposal.propose",
      proposalId: proposal.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
    },
  });
  assert.equal(proposed.status, "succeeded");
  const confirmation = "I confirm this exact governed Harness revision.";
  const requested = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-request-decision",
    actor,
    command: {
      type: "improvement.proposal.request-decision",
      proposalId: proposal.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
      confirmation,
    },
  });
  assert.equal(requested.status, "succeeded");
  const approved = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-approve",
    actor,
    command: {
      type: "improvement.proposal.decide",
      proposalId: proposal.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
      decision: "approved",
      confirmation,
      reason: "The exact revision is bounded.",
      evidenceRefs: [frozen.value.id],
    },
  });
  assert.equal(approved.status, "succeeded");
  if (approved.status !== "succeeded") assert.fail("approval must succeed");
  const decision = approved.value.revisions[0]?.decision;
  if (!decision) assert.fail("approved decision must exist");
  const intent = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "command:adapter-apply-intent",
    actor,
    command: {
      type: "improvement.application.apply",
      application: {
        operationId,
        proposalId: proposal.value.id,
        proposalRevisionId: revision.id,
        expectedProposalRevisionHash: revision.hash,
        approvedDecisionId: decision.id,
        expectedApprovedDecisionHash: decision.hash,
        target: revision.content.target,
        confirmation: "I confirm applying this exact Harness revision.",
        reason: "Exercise the Adapter after durable intent.",
        evidenceRefs: [frozen.value.id, decision.id],
      },
    },
  });
  assert.equal(intent.status, "succeeded");
  return revision.content.target;
};

describe("Governed revision Adapter", () => {
  it("appends one deterministic Harness revision, replays it as no-op, and protects the exact head", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-governed-revision-adapter-"),
    );
    const company = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const operationId = "improvement-application:harness:adapter";
    const governedTarget = createApplyIntent(company, operationId);
    const sqlite = new DatabaseSync(company.path);
    const adapter = openSqliteGovernedRevisionAdapter(sqlite, {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const absent = await adapter.inspectEffect({
      operationId,
      target: governedTarget,
      phase: "apply",
    });
    assert.equal(absent.outcome, "proven-absent");

    const applied = await adapter.appendRevision({
      operationId,
      target: governedTarget,
      phase: "apply",
      expectedGovernedHead: governedTarget.governedHead,
    });
    assert.equal(applied.disposition, "applied");
    assert.equal(
      applied.revision.revisionId,
      deterministicGovernedRevisionId({
        operationId,
        targetKind: "harness",
        phase: "apply",
      }),
    );

    const replay = await adapter.appendRevision({
      operationId,
      target: governedTarget,
      phase: "apply",
      expectedGovernedHead: governedTarget.governedHead,
    });
    assert.equal(replay.disposition, "no-op");
    assert.deepEqual(replay.revision, applied.revision);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      1,
    );

    await assert.rejects(
      adapter.appendRevision({
        operationId: "improvement-application:harness:stale-head",
        target: governedTarget,
        phase: "apply",
        expectedGovernedHead: governedTarget.governedHead,
      }),
      (error: unknown) =>
        error instanceof GovernedRevisionAdapterError &&
        error.code === "IMPROVEMENT_TARGET_CONFLICT",
    );
    sqlite.close();
    company.close();
  });
});
