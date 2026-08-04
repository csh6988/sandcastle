import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  RuntimeRequestSchema,
  type ActorRef,
  type RuntimeRequest,
  type RuntimeResponse,
  type TestRunView,
  type WorkPackageGraphView,
} from "./interface.js";
import { CompanyCatalogError } from "./catalog/companyCatalog.js";
import { PipelineConfigurationError } from "./pipeline/pipelineConfiguration.js";
import { PipelineRuntimeError } from "./pipeline/pipelineRuntime.js";
import { ProjectConfigurationError } from "./project/projectConfiguration.js";
import { SkillConfigurationError } from "./skill/skillConfiguration.js";
import { RuntimeInteractionError } from "./interaction.js";
import { ArtifactRegistryError } from "./artifactRegistry.js";
import { RuntimeMemoryError } from "./memory.js";
import { AgentCatalogError } from "./agent/agentCatalog.js";
import { SkillCatalogError } from "./skill/skillDiscovery.js";
import {
  AgUiCursorExpiredError,
  AgUiProtocolDiagnosticError,
  replayRuntimeEventsAsAgUi,
} from "./agUiAdapter.js";
import { acquireCompanyRuntimeLock } from "./runtimeLock.js";
import { openCompanyDatabase, type CompanyDatabase } from "./storage/sqlite.js";
import type { LocalAgentHost } from "./agent/agentCatalog.js";
import type { ExecutionAdapter } from "./adapters/scriptedExecutionAdapter.js";
import type { ModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";
import type { ReviewerExecutionAdapter } from "./review/reviewerExecution.js";
import type { IntegrationValidationProvider } from "./integration/integrationValidationExecutor.js";
import type {
  TestExecutionAdapter,
  TestFixtureAuthority,
} from "./testing/testRuntime.js";
import { CompanyCommandError } from "./commandRegistry.js";
import { RuntimeEventCursorError } from "./events/cursor.js";
import { WorkspaceRuntimeError } from "./workspaces/workspaceRuntime.js";
import { WorkPackageRuntimeError } from "./workspaces/workPackages.js";
import { CandidateInputRuntimeError } from "./delivery/candidateInputRuntime.js";
import { QualityGateRuntimeError } from "./quality/qualityGateRuntime.js";
import { DeliveryRuntimeError } from "./delivery/deliveryRuntime.js";
import type { DeliveryQualityNodePlanProvider } from "./quality/qualityGateNodeHandler.js";
import { ReleaseOperationRuntimeError } from "./release/releaseOperationRuntime.js";
import type { ReleaseOperationEffectAdapter } from "./release/releaseOperationContracts.js";
import { StatisticsRuntimeError } from "./statistics/statisticsRuntime.js";

export interface CompanyRuntimeServerOptions {
  readonly address: string;
  readonly companyDir: string;
  readonly token: string;
  readonly executionAdapter?: ExecutionAdapter;
  readonly interactionExecutionAdapter?: ModelOnlyInteractionExecutionAdapter;
  readonly reviewerExecutionAdapter?: ReviewerExecutionAdapter;
  readonly integrationValidationProvider?: IntegrationValidationProvider;
  readonly deliveryQualityPlans?: DeliveryQualityNodePlanProvider;
  readonly releaseOperationAdapter?: ReleaseOperationEffectAdapter;
  readonly releaseOperationFailureInjection?: (
    point: "after-intent" | "after-effect-before-finalize",
  ) => void;
  readonly testExecutionAdapterFactory?: (input: {
    readonly database: import("node:sqlite").DatabaseSync;
    readonly tests: import("./testing/testRuntime.js").TestRuntime;
    readonly artifacts: import("./artifactRegistry.js").ArtifactRegistry;
    readonly commandRegistry: import("./commandRegistry.js").CompanyCommandRegistry;
  }) => readonly TestExecutionAdapter[];
  readonly testBuildFixture?: {
    readonly clock: () => Date;
    readonly nextId: () => string;
    readonly fixtureAuthority: TestFixtureAuthority;
    readonly setup: (database: CompanyDatabase) => void | Promise<void>;
  };
  readonly agentHost?: LocalAgentHost;
  readonly principal?: ActorRef;
  readonly consumerId?: string;
  readonly trustedConnections?: readonly {
    readonly token: string;
    readonly principal: ActorRef;
    readonly consumerId: string;
  }[];
}

export interface CompanyRuntimeServerHandle {
  readonly address: string;
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

const assertStatisticsReader = (principal: ActorRef): void => {
  const authenticated =
    (principal.type === "human" &&
      principal.authenticatedBy === "local-session") ||
    (principal.type === "runtime-worker" &&
      principal.authenticatedBy === "runtime") ||
    (principal.type === "electron-main" &&
      principal.authenticatedBy === "ipc-token") ||
    (principal.type === "acp-client" &&
      principal.authenticatedBy === "acp-connection");
  if (!authenticated) {
    throw new CompanyCommandError(
      "FORBIDDEN",
      "Statistics queries require an authenticated Project reader.",
    );
  }
};

export const reconcileCompanyRuntimeStartup = async (
  database: Pick<
    CompanyDatabase,
    | "pipelineRuntime"
    | "interaction"
    | "codeReviewNodeHandler"
    | "integrationNodeHandler"
    | "testNodeHandler"
    | "releaseOperations"
  >,
): Promise<void> => {
  await database.pipelineRuntime.reconcilePendingExecutions();
  await database.interaction.reconcilePendingTurns();
  await database.codeReviewNodeHandler.reconcilePending();
  await database.integrationNodeHandler.reconcilePending();
  await database.testNodeHandler.reconcilePending();
  await database.releaseOperations.reconcilePending();
};

export const prepareCompanyRuntimeStartup = async (
  database: CompanyDatabase,
  setup?: (database: CompanyDatabase) => void | Promise<void>,
): Promise<void> => {
  await setup?.(database);
  await reconcileCompanyRuntimeStartup(database);
};

const tokenDigest = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

const tokenMatches = (actual: string, expected: string): boolean =>
  timingSafeEqual(tokenDigest(actual), tokenDigest(expected));

const acpRequestAllowed = (request: RuntimeRequest): boolean => {
  if (request.kind.startsWith("subscription.")) return true;
  if (request.kind === "query") {
    return "envelope" in request
      ? request.envelope.query.type === "interaction.inspect"
      : request.query.type === "runtime.health";
  }
  if (request.kind === "command") {
    return "envelope" in request
      ? [
          "ack-runtime-events",
          "interaction.prompt",
          "interaction.turn.cancel",
          "permission.decide",
        ].includes(request.envelope.command.type)
      : ["interaction.session.create", "interaction.participant.add"].includes(
          request.command.type,
        );
  }
  return false;
};

const sendResponse = (
  socket: Socket,
  response: RuntimeResponse,
  afterSend?: () => void,
): void => {
  if (socket.destroyed || socket.writableEnded) {
    afterSend?.();
    return;
  }
  socket.end(`${JSON.stringify(response)}\n`, afterSend);
};

export const startCompanyRuntimeServer = async (
  options: CompanyRuntimeServerOptions,
): Promise<CompanyRuntimeServerHandle> => {
  const releaseLock = acquireCompanyRuntimeLock(options.companyDir);
  let database: CompanyDatabase;
  try {
    database = openCompanyDatabase(options.companyDir, {
      executionAdapter: options.executionAdapter,
      agentHost: options.agentHost,
      ...(options.testBuildFixture
        ? {
            clock: options.testBuildFixture.clock,
            testRuntime: {
              fixtureAuthority: options.testBuildFixture.fixtureAuthority,
              nextId: options.testBuildFixture.nextId,
              ...(options.testExecutionAdapterFactory
                ? {
                    executionAdapterFactory:
                      options.testExecutionAdapterFactory,
                  }
                : {}),
            },
          }
        : {}),
      ...(options.interactionExecutionAdapter
        ? { interactionExecutionAdapter: options.interactionExecutionAdapter }
        : {}),
      ...(options.reviewerExecutionAdapter
        ? {
            codeReviewRuntime: {
              reviewerExecutionAdapter: options.reviewerExecutionAdapter,
            },
          }
        : {}),
      ...(options.integrationValidationProvider
        ? {
            integrationRuntime: {
              validationProvider: options.integrationValidationProvider,
            },
          }
        : {}),
      ...(options.deliveryQualityPlans
        ? {
            deliveryQualityRuntime: {
              plans: options.deliveryQualityPlans,
            },
          }
        : {}),
      ...(!options.testBuildFixture && options.testExecutionAdapterFactory
        ? {
            testRuntime: {
              executionAdapterFactory: options.testExecutionAdapterFactory,
            },
          }
        : {}),
      ...(options.releaseOperationAdapter ||
      options.releaseOperationFailureInjection
        ? {
            releaseOperationRuntime: {
              ...(options.releaseOperationAdapter
                ? { adapter: options.releaseOperationAdapter }
                : {}),
              ...(options.releaseOperationFailureInjection
                ? {
                    failureInjection: options.releaseOperationFailureInjection,
                  }
                : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    releaseLock();
    throw error;
  }
  try {
    await prepareCompanyRuntimeStartup(
      database,
      options.testBuildFixture?.setup,
    );
  } catch (error) {
    database.close();
    releaseLock();
    throw error;
  }
  const startedAt = new Date().toISOString();
  const trustedConnections = [
    {
      token: options.token,
      principal:
        options.principal ??
        ({
          type: "human",
          id: "local-desktop-user",
          authenticatedBy: "local-session",
        } satisfies ActorRef),
      consumerId: options.consumerId ?? "desktop-window-1",
    },
    ...(options.trustedConnections ?? []),
  ];
  if (
    new Set(trustedConnections.map((connection) => connection.token)).size !==
    trustedConnections.length
  ) {
    database.close();
    releaseLock();
    throw new Error(
      "Company Runtime trusted connection tokens must be unique.",
    );
  }
  let server: Server | null = null;
  let closing: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const cleanup = (): void => {
    database.close();
    if (process.platform !== "win32") rmSync(options.address, { force: true });
    releaseLock();
    resolveClosed();
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      let closeError: Error | undefined;
      try {
        await database.releaseOperations.prepareForShutdown();
        await Promise.all([
          database.pipelineRuntime.prepareForShutdown(),
          database.interaction.prepareForShutdown(),
        ]);
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server!.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        }
      } catch (error) {
        closeError = error instanceof Error ? error : new Error(String(error));
      } finally {
        cleanup();
      }
      if (closeError) throw closeError;
    })();
    return closing;
  };

  try {
    if (process.platform !== "win32") {
      mkdirSync(dirname(options.address), { recursive: true, mode: 0o700 });
      rmSync(options.address, { force: true });
    }

    server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => undefined);
      let requestText = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        requestText += chunk;
        if (requestText.length > 1_048_576) {
          socket.destroy();
          return;
        }
        if (requestText.includes("\n")) handleRequest();
      });
      function handleRequest(): void {
        if (handled) return;
        handled = true;
        let requestId = "unknown";
        try {
          const request = RuntimeRequestSchema.parse(
            JSON.parse(requestText.trim()),
          );
          requestId = request.id;
          const trustedConnection = trustedConnections.find((connection) =>
            tokenMatches(request.token, connection.token),
          );
          if (!trustedConnection) {
            sendResponse(socket, {
              id: request.id,
              ok: false,
              error: {
                name: "RuntimeAuthenticationError",
                code: "UNAUTHENTICATED",
                message: "Runtime IPC authentication failed.",
              },
            });
            return;
          }
          const { principal, consumerId } = trustedConnection;
          if (principal.type === "acp-client" && !acpRequestAllowed(request)) {
            sendResponse(socket, {
              id: request.id,
              ok: false,
              error: {
                name: "RuntimeAuthorizationError",
                code: "FORBIDDEN",
                message:
                  "ACP Client is not authorized for this Runtime request.",
              },
            });
            return;
          }
          if (request.kind === "subscription.open") {
            sendResponse(socket, {
              id: request.id,
              ok: true,
              result: database.events.openSubscription({
                principal,
                consumerId,
              }),
            });
            return;
          }
          if (request.kind === "subscription.read") {
            sendResponse(socket, {
              id: request.id,
              ok: true,
              result: database.events.readSubscription({
                principal,
                subscriptionId: request.subscriptionId,
                subscriptionGeneration: request.subscriptionGeneration,
                limit: request.limit,
              }),
            });
            return;
          }
          if (request.kind === "subscription.close") {
            database.events.closeSubscription({
              principal,
              subscriptionId: request.subscriptionId,
              subscriptionGeneration: request.subscriptionGeneration,
            });
            sendResponse(socket, {
              id: request.id,
              ok: true,
              result: { closed: true },
            });
            return;
          }
          if ("envelope" in request) {
            if (request.kind === "command") {
              if (request.envelope.command.type === "ack-runtime-events") {
                const result = database.events.executeAck({
                  ...request.envelope,
                  actor: principal,
                  consumerId,
                  command: request.envelope.command,
                });
                sendResponse(socket, {
                  id: request.id,
                  ok: true,
                  result,
                });
                return;
              }
              const result = database.commandRegistry.execute({
                ...request.envelope,
                actor: principal,
                consumerId,
                command: request.envelope.command,
              });
              if (
                request.envelope.command.type === "interaction.prompt" &&
                result.status === "succeeded"
              ) {
                void database.interaction.executeTurn(result.value.id);
              } else if (
                request.envelope.command.type === "interaction.turn.cancel" &&
                result.status === "succeeded"
              ) {
                void database.interaction.cancelTurn(result.value.id);
              }
              if (result.status === "succeeded") {
                if (
                  request.envelope.command.type ===
                    "delivery.release-operation.create" ||
                  request.envelope.command.type ===
                    "delivery.release-operation.reconcile"
                ) {
                  const operationId =
                    request.envelope.command.type ===
                    "delivery.release-operation.create"
                      ? request.envelope.command.operation.operationId
                      : request.envelope.command.operationId;
                  void database.releaseOperations
                    .dispatch(operationId)
                    .catch(() => undefined);
                } else if (
                  request.envelope.command.type ===
                  "workspace-allocation.provision"
                ) {
                  database.workspaces.executeProvision(
                    request.envelope.command.allocationId,
                  );
                } else if (
                  request.envelope.command.type === "source-import.execute"
                ) {
                  const resultCommit = request.envelope.command.resultCommit;
                  const workspaceImport = database.workspaces
                    .inspect(request.envelope.command.allocationId)
                    .imports.find(
                      (entry) =>
                        entry.resultCommit === resultCommit &&
                        (entry.state === "intent" || entry.state === "running"),
                    );
                  if (workspaceImport) {
                    database.workspaces.executeImport(workspaceImport.id);
                  }
                } else if (
                  request.envelope.command.type ===
                  "workspace-allocation.cleanup"
                ) {
                  database.workspaces.executeCleanup(
                    request.envelope.command.allocationId,
                  );
                } else if (
                  request.envelope.command.type === "work-package.assign" ||
                  request.envelope.command.type === "work-package.rework"
                ) {
                  const graph = result.value as unknown as WorkPackageGraphView;
                  const workPackageId = (
                    request.envelope.command as {
                      readonly workPackageId: string;
                    }
                  ).workPackageId;
                  const workPackage = graph.packages.find(
                    (entry) => entry.id === workPackageId,
                  );
                  const allocation = workPackage?.versions
                    .at(-1)
                    ?.assignments.at(-1)?.allocation;
                  if (allocation?.state === "planned") {
                    database.workspaces.executeProvision(allocation.id);
                  }
                } else if (
                  request.envelope.command.type === "code-review.start"
                ) {
                  database.codeReviews.reconcileReviewerWorkspace(
                    request.envelope.command.codeReviewId,
                  );
                } else if (
                  request.envelope.command.type === "test.run.create" ||
                  request.envelope.command.type === "test.rework.create" ||
                  request.envelope.command.type === "test.run.complete"
                ) {
                  const testRun = result.value as unknown as TestRunView;
                  void database.testNodeHandler.executeReady({
                    runId: testRun.manifest.runId,
                    nodeRunId: testRun.manifest.nodeRunId,
                  });
                }
              }
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result,
              });
              return;
            }
            const query = request.envelope.query;
            const result = database.events.querySnapshot({
              principal,
              consumerId,
              queryHash: createHash("sha256")
                .update(JSON.stringify(query))
                .digest("hex"),
              read: () => {
                switch (query.type) {
                  case "project.inspect":
                    return database.projectConfiguration.inspect(
                      query.projectId,
                    );
                  case "workspace-allocation.inspect":
                    return database.workspaces.inspect(query.allocationId);
                  case "work-packages.inspect":
                    return database.workPackages.inspect(query.runId);
                  case "applications.list":
                    return database.technicalReview.listApplications(
                      query.projectId,
                    );
                  case "product.discovery.inspect":
                    return database.product.inspect(query.projectId);
                  case "product-review.inspect":
                    return database.productReview.inspect(query.runId);
                  case "technical-review.inspect":
                    return database.technicalReview.inspect(query.runId);
                  case "review.topic.inspect":
                    return database.review.inspect(query.topicId);
                  case "review.topics.list":
                    return database.review.list(query);
                  case "code-reviews.inspect":
                    return database.codeReviews.inspect(query.runId);
                  case "integration-generations.inspect":
                    return database.integrations.inspect(query.runId);
                  case "test-runs.inspect":
                    return database.testRuns.inspect(query.testRunId);
                  case "test-pass-authority.inspect":
                    return database.testRuns.downstreamAuthority(
                      query.testRunId,
                    );
                  case "delivery-candidate-input.inspect":
                    return database.candidateInputs.inspect(
                      query.candidateInputId,
                    );
                  case "quality-gates.inspect":
                    return database.qualityGates.view(query.candidateInputId);
                  case "delivery-candidates.inspect":
                    return database.delivery.inspect(query.candidateId);
                  case "delivery-candidates.list":
                    return database.delivery.inspectRun(query.runId);
                  case "accepted-delivery-authority.inspect":
                    return database.delivery.acceptedAuthority(
                      query.candidateId,
                    );
                  case "release-operations.inspect":
                    return database.releaseOperations.inspect(
                      query.operationId,
                    );
                  case "release-operations.list":
                    return database.releaseOperations.list(query.candidateId);
                  case "statistics.inspect":
                    assertStatisticsReader(principal);
                    if (query.projectId !== query.query.projectId) {
                      throw new CompanyCommandError(
                        "FORBIDDEN",
                        "Statistics query Project authority does not match its canonical query.",
                      );
                    }
                    return database.statistics.inspect(query.query);
                  case "statistics-evidence.inspect":
                    assertStatisticsReader(principal);
                    return database.statistics.inspectEvidence(
                      query.evidenceSnapshotId,
                    );
                  case "run.supervision.inspect":
                    return database.supervision.inspect(query.runId);
                  case "artifact.inspect":
                    return database.artifactRegistry.inspect(query.versionId);
                  case "artifact.lineage.inspect":
                    return database.artifactRegistry.inspectLineage(
                      query.versionId,
                    );
                  case "memory.candidates.list":
                    return database.memory.listCandidates(query.projectId);
                  case "memory.records.list":
                    return database.memory.listLegacyRecords(query.projectId);
                  case "memory.entries.list":
                    return database.memory.listEntries(query.projectId);
                  case "memory.selections.list":
                    return database.memory.listSelections(query.runId);
                  case "memory.legacy-records.list":
                    return database.memory.listLegacyRecords(query.projectId);
                  case "interaction.inspect":
                    return database.interaction.inspectSession(query.sessionId);
                  default:
                    throw new Error(
                      `Verified QueryEnvelope does not support ${query.type}.`,
                    );
                }
              },
            });
            sendResponse(socket, {
              id: request.id,
              ok: true,
              result,
            });
            return;
          }
          if (request.kind === "query") {
            const result = (() => {
              switch (request.query.type) {
                case "runtime.health":
                  return {
                    status: "ok",
                    schemaVersion: database.schemaVersion(),
                    pid: process.pid,
                    startedAt,
                  };
                case "agent.catalog.inspect":
                  return database.agentCatalog.inspect();
                case "skill.discovery.inspect":
                  return database.skillCatalog.inspect();
                case "company.overview":
                  return database.catalog.overview();
                case "projects.list":
                  return database.catalog.projects();
                case "project.inspect":
                  return database.projectConfiguration.inspect(
                    request.query.projectId,
                  );
                case "workspace-allocation.inspect":
                  return database.workspaces.inspect(
                    request.query.allocationId,
                  );
                case "work-packages.inspect":
                  return database.workPackages.inspect(request.query.runId);
                case "applications.list":
                  return database.technicalReview.listApplications(
                    request.query.projectId,
                  );
                case "product.discovery.inspect":
                  return database.product.inspect(request.query.projectId);
                case "product-review.inspect":
                  return database.productReview.inspect(request.query.runId);
                case "technical-review.inspect":
                  return database.technicalReview.inspect(request.query.runId);
                case "review.topic.inspect":
                  return database.review.inspect(request.query.topicId);
                case "review.topics.list":
                  return database.review.list(request.query);
                case "code-reviews.inspect":
                  return database.codeReviews.inspect(request.query.runId);
                case "integration-generations.inspect":
                  return database.integrations.inspect(request.query.runId);
                case "test-runs.inspect":
                  return database.testRuns.inspect(request.query.testRunId);
                case "test-pass-authority.inspect":
                  return database.testRuns.downstreamAuthority(
                    request.query.testRunId,
                  );
                case "delivery-candidate-input.inspect":
                  return database.candidateInputs.inspect(
                    request.query.candidateInputId,
                  );
                case "quality-gates.inspect":
                  return database.qualityGates.view(
                    request.query.candidateInputId,
                  );
                case "delivery-candidates.inspect":
                  return database.delivery.inspect(request.query.candidateId);
                case "delivery-candidates.list":
                  return database.delivery.inspectRun(request.query.runId);
                case "accepted-delivery-authority.inspect":
                  return database.delivery.acceptedAuthority(
                    request.query.candidateId,
                  );
                case "release-operations.inspect":
                  return database.releaseOperations.inspect(
                    request.query.operationId,
                  );
                case "release-operations.list":
                  return database.releaseOperations.list(
                    request.query.candidateId,
                  );
                case "statistics.inspect":
                  assertStatisticsReader(principal);
                  if (
                    request.query.projectId !== request.query.query.projectId
                  ) {
                    throw new CompanyCommandError(
                      "FORBIDDEN",
                      "Statistics query Project authority does not match its canonical query.",
                    );
                  }
                  return database.statistics.inspect(request.query.query);
                case "statistics-evidence.inspect":
                  assertStatisticsReader(principal);
                  return database.statistics.inspectEvidence(
                    request.query.evidenceSnapshotId,
                  );
                case "departments.list":
                  return database.catalog.departments();
                case "department.inspect":
                  return database.catalog.inspectDepartment(
                    request.query.departmentId,
                  );
                case "department.skill-configuration.inspect":
                  return database.skillConfiguration.inspect(
                    request.query.departmentId,
                  );
                case "department.pipeline.inspect":
                  return database.pipelineConfiguration.inspect(
                    request.query.departmentId,
                  );
                case "department.pipeline.validate":
                  return database.pipelineConfiguration.validate(request.query);
                case "runs.list":
                  return database.pipelineRuntime.listRuns(request.query);
                case "run.inspect":
                  return database.pipelineRuntime.inspectRun(
                    request.query.runId,
                  );
                case "run.supervision.inspect":
                  return database.supervision.inspect(request.query.runId);
                case "execution.inspect":
                  return request.query.targetKind === "node-attempt"
                    ? database.pipelineRuntime.inspectExecution({
                        attemptId: request.query.targetId,
                      })
                    : database.interaction.inspectTurnExecution(
                        request.query.targetId,
                      );
                case "runtime.audit":
                  return database.pipelineRuntime.auditRecords(request.query);
                case "runtime.events":
                  return database.pipelineRuntime.runtimeEvents(request.query);
                case "runtime.events.consumer":
                  return database.pipelineRuntime.runtimeEventsForConsumer(
                    request.query,
                  );
                case "artifacts.list":
                  return database.artifactRegistry.listVersions(
                    request.query.projectId,
                  );
                case "artifact.inspect":
                  return database.artifactRegistry.inspect(
                    request.query.versionId,
                  );
                case "artifact.lineage.inspect":
                  return database.artifactRegistry.inspectLineage(
                    request.query.versionId,
                  );
                case "interactions.list":
                  return database.interaction.listSessions(
                    request.query.projectId,
                  );
                case "interaction.inspect":
                  return database.interaction.inspectSession(
                    request.query.sessionId,
                  );
                case "ag-ui.events":
                  return replayRuntimeEventsAsAgUi(
                    database.events.readAfter(
                      request.query.afterSequence,
                      request.query.limit,
                    ),
                    {
                      ...request.query,
                      earliestRetainedSequence:
                        database.events.earliestSequence(),
                    },
                  );
                case "memory.candidates.list":
                  return database.memory.listCandidates(
                    request.query.projectId,
                  );
                case "memory.records.list":
                  return database.memory.listLegacyRecords(
                    request.query.projectId,
                  );
                case "memory.entries.list":
                  return database.memory.listEntries(request.query.projectId);
                case "memory.selections.list":
                  return database.memory.listSelections(request.query.runId);
                case "memory.legacy-records.list":
                  return database.memory.listLegacyRecords(
                    request.query.projectId,
                  );
                case "runtime.diagnostics":
                  return database.diagnostics.inspect();
              }
            })();
            sendResponse(socket, {
              id: request.id,
              ok: true,
              result,
            });
            return;
          }
          switch (request.command.type) {
            case "agent.catalog.discover":
              database.agentCatalog
                .discover()
                .then((result) =>
                  sendResponse(socket, { id: request.id, ok: true, result }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name: "AgentCatalogError",
                      code:
                        error instanceof AgentCatalogError
                          ? error.code
                          : "AGENT_DISCOVERY_FAILED",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Agent discovery failed.",
                    },
                  }),
                );
              return;
            case "agent.test":
              database.agentCatalog
                .test(request.command.agentId)
                .then((result) =>
                  sendResponse(socket, { id: request.id, ok: true, result }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name: "AgentCatalogError",
                      code:
                        error instanceof AgentCatalogError
                          ? error.code
                          : "AGENT_TEST_FAILED",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Agent test failed.",
                    },
                  }),
                );
              return;
            case "skill.discovery.refresh":
              database.skillCatalog
                .discover({ directories: request.command.directories })
                .then((result) =>
                  sendResponse(socket, { id: request.id, ok: true, result }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name: "SkillCatalogError",
                      code:
                        error instanceof SkillCatalogError
                          ? error.code
                          : "SKILL_DISCOVERY_FAILED",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Skill discovery failed.",
                    },
                  }),
                );
              return;
            case "skill.discovery.enable":
            case "skill.discovery.archive": {
              const operation =
                request.command.type === "skill.discovery.enable"
                  ? database.skillCatalog.enable(request.command.skillId)
                  : database.skillCatalog.archive(request.command.skillId);
              operation
                .then((result) =>
                  sendResponse(socket, { id: request.id, ok: true, result }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name: "SkillCatalogError",
                      code:
                        error instanceof SkillCatalogError
                          ? error.code
                          : "SKILL_DISCOVERY_FAILED",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Skill Catalog mutation failed.",
                    },
                  }),
                );
              return;
            }
            case "artifact.version.status":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.artifactRegistry.setStatus(request.command),
              });
              return;
            case "runtime.backup":
              database
                .backup()
                .then((result) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: true,
                    result,
                  }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name: "RuntimeBackupError",
                      code: "RUNTIME_BACKUP_FAILED",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Company database backup failed.",
                    },
                  }),
                );
              return;
            case "interaction.session.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.interaction.createSession(request.command),
              });
              return;
            case "interaction.session.close":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.interaction.closeSession(
                  request.command.sessionId,
                ),
              });
              return;
            case "interaction.participant.add":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.interaction.addParticipant(request.command),
              });
              return;
            case "interaction.message.add":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.interaction.addMessage(request.command),
              });
              return;
            case "interaction.prompt":
              sendResponse(socket, {
                id: request.id,
                ok: false,
                error: {
                  name: "CompanyCommandError",
                  code: "COMMAND_ENVELOPE_REQUIRED",
                  message:
                    "Interaction Prompt requires the verified command envelope tunnel.",
                },
              });
              return;
            case "permission.request":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.interaction.requestPermission(request.command),
              });
              return;
            case "permission.decide":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.decidePermission({
                  ...request.command,
                  actor: principal,
                  commandId: request.id,
                }),
              });
              return;
            case "runtime.events.compact":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.diagnostics.compactRuntimeEvents(
                  request.command,
                ),
              });
              return;
            case "runtime.events.ack":
              database.pipelineRuntime.acknowledgeRuntimeEvents(
                request.command,
              );
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: { acknowledged: true },
              });
              return;
            case "project.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.createProject(request.command),
              });
              return;
            case "project.update":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.projectConfiguration.update(request.command),
              });
              return;
            case "project.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.projectConfiguration.archive(request.command),
              });
              return;
            case "department.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.createDepartment(request.command),
              });
              return;
            case "department.update":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.updateDepartment(request.command),
              });
              return;
            case "department.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.archiveDepartment(request.command),
              });
              return;
            case "department.copy":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.copyDepartment(request.command),
              });
              return;
            case "position.update":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.updatePosition(request.command),
              });
              return;
            case "position.configure":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.configurePosition(request.command),
              });
              return;
            case "position.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.createPosition(request.command),
              });
              return;
            case "position.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.archivePosition(request.command),
              });
              return;
            case "secret-reference.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.createSecretReference(request.command),
              });
              return;
            case "secret-reference.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.archiveSecretReference(
                  request.command,
                ),
              });
              return;
            case "execution-profile.save":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.saveExecutionProfile(request.command),
              });
              return;
            case "execution-profile.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.catalog.archiveExecutionProfile(
                  request.command,
                ),
              });
              return;
            case "skill.catalog.save":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.skillConfiguration.saveSkill(request.command),
              });
              return;
            case "skill.catalog.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.skillConfiguration.archiveSkill(
                  request.command,
                ),
              });
              return;
            case "position.skills.set":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.skillConfiguration.setPositionSkills(
                  request.command,
                ),
              });
              return;
            case "skill-flow.save":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.skillConfiguration.saveSkillFlow(
                  request.command,
                ),
              });
              return;
            case "skill-flow.archive":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.skillConfiguration.archiveSkillFlow(
                  request.command,
                ),
              });
              return;
            case "department.pipeline.draft.save":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineConfiguration.saveDraft(
                  request.command,
                ),
              });
              return;
            case "department.pipeline.publish":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineConfiguration.publish(request.command),
              });
              return;
            case "run.start":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.startFormalizedRun({
                  projectId: request.command.projectId,
                  departmentId: request.command.departmentId,
                }),
              });
              return;
            case "run.fork":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.forkRun(request.command),
              });
              return;
            case "run.execute-ready":
              database.pipelineRuntime
                .executeReady(request.command)
                .then((result) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: true,
                    result,
                  }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name:
                        error instanceof Error ? error.name : "RuntimeError",
                      code:
                        error instanceof PipelineRuntimeError
                          ? error.code
                          : "PROTOCOL_ERROR",
                      message:
                        error instanceof PipelineRuntimeError
                          ? error.message
                          : `Invalid Runtime command: ${String(error)}`,
                    },
                  }),
                );
              return;
            case "run.pause":
            case "run.resume":
            case "run.cancel":
              database.pipelineRuntime
                .controlRun({
                  runId: request.command.runId,
                  expectedRevision: request.command.expectedRevision,
                  action:
                    request.command.type === "run.pause"
                      ? "pause"
                      : request.command.type === "run.resume"
                        ? "resume"
                        : "cancel",
                })
                .then((result) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: true,
                    result,
                  }),
                )
                .catch((error: unknown) =>
                  sendResponse(socket, {
                    id: request.id,
                    ok: false,
                    error: {
                      name:
                        error instanceof Error ? error.name : "RuntimeError",
                      code:
                        error instanceof PipelineRuntimeError
                          ? error.code
                          : "PROTOCOL_ERROR",
                      message:
                        error instanceof PipelineRuntimeError
                          ? error.message
                          : `Invalid Runtime command: ${String(error)}`,
                    },
                  }),
                );
              return;
            case "run.recover":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.recoverRun(request.command),
              });
              return;
            case "run.approval.decide":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.decideApproval({
                  ...request.command,
                  actor: principal,
                  commandId: request.id,
                }),
              });
              return;
            case "run.approval.retry":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.retryApproval({
                  ...request.command,
                  actor: principal,
                }),
              });
              return;
            case "run.node.retry":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.pipelineRuntime.retryNode(request.command),
              });
              return;
            case "runtime.shutdown":
              sendResponse(
                socket,
                { id: request.id, ok: true, result: { stopping: true } },
                () => void close(),
              );
          }
        } catch (error) {
          sendResponse(socket, {
            id: requestId,
            ok: false,
            error: {
              name:
                error instanceof Error ? error.name : "RuntimeProtocolError",
              code:
                error instanceof CompanyCatalogError ||
                error instanceof PipelineConfigurationError ||
                error instanceof PipelineRuntimeError ||
                error instanceof ProjectConfigurationError ||
                error instanceof SkillConfigurationError ||
                error instanceof RuntimeInteractionError ||
                error instanceof ArtifactRegistryError ||
                error instanceof AgUiCursorExpiredError ||
                error instanceof AgUiProtocolDiagnosticError ||
                error instanceof RuntimeMemoryError ||
                error instanceof CompanyCommandError ||
                error instanceof WorkspaceRuntimeError ||
                error instanceof WorkPackageRuntimeError ||
                error instanceof CandidateInputRuntimeError ||
                error instanceof QualityGateRuntimeError ||
                error instanceof DeliveryRuntimeError ||
                error instanceof ReleaseOperationRuntimeError ||
                error instanceof StatisticsRuntimeError ||
                error instanceof RuntimeEventCursorError
                  ? error.code
                  : "PROTOCOL_ERROR",
              message:
                error instanceof CompanyCatalogError ||
                error instanceof PipelineConfigurationError ||
                error instanceof PipelineRuntimeError ||
                error instanceof ProjectConfigurationError ||
                error instanceof SkillConfigurationError ||
                error instanceof RuntimeInteractionError ||
                error instanceof ArtifactRegistryError ||
                error instanceof AgUiCursorExpiredError ||
                error instanceof AgUiProtocolDiagnosticError ||
                error instanceof RuntimeMemoryError ||
                error instanceof CompanyCommandError ||
                error instanceof WorkspaceRuntimeError ||
                error instanceof WorkPackageRuntimeError ||
                error instanceof CandidateInputRuntimeError ||
                error instanceof QualityGateRuntimeError ||
                error instanceof DeliveryRuntimeError ||
                error instanceof ReleaseOperationRuntimeError ||
                error instanceof StatisticsRuntimeError ||
                error instanceof RuntimeEventCursorError
                  ? error.message
                  : `Invalid Runtime IPC request: ${String(error)}`,
            },
          });
        }
      }
      socket.on("end", handleRequest);
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(options.address, () => {
        server!.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") chmodSync(options.address, 0o600);

    return { address: options.address, closed, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
};
