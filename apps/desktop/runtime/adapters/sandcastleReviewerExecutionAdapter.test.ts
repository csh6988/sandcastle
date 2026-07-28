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
      | { readonly sandboxRef: string; readonly workspaceRef: string }
      | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (_provider, _model, options) => {
        captureSessions = options?.captureSessions;
        return { agent: true };
      },
      resolveSandbox: () => ({ ordinary: true }),
      resolveReviewerSandbox: (request) => {
        reviewerRequest = request;
        return {
          sandbox: { reviewer: true },
          providerId: "sandcastle-docker-reviewer",
          evidence: ["mount:/review:readonly"],
        };
      },
      run: async (options) => {
        launcherPath = String(options.cwd);
        assert.equal(existsSync(launcherPath), true);
        assert.deepEqual(options.sandbox, { reviewer: true });
        assert.match(
          String(options.prompt),
          /\/review\/inputs\/manifest\.json/,
        );
        assert.doesNotMatch(String(options.prompt), /\/producer\/repository/);
        return {
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
    const result =
      await createSandcastleReviewerExecutionAdapter(runtime).execute(input());
    assert.equal(result.status, "succeeded");
    assert.equal(captureSessions, false);
    assert.deepEqual(reviewerRequest, {
      sandboxRef: "docker",
      workspaceRef: "/company/.sandcastle/reviewer-workspaces/review-1/exposed",
    });
    assert.equal(existsSync(launcherPath), false);
    if (result.status !== "succeeded") return;
    assert.equal(result.isolation.readOnlyFilesystem, true);
    assert.equal(result.isolation.independentSessionStorage, true);
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
});
