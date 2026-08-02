import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPANY_OVERVIEW_CHANNEL,
  createSandcastleBridge,
  DEPARTMENT_ARCHIVE_CHANNEL,
  DEPARTMENT_COPY_CHANNEL,
  DEPARTMENT_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
  DEPARTMENT_PIPELINE_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
  DEPARTMENT_PIPELINE_VALIDATE_CHANNEL,
  DEPARTMENT_UPDATE_CHANNEL,
  DEPARTMENTS_LIST_CHANNEL,
  EXECUTION_PROFILE_ARCHIVE_CHANNEL,
  EXECUTION_PROFILE_SAVE_CHANNEL,
  POSITION_ARCHIVE_CHANNEL,
  POSITION_CREATE_CHANNEL,
  POSITION_UPDATE_CHANNEL,
  POSITION_CONFIGURE_CHANNEL,
  PROJECT_ARCHIVE_CHANNEL,
  PROJECT_CREATE_CHANNEL,
  PROJECT_INSPECT_CHANNEL,
  PROJECTS_LIST_CHANNEL,
  PROJECT_UPDATE_CHANNEL,
  RUNTIME_HEALTH_CHANNEL,
  RUNTIME_AUDIT_CHANNEL,
  RUNTIME_EVENTS_CHANNEL,
  RUNTIME_EVENTS_CONSUMER_CHANNEL,
  RUNTIME_EVENTS_ACK_CHANNEL,
  RUNS_LIST_CHANNEL,
  RUN_APPROVAL_DECIDE_CHANNEL,
  RUN_EXECUTE_READY_CHANNEL,
  RUN_PAUSE_CHANNEL,
  RUN_RESUME_CHANNEL,
  RUN_CANCEL_CHANNEL,
  RUN_RECOVER_CHANNEL,
  RUN_INSPECT_CHANNEL,
  RUN_NODE_RETRY_CHANNEL,
  RUN_START_CHANNEL,
  RUN_FORK_CHANNEL,
  isRuntimeBridgeError,
  SECRET_REFERENCE_ARCHIVE_CHANNEL,
  SECRET_REFERENCE_CREATE_CHANNEL,
  SKILL_CATALOG_ARCHIVE_CHANNEL,
  SKILL_CATALOG_SAVE_CHANNEL,
  SKILL_CONFIGURATION_INSPECT_CHANNEL,
  SKILL_FLOW_ARCHIVE_CHANNEL,
  SKILL_FLOW_SAVE_CHANNEL,
  POSITION_SKILLS_SET_CHANNEL,
  AGENT_CATALOG_INSPECT_CHANNEL,
  AGENT_CATALOG_DISCOVER_CHANNEL,
  AGENT_TEST_CHANNEL,
  SKILL_DISCOVERY_INSPECT_CHANNEL,
  SKILL_DISCOVERY_REFRESH_CHANNEL,
  SKILL_DISCOVERY_ENABLE_CHANNEL,
  SKILL_DISCOVERY_ARCHIVE_CHANNEL,
  RUNTIME_TUNNEL_CHANNEL,
  RUNTIME_EVENT_PORT_CHANNEL,
  type RuntimeEventFrame,
} from "./bridge.js";
import { scriptedSoftwareRndDepartment } from "../runtime/testing/departmentInspectContract.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

