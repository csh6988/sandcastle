import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAcpStdioFacade } from "./acp.js";
import type { CompanyRuntimeClient } from "./interface.js";

describe("ACP stdio facade", () => {
  it("maps initialize, session/new, prompt, permission, and update to Runtime", async () => {
    const calls: string[] = [];
    const client = {
      query: async (query: { type: string }) => {
        calls.push(`query:${query.type}`);
        if (query.type === "runtime.health") {
          return {
            status: "ok" as const,
            schemaVersion: 20,
            pid: 1,
            startedAt: "2026-07-15T00:00:00.000Z",
          };
        }
        if (query.type === "ag-ui.events") {
          return { events: [], nextSequence: 0 };
        }
        return {
          session: {
            id: "session-1",
            mode: "consultation" as const,
            projectId: "project-1",
            runId: null,
            nodeRunId: null,
            status: "active" as const,
            createdAt: "2026-07-15T00:00:00.000Z",
            closedAt: null,
          },
          participants: [],
          messages: [],
          permissions: [],
        };
      },
      execute: async (command: { type: string }) => {
        calls.push(`command:${command.type}`);
        if (command.type === "interaction.session.create") {
          return {
            id: "session-1",
            mode: "consultation" as const,
            projectId: "project-1",
            runId: null,
            nodeRunId: null,
            status: "active" as const,
            createdAt: "2026-07-15T00:00:00.000Z",
            closedAt: null,
          };
        }
        if (command.type === "interaction.participant.add") {
          return {
            id: "participant-1",
            sessionId: "session-1",
            participantType: "ai-member" as const,
            participantRef: "member-1",
            role: "assistant",
            createdAt: "2026-07-15T00:00:00.000Z",
          };
        }
        if (command.type === "interaction.prompt") {
          return {
            id: "message-1",
            sessionId: "session-1",
            participantId: "participant-1",
            kind: "text" as const,
            content: "Hello",
            createdAt: "2026-07-15T00:00:00.000Z",
          };
        }
        if (command.type === "interaction.session.close") {
          return {
            id: "session-1",
            mode: "consultation" as const,
            projectId: "project-1",
            runId: null,
            nodeRunId: null,
            status: "closed" as const,
            createdAt: "2026-07-15T00:00:00.000Z",
            closedAt: "2026-07-15T00:01:00.000Z",
          };
        }
        return {
          id: "permission-1",
          sessionId: "session-1",
          runId: null,
          nodeRunId: null,
          scope: "repository.write",
          status: "approved" as const,
          expiresAt: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          decidedAt: "2026-07-15T00:00:00.000Z",
        };
      },
    } as unknown as CompanyRuntimeClient;
    const facade = createAcpStdioFacade(client);

    const initialized = await facade.handle({
      id: "1",
      method: "initialize",
      params: {},
    });
    assert.ok(initialized.result);
    assert.equal(initialized.result.schemaVersion, 20);
    const opened = await facade.handle({
      id: "2",
      method: "session/new",
      params: { projectId: "project-1", aiMemberId: "member-1" },
    });
    assert.ok(opened.result);
    assert.equal(opened.result.sessionId, "session-1");
    const prompted = await facade.handle({
      id: "3",
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        participantId: "participant-1",
        content: "Hello",
      },
    });
    assert.equal(prompted.result?.messageId, "message-1");
    await facade.handle({
      id: "4",
      method: "session/request_permission",
      params: { permissionId: "permission-1", decision: "approved" },
    });
    await facade.handle({
      id: "5",
      method: "session/update",
      params: { afterSequence: 0, limit: 10 },
    });
    const cancelled = await facade.handle({
      id: "6",
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    assert.equal(cancelled.result?.status, "closed");
    assert.deepEqual(calls, [
      "query:runtime.health",
      "command:interaction.session.create",
      "command:interaction.participant.add",
      "command:interaction.prompt",
      "command:permission.decide",
      "query:ag-ui.events",
      "command:interaction.session.close",
    ]);
  });

  it("returns explicit Runtime unavailable errors instead of creating a second writer", async () => {
    const facade = createAcpStdioFacade({
      query: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      execute: async () => {
        throw new Error("not reached");
      },
    } as unknown as CompanyRuntimeClient);
    const response = await facade.handle({
      id: "1",
      method: "initialize",
      params: {},
    });
    assert.equal(response.error?.code, "COMPANY_RUNTIME_UNAVAILABLE");
  });
});
