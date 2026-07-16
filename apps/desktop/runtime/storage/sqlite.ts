import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  openCompanyCatalog,
  type CompanyCatalog,
} from "../catalog/companyCatalog.js";
import {
  openPipelineConfiguration,
  type PipelineConfiguration,
} from "../pipeline/pipelineConfiguration.js";
import {
  openProjectConfiguration,
  type ProjectConfiguration,
} from "../project/projectConfiguration.js";
import {
  openSkillConfiguration,
  type SkillConfiguration,
} from "../skill/skillConfiguration.js";
import {
  createScriptedExecutionAdapter,
  type ExecutionAdapter,
} from "../adapters/scriptedExecutionAdapter.js";
import {
  openPipelineRuntime,
  type PipelineRuntime,
} from "../pipeline/pipelineRuntime.js";
import {
  createCompanyDatabaseBackup,
  restoreCompanyDatabaseBackup,
  type CompanyDatabaseBackup,
} from "./backups.js";
import { migrateCompanyDatabase } from "./migrations.js";
import {
  openArtifactRegistry,
  type ArtifactRegistry,
} from "../artifactRegistry.js";
import {
  openRuntimeInteraction,
  type RuntimeInteraction,
} from "../interaction.js";
import { openRuntimeMemory, type RuntimeMemory } from "../memory.js";
import {
  openRuntimeDiagnostics,
  type RuntimeDiagnostics,
} from "../diagnostics.js";
import {
  openAgentCatalog,
  type AgentCatalog,
  type LocalAgentHost,
} from "../agent/agentCatalog.js";
import {
  openSkillCatalog,
  type SkillCatalog,
} from "../skill/skillDiscovery.js";

export interface CompanyDatabase {
  readonly path: string;
  readonly catalog: CompanyCatalog;
  readonly pipelineConfiguration: PipelineConfiguration;
  readonly pipelineRuntime: PipelineRuntime;
  readonly projectConfiguration: ProjectConfiguration;
  readonly skillConfiguration: SkillConfiguration;
  readonly artifactRegistry: ArtifactRegistry;
  readonly interaction: RuntimeInteraction;
  readonly memory: RuntimeMemory;
  readonly diagnostics: RuntimeDiagnostics;
  readonly agentCatalog: AgentCatalog;
  readonly skillCatalog: SkillCatalog;
  readonly schemaVersion: () => number;
  readonly backup: () => Promise<CompanyDatabaseBackup>;
  readonly close: () => void;
}

export const restoreCompanyDatabase = restoreCompanyDatabaseBackup;

export const openCompanyDatabase = (
  companyDir: string,
  options: {
    readonly executionAdapter?: ExecutionAdapter;
    readonly clock?: () => Date;
    readonly agentHost?: LocalAgentHost;
  } = {},
): CompanyDatabase => {
  const sandcastleDir = join(companyDir, ".sandcastle");
  mkdirSync(sandcastleDir, { recursive: true });
  const path = join(sandcastleDir, "company.sqlite");
  const database = new DatabaseSync(path);

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    migrateCompanyDatabase(database);
    const integrity = database.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      throw new Error("Company database integrity check failed.");
    }
  } catch (error) {
    database.close();
    throw error;
  }

  const skillConfiguration = openSkillConfiguration(database);
  const catalog = openCompanyCatalog(
    database,
    basename(companyDir),
    skillConfiguration,
  );
  const projectConfiguration = openProjectConfiguration(database);
  const pipelineConfiguration = openPipelineConfiguration(
    database,
    skillConfiguration,
  );
  const artifactRegistry = openArtifactRegistry(database, companyDir);
  const interaction = openRuntimeInteraction(database);
  const memory = openRuntimeMemory(database);
  const diagnostics = openRuntimeDiagnostics(database, path);
  const agentCatalog = openAgentCatalog(database, {
    ...(options.agentHost ? { host: options.agentHost } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const skillCatalog = openSkillCatalog(database, {
    ...(options.clock ? { clock: options.clock } : {}),
    defaultDirectories: [
      join(homedir(), ".codex", "skills"),
      join(homedir(), ".agents", "skills"),
      join(companyDir, ".agents", "skills"),
    ],
  });
  const pipelineRuntime = openPipelineRuntime(
    database,
    options.executionAdapter ?? createScriptedExecutionAdapter(),
    {
      ...(options.clock ? { clock: options.clock } : {}),
      artifactRegistry,
    },
  );
  pipelineRuntime.recoverExpiredLeases();

  return {
    path,
    catalog,
    pipelineConfiguration,
    pipelineRuntime,
    projectConfiguration,
    skillConfiguration,
    artifactRegistry,
    interaction,
    memory,
    diagnostics,
    agentCatalog,
    skillCatalog,
    schemaVersion: () => {
      const row = database
        .prepare("SELECT value FROM schema_metadata WHERE key = ?")
        .get("schema_version") as { readonly value?: unknown } | undefined;
      const version = Number(row?.value);
      if (!Number.isInteger(version) || version < 0) {
        throw new Error("Company database schema version is invalid.");
      }
      return version;
    },
    backup: () => createCompanyDatabaseBackup(database, companyDir),
    close: () => database.close(),
  };
};
