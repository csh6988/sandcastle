import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { resolveCwd } from "./resolveCwd.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  AgentStreamEmitter,
  agentStreamEmitterLayer,
} from "./AgentStreamEmitter.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  type Severity,
} from "./Display.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { normalizeMounts, patchGitMountsForWindows } from "./mountUtils.js";
import {
  DEFAULT_COMPLETION_SIGNAL,
  DEFAULT_COMPLETION_TIMEOUT_SECONDS,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  IDLE_WARNING_INTERVAL_MS,
  invokeAgent,
  type IterationResult,
} from "./Orchestrator.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
} from "./PromptArgumentSubstitution.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import type { RunEvent } from "./RunEvent.js";
import {
  buildAgentStreamHandler,
  buildCompletionMessage,
  buildContextWindowLines,
  buildLogFilename,
  DEFAULT_MAX_ITERATIONS,
  printFileDisplayStartup,
  type LoggingOption,
  type Timeouts,
} from "./run.js";
import {
  makeSandboxFromHandle,
  resolveGitMounts,
  type MountEntry,
  type SandboxService,
} from "./SandboxFactory.js";
import type {
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  BranchStrategy,
  SandboxProvider,
} from "./SandboxProvider.js";
import {
  runHostHooks,
  withSandboxLifecycle,
  type SandboxHooks,
} from "./SandboxLifecycle.js";
import type { SandboxError } from "./errors.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";
import * as WorktreeManager from "./WorktreeManager.js";

const WORKSPACE_REPOS_DIR = "/home/agent/repos";

export interface WorkspaceRepositoryOptions {
  readonly name: string;
  readonly cwd: string;
  readonly branchStrategy?: Exclude<BranchStrategy, { type: "head" }>;
  readonly copyToWorktree?: string[];
  readonly hooks?: SandboxHooks;
}

export interface WorkspaceRepositoryResult {
  readonly branch: string;
  readonly worktreePath: string;
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
  readonly preservedWorktreePath?: string;
}

export interface RunWorkspaceOptions<A extends AgentProvider = AgentProvider> {
  readonly repositories: ReadonlyArray<WorkspaceRepositoryOptions>;
  readonly primaryRepository: string;
  readonly agent: A;
  readonly sandbox: SandboxProvider;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly completionTimeoutSeconds?: number;
  readonly logging?: LoggingOption;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly timeouts?: Timeouts;
  /**
   * Optional callback emitting the structured run-event stream for this
   * workspace run (run lifecycle, iterations, agent text/tool calls, token
   * usage). Works in both display modes, mirroring `run()`'s `onRunEvent`.
   * Lets a caller (e.g. the workflow board) surface the planner phase as its
   * own visible run. See ADR 0021.
   */
  readonly onRunEvent?: (event: RunEvent) => void;
}

export interface RunWorkspaceResult {
  readonly repositories: Record<string, WorkspaceRepositoryResult>;
  readonly stdout: string;
  readonly iterations: ReadonlyArray<IterationResult>;
  readonly completionSignal?: string;
  readonly logFilePath?: string;
}

interface PreparedRepository {
  readonly name: string;
  readonly hostRepoDir: string;
  readonly worktreePath: string;
  readonly worktreeBranch: string;
  readonly lifecycleBranch?: string;
  readonly sandboxPath: string;
  readonly hooks?: SandboxHooks;
  readonly commits: { sha: string }[];
  branch?: string;
  preservedWorktreePath?: string;
}

class WorkspaceRepositoryError extends Error {
  constructor(
    readonly repository: PreparedRepository,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `runWorkspace repository "${repository.name}" failed on branch ` +
        `"${repository.worktreeBranch}": ${detail}\n` +
        `Worktree preserved at ${repository.worktreePath}\n` +
        `Recovery: cd ${JSON.stringify(repository.worktreePath)} && git status`,
    );
    this.name = "WorkspaceRepositoryError";
    this.cause = cause;
  }
}

