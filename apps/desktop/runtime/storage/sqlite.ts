import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
import type { NodeHandlerRegistry } from "../pipeline/nodeHandlerRegistry.js";
import {
  createCompanyDatabaseBackup,
  restoreCompanyDatabaseBackup,
  type CompanyDatabaseBackup,
} from "./backups.js";
import { migrateCompanyDatabase } from "./migrations.js";
import {
  openArtifactRegistry,
  type ArtifactRegistryOptions,
  type ArtifactRegistry,
} from "../artifactRegistry.js";
import {
  openRuntimeInteraction,
  type RuntimeInteraction,
} from "../interaction.js";
import type { ModelOnlyInteractionExecutionAdapter } from "../adapters/interactionExecutionAdapter.js";
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
import {
  openCompanyCommandRegistry,
  type CompanyCommandRegistry,
  type MemoryCommandFailurePoint,
} from "../commandRegistry.js";
import {
  openRuntimeEvents,
  type RuntimeEvents,
} from "../events/subscription.js";
import {
  openProductRuntime,
  type ProductConfirmationFailurePoint,
  type ProductRuntime,
} from "../product/productRuntime.js";
import {
  openReviewRuntime,
  type ReviewMutationFailurePoint,
  type ReviewRuntime,
} from "../review/reviewRuntime.js";
import {
  openProductReviewRuntime,
  type ProductGatePromotionFailurePoint,
  type ProductReviewRuntime,
} from "../product/productReviewRuntime.js";
import {
  openTechnicalReviewRuntime,
  type TechnicalGatePromotionFailurePoint,
  type TechnicalReviewRuntime,
} from "../project/technicalReviewRuntime.js";
import {
  openWorkspaceRuntime,
  type WorkspaceRuntime,
} from "../workspaces/workspaceRuntime.js";
import {
  openLocalIsolatedGitProfile,
  type LocalIsolatedGitProfile,
} from "../workspaces/localIsolatedGitProfile.js";
import {
  openRuntimeSupervision,
  type RuntimeSupervision,
} from "../runSupervision.js";
import {
  openWorkPackageRuntime,
  type WorkPackageRuntime,
} from "../workspaces/workPackages.js";
import {
  openCodeReviewRuntime,
  type CodeReviewRuntime,
  type ReviewerWorkspaceAdapter,
} from "../review/codeReviewRuntime.js";

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
  readonly commandRegistry: CompanyCommandRegistry;
  readonly events: RuntimeEvents;
  readonly product: ProductRuntime;
  readonly productReview: ProductReviewRuntime;
  readonly technicalReview: TechnicalReviewRuntime;
  readonly review: ReviewRuntime;
  readonly workspaces: WorkspaceRuntime;
  readonly supervision: RuntimeSupervision;
  readonly workPackages: WorkPackageRuntime;
  readonly codeReviews: CodeReviewRuntime;
  readonly schemaVersion: () => number;
  readonly eventSequence: () => number;
  readonly backup: () => Promise<CompanyDatabaseBackup>;
  readonly close: () => void;
}

export const restoreCompanyDatabase = restoreCompanyDatabaseBackup;

