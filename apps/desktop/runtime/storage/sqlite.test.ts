import assert from "node:assert/strict";
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
import { openCompanyDatabase, restoreCompanyDatabase } from "./sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-database-"));

const removeArtifactRegistry = (database: DatabaseSync): void => {
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

const removeCatalogAuditTriggers = (database: DatabaseSync): void => {
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'runtime_%'",
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
  database.exec(`
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
    INSERT INTO node_attempts_v17 SELECT * FROM node_attempts;
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
      assert.equal(database.schemaVersion(), 23);
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
          ],
        );
        assert.equal(
          (
            inspected.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
          23,
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
                 AND name IN ('runtime_audit_records', 'runtime_event_outbox', 'runtime_event_cursors')
               ORDER BY name`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "runtime_audit_records" },
            { name: "runtime_event_cursors" },
            { name: "runtime_event_outbox" },
          ],
        );
      } finally {
        inspected.close();
      }
    } finally {
      database.close();
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
      assert.equal(database.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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

      assert.equal(migrated.schemaVersion(), 23);
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

      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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
      assert.equal(migrated.schemaVersion(), 23);
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

  it("rejects a database created by a newer runtime without rewriting its version", () => {
    const companyDir = tempCompanyDir();
    const databasePath = join(companyDir, ".sandcastle", "company.sqlite");
    mkdirSync(join(companyDir, ".sandcastle"), { recursive: true });
    const future = new DatabaseSync(databasePath);
    future.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '24');
      PRAGMA user_version = 24;
    `);
    future.close();

    assert.throws(
      () => openCompanyDatabase(companyDir),
      /Unsupported company database schema version 24/,
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
        "24",
      );
      assert.equal(
        (
          inspected.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
        24,
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
});

describe("Company database backups", () => {
  it("creates an online backup that can restore a closed company database", async () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);

    const backup = await database.backup();
    database.close();

    assert.equal(backup.schemaVersion, 23);
    assert.equal(existsSync(backup.path), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(backup.path).mode & 0o777, 0o600);
    }
    writeFileSync(join(companyDir, ".sandcastle", "company.sqlite"), "broken");

    await restoreCompanyDatabase(companyDir, backup.path);

    const restored = openCompanyDatabase(companyDir);
    try {
      assert.equal(restored.schemaVersion(), 23);
    } finally {
      restored.close();
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
      assert.equal(department.positions.length, 5);
      assert.ok(department.pipeline);
      assert.deepEqual(
        department.positions.map((position) => position.id),
        [
          "product-planner",
          "software-architect",
          "software-engineer",
          "reviewer",
          "evaluator",
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
        5,
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
