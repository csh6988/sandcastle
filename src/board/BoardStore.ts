import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RunEvent } from "../RunEvent.js";
import type { PrdVisualAsset } from "./prdAssets.js";
import { issueStatusForRun, renderTaskProgress } from "./taskProgress.js";
import {
  updateLocalIssueStatusMarkdown,
  type LocalIssueStatus,
} from "./localIssueMarkdown.js";
import type { BoardTaskVerificationStatus } from "./taskVerification.js";
export type {
  BoardTaskVerificationReport,
  BoardTaskVerificationRepositorySummary,
  BoardTaskVerificationStatus,
} from "./taskVerification.js";

/**
 * Lifecycle status of a board run, derived from the run-event stream.
 */
export type BoardRunStatus = "running" | "succeeded" | "failed";

/**
 * A run-event with its `Date` timestamp serialized to an ISO string, as stored
 * on disk and sent to the board frontend.
 */
export type SerializedRunEvent = RunEvent extends infer T
  ? T extends { timestamp: Date }
    ? Omit<T, "timestamp"> & { timestamp: string }
    : T
  : never;

/** A stored run-event plus its monotonically increasing per-run sequence. */
export interface BoardRunEventRecord {
  readonly seq: number;
  readonly event: SerializedRunEvent;
}

/** A run as surfaced on the board — metadata plus fields derived from events. */
export interface BoardRunRecord {
  readonly id: string;
  readonly name: string;
  readonly agent: string;
  readonly model?: string;
  readonly sandbox: string;
  readonly branch: string;
  readonly maxIterations: number;
  readonly currentIteration?: number;
  readonly status: BoardRunStatus;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly completionSignal?: string;
  readonly iterationsRun?: number;
  readonly error?: string;
  readonly commits: number;
  readonly totalTokens?: number;
  readonly lastEventType?: RunEvent["type"];
  readonly lastEventAt?: string;
  /** Optional link to a board task (set for workspace task runs). */
  readonly taskId?: string;
  /** Repository name this run targets (set for workspace task runs). */
  readonly repo?: string;
}

