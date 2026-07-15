import type { DatabaseSync } from "node:sqlite";
import {
  canonicalPipelineJson,
  pipelineHash,
} from "../pipeline/canonicalPipeline.js";

export const CURRENT_SCHEMA_VERSION = 20;

interface CompanyMigration {
  readonly version: number;
  readonly name: string;
  readonly migrate: (database: DatabaseSync) => void;
}

const migrations: readonly CompanyMigration[] = [
  {
    version: 1,
    name: "initial_schema",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: "company_overview_read_model",
    migrate: (database) => {
      database.exec(`
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
      `);
    },
  },
  {
    version: 3,
    name: "software_rnd_department_catalog",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE departments ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE departments ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1));
        ALTER TABLE departments ADD COLUMN active_pipeline_version_id TEXT;
        CREATE TABLE ai_members (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL REFERENCES departments(id),
          display_name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE positions (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL REFERENCES departments(id),
          name TEXT NOT NULL,
          responsibility TEXT NOT NULL,
          ai_member_id TEXT NOT NULL UNIQUE REFERENCES ai_members(id),
          sort_order INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE pipeline_versions (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL REFERENCES departments(id),
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          graph_json TEXT NOT NULL,
          published_at TEXT NOT NULL,
          UNIQUE (department_id, version)
        ) STRICT;
      `);

      const installedAt = "2026-07-14T00:00:00.000Z";
      database
        .prepare(
          "INSERT OR IGNORE INTO company_profile(id, name, default_locale, created_at) VALUES ('company', 'Sandcastle', 'en', ?)",
        )
        .run(installedAt);
      database
        .prepare(
          `INSERT OR IGNORE INTO departments(
             id, company_id, name, status, created_at, description, built_in, active_pipeline_version_id
           ) VALUES (?, 'company', ?, 'active', ?, ?, 1, ?)`,
        )
        .run(
          "software-rnd",
          "Software R&D",
          installedAt,
          "Turns product goals into reviewed and verified software delivery.",
          "software-rnd-pipeline-v1",
        );

      const positions = [
        {
          id: "product-planner",
          name: "Product Planner",
          responsibility:
            "Aligns product goals and turns requirements into reviewed plan inputs.",
          memberId: "product-planner-member",
          memberName: "Product Planner",
        },
        {
          id: "software-architect",
          name: "Software Architect",
          responsibility:
            "Produces the technical plan and repository-level delivery shape.",
          memberId: "software-architect-member",
          memberName: "Software Architect",
        },
        {
          id: "software-engineer",
          name: "Software Engineer",
          responsibility: "Implements and tests the approved delivery plan.",
          memberId: "software-engineer-member",
          memberName: "Software Engineer",
        },
        {
          id: "reviewer",
          name: "Reviewer",
          responsibility:
            "Independently reviews implementation and delivery risk.",
          memberId: "reviewer-member",
          memberName: "Reviewer",
        },
        {
          id: "evaluator",
          name: "Evaluator",
          responsibility:
            "Verifies acceptance criteria against recorded evidence.",
          memberId: "evaluator-member",
          memberName: "Evaluator",
        },
      ] as const;
      const insertMember = database.prepare(
        `INSERT OR IGNORE INTO ai_members(
           id, department_id, display_name, status, created_at
         ) VALUES (?, 'software-rnd', ?, 'available', ?)`,
      );
      const insertPosition = database.prepare(
        `INSERT OR IGNORE INTO positions(
           id, department_id, name, responsibility, ai_member_id, sort_order, created_at
         ) VALUES (?, 'software-rnd', ?, ?, ?, ?, ?)`,
      );
      positions.forEach((position, index) => {
        insertMember.run(position.memberId, position.memberName, installedAt);
        insertPosition.run(
          position.id,
          position.name,
          position.responsibility,
          position.memberId,
          index,
          installedAt,
        );
      });

      const graph = {
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "product-alignment",
            type: "ai-task",
            name: "Product alignment",
            positionId: "product-planner",
          },
          {
            id: "technical-plan",
            type: "ai-task",
            name: "Technical plan",
            positionId: "software-architect",
          },
          {
            id: "plan-approval",
            type: "human-approval",
            name: "Plan approval",
            positionId: "product-planner",
          },
          {
            id: "repository-execution",
            type: "parallel",
            name: "Repository execution",
          },
          {
            id: "implementation",
            type: "ai-task",
            name: "Implementation",
            positionId: "software-engineer",
          },
          { id: "join", type: "join", name: "Join" },
          {
            id: "review",
            type: "ai-task",
            name: "Review",
            positionId: "reviewer",
          },
          {
            id: "verification",
            type: "ai-task",
            name: "Verification",
            positionId: "evaluator",
          },
          {
            id: "human-acceptance",
            type: "human-approval",
            name: "Human acceptance",
            positionId: "evaluator",
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "product-alignment" },
          { from: "product-alignment", to: "technical-plan" },
          { from: "technical-plan", to: "plan-approval" },
          { from: "plan-approval", to: "repository-execution" },
          { from: "repository-execution", to: "implementation" },
          { from: "implementation", to: "join" },
          { from: "join", to: "review" },
          { from: "review", to: "verification" },
          { from: "verification", to: "human-acceptance" },
          { from: "human-acceptance", to: "complete" },
        ],
      };
      database
        .prepare(
          `INSERT OR IGNORE INTO pipeline_versions(
             id, department_id, version, status, graph_json, published_at
           ) VALUES (?, 'software-rnd', 1, 'published', ?, ?)`,
        )
        .run("software-rnd-pipeline-v1", JSON.stringify(graph), installedAt);
    },
  },
  {
    version: 4,
    name: "pipeline_drafts_and_version_hashes",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE pipeline_versions ADD COLUMN hash TEXT NOT NULL DEFAULT '';
        CREATE TABLE pipeline_drafts (
          department_id TEXT PRIMARY KEY REFERENCES departments(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          graph_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      const versions = database
        .prepare("SELECT id, graph_json AS graphJson FROM pipeline_versions")
        .all() as Array<{ readonly id: string; readonly graphJson: string }>;
      const update = database.prepare(
        "UPDATE pipeline_versions SET graph_json = ?, hash = ? WHERE id = ?",
      );
      for (const version of versions) {
        const graph = JSON.parse(version.graphJson) as unknown;
        update.run(
          canonicalPipelineJson(graph),
          pipelineHash(graph),
          version.id,
        );
      }
    },
  },
  {
    version: 5,
    name: "project_configuration",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
        ALTER TABLE projects ADD COLUMN shared_context TEXT NOT NULL DEFAULT '';
        CREATE TABLE project_repository_references (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          repository_ref TEXT NOT NULL,
          sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
          PRIMARY KEY (project_id, repository_ref),
          UNIQUE (project_id, sort_order)
        ) STRICT;
      `);
    },
  },
  {
    version: 6,
    name: "skill_configuration",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE skill_configuration_metadata (
          id TEXT PRIMARY KEY CHECK (id = 'company'),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE skills (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES company_profile(id),
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          source TEXT NOT NULL,
          version TEXT NOT NULL,
          location_ref TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        CREATE TABLE position_skill_bindings (
          position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES skills(id),
          bound_at TEXT NOT NULL,
          PRIMARY KEY (position_id, skill_id)
        ) STRICT;
        CREATE TABLE skill_flows (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
          position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          instructions TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        CREATE TABLE skill_flow_skills (
          skill_flow_id TEXT NOT NULL REFERENCES skill_flows(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES skills(id),
          sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
          PRIMARY KEY (skill_flow_id, skill_id),
          UNIQUE (skill_flow_id, sort_order)
        ) STRICT;
      `);

      const installedAt = "2026-07-14T00:00:00.000Z";
      database
        .prepare(
          "INSERT INTO skill_configuration_metadata(id, revision, updated_at) VALUES ('company', 0, ?)",
        )
        .run(installedAt);
      const skills = [
        {
          id: "grill-with-docs",
          name: "Grill with Docs",
          description:
            "Clarifies requirements and captures resolved domain decisions.",
        },
        {
          id: "domain-modeling",
          name: "Domain Modeling",
          description:
            "Sharpens the shared domain language and durable decisions.",
        },
        {
          id: "codebase-design",
          name: "Codebase Design",
          description: "Designs deep modules behind small interfaces.",
        },
        {
          id: "tdd",
          name: "Test-Driven Development",
          description: "Builds behavior through red-green vertical slices.",
        },
        {
          id: "diagnosing-bugs",
          name: "Diagnosing Bugs",
          description:
            "Reproduces and isolates failures before changing behavior.",
        },
        {
          id: "code-review",
          name: "Code Review",
          description:
            "Reviews delivery against repository standards and its specification.",
        },
        {
          id: "pre-release",
          name: "Pre-release",
          description: "Runs repository delivery checks before release.",
        },
      ] as const;
      const insertSkill = database.prepare(
        `INSERT INTO skills(
           id, company_id, name, description, source, version, location_ref,
           status, created_at, archived_at
         ) VALUES (?, 'company', ?, ?, 'sandcastle', '1', ?, 'active', ?, NULL)`,
      );
      for (const skill of skills) {
        insertSkill.run(
          skill.id,
          skill.name,
          skill.description,
          `skill://${skill.id}`,
          installedAt,
        );
      }

      const positionSkills = [
        ["product-planner", "domain-modeling"],
        ["product-planner", "grill-with-docs"],
        ["software-architect", "codebase-design"],
        ["software-architect", "domain-modeling"],
        ["software-engineer", "diagnosing-bugs"],
        ["software-engineer", "tdd"],
        ["reviewer", "code-review"],
        ["evaluator", "pre-release"],
      ] as const;
      const bindSkill = database.prepare(
        "INSERT INTO position_skill_bindings(position_id, skill_id, bound_at) VALUES (?, ?, ?)",
      );
      for (const [positionId, skillId] of positionSkills) {
        bindSkill.run(positionId, skillId, installedAt);
      }

      const flows = [
        {
          id: "product-alignment-flow",
          positionId: "product-planner",
          name: "Product Alignment",
          instructions:
            "Clarify the goal, non-goals, terminology, and acceptance criteria before planning.",
          skillIds: ["grill-with-docs", "domain-modeling"],
        },
        {
          id: "technical-planning-flow",
          positionId: "software-architect",
          name: "Technical Planning",
          instructions:
            "Shape the delivery around deep modules, stable seams, and the shared domain model.",
          skillIds: ["codebase-design", "domain-modeling"],
        },
        {
          id: "implementation-flow",
          positionId: "software-engineer",
          name: "Implementation",
          instructions:
            "Implement one verified vertical behavior at a time and diagnose failures before fixing them.",
          skillIds: ["tdd", "diagnosing-bugs"],
        },
        {
          id: "review-flow",
          positionId: "reviewer",
          name: "Delivery Review",
          instructions:
            "Review the implementation independently against its specification and repository standards.",
          skillIds: ["code-review"],
        },
        {
          id: "verification-flow",
          positionId: "evaluator",
          name: "Delivery Verification",
          instructions:
            "Verify acceptance criteria using recorded evidence and release checks.",
          skillIds: ["pre-release"],
        },
      ] as const;
      const insertFlow = database.prepare(
        `INSERT INTO skill_flows(
           id, department_id, position_id, name, instructions, revision,
           status, sort_order, created_at, updated_at, archived_at
         ) VALUES (?, 'software-rnd', ?, ?, ?, 0, 'active', ?, ?, ?, NULL)`,
      );
      const insertFlowSkill = database.prepare(
        "INSERT INTO skill_flow_skills(skill_flow_id, skill_id, sort_order) VALUES (?, ?, ?)",
      );
      flows.forEach((flow, flowIndex) => {
        insertFlow.run(
          flow.id,
          flow.positionId,
          flow.name,
          flow.instructions,
          flowIndex,
          installedAt,
          installedAt,
        );
        flow.skillIds.forEach((skillId, skillIndex) => {
          insertFlowSkill.run(flow.id, skillId, skillIndex);
        });
      });
    },
  },
  {
    version: 7,
    name: "phase_one_company_configuration",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE departments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
        ALTER TABLE departments ADD COLUMN input_artifact_contracts_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE departments ADD COLUMN output_artifact_contracts_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE departments ADD COLUMN default_execution_profile_id TEXT;
        ALTER TABLE positions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
        ALTER TABLE positions ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));
        ALTER TABLE ai_members ADD COLUMN profile TEXT NOT NULL DEFAULT '';
        ALTER TABLE ai_members ADD COLUMN responsibility_metadata_json TEXT NOT NULL DEFAULT '{}';
        UPDATE ai_members SET status = 'active' WHERE status = 'available';
        CREATE TABLE secret_references (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES company_profile(id),
          name TEXT NOT NULL,
          provider_scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        CREATE TABLE execution_profiles (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          provider_ref TEXT NOT NULL,
          model TEXT NOT NULL,
          sandbox_ref TEXT NOT NULL,
          branch_strategy TEXT NOT NULL CHECK (branch_strategy IN ('head', 'merge-to-head', 'branch')),
          timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds > 0),
          max_iterations INTEGER NOT NULL CHECK (max_iterations > 0),
          max_tokens INTEGER CHECK (max_tokens IS NULL OR max_tokens > 0),
          retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts >= 0),
          permission_policy TEXT NOT NULL CHECK (permission_policy IN ('ask', 'allow-safe', 'deny')),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        CREATE TABLE execution_profile_secret_references (
          execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id) ON DELETE CASCADE,
          secret_reference_id TEXT NOT NULL REFERENCES secret_references(id),
          sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
          PRIMARY KEY (execution_profile_id, secret_reference_id),
          UNIQUE (execution_profile_id, sort_order)
        ) STRICT;
      `);

      const installedAt = "2026-07-14T00:00:00.000Z";
      database
        .prepare(
          `INSERT INTO execution_profiles(
             id, department_id, name, provider_ref, model, sandbox_ref,
             branch_strategy, timeout_seconds, max_iterations, max_tokens,
             retry_max_attempts, permission_policy, revision, status,
             created_at, updated_at, archived_at
           ) VALUES (
             'software-rnd-default', 'software-rnd', 'Software R&D Default',
             'default-agent', 'default', 'no-sandbox', 'head', 1800, 10, NULL,
             1, 'ask', 0, 'active', ?, ?, NULL
           )`,
        )
        .run(installedAt, installedAt);
      database
        .prepare(
          "UPDATE departments SET default_execution_profile_id = 'software-rnd-default' WHERE id = 'software-rnd'",
        )
        .run();
    },
  },
  {
    version: 8,
    name: "pipeline_runtime_r1",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE department_runs ADD COLUMN pipeline_version_id TEXT REFERENCES pipeline_versions(id);
        ALTER TABLE department_runs ADD COLUMN snapshot_revision_id TEXT;
        ALTER TABLE department_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
        ALTER TABLE department_runs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        UPDATE department_runs SET updated_at = created_at WHERE updated_at = '';

        CREATE TABLE run_snapshot_revisions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision > 0),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          canonical_json TEXT NOT NULL,
          hash TEXT NOT NULL CHECK (length(hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (run_id, revision)
        ) STRICT;

        CREATE TABLE node_runs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          pipeline_node_id TEXT NOT NULL,
          node_type TEXT NOT NULL CHECK (
            node_type IN (
              'start', 'ai-task', 'human-approval', 'condition',
              'parallel', 'join', 'complete'
            )
          ),
          status TEXT NOT NULL CHECK (
            status IN (
              'queued', 'ready', 'running', 'waiting-permission',
              'waiting-approval', 'paused', 'succeeded', 'failed',
              'skipped', 'cancelled'
            )
          ),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          required_dependency_ids_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, pipeline_node_id)
        ) STRICT;

        CREATE INDEX node_runs_run_status_idx ON node_runs(run_id, status);
        CREATE INDEX department_runs_project_created_idx
          ON department_runs(project_id, created_at DESC);
      `);
    },
  },
  {
    version: 9,
    name: "node_attempt_recovery",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE node_attempts (
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
          UNIQUE (node_run_id, attempt_number)
        ) STRICT;

        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          cycle INTEGER NOT NULL CHECK (cycle > 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'decided')),
          decision TEXT CHECK (
            decision IS NULL OR
            decision IN ('approve', 'request-changes', 'reject')
          ),
          created_at TEXT NOT NULL,
          decided_at TEXT,
          CHECK (
            (status = 'pending' AND decision IS NULL AND decided_at IS NULL) OR
            (status = 'decided' AND decision IS NOT NULL AND decided_at IS NOT NULL)
          ),
          UNIQUE (node_run_id, cycle)
        ) STRICT;

        CREATE TABLE node_feedback (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          source_approval_id TEXT REFERENCES approvals(id),
          target_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
          kind TEXT NOT NULL CHECK (kind IN ('request-changes', 'retry')),
          content TEXT NOT NULL CHECK (
            length(trim(content)) BETWEEN 1 AND 10000
          ),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX node_attempts_node_run_idx
          ON node_attempts(node_run_id, attempt_number);
        CREATE INDEX approvals_run_idx ON approvals(run_id, node_run_id, cycle);
        CREATE INDEX node_feedback_attempt_idx
          ON node_feedback(target_attempt_id, created_at);

        INSERT INTO node_attempts(
          id, node_run_id, attempt_number, snapshot_revision_id, reason, status,
          structured_result_json, failure_code, failure_message,
          created_at, started_at, completed_at
        )
        SELECT
          node_runs.id || ':attempt:1',
          node_runs.id,
          1,
          department_runs.snapshot_revision_id,
          'initial',
          CASE node_runs.status
            WHEN 'succeeded' THEN 'succeeded'
            WHEN 'failed' THEN 'failed'
            WHEN 'running' THEN 'running'
            WHEN 'cancelled' THEN 'cancelled'
            ELSE 'ready'
          END,
          node_runs.result_json,
          node_runs.failure_code,
          node_runs.failure_message,
          node_runs.created_at,
          node_runs.created_at,
          CASE
            WHEN node_runs.status IN ('succeeded', 'failed', 'cancelled')
              THEN node_runs.updated_at
            ELSE NULL
          END
        FROM node_runs
        JOIN department_runs ON department_runs.id = node_runs.run_id
        WHERE node_runs.attempt_count > 0;

        INSERT INTO approvals(
          id, run_id, node_run_id, cycle, status, decision, created_at, decided_at
        )
        SELECT
          node_runs.id || ':approval:1',
          node_runs.run_id,
          node_runs.id,
          1,
          'pending',
          NULL,
          node_runs.created_at,
          NULL
        FROM node_runs
        WHERE node_runs.node_type = 'human-approval'
          AND node_runs.status = 'waiting-approval';

        INSERT INTO approvals(
          id, run_id, node_run_id, cycle, status, decision, created_at, decided_at
        )
        SELECT
          node_runs.id || ':approval:1',
          node_runs.run_id,
          node_runs.id,
          1,
          'decided',
          json_extract(node_runs.result_json, '$.decision'),
          node_runs.created_at,
          node_runs.updated_at
        FROM node_runs
        WHERE node_runs.node_type = 'human-approval'
          AND node_runs.status IN ('succeeded', 'failed')
          AND json_extract(node_runs.result_json, '$.decision') IN ('approve', 'reject');
      `);
    },
  },
  {
    version: 10,
    name: "node_attempt_leases",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE node_attempts ADD COLUMN lease_id TEXT;
        ALTER TABLE node_attempts ADD COLUMN lease_owner TEXT;
        ALTER TABLE node_attempts ADD COLUMN lease_expires_at TEXT;
        ALTER TABLE node_attempts ADD COLUMN checkpoint_json TEXT;
        ALTER TABLE node_attempts ADD COLUMN recoverable INTEGER NOT NULL DEFAULT 0
          CHECK (recoverable IN (0, 1));

        CREATE INDEX node_attempts_ready_lease_idx
          ON node_attempts(node_run_id, status, lease_expires_at);
      `);
    },
  },
  {
    version: 11,
    name: "department_run_controls",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE department_runs ADD COLUMN paused_from_status TEXT
          CHECK (
            paused_from_status IS NULL OR
            paused_from_status IN (
              'ready', 'running', 'waiting-approval', 'blocked', 'recovering'
            )
          );
      `);
    },
  },
  {
    version: 12,
    name: "snapshot_revision_parent_links",
    migrate: (database) => {
      database.exec(
        "ALTER TABLE run_snapshot_revisions ADD COLUMN parent_revision INTEGER",
      );
    },
  },
  {
    version: 13,
    name: "runtime_audit_and_event_outbox",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE runtime_audit_records (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          run_id TEXT,
          node_run_id TEXT,
          before_json TEXT,
          after_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX runtime_audit_run_idx
          ON runtime_audit_records(run_id, created_at, id);

        CREATE TABLE runtime_event_outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          run_id TEXT,
          node_run_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          delivered_at TEXT
        ) STRICT;

        CREATE INDEX runtime_event_outbox_pending_idx
          ON runtime_event_outbox(delivered_at, sequence);

        CREATE TABLE runtime_event_cursors (
          consumer_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 14,
    name: "artifact_versions_and_lineage",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE artifacts ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1';

        CREATE TABLE artifact_versions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK (version > 0),
          content_ref TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          status TEXT NOT NULL CHECK (status IN ('draft', 'produced', 'accepted', 'rejected', 'superseded')),
          producing_run_id TEXT REFERENCES department_runs(id),
          producing_node_run_id TEXT REFERENCES node_runs(id),
          producing_node_attempt_id TEXT REFERENCES node_attempts(id),
          snapshot_revision_id TEXT REFERENCES run_snapshot_revisions(id),
          ai_member_id TEXT REFERENCES ai_members(id),
          created_at TEXT NOT NULL,
          UNIQUE (artifact_id, version)
        ) STRICT;

        CREATE INDEX artifact_versions_run_idx
          ON artifact_versions(producing_run_id, producing_node_run_id);

        CREATE TABLE artifact_links (
          from_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          to_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (from_version_id, to_version_id, relation)
        ) STRICT;
      `);
    },
  },
  {
    version: 15,
    name: "fork_run_links",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE department_runs ADD COLUMN parent_run_id TEXT REFERENCES department_runs(id);
        ALTER TABLE department_runs ADD COLUMN forked_from_snapshot_revision_id TEXT;
        ALTER TABLE node_runs ADD COLUMN source_node_run_id TEXT REFERENCES node_runs(id);
        CREATE INDEX department_runs_parent_idx
          ON department_runs(parent_run_id, created_at);
      `);
    },
  },
  {
    version: 16,
    name: "interaction_sessions_permissions",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE interaction_sessions (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL CHECK (mode IN ('consultation', 'run-collaboration')),
          project_id TEXT NOT NULL REFERENCES projects(id),
          run_id TEXT REFERENCES department_runs(id),
          node_run_id TEXT REFERENCES node_runs(id),
          status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
          created_at TEXT NOT NULL,
          closed_at TEXT
        ) STRICT;

        CREATE INDEX interaction_sessions_project_idx
          ON interaction_sessions(project_id, created_at);

        CREATE TABLE session_participants (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
          participant_type TEXT NOT NULL CHECK (participant_type IN ('human', 'ai-member', 'system')),
          participant_ref TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE session_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
          participant_id TEXT NOT NULL REFERENCES session_participants(id),
          kind TEXT NOT NULL CHECK (kind IN ('text', 'tool', 'status')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX session_messages_session_idx
          ON session_messages(session_id, created_at, id);

        CREATE TABLE permission_requests (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES department_runs(id),
          node_run_id TEXT REFERENCES node_runs(id),
          scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
          expires_at TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT
        ) STRICT;

        CREATE INDEX permission_requests_session_idx
          ON permission_requests(session_id, created_at, id);
      `);
    },
  },
  {
    version: 17,
    name: "memory_candidates_and_records",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE memory_candidates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          scope TEXT NOT NULL CHECK (scope IN ('project', 'ai-member')),
          ai_member_id TEXT REFERENCES ai_members(id),
          source_session_id TEXT REFERENCES interaction_sessions(id),
          source_run_id TEXT REFERENCES department_runs(id),
          source_artifact_version_id TEXT REFERENCES artifact_versions(id),
          summary TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'discarded')),
          created_at TEXT NOT NULL,
          reviewed_at TEXT
        ) STRICT;

        CREATE INDEX memory_candidates_project_idx
          ON memory_candidates(project_id, status, created_at);

        CREATE TABLE memory_records (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          scope TEXT NOT NULL CHECK (scope IN ('project', 'ai-member')),
          owner_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          UNIQUE (scope, owner_id, version)
        ) STRICT;
      `);
    },
  },
  {
    version: 18,
    name: "node_attempt_recovery_reason",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE node_attempts_v18 (
          id TEXT PRIMARY KEY,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          reason TEXT NOT NULL CHECK (
            reason IN ('initial', 'request-changes', 'retry', 'recovery')
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

        INSERT INTO node_attempts_v18(
          id, node_run_id, attempt_number, snapshot_revision_id, reason,
          status, structured_result_json, failure_code, failure_message,
          created_at, started_at, completed_at, lease_id, lease_owner,
          lease_expires_at, checkpoint_json, recoverable
        )
        SELECT
          id, node_run_id, attempt_number, snapshot_revision_id, reason,
          status, structured_result_json, failure_code, failure_message,
          created_at, started_at, completed_at, lease_id, lease_owner,
          lease_expires_at, checkpoint_json, recoverable
        FROM node_attempts;

        DROP INDEX node_attempts_node_run_idx;
        DROP INDEX node_attempts_ready_lease_idx;
        DROP TABLE node_attempts;
        ALTER TABLE node_attempts_v18 RENAME TO node_attempts;

        CREATE INDEX node_attempts_node_run_idx
          ON node_attempts(node_run_id, attempt_number);
        CREATE INDEX node_attempts_ready_lease_idx
          ON node_attempts(node_run_id, status, lease_expires_at);
      `);
    },
  },
  {
    version: 19,
    name: "catalog_runtime_audit_triggers",
    migrate: (database) => {
      const tables = [
        { table: "projects", entity: "project", id: "NEW.id" },
        { table: "departments", entity: "department", id: "NEW.id" },
        { table: "positions", entity: "position", id: "NEW.id" },
        { table: "ai_members", entity: "ai-member", id: "NEW.id" },
        {
          table: "execution_profiles",
          entity: "execution-profile",
          id: "NEW.id",
        },
        {
          table: "secret_references",
          entity: "secret-reference",
          id: "NEW.id",
        },
        { table: "skills", entity: "skill", id: "NEW.id" },
        { table: "skill_flows", entity: "skill-flow", id: "NEW.id" },
        {
          table: "pipeline_drafts",
          entity: "pipeline-draft",
          id: "NEW.department_id",
        },
        {
          table: "pipeline_versions",
          entity: "pipeline-version",
          id: "NEW.id",
        },
        {
          table: "position_skill_bindings",
          entity: "position-skill-binding",
          id: "NEW.position_id || ':' || NEW.skill_id",
        },
      ] as const;
      for (const table of tables) {
        for (const operation of ["created", "updated", "deleted"] as const) {
          const timing =
            operation === "created"
              ? "INSERT"
              : operation === "updated"
                ? "UPDATE"
                : "DELETE";
          const reference =
            operation === "deleted"
              ? table.id.replaceAll("NEW.", "OLD.")
              : table.id;
          const payload = `json_object('entityId', ${reference}, 'operation', '${operation}')`;
          database.exec(`
            CREATE TRIGGER IF NOT EXISTS runtime_${table.table}_${operation}
            AFTER ${timing} ON ${table.table}
            BEGIN
              INSERT INTO runtime_audit_records(
                id, action, entity_type, entity_id, run_id, node_run_id,
                before_json, after_json, created_at
              ) VALUES (
                lower(hex(randomblob(16))),
                'catalog.${table.entity}.${operation}',
                '${table.entity}',
                ${reference},
                NULL,
                NULL,
                ${operation === "created" ? "NULL" : payload},
                ${operation === "deleted" ? "NULL" : payload},
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              );
              INSERT INTO runtime_event_outbox(
                event_id, type, run_id, node_run_id, payload_json, created_at
              ) VALUES (
                lower(hex(randomblob(16))),
                '${table.entity}.${operation}',
                NULL,
                NULL,
                ${payload},
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              );
            END;
          `);
        }
      }
    },
  },
  {
    version: 20,
    name: "software_rnd_production_skill_flows",
    migrate: (database) => {
      const active = database
        .prepare(
          `SELECT active_pipeline_version_id AS activePipelineVersionId
             FROM departments
            WHERE id = 'software-rnd' AND built_in = 1`,
        )
        .get() as
        | { readonly activePipelineVersionId?: string | null }
        | undefined;
      if (active?.activePipelineVersionId !== "software-rnd-pipeline-v1") {
        return;
      }

      const version = database
        .prepare(
          `SELECT id, version, graph_json AS graphJson
             FROM pipeline_versions
            WHERE id = 'software-rnd-pipeline-v1'`,
        )
        .get() as
        | {
            readonly id: string;
            readonly version: number;
            readonly graphJson: string;
          }
        | undefined;
      if (!version) return;

      const flowByNodeId = new Map([
        ["product-alignment", "product-alignment-flow"],
        ["technical-plan", "technical-planning-flow"],
        ["implementation", "implementation-flow"],
        ["review", "review-flow"],
        ["verification", "verification-flow"],
      ]);
      const flowSnapshots = new Map<string, Record<string, unknown>>();
      for (const [nodeId, flowId] of flowByNodeId) {
        const flow = database
          .prepare(
            `SELECT id, revision, name, instructions
               FROM skill_flows
              WHERE id = ? AND department_id = 'software-rnd' AND status = 'active'`,
          )
          .get(flowId) as
          | {
              readonly id: string;
              readonly revision: number;
              readonly name: string;
              readonly instructions: string;
            }
          | undefined;
        if (!flow) return;
        const skillIds = database
          .prepare(
            `SELECT skill_id AS skillId
               FROM skill_flow_skills
              WHERE skill_flow_id = ?
           ORDER BY sort_order`,
          )
          .all(flow.id)
          .map((row) => (row as { readonly skillId: string }).skillId);
        flowSnapshots.set(nodeId, {
          id: flow.id,
          revision: Number(flow.revision),
          name: flow.name,
          instructions: flow.instructions,
          skillIds,
        });
      }

      const graph = JSON.parse(version.graphJson) as {
        readonly nodes: readonly Record<string, unknown>[];
        readonly edges: readonly Record<string, unknown>[];
      };
      const correctedGraph = {
        ...graph,
        nodes: graph.nodes.map((node) => {
          const nodeId = typeof node.id === "string" ? node.id : undefined;
          const flowId = nodeId ? flowByNodeId.get(nodeId) : undefined;
          const snapshot = nodeId ? flowSnapshots.get(nodeId) : undefined;
          return flowId && snapshot
            ? { ...node, skillFlowId: flowId, skillFlowSnapshot: snapshot }
            : node;
        }),
      };
      const graphJson = canonicalPipelineJson(correctedGraph);
      const hash = pipelineHash(correctedGraph);
      const correctedId = "software-rnd-pipeline-production-v1";
      const nextVersion =
        Number(
          (
            database
              .prepare(
                "SELECT COALESCE(MAX(version), 0) AS version FROM pipeline_versions WHERE department_id = 'software-rnd'",
              )
              .get() as { readonly version: number }
          ).version,
        ) + 1;
      database
        .prepare(
          `INSERT OR IGNORE INTO pipeline_versions(
             id, department_id, version, status, graph_json, published_at, hash
           ) VALUES (?, 'software-rnd', ?, 'published', ?, '2026-07-15T00:00:00.000Z', ?)`,
        )
        .run(correctedId, nextVersion, graphJson, hash);
      database
        .prepare(
          "UPDATE departments SET active_pipeline_version_id = ? WHERE id = 'software-rnd' AND active_pipeline_version_id = ?",
        )
        .run(correctedId, version.id);
    },
  },
];

