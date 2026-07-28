import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import type { CodeReviewView, CommandResult } from "../interface.js";
import {
  blockingReviewerWorkspaceAdapter,
  type ReviewerWorkspaceAdapter,
} from "./codeReviewRuntime.js";
import { openLocalReviewerWorkspaceAdapter } from "./reviewerWorkspace.js";

const companyDirs: string[] = [];

const runtimeActor = {
  type: "runtime-worker" as const,
  id: "delivery-coordinator-member",
  authenticatedBy: "runtime" as const,
};

const readyReviewerWorkspaceAdapter: ReviewerWorkspaceAdapter = {
  provision: ({ operationKey, manifest }) => ({
    status: "ready",
    providerId: "scripted-isolated-reviewer",
    workspaceRef: `reviewer-workspace:${operationKey}`,
    capabilities: {
      readOnlyFilesystem: true,
      independentGitDatabase: true,
      independentSessionStorage: true,
      independentCredentialScope: true,
      independentMutableCache: true,
      inputAllowlist: true,
      mechanism: "scripted-read-only-snapshot",
      mechanismVersion: "1",
    },
    evidence: [
      `commit:${manifest.sourceCommit}`,
      `diff:${manifest.diffHash}`,
      "readonly:true",
    ],
  }),
};

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const git = (repositoryRoot: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
  }).trim();

const canonicalDiff = (
  repositoryRoot: string,
  baseCommit: string,
  sourceCommit: string,
): Buffer =>
  execFileSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      baseCommit,
      sourceCommit,
      "--",
    ],
    { encoding: "buffer" },
  );

const makeWritableForCleanup = (path: string): void => {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) {
      makeWritableForCleanup(join(path, child));
    }
    return;
  }
  chmodSync(path, 0o600);
};

