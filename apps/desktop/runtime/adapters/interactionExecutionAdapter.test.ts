import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  createSandcastleInteractionExecutionAdapter,
  type InteractionExecutionInput,
} from "./interactionExecutionAdapter.js";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";

const input = (): InteractionExecutionInput => ({
  session: {
    id: "session-1",
    mode: "consultation",
    projectId: "project-1",
    runId: null,
    nodeRunId: null,
    status: "active",
    createdAt: "2026-07-15T00:00:00.000Z",
    closedAt: null,
  },
  project: {
    id: "project-1",
    name: "Checkout",
    goal: "Ship checkout",
    status: "active",
    revision: 0,
    sharedContext: "Preserve payments.",
    repositoryReferences: ["/workspace/checkout"],
    departmentRuns: [],
    createdAt: "2026-07-15T00:00:00.000Z",
  },
  aiParticipant: {
    id: "participant-1",
    sessionId: "session-1",
    participantType: "ai-member",
    participantRef: "member-1",
    role: "consulted-member",
    createdAt: "2026-07-15T00:00:00.000Z",
  },
  position: {
    id: "position-1",
    name: "Product Planner",
    responsibility: "Aligns goals.",
    defaultAgentId: "codex",
    aiMember: {
      id: "member-1",
      displayName: "Ada",
      profile: "Careful planner.",
    },
  },
  executionProfile: {
    providerRef: "default-agent",
    model: "gpt-test",
    sandboxRef: "no-sandbox",
    limits: { timeoutSeconds: 60 },
  },
  prompt: "你好",
});

describe("Sandcastle interaction execution adapter", () => {
  it("invokes the configured Agent through the existing core Runtime seam", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => ({ provider, model }),
      resolveSandbox: (sandbox) => ({ sandbox }),
      run: async (options) => {
        received = options;
        return { stdout: "你好，我是 Ada。" };
      },
      runWorkspaceTask: async () => ({}),
    };

    const result =
      await createSandcastleInteractionExecutionAdapter(runtime).execute(
        input(),
      );

    assert.deepEqual(result, { response: "你好，我是 Ada。" });
    assert.deepEqual(received?.agent, { provider: "codex", model: "gpt-test" });
    assert.deepEqual(received?.branchStrategy, {
      type: "branch",
      branch: "sandcastle/interaction/session-1",
    });
    assert.equal(received?.maxIterations, 1);
    assert.match(String(received?.prompt), /Preserve payments/);
    assert.match(String(received?.prompt), /你好/);
  });

  it("fails clearly when the Agent returns no response text", async () => {
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      run: async () => ({}),
      runWorkspaceTask: async () => ({}),
    };

    await assert.rejects(
      () =>
        createSandcastleInteractionExecutionAdapter(runtime).execute(input()),
      /Agent returned no response text/,
    );
  });

  it("resolves a nested Project repository reference to its Git root", async () => {
    const repository = mkdtempSync(
      join(tmpdir(), "sandcastle-interaction-repo-"),
    );
    const nested = join(repository, "apps", "desktop");
    mkdirSync(join(repository, ".git"));
    mkdirSync(nested, { recursive: true });
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      run: async (options) => {
        received = options;
        return { stdout: "ok" };
      },
      runWorkspaceTask: async () => ({}),
    };

    await createSandcastleInteractionExecutionAdapter(runtime).execute({
      ...input(),
      project: { ...input().project, repositoryReferences: [nested] },
    });

    assert.equal(received?.cwd, repository);
  });

  it("falls back to the Runtime Git root when Project repository references are empty", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: () => ({}),
      resolveSandbox: () => ({}),
      run: async (options) => {
        received = options;
        return { stdout: "ok" };
      },
      runWorkspaceTask: async () => ({}),
    };

    await createSandcastleInteractionExecutionAdapter(runtime).execute({
      ...input(),
      project: { ...input().project, repositoryReferences: [] },
    });

    assert.equal(received?.cwd, join(process.cwd(), "..", ".."));
  });

  it("does not pass the catalog placeholder model default to Codex", async () => {
    let receivedAgent: unknown;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (provider, model) => {
        receivedAgent = { provider, model };
        return receivedAgent;
      },
      resolveSandbox: () => ({}),
      run: async () => ({ stdout: "ok" }),
      runWorkspaceTask: async () => ({}),
    };

    await createSandcastleInteractionExecutionAdapter(runtime).execute({
      ...input(),
      executionProfile: { ...input().executionProfile, model: "default" },
    });

    assert.deepEqual(receivedAgent, { provider: "codex", model: "x5/gpt-5.5" });
  });

  it("disables resumable Session capture for one-shot consultation replies", async () => {
    let receivedOptions: { readonly captureSessions?: boolean } | undefined;
    const runtime: SandcastleExecutionRuntime = {
      resolveAgent: (_provider, _model, options) => {
        receivedOptions = options;
        return {};
      },
      resolveSandbox: () => ({}),
      run: async () => ({ stdout: "ok" }),
      runWorkspaceTask: async () => ({}),
    };

    await createSandcastleInteractionExecutionAdapter(runtime).execute(input());

    assert.deepEqual(receivedOptions, { captureSessions: false });
  });
});
