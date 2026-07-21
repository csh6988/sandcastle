import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { companyRuntimeAddress } from "../runtime/address.js";
import { createCompanyRuntimeClient } from "../runtime/client.js";
import type {
  CompanyCommand,
  CompanyCommandResult,
  CompanyDepartment,
  ArtifactContract,
  ArtifactVersionView,
  ArtifactLineageView,
  InteractionView,
  InteractionSessionView,
  SessionParticipantView,
  SessionMessageView,
  PermissionRequestView,
  AgUiReplayView,
  MemoryCandidateView,
  MemoryRecordView,
  MemoryReviewView,
  RuntimeDiagnosticsView,
  RuntimeBackupView,
  CompanyOverview,
  CompanyProject,
  CompanyQuery,
  CompanyQueryResult,
  CompanyRuntimeClient,
  DepartmentRunView,
  DepartmentInspect,
  DepartmentPipelineDraftGraph,
  DepartmentPipelineEditorView,
  PipelineValidationResult,
  ProjectEditorView,
  RuntimeHealth,
  RuntimeAuditRecord,
  RuntimeEventRecord,
  SkillConfigurationView,
  AgentCatalogView,
  AgentTestResult,
  SkillCatalogView,
  PositionConfigurationResult,
} from "../runtime/interface.js";

