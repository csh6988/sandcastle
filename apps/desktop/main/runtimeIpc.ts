import {
  COMPANY_OVERVIEW_CHANNEL,
  ARTIFACTS_LIST_CHANNEL,
  ARTIFACT_INSPECT_CHANNEL,
  ARTIFACT_STATUS_CHANNEL,
  INTERACTIONS_LIST_CHANNEL,
  INTERACTION_INSPECT_CHANNEL,
  INTERACTION_SESSION_CREATE_CHANNEL,
  INTERACTION_SESSION_CLOSE_CHANNEL,
  INTERACTION_PARTICIPANT_ADD_CHANNEL,
  INTERACTION_MESSAGE_ADD_CHANNEL,
  INTERACTION_PROMPT_CHANNEL,
  PERMISSION_REQUEST_CHANNEL,
  PERMISSION_DECIDE_CHANNEL,
  AG_UI_EVENTS_CHANNEL,
  MEMORY_CANDIDATES_LIST_CHANNEL,
  MEMORY_RECORDS_LIST_CHANNEL,
  MEMORY_CANDIDATE_CREATE_CHANNEL,
  MEMORY_CANDIDATE_REVIEW_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_BACKUP_CHANNEL,
  RUNTIME_EVENTS_COMPACT_CHANNEL,
  DEPARTMENT_ARCHIVE_CHANNEL,
  DEPARTMENT_COPY_CHANNEL,
  DEPARTMENT_CREATE_CHANNEL,
  DEPARTMENT_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
  DEPARTMENT_PIPELINE_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
  DEPARTMENT_PIPELINE_VALIDATE_CHANNEL,
  DEPARTMENT_UPDATE_CHANNEL,
  DEPARTMENTS_LIST_CHANNEL,
  POSITION_UPDATE_CHANNEL,
  POSITION_CREATE_CHANNEL,
  POSITION_ARCHIVE_CHANNEL,
  POSITION_CONFIGURE_CHANNEL,
  SECRET_REFERENCE_CREATE_CHANNEL,
  SECRET_REFERENCE_ARCHIVE_CHANNEL,
  EXECUTION_PROFILE_SAVE_CHANNEL,
  EXECUTION_PROFILE_ARCHIVE_CHANNEL,
  PROJECT_CREATE_CHANNEL,
  PROJECT_ARCHIVE_CHANNEL,
  PROJECT_INSPECT_CHANNEL,
  PROJECT_UPDATE_CHANNEL,
  PROJECTS_LIST_CHANNEL,
  RUNTIME_HEALTH_CHANNEL,
  AGENT_CATALOG_INSPECT_CHANNEL,
  AGENT_CATALOG_DISCOVER_CHANNEL,
  AGENT_TEST_CHANNEL,
  SKILL_DISCOVERY_INSPECT_CHANNEL,
  SKILL_DISCOVERY_REFRESH_CHANNEL,
  SKILL_DISCOVERY_ENABLE_CHANNEL,
  SKILL_DISCOVERY_ARCHIVE_CHANNEL,
  RUNTIME_AUDIT_CHANNEL,
  RUNTIME_EVENTS_CHANNEL,
  RUNTIME_EVENTS_CONSUMER_CHANNEL,
  RUNTIME_EVENTS_ACK_CHANNEL,
  RUNTIME_TUNNEL_CHANNEL,
  RUNTIME_EVENT_PORT_CHANNEL,
  RuntimeEventFrameSchema,
  RuntimeTunnelRequestSchema,
  type RuntimeEventPort,
  RUNS_LIST_CHANNEL,
  RUN_APPROVAL_DECIDE_CHANNEL,
  RUN_APPROVAL_RETRY_CHANNEL,
  RUN_CANCEL_CHANNEL,
  RUN_NODE_RETRY_CHANNEL,
  RUN_EXECUTE_READY_CHANNEL,
  RUN_INSPECT_CHANNEL,
  RUN_PAUSE_CHANNEL,
  RUN_RESUME_CHANNEL,
  RUN_RECOVER_CHANNEL,
  RUN_START_CHANNEL,
  RUN_FORK_CHANNEL,
  SKILL_CATALOG_ARCHIVE_CHANNEL,
  SKILL_CATALOG_SAVE_CHANNEL,
  SKILL_CONFIGURATION_INSPECT_CHANNEL,
  SKILL_FLOW_ARCHIVE_CHANNEL,
  SKILL_FLOW_SAVE_CHANNEL,
  POSITION_SKILLS_SET_CHANNEL,
  type SandcastleBridge,
} from "../preload/bridge.js";
import {
  CompanyCommandSchema,
  DepartmentPipelineDraftGraphSchema,
  type ActorRef,
  type CompanyQuery,
  type EnvelopeCommand,
  type QueryEnvelope,
  type CommandEnvelope,
} from "../runtime/interface.js";
import { z } from "zod";