const setup = (adapter?: ReviewerWorkspaceAdapter) => {
  const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-code-review-"));
  companyDirs.push(companyDir);
  const repositoryRoot = join(companyDir, "repository");
  mkdirSync(repositoryRoot);
  execFileSync("git", ["init", "-q", repositoryRoot]);
  git(repositoryRoot, "config", "user.name", "Code Review Test");
  git(repositoryRoot, "config", "user.email", "review@test.invalid");
  mkdirSync(join(repositoryRoot, "src"));
  writeFileSync(
    join(repositoryRoot, "src", "reviewed.ts"),
    "export const reviewed = false;\n",
  );
  git(repositoryRoot, "add", "src/reviewed.ts");
  git(repositoryRoot, "commit", "-qm", "base");
  const baseCommit = git(repositoryRoot, "rev-parse", "HEAD");
  writeFileSync(
    join(repositoryRoot, "src", "reviewed.ts"),
    "export const reviewed = true;\n",
  );
  git(repositoryRoot, "add", "src/reviewed.ts");
  git(repositoryRoot, "commit", "-qm", "source");
  const sourceCommit = git(repositoryRoot, "rev-parse", "HEAD");
  const diffBytes = canonicalDiff(repositoryRoot, baseCommit, sourceCommit);
  const database = openCompanyDatabase(companyDir, {
    ...(adapter
      ? { codeReviewRuntime: { reviewerWorkspaceAdapter: adapter } }
      : {}),
  });
  const project = database.catalog.createProject({
    name: "Independent review",
    goal: "Gate one exact imported source commit",
  });
  database.projectConfiguration.update({
    projectId: project.id,
    expectedRevision: 0,
    name: project.name,
    goal: project.goal,
    sharedContext: "Review one exact Runtime-imported source commit.",
    repositoryReferences: [repositoryRoot],
  });
  const application = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "register-review-application",
    actor: {
      type: "human",
      id: "local-user",
      authenticatedBy: "local-session",
    },
    consumerId: "code-review-test",
    expectedRevision: 0,
    command: {
      type: "application.register",
      applicationId: "review-application",
      projectId: project.id,
      repositoryReference: repositoryRoot,
      applicationKey: "review-application",
      ownership: "software-rnd",
      buildCommand: "npm run build",
      testCommand: "npm test",
    },
  });
  assert.equal(application.status, "succeeded");
  const now = "2026-07-28T10:00:00.000Z";
  const snapshotPayload = {
    positions: [
      {
        id: "software-engineer",
        revision: 0,
        name: "Software Engineer",
        responsibility: "Implements one isolated Work Package.",
        defaultAgentId: "codex",
        resolvedAgentId: "codex",
        agentSource: "position-default",
        skillIds: [],
        aiMember: {
          id: "software-engineer-member",
          displayName: "Software Engineer",
          profile: "Repository-scoped developer",
          responsibilityMetadata: { focus: "development" },
          status: "active",
        },
      },
    ],
  };
  const snapshotJson = JSON.stringify(snapshotPayload);
  const snapshotHash = hash(snapshotJson);
  const manifest = {
    objective: "Implement the reviewed change.",
    acceptanceCriteria: ["The exact diff passes its contract tests."],
    moduleScope: ["src/reviewed.ts"],
    allowedPermissions: ["repository.write"],
    specRefs: ["application-spec:r1", "project-spec:r1"],
    harnessRefs: ["harness:tdd@1"],
    assignmentCriteria: { positionIds: ["software-engineer"] },
    expectedArtifacts: ["canonical-diff"],
    selfCheckCommands: ["npm test"],
    codeReviewConditions: ["Independent PASS required"],
    integrationConditions: ["No open cross-application obligations"],
    riskTier: "medium",
    recoveryPolicy: "Create a fresh Version and Attempt.",
    execution: {
      profileId: "software-rnd-local-isolated-git",
      branchStrategy: "branch",
      gitRefWriteIsolation: true,
      runtimeImportOnly: true,
    },
  };
  const selfCheck = {
    status: "passed",
    commands: ["npm test"],
    logRefs: ["artifact:self-check-log"],
    commitEvidence: [sourceCommit],
    summary: "Self-check passed.",
    approval: false,
  };
  const producerSession = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  database.interaction.addParticipant({
    sessionId: producerSession.id,
    participantType: "ai-member",
    participantRef: "software-engineer-member",
    role: "developer",
  });
  const raw = new DatabaseSync(database.path);
  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw
      .prepare(
        `INSERT INTO department_runs(
           id, project_id, department_id, status, created_at,
           pipeline_version_id, snapshot_revision_id, revision, updated_at
         ) VALUES ('review-run', ?, 'software-rnd', 'running', ?,
                   'software-rnd-pipeline-v1', 'review-snapshot', 0, ?)`,
      )
      .run(project.id, now, now);
    raw
      .prepare(
        `INSERT INTO run_snapshot_revisions(
           id, run_id, revision, schema_version, canonical_json, hash,
           created_at, parent_revision
         ) VALUES ('review-snapshot', 'review-run', 1, 1, ?, ?, ?, NULL)`,
      )
      .run(snapshotJson, snapshotHash, now);
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('review-node', 'review-run', 'development', 'ai-task',
                   'succeeded', 1, '[]', ?, ?, 'development@1', ?, ?)`,
      )
      .run(now, now, "4".repeat(64), "5".repeat(64));
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('code-review-node', 'review-run', 'review', 'ai-task',
                   'ready', 0, '["development"]', ?, ?, 'code-review@1', ?, ?)`,
      )
      .run(now, now, "a".repeat(64), "b".repeat(64));
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('integration-node', 'review-run', 'integration', 'ai-task',
                   'queued', 0, '["review"]', ?, ?, 'integration@1', ?, ?)`,
      )
      .run(now, now, "c".repeat(64), "d".repeat(64));
    raw
      .prepare(
        `INSERT INTO node_attempts(
           id, node_run_id, attempt_number, snapshot_revision_id, reason,
           status, created_at, started_at, completed_at, recoverable
         ) VALUES ('review-attempt', 'review-node', 1, 'review-snapshot',
                   'initial', 'succeeded', ?, ?, ?, 0)`,
      )
      .run(now, now, now);
    raw
      .prepare(
        `INSERT INTO technical_baselines(
           id, project_id, run_id, proposal_revision_id, manifest_json,
           manifest_hash, created_at
         ) VALUES ('review-baseline', ?, 'review-run', 'review-proposal',
                   '{}', ?, ?)`,
      )
      .run(project.id, "6".repeat(64), now);
    raw
      .prepare(
        `INSERT INTO work_packages(
           id, project_id, run_id, technical_baseline_id, state, revision,
           created_at, updated_at
         ) VALUES ('review-package', ?, 'review-run', 'review-baseline',
                   'self-check', 4, ?, ?)`,
      )
      .run(project.id, now, now);
    raw
      .prepare(
        `INSERT INTO work_package_versions(
           id, work_package_id, version, application_id,
           repository_reference, node_run_id, manifest_json, manifest_hash,
           status, created_at
         ) VALUES ('review-package-v1', 'review-package', 1,
                   'review-application', ?,
                   'review-node', ?, ?, 'ready', ?)`,
      )
      .run(
        repositoryRoot,
        JSON.stringify(manifest),
        hash(JSON.stringify(manifest)),
        now,
      );
    raw
      .prepare(
        `INSERT INTO workspace_allocations(
           id, project_id, application_id, execution_profile_id,
           execution_profile_revision, operation_key, state, repository_root,
           allocation_root, source_branch, base_commit, expected_source_tip,
           capability_snapshot_json, capability_snapshot_hash,
           provision_command_id, revision, created_at, updated_at,
           work_package_version_id, node_attempt_id, interaction_session_id,
           sandbox_identity, evidence_scope
         ) VALUES ('review-allocation', ?, 'review-application',
                   'software-rnd-local-isolated-git', 0, 'review-operation',
                   'ready', ?, ?,
                   'sandcastle/review', ?, ?, '{}', ?, 'review-provision', 1,
                   ?, ?, 'review-package-v1', 'review-attempt', ?,
                   'review-sandbox', 'review-evidence')`,
      )
      .run(
        project.id,
        repositoryRoot,
        join(companyDir, "allocation"),
        baseCommit,
        baseCommit,
        "7".repeat(64),
        now,
        now,
        producerSession.id,
      );
    raw
      .prepare(
        `INSERT INTO workspace_imports(
           id, allocation_id, command_id, request_hash, state,
           expected_source_tip, before_source_tip, result_commit,
           object_set_hash, receipt_json, created_at, updated_at
         ) VALUES ('review-import', 'review-allocation', 'review-import-command',
                   ?, 'succeeded', ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        "8".repeat(64),
        baseCommit,
        baseCommit,
        sourceCommit,
        "9".repeat(64),
        now,
        now,
      );
    raw
      .prepare(
        `INSERT INTO work_package_assignments(
           id, work_package_version_id, node_attempt_id, position_id,
           ai_member_id, agent_adapter_id, rationale_json, allocation_id,
           interaction_session_id, sandbox_identity, evidence_scope, state,
           created_at, updated_at
         ) VALUES ('review-assignment', 'review-package-v1', 'review-attempt',
                   'software-engineer', 'software-engineer-member', 'codex',
                   '{}', 'review-allocation', ?, 'review-sandbox',
                   'review-evidence', 'self-check-passed', ?, ?)`,
      )
      .run(producerSession.id, now, now);
    raw
      .prepare(
        `INSERT INTO work_package_self_checks(
           id, assignment_id, node_attempt_id, status, report_json,
           report_hash, created_at
         ) VALUES ('review-self-check', 'review-assignment', 'review-attempt',
                   'passed', ?, ?, ?)`,
      )
      .run(JSON.stringify(selfCheck), hash(JSON.stringify(selfCheck)), now);
  } finally {
    raw.close();
  }
  const diff = database.artifactRegistry.registerVersion({
    projectId: project.id,
    type: "canonical-diff",
    schemaVersion: "1",
    logicalName: "review-package-diff",
    content: diffBytes,
    status: "produced",
    producer: {
      runId: "review-run",
      nodeRunId: "review-node",
      nodeAttemptId: "review-attempt",
      snapshotRevisionId: "review-snapshot",
      aiMemberId: "software-engineer-member",
      positionId: "software-engineer",
      sessionId: producerSession.id,
      workPackageId: "review-package",
    },
  });
  const execute = (
    commandId: string,
    expectedRevision: number,
    command: Record<string, unknown>,
    actor = runtimeActor,
  ): CommandResult<CodeReviewView> =>
    database.commandRegistry.execute({
      schemaVersion: 1,
      commandId,
      actor,
      consumerId: "code-review-test",
      expectedRevision,
      command: command as never,
    }) as CommandResult<CodeReviewView>;
  return {
    companyDir,
    database,
    projectId: project.id,
    diff,
    repositoryRoot,
    baseCommit,
    sourceCommit,
    diffBytes,
    producerSessionId: producerSession.id,
    execute,
  };
};

