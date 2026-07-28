import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  GitIntegrationAdapter,
  GitIntegrationReconciliation,
  GitIntegrationRequest,
  GitIntegrationResult,
} from "./integrationRuntime.js";

export class GitIntegrationAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitIntegrationAdapterError";
  }
}

const zeroCommit = "0".repeat(40);

type GitExecutionBoundary = {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

type GitCommandResult = {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

const assertNotCancelled = (boundary: GitExecutionBoundary): void => {
  if (boundary.signal?.aborted) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_CANCELLED",
      "The Integration Git operation was cancelled before its outcome was proven.",
    );
  }
};

const isBoundaryError = (error: unknown): boolean =>
  (error instanceof GitIntegrationAdapterError &&
    error.code === "INTEGRATION_GIT_CANCELLED") ||
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ETIMEDOUT");

const gitEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
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
    ...overrides,
  }) satisfies NodeJS.ProcessEnv;

const timeoutError = (): NodeJS.ErrnoException => {
  const error = new Error(
    "The Integration Git command exceeded its bounded execution time.",
  ) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
};

const runCommand = (
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Buffer;
    readonly boundary: GitExecutionBoundary;
  },
): Promise<GitCommandResult> => {
  const { boundary } = options;
  assertNotCancelled(boundary);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(boundary.executable, [...args], {
      env: options.env ?? gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
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
          new GitIntegrationAdapterError(
            "INTEGRATION_GIT_CANCELLED",
            "The Integration Git operation was cancelled before its outcome was proven.",
          ),
        );
        return;
      }
      if (timedOut) {
        reject(timeoutError());
        return;
      }
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
};

const git = async (
  repositoryRoot: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Buffer;
    readonly boundary: GitExecutionBoundary;
  },
): Promise<string> => {
  const result = await runCommand(["-C", repositoryRoot, ...args], options);
  if (result.status !== 0) {
    const error = new Error(
      result.stderr.toString("utf8").trim() ||
        `Git command ${args[0] ?? "unknown"} failed.`,
    ) as NodeJS.ErrnoException;
    error.code = "INTEGRATION_GIT_COMMAND_FAILED";
    throw error;
  }
  assertNotCancelled(options.boundary);
  return result.stdout.toString("utf8").trim();
};

const gitBuffer = async (
  repositoryRoot: string,
  args: readonly string[],
  boundary: GitExecutionBoundary,
): Promise<Buffer> => {
  const result = await runCommand(["-C", repositoryRoot, ...args], {
    boundary,
    env: gitEnvironment(),
  });
  if (result.status !== 0) {
    const error = new Error(
      result.stderr.toString("utf8").trim() || "Git command failed.",
    ) as NodeJS.ErrnoException;
    error.code = "INTEGRATION_GIT_COMMAND_FAILED";
    throw error;
  }
  assertNotCancelled(boundary);
  return result.stdout;
};

const refTip = async (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): Promise<string | null> => {
  const result = await runCommand(
    [
      "-C",
      repositoryRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ],
    { boundary, env: gitEnvironment() },
  );
  assertNotCancelled(boundary);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      result.stderr.toString("utf8").trim() ||
        `Git ref ${ref} could not be queried.`,
    );
  }
  return result.stdout.toString("utf8").trim();
};

const validateRefName = async (
  branch: string,
  kind: "integration" | "source",
  boundary: GitExecutionBoundary,
): Promise<void> => {
  const check = await runCommand(["check-ref-format", "--branch", branch], {
    boundary,
    env: gitEnvironment(),
  });
  assertNotCancelled(boundary);
  if (
    check.status !== 0 ||
    branch.includes("\\") ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    (kind === "integration" &&
      !/^integration\/[A-Za-z0-9._-]+\/g[1-9][0-9]*$/.test(branch))
  ) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      `${kind === "integration" ? "Integration" : "Source"} branch ${branch} is not an allowed Git ref.`,
    );
  }
};

