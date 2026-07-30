import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import { openRuntimeEvents } from "../events/subscription.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import { CommandEnvelopeSchema } from "../interface.js";
import { openTestRuntime, TestRuntimeError } from "./testRuntime.js";

const hash = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};
const canonicalHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
const testRunQueryHash = (testRunId: string): string =>
  createHash("sha256")
    .update(JSON.stringify({ type: "test-runs.inspect", testRunId }))
    .digest("hex");
const testRiskInput = (
  testCaseRevisionIds: readonly string[] = ["case-1-r1"],
  operationIds: readonly string[] = ["operation-1", "cleanup-operation-1"],
  workPackageRiskTier: "low" | "medium" | "high" | "critical" = "high",
) => {
  const rules = [
    { factorId: "auth-permission", minimumTier: "high" as const },
    {
      factorId: "credential-materialization",
      minimumTier: "critical" as const,
    },
    { factorId: "cross-application-contract", minimumTier: "high" as const },
    { factorId: "data-migration-pii", minimumTier: "high" as const },
    { factorId: "dependency-supply-chain", minimumTier: "medium" as const },
    { factorId: "destructive-action", minimumTier: "critical" as const },
    { factorId: "network-filesystem-scope", minimumTier: "high" as const },
    { factorId: "no-sandbox", minimumTier: "high" as const },
    { factorId: "production-deployment", minimumTier: "critical" as const },
    { factorId: "public-api", minimumTier: "high" as const },
    {
      factorId: "rollback-resource-timeout-recovery",
      minimumTier: "medium" as const,
    },
    { factorId: "sandbox-boundary", minimumTier: "critical" as const },
    {
      factorId: "secret-environment-boundary",
      minimumTier: "high" as const,
    },
    { factorId: "user-visible-runtime", minimumTier: "high" as const },
    {
      factorId: "work-package-risk-tier",
      minimumTier: workPackageRiskTier,
    },
  ];
  const revisionId = `technical-baseline:technical-baseline-1:${hash("5")}`;
  const policyHash = canonicalHash({
    schemaVersion: 1,
    revisionId,
    rules,
  });
  const factors = [
    {
      id: "auth-permission",
      present: true,
      evidenceRefs: [
        "technical-baseline:technical-baseline-1:permission-policy",
        "work-package-version:package-1-v1:permission:repository.write",
      ],
    },
    {
      id: "credential-materialization",
      present: false,
      evidenceRefs: [],
    },
    {
      id: "cross-application-contract",
      present: true,
      evidenceRefs: [`contract:contract-1:1:${hash("9")}`],
    },
    { id: "data-migration-pii", present: false, evidenceRefs: [] },
    { id: "dependency-supply-chain", present: false, evidenceRefs: [] },
    { id: "destructive-action", present: false, evidenceRefs: [] },
    {
      id: "network-filesystem-scope",
      present: true,
      evidenceRefs: [
        "work-package-version:package-1-v1:permission:repository.write",
      ],
    },
    {
      id: "no-sandbox",
      present: true,
      evidenceRefs: ["execution-profile:profile-1"],
    },
    { id: "production-deployment", present: false, evidenceRefs: [] },
    { id: "public-api", present: false, evidenceRefs: [] },
    {
      id: "rollback-resource-timeout-recovery",
      present: true,
      evidenceRefs: [
        "execution-profile:profile-1:timeout:30",
        ...operationIds.map((id) => `test-operation:${id}`),
        "work-package-version:package-1-v1:recovery-policy",
      ].sort(),
    },
    { id: "sandbox-boundary", present: false, evidenceRefs: [] },
    {
      id: "secret-environment-boundary",
      present: false,
      evidenceRefs: [],
    },
    {
      id: "user-visible-runtime",
      present: true,
      evidenceRefs: testCaseRevisionIds
        .map((id) => `test-case-revision:${id}`)
        .sort(),
    },
    {
      id: "work-package-risk-tier",
      present: true,
      evidenceRefs: [
        `work-package-version:package-1-v1:risk-tier:${workPackageRiskTier}`,
      ],
    },
  ];
  const evidenceRefs = [
    ...new Set(factors.flatMap((factor) => factor.evidenceRefs)),
  ].sort();
  return {
    schemaVersion: 1 as const,
    policy: {
      revisionId,
      rules,
      hash: policyHash,
    },
    factors,
    computedTier: workPackageRiskTier,
    evidenceRefs,
    inputHash: canonicalHash({
      schemaVersion: 1,
      policyRevisionId: revisionId,
      policyHash,
      factors,
      evidenceRefs,
    }),
  };
};

const passedGeneration = (): IntegrationGenerationView =>
  ({
    id: "generation-1",
    manifest: {
      schemaVersion: 1,
      generationId: "generation-1",
      generation: 1,
      projectId: "project-1",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "integration-node-1",
      coverageId: "coverage-1",
      coverageNodeRunId: "review-node-1",
      coverageNodeAttemptId: "review-attempt-1",
      coverageHash: hash("a"),
      repositories: [
        {
          repositoryReference: "repo-a",
          baseCommit: commit("1"),
          integrationBranch: "integration/run-1/g1",
        },
      ],
      packages: [
        {
          workPackageId: "package-1",
          workPackageVersionId: "package-1-v1",
          applicationId: "application-1",
          repositoryReference: "repo-a",
          baseCommit: commit("1"),
          sourceBranch: "work/package-1",
          sourceCommit: commit("2"),
          diffHash: hash("7"),
          authorityId: "code-authority-1",
          qualityGateResultId: "code-gate-1",
          reviewContext: {
            codeReviewManifestId: "code-review-1",
            codeReviewManifestHash: hash("8"),
            diffArtifactVersionId: "diff-version-1",
            specRevisionIds: ["spec-1"],
            harnessSnapshotIds: ["harness-1"],
            acceptanceCriteria: ["requirement-19"],
            selfCheckEvidenceRefs: ["self-check-1"],
          },
          dependencies: [],
          contractVersions: [],
          integrationConditions: [],
        },
      ],
      dependencyOrder: [],
      contractVersions: [
        {
          id: "contract-1",
          version: "1",
          hash: hash("9"),
          producerApplicationId: "app-api",
          consumerApplicationId: "app-web",
          testCommands: ["contract-test"],
          evidenceRefs: ["contract-evidence-1"],
        },
      ],
      integrationConditions: [],
      requiredValidations: [],
    },
    manifestHash: hash("b"),
    state: "passed",
    repositoryResults: [
      {
        id: "repository-result-1",
        repositoryReference: "repo-a",
        baseCommit: commit("1"),
        integrationBranch: "integration/run-1/g1",
        state: "succeeded",
        expectedTip: commit("1"),
        integratedCommit: commit("2"),
        validationRecords: [],
      },
    ],
    operations: [],
    defects: [],
    aggregateReview: {
      id: "aggregate-review-1",
      topicId: "topic-1",
      qualityGateResultId: "gate-1",
      input: {},
      inputHash: hash("c"),
      result: "PASS",
      evidence: ["artifact-version:evidence-1"],
    },
    passAuthorityHash: hash("d"),
  }) as IntegrationGenerationView;

const openFixture = (
  withEvents = false,
  withArtifactAuthority = false,
  workerFailureInjection?: (
    point: "after-state" | "after-event",
    commandId: string,
  ) => void,
  nextId?: () => string,
  workPackageRiskTier: "low" | "medium" | "high" | "critical" = "high",
) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const frozenProfile = {
    id: "profile-1",
    revision: 0,
    name: "Test profile",
    providerRef: "scripted-execution",
    model: "fixture-v1",
    sandboxRef: "no-sandbox",
    branchStrategy: "head",
    limits: { timeoutSeconds: 30, maxIterations: 1, maxTokens: null },
    retryPolicy: { maxAttempts: 0 },
    permissionPolicy: "deny",
    secretReferenceIds: [],
  };
  const snapshotPayload = {
    schemaVersion: 1,
    executionProfiles: [frozenProfile],
    technicalGatePromotion: {
      acceptedTechnicalBaselineId: "technical-baseline-1",
      acceptedTechnicalBaselineHash: hash("5"),
    },
  };
  const technicalBaselineManifest = {
    schemaVersion: 1,
    promotedProjectSpecRevisionId: "project-spec-1",
    promotedProjectSpecHash: hash("4"),
    readinessEvidence: [],
    applicationSpecRevisions: [],
    proposalRevisionId: "proposal-1",
    proposalRevisionHash: hash("3"),
    crossApplicationContracts: [
      { id: "contract-1", version: "1", hash: hash("9") },
    ],
    architecture: "Single test application.",
    dependencyGraph: [],
    riskPolicy: ["Apply the fixed Runtime rubric."],
    permissionPolicy: ["Deny unspecified permissions."],
    testStrategy: ["Run paired UI and Runtime assertions."],
  };
  const workPackageManifest = {
    objective: "Exercise versioned Test authority.",
    acceptanceCriteria: ["requirement-19"],
    moduleScope: ["fixture-change.txt"],
    allowedPermissions: ["repository.write"],
    specRefs: ["project-spec-1"],
    harnessRefs: ["fixture:tdd@1"],
    assignmentCriteria: { positionIds: ["position-developer"] },
    expectedArtifacts: ["canonical-diff"],
    selfCheckCommands: ["fixture-test"],
    codeReviewConditions: ["Independent PASS required"],
    integrationConditions: ["fixture-test"],
    riskTier: workPackageRiskTier,
    recoveryPolicy: "Create a fresh Version and Attempt.",
    execution: {
      profileId: "software-rnd-local-isolated-git",
      branchStrategy: "branch",
      gitRefWriteIsolation: true,
      runtimeImportOnly: true,
    },
  };
  database.exec(`
    INSERT INTO projects(id, company_id, name, goal, status, created_at)
    VALUES ('project-1', 'company', 'Project', 'Test', 'active', '2026-07-29T00:00:00.000Z');
    INSERT INTO department_runs(id, project_id, department_id, status, created_at, snapshot_revision_id, updated_at)
    VALUES ('run-1', 'project-1', 'software-rnd', 'running', '2026-07-29T00:00:00.000Z', 'snapshot-1', '2026-07-29T00:00:00.000Z');
    INSERT INTO node_runs(id, run_id, pipeline_node_id, node_type, status, handler_kind_id, created_at, updated_at)
    VALUES ('test-node-1', 'run-1', 'test', 'ai-task', 'running', 'test@1', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO node_attempts(id, node_run_id, attempt_number, snapshot_revision_id, reason, status, created_at, started_at)
    VALUES ('test-attempt-1', 'test-node-1', 1, 'snapshot-1', 'initial', 'running', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO ai_members(id, department_id, display_name, status, created_at)
    VALUES ('tester-ai', 'software-rnd', 'Tester', 'active', '2026-07-29T00:00:00.000Z');
    INSERT INTO positions(id, department_id, name, responsibility, ai_member_id, sort_order, created_at)
    VALUES ('position-test-engineer', 'software-rnd', 'Test engineer', 'Independent testing', 'tester-ai', 1, '2026-07-29T00:00:00.000Z');
    INSERT INTO interaction_sessions(id, mode, project_id, run_id, node_run_id, status, created_at)
    VALUES ('test-session-1', 'run-collaboration', 'project-1', 'run-1', 'test-node-1', 'active', '2026-07-29T00:00:00.000Z');
    INSERT INTO session_participants(id, session_id, participant_type, participant_ref, role, created_at)
    VALUES ('tester-participant', 'test-session-1', 'ai-member', 'tester-ai', 'test-engineer', '2026-07-29T00:00:00.000Z');
    INSERT INTO artifacts(id, project_id, type, logical_name, status, created_at)
    VALUES ('build-artifact', 'project-1', 'build', 'Test build', 'accepted', '2026-07-29T00:00:00.000Z');
    INSERT INTO artifact_versions(id, artifact_id, version, content_ref, content_hash, byte_size, status, producing_run_id, snapshot_revision_id, created_at)
    VALUES ('build-1', 'build-artifact', 1, 'artifacts/build.tar', '${hash("f")}', 42, 'accepted', 'run-1', 'snapshot-1', '2026-07-29T00:00:00.000Z');
    UPDATE artifact_versions SET producer_context_json = '${JSON.stringify({
      projectId: "project-1",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "integration-node-1",
      nodeAttemptId: "integration-attempt-1",
      aiMemberId: "builder-ai",
      integrationAuthority: {
        generationId: "generation-1",
        manifestHash: hash("b"),
        passAuthorityHash: hash("d"),
        repositoryCommits: [
          { repositoryReference: "repo-a", commit: commit("2") },
        ],
      },
    }).replaceAll("'", "''")}';
    INSERT INTO technical_baselines(id, project_id, run_id, proposal_revision_id, manifest_json, manifest_hash, created_at)
    VALUES ('technical-baseline-1', 'project-1', 'run-1', 'proposal-1', '${JSON.stringify(technicalBaselineManifest).replaceAll("'", "''")}', '${hash("5")}', '2026-07-29T00:00:00.000Z');
    INSERT INTO work_packages(id, project_id, run_id, technical_baseline_id, state, created_at, updated_at)
    VALUES ('package-1', 'project-1', 'run-1', 'technical-baseline-1', 'ready', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO work_package_versions(id, work_package_id, version, application_id, repository_reference, node_run_id, manifest_json, manifest_hash, status, created_at)
    VALUES ('package-1-v1', 'package-1', 1, 'application-1', 'repo-a', 'development-node-1', '${JSON.stringify(workPackageManifest).replaceAll("'", "''")}', '${hash("6")}', 'ready', '2026-07-29T00:00:00.000Z');
  `);
  database
    .prepare(
      `INSERT INTO run_snapshot_revisions(
         id, run_id, revision, schema_version, canonical_json, hash, created_at
       ) VALUES (?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      "snapshot-1",
      "run-1",
      JSON.stringify(snapshotPayload),
      canonicalHash(snapshotPayload),
      "2026-07-29T00:00:00.000Z",
    );
  const generation = passedGeneration();
  const generations = new Map([[generation.id, generation]]);
  const runtimeEvents = openRuntimeEvents(database);
  const events = withEvents ? runtimeEvents : undefined;
  const artifactBytes = new Map<string, Buffer>();
  const artifactLocators = new Map<string, string>();
  const fixtureAuthorities = new Map([
    [
      "fixture-1",
      {
        fixtureId: "fixture-1",
        companyDirectoryFingerprint: hash("2"),
        scriptHashes: [hash("e")],
        adapterIds: ["scripted-test"],
      },
    ],
  ]);
  const runtime = openTestRuntime(database, {
    integrationAuthority: {
      readPassAuthority: (generationId) =>
        generations.get(generationId) ?? generation,
    },
    fixtureAuthority: {
      read: (fixtureId) => {
        const authority = fixtureAuthorities.get(fixtureId);
        if (!authority) throw new Error(`Fixture ${fixtureId} was not found.`);
        return authority;
      },
    },
    events: runtimeEvents,
    ...(withArtifactAuthority
      ? {
          artifacts: {
            readContent: (versionId: string) => {
              const bytes = artifactBytes.get(versionId);
              if (!bytes)
                throw new Error(`Artifact ${versionId} bytes not found.`);
              return bytes;
            },
            verify: (versionId: string) =>
              artifactBytes.has(versionId) ? "verified" : "unavailable",
            inspect: (versionId: string) =>
              (() => {
                const producerRow = database
                  .prepare(
                    `SELECT producer_context_json AS producerContextJson,
                            producing_run_id AS runId,
                            snapshot_revision_id AS snapshotRevisionId
                       FROM artifact_versions WHERE id = ?`,
                  )
                  .get(versionId) as
                  | {
                      readonly producerContextJson: string | null;
                      readonly runId: string | null;
                      readonly snapshotRevisionId: string | null;
                    }
                  | undefined;
                const producer = producerRow?.producerContextJson
                  ? (JSON.parse(producerRow.producerContextJson) as Record<
                      string,
                      unknown
                    >)
                  : {
                      runId: producerRow?.runId ?? "",
                      snapshotRevisionId: producerRow?.snapshotRevisionId ?? "",
                    };
                return {
                  version: {
                    contentRef: artifactLocators.get(versionId) ?? "",
                    producer,
                  },
                  inputs: [],
                } as unknown as ReturnType<ArtifactRegistry["inspect"]>;
              })(),
          },
        }
      : {}),
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
    ...(nextId ? { nextId } : {}),
    ...(workerFailureInjection ? { workerFailureInjection } : {}),
  });
  const revisionInput = {
    testCaseId: "case-1",
    revisionId: "case-1-r1",
    projectId: "project-1",
    manifest: {
      schemaVersion: 1 as const,
      ownerPositionId: "position-test-engineer",
      requirementIds: ["requirement-19"],
      workPackageVersions: [
        {
          workPackageId: "package-1",
          workPackageVersionId: "package-1-v1",
          manifestHash: hash("6"),
        },
      ],
      preconditions: ["integration authority is PASS"],
      uiActions: [{ id: "action-1", kind: "click", target: "run-test" }],
      assertions: [
        {
          id: "assertion-1",
          operationId: "operation-1",
          ui: { kind: "text", expected: "passed" },
          runtime: { kind: "test-run-state", expected: "passed" },
        },
      ],
      fixture: { id: "fixture-1", scriptHashes: [hash("e")] },
      executionOperations: [
        {
          id: "operation-1",
          kind: "electron" as const,
          adapterId: "scripted-test",
          input: { kind: "electron" },
          inputHash: canonicalHash({ kind: "electron" }),
        },
        {
          id: "cleanup-operation-1",
          kind: "cleanup" as const,
          adapterId: "scripted-test",
          input: { kind: "cleanup" },
          inputHash: canonicalHash({ kind: "cleanup" }),
        },
      ],
      evidencePolicy: {
        retentionClass: "durable" as const,
        redactionProfile: "default",
        requiredKinds: ["ui", "runtime"],
      },
      cleanup: {
        policy: "always",
        required: true,
        operationId: "cleanup-operation-1",
        rootFingerprint: hash("a"),
        targets: [
          { kind: "repository" as const, pathFingerprint: hash("b") },
          { kind: "worktree" as const, pathFingerprint: hash("c") },
        ],
      },
    },
  };
  const revision = runtime.registerCaseRevision(revisionInput);
  const runInput = {
    testRunId: "test:run-1:test-node-1",
    requestId: "request-1",
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    nodeRunId: "test-node-1",
    nodeAttemptId: "test-attempt-1",
    sessionId: "test-session-1",
    testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
    integrationAuthority: {
      generationId: generation.id,
      manifestHash: generation.manifestHash,
      passAuthorityHash: generation.passAuthorityHash!,
      repositoryCommits: [
        { repositoryReference: "repo-a", commit: commit("2") },
      ],
    },
    build: { artifactVersionId: "build-1", digest: hash("f") },
    executionProfile: { id: "profile-1", hash: canonicalHash(frozenProfile) },
    companyDirectoryFingerprint: hash("2"),
    fixture: { id: "fixture-1", scriptHashes: [hash("e")] },
    executionOperations: [
      {
        id: "operation-1",
        kind: "electron" as const,
        adapterId: "scripted-test",
        input: { kind: "electron" },
        inputHash: canonicalHash({ kind: "electron" }),
      },
      {
        id: "cleanup-operation-1",
        kind: "cleanup" as const,
        adapterId: "scripted-test",
        input: { kind: "cleanup" },
        inputHash: canonicalHash({ kind: "cleanup" }),
      },
    ],
    clock: { instant: "2026-07-29T00:00:00.000Z", seed: "seed-1" },
    environment: { platform: "darwin", architecture: "arm64" },
    capabilities: ["electron", "runtime-query"],
    risk: testRiskInput(undefined, undefined, workPackageRiskTier),
  };
  return {
    database,
    events,
    generation,
    generations,
    runtime,
    revision,
    revisionInput,
    runInput,
    artifactBytes,
    artifactLocators,
    fixtureAuthorities,
  };
};

const succeedRequiredExecution = async (
  fixture: ReturnType<typeof openFixture>,
  runInput = fixture.runInput,
): Promise<void> => {
  await fixture.runtime.execute({
    testRunId: runInput.testRunId,
    operationId: "operation-1",
    input: { kind: "electron" },
    adapter: {
      id: "scripted-test",
      execute: () => ({
        state: "succeeded" as const,
        providerReceipt: { id: "receipt-1" },
        evidenceRef: "execution-fact:1",
      }),
      reconcile: () => ({
        state: "succeeded" as const,
        providerReceipt: { id: "receipt-1" },
        evidenceRef: "execution-fact:1",
      }),
    },
  });
  await fixture.runtime.execute({
    testRunId: runInput.testRunId,
    operationId: "cleanup-operation-1",
    input: { kind: "cleanup" },
    adapter: {
      id: "scripted-test",
      execute: (request) => cleanupExecutionFact(fixture, runInput, request),
      reconcile: (request) => cleanupExecutionFact(fixture, runInput, request),
    },
  });
};

const seedEvidenceArtifact = (
  fixture: ReturnType<typeof openFixture>,
  input: {
    readonly id: string;
    readonly contentHash: string;
    readonly byteSize: number;
    readonly locator: string;
    readonly storedLocator?: string;
    readonly producerContextOnly?: boolean;
  },
): void => {
  fixture.database
    .prepare(
      `INSERT INTO artifacts(id, project_id, type, logical_name, status, created_at)
       VALUES (?, ?, 'test-evidence', ?, 'accepted', ?)`,
    )
    .run(
      `artifact:${input.id}`,
      fixture.runInput.projectId,
      input.id,
      "2026-07-29T00:00:00.000Z",
    );
  fixture.database
    .prepare(
      `INSERT INTO artifact_versions(
         id, artifact_id, version, content_ref, content_hash, byte_size,
         status, producing_run_id, snapshot_revision_id, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, 'accepted', ?, ?, ?)`,
    )
    .run(
      input.id,
      `artifact:${input.id}`,
      input.storedLocator ?? input.locator,
      input.contentHash,
      input.byteSize,
      fixture.runInput.runId,
      fixture.runInput.snapshotRevisionId,
      "2026-07-29T00:00:00.000Z",
    );
  fixture.artifactLocators.set(input.id, input.locator);
  if (input.producerContextOnly) {
    fixture.database
      .prepare(
        `UPDATE artifact_versions
            SET producing_run_id = NULL, snapshot_revision_id = NULL,
                producer_context_json = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          projectId: fixture.runInput.projectId,
          runId: fixture.runInput.runId,
          nodeRunId: fixture.runInput.nodeRunId,
          nodeAttemptId: fixture.runInput.nodeAttemptId,
          snapshotRevisionId: fixture.runInput.snapshotRevisionId,
          aiMemberId: "tester-ai",
          positionId: "position-test-engineer",
          sessionId: fixture.runInput.sessionId,
        }),
        input.id,
      );
  }
};

