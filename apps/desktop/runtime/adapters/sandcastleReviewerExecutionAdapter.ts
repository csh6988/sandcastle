import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const MAX_REVIEWER_FACT_CONTENT = 4_096;

const sanitizeReviewerFactContent = (value: string): string => {
  const redacted = value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)(["']?)[^"'\s,;}\]]+\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /([?&](?:X-Amz-Signature|signature|sig|token|access_token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, "[REDACTED_BASE64]");
  if (redacted.length <= MAX_REVIEWER_FACT_CONTENT) return redacted;
  const digest = createHash("sha256").update(redacted).digest("hex");
  return `${redacted.slice(0, MAX_REVIEWER_FACT_CONTENT)}\n[TRUNCATED redactedSha256=${digest} originalChars=${redacted.length}]`;
};

type ReviewerCoreRuntimeEvent =
  | {
      readonly type: "message.delta";
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool.call";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: string;
    }
  | {
      readonly type: "tool.result";
      readonly toolCallId?: string;
      readonly content: string;
    }
  | {
      readonly type: "usage.recorded";
      readonly iteration: number;
      readonly model?: string;
      readonly usage: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
    };

export const createSandcastleReviewerExecutionAdapter = (
  runtime: SandcastleExecutionRuntime,
): ReviewerExecutionAdapter => {
  const providerRefs = new Map<string, string>();
  const activeOperations = new Map<string, Promise<ReviewerExecutionResult>>();
  const completedOperations = new Map<
    string,
    Extract<ReviewerExecutionResult, { readonly status: "succeeded" }>
  >();
  const reconciliationOrdinals = new Map<string, number>();

  const executeOperation: ReviewerExecutionAdapter["execute"] = async (
    input,
    sink,
    signal,
  ) => {
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
      let ordinal = 1;
      let eventSequence = 0;
      let providerStartedRecorded = false;
      let sawMessageEvent = false;
      let sawUsageEvent = false;
      let recordQueue: Promise<void> = Promise.resolve();
      let recordFailure: unknown;
      const evidenceRefs = [input.manifest.diffArtifactVersionId];
      const enqueue = (
        fact: Parameters<NonNullable<typeof sink>["record"]>[0],
      ) => {
        const pending = recordQueue.then(async () => {
          if (recordFailure) throw recordFailure;
          if (!sink) return undefined;
          const receipt = await sink.record(fact);
          if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
            throw new Error(
              `Reviewer ${fact.kind} Fact was ${receipt.status} under the active execution fence.`,
            );
          }
          return receipt;
        });
        recordQueue = pending.then(
          () => undefined,
          (error) => {
            recordFailure = error;
          },
        );
        return pending;
      };
      const recordProviderStarted = async (started: {
        readonly providerId: string;
        readonly providerOperationId: string;
        readonly evidence: readonly string[];
      }): Promise<void> => {
        if (providerStartedRecorded || !sink) return;
        providerStartedRecorded = true;
        providerRefs.set(input.operationKey, started.providerOperationId);
        await enqueue({
          adapterSchemaVersion: 1,
          factId: `${input.operationKey}:provider-started`,
          ordinal: ordinal++,
          kind: "provider-started",
          schemaVersion: 1,
          payload: {
            providerExecutionRef: started.providerOperationId,
            providerId: started.providerId,
          },
          evidenceRefs: started.evidence,
        });
      };
      launcherPath = createLauncherRepository();
      const reviewerSandbox = runtime.resolveReviewerSandbox({
        sandboxRef: input.executionProfile.sandboxRef,
        workspaceRef: input.workspaceRef,
        operationKey: input.operationKey,
        secretReferenceIds: input.executionProfile.secretReferenceIds,
        onOperationStarted: recordProviderStarted,
      });
      const recordResolvedProviderStarted = (): Promise<void> => {
        const providerOperationId = reviewerSandbox.receipt.providerOperationId;
        return providerOperationId
          ? recordProviderStarted({
              providerId: reviewerSandbox.providerId,
              providerOperationId,
              evidence: reviewerSandbox.evidence,
            })
          : Promise.resolve();
      };
      const onRuntimeEvent = async (value: unknown): Promise<void> => {
        if (typeof value !== "object" || value === null || !("type" in value)) {
          return;
        }
        await recordResolvedProviderStarted();
        if (
          ![
            "message.delta",
            "tool.call",
            "tool.result",
            "usage.recorded",
          ].includes(String(value.type))
        ) {
          return;
        }
        const event = value as ReviewerCoreRuntimeEvent;
        if (!sink) return;
        eventSequence += 1;
        if (event.type === "message.delta") {
          sawMessageEvent = true;
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:message:${event.messageId}:${eventSequence}`,
            ordinal: ordinal++,
            kind: "message",
            schemaVersion: 1,
            payload: { content: sanitizeReviewerFactContent(event.text) },
            evidenceRefs,
          });
          return;
        }
        if (event.type === "tool.call") {
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:tool-call:${event.toolCallId}`,
            ordinal: ordinal++,
            kind: "tool-call",
            schemaVersion: 1,
            payload: {
              toolCallId: event.toolCallId,
              name: event.name,
              args: sanitizeReviewerFactContent(event.args),
            },
            evidenceRefs,
          });
          return;
        }
        if (event.type === "tool.result") {
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:tool-result:${event.toolCallId ?? eventSequence}`,
            ordinal: ordinal++,
            kind: "tool-result",
            schemaVersion: 1,
            payload: {
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
              content: sanitizeReviewerFactContent(event.content),
            },
            evidenceRefs,
          });
          return;
        }
        if (event.type === "usage.recorded") {
          sawUsageEvent = true;
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:usage:${event.iteration}`,
            ordinal: ordinal++,
            kind: "usage",
            schemaVersion: 1,
            payload: {
              ...event.usage,
              ...(event.model ? { model: event.model } : {}),
            },
            evidenceRefs,
          });
        }
      };
      const agent = runtime.resolveAgent(
        input.executionProfile.agentAdapterId,
        input.executionProfile.model,
        { captureSessions: false },
      );
      await recordResolvedProviderStarted();
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
        events: { onRuntimeEvent },
        signal,
      });
      await recordResolvedProviderStarted();
      await recordQueue;
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
        if (!sawMessageEvent && result.stdout?.trim()) {
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:message`,
            ordinal: ordinal++,
            kind: "message",
            schemaVersion: 1,
            payload: {
              content: sanitizeReviewerFactContent(result.stdout.trim()),
            },
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
        if (!sawUsageEvent && usage.totalTokens > 0) {
          await enqueue({
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:usage`,
            ordinal: ordinal++,
            kind: "usage",
            schemaVersion: 1,
            payload: usage,
            evidenceRefs,
          });
        }
        await recordQueue;
        if (recordFailure) throw recordFailure;
      }
      const succeeded = {
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
      } as const;
      reconciliationOrdinals.set(input.operationKey, ordinal);
      return succeeded;
    } catch (error) {
      return blocked(
        error instanceof Error
          ? error.message
          : "Independent Reviewer execution failed.",
      );
    } finally {
      if (launcherPath) rmSync(launcherPath, { recursive: true, force: true });
    }
  };

  const execute: ReviewerExecutionAdapter["execute"] = (
    input,
    sink,
    signal,
  ) => {
    const operation = executeOperation(input, sink, signal);
    activeOperations.set(input.operationKey, operation);
    void operation
      .then((result) => {
        if (result.status === "succeeded") {
          completedOperations.set(input.operationKey, result);
        }
      })
      .finally(() => {
        if (activeOperations.get(input.operationKey) === operation) {
          activeOperations.delete(input.operationKey);
        }
      });
    return operation;
  };

  return {
    capabilities: {
      executionBoundIsolation: runtime.resolveReviewerSandbox !== undefined,
      reattachRunningOperation: false,
    },
    execute,
    cancel: async (operationKey, durableProviderExecutionRef) => {
      const providerExecutionRef =
        durableProviderExecutionRef ?? providerRefs.get(operationKey);
      if (!providerExecutionRef || !runtime.cancelReviewerOperation) {
        return "unknown";
      }
      return runtime.cancelReviewerOperation(providerExecutionRef);
    },
    reconcile: async (operationKey, sink, providerExecutionRef) => {
      const completed = completedOperations.get(operationKey);
      if (completed) {
        if (!sink) {
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message:
              "The completed Reviewer result cannot be reconciled without an active reconciliation Fact sink.",
            evidence: completed.isolationEvidence,
          };
        }
        try {
          const receipt = await sink.record({
            adapterSchemaVersion: 1,
            factId: `${operationKey}:reconciled-completed`,
            ordinal: reconciliationOrdinals.get(operationKey) ?? 1,
            kind: "completed",
            schemaVersion: 1,
            payload: { structuredResult: completed },
            evidenceRefs: completed.isolationEvidence,
          });
          if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
            return {
              status: "unknown",
              code: "RECONCILE_UNKNOWN",
              message: `The completed Reviewer result was ${receipt.status} under the active reconciliation fence.`,
              evidence: completed.isolationEvidence,
            };
          }
          return {
            ...completed,
            terminalExecutionFactId: receipt.executionFactId,
          };
        } catch (error) {
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message: `The completed Reviewer result could not be recorded under the active reconciliation fence: ${error instanceof Error ? error.message : String(error)}`,
            evidence: completed.isolationEvidence,
          };
        }
      }
      const resolvedProviderRef =
        providerExecutionRef ?? providerRefs.get(operationKey);
      if (activeOperations.has(operationKey) && resolvedProviderRef) {
        return {
          status: "running",
          providerExecutionRef: resolvedProviderRef,
        };
      }
      if (resolvedProviderRef && runtime.inspectReviewerOperation) {
        const status =
          await runtime.inspectReviewerOperation(resolvedProviderRef);
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: `Reviewer provider operation ${resolvedProviderRef} is ${status}, but no exact structured result receipt is available.`,
          evidence: [
            `provider-operation:${resolvedProviderRef}`,
            `provider-status:${status}`,
          ],
        };
      }
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "The Reviewer provider operation cannot be inspected safely.",
        evidence: resolvedProviderRef
          ? [`provider-operation:${resolvedProviderRef}`]
          : [],
      };
    },
  };
};
