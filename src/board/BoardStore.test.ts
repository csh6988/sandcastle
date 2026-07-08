import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoardStore,
  boardTaskView,
  createRunRecorder,
  getBoardTaskStage,
} from "./BoardStore.js";
import type { RuntimeEvent } from "../RuntimeEvent.js";

const startedEvent = (
  overrides: Partial<Extract<RuntimeEvent, { type: "run.started" }>> = {},
): RuntimeEvent => ({
  type: "run.started",
  runId: "run-1",
  name: "my-run",
  agent: "claude-code",
  model: "claude-opus-4-8",
  sandbox: "docker",
  branch: "sandcastle/temp",
  maxIterations: 3,
  timestamp: new Date(),
  ...overrides,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("BoardStore", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-store-"));
    store = new BoardStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a run in the running state and lists it", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      model: "claude-opus-4-8",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    expect(run.status).toBe("running");
    expect(store.listRuns().map((r) => r.id)).toContain(run.id);
    expect(store.getRun(run.id)?.model).toBe("claude-opus-4-8");
  });

  it("records events with increasing sequence and reads them back", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "iteration.started",
      runId: "run-1",
      iteration: 1,
      maxIterations: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      text: "hello",
      iteration: 1,
      timestamp: new Date(),
    });
    const events = store.getEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1]!.event.type).toBe("message.delta");
    // Timestamp serialized to an ISO string.
    expect(typeof events[1]!.event.timestamp).toBe("string");
    expect(store.getRun(run.id)).toMatchObject({
      currentIteration: 1,
      lastEventType: "message.delta",
    });
  });

  it("folds run.finished into a succeeded status and commit count", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 2,
    });
    store.recordEvent(run.id, {
      type: "commit.created",
      runId: "run-1",
      sha: "abc",
      iteration: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "run.finished",
      runId: "run-1",
      commits: [],
      completionSignal: "<promise>COMPLETE</promise>",
      iterationsRun: 1,
      timestamp: new Date(),
    });
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe("succeeded");
    expect(updated.commits).toBe(1);
    expect(updated.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(updated.iterationsRun).toBe(1);
    expect(updated.currentIteration).toBe(1);
    expect(updated.lastEventType).toBe("run.finished");
    expect(updated.finishedAt).toBeTruthy();
  });

  it("folds run.error into a failed status with the error message", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "run.error",
      runId: "run-1",
      message: "boom",
      timestamp: new Date(),
    });
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("boom");
    expect(updated.lastEventType).toBe("run.error");
  });

  it("preserves structured recovery evidence on run.error through serialization", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "run.error",
      runId: "run-1",
      message: "agent exited with code 1",
      recovery: {
        failureKind: "agent",
        failurePhase: "agent",
        preservedWorktreePath: "/host/worktrees/repo",
        runLogPath: "/host/logs/repo.log",
        sessionId: "sess-1",
        completionSignalSeen: false,
        commits: ["abc123"],
      },
      timestamp: new Date(),
    });

    // Read back from a fresh store instance to prove it survives the on-disk
    // JSON round-trip (only `timestamp` is remapped; new fields flow through).
    const reopened = new BoardStore(dir);
    const failed = reopened
      .getEvents(run.id)
      .map((r) => r.event)
      .find((e) => e.type === "run.error");
    expect(failed).toBeDefined();
    if (failed?.type === "run.error") {
      expect(failed.recovery).toEqual({
        failureKind: "agent",
        failurePhase: "agent",
        preservedWorktreePath: "/host/worktrees/repo",
        runLogPath: "/host/logs/repo.log",
        sessionId: "sess-1",
        completionSignalSeen: false,
        commits: ["abc123"],
      });
    }
  });

  it("marks running records as failed when a new store attaches after restart", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    const task = store.createTask({ title: "Add feature", prompt: "do it" });
    store.updateTask(task.id, { status: "running", runIds: [run.id] });

    const restarted = new BoardStore(dir);

    expect(restarted.getRun(run.id)).toMatchObject({
      status: "failed",
      error: "Interrupted when the board server stopped or restarted.",
    });
    expect(restarted.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "Interrupted when the board server stopped or restarted.",
    });
    expect(
      restarted.getEvents(run.id).some((r) => r.event.type === "run.error"),
    ).toBe(true);
  });

  it("aggregates token usage per model", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 2,
    });
    const usage = {
      inputTokens: 100,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
      outputTokens: 5,
    };
    store.recordEvent(run.id, {
      type: "usage.recorded",
      runId: "run-1",
      usage,
      model: "claude-opus-4-8",
      iteration: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "usage.recorded",
      runId: "run-1",
      usage,
      model: "claude-opus-4-8",
      iteration: 2,
      timestamp: new Date(),
    });
    const agg = store.aggregateUsageByModel(run.id);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({
      model: "claude-opus-4-8",
      inputTokens: 200,
      outputTokens: 10,
      totalTokens: 270,
    });
    expect(store.getRun(run.id)).toMatchObject({
      currentIteration: 2,
      lastEventType: "usage.recorded",
      totalTokens: 270,
    });
  });

  it("notifies subscribers of run and event changes", () => {
    const kinds: string[] = [];
    const unsubscribe = store.subscribe((c) => kinds.push(c.kind));
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "run.finished",
      runId: "run-1",
      commits: [],
      iterationsRun: 1,
      timestamp: new Date(),
    });
    unsubscribe();
    expect(kinds).toContain("run-updated");
    expect(kinds).toContain("runtime-event");
  });

  it("manages task lifecycle", () => {
    const task = store.createTask({ title: "Add feature", prompt: "do it" });
    expect(task.status).toBe("pending");
    const updated = store.updateTask(task.id, {
      status: "running",
      runIds: ["run-1"],
    });
    expect(updated?.status).toBe("running");
    expect(store.listTasks().map((t) => t.id)).toContain(task.id);
  });

  it("does not treat task-scoped workspace plan files as board tasks", () => {
    const task = store.createTask({ title: "Add feature", prompt: "do it" });
    writeFileSync(
      join(dir, "tasks", `${task.id}.workspace-plan.json`),
      JSON.stringify({ repositories: [{ name: "web", task: "do it" }] }),
    );

    expect(store.listTasks().map((t) => t.id)).toEqual([task.id]);
  });

  it("initializes a board progress document when a task receives a plan", () => {
    const task = store.createTask({ title: "Add feature", prompt: "do it" });

    store.updateTask(task.id, {
      plan: {
        repositories: [
          {
            name: "web",
            task: "Add the page",
            reason: "User-facing UI",
            issue: {
              title: "Add page",
              body: "Implement the planned page.",
            },
          },
        ],
      },
    });

    expect(store.taskProgressPath(task.id)).toBe(
      join(dir, "tasks", task.id, "progress.md"),
    );
    expect(store.readTaskProgress(task.id)).toContain(
      "# Board Execution Progress",
    );
    expect(store.readTaskProgress(task.id)).toContain("## Repository: web");
    expect(store.readTaskProgress(task.id)).toContain(
      "Issue status: ready-for-agent",
    );
    expect(store.readTaskProgress(task.id)).toContain("Status: pending");
    expect(store.readTaskProgress(task.id)).toContain("Task: Add the page");
    expect(store.taskIssuePath(task.id, "web")).toBe(
      join(dir, "tasks", task.id, "issues", "web.md"),
    );
    expect(store.readTaskIssue(task.id, "web")).toContain("# Add page");
    expect(store.readTaskIssue(task.id, "web")).toContain(
      "status: ready-for-agent",
    );
  });

  it("persists a board task verification report next to progress artifacts", () => {
    const task = store.createTask({ title: "Verify feature", prompt: "do it" });

    store.writeTaskVerification(
      task.id,
      "# Board Verification Report\n\nStatus: passed\n",
    );

    expect(store.taskVerificationPath(task.id)).toBe(
      join(dir, "tasks", task.id, "verification.md"),
    );
    expect(store.readTaskVerification(task.id)).toBe(
      "# Board Verification Report\n\nStatus: passed\n",
    );
  });

  it("persists and lists a task artifact manifest", () => {
    const task = store.createTask({ title: "Export plan", prompt: "do it" });
    const createdAt = "2026-06-30T12:00:00.000Z";
    const planPath = join(dir, "exports", "workspace-plan.json");
    const issuePath = join(dir, "exports", "issues", "web.md");

    store.writeTaskArtifactManifest(task.id, [
      {
        kind: "workspace-plan",
        absolutePath: planPath,
        displayPath: ".scratch/export-plan/workspace-plan.json",
        createdAt,
      },
      {
        kind: "issue",
        absolutePath: issuePath,
        displayPath: ".scratch/export-plan/issues/web.md",
        createdAt,
      },
    ]);

    expect(store.taskArtifactManifestPath(task.id)).toBe(
      join(dir, "tasks", task.id, "artifacts.json"),
    );
    expect(
      JSON.parse(readFileSync(store.taskArtifactManifestPath(task.id), "utf8")),
    ).toEqual([
      {
        kind: "workspace-plan",
        absolutePath: planPath,
        displayPath: ".scratch/export-plan/workspace-plan.json",
        createdAt,
      },
      {
        kind: "issue",
        absolutePath: issuePath,
        displayPath: ".scratch/export-plan/issues/web.md",
        createdAt,
      },
    ]);
    expect(store.listTaskArtifacts(task.id)).toEqual([
      {
        kind: "workspace-plan",
        absolutePath: planPath,
        displayPath: ".scratch/export-plan/workspace-plan.json",
        createdAt,
      },
      {
        kind: "issue",
        absolutePath: issuePath,
        displayPath: ".scratch/export-plan/issues/web.md",
        createdAt,
      },
    ]);
  });

  it("updates task progress from linked repository runtime events", () => {
    const task = store.createTask({ title: "Fix UI", prompt: "do it" });
    store.updateTask(task.id, {
      plan: {
        repositories: [{ name: "web", task: "Fix the UI" }],
      },
    });
    const recorder = createRunRecorder(store, { taskId: task.id, repo: "web" });

    recorder(startedEvent({ name: "task web", branch: "sandcastle/web" }));
    recorder({
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      text: "I changed the component and will run tests next.",
      iteration: 1,
      timestamp: new Date(),
    });
    recorder({
      type: "run.error",
      runId: "run-1",
      message: "lint failed",
      timestamp: new Date(),
    });

    const progress = store.readTaskProgress(task.id)!;
    expect(progress).toContain("Issue status: needs-recovery");
    expect(progress).toContain("Status: needs_recovery");
    expect(progress).toContain("Branch: sandcastle/web");
    expect(progress).toContain(
      "agent text: I changed the component and will run tests next.",
    );
    expect(progress).toContain("Address the last failure: lint failed");
    expect(store.readTaskIssue(task.id, "web")).toContain(
      "status: needs-recovery",
    );
  });

  it("syncs verification issue status to existing issue markdown without overwriting the body", () => {
    const task = store.createTask({ title: "Verify UI", prompt: "do it" });
    store.updateTask(task.id, {
      plan: {
        repositories: [
          {
            name: "web",
            task: "Fix UI",
            issue: {
              title: "Fix UI",
              body: "status: ready-for-agent\n\nOriginal issue body.",
            },
          },
        ],
      },
    });
    store.writeTaskIssue(
      task.id,
      "web",
      "# Fix UI\n\nstatus: in-progress\n\nHuman-edited body.\n",
    );

    store.syncTaskIssueStatuses(task.id, {
      web: "verification-failed",
    });

    expect(store.readTaskIssue(task.id, "web")).toBe(
      "# Fix UI\n\nstatus: verification-failed\n\nHuman-edited body.\n",
    );
  });

  it("maps interactive workflow phases to stable display stages", () => {
    const task = store.createTask({ title: "Plan", prompt: "do it" });
    const updated = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(updated)).toMatchObject({
      id: "creating-issues",
      label: "Creating issues",
      mode: "interactive",
      terminalPhase: "creating-issues",
      canComplete: true,
      canCancel: true,
      cancelLabel: "Cancel phase",
    });
    expect(
      getBoardTaskStage(updated).timeline.find(
        (item) => item.id === "creating-issues",
      ),
    ).toMatchObject({ status: "current" });
  });

  it("surfaces exited phase terminals in the interactive stage description", () => {
    const task = store.createTask({ title: "Plan", prompt: "do it" });
    const updated = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "classifying",
        currentPhase: "classifying",
        phaseSessions: {
          classifying: {
            taskId: task.id,
            phase: "classifying",
            pid: 1234,
            status: "exited",
            startedAt: "2026-06-26T07:00:00.000Z",
            exitedAt: "2026-06-26T07:01:00.000Z",
            exitCode: 130,
          },
        },
        updatedAt: "2026-06-26T07:01:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(updated)).toMatchObject({
      id: "classifying",
      description:
        "Classify the task and decide how the board should treat it. The classifying terminal exited with code 130; inspect terminal output before continuing or recover the phase if it is stale.",
    });
  });

  it("maps workspace plan validation and fix states without exposing planner internals", () => {
    const task = store.createTask({ title: "Import plan", prompt: "do it" });
    const validating = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "planning",
        currentPhase: "creating-issues",
        substatus: "validating-workspace-plan",
        message: "Importing the workspace plan from the phase transcript.",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(validating)).toMatchObject({
      id: "validating-workspace-plan",
      label: "Validating workspace plan",
      mode: "background",
      canComplete: false,
      canCancel: true,
      cancelLabel: "Cancel issue generation",
    });

    const fixing = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        substatus: "fixing-workspace-plan",
        message:
          "Board could not import a workspace plan from this phase. Fix the <workspace_plan> block, then complete the phase again.",
        updatedAt: "2026-06-26T07:01:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(fixing)).toMatchObject({
      id: "fix-workspace-plan",
      label: "Fix workspace plan",
      mode: "interactive",
      terminalPhase: "creating-issues",
      canComplete: true,
      canCancel: true,
      cancelLabel: "Cancel issue generation",
    });
  });

  it("maps approval, AFK execution, and recoverable failures to task stages", () => {
    const task = store.createTask({ title: "Execute", prompt: "do it" });
    const awaitingApproval = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(awaitingApproval)).toMatchObject({
      id: "awaiting-approval",
      label: "Awaiting approval",
      mode: "approval",
      canApprove: true,
      canReject: true,
    });

    const running = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "running",
        currentPhase: "running",
        updatedAt: "2026-06-26T07:01:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(running)).toMatchObject({
      id: "running",
      label: "Running AFK execution",
      mode: "afk",
      canComplete: false,
      canCancel: true,
      cancelLabel: "Cancel execution",
    });

    const verifying = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "verifying",
        currentPhase: "verifying",
        verificationStatus: "passed",
        updatedAt: "2026-06-26T07:01:30.000Z",
      },
    })!;

    expect(getBoardTaskStage(verifying)).toMatchObject({
      id: "verifying",
      label: "Verifying delivery",
      mode: "background",
      canComplete: false,
      canCancel: true,
      cancelLabel: "Cancel verification",
    });

    const succeeded = store.updateTask(task.id, {
      status: "succeeded",
      workflow: {
        status: "succeeded",
        currentPhase: "verifying",
        verificationStatus: "passed",
        updatedAt: "2026-06-26T07:01:40.000Z",
      },
    })!;

    expect(
      getBoardTaskStage(succeeded).timeline.find(
        (item) => item.id === "verifying",
      ),
    ).toMatchObject({
      status: "complete",
    });

    const failed = store.updateTask(task.id, {
      status: "failed",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds",
      workflow: {
        status: "failed",
        currentPhase: "creating-issues",
        updatedAt: "2026-06-26T07:02:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(failed)).toMatchObject({
      id: "failed-recoverable",
      label: "Recover workflow phase",
      mode: "failed",
      canRecover: true,
      recoverPhase: "creating-issues",
    });
  });

  it("maps planning-only approval to artifact export copy", () => {
    const task = store.createTask({
      title: "Export artifacts",
      prompt: "plan only",
    });
    const awaitingExport = store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        approvedPlanAction: "export-artifacts",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(boardTaskView(awaitingExport)).toMatchObject({
      workflow: {
        approvedPlanAction: "export-artifacts",
      },
      stage: {
        id: "awaiting-approval",
        label: "Awaiting export approval",
        description:
          "Review the generated workspace plan before exporting planning artifacts.",
        canApprove: true,
        canReject: true,
        approveLabel: "Export artifacts",
        approvingLabel: "Exporting artifacts...",
      },
    });
  });

  it("keeps tasks waiting for approval running across store restarts", () => {
    const task = store.createTask({ title: "Approve", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const restarted = new BoardStore(dir).getTask(task.id)!;

    expect(restarted.status).toBe("running");
    expect(restarted.error).toBeUndefined();
    expect(getBoardTaskStage(restarted)).toMatchObject({
      id: "awaiting-approval",
      canApprove: true,
      canReject: true,
    });
  });

  it("marks interrupted approval tasks as recoverable to approval", () => {
    const task = store.createTask({
      title: "Recover approval",
      prompt: "do it",
    });
    const failedApproval = store.updateTask(task.id, {
      status: "failed",
      error: "Interrupted when the board server stopped or restarted.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "awaiting-approval",
        currentPhase: "awaiting-approval",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(failedApproval)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "awaiting-approval",
    });
  });

  it("marks failed approved execution tasks as recoverable to execution", () => {
    const task = store.createTask({
      title: "Retry execution",
      prompt: "do it",
    });
    const failedExecution = store.updateTask(task.id, {
      status: "failed",
      error: "One or more repository executions failed.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "failed",
        currentPhase: "running",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(failedExecution)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "running",
    });
  });

  it("marks failed verification tasks as recoverable execution repair", () => {
    const task = store.createTask({
      title: "Repair verification",
      prompt: "do it",
    });
    const failedVerification = store.updateTask(task.id, {
      status: "failed",
      error:
        "Verification failed: repository web did not pass delivery checks.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "failed",
        currentPhase: "verifying",
        verificationStatus: "failed",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(failedVerification)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "running",
    });
    expect(
      getBoardTaskStage(failedVerification).timeline.find(
        (item) => item.id === "verifying",
      ),
    ).toMatchObject({ status: "failed" });
  });

  it("keeps interrupted running execution tasks recoverable after store close", () => {
    const task = store.createTask({
      title: "Interrupted execution",
      prompt: "do it",
    });
    store.updateTask(task.id, {
      status: "running",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "running",
        currentPhase: "running",
        message: "Executing approved workspace plan.",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const restarted = new BoardStore(dir);

    expect(getBoardTaskStage(restarted.getTask(task.id)!)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "running",
    });
    restarted.close();
  });

  it("recovers older interrupted execution tasks from their execution message", () => {
    const task = store.createTask({
      title: "Interrupted execution",
      prompt: "do it",
    });
    const interrupted = store.updateTask(task.id, {
      status: "failed",
      error: "Interrupted when the board server stopped or restarted.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "failed",
        message: "Executing approved workspace plan.",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(interrupted)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "running",
    });
  });

  it("marks cancelled tasks with an approved plan as recoverable execution", () => {
    const task = store.createTask({
      title: "Cancelled execution",
      prompt: "do it",
    });
    const cancelled = store.updateTask(task.id, {
      status: "failed",
      error: "Task cancelled.",
      plan: {
        repositories: [{ name: "web", task: "Do it" }],
      },
      workflow: {
        status: "failed",
        currentPhase: "creating-issues",
        message:
          'Workspace plan contains duplicate repository "web". Combine same-repository issues into one repository entry or use distinct repository names.',
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    })!;

    expect(getBoardTaskStage(cancelled)).toMatchObject({
      id: "failed-recoverable",
      canRecover: true,
      recoverPhase: "running",
    });
  });
});

describe("createRunRecorder", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-recorder-"));
    store = new BoardStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a run lazily on run.started and records subsequent events", () => {
    const record = createRunRecorder(store, { taskId: "t1", repo: "web" });
    record(startedEvent());
    record({
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      text: "working",
      iteration: 1,
      timestamp: new Date(),
    });
    record({
      type: "run.finished",
      runId: "run-1",
      commits: [],
      completionSignal: "<promise>COMPLETE</promise>",
      iterationsRun: 1,
      timestamp: new Date(),
    });

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.taskId).toBe("t1");
    expect(run.repo).toBe("web");
    expect(store.getEvents(run.id).length).toBe(3);
  });

  it("ignores non-start events after a run has failed", () => {
    const record = createRunRecorder(store, { taskId: "t1", repo: "web" });
    record(startedEvent());
    record({
      type: "run.error",
      runId: "run-1",
      message: "cannot lock ref",
      timestamp: new Date(),
    });
    record({
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      text: "late output",
      iteration: 1,
      timestamp: new Date(),
    });

    const run = store.listRuns()[0]!;
    expect(store.getRun(run.id)?.status).toBe("failed");
    expect(store.getEvents(run.id).map((event) => event.event.type)).toEqual([
      "run.started",
      "run.error",
    ]);
  });

  it("ignores events emitted before run.started", () => {
    const record = createRunRecorder(store);
    record({
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      text: "orphan",
      iteration: 1,
      timestamp: new Date(),
    });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("republishes tasks written by another process when watching", async () => {
    store.startWatching();
    const changes: string[] = [];
    store.subscribe((c) => {
      if (c.kind === "task-updated") changes.push(c.task.id);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    // A separate store instance (another process) writes to the same dir.
    const external = new BoardStore(dir);
    const task = external.createTask({ title: "external", prompt: "do it" });

    await waitFor(() => changes.includes(task.id));
    expect(changes).toContain(task.id);
    store.close();
  });

  it("suppresses the watch echo of its own task writes", async () => {
    store.startWatching();
    const changes: string[] = [];
    store.subscribe((c) => {
      if (c.kind === "task-updated") changes.push(c.task.id);
    });

    const task = store.createTask({ title: "mine", prompt: "do it" });
    await new Promise((r) => setTimeout(r, 400));
    // Exactly one notification: the synchronous in-process publish, not a
    // second one echoed back by the file watcher.
    expect(changes.filter((id) => id === task.id)).toHaveLength(1);
    store.close();
  });
});