const workspaceAllocationView = {
  id: "allocation-1",
  projectId: "project-1",
  applicationId: "application-1",
  executionProfileId: "profile-1",
  executionProfileRevision: 1,
  operationKey: "workspace-allocation:allocation-1",
  workPackageVersionId: null,
  nodeAttemptId: null,
  interactionSessionId: null,
  sandboxIdentity: null,
  evidenceScope: null,
  state: "ready" as const,
  repositoryRoot: "/repo",
  allocationRoot: "/workspace",
  sourceBranch: "main",
  baseCommit: "a".repeat(40),
  expectedSourceTip: "b".repeat(40),
  capabilitySnapshot: {},
  capabilitySnapshotHash: "c".repeat(64),
  privateGitIdentity: null,
  provisionReceipt: null,
  cleanupEvidence: null,
  failure: null,
  revision: 2,
  imports: [],
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const codeReviewView = {
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
        commands: [["npm", "test"]],
        evidenceRefs: [],
        responsibleWorkPackageVersionIds: ["package-v1"],
        condition: "npm test",
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
  assertions: [],
  evidence: [],
  defects: [],
  obligations: [],
  reworkLineage: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

describe("Sandcastle preload bridge", () => {
  it("parses Workspace command results through the typed tunnel", async () => {
    const bridge = createSandcastleBridge(async (channel) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      return {
        status: "succeeded",
        value: workspaceAllocationView,
        effectIds: ["audit-workspace-1"],
      };
    });

    const commands = [
      {
        type: "workspace-allocation.provision" as const,
        allocationId: "allocation-1",
        projectId: "project-1",
        applicationId: "application-1",
        executionProfileId: "profile-1",
        sourceBranch: "main",
        baseCommit: "a".repeat(40),
        expectedSourceTip: "b".repeat(40),
      },
      {
        type: "source-import.execute" as const,
        allocationId: "allocation-1",
        resultCommit: "d".repeat(40),
        expectedSourceTip: "b".repeat(40),
      },
      {
        type: "workspace-allocation.cleanup" as const,
        allocationId: "allocation-1",
      },
    ];

    for (const [index, command] of commands.entries()) {
      const result = await bridge.execute({
        commandId: `workspace-command-${index + 1}`,
        expectedRevision: 1,
        command,
      });
      assert.equal(result.status, "succeeded");
      if (result.status === "succeeded") {
        assert.equal(result.value.id, "allocation-1");
        assert.equal(result.value.state, "ready");
      }
    }
  });

  it("parses Run Supervision through the typed query tunnel", async () => {
    const view = {
      run: scriptedDepartmentRun.run,
      snapshot: {
        id: scriptedDepartmentRun.snapshot.id,
        revision: scriptedDepartmentRun.snapshot.revision,
        hash: scriptedDepartmentRun.snapshot.hash,
      },
      graph: { nodes: [], edges: [] },
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
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      const request = payload as {
        readonly operation: "query" | "execute";
        readonly query?: { readonly type?: string };
      };
      if (request.operation === "execute") {
        return { status: "succeeded", value: view, effectIds: ["audit-1"] };
      }
      assert.equal(request.query?.type, "run.supervision.inspect");
      return { view, asOfSequence: 18 };
    });

    const result = await bridge.query({
      type: "run.supervision.inspect",
      runId: scriptedDepartmentRun.run.id,
    });

    assert.equal(result.view.run.id, scriptedDepartmentRun.run.id);
    assert.equal(result.asOfSequence, 18);
    const cancelled = await bridge.execute({
      commandId: "cancel-attempt-1",
      expectedRevision: scriptedDepartmentRun.run.revision,
      command: {
        type: "node-attempt.cancel",
        runId: scriptedDepartmentRun.run.id,
        attemptId: "attempt-1",
      },
    });
    assert.equal(cancelled.status, "succeeded");
    if (cancelled.status === "succeeded") {
      assert.equal(cancelled.value.run.id, scriptedDepartmentRun.run.id);
    }
  });

  it("parses Code Review Query Views and Commands through the typed tunnel", async () => {
    const requests: unknown[] = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      requests.push(payload);
      const request = payload as { readonly operation?: string };
      return request.operation === "query"
        ? { view: [codeReviewView], asOfSequence: 21 }
        : {
            status: "succeeded",
            value: codeReviewView,
            effectIds: ["audit-code-review-1"],
          };
    });

    const inspected = await bridge.query({
      type: "code-reviews.inspect",
      runId: "run-1",
    });
    const converged = await bridge.execute({
      commandId: "code-review-converge-1",
      expectedRevision: 3,
      command: {
        type: "code-review.converge",
        codeReviewId: "code-review-1",
      },
    });

    assert.equal(inspected.view[0]?.manifest.sourceCommit, "b".repeat(40));
    assert.equal(converged.status, "succeeded");
    if (converged.status === "succeeded") {
      assert.equal(converged.value.id, "code-review-1");
    }
    assert.deepEqual(
      requests.map(
        (request) => (request as { readonly operation?: string }).operation,
      ),
      ["query", "execute"],
    );
  });

  it("parses Integration Generation Query Views and Commands through the typed tunnel", async () => {
    const bridge = createSandcastleBridge(async (_channel, payload) => {
      const request = payload as { readonly operation?: string };
      return request.operation === "query"
        ? { view: [integrationGenerationView], asOfSequence: 22 }
        : {
            status: "succeeded",
            value: integrationGenerationView,
            effectIds: ["audit-integration-1"],
          };
    });

    const inspected = await bridge.query({
      type: "integration-generations.inspect",
      runId: "run-1",
    });
    const started = await bridge.execute({
      commandId: "integration-start-1",
      command: {
        type: "integration.generation.start",
        generationId: "generation-1",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });

    assert.equal(inspected.view[0]?.manifestHash, "c".repeat(64));
    assert.equal(
      inspected.view[0]?.manifest.requiredValidations[0]?.id,
      "validation-1",
    );
    assert.equal(started.status, "succeeded");
    if (started.status === "succeeded") {
      assert.equal(started.value.id, "generation-1");
    }
  });

  it("parses Test Run Query Views and Commands through the typed tunnel", async () => {
    const bridge = createSandcastleBridge(async (_channel, payload) => {
      const request = payload as { readonly operation?: string };
      return request.operation === "query"
        ? { view: testRunView, asOfSequence: 31 }
        : {
            status: "succeeded",
            value: testRunView,
            effectIds: ["audit-test-1"],
          };
    });

    const inspected = await bridge.query({
      type: "test-runs.inspect",
      testRunId: "test-run-1",
    });
    const completed = await bridge.execute({
      commandId: "test-complete-1",
      command: { type: "test.run.complete", testRunId: "test-run-1" },
    });
    assert.equal(inspected.view.viewHash, "f".repeat(64));
    assert.equal(completed.status, "succeeded");
    if (completed.status === "succeeded") {
      assert.equal(completed.value.passAuthorityHash, "1".repeat(64));
    }
  });

  it("exposes Interaction Prompt without leaking Electron IPC", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      return {
        status: "succeeded",
        value: {
          id: "turn-1",
          sessionId: "session-1",
          inputMessageId: "message-1",
          outputMessageId: null,
          status: "queued",
          commandId: "command-1",
          executionOperationKey: "interaction-turn:turn-1",
          executionLeaseId: null,
          executionEpoch: null,
          fenceToken: null,
          mechanism: "model-only",
          mechanismVersion: "1",
          contextHash: "a".repeat(64),
          contextSchemaHash: "b".repeat(64),
          terminalExecutionFactId: null,
          providerExecutionRef: null,
          failureCode: null,
          failureMessage: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        effectIds: [],
      };
    });

    await bridge.runtime.promptInteraction({
      sessionId: "session-1",
      participantId: "human-1",
      content: "你好",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.channel, RUNTIME_TUNNEL_CHANNEL);
    const payload = calls[0]?.payload as {
      readonly commandId?: unknown;
      readonly command?: unknown;
      readonly operation?: unknown;
      readonly schemaVersion?: unknown;
    };
    assert.equal(typeof payload.commandId, "string");
    assert.deepEqual(
      { ...payload, commandId: "stable-command-id" },
      {
        schemaVersion: 1,
        operation: "execute",
        commandId: "stable-command-id",
        command: {
          type: "interaction.prompt",
          sessionId: "session-1",
          participantId: "human-1",
          content: "你好",
        },
      },
    );
  });

  it("exposes Agent and independent Skill Catalog commands through preload", async () => {
    const calls: Array<{ channel: string; payload?: unknown }> = [];
    const agentCatalog = {
      agents: [
        {
          id: "codex",
          name: "Codex",
          status: "installed" as const,
          version: "1.2.3",
          executablePath: "/opt/codex",
          lastDetectedAt: "2026-07-16T08:00:00.000Z",
          capabilities: ["non-interactive" as const],
          errorCode: null,
        },
      ],
    };
    const skillCatalog = { directories: [], skills: [] };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      if (
        channel === AGENT_CATALOG_INSPECT_CHANNEL ||
        channel === AGENT_CATALOG_DISCOVER_CHANNEL
      )
        return agentCatalog;
      if (channel === AGENT_TEST_CHANNEL)
        return {
          agentId: "codex",
          status: "passed" as const,
          testedAt: "2026-07-16T08:00:00.000Z",
          summary: "ok",
        };
      if (
        channel === SKILL_DISCOVERY_INSPECT_CHANNEL ||
        channel === SKILL_DISCOVERY_REFRESH_CHANNEL ||
        channel === SKILL_DISCOVERY_ENABLE_CHANNEL ||
        channel === SKILL_DISCOVERY_ARCHIVE_CHANNEL
      )
        return skillCatalog;
      if (channel === POSITION_CONFIGURE_CHANNEL)
        return {
          department: scriptedSoftwareRndDepartment,
          skills: scriptedSkillConfiguration,
        };
      throw new Error(`Unexpected channel ${channel}`);
    });
    assert.equal(
      (await bridge.runtime.inspectAgentCatalog()).agents[0]?.id,
      "codex",
    );
    assert.equal(
      (await bridge.runtime.discoverAgents()).agents[0]?.status,
      "installed",
    );
    assert.equal((await bridge.runtime.testAgent("codex")).status, "passed");
    assert.deepEqual(await bridge.runtime.inspectSkillCatalog(), skillCatalog);
    await bridge.runtime.discoverSkills(["/tmp/skills"]);
    await bridge.runtime.enableSkill("local-review");
    await bridge.runtime.archiveDiscoveredSkill("local-review");
    await bridge.runtime.configurePosition({
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      expectedSkillRevision: 0,
      name: "Software Engineer",
      responsibility: "Ships tested slices.",
      aiMemberDisplayName: "Engineer",
      aiMemberProfile: "",
      aiMemberResponsibilityMetadata: {},
      aiMemberStatus: "active",
      defaultAgentId: "codex",
      skillIds: ["tdd"],
    });
    assert.deepEqual(
      calls.map((call) => call.channel),
      [
        AGENT_CATALOG_INSPECT_CHANNEL,
        AGENT_CATALOG_DISCOVER_CHANNEL,
        AGENT_TEST_CHANNEL,
        SKILL_DISCOVERY_INSPECT_CHANNEL,
        SKILL_DISCOVERY_REFRESH_CHANNEL,
        SKILL_DISCOVERY_ENABLE_CHANNEL,
        SKILL_DISCOVERY_ARCHIVE_CHANNEL,
        POSITION_CONFIGURE_CHANNEL,
      ],
    );
  });
  it("exposes typed Runtime read models through one narrow namespace", async () => {
    const calls: string[] = [];
    const bridge = createSandcastleBridge(async (channel) => {
      calls.push(channel);
      if (channel === RUNTIME_HEALTH_CHANNEL)
        return {
          status: "ok",
          schemaVersion: 1,
          pid: 42,
          startedAt: "2026-07-13T00:00:00.000Z",
        };
      return {
        company: { id: "company", name: "Acme" },
        metrics: {
          activeRuns: 0,
          waitingApprovalRuns: 0,
          blockedRuns: 0,
          completedRuns: 0,
          projects: 0,
          departments: 0,
          artifacts: 0,
        },
        attention: [],
      };
    });

    const health = await bridge.runtime.health();
    const overview = await bridge.runtime.overview();

    assert.deepEqual(calls, [RUNTIME_HEALTH_CHANNEL, COMPANY_OVERVIEW_CHANNEL]);
    assert.deepEqual(health, {
      status: "ok",
      schemaVersion: 1,
      pid: 42,
      startedAt: "2026-07-13T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(bridge), [
      "execute",
      "query",
      "openEventStream",
      "closeEventStream",
      "runtime",
    ]);
    assert.equal(overview.company.name, "Acme");
    assert.deepEqual(Object.keys(bridge.runtime), [
      "health",
      "inspectAgentCatalog",
      "discoverAgents",
      "testAgent",
      "inspectSkillCatalog",
      "discoverSkills",
      "enableSkill",
      "archiveDiscoveredSkill",
      "overview",
      "projects",
      "createProject",
      "inspectProject",
      "applications",
      "inspectProductDiscovery",
      "inspectProductReview",
      "executeProductReviewCommand",
      "inspectTechnicalReview",
      "executeTechnicalReviewCommand",
      "reviewTopics",
      "inspectReviewTopic",
      "inspectDeliveryCandidateInput",
      "inspectQualityGates",
      "inspectDeliveryCandidate",
      "listDeliveryCandidates",
      "inspectAcceptedDeliveryAuthority",
      "executeCriticalRiskEscalationCommand",
      "executeDeliveryCommand",
      "executeReviewCommand",
      "updateProject",
      "archiveProject",
      "departments",
      "inspectDepartment",
      "createDepartment",
      "updateDepartment",
      "archiveDepartment",
      "copyDepartment",
      "createPosition",
      "updatePosition",
      "archivePosition",
      "configurePosition",
      "createSecretReference",
      "archiveSecretReference",
      "saveExecutionProfile",
      "archiveExecutionProfile",
      "inspectSkillConfiguration",
      "saveSkill",
      "archiveSkill",
      "setPositionSkills",
      "saveSkillFlow",
      "archiveSkillFlow",
      "inspectPipeline",
      "validatePipeline",
      "savePipelineDraft",
      "publishPipeline",
      "runs",
      "inspectRun",
      "audit",
      "events",
      "eventsForConsumer",
      "acknowledgeEvents",
      "artifacts",
      "inspectArtifact",
      "setArtifactStatus",
      "interactions",
      "inspectInteraction",
      "createInteractionSession",
      "closeInteractionSession",
      "addInteractionParticipant",
      "addInteractionMessage",
      "promptInteraction",
      "requestPermission",
      "decidePermission",
      "agUiEvents",
      "memoryCandidates",
      "memoryEntries",
      "memorySelections",
      "legacyMemoryRecords",
      "runtimeDiagnostics",
      "backupRuntime",
      "compactRuntimeEvents",
      "startRun",
      "forkRun",
      "executeReady",
      "pauseRun",
      "resumeRun",
      "cancelRun",
      "recoverRun",
      "decideApproval",
      "retryApproval",
      "retryNode",
    ]);
  });

  it("exposes Skill Configuration without leaking Electron IPC", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      return scriptedSkillConfiguration;
    });

    await bridge.runtime.inspectSkillConfiguration("software-rnd");
    await bridge.runtime.saveSkill({
      departmentId: "software-rnd",
      expectedRevision: 0,
      name: "Release notes",
      description: "Produces release notes.",
      source: "local",
      version: "1",
      locationReference: "skill://release-notes",
    });
    await bridge.runtime.archiveSkill({
      departmentId: "software-rnd",
      skillId: "release-notes",
      expectedRevision: 1,
    });
    await bridge.runtime.setPositionSkills({
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      skillIds: ["tdd"],
    });
    await bridge.runtime.saveSkillFlow({
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      name: "Focused delivery",
      instructions: "Deliver one tested behavior.",
      skillIds: ["tdd"],
    });
    await bridge.runtime.archiveSkillFlow({
      departmentId: "software-rnd",
      skillFlowId: "implementation-flow",
      expectedRevision: 0,
    });

    assert.deepEqual(
      calls.map((call) => call.channel),
      [
        SKILL_CONFIGURATION_INSPECT_CHANNEL,
        SKILL_CATALOG_SAVE_CHANNEL,
        SKILL_CATALOG_ARCHIVE_CHANNEL,
        POSITION_SKILLS_SET_CHANNEL,
        SKILL_FLOW_SAVE_CHANNEL,
        SKILL_FLOW_ARCHIVE_CHANNEL,
      ],
    );
  });

  it("preserves structured Runtime error codes across the preload bridge", async () => {
    const bridge = createSandcastleBridge(async () => ({
      sandcastleRuntimeResult: true as const,
      ok: false as const,
      error: {
        code: "SKILL_FLOW_IN_USE",
        message: "Remove the Skill Flow from the current Pipeline first.",
      },
    }));

    await assert.rejects(
      () =>
        bridge.runtime.archiveSkillFlow({
          departmentId: "software-rnd",
          skillFlowId: "implementation-flow",
          expectedRevision: 0,
        }),
      (error: unknown) =>
        isRuntimeBridgeError(error) &&
        error.code === "SKILL_FLOW_IN_USE" &&
        error.message.includes("current Pipeline"),
    );
  });

  it("exposes Project Configuration without leaking Electron IPC", async () => {
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship the checkout redesign",
      status: "active" as const,
      revision: 0,
      sharedContext: "",
      repositoryReferences: [],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === RUNTIME_TUNNEL_CHANNEL) {
        const request = payload as { readonly operation: string };
        if (request.operation === "query") {
          return {
            view: project,
            asOfSequence: 0,
            viewSyncToken: "token-1",
          };
        }
        return {
          status: "succeeded",
          value: {
            ...project,
            revision: 1,
            sharedContext: "Preserve the payment-provider contract.",
            repositoryReferences: ["/work/checkout-web"],
          },
          effectIds: ["effect-1"],
        };
      }
      if (channel === PROJECT_ARCHIVE_CHANNEL) {
        return { ...project, revision: 1, status: "archived" };
      }
      return project;
    });

    await bridge.runtime.inspectProject(project.id);
    await bridge.runtime.updateProject({
      projectId: project.id,
      expectedRevision: 0,
      name: project.name,
      goal: project.goal,
      sharedContext: "Preserve the payment-provider contract.",
      repositoryReferences: ["/work/checkout-web"],
    });
    await bridge.runtime.archiveProject({
      projectId: project.id,
      expectedRevision: 1,
    });

    assert.deepEqual(
      calls.map((call) => call.channel),
      [RUNTIME_TUNNEL_CHANNEL, RUNTIME_TUNNEL_CHANNEL, PROJECT_ARCHIVE_CHANNEL],
    );
  });

  it("exposes Pipeline Configuration without leaking Electron IPC", async () => {
    const graph = {
      nodes: [
        { id: "start", type: "start", name: "Start" },
        { id: "complete", type: "complete", name: "Complete" },
      ],
      edges: [{ from: "start", to: "complete" }],
    };
    const editor = {
      department: { id: "software-rnd", name: "Software R&D" },
      positions: [],
      draft: { revision: 1, graph, updatedAt: "2026-07-14T00:00:00.000Z" },
      validation: { valid: true, issues: [] },
      published: null,
      history: [],
    };
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      return channel === DEPARTMENT_PIPELINE_VALIDATE_CHANNEL
        ? editor.validation
        : editor;
    });

    await bridge.runtime.inspectPipeline("software-rnd");
    await bridge.runtime.validatePipeline({
      departmentId: "software-rnd",
      graph,
    });
    await bridge.runtime.savePipelineDraft({
      departmentId: "software-rnd",
      expectedRevision: 0,
      graph,
    });
    await bridge.runtime.publishPipeline({
      departmentId: "software-rnd",
      expectedRevision: 1,
    });

    assert.deepEqual(
      calls.map((call) => call.channel),
      [
        DEPARTMENT_PIPELINE_INSPECT_CHANNEL,
        DEPARTMENT_PIPELINE_VALIDATE_CHANNEL,
        DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
        DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
      ],
    );
  });

  it("exposes Department Runs through the same narrow bridge", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      return channel === RUNS_LIST_CHANNEL
        ? [scriptedDepartmentRun]
        : scriptedDepartmentRun;
    });

    assert.equal((await bridge.runtime.runs("project-1"))[0]?.run.id, "run-1");
    assert.equal(
      (await bridge.runtime.inspectRun("run-1")).run.status,
      "ready",
    );
    assert.equal(
      (
        await bridge.runtime.startRun({
          projectId: "project-1",
          departmentId: "department-1",
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.executeReady({
          runId: "run-1",
          expectedRevision: 0,
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.forkRun({
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          fromNodeRunId: "node-run-ai-task",
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.pauseRun({
          runId: "run-1",
          expectedRevision: 0,
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.resumeRun({
          runId: "run-1",
          expectedRevision: 0,
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.cancelRun({
          runId: "run-1",
          expectedRevision: 0,
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.recoverRun({
          runId: "run-1",
          nodeRunId: "node-run-ai-task",
          expectedRevision: 0,
          override: { model: "recovery-model" },
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.decideApproval({
          runId: "run-1",
          nodeRunId: "node-run-approval",
          expectedRevision: 1,
          decision: "approve",
        })
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.retryNode({
          runId: "run-1",
          nodeRunId: "node-run-ai-task",
          expectedRevision: 2,
          feedback: "Try again.",
        })
      ).run.id,
      "run-1",
    );
    assert.deepEqual(
      calls.map((call) => call.channel),
      [
        RUNS_LIST_CHANNEL,
        RUN_INSPECT_CHANNEL,
        RUN_START_CHANNEL,
        RUN_EXECUTE_READY_CHANNEL,
        RUN_FORK_CHANNEL,
        RUN_PAUSE_CHANNEL,
        RUN_RESUME_CHANNEL,
        RUN_CANCEL_CHANNEL,
        RUN_RECOVER_CHANNEL,
        RUN_APPROVAL_DECIDE_CHANNEL,
        RUN_NODE_RETRY_CHANNEL,
      ],
    );
  });

  it("exposes Runtime audit and durable event cursors through the narrow bridge", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const createdAt = "2026-07-15T00:00:00.000Z";
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === RUNTIME_AUDIT_CHANNEL) {
        return [
          {
            id: "audit-1",
            action: "run.start",
            entityType: "department-run",
            entityId: "run-1",
            runId: "run-1",
            nodeRunId: null,
            before: null,
            after: { status: "ready" },
            createdAt,
          },
        ];
      }
      if (
        channel === RUNTIME_EVENTS_CHANNEL ||
        channel === RUNTIME_EVENTS_CONSUMER_CHANNEL
      ) {
        return [
          {
            sequence: 1,
            eventId: "event-1",
            type: "run.created",
            runId: "run-1",
            nodeRunId: null,
            payload: { status: "ready" },
            createdAt,
          },
        ];
      }
      return { acknowledged: true };
    });

    assert.equal(
      (await bridge.runtime.audit({ runId: "run-1" }))[0]?.id,
      "audit-1",
    );
    assert.equal(
      (await bridge.runtime.events({ afterSequence: 0, limit: 10 }))[0]
        ?.sequence,
      1,
    );
    assert.equal(
      (
        await bridge.runtime.eventsForConsumer({
          consumerId: "renderer",
          limit: 10,
        })
      )[0]?.eventId,
      "event-1",
    );
    assert.deepEqual(
      await bridge.runtime.acknowledgeEvents({
        consumerId: "renderer",
        sequence: 1,
      }),
      { acknowledged: true },
    );
    assert.deepEqual(
      calls.map((call) => call.channel),
      [
        RUNTIME_AUDIT_CHANNEL,
        RUNTIME_EVENTS_CHANNEL,
        RUNTIME_EVENTS_CONSUMER_CHANNEL,
        RUNTIME_EVENTS_ACK_CHANNEL,
      ],
    );
  });

  it("exposes catalog queries and commands without leaking transport details", async () => {
    const calls: string[] = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push(channel);
      if (channel === PROJECTS_LIST_CHANNEL) {
        return [];
      }
      if (channel === DEPARTMENTS_LIST_CHANNEL) {
        return [];
      }
      if (channel === DEPARTMENT_INSPECT_CHANNEL) {
        return scriptedSoftwareRndDepartment;
      }
      if (
        channel === DEPARTMENT_UPDATE_CHANNEL ||
        channel === DEPARTMENT_ARCHIVE_CHANNEL ||
        channel === DEPARTMENT_COPY_CHANNEL ||
        channel === POSITION_CREATE_CHANNEL ||
        channel === POSITION_ARCHIVE_CHANNEL ||
        channel === SECRET_REFERENCE_CREATE_CHANNEL ||
        channel === SECRET_REFERENCE_ARCHIVE_CHANNEL ||
        channel === EXECUTION_PROFILE_SAVE_CHANNEL ||
        channel === EXECUTION_PROFILE_ARCHIVE_CHANNEL ||
        channel === POSITION_UPDATE_CHANNEL
      ) {
        return scriptedSoftwareRndDepartment;
      }
      return {
        id: "project-1",
        name: "Checkout",
        goal: "Ship it",
        status: "active",
        createdAt: "2026-07-14T00:00:00.000Z",
      };
    });

    await bridge.runtime.projects();
    await bridge.runtime.departments();
    const department = await bridge.runtime.inspectDepartment("software-rnd");
    await bridge.runtime.createProject({ name: "Checkout", goal: "Ship it" });
    await bridge.runtime.updateDepartment({
      departmentId: "software-rnd",
      expectedRevision: 0,
      name: "Product Engineering",
      description: "Builds product changes.",
      inputArtifactContracts: [],
      outputArtifactContracts: [],
      defaultExecutionProfileId: "software-rnd-default",
    });
    await bridge.runtime.archiveDepartment({
      departmentId: "software-rnd",
      expectedRevision: 0,
    });
    await bridge.runtime.copyDepartment({
      departmentId: "software-rnd",
      name: "Product Delivery",
    });
    await bridge.runtime.updatePosition({
      departmentId: "software-rnd",
      positionId: "software-engineer",
      expectedRevision: 0,
      name: "Software Engineer",
      responsibility: "Ships tested slices.",
      aiMemberDisplayName: "Delivery Engineer",
      aiMemberProfile: "",
      aiMemberResponsibilityMetadata: {},
      aiMemberStatus: "inactive",
    });
    await bridge.runtime.createPosition({
      departmentId: "software-rnd",
      name: "Product Designer",
      responsibility: "Designs product flows.",
      aiMemberDisplayName: "Ada",
      aiMemberProfile: "",
      aiMemberResponsibilityMetadata: {},
    });
    await bridge.runtime.archivePosition({
      departmentId: "software-rnd",
      positionId: "product-designer",
      expectedRevision: 0,
    });
    await bridge.runtime.createSecretReference({
      departmentId: "software-rnd",
      name: "OpenAI",
      providerScope: "openai",
    });
    await bridge.runtime.archiveSecretReference({
      departmentId: "software-rnd",
      secretReferenceId: "openai-secret",
    });
    await bridge.runtime.saveExecutionProfile({
      departmentId: "software-rnd",
      expectedRevision: 0,
      name: "Delivery",
      providerRef: "openai",
      model: "gpt-5",
      sandboxRef: "docker",
      branchStrategy: "head",
      timeoutSeconds: 600,
      maxIterations: 5,
      maxTokens: null,
      retryMaxAttempts: 1,
      permissionPolicy: "ask",
      secretReferenceIds: [],
    });
    await bridge.runtime.archiveExecutionProfile({
      departmentId: "software-rnd",
      executionProfileId: "profile-1",
      expectedRevision: 0,
    });

    assert.deepEqual(calls, [
      PROJECTS_LIST_CHANNEL,
      DEPARTMENTS_LIST_CHANNEL,
      DEPARTMENT_INSPECT_CHANNEL,
      PROJECT_CREATE_CHANNEL,
      DEPARTMENT_UPDATE_CHANNEL,
      DEPARTMENT_ARCHIVE_CHANNEL,
      DEPARTMENT_COPY_CHANNEL,
      POSITION_UPDATE_CHANNEL,
      POSITION_CREATE_CHANNEL,
      POSITION_ARCHIVE_CHANNEL,
      SECRET_REFERENCE_CREATE_CHANNEL,
      SECRET_REFERENCE_ARCHIVE_CHANNEL,
      EXECUTION_PROFILE_SAVE_CHANNEL,
      EXECUTION_PROFILE_ARCHIVE_CHANNEL,
    ]);
    assert.equal(department.pipeline?.version, 2);
  });

  it("routes the migrated project slice through the single typed tunnel", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const project = {
      id: "project-1",
      name: "Checkout",
      goal: "Ship it",
      status: "active" as const,
      revision: 1,
      sharedContext: "",
      repositoryReferences: [],
      departmentRuns: [],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel !== RUNTIME_TUNNEL_CHANNEL) {
        throw new Error(`Unexpected channel ${channel}`);
      }
      const request = payload as {
        readonly operation: "query" | "execute";
        readonly query?: unknown;
        readonly command?: unknown;
      };
      if (request.operation === "query") {
        return {
          view: project,
          asOfSequence: 7,
          viewSyncToken: "token-1",
        };
      }
      return {
        status: "succeeded",
        value: project,
        effectIds: ["effect-1"],
      };
    });

    const query = await bridge.query({
      type: "project.inspect",
      projectId: "project-1",
    });
    const result = await bridge.execute({
      commandId: "command-1",
      expectedRevision: 0,
      command: {
        type: "project.update",
        projectId: "project-1",
        name: "Checkout",
        goal: "Ship it",
        sharedContext: "updated",
        repositoryReferences: [],
      },
    });
    await bridge.runtime.inspectProject("project-1");

    assert.equal(query.view.id, "project-1");
    assert.equal(query.asOfSequence, 7);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(
      calls.map((call) => call.channel),
      [RUNTIME_TUNNEL_CHANNEL, RUNTIME_TUNNEL_CHANNEL, RUNTIME_TUNNEL_CHANNEL],
    );
    for (const call of calls) {
      const payload = call.payload as Record<string, unknown>;
      assert.equal("actor" in payload, false);
      assert.equal("principal" in payload, false);
      assert.equal("consumerId" in payload, false);
    }
  });

  it("routes Candidate Input and Quality Gate queries and Commands through the typed tunnel", async () => {
    const calls: unknown[] = [];
    const candidateInput = {
      id: "candidate-input-1",
      requestId: "candidate-request-1",
      manifest: { schemaVersion: 1, risk: { tier: "high" } },
      manifestHash: "a".repeat(64),
      state: "frozen-for-final-gates" as const,
      createdAt: "2026-07-30T00:00:00.000Z",
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      const request = payload as {
        readonly operation: "query" | "execute";
        readonly query?: { readonly type?: string };
      };
      if (request.operation === "execute") {
        return {
          status: "rejected",
          error: {
            code: "QUALITY_GATE_EXECUTION_NOT_FOUND",
            message: "Gate execution is absent.",
          },
          effectIds: [],
        };
      }
      return {
        view:
          request.query?.type === "quality-gates.inspect"
            ? {
                candidateInput,
                gateInputs: [],
                gateResults: [],
                authority: null,
              }
            : candidateInput,
        asOfSequence: 49,
      };
    });

    assert.equal(
      (await bridge.runtime.inspectDeliveryCandidateInput(candidateInput.id))
        .id,
      candidateInput.id,
    );
    assert.equal(
      (await bridge.runtime.inspectQualityGates(candidateInput.id))
        .candidateInput.manifestHash,
      candidateInput.manifestHash,
    );
    const reconciled = await bridge.execute({
      commandId: "quality-reconcile-1",
      command: {
        type: "quality-gate.execution.reconcile",
        executionId: "missing-execution",
        observation: { state: "unknown" },
      },
    });
    assert.equal(reconciled.status, "rejected");
    assert.deepEqual(
      calls.map((call) => (call as { readonly operation: string }).operation),
      ["query", "query", "execute"],
    );
    for (const call of calls) {
      const payload = call as Record<string, unknown>;
      assert.equal("actor" in payload, false);
      assert.equal("principal" in payload, false);
      assert.equal("consumerId" in payload, false);
    }
  });

  it("routes Delivery Candidate queries and Human release Commands through the typed tunnel", async () => {
    const calls: unknown[] = [];
    const candidate = {
      id: "delivery-candidate-1",
      requestId: "delivery-candidate-request-1",
      manifest: {},
      manifestHash: "a".repeat(64),
      projection: "awaiting-decision" as const,
      decision: null,
      supersededByCandidateId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const authority = {
      id: "accepted-authority-1",
      candidateId: candidate.id,
      candidateHash: candidate.manifestHash,
      releaseDecisionId: "release-decision-1",
      releaseDecisionHash: "b".repeat(64),
      candidateInputId: "candidate-input-1",
      candidateInputHash: "c".repeat(64),
      gateAuthorityId: "gate-authority-1",
      gateAuthorityHash: "d".repeat(64),
      integrationGenerationId: "integration-generation-1",
      integrationAuthorityHash: "e".repeat(64),
      repositoryCommits: [
        {
          repositoryReference: "/repositories/api",
          commit: "f".repeat(40),
        },
      ],
      artifactVersionIds: ["artifact-version-1"],
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      authorityHash: "1".repeat(64),
      createdAt: "2026-08-01T00:01:00.000Z",
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      const request = payload as {
        readonly operation: "query" | "execute";
        readonly query?: { readonly type?: string };
      };
      if (request.operation === "execute") {
        return { status: "succeeded", value: candidate, effectIds: [] };
      }
      return {
        view:
          request.query?.type === "delivery-candidates.list"
            ? [candidate]
            : request.query?.type === "accepted-delivery-authority.inspect"
              ? authority
              : candidate,
        asOfSequence: 50,
      };
    });

    assert.equal(
      (await bridge.runtime.inspectDeliveryCandidate(candidate.id)).id,
      candidate.id,
    );
    assert.equal(
      (await bridge.runtime.listDeliveryCandidates(authority.runId))[0]?.id,
      candidate.id,
    );
    assert.equal(
      (await bridge.runtime.inspectAcceptedDeliveryAuthority(candidate.id))
        .authorityHash,
      authority.authorityHash,
    );
    assert.equal(
      (
        await bridge.runtime.executeDeliveryCommand({
          commandId: "release-command-1",
          command: {
            type: "delivery.release.decide",
            decisionId: authority.releaseDecisionId,
            candidateId: candidate.id,
            expectedCandidateHash: candidate.manifestHash,
            decision: "accepted",
            reason: "The immutable Candidate evidence was reviewed.",
            evidenceRefs: ["artifact-version:artifact-version-1"],
          },
        })
      ).id,
      candidate.id,
    );
    assert.deepEqual(
      calls.map((call) => (call as { readonly operation: string }).operation),
      ["query", "query", "query", "execute"],
    );
    for (const call of calls) {
      const payload = call as Record<string, unknown>;
      assert.equal("actor" in payload, false);
      assert.equal("principal" in payload, false);
      assert.equal("consumerId" in payload, false);
    }
  });

  it("routes a critical-risk escalation gesture through typed IPC without renderer-supplied actor authority", async () => {
    const calls: unknown[] = [];
    const decision = {
      id: "critical-escalation-1",
      candidateInputId: "candidate-input-critical-1",
      candidateInputHash: "a".repeat(64),
      decision: "reject" as const,
      actor: {
        type: "human" as const,
        id: "verified-local-human",
        authenticatedBy: "local-session" as const,
      },
      risk: { tier: "critical" },
      riskHash: "b".repeat(64),
      reason: "The immutable critical-risk evidence cannot continue.",
      evidenceRefs: ["artifact-version:risk-evidence-1"],
      decisionHash: "c".repeat(64),
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      return { status: "succeeded", value: decision, effectIds: ["audit-1"] };
    });

    assert.deepEqual(
      await bridge.runtime.executeCriticalRiskEscalationCommand({
        commandId: "critical-escalation-command-1",
        command: {
          type: "quality-gate.critical-escalation.decide",
          escalationId: decision.id,
          candidateInputId: decision.candidateInputId,
          expectedCandidateInputHash: decision.candidateInputHash,
          decision: "reject",
          reason: decision.reason,
          evidenceRefs: decision.evidenceRefs,
        },
      }),
      decision,
    );
    assert.equal(calls.length, 1);
    const payload = calls[0] as Record<string, unknown>;
    assert.equal(payload.operation, "execute");
    assert.equal("actor" in payload, false);
    assert.equal("principal" in payload, false);
    assert.equal("consumerId" in payload, false);
  });

  it("routes Work Package Query and Command envelopes through typed IPC", async () => {
    const calls: unknown[] = [];
    const graph = {
      projectId: "project-1",
      runId: "run-1",
      technicalBaselineId: "technical-baseline-1",
      packages: [],
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      const request = payload as { readonly operation: "query" | "execute" };
      return request.operation === "query"
        ? { view: graph, asOfSequence: 21 }
        : { status: "succeeded", value: graph, effectIds: ["effect-wp"] };
    });

    const inspected = await bridge.query({
      type: "work-packages.inspect",
      runId: "run-1",
    });
    const started = await bridge.execute({
      commandId: "start-package-a",
      expectedRevision: 1,
      command: { type: "work-package.start", workPackageId: "package-a" },
    });

    assert.equal(inspected.view.technicalBaselineId, "technical-baseline-1");
    assert.equal(started.status, "succeeded");
    assert.deepEqual(
      calls.map((call) => (call as { readonly operation: string }).operation),
      ["query", "execute"],
    );
    for (const call of calls) {
      const payload = call as Record<string, unknown>;
      assert.equal("actor" in payload, false);
      assert.equal("principal" in payload, false);
      assert.equal("consumerId" in payload, false);
    }
  });

  it("routes Product Review Query and Command envelopes through typed IPC", async () => {
    const calls: unknown[] = [];
    const state = {
      projectId: "project-1",
      runId: "run-1",
      productBaselineId: "baseline-1",
      productBaselineHash: "a".repeat(64),
      specRevisions: [],
      reviewTopics: [],
      readinessEvidence: [],
      readinessBlockers: [],
      promotion: null,
      snapshotLineage: [
        {
          id: "snapshot-r1",
          revision: 1,
          parentRevision: null,
          hash: "b".repeat(64),
        },
      ],
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      const request = payload as { operation: "query" | "execute" };
      return request.operation === "query"
        ? { view: state, asOfSequence: 9 }
        : { status: "succeeded", value: state, effectIds: ["audit-1"] };
    });

    assert.equal(
      (await bridge.runtime.inspectProductReview("run-1")).runId,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.executeProductReviewCommand({
          commandId: "spec-r1",
          expectedRevision: 0,
          command: {
            type: "project-spec.revise",
            runId: "run-1",
            producerSessionId: "product-session",
            content: {
              outcome: "Ship checkout",
              acceptanceCriteria: ["One order"],
              applicationBoundaries: ["checkout-web"],
              crossApplicationContracts: ["checkout-v1"],
              deliveryConstraints: ["Local-first"],
            },
          },
        })
      ).runId,
      "run-1",
    );
    assert.equal(calls.length, 2);
  });

  it("routes Technical Review Query and Command envelopes through typed IPC", async () => {
    const calls: unknown[] = [];
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
          hash: "b".repeat(64),
        },
      ],
    };
    const bridge = createSandcastleBridge(async (channel, payload) => {
      assert.equal(channel, RUNTIME_TUNNEL_CHANNEL);
      calls.push(payload);
      const request = payload as {
        operation: "query" | "execute";
        query?: { type?: string };
      };
      return request.operation === "query"
        ? {
            view: request.query?.type === "applications.list" ? [] : state,
            asOfSequence: 10,
          }
        : { status: "succeeded", value: state, effectIds: ["audit-technical"] };
    });

    assert.deepEqual(await bridge.runtime.applications("project-1"), []);
    assert.equal(
      (await bridge.runtime.inspectTechnicalReview("run-1")).runId,
      "run-1",
    );
    assert.equal(
      (
        await bridge.runtime.executeTechnicalReviewCommand({
          commandId: "technical-promote-1",
          expectedRevision: 2,
          command: {
            type: "technical-gate.promote",
            runId: "run-1",
            parentSnapshotRevisionId: "snapshot-r2",
            gateResultId: "technical-gate-1",
          },
        })
      ).runId,
      "run-1",
    );
    assert.equal(calls.length, 3);
  });

  it("separates governed Memory queries from legacy records and routes proposal Commands", async () => {
    const hash = "a".repeat(64);
    const candidate = {
      id: "memory-candidate-1",
      projectId: "project-1",
      scope: "project",
      aiMemberId: null,
      status: "draft",
      revision: 1,
      currentRevision: {
        id: "memory-candidate-r1",
        revision: 1,
        supersedesRevisionId: null,
        content: "Use exact reviewed evidence.",
        hash,
        redactionPolicy: { version: "redaction-v1", hash },
        sourceArtifactVersions: [{ id: "artifact-r1", hash }],
        sourceEventRanges: [{ runId: "run-1", fromSequence: 1, toSequence: 2 }],
        producer: {
          aiMemberId: "member-1",
          positionId: "position-1",
          sessionId: "session-1",
        },
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      reviewTopicId: null,
      decision: null,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    const bridge = createSandcastleBridge(async (_channel, payload) => {
      const request = payload as {
        operation: "query" | "execute";
        query?: { type?: string };
      };
      if (request.operation === "execute") {
        return {
          status: "succeeded",
          value: candidate,
          effectIds: ["audit-1"],
        };
      }
      return {
        view:
          request.query?.type === "memory.candidates.list" ? [candidate] : [],
        asOfSequence: 11,
      };
    });

    assert.equal(
      (await bridge.runtime.memoryCandidates("project-1")).length,
      1,
    );
    assert.deepEqual(await bridge.runtime.memoryEntries("project-1"), []);
    assert.deepEqual(await bridge.runtime.legacyMemoryRecords("project-1"), []);
    const proposed = await bridge.execute({
      commandId: "memory-propose-1",
      command: {
        type: "memory.candidate.propose",
        candidateId: "memory-candidate-1",
        revisionId: "memory-candidate-r1",
        projectId: "project-1",
        scope: "project",
        producer: candidate.currentRevision.producer,
        content: candidate.currentRevision.content,
        redactionPolicy: candidate.currentRevision.redactionPolicy,
        sourceArtifactVersions:
          candidate.currentRevision.sourceArtifactVersions,
        sourceEventRanges: candidate.currentRevision.sourceEventRanges,
      },
    });
    assert.equal(proposed.status, "succeeded");
    if (proposed.status === "succeeded") {
      assert.equal(proposed.value.id, "memory-candidate-1");
    }
  });

  it("recovers with Query View, View-sync Ack, then a new stream generation", async () => {
    const operations: string[] = [];
    let attachPort!: (attachment: {
      readonly streamRequestId: string;
      readonly port: {
        onmessage: ((event: { data: unknown }) => void) | null;
        start(): void;
        close(): void;
        postMessage(value: unknown): void;
      };
    }) => void;
    const port = {
      onmessage: null,
      start: () => undefined,
      close: () => undefined,
      postMessage: () => undefined,
    };
    const bridge = createSandcastleBridge(
      async (_channel, payload) => {
        const request = payload as {
          readonly operation: string;
          readonly streamRequestId?: string;
          readonly command?: {
            readonly type?: string;
            readonly consumerId?: string;
          };
        };
        operations.push(request.operation);
        if (request.operation === "query") {
          return {
            view: {
              id: "project-1",
              name: "Checkout",
              goal: "Ship it",
              status: "active",
              revision: 1,
              sharedContext: "",
              repositoryReferences: [],
              departmentRuns: [],
              createdAt: "2026-07-14T00:00:00.000Z",
            },
            asOfSequence: 12,
            viewSyncToken: "view-token-12",
          };
        }
        if (request.operation === "execute") {
          assert.equal(request.command?.type, "ack-runtime-events");
          assert.equal("consumerId" in (request.command ?? {}), false);
          return {
            status: "succeeded",
            value: {
              acknowledged: true,
              subscriptionGeneration: 5,
              barrierSequence: 12,
              auditId: "audit-12",
            },
            effectIds: ["audit-12"],
          };
        }
        queueMicrotask(() => {
          attachPort({ streamRequestId: request.streamRequestId!, port });
        });
        return {
          subscriptionId: "subscription-5",
          subscriptionGeneration: 5,
          barrierSequence: 12,
        };
      },
      {
        onPort(listener) {
          attachPort = listener as typeof attachPort;
        },
      },
    );

    const query = await bridge.query({
      type: "project.inspect",
      projectId: "project-1",
    });
    const ack = await bridge.execute({
      commandId: "ack-12",
      command: {
        type: "ack-runtime-events",
        sequence: query.asOfSequence,
        viewSyncToken: query.viewSyncToken!,
      },
    });
    const handle = await bridge.openEventStream(() => undefined);

    assert.equal(ack.status, "succeeded");
    assert.equal(handle.barrierSequence, query.asOfSequence);
    assert.deepEqual(operations, ["query", "execute", "open-event-stream"]);
  });

  it("drops stale MessagePort frames and waits for callback barriers before crediting", async () => {
    type FakePort = {
      onmessage: ((event: { data: unknown }) => void) | null;
      readonly sent: unknown[];
      start(): void;
      close(): void;
      postMessage(value: unknown): void;
    };
    const ports: FakePort[] = [];
    let attachPort!: (attachment: {
      readonly streamRequestId: string;
      readonly port: FakePort;
    }) => void;
    let resolveFrame!: () => void;
    let frameStarted = false;
    const makePort = (): FakePort => {
      const port: FakePort = {
        onmessage: null,
        sent: [],
        start: () => undefined,
        close: () => undefined,
        postMessage(value) {
          port.sent.push(value);
        },
      };
      ports.push(port);
      return port;
    };
    const bridge = createSandcastleBridge(
      async (_channel, payload) => {
        const request = payload as { readonly operation: string };
        if (request.operation === "open-event-stream") {
          const port = makePort();
          queueMicrotask(() => {
            attachPort({
              streamRequestId: (payload as { streamRequestId: string })
                .streamRequestId,
              port,
            });
          });
          return {
            subscriptionId: ports.length.toString(),
            subscriptionGeneration: ports.length,
            barrierSequence: 0,
          };
        }
        return { closed: true };
      },
      {
        onPort(listener) {
          attachPort = listener as typeof attachPort;
        },
      },
    );
    const received: RuntimeEventFrame[] = [];
    const first = bridge.openEventStream(async (frame) => {
      received.push(frame);
      if (!frameStarted) {
        frameStarted = true;
        await new Promise<void>((resolve) => {
          resolveFrame = resolve;
        });
      }
    });
    const firstHandle = await first;
    const firstPort = ports[0]!;
    firstPort.onmessage?.({
      data: {
        subscriptionId: firstHandle.subscriptionId,
        subscriptionGeneration: firstHandle.subscriptionGeneration,
        barrierSequence: 0,
        value: {
          kind: "event",
          event: {
            registryVersion: 1,
            schemaVersion: 1,
            sequence: 1,
            eventId: "event-1",
            type: "project.updated",
            companyId: "company-1",
            timestamp: "2026-07-14T00:00:00.000Z",
            payload: {},
          },
        },
      },
    });
    await Promise.resolve();
    assert.equal(firstPort.sent.length, 1);
    const closing = bridge.closeEventStream(firstHandle);
    firstPort.onmessage?.({
      data: {
        subscriptionId: firstHandle.subscriptionId,
        subscriptionGeneration: firstHandle.subscriptionGeneration,
        barrierSequence: 0,
        value: { kind: "event", event: { sequence: 2 } },
      },
    });
    resolveFrame();
    await closing;
    assert.equal(received.length, 1);

    const secondHandle = await bridge.openEventStream(async (frame) => {
      received.push(frame);
    });
    const secondPort = ports[1]!;
    secondPort.onmessage?.({
      data: {
        subscriptionId: firstHandle.subscriptionId,
        subscriptionGeneration: firstHandle.subscriptionGeneration,
        barrierSequence: 0,
        value: { kind: "event", event: { sequence: 3 } },
      },
    });
    secondPort.onmessage?.({
      data: {
        subscriptionId: secondHandle.subscriptionId,
        subscriptionGeneration: secondHandle.subscriptionGeneration,
        barrierSequence: 0,
        value: {
          kind: "control",
          control: { type: "cursor.accepted", barrierSequence: 0 },
        },
      },
    });
    await Promise.resolve();
    assert.equal(received.length, 2);
    assert.equal(received[1]?.value.kind, "control");
  });
});
