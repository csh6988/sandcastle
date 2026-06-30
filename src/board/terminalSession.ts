import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  BoardPhaseSessionSummary,
  BoardStore,
  BoardTaskRecord,
  BoardTaskWorkflowPhase,
} from "./BoardStore.js";

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
  readonly phase: BoardTaskWorkflowPhase;
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

export interface StartPhaseTerminalSessionOptions extends StartTerminalSessionOptions {
  readonly phase: BoardTaskWorkflowPhase;
}

export const PHASE_COMPLETION_SIGNAL =
  "<sandcastle-phase>complete</sandcastle-phase>";

export const createTerminalUtf8Decoder = (callback: (data: string) => void) => {
  const decoder = new StringDecoder("utf8");
  return {
    write(chunk: Buffer): void {
      const decoded = decoder.write(chunk);
      if (decoded) callback(decoded);
    },
    end(): void {
      const decoded = decoder.end();
      if (decoded) callback(decoded);
    },
  };
};

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
): TerminalProcess => {
  const decoders = new Set<ReturnType<typeof createTerminalUtf8Decoder>>();
  return {
    pid: child.pid ?? 0,
    write: (data) => child.stdin.write(data),
    resize: () => {
      // The `script` wrapper owns the PTY size. Resizing is best-effort no-op.
    },
    kill: () => child.kill(),
    onData: (callback) => {
      const stdoutDecoder = createTerminalUtf8Decoder(callback);
      const stderrDecoder = createTerminalUtf8Decoder(callback);
      decoders.add(stdoutDecoder);
      decoders.add(stderrDecoder);
      child.stdout.on("data", (chunk: Buffer) => stdoutDecoder.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrDecoder.write(chunk));
    },
    onExit: (callback) => {
      child.on("exit", (exitCode, signal) => {
        for (const decoder of decoders) decoder.end();
        decoders.clear();
        callback({ exitCode: exitCode ?? 0, signal: signal ? 1 : undefined });
      });
    },
  };
};

interface RunningTerminalSession {
  readonly process: TerminalProcess;
  readonly subscribers: Set<(data: string) => void>;
  readonly output: string[];
  completionScanOffset: number;
  record: BoardTerminalSessionRecord;
}

export interface BoardTerminalManagerOptions {
  readonly onPhaseCompleteSignal?: (args: {
    readonly taskId: string;
    readonly phase: BoardTaskWorkflowPhase;
  }) => void;
}

export class BoardTerminalManager {
  private readonly sessions = new Map<string, RunningTerminalSession>();

  constructor(
    private readonly store: BoardStore,
    private readonly spawner: TerminalSpawner = ptyBridgeSpawner,
    private readonly options: BoardTerminalManagerOptions = {},
  ) {}

  start(options: StartTerminalSessionOptions): BoardTerminalSessionRecord {
    const phase = options.task.workflow?.currentPhase ?? "running";
    return this.startPhase({ ...options, phase });
  }

