import { spawn } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  lstatSync,
  readdirSync,
  chmodSync,
  rmSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export class IntegrationWorkspaceGitError extends Error {
  constructor(
    readonly code:
      | "INTEGRATION_GIT_CANCELLED"
      | "INTEGRATION_GIT_TIMEOUT"
      | "INTEGRATION_GIT_COMMAND_FAILED"
      | "INTEGRATION_WORKSPACE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationWorkspaceGitError";
  }
}

export const integrationGitEnvironment = (): NodeJS.ProcessEnv => ({
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
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "protocol.file.allow",
  GIT_CONFIG_VALUE_2: "always",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_OPTIONAL_LOCKS: "0",
});

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

const removeWorkspace = (path: string): void => {
  if (!existsSync(path)) return;
  makeWritableForCleanup(path);
  rmSync(path, { recursive: true, force: true });
};

const runGit = (
  args: readonly string[],
  options: {
    readonly executable: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<string> => {
  if (options.signal?.aborted) {
    throw new IntegrationWorkspaceGitError(
      "INTEGRATION_GIT_CANCELLED",
      "Integration workspace Git preparation was cancelled before its outcome was proven.",
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let boundary: "cancelled" | "timeout" | null = null;
    const child = spawn(options.executable, [...args], {
      env: integrationGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const terminate = (reason: "cancelled" | "timeout") => {
      if (settled) return;
      boundary = reason;
      child.kill(reason === "timeout" ? "SIGKILL" : "SIGTERM");
    };
    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (boundary) {
        reject(
          new IntegrationWorkspaceGitError(
            boundary === "cancelled"
              ? "INTEGRATION_GIT_CANCELLED"
              : "INTEGRATION_GIT_TIMEOUT",
            boundary === "cancelled"
              ? "Integration workspace Git preparation was cancelled before its outcome was proven."
              : "Integration workspace Git preparation exceeded its bounded execution time.",
          ),
        );
        return;
      }
      if (status !== 0) {
        reject(
          new IntegrationWorkspaceGitError(
            "INTEGRATION_GIT_COMMAND_FAILED",
            Buffer.concat(stderr).toString("utf8").trim() ||
              `Git command ${args[0] ?? "unknown"} failed.`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
};

const lines = (value: string): string[] =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();

const assertContained = (root: string, path: string): void => {
  const relation = relative(root, path);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== "..")
  ) {
    return;
  }
  throw new IntegrationWorkspaceGitError(
    "INTEGRATION_WORKSPACE_INVALID",
    "Integration workspace Git common directory escaped its controlled root.",
  );
};

const expectedObjectIds = async (
  repositoryReference: string,
  commit: string,
  boundary: {
    readonly executable: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<string[]> => {
  const ids = new Set<string>([commit]);
  ids.add(
    await runGit(
      ["-C", repositoryReference, "show", "-s", "--format=%T", commit],
      boundary,
    ),
  );
  for (const entry of lines(
    await runGit(
      ["-C", repositoryReference, "ls-tree", "-r", "-t", "--full-tree", commit],
      boundary,
    ),
  )) {
    const objectId = entry.split(/\s+/)[2];
    if (objectId) ids.add(objectId);
  }
  return [...ids].sort();
};

const assertSafeGitDirectory = (workspace: string): void => {
  const gitDirectory = join(workspace, ".git");
  for (const path of [
    gitDirectory,
    join(gitDirectory, "objects"),
    join(gitDirectory, "refs"),
    join(gitDirectory, "logs"),
    join(gitDirectory, "packed-refs"),
  ]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new IntegrationWorkspaceGitError(
        "INTEGRATION_WORKSPACE_INVALID",
        "Integration workspace Git control paths cannot be symbolic links.",
      );
    }
  }
  if (
    existsSync(join(gitDirectory, "objects", "info", "alternates")) ||
    existsSync(join(gitDirectory, "commondir"))
  ) {
    throw new IntegrationWorkspaceGitError(
      "INTEGRATION_WORKSPACE_INVALID",
      "Integration workspace Git storage cannot use alternates or a shared common directory.",
    );
  }
};

export const prepareExactIntegrationWorkspace = async (input: {
  readonly repositoryReference: string;
  readonly commit: string;
  readonly workspace: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly gitExecutable?: string;
}): Promise<string> => {
  const boundary = {
    executable: input.gitExecutable ?? "git",
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const expected = await expectedObjectIds(
    input.repositoryReference,
    input.commit,
    boundary,
  );
  if (!existsSync(input.workspace)) {
    const temporary = mkdtempSync(
      join(dirname(input.workspace), ".integration-workspace-"),
    );
    try {
      await runGit(["init", "-q", temporary], boundary);
      await runGit(
        [
          "-C",
          temporary,
          "fetch",
          "--no-tags",
          "--depth=1",
          input.repositoryReference,
          input.commit,
        ],
        boundary,
      );
      await runGit(
        ["-C", temporary, "checkout", "--detach", "FETCH_HEAD"],
        boundary,
      );
      renameSync(temporary, input.workspace);
    } catch (error) {
      removeWorkspace(temporary);
      throw error;
    }
  }
  assertSafeGitDirectory(input.workspace);
  const commonDirectory = await runGit(
    ["-C", input.workspace, "rev-parse", "--git-common-dir"],
    boundary,
  );
  const resolvedCommon = realpathSync(
    isAbsolute(commonDirectory)
      ? commonDirectory
      : join(input.workspace, commonDirectory),
  );
  assertContained(realpathSync(input.workspace), resolvedCommon);
  const head = await runGit(
    ["-C", input.workspace, "rev-parse", "HEAD"],
    boundary,
  );
  const remote = await runGit(["-C", input.workspace, "remote"], boundary);
  const refs = lines(
    await runGit(
      ["-C", input.workspace, "for-each-ref", "--format=%(refname)"],
      boundary,
    ),
  );
  const dirty = await runGit(
    ["-C", input.workspace, "status", "--porcelain", "--untracked-files=all"],
    boundary,
  );
  const actual = lines(
    await runGit(
      [
        "-C",
        input.workspace,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname)",
      ],
      boundary,
    ),
  );
  if (
    head !== input.commit ||
    remote !== "" ||
    refs.length !== 0 ||
    dirty !== "" ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new IntegrationWorkspaceGitError(
      "INTEGRATION_WORKSPACE_INVALID",
      "Integration workspace is not an exact clean commit-only Git bundle.",
    );
  }
  return input.workspace;
};
