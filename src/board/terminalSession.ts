import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BoardStore, BoardTaskRecord } from "./BoardStore.js";

export interface TerminalProcess {
  readonly pid: number;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: () => void;
  readonly onData: (callback: (data: string) => void) => void;
  readonly onExit: (
    callback: (event: { exitCode: number; signal?: number }) => void,
  ) => void;
}

export interface TerminalSpawner {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string | undefined>;
      readonly cols: number;
      readonly rows: number;
    },
  ) => TerminalProcess;
}

export interface BoardTerminalSessionRecord {
  readonly taskId: string;
  readonly pid: number;
  readonly status: "running" | "exited";
  readonly startedAt: string;
  readonly exitedAt?: string;
  readonly exitCode?: number;
}

export interface StartTerminalSessionOptions {
  readonly task: BoardTaskRecord;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly cols?: number;
  readonly rows?: number;
}

export const ptyBridgeSpawner: TerminalSpawner = {
  spawn(command, args, options) {
    const child = spawn(
      "/usr/bin/python3",
      ["-u", "-c", PYTHON_PTY_BRIDGE, command, ...args],
      {
        cwd: options.cwd,
        env: {
          ...options.env,
          COLUMNS: String(options.cols),
          LINES: String(options.rows),
          TERM: "xterm-256color",
        },
        stdio: "pipe",
      },
    );
    return wrapChildProcess(child);
  },
};

const PYTHON_PTY_BRIDGE = String.raw`
import os
import pty
import select
import signal
import sys

command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, os.environ)

def forward_stdin():
    data = os.read(sys.stdin.fileno(), 4096)
    if not data:
        return False
    os.write(fd, data)
    return True

def forward_pty():
    data = os.read(fd, 4096)
    if not data:
        return False
    os.write(sys.stdout.fileno(), data)
    return True

try:
    while True:
        readable, _, _ = select.select([sys.stdin.fileno(), fd], [], [])
        if sys.stdin.fileno() in readable and not forward_stdin():
            break
        if fd in readable and not forward_pty():
            break
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
`;

const wrapChildProcess = (
  child: ChildProcessWithoutNullStreams,
): TerminalProcess => ({
  pid: child.pid ?? 0,
  write: (data) => child.stdin.write(data),
  resize: () => {
    // The `script` wrapper owns the PTY size. Resizing is best-effort no-op.
  },
  kill: () => child.kill(),
  onData: (callback) => {
    child.stdout.on("data", (chunk: Buffer) =>
      callback(chunk.toString("utf8")),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      callback(chunk.toString("utf8")),
    );
  },
  onExit: (callback) => {
    child.on("exit", (exitCode, signal) =>
      callback({ exitCode: exitCode ?? 0, signal: signal ? 1 : undefined }),
    );
  },
});

interface RunningTerminalSession {
  readonly process: TerminalProcess;
  readonly subscribers: Set<(data: string) => void>;
  readonly output: string[];
  record: BoardTerminalSessionRecord;
}

export class BoardTerminalManager {
  private readonly sessions = new Map<string, RunningTerminalSession>();

  constructor(
    private readonly store: BoardStore,
    private readonly spawner: TerminalSpawner = ptyBridgeSpawner,
  ) {}

  start(options: StartTerminalSessionOptions): BoardTerminalSessionRecord {
    const existing = this.sessions.get(options.task.id);
    if (existing?.record.status === "running") return existing.record;

    const terminal = this.spawner.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      cols: options.cols ?? 120,
      rows: options.rows ?? 32,
    });
    const session: RunningTerminalSession = {
      process: terminal,
      subscribers: new Set(),
      output: [],
      record: {
        taskId: options.task.id,
        pid: terminal.pid,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
    this.sessions.set(options.task.id, session);
    this.store.updateTask(options.task.id, {
      status: "running",
      workflow: {
        status: "running",
        message: "Interactive terminal session is running.",
        updatedAt: new Date().toISOString(),
      },
    });

    terminal.onData((data) => {
      session.output.push(data);
      if (session.output.length > 500) session.output.shift();
      for (const subscriber of session.subscribers) subscriber(data);
    });
    terminal.onExit((event) => {
      session.record = {
        ...session.record,
        status: "exited",
        exitedAt: new Date().toISOString(),
        exitCode: event.exitCode,
      };
      this.store.updateTask(options.task.id, {
        status: event.exitCode === 0 ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
        ...(event.exitCode === 0
          ? {}
          : {
              error: `Interactive terminal exited with code ${event.exitCode}.`,
            }),
        workflow: {
          status: event.exitCode === 0 ? "succeeded" : "failed",
          message: `Interactive terminal exited with code ${event.exitCode}.`,
          updatedAt: new Date().toISOString(),
        },
      });
    });

    return session.record;
  }

  get(taskId: string): BoardTerminalSessionRecord | undefined {
    return this.sessions.get(taskId)?.record;
  }

  write(taskId: string, data: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session || session.record.status !== "running") return false;
    session.process.write(data);
    return true;
  }

  resize(taskId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(taskId);
    if (!session || session.record.status !== "running") return false;
    session.process.resize(cols, rows);
    return true;
  }

  subscribe(
    taskId: string,
    callback: (data: string) => void,
  ): (() => void) | undefined {
    const session = this.sessions.get(taskId);
    if (!session) return undefined;
    for (const chunk of session.output) callback(chunk);
    session.subscribers.add(callback);
    return () => {
      session.subscribers.delete(callback);
    };
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.record.status === "running") session.process.kill();
    }
    this.sessions.clear();
  }
}