const schemaMetadataExists = (database: DatabaseSync): boolean =>
  database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_metadata'",
    )
    .get() !== undefined;

const readSchemaVersion = (database: DatabaseSync): number => {
  if (!schemaMetadataExists(database)) return 0;
  const row = database
    .prepare("SELECT value FROM schema_metadata WHERE key = ?")
    .get("schema_version") as { readonly value?: unknown } | undefined;
  if (row === undefined) return 0;
  if (typeof row.value !== "string" || !/^\d+$/.test(row.value)) {
    throw new Error("Company database schema version is invalid.");
  }
  return Number(row.value);
};

const recordMigration = (
  database: DatabaseSync,
  migration: CompanyMigration,
): void => {
  database
    .prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
    )
    .run(migration.version, migration.name, new Date().toISOString());
};

export const migrateCompanyDatabase = (database: DatabaseSync): number => {
  const existingVersion = readSchemaVersion(database);
  if (existingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported company database schema version ${existingVersion}.`,
    );
  }

  const rebuildsNodeAttempts = existingVersion < 18;
  const foreignKeysEnabled = Number(
    (
      database.prepare("PRAGMA foreign_keys").get() as
        | { readonly foreign_keys?: unknown }
        | undefined
    )?.foreign_keys,
  );
  if (rebuildsNodeAttempts && foreignKeysEnabled === 1) {
    database.exec("PRAGMA foreign_keys = OFF");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations) {
      if (migration.version > existingVersion) migration.migrate(database);
      if (migration.version <= CURRENT_SCHEMA_VERSION) {
        recordMigration(database, migration);
      }
    }
    database
      .prepare(
        "INSERT INTO schema_metadata(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(CURRENT_SCHEMA_VERSION));
    if (
      rebuildsNodeAttempts &&
      database.prepare("PRAGMA foreign_key_check").all().length > 0
    ) {
      throw new Error("Company database migration violated foreign keys.");
    }
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    database.exec("COMMIT");
    return CURRENT_SCHEMA_VERSION;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    if (rebuildsNodeAttempts && foreignKeysEnabled === 1) {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
};