const quarantineImpossibleRunSnapshots = (
  database: DatabaseSync,
  clock: () => Date,
): void => {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO runtime_run_quarantines(
       id, run_id, snapshot_revision_id, reason, evidence_json, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const detectedAt = clock().toISOString();
  const invalidRuns = database
    .prepare(
      `SELECT runs.id AS runId,
              runs.snapshot_revision_id AS snapshotRevisionId,
              snapshots.id AS foundSnapshotId,
              snapshots.run_id AS snapshotRunId
         FROM department_runs AS runs
         LEFT JOIN run_snapshot_revisions AS snapshots
           ON snapshots.id = runs.snapshot_revision_id
        WHERE runs.snapshot_revision_id IS NULL
           OR snapshots.id IS NULL
           OR snapshots.run_id <> runs.id`,
    )
    .all() as Array<{
    readonly runId: string;
    readonly snapshotRevisionId: string | null;
    readonly foundSnapshotId: string | null;
    readonly snapshotRunId: string | null;
  }>;
  for (const row of invalidRuns) {
    const reason =
      row.snapshotRevisionId === null
        ? "active-snapshot-null"
        : row.foundSnapshotId === null
          ? "active-snapshot-missing"
          : "active-snapshot-owned-by-another-run";
    const identity = `${row.runId}:${row.snapshotRevisionId ?? "none"}:${reason}`;
    insert.run(
      createHash("sha256").update(identity).digest("hex"),
      row.runId,
      row.snapshotRevisionId,
      reason,
      JSON.stringify({
        runId: row.runId,
        snapshotRevisionId: row.snapshotRevisionId,
        foundSnapshotId: row.foundSnapshotId,
        snapshotRunId: row.snapshotRunId,
      }),
      detectedAt,
    );
  }
  const orphanSnapshots = database
    .prepare(
      `SELECT snapshots.id AS snapshotRevisionId,
              snapshots.run_id AS runId
         FROM run_snapshot_revisions AS snapshots
         LEFT JOIN department_runs AS runs ON runs.id = snapshots.run_id
        WHERE runs.id IS NULL`,
    )
    .all() as Array<{
    readonly snapshotRevisionId: string;
    readonly runId: string;
  }>;
  for (const row of orphanSnapshots) {
    const reason = "snapshot-run-missing";
    const identity = `${row.runId}:${row.snapshotRevisionId}:${reason}`;
    insert.run(
      createHash("sha256").update(identity).digest("hex"),
      row.runId,
      row.snapshotRevisionId,
      reason,
      JSON.stringify(row),
      detectedAt,
    );
  }
};

export const openCompanyDatabase = (
  companyDir: string,
  options: {
    readonly executionAdapter?: ExecutionAdapter;
    readonly interactionExecutionAdapter?: ModelOnlyInteractionExecutionAdapter;
    readonly clock?: () => Date;
    readonly agentHost?: LocalAgentHost;
    readonly pipelineRuntime?: {
      readonly handlerRegistry?: NodeHandlerRegistry;
    };
    readonly workspaceRuntime?: {
      readonly profile?: LocalIsolatedGitProfile;
    };
    readonly artifactRegistry?: ArtifactRegistryOptions;
    readonly productRuntime?: {
      readonly confirmationFailure?: (
        point: ProductConfirmationFailurePoint,
      ) => void;
    };
    readonly reviewRuntime?: {
      readonly mutationFailure?: (point: ReviewMutationFailurePoint) => void;
    };
    readonly codeReviewRuntime?: {
      readonly reviewerWorkspaceAdapter?: ReviewerWorkspaceAdapter;
    };
    readonly productReviewRuntime?: {
      readonly promotionFailure?: (
        point: ProductGatePromotionFailurePoint,
      ) => void;
    };
    readonly technicalReviewRuntime?: {
      readonly promotionFailure?: (
        point: TechnicalGatePromotionFailurePoint,
      ) => void;
    };
    readonly memoryRuntime?: {
      readonly commandFailure?: (point: MemoryCommandFailurePoint) => void;
    };
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
    quarantineImpossibleRunSnapshots(
      database,
      options.clock ?? (() => new Date()),
    );
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
  const events = openRuntimeEvents(database, {
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const workspaces = openWorkspaceRuntime(database, {
    projectConfiguration,
    profile: options.workspaceRuntime?.profile ?? openLocalIsolatedGitProfile(),
    events,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const pipelineConfiguration = openPipelineConfiguration(
    database,
    skillConfiguration,
  );
  const artifactRegistry = openArtifactRegistry(database, companyDir, {
    ...options.artifactRegistry,
    events,
  });
  artifactRegistry.reconcile();
  const interaction = openRuntimeInteraction(database, {
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.interactionExecutionAdapter
      ? { interactionExecutionAdapter: options.interactionExecutionAdapter }
      : {}),
    events,
  });
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
  let memory!: RuntimeMemory;
  const pipelineRuntime = openPipelineRuntime(
    database,
    options.executionAdapter ?? createScriptedExecutionAdapter(),
    {
      ...(options.clock ? { clock: options.clock } : {}),
      artifactRegistry,
      events,
      interaction,
      resolveMemoryEntries: (input) => memory.resolveEntriesForExecution(input),
      workspaces,
      ...(options.pipelineRuntime?.handlerRegistry
        ? { handlerRegistry: options.pipelineRuntime.handlerRegistry }
        : {}),
    },
  );
  const supervision = openRuntimeSupervision(database, {
    pipelineRuntime,
    interaction,
  });
  pipelineRuntime.recoverExpiredLeases();
  pipelineRuntime.recoverExpiredApprovals();
  const product = openProductRuntime(database, {
    events,
    pipelineRuntime,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.productRuntime?.confirmationFailure
      ? { confirmationFailure: options.productRuntime.confirmationFailure }
      : {}),
  });
  const review = openReviewRuntime(database, {
    events,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.reviewRuntime?.mutationFailure
      ? { mutationFailure: options.reviewRuntime.mutationFailure }
      : {}),
  });
  const productReview = openProductReviewRuntime(database, {
    events,
    reviewRuntime: review,
    pipelineRuntime,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.productReviewRuntime?.promotionFailure
      ? { promotionFailure: options.productReviewRuntime.promotionFailure }
      : {}),
  });
  const technicalReview = openTechnicalReviewRuntime(database, {
    events,
    reviewRuntime: review,
    pipelineRuntime,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.technicalReviewRuntime?.promotionFailure
      ? { promotionFailure: options.technicalReviewRuntime.promotionFailure }
      : {}),
  });
  const workPackages = openWorkPackageRuntime(database, {
    workspaces,
    pipelineRuntime,
    events,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const codeReviews = openCodeReviewRuntime(database, {
    events,
    reviewRuntime: review,
    workPackages,
    pipelineRuntime,
    artifacts: artifactRegistry,
    ...(options.codeReviewRuntime?.reviewerWorkspaceAdapter
      ? {
          reviewerWorkspaceAdapter:
            options.codeReviewRuntime.reviewerWorkspaceAdapter,
        }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  memory = openRuntimeMemory(database, {
    events,
    artifacts: artifactRegistry,
    reviewRuntime: review,
    pipelineRuntime,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const commandRegistry = openCompanyCommandRegistry(
    database,
    projectConfiguration,
    artifactRegistry,
    options.clock,
    product,
    options.productRuntime?.confirmationFailure,
    interaction,
    pipelineRuntime,
    supervision,
    review,
    productReview,
    options.productReviewRuntime?.promotionFailure,
    technicalReview,
    options.technicalReviewRuntime?.promotionFailure,
    workspaces,
    memory,
    options.memoryRuntime?.commandFailure,
    workPackages,
    codeReviews,
  );
  workspaces.reconcile();
  pipelineRuntime.reconcileWorkPackageImports();
  codeReviews.reconcilePendingReviewerWorkspaces();

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
    commandRegistry,
    events,
    product,
    productReview,
    technicalReview,
    review,
    workspaces,
    supervision,
    workPackages,
    codeReviews,
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
    eventSequence: events.latestSequence,
    backup: () => createCompanyDatabaseBackup(database, companyDir),
    close: () => database.close(),
  };
};
