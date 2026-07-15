import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfiguredExecutionAdapter } from "./configuredExecutionAdapter.js";
import type { SandcastleExecutionRuntime } from "./sandcastleExecutionPort.js";

describe("Configured Execution Adapter", () => {
  it("keeps Scripted execution deterministic unless production is explicitly selected", async () => {
    let loads = 0;
    const loadRuntime = async (): Promise<SandcastleExecutionRuntime> => {
      loads += 1;
      throw new Error("Production Runtime must not load in Scripted mode.");
    };

    assert.equal(
      await loadConfiguredExecutionAdapter(
        { SANDCASTLE_COMPANY_RUNTIME_EXECUTION_ADAPTER: "scripted" },
        loadRuntime,
      ),
      undefined,
    );
    assert.equal(loads, 0);
  });

  it("loads the Production Adapter only for the explicit production mode", async () => {
    let loads = 0;
    const loadRuntime = async (): Promise<SandcastleExecutionRuntime> => {
      loads += 1;
      return {
        resolveAgent: () => ({}),
        resolveSandbox: () => ({ tag: "none" }),
        run: async () => ({}),
        runWorkspaceTask: async () => ({}),
      };
    };

    const adapter = await loadConfiguredExecutionAdapter(
      { SANDCASTLE_COMPANY_RUNTIME_EXECUTION_ADAPTER: "production" },
      loadRuntime,
    );

    assert.equal(typeof adapter?.execute, "function");
    assert.equal(loads, 1);
  });

  it("rejects an unknown execution mode instead of silently downgrading", async () => {
    await assert.rejects(
      () =>
        loadConfiguredExecutionAdapter(
          { SANDCASTLE_COMPANY_RUNTIME_EXECUTION_ADAPTER: "remote" },
          async () => {
            throw new Error("not reached");
          },
        ),
      /Unsupported Company Runtime execution adapter: remote/,
    );
  });
});
