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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import { defaultNodeHandlerRegistry } from "../pipeline/nodeHandlerRegistry.js";
import { canonicalPipelineJson } from "../pipeline/canonicalPipeline.js";
import type { CodeReviewView, CommandResult } from "../interface.js";
import {
  blockingReviewerWorkspaceAdapter,
  CodeReviewRuntimeError,
  type ReviewerWorkspaceAdapter,
} from "./codeReviewRuntime.js";
import { openLocalReviewerWorkspaceAdapter } from "./reviewerWorkspace.js";
import { createScriptedReviewerExecutionAdapter } from "./reviewerExecution.js";
import type { ReviewerExecutionAdapter } from "./reviewerExecution.js";

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

const setup = (
  adapter?: ReviewerWorkspaceAdapter,
  reviewerExecutionAdapter: ReviewerExecutionAdapter = createScriptedReviewerExecutionAdapter(
    {
      execute: () => ({
        status: "blocked",
        code: "PROVIDER_ISOLATION_REQUIRED",
        message: "Manual Code Review Runtime tests do not execute an Agent.",
        evidence: [],
      }),
    },
  ),
  credentialScopes?: {
    readonly producer: string;
    readonly reviewer: string;
  },
  integrationRuntime?: NonNullable<
    Parameters<typeof openCompanyDatabase>[1]
  >["integrationRuntime"],
) => {
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
  writeFileSync(join(repositoryRoot, "verify.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(repositoryRoot, "verify.sh"), 0o755);
  git(repositoryRoot, "add", "src/reviewed.ts", "verify.sh");
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
    codeReviewRuntime: {
      ...(adapter ? { reviewerWorkspaceAdapter: adapter } : {}),
      reviewerExecutionAdapter,
    },
    ...(integrationRuntime ? { integrationRuntime } : {}),
  });
  const project = database.catalog.createProject({
    name: "Independent review",
    goal: "Gate one exact imported source commit",
  });
  let reviewerSecretReferenceIds: readonly string[] = [];
  if (credentialScopes) {
    const producerReference = database.catalog
      .createSecretReference({
        departmentId: "software-rnd",
        name: `Producer ${credentialScopes.producer}`,
        providerScope: credentialScopes.producer,
      })
      .secretReferences.find(
        (reference) =>
          reference.name === `Producer ${credentialScopes.producer}`,
      );
    const reviewerReference = database.catalog
      .createSecretReference({
        departmentId: "software-rnd",
        name: `Reviewer ${credentialScopes.reviewer}`,
        providerScope: credentialScopes.reviewer,
      })
      .secretReferences.find(
        (reference) =>
          reference.name === `Reviewer ${credentialScopes.reviewer}`,
      );
    assert.ok(producerReference);
    assert.ok(reviewerReference);
    const credentials = new DatabaseSync(database.path);
    try {
      credentials
        .prepare(
          `INSERT INTO execution_profile_secret_references(
             execution_profile_id, secret_reference_id, sort_order
           ) VALUES ('software-rnd-local-isolated-git', ?, 0)`,
        )
        .run(producerReference.id);
    } finally {
      credentials.close();
    }
    reviewerSecretReferenceIds = [reviewerReference.id];
  }
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
  const handlerFor = (handlerKindId: string) => {
    const handler = defaultNodeHandlerRegistry.resolve(
      "ai-task",
      handlerKindId,
    );
    assert.ok(handler);
    return handler;
  };
  const developmentHandler = handlerFor("development@1");
  const codeReviewHandler = handlerFor("code-review@1");
  const integrationHandler = handlerFor("integration@1");
  const snapshotPositions = [
    [
      "software-engineer",
      "software-engineer-member",
      "Software Engineer",
      "Implements one isolated Work Package.",
    ],
    ["reviewer", "reviewer-member", "Reviewer", "Reviews exact Diffs."],
    [
      "software-architect",
      "software-architect-member",
      "Software Architect",
      "Freshly re-reviews exact Diffs.",
    ],
    ["evaluator", "evaluator-member", "Evaluator", "Moderates reviews."],
  ].map(([id, memberId, name, responsibility]) => ({
    id: id!,
    revision: 0,
    name: name!,
    responsibility: responsibility!,
    defaultAgentId: "codex",
    resolvedAgentId: "codex",
    agentSource: "position-default" as const,
    skillIds: [],
    aiMember: {
      id: memberId!,
      displayName: name!,
      profile: responsibility!,
      responsibilityMetadata: { focus: id! },
      status: "active" as const,
    },
  }));
  const graphNodes = [
    {
      id: "development",
      type: "ai-task" as const,
      name: "Development",
      handlerKindId: "development@1",
      positionId: "software-engineer",
      executionProfileId: "review-profile",
    },
    {
      id: "review",
      type: "ai-task" as const,
      name: "Code Review",
      handlerKindId: "code-review@1",
      positionId: "reviewer",
      executionProfileId: "review-profile",
    },
    {
      id: "integration",
      type: "ai-task" as const,
      name: "Integration",
      handlerKindId: "integration@1",
      positionId: "software-architect",
      executionProfileId: "review-profile",
    },
  ];
  const snapshotPayload = {
    schemaVersion: 1 as const,
    project: {
      id: project.id,
      revision: 0,
      name: project.name,
      goal: project.goal,
      sharedContext: "Review one exact Runtime-imported source commit.",
      repositoryReferences: [repositoryRoot],
    },
    department: {
      id: "software-rnd",
      revision: 0,
      name: "Software R&D",
      description: "Builds and reviews Work Packages.",
      inputArtifactContracts: [],
      outputArtifactContracts: [],
      defaultExecutionProfileId: "review-profile",
    },
    pipelineVersion: {
      id: "software-rnd-pipeline-v1",
      version: 1,
      hash: "3".repeat(64),
      graph: {
        nodes: graphNodes,
        edges: [
          { from: "development", to: "review" },
          { from: "review", to: "integration" },
        ],
      },
      handlerRegistry: {
        version: defaultNodeHandlerRegistry.version,
        hash: defaultNodeHandlerRegistry.hash,
      },
      handlers: graphNodes.map((node) => {
        const handler = handlerFor(node.handlerKindId);
        return {
          nodeId: node.id,
          handlerKindId: handler.handlerKindId,
          inputSchemaHash: handler.inputSchemaHash,
          outputSchemaHash: handler.outputSchemaHash,
        };
      }),
    },
    skillFlows: [],
    positions: snapshotPositions,
    executionProfiles: [
      {
        id: "review-profile",
        revision: 0,
        name: "Docker Review",
        providerRef: "codex",
        model: "gpt-test",
        sandboxRef: "docker",
        branchStrategy: "branch" as const,
        limits: {
          timeoutSeconds: 60,
          maxIterations: 1,
          maxTokens: null,
        },
        retryPolicy: { maxAttempts: 1 },
        permissionPolicy: "deny" as const,
        secretReferenceIds: reviewerSecretReferenceIds,
      },
    ],
    runLimits: { maxActiveNodes: 1 },
  };
  const snapshotJson = canonicalPipelineJson(snapshotPayload);
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
    integrationConditions: ["npm test"],
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
      .run(
        now,
        now,
        developmentHandler.inputSchemaHash,
        developmentHandler.outputSchemaHash,
      );
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('code-review-node', 'review-run', 'review', 'ai-task',
                   'ready', 0, '["development"]', ?, ?, 'code-review@1', ?, ?)`,
      )
      .run(
        now,
        now,
        codeReviewHandler.inputSchemaHash,
        codeReviewHandler.outputSchemaHash,
      );
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('integration-node', 'review-run', 'integration', 'ai-task',
                   'queued', 0, '["review"]', ?, ?, 'integration@1', ?, ?)`,
      )
      .run(
        now,
        now,
        integrationHandler.inputSchemaHash,
        integrationHandler.outputSchemaHash,
      );
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

