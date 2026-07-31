import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ArtifactVersionView } from "../artifactRegistry.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import type {
  TestCaseRevisionView,
  TestRuntime,
} from "../testing/testRuntime.js";
import {
  CandidateInputRuntimeError,
  openCandidateInputRuntime,
} from "./candidateInputRuntime.js";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const commit = (value: string): string => value.repeat(40);

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

const integrationAuthority = {
  id: "integration-generation-1",
  manifest: {
    schemaVersion: 1 as const,
    generationId: "integration-generation-1",
    generation: 1,
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-technical",
    nodeRunId: "integration-node-1",
    coverageId: "coverage-1",
    coverageNodeRunId: "review-node-1",
    coverageNodeAttemptId: "review-attempt-1",
    coverageHash: hash("coverage"),
    repositories: [
      {
        repositoryReference: "repository-a",
        baseCommit: commit("a"),
        integrationBranch: "integration/run-1/g1/repository-a",
      },
    ],
    packages: [
      {
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
        applicationId: "application-1",
        repositoryReference: "repository-a",
        baseCommit: commit("a"),
        sourceBranch: "sandcastle/run-1/package-1",
        sourceCommit: commit("b"),
        diffHash: hash("diff"),
        authorityId: "code-review-authority-1",
        qualityGateResultId: "code-review-gate-1",
        reviewContext: {
          codeReviewManifestId: "code-review-1",
          codeReviewManifestHash: hash("code-review-manifest"),
          diffArtifactVersionId: "artifact-diff-1",
          specRevisionIds: ["project-spec-r1", "application-spec-r1"],
          harnessSnapshotIds: ["harness-1"],
          acceptanceCriteria: ["requirement-1"],
          selfCheckEvidenceRefs: ["self-check:1"],
        },
        dependencies: [],
        contractVersions: [
          {
            id: "contract-1",
            version: "1",
            hash: hash("contract-1"),
            producerApplicationId: "application-1",
            consumerApplicationId: "application-2",
            testCommands: [["npm", "test", "--", "contract-1"]].flat(),
            evidenceRefs: ["contract-evidence:1"],
          },
        ],
        integrationConditions: ["build and contract validation pass"],
      },
    ],
    dependencyOrder: ["package-1-v1"],
    contractVersions: [
      {
        id: "contract-1",
        version: "1",
        hash: hash("contract-1"),
        producerApplicationId: "application-1",
        consumerApplicationId: "application-2",
        testCommands: ["npm test -- contract-1"],
        evidenceRefs: ["contract-evidence:1"],
      },
    ],
    integrationConditions: ["build and contract validation pass"],
    requiredValidations: [
      {
        id: "contract-validation-1",
        repositoryReference: "repository-a",
        kind: "contract" as const,
        identityHash: hash("contract-validation-1"),
        commands: [["npm", "test", "--", "contract-1"]],
        evidenceRefs: ["contract-evidence:1"],
        responsibleWorkPackageVersionIds: ["package-1-v1"],
        contract: {
          id: "contract-1",
          version: "1",
          hash: hash("contract-1"),
          producerApplicationId: "application-1",
          consumerApplicationId: "application-2",
        },
      },
    ],
  },
  manifestHash: hash("integration-manifest"),
  state: "passed" as const,
  repositoryResults: [
    {
      id: "integration-result-1",
      repositoryReference: "repository-a",
      baseCommit: commit("a"),
      integrationBranch: "integration/run-1/g1/repository-a",
      state: "succeeded" as const,
      expectedTip: commit("a"),
      integratedCommit: commit("c"),
      validationRecords: [
        {
          validationId: "contract-validation-1",
          kind: "contract" as const,
          status: "passed" as const,
          recordHash: hash("validation-record"),
          evidenceRefs: ["contract-evidence:1"],
          responsibleWorkPackageVersionIds: ["package-1-v1"],
          contractFailure: null,
        },
      ],
    },
  ],
  operations: [
    {
      id: "integration-operation-1",
      repositoryReference: "repository-a",
      integrationBranch: "integration/run-1/g1/repository-a",
      workPackageId: "package-1",
      workPackageVersionId: "package-1-v1",
      authorityId: "code-review-authority-1",
      qualityGateResultId: "code-review-gate-1",
      sourceBranch: "sandcastle/run-1/package-1",
      sourceCommit: commit("b"),
      diffHash: hash("diff"),
      state: "succeeded" as const,
      expectedTip: commit("a"),
      resultingCommit: commit("c"),
      requestHash: hash("integration-request"),
      receiptHash: hash("integration-receipt"),
      failure: null,
    },
  ],
  defects: [],
  aggregateReview: {
    id: "aggregate-review-1",
    topicId: "aggregate-topic-1",
    qualityGateResultId: "aggregate-gate-1",
    input: { generationId: "integration-generation-1" },
    inputHash: hash("aggregate-input"),
    result: "PASS" as const,
    evidence: ["aggregate-evidence:1"],
  },
  passAuthorityHash: hash("integration-pass"),
} satisfies IntegrationGenerationView;

