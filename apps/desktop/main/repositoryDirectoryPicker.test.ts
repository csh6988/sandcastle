import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRepositoryDirectoryPicker,
  resolveGitRepositoryRoot,
  type RepositoryDirectoryPickerDialog,
} from "./repositoryDirectoryPicker.js";

describe("repository directory picker", () => {
  it("returns the absolute Git root when the selected directory is the repository root", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "sandcastle-repository-picker-"),
    );
    try {
      execFileSync("git", ["init", repositoryRoot], { stdio: "ignore" });

      assert.equal(
        await resolveGitRepositoryRoot(repositoryRoot),
        await realpath(repositoryRoot),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("returns the absolute Git root for a real repository subdirectory", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "sandcastle-repository-picker-"),
    );
    try {
      execFileSync("git", ["init", repositoryRoot], { stdio: "ignore" });
      const nestedDirectory = path.join(repositoryRoot, "packages", "web");
      await mkdir(nestedDirectory, { recursive: true });

      assert.equal(
        await resolveGitRepositoryRoot(nestedDirectory),
        await realpath(repositoryRoot),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("initializes a selected local folder as Git after explicit confirmation", async () => {
    const localFolder = await mkdtemp(
      path.join(tmpdir(), "sandcastle-local-folder-picker-"),
    );
    let confirmationOptions: unknown;
    const dialog = {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [localFolder],
      }),
      showMessageBox: async (options: unknown) => {
        confirmationOptions = options;
        return { response: 0 };
      },
    } as RepositoryDirectoryPickerDialog & {
      showMessageBox(options: unknown): Promise<{ readonly response: number }>;
    };

    try {
      assert.deepEqual(await createRepositoryDirectoryPicker({ dialog }), {
        status: "selected",
        path: await realpath(localFolder),
      });
      assert.equal(
        execFileSync("git", ["-C", localFolder, "remote"], {
          encoding: "utf8",
        }).trim(),
        "",
      );
      assert.throws(() =>
        execFileSync(
          "git",
          ["-C", localFolder, "rev-parse", "--verify", "HEAD"],
          {
            stdio: "ignore",
          },
        ),
      );
      assert.deepEqual(confirmationOptions, {
        type: "question",
        title: "Initialize local Git repository / 初始化本地 Git 仓库",
        message: "This folder is not a Git repository.",
        detail:
          "Initialize Git here so Sandcastle can use commits and isolated worktrees? No remote or initial commit will be created.\n\n该文件夹不是 Git 仓库。是否在此初始化 Git，以便 Sandcastle 使用提交和隔离 Worktree？不会创建远程仓库或初始提交。",
        buttons: ["Initialize Git / 初始化 Git", "Cancel / 取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    } finally {
      await rm(localFolder, { recursive: true, force: true });
    }
  });

  it("leaves a selected local folder unchanged when Git initialization is canceled", async () => {
    const localFolder = await mkdtemp(
      path.join(tmpdir(), "sandcastle-local-folder-picker-"),
    );
    try {
      const result = await createRepositoryDirectoryPicker({
        dialog: {
          showOpenDialog: async () => ({
            canceled: false,
            filePaths: [localFolder],
          }),
          showMessageBox: async () => ({ response: 1 }),
        },
      });

      assert.deepEqual(result, { status: "canceled" });
      await assert.rejects(access(path.join(localFolder, ".git")));
    } finally {
      await rm(localFolder, { recursive: true, force: true });
    }
  });

  it("returns a clear error when Git cannot be initialized", async () => {
    const localFolder = await mkdtemp(
      path.join(tmpdir(), "sandcastle-local-folder-picker-"),
    );
    try {
      await writeFile(path.join(localFolder, ".git"), "not a directory");
      const result = await createRepositoryDirectoryPicker({
        dialog: {
          showOpenDialog: async () => ({
            canceled: false,
            filePaths: [localFolder],
          }),
          showMessageBox: async () => ({ response: 0 }),
        },
      });

      assert.deepEqual(result, {
        status: "error",
        code: "GIT_INIT_FAILED",
        message: "Git could not be initialized in the selected directory.",
      });
    } finally {
      await rm(localFolder, { recursive: true, force: true });
    }
  });

  it("returns canceled without resolving or changing anything", async () => {
    let resolved = false;
    let dialogOptions:
      | Parameters<RepositoryDirectoryPickerDialog["showOpenDialog"]>[0]
      | undefined;
    const dialog: RepositoryDirectoryPickerDialog = {
      showOpenDialog: async (options) => {
        dialogOptions = options;
        return { canceled: true, filePaths: [] };
      },
    };

    const result = await createRepositoryDirectoryPicker({
      dialog,
      resolveRepositoryRoot: async () => {
        resolved = true;
        return "/repo";
      },
    });

    assert.deepEqual(result, { status: "canceled" });
    assert.equal(resolved, false);
    assert.deepEqual(dialogOptions, {
      title: "Select Git repository folder / 选择 Git 仓库文件夹",
      properties: ["openDirectory"],
    });
  });

  it("resolves a selected repository and nested directory to its Git root", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = await resolveGitRepositoryRoot("/repo/packages/web", {
      accessDirectory: async () => undefined,
      runFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "/repo\n" };
      },
    });

    assert.equal(result, "/repo");
    assert.deepEqual(calls, [
      {
        file: "git",
        args: ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
      },
    ]);
  });

  it("returns a clear error for inaccessible and non-Git directories", async () => {
    const inaccessible = await createRepositoryDirectoryPicker({
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: ["/private/secret"],
        }),
      },
      resolveRepositoryRoot: async () => {
        throw Object.assign(new Error("permission denied"), {
          code: "DIRECTORY_NOT_ACCESSIBLE",
        });
      },
    });
    assert.deepEqual(inaccessible, {
      status: "error",
      code: "DIRECTORY_NOT_ACCESSIBLE",
      message: "The selected directory is not accessible.",
    });

    const nonGit = await createRepositoryDirectoryPicker({
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: ["/tmp/not-a-repository"],
        }),
      },
      resolveRepositoryRoot: async () => {
        throw Object.assign(new Error("not a repository"), {
          code: "NOT_GIT_REPOSITORY",
        });
      },
    });
    assert.deepEqual(nonGit, {
      status: "error",
      code: "NOT_GIT_REPOSITORY",
      message: "The selected directory is not a Git repository.",
    });
  });

  it("uses an argument array and reports Git command failures as non-Git", async () => {
    let received: { file: string; args: readonly string[] } | undefined;
    await assert.rejects(
      () =>
        resolveGitRepositoryRoot("/tmp/not-a-repository", {
          accessDirectory: async () => undefined,
          runFile: async (file, args) => {
            received = { file, args };
            throw new Error("fatal: not a git repository");
          },
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "NOT_GIT_REPOSITORY",
    );
    assert.deepEqual(received, {
      file: "git",
      args: ["-C", "/tmp/not-a-repository", "rev-parse", "--show-toplevel"],
    });
  });
});