const gitStorageInvalid = (): GitIntegrationAdapterError =>
  new GitIntegrationAdapterError(
    "INTEGRATION_REPOSITORY_INVALID",
    "Integration Git effects require ordinary in-Repository object, ref, and reflog storage without indirection.",
  );

const lstatIfPresent = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw gitStorageInvalid();
  }
};

const assertOrdinaryDirectory = (path: string, required: boolean): void => {
  const entry = lstatIfPresent(path);
  if (entry === null) {
    if (required) throw gitStorageInvalid();
    return;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw gitStorageInvalid();
  }
};

const assertOrdinaryFileIfPresent = (path: string): void => {
  const entry = lstatIfPresent(path);
  if (entry && (entry.isSymbolicLink() || !entry.isFile())) {
    throw gitStorageInvalid();
  }
};

const assertMissing = (path: string): void => {
  if (lstatIfPresent(path)) throw gitStorageInvalid();
};

const assertOrdinaryAncestorDirectories = (
  root: string,
  relativeLeaf: string,
  rootRequired: boolean,
): void => {
  const parts = relativeLeaf.split("/").slice(0, -1);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const entry = lstatIfPresent(current);
    if (entry === null) {
      if (index === 0 && rootRequired) throw gitStorageInvalid();
      return;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw gitStorageInvalid();
    }
  }
};

const assertSafeGitStorage = (
  repositoryRoot: string,
  refs: readonly string[],
): void => {
  const gitDirectory = join(repositoryRoot, ".git");
  assertOrdinaryDirectory(gitDirectory, true);
  assertOrdinaryDirectory(join(gitDirectory, "objects"), true);
  assertOrdinaryDirectory(join(gitDirectory, "objects", "info"), false);
  assertOrdinaryDirectory(join(gitDirectory, "objects", "pack"), false);
  assertMissing(join(gitDirectory, "objects", "info", "alternates"));
  assertMissing(join(gitDirectory, "commondir"));
  assertOrdinaryFileIfPresent(join(gitDirectory, "packed-refs"));
  for (const ref of refs) {
    assertOrdinaryAncestorDirectories(gitDirectory, ref, true);
    assertOrdinaryFileIfPresent(join(gitDirectory, ...ref.split("/")));
    const reflog = `logs/${ref}`;
    assertOrdinaryAncestorDirectories(gitDirectory, reflog, false);
    assertOrdinaryFileIfPresent(join(gitDirectory, ...reflog.split("/")));
  }
};

const resolveRepository = async (
  repositoryReference: string,
  boundary: GitExecutionBoundary,
): Promise<string> => {
  if (!isAbsolute(repositoryReference)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      "Integration Repository references must be absolute paths.",
    );
  }
  let root: string;
  try {
    if (lstatSync(repositoryReference).isSymbolicLink()) {
      throw new Error("symbolic Repository root");
    }
    root = realpathSync(repositoryReference);
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      `Integration Repository ${repositoryReference} does not exist.`,
    );
  }
  try {
    const gitDirectory = lstatSync(join(root, ".git"));
    if (gitDirectory.isSymbolicLink() || !gitDirectory.isDirectory()) {
      throw new Error("unsafe Git directory");
    }
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      "Integration Git effects require a canonical Repository with a non-symbolic .git directory.",
    );
  }
  let topLevel: string;
  let commonDir: string;
  try {
    topLevel = realpathSync(
      await git(root, ["rev-parse", "--show-toplevel"], { boundary }),
    );
    const common = await git(root, ["rev-parse", "--git-common-dir"], {
      boundary,
    });
    commonDir = realpathSync(isAbsolute(common) ? common : join(root, common));
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      `Integration Repository ${repositoryReference} is not a readable Git Repository.`,
    );
  }
  if (topLevel !== root || commonDir !== realpathSync(join(root, ".git"))) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      "Integration Git effects require the canonical Repository root, not a linked Worktree or nested path.",
    );
  }
  return root;
};

const symbolicRefTarget = async (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): Promise<string | null> => {
  const result = await runCommand(
    ["-C", repositoryRoot, "symbolic-ref", "--quiet", ref],
    { boundary, env: gitEnvironment() },
  );
  assertNotCancelled(boundary);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      `Git ref ${ref} could not be inspected safely.`,
    );
  }
  return result.stdout.toString("utf8").trim();
};

