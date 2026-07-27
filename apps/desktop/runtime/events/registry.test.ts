import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeEventRegistry,
  RuntimeEventRegistryError,
} from "./registry.js";

describe("Runtime Event registry", () => {
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
});
