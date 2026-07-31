import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { companyRuntimeAddress } from "./address.js";
import {
  createCompanyRuntimeClientFromTransport,
  createLocalRuntimeTransport,
} from "./client.js";
import {
  RuntimeRequestSchema,
  TestRunViewSchema,
  type RuntimeResponse,
} from "./interface.js";
import { scriptedDepartmentRun } from "./testing/runContract.js";

const actor = {
  type: "test-driver" as const,
  id: "runtime-client-test",
  authenticatedBy: "ipc-token" as const,
};

const integrationGenerationView = {
  id: "generation-1",
  manifest: {
    schemaVersion: 1 as const,
    generationId: "generation-1",
    generation: 1,
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    nodeRunId: "integration-node-1",
    coverageId: "coverage-1",
    coverageNodeRunId: "code-review-node-1",
    coverageNodeAttemptId: "code-review-attempt-1",
    coverageHash: "a".repeat(64),
    repositories: [
      {
        repositoryReference: "/repositories/api",
        baseCommit: "b".repeat(40),
        integrationBranch: "integration/run-1/g1",
      },
    ],
    packages: [],
    dependencyOrder: [],
    contractVersions: [],
    integrationConditions: ["npm test"],
    requiredValidations: [
      {
        id: "validation-1",
        repositoryReference: "/repositories/api",
        kind: "build-test" as const,
        identityHash: "d".repeat(64),
        condition: "npm test",
        commands: [["npm", "test"]],
        evidenceRefs: [],
        responsibleWorkPackageVersionIds: ["package-v1"],
      },
    ],
  },
  manifestHash: "c".repeat(64),
  state: "validating" as const,
  repositoryResults: [],
  operations: [],
  defects: [],
  aggregateReview: null,
  passAuthorityHash: null,
};

