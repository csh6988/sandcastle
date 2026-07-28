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
  const outputTag =
    input.phase === "initial-finding" ? "reviewer_finding" : "reviewer_recheck";
  const task =
    input.phase === "initial-finding"
      ? `Return this exact JSON shape with at least one finding (including a non-blocking finding when the Diff is acceptable):
{
  "findings": [{
    "severity": "info|low|medium|high|critical",
    "summary": "non-empty string",
    "rationale": "non-empty string",
    "impact": "non-empty string",
    "evidenceRefs": ["frozen-manifest-evidence-id"],
    "suggestedOwner": "non-empty string",
    "blocking": false,
    "scopeImpact": "scope-preserving|scope-changing (optional)"
  }]
}`
      : `Freshly re-evaluate the frozen Diff and return this exact JSON shape:
{
  "result": "PASS|CONDITIONAL_PASS|FAIL",
  "conditions": ["machine-checkable condition; required only for CONDITIONAL_PASS"],
  "evidenceRefs": ["frozen-manifest-evidence-id"]
}
Use an empty conditions array for PASS and FAIL. CONDITIONAL_PASS requires at least one condition.`;
  return `# Independent Code Review

You are a non-producer Reviewer in a fresh Session.
Read only the allowlisted bundle mounted at /review:
- /review/source contains the exact base/source Git objects and checked-out source commit.
- /review/inputs/manifest.json is the frozen Code Review manifest.
- /review/inputs/canonical.diff is the canonical Diff.

Do not inspect the launcher repository, host paths, hidden transcripts, mutable producer state, or external repositories.
Every evidenceRefs entry must name an ID from the frozen manifest.
When manifest.priorReview is present, evaluate its Defect, Gate, findings, and resolution matrix; the fresh recheck must cite every requiredEvidenceRefs entry.

${task}
Emit only one JSON object inside <${outputTag}>...</${outputTag}> tags.
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

const hasActualTerminalReceipt = (receipt: Record<string, unknown>): boolean =>
  typeof receipt.providerOperationId === "string" &&
  receipt.providerOperationId.trim().length > 0 &&
  receipt.inspectedReadOnlyReviewMount === true &&
  typeof receipt.inspectedEnvironmentHash === "string" &&
  receipt.inspectedEnvironmentHash.length === 64 &&
  typeof receipt.inspectedAt === "string" &&
  Number.isFinite(Date.parse(receipt.inspectedAt)) &&
  receipt.terminalProviderStatus === "completed" &&
  typeof receipt.terminalProviderReceiptHash === "string" &&
  receipt.terminalProviderReceiptHash.length === 64;

export const createSandcastleReviewerExecutionAdapter = (
  runtime: SandcastleExecutionRuntime,
): ReviewerExecutionAdapter => ({
  capabilities: {
    executionBoundIsolation: runtime.resolveReviewerSandbox !== undefined,
    reattachRunningOperation: false,
  },
  execute: async (input, sink, signal) => {
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
        operationKey: input.operationKey,
        secretReferenceIds: input.executionProfile.secretReferenceIds,
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
          schema:
            input.phase === "initial-finding"
              ? "reviewer-finding"
              : "reviewer-recheck",
        },
        signal,
      });
      if (result.output === undefined) {
        return blocked(
          "The independent Reviewer did not return structured output.",
          reviewerSandbox.evidence,
        );
      }
      if (
        !hasActualTerminalReceipt(
          reviewerSandbox.receipt as unknown as Record<string, unknown>,
        )
      ) {
        return blocked(
          "The Reviewer provider did not return an actual terminal operation receipt with post-launch mount and environment inspection.",
          reviewerSandbox.evidence,
        );
      }
      if (sink) {
        let ordinal = 1;
        const evidenceRefs = [input.manifest.diffArtifactVersionId];
        await sink.record({
          adapterSchemaVersion: 1,
          factId: `${input.operationKey}:provider-started`,
          ordinal: ordinal++,
          kind: "provider-started",
          schemaVersion: 1,
          payload: {
            providerExecutionRef: reviewerSandbox.receipt.providerOperationId,
            providerId: reviewerSandbox.providerId,
          },
          evidenceRefs: reviewerSandbox.evidence,
        });
        if (result.stdout?.trim()) {
          await sink.record({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:message`,
            ordinal: ordinal++,
            kind: "message",
            schemaVersion: 1,
            payload: { content: result.stdout.trim() },
            evidenceRefs,
          });
        }
        const usage = (result.iterations ?? []).reduce(
          (total, iteration) => ({
            inputTokens:
              total.inputTokens + (iteration.usage?.inputTokens ?? 0),
            outputTokens:
              total.outputTokens + (iteration.usage?.outputTokens ?? 0),
            totalTokens:
              total.totalTokens + (iteration.usage?.totalTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        );
        if (usage.totalTokens > 0) {
          await sink.record({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:usage`,
            ordinal,
            kind: "usage",
            schemaVersion: 1,
            payload: usage,
            evidenceRefs,
          });
        }
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
          ...reviewerSandbox.receipt,
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