/** Per-model token usage aggregated across a run's `usage` events. */
export interface BoardUsageByModel {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * A board-local snapshot of a workspace plan. A subset of the core
 * `WorkspaceTaskPlan`, kept independent so the board module stays decoupled
 * from the orchestration core.
 */
export interface BoardTaskPlan {
  readonly alignment?: {
    readonly summary?: string;
    readonly assumptions?: readonly string[];
    readonly openQuestions?: readonly string[];
    readonly domainTerms?: readonly {
      readonly term: string;
      readonly meaning: string;
    }[];
    readonly adrCandidates?: readonly {
      readonly title: string;
      readonly reason: string;
    }[];
  };
  readonly alignmentSummary?: string;
  readonly technicalPlan?: string;
  readonly workspace?: {
    readonly branchPrefix?: string;
    readonly maxIterations?: number;
    readonly repositories: ReadonlyArray<{
      readonly name: string;
      readonly cwd: string;
      readonly kind?: string;
      readonly description?: string;
      readonly copyToWorktree?: readonly string[];
      readonly branchStrategy?: unknown;
    }>;
  };
  readonly repositories: ReadonlyArray<{
    readonly name: string;
    readonly task: string;
    readonly reason?: string;
    readonly issue?: {
      readonly title: string;
      readonly body: string;
    };
  }>;
}

export type BoardTaskWorkflowPhase =
  | "classifying"
  | "aligning-prd"
  | "technical-planning"
  | "creating-issues"
  | "awaiting-approval"
  | "running"
  | "verifying";

export type BoardTaskWorkflowStatus =
  | BoardTaskWorkflowPhase
  | "planning"
  | "approved"
  | "rejected"
  | "retrying"
  | "succeeded"
  | "failed";

export type BoardTaskWorkflowSubstatus =
  | "validating-workspace-plan"
  | "fixing-workspace-plan";

export type BoardTaskApprovedPlanAction = "execute" | "export-artifacts";

export type BoardRole = "planner" | "generator" | "evaluator";

export type BoardTaskSource =
  | {
      readonly type: "workspace-plan";
      readonly planFile: string;
    }
  | {
      readonly type: "prd-file";
      readonly prdFile: string;
      readonly assets?: readonly PrdVisualAsset[];
    };

export interface BoardPhaseSessionSummary {
  readonly taskId: string;
  readonly phase: BoardTaskWorkflowPhase;
  readonly pid: number;
  readonly status: "running" | "exited";
  readonly startedAt: string;
  readonly exitedAt?: string;
  readonly exitCode?: number;
}

/** Optional workflow state for board tasks driven by a workflow runtime. */
export interface BoardTaskWorkflow {
  readonly status: BoardTaskWorkflowStatus;
  readonly currentPhase?: BoardTaskWorkflowPhase;
  readonly role?: BoardRole;
  readonly substatus?: BoardTaskWorkflowSubstatus;
  readonly approvedPlanAction?: BoardTaskApprovedPlanAction;
  readonly phaseSessions?: Partial<
    Record<BoardTaskWorkflowPhase, BoardPhaseSessionSummary>
  >;
  readonly checkpointThreadId?: string;
  readonly retryCount?: number;
  readonly workspacePlanRepairAttempts?: number;
  readonly verificationStatus?: BoardTaskVerificationStatus;
  readonly message?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

/** A task created on the board, optionally fanned out into per-repo runs. */
export interface BoardTaskRecord {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly source?: BoardTaskSource;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly runIds: string[];
  /** The workspace plan produced for this task, once planning has completed. */
  readonly plan?: BoardTaskPlan;
  /** Workflow runtime status, present for opt-in workflow-backed tasks. */
  readonly workflow?: BoardTaskWorkflow;
}

export type BoardTaskStageMode =
  | "pending"
  | "interactive"
  | "background"
  | "approval"
  | "afk"
  | "complete"
  | "failed";

export type BoardTaskStageTimelineStatus =
  | "pending"
  | "complete"
  | "current"
  | "failed";

export interface BoardTaskStageTimelineItem {
  readonly id: string;
  readonly label: string;
  readonly status: BoardTaskStageTimelineStatus;
}

export interface BoardTaskStage {
  readonly id: string;
  readonly label: string;
  readonly mode: BoardTaskStageMode;
  readonly description: string;
  readonly terminalPhase?: BoardTaskWorkflowPhase;
  readonly canComplete: boolean;
  readonly canCancel: boolean;
  readonly cancelLabel?: string;
  readonly canApprove: boolean;
  readonly approveLabel?: string;
  readonly approvingLabel?: string;
  readonly canReject: boolean;
  readonly canRecover: boolean;
  readonly recoverPhase?: BoardTaskWorkflowPhase;
  readonly timeline: BoardTaskStageTimelineItem[];
}

export interface BoardTaskView extends BoardTaskRecord {
  readonly stage: BoardTaskStage;
}

export type BoardTaskArtifactKind =
  | "workspace-plan"
  | "alignment"
  | "technical-plan"
  | "issue"
  | "asset"
  | "progress"
  | "verification";

export interface BoardTaskArtifact {
  readonly kind: BoardTaskArtifactKind;
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly createdAt: string;
}

/** Input for creating a run, taken from a `run-started` event. */
export interface CreateRunInput {
  readonly name: string;
  readonly agent: string;
  readonly model?: string;
  readonly sandbox: string;
  readonly branch: string;
  readonly maxIterations: number;
  readonly taskId?: string;
  readonly repo?: string;
}

/** A board change broadcast to subscribers (used to drive SSE). */
export type BoardChange =
  | { readonly kind: "run-updated"; readonly run: BoardRunRecord }
  | {
      readonly kind: "run-event";
      readonly runId: string;
      readonly record: BoardRunEventRecord;
    }
  | { readonly kind: "task-updated"; readonly task: BoardTaskRecord };

type ChangeListener = (change: BoardChange) => void;

const serializeEvent = (event: RunEvent): SerializedRunEvent =>
  JSON.parse(JSON.stringify(event)) as SerializedRunEvent;

const INTERACTIVE_WORKFLOW_PHASES = new Set<BoardTaskWorkflowPhase>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
]);

const WORKFLOW_PHASES = new Set<string>([
  "classifying",
  "aligning-prd",
  "technical-planning",
  "creating-issues",
  "awaiting-approval",
  "running",
  "verifying",
]);

const PHASE_LABELS: Record<BoardTaskWorkflowPhase, string> = {
  classifying: "Classifying task",
  "aligning-prd": "Aligning PRD",
  "technical-planning": "Technical planning",
  "creating-issues": "Creating issues",
  "awaiting-approval": "Awaiting approval",
  running: "Running AFK execution",
  verifying: "Verifying delivery",
};

const PHASE_DESCRIPTIONS: Record<BoardTaskWorkflowPhase, string> = {
  classifying: "Classify the task and decide how the board should treat it.",
  "aligning-prd": "Align the PRD, goals, non-goals, and workspace boundaries.",
  "technical-planning":
    "Prepare the technical approach before issues are finalized.",
  "creating-issues":
    "Create the final Board issues and emit the workspace_plan block.",
  "awaiting-approval": "Review and approve the generated workspace plan.",
  running: "Execute the approved workspace plan as AFK repository runs.",
  verifying:
    "Run the Evaluator agent against recorded evidence, commits, completion evidence, and failures.",
};

const sanitizeIssueArtifactSegment = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "issue";
};

const withTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n`;

const issueMarkdownFor = (
  repo: BoardTaskPlan["repositories"][number],
): string => {
  if (repo.issue) {
    return withTrailingNewline(`# ${repo.issue.title}\n\n${repo.issue.body}`);
  }

  return `# ${repo.name}: ${repo.task}

status: ready-for-agent

## What to build

${repo.task}
`;
};