const seedCleanupEvidenceArtifact = (
  fixture: ReturnType<typeof openFixture>,
  id: string,
) => {
  const bytes = Buffer.from('{"remainingResources":[]}');
  const descriptor = {
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    artifactVersionId: id,
    locator: `evidence/${id}.json`,
  };
  seedEvidenceArtifact(fixture, { id, ...descriptor });
  fixture.artifactBytes.set(id, bytes);
  return descriptor;
};

const cleanupExecutionFact = (
  fixture: ReturnType<typeof openFixture>,
  runInput: ReturnType<typeof openFixture>["runInput"],
  request: { readonly operationKey: string },
) => {
  const artifact = seedCleanupEvidenceArtifact(
    fixture,
    `cleanup-artifact:${runInput.testRunId}`,
  );
  return {
    state: "succeeded" as const,
    providerReceipt: {
      schemaVersion: 1 as const,
      kind: "cleanup" as const,
      receiptId: `cleanup-receipt:${runInput.testRunId}`,
      fixtureId: runInput.fixture.id,
      operationKey: request.operationKey,
      rootFingerprint: hash("a"),
      targets: [
        {
          kind: "repository" as const,
          pathFingerprint: hash("b"),
          state: "absent" as const,
        },
        {
          kind: "worktree" as const,
          pathFingerprint: hash("c"),
          state: "absent" as const,
        },
      ],
      artifactVersionId: artifact.artifactVersionId,
      contentHash: artifact.contentHash,
    },
    evidenceRef: `cleanup-fact:${runInput.testRunId}`,
    result: {
      schemaVersion: 1 as const,
      assertions: [],
      evidence: [
        {
          id: `cleanup-evidence:${runInput.testRunId}`,
          testCaseRevisionId: runInput.testCaseRevisions[0]!.id,
          assertionId: null,
          kind: "cleanup" as const,
          mediaType: "application/json",
          ...artifact,
          redactionProfile: "default",
          retentionClass: "durable" as const,
          metadata: { source: "runtime-cleanup-port" },
        },
      ],
    },
  };
};

const seedFreshTestAttempt = (
  fixture: ReturnType<typeof openFixture>,
  suffix: string,
): void => {
  fixture.database.exec(`
    INSERT INTO node_runs(id, run_id, pipeline_node_id, node_type, status, handler_kind_id, created_at, updated_at)
    VALUES ('test-node-${suffix}', 'run-1', 'test-rerun-${suffix}', 'ai-task', 'running', 'test@1', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO node_attempts(id, node_run_id, attempt_number, snapshot_revision_id, reason, status, created_at, started_at)
    VALUES ('test-attempt-${suffix}', 'test-node-${suffix}', 1, 'snapshot-1', 'request-changes', 'running', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO interaction_sessions(id, mode, project_id, run_id, node_run_id, status, created_at)
    VALUES ('test-session-${suffix}', 'run-collaboration', 'project-1', 'run-1', 'test-node-${suffix}', 'active', '2026-07-29T00:00:00.000Z');
    INSERT INTO session_participants(id, session_id, participant_type, participant_ref, role, created_at)
    VALUES ('tester-participant-${suffix}', 'test-session-${suffix}', 'ai-member', 'tester-ai', 'test-engineer', '2026-07-29T00:00:00.000Z');
  `);
};

