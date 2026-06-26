import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { resolve } from "node:path";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay } from "./Display.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
} from "./PromptArgumentSubstitution.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  run,
  type LoggingOption,
  type RunResult,
  type Timeouts,
} from "./run.js";
import {
  runWorkspace,
  type WorkspaceRepositoryOptions,
} from "./runWorkspace.js";
import type { RunEvent } from "./RunEvent.js";
import type { BranchStrategy, SandboxProvider } from "./SandboxProvider.js";

export interface WorkspaceTaskRepositoryOptions extends Omit<
  WorkspaceRepositoryOptions,
  "branchStrategy"
> {
  readonly kind?: string;
  readonly description?: string;
  readonly branchStrategy?: Exclude<BranchStrategy, { type: "head" }>;
}

export interface WorkspaceTaskPlanRepository {
  readonly name: string;
  readonly task: string;
  readonly reason?: string;
  readonly issue?: WorkspaceTaskIssue;
}

export interface WorkspaceTaskIssue {
  readonly title: string;
  readonly body: string;
}

export type WorkspaceTaskWorkspaceRepositoryOptions = Omit<
  WorkspaceTaskRepositoryOptions,
  "hooks"
>;

export interface WorkspaceTaskWorkspace {
  readonly repositories: ReadonlyArray<WorkspaceTaskWorkspaceRepositoryOptions>;
  readonly branchPrefix?: string;
  readonly maxIterations?: number;
}

export interface WorkspaceTaskAlignment {
  readonly summary?: string;
  readonly assumptions?: ReadonlyArray<string>;
  readonly openQuestions?: ReadonlyArray<string>;
  readonly domainTerms?: ReadonlyArray<{
    readonly term: string;
    readonly meaning: string;
  }>;
  readonly adrCandidates?: ReadonlyArray<{
    readonly title: string;
    readonly reason: string;
  }>;
}

export interface WorkspaceTaskPlan {
  readonly alignment?: WorkspaceTaskAlignment;
  readonly technicalPlan?: string;
  readonly workspace?: WorkspaceTaskWorkspace;
  readonly repositories: ReadonlyArray<WorkspaceTaskPlanRepository>;
}

export interface WorkspaceTaskRepositoryResult {
  readonly task: string;
  readonly reason?: string;
  readonly status: "success" | "failed";
  readonly branch: string;
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
  readonly stdout?: string;
  readonly preservedWorktreePath?: string;
  readonly error?: string;
}

export interface RunWorkspaceTaskOptions<
  A extends AgentProvider = AgentProvider,
> {
  readonly repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
  readonly agent: A;
  readonly plannerAgent?: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly branchPrefix?: string;
  readonly maxIterations?: number;
  readonly plannerMaxIterations?: number;
  readonly logging?: LoggingOption;
  readonly name?: string;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly timeouts?: Timeouts;
  readonly dryRun?: boolean;
  /**
   * Let the planner return a task-scoped workspace snapshot that determines
   * which repositories are executed. Used by the board PRD flow where the
   * workspace is a planning output rather than a pre-existing config file.
   */
  readonly allowPlannerWorkspace?: boolean;
  /**
   * Optional callback invoked for each structured run event produced while
   * executing a repository's task, tagged with the repository name. Lets a
   * caller (e.g. the workflow board) record per-repo runs as they happen.
   */
  readonly onRepoRunEvent?: (repo: string, event: RunEvent) => void;
  /**
   * Optional callback invoked for each structured run event produced by the
   * planner phase. Lets a caller surface planning progress as its own run.
   */
  readonly onPlannerRunEvent?: (event: RunEvent) => void;
  /**
   * Optional callback invoked with the extracted plan as soon as planning
   * completes, before execution begins. Lets a caller display the plan while
   * the per-repo runs are still in flight.
   */
  readonly onPlan?: (plan: WorkspaceTaskPlan) => void;
}

export interface RunWorkspaceTaskResult {
  readonly plan: WorkspaceTaskPlan;
  readonly repositories: Record<string, WorkspaceTaskRepositoryResult>;
  readonly plannerStdout: string;
}

export interface ExecuteWorkspaceTaskPlanOptions<
  A extends AgentProvider = AgentProvider,
