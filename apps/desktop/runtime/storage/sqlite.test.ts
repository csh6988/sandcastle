import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  CURRENT_SCHEMA_VERSION,
  migrateCompanyDatabase,
} from "./migrations.js";
import { openCompanyDatabase, restoreCompanyDatabase } from "./sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-database-"));

const removeImmutableArtifactContentKinds = (database: DatabaseSync): void => {
  const hasProductBaselineColumn = database
    .prepare("PRAGMA table_info(department_runs)")
    .all()
    .some(
      (column) =>
        (column as { readonly name?: unknown }).name === "product_baseline_id",
    );
  database.exec(`
    DROP TRIGGER IF EXISTS product_baselines_immutable_update;
    DROP TRIGGER IF EXISTS product_baselines_immutable_delete;
    DROP INDEX IF EXISTS department_runs_product_baseline_idx;
    DROP TABLE IF EXISTS runtime_run_quarantines;
  `);
  if (hasProductBaselineColumn) {
    database.exec(
      "ALTER TABLE department_runs DROP COLUMN product_baseline_id",
    );
  }
  database.exec(`
    DROP TABLE IF EXISTS product_baselines;
    DROP INDEX IF EXISTS product_proposal_revisions_proposal_idx;
    DROP TABLE IF EXISTS product_proposal_revisions;
    DROP TABLE IF EXISTS product_proposals;
  `);
  database.exec(`
    DROP INDEX artifact_links_to_idx;
    DROP TABLE artifact_supersessions;
    DROP INDEX artifact_integrity_observations_version_idx;
    DROP TABLE artifact_integrity_observations;
    DROP TABLE artifact_write_journal;
    DROP INDEX artifact_registrations_dedup_idx;
    DROP TABLE artifact_registrations;
    ALTER TABLE artifact_versions DROP COLUMN finalized_at;
    ALTER TABLE artifact_versions DROP COLUMN registration_id;
    ALTER TABLE artifact_versions DROP COLUMN integrity_descriptor_json;
    ALTER TABLE artifact_versions DROP COLUMN producer_context_hash;
    ALTER TABLE artifact_versions DROP COLUMN producer_context_json;
    ALTER TABLE artifact_versions DROP COLUMN identity_hash;
    ALTER TABLE artifact_versions DROP COLUMN canonical_identity_json;
    ALTER TABLE artifact_versions DROP COLUMN content_kind;
  `);
};

const removeArtifactRegistry = (database: DatabaseSync): void => {
  removeImmutableArtifactContentKinds(database);
  database.exec(`
    DROP TABLE artifact_links;
    DROP INDEX artifact_versions_run_idx;
    DROP TABLE artifact_versions;
    ALTER TABLE artifacts DROP COLUMN schema_version;
  `);
};

const removeForkRunLinks = (database: DatabaseSync): void => {
  database.exec(`
    DROP INDEX department_runs_parent_idx;
    ALTER TABLE node_runs DROP COLUMN source_node_run_id;
    ALTER TABLE department_runs DROP COLUMN parent_run_id;
    ALTER TABLE department_runs DROP COLUMN forked_from_snapshot_revision_id;
  `);
};

const removeInteraction = (database: DatabaseSync): void => {
  database.exec(`
    DROP TRIGGER IF EXISTS interaction_turn_delete_leases;
    DROP TRIGGER IF EXISTS node_attempt_delete_execution_leases;
    DROP TRIGGER IF EXISTS execution_leases_target_guard;
    DROP INDEX IF EXISTS interaction_turns_active_session_idx;
    DROP INDEX IF EXISTS interaction_turns_session_idx;
    DROP TABLE IF EXISTS interaction_turns;
    DROP TABLE IF EXISTS permission_decisions;
    DROP INDEX permission_requests_session_idx;
    DROP TABLE permission_requests;
    DROP INDEX session_messages_session_idx;
    DROP TABLE session_messages;
    DROP TABLE session_participants;
    DROP INDEX interaction_sessions_project_idx;
    DROP TABLE interaction_sessions;
  `);
};

const removeMemory = (database: DatabaseSync): void => {
  database.exec(`
    DROP TABLE memory_records;
    DROP INDEX memory_candidates_project_idx;
    DROP TABLE memory_candidates;
  `);
};

const removeReviewTopics = (database: DatabaseSync): void => {
  database.exec(`
    DROP TRIGGER IF EXISTS quality_gate_results_immutable_delete;
    DROP TRIGGER IF EXISTS quality_gate_results_immutable_update;
    DROP TRIGGER IF EXISTS review_rechecks_immutable_delete;
    DROP TRIGGER IF EXISTS review_rechecks_immutable_update;
    DROP TRIGGER IF EXISTS review_revisions_immutable_delete;
    DROP TRIGGER IF EXISTS review_revisions_immutable_update;
    DROP TRIGGER IF EXISTS review_resolutions_immutable_delete;
    DROP TRIGGER IF EXISTS review_resolutions_immutable_update;
    DROP TRIGGER IF EXISTS review_findings_immutable_delete;
    DROP TRIGGER IF EXISTS review_findings_immutable_update;
    DROP TABLE IF EXISTS quality_gate_results;
    DROP TABLE IF EXISTS review_rechecks;
    DROP INDEX IF EXISTS review_revisions_topic_idx;
    DROP TABLE IF EXISTS review_revisions;
    DROP TABLE IF EXISTS review_discussions;
    DROP INDEX IF EXISTS review_resolutions_finding_idx;
    DROP TABLE IF EXISTS review_resolutions;
    DROP INDEX IF EXISTS review_findings_topic_idx;
    DROP TABLE IF EXISTS review_findings;
    DROP INDEX IF EXISTS review_participants_topic_role_idx;
    DROP TABLE IF EXISTS review_participants;
    DROP INDEX IF EXISTS review_topics_run_idx;
    DROP INDEX IF EXISTS review_topics_project_idx;
    DROP TABLE IF EXISTS review_topics;
    DELETE FROM schema_migrations WHERE version = 33;
    UPDATE schema_metadata SET value = '32' WHERE key = 'schema_version';
  `);
};

const removeProductReview = (database: DatabaseSync): void => {
  database.exec(`
    DROP TRIGGER IF EXISTS product_gate_promotions_immutable_delete;
    DROP TRIGGER IF EXISTS product_gate_promotions_immutable_update;
    DROP TABLE IF EXISTS product_gate_promotions;
    DROP TRIGGER IF EXISTS product_readiness_evidence_immutable_delete;
    DROP TRIGGER IF EXISTS product_readiness_evidence_immutable_update;
    DROP INDEX IF EXISTS product_readiness_evidence_run_idx;
    DROP TABLE IF EXISTS product_readiness_evidence;
    DROP TRIGGER IF EXISTS project_spec_revisions_immutable_delete;
    DROP TRIGGER IF EXISTS project_spec_revisions_immutable_update;
    DROP INDEX IF EXISTS project_spec_revisions_run_idx;
    DROP TABLE IF EXISTS project_spec_revisions;
    DROP TABLE IF EXISTS project_specs;
    ALTER TABLE review_findings DROP COLUMN scope_impact;
    DELETE FROM schema_migrations WHERE version = 34;
    UPDATE schema_metadata SET value = '33' WHERE key = 'schema_version';
    PRAGMA user_version = 33;
  `);
};

const removeDurableRuntimeEventSubscriptions = (
  database: DatabaseSync,
): void => {
  database.exec(`
    DROP INDEX IF EXISTS consumed_view_sync_tokens_expiry_idx;
    DROP TABLE IF EXISTS consumed_view_sync_tokens;
    DROP INDEX IF EXISTS runtime_event_cursors_active_subscription_idx;
    ALTER TABLE runtime_event_cursors DROP COLUMN retired_at;
    ALTER TABLE runtime_event_cursors DROP COLUMN expires_at;
    ALTER TABLE runtime_event_cursors DROP COLUMN last_seen_at;
    ALTER TABLE runtime_event_cursors DROP COLUMN barrier_sequence;
    ALTER TABLE runtime_event_cursors DROP COLUMN last_delivered_sequence;
    ALTER TABLE runtime_event_cursors DROP COLUMN subscription_generation;
    ALTER TABLE runtime_event_cursors DROP COLUMN active_subscription_id;
    ALTER TABLE runtime_event_cursors DROP COLUMN owner_principal_json;
    ALTER TABLE runtime_event_outbox DROP COLUMN scope_json;
    ALTER TABLE runtime_event_outbox DROP COLUMN project_id;
    ALTER TABLE runtime_event_outbox DROP COLUMN company_id;
    ALTER TABLE runtime_event_outbox DROP COLUMN event_schema_version;
    ALTER TABLE runtime_event_outbox DROP COLUMN registry_version;
  `);
};