const testRunView = {
  id: "test-run-1",
  requestId: "request-1",
  manifest: {
    schemaVersion: 1 as const,
    testRunId: "test-run-1",
    requestId: "request-1",
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    nodeRunId: "test-node-1",
    nodeAttemptId: "test-attempt-1",
    sessionId: "test-session-1",
    testCaseRevisions: [{ id: "test-case-revision-1", hash: "2".repeat(64) }],
    integrationAuthority: {
      generationId: "generation-1",
      manifestHash: "3".repeat(64),
      passAuthorityHash: "4".repeat(64),
      repositoryCommits: [
        {
          repositoryReference: "/repositories/api",
          commit: "5".repeat(40),
        },
      ],
    },
    build: {
      artifactVersionId: "artifact-version-1",
      digest: "6".repeat(64),
    },
    buildLineage: {
      generationId: "generation-1",
      manifestHash: "3".repeat(64),
      passAuthorityHash: "4".repeat(64),
      repositoryCommits: [
        {
          repositoryReference: "/repositories/api",
          commit: "5".repeat(40),
        },
      ],
    },
    executionProfile: { id: "profile-1", hash: "7".repeat(64) },
    companyDirectoryFingerprint: "8".repeat(64),
    fixture: { id: "fixture-1", scriptHashes: ["9".repeat(64)] },
    executionOperations: [
      {
        id: "operation-1",
        kind: "runtime" as const,
        adapterId: "scripted-test",
        input: { check: "runtime" },
        inputHash: "a".repeat(64),
      },
      {
        id: "cleanup-operation-1",
        kind: "cleanup" as const,
        adapterId: "scripted-test",
        input: { cleanup: { repository: true, worktree: true } },
        inputHash: "b".repeat(64),
      },
    ],
    clock: { instant: "2026-07-29T00:00:00.000Z", seed: "seed-1" },
    environment: {},
    capabilities: [],
    risk: {
      schemaVersion: 1 as const,
      policy: {
        revisionId: "risk-policy-r1",
        rules: [{ factorId: "runtime-change", minimumTier: "high" as const }],
        hash: "1".repeat(64),
      },
      factors: [
        {
          id: "runtime-change",
          present: true,
          evidenceRefs: ["test-case:test-case-revision-1"],
        },
      ],
      computedTier: "high" as const,
      evidenceRefs: ["test-case:test-case-revision-1"],
      inputHash: "2".repeat(64),
    },
    coverageHash: "b".repeat(64),
    integrationCoverage: {
      coverageId: "coverage-1",
      coverageNodeRunId: "review-node-1",
      coverageNodeAttemptId: "review-attempt-1",
      coverageHash: "c".repeat(64),
      packageAuthorities: [],
      aggregateReviewId: "aggregate-review-1",
      aggregateGateResultId: "aggregate-gate-1",
      aggregateInputHash: "d".repeat(64),
      evidenceRefs: ["artifact-version-1"],
    },
  },
  manifestHash: "e".repeat(64),
  viewHash: "f".repeat(64),
  state: "passed" as const,
  passAuthorityHash: "1".repeat(64),
  executions: [],
  assertions: [
    {
      id: "test-run-1:assertion-1",
      operationId: "operation-1",
      testCaseRevisionId: "test-case-revision-1",
      assertionId: "assertion-1",
      required: true,
      uiObserved: "passed",
      runtimeObserved: "passed",
      uiStatus: "passed" as const,
      runtimeStatus: "passed" as const,
      correlation: {
        commandId: "test-command-1",
        eventSequence: 31,
        runtimeEventType: "test.run.reconciling",
        queryAsOfSequence: 31,
        queryViewHash: "a".repeat(64),
        viewSyncTokenHash: "b".repeat(64),
        snapshotRevisionId: "snapshot-1",
        runId: "run-1",
        nodeRunId: "test-node-1",
        nodeAttemptId: "test-attempt-1",
        sessionId: "test-session-1",
        artifactVersionIds: ["artifact-version-1"],
      },
      resultHash: "c".repeat(64),
    },
  ],
  evidence: [],
  defects: [],
  obligations: [],
  reworkLineage: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

describe("Company Runtime client", () => {
  it("parses recursive JSON Test inputs and exact Test scope risk", () => {
    const parsed = TestRunViewSchema.parse(testRunView);
    assert.equal(parsed.manifest.risk.computedTier, "high");
    assert.deepEqual(parsed.manifest.executionOperations[1]?.input, {
      cleanup: { repository: true, worktree: true },
    });
    for (const invalid of [undefined, Number.NaN, new Date()]) {
      assert.equal(
        TestRunViewSchema.safeParse({
          ...testRunView,
          manifest: {
            ...testRunView.manifest,
            executionOperations: [
              {
                ...testRunView.manifest.executionOperations[0],
                input: { nested: [invalid] },
              },
            ],
          },
        }).success,
        false,
      );
    }
  });

  it("parses an authoritative Run Supervision Query View", async () => {
    const requests: ReturnType<typeof RuntimeRequestSchema.parse>[] = [];
    const view = {
      run: scriptedDepartmentRun.run,
      snapshot: {
        id: scriptedDepartmentRun.snapshot.id,
        revision: scriptedDepartmentRun.snapshot.revision,
        hash: scriptedDepartmentRun.snapshot.hash,
      },
      graph: {
        nodes: scriptedDepartmentRun.nodes.map((node) => ({
          nodeRunId: node.id,
          pipelineNodeId: node.pipelineNodeId,
          name: node.pipelineNodeId,
          type: node.nodeType,
          status: node.status,
          attemptId: null,
        })),
        edges:
          scriptedDepartmentRun.snapshot.payload.pipelineVersion.graph.edges,
      },
      timeline: [],
      agentActivities: [],
      interactions: [],
      interventions: [],
      allowedCommands: {
        pause: true,
        resume: false,
        cancelAttemptIds: [],
        cancelTurnIds: [],
        decidePermissionIds: [],
        interveneNodeRunIds: [],
      },
    };
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        requests.push(request);
        return {
          id: request.id,
          ok: true,
          result: { view, asOfSequence: 14 },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.query({
      type: "run.supervision.inspect",
      runId: scriptedDepartmentRun.run.id,
    });

    assert.equal(inspected.run.id, scriptedDepartmentRun.run.id);
    assert.equal(inspected.graph.nodes[0]?.nodeRunId, "node-run-start");
    assert.equal(inspected.allowedCommands.pause, true);
    assert.equal(requests[0]?.kind, "query");
    assert.equal(
      requests[0]?.kind === "query" && "envelope" in requests[0]
        ? requests[0].envelope?.query.type
        : null,
      "run.supervision.inspect",
    );
  });

  it("sends project.update through a verified command envelope and project.inspect through a verified query envelope", async () => {
    const requests: unknown[] = [];
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        requests.push(request);
        if (request.kind === "query") {
          return {
            id: request.id,
            ok: true,
            result: {
              view: {
                id: "project-1",
                name: "Checkout",
                goal: "Ship checkout",
                status: "active",
                revision: 1,
                sharedContext: "",
                repositoryReferences: [],
                departmentRuns: [],
                createdAt: "2026-07-15T00:00:00.000Z",
              },
              asOfSequence: 2,
            },
          };
        }
        return {
          id: request.id,
          ok: true,
          result: {
            status: "succeeded",
            value: {
              id: "project-1",
              name: "Checkout Platform",
              goal: "Ship checkout",
              status: "active",
              revision: 1,
              sharedContext: "",
              repositoryReferences: [],
              departmentRuns: [],
              createdAt: "2026-07-15T00:00:00.000Z",
            },
            effectIds: ["audit-1"],
          },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.query({
      type: "project.inspect",
      projectId: "project-1",
    });
    const updated = await client.execute({
      type: "project.update",
      projectId: "project-1",
      expectedRevision: 0,
      name: "Checkout Platform",
      goal: "Ship checkout",
      sharedContext: "",
      repositoryReferences: [],
    });

    assert.equal(inspected.revision, 1);
    assert.equal(updated.revision, 1);
    assert.equal(
      (
        requests[0] as {
          readonly envelope?: { readonly schemaVersion: number };
        }
      ).envelope?.schemaVersion,
      1,
    );
    assert.equal(
      (
        requests[1] as {
          readonly envelope?: { readonly expectedRevision?: number };
        }
      ).envelope?.expectedRevision,
      0,
    );
    assert.equal(
      (
        requests[1] as {
          readonly envelope?: {
            readonly command?: { readonly expectedRevision?: number };
          };
        }
      ).envelope?.command?.expectedRevision,
      undefined,
    );
  });

  it("parses Technical Review Query and promotion Command envelopes", async () => {
    const requests: ReturnType<typeof RuntimeRequestSchema.parse>[] = [];
    const state = {
      projectId: "project-1",
      runId: "run-1",
      applications: [],
      applicationSpecRevisions: [],
      technicalBaselineProposals: [],
      applicationContracts: [],
      reviewTopics: [],
      conditionalObligations: [],
      acceptedBaseline: null,
      promotion: null,
      snapshotLineage: [
        {
          id: "snapshot-r2",
          revision: 2,
          parentRevision: 1,
          hash: "a".repeat(64),
        },
      ],
    };
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        requests.push(request);
        return request.kind === "query"
          ? {
              id: request.id,
              ok: true,
              result: { view: state, asOfSequence: 12 },
            }
          : {
              id: request.id,
              ok: true,
              result: {
                status: "succeeded",
                value: state,
                effectIds: ["audit-technical"],
              },
            };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.query({
      type: "technical-review.inspect",
      runId: "run-1",
    });
    const promoted = await client.executeEnvelope({
      schemaVersion: 1,
      commandId: "technical-promote-1",
      actor: {
        type: "runtime-worker",
        id: "delivery-coordinator-member",
        authenticatedBy: "runtime",
      },
      consumerId: "runtime-delivery-coordinator",
      expectedRevision: 2,
      command: {
        type: "technical-gate.promote",
        runId: "run-1",
        parentSnapshotRevisionId: "snapshot-r2",
        gateResultId: "technical-gate-1",
      },
    });

    assert.equal(inspected.runId, "run-1");
    assert.equal(promoted.status, "succeeded");
    assert.deepEqual(
      requests.map((request) => request.kind),
      ["query", "command"],
    );
  });

  it("parses Work Package graphs through verified Query envelopes", async () => {
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        return {
          id: request.id,
          ok: true,
          result: {
            view: {
              projectId: "project-1",
              runId: "run-1",
              technicalBaselineId: "technical-baseline-1",
              packages: [],
            },
            asOfSequence: 19,
          },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "work-package-query-1",
      principal: {
        type: "runtime-worker",
        id: "delivery-coordinator-member",
        authenticatedBy: "runtime",
      },
      consumerId: "runtime-delivery-coordinator",
      query: { type: "work-packages.inspect", runId: "run-1" },
    });

    assert.equal(inspected.view.runId, "run-1");
    assert.equal(inspected.asOfSequence, 19);
  });

  it("parses Code Review authority through a verified Query envelope", async () => {
    const requests: ReturnType<typeof RuntimeRequestSchema.parse>[] = [];
    const view = {
      id: "code-review-1",
      topicId: "code-review-topic-1",
      manifest: {
        schemaVersion: 1 as const,
        projectId: "project-1",
        runId: "run-1",
        snapshotRevisionId: "snapshot-1",
        workPackageId: "work-package-1",
        workPackageVersionId: "work-package-version-1",
        assignmentId: "assignment-1",
        nodeRunId: "node-run-1",
        nodeAttemptId: "node-attempt-1",
        repositoryReference: "/tmp/repository",
        baseCommit: "a".repeat(40),
        workspaceImportId: "workspace-import-1",
        sourceCommit: "b".repeat(40),
        diffArtifactVersionId: "diff-artifact-version-1",
        diffHash: "c".repeat(64),
        specRevisionIds: ["application-spec:r1"],
        harnessSnapshotIds: ["harness:tdd@1"],
        acceptanceCriteria: ["Independent PASS gates Integration."],
        selfCheck: {
          id: "self-check-1",
          hash: "d".repeat(64),
          commands: ["npm test"],
          logRefs: ["artifact:self-check-log"],
          evidenceRefs: ["artifact:self-check-evidence"],
        },
        permissions: ["repository.read"],
        errorHandlingInputs: [],
        crossApplicationImpactInputs: [],
        excludedContext: ["producer-workspace" as const],
      },
      manifestHash: "e".repeat(64),
      workspace: {
        id: "reviewer-workspace-1",
        operationKey: "code-review:code-review-1:workspace",
        state: "ready" as const,
        reviewerAiMemberId: "reviewer-member",
        reviewerPositionId: "reviewer-position",
        reviewerSessionId: "reviewer-session-1",
        reviewNodeRunId: "code-review-node-1",
        providerId: "isolated-reviewer",
        workspaceRef: "reviewer-workspace:1",
        capabilitySnapshotHash: "f".repeat(64),
        independenceEvidenceHash: "1".repeat(64),
        failureCode: null,
        failureMessage: null,
      },
      gateResult: null,
      authority: null,
      defects: [],
      integrationEligible: false,
    };
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        requests.push(request);
        return {
          id: request.id,
          ok: true,
          result: { view: [view], asOfSequence: 20 },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.query({
      type: "code-reviews.inspect",
      runId: "run-1",
    });

    assert.equal(inspected[0]?.id, "code-review-1");
    assert.equal(inspected[0]?.manifest.sourceCommit, "b".repeat(40));
    assert.equal(requests[0]?.kind, "query");
    assert.equal(
      requests[0]?.kind === "query" && "envelope" in requests[0]
        ? requests[0].envelope.query.type
        : null,
      "code-reviews.inspect",
    );
  });

  it("parses Integration Generation Query and Command envelopes", async () => {
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        return {
          id: request.id,
          ok: true,
          result:
            request.kind === "query"
              ? { view: [integrationGenerationView], asOfSequence: 22 }
              : {
                  status: "succeeded",
                  value: integrationGenerationView,
                  effectIds: ["audit-integration-1"],
                },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");

    const inspected = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "integration-query-1",
      principal: {
        type: "runtime-worker",
        id: "integration-node-handler",
        authenticatedBy: "runtime",
      },
      consumerId: "integration-node-handler",
      query: { type: "integration-generations.inspect", runId: "run-1" },
    });
    const started = await client.executeEnvelope({
      schemaVersion: 1,
      commandId: "integration-start-1",
      actor: {
        type: "runtime-worker",
        id: "integration-node-handler",
        authenticatedBy: "runtime",
      },
      consumerId: "integration-node-handler",
      command: {
        type: "integration.generation.start",
        generationId: "generation-1",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });

    assert.equal(inspected.view[0]?.id, "generation-1");
    assert.equal(
      inspected.view[0]?.manifest.requiredValidations[0]?.id,
      "validation-1",
    );
    assert.equal(started.status, "succeeded");
    if (started.status === "succeeded") {
      assert.equal(started.value.id, "generation-1");
    }
  });

  it("parses Test Run Query Views and Commands through the typed Runtime tunnel", async () => {
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        return {
          id: request.id,
          ok: true,
          result:
            request.kind === "query"
              ? { view: testRunView, asOfSequence: 31 }
              : {
                  status: "succeeded",
                  value: testRunView,
                  effectIds: ["audit-test-1"],
                },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token");
    const inspected = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "test-query-1",
      principal: actor,
      consumerId: "test-engineer",
      query: { type: "test-runs.inspect", testRunId: "test-run-1" },
    });
    const completed = await client.executeEnvelope({
      schemaVersion: 1,
      commandId: "test-complete-1",
      actor,
      consumerId: "test-engineer",
      command: { type: "test.run.complete", testRunId: "test-run-1" },
    });
    assert.equal(inspected.view.viewHash, "f".repeat(64));
    assert.equal(completed.status, "succeeded");
    if (completed.status === "succeeded") {
      assert.equal(completed.value.passAuthorityHash, "1".repeat(64));
    }
  });

  it("rejects malformed and future Test Run Query Views", async () => {
    for (const view of [
      { ...testRunView, manifest: { schemaVersion: 2 } },
      { ...testRunView, assertions: [{}] },
    ]) {
      const client = createCompanyRuntimeClientFromTransport(
        {
          request: async (input: unknown): Promise<RuntimeResponse> => {
            const request = RuntimeRequestSchema.parse(input);
            return {
              id: request.id,
              ok: true,
              result: { view, asOfSequence: 31 },
            };
          },
        },
        "token",
      );

      await assert.rejects(
        client.queryEnvelope({
          schemaVersion: 1,
          requestId: "test-query-invalid",
          principal: actor,
          consumerId: "test-engineer",
          query: { type: "test-runs.inspect", testRunId: "test-run-1" },
        }),
      );
    }
  });

  it("reads immutable PASS Test authority by exact Test Run ID", async () => {
    const authority = {
      schemaVersion: 1 as const,
      testRunId: "test-run-1",
      manifestHash: "e".repeat(64),
      passAuthorityHash: "1".repeat(64),
      testEngineer: {
        aiMemberId: "test-engineer-member",
        positionId: "test-engineer-position",
        sessionId: "test-engineer-session",
      },
      integrationAuthority: testRunView.manifest.integrationAuthority,
      testCaseRevisions: testRunView.manifest.testCaseRevisions,
      coverageHash: testRunView.manifest.coverageHash,
      build: testRunView.manifest.build,
      buildLineage: testRunView.manifest.buildLineage,
      snapshotRevisionId: testRunView.manifest.snapshotRevisionId,
      executionProfile: testRunView.manifest.executionProfile,
      companyDirectoryFingerprint:
        testRunView.manifest.companyDirectoryFingerprint,
      fixture: testRunView.manifest.fixture,
      environment: testRunView.manifest.environment,
      capabilities: testRunView.manifest.capabilities,
      risk: testRunView.manifest.risk,
      reworkLineage: testRunView.reworkLineage,
      assertionResultHashes: ["2".repeat(64)],
      evidence: [
        {
          id: "evidence-1",
          contentHash: "3".repeat(64),
          artifactVersionId: "artifact-version-1",
          locator: "evidence/runtime.json",
        },
      ],
      evidenceHashes: ["3".repeat(64)],
      defectResolutions: [],
      obligations: [{ id: "obligation-1", status: "closed" as const }],
      openDefectIds: [],
      openObligationIds: [],
    };
    const client = createCompanyRuntimeClientFromTransport(
      {
        request: async (input: unknown): Promise<RuntimeResponse> => {
          const request = RuntimeRequestSchema.parse(input);
          return {
            id: request.id,
            ok: true,
            result: { view: authority, asOfSequence: 32 },
          };
        },
      },
      "token",
    );

    const result = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "test-authority-query-1",
      principal: actor,
      consumerId: "candidate-runtime",
      query: {
        type: "test-pass-authority.inspect",
        testRunId: "test-run-1",
      },
    });

    assert.equal(result.view.testRunId, "test-run-1");
    assert.equal(result.view.passAuthorityHash, "1".repeat(64));
  });

  it("parses Delivery Candidate Input and Quality Gate Query Views plus formal Commands", async () => {
    const candidateInput = {
      id: "candidate-input-1",
      requestId: "candidate-request-1",
      manifest: { schemaVersion: 1, risk: { tier: "high" } },
      manifestHash: "a".repeat(64),
      state: "frozen-for-final-gates" as const,
      createdAt: "2026-07-30T00:00:00.000Z",
    };
    const requests: ReturnType<typeof RuntimeRequestSchema.parse>[] = [];
    const client = createCompanyRuntimeClientFromTransport(
      {
        request: async (input: unknown): Promise<RuntimeResponse> => {
          const request = RuntimeRequestSchema.parse(input);
          requests.push(request);
          if (request.kind === "command") {
            return {
              id: request.id,
              ok: true,
              result: {
                status: "rejected",
                error: {
                  code: "QUALITY_GATE_EXECUTION_NOT_FOUND",
                  message: "Gate execution is absent.",
                },
                effectIds: [],
              },
            };
          }
          const query =
            request.kind === "query" && "envelope" in request
              ? request.envelope.query
              : null;
          return {
            id: request.id,
            ok: true,
            result: {
              view:
                query?.type === "quality-gates.inspect"
                  ? {
                      candidateInput,
                      gateInputs: [],
                      gateResults: [],
                      authority: null,
                    }
                  : candidateInput,
              asOfSequence: 49,
            },
          };
        },
      },
      "token",
    );

    const candidate = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "candidate-query-1",
      principal: actor,
      consumerId: "delivery-coordinator",
      query: {
        type: "delivery-candidate-input.inspect",
        candidateInputId: candidateInput.id,
      },
    });
    const gates = await client.queryEnvelope({
      schemaVersion: 1,
      requestId: "quality-query-1",
      principal: actor,
      consumerId: "delivery-coordinator",
      query: {
        type: "quality-gates.inspect",
        candidateInputId: candidateInput.id,
      },
    });
    const reconciled = await client.executeEnvelope({
      schemaVersion: 1,
      commandId: "quality-reconcile-1",
      actor,
      consumerId: "quality-worker",
      command: {
        type: "quality-gate.execution.reconcile",
        executionId: "missing-execution",
        observation: { state: "unknown" },
      },
    });

    assert.equal(candidate.view.id, candidateInput.id);
    assert.equal(
      gates.view.candidateInput.manifestHash,
      candidateInput.manifestHash,
    );
    assert.equal(reconciled.status, "rejected");
    if (reconciled.status === "rejected") {
      assert.equal(reconciled.error.code, "QUALITY_GATE_EXECUTION_NOT_FOUND");
    }
    assert.deepEqual(
      requests.map((request) => request.kind),
      ["query", "query", "command"],
    );
  });

  it("uses the transport-neutral subscription protocol and keeps consumer identity out of Ack bodies", async () => {
    const requests: ReturnType<typeof RuntimeRequestSchema.parse>[] = [];
    const transport = {
      request: async (input: unknown): Promise<RuntimeResponse> => {
        const request = RuntimeRequestSchema.parse(input);
        requests.push(request);
        if (request.kind === "subscription.open") {
          return {
            id: request.id,
            ok: true,
            result: {
              subscriptionId: "subscription-1",
              subscriptionGeneration: 3,
              barrierSequence: 4,
            },
          };
        }
        if (request.kind === "subscription.read") {
          return {
            id: request.id,
            ok: true,
            result: {
              events: [
                {
                  registryVersion: 1,
                  schemaVersion: 1,
                  sequence: 5,
                  eventId: "event-5",
                  type: "project.updated",
                  companyId: "company",
                  projectId: "project-1",
                  timestamp: "2026-07-15T00:00:00.000Z",
                  payload: { projectId: "project-1", revision: 1 },
                },
              ],
              nextSequence: 5,
              hasMore: false,
            },
          };
        }
        if (request.kind === "subscription.close") {
          return { id: request.id, ok: true, result: { closed: true } };
        }
        return {
          id: request.id,
          ok: true,
          result: {
            status: "succeeded",
            value: {
              acknowledged: true,
              subscriptionGeneration: 3,
              barrierSequence: 5,
              auditId: "audit-1",
            },
            effectIds: ["audit-1"],
          },
        };
      },
    };
    const client = createCompanyRuntimeClientFromTransport(transport, "token", {
      actor: {
        type: "electron-main",
        id: "desktop-main",
        authenticatedBy: "ipc-token",
      },
      consumerId: "desktop-window-1",
    });

    const subscription = await client.openSubscription();
    const batch = await client.readSubscription({
      ...subscription,
      limit: 10,
    });
    const acknowledged = await client.execute({
      type: "ack-runtime-events",
      sequence: batch.nextSequence,
      subscriptionGeneration: subscription.subscriptionGeneration,
    });
    await client.closeSubscription(subscription);

    assert.equal(batch.events[0]?.eventId, "event-5");
    assert.equal(acknowledged.barrierSequence, 5);
    const ackRequest = requests.find(
      (request) =>
        request.kind === "command" &&
        "envelope" in request &&
        request.envelope.command.type === "ack-runtime-events",
    );
    assert.equal(ackRequest?.kind, "command");
    if (ackRequest?.kind === "command" && "envelope" in ackRequest) {
      assert.equal(ackRequest.envelope.consumerId, "desktop-window-1");
      assert.equal("consumerId" in ackRequest.envelope.command, false);
    }
    assert.deepEqual(
      requests.map((request) => request.kind),
      [
        "subscription.open",
        "subscription.read",
        "command",
        "subscription.close",
      ],
    );
  });

  it("lets Agent Catalog discovery own its subprocess timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandcastle-runtime-client-"));
    const address = companyRuntimeAddress(directory);
    if (process.platform !== "win32") {
      mkdirSync(dirname(address), { recursive: true });
    }
    let activeSocket: import("node:net").Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      activeSocket = socket;
      socket.on("error", () => undefined);
      socket.once("data", () => {
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({
              id: "request-1",
              ok: true,
              result: { agents: [] },
            })}\n`,
          );
        }, 50);
      });
    });
    server.listen(address);
    await once(server, "listening");

    try {
      const transport = createLocalRuntimeTransport({
        address,
        token: "token",
        timeoutMs: 10,
      });

      const response = await transport.request({
        id: "request-1",
        token: "token",
        kind: "command",
        command: { type: "agent.catalog.discover" },
      });

      assert.deepEqual(response, {
        id: "request-1",
        ok: true,
        result: { agents: [] },
      });
    } finally {
      activeSocket?.destroy();
      server.close();
      server.unref();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets Pipeline Runtime own the timeout for long-running execution commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandcastle-runtime-client-"));
    const address = companyRuntimeAddress(directory);
    if (process.platform !== "win32") {
      mkdirSync(dirname(address), { recursive: true });
    }
    let activeSocket: import("node:net").Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      activeSocket = socket;
      socket.on("error", () => undefined);
      socket.once("data", () => {
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({
              id: "request-1",
              ok: true,
              result: { completed: true },
            })}\n`,
          );
        }, 50);
      });
    });
    server.listen(address);
    await once(server, "listening");

    try {
      const transport = createLocalRuntimeTransport({
        address,
        token: "token",
        timeoutMs: 10,
      });

      const response = await transport.request({
        id: "request-1",
        token: "token",
        kind: "command",
        command: {
          type: "run.execute-ready",
          runId: "run-1",
          expectedRevision: 0,
        },
      });

      assert.deepEqual(response, {
        id: "request-1",
        ok: true,
        result: { completed: true },
      });
    } finally {
      activeSocket?.destroy();
      server.close();
      server.unref();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