  startPhase(
    options: StartPhaseTerminalSessionOptions,
  ): BoardTerminalSessionRecord {
    const key = this.sessionKey(options.task.id, options.phase);
    const existing = this.sessions.get(key);
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
      completionScanOffset: 0,
      record: {
        taskId: options.task.id,
        phase: options.phase,
        pid: terminal.pid,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
    this.sessions.set(key, session);
    this.recordPhaseSession(session.record);

    terminal.onData((data) => {
      session.output.push(data);
      if (session.output.length > 500) session.output.shift();
      for (const subscriber of session.subscribers) subscriber(data);
      const output = session.output.join("");
      let completionIndex = output.indexOf(
        PHASE_COMPLETION_SIGNAL,
        session.completionScanOffset,
      );
      while (completionIndex !== -1) {
        session.completionScanOffset =
          completionIndex + PHASE_COMPLETION_SIGNAL.length;
        this.options.onPhaseCompleteSignal?.({
          taskId: session.record.taskId,
          phase: session.record.phase,
        });
        completionIndex = output.indexOf(
          PHASE_COMPLETION_SIGNAL,
          session.completionScanOffset,
        );
      }
    });
    terminal.onExit((event) => {
      session.record = {
        ...session.record,
        status: "exited",
        exitedAt: new Date().toISOString(),
        exitCode: event.exitCode,
      };
      this.recordPhaseSession(session.record);
    });

    return session.record;
  }

  get(taskId: string): BoardTerminalSessionRecord | undefined {
    const task = this.store.getTask(taskId);
    const phase = task?.workflow?.currentPhase ?? "running";
    return this.getPhase(taskId, phase);
  }

  getPhase(
    taskId: string,
    phase: BoardTaskWorkflowPhase,
  ): BoardTerminalSessionRecord | undefined {
    return this.sessions.get(this.sessionKey(taskId, phase))?.record;
  }

  getPhaseOutput(taskId: string, phase: BoardTaskWorkflowPhase): string {
    return (
      this.sessions.get(this.sessionKey(taskId, phase))?.output.join("") ?? ""
    );
  }

  write(taskId: string, data: string): boolean {
    const task = this.store.getTask(taskId);
    const phase = task?.workflow?.currentPhase ?? "running";
    return this.writePhase(taskId, phase, data);
  }

  writePhase(
    taskId: string,
    phase: BoardTaskWorkflowPhase,
    data: string,
  ): boolean {
    const session = this.sessions.get(this.sessionKey(taskId, phase));
    if (!session || session.record.status !== "running") return false;
    session.process.write(data);
    return true;
  }

  resize(taskId: string, cols: number, rows: number): boolean {
    const task = this.store.getTask(taskId);
    const phase = task?.workflow?.currentPhase ?? "running";
    return this.resizePhase(taskId, phase, cols, rows);
  }

  resizePhase(
    taskId: string,
    phase: BoardTaskWorkflowPhase,
    cols: number,
    rows: number,
  ): boolean {
    const session = this.sessions.get(this.sessionKey(taskId, phase));
    if (!session || session.record.status !== "running") return false;
    session.process.resize(cols, rows);
    return true;
  }

  subscribe(
    taskId: string,
    callback: (data: string) => void,
  ): (() => void) | undefined {
    const task = this.store.getTask(taskId);
    const phase = task?.workflow?.currentPhase ?? "running";
    return this.subscribePhase(taskId, phase, callback);
  }

  subscribePhase(
    taskId: string,
    phase: BoardTaskWorkflowPhase,
    callback: (data: string) => void,
  ): (() => void) | undefined {
    const session = this.sessions.get(this.sessionKey(taskId, phase));
    if (!session) return undefined;
    for (const chunk of session.output) callback(chunk);
    session.subscribers.add(callback);
    return () => {
      session.subscribers.delete(callback);
    };
  }

  killTask(taskId: string): boolean {
    let killed = false;
    for (const session of this.sessions.values()) {
      if (
        session.record.taskId !== taskId ||
        session.record.status !== "running"
      ) {
        continue;
      }
      session.process.kill();
      killed = true;
    }
    return killed;
  }

  private sessionKey(taskId: string, phase: BoardTaskWorkflowPhase): string {
    return `${taskId}:${phase}`;
  }

  private recordPhaseSession(record: BoardTerminalSessionRecord): void {
    const task = this.store.getTask(record.taskId);
    if (!task) return;
    const summary: BoardPhaseSessionSummary = { ...record };
    this.store.updateTask(record.taskId, {
      workflow: {
        status: task.workflow?.status ?? record.phase,
        currentPhase: task.workflow?.currentPhase ?? record.phase,
        checkpointThreadId: task.workflow?.checkpointThreadId,
        retryCount: task.workflow?.retryCount,
        message: task.workflow?.message,
        error: task.workflow?.error,
        phaseSessions: {
          ...(task.workflow?.phaseSessions ?? {}),
          [record.phase]: summary,
        },
        updatedAt: new Date().toISOString(),
      },
    });
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.record.status === "running") session.process.kill();
    }
    this.sessions.clear();
  }
}
