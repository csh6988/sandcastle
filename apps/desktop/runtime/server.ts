import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { RuntimeRequestSchema, type RuntimeResponse } from "./interface.js";
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
  replayRuntimeEventsAsAgUi,
} from "./agUiAdapter.js";
import { acquireCompanyRuntimeLock } from "./runtimeLock.js";
import { openCompanyDatabase, type CompanyDatabase } from "./storage/sqlite.js";
import type { LocalAgentHost } from "./agent/agentCatalog.js";
import type { ExecutionAdapter } from "./adapters/scriptedExecutionAdapter.js";

export interface CompanyRuntimeServerOptions {
  readonly address: string;
  readonly companyDir: string;
  readonly token: string;
  readonly executionAdapter?: ExecutionAdapter;
  readonly agentHost?: LocalAgentHost;
}

export interface CompanyRuntimeServerHandle {
  readonly address: string;
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

const tokenDigest = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

const tokenMatches = (actual: string, expected: string): boolean =>
  timingSafeEqual(tokenDigest(actual), tokenDigest(expected));

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
    });
  } catch (error) {
    releaseLock();
    throw error;
  }
  const startedAt = new Date().toISOString();
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
    closing = new Promise<void>((resolve, reject) => {
      if (!server) {
        cleanup();
        resolve();
        return;
      }
      server.close((error) => {
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
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
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        requestText += chunk;
        if (requestText.length > 1_048_576) socket.destroy();
      });
      socket.on("end", () => {
        let requestId = "unknown";
        try {
          const request = RuntimeRequestSchema.parse(
            JSON.parse(requestText.trim()),
          );
          requestId = request.id;
          if (!tokenMatches(request.token, options.token)) {
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
                    database.pipelineRuntime.runtimeEvents({
                      afterSequence: request.query.afterSequence,
                      limit: request.query.limit,
                    }),
                    {
                      ...request.query,
                      earliestRetainedSequence:
                        database.pipelineRuntime.runtimeEvents({
                          afterSequence: 0,
                          limit: 1,
                        })[0]?.sequence,
                    },
                  );
                case "memory.candidates.list":
                  return database.memory.listCandidates(
                    request.query.projectId,
                  );
                case "memory.records.list":
                  return database.memory.listRecords(request.query.projectId);
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
                result: database.interaction.decidePermission(request.command),
              });
              return;
            case "memory.candidate.create":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.memory.createCandidate(request.command),
              });
              return;
            case "memory.candidate.review":
              sendResponse(socket, {
                id: request.id,
                ok: true,
                result: database.memory.reviewCandidate(request.command),
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
                result: database.pipelineRuntime.startRun(request.command),
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
                result: database.pipelineRuntime.decideApproval(
                  request.command,
                ),
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
                error instanceof RuntimeMemoryError
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
                error instanceof RuntimeMemoryError
                  ? error.message
                  : `Invalid Runtime IPC request: ${String(error)}`,
            },
          });
        }
      });
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
