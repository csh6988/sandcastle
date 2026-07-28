import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReviewerExecutionAdapter,
  ReviewerExecutionInput,
  ReviewerExecutionResult,
} from "../review/reviewerExecution.js";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
};

const createLauncherRepository = (): string => {
  const path = mkdtempSync(join(tmpdir(), "sandcastle-reviewer-launcher-"));
  git(path, "init", "--initial-branch=reviewer-launcher");
  git(path, "config", "user.name", "Sandcastle Reviewer Runtime");
  git(path, "config", "user.email", "reviewer-runtime@sandcastle.invalid");
  writeFileSync(join(path, ".gitignore"), "*\n!.gitignore\n", "utf8");
  git(path, "add", ".gitignore");
  git(path, "commit", "-m", "chore: initialize reviewer launcher");
  return path;
};

const promptFor = (input: ReviewerExecutionInput): string => {
  const task =
    input.phase === "initial-finding"
      ? "Return at least one precise finding, including non-blocking findings when the Diff is acceptable."
      : "Freshly re-evaluate the frozen Diff and return PASS, CONDITIONAL_PASS, or FAIL.";
  return `# Independent Code Review

You are a non-producer Reviewer in a fresh Session.
Read only the allowlisted bundle mounted at /review:
- /review/source contains the exact base/source Git objects and checked-out source commit.
- /review/inputs/manifest.json is the frozen Code Review manifest.
- /review/inputs/canonical.diff is the canonical Diff.

Do not inspect the launcher repository, host paths, hidden transcripts, mutable producer state, or external repositories.
Every evidenceRefs entry must name an ID from the frozen manifest.

${task}
`;
};

const blocked = (
  message: string,
  evidence: readonly string[] = [],
): ReviewerExecutionResult => ({
  status: "blocked",
  code: "PROVIDER_ISOLATION_REQUIRED",
  message,
  evidence,
});

export const createSandcastleReviewerExecutionAdapter = (
  runtime: SandcastleExecutionRuntime,
): ReviewerExecutionAdapter => ({
  capabilities: {
    executionBoundIsolation: runtime.resolveReviewerSandbox !== undefined,
    reattachRunningOperation: false,
  },
  execute: async (input) => {
    if (!runtime.resolveReviewerSandbox) {
      return blocked(
        "The Sandcastle Runtime cannot create an execution-bound Reviewer Sandbox.",
      );
    }
    if (input.executionProfile.sandboxRef !== "docker") {
      return blocked(
        `Reviewer Sandbox ${input.executionProfile.sandboxRef} cannot prove Docker read-only isolation.`,
      );
    }
    let launcherPath: string | undefined;
    try {
      launcherPath = createLauncherRepository();
      const reviewerSandbox = runtime.resolveReviewerSandbox({
        sandboxRef: input.executionProfile.sandboxRef,
        workspaceRef: input.workspaceRef,
      });
      const agent = runtime.resolveAgent(
        input.executionProfile.agentAdapterId,
        input.executionProfile.model,
        { captureSessions: false },
      );
      const result = await runtime.run({
        agent,
        sandbox: reviewerSandbox.sandbox,
        cwd: launcherPath,
        prompt: promptFor(input),
        branchStrategy: { type: "head" },
        maxIterations: input.executionProfile.maxIterations,
        idleTimeoutSeconds: input.executionProfile.timeoutSeconds,
        completionTimeoutSeconds: input.executionProfile.timeoutSeconds,
        name: input.operationKey,
        output: {
          tag:
            input.phase === "initial-finding"
              ? "reviewer_finding"
              : "reviewer_recheck",
          schema: "object",
        },
      });
      if (result.output === undefined) {
        return blocked(
          "The independent Reviewer did not return structured output.",
          reviewerSandbox.evidence,
        );
      }
      return {
        status: "succeeded",
        providerId: reviewerSandbox.providerId,
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "docker-readonly-review-bundle",
          mechanismVersion: "1",
        },
        isolationEvidence: reviewerSandbox.evidence,
        output: result.output as Extract<
          ReviewerExecutionResult,
          { status: "succeeded" }
        >["output"],
      };
    } catch (error) {
      return blocked(
        error instanceof Error
          ? error.message
          : "Independent Reviewer execution failed.",
      );
    } finally {
      if (launcherPath) rmSync(launcherPath, { recursive: true, force: true });
    }
  },
});