export interface CompanyRuntimeSupervisor {
  start(companyDir: string): Promise<RuntimeHealth>;
  health(): Promise<RuntimeHealth>;
  inspectAgentCatalog(): Promise<AgentCatalogView>;
  discoverAgents(): Promise<AgentCatalogView>;
  testAgent(agentId: string): Promise<AgentTestResult>;
  inspectSkillCatalog(): Promise<SkillCatalogView>;
  discoverSkills(directories?: readonly string[]): Promise<SkillCatalogView>;
  enableSkill(skillId: string): Promise<SkillCatalogView>;
  archiveDiscoveredSkill(skillId: string): Promise<SkillCatalogView>;
  overview(): Promise<CompanyOverview>;
  projects(): Promise<readonly CompanyProject[]>;
  createProject(input: {
    readonly name: string;
    readonly goal: string;
  }): Promise<CompanyProject>;
  inspectProject(projectId: string): Promise<ProjectEditorView>;
  updateProject(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
    readonly repositoryReferences: readonly string[];
  }): Promise<ProjectEditorView>;
  archiveProject(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
  }): Promise<ProjectEditorView>;
  departments(): Promise<readonly CompanyDepartment[]>;
  inspectDepartment(departmentId: string): Promise<DepartmentInspect>;
  createDepartment(input: {
    readonly name: string;
  }): Promise<CompanyDepartment>;
  updateDepartment(input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly inputArtifactContracts: readonly ArtifactContract[];
    readonly outputArtifactContracts: readonly ArtifactContract[];
    readonly defaultExecutionProfileId: string | null;
  }): Promise<DepartmentInspect>;
  archiveDepartment(input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentInspect>;
  copyDepartment(input: {
    readonly departmentId: string;
    readonly name: string;
  }): Promise<DepartmentInspect>;
  createPosition(input: {
    readonly departmentId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly defaultAgentId?: string;
  }): Promise<DepartmentInspect>;
  updatePosition(input: {
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
  }): Promise<DepartmentInspect>;
  archivePosition(input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentInspect>;
  configurePosition(input: {
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
  }): Promise<PositionConfigurationResult>;
  createSecretReference(input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }): Promise<DepartmentInspect>;
  archiveSecretReference(input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }): Promise<DepartmentInspect>;
  saveExecutionProfile(input: {
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
  }): Promise<DepartmentInspect>;
  archiveExecutionProfile(input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentInspect>;
  inspectPipeline(departmentId: string): Promise<DepartmentPipelineEditorView>;
  validatePipeline(input: {
    readonly departmentId: string;
    readonly graph: DepartmentPipelineDraftGraph;
  }): Promise<PipelineValidationResult>;
  savePipelineDraft(input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly graph: DepartmentPipelineDraftGraph;
  }): Promise<DepartmentPipelineEditorView>;
  publishPipeline(input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentPipelineEditorView>;
  runs(projectId?: string): Promise<readonly DepartmentRunView[]>;
  inspectRun(runId: string): Promise<DepartmentRunView>;
  audit(input?: {
    readonly runId?: string;
    readonly limit?: number;
  }): Promise<readonly RuntimeAuditRecord[]>;
  events(input: {
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<readonly RuntimeEventRecord[]>;
  eventsForConsumer(input: {
    readonly consumerId: string;
    readonly limit: number;
  }): Promise<readonly RuntimeEventRecord[]>;
  acknowledgeEvents(input: {
    readonly consumerId: string;
    readonly sequence: number;
  }): Promise<{ readonly acknowledged: true }>;
  artifacts(projectId: string): Promise<readonly ArtifactVersionView[]>;
  inspectArtifact(versionId: string): Promise<ArtifactLineageView>;
  setArtifactStatus(input: {
    readonly versionId: string;
    readonly expectedStatus: ArtifactVersionView["status"];
    readonly status: ArtifactVersionView["status"];
  }): Promise<ArtifactVersionView>;
  interactions(projectId: string): Promise<readonly InteractionView[]>;
  inspectInteraction(sessionId: string): Promise<InteractionView>;
  createInteractionSession(input: {
    readonly projectId: string;
    readonly mode: "consultation" | "run-collaboration";
    readonly runId?: string;
    readonly nodeRunId?: string;
  }): Promise<InteractionSessionView>;
  closeInteractionSession(sessionId: string): Promise<InteractionSessionView>;
  addInteractionParticipant(input: {
    readonly sessionId: string;
    readonly participantType: "human" | "ai-member" | "system";
    readonly participantRef: string;
    readonly role: string;
  }): Promise<SessionParticipantView>;
  addInteractionMessage(input: {
    readonly sessionId: string;
    readonly participantId: string;
    readonly kind: "text" | "tool" | "status";
    readonly content: string;
  }): Promise<SessionMessageView>;
  promptInteraction(input: {
    readonly sessionId: string;
    readonly participantId: string;
    readonly content: string;
  }): Promise<SessionMessageView>;
  requestPermission(input: {
    readonly sessionId: string;
    readonly scope: string;
    readonly expiresAt?: string;
  }): Promise<PermissionRequestView>;
  decidePermission(input: {
    readonly permissionId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "denied";
  }): Promise<PermissionRequestView>;
  agUiEvents(input: {
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<AgUiReplayView>;
  memoryCandidates(projectId: string): Promise<readonly MemoryCandidateView[]>;
  memoryRecords(projectId: string): Promise<readonly MemoryRecordView[]>;
  createMemoryCandidate(input: {
    readonly projectId: string;
    readonly scope: "project" | "ai-member";
    readonly aiMemberId?: string;
    readonly sourceSessionId?: string;
    readonly sourceRunId?: string;
    readonly sourceArtifactVersionId?: string;
    readonly summary: string;
  }): Promise<MemoryCandidateView>;
  reviewMemoryCandidate(input: {
    readonly candidateId: string;
    readonly expectedStatus: "pending";
    readonly decision: "approved" | "discarded";
  }): Promise<MemoryReviewView>;
  runtimeDiagnostics(): Promise<RuntimeDiagnosticsView>;
  backupRuntime(): Promise<RuntimeBackupView>;
  compactRuntimeEvents(input: {
    readonly retainLast: number;
  }): Promise<{ readonly deleted: number; readonly retained: number }>;
  startRun(input: {
    readonly projectId: string;
    readonly departmentId: string;
    readonly agentOverrideId?: string;
  }): Promise<DepartmentRunView>;
  forkRun(input: {
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly fromNodeRunId: string;
  }): Promise<DepartmentRunView>;
  executeReady(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentRunView>;
  pauseRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentRunView>;
  resumeRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentRunView>;
  cancelRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }): Promise<DepartmentRunView>;
  recoverRun(input: {
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
  }): Promise<DepartmentRunView>;
  decideApproval(input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly decision: "approve" | "request-changes" | "reject";
    readonly feedback?: string;
  }): Promise<DepartmentRunView>;
  retryNode(input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly expectedRevision: number;
    readonly feedback?: string;
  }): Promise<DepartmentRunView>;
  inspectSkillConfiguration(
    departmentId: string,
  ): Promise<SkillConfigurationView>;
  saveSkill(input: {
    readonly departmentId: string;
    readonly skillId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }): Promise<SkillConfigurationView>;
  archiveSkill(input: {
    readonly departmentId: string;
    readonly skillId: string;
    readonly expectedRevision: number;
  }): Promise<SkillConfigurationView>;
  setPositionSkills(input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }): Promise<SkillConfigurationView>;
  saveSkillFlow(input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }): Promise<SkillConfigurationView>;
  archiveSkillFlow(input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }): Promise<SkillConfigurationView>;
  diagnostics(): CompanyRuntimeSupervisorDiagnostics;
  stop(): Promise<void>;
}

