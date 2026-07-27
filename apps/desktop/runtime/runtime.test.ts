import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { companyRuntimeAddress } from "./address.js";
import { createCompanyRuntimeClient, RuntimeClientError } from "./client.js";
import { startCompanyRuntimeServer } from "./server.js";
import { openCompanyDatabase } from "./storage/sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "./storage/migrations.js";
import { createModelOnlyInteractionExecutionAdapter } from "./adapters/interactionExecutionAdapter.js";
import { assertSoftwareRndDepartmentContract } from "./testing/departmentInspectContract.js";
import type {
  CompanyRuntimeClient,
  DepartmentPipelineDraftGraph,
} from "./interface.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-runtime-"));

const startConfirmedRun = async (
  client: CompanyRuntimeClient,
  projectId: string,
  departmentId: string,
) => {
  const session = await client.execute({
    type: "interaction.session.create",
    projectId,
    mode: "consultation",
  });
  await client.execute({
    type: "interaction.participant.add",
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: "product-planner-member",
    role: "product-manager",
  });
  const revised = await client.execute({
    type: "product.proposal.revise",
    projectId,
    producerSessionId: session.id,
    expectedRevision: 0,
    content: {
      goal: "Execute the confirmed Project goal",
      users: ["Project stakeholders"],
      scope: ["The selected Department Pipeline"],
      nonGoals: [],
      acceptanceCriteria: ["The formal Run follows its immutable Snapshot"],
      constraints: ["Use the authoritative Company Runtime"],
      risks: ["Execution failure"],
      openQuestions: [],
    },
  });
  const proposal = revised.proposal!;
  const awaiting = await client.execute({
    type: "product.proposal.mark-awaiting-confirmation",
    projectId,
    expectedRevision: proposal.revision,
    proposalRevisionId: proposal.currentRevision.id,
    proposalHash: proposal.currentRevision.hash,
  });
  const exact = awaiting.proposal!;
  await client.execute({
    type: "confirm-product-baseline",
    projectId,
    departmentId,
    expectedRevision: exact.revision,
    proposalRevisionId: exact.currentRevision.id,
    proposalHash: exact.currentRevision.hash,
  });
  return client.execute({ type: "run.start", projectId, departmentId });
};

