import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createScriptedReviewerExecutionAdapter } from "../review/reviewerExecution.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import { openAggregateIntegrationReviewExecutor } from "./aggregateIntegrationReviewExecutor.js";

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : entry,
  );

const openReceiptHarness = (input?: {
  readonly waitForConcurrentExecutions?: boolean;
}) => {
  const repository = mkdtempSync(join(tmpdir(), "aggregate-receipt-repo-"));
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "runtime@example.test"]);
  git(repository, ["config", "user.name", "Runtime"]);
  writeFileSync(join(repository, "result.txt"), "reviewed\n");
  git(repository, ["add", "result.txt"]);
  git(repository, ["commit", "-qm", "reviewed"]);
  const integratedCommit = git(repository, ["rev-parse", "HEAD"]);
  const storage = new DatabaseSync(":memory:");
  migrateCompanyDatabase(storage);
  let persistedSession:
    | { readonly sessionId: string; readonly participantId: string }
    | undefined;
  const database = {
    exec: (sql: string) => storage.exec(sql),
    prepare: (sql: string) => {
      if (sql.includes("FROM integration_operations")) {
        return {
          all: () => [
            {
              aiMemberId: "developer-ai",
              positionId: "developer-position",
              sessionId: "developer-session",
            },
          ],
        };
      }
      if (sql.includes("FROM interaction_sessions")) {
        return { get: () => persistedSession };
      }
      return storage.prepare(sql);
    },
  } as unknown as DatabaseSync;
  let adapterExecutions = 0;
  let recordMutations = 0;
  let recordedInput: unknown;
  let signalExecutionStarted: (() => void) | undefined;
  const executionStarted = new Promise<void>((resolve) => {
    signalExecutionStarted = resolve;
  });
  let releaseExecutions: (() => void) | undefined;
  const concurrentExecutions = new Promise<void>((resolve) => {
    releaseExecutions = resolve;
  });
  const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
    execute: async () => {
      adapterExecutions += 1;
      if (input?.waitForConcurrentExecutions) {
        signalExecutionStarted?.();
        await concurrentExecutions;
      }
      return {
        status: "succeeded",
        providerId: "scripted-reviewer",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: ["isolation-receipt"],
        terminalExecutionFactId: "aggregate-terminal-fact",
        output: {
          result: "PASS",
          conditions: [],
          evidenceRefs: [integratedCommit],
        },
      };
    },
  });
  const reviewRuntime = {
    inspect: () => {
      if (!recordedInput) throw new Error("not recorded");
      const recorded = recordedInput as {
        readonly manifest: unknown;
        readonly topicId: string;
      };
      return {
        topic: { manifest: recorded.manifest },
        gateResult: { id: `quality-gate-${recorded.topicId}` },
      } as never;
    },
    recordAggregateExecutionInTransaction: (record: unknown) => {
      if (!recordedInput) {
        recordedInput = record;
        recordMutations += 1;
      } else {
        assert.deepEqual(record, recordedInput);
      }
      const recorded = record as { readonly topicId: string };
      return {
        topic: {
          manifest: (record as { readonly manifest: unknown }).manifest,
        },
        gateResult: { id: `quality-gate-${recorded.topicId}` },
      } as never;
    },
  };
  const workspaceRoot = mkdtempSync(
    join(tmpdir(), "aggregate-receipt-workspace-"),
  );
  const executor = openAggregateIntegrationReviewExecutor({
    database,
    workspaceRoot,
    reviewerExecutionAdapter,
    interaction: {
      createSession: () => ({ id: "aggregate-session" }) as never,
      addParticipant: () => {
        persistedSession = {
          sessionId: "aggregate-session",
          participantId: "aggregate-participant",
        };
        return { id: "aggregate-participant" } as never;
      },
    },
    pipelineRuntime: {
      inspectRun: () =>
        ({
          nodes: [{ id: "integration-node", pipelineNodeId: "integration" }],
          snapshot: {
            payload: {
              pipelineVersion: {
                graph: {
                  nodes: [
                    {
                      id: "integration",
                      executionProfileId: "review-profile",
                    },
                  ],
                },
              },
              department: { defaultExecutionProfileId: "review-profile" },
              executionProfiles: [
                {
                  id: "review-profile",
                  providerRef: "scripted",
                  model: "scripted-v1",
                  sandboxRef: "docker",
                  secretReferenceIds: [],
                  limits: { timeoutSeconds: 60, maxIterations: 1 },
                },
              ],
              positions: [
                {
                  id: "reviewer-position",
                  aiMember: { id: "reviewer-ai", status: "active" },
                },
              ],
            },
          },
        }) as never,
      inspectExecution: () => ({ facts: [], leases: [] }) as never,
      executeIntegrationReviewStage: async (execution) =>
        reviewerExecutionAdapter.execute(execution.request),
    },
    reviewRuntime,
  });
  return {
    executor,
    storage,
    workspaceRoot,
    repository,
    integratedCommit,
    adapterExecutions: () => adapterExecutions,
    recordMutations: () => recordMutations,
    executionStarted,
    releaseExecutions: () => releaseExecutions?.(),
  };
};

