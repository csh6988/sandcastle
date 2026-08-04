import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { deterministicGovernedRevisionId } from "./governedRevisionAdapter.js";
import type {
  ImprovementProposalRevisionContent,
  StatisticsEvidenceSnapshotView,
} from "../interface.js";

const timestamp = "2026-08-02T00:00:00.000Z";
const hash = "a".repeat(64);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};
const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));
const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-improvement-application-runtime-"));

const fixtureHarnessSourceContent = {
  principles: ["Preserve governed history."],
  constitution: "Restore only exact governed revisions.",
  rules: ["Require an exact rollback source."],
  examples: { positive: [], negative: [] },
  impactScope: ["fixture"],
};

const ensureGovernedRollbackSource = (
  databasePath: string,
  target: ImprovementProposalRevisionContent["target"],
): { readonly revisionId: string; readonly revisionHash: string } => {
  const revisionHash =
    target.targetKind === "harness"
      ? sha256(fixtureHarnessSourceContent)
      : target.targetKind === "application-spec"
        ? sha256({
            applicationId: target.content.lineage.applicationId,
            promotedProjectSpecRevisionId:
              target.content.lineage.promotedProjectSpecRevisionId,
            promotedProjectSpecHash:
              target.content.lineage.promotedProjectSpecHash,
            content: target.content.content,
          })
        : sha256(target.content);
  const revisionId = `fixture-${target.targetKind}-source:${sha256(target.ownerId).slice(0, 24)}`;
  const sqlite = new DatabaseSync(databasePath);
  const table =
    target.targetKind === "harness"
      ? "governed_harness_revisions"
      : target.targetKind === "project-spec"
        ? "project_spec_revisions"
        : target.targetKind === "application-spec"
          ? "application_spec_revisions"
          : target.targetKind === "template"
            ? "runtime_template_revisions"
            : "governed_skill_flow_revisions";
  if (
    sqlite
      .prepare(`SELECT 1 AS present FROM ${table} WHERE id = ?`)
      .get(revisionId)
  ) {
    sqlite.close();
    return { revisionId, revisionHash };
  }
  sqlite.exec(
    target.targetKind === "project-spec" ||
      target.targetKind === "application-spec"
      ? "PRAGMA foreign_keys = OFF;"
      : "PRAGMA foreign_keys = ON;",
  );
  if (target.targetKind === "harness") {
    sqlite
      .prepare(
        `INSERT INTO governed_harness_revisions(
           id, owner_id, revision, supersedes_revision_id, content_json,
           content_hash, operation_id, phase, created_at
         ) VALUES (?, ?, 1, NULL, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        revisionId,
        target.ownerId,
        canonicalJson(fixtureHarnessSourceContent),
        revisionHash,
        timestamp,
      );
  } else if (target.targetKind === "project-spec") {
    sqlite
      .prepare(
        `INSERT INTO project_spec_revisions(
           id, project_spec_id, project_id, run_id, product_baseline_id,
           product_baseline_hash, revision, supersedes_revision_id,
           content_json, content_hash, producer_ai_member_id,
           producer_position_id, producer_session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        target.ownerId,
        `fixture-project:${target.ownerId}`,
        `fixture-run:${target.ownerId}`,
        `fixture-baseline:${target.ownerId}`,
        hash,
        canonicalJson(target.content),
        revisionHash,
        "fixture-ai-member",
        "fixture-position",
        "fixture-session",
        timestamp,
      );
  } else if (target.targetKind === "application-spec") {
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions(
           id, application_spec_id, application_id, project_id, run_id,
           promoted_project_spec_revision_id, promoted_project_spec_hash,
           revision, supersedes_revision_id, content_json, content_hash,
           producer_ai_member_id, producer_position_id, producer_session_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        target.ownerId,
        target.content.lineage.applicationId,
        target.content.lineage.projectId,
        `fixture-run:${target.ownerId}`,
        target.content.lineage.promotedProjectSpecRevisionId,
        target.content.lineage.promotedProjectSpecHash,
        canonicalJson(target.content.content),
        revisionHash,
        "fixture-ai-member",
        "fixture-position",
        "fixture-session",
        timestamp,
      );
  } else if (target.targetKind === "template") {
    sqlite
      .prepare(
        `INSERT INTO runtime_template_revisions(
           id, owner_id, revision, supersedes_revision_id, manifest_json,
           content_hash, operation_id, phase, created_at
         ) VALUES (?, ?, 1, NULL, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        revisionId,
        target.ownerId,
        canonicalJson(target.content.manifest),
        revisionHash,
        timestamp,
      );
  } else {
    sqlite
      .prepare(
        `INSERT INTO governed_skill_flow_revisions(
           id, owner_id, position_id, revision, supersedes_revision_id, name,
           instructions, skill_ids_json, content_hash, operation_id, phase,
           created_at
         ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        revisionId,
        target.ownerId,
        target.content.positionId,
        target.content.name,
        target.content.instructions,
        canonicalJson(target.content.skillIds),
        revisionHash,
        timestamp,
      );
  }
  sqlite.close();
  return { revisionId, revisionHash };
};

const createApprovedHarnessProposal = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix = "1",
  direction: "increase" | "decrease" | "hold" = "decrease",
  targetOptions: {
    readonly target?: (
      projectId: string,
    ) => ImprovementProposalRevisionContent["target"];
    readonly governedHead?: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
    readonly rollbackSource?: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
    readonly principle?: string;
  } = {},
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
  const requestedTarget = targetOptions.target?.(project.id) ?? {
    targetKind: "harness" as const,
    ownerId: "harness:software-rnd-review",
    governedHead: targetOptions.governedHead ?? {
      revisionId: null,
      revisionHash: null,
    },
    content: {
      principles: [targetOptions.principle ?? "Use exact frozen evidence."],
      constitution: "Review immutable production contracts.",
      rules: ["Bind every recommendation to exact evidence."],
      examples: {
        positive: ["Cite the frozen evidence identity."],
        negative: ["Use a moving dashboard result."],
      },
      impactScope: [project.id],
    },
  };
  const rollbackSource =
    targetOptions.rollbackSource ??
    ensureGovernedRollbackSource(database.path, requestedTarget);
  const target = {
    ...requestedTarget,
    governedHead:
      targetOptions.governedHead ??
      (requestedTarget.governedHead.revisionId === null
        ? rollbackSource
        : requestedTarget.governedHead),
  } as ImprovementProposalRevisionContent["target"];
  const content: ImprovementProposalRevisionContent = {
    evidence,
    target,
    rootCauseHypothesis: "Review guidance permits moving evidence.",
    impactScope: {
      projectIds: [project.id],
      departmentIds: [],
      positionIds: [],
    },
    expectedMetrics: [{ metricId: "review-finding-count", direction }],
    validationPolicy: {
      metricIds: ["review-finding-count"],
      minimumComparableObservations: 1,
    },
    rolloutNotes: "Validate against the next comparable cohort.",
    rollbackSource,
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

const persistEvidenceVariant = (
  databasePath: string,
  before: StatisticsEvidenceSnapshotView,
  input: {
    readonly id: string;
    readonly count?: number;
    readonly comparisonSetId?: string;
    readonly unavailable?: boolean;
  },
): StatisticsEvidenceSnapshotView => {
  const query = {
    ...before.query,
    window: {
      ...before.query.window,
      startInclusive: "2026-08-02T00:00:00.000Z",
      endExclusive: "2026-08-03T00:00:00.000Z",
    },
    comparisonSet: {
      ...before.query.comparisonSet,
      id: input.comparisonSetId ?? before.query.comparisonSet.id,
    },
  };
  const observations = before.observations.map((observation) =>
    observation.metricId === "review-finding-count"
      ? input.unavailable
        ? {
            metricId: "review-finding-count" as const,
            status: "unavailable" as const,
            reason: "The exact after denominator is unavailable.",
            unavailableReasonCode: "missing-denominator-authority" as const,
            sourceFactFamily: "review-finding",
            sourceFactRefs: [],
          }
        : {
            metricId: "review-finding-count" as const,
            status: "available" as const,
            measurement: { kind: "count" as const, value: input.count ?? 0 },
            sourceFactFamily: "review-finding",
            sourceFactRefs: [],
          }
      : observation,
  );
  const queryJson = canonicalJson(query);
  const createdAt = "2026-08-04T00:10:00.000Z";
  const snapshotWithoutHash = {
    id: input.id,
    query,
    queryHash: sha256(queryJson),
    asOfSequence: before.asOfSequence + 1,
    observations,
    completeness: {
      status: input.unavailable
        ? ("unavailable" as const)
        : ("complete" as const),
      incompleteMetricIds: [],
      unavailableMetricIds: input.unavailable
        ? ["review-finding-count" as const]
        : [],
    },
    frozenBy: {
      type: "runtime-worker" as const,
      id: "runtime-worker:improvement-validation",
      authenticatedBy: "runtime" as const,
    },
    createdAt,
  };
  const snapshot: StatisticsEvidenceSnapshotView = {
    ...snapshotWithoutHash,
    hash: sha256(canonicalJson(snapshotWithoutHash)),
  };
  const sqlite = new DatabaseSync(databasePath);
  sqlite
    .prepare(
      `INSERT INTO statistics_evidence_snapshots(
         id, project_id, catalog_version, canonical_query_json, query_hash,
         as_of_sequence, observations_json, completeness_json,
         frozen_by_actor_type, frozen_by_actor_id, frozen_by_authenticated_by,
         snapshot_hash, command_id, created_at
       ) VALUES (?, ?, 'statistics@1', ?, ?, ?, ?, ?, 'runtime-worker', ?,
                 'runtime', ?, ?, ?)`,
    )
    .run(
      snapshot.id,
      snapshot.query.projectId,
      queryJson,
      snapshot.queryHash,
      snapshot.asOfSequence,
      canonicalJson(snapshot.observations),
      canonicalJson(snapshot.completeness),
      snapshot.frozenBy.id,
      snapshot.hash,
      `fixture:${snapshot.id}`,
      snapshot.createdAt,
    );
  sqlite.close();
  return snapshot;
};

const seedReviewFindingFacts = (
  databasePath: string,
  input: {
    readonly projectId: string;
    readonly suffix: string;
    readonly createdAt: string;
    readonly count: number;
  },
): void => {
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  sqlite
    .prepare(
      `INSERT INTO department_runs(
         id, project_id, department_id, status, created_at, revision,
         snapshot_revision_id, pipeline_version_id
       ) VALUES (?, ?, ?, 'completed', ?, 1, ?, ?)`,
    )
    .run(
      `run:validation:${input.suffix}`,
      input.projectId,
      `department:validation:${input.suffix}`,
      input.createdAt,
      `snapshot:validation:${input.suffix}`,
      `pipeline:validation:${input.suffix}`,
    );
  sqlite
    .prepare(
      `INSERT INTO review_topics(
         id, project_id, run_id, title, kind, status, revision, manifest_json,
         manifest_hash, producer_ai_member_id, producer_position_id,
         producer_session_id, quorum, budget_json, rounds_used,
         duration_seconds_used, tokens_used, cost_cents_used, stop_condition,
         escalation_policy, created_at, updated_at
       ) VALUES (?, ?, ?, 'Validation review', 'product', 'PASS', 1, '{}', ?,
                 'fixture-ai-member', 'fixture-position', 'fixture-session', 1,
                 '{}', 0, 0, 0, 0, 'blocking-findings-dispositioned',
                 'fail-with-evidence', ?, ?)`,
    )
    .run(
      `review-topic:validation:${input.suffix}`,
      input.projectId,
      `run:validation:${input.suffix}`,
      hash,
      input.createdAt,
      input.createdAt,
    );
  for (let index = 0; index < input.count; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO review_findings(
           id, topic_id, reviewer_participant_id, reviewer_session_id,
           severity, summary, rationale, impact, evidence_refs_json,
           suggested_owner, blocking, created_at, scope_impact
         ) VALUES (?, ?, ?, ?, 'medium', 'Validation finding', 'Exact fact',
                   'Measured impact', '[]', 'fixture-owner', 0, ?,
                   'scope-preserving')`,
      )
      .run(
        `review-finding:validation:${input.suffix}:${index}`,
        `review-topic:validation:${input.suffix}`,
        `review-participant:validation:${input.suffix}`,
        `review-session:validation:${input.suffix}`,
        input.createdAt,
      );
  }
  sqlite.close();
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

const prepareAppliedRollbackScenario = async (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
) => {
  const sourceProposal = createApprovedHarnessProposal(
    database,
    `${suffix}-source`,
  );
  const sourceIntent = database.commandRegistry.execute(
    harnessApplyEnvelope(sourceProposal, {
      operationId: `improvement-application:${suffix}:source`,
      commandId: `command:${suffix}:source`,
    }),
  );
  assert.equal(sourceIntent.status, "succeeded");
  if (sourceIntent.status !== "succeeded") assert.fail("source must succeed");
  const source = await database.improvementApplications.dispatch(
    sourceIntent.value.id,
  );
  const sourceRevision = source.receipts[0]?.targetRevision;
  if (!sourceRevision) assert.fail("source revision must exist");
  const changedProposal = createApprovedHarnessProposal(
    database,
    `${suffix}-change`,
    "decrease",
    {
      governedHead: sourceRevision,
      rollbackSource: sourceRevision,
      principle: `Use the ${suffix} changed policy.`,
    },
  );
  const changedIntent = database.commandRegistry.execute(
    harnessApplyEnvelope(changedProposal, {
      operationId: `improvement-application:${suffix}:change`,
      commandId: `command:${suffix}:change`,
    }),
  );
  assert.equal(changedIntent.status, "succeeded");
  if (changedIntent.status !== "succeeded") assert.fail("change must succeed");
  const application = await database.improvementApplications.dispatch(
    changedIntent.value.id,
  );
  const appliedRevision = application.receipts[0]?.targetRevision;
  if (!appliedRevision) assert.fail("applied revision must exist");
  return { sourceRevision, changedProposal, application, appliedRevision };
};

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
      1,
    );
    sqlite.close();

    const applied = await database.improvementApplications.dispatch(
      intent.value.id,
    );
    assert.equal(applied.state, "applied");
    assert.equal(applied.receipts.length, 1);
    assert.equal(applied.receipts[0]?.disposition, "applied");
    const appliedTargetRevision = applied.receipts[0]?.targetRevision;
    if (!appliedTargetRevision) assert.fail("applied revision must exist");
    assert.match(appliedTargetRevision.revisionHash, /^[a-f0-9]{64}$/);
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
      2,
    );
    const governedRevision = after
      .prepare(
        `SELECT id, content_hash AS contentHash
           FROM governed_harness_revisions
          WHERE id = ?`,
      )
      .get(appliedTargetRevision.revisionId) as {
      readonly id: string;
      readonly contentHash: string;
    };
    assert.equal(governedRevision.id, appliedTargetRevision.revisionId);
    assert.equal(
      governedRevision.contentHash,
      appliedTargetRevision.revisionHash,
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
      2,
    );
    sqlite.close();
    database.close();
  });

  it("applies every governed target kind through restart reconciliation without duplicate effects", async () => {
    const targetCases = [
      {
        kind: "project-spec" as const,
        target: (projectId: string) => ({
          targetKind: "project-spec" as const,
          ownerId: "project-spec:checkout",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            outcome: "Ship the accepted Project outcome.",
            acceptanceCriteria: ["The Project outcome remains verifiable."],
            applicationBoundaries: ["application:checkout"],
            crossApplicationContracts: ["checkout-api@1"],
            deliveryConstraints: [`Remain scoped to ${projectId}.`],
          },
        }),
      },
      {
        kind: "application-spec" as const,
        target: (projectId: string) => ({
          targetKind: "application-spec" as const,
          ownerId: "application-spec:checkout",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            lineage: {
              projectId,
              applicationId: "application:checkout",
              promotedProjectSpecRevisionId: "project-spec-revision:accepted",
              promotedProjectSpecHash: "b".repeat(64),
            },
            content: {
              design: "Use the accepted checkout contract.",
              acceptanceCriteria: ["Checkout requests are idempotent."],
              workPackageConstraints: ["Keep writes isolated."],
              integrationObligations: ["Produce checkout-api@1."],
              contractRefs: [{ id: "checkout-api", version: "1" }],
            },
          },
        }),
      },
      {
        kind: "template" as const,
        target: (_projectId: string) => ({
          targetKind: "template" as const,
          ownerId: "template:software-rnd-review",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            manifest: [
              { path: "review/prompt.md", contentHash: "b".repeat(64) },
              { path: "review/rules.md", contentHash: "c".repeat(64) },
            ],
          },
        }),
      },
      {
        kind: "skill-flow" as const,
        target: (_projectId: string) => ({
          targetKind: "skill-flow" as const,
          ownerId: "skill-flow:software-rnd-review",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            positionId: "reviewer",
            name: "Governed review",
            instructions: "Review the exact immutable evidence.",
            skillIds: ["code-review"],
          },
        }),
      },
    ];
    for (const targetCase of targetCases) {
      const companyDir = tempCompanyDir();
      let appendCalls = 0;
      let effect:
        | { readonly revisionId: string; readonly revisionHash: string }
        | undefined;
      const adapter = {
        inspectEffect: async (input: {
          readonly operationId: string;
          readonly target: ImprovementProposalRevisionContent["target"];
          readonly phase: "apply" | "rollback";
        }) =>
          effect
            ? ({
                outcome: "exact-match" as const,
                revision: effect,
                evidenceRefs: [`fixture:${effect.revisionId}`],
              } as const)
            : ({
                outcome: "proven-absent" as const,
                evidenceRefs: [
                  `fixture:${input.operationId}:${input.phase}:absent`,
                ],
              } as const),
        appendRevision: async (input: {
          readonly operationId: string;
          readonly target: ImprovementProposalRevisionContent["target"];
          readonly phase: "apply" | "rollback";
        }) => {
          appendCalls += 1;
          effect = {
            revisionId: deterministicGovernedRevisionId({
              operationId: input.operationId,
              targetKind: input.target.targetKind,
              phase: input.phase,
            }),
            revisionHash: sha256(input.target.content),
          };
          return {
            revision: effect,
            disposition: "applied" as const,
            evidenceRefs: [`fixture:${effect.revisionId}`],
          };
        },
      };
      let failAfterEffect = true;
      let database = openCompanyDatabase(companyDir, {
        clock: () => new Date(timestamp),
        improvementApplicationRuntime: {
          adapter,
          failureInjection: (point) => {
            if (failAfterEffect && point === "after-effect-before-finalize") {
              throw new Error(`simulated ${targetCase.kind} finalize crash`);
            }
          },
        },
      });
      const approved = createApprovedHarnessProposal(
        database,
        `spec-restart:${targetCase.kind}`,
        "decrease",
        { target: targetCase.target },
      );
      const envelope = harnessApplyEnvelope(approved, {
        operationId: `improvement-application:${targetCase.kind}:restart`,
        commandId: `command:apply-${targetCase.kind}-restart`,
      });
      const intent = database.commandRegistry.execute(envelope);
      assert.equal(intent.status, "succeeded");
      if (intent.status !== "succeeded") assert.fail("intent must succeed");
      await assert.rejects(
        database.improvementApplications.dispatch(intent.value.id),
        new RegExp(`simulated ${targetCase.kind} finalize crash`),
      );
      assert.equal(appendCalls, 1);
      database.close();

      failAfterEffect = false;
      database = openCompanyDatabase(companyDir, {
        clock: () => new Date(timestamp),
        improvementApplicationRuntime: { adapter },
      });
      const recovered = await database.improvementApplications.dispatch(
        intent.value.id,
      );
      assert.equal(recovered.state, "applied");
      assert.equal(recovered.target.targetKind, targetCase.kind);
      assert.equal(recovered.receipts.at(-1)?.disposition, "no-op");
      assert.equal(appendCalls, 1);
      database.close();
    }
  });

  it("fails closed for unauthorized apply and insufficient target evidence without invoking append", async () => {
    const companyDir = tempCompanyDir();
    let appendCalls = 0;
    let verifiedEffect = false;
    let inspectCalls = 0;
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
      improvementApplicationRuntime: {
        adapter: {
          inspectEffect: async () => {
            inspectCalls += 1;
            return verifiedEffect
              ? {
                  outcome: "exact-match" as const,
                  revision: {
                    revisionId: "governed-harness-revision:verified",
                    revisionHash: "c".repeat(64),
                  },
                  evidenceRefs: ["target-inspection:verified"],
                }
              : {
                  outcome: "insufficient-evidence" as const,
                  evidenceRefs: ["target-inspection:insufficient"],
                };
          },
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
    assert.equal(inspectCalls, 1);

    const replayWithoutReconciliation = database.commandRegistry.execute({
      ...harnessApplyEnvelope(approved, {
        operationId: unknown.id,
        commandId: "command:apply-harness-improvement-unknown-replay",
      }),
    });
    assert.equal(replayWithoutReconciliation.status, "succeeded");
    if (replayWithoutReconciliation.status !== "succeeded") {
      assert.fail("canonical replay must succeed");
    }
    assert.equal(replayWithoutReconciliation.value.state, "unknown");
    assert.equal(inspectCalls, 1);

    verifiedEffect = true;
    const reconciliation = database.commandRegistry.execute({
      ...harnessApplyEnvelope(approved, {
        operationId: unknown.id,
        commandId: "command:reconcile-harness-improvement-unknown",
      }),
      command: {
        ...harnessApplyEnvelope(approved, {
          operationId: unknown.id,
          commandId: "unused",
        }).command,
        reconciliation: {
          expectedOperationHash: unknown.canonicalRequestHash,
          reason: "A verified human reviewed exact target inspection evidence.",
          evidenceRefs: ["target-inspection:verified-human"],
        },
      },
    });
    assert.equal(reconciliation.status, "succeeded");
    if (reconciliation.status !== "succeeded") {
      assert.fail("verified reconciliation must succeed");
    }
    assert.equal(reconciliation.value.state, "reconciling");
    assert.equal(
      reconciliation.value.canonicalRequestHash,
      unknown.canonicalRequestHash,
    );
    assert.deepEqual(reconciliation.value.reconciliations.at(-1), {
      id: reconciliation.value.reconciliations.at(-1)?.id,
      phase: "apply",
      result: "unknown",
      evidenceRefs: ["target-inspection:verified-human"],
      hash: reconciliation.value.reconciliations.at(-1)?.hash,
      createdAt: timestamp,
    });
    const recovered = await database.improvementApplications.dispatch(
      unknown.id,
    );
    assert.equal(recovered.state, "applied");
    assert.equal(recovered.observations.at(-1)?.outcome, "exact-match");
    assert.equal(appendCalls, 0);
    assert.equal(inspectCalls, 2);
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
      2,
    );
    sqlite.close();
    database.close();
  });

  it("validates an applied operation with exact comparable frozen evidence and no second target effect", async () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    const approved = createApprovedHarnessProposal(database, "validation");
    const applyEnvelope = harnessApplyEnvelope(approved, {
      operationId: "improvement-application:harness:validation",
      commandId: "command:apply-harness-validation",
    });
    const intent = database.commandRegistry.execute(applyEnvelope);
    assert.equal(intent.status, "succeeded");
    if (intent.status !== "succeeded") assert.fail("apply intent must succeed");
    const applied = await database.improvementApplications.dispatch(
      intent.value.id,
    );
    assert.equal(applied.state, "applied");

    const afterEvidenceSnapshotId =
      "statistics-evidence:harness-validation:after";
    assert.throws(() =>
      database.statistics.inspectEvidence(afterEvidenceSnapshotId),
    );
    const validationEnvelope = {
      schemaVersion: 1 as const,
      commandId: "command:validate-harness-improvement",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId,
          afterWindow: {
            kind: "explicit-utc-half-open" as const,
            startInclusive: "2026-08-02T00:00:00.000Z",
            endExclusive: "2026-08-03T00:00:00.000Z",
          },
          reason: "Compare the next exact governed cohort.",
          evidenceRefs: [approved.content.evidence.id, afterEvidenceSnapshotId],
        },
      },
    };
    const validated = database.commandRegistry.execute(validationEnvelope);
    assert.equal(validated.status, "succeeded");
    if (validated.status !== "succeeded") {
      assert.fail("validation must succeed");
    }
    assert.equal(validated.value.state, "validated");
    assert.equal(validated.value.validations.length, 1);
    assert.equal(validated.value.validations[0]?.outcome, "unchanged");
    const afterEvidence = database.statistics.inspectEvidence(
      afterEvidenceSnapshotId,
    );
    assert.deepEqual(afterEvidence.query, {
      ...approved.content.evidence.query,
      window: validationEnvelope.command.validation.afterWindow,
    });
    assert.deepEqual(afterEvidence.frozenBy, validationEnvelope.actor);
    assert.deepEqual(
      validated.value.validations[0]?.afterEvidence,
      afterEvidence,
    );
    assert.deepEqual(
      database.commandRegistry.execute(validationEnvelope),
      validated,
    );
    const changedReplay = database.commandRegistry.execute({
      ...validationEnvelope,
      command: {
        ...validationEnvelope.command,
        validation: {
          ...validationEnvelope.command.validation,
          reason: "Changed validation input under the same Command ID.",
        },
      },
    });
    assert.equal(changedReplay.status, "rejected");
    if (changedReplay.status !== "rejected") {
      assert.fail("changed validation replay must be rejected");
    }
    assert.equal(changedReplay.error.code, "COMMAND_ID_REUSE");

    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      2,
    );
    sqlite.close();
    database.close();
  });

  it("records improved and regressed outcomes from approved metric directions", async () => {
    for (const scenario of [
      {
        suffix: "improved",
        direction: "increase" as const,
        outcome: "improved",
      },
      {
        suffix: "regressed",
        direction: "decrease" as const,
        outcome: "regressed",
      },
    ]) {
      const database = openCompanyDatabase(tempCompanyDir(), {
        clock: () => new Date(timestamp),
      });
      const approved = createApprovedHarnessProposal(
        database,
        scenario.suffix,
        scenario.direction,
      );
      const apply = database.commandRegistry.execute(
        harnessApplyEnvelope(approved, {
          operationId: `improvement-application:harness:${scenario.suffix}`,
          commandId: `command:apply-harness-${scenario.suffix}`,
        }),
      );
      assert.equal(apply.status, "succeeded");
      if (apply.status !== "succeeded") assert.fail("apply must succeed");
      const applied = await database.improvementApplications.dispatch(
        apply.value.id,
      );
      const afterEvidenceSnapshotId = `statistics-evidence:${scenario.suffix}:after`;
      seedReviewFindingFacts(database.path, {
        projectId: approved.content.evidence.query.projectId,
        suffix: scenario.suffix,
        createdAt: "2026-08-02T12:00:00.000Z",
        count: 1,
      });
      const validated = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `command:validate-harness-${scenario.suffix}`,
        actor: {
          type: "human",
          id: "human:improvement-owner",
          authenticatedBy: "local-session",
        },
        command: {
          type: "improvement.application.validate",
          validation: {
            operationId: applied.id,
            expectedOperationHash: applied.canonicalRequestHash,
            afterEvidenceSnapshotId,
            afterWindow: {
              kind: "explicit-utc-half-open",
              startInclusive: "2026-08-02T00:00:00.000Z",
              endExclusive: "2026-08-03T00:00:00.000Z",
            },
            reason: `Record the ${scenario.outcome} validation outcome.`,
            evidenceRefs: [
              approved.content.evidence.id,
              afterEvidenceSnapshotId,
            ],
          },
        },
      });
      assert.equal(validated.status, "succeeded");
      if (validated.status !== "succeeded") {
        assert.fail("validation must succeed");
      }
      assert.equal(validated.value.validations[0]?.outcome, scenario.outcome);
      database.close();
    }
  });

  it("rejects an after-evidence window that does not follow the approved baseline window", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date(timestamp),
    });
    const approved = createApprovedHarnessProposal(
      database,
      "validation-window-order",
    );
    const apply = database.commandRegistry.execute(
      harnessApplyEnvelope(approved, {
        operationId: "improvement-application:harness:validation-window-order",
        commandId: "command:apply-harness-validation-window-order",
      }),
    );
    assert.equal(apply.status, "succeeded");
    if (apply.status !== "succeeded") assert.fail("apply must succeed");
    const applied = await database.improvementApplications.dispatch(
      apply.value.id,
    );
    const afterEvidenceSnapshotId =
      "statistics-evidence:validation-window-order:after";
    const validation = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:validate-harness-validation-window-order",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId,
          afterWindow: approved.content.evidence.query.window,
          reason: "Reject reuse of the pre-apply baseline window.",
          evidenceRefs: [approved.content.evidence.id, afterEvidenceSnapshotId],
        },
      },
    });
    assert.equal(validation.status, "rejected");
    if (validation.status !== "rejected") {
      assert.fail("the baseline window must not validate as after evidence");
    }
    assert.equal(validation.error.code, "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE");
    assert.throws(() =>
      database.statistics.inspectEvidence(afterEvidenceSnapshotId),
    );
    assert.equal(
      database.improvementApplications.inspect(applied.id).state,
      "applied",
    );
    database.close();
  });

  it("rejects an after-evidence window that predates the applied effect", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const approved = createApprovedHarnessProposal(
      database,
      "validation-applied-effect-order",
    );
    const apply = database.commandRegistry.execute(
      harnessApplyEnvelope(approved, {
        operationId:
          "improvement-application:harness:validation-applied-effect-order",
        commandId: "command:apply-harness-validation-applied-effect-order",
      }),
    );
    assert.equal(apply.status, "succeeded");
    if (apply.status !== "succeeded") assert.fail("apply must succeed");
    const applied = await database.improvementApplications.dispatch(
      apply.value.id,
    );
    const afterEvidenceSnapshotId =
      "statistics-evidence:validation-applied-effect-order:after";
    const validation = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:validate-harness-validation-applied-effect-order",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId,
          afterWindow: {
            kind: "explicit-utc-half-open" as const,
            startInclusive: "2026-08-02T00:00:00.000Z",
            endExclusive: "2026-08-03T00:00:00.000Z",
          },
          reason: "Reject evidence collected before the applied effect.",
          evidenceRefs: [approved.content.evidence.id, afterEvidenceSnapshotId],
        },
      },
    });
    assert.equal(validation.status, "rejected");
    if (validation.status !== "rejected") {
      assert.fail("pre-apply evidence must not validate an applied operation");
    }
    assert.equal(validation.error.code, "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE");
    assert.throws(() =>
      database.statistics.inspectEvidence(afterEvidenceSnapshotId),
    );
    assert.equal(
      database.improvementApplications.inspect(applied.id).state,
      "applied",
    );
    database.close();
  });

  it("rejects non-comparable or unauthorized validation without changing applied state", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date(timestamp),
    });
    const approved = createApprovedHarnessProposal(
      database,
      "invalid-validation",
    );
    const apply = database.commandRegistry.execute(
      harnessApplyEnvelope(approved, {
        operationId: "improvement-application:harness:invalid-validation",
        commandId: "command:apply-harness-invalid-validation",
      }),
    );
    assert.equal(apply.status, "succeeded");
    if (apply.status !== "succeeded") assert.fail("apply must succeed");
    const applied = await database.improvementApplications.dispatch(
      apply.value.id,
    );
    const comparable = persistEvidenceVariant(
      database.path,
      approved.content.evidence,
      { id: "statistics-evidence:validation:comparable", count: 0 },
    );
    const afterWindow = comparable.query.window;
    const unauthorized = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:validate-harness-unauthorized",
      actor: {
        type: "test-driver" as const,
        id: "fixture-only",
        authenticatedBy: "ipc-token" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId:
            "statistics-evidence:validation:unauthorized",
          afterWindow,
          reason: "Fixture authority must not validate production state.",
          evidenceRefs: [
            approved.content.evidence.id,
            "statistics-evidence:validation:unauthorized",
          ],
        },
      },
    });
    assert.equal(unauthorized.status, "rejected");
    if (unauthorized.status !== "rejected") {
      assert.fail("unauthorized validation must be rejected");
    }
    assert.equal(unauthorized.error.code, "FORBIDDEN");

    const stale = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:validate-harness-stale-evidence",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId: comparable.id,
          afterWindow,
          reason: "Reject a pre-existing frozen evidence identity.",
          evidenceRefs: [approved.content.evidence.id, comparable.id],
        },
      },
    });
    assert.equal(stale.status, "rejected");
    if (stale.status !== "rejected") {
      assert.fail("pre-existing validation evidence must be rejected");
    }
    assert.equal(stale.error.code, "STATISTICS_EVIDENCE_STALE");

    const nonComparableSnapshotId =
      "statistics-evidence:validation:non-comparable";
    const rejected = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:validate-harness-non-comparable",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: applied.id,
          expectedOperationHash: applied.canonicalRequestHash,
          afterEvidenceSnapshotId: nonComparableSnapshotId,
          afterWindow: {
            ...afterWindow,
            endExclusive: "2026-08-02T12:00:00.000Z",
          },
          reason: "Reject a changed comparison window policy.",
          evidenceRefs: [approved.content.evidence.id, nonComparableSnapshotId],
        },
      },
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") {
      assert.fail("non-comparable validation must be rejected");
    }
    assert.equal(rejected.error.code, "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE");
    assert.throws(() =>
      database.statistics.inspectEvidence(nonComparableSnapshotId),
    );
    assert.equal(
      database.improvementApplications.inspect(applied.id).state,
      "applied",
    );
    database.close();
  });

  it("rolls back an applied Harness operation by appending an exact restoring revision and retaining history", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date(timestamp),
    });
    const sourceProposal = createApprovedHarnessProposal(
      database,
      "rollback-source",
      "decrease",
      { principle: "Preserve the stable review policy." },
    );
    const sourceIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(sourceProposal, {
        operationId: "improvement-application:harness:rollback-source",
        commandId: "command:apply-harness-rollback-source",
      }),
    );
    assert.equal(sourceIntent.status, "succeeded");
    if (sourceIntent.status !== "succeeded") {
      assert.fail("source apply intent must succeed");
    }
    const sourceApplied = await database.improvementApplications.dispatch(
      sourceIntent.value.id,
    );
    const sourceRevision = sourceApplied.receipts[0]?.targetRevision;
    if (!sourceRevision) assert.fail("source revision must exist");

    const changedProposal = createApprovedHarnessProposal(
      database,
      "rollback-change",
      "decrease",
      {
        governedHead: sourceRevision,
        rollbackSource: sourceRevision,
        principle: "Apply the experimental review policy.",
      },
    );
    const changedIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(changedProposal, {
        operationId: "improvement-application:harness:rollback-change",
        commandId: "command:apply-harness-rollback-change",
      }),
    );
    assert.equal(changedIntent.status, "succeeded");
    if (changedIntent.status !== "succeeded") {
      assert.fail("changed apply intent must succeed");
    }
    const changedApplied = await database.improvementApplications.dispatch(
      changedIntent.value.id,
    );
    const appliedRevision = changedApplied.receipts[0]?.targetRevision;
    if (!appliedRevision) assert.fail("applied revision must exist");

    const rollbackEnvelope = {
      schemaVersion: 1 as const,
      commandId: "command:rollback-harness-change",
      actor: {
        type: "human" as const,
        id: "human:improvement-owner",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.application.rollback" as const,
        rollback: {
          operationId: changedApplied.id,
          expectedOperationHash: changedApplied.canonicalRequestHash,
          appliedRevision,
          expectedGovernedHead: appliedRevision,
          rollbackSource: sourceRevision,
          confirmation:
            "I confirm restoring the exact selected Harness source revision.",
          reason: "Restore the stable reviewed Harness policy.",
          evidenceRefs: [sourceRevision.revisionId, appliedRevision.revisionId],
        },
      },
    };
    const unauthorized = database.commandRegistry.execute({
      ...rollbackEnvelope,
      commandId: "command:rollback-harness-unauthorized",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
    });
    assert.equal(unauthorized.status, "rejected");
    if (unauthorized.status !== "rejected") {
      assert.fail("unauthorized rollback must be rejected");
    }
    assert.equal(unauthorized.error.code, "FORBIDDEN");
    const rollbackIntent = database.commandRegistry.execute(rollbackEnvelope);
    assert.equal(rollbackIntent.status, "succeeded");
    if (rollbackIntent.status !== "succeeded") {
      assert.fail("rollback intent must succeed");
    }
    assert.equal(rollbackIntent.value.state, "rollback-requested");
    const operationReplay = database.commandRegistry.execute({
      ...rollbackEnvelope,
      commandId: "command:rollback-harness-change-replay",
    });
    assert.equal(operationReplay.status, "succeeded");
    if (operationReplay.status !== "succeeded") {
      assert.fail("exact rollback replay must succeed");
    }
    assert.deepEqual(operationReplay.value, rollbackIntent.value);
    const changedReplay = database.commandRegistry.execute({
      ...rollbackEnvelope,
      commandId: "command:rollback-harness-change-conflict",
      command: {
        ...rollbackEnvelope.command,
        rollback: {
          ...rollbackEnvelope.command.rollback,
          reason: "Changed rollback input under the same operation.",
        },
      },
    });
    assert.equal(changedReplay.status, "rejected");
    if (changedReplay.status !== "rejected") {
      assert.fail("changed rollback replay must be rejected");
    }
    assert.equal(
      changedReplay.error.code,
      "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
    );
    const rolledBack = await database.improvementApplications.dispatch(
      rollbackIntent.value.id,
    );
    assert.equal(rolledBack.state, "rolled-back");
    assert.equal(rolledBack.rollbacks.at(-1)?.state, "rolled-back");
    const restoringRevision = rolledBack.rollbacks.at(-1)?.restoringRevision;
    if (!restoringRevision) assert.fail("restoring revision must exist");

    const sqlite = new DatabaseSync(database.path);
    const revisions = sqlite
      .prepare(
        `SELECT id, content_json AS contentJson
           FROM governed_harness_revisions
          WHERE owner_id = ? ORDER BY revision`,
      )
      .all(changedProposal.content.target.ownerId) as Array<{
      readonly id: string;
      readonly contentJson: string;
    }>;
    assert.equal(revisions.length, 4);
    assert.equal(revisions[1]?.id, sourceRevision.revisionId);
    assert.equal(revisions[2]?.id, appliedRevision.revisionId);
    assert.equal(revisions[3]?.id, restoringRevision.revisionId);
    assert.equal(revisions[3]?.contentJson, revisions[1]?.contentJson);
    assert.notEqual(revisions[2]?.contentJson, revisions[1]?.contentJson);
    sqlite.close();
    database.close();
  });

  it("rolls back Runtime template and governed Skill Flow targets by restoring exact source content", async () => {
    for (const targetKind of ["template", "skill-flow"] as const) {
      const database = openCompanyDatabase(tempCompanyDir(), {
        clock: () => new Date(timestamp),
      });
      const sqlite = new DatabaseSync(database.path);
      const position =
        targetKind === "skill-flow"
          ? (sqlite
              .prepare(
                `SELECT position_id AS positionId
                   FROM position_skill_bindings
               GROUP BY position_id
               ORDER BY position_id
                  LIMIT 1`,
              )
              .get() as { readonly positionId: string } | undefined)
          : undefined;
      if (targetKind === "skill-flow" && !position) {
        assert.fail("a seeded Position Skill binding is required");
      }
      const skillIds = position
        ? (
            sqlite
              .prepare(
                `SELECT skill_id AS skillId
                   FROM position_skill_bindings
                  WHERE position_id = ?
               ORDER BY skill_id
                  LIMIT 2`,
              )
              .all(position.positionId) as Array<{ readonly skillId: string }>
          ).map((row) => row.skillId)
        : [];
      const legacyFlowsBefore = sqlite
        .prepare("SELECT * FROM skill_flows ORDER BY id")
        .all();
      const legacySelectionsBefore = sqlite
        .prepare(
          "SELECT * FROM skill_flow_skills ORDER BY skill_flow_id, sort_order",
        )
        .all();
      sqlite.close();

      const sourceTarget = (
        _projectId: string,
      ): ImprovementProposalRevisionContent["target"] => {
        if (targetKind === "template") {
          return {
            targetKind,
            ownerId: "template:runtime-rollback",
            governedHead: { revisionId: null, revisionHash: null },
            content: {
              manifest: [
                { path: "review/prompt.md", contentHash: "b".repeat(64) },
                { path: "review/rules.md", contentHash: "c".repeat(64) },
              ],
            },
          };
        }
        return {
          targetKind,
          ownerId: "governed-skill-flow:runtime-rollback",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            positionId: position!.positionId,
            name: "Stable review",
            instructions: "Review exact immutable evidence.",
            skillIds,
          },
        };
      };
      const sourceProposal = createApprovedHarnessProposal(
        database,
        `${targetKind}:rollback-source`,
        "decrease",
        { target: sourceTarget },
      );
      const sourceIntent = database.commandRegistry.execute(
        harnessApplyEnvelope(sourceProposal, {
          operationId: `improvement-application:${targetKind}:rollback-source`,
          commandId: `command:apply-${targetKind}-rollback-source`,
        }),
      );
      assert.equal(sourceIntent.status, "succeeded");
      if (sourceIntent.status !== "succeeded") {
        assert.fail("source apply intent must succeed");
      }
      const sourceApplied = await database.improvementApplications.dispatch(
        sourceIntent.value.id,
      );
      const sourceRevision = sourceApplied.receipts[0]?.targetRevision;
      if (!sourceRevision) assert.fail("source revision must exist");

      const changedProposal = createApprovedHarnessProposal(
        database,
        `${targetKind}:rollback-change`,
        "decrease",
        {
          rollbackSource: sourceRevision,
          target: (projectId) => {
            const source = sourceTarget(projectId);
            if (source.targetKind === "template") {
              return {
                ...source,
                governedHead: sourceRevision,
                content: {
                  manifest: [
                    {
                      path: "review/prompt.md",
                      contentHash: "d".repeat(64),
                    },
                    {
                      path: "review/rules.md",
                      contentHash: "c".repeat(64),
                    },
                  ],
                },
              };
            }
            if (source.targetKind !== "skill-flow") {
              throw new Error("unexpected governed target kind");
            }
            return {
              ...source,
              governedHead: sourceRevision,
              content: {
                ...source.content,
                name: "Experimental review",
                instructions: "Review exact evidence and reconciliation state.",
              },
            };
          },
        },
      );
      const changedIntent = database.commandRegistry.execute(
        harnessApplyEnvelope(changedProposal, {
          operationId: `improvement-application:${targetKind}:rollback-change`,
          commandId: `command:apply-${targetKind}-rollback-change`,
        }),
      );
      assert.equal(changedIntent.status, "succeeded");
      if (changedIntent.status !== "succeeded") {
        assert.fail("changed apply intent must succeed");
      }
      const changedApplied = await database.improvementApplications.dispatch(
        changedIntent.value.id,
      );
      const appliedRevision = changedApplied.receipts[0]?.targetRevision;
      if (!appliedRevision) assert.fail("applied revision must exist");
      const rollbackIntent = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `command:rollback-${targetKind}-change`,
        actor: {
          type: "human" as const,
          id: "human:improvement-owner",
          authenticatedBy: "local-session" as const,
        },
        command: {
          type: "improvement.application.rollback" as const,
          rollback: {
            operationId: changedApplied.id,
            expectedOperationHash: changedApplied.canonicalRequestHash,
            appliedRevision,
            expectedGovernedHead: appliedRevision,
            rollbackSource: sourceRevision,
            confirmation: `I confirm restoring the exact selected ${targetKind} source revision.`,
            reason: `Restore the stable governed ${targetKind} content.`,
            evidenceRefs: [
              sourceRevision.revisionId,
              appliedRevision.revisionId,
            ],
          },
        },
      });
      assert.equal(rollbackIntent.status, "succeeded");
      if (rollbackIntent.status !== "succeeded") {
        assert.fail("rollback intent must succeed");
      }
      const rolledBack = await database.improvementApplications.dispatch(
        rollbackIntent.value.id,
      );
      assert.equal(rolledBack.state, "rolled-back");
      const restoringRevision = rolledBack.rollbacks.at(-1)?.restoringRevision;
      if (!restoringRevision) assert.fail("restoring revision must exist");

      const after = new DatabaseSync(database.path);
      if (targetKind === "template") {
        const revisions = after
          .prepare(
            `SELECT id, manifest_json AS contentJson
               FROM runtime_template_revisions
              WHERE owner_id = ? ORDER BY revision`,
          )
          .all(changedProposal.content.target.ownerId) as Array<{
          readonly id: string;
          readonly contentJson: string;
        }>;
        assert.equal(revisions.length, 4);
        assert.equal(revisions[3]?.id, restoringRevision.revisionId);
        assert.equal(revisions[3]?.contentJson, revisions[1]?.contentJson);
        assert.notEqual(revisions[2]?.contentJson, revisions[1]?.contentJson);
      } else {
        const revisions = after
          .prepare(
            `SELECT id, position_id AS positionId, name, instructions,
                    skill_ids_json AS skillIdsJson
               FROM governed_skill_flow_revisions
              WHERE owner_id = ? ORDER BY revision`,
          )
          .all(changedProposal.content.target.ownerId) as Array<{
          readonly id: string;
          readonly positionId: string;
          readonly name: string;
          readonly instructions: string;
          readonly skillIdsJson: string;
        }>;
        assert.equal(revisions.length, 4);
        assert.equal(revisions[3]?.id, restoringRevision.revisionId);
        assert.deepEqual(
          { ...revisions[3] },
          {
            ...revisions[1],
            id: restoringRevision.revisionId,
          },
        );
      }
      assert.deepEqual(
        after.prepare("SELECT * FROM skill_flows ORDER BY id").all(),
        legacyFlowsBefore,
      );
      assert.deepEqual(
        after
          .prepare(
            "SELECT * FROM skill_flow_skills ORDER BY skill_flow_id, sort_order",
          )
          .all(),
        legacySelectionsBefore,
      );
      after.close();
      database.close();
    }
  });

  it("reconciles an exact restoring Harness revision after restart without duplicate rollback effect", async () => {
    const companyDir = tempCompanyDir();
    let failAfterRollbackEffect = false;
    const database = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
      improvementApplicationRuntime: {
        failureInjection: (point) => {
          if (
            failAfterRollbackEffect &&
            point === "after-effect-before-finalize"
          ) {
            throw new Error("simulated rollback finalize crash");
          }
        },
      },
    });
    const sourceProposal = createApprovedHarnessProposal(
      database,
      "rollback-restart-source",
    );
    const sourceIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(sourceProposal, {
        operationId: "improvement-application:rollback-restart-source",
        commandId: "command:rollback-restart-source",
      }),
    );
    assert.equal(sourceIntent.status, "succeeded");
    if (sourceIntent.status !== "succeeded") assert.fail("source must succeed");
    const source = await database.improvementApplications.dispatch(
      sourceIntent.value.id,
    );
    const sourceRevision = source.receipts[0]?.targetRevision;
    if (!sourceRevision) assert.fail("source revision must exist");
    const changedProposal = createApprovedHarnessProposal(
      database,
      "rollback-restart-change",
      "decrease",
      {
        governedHead: sourceRevision,
        rollbackSource: sourceRevision,
        principle: "Use the restart-sensitive policy.",
      },
    );
    const changedIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(changedProposal, {
        operationId: "improvement-application:rollback-restart-change",
        commandId: "command:rollback-restart-change",
      }),
    );
    assert.equal(changedIntent.status, "succeeded");
    if (changedIntent.status !== "succeeded")
      assert.fail("change must succeed");
    const changed = await database.improvementApplications.dispatch(
      changedIntent.value.id,
    );
    const appliedRevision = changed.receipts[0]?.targetRevision;
    if (!appliedRevision) assert.fail("changed revision must exist");
    const afterEvidenceSnapshotId =
      "statistics-evidence:rollback-restart-after";
    const validation = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:rollback-restart-validation",
      actor: {
        type: "runtime-worker" as const,
        id: "runtime-worker:improvement-validation",
        authenticatedBy: "runtime" as const,
      },
      command: {
        type: "improvement.application.validate" as const,
        validation: {
          operationId: changed.id,
          expectedOperationHash: changed.canonicalRequestHash,
          afterEvidenceSnapshotId,
          afterWindow: {
            kind: "explicit-utc-half-open",
            startInclusive: "2026-08-02T00:00:00.000Z",
            endExclusive: "2026-08-03T00:00:00.000Z",
          },
          reason: "Validate before exercising restoring restart recovery.",
          evidenceRefs: [
            changedProposal.content.evidence.id,
            afterEvidenceSnapshotId,
          ],
        },
      },
    });
    assert.equal(validation.status, "succeeded");
    if (validation.status !== "succeeded") {
      assert.fail("validation before rollback must succeed");
    }
    assert.equal(validation.value.state, "validated");
    const rollback = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:rollback-restart-request",
      actor: {
        type: "human" as const,
        id: "human:improvement-owner",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.application.rollback" as const,
        rollback: {
          operationId: validation.value.id,
          expectedOperationHash: validation.value.canonicalRequestHash,
          appliedRevision,
          expectedGovernedHead: appliedRevision,
          rollbackSource: sourceRevision,
          confirmation: "I confirm the exact restart-safe restoring revision.",
          reason: "Exercise rollback restart reconciliation.",
          evidenceRefs: [sourceRevision.revisionId, appliedRevision.revisionId],
        },
      },
    });
    assert.equal(rollback.status, "succeeded");
    failAfterRollbackEffect = true;
    await assert.rejects(
      database.improvementApplications.dispatch(changed.id),
      /simulated rollback finalize crash/,
    );
    database.close();

    const restarted = openCompanyDatabase(companyDir, {
      clock: () => new Date(timestamp),
    });
    await restarted.improvementApplications.reconcilePending();
    const recovered = restarted.improvementApplications.inspect(
      validation.value.id,
    );
    assert.equal(recovered.state, "rolled-back");
    assert.equal(
      recovered.receipts.filter((receipt) => receipt.phase === "rollback")
        .length,
      1,
    );
    const sqlite = new DatabaseSync(restarted.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      4,
    );
    sqlite.close();
    restarted.close();
  });

  it("fails rollback on governed-head drift without appending a restoring revision", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date(timestamp),
    });
    const scenario = await prepareAppliedRollbackScenario(
      database,
      "rollback-head-drift",
    );
    const driftProposal = createApprovedHarnessProposal(
      database,
      "rollback-head-drift-intervening",
      "decrease",
      {
        governedHead: scenario.appliedRevision,
        rollbackSource: scenario.appliedRevision,
        principle: "Append an intervening governed policy.",
      },
    );
    const driftIntent = database.commandRegistry.execute(
      harnessApplyEnvelope(driftProposal, {
        operationId: "improvement-application:rollback-head-drift:intervening",
        commandId: "command:rollback-head-drift:intervening",
      }),
    );
    assert.equal(driftIntent.status, "succeeded");
    if (driftIntent.status !== "succeeded") assert.fail("drift must succeed");
    await database.improvementApplications.dispatch(driftIntent.value.id);

    const rollback = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:rollback-head-drift:rollback",
      actor: {
        type: "human" as const,
        id: "human:improvement-owner",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.application.rollback" as const,
        rollback: {
          operationId: scenario.application.id,
          expectedOperationHash: scenario.application.canonicalRequestHash,
          appliedRevision: scenario.appliedRevision,
          expectedGovernedHead: scenario.appliedRevision,
          rollbackSource: scenario.sourceRevision,
          confirmation: "I confirm the exact stale-head rollback request.",
          reason: "Prove governed-head drift fails closed.",
          evidenceRefs: [
            scenario.sourceRevision.revisionId,
            scenario.appliedRevision.revisionId,
          ],
        },
      },
    });
    assert.equal(rollback.status, "succeeded");
    const failed = await database.improvementApplications.dispatch(
      scenario.application.id,
    );
    assert.equal(failed.state, "rollback-failed");
    assert.equal(failed.latestError?.code, "IMPROVEMENT_TARGET_CONFLICT");
    assert.equal(failed.rollbacks.at(-1)?.state, "failed");
    const sqlite = new DatabaseSync(database.path);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      4,
    );
    sqlite.close();
    database.close();
  });

  it("keeps a conflicting restoring effect unknown and reconciles without blind resend", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date(timestamp),
    });
    const scenario = await prepareAppliedRollbackScenario(
      database,
      "rollback-unknown",
    );
    const rollbackInput = {
      operationId: scenario.application.id,
      expectedOperationHash: scenario.application.canonicalRequestHash,
      appliedRevision: scenario.appliedRevision,
      expectedGovernedHead: scenario.appliedRevision,
      rollbackSource: scenario.sourceRevision,
      confirmation: "I confirm inspecting this exact restoring revision.",
      reason: "Fail closed on a conflicting deterministic effect.",
      evidenceRefs: [
        scenario.sourceRevision.revisionId,
        scenario.appliedRevision.revisionId,
      ],
    };
    const requested = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:rollback-unknown:request",
      actor: {
        type: "human" as const,
        id: "human:improvement-owner",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.application.rollback" as const,
        rollback: rollbackInput,
      },
    });
    assert.equal(requested.status, "succeeded");
    const conflictId = deterministicGovernedRevisionId({
      operationId: scenario.application.id,
      targetKind: "harness",
      phase: "rollback",
    });
    const sqlite = new DatabaseSync(database.path);
    sqlite
      .prepare(
        `INSERT INTO governed_harness_revisions(
           id, owner_id, revision, supersedes_revision_id, content_json,
           content_hash, operation_id, phase, created_at
         ) VALUES (?, ?, 4, ?, '{}', ?, ?, 'rollback', ?)`,
      )
      .run(
        conflictId,
        scenario.changedProposal.content.target.ownerId,
        scenario.appliedRevision.revisionId,
        "b".repeat(64),
        scenario.application.id,
        timestamp,
      );
    sqlite.close();

    const unknown = await database.improvementApplications.dispatch(
      scenario.application.id,
    );
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.rollbacks.at(-1)?.state, "unknown");
    const priorReconciliationCount = unknown.reconciliations.length;
    const replay = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "command:rollback-unknown:reconcile",
      actor: {
        type: "human" as const,
        id: "human:improvement-owner",
        authenticatedBy: "local-session" as const,
      },
      command: {
        type: "improvement.application.rollback" as const,
        rollback: rollbackInput,
      },
    });
    assert.equal(replay.status, "succeeded");
    if (replay.status !== "succeeded") assert.fail("reconcile must succeed");
    assert.equal(replay.value.state, "reconciling");
    assert.equal(
      replay.value.reconciliations.length,
      priorReconciliationCount + 1,
    );
    const verifiedHumanReconciliation = replay.value.reconciliations.at(-1);
    assert.deepEqual(
      verifiedHumanReconciliation && {
        phase: verifiedHumanReconciliation.phase,
        result: verifiedHumanReconciliation.result,
        evidenceRefs: verifiedHumanReconciliation.evidenceRefs,
      },
      {
        phase: "rollback",
        result: "unknown",
        evidenceRefs: rollbackInput.evidenceRefs,
      },
    );
    const auditDatabase = new DatabaseSync(database.path);
    const reconciliationAudit = (
      auditDatabase
        .prepare(
          `SELECT action, actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy, after_json AS afterJson
           FROM runtime_audit_records
          WHERE entity_type = 'improvement-application'
            AND entity_id = ?
            AND action = 'improvement.application.reconcile'
       ORDER BY created_at, id`,
        )
        .all(scenario.application.id) as Array<{
        readonly action: string;
        readonly actorType: string;
        readonly actorId: string;
        readonly authenticatedBy: string;
        readonly afterJson: string;
      }>
    ).map((record) => ({ ...record }));
    auditDatabase.close();
    assert.deepEqual(reconciliationAudit, [
      {
        action: "improvement.application.reconcile",
        actorType: "human",
        actorId: "human:improvement-owner",
        authenticatedBy: "local-session",
        afterJson: canonicalJson({
          state: "reconciling",
          phase: "rollback",
          reason: rollbackInput.reason,
          evidenceRefs: rollbackInput.evidenceRefs,
        }),
      },
    ]);
    const stillUnknown = await database.improvementApplications.dispatch(
      scenario.application.id,
    );
    assert.equal(stillUnknown.state, "unknown");
    const after = new DatabaseSync(database.path);
    assert.equal(
      (
        after
          .prepare("SELECT COUNT(*) AS count FROM governed_harness_revisions")
          .get() as { readonly count: number }
      ).count,
      4,
    );
    after.close();
    database.close();
  });
});