const startCommand = (
  fixture: ReturnType<typeof setup>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "code-review.start",
  codeReviewId: "code-review-1",
  topicId: "code-review-topic-1",
  workPackageId: "review-package",
  diffArtifactVersionId: fixture.diff.id,
  reviewerPositionId: "reviewer",
  freshReviewerPositionId: "software-architect",
  moderatorPositionId: "evaluator",
  ...overrides,
});

const completeGenericReview = (
  fixture: ReturnType<typeof setup>,
  result: "PASS" | "CONDITIONAL_PASS" | "FAIL",
  options: {
    readonly omitInitialFinding?: boolean;
    readonly freshSessionMode?: "consultation" | "run-collaboration";
  } = {},
) => {
  const started = fixture.execute("start-review", 4, startCommand(fixture));
  assert.equal(started.status, "succeeded");
  const ready =
    fixture.database.codeReviews.reconcileReviewerWorkspace("code-review-1");
  if (!options.omitInitialFinding) {
    const initialFinding = fixture.database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `review-finding-${result}`,
      actor: {
        type: "runtime-worker",
        id: "reviewer-member",
        authenticatedBy: "runtime",
      },
      consumerId: "code-review-test",
      expectedRevision: 2,
      command: {
        type: "review.finding.submit",
        topicId: ready.topicId,
        findingId: `review-finding-${result}`,
        reviewerParticipantId: "code-review-1:reviewer",
        reviewerSessionId: ready.workspace.reviewerSessionId,
        severity: "info",
        summary: "The exact canonical diff was independently inspected.",
        rationale: "Record the required independent finding before revision.",
        impact: "No blocking issue was found in the reviewed input.",
        evidenceRefs: [ready.manifest.diffArtifactVersionId],
        suggestedOwner: "software-engineer",
        blocking: false,
      },
    });
    assert.equal(initialFinding.status, "succeeded");
  }
  const ownerExpectedRevision = options.omitInitialFinding ? 2 : 3;
  const ownerResult = fixture.database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `review-revision-${result}`,
    actor: {
      type: "runtime-worker",
      id: "software-engineer-member",
      authenticatedBy: "runtime",
    },
    consumerId: "code-review-test",
    expectedRevision: ownerExpectedRevision,
    command: {
      type: "review.revision.submit",
      topicId: ready.topicId,
      revisionId: `review-revision-${result}`,
      ownerParticipantId: "code-review-1:owner",
      subjectKind: "canonical-diff",
      subjectId: ready.manifest.diffArtifactVersionId,
      subjectHash: ready.manifest.diffHash,
      producerAiMemberId: "software-engineer-member",
      producerPositionId: "software-engineer",
      producerSessionId: fixture.producerSessionId,
      evidenceRefs: [ready.manifest.selfCheck.id],
    },
  });
  assert.equal(ownerResult.status, "succeeded");
  const freshParticipant = fixture.database.review
    .inspect(ready.topicId)
    .participants.find(
      (participant) => participant.id === "code-review-1:fresh-reviewer",
    );
  assert.ok(freshParticipant);
  const freshSession = fixture.database.interaction.createSession({
    projectId: ready.manifest.projectId,
    mode: options.freshSessionMode ?? "run-collaboration",
    ...((options.freshSessionMode ?? "run-collaboration") ===
    "run-collaboration"
      ? {
          runId: ready.manifest.runId,
          nodeRunId: ready.workspace.reviewNodeRunId,
        }
      : {}),
  });
  fixture.database.interaction.addParticipant({
    sessionId: freshSession.id,
    participantType: "ai-member",
    participantRef: freshParticipant.aiMemberId,
    role: "fresh-code-reviewer",
  });
  const recheck = fixture.database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `review-recheck-${result}`,
    actor: {
      type: "runtime-worker",
      id: freshParticipant.aiMemberId,
      authenticatedBy: "runtime",
    },
    consumerId: "code-review-test",
    expectedRevision: ownerExpectedRevision + 1,
    command: {
      type: "review.recheck.submit",
      topicId: ready.topicId,
      recheckId: `review-recheck-${result}`,
      revisionId: `review-revision-${result}`,
      reviewerParticipantId: freshParticipant.id,
      reviewerSessionId: freshSession.id,
      result,
      conditions:
        result === "CONDITIONAL_PASS"
          ? ["Resolve the recorded obligation"]
          : [],
      evidenceRefs: [ready.manifest.diffArtifactVersionId],
    },
  });
  assert.equal(recheck.status, "succeeded");
  return fixture.database.codeReviews.inspect("review-run")[0]!;
};