const isWorkspaceRepositoryError = (
  error: unknown,
): error is WorkspaceRepositoryError =>
  error instanceof Error && error.name === "WorkspaceRepositoryError";

const assertValidRepositoryNames = (
  repositories: ReadonlyArray<WorkspaceRepositoryOptions>,
  primaryRepository: string,
): void => {
  if (repositories.length === 0) {
    throw new Error("runWorkspace requires at least one repository");
  }

  const names = new Set<string>();
  for (const repo of repositories) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo.name)) {
      throw new Error(
        `repository name "${repo.name}" is invalid. Use only letters, numbers, dot, underscore, and dash.`,
      );
    }
    if (names.has(repo.name)) {
      throw new Error(`duplicate repository name "${repo.name}"`);
    }
    names.add(repo.name);
  }

  if (!names.has(primaryRepository)) {
    throw new Error(`primaryRepository "${primaryRepository}" was not found`);
  }
};

const getSupportedSandbox = (
  sandbox: SandboxProvider,
): BindMountSandboxProvider => {
  if (sandbox.tag !== "bind-mount") {
    throw new Error(
      `runWorkspace supports bind-mount sandbox providers only. ` +
        `Provider "${sandbox.name}" has tag "${sandbox.tag}".`,
    );
  }
  return sandbox;
};

const lifecycleBranchFor = (
  branchStrategy: WorkspaceRepositoryOptions["branchStrategy"],
): string | undefined => {
  const strategy = branchStrategy as BranchStrategy | undefined;
  if (strategy?.type === "head") {
    throw new Error(
      "runWorkspace does not support head branch strategy. " +
        "Each workspace repository is managed through a worktree.",
    );
  }
  return strategy?.type === "branch" ? strategy.branch : undefined;
};

const buildWorkspaceManifest = (
  repositories: ReadonlyArray<PreparedRepository>,
  primaryRepository: string,
): string => {
  const rows = repositories
    .map((repo) => {
      const primary = repo.name === primaryRepository ? " (primary)" : "";
      return `- ${repo.name}${primary}: ${repo.sandboxPath} on branch ${repo.worktreeBranch}`;
    })
    .join("\n");

  return `\n\nSandcastle workspace repositories:\n${rows}\n\nDefault working directory: ${
    repositories.find((repo) => repo.name === primaryRepository)!.sandboxPath
  }\nUse the listed sandbox paths when editing files across repositories.`;
};

const buildDisplayLayer = (
  options: RunWorkspaceOptions,
  primaryHostRepoDir: string,
  primaryBranch: string,
): { layer: Layer.Layer<Display>; logFilePath?: string } => {
  const logging =
    options.logging ??
    ({
      type: "file",
      path: join(
        primaryHostRepoDir,
        ".sandcastle",
        "logs",
        buildLogFilename(primaryBranch, undefined, options.name),
      ),
    } satisfies LoggingOption);

  if (logging.type === "file") {
    printFileDisplayStartup({
      logPath: logging.path,
      agentName: options.name,
      branch: primaryBranch,
      hostRepoDir: primaryHostRepoDir,
    });
    return {
      layer: Layer.provide(
        FileDisplay.layer(logging.path),
        NodeFileSystem.layer,
      ),
      logFilePath: logging.path,
    };
  }

  return { layer: ClackDisplay.layer };
};

const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const cleanupRepository = async (
  repo: PreparedRepository,
  forcePreserve: boolean,
): Promise<void> => {
  if (forcePreserve) {
    repo.preservedWorktreePath = repo.worktreePath;
    return;
  }

  const dirty = await Effect.runPromise(
    WorktreeManager.hasUncommittedChanges(repo.worktreePath).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  );

  if (dirty) {
    repo.preservedWorktreePath = repo.worktreePath;
    console.error(
      `Run succeeded but repository "${repo.name}" has uncommitted changes at ${repo.worktreePath}`,
    );
    console.error(`  To review: cd ${repo.worktreePath}`);
    console.error(
      `  To clean up: git worktree remove --force ${repo.worktreePath}`,
    );
    return;
  }

  await Effect.runPromise(WorktreeManager.remove(repo.worktreePath));
};

