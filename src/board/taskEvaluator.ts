import type { AgentProvider } from "../AgentProvider.js";
import { Output } from "../Output.js";
import { run, type LoggingOption, type Timeouts } from "../run.js";
import type { RuntimeEvent } from "../RuntimeEvent.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import type { WorkspaceTaskRepositoryResult } from "../runWorkspaceTask.js";
import type { BoardTaskRecord } from "./BoardStore.js";
import {
  DEFAULT_ROLE_PROFILES,
  renderRoleProfilePromptSection,
  type RoleProfile,
} from "./roleProfiles.js";
import type { TaskProgressRun } from "./taskProgress.js";
import type {
  BoardTaskVerificationReport,
  BoardTaskVerificationRepositorySummary,
  BoardTaskVerificationStatus,
} from "./taskVerification.js";

export const BOARD_EVALUATOR_REPO = "(evaluator)";
export const BOARD_EVALUATION_TAG = "board_evaluation";

export interface BoardTaskEvaluationInput {
  readonly task: BoardTaskRecord;
  readonly repositoryResults: Record<string, WorkspaceTaskRepositoryResult>;
  readonly runs: readonly TaskProgressRun[];
  readonly deterministicReport: BoardTaskVerificationReport;
  readonly deterministicMarkdown: string;
  readonly progressMarkdown?: string;
  readonly signal: AbortSignal;
}

export interface BoardTaskEvaluationResult {
  readonly status: BoardTaskVerificationStatus;
  readonly markdown: string;
  readonly repositoryStatuses?: Partial<
    Record<string, BoardTaskVerificationRepositorySummary["issueStatus"]>
  >;
}

export type BoardTaskEvaluator = (
  input: BoardTaskEvaluationInput,
) => Promise<BoardTaskEvaluationResult>;

interface ParsedBoardEvaluation {
  readonly status: BoardTaskVerificationStatus;
  readonly summary?: string;
  readonly markdown?: string;
  readonly repositories?: readonly {
    readonly name: string;
    readonly status?: BoardTaskVerificationRepositorySummary["issueStatus"];
    readonly notes?: string;
  }[];
}

const VERIFICATION_STATUSES = new Set<BoardTaskVerificationStatus>([
  "passed",
  "failed",
  "needs-recovery",
  "needs-verification",
  "infra-warning",
]);

const ISSUE_STATUSES = new Set<
  BoardTaskVerificationRepositorySummary["issueStatus"]
