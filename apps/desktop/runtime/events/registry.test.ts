import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeEventRegistry,
  RUNTIME_EVENT_REGISTRY_VERSION,
  RuntimeEventRegistryError,
} from "./registry.js";

const agUiRegistryFixture = [
  "application.registered@1:custom",
  "workspace-allocation.planned@1:custom",
  "workspace-allocation.ready@1:custom",
  "workspace-allocation.failed@1:custom",
  "workspace-allocation.cleanup-requested@1:custom",
  "workspace-allocation.cleaned@1:custom",
  "source-import.planned@1:custom",
  "source-import.completed@1:custom",
  "source-import.failed@1:custom",
  "application-spec.revised@1:custom",
  "technical-proposal.revised@1:custom",
  "technical-gate.passed@1:custom",
  "technical-baseline.accepted@1:custom",
  "product.proposal.revised@1:custom",
  "product.proposal.awaiting-confirmation@1:custom",
  "product.baseline.confirmed@1:custom",
  "spec.revised@1:custom",
  "product-readiness.recorded@1:custom",
  "product-gate.passed@1:custom",
  "snapshot.promoted@1:custom",
  "department-run.formalized@1:custom",
  "review.scheduled@1:custom",
  "review.finding.created@1:custom",
  "review.finding.dispositioned@1:custom",
  "review.discussion.round@1:custom",
  "review.revision.created@1:custom",
  "review.recheck.completed@1:custom",
  "quality-gate.completed@1:custom",
  "memory.candidate.created@1:custom",
  "memory.review.started@1:custom",
  "memory.reviewed@1:custom",
  "memory.accepted@1:custom",
  "memory.rejected@1:custom",
  "memory.selected@1:custom",
  "artifact.registered@1:custom",
  "artifact.finalized@1:custom",
  "artifact.integrity-failed@1:custom",
  "artifact.superseded@1:custom",
  "artifact.version.created@1:custom",
  "artifact.version.status.changed@1:custom",
  "run.created@1:custom",
  "run.started@1:custom",
  "run.forked@1:custom",
  "run.paused@1:custom",
  "run.resumed@1:custom",
  "run.blocked@1:custom",
  "run.recovering@1:custom",
  "run.waiting-human-release@1:custom",
  "run.completed@1:custom",
  "run.release-rejected@1:custom",
  "run.superseded@1:custom",
  "run.cancelled@1:custom",
  "run.intervention.recorded@1:custom",
  "snapshot.revision.created@1:custom",
  "node.queued@1:custom",
  "node.started@1:custom",
  "node.skipped@1:custom",
  "node.waiting-approval@1:custom",
  "node.succeeded@1:custom",
  "node.failed@1:custom",
  "node.status.changed@1:custom",
  "node.condition.selected@1:custom",
  "attempt.ready@1:custom",
  "attempt.started@1:custom",
  "attempt.reconciling@1:custom",
  "attempt.succeeded@1:custom",
  "attempt.failed@1:custom",
  "attempt.interrupted@1:custom",
  "attempt.lease.renewed@1:custom",
  "approval.requested@1:custom",
  "approval.decided@1:custom",
  "approval.request-changes@1:custom",
  "approval.expired@1:custom",
  "work-package.ready@1:custom",
  "work-package.versioned@1:custom",
  "work-package.assigned@1:custom",
  "work-package.blocked@1:custom",
  "work-package.started@1:custom",
  "work-package.self-check@1:custom",
  "work-package.failed@1:custom",
  "code-review.planned@1:custom",
  "code-review.workspace.ready@1:custom",
  "code-review.workspace.blocked@1:custom",
  "code-review.workspace.unknown@1:custom",
  "code-review.execution.started@1:custom",
  "code-review.execution.completed@1:custom",
  "code-review.execution.blocked@1:custom",
  "code-review.execution.unknown@1:custom",
  "code-review.authority.created@1:custom",
  "code-review.defect.created@1:custom",
  "code-review.defect.closed@1:custom",
  "integration.generation.started@1:custom",
  "integration.generation.validating@1:custom",
  "integration.validation.recorded@1:custom",
  "integration.generation.aggregate-review@1:custom",
  "integration.generation.blocked@1:custom",
  "integration.generation.failed@1:custom",
  "integration.generation.completed@1:custom",
  "integration.operation.intent-recorded@1:custom",
  "integration.operation.finalized@1:custom",
  "test.case.revised@1:custom",
  "test.run.accepted@1:custom",
  "test.run.started@1:custom",
  "test.run.reconciling@1:custom",
  "test.run.unknown@1:custom",
  "test.assertion.recorded@1:custom",
  "test.evidence.recorded@1:custom",
  "test.defect.created@1:custom",
  "test.defect.closed@1:custom",
  "test.run.completed@1:custom",
  "test.run.failed@1:custom",
  "test.run.blocked@1:custom",
  "test.run.cancelled@1:custom",
  "delivery.candidate-input.frozen@1:custom",
  "quality-gate.input.prepared@1:custom",
  "quality-gate.execution.accepted@1:custom",
  "quality-gate.execution.reconciled@1:custom",
  "quality-gate.result.recorded@1:custom",
  "delivery.candidate-input.authorized@1:custom",
  "quality-gate.critical-escalation.authorized@1:custom",
  "quality-gate.critical-escalation.rejected@1:custom",
  "delivery.candidate.created@1:custom",
  "delivery.release.accepted@1:custom",
  "delivery.release.rejected@1:custom",
  "delivery.release.changes-requested@1:custom",
  "delivery.release.rework-activated@1:custom",
  "delivery.release-operation.invalidated@1:custom",
  "interaction.turn.started@1:custom",
  "interaction.turn.reconciling@1:custom",
  "message.delta@1:mapped",
  "usage.recorded@1:custom",
  "interaction.turn.completed@1:custom",
  "interaction.turn.failed@1:custom",
  "interaction.turn.cancelled@1:custom",
  "interaction.turn.interrupted@1:custom",
  "tool.call@1:mapped",
  "tool.result@1:mapped",
  "permission.requested@1:custom",
  "permission.decided@1:custom",
  "execution.leased@1:custom",
  "execution.fact.accepted@1:custom",
  "execution.fact.stale@1:custom",
  "execution.fact.conflict@1:custom",
  "execution.completed@1:custom",
  "execution.failed@1:custom",
  "execution.cancelled@1:custom",
  "execution.lease.lost@1:custom",
  "execution.interrupted@1:custom",
  "execution.reattached@1:custom",
] as const;

