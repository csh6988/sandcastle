// Spawn and supervise the `sandcastle board` child process for the selected
// repository. The desktop app owns process lifecycle only — all orchestration
// semantics stay inside the CLI/library.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const findFreePort = (): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });

/**
 * Resolve how to run the sandcastle CLI for a repo:
 * 1. the repo's own install (`node_modules/.bin/sandcastle`),
 * 2. an explicit override (`SANDCASTLE_CLI`),
 * 3. the dogfooding fallback: this checkout's built `dist/main.js`.
 */
export const resolveBoardCommand = (
  repoDir: string,
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } => {
  const localBin = join(repoDir, "node_modules", ".bin", "sandcastle");
  const localBinCandidates =
    platform === "win32"
      ? [`${localBin}.cmd`, `${localBin}.exe`, `${localBin}.bat`, localBin]
      : [localBin];
  const localCommand = localBinCandidates.find((candidate) =>
    existsSync(candidate),
  );
  if (localCommand) return { command: localCommand, args: [] };
  if (process.env.SANDCASTLE_CLI) {
    return { command: process.env.SANDCASTLE_CLI, args: [] };
  }
  const dogfood = join(desktopRoot, "..", "..", "dist", "main.js");
  if (existsSync(dogfood)) {
    return { command: process.execPath, args: [dogfood] };
  }
  throw new Error(
    `No sandcastle CLI found for ${repoDir}. Install sandcastle in the repo, set SANDCASTLE_CLI, or build this checkout (npm run build).`,
  );
};

export const boardCommandRequiresShell = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean => platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);

export interface BoardProcessHandle {
  readonly url: string;
  readonly port: number;
  readonly child: ChildProcess;
  readonly stop: () => Promise<void>;
}

const waitForBoard = async (
  url: string,
  child: ChildProcess,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`board process exited with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${url}/api/tasks`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`board server did not become ready at ${url}`);
};

export const startBoardProcess = async (args: {
  readonly repoDir: string;
  readonly desktopRoot: string;
  readonly onLog: (line: string) => void;
}): Promise<BoardProcessHandle> => {
  const port = await findFreePort();
  const { command, args: commandArgs } = resolveBoardCommand(
    args.repoDir,
    args.desktopRoot,
  );
  const child = spawn(
    command,
    [...commandArgs, "board", "--port", String(port)],
    {
      cwd: args.repoDir,
      env: process.env,
      shell: boardCommandRequiresShell(command),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => args.onLog(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => args.onLog(chunk.toString()));

  const url = `http://127.0.0.1:${port}`;
  await waitForBoard(url, child);

  return {
    url,
    port,
    child,
    stop: () =>
      new Promise<void>((resolvePromise) => {
        if (child.exitCode !== null) return resolvePromise();
        child.once("exit", () => resolvePromise());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3_000).unref();
      }),
  };
};
