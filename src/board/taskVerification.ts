import type { WorkspaceTaskRepositoryResult } from "../runWorkspaceTask.js";
import type { BoardTaskPlan, BoardTaskRecord } from "./BoardStore.js";
import type { TaskProgressRun } from "./taskProgress.js";

export type BoardTaskVerificationStatus =
  | "passed"
  | "failed"
  | "needs-recovery"
  | "needs-verification"
  | "infra-warning";

export type BoardTaskVerificationEvidenceKind =
  | "code-static-check"
  | "local-command"
  | "browser-backend-integration";

export interface BoardTaskVerificationCriterion {
  readonly repository: string;
  readonly source: "acceptance-criteria" | "verification";
  readonly criterion: string;
  readonly evidenceKind: BoardTaskVerificationEvidenceKind;
  readonly status: "verified" | "unverified";
  readonly evidence: string;
  readonly blocker?: string;
}

export interface BoardTaskVerificationRepositorySummary {
  readonly name: string;
  readonly issueStatus:
    | "succeeded"
    | "needs-recovery"
    | "needs-verification"
    | "verification-failed"
    | "infra-warning";
  readonly resultStatus: "success" | "failed" | "missing";
  readonly runStatus: "running" | "succeeded" | "failed" | "missing";
  readonly branch?: string;
  readonly agentClaimedCompletion: boolean;
  readonly commitExists: boolean;
  readonly commits: readonly string[];
  readonly infrastructureFailure: boolean;
  readonly criteria: readonly BoardTaskVerificationCriterion[];
  readonly errors: readonly string[];
}

export interface BoardTaskVerificationReport {
  readonly taskId: string;
  readonly status: BoardTaskVerificationStatus;
  readonly generatedAt: string;
  readonly repositories: readonly BoardTaskVerificationRepositorySummary[];
  readonly criteria: readonly BoardTaskVerificationCriterion[];
  readonly errors: readonly string[];
  readonly infrastructureFailures: readonly string[];
  readonly suggestedNextAction: string;
}

const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

const INFRASTRUCTURE_FAILURE_PATTERNS = [
  /Session capture failed/i,
  /copyFileOut failed/i,
  /transcript capture/i,
  // Sandbox never came up -- the agent had no chance to work.
  /Provider '[^']+' create failed/i,
  /No such image/i,
  /not found locally/i,
  /Cannot connect to the \S+ daemon/i,
];