> {
  readonly repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>;
  readonly plan: WorkspaceTaskPlan;
  readonly taskPrompt?: string;
  readonly agent: A;
  readonly sandbox: SandboxProvider;
  readonly branchPrefix?: string;
  readonly maxIterations?: number;
  readonly logging?: LoggingOption;
  readonly name?: string;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly timeouts?: Timeouts;
  /** Optional per-repo run-event callback (see RunWorkspaceTaskOptions.onRepoRunEvent). */
  readonly onRepoRunEvent?: (repo: string, event: RunEvent) => void;
}

const WORKSPACE_PLAN_TAG = "workspace_plan";

const displayLayer = ClackDisplay.layer;

const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const sanitizeBranchSegment = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/+/g, "/");
  return sanitized || "workspace-task";
};

const defaultBranchFor = (
  branchPrefix: string | undefined,
  repoName: string,
): string => {
  const prefix = sanitizeBranchSegment(branchPrefix ?? "codex/workspace-task");
  return `${prefix}/${sanitizeBranchSegment(repoName)}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const preservedWorktreePath = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { preservedWorktreePath?: unknown })
    .preservedWorktreePath;
  return typeof value === "string" ? value : undefined;
};

const snapshotWorkspace = (
  options: Pick<
    RunWorkspaceTaskOptions,
    "repositories" | "branchPrefix" | "maxIterations"
  >,
): WorkspaceTaskWorkspace => ({
  repositories: options.repositories.map((repo) => ({
    name: repo.name,
    cwd: repo.cwd,
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(repo.description ? { description: repo.description } : {}),
    ...(repo.copyToWorktree ? { copyToWorktree: repo.copyToWorktree } : {}),
    ...(repo.branchStrategy ? { branchStrategy: repo.branchStrategy } : {}),
  })),
  ...(options.branchPrefix ? { branchPrefix: options.branchPrefix } : {}),
  ...(options.maxIterations !== undefined
    ? { maxIterations: options.maxIterations }
    : {}),
});

interface ParsedPlannerWorkspace {
  readonly workspace: WorkspaceTaskWorkspace;
  readonly repositories: WorkspaceTaskRepositoryOptions[];
}

const parsePlannerWorkspace = (
  value: unknown,
  baseDir: string,
): ParsedPlannerWorkspace | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Planner workspace must be an object");
  }

  const input = value as {
    repositories?: unknown;
    branchPrefix?: unknown;
    maxIterations?: unknown;
  };
  if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
    throw new Error("Planner workspace must include repositories");
  }

  const names = new Set<string>();
  const repositories = input.repositories.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `Planner workspace repository at index ${index} must be an object`,
      );
    }
    const repo = entry as {
      name?: unknown;
      cwd?: unknown;
      kind?: unknown;
      description?: unknown;
      copyToWorktree?: unknown;
      branchStrategy?: unknown;
    };
    if (typeof repo.name !== "string" || !repo.name.trim()) {
      throw new Error(
        `Planner workspace repository at index ${index} must include a name`,
      );
    }
    if (names.has(repo.name)) {
      throw new Error(
        `Planner workspace has duplicate repository "${repo.name}"`,
      );
    }
    names.add(repo.name);
    if (typeof repo.cwd !== "string" || !repo.cwd.trim()) {
      throw new Error(
        `Planner workspace repository "${repo.name}" must include a cwd`,
      );
    }
    if (
      repo.copyToWorktree !== undefined &&
      (!Array.isArray(repo.copyToWorktree) ||
        repo.copyToWorktree.some((item: unknown) => typeof item !== "string"))
    ) {
      throw new Error(
        `Planner workspace repository "${repo.name}" copyToWorktree must be an array of strings`,
      );
    }

    return {
      name: repo.name,
      cwd: resolve(baseDir, repo.cwd),
      ...(typeof repo.kind === "string" ? { kind: repo.kind } : {}),
      ...(typeof repo.description === "string"
        ? { description: repo.description }
        : {}),
      ...(Array.isArray(repo.copyToWorktree)
        ? { copyToWorktree: repo.copyToWorktree as string[] }
        : {}),
      ...(typeof repo.branchStrategy === "object" &&
      repo.branchStrategy !== null
        ? {
            branchStrategy:
              repo.branchStrategy as WorkspaceTaskRepositoryOptions["branchStrategy"],
          }
        : {}),
    } satisfies WorkspaceTaskRepositoryOptions;
  });

  return {
    workspace: {
      repositories: repositories.map((repo) => ({
        name: repo.name,
        cwd: repo.cwd,
        ...(repo.kind ? { kind: repo.kind } : {}),
        ...(repo.description ? { description: repo.description } : {}),
        ...(repo.copyToWorktree ? { copyToWorktree: repo.copyToWorktree } : {}),
        ...(repo.branchStrategy ? { branchStrategy: repo.branchStrategy } : {}),
      })),
      ...(typeof input.branchPrefix === "string" && input.branchPrefix.trim()
        ? { branchPrefix: input.branchPrefix }
        : {}),
      ...(typeof input.maxIterations === "number"
        ? { maxIterations: input.maxIterations }
        : {}),
    },
    repositories,
  };
};

const attachWorkspaceSnapshot = (
  plan: WorkspaceTaskPlan,
  options: Pick<
    RunWorkspaceTaskOptions,
    "repositories" | "branchPrefix" | "maxIterations"
  >,
): WorkspaceTaskPlan => ({
  ...plan,
  workspace: snapshotWorkspace(options),
});

const resolveTaskPrompt = async (
  options: Pick<
    RunWorkspaceTaskOptions,
    "prompt" | "promptFile" | "promptArgs"
  >,
): Promise<string> => {
  const resolved = await Effect.runPromise(
    resolvePrompt({
      prompt: options.prompt,
      promptFile: options.promptFile,
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  if (resolved.source === "inline") {
    await runEffect(
      validateNoArgsWithInlinePrompt(options.promptArgs ?? {}),
      displayLayer,
    );
    return resolved.text;
  }

  return runEffect(
    substitutePromptArgs(resolved.text, options.promptArgs ?? {}, new Set()),
    displayLayer,
  );
};

const buildPlannerPrompt = (
  taskPrompt: string,
  repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>,
  allowPlannerWorkspace = false,
): string => {
  const repoLines = repositories
    .map((repo) => {
      const metadata = [
        repo.kind ? `kind=${repo.kind}` : undefined,
        repo.description ? `description=${repo.description}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${repo.name}: ${repo.cwd}${metadata ? ` (${metadata})` : ""}`;
    })
    .join("\n");

  const workspaceInstructions = allowPlannerWorkspace
    ? `
Also determine the task workspace. Include a "workspace" object in the plan. It is a task-scoped workspace snapshot, equivalent to workspace.json, and must not assume a project-level .sandcastle/workspace.json already exists.

The workspace shape is:

"workspace": {
  "repositories": [
    {
      "name": "repository-name",
      "cwd": "absolute or relative path from the primary planning repository",
      "kind": "optional repository kind",
      "description": "optional repository description"
    }
  ],
  "branchPrefix": "optional branch prefix",
  "maxIterations": 1
}
`
    : "";

  return `# Sandcastle workspace task planner

You are planning a multi-repository coding task. Analyze the product requirements document or user request and candidate repositories, then produce product alignment notes, a technical plan, and repository-local implementation issues.

Do not modify files. Do not commit. Return only a machine-readable plan inside <${WORKSPACE_PLAN_TAG}>. This is an automatic pipeline, so do not ask the user follow-up questions. When the PRD is ambiguous, make the safest explicit assumption and record it in alignment.assumptions. Only leave alignment.openQuestions for issues that truly block implementation.
${workspaceInstructions}

Product requirements document or user request:
${taskPrompt}

Candidate repositories:
${repoLines}

Return this exact shape:

<${WORKSPACE_PLAN_TAG}>
{
  "alignment": {
    "summary": "short aligned interpretation of the PRD",
    "assumptions": ["recommended assumption used to keep the pipeline moving"],
    "openQuestions": ["blocking question, only if implementation cannot proceed safely"],
    "domainTerms": [
      { "term": "canonical term", "meaning": "domain meaning without implementation detail" }
    ],
    "adrCandidates": [
      { "title": "decision worth recording later", "reason": "why this is hard to reverse, surprising, and trade-off driven" }
    ]
  },
  "technicalPlan": "technical approach, affected contracts, sequencing, risks, and verification strategy",
  "repositories": [
    {
      "name": "repository-name-from-candidates",
      "task": "specific implementation task for this repository",
      "reason": "why this repository is affected",
      "issue": {
        "title": "short repository-local issue title",
        "body": "agent-ready markdown issue body with Status: ready-for-agent, What to build, Acceptance criteria, and Verification sections"
      }
    }
  ]
}
</${WORKSPACE_PLAN_TAG}>

Rules:
- Include only repositories that need code changes.
- Use repository names exactly as listed.
- Keep each task and issue scoped to one repository.
- Perform product alignment first using explicit assumptions instead of stopping for interactive clarification.
- The technical plan should explain the cross-repository design before splitting work.
- Each issue must be independently executable by an agent working only in that repository.
- If no repositories need changes, return { "repositories": [] }.

When complete, output <promise>COMPLETE</promise>.`;
};

const extractWorkspaceTaskPlan = (
  stdout: string,
  repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>,
  options: {
    readonly allowPlannerWorkspace?: boolean;
    readonly workspaceBaseDir?: string;
  } = {},
): {
  readonly plan: WorkspaceTaskPlan;
  readonly repositories: ReadonlyArray<WorkspaceTaskRepositoryOptions>;
  readonly workspaceBranchPrefix?: string;
  readonly workspaceMaxIterations?: number;
} => {
  const match = stdout.match(
    new RegExp(
      `<${WORKSPACE_PLAN_TAG}>\\s*([\\s\\S]*?)\\s*</${WORKSPACE_PLAN_TAG}>`,
    ),
  );
  if (!match?.[1]) {
    throw new Error(`Planner did not emit <${WORKSPACE_PLAN_TAG}> JSON`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(
      `Planner emitted invalid <${WORKSPACE_PLAN_TAG}> JSON: ${errorMessage(error)}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { repositories?: unknown }).repositories)
  ) {
    throw new Error(
      `Planner <${WORKSPACE_PLAN_TAG}> JSON must contain a repositories array`,
    );
  }

  const plannerWorkspace = options.allowPlannerWorkspace
    ? parsePlannerWorkspace(
        (parsed as { workspace?: unknown }).workspace,
        options.workspaceBaseDir ?? repositories[0]?.cwd ?? process.cwd(),
      )
    : undefined;
  const executionRepositories = plannerWorkspace?.repositories ?? repositories;
  const knownNames = new Set(executionRepositories.map((repo) => repo.name));
  const alignment = parseAlignment(
    (parsed as { alignment?: unknown }).alignment,
  );
  const technicalPlan =
    typeof (parsed as { technicalPlan?: unknown }).technicalPlan === "string" &&
    (parsed as { technicalPlan?: string }).technicalPlan!.trim()
      ? (parsed as { technicalPlan: string }).technicalPlan
      : undefined;
  const planned = (parsed as { repositories: unknown[] }).repositories.map(
    (entry): WorkspaceTaskPlanRepository => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("Planner repository entries must be objects");
      }
      const repo = entry as {
        name?: unknown;
        task?: unknown;
        reason?: unknown;
        issue?: unknown;
      };
      if (typeof repo.name !== "string" || !knownNames.has(repo.name)) {
        throw new Error(`Planner referenced unknown repository "${repo.name}"`);
      }
      if (typeof repo.task !== "string" || repo.task.trim() === "") {
        throw new Error(
          `Planner entry for repository "${repo.name}" must include a task`,
        );
      }
      let issue: WorkspaceTaskIssue | undefined;
      if (repo.issue !== undefined) {
        if (typeof repo.issue !== "object" || repo.issue === null) {
          throw new Error(
            `Planner issue for repository "${repo.name}" must be an object`,
          );
        }
        const candidate = repo.issue as { title?: unknown; body?: unknown };
        if (
          typeof candidate.title !== "string" ||
          candidate.title.trim() === ""
        ) {
          throw new Error(
            `Planner issue for repository "${repo.name}" must include a title`,
          );
        }
        if (
          typeof candidate.body !== "string" ||
          candidate.body.trim() === ""
        ) {
          throw new Error(
            `Planner issue for repository "${repo.name}" must include a body`,
          );
        }
        issue = { title: candidate.title, body: candidate.body };
      }

      return {
        name: repo.name,
        task: repo.task,
        ...(typeof repo.reason === "string" && repo.reason.trim()
          ? { reason: repo.reason }
          : {}),
        ...(issue ? { issue } : {}),
      };
    },
  );

  const duplicate = planned.find(
    (entry, index) =>
      planned.findIndex((candidate) => candidate.name === entry.name) !== index,
  );
  if (duplicate) {
    throw new Error(
      `Planner returned duplicate repository "${duplicate.name}"`,
    );
  }

  return {
    plan: {
      ...(alignment ? { alignment } : {}),
      ...(technicalPlan ? { technicalPlan } : {}),
      ...(plannerWorkspace ? { workspace: plannerWorkspace.workspace } : {}),
      repositories: planned,
    },
    repositories: executionRepositories,
    workspaceBranchPrefix: plannerWorkspace?.workspace.branchPrefix,
    workspaceMaxIterations: plannerWorkspace?.workspace.maxIterations,
  };
};

const parseStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

const parseAlignment = (value: unknown): WorkspaceTaskAlignment | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Planner alignment must be an object");
  }
  const input = value as {
    summary?: unknown;
    assumptions?: unknown;
    openQuestions?: unknown;
    domainTerms?: unknown;
    adrCandidates?: unknown;
  };
  const domainTerms = Array.isArray(input.domainTerms)
    ? input.domainTerms.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const term = (entry as { term?: unknown }).term;
        const meaning = (entry as { meaning?: unknown }).meaning;
        return typeof term === "string" && typeof meaning === "string"
          ? [{ term, meaning }]
          : [];
      })
    : undefined;
  const adrCandidates = Array.isArray(input.adrCandidates)
    ? input.adrCandidates.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const title = (entry as { title?: unknown }).title;
        const reason = (entry as { reason?: unknown }).reason;
        return typeof title === "string" && typeof reason === "string"
          ? [{ title, reason }]
          : [];
      })
    : undefined;

  return {
    ...(typeof input.summary === "string" && input.summary.trim()
      ? { summary: input.summary }
      : {}),
    ...(parseStringArray(input.assumptions)
      ? { assumptions: parseStringArray(input.assumptions) }
      : {}),
    ...(parseStringArray(input.openQuestions)
      ? { openQuestions: parseStringArray(input.openQuestions) }
      : {}),
    ...(domainTerms ? { domainTerms } : {}),
    ...(adrCandidates ? { adrCandidates } : {}),
  };
};

