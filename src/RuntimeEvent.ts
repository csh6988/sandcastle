import { Context, Effect, Layer } from "effect";
import type { IterationUsage } from "./AgentProvider.js";

export type RuntimeCommit = {
  readonly sha: string;
};

/**
 * A stable, coarse classification of why a run failed, so consumers can route
 * infrastructure failures differently from agent or task failures without
 * pattern-matching on error messages.
 */
export type RunFailureKind = "infrastructure" | "agent" | "task" | "unknown";

/**
 * Structured, best-effort recovery evidence attached to a `run.error` runtime
 * event. Every field is optional and plain-serializable so the event survives a
 * JSON round-trip through stores such as the workflow board.
 */
export interface RunFailureRecovery {
  /** Coarse, stable classification of the failure. */
  readonly failureKind: RunFailureKind;
  /** Best-effort human label for where the run failed (e.g. "agent", "sandbox-create"). */
  readonly failurePhase?: string;
  /** Host path to a worktree preserved after failure, when one was kept. */
  readonly preservedWorktreePath?: string;
  /** Host path to the run log, when the run logged to a file. */
  readonly runLogPath?: string;
  /** Agent session id of the last iteration, when captured. */
  readonly sessionId?: string;
  /** Host path to the captured session file, when captured. */
  readonly sessionFilePath?: string;
  /** Whether the completion signal was seen before the failure, when known. */
  readonly completionSignalSeen?: boolean;
  /** Commit SHAs recorded before the failure, when any. */
  readonly commits?: readonly string[];
}

/**
 * Stable internal runtime event model emitted by Sandcastle core.
 *
 * Event names use dotted `domain.action` strings so protocol adapters can map
 * them without depending on CLI display text or provider-specific stream JSON.
 */
export type RuntimeEvent =
  | {
      readonly type: "run.started";
      readonly runId: string;
      readonly name?: string;
      readonly agent?: string;
      readonly model?: string;
      readonly sandbox?: string;
      readonly branch?: string;
      readonly maxIterations?: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "run.finished";
      readonly runId: string;
      readonly completionSignal?: string;
      readonly iterationsRun: number;
      readonly commits: readonly RuntimeCommit[];
      readonly timestamp: Date;
    }
  | {
      readonly type: "run.error";
      readonly runId: string;
      readonly message: string;
      readonly recovery?: RunFailureRecovery;
      readonly timestamp: Date;
    }
  | {
      readonly type: "iteration.started";
      readonly runId: string;
      readonly iteration: number;
      readonly maxIterations?: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "iteration.finished";
      readonly runId: string;
      readonly iteration: number;
      readonly sessionId?: string;
      readonly sessionFilePath?: string;
      readonly usage?: IterationUsage;
      readonly timestamp: Date;
    }
  | {
      readonly type: "message.delta";
      readonly runId: string;
      readonly messageId: string;
      readonly iteration?: number;
      readonly text: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "tool.call";
      readonly runId: string;
      readonly toolCallId: string;
      readonly iteration?: number;
      readonly name: string;
      readonly args: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "tool.result";
      readonly runId: string;
      readonly toolCallId?: string;
      readonly iteration?: number;
      readonly content: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "usage.recorded";
      readonly runId: string;
      readonly iteration: number;
      readonly usage: IterationUsage;
      readonly model?: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "commit.created";
      readonly runId: string;
      readonly iteration?: number;
      readonly sha: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "raw";
      readonly runId: string;
      readonly iteration?: number;
      readonly line: string;
      readonly timestamp: Date;
    };

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeEventEmitterService {
  readonly emit: (event: RuntimeEvent) => Effect.Effect<void>;
}

export class RuntimeEventEmitter extends Context.Tag("RuntimeEventEmitter")<
  RuntimeEventEmitter,
  RuntimeEventEmitterService
>() {}

/**
 * Build a layer for runtime events. Callback errors and rejected promises are
 * swallowed so observability adapters cannot abort the agent workflow.
 */
export const runtimeEventEmitterLayer = (
  onEvent?: RuntimeEventHandler,
): Layer.Layer<RuntimeEventEmitter> =>
  Layer.succeed(RuntimeEventEmitter, {
    emit: onEvent
      ? (event) =>
          Effect.sync(() => {
            try {
              Promise.resolve(onEvent(event)).catch(() => {});
            } catch {
              // Swallow callback errors — a broken adapter must not kill the run.
            }
          })
      : () => Effect.void,
  });
