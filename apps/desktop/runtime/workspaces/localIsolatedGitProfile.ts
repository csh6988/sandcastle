import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const LOCAL_ISOLATED_GIT_CAPABILITIES = {
  profileId: "local-isolated-git",
  mechanism: "private-git-bundle-import",
  mechanismVersion: "1",
  gitRefWriteIsolation: true,
  runtimeImportOnly: true,
} as const;

export interface LocalIsolatedGitProvisionInput {
  readonly allocationId: string;
  readonly repositoryRoot: string;
  readonly allocationRoot: string;
  readonly sourceBranch: string;
  readonly baseCommit: string;
  readonly expectedSourceTip: string;
}

export interface LocalIsolatedGitProvisionReceipt {
  readonly allocationId: string;
  readonly capabilities: typeof LOCAL_ISOLATED_GIT_CAPABILITIES;
  readonly repositoryRoot: string;
  readonly executionTreePath: string;
  readonly sourceBranch: string;
  readonly expectedSourceTip: string;
  readonly privateGitIdentity: {
    readonly gitDirectory: string;
    readonly gitCommonDirectory: string;
    readonly baseCommit: string;
  };
}

export interface LocalIsolatedGitImportReceipt {
  readonly allocationId: string;
  readonly status: "imported" | "duplicate";
  readonly beforeSourceTip: string;
  readonly afterSourceTip: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly objectSetHash: string;
  readonly changedPaths: readonly string[];
}

export class LocalIsolatedGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalIsolatedGitError";
  }
}

