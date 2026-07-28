import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import type { ReviewerExecutionInput } from "../review/reviewerExecution.js";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";
import { createSandcastleReviewerExecutionAdapter } from "./sandcastleReviewerExecutionAdapter.js";

const input = (
  overrides: Partial<ReviewerExecutionInput> = {},
): ReviewerExecutionInput => ({
  operationKey: "code-review:review-1:initial-finding",
  phase: "initial-finding",
  manifest: {
    schemaVersion: 1,
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    workPackageId: "package-1",
    workPackageVersionId: "package-v1",
    assignmentId: "assignment-1",
    nodeRunId: "development-node",
    nodeAttemptId: "attempt-1",
    repositoryReference: "/producer/repository",
    baseCommit: "1".repeat(40),
    workspaceImportId: "import-1",
    sourceCommit: "2".repeat(40),
    diffArtifactVersionId: "diff-1",
    diffHash: "3".repeat(64),
    specRevisionIds: ["spec-1"],
    harnessSnapshotIds: ["harness-1"],
    acceptanceCriteria: ["Review the exact Diff"],
    selfCheck: {
      id: "self-check-1",
      hash: "4".repeat(64),
      commands: ["npm test"],
      logRefs: ["self-check-log-1"],
      evidenceRefs: ["commit-evidence-1"],
    },
    permissions: ["repository.read"],
    errorHandlingInputs: ["fail closed"],
    crossApplicationImpactInputs: ["none"],
    excludedContext: ["producer-workspace"],
  },
  workspaceRef: "/company/.sandcastle/reviewer-workspaces/review-1/exposed",
  reviewNodeRunId: "review-node",
  reviewer: {
    participantId: "reviewer-participant",
    aiMemberId: "reviewer-member",
    positionId: "reviewer",
    sessionId: "reviewer-session",
  },
  executionProfile: {
    agentAdapterId: "codex",
    model: "gpt-test",
    sandboxRef: "docker",
    secretReferenceIds: [],
    timeoutSeconds: 60,
    maxIterations: 1,
  },
  findings: [],
  revision: null,
  ...overrides,
});

