import type {
  SoftwareDevelopmentExecutionInput,
  SoftwareDevelopmentExecutionPort,
} from "./productionExecutionAdapter.js";
import type { ExecutionFact } from "./scriptedExecutionAdapter.js";
import { resolve, win32 } from "node:path";

export interface SandcastleExecutionRuntime {
  readonly resolveAgent: (
    providerRef: string,
    model: string,
    options?: { readonly captureSessions?: boolean },
  ) => unknown;
  readonly resolveSandbox: (sandboxRef: string) => unknown;
  readonly run: (options: Readonly<Record<string, unknown>>) => Promise<{
    readonly output?: unknown;
    readonly commits?: readonly { readonly sha: string }[];
    readonly stdout?: string;
  }>;
  readonly runWorkspaceTask: (
    options: Readonly<Record<string, unknown>>,
  ) => Promise<{
    readonly plan?: unknown;
    readonly repositories?: Readonly<Record<string, unknown>>;
    readonly plannerStdout?: string;
  }>;
}

const failure = (code: string, message: string): ExecutionFact => ({
  kind: "failed",
  code,
  message,
});

const branchStrategy = (
  value: SoftwareDevelopmentExecutionInput["executionProfile"]["branchStrategy"],
  runId: string,
  nodeRunId: string,
): Record<string, string> =>
  value === "head"
    ? { type: "head" }
    : value === "merge-to-head"
      ? { type: "merge-to-head" }
      : { type: "branch", branch: `sandcastle/${runId}/${nodeRunId}` };

const promptFor = (
  input: SoftwareDevelopmentExecutionInput,
  instruction: string,
): string => {
  const priorEvidence =
    input.attempt.previousResult === null &&
    input.attempt.previousFailure === null &&
    input.attempt.feedback.length === 0
      ? ""
      : `\nPrior Node Attempt evidence:\n${JSON.stringify(
          {
            previousResult: input.attempt.previousResult,
            previousFailure: input.attempt.previousFailure,
            feedback: input.attempt.feedback,
          },
          null,
          2,
        )}\n`;
  return `# Sandcastle Software Development Node

Project goal: ${input.project.goal}
Project context: ${input.project.sharedContext}
Position: ${input.position.name}
Responsibility: ${input.position.responsibility}
AI Member: ${input.aiMember.displayName}
Skill Flow: ${input.skillFlow.name}
Skill Flow instructions:
${input.skillFlow.instructions}

Node instructions:
${input.node.instructions ?? "Follow the declared node contract."}
${priorEvidence}
Task:
${instruction}
`;
};

const repositoryOptions = (input: SoftwareDevelopmentExecutionInput) =>
  input.project.repositoryReferences.map((cwd, index) => ({
    name: `repository-${index + 1}`,
    cwd,
  }));

const repositoryLocks = new Map<string, Promise<void>>();

const repositoryLockKey = (cwd: string): string =>
  win32.isAbsolute(cwd) ? win32.normalize(cwd).toLowerCase() : resolve(cwd);

const withWorkspaceLocks = async <T>(
  sandbox: unknown,
  branchStrategy: SoftwareDevelopmentExecutionInput["executionProfile"]["branchStrategy"],
  repositories: readonly { readonly cwd: string }[],
  work: () => Promise<T>,
): Promise<T> => {
  const tag =
    typeof sandbox === "object" && sandbox !== null && "tag" in sandbox
      ? (sandbox as { readonly tag?: unknown }).tag
      : undefined;
  if (
    (tag === "isolated" && branchStrategy !== "head") ||
    repositories.length === 0
  )
    return work();

  const keys = [
    ...new Set(
      repositories.map((repository) => repositoryLockKey(repository.cwd)),
    ),
  ].sort();
  const releases: (() => void)[] = [];
  try {
    for (const key of keys) {
      const previous = repositoryLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      repositoryLocks.set(key, current);
      await previous;
      releases.push(() => {
        if (repositoryLocks.get(key) === current) repositoryLocks.delete(key);
        release();
      });
    }
    return await work();
  } finally {
    releases.reverse().forEach((release) => release());
  }
};