export interface LocalIsolatedGitProfile {
  readonly provision: (
    input: LocalIsolatedGitProvisionInput,
  ) => LocalIsolatedGitProvisionReceipt;
  readonly importResult: (input: {
    readonly allocation: LocalIsolatedGitProvisionReceipt;
    readonly resultCommit: string;
    readonly expectedSourceTip: string;
  }) => LocalIsolatedGitImportReceipt;
  readonly cleanup: (allocation: LocalIsolatedGitProvisionReceipt) => void;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const absoluteGitPath = (cwd: string, value: string): string =>
  realpathSync(isAbsolute(value) ? value : resolve(cwd, value));

const assertToken = (value: string, description: string): void => {
  if (!value.trim() || value.includes("\0")) {
    throw new Error(`${description} must be a non-empty Git token.`);
  }
};

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const gitSucceeds = (cwd: string, ...args: string[]): boolean =>
  spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;

const assertSourceBranch = (repositoryRoot: string, sourceBranch: string) => {
  if (
    !gitSucceeds(
      repositoryRoot,
      "check-ref-format",
      `refs/heads/${sourceBranch}`,
    )
  ) {
    throw new LocalIsolatedGitError(
      "WORKSPACE_SOURCE_REF_INVALID",
      `Source branch ${sourceBranch} is not a valid allocated branch.`,
    );
  }
};

const changedPaths = (
  executionTreePath: string,
  baseCommit: string,
  resultCommit: string,
): readonly string[] =>
  git(executionTreePath, "diff", "--name-only", "-z", baseCommit, resultCommit)
    .split("\0")
    .filter(Boolean);

const validateImportTree = (
  executionTreePath: string,
  baseCommit: string,
  resultCommit: string,
): readonly string[] => {
  if (
    !gitSucceeds(
      executionTreePath,
      "merge-base",
      "--is-ancestor",
      baseCommit,
      resultCommit,
    )
  ) {
    throw new LocalIsolatedGitError(
      "WORKSPACE_IMPORT_PARENTAGE_INVALID",
      "Execution result is not descended from the allocated base commit.",
    );
  }
  const revisions = git(
    executionTreePath,
    "rev-list",
    "--parents",
    `${baseCommit}..${resultCommit}`,
  );
  if (
    revisions &&
    revisions.split("\n").some((line) => line.trim().split(/\s+/).length !== 2)
  ) {
    throw new LocalIsolatedGitError(
      "WORKSPACE_IMPORT_PARENTAGE_INVALID",
      "Execution result contains a merge commit outside the allocated linear history.",
    );
  }
  git(executionTreePath, "fsck", "--strict", "--no-dangling", resultCommit);
  const paths = changedPaths(executionTreePath, baseCommit, resultCommit);
  for (const path of paths) {
    if (
      path === ".git" ||
      path.startsWith(".git/") ||
      path === ".gitmodules" ||
      path === ".sandcastle" ||
      path.startsWith(".sandcastle/") ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\\")
    ) {
      throw new LocalIsolatedGitError(
        "WORKSPACE_IMPORT_PATH_VIOLATION",
        `Execution result changes forbidden path ${path}.`,
      );
    }
    const entry = git(executionTreePath, "ls-tree", resultCommit, "--", path);
    if (entry.startsWith("120000 ") || entry.startsWith("160000 ")) {
      throw new LocalIsolatedGitError(
        "WORKSPACE_IMPORT_PATH_VIOLATION",
        `Execution result path ${path} is a symlink or submodule.`,
      );
    }
  }
  return paths;
};

const objectSetHash = (input: {
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly paths: readonly string[];
}): string => sha256(JSON.stringify(input));

export const openLocalIsolatedGitProfile = (): LocalIsolatedGitProfile => ({
  provision: (input) => {
    assertToken(input.allocationId, "Allocation ID");
    assertToken(input.sourceBranch, "Source branch");
    assertToken(input.baseCommit, "Base commit");
    assertToken(input.expectedSourceTip, "Expected source tip");

    const repositoryRoot = realpathSync(input.repositoryRoot);
    const allocationRoot = realpathSync(input.allocationRoot);
    assertSourceBranch(repositoryRoot, input.sourceBranch);
    const sourceRef = `refs/heads/${input.sourceBranch}`;
    if (!gitSucceeds(repositoryRoot, "show-ref", "--verify", sourceRef)) {
      if (input.expectedSourceTip !== input.baseCommit) {
        throw new LocalIsolatedGitError(
          "WORKSPACE_PROVISION_CONFLICT",
          "A new source branch must start at the exact allocated base commit.",
        );
      }
      git(repositoryRoot, "update-ref", sourceRef, input.baseCommit, "");
    }
    const executionTreePath = join(allocationRoot, "execution-tree");
    const sourceTip = git(repositoryRoot, "rev-parse", input.sourceBranch);
    const baseCommit = git(
      repositoryRoot,
      "rev-parse",
      `${input.baseCommit}^{commit}`,
    );
    if (
      sourceTip !== input.expectedSourceTip ||
      baseCommit !== input.baseCommit
    ) {
      throw new Error(
        "Local isolated Git provision inputs do not match the Repository state.",
      );
    }

    if (!existsSync(executionTreePath)) {
      execFileSync(
        "git",
        [
          "clone",
          "--no-local",
          "--no-checkout",
          repositoryRoot,
          executionTreePath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      git(executionTreePath, "remote", "remove", "origin");
      git(executionTreePath, "checkout", "--detach", baseCommit);
      git(executionTreePath, "switch", "-c", input.sourceBranch);
      git(
        executionTreePath,
        "config",
        "user.name",
        "Sandcastle Runtime Importer",
      );
      git(
        executionTreePath,
        "config",
        "user.email",
        "runtime-importer@sandcastle.invalid",
      );
    }
    const gitDirectory = absoluteGitPath(
      executionTreePath,
      git(executionTreePath, "rev-parse", "--absolute-git-dir"),
    );
    const gitCommonDirectory = absoluteGitPath(
      executionTreePath,
      git(executionTreePath, "rev-parse", "--git-common-dir"),
    );
    const hostCommonDirectory = absoluteGitPath(
      repositoryRoot,
      git(repositoryRoot, "rev-parse", "--git-common-dir"),
    );
    if (gitCommonDirectory === hostCommonDirectory) {
      throw new Error(
        "Local isolated Git profile must use an independent Git common directory.",
      );
    }
    if (
      git(executionTreePath, "remote") !== "" ||
      git(executionTreePath, "rev-parse", input.sourceBranch) !== baseCommit
    ) {
      throw new LocalIsolatedGitError(
        "WORKSPACE_PROVISION_CONFLICT",
        "Existing execution tree does not match the planned private Git identity.",
      );
    }
    const disabledHooks = join(gitDirectory, "sandcastle-disabled-hooks");
    mkdirSync(disabledHooks, { recursive: true });
    git(executionTreePath, "config", "core.hooksPath", disabledHooks);
    git(executionTreePath, "config", "submodule.recurse", "false");

    return {
      allocationId: input.allocationId,
      capabilities: LOCAL_ISOLATED_GIT_CAPABILITIES,
      repositoryRoot,
      executionTreePath,
      sourceBranch: input.sourceBranch,
      expectedSourceTip: input.expectedSourceTip,
      privateGitIdentity: {
        gitDirectory,
        gitCommonDirectory,
        baseCommit,
      },
    };
  },
  importResult: (input) => {
    assertToken(input.resultCommit, "Result commit");
    assertToken(input.expectedSourceTip, "Expected source tip");
    const allocation = input.allocation;
    const repositoryRoot = realpathSync(allocation.repositoryRoot);
    const executionTreePath = realpathSync(allocation.executionTreePath);
    assertSourceBranch(repositoryRoot, allocation.sourceBranch);
    const privateCommonDirectory = absoluteGitPath(
      executionTreePath,
      git(executionTreePath, "rev-parse", "--git-common-dir"),
    );
    const hostCommonDirectory = absoluteGitPath(
      repositoryRoot,
      git(repositoryRoot, "rev-parse", "--git-common-dir"),
    );
    if (
      privateCommonDirectory !==
        allocation.privateGitIdentity.gitCommonDirectory ||
      privateCommonDirectory === hostCommonDirectory ||
      git(executionTreePath, "remote") !== ""
    ) {
      throw new LocalIsolatedGitError(
        "PROVIDER_ISOLATION_REQUIRED",
        "Execution tree no longer proves an independent Git database without host remotes.",
      );
    }
    const resultCommit = git(
      executionTreePath,
      "rev-parse",
      `${input.resultCommit}^{commit}`,
    );
    const privateTip = git(
      executionTreePath,
      "rev-parse",
      allocation.sourceBranch,
    );
    if (resultCommit !== input.resultCommit || privateTip !== resultCommit) {
      throw new LocalIsolatedGitError(
        "WORKSPACE_IMPORT_OBJECT_MISMATCH",
        "Execution result must be the exact tip of the private allocated branch.",
      );
    }
    const sourceRef = `refs/heads/${allocation.sourceBranch}`;
    const beforeSourceTip = git(repositoryRoot, "rev-parse", sourceRef);
    if (beforeSourceTip === resultCommit) {
      const paths = validateImportTree(
        executionTreePath,
        allocation.privateGitIdentity.baseCommit,
        resultCommit,
      );
      const resultTree = git(
        executionTreePath,
        "rev-parse",
        `${resultCommit}^{tree}`,
      );
      return {
        allocationId: allocation.allocationId,
        status: "duplicate",
        beforeSourceTip: input.expectedSourceTip,
        afterSourceTip: resultCommit,
        baseCommit: allocation.privateGitIdentity.baseCommit,
        resultCommit,
        resultTree,
        objectSetHash: objectSetHash({
          baseCommit: allocation.privateGitIdentity.baseCommit,
          resultCommit,
          resultTree,
          paths,
        }),
        changedPaths: paths,
      };
    }
    if (beforeSourceTip !== input.expectedSourceTip) {
      throw new LocalIsolatedGitError(
        "INTEGRATION_CONFLICT",
        `Allocated source branch moved from ${input.expectedSourceTip} to ${beforeSourceTip}.`,
      );
    }
    const paths = validateImportTree(
      executionTreePath,
      allocation.privateGitIdentity.baseCommit,
      resultCommit,
    );
    const resultTree = git(
      executionTreePath,
      "rev-parse",
      `${resultCommit}^{tree}`,
    );
    const exportRef = `refs/sandcastle/export/${sha256(allocation.allocationId).slice(0, 24)}`;
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "sandcastle-runtime-import-"),
    );
    const bundlePath = join(temporaryDirectory, "objects.bundle");
    try {
      git(executionTreePath, "update-ref", exportRef, resultCommit);
      git(executionTreePath, "bundle", "create", bundlePath, exportRef);
      git(repositoryRoot, "fetch", "--no-tags", bundlePath, exportRef);
      if (
        git(repositoryRoot, "rev-parse", `${resultCommit}^{commit}`) !==
        resultCommit
      ) {
        throw new LocalIsolatedGitError(
          "WORKSPACE_IMPORT_OBJECT_MISMATCH",
          "Imported Git object identity does not match the execution result.",
        );
      }
      const update = spawnSync(
        "git",
        ["update-ref", sourceRef, resultCommit, input.expectedSourceTip],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      if (update.status !== 0) {
        throw new LocalIsolatedGitError(
          "INTEGRATION_CONFLICT",
          `Allocated source branch changed during import: ${update.stderr.trim()}`,
        );
      }
      return {
        allocationId: allocation.allocationId,
        status: "imported",
        beforeSourceTip,
        afterSourceTip: resultCommit,
        baseCommit: allocation.privateGitIdentity.baseCommit,
        resultCommit,
        resultTree,
        objectSetHash: objectSetHash({
          baseCommit: allocation.privateGitIdentity.baseCommit,
          resultCommit,
          resultTree,
          paths,
        }),
        changedPaths: paths,
      };
    } finally {
      git(executionTreePath, "update-ref", "-d", exportRef);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
  cleanup: (allocation) => {
    const expectedExecutionTree = resolve(
      dirname(allocation.executionTreePath),
      "execution-tree",
    );
    if (
      resolve(allocation.executionTreePath) !== expectedExecutionTree ||
      expectedExecutionTree === resolve(allocation.repositoryRoot)
    ) {
      throw new LocalIsolatedGitError(
        "WORKSPACE_CLEANUP_PATH_INVALID",
        "Execution tree cleanup target is outside the allocation root.",
      );
    }
    if (existsSync(expectedExecutionTree)) {
      if (realpathSync(expectedExecutionTree) !== expectedExecutionTree) {
        throw new LocalIsolatedGitError(
          "WORKSPACE_CLEANUP_PATH_INVALID",
          "Execution tree cleanup target resolves outside the allocation root.",
        );
      }
      rmSync(expectedExecutionTree, { recursive: true, force: true });
    }
  },
});
