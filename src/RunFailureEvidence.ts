import type { RunFailureKind, RunFailureRecovery } from "./RunEvent.js";

/**
 * Pure classification + evidence-gathering for failed runs.
 *
 * This module holds the logic that turns a caught error (plus whatever context
 * the emit site has in scope) into the {@link RunFailureRecovery} object carried
 * on a `run-failed` {@link import("./RunEvent.js").RunEvent}. Keeping it here
 * lets the emit-site wiring in `run.ts` / `runWorkspace.ts` stay thin and lets
 * the classification be unit-tested without running a real agent.
 *
 * It is intentionally Effect-free and depends only on the public
 * `RunFailureKind` shape, so it can be used from both the orchestration core
 * and the (non-Effect) workflow board.
 */

/**
 * Error `_tag` values (from `src/errors.ts`) that mean the sandbox/host
 * environment failed rather than the task itself. Kept in sync with the errors
 * that describe infrastructure operations (containers, copy/sync, worktree,
 * hooks, and their timeouts).
 */
const INFRASTRUCTURE_TAGS = new Set<string>([
  "CopyError",
  "DockerError",
  "PodmanError",
  "SyncError",
  "WorktreeError",
  "ConfigDirError",
  "InitError",
  "ExecError",
  "ExecHostError",
  "WorktreeTimeoutError",
  "ContainerStartTimeoutError",
  "CopyToWorktreeTimeoutError",
  "CopyToWorktreeError",
  "SyncInTimeoutError",
  "HookTimeoutError",
  "GitSetupTimeoutError",
  "CommitCollectionTimeoutError",
  "MergeToHostTimeoutError",
  "SessionCaptureError",
]);

/** Error `_tag` values that mean the agent process itself failed. */
const AGENT_TAGS = new Set<string>(["AgentError", "AgentIdleTimeoutError"]);

const readTag = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { _tag?: unknown })._tag;
    return typeof tag === "string" ? tag : undefined;
  }
  return undefined;
};

const readString = (error: unknown, key: string): string | undefined => {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : (readString(error, "message") ?? String(error));

/**
 * Whether a failure message looks like an infrastructure problem (e.g. a
 * missing container image) rather than task failure. Consumers use this as a
 * best-effort signal when no structured `failureKind` is available (legacy
 * events) so infrastructure-capture warnings do not fail delivered work.
 */
export const isInfrastructureFailureMessage = (message: string): boolean => {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not found locally") ||
    normalized.includes("create failed") ||
    normalized.includes("build it first")
  );
};

/**
 * Classify a caught error into a stable {@link RunFailureKind} and a best-effort
 * `failurePhase` label. Classification derives first from the error `_tag`
 * (Effect `Data.TaggedError` classes), then from the error `name`
 * (`StructuredOutputError`), then from the message (infrastructure signal), and
 * finally falls back to `unknown`.
 */
export const classifyRunFailure = (
  error: unknown,
): { readonly failureKind: RunFailureKind; readonly failurePhase?: string } => {
  const tag = readTag(error);
  if (tag !== undefined) {
    if (AGENT_TAGS.has(tag))
      return { failureKind: "agent", failurePhase: "agent" };
    if (INFRASTRUCTURE_TAGS.has(tag)) {
      return { failureKind: "infrastructure", failurePhase: tag };
    }
  }

  const name = error instanceof Error ? error.name : readString(error, "name");
  if (name === "StructuredOutputError") {
    return { failureKind: "task", failurePhase: "structured-output" };
  }

  if (isInfrastructureFailureMessage(errorMessage(error))) {
    return { failureKind: "infrastructure", failurePhase: "sandbox-create" };
  }

  return { failureKind: "unknown" };
};

/** Emit-site context that supplements the evidence carried on the error. */
export interface RunFailureContext {
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
  /** Preserved worktree path known at the emit site (fallback if the error omits it). */
  readonly preservedWorktreePath?: string;
}

/**
 * Build the {@link RunFailureRecovery} for a failed run from a caught error plus
 * emit-site context. Evidence carried on the error (preserved worktree path,
 * session id/file) takes precedence over the context fallback. Undefined
 * optional fields are omitted so the serialized event stays minimal and legacy
 * consumers see only what is actually known.
 */
export const buildRunFailureRecovery = (
  error: unknown,
  context: RunFailureContext,
): RunFailureRecovery => {
  const { failureKind, failurePhase } = classifyRunFailure(error);

  const preservedWorktreePath =
    readString(error, "preservedWorktreePath") ?? context.preservedWorktreePath;
  const sessionId = readString(error, "sessionId") ?? context.sessionId;
  const sessionFilePath =
    readString(error, "sessionFilePath") ?? context.sessionFilePath;

  const recovery: {
    failureKind: RunFailureKind;
    failurePhase?: string;
    preservedWorktreePath?: string;
    runLogPath?: string;
    sessionId?: string;
    sessionFilePath?: string;
    completionSignalSeen?: boolean;
    commits?: readonly string[];
  } = { failureKind };

  if (failurePhase !== undefined) recovery.failurePhase = failurePhase;
  if (preservedWorktreePath !== undefined)
    recovery.preservedWorktreePath = preservedWorktreePath;
  if (context.runLogPath !== undefined)
    recovery.runLogPath = context.runLogPath;
  if (sessionId !== undefined) recovery.sessionId = sessionId;
  if (sessionFilePath !== undefined) recovery.sessionFilePath = sessionFilePath;
  if (context.completionSignalSeen !== undefined)
    recovery.completionSignalSeen = context.completionSignalSeen;
  if (context.commits !== undefined && context.commits.length > 0)
    recovery.commits = context.commits;

  return recovery;
};
