import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  CompanyRuntimeClient,
  EventEnvelope,
  RuntimeSubscriptionHandle,
} from "./interface.js";
import {
  assertRuntimeEventRegistryVersionSupported,
  createRuntimeEventRegistry,
} from "./events/registry.js";

export type AcpRequestId = string | number;

export type AcpMessage =
  | {
      readonly jsonrpc: "2.0";
      readonly id: AcpRequestId;
      readonly method: string;
      readonly params?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly method: string;
      readonly params?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: AcpRequestId;
      readonly result?: unknown;
      readonly error?: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

export interface AcpFacade {
  readonly receive: (message: AcpMessage) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const createAcpFacade = (input: {
  readonly client: CompanyRuntimeClient;
  readonly connection: {
    readonly clientId: string;
    readonly consumerId: string;
  };
  readonly send: (message: AcpMessage) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly permissionTimeoutMs?: number;
}): AcpFacade => {
  const sessions = new Map<string, string>();
  const sessionTurns = new Map<string, string>();
  const pendingSessionCancels = new Set<string>();
  const terminalEvents = new Map<string, EventEnvelope>();
  const terminalWaiters = new Map<
    string,
    {
      readonly requestId: AcpRequestId;
      readonly sessionId: string;
      readonly resolve: () => void;
    }
  >();
  const pendingPermissions = new Map<
    string,
    { readonly resolve: (decision: "approved" | "denied") => void }
  >();
  const registry = createRuntimeEventRegistry();
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  const permissionTimeoutMs = input.permissionTimeoutMs ?? 30_000;
  let closed = false;
  let closing: Promise<void> | undefined;
  let subscription: RuntimeSubscriptionHandle | undefined;
  let pump: Promise<void> | undefined;
  const requiredStringParam = (
    params: Readonly<Record<string, unknown>>,
    key: string,
  ): string => {
    const value = params[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`ACP parameter ${key} is required.`);
    }
    return value;
  };
  const sessionNotFound = async (id: AcpRequestId): Promise<void> =>
    input.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32004,
        message: "ACP session was not found.",
        data: { runtimeCode: "ACP_SESSION_NOT_FOUND" },
      },
    });

  const inspectSession = async (sessionId: string, requestId: AcpRequestId) => {
    if (typeof input.client.queryEnvelope !== "function") {
      return input.client.query({ type: "interaction.inspect", sessionId });
    }
    if (!pump && !subscription) {
      subscription = await input.client.openSubscription();
    }
    const snapshot = await input.client.queryEnvelope({
      schemaVersion: 1,
      requestId: `acp:${input.connection.clientId}:view:${String(requestId)}`,
      principal: {
        type: "acp-client",
        id: input.connection.clientId,
        authenticatedBy: "acp-connection",
      },
      consumerId: input.connection.consumerId,
      query: { type: "interaction.inspect", sessionId },
    });
    if (
      !pump &&
      subscription?.subscriptionGeneration === 1 &&
      subscription.barrierSequence === 0 &&
      snapshot.viewSyncToken
    ) {
      await input.client.closeSubscription(subscription);
      subscription = undefined;
      const acknowledged = await input.client.executeEnvelope({
        schemaVersion: 1,
        commandId: `acp:${input.connection.clientId}:view-ack:${String(requestId)}`,
        actor: {
          type: "acp-client",
          id: input.connection.clientId,
          authenticatedBy: "acp-connection",
        },
        consumerId: input.connection.consumerId,
        command: {
          type: "ack-runtime-events",
          sequence: snapshot.asOfSequence,
          viewSyncToken: snapshot.viewSyncToken,
        },
      });
      if (acknowledged.status === "rejected") {
        throw new Error(acknowledged.error.message);
      }
    }
    return snapshot.view;
  };

  const source = (event: EventEnvelope) => ({
    eventId: event.eventId,
    sequence: event.sequence,
    registryVersion: event.registryVersion ?? 1,
    schemaVersion: event.schemaVersion,
  });

  const stopReason = (event: EventEnvelope): string =>
    event.type === "interaction.turn.completed"
      ? "end_turn"
      : event.type === "interaction.turn.cancelled" ||
          event.type === "interaction.turn.interrupted"
        ? "cancelled"
        : "error";

  const finishPrompt = async (
    event: EventEnvelope,
    waiter: {
      readonly requestId: AcpRequestId;
      readonly sessionId: string;
      readonly resolve: () => void;
    },
  ): Promise<void> => {
    await input.send({
      jsonrpc: "2.0",
      id: waiter.requestId,
      result: {
        sessionId: waiter.sessionId,
        turnId: event.interactionTurnId,
        stopReason: stopReason(event),
      },
    });
    waiter.resolve();
  };

  const permissionDecision = (message: AcpMessage): "approved" | "denied" => {
    if (!("result" in message)) return "denied";
    const result = message.result;
    if (typeof result !== "object" || result === null) return "denied";
    const outcome = "outcome" in result ? result.outcome : undefined;
    if (typeof outcome !== "object" || outcome === null) return "denied";
    return "outcome" in outcome &&
      outcome.outcome === "selected" &&
      "optionId" in outcome &&
      outcome.optionId === "approved"
      ? "approved"
      : "denied";
  };

  const requestPermission = async (event: EventEnvelope): Promise<void> => {
    const sessionId = event.sessionId;
    const permissionRequestId = event.permissionRequestId;
    const payload = event.payload as {
      readonly scope: string;
    };
    if (!sessionId || !permissionRequestId) return;
    const requestId = `permission:${event.eventId}`;
    let resolveDecision!: (decision: "approved" | "denied") => void;
    const response = new Promise<"approved" | "denied">((resolve) => {
      resolveDecision = resolve;
    });
    pendingPermissions.set(requestId, { resolve: resolveDecision });
    const timeout = setTimeout(
      () => resolveDecision("denied"),
      permissionTimeoutMs,
    );
    try {
      await input.send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId,
          permissionRequestId,
          scope: payload.scope,
          options: [
            { optionId: "approved", name: "Allow", kind: "allow_once" },
            { optionId: "denied", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      const decision = await response;
      const result = await input.client.executeEnvelope({
        schemaVersion: 1,
        commandId: `acp:${input.connection.clientId}:permission:${event.eventId}`,
        actor: {
          type: "acp-client",
          id: input.connection.clientId,
          authenticatedBy: "acp-connection",
        },
        consumerId: input.connection.consumerId,
        command: {
          type: "permission.decide",
          permissionId: permissionRequestId,
          expectedStatus: "pending",
          decision,
        },
      });
      if (result.status === "rejected") {
        throw new Error(result.error.message);
      }
    } finally {
      clearTimeout(timeout);
      pendingPermissions.delete(requestId);
    }
  };

  const cancelTurn = async (sessionId: string, turnId: string) =>
    input.client.executeEnvelope({
      schemaVersion: 1,
      commandId: `acp:${input.connection.clientId}:cancel:${turnId}`,
      actor: {
        type: "acp-client",
        id: input.connection.clientId,
        authenticatedBy: "acp-connection",
      },
      consumerId: input.connection.consumerId,
      command: {
        type: "interaction.turn.cancel",
        sessionId,
        turnId,
      },
    });

  const applyEvent = async (event: EventEnvelope): Promise<void> => {
    // Shared registry-version choke point: enforce the same fail-closed rule as
    // the AG-UI path so a newer-than-supported event is refused on ACP too. A
    // below-floor or too-new version is permanent and must not be forwarded.
    assertRuntimeEventRegistryVersionSupported(
      event.registryVersion ?? 1,
      registry.version,
    );
    const definition = registry.validate({
      type: event.type,
      scope: event,
      payload: event.payload,
      schemaVersion: event.schemaVersion,
    });
    const sessionId = event.sessionId;
    if (
      event.type === "permission.requested" &&
      sessionId !== undefined &&
      sessions.has(sessionId)
    ) {
      await requestPermission(event);
      return;
    }
    if (
      definition.acpMapping !== "unmapped" &&
      sessionId !== undefined &&
      sessions.has(sessionId)
    ) {
      const update =
        event.type === "message.delta"
          ? {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text:
                  typeof event.payload === "object" &&
                  event.payload !== null &&
                  "content" in event.payload &&
                  typeof event.payload.content === "string"
                    ? event.payload.content
                    : "",
              },
              source: source(event),
            }
          : {
              sessionUpdate: "sandcastle_event",
              eventType: event.type,
              payload: event.payload,
              source: source(event),
            };
      await input.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      });
    }
    if (
      event.interactionTurnId &&
      [
        "interaction.turn.completed",
        "interaction.turn.failed",
        "interaction.turn.cancelled",
        "interaction.turn.interrupted",
      ].includes(event.type)
    ) {
      if (
        event.sessionId &&
        sessionTurns.get(event.sessionId) === event.interactionTurnId
      ) {
        sessionTurns.delete(event.sessionId);
      }
      const waiter = terminalWaiters.get(event.interactionTurnId);
      if (waiter) {
        await finishPrompt(event, waiter);
        terminalWaiters.delete(event.interactionTurnId);
      } else {
        terminalEvents.set(event.interactionTurnId, event);
      }
    }
  };

  const delay = async (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

  const ensurePump = (): void => {
    if (pump) return;
    pump = (async () => {
      let active: RuntimeSubscriptionHandle | undefined;
      try {
        active = subscription ?? (await input.client.openSubscription());
        subscription = active;
        while (!closed) {
          const batch = await input.client.readSubscription({
            subscriptionId: active.subscriptionId,
            subscriptionGeneration: active.subscriptionGeneration,
            limit: 100,
          });
          for (const event of batch.events) await applyEvent(event);
          if (batch.events.length > 0) {
            await input.client.execute({
              type: "ack-runtime-events",
              sequence: batch.nextSequence,
              subscriptionGeneration: active.subscriptionGeneration,
            });
          }
          if (!batch.hasMore) await delay();
        }
      } finally {
        if (subscription === active) subscription = undefined;
        if (active) {
          await input.client.closeSubscription(active).catch(() => undefined);
        }
      }
    })();
    void pump.catch(() => undefined);
  };

  return {
    receive: async (message) => {
      if (!("method" in message)) {
        if ("id" in message) {
          pendingPermissions
            .get(String(message.id))
            ?.resolve(permissionDecision(message));
        }
        return;
      }
      if (
        message.method === "session/update" ||
        message.method === "session/request_permission"
      ) {
        if ("id" in message) {
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: `ACP method ${message.method} is Agent-to-Client only.`,
            },
          });
        }
        return;
      }
      const params = message.params ?? {};
      if (
        "actor" in params ||
        "principal" in params ||
        "consumerId" in params
      ) {
        if ("id" in message) {
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32602,
              message:
                "ACP identity fields are supplied by the authenticated connection.",
            },
          });
        }
        return;
      }
      if (message.method === "initialize") {
        if (!("id" in message)) return;
        if (
          params.protocolVersion !== undefined &&
          params.protocolVersion !== 1
        ) {
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32602,
              message: "ACP protocolVersion 1 is required.",
            },
          });
          return;
        }
        try {
          const health = await input.client.query({ type: "runtime.health" });
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              schemaVersion: health.schemaVersion,
              capabilities: {
                sessions: true,
                sessionLoad: true,
                permissions: true,
                updates: true,
                cancellation: true,
              },
            },
          });
        } catch (error) {
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: error instanceof Error ? error.message : String(error),
              data: { runtimeCode: "COMPANY_RUNTIME_UNAVAILABLE" },
            },
          });
        }
        return;
      }
      if (message.method === "session/cancel") {
        const sessionId = requiredStringParam(params, "sessionId");
        const turnId =
          typeof params.turnId === "string" && params.turnId.trim()
            ? params.turnId
            : sessionTurns.get(sessionId);
        if (!sessions.has(sessionId)) {
          if ("id" in message) await sessionNotFound(message.id);
          return;
        }
        if (!turnId) {
          pendingSessionCancels.add(sessionId);
          return;
        }
        const result = await cancelTurn(sessionId, turnId);
        if ("id" in message) {
          await input.send(
            result.status === "succeeded"
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { sessionId, turnId, status: result.value.status },
                }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32000,
                    message: result.error.message,
                    data: { runtimeCode: result.error.code },
                  },
                },
          );
        }
        return;
      }
      if (!("id" in message)) return;
      if (message.method === "session/new") {
        const projectId = requiredStringParam(params, "projectId");
        const aiMemberId = requiredStringParam(params, "aiMemberId");
        const runId =
          typeof params.runId === "string" && params.runId.trim()
            ? params.runId
            : undefined;
        const nodeRunId =
          typeof params.nodeRunId === "string" && params.nodeRunId.trim()
            ? params.nodeRunId
            : undefined;
        const session = await input.client.execute({
          type: "interaction.session.create",
          projectId,
          mode: runId ? "run-collaboration" : "consultation",
          ...(runId ? { runId } : {}),
          ...(nodeRunId ? { nodeRunId } : {}),
        });
        const clientParticipant = await input.client.execute({
          type: "interaction.participant.add",
          sessionId: session.id,
          participantType: "human",
          participantRef: input.connection.clientId,
          role: "requester",
        });
        const aiParticipant = await input.client.execute({
          type: "interaction.participant.add",
          sessionId: session.id,
          participantType: "ai-member",
          participantRef: aiMemberId,
          role: "assistant",
        });
        await inspectSession(session.id, message.id);
        sessions.set(session.id, clientParticipant.id);
        await input.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: session.id,
            mode: session.mode,
            clientParticipantId: clientParticipant.id,
            aiParticipantId: aiParticipant.id,
          },
        });
        ensurePump();
        return;
      }
      if (message.method === "session/load") {
        const sessionId = requiredStringParam(params, "sessionId");
        let view;
        try {
          view = await inspectSession(sessionId, message.id);
        } catch {
          await sessionNotFound(message.id);
          return;
        }
        const clientParticipant = view.participants.find(
          (participant) =>
            participant.participantType === "human" &&
            participant.participantRef === input.connection.clientId,
        );
        if (!clientParticipant) {
          await sessionNotFound(message.id);
          return;
        }
        sessions.set(sessionId, clientParticipant.id);
        await input.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId, mode: view.session.mode },
        });
        ensurePump();
        return;
      }
      if (message.method === "session/prompt") {
        const sessionId = requiredStringParam(params, "sessionId");
        const participantId = sessions.get(sessionId);
        if (!participantId) {
          await sessionNotFound(message.id);
          return;
        }
        const content = requiredStringParam(params, "content");
        const result = await input.client.executeEnvelope({
          schemaVersion: 1,
          commandId: `acp:${input.connection.clientId}:prompt:${String(message.id)}`,
          actor: {
            type: "acp-client",
            id: input.connection.clientId,
            authenticatedBy: "acp-connection",
          },
          consumerId: input.connection.consumerId,
          command: {
            type: "interaction.prompt",
            sessionId,
            participantId,
            content,
          },
        });
        if (result.status === "rejected") {
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: result.error.message,
              data: { runtimeCode: result.error.code },
            },
          });
          return;
        }
        sessionTurns.set(sessionId, result.value.id);
        if (pendingSessionCancels.delete(sessionId)) {
          const cancellation = await cancelTurn(sessionId, result.value.id);
          if (cancellation.status === "rejected") {
            await input.send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: cancellation.error.message,
                data: { runtimeCode: cancellation.error.code },
              },
            });
            return;
          }
        }
        ensurePump();
        const terminal = terminalEvents.get(result.value.id);
        if (terminal) {
          terminalEvents.delete(result.value.id);
          await input.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              sessionId,
              turnId: result.value.id,
              stopReason: stopReason(terminal),
            },
          });
          return;
        }
        await new Promise<void>((resolve) => {
          terminalWaiters.set(result.value.id, {
            requestId: message.id,
            sessionId,
            resolve,
          });
        });
        return;
      }
      await input.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported ACP method ${message.method}.`,
        },
      });
    },
    close: async () => {
      if (!closing) {
        closing = (async () => {
          closed = true;
          pendingSessionCancels.clear();
          for (const waiter of terminalWaiters.values()) waiter.resolve();
          terminalWaiters.clear();
          for (const pending of pendingPermissions.values()) {
            pending.resolve("denied");
          }
          if (subscription) {
            await input.client
              .closeSubscription(subscription)
              .catch(() => undefined);
          }
          await pump?.catch(() => undefined);
        })();
      }
      await closing;
    },
  };
};

export const serveAcpStdio = async (input: {
  readonly facade: AcpFacade;
  readonly stdin: Readable;
  readonly stdout: Writable;
}): Promise<void> => {
  const write = (message: AcpMessage): void => {
    input.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input: input.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: AcpMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("jsonrpc" in parsed) ||
        parsed.jsonrpc !== "2.0"
      ) {
        throw new Error("ACP messages require a JSON-RPC 2.0 envelope.");
      }
      message = parsed as AcpMessage;
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: "unknown",
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }
    const task = input.facade.receive(message).catch((error) => {
      if ("id" in message) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }
  await input.facade.close();
  await Promise.allSettled(inFlight);
};