interface RuntimeHealthSource {
  queryEnvelope?: (envelope: QueryEnvelope<CompanyQuery>) => Promise<unknown>;
  executeEnvelope?: (
    envelope: CommandEnvelope<EnvelopeCommand>,
  ) => Promise<unknown>;
  openSubscription?: () => Promise<{
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
    readonly barrierSequence: number;
  }>;
  readSubscription?: (input: {
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
    readonly limit: number;
  }) => Promise<{
    readonly events: readonly unknown[];
    readonly nextSequence: number;
    readonly hasMore: boolean;
  }>;
  closeSubscription?: (input: {
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
  }) => Promise<void>;
  health(): ReturnType<SandcastleBridge["runtime"]["health"]>;
  inspectAgentCatalog: SandcastleBridge["runtime"]["inspectAgentCatalog"];
  discoverAgents: SandcastleBridge["runtime"]["discoverAgents"];
  testAgent: SandcastleBridge["runtime"]["testAgent"];
  inspectSkillCatalog: SandcastleBridge["runtime"]["inspectSkillCatalog"];
  discoverSkills: SandcastleBridge["runtime"]["discoverSkills"];
  enableSkill: SandcastleBridge["runtime"]["enableSkill"];
  archiveDiscoveredSkill: SandcastleBridge["runtime"]["archiveDiscoveredSkill"];
  overview(): ReturnType<SandcastleBridge["runtime"]["overview"]>;
  projects(): ReturnType<SandcastleBridge["runtime"]["projects"]>;
  createProject: SandcastleBridge["runtime"]["createProject"];
  inspectProject: SandcastleBridge["runtime"]["inspectProject"];
  updateProject: SandcastleBridge["runtime"]["updateProject"];
  archiveProject: SandcastleBridge["runtime"]["archiveProject"];
  departments(): ReturnType<SandcastleBridge["runtime"]["departments"]>;
  inspectDepartment: SandcastleBridge["runtime"]["inspectDepartment"];
  createDepartment: SandcastleBridge["runtime"]["createDepartment"];
  updateDepartment: SandcastleBridge["runtime"]["updateDepartment"];
  archiveDepartment: SandcastleBridge["runtime"]["archiveDepartment"];
  copyDepartment: SandcastleBridge["runtime"]["copyDepartment"];
  createPosition: SandcastleBridge["runtime"]["createPosition"];
  updatePosition: SandcastleBridge["runtime"]["updatePosition"];
  archivePosition: SandcastleBridge["runtime"]["archivePosition"];
  configurePosition: SandcastleBridge["runtime"]["configurePosition"];
  createSecretReference: SandcastleBridge["runtime"]["createSecretReference"];
  archiveSecretReference: SandcastleBridge["runtime"]["archiveSecretReference"];
  saveExecutionProfile: SandcastleBridge["runtime"]["saveExecutionProfile"];
  archiveExecutionProfile: SandcastleBridge["runtime"]["archiveExecutionProfile"];
  inspectSkillConfiguration: SandcastleBridge["runtime"]["inspectSkillConfiguration"];
  saveSkill: SandcastleBridge["runtime"]["saveSkill"];
  archiveSkill: SandcastleBridge["runtime"]["archiveSkill"];
  setPositionSkills: SandcastleBridge["runtime"]["setPositionSkills"];
  saveSkillFlow: SandcastleBridge["runtime"]["saveSkillFlow"];
  archiveSkillFlow: SandcastleBridge["runtime"]["archiveSkillFlow"];
  inspectPipeline: SandcastleBridge["runtime"]["inspectPipeline"];
  validatePipeline: SandcastleBridge["runtime"]["validatePipeline"];
  savePipelineDraft: SandcastleBridge["runtime"]["savePipelineDraft"];
  publishPipeline: SandcastleBridge["runtime"]["publishPipeline"];
  runs: SandcastleBridge["runtime"]["runs"];
  inspectRun: SandcastleBridge["runtime"]["inspectRun"];
  startRun: SandcastleBridge["runtime"]["startRun"];
  forkRun: SandcastleBridge["runtime"]["forkRun"];
  executeReady: SandcastleBridge["runtime"]["executeReady"];
  pauseRun: SandcastleBridge["runtime"]["pauseRun"];
  resumeRun: SandcastleBridge["runtime"]["resumeRun"];
  cancelRun: SandcastleBridge["runtime"]["cancelRun"];
  recoverRun: SandcastleBridge["runtime"]["recoverRun"];
  decideApproval: SandcastleBridge["runtime"]["decideApproval"];
  retryApproval: SandcastleBridge["runtime"]["retryApproval"];
  retryNode: SandcastleBridge["runtime"]["retryNode"];
  audit: SandcastleBridge["runtime"]["audit"];
  events: SandcastleBridge["runtime"]["events"];
  eventsForConsumer: SandcastleBridge["runtime"]["eventsForConsumer"];
  acknowledgeEvents: SandcastleBridge["runtime"]["acknowledgeEvents"];
  artifacts: SandcastleBridge["runtime"]["artifacts"];
  inspectArtifact: SandcastleBridge["runtime"]["inspectArtifact"];
  setArtifactStatus: SandcastleBridge["runtime"]["setArtifactStatus"];
  interactions: SandcastleBridge["runtime"]["interactions"];
  inspectInteraction: SandcastleBridge["runtime"]["inspectInteraction"];
  createInteractionSession: SandcastleBridge["runtime"]["createInteractionSession"];
  closeInteractionSession: SandcastleBridge["runtime"]["closeInteractionSession"];
  addInteractionParticipant: SandcastleBridge["runtime"]["addInteractionParticipant"];
  addInteractionMessage: SandcastleBridge["runtime"]["addInteractionMessage"];
  promptInteraction: SandcastleBridge["runtime"]["promptInteraction"];
  requestPermission: SandcastleBridge["runtime"]["requestPermission"];
  decidePermission: SandcastleBridge["runtime"]["decidePermission"];
  agUiEvents: SandcastleBridge["runtime"]["agUiEvents"];
  memoryCandidates: SandcastleBridge["runtime"]["memoryCandidates"];
  memoryRecords: SandcastleBridge["runtime"]["memoryRecords"];
  createMemoryCandidate: SandcastleBridge["runtime"]["createMemoryCandidate"];
  reviewMemoryCandidate: SandcastleBridge["runtime"]["reviewMemoryCandidate"];
  runtimeDiagnostics: SandcastleBridge["runtime"]["runtimeDiagnostics"];
  backupRuntime: SandcastleBridge["runtime"]["backupRuntime"];
  compactRuntimeEvents: SandcastleBridge["runtime"]["compactRuntimeEvents"];
}

