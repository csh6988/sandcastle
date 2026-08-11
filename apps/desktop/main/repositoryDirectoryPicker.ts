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
}

const pickerErrorMessage = (code: PickerErrorCode): string => {
  if (code === "DIRECTORY_NOT_ACCESSIBLE") {
    return "The selected directory is not accessible.";
  }
  if (code === "NOT_GIT_REPOSITORY") {
    return "The selected directory is not a Git repository.";
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
    return { status: "error", code, message: pickerErrorMessage(code) };
  }
};