export const createSandcastleExecutionPort = (
  runtime: SandcastleExecutionRuntime,
): SoftwareDevelopmentExecutionPort => ({
  execute: async (input) => {
    try {
      const agent = runtime.resolveAgent(
        input.executionProfile.providerRef,
        input.executionProfile.model,
      );
      const sandbox = runtime.resolveSandbox(input.executionProfile.sandboxRef);
      const repositories = repositoryOptions(input);
      const common = {
        agent,
        sandbox,
        signal: input.signal,
        branchStrategy: branchStrategy(
          input.executionProfile.branchStrategy,
          input.runId,
          input.nodeRunId,
        ),
        maxIterations: input.executionProfile.limits.maxIterations,
        idleTimeoutSeconds: input.executionProfile.limits.timeoutSeconds,
        completionTimeoutSeconds: input.executionProfile.limits.timeoutSeconds,
        name: `${input.handler}:${input.nodeRunId}`,
      };

      if (input.handler === "product-goal-alignment") {
        const result = await withWorkspaceLocks(
          sandbox,
          input.executionProfile.branchStrategy,
          repositories,
          () =>
            runtime.run({
              ...common,
              cwd: repositories[0]?.cwd,
              prompt: promptFor(
                input,
                "Align the product goal, non-goals, terms, assumptions, and acceptance criteria. Return the JSON result inside <product_alignment>...</product_alignment>.",
              ),
              output: { tag: "product_alignment", schema: "object" },
            }),
        );
        return result.output === undefined
          ? failure(
              "STRUCTURED_OUTPUT_MISSING",
              "Product goal alignment did not return structured output.",
            )
          : { kind: "succeeded", structuredResult: result.output };
      }

      if (input.handler === "technical-plan") {
        if (repositories.length === 0) {
          return failure(
            "REPOSITORY_REFERENCE_REQUIRED",
            "Technical planning requires at least one Repository reference.",
          );
        }
        const result = await withWorkspaceLocks(
          sandbox,
          input.executionProfile.branchStrategy,
          repositories,
          () =>
            runtime.runWorkspaceTask({
              ...common,
              repositories,
              dryRun: true,
              prompt: promptFor(
                input,
                "Analyze the repositories and produce a technical plan with verification evidence.",
              ),
            }),
        );
        return result.plan === undefined
          ? failure(
              "STRUCTURED_OUTPUT_MISSING",
              "Technical planning did not return a Workspace Task plan.",
            )
          : { kind: "succeeded", structuredResult: result.plan };
      }

      if (repositories.length === 0) {
        return failure(
          "REPOSITORY_REFERENCE_REQUIRED",
          `Handler ${input.handler} requires at least one Repository reference.`,
        );
      }
      const outputTag =
        input.handler === "independent-review"
          ? "independent_review"
          : input.handler === "delivery-verification"
            ? "verification_report"
            : undefined;
      const result = await withWorkspaceLocks(
        sandbox,
        input.executionProfile.branchStrategy,
        repositories,
        () =>
          runtime.run({
            ...common,
            cwd: repositories[0]?.cwd,
            prompt: promptFor(
              input,
              input.handler === "repository-implementation"
                ? "Implement the approved technical plan and verify the repository changes."
                : input.handler === "independent-review"
                  ? "Review the implementation independently against the approved plan. Return the JSON result inside <independent_review>...</independent_review>."
                  : "Verify acceptance criteria. Return the JSON result inside <verification_report>...</verification_report>.",
            ),
            ...(outputTag
              ? { output: { tag: outputTag, schema: "object" } }
              : {}),
          }),
      );
      if (outputTag) {
        return result.output === undefined
          ? failure(
              "STRUCTURED_OUTPUT_MISSING",
              `${input.handler} did not return structured output.`,
            )
          : {
              kind: "succeeded",
              structuredResult: result.output,
              artifacts: [
                {
                  type:
                    input.handler === "independent-review"
                      ? "independent-review"
                      : "verification-report",
                  schemaVersion: "1",
                  logicalName: `${input.project.id}-${
                    input.handler === "independent-review"
                      ? "independent-review"
                      : "verification-report"
                  }`,
                  content: JSON.stringify(result.output),
                  status: "produced",
                },
              ],
            };
      }
      return {
        kind: "succeeded",
        structuredResult: {
          commits: result.commits ?? [],
          stdout: result.stdout,
          output: result.output,
        },
      };
    } catch {
      return failure(
        "PRODUCTION_EXECUTION_FAILED",
        `Software Development handler ${input.handler} failed without exposing provider output.`,
      );
    }
  },
});
