import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createAcpFacade, serveAcpStdio, type AcpMessage } from "./acp.js";
import type { CompanyRuntimeClient } from "./interface.js";
import { companyRuntimeAddress } from "./address.js";
import { createCompanyRuntimeClient } from "./client.js";
import { startCompanyRuntimeServer } from "./server.js";

describe("local ACP facade", () => {
  it("replays an unacknowledged Permission event over a real Runtime reconnect", async () => {
    const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-acp-replay-"));
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "desktop-token",
      trustedConnections: [
        {
          token: "acp-token",
          principal: {
            type: "acp-client",
            id: "editor-1",
            authenticatedBy: "acp-connection",
          },
          consumerId: "acp:editor-1",
        },
      ],
    });
    let first: ReturnType<typeof createAcpFacade> | undefined;
    let second: ReturnType<typeof createAcpFacade> | undefined;
    try {
      const desktop = createCompanyRuntimeClient({
        address,
        token: "desktop-token",
      });
      const acpClient = createCompanyRuntimeClient({
        address,
        token: "acp-token",
      });
      const project = await desktop.execute({
        type: "project.create",
        name: "Replay",
        goal: "Prove durable ACP replay",
      });
      const firstMessages: AcpMessage[] = [];
      let failPermissionDelivery = false;
      first = createAcpFacade({
        client: acpClient,
        connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
        pollIntervalMs: 1,
        send: async (message) => {
          if (
            failPermissionDelivery &&
            "method" in message &&
            message.method === "session/request_permission"
          ) {
            throw new Error("editor disconnected");
          }
          firstMessages.push(message);
        },
      });
      await first.receive({
        jsonrpc: "2.0",
        id: "new-1",
        method: "session/new",
        params: {
          projectId: project.id,
          aiMemberId: "product-planner-member",
        },
      });
      const created = firstMessages.find(
        (message) => "id" in message && message.id === "new-1",
      );
      if (!created || !("result" in created)) {
        assert.fail("ACP Session should be created.");
      }
      const sessionId = String(
        (created.result as { readonly sessionId: string }).sessionId,
      );
      failPermissionDelivery = true;
      const permission = await desktop.execute({
        type: "permission.request",
        sessionId,
        scope: "repository.write",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await first.close();
      first = undefined;

      const replayed: AcpMessage[] = [];
      second = createAcpFacade({
        client: acpClient,
        connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
        pollIntervalMs: 1,
        send: async (message) => {
          replayed.push(message);
          if (
            "method" in message &&
            message.method === "session/request_permission" &&
            "id" in message
          ) {
            await second!.receive({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                outcome: { outcome: "selected", optionId: "approved" },
              },
            });
          }
        },
      });
      await second.receive({
        jsonrpc: "2.0",
        id: "load-2",
        method: "session/load",
        params: { sessionId },
      });
      while (
        (
          await desktop.query({ type: "interaction.inspect", sessionId })
        ).permissions.find((candidate) => candidate.id === permission.id)
          ?.status === "pending"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      assert.equal(
        replayed.some(
          (message) =>
            "method" in message &&
            message.method === "session/request_permission" &&
            message.params?.permissionRequestId === permission.id,
        ),
        true,
      );
      assert.equal(
        (
          await desktop.query({ type: "interaction.inspect", sessionId })
        ).permissions.find((candidate) => candidate.id === permission.id)
          ?.status,
        "approved",
      );
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("keeps reading stdio while a prompt request is pending so cancellation can arrive", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const received: string[] = [];
    let releasePrompt!: () => void;
    const promptCancelled = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let closed = false;
    const serving = serveAcpStdio({
      facade: {
        receive: async (message) => {
          if (!("method" in message)) return;
          received.push(message.method);
          if (message.method === "session/prompt") {
            await promptCancelled;
          } else if (message.method === "session/cancel") {
            releasePrompt();
          }
        },
        close: async () => {
          closed = true;
          releasePrompt();
        },
      },
      stdin,
      stdout,
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "session/prompt",
        params: { sessionId: "session-1", content: "Wait" },
      })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "session-1" },
      })}\n`,
    );
    stdin.end();

    await serving;

    assert.deepEqual(received, ["session/prompt", "session/cancel"]);
    assert.equal(closed, true);
  });

  it("keeps Agent-to-Client methods outbound and injects the authenticated connection identity", async () => {
    const sent: AcpMessage[] = [];
    const envelopes: unknown[] = [];
    const client = {
      query: async () => ({
        status: "ok" as const,
        schemaVersion: 39,
        pid: 1,
        startedAt: "2026-07-27T00:00:00.000Z",
      }),
      executeEnvelope: async (envelope: unknown) => {
        envelopes.push(envelope);
        return {
          status: "succeeded" as const,
          value: {
            id: "turn-1",
            sessionId: "session-1",
            inputMessageId: "message-1",
            outputMessageId: null,
            status: "queued" as const,
            commandId: "acp:editor-1:prompt:prompt-1",
            executionOperationKey: "interaction-turn:turn-1",
            executionLeaseId: null,
            executionEpoch: null,
            fenceToken: null,
            mechanism: "model-only" as const,
            mechanismVersion: "1",
            contextHash: "a".repeat(64),
            contextSchemaHash: "b".repeat(64),
            terminalExecutionFactId: null,
            providerExecutionRef: null,
            failureCode: null,
            failureMessage: null,
            createdAt: "2026-07-27T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          effectIds: [],
        };
      },
      openSubscription: async () => ({
        subscriptionId: "subscription-1",
        subscriptionGeneration: 1,
        barrierSequence: 0,
      }),
      readSubscription: async () => ({
        events: [],
        nextSequence: 0,
        hasMore: false,
      }),
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      send: async (message) => {
        sent.push(message);
      },
    });

    await facade.receive({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    await facade.receive({
      jsonrpc: "2.0",
      id: "wrong-direction",
      method: "session/update",
      params: { sessionId: "session-1" },
    });
    await facade.receive({
      jsonrpc: "2.0",
      id: "impersonation",
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        participantId: "participant-1",
        content: "hello",
        actor: {
          type: "human",
          id: "forged-user",
          authenticatedBy: "local-session",
        },
      },
    });

    assert.deepEqual(sent, [
      {
        jsonrpc: "2.0",
        id: "initialize-1",
        result: {
          protocolVersion: 1,
          schemaVersion: 39,
          capabilities: {
            sessions: true,
            sessionLoad: true,
            permissions: true,
            updates: true,
            cancellation: true,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: "wrong-direction",
        error: {
          code: -32601,
          message: "ACP method session/update is Agent-to-Client only.",
        },
      },
      {
        jsonrpc: "2.0",
        id: "impersonation",
        error: {
          code: -32602,
          message:
            "ACP identity fields are supplied by the authenticated connection.",
        },
      },
    ]);
    assert.deepEqual(envelopes, []);
    await facade.close();
  });

  it("creates and reloads only sessions owned by the authenticated ACP client", async () => {
    const sent: AcpMessage[] = [];
    const commands: unknown[] = [];
    const ownedView = {
      session: {
        id: "session-1",
        mode: "consultation" as const,
        projectId: "project-1",
        runId: null,
        nodeRunId: null,
        status: "active" as const,
        createdAt: "2026-07-27T00:00:00.000Z",
        closedAt: null,
      },
      participants: [
        {
          id: "client-participant-1",
          sessionId: "session-1",
          participantType: "human" as const,
          participantRef: "editor-1",
          role: "requester",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
        {
          id: "agent-participant-1",
          sessionId: "session-1",
          participantType: "ai-member" as const,
          participantRef: "member-1",
          role: "assistant",
          createdAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      messages: [],
      turns: [],
      permissions: [],
    };
    const client = {
      query: async (query: { type: string; sessionId?: string }) => {
        if (query.type === "runtime.health") {
          return {
            status: "ok" as const,
            schemaVersion: 39,
            pid: 1,
            startedAt: "2026-07-27T00:00:00.000Z",
          };
        }
        if (query.sessionId === "session-1") return ownedView;
        return {
          ...ownedView,
          session: { ...ownedView.session, id: "session-other" },
          participants: [],
        };
      },
      execute: async (command: { type: string }) => {
        commands.push(command);
        if (command.type === "interaction.session.create") {
          return ownedView.session;
        }
        return command.type === "interaction.participant.add" &&
          commands.length === 2
          ? ownedView.participants[0]
          : ownedView.participants[1];
      },
      openSubscription: async () => ({
        subscriptionId: "subscription-1",
        subscriptionGeneration: 1,
        barrierSequence: 0,
      }),
      readSubscription: async () => ({
        events: [],
        nextSequence: 0,
        hasMore: false,
      }),
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      send: async (message) => {
        sent.push(message);
      },
    });

    await facade.receive({
      jsonrpc: "2.0",
      id: "new-1",
      method: "session/new",
      params: { projectId: "project-1", aiMemberId: "member-1" },
    });
    await facade.receive({
      jsonrpc: "2.0",
      id: "load-1",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    await facade.receive({
      jsonrpc: "2.0",
      id: "load-other",
      method: "session/load",
      params: { sessionId: "session-other" },
    });

    assert.deepEqual(commands, [
      {
        type: "interaction.session.create",
        projectId: "project-1",
        mode: "consultation",
      },
      {
        type: "interaction.participant.add",
        sessionId: "session-1",
        participantType: "human",
        participantRef: "editor-1",
        role: "requester",
      },
      {
        type: "interaction.participant.add",
        sessionId: "session-1",
        participantType: "ai-member",
        participantRef: "member-1",
        role: "assistant",
      },
    ]);
    assert.deepEqual(sent, [
      {
        jsonrpc: "2.0",
        id: "new-1",
        result: {
          sessionId: "session-1",
          mode: "consultation",
          clientParticipantId: "client-participant-1",
          aiParticipantId: "agent-participant-1",
        },
      },
      {
        jsonrpc: "2.0",
        id: "load-1",
        result: { sessionId: "session-1", mode: "consultation" },
      },
      {
        jsonrpc: "2.0",
        id: "load-other",
        error: {
          code: -32004,
          message: "ACP session was not found.",
          data: { runtimeCode: "ACP_SESSION_NOT_FOUND" },
        },
      },
    ]);
    await facade.close();
  });

  it("creates one stable Turn, streams Runtime events outbound, and acknowledges only after delivery", async () => {
    const sent: AcpMessage[] = [];
    const envelopes: unknown[] = [];
    const acknowledgements: unknown[] = [];
    let releaseEvents!: () => void;
    const eventsReady = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let delivered = false;
    const client = {
      query: async () => ({
        session: {
          id: "session-1",
          mode: "consultation" as const,
          projectId: "project-1",
          runId: null,
          nodeRunId: null,
          status: "active" as const,
          createdAt: "2026-07-27T00:00:00.000Z",
          closedAt: null,
        },
        participants: [
          {
            id: "client-participant-1",
            sessionId: "session-1",
            participantType: "human" as const,
            participantRef: "editor-1",
            role: "requester",
            createdAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        messages: [],
        turns: [],
        permissions: [],
      }),
      executeEnvelope: async (envelope: unknown) => {
        envelopes.push(envelope);
        releaseEvents();
        return {
          status: "succeeded" as const,
          value: {
            id: "turn-1",
            sessionId: "session-1",
            inputMessageId: "message-1",
            outputMessageId: null,
            status: "queued" as const,
            commandId: "acp:editor-1:prompt:prompt-1",
            executionOperationKey: "interaction-turn:turn-1",
            executionLeaseId: null,
            executionEpoch: null,
            fenceToken: null,
            mechanism: "model-only" as const,
            mechanismVersion: "1",
            contextHash: "a".repeat(64),
            contextSchemaHash: "b".repeat(64),
            terminalExecutionFactId: null,
            providerExecutionRef: null,
            failureCode: null,
            failureMessage: null,
            createdAt: "2026-07-27T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          effectIds: [],
        };
      },
      execute: async (command: unknown) => {
        acknowledgements.push(command);
        return {
          acknowledged: true,
          subscriptionGeneration: 4,
          barrierSequence: 2,
          auditId: "audit-2",
        };
      },
      openSubscription: async () => ({
        subscriptionId: "subscription-1",
        subscriptionGeneration: 4,
        barrierSequence: 0,
      }),
      readSubscription: async () => {
        await eventsReady;
        if (delivered) {
          return { events: [], nextSequence: 2, hasMore: false };
        }
        delivered = true;
        return {
          events: [
            {
              registryVersion: 8,
              schemaVersion: 1 as const,
              sequence: 1,
              eventId: "event-1",
              type: "message.delta",
              companyId: "company",
              projectId: "project-1",
              sessionId: "session-1",
              interactionTurnId: "turn-1",
              timestamp: "2026-07-27T00:00:00.000Z",
              payload: { messageId: "message-2", content: "Hello" },
            },
            {
              registryVersion: 8,
              schemaVersion: 1 as const,
              sequence: 2,
              eventId: "event-2",
              type: "interaction.turn.completed",
              companyId: "company",
              projectId: "project-1",
              sessionId: "session-1",
              interactionTurnId: "turn-1",
              timestamp: "2026-07-27T00:00:01.000Z",
              payload: {
                status: "completed",
                operationKey: "interaction-turn:turn-1",
              },
            },
          ],
          nextSequence: 2,
          hasMore: false,
        };
      },
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      send: async (message) => {
        sent.push(message);
      },
    });

    await facade.receive({
      jsonrpc: "2.0",
      id: "load-1",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    await facade.receive({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId: "session-1", content: "Hello" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(envelopes, [
      {
        schemaVersion: 1,
        commandId: "acp:editor-1:prompt:prompt-1",
        actor: {
          type: "acp-client",
          id: "editor-1",
          authenticatedBy: "acp-connection",
        },
        consumerId: "acp:editor-1",
        command: {
          type: "interaction.prompt",
          sessionId: "session-1",
          participantId: "client-participant-1",
          content: "Hello",
        },
      },
    ]);
    assert.deepEqual(acknowledgements, [
      {
        type: "ack-runtime-events",
        sequence: 2,
        subscriptionGeneration: 4,
      },
    ]);
    assert.deepEqual(sent.slice(1), [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello" },
            source: {
              eventId: "event-1",
              sequence: 1,
              registryVersion: 8,
              schemaVersion: 1,
            },
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "sandcastle_event",
            eventType: "interaction.turn.completed",
            payload: {
              status: "completed",
              operationKey: "interaction-turn:turn-1",
            },
            source: {
              eventId: "event-2",
              sequence: 2,
              registryVersion: 8,
              schemaVersion: 1,
            },
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: "prompt-1",
        result: {
          sessionId: "session-1",
          turnId: "turn-1",
          stopReason: "end_turn",
        },
      },
    ]);
    await facade.close();
  });

  it("does not advance the durable cursor when outbound delivery fails and replays on reconnect", async (t) => {
    const acknowledgements: unknown[] = [];
    const closedSubscriptions: unknown[] = [];
    const replayed: AcpMessage[] = [];
    let acknowledged = false;
    let generation = 0;
    const event = {
      registryVersion: 8,
      schemaVersion: 1 as const,
      sequence: 1,
      eventId: "event-1",
      type: "message.delta",
      companyId: "company",
      projectId: "project-1",
      sessionId: "session-1",
      interactionTurnId: "turn-1",
      timestamp: "2026-07-27T00:00:00.000Z",
      payload: { messageId: "message-1", content: "Replay me" },
    };
    const client = {
      query: async () => ({
        session: {
          id: "session-1",
          mode: "consultation" as const,
          projectId: "project-1",
          runId: null,
          nodeRunId: null,
          status: "active" as const,
          createdAt: "2026-07-27T00:00:00.000Z",
          closedAt: null,
        },
        participants: [
          {
            id: "client-participant-1",
            sessionId: "session-1",
            participantType: "human" as const,
            participantRef: "editor-1",
            role: "requester",
            createdAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        messages: [],
        turns: [],
        permissions: [],
      }),
      execute: async (command: unknown) => {
        acknowledgements.push(command);
        acknowledged = true;
        return {
          acknowledged: true,
          subscriptionGeneration: generation,
          barrierSequence: 1,
          auditId: "audit-1",
        };
      },
      openSubscription: async () => ({
        subscriptionId: `subscription-${++generation}`,
        subscriptionGeneration: generation,
        barrierSequence: acknowledged ? 1 : 0,
      }),
      readSubscription: async () => ({
        events: acknowledged ? [] : [event],
        nextSequence: acknowledged ? 1 : event.sequence,
        hasMore: false,
      }),
      closeSubscription: async (subscription: unknown) => {
        closedSubscriptions.push(subscription);
      },
    } as unknown as CompanyRuntimeClient;

    const failed = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      send: async (message) => {
        if (!("method" in message)) return;
        throw new Error("editor disconnected");
      },
    });
    t.after(() => failed.close());
    await failed.receive({
      jsonrpc: "2.0",
      id: "load-failed",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await failed.close();

    assert.deepEqual(acknowledgements, []);
    assert.equal(closedSubscriptions.length, 1);

    const reconnected = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      send: async (message) => {
        replayed.push(message);
      },
    });
    t.after(() => reconnected.close());
    await reconnected.receive({
      jsonrpc: "2.0",
      id: "load-reconnected",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(acknowledgements, [
      {
        type: "ack-runtime-events",
        sequence: 1,
        subscriptionGeneration: 2,
      },
    ]);
    assert.deepEqual(replayed.slice(1, 2), [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Replay me" },
            source: {
              eventId: "event-1",
              sequence: 1,
              registryVersion: 8,
              schemaVersion: 1,
            },
          },
        },
      },
    ]);
    await reconnected.close();
  });

  it("correlates outbound Permission requests and acknowledges only after the Runtime decision", async (t) => {
    const sent: AcpMessage[] = [];
    const envelopes: unknown[] = [];
    const acknowledgements: unknown[] = [];
    let delivered = false;
    const client = {
      query: async () => ({
        session: {
          id: "session-1",
          mode: "run-collaboration" as const,
          projectId: "project-1",
          runId: "run-1",
          nodeRunId: "node-1",
          status: "active" as const,
          createdAt: "2026-07-27T00:00:00.000Z",
          closedAt: null,
        },
        participants: [
          {
            id: "client-participant-1",
            sessionId: "session-1",
            participantType: "human" as const,
            participantRef: "editor-1",
            role: "requester",
            createdAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        messages: [],
        turns: [],
        permissions: [],
      }),
      executeEnvelope: async (envelope: unknown) => {
        envelopes.push(envelope);
        return {
          status: "succeeded" as const,
          value: {
            id: "permission-1",
            sessionId: "session-1",
            runId: "run-1",
            nodeRunId: "node-1",
            scope: "repository.write",
            status: "approved" as const,
            expiresAt: null,
            createdAt: "2026-07-27T00:00:00.000Z",
            decidedAt: "2026-07-27T00:00:01.000Z",
            decisionActor: {
              type: "acp-client" as const,
              id: "editor-1",
              authenticatedBy: "acp-connection" as const,
            },
            decisionCommandId: "acp:editor-1:permission:event-permission-1",
          },
          effectIds: ["audit-permission-1"],
        };
      },
      execute: async (command: unknown) => {
        acknowledgements.push(command);
        return {
          acknowledged: true,
          subscriptionGeneration: 5,
          barrierSequence: 1,
          auditId: "audit-ack-1",
        };
      },
      openSubscription: async () => ({
        subscriptionId: "subscription-1",
        subscriptionGeneration: 5,
        barrierSequence: 0,
      }),
      readSubscription: async () => {
        if (delivered) {
          return { events: [], nextSequence: 1, hasMore: false };
        }
        delivered = true;
        return {
          events: [
            {
              registryVersion: 8,
              schemaVersion: 1 as const,
              sequence: 1,
              eventId: "event-permission-1",
              type: "permission.requested",
              companyId: "company",
              projectId: "project-1",
              runId: "run-1",
              nodeRunId: "node-1",
              sessionId: "session-1",
              permissionRequestId: "permission-1",
              timestamp: "2026-07-27T00:00:00.000Z",
              payload: {
                permissionId: "permission-1",
                scope: "repository.write",
                status: "pending",
              },
            },
          ],
          nextSequence: 1,
          hasMore: false,
        };
      },
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      send: async (message) => {
        sent.push(message);
      },
    });
    t.after(() => facade.close());

    await facade.receive({
      jsonrpc: "2.0",
      id: "load-1",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    while (sent.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(acknowledgements, []);
    await facade.receive({
      jsonrpc: "2.0",
      id: "permission:event-permission-1",
      result: {
        outcome: { outcome: "selected", optionId: "approved" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(sent[1], {
      jsonrpc: "2.0",
      id: "permission:event-permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        permissionRequestId: "permission-1",
        scope: "repository.write",
        options: [
          { optionId: "approved", name: "Allow", kind: "allow_once" },
          { optionId: "denied", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    assert.deepEqual(envelopes, [
      {
        schemaVersion: 1,
        commandId: "acp:editor-1:permission:event-permission-1",
        actor: {
          type: "acp-client",
          id: "editor-1",
          authenticatedBy: "acp-connection",
        },
        consumerId: "acp:editor-1",
        command: {
          type: "permission.decide",
          permissionId: "permission-1",
          expectedStatus: "pending",
          decision: "approved",
        },
      },
    ]);
    assert.deepEqual(acknowledgements, [
      {
        type: "ack-runtime-events",
        sequence: 1,
        subscriptionGeneration: 5,
      },
    ]);
    await facade.close();
  });

  it("denies timed-out Permission requests through the same stable Runtime Command before Ack", async (t) => {
    const envelopes: unknown[] = [];
    const acknowledgements: unknown[] = [];
    let delivered = false;
    const client = {
      query: async () => ({
        session: {
          id: "session-1",
          mode: "run-collaboration" as const,
          projectId: "project-1",
          runId: "run-1",
          nodeRunId: "node-1",
          status: "active" as const,
          createdAt: "2026-07-27T00:00:00.000Z",
          closedAt: null,
        },
        participants: [
          {
            id: "client-participant-1",
            sessionId: "session-1",
            participantType: "human" as const,
            participantRef: "editor-1",
            role: "requester",
            createdAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        messages: [],
        turns: [],
        permissions: [],
      }),
      executeEnvelope: async (envelope: unknown) => {
        envelopes.push(envelope);
        return {
          status: "succeeded" as const,
          value: {
            id: "permission-timeout",
            sessionId: "session-1",
            runId: "run-1",
            nodeRunId: "node-1",
            scope: "repository.write",
            status: "denied" as const,
            expiresAt: null,
            createdAt: "2026-07-27T00:00:00.000Z",
            decidedAt: "2026-07-27T00:00:01.000Z",
            decisionActor: null,
            decisionCommandId:
              "acp:editor-1:permission:event-permission-timeout",
          },
          effectIds: [],
        };
      },
      execute: async (command: unknown) => {
        acknowledgements.push(command);
        return {
          acknowledged: true,
          subscriptionGeneration: 6,
          barrierSequence: 1,
          auditId: "audit-ack-timeout",
        };
      },
      openSubscription: async () => ({
        subscriptionId: "subscription-timeout",
        subscriptionGeneration: 6,
        barrierSequence: 0,
      }),
      readSubscription: async () => {
        if (delivered) {
          return { events: [], nextSequence: 1, hasMore: false };
        }
        delivered = true;
        return {
          events: [
            {
              registryVersion: 8,
              schemaVersion: 1 as const,
              sequence: 1,
              eventId: "event-permission-timeout",
              type: "permission.requested",
              companyId: "company",
              projectId: "project-1",
              runId: "run-1",
              nodeRunId: "node-1",
              sessionId: "session-1",
              permissionRequestId: "permission-timeout",
              timestamp: "2026-07-27T00:00:00.000Z",
              payload: {
                permissionId: "permission-timeout",
                scope: "repository.write",
                status: "pending",
              },
            },
          ],
          nextSequence: 1,
          hasMore: false,
        };
      },
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      permissionTimeoutMs: 2,
      send: async () => undefined,
    });
    t.after(() => facade.close());

    await facade.receive({
      jsonrpc: "2.0",
      id: "load-timeout",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    while (acknowledgements.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.equal(
      (
        envelopes[0] as {
          readonly command: { readonly decision: string };
        }
      ).command.decision,
      "denied",
    );
    assert.deepEqual(acknowledgements, [
      {
        type: "ack-runtime-events",
        sequence: 1,
        subscriptionGeneration: 6,
      },
    ]);
  });

  it("cancels the stable active Turn without closing its Session", async (t) => {
    const sent: AcpMessage[] = [];
    const envelopes: unknown[] = [];
    let cancelled = false;
    let delivered = false;
    const client = {
      query: async () => ({
        session: {
          id: "session-1",
          mode: "consultation" as const,
          projectId: "project-1",
          runId: null,
          nodeRunId: null,
          status: "active" as const,
          createdAt: "2026-07-27T00:00:00.000Z",
          closedAt: null,
        },
        participants: [
          {
            id: "client-participant-1",
            sessionId: "session-1",
            participantType: "human" as const,
            participantRef: "editor-1",
            role: "requester",
            createdAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        messages: [],
        turns: [],
        permissions: [],
      }),
      executeEnvelope: async (envelope: {
        readonly command: { readonly type: string };
      }) => {
        envelopes.push(envelope);
        if (envelope.command.type === "interaction.turn.cancel") {
          cancelled = true;
        }
        return {
          status: "succeeded" as const,
          value: {
            id: "turn-1",
            sessionId: "session-1",
            inputMessageId: "message-1",
            outputMessageId: null,
            status:
              envelope.command.type === "interaction.turn.cancel"
                ? ("running" as const)
                : ("queued" as const),
            commandId: "acp:editor-1:prompt:prompt-1",
            executionOperationKey: "interaction-turn:turn-1",
            executionLeaseId: null,
            executionEpoch: null,
            fenceToken: null,
            mechanism: "model-only" as const,
            mechanismVersion: "1",
            contextHash: "a".repeat(64),
            contextSchemaHash: "b".repeat(64),
            terminalExecutionFactId: null,
            providerExecutionRef: null,
            failureCode: null,
            failureMessage: null,
            createdAt: "2026-07-27T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          effectIds: [],
        };
      },
      execute: async () => ({
        acknowledged: true,
        subscriptionGeneration: 3,
        barrierSequence: 1,
        auditId: "audit-1",
      }),
      openSubscription: async () => ({
        subscriptionId: "subscription-1",
        subscriptionGeneration: 3,
        barrierSequence: 0,
      }),
      readSubscription: async () => {
        while (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (delivered) {
          return { events: [], nextSequence: 1, hasMore: false };
        }
        delivered = true;
        return {
          events: [
            {
              registryVersion: 8,
              schemaVersion: 1 as const,
              sequence: 1,
              eventId: "event-cancelled-1",
              type: "interaction.turn.cancelled",
              companyId: "company",
              projectId: "project-1",
              sessionId: "session-1",
              interactionTurnId: "turn-1",
              timestamp: "2026-07-27T00:00:01.000Z",
              payload: {
                status: "cancelled",
                operationKey: "interaction-turn:turn-1",
              },
            },
          ],
          nextSequence: 1,
          hasMore: false,
        };
      },
      closeSubscription: async () => undefined,
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpFacade({
      client,
      connection: { clientId: "editor-1", consumerId: "acp:editor-1" },
      pollIntervalMs: 1,
      send: async (message) => {
        sent.push(message);
      },
    });
    t.after(() => facade.close());

    await facade.receive({
      jsonrpc: "2.0",
      id: "load-1",
      method: "session/load",
      params: { sessionId: "session-1" },
    });
    const prompting = facade.receive({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId: "session-1", content: "Wait" },
    });
    while (envelopes.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await facade.receive({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    await prompting;

    assert.deepEqual(
      envelopes.map(
        (envelope) => (envelope as { readonly command: unknown }).command,
      ),
      [
        {
          type: "interaction.prompt",
          sessionId: "session-1",
          participantId: "client-participant-1",
          content: "Wait",
        },
        {
          type: "interaction.turn.cancel",
          sessionId: "session-1",
          turnId: "turn-1",
        },
      ],
    );
    assert.equal(
      envelopes.some(
        (envelope) =>
          (envelope as { readonly command: { readonly type: string } }).command
            .type === "interaction.session.close",
      ),
      false,
    );
    assert.deepEqual(sent.at(-1), {
      jsonrpc: "2.0",
      id: "prompt-1",
      result: {
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "cancelled",
      },
    });
  });
});