>([
  "succeeded",
  "needs-recovery",
  "needs-verification",
  "verification-failed",
  "infra-warning",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseRepositoryStatuses = (
  value: unknown,
): BoardTaskEvaluationResult["repositoryStatuses"] => {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<
    readonly [string, BoardTaskVerificationRepositorySummary["issueStatus"]]
  > = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const { name, status } = item;
    if (
      typeof name === "string" &&
      typeof status === "string" &&
      ISSUE_STATUSES.has(
        status as BoardTaskVerificationRepositorySummary["issueStatus"],
      )
    ) {
      entries.push([
        name,
        status as BoardTaskVerificationRepositorySummary["issueStatus"],
      ]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const parseBoardEvaluatorOutput = (
  output: string,
): BoardTaskEvaluationResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Evaluator emitted invalid <${BOARD_EVALUATION_TAG}> JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error(
      `Evaluator <${BOARD_EVALUATION_TAG}> JSON must be an object.`,
    );
  }
  const status = parsed.status;
  if (
    typeof status !== "string" ||
    !VERIFICATION_STATUSES.has(status as BoardTaskVerificationStatus)
  ) {
    throw new Error(
      `Evaluator <${BOARD_EVALUATION_TAG}> JSON must include a valid status.`,
    );
  }
  const evaluation = parsed as unknown as ParsedBoardEvaluation;
  const markdown =
    typeof evaluation.markdown === "string" && evaluation.markdown.trim()
      ? evaluation.markdown.trim()
      : typeof evaluation.summary === "string" && evaluation.summary.trim()
        ? evaluation.summary.trim()
        : "Evaluator completed without a written review.";
  return {
    status: status as BoardTaskVerificationStatus,
    markdown,
    ...(parseRepositoryStatuses(evaluation.repositories)
      ? { repositoryStatuses: parseRepositoryStatuses(evaluation.repositories) }
      : {}),
  };
};

const compactRuntimeEvents = (runs: readonly TaskProgressRun[]) =>
  runs.map(({ run, events }) => ({
    run: {
      id: run.id,
      repo: run.repo,
      status: run.status,
      branch: run.branch,
      commits: run.commits,
      completionSignal: run.completionSignal,
      error: run.error,
    },
    events: events.map((record) => record.event),
  }));

export const repositoryAgentWorkWasRecorded = (
  runs: readonly TaskProgressRun[],
  repositoryResults: Record<string, WorkspaceTaskRepositoryResult>,
): boolean => {
  if (
    Object.values(repositoryResults).some(
      (result) =>
        (result.stdout?.trim() ?? "") !== "" || result.commits.length > 0,
    )
  ) {
    return true;
  }
  // Lifecycle events (run.started, iteration.started, run.error) are emitted
  // before the sandbox/agent produces anything, so they are not agent work --
  // only events carrying agent output or commits count as delivery evidence.
  return runs.some(({ events }) =>
    events.some((record) =>
      [
        "message.delta",
        "tool.call",
        "commit.created",
        "usage.recorded",
      ].includes(record.event.type),
    ),
  );
};

export const buildBoardEvaluatorPrompt = (
  input: Omit<BoardTaskEvaluationInput, "signal">,
  roleProfile: RoleProfile = DEFAULT_ROLE_PROFILES.evaluator,
): string => `# Sandcastle Board Evaluator

${renderRoleProfilePromptSection(roleProfile)}

You verify delivery only. Do not re-plan, do not regenerate Board issues, do not edit files, do not run implementation commands, and do not commit. Judge the approved plan against recorded evidence. If evidence is missing, say so clearly instead of assuming delivery worked.

Allowed statuses:
- passed: recorded evidence proves the approved plan and PRD acceptance criteria were delivered.
- needs-verification: implementation may be present, but recorded acceptance evidence is incomplete.
- needs-recovery: execution results or artifacts are missing and the Generator must recover from stored progress.
- infra-warning: delivery evidence exists, but Sandcastle capture/session infrastructure failed.
- failed: recorded evidence contradicts delivery or the Evaluator cannot complete a trustworthy review.

Original PRD / task prompt:
${input.task.prompt}

Approved Board plan:
${JSON.stringify(input.task.plan ?? input.deterministicReport.repositories, null, 2)}

Board progress document:
${input.progressMarkdown ?? "No Board progress document was available."}

Repository execution results:
${JSON.stringify(input.repositoryResults, null, 2)}

Repository runtime events:
${JSON.stringify(compactRuntimeEvents(input.runs), null, 2)}

Deterministic structured evidence:
${input.deterministicMarkdown}

Return only JSON inside this exact tag:
<${BOARD_EVALUATION_TAG}>
{
  "status": "passed | needs-verification | needs-recovery | infra-warning | failed",
  "summary": "short evaluator conclusion",
  "markdown": "markdown review explaining evidence, gaps, and next action",
  "repositories": [
    {
      "name": "repository name",
      "status": "succeeded | needs-recovery | needs-verification | verification-failed | infra-warning",
      "notes": "short evidence note"
    }
  ]
}
</${BOARD_EVALUATION_TAG}>

When complete, output <promise>COMPLETE</promise>.`;

export const renderEvaluatedVerificationMarkdown = (args: {
  readonly task: Pick<BoardTaskRecord, "id" | "title">;
  readonly status: BoardTaskVerificationStatus;
  readonly deterministicMarkdown: string;
  readonly evaluator:
    | { readonly kind: "completed"; readonly markdown: string }
    | { readonly kind: "failed"; readonly error: string }
    | { readonly kind: "skipped"; readonly reason: string };
  readonly now?: Date;
}): string => {
  const generatedAt = (args.now ?? new Date()).toISOString();
  const evaluatorMarkdown =
    args.evaluator.kind === "completed"
      ? args.evaluator.markdown
      : args.evaluator.kind === "failed"
        ? `Evaluator agent failed: ${args.evaluator.error}`
        : `Evaluator agent skipped: ${args.evaluator.reason}`;
  return `# Board Verification Report

Task: ${args.task.title}
Task ID: ${args.task.id}
Board role: Evaluator
Status: ${args.status}
Generated: ${generatedAt}
Evaluator agent: ${args.evaluator.kind}

## Evaluator output
${evaluatorMarkdown}

## Deterministic structured evidence
${args.deterministicMarkdown}
`;
};

export const runBoardEvaluatorAgent = async (args: {
  readonly cwd: string;
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly branch: string;
  readonly input: Omit<BoardTaskEvaluationInput, "signal">;
  readonly signal: AbortSignal;
  readonly logging?: LoggingOption;
  readonly idleTimeoutSeconds?: number;
  readonly timeouts?: Timeouts;
  readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
  readonly roleProfile?: RoleProfile;
}): Promise<BoardTaskEvaluationResult> => {
  const result = await run({
    cwd: args.cwd,
    agent: args.agent,
    sandbox: args.sandbox,
    branchStrategy: { type: "branch", branch: args.branch },
    prompt: buildBoardEvaluatorPrompt(args.input, args.roleProfile),
    maxIterations: 1,
    logging: args.logging,
    idleTimeoutSeconds: args.idleTimeoutSeconds,
    timeouts: args.timeouts,
    name: `${args.input.task.title} evaluator`,
    signal: args.signal,
    events: args.onRuntimeEvent
      ? { onRuntimeEvent: args.onRuntimeEvent }
      : undefined,
    output: Output.string({ tag: BOARD_EVALUATION_TAG }),
  });
  return parseBoardEvaluatorOutput(result.output);
};
