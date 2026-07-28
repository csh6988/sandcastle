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

const gitEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...overrides,
  };
};

const git = (
  repositoryRoot: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly input?: Buffer } = {},
): string =>
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: options.env ?? gitEnvironment(),
    ...(options.input ? { input: options.input } : {}),
  }).trim();

const gitBuffer = (repositoryRoot: string, args: readonly string[]): Buffer =>
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer",
    env: gitEnvironment(),
  });

const refTip = (repositoryRoot: string, ref: string): string | null => {
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
    { encoding: "utf8", env: gitEnvironment() },
  );
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      result.stderr.trim() || `Git ref ${ref} could not be queried.`,
    );
  }
  return result.stdout.trim();
};

const validateRefName = (branch: string, kind: "integration" | "source") => {
  const check = spawnSync("git", ["check-ref-format", "--branch", branch], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
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

const resolveRepository = (repositoryReference: string): string => {
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
  } catch {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REPOSITORY_INVALID",
      `Integration Repository ${repositoryReference} does not exist.`,
    );
  }
  let topLevel: string;
  let commonDir: string;
  try {
    topLevel = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
    const common = git(root, ["rev-parse", "--git-common-dir"]);
    commonDir = realpathSync(isAbsolute(common) ? common : join(root, common));
  } catch {
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
): string | null => {
  const result = spawnSync(
    "git",
    ["-C", repositoryRoot, "symbolic-ref", "--quiet", ref],
    { encoding: "utf8", env: gitEnvironment() },
  );
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_GIT_UNQUERYABLE",
      `Git ref ${ref} could not be inspected safely.`,
    );
  }
  return result.stdout.trim();
};

const refIsCheckedOut = (repositoryRoot: string, ref: string): boolean =>
  git(repositoryRoot, ["worktree", "list", "--porcelain"])
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

const prepare = (input: GitIntegrationRequest): PreparedIntegration => {
  validateRefName(input.integrationBranch, "integration");
  validateRefName(input.sourceBranch, "source");
  if (input.sourceBranch === input.integrationBranch) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "An Integration operation cannot use its generation branch as a source branch.",
    );
  }
  const repositoryRoot = resolveRepository(input.repositoryReference);
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
  if (symbolicRefTarget(repositoryRoot, sourceRef)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The reviewed source branch cannot be a symbolic ref.",
    );
  }
  const sourceTip = refTip(repositoryRoot, sourceRef);
  if (sourceTip !== input.sourceCommit) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_SOURCE_DRIFT",
      `Source branch ${input.sourceBranch} is at ${sourceTip ?? "missing"}, not the reviewed commit ${input.sourceCommit}.`,
    );
  }
  try {
    git(repositoryRoot, ["cat-file", "-e", `${input.baseCommit}^{commit}`]);
    git(repositoryRoot, ["cat-file", "-e", `${input.sourceCommit}^{commit}`]);
    git(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      input.baseCommit,
      input.sourceCommit,
    ]);
    git(repositoryRoot, ["cat-file", "-e", `${input.expectedTip}^{commit}`]);
  } catch {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_COMMIT_INVALID",
      "Integration base, source, and expected tip must be readable commits, and source must descend from the frozen base.",
    );
  }
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  if (symbolicRefTarget(repositoryRoot, integrationRef)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be a symbolic ref.",
    );
  }
  if (refIsCheckedOut(repositoryRoot, integrationRef)) {
    throw new GitIntegrationAdapterError(
      "INTEGRATION_REF_INVALID",
      "The Integration generation branch cannot be checked out in a Worktree.",
    );
  }
  const currentTip = refTip(repositoryRoot, integrationRef);
  const scratch = mkdtempSync(join(tmpdir(), "sandcastle-integration-index-"));
  const indexPath = join(scratch, "index");
  const env = gitEnvironment({ GIT_INDEX_FILE: indexPath });
  try {
    git(repositoryRoot, ["read-tree", input.expectedTip], { env });
    const delta = gitBuffer(repositoryRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      input.baseCommit,
      input.sourceCommit,
      "--",
    ]);
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
      { env, input: delta, encoding: "utf8" },
    );
    if (applied.status !== 0) {
      const conflictFiles = git(repositoryRoot, ["ls-files", "-u"], { env })
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
    const tree = git(repositoryRoot, ["write-tree"], { env });
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

export const openLocalGitIntegrationAdapter = (): GitIntegrationAdapter => ({
  execute: (input) => {
    const prepared = prepare(input);
    if (prepared.conflictFiles.length > 0) {
      return {
        status: "conflict",
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
      git(prepared.repositoryRoot, [
        "update-ref",
        "--no-deref",
        "-m",
        `sandcastle integration ${input.operationId}`,
        prepared.integrationRef,
        prepared.resultingCommit,
        expectedOld,
      ]);
    } catch {
      const observed = refTip(prepared.repositoryRoot, prepared.integrationRef);
      if (observed === prepared.resultingCommit) {
        return succeeded(input, prepared);
      }
      return {
        status: "failed",
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
      const prepared = prepare(input);
      if (prepared.conflictFiles.length > 0) {
        return {
          status: "conflict",
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
});