const retainedCatalogRegistryFixture = [
  "department",
  "position",
  "ai-member",
  "execution-profile",
  "secret-reference",
  "skill",
  "skill-flow",
  "pipeline-draft",
  "pipeline-version",
  "position-skill-binding",
].flatMap((entity) =>
  ["created", "updated", "deleted"].map(
    (operation) => `${entity}.${operation}@1`,
  ),
);

describe("Runtime Event registry", () => {
  it("keeps a golden AG-UI policy fixture for every mapped schema version", () => {
    const registry = createRuntimeEventRegistry();
    assert.equal(registry.version, RUNTIME_EVENT_REGISTRY_VERSION);
    assert.equal(RUNTIME_EVENT_REGISTRY_VERSION, 19);

    assert.deepEqual(
      registry
        .list()
        .filter((entry) => entry.agUiMapping !== "unmapped")
        .map(
          (entry) =>
            `${entry.type}@${entry.schemaVersion}:${entry.agUiMapping}`,
        ),
      agUiRegistryFixture,
    );
    assert.deepEqual(
      registry
        .list()
        .filter((entry) => entry.agUiMapping === "unmapped")
        .map((entry) => `${entry.type}@${entry.schemaVersion}`),
      [
        "project.created@1",
        "project.updated@1",
        "project.deleted@1",
        ...retainedCatalogRegistryFixture,
        "session.created@1",
        "session.participant.added@1",
        "session.closed@1",
        "session.message.created@1",
        "memory.candidate.reviewed@1",
      ],
    );
  });

  it("accepts exact retained catalog trigger contracts", () => {
    const registry = createRuntimeEventRegistry();

    assert.doesNotThrow(() =>
      registry.validate({
        type: "pipeline-version.created",
        scope: { companyId: "company" },
        payload: {
          entityId: "pipeline-version-1",
          operation: "created",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "department.updated",
        scope: { companyId: "company" },
        payload: {
          entityId: "department-1",
          operation: "updated",
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "department.updated",
          scope: { companyId: "company" },
          payload: {
            entityId: "department-1",
            operation: "created",
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_PAYLOAD_INVALID",
    );
  });

  it("accepts retained Session and Memory compatibility events", () => {
    const registry = createRuntimeEventRegistry();

    assert.doesNotThrow(() =>
      registry.validate({
        type: "session.created",
        scope: { companyId: "company" },
        payload: {
          sessionId: "session-1",
          mode: "consultation",
          projectId: "project-1",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "session.created",
        scope: { companyId: "company" },
        payload: {
          sessionId: "session-2",
          mode: "run-collaboration",
          status: "active",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "memory.candidate.reviewed",
        scope: { companyId: "company" },
        payload: {
          candidateId: "candidate-1",
          status: "approved",
          recordId: "record-1",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "permission.requested",
        scope: { companyId: "company" },
        payload: {
          sessionId: "session-1",
          permissionId: "permission-1",
          scope: "repository.write",
          status: "pending",
        },
      }),
    );
  });

  it("adds v16 Test events without changing retained v15 contracts", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "run.created",
        scope: {
          companyId: "company",
          projectId: "project-1",
          departmentId: "department-1",
          runId: "run-1",
        },
        payload: { runId: "run-1", status: "ready" },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "test.run.completed",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          nodeRunId: "test-node-1",
          testRunId: "test-run-1",
        },
        payload: {
          testRunId: "test-run-1",
          state: "passed",
          manifestHash: "a".repeat(64),
          passAuthorityHash: "b".repeat(64),
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "test.run.completed",
          scope: {
            companyId: "company",
            projectId: "project-1",
            runId: "run-1",
            nodeRunId: "test-node-1",
            testRunId: "test-run-1",
          },
          payload: {},
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_PAYLOAD_INVALID",
    );
    assert.throws(
      () =>
        registry.validate({
          type: "test.run.completed",
          schemaVersion: 2,
          scope: {
            companyId: "company",
            projectId: "project-1",
            runId: "run-1",
            nodeRunId: "test-node-1",
            testRunId: "test-run-1",
          },
          payload: {
            testRunId: "test-run-1",
            state: "passed",
            manifestHash: "a".repeat(64),
            passAuthorityHash: "b".repeat(64),
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCHEMA_UNSUPPORTED",
    );
    assert.throws(
      () =>
        registry.validate({
          type: "test.run.future",
          scope: { companyId: "company" },
          payload: {},
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_UNREGISTERED",
    );

    const runScope = {
      companyId: "company",
      projectId: "project-1",
      runId: "run-1",
      nodeRunId: "test-node-1",
      testRunId: "test-run-1",
    };
    const exactEvents = [
      {
        type: "test.case.revised",
        scope: {
          companyId: "company",
          projectId: "project-1",
          testCaseRevisionId: "case-r1",
        },
        payload: {
          testCaseRevisionId: "case-r1",
          manifestHash: "a".repeat(64),
        },
      },
      {
        type: "test.run.accepted",
        scope: runScope,
        payload: {
          testRunId: "test-run-1",
          state: "scheduled",
          manifestHash: "a".repeat(64),
        },
      },
      ...[
        ["test.run.started", "running"],
        ["test.run.reconciling", "reconciling"],
        ["test.run.unknown", "unknown"],
        ["test.run.failed", "failed"],
        ["test.run.cancelled", "cancelled"],
      ].map(([type, state]) => ({
        type: type!,
        scope: runScope,
        payload: {
          testRunId: "test-run-1",
          state: state!,
          operationId: "operation-1",
        },
      })),
      {
        type: "test.assertion.recorded",
        scope: { ...runScope, testCaseRevisionId: "case-r1" },
        payload: {
          testRunId: "test-run-1",
          testCaseRevisionId: "case-r1",
          assertionId: "assertion-1",
        },
      },
      {
        type: "test.evidence.recorded",
        scope: runScope,
        payload: { testRunId: "test-run-1", evidenceId: "evidence-1" },
      },
      {
        type: "test.defect.created",
        scope: { ...runScope, defectId: "defect-1" },
        payload: {
          testRunId: "test-run-1",
          defectId: "defect-1",
          operationId: "operation-1",
        },
      },
      {
        type: "test.defect.closed",
        scope: { ...runScope, defectId: "defect-1" },
        payload: { testRunId: "test-run-1", defectId: "defect-1" },
      },
      {
        type: "test.run.blocked",
        scope: runScope,
        payload: { testRunId: "test-run-1", state: "blocked" },
      },
    ];
    for (const event of exactEvents) {
      assert.doesNotThrow(() => registry.validate(event));
    }
    assert.throws(
      () =>
        registry.validate({
          type: "test.evidence.recorded",
          scope: runScope,
          payload: {
            testRunId: "test-run-1",
            evidenceId: "evidence-1",
            unexpected: true,
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_PAYLOAD_INVALID",
    );
  });

  it("adds v17 Candidate Input and Quality Gate events without changing v16 contracts", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "delivery.candidate-input.frozen",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateInputId: "candidate-input-1",
        },
        payload: {
          deliveryCandidateInputId: "candidate-input-1",
          manifestHash: "a".repeat(64),
          riskTier: "high",
          state: "frozen-for-final-gates",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "quality-gate.result.recorded",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateInputId: "candidate-input-1",
          candidateGateInputId: "security-gate-input-1",
        },
        payload: {
          candidateGateInputId: "security-gate-input-1",
          candidateGateResultId: "security-result-1",
          result: "PASS",
          resultHash: "b".repeat(64),
        },
      }),
    );
  });

  it("adds v18 Delivery Candidate and Human release events without changing v17 contracts", () => {
    const registry = createRuntimeEventRegistry();
    const scope = {
      companyId: "company",
      projectId: "project-1",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      deliveryCandidateInputId: "candidate-input-1",
      deliveryCandidateId: "candidate-1",
      commandId: "command-1",
    } as const;

    assert.doesNotThrow(() =>
      registry.validate({
        type: "delivery.candidate.created",
        scope,
        payload: {
          deliveryCandidateId: "candidate-1",
          deliveryCandidateInputId: "candidate-input-1",
          candidateHash: "a".repeat(64),
          candidateInputHash: "b".repeat(64),
          gateAuthorityId: "gate-authority-1",
          gateAuthorityHash: "c".repeat(64),
          supersedesCandidateId: null,
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "delivery.release.accepted",
        scope: { ...scope, releaseDecisionId: "decision-1" },
        payload: {
          humanReleaseDecisionId: "decision-1",
          deliveryCandidateId: "candidate-1",
          deliveryCandidateInputId: "candidate-input-1",
          candidateHash: "a".repeat(64),
          decision: "accepted",
          decisionHash: "d".repeat(64),
          evidenceRefs: ["artifact-version:evidence-1"],
          reworkScope: null,
          childRunId: null,
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "delivery.release.accepted",
          scope,
          payload: {
            humanReleaseDecisionId: "decision-1",
            deliveryCandidateId: "candidate-1",
            deliveryCandidateInputId: "candidate-input-1",
            candidateHash: "a".repeat(64),
            decision: "accepted",
            decisionHash: "d".repeat(64),
            evidenceRefs: ["artifact-version:evidence-1"],
            reworkScope: null,
            childRunId: null,
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("adds v19 release-operation invalidation without publishing effect progress", () => {
    const registry = createRuntimeEventRegistry();

    assert.equal(registry.version, 19);
    assert.doesNotThrow(() =>
      registry.validate({
        type: "delivery.release-operation.invalidated",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          deliveryCandidateId: "candidate-1",
          releaseOperationId: "release-operation-1",
        },
        payload: {
          releaseOperationId: "release-operation-1",
          candidateId: "candidate-1",
        },
      }),
    );
    assert.equal(
      registry.get("delivery.release-operation.item-running"),
      undefined,
    );
  });

  it("accepts the canonical project.updated contract", () => {
    const registry = createRuntimeEventRegistry();

    assert.doesNotThrow(() =>
      registry.validate({
        type: "project.updated",
        scope: { companyId: "company", projectId: "project-1" },
        payload: { projectId: "project-1", revision: 2 },
      }),
    );
  });

  it("rejects unregistered events and missing required subject IDs", () => {
    const registry = createRuntimeEventRegistry();

    assert.throws(
      () =>
        registry.validate({
          type: "project.deleted-invented",
          scope: { companyId: "company", projectId: "project-1" },
          payload: {},
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_UNREGISTERED",
    );
    assert.throws(
      () =>
        registry.validate({
          type: "project.updated",
          scope: { companyId: "company" },
          payload: { projectId: "project-1", revision: 2 },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires top-level Artifact and Artifact Version IDs", () => {
    const registry = createRuntimeEventRegistry();

    assert.doesNotThrow(() =>
      registry.validate({
        type: "artifact.finalized",
        scope: {
          companyId: "company",
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
        },
        payload: {
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
          contentKind: "managed-file",
          integrityStatus: "verified",
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "artifact.finalized",
          scope: {
            companyId: "company",
            projectId: "project-1",
            artifactVersionId: "artifact-version-1",
          },
          payload: {
            artifactId: "artifact-1",
            artifactVersionId: "artifact-version-1",
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires Review Topic, Finding, and Quality Gate subject identities", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "review.finding.created",
        scope: {
          companyId: "company",
          projectId: "project-1",
          topicId: "topic-1",
          reviewFindingId: "finding-1",
        },
        payload: {
          topicId: "topic-1",
          findingId: "finding-1",
          severity: "high",
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "quality-gate.completed",
          scope: {
            companyId: "company",
            projectId: "project-1",
            topicId: "topic-1",
          },
          payload: {
            topicId: "topic-1",
            qualityGateResultId: "gate-1",
            result: "PASS",
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires exact Technical Baseline and promotion identities", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "technical-baseline.accepted",
        scope: {
          companyId: "company",
          projectId: "project-1",
          projectSpecRevisionId: "project-spec-r1",
          technicalBaselineProposalId: "proposal-1",
          technicalBaselineId: "technical-baseline-1",
          runId: "run-1",
          snapshotRevisionId: "snapshot-r3",
          topicId: "technical-topic-1",
          qualityGateResultId: "technical-gate-1",
        },
        payload: {
          promotionId: "technical-promotion-1",
          technicalBaselineId: "technical-baseline-1",
          technicalBaselineHash: "a".repeat(64),
          applicationSpecRevisionIds: ["application-spec-r1"],
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "technical-baseline.accepted",
          scope: {
            companyId: "company",
            projectId: "project-1",
            projectSpecRevisionId: "project-spec-r1",
            technicalBaselineProposalId: "proposal-1",
            runId: "run-1",
            snapshotRevisionId: "snapshot-r3",
            topicId: "technical-topic-1",
            qualityGateResultId: "technical-gate-1",
          },
          payload: {
            promotionId: "technical-promotion-1",
            technicalBaselineId: "technical-baseline-1",
            technicalBaselineHash: "a".repeat(64),
            applicationSpecRevisionIds: ["application-spec-r1"],
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires governed Memory Candidate and Entry identities", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "memory.accepted",
        scope: {
          companyId: "company",
          projectId: "project-1",
          memoryCandidateId: "memory-candidate-1",
          memoryEntryId: "memory-entry-1",
          topicId: "memory-topic-1",
          qualityGateResultId: "memory-gate-1",
        },
        payload: {
          decisionId: "memory-decision-1",
          candidateId: "memory-candidate-1",
          candidateRevisionId: "memory-candidate-revision-1",
          candidateRevisionHash: "a".repeat(64),
          entryId: "memory-entry-1",
          entryHash: "b".repeat(64),
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "memory.selected",
          scope: {
            companyId: "company",
            projectId: "project-1",
            runId: "run-1",
            snapshotRevisionId: "snapshot-r2",
          },
          payload: {
            entryId: "memory-entry-1",
            snapshotRevisionId: "snapshot-r2",
            snapshotHash: "c".repeat(64),
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires exact Work Package and Version identities", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "work-package.started",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
        },
        payload: {
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
          state: "running",
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "work-package.started",
          scope: {
            companyId: "company",
            projectId: "project-1",
            runId: "run-1",
            workPackageId: "work-package-1",
          },
          payload: {
            workPackageId: "work-package-1",
            workPackageVersionId: "work-package-version-1",
            state: "running",
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });

  it("requires exact Code Review, Work Package, and Version identities", () => {
    const registry = createRuntimeEventRegistry();
    assert.doesNotThrow(() =>
      registry.validate({
        type: "code-review.authority.created",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          topicId: "code-review-topic-1",
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
        },
        payload: {
          codeReviewId: "code-review-1",
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
          qualityGateResultId: "code-gate-1",
        },
      }),
    );
    assert.doesNotThrow(() =>
      registry.validate({
        type: "code-review.execution.started",
        scope: {
          companyId: "company",
          projectId: "project-1",
          runId: "run-1",
          topicId: "code-review-topic-1",
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
        },
        payload: {
          codeReviewId: "code-review-1",
          workPackageId: "work-package-1",
          workPackageVersionId: "work-package-version-1",
          phase: "initial-finding",
          operationKey: "code-review:code-review-1:initial-finding",
          state: "running",
        },
      }),
    );
    assert.throws(
      () =>
        registry.validate({
          type: "code-review.authority.created",
          scope: {
            companyId: "company",
            projectId: "project-1",
            runId: "run-1",
            topicId: "code-review-topic-1",
            workPackageId: "work-package-1",
          },
          payload: {
            codeReviewId: "code-review-1",
            workPackageId: "work-package-1",
            workPackageVersionId: "work-package-version-1",
          },
        }),
      (error: unknown) =>
        error instanceof RuntimeEventRegistryError &&
        error.code === "RUNTIME_EVENT_SCOPE_INVALID",
    );
  });
});
