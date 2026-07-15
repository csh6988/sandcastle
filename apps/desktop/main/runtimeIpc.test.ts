import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPANY_OVERVIEW_CHANNEL,
  ARTIFACT_STATUS_CHANNEL,
  DEPARTMENT_ARCHIVE_CHANNEL,
  DEPARTMENT_COPY_CHANNEL,
  DEPARTMENT_CREATE_CHANNEL,
  DEPARTMENT_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL,
  DEPARTMENT_PIPELINE_INSPECT_CHANNEL,
  DEPARTMENT_PIPELINE_PUBLISH_CHANNEL,
  DEPARTMENT_PIPELINE_VALIDATE_CHANNEL,
  DEPARTMENT_UPDATE_CHANNEL,
  DEPARTMENTS_LIST_CHANNEL,
  POSITION_UPDATE_CHANNEL,
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
  RUN_INSPECT_CHANNEL,
  RUN_NODE_RETRY_CHANNEL,
  RUN_START_CHANNEL,
  SKILL_CATALOG_ARCHIVE_CHANNEL,
  SKILL_CATALOG_SAVE_CHANNEL,
  SKILL_CONFIGURATION_INSPECT_CHANNEL,
  SKILL_FLOW_ARCHIVE_CHANNEL,
  SKILL_FLOW_SAVE_CHANNEL,
  POSITION_SKILLS_SET_CHANNEL,
} from "../preload/bridge.js";
import { registerRuntimeIpc } from "./runtimeIpc.js";
import { scriptedSoftwareRndDepartment } from "../runtime/testing/departmentInspectContract.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

