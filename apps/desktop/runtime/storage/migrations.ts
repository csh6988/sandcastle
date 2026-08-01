import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalPipelineJson,
  pipelineHash,
} from "../pipeline/canonicalPipeline.js";
import { defaultNodeHandlerRegistry } from "../pipeline/nodeHandlerRegistry.js";

export const CURRENT_SCHEMA_VERSION = 50;

interface CompanyMigration {
  readonly version: number;
  readonly name: string;
  readonly migrate: (database: DatabaseSync) => void;
}

const TEST_V48_SCHEMA_REFERENCE = [
  [
    "table",
    "test_assertion_results",
    "dec5b0dc6d0e7dda359fb92e9b6851eacbe22170a48e3fd9fee20511433ecc78",
  ],
  [
    "trigger",
    "test_assertion_results_immutable_delete",
    "6116d8c870820b8dec3ab7293fd6807155418297729d08a74b507c3ac8cd5111",
  ],
  [
    "trigger",
    "test_assertion_results_immutable_update",
    "f7810bcd1e64ec1cbf5b8b8fe97603846741b6ec22be33414ae3c665d955b87f",
  ],
  [
    "trigger",
    "test_assertion_results_terminal_run_insert",
    "400a5f3901e45db10a8fa2c64fcb5929e135644ddbd9e69a41c964d1af5865ac",
  ],
  [
    "table",
    "test_case_revisions",
    "17c7a1644fe1065fea5d336b13b2d8410dd162060eae453632ff070c0458389c",
  ],
  [
    "index",
    "test_case_revisions_case_idx",
    "28aeae05a5923e4fe64bab4bed5c6f19dea4b614eed761f945576385a1ef85fd",
  ],
  [
    "trigger",
    "test_case_revisions_immutable_delete",
    "ec7a1009a94f66d63e7bfb957c346a10a2103fc2c51c65387a2b2d3f4c2836d2",
  ],
  [
    "trigger",
    "test_case_revisions_immutable_update",
    "904bc7e1e7a7a66c812040a72590a6d885206dce2ef2206c69f384fc9e90c669",
  ],
  [
    "table",
    "test_cases",
    "cadfc03e7f09f6e362fb780ee220ddc5687e53eb9ea3e8f5f6958837b6f3951d",
  ],
  [
    "trigger",
    "test_cases_immutable_delete",
    "460f225de0a6f4324e4283f3671a14d7e5d0b52287cd057435f9b57300a20a4a",
  ],
  [
    "trigger",
    "test_cases_immutable_update",
    "ffb292161f5cc19a5420d04f243d91f9a17e26c209193610cb8abccc4cbb9862",
  ],
  [
    "table",
    "test_defect_resolutions",
    "ad99aab5ea852585e611feeefa24bf6891a2f25350b9b637ea8a3a28fdf6d64a",
  ],
  [
    "index",
    "test_defect_resolutions_defect_idx",
    "b9077a567ad37a93b40b0839ebe2473dbf2e4f46f07711b8196890b0d5b10e45",
  ],
  [
    "trigger",
    "test_defect_resolutions_immutable_delete",
    "6021e6c0701593d5b681392d4bae3b7d3f685af68a637ac30388f6f655fd7543",
  ],
  [
    "trigger",
    "test_defect_resolutions_immutable_update",
    "fc3fc708749994231e6c87a1aa05efa11e370df28a627b84dd4c39484cfc1dbb",
  ],
  [
    "table",
    "test_defects",
    "d713ab3c2ff45cc638b0b5b3346edd50891f24997788814da0914785215a746f",
  ],
  [
    "trigger",
    "test_defects_identity_update",
    "be409a1e0a235e15db80081a9fab9a95dedb9b3dd4632b3f38e6a52be8b50d95",
  ],
  [
    "trigger",
    "test_defects_immutable_delete",
    "9cd1eb5fb78f0ef92a2ee096e01972b189a27ad27636922071f56e67756f4239",
  ],
  [
    "index",
    "test_defects_run_idx",
    "02adaf22ab74bbe9660b6f44f67bf9120bf543e9e49ed15ec22c37e815b26cf4",
  ],
  [
    "trigger",
    "test_defects_terminal_run_insert",
    "d76c178afc90eb0957f066230405492e26adf81783922977b7c49f4d35b8b2f2",
  ],
  [
    "table",
    "test_evidence",
    "5278597b5ec60708a56c555c6e6e4c40373acabfd740471e516a2c0c292ec952",
  ],
  [
    "trigger",
    "test_evidence_immutable_delete",
    "3b383cbf5ac083f4e9e87d8d14f4b3fe6b926912cf1c5df2af9fd13fc2dc9c45",
  ],
  [
    "trigger",
    "test_evidence_immutable_update",
    "58c246709008c39fa12414a3c13b59f75ae91db9d70cbdd1e0cbfc4edc589f99",
  ],
  [
    "index",
    "test_evidence_run_idx",
    "6e61fcbee21942bef73a526811705c093edc13a07287e64247c7328b81e92c6a",
  ],
  [
    "trigger",
    "test_evidence_terminal_run_insert",
    "b7113d98a0e89f2c9e38a5334a14d8ac4a056ad3987f97a60bf9a7b3bfd1875b",
  ],
  [
    "table",
    "test_execution_control_operations",
    "af8375da0407f07ddaaa664c10f2b3469ae081babc497590674cd3546ab4af18",
  ],
  [
    "trigger",
    "test_execution_control_operations_identity_update",
    "6fe0b65f79d4a1db46034c081a130464a2bc0b22d1efbc16c0ac7fd358626ef7",
  ],
  [
    "trigger",
    "test_execution_control_operations_immutable_delete",
    "65e921db83a0dbdc327a502c569c6977ec48859943e42622d049279775044ae9",
  ],
  [
    "index",
    "test_execution_control_operations_state_idx",
    "539ee4e6b909589438f0cfc2c7beeb8d6fc29248b765e8acd801501dad8f2272",
  ],
  [
    "trigger",
    "test_execution_control_operations_terminal_update",
    "7e987de0f68446427cb84311adacf7e6089be7e39a927c85aed2dea39ebe3a63",
  ],
  [
    "table",
    "test_execution_facts",
    "ee58f23e1764258be4874eacd132430d33e21824dad347c5cbbf037db54a27f7",
  ],
  [
    "trigger",
    "test_execution_facts_immutable_delete",
    "b9b534560aa1f586547a670e355ad0a02a49abc6fe1710137a1741173e98a78d",
  ],
  [
    "trigger",
    "test_execution_facts_immutable_update",
    "1236053de57663398515994e5b0ad5ba9ea47a4feeea1307318fe718b6a4a630",
  ],
  [
    "trigger",
    "test_execution_facts_terminal_run_insert",
    "387fbe3639ed338fe21b53519faf5d4d6b6bbd381ffe3aacbddbd68949e3be3b",
  ],
  [
    "table",
    "test_execution_operations",
    "ace2ab90e3fe308bafa745261fd0d5e4da05ad98329ccfcbc44eec575e675e93",
  ],
  [
    "trigger",
    "test_execution_operations_identity_update",
    "2f8b403fec7ca17ce1cbba14def0a9eabc10fd1d2f7f62815ae9c6f0975ae086",
  ],
  [
    "trigger",
    "test_execution_operations_immutable_delete",
    "6356d6fe245e5464d0f37e3df150cbd9e2c7e61e501985b5bbdea8ac113527c0",
  ],
  [
    "index",
    "test_execution_operations_state_idx",
    "7d479d146bbba16637edaf94055baffa3987943deaf7171ec13174cceb21c809",
  ],
  [
    "trigger",
    "test_execution_operations_terminal_run_insert",
    "2825aee66108bcc0c8afab98d0a3d672723241363f6ee6836cf213c011e5fe39",
  ],
  [
    "trigger",
    "test_execution_operations_terminal_run_update",
    "83ed35e3d23341d446191138791edcc8dd93513e55b7af119ba7d644fbfbf23e",
  ],
  [
    "trigger",
    "test_execution_operations_terminal_update",
    "4cf15d0fe95203590a52cdae75e08e104f6396bccddfb47adc379e897dd9040b",
  ],
  [
    "table",
    "test_rework_runs",
    "e76c2a83e84d5f5888ae767c62889d8abd0028f02ac06b125b2a35b39bc4c8df",
  ],
  [
    "index",
    "test_rework_runs_defect_idx",
    "6c85c3ee49f81bfe78404be8aa5c4d468c766240cd518b57dfadcf5f85ff27ea",
  ],
  [
    "trigger",
    "test_rework_runs_immutable_delete",
    "591bc939f8a8131e65965f768ec581dd94347d12a0e4403040d64a65981b215e",
  ],
  [
    "trigger",
    "test_rework_runs_immutable_update",
    "4fbf24fd9c7acc879ac0d34e5864ef298d7c3a477c53abf205488712a8f45631",
  ],
  [
    "table",
    "test_run_case_revisions",
    "66c28d8d6fcf4c88c4e6b9530931bfe074e5d023c86065cb4ef8378e4ba688cb",
  ],
  [
    "trigger",
    "test_run_case_revisions_immutable_delete",
    "1b619c1b92f1339e925eeced3e223fc46ae1eb2baceae0814a943cf583888378",
  ],
  [
    "trigger",
    "test_run_case_revisions_immutable_update",
    "ce7c678b19defce2ab0005c744e03e3d0c56b0f53e63b26713e2fa89d7e80606",
  ],
  [
    "trigger",
    "test_run_case_revisions_terminal_insert",
    "871b14e3acbe1e3b3e302f0d63c7e08cd115da2c3e3808f5f95a7e30cdfc015d",
  ],
  [
    "table",
    "test_run_obligation_resolutions",
    "d4194390b12458fa127d1d42c8714f138ddbbf1ded2518acd6c9facf05642e28",
  ],
  [
    "trigger",
    "test_run_obligation_resolutions_immutable_delete",
    "0a67cfffb03b4bb08a584af9889ec4ef248e7678f84442d6ba31f0c647acb7e3",
  ],
  [
    "trigger",
    "test_run_obligation_resolutions_immutable_update",
    "8336c84edd0e23720cc218928782a42040a47eb19a88beee251847df7c459a1e",
  ],
  [
    "table",
    "test_run_obligations",
    "d78810783757c5e23198e60c92b7cf351a89a61f6168d4347884c5e38d3cce88",
  ],
  [
    "trigger",
    "test_run_obligations_identity_update",
    "610e4a51344f9080e936fa43c66c9f4d1b2a6c5a6857bbdfaa4684a230d6057a",
  ],
  [
    "trigger",
    "test_run_obligations_immutable_delete",
    "0d255cc80754cdcbfb1538cdf01231ab449462714958918c110b9bf508448ead",
  ],
  [
    "index",
    "test_run_obligations_run_idx",
    "12a3689c249eda2944bc5d1782bc815efd9e6432cfb63b786ba446b7953abe3e",
  ],
  [
    "trigger",
    "test_run_obligations_terminal_run_insert",
    "e6bb8cad27de4982b8f7164d178ede8b963876dfdd5e93873038246cba0cceb6",
  ],
  [
    "table",
    "test_runs",
    "6d363fb153b8270edf40cad33b78d78738d0672c6233838844fcdac894ee15ee",
  ],
  [
    "trigger",
    "test_runs_identity_update",
    "054d9b4e9390dbb229f661a7f1be1a27274b6c6eb923cf51923536cafdaa709f",
  ],
  [
    "trigger",
    "test_runs_immutable_delete",
    "12f8cbe40f1f8b60001da17ad53814c9567fc218a1661eb18d5a080854514787",
  ],
  [
    "index",
    "test_runs_run_idx",
    "52045a225d128f721928bbf9d5770ed6d743be1ab8d73c7148d09a2165ab9548",
  ],
  [
    "index",
    "test_runs_state_idx",
    "6cee537405636c9be27588a58fc04eac2874c7ed87ddccff81b14b73875ac146",
  ],
  [
    "trigger",
    "test_runs_terminal_update",
    "1ff646e12e0da3c13f75f873941d3c9a929a2857d75e83697f2e6888757421a5",
  ],
] as const;

const tableExists = (database: DatabaseSync, table: string): boolean =>
  database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
    )
    .get(table) !== undefined;

