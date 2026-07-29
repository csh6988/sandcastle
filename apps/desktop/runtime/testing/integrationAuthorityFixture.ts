import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createScriptedExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import { createScriptedReviewerExecutionAdapter } from "../review/reviewerExecution.js";
import { openCompanyDatabase } from "../storage/sqlite.js";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const requireSucceeded = <Value>(
  result:
    | { readonly status: "succeeded"; readonly value: Value }
    | {
        readonly status: "rejected";
        readonly error: { readonly code: string; readonly message: string };
      },
): Value => {
  if (result.status === "rejected") {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

export interface IntegrationAuthorityFixtureResult {
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly testNodeRunId: string;
  readonly testNodeAttemptId: string;
  readonly testSessionId: string;
  readonly testOwnerPositionId: string;
  readonly testOwnerAiMemberId: string;
  readonly workPackageCoverage: readonly {
    readonly workPackageId: string;
    readonly workPackageVersionId: string;
    readonly manifestHash: string;
  }[];
  readonly testExecutionProfile: {
    readonly id: string;
    readonly hash: string;
  };
  readonly build: {
    readonly artifactVersionId: string;
    readonly digest: string;
  };
  readonly integrationAuthority: IntegrationGenerationView;
}

/**
 * Test-build-only setup seam. It may seed non-authoritative prerequisite rows,
 * with foreign keys enabled, but Code Review and Integration authority are
 * produced only by their registered Runtime handlers.
 */
export const createIntegrationAuthorityFixture = async (input: {
  readonly companyDirectory: string;
  readonly companyDirectoryFingerprint: string;
  readonly fixtureId: string;
  readonly repositoryDirectory: string;
  readonly worktreeDirectory: string;
  readonly fakeClock: string;
  readonly repeatableIdSeed: string;
}): Promise<IntegrationAuthorityFixtureResult> => {
  const clock = () => new Date(input.fakeClock);
  const baseCommit = git(input.repositoryDirectory, ["rev-parse", "HEAD"]);
  const sourceBranch = `fixture-source-${sha256(input.repeatableIdSeed).slice(0, 12)}`;
  git(input.worktreeDirectory, ["switch", "-c", sourceBranch]);
  writeFileSync(
    join(input.worktreeDirectory, "fixture-change.txt"),
    `${input.fixtureId}\n`,
  );
  git(input.worktreeDirectory, ["add", "fixture-change.txt"]);
  git(input.worktreeDirectory, [
    "-c",
    "user.name=Sandcastle Test Fixture",
    "-c",
    "user.email=fixture@sandcastle.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: add reviewed fixture change",
  ]);
  const sourceCommit = git(input.worktreeDirectory, ["rev-parse", "HEAD"]);
  git(input.worktreeDirectory, ["switch", "--detach", baseCommit]);
  const diffBytes = execFileSync(
    "git",
    [
      "-C",
      input.repositoryDirectory,
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

  const reviewerExecutionAdapter = createScriptedReviewerExecutionAdapter({
    execute: (request) => {
      const manifest = request.manifest as unknown as Record<string, unknown>;
      const integrationGenerationId = manifest.integrationGenerationId;
      const integrationManifestHash = manifest.integrationManifestHash;
      const repositoryCommits = manifest.repositoryCommits;
      const evidenceRefs =
        typeof integrationGenerationId === "string" &&
        typeof integrationManifestHash === "string" &&
        Array.isArray(repositoryCommits)
          ? [
              `integration-generation:${integrationGenerationId}`,
              `integration-manifest:${integrationManifestHash}`,
              ...repositoryCommits.map((entry) => {
                const commit = entry as {
                  readonly repositoryId: string;
                  readonly commit: string;
                };
                return `repository-commit:${commit.repositoryId}:${commit.commit}`;
              }),
            ]
          : [
              String(
                (request.manifest as { diffArtifactVersionId: string })
                  .diffArtifactVersionId,
              ),
            ];
      return {
        status: "succeeded" as const,
        providerId: "scripted-execution",
        isolation: {
          readOnlyFilesystem: true as const,
          independentGitDatabase: true as const,
          independentSessionStorage: true as const,
          independentCredentialScope: true as const,
          independentMutableCache: true as const,
          inputAllowlist: true as const,
          mechanism: "electron-test-fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: [
          `fixture:${input.fixtureId}`,
          `operation:${request.operationKey}`,
        ],
        terminalExecutionFactId: `${request.operationKey}:terminal`,
        output:
          request.phase === "initial-finding"
            ? {
                findings: [
                  {
                    severity: "info" as const,
                    summary:
                      "The exact frozen Diff was independently reviewed.",
                    rationale:
                      "The scripted test-build Reviewer inspected the allowlisted immutable input.",
                    impact:
                      "No blocking issue was found in the scoped fixture change.",
                    evidenceRefs,
                    suggestedOwner: "fixture-developer",
                    blocking: false,
                  },
                ],
              }
            : { result: "PASS" as const, conditions: [], evidenceRefs },
      };
    },
  });
  const database = openCompanyDatabase(input.companyDirectory, {
    clock,
    executionAdapter: createScriptedExecutionAdapter({
      defaultFact: {
        kind: "succeeded",
        structuredResult: { fixtureId: input.fixtureId },
      },
    }),
    codeReviewRuntime: { reviewerExecutionAdapter },
    integrationRuntime: {
      validationExecutor: {
        reconcile: async () => ({ status: "not-applied" }),
        execute: async (request) => ({
          status: "passed",
          evidenceRefs: [`fixture-validation:${request.validation.id}`],
          responsibleWorkPackageVersionIds:
            request.responsibleWorkPackageVersionIds,
        }),
      },
    },
  });
  try {
    const project = database.catalog.createProject({
      name: "Electron Test Fixture",
      goal: "Verify exact T15 and T16 authority before a scoped Test Run.",
    });
    database.projectConfiguration.update({
      projectId: project.id,
      expectedRevision: 0,
      name: project.name,
      goal: project.goal,
      sharedContext:
        "One temporary Repository produces one reviewed source commit.",
      repositoryReferences: [input.repositoryDirectory],
    });
    requireSucceeded(
      database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${input.fixtureId}:application-register`,
        actor: {
          type: "human",
          id: "electron-test-fixture",
          authenticatedBy: "local-session",
        },
        consumerId: "electron-test-fixture-setup",
        expectedRevision: 0,
        command: {
          type: "application.register",
          applicationId: `${input.fixtureId}:application`,
          projectId: project.id,
          repositoryReference: input.repositoryDirectory,
          applicationKey: "fixture",
          ownership: "software-rnd",
          buildCommand: "fixture-build",
          testCommand: "fixture-test",
        },
      }),
    );
    const department = database.catalog.createDepartment({
      name: "Electron Test Quality",
    });
    const createPosition = (name: string, focus: string) => {
      const before = database.catalog.inspectDepartment(department.id);
      const after = database.catalog.createPosition({
        departmentId: department.id,
        name,
        responsibility: `${name} responsibility for the scoped fixture.`,
        aiMemberDisplayName: `${name} Member`,
        aiMemberProfile: `${name} deterministic test-build participant.`,
        aiMemberResponsibilityMetadata: { focus },
      });
      return after.positions.find(
        (position) =>
          !before.positions.some((candidate) => candidate.id === position.id),
      )!;
    };
    const developer = createPosition("Fixture Developer", "development");
    const reviewer = createPosition("Fixture Reviewer", "review");
    const freshReviewer = createPosition("Fixture Fresh Reviewer", "review");
    const tester = createPosition("Fixture Test Engineer", "test");
    const producerProfile = database.catalog
      .saveExecutionProfile({
        departmentId: department.id,
        expectedRevision: 0,
        name: "Fixture producer execution",
        providerRef: "scripted-execution",
        model: "fixture-v1",
        sandboxRef: "docker",
        branchStrategy: "branch",
        timeoutSeconds: 30,
        maxIterations: 1,
        maxTokens: null,
        retryMaxAttempts: 0,
        permissionPolicy: "deny",
        secretReferenceIds: [],
      })
      .executionProfiles.find(
        (candidate) => candidate.name === "Fixture producer execution",
      )!;
    const profile = database.catalog
      .saveExecutionProfile({
        departmentId: department.id,
        expectedRevision: 0,
        name: "Fixture isolated execution",
        providerRef: "scripted-execution",
        model: "fixture-v1",
        sandboxRef: "docker",
        branchStrategy: "branch",
        timeoutSeconds: 30,
        maxIterations: 1,
        maxTokens: null,
        retryMaxAttempts: 0,
        permissionPolicy: "deny",
        secretReferenceIds: [],
      })
      .executionProfiles.find(
        (candidate) => candidate.name === "Fixture isolated execution",
      )!;
    database.catalog.updateDepartment({
      departmentId: department.id,
      expectedRevision: 0,
      name: department.name,
      description: "Scoped exact-authority Electron Test fixture.",
      inputArtifactContracts: [],
      outputArtifactContracts: [],
      defaultExecutionProfileId: profile.id,
    });
    const graph = {
      nodes: [
        {
          id: "start",
          type: "start" as const,
          name: "Start",
          handlerKindId: "run-start@1",
        },
        {
          id: "development",
          type: "ai-task" as const,
          name: "Development",
          positionId: developer.id,
          executionProfileId: producerProfile.id,
          handlerKindId: "development@1",
        },
        {
          id: "review",
          type: "ai-task" as const,
          name: "Code Review",
          positionId: reviewer.id,
          executionProfileId: profile.id,
          handlerKindId: "code-review@1",
        },
        {
          id: "integration",
          type: "ai-task" as const,
          name: "Integration",
          positionId: freshReviewer.id,
          executionProfileId: profile.id,
          handlerKindId: "integration@1",
        },
        {
          id: "test",
          type: "ai-task" as const,
          name: "Test",
          positionId: tester.id,
          executionProfileId: profile.id,
          handlerKindId: "test@1",
        },
        {
          id: "complete",
          type: "complete" as const,
          name: "Complete",
          handlerKindId: "run-complete@1",
        },
      ],
      edges: [
        { from: "start", to: "development" },
        { from: "development", to: "review" },
        { from: "review", to: "integration" },
        { from: "integration", to: "test" },
        { from: "test", to: "complete" },
      ],
    };
    const draft = database.pipelineConfiguration.saveDraft({
      departmentId: department.id,
      expectedRevision: 0,
      graph,
    });
    database.pipelineConfiguration.publish({
      departmentId: department.id,
      expectedRevision: draft.draft.revision,
    });
    const started = database.pipelineRuntime.startRun({
      projectId: project.id,
      departmentId: department.id,
    });
    const awaitingReview = await database.pipelineRuntime.executeReady({
      runId: started.run.id,
      expectedRevision: started.run.revision,
    });
    const developmentNode = awaitingReview.nodes.find(
      (node) => node.pipelineNodeId === "development",
    );
    const developmentAttempt = developmentNode?.attempts.at(-1);
    const reviewNode = awaitingReview.nodes.find(
      (node) => node.pipelineNodeId === "review",
    );
    if (
      developmentNode?.status !== "succeeded" ||
      !developmentAttempt ||
      reviewNode?.status !== "ready"
    ) {
      throw new Error("Fixture Pipeline did not stop at the Code Review seam.");
    }
    const producerSession = database.interaction.createSession({
      projectId: project.id,
      mode: "run-collaboration",
      runId: awaitingReview.run.id,
      nodeRunId: developmentNode.id,
    });
    database.interaction.addParticipant({
      sessionId: producerSession.id,
      participantType: "ai-member",
      participantRef: developer.aiMember.id,
      role: "developer",
    });

    const now = input.fakeClock;
    const productProposalId = `${input.fixtureId}:product-proposal`;
    const productProposalRevisionId = `${productProposalId}:r1`;
    const productBaselineId = `${input.fixtureId}:product-baseline`;
    const projectSpecId = `${input.fixtureId}:project-spec`;
    const projectSpecRevisionId = `${projectSpecId}:r1`;
    const technicalProposalId = `${input.fixtureId}:technical-proposal`;
    const technicalProposalRevisionId = `${technicalProposalId}:r1`;
    const technicalBaselineId = `${input.fixtureId}:technical-baseline`;
    const workPackageId = `${input.fixtureId}:work-package`;
    const workPackageVersionId = `${workPackageId}:v1`;
    const allocationId = `${input.fixtureId}:allocation`;
    const manifest = {
      objective: "Apply the scoped fixture change.",
      acceptanceCriteria: ["The exact frozen Diff is independently reviewed."],
      moduleScope: ["fixture-change.txt"],
      allowedPermissions: ["repository.write"],
      specRefs: [projectSpecRevisionId],
      harnessRefs: ["fixture:tdd@1"],
      assignmentCriteria: { positionIds: [developer.id] },
      expectedArtifacts: ["canonical-diff"],
      selfCheckCommands: ["fixture-test"],
      codeReviewConditions: ["Independent PASS required"],
      integrationConditions: ["npm test"],
      riskTier: "medium",
      recoveryPolicy: "Create a fresh Version and Attempt.",
      execution: {
        profileId: producerProfile.id,
        branchStrategy: "branch",
        gitRefWriteIsolation: true,
        runtimeImportOnly: true,
      },
    };
    const selfCheck = {
      status: "passed",
      commands: ["fixture-test"],
      logRefs: ["fixture:self-check"],
      commitEvidence: [sourceCommit],
      summary: "The scoped fixture self-check passed.",
      approval: false,
    };
    const raw = new DatabaseSync(database.path);
    try {
      raw.exec("PRAGMA foreign_keys = ON");
      raw.exec("BEGIN IMMEDIATE");
      raw
        .prepare(
          `INSERT INTO product_proposals(
           id, project_id, status, revision, current_revision_id,
           created_at, updated_at
         ) VALUES (?, ?, 'confirmed', 1, ?, ?, ?)`,
        )
        .run(
          productProposalId,
          project.id,
          productProposalRevisionId,
          now,
          now,
        );
      raw
        .prepare(
          `INSERT INTO product_proposal_revisions(
           id, proposal_id, revision, content_json, content_hash,
           producer_ai_member_id, producer_position_id, producer_session_id,
           edited_by_type, edited_by_id, edited_by_authenticated_by, created_at
         ) VALUES (?, ?, 1, '{}', ?, ?, ?, ?, 'runtime-worker', ?, 'runtime', ?)`,
        )
        .run(
          productProposalRevisionId,
          productProposalId,
          sha256("{}"),
          developer.aiMember.id,
          developer.id,
          producerSession.id,
          developer.aiMember.id,
          now,
        );
      raw
        .prepare(
          `INSERT INTO product_baselines(
           id, project_id, source_proposal_revision_id, source_proposal_hash,
           content_json, canonical_hash, confirmed_by_type, confirmed_by_id,
           confirmed_by_authenticated_by, confirmation_command_id, run_id,
           snapshot_revision_id, confirmed_at
         ) VALUES (?, ?, ?, ?, '{}', ?, 'human', 'electron-test-fixture',
                   'local-session', ?, ?, ?, ?)`,
        )
        .run(
          productBaselineId,
          project.id,
          productProposalRevisionId,
          sha256("{}"),
          sha256("{}"),
          `${input.fixtureId}:product-confirm`,
          awaitingReview.run.id,
          awaitingReview.snapshot.id,
          now,
        );
      raw
        .prepare(
          `INSERT INTO project_specs(
           id, project_id, run_id, product_baseline_id, current_revision_id,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          projectSpecId,
          project.id,
          awaitingReview.run.id,
          productBaselineId,
          projectSpecRevisionId,
          now,
          now,
        );
      raw
        .prepare(
          `INSERT INTO project_spec_revisions(
           id, project_spec_id, project_id, run_id, product_baseline_id,
           product_baseline_hash, revision, content_json, content_hash,
           producer_ai_member_id, producer_position_id, producer_session_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, '{}', ?, ?, ?, ?, ?)`,
        )
        .run(
          projectSpecRevisionId,
          projectSpecId,
          project.id,
          awaitingReview.run.id,
          productBaselineId,
          sha256("{}"),
          sha256("{}"),
          developer.aiMember.id,
          developer.id,
          producerSession.id,
          now,
        );
      raw
        .prepare(
          `INSERT INTO technical_baseline_proposals(
           id, project_id, run_id, current_revision_id, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          technicalProposalId,
          project.id,
          awaitingReview.run.id,
          technicalProposalRevisionId,
          now,
          now,
        );
      raw
        .prepare(
          `INSERT INTO technical_baseline_proposal_revisions(
           id, technical_baseline_proposal_id, project_id, run_id,
           promoted_project_spec_revision_id, promoted_project_spec_hash,
           readiness_evidence_json, application_spec_revisions_json,
           revision, content_json, content_hash, producer_ai_member_id,
           producer_position_id, producer_session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 1, '{}', ?, ?, ?, ?, ?)`,
        )
        .run(
          technicalProposalRevisionId,
          technicalProposalId,
          project.id,
          awaitingReview.run.id,
          projectSpecRevisionId,
          sha256("{}"),
          sha256("{}"),
          developer.aiMember.id,
          developer.id,
          producerSession.id,
          now,
        );
      raw
        .prepare(
          `INSERT INTO technical_baselines(
           id, project_id, run_id, proposal_revision_id, manifest_json,
           manifest_hash, created_at
         ) VALUES (?, ?, ?, ?, '{}', ?, ?)`,
        )
        .run(
          technicalBaselineId,
          project.id,
          awaitingReview.run.id,
          technicalProposalRevisionId,
          sha256("{}"),
          now,
        );
      raw
        .prepare(
          `INSERT INTO work_packages(
           id, project_id, run_id, technical_baseline_id, state, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'self-check', 4, ?, ?)`,
        )
        .run(
          workPackageId,
          project.id,
          awaitingReview.run.id,
          technicalBaselineId,
          now,
          now,
        );
      raw
        .prepare(
          `INSERT INTO work_package_versions(
           id, work_package_id, version, application_id,
           repository_reference, node_run_id, manifest_json, manifest_hash,
           status, created_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', ?)`,
        )
        .run(
          workPackageVersionId,
          workPackageId,
          `${input.fixtureId}:application`,
          input.repositoryDirectory,
          developmentNode.id,
          canonicalJson(manifest),
          sha256(canonicalJson(manifest)),
          now,
        );
      const capabilitySnapshot = canonicalJson({
        repositoryRoot: input.repositoryDirectory,
        worktreeRoot: input.worktreeDirectory,
        sourceBranch,
        baseCommit,
      });
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
         ) VALUES (?, ?, ?, ?, 0, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, 1,
                   ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          allocationId,
          project.id,
          `${input.fixtureId}:application`,
          producerProfile.id,
          `${input.fixtureId}:allocation-operation`,
          input.repositoryDirectory,
          input.worktreeDirectory,
          sourceBranch,
          baseCommit,
          baseCommit,
          capabilitySnapshot,
          sha256(capabilitySnapshot),
          `${input.fixtureId}:allocation-provision`,
          now,
          now,
          workPackageVersionId,
          developmentAttempt.id,
          producerSession.id,
          `${input.fixtureId}:sandbox`,
          `${input.fixtureId}:evidence-scope`,
        );
      raw
        .prepare(
          `INSERT INTO workspace_imports(
           id, allocation_id, command_id, request_hash, state,
           expected_source_tip, before_source_tip, result_commit,
           object_set_hash, receipt_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, '{}', ?, ?)`,
        )
        .run(
          `${input.fixtureId}:source-import`,
          allocationId,
          `${input.fixtureId}:source-import-command`,
          sha256(`${baseCommit}:${sourceCommit}`),
          baseCommit,
          baseCommit,
          sourceCommit,
          sha256(sourceCommit),
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
         ) VALUES (?, ?, ?, ?, ?, 'scripted-execution', '{}', ?, ?, ?, ?,
                   'self-check-passed', ?, ?)`,
        )
        .run(
          `${input.fixtureId}:assignment`,
          workPackageVersionId,
          developmentAttempt.id,
          developer.id,
          developer.aiMember.id,
          allocationId,
          producerSession.id,
          `${input.fixtureId}:sandbox`,
          `${input.fixtureId}:evidence-scope`,
          now,
          now,
        );
      raw
        .prepare(
          `INSERT INTO work_package_self_checks(
           id, assignment_id, node_attempt_id, status, report_json,
           report_hash, created_at
         ) VALUES (?, ?, ?, 'passed', ?, ?, ?)`,
        )
        .run(
          `${input.fixtureId}:self-check`,
          `${input.fixtureId}:assignment`,
          developmentAttempt.id,
          canonicalJson(selfCheck),
          sha256(canonicalJson(selfCheck)),
          now,
        );
      raw.exec("COMMIT");
      const violations = raw.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error("Fixture prerequisite records violate foreign keys.");
      }
    } catch (error) {
      if (raw.isTransaction) raw.exec("ROLLBACK");
      throw error;
    } finally {
      raw.close();
    }

    const diff = database.artifactRegistry.registerVersion({
      projectId: project.id,
      type: "canonical-diff",
      schemaVersion: "1",
      logicalName: `${input.fixtureId}:canonical-diff`,
      content: diffBytes,
      status: "produced",
      producer: {
        runId: awaitingReview.run.id,
        nodeRunId: developmentNode.id,
        nodeAttemptId: developmentAttempt.id,
        snapshotRevisionId: awaitingReview.snapshot.id,
        aiMemberId: developer.aiMember.id,
        positionId: developer.id,
        sessionId: producerSession.id,
        workPackageId,
      },
    });
    void diff;
    const buildBytes = Buffer.from(`fixture-build:${sourceCommit}\n`);
    const build = database.artifactRegistry.registerVersion({
      projectId: project.id,
      type: "build",
      schemaVersion: "1",
      logicalName: `${input.fixtureId}:build`,
      content: buildBytes,
      status: "produced",
      producer: {
        runId: awaitingReview.run.id,
        nodeRunId: developmentNode.id,
        nodeAttemptId: developmentAttempt.id,
        snapshotRevisionId: awaitingReview.snapshot.id,
        aiMemberId: developer.aiMember.id,
        positionId: developer.id,
        sessionId: producerSession.id,
        workPackageId,
      },
    });

    const reviewed = await database.pipelineRuntime.executeReady({
      runId: awaitingReview.run.id,
      expectedRevision: awaitingReview.run.revision,
    });
    const reviewResult = database.codeReviews.inspect(reviewed.run.id)[0];
    if (!reviewResult?.integrationEligible) {
      throw new Error(
        "Code Review handler did not produce exact T15 authority.",
      );
    }
    const integrated = await database.pipelineRuntime.executeReady({
      runId: reviewed.run.id,
      expectedRevision: reviewed.run.revision,
    });
    const generation = database.integrations
      .inspect(integrated.run.id)
      .find((candidate) => candidate.state === "passed");
    if (!generation) {
      throw new Error(
        `Integration handler did not produce PASS authority: ${JSON.stringify({
          reviewed: reviewed.nodes.map((node) => ({
            id: node.pipelineNodeId,
            status: node.status,
          })),
          integrated: integrated.nodes,
          generations: database.integrations.inspect(integrated.run.id),
        })}`,
      );
    }
    const integrationAuthority = database.integrations.readPassAuthority(
      generation.id,
    );
    const testing = await database.pipelineRuntime.executeReady({
      runId: integrated.run.id,
      expectedRevision: integrated.run.revision,
    });
    const testNode = testing.nodes.find(
      (node) => node.pipelineNodeId === "test",
    );
    const testAttempt = testNode?.attempts.at(-1);
    if (testNode?.status !== "running" || !testAttempt) {
      throw new Error("Fixture Pipeline did not claim the Test Node Attempt.");
    }
    const testSession = database.interaction.createSession({
      projectId: project.id,
      mode: "run-collaboration",
      runId: testing.run.id,
      nodeRunId: testNode.id,
    });
    database.interaction.addParticipant({
      sessionId: testSession.id,
      participantType: "ai-member",
      participantRef: tester.aiMember.id,
      role: "test-engineer",
    });
    const frozenProfile = testing.snapshot.payload.executionProfiles.find(
      (candidate) => candidate.id === profile.id,
    );
    if (!frozenProfile)
      throw new Error("Fixture Execution Profile was not frozen.");

    return {
      projectId: project.id,
      runId: testing.run.id,
      snapshotRevisionId: testing.snapshot.id,
      testNodeRunId: testNode.id,
      testNodeAttemptId: testAttempt.id,
      testSessionId: testSession.id,
      testOwnerPositionId: tester.id,
      testOwnerAiMemberId: tester.aiMember.id,
      workPackageCoverage: [
        {
          workPackageId,
          workPackageVersionId,
          manifestHash: sha256(canonicalJson(manifest)),
        },
      ],
      testExecutionProfile: {
        id: profile.id,
        hash: sha256(canonicalJson(frozenProfile)),
      },
      build: {
        artifactVersionId: build.id,
        digest: sha256(buildBytes),
      },
      integrationAuthority,
    };
  } finally {
    database.close();
  }
};
