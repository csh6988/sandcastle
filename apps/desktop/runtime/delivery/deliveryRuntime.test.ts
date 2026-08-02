import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyCommandRegistry } from "../commandRegistry.js";
import { openRuntimeEvents } from "../events/subscription.js";
import { openProjectConfiguration } from "../project/projectConfiguration.js";
import type { DeliveryCandidateInputView } from "./candidateInputRuntime.js";
import type { DeliveryCandidateInputGateAuthority } from "../quality/qualityGateRuntime.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
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
