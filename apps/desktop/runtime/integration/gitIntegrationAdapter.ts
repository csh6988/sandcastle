import { execFileSync, spawnSync } from "node:child_process";
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
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
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

const git = (
  repositoryRoot: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Buffer;
    readonly boundary?: GitExecutionBoundary;
  } = {},
): string => {
  const boundary = options.boundary ?? { timeoutMs: 30_000 };
  assertNotCancelled(boundary);
  const value = execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: options.env ?? gitEnvironment(),
    timeout: boundary.timeoutMs,
    killSignal: "SIGKILL",
    ...(options.input ? { input: options.input } : {}),
  }).trim();
  assertNotCancelled(boundary);
  return value;
};

const gitBuffer = (
  repositoryRoot: string,
  args: readonly string[],
  boundary: GitExecutionBoundary,
): Buffer => {
  assertNotCancelled(boundary);
  const value = execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer",
    env: gitEnvironment(),
    timeout: boundary.timeoutMs,
    killSignal: "SIGKILL",
  });
  assertNotCancelled(boundary);
  return value;
};

const refTip = (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): string | null => {
  assertNotCancelled(boundary);
  const result = spawnSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: boundary.timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  assertNotCancelled(boundary);
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      result.stderr.trim() || `Git ref ${ref} could not be queried.`,
    );
  }
  return result.stdout.trim();
};

const validateRefName = (
  branch: string,
  kind: "integration" | "source",
  boundary: GitExecutionBoundary,
) => {
  assertNotCancelled(boundary);
  const check = spawnSync("git", ["check-ref-format", "--branch", branch], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: boundary.timeoutMs,
    killSignal: "SIGKILL",
  });
  assertNotCancelled(boundary);
  if (check.error) throw check.error;
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

const resolveRepository = (
  repositoryReference: string,
  boundary: GitExecutionBoundary,
): string => {
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
  let topLevel: string;
  let commonDir: string;
  try {
    topLevel = realpathSync(
      git(root, ["rev-parse", "--show-toplevel"], { boundary }),
    );
    const common = git(root, ["rev-parse", "--git-common-dir"], { boundary });
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

const symbolicRefTarget = (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): string | null => {
  assertNotCancelled(boundary);
  const result = spawnSync(
    "git",
    ["-C", repositoryRoot, "symbolic-ref", "--quiet", ref],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: boundary.timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  assertNotCancelled(boundary);
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      `Git ref ${ref} could not be inspected safely.`,
    );
  }
  return result.stdout.trim();
};

const refIsCheckedOut = (
  repositoryRoot: string,
  ref: string,
  boundary: GitExecutionBoundary,
): boolean =>
  git(repositoryRoot, ["worktree", "list", "--porcelain"], { boundary })
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

const prepare = (
  input: GitIntegrationRequest,
  boundary: GitExecutionBoundary,
): PreparedIntegration => {
  validateRefName(input.integrationBranch, "integration", boundary);
  validateRefName(input.sourceBranch, "source", boundary);
  if (input.sourceBranch === input.integrationBranch) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "An Integration operation cannot use its generation branch as a source branch.",
    );
  }
  const repositoryRoot = resolveRepository(input.repositoryReference, boundary);
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
  if (symbolicRefTarget(repositoryRoot, sourceRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The reviewed source branch cannot be a symbolic ref.",
    );
  }
  const sourceTip = refTip(repositoryRoot, sourceRef, boundary);
  if (sourceTip !== input.sourceCommit) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_SOURCE_DRIFT",
      `Source branch ${input.sourceBranch} is at ${sourceTip ?? "missing"}, not the reviewed commit ${input.sourceCommit}.`,
    );
  }
  try {
    git(repositoryRoot, ["cat-file", "-e", `${input.baseCommit}^{commit}`], {
      boundary,
    });
    git(repositoryRoot, ["cat-file", "-e", `${input.sourceCommit}^{commit}`], {
      boundary,
    });
    git(
      repositoryRoot,
      ["merge-base", "--is-ancestor", input.baseCommit, input.sourceCommit],
      { boundary },
    );
    git(repositoryRoot, ["cat-file", "-e", `${input.expectedTip}^{commit}`], {
      boundary,
    });
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw new GitIntegrationAdapterError(
      "INTEGRATION_COMMIT_INVALID",
      "Integration base, source, and expected tip must be readable commits, and source must descend from the frozen base.",
    );
  }
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  if (symbolicRefTarget(repositoryRoot, integrationRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be a symbolic ref.",
    );
  }
  if (refIsCheckedOut(repositoryRoot, integrationRef, boundary)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be checked out in a Worktree.",
    );
  }
  const currentTip = refTip(repositoryRoot, integrationRef, boundary);
  const scratch = mkdtempSync(join(tmpdir(), "sandcastle-integration-index-"));
  const indexPath = join(scratch, "index");
  const env = gitEnvironment({ GIT_INDEX_FILE: indexPath });
  try {
    git(repositoryRoot, ["read-tree", input.expectedTip], { env, boundary });
    const delta = gitBuffer(
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
    const applied = spawnSync(
      "git",
      [
        "-C",
        repositoryRoot,
        "apply",
        "--cached",
        "--3way",
        "--binary",
        "--whitespace=nowarn",
      ],
      {
        env,
        input: delta,
        encoding: "utf8",
        timeout: boundary.timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    assertNotCancelled(boundary);
    if (applied.error) throw applied.error;
    if (applied.status !== 0) {
      const conflictFiles = git(repositoryRoot, ["ls-files", "-u"], {
        env,
        boundary,
      })
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
    const tree = git(repositoryRoot, ["write-tree"], { env, boundary });
    const commitEnvironment: NodeJS.ProcessEnv = {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: "Sandcastle Integration Adapter",
      GIT_AUTHOR_EMAIL: "integration@sandcastle.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Sandcastle Integration Adapter",
      GIT_COMMITTER_EMAIL: "integration@sandcastle.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const resultingCommit = git(
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
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): GitIntegrationAdapter => {
  const boundary: GitExecutionBoundary = {
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  };
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
    execute: (input) => {
      let prepared: PreparedIntegration;
      try {
        prepared = prepare(input, boundary);
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
        git(
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
          { boundary },
        );
      } catch (error) {
        if (isBoundaryError(error)) return unknown(error);
        const observed = refTip(
          prepared.repositoryRoot,
          prepared.integrationRef,
          boundary,
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
    },
    reconcile: (input): GitIntegrationReconciliation => {
      try {
        const prepared = prepare(input, boundary);
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
  };
};