export const isInfrastructureFailureMessage = (message: string): boolean =>
  INFRASTRUCTURE_FAILURE_PATTERNS.some((pattern) => pattern.test(message));

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const markdownSectionItems = (markdown: string, heading: string): string[] => {
  const items: string[] = [];
  let inSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    const headingMatch = line.match(/^##+\s+(.+?)\s*$/);
    if (headingMatch) {
      inSection = (headingMatch[1] ?? "")
        .toLowerCase()
        .includes(heading.toLowerCase());
      continue;
    }
    if (!inSection) continue;
    const itemMatch = line
      .trim()
      .match(/^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (itemMatch?.[1]) items.push(itemMatch[1].trim());
  }
  return items;
};

const plannedCriteria = (
  repo: BoardTaskPlan["repositories"][number],
): ReadonlyArray<
  Pick<BoardTaskVerificationCriterion, "source" | "criterion">
> => {
  const issueBody = repo.issue?.body ?? "";
  return [
    ...markdownSectionItems(issueBody, "acceptance criteria").map(
      (criterion) => ({
        source: "acceptance-criteria" as const,
        criterion,
      }),
    ),
    ...markdownSectionItems(issueBody, "verification").map((criterion) => ({
      source: "verification" as const,
      criterion,
    })),
  ];
};

const eventText = (run: TaskProgressRun | undefined): string[] =>
  (run?.events ?? []).flatMap((record) => {
    const event = record.event as {
      readonly message?: unknown;
      readonly name?: unknown;
      readonly formattedArgs?: unknown;
      readonly content?: unknown;
      readonly sha?: unknown;
      readonly completionSignal?: unknown;
    };
    return [
      event.message,
      event.name,
      event.formattedArgs,
      event.content,
      event.sha,
      event.completionSignal,
    ].filter((value): value is string => typeof value === "string");
  });

const verificationCorpus = (
  result: WorkspaceTaskRepositoryResult | undefined,
  run: TaskProgressRun | undefined,
): string =>
  [result?.stdout, result?.error, run?.run.error, ...eventText(run)]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

const criterionEvidenceKind = (
  criterion: string,
): BoardTaskVerificationEvidenceKind => {
  const normalized = criterion.toLowerCase();
  if (/复用|不新增|平行实现|existing|代码|code|模式/.test(normalized)) {
    return "code-static-check";
  }
  if (
    /手动|浏览器|browser|playwright|cypress|后端|backend|接口|api|curl|权限|permission|隐藏|禁用|超限|分配|页面|表单|入口|展示|联调|流程/.test(
      normalized,
    )
  ) {
    return "browser-backend-integration";
  }
  if (
    /typecheck|vue-tsc|build|构建|npm|pnpm|yarn|test|vitest|lint|tsc|单元|测试/.test(
      normalized,
    )
  ) {
    return "local-command";
  }
  return "code-static-check";
};

const localCommandEvidence = (
  criterion: string,
  corpus: string,
  result: WorkspaceTaskRepositoryResult | undefined,
): string | undefined => {
  const normalized = criterion.toLowerCase();
  if (
    /build|构建/.test(normalized) &&
    /build|vite build|webpack|构建/.test(corpus)
  ) {
    return "Recorded command output mentions a build and the repository result succeeded.";
  }
  if (
    /typecheck|vue-tsc|tsc/.test(normalized) &&
    /typecheck|vue-tsc|tsc/.test(corpus)
  ) {
    return "Recorded command output mentions type checking and the repository result succeeded.";
  }
  if (
    /test|vitest|单元|测试/.test(normalized) &&
    /test|vitest|jest|单元|测试/.test(corpus)
  ) {
    return "Recorded command output mentions tests and the repository result succeeded.";
  }
  if (result?.status === "success" && /npm|pnpm|yarn/.test(corpus)) {
    return "Recorded package-manager command output and the repository result succeeded.";
  }
  return undefined;
};

const integrationEvidence = (corpus: string): string | undefined =>
  /(?:playwright|cypress)[^\n]*(?:pass|passed|success|succeeded|通过|成功)|(?:^|\s)curl\s+[^\n]*(?:200|201|204|pass|passed|success|succeeded|通过|成功)|(?:manual verification|browser verification|browser test|end-to-end)[^\n]*(?:pass|passed|complete|completed|success|succeeded)|(?:手动验证|浏览器验证|浏览器测试|接口联调|后端联调|端到端)[^\n]*(?:通过|完成|成功|已验证)/.test(
    corpus,
  )
    ? "Recorded output mentions browser, HTTP, or manual integration verification."
    : undefined;

const summarizeCriteria = (
  repo: BoardTaskPlan["repositories"][number],
  result: WorkspaceTaskRepositoryResult | undefined,
  run: TaskProgressRun | undefined,
): BoardTaskVerificationCriterion[] => {
  const corpus = verificationCorpus(result, run);
  const agentCompleted =
    resultClaimedCompletion(result) || eventClaimedCompletion(run);
  return plannedCriteria(repo).map(({ source, criterion }) => {
    const evidenceKind = criterionEvidenceKind(criterion);
    if (evidenceKind === "local-command") {
      const evidence = localCommandEvidence(criterion, corpus, result);
      return {
        repository: repo.name,
        source,
        criterion,
        evidenceKind,
        status: evidence ? "verified" : "unverified",
        evidence:
          evidence ??
          "No matching local command output was recorded for this criterion.",
        ...(evidence
          ? {}
          : {
              blocker:
                "Run the named command and keep its output in the repository run evidence.",
            }),
      };
    }
    if (evidenceKind === "browser-backend-integration") {
      const evidence = integrationEvidence(corpus);
      return {
        repository: repo.name,
        source,
        criterion,
        evidenceKind,
        status: evidence ? "verified" : "unverified",
        evidence:
          evidence ??
          "No browser/backend integration evidence was recorded for this criterion.",
        ...(evidence
          ? {}
          : {
              blocker:
                "No browser/backend integration evidence was recorded. Passing build/run evidence is not enough to mark PRD acceptance criteria complete.",
            }),
      };
    }
    return {
      repository: repo.name,
      source,
      criterion,
      evidenceKind,
      status:
        result?.status === "success" && agentCompleted
          ? "verified"
          : "unverified",
      evidence:
        result?.status === "success" && agentCompleted
          ? "Repository run succeeded and the agent claimed completion; this is static/code-review level evidence only."
          : "No static/code-review completion evidence was recorded.",
      ...(result?.status === "success" && agentCompleted
        ? {}
        : {
            blocker:
              "Record code-review or implementation evidence for this criterion.",
          }),
    };
  });
};

const latestRunForRepo = (
  repoName: string,
  runs: readonly TaskProgressRun[],
): TaskProgressRun | undefined =>
  runs
    .filter(({ run }) => run.repo === repoName)
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0];

