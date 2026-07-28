import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReviewerWorkspaceAdapter } from "./codeReviewRuntime.js";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const git = (repositoryReference: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repositoryReference, ...args], {
    encoding: "utf8",
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const sortedLines = (value: string): string[] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const makeReadOnly = (path: string): void => {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    throw new Error("Reviewer Workspace input contains a symbolic link.");
  }
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) makeReadOnly(join(path, child));
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, 0o444 | (entry.mode & 0o111));
};

const makeWritableForCleanup = (path: string): void => {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) {
      makeWritableForCleanup(join(path, child));
    }
    return;
  }
  chmodSync(path, 0o600);
};

const removeTemporaryWorkspace = (temporaryRoot: string): void => {
  if (!existsSync(temporaryRoot)) return;
  makeWritableForCleanup(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
};

const assertContainedPath = (parent: string, child: string): void => {
  const relation = relative(parent, child);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== "..")
  )
    return;
  throw new Error("Reviewer Workspace path escapes its controlled root.");
};

const assertDirectoryChainHasNoSymlink = (
  root: string,
  target: string,
): void => {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  assertContainedPath(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  if (lstatSync(current).isSymbolicLink()) {
    throw new Error("Reviewer Workspace root cannot be a symbolic link.");
  }
  const relation = relative(resolvedRoot, resolvedTarget);
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("Reviewer Workspace ancestors cannot be symbolic links.");
    }
  }
};

const assertExactEntries = (
  path: string,
  expected: readonly string[],
): void => {
  const actual = readdirSync(path).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Reviewer Workspace has unexpected entries at ${path}.`);
  }
};

const assertRegularFile = (path: string): void => {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Reviewer Workspace input ${path} must be a regular file.`);
  }
};

const expectedReviewObjectIds = (input: {
  readonly repositoryReference: string;
  readonly baseCommit: string;
  readonly sourceCommit: string;
}): string[] => {
  const ids = new Set<string>();
  for (const commit of [input.baseCommit, input.sourceCommit]) {
    ids.add(commit);
    ids.add(
      git(input.repositoryReference, "show", "-s", "--format=%T", commit),
    );
    for (const line of sortedLines(
      git(
        input.repositoryReference,
        "ls-tree",
        "-r",
        "-t",
        "--full-tree",
        commit,
      ),
    )) {
      const objectId = line.split(/\s+/)[2];
      if (objectId) ids.add(objectId);
    }
  }
  return [...ids].sort();
};

const actualReviewObjectIds = (sourcePath: string): string[] =>
  sortedLines(
    git(
      sourcePath,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ),
  );

const assertExactWorkspaceLayout = (reviewerRoot: string): void => {
  assertExactEntries(reviewerRoot, [
    "credential-scope",
    "exposed",
    "mutable-cache",
    "session-storage",
  ]);
  const exposedRoot = join(reviewerRoot, "exposed");
  assertExactEntries(exposedRoot, ["inputs", "source"]);
  assertExactEntries(join(exposedRoot, "inputs"), [
    "canonical.diff",
    "manifest.json",
  ]);
  assertRegularFile(join(exposedRoot, "inputs", "manifest.json"));
  assertRegularFile(join(exposedRoot, "inputs", "canonical.diff"));
  for (const privateDirectory of [
    "session-storage",
    "credential-scope",
    "mutable-cache",
  ]) {
    const path = join(reviewerRoot, privateDirectory);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Reviewer Workspace private scopes must be directories.");
    }
    assertExactEntries(path, []);
  }
};

const resolveGitCommonDirectory = (repositoryReference: string): string => {
  const commonDirectory = git(
    repositoryReference,
    "rev-parse",
    "--git-common-dir",
  );
  return realpathSync(
    isAbsolute(commonDirectory)
      ? commonDirectory
      : join(repositoryReference, commonDirectory),
  );
};