const caseRevision = {
  id: "test-case-r1",
  testCaseId: "test-case-1",
  projectId: "project-1",
  revision: 1,
  supersedesRevisionId: null,
  manifest: {
    schemaVersion: 1 as const,
    testCaseId: "test-case-1",
    revisionId: "test-case-r1",
    revision: 1,
    supersedesRevisionId: null,
    ownerPositionId: "test-engineer",
    requirementIds: ["requirement-1"],
    workPackageVersions: [
      {
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
        manifestHash: hash("package-1-v1"),
      },
    ],
    preconditions: ["Runtime started"],
    uiActions: [{ id: "action-1", kind: "click", target: "run-test" }],
    assertions: [
      {
        id: "assertion-1",
        operationId: "test-operation-1",
        ui: { kind: "status", expected: "passed" },
        runtime: { kind: "query", expected: "passed" },
      },
    ],
    fixture: { id: "fixture-1", scriptHashes: [hash("fixture-script")] },
    executionOperations: [
      {
        id: "test-operation-1",
        kind: "electron" as const,
        adapterId: "scripted-test",
        input: { fixture: "fixture-1" },
        inputHash: hash("fixture-input"),
      },
    ],
    evidencePolicy: {
      retentionClass: "durable" as const,
      redactionProfile: "candidate-safe-v1",
      requiredKinds: ["ui", "runtime"],
    },
    cleanup: {
      policy: "identity-verified-quarantine",
      required: true,
      operationId: "cleanup-1",
      rootFingerprint: hash("fixture-root"),
      targets: [
        { kind: "repository" as const, pathFingerprint: hash("repository") },
      ],
    },
  },
  manifestHash: hash("test-case-r1"),
  createdAt: "2026-07-30T00:00:00.000Z",
} satisfies TestCaseRevisionView;

