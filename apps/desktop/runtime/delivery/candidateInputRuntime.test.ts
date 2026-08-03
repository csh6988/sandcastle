import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createScriptedExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import { openCompanyCommandRegistry } from "../commandRegistry.js";
import type { ArtifactVersionView } from "../artifactRegistry.js";
import { openRuntimeEvents } from "../events/subscription.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import { openPipelineRuntime } from "../pipeline/pipelineRuntime.js";
import {
  canonicalPipelineJson,
  pipelineHash,
} from "../pipeline/canonicalPipeline.js";
import { openProjectConfiguration } from "../project/projectConfiguration.js";
import { openQualityGateRuntime } from "../quality/qualityGateRuntime.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import type {
  TestCaseRevisionView,
  TestRuntime,
} from "../testing/testRuntime.js";
import {
  CandidateInputRuntimeError,
  openCandidateInputRuntime,
  type DeliveryCandidateInputView,
} from "./candidateInputRuntime.js";
import { openDeliveryRuntime } from "./deliveryRuntime.js";

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
      id, project_id, department_id, pipeline_version_id, status, created_at,
      snapshot_revision_id, updated_at
    ) VALUES (
      'run-1', 'project-1', 'software-rnd', 'pipeline-1', 'running',
      '2026-07-30T00:00:00.000Z', 'snapshot-technical',
      '2026-07-30T00:00:00.000Z'
    );
  `);
  const snapshotPayload = {
    schemaVersion: 1,
    project: {
      id: "project-1",
      revision: 0,
      name: "Project",
      goal: "Candidate test",
      sharedContext: "",
      repositoryReferences: ["repository-a"],
    },
    department: {
      id: "software-rnd",
      revision: 0,
      name: "Software R&D",
      description: "Delivery fixture",
      inputArtifactContracts: [],
      outputArtifactContracts: [],
      defaultExecutionProfileId: null,
    },
    pipelineVersion: {
      id: "pipeline-1",
      version: 1,
      hash: hash("pipeline"),
      handlerRegistry: {
        version: 1,
        hash: hash("handler-registry"),
      },
      graph: {
        nodes: [
          {
            id: "candidate-input-pipeline-node",
            type: "ai-task",
            name: "Delivery Candidate Input",
            handlerKindId: "delivery-candidate-input@1",
          },
          {
            id: "security-pipeline-node",
            type: "ai-task",
            name: "Security",
            handlerKindId: "security-review@1",
          },
          {
            id: "operability-pipeline-node",
            type: "ai-task",
            name: "Operability",
            handlerKindId: "operability-review@1",
          },
          {
            id: "delivery-candidate-pipeline-node",
            type: "ai-task",
            name: "Delivery Candidate",
            handlerKindId: "delivery-candidate@1",
          },
          {
            id: "human-release-pipeline-node",
            type: "human-approval",
            name: "Human release",
            handlerKindId: "human-release@1",
          },
          {
            id: "complete-pipeline-node",
            type: "complete",
            name: "Complete",
            handlerKindId: "run-complete@1",
          },
        ],
        edges: [
          {
            from: "candidate-input-pipeline-node",
            to: "security-pipeline-node",
          },
          { from: "security-pipeline-node", to: "operability-pipeline-node" },
          {
            from: "operability-pipeline-node",
            to: "delivery-candidate-pipeline-node",
          },
          {
            from: "delivery-candidate-pipeline-node",
            to: "human-release-pipeline-node",
          },
          { from: "human-release-pipeline-node", to: "complete-pipeline-node" },
        ],
      },
    },
    skillFlows: [],
    positions: [],
    executionProfiles: [],
    runLimits: { maxActiveNodes: 1 },
  };
  const technicalBaselineManifest = {
    applicationSpecRevisions: [
      { id: "application-spec-r1", hash: hash("application-spec-r1") },
    ],
    contractVersions: integrationAuthority.manifest.contractVersions,
    riskPolicy: ["runtime-owned"],
  };
  const snapshotCanonical = canonicalPipelineJson(snapshotPayload);
  const snapshotHash = pipelineHash(snapshotPayload);
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
      snapshotCanonical,
      snapshotHash,
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
      snapshotHash,
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
  database.exec(`
    INSERT INTO node_runs(
      id, run_id, pipeline_node_id, node_type, handler_kind_id, status,
      attempt_count, required_dependency_ids_json, created_at, updated_at
    ) VALUES
      ('security-node-1', 'run-1', 'security-pipeline-node', 'ai-task',
       'security-review@1', 'queued', 0, '["candidate-input-pipeline-node"]',
       '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'),
      ('operability-node-1', 'run-1', 'operability-pipeline-node', 'ai-task',
       'operability-review@1', 'queued', 0, '["security-pipeline-node"]',
       '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'),
      ('delivery-candidate-node-1', 'run-1', 'delivery-candidate-pipeline-node',
       'ai-task', 'delivery-candidate@1', 'queued', 0,
       '["operability-pipeline-node"]', '2026-07-30T00:00:00.000Z',
       '2026-07-30T00:00:00.000Z'),
      ('human-release-node-1', 'run-1', 'human-release-pipeline-node',
       'human-approval', 'human-release@1', 'queued', 0,
       '["delivery-candidate-pipeline-node"]', '2026-07-30T00:00:00.000Z',
       '2026-07-30T00:00:00.000Z'),
      ('complete-node-1', 'run-1', 'complete-pipeline-node', 'complete',
       'run-complete@1', 'queued', 0, '["human-release-pipeline-node"]',
       '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
  `);
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

const seedCandidateGateReview = (
  database: DatabaseSync,
  subject: DeliveryCandidateInputView,
  kind: "security" | "operability",
  generation: number,
) => {
  const topicId = `${kind}-topic-recovery-${generation}`;
  const participantId = `${kind}-participant-recovery-${generation}`;
  const reviewerSessionId = `${kind}-session-recovery-${generation}`;
  const manifest = {
    scope: "verification",
    topicId,
    supportingArtifactVersionIds: subject.manifest.artifacts.map(
      (artifact) => artifact.id,
    ),
    supportingSpecRevisionIds: [
      subject.manifest.product.projectSpecRevisionId,
      ...subject.manifest.technical.applicationSpecRevisions.map(
        (revision) => revision.id,
      ),
    ],
    harnessSnapshotIds: subject.manifest.tests.flatMap((test) =>
      "fixture" in test && test.fixture ? [test.fixture.id] : [],
    ),
    acceptanceCriteria: ["requirement-1"],
    excludedContext: [
      "hidden-prompts",
      "prior-reviewer-opinions",
      "private-transcripts",
      "provider-session-history",
      "credential-values",
    ],
    verificationSubject: {
      kind: "candidate-final",
      deliveryCandidateInputId: subject.id,
      deliveryCandidateInputHash: subject.manifestHash,
    },
  };
  database
    .prepare(
      `INSERT INTO review_topics(
         id, project_id, run_id, title, kind, status, revision, manifest_json,
         manifest_hash, producer_ai_member_id, producer_position_id,
         producer_session_id, quorum, budget_json, stop_condition,
         escalation_policy, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'verification', 'independent-review', 1, ?, ?, ?, ?, ?, 1,
                 ?, 'blocking-findings-dispositioned', 'fail-with-evidence', ?, ?)`,
    )
    .run(
      topicId,
      subject.manifest.projectId,
      subject.manifest.runId,
      `${kind} recovery review ${generation}`,
      canonicalJson(manifest),
      hash(canonicalJson(manifest)),
      subject.manifest.producer.aiMemberId,
      subject.manifest.producer.positionId,
      subject.manifest.producer.sessionId,
      canonicalJson({ maxRounds: 1 }),
      subject.createdAt,
      subject.createdAt,
    );
  const eligibility = {
    topicId,
    participantId,
    role: "reviewer-participant",
    aiMemberId: `${kind}-reviewer-member`,
    positionId: `${kind}-reviewer`,
    sessionId: reviewerSessionId,
    producer: subject.manifest.producer,
    projectId: subject.manifest.projectId,
    eligible: true,
    reasons: [],
  };
  database
    .prepare(
      `INSERT INTO review_participants(
         id, topic_id, role, ai_member_id, position_id, session_id, eligible,
         eligibility_reasons_json, eligibility_snapshot_json,
         eligibility_snapshot_hash, created_at
       ) VALUES (?, ?, 'reviewer-participant', ?, ?, ?, 1, '[]', ?, ?, ?)`,
    )
    .run(
      participantId,
      topicId,
      eligibility.aiMemberId,
      eligibility.positionId,
      reviewerSessionId,
      canonicalJson(eligibility),
      hash(canonicalJson(eligibility)),
      subject.createdAt,
    );
  return { topicId, participantId };
};

const seedGenericCandidateGatePass = (
  database: DatabaseSync,
  topicId: string,
  qualityGateResultId: string,
  createdAt: string,
): void => {
  const topic = database
    .prepare(
      `SELECT manifest_json AS manifestJson, manifest_hash AS manifestHash
         FROM review_topics WHERE id = ?`,
    )
    .get(topicId) as {
    readonly manifestJson: string;
    readonly manifestHash: string;
  };
  database
    .prepare(
      "UPDATE review_topics SET status = 'PASS', updated_at = ? WHERE id = ?",
    )
    .run(createdAt, topicId);
  database
    .prepare(
      `INSERT INTO quality_gate_results(
         id, topic_id, kind, manifest_json, manifest_hash, revision_id, result,
         conditions_json, recheck_ids_json, evidence_refs_json, created_at
       ) VALUES (?, ?, 'verification', ?, ?, NULL, 'PASS', '[]', '[]', ?, ?)`,
    )
    .run(
      qualityGateResultId,
      topicId,
      topic.manifestJson,
      topic.manifestHash,
      canonicalJson([`review-evidence:${topicId}`]),
      createdAt,
    );
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

  it("rejects a producer whose exact Candidate Node Attempt does not exist", () => {
    const fixture = openFixture();

    assert.throws(
      () =>
        fixture.runtime.freeze({
          ...freezeInput,
          nodeRunId: "missing-candidate-input-node",
          nodeAttemptId: "missing-candidate-input-attempt",
        }),
      (error: unknown) =>
        error instanceof CandidateInputRuntimeError &&
        error.code === "CANDIDATE_PRODUCER_BINDING_INVALID",
    );
    fixture.database.close();
  });

  it("keeps a failed exact Work Package assignment forbidden from review", () => {
    const fixture = openFixture();
    fixture.database
      .prepare(
        "UPDATE work_package_assignments SET state = 'failed' WHERE id = ?",
      )
      .run("package-1-assignment");

    const frozen = fixture.runtime.freeze(freezeInput);

    assert.equal(
      (frozen.manifest.forbiddenReviewerIdentities ?? []).some(
        (identity) =>
          identity.aiMemberId === "implementer-member" &&
          identity.positionId === "implementer-position" &&
          identity.sessionId === "package-session-1" &&
          identity.reason === "integration-assignment",
      ),
      true,
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

  it("rebuilds a superseding Candidate through formal recovery, fresh Input, required Gates, and Pipeline seams", () => {
    const fixture = openFixture();
    const workerId = "delivery-quality-node-handler";
    const events = openRuntimeEvents(fixture.database, {
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
    });
    const pipeline = openPipelineRuntime(
      fixture.database,
      createScriptedExecutionAdapter(),
      { clock: () => new Date("2026-07-30T00:00:00.000Z") },
    );
    const quality = openQualityGateRuntime(fixture.database, {
      candidates: fixture.runtime,
      pipelineRuntime: pipeline,
      events,
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
    });
    const delivery = openDeliveryRuntime(fixture.database, {
      candidateInputs: fixture.runtime,
      qualityGates: quality,
      pipelineRuntime: pipeline,
      events,
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
    });
    const registry = openCompanyCommandRegistry(
      fixture.database,
      openProjectConfiguration(fixture.database),
      undefined,
      () => new Date("2026-07-30T00:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      pipeline,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fixture.runtime,
      quality,
      delivery,
    );
    fixture.database.exec(`
      UPDATE node_attempts
         SET status = 'interrupted', completed_at = '2026-07-30T00:00:00.000Z'
       WHERE id = 'candidate-input-attempt-1';
      UPDATE node_runs SET status = 'ready', attempt_count = 1
       WHERE id = 'candidate-input-node-1';
    `);

    const execute = <Value>(
      envelope: Parameters<typeof registry.execute>[0],
    ) => {
      const result = registry.execute(envelope);
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      if (result.status !== "succeeded") assert.fail(JSON.stringify(result));
      return result.value as Value;
    };
    const claim = (nodeRunId: string) => {
      const readyAttempt = fixture.database
        .prepare(
          `SELECT id FROM node_attempts
            WHERE node_run_id = ? AND status = 'ready'
            ORDER BY attempt_number DESC LIMIT 1`,
        )
        .get(nodeRunId) as { readonly id: string } | undefined;
      if (!readyAttempt) {
        const nextAttempt = (
          fixture.database
            .prepare(
              "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attemptNumber FROM node_attempts WHERE node_run_id = ?",
            )
            .get(nodeRunId) as { readonly attemptNumber: number }
        ).attemptNumber;
        fixture.database
          .prepare(
            `INSERT INTO node_attempts(
               id, node_run_id, attempt_number, snapshot_revision_id, reason,
               status, created_at
             ) VALUES (?, ?, ?, 'snapshot-technical', 'retry', 'ready', ?)`,
          )
          .run(
            `${nodeRunId}:attempt:${nextAttempt}`,
            nodeRunId,
            nextAttempt,
            "2026-07-30T00:00:00.000Z",
          );
        fixture.database
          .prepare(
            "UPDATE node_runs SET attempt_count = ? WHERE id = ? AND status = 'ready'",
          )
          .run(nextAttempt, nodeRunId);
      }
      const claimed = pipeline.claimReadyAttempt({
        runId: "run-1",
        nodeRunId,
        workerId,
        leaseDurationMs: 300_000,
      });
      assert.equal(
        claimed.kind,
        "claimed",
        claimed.kind === "no-work"
          ? `claim ${nodeRunId}: ${claimed.kind}/${claimed.reason}`
          : `claim ${nodeRunId}: ${claimed.kind}`,
      );
      if (claimed.kind !== "claimed") assert.fail("expected claimed Attempt");
      return claimed;
    };
    const complete = (
      nodeRunId: string,
      attempt: ReturnType<typeof claim>,
      result: unknown,
    ) =>
      pipeline.completeClaimedAttempt({
        runId: "run-1",
        nodeRunId,
        attemptId: attempt.attemptId,
        leaseId: attempt.leaseId,
        workerId,
        result,
      });
    const produceGate = (
      subject: DeliveryCandidateInputView,
      kind: "security" | "operability",
      generation: number,
    ) => {
      const nodeRunId = `${kind}-node-1`;
      const attempt = claim(nodeRunId);
      const review = seedCandidateGateReview(
        fixture.database,
        subject,
        kind,
        generation,
      );
      const gateInput = execute<{
        readonly id: string;
        readonly manifestHash: string;
        readonly manifest: {
          readonly checkCatalog: {
            readonly checks: readonly {
              readonly id: string;
              readonly requiredEvidenceKinds: readonly string[];
            }[];
          };
        };
      }>({
        schemaVersion: 1,
        commandId: `${kind}-prepare-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "quality-gate.input.prepare",
          gateInputId: `${kind}-gate-input-${generation}`,
          requestId: `${kind}-gate-request-${generation}`,
          kind,
          candidateInputId: subject.id,
          expectedCandidateInputHash: subject.manifestHash,
          expectedRiskTier: subject.manifest.risk.tier,
          nodeRunId,
          nodeAttemptId: attempt.attemptId,
          reviewTopicId: review.topicId,
          reviewerParticipantId: review.participantId,
        },
      });
      const executionId = `${kind}-gate-execution-${generation}`;
      execute({
        schemaVersion: 1,
        commandId: `${kind}-accept-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "quality-gate.execution.accept",
          executionId,
          gateInputId: gateInput.id,
          operationKey: `${kind}-gate:${subject.id}`,
          request: { gateInputId: gateInput.id },
        },
      });
      const checks = gateInput.manifest.checkCatalog.checks.map((check) => ({
        checkId: check.id,
        status: "passed" as const,
        evidence: check.requiredEvidenceKinds.map((evidenceKind) => ({
          kind: evidenceKind,
          ref:
            evidenceKind === "artifact" || evidenceKind === "static-analysis"
              ? "artifact-version:artifact-build-1"
              : evidenceKind === "runtime-fact"
                ? "test-pass-authority:test-run-1"
                : "test-evidence:test-evidence-ui",
        })),
        responsibility: {
          kind: "aggregate" as const,
          candidateIds: [subject.id],
        },
      }));
      execute({
        schemaVersion: 1,
        commandId: `${kind}-reconcile-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "quality-gate.execution.reconcile",
          executionId,
          observation: {
            state: "succeeded",
            fact: {
              schemaVersion: 1,
              gateInputId: gateInput.id,
              checks,
              resolutions: [],
            },
            receiptHash: hash(`${kind}-receipt-${generation}`),
          },
        },
      });
      const qualityGateResultId = `${kind}-review-pass-${generation}`;
      seedGenericCandidateGatePass(
        fixture.database,
        review.topicId,
        qualityGateResultId,
        subject.createdAt,
      );
      const gateResult = execute<{
        readonly id: string;
        readonly result: "PASS";
        readonly resultHash: string;
      }>({
        schemaVersion: 1,
        commandId: `${kind}-finalize-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "quality-gate.result.finalize",
          candidateGateResultId: `${kind}-candidate-gate-result-${generation}`,
          gateInputId: gateInput.id,
          executionId,
          qualityGateResultId,
        },
      });
      complete(nodeRunId, attempt, {
        candidateGateResultId: gateResult.id,
        result: gateResult.result,
        resultHash: gateResult.resultHash,
      });
      return gateResult;
    };
    const produceCandidate = (generation: number) => {
      const inputAttempt = claim("candidate-input-node-1");
      const input = execute<DeliveryCandidateInputView>({
        schemaVersion: 1,
        commandId: `candidate-input-freeze-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "delivery.candidate-input.freeze",
          ...freezeInput,
          candidateInputId: `candidate-input-recovery-${generation}`,
          requestId: `candidate-input-recovery-request-${generation}`,
          nodeAttemptId: inputAttempt.attemptId,
        },
      });
      complete("candidate-input-node-1", inputAttempt, {
        deliveryCandidateInputId: input.id,
        manifestHash: input.manifestHash,
      });
      const security = produceGate(input, "security", generation);
      const operability = produceGate(input, "operability", generation);
      const authority = execute<{ readonly authorityHash: string }>({
        schemaVersion: 1,
        commandId: `candidate-input-authorize-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "delivery.candidate-input.authorize",
          authorityId: `candidate-input-authority-${generation}`,
          candidateInputId: input.id,
          expectedCandidateInputHash: input.manifestHash,
          securityGateResultId: security.id,
          operabilityGateResultId: operability.id,
        },
      });
      const candidateAttempt = claim("delivery-candidate-node-1");
      const candidate = execute<ReturnType<typeof delivery.inspect>>({
        schemaVersion: 1,
        commandId: `delivery-candidate-assemble-command-${generation}`,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: {
          type: "delivery.candidate.assemble",
          candidateId: `delivery-candidate-recovery-${generation}`,
          requestId: `delivery-candidate-recovery-request-${generation}`,
          candidateInputId: input.id,
          expectedCandidateInputHash: input.manifestHash,
          expectedGateAuthorityHash: authority.authorityHash,
          nodeRunId: "delivery-candidate-node-1",
          nodeAttemptId: candidateAttempt.attemptId,
          leaseId: candidateAttempt.leaseId,
          workerId,
        },
      });
      return { input, candidate };
    };

    const first = produceCandidate(1);
    assert.equal(
      pipeline.inspectRun("run-1").run.status,
      "waiting-human-release",
    );
    execute({
      schemaVersion: 1,
      commandId: "release-changes-requested-command",
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      consumerId: "desktop-human-release",
      command: {
        type: "delivery.release.decide",
        decisionId: "release-changes-requested-decision",
        candidateId: first.candidate.id,
        expectedCandidateHash: first.candidate.manifestHash,
        decision: "changes-requested",
        reason: "Repeat the complete frozen Candidate verification flow.",
        evidenceRefs: ["artifact-version:artifact-build-1"],
        rework: {
          scope: "same-boundary",
          responsibility: {
            kind: "aggregate",
            summary:
              "Rebuild the exact Candidate evidence under the same boundary.",
          },
        },
      },
    });
    assert.equal(pipeline.inspectRun("run-1").run.status, "blocked");
    const activated = execute<ReturnType<typeof delivery.inspect>>({
      schemaVersion: 1,
      commandId: "release-recovery-activation-command",
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      consumerId: "desktop-human-release",
      command: {
        type: "delivery.release.recover",
        decisionId: "release-changes-requested-decision",
        candidateId: first.candidate.id,
        expectedCandidateHash: first.candidate.manifestHash,
        authority: {
          kind: "candidate-input-recheck",
          id: first.input.id,
        },
      },
    });
    assert.equal(activated.projection, "rework-activated");
    assert.equal(pipeline.inspectRun("run-1").run.status, "recovering");

    const second = produceCandidate(2);
    assert.equal(delivery.inspect(first.candidate.id).projection, "superseded");
    assert.equal(
      delivery.inspect(first.candidate.id).supersededByCandidateId,
      second.candidate.id,
    );
    const accepted = execute<ReturnType<typeof delivery.inspect>>({
      schemaVersion: 1,
      commandId: "release-accepted-command",
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      consumerId: "desktop-human-release",
      command: {
        type: "delivery.release.decide",
        decisionId: "release-accepted-decision",
        candidateId: second.candidate.id,
        expectedCandidateHash: second.candidate.manifestHash,
        decision: "accepted",
        reason: "The fresh immutable Candidate and both required Gates pass.",
        evidenceRefs: ["artifact-version:artifact-build-1"],
      },
    });
    assert.equal(accepted.projection, "accepted");
    assert.equal(delivery.inspect(second.candidate.id).projection, "accepted");
    assert.equal(pipeline.inspectRun("run-1").run.status, "completed");
    fixture.database.close();
  });
});
