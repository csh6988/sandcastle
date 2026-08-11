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
  POSITION_CONFIGURE_CHANNEL,
  AGENT_CATALOG_INSPECT_CHANNEL,
  AGENT_CATALOG_DISCOVER_CHANNEL,
  AGENT_TEST_CHANNEL,
  SKILL_DISCOVERY_INSPECT_CHANNEL,
  SKILL_DISCOVERY_REFRESH_CHANNEL,
  SKILL_DISCOVERY_ENABLE_CHANNEL,
  SKILL_DISCOVERY_ARCHIVE_CHANNEL,
  RUNTIME_TUNNEL_CHANNEL,
  RUNTIME_EVENT_PORT_CHANNEL,
  REPOSITORY_DIRECTORY_PICK_CHANNEL,
} from "../preload/bridge.js";
import { registerRuntimeIpc } from "./runtimeIpc.js";
import { scriptedSoftwareRndDepartment } from "../runtime/testing/departmentInspectContract.js";
import { scriptedSkillConfiguration } from "../runtime/testing/skillConfigurationContract.js";
import { scriptedDepartmentRun } from "../runtime/testing/runContract.js";

describe("Runtime Electron IPC", () => {
  it("guards the Desktop repository picker with the current window and origin boundary", async () => {
    const handlers = new Map<
      string,
      ((...args: readonly unknown[]) => Promise<unknown> | unknown) | undefined
    >();
    const mainFrame = { url: "http://127.0.0.1:4399/" };
    const webContents = { id: 7, mainFrame, postMessage: () => undefined };
    const window = { webContents };
    let pickerCalls = 0;
    registerRuntimeIpc(
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      () => ({}) as never,
      {
        getWindow: () => window,
        allowedOrigins: ["http://127.0.0.1:4399"],
        pickRepositoryDirectory: async () => {
          pickerCalls += 1;
          return { status: "selected", path: "/work/checkout" };
        },
      },
    );

    const handler = handlers.get(REPOSITORY_DIRECTORY_PICK_CHANNEL)!;
    assert.deepEqual(
      await handler({ sender: webContents, senderFrame: mainFrame }),
      { status: "selected", path: "/work/checkout" },
    );
    assert.equal(pickerCalls, 1);

    await assert.rejects(async () => {
      await handler({ sender: {}, senderFrame: mainFrame });
    }, /registered BrowserWindow/i);
    mainFrame.url = "https://untrusted.example/";
    await assert.rejects(async () => {
      await handler({ sender: webContents, senderFrame: mainFrame });
    }, /origin is not allowlisted/i);
    assert.equal(pickerCalls, 1);
  });

  it("validates the typed tunnel sender and injects trusted context", async () => {
    const handlers = new Map<
      string,
      ((...args: readonly unknown[]) => Promise<unknown> | unknown) | undefined
    >();
    const mainFrame = { url: "http://127.0.0.1:4399/" };
    const webContents = { id: 7, mainFrame, postMessage: () => undefined };
    const window = { webContents };
    const queryEnvelopeCalls: unknown[] = [];
    const executeEnvelopeCalls: unknown[] = [];
    registerRuntimeIpc(
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      () =>
        ({
          queryEnvelope: async (envelope: unknown) => {
            queryEnvelopeCalls.push(envelope);
            return {
              view: {
                id: "project-1",
                name: "Checkout",
                goal: "Ship it",
                status: "active",
                revision: 0,
                sharedContext: "",
                repositoryReferences: [],
                departmentRuns: [],
                createdAt: "2026-07-14T00:00:00.000Z",
              },
              asOfSequence: 0,
              viewSyncToken: "token-1",
            };
          },
          executeEnvelope: async (envelope: unknown) => {
            executeEnvelopeCalls.push(envelope);
            return {
              status: "succeeded",
              value: {
                id: "project-1",
                name: "Checkout",
                goal: "Ship it",
                status: "active",
                revision: 1,
                sharedContext: "updated",
                repositoryReferences: [],
                departmentRuns: [],
                createdAt: "2026-07-14T00:00:00.000Z",
              },
              effectIds: ["effect-1"],
            };
          },
        }) as never,
      {
        getWindow: () => window,
        allowedOrigins: ["http://127.0.0.1:4399"],
        maxPayloadBytes: 1_024,
      },
    );
    const handler = handlers.get(RUNTIME_TUNNEL_CHANNEL)!;
    const result = await handler(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "query",
        requestId: "request-1",
        query: { type: "project.inspect", projectId: "project-1" },
      },
    );
    assert.equal((result as { asOfSequence: number }).asOfSequence, 0);
    const queryEnvelope = queryEnvelopeCalls[0] as {
      principal: { type: string; id: string };
      consumerId: string;
    };
    assert.deepEqual(queryEnvelope.principal, {
      type: "electron-main",
      id: "desktop-main",
      authenticatedBy: "ipc-token",
    });
    assert.equal(queryEnvelope.consumerId, "desktop-window-1");

    await handler(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "execute",
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
      },
    );
    const commandEnvelope = executeEnvelopeCalls[0] as {
      actor: { type: string; id: string };
      consumerId: string;
      command: { type: string };
    };
    assert.equal(commandEnvelope.command.type, "project.update");
    assert.equal(commandEnvelope.consumerId, "desktop-window-1");
    await handler(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "query",
        requestId: "review-query-1",
        query: { type: "review.topics.list", projectId: "project-1" },
      },
    );
    await handler(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "execute",
        commandId: "review-command-1",
        expectedRevision: 7,
        command: {
          type: "review.recheck.submit",
          topicId: "topic-1",
          recheckId: "recheck-1",
          revisionId: "revision-1",
          reviewerParticipantId: "reviewer-1",
          reviewerSessionId: "fresh-session-1",
          result: "PASS",
          conditions: [],
          evidenceRefs: ["evidence-1"],
        },
      },
    );
    assert.equal(
      (queryEnvelopeCalls[1] as { query: { type: string } }).query.type,
      "review.topics.list",
    );
    assert.equal(
      (executeEnvelopeCalls[1] as { command: { type: string } }).command.type,
      "review.recheck.submit",
    );
    await assert.rejects(
      async () =>
        handler(
          { sender: { id: 99 }, senderFrame: mainFrame },
          {
            schemaVersion: 1,
            operation: "query",
            requestId: "request-2",
            query: { type: "project.inspect", projectId: "project-1" },
          },
        ),
      /sender|window/i,
    );
    mainFrame.url = "https://evil.test/";
    await assert.rejects(
      async () =>
        handler(
          { sender: webContents, senderFrame: mainFrame },
          {
            schemaVersion: 1,
            operation: "query",
            requestId: "request-3",
            query: { type: "project.inspect", projectId: "project-1" },
          },
        ),
      /origin/i,
    );
    mainFrame.url = "http://127.0.0.1:4399/";
    await assert.rejects(
      async () =>
        handler(
          { sender: webContents, senderFrame: mainFrame },
          {
            schemaVersion: 1,
            operation: "query",
            requestId: "request-4",
            query: { type: "project.inspect", projectId: "project-1" },
            extra: "x",
          },
        ),
      /schema|unrecognized|invalid/i,
    );
    await assert.rejects(
      async () =>
        handler(
          { sender: webContents, senderFrame: mainFrame },
          {
            schemaVersion: 1,
            operation: "execute",
            commandId: "command-oversized",
            expectedRevision: 0,
            command: {
              type: "project.update",
              projectId: "project-1",
              name: "Checkout",
              goal: "Ship it",
              sharedContext: "x".repeat(2_000),
              repositoryReferences: [],
            },
          },
        ),
      /size limit/i,
    );
  });

  it("fences stale event stream closes after a new window generation opens", async () => {
    const handlers = new Map<
      string,
      ((...args: readonly unknown[]) => Promise<unknown> | unknown) | undefined
    >();
    const mainFrame = { url: "http://127.0.0.1:4399/" };
    const webContents = {
      id: 7,
      mainFrame,
      postMessage: () => undefined,
    };
    const window = { webContents };
    const closed: unknown[] = [];
    let generation = 0;
    registerRuntimeIpc(
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      () =>
        ({
          openSubscription: async () => ({
            subscriptionId: `subscription-${++generation}`,
            subscriptionGeneration: generation,
            barrierSequence: 0,
          }),
          closeSubscription: async (input: unknown) => {
            closed.push(input);
          },
          readSubscription: async () => ({
            events: [],
            nextSequence: 0,
            hasMore: false,
          }),
        }) as never,
      {
        getWindow: () => window,
        allowedOrigins: ["http://127.0.0.1:4399"],
        createMessageChannel: () => ({
          port1: {
            onmessage: null,
            on: () => undefined,
            start: () => undefined,
            close: () => undefined,
            postMessage: () => undefined,
          },
          port2: {},
        }),
      },
    );
    const open = handlers.get(RUNTIME_TUNNEL_CHANNEL)!;
    const first = (await open(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "open-event-stream",
        streamRequestId: "s1",
      },
    )) as { subscriptionId: string; subscriptionGeneration: number };
    const second = (await open(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "open-event-stream",
        streamRequestId: "s2",
      },
    )) as { subscriptionId: string; subscriptionGeneration: number };
    const close = handlers.get(RUNTIME_TUNNEL_CHANNEL)!;
    const stale = await close(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "close-event-stream",
        subscriptionId: first.subscriptionId,
        subscriptionGeneration: first.subscriptionGeneration,
      },
    );
    assert.deepEqual(stale, { closed: false, stale: true });
    assert.equal(second.subscriptionGeneration, 2);
    assert.equal(closed.length, 0);
  });

  it("relays generation-tagged frames only when preload grants bounded credit", async () => {
    const handlers = new Map<
      string,
      ((...args: readonly unknown[]) => Promise<unknown> | unknown) | undefined
    >();
    const mainFrame = { url: "http://127.0.0.1:4399/" };
    const transferred: Array<{ channel: string; message: unknown }> = [];
    const webContents = {
      id: 7,
      mainFrame,
      postMessage: (channel: string, message: unknown) => {
        transferred.push({ channel, message });
      },
    };
    let onMessage: ((event: { readonly data: unknown }) => void) | undefined;
    const sent: unknown[] = [];
    const port = {
      onmessage: null,
      on: (
        _event: "message",
        listener: (event: { readonly data: unknown }) => void,
      ) => {
        onMessage = listener;
      },
      start: () => undefined,
      close: () => undefined,
      postMessage: (value: unknown) => {
        sent.push(value);
      },
    };
    let reads = 0;
    registerRuntimeIpc(
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      () =>
        ({
          openSubscription: async () => ({
            subscriptionId: "subscription-1",
            subscriptionGeneration: 4,
            barrierSequence: 8,
          }),
          readSubscription: async () => {
            reads += 1;
            return {
              events:
                reads === 1
                  ? [
                      {
                        registryVersion: 1,
                        schemaVersion: 1,
                        sequence: 9,
                        eventId: "event-9",
                        type: "project.updated",
                        companyId: "company-1",
                        projectId: "project-1",
                        timestamp: "2026-07-14T00:00:00.000Z",
                        payload: {},
                      },
                    ]
                  : [],
              nextSequence: reads === 1 ? 10 : 9,
              hasMore: false,
            };
          },
        }) as never,
      {
        getWindow: () => ({ webContents }),
        allowedOrigins: ["http://127.0.0.1:4399"],
        maxCredits: 1,
        createMessageChannel: () => ({ port1: port, port2: {} }),
      },
    );
    const tunnel = handlers.get(RUNTIME_TUNNEL_CHANNEL)!;
    const handle = (await tunnel(
      { sender: webContents, senderFrame: mainFrame },
      {
        schemaVersion: 1,
        operation: "open-event-stream",
        streamRequestId: "stream-1",
      },
    )) as { subscriptionId: string; subscriptionGeneration: number };
    assert.equal(transferred[0]?.channel, RUNTIME_EVENT_PORT_CHANNEL);
    onMessage?.({
      data: {
        schemaVersion: 1,
        type: "credit",
        subscriptionId: handle.subscriptionId,
        subscriptionGeneration: handle.subscriptionGeneration,
        credits: 1,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (sent[0] as { value: { control: { type: string } } }).value.control.type,
      "cursor.accepted",
    );
    assert.equal(reads, 0);
    onMessage?.({
      data: {
        schemaVersion: 1,
        type: "credit",
        subscriptionId: handle.subscriptionId,
        subscriptionGeneration: handle.subscriptionGeneration,
        credits: 1,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (sent[1] as { value: { event: { sequence: number } } }).value.event
        .sequence,
      9,
    );
    assert.equal(reads, 1);
  });
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
        inspectAgentCatalog: async () => ({ agents: [] }),
        discoverAgents: async () => ({ agents: [] }),
        testAgent: async (agentId) => ({
          agentId,
          status: "passed" as const,
          testedAt: "2026-07-13T00:00:00.000Z",
          summary: "ok",
        }),
        inspectSkillCatalog: async () => ({ directories: [], skills: [] }),
        discoverSkills: async () => ({ directories: [], skills: [] }),
        enableSkill: async () => ({ directories: [], skills: [] }),
        archiveDiscoveredSkill: async () => ({
          directories: [],
          skills: [],
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
        configurePosition: async () => ({
          department: scriptedSoftwareRndDepartment,
          skills: scriptedSkillConfiguration,
        }),
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
        retryApproval: async () => scriptedDepartmentRun,
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
        promptInteraction: async () => {
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
    assert.equal(handlers.has(AGENT_CATALOG_INSPECT_CHANNEL), true);
    assert.equal(handlers.has(AGENT_CATALOG_DISCOVER_CHANNEL), true);
    assert.equal(handlers.has(AGENT_TEST_CHANNEL), true);
    assert.equal(handlers.has(SKILL_DISCOVERY_INSPECT_CHANNEL), true);
    assert.equal(handlers.has(SKILL_DISCOVERY_REFRESH_CHANNEL), true);
    assert.equal(handlers.has(SKILL_DISCOVERY_ENABLE_CHANNEL), true);
    assert.equal(handlers.has(SKILL_DISCOVERY_ARCHIVE_CHANNEL), true);
    assert.equal(handlers.has(POSITION_CONFIGURE_CHANNEL), true);
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