const buildExecutorPrompt = (options: {
  readonly taskPrompt: string;
  readonly plan: WorkspaceTaskPlan;
  readonly repo: WorkspaceTaskRepositoryOptions;
  readonly planned: WorkspaceTaskPlanRepository;
}): string => `# Sandcastle workspace task executor

Implement the assigned repository task.

Overall user request:
${options.taskPrompt}

Repository:
- name: ${options.repo.name}
- kind: ${options.repo.kind ?? "unspecified"}
- cwd: ${options.repo.cwd}
${options.repo.description ? `- description: ${options.repo.description}\n` : ""}
Assigned task:
${options.planned.task}

Repository issue:
${
  options.planned.issue
    ? `# ${options.planned.issue.title}\n\n${options.planned.issue.body}`
    : "Planner did not provide a separate issue body. Use the assigned task."
}

Reason this repository is affected:
${options.planned.reason ?? "Planner did not provide a reason."}

Full workspace plan:
${JSON.stringify(options.plan, null, 2)}

Product alignment:
${JSON.stringify(options.plan.alignment ?? {}, null, 2)}

Rules:
- Work only in this repository.
- Read and follow the repository's AGENTS.md before editing.
- Keep changes surgical and scoped to the assigned task.
- Add or update focused tests when there is an existing suitable seam.
- Run targeted verification for this repository when feasible.
- Commit the repository changes before finishing.

