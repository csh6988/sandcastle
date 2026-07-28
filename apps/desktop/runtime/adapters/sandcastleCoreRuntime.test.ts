import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSandcastleExecutionRuntimeFromModules } from "./sandcastleCoreRuntime.js";

describe("Sandcastle core Runtime loader", () => {
  it("resolves a configured Agent, no-sandbox, and structured Output", async () => {
    let runOptions: Record<string, unknown> | undefined;
    let claudeOptions: Record<string, unknown> | undefined;
    const runtime = createSandcastleExecutionRuntimeFromModules(
      {
        run: async (options) => {
          runOptions = options;
          return { output: { aligned: true } };
        },
        runWorkspaceTask: async () => ({}),
        Output: {
          object: ({ tag }) => ({ kind: "object", tag }),
        },
        createBindMountSandboxProvider: (configuration) => ({
          tag: "bind-mount",
          env: {},
          sandboxHomedir: undefined,
          ...configuration,
        }),
        claudeCode: (model, options) => {
          claudeOptions = options;
          return { provider: "claude-code", model };
        },
        codex: (model) => ({ provider: "codex", model }),
        copilot: (model) => ({ provider: "copilot", model }),
        cursor: (model) => ({ provider: "cursor", model }),
        opencode: (model) => ({ provider: "opencode", model }),
        pi: (model) => ({ provider: "pi", model }),
      },
      {
        noSandbox: () => ({
          create: async ({ worktreePath }) => ({
            worktreePath,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            close: async () => undefined,
          }),
        }),
      },
    );
    assert.deepEqual(runtime.resolveAgent("codex", "gpt-test"), {
      provider: "codex",
      model: "gpt-test",
    });
    runtime.resolveAgent("claude-code", "claude-test");
    assert.deepEqual(claudeOptions, { captureSessions: false });
    assert.equal(
      (runtime.resolveSandbox("no-sandbox") as { readonly tag: string }).tag,
      "bind-mount",
    );
    await runtime.run({
      prompt: "emit <alignment>",
      output: { tag: "alignment", schema: "object" },
    });
    assert.deepEqual(runOptions?.output, { kind: "object", tag: "alignment" });
  });

  it("resolves the formal local profile to the Docker sandbox provider", async () => {
    const dockerSandbox = {
      tag: "bind-mount" as const,
      name: "docker",
      env: {},
      sandboxHomedir: "/home/agent",
      create: async (_options: unknown) => ({
        worktreePath: "/launcher",
        exec: async (command: string) => {
          if (command.includes("/etc/hostname")) {
            return {
              stdout: "reviewer-container-1\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (command.includes("mountinfo")) {
            return {
              stdout: "42 31 0:40 / /review ro - ext4 /dev/root ro\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (command.includes("printf")) {
            return {
              stdout:
                "/home/agent\n/home/agent/.cache\n/home/agent/.config\n/home/agent/.local/share\n",
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => undefined,
        copyFileOut: async () => undefined,
        close: async () => undefined,
      }),
    };
    let reviewerDockerOptions: Record<string, unknown> | undefined;
    const runtime = createSandcastleExecutionRuntimeFromModules(
      {
        run: async () => ({}),
        runWorkspaceTask: async () => ({}),
        Output: { object: ({ tag }) => ({ tag }) },
        createBindMountSandboxProvider: (configuration) => configuration,
        claudeCode: () => ({}),
        codex: () => ({}),
        copilot: () => ({}),
        cursor: () => ({}),
        opencode: () => ({}),
        pi: () => ({}),
      },
      {
        noSandbox: () => ({
          create: async ({ worktreePath }) => ({
            worktreePath,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            close: async () => undefined,
          }),
        }),
      },
      {
        docker: (options) => {
          reviewerDockerOptions = options;
          return dockerSandbox;
        },
      },
    );

    assert.equal(runtime.resolveSandbox("docker"), dockerSandbox);
    const startedOperations: unknown[] = [];
    const reviewerSandbox = runtime.resolveReviewerSandbox?.({
      sandboxRef: "docker",
      workspaceRef: "/review-bundle",
      operationKey: "code-review:review-1:initial-finding",
      secretReferenceIds: [],
      onOperationStarted: async (started) => {
        startedOperations.push(started);
      },
    });
    assert.ok(reviewerSandbox);
    const handle = await (
      reviewerSandbox.sandbox as typeof dockerSandbox
    ).create({
      worktreePath: "/launcher",
      hostRepoPath: "/launcher",
      mounts: [],
      env: {},
    });
    assert.deepEqual(startedOperations, [
      {
        providerId: "sandcastle-docker-reviewer",
        providerOperationId: "reviewer-container-1",
        evidence: [
          "docker:ephemeral-container",
          "mount:/review:readonly",
          "home:/home/agent:container-private",
          "cache:/home/agent/.cache:container-private",
          "sessions:capture-disabled",
          "inputs:/review:allowlisted",
          "provider-operation:reviewer-container-1",
          `mount-inspection:${reviewerSandbox.receipt.mountTableHash}`,
          `environment-inspection:${reviewerSandbox.receipt.inspectedEnvironmentHash}`,
          `credentials:scope:${reviewerSandbox.receipt.credentialScopeHash}`,
        ],
      },
    ]);
    await handle.close();
    assert.equal(
      reviewerSandbox.receipt.providerOperationId,
      "reviewer-container-1",
    );
    assert.equal(reviewerSandbox.receipt.inspectedReadOnlyReviewMount, true);
    assert.equal(reviewerSandbox.receipt.terminalProviderStatus, "completed");
    assert.equal(
      reviewerSandbox.receipt.terminalProviderReceiptHash?.length,
      64,
    );
    assert.deepEqual(reviewerDockerOptions, {
      mounts: [
        {
          hostPath: "/review-bundle",
          sandboxPath: "/review",
          readonly: true,
        },
      ],
      env: {
        HOME: "/home/agent",
        XDG_CACHE_HOME: "/home/agent/.cache",
        XDG_CONFIG_HOME: "/home/agent/.config",
        XDG_DATA_HOME: "/home/agent/.local/share",
      },
    });
    assert.throws(
      () =>
        runtime.resolveReviewerSandbox?.({
          sandboxRef: "docker",
          workspaceRef: "/review-bundle",
          operationKey: "code-review:review-1:initial-finding",
          secretReferenceIds: ["reviewer-secret"],
        }),
      /operation-local materializer/,
    );
    assert.throws(
      () => runtime.resolveSandbox("test-isolated"),
      /Unsupported Sandbox reference/,
    );
  });
});