const prepareRepository = async (
  repo: WorkspaceRepositoryOptions,
  options: RunWorkspaceOptions,
  displayLayer: Layer.Layer<Display>,
): Promise<PreparedRepository> => {
  const hostRepoDir = await Effect.runPromise(
    resolveCwd(repo.cwd).pipe(Effect.provide(NodeContext.layer)),
  );
  const branchStrategy = repo.branchStrategy ?? { type: "merge-to-head" };
  const lifecycleBranch = lifecycleBranchFor(branchStrategy);

  await Effect.runPromise(
    WorktreeManager.pruneStale(hostRepoDir).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.error(
            `[sandcastle] Warning: failed to prune stale worktrees for repository "${repo.name}":`,
            e.message,
          );
        }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );

  const worktreeInfo = await Effect.runPromise(
    WorktreeManager.create(
      hostRepoDir,
      branchStrategy.type === "branch"
        ? {
            branch: branchStrategy.branch,
            baseBranch: branchStrategy.baseBranch,
          }
        : { name: `${options.name ?? "workspace"}-${repo.name}` },
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  if (repo.copyToWorktree?.length) {
    await runEffect(
      copyToWorktree(
        [...repo.copyToWorktree],
        hostRepoDir,
        worktreeInfo.path,
        options.timeouts?.copyToWorktreeMs,
      ),
      displayLayer,
    );
  }

  if (repo.hooks?.host?.onWorktreeReady?.length) {
    await Effect.runPromise(
      runHostHooks(
        repo.hooks.host.onWorktreeReady,
        worktreeInfo.path,
        options.signal,
      ),
    );
  }

  return {
    name: repo.name,
    hostRepoDir,
    worktreePath: worktreeInfo.path,
    worktreeBranch: worktreeInfo.branch,
    lifecycleBranch,
    sandboxPath: `${WORKSPACE_REPOS_DIR}/${repo.name}`,
    hooks: repo.hooks,
    commits: [],
  };
};

const resolveRepositoryMounts = async (
  repo: PreparedRepository,
): Promise<MountEntry[]> => {
  const gitMounts = await Effect.runPromise(
    resolveGitMounts(join(repo.hostRepoDir, ".git")).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  const patchedGitMounts = await Effect.runPromise(
    patchGitMountsForWindows(gitMounts, repo.worktreePath, repo.sandboxPath),
  );
  return normalizeMounts(
    [
      { hostPath: repo.worktreePath, sandboxPath: repo.sandboxPath },
      ...patchedGitMounts,
    ],
    repo.worktreePath,
    repo.sandboxPath,
  );
};

const startWorkspaceSandbox = async (
  provider: BindMountSandboxProvider,
  repositories: ReadonlyArray<PreparedRepository>,
  primaryRepository: string,
  env: Record<string, string>,
): Promise<{
  readonly handle: BindMountSandboxHandle;
  readonly sandbox: SandboxService;
}> => {
  const primary = repositories.find((repo) => repo.name === primaryRepository)!;
  const mounts = (
    await Promise.all(repositories.map((repo) => resolveRepositoryMounts(repo)))
  ).flat();
  const worktreePath =
    process.platform === "win32"
      ? primary.worktreePath.replace(/\\/g, "/")
      : primary.worktreePath;
  const handle = await provider.create({
    worktreePath,
    hostRepoPath: primary.hostRepoDir,
    mounts,
    env,
  });
  return { handle, sandbox: makeSandboxFromHandle(handle) };
};

const runRepositoryLifecycles = (
  repositories: ReadonlyArray<PreparedRepository>,
  index: number,
  sandbox: SandboxService,
  work: () => Effect.Effect<
    {
      readonly stdout: string;
      readonly completionSignal?: string;
      readonly iteration: IterationResult;
    },
    SandboxError | WorkspaceRepositoryError,
    Display | AgentStreamEmitter
  >,
  options: RunWorkspaceOptions,
): Effect.Effect<
  {
    readonly stdout: string;
    readonly completionSignal?: string;
    readonly iteration: IterationResult;
  },
  SandboxError | WorkspaceRepositoryError,
  Display | AgentStreamEmitter
> => {
  const repo = repositories[index];
  if (repo === undefined) {
    return work();
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    yield* display.status(`Repository ${repo.name}`, "info");
    return yield* withSandboxLifecycle(
      {
        hostRepoDir: repo.hostRepoDir,
        sandboxRepoDir: repo.sandboxPath,
        branch: repo.lifecycleBranch,
        hostWorktreePath: repo.worktreePath,
        hooks: repo.hooks,
        signal: options.signal,
        timeouts: options.timeouts,
      },
      sandbox,
      () =>
        runRepositoryLifecycles(
          repositories,
          index + 1,
          sandbox,
          work,
          options,
        ),
    ).pipe(
      Effect.map((result) => {
        repo.branch = result.branch;
        repo.commits.push(...result.commits);
        return result.result;
      }),
      Effect.mapError((error) =>
        isWorkspaceRepositoryError(error)
          ? error
          : new WorkspaceRepositoryError(repo, error),
      ),
    );
  });
};

export async function runWorkspace(
  options: RunWorkspaceOptions,
): Promise<RunWorkspaceResult> {
  options.signal?.throwIfAborted();
  assertValidRepositoryNames(options.repositories, options.primaryRepository);
  const sandboxProvider = getSupportedSandbox(options.sandbox);

  // Safe, synchronous run-event emit. A thrown observer must never abort the
  // workspace run, so callback errors are swallowed.
  const emitRunEvent = (event: RunEvent): void => {
    if (!options.onRunEvent) return;
    try {
      options.onRunEvent(event);
    } catch {
      // Swallow — a broken observer must not kill the run.
    }
  };

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (maxIterations < 1 || !Number.isInteger(maxIterations)) {
    throw new Error(
      `maxIterations must be a positive integer. Received: ${maxIterations}`,
    );
  }

  const primaryInput = options.repositories.find(
    (repo) => repo.name === options.primaryRepository,
  )!;
  const primaryHostRepoDir = await Effect.runPromise(
    resolveCwd(primaryInput.cwd).pipe(Effect.provide(NodeContext.layer)),
  );
  const primaryBranch = await Effect.runPromise(
    WorktreeManager.getCurrentBranch(primaryHostRepoDir),
  );
  const displayConfig = buildDisplayLayer(
    options,
    primaryHostRepoDir,
    primaryBranch,
  );
  const displayLayer = displayConfig.layer;
  const streamEmitterLayer = agentStreamEmitterLayer(
    options.logging?.type === "file"
      ? buildAgentStreamHandler(options.logging)
      : undefined,
  );
  const effectLayer = Layer.merge(displayLayer, streamEmitterLayer);

  const resolvedPrompt = await Effect.runPromise(
    resolvePrompt({
      prompt: options.prompt,
      promptFile: options.promptFile,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
  if (resolvedPrompt.source === "inline") {
    await runEffect(
      validateNoArgsWithInlinePrompt(options.promptArgs ?? {}),
      displayLayer,
    );
  }

  const resolvedEnv = await Effect.runPromise(
    resolveEnv(primaryHostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: options.agent.env,
    sandboxProviderEnv: options.sandbox.env,
  });

  const prepared: PreparedRepository[] = [];
  let handle: BindMountSandboxHandle | undefined;
  let result: RunWorkspaceResult | undefined;
  let caught: unknown;

  try {
    for (const repo of options.repositories) {
      prepared.push(await prepareRepository(repo, options, displayLayer));
    }

    const primary = prepared.find(
      (repo) => repo.name === options.primaryRepository,
    )!;
    const started = await startWorkspaceSandbox(
      sandboxProvider,
      prepared,
      options.primaryRepository,
      env,
    );
    handle = started.handle;

    const manifest = buildWorkspaceManifest(
      prepared,
      options.primaryRepository,
    );
    const promptWithArgs =
      resolvedPrompt.source === "template"
        ? await runEffect(
            substitutePromptArgs(
              resolvedPrompt.text,
              options.promptArgs ?? {},
              new Set(),
            ),
            displayLayer,
          )
        : resolvedPrompt.text;
    const prompt = `${promptWithArgs}${manifest}`;

    const completionSignals =
      options.completionSignal === undefined
        ? [DEFAULT_COMPLETION_SIGNAL]
        : Array.isArray(options.completionSignal)
          ? options.completionSignal
          : [options.completionSignal];

    const display = await Effect.runPromise(
      Effect.map(Display, (displayService) => displayService).pipe(
        Effect.provide(displayLayer),
      ),
    );
    await Effect.runPromise(
      display.intro(options.name ?? "sandcastle workspace"),
    );
    await Effect.runPromise(
      display.summary("Sandcastle Workspace Run", {
        Agent: options.agent.name,
        Sandbox: options.sandbox.name,
        "Primary repository": options.primaryRepository,
        Repositories: prepared.map((repo) => repo.name).join(", "),
        "Max iterations": String(maxIterations),
      }),
    );

    emitRunEvent({
      type: "run-started",
      name: options.name ?? options.agent.name,
      agent: options.agent.name,
      model: options.agent.model,
      sandbox: options.sandbox.name,
      branch: primaryBranch,
      maxIterations,
      timestamp: new Date(),
    });

    const allIterations: IterationResult[] = [];
    let allStdout = "";
    let matchedCompletionSignal: string | undefined;

    for (let i = 1; i <= maxIterations; i++) {
      options.signal?.throwIfAborted();
      await Effect.runPromise(
        display.status(`Workspace iteration ${i}/${maxIterations}`, "info"),
      );
      emitRunEvent({
        type: "iteration-started",
        iteration: i,
        maxIterations,
        timestamp: new Date(),
      });

      const iterationResult = await runEffect(
        runRepositoryLifecycles(
          prepared,
          0,
          started.sandbox,
          () =>
            Effect.gen(function* () {
              const streamEmitter = yield* AgentStreamEmitter;
              const textBuffer = new TextDeltaBuffer((chunk) => {
                Effect.runPromise(display.text(chunk));
                Effect.runPromise(
                  streamEmitter.emit({
                    type: "text",
                    message: chunk,
                    iteration: i,
                    timestamp: new Date(),
                  }),
                );
                emitRunEvent({
                  type: "agent-text",
                  message: chunk,
                  iteration: i,
                  timestamp: new Date(),
                });
              });
              const onText = (text: string) => textBuffer.write(text);
              const onToolCall = (name: string, formattedArgs: string) => {
                textBuffer.flush();
                Effect.runPromise(display.toolCall(name, formattedArgs));
                Effect.runPromise(
                  streamEmitter.emit({
                    type: "toolCall",
                    name,
                    formattedArgs,
                    iteration: i,
                    timestamp: new Date(),
                  }),
                );
                emitRunEvent({
                  type: "agent-tool-call",
                  name,
                  formattedArgs,
                  iteration: i,
                  timestamp: new Date(),
                });
              };
              const onRawLine = (line: string) => {
                Effect.runPromise(
                  streamEmitter.emit({
                    type: "raw",
                    line,
                    iteration: i,
                    timestamp: new Date(),
                  }),
                ).catch(() => {});
              };
              const onIdleWarning = (minutes: number) => {
                const message =
                  minutes === 1
                    ? "Agent idle for 1 minute"
                    : `Agent idle for ${minutes} minutes`;
                Effect.runPromise(display.status(message, "warn"));
              };
              const onCompletionTimeout = (timeoutMs: number) => {
                Effect.runPromise(
                  display.status(
                    `Completion signal seen but agent process is hanging — force-completing after ${timeoutMs / 1000}s grace window.`,
                    "warn",
                  ),
                );
              };
              const rawAgentPrompt =
                resolvedPrompt.source === "inline"
                  ? prompt
                  : yield* preprocessPrompt(
                      prompt,
                      started.sandbox,
                      primary.sandboxPath,
                    );
              yield* display.status("Agent started", "success");
              const agentOutput = yield* invokeAgent(
                started.sandbox,
                primary.sandboxPath,
                rawAgentPrompt,
                options.agent,
                (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) *
                  1000,
                (options.completionTimeoutSeconds ??
                  DEFAULT_COMPLETION_TIMEOUT_SECONDS) * 1000,
                completionSignals,
                onText,
                onToolCall,
                onRawLine,
                onIdleWarning,
                onCompletionTimeout,
                IDLE_WARNING_INTERVAL_MS,
                undefined,
                undefined,
                options.signal,
              );
              textBuffer.dispose();
              yield* display.status("Agent stopped", "info");
              const completionSignal = completionSignals.find((signal) =>
                agentOutput.result.includes(signal),
              );
              return {
                stdout: agentOutput.result,
                completionSignal,
                iteration: {
                  sessionId: agentOutput.sessionId,
                  usage: agentOutput.usage,
                },
              };
            }),
          options,
        ),
        effectLayer,
      );

      allStdout += iterationResult.stdout;
      allIterations.push(iterationResult.iteration);

      if (iterationResult.iteration.usage) {
        emitRunEvent({
          type: "usage",
          usage: iterationResult.iteration.usage,
          model: options.agent.model,
          iteration: i,
          timestamp: new Date(),
        });
      }

      if (iterationResult.completionSignal !== undefined) {
        matchedCompletionSignal = iterationResult.completionSignal;
        break;
      }
    }

    const completion = buildCompletionMessage(
      matchedCompletionSignal,
      allIterations.length,
    );
    await Effect.runPromise(
      display.status(completion.message, completion.severity as Severity),
    );
    for (const line of buildContextWindowLines(allIterations)) {
      await Effect.runPromise(display.text(line));
    }

    emitRunEvent({
      type: "run-finished",
      completionSignal: matchedCompletionSignal,
      iterationsRun: allIterations.length,
      timestamp: new Date(),
    });

    result = {
      repositories: Object.fromEntries(
        prepared.map((repo) => [
          repo.name,
          {
            branch: repo.branch ?? repo.worktreeBranch,
            worktreePath: repo.worktreePath,
            commits: repo.commits,
          },
        ]),
      ),
      stdout: allStdout,
      iterations: allIterations,
      completionSignal: matchedCompletionSignal,
      logFilePath: displayConfig.logFilePath,
    };
  } catch (error) {
    caught = error;
    emitRunEvent({
      type: "run-failed",
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date(),
    });
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    const forcePreserve = caught !== undefined;
    for (const repo of [...prepared].reverse()) {
      await cleanupRepository(repo, forcePreserve).catch((error) => {
        if (caught === undefined) {
          caught = error;
        }
      });
    }
  }

  if (caught !== undefined) {
    throw caught;
  }

  if (result === undefined) {
    throw new Error("runWorkspace failed before producing a result");
  }

  return {
    ...result,
    repositories: Object.fromEntries(
      Object.entries(result.repositories).map(([name, repoResult]) => {
        const repo = prepared.find((candidate) => candidate.name === name)!;
        return [
          name,
          {
            ...repoResult,
            ...(repo.preservedWorktreePath
              ? { preservedWorktreePath: repo.preservedWorktreePath }
              : {}),
          },
        ];
      }),
    ),
  };
}
