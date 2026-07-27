import { z } from "zod";
import {
  CompanyDepartmentSchema,
  ArtifactVersionViewSchema,
  ArtifactLineageViewSchema,
  InteractionViewSchema,
  InteractionSessionViewSchema,
  SessionParticipantViewSchema,
  SessionMessageViewSchema,
  InteractionTurnViewSchema,
  PermissionRequestViewSchema,
  CompanyOverviewSchema,
  CompanyProjectSchema,
  DepartmentRunViewSchema,
  DepartmentPipelineDraftGraphSchema,
  DepartmentPipelineEditorViewSchema,
  DepartmentInspectSchema,
  PipelineValidationResultSchema,
  ProjectEditorViewSchema,
  ProductDiscoveryViewSchema,
  ProductReviewStateViewSchema,
  ApplicationViewSchema,
  TechnicalReviewStateViewSchema,
  ReviewTopicViewSchema,
  RuntimeHealthSchema,
  AgentCatalogViewSchema,
  AgentTestResultSchema,
  SkillCatalogViewSchema,
  PositionConfigurationResultSchema,
  RuntimeAuditRecordSchema,
  RuntimeEventRecordSchema,
  SkillConfigurationViewSchema,
  CompanyQuerySchema,
  CommandResultSchema,
  QueryResultSchema,
  EventEnvelopeSchema,
  EnvelopeCommandSchema,
  RuntimeSubscriptionHandleSchema,
  type CompanyQuery,
  type CompanyQueryResult,
  type EnvelopeCommand,
  type EnvelopeCommandResult,
  type CommandResult,
  type QueryResult,
  type RuntimeSubscriptionHandle,
  type ArtifactContract,
  type ArtifactVersionView,
  type ArtifactLineageView,
  type InteractionView,
  type InteractionSessionView,
  type SessionParticipantView,
  type SessionMessageView,
  type InteractionTurnView,
  type PermissionRequestView,
  AgUiReplayViewSchema,
  type AgUiReplayView,
  MemoryCandidateViewSchema,
  MemoryRecordViewSchema,
  MemoryReviewViewSchema,
  type MemoryCandidateView,
  type MemoryRecordView,
  type MemoryReviewView,
  RuntimeDiagnosticsViewSchema,
  type RuntimeDiagnosticsView,
  RuntimeBackupViewSchema,
  type RuntimeBackupView,
  type CompanyOverview,
  type CompanyDepartment,
  type CompanyProject,
  type DepartmentRunView,
  type DepartmentPipelineDraftGraph,
  type DepartmentPipelineEditorView,
  type DepartmentInspect,
  type PipelineValidationResult,
  type ProjectEditorView,
  type ProductDiscoveryView,
  type ProductReviewEnvelopeCommand,
  type ProductReviewStateView,
  type ApplicationView,
  type TechnicalReviewEnvelopeCommand,
  type TechnicalReviewStateView,
  type ReviewEnvelopeCommand,
  type ReviewTopicView,
  type RuntimeHealth,
  type AgentCatalogView,
  type AgentTestResult,
  type SkillCatalogView,
  type PositionConfigurationResult,
  type RuntimeAuditRecord,
  type RuntimeEventRecord,
  type SkillConfigurationView,
} from "../runtime/interface.js";

export const RUNTIME_HEALTH_CHANNEL = "sandcastle:runtime.health";
export const AGENT_CATALOG_INSPECT_CHANNEL = "sandcastle:agent.catalog.inspect";
export const AGENT_CATALOG_DISCOVER_CHANNEL =
  "sandcastle:agent.catalog.discover";
export const AGENT_TEST_CHANNEL = "sandcastle:agent.test";
export const SKILL_DISCOVERY_INSPECT_CHANNEL =
  "sandcastle:skill.discovery.inspect";
export const SKILL_DISCOVERY_REFRESH_CHANNEL =
  "sandcastle:skill.discovery.refresh";
export const SKILL_DISCOVERY_ENABLE_CHANNEL =
  "sandcastle:skill.discovery.enable";
export const SKILL_DISCOVERY_ARCHIVE_CHANNEL =
  "sandcastle:skill.discovery.archive";
export const COMPANY_OVERVIEW_CHANNEL = "sandcastle:company.overview";
export const PROJECTS_LIST_CHANNEL = "sandcastle:projects.list";
export const PROJECT_CREATE_CHANNEL = "sandcastle:project.create";
export const PROJECT_INSPECT_CHANNEL = "sandcastle:project.inspect";
export const PROJECT_UPDATE_CHANNEL = "sandcastle:project.update";
export const PROJECT_ARCHIVE_CHANNEL = "sandcastle:project.archive";
export const DEPARTMENTS_LIST_CHANNEL = "sandcastle:departments.list";
export const DEPARTMENT_INSPECT_CHANNEL = "sandcastle:department.inspect";
export const DEPARTMENT_CREATE_CHANNEL = "sandcastle:department.create";
export const DEPARTMENT_UPDATE_CHANNEL = "sandcastle:department.update";
export const DEPARTMENT_ARCHIVE_CHANNEL = "sandcastle:department.archive";
export const DEPARTMENT_COPY_CHANNEL = "sandcastle:department.copy";
export const POSITION_UPDATE_CHANNEL = "sandcastle:position.update";
export const POSITION_CREATE_CHANNEL = "sandcastle:position.create";
export const POSITION_ARCHIVE_CHANNEL = "sandcastle:position.archive";
export const POSITION_CONFIGURE_CHANNEL = "sandcastle:position.configure";
export const SECRET_REFERENCE_CREATE_CHANNEL =
  "sandcastle:secret-reference.create";
export const SECRET_REFERENCE_ARCHIVE_CHANNEL =
  "sandcastle:secret-reference.archive";
export const EXECUTION_PROFILE_SAVE_CHANNEL =
  "sandcastle:execution-profile.save";
export const EXECUTION_PROFILE_ARCHIVE_CHANNEL =
  "sandcastle:execution-profile.archive";
export const SKILL_CONFIGURATION_INSPECT_CHANNEL =
  "sandcastle:department.skill-configuration.inspect";
