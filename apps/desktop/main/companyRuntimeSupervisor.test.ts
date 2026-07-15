import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createSandcastleBridge } from "../preload/bridge.js";
import { companyRuntimeAddress } from "../runtime/address.js";
import { createCompanyRuntimeSupervisor } from "./companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "./runtimeIpc.js";
import { assertSoftwareRndDepartmentContract } from "../runtime/testing/departmentInspectContract.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-supervisor-"));

const createTestSupervisor = () =>
  createCompanyRuntimeSupervisor({
    executable: process.execPath,
    execArgs: ["--import", "tsx"],
    runtimeEntry: fileURLToPath(
      new URL("../runtime/entry.ts", import.meta.url),
    ),
    shutdownTimeoutMs: 5_000,
    startupTimeoutMs: 10_000,
  });

const waitFor = async <T>(
  inspect: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspect();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
};

describe("Company Runtime Supervisor", () => {
  it("starts one runtime for a company and renderer reconnects keep it alive", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      const first = await supervisor.start(companyDir);
      const handlers = new Map<
        string,
        (...args: readonly unknown[]) => Promise<unknown> | unknown
      >();
      registerRuntimeIpc(
        {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
        () => supervisor,
      );
      const rendererBeforeReload = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const beforeReload = await rendererBeforeReload.runtime.health();

      const rendererAfterReload = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const afterReload = await rendererAfterReload.runtime.health();
      const department =
        await rendererAfterReload.runtime.inspectDepartment("software-rnd");
      const repeatedStart = await supervisor.start(companyDir);

      assert.equal(beforeReload.pid, first.pid);
      assert.equal(afterReload.pid, first.pid);
      assert.equal(afterReload.startedAt, first.startedAt);
      assert.equal(repeatedStart.pid, first.pid);
      assertSoftwareRndDepartmentContract(department);
      assert.doesNotThrow(() => process.kill(first.pid, 0));
    } finally {
      await supervisor.stop();
    }
  });

  it("closes the Department Run loop through Supervisor, IPC, and preload", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const handlers = new Map<
        string,
        (...args: readonly unknown[]) => Promise<unknown> | unknown
      >();
      registerRuntimeIpc(
        {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
        () => supervisor,
      );
      const bridge = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const project = await bridge.runtime.createProject({
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const started = await bridge.runtime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const advanced = await bridge.runtime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });

      assert.equal(started.run.status, "ready");
      assert.equal(advanced.run.status, "waiting-approval");
      assert.equal(
        advanced.nodes.find((node) => node.pipelineNodeId === "plan-approval")
          ?.status,
        "waiting-approval",
      );
      const approval = advanced.nodes.find(
        (node) => node.pipelineNodeId === "plan-approval",
      );
      assert.ok(approval);
      const requested = await bridge.runtime.decideApproval({
        runId: advanced.run.id,
        nodeRunId: approval.id,
        expectedRevision: advanced.run.revision,
        decision: "request-changes",
        feedback: "Add recovery evidence.",
      });
      assert.equal(
        requested.nodes.find((node) => node.pipelineNodeId === "technical-plan")
          ?.attempts.length,
        2,
      );
      const waitingAgain = await bridge.runtime.executeReady({
        runId: requested.run.id,
        expectedRevision: requested.run.revision,
      });
      const approved = await bridge.runtime.decideApproval({
        runId: waitingAgain.run.id,
        nodeRunId: approval.id,
        expectedRevision: waitingAgain.run.revision,
        decision: "approve",
      });
      assert.equal(approved.run.status, "running");
      assert.deepEqual(
        approved.nodes.find((node) => node.id === approval.id)?.result,
        { decision: "approve" },
      );

      const reloadedBridge = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const reloaded = await reloadedBridge.runtime.inspectRun(started.run.id);
      assert.equal(reloaded.run.status, "running");
      assert.equal(reloaded.snapshot.hash, started.snapshot.hash);
      assert.equal(
        (await reloadedBridge.runtime.runs(project.id))[0]?.run.id,
        started.run.id,
      );
      await assert.rejects(
        () =>
          reloadedBridge.runtime.decideApproval({
            runId: approved.run.id,
            nodeRunId: approval.id,
            expectedRevision: approved.run.revision,
            decision: "reject",
          }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "RuntimeBridgeError" &&
          "code" in error &&
          error.code === "APPROVAL_STATE_INVALID",
      );
      await assert.rejects(
        () =>
          reloadedBridge.runtime.executeReady({
            runId: started.run.id,
            expectedRevision: 0,
          }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "RuntimeBridgeError" &&
          "code" in error &&
          error.code === "VERSION_CONFLICT",
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("closes the Department configuration loop through Supervisor, IPC, and preload", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const handlers = new Map<
        string,
        (...args: readonly unknown[]) => Promise<unknown> | unknown
      >();
      registerRuntimeIpc(
        {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
        () => supervisor,
      );
      const bridge = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );

      const updated = await bridge.runtime.updateDepartment({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Product Engineering",
        description: "Builds and verifies product changes.",
        inputArtifactContracts: [],
        outputArtifactContracts: [],
        defaultExecutionProfileId: "software-rnd-default",
      });
      const configured = await bridge.runtime.updatePosition({
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
      const copied = await bridge.runtime.copyDepartment({
        departmentId: "software-rnd",
        name: "Product Delivery",
      });
      const archived = await bridge.runtime.archiveDepartment({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });

      assert.equal(updated.name, "Product Engineering");
      assert.equal(configured.positions[2]?.aiMember.status, "inactive");
      assert.equal(copied.name, "Product Delivery");
      assert.notEqual(copied.pipeline?.id, configured.pipeline?.id);
      assert.equal(archived.status, "archived");
      assert.deepEqual(
        (await bridge.runtime.departments()).map((department) => department.id),
        [copied.id],
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("closes the Project Configuration loop through Supervisor, IPC, and preload", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const handlers = new Map<
        string,
        (...args: readonly unknown[]) => Promise<unknown> | unknown
      >();
      registerRuntimeIpc(
        {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
        () => supervisor,
      );
      const bridge = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const project = await bridge.runtime.createProject({
        name: "Checkout",
        goal: "Ship the checkout redesign",
      });
      const inspected = await bridge.runtime.inspectProject(project.id);
      const updated = await bridge.runtime.updateProject({
        projectId: project.id,
        expectedRevision: inspected.revision,
        name: "Checkout Platform",
        goal: "Ship a resilient checkout platform",
        sharedContext: "Preserve the payment-provider contract.",
        repositoryReferences: ["/work/checkout-web"],
      });
      const archived = await bridge.runtime.archiveProject({
        projectId: project.id,
        expectedRevision: updated.revision,
      });

      assert.equal(updated.revision, 1);
      assert.deepEqual(updated.repositoryReferences, ["/work/checkout-web"]);
      assert.equal(archived.status, "archived");
      assert.deepEqual(await bridge.runtime.projects(), []);
      assert.equal(
        (await bridge.runtime.inspectProject(project.id)).revision,
        2,
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("closes the Skill Configuration loop through Supervisor, IPC, and preload", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const handlers = new Map<
        string,
        (...args: readonly unknown[]) => Promise<unknown> | unknown
      >();
      registerRuntimeIpc(
        {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
        () => supervisor,
      );
      const bridge = createSandcastleBridge((channel, payload) =>
        Promise.resolve(handlers.get(channel)?.({}, payload)),
      );
      const inspected =
        await bridge.runtime.inspectSkillConfiguration("software-rnd");
      const bound = await bridge.runtime.setPositionSkills({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: inspected.revision,
        skillIds: ["code-review", "diagnosing-bugs", "tdd"],
      });
      const created = await bridge.runtime.saveSkillFlow({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Renderer delivery",
        instructions: "Deliver one tested behavior.",
        skillIds: ["tdd"],
      });
      const flow = created.skillFlows.find(
        (candidate) => candidate.name === "Renderer delivery",
      );
      assert.ok(flow);
      const archived = await bridge.runtime.archiveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: flow.id,
        expectedRevision: 0,
      });

      assert.equal(bound.revision, 1);
      assert.equal(
        archived.skillFlows.find((candidate) => candidate.id === flow.id)
          ?.status,
        "archived",
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("exposes Pipeline Configuration through the supervised Runtime", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const editor = await supervisor.inspectPipeline("software-rnd");
      const graph = {
        ...editor.draft.graph,
        nodes: editor.draft.graph.nodes.map((node) =>
          node.id === "review" ? { ...node, name: "Supervised review" } : node,
        ),
      };
      const saved = await supervisor.savePipelineDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph,
      });
      const validation = await supervisor.validatePipeline({
        departmentId: "software-rnd",
        graph,
      });
      const published = await supervisor.publishPipeline({
        departmentId: "software-rnd",
        expectedRevision: saved.draft.revision,
      });

      assert.equal(saved.draft.revision, 1);
      assert.equal(validation.valid, true);
      assert.equal(published.published?.version, 3);
      assert.equal(published.history.length, 3);
    } finally {
      await supervisor.stop();
    }
  });

  it("exposes Skill Configuration through the supervised Runtime", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      await supervisor.start(companyDir);
      const inspected =
        await supervisor.inspectSkillConfiguration("software-rnd");
      const bound = await supervisor.setPositionSkills({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: inspected.revision,
        skillIds: ["code-review", "diagnosing-bugs", "tdd"],
      });
      const created = await supervisor.saveSkillFlow({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Supervised delivery",
        instructions: "Deliver one tested behavior.",
        skillIds: ["tdd"],
      });
      const flow = created.skillFlows.find(
        (candidate) => candidate.name === "Supervised delivery",
      );
      assert.ok(flow);
      const archived = await supervisor.archiveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: flow.id,
        expectedRevision: 0,
      });

      assert.equal(bound.revision, 1);
      assert.equal(
        archived.skillFlows.find((candidate) => candidate.id === flow.id)
          ?.status,
        "archived",
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("stops the runtime without leaving an orphan process or transient files", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();
    const health = await supervisor.start(companyDir);

    await supervisor.stop();

    assert.throws(() => process.kill(health.pid, 0));
    assert.equal(existsSync(companyRuntimeAddress(companyDir)), false);
    assert.equal(
      existsSync(join(companyDir, ".sandcastle", "runtime", "runtime.lock")),
      false,
    );
  });

  it("restarts once after an unexpected exit, then exposes a diagnosable failure", async () => {
    const companyDir = tempCompanyDir();
    const supervisor = createTestSupervisor();

    try {
      const first = await supervisor.start(companyDir);
      process.kill(first.pid, "SIGKILL");

      const second = await waitFor(async () => {
        try {
          const health = await supervisor.health();
          return health.pid === first.pid ? undefined : health;
        } catch {
          return undefined;
        }
      });
      assert.equal(supervisor.diagnostics().status, "running");
      assert.equal(supervisor.diagnostics().restartCount, 1);
      assert.notEqual(second.pid, first.pid);

      process.kill(second.pid, "SIGKILL");
      const failed = await waitFor(() => {
        const diagnostics = supervisor.diagnostics();
        return diagnostics.status === "failed" ? diagnostics : undefined;
      });

      assert.equal(failed.restartCount, 1);
      assert.equal(failed.lastExit?.pid, second.pid);
      if (process.platform !== "win32") {
        assert.equal(failed.lastExit?.signal, "SIGKILL");
      }
      await assert.rejects(() => supervisor.health(), /unexpectedly exited/);
      assert.throws(() => process.kill(second.pid, 0));
    } finally {
      await supervisor.stop();
    }
  });
});
