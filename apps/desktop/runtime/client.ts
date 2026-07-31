import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  CompanyDepartmentSchema,
  ApplicationViewSchema,
  ArtifactVersionViewSchema,
  ArtifactLineageViewSchema,
  ArtifactLineageGraphViewSchema,
  ArtifactRegistrationViewSchema,
  InteractionViewSchema,
  InteractionSessionViewSchema,
  SessionParticipantViewSchema,
  SessionMessageViewSchema,
  InteractionTurnViewSchema,
  PermissionRequestViewSchema,
  AgUiReplayViewSchema,
  MemoryCandidateViewSchema,
  MemoryEntryViewSchema,
  RunMemorySelectionViewSchema,
  LegacyMemoryRecordViewSchema,
  RuntimeDiagnosticsViewSchema,
  RuntimeBackupViewSchema,
  CompanyOverviewSchema,
  CompanyProjectSchema,
  DepartmentRunViewSchema,
  RunSupervisionViewSchema,
  ExecutionInspectionViewSchema,
  DepartmentPipelineEditorViewSchema,
  DepartmentInspectSchema,
  PipelineValidationResultSchema,
  ProjectEditorViewSchema,
  ProductDiscoveryViewSchema,
  ProductReviewStateViewSchema,
  TechnicalReviewStateViewSchema,
  ReviewTopicViewSchema,
  CodeReviewViewSchema,
  IntegrationGenerationViewSchema,
  TestCaseRevisionViewSchema,
  TestPassAuthorityViewSchema,
  TestRunViewSchema,
  DeliveryCandidateInputViewSchema,
  CandidateQualityGateViewSchema,
  WorkspaceAllocationViewSchema,
  WorkPackageGraphViewSchema,
  RuntimeHealthSchema,
  AgentCatalogViewSchema,
  AgentTestResultSchema,
  SkillCatalogViewSchema,
  PositionConfigurationResultSchema,
  RuntimeAuditRecordSchema,
  RuntimeEventRecordSchema,
  RuntimeResponseSchema,
  CommandResultSchema,
  QueryResultSchema,
  RuntimeSubscriptionBatchSchema,
  RuntimeSubscriptionHandleSchema,
  ProjectUpdateEnvelopeCommandSchema,
  ProductProposalReviseEnvelopeCommandSchema,
  ProductProposalMarkAwaitingEnvelopeCommandSchema,
  ConfirmProductBaselineEnvelopeCommandSchema,
  ForkDepartmentRunEnvelopeCommandSchema,
  SkillConfigurationViewSchema,
  type ActorRef,
  type CommandEnvelope,
  type CommandResult,
  type CompanyCommand,
  type CompanyCommandResult,
  type CompanyQuery,
  type CompanyQueryResult,
  type CompanyRuntimeClient,
  type EnvelopeCommand,
  type EnvelopeCommandResult,
  type QueryEnvelope,
  type QueryResult,
  type RuntimeRequestInput,
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
  request(request: RuntimeRequestInput): Promise<RuntimeResponse>;
}

