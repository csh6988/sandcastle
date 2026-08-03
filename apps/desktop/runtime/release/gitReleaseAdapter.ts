import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  ReleaseOperationEffectAdapter,
  ReleaseOperationEffectRequest,
  ReleaseOperationItemFinalize,
  ReleaseOperationReconcileObservation,
} from "./releaseOperationContracts.js";

export class GitReleaseAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitReleaseAdapterError";
  }
}

export type GitReleaseExecutionBoundary = {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

type GitCommandResult = {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

type PreparedRelease = {
  readonly repositoryRoot: string;
  readonly targetRef: string;
  readonly sourceCommit: string;
  readonly expectedTargetTip: string;
  readonly currentTargetTip: string | null;
};

const commitPattern = /^[a-f0-9]{40}$/;

const gitEnvironment = (): NodeJS.ProcessEnv =>
  ({
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(process.platform === "win32" && process.env.PATHEXT
      ? { PATHEXT: process.env.PATHEXT }
      : {}),
    ...(process.platform === "win32" && process.env.TEMP
      ? { TEMP: process.env.TEMP }
      : {}),
    ...(process.platform === "win32" && process.env.TMP
      ? { TMP: process.env.TMP }
      : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  }) satisfies NodeJS.ProcessEnv;

const timeoutError = (): NodeJS.ErrnoException => {
  const error = new Error("The bounded Release Git command timed out.") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
};

const assertNotCancelled = (boundary: GitReleaseExecutionBoundary): void => {
  if (boundary.signal?.aborted) {
    throw new GitReleaseAdapterError(
      "RELEASE_GIT_CANCELLED",
      "The Release Git operation was cancelled before its outcome was proven.",
    );
  }
};

const isUnproven = (error: unknown): boolean =>
  (error instanceof GitReleaseAdapterError && error.code === "RELEASE_GIT_CANCELLED") ||
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ETIMEDOUT");

const runCommand = (
  args: readonly string[],
  boundary: GitReleaseExecutionBoundary,
): Promise<GitCommandResult> => {
  assertNotCancelled(boundary);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(boundary.executable, [...args], {
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const terminate = (reason: "cancelled" | "timeout") => {
      if (settled) return;
      cancelled = reason === "cancelled";
      timedOut = reason === "timeout";
      child.kill(reason === "timeout" ? "SIGKILL" : "SIGTERM");
    };
    const onAbort = () => terminate("cancelled");
    boundary.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout"), boundary.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      boundary.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      boundary.signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        reject(
          new GitReleaseAdapterError(
            "RELEASE_GIT_CANCELLED",
            "The Release Git operation was cancelled before its outcome was proven.",
          ),
        );
        return;
      }
      if (timedOut) {
        reject(timeoutError());
        return;
      }
      resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
};

const git = async (
  repositoryRoot: string,
  args: readonly string[],
  boundary: GitReleaseExecutionBoundary,
): Promise<string> => {
  const result = await runCommand(["-C", repositoryRoot, ...args], boundary);
  if (result.status !== 0) {
    const error = new Error(result.stderr.toString("utf8").trim() || "Git command failed.") as NodeJS.ErrnoException;
    error.code = "RELEASE_GIT_COMMAND_FAILED";
    throw error;
  }
  assertNotCancelled(boundary);
  return result.stdout.toString("utf8").trim();
};

const releaseStorageInvalid = (): GitReleaseAdapterError =>
  new GitReleaseAdapterError(
    "RELEASE_DESTINATION_INVALID",
    "Release Git effects require ordinary in-Repository object, ref, and reflog storage without indirection.",
  );

const lstatIfPresent = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw releaseStorageInvalid();
  }
};

const assertOrdinaryDirectory = (path: string, required: boolean): void => {
  const entry = lstatIfPresent(path);
  if (entry === null) {
    if (required) throw releaseStorageInvalid();
    return;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw releaseStorageInvalid();
};

const assertOrdinaryFileIfPresent = (path: string): void => {
  const entry = lstatIfPresent(path);
  if (entry && (entry.isSymbolicLink() || !entry.isFile())) throw releaseStorageInvalid();
};

const assertMissing = (path: string): void => {
  if (lstatIfPresent(path)) throw releaseStorageInvalid();
};

const assertOrdinaryAncestors = (root: string, relativeLeaf: string, rootRequired: boolean): void => {
  let current = root;
  for (const [index, part] of relativeLeaf.split("/").slice(0, -1).entries()) {
    current = join(current, part);
    const entry = lstatIfPresent(current);
    if (entry === null) {
      if (index === 0 && rootRequired) throw releaseStorageInvalid();
      return;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw releaseStorageInvalid();
  }
};

const assertSafeGitStorage = (repositoryRoot: string, ref: string): void => {
  const gitDirectory = join(repositoryRoot, ".git");
  assertOrdinaryDirectory(gitDirectory, true);
  assertOrdinaryDirectory(join(gitDirectory, "objects"), true);
  assertOrdinaryDirectory(join(gitDirectory, "objects", "info"), false);
  assertOrdinaryDirectory(join(gitDirectory, "objects", "pack"), false);
  assertMissing(join(gitDirectory, "objects", "info", "alternates"));
  assertMissing(join(gitDirectory, "commondir"));
  assertOrdinaryFileIfPresent(join(gitDirectory, "packed-refs"));
  assertOrdinaryAncestors(gitDirectory, ref, true);
  assertOrdinaryFileIfPresent(join(gitDirectory, ...ref.split("/")));
  const reflog = `logs/${ref}`;
  assertOrdinaryAncestors(gitDirectory, reflog, false);
  assertOrdinaryFileIfPresent(join(gitDirectory, ...reflog.split("/")));
};

const resolveRepository = async (
  repositoryReference: string,
  boundary: GitReleaseExecutionBoundary,
): Promise<string> => {
  if (!isAbsolute(repositoryReference)) {
    throw new GitReleaseAdapterError("RELEASE_DESTINATION_INVALID", "Release Repository references must be absolute paths.");
  }
  let root: string;
  try {
    if (lstatSync(repositoryReference).isSymbolicLink()) throw new Error("symbolic repository root");
    root = realpathSync(repositoryReference);
    const gitDirectory = lstatSync(join(root, ".git"));
    if (gitDirectory.isSymbolicLink() || !gitDirectory.isDirectory()) throw new Error("unsafe Git directory");
  } catch {
    throw new GitReleaseAdapterError(
      "RELEASE_DESTINATION_INVALID",
      "Release Git effects require a canonical Repository with a non-symbolic .git directory.",
    );
  }
  try {
    const topLevel = realpathSync(await git(root, ["rev-parse", "--show-toplevel"], boundary));
    const common = await git(root, ["rev-parse", "--git-common-dir"], boundary);
    const commonDir = realpathSync(isAbsolute(common) ? common : join(root, common));
    if (topLevel !== root || commonDir !== realpathSync(join(root, ".git"))) {
      throw new Error("linked worktree or nested root");
    }
  } catch (error) {
    if (isUnproven(error)) throw error;
    throw new GitReleaseAdapterError(
      "RELEASE_DESTINATION_INVALID",
      "Release Git effects require the canonical Repository root with its own ordinary Git directory.",
    );
  }
  return root;
};

const validateTargetBranch = async (branch: string, boundary: GitReleaseExecutionBoundary): Promise<void> => {
  const check = await runCommand(["check-ref-format", "--branch", branch], boundary);
  assertNotCancelled(boundary);
  if (
    check.status !== 0 ||
    branch.includes("\\") ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    branch === "integration" ||
    branch.startsWith("integration/")
  ) {
    throw new GitReleaseAdapterError(
      "RELEASE_TARGET_INVALID",
      "The selected Release target branch is not an allowed mutable branch.",
    );
  }
};

const refTip = async (repositoryRoot: string, ref: string, boundary: GitReleaseExecutionBoundary): Promise<string | null> => {
  const result = await runCommand(
    ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    boundary,
  );
  assertNotCancelled(boundary);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitReleaseAdapterError("RELEASE_DESTINATION_INVALID", "The selected Release target could not be inspected safely.");
  }
  return result.stdout.toString("utf8").trim();
};

const symbolicRefTarget = async (repositoryRoot: string, ref: string, boundary: GitReleaseExecutionBoundary): Promise<string | null> => {
  const result = await runCommand(["-C", repositoryRoot, "symbolic-ref", "--quiet", ref], boundary);
  assertNotCancelled(boundary);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitReleaseAdapterError("RELEASE_DESTINATION_INVALID", "The selected Release target could not be inspected safely.");
  }
  return result.stdout.toString("utf8").trim();
};

const refIsCheckedOut = async (repositoryRoot: string, ref: string, boundary: GitReleaseExecutionBoundary): Promise<boolean> =>
  (await git(repositoryRoot, ["worktree", "list", "--porcelain"], boundary))
    .split("\n")
    .some((line) => line === `branch ${ref}`);

const isAncestor = async (
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
  boundary: GitReleaseExecutionBoundary,
): Promise<boolean> => {
  const result = await runCommand(
    ["-C", repositoryRoot, "merge-base", "--is-ancestor", ancestor, descendant],
    boundary,
  );
  assertNotCancelled(boundary);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new GitReleaseAdapterError("RELEASE_DESTINATION_INVALID", "Release commit ancestry could not be proven safely.");
};

const now = (): string => new Date().toISOString();

const failure = (code: string, message: string): ReleaseOperationItemFinalize => ({
  state: "failed",
  failure: { code, message, observedAt: now() },
});

const unknown = (error: unknown): ReleaseOperationItemFinalize => ({
  state: "unknown",
  unknown: {
    code: "RELEASE_RECONCILIATION_INVALID",
    message:
      error instanceof GitReleaseAdapterError
        ? error.message
        : "The bounded Release Git operation did not produce a provable result.",
    observedAt: now(),
  },
});

const conflict = (message: string, observedDestinationState: unknown): ReleaseOperationItemFinalize => ({
  state: "destination-conflict",
  conflict: {
    code: "RELEASE_DESTINATION_CONFLICT",
    message,
    observedDestinationState,
    observedAt: now(),
  },
});

const receipt = (disposition: "applied" | "no-op", resultingTargetTip: string): ReleaseOperationItemFinalize => ({
  state: "succeeded",
  receipt: { kind: "merge", disposition, resultingTargetTip, observedAt: now() },
});

const authorityMatches = (request: Extract<ReleaseOperationEffectRequest, { readonly kind: "merge" }>): boolean => {
  const matches = request.acceptedAuthority.repositoryCommits.filter(
    (repository) => repository.repositoryReference === request.item.repositoryReference,
  );
  return matches.length === 1 && matches[0]?.commit === request.item.sourceCommit;
};

const prepare = async (
  request: Extract<ReleaseOperationEffectRequest, { readonly kind: "merge" }>,
  boundary: GitReleaseExecutionBoundary,
): Promise<PreparedRelease> => {
  if (!authorityMatches(request)) {
    throw new GitReleaseAdapterError(
      "RELEASE_ARTIFACT_NOT_AUTHORIZED",
      "The Release source commit does not exactly match the accepted authority for this Repository.",
    );
  }
  if (!commitPattern.test(request.item.sourceCommit) || !commitPattern.test(request.item.destination.expectedTargetTip)) {
    throw new GitReleaseAdapterError("RELEASE_TARGET_INVALID", "Release source and expected target tips must be exact lowercase Git commit identities.");
  }
  await validateTargetBranch(request.item.destination.targetBranch, boundary);
  const repositoryRoot = await resolveRepository(request.item.repositoryReference, boundary);
  const targetRef = `refs/heads/${request.item.destination.targetBranch}`;
  assertSafeGitStorage(repositoryRoot, targetRef);
  if (await symbolicRefTarget(repositoryRoot, targetRef, boundary)) {
    throw new GitReleaseAdapterError("RELEASE_TARGET_INVALID", "The selected Release target branch cannot be a symbolic ref.");
  }
  if (await refIsCheckedOut(repositoryRoot, targetRef, boundary)) {
    throw new GitReleaseAdapterError("RELEASE_TARGET_CHECKED_OUT", "The selected Release target branch is checked out in a Git worktree.");
  }
  try {
    await git(repositoryRoot, ["cat-file", "-e", `${request.item.sourceCommit}^{commit}`], boundary);
    await git(repositoryRoot, ["cat-file", "-e", `${request.item.destination.expectedTargetTip}^{commit}`], boundary);
  } catch (error) {
    if (isUnproven(error)) throw error;
    throw new GitReleaseAdapterError("RELEASE_TARGET_INVALID", "Release source and expected target tips must name readable Git commits.");
  }
  return {
    repositoryRoot,
    targetRef,
    sourceCommit: request.item.sourceCommit,
    expectedTargetTip: request.item.destination.expectedTargetTip,
    currentTargetTip: await refTip(repositoryRoot, targetRef, boundary),
  };
};

const reconcilePrepared = async (
  prepared: PreparedRelease,
  boundary: GitReleaseExecutionBoundary,
): Promise<ReleaseOperationReconcileObservation> => {
  assertSafeGitStorage(prepared.repositoryRoot, prepared.targetRef);
  if (await symbolicRefTarget(prepared.repositoryRoot, prepared.targetRef, boundary)) {
    throw new GitReleaseAdapterError("RELEASE_TARGET_INVALID", "The selected Release target branch cannot be a symbolic ref.");
  }
  const targetTip = await refTip(prepared.repositoryRoot, prepared.targetRef, boundary);
  if (targetTip === null) {
    return {
      state: "destination-conflict",
      conflict: {
        code: "RELEASE_DESTINATION_CONFLICT",
        message: "The selected Release target branch no longer resolves to a commit.",
        observedDestinationState: { expectedTargetTip: prepared.expectedTargetTip, observedTargetTip: null },
        observedAt: now(),
      },
    };
  }
  if (await isAncestor(prepared.repositoryRoot, prepared.sourceCommit, targetTip, boundary)) {
    const applied = targetTip === prepared.sourceCommit && prepared.expectedTargetTip !== prepared.sourceCommit && (await isAncestor(prepared.repositoryRoot, prepared.expectedTargetTip, prepared.sourceCommit, boundary));
    return { state: "succeeded", receipt: (receipt(applied ? "applied" : "no-op", targetTip) as Extract<ReleaseOperationItemFinalize, { state: "succeeded" }>).receipt };
  }
  if (targetTip === prepared.expectedTargetTip) return { state: "pending" };
  return {
    state: "destination-conflict",
    conflict: {
      code: "RELEASE_DESTINATION_CONFLICT",
      message: "The Release target tip differs from both the expected tip and an exact source-containing result.",
      observedDestinationState: { expectedTargetTip: prepared.expectedTargetTip, observedTargetTip: targetTip, sourceCommit: prepared.sourceCommit },
      observedAt: now(),
    },
  };
};

export type GitReleaseAdapter = ReleaseOperationEffectAdapter;

export const openLocalGitReleaseAdapter = (
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly gitExecutable?: string;
  } = {},
): GitReleaseAdapter => {
  const locks = new Map<string, Promise<void>>();
  const boundary = (): GitReleaseExecutionBoundary => ({
    executable: options.gitExecutable ?? "git",
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const withTargetLock = async <Result>(key: string, action: () => Promise<Result>): Promise<Result> => {
    const predecessor = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = predecessor.then(() => current);
    locks.set(key, queued);
    await predecessor;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  };
  return {
    execute: async (request) => {
      if (request.kind !== "merge") return failure("RELEASE_OPERATION_BLOCKED", "This Git Release Adapter only executes merge-kind Release operations.");
      const executionBoundary = boundary();
      let prepared: PreparedRelease;
      try {
        prepared = await prepare(request, executionBoundary);
      } catch (error) {
        return isUnproven(error) ? unknown(error) : failure(error instanceof GitReleaseAdapterError ? error.code : "RELEASE_DESTINATION_INVALID", error instanceof Error ? error.message : "Release Git validation failed.");
      }
      return withTargetLock(`${prepared.repositoryRoot}:${prepared.targetRef}`, async () => {
        try {
          const currentTargetTip = await refTip(prepared.repositoryRoot, prepared.targetRef, executionBoundary);
          if (currentTargetTip === null) return conflict("The selected Release target branch no longer resolves to a commit.", { expectedTargetTip: prepared.expectedTargetTip, observedTargetTip: null });
          if (await isAncestor(prepared.repositoryRoot, prepared.sourceCommit, currentTargetTip, executionBoundary)) return receipt("no-op", currentTargetTip);
          if (currentTargetTip !== prepared.expectedTargetTip) return conflict("The Release target changed before its expected-tip compare-and-swap.", { expectedTargetTip: prepared.expectedTargetTip, observedTargetTip: currentTargetTip, sourceCommit: prepared.sourceCommit });
          if (!(await isAncestor(prepared.repositoryRoot, prepared.expectedTargetTip, prepared.sourceCommit, executionBoundary))) {
            return failure("RELEASE_FAST_FORWARD_REQUIRED", "The accepted source cannot fast-forward the selected Release target branch.");
          }
          assertSafeGitStorage(prepared.repositoryRoot, prepared.targetRef);
          if (await symbolicRefTarget(prepared.repositoryRoot, prepared.targetRef, executionBoundary)) {
            return failure("RELEASE_TARGET_INVALID", "The selected Release target branch cannot be a symbolic ref.");
          }
          if (await refIsCheckedOut(prepared.repositoryRoot, prepared.targetRef, executionBoundary)) {
            return failure("RELEASE_TARGET_CHECKED_OUT", "The selected Release target branch is checked out in a Git worktree.");
          }
          const result = await runCommand(
            ["-C", prepared.repositoryRoot, "update-ref", "--no-deref", prepared.targetRef, prepared.sourceCommit, prepared.expectedTargetTip],
            executionBoundary,
          );
          assertNotCancelled(executionBoundary);
          if (result.status !== 0) {
            const observed = await refTip(prepared.repositoryRoot, prepared.targetRef, executionBoundary);
            if (observed !== null && (await isAncestor(prepared.repositoryRoot, prepared.sourceCommit, observed, executionBoundary))) return receipt("no-op", observed);
            return conflict("The Release target changed during its expected-tip compare-and-swap.", { expectedTargetTip: prepared.expectedTargetTip, observedTargetTip: observed, sourceCommit: prepared.sourceCommit });
          }
          assertSafeGitStorage(prepared.repositoryRoot, prepared.targetRef);
          const observed = await refTip(prepared.repositoryRoot, prepared.targetRef, executionBoundary);
          if (observed !== prepared.sourceCommit) return unknown(new GitReleaseAdapterError("RELEASE_RECONCILIATION_INVALID", "The Release target could not be proven after compare-and-swap."));
          return receipt("applied", observed);
        } catch (error) {
          return isUnproven(error) ? unknown(error) : failure(error instanceof GitReleaseAdapterError ? error.code : "RELEASE_DESTINATION_INVALID", error instanceof Error ? error.message : "Release Git execution failed.");
        }
      });
    },
    reconcile: async (request) => {
      if (request.kind !== "merge") {
        return { state: "unknown", unknown: { code: "RELEASE_OPERATION_BLOCKED", message: "This Git Release Adapter only reconciles merge-kind Release operations.", observedAt: now() } };
      }
      try {
        const prepared = await prepare(request, boundary());
        return await reconcilePrepared(prepared, boundary());
      } catch (error) {
        return {
          state: "unknown",
          unknown: {
            code: error instanceof GitReleaseAdapterError ? error.code : "RELEASE_RECONCILIATION_INVALID",
            message: error instanceof Error ? error.message : "The Release Git effect could not be proven safely.",
            observedAt: now(),
          },
        };
      }
    },
  };
};