const BASE_TIMELINE: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
}> = [
  { id: "classifying", label: "Classify" },
  { id: "aligning-prd", label: "Align PRD" },
  { id: "technical-planning", label: "Technical plan" },
  { id: "creating-issues", label: "Create issues" },
  { id: "validating-workspace-plan", label: "Validate plan" },
  { id: "awaiting-approval", label: "Approve" },
  { id: "running", label: "Execute" },
  { id: "verifying", label: "Verify" },
];

const timelineFor = (
  currentId: string,
  failure = false,
  completeCurrent = false,
): BoardTaskStageTimelineItem[] => {
  const currentIndex = BASE_TIMELINE.findIndex((item) => item.id === currentId);
  return BASE_TIMELINE.map((item, index) => {
    let status: BoardTaskStageTimelineStatus = "pending";
    if (currentIndex === -1) {
      status = failure ? "failed" : "pending";
    } else if (index < currentIndex) {
      status = "complete";
    } else if (index === currentIndex) {
      status = failure ? "failed" : completeCurrent ? "complete" : "current";
    }
    return { ...item, status };
  });
};

const boardTaskStage = (stage: {
  readonly id: string;
  readonly label: string;
  readonly mode: BoardTaskStageMode;
  readonly description: string;
  readonly currentTimelineId?: string;
  readonly terminalPhase?: BoardTaskWorkflowPhase;
  readonly canComplete?: boolean;
  readonly canCancel?: boolean;
  readonly cancelLabel?: string;
  readonly canApprove?: boolean;
  readonly approveLabel?: string;
  readonly approvingLabel?: string;
  readonly canReject?: boolean;
  readonly canRecover?: boolean;
  readonly recoverPhase?: BoardTaskWorkflowPhase;
  readonly failureTimeline?: boolean;
  readonly completeCurrentTimeline?: boolean;
}): BoardTaskStage => ({
  id: stage.id,
  label: stage.label,
  mode: stage.mode,
  description: stage.description,
  ...(stage.terminalPhase ? { terminalPhase: stage.terminalPhase } : {}),
  canComplete: stage.canComplete ?? false,
  canCancel: stage.canCancel ?? false,
  ...(stage.cancelLabel ? { cancelLabel: stage.cancelLabel } : {}),
  canApprove: stage.canApprove ?? false,
  ...(stage.approveLabel ? { approveLabel: stage.approveLabel } : {}),
  ...(stage.approvingLabel ? { approvingLabel: stage.approvingLabel } : {}),
  canReject: stage.canReject ?? false,
  canRecover: stage.canRecover ?? false,
  ...(stage.recoverPhase ? { recoverPhase: stage.recoverPhase } : {}),
  timeline: timelineFor(
    stage.currentTimelineId ?? stage.id,
    stage.failureTimeline ?? false,
    stage.completeCurrentTimeline ?? false,
  ),
});

const boardTaskInterruptPhase = (
  error: unknown,
): BoardTaskWorkflowPhase | undefined => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  let parsed: unknown = error;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = error;
    }
  }
  const interrupts = Array.isArray(parsed) ? parsed : undefined;
  if (!interrupts || interrupts.length === 0) return undefined;
  const phase = (interrupts[0] as { value?: { phase?: unknown } } | undefined)
    ?.value?.phase;
  return typeof phase === "string" && WORKFLOW_PHASES.has(phase)
    ? (phase as BoardTaskWorkflowPhase)
    : undefined;
};

const latestInteractivePhaseSession = (
  task: BoardTaskRecord,
): BoardTaskWorkflowPhase | undefined => {
  const sessions = Object.values(task.workflow?.phaseSessions ?? {});
  const latest = sessions
    .filter(
      (session) =>
        session !== undefined && INTERACTIVE_WORKFLOW_PHASES.has(session.phase),
    )
    .sort((a, b) =>
      (b.exitedAt ?? b.startedAt).localeCompare(a.exitedAt ?? a.startedAt),
    )[0];
  return latest?.phase;
};

const isPlannerTransientFailure = (task: BoardTaskRecord): boolean => {
  const message = `${task.error ?? ""}\n${task.workflow?.error ?? ""}`;
  return (
    /Agent idle for \d+ seconds/i.test(message) &&
    (/runWorkspace repository failed/i.test(message) ||
      /planner/i.test(message))
  );
};

const isAwaitingApprovalWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.status === "awaiting-approval" ||
    task.workflow?.currentPhase === "awaiting-approval");

const shouldExportApprovedPlanArtifacts = (task: BoardTaskRecord): boolean =>
  task.workflow?.approvedPlanAction === "export-artifacts";

const phaseSessionExitDiagnostic = (
  task: BoardTaskRecord,
  phase: BoardTaskWorkflowPhase,
): string => {
  const session = task.workflow?.phaseSessions?.[phase];
  if (session?.status !== "exited") return "";
  const exit =
    session.exitCode !== undefined ? ` with code ${session.exitCode}` : "";
  return ` The ${phase} terminal exited${exit}; inspect terminal output before continuing or recover the phase if it is stale.`;
};

