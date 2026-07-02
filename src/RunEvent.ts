import { Context, Effect, Layer } from "effect";
import type { IterationUsage } from "./AgentProvider.js";

/**
 * A stable, coarse classification of why a run failed, so consumers can route
 * infrastructure failures differently from agent or task failures without
 * pattern-matching on error messages.
 *
 * - `infrastructure` — the sandbox/host environment failed (e.g. a missing
 *   container image, Docker/Podman errors, copy/sync/worktree/hook timeouts).
 *   The task itself was never fairly attempted.
 * - `agent` — the agent process itself failed (non-zero exit, idle timeout).
 * - `task` — the run reached the agent's output but it did not satisfy the
 *   task contract (e.g. structured-output extraction/validation failed).
 * - `unknown` — the failure could not be classified.
 *
 * This is a plain string union with no Effect types so it can be exported from
 * `src/index.ts` and consumed by non-Effect hosts. See ADR 0021.
 */
export type RunFailureKind = "infrastructure" | "agent" | "task" | "unknown";

/**
 * Structured, best-effort recovery evidence attached to a {@link RunEvent} of
 * type `run-failed`. Every field is optional and plain-serializable so the
 * event survives a JSON round-trip through a store and stays compatible with
 * minimal legacy `run-failed` events that omit it entirely.
 *
 * This is observability/recovery metadata, not a new error-handling mechanism:
 * the original error is still thrown. It surfaces evidence Sandcastle already
 * knows (preserved worktree, run log, session, commits, completion state) at
 * the same public seam used by `run()` and the workspace runners so a caller or
 * the workflow board can decide how to recover.
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
 * A single event in a run's structured lifecycle stream, surfaced to callers of
 * `run()` (and the workspace runners) via the `onRunEvent` callback.
 *
 * Unlike {@link AgentStreamEvent}, the run-event stream:
 * - works in **both** logging modes (`file` and `stdout`), decoupled from where
 *   human-readable output goes;
 * - covers the full run shape a consumer needs to render a board — lifecycle,
 *   iteration boundaries, agent text/tool activity, token `usage` (with the
 *   model), and commits.
 *
 * It is a plain discriminated union with no Effect types so it can be consumed
 * by non-Effect hosts (e.g. the board server). See ADR 0021.
 */
export type RunEvent =
  | {
      readonly type: "run-started";
      /** Display name of the run (the `name` option, falling back to the agent). */
      readonly name: string;
      /** Internal agent provider name (e.g. "claude-code"). */
      readonly agent: string;
      /** Agent model when the provider exposes one. */
      readonly model?: string;
      /** Sandbox provider display name. */
      readonly sandbox: string;
      /** Branch the agent works on inside the sandbox. */
      readonly branch: string;
      /** Maximum iterations configured for the run. */
      readonly maxIterations: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "iteration-started";
      readonly iteration: number;
      readonly maxIterations: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "agent-text";
      readonly message: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "agent-tool-call";
      readonly name: string;
      readonly formattedArgs: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "agent-tool-result";
      readonly content: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "agent-idle-warning";
      readonly minutes: number;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "usage";
      readonly usage: IterationUsage;
      /** Agent model the tokens are attributed to, when known. */
      readonly model?: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "commit";
      readonly sha: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "run-finished";
      /** The matched completion signal, or undefined if the run hit its iteration limit. */
      readonly completionSignal?: string;
      readonly iterationsRun: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "run-failed";
      readonly message: string;
      /**
       * Optional structured recovery evidence. Absent on minimal/legacy
       * `run-failed` events; present when the emit site could gather it. The
       * `message` field is unchanged and remains the primary failure text.
       */
      readonly recovery?: RunFailureRecovery;
      readonly timestamp: Date;
    };

export interface RunEventEmitterService {
  readonly emit: (event: RunEvent) => Effect.Effect<void>;
}

export class RunEventEmitter extends Context.Tag("RunEventEmitter")<
  RunEventEmitter,
  RunEventEmitterService
>() {}

/**
 * Build a layer for the RunEventEmitter service.
 *
 * Called with no argument, returns a no-op layer that discards events.
 * Called with a callback, returns a layer that forwards each event to it.
 * The callback is invoked synchronously inside an `Effect.sync`; any error it
 * throws is caught and discarded so observability failures cannot kill the run.
 */
export const runEventEmitterLayer = (
  onEvent?: (event: RunEvent) => void,
): Layer.Layer<RunEventEmitter> =>
  Layer.succeed(RunEventEmitter, {
    emit: onEvent
      ? (event) =>
          Effect.sync(() => {
            try {
              onEvent(event);
            } catch {
              // Swallow callback errors — a broken forwarder must not kill the run.
            }
          })
      : () => Effect.void,
  });
