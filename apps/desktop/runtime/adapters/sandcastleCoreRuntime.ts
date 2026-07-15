import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";

interface SandcastleCoreModule {
  readonly run: (options: Record<string, unknown>) => Promise<{
    readonly output?: unknown;
    readonly commits?: readonly { readonly sha: string }[];
    readonly stdout?: string;
  }>;
  readonly runWorkspaceTask: (options: Record<string, unknown>) => Promise<{
    readonly plan?: unknown;
    readonly repositories?: Readonly<Record<string, unknown>>;
    readonly plannerStdout?: string;
  }>;
  readonly Output: {
    readonly object: (input: {
      readonly tag: string;
      readonly schema: unknown;
    }) => unknown;
  };
  readonly createBindMountSandboxProvider: (input: {
    readonly name: string;
    readonly create: (options: {
      readonly worktreePath: string;
      readonly mounts: readonly {
        readonly hostPath: string;
        readonly sandboxPath: string;
      }[];
      readonly env: Record<string, string>;
    }) => Promise<unknown>;
  }) => unknown;
  readonly claudeCode: (
    model?: string,
    options?: { readonly captureSessions?: boolean },
  ) => unknown;
  readonly codex: (model: string) => unknown;
  readonly copilot: (model?: string) => unknown;
  readonly cursor: (model?: string) => unknown;
  readonly opencode: (model?: string) => unknown;
  readonly pi: (model?: string) => unknown;
}

interface NoSandboxModule {
  readonly noSandbox: () => {
    readonly create: (options: {
      readonly worktreePath: string;
      readonly env: Record<string, string>;
    }) => Promise<{
      readonly worktreePath: string;
      readonly exec: (
        command: string,
        options?: {
          readonly onLine?: (line: string) => void;
          readonly cwd?: string;
          readonly sudo?: boolean;
          readonly stdin?: string;
        },
      ) => Promise<unknown>;
      readonly interactiveExec?: (
        args: string[],
        options: Record<string, unknown>,
      ) => Promise<{ readonly exitCode: number }>;
      readonly close: () => Promise<void>;
    }>;
  };
}

const translateSandboxPath = (
  path: string,
  mounts: readonly {
    readonly hostPath: string;
    readonly sandboxPath: string;
  }[],
): string => {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const mount = [...mounts]
    .sort((left, right) => right.sandboxPath.length - left.sandboxPath.length)
    .find(
      (candidate) =>
        normalized === candidate.sandboxPath ||
        normalized.startsWith(`${candidate.sandboxPath}/`),
    );
  if (!mount) return path;
  const relative = normalized
    .slice(mount.sandboxPath.length)
    .replace(/^\//, "");
  return relative ? join(mount.hostPath, relative) : mount.hostPath;
};

const createHostBindMountSandbox = (
  core: SandcastleCoreModule,
  noSandboxModule: NoSandboxModule,
): unknown => {
  const provider = noSandboxModule.noSandbox();
  return core.createBindMountSandboxProvider({
    name: "no-sandbox",
    create: async (options) => {
      const handle = await provider.create({
        worktreePath: options.worktreePath,
        env: options.env,
      });
      return {
        worktreePath: options.worktreePath,
        exec: (
          command: string,
          execOptions?: Parameters<typeof handle.exec>[1],
        ) =>
          handle.exec(command, {
            ...execOptions,
            ...(execOptions?.cwd
              ? {
                  cwd: translateSandboxPath(execOptions.cwd, options.mounts),
                }
              : {}),
          }),
        ...(handle.interactiveExec
          ? {
              interactiveExec: (
                args: string[],
                interactiveOptions: Record<string, unknown>,
              ) =>
                handle.interactiveExec!(args, {
                  ...interactiveOptions,
                  ...(typeof interactiveOptions.cwd === "string"
                    ? {
                        cwd: translateSandboxPath(
                          interactiveOptions.cwd,
                          options.mounts,
                        ),
                      }
                    : {}),
                }),
            }
          : {}),
        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          const destination = translateSandboxPath(sandboxPath, options.mounts);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(hostPath, destination);
        },
        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          const source = translateSandboxPath(sandboxPath, options.mounts);
          mkdirSync(dirname(hostPath), { recursive: true });
          copyFileSync(source, hostPath);
        },
        close: () => handle.close(),
      };
    },
  });
};

const coreDirectoryCandidates = (): string[] => [
  ...(process.env.SANDCASTLE_CORE_DIST
    ? [resolve(process.env.SANDCASTLE_CORE_DIST)]
    : []),
  ...(typeof process.resourcesPath === "string"
    ? [join(process.resourcesPath, "sandcastle-core")]
    : []),
  resolve(process.cwd(), "dist"),
  resolve(process.cwd(), "../../dist"),
];

const findCoreDirectory = (): string => {
  const directory = coreDirectoryCandidates().find((candidate) =>
    existsSync(join(candidate, "index.js")),
  );
  if (!directory) {
    throw new Error(
      "Sandcastle core dist was not found. Build the root package or set SANDCASTLE_CORE_DIST.",
    );
  }
  return directory;
};

export const createSandcastleExecutionRuntimeFromModules = (
  core: SandcastleCoreModule,
  noSandboxModule: NoSandboxModule,
): SandcastleExecutionRuntime => {
  const hostBindMountSandbox = createHostBindMountSandbox(
    core,
    noSandboxModule,
  );
  return {
    resolveAgent: (providerRef, model) => {
      const resolvedProvider =
        providerRef === "default-agent"
          ? process.env.SANDCASTLE_DEFAULT_AGENT_PROVIDER
          : providerRef;
      switch (resolvedProvider) {
        case "claude-code":
          return core.claudeCode(model, { captureSessions: false });
        case "codex":
          return core.codex(model);
        case "copilot":
          return core.copilot(model);
        case "cursor":
          return core.cursor(model);
        case "opencode":
          return core.opencode(model);
        case "pi":
          return core.pi(model);
        default:
          throw new Error(
            `Unsupported Agent provider reference: ${providerRef}`,
          );
      }
    },
    resolveSandbox: (sandboxRef) => {
      if (sandboxRef !== "no-sandbox") {
        throw new Error(`Unsupported Sandbox reference: ${sandboxRef}`);
      }
      return hostBindMountSandbox;
    },
    run: async (options) => {
      const outputMarker = options.output as
        | { readonly tag: string; readonly schema: "object" }
        | undefined;
      return core.run({
        ...options,
        ...(outputMarker
          ? {
              output: core.Output.object({
                tag: outputMarker.tag,
                schema: z.record(z.unknown()),
              }),
            }
          : {}),
      });
    },
    runWorkspaceTask: (options) =>
      core.runWorkspaceTask({ ...options } as Record<string, unknown>),
  };
};

export const loadSandcastleExecutionRuntime =
  async (): Promise<SandcastleExecutionRuntime> => {
    const directory = findCoreDirectory();
    const [core, noSandboxModule] = await Promise.all([
      import(
        pathToFileURL(join(directory, "index.js")).href
      ) as Promise<SandcastleCoreModule>,
      import(
        pathToFileURL(join(directory, "sandboxes/no-sandbox.js")).href
      ) as Promise<NoSandboxModule>,
    ]);
    return createSandcastleExecutionRuntimeFromModules(core, noSandboxModule);
  };