const sendRequest = async (
  connection: CompanyRuntimeConnection,
  request: RuntimeRequestInput,
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

    const commandType =
      request.kind === "command"
        ? "envelope" in request
          ? request.envelope.command.type
          : request.command.type
        : undefined;
    const longRunningCommand =
      commandType !== undefined &&
      [
        "run.execute-ready",
        "run.pause",
        "run.resume",
        "run.cancel",
        "agent.catalog.discover",
        "agent.test",
      ].includes(commandType);
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
  request: RuntimeRequestInput,
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
  context: {
    readonly actor?: ActorRef;
    readonly consumerId?: string;
  } = {},
): CompanyRuntimeClient => ({
  query: async <Query extends CompanyQuery>(
    query: Query,
  ): Promise<CompanyQueryResult<Query>> => {
    const result = await requestResult(
      transport,
      query.type === "project.inspect" ||
        query.type === "workspace-allocation.inspect" ||
        query.type === "work-packages.inspect" ||
        query.type === "applications.list" ||
        query.type === "product.discovery.inspect" ||
        query.type === "product-review.inspect" ||
        query.type === "technical-review.inspect" ||
        query.type === "review.topic.inspect" ||
        query.type === "review.topics.list" ||
        query.type === "code-reviews.inspect" ||
        query.type === "integration-generations.inspect" ||
        query.type === "test-runs.inspect" ||
        query.type === "test-pass-authority.inspect" ||
        query.type === "delivery-candidate-input.inspect" ||
        query.type === "quality-gates.inspect" ||
        query.type === "run.supervision.inspect" ||
        query.type === "artifact.inspect" ||
        query.type === "artifact.lineage.inspect" ||
        query.type === "interaction.inspect"
        ? {
            id: randomUUID(),
            token,
            kind: "query",
            envelope: {
              schemaVersion: 1,
              requestId: randomUUID(),
              principal:
                context.actor ??
                ({
                  type: "test-driver",
                  id: "runtime-client",
                  authenticatedBy: "ipc-token",
                } satisfies ActorRef),
              consumerId: context.consumerId ?? "runtime-client",
              query,
            },
          }
        : {
            id: randomUUID(),
            token,
            kind: "query",
            query,
          },
    );
    const parsedQueryResult = QueryResultSchema.safeParse(result);
    const queryValue = parsedQueryResult.success
      ? parsedQueryResult.data.view
      : result;
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
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "workspace-allocation.inspect":
        return WorkspaceAllocationViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "work-packages.inspect":
        return WorkPackageGraphViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "applications.list":
        return ApplicationViewSchema.array().parse(
          queryValue,
        ) as unknown as CompanyQueryResult<Query>;
      case "product.discovery.inspect":
        return ProductDiscoveryViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "product-review.inspect":
        return ProductReviewStateViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "technical-review.inspect":
        return TechnicalReviewStateViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "review.topic.inspect":
        return ReviewTopicViewSchema.parse(
          queryValue,
        ) as unknown as CompanyQueryResult<Query>;
      case "review.topics.list":
        return ReviewTopicViewSchema.array().parse(
          queryValue,
        ) as unknown as CompanyQueryResult<Query>;
      case "code-reviews.inspect":
        return CodeReviewViewSchema.array().parse(
          queryValue,
        ) as unknown as CompanyQueryResult<Query>;
      case "integration-generations.inspect":
        return IntegrationGenerationViewSchema.array().parse(
          queryValue,
        ) as unknown as CompanyQueryResult<Query>;
      case "test-runs.inspect":
        return TestRunViewSchema.parse(queryValue) as CompanyQueryResult<Query>;
      case "test-pass-authority.inspect":
        return TestPassAuthorityViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "delivery-candidate-input.inspect":
        return DeliveryCandidateInputViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "quality-gates.inspect":
        return CandidateQualityGateViewSchema.parse(
          queryValue,
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
      case "run.supervision.inspect":
        return RunSupervisionViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "execution.inspect":
        return ExecutionInspectionViewSchema.parse(
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
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "artifact.lineage.inspect":
        return ArtifactLineageGraphViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "interactions.list":
        return InteractionViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "interaction.inspect":
        return InteractionViewSchema.parse(
          queryValue,
        ) as CompanyQueryResult<Query>;
      case "ag-ui.events":
        return AgUiReplayViewSchema.parse(result) as CompanyQueryResult<Query>;
      case "memory.candidates.list":
        return MemoryCandidateViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "memory.records.list":
        return LegacyMemoryRecordViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "memory.entries.list":
        return MemoryEntryViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "memory.selections.list":
        return RunMemorySelectionViewSchema.array().parse(
          result,
        ) as unknown as CompanyQueryResult<Query>;
      case "memory.legacy-records.list":
        return LegacyMemoryRecordViewSchema.array().parse(
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
    const verifiedActor =
      context.actor ??
      ({
        type: "test-driver",
        id: "runtime-client",
        authenticatedBy: "ipc-token",
      } satisfies ActorRef);
    const rawResult = await requestResult(
      transport,
      command.type === "project.update"
        ? {
            id: randomUUID(),
            token,
            kind: "command",
            envelope: {
              schemaVersion: 1,
              commandId: randomUUID(),
              actor: verifiedActor,
              consumerId: context.consumerId ?? "runtime-client",
              expectedRevision: command.expectedRevision,
              command: ProjectUpdateEnvelopeCommandSchema.parse({
                type: command.type,
                projectId: command.projectId,
                name: command.name,
                goal: command.goal,
                sharedContext: command.sharedContext,
                repositoryReferences: command.repositoryReferences,
              }),
            },
          }
        : command.type === "interaction.prompt"
          ? {
              id: randomUUID(),
              token,
              kind: "command",
              envelope: {
                schemaVersion: 1,
                commandId: randomUUID(),
                actor: verifiedActor,
                consumerId: context.consumerId ?? "runtime-client",
                command,
              },
            }
          : command.type === "product.proposal.revise" ||
              command.type === "product.proposal.mark-awaiting-confirmation" ||
              command.type === "confirm-product-baseline" ||
              command.type === "fork-department-run"
            ? {
                id: randomUUID(),
                token,
                kind: "command",
                envelope: {
                  schemaVersion: 1,
                  commandId: randomUUID(),
                  actor: verifiedActor,
                  consumerId: context.consumerId ?? "runtime-client",
                  expectedRevision: command.expectedRevision,
                  command:
                    command.type === "product.proposal.revise"
                      ? ProductProposalReviseEnvelopeCommandSchema.parse({
                          type: command.type,
                          projectId: command.projectId,
                          producerSessionId: command.producerSessionId,
                          content: command.content,
                        })
                      : command.type ===
                          "product.proposal.mark-awaiting-confirmation"
                        ? ProductProposalMarkAwaitingEnvelopeCommandSchema.parse(
                            {
                              type: command.type,
                              projectId: command.projectId,
                              proposalRevisionId: command.proposalRevisionId,
                              proposalHash: command.proposalHash,
                            },
                          )
                        : command.type === "confirm-product-baseline"
                          ? ConfirmProductBaselineEnvelopeCommandSchema.parse({
                              type: command.type,
                              projectId: command.projectId,
                              departmentId: command.departmentId,
                              agentOverrideId: command.agentOverrideId,
                              forkSourceRunId: command.forkSourceRunId,
                              forkSourceSnapshotRevisionId:
                                command.forkSourceSnapshotRevisionId,
                              proposalRevisionId: command.proposalRevisionId,
                              proposalHash: command.proposalHash,
                            })
                          : ForkDepartmentRunEnvelopeCommandSchema.parse({
                              type: command.type,
                              sourceRunId: command.sourceRunId,
                              sourceSnapshotRevisionId:
                                command.sourceSnapshotRevisionId,
                              reason: command.reason,
                            }),
                },
              }
            : command.type === "ack-runtime-events" ||
                command.type === "artifact.version.register" ||
                command.type === "artifact.version.finalize" ||
                command.type === "artifact.version.supersede"
              ? {
                  id: randomUUID(),
                  token,
                  kind: "command",
                  envelope: {
                    schemaVersion: 1,
                    commandId: randomUUID(),
                    actor: verifiedActor,
                    consumerId: context.consumerId ?? "runtime-client",
                    command:
                      command.type === "artifact.version.register"
                        ? {
                            ...command,
                            content:
                              command.content.kind === "managed-file"
                                ? command.content
                                : command.content,
                          }
                        : command,
                  },
                }
              : {
                  id: randomUUID(),
                  token,
                  kind: "command",
                  command,
                },
    );
    const parsedCommandResult = CommandResultSchema.safeParse(rawResult);
    if (
      command.type === "project.update" &&
      parsedCommandResult.success &&
      parsedCommandResult.data.status === "rejected"
    ) {
      throw new RuntimeClientError(
        parsedCommandResult.data.error.code,
        parsedCommandResult.data.error.message,
      );
    }
    const result =
      command.type === "project.update" &&
      parsedCommandResult.success &&
      parsedCommandResult.data.status === "succeeded"
        ? parsedCommandResult.data.value
        : rawResult;
    if (command.type === "project.create") {
      return CompanyProjectSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (
      command.type === "product.proposal.revise" ||
      command.type === "product.proposal.mark-awaiting-confirmation" ||
      command.type === "confirm-product-baseline" ||
      command.type === "fork-department-run"
    ) {
      if (!parsedCommandResult.success) {
        throw new RuntimeClientError(
          "PROTOCOL_ERROR",
          "Product Runtime command response was invalid.",
        );
      }
      if (parsedCommandResult.data.status === "rejected") {
        throw new RuntimeClientError(
          parsedCommandResult.data.error.code,
          parsedCommandResult.data.error.message,
        );
      }
      return ProductDiscoveryViewSchema.parse(
        parsedCommandResult.data.value,
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
    if (command.type === "ack-runtime-events") {
      if (!parsedCommandResult.success) {
        throw new RuntimeClientError(
          "PROTOCOL_ERROR",
          "Runtime event acknowledgement response was invalid.",
        );
      }
      if (parsedCommandResult.data.status === "rejected") {
        throw new RuntimeClientError(
          parsedCommandResult.data.error.code,
          parsedCommandResult.data.error.message,
        );
      }
      return parsedCommandResult.data.value as CompanyCommandResult<Command>;
    }
    if (command.type === "artifact.version.status") {
      return ArtifactVersionViewSchema.parse(
        result,
      ) as CompanyCommandResult<Command>;
    }
    if (command.type === "artifact.version.register") {
      if (!parsedCommandResult.success) {
        throw new RuntimeClientError(
          "PROTOCOL_ERROR",
          "Artifact registration response was invalid.",
        );
      }
      if (parsedCommandResult.data.status === "rejected") {
        throw new RuntimeClientError(
          parsedCommandResult.data.error.code,
          parsedCommandResult.data.error.message,
        );
      }
      return ArtifactRegistrationViewSchema.parse(
        parsedCommandResult.data.value,
      ) as CompanyCommandResult<Command>;
    }
    if (
      command.type === "artifact.version.finalize" ||
      command.type === "artifact.version.supersede"
    ) {
      if (!parsedCommandResult.success) {
        throw new RuntimeClientError(
          "PROTOCOL_ERROR",
          "Artifact Version command response was invalid.",
        );
      }
      if (parsedCommandResult.data.status === "rejected") {
        throw new RuntimeClientError(
          parsedCommandResult.data.error.code,
          parsedCommandResult.data.error.message,
        );
      }
      return ArtifactVersionViewSchema.parse(
        parsedCommandResult.data.value,
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
    if (command.type === "interaction.prompt") {
      if (!parsedCommandResult.success) {
        throw new RuntimeClientError(
          "PROTOCOL_ERROR",
          "Interaction Prompt command response was invalid.",
        );
      }
      if (parsedCommandResult.data.status === "rejected") {
        throw new RuntimeClientError(
          parsedCommandResult.data.error.code,
          parsedCommandResult.data.error.message,
        );
      }
      return InteractionTurnViewSchema.parse(
        parsedCommandResult.data.value,
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
        command.type === "run.approval.retry" ||
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
  queryEnvelope: async <Query extends CompanyQuery>(
    envelope: QueryEnvelope<Query>,
  ): Promise<QueryResult<CompanyQueryResult<Query>>> => {
    const raw = await requestResult(transport, {
      id: randomUUID(),
      token,
      kind: "query",
      envelope,
    });
    const parsed = QueryResultSchema.parse(raw);
    const view =
      envelope.query.type === "project.inspect"
        ? ProjectEditorViewSchema.parse(parsed.view)
        : envelope.query.type === "workspace-allocation.inspect"
          ? WorkspaceAllocationViewSchema.parse(parsed.view)
          : envelope.query.type === "work-packages.inspect"
            ? WorkPackageGraphViewSchema.parse(parsed.view)
            : envelope.query.type === "applications.list"
              ? ApplicationViewSchema.array().parse(parsed.view)
              : envelope.query.type === "product.discovery.inspect"
                ? ProductDiscoveryViewSchema.parse(parsed.view)
                : envelope.query.type === "product-review.inspect"
                  ? ProductReviewStateViewSchema.parse(parsed.view)
                  : envelope.query.type === "technical-review.inspect"
                    ? TechnicalReviewStateViewSchema.parse(parsed.view)
                    : envelope.query.type === "review.topic.inspect"
                      ? ReviewTopicViewSchema.parse(parsed.view)
                      : envelope.query.type === "review.topics.list"
                        ? ReviewTopicViewSchema.array().parse(parsed.view)
                        : envelope.query.type === "code-reviews.inspect"
                          ? CodeReviewViewSchema.array().parse(parsed.view)
                          : envelope.query.type ===
                              "integration-generations.inspect"
                            ? IntegrationGenerationViewSchema.array().parse(
                                parsed.view,
                              )
                            : envelope.query.type === "test-runs.inspect"
                              ? TestRunViewSchema.parse(parsed.view)
                              : envelope.query.type ===
                                  "test-pass-authority.inspect"
                                ? TestPassAuthorityViewSchema.parse(parsed.view)
                                : envelope.query.type ===
                                    "delivery-candidate-input.inspect"
                                  ? DeliveryCandidateInputViewSchema.parse(
                                      parsed.view,
                                    )
                                  : envelope.query.type ===
                                      "quality-gates.inspect"
                                    ? CandidateQualityGateViewSchema.parse(
                                        parsed.view,
                                      )
                                    : envelope.query.type ===
                                        "run.supervision.inspect"
                                      ? RunSupervisionViewSchema.parse(
                                          parsed.view,
                                        )
                                      : envelope.query.type ===
                                          "memory.candidates.list"
                                        ? MemoryCandidateViewSchema.array().parse(
                                            parsed.view,
                                          )
                                        : envelope.query.type ===
                                              "memory.records.list" ||
                                            envelope.query.type ===
                                              "memory.legacy-records.list"
                                          ? LegacyMemoryRecordViewSchema.array().parse(
                                              parsed.view,
                                            )
                                          : envelope.query.type ===
                                              "memory.entries.list"
                                            ? MemoryEntryViewSchema.array().parse(
                                                parsed.view,
                                              )
                                            : envelope.query.type ===
                                                "memory.selections.list"
                                              ? RunMemorySelectionViewSchema.array().parse(
                                                  parsed.view,
                                                )
                                              : envelope.query.type ===
                                                  "interaction.inspect"
                                                ? InteractionViewSchema.parse(
                                                    parsed.view,
                                                  )
                                                : (() => {
                                                    throw new RuntimeClientError(
                                                      "PROTOCOL_ERROR",
                                                      `Verified QueryEnvelope does not support ${envelope.query.type}.`,
                                                    );
                                                  })();
    return {
      view: view as CompanyQueryResult<Query>,
      asOfSequence: parsed.asOfSequence,
      ...(parsed.viewSyncToken ? { viewSyncToken: parsed.viewSyncToken } : {}),
    };
  },
  executeEnvelope: async <Command extends EnvelopeCommand>(
    envelope: CommandEnvelope<Command>,
  ): Promise<CommandResult<EnvelopeCommandResult<Command>>> => {
    const raw = await requestResult(transport, {
      id: randomUUID(),
      token,
      kind: "command",
      envelope,
    });
    const parsed = CommandResultSchema.safeParse(raw);
    if (parsed.success) {
      if (
        parsed.data.status === "succeeded" &&
        envelope.command.type.startsWith("integration.")
      ) {
        return {
          ...parsed.data,
          value: IntegrationGenerationViewSchema.parse(parsed.data.value),
        } as unknown as CommandResult<EnvelopeCommandResult<Command>>;
      }
      if (
        parsed.data.status === "succeeded" &&
        envelope.command.type.startsWith("test.")
      ) {
        return {
          ...parsed.data,
          value:
            envelope.command.type === "test.case-revision.register"
              ? TestCaseRevisionViewSchema.parse(parsed.data.value)
              : TestRunViewSchema.parse(parsed.data.value),
        } as unknown as CommandResult<EnvelopeCommandResult<Command>>;
      }
      return parsed.data as CommandResult<EnvelopeCommandResult<Command>>;
    }
    if (envelope.command.type === "ack-runtime-events") {
      throw new RuntimeClientError(
        "PROTOCOL_ERROR",
        "Runtime event acknowledgement response was invalid.",
      );
    }
    return {
      status: "succeeded",
      value: ProjectEditorViewSchema.parse(
        raw,
      ) as EnvelopeCommandResult<Command>,
      effectIds: [],
    };
  },
  openSubscription: async () =>
    RuntimeSubscriptionHandleSchema.parse(
      await requestResult(transport, {
        id: randomUUID(),
        token,
        kind: "subscription.open",
      }),
    ),
  readSubscription: async (input) =>
    RuntimeSubscriptionBatchSchema.parse(
      await requestResult(transport, {
        id: randomUUID(),
        token,
        kind: "subscription.read",
        ...input,
      }),
    ),
  closeSubscription: async (input) => {
    await requestResult(transport, {
      id: randomUUID(),
      token,
      kind: "subscription.close",
      ...input,
    });
  },
});

export const createCompanyRuntimeClient = (
  connection: CompanyRuntimeConnection,
): CompanyRuntimeClient =>
  createCompanyRuntimeClientFromTransport(
    createLocalRuntimeTransport(connection),
    connection.token,
    {
      actor: {
        type: "electron-main",
        id: "desktop-main",
        authenticatedBy: "ipc-token",
      },
      consumerId: "desktop-window-1",
    },
  );