afterEach(() => {
  for (const directory of companyDirs.splice(0)) {
    if (lstatSync(directory).isDirectory()) makeWritableForCleanup(directory);
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  }
});

describe("Code Review Runtime", () => {
  it("installs the independent Code Review authority schema", () => {
    const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-code-review-"));
    companyDirs.push(companyDir);
    const database = openCompanyDatabase(companyDir);
    try {
      assert.equal(CURRENT_SCHEMA_VERSION, 43);
      assert.equal(database.schemaVersion(), 43);
    } finally {
      database.close();
    }
  });

  it("freezes the exact imported commit, canonical diff, self-check, and fresh reviewer Session", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const started = fixture.execute("start-review", 4, startCommand(fixture));
      assert.equal(started.status, "succeeded");
      if (started.status !== "succeeded") return;
      assert.equal(started.value.workspace.state, "intent");
      const ready =
        fixture.database.codeReviews.reconcileReviewerWorkspace(
          "code-review-1",
        );
      assert.equal(ready.workspace.state, "ready");
      assert.equal(ready.manifest.workPackageVersionId, "review-package-v1");
      assert.equal(ready.manifest.assignmentId, "review-assignment");
      assert.equal(ready.manifest.workspaceImportId, "review-import");
      assert.equal(ready.manifest.sourceCommit, fixture.sourceCommit);
      assert.equal(ready.manifest.diffArtifactVersionId, fixture.diff.id);
      assert.equal(ready.manifest.diffHash, fixture.diff.contentHash);
      assert.equal(ready.manifest.selfCheck.id, "review-self-check");
      assert.notEqual(
        ready.workspace.reviewerSessionId,
        fixture.producerSessionId,
      );
      assert.deepEqual(ready.gateResult, null);
      assert.equal(
        fixture.database.review
          .inspect(ready.topicId)
          .participants.filter(
            (participant) => participant.role === "reviewer-participant",
          ).length,
        2,
      );
      assert.equal(ready.workspace.reviewNodeRunId, "code-review-node");
      assert.equal(
        fixture.database.interaction.inspectSession(
          ready.workspace.reviewerSessionId,
        ).session.nodeRunId,
        "code-review-node",
      );
      assert.equal(
        fixture.database.review.inspect(ready.topicId).topic.status,
        "independent-review",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("rejects producer self-review before creating a Topic or reviewer Workspace", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const result = fixture.execute(
        "reject-self-review",
        4,
        startCommand(fixture, { reviewerPositionId: "software-engineer" }),
      );
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") return;
      assert.equal(result.error.code, "REVIEWER_INELIGIBLE");
      assert.deepEqual(fixture.database.codeReviews.inspect("review-run"), []);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a Diff Artifact with the wrong type, schema, content kind, or canonical bytes", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const producer = fixture.diff.producer;
      const wrongType = fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.projectId,
        type: "implementation-log",
        schemaVersion: "1",
        logicalName: "wrong-type-diff",
        content: fixture.diffBytes,
        status: "produced",
        producer,
      });
      const wrongSchema = fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.projectId,
        type: "canonical-diff",
        schemaVersion: "2",
        logicalName: "wrong-schema-diff",
        content: fixture.diffBytes,
        status: "produced",
        producer,
      });
      const wrongBytes = fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.projectId,
        type: "canonical-diff",
        schemaVersion: "1",
        logicalName: "wrong-bytes-diff",
        content: "not the canonical Git diff\n",
        status: "produced",
        producer,
      });
      const repositoryObject = fixture.database.artifactRegistry.register({
        projectId: fixture.projectId,
        type: "canonical-diff",
        schemaVersion: "1",
        logicalName: "wrong-content-kind-diff",
        content: {
          kind: "repository-object",
          repositoryRef: fixture.repositoryRoot,
          commitId: fixture.sourceCommit,
          objectId: fixture.sourceCommit,
          objectKind: "commit",
        },
        producer: { projectId: fixture.projectId, ...producer },
      });
      const wrongContentKind = fixture.database.artifactRegistry.finalize({
        registrationId: repositoryObject.registrationId,
      });

      for (const [suffix, diffArtifactVersionId] of [
        ["type", wrongType.id],
        ["schema", wrongSchema.id],
        ["bytes", wrongBytes.id],
        ["content-kind", wrongContentKind.id],
      ] as const) {
        const result = fixture.execute(
          `reject-diff-${suffix}`,
          4,
          startCommand(fixture, {
            codeReviewId: `code-review-${suffix}`,
            topicId: `code-review-topic-${suffix}`,
            diffArtifactVersionId,
          }),
        );
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
          assert.equal(result.error.code, "CODE_REVIEW_DIFF_INVALID");
        }
      }
    } finally {
      fixture.database.close();
    }
  });

  it("provisions the default local Reviewer Workspace at the exact commit with an independent read-only Git database", () => {
    const fixture = setup();
    try {
      const started = fixture.execute(
        "start-local-review",
        4,
        startCommand(fixture),
      );
      assert.equal(started.status, "succeeded");
      const ready =
        fixture.database.codeReviews.reconcileReviewerWorkspace(
          "code-review-1",
        );
      assert.equal(ready.workspace.state, "ready");
      assert.equal(ready.workspace.providerId, "local-isolated-reviewer");
      assert.ok(ready.workspace.workspaceRef);
      const sourcePath = join(ready.workspace.workspaceRef!, "source");
      assert.equal(git(sourcePath, "rev-parse", "HEAD"), fixture.sourceCommit);
      assert.equal(git(sourcePath, "remote"), "");
      assert.notEqual(
        realpathSync(
          join(sourcePath, git(sourcePath, "rev-parse", "--git-common-dir")),
        ),
        realpathSync(
          join(
            fixture.repositoryRoot,
            git(fixture.repositoryRoot, "rev-parse", "--git-common-dir"),
          ),
        ),
      );
      assert.equal(
        statSync(join(sourcePath, "src", "reviewed.ts")).mode & 0o222,
        0,
      );
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(ready.workspace.workspaceRef!, "inputs", "manifest.json"),
            "utf8",
          ),
        ),
        JSON.parse(JSON.stringify(ready.manifest)),
      );
      assert.deepEqual(
        readFileSync(
          join(ready.workspace.workspaceRef!, "inputs", "canonical.diff"),
        ),
        fixture.diffBytes,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("blocks the local Reviewer Workspace when the frozen Repository path is missing", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const started = fixture.execute(
        "start-missing-local-repository",
        4,
        startCommand(fixture),
      );
      assert.equal(started.status, "succeeded");
      if (started.status !== "succeeded") return;
      const adapter = openLocalReviewerWorkspaceAdapter(fixture.companyDir);
      const result = adapter.provision({
        operationKey: "missing-local-repository",
        manifest: {
          ...started.value.manifest,
          repositoryReference: join(fixture.companyDir, "missing-repository"),
        },
        reviewer: {
          aiMemberId: "reviewer-member",
          positionId: "reviewer",
          sessionId: started.value.workspace.reviewerSessionId,
        },
      });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") {
        assert.equal(result.code, "PROVIDER_ISOLATION_REQUIRED");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("blocks formal review when reviewer isolation cannot be proven and preserves replay", () => {
    const fixture = setup(blockingReviewerWorkspaceAdapter);
    try {
      const first = fixture.execute(
        "start-blocked-review",
        4,
        startCommand(fixture),
      );
      const replay = fixture.execute(
        "start-blocked-review",
        4,
        startCommand(fixture),
      );
      assert.deepEqual(replay, first);
      const blocked =
        fixture.database.codeReviews.reconcileReviewerWorkspace(
          "code-review-1",
        );
      assert.equal(blocked.workspace.state, "blocked");
      assert.equal(
        blocked.workspace.failureCode,
        "PROVIDER_ISOLATION_REQUIRED",
      );
      assert.equal(blocked.integrationEligible, false);
      assert.equal(
        fixture.database.review.inspect(blocked.topicId).topic.status,
        "blocked",
      );
      const runBlocked = fixture.database.events
        .readAfter(0, 1_000)
        .find(
          (event) =>
            event.type === "run.blocked" &&
            event.nodeRunId === "code-review-node",
        );
      assert.ok(runBlocked);
      assert.deepEqual(runBlocked.payload, {
        status: "blocked",
        revision: 2,
        nodeStatus: "blocked",
        reason: "code-review-isolation",
        failure: {
          code: "PROVIDER_ISOLATION_REQUIRED",
          message:
            "No reviewer provider proved an independent read-only Workspace, Session storage, credentials, and mutable cache.",
        },
      });
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.deepEqual(
          {
            ...(raw
              .prepare(
                `SELECT status, failure_code AS failureCode
                 FROM node_attempts WHERE node_run_id = 'code-review-node'
             ORDER BY attempt_number DESC LIMIT 1`,
              )
              .get() as Record<string, unknown>),
          },
          {
            status: "failed",
            failureCode: "PROVIDER_ISOLATION_REQUIRED",
          },
        );
        assert.deepEqual(
          {
            ...(raw
              .prepare(
                `SELECT command_id AS commandId, actor_type AS actorType,
                        actor_id AS actorId, authenticated_by AS authenticatedBy,
                        consumer_id AS consumerId
                   FROM runtime_audit_records
                  WHERE action = 'run.code-review-blocked'
               ORDER BY created_at DESC, id DESC LIMIT 1`,
              )
              .get() as Record<string, unknown>),
          },
          {
            commandId: "reconcile:code-review:code-review-1:workspace",
            actorType: "runtime-worker",
            actorId: "code-review-workspace-reconciler",
            authenticatedBy: "runtime",
            consumerId: "code-review-workspace-reconciler",
          },
        );
        assert.deepEqual(
          {
            ...(raw
              .prepare(
                `SELECT status, consumer_id AS consumerId
                   FROM command_deduplication WHERE command_id = ?`,
              )
              .get("reconcile:code-review:code-review-1:workspace") as Record<
              string,
              unknown
            >),
          },
          {
            status: "completed",
            consumerId: "code-review-workspace-reconciler",
          },
        );
        assert.equal(
          raw
            .prepare(
              "SELECT 1 FROM runtime_unit_of_work_context WHERE slot = 1",
            )
            .get(),
          undefined,
        );
      } finally {
        raw.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("creates immutable PASS-only Integration authority bound to the exact current Version", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      assert.equal(reviewed.gateResult?.result, "PASS");
      const converged = fixture.execute("converge-pass", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      assert.equal(converged.value.integrationEligible, true);
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.deepEqual(
          {
            ...(raw
              .prepare(
                `SELECT
                 (SELECT status FROM node_runs WHERE id = 'code-review-node') AS reviewStatus,
                 (SELECT status FROM node_attempts
                   WHERE node_run_id = 'code-review-node'
                ORDER BY attempt_number DESC LIMIT 1) AS attemptStatus,
                 (SELECT status FROM node_runs WHERE id = 'integration-node') AS successorStatus`,
              )
              .get() as Record<string, unknown>),
          },
          {
            reviewStatus: "succeeded",
            attemptStatus: "succeeded",
            successorStatus: "ready",
          },
        );
      } finally {
        raw.close();
      }
      assert.equal(
        converged.value.authority?.qualityGateResultId,
        reviewed.gateResult?.id,
      );
      assert.equal(
        converged.value.authority?.workPackageVersionId,
        "review-package-v1",
      );
      const duplicate = fixture.execute("converge-pass-again", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(duplicate.status, "succeeded");
      if (duplicate.status === "succeeded") {
        assert.equal(
          duplicate.value.authority?.id,
          converged.value.authority?.id,
        );
      }
      assert.equal(
        fixture.database.events
          .readAfter(0, 1_000)
          .filter((event) => event.type === "code-review.authority.created")
          .length,
        1,
      );
      assert.equal(
        converged.value.authority?.sourceCommit,
        fixture.sourceCommit,
      );
      assert.equal(
        converged.value.authority?.diffHash,
        fixture.diff.contentHash,
      );
      assert.throws(() => {
        const raw = new DatabaseSync(fixture.database.path);
        try {
          raw
            .prepare(
              "UPDATE code_review_authorities SET source_commit = ? WHERE id = ?",
            )
            .run("f".repeat(40), converged.value.authority!.id);
        } finally {
          raw.close();
        }
      }, /immutable/);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects convergence without an initial independent Finding", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS", {
        omitInitialFinding: true,
      });
      const converged = fixture.execute("reject-missing-finding", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "rejected");
      if (converged.status === "rejected") {
        assert.equal(
          converged.error.code,
          "CODE_REVIEW_REVIEW_PROTOCOL_INVALID",
        );
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rejects convergence when the fresh re-review Session is not bound to the Code Review Node", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS", {
        freshSessionMode: "consultation",
      });
      const converged = fixture.execute("reject-unbound-recheck", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "rejected");
      if (converged.status === "rejected") {
        assert.equal(
          converged.error.code,
          "CODE_REVIEW_REVIEW_PROTOCOL_INVALID",
        );
      }
    } finally {
      fixture.database.close();
    }
  });

  it("turns FAIL into a Defect and a fresh Work Package Version, Attempt, allocation, and Session", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "FAIL");
      const converged = fixture.execute("converge-fail", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
        reworkVersionId: "review-package-v2",
        reworkBaseCommit: reviewed.manifest.sourceCommit,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      assert.equal(converged.value.integrationEligible, false);
      assert.equal(converged.value.authority, null);
      assert.equal(converged.value.defects[0]?.result, "FAIL");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.deepEqual(
          {
            ...(raw
              .prepare(
                `SELECT
                 (SELECT status FROM node_runs WHERE id = 'code-review-node') AS reviewStatus,
                 (SELECT status FROM node_attempts
                   WHERE node_run_id = 'code-review-node'
                ORDER BY attempt_number DESC LIMIT 1) AS attemptStatus,
                 (SELECT status FROM node_runs WHERE id = 'integration-node') AS successorStatus`,
              )
              .get() as Record<string, unknown>),
          },
          {
            reviewStatus: "blocked",
            attemptStatus: "failed",
            successorStatus: "queued",
          },
        );
      } finally {
        raw.close();
      }
      assert.equal(
        converged.value.defects[0]?.reworkWorkPackageVersionId,
        "review-package-v2",
      );
      const graph = fixture.database.workPackages.inspect("review-run");
      const workPackage = graph.packages[0]!;
      assert.equal(workPackage.versions.length, 2);
      const oldAssignment = workPackage.versions[0]!.assignments[0]!;
      const freshAssignment = workPackage.versions[1]!.assignments[0]!;
      assert.equal(oldAssignment.state, "superseded");
      assert.notEqual(
        freshAssignment.nodeAttemptId,
        oldAssignment.nodeAttemptId,
      );
      assert.notEqual(freshAssignment.allocationId, oldAssignment.allocationId);
      assert.notEqual(
        freshAssignment.interactionSessionId,
        oldAssignment.interactionSessionId,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("treats CONDITIONAL_PASS as a blocking obligation with the same fresh rework loop", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "CONDITIONAL_PASS");
      const converged = fixture.execute("converge-conditional", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
        reworkVersionId: "review-package-v2",
        reworkBaseCommit: reviewed.manifest.sourceCommit,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      assert.equal(converged.value.integrationEligible, false);
      assert.equal(converged.value.authority, null);
      assert.equal(converged.value.defects[0]?.result, "CONDITIONAL_PASS");
      assert.deepEqual(
        (converged.value.defects[0]?.obligation as { conditions: string[] })
          .conditions,
        ["Resolve the recorded obligation"],
      );
      assert.equal(
        fixture.database.workPackages.inspect("review-run").packages[0]
          ?.versions[1]?.id,
        "review-package-v2",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a historical PASS after the reviewed Version is superseded", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const reworked = fixture.database.workPackages.reworkInTransaction({
        commandId: "supersede-before-converge",
        actor: runtimeActor,
        expectedRevision: 4,
        workPackageId: "review-package",
        versionId: "review-package-v2",
        baseCommit: reviewed.manifest.sourceCommit,
        recoveryReason: "Supersede the reviewed Version.",
      });
      assert.equal(reworked.packages[0]?.versions.length, 2);
      const stale = fixture.execute("reject-stale-pass", 5, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(stale.status, "rejected");
      if (stale.status !== "rejected") return;
      assert.equal(stale.error.code, "CODE_REVIEW_AUTHORITY_STALE");
      assert.equal(
        fixture.database.codeReviews.inspect("review-run")[0]!
          .integrationEligible,
        false,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("makes an existing Authority ineligible when its Version is later superseded", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const converged = fixture.execute("converge-before-supersede", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      assert.equal(converged.value.integrationEligible, true);

      fixture.database.workPackages.reworkInTransaction({
        commandId: "supersede-after-authority",
        actor: runtimeActor,
        expectedRevision: 4,
        workPackageId: reviewed.manifest.workPackageId,
        versionId: "review-package-v2",
        baseCommit: reviewed.manifest.sourceCommit,
        recoveryReason: "Invalidate historical Code Review authority.",
      });

      const historical = fixture.database.codeReviews.inspect("review-run")[0]!;
      assert.ok(historical.authority);
      assert.equal(historical.integrationEligible, false);
    } finally {
      fixture.database.close();
    }
  });

  it("makes an existing Authority ineligible while any Code Review obligation is open", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const converged = fixture.execute("converge-before-obligation", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `INSERT INTO review_topics(
               id, project_id, run_id, title, kind, status, revision,
               manifest_json, manifest_hash, producer_ai_member_id,
               producer_position_id, producer_session_id, quorum, budget_json,
               rounds_used, duration_seconds_used, tokens_used, cost_cents_used,
               stop_condition, escalation_policy, created_at, updated_at
             )
             SELECT 'historical-code-review-topic', project_id, run_id, title,
                    kind, status, revision, manifest_json, manifest_hash,
                    producer_ai_member_id, producer_position_id,
                    producer_session_id, quorum, budget_json, rounds_used,
                    duration_seconds_used, tokens_used, cost_cents_used,
                    stop_condition, escalation_policy, created_at, updated_at
               FROM review_topics WHERE id = ?`,
          )
          .run(reviewed.topicId);
        raw
          .prepare(
            `INSERT INTO code_review_manifests(
               id, topic_id, project_id, run_id, snapshot_revision_id,
               work_package_id, work_package_version_id, assignment_id,
               node_attempt_id, workspace_import_id, diff_artifact_version_id,
               manifest_json, manifest_hash, created_at
             )
             SELECT 'historical-code-review', 'historical-code-review-topic',
                    project_id, run_id, snapshot_revision_id, work_package_id,
                    work_package_version_id, assignment_id, node_attempt_id,
                    workspace_import_id, diff_artifact_version_id,
                    manifest_json, manifest_hash, created_at
               FROM code_review_manifests WHERE id = ?`,
          )
          .run(reviewed.id);
        raw
          .prepare(
            `INSERT INTO interaction_sessions(
               id, mode, project_id, run_id, node_run_id, status, created_at,
               closed_at
             )
             SELECT 'historical-reviewer-session', mode, project_id, run_id,
                    node_run_id, status, created_at, closed_at
               FROM interaction_sessions WHERE id = ?`,
          )
          .run(reviewed.workspace.reviewerSessionId);
        raw
          .prepare(
            `INSERT INTO reviewer_workspace_intents(
               id, code_review_manifest_id, operation_key, state,
               reviewer_ai_member_id, reviewer_position_id,
               reviewer_session_id, review_node_run_id, provider_id,
               workspace_ref, capability_snapshot_json,
               capability_snapshot_hash, independence_evidence_json,
               failure_code, failure_message, created_at, updated_at
             )
             SELECT 'historical-reviewer-workspace',
                    'historical-code-review',
                    'code-review:historical-code-review:workspace', state,
                    reviewer_ai_member_id, reviewer_position_id,
                    'historical-reviewer-session', review_node_run_id,
                    provider_id, workspace_ref, capability_snapshot_json,
                    capability_snapshot_hash, independence_evidence_json,
                    failure_code, failure_message, created_at, updated_at
               FROM reviewer_workspace_intents
              WHERE code_review_manifest_id = ?`,
          )
          .run(reviewed.id);
        raw
          .prepare(
            `INSERT INTO code_review_defects(
               id, code_review_manifest_id, quality_gate_result_id,
               work_package_id, result, finding_ids_json, obligation_json,
               rework_work_package_version_id, status, created_at
             ) VALUES ('late-obligation', ?, ?, ?, 'FAIL', '[]', '{}', NULL,
                       'open', '2026-07-28T10:02:00.000Z')`,
          )
          .run(
            "historical-code-review",
            reviewed.gateResult!.id,
            reviewed.manifest.workPackageId,
          );
      } finally {
        raw.close();
      }
      assert.equal(
        fixture.database.codeReviews
          .inspect("review-run")
          .find((review) => review.id === reviewed.id)?.integrationEligible,
        false,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("closes a tracked rework obligation when fresh PASS reviews its exact Version", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `INSERT INTO review_topics(
               id, project_id, run_id, title, kind, status, revision,
               manifest_json, manifest_hash, producer_ai_member_id,
               producer_position_id, producer_session_id, quorum, budget_json,
               rounds_used, duration_seconds_used, tokens_used, cost_cents_used,
               stop_condition, escalation_policy, created_at, updated_at
             )
             SELECT 'rework-obligation-topic', project_id, run_id, title,
                    kind, 'FAIL', revision, manifest_json, manifest_hash,
                    producer_ai_member_id, producer_position_id,
                    producer_session_id, quorum, budget_json, rounds_used,
                    duration_seconds_used, tokens_used, cost_cents_used,
                    stop_condition, escalation_policy, created_at, updated_at
               FROM review_topics WHERE id = ?`,
          )
          .run(reviewed.topicId);
        raw
          .prepare(
            `INSERT INTO quality_gate_results(
               id, topic_id, kind, manifest_json, manifest_hash, revision_id,
               result, conditions_json, recheck_ids_json, evidence_refs_json,
               created_at
             )
             SELECT 'rework-obligation-gate', 'rework-obligation-topic', kind,
                    manifest_json, manifest_hash, revision_id, 'FAIL',
                    conditions_json, recheck_ids_json, evidence_refs_json,
                    created_at
               FROM quality_gate_results WHERE id = ?`,
          )
          .run(reviewed.gateResult!.id);
        raw
          .prepare(
            `INSERT INTO code_review_defects(
               id, code_review_manifest_id, quality_gate_result_id,
               work_package_id, result, finding_ids_json, obligation_json,
               rework_work_package_version_id, status, created_at
             ) VALUES ('rework-obligation', ?, ?, ?, 'FAIL', '[]', '{}', ?,
                       'rework-created', '2026-07-28T10:02:00.000Z')`,
          )
          .run(
            reviewed.id,
            "rework-obligation-gate",
            reviewed.manifest.workPackageId,
            reviewed.manifest.workPackageVersionId,
          );
      } finally {
        raw.close();
      }

      const converged = fixture.execute("converge-resolved-rework", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "succeeded");
      if (converged.status !== "succeeded") return;
      assert.equal(converged.value.integrationEligible, true);
      const persisted = new DatabaseSync(fixture.database.path);
      try {
        assert.equal(
          (
            persisted
              .prepare(
                "SELECT status FROM code_review_defects WHERE id = 'rework-obligation'",
              )
              .get() as { readonly status: string }
          ).status,
          "closed",
        );
      } finally {
        persisted.close();
      }
      assert.equal(
        fixture.database.events
          .readAfter(0, 1_000)
          .filter((event) => event.type === "code-review.defect.closed").length,
        1,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("rejects PASS after a newer Runtime-owned source import supersedes the reviewed input", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const raw = new DatabaseSync(fixture.database.path);
      const now = "2026-07-28T10:01:00.000Z";
      try {
        raw
          .prepare(
            `INSERT INTO workspace_imports(
               id, allocation_id, command_id, request_hash, state,
               expected_source_tip, before_source_tip, result_commit,
               object_set_hash, receipt_json, created_at, updated_at
             ) VALUES ('review-import-new', 'review-allocation',
                       'review-import-new-command', ?, 'succeeded', ?, ?, ?, ?,
                       '{}', ?, ?)`,
          )
          .run(
            "a".repeat(64),
            fixture.sourceCommit,
            fixture.sourceCommit,
            "3".repeat(40),
            "b".repeat(64),
            now,
            now,
          );
      } finally {
        raw.close();
      }

      const stale = fixture.execute("reject-stale-import", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(stale.status, "rejected");
      if (stale.status === "rejected") {
        assert.equal(stale.error.code, "CODE_REVIEW_AUTHORITY_STALE");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rejects PASS after the canonical Diff Artifact is superseded", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const superseded = fixture.database.artifactRegistry.setStatus({
        versionId: fixture.diff.id,
        expectedStatus: "produced",
        status: "superseded",
      });
      assert.equal(superseded.status, "superseded");

      const stale = fixture.execute("reject-stale-diff", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(stale.status, "rejected");
      if (stale.status === "rejected") {
        assert.equal(stale.error.code, "CODE_REVIEW_AUTHORITY_STALE");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rebuilds the authoritative Query View after restart without replaying reviewer side effects", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    const reviewed = completeGenericReview(fixture, "PASS");
    const converged = fixture.execute("converge-before-restart", 4, {
      type: "code-review.converge",
      codeReviewId: reviewed.id,
    });
    assert.equal(converged.status, "succeeded");
    fixture.database.close();
    const reopened = openCompanyDatabase(fixture.companyDir, {
      codeReviewRuntime: {
        reviewerWorkspaceAdapter: {
          provision: () => {
            throw new Error(
              "A ready reviewer workspace must not be reprovisioned.",
            );
          },
        },
      },
    });
    try {
      const reloaded = reopened.codeReviews.inspect("review-run");
      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0]?.workspace.state, "ready");
      assert.equal(reloaded[0]?.gateResult?.result, "PASS");
      assert.equal(reloaded[0]?.integrationEligible, true);
      assert.equal(reloaded[0]?.authority?.sourceCommit, fixture.sourceCommit);
    } finally {
      reopened.close();
    }
  });
});