const columnExists = (
  database: DatabaseSync,
  table: string,
  column: string,
): boolean =>
  tableExists(database, table) &&
  database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .some((entry) => (entry as { readonly name?: unknown }).name === column);

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
  {
    version: 21,
    name: "local_agent_detection_results",
    migrate: (database) => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS agent_detection_results (
          adapter_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (
            status IN ('installed', 'not-installed', 'detection-failed')
          ),
          version TEXT,
          executable_path TEXT,
          last_detected_at TEXT NOT NULL,
          error_code TEXT
        ) STRICT;
      `);
    },
  },
  {
    version: 22,
    name: "position_default_agent_bindings",
    migrate: (database) => {
      const hasDefaultAgent = database
        .prepare("PRAGMA table_info(positions)")
        .all()
        .some(
          (column) =>
            typeof column === "object" &&
            column !== null &&
            "name" in column &&
            column.name === "default_agent_id",
        );
      if (!hasDefaultAgent) {
        database.exec(
          "ALTER TABLE positions ADD COLUMN default_agent_id TEXT NOT NULL DEFAULT 'codex'",
        );
      }
    },
  },
  {
    version: 23,
    name: "local_skill_discovery_catalog",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_source_directories (
          path TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS skill_discovery_entries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          source_directory TEXT NOT NULL,
          location_ref TEXT NOT NULL UNIQUE,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('discovered', 'enabled', 'unavailable', 'archived')
          ),
          discovered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 24,
    name: "command_envelopes_and_receipts",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS command_deduplication (
          command_id TEXT PRIMARY KEY,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          authenticated_by TEXT NOT NULL,
          consumer_id TEXT,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          status TEXT NOT NULL CHECK (status = 'completed'),
          result_json TEXT NOT NULL,
          result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
          effect_ids_json TEXT NOT NULL,
          completed_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS runtime_unit_of_work_context (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          command_id TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          authenticated_by TEXT NOT NULL,
          consumer_id TEXT,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0)
        ) STRICT;
      `);

      const auditColumns = new Set(
        database
          .prepare("PRAGMA table_info(runtime_audit_records)")
          .all()
          .map((column) => (column as { readonly name: string }).name),
      );
      for (const column of [
        "command_id",
        "actor_type",
        "actor_id",
        "authenticated_by",
        "consumer_id",
      ]) {
        if (!auditColumns.has(column)) {
          database.exec(
            `ALTER TABLE runtime_audit_records ADD COLUMN ${column} TEXT`,
          );
        }
      }

      const triggers = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'runtime_%'",
        )
        .all() as Array<{ readonly name: string }>;
      for (const trigger of triggers) {
        database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      }

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
            CREATE TRIGGER runtime_${table.table}_${operation}
            AFTER ${timing} ON ${table.table}
            BEGIN
              INSERT INTO runtime_audit_records(
                id, action, entity_type, entity_id, run_id, node_run_id,
                before_json, after_json, created_at, command_id, actor_type,
                actor_id, authenticated_by, consumer_id
              ) VALUES (
                lower(hex(randomblob(16))),
                'catalog.${table.entity}.${operation}',
                '${table.entity}',
                ${reference},
                NULL,
                NULL,
                ${operation === "created" ? "NULL" : payload},
                ${operation === "deleted" ? "NULL" : payload},
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                (SELECT command_id FROM runtime_unit_of_work_context WHERE slot = 1),
                (SELECT actor_type FROM runtime_unit_of_work_context WHERE slot = 1),
                (SELECT actor_id FROM runtime_unit_of_work_context WHERE slot = 1),
                (SELECT authenticated_by FROM runtime_unit_of_work_context WHERE slot = 1),
                (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1)
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
    version: 25,
    name: "durable_runtime_event_subscriptions",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE runtime_event_outbox
          ADD COLUMN registry_version INTEGER NOT NULL DEFAULT 1
          CHECK (registry_version > 0);
        ALTER TABLE runtime_event_outbox
          ADD COLUMN event_schema_version INTEGER NOT NULL DEFAULT 1
          CHECK (event_schema_version > 0);
        ALTER TABLE runtime_event_outbox
          ADD COLUMN company_id TEXT NOT NULL DEFAULT 'company';
        ALTER TABLE runtime_event_outbox ADD COLUMN project_id TEXT;
        ALTER TABLE runtime_event_outbox ADD COLUMN scope_json TEXT;

        ALTER TABLE runtime_event_cursors ADD COLUMN owner_principal_json TEXT;
        ALTER TABLE runtime_event_cursors ADD COLUMN active_subscription_id TEXT;
        ALTER TABLE runtime_event_cursors
          ADD COLUMN subscription_generation INTEGER NOT NULL DEFAULT 0
          CHECK (subscription_generation >= 0);
        ALTER TABLE runtime_event_cursors
          ADD COLUMN last_delivered_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_delivered_sequence >= 0);
        ALTER TABLE runtime_event_cursors
          ADD COLUMN barrier_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (barrier_sequence >= 0);
        ALTER TABLE runtime_event_cursors ADD COLUMN last_seen_at TEXT;
        ALTER TABLE runtime_event_cursors ADD COLUMN expires_at TEXT;
        ALTER TABLE runtime_event_cursors ADD COLUMN retired_at TEXT;

        CREATE UNIQUE INDEX runtime_event_cursors_active_subscription_idx
          ON runtime_event_cursors(active_subscription_id)
          WHERE active_subscription_id IS NOT NULL;

        CREATE TABLE consumed_view_sync_tokens (
          token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
          nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64),
          consumer_id TEXT NOT NULL,
          principal_hash TEXT NOT NULL CHECK (length(principal_hash) = 64),
          query_hash TEXT NOT NULL,
          view_hash TEXT NOT NULL CHECK (length(view_hash) = 64),
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          expires_at TEXT NOT NULL,
          consumed_at TEXT NOT NULL,
          command_id TEXT
        ) STRICT;

        CREATE INDEX consumed_view_sync_tokens_expiry_idx
          ON consumed_view_sync_tokens(expires_at);
      `);

      for (const operation of ["created", "updated", "deleted"] as const) {
        database.exec(`DROP TRIGGER IF EXISTS runtime_projects_${operation}`);
        const timing =
          operation === "created"
            ? "INSERT"
            : operation === "updated"
              ? "UPDATE"
              : "DELETE";
        const row = operation === "deleted" ? "OLD" : "NEW";
        const payload = `json_object(
          'projectId', ${row}.id,
          'entityId', ${row}.id,
          'operation', '${operation}',
          'revision', ${row}.revision
        )`;
        database.exec(`
          CREATE TRIGGER runtime_projects_${operation}
          AFTER ${timing} ON projects
          BEGIN
            INSERT INTO runtime_audit_records(
              id, action, entity_type, entity_id, run_id, node_run_id,
              before_json, after_json, created_at, command_id, actor_type,
              actor_id, authenticated_by, consumer_id
            ) VALUES (
              lower(hex(randomblob(16))),
              'catalog.project.${operation}',
              'project',
              ${row}.id,
              NULL,
              NULL,
              ${operation === "created" ? "NULL" : payload},
              ${operation === "deleted" ? "NULL" : payload},
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              (SELECT command_id FROM runtime_unit_of_work_context WHERE slot = 1),
              (SELECT actor_type FROM runtime_unit_of_work_context WHERE slot = 1),
              (SELECT actor_id FROM runtime_unit_of_work_context WHERE slot = 1),
              (SELECT authenticated_by FROM runtime_unit_of_work_context WHERE slot = 1),
              (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1)
            );
            INSERT INTO runtime_event_outbox(
              event_id, type, registry_version, event_schema_version,
              company_id, project_id, run_id, node_run_id, scope_json,
              payload_json, created_at
            ) VALUES (
              lower(hex(randomblob(16))),
              'project.${operation}',
              1,
              1,
              ${row}.company_id,
              ${row}.id,
              NULL,
              NULL,
              json_object('companyId', ${row}.company_id, 'projectId', ${row}.id),
              ${payload},
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            );
          END;
        `);
      }
    },
  },
  {
    version: 26,
    name: "immutable_artifact_content_kinds",
    migrate: (database) => {
      database.exec(`
        ALTER TABLE artifact_versions
          ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'managed-file'
          CHECK (content_kind IN ('managed-file', 'repository-object', 'external-reference'));
        ALTER TABLE artifact_versions
          ADD COLUMN canonical_identity_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE artifact_versions
          ADD COLUMN identity_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
          CHECK (length(identity_hash) = 64);
        ALTER TABLE artifact_versions
          ADD COLUMN producer_context_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE artifact_versions
          ADD COLUMN producer_context_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
          CHECK (length(producer_context_hash) = 64);
        ALTER TABLE artifact_versions
          ADD COLUMN integrity_descriptor_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE artifact_versions ADD COLUMN registration_id TEXT;
        ALTER TABLE artifact_versions ADD COLUMN finalized_at TEXT;

        CREATE TABLE artifact_registrations (
          id TEXT PRIMARY KEY,
          version_id TEXT NOT NULL UNIQUE,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          version INTEGER NOT NULL CHECK (version > 0),
          content_kind TEXT NOT NULL CHECK (
            content_kind IN ('managed-file', 'repository-object', 'external-reference')
          ),
          canonical_identity_json TEXT NOT NULL,
          identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
          producer_context_json TEXT NOT NULL,
          producer_context_hash TEXT NOT NULL CHECK (length(producer_context_hash) = 64),
          lineage_json TEXT NOT NULL DEFAULT '[]',
          integrity_descriptor_json TEXT NOT NULL,
          content_ref TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          state TEXT NOT NULL CHECK (state IN ('registered', 'ready', 'finalized', 'failed')),
          failure_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finalized_at TEXT,
          UNIQUE (artifact_id, version)
        ) STRICT;

        CREATE INDEX artifact_registrations_dedup_idx
          ON artifact_registrations(artifact_id, identity_hash, producer_context_hash);

        CREATE TABLE artifact_write_journal (
          registration_id TEXT PRIMARY KEY REFERENCES artifact_registrations(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK (
            state IN ('prepared', 'written', 'renamed', 'finalized', 'failed')
          ),
          expected_hash TEXT NOT NULL CHECK (length(expected_hash) = 64),
          expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
          temp_ref TEXT NOT NULL,
          final_ref TEXT NOT NULL,
          quarantine_ref TEXT,
          reconcile_evidence_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE artifact_integrity_observations (
          id TEXT PRIMARY KEY,
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('verified', 'unavailable', 'failed')),
          verifier_metadata_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          observed_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX artifact_integrity_observations_version_idx
          ON artifact_integrity_observations(artifact_version_id, observed_at, id);

        CREATE TABLE artifact_supersessions (
          superseded_version_id TEXT PRIMARY KEY REFERENCES artifact_versions(id),
          superseding_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
          created_at TEXT NOT NULL,
          CHECK (superseded_version_id <> superseding_version_id)
        ) STRICT;

        CREATE INDEX artifact_links_to_idx
          ON artifact_links(to_version_id, created_at, from_version_id);
      `);

      const existingVersions = database
        .prepare(
          `SELECT id, content_ref AS contentRef, content_hash AS contentHash,
                  byte_size AS byteSize, producing_run_id AS runId,
                  producing_node_run_id AS nodeRunId,
                  producing_node_attempt_id AS nodeAttemptId,
                  snapshot_revision_id AS snapshotRevisionId,
                  ai_member_id AS aiMemberId, created_at AS createdAt
             FROM artifact_versions`,
        )
        .all() as Array<{
        readonly id: string;
        readonly contentRef: string;
        readonly contentHash: string;
        readonly byteSize: number;
        readonly runId: string | null;
        readonly nodeRunId: string | null;
        readonly nodeAttemptId: string | null;
        readonly snapshotRevisionId: string | null;
        readonly aiMemberId: string | null;
        readonly createdAt: string;
      }>;
      const updateVersion = database.prepare(
        `UPDATE artifact_versions
            SET canonical_identity_json = ?, identity_hash = ?,
                producer_context_json = ?, producer_context_hash = ?,
                integrity_descriptor_json = ?, finalized_at = ?
          WHERE id = ?`,
      );
      const insertObservation = database.prepare(
        `INSERT INTO artifact_integrity_observations(
           id, artifact_version_id, status, verifier_metadata_json,
           evidence_json, observed_at
         ) VALUES (?, ?, 'verified', '{}', ?, ?)`,
      );
      for (const version of existingVersions) {
        const identityJson = JSON.stringify({
          kind: "managed-file",
          contentHash: version.contentHash,
          byteSize: Number(version.byteSize),
          storageRef: version.contentRef,
        });
        const producerJson = JSON.stringify({
          ...(version.runId ? { runId: version.runId } : {}),
          ...(version.snapshotRevisionId
            ? { snapshotRevisionId: version.snapshotRevisionId }
            : {}),
          ...(version.nodeRunId ? { nodeRunId: version.nodeRunId } : {}),
          ...(version.nodeAttemptId
            ? { nodeAttemptId: version.nodeAttemptId }
            : {}),
          ...(version.aiMemberId ? { aiMemberId: version.aiMemberId } : {}),
        });
        const identityHash = pipelineHash(JSON.parse(identityJson));
        const producerHash = pipelineHash(JSON.parse(producerJson));
        updateVersion.run(
          identityJson,
          identityHash,
          producerJson,
          producerHash,
          JSON.stringify({
            algorithm: "sha256",
            digest: version.contentHash,
            byteSize: Number(version.byteSize),
          }),
          version.createdAt,
          version.id,
        );
        insertObservation.run(
          `migration-26-${version.id}`,
          version.id,
          JSON.stringify({ source: "schema-migration-26" }),
          version.createdAt,
        );
      }
    },
  },
  {
    version: 27,
    name: "product_proposal_lifecycle",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE product_proposals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (
            status IN (
              'draft', 'clarifying', 'awaiting-confirmation',
              'confirmed', 'rejected', 'needs-rework'
            )
          ),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          current_revision_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE product_proposal_revisions (
          id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL REFERENCES product_proposals(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision > 0),
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          edited_by_type TEXT NOT NULL,
          edited_by_id TEXT NOT NULL,
          edited_by_authenticated_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (proposal_id, revision)
        ) STRICT;

        CREATE INDEX product_proposal_revisions_proposal_idx
          ON product_proposal_revisions(proposal_id, revision DESC);
      `);
    },
  },
  {
    version: 28,
    name: "product_baseline_formal_run",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE product_baselines (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          source_proposal_revision_id TEXT NOT NULL
            REFERENCES product_proposal_revisions(id),
          source_proposal_hash TEXT NOT NULL CHECK (length(source_proposal_hash) = 64),
          content_json TEXT NOT NULL,
          canonical_hash TEXT NOT NULL CHECK (length(canonical_hash) = 64),
          confirmed_by_type TEXT NOT NULL,
          confirmed_by_id TEXT NOT NULL,
          confirmed_by_authenticated_by TEXT NOT NULL,
          confirmation_command_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          snapshot_revision_id TEXT NOT NULL UNIQUE,
          confirmed_at TEXT NOT NULL,
          UNIQUE (project_id, source_proposal_revision_id)
        ) STRICT;

        CREATE TRIGGER product_baselines_immutable_update
        BEFORE UPDATE ON product_baselines
        BEGIN
          SELECT RAISE(ABORT, 'Product Baseline is immutable');
        END;

        CREATE TRIGGER product_baselines_immutable_delete
        BEFORE DELETE ON product_baselines
        BEGIN
          SELECT RAISE(ABORT, 'Product Baseline is immutable');
        END;

        ALTER TABLE department_runs
          ADD COLUMN product_baseline_id TEXT REFERENCES product_baselines(id);
        CREATE INDEX department_runs_product_baseline_idx
          ON department_runs(product_baseline_id, created_at);

        CREATE TABLE runtime_run_quarantines (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          snapshot_revision_id TEXT,
          reason TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          UNIQUE (run_id, snapshot_revision_id, reason)
        ) STRICT;
      `);
    },
  },
  {
    version: 29,
    name: "versioned_pipeline_node_handlers",
    migrate: (database) => {
      if (
        !columnExists(database, "pipeline_versions", "handler_registry_version")
      ) {
        database.exec(`
        ALTER TABLE pipeline_versions
          ADD COLUMN handler_registry_version INTEGER NOT NULL DEFAULT 1
          CHECK (handler_registry_version > 0);
        `);
      }
      if (
        !columnExists(database, "pipeline_versions", "handler_registry_hash")
      ) {
        database.exec(`
        ALTER TABLE pipeline_versions
          ADD COLUMN handler_registry_hash TEXT NOT NULL DEFAULT '';
        `);
      }

      database.exec(`
        DROP TABLE IF EXISTS pipeline_version_handlers;
        CREATE TABLE pipeline_version_handlers (
          pipeline_version_id TEXT NOT NULL
            REFERENCES pipeline_versions(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          node_order INTEGER NOT NULL CHECK (node_order >= 0),
          handler_kind_id TEXT NOT NULL,
          input_schema_hash TEXT NOT NULL CHECK (length(input_schema_hash) = 64),
          output_schema_hash TEXT NOT NULL CHECK (length(output_schema_hash) = 64),
          PRIMARY KEY (pipeline_version_id, node_id),
          UNIQUE (pipeline_version_id, node_order)
        ) STRICT;
      `);

      if (!columnExists(database, "node_runs", "handler_kind_id")) {
        database.exec(`
        ALTER TABLE node_runs ADD COLUMN handler_kind_id TEXT;
        `);
      }
      if (!columnExists(database, "node_runs", "input_schema_hash")) {
        database.exec(`
        ALTER TABLE node_runs ADD COLUMN input_schema_hash TEXT;
        `);
      }
      if (!columnExists(database, "node_runs", "output_schema_hash")) {
        database.exec(`
        ALTER TABLE node_runs ADD COLUMN output_schema_hash TEXT;
        `);
      }

      if (!columnExists(database, "approvals", "requested_action")) {
        database.exec(`
        DROP TABLE IF EXISTS approvals_v29;
        CREATE TABLE approvals_v29 (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          cycle INTEGER NOT NULL CHECK (cycle > 0),
          snapshot_revision_id TEXT REFERENCES run_snapshot_revisions(id),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'decided', 'expired', 'cancelled')
          ),
          decision TEXT CHECK (
            decision IS NULL OR
            decision IN ('approve', 'request-changes', 'reject')
          ),
          requested_action TEXT NOT NULL DEFAULT '',
          input_manifest_hash TEXT CHECK (
            input_manifest_hash IS NULL OR length(input_manifest_hash) = 64
          ),
          eligible_human_policy_json TEXT NOT NULL DEFAULT '{}',
          expires_at TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          expired_at TEXT,
          decision_actor_type TEXT,
          decision_actor_id TEXT,
          decision_actor_authenticated_by TEXT,
          decision_command_id TEXT,
          decision_hash TEXT CHECK (
            decision_hash IS NULL OR length(decision_hash) = 64
          ),
          CHECK (
            (status = 'pending' AND decision IS NULL AND decided_at IS NULL AND expired_at IS NULL) OR
            (status = 'decided' AND decision IS NOT NULL AND decided_at IS NOT NULL AND expired_at IS NULL) OR
            (status = 'expired' AND decision IS NULL AND decided_at IS NULL AND expired_at IS NOT NULL) OR
            (status = 'cancelled' AND decision IS NULL)
          ),
          UNIQUE (node_run_id, cycle)
        ) STRICT;

        INSERT INTO approvals_v29(
          id, run_id, node_run_id, cycle, snapshot_revision_id, status,
          decision, requested_action, input_manifest_hash,
          eligible_human_policy_json, expires_at, created_at, decided_at,
          expired_at, decision_actor_type, decision_actor_id,
          decision_actor_authenticated_by, decision_command_id, decision_hash
        )
        SELECT approvals.id, approvals.run_id, approvals.node_run_id,
               approvals.cycle, department_runs.snapshot_revision_id,
               approvals.status, approvals.decision, '', NULL, '{}', NULL,
               approvals.created_at, approvals.decided_at, NULL,
               NULL, NULL, NULL, NULL, NULL
          FROM approvals
          JOIN department_runs ON department_runs.id = approvals.run_id;

        DROP INDEX IF EXISTS approvals_run_idx;
        DROP TABLE approvals;
        ALTER TABLE approvals_v29 RENAME TO approvals;
        CREATE INDEX approvals_run_idx ON approvals(run_id, node_run_id, cycle);
        `);
      }

      const versions = database
        .prepare("SELECT id, graph_json AS graphJson FROM pipeline_versions")
        .all() as Array<{ readonly id: string; readonly graphJson: string }>;
      const updateVersion = database.prepare(
        `UPDATE pipeline_versions
            SET handler_registry_version = ?, handler_registry_hash = ?
          WHERE id = ?`,
      );
      const deleteHandlers = database.prepare(
        "DELETE FROM pipeline_version_handlers WHERE pipeline_version_id = ?",
      );
      const insertHandler = database.prepare(
        `INSERT INTO pipeline_version_handlers(
           pipeline_version_id, node_id, node_order, handler_kind_id,
           input_schema_hash, output_schema_hash
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pipeline_version_id, node_id) DO UPDATE SET
           node_order = excluded.node_order,
           handler_kind_id = excluded.handler_kind_id,
           input_schema_hash = excluded.input_schema_hash,
           output_schema_hash = excluded.output_schema_hash`,
      );
      for (const version of versions) {
        const graph = JSON.parse(version.graphJson) as {
          readonly nodes: readonly {
            readonly id: string;
            readonly type: Parameters<
              typeof defaultNodeHandlerRegistry.resolve
            >[0];
            readonly handlerKindId?: string;
          }[];
        };
        updateVersion.run(
          defaultNodeHandlerRegistry.version,
          defaultNodeHandlerRegistry.hash,
          version.id,
        );
        deleteHandlers.run(version.id);
        graph.nodes.forEach((node, nodeOrder) => {
          const definition = defaultNodeHandlerRegistry.resolve(
            node.type,
            node.handlerKindId,
          );
          if (!definition) {
            throw new Error(
              `Pipeline Version ${version.id} requires unavailable Handler ${node.handlerKindId ?? node.type}.`,
            );
          }
          insertHandler.run(
            version.id,
            node.id,
            nodeOrder,
            definition.handlerKindId,
            definition.inputSchemaHash,
            definition.outputSchemaHash,
          );
        });
      }
    },
  },
  {
    version: 30,
    name: "fenced_execution_facts",
    migrate: (database) => {
      if (!columnExists(database, "node_attempts", "execution_operation_key")) {
        database.exec(`
          ALTER TABLE node_attempts ADD COLUMN execution_operation_key TEXT;
        `);
      }
      if (
        !columnExists(database, "node_attempts", "terminal_execution_fact_id")
      ) {
        database.exec(`
          ALTER TABLE node_attempts ADD COLUMN terminal_execution_fact_id TEXT;
        `);
      }

      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS node_attempts_execution_operation_idx
          ON node_attempts(execution_operation_key)
          WHERE execution_operation_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS execution_leases (
          id TEXT PRIMARY KEY,
          target_kind TEXT NOT NULL CHECK (target_kind = 'node-attempt'),
          target_id TEXT NOT NULL REFERENCES node_attempts(id) ON DELETE CASCADE,
          lease_kind TEXT NOT NULL CHECK (
            lease_kind IN ('execution', 'reconciliation')
          ),
          operation_key TEXT NOT NULL,
          execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
          fence_token TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          renewed_at TEXT,
          released_at TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0
            CHECK (cancel_requested IN (0, 1)),
          UNIQUE (operation_key, execution_epoch),
          UNIQUE (id, operation_key, execution_epoch, fence_token)
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS execution_leases_active_target_idx
          ON execution_leases(target_kind, target_id)
          WHERE released_at IS NULL;
        CREATE INDEX IF NOT EXISTS execution_leases_operation_idx
          ON execution_leases(operation_key, execution_epoch, expires_at);

        CREATE TABLE IF NOT EXISTS execution_facts (
          id TEXT PRIMARY KEY,
          operation_key TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK (target_kind = 'node-attempt'),
          target_id TEXT NOT NULL REFERENCES node_attempts(id) ON DELETE CASCADE,
          lease_id TEXT NOT NULL REFERENCES execution_leases(id),
          lease_kind TEXT NOT NULL CHECK (
            lease_kind IN ('execution', 'reconciliation')
          ),
          execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
          fence_token TEXT NOT NULL,
          adapter_schema_version INTEGER NOT NULL
            CHECK (adapter_schema_version > 0),
          fact_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal > 0),
          kind TEXT NOT NULL CHECK (
            kind IN (
              'provider-started', 'agent-session', 'message', 'tool-call',
              'tool-result', 'permission-request', 'checkpoint', 'artifact',
              'commit', 'usage', 'not-started', 'completed', 'failed',
              'cancelled'
            )
          ),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          payload_json TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          canonical_payload_hash TEXT NOT NULL
            CHECK (length(canonical_payload_hash) = 64),
          status TEXT NOT NULL CHECK (
            status IN ('accepted', 'duplicate', 'stale', 'conflict')
          ),
          effect_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS execution_facts_accepted_identity_idx
          ON execution_facts(operation_key, fact_id)
          WHERE status = 'accepted';
        CREATE UNIQUE INDEX IF NOT EXISTS execution_facts_accepted_ordinal_idx
          ON execution_facts(operation_key, execution_epoch, ordinal)
          WHERE status = 'accepted';
        CREATE UNIQUE INDEX IF NOT EXISTS execution_facts_terminal_idx
          ON execution_facts(operation_key, execution_epoch)
          WHERE status = 'accepted'
            AND kind IN ('completed', 'failed', 'cancelled');
        CREATE INDEX IF NOT EXISTS execution_facts_target_idx
          ON execution_facts(target_id, execution_epoch, ordinal, created_at);

        CREATE TABLE IF NOT EXISTS permission_decisions (
          id TEXT PRIMARY KEY,
          permission_request_id TEXT NOT NULL UNIQUE
            REFERENCES permission_requests(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          authenticated_by TEXT NOT NULL,
          command_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          CHECK (
            (actor_type = 'human' AND authenticated_by = 'local-session') OR
            (actor_type = 'acp-client' AND authenticated_by = 'acp-connection')
          )
        ) STRICT;

        CREATE INDEX IF NOT EXISTS permission_decisions_actor_idx
          ON permission_decisions(actor_type, actor_id, created_at);
      `);
    },
  },
  {
    version: 31,
    name: "interaction_turns_and_execution_targets",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS interaction_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
          human_participant_id TEXT NOT NULL REFERENCES session_participants(id),
          ai_participant_id TEXT NOT NULL REFERENCES session_participants(id),
          input_message_id TEXT NOT NULL REFERENCES session_messages(id),
          output_message_id TEXT REFERENCES session_messages(id),
          status TEXT NOT NULL CHECK (
            status IN ('queued', 'running', 'reconciling', 'completed',
                       'failed', 'cancelled', 'interrupted')
          ),
          command_id TEXT NOT NULL UNIQUE,
          execution_operation_key TEXT NOT NULL UNIQUE,
          execution_lease_id TEXT,
          execution_epoch INTEGER,
          fence_token TEXT,
          agent_adapter_id TEXT NOT NULL,
          model TEXT NOT NULL,
          timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds > 0),
          mechanism TEXT NOT NULL CHECK (mechanism = 'model-only'),
          mechanism_version TEXT NOT NULL,
          context_json TEXT NOT NULL,
          context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
          context_schema_hash TEXT NOT NULL CHECK (length(context_schema_hash) = 64),
          terminal_execution_fact_id TEXT,
          provider_execution_ref TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS interaction_turns_session_idx
          ON interaction_turns(session_id, created_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS interaction_turns_active_session_idx
          ON interaction_turns(session_id)
          WHERE status IN ('queued', 'running', 'reconciling');

        ALTER TABLE execution_facts RENAME TO execution_facts_v30;
        ALTER TABLE execution_leases RENAME TO execution_leases_v30;
        DROP INDEX execution_leases_active_target_idx;
        DROP INDEX execution_leases_operation_idx;
        DROP INDEX execution_facts_accepted_identity_idx;
        DROP INDEX execution_facts_accepted_ordinal_idx;
        DROP INDEX execution_facts_terminal_idx;
        DROP INDEX execution_facts_target_idx;

        CREATE TABLE execution_leases (
          id TEXT PRIMARY KEY,
          target_kind TEXT NOT NULL CHECK (
            target_kind IN ('node-attempt', 'interaction-turn')
          ),
          target_id TEXT NOT NULL,
          lease_kind TEXT NOT NULL CHECK (
            lease_kind IN ('execution', 'reconciliation')
          ),
          operation_key TEXT NOT NULL,
          execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
          fence_token TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          renewed_at TEXT,
          released_at TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0
            CHECK (cancel_requested IN (0, 1)),
          UNIQUE (operation_key, execution_epoch),
          UNIQUE (
            id, target_kind, target_id, operation_key,
            execution_epoch, fence_token
          )
        ) STRICT;

        INSERT INTO execution_leases(
          id, target_kind, target_id, lease_kind, operation_key,
          execution_epoch, fence_token, worker_id, issued_at, expires_at,
          renewed_at, released_at, cancel_requested
        )
        SELECT id, target_kind, target_id, lease_kind, operation_key,
               execution_epoch, fence_token, worker_id, issued_at, expires_at,
               renewed_at, released_at, cancel_requested
          FROM execution_leases_v30;

        CREATE UNIQUE INDEX execution_leases_active_target_idx
          ON execution_leases(target_kind, target_id)
          WHERE released_at IS NULL;
        CREATE INDEX execution_leases_operation_idx
          ON execution_leases(operation_key, execution_epoch, expires_at);

        CREATE TRIGGER IF NOT EXISTS execution_leases_target_guard
        BEFORE INSERT ON execution_leases
        BEGIN
          SELECT CASE
            WHEN NEW.target_kind = 'node-attempt'
              AND NOT EXISTS (
                SELECT 1 FROM node_attempts WHERE id = NEW.target_id
              )
            THEN RAISE(ABORT, 'execution lease target node attempt not found')
            WHEN NEW.target_kind = 'interaction-turn'
              AND NOT EXISTS (
                SELECT 1 FROM interaction_turns WHERE id = NEW.target_id
              )
            THEN RAISE(ABORT, 'execution lease target interaction turn not found')
          END;
        END;

        CREATE TABLE execution_facts (
          id TEXT PRIMARY KEY,
          operation_key TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK (
            target_kind IN ('node-attempt', 'interaction-turn')
          ),
          target_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          lease_kind TEXT NOT NULL CHECK (
            lease_kind IN ('execution', 'reconciliation')
          ),
          execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
          fence_token TEXT NOT NULL,
          adapter_schema_version INTEGER NOT NULL
            CHECK (adapter_schema_version > 0),
          fact_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal > 0),
          kind TEXT NOT NULL CHECK (
            kind IN (
              'provider-started', 'agent-session', 'message', 'tool-call',
              'tool-result', 'permission-request', 'checkpoint', 'artifact',
              'commit', 'usage', 'not-started', 'completed', 'failed',
              'cancelled'
            )
          ),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          payload_json TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          canonical_payload_hash TEXT NOT NULL
            CHECK (length(canonical_payload_hash) = 64),
          status TEXT NOT NULL CHECK (
            status IN ('accepted', 'duplicate', 'stale', 'conflict')
          ),
          effect_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (
            lease_id, target_kind, target_id, operation_key,
            execution_epoch, fence_token
          ) REFERENCES execution_leases(
            id, target_kind, target_id, operation_key,
            execution_epoch, fence_token
          )
        ) STRICT;

        INSERT INTO execution_facts(
          id, operation_key, target_kind, target_id, lease_id, lease_kind,
          execution_epoch, fence_token, adapter_schema_version, fact_id,
          ordinal, kind, schema_version, payload_json, evidence_refs_json,
          canonical_payload_hash, status, effect_ids_json, created_at
        )
        SELECT id, operation_key, target_kind, target_id, lease_id, lease_kind,
               execution_epoch, fence_token, adapter_schema_version, fact_id,
               ordinal, kind, schema_version, payload_json, evidence_refs_json,
               canonical_payload_hash, status, effect_ids_json, created_at
          FROM execution_facts_v30;

        CREATE UNIQUE INDEX execution_facts_accepted_identity_idx
          ON execution_facts(operation_key, fact_id)
          WHERE status = 'accepted';
        CREATE UNIQUE INDEX execution_facts_accepted_ordinal_idx
          ON execution_facts(operation_key, execution_epoch, ordinal)
          WHERE status = 'accepted';
        CREATE UNIQUE INDEX execution_facts_terminal_idx
          ON execution_facts(operation_key, execution_epoch)
          WHERE status = 'accepted'
            AND kind IN ('completed', 'failed', 'cancelled');
        CREATE INDEX execution_facts_target_idx
          ON execution_facts(target_kind, target_id, execution_epoch, ordinal, created_at);

        DROP TABLE execution_facts_v30;
        DROP TABLE execution_leases_v30;

        CREATE TRIGGER IF NOT EXISTS interaction_turn_delete_leases
        AFTER DELETE ON interaction_turns
        BEGIN
          DELETE FROM execution_facts
           WHERE target_kind = 'interaction-turn' AND target_id = OLD.id;
          DELETE FROM execution_leases
           WHERE target_kind = 'interaction-turn' AND target_id = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS node_attempt_delete_execution_leases
        AFTER DELETE ON node_attempts
        BEGIN
          DELETE FROM execution_facts
           WHERE target_kind = 'node-attempt' AND target_id = OLD.id;
          DELETE FROM execution_leases
           WHERE target_kind = 'node-attempt' AND target_id = OLD.id;
        END;
      `);
    },
  },
  {
    version: 32,
    name: "execution_reconciliation_states",
    migrate: (database) => {
      database.exec(`
        DROP TRIGGER IF EXISTS execution_leases_target_guard;
        DROP TRIGGER IF EXISTS node_attempt_delete_execution_leases;

        PRAGMA legacy_alter_table = ON;
        ALTER TABLE node_attempts RENAME TO node_attempts_v31;
        ALTER TABLE node_runs RENAME TO node_runs_v31;

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
              'waiting-approval', 'paused', 'blocked', 'succeeded', 'failed',
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
          source_node_run_id TEXT REFERENCES node_runs(id),
          handler_kind_id TEXT,
          input_schema_hash TEXT,
          output_schema_hash TEXT,
          UNIQUE (run_id, pipeline_node_id)
        ) STRICT;

        INSERT INTO node_runs(
          id, run_id, pipeline_node_id, node_type, status, attempt_count,
          required_dependency_ids_json, result_json, failure_code,
          failure_message, created_at, updated_at, source_node_run_id,
          handler_kind_id, input_schema_hash, output_schema_hash
        )
        SELECT
          id, run_id, pipeline_node_id, node_type, status, attempt_count,
          required_dependency_ids_json, result_json, failure_code,
          failure_message, created_at, updated_at, source_node_run_id,
          handler_kind_id, input_schema_hash, output_schema_hash
        FROM node_runs_v31;

        CREATE TABLE node_attempts (
          id TEXT PRIMARY KEY,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          reason TEXT NOT NULL CHECK (
            reason IN ('initial', 'request-changes', 'retry', 'recovery')
          ),
          status TEXT NOT NULL CHECK (
            status IN (
              'ready', 'running', 'reconciling', 'succeeded', 'failed',
              'cancelled', 'interrupted'
            )
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
          execution_operation_key TEXT,
          terminal_execution_fact_id TEXT,
          provider_execution_ref TEXT,
          UNIQUE (node_run_id, attempt_number)
        ) STRICT;

        INSERT INTO node_attempts(
          id, node_run_id, attempt_number, snapshot_revision_id, reason,
          status, structured_result_json, failure_code, failure_message,
          created_at, started_at, completed_at, lease_id, lease_owner,
          lease_expires_at, checkpoint_json, recoverable,
          execution_operation_key, terminal_execution_fact_id,
          provider_execution_ref
        )
        SELECT
          id, node_run_id, attempt_number, snapshot_revision_id, reason,
          status, structured_result_json, failure_code, failure_message,
          created_at, started_at, completed_at, lease_id, lease_owner,
          lease_expires_at, checkpoint_json, recoverable,
          execution_operation_key, terminal_execution_fact_id, NULL
        FROM node_attempts_v31;

        DROP TABLE node_attempts_v31;
        DROP TABLE node_runs_v31;
        PRAGMA legacy_alter_table = OFF;

        CREATE INDEX node_runs_run_status_idx ON node_runs(run_id, status);
        CREATE INDEX node_attempts_node_run_idx
          ON node_attempts(node_run_id, attempt_number);
        CREATE INDEX node_attempts_ready_lease_idx
          ON node_attempts(node_run_id, status, lease_expires_at);
        CREATE UNIQUE INDEX node_attempts_execution_operation_idx
          ON node_attempts(execution_operation_key)
          WHERE execution_operation_key IS NOT NULL;

        DROP INDEX execution_facts_terminal_idx;
        CREATE UNIQUE INDEX execution_facts_terminal_idx
          ON execution_facts(operation_key, execution_epoch)
          WHERE status = 'accepted'
            AND kind IN ('not-started', 'completed', 'failed', 'cancelled');

        CREATE TRIGGER execution_leases_target_guard
        BEFORE INSERT ON execution_leases
        BEGIN
          SELECT CASE
            WHEN NEW.target_kind = 'node-attempt'
              AND NOT EXISTS (
                SELECT 1 FROM node_attempts WHERE id = NEW.target_id
              )
            THEN RAISE(ABORT, 'execution lease target node attempt not found')
            WHEN NEW.target_kind = 'interaction-turn'
              AND NOT EXISTS (
                SELECT 1 FROM interaction_turns WHERE id = NEW.target_id
              )
            THEN RAISE(ABORT, 'execution lease target interaction turn not found')
          END;
        END;

        CREATE TRIGGER node_attempt_delete_execution_leases
        AFTER DELETE ON node_attempts
        BEGIN
          DELETE FROM execution_facts
           WHERE target_kind = 'node-attempt' AND target_id = OLD.id;
          DELETE FROM execution_leases
           WHERE target_kind = 'node-attempt' AND target_id = OLD.id;
        END;

        CREATE TABLE IF NOT EXISTS continuation_plans (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('recovery', 'fork')),
          source_run_id TEXT NOT NULL REFERENCES department_runs(id),
          target_run_id TEXT NOT NULL REFERENCES department_runs(id),
          source_snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          target_snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          target_node_run_id TEXT REFERENCES node_runs(id),
          mode TEXT NOT NULL CHECK (mode IN ('recovery', 'replay', 'reconfigure')),
          run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
          canonical_json TEXT NOT NULL,
          hash TEXT NOT NULL CHECK (length(hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS continuation_plan_items (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES continuation_plans(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          pipeline_node_id TEXT NOT NULL,
          source_node_run_id TEXT REFERENCES node_runs(id),
          target_node_run_id TEXT NOT NULL REFERENCES node_runs(id),
          disposition TEXT NOT NULL CHECK (
            disposition IN ('rerun', 'reuse-evidence', 'skip', 'blocked')
          ),
          evidence_refs_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          UNIQUE (plan_id, pipeline_node_id),
          UNIQUE (plan_id, ordinal)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS continuation_plans_target_run_idx
          ON continuation_plans(target_run_id, created_at, id);
        CREATE TRIGGER IF NOT EXISTS continuation_plans_immutable_update
        BEFORE UPDATE ON continuation_plans
        BEGIN
          SELECT RAISE(ABORT, 'continuation plan is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS continuation_plans_immutable_delete
        BEFORE DELETE ON continuation_plans
        BEGIN
          SELECT RAISE(ABORT, 'continuation plan is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS continuation_plan_items_immutable_update
        BEFORE UPDATE ON continuation_plan_items
        BEGIN
          SELECT RAISE(ABORT, 'continuation plan item is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS continuation_plan_items_immutable_delete
        BEFORE DELETE ON continuation_plan_items
        BEGIN
          SELECT RAISE(ABORT, 'continuation plan item is immutable');
        END;
      `);
    },
  },
  {
    version: 33,
    name: "review_topics_and_quality_gates",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS review_topics (
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

        CREATE INDEX IF NOT EXISTS review_topics_project_idx
          ON review_topics(project_id, created_at, id);
        CREATE INDEX IF NOT EXISTS review_topics_run_idx
          ON review_topics(run_id, created_at, id);

        CREATE TABLE IF NOT EXISTS review_participants (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (
            role IN ('owner-participant', 'reviewer-participant', 'moderator')
          ),
          ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          position_id TEXT NOT NULL REFERENCES positions(id),
          session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
          eligibility_reasons_json TEXT NOT NULL,
          eligibility_snapshot_json TEXT NOT NULL,
          eligibility_snapshot_hash TEXT NOT NULL
            CHECK (length(eligibility_snapshot_hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (topic_id, ai_member_id),
          UNIQUE (topic_id, position_id),
          UNIQUE (topic_id, session_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS review_participants_topic_role_idx
          ON review_participants(topic_id, role, eligible);

        CREATE TABLE IF NOT EXISTS review_findings (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          reviewer_participant_id TEXT NOT NULL REFERENCES review_participants(id),
          reviewer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          severity TEXT NOT NULL CHECK (
            severity IN ('info', 'low', 'medium', 'high', 'critical')
          ),
          summary TEXT NOT NULL,
          rationale TEXT NOT NULL,
          impact TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          suggested_owner TEXT NOT NULL,
          blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS review_findings_topic_idx
          ON review_findings(topic_id, created_at, id);

        CREATE TABLE IF NOT EXISTS review_resolutions (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          finding_id TEXT NOT NULL REFERENCES review_findings(id),
          participant_id TEXT NOT NULL REFERENCES review_participants(id),
          disposition TEXT NOT NULL CHECK (
            disposition IN ('accepted', 'disputed', 'resolved', 'rejected')
          ),
          response TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          revised_subject_id TEXT,
          revised_subject_hash TEXT CHECK (
            revised_subject_hash IS NULL OR length(revised_subject_hash) = 64
          ),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS review_resolutions_finding_idx
          ON review_resolutions(finding_id, created_at, id);

        CREATE TABLE IF NOT EXISTS review_discussions (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          round INTEGER NOT NULL CHECK (round > 0),
          status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
          conflict_finding_ids_json TEXT NOT NULL,
          bounded_prompt TEXT NOT NULL,
          tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
          cost_cents_used INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents_used >= 0),
          duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
          stop_reason TEXT,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          UNIQUE (topic_id, round)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS review_revisions (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64),
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          evidence_refs_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS review_revisions_topic_idx
          ON review_revisions(topic_id, created_at, id);

        CREATE TABLE IF NOT EXISTS review_rechecks (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES review_topics(id) ON DELETE CASCADE,
          revision_id TEXT NOT NULL REFERENCES review_revisions(id),
          reviewer_participant_id TEXT NOT NULL REFERENCES review_participants(id),
          reviewer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          result TEXT NOT NULL CHECK (
            result IN ('PASS', 'CONDITIONAL_PASS', 'FAIL')
          ),
          conditions_json TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          eligibility_snapshot_json TEXT NOT NULL,
          eligibility_snapshot_hash TEXT NOT NULL
            CHECK (length(eligibility_snapshot_hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (revision_id, reviewer_participant_id),
          UNIQUE (revision_id, reviewer_session_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS quality_gate_results (
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

        CREATE TRIGGER IF NOT EXISTS review_findings_immutable_update
        BEFORE UPDATE ON review_findings
        BEGIN
          SELECT RAISE(ABORT, 'Review Finding is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS review_findings_immutable_delete
        BEFORE DELETE ON review_findings
        BEGIN
          SELECT RAISE(ABORT, 'Review Finding is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS review_resolutions_immutable_update
        BEFORE UPDATE ON review_resolutions
        BEGIN
          SELECT RAISE(ABORT, 'Review resolution is append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS review_resolutions_immutable_delete
        BEFORE DELETE ON review_resolutions
        BEGIN
          SELECT RAISE(ABORT, 'Review resolution is append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS review_revisions_immutable_update
        BEFORE UPDATE ON review_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Review revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS review_revisions_immutable_delete
        BEFORE DELETE ON review_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Review revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS review_rechecks_immutable_update
        BEFORE UPDATE ON review_rechecks
        BEGIN
          SELECT RAISE(ABORT, 'Review recheck is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS review_rechecks_immutable_delete
        BEFORE DELETE ON review_rechecks
        BEGIN
          SELECT RAISE(ABORT, 'Review recheck is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS quality_gate_results_immutable_update
        BEFORE UPDATE ON quality_gate_results
        BEGIN
          SELECT RAISE(ABORT, 'Quality Gate Result is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS quality_gate_results_immutable_delete
        BEFORE DELETE ON quality_gate_results
        BEGIN
          SELECT RAISE(ABORT, 'Quality Gate Result is immutable');
        END;
      `);
    },
  },
  {
    version: 34,
    name: "project_spec_revisions",
    migrate: (database) => {
      const reviewFindingColumns = database
        .prepare("PRAGMA table_info(review_findings)")
        .all() as Array<{ readonly name: string }>;
      if (
        !reviewFindingColumns.some((column) => column.name === "scope_impact")
      ) {
        database.exec(`
          ALTER TABLE review_findings ADD COLUMN scope_impact TEXT
            CHECK (scope_impact IN ('scope-preserving', 'scope-changing'));
        `);
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_specs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES department_runs(id) ON DELETE CASCADE,
          product_baseline_id TEXT NOT NULL REFERENCES product_baselines(id),
          current_revision_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_spec_revisions (
          id TEXT PRIMARY KEY,
          project_spec_id TEXT NOT NULL REFERENCES project_specs(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          product_baseline_id TEXT NOT NULL REFERENCES product_baselines(id),
          product_baseline_hash TEXT NOT NULL CHECK (length(product_baseline_hash) = 64),
          revision INTEGER NOT NULL CHECK (revision > 0),
          supersedes_revision_id TEXT REFERENCES project_spec_revisions(id),
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          created_at TEXT NOT NULL,
          UNIQUE (project_spec_id, revision)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS project_spec_revisions_run_idx
          ON project_spec_revisions(run_id, revision);

        CREATE TRIGGER IF NOT EXISTS project_spec_revisions_immutable_update
        BEFORE UPDATE ON project_spec_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Project Spec Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS project_spec_revisions_immutable_delete
        BEFORE DELETE ON project_spec_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Project Spec Revision is immutable');
        END;

        CREATE TABLE IF NOT EXISTS product_readiness_evidence (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          product_baseline_id TEXT NOT NULL REFERENCES product_baselines(id),
          product_baseline_hash TEXT NOT NULL CHECK (length(product_baseline_hash) = 64),
          project_spec_revision_id TEXT NOT NULL REFERENCES project_spec_revisions(id),
          project_spec_hash TEXT NOT NULL CHECK (length(project_spec_hash) = 64),
          check_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ready', 'blocked')),
          summary TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS product_readiness_evidence_run_idx
          ON product_readiness_evidence(run_id, created_at, id);
        CREATE TRIGGER IF NOT EXISTS product_readiness_evidence_immutable_update
        BEFORE UPDATE ON product_readiness_evidence
        BEGIN
          SELECT RAISE(ABORT, 'Readiness Evidence is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS product_readiness_evidence_immutable_delete
        BEFORE DELETE ON product_readiness_evidence
        BEGIN
          SELECT RAISE(ABORT, 'Readiness Evidence is immutable');
        END;

        CREATE TABLE IF NOT EXISTS product_gate_promotions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES department_runs(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL UNIQUE REFERENCES review_topics(id),
          quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
          project_spec_revision_id TEXT NOT NULL REFERENCES project_spec_revisions(id),
          project_spec_hash TEXT NOT NULL CHECK (length(project_spec_hash) = 64),
          readiness_evidence_ids_json TEXT NOT NULL,
          source_snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          snapshot_revision_id TEXT NOT NULL UNIQUE REFERENCES run_snapshot_revisions(id),
          snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER IF NOT EXISTS product_gate_promotions_immutable_update
        BEFORE UPDATE ON product_gate_promotions
        BEGIN
          SELECT RAISE(ABORT, 'Product Gate Promotion is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS product_gate_promotions_immutable_delete
        BEFORE DELETE ON product_gate_promotions
        BEGIN
          SELECT RAISE(ABORT, 'Product Gate Promotion is immutable');
        END;
      `);
    },
  },
  {
    version: 35,
    name: "application_references",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS application_references (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          repository_reference TEXT NOT NULL,
          application_key TEXT NOT NULL,
          ownership TEXT NOT NULL,
          build_command TEXT NOT NULL,
          test_command TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision = 1),
          created_at TEXT NOT NULL,
          UNIQUE (project_id, application_key)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS application_references_project_idx
          ON application_references(project_id, created_at, id);
        CREATE TRIGGER IF NOT EXISTS application_references_immutable_update
        BEFORE UPDATE ON application_references
        BEGIN
          SELECT RAISE(ABORT, 'Application registration is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS application_references_immutable_delete
        BEFORE DELETE ON application_references
        BEGIN
          SELECT RAISE(ABORT, 'Application registration is immutable');
        END;
      `);
    },
  },
  {
    version: 36,
    name: "application_spec_revisions",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS application_specs (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL REFERENCES application_references(id),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          current_revision_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, application_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS application_spec_revisions (
          id TEXT PRIMARY KEY,
          application_spec_id TEXT NOT NULL REFERENCES application_specs(id) ON DELETE CASCADE,
          application_id TEXT NOT NULL REFERENCES application_references(id),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          promoted_project_spec_revision_id TEXT NOT NULL REFERENCES project_spec_revisions(id),
          promoted_project_spec_hash TEXT NOT NULL CHECK (length(promoted_project_spec_hash) = 64),
          revision INTEGER NOT NULL CHECK (revision > 0),
          supersedes_revision_id TEXT REFERENCES application_spec_revisions(id),
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          created_at TEXT NOT NULL,
          UNIQUE (application_spec_id, revision)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS application_spec_revisions_run_idx
          ON application_spec_revisions(run_id, application_id, revision);
        CREATE TRIGGER IF NOT EXISTS application_spec_revisions_immutable_update
        BEFORE UPDATE ON application_spec_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Application Spec Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS application_spec_revisions_immutable_delete
        BEFORE DELETE ON application_spec_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Application Spec Revision is immutable');
        END;
      `);
    },
  },
  {
    version: 37,
    name: "technical_baseline_proposals",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS technical_baseline_proposals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES department_runs(id) ON DELETE CASCADE,
          current_revision_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS technical_baseline_proposal_revisions (
          id TEXT PRIMARY KEY,
          technical_baseline_proposal_id TEXT NOT NULL
            REFERENCES technical_baseline_proposals(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          promoted_project_spec_revision_id TEXT NOT NULL
            REFERENCES project_spec_revisions(id),
          promoted_project_spec_hash TEXT NOT NULL CHECK (length(promoted_project_spec_hash) = 64),
          readiness_evidence_json TEXT NOT NULL,
          application_spec_revisions_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          supersedes_revision_id TEXT REFERENCES technical_baseline_proposal_revisions(id),
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          created_at TEXT NOT NULL,
          UNIQUE (technical_baseline_proposal_id, revision)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS cross_application_contract_revisions (
          proposal_revision_id TEXT NOT NULL
            REFERENCES technical_baseline_proposal_revisions(id) ON DELETE CASCADE,
          contract_id TEXT NOT NULL,
          version TEXT NOT NULL,
          producer_application_id TEXT NOT NULL REFERENCES application_references(id),
          consumer_application_id TEXT NOT NULL REFERENCES application_references(id),
          kind TEXT NOT NULL CHECK (kind IN ('api', 'data', 'event')),
          schema_text TEXT NOT NULL,
          compatibility_policy TEXT NOT NULL
            CHECK (compatibility_policy IN ('exact', 'backward-compatible')),
          compatibility TEXT NOT NULL
            CHECK (compatibility IN ('compatible', 'incompatible')),
          evidence_refs_json TEXT NOT NULL,
          test_commands_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          created_at TEXT NOT NULL,
          PRIMARY KEY (proposal_revision_id, contract_id, version)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS technical_review_topics (
          topic_id TEXT PRIMARY KEY REFERENCES review_topics(id),
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          proposal_revision_id TEXT NOT NULL
            REFERENCES technical_baseline_proposal_revisions(id),
          prior_quality_gate_result_id TEXT REFERENCES quality_gate_results(id),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS technical_baseline_proposal_revisions_run_idx
          ON technical_baseline_proposal_revisions(run_id, revision);
        CREATE INDEX IF NOT EXISTS cross_application_contract_revisions_proposal_idx
          ON cross_application_contract_revisions(proposal_revision_id, contract_id);
        CREATE INDEX IF NOT EXISTS technical_review_topics_run_idx
          ON technical_review_topics(run_id, created_at, topic_id);

        CREATE TRIGGER IF NOT EXISTS technical_baseline_proposal_revisions_immutable_update
        BEFORE UPDATE ON technical_baseline_proposal_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Technical Baseline Proposal Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_baseline_proposal_revisions_immutable_delete
        BEFORE DELETE ON technical_baseline_proposal_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Technical Baseline Proposal Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS cross_application_contract_revisions_immutable_update
        BEFORE UPDATE ON cross_application_contract_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Cross-Application Contract Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS cross_application_contract_revisions_immutable_delete
        BEFORE DELETE ON cross_application_contract_revisions
        BEGIN
          SELECT RAISE(ABORT, 'Cross-Application Contract Revision is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_review_topics_immutable_update
        BEFORE UPDATE ON technical_review_topics
        BEGIN
          SELECT RAISE(ABORT, 'Technical Review lineage is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_review_topics_immutable_delete
        BEFORE DELETE ON technical_review_topics
        BEGIN
          SELECT RAISE(ABORT, 'Technical Review lineage is immutable');
        END;
      `);
    },
  },
  {
    version: 38,
    name: "accepted_technical_baselines",
    migrate: (database) => {
      const installedAt = "2026-07-27T00:00:00.000Z";
      database
        .prepare(
          `INSERT OR IGNORE INTO ai_members(
             id, department_id, display_name, status, created_at
           ) VALUES ('delivery-coordinator-member', 'software-rnd',
                     'Delivery Coordinator', 'active', ?)`,
        )
        .run(installedAt);
      database
        .prepare(
          `INSERT OR IGNORE INTO positions(
             id, department_id, name, responsibility, ai_member_id,
             sort_order, created_at
           ) VALUES ('delivery-coordinator', 'software-rnd',
                     'Delivery Coordinator',
                     'Orchestrates downstream delivery without approving producer-owned work.',
                     'delivery-coordinator-member', 5, ?)`,
        )
        .run(installedAt);
      database.exec(`
        CREATE TABLE IF NOT EXISTS technical_baselines (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES department_runs(id) ON DELETE CASCADE,
          proposal_revision_id TEXT NOT NULL UNIQUE
            REFERENCES technical_baseline_proposal_revisions(id),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS technical_gate_promotions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES department_runs(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL REFERENCES review_topics(id),
          quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
          technical_baseline_id TEXT NOT NULL UNIQUE REFERENCES technical_baselines(id),
          technical_baseline_hash TEXT NOT NULL CHECK (length(technical_baseline_hash) = 64),
          proposal_revision_id TEXT NOT NULL REFERENCES technical_baseline_proposal_revisions(id),
          proposal_revision_hash TEXT NOT NULL CHECK (length(proposal_revision_hash) = 64),
          source_snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          snapshot_revision_id TEXT NOT NULL UNIQUE REFERENCES run_snapshot_revisions(id),
          snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER IF NOT EXISTS technical_baselines_immutable_update
        BEFORE UPDATE ON technical_baselines
        BEGIN
          SELECT RAISE(ABORT, 'Technical Baseline is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_baselines_immutable_delete
        BEFORE DELETE ON technical_baselines
        BEGIN
          SELECT RAISE(ABORT, 'Technical Baseline is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_gate_promotions_immutable_update
        BEFORE UPDATE ON technical_gate_promotions
        BEGIN
          SELECT RAISE(ABORT, 'Technical Gate Promotion is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS technical_gate_promotions_immutable_delete
        BEFORE DELETE ON technical_gate_promotions
        BEGIN
          SELECT RAISE(ABORT, 'Technical Gate Promotion is immutable');
        END;
      `);
    },
  },
  {
    version: 39,
    name: "local_isolated_git_workspace_imports",
    migrate: (database) => {
      const installedAt = "2026-07-27T00:00:00.000Z";
      database
        .prepare(
          `INSERT OR IGNORE INTO execution_profiles(
             id, department_id, name, provider_ref, model, sandbox_ref,
             branch_strategy, timeout_seconds, max_iterations, max_tokens,
             retry_max_attempts, permission_policy, revision, status,
             created_at, updated_at, archived_at
           ) VALUES ('software-rnd-local-isolated-git', 'software-rnd',
                     'Local Isolated Git (Docker)', 'default-agent', 'default',
                     'docker', 'branch', 1800, 10, NULL, 1, 'ask', 0,
                     'active', ?, ?, NULL)`,
        )
        .run(installedAt, installedAt);
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_allocations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          application_id TEXT NOT NULL REFERENCES application_references(id),
          execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
          execution_profile_revision INTEGER NOT NULL CHECK (execution_profile_revision >= 0),
          operation_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (
            state IN ('planned', 'provisioning', 'ready', 'failed',
                      'cleanup-pending', 'cleaned')
          ),
          repository_root TEXT NOT NULL,
          allocation_root TEXT NOT NULL,
          source_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
          expected_source_tip TEXT NOT NULL CHECK (length(expected_source_tip) = 40),
          capability_snapshot_json TEXT NOT NULL,
          capability_snapshot_hash TEXT NOT NULL CHECK (length(capability_snapshot_hash) = 64),
          private_git_identity_json TEXT,
          provision_receipt_json TEXT,
          cleanup_evidence_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          provision_command_id TEXT NOT NULL,
          cleanup_command_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS workspace_allocations_project_idx
          ON workspace_allocations(project_id, created_at, id);
        CREATE INDEX IF NOT EXISTS workspace_allocations_state_idx
          ON workspace_allocations(state, updated_at, id);

        CREATE TABLE IF NOT EXISTS workspace_imports (
          id TEXT PRIMARY KEY,
          allocation_id TEXT NOT NULL REFERENCES workspace_allocations(id),
          command_id TEXT NOT NULL,
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          state TEXT NOT NULL CHECK (
            state IN ('intent', 'running', 'succeeded', 'failed', 'unknown')
          ),
          expected_source_tip TEXT NOT NULL CHECK (length(expected_source_tip) = 40),
          before_source_tip TEXT NOT NULL CHECK (length(before_source_tip) = 40),
          result_commit TEXT NOT NULL CHECK (length(result_commit) = 40),
          object_set_hash TEXT,
          receipt_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (allocation_id, request_hash)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS workspace_imports_state_idx
          ON workspace_imports(state, updated_at, id);

        CREATE TRIGGER IF NOT EXISTS workspace_import_receipt_immutable
        BEFORE UPDATE OF receipt_json ON workspace_imports
        WHEN OLD.receipt_json IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'Workspace import receipt is immutable');
        END;
      `);
    },
  },
  {
    version: 40,
    name: "governed_run_interventions",
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS governed_interventions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES node_attempts(id),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          actor_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
          feedback TEXT NOT NULL CHECK (length(trim(feedback)) BETWEEN 1 AND 10000),
          outcome TEXT NOT NULL CHECK (outcome IN ('feedback', 'new-attempt')),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS governed_interventions_run_idx
          ON governed_interventions(run_id, created_at, id);
      `);
    },
  },
  {
    version: 41,
    name: "reviewed_memory_candidates_entries_and_snapshot_selections",
    migrate: (database) => {
      const reviewTopicsSql = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_topics'",
        )
        .get() as { readonly sql?: string } | undefined;
      if (!reviewTopicsSql?.sql?.includes("'memory'")) {
        database.exec(`
        CREATE TABLE review_topics_v41 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES department_runs(id),
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN ('product', 'technical', 'code', 'aggregate', 'verification', 'memory')
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

        INSERT INTO review_topics_v41
        SELECT * FROM review_topics;

        CREATE TABLE quality_gate_results_v41 (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL UNIQUE REFERENCES review_topics(id),
          kind TEXT NOT NULL CHECK (
            kind IN ('product', 'technical', 'code', 'aggregate', 'verification', 'memory')
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

        INSERT INTO quality_gate_results_v41
        SELECT * FROM quality_gate_results;

        DROP TABLE quality_gate_results;
        ALTER TABLE quality_gate_results_v41 RENAME TO quality_gate_results;
        DROP TABLE review_topics;
        ALTER TABLE review_topics_v41 RENAME TO review_topics;

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
        `);
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS reviewed_memory_candidates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK (scope IN ('project', 'ai-member')),
          ai_member_id TEXT REFERENCES ai_members(id),
          current_revision_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'accepted', 'rejected')),
          review_topic_id TEXT REFERENCES review_topics(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((scope = 'project' AND ai_member_id IS NULL)
              OR (scope = 'ai-member' AND ai_member_id IS NOT NULL))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS reviewed_memory_candidate_revisions (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL REFERENCES reviewed_memory_candidates(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK (scope IN ('project', 'ai-member')),
          ai_member_id TEXT REFERENCES ai_members(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          supersedes_revision_id TEXT REFERENCES reviewed_memory_candidate_revisions(id),
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          redaction_policy_version TEXT NOT NULL,
          redaction_policy_hash TEXT NOT NULL CHECK (length(redaction_policy_hash) = 64),
          source_artifact_versions_json TEXT NOT NULL,
          source_event_ranges_json TEXT NOT NULL,
          producer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          producer_position_id TEXT NOT NULL REFERENCES positions(id),
          producer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          created_at TEXT NOT NULL,
          UNIQUE (candidate_id, revision)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS reviewed_memory_review_topics (
          topic_id TEXT PRIMARY KEY REFERENCES review_topics(id),
          candidate_revision_id TEXT NOT NULL UNIQUE
            REFERENCES reviewed_memory_candidate_revisions(id),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS reviewed_memory_decisions (
          id TEXT PRIMARY KEY,
          candidate_revision_id TEXT NOT NULL UNIQUE
            REFERENCES reviewed_memory_candidate_revisions(id),
          candidate_revision_hash TEXT NOT NULL CHECK (length(candidate_revision_hash) = 64),
          topic_id TEXT NOT NULL REFERENCES review_topics(id),
          quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
          decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          authenticated_by TEXT NOT NULL,
          command_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS reviewed_memory_entries (
          id TEXT PRIMARY KEY,
          decision_id TEXT NOT NULL UNIQUE REFERENCES reviewed_memory_decisions(id),
          candidate_revision_id TEXT NOT NULL UNIQUE
            REFERENCES reviewed_memory_candidate_revisions(id),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK (scope IN ('project', 'ai-member')),
          owner_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          redaction_policy_version TEXT NOT NULL,
          redaction_policy_hash TEXT NOT NULL CHECK (length(redaction_policy_hash) = 64),
          quality_gate_result_id TEXT NOT NULL REFERENCES quality_gate_results(id),
          created_at TEXT NOT NULL,
          UNIQUE (scope, owner_id, version)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS run_memory_selections (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          source_snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          entry_id TEXT NOT NULL REFERENCES reviewed_memory_entries(id),
          entry_version INTEGER NOT NULL CHECK (entry_version > 0),
          entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
          selection_reason TEXT NOT NULL,
          policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (snapshot_revision_id, entry_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS reviewed_memory_candidates_project_idx
          ON reviewed_memory_candidates(project_id, status, created_at);
        CREATE INDEX IF NOT EXISTS reviewed_memory_entries_project_idx
          ON reviewed_memory_entries(project_id, scope, owner_id, version);
        CREATE INDEX IF NOT EXISTS run_memory_selections_run_idx
          ON run_memory_selections(run_id, snapshot_revision_id, entry_id);

        CREATE TRIGGER IF NOT EXISTS reviewed_memory_candidate_revisions_immutable_update
        BEFORE UPDATE ON reviewed_memory_candidate_revisions
        BEGIN SELECT RAISE(ABORT, 'Memory Candidate Revision is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS reviewed_memory_candidate_revisions_immutable_delete
        BEFORE DELETE ON reviewed_memory_candidate_revisions
        BEGIN SELECT RAISE(ABORT, 'Memory Candidate Revision is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS reviewed_memory_decisions_immutable_update
        BEFORE UPDATE ON reviewed_memory_decisions
        BEGIN SELECT RAISE(ABORT, 'Memory Decision is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS reviewed_memory_decisions_immutable_delete
        BEFORE DELETE ON reviewed_memory_decisions
        BEGIN SELECT RAISE(ABORT, 'Memory Decision is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS reviewed_memory_entries_immutable_update
        BEFORE UPDATE ON reviewed_memory_entries
        BEGIN SELECT RAISE(ABORT, 'Memory Entry is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS reviewed_memory_entries_immutable_delete
        BEFORE DELETE ON reviewed_memory_entries
        BEGIN SELECT RAISE(ABORT, 'Memory Entry is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS run_memory_selections_immutable_update
        BEFORE UPDATE ON run_memory_selections
        BEGIN SELECT RAISE(ABORT, 'Run Memory Selection is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS run_memory_selections_immutable_delete
        BEFORE DELETE ON run_memory_selections
        BEGIN SELECT RAISE(ABORT, 'Run Memory Selection is immutable'); END;
      `);
    },
  },
  {
    version: 42,
    name: "work_package_execution",
    migrate: (database) => {
      const requiredTables = {
        work_packages: [
          "id",
          "project_id",
          "run_id",
          "technical_baseline_id",
          "state",
          "revision",
          "created_at",
          "updated_at",
        ],
        work_package_versions: [
          "id",
          "work_package_id",
          "version",
          "application_id",
          "repository_reference",
          "node_run_id",
          "manifest_json",
          "manifest_hash",
          "status",
          "created_at",
        ],
        work_package_dependencies: [
          "work_package_version_id",
          "predecessor_work_package_version_id",
          "kind",
          "contract_id",
          "contract_version",
          "evidence_ref",
          "created_at",
        ],
        work_package_assignments: [
          "id",
          "work_package_version_id",
          "node_attempt_id",
          "position_id",
          "ai_member_id",
          "agent_adapter_id",
          "rationale_json",
          "allocation_id",
          "interaction_session_id",
          "sandbox_identity",
          "evidence_scope",
          "state",
          "created_at",
          "updated_at",
        ],
        work_package_self_checks: [
          "id",
          "assignment_id",
          "node_attempt_id",
          "status",
          "report_json",
          "report_hash",
          "created_at",
        ],
      } as const;
      const requiredAllocationColumns = [
        "work_package_version_id",
        "node_attempt_id",
        "interaction_session_id",
        "sandbox_identity",
        "evidence_scope",
      ] as const;
      const schemaObjects = database
        .prepare(
          `SELECT type, name FROM sqlite_schema
           WHERE name LIKE 'work_package%'
              OR name IN (
                'workspace_allocations_attempt_idx',
                'workspace_allocations_session_idx',
                'workspace_allocations_sandbox_idx',
                'workspace_allocations_evidence_idx'
              )`,
        )
        .all() as Array<{
        readonly type: string;
        readonly name: string;
      }>;
      const hasExistingSchema =
        schemaObjects.length > 0 ||
        requiredAllocationColumns.some((column) =>
          columnExists(database, "workspace_allocations", column),
        );

      if (hasExistingSchema) {
        const normalizeSql = (sql: string): string =>
          sql
            .replace(/\s+/g, " ")
            .replace(/\s*([(),])\s*/g, "$1")
            .trim()
            .toLowerCase();
        const objectSql = (name: string): string | undefined => {
          const row = database
            .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
            .get(name) as { readonly sql: string | null } | undefined;
          return row?.sql ? normalizeSql(row.sql) : undefined;
        };
        const missingColumns = [
          ...Object.entries(requiredTables).flatMap(([table, columns]) =>
            columns
              .filter((column) => !columnExists(database, table, column))
              .map((column) => `${table}.${column}`),
          ),
          ...requiredAllocationColumns
            .filter(
              (column) =>
                !columnExists(database, "workspace_allocations", column),
            )
            .map((column) => `workspace_allocations.${column}`),
        ];
        const requiredSchemaObjects = [
          "work_packages_run_idx",
          "work_package_versions_node_idx",
          "work_package_versions_active_node_idx",
          "work_package_dependencies_predecessor_idx",
          "work_package_assignments_version_idx",
          "workspace_allocations_attempt_idx",
          "workspace_allocations_session_idx",
          "workspace_allocations_sandbox_idx",
          "workspace_allocations_evidence_idx",
          "work_package_versions_immutable_update",
          "work_package_versions_immutable_delete",
          "work_package_self_checks_immutable_update",
          "work_package_self_checks_immutable_delete",
        ];
        const existingObjectNames = new Set(
          schemaObjects.map((entry) => entry.name),
        );
        const missingObjects = requiredSchemaObjects.filter(
          (name) => !existingObjectNames.has(name),
        );
        const requiredTableFragments = {
          work_packages: [
            "state in ( 'ready', 'assigned', 'running', 'self-check', 'blocked', 'failed' )",
            "revision integer not null default 0 check (revision >= 0)",
            "unique (run_id, id)",
            ") strict",
          ],
          work_package_versions: [
            "work_package_id text not null references work_packages(id) on delete cascade",
            "version integer not null check (version > 0)",
            "application_id text not null references application_references(id)",
            "node_run_id text not null references node_runs(id)",
            "manifest_hash text not null check (length(manifest_hash) = 64)",
            "status text not null check (status in ('ready', 'superseded'))",
            "unique (work_package_id, version)",
            ") strict",
          ],
          work_package_dependencies: [
            "work_package_version_id text not null references work_package_versions(id) on delete cascade",
            "predecessor_work_package_version_id text not null references work_package_versions(id)",
            "kind text not null check ( kind in ('artifact', 'commit', 'contract', 'readiness', 'manual') )",
            "contract_version text",
            "evidence_ref text",
            "primary key ( work_package_version_id, predecessor_work_package_version_id, kind )",
            "check (work_package_version_id <> predecessor_work_package_version_id)",
            ") strict",
          ],
          work_package_assignments: [
            "work_package_version_id text not null references work_package_versions(id)",
            "node_attempt_id text not null unique references node_attempts(id)",
            "position_id text not null references positions(id)",
            "ai_member_id text not null references ai_members(id)",
            "allocation_id text not null unique references workspace_allocations(id)",
            "interaction_session_id text not null unique references interaction_sessions(id)",
            "sandbox_identity text not null unique",
            "evidence_scope text not null unique",
            "state text not null check ( state in ( 'assigned', 'running', 'awaiting-self-check', 'self-check-passed', 'failed', 'superseded' ) )",
            ") strict",
          ],
          work_package_self_checks: [
            "assignment_id text not null references work_package_assignments(id)",
            "node_attempt_id text not null references node_attempts(id)",
            "status text not null check (status in ('passed', 'failed'))",
            "report_hash text not null check (length(report_hash) = 64)",
            "unique (assignment_id, node_attempt_id)",
            ") strict",
          ],
          workspace_allocations: [
            "work_package_version_id text references work_package_versions(id)",
            "node_attempt_id text references node_attempts(id)",
            "interaction_session_id text references interaction_sessions(id)",
            "sandbox_identity text",
            "evidence_scope text",
          ],
        } as const;
        const incompatibleTables = Object.entries(requiredTableFragments)
          .filter(([name, fragments]) => {
            const sql = objectSql(name);
            return (
              !sql ||
              fragments.some(
                (fragment) => !sql.includes(normalizeSql(fragment)),
              )
            );
          })
          .map(([name]) => name);
        const requiredExactTableSql = {
          work_packages: `CREATE TABLE work_packages (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
            technical_baseline_id TEXT NOT NULL REFERENCES technical_baselines(id),
            state TEXT NOT NULL CHECK (
              state IN (
                'ready', 'assigned', 'running', 'self-check', 'blocked', 'failed'
              )
            ),
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (run_id, id)
          ) STRICT`,
          work_package_versions: `CREATE TABLE work_package_versions (
            id TEXT PRIMARY KEY,
            work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
            version INTEGER NOT NULL CHECK (version > 0),
            application_id TEXT NOT NULL REFERENCES application_references(id),
            repository_reference TEXT NOT NULL,
            node_run_id TEXT NOT NULL REFERENCES node_runs(id),
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            status TEXT NOT NULL CHECK (status IN ('ready', 'superseded')),
            created_at TEXT NOT NULL,
            UNIQUE (work_package_id, version)
          ) STRICT`,
          work_package_dependencies: `CREATE TABLE work_package_dependencies (
            work_package_version_id TEXT NOT NULL
              REFERENCES work_package_versions(id) ON DELETE CASCADE,
            predecessor_work_package_version_id TEXT NOT NULL
              REFERENCES work_package_versions(id),
            kind TEXT NOT NULL CHECK (
              kind IN ('artifact', 'commit', 'contract', 'readiness', 'manual')
            ),
            contract_id TEXT,
            contract_version TEXT,
            evidence_ref TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (
              work_package_version_id,
              predecessor_work_package_version_id,
              kind
            ),
            CHECK (work_package_version_id <> predecessor_work_package_version_id)
          ) STRICT`,
          work_package_assignments: `CREATE TABLE work_package_assignments (
            id TEXT PRIMARY KEY,
            work_package_version_id TEXT NOT NULL
              REFERENCES work_package_versions(id),
            node_attempt_id TEXT NOT NULL UNIQUE REFERENCES node_attempts(id),
            position_id TEXT NOT NULL REFERENCES positions(id),
            ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
            agent_adapter_id TEXT NOT NULL,
            rationale_json TEXT NOT NULL,
            allocation_id TEXT NOT NULL UNIQUE REFERENCES workspace_allocations(id),
            interaction_session_id TEXT NOT NULL UNIQUE
              REFERENCES interaction_sessions(id),
            sandbox_identity TEXT NOT NULL UNIQUE,
            evidence_scope TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (
              state IN (
                'assigned', 'running', 'awaiting-self-check',
                'self-check-passed', 'failed', 'superseded'
              )
            ),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT`,
          work_package_self_checks: `CREATE TABLE work_package_self_checks (
            id TEXT PRIMARY KEY,
            assignment_id TEXT NOT NULL REFERENCES work_package_assignments(id),
            node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
            status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
            report_json TEXT NOT NULL,
            report_hash TEXT NOT NULL CHECK (length(report_hash) = 64),
            created_at TEXT NOT NULL,
            UNIQUE (assignment_id, node_attempt_id)
          ) STRICT`,
          workspace_allocations: `CREATE TABLE workspace_allocations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            application_id TEXT NOT NULL REFERENCES application_references(id),
            execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
            execution_profile_revision INTEGER NOT NULL CHECK (execution_profile_revision >= 0),
            operation_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (
              state IN ('planned', 'provisioning', 'ready', 'failed',
                        'cleanup-pending', 'cleaned')
            ),
            repository_root TEXT NOT NULL,
            allocation_root TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
            expected_source_tip TEXT NOT NULL CHECK (length(expected_source_tip) = 40),
            capability_snapshot_json TEXT NOT NULL,
            capability_snapshot_hash TEXT NOT NULL CHECK (length(capability_snapshot_hash) = 64),
            private_git_identity_json TEXT,
            provision_receipt_json TEXT,
            cleanup_evidence_json TEXT,
            failure_code TEXT,
            failure_message TEXT,
            provision_command_id TEXT NOT NULL,
            cleanup_command_id TEXT,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            work_package_version_id TEXT
              REFERENCES work_package_versions(id),
            node_attempt_id TEXT REFERENCES node_attempts(id),
            interaction_session_id TEXT REFERENCES interaction_sessions(id),
            sandbox_identity TEXT,
            evidence_scope TEXT
          ) STRICT`,
        } as const;
        incompatibleTables.push(
          ...Object.entries(requiredExactTableSql)
            .filter(
              ([name, expected]) => objectSql(name) !== normalizeSql(expected),
            )
            .map(([name]) => name),
        );
        const workspaceAllocationColumns = database
          .prepare("PRAGMA table_info(workspace_allocations)")
          .all()
          .map((entry) => {
            const column = entry as {
              readonly name: string;
              readonly type: string;
              readonly notnull: number;
              readonly dflt_value: string | null;
              readonly pk: number;
            };
            return `${column.name}:${column.type}:${column.notnull}:${column.dflt_value ?? ""}:${column.pk}`;
          })
          .join("|");
        const expectedWorkspaceAllocationColumns = [
          "id:TEXT:1::1",
          "project_id:TEXT:1::0",
          "application_id:TEXT:1::0",
          "execution_profile_id:TEXT:1::0",
          "execution_profile_revision:INTEGER:1::0",
          "operation_key:TEXT:1::0",
          "state:TEXT:1::0",
          "repository_root:TEXT:1::0",
          "allocation_root:TEXT:1::0",
          "source_branch:TEXT:1::0",
          "base_commit:TEXT:1::0",
          "expected_source_tip:TEXT:1::0",
          "capability_snapshot_json:TEXT:1::0",
          "capability_snapshot_hash:TEXT:1::0",
          "private_git_identity_json:TEXT:0::0",
          "provision_receipt_json:TEXT:0::0",
          "cleanup_evidence_json:TEXT:0::0",
          "failure_code:TEXT:0::0",
          "failure_message:TEXT:0::0",
          "provision_command_id:TEXT:1::0",
          "cleanup_command_id:TEXT:0::0",
          "revision:INTEGER:1:0:0",
          "created_at:TEXT:1::0",
          "updated_at:TEXT:1::0",
          "work_package_version_id:TEXT:0::0",
          "node_attempt_id:TEXT:0::0",
          "interaction_session_id:TEXT:0::0",
          "sandbox_identity:TEXT:0::0",
          "evidence_scope:TEXT:0::0",
        ].join("|");
        if (workspaceAllocationColumns !== expectedWorkspaceAllocationColumns) {
          incompatibleTables.push("workspace_allocations");
        }
        const requiredExactSql = {
          work_packages_run_idx:
            "CREATE INDEX work_packages_run_idx ON work_packages(run_id, created_at, id)",
          work_package_versions_node_idx:
            "CREATE INDEX work_package_versions_node_idx ON work_package_versions(node_run_id, status, created_at)",
          work_package_versions_active_node_idx:
            "CREATE UNIQUE INDEX work_package_versions_active_node_idx ON work_package_versions(node_run_id) WHERE status = 'ready'",
          work_package_dependencies_predecessor_idx:
            "CREATE INDEX work_package_dependencies_predecessor_idx ON work_package_dependencies(predecessor_work_package_version_id)",
          work_package_assignments_version_idx:
            "CREATE INDEX work_package_assignments_version_idx ON work_package_assignments(work_package_version_id, created_at)",
          workspace_allocations_attempt_idx:
            "CREATE UNIQUE INDEX workspace_allocations_attempt_idx ON workspace_allocations(node_attempt_id) WHERE node_attempt_id IS NOT NULL",
          workspace_allocations_session_idx:
            "CREATE UNIQUE INDEX workspace_allocations_session_idx ON workspace_allocations(interaction_session_id) WHERE interaction_session_id IS NOT NULL",
          workspace_allocations_sandbox_idx:
            "CREATE UNIQUE INDEX workspace_allocations_sandbox_idx ON workspace_allocations(sandbox_identity) WHERE sandbox_identity IS NOT NULL",
          workspace_allocations_evidence_idx:
            "CREATE UNIQUE INDEX workspace_allocations_evidence_idx ON workspace_allocations(evidence_scope) WHERE evidence_scope IS NOT NULL",
          work_package_versions_immutable_update: `
            CREATE TRIGGER work_package_versions_immutable_update
            BEFORE UPDATE ON work_package_versions
            WHEN NEW.id <> OLD.id
              OR NEW.work_package_id <> OLD.work_package_id
              OR NEW.version <> OLD.version
              OR NEW.application_id <> OLD.application_id
              OR NEW.repository_reference <> OLD.repository_reference
              OR NEW.node_run_id <> OLD.node_run_id
              OR NEW.manifest_json <> OLD.manifest_json
              OR NEW.manifest_hash <> OLD.manifest_hash
              OR NEW.created_at <> OLD.created_at
            BEGIN
              SELECT RAISE(ABORT, 'Work Package Version is immutable');
            END`,
          work_package_versions_immutable_delete: `
            CREATE TRIGGER work_package_versions_immutable_delete
            BEFORE DELETE ON work_package_versions
            BEGIN
              SELECT RAISE(ABORT, 'Work Package Version is immutable');
            END`,
          work_package_self_checks_immutable_update: `
            CREATE TRIGGER work_package_self_checks_immutable_update
            BEFORE UPDATE ON work_package_self_checks
            BEGIN
              SELECT RAISE(ABORT, 'Work Package self-check evidence is immutable');
            END`,
          work_package_self_checks_immutable_delete: `
            CREATE TRIGGER work_package_self_checks_immutable_delete
            BEFORE DELETE ON work_package_self_checks
            BEGIN
              SELECT RAISE(ABORT, 'Work Package self-check evidence is immutable');
            END`,
        } as const;
        const incompatibleObjects = Object.entries(requiredExactSql)
          .filter(
            ([name, expected]) => objectSql(name) !== normalizeSql(expected),
          )
          .map(([name]) => name);
        if (
          missingColumns.length > 0 ||
          missingObjects.length > 0 ||
          incompatibleTables.length > 0 ||
          incompatibleObjects.length > 0
        ) {
          throw new Error(
            `Existing Work Package schema is incompatible: ${[
              ...missingColumns,
              ...missingObjects,
              ...incompatibleTables,
              ...incompatibleObjects,
            ].join(", ")}`,
          );
        }
        return;
      }

      database.exec(`
        CREATE TABLE work_packages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES department_runs(id) ON DELETE CASCADE,
          technical_baseline_id TEXT NOT NULL REFERENCES technical_baselines(id),
          state TEXT NOT NULL CHECK (
            state IN (
              'ready', 'assigned', 'running', 'self-check', 'blocked', 'failed'
            )
          ),
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, id)
        ) STRICT;

        CREATE TABLE work_package_versions (
          id TEXT PRIMARY KEY,
          work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK (version > 0),
          application_id TEXT NOT NULL REFERENCES application_references(id),
          repository_reference TEXT NOT NULL,
          node_run_id TEXT NOT NULL REFERENCES node_runs(id),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
          status TEXT NOT NULL CHECK (status IN ('ready', 'superseded')),
          created_at TEXT NOT NULL,
          UNIQUE (work_package_id, version)
        ) STRICT;

        CREATE TABLE work_package_dependencies (
          work_package_version_id TEXT NOT NULL
            REFERENCES work_package_versions(id) ON DELETE CASCADE,
          predecessor_work_package_version_id TEXT NOT NULL
            REFERENCES work_package_versions(id),
          kind TEXT NOT NULL CHECK (
            kind IN ('artifact', 'commit', 'contract', 'readiness', 'manual')
          ),
          contract_id TEXT,
          contract_version TEXT,
          evidence_ref TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (
            work_package_version_id,
            predecessor_work_package_version_id,
            kind
          ),
          CHECK (work_package_version_id <> predecessor_work_package_version_id)
        ) STRICT;

        CREATE TABLE work_package_assignments (
          id TEXT PRIMARY KEY,
          work_package_version_id TEXT NOT NULL
            REFERENCES work_package_versions(id),
          node_attempt_id TEXT NOT NULL UNIQUE REFERENCES node_attempts(id),
          position_id TEXT NOT NULL REFERENCES positions(id),
          ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          agent_adapter_id TEXT NOT NULL,
          rationale_json TEXT NOT NULL,
          allocation_id TEXT NOT NULL UNIQUE REFERENCES workspace_allocations(id),
          interaction_session_id TEXT NOT NULL UNIQUE
            REFERENCES interaction_sessions(id),
          sandbox_identity TEXT NOT NULL UNIQUE,
          evidence_scope TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (
            state IN (
              'assigned', 'running', 'awaiting-self-check',
              'self-check-passed', 'failed', 'superseded'
            )
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE work_package_self_checks (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL REFERENCES work_package_assignments(id),
          node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
          status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
          report_json TEXT NOT NULL,
          report_hash TEXT NOT NULL CHECK (length(report_hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (assignment_id, node_attempt_id)
        ) STRICT;

        ALTER TABLE workspace_allocations
          ADD COLUMN work_package_version_id TEXT
            REFERENCES work_package_versions(id);
        ALTER TABLE workspace_allocations
          ADD COLUMN node_attempt_id TEXT REFERENCES node_attempts(id);
        ALTER TABLE workspace_allocations
          ADD COLUMN interaction_session_id TEXT REFERENCES interaction_sessions(id);
        ALTER TABLE workspace_allocations
          ADD COLUMN sandbox_identity TEXT;
        ALTER TABLE workspace_allocations
          ADD COLUMN evidence_scope TEXT;

        CREATE INDEX work_packages_run_idx
          ON work_packages(run_id, created_at, id);
        CREATE INDEX work_package_versions_node_idx
          ON work_package_versions(node_run_id, status, created_at);
        CREATE UNIQUE INDEX work_package_versions_active_node_idx
          ON work_package_versions(node_run_id)
          WHERE status = 'ready';
        CREATE INDEX work_package_dependencies_predecessor_idx
          ON work_package_dependencies(predecessor_work_package_version_id);
        CREATE INDEX work_package_assignments_version_idx
          ON work_package_assignments(work_package_version_id, created_at);
        CREATE UNIQUE INDEX workspace_allocations_attempt_idx
          ON workspace_allocations(node_attempt_id)
          WHERE node_attempt_id IS NOT NULL;
        CREATE UNIQUE INDEX workspace_allocations_session_idx
          ON workspace_allocations(interaction_session_id)
          WHERE interaction_session_id IS NOT NULL;
        CREATE UNIQUE INDEX workspace_allocations_sandbox_idx
          ON workspace_allocations(sandbox_identity)
          WHERE sandbox_identity IS NOT NULL;
        CREATE UNIQUE INDEX workspace_allocations_evidence_idx
          ON workspace_allocations(evidence_scope)
          WHERE evidence_scope IS NOT NULL;

        CREATE TRIGGER work_package_versions_immutable_update
        BEFORE UPDATE ON work_package_versions
        WHEN NEW.id <> OLD.id
          OR NEW.work_package_id <> OLD.work_package_id
          OR NEW.version <> OLD.version
          OR NEW.application_id <> OLD.application_id
          OR NEW.repository_reference <> OLD.repository_reference
          OR NEW.node_run_id <> OLD.node_run_id
          OR NEW.manifest_json <> OLD.manifest_json
          OR NEW.manifest_hash <> OLD.manifest_hash
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Work Package Version is immutable');
        END;
        CREATE TRIGGER work_package_versions_immutable_delete
        BEFORE DELETE ON work_package_versions
        BEGIN
          SELECT RAISE(ABORT, 'Work Package Version is immutable');
        END;
        CREATE TRIGGER work_package_self_checks_immutable_update
        BEFORE UPDATE ON work_package_self_checks
        BEGIN
          SELECT RAISE(ABORT, 'Work Package self-check evidence is immutable');
        END;
        CREATE TRIGGER work_package_self_checks_immutable_delete
        BEFORE DELETE ON work_package_self_checks
        BEGIN
          SELECT RAISE(ABORT, 'Work Package self-check evidence is immutable');
        END;
      `);
    },
  },
  {
    version: 43,
    name: "independent_code_review_authority",
    migrate: (database) => {
      const schemaSql = {
        code_review_manifests: `CREATE TABLE code_review_manifests (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL UNIQUE REFERENCES review_topics(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          run_id TEXT NOT NULL REFERENCES department_runs(id),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          work_package_id TEXT NOT NULL REFERENCES work_packages(id),
          work_package_version_id TEXT NOT NULL REFERENCES work_package_versions(id),
          assignment_id TEXT NOT NULL REFERENCES work_package_assignments(id),
          node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
          workspace_import_id TEXT NOT NULL REFERENCES workspace_imports(id),
          diff_artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT`,
        reviewer_workspace_intents: `CREATE TABLE reviewer_workspace_intents (
          id TEXT PRIMARY KEY,
          code_review_manifest_id TEXT NOT NULL UNIQUE REFERENCES code_review_manifests(id),
          operation_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('intent', 'ready', 'blocked', 'unknown')),
          reviewer_ai_member_id TEXT NOT NULL REFERENCES ai_members(id),
          reviewer_position_id TEXT NOT NULL REFERENCES positions(id),
          reviewer_session_id TEXT NOT NULL UNIQUE REFERENCES interaction_sessions(id),
          review_node_run_id TEXT NOT NULL REFERENCES node_runs(id),
          provider_id TEXT,
          workspace_ref TEXT,
          capability_snapshot_json TEXT,
          capability_snapshot_hash TEXT,
          independence_evidence_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT`,
        code_review_defects: `CREATE TABLE code_review_defects (
          id TEXT PRIMARY KEY,
          code_review_manifest_id TEXT NOT NULL REFERENCES code_review_manifests(id),
          quality_gate_result_id TEXT NOT NULL REFERENCES quality_gate_results(id),
          work_package_id TEXT NOT NULL REFERENCES work_packages(id),
          result TEXT NOT NULL CHECK (result IN ('CONDITIONAL_PASS', 'FAIL')),
          finding_ids_json TEXT NOT NULL,
          obligation_json TEXT NOT NULL,
          rework_work_package_version_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('open', 'rework-created', 'closed')),
          created_at TEXT NOT NULL
        ) STRICT`,
        code_review_authorities: `CREATE TABLE code_review_authorities (
          id TEXT PRIMARY KEY,
          code_review_manifest_id TEXT NOT NULL UNIQUE REFERENCES code_review_manifests(id),
          quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          run_id TEXT NOT NULL REFERENCES department_runs(id),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          work_package_id TEXT NOT NULL REFERENCES work_packages(id),
          work_package_version_id TEXT NOT NULL REFERENCES work_package_versions(id),
          assignment_id TEXT NOT NULL REFERENCES work_package_assignments(id),
          node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
          repository_reference TEXT NOT NULL,
          base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
          source_commit TEXT NOT NULL CHECK (length(source_commit) = 40),
          workspace_import_id TEXT NOT NULL REFERENCES workspace_imports(id),
          diff_artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
          diff_hash TEXT NOT NULL CHECK (length(diff_hash) = 64),
          self_check_id TEXT NOT NULL REFERENCES work_package_self_checks(id),
          self_check_hash TEXT NOT NULL CHECK (length(self_check_hash) = 64),
          topic_id TEXT NOT NULL REFERENCES review_topics(id),
          manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
          reviewer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          independence_evidence_hash TEXT NOT NULL CHECK (length(independence_evidence_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT`,
        code_review_manifests_package_idx:
          "CREATE INDEX code_review_manifests_package_idx ON code_review_manifests(work_package_id, created_at, id)",
        code_review_defects_package_idx:
          "CREATE INDEX code_review_defects_package_idx ON code_review_defects(work_package_id, status, created_at, id)",
        code_review_manifests_immutable_update:
          "CREATE TRIGGER code_review_manifests_immutable_update BEFORE UPDATE ON code_review_manifests BEGIN SELECT RAISE(ABORT, 'Code Review manifest is immutable'); END",
        code_review_manifests_immutable_delete:
          "CREATE TRIGGER code_review_manifests_immutable_delete BEFORE DELETE ON code_review_manifests BEGIN SELECT RAISE(ABORT, 'Code Review manifest is immutable'); END",
        code_review_authorities_immutable_update:
          "CREATE TRIGGER code_review_authorities_immutable_update BEFORE UPDATE ON code_review_authorities BEGIN SELECT RAISE(ABORT, 'Code Review authority is immutable'); END",
        code_review_authorities_immutable_delete:
          "CREATE TRIGGER code_review_authorities_immutable_delete BEFORE DELETE ON code_review_authorities BEGIN SELECT RAISE(ABORT, 'Code Review authority is immutable'); END",
      } as const;
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const existingObjects = database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE name LIKE 'code_review%'
              OR name LIKE 'reviewer_workspace%'`,
        )
        .all() as Array<{ readonly name: string }>;
      if (existingObjects.length > 0) {
        const incompatible = Object.entries(schemaSql)
          .filter(([name, expected]) => {
            const row = database
              .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
              .get(name) as { readonly sql: string | null } | undefined;
            const compatibleSql =
              name === "code_review_authorities" && row?.sql
                ? row.sql.replace(
                    /,\s*initial_execution_stage_id TEXT REFERENCES code_review_execution_stages\(id\),\s*initial_isolation_receipt_hash TEXT,\s*initial_result_hash TEXT,\s*fresh_execution_stage_id TEXT REFERENCES code_review_execution_stages\(id\),\s*fresh_isolation_receipt_hash TEXT,\s*fresh_result_hash TEXT(?=\s*\)\s*STRICT)/i,
                    "",
                  )
                : row?.sql;
            return (
              !compatibleSql ||
              normalizeSql(compatibleSql) !== normalizeSql(expected)
            );
          })
          .map(([name]) => name);
        if (incompatible.length > 0) {
          throw new Error(
            `Existing Code Review schema is incompatible: ${incompatible.join(", ")}`,
          );
        }
        return;
      }
      database.exec(`${Object.values(schemaSql).join(";\n")};`);
    },
  },
  {
    version: 44,
    name: "durable_code_review_execution",
    migrate: (database) => {
      const schemaSql = {
        code_review_execution_stages: `CREATE TABLE code_review_execution_stages (
          id TEXT PRIMARY KEY,
          code_review_manifest_id TEXT NOT NULL REFERENCES code_review_manifests(id),
          phase TEXT NOT NULL CHECK (phase IN ('initial-finding', 'fresh-recheck')),
          operation_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'blocked', 'unknown')),
          reviewer_participant_id TEXT NOT NULL REFERENCES review_participants(id),
          reviewer_session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
          provider_id TEXT,
          isolation_receipt_json TEXT,
          isolation_receipt_hash TEXT,
          result_json TEXT,
          result_hash TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(code_review_manifest_id, phase)
        ) STRICT`,
        code_review_execution_stages_state_idx:
          "CREATE INDEX code_review_execution_stages_state_idx ON code_review_execution_stages(state, updated_at, id)",
        code_review_execution_stages_identity_update: `
          CREATE TRIGGER code_review_execution_stages_identity_update
          BEFORE UPDATE ON code_review_execution_stages
          WHEN NEW.id <> OLD.id
            OR NEW.code_review_manifest_id <> OLD.code_review_manifest_id
            OR NEW.phase <> OLD.phase
            OR NEW.operation_key <> OLD.operation_key
            OR NEW.reviewer_participant_id <> OLD.reviewer_participant_id
            OR NEW.reviewer_session_id <> OLD.reviewer_session_id
            OR NEW.created_at <> OLD.created_at
          BEGIN
            SELECT RAISE(ABORT, 'Code Review execution identity is immutable');
          END`,
        code_review_execution_stages_immutable_delete: `
          CREATE TRIGGER code_review_execution_stages_immutable_delete
          BEFORE DELETE ON code_review_execution_stages
          BEGIN
            SELECT RAISE(ABORT, 'Code Review execution evidence is immutable');
          END`,
      } as const;
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const existingObjects = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE name LIKE 'code_review_execution_stages%'`,
        )
        .all() as Array<{ readonly name: string }>;
      if (existingObjects.length > 0) {
        const incompatible = Object.entries(schemaSql)
          .filter(([name, expected]) => {
            const row = database
              .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
              .get(name) as { readonly sql: string | null } | undefined;
            return (
              !row?.sql || normalizeSql(row.sql) !== normalizeSql(expected)
            );
          })
          .map(([name]) => name);
        if (incompatible.length > 0) {
          throw new Error(
            `Existing Code Review execution schema is incompatible: ${incompatible.join(", ")}`,
          );
        }
        return;
      }
      database.exec(`${Object.values(schemaSql).join(";\n")};`);
    },
  },
  {
    version: 45,
    name: "immutable_exact_code_review_execution_evidence",
    migrate: (database) => {
      const columns = database
        .prepare("PRAGMA table_info(code_review_authorities)")
        .all() as Array<{ readonly name: string }>;
      if (
        !columns.some((column) => column.name === "initial_execution_stage_id")
      ) {
        database.exec(`
          DROP TRIGGER code_review_authorities_immutable_update;
          ALTER TABLE code_review_authorities
            ADD COLUMN initial_execution_stage_id TEXT REFERENCES code_review_execution_stages(id);
          ALTER TABLE code_review_authorities
            ADD COLUMN initial_isolation_receipt_hash TEXT;
          ALTER TABLE code_review_authorities
            ADD COLUMN initial_result_hash TEXT;
          ALTER TABLE code_review_authorities
            ADD COLUMN fresh_execution_stage_id TEXT REFERENCES code_review_execution_stages(id);
          ALTER TABLE code_review_authorities
            ADD COLUMN fresh_isolation_receipt_hash TEXT;
          ALTER TABLE code_review_authorities
            ADD COLUMN fresh_result_hash TEXT;
          UPDATE code_review_authorities
             SET initial_execution_stage_id = (
                   SELECT id FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'initial-finding'
                 ),
                 initial_isolation_receipt_hash = (
                   SELECT isolation_receipt_hash FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'initial-finding'
                 ),
                 initial_result_hash = (
                   SELECT result_hash FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'initial-finding'
                 ),
                 fresh_execution_stage_id = (
                   SELECT id FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'fresh-recheck'
                 ),
                 fresh_isolation_receipt_hash = (
                   SELECT isolation_receipt_hash FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'fresh-recheck'
                 ),
                 fresh_result_hash = (
                   SELECT result_hash FROM code_review_execution_stages
                    WHERE code_review_manifest_id = code_review_authorities.code_review_manifest_id
                      AND phase = 'fresh-recheck'
                 );
          CREATE TRIGGER code_review_authorities_immutable_update
          BEFORE UPDATE ON code_review_authorities
          BEGIN
            SELECT RAISE(ABORT, 'Code Review authority is immutable');
          END;
        `);
      }
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS code_review_execution_stages_succeeded_update
        BEFORE UPDATE ON code_review_execution_stages
        WHEN OLD.state = 'succeeded' AND (
          NEW.state IS NOT OLD.state
          OR NEW.provider_id IS NOT OLD.provider_id
          OR NEW.isolation_receipt_json IS NOT OLD.isolation_receipt_json
          OR NEW.isolation_receipt_hash IS NOT OLD.isolation_receipt_hash
          OR NEW.result_json IS NOT OLD.result_json
          OR NEW.result_hash IS NOT OLD.result_hash
          OR NEW.failure_code IS NOT OLD.failure_code
          OR NEW.failure_message IS NOT OLD.failure_message
          OR NEW.updated_at IS NOT OLD.updated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'Succeeded Code Review execution evidence is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS code_review_authorities_execution_binding_insert
        BEFORE INSERT ON code_review_authorities
        WHEN NEW.initial_execution_stage_id IS NULL
          OR NEW.initial_isolation_receipt_hash IS NULL
          OR length(NEW.initial_isolation_receipt_hash) <> 64
          OR NEW.initial_result_hash IS NULL
          OR length(NEW.initial_result_hash) <> 64
          OR NEW.fresh_execution_stage_id IS NULL
          OR NEW.fresh_isolation_receipt_hash IS NULL
          OR length(NEW.fresh_isolation_receipt_hash) <> 64
          OR NEW.fresh_result_hash IS NULL
          OR length(NEW.fresh_result_hash) <> 64
        BEGIN
          SELECT RAISE(ABORT, 'Code Review authority requires exact execution evidence bindings');
        END;
      `);
    },
  },
  {
    version: 46,
    name: "multi_repository_integration_generations",
    migrate: (database) => {
      const createIntegrationSchema = (target: DatabaseSync): void =>
        target.exec(`
        CREATE TABLE integration_generations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          run_id TEXT NOT NULL REFERENCES department_runs(id),
          snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
          node_run_id TEXT NOT NULL REFERENCES node_runs(id),
          generation INTEGER NOT NULL CHECK (generation > 0),
          coverage_id TEXT NOT NULL,
          coverage_node_run_id TEXT NOT NULL REFERENCES node_runs(id),
          coverage_node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
          coverage_hash TEXT NOT NULL CHECK (length(coverage_hash) = 64),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
          state TEXT NOT NULL CHECK (
            state IN (
              'pending', 'running', 'validating', 'aggregate-review', 'blocked', 'failed', 'passed'
            )
          ),
          pass_authority_hash TEXT CHECK (
            pass_authority_hash IS NULL OR length(pass_authority_hash) = 64
          ),
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, generation),
          UNIQUE (run_id, coverage_id)
        ) STRICT;

        CREATE TABLE integration_repository_results (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL REFERENCES integration_generations(id),
          repository_reference TEXT NOT NULL,
          base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
          integration_branch TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('pending', 'running', 'validating', 'succeeded', 'failed', 'blocked')
          ),
          expected_tip TEXT NOT NULL CHECK (length(expected_tip) = 40),
          integrated_commit TEXT CHECK (
            integrated_commit IS NULL OR length(integrated_commit) = 40
          ),
          validation_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (generation_id, repository_reference)
        ) STRICT;

        CREATE TABLE integration_operations (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL REFERENCES integration_generations(id),
          repository_result_id TEXT NOT NULL REFERENCES integration_repository_results(id),
          work_package_id TEXT NOT NULL REFERENCES work_packages(id),
          work_package_version_id TEXT NOT NULL REFERENCES work_package_versions(id),
          authority_id TEXT NOT NULL REFERENCES code_review_authorities(id),
          quality_gate_result_id TEXT NOT NULL REFERENCES quality_gate_results(id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          source_branch TEXT NOT NULL,
          source_commit TEXT NOT NULL CHECK (length(source_commit) = 40),
          diff_hash TEXT NOT NULL CHECK (length(diff_hash) = 64),
          expected_tip TEXT NOT NULL CHECK (length(expected_tip) = 40),
          request_json TEXT NOT NULL,
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (
            state IN ('intent', 'running', 'succeeded', 'failed', 'unknown', 'blocked')
          ),
          receipt_json TEXT,
          receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
          resulting_commit TEXT CHECK (
            resulting_commit IS NULL OR length(resulting_commit) = 40
          ),
          failure_code TEXT,
          failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (generation_id, work_package_version_id),
          UNIQUE (generation_id, repository_result_id, ordinal)
        ) STRICT;

        CREATE TABLE integration_defects (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL REFERENCES integration_generations(id),
          integration_operation_id TEXT REFERENCES integration_operations(id),
          kind TEXT NOT NULL CHECK (
            kind IN ('git-conflict', 'build-test', 'contract', 'aggregate', 'reconciliation')
          ),
          responsibility_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
          created_at TEXT NOT NULL,
          closed_at TEXT
        ) STRICT;

        CREATE TABLE integration_validation_records (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL REFERENCES integration_generations(id),
          repository_result_id TEXT NOT NULL REFERENCES integration_repository_results(id),
          validation_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('build-test', 'contract')),
          status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
          evidence_json TEXT NOT NULL,
          responsibility_json TEXT NOT NULL,
          contract_failure_json TEXT,
          record_hash TEXT NOT NULL CHECK (length(record_hash) = 64),
          created_at TEXT NOT NULL,
          UNIQUE (generation_id, validation_id)
        ) STRICT;

        CREATE TABLE integration_aggregate_reviews (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL UNIQUE REFERENCES integration_generations(id),
          topic_id TEXT NOT NULL REFERENCES review_topics(id),
          quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
          input_json TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
          result TEXT NOT NULL CHECK (result IN ('PASS', 'CONDITIONAL_PASS', 'FAIL')),
          evidence_json TEXT NOT NULL,
          pass_authority_hash TEXT CHECK (
            pass_authority_hash IS NULL OR length(pass_authority_hash) = 64
          ),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE integration_execution_stages (
          id TEXT PRIMARY KEY,
          operation_key TEXT NOT NULL UNIQUE,
          generation_id TEXT NOT NULL REFERENCES integration_generations(id),
          phase TEXT NOT NULL CHECK (phase IN ('validation', 'aggregate-review')),
          target_key TEXT NOT NULL,
          request_json TEXT NOT NULL,
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          state TEXT NOT NULL CHECK (
            state IN ('running', 'reconciling', 'unknown', 'succeeded', 'failed')
          ),
          result_json TEXT,
          result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (generation_id, phase, target_key)
        ) STRICT;

        CREATE INDEX integration_generations_run_idx
          ON integration_generations(run_id, generation, created_at);
        CREATE INDEX integration_operations_state_idx
          ON integration_operations(state, updated_at, id);
        CREATE INDEX integration_validation_records_generation_idx
          ON integration_validation_records(generation_id, repository_result_id, validation_id);
        CREATE INDEX integration_defects_generation_idx
          ON integration_defects(generation_id, status, created_at, id);
        CREATE INDEX integration_execution_stages_state_idx
          ON integration_execution_stages(state, updated_at, operation_key);

        CREATE TRIGGER integration_generations_identity_update
        BEFORE UPDATE ON integration_generations
        WHEN NEW.id <> OLD.id
          OR NEW.project_id <> OLD.project_id
          OR NEW.run_id <> OLD.run_id
          OR NEW.snapshot_revision_id <> OLD.snapshot_revision_id
          OR NEW.node_run_id <> OLD.node_run_id
          OR NEW.generation <> OLD.generation
          OR NEW.coverage_id <> OLD.coverage_id
          OR NEW.coverage_node_run_id <> OLD.coverage_node_run_id
          OR NEW.coverage_node_attempt_id <> OLD.coverage_node_attempt_id
          OR NEW.coverage_hash <> OLD.coverage_hash
          OR NEW.manifest_json <> OLD.manifest_json
          OR NEW.manifest_hash <> OLD.manifest_hash
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Integration Generation manifest is immutable');
        END;
        CREATE TRIGGER integration_generations_immutable_delete
        BEFORE DELETE ON integration_generations
        BEGIN
          SELECT RAISE(ABORT, 'Integration Generation evidence is immutable');
        END;
        CREATE TRIGGER integration_operations_identity_update
        BEFORE UPDATE ON integration_operations
        WHEN NEW.id <> OLD.id
          OR NEW.generation_id <> OLD.generation_id
          OR NEW.repository_result_id <> OLD.repository_result_id
          OR NEW.work_package_id <> OLD.work_package_id
          OR NEW.work_package_version_id <> OLD.work_package_version_id
          OR NEW.authority_id <> OLD.authority_id
          OR NEW.quality_gate_result_id <> OLD.quality_gate_result_id
          OR NEW.ordinal <> OLD.ordinal
          OR NEW.source_branch <> OLD.source_branch
          OR NEW.source_commit <> OLD.source_commit
          OR NEW.diff_hash <> OLD.diff_hash
          OR NEW.expected_tip <> OLD.expected_tip
          OR NEW.request_json <> OLD.request_json
          OR NEW.request_hash <> OLD.request_hash
          OR NEW.idempotency_key <> OLD.idempotency_key
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Integration operation request is immutable');
        END;
        CREATE TRIGGER integration_operations_succeeded_update
        BEFORE UPDATE ON integration_operations
        WHEN OLD.state = 'succeeded' AND (
          NEW.state IS NOT OLD.state
          OR NEW.receipt_json IS NOT OLD.receipt_json
          OR NEW.receipt_hash IS NOT OLD.receipt_hash
          OR NEW.resulting_commit IS NOT OLD.resulting_commit
          OR NEW.failure_code IS NOT OLD.failure_code
          OR NEW.failure_message IS NOT OLD.failure_message
          OR NEW.updated_at IS NOT OLD.updated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'Succeeded Integration operation evidence is immutable');
        END;
        CREATE TRIGGER integration_operations_immutable_delete
        BEFORE DELETE ON integration_operations
        BEGIN
          SELECT RAISE(ABORT, 'Integration operation evidence is immutable');
        END;
        CREATE TRIGGER integration_repository_results_identity_update
        BEFORE UPDATE ON integration_repository_results
        WHEN NEW.id <> OLD.id
          OR NEW.generation_id <> OLD.generation_id
          OR NEW.repository_reference <> OLD.repository_reference
          OR NEW.base_commit <> OLD.base_commit
          OR NEW.integration_branch <> OLD.integration_branch
          OR NEW.created_at <> OLD.created_at
          OR (OLD.integrated_commit IS NOT NULL AND NEW.integrated_commit IS NOT OLD.integrated_commit)
        BEGIN
          SELECT RAISE(ABORT, 'Integration Repository result identity is immutable');
        END;
        CREATE TRIGGER integration_repository_results_terminal_update
        BEFORE UPDATE ON integration_repository_results
        WHEN OLD.state IN ('succeeded', 'failed') AND (
          NEW.state IS NOT OLD.state
          OR NEW.expected_tip IS NOT OLD.expected_tip
          OR NEW.integrated_commit IS NOT OLD.integrated_commit
          OR NEW.validation_json IS NOT OLD.validation_json
          OR NEW.failure_code IS NOT OLD.failure_code
          OR NEW.failure_message IS NOT OLD.failure_message
          OR NEW.updated_at IS NOT OLD.updated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'Terminal Integration Repository result is immutable');
        END;
        CREATE TRIGGER integration_repository_results_immutable_delete
        BEFORE DELETE ON integration_repository_results
        BEGIN
          SELECT RAISE(ABORT, 'Integration Repository result evidence is immutable');
        END;
        CREATE TRIGGER integration_validation_records_immutable_update
        BEFORE UPDATE ON integration_validation_records
        BEGIN
          SELECT RAISE(ABORT, 'Integration validation evidence is immutable');
        END;
        CREATE TRIGGER integration_validation_records_immutable_delete
        BEFORE DELETE ON integration_validation_records
        BEGIN
          SELECT RAISE(ABORT, 'Integration validation evidence is immutable');
        END;
        CREATE TRIGGER integration_defects_evidence_update
        BEFORE UPDATE ON integration_defects
        WHEN NEW.id <> OLD.id
          OR NEW.generation_id <> OLD.generation_id
          OR NEW.integration_operation_id IS NOT OLD.integration_operation_id
          OR NEW.kind <> OLD.kind
          OR NEW.responsibility_json <> OLD.responsibility_json
          OR NEW.evidence_json <> OLD.evidence_json
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Integration defect evidence is immutable');
        END;
        CREATE TRIGGER integration_defects_immutable_delete
        BEFORE DELETE ON integration_defects
        BEGIN
          SELECT RAISE(ABORT, 'Integration defect evidence is immutable');
        END;
        CREATE TRIGGER integration_aggregate_reviews_immutable_update
        BEFORE UPDATE ON integration_aggregate_reviews
        BEGIN
          SELECT RAISE(ABORT, 'Aggregate Integration review is immutable');
        END;
        CREATE TRIGGER integration_aggregate_reviews_immutable_delete
        BEFORE DELETE ON integration_aggregate_reviews
        BEGIN
          SELECT RAISE(ABORT, 'Aggregate Integration review is immutable');
        END;
        CREATE TRIGGER integration_execution_stages_identity_update
        BEFORE UPDATE ON integration_execution_stages
        WHEN NEW.id <> OLD.id
          OR NEW.operation_key <> OLD.operation_key
          OR NEW.generation_id <> OLD.generation_id
          OR NEW.phase <> OLD.phase
          OR NEW.target_key <> OLD.target_key
          OR NEW.request_json <> OLD.request_json
          OR NEW.request_hash <> OLD.request_hash
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Integration execution stage identity is immutable');
        END;
        CREATE TRIGGER integration_execution_stages_terminal_update
        BEFORE UPDATE ON integration_execution_stages
        WHEN OLD.state IN ('succeeded', 'failed') AND (
          NEW.state IS NOT OLD.state
          OR NEW.result_json IS NOT OLD.result_json
          OR NEW.result_hash IS NOT OLD.result_hash
          OR NEW.updated_at IS NOT OLD.updated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'Terminal Integration execution stage is immutable');
        END;
        CREATE TRIGGER integration_execution_stages_immutable_delete
        BEFORE DELETE ON integration_execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'Integration execution stage evidence is immutable');
        END;
      `);
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const reference = new DatabaseSync(":memory:");
      try {
        createIntegrationSchema(reference);
        const expectedObjects = reference
          .prepare(
            `SELECT type, name, sql FROM sqlite_schema
              WHERE name LIKE 'integration_%' ORDER BY name`,
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
        const actualObjects = database
          .prepare(
            `SELECT type, name, sql FROM sqlite_schema
              WHERE name LIKE 'integration_%' ORDER BY name`,
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
        if (actualObjects.length > 0) {
          const actualByName = new Map(
            actualObjects.map((entry) => [entry.name, entry]),
          );
          const expectedNames = new Set(
            expectedObjects.map((entry) => entry.name),
          );
          const incompatible = expectedObjects
            .filter((expected) => {
              const actual = actualByName.get(expected.name);
              return (
                !actual ||
                actual.type !== expected.type ||
                normalizeSql(actual.sql) !== normalizeSql(expected.sql)
              );
            })
            .map((entry) => entry.name);
          incompatible.push(
            ...actualObjects
              .filter((entry) => !expectedNames.has(entry.name))
              .map((entry) => entry.name),
          );
          if (incompatible.length > 0) {
            throw new Error(
              `Existing Integration schema is incompatible: ${incompatible.join(", ")}`,
            );
          }
        } else {
          createIntegrationSchema(database);
        }
      } finally {
        reference.close();
      }
      const activeLeaseIndexSql = `CREATE UNIQUE INDEX execution_leases_active_operation_idx
        ON execution_leases(operation_key)
        WHERE released_at IS NULL`;
      const activeLeaseIndex = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'execution_leases_active_operation_idx'",
        )
        .get() as { readonly sql: string | null } | undefined;
      if (
        activeLeaseIndex?.sql &&
        normalizeSql(activeLeaseIndex.sql) !== normalizeSql(activeLeaseIndexSql)
      ) {
        throw new Error(
          "Existing Integration schema is incompatible: execution_leases_active_operation_idx",
        );
      }
      if (!activeLeaseIndex) database.exec(activeLeaseIndexSql);
    },
  },
  {
    version: 47,
    name: "versioned_test_cases_and_runs",
    migrate: (database) => {
      const v48Signals = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE name IN (
              'test_defect_resolutions_defect_idx',
              'test_run_obligation_resolutions',
              'test_rework_runs',
              'test_rework_runs_defect_idx',
              'test_run_obligation_resolutions_immutable_update',
              'test_run_obligation_resolutions_immutable_delete',
              'test_rework_runs_immutable_update',
              'test_rework_runs_immutable_delete'
            )`,
        )
        .all() as Array<{ readonly name: string }>;
      const obligationColumns = database
        .prepare("PRAGMA table_info(test_run_obligations)")
        .all() as Array<{ readonly name: string }>;
      const assertionResultColumns = database
        .prepare("PRAGMA table_info(test_assertion_results)")
        .all() as Array<{ readonly name: string }>;
      if (
        v48Signals.length > 0 ||
        obligationColumns.some((column) => column.name === "defect_id") ||
        assertionResultColumns.some(
          (column) =>
            column.name === "ui_observation_json" ||
            column.name === "runtime_observation_json",
        )
      ) {
        return;
      }
      const createTestSchema = (target: DatabaseSync): void =>
        target.exec(`
          CREATE TABLE test_cases (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_case_revisions (
            id TEXT PRIMARY KEY,
            test_case_id TEXT NOT NULL REFERENCES test_cases(id),
            revision INTEGER NOT NULL CHECK (revision > 0),
            supersedes_revision_id TEXT REFERENCES test_case_revisions(id),
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            created_at TEXT NOT NULL,
            UNIQUE (test_case_id, revision),
            UNIQUE (test_case_id, manifest_hash)
          ) STRICT;

          CREATE TABLE test_runs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL REFERENCES projects(id),
            run_id TEXT NOT NULL REFERENCES department_runs(id),
            snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
            node_run_id TEXT NOT NULL REFERENCES node_runs(id),
            node_attempt_id TEXT NOT NULL REFERENCES node_attempts(id),
            session_id TEXT NOT NULL REFERENCES interaction_sessions(id),
            integration_generation_id TEXT NOT NULL REFERENCES integration_generations(id),
            integration_manifest_hash TEXT NOT NULL CHECK (length(integration_manifest_hash) = 64),
            integration_pass_authority_hash TEXT NOT NULL CHECK (length(integration_pass_authority_hash) = 64),
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            state TEXT NOT NULL CHECK (
              state IN ('scheduled', 'running', 'reconciling', 'unknown', 'passed', 'failed', 'blocked', 'cancelled')
            ),
            pass_authority_hash TEXT CHECK (pass_authority_hash IS NULL OR length(pass_authority_hash) = 64),
            failure_code TEXT,
            failure_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_run_case_revisions (
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            test_case_revision_id TEXT NOT NULL REFERENCES test_case_revisions(id),
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            PRIMARY KEY (test_run_id, test_case_revision_id),
            UNIQUE (test_run_id, ordinal)
          ) STRICT;

          CREATE TABLE test_execution_operations (
            id TEXT PRIMARY KEY,
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            operation_key TEXT NOT NULL UNIQUE,
            request_json TEXT NOT NULL,
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            state TEXT NOT NULL CHECK (
              state IN ('intent', 'running', 'reconciling', 'not-started', 'unknown', 'succeeded', 'failed', 'cancelled')
            ),
            fact_json TEXT,
            fact_hash TEXT CHECK (fact_hash IS NULL OR length(fact_hash) = 64),
            receipt_json TEXT,
            receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (test_run_id, id)
          ) STRICT;

          CREATE TABLE test_execution_facts (
            id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL REFERENCES test_execution_operations(id),
            state TEXT NOT NULL CHECK (state IN ('not-started', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
            fact_json TEXT NOT NULL,
            fact_hash TEXT NOT NULL CHECK (length(fact_hash) = 64),
            evidence_ref TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (operation_id, fact_hash)
          ) STRICT;

          CREATE TABLE test_execution_control_operations (
            id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL REFERENCES test_execution_operations(id),
            kind TEXT NOT NULL CHECK (kind IN ('pause', 'cancel')),
            operation_key TEXT NOT NULL UNIQUE,
            request_json TEXT NOT NULL,
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            state TEXT NOT NULL CHECK (
              state IN ('intent', 'reconciling', 'not-started', 'unknown', 'cancelled')
            ),
            fact_json TEXT,
            fact_hash TEXT CHECK (fact_hash IS NULL OR length(fact_hash) = 64),
            receipt_json TEXT,
            receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_assertion_results (
            id TEXT PRIMARY KEY,
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            operation_id TEXT NOT NULL REFERENCES test_execution_operations(id),
            test_case_revision_id TEXT NOT NULL REFERENCES test_case_revisions(id),
            assertion_id TEXT NOT NULL,
            required INTEGER NOT NULL CHECK (required IN (0, 1)),
            ui_status TEXT NOT NULL CHECK (ui_status IN ('passed', 'failed', 'missing', 'unknown')),
            runtime_status TEXT NOT NULL CHECK (runtime_status IN ('passed', 'failed', 'missing', 'unknown')),
            correlation_json TEXT NOT NULL,
            result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
            created_at TEXT NOT NULL,
            UNIQUE (test_run_id, test_case_revision_id, assertion_id)
          ) STRICT;

          CREATE TABLE test_evidence (
            id TEXT PRIMARY KEY,
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            operation_id TEXT NOT NULL REFERENCES test_execution_operations(id),
            test_case_revision_id TEXT REFERENCES test_case_revisions(id),
            assertion_id TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('ui', 'runtime', 'screenshot', 'log', 'payload', 'receipt', 'cleanup')),
            media_type TEXT NOT NULL,
            content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            artifact_version_id TEXT,
            redaction_profile TEXT NOT NULL,
            retention_class TEXT NOT NULL CHECK (retention_class IN ('transient', 'standard', 'durable')),
            locator TEXT,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_defects (
            id TEXT PRIMARY KEY,
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            test_case_revision_id TEXT NOT NULL REFERENCES test_case_revisions(id),
            assertion_id TEXT,
            integration_generation_id TEXT NOT NULL REFERENCES integration_generations(id),
            responsibility_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
            created_at TEXT NOT NULL,
            closed_at TEXT
          ) STRICT;

          CREATE TABLE test_defect_resolutions (
            id TEXT PRIMARY KEY,
            defect_id TEXT NOT NULL REFERENCES test_defects(id),
            resolution_json TEXT NOT NULL,
            resolution_hash TEXT NOT NULL CHECK (length(resolution_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_run_obligations (
            id TEXT PRIMARY KEY,
            test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            description TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
            created_at TEXT NOT NULL,
            closed_at TEXT
          ) STRICT;

          CREATE INDEX test_case_revisions_case_idx ON test_case_revisions(test_case_id, revision, id);
          CREATE INDEX test_runs_run_idx ON test_runs(run_id, created_at, id);
          CREATE INDEX test_runs_state_idx ON test_runs(state, updated_at, id);
          CREATE INDEX test_execution_operations_state_idx ON test_execution_operations(state, updated_at, operation_key);
          CREATE INDEX test_execution_control_operations_state_idx ON test_execution_control_operations(state, updated_at, operation_key);
          CREATE INDEX test_evidence_run_idx ON test_evidence(test_run_id, test_case_revision_id, assertion_id, id);
          CREATE INDEX test_defects_run_idx ON test_defects(test_run_id, status, created_at, id);
          CREATE INDEX test_run_obligations_run_idx ON test_run_obligations(test_run_id, status, created_at, id);

          CREATE TRIGGER test_case_revisions_immutable_update BEFORE UPDATE ON test_case_revisions BEGIN SELECT RAISE(ABORT, 'Test Case revision is immutable'); END;
          CREATE TRIGGER test_case_revisions_immutable_delete BEFORE DELETE ON test_case_revisions BEGIN SELECT RAISE(ABORT, 'Test Case revision is immutable'); END;
          CREATE TRIGGER test_cases_immutable_update BEFORE UPDATE ON test_cases BEGIN SELECT RAISE(ABORT, 'Test Case identity is immutable'); END;
          CREATE TRIGGER test_cases_immutable_delete BEFORE DELETE ON test_cases BEGIN SELECT RAISE(ABORT, 'Test Case identity is immutable'); END;
          CREATE TRIGGER test_runs_identity_update BEFORE UPDATE ON test_runs
          WHEN NEW.id <> OLD.id OR NEW.request_id <> OLD.request_id OR NEW.project_id <> OLD.project_id
            OR NEW.run_id <> OLD.run_id OR NEW.snapshot_revision_id <> OLD.snapshot_revision_id
            OR NEW.node_run_id <> OLD.node_run_id OR NEW.node_attempt_id <> OLD.node_attempt_id
            OR NEW.session_id <> OLD.session_id OR NEW.integration_generation_id <> OLD.integration_generation_id
            OR NEW.integration_manifest_hash <> OLD.integration_manifest_hash
            OR NEW.integration_pass_authority_hash <> OLD.integration_pass_authority_hash
            OR NEW.manifest_json <> OLD.manifest_json OR NEW.manifest_hash <> OLD.manifest_hash
            OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'Test Run manifest is immutable'); END;
          CREATE TRIGGER test_runs_terminal_update BEFORE UPDATE ON test_runs
          WHEN OLD.state IN ('passed', 'failed', 'blocked', 'cancelled') AND (
            NEW.state IS NOT OLD.state OR NEW.pass_authority_hash IS NOT OLD.pass_authority_hash
            OR NEW.failure_code IS NOT OLD.failure_code OR NEW.failure_message IS NOT OLD.failure_message
            OR NEW.updated_at IS NOT OLD.updated_at
          ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run is immutable'); END;
          CREATE TRIGGER test_runs_immutable_delete BEFORE DELETE ON test_runs BEGIN SELECT RAISE(ABORT, 'Test Run evidence is immutable'); END;
          CREATE TRIGGER test_run_case_revisions_immutable_update BEFORE UPDATE ON test_run_case_revisions BEGIN SELECT RAISE(ABORT, 'Test Run case coverage is immutable'); END;
          CREATE TRIGGER test_run_case_revisions_immutable_delete BEFORE DELETE ON test_run_case_revisions BEGIN SELECT RAISE(ABORT, 'Test Run case coverage is immutable'); END;
          CREATE TRIGGER test_execution_operations_identity_update BEFORE UPDATE ON test_execution_operations
          WHEN NEW.id <> OLD.id OR NEW.test_run_id <> OLD.test_run_id OR NEW.operation_key <> OLD.operation_key
            OR NEW.request_json <> OLD.request_json OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'Test execution intent is immutable'); END;
          CREATE TRIGGER test_execution_operations_terminal_update BEFORE UPDATE ON test_execution_operations
          WHEN OLD.state IN ('succeeded', 'failed', 'cancelled') AND (
            NEW.state IS NOT OLD.state OR NEW.fact_json IS NOT OLD.fact_json OR NEW.fact_hash IS NOT OLD.fact_hash
            OR NEW.receipt_json IS NOT OLD.receipt_json OR NEW.receipt_hash IS NOT OLD.receipt_hash
            OR NEW.updated_at IS NOT OLD.updated_at
          ) BEGIN SELECT RAISE(ABORT, 'Terminal Test execution is immutable'); END;
          CREATE TRIGGER test_execution_operations_immutable_delete BEFORE DELETE ON test_execution_operations BEGIN SELECT RAISE(ABORT, 'Test execution evidence is immutable'); END;
          CREATE TRIGGER test_execution_facts_immutable_update BEFORE UPDATE ON test_execution_facts BEGIN SELECT RAISE(ABORT, 'Test execution fact is immutable'); END;
          CREATE TRIGGER test_execution_facts_immutable_delete BEFORE DELETE ON test_execution_facts BEGIN SELECT RAISE(ABORT, 'Test execution fact is immutable'); END;
          CREATE TRIGGER test_execution_control_operations_identity_update BEFORE UPDATE ON test_execution_control_operations
          WHEN NEW.id <> OLD.id OR NEW.operation_id <> OLD.operation_id OR NEW.kind <> OLD.kind
            OR NEW.operation_key <> OLD.operation_key OR NEW.request_json <> OLD.request_json
            OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'Test execution control intent is immutable'); END;
          CREATE TRIGGER test_execution_control_operations_terminal_update BEFORE UPDATE ON test_execution_control_operations
          WHEN OLD.state = 'cancelled' AND (
            NEW.state IS NOT OLD.state OR NEW.fact_json IS NOT OLD.fact_json OR NEW.fact_hash IS NOT OLD.fact_hash
            OR NEW.receipt_json IS NOT OLD.receipt_json OR NEW.receipt_hash IS NOT OLD.receipt_hash
            OR NEW.updated_at IS NOT OLD.updated_at
          ) BEGIN SELECT RAISE(ABORT, 'Terminal Test execution control operation is immutable'); END;
          CREATE TRIGGER test_execution_control_operations_immutable_delete BEFORE DELETE ON test_execution_control_operations BEGIN SELECT RAISE(ABORT, 'Test execution control evidence is immutable'); END;
          CREATE TRIGGER test_assertion_results_immutable_update BEFORE UPDATE ON test_assertion_results BEGIN SELECT RAISE(ABORT, 'Test assertion result is immutable'); END;
          CREATE TRIGGER test_assertion_results_immutable_delete BEFORE DELETE ON test_assertion_results BEGIN SELECT RAISE(ABORT, 'Test assertion result is immutable'); END;
          CREATE TRIGGER test_evidence_immutable_update BEFORE UPDATE ON test_evidence BEGIN SELECT RAISE(ABORT, 'Test evidence is immutable'); END;
          CREATE TRIGGER test_evidence_immutable_delete BEFORE DELETE ON test_evidence BEGIN SELECT RAISE(ABORT, 'Test evidence is immutable'); END;
          CREATE TRIGGER test_defects_identity_update BEFORE UPDATE ON test_defects
          WHEN NEW.id <> OLD.id OR NEW.test_run_id <> OLD.test_run_id OR NEW.test_case_revision_id <> OLD.test_case_revision_id
            OR NEW.assertion_id IS NOT OLD.assertion_id OR NEW.integration_generation_id <> OLD.integration_generation_id
            OR NEW.responsibility_json <> OLD.responsibility_json OR NEW.evidence_json <> OLD.evidence_json
            OR NEW.created_at <> OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'Test defect evidence is immutable'); END;
          CREATE TRIGGER test_defects_immutable_delete BEFORE DELETE ON test_defects BEGIN SELECT RAISE(ABORT, 'Test defect evidence is immutable'); END;
          CREATE TRIGGER test_defect_resolutions_immutable_update BEFORE UPDATE ON test_defect_resolutions BEGIN SELECT RAISE(ABORT, 'Test defect resolution is immutable'); END;
          CREATE TRIGGER test_defect_resolutions_immutable_delete BEFORE DELETE ON test_defect_resolutions BEGIN SELECT RAISE(ABORT, 'Test defect resolution is immutable'); END;
          CREATE TRIGGER test_run_case_revisions_terminal_insert BEFORE INSERT ON test_run_case_revisions
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_execution_operations_terminal_run_insert BEFORE INSERT ON test_execution_operations
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_execution_operations_terminal_run_update BEFORE UPDATE ON test_execution_operations
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = OLD.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_execution_facts_terminal_run_insert BEFORE INSERT ON test_execution_facts
          WHEN EXISTS (
            SELECT 1 FROM test_execution_operations AS operations
            JOIN test_runs ON test_runs.id = operations.test_run_id
            WHERE operations.id = NEW.operation_id AND test_runs.state IN ('passed', 'failed', 'blocked', 'cancelled')
          ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_assertion_results_terminal_run_insert BEFORE INSERT ON test_assertion_results
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_evidence_terminal_run_insert BEFORE INSERT ON test_evidence
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_defects_terminal_run_insert BEFORE INSERT ON test_defects
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_defects_terminal_run_update BEFORE UPDATE ON test_defects
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = OLD.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_defect_resolutions_terminal_run_insert BEFORE INSERT ON test_defect_resolutions
          WHEN EXISTS (
            SELECT 1 FROM test_defects
            JOIN test_runs ON test_runs.id = test_defects.test_run_id
            WHERE test_defects.id = NEW.defect_id AND test_runs.state IN ('passed', 'failed', 'blocked', 'cancelled')
          ) BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_run_obligations_immutable_delete BEFORE DELETE ON test_run_obligations BEGIN SELECT RAISE(ABORT, 'Test Run obligation is immutable'); END;
          CREATE TRIGGER test_run_obligations_identity_update BEFORE UPDATE ON test_run_obligations
          WHEN NEW.id <> OLD.id OR NEW.test_run_id <> OLD.test_run_id OR NEW.description <> OLD.description
            OR NEW.evidence_json <> OLD.evidence_json OR NEW.created_at <> OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'Test Run obligation identity is immutable'); END;
          CREATE TRIGGER test_run_obligations_terminal_run_insert BEFORE INSERT ON test_run_obligations
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
          CREATE TRIGGER test_run_obligations_terminal_run_update BEFORE UPDATE ON test_run_obligations
          WHEN EXISTS (SELECT 1 FROM test_runs WHERE id = OLD.test_run_id AND state IN ('passed', 'failed', 'blocked', 'cancelled'))
          BEGIN SELECT RAISE(ABORT, 'Terminal Test Run children are immutable'); END;
        `);
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const reference = new DatabaseSync(":memory:");
      try {
        createTestSchema(reference);
        const expectedObjects = reference
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE name LIKE 'test_%' ORDER BY name",
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
        const actualObjects = database
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE name LIKE 'test_%' ORDER BY name",
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
        if (actualObjects.length === 0) {
          createTestSchema(database);
        } else {
          const actualByName = new Map(
            actualObjects.map((entry) => [entry.name, entry]),
          );
          const expectedNames = new Set(
            expectedObjects.map((entry) => entry.name),
          );
          const incompatible = expectedObjects
            .filter((expected) => {
              const actual = actualByName.get(expected.name);
              return (
                !actual ||
                actual.type !== expected.type ||
                normalizeSql(actual.sql) !== normalizeSql(expected.sql)
              );
            })
            .map((entry) => entry.name);
          incompatible.push(
            ...actualObjects
              .filter((entry) => !expectedNames.has(entry.name))
              .map((entry) => entry.name),
          );
          if (incompatible.length > 0) {
            throw new Error(
              `Existing Test schema is incompatible: ${incompatible.join(", ")}`,
            );
          }
        }
      } finally {
        reference.close();
      }
    },
  },
  {
    version: 48,
    name: "test_rework_resolution_authority",
    migrate: (database) => {
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const createV48Objects = (target: DatabaseSync): void =>
        target.exec(`
          CREATE UNIQUE INDEX test_defect_resolutions_defect_idx
            ON test_defect_resolutions(defect_id);

          CREATE TABLE test_run_obligation_resolutions (
            id TEXT PRIMARY KEY,
            obligation_id TEXT NOT NULL UNIQUE REFERENCES test_run_obligations(id),
            defect_resolution_id TEXT NOT NULL REFERENCES test_defect_resolutions(id),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE test_rework_runs (
            id TEXT PRIMARY KEY,
            defect_id TEXT NOT NULL REFERENCES test_defects(id),
            prior_test_run_id TEXT NOT NULL REFERENCES test_runs(id),
            fresh_test_run_id TEXT NOT NULL UNIQUE REFERENCES test_runs(id),
            route_json TEXT NOT NULL,
            lineage_json TEXT NOT NULL,
            lineage_hash TEXT NOT NULL CHECK (length(lineage_hash) = 64),
            created_at TEXT NOT NULL,
            UNIQUE (defect_id, fresh_test_run_id)
          ) STRICT;

          CREATE INDEX test_rework_runs_defect_idx
            ON test_rework_runs(defect_id, created_at, id);

          CREATE TRIGGER test_run_obligation_resolutions_immutable_update
            BEFORE UPDATE ON test_run_obligation_resolutions
            BEGIN SELECT RAISE(ABORT, 'Test obligation resolution is immutable'); END;
          CREATE TRIGGER test_run_obligation_resolutions_immutable_delete
            BEFORE DELETE ON test_run_obligation_resolutions
            BEGIN SELECT RAISE(ABORT, 'Test obligation resolution is immutable'); END;
          CREATE TRIGGER test_rework_runs_immutable_update
            BEFORE UPDATE ON test_rework_runs
            BEGIN SELECT RAISE(ABORT, 'Test rework lineage is immutable'); END;
          CREATE TRIGGER test_rework_runs_immutable_delete
            BEFORE DELETE ON test_rework_runs
            BEGIN SELECT RAISE(ABORT, 'Test rework lineage is immutable'); END;
        `);
      const obligationColumns = database
        .prepare("PRAGMA table_info(test_run_obligations)")
        .all() as Array<{ readonly name: string }>;
      const assertionResultColumns = database
        .prepare("PRAGMA table_info(test_assertion_results)")
        .all() as Array<{ readonly name: string }>;
      const v48Markers = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE name IN (
              'test_defect_resolutions_defect_idx',
              'test_run_obligation_resolutions',
              'test_rework_runs',
              'test_rework_runs_defect_idx',
              'test_run_obligation_resolutions_immutable_update',
              'test_run_obligation_resolutions_immutable_delete',
              'test_rework_runs_immutable_update',
              'test_rework_runs_immutable_delete'
            )`,
        )
        .all() as Array<{ readonly name: string }>;
      const hasDefectId = obligationColumns.some(
        (column) => column.name === "defect_id",
      );
      const hasUiObservation = assertionResultColumns.some(
        (column) => column.name === "ui_observation_json",
      );
      const hasRuntimeObservation = assertionResultColumns.some(
        (column) => column.name === "runtime_observation_json",
      );
      if (
        !hasDefectId &&
        !hasUiObservation &&
        !hasRuntimeObservation &&
        v48Markers.length === 0
      ) {
        database.exec(`
          DROP TRIGGER test_defects_terminal_run_update;
          DROP TRIGGER test_defect_resolutions_terminal_run_insert;
          DROP TRIGGER test_run_obligations_terminal_run_update;
          DROP TRIGGER test_run_obligations_identity_update;
          ALTER TABLE test_run_obligations
            ADD COLUMN defect_id TEXT REFERENCES test_defects(id);
          ALTER TABLE test_assertion_results
            ADD COLUMN ui_observation_json TEXT NOT NULL DEFAULT 'null';
          ALTER TABLE test_assertion_results
            ADD COLUMN runtime_observation_json TEXT NOT NULL DEFAULT 'null';
          CREATE TRIGGER test_run_obligations_identity_update
            BEFORE UPDATE ON test_run_obligations
            WHEN NEW.id <> OLD.id OR NEW.test_run_id <> OLD.test_run_id
              OR NEW.defect_id IS NOT OLD.defect_id
              OR NEW.description <> OLD.description
              OR NEW.evidence_json <> OLD.evidence_json
              OR NEW.created_at <> OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Test Run obligation identity is immutable'); END;
        `);
        createV48Objects(database);
      }
      const actualObjects = database
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name LIKE 'test_%' ORDER BY name",
        )
        .all() as Array<{
        readonly type: string;
        readonly name: string;
        readonly sql: string;
      }>;
      const actualByName = new Map(
        actualObjects.map((entry) => [
          entry.name,
          {
            type: entry.type,
            sqlHash: createHash("sha256")
              .update(normalizeSql(entry.sql))
              .digest("hex"),
          },
        ]),
      );
      const expectedNames = new Set<string>(
        TEST_V48_SCHEMA_REFERENCE.map(([, name]) => name),
      );
      const incompatible: string[] = TEST_V48_SCHEMA_REFERENCE.flatMap(
        ([type, name, sqlHash]) => {
          const actual = actualByName.get(name);
          return !actual || actual.type !== type || actual.sqlHash !== sqlHash
            ? [name]
            : [];
        },
      );
      incompatible.push(
        ...actualObjects
          .filter((entry) => !expectedNames.has(entry.name))
          .map((entry) => entry.name),
      );
      if (incompatible.length > 0) {
        throw new Error(
          `Existing Test v48 schema is incompatible: ${[
            ...new Set(incompatible),
          ]
            .sort()
            .join(", ")}`,
        );
      }
    },
  },
  {
    version: 49,
    name: "frozen_delivery_candidate_quality_gates",
    migrate: (database) => {
      const createSchema = (target: DatabaseSync): void =>
        target.exec(`
          CREATE TABLE delivery_candidate_inputs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL REFERENCES projects(id),
            run_id TEXT NOT NULL REFERENCES department_runs(id),
            snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
            node_run_id TEXT NOT NULL,
            node_attempt_id TEXT NOT NULL,
            producer_json TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
            state TEXT NOT NULL CHECK (state = 'frozen-for-final-gates'),
            created_at TEXT NOT NULL,
            UNIQUE (run_id, id)
          ) STRICT;

          CREATE INDEX delivery_candidate_inputs_run_idx
            ON delivery_candidate_inputs(run_id, created_at, id);
          CREATE TRIGGER delivery_candidate_inputs_immutable_update
            BEFORE UPDATE ON delivery_candidate_inputs
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate Input is immutable'); END;
          CREATE TRIGGER delivery_candidate_inputs_immutable_delete
            BEFORE DELETE ON delivery_candidate_inputs
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate Input is immutable'); END;

          CREATE TABLE candidate_gate_inputs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            candidate_input_id TEXT NOT NULL REFERENCES delivery_candidate_inputs(id),
            candidate_input_hash TEXT NOT NULL CHECK (length(candidate_input_hash) = 64),
            kind TEXT NOT NULL CHECK (kind IN ('security', 'operability')),
            node_run_id TEXT NOT NULL,
            node_attempt_id TEXT NOT NULL,
            review_topic_id TEXT NOT NULL UNIQUE REFERENCES review_topics(id),
            prior_gate_input_id TEXT REFERENCES candidate_gate_inputs(id),
            reviewer_position_id TEXT NOT NULL,
            reviewer_session_id TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
            review_depth TEXT NOT NULL CHECK (review_depth IN ('lightweight', 'targeted', 'deep-independent', 'deep-independent-escalated')),
            state TEXT NOT NULL CHECK (state IN ('scheduled', 'running', 'reconciling', 'unknown', 'blocked', 'completed')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (candidate_input_id, kind, id)
          ) STRICT;

          CREATE INDEX candidate_gate_inputs_candidate_idx
            ON candidate_gate_inputs(candidate_input_id, kind, created_at, id);
          CREATE TRIGGER candidate_gate_inputs_identity_update
            BEFORE UPDATE ON candidate_gate_inputs
            WHEN NEW.id <> OLD.id OR NEW.request_id <> OLD.request_id
              OR NEW.candidate_input_id <> OLD.candidate_input_id
              OR NEW.candidate_input_hash <> OLD.candidate_input_hash
              OR NEW.kind <> OLD.kind OR NEW.node_run_id <> OLD.node_run_id
              OR NEW.node_attempt_id <> OLD.node_attempt_id
              OR NEW.review_topic_id <> OLD.review_topic_id
              OR NEW.prior_gate_input_id IS NOT OLD.prior_gate_input_id
              OR NEW.reviewer_position_id <> OLD.reviewer_position_id
              OR NEW.reviewer_session_id <> OLD.reviewer_session_id
              OR NEW.manifest_json <> OLD.manifest_json
              OR NEW.manifest_hash <> OLD.manifest_hash
              OR NEW.request_hash <> OLD.request_hash
              OR NEW.risk_tier <> OLD.risk_tier
              OR NEW.review_depth <> OLD.review_depth
              OR NEW.created_at <> OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate input is immutable'); END;
          CREATE TRIGGER candidate_gate_inputs_terminal_update
            BEFORE UPDATE ON candidate_gate_inputs
            WHEN OLD.state IN ('blocked', 'completed') AND (
              NEW.state IS NOT OLD.state OR NEW.updated_at IS NOT OLD.updated_at
            ) BEGIN SELECT RAISE(ABORT, 'Terminal Candidate Gate input is immutable'); END;
          CREATE TRIGGER candidate_gate_inputs_immutable_delete
            BEFORE DELETE ON candidate_gate_inputs
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate input is immutable'); END;

          CREATE TABLE candidate_gate_executions (
            id TEXT PRIMARY KEY,
            gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
            operation_key TEXT NOT NULL UNIQUE,
            request_json TEXT NOT NULL,
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            state TEXT NOT NULL CHECK (state IN ('intent', 'running', 'reconciling', 'unknown', 'succeeded', 'failed', 'cancelled')),
            fact_hash TEXT CHECK (fact_hash IS NULL OR length(fact_hash) = 64),
            receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (gate_input_id, id)
          ) STRICT;
          CREATE INDEX candidate_gate_executions_state_idx
            ON candidate_gate_executions(state, updated_at, id);
          CREATE TRIGGER candidate_gate_executions_identity_update
            BEFORE UPDATE ON candidate_gate_executions
            WHEN NEW.id <> OLD.id OR NEW.gate_input_id <> OLD.gate_input_id
              OR NEW.operation_key <> OLD.operation_key
              OR NEW.request_json <> OLD.request_json
              OR NEW.request_hash <> OLD.request_hash
              OR NEW.created_at <> OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate execution intent is immutable'); END;
          CREATE TRIGGER candidate_gate_executions_terminal_update
            BEFORE UPDATE ON candidate_gate_executions
            WHEN OLD.state IN ('succeeded', 'failed', 'cancelled') AND (
              NEW.state IS NOT OLD.state OR NEW.fact_hash IS NOT OLD.fact_hash
              OR NEW.receipt_hash IS NOT OLD.receipt_hash
              OR NEW.updated_at IS NOT OLD.updated_at
            ) BEGIN SELECT RAISE(ABORT, 'Terminal Candidate Gate execution is immutable'); END;
          CREATE TRIGGER candidate_gate_executions_immutable_delete
            BEFORE DELETE ON candidate_gate_executions
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate execution is immutable'); END;

          CREATE TABLE candidate_gate_execution_facts (
            execution_id TEXT PRIMARY KEY REFERENCES candidate_gate_executions(id),
            fact_json TEXT NOT NULL,
            fact_hash TEXT NOT NULL CHECK (length(fact_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER candidate_gate_execution_facts_immutable_update
            BEFORE UPDATE ON candidate_gate_execution_facts
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate execution fact is immutable'); END;
          CREATE TRIGGER candidate_gate_execution_facts_immutable_delete
            BEFORE DELETE ON candidate_gate_execution_facts
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate execution fact is immutable'); END;

          CREATE TABLE candidate_gate_results (
            id TEXT PRIMARY KEY,
            gate_input_id TEXT NOT NULL UNIQUE REFERENCES candidate_gate_inputs(id),
            quality_gate_result_id TEXT NOT NULL UNIQUE REFERENCES quality_gate_results(id),
            result TEXT NOT NULL CHECK (result IN ('PASS', 'CONDITIONAL_PASS', 'FAIL')),
            result_json TEXT NOT NULL,
            result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER candidate_gate_results_immutable_update
            BEFORE UPDATE ON candidate_gate_results
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate result is immutable'); END;
          CREATE TRIGGER candidate_gate_results_immutable_delete
            BEFORE DELETE ON candidate_gate_results
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate result is immutable'); END;

          CREATE TABLE candidate_gate_defects (
            id TEXT PRIMARY KEY,
            gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
            check_id TEXT NOT NULL,
            responsibility_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
            created_at TEXT NOT NULL,
            closed_at TEXT
          ) STRICT;
          CREATE INDEX candidate_gate_defects_input_idx
            ON candidate_gate_defects(gate_input_id, status, created_at, id);
          CREATE TRIGGER candidate_gate_defects_identity_update
            BEFORE UPDATE ON candidate_gate_defects
            WHEN NEW.id <> OLD.id OR NEW.gate_input_id <> OLD.gate_input_id
              OR NEW.check_id <> OLD.check_id
              OR NEW.responsibility_json <> OLD.responsibility_json
              OR NEW.evidence_json <> OLD.evidence_json
              OR NEW.created_at <> OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect identity is immutable'); END;
          CREATE TRIGGER candidate_gate_defects_immutable_delete
            BEFORE DELETE ON candidate_gate_defects
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect is immutable'); END;

          CREATE TABLE candidate_gate_defect_resolutions (
            id TEXT PRIMARY KEY,
            defect_id TEXT NOT NULL UNIQUE REFERENCES candidate_gate_defects(id),
            fresh_gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
            evidence_json TEXT NOT NULL,
            resolution_hash TEXT NOT NULL CHECK (length(resolution_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER candidate_gate_defect_resolutions_immutable_update
            BEFORE UPDATE ON candidate_gate_defect_resolutions
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect resolution is immutable'); END;
          CREATE TRIGGER candidate_gate_defect_resolutions_immutable_delete
            BEFORE DELETE ON candidate_gate_defect_resolutions
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect resolution is immutable'); END;

          CREATE TABLE candidate_gate_obligations (
            id TEXT PRIMARY KEY,
            gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
            defect_id TEXT REFERENCES candidate_gate_defects(id),
            check_id TEXT NOT NULL,
            description TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
            created_at TEXT NOT NULL,
            closed_at TEXT
          ) STRICT;
          CREATE INDEX candidate_gate_obligations_input_idx
            ON candidate_gate_obligations(gate_input_id, status, created_at, id);
          CREATE TRIGGER candidate_gate_obligations_identity_update
            BEFORE UPDATE ON candidate_gate_obligations
            WHEN NEW.id <> OLD.id OR NEW.gate_input_id <> OLD.gate_input_id
              OR NEW.defect_id IS NOT OLD.defect_id OR NEW.check_id <> OLD.check_id
              OR NEW.description <> OLD.description
              OR NEW.evidence_json <> OLD.evidence_json
              OR NEW.created_at <> OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate obligation identity is immutable'); END;
          CREATE TRIGGER candidate_gate_obligations_immutable_delete
            BEFORE DELETE ON candidate_gate_obligations
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate obligation is immutable'); END;

          CREATE TABLE candidate_gate_obligation_resolutions (
            id TEXT PRIMARY KEY,
            obligation_id TEXT NOT NULL UNIQUE REFERENCES candidate_gate_obligations(id),
            fresh_gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
            evidence_json TEXT NOT NULL,
            resolution_hash TEXT NOT NULL CHECK (length(resolution_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER candidate_gate_obligation_resolutions_immutable_update
            BEFORE UPDATE ON candidate_gate_obligation_resolutions
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate obligation resolution is immutable'); END;
          CREATE TRIGGER candidate_gate_obligation_resolutions_immutable_delete
            BEFORE DELETE ON candidate_gate_obligation_resolutions
            BEGIN SELECT RAISE(ABORT, 'Candidate Gate obligation resolution is immutable'); END;

          CREATE TABLE delivery_candidate_input_authorities (
            id TEXT PRIMARY KEY,
            candidate_input_id TEXT NOT NULL UNIQUE REFERENCES delivery_candidate_inputs(id),
            security_gate_result_id TEXT NOT NULL REFERENCES candidate_gate_results(id),
            operability_gate_result_id TEXT NOT NULL REFERENCES candidate_gate_results(id),
            authority_json TEXT NOT NULL,
            authority_hash TEXT NOT NULL CHECK (length(authority_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER delivery_candidate_input_authorities_immutable_update
            BEFORE UPDATE ON delivery_candidate_input_authorities
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate Input authority is immutable'); END;
          CREATE TRIGGER delivery_candidate_input_authorities_immutable_delete
            BEFORE DELETE ON delivery_candidate_input_authorities
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate Input authority is immutable'); END;
        `);

      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const prefixSql = (target: DatabaseSync) =>
        target
          .prepare(
            `SELECT type, name, sql FROM sqlite_schema
              WHERE name LIKE 'candidate_gate_%'
                 OR name LIKE 'delivery_candidate_input%'
              ORDER BY name`,
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
      const reference = new DatabaseSync(":memory:");
      try {
        createSchema(reference);
        const expected = prefixSql(reference);
        const actual = prefixSql(database);
        if (actual.length === 0) {
          createSchema(database);
        } else {
          const actualByName = new Map(
            actual.map((entry) => [entry.name, entry]),
          );
          const expectedNames = new Set(expected.map((entry) => entry.name));
          const incompatible = expected
            .filter((entry) => {
              const found = actualByName.get(entry.name);
              return (
                !found ||
                found.type !== entry.type ||
                normalizeSql(found.sql) !== normalizeSql(entry.sql)
              );
            })
            .map((entry) => entry.name);
          incompatible.push(
            ...actual
              .filter((entry) => !expectedNames.has(entry.name))
              .map((entry) => entry.name),
          );
          if (incompatible.length > 0) {
            throw new Error(
              `Existing Delivery/Quality schema is incompatible: ${[
                ...new Set(incompatible),
              ]
                .sort()
                .join(", ")}`,
            );
          }
        }
      } finally {
        reference.close();
      }
    },
  },
  {
    version: 50,
    name: "delivery_candidates_and_human_release",
    migrate: (database) => {
      const createSchema = (target: DatabaseSync): void =>
        target.exec(`
          CREATE TABLE candidate_critical_escalations (
            id TEXT PRIMARY KEY,
            candidate_input_id TEXT NOT NULL UNIQUE REFERENCES delivery_candidate_inputs(id),
            candidate_input_hash TEXT NOT NULL CHECK (length(candidate_input_hash) = 64),
            decision TEXT NOT NULL CHECK (decision IN ('authorize-gate-continuation', 'reject')),
            actor_type TEXT NOT NULL CHECK (actor_type = 'human'),
            actor_id TEXT NOT NULL,
            authenticated_by TEXT NOT NULL CHECK (authenticated_by = 'local-session'),
            risk_json TEXT NOT NULL,
            risk_hash TEXT NOT NULL CHECK (length(risk_hash) = 64),
            reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
            evidence_refs_json TEXT NOT NULL,
            decision_hash TEXT NOT NULL CHECK (length(decision_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER candidate_critical_escalations_immutable_update
            BEFORE UPDATE ON candidate_critical_escalations
            BEGIN SELECT RAISE(ABORT, 'Critical-risk escalation is immutable'); END;
          CREATE TRIGGER candidate_critical_escalations_immutable_delete
            BEFORE DELETE ON candidate_critical_escalations
            BEGIN SELECT RAISE(ABORT, 'Critical-risk escalation is immutable'); END;

          CREATE TABLE delivery_candidates (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL REFERENCES projects(id),
            run_id TEXT NOT NULL REFERENCES department_runs(id),
            snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
            candidate_input_id TEXT NOT NULL UNIQUE REFERENCES delivery_candidate_inputs(id),
            candidate_input_hash TEXT NOT NULL CHECK (length(candidate_input_hash) = 64),
            gate_authority_id TEXT NOT NULL REFERENCES delivery_candidate_input_authorities(id),
            gate_authority_hash TEXT NOT NULL CHECK (length(gate_authority_hash) = 64),
            source_node_run_id TEXT NOT NULL,
            source_node_attempt_id TEXT NOT NULL,
            supersedes_candidate_id TEXT REFERENCES delivery_candidates(id),
            lineage_hash TEXT NOT NULL CHECK (length(lineage_hash) = 64),
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
            request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX delivery_candidates_run_idx
            ON delivery_candidates(run_id, created_at, id);
          CREATE INDEX delivery_candidates_supersedes_idx
            ON delivery_candidates(supersedes_candidate_id);
          CREATE TRIGGER delivery_candidates_immutable_update
            BEFORE UPDATE ON delivery_candidates
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate is immutable'); END;
          CREATE TRIGGER delivery_candidates_immutable_delete
            BEFORE DELETE ON delivery_candidates
            BEGIN SELECT RAISE(ABORT, 'Delivery Candidate is immutable'); END;

          CREATE TABLE human_release_decisions (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE REFERENCES delivery_candidates(id),
            candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64),
            run_id TEXT NOT NULL REFERENCES department_runs(id),
            snapshot_revision_id TEXT NOT NULL REFERENCES run_snapshot_revisions(id),
            decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'changes-requested')),
            actor_type TEXT NOT NULL CHECK (actor_type = 'human'),
            actor_id TEXT NOT NULL,
            authenticated_by TEXT NOT NULL CHECK (authenticated_by = 'local-session'),
            reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
            comment TEXT CHECK (comment IS NULL OR length(comment) <= 4000),
            evidence_refs_json TEXT NOT NULL,
            rework_json TEXT,
            rework_hash TEXT CHECK (rework_hash IS NULL OR length(rework_hash) = 64),
            child_run_id TEXT REFERENCES department_runs(id),
            decision_hash TEXT NOT NULL CHECK (length(decision_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX human_release_decisions_run_idx
            ON human_release_decisions(run_id, created_at, id);
          CREATE TRIGGER human_release_decisions_immutable_update
            BEFORE UPDATE ON human_release_decisions
            BEGIN SELECT RAISE(ABORT, 'Human release decision is immutable'); END;
          CREATE TRIGGER human_release_decisions_immutable_delete
            BEFORE DELETE ON human_release_decisions
            BEGIN SELECT RAISE(ABORT, 'Human release decision is immutable'); END;

          CREATE TABLE delivery_release_rework_records (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL UNIQUE REFERENCES human_release_decisions(id),
            candidate_id TEXT NOT NULL REFERENCES delivery_candidates(id),
            run_id TEXT NOT NULL REFERENCES department_runs(id),
            scope TEXT NOT NULL CHECK (scope IN ('same-boundary', 'boundary-changing')),
            responsibility_json TEXT NOT NULL,
            responsibility_hash TEXT NOT NULL CHECK (length(responsibility_hash) = 64),
            child_run_id TEXT REFERENCES department_runs(id),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER delivery_release_rework_records_immutable_update
            BEFORE UPDATE ON delivery_release_rework_records
            BEGIN SELECT RAISE(ABORT, 'Release rework record is immutable'); END;
          CREATE TRIGGER delivery_release_rework_records_immutable_delete
            BEFORE DELETE ON delivery_release_rework_records
            BEGIN SELECT RAISE(ABORT, 'Release rework record is immutable'); END;

          CREATE TABLE accepted_delivery_candidate_authorities (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE REFERENCES delivery_candidates(id),
            release_decision_id TEXT NOT NULL UNIQUE REFERENCES human_release_decisions(id),
            authority_json TEXT NOT NULL,
            authority_hash TEXT NOT NULL CHECK (length(authority_hash) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER accepted_delivery_candidate_authorities_immutable_update
            BEFORE UPDATE ON accepted_delivery_candidate_authorities
            BEGIN SELECT RAISE(ABORT, 'Accepted Delivery Candidate authority is immutable'); END;
          CREATE TRIGGER accepted_delivery_candidate_authorities_immutable_delete
            BEFORE DELETE ON accepted_delivery_candidate_authorities
            BEGIN SELECT RAISE(ABORT, 'Accepted Delivery Candidate authority is immutable'); END;
        `);

      const objects = (target: DatabaseSync) =>
        target
          .prepare(
            `SELECT type, name, sql FROM sqlite_schema
              WHERE name LIKE 'candidate_critical_escalation%'
                 OR name = 'delivery_candidates'
                 OR name LIKE 'delivery_candidates_%'
                 OR name LIKE 'human_release_decision%'
                 OR name LIKE 'delivery_release_rework%'
                 OR name LIKE 'accepted_delivery_candidate%'
              ORDER BY name`,
          )
          .all() as Array<{
          readonly type: string;
          readonly name: string;
          readonly sql: string;
        }>;
      const normalizeSql = (sql: string): string =>
        sql
          .replace(/\s+/g, " ")
          .replace(/\s*([(),])\s*/g, "$1")
          .trim()
          .toLowerCase();
      const reference = new DatabaseSync(":memory:");
      try {
        createSchema(reference);
        const expected = objects(reference);
        const actual = objects(database);
        if (actual.length === 0) {
          createSchema(database);
        } else {
          const actualByName = new Map(
            actual.map((entry) => [entry.name, entry]),
          );
          const expectedNames = new Set(expected.map((entry) => entry.name));
          const incompatible = expected
            .filter((entry) => {
              const found = actualByName.get(entry.name);
              return (
                !found ||
                found.type !== entry.type ||
                normalizeSql(found.sql) !== normalizeSql(entry.sql)
              );
            })
            .map((entry) => entry.name);
          incompatible.push(
            ...actual
              .filter((entry) => !expectedNames.has(entry.name))
              .map((entry) => entry.name),
          );
          if (incompatible.length > 0) {
            throw new Error(
              `Existing Delivery v50 schema is incompatible: ${[
                ...new Set(incompatible),
              ]
                .sort()
                .join(", ")}`,
            );
          }
        }
      } finally {
        reference.close();
      }
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
  const rebuildsApprovals = existingVersion < 29;
  const rebuildsExecutionStates = existingVersion < 32;
  const reviewTopicsSql = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_topics'",
    )
    .get() as { readonly sql?: string } | undefined;
  const rebuildsReviewTables =
    existingVersion < 39 &&
    (!reviewTopicsSql?.sql || !reviewTopicsSql.sql.includes("'memory'"));
  const foreignKeysEnabled = Number(
    (
      database.prepare("PRAGMA foreign_keys").get() as
        | { readonly foreign_keys?: unknown }
        | undefined
    )?.foreign_keys,
  );
  if (
    (rebuildsNodeAttempts ||
      rebuildsApprovals ||
      rebuildsExecutionStates ||
      rebuildsReviewTables) &&
    foreignKeysEnabled === 1
  ) {
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
    if (existingVersion >= 49) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS candidate_gate_defect_resolutions (
          id TEXT PRIMARY KEY,
          defect_id TEXT NOT NULL UNIQUE REFERENCES candidate_gate_defects(id),
          fresh_gate_input_id TEXT NOT NULL REFERENCES candidate_gate_inputs(id),
          evidence_json TEXT NOT NULL,
          resolution_hash TEXT NOT NULL CHECK (length(resolution_hash) = 64),
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS candidate_gate_defect_resolutions_immutable_update
          BEFORE UPDATE ON candidate_gate_defect_resolutions
          BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect resolution is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS candidate_gate_defect_resolutions_immutable_delete
          BEFORE DELETE ON candidate_gate_defect_resolutions
          BEGIN SELECT RAISE(ABORT, 'Candidate Gate Defect resolution is immutable'); END;
      `);
    }
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
      (rebuildsNodeAttempts ||
        rebuildsApprovals ||
        rebuildsExecutionStates ||
        rebuildsReviewTables) &&
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
    if (
      (rebuildsNodeAttempts ||
        rebuildsApprovals ||
        rebuildsExecutionStates ||
        rebuildsReviewTables) &&
      foreignKeysEnabled === 1
    ) {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
};