const addSecondWorkPackage = (fixture: ReturnType<typeof setup>) => {
  const now = new Date().toISOString();
  const secondSession = fixture.database.interaction.createSession({
    projectId: fixture.projectId,
    mode: "consultation",
  });
  fixture.database.interaction.addParticipant({
    sessionId: secondSession.id,
    participantType: "ai-member",
    participantRef: "software-engineer-member",
    role: "developer",
  });
  const raw = new DatabaseSync(fixture.database.path);
  try {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw
      .prepare(
        `INSERT INTO node_runs(
           id, run_id, pipeline_node_id, node_type, status, attempt_count,
           required_dependency_ids_json, created_at, updated_at,
           handler_kind_id, input_schema_hash, output_schema_hash
         ) VALUES ('review-node-2', 'review-run', 'development-2', 'ai-task',
                   'succeeded', 1, '[]', ?, ?, 'development@1', ?, ?)`,
      )
      .run(now, now, "4".repeat(64), "5".repeat(64));
    raw
      .prepare(
        `INSERT INTO node_attempts(
           id, node_run_id, attempt_number, snapshot_revision_id, reason,
           status, created_at, started_at, completed_at, recoverable
         ) VALUES ('review-attempt-2', 'review-node-2', 1, 'review-snapshot',
                   'initial', 'succeeded', ?, ?, ?, 0)`,
      )
      .run(now, now, now);
    raw
      .prepare(
        `INSERT INTO work_packages(
           id, project_id, run_id, technical_baseline_id, state, revision,
           created_at, updated_at
         ) SELECT 'review-package-2', project_id, run_id, technical_baseline_id,
                  state, revision, ?, ?
             FROM work_packages WHERE id = 'review-package'`,
      )
      .run(now, now);
    raw
      .prepare(
        `INSERT INTO work_package_versions(
           id, work_package_id, version, application_id,
           repository_reference, node_run_id, manifest_json, manifest_hash,
           status, created_at
         ) SELECT 'review-package-2-v1', 'review-package-2', version,
                  application_id, repository_reference, 'review-node-2',
                  manifest_json, manifest_hash, status, ?
             FROM work_package_versions WHERE id = 'review-package-v1'`,
      )
      .run(now);
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
         ) SELECT 'review-allocation-2', project_id, application_id,
                  execution_profile_id, execution_profile_revision,
                  'review-operation-2', state, repository_root,
                  allocation_root || '-2', 'sandcastle/review-2', base_commit,
                  expected_source_tip, capability_snapshot_json,
                  capability_snapshot_hash, 'review-provision-2', revision,
                  ?, ?, 'review-package-2-v1', 'review-attempt-2', ?,
                  'review-sandbox-2', 'review-evidence-2'
             FROM workspace_allocations WHERE id = 'review-allocation'`,
      )
      .run(now, now, secondSession.id);
    raw
      .prepare(
        `INSERT INTO workspace_imports(
           id, allocation_id, command_id, request_hash, state,
           expected_source_tip, before_source_tip, result_commit,
           object_set_hash, receipt_json, created_at, updated_at
         ) SELECT 'review-import-2', 'review-allocation-2',
                  'review-import-command-2', request_hash, state,
                  expected_source_tip, before_source_tip, result_commit,
                  object_set_hash, receipt_json, ?, ?
             FROM workspace_imports WHERE id = 'review-import'`,
      )
      .run(now, now);
    raw
      .prepare(
        `INSERT INTO work_package_assignments(
           id, work_package_version_id, node_attempt_id, position_id,
           ai_member_id, agent_adapter_id, rationale_json, allocation_id,
           interaction_session_id, sandbox_identity, evidence_scope, state,
           created_at, updated_at
         ) SELECT 'review-assignment-2', 'review-package-2-v1',
                  'review-attempt-2', position_id, ai_member_id,
                  agent_adapter_id, rationale_json, 'review-allocation-2', ?,
                  'review-sandbox-2', 'review-evidence-2', state, ?, ?
             FROM work_package_assignments WHERE id = 'review-assignment'`,
      )
      .run(secondSession.id, now, now);
    raw
      .prepare(
        `INSERT INTO work_package_self_checks(
           id, assignment_id, node_attempt_id, status, report_json,
           report_hash, created_at
         ) SELECT 'review-self-check-2', 'review-assignment-2',
                  'review-attempt-2', status, report_json, report_hash, ?
             FROM work_package_self_checks WHERE id = 'review-self-check'`,
      )
      .run(now);
  } finally {
    raw.close();
  }
  const diff = fixture.database.artifactRegistry.registerVersion({
    projectId: fixture.projectId,
    type: "canonical-diff",
    schemaVersion: "1",
    logicalName: "review-package-2-diff",
    content: fixture.diffBytes,
    status: "produced",
    producer: {
      runId: "review-run",
      nodeRunId: "review-node-2",
      nodeAttemptId: "review-attempt-2",
      snapshotRevisionId: "review-snapshot",
      aiMemberId: "software-engineer-member",
      positionId: "software-engineer",
      sessionId: secondSession.id,
      workPackageId: "review-package-2",
    },
  });
  return { diff, producerSessionId: secondSession.id };
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
    readonly suffix?: string;
    readonly workPackageId?: string;
    readonly diffArtifactVersionId?: string;
    readonly producerSessionId?: string;
    readonly omitExecutionStages?: boolean;
  } = {},
) => {
  const suffix = options.suffix ?? "1";
  const codeReviewId = `code-review-${suffix}`;
  const started = fixture.execute(`start-review-${suffix}`, 4, {
    ...startCommand(fixture),
    codeReviewId,
    topicId: `code-review-topic-${suffix}`,
    ...(options.workPackageId ? { workPackageId: options.workPackageId } : {}),
    ...(options.diffArtifactVersionId
      ? { diffArtifactVersionId: options.diffArtifactVersionId }
      : {}),
  });
  assert.equal(started.status, "succeeded");
  const ready =
    fixture.database.codeReviews.reconcileReviewerWorkspace(codeReviewId);
  if (!options.omitInitialFinding) {
    const initialFinding = fixture.database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `review-finding-${suffix}-${result}`,
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
        findingId: `review-finding-${suffix}-${result}`,
        reviewerParticipantId: `${codeReviewId}:reviewer`,
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
    commandId: `review-revision-${suffix}-${result}`,
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
      revisionId: `review-revision-${suffix}-${result}`,
      ownerParticipantId: `${codeReviewId}:owner`,
      subjectKind: "canonical-diff",
      subjectId: ready.manifest.diffArtifactVersionId,
      subjectHash: ready.manifest.diffHash,
      producerAiMemberId: "software-engineer-member",
      producerPositionId: "software-engineer",
      producerSessionId: options.producerSessionId ?? fixture.producerSessionId,
      evidenceRefs: [ready.manifest.selfCheck.id],
    },
  });
  assert.equal(ownerResult.status, "succeeded");
  const freshParticipant = fixture.database.review
    .inspect(ready.topicId)
    .participants.find(
      (participant) => participant.id === `${codeReviewId}:fresh-reviewer`,
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
    commandId: `review-recheck-${suffix}-${result}`,
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
      recheckId: `review-recheck-${suffix}-${result}`,
      revisionId: `review-revision-${suffix}-${result}`,
      reviewerParticipantId: freshParticipant.id,
      reviewerSessionId: freshSession.id,
      result,
      conditions:
        result === "CONDITIONAL_PASS"
          ? ["Resolve the recorded obligation"]
          : [],
      evidenceRefs: [
        ready.manifest.diffArtifactVersionId,
        ...(ready.manifest.priorReview?.requiredEvidenceRefs ?? []),
      ],
    },
  });
  assert.equal(recheck.status, "succeeded");
  if (!options.omitExecutionStages) {
    const raw = new DatabaseSync(fixture.database.path);
    try {
      const now = new Date().toISOString();
      const isolationReceipt = JSON.stringify({
        capabilities: ready.workspace.capabilitySnapshotHash,
        evidence: ready.workspace.independenceEvidenceHash,
      });
      for (const stage of [
        {
          phase: "initial-finding",
          participantId: `${codeReviewId}:reviewer`,
          sessionId: ready.workspace.reviewerSessionId,
          result: {
            findings: [
              {
                severity: "info",
                summary:
                  "The exact canonical diff was independently inspected.",
                rationale:
                  "Record the required independent finding before revision.",
                impact: "No blocking issue was found in the reviewed input.",
                evidenceRefs: [ready.manifest.diffArtifactVersionId],
                suggestedOwner: "software-engineer",
                blocking: false,
              },
            ],
          },
        },
        {
          phase: "fresh-recheck",
          participantId: freshParticipant.id,
          sessionId: freshSession.id,
          result: {
            result,
            conditions:
              result === "CONDITIONAL_PASS"
                ? ["Resolve the recorded obligation"]
                : [],
            evidenceRefs: [
              ready.manifest.diffArtifactVersionId,
              ...(ready.manifest.priorReview?.requiredEvidenceRefs ?? []),
            ],
          },
        },
      ] as const) {
        const resultJson = JSON.stringify(stage.result);
        raw
          .prepare(
            `INSERT INTO code_review_execution_stages(
               id, code_review_manifest_id, phase, operation_key, state,
               reviewer_participant_id, reviewer_session_id, provider_id,
               isolation_receipt_json, isolation_receipt_hash,
               result_json, result_hash, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?,
                       'scripted-docker-reviewer', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `${codeReviewId}:${stage.phase}`,
            codeReviewId,
            stage.phase,
            `code-review:${codeReviewId}:${stage.phase}`,
            stage.participantId,
            stage.sessionId,
            isolationReceipt,
            hash(isolationReceipt),
            resultJson,
            hash(resultJson),
            now,
            now,
          );
      }
    } finally {
      raw.close();
    }
  }
  return fixture.database.codeReviews
    .inspect("review-run")
    .find((review) => review.id === codeReviewId)!;
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
      assert.equal(CURRENT_SCHEMA_VERSION, 53);
      assert.equal(database.schemaVersion(), CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it("executes the frozen code-review Node through two fresh Reviewer operations and records aggregate authority coverage", async () => {
    const executions: Array<{
      readonly phase: string;
      readonly sessionId: string;
      readonly operationKey: string;
    }> = [];
    const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
      onExecute: (input) => {
        executions.push({
          phase: input.phase,
          sessionId: input.reviewer.sessionId,
          operationKey: input.operationKey,
        });
      },
      execute: (input) => ({
        status: "succeeded",
        providerId: "scripted-docker-reviewer",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "scripted-docker-readonly",
          mechanismVersion: "1",
        },
        isolationEvidence: [
          "mount:/review:readonly",
          `operation:${input.operationKey}`,
        ],
        output:
          input.phase === "initial-finding"
            ? {
                findings: [
                  {
                    severity: "info",
                    summary: "The exact canonical Diff was reviewed.",
                    rationale: "The frozen inputs support the intended change.",
                    impact: "No blocking issue was found.",
                    evidenceRefs: [input.manifest.diffArtifactVersionId],
                    suggestedOwner: "software-engineer",
                    blocking: false,
                  },
                ],
              }
            : {
                result: "PASS",
                conditions: [],
                evidenceRefs: [input.manifest.diffArtifactVersionId],
              },
      }),
    });
    const fixture = setup(
      readyReviewerWorkspaceAdapter,
      reviewerExecutionAdapter,
    );
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      const completed = await fixture.database.pipelineRuntime.executeReady({
        runId: before.run.id,
        expectedRevision: before.run.revision,
      });
      assert.deepEqual(
        executions.map((entry) => entry.phase),
        ["initial-finding", "fresh-recheck"],
      );
      assert.notEqual(executions[0]?.sessionId, executions[1]?.sessionId);
      assert.notEqual(executions[0]?.operationKey, executions[1]?.operationKey);
      const review = fixture.database.codeReviews.inspect("review-run")[0];
      assert.equal(review?.integrationEligible, true);
      assert.equal(
        review?.authority?.workPackageVersionId,
        "review-package-v1",
      );
      const reviewNode = completed.nodes.find(
        (node) => node.id === "code-review-node",
      );
      assert.equal(reviewNode?.status, "succeeded");
      const aggregateResult = reviewNode?.attempts.at(-1)?.result as
        | {
            readonly authorityIds: string[];
            readonly coverageHash: string;
            readonly qualityGateResultIds: string[];
            readonly workPackageVersionIds: string[];
          }
        | undefined;
      assert.deepEqual(aggregateResult, {
        authorityIds: [review!.authority!.id],
        coverageHash: aggregateResult?.coverageHash,
        qualityGateResultIds: [review!.gateResult!.id],
        workPackageVersionIds: ["review-package-v1"],
      });
      assert.match(String(aggregateResult?.coverageHash), /^[a-f0-9]{64}$/);
    } finally {
      fixture.database.close();
    }
  });

  it("binds Reviewer message, tool, and usage Execution Facts to the Reviewer Session and Code Review Node Attempt", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async (input, sink, signal) => {
        assert.ok(sink);
        assert.equal(signal?.aborted, false);
        for (const fact of [
          {
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:message`,
            ordinal: 1,
            kind: "message" as const,
            schemaVersion: 1,
            payload: { content: `Reviewer activity for ${input.phase}` },
            evidenceRefs: [input.manifest.diffArtifactVersionId],
          },
          {
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:tool`,
            ordinal: 2,
            kind: "tool-call" as const,
            schemaVersion: 1,
            payload: { name: "read-review-bundle", path: "/review" },
            evidenceRefs: [input.manifest.diffArtifactVersionId],
          },
          {
            adapterSchemaVersion: 1,
            factId: `${input.operationKey}:usage`,
            ordinal: 3,
            kind: "usage" as const,
            schemaVersion: 1,
            payload: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            evidenceRefs: [input.manifest.diffArtifactVersionId],
          },
        ]) {
          await sink.record(fact);
        }
        return {
          status: "succeeded",
          providerId: "scripted-docker-reviewer",
          isolation: {
            readOnlyFilesystem: true,
            independentGitDatabase: true,
            independentSessionStorage: true,
            independentCredentialScope: true,
            independentMutableCache: true,
            inputAllowlist: true,
            mountTableHash: "1".repeat(64),
            sessionScopeHash: "2".repeat(64),
            cacheScopeHash: "3".repeat(64),
            credentialScopeHash: "4".repeat(64),
            providerOperationId: `${input.phase}-operation`,
            inspectedReadOnlyReviewMount: true,
            inspectedEnvironmentHash: "5".repeat(64),
            inspectedAt: "2026-07-28T10:00:00.000Z",
            terminalProviderStatus: "completed",
            terminalProviderReceiptHash: "6".repeat(64),
            mechanism: "scripted-docker-readonly",
            mechanismVersion: "1",
          },
          isolationEvidence: [`operation:${input.operationKey}`],
          output:
            input.phase === "initial-finding"
              ? {
                  findings: [
                    {
                      severity: "info",
                      summary: "The exact Diff was reviewed.",
                      rationale: "The manifest is complete.",
                      impact: "No blocker was found.",
                      evidenceRefs: [input.manifest.diffArtifactVersionId],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                }
              : {
                  result: "PASS",
                  conditions: [],
                  evidenceRefs: [input.manifest.diffArtifactVersionId],
                },
        };
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "No restart in this test.",
        evidence: [],
      }),
    });
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await fixture.database.pipelineRuntime.executeReady({
        runId: before.run.id,
        expectedRevision: before.run.revision,
      });
      const raw = new DatabaseSync(fixture.database.path);
      try {
        const facts = raw
          .prepare(
            `SELECT execution_facts.kind, execution_facts.target_id AS targetId,
                    stages.reviewer_session_id AS reviewerSessionId
               FROM execution_facts
               JOIN code_review_execution_stages AS stages
                 ON stages.operation_key = execution_facts.operation_key
              WHERE execution_facts.status = 'accepted'
                AND execution_facts.kind IN ('message', 'tool-call', 'usage')
              ORDER BY stages.phase, execution_facts.ordinal`,
          )
          .all() as Array<{
          readonly kind: string;
          readonly targetId: string;
          readonly reviewerSessionId: string;
        }>;
        assert.deepEqual(
          facts.map((fact) => fact.kind),
          ["message", "tool-call", "usage", "message", "tool-call", "usage"],
        );
        assert.equal(new Set(facts.map((fact) => fact.targetId)).size, 1);
        assert.equal(Boolean(facts[0]?.targetId.length), true);
        const messages = raw
          .prepare(
            `SELECT session_id AS sessionId, content
               FROM session_messages
              WHERE content LIKE 'Reviewer activity for %'
              ORDER BY content`,
          )
          .all() as Array<{
          readonly sessionId: string;
          readonly content: string;
        }>;
        assert.deepEqual(
          messages.map((message) => message.sessionId).sort(),
          [...new Set(facts.map((fact) => fact.reviewerSessionId))].sort(),
        );
      } finally {
        raw.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("aborts and cancels an active Reviewer operation when the Department Run is paused", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedAbort = false;
    let cancelCalls = 0;
    let resolveProviderCancellation!: () => void;
    const providerCancellation = new Promise<void>((resolve) => {
      resolveProviderCancellation = resolve;
    });
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async (_input, _sink, signal) => {
        assert.ok(signal);
        resolveStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolveProviderCancellation();
              resolve();
            },
            { once: true },
          );
        });
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "Pause requires provider reconciliation.",
          evidence: [],
        };
      },
      cancel: async () => {
        cancelCalls += 1;
        await providerCancellation;
        return "cancelled";
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "Pause requires provider reconciliation.",
        evidence: [],
      }),
    });
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      const execution = fixture.database.pipelineRuntime.executeReady({
        runId: before.run.id,
        expectedRevision: before.run.revision,
      });
      await started;
      const running = fixture.database.pipelineRuntime.inspectRun("review-run");
      const paused = await Promise.race([
        fixture.database.pipelineRuntime.controlRun({
          runId: running.run.id,
          expectedRevision: running.run.revision,
          action: "pause",
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "Pause waited for provider cancellation before local abort.",
                ),
              ),
            1_000,
          );
        }),
      ]);
      await assert.rejects(execution);
      assert.equal(paused.run.status, "paused");
      assert.equal(observedAbort, true);
      assert.equal(cancelCalls, 1);
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.equal(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS count FROM execution_facts
                  WHERE operation_key IN (
                    SELECT operation_key FROM code_review_execution_stages
                     WHERE phase = 'initial-finding'
                  ) AND kind = 'cancelled' AND status = 'accepted'`,
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
      } finally {
        raw.close();
      }
      const interrupted = paused.nodes.find(
        (node) => node.id === "code-review-node",
      );
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
    } finally {
      fixture.database.close();
    }
  });

  it("aborts and cancels an active Reviewer operation during Runtime shutdown", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedAbort = false;
    let cancelCalls = 0;
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async (_input, _sink, signal) => {
        assert.ok(signal);
        resolveStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "Shutdown requires provider reconciliation.",
          evidence: [],
        };
      },
      cancel: async () => {
        cancelCalls += 1;
        return "cancelled";
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "Shutdown requires provider reconciliation.",
        evidence: [],
      }),
    });
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      const execution = fixture.database.pipelineRuntime
        .executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        })
        .catch((error: unknown) => error);
      await started;

      await fixture.database.pipelineRuntime.prepareForShutdown();

      assert.equal(observedAbort, true);
      assert.equal(cancelCalls, 1);
      assert.equal((await execution) instanceof Error, true);
      const drained = fixture.database.pipelineRuntime.inspectRun("review-run");
      assert.equal(drained.run.status, "blocked");
      const interrupted = drained.nodes.find(
        (node) => node.id === "code-review-node",
      );
      assert.equal(interrupted?.status, "blocked");
      assert.equal(interrupted?.attempts.at(-1)?.status, "reconciling");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.equal(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS count FROM execution_facts
                  WHERE operation_key IN (
                    SELECT operation_key FROM code_review_execution_stages
                     WHERE phase = 'initial-finding'
                  ) AND kind = 'cancelled' AND status = 'accepted'`,
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
      } finally {
        raw.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("reconciles and reattaches a shutdown-interrupted Reviewer operation after Runtime restart", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async (_input, _sink, signal) => {
        assert.ok(signal);
        resolveStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message: "Runtime shutdown interrupted the local Reviewer worker.",
          evidence: [],
        };
      },
      cancel: async () => "unknown",
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "not used before restart",
        evidence: [],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      const execution = fixture.database.pipelineRuntime
        .executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        })
        .catch((error: unknown) => error);
      await started;
      await fixture.database.pipelineRuntime.prepareForShutdown();
      assert.equal((await execution) instanceof Error, true);
      const drained = fixture.database.pipelineRuntime.inspectRun("review-run");
      assert.equal(
        drained.nodes
          .find((node) => node.id === "code-review-node")
          ?.attempts.at(-1)?.failure?.code,
        "RUNTIME_SHUTDOWN",
      );
      fixture.database.close();

      let reconcileCalls = 0;
      let reattachCalls = 0;
      const resumedExecutePhases: string[] = [];
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: true,
            },
            reconcile: async () => {
              reconcileCalls += 1;
              return {
                status: "running",
                providerExecutionRef: "shutdown-review-operation-1",
              };
            },
            reattach: async (input) => {
              reattachCalls += 1;
              return {
                status: "succeeded",
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true,
                  independentGitDatabase: true,
                  independentSessionStorage: true,
                  independentCredentialScope: true,
                  independentMutableCache: true,
                  inputAllowlist: true,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "shutdown-review-operation-1",
                  inspectedReadOnlyReviewMount: true,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed",
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:shutdown-reattached"],
                output: {
                  findings: [
                    {
                      severity: "info",
                      summary: "Recovered exact review output.",
                      rationale: "The provider operation remained attached.",
                      impact: "No duplicate Reviewer was started.",
                      evidenceRefs: [input.manifest.diffArtifactVersionId],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                },
              };
            },
            execute: async (input) => {
              resumedExecutePhases.push(input.phase);
              return {
                status: "succeeded",
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true,
                  independentGitDatabase: true,
                  independentSessionStorage: true,
                  independentCredentialScope: true,
                  independentMutableCache: true,
                  inputAllowlist: true,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "shutdown-fresh-recheck-operation",
                  inspectedReadOnlyReviewMount: true,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed",
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:shutdown-fresh-recheck"],
                output: {
                  result: "PASS",
                  conditions: [],
                  evidenceRefs: [input.manifest.diffArtifactVersionId],
                },
              };
            },
          },
        },
      });

      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 1);
      assert.equal(reconcileCalls, 1);
      assert.equal(reattachCalls, 1);
      assert.deepEqual(resumedExecutePhases, ["fresh-recheck"]);
      assert.equal(
        reopened.codeReviews.inspect("review-run")[0]?.integrationEligible,
        true,
      );
      const raw = new DatabaseSync(reopened.path);
      try {
        const reattachAudit = raw
          .prepare(
            `SELECT command_id AS commandId
               FROM runtime_audit_records
              WHERE action = 'attempt.code-review-reattach'`,
          )
          .get() as { readonly commandId: string | null } | undefined;
        assert.ok(reattachAudit?.commandId);
        assert.equal(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS count FROM command_deduplication
                  WHERE command_id = ? AND status = 'completed'`,
              )
              .get(reattachAudit.commandId) as { readonly count: number }
          ).count,
          1,
        );
      } finally {
        raw.close();
      }
    } finally {
      reopened?.close();
    }
  });

  it("uses a distinct fresh re-review Session for each Work Package manifest", async () => {
    const executions: Array<{
      readonly workPackageVersionId: string;
      readonly phase: string;
      readonly sessionId: string;
    }> = [];
    const fixture = setup(
      readyReviewerWorkspaceAdapter,
      createScriptedReviewerExecutionAdapter({
        onExecute: (input) => {
          executions.push({
            workPackageVersionId: input.manifest.workPackageVersionId,
            phase: input.phase,
            sessionId: input.reviewer.sessionId,
          });
        },
        execute: (input) => ({
          status: "succeeded",
          providerId: "scripted-docker-reviewer",
          isolation: {
            readOnlyFilesystem: true,
            independentGitDatabase: true,
            independentSessionStorage: true,
            independentCredentialScope: true,
            independentMutableCache: true,
            inputAllowlist: true,
            mechanism: "scripted-docker-readonly",
            mechanismVersion: "1",
          },
          isolationEvidence: [`operation:${input.operationKey}`],
          output:
            input.phase === "initial-finding"
              ? {
                  findings: [
                    {
                      severity: "info",
                      summary: "The exact Diff was reviewed.",
                      rationale: "The manifest is complete.",
                      impact: "No blocker was found.",
                      evidenceRefs: [input.manifest.diffArtifactVersionId],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                }
              : {
                  result: "PASS",
                  conditions: [],
                  evidenceRefs: [input.manifest.diffArtifactVersionId],
                },
        }),
      }),
    );
    try {
      addSecondWorkPackage(fixture);
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await fixture.database.pipelineRuntime.executeReady({
        runId: before.run.id,
        expectedRevision: before.run.revision,
      });
      const freshSessions = executions
        .filter((execution) => execution.phase === "fresh-recheck")
        .sort((left, right) =>
          left.workPackageVersionId.localeCompare(right.workPackageVersionId),
        );
      assert.equal(freshSessions.length, 2);
      assert.notEqual(freshSessions[0]?.sessionId, freshSessions[1]?.sessionId);
    } finally {
      fixture.database.close();
    }
  });

  it("blocks the Code Review Node when Reviewer output cites evidence outside the frozen manifest", async () => {
    const fixture = setup(
      readyReviewerWorkspaceAdapter,
      createScriptedReviewerExecutionAdapter({
        execute: () => ({
          status: "succeeded",
          providerId: "scripted-docker-reviewer",
          isolation: {
            readOnlyFilesystem: true,
            independentGitDatabase: true,
            independentSessionStorage: true,
            independentCredentialScope: true,
            independentMutableCache: true,
            inputAllowlist: true,
            mechanism: "scripted-docker-readonly",
            mechanismVersion: "1",
          },
          isolationEvidence: ["mount:/review:readonly"],
          output: {
            findings: [
              {
                severity: "high",
                summary: "Hidden evidence was consulted.",
                rationale: "This reference is outside the manifest.",
                impact: "The review boundary is not trustworthy.",
                evidenceRefs: ["hidden-transcript:producer"],
                suggestedOwner: "runtime",
                blocking: true,
              },
            ],
          },
        }),
      }),
    );
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "REVIEWER_OUTPUT_INVALID",
      );
      const blocked = fixture.database.pipelineRuntime.inspectRun("review-run");
      assert.equal(blocked.run.status, "blocked");
      assert.equal(
        blocked.nodes.find((node) => node.id === "code-review-node")?.status,
        "blocked",
      );
      const raw = new DatabaseSync(fixture.database.path);
      try {
        const stage = raw
          .prepare(
            `SELECT state, failure_code AS failureCode
               FROM code_review_execution_stages`,
          )
          .get() as { readonly state: string; readonly failureCode: string };
        assert.equal(stage.state, "blocked");
        assert.equal(stage.failureCode, "REVIEWER_OUTPUT_INVALID");
      } finally {
        raw.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("does not treat an accepted initial Reviewer execution as Node success when fresh isolation later blocks", async () => {
    const phases: string[] = [];
    const fixture = setup(
      readyReviewerWorkspaceAdapter,
      createScriptedReviewerExecutionAdapter({
        execute: (input) => {
          phases.push(input.phase);
          if (input.phase === "fresh-recheck") {
            return {
              status: "blocked",
              code: "PROVIDER_ISOLATION_REQUIRED",
              message: "The fresh Reviewer Sandbox lost its read-only mount.",
              evidence: ["mount:/review:writable"],
            };
          }
          return {
            status: "succeeded",
            providerId: "scripted-docker-reviewer",
            isolation: {
              readOnlyFilesystem: true,
              independentGitDatabase: true,
              independentSessionStorage: true,
              independentCredentialScope: true,
              independentMutableCache: true,
              inputAllowlist: true,
              mechanism: "scripted-docker-readonly",
              mechanismVersion: "1",
            },
            isolationEvidence: ["mount:/review:readonly"],
            output: {
              findings: [
                {
                  severity: "info",
                  summary: "Initial review completed.",
                  rationale: "The exact Diff was inspected.",
                  impact: "Fresh re-review is still required.",
                  evidenceRefs: [input.manifest.diffArtifactVersionId],
                  suggestedOwner: "software-engineer",
                  blocking: false,
                },
              ],
            },
          };
        },
      }),
    );
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PROVIDER_ISOLATION_REQUIRED",
      );
      assert.deepEqual(phases, ["initial-finding", "fresh-recheck"]);
      const blocked = fixture.database.pipelineRuntime.inspectRun("review-run");
      const reviewNode = blocked.nodes.find(
        (node) => node.id === "code-review-node",
      );
      assert.equal(reviewNode?.status, "blocked");
      assert.equal(reviewNode?.attempts.at(-1)?.status, "failed");
      assert.equal(
        fixture.database.codeReviews.inspect("review-run")[0]?.authority,
        null,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("continues in a fresh aggregate Attempt only after reconciliation accepts the terminal Reviewer Fact", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async () => {
        throw new Error("provider response was lost after durable completion");
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "not used before restart",
        evidence: [],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        /provider response was lost/,
      );
      await fixture.database.pipelineRuntime.prepareForShutdown();
      fixture.database.close();
      let genericReconcileCalls = 0;
      reopened = openCompanyDatabase(fixture.companyDir, {
        executionAdapter: {
          execute: async () => {
            throw new Error("generic execution must not run Code Review");
          },
          reconcile: async () => {
            genericReconcileCalls += 1;
            return { status: "unknown", evidenceRefs: [] };
          },
        },
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: false,
            },
            reconcile: async (operationKey, sink) => {
              assert.ok(sink);
              const result = {
                status: "succeeded" as const,
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true as const,
                  independentGitDatabase: true as const,
                  independentSessionStorage: true as const,
                  independentCredentialScope: true as const,
                  independentMutableCache: true as const,
                  inputAllowlist: true as const,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "reconciled-terminal-operation",
                  inspectedReadOnlyReviewMount: true as const,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed" as const,
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:reconciled-terminal"],
                output: {
                  findings: [
                    {
                      severity: "info" as const,
                      summary: "Recovered exact review output.",
                      rationale: "The provider terminal receipt was durable.",
                      impact: "No Reviewer execution was repeated.",
                      evidenceRefs: [fixture.diff.id],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                },
              };
              const receipt = await sink.record({
                adapterSchemaVersion: 1,
                factId: `${operationKey}:reconciled-completed`,
                ordinal: 1,
                kind: "completed",
                schemaVersion: 1,
                payload: { structuredResult: result },
                evidenceRefs: result.isolationEvidence,
              });
              return {
                ...result,
                terminalExecutionFactId: receipt.executionFactId,
              };
            },
            execute: async (input) => ({
              status: "succeeded",
              providerId: "scripted-docker-reviewer",
              isolation: {
                readOnlyFilesystem: true,
                independentGitDatabase: true,
                independentSessionStorage: true,
                independentCredentialScope: true,
                independentMutableCache: true,
                inputAllowlist: true,
                mountTableHash: "1".repeat(64),
                sessionScopeHash: "2".repeat(64),
                cacheScopeHash: "3".repeat(64),
                credentialScopeHash: "4".repeat(64),
                providerOperationId: "fresh-recheck-after-reconcile",
                inspectedReadOnlyReviewMount: true,
                inspectedEnvironmentHash: "5".repeat(64),
                inspectedAt: "2026-07-28T10:00:00.000Z",
                terminalProviderStatus: "completed",
                terminalProviderReceiptHash: "6".repeat(64),
                mechanism: "scripted-docker-readonly",
                mechanismVersion: "1",
              },
              isolationEvidence: ["provider:fresh-recheck"],
              output: {
                result: "PASS",
                conditions: [],
                evidenceRefs: [input.manifest.diffArtifactVersionId],
              },
            }),
          },
        },
      });

      assert.equal(
        await reopened.pipelineRuntime.reconcilePendingExecutions(),
        0,
      );
      assert.equal(genericReconcileCalls, 0);
      const crashConnection = new DatabaseSync(reopened.path);
      try {
        crashConnection.exec(`
          CREATE TRIGGER crash_after_terminal_reconciliation
          BEFORE UPDATE OF state ON code_review_execution_stages
          WHEN NEW.state = 'succeeded'
          BEGIN
            SELECT RAISE(ABORT, 'crash after terminal reconciliation');
          END;
        `);
      } finally {
        crashConnection.close();
      }
      await assert.rejects(
        reopened.codeReviewNodeHandler.reconcilePending(),
        /crash after terminal reconciliation/,
      );
      const afterCrash = reopened.pipelineRuntime.inspectRun("review-run");
      assert.deepEqual(
        afterCrash.nodes
          .find((node) => node.id === "code-review-node")
          ?.attempts.map((attempt) => attempt.status),
        ["interrupted", "running"],
      );
      const resumeConnection = new DatabaseSync(reopened.path);
      try {
        resumeConnection.exec(
          "DROP TRIGGER crash_after_terminal_reconciliation",
        );
      } finally {
        resumeConnection.close();
      }
      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 1);
      const run = reopened.pipelineRuntime.inspectRun("review-run");
      const attempts = run.nodes.find(
        (node) => node.id === "code-review-node",
      )?.attempts;
      assert.deepEqual(
        attempts?.map((attempt) => attempt.status),
        ["interrupted", "succeeded"],
      );
      const raw = new DatabaseSync(reopened.path);
      try {
        const reconciledFact = raw
          .prepare(
            `SELECT lease_kind AS leaseKind, status
               FROM execution_facts
              WHERE fact_id LIKE '%:reconciled-completed'`,
          )
          .get() as
          | { readonly leaseKind: string; readonly status: string }
          | undefined;
        assert.equal(reconciledFact?.leaseKind, "reconciliation");
        assert.equal(reconciledFact?.status, "accepted");
        assert.equal(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS count FROM runtime_audit_records
                  WHERE action = 'attempt.code-review-reattach'`,
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
        assert.equal(
          (
            raw
              .prepare(
                `SELECT COUNT(*) AS count FROM command_deduplication
                  WHERE command_id LIKE 'code-review:terminal-reconciliation:%'`,
              )
              .get() as { readonly count: number }
          ).count,
          1,
        );
      } finally {
        raw.close();
      }
    } finally {
      reopened?.close();
    }
  });

  it("replays an accepted blocked Reviewer result after a crash before stage persistence", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: false,
      },
      execute: async () => {
        throw new Error("provider response was lost after durable blocking");
      },
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        /provider response was lost/,
      );
      await fixture.database.pipelineRuntime.prepareForShutdown();
      fixture.database.close();
      let reconcileCalls = 0;
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: false,
            },
            execute: async () => {
              throw new Error("blocked Reviewer execution must not repeat");
            },
            reconcile: async (operationKey, sink) => {
              reconcileCalls += 1;
              assert.ok(sink);
              const blocked = {
                status: "blocked" as const,
                code: "PROVIDER_ISOLATION_REQUIRED" as const,
                message:
                  "The durable Reviewer receipt proves invalid isolation.",
                evidence: ["provider:isolation-invalid"],
              };
              const receipt = await sink.record({
                adapterSchemaVersion: 1,
                factId: `${operationKey}:reconciled-blocked`,
                ordinal: 1,
                kind: "completed",
                schemaVersion: 1,
                payload: { structuredResult: blocked },
                evidenceRefs: blocked.evidence,
              });
              return {
                ...blocked,
                terminalExecutionFactId: receipt.executionFactId,
              };
            },
          },
        },
      });
      const crashConnection = new DatabaseSync(reopened.path);
      try {
        crashConnection.exec(`
          CREATE TRIGGER crash_before_blocked_stage_persistence
          BEFORE UPDATE OF state ON code_review_execution_stages
          WHEN NEW.state = 'blocked'
          BEGIN
            SELECT RAISE(ABORT, 'crash before blocked stage persistence');
          END;
        `);
      } finally {
        crashConnection.close();
      }
      await assert.rejects(
        reopened.codeReviewNodeHandler.reconcilePending(),
        /crash before blocked stage persistence/,
      );
      const resumeConnection = new DatabaseSync(reopened.path);
      try {
        resumeConnection.exec(
          "DROP TRIGGER crash_before_blocked_stage_persistence",
        );
      } finally {
        resumeConnection.close();
      }
      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 1);
      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 0);
      assert.equal(reconcileCalls, 1);
      const raw = new DatabaseSync(reopened.path);
      try {
        const stage = raw
          .prepare(
            `SELECT state, failure_code AS failureCode
               FROM code_review_execution_stages
              WHERE phase = 'initial-finding'`,
          )
          .get() as { readonly state: string; readonly failureCode: string };
        assert.equal(stage.state, "blocked");
        assert.equal(stage.failureCode, "PROVIDER_ISOLATION_REQUIRED");
        const attempt = raw
          .prepare(
            `SELECT attempts.status,
                    facts.fact_id AS terminalExecutionFactId
               FROM node_attempts AS attempts
               LEFT JOIN execution_facts AS facts
                 ON facts.id = attempts.terminal_execution_fact_id
              WHERE attempts.node_run_id = 'code-review-node'
              ORDER BY attempts.attempt_number DESC LIMIT 1`,
          )
          .get() as {
          readonly status: string;
          readonly terminalExecutionFactId: string | null;
        };
        assert.equal(attempt.status, "failed");
        assert.match(
          attempt.terminalExecutionFactId ?? "",
          /reconciled-blocked/,
        );
      } finally {
        raw.close();
      }
    } finally {
      reopened?.close();
    }
  });

  it("retries an unknown Reviewer outcome because it is not a terminal Execution Fact", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: false,
      },
      execute: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "The provider has not exposed terminal evidence yet.",
        evidence: ["provider:pending"],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RECONCILE_UNKNOWN",
      );
      const review = fixture.database.codeReviews.inspect("review-run")[0];
      assert.ok(review);
      assert.equal(
        fixture.database.pipelineRuntime
          .inspectExecution({
            operationKey: `code-review:${review.id}:initial-finding`,
          })
          .facts.filter((fact) => fact.kind === "completed").length,
        0,
      );
      fixture.database.close();
      let reconcileCalls = 0;
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: false,
            },
            reconcile: async (operationKey, sink) => {
              reconcileCalls += 1;
              assert.ok(sink);
              const result = {
                status: "succeeded" as const,
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true as const,
                  independentGitDatabase: true as const,
                  independentSessionStorage: true as const,
                  independentCredentialScope: true as const,
                  independentMutableCache: true as const,
                  inputAllowlist: true as const,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "reconciled-after-unknown",
                  inspectedReadOnlyReviewMount: true as const,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed" as const,
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:reconciled-after-unknown"],
                output: {
                  findings: [
                    {
                      severity: "info" as const,
                      summary: "Recovered exact review output.",
                      rationale:
                        "The provider later exposed terminal evidence.",
                      impact: "The review can continue without resending work.",
                      evidenceRefs: [fixture.diff.id],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                },
              };
              const receipt = await sink.record({
                adapterSchemaVersion: 1,
                factId: `${operationKey}:reconciled-completed`,
                ordinal: 1,
                kind: "completed",
                schemaVersion: 1,
                payload: { structuredResult: result },
                evidenceRefs: result.isolationEvidence,
              });
              return {
                ...result,
                terminalExecutionFactId: receipt.executionFactId,
              };
            },
            execute: async (input) => ({
              status: "succeeded",
              providerId: "scripted-docker-reviewer",
              isolation: {
                readOnlyFilesystem: true,
                independentGitDatabase: true,
                independentSessionStorage: true,
                independentCredentialScope: true,
                independentMutableCache: true,
                inputAllowlist: true,
                mountTableHash: "1".repeat(64),
                sessionScopeHash: "2".repeat(64),
                cacheScopeHash: "3".repeat(64),
                credentialScopeHash: "4".repeat(64),
                providerOperationId: "fresh-recheck-after-unknown",
                inspectedReadOnlyReviewMount: true,
                inspectedEnvironmentHash: "5".repeat(64),
                inspectedAt: "2026-07-28T10:00:00.000Z",
                terminalProviderStatus: "completed",
                terminalProviderReceiptHash: "6".repeat(64),
                mechanism: "scripted-docker-readonly",
                mechanismVersion: "1",
              },
              isolationEvidence: ["provider:fresh-recheck"],
              output: {
                result: "PASS",
                conditions: [],
                evidenceRefs: [input.manifest.diffArtifactVersionId],
              },
            }),
          },
        },
      });

      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 1);
      assert.equal(reconcileCalls, 1);
      assert.equal(
        reopened.codeReviews.inspect("review-run")[0]?.integrationEligible,
        true,
      );
    } finally {
      reopened?.close();
    }
  });

  it("reconciles a running Reviewer operation after restart without repeating the initial Agent execution", async () => {
    let initialExecuteCalls = 0;
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async () => {
        initialExecuteCalls += 1;
        throw new Error("provider response was lost after durable start");
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "not used before restart",
        evidence: [],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
        /provider response was lost/,
      );
      assert.equal(initialExecuteCalls, 1);
      fixture.database.close();
      let reconcileCalls = 0;
      let reattachCalls = 0;
      const resumedExecutePhases: string[] = [];
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: true,
            },
            reconcile: async () => {
              reconcileCalls += 1;
              return {
                status: "running",
                providerExecutionRef: "review-provider-operation-1",
              };
            },
            reattach: async (input, providerExecutionRef, _sink, signal) => {
              reattachCalls += 1;
              assert.equal(providerExecutionRef, "review-provider-operation-1");
              assert.equal(signal.aborted, false);
              return {
                status: "succeeded",
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true,
                  independentGitDatabase: true,
                  independentSessionStorage: true,
                  independentCredentialScope: true,
                  independentMutableCache: true,
                  inputAllowlist: true,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "reconciled-operation",
                  inspectedReadOnlyReviewMount: true,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed",
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:reconciled"],
                output: {
                  findings: [
                    {
                      severity: "info",
                      summary: "Recovered exact review output.",
                      rationale: "The provider operation receipt was durable.",
                      impact: "No Agent retry was required.",
                      evidenceRefs: [input.manifest.diffArtifactVersionId],
                      suggestedOwner: "software-engineer",
                      blocking: false,
                    },
                  ],
                },
              };
            },
            execute: async (input) => {
              resumedExecutePhases.push(input.phase);
              return {
                status: "succeeded",
                providerId: "scripted-docker-reviewer",
                isolation: {
                  readOnlyFilesystem: true,
                  independentGitDatabase: true,
                  independentSessionStorage: true,
                  independentCredentialScope: true,
                  independentMutableCache: true,
                  inputAllowlist: true,
                  mountTableHash: "1".repeat(64),
                  sessionScopeHash: "2".repeat(64),
                  cacheScopeHash: "3".repeat(64),
                  credentialScopeHash: "4".repeat(64),
                  providerOperationId: "fresh-recheck-operation",
                  inspectedReadOnlyReviewMount: true,
                  inspectedEnvironmentHash: "5".repeat(64),
                  inspectedAt: "2026-07-28T10:00:00.000Z",
                  terminalProviderStatus: "completed",
                  terminalProviderReceiptHash: "6".repeat(64),
                  mechanism: "scripted-docker-readonly",
                  mechanismVersion: "1",
                },
                isolationEvidence: ["provider:fresh-recheck"],
                output: {
                  result: "PASS",
                  conditions: [],
                  evidenceRefs: [input.manifest.diffArtifactVersionId],
                },
              };
            },
          },
        },
      });
      assert.equal(await reopened.codeReviewNodeHandler.reconcilePending(), 1);
      assert.equal(reconcileCalls, 1);
      assert.equal(reattachCalls, 1);
      assert.deepEqual(resumedExecutePhases, ["fresh-recheck"]);
      assert.equal(
        reopened.codeReviews.inspect("review-run")[0]?.integrationEligible,
        true,
      );
    } finally {
      reopened?.close();
    }
  });

  it("blocks restart reconciliation when a running Reviewer operation is unknown instead of blindly resending it", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async () => {
        throw new Error("provider response was lost after durable start");
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "not used before restart",
        evidence: [],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
      );
      fixture.database.close();
      let executeCalls = 0;
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: true,
            },
            execute: async () => {
              executeCalls += 1;
              throw new Error("must not resend an unknown Reviewer operation");
            },
            reconcile: async () => ({
              status: "unknown",
              code: "RECONCILE_UNKNOWN",
              message:
                "The provider cannot prove whether the Reviewer finished.",
              evidence: ["provider:operation-missing"],
            }),
          },
        },
      });
      await assert.rejects(
        reopened.codeReviewNodeHandler.reconcilePending(),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "RECONCILE_UNKNOWN",
      );
      assert.equal(executeCalls, 0);
      const blocked = reopened.pipelineRuntime.inspectRun("review-run");
      assert.equal(blocked.run.status, "blocked");
      assert.equal(
        blocked.nodes.find((node) => node.id === "code-review-node")?.status,
        "blocked",
      );
      assert.equal(
        blocked.nodes
          .find((node) => node.id === "code-review-node")
          ?.attempts.at(-1)?.status,
        "reconciling",
      );
    } finally {
      reopened?.close();
    }
  });

  it("releases the Reviewer reconciliation lease when provider reconciliation throws", async () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, {
      capabilities: {
        executionBoundIsolation: true,
        reattachRunningOperation: true,
      },
      execute: async () => {
        throw new Error("provider response was lost after durable start");
      },
      reconcile: async () => ({
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: "not used before restart",
        evidence: [],
      }),
    });
    let reopened: ReturnType<typeof openCompanyDatabase> | undefined;
    try {
      const before = fixture.database.pipelineRuntime.inspectRun("review-run");
      await assert.rejects(
        fixture.database.pipelineRuntime.executeReady({
          runId: before.run.id,
          expectedRevision: before.run.revision,
        }),
      );
      fixture.database.close();
      reopened = openCompanyDatabase(fixture.companyDir, {
        codeReviewRuntime: {
          reviewerWorkspaceAdapter: readyReviewerWorkspaceAdapter,
          reviewerExecutionAdapter: {
            capabilities: {
              executionBoundIsolation: true,
              reattachRunningOperation: true,
            },
            execute: async () => {
              throw new Error("must not resend an unknown Reviewer operation");
            },
            reconcile: async () => {
              throw new Error("provider reconciliation failed");
            },
          },
        },
      });

      await assert.rejects(
        reopened.codeReviewNodeHandler.reconcilePending(),
        /provider reconciliation failed/,
      );

      const review = reopened.codeReviews.inspect("review-run")[0];
      assert.ok(review);
      const leases = reopened.pipelineRuntime.inspectExecution({
        operationKey: `code-review:${review.id}:initial-finding`,
      }).leases;
      assert.equal(leases.at(-1)?.leaseKind, "reconciliation");
      assert.notEqual(leases.at(-1)?.releasedAt, null);
    } finally {
      reopened?.close();
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
      const raw = new DatabaseSync(fixture.database.path);
      try {
        assert.deepEqual(
          (
            raw
              .prepare(
                `SELECT action FROM runtime_audit_records
                  WHERE entity_type = 'review-topic' AND entity_id = ?
                    AND action IN ('review.topic.blocked', 'review.topic.activated')
                  ORDER BY created_at, action`,
              )
              .all(ready.topicId) as Array<{ readonly action: string }>
          ).map((row) => row.action),
          ["review.topic.blocked", "review.topic.activated"],
        );
      } finally {
        raw.close();
      }
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

  it("rejects a Reviewer Execution Profile that reuses the producer allocation credential scope", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        raw
          .prepare(
            "UPDATE workspace_allocations SET execution_profile_id = 'review-profile' WHERE id = 'review-allocation'",
          )
          .run();
      } finally {
        raw.close();
      }
      const result = fixture.execute(
        "reject-shared-reviewer-profile",
        4,
        startCommand(fixture),
      );
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.equal(result.error.code, "REVIEWER_CREDENTIAL_SCOPE_INVALID");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rejects distinct producer and Reviewer Secret References with an overlapping provider credential scope", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter, undefined, {
      producer: "shared-provider-account",
      reviewer: "shared-provider-account",
    });
    try {
      const result = fixture.execute(
        "reject-overlapping-secret-scope",
        4,
        startCommand(fixture),
      );
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.equal(result.error.code, "REVIEWER_CREDENTIAL_SCOPE_INVALID");
      }
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
      const secretBlob = execFileSync(
        "git",
        ["-C", fixture.repositoryRoot, "hash-object", "-w", "--stdin"],
        { input: "hidden history\n", encoding: "utf8" },
      ).trim();
      const secretTree = execFileSync(
        "git",
        ["-C", fixture.repositoryRoot, "mktree"],
        {
          input: `100644 blob ${secretBlob}\thidden.txt\n`,
          encoding: "utf8",
        },
      ).trim();
      const secretCommit = execFileSync(
        "git",
        ["-C", fixture.repositoryRoot, "commit-tree", secretTree],
        { input: "hidden branch\n", encoding: "utf8" },
      ).trim();
      git(
        fixture.repositoryRoot,
        "update-ref",
        "refs/heads/hidden-review-input",
        secretCommit,
      );
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
      assert.throws(() => git(sourcePath, "cat-file", "-e", secretCommit));

      const inputsPath = join(ready.workspace.workspaceRef!, "inputs");
      chmodSync(inputsPath, 0o755);
      writeFileSync(join(inputsPath, "unexpected.txt"), "not allowlisted\n");
      const replay = openLocalReviewerWorkspaceAdapter(
        fixture.companyDir,
      ).provision({
        operationKey: ready.workspace.operationKey,
        manifest: ready.manifest,
        reviewer: {
          aiMemberId: ready.workspace.reviewerAiMemberId,
          positionId: ready.workspace.reviewerPositionId,
          sessionId: ready.workspace.reviewerSessionId,
        },
      });
      assert.equal(replay.status, "blocked");
      if (replay.status === "blocked") {
        assert.match(replay.message, /unexpected entries/);
      }
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

  it("fails closed when the Reviewer Workspace root is pre-created with unknown content", () => {
    const fixture = setup();
    try {
      const started = fixture.execute(
        "start-precreated-reviewer-root",
        4,
        startCommand(fixture),
      );
      assert.equal(started.status, "succeeded");
      const reviewerRoot = join(
        fixture.companyDir,
        ".sandcastle",
        "reviewer-workspaces",
        hash("code-review:code-review-1:workspace"),
      );
      mkdirSync(reviewerRoot, { recursive: true });
      writeFileSync(join(reviewerRoot, "unknown.txt"), "not allowlisted\n");
      const blocked =
        fixture.database.codeReviews.reconcileReviewerWorkspace(
          "code-review-1",
        );
      assert.equal(blocked.workspace.state, "blocked");
      assert.match(
        blocked.workspace.failureMessage ?? "",
        /unexpected entries/,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when the Reviewer Workspace root is a symbolic link", () => {
    if (process.platform === "win32") return;
    const fixture = setup();
    try {
      const started = fixture.execute(
        "start-symlink-reviewer-root",
        4,
        startCommand(fixture),
      );
      assert.equal(started.status, "succeeded");
      const reviewerParent = join(
        fixture.companyDir,
        ".sandcastle",
        "reviewer-workspaces",
      );
      mkdirSync(reviewerParent, { recursive: true });
      symlinkSync(
        fixture.repositoryRoot,
        join(reviewerParent, hash("code-review:code-review-1:workspace")),
        "dir",
      );
      const blocked =
        fixture.database.codeReviews.reconcileReviewerWorkspace(
          "code-review-1",
        );
      assert.equal(blocked.workspace.state, "blocked");
      assert.match(blocked.workspace.failureMessage ?? "", /symbolic link/);
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

  it("rejects Integration authority when the two Reviewer execution receipts are absent", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS", {
        omitExecutionStages: true,
      });
      const converged = fixture.execute("converge-without-executions", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "rejected");
      if (converged.status === "rejected") {
        assert.equal(converged.error.code, "REVIEWER_EXECUTION_REQUIRED");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rejects Integration authority when a Reviewer execution result does not match the persisted review evidence", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw.exec("DROP TRIGGER code_review_execution_stages_succeeded_update");
        const resultJson = JSON.stringify({
          findings: [
            {
              severity: "info",
              summary: "A different finding was returned by the execution.",
              rationale: "The execution receipt must bind exact review data.",
              impact: "Persisted review evidence no longer matches.",
              evidenceRefs: [reviewed.manifest.diffArtifactVersionId],
              suggestedOwner: "software-engineer",
              blocking: false,
            },
          ],
        });
        raw
          .prepare(
            `UPDATE code_review_execution_stages
                SET result_json = ?, result_hash = ?
              WHERE code_review_manifest_id = ?
                AND phase = 'initial-finding'`,
          )
          .run(resultJson, hash(resultJson), reviewed.id);
      } finally {
        raw.close();
      }
      const converged = fixture.execute("reject-mismatched-execution", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "rejected");
      if (converged.status === "rejected") {
        assert.equal(converged.error.code, "REVIEWER_EXECUTION_REQUIRED");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("freezes every successful Reviewer execution evidence column", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      assert.throws(() => {
        const raw = new DatabaseSync(fixture.database.path);
        try {
          raw
            .prepare(
              `UPDATE code_review_execution_stages
                  SET provider_id = 'rewritten-provider'
                WHERE code_review_manifest_id = ?
                  AND phase = 'initial-finding'`,
            )
            .run(reviewed.id);
        } finally {
          raw.close();
        }
      }, /immutable/);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects an existing authority at query time when its bound execution evidence is corrupted", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const converged = fixture.execute("converge-before-corruption", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(converged.status, "succeeded");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw.exec("DROP TRIGGER code_review_execution_stages_succeeded_update");
        const resultJson = JSON.stringify({
          result: "FAIL",
          conditions: [],
          evidenceRefs: [reviewed.manifest.diffArtifactVersionId],
        });
        raw
          .prepare(
            `UPDATE code_review_execution_stages
                SET result_json = ?, result_hash = ?
              WHERE code_review_manifest_id = ?
                AND phase = 'fresh-recheck'`,
          )
          .run(resultJson, hash(resultJson), reviewed.id);
      } finally {
        raw.close();
      }
      const inspected = fixture.database.codeReviews
        .inspect("review-run")
        .find((review) => review.id === reviewed.id);
      assert.equal(inspected?.integrationEligible, false);
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
      const historical = completeGenericReview(fixture, "PASS", {
        suffix: "history",
      });
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
          .run(historical.topicId);
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
          .run(historical.gateResult!.id);
        raw
          .prepare(
            `INSERT INTO code_review_defects(
               id, code_review_manifest_id, quality_gate_result_id,
               work_package_id, result, finding_ids_json, obligation_json,
               rework_work_package_version_id, status, created_at
             ) VALUES ('rework-obligation', ?, ?, ?, 'FAIL', ?, ?, ?,
                       'rework-created', '2026-07-28T10:02:00.000Z')`,
          )
          .run(
            historical.id,
            "rework-obligation-gate",
            historical.manifest.workPackageId,
            JSON.stringify(["review-finding-history-PASS"]),
            JSON.stringify({
              conditions: ["Resolve the historical finding"],
              evidenceRefs: ["obligation-evidence"],
              freshIndependentReReviewRequired: true,
            }),
            historical.manifest.workPackageVersionId,
          );
        raw
          .prepare(
            `INSERT INTO review_resolutions(
               id, topic_id, finding_id, participant_id, disposition,
               response, evidence_refs_json, revised_subject_id,
               revised_subject_hash, created_at
             ) VALUES ('historical-resolution', ?, ?, ?, 'resolved',
                       'The rework resolves the historical finding.', ?,
                       NULL, NULL, '2026-07-28T10:01:30.000Z')`,
          )
          .run(
            historical.topicId,
            "review-finding-history-PASS",
            `${historical.id}:owner`,
            JSON.stringify(["resolution-evidence"]),
          );
      } finally {
        raw.close();
      }

      const reviewed = completeGenericReview(fixture, "PASS", {
        suffix: "resolved",
      });
      assert.equal(
        reviewed.manifest.priorReview?.defectId,
        "rework-obligation",
      );
      assert.deepEqual(reviewed.manifest.priorReview?.requiredEvidenceRefs, [
        "rework-obligation",
        "rework-obligation-gate",
        "review-finding-history-PASS",
        historical.manifest.diffArtifactVersionId,
        "historical-resolution",
        "obligation-evidence",
        "resolution-evidence",
      ]);

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

  it("blocks a fresh review when the prior Defect has no evidence-backed finding resolution", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const historical = completeGenericReview(fixture, "PASS", {
        suffix: "missing-resolution-history",
      });
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `INSERT INTO code_review_defects(
               id, code_review_manifest_id, quality_gate_result_id,
               work_package_id, result, finding_ids_json, obligation_json,
               rework_work_package_version_id, status, created_at
             ) VALUES ('missing-resolution-defect', ?, ?, ?, 'FAIL', ?, ?, ?,
                       'rework-created', '2026-07-28T10:03:00.000Z')`,
          )
          .run(
            historical.id,
            historical.gateResult!.id,
            historical.manifest.workPackageId,
            JSON.stringify(["review-finding-missing-resolution-history-PASS"]),
            JSON.stringify({
              conditions: ["Resolve the historical finding"],
              evidenceRefs: ["obligation-evidence"],
              freshIndependentReReviewRequired: true,
            }),
            historical.manifest.workPackageVersionId,
          );
      } finally {
        raw.close();
      }
      const started = fixture.execute("reject-missing-resolution", 4, {
        ...startCommand(fixture),
        codeReviewId: "code-review-missing-resolution",
        topicId: "code-review-topic-missing-resolution",
      });
      assert.equal(started.status, "rejected");
      if (started.status === "rejected") {
        assert.equal(started.error.code, "CODE_REVIEW_OBLIGATION_INVALID");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("keeps the shared Code Review barrier running until every active Work Package has a fresh PASS", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const second = addSecondWorkPackage(fixture);
      const firstReview = completeGenericReview(fixture, "PASS");
      const firstConvergence = fixture.execute("converge-package-1", 4, {
        type: "code-review.converge",
        codeReviewId: firstReview.id,
      });
      assert.equal(firstConvergence.status, "succeeded");
      const raw = new DatabaseSync(fixture.database.path);
      const status = (id: string): string =>
        String(
          (
            raw
              .prepare("SELECT status FROM node_runs WHERE id = ?")
              .get(id) as {
              readonly status: string;
            }
          ).status,
        );
      assert.equal(status("code-review-node"), "running");
      assert.equal(status("integration-node"), "queued");

      const secondReview = completeGenericReview(fixture, "PASS", {
        suffix: "2",
        workPackageId: "review-package-2",
        diffArtifactVersionId: second.diff.id,
        producerSessionId: second.producerSessionId,
      });
      const secondConvergence = fixture.execute("converge-package-2", 4, {
        type: "code-review.converge",
        codeReviewId: secondReview.id,
      });
      assert.equal(secondConvergence.status, "succeeded");
      assert.equal(status("code-review-node"), "succeeded");
      assert.equal(status("integration-node"), "ready");
      assert.deepEqual(
        fixture.database.codeReviews
          .inspect("review-run")
          .filter((review) => review.integrationEligible)
          .map((review) => review.manifest.workPackageVersionId)
          .sort(),
        ["review-package-2-v1", "review-package-v1"],
      );
      const authorities = fixture.database.codeReviews
        .inspect("review-run")
        .filter((review) => review.integrationEligible)
        .sort((left, right) =>
          left.manifest.workPackageVersionId.localeCompare(
            right.manifest.workPackageVersionId,
          ),
        );
      const aggregate = JSON.parse(
        String(
          (
            raw
              .prepare(
                `SELECT structured_result_json AS resultJson
                   FROM node_attempts
                  WHERE node_run_id = 'code-review-node'
                  ORDER BY attempt_number DESC LIMIT 1`,
              )
              .get() as { readonly resultJson: string }
          ).resultJson,
        ),
      ) as {
        readonly workPackageVersionIds: string[];
        readonly authorityIds: string[];
        readonly qualityGateResultIds: string[];
        readonly coverageHash: string;
      };
      assert.deepEqual(
        aggregate.workPackageVersionIds,
        authorities.map((review) => review.manifest.workPackageVersionId),
      );
      assert.deepEqual(
        aggregate.authorityIds,
        authorities.map((review) => review.authority!.id),
      );
      assert.deepEqual(
        aggregate.qualityGateResultIds,
        authorities.map((review) => review.gateResult!.id),
      );
      assert.match(aggregate.coverageHash, /^[a-f0-9]{64}$/);
      const completedCoverage =
        fixture.database.codeReviews.readCompletedCoverage("review-run");
      assert.equal(
        completedCoverage.coverageId,
        completedCoverage.nodeAttemptId,
      );
      assert.equal(completedCoverage.coverageHash, aggregate.coverageHash);
      assert.deepEqual(
        completedCoverage.packages.map((entry) => ({
          versionId: entry.workPackageVersionId,
          authorityId: entry.authorityId,
          gateResultId: entry.qualityGateResultId,
          sourceCommit: entry.sourceCommit,
        })),
        authorities.map((review) => ({
          versionId: review.manifest.workPackageVersionId,
          authorityId: review.authority!.id,
          gateResultId: review.gateResult!.id,
          sourceCommit: review.manifest.sourceCommit,
        })),
      );
      raw.close();
    } finally {
      fixture.database.close();
    }
  });

  it("does not repackage completed Code Review authority under a newer Run Snapshot", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const converged = fixture.execute(
        "converge-before-snapshot-recovery",
        4,
        {
          type: "code-review.converge",
          codeReviewId: reviewed.id,
        },
      );
      assert.equal(converged.status, "succeeded");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw.exec(`
          INSERT INTO run_snapshot_revisions(
            id, run_id, revision, schema_version, canonical_json, hash,
            created_at, parent_revision
          )
          SELECT 'review-snapshot-recovered', run_id, revision + 1,
                 schema_version, canonical_json, hash,
                 '2026-07-28T10:30:00.000Z', revision
            FROM run_snapshot_revisions WHERE id = 'review-snapshot';
          UPDATE department_runs
             SET snapshot_revision_id = 'review-snapshot-recovered'
           WHERE id = 'review-run';
        `);
      } finally {
        raw.close();
      }

      assert.equal(
        fixture.database.codeReviews.inspect("review-run")[0]
          ?.integrationEligible,
        false,
      );
      assert.throws(
        () => fixture.database.codeReviews.readCompletedCoverage("review-run"),
        (error: unknown) =>
          error instanceof CodeReviewRuntimeError &&
          error.code === "CODE_REVIEW_COVERAGE_STALE",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("recovers through a fresh T15 authority before T16 creates a fresh g2 Generation", async () => {
    const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
      execute: (input) => ({
        status: "succeeded",
        providerId: "scripted-docker-reviewer",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "scripted-docker-readonly",
          mechanismVersion: "1",
        },
        isolationEvidence: [
          "mount:/review:readonly",
          `operation:${input.operationKey}`,
        ],
        output:
          input.phase === "initial-finding"
            ? {
                findings: [
                  {
                    severity: "info",
                    summary: "The exact recovered Diff was reviewed.",
                    rationale: "The frozen recovered input is acceptable.",
                    impact: "No blocking issue was found.",
                    evidenceRefs: [input.manifest.selfCheck.id],
                    suggestedOwner: "software-engineer",
                    blocking: false,
                  },
                ],
              }
            : {
                result: "PASS",
                conditions: [],
                evidenceRefs: [input.manifest.selfCheck.id],
              },
      }),
    });
    const fixture = setup(
      readyReviewerWorkspaceAdapter,
      reviewerExecutionAdapter,
      undefined,
      {
        gitAdapter: {
          execute: (input) => ({
            status: "succeeded",
            beforeTip: input.expectedTip,
            afterTip: input.sourceCommit,
            resultingCommit: input.sourceCommit,
            receipt: { operationId: input.operationId },
          }),
          reconcile: () => ({ status: "not-applied" }),
        },
        validationExecutor: {
          execute: async (input) => ({
            status: "unknown",
            code: "VALIDATION_RECONCILIATION_REQUIRED",
            message:
              "Keep the fresh Generation blocked after authority capture.",
            evidence: { operationKey: input.operationKey },
          }),
          reconcile: async (input) => ({
            status: "unknown",
            code: "VALIDATION_RECONCILIATION_REQUIRED",
            message:
              "Keep the fresh Generation blocked after authority capture.",
            evidence: { operationKey: input.operationKey },
          }),
        },
      },
    );
    try {
      const firstReview = completeGenericReview(fixture, "PASS");
      const converged = fixture.execute("converge-before-t16-recovery", 4, {
        type: "code-review.converge",
        codeReviewId: firstReview.id,
      });
      assert.equal(converged.status, "succeeded");
      const completedFirstReview = fixture.database.codeReviews
        .inspect("review-run")
        .find((review) => review.id === firstReview.id)!;
      const oldCoverage =
        fixture.database.codeReviews.readCompletedCoverage("review-run");
      const oldAuthorityId = completedFirstReview.authority!.id;
      const oldGateId = completedFirstReview.gateResult!.id;

      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw.exec(`
          INSERT INTO run_snapshot_revisions(
            id, run_id, revision, schema_version, canonical_json, hash,
            created_at, parent_revision
          )
          SELECT 'review-snapshot-recovered', run_id, revision + 1,
                 schema_version, canonical_json, hash,
                 '2026-07-28T11:00:00.000Z', revision
            FROM run_snapshot_revisions WHERE id = 'review-snapshot';
          UPDATE department_runs
             SET snapshot_revision_id = 'review-snapshot-recovered'
           WHERE id = 'review-run';
        `);
      } finally {
        raw.close();
      }
      assert.equal(
        fixture.database.codeReviews.inspect("review-run")[0]
          ?.integrationEligible,
        false,
      );

      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        async () => undefined,
      );
      const beforeStaleIntegration =
        fixture.database.pipelineRuntime.inspectRun("review-run");
      await fixture.database.pipelineRuntime.executeReady({
        runId: "review-run",
        expectedRevision: beforeStaleIntegration.run.revision,
      });
      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        fixture.database.integrationNodeHandler.executeReady,
      );
      await fixture.database.integrationNodeHandler.executeReady({
        runId: "review-run",
        nodeRunId: "integration-node",
      });
      const staleBlocked =
        fixture.database.pipelineRuntime.inspectRun("review-run");
      assert.equal(
        staleBlocked.nodes.find((node) => node.id === "integration-node")
          ?.status,
        "blocked",
      );
      assert.deepEqual(fixture.database.integrations.inspect("review-run"), []);
      const staleReceipt = new DatabaseSync(fixture.database.path);
      try {
        const receipt = staleReceipt
          .prepare(
            `SELECT result_json AS resultJson FROM command_deduplication
              WHERE command_id =
                'integration:review-run:integration-node:g1:start'`,
          )
          .get() as { readonly resultJson: string } | undefined;
        assert.ok(receipt);
        assert.equal(JSON.parse(receipt.resultJson).status, "rejected");
      } finally {
        staleReceipt.close();
      }

      fixture.database.pipelineRuntime.requeueIntegrationRecoveryInTransaction({
        runId: "review-run",
        integrationNodeRunId: "integration-node",
        generationId: "integration:review-run:g1",
      });
      const freshProducerSession = fixture.database.interaction.createSession({
        projectId: fixture.projectId,
        mode: "consultation",
      });
      fixture.database.interaction.addParticipant({
        sessionId: freshProducerSession.id,
        participantType: "ai-member",
        participantRef: "software-engineer-member",
        role: "developer",
      });
      const recovered = new DatabaseSync(fixture.database.path);
      try {
        recovered.exec("PRAGMA foreign_keys = OFF");
        recovered
          .prepare(
            `INSERT INTO node_attempts(
               id, node_run_id, attempt_number, snapshot_revision_id, reason,
               status, created_at, started_at, completed_at, recoverable
             ) VALUES ('review-attempt-recovered', 'review-node', 2,
                       'review-snapshot-recovered', 'recovery', 'succeeded',
                       ?, ?, ?, 0)`,
          )
          .run(
            "2026-07-28T11:01:00.000Z",
            "2026-07-28T11:01:00.000Z",
            "2026-07-28T11:01:00.000Z",
          );
        recovered
          .prepare(
            `UPDATE node_runs SET attempt_count = 2, updated_at = ?
              WHERE id = 'review-node'`,
          )
          .run("2026-07-28T11:01:00.000Z");
        recovered.exec(`
          INSERT INTO workspace_allocations(
            id, project_id, application_id, execution_profile_id,
            execution_profile_revision, operation_key, state, repository_root,
            allocation_root, source_branch, base_commit, expected_source_tip,
            capability_snapshot_json, capability_snapshot_hash,
            provision_command_id, revision, created_at, updated_at,
            work_package_version_id, node_attempt_id, interaction_session_id,
            sandbox_identity, evidence_scope
          )
          SELECT 'review-allocation-recovered', project_id, application_id,
                 execution_profile_id, execution_profile_revision,
                 'review-operation-recovered', state, repository_root,
                 allocation_root || '-recovered', 'sandcastle/review-recovered',
                 base_commit, expected_source_tip, capability_snapshot_json,
                 capability_snapshot_hash, 'review-provision-recovered',
                 revision, '2026-07-28T11:01:00.000Z',
                 '2026-07-28T11:01:00.000Z', work_package_version_id,
                 'review-attempt-recovered', '${freshProducerSession.id}',
                 'review-sandbox-recovered', 'review-evidence-recovered'
            FROM workspace_allocations WHERE id = 'review-allocation';
          INSERT INTO workspace_imports(
            id, allocation_id, command_id, request_hash, state,
            expected_source_tip, before_source_tip, result_commit,
            object_set_hash, receipt_json, created_at, updated_at
          )
          SELECT 'review-import-recovered', 'review-allocation-recovered',
                 'review-import-command-recovered', request_hash, state,
                 expected_source_tip, before_source_tip, result_commit,
                 object_set_hash, receipt_json, '2026-07-28T11:01:00.000Z',
                 '2026-07-28T11:01:00.000Z'
            FROM workspace_imports WHERE id = 'review-import';
          INSERT INTO work_package_assignments(
            id, work_package_version_id, node_attempt_id, position_id,
            ai_member_id, agent_adapter_id, rationale_json, allocation_id,
            interaction_session_id, sandbox_identity, evidence_scope, state,
            created_at, updated_at
          )
          SELECT 'review-assignment-recovered', work_package_version_id,
                 'review-attempt-recovered', position_id, ai_member_id,
                 agent_adapter_id, rationale_json, 'review-allocation-recovered',
                 '${freshProducerSession.id}', 'review-sandbox-recovered',
                 'review-evidence-recovered', state,
                 '2026-07-28T11:01:00.000Z', '2026-07-28T11:01:00.000Z'
            FROM work_package_assignments WHERE id = 'review-assignment';
          INSERT INTO work_package_self_checks(
            id, assignment_id, node_attempt_id, status, report_json,
            report_hash, created_at
          )
          SELECT 'review-self-check-recovered', 'review-assignment-recovered',
                 'review-attempt-recovered', status, report_json, report_hash,
                 '2026-07-28T11:01:00.000Z'
            FROM work_package_self_checks WHERE id = 'review-self-check';
        `);
      } finally {
        recovered.close();
      }
      const freshDiff = fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.projectId,
        type: "canonical-diff",
        schemaVersion: "1",
        logicalName: "review-package-diff",
        content: fixture.diffBytes,
        status: "produced",
        producer: {
          runId: "review-run",
          nodeRunId: "review-node",
          nodeAttemptId: "review-attempt-recovered",
          snapshotRevisionId: "review-snapshot-recovered",
          aiMemberId: "software-engineer-member",
          positionId: "software-engineer",
          sessionId: freshProducerSession.id,
          workPackageId: "review-package",
        },
      });
      assert.notEqual(freshDiff.id, fixture.diff.id);
      fixture.database.pipelineRuntime.releaseWorkPackageSuccessorsInTransaction(
        {
          runId: "review-run",
          nodeRunId: "review-node",
          assignmentId: "review-assignment-recovered",
        },
      );

      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        async () => undefined,
      );
      const beforeFreshReview =
        fixture.database.pipelineRuntime.inspectRun("review-run");
      await fixture.database.pipelineRuntime.executeReady({
        runId: "review-run",
        expectedRevision: beforeFreshReview.run.revision,
      });
      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        fixture.database.integrationNodeHandler.executeReady,
      );
      const reviews = fixture.database.codeReviews.inspect("review-run");
      const freshReview = reviews.find(
        (review) =>
          review.manifest.snapshotRevisionId === "review-snapshot-recovered",
      );
      assert.ok(freshReview?.integrationEligible);
      assert.notEqual(freshReview.id, firstReview.id);
      assert.notEqual(freshReview.authority?.id, oldAuthorityId);
      assert.notEqual(freshReview.gateResult?.id, oldGateId);
      const freshCoverage =
        fixture.database.codeReviews.readCompletedCoverage("review-run");
      assert.notEqual(freshCoverage.coverageId, oldCoverage.coverageId);
      assert.notEqual(freshCoverage.coverageHash, oldCoverage.coverageHash);
      assert.equal(
        freshCoverage.snapshotRevisionId,
        "review-snapshot-recovered",
      );

      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        async () => undefined,
      );
      const beforeFreshIntegration =
        fixture.database.pipelineRuntime.inspectRun("review-run");
      await fixture.database.pipelineRuntime.executeReady({
        runId: "review-run",
        expectedRevision: beforeFreshIntegration.run.revision,
      });
      fixture.database.pipelineRuntime.registerIntegrationExecutor(
        fixture.database.integrationNodeHandler.executeReady,
      );
      await fixture.database.integrationNodeHandler.executeReady({
        runId: "review-run",
        nodeRunId: "integration-node",
      });
      const generations = fixture.database.integrations.inspect("review-run");
      assert.equal(generations.length, 1);
      const generation = generations[0]!;
      assert.equal(generation.id, "integration:review-run:g2");
      assert.equal(generation.manifest.generation, 2);
      assert.equal(generation.manifest.coverageId, freshCoverage.coverageId);
      assert.equal(
        generation.manifest.coverageHash,
        freshCoverage.coverageHash,
      );
      assert.equal(
        generation.manifest.snapshotRevisionId,
        "review-snapshot-recovered",
      );
      assert.equal(
        generation.manifest.packages[0]?.authorityId,
        freshReview.authority?.id,
      );
      assert.equal(
        generation.manifest.packages[0]?.qualityGateResultId,
        freshReview.gateResult?.id,
      );
      assert.notEqual(
        generation.manifest.packages[0]?.authorityId,
        oldAuthorityId,
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

  it("rejects PASS when the canonical Diff bytes change after the Gate is frozen", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      writeFileSync(
        join(fixture.companyDir, fixture.diff.contentRef),
        "tampered after review\n",
      );

      const stale = fixture.execute("reject-tampered-diff", 4, {
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

  it("rejects PASS when a frozen Reviewer Position is no longer active", () => {
    const fixture = setup(readyReviewerWorkspaceAdapter);
    try {
      const reviewed = completeGenericReview(fixture, "PASS");
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare("UPDATE positions SET status = 'archived' WHERE id = ?")
          .run("software-architect");
      } finally {
        raw.close();
      }

      const ineligible = fixture.execute("reject-inactive-reviewer", 4, {
        type: "code-review.converge",
        codeReviewId: reviewed.id,
      });
      assert.equal(ineligible.status, "rejected");
      if (ineligible.status === "rejected") {
        assert.equal(ineligible.error.code, "REVIEWER_INELIGIBLE");
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