describe("Company Runtime", () => {
  it("revises a Product Proposal and marks it awaiting confirmation through verified Runtime envelopes", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const humanPrincipal = {
      type: "human" as const,
      id: "local-user",
      authenticatedBy: "local-session" as const,
    };
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      principal: humanPrincipal,
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Product discovery",
        goal: "Confirm an exact product boundary",
      });
      const session = await client.execute({
        type: "interaction.session.create",
        projectId: project.id,
        mode: "consultation",
      });
      await client.execute({
        type: "interaction.participant.add",
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "product-manager",
      });

      const revised = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "runtime-product-revise-1",
        actor: humanPrincipal,
        consumerId: "desktop-window-1",
        expectedRevision: 0,
        command: {
          type: "product.proposal.revise",
          projectId: project.id,
          producerSessionId: session.id,
          content: {
            goal: "Confirm an exact product boundary",
            users: ["Product owner"],
            scope: ["Product Proposal confirmation"],
            nonGoals: ["Agent execution"],
            acceptanceCriteria: ["Confirmation creates one formal Run"],
            constraints: ["Keep Runtime authoritative"],
            risks: ["Partial transaction writes"],
            openQuestions: [],
          },
        },
      });
      assert.equal(revised.status, "succeeded");
      if (revised.status !== "succeeded") return;

      const awaiting = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "runtime-product-awaiting-1",
        actor: humanPrincipal,
        consumerId: "desktop-window-1",
        expectedRevision: revised.value.proposal!.revision,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: project.id,
          proposalRevisionId: revised.value.proposal!.currentRevision.id,
          proposalHash: revised.value.proposal!.currentRevision.hash,
        },
      });
      assert.equal(awaiting.status, "succeeded");
      if (awaiting.status !== "succeeded") return;

      const inspected = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "runtime-product-inspect-1",
        principal: humanPrincipal,
        consumerId: "desktop-window-1",
        query: {
          type: "product.discovery.inspect",
          projectId: project.id,
        },
      });
      assert.equal(inspected.view.proposal?.status, "awaiting-confirmation");
      assert.equal(
        inspected.view.proposal?.currentRevision.hash,
        revised.value.proposal?.currentRevision.hash,
      );

      const confirmed = await client.execute({
        type: "confirm-product-baseline",
        projectId: project.id,
        departmentId: "software-rnd",
        expectedRevision: awaiting.value.proposal!.revision,
        proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
        proposalHash: awaiting.value.proposal!.currentRevision.hash,
      });
      assert.equal(confirmed.proposal?.status, "confirmed");
      assert.equal(confirmed.baselines.length, 1);
      assert.equal(confirmed.formalRuns.length, 1);
      assert.equal(confirmed.formalRuns[0]?.status, "ready");

      const events = await client.query({
        type: "runtime.events",
        afterSequence: 0,
        limit: 100,
      });
      assert.deepEqual(
        events
          .filter((event) => event.payload !== null)
          .map((event) => event.type)
          .filter(
            (type) =>
              type.startsWith("product.") ||
              type === "department-run.formalized",
          ),
        [
          "product.proposal.revised",
          "product.proposal.awaiting-confirmation",
          "product.baseline.confirmed",
          "department-run.formalized",
        ],
      );
    } finally {
      await runtime.close();
    }
  });

  it("initializes SQLite and answers the typed runtime.health query", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });

      const health = await client.query({ type: "runtime.health" });

      assert.equal(health.status, "ok");
      assert.equal(health.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(health.pid, process.pid);
      assert.equal(
        existsSync(join(companyDir, ".sandcastle", "company.sqlite")),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("registers, finalizes, and inspects an Artifact Version through verified envelopes", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Artifact Runtime",
        goal: "Verify Artifact envelopes",
      });
      const registration = await client.execute({
        type: "artifact.version.register",
        projectId: project.id,
        artifactType: "runtime-evidence",
        artifactSchemaVersion: "1",
        logicalName: "runtime-evidence",
        content: {
          kind: "managed-file",
          encoding: "base64",
          data: Buffer.from("runtime artifact").toString("base64"),
        },
        producer: {
          projectId: project.id,
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          nodeRunId: "node-1",
          nodeAttemptId: "attempt-1",
          aiMemberId: "member-1",
        },
        inputVersionIds: [],
      });
      const version = await client.execute({
        type: "artifact.version.finalize",
        registrationId: registration.registrationId,
      });
      const inspected = await client.query({
        type: "artifact.inspect",
        versionId: version.id,
      });
      const lineage = await client.query({
        type: "artifact.lineage.inspect",
        versionId: version.id,
      });

      assert.equal(inspected.version.id, version.id);
      assert.equal(inspected.version.contentRef.startsWith("/"), false);
      assert.equal(lineage.rootVersionId, version.id);
      assert.deepEqual(lineage.edges, []);
    } finally {
      await runtime.close();
    }
  });

  it("reconciles a partially written managed-file journal when Runtime restarts", async () => {
    const companyDir = tempCompanyDir();
    let registrationId = "";
    const interrupted = openCompanyDatabase(companyDir, {
      artifactRegistry: {
        managedFileCrash: (point, currentRegistrationId) => {
          if (point !== "after-written") return;
          registrationId = currentRegistrationId;
          throw new Error("simulated Runtime crash after journal write");
        },
      },
    });
    const project = interrupted.catalog.createProject({
      name: "Runtime recovery",
      goal: "Recover a partially written Artifact",
    });
    assert.throws(
      () =>
        interrupted.artifactRegistry.register({
          projectId: project.id,
          type: "runtime-evidence",
          schemaVersion: "1",
          logicalName: "restart-evidence",
          content: {
            kind: "managed-file",
            bytes: Buffer.from("restart payload"),
          },
          producer: {
            projectId: project.id,
            runId: "run-1",
            snapshotRevisionId: "snapshot-1",
            nodeRunId: "node-1",
            nodeAttemptId: "attempt-1",
            aiMemberId: "member-1",
          },
        }),
      /simulated Runtime crash/,
    );
    interrupted.close();

    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const version = await client.execute({
        type: "artifact.version.finalize",
        registrationId,
      });
      const inspected = await client.query({
        type: "artifact.inspect",
        versionId: version.id,
      });
      assert.equal(inspected.version.integrityStatus, "verified");
      assert.equal(inspected.version.contentKind, "managed-file");
      assert.equal(inspected.version.contentRef.startsWith("/"), false);
    } finally {
      await runtime.close();
    }
  });

  it("answers a request before the client half-closes the connection", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    const socket = createConnection(address);
    let response = "";

    try {
      await once(socket, "connect");
      const ended = once(socket, "end");
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.write(
        `${JSON.stringify({
          id: "named-pipe-compatible-request",
          token: "valid-token",
          kind: "query",
          query: { type: "runtime.health" },
        })}\n`,
      );
      await Promise.race([
        ended,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Runtime did not answer a framed request.")),
            1_000,
          ),
        ),
      ]);

      const parsed = JSON.parse(response) as {
        readonly ok: boolean;
        readonly result?: { readonly status?: string };
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.result?.status, "ok");
    } finally {
      socket.destroy();
      await runtime.close();
    }
  });

  it("serves Agent discovery and testing through the authenticated Runtime contract", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      agentHost: {
        resolveExecutable: async (names) =>
          names.includes("codex") ? "/opt/codex" : null,
        run: async () => ({
          exitCode: 0,
          stdout: "codex-cli 1.2.3",
          stderr: "",
        }),
      },
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const discovered = await client.execute({
        type: "agent.catalog.discover",
      });
      assert.equal(
        discovered.agents.find((agent) => agent.id === "codex")?.version,
        "1.2.3",
      );
      const inspected = await client.query({ type: "agent.catalog.inspect" });
      assert.equal(
        inspected.agents.find((agent) => agent.id === "codex")?.status,
        "installed",
      );
      const tested = await client.execute({
        type: "agent.test",
        agentId: "codex",
      });
      assert.equal(tested.status, "passed");
    } finally {
      await runtime.close();
    }
  });

  it("serves Skill discovery and unified Position configuration through the Runtime", async () => {
    const companyDir = tempCompanyDir();
    const sourceDirectory = join(companyDir, "extra-skills");
    const skillDirectory = join(sourceDirectory, "local-review");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, "SKILL.md"),
      "---\nname: Local Review\ndescription: Reviews changes.\n---\n",
    );
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const discovered = await client.execute({
        type: "skill.discovery.refresh",
        directories: [sourceDirectory],
      });
      const localSkill = discovered.skills.find(
        (skill) => skill.name === "Local Review",
      );
      assert.ok(localSkill);
      const enabled = await client.execute({
        type: "skill.discovery.enable",
        skillId: localSkill.id,
      });
      assert.equal(
        enabled.skills.find((skill) => skill.id === localSkill.id)?.status,
        "enabled",
      );
      const department = await client.query({
        type: "department.inspect",
        departmentId: "software-rnd",
      });
      const skills = await client.query({
        type: "department.skill-configuration.inspect",
        departmentId: "software-rnd",
      });
      const engineer = department.positions.find(
        (position) => position.id === "software-engineer",
      );
      assert.ok(engineer);
      const configured = await client.execute({
        type: "position.configure",
        departmentId: "software-rnd",
        positionId: engineer.id,
        expectedRevision: engineer.revision,
        expectedSkillRevision: skills.revision,
        name: engineer.name,
        responsibility: engineer.responsibility,
        aiMemberDisplayName: engineer.aiMember.displayName,
        aiMemberProfile: engineer.aiMember.profile,
        aiMemberResponsibilityMetadata:
          engineer.aiMember.responsibilityMetadata,
        aiMemberStatus: engineer.aiMember.status,
        defaultAgentId: "claude-code",
        skillIds: [
          ...(skills.positions.find((position) => position.id === engineer.id)
            ?.skillIds ?? []),
          localSkill.id,
        ],
      });
      assert.equal(
        configured.department.positions.find(
          (position) => position.id === engineer.id,
        )?.defaultAgentId,
        "claude-code",
      );
      assert.equal(
        configured.skills.positions
          .find((position) => position.id === engineer.id)
          ?.skillIds.includes(localSkill.id),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps the Runtime alive when a client disconnects before a long command finishes", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      executionAdapter: {
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            kind: "failed",
            code: "TEST_STOP",
            message: "Stop after exercising the disconnected response.",
          };
        },
      },
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Disconnected client",
        goal: "Keep Runtime state authoritative",
      });
      const started = await startConfirmedRun(
        client,
        project.id,
        "software-rnd",
      );
      const socket = createConnection(address);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      socket.end(
        `${JSON.stringify({
          id: "disconnected-request",
          token: "valid-token",
          kind: "command",
          command: {
            type: "run.execute-ready",
            runId: started.run.id,
            expectedRevision: started.run.revision,
          },
        })}\n`,
      );
      setTimeout(() => socket.destroy(), 5);
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(
        (await client.query({ type: "runtime.health" })).status,
        "ok",
      );
    } finally {
      await runtime.close();
    }
  });

  it("creates an integrity-checked online backup through the Runtime command seam", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const created = await client.execute({
        type: "runtime.backup",
      });

      assert.equal(created.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(existsSync(created.path), true);
      assert.equal(
        created.path.startsWith(join(companyDir, ".sandcastle", "backups")),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("serves durable Runtime event replay, audit, and acknowledgement through IPC", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship checkout",
      });
      const started = await startConfirmedRun(
        client,
        project.id,
        "software-rnd",
      );

      const audit = await client.query({
        type: "runtime.audit",
        runId: started.run.id,
      });
      const events = await client.query({
        type: "runtime.events.consumer",
        consumerId: "runtime-test",
        limit: 100,
      });
      const runAudit = audit.find((record) => record.runId === started.run.id);
      const formalizedEvent = events.find(
        (event) =>
          event.runId === started.run.id &&
          event.type === "department-run.formalized",
      );
      const runEvent = events.find(
        (event) =>
          event.runId === started.run.id && event.type === "run.started",
      );
      assert.equal(runAudit?.action, "department-run.formalized");
      assert.equal(formalizedEvent?.type, "department-run.formalized");
      assert.equal(runEvent?.type, "run.started");
      assert.deepEqual(
        await client.execute({
          type: "runtime.events.ack",
          consumerId: "runtime-test",
          sequence: runEvent!.sequence,
        }),
        { acknowledged: true },
      );
      assert.deepEqual(
        await client.query({
          type: "runtime.events.consumer",
          consumerId: "runtime-test",
          limit: 100,
        }),
        [],
      );
    } finally {
      await runtime.close();
    }
  });

  it("re-delivers unacknowledged project events after restart and resumes after canonical Ack", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    let runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      let client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const subscription = await client.openSubscription();
      const project = await client.execute({
        type: "project.create",
        name: "Durable events",
        goal: "Verify restart replay",
      });
      const firstBatch = await client.readSubscription({
        ...subscription,
        limit: 100,
      });
      const created = firstBatch.events.find(
        (event) =>
          event.type === "project.created" && event.projectId === project.id,
      );
      assert.ok(created);
      await client.execute({
        type: "ack-runtime-events",
        sequence: created.sequence,
        subscriptionGeneration: subscription.subscriptionGeneration,
      });
      const updatedProject = await client.execute({
        type: "project.update",
        projectId: project.id,
        expectedRevision: 0,
        name: "Durable project events",
        goal: project.goal,
        sharedContext: "Canonical project.updated",
        repositoryReferences: [],
      });
      const updateBatch = await client.readSubscription({
        ...subscription,
        limit: 100,
      });
      const updated = updateBatch.events.find(
        (event) =>
          event.type === "project.updated" && event.projectId === project.id,
      );
      assert.ok(updated);
      assert.equal(updated.registryVersion, 1);
      assert.deepEqual(updated.payload, {
        projectId: project.id,
        entityId: project.id,
        operation: "updated",
        revision: updatedProject.revision,
      });

      await runtime.close();
      runtime = await startCompanyRuntimeServer({
        address,
        companyDir,
        token: "valid-token",
      });
      client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const replaySubscription = await client.openSubscription();
      const replay = await client.readSubscription({
        ...replaySubscription,
        limit: 100,
      });
      assert.equal(
        replay.events.some((event) => event.eventId === updated.eventId),
        true,
      );

      const acknowledged = await client.execute({
        type: "ack-runtime-events",
        sequence: updated.sequence,
        subscriptionGeneration: replaySubscription.subscriptionGeneration,
      });
      assert.equal(acknowledged.acknowledged, true);
      const afterAckSubscription = await client.openSubscription();
      const afterAck = await client.readSubscription({
        ...afterAckSubscription,
        limit: 100,
      });
      assert.equal(
        afterAck.events.some((event) => event.eventId === updated.eventId),
        false,
      );
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it("syncs a verified Query view with a one-time View token without appending an Ack event", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "View sync",
        goal: "Verify one-time token",
      });
      const query = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "view-sync-query",
        principal: {
          type: "electron-main",
          id: "desktop-main",
          authenticatedBy: "ipc-token",
        },
        consumerId: "desktop-window-1",
        query: { type: "project.inspect", projectId: project.id },
      });
      assert.ok(query.viewSyncToken);
      const before = await client.query({
        type: "runtime.diagnostics",
      });
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "view-sync-ack-1",
        actor: {
          type: "electron-main" as const,
          id: "desktop-main",
          authenticatedBy: "ipc-token" as const,
        },
        consumerId: "desktop-window-1",
        command: {
          type: "ack-runtime-events" as const,
          sequence: query.asOfSequence,
          viewSyncToken: query.viewSyncToken,
        },
      };
      const acknowledged = await client.executeEnvelope(envelope);
      assert.equal(acknowledged.status, "succeeded");
      const replay = await client.executeEnvelope(envelope);
      assert.deepEqual(replay, acknowledged);
      const reusedCommandId = await client.executeEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          sequence: query.asOfSequence + 1,
        },
      });
      assert.equal(reusedCommandId.status, "rejected");
      if (reusedCommandId.status === "rejected") {
        assert.equal(reusedCommandId.error.code, "COMMAND_ID_REUSE");
      }
      const after = await client.query({
        type: "runtime.diagnostics",
      });
      assert.equal(after.runtimeEventCount, before.runtimeEventCount);

      const reusedToken = await client.executeEnvelope({
        ...envelope,
        commandId: "view-sync-ack-2",
      });
      assert.equal(reusedToken.status, "rejected");
      if (reusedToken.status === "rejected") {
        assert.equal(reusedToken.error.code, "VIEW_SYNC_TOKEN_USED");
      }
    } finally {
      await runtime.close();
    }
  });

  it("audits Catalog mutations in the same Runtime transaction", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Audited checkout",
        goal: "Prove configuration audit",
      });
      const audit = await client.query({ type: "runtime.audit", limit: 100 });
      const events = await client.query({
        type: "runtime.events",
        afterSequence: 0,
        limit: 100,
      });

      assert.equal(
        audit.some(
          (record) =>
            record.action === "catalog.project.created" &&
            record.entityId === project.id,
        ),
        true,
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "project.created" &&
            (event.payload as { entityId?: string }).entityId === project.id,
        ),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("replays AG-UI events beyond the first retained page", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const initialized = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    await initialized.close();

    const sqlite = new DatabaseSync(
      join(companyDir, ".sandcastle", "company.sqlite"),
    );
    try {
      const insert = sqlite.prepare(
        `INSERT INTO runtime_event_outbox(
           event_id, type, registry_version, event_schema_version,
           company_id, project_id, run_id, node_run_id, scope_json,
           payload_json, created_at
         ) VALUES (?, 'message.delta', 7, 1, 'company', 'project-1',
                   NULL, NULL, ?, ?, ?)`,
      );
      sqlite.exec("BEGIN IMMEDIATE");
      for (let sequence = 1; sequence <= 1_005; sequence += 1) {
        insert.run(
          `event-${sequence}`,
          JSON.stringify({
            companyId: "company",
            projectId: "project-1",
            sessionId: "session-1",
            interactionTurnId: "turn-1",
          }),
          JSON.stringify({
            messageId: "message-1",
            content: `${sequence}`,
          }),
          "2026-07-15T00:00:00.000Z",
        );
      }
      sqlite.exec("COMMIT");
    } finally {
      sqlite.close();
    }

    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const replay = await client.query({
        type: "ag-ui.events",
        afterSequence: 1_000,
        limit: 5,
      });

      assert.deepEqual(
        replay.events.map((event) => event.sequence),
        [1_001, 1_002, 1_003, 1_004, 1_005],
      );
      assert.equal(replay.nextSequence, 1_005);
    } finally {
      await runtime.close();
    }
  });

  it("serves Interaction Session and Permission commands through the same Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = await client.execute({
        type: "interaction.session.create",
        projectId: project.id,
        mode: "consultation",
      });
      const participant = await client.execute({
        type: "interaction.participant.add",
        sessionId: session.id,
        participantType: "human",
        participantRef: "user-local",
        role: "requester",
      });
      await client.execute({
        type: "interaction.message.add",
        sessionId: session.id,
        participantId: participant.id,
        kind: "text",
        content: "Explain the risk.",
      });
      const permission = await client.execute({
        type: "permission.request",
        sessionId: session.id,
        scope: "repository.write",
      });
      await client.execute({
        type: "permission.decide",
        permissionId: permission.id,
        expectedStatus: "pending",
        decision: "approved",
      });
      const inspected = await client.query({
        type: "interaction.inspect",
        sessionId: session.id,
      });
      assert.equal(inspected.messages[0]?.content, "Explain the risk.");
      assert.equal(inspected.permissions[0]?.status, "approved");
    } finally {
      await runtime.close();
    }
  });

  it("executes an Interaction Prompt and persists the AI Member response", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const prompts: string[] = [];
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      interactionExecutionAdapter: createModelOnlyInteractionExecutionAdapter({
        complete: async (input) => {
          prompts.push(input.context.prompt);
          return {
            providerExecutionRef: "provider-turn-1",
            response: "你好，我是 Product Planner。",
          };
        },
      }),
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Interaction Project",
        goal: "Verify consultation replies",
      });
      const session = await client.execute({
        type: "interaction.session.create",
        projectId: project.id,
        mode: "consultation",
      });
      const human = await client.execute({
        type: "interaction.participant.add",
        sessionId: session.id,
        participantType: "human",
        participantRef: "local-desktop-user",
        role: "requester",
      });
      const aiMember = await client.execute({
        type: "interaction.participant.add",
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: "product-planner-member",
        role: "consulted-member",
      });

      await client.execute({
        type: "interaction.prompt",
        sessionId: session.id,
        participantId: human.id,
        content: "你好",
      });

      let inspected = await client.query({
        type: "interaction.inspect",
        sessionId: session.id,
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          inspected.messages.some(
            (message) =>
              message.participantId === aiMember.id &&
              message.content === "你好，我是 Product Planner。",
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        inspected = await client.query({
          type: "interaction.inspect",
          sessionId: session.id,
        });
      }

      assert.deepEqual(prompts, ["你好"]);
      assert.equal(inspected.messages[0]?.content, "你好");
      assert.equal(inspected.turns[0]?.status, "completed");
      assert.equal(
        inspected.messages.some(
          (message) =>
            message.participantId === aiMember.id &&
            message.content === "你好，我是 Product Planner。",
        ),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("returns the Runtime-backed Company Overview read model", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });

      const overview = await client.query({ type: "company.overview" });

      assert.equal(overview.company.name, basename(companyDir));
      assert.deepEqual(overview.metrics, {
        activeRuns: 0,
        waitingApprovalRuns: 0,
        blockedRuns: 0,
        completedRuns: 0,
        projects: 0,
        departments: 1,
        artifacts: 0,
      });
      assert.deepEqual(overview.attention, []);
    } finally {
      await runtime.close();
    }
  });

  it("serves catalog queries and commands through the authenticated Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const department = await client.execute({
        type: "department.create",
        name: "Design",
      });

      assert.deepEqual(await client.query({ type: "projects.list" }), [
        project,
      ]);
      const departments = await client.query({ type: "departments.list" });
      assert.equal(departments[0]?.id, "software-rnd");
      assert.deepEqual(departments.slice(1), [department]);
    } finally {
      await runtime.close();
    }
  });

  it("serves Project Configuration through the real Runtime contract", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const inspected = await client.query({
        type: "project.inspect",
        projectId: project.id,
      });
      const updated = await client.execute({
        type: "project.update",
        projectId: project.id,
        expectedRevision: inspected.revision,
        name: "Checkout Platform",
        goal: "Ship a resilient checkout platform",
        sharedContext: "Preserve the payment-provider contract.",
        repositoryReferences: ["/work/checkout-web", "/work/checkout-api"],
      });

      assert.equal(updated.revision, 1);
      assert.deepEqual(updated.repositoryReferences, [
        "/work/checkout-web",
        "/work/checkout-api",
      ]);
      await assert.rejects(
        () =>
          client.execute({
            type: "project.update",
            projectId: project.id,
            expectedRevision: 0,
            name: "Stale overwrite",
            goal: updated.goal,
            sharedContext: updated.sharedContext,
            repositoryReferences: [],
          }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "VERSION_CONFLICT",
      );
      const archived = await client.execute({
        type: "project.archive",
        projectId: project.id,
        expectedRevision: updated.revision,
      });
      assert.equal(archived.status, "archived");
      assert.equal(archived.revision, 2);
      assert.deepEqual(await client.query({ type: "projects.list" }), []);
      assert.deepEqual(
        (
          await client.query({
            type: "project.inspect",
            projectId: project.id,
          })
        ).repositoryReferences,
        updated.repositoryReferences,
      );
    } finally {
      await runtime.close();
    }
  });

  it("executes project.update with a transactional receipt and verified envelopes", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      principal: {
        type: "electron-main",
        id: "desktop-main",
        authenticatedBy: "ipc-token",
      },
      consumerId: "desktop-window-1",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship checkout",
      });
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "project-update-over-real-runtime",
        actor: {
          type: "human" as const,
          id: "untrusted-renderer-claim",
          authenticatedBy: "local-session" as const,
        },
        consumerId: "untrusted-renderer-consumer",
        expectedRevision: 0,
        command: {
          type: "project.update" as const,
          projectId: project.id,
          name: "Checkout Platform",
          goal: "Ship resilient checkout",
          sharedContext: "Preserve payment contracts.",
          repositoryReferences: ["/work/checkout"],
        },
      };

      const first = await client.executeEnvelope(envelope);
      const replay = await client.executeEnvelope({
        ...envelope,
        actor: {
          type: "human",
          id: "different-untrusted-claim",
          authenticatedBy: "local-session",
        },
        consumerId: "different-untrusted-consumer",
      });
      const inspected = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "inspect-updated-project",
        principal: {
          type: "human",
          id: "untrusted-renderer-claim",
          authenticatedBy: "local-session",
        },
        consumerId: "untrusted-renderer-consumer",
        query: { type: "project.inspect", projectId: project.id },
      });

      assert.deepEqual(replay, first);
      assert.equal(first.status, "succeeded");
      assert.equal(first.value.revision, 1);
      assert.equal(inspected.view.name, "Checkout Platform");
      assert.ok(inspected.asOfSequence >= 1);

      const reused = await client.executeEnvelope({
        ...envelope,
        command: { ...envelope.command, name: "Conflicting input" },
      });
      assert.equal(reused.status, "rejected");
      assert.equal(reused.error.code, "COMMAND_ID_REUSE");

      const sqlite = new DatabaseSync(
        join(companyDir, ".sandcastle", "company.sqlite"),
      );
      try {
        assert.deepEqual(
          {
            ...sqlite
              .prepare(
                `SELECT actor_type AS actorType,
                        actor_id AS actorId,
                        authenticated_by AS authenticatedBy,
                        consumer_id AS consumerId
                   FROM command_deduplication
                  WHERE command_id = ?`,
              )
              .get(envelope.commandId),
          },
          {
            actorType: "electron-main",
            actorId: "desktop-main",
            authenticatedBy: "ipc-token",
            consumerId: "desktop-window-1",
          },
        );
      } finally {
        sqlite.close();
      }
    } finally {
      await runtime.close();
    }
  });

  it("serves the typed department.inspect read model through the real Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });

      assertSoftwareRndDepartmentContract(
        await client.query({
          type: "department.inspect",
          departmentId: "software-rnd",
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("serves Department and Position configuration commands through the real Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const updated = await client.execute({
        type: "department.update",
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Product Engineering",
        description: "Builds and verifies product changes.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: "software-rnd-default",
      });
      const configured = await client.execute({
        type: "position.update",
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Software Engineer",
        responsibility: "Ships tested vertical slices.",
        aiMemberDisplayName: "Delivery Engineer",
        aiMemberProfile: "Delivers verified slices.",
        aiMemberResponsibilityMetadata: { focus: "delivery" },
        aiMemberStatus: "inactive",
      });
      const copied = await client.execute({
        type: "department.copy",
        departmentId: "software-rnd",
        name: "Product Delivery",
      });
      const archived = await client.execute({
        type: "department.archive",
        departmentId: "software-rnd",
        expectedRevision: 1,
      });

      assert.equal(updated.name, "Product Engineering");
      assert.equal(
        configured.positions.find(
          (position) => position.id === "software-engineer",
        )?.aiMember.displayName,
        "Delivery Engineer",
      );
      assert.notEqual(copied.id, "software-rnd");
      assert.equal(copied.positions.length, 6);
      assert.notEqual(copied.pipeline?.id, configured.pipeline?.id);
      assert.equal(archived.status, "archived");
      assert.deepEqual(
        (await client.query({ type: "departments.list" })).map(
          (department) => department.id,
        ),
        [copied.id],
      );
      assert.equal(
        (
          await client.query({
            type: "department.inspect",
            departmentId: "software-rnd",
          })
        ).positions.length,
        6,
      );
    } finally {
      await runtime.close();
    }
  });

  it("serves Position lifecycle, Department contracts, Execution Profiles, and Secret References through the real Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const department = await client.execute({
        type: "department.create",
        name: "Design",
      });
      const created = await client.execute({
        type: "position.create",
        departmentId: department.id,
        name: "Product Designer",
        responsibility: "Designs accessible product flows.",
        aiMemberDisplayName: "Ada",
        aiMemberProfile: "A pragmatic designer.",
        aiMemberResponsibilityMetadata: { discipline: "product-design" },
      });
      const position = created.positions[0];
      assert.ok(position);
      const updated = await client.execute({
        type: "position.update",
        departmentId: department.id,
        positionId: position.id,
        expectedRevision: 0,
        name: "Senior Product Designer",
        responsibility: "Owns accessible product flows.",
        aiMemberDisplayName: "Ada Lovelace",
        aiMemberProfile: "A senior, pragmatic designer.",
        aiMemberResponsibilityMetadata: { discipline: "product-design" },
        aiMemberStatus: "active",
      });
      assert.equal(updated.positions[0]?.revision, 1);
      await assert.rejects(
        () =>
          client.execute({
            type: "position.update",
            departmentId: department.id,
            positionId: position.id,
            expectedRevision: 0,
            name: "Stale",
            responsibility: "Must not persist.",
            aiMemberDisplayName: "Stale",
            aiMemberProfile: "",
            aiMemberResponsibilityMetadata: {},
            aiMemberStatus: "inactive",
          }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "VERSION_CONFLICT",
      );
      const withReference = await client.execute({
        type: "secret-reference.create",
        departmentId: department.id,
        name: "OpenAI",
        providerScope: "openai",
      });
      const reference = withReference.secretReferences[0];
      assert.ok(reference);
      const withProfile = await client.execute({
        type: "execution-profile.save",
        departmentId: department.id,
        expectedRevision: 0,
        name: "Design delivery",
        providerRef: "openai",
        model: "gpt-5",
        sandboxRef: "docker",
        branchStrategy: "branch",
        timeoutSeconds: 600,
        maxIterations: 6,
        maxTokens: null,
        retryMaxAttempts: 1,
        permissionPolicy: "ask",
        secretReferenceIds: [reference.id],
      });
      const profile = withProfile.executionProfiles[0];
      assert.ok(profile);
      const configured = await client.execute({
        type: "department.update",
        departmentId: department.id,
        expectedRevision: 0,
        name: "Design",
        description: "Designs product experiences.",
        inputArtifactContracts: [
          {
            id: "brief",
            name: "Design brief",
            artifactType: "text/markdown",
            schemaVersion: "1",
            required: true,
          },
        ],
        outputArtifactContracts: [
          {
            id: "design",
            name: "Product design",
            artifactType: "application/vnd.sandcastle.design+json",
            schemaVersion: "1",
            required: true,
          },
        ],
        defaultExecutionProfileId: profile.id,
      });
      assert.equal(configured.defaultExecutionProfileId, profile.id);
      assert.equal(JSON.stringify(configured).includes("secretValue"), false);
      assert.equal(JSON.stringify(configured).includes("apiKey"), false);
      assert.equal(JSON.stringify(configured).includes("token"), false);

      const archived = await client.execute({
        type: "position.archive",
        departmentId: department.id,
        positionId: position.id,
        expectedRevision: 1,
      });
      assert.equal(archived.positions[0]?.status, "archived");
      assert.equal(archived.positions[0]?.aiMember.status, "inactive");
    } finally {
      await runtime.close();
    }
  });

  it("serves Pipeline Draft validation and immutable publish through the real Runtime", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const editor = await client.query({
        type: "department.pipeline.inspect",
        departmentId: "software-rnd",
      });
      const graph = {
        ...editor.draft.graph,
        nodes: editor.draft.graph.nodes.map((node) =>
          node.id === "verification"
            ? { ...node, name: "Acceptance verification" }
            : node,
        ),
      };
      const validation = await client.query({
        type: "department.pipeline.validate",
        departmentId: "software-rnd",
        graph,
      });
      const saved = await client.execute({
        type: "department.pipeline.draft.save",
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });
      const published = await client.execute({
        type: "department.pipeline.publish",
        departmentId: "software-rnd",
        expectedRevision: saved.draft.revision,
      });

      assert.equal(validation.valid, true);
      assert.equal(saved.draft.revision, 1);
      assert.equal(saved.published?.version, 2);
      assert.equal(published.published?.version, 3);
      assert.deepEqual(
        published.history.map((version) => version.version),
        [3, 2, 1],
      );
      await assert.rejects(
        () =>
          client.execute({
            type: "department.pipeline.draft.save",
            departmentId: "software-rnd",
            expectedRevision: 0,
            graph,
          }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "VERSION_CONFLICT",
      );

      const custom = await client.execute({
        type: "department.create",
        name: "Design",
      });
      const customEditor = await client.query({
        type: "department.pipeline.inspect",
        departmentId: custom.id,
      });
      const customSaved = await client.execute({
        type: "department.pipeline.draft.save",
        departmentId: custom.id,
        expectedRevision: 0,
        graph: customEditor.draft.graph,
      });
      const customPublished = await client.execute({
        type: "department.pipeline.publish",
        departmentId: custom.id,
        expectedRevision: customSaved.draft.revision,
      });
      assert.equal(customPublished.published?.version, 1);
    } finally {
      await runtime.close();
    }
  });

  it("starts and executes a persistent Department Run through the real Runtime contract", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    let runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
      principal: {
        type: "human",
        id: "runtime-contract-human",
        authenticatedBy: "local-session",
      },
    });
    const client = createCompanyRuntimeClient({
      address,
      token: "valid-token",
    });
    try {
      const project = await client.execute({
        type: "project.create",
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const department = await client.execute({
        type: "department.create",
        name: "Delivery",
      });
      const position = (
        await client.execute({
          type: "position.create",
          departmentId: department.id,
          name: "Engineer",
          responsibility: "Ships the change.",
          aiMemberDisplayName: "Ada",
          aiMemberProfile: "A careful engineer.",
          aiMemberResponsibilityMetadata: { focus: "delivery" },
        })
      ).positions[0];
      assert.ok(position);
      const profile = (
        await client.execute({
          type: "execution-profile.save",
          departmentId: department.id,
          expectedRevision: 0,
          name: "Scripted default",
          providerRef: "scripted",
          model: "scripted-v1",
          sandboxRef: "no-sandbox",
          branchStrategy: "head",
          timeoutSeconds: 60,
          maxIterations: 1,
          maxTokens: null,
          retryMaxAttempts: 0,
          permissionPolicy: "deny",
          secretReferenceIds: [],
        })
      ).executionProfiles[0];
      assert.ok(profile);
      await client.execute({
        type: "department.update",
        departmentId: department.id,
        expectedRevision: 0,
        name: department.name,
        description: "A delivery department.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: profile.id,
      });
      const editor = await client.query({
        type: "department.pipeline.inspect",
        departmentId: department.id,
      });
      const graph: DepartmentPipelineDraftGraph = {
        nodes: [
          { id: "start", type: "start", name: "Start" },
          {
            id: "implement",
            type: "ai-task",
            name: "Implement",
            positionId: position.id,
          },
          {
            id: "approval",
            type: "human-approval",
            name: "Approval",
            positionId: position.id,
          },
          { id: "complete", type: "complete", name: "Complete" },
        ],
        edges: [
          { from: "start", to: "implement" },
          { from: "implement", to: "approval" },
          { from: "approval", to: "complete" },
        ],
      };
      const saved = await client.execute({
        type: "department.pipeline.draft.save",
        departmentId: department.id,
        expectedRevision: editor.draft.revision,
        graph,
      });
      await client.execute({
        type: "department.pipeline.publish",
        departmentId: department.id,
        expectedRevision: saved.draft.revision,
      });

      const started = await startConfirmedRun(
        client,
        project.id,
        department.id,
      );
      const waiting = await client.execute({
        type: "run.execute-ready",
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      assert.equal(waiting.run.status, "waiting-approval");
      const approval = waiting.nodes.find(
        (node) => node.pipelineNodeId === "approval",
      );
      assert.ok(approval);
      const requested = await client.execute({
        type: "run.approval.decide",
        runId: waiting.run.id,
        nodeRunId: approval.id,
        expectedRevision: waiting.run.revision,
        decision: "request-changes",
        feedback: "Add recovery evidence.",
      });
      assert.equal(
        requested.nodes.find((node) => node.pipelineNodeId === "implement")
          ?.attempts[1]?.reason,
        "request-changes",
      );
      const waitingAgain = await client.execute({
        type: "run.execute-ready",
        runId: requested.run.id,
        expectedRevision: requested.run.revision,
      });
      assert.equal(waitingAgain.run.status, "waiting-approval");
      const approved = await client.execute({
        type: "run.approval.decide",
        runId: waitingAgain.run.id,
        nodeRunId: approval.id,
        expectedRevision: waitingAgain.run.revision,
        decision: "approve",
      });
      assert.equal(
        approved.nodes.find((node) => node.id === approval.id)?.approvals.at(-1)
          ?.decisionActor?.id,
        "runtime-contract-human",
      );
      const completed = await client.execute({
        type: "run.execute-ready",
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });

      assert.equal(completed.run.status, "completed");
      const completedAttempt = completed.nodes
        .find((node) => node.pipelineNodeId === "implement")
        ?.attempts.at(-1);
      assert.ok(completedAttempt);
      const execution = await client.query({
        type: "execution.inspect",
        targetKind: "node-attempt",
        targetId: completedAttempt.id,
      });
      assert.equal(
        execution.operationKey,
        `node-attempt:${completedAttempt.id}`,
      );
      assert.deepEqual(execution.target, {
        kind: "node-attempt",
        id: completedAttempt.id,
      });
      assert.equal(
        (await client.query({ type: "run.inspect", runId: started.run.id }))
          .snapshot.hash,
        started.snapshot.hash,
      );
      assert.equal(
        (await client.query({ type: "runs.list", projectId: project.id }))
          .length,
        1,
      );
      assert.equal(JSON.stringify(completed).includes("apiKey"), false);
      await runtime.close();

      runtime = await startCompanyRuntimeServer({
        address,
        companyDir,
        token: "valid-token",
      });
      const reloadedClient = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      assert.equal(
        (
          await reloadedClient.query({
            type: "run.inspect",
            runId: started.run.id,
          })
        ).run.status,
        "completed",
      );
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it("serves pause, resume, and cancel through the real Runtime contract", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const project = await client.execute({
        type: "project.create",
        name: "Controlled Run",
        goal: "Verify persistent controls",
      });
      const started = await startConfirmedRun(
        client,
        project.id,
        "software-rnd",
      );
      const paused = await client.execute({
        type: "run.pause",
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      assert.equal(paused.run.status, "paused");
      const resumed = await client.execute({
        type: "run.resume",
        runId: paused.run.id,
        expectedRevision: paused.run.revision,
      });
      assert.equal(resumed.run.status, "ready");
      const cancelled = await client.execute({
        type: "run.cancel",
        runId: resumed.run.id,
        expectedRevision: resumed.run.revision,
      });
      assert.equal(cancelled.run.status, "cancelled");
      assert.equal(
        (
          await client.query({
            type: "run.inspect",
            runId: started.run.id,
          })
        ).run.status,
        "cancelled",
      );
    } finally {
      await runtime.close();
    }
  });

  it("serves Skill Configuration through the real Runtime contract", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "valid-token",
      });
      const inspected = await client.query({
        type: "department.skill-configuration.inspect",
        departmentId: "software-rnd",
      });
      const bound = await client.execute({
        type: "position.skills.set",
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: inspected.revision,
        skillIds: ["code-review", "diagnosing-bugs", "tdd"],
      });
      const skill = await client.execute({
        type: "skill.catalog.save",
        departmentId: "software-rnd",
        expectedRevision: bound.revision,
        name: "Release notes",
        description: "Produces release notes from verified changes.",
        source: "local",
        version: "1",
        locationReference: "skill://release-notes",
      });
      const savedSkill = skill.activeSkills.find(
        (candidate) => candidate.name === "Release notes",
      );
      assert.ok(savedSkill);
      const created = await client.execute({
        type: "skill-flow.save",
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Focused delivery",
        instructions: "Deliver one tested behavior.",
        skillIds: ["tdd"],
      });
      const flow = created.skillFlows.find(
        (candidate) => candidate.name === "Focused delivery",
      );
      assert.ok(flow);
      const updated = await client.execute({
        type: "skill-flow.save",
        departmentId: "software-rnd",
        skillFlowId: flow.id,
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Focused delivery",
        instructions: "Deliver one tested behavior and report evidence.",
        skillIds: ["tdd"],
      });
      assert.equal(
        updated.skillFlows.find((candidate) => candidate.id === flow.id)
          ?.revision,
        1,
      );
      await assert.rejects(
        () =>
          client.execute({
            type: "skill-flow.save",
            departmentId: "software-rnd",
            skillFlowId: flow.id,
            positionId: "software-engineer",
            expectedRevision: 0,
            name: "Stale overwrite",
            instructions: "This must be rejected.",
            skillIds: ["tdd"],
          }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "VERSION_CONFLICT",
      );
      const archivedFlow = await client.execute({
        type: "skill-flow.archive",
        departmentId: "software-rnd",
        skillFlowId: flow.id,
        expectedRevision: 1,
      });
      assert.equal(
        archivedFlow.skillFlows.find((candidate) => candidate.id === flow.id)
          ?.status,
        "archived",
      );
      const archivedSkill = await client.execute({
        type: "skill.catalog.archive",
        departmentId: "software-rnd",
        skillId: savedSkill.id,
        expectedRevision: archivedFlow.revision,
      });
      assert.equal(
        archivedSkill.archivedSkills.some(
          (candidate) => candidate.id === savedSkill.id,
        ),
        true,
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects invalid IPC authentication", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });

    try {
      const client = createCompanyRuntimeClient({
        address,
        token: "invalid-token",
      });

      await assert.rejects(
        () => client.query({ type: "runtime.health" }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "UNAUTHENTICATED",
      );
    } finally {
      await runtime.close();
    }
  });

  it("shuts down cleanly and removes transient runtime files", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const runtime = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "valid-token",
    });
    const client = createCompanyRuntimeClient({
      address,
      token: "valid-token",
    });

    await client.execute({ type: "runtime.shutdown" });
    await runtime.closed;

    assert.equal(existsSync(address), false);
    assert.equal(
      existsSync(join(companyDir, ".sandcastle", "runtime", "runtime.lock")),
      false,
    );
  });

  it("allows only one Runtime writer for a Company Directory", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const first = await startCompanyRuntimeServer({
      address,
      companyDir,
      token: "first-token",
    });

    try {
      await assert.rejects(
        () =>
          startCompanyRuntimeServer({
            address,
            companyDir,
            token: "second-token",
          }),
        /Company Runtime is already running/,
      );
    } finally {
      await first.close();
    }
  });

  it("replaces malformed and stale Runtime locks", async () => {
    for (const lock of ["not-json", JSON.stringify({ pid: 2_147_483_647 })]) {
      const companyDir = tempCompanyDir();
      const runtimeDir = join(companyDir, ".sandcastle", "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, "runtime.lock"), lock);
      const runtime = await startCompanyRuntimeServer({
        address: companyRuntimeAddress(companyDir),
        companyDir,
        token: "valid-token",
      });

      await runtime.close();

      assert.equal(existsSync(join(runtimeDir, "runtime.lock")), false);
    }
  });

  it("fails one of two concurrent starts without disturbing the writer", async () => {
    const companyDir = tempCompanyDir();
    const address = companyRuntimeAddress(companyDir);
    const starts = await Promise.allSettled([
      startCompanyRuntimeServer({
        address,
        companyDir,
        token: "first-token",
      }),
      startCompanyRuntimeServer({
        address,
        companyDir,
        token: "second-token",
      }),
    ]);
    const running = starts.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof startCompanyRuntimeServer>>
      > => result.status === "fulfilled",
    );

    try {
      assert.equal(
        starts.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        starts.filter((result) => result.status === "rejected").length,
        1,
      );
      const client = createCompanyRuntimeClient({
        address,
        token: running === starts[0] ? "first-token" : "second-token",
      });
      assert.equal(
        (await client.query({ type: "runtime.health" })).status,
        "ok",
      );
    } finally {
      await running?.value.close();
    }
  });

  it("releases the Runtime lock when database startup fails", async () => {
    const companyDir = tempCompanyDir();
    const sandcastleDir = join(companyDir, ".sandcastle");
    mkdirSync(sandcastleDir, { recursive: true });
    const database = new DatabaseSync(join(sandcastleDir, "company.sqlite"));
    const unsupportedSchemaVersion = CURRENT_SCHEMA_VERSION + 1;
    database.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '${unsupportedSchemaVersion}');
    `);
    database.close();

    await assert.rejects(
      () =>
        startCompanyRuntimeServer({
          address: companyRuntimeAddress(companyDir),
          companyDir,
          token: "valid-token",
        }),
      new RegExp(
        `Unsupported company database schema version ${unsupportedSchemaVersion}`,
      ),
    );

    assert.equal(
      existsSync(join(sandcastleDir, "runtime", "runtime.lock")),
      false,
    );
  });
});
