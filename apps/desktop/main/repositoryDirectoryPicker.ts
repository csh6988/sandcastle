import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { RepositoryDirectoryPickerResult } from "../preload/bridge.js";

type PickerErrorCode = Extract<
  RepositoryDirectoryPickerResult,
  { readonly status: "error" }
>["code"];

class RepositoryDirectoryPickerError extends Error {
  readonly code: PickerErrorCode;

  constructor(code: PickerErrorCode) {
    super(code);
    this.code = code;
  }
}

interface PathApi {
  resolve(...paths: readonly string[]): string;
}

interface ResolveGitRepositoryRootOptions {
  readonly pathApi?: PathApi;
  readonly accessDirectory?: (directoryPath: string) => Promise<void>;
  readonly runFile?: (
    file: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
}

const accessDirectory = async (directoryPath: string): Promise<void> => {
  await access(directoryPath, constants.R_OK);
  if (!(await stat(directoryPath)).isDirectory()) {
    throw new Error("Selected path is not a directory.");
  }
};

const runFile = (
  file: string,
  args: readonly string[],
): Promise<{ readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });

export const resolveGitRepositoryRoot = async (
  directoryPath: string,
  options: ResolveGitRepositoryRootOptions = {},
): Promise<string> => {
  try {
    await (options.accessDirectory ?? accessDirectory)(directoryPath);
  } catch {
    throw new RepositoryDirectoryPickerError("DIRECTORY_NOT_ACCESSIBLE");
  }

  let stdout: string;
  try {
    ({ stdout } = await (options.runFile ?? runFile)("git", [
      "-C",
      directoryPath,
      "rev-parse",
      "--show-toplevel",
    ]));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new RepositoryDirectoryPickerError("GIT_UNAVAILABLE");
    }
    throw new RepositoryDirectoryPickerError("NOT_GIT_REPOSITORY");
  }

  const root = stdout.trim();
  if (!root) {
    throw new RepositoryDirectoryPickerError("NOT_GIT_REPOSITORY");
  }
  return (options.pathApi ?? path).resolve(root);
};

export interface RepositoryDirectoryPickerDialog {
  showOpenDialog(options: {
    readonly title: string;
    readonly properties: readonly ["openDirectory"];
  }): Promise<{
    readonly canceled: boolean;
    readonly filePaths: readonly string[];
  }>;
  showMessageBox?(options: {
    readonly type: "question";
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly [string, string];
    readonly defaultId: 0;
    readonly cancelId: 1;
    readonly noLink: true;
  }): Promise<{ readonly response: number }>;
}

const initializeGitRepository = async (
  directoryPath: string,
): Promise<void> => {
  await runFile("git", ["init", "--", directoryPath]);
};

const initializeRepositoryConfirmation = {
  type: "question",
  title: "Initialize local Git repository / 初始化本地 Git 仓库",
  message: "This folder is not a Git repository.",
  detail:
    "Initialize Git here so Sandcastle can use commits and isolated worktrees? No remote or initial commit will be created.\n\n该文件夹不是 Git 仓库。是否在此初始化 Git，以便 Sandcastle 使用提交和隔离 Worktree？不会创建远程仓库或初始提交。",
  buttons: ["Initialize Git / 初始化 Git", "Cancel / 取消"],
  defaultId: 0,
  cancelId: 1,
  noLink: true,
} as const;

const pickerErrorMessage = (code: PickerErrorCode): string => {
  if (code === "DIRECTORY_NOT_ACCESSIBLE") {
    return "The selected directory is not accessible.";
  }
  if (code === "NOT_GIT_REPOSITORY") {
    return "The selected directory is not a Git repository.";
  }
  if (code === "GIT_INIT_FAILED") {
    return "Git could not be initialized in the selected directory.";
  }
  if (code === "GIT_UNAVAILABLE") {
    return "Git is not available on this computer.";
  }
  return "The repository folder picker could not be opened.";
};

export const createRepositoryDirectoryPicker = async (options: {
  readonly dialog: RepositoryDirectoryPickerDialog;
  readonly resolveRepositoryRoot?: (directoryPath: string) => Promise<string>;
}): Promise<RepositoryDirectoryPickerResult> => {
  let selection: Awaited<
    ReturnType<RepositoryDirectoryPickerDialog["showOpenDialog"]>
  >;
  try {
    selection = await options.dialog.showOpenDialog({
      title: "Select Git repository folder / 选择 Git 仓库文件夹",
      properties: ["openDirectory"],
    });
  } catch {
    return {
      status: "error",
      code: "PICKER_FAILED",
      message: pickerErrorMessage("PICKER_FAILED"),
    };
  }
  if (selection.canceled || !selection.filePaths[0]) {
    return { status: "canceled" };
  }
  try {
    const repositoryRoot = await (
      options.resolveRepositoryRoot ?? resolveGitRepositoryRoot
    )(selection.filePaths[0]);
    return { status: "selected", path: repositoryRoot };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "DIRECTORY_NOT_ACCESSIBLE" ||
        error.code === "NOT_GIT_REPOSITORY" ||
        error.code === "GIT_UNAVAILABLE")
        ? error.code
        : "PICKER_FAILED";
    if (code === "NOT_GIT_REPOSITORY" && options.dialog.showMessageBox) {
      let response: number;
      try {
        ({ response } = await options.dialog.showMessageBox(
          initializeRepositoryConfirmation,
        ));
      } catch {
        return {
          status: "error",
          code: "PICKER_FAILED",
          message: pickerErrorMessage("PICKER_FAILED"),
        };
      }
      if (response !== initializeRepositoryConfirmation.defaultId) {
        return { status: "canceled" };
      }
      try {
        await initializeGitRepository(selection.filePaths[0]);
      } catch {
        return {
          status: "error",
          code: "GIT_INIT_FAILED",
          message: pickerErrorMessage("GIT_INIT_FAILED"),
        };
      }
      try {
        const repositoryRoot = await (
          options.resolveRepositoryRoot ?? resolveGitRepositoryRoot
        )(selection.filePaths[0]);
        return { status: "selected", path: repositoryRoot };
      } catch {
        return {
          status: "error",
          code: "GIT_INIT_FAILED",
          message: pickerErrorMessage("GIT_INIT_FAILED"),
        };
      }
    }
    return { status: "error", code, message: pickerErrorMessage(code) };
  }
};