export const SKILL_CATALOG_SAVE_CHANNEL = "sandcastle:skill.catalog.save";
export const SKILL_CATALOG_ARCHIVE_CHANNEL = "sandcastle:skill.catalog.archive";
export const POSITION_SKILLS_SET_CHANNEL = "sandcastle:position.skills.set";
export const SKILL_FLOW_SAVE_CHANNEL = "sandcastle:skill-flow.save";
export const SKILL_FLOW_ARCHIVE_CHANNEL = "sandcastle:skill-flow.archive";
export const DEPARTMENT_PIPELINE_INSPECT_CHANNEL =
  "sandcastle:department.pipeline.inspect";
export const DEPARTMENT_PIPELINE_VALIDATE_CHANNEL =
  "sandcastle:department.pipeline.validate";
export const DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL =
  "sandcastle:department.pipeline.draft.save";
export const DEPARTMENT_PIPELINE_PUBLISH_CHANNEL =
  "sandcastle:department.pipeline.publish";
export const RUNS_LIST_CHANNEL = "sandcastle:runs.list";
export const RUN_INSPECT_CHANNEL = "sandcastle:run.inspect";
export const RUN_START_CHANNEL = "sandcastle:run.start";
export const RUN_FORK_CHANNEL = "sandcastle:run.fork";
export const RUN_EXECUTE_READY_CHANNEL = "sandcastle:run.execute-ready";
export const RUN_PAUSE_CHANNEL = "sandcastle:run.pause";
export const RUN_RESUME_CHANNEL = "sandcastle:run.resume";
export const RUN_CANCEL_CHANNEL = "sandcastle:run.cancel";
export const RUN_RECOVER_CHANNEL = "sandcastle:run.recover";
export const RUN_APPROVAL_DECIDE_CHANNEL = "sandcastle:run.approval.decide";
export const RUN_APPROVAL_RETRY_CHANNEL = "sandcastle:run.approval.retry";
export const RUN_NODE_RETRY_CHANNEL = "sandcastle:run.node.retry";
export const RUNTIME_AUDIT_CHANNEL = "sandcastle:runtime.audit";
export const RUNTIME_EVENTS_CHANNEL = "sandcastle:runtime.events";
export const RUNTIME_EVENTS_CONSUMER_CHANNEL =
  "sandcastle:runtime.events.consumer";
export const RUNTIME_EVENTS_ACK_CHANNEL = "sandcastle:runtime.events.ack";
export const RUNTIME_TUNNEL_CHANNEL = "sandcastle:runtime.tunnel";
export const RUNTIME_EVENT_PORT_CHANNEL = "sandcastle:runtime.event-port";
export const ARTIFACTS_LIST_CHANNEL = "sandcastle:artifacts.list";
export const ARTIFACT_INSPECT_CHANNEL = "sandcastle:artifact.inspect";
export const ARTIFACT_STATUS_CHANNEL = "sandcastle:artifact.version.status";
export const INTERACTIONS_LIST_CHANNEL = "sandcastle:interactions.list";
export const INTERACTION_INSPECT_CHANNEL = "sandcastle:interaction.inspect";
export const INTERACTION_SESSION_CREATE_CHANNEL =
  "sandcastle:interaction.session.create";
export const INTERACTION_SESSION_CLOSE_CHANNEL =
  "sandcastle:interaction.session.close";
export const INTERACTION_PARTICIPANT_ADD_CHANNEL =
  "sandcastle:interaction.participant.add";
export const INTERACTION_MESSAGE_ADD_CHANNEL =
  "sandcastle:interaction.message.add";
export const INTERACTION_PROMPT_CHANNEL = "sandcastle:interaction.prompt";
export const PERMISSION_REQUEST_CHANNEL = "sandcastle:permission.request";
export const PERMISSION_DECIDE_CHANNEL = "sandcastle:permission.decide";
export const AG_UI_EVENTS_CHANNEL = "sandcastle:ag-ui.events";
export const MEMORY_CANDIDATES_LIST_CHANNEL =
  "sandcastle:memory.candidates.list";
export const MEMORY_RECORDS_LIST_CHANNEL = "sandcastle:memory.records.list";
export const MEMORY_CANDIDATE_CREATE_CHANNEL =
  "sandcastle:memory.candidate.create";
export const MEMORY_CANDIDATE_REVIEW_CHANNEL =
  "sandcastle:memory.candidate.review";
export const RUNTIME_DIAGNOSTICS_CHANNEL = "sandcastle:runtime.diagnostics";
export const RUNTIME_BACKUP_CHANNEL = "sandcastle:runtime.backup";
export const RUNTIME_EVENTS_COMPACT_CHANNEL =
  "sandcastle:runtime.events.compact";

const RuntimeTunnelQuerySchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("query"),
    requestId: z.string().trim().min(1),
    query: CompanyQuerySchema,
  })
  .strict();

const RuntimeTunnelExecuteSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("execute"),
    commandId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
    command: EnvelopeCommandSchema,
  })
  .strict();

const RuntimeTunnelOpenEventStreamSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("open-event-stream"),
    streamRequestId: z.string().trim().min(1),
  })
  .strict();

const RuntimeTunnelCloseEventStreamSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("close-event-stream"),
    subscriptionId: z.string().trim().min(1),
    subscriptionGeneration: z.number().int().positive(),
  })
  .strict();

export const RuntimeTunnelRequestSchema = z.union([
  RuntimeTunnelQuerySchema,
  RuntimeTunnelExecuteSchema,
  RuntimeTunnelOpenEventStreamSchema,
  RuntimeTunnelCloseEventStreamSchema,
]);

const RuntimeEventControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cursor.accepted"),
      barrierSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime.disconnected"),
      code: z.string().trim().min(1),
      message: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("stream.closed"),
      reason: z.enum(["client", "runtime", "superseded", "window-destroyed"]),
    })
    .strict(),
]);

