import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

export interface WorkspacePlanningArtifacts {
  readonly planJsonPath: string;
  readonly alignmentPath: string;
  readonly technicalPlanPath: string;
  readonly issuePaths: string[];
}

export const sanitizePlanningArtifactSegment = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "workspace-task";
};

const issueBodyFor = (
  repo: WorkspaceTaskPlan["repositories"][number],
): string => {
  if (repo.issue) {
    return `# ${repo.issue.title}

${repo.issue.body}
`;
  }

  return `# ${repo.name}: ${repo.task}

Status: ready-for-agent

## What to build

${repo.task}

## Acceptance criteria

- [ ] Implement the repository-local task.
- [ ] Keep changes scoped to ${repo.name}.
- [ ] Run focused verification when feasible.

## Notes

${repo.reason ?? "No planner reason was provided."}
`;
};

export const workspaceAlignmentMarkdown = (plan: WorkspaceTaskPlan): string => {
  const alignment = plan.alignment;
  return `# Workspace PRD Alignment

## Summary

${alignment?.summary ?? "The planner did not provide a separate alignment summary."}

## Assumptions

${
  alignment?.assumptions?.length
    ? alignment.assumptions.map((item) => `- ${item}`).join("\n")
    : "- None recorded."
}

## Open Questions

${
  alignment?.openQuestions?.length
    ? alignment.openQuestions.map((item) => `- ${item}`).join("\n")
    : "- None blocking."
}

## Domain Terms

${
  alignment?.domainTerms?.length
    ? alignment.domainTerms
        .map((item) => `- ${item.term}: ${item.meaning}`)
        .join("\n")
    : "- None recorded."
}

## ADR Candidates

${
  alignment?.adrCandidates?.length
    ? alignment.adrCandidates
        .map((item) => `- ${item.title}: ${item.reason}`)
        .join("\n")
    : "- None recorded."
}
`;
};

export const writeWorkspacePlanningArtifacts = (
  dir: string,
  plan: WorkspaceTaskPlan,
): WorkspacePlanningArtifacts => {
  const issuesDir = resolve(dir, "issues");
  mkdirSync(issuesDir, { recursive: true });

  const planJsonPath = resolve(dir, "workspace-plan.json");
  writeFileSync(planJsonPath, `${JSON.stringify(plan, null, 2)}\n`);

  const alignmentPath = resolve(dir, "alignment.md");
  writeFileSync(alignmentPath, workspaceAlignmentMarkdown(plan));

  const technicalPlanPath = resolve(dir, "technical-plan.md");
  writeFileSync(
    technicalPlanPath,
    `# Workspace Technical Plan

${plan.technicalPlan ?? "The planner did not provide a separate technical plan."}

## Repository Issues

${plan.repositories.map((repo) => `- ${repo.name}: ${repo.task}`).join("\n")}
`,
  );

  const issuePaths = plan.repositories.map((repo) => {
    const path = resolve(
      issuesDir,
      `${sanitizePlanningArtifactSegment(repo.name)}.md`,
    );
    writeFileSync(path, issueBodyFor(repo));
    return path;
  });

  return { planJsonPath, alignmentPath, technicalPlanPath, issuePaths };
};
