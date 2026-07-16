import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  CompanyDepartmentSchema,
  ArtifactVersionViewSchema,
  ArtifactLineageViewSchema,
  InteractionViewSchema,
  InteractionSessionViewSchema,
  SessionParticipantViewSchema,
  SessionMessageViewSchema,
  PermissionRequestViewSchema,
  AgUiReplayViewSchema,
  MemoryCandidateViewSchema,
  MemoryRecordViewSchema,
  MemoryReviewViewSchema,
  RuntimeDiagnosticsViewSchema,
  RuntimeBackupViewSchema,
  CompanyOverviewSchema,
  CompanyProjectSchema,
  DepartmentRunViewSchema,
  DepartmentPipelineEditorViewSchema,
  DepartmentInspectSchema,
  PipelineValidationResultSchema,
  ProjectEditorViewSchema,
  RuntimeHealthSchema,
  AgentCatalogViewSchema,
  AgentTestResultSchema,
  SkillCatalogViewSchema,
  PositionConfigurationResultSchema,
  RuntimeAuditRecordSchema,
  RuntimeEventRecordSchema,
  RuntimeResponseSchema,
  SkillConfigurationViewSchema,
  type CompanyCommand,
  type CompanyCommandResult,
  type CompanyQuery,
  type CompanyQueryResult,
  type CompanyRuntimeClient,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./interface.js";

export class RuntimeClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }
}

export interface CompanyRuntimeConnection {
  readonly address: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

export interface RuntimeRequestTransport {
  request(request: RuntimeRequest): Promise<RuntimeResponse>;
}

const sendRequest = async (
  connection: CompanyRuntimeConnection,
  request: RuntimeRequest,
): Promise<RuntimeResponse> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(connection.address);
    let response = "";
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const longRunningCommand =
      request.kind === "command" &&
      ["run.execute-ready", "run.pause", "run.resume", "run.cancel"].includes(
        request.command.type,
      );
    socket.setTimeout(
      longRunningCommand ? 0 : (connection.timeoutMs ?? 5_000),
      () => {
        fail(
          new RuntimeClientError("RUNTIME_TIMEOUT", "Runtime IPC timed out."),
        );
      },
    );
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 1_048_576) {
        fail(
          new RuntimeClientError(
            "PROTOCOL_ERROR",
            "Runtime IPC response exceeded the size limit.",
          ),
        );
      }
    });
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = RuntimeResponseSchema.parse(JSON.parse(response.trim()));
        resolve(parsed);
      } catch (error) {
        reject(
          error instanceof RuntimeClientError
            ? error
            : new RuntimeClientError(
                "PROTOCOL_ERROR",
                `Invalid Runtime IPC response: ${String(error)}`,
              ),
        );
      }
    });
  });

export const createLocalRuntimeTransport = (
  connection: CompanyRuntimeConnection,
): RuntimeRequestTransport => ({
  request: (request) => sendRequest(connection, request),
});

const requestResult = async (
  transport: RuntimeRequestTransport,
  request: RuntimeRequest,
): Promise<unknown> => {
  const response = RuntimeResponseSchema.parse(
    await transport.request(request),
  );
  if (response.id !== request.id) {
    throw new RuntimeClientError(
      "PROTOCOL_ERROR",
      "Runtime IPC response did not match the request id.",
    );
  }
  if (!response.ok) {
    throw new RuntimeClientError(response.error.code, response.error.message);
  }
  return response.result;
};

