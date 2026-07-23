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
import { RuntimeRequestSchema, type RuntimeResponse } from "./interface.js";

describe("Company Runtime client", () => {
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