describe("Runtime Electron IPC", () => {
  it("routes the allowlisted health query to the active supervisor", async () => {
    const handlers = new Map<
      string,
      ((...args: readonly unknown[]) => Promise<unknown> | unknown) | undefined
    >();
    registerRuntimeIpc(
      {
        handle(nextChannel, nextHandler) {
          handlers.set(nextChannel, nextHandler);
        },
      },
      () => ({
        health: async () => ({
          status: "ok",
          schemaVersion: 1,
          pid: 42,
          startedAt: "2026-07-13T00:00:00.000Z",
        }),
        overview: async () => ({
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
        }),
        projects: async () => [],
        createProject: async (input) => ({
          id: "project-1",
          ...input,
          status: "active" as const,
          createdAt: "2026-07-14T00:00:00.000Z",
        }),
        inspectProject: async (projectId) => ({
          id: projectId,
          name: "Checkout",
          goal: "Ship it",
          status: "active" as const,
          revision: 0,
          sharedContext: "",
          repositoryReferences: [],
          departmentRuns: [],
          createdAt: "2026-07-14T00:00:00.000Z",
        }),
        updateProject: async (input) => {
          if (input.name === "Conflict") {
            throw Object.assign(new Error("Project revision is stale."), {
              code: "VERSION_CONFLICT",
            });
          }
          return {
            id: input.projectId,
            name: input.name,
            goal: input.goal,
            status: "active" as const,
            revision: input.expectedRevision + 1,
            sharedContext: input.sharedContext,
            repositoryReferences: [...input.repositoryReferences],
            departmentRuns: [],
            createdAt: "2026-07-14T00:00:00.000Z",
          };
        },
        archiveProject: async (input) => ({
          id: input.projectId,
          name: "Checkout",
          goal: "Ship it",
          status: "archived" as const,
          revision: input.expectedRevision + 1,
          sharedContext: "",
          repositoryReferences: [],
          departmentRuns: [],
          createdAt: "2026-07-14T00:00:00.000Z",
        }),
        departments: async () => [],
        inspectDepartment: async () => scriptedSoftwareRndDepartment,
        createDepartment: async (input) => ({
          id: "department-1",
          ...input,
          description: "",
          status: "active" as const,
          revision: 0,
          builtIn: false,
          activeRuns: 0,
          positionCount: 0,
          publishedPipelineVersion: null,
          createdAt: "2026-07-14T00:00:00.000Z",
        }),
        updateDepartment: async () => scriptedSoftwareRndDepartment,
        archiveDepartment: async () => ({
          ...scriptedSoftwareRndDepartment,
          status: "archived" as const,
        }),
        copyDepartment: async (input) => ({
          ...scriptedSoftwareRndDepartment,
          id: "copied-department",
          name: input.name,
          builtIn: false,
        }),
        createPosition: async () => scriptedSoftwareRndDepartment,
        updatePosition: async () => scriptedSoftwareRndDepartment,
        archivePosition: async () => scriptedSoftwareRndDepartment,
        createSecretReference: async () => scriptedSoftwareRndDepartment,
        archiveSecretReference: async () => scriptedSoftwareRndDepartment,
        saveExecutionProfile: async () => scriptedSoftwareRndDepartment,
        archiveExecutionProfile: async () => scriptedSoftwareRndDepartment,
        inspectSkillConfiguration: async () => scriptedSkillConfiguration,
        saveSkill: async () => scriptedSkillConfiguration,
        archiveSkill: async () => scriptedSkillConfiguration,
        setPositionSkills: async () => scriptedSkillConfiguration,
        saveSkillFlow: async () => scriptedSkillConfiguration,
        archiveSkillFlow: async () => scriptedSkillConfiguration,
        inspectPipeline: async () => ({
          department: { id: "software-rnd", name: "Software R&D" },
          positions: [],
          draft: {
            revision: 0,
            graph: {
              nodes: [
                { id: "start", type: "start", name: "Start" },
                { id: "complete", type: "complete", name: "Complete" },
              ],
              edges: [{ from: "start", to: "complete" }],
            },
            updatedAt: null,
          },
          validation: { valid: true, issues: [] },
          published: null,
          history: [],
        }),
        validatePipeline: async () => ({ valid: true, issues: [] }),
        savePipelineDraft: async (input) => ({
          department: { id: input.departmentId, name: "Software R&D" },
          positions: [],
          draft: {
            revision: input.expectedRevision + 1,
            graph: input.graph,
            updatedAt: "2026-07-14T00:00:00.000Z",
          },
          validation: { valid: true, issues: [] },
          published: null,
          history: [],
        }),
        publishPipeline: async (input) => ({
          ...(await (async () => ({
            department: { id: input.departmentId, name: "Software R&D" },
            positions: [],
            draft: {
              revision: input.expectedRevision,
              graph: {
                nodes: [
                  { id: "start", type: "start", name: "Start" },
                  { id: "complete", type: "complete", name: "Complete" },
                ],
                edges: [{ from: "start", to: "complete" }],
              },
              updatedAt: "2026-07-14T00:00:00.000Z",
            },
            validation: { valid: true, issues: [] },
            published: null,
            history: [],
          }))()),
        }),
        runs: async () => [scriptedDepartmentRun],
        inspectRun: async () => scriptedDepartmentRun,
        startRun: async () => scriptedDepartmentRun,
        forkRun: async () => scriptedDepartmentRun,
        executeReady: async () => scriptedDepartmentRun,
        pauseRun: async () => scriptedDepartmentRun,
        resumeRun: async () => scriptedDepartmentRun,
        cancelRun: async () => scriptedDepartmentRun,
        recoverRun: async () => scriptedDepartmentRun,
        decideApproval: async () => scriptedDepartmentRun,
        retryNode: async () => scriptedDepartmentRun,
        audit: async () => [],
        events: async () => [],
        eventsForConsumer: async () => [],
        acknowledgeEvents: async () => ({ acknowledged: true as const }),
        artifacts: async () => [],
        inspectArtifact: async () => {
          throw new Error("not used");
        },
        setArtifactStatus: async (input) => ({
          id: input.versionId,
          artifactId: "artifact-1",
          projectId: "project-1",
          type: "verification-report",
          schemaVersion: "1",
          logicalName: "verification",
          version: 1,
          contentRef: ".sandcastle/artifacts/artifact-1/1.bin",
          contentHash: "a".repeat(64),
          byteSize: 1,
          status: input.status,
          producer: {
            runId: "run-1",
            nodeRunId: "node-1",
            nodeAttemptId: "attempt-1",
            snapshotRevisionId: "snapshot-1",
            aiMemberId: "member-1",
          },
          createdAt: "2026-07-15T00:00:00.000Z",
        }),
        interactions: async () => [],
        inspectInteraction: async () => {
          throw new Error("not used");
        },
        createInteractionSession: async () => {
          throw new Error("not used");
        },
        closeInteractionSession: async () => {
          throw new Error("not used");
        },
        addInteractionParticipant: async () => {
          throw new Error("not used");
        },
        addInteractionMessage: async () => {
          throw new Error("not used");
        },
        requestPermission: async () => {
          throw new Error("not used");
        },
        decidePermission: async () => {
          throw new Error("not used");
        },
        agUiEvents: async () => ({ events: [], nextSequence: 0 }),
        memoryCandidates: async () => [],
        memoryRecords: async () => [],
        createMemoryCandidate: async () => {
          throw new Error("not used");
        },
        reviewMemoryCandidate: async () => {
          throw new Error("not used");
        },
        runtimeDiagnostics: async () => ({
          schemaVersion: 20,
          sqliteIntegrity: "ok",
          databaseBytes: 0,
          runtimeEventCount: 0,
          pendingRuntimeEventCount: 0,
          auditRecordCount: 0,
          activeLeaseCount: 0,
          cursorCount: 0,
        }),
        backupRuntime: async () => ({
          path: "/company/.sandcastle/backups/company.sqlite",
          schemaVersion: 20,
          createdAt: "2026-07-15T00:00:00.000Z",
        }),
        compactRuntimeEvents: async () => ({ deleted: 0, retained: 0 }),
      }),
    );

    assert.deepEqual(await handlers.get(RUNTIME_HEALTH_CHANNEL)?.(), {
      status: "ok",
      schemaVersion: 1,
      pid: 42,
      startedAt: "2026-07-13T00:00:00.000Z",
    });
    assert.equal(
      (
        (await handlers.get(COMPANY_OVERVIEW_CHANNEL)?.()) as {
          company: { name: string };
        }
      ).company.name,
      "Acme",
    );
    assert.deepEqual(await handlers.get(PROJECTS_LIST_CHANNEL)?.(), []);
    assert.equal(
      (
        (await handlers.get(ARTIFACT_STATUS_CHANNEL)?.(
          {},
          {
            versionId: "artifact-version-1",
            expectedStatus: "produced",
            status: "accepted",
          },
        )) as { status: string }
      ).status,
      "accepted",
    );
    assert.deepEqual(
      await handlers.get(RUNTIME_AUDIT_CHANNEL)?.({}, { runId: "run-1" }),
      [],
    );
    assert.deepEqual(
      await handlers.get(RUNTIME_EVENTS_CHANNEL)?.(
        {},
        { afterSequence: 0, limit: 10 },
      ),
      [],
    );
    assert.deepEqual(
      await handlers.get(RUNTIME_EVENTS_CONSUMER_CHANNEL)?.(
        {},
        { consumerId: "renderer", limit: 10 },
      ),
      [],
    );
    assert.deepEqual(
      await handlers.get(RUNTIME_EVENTS_ACK_CHANNEL)?.(
        {},
        { consumerId: "renderer", sequence: 0 },
      ),
      { acknowledged: true },
    );
    assert.deepEqual(
      await handlers.get(PROJECT_CREATE_CHANNEL)?.(
        {},
        { name: "Checkout", goal: "Ship it" },
      ),
      {
        id: "project-1",
        name: "Checkout",
        goal: "Ship it",
        status: "active",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    );
    assert.equal(
      (
        (await handlers.get(PROJECT_INSPECT_CHANNEL)?.({}, "project-1")) as {
          revision: number;
        }
      ).revision,
      0,
    );
    assert.equal(
      (
        (await handlers.get(PROJECT_UPDATE_CHANNEL)?.(
          {},
          {
            projectId: "project-1",
            expectedRevision: 0,
            name: "Checkout Platform",
            goal: "Ship a resilient checkout platform",
            sharedContext: "Preserve the payment-provider contract.",
            repositoryReferences: ["/work/checkout-web"],
          },
        )) as { revision: number }
      ).revision,
      1,
    );
    assert.deepEqual(
      await handlers.get(PROJECT_UPDATE_CHANNEL)?.(
        {},
        {
          projectId: "project-1",
          expectedRevision: 0,
          name: "Conflict",
          goal: "Ship it",
          sharedContext: "",
          repositoryReferences: [],
        },
      ),
      {
        sandcastleRuntimeResult: true,
        ok: false,
        error: {
          name: "Error",
          code: "VERSION_CONFLICT",
          message: "Project revision is stale.",
        },
      },
    );
    assert.equal(
      (
        (await handlers.get(PROJECT_ARCHIVE_CHANNEL)?.(
          {},
          { projectId: "project-1", expectedRevision: 1 },
        )) as { status: string }
      ).status,
      "archived",
    );
    assert.deepEqual(await handlers.get(DEPARTMENTS_LIST_CHANNEL)?.(), []);
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_INSPECT_CHANNEL)?.(
          {},
          "software-rnd",
        )) as { id: string }
      ).id,
      "software-rnd",
    );
    const pipeline = (await handlers.get(DEPARTMENT_PIPELINE_INSPECT_CHANNEL)?.(
      {},
      "software-rnd",
    )) as {
      draft: {
        revision: number;
        graph: {
          nodes: Array<{ id: string; type: string; name: string }>;
          edges: Array<{ from: string; to: string }>;
        };
      };
    };
    const graph = pipeline.draft.graph;
    assert.equal(pipeline.draft.revision, 0);
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_PIPELINE_VALIDATE_CHANNEL)?.(
          {},
          { departmentId: "software-rnd", graph },
        )) as { valid: boolean }
      ).valid,
      true,
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_PIPELINE_DRAFT_SAVE_CHANNEL)?.(
          {},
          { departmentId: "software-rnd", expectedRevision: 0, graph },
        )) as { draft: { revision: number } }
      ).draft.revision,
      1,
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_PIPELINE_PUBLISH_CHANNEL)?.(
          {},
          { departmentId: "software-rnd", expectedRevision: 1 },
        )) as { draft: { revision: number } }
      ).draft.revision,
      1,
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_CREATE_CHANNEL)?.(
          {},
          { name: "Design" },
        )) as {
          name: string;
        }
      ).name,
      "Design",
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_UPDATE_CHANNEL)?.(
          {},
          {
            departmentId: "software-rnd",
            expectedRevision: 0,
            name: "Product Engineering",
            description: "Builds product changes.",
            inputArtifactContracts: [],
            outputArtifactContracts: [],
            defaultExecutionProfileId: "software-rnd-default",
          },
        )) as { id: string }
      ).id,
      "software-rnd",
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_ARCHIVE_CHANNEL)?.(
          {},
          { departmentId: "software-rnd", expectedRevision: 0 },
        )) as { status: string }
      ).status,
      "archived",
    );
    assert.equal(
      (
        (await handlers.get(DEPARTMENT_COPY_CHANNEL)?.(
          {},
          {
            departmentId: "software-rnd",
            name: "Product Delivery",
          },
        )) as { id: string }
      ).id,
      "copied-department",
    );
    assert.equal(
      (
        (await handlers.get(POSITION_UPDATE_CHANNEL)?.(
          {},
          {
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 0,
            name: "Software Engineer",
            responsibility: "Ships tested slices.",
            aiMemberDisplayName: "Delivery Engineer",
            aiMemberProfile: "",
            aiMemberResponsibilityMetadata: {},
            aiMemberStatus: "inactive",
          },
        )) as { id: string }
      ).id,
      "software-rnd",
    );
    assert.equal(
      (
        (await handlers.get(SKILL_CONFIGURATION_INSPECT_CHANNEL)?.(
          {},
          "software-rnd",
        )) as { department: { id: string } }
      ).department.id,
      "software-rnd",
    );
    assert.equal(
      (
        (await handlers.get(POSITION_SKILLS_SET_CHANNEL)?.(
          {},
          {
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 0,
            skillIds: ["tdd"],
          },
        )) as { positions: readonly unknown[] }
      ).positions.length,
      1,
    );
    assert.equal(handlers.has(SKILL_CATALOG_SAVE_CHANNEL), true);
    assert.equal(handlers.has(SKILL_CATALOG_ARCHIVE_CHANNEL), true);
    assert.equal(handlers.has(SKILL_FLOW_SAVE_CHANNEL), true);
    assert.equal(handlers.has(SKILL_FLOW_ARCHIVE_CHANNEL), true);
    assert.deepEqual(
      await handlers.get(RUNS_LIST_CHANNEL)?.({}, { projectId: "project-1" }),
      [scriptedDepartmentRun],
    );
    assert.equal(
      (
        (await handlers.get(RUN_INSPECT_CHANNEL)?.({}, "run-1")) as {
          run: { id: string };
        }
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        (await handlers.get(RUN_START_CHANNEL)?.(
          {},
          { projectId: "project-1", departmentId: "department-1" },
        )) as { run: { id: string } }
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        (await handlers.get(RUN_EXECUTE_READY_CHANNEL)?.(
          {},
          { runId: "run-1", expectedRevision: 0 },
        )) as { run: { id: string } }
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        (await handlers.get(RUN_APPROVAL_DECIDE_CHANNEL)?.(
          {},
          {
            runId: "run-1",
            nodeRunId: "node-run-approval",
            expectedRevision: 1,
            decision: "approve",
          },
        )) as { run: { id: string } }
      ).run.id,
      "run-1",
    );
    assert.equal(
      (
        (await handlers.get(RUN_NODE_RETRY_CHANNEL)?.(
          {},
          {
            runId: "run-1",
            nodeRunId: "node-run-ai-task",
            expectedRevision: 2,
            feedback: "Try again.",
          },
        )) as { run: { id: string } }
      ).run.id,
      "run-1",
    );
    await assert.rejects(
      async () =>
        handlers.get(POSITION_SKILLS_SET_CHANNEL)?.(
          {},
          { departmentId: "software-rnd", skillIds: ["tdd"] },
        ),
      /invalid_type|Invalid input/i,
    );
  });
});
