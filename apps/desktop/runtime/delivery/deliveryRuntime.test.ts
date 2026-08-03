import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyCommandRegistry } from "../commandRegistry.js";
import { openRuntimeEvents } from "../events/subscription.js";
import { openProjectConfiguration } from "../project/projectConfiguration.js";
import type { DeliveryCandidateInputView } from "./candidateInputRuntime.js";
import type { DeliveryCandidateInputGateAuthority } from "../quality/qualityGateRuntime.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import { openCompanyDatabase } from "../storage/sqlite.js";
import {
  DeliveryRuntimeError,
  openDeliveryRuntime,
} from "./deliveryRuntime.js";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const candidateInput = {
  id: "candidate-input-1",
  requestId: "candidate-input-request-1",
  manifestHash: hash("candidate-input-1"),
  state: "frozen-for-final-gates" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  manifest: {
    schemaVersion: 1 as const,
    candidateInputId: "candidate-input-1",
    projectId: "project-1",
    runId: "run-1",
    snapshot: {
      id: "snapshot-1",
      hash: hash("snapshot-1"),
      payload: { pipelineVersion: { id: "pipeline-1" } },
    },
    sourceNode: {
      nodeRunId: "candidate-input-node-1",
      nodeAttemptId: "candidate-input-attempt-1",
    },
    producer: {
      aiMemberId: "delivery-coordinator-member",
      positionId: "delivery-coordinator",
      sessionId: "delivery-session-1",
    },
    product: {
      baselineId: "product-baseline-1",
      baselineHash: hash("product-baseline-1"),
      sourceProposalRevisionId: "proposal-1",
      sourceProposalHash: hash("proposal-1"),
      projectSpecRevisionId: "project-spec-1",
      projectSpecHash: hash("project-spec-1"),
      productQualityGateResultId: "product-gate-1",
      readinessEvidenceIds: ["readiness-1"],
    },
    technical: {
      baselineId: "technical-baseline-1",
      baselineHash: hash("technical-baseline-1"),
      proposalRevisionId: "technical-proposal-1",
      proposalRevisionHash: hash("technical-proposal-1"),
      technicalQualityGateResultId: "technical-gate-1",
      applicationSpecRevisions: [],
      manifest: { riskPolicy: "runtime-owned" },
    },
    codeReviewCoverage: [],
    integration: {
      id: "integration-generation-1",
      manifestHash: hash("integration-manifest"),
      passAuthorityHash: hash("integration-authority"),
    },
    repositoryCommits: [
      {
        repositoryReference: "fixture-repository-1",
        commit: "1".repeat(40),
      },
    ],
    contracts: [{ id: "contract-1", version: "1" }],
    tests: [{ testRunId: "test-run-1", passAuthorityHash: hash("test-pass") }],
    testCaseRevisions: [{ id: "test-case-revision-1" }],
    evidence: [
      {
        id: "evidence-1",
        testRunId: "test-run-1",
        testCaseRevisionId: "test-case-revision-1",
        assertionId: "assertion-1",
        kind: "runtime",
        mediaType: "application/json",
        contentHash: hash("evidence-1"),
        byteSize: 64,
        artifactVersionId: "artifact-version-1",
        redactionProfile: "candidate-safe-v1",
        retentionClass: "durable" as const,
        locator: "artifacts/evidence-1.json",
        metadata: { redacted: true },
      },
    ],
    artifacts: [{ id: "artifact-version-1", contentHash: hash("artifact-1") }],
    risk: {
      policyRevisionId: "delivery-candidate-risk@1" as const,
      policyHash: hash("risk-policy"),
      factors: [
        {
          id: "user-visible-runtime",
          minimumTier: "high" as const,
          present: true,
          evidenceRefs: ["artifact-version:artifact-version-1"],
        },
      ],
      tier: "high" as const,
      inputHash: hash("risk-input"),
    },
    environment: {
      platform: "darwin",
      architecture: "arm64",
      electronVersion: "43.0.0",
      executableHash: hash("electron"),
      capabilityProfileHash: hash("capabilities"),
    },
    evidencePolicy: {
      revisionId: "candidate-evidence-policy@1",
      redactionProfile: "candidate-safe-v1",
      retentionClass: "durable" as const,
      maxItemBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
    },
  },
} as unknown as DeliveryCandidateInputView;

const gateAuthority = {
  id: "candidate-input-authority-1",
  candidateInputId: candidateInput.id,
  candidateInputHash: candidateInput.manifestHash,
  security: {
    gateInputId: "security-input-1",
    gateInputHash: hash("security-input-1"),
    resultId: "security-result-1",
    resultHash: hash("security-result-1"),
    qualityGateResultId: "security-quality-result-1",
  },
  operability: {
    gateInputId: "operability-input-1",
    gateInputHash: hash("operability-input-1"),
    resultId: "operability-result-1",
    resultHash: hash("operability-result-1"),
    qualityGateResultId: "operability-quality-result-1",
  },
  risk: candidateInput.manifest.risk,
  evidenceRefs: ["artifact-version:artifact-version-1"],
  authorityHash: hash("candidate-input-authority-1"),
  createdAt: candidateInput.createdAt,
} satisfies DeliveryCandidateInputGateAuthority;

const candidateInputFor = (
  id: string,
  runId = "run-1",
): DeliveryCandidateInputView => ({
  ...candidateInput,
  id,
  requestId: `${id}-request`,
  manifestHash: hash(id),
  manifest: {
    ...candidateInput.manifest,
    candidateInputId: id,
    runId,
  },
});

const gateAuthorityFor = (
  input: DeliveryCandidateInputView,
): DeliveryCandidateInputGateAuthority => ({
  ...gateAuthority,
  id: `${input.id}-authority`,
  candidateInputId: input.id,
  candidateInputHash: input.manifestHash,
  authorityHash: hash(`${input.id}-authority`),
});