const trustedCorrelation = (
  fixture: ReturnType<typeof openFixture>,
  artifactVersionIds: readonly string[],
  runInput = fixture.runInput,
  suffix = "",
) => {
  const view = fixture.runtime.inspect(runInput.testRunId);
  const eventSequence = Number(
    (
      fixture.database
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM runtime_event_outbox WHERE run_id = ? AND node_run_id = ?",
        )
        .get(runInput.runId, runInput.nodeRunId) as {
        readonly sequence: number;
      }
    ).sequence,
  );
  const eventType = String(
    (
      fixture.database
        .prepare("SELECT type FROM runtime_event_outbox WHERE sequence = ?")
        .get(eventSequence) as { readonly type: string }
    ).type,
  );
  const commandId = `trusted-ui-command${suffix}`;
  fixture.database
    .prepare(
      `INSERT INTO command_deduplication(
         command_id, actor_type, actor_id, authenticated_by, consumer_id,
         schema_version, request_hash, status, result_json, result_hash,
         effect_ids_json, completed_at
       ) VALUES (?, 'human', 'test-driver', 'electron-fixture', NULL, 1, ?,
                 'completed', ?, ?, '[]', ?)`,
    )
    .run(
      commandId,
      hash("3"),
      JSON.stringify({ status: "succeeded", value: {} }),
      hash("4"),
      "2026-07-29T00:00:00.000Z",
    );
  fixture.database
    .prepare(
      `INSERT INTO runtime_audit_records(
         id, action, entity_type, entity_id, run_id, node_run_id,
         created_at, command_id, actor_type, actor_id, authenticated_by
       ) VALUES (?, 'fixture.ui-action', 'test-run', ?, ?, ?, ?, ?, 'human',
                 'test-driver', 'electron-fixture')`,
    )
    .run(
      `trusted-ui-audit${suffix}`,
      runInput.testRunId,
      runInput.runId,
      runInput.nodeRunId,
      "2026-07-29T00:00:00.000Z",
      commandId,
    );
  const viewSyncTokenHash = canonicalHash({ token: "view-sync", suffix });
  const tokenPrincipal = {
    type: "human",
    id: "test-driver",
    authenticatedBy: "electron-fixture",
  } as const;
  const acknowledgementCommandId = `fixture-view-ack${suffix}`;
  const acknowledgementAuditId = `fixture-view-ack-audit${suffix}`;
  const acknowledgementResult = {
    status: "succeeded",
    value: {
      acknowledged: true,
      subscriptionGeneration: 1,
      barrierSequence: eventSequence,
      auditId: acknowledgementAuditId,
    },
    effectIds: [acknowledgementAuditId],
  };
  const acknowledgementResultJson = JSON.stringify(
    canonicalize(acknowledgementResult),
  );
  fixture.database
    .prepare(
      `INSERT INTO runtime_audit_records(
         id, action, entity_type, entity_id, run_id, node_run_id,
         before_json, after_json, created_at, command_id, actor_type,
         actor_id, authenticated_by, consumer_id
       ) VALUES (?, 'runtime.events.acknowledged', 'runtime-event-cursor',
                 'fixture-consumer', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?,
                 'fixture-consumer')`,
    )
    .run(
      acknowledgementAuditId,
      JSON.stringify({ sequence: eventSequence, subscriptionGeneration: 1 }),
      "2026-07-29T00:00:00.000Z",
      acknowledgementCommandId,
      tokenPrincipal.type,
      tokenPrincipal.id,
      tokenPrincipal.authenticatedBy,
    );
  fixture.database
    .prepare(
      `INSERT INTO command_deduplication(
         command_id, actor_type, actor_id, authenticated_by, consumer_id,
         schema_version, request_hash, status, result_json, result_hash,
         effect_ids_json, completed_at
       ) VALUES (?, ?, ?, ?, 'fixture-consumer', 1, ?, 'completed', ?, ?, ?, ?)`,
    )
    .run(
      acknowledgementCommandId,
      tokenPrincipal.type,
      tokenPrincipal.id,
      tokenPrincipal.authenticatedBy,
      canonicalHash({ acknowledgementCommandId }),
      acknowledgementResultJson,
      createHash("sha256").update(acknowledgementResultJson).digest("hex"),
      JSON.stringify([acknowledgementAuditId]),
      "2026-07-29T00:00:00.000Z",
    );
  const queryViewHash = canonicalHash(view);
  fixture.database
    .prepare(
      `INSERT INTO consumed_view_sync_tokens(
         token_hash, nonce_hash, consumer_id, principal_hash, query_hash,
         view_hash, sequence, expires_at, consumed_at, command_id
       ) VALUES (?, ?, 'fixture-consumer', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      viewSyncTokenHash,
      canonicalHash({ nonce: "view-sync", suffix }),
      canonicalHash(tokenPrincipal),
      testRunQueryHash(runInput.testRunId),
      queryViewHash,
      eventSequence,
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      acknowledgementCommandId,
    );
  return {
    commandId,
    eventSequence,
    runtimeEventType: eventType,
    queryAsOfSequence: eventSequence,
    queryViewHash,
    viewSyncTokenHash,
    snapshotRevisionId: runInput.snapshotRevisionId,
    runId: runInput.runId,
    nodeRunId: runInput.nodeRunId,
    nodeAttemptId: runInput.nodeAttemptId,
    sessionId: runInput.sessionId,
    artifactVersionIds,
  };
};

const selectedQueryView = (
  fixture: ReturnType<typeof openFixture>,
  correlation: ReturnType<typeof trustedCorrelation>,
) =>
  fixture.database
    .prepare(
      `SELECT token_hash AS tokenHash, query_hash AS queryHash,
              view_hash AS viewHash, sequence,
              consumer_id AS consumerId, principal_hash AS principalHash,
              command_id AS acknowledgementCommandId
         FROM consumed_view_sync_tokens WHERE token_hash = ?`,
    )
    .get(correlation.viewSyncTokenHash) as {
    readonly tokenHash: string;
    readonly queryHash: string;
    readonly viewHash: string;
    readonly sequence: number;
    readonly consumerId: string;
    readonly principalHash: string;
    readonly acknowledgementCommandId: string;
  };

const completeFreshPassingRun = async (
  fixture: ReturnType<typeof openFixture>,
  suffix: string,
  defectId: string,
) => {
  seedFreshTestAttempt(fixture, suffix);
  const scopedDefects = fixture.runtime
    .inspect(fixture.runInput.testRunId)
    .defects.filter((candidate) => candidate.status === "open");
  const runInput = {
    ...fixture.runInput,
    testRunId: `test:run-1:test-node-${suffix}`,
    requestId: `request-pass-${suffix}`,
    nodeRunId: `test-node-${suffix}`,
    nodeAttemptId: `test-attempt-${suffix}`,
    sessionId: `test-session-${suffix}`,
  };
  fixture.runtime.createReworkRun({
    defectId,
    input: runInput,
    successorAssertions: scopedDefects.map((candidate) => ({
      defectId: candidate.id,
      nextTestCaseRevisionId: fixture.revision.id,
      nextAssertionId: candidate.assertionId!,
    })),
  });
  await succeedRequiredExecution(fixture, runInput);
  const uiArtifactId = `pass-ui-${suffix}`;
  const runtimeArtifactId = `pass-runtime-${suffix}`;
  seedEvidenceArtifact(fixture, {
    id: uiArtifactId,
    contentHash: hash("4"),
    byteSize: 42,
    locator: `evidence/${uiArtifactId}.png`,
  });
  seedEvidenceArtifact(fixture, {
    id: runtimeArtifactId,
    contentHash: hash("5"),
    byteSize: 42,
    locator: `evidence/${runtimeArtifactId}.json`,
  });
  const correlation = trustedCorrelation(
    fixture,
    [uiArtifactId, runtimeArtifactId],
    runInput,
    `-${suffix}`,
  );
  fixture.runtime.recordAssertion({
    operationId: "operation-1",
    testRunId: runInput.testRunId,
    testCaseRevisionId: fixture.revision.id,
    assertionId: "assertion-1",
    uiObserved: "passed",
    runtimeObserved: "passed",
    uiStatus: "passed",
    runtimeStatus: "passed",
    correlation,
  });
  fixture.runtime.recordEvidence({
    id: `pass-ui-evidence-${suffix}`,
    operationId: "operation-1",
    testRunId: runInput.testRunId,
    testCaseRevisionId: fixture.revision.id,
    assertionId: "assertion-1",
    kind: "screenshot",
    mediaType: "image/png",
    contentHash: hash("4"),
    byteSize: 42,
    artifactVersionId: uiArtifactId,
    redactionProfile: "default",
    retentionClass: "durable",
    locator: `evidence/${uiArtifactId}.png`,
    metadata: {},
  });
  fixture.runtime.recordEvidence({
    id: `pass-runtime-evidence-${suffix}`,
    operationId: "operation-1",
    testRunId: runInput.testRunId,
    testCaseRevisionId: fixture.revision.id,
    assertionId: "assertion-1",
    kind: "runtime",
    mediaType: "application/json",
    contentHash: hash("5"),
    byteSize: 42,
    artifactVersionId: runtimeArtifactId,
    redactionProfile: "default",
    retentionClass: "durable",
    locator: `evidence/${runtimeArtifactId}.json`,
    metadata: {},
  });
  return fixture.runtime.complete(runInput.testRunId);
};

const prepareFailedAssertion = async (
  fixture: ReturnType<typeof openFixture>,
  suffix: string,
) => {
  fixture.runtime.createRun(fixture.runInput);
  await succeedRequiredExecution(fixture);
  const uiArtifactId = `failure-ui-${suffix}`;
  const runtimeArtifactId = `failure-runtime-${suffix}`;
  seedEvidenceArtifact(fixture, {
    id: uiArtifactId,
    contentHash: hash("4"),
    byteSize: 42,
    locator: `evidence/${uiArtifactId}.png`,
  });
  seedEvidenceArtifact(fixture, {
    id: runtimeArtifactId,
    contentHash: hash("5"),
    byteSize: 42,
    locator: `evidence/${runtimeArtifactId}.json`,
  });
  const correlation = trustedCorrelation(
    fixture,
    [uiArtifactId, runtimeArtifactId],
    fixture.runInput,
    `-failure-${suffix}`,
  );
  fixture.runtime.recordAssertion({
    operationId: "operation-1",
    testRunId: fixture.runInput.testRunId,
    testCaseRevisionId: fixture.revision.id,
    assertionId: "assertion-1",
    uiObserved: "passed",
    runtimeObserved: "failed",
    uiStatus: "passed",
    runtimeStatus: "failed",
    correlation,
  });
  for (const evidence of [
    {
      id: uiArtifactId,
      kind: "screenshot" as const,
      mediaType: "image/png",
      locator: `evidence/${uiArtifactId}.png`,
      contentHash: hash("4"),
    },
    {
      id: runtimeArtifactId,
      kind: "runtime" as const,
      mediaType: "application/json",
      locator: `evidence/${runtimeArtifactId}.json`,
      contentHash: hash("5"),
    },
  ]) {
    fixture.runtime.recordEvidence({
      id: evidence.id,
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      kind: evidence.kind,
      mediaType: evidence.mediaType,
      contentHash: evidence.contentHash,
      byteSize: 42,
      artifactVersionId: evidence.id,
      redactionProfile: "default",
      retentionClass: "durable",
      locator: evidence.locator,
      metadata: {},
    });
  }
  const assertion = fixture.runtime
    .inspect(fixture.runInput.testRunId)
    .assertions.find((entry) => entry.assertionId === "assertion-1")!;
  return { assertion, evidenceRefs: [uiArtifactId, runtimeArtifactId] };
};

describe("Test Runtime", () => {
  it("atomically materializes paired assertions and verified Artifact evidence from a terminal execution result", async () => {
    const fixture = openFixture(true, true);
    fixture.runtime.createRun(fixture.runInput);
    const uiBytes = Buffer.from("real renderer screenshot");
    const runtimeBytes = Buffer.from('{"state":"reconciling"}');
    const evidence = [
      {
        id: "artifact-version-ui",
        bytes: uiBytes,
        locator: "evidence/ui.png",
      },
      {
        id: "artifact-version-runtime",
        bytes: runtimeBytes,
        locator: "evidence/runtime.json",
      },
    ];
    for (const entry of evidence) {
      seedEvidenceArtifact(fixture, {
        id: entry.id,
        contentHash: createHash("sha256").update(entry.bytes).digest("hex"),
        byteSize: entry.bytes.byteLength,
        locator: entry.locator,
        storedLocator: `/private/company/.sandcastle/artifacts/${entry.id}.bin`,
      });
      fixture.artifactBytes.set(entry.id, entry.bytes);
    }
    const cleanupArtifact = seedCleanupEvidenceArtifact(
      fixture,
      "artifact-version-cleanup",
    );

    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: {
        id: "scripted-test",
        execute: () => {
          const correlation = trustedCorrelation(
            fixture,
            evidence.map((entry) => entry.id),
            fixture.runInput,
            "-terminal-execute",
          );
          return {
            state: "succeeded" as const,
            providerReceipt: { id: "receipt-materialized" },
            selectedQueryView: selectedQueryView(fixture, correlation),
            result: {
              schemaVersion: 1,
              assertions: [
                {
                  testCaseRevisionId: fixture.revision.id,
                  assertionId: "assertion-1",
                  uiObserved: "passed",
                  runtimeObserved: "passed",
                  uiStatus: "passed",
                  runtimeStatus: "passed",
                  correlation,
                },
              ],
              evidence: [
                {
                  id: "evidence-ui",
                  testCaseRevisionId: fixture.revision.id,
                  assertionId: "assertion-1",
                  kind: "screenshot",
                  mediaType: "image/png",
                  contentHash: createHash("sha256")
                    .update(uiBytes)
                    .digest("hex"),
                  byteSize: uiBytes.byteLength,
                  artifactVersionId: "artifact-version-ui",
                  redactionProfile: "default",
                  retentionClass: "durable",
                  locator: "evidence/ui.png",
                  metadata: { renderer: true },
                },
                {
                  id: "evidence-runtime",
                  testCaseRevisionId: fixture.revision.id,
                  assertionId: "assertion-1",
                  kind: "runtime",
                  mediaType: "application/json",
                  contentHash: createHash("sha256")
                    .update(runtimeBytes)
                    .digest("hex"),
                  byteSize: runtimeBytes.byteLength,
                  artifactVersionId: "artifact-version-runtime",
                  redactionProfile: "default",
                  retentionClass: "durable",
                  locator: "evidence/runtime.json",
                  metadata: { authoritativeQuery: true },
                },
              ],
            },
          };
        },
        reconcile: () => ({ state: "unknown" as const }),
      },
    });
    const executed = await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "cleanup-operation-1",
      input: { kind: "cleanup" },
      adapter: {
        id: "scripted-test",
        execute: (request) => ({
          state: "succeeded" as const,
          providerReceipt: {
            schemaVersion: 1 as const,
            kind: "cleanup" as const,
            receiptId: "cleanup-receipt-materialized",
            fixtureId: fixture.runInput.fixture.id,
            operationKey: request.operationKey,
            rootFingerprint: hash("a"),
            targets: [
              {
                kind: "repository" as const,
                pathFingerprint: hash("b"),
                state: "absent" as const,
              },
              {
                kind: "worktree" as const,
                pathFingerprint: hash("c"),
                state: "absent" as const,
              },
            ],
            artifactVersionId: cleanupArtifact.artifactVersionId,
            contentHash: cleanupArtifact.contentHash,
          },
          result: {
            schemaVersion: 1,
            assertions: [],
            evidence: [
              {
                id: "evidence-cleanup",
                testCaseRevisionId: fixture.revision.id,
                assertionId: null,
                kind: "cleanup",
                mediaType: "application/json",
                ...cleanupArtifact,
                redactionProfile: "default",
                retentionClass: "durable",
                metadata: { remainingResources: [] },
              },
            ],
          },
        }),
        reconcile: () => ({ state: "unknown" as const }),
      },
    });

    assert.equal(executed.assertions.length, 1);
    assert.equal(executed.evidence.length, 3);
    assert.equal(
      fixture.runtime.complete(fixture.runInput.testRunId).state,
      "passed",
    );
    fixture.database.close();
  });

  it("derives immutable assertion verdicts from canonical observed and frozen expected values", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture);
    const input = {
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      uiStatus: "passed" as const,
      runtimeStatus: "passed" as const,
      uiObserved: { label: "Interaction Observed", order: [2, 1] },
      runtimeObserved: { state: "completed", detail: { b: 2, a: 1 } },
      correlation: trustedCorrelation(fixture, []),
    };

    fixture.runtime.recordAssertion(input);

    const assertion = fixture.runtime.inspect(fixture.runInput.testRunId)
      .assertions[0] as (typeof fixture.runtime.inspect extends (
      ...args: never[]
    ) => infer View
      ? View extends { assertions: readonly (infer Assertion)[] }
        ? Assertion
        : never
      : never) & {
      readonly uiObserved: unknown;
      readonly runtimeObserved: unknown;
    };
    assert.equal(assertion.uiStatus, "failed");
    assert.equal(assertion.runtimeStatus, "failed");
    assert.deepEqual(assertion.uiObserved, input.uiObserved);
    assert.deepEqual(assertion.runtimeObserved, input.runtimeObserved);

    assert.throws(
      () =>
        fixture.runtime.recordAssertion({
          ...input,
          uiObserved: "passed",
          runtimeObserved: "passed",
          correlation: trustedCorrelation(
            fixture,
            [],
            fixture.runInput,
            "-assertion-conflict",
          ),
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ASSERTION_CONFLICT",
    );
    fixture.database.close();
  });

  it("accepts formal Artifact producer context when legacy producer columns are null", async () => {
    const fixture = openFixture(true, true);
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture, fixture.runInput);
    const bytes = Buffer.from("formal artifact evidence");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    seedEvidenceArtifact(fixture, {
      id: "formal-artifact-version",
      contentHash,
      byteSize: bytes.byteLength,
      locator: "evidence/formal.json",
      producerContextOnly: true,
    });
    fixture.artifactBytes.set("formal-artifact-version", bytes);

    assert.doesNotThrow(() =>
      fixture.runtime.recordEvidence({
        id: "formal-artifact-evidence",
        operationId: "operation-1",
        testRunId: fixture.runInput.testRunId,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        kind: "runtime",
        mediaType: "application/json",
        contentHash,
        byteSize: bytes.byteLength,
        artifactVersionId: "formal-artifact-version",
        redactionProfile: "default",
        retentionClass: "durable",
        locator: "evidence/formal.json",
        metadata: {},
      }),
    );
    fixture.database.close();
  });

  it("rolls back a terminal fact whose Artifact bytes do not match the frozen evidence descriptor", async () => {
    const fixture = openFixture(true, true);
    fixture.runtime.createRun(fixture.runInput);
    const declaredBytes = Buffer.from("declared evidence");
    seedEvidenceArtifact(fixture, {
      id: "artifact-version-tampered",
      contentHash: createHash("sha256").update(declaredBytes).digest("hex"),
      byteSize: declaredBytes.byteLength,
      locator: "evidence/tampered.json",
    });
    fixture.artifactBytes.set(
      "artifact-version-tampered",
      Buffer.from("different bytes"),
    );

    await assert.rejects(
      fixture.runtime.execute({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter: {
          id: "scripted-test",
          execute: () => ({
            state: "succeeded" as const,
            providerReceipt: { id: "receipt-tampered" },
            result: {
              schemaVersion: 1,
              assertions: [],
              evidence: [
                {
                  id: "evidence-tampered",
                  testCaseRevisionId: fixture.revision.id,
                  assertionId: "assertion-1",
                  kind: "runtime",
                  mediaType: "application/json",
                  contentHash: createHash("sha256")
                    .update(declaredBytes)
                    .digest("hex"),
                  byteSize: declaredBytes.byteLength,
                  artifactVersionId: "artifact-version-tampered",
                  redactionProfile: "default",
                  retentionClass: "durable",
                  locator: "evidence/tampered.json",
                  metadata: {},
                },
              ],
            },
          }),
          reconcile: () => ({ state: "unknown" as const }),
        },
      }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_EVIDENCE_ARTIFACT_INVALID",
    );
    assert.equal(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM test_execution_facts")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    assert.equal(
      fixture.runtime.inspect(fixture.runInput.testRunId).evidence.length,
      0,
    );
    fixture.database.close();
  });

  it("reconcile materializes a terminal result once after a crash between effect and fact persistence", async () => {
    const fixture = openFixture(true, true);
    fixture.runtime.createRun(fixture.runInput);
    const cleanupArtifact = seedCleanupEvidenceArtifact(
      fixture,
      "artifact-version-cleanup-on-reconcile",
    );
    const terminalResult = {
      schemaVersion: 1 as const,
      assertions: [],
      evidence: [
        {
          id: "evidence-cleanup-on-reconcile",
          testCaseRevisionId: fixture.revision.id,
          assertionId: null,
          kind: "cleanup" as const,
          mediaType: "application/json",
          ...cleanupArtifact,
          redactionProfile: "default",
          retentionClass: "durable" as const,
          metadata: { remainingResources: [] },
        },
      ],
    };
    const cleanupReceipt = (operationKey: string) => ({
      schemaVersion: 1 as const,
      kind: "cleanup" as const,
      receiptId: "receipt-reconcile",
      fixtureId: fixture.runInput.fixture.id,
      operationKey,
      rootFingerprint: hash("a"),
      targets: [
        {
          kind: "repository" as const,
          pathFingerprint: hash("b"),
          state: "absent" as const,
        },
        {
          kind: "worktree" as const,
          pathFingerprint: hash("c"),
          state: "absent" as const,
        },
      ],
      artifactVersionId: cleanupArtifact.artifactVersionId,
      contentHash: cleanupArtifact.contentHash,
    });
    const adapter = {
      id: "scripted-test",
      execute: (request: { readonly operationKey: string }) => ({
        state: "succeeded" as const,
        providerReceipt: cleanupReceipt(request.operationKey),
        result: terminalResult,
      }),
      reconcile: (request: { readonly operationKey: string }) => ({
        state: "succeeded" as const,
        providerReceipt: cleanupReceipt(request.operationKey),
        result: terminalResult,
      }),
    };

    await assert.rejects(
      fixture.runtime.execute({
        testRunId: fixture.runInput.testRunId,
        operationId: "cleanup-operation-1",
        input: { kind: "cleanup" },
        adapter,
        failureInjection: (point) => {
          if (point === "after-effect") throw new Error("crash-after-effect");
        },
      }),
      /crash-after-effect/,
    );
    assert.equal(
      fixture.runtime.inspect(fixture.runInput.testRunId).evidence.length,
      0,
    );
    await fixture.runtime.reconcile({
      testRunId: fixture.runInput.testRunId,
      operationId: "cleanup-operation-1",
      adapter,
    });
    await fixture.runtime.reconcile({
      testRunId: fixture.runInput.testRunId,
      operationId: "cleanup-operation-1",
      adapter,
    });
    assert.equal(
      fixture.runtime.inspect(fixture.runInput.testRunId).evidence.length,
      1,
    );
    fixture.database.close();
  });

  it("rolls back reconcile state, event, audit, context, and receipt as one worker unit", async () => {
    const fixture = openFixture(true, false, (point, commandId) => {
      if (point === "after-event" && commandId.endsWith(":reconcile-intent")) {
        throw new Error("reconcile-unit-of-work-crash");
      }
    });
    fixture.runtime.createRun(fixture.runInput);
    const adapter = {
      id: "scripted-test",
      execute: () => ({ state: "unknown" as const }),
      reconcile: () => ({ state: "unknown" as const }),
    };
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });
    const before = fixture.runtime.inspect(fixture.runInput.testRunId);
    const beforeSequence = fixture.events!.latestSequence();
    const beforeAuditCount = (
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
        .get() as { readonly count: number }
    ).count;
    const beforeReceiptCount = (
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
        .get() as { readonly count: number }
    ).count;

    await assert.rejects(
      fixture.runtime.reconcile({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        adapter,
      }),
      /reconcile-unit-of-work-crash/,
    );

    assert.deepEqual(
      fixture.runtime.inspect(fixture.runInput.testRunId),
      before,
    );
    assert.equal(fixture.events!.latestSequence(), beforeSequence);
    assert.equal(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM runtime_audit_records")
          .get() as { readonly count: number }
      ).count,
      beforeAuditCount,
    );
    assert.equal(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM command_deduplication")
          .get() as { readonly count: number }
      ).count,
      beforeReceiptCount,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT 1 FROM runtime_unit_of_work_context")
        .get(),
      undefined,
    );
    fixture.database.close();
  });

  it("rejects renderer-authored assertion verdict Commands", () => {
    const parsed = CommandEnvelopeSchema.safeParse({
      commandId: "forged-test-assertion",
      schemaVersion: 1,
      actor: {
        type: "human",
        id: "renderer-user",
        authenticatedBy: "local-session",
      },
      command: {
        type: "test.assertion.record",
        testRunId: "test-run-1",
        testCaseRevisionId: "case-1-r1",
        assertionId: "assertion-1",
        required: false,
        uiStatus: "passed",
        runtimeStatus: "passed",
        correlation: {
          commandId: "unrelated-command",
          eventSequence: 1,
          queryAsOfSequence: 1,
          queryViewHash: hash("a"),
          snapshotRevisionId: "snapshot-1",
          runId: "run-1",
          nodeRunId: "test-node-1",
          nodeAttemptId: "test-attempt-1",
          sessionId: "test-session-1",
          artifactVersionIds: ["made-up-artifact"],
        },
      },
    });

    assert.equal(parsed.success, false);
  });

  it("does not let caller-declared optional assertions or fabricated evidence create PASS", () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    const correlation = {
      commandId: "made-up-command",
      eventSequence: 0,
      runtimeEventType: "test.run.started",
      queryAsOfSequence: 0,
      queryViewHash: fixture.runtime.inspect(fixture.runInput.testRunId)
        .viewHash,
      viewSyncTokenHash: hash("9"),
      snapshotRevisionId: fixture.runInput.snapshotRevisionId,
      runId: fixture.runInput.runId,
      nodeRunId: fixture.runInput.nodeRunId,
      nodeAttemptId: fixture.runInput.nodeAttemptId,
      sessionId: fixture.runInput.sessionId,
      artifactVersionIds: ["made-up-artifact"],
    };
    assert.throws(
      () =>
        fixture.runtime.recordAssertion({
          operationId: "operation-1",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          required: false,
          uiObserved: "failed",
          runtimeObserved: "failed",
          uiStatus: "failed",
          runtimeStatus: "failed",
          correlation,
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ASSERTION_REQUIREDNESS_FROZEN",
    );
    assert.throws(
      () =>
        fixture.runtime.recordEvidence({
          id: "forged-runtime",
          operationId: "operation-1",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          kind: "runtime",
          mediaType: "application/json",
          contentHash: hash("8"),
          byteSize: 42,
          artifactVersionId: "made-up-artifact",
          redactionProfile: "default",
          retentionClass: "durable",
          locator: "evidence/forged-runtime",
          metadata: {},
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_OBSERVATION_SOURCE_INVALID",
    );

    assert.throws(() => fixture.runtime.complete(fixture.runInput.testRunId));
    fixture.database.close();
  });

  it("freezes all child evidence after a Test Run becomes terminal", () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    fixture.database
      .prepare(
        "UPDATE test_runs SET state = 'passed', pass_authority_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(hash("9"), "2026-07-29T00:00:01.000Z", fixture.runInput.testRunId);

    assert.throws(
      () =>
        fixture.database
          .prepare(
            `INSERT INTO test_evidence(
               id, test_run_id, test_case_revision_id, assertion_id, kind,
               media_type, content_hash, byte_size, artifact_version_id,
               redaction_profile, retention_class, locator, metadata_json,
               created_at
             ) VALUES (?, ?, ?, ?, 'runtime', 'application/json', ?, 2, NULL,
                       'default', 'durable', 'evidence/late.json', '{}', ?)`,
          )
          .run(
            "late-evidence",
            fixture.runInput.testRunId,
            fixture.revision.id,
            "assertion-1",
            hash("8"),
            "2026-07-29T00:00:02.000Z",
          ),
      /Terminal Test Run children are immutable/,
    );
    fixture.database.close();
  });

  it("rejects Test Runs whose project, Run, or Snapshot differs from exact Integration authority", () => {
    for (const changed of [
      { projectId: "project-other" },
      { runId: "run-other" },
      { snapshotRevisionId: "snapshot-other" },
    ]) {
      const fixture = openFixture();
      assert.throws(
        () =>
          fixture.runtime.createRun({
            ...fixture.runInput,
            ...changed,
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "INTEGRATION_AUTHORITY_LINEAGE_MISMATCH",
      );
      fixture.database.close();
    }
  });

  it("derives build and Execution Profile identity from authoritative registries", () => {
    for (const [changed, expectedCode] of [
      [
        { build: { artifactVersionId: "build-1", digest: hash("0") } },
        "TEST_BUILD_AUTHORITY_INVALID",
      ],
      [
        { executionProfile: { id: "profile-1", hash: hash("0") } },
        "TEST_EXECUTION_PROFILE_INVALID",
      ],
    ] as const) {
      const fixture = openFixture();
      assert.throws(
        () => fixture.runtime.createRun({ ...fixture.runInput, ...changed }),
        (error: unknown) =>
          error instanceof TestRuntimeError && error.code === expectedCode,
      );
      fixture.database.close();
    }
  });

  it("rejects build Artifact lineage from an unrelated Integration Generation", () => {
    const fixture = openFixture();
    fixture.database
      .prepare(
        "UPDATE artifact_versions SET producer_context_json = ? WHERE id = 'build-1'",
      )
      .run(
        JSON.stringify({
          projectId: fixture.runInput.projectId,
          runId: fixture.runInput.runId,
          snapshotRevisionId: fixture.runInput.snapshotRevisionId,
          nodeRunId: "integration-node-1",
          nodeAttemptId: "integration-attempt-1",
          aiMemberId: "builder-ai",
          integrationAuthority: {
            ...fixture.runInput.integrationAuthority,
            generationId: "generation-unrelated",
          },
        }),
      );
    assert.throws(
      () => fixture.runtime.createRun(fixture.runInput),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_BUILD_AUTHORITY_INVALID",
    );
    fixture.database.close();
  });

  it("compares build Integration commits canonically while rejecting changed content", () => {
    const addSecondRepository = (fixture: ReturnType<typeof openFixture>) => {
      const first = fixture.generation.repositoryResults[0]!;
      (fixture.generation.repositoryResults as Array<typeof first>).push({
        ...first,
        id: "repository-result-2",
        repositoryReference: "repo-b",
        integratedCommit: commit("4"),
        validationRecords: [],
      });
      fixture.database
        .prepare(
          "UPDATE artifact_versions SET producer_context_json = ? WHERE id = 'build-1'",
        )
        .run(
          JSON.stringify({
            projectId: fixture.runInput.projectId,
            runId: fixture.runInput.runId,
            snapshotRevisionId: fixture.runInput.snapshotRevisionId,
            nodeRunId: fixture.runInput.nodeRunId,
            nodeAttemptId: fixture.runInput.nodeAttemptId,
            aiMemberId: "builder-ai",
            integrationAuthority: {
              generationId: fixture.generation.id,
              manifestHash: fixture.generation.manifestHash,
              passAuthorityHash: fixture.generation.passAuthorityHash!,
              repositoryCommits: [
                { repositoryReference: "repo-a", commit: commit("2") },
                { repositoryReference: "repo-b", commit: commit("4") },
              ],
            },
          }),
        );
    };

    const reversed = openFixture();
    addSecondRepository(reversed);
    assert.equal(
      reversed.runtime.createRun({
        ...reversed.runInput,
        integrationAuthority: {
          ...reversed.runInput.integrationAuthority,
          repositoryCommits: [
            { repositoryReference: "repo-b", commit: commit("4") },
            { repositoryReference: "repo-a", commit: commit("2") },
          ],
        },
      }).state,
      "scheduled",
    );
    reversed.database.close();

    const changed = openFixture();
    addSecondRepository(changed);
    assert.throws(
      () =>
        changed.runtime.createRun({
          ...changed.runInput,
          integrationAuthority: {
            ...changed.runInput.integrationAuthority,
            repositoryCommits: [
              { repositoryReference: "repo-b", commit: commit("5") },
              { repositoryReference: "repo-a", commit: commit("2") },
            ],
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "INTEGRATION_AUTHORITY_INELIGIBLE",
    );
    changed.database.close();
  });

  it("accepts formal build producer context when legacy producer columns are null", () => {
    const fixture = openFixture(false, true);
    fixture.database
      .prepare(
        `UPDATE artifact_versions
            SET producing_run_id = NULL, snapshot_revision_id = NULL,
                producer_context_json = ?
          WHERE id = 'build-1'`,
      )
      .run(
        JSON.stringify({
          projectId: fixture.runInput.projectId,
          runId: fixture.runInput.runId,
          nodeRunId: fixture.runInput.nodeRunId,
          nodeAttemptId: fixture.runInput.nodeAttemptId,
          snapshotRevisionId: fixture.runInput.snapshotRevisionId,
          aiMemberId: "developer-ai",
          integrationAuthority: {
            generationId: fixture.generation.id,
            manifestHash: fixture.generation.manifestHash,
            passAuthorityHash: fixture.generation.passAuthorityHash!,
            repositoryCommits:
              fixture.runInput.integrationAuthority.repositoryCommits,
          },
        }),
      );

    assert.equal(
      fixture.runtime.createRun(fixture.runInput).state,
      "scheduled",
    );
    fixture.database.close();

    const tampered = openFixture(false, true);
    tampered.database
      .prepare(
        `UPDATE artifact_versions
            SET producing_run_id = NULL, snapshot_revision_id = NULL,
                producer_context_json = ?
          WHERE id = 'build-1'`,
      )
      .run(
        JSON.stringify({
          projectId: tampered.runInput.projectId,
          runId: "run-other",
          snapshotRevisionId: tampered.runInput.snapshotRevisionId,
          nodeRunId: tampered.runInput.nodeRunId,
          nodeAttemptId: tampered.runInput.nodeAttemptId,
          aiMemberId: "developer-ai",
          integrationAuthority: {
            generationId: tampered.generation.id,
            manifestHash: tampered.generation.manifestHash,
            passAuthorityHash: tampered.generation.passAuthorityHash!,
            repositoryCommits:
              tampered.runInput.integrationAuthority.repositoryCommits,
          },
        }),
      );
    assert.throws(
      () => tampered.runtime.createRun(tampered.runInput),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_BUILD_AUTHORITY_INVALID",
    );
    tampered.database.close();
  });

  it("rejects caller attempts to remove risk rules or factors or down-tier Runtime authority", () => {
    const complete = openFixture();
    assert.equal(
      complete.runtime.createRun(complete.runInput).state,
      "scheduled",
    );
    complete.database.close();
    const rebuildRisk = (
      risk: ReturnType<typeof testRiskInput>,
      rules: readonly {
        readonly factorId: string;
        readonly minimumTier: "low" | "medium" | "high" | "critical";
      }[],
      factors: typeof risk.factors,
      computedTier: "low" | "medium" | "high" | "critical",
    ) => {
      const policyHash = canonicalHash({
        schemaVersion: 1,
        revisionId: risk.policy.revisionId,
        rules,
      });
      const evidenceRefs = [
        ...new Set(factors.flatMap((factor) => factor.evidenceRefs)),
      ].sort();
      return {
        ...risk,
        policy: { ...risk.policy, rules, hash: policyHash },
        factors,
        computedTier,
        evidenceRefs,
        inputHash: canonicalHash({
          schemaVersion: 1,
          policyRevisionId: risk.policy.revisionId,
          policyHash,
          factors,
          evidenceRefs,
        }),
      };
    };
    for (const mutate of [
      (risk: ReturnType<typeof testRiskInput>) =>
        rebuildRisk(risk, risk.policy.rules.slice(1), risk.factors, "high"),
      (risk: ReturnType<typeof testRiskInput>) =>
        rebuildRisk(risk, risk.policy.rules, risk.factors.slice(1), "high"),
      (risk: ReturnType<typeof testRiskInput>) => {
        const rules = risk.policy.rules.map((rule) => ({
          ...rule,
          minimumTier: "low" as const,
        }));
        return rebuildRisk(risk, rules, risk.factors, "low");
      },
    ]) {
      const fixture = openFixture();
      assert.throws(
        () =>
          fixture.runtime.createRun({
            ...fixture.runInput,
            risk: mutate(fixture.runInput.risk),
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_SCOPE_RISK_AUTHORITY_INVALID",
      );
      fixture.database.close();
    }
  });

  it("keeps a keyword-free critical frozen Work Package as the Test scope tier floor", () => {
    const fixture = openFixture(false, false, undefined, undefined, "critical");

    const run = fixture.runtime.createRun(fixture.runInput);

    assert.equal(run.manifest.risk.computedTier, "critical");
    assert.deepEqual(
      run.manifest.risk.factors.find(
        (factor) => factor.id === "work-package-risk-tier",
      ),
      {
        id: "work-package-risk-tier",
        present: true,
        evidenceRefs: ["work-package-version:package-1-v1:risk-tier:critical"],
      },
    );
    fixture.database.close();
  });

  it("raises explicit destructive and boundary signals to critical and rejects downgrade", () => {
    const fixture = openFixture();
    const capabilities = [
      ...fixture.runInput.capabilities,
      "destructive-action",
      "sandbox-escape",
    ];
    const factors = fixture.runInput.risk.factors.map((factor) =>
      factor.id === "destructive-action"
        ? {
            ...factor,
            present: true,
            evidenceRefs: ["test-capability:destructive-action"],
          }
        : factor.id === "sandbox-boundary"
          ? {
              ...factor,
              present: true,
              evidenceRefs: ["test-capability:sandbox-escape"],
            }
          : factor,
    );
    const evidenceRefs = [
      ...new Set(factors.flatMap((factor) => factor.evidenceRefs)),
    ].sort();
    const risk = {
      ...fixture.runInput.risk,
      factors,
      computedTier: "critical" as const,
      evidenceRefs,
      inputHash: canonicalHash({
        schemaVersion: 1,
        policyRevisionId: fixture.runInput.risk.policy.revisionId,
        policyHash: fixture.runInput.risk.policy.hash,
        factors,
        evidenceRefs,
      }),
    };
    assert.equal(
      fixture.runtime.createRun({
        ...fixture.runInput,
        capabilities,
        risk,
      }).manifest.risk.computedTier,
      "critical",
    );
    fixture.database.close();

    const downgraded = openFixture();
    assert.throws(
      () =>
        downgraded.runtime.createRun({
          ...downgraded.runInput,
          capabilities,
          risk: { ...risk, computedTier: "high" },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_SCOPE_RISK_INVALID",
    );
    downgraded.database.close();
  });

  it("requires exact package and acceptance-criterion coverage from frozen Case revisions", () => {
    const fixture = openFixture();
    const incomplete = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-1-r2",
      supersedesRevisionId: fixture.revision.id,
      manifest: {
        ...fixture.revisionInput.manifest,
        requirementIds: [],
        workPackageVersions: [],
      },
    });
    const incompleteRisk = testRiskInput([incomplete.id]);
    assert.throws(
      () =>
        fixture.runtime.createRun({
          ...fixture.runInput,
          testCaseRevisions: [
            { id: incomplete.id, hash: incomplete.manifestHash },
          ],
          risk: incompleteRisk,
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_CASE_COVERAGE_INCOMPLETE",
    );
    fixture.database.close();
  });

  it("rejects a Test engineer who shares an implementation Agent identity", () => {
    const fixture = openFixture();
    fixture.database
      .prepare(
        `INSERT INTO work_package_assignments(
           id, work_package_version_id, node_attempt_id, position_id,
           ai_member_id, agent_adapter_id, rationale_json, allocation_id,
           interaction_session_id, sandbox_identity, evidence_scope, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'self-check-passed', ?, ?)`,
      )
      .run(
        "assignment-1",
        "package-1-v1",
        "developer-attempt-1",
        "position-test-engineer",
        "tester-ai",
        "scripted-execution",
        "allocation-1",
        "developer-session-1",
        "sandbox-1",
        "evidence-scope-1",
        "2026-07-29T00:00:00.000Z",
        "2026-07-29T00:00:00.000Z",
      );
    assert.throws(
      () => fixture.runtime.createRun(fixture.runInput),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ENGINEER_NOT_INDEPENDENT",
    );
    fixture.database.close();
  });

  it("accepts only the exact closed PASS Integration Generation authority", () => {
    const { database, generation, runtime, runInput } = openFixture();
    const run = runtime.createRun(runInput);
    assert.equal(run.state, "scheduled");

    (
      generation.defects as Array<IntegrationGenerationView["defects"][number]>
    ).push({
      id: "defect-1",
      kind: "aggregate",
      status: "open",
      responsibility: {},
      evidence: {},
    });
    assert.throws(
      () =>
        runtime.createRun({
          ...runInput,
          testRunId: "test-run-2",
          requestId: "request-2",
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "INTEGRATION_AUTHORITY_INELIGIBLE",
    );
    database.close();
  });

  it("keeps Test Case revisions and Test Run manifests immutable with stable replay conflicts", () => {
    const { database, runtime, revision, revisionInput, runInput } =
      openFixture();
    assert.deepEqual(runtime.registerCaseRevision(revisionInput), revision);
    assert.throws(
      () =>
        runtime.registerCaseRevision({
          ...revisionInput,
          manifest: { ...revisionInput.manifest, preconditions: ["changed"] },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_CASE_REVISION_CONFLICT",
    );

    const first = runtime.createRun(runInput);
    assert.deepEqual(runtime.createRun(runInput), first);
    assert.throws(
      () =>
        runtime.createRun({
          ...runInput,
          environment: { ...runInput.environment, platform: "win32" },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_REQUEST_CONFLICT",
    );
    assert.throws(
      () =>
        runtime.createRun({
          ...runInput,
          clock: { ...runInput.clock, seed: "changed-seed" },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_REQUEST_CONFLICT",
    );

    const changedSeedFixture = openFixture();
    const changedSeed = changedSeedFixture.runtime.createRun({
      ...changedSeedFixture.runInput,
      clock: { ...changedSeedFixture.runInput.clock, seed: "changed-seed" },
    });
    const changedClockFixture = openFixture();
    const changedClock = changedClockFixture.runtime.createRun({
      ...changedClockFixture.runInput,
      clock: {
        ...changedClockFixture.runInput.clock,
        instant: "2026-07-30T00:00:00.000Z",
      },
    });
    assert.notEqual(changedSeed.manifestHash, first.manifestHash);
    assert.notEqual(changedClock.manifestHash, first.manifestHash);
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE test_case_revisions SET manifest_hash = ? WHERE id = ?",
          )
          .run(hash("9"), revision.id),
      /Test Case revision is immutable/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE test_runs SET manifest_hash = ? WHERE id = ?")
          .run(hash("9"), first.id),
      /Test Run manifest is immutable/,
    );
    changedSeedFixture.database.close();
    changedClockFixture.database.close();
    database.close();
  });

  it("keeps Query View child IDs repeatable for the same clock and seeded ID source", async () => {
    const nextId = () => {
      let sequence = 0;
      return () => `repeatable-id-${++sequence}`;
    };
    const first = openFixture(false, false, undefined, nextId());
    const second = openFixture(false, false, undefined, nextId());
    for (const fixture of [first, second]) {
      fixture.runtime.createRun(fixture.runInput);
      await succeedRequiredExecution(fixture);
      fixture.runtime.recordAssertion({
        operationId: "operation-1",
        testRunId: fixture.runInput.testRunId,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        uiObserved: "passed",
        runtimeObserved: "passed",
        uiStatus: "passed",
        runtimeStatus: "passed",
        correlation: trustedCorrelation(fixture, []),
      });
    }
    assert.deepEqual(
      first.runtime.inspect(first.runInput.testRunId).assertions,
      second.runtime.inspect(second.runInput.testRunId).assertions,
    );
    first.database.close();
    second.database.close();
  });

  it("requires paired UI and Runtime assertions with correlated immutable evidence before PASS", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture);
    seedEvidenceArtifact(fixture, {
      id: "artifact-version-1",
      contentHash: hash("4"),
      byteSize: 42,
      locator: "evidence/screenshot.png",
    });
    const correlation = trustedCorrelation(fixture, ["artifact-version-1"]);
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: null,
      uiStatus: "passed",
      runtimeStatus: "missing",
      correlation,
    });
    fixture.runtime.recordEvidence({
      id: "evidence-1",
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      kind: "ui",
      mediaType: "image/png",
      contentHash: hash("4"),
      byteSize: 42,
      artifactVersionId: "artifact-version-1",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/screenshot.png",
      metadata: { commandId: "command-1" },
    });
    const blocked = fixture.runtime.complete(fixture.runInput.testRunId);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.defects.length, 1);
    assert.equal(blocked.defects[0]?.status, "open");
    assert.equal(blocked.obligations.length, 1);
    assert.equal(blocked.obligations[0]?.status, "open");

    const fresh = openFixture();
    fresh.runtime.createRun(fresh.runInput);
    await succeedRequiredExecution(fresh);
    seedEvidenceArtifact(fresh, {
      id: "artifact-version-runtime",
      contentHash: hash("5"),
      byteSize: 42,
      locator: "evidence/runtime.json",
    });
    seedEvidenceArtifact(fresh, {
      id: "artifact-version-ui",
      contentHash: hash("6"),
      byteSize: 42,
      locator: "evidence/ui.png",
    });
    const freshCorrelation = trustedCorrelation(fresh, [
      "artifact-version-ui",
      "artifact-version-runtime",
    ]);
    fresh.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: "passed",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: freshCorrelation,
    });
    fresh.runtime.recordEvidence({
      id: "evidence-1",
      operationId: "operation-1",
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      kind: "runtime",
      mediaType: "application/json",
      contentHash: hash("5"),
      byteSize: 42,
      artifactVersionId: "artifact-version-runtime",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/runtime.json",
      metadata: { eventSequence: 8, queryViewHash: hash("3") },
    });
    assert.throws(
      () => fresh.runtime.complete(fresh.runInput.testRunId),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_PASS_INCOMPLETE",
    );
    const uiEvidence = {
      id: "evidence-ui",
      operationId: "operation-1",
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      kind: "screenshot",
      mediaType: "image/png",
      contentHash: hash("6"),
      byteSize: 42,
      artifactVersionId: "artifact-version-ui",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/ui.png",
      metadata: { commandId: "command-1" },
    } as const;
    fresh.runtime.recordEvidence(uiEvidence);
    fresh.runtime.recordEvidence(uiEvidence);
    assert.throws(
      () =>
        fresh.runtime.recordEvidence({
          ...uiEvidence,
          locator: "evidence/changed.png",
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_EVIDENCE_ARTIFACT_INVALID",
    );
    const passed = fresh.runtime.complete(fresh.runInput.testRunId);
    assert.equal(passed.state, "passed");
    assert.match(passed.passAuthorityHash!, /^[a-f0-9]{64}$/);
    assert.equal(
      fresh.runtime.downstreamAuthority(passed.id).integrationAuthority
        .generationId,
      "generation-1",
    );
    fresh.database.close();
    fixture.database.close();
  });

  it("blocks the complete failed, unknown, and missing assertion union", async () => {
    const fixture = openFixture();
    const revision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      testCaseId: "case-terminal-union",
      revisionId: "case-terminal-union-r1",
      manifest: {
        ...fixture.revisionInput.manifest,
        assertions: [
          {
            id: "assertion-failed",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "state", expected: "passed" },
          },
          {
            id: "assertion-unknown",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "state", expected: "passed" },
          },
          {
            id: "assertion-missing",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "state", expected: "passed" },
          },
        ],
      },
    });
    const runInput = {
      ...fixture.runInput,
      testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
      risk: testRiskInput([revision.id]),
    };
    fixture.runtime.createRun(runInput);
    await succeedRequiredExecution(fixture, runInput);
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: runInput.testRunId,
      testCaseRevisionId: revision.id,
      assertionId: "assertion-failed",
      uiObserved: "failed",
      runtimeObserved: "passed",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: trustedCorrelation(fixture, [], runInput, "-union-failed"),
    });
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: runInput.testRunId,
      testCaseRevisionId: revision.id,
      assertionId: "assertion-unknown",
      uiObserved: "passed",
      runtimeObserved: null,
      uiStatus: "passed",
      runtimeStatus: "unknown",
      correlation: trustedCorrelation(fixture, [], runInput, "-union-unknown"),
    });

    const completed = fixture.runtime.complete(runInput.testRunId);

    assert.equal(completed.state, "blocked");
    assert.deepEqual(
      completed.defects.map((defect) => defect.assertionId).sort(),
      ["assertion-failed", "assertion-missing", "assertion-unknown"],
    );
    assert.equal(completed.obligations.length, 3);
    assert.equal(
      completed.defects.every((defect) => defect.status === "open"),
      true,
    );
    fixture.database.close();
  });

  it("keeps missing assertion identity unambiguous when revision and assertion IDs contain colons", async () => {
    const fixture = openFixture();
    const revision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case:colon:r1",
      manifest: {
        ...fixture.revisionInput.manifest,
        assertions: [
          {
            id: "assertion:missing:only",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "state", expected: "passed" },
          },
        ],
      },
    });
    const runInput = {
      ...fixture.runInput,
      testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
      risk: testRiskInput([revision.id]),
    };
    fixture.runtime.createRun(runInput);
    await succeedRequiredExecution(fixture, runInput);

    const completed = fixture.runtime.complete(runInput.testRunId);

    assert.equal(completed.state, "blocked");
    assert.deepEqual(
      completed.defects.map((defect) => ({
        testCaseRevisionId: defect.testCaseRevisionId,
        assertionId: defect.assertionId,
      })),
      [
        {
          testCaseRevisionId: "case:colon:r1",
          assertionId: "assertion:missing:only",
        },
      ],
    );
    fixture.database.close();
  });

  it("terminalizes inside an existing formal Command unit of work without nesting a transaction", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture);
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: null,
      uiStatus: "passed",
      runtimeStatus: "unknown",
      correlation: trustedCorrelation(fixture, []),
    });
    fixture.database.exec("BEGIN IMMEDIATE");
    fixture.database
      .prepare(
        `INSERT INTO runtime_unit_of_work_context(
           slot, command_id, actor_type, actor_id, authenticated_by,
           consumer_id, schema_version
         ) VALUES (1, 'formal-test-run-complete', 'human', 'tester',
                   'local-session', 'desktop', 1)`,
      )
      .run();
    try {
      assert.equal(
        fixture.runtime.complete(fixture.runInput.testRunId).state,
        "blocked",
      );
      fixture.database
        .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
        .run();
      fixture.database.exec("COMMIT");
    } catch (error) {
      fixture.database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      Number(
        (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = 'formal-test-run-complete'",
            )
            .get() as { readonly count: number }
        ).count,
      ) > 0,
      true,
    );
    fixture.database.close();
  });

  it("rolls back worker-owned PASS completion after state or event failure", async () => {
    for (const failurePoint of ["after-state", "after-event"] as const) {
      const fixture = openFixture(false, false, (point, commandId) => {
        if (point === failurePoint && commandId.includes(":terminal:")) {
          throw new Error(`pass-completion-${failurePoint}`);
        }
      });
      fixture.runtime.createRun(fixture.runInput);
      await succeedRequiredExecution(fixture);
      const artifacts = [
        ["pass-rollback-ui", "screenshot", "image/png", hash("4")],
        ["pass-rollback-runtime", "runtime", "application/json", hash("5")],
      ] as const;
      for (const [id, kind, mediaType, contentHash] of artifacts) {
        seedEvidenceArtifact(fixture, {
          id,
          contentHash,
          byteSize: 42,
          locator: `evidence/${id}`,
        });
        fixture.runtime.recordEvidence({
          id,
          operationId: "operation-1",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          kind,
          mediaType,
          contentHash,
          byteSize: 42,
          artifactVersionId: id,
          redactionProfile: "default",
          retentionClass: "durable",
          locator: `evidence/${id}`,
          metadata: {},
        });
      }
      fixture.runtime.recordAssertion({
        operationId: "operation-1",
        testRunId: fixture.runInput.testRunId,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        uiObserved: "passed",
        runtimeObserved: "passed",
        uiStatus: "passed",
        runtimeStatus: "passed",
        correlation: trustedCorrelation(
          fixture,
          artifacts.map(([id]) => id),
        ),
      });

      assert.throws(
        () => fixture.runtime.complete(fixture.runInput.testRunId),
        new RegExp(`pass-completion-${failurePoint}`),
      );
      assert.equal(
        fixture.runtime.inspect(fixture.runInput.testRunId).state,
        "running",
      );
      assert.equal(
        fixture.database
          .prepare(
            "SELECT 1 FROM command_deduplication WHERE command_id LIKE '%:terminal:%'",
          )
          .get(),
        undefined,
      );
      fixture.database.close();
    }
  });

  it("reconciles crash, timeout, cancellation, and accepted non-terminal effects without blind resend", async () => {
    const { database, runtime, runInput } = openFixture();
    runtime.createRun(runInput);
    let executions = 0;
    const adapter = {
      id: "scripted-test",
      execute: () => {
        executions += 1;
        return {
          state: "accepted" as const,
          providerReceipt: { id: "provider-1" },
        };
      },
      reconcile: () => ({
        state: "succeeded" as const,
        providerReceipt: { id: "provider-1" },
        evidenceRef: "execution-fact:1",
      }),
      cancel: () => ({ state: "unknown" as const }),
    };
    const accepted = await runtime.execute({
      testRunId: runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });
    assert.equal(accepted.state, "reconciling");
    await assert.rejects(
      runtime.execute({
        testRunId: runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter,
      }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_EXECUTION_RECONCILIATION_REQUIRED",
    );
    assert.equal(executions, 1);
    const reconciled = await runtime.reconcile({
      testRunId: runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(reconciled.state, "running");
    assert.equal(executions, 1);

    const second = openFixture();
    second.runtime.createRun(second.runInput);
    await second.runtime.execute({
      testRunId: second.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });
    let cancelCalls = 0;
    let cancelReconciliations = 0;
    const cancelAdapter = {
      ...adapter,
      cancel: () => {
        cancelCalls += 1;
        assert.equal(
          (
            second.database
              .prepare(
                "SELECT state FROM test_execution_control_operations WHERE id = 'cancel-operation-1'",
              )
              .get() as { readonly state: string }
          ).state,
          "intent",
        );
        assert.ok(
          second.database
            .prepare(
              "SELECT 1 FROM command_deduplication WHERE command_id LIKE '%:cancel:cancel-operation-1:intent'",
            )
            .get(),
        );
        return { state: "unknown" as const };
      },
      reconcile: () => {
        cancelReconciliations += 1;
        return { state: "unknown" as const };
      },
    };
    const cancelled = await second.runtime.cancel({
      cancelOperationId: "cancel-operation-1",
      testRunId: second.runInput.testRunId,
      operationId: "operation-1",
      adapter: cancelAdapter,
    });
    assert.equal(cancelled.state, "unknown");
    await second.runtime.cancel({
      cancelOperationId: "cancel-operation-1",
      testRunId: second.runInput.testRunId,
      operationId: "operation-1",
      adapter: cancelAdapter,
    });
    assert.equal(cancelCalls, 1);
    assert.equal(cancelReconciliations, 1);
    second.database.close();
    database.close();
  });

  it("rolls back Test worker state, audit, outbox, context, and receipt together", async () => {
    const fixture = openFixture(true, false, (point, commandId) => {
      if (point === "after-event" && commandId.endsWith(":intent")) {
        throw new Error("worker-receipt-crash");
      }
    });
    fixture.runtime.createRun(fixture.runInput);
    const beforeEvents = fixture.events!.latestSequence();

    await assert.rejects(
      fixture.runtime.execute({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter: {
          id: "scripted-test",
          execute: () => ({ state: "unknown" }),
          reconcile: () => ({ state: "unknown" }),
        },
      }),
      /worker-receipt-crash/,
    );

    assert.equal(
      fixture.database.prepare("SELECT 1 FROM test_execution_operations").get(),
      undefined,
    );
    assert.equal(fixture.events!.latestSequence(), beforeEvents);
    assert.equal(
      fixture.database
        .prepare(
          "SELECT 1 FROM runtime_audit_records WHERE actor_id = 'test-runtime'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      fixture.database
        .prepare(
          "SELECT 1 FROM command_deduplication WHERE consumer_id = 'test-runtime'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT 1 FROM runtime_unit_of_work_context")
        .get(),
      undefined,
    );
    fixture.database.close();
  });

  it("never resends a cancel after the effect may have happened", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: {
        id: "scripted-test",
        execute: () => ({ state: "running" }),
        reconcile: () => ({ state: "unknown" }),
      },
    });
    let cancelCalls = 0;
    let reconcileCalls = 0;
    const adapter = {
      id: "scripted-test",
      execute: () => ({ state: "unknown" as const }),
      cancel: () => {
        cancelCalls += 1;
        return { state: "unknown" as const };
      },
      reconcile: () => {
        reconcileCalls += 1;
        return { state: "unknown" as const };
      },
    };
    await assert.rejects(
      fixture.runtime.cancel({
        cancelOperationId: "cancel-after-effect",
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        adapter,
        failureInjection: (point) => {
          if (point === "after-cancel-effect") {
            throw new Error("cancel-crash-after-effect");
          }
        },
      }),
      /cancel-crash-after-effect/,
    );
    await fixture.runtime.cancel({
      cancelOperationId: "cancel-after-effect",
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(cancelCalls, 1);
    assert.equal(reconcileCalls, 1);
    fixture.database.close();
  });

  it("requires exact not-started proof before retrying a pre-effect cancel crash", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: {
        id: "scripted-test",
        execute: () => ({ state: "running" }),
        reconcile: () => ({ state: "unknown" }),
      },
    });
    let cancelCalls = 0;
    let reconcileCalls = 0;
    const adapter = {
      id: "scripted-test",
      execute: () => ({ state: "unknown" as const }),
      cancel: () => {
        cancelCalls += 1;
        return {
          state: "cancelled" as const,
          providerReceipt: { id: "cancelled-after-proof" },
          evidenceRef: "provider:cancelled-after-proof",
        };
      },
      reconcile: () => {
        reconcileCalls += 1;
        return {
          state: "not-started" as const,
          providerReceipt: { id: "cancel-not-started" },
          evidenceRef: "provider:cancel-not-started",
        };
      },
    };
    await assert.rejects(
      fixture.runtime.cancel({
        cancelOperationId: "cancel-before-effect",
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        adapter,
        failureInjection: (point) => {
          if (point === "after-cancel-intent") {
            throw new Error("cancel-crash-before-effect");
          }
        },
      }),
      /cancel-crash-before-effect/,
    );
    assert.equal(cancelCalls, 0);
    await fixture.runtime.cancel({
      cancelOperationId: "cancel-before-effect",
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(reconcileCalls, 1);
    assert.equal(cancelCalls, 0);
    const cancelled = await fixture.runtime.cancel({
      cancelOperationId: "cancel-before-effect",
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(cancelCalls, 1);
    assert.equal(cancelled.state, "cancelled");
    fixture.database.close();
  });

  it("keeps a paused Test operation out of start, resume, and PASS paths", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: {
        id: "scripted-test",
        execute: () => ({ state: "running" }),
        reconcile: () => ({ state: "unknown" }),
      },
    });
    let executeCalls = 0;
    const adapter = {
      id: "scripted-test",
      execute: () => {
        executeCalls += 1;
        return { state: "unknown" as const };
      },
      reconcile: () => ({ state: "unknown" as const }),
      cancel: () => ({
        state: "cancelled" as const,
        providerReceipt: { id: "paused-terminal" },
        evidenceRef: "provider:paused-terminal",
      }),
    };
    const paused = await fixture.runtime.cancel({
      cancelOperationId: "pause-operation-1",
      kind: "pause",
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(paused.state, "reconciling");
    const unchanged = await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });
    assert.equal(unchanged.state, "reconciling");
    assert.equal(executeCalls, 0);
    assert.throws(
      () => fixture.runtime.complete(fixture.runInput.testRunId),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_PASS_INCOMPLETE",
    );
    fixture.database.close();
  });

  it("atomically records a responsibility-preserving defect and obligation for terminal execution failure", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    const failed = await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: {
        id: "scripted-test",
        execute: () => ({
          state: "failed" as const,
          providerReceipt: { id: "failure-receipt" },
          evidenceRef: "execution-failure:operation-1",
          result: { code: "ASSERTION_FAILED" },
        }),
        reconcile: () => ({ state: "unknown" as const }),
      },
    });

    assert.equal(failed.state, "failed");
    assert.equal(failed.defects.length, 1);
    assert.equal(failed.defects[0]?.status, "open");
    assert.deepEqual(failed.defects[0]?.responsibility, {
      kind: "unknown",
      candidateWorkPackageVersionIds: ["package-1-v1"],
      reason:
        "Terminal Test execution failed before responsibility could be uniquely proven.",
    });
    assert.equal(failed.obligations.length, 1);
    assert.equal(failed.obligations[0]?.id, "test-obligation:operation-1");
    assert.equal(failed.obligations[0]?.status, "open");
    fixture.database.close();
  });

  it("reconciles crashes on both sides of the external effect without duplicating it", async () => {
    const beforeEffect = openFixture(true);
    beforeEffect.runtime.createRun(beforeEffect.runInput);
    let beforeExecutions = 0;
    const beforeAdapter = {
      id: "scripted-test",
      execute: () => {
        beforeExecutions += 1;
        return {
          state: "succeeded" as const,
          providerReceipt: { id: "receipt-before" },
          evidenceRef: "fact:before",
        };
      },
      reconcile: () => ({
        state: "not-started" as const,
        providerReceipt: { id: "not-started-before" },
        evidenceRef: "provider:not-started-before",
      }),
    };
    await assert.rejects(
      beforeEffect.runtime.execute({
        testRunId: beforeEffect.runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter: beforeAdapter,
        failureInjection: (point) => {
          if (point === "after-intent") throw new Error("crash-after-intent");
        },
      }),
      /crash-after-intent/,
    );
    assert.equal(beforeExecutions, 0);
    await beforeEffect.runtime.reconcile({
      testRunId: beforeEffect.runInput.testRunId,
      operationId: "operation-1",
      adapter: beforeAdapter,
    });
    assert.equal(
      (
        beforeEffect.events
          ?.readAfter(0, 100)
          .slice()
          .reverse()
          .find((event) => event.type === "test.run.reconciling")?.payload as
          | { readonly state?: string }
          | undefined
      )?.state,
      "reconciling",
    );
    const resumed = await beforeEffect.runtime.execute({
      testRunId: beforeEffect.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter: beforeAdapter,
    });
    assert.equal(resumed.state, "running");
    assert.equal(beforeExecutions, 1);

    const afterEffect = openFixture();
    afterEffect.runtime.createRun(afterEffect.runInput);
    let afterExecutions = 0;
    const afterAdapter = {
      id: "scripted-test",
      execute: () => {
        afterExecutions += 1;
        return {
          state: "succeeded" as const,
          providerReceipt: { id: "receipt-after" },
          evidenceRef: "fact:after",
        };
      },
      reconcile: () => ({
        state: "succeeded" as const,
        providerReceipt: { id: "receipt-after" },
        evidenceRef: "fact:after",
      }),
    };
    await assert.rejects(
      afterEffect.runtime.execute({
        testRunId: afterEffect.runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter: afterAdapter,
        failureInjection: (point) => {
          if (point === "after-effect") throw new Error("crash-after-effect");
        },
      }),
      /crash-after-effect/,
    );
    assert.equal(afterExecutions, 1);
    const reconciled = await afterEffect.runtime.reconcile({
      testRunId: afterEffect.runInput.testRunId,
      operationId: "operation-1",
      adapter: afterAdapter,
    });
    assert.equal(reconciled.state, "running");
    assert.equal(afterExecutions, 1);
    beforeEffect.database.close();
    afterEffect.database.close();
  });

  it("rejects stale Query correlation even when the Test Run view hash still matches", async () => {
    const fixture = openFixture(true);
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture);
    const correlation = trustedCorrelation(fixture, ["artifact-version-1"]);
    assert.throws(
      () =>
        fixture.runtime.recordAssertion({
          operationId: "operation-1",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          uiObserved: "passed",
          runtimeObserved: "passed",
          uiStatus: "passed",
          runtimeStatus: "passed",
          correlation: {
            ...correlation,
            queryAsOfSequence: correlation.queryAsOfSequence - 1,
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ASSERTION_CORRELATION_INVALID",
    );
    fixture.database.close();
  });

  it("materializes a terminal result against the exact acknowledged predecessor Query View", async () => {
    const fixture = openFixture(true);
    fixture.runtime.createRun(fixture.runInput);
    seedEvidenceArtifact(fixture, {
      id: "predecessor-view-artifact",
      contentHash: hash("4"),
      byteSize: 42,
      locator: "evidence/predecessor-view.json",
    });
    const adapter = {
      id: "scripted-test",
      execute: () => ({
        state: "accepted" as const,
        providerReceipt: { id: "accepted-receipt" },
      }),
      reconcile: () => {
        const acknowledged = fixture.runtime.inspect(
          fixture.runInput.testRunId,
        );
        assert.equal(acknowledged.state, "reconciling");
        const correlation = trustedCorrelation(
          fixture,
          ["predecessor-view-artifact"],
          fixture.runInput,
          "-predecessor-view",
        );
        assert.equal(correlation.queryViewHash, canonicalHash(acknowledged));
        return {
          state: "succeeded" as const,
          providerReceipt: { id: "terminal-receipt" },
          selectedQueryView: selectedQueryView(fixture, correlation),
          result: {
            schemaVersion: 1 as const,
            assertions: [
              {
                testCaseRevisionId: fixture.revision.id,
                assertionId: "assertion-1",
                uiObserved: "passed",
                runtimeObserved: "passed",
                uiStatus: "passed" as const,
                runtimeStatus: "passed" as const,
                correlation,
              },
            ],
            evidence: [],
          },
        };
      },
    };
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });

    const reconciled = await fixture.runtime.reconcile({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });

    assert.equal(reconciled.executions[0]?.state, "succeeded");
    assert.equal(reconciled.assertions[0]?.uiStatus, "passed");
    assert.equal(reconciled.assertions[0]?.runtimeStatus, "passed");
    fixture.database.close();
  });

  it("rejects an older same-View token when the adapter selected a different acknowledged token", async () => {
    const fixture = openFixture(true);
    fixture.runtime.createRun(fixture.runInput);
    seedEvidenceArtifact(fixture, {
      id: "same-view-artifact",
      contentHash: hash("4"),
      byteSize: 42,
      locator: "evidence/same-view.json",
    });
    const adapter = {
      id: "scripted-test",
      execute: () => ({
        state: "accepted" as const,
        providerReceipt: { id: "accepted-receipt" },
      }),
      reconcile: () => {
        const older = trustedCorrelation(
          fixture,
          ["same-view-artifact"],
          fixture.runInput,
          "-same-view-older",
        );
        const selected = trustedCorrelation(
          fixture,
          ["same-view-artifact"],
          fixture.runInput,
          "-same-view-selected",
        );
        assert.equal(older.queryViewHash, selected.queryViewHash);
        return {
          state: "succeeded" as const,
          providerReceipt: { id: "terminal-receipt" },
          selectedQueryView: selectedQueryView(fixture, selected),
          result: {
            schemaVersion: 1 as const,
            assertions: [
              {
                testCaseRevisionId: fixture.revision.id,
                assertionId: "assertion-1",
                uiObserved: "passed",
                runtimeObserved: "passed",
                uiStatus: "passed" as const,
                runtimeStatus: "passed" as const,
                correlation: older,
              },
            ],
            evidence: [],
          },
        };
      },
    };
    await fixture.runtime.execute({
      testRunId: fixture.runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });

    await assert.rejects(
      fixture.runtime.reconcile({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        adapter,
      }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ASSERTION_CORRELATION_INVALID",
    );
    fixture.database.close();
  });

  it("binds assertion correlation to the exact Test Run Query, consumer, principal, ack receipt, and current View", async () => {
    const corruptions = [
      {
        label: "query",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) =>
          fixture.database
            .prepare(
              "UPDATE consumed_view_sync_tokens SET query_hash = ? WHERE token_hash = ?",
            )
            .run(hash("0"), tokenHash),
      },
      {
        label: "consumer",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) =>
          fixture.database
            .prepare(
              "UPDATE consumed_view_sync_tokens SET consumer_id = 'other-consumer' WHERE token_hash = ?",
            )
            .run(tokenHash),
      },
      {
        label: "principal",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) =>
          fixture.database
            .prepare(
              "UPDATE consumed_view_sync_tokens SET principal_hash = ? WHERE token_hash = ?",
            )
            .run(hash("1"), tokenHash),
      },
      {
        label: "ack receipt",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) =>
          fixture.database
            .prepare(
              "UPDATE consumed_view_sync_tokens SET command_id = 'missing-ack-receipt' WHERE token_hash = ?",
            )
            .run(tokenHash),
      },
      {
        label: "ack audit",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) => {
          const row = fixture.database
            .prepare(
              "SELECT command_id AS commandId FROM consumed_view_sync_tokens WHERE token_hash = ?",
            )
            .get(tokenHash) as { readonly commandId: string };
          return fixture.database
            .prepare(
              "UPDATE runtime_audit_records SET action = 'tampered' WHERE command_id = ?",
            )
            .run(row.commandId);
        },
      },
      {
        label: "current View",
        apply: (fixture: ReturnType<typeof openFixture>, tokenHash: string) =>
          fixture.database
            .prepare(
              "UPDATE consumed_view_sync_tokens SET view_hash = ? WHERE token_hash = ?",
            )
            .run(hash("2"), tokenHash),
        correlationViewHash: hash("2"),
      },
    ] as const;
    for (const corruption of corruptions) {
      const fixture = openFixture(true);
      fixture.runtime.createRun(fixture.runInput);
      await succeedRequiredExecution(fixture);
      const correlation = trustedCorrelation(
        fixture,
        [],
        fixture.runInput,
        `-binding-${corruption.label}`,
      );
      corruption.apply(fixture, correlation.viewSyncTokenHash);
      assert.throws(
        () =>
          fixture.runtime.recordAssertion({
            operationId: "operation-1",
            testRunId: fixture.runInput.testRunId,
            testCaseRevisionId: fixture.revision.id,
            assertionId: "assertion-1",
            uiObserved: "passed",
            runtimeObserved: "passed",
            uiStatus: "passed",
            runtimeStatus: "passed",
            correlation: {
              ...correlation,
              queryViewHash:
                "correlationViewHash" in corruption
                  ? corruption.correlationViewHash
                  : correlation.queryViewHash,
            },
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_ASSERTION_CORRELATION_INVALID",
        corruption.label,
      );
      fixture.database.close();
    }
  });

  it("rejects replay of a tampered trusted worker receipt before another adapter call", async () => {
    const corruptions = [
      "actor",
      "consumer",
      "result-hash",
      "effect-ids",
      "audit-context",
    ] as const;
    for (const corruption of corruptions) {
      const fixture = openFixture();
      fixture.runtime.createRun(fixture.runInput);
      const adapter = {
        id: "scripted-test",
        execute: () => ({ state: "accepted" as const }),
        reconcile: () => ({ state: "unknown" as const }),
      };
      await fixture.runtime.execute({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter,
      });
      await fixture.runtime.reconcile({
        testRunId: fixture.runInput.testRunId,
        operationId: "operation-1",
        adapter,
      });
      const receipt = fixture.database
        .prepare(
          "SELECT command_id AS commandId FROM command_deduplication WHERE command_id LIKE '%:reconcile-intent'",
        )
        .get() as { readonly commandId: string };
      if (corruption === "actor") {
        fixture.database
          .prepare(
            "UPDATE command_deduplication SET actor_id = 'tampered' WHERE command_id = ?",
          )
          .run(receipt.commandId);
      } else if (corruption === "consumer") {
        fixture.database
          .prepare(
            "UPDATE command_deduplication SET consumer_id = 'tampered' WHERE command_id = ?",
          )
          .run(receipt.commandId);
      } else if (corruption === "result-hash") {
        fixture.database
          .prepare(
            "UPDATE command_deduplication SET result_hash = ? WHERE command_id = ?",
          )
          .run(hash("0"), receipt.commandId);
      } else if (corruption === "effect-ids") {
        fixture.database
          .prepare(
            "UPDATE command_deduplication SET effect_ids_json = '[]' WHERE command_id = ?",
          )
          .run(receipt.commandId);
      } else {
        fixture.database
          .prepare(
            "UPDATE runtime_audit_records SET actor_id = 'tampered' WHERE command_id = ?",
          )
          .run(receipt.commandId);
      }

      await assert.rejects(
        fixture.runtime.reconcile({
          testRunId: fixture.runInput.testRunId,
          operationId: "operation-1",
          adapter,
        }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_WORKER_RECEIPT_INVALID",
        corruption,
      );
      fixture.database.close();
    }
  });

  it("tracks discriminated defect responsibility, immutable resolution, and fresh rerun authority", async () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    await succeedRequiredExecution(fixture);
    seedEvidenceArtifact(fixture, {
      id: "fix-evidence-1",
      contentHash: hash("b"),
      byteSize: 42,
      locator: "evidence/fix.json",
    });
    seedEvidenceArtifact(fixture, {
      id: "fix-ui-evidence-1",
      contentHash: hash("c"),
      byteSize: 42,
      locator: "evidence/fix.png",
    });
    const failedCorrelation = trustedCorrelation(fixture, [
      "fix-ui-evidence-1",
      "fix-evidence-1",
    ]);
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: "failed",
      uiStatus: "passed",
      runtimeStatus: "failed",
      correlation: failedCorrelation,
    });
    fixture.runtime.recordEvidence({
      id: "fix-evidence-1",
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      kind: "runtime",
      mediaType: "application/json",
      contentHash: hash("b"),
      byteSize: 42,
      artifactVersionId: "fix-evidence-1",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/fix.json",
      metadata: {},
    });
    fixture.runtime.recordEvidence({
      id: "fix-ui-evidence-1",
      operationId: "operation-1",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      kind: "screenshot",
      mediaType: "image/png",
      contentHash: hash("c"),
      byteSize: 42,
      artifactVersionId: "fix-ui-evidence-1",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/fix.png",
      metadata: {},
    });
    const failedAssertion = fixture.runtime
      .inspect(fixture.runInput.testRunId)
      .assertions.find((entry) => entry.assertionId === "assertion-1")!;
    const responsibilities = [
      {
        kind: "work-package" as const,
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
      },
      {
        kind: "contract" as const,
        contractId: "contract-1",
        version: "1",
        producerApplicationId: "app-api",
        consumerApplicationId: "app-web",
        candidateWorkPackageVersionIds: ["package-1-v1"],
      },
      {
        kind: "aggregate" as const,
        candidateWorkPackageVersionIds: ["package-1-v1"],
      },
      {
        kind: "unknown" as const,
        candidateWorkPackageVersionIds: ["package-1-v1"],
        reason: "Evidence cannot uniquely attribute the mismatch.",
      },
    ];
    responsibilities.forEach((responsibility, index) => {
      fixture.runtime.recordDefect({
        id: `defect-${index + 1}`,
        testRunId: fixture.runInput.testRunId,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        responsibility,
        evidence: {
          schemaVersion: 1,
          kind: "assertion",
          assertion: {
            testCaseRevisionId: fixture.revision.id,
            assertionId: "assertion-1",
            resultHash: failedAssertion.resultHash,
          },
          evidenceRefs: ["fix-evidence-1", "fix-ui-evidence-1"],
        },
      });
    });
    for (const responsibility of [
      {
        kind: "work-package" as const,
        workPackageId: "missing-package",
        workPackageVersionId: "missing-package-v1",
      },
      {
        kind: "contract" as const,
        contractId: "missing-contract",
        version: "1",
        producerApplicationId: "app-api",
        consumerApplicationId: "app-web",
        candidateWorkPackageVersionIds: ["package-1-v1"],
      },
    ]) {
      assert.throws(
        () =>
          fixture.runtime.recordDefect({
            id: `invalid-responsibility-${responsibility.kind}`,
            testRunId: fixture.runInput.testRunId,
            testCaseRevisionId: fixture.revision.id,
            assertionId: "assertion-1",
            responsibility,
            evidence: {
              schemaVersion: 1,
              kind: "assertion",
              assertion: {
                testCaseRevisionId: fixture.revision.id,
                assertionId: "assertion-1",
                resultHash: failedAssertion.resultHash,
              },
              evidenceRefs: ["fix-evidence-1"],
            },
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_DEFECT_RESPONSIBILITY_INVALID",
      );
    }
    assert.throws(
      () =>
        fixture.runtime.recordDefect({
          id: "defect-outside-frozen-scope",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "missing-assertion",
          responsibility: responsibilities[0]!,
          evidence: {
            schemaVersion: 1,
            kind: "assertion",
            assertion: {
              testCaseRevisionId: fixture.revision.id,
              assertionId: "missing-assertion",
              resultHash: failedAssertion.resultHash,
            },
            evidenceRefs: ["fix-evidence-1"],
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_SCOPE_INVALID",
    );
    assert.throws(
      () =>
        fixture.runtime.closeDefect({
          defectId: "defect-1",
          resolutionId: "resolution-without-evidence",
          resolution: {} as never,
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_RESOLUTION_INVALID",
    );
    assert.equal(
      fixture.runtime.complete(fixture.runInput.testRunId).state,
      "failed",
    );
    const passingRerun = await completeFreshPassingRun(
      fixture,
      "9",
      "defect-1",
    );
    const passingAssertion = passingRerun.assertions.find(
      (entry) => entry.assertionId === "assertion-1",
    )!;
    const resolution = {
      schemaVersion: 1 as const,
      resolvedByTestRunId: passingRerun.id,
      passAuthorityHash: passingRerun.passAuthorityHash!,
      assertions: [
        {
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          resultHash: passingAssertion.resultHash,
          evidenceRefs: [
            "pass-runtime-9",
            "pass-runtime-evidence-9",
            "pass-ui-9",
            "pass-ui-evidence-9",
          ],
        },
      ],
    };
    assert.throws(
      () =>
        fixture.runtime.closeDefect({
          defectId: "defect-1",
          resolutionId: "resolution-forged-pass",
          resolution: {
            ...resolution,
            passAuthorityHash: hash("0"),
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_RESOLUTION_EVIDENCE_INVALID",
    );
    const resolvedPrior = fixture.runtime.inspect(fixture.runInput.testRunId);
    assert.equal(
      resolvedPrior.defects.every((defect) => defect.status === "closed"),
      true,
    );
    assert.equal(
      resolvedPrior.obligations.every(
        (obligation) => obligation.status === "closed",
      ),
      true,
    );
    const automaticResolutionId = `test-resolution:${passingRerun.reworkLineage!.id}:defect-1`;
    assert.deepEqual(
      fixture.runtime.closeDefect({
        defectId: "defect-1",
        resolutionId: automaticResolutionId,
        resolution,
      }),
      resolvedPrior,
    );
    assert.throws(
      () =>
        fixture.runtime.closeDefect({
          defectId: "defect-1",
          resolutionId: "resolution-duplicate",
          resolution,
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_RESOLUTION_CONFLICT",
    );
    assert.throws(
      () =>
        fixture.runtime.createRun({
          ...fixture.runInput,
          testRunId: "test-run-code-change",
          requestId: "request-code-change",
          integrationAuthority: {
            ...fixture.runInput.integrationAuthority,
            repositoryCommits: [
              { repositoryReference: "repo-a", commit: commit("3") },
            ],
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "INTEGRATION_AUTHORITY_INELIGIBLE",
    );
    fixture.database.close();
  });

  it("freezes explicit renamed successor mappings and resolves the complete related rework scope", async () => {
    const fixture = openFixture();
    const failed = await prepareFailedAssertion(fixture, "mapped-scope");
    fixture.runtime.recordDefect({
      id: "related-defect",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      responsibility: {
        kind: "ui-runtime-contract",
        owner: "shared",
      },
      evidence: {
        schemaVersion: 1,
        kind: "assertion",
        assertion: {
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          resultHash: failed.assertion.resultHash,
        },
        evidenceRefs: failed.evidenceRefs,
      },
    });
    const prior = fixture.runtime.complete(fixture.runInput.testRunId);
    const automaticDefectId = `test-defect:assertion:${prior.id}:${canonicalHash(
      {
        schemaVersion: 1,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
      },
    )}`;
    assert.deepEqual(
      prior.defects.map((defect) => defect.id).sort(),
      [automaticDefectId, "related-defect"].sort(),
    );

    const renamedRevision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-1-r2-renamed",
      supersedesRevisionId: fixture.revision.id,
      manifest: {
        ...fixture.revisionInput.manifest,
        assertions: [
          {
            id: "assertion-renamed",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "test-run-state", expected: "passed" },
          },
        ],
      },
    });
    const unrelatedRevision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      testCaseId: "unrelated-case",
      revisionId: "unrelated-case-r1",
    });
    seedFreshTestAttempt(fixture, "mapped-scope");
    const baseInput = {
      ...fixture.runInput,
      testRunId: "test:run-1:test-node-mapped-scope",
      requestId: "request-mapped-scope",
      nodeRunId: "test-node-mapped-scope",
      nodeAttemptId: "test-attempt-mapped-scope",
      sessionId: "test-session-mapped-scope",
    };
    const scopedDefectIds = [automaticDefectId, "related-defect"];
    const mappings = scopedDefectIds.map((defectId) => ({
      defectId,
      nextTestCaseRevisionId: renamedRevision.id,
      nextAssertionId: "assertion-renamed",
    }));
    const partialRequest = {
      defectId: "related-defect",
      input: {
        ...baseInput,
        testCaseRevisions: [
          { id: renamedRevision.id, hash: renamedRevision.manifestHash },
        ],
        risk: testRiskInput([renamedRevision.id]),
      },
      successorAssertions: mappings.slice(0, 1),
    };
    assert.throws(
      () => fixture.runtime.createReworkRun(partialRequest),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_REWORK_MAPPING_INVALID",
    );
    const unrelatedRequest = {
      ...partialRequest,
      input: {
        ...baseInput,
        testCaseRevisions: [
          { id: unrelatedRevision.id, hash: unrelatedRevision.manifestHash },
        ],
        risk: testRiskInput([unrelatedRevision.id]),
      },
      successorAssertions: scopedDefectIds.map((defectId) => ({
        defectId,
        nextTestCaseRevisionId: unrelatedRevision.id,
        nextAssertionId: "assertion-1",
      })),
    };
    assert.throws(
      () => fixture.runtime.createReworkRun(unrelatedRequest),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_REWORK_MAPPING_INVALID",
    );

    const created = fixture.runtime.createReworkRun({
      ...partialRequest,
      successorAssertions: mappings,
    });
    assert.deepEqual(
      created.run.reworkLineage?.lineage.successorAssertions,
      mappings
        .map((mapping) => ({
          ...mapping,
          priorTestRunId: prior.id,
          priorIntegrationGenerationId:
            prior.manifest.integrationAuthority.generationId,
          priorTestCaseRevisionId: fixture.revision.id,
          priorAssertionId: "assertion-1",
          priorResultHash: failed.assertion.resultHash,
          responsibilityRoute:
            mapping.defectId === "related-defect"
              ? {
                  destination: "ui-runtime-contract" as const,
                  owner: "shared" as const,
                }
              : {
                  destination: "ui-runtime-contract" as const,
                  owner: "runtime" as const,
                },
        }))
        .sort((left, right) => left.defectId.localeCompare(right.defectId)),
    );
    assert.deepEqual(
      created.run.reworkLineage?.lineage.scope.defectIds,
      scopedDefectIds.sort(),
    );
    await succeedRequiredExecution(fixture, partialRequest.input);
    for (const [id, kind, mediaType, contentHash] of [
      ["mapped-pass-ui", "screenshot", "image/png", hash("4")],
      ["mapped-pass-runtime", "runtime", "application/json", hash("5")],
    ] as const) {
      seedEvidenceArtifact(fixture, {
        id,
        contentHash,
        byteSize: 42,
        locator: `evidence/${id}`,
      });
      fixture.runtime.recordEvidence({
        id,
        operationId: "operation-1",
        testRunId: created.run.id,
        testCaseRevisionId: renamedRevision.id,
        assertionId: "assertion-renamed",
        kind,
        mediaType,
        contentHash,
        byteSize: 42,
        artifactVersionId: id,
        redactionProfile: "default",
        retentionClass: "durable",
        locator: `evidence/${id}`,
        metadata: {},
      });
    }
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: created.run.id,
      testCaseRevisionId: renamedRevision.id,
      assertionId: "assertion-renamed",
      uiObserved: "passed",
      runtimeObserved: "passed",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: trustedCorrelation(
        fixture,
        ["mapped-pass-ui", "mapped-pass-runtime"],
        partialRequest.input,
        "-mapped-pass",
      ),
    });

    const passed = fixture.runtime.complete(created.run.id);

    assert.equal(passed.state, "passed");
    const resolvedPrior = fixture.runtime.inspect(prior.id);
    assert.equal(
      resolvedPrior.defects.every((defect) => defect.status === "closed"),
      true,
    );
    assert.equal(
      resolvedPrior.obligations.every(
        (obligation) => obligation.status === "closed",
      ),
      true,
    );
    assert.equal(
      fixture.runtime.downstreamAuthority(passed.id).testRunId,
      passed.id,
    );
    fixture.database.close();
  });

  it("recursively freezes and resolves ancestor and current rework scope with each responsibility route", async () => {
    const fixture = openFixture();
    const failed = await prepareFailedAssertion(fixture, "recursive-base");
    fixture.runtime.recordDefect({
      id: "ancestor-work-package-defect",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      responsibility: {
        kind: "work-package",
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
      },
      evidence: {
        schemaVersion: 1,
        kind: "assertion",
        assertion: {
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          resultHash: failed.assertion.resultHash,
        },
        evidenceRefs: failed.evidenceRefs,
      },
    });
    const base = fixture.runtime.complete(fixture.runInput.testRunId);
    const baseDefectIds = base.defects.map((defect) => defect.id).sort();
    const revision2 = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-recursive-r2",
      supersedesRevisionId: fixture.revision.id,
    });
    seedFreshTestAttempt(fixture, "recursive-r2");
    const firstInput = {
      ...fixture.runInput,
      testRunId: "test:run-1:test-node-recursive-r2",
      requestId: "request-recursive-r2",
      nodeRunId: "test-node-recursive-r2",
      nodeAttemptId: "test-attempt-recursive-r2",
      sessionId: "test-session-recursive-r2",
      testCaseRevisions: [{ id: revision2.id, hash: revision2.manifestHash }],
      risk: testRiskInput([revision2.id]),
    };
    const first = fixture.runtime.createReworkRun({
      defectId: "ancestor-work-package-defect",
      input: firstInput,
      successorAssertions: baseDefectIds.map((defectId) => ({
        defectId,
        nextTestCaseRevisionId: revision2.id,
        nextAssertionId: "assertion-1",
      })),
    });
    await succeedRequiredExecution(fixture, firstInput);
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: first.run.id,
      testCaseRevisionId: revision2.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: "failed",
      uiStatus: "passed",
      runtimeStatus: "failed",
      correlation: trustedCorrelation(fixture, [], firstInput, "-recursive-r2"),
    });
    const firstFailed = fixture.runtime.complete(first.run.id);
    const currentDefectId = firstFailed.defects[0]!.id;
    const revision3 = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-recursive-r3",
      supersedesRevisionId: revision2.id,
    });
    seedFreshTestAttempt(fixture, "recursive-r3");
    const secondInput = {
      ...fixture.runInput,
      testRunId: "test:run-1:test-node-recursive-r3",
      requestId: "request-recursive-r3",
      nodeRunId: "test-node-recursive-r3",
      nodeAttemptId: "test-attempt-recursive-r3",
      sessionId: "test-session-recursive-r3",
      testCaseRevisions: [{ id: revision3.id, hash: revision3.manifestHash }],
      risk: testRiskInput([revision3.id]),
    };
    const recursiveDefectIds = [...baseDefectIds, currentDefectId].sort();

    const second = fixture.runtime.createReworkRun({
      defectId: currentDefectId,
      input: secondInput,
      successorAssertions: recursiveDefectIds.map((defectId) => ({
        defectId,
        nextTestCaseRevisionId: revision3.id,
        nextAssertionId: "assertion-1",
      })),
    });

    assert.deepEqual(second.lineage.scope.defectIds, recursiveDefectIds);
    const routes = new Map(
      second.lineage.successorAssertions.map((mapping) => [
        mapping.defectId,
        mapping.responsibilityRoute,
      ]),
    );
    assert.equal(
      routes.get("ancestor-work-package-defect")?.destination,
      "work-package",
    );
    assert.equal(
      routes.get(currentDefectId)?.destination,
      "ui-runtime-contract",
    );

    await succeedRequiredExecution(fixture, secondInput);
    const evidenceIds = [
      ["recursive-pass-ui", "screenshot", "image/png", hash("4")],
      ["recursive-pass-runtime", "runtime", "application/json", hash("5")],
    ] as const;
    for (const [id, kind, mediaType, contentHash] of evidenceIds) {
      seedEvidenceArtifact(fixture, {
        id,
        contentHash,
        byteSize: 42,
        locator: `evidence/${id}`,
      });
      fixture.runtime.recordEvidence({
        id,
        operationId: "operation-1",
        testRunId: second.run.id,
        testCaseRevisionId: revision3.id,
        assertionId: "assertion-1",
        kind,
        mediaType,
        contentHash,
        byteSize: 42,
        artifactVersionId: id,
        redactionProfile: "default",
        retentionClass: "durable",
        locator: `evidence/${id}`,
        metadata: {},
      });
    }
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: second.run.id,
      testCaseRevisionId: revision3.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: "passed",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: trustedCorrelation(
        fixture,
        evidenceIds.map(([id]) => id),
        secondInput,
        "-recursive-r3",
      ),
    });

    const passed = fixture.runtime.complete(second.run.id);

    assert.equal(passed.state, "passed");
    assert.equal(
      recursiveDefectIds.every(
        (defectId) =>
          fixture.runtime
            .inspect(
              defectId === currentDefectId
                ? first.run.id
                : fixture.runInput.testRunId,
            )
            .defects.find((defect) => defect.id === defectId)?.status ===
          "closed",
      ),
      true,
    );
    assert.equal(
      fixture.runtime.downstreamAuthority(passed.id).testRunId,
      passed.id,
    );
    fixture.database.close();
  });

  it("preserves related Test defect lineage across fresh Integration Generations", async () => {
    const fixture = openFixture();
    const failed = await prepareFailedAssertion(fixture, "cross-generation");
    fixture.runtime.recordDefect({
      id: "cross-generation-defect",
      testRunId: fixture.runInput.testRunId,
      testCaseRevisionId: fixture.revision.id,
      assertionId: "assertion-1",
      responsibility: {
        kind: "work-package",
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
      },
      evidence: {
        schemaVersion: 1,
        kind: "assertion",
        assertion: {
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          resultHash: failed.assertion.resultHash,
        },
        evidenceRefs: failed.evidenceRefs,
      },
    });
    const prior = fixture.runtime.complete(fixture.runInput.testRunId);
    const priorDefectIds = prior.defects.map((defect) => defect.id).sort();

    const freshGeneration = {
      ...fixture.generation,
      id: "generation-2",
      manifest: {
        ...fixture.generation.manifest,
        generationId: "generation-2",
        generation: 2,
        repositories: fixture.generation.manifest.repositories.map(
          (repository) => ({
            ...repository,
            integrationBranch: "integration/run-1/g2",
          }),
        ),
        packages: fixture.generation.manifest.packages.map((entry) => ({
          ...entry,
          sourceCommit: commit("3"),
          authorityId: "code-authority-2",
          qualityGateResultId: "code-gate-2",
        })),
      },
      manifestHash: hash("1"),
      repositoryResults: fixture.generation.repositoryResults.map((entry) => ({
        ...entry,
        id: "repository-result-2",
        integrationBranch: "integration/run-1/g2",
        integratedCommit: commit("3"),
      })),
      aggregateReview: {
        ...fixture.generation.aggregateReview!,
        id: "aggregate-review-2",
        qualityGateResultId: "gate-2",
      },
      passAuthorityHash: hash("2"),
    } as IntegrationGenerationView;
    fixture.generations.set(freshGeneration.id, freshGeneration);
    fixture.database
      .prepare(
        `INSERT INTO artifact_versions(
           id, artifact_id, version, content_ref, content_hash, byte_size,
           status, producing_run_id, snapshot_revision_id,
           producer_context_json, created_at
         ) VALUES ('build-2', 'build-artifact', 2, 'artifacts/build-2.tar', ?,
                   42, 'accepted', 'run-1', 'snapshot-1', ?, ?)`,
      )
      .run(
        hash("0"),
        JSON.stringify({
          projectId: "project-1",
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          nodeRunId: "integration-node-2",
          nodeAttemptId: "integration-attempt-2",
          aiMemberId: "builder-ai",
          integrationAuthority: {
            generationId: freshGeneration.id,
            manifestHash: freshGeneration.manifestHash,
            passAuthorityHash: freshGeneration.passAuthorityHash!,
            repositoryCommits: [
              { repositoryReference: "repo-a", commit: commit("3") },
            ],
          },
        }),
        "2026-07-29T00:00:00.000Z",
      );
    const revision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-cross-generation-r2",
      supersedesRevisionId: fixture.revision.id,
    });
    seedFreshTestAttempt(fixture, "cross-generation");
    const freshInput = {
      ...fixture.runInput,
      testRunId: "test:run-1:test-node-cross-generation",
      requestId: "request-cross-generation",
      nodeRunId: "test-node-cross-generation",
      nodeAttemptId: "test-attempt-cross-generation",
      sessionId: "test-session-cross-generation",
      testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
      integrationAuthority: {
        generationId: freshGeneration.id,
        manifestHash: freshGeneration.manifestHash,
        passAuthorityHash: freshGeneration.passAuthorityHash!,
        repositoryCommits: [
          { repositoryReference: "repo-a", commit: commit("3") },
        ],
      },
      build: { artifactVersionId: "build-2", digest: hash("0") },
      risk: testRiskInput([revision.id]),
    };

    assert.throws(
      () => fixture.runtime.createRun(freshInput),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_REWORK_COMMAND_REQUIRED",
    );
    const rework = fixture.runtime.createReworkRun({
      defectId: "cross-generation-defect",
      input: freshInput,
      successorAssertions: [
        ...priorDefectIds.map((defectId) => ({
          defectId,
          nextTestCaseRevisionId: revision.id,
          nextAssertionId: "assertion-1",
        })),
      ],
    });

    assert.equal(rework.lineage.integrationAuthority, "fresh-pass-authority");
    assert.equal(
      rework.lineage.nextIntegrationGenerationId,
      freshGeneration.id,
    );
    assert.deepEqual(rework.lineage.scope.defectIds, priorDefectIds);
    assert.deepEqual(
      rework.lineage.scope.obligationIds,
      prior.obligations.map((obligation) => obligation.id).sort(),
    );
    assert.deepEqual(
      rework.run.manifest.integrationAuthority,
      freshInput.integrationAuthority,
    );
    assert.match(rework.run.reworkLineage!.lineageHash, /^[a-f0-9]{64}$/);
    await succeedRequiredExecution(fixture, freshInput);
    for (const [id, kind, mediaType, contentHash] of [
      ["cross-generation-pass-ui", "screenshot", "image/png", hash("4")],
      [
        "cross-generation-pass-runtime",
        "runtime",
        "application/json",
        hash("5"),
      ],
    ] as const) {
      seedEvidenceArtifact(fixture, {
        id,
        contentHash,
        byteSize: 42,
        locator: `evidence/${id}`,
      });
      fixture.runtime.recordEvidence({
        id,
        operationId: "operation-1",
        testRunId: rework.run.id,
        testCaseRevisionId: revision.id,
        assertionId: "assertion-1",
        kind,
        mediaType,
        contentHash,
        byteSize: 42,
        artifactVersionId: id,
        redactionProfile: "default",
        retentionClass: "durable",
        locator: `evidence/${id}`,
        metadata: {},
      });
    }
    fixture.runtime.recordAssertion({
      operationId: "operation-1",
      testRunId: rework.run.id,
      testCaseRevisionId: revision.id,
      assertionId: "assertion-1",
      uiObserved: "passed",
      runtimeObserved: "passed",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: trustedCorrelation(
        fixture,
        ["cross-generation-pass-ui", "cross-generation-pass-runtime"],
        freshInput,
        "-cross-generation-pass",
      ),
    });

    const passed = fixture.runtime.complete(rework.run.id);

    const resolvedPrior = fixture.runtime.inspect(prior.id);
    assert.equal(
      resolvedPrior.defects.every((defect) => defect.status === "closed"),
      true,
    );
    assert.equal(
      resolvedPrior.obligations.every(
        (obligation) => obligation.status === "closed",
      ),
      true,
    );
    assert.equal(
      fixture.runtime.downstreamAuthority(passed.id).testRunId,
      passed.id,
    );
    fixture.database.close();
  });

  it("routes persisted Test defect responsibility and enforces fresh rework lineage", async () => {
    const scenarios = [
      {
        responsibility: {
          kind: "work-package" as const,
          workPackageId: "package-1",
          workPackageVersionId: "package-1-v1",
        },
        destination: "work-package",
      },
      {
        responsibility: {
          kind: "contract" as const,
          contractId: "contract-1",
          version: "1",
          producerApplicationId: "app-api",
          consumerApplicationId: "app-web",
          candidateWorkPackageVersionIds: ["package-1-v1"],
        },
        destination: "contract",
      },
      {
        responsibility: {
          kind: "aggregate" as const,
          candidateWorkPackageVersionIds: ["package-1-v1"],
        },
        destination: "triage",
      },
      {
        responsibility: {
          kind: "unknown" as const,
          candidateWorkPackageVersionIds: ["package-1-v1"],
          reason: "Evidence cannot uniquely attribute the mismatch.",
        },
        destination: "triage",
      },
      {
        responsibility: {
          kind: "ui-runtime-contract" as const,
          owner: "runtime" as const,
        },
        destination: "ui-runtime-contract",
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const fixture = openFixture();
      const failed = await prepareFailedAssertion(fixture, String(index));
      const prior = fixture.runtime.inspect(fixture.runInput.testRunId);
      fixture.runtime.recordDefect({
        id: `rework-defect-${index}`,
        testRunId: prior.id,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        responsibility: scenario.responsibility,
        evidence: {
          schemaVersion: 1,
          kind: "assertion",
          assertion: {
            testCaseRevisionId: fixture.revision.id,
            assertionId: "assertion-1",
            resultHash: failed.assertion.resultHash,
          },
          evidenceRefs: failed.evidenceRefs,
        },
      });
      fixture.database
        .prepare("UPDATE test_runs SET state = 'failed' WHERE id = ?")
        .run(prior.id);
      const revision = fixture.runtime.registerCaseRevision({
        ...fixture.revisionInput,
        revisionId: `case-1-r${index + 2}`,
        supersedesRevisionId: fixture.revision.id,
        manifest: {
          ...fixture.revisionInput.manifest,
          fixture: {
            id: `fixture-${index + 2}`,
            scriptHashes: [String(index + 2).repeat(64)],
          },
        },
      });
      const suffix = String(index + 2);
      fixture.fixtureAuthorities.set(`fixture-${suffix}`, {
        fixtureId: `fixture-${suffix}`,
        companyDirectoryFingerprint: hash("2"),
        scriptHashes: [suffix.repeat(64)],
        adapterIds: ["scripted-test"],
      });
      seedFreshTestAttempt(fixture, suffix);
      const nextRun = {
        ...fixture.runInput,
        testRunId: `test:run-1:test-node-${suffix}`,
        requestId: `request-rework-${suffix}`,
        nodeRunId: `test-node-${suffix}`,
        nodeAttemptId: `test-attempt-${suffix}`,
        sessionId: `test-session-${suffix}`,
        testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
        fixture: revision.manifest.fixture,
        risk: testRiskInput([revision.id]),
      };
      const freshGeneration = {
        ...fixture.generation,
        id: `generation-fresh-${suffix}`,
        manifest: {
          ...fixture.generation.manifest,
          generationId: `generation-fresh-${suffix}`,
          generation: index + 2,
          packages: fixture.generation.manifest.packages.map((entry) => ({
            ...entry,
            workPackageVersionId: `package-1-v${index + 2}`,
          })),
          contractVersions: fixture.generation.manifest.contractVersions.map(
            (contract) => ({ ...contract, version: String(index + 2) }),
          ),
        },
        manifestHash: String(index + 3).repeat(64),
        passAuthorityHash: String(index + 4).repeat(64),
      } as IntegrationGenerationView;
      fixture.generations.set(freshGeneration.id, freshGeneration);
      assert.throws(
        () =>
          fixture.runtime.createRun({
            ...nextRun,
            integrationAuthority: {
              ...nextRun.integrationAuthority,
              generationId: freshGeneration.id,
              manifestHash: freshGeneration.manifestHash,
              passAuthorityHash: freshGeneration.passAuthorityHash!,
            },
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_REWORK_COMMAND_REQUIRED",
      );
      assert.throws(
        () => fixture.runtime.createRun(nextRun),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_REWORK_COMMAND_REQUIRED",
      );
      const rework = fixture.runtime.createReworkRun({
        defectId: `rework-defect-${index}`,
        input: nextRun,
        successorAssertions: [
          {
            defectId: `rework-defect-${index}`,
            nextTestCaseRevisionId: revision.id,
            nextAssertionId: "assertion-1",
          },
        ],
      });

      assert.equal(rework.route.destination, scenario.destination);
      assert.equal(rework.lineage.integrationAuthority, "reuse-exact-pass");
      assert.equal(rework.lineage.priorTestRunId, prior.id);
      assert.equal(rework.run.id, nextRun.testRunId);
      assert.deepEqual(
        fixture.runtime.inspect(nextRun.testRunId).reworkLineage?.lineage,
        rework.lineage,
      );
      assert.equal(
        fixture.runtime.inspect(prior.id).manifestHash,
        prior.manifestHash,
      );

      assert.throws(
        () =>
          fixture.runtime.createReworkRun({
            defectId: `rework-defect-${index}`,
            input: {
              ...nextRun,
              testRunId: `${nextRun.testRunId}-code-change`,
              requestId: `${nextRun.requestId}-code-change`,
              integrationAuthority: {
                ...nextRun.integrationAuthority,
                repositoryCommits: [
                  { repositoryReference: "repo-a", commit: commit("3") },
                ],
              },
            },
            successorAssertions: [
              {
                defectId: `rework-defect-${index}`,
                nextTestCaseRevisionId: revision.id,
                nextAssertionId: "assertion-1",
              },
            ],
          }),
        (error: unknown) =>
          error instanceof TestRuntimeError &&
          error.code === "TEST_REWORK_FRESH_INTEGRATION_REQUIRED",
      );
      fixture.database.close();
    }
  });
});
