import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoardStore,
  createRunRecorder,
  getBoardTaskStage,
} from "./BoardStore.js";
import type { RunEvent } from "../RunEvent.js";

const startedEvent = (
  overrides: Partial<Extract<RunEvent, { type: "run-started" }>> = {},
): RunEvent => ({
  type: "run-started",
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
      type: "iteration-started",
      iteration: 1,
      maxIterations: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "agent-text",
      message: "hello",
      iteration: 1,
      timestamp: new Date(),
    });
    const events = store.getEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1]!.event.type).toBe("agent-text");
    // Timestamp serialized to an ISO string.
    expect(typeof events[1]!.event.timestamp).toBe("string");
    expect(store.getRun(run.id)).toMatchObject({
      currentIteration: 1,
      lastEventType: "agent-text",
    });
  });

  it("folds run-finished into a succeeded status and commit count", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 2,
    });
    store.recordEvent(run.id, {
      type: "commit",
      sha: "abc",
      iteration: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "run-finished",
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
    expect(updated.lastEventType).toBe("run-finished");
    expect(updated.finishedAt).toBeTruthy();
  });

  it("folds run-failed into a failed status with the error message", () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "run-failed",
      message: "boom",
      timestamp: new Date(),
    });
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("boom");
    expect(updated.lastEventType).toBe("run-failed");
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
      restarted.getEvents(run.id).some((r) => r.event.type === "run-failed"),
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
      type: "usage",
      usage,
      model: "claude-opus-4-8",
      iteration: 1,
      timestamp: new Date(),
    });
    store.recordEvent(run.id, {
      type: "usage",
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
      lastEventType: "usage",
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
      type: "run-finished",
      iterationsRun: 1,
      timestamp: new Date(),
    });
    unsubscribe();
    expect(kinds).toContain("run-updated");
    expect(kinds).toContain("run-event");
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
    expect(store.readTaskProgress(task.id)).toContain("Status: pending");
    expect(store.readTaskProgress(task.id)).toContain("Task: Add the page");
  });

  it("updates task progress from linked repository run events", () => {
    const task = store.createTask({ title: "Fix UI", prompt: "do it" });
    store.updateTask(task.id, {
      plan: {
        repositories: [{ name: "web", task: "Fix the UI" }],
      },
    });
    const recorder = createRunRecorder(store, { taskId: task.id, repo: "web" });

    recorder(startedEvent({ name: "task web", branch: "sandcastle/web" }));
    recorder({
      type: "agent-text",
      message: "I changed the component and will run tests next.",
      iteration: 1,
      timestamp: new Date(),
    });
    recorder({
      type: "run-failed",
      message: "lint failed",
      timestamp: new Date(),
    });

    const progress = store.readTaskProgress(task.id)!;
    expect(progress).toContain("Status: needs_recovery");
    expect(progress).toContain("Branch: sandcastle/web");
    expect(progress).toContain(
      "agent text: I changed the component and will run tests next.",
    );
    expect(progress).toContain("Address the last failure: lint failed");
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

  it("creates a run lazily on run-started and records subsequent events", () => {
    const record = createRunRecorder(store, { taskId: "t1", repo: "web" });
    record(startedEvent());
    record({
      type: "agent-text",
      message: "working",
      iteration: 1,
      timestamp: new Date(),
    });
    record({
      type: "run-finished",
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
      type: "run-failed",
      message: "cannot lock ref",
      timestamp: new Date(),
    });
    record({
      type: "agent-text",
      message: "late output",
      iteration: 1,
      timestamp: new Date(),
    });

    const run = store.listRuns()[0]!;
    expect(store.getRun(run.id)?.status).toBe("failed");
    expect(store.getEvents(run.id).map((event) => event.event.type)).toEqual([
      "run-started",
      "run-failed",
    ]);
  });

  it("ignores events emitted before run-started", () => {
    const record = createRunRecorder(store);
    record({
      type: "agent-text",
      message: "orphan",
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
