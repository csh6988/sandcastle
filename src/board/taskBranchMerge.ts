import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { BoardRunRecord, BoardTaskRecord } from "./BoardStore.js";

export interface BoardTaskBranchMergeRepositoryOption {
  readonly name: string;
  readonly cwd: string;
  readonly sourceBranch?: string;
  readonly currentBranch?: string;
  readonly targetBranches: readonly string[];
  readonly mergedTargetBranches: readonly string[];
  readonly dirty: boolean;
  readonly canMerge: boolean;
  readonly reason?: string;
}

export interface BoardTaskBranchMergeOptions {
  readonly repositories: readonly BoardTaskBranchMergeRepositoryOption[];
}

export interface BoardTaskBranchMergedResult {
  readonly status: "merged";
  readonly repository: string;
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly before: string;
  readonly after: string;
  readonly fastForward: boolean;
}

export interface BoardTaskBranchMergeConflictResult {
  readonly status: "conflict";
  readonly repository: string;
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly before: string;
  readonly message: string;
}

export type BoardTaskBranchMergeResult =
  | BoardTaskBranchMergedResult
  | BoardTaskBranchMergeConflictResult;

export interface BoardTaskBranchMergeContext {
  readonly repository: string;
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const errorOutput = (error: unknown): string => {
  if (
    error &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof (error as { stderr?: unknown }).stderr === "string"
  ) {
    return (error as { stderr: string }).stderr.trim();
  }
  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    return (error as { stdout: string }).stdout.trim();
  }
  return error instanceof Error ? error.message : String(error);
};

const gitOrUndefined = (
  cwd: string,
  args: readonly string[],
): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

const gitLines = (cwd: string, args: readonly string[]): string[] =>
  (gitOrUndefined(cwd, args) ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const cleanBranchName = (line: string): string =>
  line.replace(/^\*\s*/, "").trim();

const repositoryCwd = (
  task: BoardTaskRecord,
  repoName: string,
  defaultRepoDir: string,
): string => {
  const workspaceRepo = task.plan?.workspace?.repositories.find(
    (repo) => repo.name === repoName,
  );
  return resolve(workspaceRepo?.cwd ?? defaultRepoDir);
};

const latestRunForRepo = (
  repoName: string,
  runs: readonly BoardRunRecord[],
): BoardRunRecord | undefined =>
  runs
    .filter((run) => run.repo === repoName)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

const sourceBranchFor = (
  repoName: string,
  runs: readonly BoardRunRecord[],
): string | undefined => latestRunForRepo(repoName, runs)?.branch;

const isDirty = (cwd: string): boolean =>
  gitLines(cwd, ["status", "--porcelain"]).length > 0;

const localBranches = (cwd: string): string[] =>
  gitLines(cwd, ["branch", "--format=%(refname:short)"]).map(cleanBranchName);

const currentBranch = (cwd: string): string | undefined =>
  gitOrUndefined(cwd, ["branch", "--show-current"]);

const headSha = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]);

const branchExists = (cwd: string, branch: string): boolean =>
  gitOrUndefined(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]) !==
  undefined;

const branchContains = (
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean =>
  gitOrUndefined(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) ===
  "";

const mergeInProgress = (cwd: string): boolean =>
  gitOrUndefined(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]) !== undefined;

export const getBoardTaskBranchMergeContext = (args: {
  readonly task: BoardTaskRecord;
  readonly runs: readonly BoardRunRecord[];
  readonly repository: string;
  readonly targetBranch: string;
  readonly defaultRepoDir: string;
}): BoardTaskBranchMergeContext => {
  const repo = args.task.plan?.repositories.find(
    (item) => item.name === args.repository,
  );
  if (!repo) {
    throw new Error(
      `Repository "${args.repository}" is not part of this task.`,
    );
  }
  const cwd = repositoryCwd(args.task, repo.name, args.defaultRepoDir);
  const sourceBranch = sourceBranchFor(repo.name, args.runs);
  if (!sourceBranch || !branchExists(cwd, sourceBranch)) {
    throw new Error(
      `No local source branch was recorded for repository "${repo.name}".`,
    );
  }
  if (!branchExists(cwd, args.targetBranch)) {
    throw new Error(`Target branch "${args.targetBranch}" does not exist.`);
  }
  if (sourceBranch === args.targetBranch) {
    throw new Error("Source and target branches must be different.");
  }
  if (isDirty(cwd)) {
    throw new Error(
      `Repository "${repo.name}" working tree is not clean; commit or stash local changes before resolving merge conflicts.`,
    );
  }
  return {
    repository: repo.name,
    cwd,
    sourceBranch,
    targetBranch: args.targetBranch,
  };
};

export const listBoardTaskBranchMergeOptions = (args: {
  readonly task: BoardTaskRecord;
  readonly runs: readonly BoardRunRecord[];
  readonly defaultRepoDir: string;
}): BoardTaskBranchMergeOptions => {
  const repositories = (args.task.plan?.repositories ?? []).map((repo) => {
    const cwd = repositoryCwd(args.task, repo.name, args.defaultRepoDir);
    const sourceBranch = sourceBranchFor(repo.name, args.runs);
    const branches = localBranches(cwd);
    const targetBranches = branches.filter((branch) => branch !== sourceBranch);
    const mergedTargetBranches = sourceBranch
      ? targetBranches.filter((branch) =>
          branchContains(cwd, sourceBranch, branch),
        )
      : [];
    const activeBranch = currentBranch(cwd);
    const dirty = isDirty(cwd);
    const missingSource =
      sourceBranch === undefined || !branchExists(cwd, sourceBranch);
    const hasUnmergedTarget =
      targetBranches.length > mergedTargetBranches.length;
    const reason = missingSource
      ? "No local source branch was recorded for this repository."
      : targetBranches.length === 0
        ? "No local target branch is available for this source branch."
        : !hasUnmergedTarget
          ? "The source branch is already merged into every target branch."
          : dirty
            ? "The repository working tree is not clean."
            : undefined;
    return {
      name: repo.name,
      cwd,
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(activeBranch ? { currentBranch: activeBranch } : {}),
      targetBranches,
      mergedTargetBranches,
      dirty,
      canMerge:
        !missingSource &&
        targetBranches.length > 0 &&
        hasUnmergedTarget &&
        !dirty,
      ...(reason ? { reason } : {}),
    };
  });
  return { repositories };
};

export const mergeBoardTaskBranch = (args: {
  readonly task: BoardTaskRecord;
  readonly runs: readonly BoardRunRecord[];
  readonly repository: string;
  readonly targetBranch: string;
  readonly defaultRepoDir: string;
}): BoardTaskBranchMergeResult => {
  const context = getBoardTaskBranchMergeContext(args);
  const { cwd, repository: repoName, sourceBranch, targetBranch } = context;

  git(cwd, ["checkout", targetBranch]);
  const before = headSha(cwd);
  try {
    git(cwd, ["merge", "--no-edit", sourceBranch]);
  } catch (error) {
    const message = `Failed to merge "${sourceBranch}" into "${targetBranch}": ${errorOutput(error)}`;
    if (mergeInProgress(cwd)) {
      gitOrUndefined(cwd, ["merge", "--abort"]);
    }
    return {
      status: "conflict",
      repository: repoName,
      cwd,
      sourceBranch,
      targetBranch,
      before,
      message,
    };
  }
  const after = headSha(cwd);

  return {
    status: "merged",
    repository: repoName,
    cwd,
    sourceBranch,
    targetBranch,
    before,
    after,
    fastForward:
      before !== after && git(cwd, ["rev-parse", sourceBranch]) === after,
  };
};