const refIsCheckedOut = async (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): Promise<boolean> =>
  (await git(repositoryRoot, ["worktree", "list", "--porcelain"], { boundary }))
    .split("\n")
    .some((line) => line === `branch ${ref}`);

type PreparedIntegration = {
  readonly repositoryRoot: string;
  readonly integrationRef: string;
  readonly currentTip: string | null;
  readonly resultingCommit: string;
  readonly tree: string;
  readonly conflictFiles: readonly string[];
};

const prepare = async (
  input: GitIntegrationRequest,
  boundary: GitExecutionBoundary,
): Promise<PreparedIntegration> => {
  await validateRefName(input.integrationBranch, "integration", boundary);
  await validateRefName(input.sourceBranch, "source", boundary);
  if (input.sourceBranch === input.integrationBranch) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "An Integration operation cannot use its generation branch as a source branch.",
    );
  }
  const repositoryRoot = await resolveRepository(
    input.repositoryReference,
    boundary,
  );
  for (const [label, value] of [
    ["base commit", input.baseCommit],
    ["source commit", input.sourceCommit],
    ["expected Integration tip", input.expectedTip],
  ] as const) {
    if (!/^[a-f0-9]{40}$/.test(value)) {
      throw new GitIntegrationAdapterError(
        "INTEGRATION_COMMIT_INVALID",
        `${label} must be an exact lowercase Git commit identity.`,
      );
    }
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REQUEST_INVALID",
      "Integration request hash must be a lowercase SHA-256 identity.",
    );
  }
  const sourceRef = `refs/heads/${input.sourceBranch}`;
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  assertSafeGitStorage(repositoryRoot, [sourceRef, integrationRef]);
  if (await symbolicRefTarget(repositoryRoot, sourceRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The reviewed source branch cannot be a symbolic ref.",
    );
  }
  const sourceTip = await refTip(repositoryRoot, sourceRef, boundary);
  if (sourceTip !== input.sourceCommit) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_SOURCE_DRIFT",
      `Source branch ${input.sourceBranch} is at ${sourceTip ?? "missing"}, not the reviewed commit ${input.sourceCommit}.`,
    );
  }
  try {
    await git(
      repositoryRoot,
      ["cat-file", "-e", `${input.baseCommit}^{commit}`],
      {
        boundary,
      },
    );
    await git(
      repositoryRoot,
      ["cat-file", "-e", `${input.sourceCommit}^{commit}`],
      { boundary },
    );
    await git(
      repositoryRoot,
      ["merge-base", "--is-ancestor", input.baseCommit, input.sourceCommit],
      { boundary },
    );
    await git(
      repositoryRoot,
      ["cat-file", "-e", `${input.expectedTip}^{commit}`],
      { boundary },
    );
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw new GitIntegrationAdapterError(
      "INTEGRATION_COMMIT_INVALID",
      "Integration base, source, and expected tip must be readable commits, and source must descend from the frozen base.",
    );
  }
  if (await symbolicRefTarget(repositoryRoot, integrationRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be a symbolic ref.",
    );
  }
  if (await refIsCheckedOut(repositoryRoot, integrationRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be checked out in a Worktree.",
    );
  }
  const currentTip = await refTip(repositoryRoot, integrationRef, boundary);
  const scratch = mkdtempSync(join(tmpdir(), "sandcastle-integration-index-"));
  const indexPath = join(scratch, "index");
  const env = gitEnvironment({ GIT_INDEX_FILE: indexPath });
  try {
    await git(repositoryRoot, ["read-tree", input.expectedTip], {
      env,
      boundary,
    });
    const delta = await gitBuffer(
      repositoryRoot,
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        input.baseCommit,
        input.sourceCommit,
        "--",
      ],
      boundary,
    );
    const applied = await runCommand(
      [
        "-C",
        repositoryRoot,
        "apply",
        "--cached",
        "--3way",
        "--binary",
        "--whitespace=nowarn",
      ],
      { env, input: delta, boundary },
    );
    assertNotCancelled(boundary);
    if (applied.status !== 0) {
      const conflictFiles = (
        await git(repositoryRoot, ["ls-files", "-u"], { env, boundary })
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t").at(-1)!)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort();
      return {
        repositoryRoot,
        integrationRef,
        currentTip,
        resultingCommit: input.expectedTip,
        tree: "",
        conflictFiles,
      };
    }
    const tree = await git(repositoryRoot, ["write-tree"], { env, boundary });
    const commitEnvironment: NodeJS.ProcessEnv = {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: "Sandcastle Integration Adapter",
      GIT_AUTHOR_EMAIL: "integration@sandcastle.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Sandcastle Integration Adapter",
      GIT_COMMITTER_EMAIL: "integration@sandcastle.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const resultingCommit = await git(
      repositoryRoot,
      ["commit-tree", tree, "-p", input.expectedTip],
      {
        env: commitEnvironment,
        boundary,
        input: Buffer.from(
          `Sandcastle Integration operation ${input.operationId}\n\nGeneration: ${input.generationId}\nRequest: ${input.requestHash}\n`,
        ),
      },
    );
    return {
      repositoryRoot,
      integrationRef,
      currentTip,
      resultingCommit,
      tree,
      conflictFiles: [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const succeeded = (
  input: GitIntegrationRequest,
  prepared: PreparedIntegration,
): Extract<GitIntegrationResult, { readonly status: "succeeded" }> => ({
  status: "succeeded",
  beforeTip: input.expectedTip,
  afterTip: prepared.resultingCommit,
  resultingCommit: prepared.resultingCommit,
  receipt: {
    schemaVersion: 1,
    operationId: input.operationId,
    generationId: input.generationId,
    repositoryRoot: prepared.repositoryRoot,
    integrationRef: prepared.integrationRef,
    baseCommit: input.baseCommit,
    sourceCommit: input.sourceCommit,
    beforeTip: input.expectedTip,
    afterTip: prepared.resultingCommit,
    resultingTree: prepared.tree,
    requestHash: input.requestHash,
    idempotencyKey: input.idempotencyKey,
  },
});

export const openLocalGitIntegrationAdapter = (
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly gitExecutable?: string;
  } = {},
): GitIntegrationAdapter => {
  const active = new Map<string, AbortController>();
  const boundary = (signal?: AbortSignal): GitExecutionBoundary => ({
    executable: options.gitExecutable ?? "git",
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(signal ? { signal } : options.signal ? { signal: options.signal } : {}),
  });
  const unknown = (
    error: unknown,
  ): Extract<GitIntegrationResult, { status: "unknown" }> => ({
    status: "unknown",
    code: "RECONCILE_UNKNOWN",
    message:
      error instanceof GitIntegrationAdapterError
        ? error.message
        : "The bounded Integration Git operation did not produce a provable result.",
    evidence: {
      causeCode:
        error instanceof GitIntegrationAdapterError
          ? error.code
          : ((error as NodeJS.ErrnoException)?.code ??
            "INTEGRATION_GIT_TIMEOUT"),
    },
  });
  return {
    execute: async (input) => {
      const controller = new AbortController();
      const abortFromParent = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else
        options.signal?.addEventListener("abort", abortFromParent, {
          once: true,
        });
      active.set(input.operationId, controller);
      const executionBoundary = boundary(controller.signal);
      try {
        let prepared: PreparedIntegration;
        try {
          prepared = await prepare(input, executionBoundary);
        } catch (error) {
          if (
            error instanceof GitIntegrationAdapterError &&
            error.code !== "INTEGRATION_GIT_CANCELLED"
          ) {
            return {
              status: "failed",
              writeStatus: "not-started",
              code: error.code,
              message: error.message,
              evidence: {
                causeCode: error.code,
                requestHash: input.requestHash,
                expectedTip: input.expectedTip,
              },
            };
          }
          return unknown(error);
        }
        if (prepared.conflictFiles.length > 0) {
          return {
            status: "conflict",
            writeStatus: "not-started",
            code: "INTEGRATION_GIT_CONFLICT",
            message:
              "The reviewed full-tree delta conflicts with the exact Integration branch tip.",
            evidence: {
              baseCommit: input.baseCommit,
              sourceCommit: input.sourceCommit,
              targetCommit: input.expectedTip,
              conflictFiles: prepared.conflictFiles,
            },
          };
        }
        if (prepared.currentTip === prepared.resultingCommit) {
          return succeeded(input, prepared);
        }
        if (
          prepared.currentTip !== null &&
          prepared.currentTip !== input.expectedTip
        ) {
          return {
            status: "failed",
            writeStatus: "not-started",
            code: "INTEGRATION_CONFLICT",
            message: `Integration branch is at ${prepared.currentTip}, not expected tip ${input.expectedTip}.`,
            evidence: {
              expectedTip: input.expectedTip,
              actualTip: prepared.currentTip,
              resultingCommit: prepared.resultingCommit,
            },
          };
        }
        const expectedOld = prepared.currentTip ?? zeroCommit;
        try {
          assertSafeGitStorage(prepared.repositoryRoot, [
            prepared.integrationRef,
          ]);
          await git(
            prepared.repositoryRoot,
            [
              "update-ref",
              "--no-deref",
              "-m",
              `sandcastle integration ${input.operationId}`,
              prepared.integrationRef,
              prepared.resultingCommit,
              expectedOld,
            ],
            { boundary: executionBoundary },
          );
        } catch (error) {
          if (isBoundaryError(error)) return unknown(error);
          if (error instanceof GitIntegrationAdapterError) {
            return {
              status: "failed",
              writeStatus: "not-started",
              code: error.code,
              message: error.message,
              evidence: {
                causeCode: error.code,
                requestHash: input.requestHash,
                expectedTip: input.expectedTip,
              },
            };
          }
          const observed = await refTip(
            prepared.repositoryRoot,
            prepared.integrationRef,
            executionBoundary,
          );
          if (observed === prepared.resultingCommit) {
            return succeeded(input, prepared);
          }
          return {
            status: "failed",
            writeStatus: "not-started",
            code: "INTEGRATION_CONFLICT",
            message: "Integration branch changed during compare-and-swap.",
            evidence: {
              expectedTip: prepared.currentTip,
              actualTip: observed,
              resultingCommit: prepared.resultingCommit,
            },
          };
        }
        return succeeded(input, prepared);
      } finally {
        active.delete(input.operationId);
        options.signal?.removeEventListener("abort", abortFromParent);
      }
    },
    reconcile: async (input): Promise<GitIntegrationReconciliation> => {
      try {
        const prepared = await prepare(input, boundary());
        if (prepared.conflictFiles.length > 0) {
          return {
            status: "conflict",
            writeStatus: "not-started",
            code: "INTEGRATION_CONFLICT",
            message:
              "The Integration operation cannot be proven because its exact delta conflicts.",
            evidence: { conflictFiles: prepared.conflictFiles },
          };
        }
        if (prepared.currentTip === prepared.resultingCommit) {
          return succeeded(input, prepared);
        }
        if (
          prepared.currentTip === null ||
          prepared.currentTip === input.expectedTip
        ) {
          return { status: "not-applied" };
        }
        return {
          status: "conflict",
          writeStatus: "not-started",
          code: "INTEGRATION_CONFLICT",
          message:
            "Integration branch tip differs from both the expected and deterministic resulting commits.",
          evidence: {
            expectedTip: input.expectedTip,
            actualTip: prepared.currentTip,
            resultingCommit: prepared.resultingCommit,
          },
        };
      } catch (error) {
        if (error instanceof GitIntegrationAdapterError) {
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message: error.message,
            evidence: { causeCode: error.code },
          };
        }
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "The Integration Git effect could not be queried.",
          evidence: { error: String(error) },
        };
      }
    },
    cancel: async (operationId) => {
      active.get(operationId)?.abort();
    },
  };
};
