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
  INTERACTION_PROMPT_CHANNEL,
  SKILL_DISCOVERY_INSPECT_CHANNEL,
  SKILL_DISCOVERY_REFRESH_CHANNEL,
  SKILL_DISCOVERY_ENABLE_CHANNEL,
  SKILL_DISCOVERY_ARCHIVE_CHANNEL,
} from "./bridge.js";
import { scriptedSoftwareRndDepartment } from "../runtime/testing/departmentInspectContract.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

describe("Sandcastle preload bridge", () => {
  it("exposes Interaction Prompt without leaking Electron IPC", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const bridge = createSandcastleBridge(async (channel, payload) => {
      calls.push({ channel, payload });
      return {
        id: "message-1",
        sessionId: "session-1",
        participantId: "human-1",
        kind: "text",
        content: "你好",
        createdAt: "2026-07-15T00:00:00.000Z",
      };
    });

    await bridge.runtime.promptInteraction({
      sessionId: "session-1",
      participantId: "human-1",
      content: "你好",
    });

    assert.deepEqual(calls, [
      {
        channel: INTERACTION_PROMPT_CHANNEL,
        payload: {
          sessionId: "session-1",
          participantId: "human-1",
          content: "你好",
        },
      },
    ]);
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
    assert.deepEqual(Object.keys(bridge), ["runtime"]);
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
      "memoryRecords",
      "createMemoryCandidate",
      "reviewMemoryCandidate",
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
      if (channel === PROJECT_UPDATE_CHANNEL) {
        return {
          ...project,
          revision: 1,
          sharedContext: "Preserve the payment-provider contract.",
          repositoryReferences: ["/work/checkout-web"],
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
      [
        PROJECT_INSPECT_CHANNEL,
        PROJECT_UPDATE_CHANNEL,
        PROJECT_ARCHIVE_CHANNEL,
      ],
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
});