const eventErrors = (run: TaskProgressRun | undefined): string[] =>
  (run?.events ?? []).flatMap((record) =>
    record.event.type === "run-failed" ? [record.event.message] : [],
  );

const eventCommitShas = (run: TaskProgressRun | undefined): string[] =>
  (run?.events ?? []).flatMap((record) =>
    record.event.type === "commit" ? [record.event.sha] : [],
  );

const eventClaimedCompletion = (run: TaskProgressRun | undefined): boolean =>
  (run?.events ?? []).some((record) => {
    const event = record.event;
    return (
      (event.type === "agent-text" &&
        event.message.includes(COMPLETION_SIGNAL)) ||
      (event.type === "run-finished" &&
        event.completionSignal === COMPLETION_SIGNAL)
    );
  });

const resultClaimedCompletion = (
  result: WorkspaceTaskRepositoryResult | undefined,
): boolean => result?.stdout?.includes(COMPLETION_SIGNAL) ?? false;

const resultCommitShas = (
  result: WorkspaceTaskRepositoryResult | undefined,
): string[] => result?.commits.map((commit) => commit.sha) ?? [];

const summarizeRepository = (
  repo: BoardTaskPlan["repositories"][number],
  result: WorkspaceTaskRepositoryResult | undefined,
  run: TaskProgressRun | undefined,
): BoardTaskVerificationRepositorySummary => {
  const criteria = summarizeCriteria(repo, result, run);
  const hasUnverifiedCriteria = criteria.some(
    (criterion) => criterion.status === "unverified",
  );
  const errors = unique(
    [
      result ? undefined : "Missing execution result.",
      result?.error,
      run?.run.error,
      ...eventErrors(run),
    ].filter((value): value is string => typeof value === "string"),
  );
  const commits = unique([
    ...resultCommitShas(result),
    ...eventCommitShas(run),
  ]);
  const commitExists =
    commits.length > 0 ||
    (run?.run.commits ?? 0) > 0 ||
    resultCommitShas(result).length > 0;
  const infrastructureFailure = errors.some(isInfrastructureFailureMessage);
  const agentClaimedCompletion =
    resultClaimedCompletion(result) || eventClaimedCompletion(run);
  const issueStatus =
    result === undefined
      ? "needs-recovery"
      : result.status === "success"
        ? hasUnverifiedCriteria
          ? "needs-verification"
          : "succeeded"
        : infrastructureFailure && agentClaimedCompletion && commitExists
          ? "infra-warning"
          : infrastructureFailure && !agentClaimedCompletion && !commitExists
            ? "needs-recovery"
            : "verification-failed";
  return {
    name: repo.name,
    issueStatus,
    resultStatus: result?.status ?? "missing",
    runStatus: run?.run.status ?? "missing",
    ...((result?.branch ?? run?.run.branch)
      ? { branch: result?.branch ?? run?.run.branch }
      : {}),
    agentClaimedCompletion,
    commitExists,
    commits,
    infrastructureFailure,
    criteria,
    errors,
  };
};

const suggestedNextAction = (status: BoardTaskVerificationStatus): string => {
  if (status === "passed") {
    return "No action required; the approved execution passed verification.";
  }
  if (status === "infra-warning") {
    return "Inspect Sandcastle capture/session artifacts, but delivery evidence shows the agent claimed completion and a commit exists.";
  }
  if (status === "needs-verification") {
    return "Run or record the missing PRD acceptance verification before treating this task as delivered.";
  }
  if (status === "needs-recovery") {
    return "Recover this task and continue from the verification report without re-planning.";
  }
  return "Recover this task and repair the failed delivery checks without re-planning.";
};

const reportStatus = (
  repositories: readonly BoardTaskVerificationRepositorySummary[],
): BoardTaskVerificationStatus => {
  if (repositories.some((repo) => repo.resultStatus === "missing")) {
    return "needs-recovery";
  }
  const failedRepos = repositories.filter(
    (repo) => repo.resultStatus === "failed",
  );
  if (failedRepos.length > 0) {
    const allFailuresHaveDeliveryEvidence = failedRepos.every(
      (repo) =>
        repo.infrastructureFailure &&
        repo.agentClaimedCompletion &&
        repo.commitExists,
    );
    if (allFailuresHaveDeliveryEvidence) return "infra-warning";
    // Every failure happened before the agent produced any work (e.g. the
    // sandbox never came up): the Generator must recover, nothing to verify.
    const allFailuresPreAgent = failedRepos.every(
      (repo) => repo.issueStatus === "needs-recovery",
    );
    return allFailuresPreAgent ? "needs-recovery" : "failed";
  }
  if (
    repositories.some((repo) =>
      repo.criteria.some((criterion) => criterion.status === "unverified"),
    )
  ) {
    return "needs-verification";
  }
  return "passed";
};

