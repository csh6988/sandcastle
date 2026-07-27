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
import { scriptedDepartmentRun } from "./testing/runContract.js";

describe("Company Runtime client", () => {
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