const assertRepositorySnapshot = (input: {
  readonly repositoryReference: string;
  readonly sourcePath: string;
  readonly baseCommit: string;
  readonly sourceCommit: string;
  readonly expectedObjectIds: readonly string[];
}): { readonly gitCommonDirectory: string; readonly objectSetHash: string } => {
  const head = git(input.sourcePath, "rev-parse", "HEAD");
  if (head !== input.sourceCommit) {
    throw new Error(
      "Reviewer Workspace is not detached at the exact source commit.",
    );
  }
  if (git(input.sourcePath, "remote") !== "") {
    throw new Error("Reviewer Workspace must not retain a writable remote.");
  }
  if (git(input.sourcePath, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Reviewer Workspace source tree must remain clean.");
  }
  const refs = sortedLines(
    git(input.sourcePath, "for-each-ref", "--format=%(refname)"),
  );
  if (
    JSON.stringify(refs) !==
    JSON.stringify(["refs/review/base", "refs/review/source"])
  ) {
    throw new Error("Reviewer Workspace contains unexpected Git refs.");
  }
  const actualObjectIds = actualReviewObjectIds(input.sourcePath);
  if (
    JSON.stringify(actualObjectIds) !==
    JSON.stringify([...input.expectedObjectIds].sort())
  ) {
    throw new Error(
      "Reviewer Workspace contains Git objects outside the allowlist.",
    );
  }
  const gitCommonDirectory = resolveGitCommonDirectory(input.sourcePath);
  const hostGitCommonDirectory = resolveGitCommonDirectory(
    input.repositoryReference,
  );
  if (gitCommonDirectory === hostGitCommonDirectory) {
    throw new Error("Reviewer Workspace must use an independent Git database.");
  }
  if (
    git(input.sourcePath, "ls-files", "-s")
      .split("\n")
      .some((line) => line.startsWith("160000 "))
  ) {
    throw new Error("Reviewer Workspace inputs cannot include Git submodules.");
  }
  return {
    gitCommonDirectory,
    objectSetHash: sha256(actualObjectIds.join("\n")),
  };
};

export const readCanonicalGitDiff = (input: {
  readonly repositoryReference: string;
  readonly baseCommit: string;
  readonly sourceCommit: string;
}): Buffer =>
  execFileSync(
    "git",
    [
      "-C",
      input.repositoryReference,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      input.baseCommit,
      input.sourceCommit,
      "--",
    ],
    {
      encoding: "buffer",
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

export const openLocalReviewerWorkspaceAdapter = (
  companyDir: string,
): ReviewerWorkspaceAdapter => ({
  provision: (input) => {
    if (process.platform === "win32") {
      return {
        status: "blocked",
        code: "PROVIDER_ISOLATION_REQUIRED",
        message:
          "The built-in local Reviewer Workspace cannot prove read-only filesystem isolation on Windows.",
        evidence: ["platform:win32", "read-only-filesystem:unproven"],
      };
    }
    const operationHash = sha256(input.operationKey);
    const reviewerRoot = join(
      companyDir,
      ".sandcastle",
      "reviewer-workspaces",
      operationHash,
    );
    const exposedRoot = join(reviewerRoot, "exposed");
    const sourcePath = join(exposedRoot, "source");
    const manifestPath = join(exposedRoot, "inputs", "manifest.json");
    const diffPath = join(exposedRoot, "inputs", "canonical.diff");
    try {
      assertDirectoryChainHasNoSymlink(companyDir, dirname(reviewerRoot));
      const repositoryReference = realpathSync(
        input.manifest.repositoryReference,
      );
      execFileSync(
        "git",
        [
          "-C",
          repositoryReference,
          "merge-base",
          "--is-ancestor",
          input.manifest.baseCommit,
          input.manifest.sourceCommit,
        ],
        { env: gitEnvironment, stdio: "ignore" },
      );
      const expectedObjectIds = expectedReviewObjectIds({
        repositoryReference,
        baseCommit: input.manifest.baseCommit,
        sourceCommit: input.manifest.sourceCommit,
      });
      const diff = readCanonicalGitDiff({
        repositoryReference,
        baseCommit: input.manifest.baseCommit,
        sourceCommit: input.manifest.sourceCommit,
      });
      if (!existsSync(reviewerRoot)) {
        const parent = dirname(reviewerRoot);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const temporaryRoot = mkdtempSync(join(parent, `.${operationHash}-`));
        try {
          const temporaryExposed = join(temporaryRoot, "exposed");
          const temporarySource = join(temporaryExposed, "source");
          const temporaryInputs = join(temporaryExposed, "inputs");
          mkdirSync(temporaryInputs, { recursive: true, mode: 0o700 });
          execFileSync("git", ["init", "-q", temporarySource], {
            env: gitEnvironment,
            stdio: ["ignore", "ignore", "pipe"],
          });
          git(
            temporarySource,
            "fetch",
            "--no-tags",
            "--depth=1",
            repositoryReference,
            input.manifest.sourceCommit,
          );
          git(
            temporarySource,
            "update-ref",
            "refs/review/source",
            "FETCH_HEAD",
          );
          git(
            temporarySource,
            "fetch",
            "--no-tags",
            "--depth=1",
            repositoryReference,
            input.manifest.baseCommit,
          );
          git(temporarySource, "update-ref", "refs/review/base", "FETCH_HEAD");
          git(
            temporarySource,
            "checkout",
            "--detach",
            input.manifest.sourceCommit,
          );
          const disabledHooks = join(temporarySource, ".git", "disabled-hooks");
          mkdirSync(disabledHooks, { recursive: true, mode: 0o500 });
          git(temporarySource, "config", "core.hooksPath", disabledHooks);
          git(temporarySource, "config", "submodule.recurse", "false");
          git(temporarySource, "config", "credential.helper", "");
          writeFileSync(
            join(temporaryInputs, "manifest.json"),
            JSON.stringify(canonicalize(input.manifest)),
            { mode: 0o400 },
          );
          writeFileSync(join(temporaryInputs, "canonical.diff"), diff, {
            mode: 0o400,
          });
          for (const privateDirectory of [
            "session-storage",
            "credential-scope",
            "mutable-cache",
          ]) {
            mkdirSync(join(temporaryRoot, privateDirectory), { mode: 0o700 });
          }
          assertRepositorySnapshot({
            repositoryReference,
            sourcePath: temporarySource,
            baseCommit: input.manifest.baseCommit,
            sourceCommit: input.manifest.sourceCommit,
            expectedObjectIds,
          });
          assertExactWorkspaceLayout(temporaryRoot);
          makeReadOnly(temporaryExposed);
          renameSync(temporaryRoot, reviewerRoot);
        } catch (error) {
          removeTemporaryWorkspace(temporaryRoot);
          throw error;
        }
      }
      assertDirectoryChainHasNoSymlink(companyDir, reviewerRoot);
      assertExactWorkspaceLayout(reviewerRoot);
      const snapshot = assertRepositorySnapshot({
        repositoryReference,
        sourcePath,
        baseCommit: input.manifest.baseCommit,
        sourceCommit: input.manifest.sourceCommit,
        expectedObjectIds,
      });
      const manifestBytes = readFileSync(manifestPath);
      const diffBytes = readFileSync(diffPath);
      if (
        sha256(manifestBytes) !==
          sha256(JSON.stringify(canonicalize(input.manifest))) ||
        !diffBytes.equals(diff)
      ) {
        throw new Error("Reviewer Workspace allowlisted inputs changed.");
      }
      return {
        status: "ready",
        providerId: "local-isolated-reviewer",
        workspaceRef: exposedRoot,
        capabilities: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "local-read-only-detached-git",
          mechanismVersion: "1",
        },
        evidence: [
          `operation-key:${input.operationKey}`,
          `source-commit:${input.manifest.sourceCommit}`,
          `base-ancestor:${input.manifest.baseCommit}`,
          `diff-sha256:${sha256(diff)}`,
          `manifest-sha256:${sha256(manifestBytes)}`,
          `git-common-directory-sha256:${sha256(snapshot.gitCommonDirectory)}`,
          `git-object-set-sha256:${snapshot.objectSetHash}`,
          "remote:none",
          "filesystem:read-only",
          "inputs:manifest+canonical-diff",
          `reviewer-session:${input.reviewer.sessionId}`,
        ],
      };
    } catch (error) {
      return {
        status: "blocked",
        code: "PROVIDER_ISOLATION_REQUIRED",
        message: `Local Reviewer Workspace isolation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        evidence: [
          `operation-key:${input.operationKey}`,
          `source-commit:${input.manifest.sourceCommit}`,
          "isolation:failed",
        ],
      };
    }
  },
});
