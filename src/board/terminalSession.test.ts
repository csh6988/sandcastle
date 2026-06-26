import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import {
  BoardTerminalManager,
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
  let terminal: FakeTerminalProcess;
  let spawner: TerminalSpawner;
  let manager: BoardTerminalManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-terminal-"));
    store = new BoardStore(dir);
    terminal = new FakeTerminalProcess();
    spawner = {
      spawn: () => terminal,
    };
    manager = new BoardTerminalManager(store, spawner);
  });

  afterEach(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a terminal session and marks the task running", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });

    const session = manager.start({
      task,
      command: "claude",
      args: ["do it"],
      cwd: dir,
    });

    expect(session).toMatchObject({
      taskId: task.id,
      pid: 1234,
      status: "running",
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "running",
      workflow: { status: "running" },
    });
  });

  it("replays output, forwards input, resizes, and folds exit status", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.start({ task, command: "claude", args: ["do it"], cwd: dir });
    terminal.emitData("hello");

    const chunks: string[] = [];
    const unsubscribe = manager.subscribe(task.id, (data) => chunks.push(data));
    terminal.emitData(" world");

    expect(chunks).toEqual(["hello", " world"]);
    expect(manager.write(task.id, "yes\r")).toBe(true);
    expect(terminal.writes).toEqual(["yes\r"]);
    expect(manager.resize(task.id, 80, 24)).toBe(true);
    expect(terminal.resizes).toEqual([{ cols: 80, rows: 24 }]);

    unsubscribe?.();
    terminal.emitExit(0);

    expect(manager.get(task.id)).toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      workflow: { status: "succeeded" },
    });
  });

  it("kills running terminals when the manager closes", () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    manager.start({ task, command: "claude", args: ["do it"], cwd: dir });

    manager.close();

    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "Interactive terminal exited with code 130.",
      workflow: { status: "failed" },
    });
  });
});