When complete, output <promise>COMPLETE</promise>.`;

export async function executeWorkspaceTaskPlan(
  options: ExecuteWorkspaceTaskPlanOptions,
): Promise<Record<string, WorkspaceTaskRepositoryResult>> {
  const repoByName = new Map(
    options.repositories.map((repo) => [repo.name, repo]),
  );
  const results = await Promise.all(
    options.plan.repositories.map(async (planned) => {
      const repo = repoByName.get(planned.name);
      if (!repo) {
        throw new Error(
          `Workspace plan referenced unknown repository "${planned.name}"`,
        );
      }
      const branchStrategy =
        repo.branchStrategy ??
        ({
          type: "branch",
          branch: defaultBranchFor(options.branchPrefix, repo.name),
        } satisfies Exclude<BranchStrategy, { type: "head" }>);

      try {
        const runResult: RunResult = await run({
          cwd: repo.cwd,
          agent: options.agent,
          sandbox: options.sandbox,
          branchStrategy,
          copyToWorktree: repo.copyToWorktree,
          hooks: repo.hooks,
          prompt: buildExecutorPrompt({
            taskPrompt:
              options.taskPrompt ?? "Execute the approved workspace plan.",
            plan: options.plan,
            repo,
            planned,
          }),
          maxIterations: options.maxIterations ?? 1,
          logging: options.logging,
          idleTimeoutSeconds: options.idleTimeoutSeconds,
          onRunEvent: options.onRepoRunEvent
            ? (event) => options.onRepoRunEvent!(repo.name, event)
            : undefined,
          name: options.name
            ? `${options.name} ${repo.name}`
            : `workspace ${repo.name}`,
          signal: options.signal,
          timeouts: options.timeouts,
        });
        return [
          repo.name,
          {
            task: planned.task,
            reason: planned.reason,
            status: "success" as const,
            branch: runResult.branch,
            commits: runResult.commits,
            stdout: runResult.stdout,
            preservedWorktreePath: runResult.preservedWorktreePath,
          },
        ] as const;
      } catch (error) {
        return [
          repo.name,
          {
            task: planned.task,
            reason: planned.reason,
            status: "failed" as const,
            branch:
              branchStrategy.type === "branch"
                ? branchStrategy.branch
                : defaultBranchFor(options.branchPrefix, repo.name),
            commits: [],
            error: errorMessage(error),
            preservedWorktreePath: preservedWorktreePath(error),
          },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(results);
}

export async function runWorkspaceTask(
  options: RunWorkspaceTaskOptions,
): Promise<RunWorkspaceTaskResult> {
  if (options.repositories.length === 0) {
    throw new Error("runWorkspaceTask requires at least one repository");
  }

  const taskPrompt = await resolveTaskPrompt(options);
  const planner = await runWorkspace({
    repositories: options.repositories.map((repo) => ({
      name: repo.name,
      cwd: repo.cwd,
      copyToWorktree: repo.copyToWorktree,
      hooks: repo.hooks,
    })),
    primaryRepository: options.repositories[0]!.name,
    agent: options.plannerAgent ?? options.agent,
    sandbox: options.sandbox,
    prompt: buildPlannerPrompt(
      taskPrompt,
      options.repositories,
      options.allowPlannerWorkspace,
    ),
    maxIterations: options.plannerMaxIterations ?? 1,
    logging: options.logging,
    name: options.name ? `${options.name} planner` : "workspace planner",
    idleTimeoutSeconds: options.idleTimeoutSeconds,
    signal: options.signal,
    timeouts: options.timeouts,
    onRunEvent: options.onPlannerRunEvent,
  });

  const extracted = extractWorkspaceTaskPlan(
    planner.stdout,
    options.repositories,
    {
      allowPlannerWorkspace: options.allowPlannerWorkspace,
      workspaceBaseDir: options.repositories[0]!.cwd,
    },
  );
  const executionBranchPrefix =
    options.branchPrefix ?? extracted.workspaceBranchPrefix;
  const executionMaxIterations =
    options.maxIterations ?? extracted.workspaceMaxIterations;
  const plan = attachWorkspaceSnapshot(extracted.plan, {
    repositories: extracted.repositories,
    branchPrefix: executionBranchPrefix,
    maxIterations: executionMaxIterations,
  });
  options.onPlan?.(plan);
  if (options.dryRun) {
    return { plan, repositories: {}, plannerStdout: planner.stdout };
  }

  return {
    plan,
    repositories: await executeWorkspaceTaskPlan({
      repositories: extracted.repositories,
      plan,
      taskPrompt,
      agent: options.agent,
      sandbox: options.sandbox,
      branchPrefix: executionBranchPrefix,
      maxIterations: executionMaxIterations,
      logging: options.logging,
      name: options.name,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      signal: options.signal,
      timeouts: options.timeouts,
      onRepoRunEvent: options.onRepoRunEvent,
    }),
    plannerStdout: planner.stdout,
  };
}
