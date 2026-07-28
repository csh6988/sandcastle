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

  it("resolves the formal local profile to the Docker sandbox provider", () => {
    const dockerSandbox = { tag: "bind-mount", name: "docker" };
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
    assert.deepEqual(
      runtime.resolveReviewerSandbox?.({
        sandboxRef: "docker",
        workspaceRef: "/review-bundle",
        operationKey: "code-review:review-1:initial-finding",
        secretReferenceIds: [],
      }).sandbox,
      dockerSandbox,
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