const isExecutionRecoveryMessage = (task: BoardTaskRecord): boolean => {
  const message = [
    task.error,
    task.workflow?.error,
    task.workflow?.message,
    task.workflow?.status,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (
    /Executing approved workspace plan/i.test(message) ||
    /Retrying failed repository execution/i.test(message) ||
    /One or more repository executions failed/i.test(message) ||
    /Verification failed/i.test(message) ||
    /Verification incomplete/i.test(message) ||
    /Verification needs recovery/i.test(message) ||
    /Interrupted when the board server stopped or restarted/i.test(message) ||
    /Task cancelled/i.test(message)
  );
};

const isFailedExecutionWithPlan = (task: BoardTaskRecord): boolean =>
  task.plan !== undefined &&
  (task.workflow?.currentPhase === "running" ||
    task.workflow?.currentPhase === "verifying" ||
    task.workflow?.status === "running" ||
    task.workflow?.status === "verifying" ||
    task.workflow?.status === "retrying" ||
    task.workflow?.verificationStatus === "failed" ||
    task.workflow?.verificationStatus === "needs-recovery" ||
    task.workflow?.verificationStatus === "needs-verification" ||
    isExecutionRecoveryMessage(task));

export const recoverableBoardTaskPhase = (
  task: BoardTaskRecord,
): BoardTaskWorkflowPhase | undefined => {
  if (task.status !== "failed") return undefined;
  const interruptPhase =
    boardTaskInterruptPhase(task.error) ??
    boardTaskInterruptPhase(task.workflow?.error);
  if (interruptPhase) return interruptPhase;
  if (isAwaitingApprovalWithPlan(task)) return "awaiting-approval";
  if (isFailedExecutionWithPlan(task)) return "running";
  if (task.plan) return undefined;
  const currentPhase = task.workflow?.currentPhase;
  if (currentPhase && INTERACTIVE_WORKFLOW_PHASES.has(currentPhase)) {
    return currentPhase;
  }
  if (task.workflow?.status === "failed") {
    const latestPhase = latestInteractivePhaseSession(task);
    if (latestPhase) return latestPhase;
  }
  if (isPlannerTransientFailure(task)) return "creating-issues";
  return undefined;
};

export const getBoardTaskStage = (task: BoardTaskRecord): BoardTaskStage => {
  if (task.status === "succeeded") {
    return boardTaskStage({
      id: "succeeded",
      label: "Succeeded",
      mode: "complete",
      description: "The board task completed successfully.",
      currentTimelineId: "verifying",
      completeCurrentTimeline: true,
    });
  }

  if (task.status === "failed") {
    const recoverPhase = recoverableBoardTaskPhase(task);
    if (recoverPhase) {
      return boardTaskStage({
        id: "failed-recoverable",
        label: "Recover workflow phase",
        mode: "failed",
        description: `The task failed while ${PHASE_LABELS[recoverPhase].toLowerCase()} was recoverable.`,
        currentTimelineId:
          task.workflow?.currentPhase === "verifying"
            ? "verifying"
            : recoverPhase,
        canRecover: true,
        recoverPhase,
        failureTimeline: true,
      });
    }
    return boardTaskStage({
      id: "failed",
      label: "Failed",
      mode: "failed",
      description:
        "The board task failed and cannot be recovered automatically.",
      currentTimelineId: task.workflow?.currentPhase ?? "running",
      failureTimeline: true,
    });
  }

  const workflow = task.workflow;
  if (!workflow) {
    return boardTaskStage({
      id: task.status === "pending" ? "pending" : "starting",
      label: task.status === "pending" ? "Pending" : "Starting workflow",
      mode: task.status === "pending" ? "pending" : "background",
      description:
        task.status === "pending"
          ? "The task has not started yet."
          : "The board is starting the task workflow.",
      currentTimelineId: "classifying",
    });
  }

  if (
    workflow.currentPhase === "creating-issues" &&
    workflow.substatus === "validating-workspace-plan"
  ) {
    return boardTaskStage({
      id: "validating-workspace-plan",
      label: "Validating workspace plan",
      mode: "background",
      description:
        "Importing and validating the workspace_plan block from the phase transcript.",
      canCancel: task.status === "running",
      cancelLabel: "Cancel issue generation",
    });
  }

  if (
    workflow.currentPhase === "creating-issues" &&
    workflow.substatus === "fixing-workspace-plan"
  ) {
    return boardTaskStage({
      id: "fix-workspace-plan",
      label: "Fix workspace plan",
      mode: "interactive",
      description:
        "Fix the workspace_plan block in the creating-issues terminal, then complete the phase again.",
      currentTimelineId: "creating-issues",
      terminalPhase: "creating-issues",
      canComplete: true,
      canCancel: task.status === "running",
      cancelLabel: "Cancel issue generation",
    });
  }

  const phase = workflow.currentPhase ?? workflow.status;
  if (
    typeof phase === "string" &&
    WORKFLOW_PHASES.has(phase) &&
    INTERACTIVE_WORKFLOW_PHASES.has(phase as BoardTaskWorkflowPhase)
  ) {
    const currentPhase = phase as BoardTaskWorkflowPhase;
    return boardTaskStage({
      id: currentPhase,
      label: PHASE_LABELS[currentPhase],
      mode: "interactive",
      description: `${PHASE_DESCRIPTIONS[currentPhase]}${phaseSessionExitDiagnostic(task, currentPhase)}`,
      terminalPhase: currentPhase,
      canComplete: true,
      canCancel: task.status === "running",
      cancelLabel: "Cancel phase",
    });
  }

  if (workflow.status === "awaiting-approval") {
    const exportArtifacts = shouldExportApprovedPlanArtifacts(task);
    return boardTaskStage({
      id: "awaiting-approval",
      label: exportArtifacts ? "Awaiting export approval" : "Awaiting approval",
      mode: "approval",
      description: exportArtifacts
        ? "Review the generated workspace plan before exporting planning artifacts."
        : "Review the generated workspace plan before AFK execution.",
      canApprove: true,
      ...(exportArtifacts
        ? {
            approveLabel: "Export artifacts",
            approvingLabel: "Exporting artifacts...",
          }
        : {}),
      canReject: true,
    });
  }

  if (
    workflow.currentPhase === "running" ||
    workflow.status === "approved" ||
    workflow.status === "running" ||
    workflow.status === "retrying"
  ) {
    return boardTaskStage({
      id: "running",
      label:
        workflow.status === "retrying"
          ? "Retrying AFK execution"
          : "Running AFK execution",
      mode: "afk",
      description:
        workflow.status === "retrying"
          ? "Retrying failed repository execution for the approved plan."
          : "Executing the approved workspace plan in repository runs.",
      canCancel: task.status === "running",
      cancelLabel:
        workflow.status === "retrying" ? "Cancel retry" : "Cancel execution",
    });
  }

  if (
    workflow.currentPhase === "verifying" ||
    workflow.status === "verifying"
  ) {
    return boardTaskStage({
      id: "verifying",
      label: "Verifying delivery",
      mode: "background",
      description:
        workflow.message ??
        "Running the Evaluator agent against repository evidence, completion evidence, commits, and infrastructure failures.",
      canCancel: task.status === "running",
      cancelLabel: "Cancel verification",
    });
  }

  return boardTaskStage({
    id: "workflow-progress",
    label: "Workflow in progress",
    mode: "background",
    description: workflow.message ?? "The board workflow is making progress.",
    currentTimelineId: workflow.currentPhase ?? "classifying",
  });
};

export const boardTaskView = (task: BoardTaskRecord): BoardTaskView => ({
  ...task,
  stage: getBoardTaskStage(task),
});

/**
 * File-backed persistence for the workflow board.
 *
 * Deliberately dependency-free (no SQLite native module): the board is an
 * optional, local feature and a native build dependency would burden every
 * install of the published package. Runs, their event streams, and tasks are
 * stored as JSON / NDJSON files under a base directory (default
 * `.sandcastle/board/`). The narrow public surface keeps the storage engine
 * swappable. In-process subscribers drive the server's SSE stream.
 */
export class BoardStore {
  private readonly runsDir: string;
  private readonly tasksDir: string;
  private readonly listeners = new Set<ChangeListener>();
  /** Per-run event sequence counters, kept in memory and rebuilt lazily. */
  private readonly seqCounters = new Map<string, number>();
  private readonly watchers: FSWatcher[] = [];
  /**
   * Absolute file paths this instance just wrote, with a timestamp. Used to
   * suppress the `fs.watch` echo of our own writes so cross-process watching
   * only surfaces changes made by *other* processes.
   */
  private readonly recentSelfWrites = new Map<string, number>();
  private static readonly SELF_WRITE_WINDOW_MS = 1500;

  constructor(private readonly baseDir: string) {
    this.runsDir = join(baseDir, "runs");
    this.tasksDir = join(baseDir, "tasks");
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true });
    this.failInterruptedRecords();
  }

  private runMetaPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  private runEventsPath(id: string): string {
    return join(this.runsDir, `${id}.events.ndjson`);
  }

  private taskPath(id: string): string {
    return join(this.tasksDir, `${id}.json`);
  }

  private taskDir(id: string): string {
    return join(this.tasksDir, id);
  }

  taskAssetsDir(id: string): string {
    return join(this.taskDir(id), "assets");
  }

  taskProgressPath(id: string): string {
    return join(this.taskDir(id), "progress.md");
  }

  taskVerificationPath(id: string): string {
    return join(this.taskDir(id), "verification.md");
  }

  taskArtifactManifestPath(id: string): string {
    return join(this.taskDir(id), "artifacts.json");
  }

  taskIssuePath(id: string, repoName: string): string {
    return join(
      this.taskDir(id),
      "issues",
      `${sanitizeIssueArtifactSegment(repoName)}.md`,
    );
  }

  private writeRun(run: BoardRunRecord): void {
    const path = this.runMetaPath(run.id);
    this.recentSelfWrites.set(path, Date.now());
    writeFileSync(path, JSON.stringify(run, null, 2));
    this.publish({ kind: "run-updated", run });
  }

  private failInterruptedRecords(): void {
    const now = new Date().toISOString();
    const message = "Interrupted when the board server stopped or restarted.";
    for (const run of this.listRuns()) {
      if (run.status !== "running") continue;
      const failed: BoardRunRecord = {
        ...run,
        status: "failed",
        finishedAt: now,
        error: message,
      };
      this.writeRun(failed);
      const record: BoardRunEventRecord = {
        seq: this.nextSeq(run.id),
        event: {
          type: "run-failed",
          message,
          timestamp: now,
        },
      };
      appendFileSync(this.runEventsPath(run.id), JSON.stringify(record) + "\n");
      this.publish({ kind: "run-event", runId: run.id, record });
    }
    for (const task of this.listTasks()) {
      if (task.status !== "running") continue;
      if (isAwaitingApprovalWithPlan(task)) continue;
      this.writeTask({
        ...task,
        status: "failed",
        finishedAt: now,
        error: message,
      });
    }
  }

  private publish(change: BoardChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A broken subscriber must not break recording.
      }
    }
  }

  /** Subscribe to board changes. Returns an unsubscribe function. */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Create a new run in the `running` state. */
  createRun(input: CreateRunInput): BoardRunRecord {
    const run: BoardRunRecord = {
      id: randomUUID(),
      name: input.name,
      agent: input.agent,
      model: input.model,
      sandbox: input.sandbox,
      branch: input.branch,
      maxIterations: input.maxIterations,
      status: "running",
      createdAt: new Date().toISOString(),
      commits: 0,
      taskId: input.taskId,
      repo: input.repo,
    };
    this.seqCounters.set(run.id, 0);
    this.writeRun(run);
    return run;
  }

  /** List all runs, newest first. */
  listRuns(): BoardRunRecord[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".events.ndjson"))
      .map((f) => {
        try {
          return JSON.parse(
            readFileSync(join(this.runsDir, f), "utf8"),
          ) as BoardRunRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is BoardRunRecord => r !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): BoardRunRecord | undefined {
    const path = this.runMetaPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as BoardRunRecord;
    } catch {
      return undefined;
    }
  }

  getEvents(id: string): BoardRunEventRecord[] {
    const path = this.runEventsPath(id);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as BoardRunEventRecord);
  }

  private nextSeq(runId: string): number {
    let current = this.seqCounters.get(runId);
    if (current === undefined) {
      // Rebuild from disk (e.g. after a fresh process attaches to the store).
      current = this.getEvents(runId).reduce(
        (max, r) => Math.max(max, r.seq),
        0,
      );
    }
    const next = current + 1;
    this.seqCounters.set(runId, next);
    return next;
  }

  /**
   * Append a run-event for `runId`, persist it, fold its effect into the run
   * record (status, completion, commit count), and broadcast to subscribers.
   */
  recordEvent(runId: string, event: RunEvent): BoardRunEventRecord {
    const record: BoardRunEventRecord = {
      seq: this.nextSeq(runId),
      event: serializeEvent(event),
    };
    appendFileSync(this.runEventsPath(runId), JSON.stringify(record) + "\n");
    this.publish({ kind: "run-event", runId, record });

    const run = this.getRun(runId);
    if (run) {
      let next: BoardRunRecord = {
        ...run,
        lastEventType: event.type,
        lastEventAt: event.timestamp.toISOString(),
      };
      if (event.type === "iteration-started") {
        next = {
          ...next,
          currentIteration: event.iteration,
        };
      } else if (event.type === "usage") {
        const usage = event.usage;
        next = {
          ...next,
          currentIteration: event.iteration,
          totalTokens:
            (run.totalTokens ?? 0) +
            usage.inputTokens +
            usage.cacheCreationInputTokens +
            usage.cacheReadInputTokens +
            usage.outputTokens,
        };
      } else if (event.type === "agent-text") {
        next = { ...next, currentIteration: event.iteration };
      } else if (event.type === "agent-tool-call") {
        next = { ...next, currentIteration: event.iteration };
      } else if (event.type === "agent-tool-result") {
        next = { ...next, currentIteration: event.iteration };
      } else if (event.type === "agent-idle-warning") {
        next = { ...next, currentIteration: event.iteration };
      } else if (event.type === "commit") {
        next = {
          ...next,
          commits: run.commits + 1,
          currentIteration: event.iteration,
        };
      } else if (event.type === "run-finished") {
        next = {
          ...next,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          completionSignal: event.completionSignal,
          iterationsRun: event.iterationsRun,
          currentIteration: event.iterationsRun,
        };
      } else if (event.type === "run-failed") {
        next = {
          ...next,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: event.message,
        };
      }
      this.writeRun(next);
      if (next.taskId) this.refreshTaskProgress(next.taskId);
    }
    return record;
  }

  /** Aggregate per-model token usage from a run's `usage` events. */
  aggregateUsageByModel(runId: string): BoardUsageByModel[] {
    const totals = new Map<string, BoardUsageByModel>();
    for (const { event } of this.getEvents(runId)) {
      if (event.type !== "usage") continue;
      const model = event.model ?? "unknown";
      const prev =
        totals.get(model) ??
        ({
          model,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        } satisfies BoardUsageByModel);
      const u = event.usage;
      const merged: BoardUsageByModel = {
        model,
        inputTokens: prev.inputTokens + u.inputTokens,
        cacheCreationInputTokens:
          prev.cacheCreationInputTokens + u.cacheCreationInputTokens,
        cacheReadInputTokens:
          prev.cacheReadInputTokens + u.cacheReadInputTokens,
        outputTokens: prev.outputTokens + u.outputTokens,
        totalTokens:
          prev.totalTokens +
          u.inputTokens +
          u.cacheCreationInputTokens +
          u.cacheReadInputTokens +
          u.outputTokens,
      };
      totals.set(model, merged);
    }
    return [...totals.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }

  // --- Tasks ---------------------------------------------------------------

  createTask(input: { title: string; prompt: string }): BoardTaskRecord {
    const task: BoardTaskRecord = {
      id: randomUUID(),
      title: input.title,
      prompt: input.prompt,
      status: "pending",
      createdAt: new Date().toISOString(),
      runIds: [],
    };
    this.writeTask(task);
    return task;
  }

  private writeTask(task: BoardTaskRecord): void {
    const path = this.taskPath(task.id);
    this.recentSelfWrites.set(path, Date.now());
    writeFileSync(path, JSON.stringify(task, null, 2));
    this.publish({ kind: "task-updated", task });
  }

  readTaskProgress(id: string): string | undefined {
    const path = this.taskProgressPath(id);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }

  writeTaskProgress(id: string, markdown: string): void {
    const progressDir = join(this.tasksDir, id);
    mkdirSync(progressDir, { recursive: true });
    writeFileSync(this.taskProgressPath(id), markdown);
  }

  readTaskIssue(id: string, repoName: string): string | undefined {
    const path = this.taskIssuePath(id, repoName);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }

  writeTaskIssue(id: string, repoName: string, markdown: string): void {
    const issueDir = join(this.tasksDir, id, "issues");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(this.taskIssuePath(id, repoName), markdown);
  }

  syncTaskIssueStatuses(
    id: string,
    statuses: Partial<Record<string, LocalIssueStatus>>,
  ): void {
    const task = this.getTask(id);
    if (!task?.plan) return;
    for (const repo of task.plan.repositories) {
      const status = statuses[repo.name] ?? "ready-for-agent";
      const current =
        this.readTaskIssue(id, repo.name) ?? issueMarkdownFor(repo);
      this.writeTaskIssue(
        id,
        repo.name,
        updateLocalIssueStatusMarkdown(current, status),
      );
    }
  }

  readTaskVerification(id: string): string | undefined {
    const path = this.taskVerificationPath(id);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }

  writeTaskVerification(id: string, markdown: string): void {
    const taskDir = this.taskDir(id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(this.taskVerificationPath(id), markdown);
  }

  writeTaskArtifactManifest(
    id: string,
    artifacts: readonly BoardTaskArtifact[],
  ): void {
    const taskDir = this.taskDir(id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      this.taskArtifactManifestPath(id),
      `${JSON.stringify(
        artifacts.map((artifact) => ({
          ...artifact,
          absolutePath: resolve(artifact.absolutePath),
        })),
        null,
        2,
      )}\n`,
    );
  }

  private readTaskArtifactManifest(id: string): BoardTaskArtifact[] {
    const path = this.taskArtifactManifestPath(id);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as BoardTaskArtifact[];
    } catch {
      return [];
    }
  }

  private taskScopedArtifact(
    kind: BoardTaskArtifactKind,
    path: string,
  ): BoardTaskArtifact | undefined {
    if (!existsSync(path)) return undefined;
    return {
      kind,
      absolutePath: resolve(path),
      displayPath: relative(this.baseDir, path),
      createdAt: statSync(path).mtime.toISOString(),
    };
  }

  listTaskArtifacts(id: string): BoardTaskArtifact[] {
    const artifacts = [...this.readTaskArtifactManifest(id)];
    const progress = this.taskScopedArtifact(
      "progress",
      this.taskProgressPath(id),
    );
    if (progress) artifacts.push(progress);
    const verification = this.taskScopedArtifact(
      "verification",
      this.taskVerificationPath(id),
    );
    if (verification) artifacts.push(verification);

    const issueDir = join(this.taskDir(id), "issues");
    if (existsSync(issueDir)) {
      const issues = readdirSync(issueDir)
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => this.taskScopedArtifact("issue", join(issueDir, file)))
        .filter(
          (artifact): artifact is BoardTaskArtifact => artifact !== undefined,
        );
      artifacts.push(...issues);
    }
    const assetDir = this.taskAssetsDir(id);
    if (existsSync(assetDir)) {
      const assets = readdirSync(assetDir)
        .sort()
        .map((file) => this.taskScopedArtifact("asset", join(assetDir, file)))
        .filter(
          (artifact): artifact is BoardTaskArtifact => artifact !== undefined,
        );
      artifacts.push(...assets);
    }
    return artifacts;
  }

  refreshTaskProgress(id: string): string | undefined {
    const task = this.getTask(id);
    if (!task?.plan) return undefined;
    const runs = this.listRuns()
      .filter(
        (run) =>
          run.taskId === id &&
          run.repo !== "(planner)" &&
          run.repo !== "(evaluator)",
      )
      .map((run) => ({ run, events: this.getEvents(run.id) }));
    const markdown = renderTaskProgress(task, runs);
    if (!markdown) return undefined;
    this.writeTaskProgress(id, markdown);
    if (!task.workflow?.verificationStatus) {
      this.syncTaskIssueStatuses(
        id,
        Object.fromEntries(
          task.plan.repositories.map((repo) => {
            const latestRun = runs
              .filter(({ run }) => run.repo === repo.name)
              .sort((a, b) =>
                b.run.createdAt.localeCompare(a.run.createdAt),
              )[0]?.run;
            return [repo.name, issueStatusForRun(latestRun)];
          }),
        ),
      );
    }
    return markdown;
  }

  listTasks(): BoardTaskRecord[] {
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".workspace-plan.json"))
      .map((f) => {
        try {
          const parsed = JSON.parse(
            readFileSync(join(this.tasksDir, f), "utf8"),
          ) as Partial<BoardTaskRecord>;
          return typeof parsed.id === "string" &&
            typeof parsed.title === "string" &&
            typeof parsed.createdAt === "string" &&
            Array.isArray(parsed.runIds)
            ? (parsed as BoardTaskRecord)
            : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((t): t is BoardTaskRecord => t !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getTask(id: string): BoardTaskRecord | undefined {
    const path = this.taskPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as BoardTaskRecord;
    } catch {
      return undefined;
    }
  }

  updateTask(
    id: string,
    patch: Partial<Omit<BoardTaskRecord, "id" | "createdAt">>,
  ): BoardTaskRecord | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;
    const next: BoardTaskRecord = { ...task, ...patch };
    this.writeTask(next);
    if (next.plan) this.refreshTaskProgress(next.id);
    return next;
  }

  // --- Cross-process watching ----------------------------------------------

  /**
   * Watch the on-disk store for changes made by *other* processes (e.g. a
   * `sandcastle run` writing run events to the same board directory) and
   * republish them to in-process subscribers, so a single board server can
   * surface runs it did not itself launch.
   *
   * Echoes of this instance's own writes are suppressed via a short
   * self-write window. Only run/task metadata (`*.json`) is watched; per-event
   * NDJSON appends from external runs are not streamed line-by-line (selecting
   * the run loads its events on demand). Idempotent; returns immediately if
   * already watching.
   */
  startWatching(): void {
    if (this.watchers.length > 0) return;
    const watchDir = (dir: string, kind: "run" | "task"): void => {
      try {
        const watcher = watch(dir, (_event, filename) => {
          if (!filename) return;
          this.handleWatchedFile(kind, filename.toString());
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // Watching is best-effort; failure leaves in-process updates working.
      }
    };
    watchDir(this.runsDir, "run");
    watchDir(this.tasksDir, "task");
  }

  private handleWatchedFile(kind: "run" | "task", filename: string): void {
    if (!filename.endsWith(".json")) return;
    if (filename.endsWith(".events.ndjson")) return;
    const dir = kind === "run" ? this.runsDir : this.tasksDir;
    const path = join(dir, filename);
    const wroteAt = this.recentSelfWrites.get(path);
    if (
      wroteAt !== undefined &&
      Date.now() - wroteAt < BoardStore.SELF_WRITE_WINDOW_MS
    ) {
      this.recentSelfWrites.delete(path);
      return;
    }
    const id = filename.slice(0, -".json".length);
    if (kind === "run") {
      const run = this.getRun(id);
      if (run) this.publish({ kind: "run-updated", run });
    } else {
      const task = this.getTask(id);
      if (task) this.publish({ kind: "task-updated", task });
    }
  }

  /** Stop any file watchers. Safe to call when not watching. */
  close(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
  }
}

/**
 * Build an `onRunEvent` callback that records a single run into the store.
 *
 * The run is created lazily on the `run-started` event, so the recorder needs
 * no run id up front. Optional `taskId`/`repo` link the run to a board task
 * (used by the workspace task launcher).
 */
export const createRunRecorder = (
  store: BoardStore,
  link?: { taskId?: string; repo?: string },
): ((event: RunEvent) => void) => {
  let runId: string | undefined;
  let closed = false;
  return (event: RunEvent) => {
    if (event.type === "run-started") {
      runId = store.createRun({
        name: event.name,
        agent: event.agent,
        model: event.model,
        sandbox: event.sandbox,
        branch: event.branch,
        maxIterations: event.maxIterations,
        taskId: link?.taskId,
        repo: link?.repo,
      }).id;
      closed = false;
    }
    if (!runId || closed) return;
    store.recordEvent(runId, event);
    if (event.type === "run-failed" || event.type === "run-finished") {
      closed = true;
      runId = undefined;
    }
  };
};