export interface RuntimeExitDiagnostic {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: string;
  readonly stderr: string;
}

export interface CompanyRuntimeSupervisorDiagnostics {
  readonly status: "stopped" | "starting" | "running" | "restarting" | "failed";
  readonly companyDir?: string;
  readonly pid?: number;
  readonly restartCount: number;
  readonly lastExit?: RuntimeExitDiagnostic;
  readonly error?: string;
}

export interface CompanyRuntimeSupervisorOptions {
  readonly executable?: string;
  readonly execArgs?: readonly string[];
  readonly runtimeEntry?: string;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly onLog?: (line: string) => void;
}

interface RunningRuntime {
  readonly child: ChildProcess;
  readonly client: CompanyRuntimeClient;
  readonly companyDir: string;
  readonly restartCount: number;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
};

export const createCompanyRuntimeSupervisor = (
  options: CompanyRuntimeSupervisorOptions = {},
): CompanyRuntimeSupervisor => {
  const executable = options.executable ?? process.execPath;
  const runtimeEntry =
    options.runtimeEntry ??
    fileURLToPath(new URL("../runtime/entry.js", import.meta.url));
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  let running: RunningRuntime | null = null;
  let restartPromise: Promise<RuntimeHealth> | null = null;
  let stopping = false;
  let state: CompanyRuntimeSupervisorDiagnostics = {
    status: "stopped",
    restartCount: 0,
  };

  const diagnostics = (): CompanyRuntimeSupervisorDiagnostics => ({
    ...state,
    lastExit: state.lastExit ? { ...state.lastExit } : undefined,
  });

  const health = async (): Promise<RuntimeHealth> => {
    if (restartPromise) return restartPromise;
    if (running) return running.client.query({ type: "runtime.health" });
    if (state.status === "failed" && state.lastExit) {
      throw new Error(
        `Company Runtime unexpectedly exited with pid ${state.lastExit.pid}.`,
      );
    }
    throw new Error("Company Runtime is not running.");
  };

  const overview = async (): Promise<CompanyOverview> => {
    if (restartPromise) await restartPromise;
    if (!running) throw new Error("Company Runtime is not running.");
    return running.client.query({ type: "company.overview" });
  };

  const query = async <Query extends CompanyQuery>(
    nextQuery: Query,
  ): Promise<CompanyQueryResult<Query>> => {
    if (restartPromise) await restartPromise;
    if (!running) throw new Error("Company Runtime is not running.");
    return running.client.query(nextQuery);
  };

  const execute = async <Command extends CompanyCommand>(
    command: Command,
  ): Promise<CompanyCommandResult<Command>> => {
    if (restartPromise) await restartPromise;
    if (!running) throw new Error("Company Runtime is not running.");
    return running.client.execute(command);
  };

  const stopChild = async (current: RunningRuntime): Promise<void> => {
    if (current.child.exitCode === null && current.child.signalCode === null) {
      await current.client
        .execute({ type: "runtime.shutdown" })
        .catch(() => undefined);
    }
    if (await waitForExit(current.child, shutdownTimeoutMs)) return;

    current.child.kill("SIGTERM");
    if (await waitForExit(current.child, shutdownTimeoutMs)) return;
    current.child.kill("SIGKILL");
    await waitForExit(current.child, shutdownTimeoutMs);
  };

  const launch = async (
    companyDir: string,
    restartCount: number,
    lastExit?: RuntimeExitDiagnostic,
  ): Promise<RuntimeHealth> => {
    state = {
      status: restartCount === 0 ? "starting" : "restarting",
      companyDir,
      restartCount,
      lastExit,
    };
    const address = companyRuntimeAddress(companyDir);
    const token = randomBytes(32).toString("base64url");
    const child = spawn(
      executable,
      [...(options.execArgs ?? []), runtimeEntry],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          SANDCASTLE_COMPANY_DIR: companyDir,
          SANDCASTLE_COMPANY_RUNTIME_ADDRESS: address,
          SANDCASTLE_COMPANY_RUNTIME_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout?.on("data", (chunk) => {
      options.onLog?.(chunk.toString("utf8").trimEnd());
    });
    child.stderr?.on("data", (chunk) => {
      const line = chunk.toString("utf8");
      stderr = `${stderr}${line}`.slice(-8_192);
      options.onLog?.(line.trimEnd());
    });
    const client = createCompanyRuntimeClient({
      address,
      token,
      timeoutMs: 500,
    });
    const current: RunningRuntime = {
      child,
      client,
      companyDir,
      restartCount,
    };
    running = current;
    let becameHealthy = false;
    child.once("exit", (code, signal) => {
      if (!becameHealthy || stopping || running !== current) return;
      running = null;
      const exit: RuntimeExitDiagnostic = {
        pid: child.pid ?? state.pid ?? -1,
        code,
        signal,
        at: new Date().toISOString(),
        stderr: stderr.trim(),
      };
      if (restartCount >= 1) {
        state = {
          status: "failed",
          companyDir,
          restartCount,
          lastExit: exit,
          error: `Company Runtime unexpectedly exited after ${restartCount} restart.`,
        };
        options.onLog?.(
          `unexpected exit pid=${exit.pid} code=${String(code)} signal=${String(signal)}; restart limit reached`,
        );
        return;
      }

      state = {
        status: "restarting",
        companyDir,
        restartCount: 1,
        lastExit: exit,
      };
      options.onLog?.(
        `unexpected exit pid=${exit.pid} code=${String(code)} signal=${String(signal)}; restarting once`,
      );
      const attempt = launch(companyDir, 1, exit);
      restartPromise = attempt;
      void attempt
        .catch((error: unknown) => {
          state = {
            status: "failed",
            companyDir,
            restartCount: 1,
            lastExit: exit,
            error: `Company Runtime restart failed: ${String(error)}`,
          };
          options.onLog?.(`restart failed: ${String(error)}`);
        })
        .finally(() => {
          if (restartPromise === attempt) restartPromise = null;
        });
    });

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      const currentSpawnError = spawnError as Error | null;
      if (currentSpawnError) {
        if (running === current) running = null;
        throw new Error(
          `Company Runtime failed to start: ${currentSpawnError.message}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        if (running === current) running = null;
        throw new Error(
          `Company Runtime exited before becoming healthy.${stderr ? ` ${stderr.trim()}` : ""}`,
        );
      }
      try {
        const result = await client.query({ type: "runtime.health" });
        becameHealthy = true;
        state = {
          status: "running",
          companyDir,
          pid: result.pid,
          restartCount,
          lastExit,
        };
        options.onLog?.(
          `healthy pid=${result.pid} schema=${result.schemaVersion}`,
        );
        return result;
      } catch {
        await delay(50);
      }
    }

    if (running === current) running = null;
    await stopChild(current);
    throw new Error(
      `Company Runtime did not become healthy within ${startupTimeoutMs}ms.${stderr ? ` ${stderr.trim()}` : ""}`,
    );
  };

  const start = async (companyDir: string): Promise<RuntimeHealth> => {
    if (running) {
      if (running.companyDir !== companyDir) {
        throw new Error(
          "Company Runtime is already supervising a different company directory.",
        );
      }
      return health();
    }
    if (restartPromise) {
      if (state.companyDir !== companyDir) {
        throw new Error(
          "Company Runtime is already supervising a different company directory.",
        );
      }
      return restartPromise;
    }

    stopping = false;
    try {
      return await launch(companyDir, 0);
    } catch (error) {
      state = {
        status: "failed",
        companyDir,
        restartCount: 0,
        error: String(error),
      };
      throw error;
    }
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    const pendingRestart = restartPromise;
    if (pendingRestart) await pendingRestart.catch(() => undefined);
    restartPromise = null;
    const current = running;
    running = null;
    if (current) await stopChild(current);
    state = { status: "stopped", restartCount: 0 };
    stopping = false;
  };

  return {
    start,
    health,
    inspectAgentCatalog: () => query({ type: "agent.catalog.inspect" }),
    discoverAgents: () => execute({ type: "agent.catalog.discover" }),
    testAgent: (agentId) => execute({ type: "agent.test", agentId }),
    inspectSkillCatalog: () => query({ type: "skill.discovery.inspect" }),
    discoverSkills: (directories = []) =>
      execute({
        type: "skill.discovery.refresh",
        directories: [...directories],
      }),
    enableSkill: (skillId) =>
      execute({ type: "skill.discovery.enable", skillId }),
    archiveDiscoveredSkill: (skillId) =>
      execute({ type: "skill.discovery.archive", skillId }),
    overview,
    projects: () => query({ type: "projects.list" }),
    createProject: (input) => execute({ type: "project.create", ...input }),
    inspectProject: (projectId) =>
      query({ type: "project.inspect", projectId }),
    updateProject: (input) =>
      execute({
        type: "project.update",
        ...input,
        repositoryReferences: [...input.repositoryReferences],
      }),
    archiveProject: (input) => execute({ type: "project.archive", ...input }),
    departments: () => query({ type: "departments.list" }),
    inspectDepartment: (departmentId) =>
      query({ type: "department.inspect", departmentId }),
    createDepartment: (input) =>
      execute({ type: "department.create", ...input }),
    updateDepartment: (input) =>
      execute({
        type: "department.update",
        ...input,
        inputArtifactContracts: [...input.inputArtifactContracts],
        outputArtifactContracts: [...input.outputArtifactContracts],
      }),
    archiveDepartment: (input) =>
      execute({ type: "department.archive", ...input }),
    copyDepartment: (input) => execute({ type: "department.copy", ...input }),
    createPosition: (input) => execute({ type: "position.create", ...input }),
    updatePosition: (input) => execute({ type: "position.update", ...input }),
    archivePosition: (input) => execute({ type: "position.archive", ...input }),
    configurePosition: (input) =>
      execute({
        type: "position.configure",
        ...input,
        skillIds: [...input.skillIds],
      }),
    createSecretReference: (input) =>
      execute({ type: "secret-reference.create", ...input }),
    archiveSecretReference: (input) =>
      execute({ type: "secret-reference.archive", ...input }),
    saveExecutionProfile: (input) =>
      execute({
        type: "execution-profile.save",
        ...input,
        secretReferenceIds: [...input.secretReferenceIds],
      }),
    archiveExecutionProfile: (input) =>
      execute({ type: "execution-profile.archive", ...input }),
    inspectPipeline: (departmentId) =>
      query({ type: "department.pipeline.inspect", departmentId }),
    validatePipeline: (input) =>
      query({ type: "department.pipeline.validate", ...input }),
    savePipelineDraft: (input) =>
      execute({ type: "department.pipeline.draft.save", ...input }),
    publishPipeline: (input) =>
      execute({ type: "department.pipeline.publish", ...input }),
    runs: (projectId) =>
      query({ type: "runs.list", ...(projectId ? { projectId } : {}) }),
    inspectRun: (runId) => query({ type: "run.inspect", runId }),
    audit: (input = {}) => query({ type: "runtime.audit", ...input }),
    events: (input) => query({ type: "runtime.events", ...input }),
    eventsForConsumer: (input) =>
      query({ type: "runtime.events.consumer", ...input }),
    acknowledgeEvents: (input) =>
      execute({ type: "runtime.events.ack", ...input }),
    artifacts: (projectId) => query({ type: "artifacts.list", projectId }),
    inspectArtifact: (versionId) =>
      query({ type: "artifact.inspect", versionId }),
    setArtifactStatus: (input) =>
      execute({ type: "artifact.version.status", ...input }),
    interactions: (projectId) =>
      query({ type: "interactions.list", projectId }),
    inspectInteraction: (sessionId) =>
      query({ type: "interaction.inspect", sessionId }),
    createInteractionSession: (input) =>
      execute({ type: "interaction.session.create", ...input }),
    closeInteractionSession: (sessionId) =>
      execute({ type: "interaction.session.close", sessionId }),
    addInteractionParticipant: (input) =>
      execute({ type: "interaction.participant.add", ...input }),
    addInteractionMessage: (input) =>
      execute({ type: "interaction.message.add", ...input }),
    promptInteraction: (input) =>
      execute({ type: "interaction.prompt", ...input }),
    requestPermission: (input) =>
      execute({ type: "permission.request", ...input }),
    decidePermission: (input) =>
      execute({ type: "permission.decide", ...input }),
    agUiEvents: (input) => query({ type: "ag-ui.events", ...input }),
    memoryCandidates: (projectId) =>
      query({ type: "memory.candidates.list", projectId }),
    memoryRecords: (projectId) =>
      query({ type: "memory.records.list", projectId }),
    createMemoryCandidate: (input) =>
      execute({ type: "memory.candidate.create", ...input }),
    reviewMemoryCandidate: (input) =>
      execute({ type: "memory.candidate.review", ...input }),
    runtimeDiagnostics: () => query({ type: "runtime.diagnostics" }),
    backupRuntime: () => execute({ type: "runtime.backup" }),
    compactRuntimeEvents: (input) =>
      execute({ type: "runtime.events.compact", ...input }),
    startRun: (input) => execute({ type: "run.start", ...input }),
    forkRun: (input) => execute({ type: "run.fork", ...input }),
    executeReady: (input) => execute({ type: "run.execute-ready", ...input }),
    pauseRun: (input) => execute({ type: "run.pause", ...input }),
    resumeRun: (input) => execute({ type: "run.resume", ...input }),
    cancelRun: (input) => execute({ type: "run.cancel", ...input }),
    recoverRun: (input) =>
      execute({
        type: "run.recover",
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        expectedRevision: input.expectedRevision,
        override: {
          ...(input.override.providerRef
            ? { providerRef: input.override.providerRef }
            : {}),
          ...(input.override.model ? { model: input.override.model } : {}),
          ...(input.override.sandboxRef
            ? { sandboxRef: input.override.sandboxRef }
            : {}),
          ...(input.override.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: input.override.timeoutSeconds }),
          ...(input.override.maxIterations === undefined
            ? {}
            : { maxIterations: input.override.maxIterations }),
          ...(input.override.maxTokens === undefined
            ? {}
            : { maxTokens: input.override.maxTokens }),
          ...(input.override.secretReferenceIds
            ? { secretReferenceIds: [...input.override.secretReferenceIds] }
            : {}),
        },
      }),
    decideApproval: (input) =>
      execute({ type: "run.approval.decide", ...input }),
    retryNode: (input) => execute({ type: "run.node.retry", ...input }),
    inspectSkillConfiguration: (departmentId) =>
      query({
        type: "department.skill-configuration.inspect",
        departmentId,
      }),
    saveSkill: (input) => execute({ type: "skill.catalog.save", ...input }),
    archiveSkill: (input) =>
      execute({ type: "skill.catalog.archive", ...input }),
    setPositionSkills: (input) =>
      execute({
        type: "position.skills.set",
        ...input,
        skillIds: [...input.skillIds],
      }),
    saveSkillFlow: (input) =>
      execute({
        type: "skill-flow.save",
        ...input,
        skillIds: [...input.skillIds],
      }),
    archiveSkillFlow: (input) =>
      execute({ type: "skill-flow.archive", ...input }),
    diagnostics,
    stop,
  };
};