const testAuthority = {
  schemaVersion: 1 as const,
  testRunId: "test-run-1",
  manifestHash: hash("test-run-manifest"),
  passAuthorityHash: hash("test-run-pass"),
  testEngineer: {
    aiMemberId: "tester-ai",
    positionId: "position-test-engineer",
    sessionId: "test-session-1",
  },
  integrationAuthority: {
    generationId: integrationAuthority.id,
    manifestHash: integrationAuthority.manifestHash,
    passAuthorityHash: integrationAuthority.passAuthorityHash!,
    repositoryCommits: [
      { repositoryReference: "repository-a", commit: commit("c") },
    ],
  },
  testCaseRevisions: [{ id: caseRevision.id, hash: caseRevision.manifestHash }],
  coverageHash: hash("test-coverage"),
  build: { artifactVersionId: "artifact-build-1", digest: hash("build") },
  buildLineage: {
    generationId: integrationAuthority.id,
    manifestHash: integrationAuthority.manifestHash,
    passAuthorityHash: integrationAuthority.passAuthorityHash!,
    repositoryCommits: [
      { repositoryReference: "repository-a", commit: commit("c") },
    ],
  },
  snapshotRevisionId: "snapshot-technical",
  executionProfile: { id: "isolated-profile", hash: hash("profile") },
  companyDirectoryFingerprint: hash("company-directory"),
  fixture: { id: "fixture-1", scriptHashes: [hash("fixture-script")] },
  environment: { platform: "darwin", arch: "arm64" },
  capabilities: [
    "branch",
    "git-ref-write-isolation",
    "runtime-import-only",
    "electron",
  ],
  risk: {
    schemaVersion: 1 as const,
    policy: {
      revisionId: "technical-baseline-1",
      rules: [
        { factorId: "user-visible-runtime", minimumTier: "high" as const },
      ],
      hash: hash("test-risk-policy"),
    },
    factors: [
      {
        id: "user-visible-runtime",
        present: true,
        evidenceRefs: ["test-case:test-case-r1"],
      },
    ],
    computedTier: "high" as const,
    evidenceRefs: ["test-case:test-case-r1"],
    inputHash: hash("test-risk-input"),
  },
  reworkLineage: null,
  assertionResultHashes: [hash("assertion-result")],
  evidence: [
    {
      id: "test-evidence-ui",
      contentHash: hash("ui-evidence"),
      artifactVersionId: "artifact-ui-1",
      locator: "artifacts/ui.json",
    },
    {
      id: "test-evidence-runtime",
      contentHash: hash("runtime-evidence"),
      artifactVersionId: "artifact-runtime-1",
      locator: "artifacts/runtime.json",
    },
  ],
  evidenceHashes: [hash("runtime-evidence"), hash("ui-evidence")].sort(),
  defectResolutions: [],
  obligations: [],
  openDefectIds: [],
  openObligationIds: [],
} satisfies ReturnType<TestRuntime["downstreamAuthority"]>;

const artifact = (input: {
  id: string;
  type: string;
  contentHash: string;
  byteSize?: number;
}): ArtifactVersionView => ({
  id: input.id,
  artifactId: `artifact:${input.id}`,
  projectId: "project-1",
  type: input.type,
  schemaVersion: "1",
  logicalName: input.id,
  version: 1,
  contentRef: `artifacts/${input.id}.json`,
  contentHash: input.contentHash,
  byteSize: input.byteSize ?? 128,
  contentKind: "managed-file",
  integrityStatus: "verified",
  lifecycle: "finalized",
  identityHash: hash(`identity:${input.id}`),
  integrityDescriptor: { algorithm: "sha256" },
  status: "accepted",
  producer: {
    runId: "run-1",
    snapshotRevisionId: "snapshot-technical",
    nodeRunId: "test-node-1",
    nodeAttemptId: "test-attempt-1",
    aiMemberId: "test-engineer-member",
  },
  createdAt: "2026-07-30T00:00:00.000Z",
});

