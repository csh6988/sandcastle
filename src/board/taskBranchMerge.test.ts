import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardTaskRecord } from "./BoardStore.js";
import {
  listBoardTaskBranchMergeOptions,
  mergeBoardTaskBranch,
} from "./taskBranchMerge.js";

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commitFile = (cwd: string, file: string, content: string): string => {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", `commit ${file}`]);
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
};

const taskFor = (repoDir: string, branch: string): BoardTaskRecord => ({
  id: "task-1",
  title: "Merge task",
  prompt: "Do it",
  status: "succeeded",
  createdAt: "2026-07-01T00:00:00.000Z",
  runIds: ["run-1"],
  plan: {
    workspace: {
      repositories: [{ name: "web", cwd: repoDir }],
    },
    repositories: [{ name: "web", task: "Ship it" }],
  },
  workflow: {
    status: "succeeded",
    currentPhase: "verifying",
    verificationStatus: "passed",
    updatedAt: "2026-07-01T00:01:00.000Z",
  },
});

describe("task branch merge", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-branch-merge-"));
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    commitFile(dir, "base.txt", "base\n");
    git(dir, ["checkout", "-b", "feature"]);
    commitFile(dir, "feature.txt", "feature\n");
    git(dir, ["checkout", "main"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists source and target branches for a board task repository", () => {
    const options = listBoardTaskBranchMergeOptions({
      task: taskFor(dir, "feature"),
      runs: [
        {
          id: "run-1",
          name: "web",
          agent: "claude-code",
          sandbox: "no-sandbox",
          branch: "feature",
          maxIterations: 1,
          status: "succeeded",
          createdAt: "2026-07-01T00:00:00.000Z",
          commits: 1,
          taskId: "task-1",
          repo: "web",
        },
      ],
      defaultRepoDir: dir,
    });

    expect(options.repositories).toEqual([
      expect.objectContaining({
        name: "web",
        cwd: dir,
        currentBranch: "main",
        sourceBranch: "feature",
        dirty: false,
        targetBranches: expect.arrayContaining(["main"]),
      }),
    ]);
    expect(options.repositories[0]?.targetBranches).not.toContain("feature");
  });

  it("merges the task source branch into a selected clean target branch", () => {
    const result = mergeBoardTaskBranch({
      task: taskFor(dir, "feature"),
      runs: [
        {
          id: "run-1",
          name: "web",
          agent: "claude-code",
          sandbox: "no-sandbox",
          branch: "feature",
          maxIterations: 1,
          status: "succeeded",
          createdAt: "2026-07-01T00:00:00.000Z",
          commits: 1,
          taskId: "task-1",
          repo: "web",
        },
      ],
      repository: "web",
      targetBranch: "main",
      defaultRepoDir: dir,
    });

    expect(result).toMatchObject({
      status: "merged",
      repository: "web",
      sourceBranch: "feature",
      targetBranch: "main",
    });
    expect(git(dir, ["branch", "--show-current"])).toBe("main");
    expect(git(dir, ["merge-base", "--is-ancestor", "feature", "main"])).toBe(
      "",
    );
  });

  it("marks a target branch as already merged once it contains the task source branch", () => {
    mergeBoardTaskBranch({
      task: taskFor(dir, "feature"),
      runs: [
        {
          id: "run-1",
          name: "web",
          agent: "claude-code",
          sandbox: "no-sandbox",
          branch: "feature",
          maxIterations: 1,
          status: "succeeded",
          createdAt: "2026-07-01T00:00:00.000Z",
          commits: 1,
          taskId: "task-1",
          repo: "web",
        },
      ],
      repository: "web",
      targetBranch: "main",
      defaultRepoDir: dir,
    });

    const options = listBoardTaskBranchMergeOptions({
      task: taskFor(dir, "feature"),
      runs: [
        {
          id: "run-1",
          name: "web",
          agent: "claude-code",
          sandbox: "no-sandbox",
          branch: "feature",
          maxIterations: 1,
          status: "succeeded",
          createdAt: "2026-07-01T00:00:00.000Z",
          commits: 1,
          taskId: "task-1",
          repo: "web",
        },
      ],
      defaultRepoDir: dir,
    });

    expect(options.repositories[0]).toMatchObject({
      name: "web",
      sourceBranch: "feature",
      mergedTargetBranches: ["main"],
      canMerge: false,
      reason: "The source branch is already merged into every target branch.",
    });
  });

  it("refuses to merge when the target repository has uncommitted changes", () => {
    writeFileSync(join(dir, "dirty.txt"), "dirty\n");

    expect(() =>
      mergeBoardTaskBranch({
        task: taskFor(dir, "feature"),
        runs: [
          {
            id: "run-1",
            name: "web",
            agent: "claude-code",
            sandbox: "no-sandbox",
            branch: "feature",
            maxIterations: 1,
            status: "succeeded",
            createdAt: "2026-07-01T00:00:00.000Z",
            commits: 1,
            taskId: "task-1",
            repo: "web",
          },
        ],
        repository: "web",
        targetBranch: "main",
        defaultRepoDir: dir,
      }),
    ).toThrow("working tree is not clean");
  });

  it("refuses to merge a task source branch into itself", () => {
    expect(() =>
      mergeBoardTaskBranch({
        task: taskFor(dir, "feature"),
        runs: [
          {
            id: "run-1",
            name: "web",
            agent: "claude-code",
            sandbox: "no-sandbox",
            branch: "feature",
            maxIterations: 1,
            status: "succeeded",
            createdAt: "2026-07-01T00:00:00.000Z",
            commits: 1,
            taskId: "task-1",
            repo: "web",
          },
        ],
        repository: "web",
        targetBranch: "feature",
        defaultRepoDir: dir,
      }),
    ).toThrow("Source and target branches must be different");
  });

  it("returns a conflict result for a conflicted merge started by the board action", () => {
    git(dir, ["checkout", "feature"]);
    commitFile(dir, "base.txt", "feature base\n");
    git(dir, ["checkout", "main"]);
    commitFile(dir, "base.txt", "main base\n");

    const result = mergeBoardTaskBranch({
      task: taskFor(dir, "feature"),
      runs: [
        {
          id: "run-1",
          name: "web",
          agent: "claude-code",
          sandbox: "no-sandbox",
          branch: "feature",
          maxIterations: 1,
          status: "succeeded",
          createdAt: "2026-07-01T00:00:00.000Z",
          commits: 1,
          taskId: "task-1",
          repo: "web",
        },
      ],
      repository: "web",
      targetBranch: "main",
      defaultRepoDir: dir,
    });

    expect(result).toMatchObject({
      status: "conflict",
      repository: "web",
      sourceBranch: "feature",
      targetBranch: "main",
      message: expect.stringContaining('Failed to merge "feature" into "main"'),
    });
    expect(git(dir, ["branch", "--show-current"])).toBe("main");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(() => git(dir, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
  });
});
