import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { ImprovementTarget } from "./improvementProposalContracts.js";

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

const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

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
  options: {
    readonly target?: (projectId: string) => ImprovementTarget;
    readonly rollbackSource?: {
      readonly revisionId: string;
      readonly revisionHash: string;
    };
  } = {},
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
    commandId: `command:adapter-freeze:${operationId}`,
    actor,
    command: {
      type: "statistics.evidence.freeze",
      evidenceSnapshotId: `statistics-evidence:adapter:${operationId}`,
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
  const governedTarget =
    options.target?.(project.id) ??
    ({
      ...target,
      content: { ...target.content, impactScope: [project.id] },
    } satisfies ImprovementTarget);
  const proposal = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:adapter-proposal:${operationId}`,
    actor,
    command: {
      type: "improvement.proposal.create",
      proposal: {
        proposalId: `improvement-proposal:adapter:${operationId}`,
        revisionId: `improvement-proposal-revision:adapter:${operationId}:1`,
        projectId: project.id,
        departmentId: null,
        content: {
          evidence: frozen.value,
          target: governedTarget,
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
          rollbackSource: options.rollbackSource ?? {
            revisionId: `${governedTarget.ownerId}:source`,
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
    commandId: `command:adapter-propose:${operationId}`,
    actor,
    command: {
      type: "improvement.proposal.propose",
      proposalId: proposal.value.id,
      proposalRevisionId: revision.id,
      expectedProposalRevisionHash: revision.hash,
    },
  });
  assert.equal(proposed.status, "succeeded");
  const confirmation = `I confirm this exact governed ${governedTarget.targetKind} revision.`;
  const requested = company.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `command:adapter-request-decision:${operationId}`,
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
    commandId: `command:adapter-approve:${operationId}`,
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
    commandId: `command:adapter-apply-intent:${operationId}`,
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
        confirmation: `I confirm applying this exact ${governedTarget.targetKind} revision.`,
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

  it("appends Project and Application Spec revisions without moving current pointers", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE project_specs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        product_baseline_id TEXT NOT NULL,
        current_revision_id TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_spec_revisions (
        id TEXT PRIMARY KEY,
        project_spec_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        product_baseline_id TEXT NOT NULL,
        product_baseline_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        supersedes_revision_id TEXT,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        producer_ai_member_id TEXT NOT NULL,
        producer_position_id TEXT NOT NULL,
        producer_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_spec_id, revision)
      ) STRICT;
      CREATE TABLE application_specs (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        current_revision_id TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE application_spec_revisions (
        id TEXT PRIMARY KEY,
        application_spec_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        promoted_project_spec_revision_id TEXT NOT NULL,
        promoted_project_spec_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        supersedes_revision_id TEXT,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        producer_ai_member_id TEXT NOT NULL,
        producer_position_id TEXT NOT NULL,
        producer_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(application_spec_id, revision)
      ) STRICT;
    `);
    const sourceProjectContent = {
      outcome: "Ship the accepted Project outcome.",
      acceptanceCriteria: ["The accepted outcome remains verifiable."],
      applicationBoundaries: ["application:checkout"],
      crossApplicationContracts: ["checkout-api@1"],
      deliveryConstraints: ["Remain local-first."],
    };
    const sourceProjectHash = hash(sourceProjectContent);
    sqlite
      .prepare(
        `INSERT INTO project_specs VALUES (
           'project-spec:checkout', 'project:checkout', 'run:checkout',
           'baseline:checkout', 'project-spec-revision:source', 1,
           '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
         )`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_spec_revisions VALUES (
           'project-spec-revision:source', 'project-spec:checkout',
           'project:checkout', 'run:checkout', 'baseline:checkout', ?, 1, NULL,
           ?, ?, 'member:product', 'position:product', 'session:product',
           '2026-08-04T00:00:00.000Z'
         )`,
      )
      .run(
        "a".repeat(64),
        canonicalJson(sourceProjectContent),
        sourceProjectHash,
      );
    const sourceApplicationContent = {
      design: "Use the accepted checkout contract.",
      acceptanceCriteria: ["Checkout requests are idempotent."],
      workPackageConstraints: ["Keep writes isolated."],
      integrationObligations: ["Produce checkout-api@1."],
      contractRefs: [{ id: "checkout-api", version: "1" }],
    };
    const sourceApplicationHash = hash({
      applicationId: "application:checkout",
      promotedProjectSpecRevisionId: "project-spec-revision:source",
      promotedProjectSpecHash: sourceProjectHash,
      content: sourceApplicationContent,
    });
    sqlite
      .prepare(
        `INSERT INTO application_specs VALUES (
           'application-spec:checkout', 'application:checkout', 'project:checkout',
           'run:checkout', 'application-spec-revision:source', 1,
           '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
         )`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions VALUES (
           'application-spec-revision:source', 'application-spec:checkout',
           'application:checkout', 'project:checkout', 'run:checkout',
           'project-spec-revision:source', ?, 1, NULL, ?, ?,
           'member:architect', 'position:architect', 'session:architect',
           '2026-08-04T00:00:00.000Z'
         )`,
      )
      .run(
        sourceProjectHash,
        canonicalJson(sourceApplicationContent),
        sourceApplicationHash,
      );

    const adapter = openSqliteGovernedRevisionAdapter(sqlite, {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const projectTarget = {
      targetKind: "project-spec" as const,
      ownerId: "project-spec:checkout",
      governedHead: {
        revisionId: "project-spec-revision:source",
        revisionHash: sourceProjectHash,
      },
      content: {
        ...sourceProjectContent,
        deliveryConstraints: ["Remain local-first.", "Retain exact evidence."],
      },
    };
    const projectApplied = await adapter.appendRevision({
      operationId: "improvement-application:project-spec",
      target: projectTarget,
      phase: "apply",
      expectedGovernedHead: projectTarget.governedHead,
    });
    assert.equal(projectApplied.disposition, "applied");
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT current_revision_id AS id FROM project_specs WHERE id = ?",
          )
          .get(projectTarget.ownerId) as { readonly id: string }
      ).id,
      "project-spec-revision:source",
    );
    const projectReplay = await adapter.appendRevision({
      operationId: "improvement-application:project-spec",
      target: projectTarget,
      phase: "apply",
      expectedGovernedHead: projectTarget.governedHead,
    });
    assert.equal(projectReplay.disposition, "no-op");
    const projectRestored = await adapter.appendRevision({
      operationId: "improvement-application:project-spec:rollback",
      target: { ...projectTarget, content: sourceProjectContent },
      phase: "rollback",
      expectedGovernedHead: projectApplied.revision,
    });
    assert.equal(projectRestored.disposition, "applied");
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT content_json AS contentJson FROM project_spec_revisions WHERE id = ?",
          )
          .get(projectRestored.revision.revisionId) as {
          readonly contentJson: string;
        }
      ).contentJson,
      canonicalJson(sourceProjectContent),
    );
    await assert.rejects(
      adapter.appendRevision({
        operationId: "improvement-application:project-spec:stale-head",
        target: projectTarget,
        phase: "apply",
        expectedGovernedHead: projectTarget.governedHead,
      }),
      (error: unknown) =>
        error instanceof GovernedRevisionAdapterError &&
        error.code === "IMPROVEMENT_TARGET_CONFLICT",
    );

    const applicationTarget = {
      targetKind: "application-spec" as const,
      ownerId: "application-spec:checkout",
      governedHead: {
        revisionId: "application-spec-revision:source",
        revisionHash: sourceApplicationHash,
      },
      content: {
        lineage: {
          projectId: "project:checkout",
          applicationId: "application:checkout",
          promotedProjectSpecRevisionId: "project-spec-revision:source",
          promotedProjectSpecHash: sourceProjectHash,
        },
        content: {
          ...sourceApplicationContent,
          workPackageConstraints: [
            "Keep writes isolated.",
            "Retain exact evidence.",
          ],
        },
      },
    };
    const applicationApplied = await adapter.appendRevision({
      operationId: "improvement-application:application-spec",
      target: applicationTarget,
      phase: "apply",
      expectedGovernedHead: applicationTarget.governedHead,
    });
    assert.equal(applicationApplied.disposition, "applied");
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT current_revision_id AS id FROM application_specs WHERE id = ?",
          )
          .get(applicationTarget.ownerId) as { readonly id: string }
      ).id,
      "application-spec-revision:source",
    );
    const applicationRestored = await adapter.appendRevision({
      operationId: "improvement-application:application-spec:rollback",
      target: {
        ...applicationTarget,
        content: {
          ...applicationTarget.content,
          content: sourceApplicationContent,
        },
      },
      phase: "rollback",
      expectedGovernedHead: applicationApplied.revision,
    });
    assert.equal(applicationRestored.disposition, "applied");
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT content_json AS contentJson FROM application_spec_revisions WHERE id = ?",
          )
          .get(applicationRestored.revision.revisionId) as {
          readonly contentJson: string;
        }
      ).contentJson,
      canonicalJson(sourceApplicationContent),
    );
    await assert.rejects(
      adapter.appendRevision({
        operationId: "improvement-application:application-spec:stale-head",
        target: applicationTarget,
        phase: "apply",
        expectedGovernedHead: applicationTarget.governedHead,
      }),
      (error: unknown) =>
        error instanceof GovernedRevisionAdapterError &&
        error.code === "IMPROVEMENT_TARGET_CONFLICT",
    );
    await assert.rejects(
      adapter.appendRevision({
        operationId: "improvement-application:application-spec:bad-lineage",
        target: {
          ...applicationTarget,
          content: {
            ...applicationTarget.content,
            lineage: {
              ...applicationTarget.content.lineage,
              promotedProjectSpecHash: "f".repeat(64),
            },
          },
        },
        phase: "apply",
        expectedGovernedHead: applicationRestored.revision,
      }),
      (error: unknown) =>
        error instanceof GovernedRevisionAdapterError &&
        error.code === "IMPROVEMENT_TARGET_CONFLICT",
    );
    sqlite.close();
  });

  it("appends and restores deterministic Runtime-owned template manifests", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-governed-template-adapter-"),
    );
    const company = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const sqlite = new DatabaseSync(company.path);
    try {
      const adapter = openSqliteGovernedRevisionAdapter(sqlite, {
        clock: () => new Date("2026-08-04T00:00:00.000Z"),
      });
      const sourceOperationId = "improvement-application:template:source";
      const sourceTarget = createApplyIntent(company, sourceOperationId, {
        target: () => ({
          targetKind: "template",
          ownerId: "template:software-rnd-review",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            manifest: [
              { path: "review/prompt.md", contentHash: "b".repeat(64) },
              { path: "review/rules.md", contentHash: "c".repeat(64) },
            ],
          },
        }),
      });
      if (sourceTarget.targetKind !== "template") {
        assert.fail("template source target must remain exact");
      }
      const source = await adapter.appendRevision({
        operationId: sourceOperationId,
        target: sourceTarget,
        phase: "apply",
        expectedGovernedHead: sourceTarget.governedHead,
      });
      assert.equal(
        source.revision.revisionHash,
        "0cc224c1b34ef960bdc3d87f10cbc158d54c645167bdcc9b159392e53fa16c96",
      );
      const applyOperationId = "improvement-application:template:change";
      const changedTarget = createApplyIntent(company, applyOperationId, {
        rollbackSource: source.revision,
        target: () => ({
          ...sourceTarget,
          governedHead: source.revision,
          content: {
            manifest: [
              { path: "review/prompt.md", contentHash: "d".repeat(64) },
              { path: "review/rules.md", contentHash: "c".repeat(64) },
            ],
          },
        }),
      });
      if (changedTarget.targetKind !== "template") {
        assert.fail("template changed target must remain exact");
      }
      const applied = await adapter.appendRevision({
        operationId: applyOperationId,
        target: changedTarget,
        phase: "apply",
        expectedGovernedHead: source.revision,
      });
      const replay = await adapter.appendRevision({
        operationId: applyOperationId,
        target: changedTarget,
        phase: "apply",
        expectedGovernedHead: source.revision,
      });
      assert.equal(replay.disposition, "no-op");
      const restored = await adapter.appendRevision({
        operationId: applyOperationId,
        target: { ...changedTarget, content: sourceTarget.content },
        phase: "rollback",
        expectedGovernedHead: applied.revision,
      });
      const revisions = sqlite
        .prepare(
          `SELECT id, manifest_json AS manifestJson, content_hash AS contentHash
             FROM runtime_template_revisions
            WHERE owner_id = ? ORDER BY revision`,
        )
        .all(sourceTarget.ownerId) as Array<{
        readonly id: string;
        readonly manifestJson: string;
        readonly contentHash: string;
      }>;
      assert.equal(revisions.length, 3);
      assert.equal(revisions[0]?.id, source.revision.revisionId);
      assert.equal(revisions[1]?.id, applied.revision.revisionId);
      assert.equal(revisions[2]?.id, restored.revision.revisionId);
      assert.equal(revisions[2]?.manifestJson, revisions[0]?.manifestJson);
      assert.equal(revisions[2]?.contentHash, revisions[0]?.contentHash);
      assert.notEqual(revisions[1]?.manifestJson, revisions[0]?.manifestJson);
    } finally {
      sqlite.close();
      company.close();
    }
  });

  it("validates governed Skill Flow revisions against Position-owned Skills without mutating the active flow", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-governed-skill-flow-adapter-"),
    );
    const company = openCompanyDatabase(companyDir, {
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const sqlite = new DatabaseSync(company.path);
    try {
      const position = sqlite
        .prepare(
          `SELECT position_id AS positionId
             FROM position_skill_bindings
         GROUP BY position_id
         ORDER BY position_id
            LIMIT 1`,
        )
        .get() as { readonly positionId: string } | undefined;
      if (!position) assert.fail("a seeded Position Skill binding is required");
      const skillIds = (
        sqlite
          .prepare(
            `SELECT skill_id AS skillId
               FROM position_skill_bindings
              WHERE position_id = ?
           ORDER BY skill_id
              LIMIT 2`,
          )
          .all(position.positionId) as Array<{ readonly skillId: string }>
      ).map((row) => row.skillId);
      assert.ok(skillIds.length > 0);
      const legacyFlowsBefore = sqlite
        .prepare("SELECT * FROM skill_flows ORDER BY id")
        .all();
      const legacySelectionsBefore = sqlite
        .prepare(
          "SELECT * FROM skill_flow_skills ORDER BY skill_flow_id, sort_order",
        )
        .all();
      const adapter = openSqliteGovernedRevisionAdapter(sqlite, {
        clock: () => new Date("2026-08-04T00:00:00.000Z"),
      });
      const sourceOperationId = "improvement-application:skill-flow:source";
      const sourceTarget = createApplyIntent(company, sourceOperationId, {
        target: () => ({
          targetKind: "skill-flow",
          ownerId: "governed-skill-flow:review",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            positionId: position.positionId,
            name: "Stable review",
            instructions: "Review exact immutable evidence.",
            skillIds,
          },
        }),
      });
      if (sourceTarget.targetKind !== "skill-flow") {
        assert.fail("Skill Flow source target must remain exact");
      }
      const source = await adapter.appendRevision({
        operationId: sourceOperationId,
        target: sourceTarget,
        phase: "apply",
        expectedGovernedHead: sourceTarget.governedHead,
      });
      const applyOperationId = "improvement-application:skill-flow:change";
      const changedTarget = createApplyIntent(company, applyOperationId, {
        rollbackSource: source.revision,
        target: () => ({
          ...sourceTarget,
          governedHead: source.revision,
          content: {
            ...sourceTarget.content,
            name: "Experimental review",
            instructions: "Review exact evidence and reconciliation state.",
          },
        }),
      });
      if (changedTarget.targetKind !== "skill-flow") {
        assert.fail("Skill Flow changed target must remain exact");
      }
      const applied = await adapter.appendRevision({
        operationId: applyOperationId,
        target: changedTarget,
        phase: "apply",
        expectedGovernedHead: source.revision,
      });
      const restored = await adapter.appendRevision({
        operationId: applyOperationId,
        target: { ...changedTarget, content: sourceTarget.content },
        phase: "rollback",
        expectedGovernedHead: applied.revision,
      });
      const revisions = sqlite
        .prepare(
          `SELECT id, position_id AS positionId, name, instructions,
                  skill_ids_json AS skillIdsJson, content_hash AS contentHash
             FROM governed_skill_flow_revisions
            WHERE owner_id = ? ORDER BY revision`,
        )
        .all(sourceTarget.ownerId) as Array<{
        readonly id: string;
        readonly positionId: string;
        readonly name: string;
        readonly instructions: string;
        readonly skillIdsJson: string;
        readonly contentHash: string;
      }>;
      assert.equal(revisions.length, 3);
      assert.equal(revisions[0]?.id, source.revision.revisionId);
      assert.equal(revisions[1]?.id, applied.revision.revisionId);
      assert.equal(revisions[2]?.id, restored.revision.revisionId);
      assert.equal(revisions[2]?.contentHash, revisions[0]?.contentHash);
      assert.equal(revisions[2]?.skillIdsJson, canonicalJson(skillIds));
      assert.deepEqual(
        sqlite.prepare("SELECT * FROM skill_flows ORDER BY id").all(),
        legacyFlowsBefore,
      );
      assert.deepEqual(
        sqlite
          .prepare(
            "SELECT * FROM skill_flow_skills ORDER BY skill_flow_id, sort_order",
          )
          .all(),
        legacySelectionsBefore,
      );

      const invalidOperationId =
        "improvement-application:skill-flow:unbound-skill";
      const invalidTarget = createApplyIntent(company, invalidOperationId, {
        target: () => ({
          ...sourceTarget,
          ownerId: "governed-skill-flow:invalid",
          governedHead: { revisionId: null, revisionHash: null },
          content: {
            ...sourceTarget.content,
            skillIds: ["skill:not-bound-to-position"],
          },
        }),
      });
      await assert.rejects(
        adapter.appendRevision({
          operationId: invalidOperationId,
          target: invalidTarget,
          phase: "apply",
          expectedGovernedHead: invalidTarget.governedHead,
        }),
        (error: unknown) =>
          error instanceof GovernedRevisionAdapterError &&
          error.code === "IMPROVEMENT_TARGET_CONFLICT",
      );
    } finally {
      sqlite.close();
      company.close();
    }
  });
});