const seedFormalWorkPackageReworkAuthority = (
  database: DatabaseSync,
  suffix: string,
  commandId = `wp-rework-command-${suffix}`,
  seedReceipt = true,
) => {
  const packageId = `work-package-${suffix}`;
  const priorVersionId = `wp-${suffix}-v1`;
  const freshVersionId = `wp-${suffix}-v2`;
  const nodeRunId = `development-node-${suffix}`;
  const attemptId = `wp-attempt-${suffix}`;
  const allocationId = `wp-allocation-${suffix}`;
  database.exec(`
    INSERT INTO work_packages(
      id, project_id, run_id, technical_baseline_id, state, revision,
      created_at, updated_at
    ) VALUES (
      '${packageId}', 'project-1', 'run-1', 'technical-baseline-1',
      'assigned', 2, '${candidateInput.createdAt}', '${candidateInput.createdAt}'
    );
    INSERT INTO work_package_versions(
      id, work_package_id, version, application_id, repository_reference,
      node_run_id, manifest_json, manifest_hash, status, created_at
    ) VALUES
      ('${priorVersionId}', '${packageId}', 1, 'application-1', 'repo-1',
       '${nodeRunId}', '{}', '${hash(`${suffix}-v1`)}', 'superseded', '${candidateInput.createdAt}'),
      ('${freshVersionId}', '${packageId}', 2, 'application-1', 'repo-1',
       '${nodeRunId}', '{}', '${hash(`${suffix}-v2`)}', 'ready', '${candidateInput.createdAt}');
    INSERT INTO node_attempts(
      id, node_run_id, attempt_number, snapshot_revision_id, reason, status,
      structured_result_json, failure_code, failure_message, created_at,
      started_at, completed_at
    ) VALUES (
      '${attemptId}', '${nodeRunId}', 2, 'snapshot-1', 'retry', 'ready',
      NULL, NULL, NULL, '${candidateInput.createdAt}', NULL, NULL
    );
    INSERT INTO workspace_allocations(
      id, project_id, application_id, execution_profile_id,
      execution_profile_revision, operation_key, state, repository_root,
      allocation_root, source_branch, base_commit, expected_source_tip,
      capability_snapshot_json, capability_snapshot_hash,
      provision_command_id, revision, created_at, updated_at,
      work_package_version_id, node_attempt_id
    ) VALUES (
      '${allocationId}', 'project-1', 'application-1', 'profile-1', 1,
      'wp-operation-${suffix}', 'planned', '/repo', '/allocation', 'branch',
      '${"a".repeat(40)}', '${"a".repeat(40)}', '{}', '${hash(`${suffix}-capability`)}',
      '${commandId}', 0, '${candidateInput.createdAt}',
      '${candidateInput.createdAt}', '${freshVersionId}', '${attemptId}'
    );
    INSERT INTO work_package_assignments(
      id, work_package_version_id, node_attempt_id, position_id,
      ai_member_id, agent_adapter_id, rationale_json, allocation_id,
      interaction_session_id, sandbox_identity, evidence_scope, state,
      created_at, updated_at
    ) VALUES (
      'wp-assignment-${suffix}', '${freshVersionId}', '${attemptId}',
      'position-1', 'member-1', 'scripted', '{}', '${allocationId}',
      'session-${suffix}', 'sandbox-${suffix}', 'evidence-${suffix}',
      'assigned', '${candidateInput.createdAt}', '${candidateInput.createdAt}'
    );
    INSERT INTO runtime_audit_records(
      id, action, entity_type, entity_id, run_id, node_run_id,
      before_json, after_json, created_at, command_id, actor_type,
      actor_id, authenticated_by, consumer_id
    ) VALUES (
      'wp-rework-audit-${suffix}', 'work-package.rework', 'work-package',
      '${packageId}', 'run-1', '${nodeRunId}', NULL,
      '{"workPackageVersionId":"${freshVersionId}"}', '${candidateInput.createdAt}',
      '${commandId}', 'runtime-worker', 'work-package-runtime',
      'runtime', 'work-package-runtime'
    );
  `);
  if (seedReceipt) {
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, 'runtime-worker', 'work-package-runtime', 'runtime',
                   'work-package-runtime', 1, ?, 'completed', '{}', ?, ?, ?)`,
      )
      .run(
        commandId,
        hash(`${commandId}:request`),
        hash("{}"),
        JSON.stringify([`wp-rework-audit-${suffix}`]),
        candidateInput.createdAt,
      );
  }
  return { packageId, priorVersionId, freshVersionId, nodeRunId };
};

const seedFormalTestReworkAuthority = (
  database: DatabaseSync,
  suffix: string,
  priorState: "running" | "failed" = "failed",
  defectId = `test-defect-${suffix}`,
) => {
  const priorTestRunId = `test-run-${suffix}`;
  const freshTestRunId = `test-rework-run-${suffix}`;
  database.exec(`
    INSERT INTO test_runs(
      id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
      node_attempt_id, session_id, integration_generation_id,
      integration_manifest_hash, integration_pass_authority_hash,
      manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
      failure_code, failure_message, created_at, updated_at
    ) VALUES
      ('${priorTestRunId}', 'test-request-${suffix}-prior', 'project-1', 'run-1',
       'snapshot-1', 'test-node-${suffix}-prior', 'test-attempt-${suffix}-prior',
       'test-session-${suffix}-prior', 'integration-generation-1',
       '${hash("integration-manifest")}', '${hash("integration-authority")}',
       '{}', '${hash(`${suffix}-prior-test-manifest`)}',
       '${hash(`${suffix}-prior-test-request`)}', 'running', NULL,
       NULL, NULL,
       '${candidateInput.createdAt}',
       '${candidateInput.createdAt}'),
      ('${freshTestRunId}', 'test-request-${suffix}-fresh', 'project-1', 'run-1',
       'snapshot-1', 'test-node-${suffix}-fresh', 'test-attempt-${suffix}-fresh',
       'test-session-${suffix}-fresh', 'integration-generation-1',
       '${hash("integration-manifest")}', '${hash("integration-authority")}',
       '{}', '${hash("fresh-test-manifest")}',
       '${hash(`${suffix}-fresh-test-request`)}', 'passed',
       '${hash("fresh-test-pass")}', NULL, NULL, '${candidateInput.createdAt}',
       '${candidateInput.createdAt}');
    INSERT INTO test_rework_runs(
      id, defect_id, prior_test_run_id, fresh_test_run_id, route_json,
      lineage_json, lineage_hash, created_at
    ) VALUES (
      'test-rework-record-${suffix}', '${defectId}',
      '${priorTestRunId}', '${freshTestRunId}', '{}', '{}',
      '${hash(`${suffix}-test-rework-lineage`)}', '${candidateInput.createdAt}'
    );
    INSERT INTO test_defects(
      id, test_run_id, test_case_revision_id, assertion_id,
      integration_generation_id, responsibility_json, evidence_json,
      status, created_at, closed_at
    ) VALUES (
      '${defectId}', '${priorTestRunId}', 'test-case-revision-${suffix}',
      'assertion-${suffix}', 'integration-generation-1', '{}', '[]',
      'closed', '${candidateInput.createdAt}', '${candidateInput.createdAt}'
    );
    INSERT INTO test_defect_resolutions(
      id, defect_id, resolution_json, resolution_hash, created_at
    ) VALUES (
      'test-resolution-${suffix}', '${defectId}',
      '{"schemaVersion":1,"resolvedByTestRunId":"${freshTestRunId}","passAuthorityHash":"${hash("fresh-test-pass")}","assertions":[]}',
      '${hash(`${suffix}-test-resolution`)}', '${candidateInput.createdAt}'
    );
    INSERT INTO runtime_audit_records(
      id, action, entity_type, entity_id, run_id, node_run_id,
      before_json, after_json, created_at, command_id, actor_type,
      actor_id, authenticated_by, consumer_id
    ) VALUES
      ('test-rework-accepted-audit-${suffix}', 'test.run.accepted', 'test-run',
       '${freshTestRunId}', 'run-1', 'test-node-${suffix}-fresh', NULL, '{}',
       '${candidateInput.createdAt}', 'test-rework-create-command-${suffix}',
       'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime'),
      ('test-rework-completed-audit-${suffix}', 'test.run.completed', 'test-run',
       '${freshTestRunId}', 'run-1', 'test-node-${suffix}-fresh', NULL, '{}',
       '${candidateInput.createdAt}', 'test-rework-complete-command-${suffix}',
       'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime');
  `);
  if (priorState === "failed") {
    database
      .prepare(
        `UPDATE test_runs
            SET state = 'failed', failure_code = 'TEST_FAILED',
                failure_message = 'failed', updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .run(candidateInput.createdAt, priorTestRunId);
  }
  for (const [commandId, auditId] of [
    [
      `test-rework-create-command-${suffix}`,
      `test-rework-accepted-audit-${suffix}`,
    ],
    [
      `test-rework-complete-command-${suffix}`,
      `test-rework-completed-audit-${suffix}`,
    ],
  ] as const) {
    database
      .prepare(
        `INSERT INTO command_deduplication(
           command_id, actor_type, actor_id, authenticated_by, consumer_id,
           schema_version, request_hash, status, result_json, result_hash,
           effect_ids_json, completed_at
         ) VALUES (?, 'runtime-worker', 'test-runtime', 'company-runtime',
                   'test-runtime', 1, ?, 'completed', '{}', ?, ?, ?)`,
      )
      .run(
        commandId,
        hash(`${commandId}:request`),
        hash("{}"),
        JSON.stringify([auditId]),
        candidateInput.createdAt,
      );
  }
  return { priorTestRunId, freshTestRunId };
};

