import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { DeliveryCandidateInputView } from "../delivery/candidateInputRuntime.js";
import type { CandidateInputRuntime } from "../delivery/candidateInputRuntime.js";
import { openCompanyCommandRegistry } from "../commandRegistry.js";
import { openRuntimeEvents } from "../events/subscription.js";
import { openProjectConfiguration } from "../project/projectConfiguration.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import {
  openQualityGateRuntime,
  QualityGateRuntimeError,
} from "./qualityGateRuntime.js";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const candidate = {
  id: "candidate-input-1",
  requestId: "candidate-request-1",
  manifestHash: hash("candidate-input-1"),
  state: "frozen-for-final-gates" as const,
  createdAt: "2026-07-30T00:00:00.000Z",
  manifest: {
    schemaVersion: 1 as const,
    candidateInputId: "candidate-input-1",
    projectId: "project-1",
    runId: "run-1",
    snapshot: {
      id: "snapshot-1",
      hash: hash("snapshot-1"),
      payload: { revision: 1 },
    },
    sourceNode: {
      nodeRunId: "candidate-node",
      nodeAttemptId: "candidate-attempt",
    },
    producer: {
      aiMemberId: "delivery-coordinator-member",
      positionId: "delivery-coordinator",
      sessionId: "candidate-session",
    },
    forbiddenReviewerIdentities: [
      {
        aiMemberId: "delivery-coordinator-member",
        positionId: "delivery-coordinator",
        sessionId: "candidate-session",
        reason: "producer" as const,
      },
      {
        aiMemberId: "implementer-member",
        positionId: "implementer-position",
        sessionId: "implementer-session",
        reason: "integration-assignment" as const,
      },
      {
        aiMemberId: "test-engineer-member",
        positionId: "test-engineer-position",
        sessionId: "test-engineer-session",
        reason: "test-engineer" as const,
      },
    ],
    product: {
      baselineId: "product-baseline-1",
      baselineHash: hash("product-baseline-1"),
      sourceProposalRevisionId: "product-proposal-1",
      sourceProposalHash: hash("product-proposal-1"),
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
    } as unknown as DeliveryCandidateInputView["manifest"]["integration"],
    repositoryCommits: [],
    contracts: [],
    tests: [
      {
        capabilities: [
          "branch",
          "git-ref-write-isolation",
          "runtime-import-only",
          "electron",
        ],
        executionProfile: { id: "isolated-profile", hash: hash("profile") },
        fixture: { id: "fixture-1", scriptHashes: [hash("fixture-script")] },
      } as unknown as DeliveryCandidateInputView["manifest"]["tests"][number],
    ],
    testCaseRevisions: [],
    evidence: [
      {
        id: "test-evidence-1",
        testRunId: "test-run-1",
        testCaseRevisionId: null,
        assertionId: null,
        kind: "runtime",
        mediaType: "application/json",
        contentHash: hash("test-evidence-1"),
        byteSize: 128,
        artifactVersionId: "artifact-evidence-1",
        redactionProfile: "candidate-safe-v1",
        retentionClass: "durable" as const,
        locator: "artifacts/evidence.json",
        metadata: { redacted: true },
      },
    ],
    artifacts: [],
    risk: {
      policyRevisionId: "delivery-candidate-risk@1" as const,
      policyHash: hash("delivery-candidate-risk@1"),
      factors: [
        {
          id: "user-visible-runtime",
          minimumTier: "high" as const,
          present: true,
          evidenceRefs: ["test-run:test-run-1"],
        },
      ],
      tier: "high" as const,
      inputHash: hash("candidate-risk-input"),
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
} satisfies DeliveryCandidateInputView;

const reviewManifest = (
  topicId: string,
  subject: DeliveryCandidateInputView = candidate,
) => ({
  scope: "verification",
  topicId,
  supportingArtifactVersionIds: ["artifact-evidence-1"],
  supportingSpecRevisionIds: ["project-spec-1"],
  harnessSnapshotIds: ["fixture-1"],
  acceptanceCriteria: [
    "Every required final quality check is evidence-backed.",
  ],
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
});

const seedReview = (
  database: DatabaseSync,
  input: {
    topicId: string;
    reviewerParticipantId: string;
    reviewerAiMemberId: string;
    reviewerPositionId: string;
    reviewerSessionId: string;
    eligible?: boolean;
    subject?: DeliveryCandidateInputView;
  },
): void => {
  const subject = input.subject ?? candidate;
  const manifest = reviewManifest(input.topicId, subject);
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
      input.topicId,
      subject.manifest.projectId,
      subject.manifest.runId,
      `Quality gate ${input.topicId}`,
      JSON.stringify(manifest),
      hash(JSON.stringify(manifest)),
      subject.manifest.producer.aiMemberId,
      subject.manifest.producer.positionId,
      subject.manifest.producer.sessionId,
      JSON.stringify({ maxRounds: 2 }),
      candidate.createdAt,
      candidate.createdAt,
    );
  const eligibility = {
    topicId: input.topicId,
    participantId: input.reviewerParticipantId,
    role: "reviewer-participant",
    aiMemberId: input.reviewerAiMemberId,
    positionId: input.reviewerPositionId,
    sessionId: input.reviewerSessionId,
    producer: subject.manifest.producer,
    projectId: subject.manifest.projectId,
    eligible: input.eligible ?? true,
    reasons: input.eligible === false ? ["producer-session"] : [],
  };
  database
    .prepare(
      `INSERT INTO review_participants(
         id, topic_id, role, ai_member_id, position_id, session_id, eligible,
         eligibility_reasons_json, eligibility_snapshot_json,
         eligibility_snapshot_hash, created_at
       ) VALUES (?, ?, 'reviewer-participant', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.reviewerParticipantId,
      input.topicId,
      input.reviewerAiMemberId,
      input.reviewerPositionId,
      input.reviewerSessionId,
      input.eligible === false ? 0 : 1,
      JSON.stringify(eligibility.reasons),
      JSON.stringify(eligibility),
      hash(JSON.stringify(eligibility)),
      candidate.createdAt,
    );
};

const openFixture = () => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  seedGateSource(database, {
    kind: "security",
    nodeRunId: "security-node-1",
    nodeAttemptId: "security-attempt-1",
  });
  seedGateSource(database, {
    kind: "operability",
    nodeRunId: "operability-node-1",
    nodeAttemptId: "operability-attempt-1",
  });
  const candidates = { inspect: () => candidate };
  const events = openRuntimeEvents(database, {
    clock: () => new Date(candidate.createdAt),
  });
  const runtime = openQualityGateRuntime(database, {
    candidates,
    events,
    clock: () => new Date(candidate.createdAt),
  });
  return {
    database,
    runtime: {
      ...runtime,
      prepare: (input: Omit<Parameters<typeof runtime.prepare>[0], "actor">) =>
        runtime.prepare({ ...input, actor: qualityGateActor }),
    },
    events,
  };
};

const qualityGateActor = {
  type: "runtime-worker" as const,
  id: "quality-gate-test-worker",
  authenticatedBy: "runtime" as const,
};

const seedGateSource = (
  database: DatabaseSync,
  input: {
    readonly kind: "security" | "operability";
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly workerId?: string;
  },
): void => {
  database
    .prepare(
      `INSERT INTO node_runs(
         id, run_id, pipeline_node_id, node_type, status, attempt_count,
         required_dependency_ids_json, created_at, updated_at, handler_kind_id
       ) VALUES (?, ?, ?, 'ai-task', 'running', 1, '[]', ?, ?, ?)`,
    )
    .run(
      input.nodeRunId,
      candidate.manifest.runId,
      input.nodeRunId,
      candidate.createdAt,
      candidate.createdAt,
      `${input.kind}-review@1`,
    );
  database
    .prepare(
      `INSERT INTO node_attempts(
         id, node_run_id, attempt_number, snapshot_revision_id, reason,
         status, created_at, started_at, lease_id, lease_owner,
         lease_expires_at
       ) VALUES (?, ?, 1, ?, 'initial', 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.nodeAttemptId,
      input.nodeRunId,
      candidate.manifest.snapshot.id,
      candidate.createdAt,
      candidate.createdAt,
      `${input.nodeAttemptId}:lease`,
      input.workerId ?? qualityGateActor.id,
      new Date(Date.parse(candidate.createdAt) + 300_000).toISOString(),
    );
};

const prepareInput = {
  gateInputId: "security-gate-input-1",
  requestId: "security-gate-request-1",
  kind: "security" as const,
  candidateInputId: candidate.id,
  expectedCandidateInputHash: candidate.manifestHash,
  expectedRiskTier: "high" as const,
  nodeRunId: "security-node-1",
  nodeAttemptId: "security-attempt-1",
  reviewTopicId: "security-topic-1",
  reviewerParticipantId: "security-reviewer-participant-1",
};

const seedExecutionFact = (
  database: DatabaseSync,
  input: {
    gateInputId: string;
    executionId: string;
    checks: readonly {
      checkId: string;
      status: "passed" | "missing" | "failed" | "unknown";
      evidence: readonly { kind: string; ref: string }[];
      responsibility: { kind: "aggregate"; candidateIds: readonly string[] };
    }[];
    resolutions?: readonly {
      subjectType: "defect" | "obligation";
      subjectId: string;
      evidenceRefs: readonly string[];
    }[];
  },
): void => {
  const fact = {
    schemaVersion: 1,
    gateInputId: input.gateInputId,
    checks: input.checks,
    resolutions: input.resolutions ?? [],
  };
  database
    .prepare(
      `INSERT INTO candidate_gate_executions(
         id, gate_input_id, operation_key, request_json, request_hash, state,
         fact_hash, receipt_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
    )
    .run(
      input.executionId,
      input.gateInputId,
      `operation:${input.executionId}`,
      JSON.stringify({ gateInputId: input.gateInputId }),
      hash(`request:${input.executionId}`),
      hash(JSON.stringify(fact)),
      hash(`receipt:${input.executionId}`),
      candidate.createdAt,
      candidate.createdAt,
    );
  database
    .prepare(
      `INSERT INTO candidate_gate_execution_facts(
         execution_id, fact_json, fact_hash, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.executionId,
      JSON.stringify(fact),
      hash(JSON.stringify(fact)),
      candidate.createdAt,
    );
};

const passingChecks = (
  prepared: ReturnType<ReturnType<typeof openFixture>["runtime"]["prepare"]>,
) =>
  prepared.manifest.checkCatalog.checks.map((check) => ({
    checkId: check.id,
    status: "passed" as const,
    evidence: check.requiredEvidenceKinds.map((kind) => ({
      kind,
      ref:
        kind === "artifact" || kind === "static-analysis"
          ? "artifact-version:artifact-evidence-1"
          : kind === "runtime-fact"
            ? "test-pass-authority:test-run-1"
            : "test-evidence:test-evidence-1",
    })),
    responsibility: {
      kind: "aggregate" as const,
      candidateIds: [prepared.manifest.candidateInput.id],
    },
  }));

const seedQualityGateResult = (
  database: DatabaseSync,
  input: {
    topicId: string;
    qualityGateResultId: string;
    result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
    conditions?: readonly string[];
    criticalFinding?: boolean;
  },
): void => {
  const topic = database
    .prepare(
      `SELECT manifest_json AS manifestJson, manifest_hash AS manifestHash
         FROM review_topics WHERE id = ?`,
    )
    .get(input.topicId) as { manifestJson: string; manifestHash: string };
  database
    .prepare("UPDATE review_topics SET status = ?, updated_at = ? WHERE id = ?")
    .run(input.result, candidate.createdAt, input.topicId);
  if (input.criticalFinding) {
    const participant = database
      .prepare(
        `SELECT id, session_id AS sessionId FROM review_participants
          WHERE topic_id = ? AND role = 'reviewer-participant'`,
      )
      .get(input.topicId) as { id: string; sessionId: string };
    database
      .prepare(
        `INSERT INTO review_findings(
           id, topic_id, reviewer_participant_id, reviewer_session_id, severity,
           summary, rationale, impact, evidence_refs_json, suggested_owner,
           blocking, created_at
         ) VALUES (?, ?, ?, ?, 'critical', ?, ?, ?, ?, 'aggregate', 1, ?)`,
      )
      .run(
        `finding:${input.topicId}`,
        input.topicId,
        participant.id,
        participant.sessionId,
        "Sandbox boundary can be crossed",
        "Recorded dynamic evidence crossed the frozen Repository boundary.",
        "Candidate authority is unsafe.",
        JSON.stringify(["dynamic-analysis:sandbox-boundary"]),
        candidate.createdAt,
      );
  }
  database
    .prepare(
      `INSERT INTO quality_gate_results(
         id, topic_id, kind, manifest_json, manifest_hash, revision_id, result,
         conditions_json, recheck_ids_json, evidence_refs_json, created_at
       ) VALUES (?, ?, 'verification', ?, ?, NULL, ?, ?, '[]', ?, ?)`,
    )
    .run(
      input.qualityGateResultId,
      input.topicId,
      topic.manifestJson,
      topic.manifestHash,
      input.result,
      JSON.stringify(input.conditions ?? []),
      JSON.stringify([`review-evidence:${input.topicId}`]),
      candidate.createdAt,
    );
};

const seedFinding = (
  database: DatabaseSync,
  input: {
    topicId: string;
    findingId: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    blocking: boolean;
  },
): void => {
  const participant = database
    .prepare(
      `SELECT id, session_id AS sessionId FROM review_participants
        WHERE topic_id = ? AND role = 'reviewer-participant'`,
    )
    .get(input.topicId) as { id: string; sessionId: string };
  database
    .prepare(
      `INSERT INTO review_findings(
         id, topic_id, reviewer_participant_id, reviewer_session_id, severity,
         summary, rationale, impact, evidence_refs_json, suggested_owner,
         blocking, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aggregate', ?, ?)`,
    )
    .run(
      input.findingId,
      input.topicId,
      participant.id,
      participant.sessionId,
      input.severity,
      `Finding ${input.findingId}`,
      "Independent evidence requires disposition.",
      "Candidate Gate result must reflect the latest disposition.",
      JSON.stringify(["artifact-version:artifact-evidence-1"]),
      input.blocking ? 1 : 0,
      candidate.createdAt,
    );
};

describe("Quality Gate Runtime input", () => {
  it("freezes Runtime-owned risk, deep review depth, and the complete Security catalog", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });

    const prepared = fixture.runtime.prepare(prepareInput);

    assert.equal(prepared.manifest.risk.tier, "high");
    assert.equal(prepared.manifest.reviewDepth, "deep-independent");
    assert.deepEqual(prepared.manifest.source, {
      runId: candidate.manifest.runId,
      nodeRunId: prepareInput.nodeRunId,
      nodeAttemptId: prepareInput.nodeAttemptId,
      handlerKindId: "security-review@1",
      attemptNumber: 1,
      snapshotRevisionId: candidate.manifest.snapshot.id,
      leaseId: `${prepareInput.nodeAttemptId}:lease`,
      workerId: qualityGateActor.id,
    });
    assert.deepEqual(
      prepared.manifest.checkCatalog.checks.map((check) => check.id),
      [
        "permission-auth",
        "secret-reference",
        "environment-forwarding",
        "sandbox-worktree-git-boundary",
        "network-filesystem-scope",
        "dependency-supply-chain",
        "data-pii-migration-destructive-action",
        "public-api",
        "cross-application-trust",
        "sensitive-logs",
        "rollback",
        "credential-materialization",
      ],
    );
    assert.deepEqual(prepared.manifest.harnessSnapshotRefs, [
      { id: "fixture-1", hashes: [hash("fixture-script")] },
    ]);
    assert.deepEqual(prepared.manifest.capabilities, [
      "branch",
      "electron",
      "git-ref-write-isolation",
      "runtime-import-only",
    ]);
    assert.deepEqual(fixture.runtime.inspect(prepared.id), prepared);
    assert.deepEqual(fixture.runtime.prepare(prepareInput), prepared);
    fixture.database.close();
  });

  it("rejects a missing or cross-kind Gate source Attempt", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });

    for (const input of [
      {
        ...prepareInput,
        gateInputId: "missing-source-gate-input",
        requestId: "missing-source-gate-request",
        nodeRunId: "missing-security-node",
        nodeAttemptId: "missing-security-attempt",
      },
      {
        ...prepareInput,
        gateInputId: "cross-kind-gate-input",
        requestId: "cross-kind-gate-request",
        kind: "operability" as const,
      },
    ]) {
      assert.throws(
        () => fixture.runtime.prepare(input),
        (error: unknown) =>
          error instanceof QualityGateRuntimeError &&
          error.code === "QUALITY_GATE_SOURCE_ATTEMPT_INVALID",
      );
    }
    fixture.database.close();
  });

  it("selects escalated depth for critical Operability input without shrinking its catalog", () => {
    const fixture = openFixture();
    const criticalCandidate = {
      ...candidate,
      id: "candidate-input-critical",
      manifestHash: hash("candidate-input-critical"),
      manifest: {
        ...candidate.manifest,
        candidateInputId: "candidate-input-critical",
        risk: {
          ...candidate.manifest.risk,
          tier: "critical" as const,
          factors: [
            ...candidate.manifest.risk.factors,
            {
              id: "destructive-action",
              minimumTier: "critical" as const,
              present: true,
              evidenceRefs: ["contract:destructive-operation"],
            },
          ],
        },
      },
    } satisfies DeliveryCandidateInputView;
    const runtime = openQualityGateRuntime(fixture.database, {
      candidates: { inspect: () => criticalCandidate },
      events: fixture.events,
      clock: () => new Date(candidate.createdAt),
    });
    const topicId = "operability-topic-critical";
    seedReview(fixture.database, {
      topicId,
      reviewerParticipantId: "operability-reviewer-participant-1",
      reviewerAiMemberId: "operability-reviewer-member",
      reviewerPositionId: "operability-reviewer",
      reviewerSessionId: "operability-review-session-1",
      subject: criticalCandidate,
    });

    const prepared = runtime.prepare({
      ...prepareInput,
      actor: qualityGateActor,
      gateInputId: "operability-gate-input-1",
      requestId: "operability-gate-request-1",
      kind: "operability",
      candidateInputId: criticalCandidate.id,
      expectedCandidateInputHash: criticalCandidate.manifestHash,
      expectedRiskTier: "critical",
      nodeRunId: "operability-node-1",
      nodeAttemptId: "operability-attempt-1",
      reviewTopicId: topicId,
      reviewerParticipantId: "operability-reviewer-participant-1",
    });

    assert.equal(prepared.manifest.reviewDepth, "deep-independent-escalated");
    assert.deepEqual(
      prepared.manifest.checkCatalog.checks.map((check) => check.id),
      [
        "startup-build",
        "logs-telemetry",
        "runtime-events-outbox",
        "timeout-lease",
        "retry-reconcile",
        "crash-recovery",
        "resource-exhaustion",
        "backup-restore",
        "migration-upgrade",
        "rollback",
        "cross-application-operations",
      ],
    );
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "operability-execution-critical",
      checks: passingChecks(prepared),
    });
    seedQualityGateResult(fixture.database, {
      topicId,
      qualityGateResultId: "generic-operability-gate-critical",
      result: "PASS",
    });
    assert.throws(
      () =>
        runtime.finalize({
          candidateGateResultId: "candidate-operability-result-critical",
          gateInputId: prepared.id,
          executionId: "operability-execution-critical",
          qualityGateResultId: "generic-operability-gate-critical",
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_HUMAN_ESCALATION_REQUIRED",
    );
    assert.throws(
      () =>
        runtime.authorize({
          authorityId: "critical-authority",
          candidateInputId: criticalCandidate.id,
          expectedCandidateInputHash: criticalCandidate.manifestHash,
          securityGateResultId: "not-materialized",
          operabilityGateResultId: "not-materialized",
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_HUMAN_ESCALATION_REQUIRED",
    );
    assert.throws(
      () => runtime.downstreamAuthority(criticalCandidate.id),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_HUMAN_ESCALATION_REQUIRED",
    );
    fixture.database.close();
  });

  it("requires one append-only verified-human escalation decision for a critical input", () => {
    const fixture = openFixture();
    const criticalCandidate = {
      ...candidate,
      id: "candidate-input-critical-escalation",
      manifestHash: hash("candidate-input-critical-escalation"),
      manifest: {
        ...candidate.manifest,
        candidateInputId: "candidate-input-critical-escalation",
        risk: {
          ...candidate.manifest.risk,
          tier: "critical" as const,
          factors: [
            ...candidate.manifest.risk.factors,
            {
              id: "destructive-action",
              minimumTier: "critical" as const,
              present: true,
              evidenceRefs: ["artifact-version:artifact-evidence-1"],
            },
          ],
        },
      },
    } satisfies DeliveryCandidateInputView;
    const runtime = openQualityGateRuntime(fixture.database, {
      candidates: { inspect: () => criticalCandidate },
      events: fixture.events,
      clock: () => new Date(candidate.createdAt),
    });
    const request = {
      escalationId: "critical-escalation-1",
      candidateInputId: criticalCandidate.id,
      expectedCandidateInputHash: criticalCandidate.manifestHash,
      decision: "authorize-gate-continuation" as const,
      reason: "A local human reviewed the frozen critical-risk evidence.",
      evidenceRefs: ["artifact-version:artifact-evidence-1"],
    };

    assert.throws(
      () =>
        runtime.decideCriticalEscalation({
          ...request,
          actor: qualityGateActor,
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_HUMAN_ESCALATION_ACTOR_INVALID",
    );

    const candidateRuntime = {
      inspect: () => criticalCandidate,
      freeze: () => {
        throw new Error("Candidate freeze is outside this escalation fixture.");
      },
    } as CandidateInputRuntime;
    const registry = openCompanyCommandRegistry(
      fixture.database,
      openProjectConfiguration(fixture.database),
      undefined,
      () => new Date(candidate.createdAt),
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
      candidateRuntime,
      runtime,
    );
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "critical-escalation-command-1",
      actor: {
        type: "human" as const,
        id: "local-release-owner",
        authenticatedBy: "local-session" as const,
      },
      consumerId: "desktop-critical-escalation",
      command: {
        type: "quality-gate.critical-escalation.decide" as const,
        ...request,
      },
    };
    const rejected = registry.execute({
      ...envelope,
      commandId: "critical-escalation-untrusted-command",
      actor: qualityGateActor,
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected") {
      assert.equal(
        rejected.error.code,
        "QUALITY_GATE_HUMAN_ESCALATION_ACTOR_INVALID",
      );
    }

    const commandResult = registry.execute(envelope);
    assert.equal(
      commandResult.status,
      "succeeded",
      JSON.stringify(commandResult),
    );
    if (commandResult.status !== "succeeded") {
      throw new Error("Critical escalation Command did not succeed.");
    }
    const decision = commandResult.value;

    assert.equal(decision.decision, "authorize-gate-continuation");
    assert.equal(decision.candidateInputHash, criticalCandidate.manifestHash);
    assert.equal((decision.risk as { readonly tier: string }).tier, "critical");
    assert.equal(commandResult.effectIds.length, 1);
    assert.deepEqual(registry.execute(envelope), commandResult);
    const escalationEvent = fixture.events
      .readAfter(0, 100)
      .find(
        (event) => event.type === "quality-gate.critical-escalation.authorized",
      );
    assert.ok(escalationEvent);
    assert.deepEqual(
      {
        ...(fixture.database
          .prepare(
            `SELECT json_extract(scope_json, '$.commandId') AS commandId,
                    json_extract(scope_json, '$.deliveryCandidateInputId') AS candidateInputId
               FROM runtime_event_outbox
              WHERE type = 'quality-gate.critical-escalation.authorized'`,
          )
          .get() as {
          readonly commandId: string;
          readonly candidateInputId: string;
        }),
      },
      {
        commandId: envelope.commandId,
        candidateInputId: criticalCandidate.id,
      },
    );
    assert.equal(
      (
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(envelope.commandId) as { readonly count: number }
      ).count,
      1,
    );
    assert.throws(
      () =>
        runtime.decideCriticalEscalation({
          ...request,
          escalationId: "critical-escalation-conflict",
          decision: "reject",
          actor: {
            type: "human",
            id: "local-release-owner",
            authenticatedBy: "local-session",
          },
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_HUMAN_ESCALATION_EXISTS",
    );
    fixture.database.close();
  });

  it("atomically replays and rolls back a rejected critical-risk escalation Command", () => {
    const fixture = openFixture();
    const criticalCandidate = {
      ...candidate,
      id: "candidate-input-critical-rejected",
      manifestHash: hash("candidate-input-critical-rejected"),
      manifest: {
        ...candidate.manifest,
        candidateInputId: "candidate-input-critical-rejected",
        risk: {
          ...candidate.manifest.risk,
          tier: "critical" as const,
        },
      },
    } satisfies DeliveryCandidateInputView;
    const rollbackCandidate = {
      ...criticalCandidate,
      id: "candidate-input-critical-rollback",
      manifestHash: hash("candidate-input-critical-rollback"),
      manifest: {
        ...criticalCandidate.manifest,
        candidateInputId: "candidate-input-critical-rollback",
      },
    } satisfies DeliveryCandidateInputView;
    fixture.database.exec(`
      CREATE TABLE quality_pipeline_markers(
        candidate_input_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
      );
    `);
    const candidates = {
      inspect: (candidateInputId: string) =>
        candidateInputId === rollbackCandidate.id
          ? rollbackCandidate
          : criticalCandidate,
      freeze: () => {
        throw new Error("Candidate freeze is outside this escalation fixture.");
      },
    } as CandidateInputRuntime;
    const runtime = openQualityGateRuntime(fixture.database, {
      candidates,
      pipelineRuntime: {
        rejectCriticalRiskEscalationInTransaction: (input) => {
          fixture.database
            .prepare(
              "INSERT INTO quality_pipeline_markers(candidate_input_id, run_id) VALUES (?, ?)",
            )
            .run(input.candidateInputId, input.runId);
        },
      },
      events: fixture.events,
      clock: () => new Date(candidate.createdAt),
    });
    const openRegistry = () =>
      openCompanyCommandRegistry(
        fixture.database,
        openProjectConfiguration(fixture.database),
        undefined,
        () => new Date(candidate.createdAt),
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
        candidates,
        runtime,
      );
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "critical-escalation-reject-command",
      actor: {
        type: "human" as const,
        id: "local-release-owner",
        authenticatedBy: "local-session" as const,
      },
      consumerId: "desktop-critical-escalation",
      command: {
        type: "quality-gate.critical-escalation.decide" as const,
        escalationId: "critical-escalation-rejected",
        candidateInputId: criticalCandidate.id,
        expectedCandidateInputHash: criticalCandidate.manifestHash,
        decision: "reject" as const,
        reason:
          "The frozen critical-risk evidence is not authorized to continue.",
        evidenceRefs: ["artifact-version:artifact-evidence-1"],
      },
    };

    const first = openRegistry().execute(envelope);
    assert.equal(first.status, "succeeded", JSON.stringify(first));
    assert.deepEqual(openRegistry().execute(envelope), first);
    assert.deepEqual(
      {
        escalation: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM candidate_critical_escalations WHERE candidate_input_id = ?",
            )
            .get(criticalCandidate.id) as { readonly count: number }
        ).count,
        pipeline: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM quality_pipeline_markers WHERE candidate_input_id = ?",
            )
            .get(criticalCandidate.id) as { readonly count: number }
        ).count,
        audit: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
            )
            .get(envelope.commandId) as { readonly count: number }
        ).count,
        outbox: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = 'quality-gate.critical-escalation.rejected' AND json_extract(scope_json, '$.commandId') = ?",
            )
            .get(envelope.commandId) as { readonly count: number }
        ).count,
        receipt: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
            )
            .get(envelope.commandId) as { readonly count: number }
        ).count,
      },
      { escalation: 1, pipeline: 1, audit: 1, outbox: 1, receipt: 1 },
    );

    const rollbackEnvelope = {
      ...envelope,
      commandId: "critical-escalation-rollback-command",
      command: {
        ...envelope.command,
        escalationId: "critical-escalation-rollback",
        candidateInputId: rollbackCandidate.id,
        expectedCandidateInputHash: rollbackCandidate.manifestHash,
      },
    };
    fixture.database.exec(`
      CREATE TRIGGER fail_critical_escalation_receipt
      BEFORE INSERT ON command_deduplication
      WHEN NEW.command_id = '${rollbackEnvelope.commandId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced critical escalation receipt failure');
      END;
    `);
    assert.throws(
      () => openRegistry().execute(rollbackEnvelope),
      /forced critical escalation receipt failure/,
    );
    assert.deepEqual(
      {
        escalation: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM candidate_critical_escalations WHERE candidate_input_id = ?",
            )
            .get(rollbackCandidate.id) as { readonly count: number }
        ).count,
        pipeline: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM quality_pipeline_markers WHERE candidate_input_id = ?",
            )
            .get(rollbackCandidate.id) as { readonly count: number }
        ).count,
        audit: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
            )
            .get(rollbackEnvelope.commandId) as { readonly count: number }
        ).count,
        outbox: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE json_extract(scope_json, '$.commandId') = ?",
            )
            .get(rollbackEnvelope.commandId) as { readonly count: number }
        ).count,
        receipt: (
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
            )
            .get(rollbackEnvelope.commandId) as { readonly count: number }
        ).count,
      },
      { escalation: 0, pipeline: 0, audit: 0, outbox: 0, receipt: 0 },
    );
    fixture.database.close();
  });

  it("rejects caller down-tiering and an ineligible self-review Session", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: candidate.manifest.producer.aiMemberId,
      reviewerPositionId: candidate.manifest.producer.positionId,
      reviewerSessionId: candidate.manifest.producer.sessionId,
      eligible: false,
    });

    assert.throws(
      () =>
        fixture.runtime.prepare({
          ...prepareInput,
          expectedRiskTier: "medium",
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_RISK_CONFLICT",
    );
    assert.throws(
      () => fixture.runtime.prepare(prepareInput),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_REVIEWER_NOT_INDEPENDENT",
    );
    fixture.database.close();
  });

  it("rejects a reviewer colliding with any frozen Work Package or Test identity", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "independent-reviewer-member",
      reviewerPositionId: "implementer-position",
      reviewerSessionId: "independent-review-session",
    });

    assert.throws(
      () => fixture.runtime.prepare(prepareInput),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_REVIEWER_NOT_INDEPENDENT",
    );
    fixture.database.close();
  });

  it("derives PASS only from a complete durable fact and the exact generic Quality Gate Result", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "security-execution-1",
      checks: passingChecks(prepared),
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-1",
      result: "PASS",
    });

    const result = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-1",
      gateInputId: prepared.id,
      executionId: "security-execution-1",
      qualityGateResultId: "generic-security-gate-1",
    });

    assert.equal(result.result, "PASS");
    assert.deepEqual(result.defects, []);
    assert.deepEqual(result.obligations, []);
    assert.deepEqual(fixture.runtime.inspectResult(result.id), result);
    fixture.database.close();
  });

  it("turns missing required evidence into CONDITIONAL_PASS and a blocking obligation", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    const checks = passingChecks(prepared);
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "security-execution-missing",
      checks: checks.map((check, index) =>
        index === 0
          ? { ...check, status: "missing" as const, evidence: [] }
          : check,
      ),
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-conditional",
      result: "PASS",
    });

    const result = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-conditional",
      gateInputId: prepared.id,
      executionId: "security-execution-missing",
      qualityGateResultId: "generic-security-gate-conditional",
    });

    assert.equal(result.result, "CONDITIONAL_PASS");
    assert.deepEqual(
      result.obligations.map((entry) => ({
        checkId: entry.checkId,
        status: entry.status,
      })),
      [{ checkId: "permission-auth", status: "open" }],
    );
    fixture.database.close();
  });

  it("maps a critical generic Finding to FAIL and a durable Defect", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "security-execution-critical",
      checks: passingChecks(prepared),
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-critical",
      result: "CONDITIONAL_PASS",
      conditions: ["Resolve the critical Sandbox boundary Finding."],
      criticalFinding: true,
    });

    const result = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-critical",
      gateInputId: prepared.id,
      executionId: "security-execution-critical",
      qualityGateResultId: "generic-security-gate-critical",
    });

    assert.equal(result.result, "FAIL");
    assert.deepEqual(
      result.defects.map((entry) => ({
        checkId: entry.checkId,
        status: entry.status,
      })),
      [{ checkId: "review-finding:finding:security-topic-1", status: "open" }],
    );
    fixture.database.close();
  });

  it("maps an unresolved lower-severity Finding to CONDITIONAL_PASS and an obligation", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "security-execution-lower-finding",
      checks: passingChecks(prepared),
    });
    seedFinding(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      findingId: "finding:lower",
      severity: "medium",
      blocking: false,
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-lower-finding",
      result: "PASS",
    });

    const result = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-lower-finding",
      gateInputId: prepared.id,
      executionId: "security-execution-lower-finding",
      qualityGateResultId: "generic-security-gate-lower-finding",
    });

    assert.equal(result.result, "CONDITIONAL_PASS");
    assert.deepEqual(
      result.obligations.map((entry) => entry.checkId),
      ["review-finding:finding:lower"],
    );
    fixture.database.close();
  });

  it("uses the latest append-only Finding disposition and excludes resolved findings", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    seedExecutionFact(fixture.database, {
      gateInputId: prepared.id,
      executionId: "security-execution-resolved-finding",
      checks: passingChecks(prepared),
    });
    seedFinding(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      findingId: "finding:resolved-high",
      severity: "high",
      blocking: true,
    });
    fixture.database
      .prepare(
        `INSERT INTO review_resolutions(
           id, topic_id, finding_id, participant_id, disposition, response,
           evidence_refs_json, revised_subject_id, revised_subject_hash,
           created_at
         ) VALUES (?, ?, ?, ?, 'accepted', ?, ?, NULL, NULL, ?)`,
      )
      .run(
        "resolution:accepted",
        prepareInput.reviewTopicId,
        "finding:resolved-high",
        prepareInput.reviewerParticipantId,
        "Accepted for remediation.",
        JSON.stringify(["artifact-version:artifact-evidence-1"]),
        "2026-07-30T00:00:01.000Z",
      );
    fixture.database
      .prepare(
        `INSERT INTO review_resolutions(
           id, topic_id, finding_id, participant_id, disposition, response,
           evidence_refs_json, revised_subject_id, revised_subject_hash,
           created_at
         ) VALUES (?, ?, ?, ?, 'resolved', ?, ?, NULL, NULL, ?)`,
      )
      .run(
        "resolution:resolved",
        prepareInput.reviewTopicId,
        "finding:resolved-high",
        prepareInput.reviewerParticipantId,
        "Resolved with exact evidence.",
        JSON.stringify(["artifact-version:artifact-evidence-1"]),
        "2026-07-30T00:00:02.000Z",
      );
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-resolved-finding",
      result: "PASS",
    });

    const result = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-resolved-finding",
      gateInputId: prepared.id,
      executionId: "security-execution-resolved-finding",
      qualityGateResultId: "generic-security-gate-resolved-finding",
    });

    assert.equal(result.result, "PASS");
    assert.deepEqual(result.defects, []);
    assert.deepEqual(result.obligations, []);
    fixture.database.close();
  });

  it("closes prior obligations only through a fresh independent re-review over unchanged input", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const priorInput = fixture.runtime.prepare(prepareInput);
    const priorChecks = passingChecks(priorInput);
    seedExecutionFact(fixture.database, {
      gateInputId: priorInput.id,
      executionId: "security-execution-prior",
      checks: priorChecks.map((check, index) =>
        index === 0
          ? { ...check, status: "missing" as const, evidence: [] }
          : check,
      ),
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-prior",
      result: "CONDITIONAL_PASS",
      conditions: [],
    });
    const priorResult = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-prior",
      gateInputId: priorInput.id,
      executionId: "security-execution-prior",
      qualityGateResultId: "generic-security-gate-prior",
    });
    const obligationId = priorResult.obligations[0]!.id;

    seedReview(fixture.database, {
      topicId: "security-topic-fresh",
      reviewerParticipantId: "security-reviewer-participant-fresh",
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-fresh",
    });
    const freshInput = fixture.runtime.prepare({
      ...prepareInput,
      gateInputId: "security-gate-input-fresh",
      requestId: "security-gate-request-fresh",
      reviewTopicId: "security-topic-fresh",
      reviewerParticipantId: "security-reviewer-participant-fresh",
      priorGateInputId: priorInput.id,
    });
    seedExecutionFact(fixture.database, {
      gateInputId: freshInput.id,
      executionId: "security-execution-fresh",
      checks: passingChecks(freshInput),
      resolutions: [
        {
          subjectType: "obligation",
          subjectId: obligationId,
          evidenceRefs: ["artifact-version:artifact-evidence-1"],
        },
      ],
    });
    seedQualityGateResult(fixture.database, {
      topicId: "security-topic-fresh",
      qualityGateResultId: "generic-security-gate-fresh",
      result: "PASS",
    });

    const freshResult = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-fresh",
      gateInputId: freshInput.id,
      executionId: "security-execution-fresh",
      qualityGateResultId: "generic-security-gate-fresh",
    });

    assert.equal(freshResult.result, "PASS");
    assert.equal(
      fixture.runtime.inspectResult(priorResult.id).result,
      "CONDITIONAL_PASS",
    );
    assert.equal(
      fixture.runtime.inspectResult(priorResult.id).obligations[0]?.status,
      "closed",
    );
    const resolution = fixture.database
      .prepare(
        `SELECT fresh_gate_input_id AS freshGateInputId
           FROM candidate_gate_obligation_resolutions WHERE obligation_id = ?`,
      )
      .get(obligationId) as { freshGateInputId: string };
    assert.equal(resolution.freshGateInputId, freshInput.id);
    fixture.database.close();
  });

  it("closes prior Defects only after recording an immutable fresh-input resolution", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const priorInput = fixture.runtime.prepare(prepareInput);
    const priorChecks = passingChecks(priorInput);
    seedExecutionFact(fixture.database, {
      gateInputId: priorInput.id,
      executionId: "security-execution-prior-defect",
      checks: priorChecks.map((check, index) =>
        index === 0 ? { ...check, status: "failed" as const } : check,
      ),
    });
    seedQualityGateResult(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      qualityGateResultId: "generic-security-gate-prior-defect",
      result: "FAIL",
    });
    const priorResult = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-prior-defect",
      gateInputId: priorInput.id,
      executionId: "security-execution-prior-defect",
      qualityGateResultId: "generic-security-gate-prior-defect",
    });
    const defectId = priorResult.defects[0]!.id;

    seedReview(fixture.database, {
      topicId: "security-topic-fresh-defect",
      reviewerParticipantId: "security-reviewer-participant-fresh-defect",
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-fresh-defect",
    });
    const freshInput = fixture.runtime.prepare({
      ...prepareInput,
      gateInputId: "security-gate-input-fresh-defect",
      requestId: "security-gate-request-fresh-defect",
      reviewTopicId: "security-topic-fresh-defect",
      reviewerParticipantId: "security-reviewer-participant-fresh-defect",
      priorGateInputId: priorInput.id,
    });
    seedExecutionFact(fixture.database, {
      gateInputId: freshInput.id,
      executionId: "security-execution-fresh-defect",
      checks: passingChecks(freshInput),
      resolutions: [
        {
          subjectType: "defect",
          subjectId: defectId,
          evidenceRefs: ["artifact-version:artifact-evidence-1"],
        },
      ],
    });
    seedQualityGateResult(fixture.database, {
      topicId: "security-topic-fresh-defect",
      qualityGateResultId: "generic-security-gate-fresh-defect",
      result: "PASS",
    });

    const freshResult = fixture.runtime.finalize({
      candidateGateResultId: "candidate-security-result-fresh-defect",
      gateInputId: freshInput.id,
      executionId: "security-execution-fresh-defect",
      qualityGateResultId: "generic-security-gate-fresh-defect",
    });

    assert.equal(freshResult.result, "PASS");
    assert.equal(
      fixture.runtime.inspectResult(priorResult.id).defects[0]?.status,
      "closed",
    );
    const resolution = fixture.database
      .prepare(
        `SELECT fresh_gate_input_id AS freshGateInputId,
                resolution_hash AS resolutionHash
           FROM candidate_gate_defect_resolutions WHERE defect_id = ?`,
      )
      .get(defectId) as {
      freshGateInputId: string;
      resolutionHash: string;
    };
    assert.equal(resolution.freshGateInputId, freshInput.id);
    assert.match(resolution.resolutionHash, /^[a-f0-9]{64}$/);
    assert.throws(() =>
      fixture.database
        .prepare(
          "UPDATE candidate_gate_defect_resolutions SET evidence_json = '[]' WHERE defect_id = ?",
        )
        .run(defectId),
    );
    fixture.database.close();
  });

  it("materializes downstream authority only from exact dual PASS results", () => {
    const fixture = openFixture();
    const passGate = (kind: "security" | "operability", suffix: string) => {
      const topicId = `${kind}-topic-${suffix}`;
      const participantId = `${kind}-reviewer-participant-${suffix}`;
      seedReview(fixture.database, {
        topicId,
        reviewerParticipantId: participantId,
        reviewerAiMemberId: `${kind}-reviewer-member`,
        reviewerPositionId: `${kind}-reviewer`,
        reviewerSessionId: `${kind}-review-session-${suffix}`,
      });
      seedGateSource(fixture.database, {
        kind,
        nodeRunId: `${kind}-node-${suffix}`,
        nodeAttemptId: `${kind}-attempt-${suffix}`,
      });
      const gateInput = fixture.runtime.prepare({
        ...prepareInput,
        gateInputId: `${kind}-gate-input-${suffix}`,
        requestId: `${kind}-gate-request-${suffix}`,
        kind,
        nodeRunId: `${kind}-node-${suffix}`,
        nodeAttemptId: `${kind}-attempt-${suffix}`,
        reviewTopicId: topicId,
        reviewerParticipantId: participantId,
      });
      const executionId = `${kind}-execution-${suffix}`;
      const qualityGateResultId = `generic-${kind}-gate-${suffix}`;
      seedExecutionFact(fixture.database, {
        gateInputId: gateInput.id,
        executionId,
        checks: passingChecks(gateInput),
      });
      seedQualityGateResult(fixture.database, {
        topicId,
        qualityGateResultId,
        result: "PASS",
      });
      return fixture.runtime.finalize({
        candidateGateResultId: `candidate-${kind}-result-${suffix}`,
        gateInputId: gateInput.id,
        executionId,
        qualityGateResultId,
      });
    };
    const security = passGate("security", "authority");
    const operability = passGate("operability", "authority");

    const authority = fixture.runtime.authorize({
      authorityId: "candidate-input-authority-1",
      candidateInputId: candidate.id,
      expectedCandidateInputHash: candidate.manifestHash,
      securityGateResultId: security.id,
      operabilityGateResultId: operability.id,
    });

    assert.equal(authority.candidateInputId, candidate.id);
    assert.equal(authority.security.resultId, security.id);
    assert.equal(authority.operability.resultId, operability.id);
    assert.deepEqual(
      fixture.runtime.downstreamAuthority(candidate.id),
      authority,
    );
    fixture.database.close();
  });

  it("rejects downstream authority while any selected Gate lineage has an open Defect", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    fixture.database
      .prepare(
        `INSERT INTO candidate_gate_defects(
           id, gate_input_id, check_id, responsibility_json, evidence_json,
           status, created_at, closed_at
         ) VALUES ('open-defect-1', ?, 'permission-auth', '{}', '[]', 'open', ?, NULL)`,
      )
      .run(prepared.id, candidate.createdAt);

    assert.throws(
      () =>
        fixture.runtime.authorize({
          authorityId: "candidate-input-authority-blocked",
          candidateInputId: candidate.id,
          expectedCandidateInputHash: candidate.manifestHash,
          securityGateResultId: "missing-security-result",
          operabilityGateResultId: "missing-operability-result",
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_DOWNSTREAM_BLOCKED",
    );
    fixture.database.close();
  });

  it("persists an execution intent before effect and replays only the exact operation", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    const request = {
      gateInputId: prepared.id,
      adapterId: "scripted-security-gate",
      inputHash: prepared.manifestHash,
    };

    const intent = fixture.runtime.acceptExecution({
      executionId: "security-execution-intent",
      gateInputId: prepared.id,
      operationKey: "security-gate:candidate-input-1:security",
      request,
    });

    assert.equal(intent.state, "intent");
    assert.deepEqual(
      fixture.runtime.acceptExecution({
        executionId: "security-execution-intent",
        gateInputId: prepared.id,
        operationKey: "security-gate:candidate-input-1:security",
        request,
      }),
      intent,
    );
    assert.throws(
      () =>
        fixture.runtime.acceptExecution({
          executionId: "security-execution-conflict",
          gateInputId: prepared.id,
          operationKey: "security-gate:candidate-input-1:security",
          request: { ...request, adapterId: "different-adapter" },
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_EXECUTION_CONFLICT",
    );
    fixture.database.close();
  });

  it("reconciles an effect-complete/finalize-crash into one exact terminal fact", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    fixture.runtime.acceptExecution({
      executionId: "security-execution-reconcile",
      gateInputId: prepared.id,
      operationKey: "security-gate:reconcile",
      request: { gateInputId: prepared.id },
    });
    fixture.runtime.markExecutionRunning("security-execution-reconcile");
    const fact = {
      schemaVersion: 1 as const,
      gateInputId: prepared.id,
      checks: passingChecks(prepared),
      resolutions: [],
    };

    const terminal = fixture.runtime.reconcileExecution({
      executionId: "security-execution-reconcile",
      observation: {
        state: "succeeded",
        fact,
        receiptHash: hash("security-execution-reconcile-receipt"),
      },
    });

    assert.equal(terminal.state, "succeeded");
    assert.deepEqual(
      fixture.runtime.reconcileExecution({
        executionId: "security-execution-reconcile",
        observation: {
          state: "succeeded",
          fact,
          receiptHash: hash("security-execution-reconcile-receipt"),
        },
      }),
      terminal,
    );
    assert.throws(
      () =>
        fixture.runtime.reconcileExecution({
          executionId: "security-execution-reconcile",
          observation: {
            state: "succeeded",
            fact: { ...fact, checks: [] },
            receiptHash: hash("security-execution-reconcile-receipt"),
          },
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_EXECUTION_TERMINAL_CONFLICT",
    );
    fixture.database.close();
  });

  it("rejects unknown fact fields and mislabeled evidence before terminal mutation", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    fixture.runtime.acceptExecution({
      executionId: "security-execution-invalid-fact",
      gateInputId: prepared.id,
      operationKey: "security-gate:invalid-fact",
      request: { gateInputId: prepared.id },
    });
    fixture.runtime.markExecutionRunning("security-execution-invalid-fact");

    assert.throws(
      () =>
        fixture.runtime.reconcileExecution({
          executionId: "security-execution-invalid-fact",
          observation: {
            state: "succeeded",
            fact: {
              schemaVersion: 1,
              gateInputId: prepared.id,
              checks: passingChecks(prepared),
              resolutions: [],
              unexpected: true,
            },
            receiptHash: hash("invalid-fact-receipt"),
          },
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_FACT_SCHEMA_INVALID",
    );
    assert.equal(
      fixture.runtime.reconcileExecution({
        executionId: "security-execution-invalid-fact",
        observation: { state: "running" },
      }).state,
      "reconciling",
    );

    fixture.runtime.acceptExecution({
      executionId: "security-execution-mislabeled-evidence",
      gateInputId: prepared.id,
      operationKey: "security-gate:mislabeled-evidence",
      request: { gateInputId: prepared.id },
    });
    const mislabeledChecks = passingChecks(prepared).map((check, index) =>
      index === 0
        ? {
            ...check,
            evidence: [
              {
                kind: "artifact",
                ref: "test-pass-authority:test-run-1",
              },
            ],
          }
        : check,
    );
    assert.throws(
      () =>
        fixture.runtime.reconcileExecution({
          executionId: "security-execution-mislabeled-evidence",
          observation: {
            state: "succeeded",
            fact: {
              schemaVersion: 1,
              gateInputId: prepared.id,
              checks: mislabeledChecks,
              resolutions: [],
            },
            receiptHash: hash("mislabeled-evidence-receipt"),
          },
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_EVIDENCE_REF_INVALID",
    );
    fixture.database.close();
  });

  it("accepts exact current execution fact and receipt references as Runtime evidence", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    const executionId = "security-execution-exact-runtime-evidence";
    const receiptHash = hash("exact-runtime-evidence-receipt");
    fixture.runtime.acceptExecution({
      executionId,
      gateInputId: prepared.id,
      operationKey: "security-gate:exact-runtime-evidence",
      request: { gateInputId: prepared.id },
    });
    const checks = passingChecks(prepared).map((check, checkIndex) => ({
      ...check,
      evidence: check.evidence.map((evidence, evidenceIndex) =>
        evidence.kind === "runtime-fact"
          ? {
              ...evidence,
              ref:
                (checkIndex + evidenceIndex) % 2 === 0
                  ? `quality-gate-execution:${executionId}:fact`
                  : `quality-gate-execution:${executionId}:receipt:${receiptHash}`,
            }
          : evidence,
      ),
    }));

    const terminal = fixture.runtime.reconcileExecution({
      executionId,
      observation: {
        state: "succeeded",
        fact: {
          schemaVersion: 1,
          gateInputId: prepared.id,
          checks,
          resolutions: [],
        },
        receiptHash,
      },
    });

    assert.equal(terminal.state, "succeeded");
    fixture.database.close();
  });

  it("preserves unknown execution state without inventing PASS, FAIL, or a resend", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const prepared = fixture.runtime.prepare(prepareInput);
    fixture.runtime.acceptExecution({
      executionId: "security-execution-unknown",
      gateInputId: prepared.id,
      operationKey: "security-gate:unknown",
      request: { gateInputId: prepared.id },
    });

    const unknown = fixture.runtime.reconcileExecution({
      executionId: "security-execution-unknown",
      observation: { state: "unknown" },
    });

    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.factHash, null);
    assert.equal(unknown.receiptHash, null);
    assert.throws(
      () =>
        fixture.runtime.finalize({
          candidateGateResultId: "invented-result",
          gateInputId: prepared.id,
          executionId: unknown.id,
          qualityGateResultId: "invented-qgr",
        }),
      (error: unknown) =>
        error instanceof QualityGateRuntimeError &&
        error.code === "QUALITY_GATE_EXECUTION_NOT_TERMINAL",
    );
    assert.deepEqual(
      fixture.runtime.acceptExecution({
        executionId: "security-execution-unknown",
        gateInputId: prepared.id,
        operationKey: "security-gate:unknown",
        request: { gateInputId: prepared.id },
      }),
      unknown,
    );
    fixture.database.close();
  });

  it("persists state, audit, outbox, and receipt in one formal Command Unit of Work", () => {
    const fixture = openFixture();
    seedReview(fixture.database, {
      topicId: prepareInput.reviewTopicId,
      reviewerParticipantId: prepareInput.reviewerParticipantId,
      reviewerAiMemberId: "security-reviewer-member",
      reviewerPositionId: "security-reviewer",
      reviewerSessionId: "security-review-session-1",
    });
    const candidateRuntime = {
      inspect: () => candidate,
      freeze: () => {
        throw new Error("Candidate freeze is outside this Command fixture.");
      },
    } as CandidateInputRuntime;
    const registry = openCompanyCommandRegistry(
      fixture.database,
      openProjectConfiguration(fixture.database),
      undefined,
      () => new Date(candidate.createdAt),
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
      candidateRuntime,
      fixture.runtime,
    );
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "command-quality-prepare-1",
      actor: {
        type: "runtime-worker" as const,
        id: qualityGateActor.id,
        authenticatedBy: "runtime" as const,
      },
      consumerId: "quality-command-consumer",
      command: {
        type: "quality-gate.input.prepare" as const,
        ...prepareInput,
      },
    };

    const rejected = registry.execute({
      ...envelope,
      actor: {
        type: "test-driver" as const,
        id: "untrusted-quality-command-test",
        authenticatedBy: "ipc-token" as const,
      },
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected") {
      assert.equal(rejected.error.code, "DELIVERY_QUALITY_ACTOR_INVALID");
    }
    assert.equal(
      (
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(envelope.commandId) as { count: number }
      ).count,
      0,
    );

    const first = registry.execute(envelope);

    assert.equal(first.status, "succeeded");
    assert.equal(first.effectIds.length, 1);
    assert.equal(
      (
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(envelope.commandId) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT type FROM runtime_event_outbox
            WHERE type = ?
              AND json_extract(scope_json, '$.candidateGateInputId') = ?
            ORDER BY sequence`,
        )
        .all("quality-gate.input.prepared", prepareInput.gateInputId)
        .map((row) => (row as { type: string }).type),
      ["quality-gate.input.prepared"],
    );
    assert.deepEqual(registry.execute(envelope), first);
    assert.equal(
      (
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count FROM runtime_event_outbox
              WHERE type = ?
                AND json_extract(scope_json, '$.candidateGateInputId') = ?`,
          )
          .get("quality-gate.input.prepared", prepareInput.gateInputId) as {
          count: number;
        }
      ).count,
      1,
    );

    const acceptEnvelope = {
      ...envelope,
      commandId: "command-quality-accept-1",
      command: {
        type: "quality-gate.execution.accept" as const,
        executionId: "security-execution-command-1",
        gateInputId: prepareInput.gateInputId,
        operationKey: "security-gate:command-1",
        request: { gateInputId: prepareInput.gateInputId },
      },
    };
    const reconcileEnvelope = {
      ...envelope,
      commandId: "command-quality-reconcile-1",
      command: {
        type: "quality-gate.execution.reconcile" as const,
        executionId: "security-execution-command-1",
        observation: { state: "unknown" as const },
      },
    };

    assert.equal(registry.execute(acceptEnvelope).status, "succeeded");
    assert.equal(registry.execute(reconcileEnvelope).status, "succeeded");
    assert.equal(
      (
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
          )
          .get(reconcileEnvelope.commandId) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count FROM runtime_event_outbox
              WHERE type = ?
                AND json_extract(payload_json, '$.executionId') = ?`,
          )
          .get(
            "quality-gate.execution.reconciled",
            acceptEnvelope.command.executionId,
          ) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
          )
          .get(reconcileEnvelope.commandId) as { count: number }
      ).count,
      1,
    );
    fixture.database.close();
  });
});
