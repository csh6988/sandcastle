import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import {
  BoardTerminalManager,
  PHASE_COMPLETION_SIGNAL,
  createTerminalUtf8Decoder,
  type TerminalProcess,
  type TerminalSpawner,
} from "./terminalSession.js";

class FakeTerminalProcess implements TerminalProcess {
  readonly pid = 1234;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<
    (event: { exitCode: number; signal?: number }) => void
  > = [];

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.emitExit(130);
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onExit(
    callback: (event: { exitCode: number; signal?: number }) => void,
  ): void {
    this.exitCallbacks.push(callback);
  }

  emitData(data: string): void {
    for (const callback of this.dataCallbacks) callback(data);
  }

  emitExit(exitCode: number): void {
    for (const callback of this.exitCallbacks) callback({ exitCode });
  }
}

describe("BoardTerminalManager", () => {
  let dir: string;
  let store: BoardStore;
  let terminals: FakeTerminalProcess[];
  let spawner: TerminalSpawner;
  let manager: BoardTerminalManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-terminal-"));
    store = new BoardStore(dir);
    terminals = [];
    spawner = {
      spawn: () => {
        const terminal = new FakeTerminalProcess();
        terminals.push(terminal);
        return terminal;
      },
    };
    manager = new BoardTerminalManager(store, spawner);
  });

  afterEach(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a phase terminal session without replacing the workflow phase", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "classifying",
        currentPhase: "classifying",
        updatedAt: new Date().toISOString(),
      },
    });

    const session = manager.startPhase({
      task,
      phase: "classifying",
      command: "claude",
      args: ["do it"],
      cwd: dir,
    });

    expect(session).toMatchObject({
      taskId: task.id,
      phase: "classifying",
      pid: 1234,
      status: "running",
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: {
        status: "classifying",
        currentPhase: "classifying",
        phaseSessions: {
          classifying: { status: "running", phase: "classifying" },
        },
      },
    });
  });

  it("replays output, forwards input, and resizes by phase", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.startPhase({
      task,
      phase: "classifying",
      command: "claude",
      args: ["classify"],
      cwd: dir,
    });
    manager.startPhase({
      task,
      phase: "aligning-prd",
      command: "claude",
      args: ["align"],
      cwd: dir,
    });
    terminals[0]!.emitData("hello");
    terminals[1]!.emitData("ignored");

    const chunks: string[] = [];
    const unsubscribe = manager.subscribePhase(task.id, "classifying", (data) =>
      chunks.push(data),
    );
    terminals[0]!.emitData(" world");

    expect(chunks).toEqual(["hello", " world"]);
    expect(manager.writePhase(task.id, "classifying", "yes\r")).toBe(true);
    expect(terminals[0]!.writes).toEqual(["yes\r"]);
    expect(terminals[1]!.writes).toEqual([]);
    expect(manager.resizePhase(task.id, "classifying", 80, 24)).toBe(true);
    expect(terminals[0]!.resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(terminals[1]!.resizes).toEqual([]);

    unsubscribe?.();
  });

  it("exposes buffered phase output for workflow handoff parsing", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.startPhase({
      task,
      phase: "creating-issues",
      command: "claude",
      args: ["issues"],
      cwd: dir,
    });

    terminals[0]!.emitData("before ");
    terminals[0]!.emitData(
      '<workspace_plan>{"repositories":[]}</workspace_plan>',
    );

    expect(manager.getPhaseOutput(task.id, "creating-issues")).toBe(
      'before <workspace_plan>{"repositories":[]}</workspace_plan>',
    );
  });

  it("keeps a completed workspace plan available through noisy PTY output", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.startPhase({
      task,
      phase: "creating-issues",
      command: "claude",
      args: ["issues"],
      cwd: dir,
    });

    terminals[0]!.emitData(
      '<workspace_plan>{"repositories":[{"name":"web","task":"Do it"}]}</workspace_plan>',
    );
    for (let i = 0; i < 700; i++) {
      terminals[0]!.emitData("\x1b[?6n");
    }

    expect(manager.getPhaseOutput(task.id, "creating-issues")).toContain(
      '<workspace_plan>{"repositories":[{"name":"web","task":"Do it"}]}</workspace_plan>',
    );
  });

  it("records phase terminal exits without folding them into the task status", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "aligning-prd",
        currentPhase: "aligning-prd",
        updatedAt: new Date().toISOString(),
      },
    });
    manager.startPhase({
      task,
      phase: "aligning-prd",
      command: "claude",
      args: ["align"],
      cwd: dir,
    });

    terminals[0]!.emitExit(0);

    expect(manager.getPhase(task.id, "aligning-prd")).toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: {
        status: "aligning-prd",
        currentPhase: "aligning-prd",
        phaseSessions: {
          "aligning-prd": { status: "exited", exitCode: 0 },
        },
      },
    });
  });

  it("notifies once for a phase completion signal in the terminal output", () => {
    const completed: Array<{ taskId: string; phase: string }> = [];
    manager = new BoardTerminalManager(store, spawner, {
      onPhaseCompleteSignal: ({ taskId, phase }) =>
        completed.push({ taskId, phase }),
    });
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.startPhase({
      task,
      phase: "technical-planning",
      command: "claude",
      args: ["plan"],
      cwd: dir,
    });

    terminals[0]!.emitData(`ready ${PHASE_COMPLETION_SIGNAL}`);
    terminals[0]!.emitData("no marker here");
    terminals[0]!.emitData(`again ${PHASE_COMPLETION_SIGNAL}`);

    expect(completed).toEqual([
      { taskId: task.id, phase: "technical-planning" },
    ]);
  });

  it("notifies again when creating-issues returns to fixing the workspace plan", () => {
    const completed: Array<{ taskId: string; phase: string }> = [];
    manager = new BoardTerminalManager(store, spawner, {
      onPhaseCompleteSignal: ({ taskId, phase }) =>
        completed.push({ taskId, phase }),
    });
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        updatedAt: new Date().toISOString(),
      },
    });
    manager.startPhase({
      task,
      phase: "creating-issues",
      command: "claude",
      args: ["issues"],
      cwd: dir,
    });

    terminals[0]!.emitData(PHASE_COMPLETION_SIGNAL);
    store.updateTask(task.id, {
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        substatus: "fixing-workspace-plan",
        updatedAt: new Date().toISOString(),
      },
    });
    terminals[0]!.emitData(`repaired ${PHASE_COMPLETION_SIGNAL}`);

    expect(completed).toEqual([
      { taskId: task.id, phase: "creating-issues" },
      { taskId: task.id, phase: "creating-issues" },
    ]);
  });

  it("ignores completion signals from stale phase terminals", () => {
    const completed: Array<{ taskId: string; phase: string }> = [];
    manager = new BoardTerminalManager(store, spawner, {
      onPhaseCompleteSignal: ({ taskId, phase }) =>
        completed.push({ taskId, phase }),
    });
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        updatedAt: new Date().toISOString(),
      },
    });
    manager.startPhase({
      task,
      phase: "aligning-prd",
      command: "claude",
      args: ["align"],
      cwd: dir,
    });

    terminals[0]!.emitData(PHASE_COMPLETION_SIGNAL);

    expect(completed).toEqual([]);
  });

  it("kills running terminals when the manager closes", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "classifying",
        currentPhase: "classifying",
        updatedAt: new Date().toISOString(),
      },
    });
    manager.startPhase({
      task,
      phase: "classifying",
      command: "claude",
      args: ["do it"],
      cwd: dir,
    });

    manager.close();

    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: {
        status: "classifying",
        phaseSessions: {
          classifying: { status: "exited", exitCode: 130 },
        },
      },
    });
  });

  it("kills running phase terminals for one task without touching another task", () => {
    const first = store.createTask({ title: "First", prompt: "do it" });
    const second = store.createTask({ title: "Second", prompt: "do it" });
    manager.startPhase({
      task: first,
      phase: "classifying",
      command: "claude",
      args: ["classify"],
      cwd: dir,
    });
    manager.startPhase({
      task: first,
      phase: "aligning-prd",
      command: "claude",
      args: ["align"],
      cwd: dir,
    });
    manager.startPhase({
      task: second,
      phase: "classifying",
      command: "claude",
      args: ["other"],
      cwd: dir,
    });

    expect(manager.killTask(first.id)).toBe(true);

    expect(manager.getPhase(first.id, "classifying")).toMatchObject({
      status: "exited",
      exitCode: 130,
    });
    expect(manager.getPhase(first.id, "aligning-prd")).toMatchObject({
      status: "exited",
      exitCode: 130,
    });
    expect(manager.getPhase(second.id, "classifying")).toMatchObject({
      status: "running",
    });
  });
});

describe("createTerminalUtf8Decoder", () => {
  it("preserves multibyte characters split across terminal chunks", () => {
    const chunks: string[] = [];
    const decoder = createTerminalUtf8Decoder((chunk) => chunks.push(chunk));
    const bytes = Buffer.from("› ✻ 你好", "utf8");

    decoder.write(bytes.subarray(0, 2));
    decoder.write(bytes.subarray(2, 5));
    decoder.write(bytes.subarray(5));
    decoder.end();

    expect(chunks.join("")).toBe("› ✻ 你好");
    expect(chunks.join("")).not.toContain("�");
  });
});