const seedLineage = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO projects(id, company_id, name, goal, status, created_at)
    VALUES ('project-1', 'company', 'Project', 'Candidate test', 'active', '2026-07-30T00:00:00.000Z');
    INSERT INTO department_runs(
      id, project_id, department_id, status, created_at,
      snapshot_revision_id, updated_at
    ) VALUES (
      'run-1', 'project-1', 'software-rnd', 'running',
      '2026-07-30T00:00:00.000Z', 'snapshot-technical',
      '2026-07-30T00:00:00.000Z'
    );
  `);
  const snapshotPayload = {
    schemaVersion: 1,
    pipelineVersion: {
      id: "pipeline-1",
      version: 1,
      hash: hash("pipeline"),
      handlerRegistryVersion: 1,
      handlerRegistryHash: hash("handler-registry"),
    },
  };
  const technicalBaselineManifest = {
    applicationSpecRevisions: [
      { id: "application-spec-r1", hash: hash("application-spec-r1") },
    ],
    contractVersions: integrationAuthority.manifest.contractVersions,
    riskPolicy: ["runtime-owned"],
  };
  const technicalBaselineHash = hash(canonicalJson(technicalBaselineManifest));
  database
    .prepare(
      `INSERT INTO run_snapshot_revisions(
         id, run_id, revision, schema_version, canonical_json, hash, created_at
       ) VALUES (?, ?, 3, 1, ?, ?, ?)`,
    )
    .run(
      "snapshot-technical",
      "run-1",
      canonicalJson(snapshotPayload),
      hash(canonicalJson(snapshotPayload)),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO product_baselines(
         id, project_id, source_proposal_revision_id, source_proposal_hash,
         content_json, canonical_hash, confirmed_by_type, confirmed_by_id,
         confirmed_by_authenticated_by, confirmation_command_id, run_id,
         snapshot_revision_id, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'human', 'owner', 'local-session', ?, ?, ?, ?)`,
    )
    .run(
      "product-baseline-1",
      "project-1",
      "product-proposal-r1",
      hash("product-proposal-r1"),
      canonicalJson({ goal: "Ship exact candidate input" }),
      hash("product-baseline"),
      "confirm-product-baseline",
      "run-1",
      "snapshot-r1",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO project_spec_revisions(
         id, project_spec_id, project_id, run_id, product_baseline_id,
         product_baseline_hash, revision, supersedes_revision_id, content_json,
         content_hash, producer_ai_member_id, producer_position_id,
         producer_session_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "project-spec-r1",
      "project-spec-1",
      "project-1",
      "run-1",
      "product-baseline-1",
      hash("product-baseline"),
      canonicalJson({ acceptanceCriteria: ["requirement-1"] }),
      hash("project-spec-r1"),
      "product-manager-member",
      "product-manager",
      "product-session",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO product_gate_promotions(
         id, project_id, run_id, topic_id, quality_gate_result_id,
         project_spec_revision_id, project_spec_hash,
         readiness_evidence_ids_json, source_snapshot_revision_id,
         snapshot_revision_id, snapshot_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "product-promotion-1",
      "project-1",
      "run-1",
      "product-topic-1",
      "product-gate-1",
      "project-spec-r1",
      hash("project-spec-r1"),
      canonicalJson(["readiness-1"]),
      "snapshot-r1",
      "snapshot-product",
      hash("snapshot-product"),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO application_spec_revisions(
         id, application_spec_id, application_id, project_id, run_id,
         promoted_project_spec_revision_id, promoted_project_spec_hash,
         revision, supersedes_revision_id, content_json, content_hash,
         producer_ai_member_id, producer_position_id, producer_session_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "application-spec-r1",
      "application-spec-1",
      "application-1",
      "project-1",
      "run-1",
      "project-spec-r1",
      hash("project-spec-r1"),
      canonicalJson({ requirements: ["requirement-1"] }),
      hash("application-spec-r1"),
      "architect-member",
      "architect",
      "architect-session",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO technical_baseline_proposal_revisions(
         id, technical_baseline_proposal_id, project_id, run_id,
         promoted_project_spec_revision_id, promoted_project_spec_hash,
         readiness_evidence_json, application_spec_revisions_json, revision,
         supersedes_revision_id, content_json, content_hash,
         producer_ai_member_id, producer_position_id, producer_session_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "technical-proposal-r1",
      "technical-proposal-1",
      "project-1",
      "run-1",
      "project-spec-r1",
      hash("project-spec-r1"),
      canonicalJson(["readiness-1"]),
      canonicalJson([
        { id: "application-spec-r1", hash: hash("application-spec-r1") },
      ]),
      canonicalJson({ riskPolicy: ["runtime-owned"] }),
      hash("technical-proposal-r1"),
      "architect-member",
      "architect",
      "architect-session",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO technical_baselines(
         id, project_id, run_id, proposal_revision_id, manifest_json,
         manifest_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "technical-baseline-1",
      "project-1",
      "run-1",
      "technical-proposal-r1",
      canonicalJson(technicalBaselineManifest),
      technicalBaselineHash,
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO technical_gate_promotions(
         id, project_id, run_id, topic_id, quality_gate_result_id,
         technical_baseline_id, technical_baseline_hash,
         proposal_revision_id, proposal_revision_hash,
         source_snapshot_revision_id, snapshot_revision_id, snapshot_hash,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "technical-promotion-1",
      "project-1",
      "run-1",
      "technical-topic-1",
      "technical-gate-1",
      "technical-baseline-1",
      technicalBaselineHash,
      "technical-proposal-r1",
      hash("technical-proposal-r1"),
      "snapshot-product",
      "snapshot-technical",
      hash(canonicalJson(snapshotPayload)),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO test_evidence(
         id, test_run_id, operation_id, test_case_revision_id, assertion_id,
         kind, media_type, content_hash, byte_size, artifact_version_id,
         redaction_profile, retention_class, locator, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "test-evidence-ui",
      "test-run-1",
      "test-operation-1",
      "test-case-r1",
      "assertion-1",
      "ui",
      "application/json",
      hash("ui-evidence"),
      128,
      "artifact-ui-1",
      "candidate-safe-v1",
      "durable",
      "artifacts/ui.json",
      canonicalJson({ redacted: true }),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO test_evidence(
         id, test_run_id, operation_id, test_case_revision_id, assertion_id,
         kind, media_type, content_hash, byte_size, artifact_version_id,
         redaction_profile, retention_class, locator, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "test-evidence-runtime",
      "test-run-1",
      "test-operation-1",
      "test-case-r1",
      "assertion-1",
      "runtime",
      "application/json",
      hash("runtime-evidence"),
      128,
      "artifact-runtime-1",
      "candidate-safe-v1",
      "durable",
      "artifacts/runtime.json",
      canonicalJson({ redacted: true }),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO work_package_versions(
         id, work_package_id, version, application_id, repository_reference,
         node_run_id, manifest_json, manifest_hash, status, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', ?)`,
    )
    .run(
      "package-1-v1",
      "package-1",
      "application-1",
      "repository-a",
      "package-node-1",
      canonicalJson({ acceptanceCriteria: ["requirement-1"] }),
      hash("package-1-v1"),
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO work_package_assignments(
         id, work_package_version_id, node_attempt_id, position_id,
         ai_member_id, agent_adapter_id, rationale_json, allocation_id,
         interaction_session_id, sandbox_identity, evidence_scope, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'self-check-passed', ?, ?)`,
    )
    .run(
      "package-1-assignment",
      "package-1-v1",
      "package-attempt-1",
      "implementer-position",
      "implementer-member",
      "scripted-agent",
      canonicalJson({ reason: "exact package assignment" }),
      "package-allocation-1",
      "package-session-1",
      "package-sandbox-1",
      "package-evidence-scope-1",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO node_runs(
         id, run_id, pipeline_node_id, node_type, status, attempt_count,
         required_dependency_ids_json, created_at, updated_at,
         handler_kind_id
       ) VALUES (?, ?, ?, 'ai-task', 'running', 1, '[]', ?, ?, ?)`,
    )
    .run(
      "candidate-input-node-1",
      "run-1",
      "candidate-input-pipeline-node",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
      "delivery-candidate-input@1",
    );
  database
    .prepare(
      `INSERT INTO node_attempts(
         id, node_run_id, attempt_number, snapshot_revision_id, reason,
         status, created_at, started_at
       ) VALUES (?, ?, 1, ?, 'initial', 'running', ?, ?)`,
    )
    .run(
      "candidate-input-attempt-1",
      "candidate-input-node-1",
      "snapshot-technical",
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO interaction_sessions(
         id, mode, project_id, run_id, node_run_id, status, created_at
       ) VALUES (?, 'run-collaboration', ?, ?, ?, 'active', ?)`,
    )
    .run(
      "candidate-input-session-1",
      "project-1",
      "run-1",
      "candidate-input-node-1",
      "2026-07-30T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO session_participants(
         id, session_id, participant_type, participant_ref, role, created_at
       ) VALUES (?, ?, 'ai-member', ?, 'delivery-coordinator', ?)`,
    )
    .run(
      "candidate-input-participant-1",
      "candidate-input-session-1",
      "delivery-coordinator-member",
      "2026-07-30T00:00:00.000Z",
    );
};

const openFixture = (
  exactIntegration: IntegrationGenerationView = integrationAuthority,
) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  seedLineage(database);
  const artifacts = new Map(
    [
      artifact({
        id: "artifact-build-1",
        type: "build",
        contentHash: hash("build"),
      }),
      artifact({
        id: "artifact-diff-1",
        type: "diff",
        contentHash: hash("diff"),
      }),
      artifact({
        id: "artifact-ui-1",
        type: "test-evidence",
        contentHash: hash("ui-evidence"),
      }),
      artifact({
        id: "artifact-runtime-1",
        type: "test-evidence",
        contentHash: hash("runtime-evidence"),
      }),
    ].map((entry) => [entry.id, entry]),
  );
  const runtime = openCandidateInputRuntime(database, {
    tests: {
      downstreamAuthority: (testRunId) => {
        assert.equal(testRunId, testAuthority.testRunId);
        return testAuthority;
      },
      readCaseRevision: (revisionId, expectedHash) => {
        assert.equal(revisionId, caseRevision.id);
        assert.equal(expectedHash, caseRevision.manifestHash);
        return caseRevision;
      },
    },
    integrations: {
      readPassAuthority: (generationId) => {
        assert.equal(generationId, exactIntegration.id);
        return exactIntegration;
      },
    },
    artifacts: {
      inspect: (versionId) => {
        const version = artifacts.get(versionId);
        if (!version) throw new Error(`Unknown Artifact ${versionId}`);
        return { version, inputs: [] };
      },
    },
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  return { database, runtime };
};

const freezeInput = {
  candidateInputId: "candidate-input-1",
  requestId: "candidate-input-request-1",
  projectId: "project-1",
  runId: "run-1",
  snapshotRevisionId: "snapshot-technical",
  nodeRunId: "candidate-input-node-1",
  nodeAttemptId: "candidate-input-attempt-1",
  producer: {
    aiMemberId: "delivery-coordinator-member",
    positionId: "delivery-coordinator",
    sessionId: "candidate-input-session-1",
  },
  requiredTestRunIds: ["test-run-1"],
  environment: {
    platform: "darwin",
    architecture: "arm64",
    electronVersion: "43.0.0",
    executableHash: hash("electron-executable"),
    capabilityProfileHash: hash("candidate-capability-profile"),
  },
  evidencePolicy: {
    revisionId: "candidate-evidence-policy@1",
    redactionProfile: "candidate-safe-v1",
    retentionClass: "durable" as const,
    maxItemBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
  },
};

describe("Delivery Candidate Input Runtime", () => {
  it("freezes exact T15-T17 lineage into one canonical immutable manifest", () => {
    const fixture = openFixture();
    const frozen = fixture.runtime.freeze(freezeInput);

    assert.equal(frozen.state, "frozen-for-final-gates");
    assert.equal(frozen.manifest.integration.id, integrationAuthority.id);
    assert.deepEqual(
      frozen.manifest.tests.map((entry) => entry.testRunId),
      ["test-run-1"],
    );
    assert.deepEqual(
      frozen.manifest.testCaseRevisions.map((entry) => entry.id),
      ["test-case-r1"],
    );
    assert.deepEqual(
      frozen.manifest.contracts.map((entry) => entry.id),
      ["contract-1"],
    );
    assert.deepEqual(
      frozen.manifest.artifacts.map((entry) => entry.id),
      [
        "artifact-build-1",
        "artifact-diff-1",
        "artifact-runtime-1",
        "artifact-ui-1",
      ],
    );
    assert.equal(frozen.manifest.risk.tier, "high");
    assert.deepEqual(frozen.manifest.forbiddenReviewerIdentities, [
      {
        aiMemberId: "delivery-coordinator-member",
        positionId: "delivery-coordinator",
        sessionId: "candidate-input-session-1",
        reason: "producer",
      },
      {
        aiMemberId: "implementer-member",
        positionId: "implementer-position",
        sessionId: "package-session-1",
        reason: "integration-assignment",
      },
      {
        aiMemberId: "tester-ai",
        positionId: "position-test-engineer",
        sessionId: "test-session-1",
        reason: "test-engineer",
      },
    ]);
    assert.match(frozen.manifestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(fixture.runtime.inspect(frozen.id), frozen);
    assert.deepEqual(fixture.runtime.freeze(freezeInput), frozen);
    fixture.database.close();
  });

  it("rejects changed authority or environment under an existing identity", () => {
    const fixture = openFixture();
    fixture.runtime.freeze(freezeInput);

    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          environment: {
            ...freezeInput.environment,
            architecture: "x64",
          },
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_INPUT_CONFLICT",
    );
    fixture.database.close();
  });

  it("rejects evidence that violates the frozen redaction profile", () => {
    const fixture = openFixture();

    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          evidencePolicy: {
            ...freezeInput.evidencePolicy,
            redactionProfile: "different-redaction-profile",
          },
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_EVIDENCE_AUTHORITY_INVALID",
    );
    fixture.database.close();
  });

  it("freezes only the exact Application Spec revisions accepted by the Technical Baseline", () => {
    const fixture = openFixture();
    fixture.database
      .prepare(
        `INSERT INTO application_spec_revisions(
           id, application_spec_id, application_id, project_id, run_id,
           promoted_project_spec_revision_id, promoted_project_spec_hash,
           revision, supersedes_revision_id, content_json, content_hash,
           producer_ai_member_id, producer_position_id, producer_session_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "application-spec-r2",
        "application-spec-1",
        "application-1",
        "project-1",
        "run-1",
        "project-spec-r1",
        hash("project-spec-r1"),
        "application-spec-r1",
        canonicalJson({ requirements: ["requirement-1", "later-change"] }),
        hash("application-spec-r2"),
        "architect-member",
        "architect",
        "architect-session",
        "2026-07-30T01:00:00.000Z",
      );

    const frozen = fixture.runtime.freeze(freezeInput);

    assert.deepEqual(frozen.manifest.technical.applicationSpecRevisions, [
      {
        id: "application-spec-r1",
        applicationId: "application-1",
        revision: 1,
        hash: hash("application-spec-r1"),
      },
    ]);
    fixture.database.close();
  });

  it("rejects hash drift in an Application Spec frozen by the Technical Baseline", () => {
    const fixture = openFixture();
    fixture.database.exec(
      "DROP TRIGGER application_spec_revisions_immutable_update",
    );
    fixture.database
      .prepare(
        "UPDATE application_spec_revisions SET content_hash = ? WHERE id = ?",
      )
      .run(hash("drifted-application-spec"), "application-spec-r1");

    assert.throws(
      () => fixture.runtime.freeze(freezeInput),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_APPLICATION_SPEC_AUTHORITY_INVALID",
    );
    fixture.database.close();
  });

  it("requires an exact passed Integration validation for every frozen Contract", () => {
    const invalidIntegration = structuredClone(integrationAuthority);
    invalidIntegration.repositoryResults[0]!.validationRecords = [];
    const fixture = openFixture(invalidIntegration);

    assert.throws(
      () => fixture.runtime.freeze(freezeInput),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_CONTRACT_VALIDATION_MISSING",
    );
    fixture.database.close();
  });

  it("requires the exact active Delivery coordinator Pipeline Session", () => {
    const fixture = openFixture();

    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          producer: {
            ...freezeInput.producer,
            sessionId: "different-session",
          },
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_PRODUCER_BINDING_INVALID",
    );
    fixture.database.close();
  });

  it("rejects evidence that exceeds the frozen aggregate retention budget", () => {
    const fixture = openFixture();

    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          evidencePolicy: {
            ...freezeInput.evidencePolicy,
            maxItemBytes: 200,
            maxTotalBytes: 250,
          },
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_EVIDENCE_TOO_LARGE",
    );
    fixture.database.close();
  });

  it("fails closed when required Test authority is duplicated or incomplete", () => {
    const fixture = openFixture();
    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          candidateInputId: "candidate-input-duplicates",
          requestId: "candidate-input-request-duplicates",
          requiredTestRunIds: ["test-run-1", "test-run-1"],
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_TEST_AUTHORITY_SET_INVALID",
    );
    fixture.database.close();
  });
});