export const createCompanyRuntimeClientFromTransport = (
  transport: RuntimeRequestTransport,
  token = "scripted-runtime",
): CompanyRuntimeClient => ({
  query: async <Query extends CompanyQuery>(
    query: Query,
  ): Promise<CompanyQueryResult<Query>> => {
    const result = await requestResult(transport, {
      id: randomUUID(),
      token,
      kind: "query",
      query,
    });
    switch (query.type) {
      case "runtime.health":
        return RuntimeHealthSchema.parse(result) as CompanyQueryResult<Query>;
      case "agent.catalog.inspect":
        return AgentCatalogViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "skill.discovery.inspect":
        return SkillCatalogViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "company.overview":
        return CompanyOverviewSchema.parse(result) as CompanyQueryResult<Query>;
      case "projects.list":
        return CompanyProjectSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "project.inspect":
        return ProjectEditorViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "departments.list":
        return CompanyDepartmentSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "department.inspect":
        return DepartmentInspectSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "department.skill-configuration.inspect":
        return SkillConfigurationViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "department.pipeline.inspect":
        return DepartmentPipelineEditorViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "department.pipeline.validate":
        return PipelineValidationResultSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "runs.list":
        return DepartmentRunViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "run.inspect":
        return DepartmentRunViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "runtime.audit":
        return RuntimeAuditRecordSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "runtime.events":
      case "runtime.events.consumer":
        return RuntimeEventRecordSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "artifacts.list":
        return ArtifactVersionViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "artifact.inspect":
        return ArtifactLineageViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
      case "interactions.list":
        return InteractionViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "interaction.inspect":
        return InteractionViewSchema.parse(result) as CompanyQueryResult<Query>;
      case "ag-ui.events":
        return AgUiReplayViewSchema.parse(result) as CompanyQueryResult<Query>;
      case "memory.candidates.list":
        return MemoryCandidateViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "memory.records.list":
        return MemoryRecordViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "runtime.diagnostics":
        return RuntimeDiagnosticsViewSchema.parse(
          result,
        ) as CompanyQueryResult<Query>;
    }
  },
  execute: async <Command extends CompanyCommand>(
    command: Command,
  ): Promise<CompanyCommandResult<Command>> => {
    const result = await requestResult(transport, {
      id: randomUUID(),
      token,
      kind: "command",
      command,
    });
    if (command.type === "project.create") {
      return CompanyProjectSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "position.configure") {
      return PositionConfigurationResultSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "agent.catalog.discover") {
      return AgentCatalogViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "agent.test") {
      return AgentTestResultSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (
      command.type === "skill.discovery.refresh" ||
      command.type === "skill.discovery.enable" ||
      command.type === "skill.discovery.archive"
    ) {
      return SkillCatalogViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "runtime.backup") {
      return RuntimeBackupViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "artifact.version.status") {
      return ArtifactVersionViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "runtime.events.ack") {
      return { acknowledged: true } as CompanyCommandResult<Command>;
    }
    if (command.type === "interaction.session.create") {
      return InteractionSessionViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "interaction.session.close") {
      return InteractionSessionViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "interaction.participant.add") {
      return SessionParticipantViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "interaction.message.add") {
      return SessionMessageViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (
      command.type === "permission.request" ||
      command.type === "permission.decide"
    ) {
      return PermissionRequestViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "memory.candidate.create") {
      return MemoryCandidateViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "memory.candidate.review") {
      return MemoryReviewViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "runtime.events.compact") {
      return result as CompanyCommandResult<Command>;
    }
    if (
      command.type === "project.update" ||
      command.type === "project.archive"
    ) {
      return ProjectEditorViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "department.create") {
      return CompanyDepartmentSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (
      command.type === "skill.catalog.save" ||
      command.type === "skill.catalog.archive" ||
      command.type === "position.skills.set" ||
      command.type === "skill-flow.save" ||
      command.type === "skill-flow.archive"
    ) {
      return SkillConfigurationViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type !== "runtime.shutdown") {
      if (
        command.type === "department.pipeline.draft.save" ||
        command.type === "department.pipeline.publish"
      ) {
        return DepartmentPipelineEditorViewSchema.parse(
          result,
        ) as CompanyCommandResult<Command>;
      }
      if (
        command.type === "run.start" ||
        command.type === "run.fork" ||
        command.type === "run.execute-ready" ||
        command.type === "run.pause" ||
        command.type === "run.resume" ||
        command.type === "run.cancel" ||
        command.type === "run.recover" ||
        command.type === "run.approval.decide" ||
        command.type === "run.node.retry"
      ) {
        return DepartmentRunViewSchema.parse(
          result,
        ) as CompanyCommandResult<Command>;
      }
      return DepartmentInspectSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (
      typeof result === "object" &&
      result !== null &&
      "stopping" in result &&
      result.stopping === true
    ) {
      return { stopping: true } as CompanyCommandResult<Command>;
    }
    throw new RuntimeClientError(
      "PROTOCOL_ERROR",
      "Runtime shutdown response was invalid.",
    );
  },
});

export const createCompanyRuntimeClient = (
  connection: CompanyRuntimeConnection,
): CompanyRuntimeClient =>
  createCompanyRuntimeClientFromTransport(
    createLocalRuntimeTransport(connection),
    connection.token,
  );