describe("Delivery Runtime", () => {
  it("assembles one immutable Candidate only from the exact T18 downstream authority", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const transitions: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => candidateInput },
      qualityGates: { downstreamAuthority: () => gateAuthority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: (input) => {
          transitions.push(input);
        },
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: () => {},
        activateHumanReleaseReworkInTransaction: () => {},
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const request = {
      candidateId: "delivery-candidate-1",
      requestId: "delivery-candidate-request-1",
      candidateInputId: candidateInput.id,
      expectedCandidateInputHash: candidateInput.manifestHash,
      expectedGateAuthorityHash: gateAuthority.authorityHash,
      nodeRunId: "delivery-candidate-node-1",
      nodeAttemptId: "delivery-candidate-attempt-1",
      leaseId: "delivery-candidate-lease-1",
      workerId: "delivery-candidate-node-handler",
    };

    const candidate = runtime.assemble(request);

    assert.equal(candidate.manifest.candidateInput.id, candidateInput.id);
    assert.equal(candidate.manifest.gateAuthority.id, gateAuthority.id);
    assert.deepEqual(candidate.manifest.repositoryCommits, [
      {
        repositoryReference: "fixture-repository-1",
        commit: "1".repeat(40),
      },
    ]);
    assert.match(candidate.manifestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(runtime.assemble(request), candidate);
    assert.equal(transitions.length, 1);
    assert.throws(
      () =>
        runtime.assemble({
          ...request,
          expectedGateAuthorityHash: hash("changed-authority"),
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "DELIVERY_CANDIDATE_AUTHORITY_CONFLICT",
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE delivery_candidates SET manifest_json = '{}' WHERE id = ?",
        )
        .run(candidate.id),
    );
    database.close();
  });

  it("records one verified-human accepted decision and exposes only T22 input authority", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const decisions: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => candidateInput },
      qualityGates: { downstreamAuthority: () => gateAuthority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: (input) => {
          decisions.push(input);
        },
        activateHumanReleaseReworkInTransaction: () => {},
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const candidate = runtime.assemble({
      candidateId: "delivery-candidate-accepted",
      requestId: "delivery-candidate-request-accepted",
      candidateInputId: candidateInput.id,
      expectedCandidateInputHash: candidateInput.manifestHash,
      expectedGateAuthorityHash: gateAuthority.authorityHash,
      nodeRunId: "delivery-candidate-node-1",
      nodeAttemptId: "delivery-candidate-attempt-1",
      leaseId: "delivery-candidate-lease-1",
      workerId: "delivery-candidate-node-handler",
    });
    const request = {
      decisionId: "release-decision-accepted",
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decision: "accepted" as const,
      reason: "The frozen Candidate evidence satisfies release review.",
      comment: "Approved from the local release screen.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
    };

    assert.throws(
      () =>
        runtime.decide({
          ...request,
          actor: {
            type: "runtime-worker",
            id: "delivery-worker",
            authenticatedBy: "runtime",
          },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_DECISION_ACTOR_INVALID",
    );
    const accepted = runtime.decide({
      ...request,
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
    });

    assert.equal(accepted.projection, "accepted");
    assert.equal(accepted.decision?.decision, "accepted");
    assert.equal(decisions.length, 1);
    assert.deepEqual(
      runtime.decide({
        ...request,
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
      }),
      accepted,
    );
    const authority = runtime.acceptedAuthority(candidate.id);
    assert.equal(authority.candidateId, candidate.id);
    assert.equal(
      authority.integrationGenerationId,
      candidateInput.manifest.integration.id,
    );
    assert.deepEqual(authority.repositoryCommits, [
      {
        repositoryReference: "fixture-repository-1",
        commit: "1".repeat(40),
      },
    ]);
    assert.equal("destination" in authority, false);
    assert.equal("releaseOperationId" in authority, false);
    assert.throws(
      () =>
        runtime.decide({
          ...request,
          decisionId: "release-decision-conflict",
          decision: "rejected",
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_DECISION_EXISTS",
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE human_release_decisions SET reason = 'changed' WHERE id = ?",
        )
        .run(request.decisionId),
    );
    database.close();
  });

  it("records same-boundary rework, supersedes only an unaccepted Candidate, and keeps rejection terminal", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    let currentInput = candidateInputFor("candidate-input-rework-1");
    let currentAuthority = gateAuthorityFor(currentInput);
    const decisions: unknown[] = [];
    const activations: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => currentInput },
      qualityGates: { downstreamAuthority: () => currentAuthority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: (input) => {
          decisions.push(input);
        },
        activateHumanReleaseReworkInTransaction: (input) => {
          activations.push(input);
        },
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const first = runtime.assemble({
      candidateId: "delivery-candidate-rework-1",
      requestId: "delivery-candidate-rework-request-1",
      candidateInputId: currentInput.id,
      expectedCandidateInputHash: currentInput.manifestHash,
      expectedGateAuthorityHash: currentAuthority.authorityHash,
      nodeRunId: "delivery-candidate-node-1",
      nodeAttemptId: "delivery-candidate-attempt-1",
      leaseId: "delivery-candidate-lease-1",
      workerId: "delivery-candidate-node-handler",
    });
    const changesRequested = runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-rework-1",
      candidateId: first.id,
      expectedCandidateHash: first.manifestHash,
      decision: "changes-requested",
      reason: "The exact contract evidence needs another verification run.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
      rework: {
        scope: "same-boundary",
        responsibility: {
          kind: "aggregate",
          summary: "Re-run the exact contract validation.",
        },
      },
    });
    assert.equal(changesRequested.projection, "changes-requested");
    assert.equal(changesRequested.decision?.childRunId, null);
    assert.throws(
      () =>
        runtime.recover({
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
          candidateId: first.id,
          expectedCandidateHash: first.manifestHash,
          decisionId: "release-decision-rework-1",
          authority: {
            kind: "work-package-version",
            id: "work-package-version-2",
          },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_REWORK_AUTHORITY_INVALID",
    );
    const recoveryRequest = {
      actor: {
        type: "human" as const,
        id: "local-release-owner",
        authenticatedBy: "local-session" as const,
      },
      candidateId: first.id,
      expectedCandidateHash: first.manifestHash,
      decisionId: "release-decision-rework-1",
      authority: {
        kind: "candidate-input-recheck" as const,
        id: first.manifest.candidateInput.id,
      },
      commandId: "release-recovery-command-1",
    };
    const activated = runtime.recover(recoveryRequest);
    assert.equal(activated.projection, "changes-requested");
    assert.equal(
      activated.recoveryActivation?.decisionId,
      recoveryRequest.decisionId,
    );
    assert.equal(
      activated.recoveryActivation?.authority.id,
      first.manifest.candidateInput.id,
    );
    assert.equal(
      activated.recoveryActivation?.commandId,
      recoveryRequest.commandId,
    );
    assert.equal(activations.length, 1);
    assert.deepEqual(runtime.recover(recoveryRequest), activated);
    assert.equal(activations.length, 1);
    assert.throws(
      () =>
        runtime.recover({
          ...recoveryRequest,
          authority: {
            kind: "work-package-version",
            id: "work-package-version-2",
          },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_REWORK_ACTIVATION_EXISTS",
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE delivery_release_rework_activations SET authority_id = 'changed' WHERE decision_id = ?",
        )
        .run(recoveryRequest.decisionId),
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM delivery_release_rework_records WHERE decision_id = ? AND scope = 'same-boundary'",
          )
          .get("release-decision-rework-1") as { readonly count: number }
      ).count,
      1,
    );

    currentInput = candidateInputFor("candidate-input-rework-2");
    currentAuthority = gateAuthorityFor(currentInput);
    const second = runtime.assemble({
      candidateId: "delivery-candidate-rework-2",
      requestId: "delivery-candidate-rework-request-2",
      candidateInputId: currentInput.id,
      expectedCandidateInputHash: currentInput.manifestHash,
      expectedGateAuthorityHash: currentAuthority.authorityHash,
      nodeRunId: "delivery-candidate-node-2",
      nodeAttemptId: "delivery-candidate-attempt-2",
      leaseId: "delivery-candidate-lease-2",
      workerId: "delivery-candidate-node-handler",
    });
    assert.equal(runtime.inspect(first.id).projection, "superseded");
    assert.equal(runtime.inspect(first.id).supersededByCandidateId, second.id);

    const rejected = runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-rejected",
      candidateId: second.id,
      expectedCandidateHash: second.manifestHash,
      decision: "rejected",
      reason: "The frozen Candidate is not suitable for release.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
    });
    assert.equal(rejected.projection, "rejected");
    assert.equal(decisions.length, 2);

    currentInput = candidateInputFor("candidate-input-rework-3");
    currentAuthority = gateAuthorityFor(currentInput);
    assert.throws(
      () =>
        runtime.assemble({
          candidateId: "delivery-candidate-rework-3",
          requestId: "delivery-candidate-rework-request-3",
          candidateInputId: currentInput.id,
          expectedCandidateInputHash: currentInput.manifestHash,
          expectedGateAuthorityHash: currentAuthority.authorityHash,
          nodeRunId: "delivery-candidate-node-3",
          nodeAttemptId: "delivery-candidate-attempt-3",
          leaseId: "delivery-candidate-lease-3",
          workerId: "delivery-candidate-node-handler",
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "DELIVERY_CANDIDATE_EXPLICIT_FORK_REQUIRED",
    );
    database.close();
  });

  it("records boundary-changing rework against an explicit child Run", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const input = candidateInputFor("candidate-input-boundary-change");
    const authority = gateAuthorityFor(input);
    const boundaryValidations: unknown[] = [];
    const decisions: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => input },
      qualityGates: { downstreamAuthority: () => authority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: (decision) => {
          decisions.push(decision);
        },
        activateHumanReleaseReworkInTransaction: () => {},
        validateReleaseBoundaryChildInTransaction: (boundary) => {
          boundaryValidations.push(boundary);
        },
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const candidate = runtime.assemble({
      candidateId: "delivery-candidate-boundary-change",
      requestId: "delivery-candidate-boundary-change-request",
      candidateInputId: input.id,
      expectedCandidateInputHash: input.manifestHash,
      expectedGateAuthorityHash: authority.authorityHash,
      nodeRunId: "delivery-candidate-node-boundary",
      nodeAttemptId: "delivery-candidate-attempt-boundary",
      leaseId: "delivery-candidate-lease-boundary",
      workerId: "delivery-candidate-node-handler",
    });

    const decided = runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-boundary-change",
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decision: "changes-requested",
      reason:
        "The requested repository boundary requires an explicit child Run.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
      rework: {
        scope: "boundary-changing",
        childRunId: "child-run-1",
        responsibility: {
          kind: "aggregate",
          summary: "Change the Product Baseline repository scope.",
        },
      },
    });

    assert.equal(boundaryValidations.length, 1);
    assert.equal(decisions.length, 1);
    assert.equal(decided.decision?.childRunId, "child-run-1");
    assert.equal(
      (decisions[0] as { readonly childRunId: string }).childRunId,
      "child-run-1",
    );
    database.close();
  });

  it("activates same-boundary recovery only from a fresh formal Work Package authority", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const input = {
      ...candidateInputFor("candidate-input-work-package-rework"),
      manifest: {
        ...candidateInputFor("candidate-input-work-package-rework").manifest,
        codeReviewCoverage: [
          {
            workPackageId: "work-package-command",
            workPackageVersionId: "wp-command-v1",
          },
        ] as never,
      },
    };
    const authority = gateAuthorityFor(input);
    const activations: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => input },
      qualityGates: { downstreamAuthority: () => authority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: () => {},
        activateHumanReleaseReworkInTransaction: (activation) => {
          activations.push(activation);
        },
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const candidate = runtime.assemble({
      candidateId: "delivery-candidate-work-package-rework",
      requestId: "delivery-candidate-work-package-rework-request",
      candidateInputId: input.id,
      expectedCandidateInputHash: input.manifestHash,
      expectedGateAuthorityHash: authority.authorityHash,
      nodeRunId: "delivery-candidate-node-work-package",
      nodeAttemptId: "delivery-candidate-attempt-work-package",
      leaseId: "delivery-candidate-lease-work-package",
      workerId: "delivery-candidate-node-handler",
    });
    runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-work-package-rework",
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decision: "changes-requested",
      reason: "The exact Work Package requires formal rework.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
      rework: {
        scope: "same-boundary",
        responsibility: {
          kind: "work-package",
          id: "work-package-command",
          summary: "Rework the exact frozen Work Package.",
        },
      },
    });
    const workPackageRuntime = {
      reworkInTransaction: (command: { readonly commandId: string }) => {
        seedFormalWorkPackageReworkAuthority(
          database,
          "command",
          command.commandId,
          false,
        );
        return {
          projectId: "project-1",
          runId: "run-1",
          technicalBaselineId: "technical-baseline-1",
          packages: [],
        };
      },
    } as never;
    const registry = openCompanyCommandRegistry(
      database,
      openProjectConfiguration(database),
      undefined,
      () => new Date(candidateInput.createdAt),
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
      workPackageRuntime,
    );
    const reworked = registry.execute({
      schemaVersion: 1,
      commandId: "wp-rework-command-formal",
      actor: {
        type: "runtime-worker",
        id: "work-package-runtime",
        authenticatedBy: "runtime",
      },
      consumerId: "work-package-runtime",
      expectedRevision: 1,
      command: {
        type: "work-package.rework",
        workPackageId: "work-package-command",
        versionId: "wp-command-v2",
        baseCommit: "a".repeat(40),
        recoveryReason: "Address the exact Human release responsibility.",
      },
    });
    assert.equal(reworked.status, "succeeded", JSON.stringify(reworked));
    database.exec(`
      UPDATE work_package_versions SET status = 'superseded'
       WHERE id = 'wp-command-v2';
      INSERT INTO work_package_versions(
        id, work_package_id, version, application_id, repository_reference,
        node_run_id, manifest_json, manifest_hash, status, created_at
      ) VALUES (
        'wp-command-v3', 'work-package-command', 3, 'application-1', 'repo-1',
        'development-node-command', '{}', '${hash("command-v3")}', 'ready',
        '${candidateInput.createdAt}'
      );
      INSERT INTO node_attempts(
        id, node_run_id, attempt_number, snapshot_revision_id, reason, status,
        structured_result_json, failure_code, failure_message, created_at,
        started_at, completed_at
      ) VALUES (
        'wp-attempt-command-v3', 'development-node-command', 3, 'snapshot-1',
        'retry', 'ready', NULL, NULL, NULL, '${candidateInput.createdAt}', NULL, NULL
      );
      INSERT INTO workspace_allocations(
        id, project_id, application_id, execution_profile_id,
        execution_profile_revision, operation_key, state, repository_root,
        allocation_root, source_branch, base_commit, expected_source_tip,
        capability_snapshot_json, capability_snapshot_hash,
        provision_command_id, revision, created_at, updated_at,
        work_package_version_id, node_attempt_id
      ) VALUES (
        'wp-allocation-command-v3', 'project-1', 'application-1', 'profile-1', 1,
        'wp-operation-command-v3', 'planned', '/repo', '/allocation-v3', 'branch',
        '${"a".repeat(40)}', '${"a".repeat(40)}', '{}', '${hash("command-v3-capability")}',
        'ordinary-version-command', 0, '${candidateInput.createdAt}',
        '${candidateInput.createdAt}', 'wp-command-v3', 'wp-attempt-command-v3'
      );
      INSERT INTO work_package_assignments(
        id, work_package_version_id, node_attempt_id, position_id,
        ai_member_id, agent_adapter_id, rationale_json, allocation_id,
        interaction_session_id, sandbox_identity, evidence_scope, state,
        created_at, updated_at
      ) VALUES (
        'wp-assignment-command-v3', 'wp-command-v3', 'wp-attempt-command-v3',
        'position-1', 'member-1', 'scripted', '{}', 'wp-allocation-command-v3',
        'session-command-v3', 'sandbox-command-v3', 'evidence-command-v3',
        'assigned', '${candidateInput.createdAt}', '${candidateInput.createdAt}'
      );
    `);
    assert.throws(
      () =>
        runtime.recover({
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
          candidateId: candidate.id,
          expectedCandidateHash: candidate.manifestHash,
          decisionId: "release-decision-work-package-rework",
          authority: { kind: "work-package-version", id: "wp-command-v3" },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_REWORK_AUTHORITY_INVALID",
    );
    database.exec(`
      UPDATE work_package_versions SET status = 'superseded'
       WHERE id = 'wp-command-v3';
      UPDATE work_package_versions SET status = 'ready'
       WHERE id = 'wp-command-v2';
    `);
    runtime.recover({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decisionId: "release-decision-work-package-rework",
      authority: { kind: "work-package-version", id: "wp-command-v2" },
    });
    assert.equal(activations.length, 1);
    assert.equal(
      (activations[0] as { readonly targetNodeRunId: string }).targetNodeRunId,
      "development-node-command",
    );
    database.close();
  });

  it("routes Contract, Integration Defect, and Test Defect responsibility through exact formal rework authority", () => {
    const exerciseWorkPackageRoute = (
      suffix: string,
      responsibility: {
        readonly kind: "contract" | "defect";
        readonly id: string;
        readonly summary: string;
      },
      seedRoute: (database: DatabaseSync, priorVersionId: string) => void,
    ) => {
      const database = new DatabaseSync(":memory:");
      migrateCompanyDatabase(database);
      database.exec("PRAGMA foreign_keys = OFF");
      const workPackage = seedFormalWorkPackageReworkAuthority(
        database,
        suffix,
      );
      seedRoute(database, workPackage.priorVersionId);
      const baseInput = candidateInputFor(`candidate-input-${suffix}`);
      const input = {
        ...baseInput,
        manifest: {
          ...baseInput.manifest,
          codeReviewCoverage: [
            {
              workPackageId: workPackage.packageId,
              workPackageVersionId: workPackage.priorVersionId,
            },
          ] as never,
        },
      };
      const authority = gateAuthorityFor(input);
      const activations: unknown[] = [];
      const runtime = openDeliveryRuntime(database, {
        candidateInputs: { inspect: () => input },
        qualityGates: { downstreamAuthority: () => authority },
        pipelineRuntime: {
          completeDeliveryCandidateInTransaction: () => {},
          resolveHumanReleaseNodeInTransaction: () => ({
            humanReleaseNodeRunId: "human-release-node-1",
          }),
          applyHumanReleaseDecisionInTransaction: () => {},
          activateHumanReleaseReworkInTransaction: (activation) => {
            activations.push(activation);
          },
          validateReleaseBoundaryChildInTransaction: () => {},
        },
        clock: () => new Date(candidateInput.createdAt),
      });
      const candidate = runtime.assemble({
        candidateId: `delivery-candidate-${suffix}`,
        requestId: `delivery-candidate-${suffix}-request`,
        candidateInputId: input.id,
        expectedCandidateInputHash: input.manifestHash,
        expectedGateAuthorityHash: authority.authorityHash,
        nodeRunId: `delivery-candidate-node-${suffix}`,
        nodeAttemptId: `delivery-candidate-attempt-${suffix}`,
        leaseId: `delivery-candidate-lease-${suffix}`,
        workerId: "delivery-candidate-node-handler",
      });
      runtime.decide({
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
        decisionId: `release-decision-${suffix}`,
        candidateId: candidate.id,
        expectedCandidateHash: candidate.manifestHash,
        decision: "changes-requested",
        reason: "The exact frozen responsibility requires formal rework.",
        evidenceRefs: ["artifact-version:artifact-version-1"],
        rework: { scope: "same-boundary", responsibility },
      });
      runtime.recover({
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
        candidateId: candidate.id,
        expectedCandidateHash: candidate.manifestHash,
        decisionId: `release-decision-${suffix}`,
        authority: {
          kind: "work-package-version",
          id: workPackage.freshVersionId,
        },
      });
      assert.equal(activations.length, 1);
      assert.equal(
        (activations[0] as { readonly targetNodeRunId: string })
          .targetNodeRunId,
        workPackage.nodeRunId,
      );
      database.close();
    };

    exerciseWorkPackageRoute(
      "contract-route",
      {
        kind: "contract",
        id: "contract-1",
        summary: "Rework the exact Contract producer.",
      },
      (database, priorVersionId) => {
        const manifest = JSON.stringify({
          requiredValidations: [
            {
              contract: { id: "contract-1", version: "1" },
              responsibleWorkPackageVersionIds: [priorVersionId],
            },
          ],
        }).replaceAll("'", "''");
        database.exec(`
          INSERT INTO integration_generations(
            id, project_id, run_id, snapshot_revision_id, node_run_id,
            generation, coverage_id, coverage_node_run_id,
            coverage_node_attempt_id, coverage_hash, manifest_json,
            manifest_hash, state, pass_authority_hash, created_at, updated_at
          ) VALUES (
            'integration-generation-1', 'project-1', 'run-1', 'snapshot-1',
            'integration-node-contract-route', 1, 'coverage-contract-route',
            'coverage-node-contract-route', 'coverage-attempt-contract-route',
            '${hash("coverage-contract-route")}', '${manifest}',
            '${hash("integration-manifest")}', 'passed',
            '${hash("integration-authority")}', '${candidateInput.createdAt}',
            '${candidateInput.createdAt}'
          );
        `);
      },
    );

    exerciseWorkPackageRoute(
      "integration-defect-route",
      {
        kind: "defect",
        id: "integration-defect-route-1",
        summary: "Rework the exact Integration Defect owner.",
      },
      (database, priorVersionId) => {
        database.exec(`
          INSERT INTO integration_generations(
            id, project_id, run_id, snapshot_revision_id, node_run_id,
            generation, coverage_id, coverage_node_run_id,
            coverage_node_attempt_id, coverage_hash, manifest_json,
            manifest_hash, state, pass_authority_hash, created_at, updated_at
          ) VALUES (
            'integration-generation-1', 'project-1', 'run-1', 'snapshot-1',
            'integration-node-defect-route', 1, 'coverage-defect-route',
            'coverage-node-defect-route', 'coverage-attempt-defect-route',
            '${hash("coverage-defect-route")}', '{}',
            '${hash("integration-manifest")}', 'passed',
            '${hash("integration-authority")}', '${candidateInput.createdAt}',
            '${candidateInput.createdAt}'
          );
          INSERT INTO integration_defects(
            id, generation_id, kind, responsibility_json, evidence_json,
            status, created_at
          ) VALUES (
            'integration-defect-route-1', 'integration-generation-1',
            'build-test',
            '{"workPackageVersionIds":["${priorVersionId}"]}', '[]',
            'open', '${candidateInput.createdAt}'
          );
        `);
      },
    );

    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const testRework = seedFormalTestReworkAuthority(
      database,
      "defect-route",
      "running",
      "test-defect-route-1",
    );
    const baseInput = candidateInputFor("candidate-input-test-defect-route");
    const input = {
      ...baseInput,
      manifest: {
        ...baseInput.manifest,
        tests: [
          {
            testRunId: testRework.priorTestRunId,
            passAuthorityHash: hash("prior-test-pass"),
          },
        ] as never,
      },
    };
    const authority = gateAuthorityFor(input);
    const activations: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => input },
      qualityGates: { downstreamAuthority: () => authority },
      tests: {
        downstreamAuthority: (testRunId) =>
          ({
            schemaVersion: 1,
            testRunId,
            manifestHash: hash("fresh-test-manifest"),
            passAuthorityHash: hash("fresh-test-pass"),
          }) as never,
      },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: () => {},
        activateHumanReleaseReworkInTransaction: (activation) => {
          activations.push(activation);
        },
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const candidate = runtime.assemble({
      candidateId: "delivery-candidate-test-defect-route",
      requestId: "delivery-candidate-test-defect-route-request",
      candidateInputId: input.id,
      expectedCandidateInputHash: input.manifestHash,
      expectedGateAuthorityHash: authority.authorityHash,
      nodeRunId: "delivery-candidate-node-test-defect-route",
      nodeAttemptId: "delivery-candidate-attempt-test-defect-route",
      leaseId: "delivery-candidate-lease-test-defect-route",
      workerId: "delivery-candidate-node-handler",
    });
    runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-test-defect-route",
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decision: "changes-requested",
      reason: "The exact Test Defect requires formal rework.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
      rework: {
        scope: "same-boundary",
        responsibility: {
          kind: "defect",
          id: "test-defect-route-1",
          summary: "Rework the exact Test Defect owner.",
        },
      },
    });
    database.exec(`
      INSERT INTO test_runs(
        id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
        node_attempt_id, session_id, integration_generation_id,
        integration_manifest_hash, integration_pass_authority_hash,
        manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
        failure_code, failure_message, created_at, updated_at
      ) SELECT
        'test-rework-run-wrong-defect', 'test-request-wrong-defect', project_id,
        run_id, snapshot_revision_id, 'test-node-wrong-defect',
        'test-attempt-wrong-defect', 'test-session-wrong-defect',
        integration_generation_id, integration_manifest_hash,
        integration_pass_authority_hash, manifest_json,
        '${hash("fresh-test-manifest")}', '${hash("wrong-defect-request")}',
        'passed', '${hash("fresh-test-pass")}', NULL, NULL, created_at, updated_at
        FROM test_runs WHERE id = '${testRework.freshTestRunId}';
      INSERT INTO test_defects(
        id, test_run_id, test_case_revision_id, assertion_id,
        integration_generation_id, responsibility_json, evidence_json,
        status, created_at, closed_at
      ) VALUES (
        'test-defect-wrong-route', '${testRework.priorTestRunId}',
        'test-case-revision-wrong-route', 'assertion-wrong-route',
        'integration-generation-1', '{}', '[]', 'closed',
        '${candidateInput.createdAt}', '${candidateInput.createdAt}'
      );
      INSERT INTO test_rework_runs(
        id, defect_id, prior_test_run_id, fresh_test_run_id, route_json,
        lineage_json, lineage_hash, created_at
      ) VALUES (
        'test-rework-record-wrong-defect', 'test-defect-wrong-route',
        '${testRework.priorTestRunId}', 'test-rework-run-wrong-defect', '{}', '{}',
        '${hash("wrong-defect-lineage")}', '${candidateInput.createdAt}'
      );
      INSERT INTO test_defect_resolutions(
        id, defect_id, resolution_json, resolution_hash, created_at
      ) VALUES (
        'test-resolution-wrong-defect', 'test-defect-wrong-route',
        '{"schemaVersion":1,"resolvedByTestRunId":"test-rework-run-wrong-defect","passAuthorityHash":"${hash("fresh-test-pass")}","assertions":[]}',
        '${hash("wrong-defect-resolution")}', '${candidateInput.createdAt}'
      );
      INSERT INTO runtime_audit_records(
        id, action, entity_type, entity_id, run_id, node_run_id,
        before_json, after_json, created_at, command_id, actor_type,
        actor_id, authenticated_by, consumer_id
      ) VALUES
        ('wrong-defect-accepted-audit', 'test.run.accepted', 'test-run',
         'test-rework-run-wrong-defect', 'run-1', 'test-node-wrong-defect', NULL, '{}',
         '${candidateInput.createdAt}', 'wrong-defect-create-command',
         'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime'),
        ('wrong-defect-completed-audit', 'test.run.completed', 'test-run',
         'test-rework-run-wrong-defect', 'run-1', 'test-node-wrong-defect', NULL, '{}',
         '${candidateInput.createdAt}', 'wrong-defect-complete-command',
         'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime');
      INSERT INTO command_deduplication(
        command_id, actor_type, actor_id, authenticated_by, consumer_id,
        schema_version, request_hash, status, result_json, result_hash,
        effect_ids_json, completed_at
      ) VALUES
        ('wrong-defect-create-command', 'runtime-worker', 'test-runtime',
         'company-runtime', 'test-runtime', 1, '${hash("wrong-create-request")}',
         'completed', '{}', '${hash("{}")}', '["wrong-defect-accepted-audit"]',
         '${candidateInput.createdAt}'),
        ('wrong-defect-complete-command', 'runtime-worker', 'test-runtime',
         'company-runtime', 'test-runtime', 1, '${hash("wrong-complete-request")}',
         'completed', '{}', '${hash("{}")}', '["wrong-defect-completed-audit"]',
         '${candidateInput.createdAt}');
      UPDATE test_runs
         SET state = 'failed', failure_code = 'TEST_FAILED',
             failure_message = 'failed', updated_at = '${candidateInput.createdAt}'
       WHERE id = '${testRework.priorTestRunId}';
    `);
    assert.throws(
      () =>
        runtime.recover({
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
          candidateId: candidate.id,
          expectedCandidateHash: candidate.manifestHash,
          decisionId: "release-decision-test-defect-route",
          authority: {
            kind: "test-rework-run",
            id: "test-rework-run-wrong-defect",
          },
        }),
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_REWORK_AUTHORITY_INVALID",
    );
    runtime.recover({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decisionId: "release-decision-test-defect-route",
      authority: {
        kind: "test-rework-run",
        id: testRework.freshTestRunId,
      },
    });
    assert.equal(activations.length, 1);
    database.close();
  });

  it("starts an exact Gate full recheck explicitly and keeps unknown responsibility blocked", () => {
    const exercise = (
      suffix: string,
      responsibility: {
        readonly kind: "gate" | "defect" | "unknown";
        readonly id?: string;
        readonly summary: string;
      },
    ) => {
      const database = new DatabaseSync(":memory:");
      migrateCompanyDatabase(database);
      database.exec("PRAGMA foreign_keys = OFF");
      const input = candidateInputFor(`candidate-input-${suffix}`);
      const authority = gateAuthorityFor(input);
      const activations: unknown[] = [];
      const runtime = openDeliveryRuntime(database, {
        candidateInputs: { inspect: () => input },
        qualityGates: { downstreamAuthority: () => authority },
        pipelineRuntime: {
          completeDeliveryCandidateInTransaction: () => {},
          resolveHumanReleaseNodeInTransaction: () => ({
            humanReleaseNodeRunId: "human-release-node-1",
          }),
          applyHumanReleaseDecisionInTransaction: () => {},
          activateHumanReleaseReworkInTransaction: (activation) => {
            activations.push(activation);
          },
          validateReleaseBoundaryChildInTransaction: () => {},
        },
        clock: () => new Date(candidateInput.createdAt),
      });
      const candidate = runtime.assemble({
        candidateId: `delivery-candidate-${suffix}`,
        requestId: `delivery-candidate-${suffix}-request`,
        candidateInputId: input.id,
        expectedCandidateInputHash: input.manifestHash,
        expectedGateAuthorityHash: authority.authorityHash,
        nodeRunId: `delivery-candidate-node-${suffix}`,
        nodeAttemptId: `delivery-candidate-attempt-${suffix}`,
        leaseId: `delivery-candidate-lease-${suffix}`,
        workerId: "delivery-candidate-node-handler",
      });
      runtime.decide({
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
        decisionId: `release-decision-${suffix}`,
        candidateId: candidate.id,
        expectedCandidateHash: candidate.manifestHash,
        decision: "changes-requested",
        reason: "The exact frozen responsibility requires recheck.",
        evidenceRefs: ["artifact-version:artifact-version-1"],
        rework: { scope: "same-boundary", responsibility },
      });
      const recover = () =>
        runtime.recover({
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
          candidateId: candidate.id,
          expectedCandidateHash: candidate.manifestHash,
          decisionId: `release-decision-${suffix}`,
          authority: {
            kind: "candidate-input-recheck",
            id: input.id,
          },
        });
      return { activations, database, recover };
    };

    const gate = exercise("gate-recheck", {
      kind: "gate",
      id: "security-result-1",
      summary: "Recheck the exact Security Gate lineage.",
    });
    assert.doesNotThrow(gate.recover);
    assert.equal(gate.activations.length, 1);
    gate.database.close();

    const gateDefect = exercise("gate-defect-recheck", {
      kind: "defect",
      id: "candidate-gate-defect-1",
      summary: "Resolve the exact Candidate Gate Defect through full recheck.",
    });
    gateDefect.database.exec(`
      INSERT INTO candidate_gate_inputs(
        id, request_id, candidate_input_id, candidate_input_hash, kind,
        node_run_id, node_attempt_id, review_topic_id, prior_gate_input_id,
        reviewer_position_id, reviewer_session_id, manifest_json,
        manifest_hash, request_hash, risk_tier, review_depth, state,
        created_at, updated_at
      ) VALUES (
        'candidate-gate-input-defect-1', 'candidate-gate-input-defect-request-1',
        'candidate-input-gate-defect-recheck', '${hash("candidate-input-gate-defect-recheck")}',
        'security', 'security-node-1', 'security-attempt-1', 'review-topic-1',
        NULL, 'security-reviewer', 'security-session', '{}', '${hash("gate-manifest")}',
        '${hash("gate-request")}', 'high', 'deep-independent', 'completed',
        '${candidateInput.createdAt}', '${candidateInput.createdAt}'
      );
      INSERT INTO candidate_gate_defects(
        id, gate_input_id, check_id, responsibility_json, evidence_json,
        status, created_at, closed_at
      ) VALUES (
        'candidate-gate-defect-1', 'candidate-gate-input-defect-1',
        'security-check-1', '{}', '[]', 'open',
        '${candidateInput.createdAt}', NULL
      );
    `);
    assert.doesNotThrow(gateDefect.recover);
    assert.equal(gateDefect.activations.length, 1);
    gateDefect.database.close();

    const unknown = exercise("unknown-recheck", {
      kind: "unknown",
      summary: "The responsibility has not been resolved.",
    });
    assert.throws(
      unknown.recover,
      (error: unknown) =>
        error instanceof DeliveryRuntimeError &&
        error.code === "RELEASE_REWORK_RESPONSIBILITY_UNRESOLVED",
    );
    assert.equal(unknown.activations.length, 0);
    unknown.database.close();
  });

  it("accepts only a fresh formal PASS Test rework authority", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const input = candidateInputFor("candidate-input-test-rework");
    const authority = gateAuthorityFor(input);
    const activations: unknown[] = [];
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => input },
      qualityGates: { downstreamAuthority: () => authority },
      tests: {
        downstreamAuthority: (testRunId) =>
          ({
            schemaVersion: 1,
            testRunId,
            manifestHash: hash("fresh-test-manifest"),
            passAuthorityHash: hash("fresh-test-pass"),
          }) as never,
      },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {},
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: () => {},
        activateHumanReleaseReworkInTransaction: (activation) => {
          activations.push(activation);
        },
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      clock: () => new Date(candidateInput.createdAt),
    });
    const candidate = runtime.assemble({
      candidateId: "delivery-candidate-test-rework",
      requestId: "delivery-candidate-test-rework-request",
      candidateInputId: input.id,
      expectedCandidateInputHash: input.manifestHash,
      expectedGateAuthorityHash: authority.authorityHash,
      nodeRunId: "delivery-candidate-node-test",
      nodeAttemptId: "delivery-candidate-attempt-test",
      leaseId: "delivery-candidate-lease-test",
      workerId: "delivery-candidate-node-handler",
    });
    runtime.decide({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      decisionId: "release-decision-test-rework",
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decision: "changes-requested",
      reason: "The exact Test Run requires formal rework.",
      evidenceRefs: ["artifact-version:artifact-version-1"],
      rework: {
        scope: "same-boundary",
        responsibility: {
          kind: "test",
          id: "test-run-1",
          summary: "Rework the frozen Test Run.",
        },
      },
    });
    database.exec(`
      INSERT INTO test_runs(
        id, request_id, project_id, run_id, snapshot_revision_id, node_run_id,
        node_attempt_id, session_id, integration_generation_id,
        integration_manifest_hash, integration_pass_authority_hash,
        manifest_json, manifest_hash, request_hash, state, pass_authority_hash,
        failure_code, failure_message, created_at, updated_at
      ) VALUES
        ('test-run-1', 'test-request-1', 'project-1', 'run-1', 'snapshot-1',
         'test-node-1', 'test-attempt-1', 'test-session-1',
         'integration-generation-1', '${hash("integration-manifest")}',
         '${hash("integration-authority")}', '{}', '${hash("prior-test-manifest")}',
         '${hash("prior-test-request")}', 'running', NULL, NULL,
         NULL, '${candidateInput.createdAt}', '${candidateInput.createdAt}'),
        ('test-rework-run-2', 'test-request-2', 'project-1', 'run-1', 'snapshot-1',
         'test-node-2', 'test-attempt-2', 'test-session-2',
         'integration-generation-1', '${hash("integration-manifest")}',
         '${hash("integration-authority")}', '{}', '${hash("fresh-test-manifest")}',
         '${hash("fresh-test-request")}', 'passed', '${hash("fresh-test-pass")}',
         NULL, NULL, '${candidateInput.createdAt}', '${candidateInput.createdAt}');
      INSERT INTO test_rework_runs(
        id, defect_id, prior_test_run_id, fresh_test_run_id, route_json,
        lineage_json, lineage_hash, created_at
      ) VALUES (
        'test-rework-record-2', 'test-defect-1', 'test-run-1',
        'test-rework-run-2', '{}', '{}', '${hash("test-rework-lineage")}',
        '${candidateInput.createdAt}'
      );
      INSERT INTO test_defects(
        id, test_run_id, test_case_revision_id, assertion_id,
        integration_generation_id, responsibility_json, evidence_json,
        status, created_at, closed_at
      ) VALUES (
        'test-defect-1', 'test-run-1', 'test-case-revision-1', 'assertion-1',
        'integration-generation-1', '{}', '[]', 'closed',
        '${candidateInput.createdAt}', '${candidateInput.createdAt}'
      );
      INSERT INTO test_defect_resolutions(
        id, defect_id, resolution_json, resolution_hash, created_at
      ) VALUES (
        'test-resolution-1', 'test-defect-1',
        '{"schemaVersion":1,"resolvedByTestRunId":"test-rework-run-2","passAuthorityHash":"${hash("fresh-test-pass")}","assertions":[]}',
        '${hash("test-resolution-1")}', '${candidateInput.createdAt}'
      );
      UPDATE test_runs
         SET state = 'failed', failure_code = 'TEST_FAILED',
             failure_message = 'failed', updated_at = '${candidateInput.createdAt}'
       WHERE id = 'test-run-1';
      INSERT INTO runtime_audit_records(
        id, action, entity_type, entity_id, run_id, node_run_id,
        before_json, after_json, created_at, command_id, actor_type,
        actor_id, authenticated_by, consumer_id
      ) VALUES
        ('test-rework-accepted-audit', 'test.run.accepted', 'test-run',
         'test-rework-run-2', 'run-1', 'test-node-2', NULL, '{}',
         '${candidateInput.createdAt}', 'test-rework-create-command',
         'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime'),
        ('test-rework-completed-audit', 'test.run.completed', 'test-run',
         'test-rework-run-2', 'run-1', 'test-node-2', NULL, '{}',
         '${candidateInput.createdAt}', 'test-rework-complete-command',
         'runtime-worker', 'test-runtime', 'company-runtime', 'test-runtime');
      INSERT INTO command_deduplication(
        command_id, actor_type, actor_id, authenticated_by, consumer_id,
        schema_version, request_hash, status, result_json, result_hash,
        effect_ids_json, completed_at
      ) VALUES
        ('test-rework-create-command', 'runtime-worker', 'test-runtime',
         'company-runtime', 'test-runtime', 1,
         '${hash("test-rework-create-request")}', 'completed', '{}',
         '${hash("{}")}', '["test-rework-accepted-audit"]',
         '${candidateInput.createdAt}'),
        ('test-rework-complete-command', 'runtime-worker', 'test-runtime',
         'company-runtime', 'test-runtime', 1,
         '${hash("test-rework-complete-request")}', 'completed', '{}',
         '${hash("{}")}', '["test-rework-completed-audit"]',
         '${candidateInput.createdAt}');
    `);
    runtime.recover({
      actor: {
        type: "human",
        id: "local-release-owner",
        authenticatedBy: "local-session",
      },
      candidateId: candidate.id,
      expectedCandidateHash: candidate.manifestHash,
      decisionId: "release-decision-test-rework",
      authority: { kind: "test-rework-run", id: "test-rework-run-2" },
    });
    assert.equal(activations.length, 1);
    assert.equal(
      (activations[0] as { readonly targetNodeRunId: string }).targetNodeRunId,
      "candidate-input-node-1",
    );
    database.close();
  });

  it("persists formal recovery through the Company Database and rebuilds activation evidence after reload", () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-delivery-recovery-"),
    );
    try {
      openCompanyDatabase(companyDir).close();
      const database = new DatabaseSync(
        join(companyDir, ".sandcastle", "company.sqlite"),
      );
      database.exec("PRAGMA foreign_keys = OFF");
      const input = candidateInputFor("candidate-input-company-recovery");
      const authority = gateAuthorityFor(input);
      const runtime = openDeliveryRuntime(database, {
        candidateInputs: { inspect: () => input },
        qualityGates: { downstreamAuthority: () => authority },
        pipelineRuntime: {
          completeDeliveryCandidateInTransaction: () => {},
          resolveHumanReleaseNodeInTransaction: () => ({
            humanReleaseNodeRunId: "human-release-node-1",
          }),
          applyHumanReleaseDecisionInTransaction: () => {},
          activateHumanReleaseReworkInTransaction: () => {},
          validateReleaseBoundaryChildInTransaction: () => {},
        },
        events: openRuntimeEvents(database),
        clock: () => new Date(candidateInput.createdAt),
      });
      const registry = openCompanyCommandRegistry(
        database,
        openProjectConfiguration(database),
        undefined,
        () => new Date(candidateInput.createdAt),
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        runtime,
      );
      const assembled = registry.execute({
        schemaVersion: 1,
        commandId: "company-recovery-assemble-command",
        actor: {
          type: "runtime-worker",
          id: "delivery-candidate-node-handler",
          authenticatedBy: "runtime",
        },
        consumerId: "delivery-candidate-node-handler",
        command: {
          type: "delivery.candidate.assemble",
          candidateId: "delivery-candidate-company-recovery",
          requestId: "delivery-candidate-company-recovery-request",
          candidateInputId: input.id,
          expectedCandidateInputHash: input.manifestHash,
          expectedGateAuthorityHash: authority.authorityHash,
          nodeRunId: "delivery-candidate-node-company-recovery",
          nodeAttemptId: "delivery-candidate-attempt-company-recovery",
          leaseId: "delivery-candidate-lease-company-recovery",
          workerId: "delivery-candidate-node-handler",
        },
      });
      assert.equal(assembled.status, "succeeded", JSON.stringify(assembled));
      if (assembled.status !== "succeeded") assert.fail("assembly failed");
      const decided = registry.execute({
        schemaVersion: 1,
        commandId: "company-recovery-decision-command",
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
        consumerId: "desktop-human-release",
        command: {
          type: "delivery.release.decide",
          decisionId: "company-recovery-decision",
          candidateId: assembled.value.id,
          expectedCandidateHash: assembled.value.manifestHash,
          decision: "changes-requested",
          reason: "The frozen Candidate requires a formal full recheck.",
          evidenceRefs: ["artifact-version:artifact-version-1"],
          rework: {
            scope: "same-boundary",
            responsibility: {
              kind: "aggregate",
              summary: "Repeat all formal Candidate checks.",
            },
          },
        },
      });
      assert.equal(decided.status, "succeeded", JSON.stringify(decided));
      const recovered = registry.execute({
        schemaVersion: 1,
        commandId: "company-recovery-activation-command",
        actor: {
          type: "human",
          id: "local-release-owner",
          authenticatedBy: "local-session",
        },
        consumerId: "desktop-human-release",
        command: {
          type: "delivery.release.recover",
          decisionId: "company-recovery-decision",
          candidateId: assembled.value.id,
          expectedCandidateHash: assembled.value.manifestHash,
          authority: {
            kind: "candidate-input-recheck",
            id: input.id,
          },
        },
      });
      assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
      if (recovered.status !== "succeeded") assert.fail("recovery failed");
      assert.equal(recovered.value.projection, "changes-requested");
      assert.equal(
        recovered.value.recoveryActivation?.commandId,
        "company-recovery-activation-command",
      );
      assert.equal(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = 'delivery.release.rework-activated'",
            )
            .get() as { readonly count: number }
        ).count,
        1,
      );
      database.close();

      const reopened = openCompanyDatabase(companyDir);
      try {
        const reloaded = reopened.delivery.inspect(assembled.value.id);
        assert.equal(reloaded.projection, "changes-requested");
        assert.equal(
          reloaded.recoveryActivation?.activationHash,
          recovered.value.recoveryActivation?.activationHash,
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(companyDir, { recursive: true, force: true });
    }
  });

  it("persists Candidate and Human release Commands atomically with replay receipts", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE delivery_command_markers(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
      ) STRICT;
    `);
    const input = candidateInputFor("candidate-input-command");
    const authority = gateAuthorityFor(input);
    let failDecisionAfterPipelineWrite = true;
    const runtime = openDeliveryRuntime(database, {
      candidateInputs: { inspect: () => input },
      qualityGates: { downstreamAuthority: () => authority },
      pipelineRuntime: {
        completeDeliveryCandidateInTransaction: () => {
          database
            .prepare(
              "INSERT INTO delivery_command_markers(id, kind) VALUES ('candidate-transition', 'candidate')",
            )
            .run();
        },
        resolveHumanReleaseNodeInTransaction: () => ({
          humanReleaseNodeRunId: "human-release-node-1",
        }),
        applyHumanReleaseDecisionInTransaction: () => {
          database
            .prepare(
              "INSERT INTO delivery_command_markers(id, kind) VALUES ('decision-transition', 'decision')",
            )
            .run();
          if (failDecisionAfterPipelineWrite) {
            throw new Error("injected decision crash");
          }
        },
        activateHumanReleaseReworkInTransaction: () => {},
        validateReleaseBoundaryChildInTransaction: () => {},
      },
      events: openRuntimeEvents(database),
      clock: () => new Date(candidateInput.createdAt),
    });
    const registry = openCompanyCommandRegistry(
      database,
      openProjectConfiguration(database),
      undefined,
      () => new Date(candidateInput.createdAt),
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    const assemble = {
      schemaVersion: 1 as const,
      commandId: "delivery-candidate-command",
      actor: {
        type: "runtime-worker" as const,
        id: "delivery-candidate-node-handler",
        authenticatedBy: "runtime" as const,
      },
      consumerId: "delivery-candidate-node-handler",
      command: {
        type: "delivery.candidate.assemble" as const,
        candidateId: "delivery-candidate-command",
        requestId: "delivery-candidate-command-request",
        candidateInputId: input.id,
        expectedCandidateInputHash: input.manifestHash,
        expectedGateAuthorityHash: authority.authorityHash,
        nodeRunId: "delivery-candidate-node-command",
        nodeAttemptId: "delivery-candidate-attempt-command",
        leaseId: "delivery-candidate-lease-command",
        workerId: "delivery-candidate-node-handler",
      },
    };
    const assembled = registry.execute(assemble);
    assert.equal(assembled.status, "succeeded", JSON.stringify(assembled));
    assert.deepEqual(registry.execute(assemble), assembled);
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM delivery_candidates WHERE id = ?",
          )
          .get(assemble.command.candidateId) as { readonly count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = 'delivery.candidate.created'",
          )
          .get() as { readonly count: number }
      ).count,
      1,
    );

    const decision = {
      schemaVersion: 1 as const,
      commandId: "human-release-command",
      actor: {
        type: "human" as const,
        id: "local-release-owner",
        authenticatedBy: "local-session" as const,
      },
      consumerId: "desktop-human-release",
      command: {
        type: "delivery.release.decide" as const,
        decisionId: "human-release-decision-command",
        candidateId: assemble.command.candidateId,
        expectedCandidateHash:
          assembled.status === "succeeded"
            ? assembled.value.manifestHash
            : "0".repeat(64),
        decision: "accepted" as const,
        reason: "The immutable evidence was reviewed in the local session.",
        comment: "Approved.",
        evidenceRefs: ["artifact-version:artifact-version-1"],
      },
    };
    assert.throws(() => registry.execute(decision), /injected decision crash/);
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM human_release_decisions WHERE id = ?",
          )
          .get(decision.command.decisionId) as { readonly count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM delivery_command_markers WHERE id = 'decision-transition'",
          )
          .get() as { readonly count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(decision.commandId) as { readonly count: number }
      ).count,
      0,
    );

    failDecisionAfterPipelineWrite = false;
    const accepted = registry.execute(decision);
    assert.equal(accepted.status, "succeeded", JSON.stringify(accepted));
    assert.deepEqual(registry.execute(decision), accepted);
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM human_release_decisions WHERE id = ?",
          )
          .get(decision.command.decisionId) as { readonly count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM accepted_delivery_candidate_authorities WHERE candidate_id = ?",
          )
          .get(decision.command.candidateId) as { readonly count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = 'delivery.release.accepted'",
          )
          .get() as { readonly count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM runtime_unit_of_work_context")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    database.close();
  });
});
