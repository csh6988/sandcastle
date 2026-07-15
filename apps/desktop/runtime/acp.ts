import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CompanyRuntimeClient } from "./interface.js";

export interface AcpRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpResponse {
  readonly id: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AcpStdioFacade {
  readonly handle: (request: AcpRequest) => Promise<AcpResponse>;
}

const requiredString = (
  params: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ACP parameter ${key} is required.`);
  }
  return value;
};

export const createAcpStdioFacade = (
  client: CompanyRuntimeClient,
): AcpStdioFacade => ({
  handle: async (request) => {
    try {
      switch (request.method) {
        case "initialize": {
          const health = await client.query({ type: "runtime.health" });
          return {
            id: request.id,
            result: {
              protocolVersion: 1,
              schemaVersion: health.schemaVersion,
              capabilities: {
                sessions: true,
                permissions: true,
                updates: true,
                cancellation: false,
              },
            },
          };
        }
        case "session/new": {
          const projectId = requiredString(request.params, "projectId");
          const aiMemberId = requiredString(request.params, "aiMemberId");
          const runId =
            typeof request.params.runId === "string"
              ? request.params.runId
              : undefined;
          const nodeRunId =
            typeof request.params.nodeRunId === "string"
              ? request.params.nodeRunId
              : undefined;
          const session = await client.execute({
            type: "interaction.session.create",
            projectId,
            mode: runId ? "run-collaboration" : "consultation",
            ...(runId ? { runId } : {}),
            ...(nodeRunId ? { nodeRunId } : {}),
          });
          const participant = await client.execute({
            type: "interaction.participant.add",
            sessionId: session.id,
            participantType: "ai-member",
            participantRef: aiMemberId,
            role: "assistant",
          });
          return {
            id: request.id,
            result: {
              sessionId: session.id,
              participantId: participant.id,
              mode: session.mode,
            },
          };
        }
        case "session/prompt": {
          const message = await client.execute({
            type: "interaction.message.add",
            sessionId: requiredString(request.params, "sessionId"),
            participantId: requiredString(request.params, "participantId"),
            kind: "text",
            content: requiredString(request.params, "content"),
          });
          return { id: request.id, result: { messageId: message.id } };
        }
        case "session/update": {
          const afterSequence = Number(request.params.afterSequence ?? 0);
          const limit = Number(request.params.limit ?? 100);
          const replay = await client.query({
            type: "ag-ui.events",
            afterSequence,
            limit,
          });
          return { id: request.id, result: replay };
        }
        case "session/request_permission": {
          const permission = await client.execute({
            type: "permission.decide",
            permissionId: requiredString(request.params, "permissionId"),
            expectedStatus: "pending",
            decision:
              request.params.decision === "approved" ? "approved" : "denied",
          });
          return {
            id: request.id,
            result: {
              permissionId: permission.id,
              status: permission.status,
            },
          };
        }
        case "session/cancel": {
          const session = await client.execute({
            type: "interaction.session.close",
            sessionId: requiredString(request.params, "sessionId"),
          });
          return {
            id: request.id,
            result: { sessionId: session.id, status: session.status },
          };
        }
        default:
          return {
            id: request.id,
            error: {
              code: "ACP_METHOD_NOT_FOUND",
              message: `Unsupported ACP method ${request.method}.`,
            },
          };
      }
    } catch (error) {
      return {
        id: request.id,
        error: {
          code:
            request.method === "initialize"
              ? "COMPANY_RUNTIME_UNAVAILABLE"
              : typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  typeof error.code === "string"
                ? error.code
                : "ACP_REQUEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
});

export const serveAcpStdio = async (input: {
  readonly facade: AcpStdioFacade;
  readonly stdin: Readable;
  readonly stdout: Writable;
}): Promise<void> => {
  const lines = createInterface({ input: input.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: AcpResponse;
    try {
      const request = JSON.parse(line) as AcpRequest;
      response = await input.facade.handle(request);
    } catch (error) {
      response = {
        id: "unknown",
        error: {
          code: "ACP_PROTOCOL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    input.stdout.write(`${JSON.stringify(response)}\n`);
  }
};
