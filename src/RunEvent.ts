import { Context, Effect, Layer } from "effect";
import type { IterationUsage } from "./AgentProvider.js";

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
