import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore, createRunRecorder } from "./BoardStore.js";
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

    // A separate store instance (another process) writes to the same dir.
    const external = new BoardStore(dir);
    const task = external.createTask({ title: "external", prompt: "do it" });

    await new Promise((r) => setTimeout(r, 400));
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