export const RuntimeEventFrameSchema = z
  .object({
    subscriptionId: z.string().trim().min(1),
    subscriptionGeneration: z.number().int().positive(),
    barrierSequence: z.number().int().nonnegative(),
    value: z.union([
      z
        .object({
          kind: z.literal("event"),
          event: EventEnvelopeSchema.strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("control"),
          control: RuntimeEventControlSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export type RuntimeEventFrame = z.infer<typeof RuntimeEventFrameSchema>;

export interface RuntimeEventPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  start(): void;
  close(): void;
  postMessage(value: unknown): void;
}

export interface RuntimeEventPortAttachment {
  readonly streamRequestId: string;
  readonly port: RuntimeEventPort;
}

export interface RuntimeBridgeError {
  readonly name: "RuntimeBridgeError";
  readonly code: string;
  readonly message: string;
}

export const isRuntimeBridgeError = (
  error: unknown,
): error is RuntimeBridgeError =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "RuntimeBridgeError" &&
  "code" in error &&
  typeof error.code === "string" &&
  "message" in error &&
  typeof error.message === "string";

const runtimeBridgeError = (
  code: string,
  message: string,
): RuntimeBridgeError => ({ name: "RuntimeBridgeError", code, message });

const invokeRuntimeCommand = async (
  invoke: (channel: string, payload?: unknown) => Promise<unknown>,
  channel: string,
  payload?: unknown,
): Promise<unknown> => {
  const response = await invoke(channel, payload);
  if (
    typeof response !== "object" ||
    response === null ||
    !("sandcastleRuntimeResult" in response) ||
    response.sandcastleRuntimeResult !== true ||
    !("ok" in response)
  ) {
    return response;
  }
  if (response.ok === true && "result" in response) return response.result;
  if (
    response.ok === false &&
    "error" in response &&
    typeof response.error === "object" &&
    response.error !== null &&
    "code" in response.error &&
    typeof response.error.code === "string" &&
    "message" in response.error &&
    typeof response.error.message === "string"
  ) {
    throw runtimeBridgeError(response.error.code, response.error.message);
  }
  throw runtimeBridgeError(
    "PROTOCOL_ERROR",
    "Runtime IPC command result was invalid.",
  );
};

export interface SandcastleBridge {
  readonly execute: <Command extends EnvelopeCommand>(input: {
    readonly commandId: string;
    readonly expectedRevision?: number;
    readonly command: Command;
  }) => Promise<CommandResult<EnvelopeCommandResult<Command>>>;
  readonly query: <Query extends CompanyQuery>(
    query: Query,
  ) => Promise<QueryResult<CompanyQueryResult<Query>>>;
  readonly openEventStream: (
    onFrame: (frame: RuntimeEventFrame) => void | Promise<void>,
  ) => Promise<RuntimeSubscriptionHandle>;
  readonly closeEventStream: (
    input: RuntimeSubscriptionHandle,
  ) => Promise<void>;
  readonly runtime: {
    readonly health: () => Promise<RuntimeHealth>;
    readonly inspectAgentCatalog: () => Promise<AgentCatalogView>;
    readonly discoverAgents: () => Promise<AgentCatalogView>;
    readonly testAgent: (agentId: string) => Promise<AgentTestResult>;
    readonly inspectSkillCatalog: () => Promise<SkillCatalogView>;
    readonly discoverSkills: (
      directories?: readonly string[],
    ) => Promise<SkillCatalogView>;
    readonly enableSkill: (skillId: string) => Promise<SkillCatalogView>;
    readonly archiveDiscoveredSkill: (
      skillId: string,
    ) => Promise<SkillCatalogView>;
    readonly overview: () => Promise<CompanyOverview>;
    readonly projects: () => Promise<readonly CompanyProject[]>;
    readonly createProject: (input: {
      readonly name: string;
      readonly goal: string;
    }) => Promise<CompanyProject>;
    readonly inspectProject: (projectId: string) => Promise<ProjectEditorView>;
    readonly applications: (
      projectId: string,
    ) => Promise<readonly ApplicationView[]>;
    readonly inspectProductDiscovery: (
      projectId: string,
    ) => Promise<ProductDiscoveryView>;
    readonly inspectProductReview: (
      runId: string,
    ) => Promise<ProductReviewStateView>;
    readonly executeProductReviewCommand: (input: {
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly command: ProductReviewEnvelopeCommand;
    }) => Promise<ProductReviewStateView>;
    readonly inspectTechnicalReview: (
      runId: string,
    ) => Promise<TechnicalReviewStateView>;
    readonly executeTechnicalReviewCommand: (input: {
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly command: TechnicalReviewEnvelopeCommand;
    }) => Promise<TechnicalReviewStateView>;
    readonly reviewTopics: (input: {
      readonly projectId?: string;
      readonly runId?: string;
    }) => Promise<readonly ReviewTopicView[]>;
    readonly inspectReviewTopic: (topicId: string) => Promise<ReviewTopicView>;
    readonly executeReviewCommand: (input: {
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly command: ReviewEnvelopeCommand;
    }) => Promise<ReviewTopicView>;
    readonly updateProject: (input: {
      readonly projectId: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly goal: string;
      readonly sharedContext: string;
      readonly repositoryReferences: readonly string[];
    }) => Promise<ProjectEditorView>;
    readonly archiveProject: (input: {
      readonly projectId: string;
      readonly expectedRevision: number;
    }) => Promise<ProjectEditorView>;
    readonly departments: () => Promise<readonly CompanyDepartment[]>;
    readonly inspectDepartment: (
      departmentId: string,
    ) => Promise<DepartmentInspect>;
    readonly createDepartment: (input: {
      readonly name: string;
    }) => Promise<CompanyDepartment>;
    readonly updateDepartment: (input: {
      readonly departmentId: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly description: string;
      readonly inputArtifactContracts: readonly ArtifactContract[];
      readonly outputArtifactContracts: readonly ArtifactContract[];
      readonly defaultExecutionProfileId: string | null;
    }) => Promise<DepartmentInspect>;
    readonly archiveDepartment: (input: {
      readonly departmentId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentInspect>;
    readonly copyDepartment: (input: {
      readonly departmentId: string;
      readonly name: string;
    }) => Promise<DepartmentInspect>;
    readonly createPosition: (input: {
      readonly departmentId: string;
      readonly name: string;
      readonly responsibility: string;
      readonly aiMemberDisplayName: string;
      readonly aiMemberProfile: string;
      readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
      readonly defaultAgentId?: string;
    }) => Promise<DepartmentInspect>;
    readonly updatePosition: (input: {
      readonly departmentId: string;
      readonly positionId: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly responsibility: string;
      readonly aiMemberDisplayName: string;
      readonly aiMemberProfile: string;
      readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
      readonly aiMemberStatus: "active" | "inactive";
      readonly defaultAgentId?: string;
    }) => Promise<DepartmentInspect>;
    readonly archivePosition: (input: {
      readonly departmentId: string;
      readonly positionId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentInspect>;
    readonly configurePosition: (input: {
      readonly departmentId: string;
      readonly positionId: string;
      readonly expectedRevision: number;
      readonly expectedSkillRevision: number;
      readonly name: string;
      readonly responsibility: string;
      readonly aiMemberDisplayName: string;
      readonly aiMemberProfile: string;
      readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
      readonly aiMemberStatus: "active" | "inactive";
      readonly defaultAgentId: string;
      readonly skillIds: readonly string[];
    }) => Promise<PositionConfigurationResult>;
    readonly createSecretReference: (input: {
      readonly departmentId: string;
      readonly name: string;
      readonly providerScope: string;
    }) => Promise<DepartmentInspect>;
    readonly archiveSecretReference: (input: {
      readonly departmentId: string;
      readonly secretReferenceId: string;
    }) => Promise<DepartmentInspect>;
    readonly saveExecutionProfile: (input: {
      readonly departmentId: string;
      readonly executionProfileId?: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly providerRef: string;
      readonly model: string;
      readonly sandboxRef: string;
      readonly branchStrategy: "head" | "merge-to-head" | "branch";
      readonly timeoutSeconds: number;
      readonly maxIterations: number;
      readonly maxTokens: number | null;
      readonly retryMaxAttempts: number;
      readonly permissionPolicy: "ask" | "allow-safe" | "deny";
      readonly secretReferenceIds: readonly string[];
    }) => Promise<DepartmentInspect>;
    readonly archiveExecutionProfile: (input: {
      readonly departmentId: string;
      readonly executionProfileId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentInspect>;
    readonly inspectSkillConfiguration: (
      departmentId: string,
    ) => Promise<SkillConfigurationView>;
    readonly saveSkill: (input: {
      readonly departmentId: string;
      readonly skillId?: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly description: string;
      readonly source: string;
      readonly version: string;
      readonly locationReference: string;
    }) => Promise<SkillConfigurationView>;
    readonly archiveSkill: (input: {
      readonly departmentId: string;
      readonly skillId: string;
      readonly expectedRevision: number;
    }) => Promise<SkillConfigurationView>;
    readonly setPositionSkills: (input: {
      readonly departmentId: string;
      readonly positionId: string;
      readonly expectedRevision: number;
      readonly skillIds: readonly string[];
    }) => Promise<SkillConfigurationView>;
    readonly saveSkillFlow: (input: {
      readonly departmentId: string;
      readonly skillFlowId?: string;
      readonly positionId: string;
      readonly expectedRevision: number;
      readonly name: string;
      readonly instructions: string;
      readonly skillIds: readonly string[];
    }) => Promise<SkillConfigurationView>;
    readonly archiveSkillFlow: (input: {
      readonly departmentId: string;
      readonly skillFlowId: string;
      readonly expectedRevision: number;
    }) => Promise<SkillConfigurationView>;
    readonly inspectPipeline: (
      departmentId: string,
    ) => Promise<DepartmentPipelineEditorView>;
    readonly validatePipeline: (input: {
      readonly departmentId: string;
      readonly graph: DepartmentPipelineDraftGraph;
    }) => Promise<PipelineValidationResult>;
    readonly savePipelineDraft: (input: {
      readonly departmentId: string;
      readonly expectedRevision: number;
      readonly graph: DepartmentPipelineDraftGraph;
    }) => Promise<DepartmentPipelineEditorView>;
    readonly publishPipeline: (input: {
      readonly departmentId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentPipelineEditorView>;
    readonly runs: (
      projectId?: string,
    ) => Promise<readonly DepartmentRunView[]>;
    readonly inspectRun: (runId: string) => Promise<DepartmentRunView>;
    readonly audit: (input?: {
      readonly runId?: string;
      readonly limit?: number;
    }) => Promise<readonly RuntimeAuditRecord[]>;
    readonly events: (input: {
      readonly afterSequence: number;
      readonly limit: number;
    }) => Promise<readonly RuntimeEventRecord[]>;
    readonly eventsForConsumer: (input: {
      readonly consumerId: string;
      readonly limit: number;
    }) => Promise<readonly RuntimeEventRecord[]>;
    readonly acknowledgeEvents: (input: {
      readonly consumerId: string;
      readonly sequence: number;
    }) => Promise<{ readonly acknowledged: true }>;
    readonly artifacts: (
      projectId: string,
    ) => Promise<readonly ArtifactVersionView[]>;
    readonly inspectArtifact: (
      versionId: string,
    ) => Promise<ArtifactLineageView>;
    readonly setArtifactStatus: (input: {
      readonly versionId: string;
      readonly expectedStatus: ArtifactVersionView["status"];
      readonly status: ArtifactVersionView["status"];
    }) => Promise<ArtifactVersionView>;
    readonly interactions: (
      projectId: string,
    ) => Promise<readonly InteractionView[]>;
    readonly inspectInteraction: (
      sessionId: string,
    ) => Promise<InteractionView>;
    readonly createInteractionSession: (input: {
      readonly projectId: string;
      readonly mode: "consultation" | "run-collaboration";
      readonly runId?: string;
      readonly nodeRunId?: string;
    }) => Promise<InteractionSessionView>;
    readonly closeInteractionSession: (
      sessionId: string,
    ) => Promise<InteractionSessionView>;
    readonly addInteractionParticipant: (input: {
      readonly sessionId: string;
      readonly participantType: "human" | "ai-member" | "system";
      readonly participantRef: string;
      readonly role: string;
    }) => Promise<SessionParticipantView>;
    readonly addInteractionMessage: (input: {
      readonly sessionId: string;
      readonly participantId: string;
      readonly kind: "text" | "tool" | "status";
      readonly content: string;
    }) => Promise<SessionMessageView>;
    readonly promptInteraction: (input: {
      readonly sessionId: string;
      readonly participantId: string;
      readonly content: string;
    }) => Promise<InteractionTurnView>;
    readonly requestPermission: (input: {
      readonly sessionId: string;
      readonly scope: string;
      readonly expiresAt?: string;
    }) => Promise<PermissionRequestView>;
    readonly decidePermission: (input: {
      readonly permissionId: string;
      readonly expectedStatus: "pending";
      readonly decision: "approved" | "denied";
    }) => Promise<PermissionRequestView>;
    readonly agUiEvents: (input: {
      readonly afterSequence: number;
      readonly limit: number;
    }) => Promise<AgUiReplayView>;
    readonly memoryCandidates: (
      projectId: string,
    ) => Promise<readonly MemoryCandidateView[]>;
    readonly memoryRecords: (
      projectId: string,
    ) => Promise<readonly MemoryRecordView[]>;
    readonly createMemoryCandidate: (input: {
      readonly projectId: string;
      readonly scope: "project" | "ai-member";
      readonly aiMemberId?: string;
      readonly sourceSessionId?: string;
      readonly sourceRunId?: string;
      readonly sourceArtifactVersionId?: string;
      readonly summary: string;
    }) => Promise<MemoryCandidateView>;
    readonly reviewMemoryCandidate: (input: {
      readonly candidateId: string;
      readonly expectedStatus: "pending";
      readonly decision: "approved" | "discarded";
    }) => Promise<MemoryReviewView>;
    readonly runtimeDiagnostics: () => Promise<RuntimeDiagnosticsView>;
    readonly backupRuntime: () => Promise<RuntimeBackupView>;
    readonly compactRuntimeEvents: (input: {
      readonly retainLast: number;
    }) => Promise<{ readonly deleted: number; readonly retained: number }>;
    readonly startRun: (input: {
      readonly projectId: string;
      readonly departmentId: string;
      readonly agentOverrideId?: string;
    }) => Promise<DepartmentRunView>;
    readonly forkRun: (input: {
      readonly runId: string;
      readonly snapshotRevisionId: string;
      readonly fromNodeRunId: string;
      readonly mode?: "replay" | "reconfigure";
    }) => Promise<DepartmentRunView>;
    readonly executeReady: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentRunView>;
    readonly pauseRun: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentRunView>;
    readonly resumeRun: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentRunView>;
    readonly cancelRun: (input: {
      readonly runId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentRunView>;
    readonly recoverRun: (input: {
      readonly runId: string;
      readonly nodeRunId: string;
      readonly expectedRevision: number;
      readonly override: {
        readonly providerRef?: string;
        readonly model?: string;
        readonly sandboxRef?: string;
        readonly timeoutSeconds?: number;
        readonly maxIterations?: number;
        readonly maxTokens?: number | null;
        readonly secretReferenceIds?: readonly string[];
      };
    }) => Promise<DepartmentRunView>;
    readonly decideApproval: (input: {
      readonly runId: string;
      readonly nodeRunId: string;
      readonly expectedRevision: number;
      readonly decision: "approve" | "request-changes" | "reject";
      readonly feedback?: string;
    }) => Promise<DepartmentRunView>;
    readonly retryApproval: (input: {
      readonly runId: string;
      readonly nodeRunId: string;
      readonly expectedRevision: number;
    }) => Promise<DepartmentRunView>;
    readonly retryNode: (input: {
      readonly runId: string;
      readonly nodeRunId: string;
      readonly expectedRevision: number;
      readonly feedback?: string;
    }) => Promise<DepartmentRunView>;
  };
}

export interface SandcastleBridgeOptions {
  readonly onPort?: (
    listener: (attachment: RuntimeEventPortAttachment) => void,
  ) => void;
}

interface ActiveEventStream {
  readonly handle: RuntimeSubscriptionHandle;
  readonly port: RuntimeEventPort;
  readonly onFrame: (frame: RuntimeEventFrame) => void | Promise<void>;
  accepting: boolean;
  callbackBarrier: Promise<void>;
}

let fallbackRequestCounter = 0;
const newRequestId = (): string => {
  const cryptoApi = globalThis.crypto as unknown as {
    readonly randomUUID?: () => string;
    readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
  };
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  fallbackRequestCounter += 1;
  return `renderer-${Date.now().toString(36)}-${fallbackRequestCounter.toString(36)}`;
};

export const createSandcastleBridge = (
  invoke: (channel: string, payload?: unknown) => Promise<unknown>,
  options: SandcastleBridgeOptions = {},
): SandcastleBridge => {
  const pendingPorts = new Map<
    string,
    (attachment: RuntimeEventPortAttachment) => void
  >();
  let activeEventStream: ActiveEventStream | null = null;

  options.onPort?.((attachment) => {
    pendingPorts.get(attachment.streamRequestId)?.(attachment);
  });

  const query = async <Query extends CompanyQuery>(
    nextQuery: Query,
  ): Promise<QueryResult<CompanyQueryResult<Query>>> => {
    const request = RuntimeTunnelRequestSchema.parse({
      schemaVersion: 1,
      operation: "query",
      requestId: newRequestId(),
      query: nextQuery,
    });
    const result = QueryResultSchema.parse(
      await invoke(RUNTIME_TUNNEL_CHANNEL, request),
    );
    const view =
      nextQuery.type === "project.inspect"
        ? ProjectEditorViewSchema.parse(result.view)
        : nextQuery.type === "applications.list"
          ? ApplicationViewSchema.array().parse(result.view)
          : nextQuery.type === "product.discovery.inspect"
            ? ProductDiscoveryViewSchema.parse(result.view)
            : nextQuery.type === "product-review.inspect"
              ? ProductReviewStateViewSchema.parse(result.view)
              : nextQuery.type === "technical-review.inspect"
                ? TechnicalReviewStateViewSchema.parse(result.view)
                : nextQuery.type === "review.topic.inspect"
                  ? ReviewTopicViewSchema.parse(result.view)
                  : nextQuery.type === "review.topics.list"
                    ? ReviewTopicViewSchema.array().parse(result.view)
                    : result.view;
    return {
      view: view as CompanyQueryResult<Query>,
      asOfSequence: result.asOfSequence,
      ...(result.viewSyncToken ? { viewSyncToken: result.viewSyncToken } : {}),
    };
  };

  const execute = async <Command extends EnvelopeCommand>(input: {
    readonly commandId: string;
    readonly expectedRevision?: number;
    readonly command: Command;
  }): Promise<CommandResult<EnvelopeCommandResult<Command>>> => {
    const request = RuntimeTunnelRequestSchema.parse({
      schemaVersion: 1,
      operation: "execute",
      commandId: input.commandId,
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
      command: input.command,
    });
    const result = CommandResultSchema.parse(
      await invoke(RUNTIME_TUNNEL_CHANNEL, request),
    );
    if (result.status === "rejected") {
      return result as CommandResult<EnvelopeCommandResult<Command>>;
    }
    const value =
      input.command.type === "project.update"
        ? ProjectEditorViewSchema.parse(result.value)
        : input.command.type === "product.proposal.revise" ||
            input.command.type ===
              "product.proposal.mark-awaiting-confirmation" ||
            input.command.type === "confirm-product-baseline" ||
            input.command.type === "fork-department-run"
          ? ProductDiscoveryViewSchema.parse(result.value)
          : input.command.type === "project-spec.revise" ||
              input.command.type === "product-review.start" ||
              input.command.type === "product-readiness.record" ||
              input.command.type === "product-gate.promote"
            ? ProductReviewStateViewSchema.parse(result.value)
            : input.command.type === "application.register"
              ? ApplicationViewSchema.parse(result.value)
              : input.command.type === "application-spec.revise" ||
                  input.command.type === "technical-baseline-proposal.revise" ||
                  input.command.type === "technical-review.start" ||
                  input.command.type === "technical-gate.promote"
                ? TechnicalReviewStateViewSchema.parse(result.value)
                : input.command.type.startsWith("review.")
                  ? ReviewTopicViewSchema.parse(result.value)
                  : input.command.type === "interaction.prompt"
                    ? InteractionTurnViewSchema.parse(result.value)
                    : z
                        .object({
                          acknowledged: z.literal(true),
                          subscriptionGeneration: z.number().int().positive(),
                          barrierSequence: z.number().int().nonnegative(),
                          auditId: z.string().trim().min(1),
                        })
                        .parse(result.value);
    return {
      status: "succeeded",
      value: value as EnvelopeCommandResult<Command>,
      effectIds: result.effectIds,
    };
  };

  const closeEventStream = async (
    input: RuntimeSubscriptionHandle,
  ): Promise<void> => {
    const stream = activeEventStream;
    if (
      !stream ||
      stream.handle.subscriptionId !== input.subscriptionId ||
      stream.handle.subscriptionGeneration !== input.subscriptionGeneration
    ) {
      return;
    }
    stream.accepting = false;
    activeEventStream = null;
    await stream.callbackBarrier;
    stream.port.close();
    const request = RuntimeTunnelRequestSchema.parse({
      schemaVersion: 1,
      operation: "close-event-stream",
      subscriptionId: input.subscriptionId,
      subscriptionGeneration: input.subscriptionGeneration,
    });
    await invoke(RUNTIME_TUNNEL_CHANNEL, request);
  };

  const openEventStream = async (
    onFrame: (frame: RuntimeEventFrame) => void | Promise<void>,
  ): Promise<RuntimeSubscriptionHandle> => {
    if (activeEventStream) {
      await closeEventStream(activeEventStream.handle);
    }
    const streamRequestId = newRequestId();
    const attachmentPromise = new Promise<RuntimeEventPortAttachment>(
      (resolve) => {
        pendingPorts.set(streamRequestId, resolve);
      },
    );
    const request = RuntimeTunnelRequestSchema.parse({
      schemaVersion: 1,
      operation: "open-event-stream",
      streamRequestId,
    });
    let handle: RuntimeSubscriptionHandle;
    let attachment: RuntimeEventPortAttachment;
    try {
      [handle, attachment] = await Promise.all([
        invoke(RUNTIME_TUNNEL_CHANNEL, request).then((value) =>
          RuntimeSubscriptionHandleSchema.parse(value),
        ),
        attachmentPromise,
      ]);
    } finally {
      pendingPorts.delete(streamRequestId);
    }
    const stream: ActiveEventStream = {
      handle,
      port: attachment.port,
      onFrame,
      accepting: true,
      callbackBarrier: Promise.resolve(),
    };
    activeEventStream = stream;
    stream.port.onmessage = (message) => {
      if (!stream.accepting || activeEventStream !== stream) return;
      const frame = RuntimeEventFrameSchema.safeParse(message.data);
      if (
        !frame.success ||
        frame.data.subscriptionId !== stream.handle.subscriptionId ||
        frame.data.subscriptionGeneration !==
          stream.handle.subscriptionGeneration
      ) {
        return;
      }
      stream.callbackBarrier = stream.callbackBarrier
        .then(async () => {
          if (!stream.accepting || activeEventStream !== stream) return;
          await stream.onFrame(frame.data);
          if (!stream.accepting || activeEventStream !== stream) return;
          if (
            frame.data.value.kind === "control" &&
            frame.data.value.control.type === "runtime.disconnected"
          ) {
            stream.accepting = false;
            activeEventStream = null;
            stream.port.close();
            return;
          }
          stream.port.postMessage({
            schemaVersion: 1,
            type: "credit",
            subscriptionId: stream.handle.subscriptionId,
            subscriptionGeneration: stream.handle.subscriptionGeneration,
            credits: 1,
          });
        })
        .catch(() => {
          if (activeEventStream === stream) activeEventStream = null;
          stream.accepting = false;
          stream.port.close();
          void invoke(
            RUNTIME_TUNNEL_CHANNEL,
            RuntimeTunnelRequestSchema.parse({
              schemaVersion: 1,
              operation: "close-event-stream",
              subscriptionId: stream.handle.subscriptionId,
              subscriptionGeneration: stream.handle.subscriptionGeneration,
            }),
          ).catch(() => undefined);
        });
    };
    stream.port.start();
    stream.port.postMessage({
      schemaVersion: 1,
      type: "credit",
      subscriptionId: stream.handle.subscriptionId,
      subscriptionGeneration: stream.handle.subscriptionGeneration,
      credits: 1,
    });
    return handle;
  };

  return {
    execute,
    query,
    openEventStream,
    closeEventStream,
    runtime: {
      health: async () =>
        RuntimeHealthSchema.parse(await invoke(RUNTIME_HEALTH_CHANNEL)),
      inspectAgentCatalog: async () =>
        AgentCatalogViewSchema.parse(
          await invoke(AGENT_CATALOG_INSPECT_CHANNEL),
        ),
      discoverAgents: async () =>
        AgentCatalogViewSchema.parse(
          await invokeRuntimeCommand(invoke, AGENT_CATALOG_DISCOVER_CHANNEL),
        ),
      testAgent: async (agentId) =>
        AgentTestResultSchema.parse(
          await invokeRuntimeCommand(invoke, AGENT_TEST_CHANNEL, { agentId }),
        ),
      inspectSkillCatalog: async () =>
        SkillCatalogViewSchema.parse(
          await invoke(SKILL_DISCOVERY_INSPECT_CHANNEL),
        ),
      discoverSkills: async (directories = []) =>
        SkillCatalogViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_DISCOVERY_REFRESH_CHANNEL, {
            directories: [...directories],
          }),
        ),
      enableSkill: async (skillId) =>
        SkillCatalogViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_DISCOVERY_ENABLE_CHANNEL, {
            skillId,
          }),
        ),
      archiveDiscoveredSkill: async (skillId) =>
        SkillCatalogViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_DISCOVERY_ARCHIVE_CHANNEL, {
            skillId,
          }),
        ),
      overview: async () =>
        CompanyOverviewSchema.parse(await invoke(COMPANY_OVERVIEW_CHANNEL)),
      projects: async () =>
        CompanyProjectSchema.array().parse(await invoke(PROJECTS_LIST_CHANNEL)),
      createProject: async (input) =>
        CompanyProjectSchema.parse(
          await invokeRuntimeCommand(invoke, PROJECT_CREATE_CHANNEL, input),
        ),
      inspectProject: async (projectId) =>
        (await query({ type: "project.inspect", projectId })).view,
      applications: async (projectId) =>
        (await query({ type: "applications.list", projectId })).view,
      inspectProductDiscovery: async (projectId) =>
        (await query({ type: "product.discovery.inspect", projectId })).view,
      inspectProductReview: async (runId) =>
        (await query({ type: "product-review.inspect", runId })).view,
      executeProductReviewCommand: async (input) => {
        const result = await execute(input);
        if (result.status === "rejected") {
          throw runtimeBridgeError(result.error.code, result.error.message);
        }
        return ProductReviewStateViewSchema.parse(result.value);
      },
      inspectTechnicalReview: async (runId) =>
        (await query({ type: "technical-review.inspect", runId })).view,
      executeTechnicalReviewCommand: async (input) => {
        const result = await execute(input);
        if (result.status === "rejected") {
          throw runtimeBridgeError(result.error.code, result.error.message);
        }
        return TechnicalReviewStateViewSchema.parse(result.value);
      },
      reviewTopics: async (input) =>
        (await query({ type: "review.topics.list", ...input })).view,
      inspectReviewTopic: async (topicId) =>
        (await query({ type: "review.topic.inspect", topicId })).view,
      executeReviewCommand: async (input) => {
        const result = await execute(input);
        if (result.status === "rejected") {
          throw runtimeBridgeError(result.error.code, result.error.message);
        }
        return ReviewTopicViewSchema.parse(result.value);
      },
      updateProject: async (input) => {
        const result = await execute({
          commandId: newRequestId(),
          expectedRevision: input.expectedRevision,
          command: {
            type: "project.update",
            projectId: input.projectId,
            name: input.name,
            goal: input.goal,
            sharedContext: input.sharedContext,
            repositoryReferences: [...input.repositoryReferences],
          },
        });
        if (result.status === "rejected") {
          throw runtimeBridgeError(result.error.code, result.error.message);
        }
        return result.value;
      },
      archiveProject: async (input) =>
        ProjectEditorViewSchema.parse(
          await invokeRuntimeCommand(invoke, PROJECT_ARCHIVE_CHANNEL, input),
        ),
      departments: async () =>
        CompanyDepartmentSchema.array().parse(
          await invoke(DEPARTMENTS_LIST_CHANNEL),
        ),
      inspectDepartment: async (departmentId) =>
        DepartmentInspectSchema.parse(
          await invoke(DEPARTMENT_INSPECT_CHANNEL, departmentId),
        ),
      createDepartment: async (input) =>
        CompanyDepartmentSchema.parse(
          await invokeRuntimeCommand(invoke, DEPARTMENT_CREATE_CHANNEL, input),
        ),
      updateDepartment: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, DEPARTMENT_UPDATE_CHANNEL, input),
        ),
      archiveDepartment: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, DEPARTMENT_ARCHIVE_CHANNEL, input),
        ),
      copyDepartment: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, DEPARTMENT_COPY_CHANNEL, input),
        ),
      createPosition: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, POSITION_CREATE_CHANNEL, input),
        ),
      updatePosition: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, POSITION_UPDATE_CHANNEL, input),
        ),
      archivePosition: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(invoke, POSITION_ARCHIVE_CHANNEL, input),
        ),
      configurePosition: async (input) =>
        PositionConfigurationResultSchema.parse(
          await invokeRuntimeCommand(invoke, POSITION_CONFIGURE_CHANNEL, input),
        ),
      createSecretReference: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            SECRET_REFERENCE_CREATE_CHANNEL,
            input,
          ),
        ),
      archiveSecretReference: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            SECRET_REFERENCE_ARCHIVE_CHANNEL,
            input,
          ),
        ),
      saveExecutionProfile: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            EXECUTION_PROFILE_SAVE_CHANNEL,
            input,
          ),
        ),
      archiveExecutionProfile: async (input) =>
        DepartmentInspectSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            EXECUTION_PROFILE_ARCHIVE_CHANNEL,
            input,
          ),
        ),
      inspectSkillConfiguration: async (departmentId) =>
        SkillConfigurationViewSchema.parse(
          await invoke(SKILL_CONFIGURATION_INSPECT_CHANNEL, departmentId),
        ),
      saveSkill: async (input) =>
        SkillConfigurationViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_CATALOG_SAVE_CHANNEL, input),
        ),
      archiveSkill: async (input) =>
        SkillConfigurationViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            SKILL_CATALOG_ARCHIVE_CHANNEL,
            input,
          ),
        ),
      setPositionSkills: async (input) =>
        SkillConfigurationViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            POSITION_SKILLS_SET_CHANNEL,
            input,
          ),
        ),
      saveSkillFlow: async (input) =>
        SkillConfigurationViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_FLOW_SAVE_CHANNEL, input),
        ),
      archiveSkillFlow: async (input) =>
        SkillConfigurationViewSchema.parse(
          await invokeRuntimeCommand(invoke, SKILL_FLOW_ARCHIVE_CHANNEL, input),
        ),
      inspectPipeline: async (departmentId) =>
        DepartmentPipelineEditorViewSchema.parse(
          await invoke(DEPARTMENT_PIPELINE_INSPECT_CHANNEL, departmentId),
        ),
      validatePipeline: async (input) => {
        const parsed = {
          ...input,
          graph: DepartmentPipelineDraftGraphSchema.parse(input.graph),
        };
        return PipelineValidationResultSchema.parse(
          await invoke(DEPARTMENT_PIPELINE_VALIDATE_CHANNEL, parsed),
        );
      },
      savePipelineDraft: async (input) => {
        const parsed = {
          ...input,
          graph: DepartmentPipelineDraftGraphSchema.parse(input.graph),
        };
        return DepartmentPipelineEditorViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
            parsed,
          ),
        );
      },
      publishPipeline: async (input) =>
        DepartmentPipelineEditorViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
            input,
          ),
        ),
      runs: async (projectId) =>
        DepartmentRunViewSchema.array().parse(
          await invoke(
            RUNS_LIST_CHANNEL,
            projectId === undefined ? undefined : { projectId },
          ),
        ),
      inspectRun: async (runId) =>
        DepartmentRunViewSchema.parse(await invoke(RUN_INSPECT_CHANNEL, runId)),
      audit: async (input = {}) =>
        RuntimeAuditRecordSchema.array().parse(
          await invoke(RUNTIME_AUDIT_CHANNEL, input),
        ),
      events: async (input) =>
        RuntimeEventRecordSchema.array().parse(
          await invoke(RUNTIME_EVENTS_CHANNEL, input),
        ),
      eventsForConsumer: async (input) =>
        RuntimeEventRecordSchema.array().parse(
          await invoke(RUNTIME_EVENTS_CONSUMER_CHANNEL, input),
        ),
      acknowledgeEvents: async (input) =>
        (await invokeRuntimeCommand(
          invoke,
          RUNTIME_EVENTS_ACK_CHANNEL,
          input,
        )) as { readonly acknowledged: true },
      artifacts: async (projectId) =>
        ArtifactVersionViewSchema.array().parse(
          await invoke(ARTIFACTS_LIST_CHANNEL, projectId),
        ),
      inspectArtifact: async (versionId) =>
        ArtifactLineageViewSchema.parse(
          await invoke(ARTIFACT_INSPECT_CHANNEL, versionId),
        ),
      setArtifactStatus: async (input) =>
        ArtifactVersionViewSchema.parse(
          await invokeRuntimeCommand(invoke, ARTIFACT_STATUS_CHANNEL, input),
        ),
      interactions: async (projectId) =>
        InteractionViewSchema.array().parse(
          await invoke(INTERACTIONS_LIST_CHANNEL, projectId),
        ),
      inspectInteraction: async (sessionId) =>
        InteractionViewSchema.parse(
          await invoke(INTERACTION_INSPECT_CHANNEL, sessionId),
        ),
      createInteractionSession: async (input) =>
        InteractionSessionViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            INTERACTION_SESSION_CREATE_CHANNEL,
            input,
          ),
        ),
      closeInteractionSession: async (sessionId) =>
        InteractionSessionViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            INTERACTION_SESSION_CLOSE_CHANNEL,
            {
              sessionId,
            },
          ),
        ),
      addInteractionParticipant: async (input) =>
        SessionParticipantViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            INTERACTION_PARTICIPANT_ADD_CHANNEL,
            input,
          ),
        ),
      addInteractionMessage: async (input) =>
        SessionMessageViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            INTERACTION_MESSAGE_ADD_CHANNEL,
            input,
          ),
        ),
      promptInteraction: async (input) => {
        const result = await execute({
          commandId: newRequestId(),
          command: { type: "interaction.prompt", ...input },
        });
        if (result.status === "rejected") {
          throw runtimeBridgeError(result.error.code, result.error.message);
        }
        return InteractionTurnViewSchema.parse(result.value);
      },
      requestPermission: async (input) =>
        PermissionRequestViewSchema.parse(
          await invokeRuntimeCommand(invoke, PERMISSION_REQUEST_CHANNEL, input),
        ),
      decidePermission: async (input) =>
        PermissionRequestViewSchema.parse(
          await invokeRuntimeCommand(invoke, PERMISSION_DECIDE_CHANNEL, input),
        ),
      agUiEvents: async (input) =>
        AgUiReplayViewSchema.parse(await invoke(AG_UI_EVENTS_CHANNEL, input)),
      memoryCandidates: async (projectId) =>
        MemoryCandidateViewSchema.array().parse(
          await invoke(MEMORY_CANDIDATES_LIST_CHANNEL, projectId),
        ),
      memoryRecords: async (projectId) =>
        MemoryRecordViewSchema.array().parse(
          await invoke(MEMORY_RECORDS_LIST_CHANNEL, projectId),
        ),
      createMemoryCandidate: async (input) =>
        MemoryCandidateViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            MEMORY_CANDIDATE_CREATE_CHANNEL,
            input,
          ),
        ),
      reviewMemoryCandidate: async (input) =>
        MemoryReviewViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            MEMORY_CANDIDATE_REVIEW_CHANNEL,
            input,
          ),
        ),
      runtimeDiagnostics: async () =>
        RuntimeDiagnosticsViewSchema.parse(
          await invoke(RUNTIME_DIAGNOSTICS_CHANNEL),
        ),
      backupRuntime: async () =>
        RuntimeBackupViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUNTIME_BACKUP_CHANNEL, {}),
        ),
      compactRuntimeEvents: async (input) =>
        (await invokeRuntimeCommand(
          invoke,
          RUNTIME_EVENTS_COMPACT_CHANNEL,
          input,
        )) as { readonly deleted: number; readonly retained: number },
      startRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_START_CHANNEL, input),
        ),
      forkRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_FORK_CHANNEL, input),
        ),
      executeReady: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_EXECUTE_READY_CHANNEL, input),
        ),
      pauseRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_PAUSE_CHANNEL, input),
        ),
      resumeRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_RESUME_CHANNEL, input),
        ),
      cancelRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_CANCEL_CHANNEL, input),
        ),
      recoverRun: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_RECOVER_CHANNEL, {
            ...input,
            override: {
              ...input.override,
              ...(input.override.secretReferenceIds
                ? { secretReferenceIds: [...input.override.secretReferenceIds] }
                : {}),
            },
          }),
        ),
      decideApproval: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(
            invoke,
            RUN_APPROVAL_DECIDE_CHANNEL,
            input,
          ),
        ),
      retryApproval: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_APPROVAL_RETRY_CHANNEL, input),
        ),
      retryNode: async (input) =>
        DepartmentRunViewSchema.parse(
          await invokeRuntimeCommand(invoke, RUN_NODE_RETRY_CHANNEL, input),
        ),
    },
  };
};