describe("Sandcastle Reviewer Execution Adapter", () => {
  it("runs a fresh Agent in a Docker reviewer Sandbox with only the read-only review bundle", async () => {
    let launcherPath = "";
    let captureSessions: boolean | undefined;
    let reviewerRequest:
      | {
          readonly sandboxRef: string;
          readonly workspaceRef: string;
          readonly operationKey: string;
          readonly secretReferenceIds: readonly string[];
        }
      | undefined;
    let notifyReviewerOperationStarted:
      | ((input: {
          readonly providerId: string;
          readonly providerOperationId: string;
          readonly evidence: readonly string[];
        }) => Promise<void>)
      | undefined;
    const factKinds: string[] = [];
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (_provider, _model, options) => {
        captureSessions = options?.captureSessions;
        return { agent: true };
      },
      resolveSandbox: () => ({ ordinary: true }),
      resolveReviewerSandbox: (request) => {
        const { onOperationStarted, ...frozenRequest } = request;
        reviewerRequest = frozenRequest;
        notifyReviewerOperationStarted = onOperationStarted;
        return {
          sandbox: { reviewer: true },
          providerId: "sandcastle-docker-reviewer",
          evidence: ["mount:/review:readonly"],
          receipt: {
            mountTableHash: "1".repeat(64),
            sessionScopeHash: "2".repeat(64),
            cacheScopeHash: "3".repeat(64),
            credentialScopeHash: "4".repeat(64),
            providerOperationId: "docker-container-1",
            inspectedReadOnlyReviewMount: true,
            inspectedEnvironmentHash: "5".repeat(64),
            inspectedAt: "2026-07-28T10:00:00.000Z",
            terminalProviderStatus: "completed",
            terminalProviderReceiptHash: "6".repeat(64),
          },
        };
      },
      run: async (options) => {
        assert.ok(notifyReviewerOperationStarted);
        await notifyReviewerOperationStarted({
          providerId: "sandcastle-docker-reviewer",
          providerOperationId: "docker-container-1",
          evidence: ["mount:/review:readonly"],
        });
        assert.deepEqual(factKinds, ["provider-started"]);
        launcherPath = String(options.cwd);
        assert.equal(existsSync(launcherPath), true);
        assert.deepEqual(options.sandbox, { reviewer: true });
        assert.match(
          String(options.prompt),
          /\/review\/inputs\/manifest\.json/,
        );
        assert.match(String(options.prompt), /<reviewer_finding>/);
        assert.match(String(options.prompt), /"severity"/);
        assert.match(String(options.prompt), /"rationale"/);
        assert.match(String(options.prompt), /"impact"/);
        assert.match(String(options.prompt), /"evidenceRefs"/);
        assert.match(String(options.prompt), /"suggestedOwner"/);
        assert.match(String(options.prompt), /"blocking"/);
        assert.deepEqual(options.output, {
          tag: "reviewer_finding",
          schema: "reviewer-finding",
        });
        assert.doesNotMatch(String(options.prompt), /\/producer\/repository/);
        const onRuntimeEvent = (
          options.events as
            | {
                readonly onRuntimeEvent?: (event: unknown) => Promise<void>;
              }
            | undefined
        )?.onRuntimeEvent;
        assert.ok(onRuntimeEvent);
        await onRuntimeEvent({
          type: "message.delta",
          runId: "core-run-1",
          messageId: "message-1",
          iteration: 1,
          text: "Reviewer inspected the exact bundle.",
          timestamp: new Date("2026-07-28T10:00:01.000Z"),
        });
        await onRuntimeEvent({
          type: "tool.call",
          runId: "core-run-1",
          toolCallId: "tool-call-1",
          iteration: 1,
          name: "Read",
          args: '{"path":"/review/inputs/manifest.json"}',
          timestamp: new Date("2026-07-28T10:00:02.000Z"),
        });
        await onRuntimeEvent({
          type: "tool.result",
          runId: "core-run-1",
          toolCallId: "tool-call-1",
          iteration: 1,
          content: "manifest loaded",
          timestamp: new Date("2026-07-28T10:00:03.000Z"),
        });
        await onRuntimeEvent({
          type: "usage.recorded",
          runId: "core-run-1",
          iteration: 1,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
          model: "gpt-test",
          timestamp: new Date("2026-07-28T10:00:04.000Z"),
        });
        return {
          stdout: "Reviewer inspected the exact bundle.",
          iterations: [
            {
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
              },
            },
          ],
          output: {
            findings: [
              {
                severity: "info",
                summary: "Reviewed",
                rationale: "Exact inputs",
                impact: "No blocker",
                evidenceRefs: ["diff-1"],
                suggestedOwner: "software-engineer",
                blocking: false,
              },
            ],
          },
        };
      },
      runWorkspaceTask: async () => ({}),
    };
    const result = await createSandcastleReviewerExecutionAdapter(
      runtime,
    ).execute(input(), {
      record: async (fact) => {
        factKinds.push(fact.kind);
        return {
          status: "accepted",
          executionFactId: fact.factId,
          effectIds: [],
          canonicalPayloadHash: "a".repeat(64),
        };
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(captureSessions, false);
    assert.deepEqual(reviewerRequest, {
      sandboxRef: "docker",
      workspaceRef: "/company/.sandcastle/reviewer-workspaces/review-1/exposed",
      operationKey: "code-review:review-1:initial-finding",
      secretReferenceIds: [],
    });
    assert.equal(existsSync(launcherPath), false);
    assert.deepEqual(factKinds, [
      "provider-started",
      "message",
      "tool-call",
      "tool-result",
      "usage",
    ]);
    if (result.status !== "succeeded") return;
    assert.equal(result.isolation.readOnlyFilesystem, true);
    assert.equal(result.isolation.independentSessionStorage, true);
  });

  it("cancels and reconciles a live Reviewer provider operation without overstating restart reattachment", async () => {
    let resolveRun!: (value: {
      readonly output: {
        readonly findings: readonly {
          readonly severity: "info";
          readonly summary: string;
          readonly rationale: string;
          readonly impact: string;
          readonly evidenceRefs: readonly string[];
          readonly suggestedOwner: string;
          readonly blocking: false;
        }[];
      };
    }) => void;
    const runResult = new Promise<{
      readonly output: {
        readonly findings: readonly {
          readonly severity: "info";
          readonly summary: string;
          readonly rationale: string;
          readonly impact: string;
          readonly evidenceRefs: readonly string[];
          readonly suggestedOwner: string;
          readonly blocking: false;
        }[];
      };
    }>((resolve) => {
      resolveRun = resolve;
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelledRefs: string[] = [];
    const inspectedRefs: string[] = [];
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      resolveReviewerSandbox: () => ({
        sandbox: {},
        providerId: "sandcastle-docker-reviewer",
        evidence: ["provider-operation:docker-container-1"],
        receipt: {
          mountTableHash: "1".repeat(64),
          sessionScopeHash: "2".repeat(64),
          cacheScopeHash: "3".repeat(64),
          credentialScopeHash: "4".repeat(64),
          providerOperationId: "docker-container-1",
          inspectedReadOnlyReviewMount: true,
          inspectedEnvironmentHash: "5".repeat(64),
          inspectedAt: "2026-07-28T10:00:00.000Z",
          terminalProviderStatus: "completed",
          terminalProviderReceiptHash: "6".repeat(64),
        },
      }),
      cancelReviewerOperation: async (providerOperationId) => {
        cancelledRefs.push(providerOperationId);
        return "cancelled";
      },
      inspectReviewerOperation: async (providerOperationId) => {
        inspectedRefs.push(providerOperationId);
        return "running";
      },
      run: async () => {
        resolveStarted();
        return runResult;
      },
      runWorkspaceTask: async () => ({}),
    };
    const adapter = createSandcastleReviewerExecutionAdapter(runtime);
    const sink = {
      record: async (fact: { readonly factId: string }) => ({
        status: "accepted" as const,
        executionFactId: fact.factId,
        effectIds: [],
        canonicalPayloadHash: "a".repeat(64),
      }),
    };
    const request = input();
    const execution = adapter.execute(request, sink);
    await started;

    const reconciled = await adapter.reconcile?.(
      request.operationKey,
      sink,
      "docker-container-1",
    );
    assert.deepEqual(reconciled, {
      status: "running",
      providerExecutionRef: "docker-container-1",
    });
    assert.deepEqual(inspectedRefs, []);
    assert.equal(adapter.capabilities.reattachRunningOperation, false);
    assert.equal(adapter.reattach, undefined);
    assert.equal(await adapter.cancel?.(request.operationKey), "cancelled");
    assert.deepEqual(cancelledRefs, ["docker-container-1"]);

    resolveRun({
      output: {
        findings: [
          {
            severity: "info",
            summary: "Reviewed",
            rationale: "Exact inputs",
            impact: "No blocker",
            evidenceRefs: ["diff-1"],
            suggestedOwner: "software-engineer",
            blocking: false,
          },
        ],
      },
    });
    assert.equal((await execution).status, "succeeded");
  });

  it("does not claim a hard-restarted Docker container is a reattachable Reviewer operation", async () => {
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      resolveReviewerSandbox: () => ({
        sandbox: {},
        providerId: "sandcastle-docker-reviewer",
        evidence: ["provider-operation:docker-container-after-restart"],
        receipt: {
          mountTableHash: "1".repeat(64),
          sessionScopeHash: "2".repeat(64),
          cacheScopeHash: "3".repeat(64),
          credentialScopeHash: "4".repeat(64),
        },
      }),
      inspectReviewerOperation: async () => "running",
      run: async () => ({}),
      runWorkspaceTask: async () => ({}),
    };
    const adapter = createSandcastleReviewerExecutionAdapter(runtime);

    const result = await adapter.reconcile?.(
      "code-review:review-1:initial-finding",
      undefined,
      "docker-container-after-restart",
    );

    assert.equal(result?.status, "unknown");
    if (result?.status !== "unknown") return;
    assert.equal(result.code, "RECONCILE_UNKNOWN");
    assert.deepEqual(result.evidence, [
      "provider-operation:docker-container-after-restart",
      "provider-status:running",
    ]);
  });

  it("fails closed for no-sandbox and bind-mount Reviewer execution", async () => {
    let runCalls = 0;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      resolveReviewerSandbox: () => ({
        sandbox: {},
        providerId: "unexpected",
        evidence: [],
        receipt: {
          mountTableHash: "1".repeat(64),
          sessionScopeHash: "2".repeat(64),
          cacheScopeHash: "3".repeat(64),
          credentialScopeHash: "4".repeat(64),
          providerOperationId: "docker-container-1",
          inspectedReadOnlyReviewMount: true,
          inspectedEnvironmentHash: "5".repeat(64),
          inspectedAt: "2026-07-28T10:00:00.000Z",
          terminalProviderStatus: "completed",
          terminalProviderReceiptHash: "6".repeat(64),
        },
      }),
      run: async () => {
        runCalls += 1;
        return {};
      },
      runWorkspaceTask: async () => ({}),
    };
    const result = await createSandcastleReviewerExecutionAdapter(
      runtime,
    ).execute(
      input({
        executionProfile: {
          ...input().executionProfile,
          sandboxRef: "no-sandbox",
        },
      }),
    );
    assert.equal(result.status, "blocked");
    assert.equal(runCalls, 0);
  });

  it("blocks when the provider returns only requested isolation hashes without an actual terminal operation receipt", async () => {
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      resolveReviewerSandbox: () => ({
        sandbox: {},
        providerId: "requested-only-reviewer",
        evidence: ["mount:/review:requested-readonly"],
        receipt: {
          mountTableHash: "1".repeat(64),
          sessionScopeHash: "2".repeat(64),
          cacheScopeHash: "3".repeat(64),
          credentialScopeHash: "4".repeat(64),
        } as never,
      }),
      run: async () => ({
        output: {
          findings: [
            {
              severity: "info",
              summary: "Reviewed",
              rationale: "Exact inputs",
              impact: "No blocker",
              evidenceRefs: ["diff-1"],
              suggestedOwner: "software-engineer",
              blocking: false,
            },
          ],
        },
      }),
      runWorkspaceTask: async () => ({}),
    };
    const result =
      await createSandcastleReviewerExecutionAdapter(runtime).execute(input());
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.match(result.message, /actual terminal operation receipt/);
    }
  });

  it("blocks when Reviewer Secret References cannot be materialized into an operation-local credential scope", async () => {
    let runCalls = 0;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      resolveReviewerSandbox: () => {
        throw new Error(
          "Reviewer Secret References require an operation-local materializer.",
        );
      },
      run: async () => {
        runCalls += 1;
        return {};
      },
      runWorkspaceTask: async () => ({}),
    };
    const result = await createSandcastleReviewerExecutionAdapter(
      runtime,
    ).execute(
      input({
        executionProfile: {
          ...input().executionProfile,
          secretReferenceIds: ["reviewer-secret"],
        },
      }),
    );
    assert.equal(result.status, "blocked");
    assert.equal(runCalls, 0);
  });
});