export interface RuntimeIpcMain {
  handle(
    channel: string,
    handler: (...args: readonly unknown[]) => Promise<unknown> | unknown,
  ): void;
}

interface RuntimeIpcFrame {
  readonly url: string;
}

interface RuntimeIpcWebContents {
  readonly id: number;
  readonly mainFrame: RuntimeIpcFrame;
  readonly postMessage: (
    channel: string,
    message: unknown,
    ports?: readonly unknown[],
  ) => void;
}

interface RuntimeIpcPort extends RuntimeEventPort {
  on(
    event: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
}

export interface RuntimeIpcWindow {
  readonly webContents: RuntimeIpcWebContents;
}

export interface RuntimeIpcOptions {
  readonly getWindow?: () => RuntimeIpcWindow | null;
  readonly allowedOrigins?: readonly string[] | (() => readonly string[]);
  readonly createMessageChannel?: () => {
    readonly port1: RuntimeIpcPort;
    readonly port2: unknown;
  };
  readonly principal?: ActorRef;
  readonly consumerId?: string;
  readonly maxPayloadBytes?: number;
  readonly maxCredits?: number;
  readonly readBatchSize?: number;
}

export interface RuntimeIpcRegistration {
  readonly revokeWindow: () => void;
}

const RuntimeCreditSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("credit"),
    subscriptionId: z.string().trim().min(1),
    subscriptionGeneration: z.number().int().positive(),
    credits: z.number().int().positive(),
  })
  .strict();

type RuntimeEventFrameValue = z.infer<typeof RuntimeEventFrameSchema>["value"];

interface RuntimeEventStreamState {
  readonly webContentsId: number;
  readonly handle: {
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
    readonly barrierSequence: number;
  };
  readonly port: RuntimeIpcPort;
  credits: number;
  reading: boolean;
  cursorAccepted: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const exposeRuntimeErrorCode = async <Result>(
  operation: () => Promise<Result>,
): Promise<
  | Result
  | {
      readonly sandcastleRuntimeResult: true;
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly code: string;
        readonly message: string;
      };
    }
> => {
  try {
    return await operation();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (!code) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      sandcastleRuntimeResult: true,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "RuntimeError",
        code,
        message,
      },
    };
  }
};

