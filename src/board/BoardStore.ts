import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../RunEvent.js";

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
  readonly status: BoardRunStatus;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly completionSignal?: string;
  readonly iterationsRun?: number;
  readonly error?: string;
  readonly commits: number;
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
  }>;
}

/** Optional workflow state for board tasks driven by a workflow runtime. */
export interface BoardTaskWorkflow {
  readonly status:
    | "planning"
    | "awaiting-approval"
    | "approved"
    | "rejected"
    | "running"
    | "retrying"
    | "succeeded"
    | "failed";
  readonly checkpointThreadId?: string;
  readonly retryCount?: number;
  readonly message?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

/** A task created on the board, optionally fanned out into per-repo runs. */
export interface BoardTaskRecord {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
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
      let next: BoardRunRecord | undefined;
      if (event.type === "commit") {
        next = { ...run, commits: run.commits + 1 };
      } else if (event.type === "run-finished") {
        next = {
          ...run,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          completionSignal: event.completionSignal,
          iterationsRun: event.iterationsRun,
        };
      } else if (event.type === "run-failed") {
        next = {
          ...run,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: event.message,
        };
      }
      if (next) this.writeRun(next);
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

  listTasks(): BoardTaskRecord[] {
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(
            readFileSync(join(this.tasksDir, f), "utf8"),
          ) as BoardTaskRecord;
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
    }
    if (runId) store.recordEvent(runId, event);
  };
};