const markdownList = (items: readonly string[], empty: string): string =>
  (items.length > 0 ? items : [empty]).map((item) => `- ${item}`).join("\n");

const markdownCell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const renderCriterionMarkdown = (
  criterion: BoardTaskVerificationCriterion,
): string =>
  `| ${markdownCell(criterion.repository)} | ${criterion.evidenceKind} | ${criterion.status} | ${markdownCell(criterion.criterion)} | ${markdownCell(criterion.evidence)} | ${markdownCell(criterion.blocker ?? "")} |`;

const renderRepositoryMarkdown = (
  repo: BoardTaskVerificationRepositorySummary,
): string => `## Repository: ${repo.name}
Issue status: ${repo.issueStatus}
Execution result: ${repo.resultStatus}
Run status: ${repo.runStatus}
Branch: ${repo.branch ?? "unknown"}
Agent claimed completion: ${repo.agentClaimedCompletion ? "yes" : "no"}
Commit exists: ${repo.commitExists ? "yes" : "no"}
Commits: ${repo.commits.length > 0 ? repo.commits.join(", ") : "none"}
Infrastructure failure: ${repo.infrastructureFailure ? "yes" : "no"}

### PRD verification evidence
${markdownList(
  repo.criteria.map(
    (criterion) =>
      `${criterion.status}: ${criterion.evidenceKind} - ${criterion.criterion}`,
  ),
  "No PRD acceptance criteria were extracted from the issue.",
)}

### Errors
${markdownList(repo.errors, "No errors recorded.")}`;

export const renderTaskVerificationReport = (args: {
  readonly task: Pick<BoardTaskRecord, "id" | "title" | "plan">;
  readonly repositoryResults: Record<string, WorkspaceTaskRepositoryResult>;
  readonly runs: readonly TaskProgressRun[];
  readonly now?: Date;
}): {
  readonly report: BoardTaskVerificationReport;
  readonly markdown: string;
} => {
  const generatedAt = (args.now ?? new Date()).toISOString();
  const repositories = (args.task.plan?.repositories ?? []).map((repo) =>
    summarizeRepository(
      repo,
      args.repositoryResults[repo.name],
      latestRunForRepo(repo.name, args.runs),
    ),
  );
  const status = reportStatus(repositories);
  const criteria = repositories.flatMap((repo) => repo.criteria);
  const errors = repositories.flatMap((repo) =>
    repo.errors.map((error) => `${repo.name}: ${error}`),
  );
  const infrastructureFailures = repositories.flatMap((repo) =>
    repo.infrastructureFailure
      ? repo.errors
          .filter(isInfrastructureFailureMessage)
          .map((error) => `${repo.name}: ${error}`)
      : [],
  );
  const report: BoardTaskVerificationReport = {
    taskId: args.task.id,
    status,
    generatedAt,
    repositories,
    criteria,
    errors,
    infrastructureFailures,
    suggestedNextAction: suggestedNextAction(status),
  };
  const markdown = `# Board Verification Report

Task: ${args.task.title}
Task ID: ${args.task.id}
Board role: Evaluator
Status: ${report.status}
Generated: ${report.generatedAt}

## Summary
${markdownList(
  repositories.map(
    (repo) =>
      `${repo.name}: issue=${repo.issueStatus}, result=${repo.resultStatus}, run=${repo.runStatus}, completion=${repo.agentClaimedCompletion ? "yes" : "no"}, commit=${repo.commitExists ? "yes" : "no"}`,
  ),
  "No planned repositories.",
)}

## Verification matrix
| Repository | Evidence level | Status | PRD / acceptance item | Evidence | Blocker |
| --- | --- | --- | --- | --- | --- |
${criteria.length > 0 ? criteria.map(renderCriterionMarkdown).join("\n") : "| - | - | unverified | No PRD acceptance criteria were extracted. | Repository run evidence only. | Add acceptance criteria to the Board issue or PRD. |"}

## Evidence level guide
- code-static-check: code or agent-completion evidence only; it does not prove browser/backend behavior.
- local-command: a recorded local command such as typecheck, test, or build.
- browser-backend-integration: browser, HTTP/API, permission, or manual end-to-end evidence.

## Infrastructure failures
${markdownList(report.infrastructureFailures, "No infrastructure failures detected.")}

## Errors
${markdownList(report.errors, "No errors recorded.")}

## Suggested next action
${report.suggestedNextAction}

${repositories.map(renderRepositoryMarkdown).join("\n\n")}
`;
  return { report, markdown };
};