export const registerRuntimeIpc = (
  ipcMain: RuntimeIpcMain,
  runtime: () => RuntimeHealthSource,
  options: RuntimeIpcOptions = {},
): RuntimeIpcRegistration => {
  const maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
  const maxCredits = options.maxCredits ?? 32;
  const readBatchSize = options.readBatchSize ?? 32;
  const streams = new Map<number, RuntimeEventStreamState>();

  const trustedPrincipal =
    options.principal ??
    ({
      type: "electron-main",
      id: "desktop-main",
      authenticatedBy: "ipc-token",
    } satisfies ActorRef);
  const trustedConsumerId = options.consumerId ?? "desktop-window-1";

  const allowedOrigins = (): readonly string[] =>
    typeof options.allowedOrigins === "function"
      ? options.allowedOrigins()
      : (options.allowedOrigins ?? []);

  const assertTrustedSender = (
    event: unknown,
    payload: unknown,
  ): RuntimeIpcWebContents => {
    const currentWindow = options.getWindow?.();
    if (!currentWindow)
      throw new Error("Runtime IPC has no active BrowserWindow.");
    if (
      typeof event !== "object" ||
      event === null ||
      !((event as { sender?: unknown }).sender === currentWindow.webContents)
    ) {
      throw new Error(
        "Runtime IPC sender is not the registered BrowserWindow.",
      );
    }
    const senderFrame = (event as { senderFrame?: unknown }).senderFrame;
    if (senderFrame !== currentWindow.webContents.mainFrame) {
      throw new Error("Runtime IPC only accepts the current main frame.");
    }
    const origin = new URL(currentWindow.webContents.mainFrame.url).origin;
    if (!allowedOrigins().includes(origin)) {
      throw new Error("Runtime IPC sender origin is not allowlisted.");
    }
    const encoded = JSON.stringify(payload);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, "utf8") > maxPayloadBytes
    ) {
      throw new Error("Runtime IPC payload exceeds the size limit.");
    }
    return currentWindow.webContents;
  };

  const sendFrame = (
    stream: RuntimeEventStreamState,
    value: RuntimeEventFrameValue,
    consumeCredit = true,
  ): void => {
    if (stream.closed || streams.get(stream.webContentsId) !== stream) return;
    if (consumeCredit && stream.credits <= 0) return;
    const frame = RuntimeEventFrameSchema.parse({
      subscriptionId: stream.handle.subscriptionId,
      subscriptionGeneration: stream.handle.subscriptionGeneration,
      barrierSequence: stream.handle.barrierSequence,
      value,
    });
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > maxPayloadBytes) {
      throw new Error("Runtime event frame exceeds the size limit.");
    }
    if (consumeCredit) stream.credits -= 1;
    stream.port.postMessage(frame);
  };

  const closeStream = (stream: RuntimeEventStreamState): void => {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.timer) clearTimeout(stream.timer);
    stream.port.close();
    if (streams.get(stream.webContentsId) === stream) {
      streams.delete(stream.webContentsId);
    }
  };

  const pump = async (stream: RuntimeEventStreamState): Promise<void> => {
    if (
      stream.closed ||
      stream.reading ||
      stream.credits <= 0 ||
      streams.get(stream.webContentsId) !== stream
    ) {
      return;
    }
    stream.reading = true;
    try {
      if (!stream.cursorAccepted) {
        sendFrame(stream, {
          kind: "control",
          control: {
            type: "cursor.accepted",
            barrierSequence: stream.handle.barrierSequence,
          },
        });
        stream.cursorAccepted = true;
      }
      if (stream.credits > 0) {
        const source = runtime();
        if (!source.readSubscription) {
          throw new Error("Runtime event subscription is unavailable.");
        }
        const batch = await source.readSubscription({
          subscriptionId: stream.handle.subscriptionId,
          subscriptionGeneration: stream.handle.subscriptionGeneration,
          limit: Math.min(stream.credits, readBatchSize),
        });
        for (const event of batch.events) {
          sendFrame(stream, { kind: "event", event: event as never });
          if (stream.closed) break;
        }
        if (!stream.closed && stream.credits > 0 && !batch.hasMore) {
          stream.timer = setTimeout(() => {
            stream.timer = null;
            void pump(stream);
          }, 50);
        }
      }
    } catch (error) {
      if (!stream.closed) {
        try {
          sendFrame(
            stream,
            {
              kind: "control",
              control: {
                type: "runtime.disconnected",
                code:
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  typeof error.code === "string"
                    ? error.code
                    : "COMPANY_RUNTIME_UNAVAILABLE",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            false,
          );
        } finally {
          closeStream(stream);
        }
      }
    } finally {
      stream.reading = false;
    }
  };

  const registerStreamCredit = (
    stream: RuntimeEventStreamState,
    value: unknown,
  ): void => {
    const credit = RuntimeCreditSchema.safeParse(value);
    if (!credit.success) return;
    if (
      credit.data.subscriptionId !== stream.handle.subscriptionId ||
      credit.data.subscriptionGeneration !==
        stream.handle.subscriptionGeneration
    ) {
      return;
    }
    stream.credits = Math.min(maxCredits, stream.credits + credit.data.credits);
    void pump(stream);
  };

  ipcMain.handle(RUNTIME_TUNNEL_CHANNEL, async (event, input: unknown) => {
    const webContents = assertTrustedSender(event, input);
    const request = RuntimeTunnelRequestSchema.parse(input);
    const source = runtime();
    if (request.operation === "query") {
      if (!source.queryEnvelope) {
        throw new Error("Typed Runtime query tunnel is unavailable.");
      }
      return source.queryEnvelope({
        schemaVersion: 1,
        requestId: request.requestId,
        principal: trustedPrincipal,
        consumerId: trustedConsumerId,
        query: request.query,
      });
    }
    if (request.operation === "execute") {
      if (!source.executeEnvelope) {
        throw new Error("Typed Runtime command tunnel is unavailable.");
      }
      return source.executeEnvelope({
        schemaVersion: 1,
        commandId: request.commandId,
        actor: trustedPrincipal,
        consumerId: trustedConsumerId,
        ...(request.expectedRevision === undefined
          ? {}
          : { expectedRevision: request.expectedRevision }),
        command: request.command,
      });
    }
    if (request.operation === "close-event-stream") {
      const stream = streams.get(webContents.id);
      if (
        !stream ||
        stream.handle.subscriptionId !== request.subscriptionId ||
        stream.handle.subscriptionGeneration !== request.subscriptionGeneration
      ) {
        return { closed: false, stale: true };
      }
      closeStream(stream);
      if (source.closeSubscription) {
        await source.closeSubscription({
          subscriptionId: request.subscriptionId,
          subscriptionGeneration: request.subscriptionGeneration,
        });
      }
      return { closed: true };
    }
    if (!source.openSubscription || !options.createMessageChannel) {
      throw new Error("MessagePort Runtime event stream is unavailable.");
    }
    const previous = streams.get(webContents.id);
    if (previous) closeStream(previous);
    const handle = await source.openSubscription();
    const channel = options.createMessageChannel();
    const stream: RuntimeEventStreamState = {
      webContentsId: webContents.id,
      handle,
      port: channel.port1,
      credits: 0,
      reading: false,
      cursorAccepted: false,
      closed: false,
      timer: null,
    };
    streams.set(webContents.id, stream);
    channel.port1.on("message", (message) =>
      registerStreamCredit(stream, message.data),
    );
    channel.port1.start();
    webContents.postMessage(
      RUNTIME_EVENT_PORT_CHANNEL,
      { streamRequestId: request.streamRequestId },
      [channel.port2],
    );
    return handle;
  });

  ipcMain.handle(RUNTIME_HEALTH_CHANNEL, () => runtime().health());
  ipcMain.handle(AGENT_CATALOG_INSPECT_CHANNEL, () =>
    runtime().inspectAgentCatalog(),
  );
  ipcMain.handle(AGENT_CATALOG_DISCOVER_CHANNEL, () =>
    exposeRuntimeErrorCode(() => runtime().discoverAgents()),
  );
  ipcMain.handle(AGENT_TEST_CHANNEL, (_event, input: unknown) => {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { agentId?: unknown }).agentId !== "string"
    ) {
      throw new Error("Invalid agent.test payload.");
    }
    return exposeRuntimeErrorCode(() =>
      runtime().testAgent((input as { agentId: string }).agentId),
    );
  });
  ipcMain.handle(SKILL_DISCOVERY_INSPECT_CHANNEL, () =>
    runtime().inspectSkillCatalog(),
  );
  ipcMain.handle(SKILL_DISCOVERY_REFRESH_CHANNEL, (_event, input: unknown) => {
    const directories =
      typeof input === "object" && input !== null && "directories" in input
        ? (input as { directories?: unknown }).directories
        : [];
    if (
      !Array.isArray(directories) ||
      directories.some((directory) => typeof directory !== "string")
    ) {
      throw new Error("Invalid skill.discovery.refresh payload.");
    }
    return exposeRuntimeErrorCode(() => runtime().discoverSkills(directories));
  });
  const registerSkillDiscoveryMutation = (
    channel: string,
    execute: (skillId: string) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (_event, input: unknown) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as { skillId?: unknown }).skillId !== "string"
      ) {
        throw new Error("Invalid Skill discovery mutation payload.");
      }
      return exposeRuntimeErrorCode(() =>
        execute((input as { skillId: string }).skillId),
      );
    });
  };
  registerSkillDiscoveryMutation(SKILL_DISCOVERY_ENABLE_CHANNEL, (skillId) =>
    runtime().enableSkill(skillId),
  );
  registerSkillDiscoveryMutation(SKILL_DISCOVERY_ARCHIVE_CHANNEL, (skillId) =>
    runtime().archiveDiscoveredSkill(skillId),
  );
  ipcMain.handle(COMPANY_OVERVIEW_CHANNEL, () => runtime().overview());
  ipcMain.handle(PROJECTS_LIST_CHANNEL, () => runtime().projects());
  ipcMain.handle(PROJECT_CREATE_CHANNEL, (_event, input: unknown) => {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { name?: unknown }).name !== "string" ||
      typeof (input as { goal?: unknown }).goal !== "string"
    ) {
      throw new Error("Invalid project.create payload.");
    }
    return runtime().createProject({
      name: (input as { name: string }).name,
      goal: (input as { goal: string }).goal,
    });
  });
  ipcMain.handle(PROJECT_INSPECT_CHANNEL, (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("Invalid project.inspect payload.");
    }
    return runtime().inspectProject(projectId);
  });
  ipcMain.handle(PROJECT_UPDATE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "project.update",
    });
    if (command.type !== "project.update") {
      throw new Error("Invalid project.update payload.");
    }
    const { type: _type, ...projectUpdate } = command;
    return exposeRuntimeErrorCode(() => runtime().updateProject(projectUpdate));
  });
  ipcMain.handle(PROJECT_ARCHIVE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "project.archive",
    });
    if (command.type !== "project.archive") {
      throw new Error("Invalid project.archive payload.");
    }
    const { type: _type, ...projectArchive } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().archiveProject(projectArchive),
    );
  });
  ipcMain.handle(DEPARTMENTS_LIST_CHANNEL, () => runtime().departments());
  ipcMain.handle(
    DEPARTMENT_INSPECT_CHANNEL,
    (_event, departmentId: unknown) => {
      if (typeof departmentId !== "string" || departmentId.trim() === "") {
        throw new Error("Invalid department.inspect payload.");
      }
      return runtime().inspectDepartment(departmentId);
    },
  );
  ipcMain.handle(DEPARTMENT_CREATE_CHANNEL, (_event, input: unknown) => {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { name?: unknown }).name !== "string"
    ) {
      throw new Error("Invalid department.create payload.");
    }
    return runtime().createDepartment({
      name: (input as { name: string }).name,
    });
  });
  ipcMain.handle(DEPARTMENT_UPDATE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "department.update",
    });
    if (command.type !== "department.update") {
      throw new Error("Invalid department.update payload.");
    }
    const { type: _type, ...departmentUpdate } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().updateDepartment(departmentUpdate),
    );
  });
  ipcMain.handle(DEPARTMENT_ARCHIVE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "department.archive",
    });
    if (command.type !== "department.archive") {
      throw new Error("Invalid department.archive payload.");
    }
    const { type: _type, ...departmentArchive } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().archiveDepartment(departmentArchive),
    );
  });
  ipcMain.handle(DEPARTMENT_COPY_CHANNEL, (_event, input: unknown) => {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { departmentId?: unknown }).departmentId !== "string" ||
      typeof (input as { name?: unknown }).name !== "string"
    ) {
      throw new Error("Invalid department.copy payload.");
    }
    return runtime().copyDepartment(
      input as Parameters<RuntimeHealthSource["copyDepartment"]>[0],
    );
  });
  ipcMain.handle(POSITION_UPDATE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "position.update",
    });
    if (command.type !== "position.update") {
      throw new Error("Invalid position.update payload.");
    }
    const { type: _type, ...positionUpdate } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().updatePosition(positionUpdate),
    );
  });
  const registerCatalogCommand = (
    channel: string,
    type:
      | "position.create"
      | "position.archive"
      | "secret-reference.create"
      | "secret-reference.archive"
      | "execution-profile.save"
      | "execution-profile.archive",
    execute: (command: never) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (_event, input: unknown) => {
      const command = CompanyCommandSchema.parse({
        ...(typeof input === "object" && input !== null ? input : {}),
        type,
      });
      return exposeRuntimeErrorCode(() => execute(command as never));
    });
  };
  registerCatalogCommand(
    POSITION_CREATE_CHANNEL,
    "position.create",
    (command) => runtime().createPosition(command),
  );
  registerCatalogCommand(
    POSITION_ARCHIVE_CHANNEL,
    "position.archive",
    (command) => runtime().archivePosition(command),
  );
  ipcMain.handle(POSITION_CONFIGURE_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "position.configure",
    });
    if (command.type !== "position.configure") {
      throw new Error("Invalid position.configure payload.");
    }
    const { type: _type, ...positionConfiguration } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().configurePosition(positionConfiguration),
    );
  });
  registerCatalogCommand(
    SECRET_REFERENCE_CREATE_CHANNEL,
    "secret-reference.create",
    (command) => runtime().createSecretReference(command),
  );
  registerCatalogCommand(
    SECRET_REFERENCE_ARCHIVE_CHANNEL,
    "secret-reference.archive",
    (command) => runtime().archiveSecretReference(command),
  );
  registerCatalogCommand(
    EXECUTION_PROFILE_SAVE_CHANNEL,
    "execution-profile.save",
    (command) => runtime().saveExecutionProfile(command),
  );
  registerCatalogCommand(
    EXECUTION_PROFILE_ARCHIVE_CHANNEL,
    "execution-profile.archive",
    (command) => runtime().archiveExecutionProfile(command),
  );
  ipcMain.handle(
    SKILL_CONFIGURATION_INSPECT_CHANNEL,
    (_event, departmentId: unknown) => {
      if (typeof departmentId !== "string" || departmentId.trim() === "") {
        throw new Error(
          "Invalid department.skill-configuration.inspect payload.",
        );
      }
      return runtime().inspectSkillConfiguration(departmentId);
    },
  );
  const registerSkillCommand = (
    channel: string,
    type:
      | "skill.catalog.save"
      | "skill.catalog.archive"
      | "position.skills.set"
      | "skill-flow.save"
      | "skill-flow.archive",
    execute: (command: never) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (_event, input: unknown) => {
      const command = CompanyCommandSchema.parse({
        ...(typeof input === "object" && input !== null ? input : {}),
        type,
      });
      return exposeRuntimeErrorCode(() => execute(command as never));
    });
  };
  registerSkillCommand(
    SKILL_CATALOG_SAVE_CHANNEL,
    "skill.catalog.save",
    (command) => runtime().saveSkill(command),
  );
  registerSkillCommand(
    SKILL_CATALOG_ARCHIVE_CHANNEL,
    "skill.catalog.archive",
    (command) => runtime().archiveSkill(command),
  );
  registerSkillCommand(
    POSITION_SKILLS_SET_CHANNEL,
    "position.skills.set",
    (command) => runtime().setPositionSkills(command),
  );
  registerSkillCommand(SKILL_FLOW_SAVE_CHANNEL, "skill-flow.save", (command) =>
    runtime().saveSkillFlow(command),
  );
  registerSkillCommand(
    SKILL_FLOW_ARCHIVE_CHANNEL,
    "skill-flow.archive",
    (command) => runtime().archiveSkillFlow(command),
  );
  ipcMain.handle(
    DEPARTMENT_PIPELINE_INSPECT_CHANNEL,
    (_event, departmentId: unknown) => {
      if (typeof departmentId !== "string" || departmentId.trim() === "") {
        throw new Error("Invalid department.pipeline.inspect payload.");
      }
      return runtime().inspectPipeline(departmentId);
    },
  );
  ipcMain.handle(
    DEPARTMENT_PIPELINE_VALIDATE_CHANNEL,
    (_event, input: unknown) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as { departmentId?: unknown }).departmentId !== "string"
      ) {
        throw new Error("Invalid department.pipeline.validate payload.");
      }
      return runtime().validatePipeline({
        departmentId: (input as { departmentId: string }).departmentId,
        graph: DepartmentPipelineDraftGraphSchema.parse(
          (input as { graph?: unknown }).graph,
        ),
      });
    },
  );
  ipcMain.handle(
    DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
    (_event, input: unknown) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as { departmentId?: unknown }).departmentId !==
          "string" ||
        !Number.isInteger(
          (input as { expectedRevision?: unknown }).expectedRevision,
        ) ||
        Number((input as { expectedRevision?: unknown }).expectedRevision) < 0
      ) {
        throw new Error("Invalid department.pipeline.draft.save payload.");
      }
      return runtime().savePipelineDraft({
        departmentId: (input as { departmentId: string }).departmentId,
        expectedRevision: (input as { expectedRevision: number })
          .expectedRevision,
        graph: DepartmentPipelineDraftGraphSchema.parse(
          (input as { graph?: unknown }).graph,
        ),
      });
    },
  );
  ipcMain.handle(
    DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
    (_event, input: unknown) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as { departmentId?: unknown }).departmentId !==
          "string" ||
        !Number.isInteger(
          (input as { expectedRevision?: unknown }).expectedRevision,
        ) ||
        Number((input as { expectedRevision?: unknown }).expectedRevision) < 0
      ) {
        throw new Error("Invalid department.pipeline.publish payload.");
      }
      return runtime().publishPipeline(
        input as Parameters<RuntimeHealthSource["publishPipeline"]>[0],
      );
    },
  );
  ipcMain.handle(RUNS_LIST_CHANNEL, (_event, input: unknown) => {
    if (input === undefined) return runtime().runs();
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { projectId?: unknown }).projectId !== "string"
    ) {
      throw new Error("Invalid runs.list payload.");
    }
    return runtime().runs((input as { projectId: string }).projectId);
  });
  ipcMain.handle(RUN_INSPECT_CHANNEL, (_event, runId: unknown) => {
    if (typeof runId !== "string" || runId.trim() === "") {
      throw new Error("Invalid run.inspect payload.");
    }
    return runtime().inspectRun(runId);
  });
  ipcMain.handle(RUNTIME_AUDIT_CHANNEL, (_event, input: unknown) => {
    if (input !== undefined && (typeof input !== "object" || input === null)) {
      throw new Error("Invalid runtime.audit payload.");
    }
    return runtime().audit(
      input as { runId?: string; limit?: number } | undefined,
    );
  });
  ipcMain.handle(RUNTIME_EVENTS_CHANNEL, (_event, input: unknown) => {
    if (typeof input !== "object" || input === null) {
      throw new Error("Invalid runtime.events payload.");
    }
    return runtime().events(input as { afterSequence: number; limit: number });
  });
  ipcMain.handle(RUNTIME_EVENTS_CONSUMER_CHANNEL, (_event, input: unknown) => {
    if (typeof input !== "object" || input === null) {
      throw new Error("Invalid runtime.events.consumer payload.");
    }
    return runtime().eventsForConsumer(
      input as { consumerId: string; limit: number },
    );
  });
  ipcMain.handle(RUNTIME_EVENTS_ACK_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "runtime.events.ack",
    });
    if (command.type !== "runtime.events.ack") {
      throw new Error("Invalid runtime.events.ack payload.");
    }
    return exposeRuntimeErrorCode(() =>
      runtime().acknowledgeEvents({
        consumerId: command.consumerId,
        sequence: command.sequence,
      }),
    );
  });
  ipcMain.handle(ARTIFACTS_LIST_CHANNEL, (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Invalid artifacts.list payload.");
    }
    return runtime().artifacts(projectId);
  });
  ipcMain.handle(ARTIFACT_INSPECT_CHANNEL, (_event, versionId: unknown) => {
    if (typeof versionId !== "string" || !versionId.trim()) {
      throw new Error("Invalid artifact.inspect payload.");
    }
    return runtime().inspectArtifact(versionId);
  });
  ipcMain.handle(ARTIFACT_STATUS_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "artifact.version.status",
    });
    if (command.type !== "artifact.version.status") {
      throw new Error("Invalid artifact.version.status payload.");
    }
    const { type: _type, ...statusInput } = command;
    return exposeRuntimeErrorCode(() =>
      runtime().setArtifactStatus(statusInput),
    );
  });
  ipcMain.handle(INTERACTIONS_LIST_CHANNEL, (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Invalid interactions.list payload.");
    }
    return runtime().interactions(projectId);
  });
  ipcMain.handle(AG_UI_EVENTS_CHANNEL, (_event, input: unknown) => {
    if (typeof input !== "object" || input === null) {
      throw new Error("Invalid ag-ui.events payload.");
    }
    return exposeRuntimeErrorCode(() =>
      runtime().agUiEvents(input as { afterSequence: number; limit: number }),
    );
  });
  ipcMain.handle(
    MEMORY_CANDIDATES_LIST_CHANNEL,
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Invalid memory.candidates.list payload.");
      }
      return runtime().memoryCandidates(projectId);
    },
  );
  ipcMain.handle(MEMORY_RECORDS_LIST_CHANNEL, (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Invalid memory.records.list payload.");
    }
    return runtime().memoryRecords(projectId);
  });
  ipcMain.handle(RUNTIME_DIAGNOSTICS_CHANNEL, () =>
    runtime().runtimeDiagnostics(),
  );
  ipcMain.handle(RUNTIME_BACKUP_CHANNEL, () =>
    exposeRuntimeErrorCode(() => runtime().backupRuntime()),
  );
  ipcMain.handle(RUNTIME_EVENTS_COMPACT_CHANNEL, (_event, input: unknown) => {
    const command = CompanyCommandSchema.parse({
      ...(typeof input === "object" && input !== null ? input : {}),
      type: "runtime.events.compact",
    });
    if (command.type !== "runtime.events.compact") {
      throw new Error("Invalid runtime.events.compact payload.");
    }
    return exposeRuntimeErrorCode(() =>
      runtime().compactRuntimeEvents({ retainLast: command.retainLast }),
    );
  });
  ipcMain.handle(INTERACTION_INSPECT_CHANNEL, (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Invalid interaction.inspect payload.");
    }
    return runtime().inspectInteraction(sessionId);
  });
  const registerInteractionCommand = (
    channel: string,
    type:
      | "interaction.session.create"
      | "interaction.session.close"
      | "interaction.participant.add"
      | "interaction.message.add"
      | "interaction.prompt"
      | "permission.request"
      | "permission.decide"
      | "memory.candidate.create"
      | "memory.candidate.review",
    execute: (command: never) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (_event, input: unknown) => {
      const command = CompanyCommandSchema.parse({
        ...(typeof input === "object" && input !== null ? input : {}),
        type,
      });
      return exposeRuntimeErrorCode(() => execute(command as never));
    });
  };
  registerInteractionCommand(
    INTERACTION_SESSION_CREATE_CHANNEL,
    "interaction.session.create",
    (command) => runtime().createInteractionSession(command),
  );
  registerInteractionCommand(
    INTERACTION_SESSION_CLOSE_CHANNEL,
    "interaction.session.close",
    (command) =>
      runtime().closeInteractionSession(
        (command as { readonly sessionId: string }).sessionId,
      ),
  );
  registerInteractionCommand(
    MEMORY_CANDIDATE_CREATE_CHANNEL,
    "memory.candidate.create",
    (command) => runtime().createMemoryCandidate(command),
  );
  registerInteractionCommand(
    MEMORY_CANDIDATE_REVIEW_CHANNEL,
    "memory.candidate.review",
    (command) => runtime().reviewMemoryCandidate(command),
  );
  registerInteractionCommand(
    INTERACTION_PARTICIPANT_ADD_CHANNEL,
    "interaction.participant.add",
    (command) => runtime().addInteractionParticipant(command),
  );
  registerInteractionCommand(
    INTERACTION_MESSAGE_ADD_CHANNEL,
    "interaction.message.add",
    (command) => runtime().addInteractionMessage(command),
  );
  registerInteractionCommand(
    INTERACTION_PROMPT_CHANNEL,
    "interaction.prompt",
    (command) => runtime().promptInteraction(command),
  );
  registerInteractionCommand(
    PERMISSION_REQUEST_CHANNEL,
    "permission.request",
    (command) => runtime().requestPermission(command),
  );
  registerInteractionCommand(
    PERMISSION_DECIDE_CHANNEL,
    "permission.decide",
    (command) => runtime().decidePermission(command),
  );
  const registerRunCommand = (
    channel: string,
    type:
      | "run.start"
      | "run.fork"
      | "run.execute-ready"
      | "run.pause"
      | "run.resume"
      | "run.cancel"
      | "run.recover"
      | "run.approval.decide"
      | "run.approval.retry"
      | "run.node.retry",
    execute: (command: never) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, (_event, input: unknown) => {
      const command = CompanyCommandSchema.parse({
        ...(typeof input === "object" && input !== null ? input : {}),
        type,
      });
      return exposeRuntimeErrorCode(() => execute(command as never));
    });
  };
  registerRunCommand(RUN_START_CHANNEL, "run.start", (command) =>
    runtime().startRun(command),
  );
  registerRunCommand(RUN_FORK_CHANNEL, "run.fork", (command) =>
    runtime().forkRun(command),
  );
  registerRunCommand(
    RUN_EXECUTE_READY_CHANNEL,
    "run.execute-ready",
    (command) => runtime().executeReady(command),
  );
  registerRunCommand(RUN_PAUSE_CHANNEL, "run.pause", (command) =>
    runtime().pauseRun(command),
  );
  registerRunCommand(RUN_RESUME_CHANNEL, "run.resume", (command) =>
    runtime().resumeRun(command),
  );
  registerRunCommand(RUN_CANCEL_CHANNEL, "run.cancel", (command) =>
    runtime().cancelRun(command),
  );
  registerRunCommand(RUN_RECOVER_CHANNEL, "run.recover", (command) =>
    runtime().recoverRun(command),
  );
  registerRunCommand(
    RUN_APPROVAL_DECIDE_CHANNEL,
    "run.approval.decide",
    (command) => runtime().decideApproval(command),
  );
  registerRunCommand(
    RUN_APPROVAL_RETRY_CHANNEL,
    "run.approval.retry",
    (command) => runtime().retryApproval(command),
  );
  registerRunCommand(RUN_NODE_RETRY_CHANNEL, "run.node.retry", (command) =>
    runtime().retryNode(command),
  );
  return {
    revokeWindow: () => {
      const currentWindow = options.getWindow?.();
      if (!currentWindow) return;
      const stream = streams.get(currentWindow.webContents.id);
      if (!stream) return;
      closeStream(stream);
      const closing = runtime().closeSubscription?.({
        subscriptionId: stream.handle.subscriptionId,
        subscriptionGeneration: stream.handle.subscriptionGeneration,
      });
      void closing?.catch(() => undefined);
    },
  };
};
