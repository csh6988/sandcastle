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
import { assertSoftwareRndDepartmentContract } from "./testing/departmentInspectContract.js";
import type { DepartmentPipelineDraftGraph } from "./interface.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-runtime-"));

describe("Company Runtime", () => {
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
      assert.equal(health.schemaVersion, 23);
      assert.equal(health.pid, process.pid);
      assert.equal(
        existsSync(join(companyDir, ".sandcastle", "company.sqlite")),
        true,
      );
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
      const started = await client.execute({
        type: "run.start",
        projectId: project.id,
        departmentId: "software-rnd",
      });
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

      assert.equal(created.schemaVersion, 23);
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
      const started = await client.execute({
        type: "run.start",
        projectId: project.id,
        departmentId: "software-rnd",
      });

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
      const runEvent = events.find((event) => event.runId === started.run.id);
      assert.equal(runAudit?.action, "run.start");
      assert.equal(runEvent?.type, "run.created");
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
           event_id, type, run_id, node_run_id, payload_json, created_at
         ) VALUES (?, 'session.message.created', NULL, NULL, ?, ?)`,
      );
      sqlite.exec("BEGIN IMMEDIATE");
      for (let sequence = 1; sequence <= 1_005; sequence += 1) {
        insert.run(
          `event-${sequence}`,
          JSON.stringify({ sessionId: "session-1", content: `${sequence}` }),
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
      assert.equal(copied.positions.length, 5);
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
        5,
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

      const started = await client.execute({
        type: "run.start",
        projectId: project.id,
        departmentId: department.id,
      });
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
      const completed = await client.execute({
        type: "run.execute-ready",
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
      });

      assert.equal(completed.run.status, "completed");
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
      const started = await client.execute({
        type: "run.start",
        projectId: project.id,
        departmentId: "software-rnd",
      });
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
    database.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '24');
    `);
    database.close();

    await assert.rejects(
      () =>
        startCompanyRuntimeServer({
          address: companyRuntimeAddress(companyDir),
          companyDir,
          token: "valid-token",
        }),
      /Unsupported company database schema version 24/,
    );

    assert.equal(
      existsSync(join(sandcastleDir, "runtime", "runtime.lock")),
      false,
    );
  });
});