describe("Aggregate Integration Review executor", () => {
  it("uses the real Reviewer execution seam with an exact read-only multi-Repository bundle", async () => {
    const repository = mkdtempSync(join(tmpdir(), "aggregate-review-repo-"));
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "runtime@example.test"]);
    git(repository, ["config", "user.name", "Runtime"]);
    writeFileSync(join(repository, "result.txt"), "reviewed\n");
    git(repository, ["add", "result.txt"]);
    git(repository, ["commit", "-qm", "reviewed"]);
    const integratedCommit = git(repository, ["rev-parse", "HEAD"]);
    let recordedManifest: unknown;
    let adapterManifest: unknown;
    let bundledManifest: unknown;
    let selectedReviewer: string | undefined;
    let adapterExecutions = 0;
    const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
      onExecute: (request) => {
        adapterExecutions += 1;
        adapterManifest = request.manifest;
        bundledManifest = JSON.parse(
          readFileSync(
            join(request.workspaceRef, "inputs", "manifest.json"),
            "utf8",
          ),
        );
      },
      execute: () => ({
        status: "succeeded",
        providerId: "scripted-reviewer",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: ["isolation-receipt"],
        terminalExecutionFactId: "aggregate-terminal-fact",
        output: {
          result: "PASS",
          conditions: [],
          evidenceRefs: [integratedCommit],
        },
      }),
    });
    const fakeDatabase = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => undefined,
        all: () =>
          sql.includes("FROM integration_operations")
            ? [
                {
                  aiMemberId: "developer-ai-a",
                  positionId: "developer-position-a",
                  sessionId: "developer-session-a",
                },
                {
                  aiMemberId: "developer-ai-b",
                  positionId: "developer-position-b",
                  sessionId: "developer-session-b",
                },
              ]
            : [],
        run: () => ({ changes: 1 }),
      }),
    } as unknown as DatabaseSync;
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "aggregate-review-workspace-"),
    );
    const executor = openAggregateIntegrationReviewExecutor({
      database: fakeDatabase,
      workspaceRoot,
      reviewerExecutionAdapter,
      interaction: {
        createSession: () => ({ id: "aggregate-session" }) as never,
        addParticipant: () => ({ id: "aggregate-participant" }) as never,
      },
      pipelineRuntime: {
        inspectRun: () =>
          ({
            nodes: [{ id: "integration-node", pipelineNodeId: "integration" }],
            snapshot: {
              payload: {
                pipelineVersion: {
                  graph: {
                    nodes: [
                      {
                        id: "integration",
                        executionProfileId: "review-profile",
                      },
                    ],
                  },
                },
                department: { defaultExecutionProfileId: "review-profile" },
                executionProfiles: [
                  {
                    id: "review-profile",
                    providerRef: "scripted",
                    model: "scripted-v1",
                    sandboxRef: "docker",
                    secretReferenceIds: [],
                    limits: { timeoutSeconds: 60, maxIterations: 1 },
                  },
                ],
                positions: [
                  {
                    id: "developer-position-b",
                    aiMember: { id: "developer-ai-b", status: "active" },
                  },
                  {
                    id: "reviewer-position",
                    aiMember: { id: "reviewer-ai", status: "active" },
                  },
                ],
              },
            },
          }) as never,
        inspectExecution: () => ({ facts: [], leases: [] }) as never,
        executeIntegrationReviewStage: async (input) => {
          selectedReviewer = input.reviewerAiMemberId;
          return reviewerExecutionAdapter.execute(input.request);
        },
      },
      reviewRuntime: {
        inspect: () => {
          throw new Error("not recorded");
        },
        recordAggregateExecutionInTransaction: (input) => {
          recordedManifest = input.manifest;
          return {
            topic: { manifest: input.manifest },
            gateResult: { id: `quality-gate-${input.topicId}` },
          } as never;
        },
      },
    });
    const input = {
      operationKey: "generation-1:aggregate-review",
      generationId: "generation-1",
      manifestHash: "a".repeat(64),
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node",
      topicId: "integration-review:generation-1",
      repositoryCommits: [
        { repositoryId: repository, commit: integratedCommit },
      ],
      acceptanceCriteria: ["npm test"],
    };

    const result = await executor.execute(input);

    assert.deepEqual(result, {
      status: "completed",
      topicId: input.topicId,
      qualityGateResultId: `quality-gate-${input.topicId}`,
    });
    assert.deepEqual(adapterManifest, recordedManifest);
    assert.deepEqual(bundledManifest, {
      scope: "aggregate",
      topicId: input.topicId,
      supportingArtifactVersionIds: [],
      supportingSpecRevisionIds: [],
      harnessSnapshotIds: [],
      acceptanceCriteria: ["npm test"],
      excludedContext: [
        "hidden-prompts",
        "prior-reviewer-opinions",
        "private-transcripts",
      ],
      integrationGenerationId: input.generationId,
      integrationManifestHash: input.manifestHash,
      repositoryCommits: [
        { repositoryId: repository, commit: integratedCommit },
      ],
    });
    assert.equal(
      (adapterManifest as { readonly scope: string }).scope,
      "aggregate",
    );
    assert.equal(selectedReviewer, "reviewer-ai");

    const workspace = join(
      workspaceRoot,
      createHash("sha256").update(input.operationKey).digest("hex"),
      "repository-1",
    );
    chmodSync(workspace, 0o700);
    chmodSync(join(workspace, "result.txt"), 0o600);
    writeFileSync(join(workspace, "result.txt"), "drifted\n");
    writeFileSync(join(workspace, "untracked.txt"), "untracked\n");

    const drifted = await executor.execute(input);

    assert.equal(drifted.status, "unknown");
    assert.equal(adapterExecutions, 1);
  });

  it("reuses the frozen Reviewer Session when a running execution is reconciled", async () => {
    const repository = mkdtempSync(
      join(tmpdir(), "aggregate-review-reconcile-repo-"),
    );
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "runtime@example.test"]);
    git(repository, ["config", "user.name", "Runtime"]);
    writeFileSync(join(repository, "result.txt"), "reviewed\n");
    git(repository, ["add", "result.txt"]);
    git(repository, ["commit", "-qm", "reviewed"]);
    const integratedCommit = git(repository, ["rev-parse", "HEAD"]);
    let sessionCreates = 0;
    let participantCreates = 0;
    let persistedSession:
      | { readonly sessionId: string; readonly participantId: string }
      | undefined;
    let executionStarted = false;
    const fakeDatabase = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes("FROM interaction_sessions")) {
            return persistedSession;
          }
          return undefined;
        },
        all: () =>
          sql.includes("FROM integration_operations")
            ? [
                {
                  aiMemberId: "developer-ai",
                  positionId: "developer-position",
                  sessionId: "developer-session",
                },
              ]
            : [],
        run: () => ({ changes: 1 }),
      }),
    } as unknown as DatabaseSync;
    const executor = openAggregateIntegrationReviewExecutor({
      database: fakeDatabase,
      workspaceRoot: mkdtempSync(
        join(tmpdir(), "aggregate-review-reconcile-workspace-"),
      ),
      reviewerExecutionAdapter: createScriptedReviewerExecutionAdapter({
        execute: () => ({
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "provider result is not yet provable",
          evidence: [],
        }),
      }),
      interaction: {
        createSession: () => {
          sessionCreates += 1;
          return { id: "aggregate-session" } as never;
        },
        addParticipant: () => {
          participantCreates += 1;
          persistedSession = {
            sessionId: "aggregate-session",
            participantId: "aggregate-participant",
          };
          return { id: "aggregate-participant" } as never;
        },
      },
      pipelineRuntime: {
        inspectRun: () =>
          ({
            nodes: [{ id: "integration-node", pipelineNodeId: "integration" }],
            snapshot: {
              payload: {
                pipelineVersion: {
                  graph: {
                    nodes: [
                      {
                        id: "integration",
                        executionProfileId: "review-profile",
                      },
                    ],
                  },
                },
                department: { defaultExecutionProfileId: "review-profile" },
                executionProfiles: [
                  {
                    id: "review-profile",
                    providerRef: "scripted",
                    model: "scripted-v1",
                    sandboxRef: "docker",
                    secretReferenceIds: [],
                    limits: { timeoutSeconds: 60, maxIterations: 1 },
                  },
                ],
                positions: [
                  {
                    id: "reviewer-position",
                    aiMember: { id: "reviewer-ai", status: "active" },
                  },
                ],
              },
            },
          }) as never,
        inspectExecution: () =>
          (executionStarted
            ? { facts: [{}], leases: [] }
            : { facts: [], leases: [] }) as never,
        executeIntegrationReviewStage: async () => {
          executionStarted = true;
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message: "provider result is not yet provable",
            evidence: [],
          };
        },
      },
      reviewRuntime: {
        inspect: () => {
          throw new Error("not recorded");
        },
        recordAggregateExecutionInTransaction: () => {
          throw new Error("must not record an unknown execution");
        },
      },
    });
    const input = {
      operationKey: "generation-1:aggregate-review",
      generationId: "generation-1",
      manifestHash: "a".repeat(64),
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node",
      topicId: "integration-review:generation-1",
      repositoryCommits: [
        { repositoryId: repository, commit: integratedCommit },
      ],
      acceptanceCriteria: ["npm test"],
    };

    await executor.execute(input);
    await executor.reconcile(input);

    assert.equal(sessionCreates, 1);
    assert.equal(participantCreates, 1);
  });

  it("rejects a symlinked aggregate manifest input before Reviewer execution", async () => {
    const harness = openReceiptHarness();
    const input = {
      operationKey: "generation-symlink:aggregate-review",
      generationId: "generation-symlink",
      manifestHash: "a".repeat(64),
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node",
      topicId: "integration-review:generation-symlink",
      repositoryCommits: [
        {
          repositoryId: harness.repository,
          commit: harness.integratedCommit,
        },
      ],
      acceptanceCriteria: ["npm test"],
    };
    const bundleRoot = join(
      harness.workspaceRoot,
      createHash("sha256").update(input.operationKey).digest("hex"),
    );
    const externalInputs = mkdtempSync(
      join(tmpdir(), "aggregate-symlink-inputs-"),
    );
    mkdirSync(bundleRoot, { recursive: true });
    writeFileSync(
      join(externalInputs, "manifest.json"),
      canonicalJson({
        scope: "aggregate",
        topicId: input.topicId,
        supportingArtifactVersionIds: [],
        supportingSpecRevisionIds: [],
        harnessSnapshotIds: [],
        acceptanceCriteria: input.acceptanceCriteria,
        excludedContext: [
          "hidden-prompts",
          "prior-reviewer-opinions",
          "private-transcripts",
        ],
        integrationGenerationId: input.generationId,
        integrationManifestHash: input.manifestHash,
        repositoryCommits: input.repositoryCommits,
      }),
    );
    symlinkSync(externalInputs, join(bundleRoot, "inputs"));

    const result = await harness.executor.execute(input);

    assert.equal(result.status, "unknown");
    assert.equal(harness.adapterExecutions(), 0);
  });

  it("replays the exact aggregate record authority and rejects changed input", async () => {
    const harness = openReceiptHarness();
    const input = {
      operationKey: "generation-receipt:aggregate-review",
      generationId: "generation-receipt",
      manifestHash: "a".repeat(64),
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node",
      topicId: "integration-review:generation-receipt",
      repositoryCommits: [
        {
          repositoryId: harness.repository,
          commit: harness.integratedCommit,
        },
      ],
      acceptanceCriteria: ["npm test"],
    };

    const first = await harness.executor.execute(input);
    const replay = await harness.executor.execute(input);
    const changed = await harness.executor.execute({
      ...input,
      operationKey: "generation-receipt:changed-aggregate-review",
    });

    assert.deepEqual(replay, first);
    assert.equal(first.status, "completed");
    assert.equal(changed.status, "unknown");
    if (changed.status === "unknown") {
      assert.equal(changed.code, "INTEGRATION_AGGREGATE_REVIEW_CONFLICT");
    }
    assert.equal(harness.adapterExecutions(), 1);
    assert.equal(harness.recordMutations(), 1);
    assert.equal(
      Number(
        harness.storage
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(`${input.operationKey}:record`)!.count,
      ),
      1,
    );
  });

  it("returns one aggregate authority when concurrent recorders finish together", async () => {
    const harness = openReceiptHarness({ waitForConcurrentExecutions: true });
    const input = {
      operationKey: "generation-concurrent:aggregate-review",
      generationId: "generation-concurrent",
      manifestHash: "b".repeat(64),
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "integration-node",
      topicId: "integration-review:generation-concurrent",
      repositoryCommits: [
        {
          repositoryId: harness.repository,
          commit: harness.integratedCommit,
        },
      ],
      acceptanceCriteria: ["npm test"],
    };

    const leftPromise = harness.executor.execute(input);
    await harness.executionStarted;
    const rightPromise = harness.executor.execute(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrentExecutionCount = harness.adapterExecutions();
    harness.releaseExecutions();
    const [left, right] = await Promise.all([leftPromise, rightPromise]);

    assert.deepEqual(left, right);
    assert.equal(left.status, "completed");
    assert.equal(concurrentExecutionCount, 1);
    assert.equal(harness.adapterExecutions(), 1);
    assert.equal(harness.recordMutations(), 1);
    assert.equal(
      Number(
        harness.storage
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(`${input.operationKey}:record`)!.count,
      ),
      1,
    );
  });
});