const removeCatalogAuditTriggers = (database: DatabaseSync): void => {
  removeDurableRuntimeEventSubscriptions(database);
  const triggers = database
    .prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'trigger'
          AND name LIKE 'runtime_%'
          AND name NOT LIKE 'runtime_template_revisions_%'`,
    )
    .all() as Array<{ readonly name: string }>;
  for (const trigger of triggers) {
    database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  }
};

const removeNodeAttemptLeases = (database: DatabaseSync): void => {
  database.exec(`
    DROP INDEX node_attempts_ready_lease_idx;
    ALTER TABLE node_attempts DROP COLUMN lease_id;
    ALTER TABLE node_attempts DROP COLUMN lease_owner;
    ALTER TABLE node_attempts DROP COLUMN lease_expires_at;
    ALTER TABLE node_attempts DROP COLUMN checkpoint_json;
    ALTER TABLE node_attempts DROP COLUMN recoverable;
  `);
};

const removeRecoveryAttemptReason = (database: DatabaseSync): void => {
  removeImmutableArtifactContentKinds(database);
  removeDurableRuntimeEventSubscriptions(database);
  database.exec(`
    DROP TRIGGER IF EXISTS interaction_turn_delete_leases;
    DROP TRIGGER IF EXISTS node_attempt_delete_execution_leases;
    DROP TRIGGER IF EXISTS execution_leases_target_guard;
    DROP TABLE IF EXISTS interaction_turns;
    DROP TABLE permission_decisions;
    DROP TABLE execution_facts;
    DROP TABLE execution_leases;
    DROP INDEX node_attempts_execution_operation_idx;
    CREATE TABLE node_attempts_v17 (
      id TEXT PRIMARY KEY,
      node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
      reason TEXT NOT NULL CHECK (
        reason IN ('initial', 'request-changes', 'retry')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('ready', 'running', 'succeeded', 'failed', 'cancelled')
      ),
      structured_result_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      lease_id TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      checkpoint_json TEXT,
      recoverable INTEGER NOT NULL DEFAULT 0 CHECK (recoverable IN (0, 1)),
      UNIQUE (node_run_id, attempt_number)
    ) STRICT;
    INSERT INTO node_attempts_v17 (
      id,
      node_run_id,
      attempt_number,
      snapshot_revision_id,
      reason,
      status,
      structured_result_json,
      failure_code,
      failure_message,
      created_at,
      started_at,
      completed_at,
      lease_id,
      lease_owner,
      lease_expires_at,
      checkpoint_json,
      recoverable
    )
    SELECT
      id,
      node_run_id,
      attempt_number,
      snapshot_revision_id,
      reason,
      status,
      structured_result_json,
      failure_code,
      failure_message,
      created_at,
      started_at,
      completed_at,
      lease_id,
      lease_owner,
      lease_expires_at,
      checkpoint_json,
      recoverable
    FROM node_attempts;
    DROP INDEX node_attempts_node_run_idx;
    DROP INDEX node_attempts_ready_lease_idx;
    DROP TABLE node_attempts;
    ALTER TABLE node_attempts_v17 RENAME TO node_attempts;
    CREATE INDEX node_attempts_node_run_idx
      ON node_attempts(node_run_id, attempt_number);
    CREATE INDEX node_attempts_ready_lease_idx
      ON node_attempts(node_run_id, status, lease_expires_at);
  `);
};

const removeDepartmentRunControls = (database: DatabaseSync): void => {
  database.exec(`
    ALTER TABLE department_runs DROP COLUMN paused_from_status;
  `);
};

const removeSnapshotRevisionParentLinks = (database: DatabaseSync): void => {
  removeCatalogAuditTriggers(database);
  removeMemory(database);
  removeInteraction(database);
  removeForkRunLinks(database);
  removeArtifactRegistry(database);
  database.exec(`
    DROP INDEX runtime_event_outbox_pending_idx;
    DROP TABLE runtime_event_cursors;
    DROP TABLE runtime_event_outbox;
    DROP INDEX runtime_audit_run_idx;
    DROP TABLE runtime_audit_records;
  `);
  database.exec(
    "ALTER TABLE run_snapshot_revisions DROP COLUMN parent_revision",
  );
};

const removeNodeAttemptRecovery = (database: DatabaseSync): void => {
  database.exec(`
    DROP TABLE IF EXISTS governed_interventions;
    DROP TABLE node_feedback;
    DROP TABLE approvals;
    DROP TABLE node_attempts;
  `);
};

const removePipelineRuntime = (database: DatabaseSync): void => {
  removeCatalogAuditTriggers(database);
  removeMemory(database);
  removeInteraction(database);
  removeForkRunLinks(database);
  removeArtifactRegistry(database);
  database.exec(`
    DROP INDEX runtime_event_outbox_pending_idx;
    DROP TABLE runtime_event_cursors;
    DROP TABLE runtime_event_outbox;
    DROP INDEX runtime_audit_run_idx;
    DROP TABLE runtime_audit_records;
  `);
  removeDepartmentRunControls(database);
  removeNodeAttemptRecovery(database);
  database.exec(`
    DROP INDEX department_runs_project_created_idx;
    DROP TABLE node_runs;
    DROP TABLE run_snapshot_revisions;
    ALTER TABLE department_runs DROP COLUMN pipeline_version_id;
    ALTER TABLE department_runs DROP COLUMN snapshot_revision_id;
    ALTER TABLE department_runs DROP COLUMN revision;
    ALTER TABLE department_runs DROP COLUMN updated_at;
  `);
};

const removePhaseOneCompanyConfiguration = (database: DatabaseSync): void => {
  removePipelineRuntime(database);
  database.exec(`
    DROP TABLE execution_profile_secret_references;
    DROP TABLE execution_profiles;
    DROP TABLE secret_references;
    ALTER TABLE ai_members DROP COLUMN profile;
    ALTER TABLE ai_members DROP COLUMN responsibility_metadata_json;
    ALTER TABLE positions DROP COLUMN revision;
    ALTER TABLE positions DROP COLUMN status;
    ALTER TABLE departments DROP COLUMN revision;
    ALTER TABLE departments DROP COLUMN input_artifact_contracts_json;
    ALTER TABLE departments DROP COLUMN output_artifact_contracts_json;
    ALTER TABLE departments DROP COLUMN default_execution_profile_id;
    UPDATE ai_members SET status = 'available' WHERE status = 'active';
  `);
};

describe("Company database migrations", () => {
  it("migrates a schema version zero database to the current version", () => {
    const companyDir = tempCompanyDir();
    const databasePath = join(companyDir, ".sandcastle", "company.sqlite");
    mkdirSync(join(companyDir, ".sandcastle"), { recursive: true });
    const bootstrap = new DatabaseSync(databasePath);
    bootstrap.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '0');
    `);
    bootstrap.close();

    const database = openCompanyDatabase(companyDir);

    try {
      assert.equal(database.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(database.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              "SELECT version, name FROM schema_migrations ORDER BY version",
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { version: 1, name: "initial_schema" },
            { version: 2, name: "company_overview_read_model" },
            { version: 3, name: "software_rnd_department_catalog" },
            { version: 4, name: "pipeline_drafts_and_version_hashes" },
            { version: 5, name: "project_configuration" },
            { version: 6, name: "skill_configuration" },
            { version: 7, name: "phase_one_company_configuration" },
            { version: 8, name: "pipeline_runtime_r1" },
            { version: 9, name: "node_attempt_recovery" },
            { version: 10, name: "node_attempt_leases" },
            { version: 11, name: "department_run_controls" },
            { version: 12, name: "snapshot_revision_parent_links" },
            { version: 13, name: "runtime_audit_and_event_outbox" },
            { version: 14, name: "artifact_versions_and_lineage" },
            { version: 15, name: "fork_run_links" },
            { version: 16, name: "interaction_sessions_permissions" },
            { version: 17, name: "memory_candidates_and_records" },
            { version: 18, name: "node_attempt_recovery_reason" },
            { version: 19, name: "catalog_runtime_audit_triggers" },
            {
              version: 20,
              name: "software_rnd_production_skill_flows",
            },
            { version: 21, name: "local_agent_detection_results" },
            { version: 22, name: "position_default_agent_bindings" },
            { version: 23, name: "local_skill_discovery_catalog" },
            { version: 24, name: "command_envelopes_and_receipts" },
            {
              version: 25,
              name: "durable_runtime_event_subscriptions",
            },
            { version: 26, name: "immutable_artifact_content_kinds" },
            { version: 27, name: "product_proposal_lifecycle" },
            { version: 28, name: "product_baseline_formal_run" },
            { version: 29, name: "versioned_pipeline_node_handlers" },
            { version: 30, name: "fenced_execution_facts" },
            {
              version: 31,
              name: "interaction_turns_and_execution_targets",
            },
            { version: 32, name: "execution_reconciliation_states" },
            { version: 33, name: "review_topics_and_quality_gates" },
            { version: 34, name: "project_spec_revisions" },
            { version: 35, name: "application_references" },
            { version: 36, name: "application_spec_revisions" },
            { version: 37, name: "technical_baseline_proposals" },
            { version: 38, name: "accepted_technical_baselines" },
            {
              version: 39,
              name: "local_isolated_git_workspace_imports",
            },
            { version: 40, name: "governed_run_interventions" },
            {
              version: 41,
              name: "reviewed_memory_candidates_entries_and_snapshot_selections",
            },
            { version: 42, name: "work_package_execution" },
            {
              version: 43,
              name: "independent_code_review_authority",
            },
            {
              version: 44,
              name: "durable_code_review_execution",
            },
            {
              version: 45,
              name: "immutable_exact_code_review_execution_evidence",
            },
            {
              version: 46,
              name: "multi_repository_integration_generations",
            },
            {
              version: 47,
              name: "versioned_test_cases_and_runs",
            },
            {
              version: 48,
              name: "test_rework_resolution_authority",
            },
            {
              version: 49,
              name: "frozen_delivery_candidate_quality_gates",
            },
            {
              version: 50,
              name: "delivery_candidates_and_human_release",
            },
            {
              version: 51,
              name: "idempotent_release_operations",
            },
            {
              version: 52,
              name: "improvement_proposal_foundation",
            },
          ],
        );
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'table'
                 AND name IN ('execution_leases', 'execution_facts', 'permission_decisions')
               ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "execution_facts" },
            { name: "execution_leases" },
            { name: "permission_decisions" },
          ],
        );
        assert.equal(
          inspected
            .prepare("PRAGMA table_info(node_attempts)")
            .all()
            .some(
              (row) =>
                (row as { name: string }).name === "execution_operation_key",
            ),
          true,
        );
        assert.equal(
          inspected
            .prepare("PRAGMA table_info(node_attempts)")
            .all()
            .some(
              (row) =>
                (row as { name: string }).name === "terminal_execution_fact_id",
            ),
          true,
        );
        assert.equal(
          (
            inspected.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
          CURRENT_SCHEMA_VERSION,
        );
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'table'
                 AND name IN ('node_attempts', 'node_feedback', 'approvals')
               ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "approvals" },
            { name: "node_attempts" },
            { name: "node_feedback" },
          ],
        );
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'table'
                 AND name IN (
                   'command_deduplication',
                   'runtime_audit_records',
                   'runtime_event_outbox',
                   'runtime_event_cursors',
                   'runtime_unit_of_work_context'
                 )
               ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "command_deduplication" },
            { name: "runtime_audit_records" },
            { name: "runtime_event_cursors" },
            { name: "runtime_event_outbox" },
            { name: "runtime_unit_of_work_context" },
          ],
        );
      } finally {
        inspected.close();
      }
    } finally {
      database.close();
    }
  });

  it("upgrades a v32 database with immutable Review Topic storage", () => {
    const companyDir = tempCompanyDir();
    const initial = openCompanyDatabase(companyDir);
    const path = initial.path;
    initial.close();
    const old = new DatabaseSync(path);
    removeReviewTopics(old);
    old.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(upgraded.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
                WHERE type = 'table' AND name IN (
                  'review_topics', 'review_participants', 'review_findings',
                  'review_resolutions', 'review_discussions',
                  'review_revisions', 'review_rechecks',
                  'quality_gate_results'
                ) ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "quality_gate_results" },
            { name: "review_discussions" },
            { name: "review_findings" },
            { name: "review_participants" },
            { name: "review_rechecks" },
            { name: "review_resolutions" },
            { name: "review_revisions" },
            { name: "review_topics" },
          ],
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a v33 database with immutable Product Spec, readiness, and promotion storage", () => {
    const companyDir = tempCompanyDir();
    const initial = openCompanyDatabase(companyDir);
    const path = initial.path;
    initial.close();
    const old = new DatabaseSync(path);
    removeProductReview(old);
    old.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(upgraded.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
                WHERE type = 'table' AND name IN (
                  'project_specs', 'project_spec_revisions',
                  'product_readiness_evidence', 'product_gate_promotions'
                ) ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "product_gate_promotions" },
            { name: "product_readiness_evidence" },
            { name: "project_spec_revisions" },
            { name: "project_specs" },
          ],
        );
        assert.equal(
          inspected
            .prepare("PRAGMA table_info(review_findings)")
            .all()
            .some((row) => (row as { name: string }).name === "scope_impact"),
          true,
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a schema version 23 database with command receipt and trigger context storage", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();

    const versionTwentyThree = new DatabaseSync(databasePath);
    removeImmutableArtifactContentKinds(versionTwentyThree);
    removeCatalogAuditTriggers(versionTwentyThree);
    versionTwentyThree.exec(`
      DROP TABLE command_deduplication;
      DROP TABLE runtime_unit_of_work_context;
      ALTER TABLE runtime_audit_records DROP COLUMN command_id;
      ALTER TABLE runtime_audit_records DROP COLUMN actor_type;
      ALTER TABLE runtime_audit_records DROP COLUMN actor_id;
      ALTER TABLE runtime_audit_records DROP COLUMN authenticated_by;
      ALTER TABLE runtime_audit_records DROP COLUMN consumer_id;
      UPDATE schema_metadata SET value = '23' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 24;
      PRAGMA user_version = 23;
    `);
    versionTwentyThree.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(migrated.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'table'
                 AND name IN ('command_deduplication', 'runtime_unit_of_work_context')
               ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "command_deduplication" },
            { name: "runtime_unit_of_work_context" },
          ],
        );
        assert.equal(
          inspected
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'runtime_projects_updated'",
            )
            .get() !== undefined,
          true,
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("upgrades a schema version 25 Artifact Version with immutable content identity and integrity evidence", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const project = current.catalog.createProject({
      name: "Legacy Artifact",
      goal: "Preserve an Artifact Version across schema migration",
    });
    const databasePath = current.path;
    current.close();

    const content = Buffer.from("legacy artifact payload");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const contentRef = ".sandcastle/artifacts/legacy/version.bin";
    mkdirSync(join(companyDir, ".sandcastle", "artifacts", "legacy"), {
      recursive: true,
    });
    writeFileSync(join(companyDir, contentRef), content);

    const versionTwentyFive = new DatabaseSync(databasePath);
    removeImmutableArtifactContentKinds(versionTwentyFive);
    versionTwentyFive.exec(`
      UPDATE schema_metadata SET value = '25' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 26;
      PRAGMA user_version = 25;
    `);
    versionTwentyFive
      .prepare(
        `INSERT INTO artifacts(
           id, project_id, type, logical_name, status, schema_version, created_at
         ) VALUES (?, ?, 'evidence', 'legacy', 'active', '1', ?)`,
      )
      .run("legacy-artifact", project.id, "2026-07-23T00:00:00.000Z");
    versionTwentyFive
      .prepare(
        `INSERT INTO artifact_versions(
           id, artifact_id, version, content_ref, content_hash, byte_size,
           status, producing_run_id, producing_node_run_id,
           producing_node_attempt_id, snapshot_revision_id, ai_member_id,
           created_at
         ) VALUES (?, ?, 1, ?, ?, ?, 'produced', NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        "legacy-artifact-version",
        "legacy-artifact",
        contentRef,
        contentHash,
        content.byteLength,
        "2026-07-23T00:00:00.000Z",
      );
    versionTwentyFive.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const version = migrated.artifactRegistry.inspect(
        "legacy-artifact-version",
      ).version;
      assert.equal(version.contentKind, "managed-file");
      assert.equal(version.integrityStatus, "verified");
      assert.equal(version.contentRef, contentRef);

      const inspected = new DatabaseSync(migrated.path);
      try {
        const row = inspected
          .prepare(
            `SELECT content_kind AS contentKind,
                    canonical_identity_json AS canonicalIdentityJson,
                    identity_hash AS identityHash,
                    producer_context_json AS producerContextJson,
                    producer_context_hash AS producerContextHash,
                    integrity_descriptor_json AS integrityDescriptorJson,
                    finalized_at AS finalizedAt
               FROM artifact_versions
              WHERE id = ?`,
          )
          .get("legacy-artifact-version") as {
          readonly contentKind: string;
          readonly canonicalIdentityJson: string;
          readonly identityHash: string;
          readonly producerContextJson: string;
          readonly producerContextHash: string;
          readonly integrityDescriptorJson: string;
          readonly finalizedAt: string;
        };
        assert.equal(row.contentKind, "managed-file");
        assert.deepEqual(JSON.parse(row.canonicalIdentityJson), {
          kind: "managed-file",
          contentHash,
          byteSize: content.byteLength,
          storageRef: contentRef,
        });
        assert.equal(row.identityHash.length, 64);
        assert.notEqual(row.identityHash, "0".repeat(64));
        assert.deepEqual(JSON.parse(row.producerContextJson), {});
        assert.equal(row.producerContextHash.length, 64);
        assert.notEqual(row.producerContextHash, "0".repeat(64));
        assert.deepEqual(JSON.parse(row.integrityDescriptorJson), {
          algorithm: "sha256",
          digest: contentHash,
          byteSize: content.byteLength,
        });
        assert.equal(row.finalizedAt, "2026-07-23T00:00:00.000Z");
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT status, evidence_json AS evidenceJson
                 FROM artifact_integrity_observations
                WHERE artifact_version_id = ?`,
            )
            .all("legacy-artifact-version")
            .map((observation) => ({ ...observation })),
          [
            {
              status: "verified",
              evidenceJson: JSON.stringify({
                source: "schema-migration-26",
              }),
            },
          ],
        );
        assert.equal(
          (
            inspected.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
          CURRENT_SCHEMA_VERSION,
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("migrates a schema version two database without losing existing Company data", () => {
    const companyDir = tempCompanyDir();
    const databasePath = join(companyDir, ".sandcastle", "company.sqlite");
    mkdirSync(join(companyDir, ".sandcastle"), { recursive: true });
    const bootstrap = new DatabaseSync(databasePath);
    bootstrap.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE company_profile (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_locale TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES company_profile(id),
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE departments (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES company_profile(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE department_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        department_id TEXT NOT NULL REFERENCES departments(id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        type TEXT NOT NULL,
        logical_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '2');
      INSERT INTO company_profile(id, name, default_locale, created_at)
        VALUES ('company', 'Existing Company', 'en', '2026-07-13T00:00:00.000Z');
      INSERT INTO departments(id, company_id, name, status, created_at)
        VALUES ('existing-department', 'company', 'Existing', 'active', '2026-07-13T00:00:00.000Z');
      PRAGMA user_version = 2;
    `);
    bootstrap.close();

    const database = openCompanyDatabase(companyDir);
    try {
      assert.equal(database.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.equal(
        database.catalog.inspectDepartment("existing-department").name,
        "Existing",
      );
      assert.equal(
        database.pipelineConfiguration.inspect("software-rnd").published
          ?.version,
        2,
      );
    } finally {
      database.close();
    }
  });

  it("migrates schema version three with a deterministic Software R&D v1 hash", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();
    const versionThree = new DatabaseSync(databasePath);
    removePhaseOneCompanyConfiguration(versionThree);
    versionThree.exec(`
      DROP TABLE skill_flow_skills;
      DROP TABLE skill_flows;
      DROP TABLE position_skill_bindings;
      DROP TABLE skills;
      DROP TABLE skill_configuration_metadata;
      DROP TABLE project_repository_references;
      ALTER TABLE projects DROP COLUMN shared_context;
      ALTER TABLE projects DROP COLUMN revision;
      DROP TABLE pipeline_drafts;
      ALTER TABLE pipeline_versions RENAME TO pipeline_versions_v4;
      CREATE TABLE pipeline_versions (
        id TEXT PRIMARY KEY,
        department_id TEXT NOT NULL REFERENCES departments(id),
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE (department_id, version)
      ) STRICT;
      INSERT INTO pipeline_versions(
        id, department_id, version, status, graph_json, published_at
      )
      SELECT id, department_id, version, status, graph_json, published_at
        FROM pipeline_versions_v4;
      DROP TABLE pipeline_versions_v4;
      UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version';
      DELETE FROM pipeline_versions WHERE version > 1;
      UPDATE departments
         SET active_pipeline_version_id = 'software-rnd-pipeline-v1'
       WHERE id = 'software-rnd';
      DELETE FROM schema_migrations WHERE version >= 4;
      PRAGMA user_version = 3;
    `);
    versionThree.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      const pipeline =
        migrated.pipelineConfiguration.inspect("software-rnd").published;
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.equal(
        pipeline?.hash,
        "bceeae6c19bab660551f35f602d07bab10c6a93388556346cc19f6fbb748acdb",
      );
      assert.equal(pipeline?.version, 2);
      assert.equal(
        migrated.pipelineConfiguration.inspect("software-rnd").history.at(-1)
          ?.hash,
        "a93da93517d3496a79e3ab43002081d634fbb8dfb485e487180c055f0149f337",
      );
    } finally {
      migrated.close();
    }
  });

  it("migrates schema version four without losing existing Project data", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const project = current.catalog.createProject({
      name: "Existing Project",
      goal: "Survive the Project Configuration migration",
    });
    const databasePath = current.path;
    current.close();
    const versionFour = new DatabaseSync(databasePath);
    removePhaseOneCompanyConfiguration(versionFour);
    versionFour.exec(`
      DROP TABLE skill_flow_skills;
      DROP TABLE skill_flows;
      DROP TABLE position_skill_bindings;
      DROP TABLE skills;
      DROP TABLE skill_configuration_metadata;
      DROP TABLE project_repository_references;
      ALTER TABLE projects DROP COLUMN shared_context;
      ALTER TABLE projects DROP COLUMN revision;
      UPDATE schema_metadata SET value = '4' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version >= 5;
      PRAGMA user_version = 4;
    `);
    versionFour.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.deepEqual(migrated.projectConfiguration.inspect(project.id), {
        id: project.id,
        name: "Existing Project",
        goal: "Survive the Project Configuration migration",
        status: "active",
        revision: 0,
        sharedContext: "",
        repositoryReferences: [],
        departmentRuns: [],
        createdAt: project.createdAt,
      });
    } finally {
      migrated.close();
    }
  });

  it("migrates schema version five with the persistent Skill Configuration catalog", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();
    const versionFive = new DatabaseSync(databasePath);
    removePhaseOneCompanyConfiguration(versionFive);
    versionFive.exec(`
      DROP TABLE skill_flow_skills;
      DROP TABLE skill_flows;
      DROP TABLE position_skill_bindings;
      DROP TABLE skills;
      DROP TABLE skill_configuration_metadata;
      UPDATE schema_metadata SET value = '5' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 6;
      PRAGMA user_version = 5;
    `);
    versionFive.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      const configuration = migrated.skillConfiguration.inspect("software-rnd");
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.equal(configuration.revision, 0);
      assert.equal(configuration.activeSkills.length, 7);
      assert.equal(configuration.skillFlows.length, 5);
      assert.deepEqual(
        configuration.positions.find(
          (position) => position.id === "software-engineer",
        )?.skillIds,
        ["diagnosing-bugs", "tdd"],
      );
    } finally {
      migrated.close();
    }
  });

  it("migrates schema version six with safe Phase 1 configuration defaults", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();
    const versionSix = new DatabaseSync(databasePath);
    removePhaseOneCompanyConfiguration(versionSix);
    versionSix.exec(`
      UPDATE schema_metadata SET value = '6' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 7;
      PRAGMA user_version = 6;
    `);
    versionSix.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      const department = migrated.catalog.inspectDepartment("software-rnd");
      const engineer = department.positions.find(
        (position) => position.id === "software-engineer",
      );

      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.equal(department.revision, 0);
      assert.deepEqual(department.inputArtifactContracts, []);
      assert.deepEqual(department.outputArtifactContracts, []);
      assert.equal(
        department.defaultExecutionProfileId,
        "software-rnd-default",
      );
      assert.equal(engineer?.revision, 0);
      assert.equal(engineer?.status, "active");
      assert.equal(engineer?.aiMember.status, "active");
      assert.equal(engineer?.aiMember.profile, "");
      assert.deepEqual(engineer?.aiMember.responsibilityMetadata, {});
    } finally {
      migrated.close();
    }
  });

  it("migrates schema version seven without changing frozen Pipeline configuration", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    const before = current.pipelineConfiguration.inspect("software-rnd");
    const departmentBefore = current.catalog.inspectDepartment("software-rnd");
    current.close();

    const versionSeven = new DatabaseSync(databasePath);
    removePipelineRuntime(versionSeven);
    versionSeven.exec(`
      UPDATE schema_metadata SET value = '7' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 8;
      PRAGMA user_version = 7;
    `);
    versionSeven.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      const after = migrated.pipelineConfiguration.inspect("software-rnd");
      const departmentAfter =
        migrated.catalog.inspectDepartment("software-rnd");

      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.deepEqual(after.published, before.published);
      assert.deepEqual(after.history, before.history);
      assert.deepEqual(
        departmentAfter.executionProfiles,
        departmentBefore.executionProfiles,
      );
      assert.deepEqual(
        departmentAfter.pipeline?.nodes.map((node) => node.skillFlowSnapshot),
        departmentBefore.pipeline?.nodes.map((node) => node.skillFlowSnapshot),
      );
    } finally {
      migrated.close();
    }
  });

  it("backfills persisted Node attempts and a pending Approval from schema version eight", async () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const project = current.catalog.createProject({
      name: "Existing Run",
      goal: "Preserve Phase 2 execution evidence",
    });
    const started = current.pipelineRuntime.startRun({
      projectId: project.id,
      departmentId: "software-rnd",
    });
    const waiting = await current.pipelineRuntime.executeReady({
      runId: started.run.id,
      expectedRevision: started.run.revision,
    });
    assert.equal(waiting.run.status, "waiting-approval");
    const databasePath = current.path;
    current.close();

    const versionEight = new DatabaseSync(databasePath);
    removeSnapshotRevisionParentLinks(versionEight);
    removeDepartmentRunControls(versionEight);
    removeNodeAttemptRecovery(versionEight);
    versionEight.exec(`
      UPDATE schema_metadata SET value = '8' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version >= 9;
      PRAGMA user_version = 8;
    `);
    versionEight.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(migrated.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT node_runs.pipeline_node_id AS pipelineNodeId,
                      node_attempts.attempt_number AS attemptNumber,
                      node_attempts.reason,
                      node_attempts.status
                 FROM node_attempts
                 JOIN node_runs ON node_runs.id = node_attempts.node_run_id
                WHERE node_runs.run_id = ?
                ORDER BY node_runs.created_at`,
            )
            .all(waiting.run.id)
            .map((row) => ({ ...row })),
          [
            {
              pipelineNodeId: "product-alignment",
              attemptNumber: 1,
              reason: "initial",
              status: "succeeded",
            },
            {
              pipelineNodeId: "technical-plan",
              attemptNumber: 1,
              reason: "initial",
              status: "succeeded",
            },
          ],
        );
        assert.deepEqual(
          {
            ...inspected
              .prepare(
                `SELECT node_runs.pipeline_node_id AS pipelineNodeId,
                        approvals.cycle,
                        approvals.status,
                        approvals.decision
                   FROM approvals
                   JOIN node_runs ON node_runs.id = approvals.node_run_id
                  WHERE approvals.run_id = ?`,
              )
              .get(waiting.run.id),
          },
          {
            pipelineNodeId: "plan-approval",
            cycle: 1,
            status: "pending",
            decision: null,
          },
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("adds durable lease metadata when upgrading schema version nine", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();

    const versionNine = new DatabaseSync(databasePath);
    removeSnapshotRevisionParentLinks(versionNine);
    removeDepartmentRunControls(versionNine);
    removeNodeAttemptLeases(versionNine);
    versionNine.exec(`
      UPDATE schema_metadata SET value = '9' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version >= 10;
      PRAGMA user_version = 9;
    `);
    versionNine.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(migrated.path);
      try {
        assert.deepEqual(
          inspected
            .prepare("PRAGMA table_info(node_attempts)")
            .all()
            .map((row) => (row as { name: string }).name)
            .filter((name) =>
              [
                "lease_id",
                "lease_owner",
                "lease_expires_at",
                "checkpoint_json",
                "recoverable",
              ].includes(name),
            ),
          [
            "lease_id",
            "lease_owner",
            "lease_expires_at",
            "checkpoint_json",
            "recoverable",
          ],
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("adds persistent Run control state when upgrading schema version ten", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();

    const versionTen = new DatabaseSync(databasePath);
    removeSnapshotRevisionParentLinks(versionTen);
    removeDepartmentRunControls(versionTen);
    versionTen.exec(`
      UPDATE schema_metadata SET value = '10' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version >= 11;
      PRAGMA user_version = 10;
    `);
    versionTen.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(migrated.path);
      try {
        assert.equal(
          inspected
            .prepare("PRAGMA table_info(department_runs)")
            .all()
            .some(
              (row) => (row as { name: string }).name === "paused_from_status",
            ),
          true,
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("adds an explicit Recovery Attempt reason when upgrading schema version seventeen", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const databasePath = current.path;
    current.close();

    const versionSeventeen = new DatabaseSync(databasePath);
    removeRecoveryAttemptReason(versionSeventeen);
    versionSeventeen.exec(`
      UPDATE schema_metadata SET value = '17' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version >= 18;
      PRAGMA user_version = 17;
    `);
    versionSeventeen.close();

    const migrated = openCompanyDatabase(companyDir);
    try {
      assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(migrated.path);
      try {
        const table = inspected
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'node_attempts'",
          )
          .get() as { readonly sql: string };
        assert.match(table.sql, /'recovery'/);
        assert.deepEqual(
          inspected.prepare("PRAGMA foreign_key_check").all(),
          [],
        );
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("upgrades schema version 37 with accepted Technical Baselines and the Delivery coordinator", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const previous = new DatabaseSync(databasePath);
    previous.exec(`
      DROP TABLE technical_gate_promotions;
      DROP TABLE technical_baselines;
      DELETE FROM positions WHERE id = 'delivery-coordinator';
      DELETE FROM ai_members WHERE id = 'delivery-coordinator-member';
      DELETE FROM schema_migrations WHERE version = 38;
      UPDATE schema_metadata SET value = '37' WHERE key = 'schema_version';
      PRAGMA user_version = 37;
    `);
    previous.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(databasePath);
      try {
        assert.equal(
          inspected
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'technical_baselines'",
            )
            .get() !== undefined,
          true,
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT ai_member_id AS aiMemberId FROM positions WHERE id = 'delivery-coordinator'",
              )
              .get() as { readonly aiMemberId: string }
          ).aiMemberId,
          "delivery-coordinator-member",
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("upgrades schema version 38 without losing generic Review rows and admits Memory Review kinds", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const project = initialized.catalog.createProject({
      name: "Reviewed Memory migration",
      goal: "Preserve generic Review evidence",
    });
    const producerSession = initialized.interaction.createSession({
      projectId: project.id,
      mode: "consultation",
    });
    const databasePath = initialized.path;
    initialized.close();

    const previous = new DatabaseSync(databasePath);
    previous
      .prepare(
        `INSERT INTO review_topics(
          id, project_id, run_id, title, kind, status, revision,
          manifest_json, manifest_hash, producer_ai_member_id,
          producer_position_id, producer_session_id, quorum, budget_json,
          rounds_used, duration_seconds_used, tokens_used, cost_cents_used,
          stop_condition, escalation_policy, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'product', 'PASS', 1, '{}', ?, ?, ?, ?, 1,
                  '{}', 0, 0, 0, 0, 'blocking-findings-dispositioned',
                  'fail-with-evidence', ?, ?)`,
      )
      .run(
        "review-topic-v38",
        project.id,
        "Existing Review",
        "a".repeat(64),
        "product-planner-member",
        "product-planner",
        producerSession.id,
        "2026-07-27T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
      );
    previous
      .prepare(
        `INSERT INTO quality_gate_results(
          id, topic_id, kind, manifest_json, manifest_hash, revision_id,
          result, conditions_json, recheck_ids_json, evidence_refs_json,
          created_at
        ) VALUES (?, ?, 'product', '{}', ?, NULL, 'PASS', '[]', '[]', '[]', ?)`,
      )
      .run(
        "quality-gate-v38",
        "review-topic-v38",
        "a".repeat(64),
        "2026-07-27T00:00:00.000Z",
      );
    previous.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX execution_leases_active_operation_idx;
      DROP TABLE run_memory_selections;
      DROP TABLE reviewed_memory_entries;
      DROP TABLE reviewed_memory_decisions;
      DROP TABLE reviewed_memory_review_topics;
      DROP TABLE reviewed_memory_candidate_revisions;
      DROP TABLE reviewed_memory_candidates;

      CREATE TABLE review_topics_v38 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES department_runs(id),
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('product', 'technical', 'code', 'aggregate', 'verification')
        ),
        status TEXT NOT NULL CHECK (
          status IN (
            'scheduled', 'independent-review', 'discussion', 'revision',
            're-review', 'blocked', 'PASS', 'CONDITIONAL_PASS', 'FAIL'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision > 0),
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
        producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
        producer_position_id TEXT NOT NULL REFERENCES positions(id),
        producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
        quorum INTEGER NOT NULL CHECK (quorum > 0),
        budget_json TEXT NOT NULL,
        rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
        duration_seconds_used INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds_used >= 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        cost_cents_used INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents_used >= 0),
        stop_condition TEXT NOT NULL CHECK (
          stop_condition = 'blocking-findings-dispositioned'
        ),
        escalation_policy TEXT NOT NULL CHECK (
          escalation_policy = 'fail-with-evidence'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO review_topics_v38 SELECT * FROM review_topics;

      CREATE TABLE quality_gate_results_v38 (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL UNIQUE REFERENCES review_topics(id),
        kind TEXT NOT NULL CHECK (
          kind IN ('product', 'technical', 'code', 'aggregate', 'verification')
        ),
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
        revision_id TEXT REFERENCES review_revisions(id),
        result TEXT NOT NULL CHECK (
          result IN ('PASS', 'CONDITIONAL_PASS', 'FAIL')
        ),
        conditions_json TEXT NOT NULL,
        recheck_ids_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO quality_gate_results_v38 SELECT * FROM quality_gate_results;

      DROP TABLE quality_gate_results;
      ALTER TABLE quality_gate_results_v38 RENAME TO quality_gate_results;
      DROP TABLE review_topics;
      ALTER TABLE review_topics_v38 RENAME TO review_topics;
      CREATE INDEX review_topics_project_idx
        ON review_topics(project_id, created_at, id);
      CREATE INDEX review_topics_run_idx
        ON review_topics(run_id, created_at, id);
      CREATE TRIGGER quality_gate_results_immutable_update
      BEFORE UPDATE ON quality_gate_results
      BEGIN
        SELECT RAISE(ABORT, 'Quality Gate Result is immutable');
      END;
      CREATE TRIGGER quality_gate_results_immutable_delete
      BEFORE DELETE ON quality_gate_results
      BEGIN
        SELECT RAISE(ABORT, 'Quality Gate Result is immutable');
      END;

      DELETE FROM schema_migrations WHERE version = 39;
      UPDATE schema_metadata SET value = '38' WHERE key = 'schema_version';
      PRAGMA user_version = 38;
      PRAGMA foreign_keys = ON;
    `);
    previous.close();
    const v38 = new DatabaseSync(databasePath);
    try {
      const topicSql = (
        v38
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_topics'",
          )
          .get() as { readonly sql: string }
      ).sql;
      assert.equal(topicSql.includes("'memory'"), false);
    } finally {
      v38.close();
    }
    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(databasePath);
      try {
        assert.deepEqual(
          {
            ...(inspected
              .prepare(
                `SELECT topics.id AS topicId, topics.kind AS topicKind,
                        gates.id AS gateId, gates.kind AS gateKind
                   FROM review_topics AS topics
                   JOIN quality_gate_results AS gates ON gates.topic_id = topics.id
                  WHERE topics.id = 'review-topic-v38'`,
              )
              .get() as object),
          },
          {
            topicId: "review-topic-v38",
            topicKind: "product",
            gateId: "quality-gate-v38",
            gateKind: "product",
          },
        );
        const reviewSql = inspected
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_topics'",
          )
          .get() as { readonly sql: string };
        const gateSql = inspected
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'quality_gate_results'",
          )
          .get() as { readonly sql: string };
        assert.match(reviewSql.sql, /'memory'/);
        assert.match(gateSql.sql, /'memory'/);
        assert.deepEqual(
          inspected.prepare("PRAGMA foreign_key_check").all(),
          [],
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("adopts a complete compatible Work Package schema when replaying migration 42", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const previous = new DatabaseSync(databasePath);
    previous.exec(`
      DELETE FROM schema_migrations WHERE version = 42;
      UPDATE schema_metadata SET value = '41' WHERE key = 'schema_version';
      PRAGMA user_version = 41;
    `);
    previous.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(databasePath);
      try {
        assert.equal(
          inspected
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'work_packages'",
            )
            .get() !== undefined,
          true,
        );
        assert.equal(
          inspected
            .prepare(
              "SELECT 1 FROM schema_migrations WHERE version = 42 AND name = 'work_package_execution'",
            )
            .get() !== undefined,
          true,
        );
        assert.match(
          (
            inspected
              .prepare(
                "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'work_package_versions_active_node_idx'",
              )
              .get() as { readonly sql: string }
          ).sql,
          /CREATE UNIQUE INDEX work_package_versions_active_node_idx[\s\S]*WHERE status = 'ready'/,
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("transactionally rejects a partial Work Package schema without destructive DDL", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const partial = new DatabaseSync(databasePath);
    partial.exec(`
      DROP TRIGGER work_package_self_checks_immutable_delete;
      DELETE FROM schema_migrations WHERE version = 42;
      UPDATE schema_metadata SET value = '41' WHERE key = 'schema_version';
      PRAGMA user_version = 41;
    `);
    partial.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Work Package schema is incompatible: work_package_self_checks_immutable_delete/,
    );

    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (
          inspected
            .prepare(
              "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
            )
            .get() as { readonly value: string }
        ).value,
        "41",
      );
      assert.equal(
        inspected
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'work_packages'",
          )
          .get() !== undefined,
        true,
      );
      assert.equal(
        inspected
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'work_package_self_checks'",
          )
          .get() !== undefined,
        true,
      );
      assert.equal(
        inspected
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 42")
          .get(),
        undefined,
      );
    } finally {
      inspected.close();
    }
  });

  it("rejects same-name Work Package indexes and triggers with incompatible SQL", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(`
      DROP INDEX work_package_assignments_version_idx;
      CREATE INDEX work_package_assignments_version_idx
        ON work_package_assignments(state);
      DROP TRIGGER work_package_self_checks_immutable_delete;
      CREATE TRIGGER work_package_self_checks_immutable_delete
      BEFORE DELETE ON work_package_self_checks
      BEGIN
        SELECT 1;
      END;
      DELETE FROM schema_migrations WHERE version = 42;
      UPDATE schema_metadata SET value = '41' WHERE key = 'schema_version';
      PRAGMA user_version = 41;
    `);
    incompatible.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Work Package schema is incompatible:.*work_package_assignments_version_idx.*work_package_self_checks_immutable_delete/,
    );

    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (
          inspected
            .prepare(
              "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
            )
            .get() as { readonly value: string }
        ).value,
        "41",
      );
    } finally {
      inspected.close();
    }
  });

  it("rejects a same-name Work Package table with an extra column", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(`
      ALTER TABLE work_packages ADD COLUMN unexpected_authority TEXT;
      DELETE FROM schema_migrations WHERE version = 42;
      UPDATE schema_metadata SET value = '41' WHERE key = 'schema_version';
      PRAGMA user_version = 41;
    `);
    incompatible.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Work Package schema is incompatible:.*work_packages/,
    );
  });

  it("rejects a workspace allocation table with the same columns but different constraints", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(`
      PRAGMA writable_schema = ON;
      UPDATE sqlite_schema
         SET sql = replace(
           sql,
           'evidence_scope TEXT',
           'evidence_scope TEXT CHECK (
              evidence_scope IS NULL OR length(evidence_scope) > 0
            )'
         )
       WHERE type = 'table' AND name = 'workspace_allocations';
      PRAGMA writable_schema = OFF;
      PRAGMA schema_version = 1000;
      DELETE FROM schema_migrations WHERE version = 42;
      UPDATE schema_metadata SET value = '41' WHERE key = 'schema_version';
      PRAGMA user_version = 41;
    `);
    incompatible.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Work Package schema is incompatible:.*workspace_allocations/,
    );
  });

  it("adopts a complete compatible Code Review schema when replaying migration 43", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const previous = new DatabaseSync(databasePath);
    previous.exec(`
      DELETE FROM schema_migrations WHERE version = 43;
      UPDATE schema_metadata SET value = '42' WHERE key = 'schema_version';
      PRAGMA user_version = 42;
    `);
    previous.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(databasePath);
      try {
        assert.equal(
          inspected
            .prepare(
              "SELECT 1 FROM schema_migrations WHERE version = 43 AND name = 'independent_code_review_authority'",
            )
            .get() !== undefined,
          true,
        );
        assert.equal(
          inspected
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'code_review_authorities'",
            )
            .get() !== undefined,
          true,
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("transactionally rejects a partial Code Review schema", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const partial = new DatabaseSync(databasePath);
    partial.exec(`
      DROP TRIGGER code_review_authorities_immutable_delete;
      DELETE FROM schema_migrations WHERE version = 43;
      UPDATE schema_metadata SET value = '42' WHERE key = 'schema_version';
      PRAGMA user_version = 42;
    `);
    partial.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Code Review schema is incompatible: code_review_authorities_immutable_delete/,
    );
    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (
          inspected
            .prepare(
              "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
            )
            .get() as { readonly value: string }
        ).value,
        "42",
      );
      assert.equal(
        inspected
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 43")
          .get(),
        undefined,
      );
    } finally {
      inspected.close();
    }
  });

  it("rejects a same-name Code Review index with incompatible SQL", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const databasePath = initialized.path;
    initialized.close();

    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(`
      DROP INDEX code_review_defects_package_idx;
      CREATE INDEX code_review_defects_package_idx
        ON code_review_defects(status);
      DELETE FROM schema_migrations WHERE version = 43;
      UPDATE schema_metadata SET value = '42' WHERE key = 'schema_version';
      PRAGMA user_version = 42;
    `);
    incompatible.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Existing Code Review schema is incompatible: code_review_defects_package_idx/,
    );
  });

  it("rejects a database created by a newer runtime without rewriting its version", () => {
    const companyDir = tempCompanyDir();
    const databasePath = join(companyDir, ".sandcastle", "company.sqlite");
    mkdirSync(join(companyDir, ".sandcastle"), { recursive: true });
    const future = new DatabaseSync(databasePath);
    const futureVersion = CURRENT_SCHEMA_VERSION + 1;
    future.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '${futureVersion}');
      PRAGMA user_version = ${futureVersion};
    `);
    future.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      new RegExp(
        `Unsupported company database schema version ${futureVersion}`,
      ),
    );

    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (
          inspected
            .prepare(
              "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
            )
            .get() as { value: string }
        ).value,
        String(futureVersion),
      );
      assert.equal(
        (
          inspected.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
        futureVersion,
      );
      assert.equal(
        inspected
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get(),
        undefined,
      );
    } finally {
      inspected.close();
    }
  });

  it("upgrades schema version 43 with durable Reviewer execution stages", () => {
    const companyDir = tempCompanyDir();
    const current = openCompanyDatabase(companyDir);
    const path = current.path;
    current.close();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DROP TRIGGER code_review_execution_stages_identity_update;
        DROP TRIGGER code_review_execution_stages_immutable_delete;
        DROP INDEX code_review_execution_stages_state_idx;
        DROP TABLE code_review_execution_stages;
        DELETE FROM schema_migrations WHERE version = 44;
        UPDATE schema_metadata SET value = '43' WHERE key = 'schema_version';
        PRAGMA user_version = 43;
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(upgraded.path);
      try {
        const table = inspected
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE type = 'table' AND name = 'code_review_execution_stages'`,
          )
          .get() as { readonly name: string } | undefined;
        assert.equal(table?.name, "code_review_execution_stages");
        const migration = inspected
          .prepare(
            `SELECT version, name FROM schema_migrations WHERE version = 44`,
          )
          .get() as
          | { readonly version: number; readonly name: string }
          | undefined;
        assert.equal(migration?.version, 44);
        assert.equal(migration?.name, "durable_code_review_execution");
        const exactEvidenceMigration = inspected
          .prepare(
            `SELECT version, name FROM schema_migrations WHERE version = 45`,
          )
          .get() as
          | { readonly version: number; readonly name: string }
          | undefined;
        assert.equal(exactEvidenceMigration?.version, 45);
        assert.equal(
          exactEvidenceMigration?.name,
          "immutable_exact_code_review_execution_evidence",
        );
        const authorityColumns = inspected
          .prepare("PRAGMA table_info(code_review_authorities)")
          .all() as Array<{ readonly name: string }>;
        assert.equal(
          authorityColumns.some(
            (column) => column.name === "initial_execution_stage_id",
          ),
          true,
        );
        assert.equal(
          authorityColumns.some(
            (column) => column.name === "fresh_result_hash",
          ),
          true,
        );
        assert.equal(
          (
            inspected
              .prepare(
                `SELECT COUNT(*) AS count FROM sqlite_schema
                  WHERE type = 'trigger'
                    AND name = 'code_review_execution_stages_succeeded_update'`,
              )
              .get() as { readonly count: number }
          ).count,
          1,
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("upgrades schema version 45 with immutable Integration Generation storage", () => {
    const companyDir = tempCompanyDir();
    const initial = openCompanyDatabase(companyDir);
    const path = initial.path;
    initial.close();
    const old = new DatabaseSync(path);
    old.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX execution_leases_active_operation_idx;
      DROP TRIGGER integration_execution_stages_immutable_delete;
      DROP TRIGGER integration_execution_stages_terminal_update;
      DROP TRIGGER integration_execution_stages_identity_update;
      DROP TRIGGER integration_aggregate_reviews_immutable_delete;
      DROP TRIGGER integration_aggregate_reviews_immutable_update;
      DROP TRIGGER integration_defects_immutable_delete;
      DROP TRIGGER integration_defects_evidence_update;
      DROP TRIGGER integration_validation_records_immutable_delete;
      DROP TRIGGER integration_validation_records_immutable_update;
      DROP TRIGGER integration_repository_results_immutable_delete;
      DROP TRIGGER integration_repository_results_terminal_update;
      DROP TRIGGER integration_repository_results_identity_update;
      DROP TRIGGER integration_operations_immutable_delete;
      DROP TRIGGER integration_operations_succeeded_update;
      DROP TRIGGER integration_operations_identity_update;
      DROP TRIGGER integration_generations_immutable_delete;
      DROP TRIGGER integration_generations_identity_update;
      DROP INDEX integration_defects_generation_idx;
      DROP INDEX integration_operations_state_idx;
      DROP INDEX integration_validation_records_generation_idx;
      DROP INDEX integration_generations_run_idx;
      DROP INDEX integration_execution_stages_state_idx;
      DROP TABLE integration_execution_stages;
      DROP TABLE integration_aggregate_reviews;
      DROP TABLE integration_defects;
      DROP TABLE integration_validation_records;
      DROP TABLE integration_operations;
      DROP TABLE integration_repository_results;
      DROP TABLE integration_generations;
      DELETE FROM schema_migrations WHERE version = 46;
      UPDATE schema_metadata SET value = '45' WHERE key = 'schema_version';
      PRAGMA user_version = 45;
    `);
    old.close();

    const upgraded = openCompanyDatabase(companyDir);
    try {
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const inspected = new DatabaseSync(upgraded.path);
      try {
        assert.deepEqual(
          inspected
            .prepare(
              `SELECT name FROM sqlite_schema
                WHERE type = 'table' AND name LIKE 'integration_%'
                ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "integration_aggregate_reviews" },
            { name: "integration_defects" },
            { name: "integration_execution_stages" },
            { name: "integration_generations" },
            { name: "integration_operations" },
            { name: "integration_repository_results" },
            { name: "integration_validation_records" },
          ],
        );
        assert.equal(
          Number(
            inspected
              .prepare(
                `SELECT COUNT(*) AS count FROM sqlite_schema
                  WHERE type = 'index'
                    AND name = 'execution_leases_active_operation_idx'`,
              )
              .get()!.count,
          ),
          1,
        );
        assert.deepEqual(
          {
            ...(inspected
              .prepare(
                "SELECT version, name FROM schema_migrations WHERE version = 46",
              )
              .get() as Record<string, unknown>),
          },
          {
            version: 46,
            name: "multi_repository_integration_generations",
          },
        );
        inspected.exec("PRAGMA foreign_keys = OFF");
        inspected
          .prepare(
            `INSERT INTO integration_generations(
               id, project_id, run_id, snapshot_revision_id, node_run_id,
               generation, coverage_id, coverage_node_run_id,
               coverage_node_attempt_id, coverage_hash, manifest_json,
               manifest_hash, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '{}', ?, 'passed', ?, ?)`,
          )
          .run(
            "generation-immutable",
            "project",
            "run",
            "snapshot",
            "node",
            "coverage",
            "coverage-node",
            "coverage-attempt",
            "a".repeat(64),
            "b".repeat(64),
            "2026-07-28T00:00:00.000Z",
            "2026-07-28T00:00:00.000Z",
          );
        inspected
          .prepare(
            `INSERT INTO integration_repository_results(
               id, generation_id, repository_reference, base_commit,
               integration_branch, state, expected_tip, integrated_commit,
               validation_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, '{}', ?, ?)`,
          )
          .run(
            "repository-immutable",
            "generation-immutable",
            "/repositories/api",
            "1".repeat(40),
            "integration/run/g1",
            "2".repeat(40),
            "2".repeat(40),
            "2026-07-28T00:00:00.000Z",
            "2026-07-28T00:00:00.000Z",
          );
        inspected
          .prepare(
            `INSERT INTO integration_validation_records(
               id, generation_id, repository_result_id, validation_id, kind,
               status, evidence_json, responsibility_json, record_hash, created_at
             ) VALUES (?, ?, ?, ?, 'build-test', 'passed', '[]', '[]', ?, ?)`,
          )
          .run(
            "validation-immutable",
            "generation-immutable",
            "repository-immutable",
            "validation-1",
            "c".repeat(64),
            "2026-07-28T00:00:00.000Z",
          );
        inspected
          .prepare(
            `INSERT INTO integration_defects(
               id, generation_id, kind, responsibility_json, evidence_json,
               status, created_at
             ) VALUES (?, ?, 'build-test', '{}', '{}', 'open', ?)`,
          )
          .run(
            "defect-immutable",
            "generation-immutable",
            "2026-07-28T00:00:00.000Z",
          );
        assert.throws(() =>
          inspected.exec(
            "UPDATE integration_repository_results SET base_commit = '9999999999999999999999999999999999999999' WHERE id = 'repository-immutable'",
          ),
        );
        assert.throws(() =>
          inspected.exec(
            "UPDATE integration_repository_results SET integrated_commit = '8888888888888888888888888888888888888888' WHERE id = 'repository-immutable'",
          ),
        );
        assert.throws(() =>
          inspected.exec(
            "UPDATE integration_validation_records SET evidence_json = '[\"changed\"]' WHERE id = 'validation-immutable'",
          ),
        );
        assert.throws(() =>
          inspected.exec(
            "UPDATE integration_defects SET evidence_json = '{\"changed\":true}' WHERE id = 'defect-immutable'",
          ),
        );
      } finally {
        inspected.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("rejects same-name but incompatible v46 tables, triggers, and indexes transactionally", () => {
    const corruptions = [
      {
        label: "extra table column",
        sql: "ALTER TABLE integration_generations ADD COLUMN forged TEXT",
      },
      {
        label: "no-op trigger",
        sql: `DROP TRIGGER integration_execution_stages_terminal_update;
              CREATE TRIGGER integration_execution_stages_terminal_update
              BEFORE UPDATE ON integration_execution_stages BEGIN SELECT 1; END`,
      },
      {
        label: "active lease index mismatch",
        sql: `DROP INDEX execution_leases_active_operation_idx;
              CREATE INDEX execution_leases_active_operation_idx
                ON execution_leases(operation_key)`,
      },
    ] as const;
    for (const corruption of corruptions) {
      const companyDir = tempCompanyDir();
      const current = openCompanyDatabase(companyDir);
      const path = current.path;
      current.close();
      const forged = new DatabaseSync(path);
      forged.exec(`
        ${corruption.sql};
        DELETE FROM schema_migrations WHERE version = 46;
        UPDATE schema_metadata SET value = '45' WHERE key = 'schema_version';
        PRAGMA user_version = 45;
      `);
      forged.close();

      assert.throws(
        () => openCompanyDatabase(companyDir),
        new RegExp("Existing Integration schema is incompatible"),
        corruption.label,
      );
      const inspected = new DatabaseSync(path);
      try {
        assert.equal(
          inspected
            .prepare(
              "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
            )
            .get()!.value,
          "45",
        );
        assert.equal(
          Number(
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 46",
              )
              .get()!.count,
          ),
          0,
        );
      } finally {
        inspected.close();
      }
    }
  });
});

describe("Test authority schema migration", () => {
  const restoreHistoricalV47Contract = (database: DatabaseSync): void => {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER test_run_obligation_resolutions_immutable_update;
      DROP TRIGGER test_run_obligation_resolutions_immutable_delete;
      DROP TRIGGER test_rework_runs_immutable_update;
      DROP TRIGGER test_rework_runs_immutable_delete;
      DROP INDEX test_rework_runs_defect_idx;
      DROP INDEX test_defect_resolutions_defect_idx;
      DROP TABLE test_run_obligation_resolutions;
      DROP TABLE test_rework_runs;
      ALTER TABLE test_assertion_results DROP COLUMN ui_observation_json;
      ALTER TABLE test_assertion_results DROP COLUMN runtime_observation_json;

      DROP TRIGGER test_run_obligations_identity_update;
      ALTER TABLE test_run_obligations RENAME TO test_run_obligations_v48;
      CREATE TABLE test_run_obligations (
        id TEXT PRIMARY KEY,
        test_run_id TEXT NOT NULL REFERENCES test_runs(id),
        description TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        closed_at TEXT
      ) STRICT;
      INSERT INTO test_run_obligations(
        id, test_run_id, description, evidence_json, status, created_at, closed_at
      )
      SELECT id, test_run_id, description, evidence_json, status, created_at, closed_at
        FROM test_run_obligations_v48;
      DROP TABLE test_run_obligations_v48;
      CREATE INDEX test_run_obligations_run_idx
        ON test_run_obligations(test_run_id, status, created_at, id);
      CREATE TRIGGER test_run_obligations_immutable_delete
        BEFORE DELETE ON test_run_obligations
        BEGIN SELECT RAISE(ABORT, 'Test Run obligation is immutable'); END;
      CREATE TRIGGER test_run_obligations_identity_update
        BEFORE UPDATE ON test_run_obligations
        WHEN NEW.id <> OLD.id OR NEW.test_run_id <> OLD.test_run_id
          OR NEW.description <> OLD.description
          OR NEW.evidence_json <> OLD.evidence_json
          OR NEW.created_at <> OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'Test Run obligation identity is immutable'); END;
      CREATE TRIGGER test_run_obligations_terminal_run_insert
        BEFORE INSERT ON test_run_obligations
        WHEN EXISTS (
          SELECT 1 FROM test_runs
           WHERE id = NEW.test_run_id
             AND state IN ('passed', 'failed', 'blocked', 'cancelled')
        ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
      CREATE TRIGGER test_run_obligations_terminal_run_update
        BEFORE UPDATE ON test_run_obligations
        WHEN EXISTS (
          SELECT 1 FROM test_runs
           WHERE id = OLD.test_run_id
             AND state IN ('passed', 'failed', 'blocked', 'cancelled')
        ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;

      CREATE TRIGGER test_defects_terminal_run_update
        BEFORE UPDATE ON test_defects
        WHEN EXISTS (
          SELECT 1 FROM test_runs
           WHERE id = OLD.test_run_id
             AND state IN ('passed', 'failed', 'blocked', 'cancelled')
        ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
      CREATE TRIGGER test_defect_resolutions_terminal_run_insert
        BEFORE INSERT ON test_defect_resolutions
        WHEN EXISTS (
          SELECT 1 FROM test_defects
          JOIN test_runs ON test_runs.id = test_defects.test_run_id
          WHERE test_defects.id = NEW.defect_id
            AND test_runs.state IN ('passed', 'failed', 'blocked', 'cancelled')
        ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;

      DELETE FROM schema_migrations WHERE version = 48;
      UPDATE schema_metadata SET value = '47' WHERE key = 'schema_version';
      PRAGMA user_version = 47;
    `);
  };

  it("upgrades through the historical v47 contract to the complete immutable v48 Test schema", () => {
    const companyDir = tempCompanyDir();
    const opened = openCompanyDatabase(companyDir);
    assert.equal(CURRENT_SCHEMA_VERSION, 52);
    assert.equal(opened.schemaVersion(), 52);
    opened.close();

    const database = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    const expected = [
      "test_cases",
      "test_case_revisions",
      "test_runs",
      "test_run_case_revisions",
      "test_execution_operations",
      "test_execution_facts",
      "test_execution_control_operations",
      "test_assertion_results",
      "test_evidence",
      "test_defects",
      "test_defect_resolutions",
      "test_run_obligations",
      "test_run_obligation_resolutions",
      "test_rework_runs",
    ];
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'test_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      [...expected].sort(),
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'test_%immutable%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      [
        "test_assertion_results_immutable_delete",
        "test_assertion_results_immutable_update",
        "test_case_revisions_immutable_delete",
        "test_case_revisions_immutable_update",
        "test_cases_immutable_delete",
        "test_cases_immutable_update",
        "test_defect_resolutions_immutable_delete",
        "test_defect_resolutions_immutable_update",
        "test_defects_immutable_delete",
        "test_evidence_immutable_delete",
        "test_evidence_immutable_update",
        "test_execution_control_operations_immutable_delete",
        "test_execution_facts_immutable_delete",
        "test_execution_facts_immutable_update",
        "test_execution_operations_immutable_delete",
        "test_rework_runs_immutable_delete",
        "test_rework_runs_immutable_update",
        "test_run_case_revisions_immutable_delete",
        "test_run_case_revisions_immutable_update",
        "test_run_obligation_resolutions_immutable_delete",
        "test_run_obligation_resolutions_immutable_update",
        "test_run_obligations_immutable_delete",
        "test_runs_immutable_delete",
      ],
    );
    database.exec(`
      INSERT INTO projects(id, company_id, name, goal, status, created_at)
      VALUES ('test-schema-project', 'company', 'Schema', 'Verify immutability', 'active', '2026-07-29T00:00:00.000Z');
      INSERT INTO test_cases(id, project_id, created_at)
      VALUES ('test-schema-case', 'test-schema-project', '2026-07-29T00:00:00.000Z');
    `);
    assert.throws(
      () =>
        database
          .prepare("UPDATE test_cases SET project_id = ? WHERE id = ?")
          .run("test-schema-project", "test-schema-case"),
      /Test Case identity is immutable/,
    );
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM test_cases WHERE id = ?")
          .run("test-schema-case"),
      /Test Case identity is immutable/,
    );
    database.close();
  });

  it("upgrades the exact historical v47 schema through the additive v48 migration", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const path = initialized.path;
    initialized.close();
    const historical = new DatabaseSync(path);
    restoreHistoricalV47Contract(historical);

    assert.equal(migrateCompanyDatabase(historical), 52);
    assert.deepEqual(
      historical
        .prepare(
          "SELECT version, name FROM schema_migrations WHERE version IN (47, 48, 49, 50, 51) ORDER BY version",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { version: 47, name: "versioned_test_cases_and_runs" },
        { version: 48, name: "test_rework_resolution_authority" },
        { version: 49, name: "frozen_delivery_candidate_quality_gates" },
        { version: 50, name: "delivery_candidates_and_human_release" },
        { version: 51, name: "idempotent_release_operations" },
      ],
    );
    assert.equal(
      (
        historical
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('test_run_obligations') WHERE name = 'defect_id'",
          )
          .get() as { readonly count: number }
      ).count,
      1,
    );
    assert.deepEqual(
      historical
        .prepare(
          "SELECT name FROM pragma_table_info('test_assertion_results') WHERE name LIKE '%_observation_json' ORDER BY name",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      ["runtime_observation_json", "ui_observation_json"],
    );
    historical.close();
  });

  it("adopts a complete compatible v48 schema and rejects a partial one transactionally", () => {
    const compatibleDir = tempCompanyDir();
    openCompanyDatabase(compatibleDir).close();
    const compatiblePath = join(compatibleDir, ".sandcastle", "company.sqlite");
    const compatible = new DatabaseSync(compatiblePath);
    compatible.exec(`
      UPDATE schema_metadata SET value = '47' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 48;
      PRAGMA user_version = 47;
    `);
    assert.equal(migrateCompanyDatabase(compatible), 52);
    compatible.close();

    const partialDir = tempCompanyDir();
    openCompanyDatabase(partialDir).close();
    const partialPath = join(partialDir, ".sandcastle", "company.sqlite");
    const partial = new DatabaseSync(partialPath);
    partial.exec(`
      DROP TRIGGER test_rework_runs_immutable_delete;
      UPDATE schema_metadata SET value = '47' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 48;
      PRAGMA user_version = 47;
    `);
    assert.throws(
      () => migrateCompanyDatabase(partial),
      /Existing Test v48 schema is incompatible: test_rework_runs_immutable_delete/,
    );
    assert.equal(
      (
        partial
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "47",
    );
    partial.close();
  });

  it("rejects a downgraded v48 schema missing any historical v47 immutability trigger", () => {
    const companyDir = tempCompanyDir();
    openCompanyDatabase(companyDir).close();
    const path = join(companyDir, ".sandcastle", "company.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TRIGGER test_evidence_immutable_delete;
      UPDATE schema_metadata SET value = '47' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 48;
      PRAGMA user_version = 47;
    `);

    assert.throws(
      () => migrateCompanyDatabase(database),
      /Existing Test v48 schema is incompatible: test_evidence_immutable_delete/,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "47",
    );
    database.close();
  });

  it("adopts a complete v49 Delivery/Quality schema and rejects a partial one transactionally", () => {
    const compatibleDir = tempCompanyDir();
    openCompanyDatabase(compatibleDir).close();
    const compatible = new DatabaseSync(
      join(compatibleDir, ".sandcastle", "company.sqlite"),
    );
    compatible.exec(`
      UPDATE schema_metadata SET value = '48' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 49;
      PRAGMA user_version = 48;
    `);
    assert.equal(migrateCompanyDatabase(compatible), 52);
    compatible.close();

    const partialDir = tempCompanyDir();
    openCompanyDatabase(partialDir).close();
    const partial = new DatabaseSync(
      join(partialDir, ".sandcastle", "company.sqlite"),
    );
    partial.exec(`
      DROP TRIGGER candidate_gate_results_immutable_delete;
      UPDATE schema_metadata SET value = '48' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 49;
      PRAGMA user_version = 48;
    `);
    assert.throws(
      () => migrateCompanyDatabase(partial),
      /Existing Delivery\/Quality schema is incompatible: candidate_gate_results_immutable_delete/,
    );
    assert.equal(
      (
        partial
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "48",
    );
    partial.close();
  });

  it("upgrades v49, adopts a complete v50 schema, and rejects a partial v50 schema transactionally", () => {
    const forwardDir = tempCompanyDir();
    openCompanyDatabase(forwardDir).close();
    const forward = new DatabaseSync(
      join(forwardDir, ".sandcastle", "company.sqlite"),
    );
    forward.exec(`
      DROP TABLE delivery_release_rework_activations;
      DROP TABLE accepted_delivery_candidate_authorities;
      DROP TABLE delivery_release_rework_records;
      DROP TABLE human_release_decisions;
      DROP TABLE delivery_candidates;
      DROP TABLE candidate_critical_escalations;
      UPDATE schema_metadata SET value = '49' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 50;
      PRAGMA user_version = 49;
    `);
    assert.equal(migrateCompanyDatabase(forward), 52);
    assert.deepEqual(
      forward
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (
                'candidate_critical_escalations',
                'delivery_candidates',
                'human_release_decisions',
                'delivery_release_rework_records',
                'delivery_release_rework_activations',
                'accepted_delivery_candidate_authorities'
              )
            ORDER BY name`,
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      [
        "accepted_delivery_candidate_authorities",
        "candidate_critical_escalations",
        "delivery_candidates",
        "delivery_release_rework_activations",
        "delivery_release_rework_records",
        "human_release_decisions",
      ],
    );
    forward.close();

    const compatibleDir = tempCompanyDir();
    openCompanyDatabase(compatibleDir).close();
    const compatible = new DatabaseSync(
      join(compatibleDir, ".sandcastle", "company.sqlite"),
    );
    compatible.exec(`
      UPDATE schema_metadata SET value = '49' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 50;
      PRAGMA user_version = 49;
    `);
    assert.equal(migrateCompanyDatabase(compatible), 52);
    compatible.close();

    const partialDir = tempCompanyDir();
    openCompanyDatabase(partialDir).close();
    const partial = new DatabaseSync(
      join(partialDir, ".sandcastle", "company.sqlite"),
    );
    partial.exec(`
      DROP TRIGGER delivery_release_rework_activations_immutable_delete;
      UPDATE schema_metadata SET value = '49' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 50;
      PRAGMA user_version = 49;
    `);
    assert.throws(
      () => migrateCompanyDatabase(partial),
      /Existing Delivery v50 schema is incompatible: delivery_release_rework_activations_immutable_delete/,
    );
    assert.equal(
      (
        partial
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "49",
    );
    partial.close();
  });

  it("adds the immutable v51 release-operation claim and observation schema", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    assert.equal(CURRENT_SCHEMA_VERSION, 52);
    assert.equal(database.schemaVersion(), 52);
    database.close();

    const sqlite = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    assert.deepEqual(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (
                'release_operations',
                'release_operation_items',
                'release_operation_reconciliations',
                'release_operation_destination_claims',
                'release_operation_destination_claim_events',
                'release_operation_item_observations'
              )
            ORDER BY name`,
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      [
        "release_operation_destination_claim_events",
        "release_operation_destination_claims",
        "release_operation_item_observations",
        "release_operation_items",
        "release_operation_reconciliations",
        "release_operations",
      ],
    );
    assert.deepEqual(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'trigger' AND name LIKE 'release_operation%immutable%'
            ORDER BY name`,
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      [
        "release_operation_destination_claim_events_immutable_delete",
        "release_operation_destination_claim_events_immutable_update",
        "release_operation_destination_claims_immutable_delete",
        "release_operation_item_observations_immutable_delete",
        "release_operation_item_observations_immutable_update",
        "release_operation_items_immutable_delete",
        "release_operation_reconciliations_immutable_delete",
        "release_operation_reconciliations_immutable_update",
        "release_operations_immutable_delete",
      ],
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'release_operation_destination_claims_active_destination_idx'",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name),
      ["release_operation_destination_claims_active_destination_idx"],
    );
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO release_operations(
        id, idempotency_key, candidate_id, accepted_authority_id, kind,
        authorization_json, authorization_hash, request_json, canonical_request_hash,
        aggregate_state, created_at, updated_at
      ) VALUES (
        'release-operation-1', 'release-operation-1', 'candidate-1', 'authority-1', 'merge',
        '{}', '${"a".repeat(64)}', '{}', '${"a".repeat(64)}',
        'pending', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
      );
      INSERT INTO release_operation_items(
        id, operation_id, item_key, ordinal, kind, request_json, request_hash, state,
        evidence_json, created_at, updated_at
      ) VALUES (
        'release-item-1', 'release-operation-1', 'repository:api', 0, 'merge', '{}',
        '${"a".repeat(64)}', 'pending', '[]',
        '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
      );
      INSERT INTO release_operation_destination_claims(
        id, operation_id, item_id, destination_key, fence_token, is_active, created_at
      ) VALUES (
        'claim-1', 'release-operation-1', 'release-item-1', 'git:repository:api:main',
        'fence-1', 1, '2026-08-03T00:00:00.000Z'
      );
      INSERT INTO release_operation_item_observations(
        id, operation_id, item_id, kind, observation_json, observation_hash, created_at
      ) VALUES (
        'observation-1', 'release-operation-1', 'release-item-1', 'execution', '{}',
        '${"a".repeat(64)}', '2026-08-03T00:00:00.000Z'
      );
    `);
    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO release_operation_destination_claims(id, operation_id, item_id, destination_key, fence_token, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "claim-2",
            "release-operation-1",
            "release-item-1",
            "git:repository:api:main",
            "fence-2",
            1,
            "2026-08-03T00:00:00.000Z",
          ),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            "UPDATE release_operation_item_observations SET kind = ? WHERE id = ?",
          )
          .run("receipt", "observation-1"),
      /Release operation item observation is immutable/,
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            "DELETE FROM release_operation_item_observations WHERE id = ?",
          )
          .run("observation-1"),
      /Release operation item observation is immutable/,
    );
    sqlite.close();
  });

  it("creates and adopts the complete governed v52 Statistics and Improvement schema", () => {
    const expectedTables = [
      "governed_harness_revisions",
      "governed_skill_flow_revisions",
      "improvement_application_observations",
      "improvement_application_operations",
      "improvement_application_projections",
      "improvement_application_receipts",
      "improvement_application_reconciliations",
      "improvement_application_rollbacks",
      "improvement_application_validations",
      "improvement_decisions",
      "improvement_proposal_lifecycle",
      "improvement_proposal_revisions",
      "improvement_proposals",
      "runtime_template_revisions",
      "statistics_evidence_snapshots",
    ];
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const path = initialized.path;
    initialized.close();
    const database = new DatabaseSync(path);

    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (${expectedTables.map(() => "?").join(", ")})
            ORDER BY name`,
        )
        .all(...expectedTables)
        .map((row) => (row as { readonly name: string }).name),
      expectedTables,
    );

    database.exec(`
      UPDATE schema_metadata SET value = '51' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 52;
      PRAGMA user_version = 51;
    `);
    assert.equal(migrateCompanyDatabase(database), 52);
    assert.deepEqual(
      database
        .prepare(
          "SELECT version, name FROM schema_migrations WHERE version = 52",
        )
        .all()
        .map((row) => ({ ...row })),
      [{ version: 52, name: "improvement_proposal_foundation" }],
    );
    database.close();

    const upgradeDir = tempCompanyDir();
    const upgradeOpened = openCompanyDatabase(upgradeDir);
    const upgradePath = upgradeOpened.path;
    upgradeOpened.close();
    const upgrade = new DatabaseSync(upgradePath);
    upgrade.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS improvement_application_rollbacks;
      DROP TABLE IF EXISTS improvement_application_validations;
      DROP TABLE IF EXISTS improvement_application_reconciliations;
      DROP TABLE IF EXISTS improvement_application_observations;
      DROP TABLE IF EXISTS improvement_application_receipts;
      DROP TABLE IF EXISTS improvement_application_projections;
      DROP TABLE IF EXISTS improvement_application_operations;
      DROP TABLE IF EXISTS improvement_decisions;
      DROP TABLE IF EXISTS improvement_proposal_lifecycle;
      DROP TABLE IF EXISTS improvement_proposal_revisions;
      DROP TABLE IF EXISTS improvement_proposals;
      DROP TABLE IF EXISTS statistics_evidence_snapshots;
      DROP TABLE IF EXISTS governed_harness_revisions;
      DROP TABLE IF EXISTS runtime_template_revisions;
      DROP TABLE IF EXISTS governed_skill_flow_revisions;
      DELETE FROM schema_migrations WHERE version = 52;
      UPDATE schema_metadata SET value = '51' WHERE key = 'schema_version';
      PRAGMA user_version = 51;
    `);
    assert.equal(migrateCompanyDatabase(upgrade), 52);
    assert.deepEqual(
      upgrade
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (${expectedTables.map(() => "?").join(", ")})
            ORDER BY name`,
        )
        .all(...expectedTables)
        .map((row) => (row as { readonly name: string }).name),
      expectedTables,
    );
    upgrade.close();
  });

  it("rejects a partial v52 schema transactionally", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const path = initialized.path;
    initialized.close();
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TRIGGER statistics_evidence_snapshots_immutable_delete;
      UPDATE schema_metadata SET value = '51' WHERE key = 'schema_version';
      DELETE FROM schema_migrations WHERE version = 52;
      PRAGMA user_version = 51;
    `);

    assert.throws(
      () => migrateCompanyDatabase(database),
      /Existing T26 v52 schema is incompatible: statistics_evidence_snapshots_immutable_delete/,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "51",
    );
    assert.equal(
      database
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE name = 'statistics_evidence_snapshots_immutable_delete'",
        )
        .get(),
      undefined,
    );
    database.close();
  });

  it("enforces immutable lineage, exact decisions, authority pairs, and append-only application history in v52", () => {
    const companyDir = tempCompanyDir();
    openCompanyDatabase(companyDir).close();
    const database = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    database.exec("PRAGMA foreign_keys = ON");
    const hash = "a".repeat(64);
    const otherHash = "b".repeat(64);
    const timestamp = "2026-08-04T00:00:00.000Z";
    database
      .prepare(
        "INSERT INTO projects(id, company_id, name, goal, status, created_at) VALUES (?, 'company', ?, ?, 'active', ?)",
      )
      .run("project:t26", "T26", "Govern improvements", timestamp);
    database
      .prepare(
        "INSERT INTO projects(id, company_id, name, goal, status, created_at) VALUES (?, 'company', ?, ?, 'active', ?)",
      )
      .run("project:other", "Other", "Reject cross-project lineage", timestamp);

    const insertEvidence = database.prepare(`
      INSERT INTO statistics_evidence_snapshots(
        id, project_id, catalog_version, canonical_query_json, query_hash,
        as_of_sequence, observations_json, completeness_json,
        frozen_by_actor_type, frozen_by_actor_id, frozen_by_authenticated_by,
        snapshot_hash, command_id, created_at
      ) VALUES (?, ?, 'statistics@1', '{}', ?, 7, '[]', '{}', ?, 'runtime-worker:statistics', ?, ?, ?, ?)
    `);
    insertEvidence.run(
      "statistics-evidence:1",
      "project:t26",
      hash,
      "runtime-worker",
      "runtime",
      hash,
      "command:freeze-1",
      timestamp,
    );
    assert.throws(
      () =>
        insertEvidence.run(
          "statistics-evidence:invalid",
          "project:t26",
          hash,
          "human",
          "runtime",
          otherHash,
          "command:freeze-invalid",
          timestamp,
        ),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE statistics_evidence_snapshots SET observations_json = '[]' WHERE id = ?",
          )
          .run("statistics-evidence:1"),
      /Statistics evidence snapshot is immutable/,
    );

    database.exec(`
      INSERT INTO improvement_proposals(
        id, project_id, department_id, current_revision_id, revision, state,
        created_at, updated_at
      ) VALUES (
        'proposal:1', 'project:t26', NULL, 'proposal-revision:1', 1, 'draft',
        '${timestamp}', '${timestamp}'
      );
      INSERT INTO improvement_proposals(
        id, project_id, department_id, current_revision_id, revision, state,
        created_at, updated_at
      ) VALUES (
        'proposal:other', 'project:other', NULL, 'proposal-revision:other', 1, 'draft',
        '${timestamp}', '${timestamp}'
      );
    `);
    const insertRevision = database.prepare(`
      INSERT INTO improvement_proposal_revisions(
        id, proposal_id, project_id, revision, supersedes_revision_id,
        evidence_snapshot_id, evidence_snapshot_hash, target_kind, target_owner_id,
        governed_head_revision_id, governed_head_revision_hash, content_json,
        content_hash, authored_by_actor_type, authored_by_actor_id,
        authored_by_authenticated_by, command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'statistics-evidence:1', ?, 'harness',
        'harness:software-rnd-review', NULL, NULL, '{}', ?, 'runtime-worker',
        'runtime-worker:author', 'runtime', ?, ?)
    `);
    insertRevision.run(
      "proposal-revision:1",
      "proposal:1",
      "project:t26",
      1,
      null,
      hash,
      hash,
      "command:proposal-1",
      timestamp,
    );
    assert.throws(
      () =>
        insertRevision.run(
          "proposal-revision:other",
          "proposal:other",
          "project:other",
          1,
          "proposal-revision:1",
          hash,
          otherHash,
          "command:proposal-other",
          timestamp,
        ),
      /FOREIGN KEY constraint failed/,
    );

    const insertDecision = database.prepare(`
      INSERT INTO improvement_decisions(
        id, proposal_id, proposal_revision_id, proposal_revision_hash,
        evidence_snapshot_id, evidence_snapshot_hash, target_kind, target_owner_id,
        governed_head_revision_id, governed_head_revision_hash, decision,
        confirmation, actor_type, actor_id, authenticated_by, reason,
        evidence_refs_json, decision_hash, command_id, created_at
      ) VALUES (?, 'proposal:1', 'proposal-revision:1', ?,
        'statistics-evidence:1', ?, 'harness', 'harness:software-rnd-review',
        NULL, NULL, ?, 'I confirm', 'human', 'human:reviewer', 'local-session',
        'Evidence supports this decision', '["statistics-evidence:1"]', ?, ?, ?)
    `);
    insertDecision.run(
      "decision:1",
      hash,
      hash,
      "approved",
      hash,
      "command:decision-1",
      timestamp,
    );
    assert.throws(
      () =>
        insertDecision.run(
          "decision:duplicate",
          hash,
          hash,
          "rejected",
          otherHash,
          "command:decision-2",
          timestamp,
        ),
      /UNIQUE constraint failed: improvement_decisions.proposal_revision_id/,
    );

    database.exec(`
      INSERT INTO improvement_application_operations(
        id, project_id, proposal_id, proposal_revision_id, proposal_revision_hash,
        approved_decision_id, approved_decision_hash, target_kind, target_owner_id,
        governed_head_revision_id, governed_head_revision_hash, target_content_json,
        target_content_hash, canonical_request_json, canonical_request_hash,
        deterministic_effect_id, confirmation, reason, evidence_refs_json,
        actor_type, actor_id, authenticated_by, command_id, created_at
      ) VALUES (
        'operation:1', 'project:t26', 'proposal:1', 'proposal-revision:1', '${hash}',
        'decision:1', '${hash}', 'harness', 'harness:software-rnd-review', NULL, NULL,
        '{}', '${hash}', '{}', '${hash}', 'improvement-effect:operation:1:apply',
        'I confirm', 'Apply the approved revision', '["decision:1"]',
        'human', 'human:reviewer', 'local-session', 'command:apply-1', '${timestamp}'
      );
      INSERT INTO improvement_application_projections(
        operation_id, state, latest_error_code, latest_error_message, revision, updated_at
      ) VALUES ('operation:1', 'applying', NULL, NULL, 0, '${timestamp}');
      INSERT INTO improvement_application_receipts(
        id, operation_id, phase, disposition, target_revision_id,
        target_revision_hash, evidence_refs_json, receipt_hash, created_at
      ) VALUES (
        'receipt:1', 'operation:1', 'apply', 'applied', 'harness-revision:1',
        '${hash}', '["harness-revision:1"]', '${hash}', '${timestamp}'
      );
    `);
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE improvement_application_operations SET reason = ? WHERE id = ?",
          )
          .run("Changed", "operation:1"),
      /Improvement application intent is immutable/,
    );
    database
      .prepare(
        "UPDATE improvement_application_projections SET state = 'applied', revision = revision + 1 WHERE operation_id = ?",
      )
      .run("operation:1");
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE improvement_application_receipts SET disposition = 'failed' WHERE id = ?",
          )
          .run("receipt:1"),
      /Improvement application receipt is immutable/,
    );
    database.close();
  });

  it("rejects a future Test authority schema without rewriting its version", () => {
    const companyDir = tempCompanyDir();
    const initialized = openCompanyDatabase(companyDir);
    const path = initialized.path;
    initialized.close();
    const future = new DatabaseSync(path);
    future.exec(`
      UPDATE schema_metadata SET value = '53' WHERE key = 'schema_version';
      PRAGMA user_version = 53;
    `);
    assert.throws(
      () => migrateCompanyDatabase(future),
      /Unsupported company database schema version 53/,
    );
    assert.equal(
      (
        future
          .prepare(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
          )
          .get() as { readonly value: string }
      ).value,
      "53",
    );
    future.close();
  });
});
describe("Company database backups", () => {
  it("creates an online backup that can restore a closed company database", async () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    const backup = await database.backup();
    database.close();

    assert.equal(backup.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(existsSync(backup.path), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(backup.path).mode & 0o777, 0o600);
    }
    writeFileSync(join(companyDir, ".sandcastle", "company.sqlite"), "broken");

    await restoreCompanyDatabase(companyDir, backup.path);

    const restored = openCompanyDatabase(companyDir);
    try {
      assert.equal(restored.schemaVersion(), CURRENT_SCHEMA_VERSION);
    } finally {
      restored.close();
    }
  });
});

describe("Company database Integration executor wiring", () => {
  it("constructs the Runtime-owned validation and aggregate Review executors", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      assert.equal(
        existsSync(
          join(companyDir, ".sandcastle", "integration-validation-evidence"),
        ),
        true,
      );
      assert.equal(
        existsSync(
          join(companyDir, ".sandcastle", "integration-review-workspaces"),
        ),
        true,
      );
    } finally {
      database.close();
    }
  });
});

describe("Company catalog", () => {
  it("installs and inspects the built-in Software R&D Department", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      const departments = database.catalog.departments();
      const department = database.catalog.inspectDepartment("software-rnd");

      assert.equal(departments.length, 1);
      assert.equal(departments[0]?.id, "software-rnd");
      assert.equal(departments[0]?.builtIn, true);
      assert.equal(departments[0]?.publishedPipelineVersion, 2);
      assert.equal(department.name, "Software R&D");
      assert.equal(department.positions.length, 6);
      assert.ok(department.pipeline);
      assert.deepEqual(
        department.positions.map((position) => position.id),
        [
          "product-planner",
          "software-architect",
          "software-engineer",
          "reviewer",
          "evaluator",
          "delivery-coordinator",
        ],
      );
      assert.equal(
        department.positions.every(
          (position) => position.aiMember.positionId === position.id,
        ),
        true,
      );
      assert.equal(department.pipeline.status, "published");
      assert.equal(department.pipeline.version, 2);
      assert.equal(department.pipeline.nodes[0]?.type, "start");
      assert.equal(department.pipeline.nodes.at(-1)?.type, "complete");
    } finally {
      database.close();
    }
  });

  it("creates and lists Runtime-backed projects and departments", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      assert.deepEqual(database.catalog.projects(), []);

      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const department = database.catalog.createDepartment({ name: "Design" });

      assert.deepEqual(database.catalog.projects(), [project]);
      assert.deepEqual(database.catalog.departments().slice(1), [department]);
      assert.equal(project.status, "active");
      assert.equal(department.activeRuns, 0);
    } finally {
      database.close();
    }
  });

  it("updates Department name and description through the catalog", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      const updated = database.catalog.updateDepartment({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Product Engineering",
        description: "Builds and verifies product changes.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: "software-rnd-default",
      });

      assert.equal(updated.name, "Product Engineering");
      assert.equal(updated.description, "Builds and verifies product changes.");
      assert.equal(
        database.catalog.inspectDepartment("software-rnd").name,
        "Product Engineering",
      );
    } finally {
      database.close();
    }
  });

  it("archives a Department without deleting its deep read model", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      const archived = database.catalog.archiveDepartment({
        departmentId: "software-rnd",
        expectedRevision: 0,
      });

      assert.equal(archived.status, "archived");
      assert.equal(database.catalog.departments().length, 0);
      assert.equal(
        database.catalog.inspectDepartment("software-rnd").positions.length,
        6,
      );
    } finally {
      database.close();
    }
  });

  it("inspects a custom Department without a published Pipeline Version", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      const created = database.catalog.createDepartment({ name: "Design" });
      const inspected = database.catalog.inspectDepartment(created.id);

      assert.equal(inspected.name, "Design");
      assert.deepEqual(inspected.positions, []);
      assert.equal(inspected.pipeline, null);
    } finally {
      database.close();
    }
  });

  it("updates persistent Position and AI Member configuration together", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      const updated = database.catalog.updatePosition({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Software Engineer",
        responsibility: "Ships narrow, tested vertical slices.",
        aiMemberDisplayName: "Delivery Engineer",
        aiMemberProfile: "Delivers small, verified slices.",
        aiMemberResponsibilityMetadata: { focus: "delivery" },
        aiMemberStatus: "inactive",
      });
      const position = updated.positions.find(
        (candidate) => candidate.id === "software-engineer",
      );

      assert.equal(
        position?.responsibility,
        "Ships narrow, tested vertical slices.",
      );
      assert.equal(position?.aiMember.displayName, "Delivery Engineer");
      assert.equal(
        position?.aiMember.profile,
        "Delivers small, verified slices.",
      );
      assert.deepEqual(position?.aiMember.responsibilityMetadata, {
        focus: "delivery",
      });
      assert.equal(position?.aiMember.status, "inactive");
      assert.equal(position?.revision, 1);
    } finally {
      database.close();
    }
  });

  it("copies Department configuration with new Department, Position, AI Member, and Pipeline IDs", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    try {
      database.catalog.updatePosition({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Software Engineer",
        responsibility: "Ships copied vertical slices.",
        aiMemberDisplayName: "Copy Engineer",
        aiMemberProfile: "Copies configuration safely.",
        aiMemberResponsibilityMetadata: { mode: "copy" },
        aiMemberStatus: "inactive",
      });
      const pipeline = database.pipelineConfiguration.inspect("software-rnd");
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: {
          ...pipeline.draft.graph,
          nodes: pipeline.draft.graph.nodes.map((node) =>
            node.id === "implementation"
              ? { ...node, skillFlowId: "implementation-flow" }
              : node,
          ),
        },
      });
      database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });
      const source = database.catalog.inspectDepartment("software-rnd");
      const sourceSkills = database.skillConfiguration.inspect("software-rnd");
      const copied = database.catalog.copyDepartment({
        departmentId: "software-rnd",
        name: "Product Delivery",
      });

      assert.notEqual(copied.id, source.id);
      assert.equal(copied.name, "Product Delivery");
      assert.equal(copied.description, source.description);
      assert.equal(copied.status, "active");
      assert.equal(copied.builtIn, false);
      assert.deepEqual(
        copied.positions.map((position) => ({
          name: position.name,
          responsibility: position.responsibility,
          memberName: position.aiMember.displayName,
          memberStatus: position.aiMember.status,
        })),
        source.positions.map((position) => ({
          name: position.name,
          responsibility: position.responsibility,
          memberName: position.aiMember.displayName,
          memberStatus: position.aiMember.status,
        })),
      );
      assert.equal(
        copied.positions.every(
          (position) =>
            !source.positions.some(
              (sourcePosition) =>
                sourcePosition.id === position.id ||
                sourcePosition.aiMember.id === position.aiMember.id,
            ),
        ),
        true,
      );
      const copiedSkills = database.skillConfiguration.inspect(copied.id);
      assert.deepEqual(
        copiedSkills.positions.map((position) => ({
          name: position.name,
          skillIds: position.skillIds,
        })),
        sourceSkills.positions.map((position) => ({
          name: position.name,
          skillIds: position.skillIds,
        })),
      );
      assert.equal(
        copiedSkills.skillFlows.every(
          (flow) =>
            !sourceSkills.skillFlows.some(
              (sourceFlow) => sourceFlow.id === flow.id,
            ),
        ),
        true,
      );
      assert.deepEqual(
        copiedSkills.skillFlows.map((flow) => ({
          name: flow.name,
          skillIds: flow.skillIds,
          status: flow.status,
        })),
        sourceSkills.skillFlows.map((flow) => ({
          name: flow.name,
          skillIds: flow.skillIds,
          status: flow.status,
        })),
      );
      assert.ok(source.pipeline);
      assert.ok(copied.pipeline);
      assert.notEqual(copied.pipeline.id, source.pipeline.id);
      assert.deepEqual(
        copied.pipeline.nodes.map((node) => node.positionId).filter(Boolean),
        source.pipeline.nodes
          .map((node) => node.positionId)
          .filter(Boolean)
          .map((sourcePositionId) => {
            const sourceIndex = source.positions.findIndex(
              (position) => position.id === sourcePositionId,
            );
            return copied.positions[sourceIndex]?.id;
          }),
      );
      const copiedImplementationFlow = copiedSkills.skillFlows.find(
        (flow) => flow.name === "Implementation",
      );
      assert.ok(copiedImplementationFlow);
      assert.equal(
        copied.pipeline.nodes.find((node) => node.id === "implementation")
          ?.skillFlowId,
        copiedImplementationFlow.id,
      );
    } finally {
      database.close();
    }
  });
});
