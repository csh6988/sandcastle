import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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

  it("returns canceled without resolving or changing anything", async () => {
    let resolved = false;
    const dialog: RepositoryDirectoryPickerDialog = {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
