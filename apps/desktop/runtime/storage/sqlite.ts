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
import { openLocalReviewerWorkspaceAdapter } from "../review/reviewerWorkspace.js";
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
  blockingReviewerWorkspaceAdapter,
  openCodeReviewRuntime,
  type CodeReviewRuntime,
  type ReviewerWorkspaceAdapter,
} from "../review/codeReviewRuntime.js";
import {
  openCodeReviewNodeHandler,
  type CodeReviewNodeHandler,
} from "../review/codeReviewNodeHandler.js";
import {
  blockingReviewerExecutionAdapter,
  type ReviewerExecutionAdapter,
} from "../review/reviewerExecution.js";
import {
  openIntegrationRuntime,
  type GitIntegrationAdapter,
  type IntegrationRuntime,
} from "../integration/integrationRuntime.js";
import { openLocalGitIntegrationAdapter } from "../integration/gitIntegrationAdapter.js";
import {
  openIntegrationNodeHandler,
  type AggregateIntegrationReviewExecutor,
  type IntegrationNodeHandler,
  type IntegrationValidationExecutor,
} from "../integration/integrationNodeHandler.js";
import {
  openIsolatedIntegrationValidationExecutor,
  type IntegrationValidationProvider,
} from "../integration/integrationValidationExecutor.js";
import { openAggregateIntegrationReviewExecutor } from "../integration/aggregateIntegrationReviewExecutor.js";
import {
  openTestRuntime,
  type TestExecutionAdapter,
  type TestRuntime,
} from "../testing/testRuntime.js";
import {
  openTestNodeHandler,
  type TestNodeHandler,
} from "../testing/testNodeHandler.js";

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
  readonly codeReviewNodeHandler: CodeReviewNodeHandler;
  readonly integrations: IntegrationRuntime;
  readonly testRuns: TestRuntime;
  readonly testNodeHandler: TestNodeHandler;
  readonly integrationNodeHandler: IntegrationNodeHandler;
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
      readonly reviewerExecutionAdapter?: ReviewerExecutionAdapter;
    };
    readonly integrationRuntime?: {
      readonly gitAdapter?: GitIntegrationAdapter;
      readonly validationExecutor?: IntegrationValidationExecutor;
      readonly validationProvider?: IntegrationValidationProvider;
      readonly aggregateReviewExecutor?: AggregateIntegrationReviewExecutor;
      readonly failureInjection?: (
        point:
          | "after-intent"
          | "after-effect"
          | "before-operation-intent"
          | "during-operation-intent"
          | "during-operation-finalization"
          | "during-failure-finalization",
        operationId: string,
      ) => void;
    };
    readonly testRuntime?: {
      readonly executionAdapters?: readonly TestExecutionAdapter[];
      readonly fixtureAuthority?: Parameters<
        typeof openTestRuntime
      >[1]["fixtureAuthority"];
      readonly nextId?: () => string;
      readonly executionAdapterFactory?: (input: {
        readonly database: DatabaseSync;
        readonly tests: TestRuntime;
        readonly artifacts: ArtifactRegistry;
        readonly commandRegistry: CompanyCommandRegistry;
      }) => readonly TestExecutionAdapter[];
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
  const reviewerExecutionAdapter =
    options.codeReviewRuntime?.reviewerExecutionAdapter ??
    blockingReviewerExecutionAdapter;
  const codeReviews = openCodeReviewRuntime(database, {
    events,
    reviewRuntime: review,
    workPackages,
    pipelineRuntime,
    artifacts: artifactRegistry,
    reviewerWorkspaceAdapter:
      options.codeReviewRuntime?.reviewerWorkspaceAdapter ??
      (reviewerExecutionAdapter.capabilities.executionBoundIsolation
        ? openLocalReviewerWorkspaceAdapter(companyDir)
        : blockingReviewerWorkspaceAdapter),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const integrations = openIntegrationRuntime(database, {
    events,
    codeReviews,
    workPackages,
    pipelineRuntime,
    reviewRuntime: review,
    gitAdapter:
      options.integrationRuntime?.gitAdapter ??
      openLocalGitIntegrationAdapter(),
    ...(options.integrationRuntime?.failureInjection
      ? { failureInjection: options.integrationRuntime.failureInjection }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const testRuns = openTestRuntime(database, {
    integrationAuthority: integrations,
    artifacts: artifactRegistry,
    events,
    ...(options.testRuntime?.fixtureAuthority
      ? { fixtureAuthority: options.testRuntime.fixtureAuthority }
      : {}),
    ...(options.testRuntime?.nextId
      ? { nextId: options.testRuntime.nextId }
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
    integrations,
    testRuns,
  );
  const testExecutionAdapters = [
    ...(options.testRuntime?.executionAdapters ?? []),
    ...(options.testRuntime?.executionAdapterFactory?.({
      database,
      tests: testRuns,
      artifacts: artifactRegistry,
      commandRegistry,
    }) ?? []),
  ];
  const codeReviewNodeHandler = openCodeReviewNodeHandler(database, {
    events,
    commandRegistry,
    codeReviews,
    reviewRuntime: review,
    workPackages,
    artifacts: artifactRegistry,
    interaction,
    pipelineRuntime,
    ...(options.codeReviewRuntime?.reviewerExecutionAdapter
      ? {
          reviewerExecutionAdapter:
            options.codeReviewRuntime.reviewerExecutionAdapter,
        }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  pipelineRuntime.registerCodeReviewExecutor(
    codeReviewNodeHandler.executeReady,
  );
  const integrationNodeHandler = openIntegrationNodeHandler({
    commandRegistry,
    integrations,
    validationExecutor:
      options.integrationRuntime?.validationExecutor ??
      openIsolatedIntegrationValidationExecutor({
        evidenceRoot: join(sandcastleDir, "integration-validation-evidence"),
        ...(options.integrationRuntime?.validationProvider
          ? { provider: options.integrationRuntime.validationProvider }
          : {}),
      }),
    aggregateReviewExecutor:
      options.integrationRuntime?.aggregateReviewExecutor ??
      openAggregateIntegrationReviewExecutor({
        database,
        workspaceRoot: join(sandcastleDir, "integration-review-workspaces"),
        reviewerExecutionAdapter,
        interaction,
        pipelineRuntime,
        reviewRuntime: review,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
  });
  pipelineRuntime.registerIntegrationExecutor(
    integrationNodeHandler.executeReady,
  );
  pipelineRuntime.registerIntegrationCancellationDispatcher(
    integrationNodeHandler.cancelPending,
  );
  const testNodeHandler = openTestNodeHandler({
    database,
    pipelineRuntime,
    tests: testRuns,
    executionAdapters: testExecutionAdapters,
  });
  pipelineRuntime.registerTestExecutor(testNodeHandler.executeReady);
  pipelineRuntime.registerTestCancellationDispatcher(async (input) => {
    await testNodeHandler.cancelPending(
      `test:${input.runId}:${input.nodeRunId}`,
      input.action,
    );
  });
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
    codeReviewNodeHandler,
    integrations,
    testRuns,
    testNodeHandler,
    integrationNodeHandler,
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
