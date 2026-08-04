import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";

const hash = "a".repeat(64);
const timestamp = "2026-08-04T00:00:00.000Z";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-statistics-runtime-"));

const baselineQuery = {
  projectId: "project:statistics",
  filters: {
    departmentIds: ["software-rnd", "software-rnd"],
    repositoryIds: [],
  },
  window: {
    kind: "explicit-utc-half-open" as const,
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-02T00:00:00.000Z",
  },
  cohort: {
    id: "cohort:baseline",
    filters: { departmentIds: ["software-rnd", "software-rnd"] },
  },
  comparisonSet: {
    id: "comparison:baseline-quality",
    metricIds: [
      "review-recheck-pass-rate" as const,
      "readiness-blocker-count" as const,
      "product-baseline-confirmation-latency" as const,
      "review-finding-count" as const,
      "review-discussion-round-count" as const,
      "product-baseline-confirmation-count" as const,
    ],
  },
};

const seedBaselineFacts = (path: string): void => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO projects(id, company_id, name, goal, status, created_at)
    VALUES (
      'project:statistics', 'company', 'Statistics', 'Measure governed facts',
      'active', '${timestamp}'
    );
    INSERT INTO department_runs(
      id, project_id, department_id, status, created_at, revision,
      snapshot_revision_id, pipeline_version_id
    ) VALUES (
      'run:statistics', 'project:statistics', 'software-rnd', 'completed',
      '2026-08-01T00:00:00.000Z', 1, 'snapshot:statistics',
      'software-rnd-pipeline-v1'
    );
    INSERT INTO product_proposals(
      id, project_id, status, revision, current_revision_id, created_at, updated_at
    ) VALUES (
      'product-proposal:statistics', 'project:statistics', 'confirmed', 1,
      'product-proposal-revision:statistics',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:10:00.000Z'
    );
    INSERT INTO product_proposal_revisions(
      id, proposal_id, revision, content_json, content_hash,
      producer_ai_member_id, producer_position_id, producer_session_id,
      edited_by_type, edited_by_id, edited_by_authenticated_by, created_at
    ) VALUES (
      'product-proposal-revision:statistics', 'product-proposal:statistics', 1,
      '{}', '${hash}', 'product-planner-member', 'product-planner',
      'session:statistics', 'runtime-worker', 'runtime-worker:statistics',
      'runtime', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO product_baselines(
      id, project_id, source_proposal_revision_id, source_proposal_hash,
      content_json, canonical_hash, confirmed_by_type, confirmed_by_id,
      confirmed_by_authenticated_by, confirmation_command_id, run_id,
      snapshot_revision_id, confirmed_at
    ) VALUES (
      'product-baseline:statistics', 'project:statistics',
      'product-proposal-revision:statistics', '${hash}', '{}', '${hash}',
      'human', 'human:statistics', 'local-session', 'command:baseline',
      'run:statistics', 'snapshot:statistics', '2026-08-01T00:10:00.000Z'
    );
    INSERT INTO review_topics(
      id, project_id, run_id, title, kind, status, revision, manifest_json,
      manifest_hash, producer_ai_member_id, producer_position_id,
      producer_session_id, quorum, budget_json, rounds_used,
      duration_seconds_used, tokens_used, cost_cents_used, stop_condition,
      escalation_policy, created_at, updated_at
    ) VALUES (
      'review-topic:statistics', 'project:statistics', 'run:statistics',
      'Statistics review', 'product', 'PASS', 1, '{}', '${hash}',
      'product-planner-member', 'product-planner', 'session:statistics', 1,
      '{}', 2, 0, 0, 0, 'blocking-findings-dispositioned',
      'fail-with-evidence', '2026-08-01T00:20:00.000Z',
      '2026-08-01T00:50:00.000Z'
    );
    INSERT INTO review_participants(
      id, topic_id, role, ai_member_id, position_id, session_id, eligible,
      eligibility_reasons_json, eligibility_snapshot_json,
      eligibility_snapshot_hash, created_at
    ) VALUES (
      'review-participant:statistics', 'review-topic:statistics',
      'reviewer-participant', 'reviewer-member', 'reviewer',
      'session:reviewer-statistics', 1, '[]', '{}', '${hash}',
      '2026-08-01T00:20:00.000Z'
    );
    INSERT INTO review_findings(
      id, topic_id, reviewer_participant_id, reviewer_session_id, severity,
      summary, rationale, impact, evidence_refs_json, suggested_owner,
      blocking, created_at, scope_impact
    ) VALUES
      ('finding:1', 'review-topic:statistics', 'review-participant:statistics',
       'session:reviewer-statistics', 'medium', 'First', 'Rationale', 'Impact',
       '[]', 'software-rnd', 0, '2026-08-01T00:25:00.000Z', 'scope-preserving'),
      ('finding:2', 'review-topic:statistics', 'review-participant:statistics',
       'session:reviewer-statistics', 'high', 'Second', 'Rationale', 'Impact',
       '[]', 'software-rnd', 1, '2026-08-01T00:26:00.000Z', 'scope-preserving');
    INSERT INTO review_discussions(
      id, topic_id, round, status, conflict_finding_ids_json, bounded_prompt,
      tokens_used, cost_cents_used, duration_seconds, stop_reason, opened_at,
      closed_at
    ) VALUES
      ('discussion:1', 'review-topic:statistics', 1, 'closed', '[]', 'Discuss',
       0, 0, 0, 'resolved', '2026-08-01T00:30:00.000Z',
       '2026-08-01T00:31:00.000Z'),
      ('discussion:2', 'review-topic:statistics', 2, 'closed', '[]', 'Discuss',
       0, 0, 0, 'resolved', '2026-08-01T00:32:00.000Z',
       '2026-08-01T00:33:00.000Z');
    INSERT INTO review_revisions(
      id, topic_id, subject_kind, subject_id, subject_hash,
      producer_ai_member_id, producer_position_id, producer_session_id,
      evidence_refs_json, created_at
    ) VALUES (
      'review-revision:statistics', 'review-topic:statistics', 'product-spec',
      'subject:statistics', '${hash}', 'product-planner-member',
      'product-planner', 'session:statistics', '[]',
      '2026-08-01T00:40:00.000Z'
    );
    INSERT INTO review_rechecks(
      id, topic_id, revision_id, reviewer_participant_id, reviewer_session_id,
      result, conditions_json, evidence_refs_json, eligibility_snapshot_json,
      eligibility_snapshot_hash, created_at
    ) VALUES
      ('recheck:pass', 'review-topic:statistics', 'review-revision:statistics',
       'review-participant:statistics', 'session:recheck-pass', 'PASS', '[]',
       '[]', '{}', '${hash}', '2026-08-01T00:45:00.000Z'),
      ('recheck:fail', 'review-topic:statistics', 'review-revision:statistics',
       'review-participant:statistics-2', 'session:recheck-fail', 'FAIL', '[]',
       '[]', '{}', '${hash}', '2026-08-01T00:46:00.000Z');
    INSERT INTO product_readiness_evidence(
      id, project_id, run_id, product_baseline_id, product_baseline_hash,
      project_spec_revision_id, project_spec_hash, check_key, status, summary,
      evidence_refs_json, producer_ai_member_id, producer_position_id,
      producer_session_id, created_at
    ) VALUES
      ('readiness:blocked', 'project:statistics', 'run:statistics',
       'product-baseline:statistics', '${hash}', 'project-spec:statistics',
       '${hash}', 'dependencies', 'blocked', 'Dependency is blocked', '[]',
       'product-planner-member', 'product-planner', 'session:statistics',
       '2026-08-01T00:55:00.000Z'),
      ('readiness:ready', 'project:statistics', 'run:statistics',
       'product-baseline:statistics', '${hash}', 'project-spec:statistics',
       '${hash}', 'contracts', 'ready', 'Contracts are ready', '[]',
       'product-planner-member', 'product-planner', 'session:statistics',
       '2026-08-01T00:56:00.000Z');
  `);
  database.close();
};

describe("Statistics Runtime", () => {
  it("inspects deterministic baseline quality facts without writing", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    const beforeSequence = database.eventSequence();

    const view = database.statistics.inspect(baselineQuery);

    assert.equal(database.eventSequence(), beforeSequence);
    assert.equal(view.asOfSequence, beforeSequence);
    assert.deepEqual(view.query.filters.departmentIds, ["software-rnd"]);
    assert.deepEqual(view.query.cohort.filters.departmentIds, ["software-rnd"]);
    assert.deepEqual(view.query.comparisonSet.metricIds, [
      "product-baseline-confirmation-count",
      "product-baseline-confirmation-latency",
      "readiness-blocker-count",
      "review-discussion-round-count",
      "review-finding-count",
      "review-recheck-pass-rate",
    ]);
    assert.deepEqual(
      view.observations.map((observation) => ({
        metricId: observation.metricId,
        status: observation.status,
        measurement:
          observation.status === "available" ? observation.measurement : null,
      })),
      [
        {
          metricId: "product-baseline-confirmation-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
        {
          metricId: "product-baseline-confirmation-latency",
          status: "available",
          measurement: { kind: "duration", milliseconds: 600_000 },
        },
        {
          metricId: "readiness-blocker-count",
          status: "available",
          measurement: { kind: "count", value: 1 },
        },
        {
          metricId: "review-discussion-round-count",
          status: "available",
          measurement: { kind: "count", value: 2 },
        },
        {
          metricId: "review-finding-count",
          status: "available",
          measurement: { kind: "count", value: 2 },
        },
        {
          metricId: "review-recheck-pass-rate",
          status: "available",
          measurement: {
            kind: "rate",
            numerator: 1,
            denominator: 2,
            value: 0.5,
          },
        },
      ],
    );
    assert.deepEqual(view.completeness, {
      status: "complete",
      incompleteMetricIds: [],
      unavailableMetricIds: [],
    });

    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM statistics_evidence_snapshots",
          )
          .get() as { readonly count: number }
      ).count,
      0,
    );
    sqlite.close();
    database.close();
  });

  it("keeps exact zero distinct from missing dimensional and denominator facts", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);

    const empty = database.statistics.inspect({
      ...baselineQuery,
      window: {
        kind: "explicit-utc-half-open",
        startInclusive: "2026-08-02T00:00:00.000Z",
        endExclusive: "2026-08-03T00:00:00.000Z",
      },
    });
    assert.deepEqual(
      empty.observations.find(
        (entry) => entry.metricId === "review-finding-count",
      ),
      {
        metricId: "review-finding-count",
        status: "available",
        measurement: { kind: "count", value: 0 },
        sourceFactFamily: "review-finding",
        sourceFactRefs: [],
      },
    );
    assert.equal(
      empty.observations.find(
        (entry) => entry.metricId === "review-recheck-pass-rate",
      )?.status,
      "unavailable",
    );

    const repositoryFiltered = database.statistics.inspect({
      ...baselineQuery,
      filters: { repositoryIds: ["repository:sandcastle"] },
    });
    assert.equal(repositoryFiltered.completeness.status, "unavailable");
    assert.equal(
      repositoryFiltered.observations.every(
        (entry) =>
          entry.status === "unavailable" &&
          entry.unavailableReasonCode === "missing-dimension-attribution",
      ),
      true,
    );
    database.close();
  });

  it("freezes one immutable restart-stable snapshot and replays the exact Command", () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    seedBaselineFacts(database.path);
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "command:freeze-statistics",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:statistics",
        authenticatedBy: "runtime" as const,
      },
      consumerId: "statistics-runtime-test",
      command: {
        type: "statistics.evidence.freeze" as const,
        evidenceSnapshotId: "statistics-evidence:baseline",
        query: baselineQuery,
      },
    };

    const first = database.commandRegistry.execute(envelope);
    const replay = database.commandRegistry.execute(envelope);
    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    if (first.status !== "succeeded") assert.fail("freeze must succeed");
    assert.equal(first.value.id, "statistics-evidence:baseline");
    assert.equal(first.value.frozenBy.type, "runtime-worker");
    assert.deepEqual(
      database.statistics.inspectEvidence("statistics-evidence:baseline"),
      first.value,
    );
    database.close();

    database = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(
      database.statistics.inspectEvidence("statistics-evidence:baseline"),
      first.value,
    );
    const sqlite = new DatabaseSync(database.path);
    assert.throws(
      () =>
        sqlite
          .prepare(
            "UPDATE statistics_evidence_snapshots SET observations_json = '[]' WHERE id = ?",
          )
          .run("statistics-evidence:baseline"),
      /Statistics evidence snapshot is immutable/,
    );
    sqlite.close();
    database.close();
  });
});
