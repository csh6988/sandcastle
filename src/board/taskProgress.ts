import type {
  BoardRuntimeEventRecord,
  BoardRunRecord,
  BoardTaskPlan,
  BoardTaskRecord,
} from "./BoardStore.js";
import type { LocalIssueStatus } from "./localIssueMarkdown.js";

export interface TaskProgressRun {
  readonly run: BoardRunRecord;
  readonly events: readonly BoardRuntimeEventRecord[];
}

const MAX_DIGEST_ITEMS = 8;
const MAX_INLINE_CHARS = 220;

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, max = MAX_INLINE_CHARS): string => {
  const normalized = oneLine(value);
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 1))}…`
    : normalized;
};

const bulletList = (items: readonly string[], empty: string): string =>
  (items.length > 0 ? items : [empty]).map((item) => `- ${item}`).join("\n");

const repoStatus = (run: BoardRunRecord | undefined): string => {
  if (!run) return "pending";
  if (run.status === "running") return "in_progress";
  if (run.status === "succeeded") return "succeeded";
  return "needs_recovery";
};

export const issueStatusForRun = (
  run: BoardRunRecord | undefined,
): LocalIssueStatus => {
  if (!run) return "ready-for-agent";
  if (run.status === "running") return "in-progress";
  if (run.status === "succeeded") return "succeeded";
  return "needs-recovery";
};

const approvedWorkLines = (repo: BoardTaskPlan["repositories"][number]) => {
  const lines = [`Task: ${repo.task}`];
  if (repo.reason) lines.push(`Reason: ${repo.reason}`);
  if (repo.issue) {
    lines.push(`Issue: ${repo.issue.title}`);
    lines.push(repo.issue.body);
  }
  return lines;
};

const eventTimestamp = (record: BoardRuntimeEventRecord): string =>
  "timestamp" in record.event && typeof record.event.timestamp === "string"
    ? record.event.timestamp
    : "unknown-time";

const digestLine = (record: BoardRuntimeEventRecord): string | undefined => {
  const event = record.event;
  const prefix = `[${eventTimestamp(record)}]`;
  switch (event.type) {
    case "message.delta":
      return `${prefix} agent text: ${truncate(event.text)}`;
    case "tool.call":
      return `${prefix} tool call: ${event.name} ${truncate(event.args)}`;
    case "tool.result":
      return `${prefix} tool result: ${truncate(event.content)}`;
    case "commit.created":
      return `${prefix} commit: ${event.sha}`;
    case "run.error":
      return `${prefix} run failed: ${truncate(event.message)}`;
    case "run.finished":
      return `${prefix} run finished after ${event.iterationsRun} iteration${event.iterationsRun === 1 ? "" : "s"}`;
    default:
      return undefined;
  }
};

const completedEvidence = (
  run: BoardRunRecord | undefined,
  events: readonly BoardRuntimeEventRecord[],
): string[] => {
  if (!run) return [];
  const evidence = events
    .map((record) => {
      const event = record.event;
      if (event.type === "commit.created") return `Commit ${event.sha}`;
      if (event.type === "run.finished") {
        return `Run ${run.id} finished successfully after ${event.iterationsRun} iteration${event.iterationsRun === 1 ? "" : "s"}.`;
      }
      return undefined;
    })
    .filter((item): item is string => item !== undefined);
  if (run.status === "succeeded" && evidence.length === 0) {
    evidence.push(`Run ${run.id} succeeded.`);
  }
  return evidence;
};

const failureKindLabel: Record<string, string> = {
  infrastructure: "infrastructure failure (environment, not the task)",
  agent: "agent failure",
  task: "task failure",
  unknown: "unclassified failure",
};

/**
 * Board-specific recovery wording projected from the generic
 * `RunFailureRecovery` evidence carried on the latest `run.error` event.
 * Falls back to nothing when recovery evidence is unavailable.
 */
const recoveryEvidenceLines = (
  events: readonly BoardRuntimeEventRecord[],
): string[] => {
  const failed = [...events]
    .reverse()
    .map((record) => record.event)
    .find((event) => event.type === "run.error");
  if (!failed || failed.type !== "run.error") return [];
  const recovery = failed.recovery;
  if (!recovery) return [];

  const lines: string[] = [];
  const label = failureKindLabel[recovery.failureKind];
  if (label) lines.push(`Failure kind: ${label}.`);
  if (recovery.failurePhase) {
    lines.push(`Failure phase: ${recovery.failurePhase}.`);
  }
  if (recovery.preservedWorktreePath) {
    lines.push(
      `Preserved worktree to inspect or continue: ${recovery.preservedWorktreePath}`,
    );
  }
  if (recovery.runLogPath) {
    lines.push(`Run log for full context: ${recovery.runLogPath}`);
  }
  if (recovery.sessionId) {
    lines.push(
      `Agent session id${recovery.sessionFilePath ? ` (${recovery.sessionFilePath})` : ""}: ${recovery.sessionId}`,
    );
  }
  if (recovery.commits && recovery.commits.length > 0) {
    lines.push(
      `Commits recorded before failure: ${recovery.commits.join(", ")}`,
    );
  }
  if (recovery.completionSignalSeen !== undefined) {
    lines.push(
      recovery.completionSignalSeen
        ? "The agent claimed completion before the failure — verify delivered work before recovering."
        : "The agent did not claim completion before the failure.",
    );
  }
  return lines;
};

const currentNextStep = (
  run: BoardRunRecord | undefined,
  events: readonly BoardRuntimeEventRecord[],
): string[] => {
  if (!run) return ["Start this repository's approved work."];
  if (run.status === "succeeded") {
    return ["No action required unless later verification finds a regression."];
  }
  if (run.status === "failed") {
    return [
      "Inspect the existing branch/worktree and continue from the last activity digest.",
      run.error ? `Address the last failure: ${truncate(run.error)}` : "",
      ...recoveryEvidenceLines(events),
    ].filter(Boolean);
  }
  const latestDigest = [...events].reverse().map(digestLine).find(Boolean);
  return [
    latestDigest
      ? `Continue after latest activity: ${latestDigest}`
      : "Continue the in-progress repository task.",
  ];
};

const latestRunForRepo = (
  repoName: string,
  runs: readonly TaskProgressRun[],
): { readonly latest?: TaskProgressRun; readonly attempt: number } => {
  const repoRuns = runs
    .filter(({ run }) => run.repo === repoName)
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  return repoRuns[0]
    ? { latest: repoRuns[0], attempt: repoRuns.length }
    : { attempt: 0 };
};

export const renderTaskProgress = (
  task: BoardTaskRecord,
  runs: readonly TaskProgressRun[],
  now: Date = new Date(),
): string | undefined => {
  if (!task.plan) return undefined;
  const sections = task.plan.repositories.map((repo) => {
    const { latest, attempt } = latestRunForRepo(repo.name, runs);
    const run = latest?.run;
    const events = latest?.events ?? [];
    const digest = events
      .map(digestLine)
      .filter((line): line is string => line !== undefined);
    const lastDigest = digest.slice(-MAX_DIGEST_ITEMS);
    return `## Repository: ${repo.name}
Issue status: ${issueStatusForRun(run)}
Status: ${repoStatus(run)}
Run ID: ${run?.id ?? "not-started"}
Branch: ${run?.branch ?? "not-started"}
Attempt: ${attempt}

### Approved Work
${approvedWorkLines(repo).join("\n")}

### Completed Evidence
${bulletList(completedEvidence(run, events), "No completed evidence recorded yet.")}

### Current/Next Step
${bulletList(currentNextStep(run, events), "Continue the approved repository task.")}

### Last Activity Digest
${bulletList(lastDigest, "No run activity recorded yet.")}`;
  });

  return `# Board Execution Progress

Task: ${task.title}
Task ID: ${task.id}
Phase: ${task.workflow?.currentPhase ?? task.workflow?.status ?? task.status}
Updated: ${now.toISOString()}

## Recovery Instructions
- Continue from this document, not from model session state.
- Inspect existing branch/worktree/diff before editing.
- Do not re-plan or regenerate Board issues.
- Do not redo repositories marked succeeded unless verification proves they regressed.
- Continue repositories marked in_progress, needs_recovery, or pending.

${sections.join("\n\n")}
`;
};
