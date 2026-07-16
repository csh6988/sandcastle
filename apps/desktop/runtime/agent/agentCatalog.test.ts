import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-agent-catalog-"));

describe("Agent Catalog", () => {
  it("discovers registered local Company Agent Adapters through stable IDs", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date("2026-07-16T08:00:00.000Z"),
      agentHost: {
        resolveExecutable: async (names: readonly string[]) =>
          names.includes("codex") ? "/opt/sandcastle/bin/codex" : null,
        run: async () => ({
          exitCode: 0,
          stdout: "codex-cli 1.2.3\n",
          stderr: "",
        }),
      },
    });

    try {
      const catalog = await database.agentCatalog.discover();

      assert.deepEqual(
        catalog.agents.map((agent) => agent.id),
        ["claude-code", "codex", "pi-agent", "codem", "hermes"],
      );
      assert.deepEqual(
        catalog.agents.find((agent) => agent.id === "codex"),
        {
          id: "codex",
          name: "Codex",
          status: "installed",
          version: "1.2.3",
          executablePath: "/opt/sandcastle/bin/codex",
          lastDetectedAt: "2026-07-16T08:00:00.000Z",
          capabilities: [
            "non-interactive",
            "structured-output",
            "session-resume",
          ],
          errorCode: null,
        },
      );
      assert.equal(
        catalog.agents.find((agent) => agent.id === "claude-code")?.status,
        "not-installed",
      );
    } finally {
      database.close();
    }
  });

  it("runs a non-destructive Agent test without exposing command output", async () => {
    const database = openCompanyDatabase(tempCompanyDir(), {
      clock: () => new Date("2026-07-16T08:01:00.000Z"),
      agentHost: {
        resolveExecutable: async (names: readonly string[]) =>
          names.includes("codex") ? "/opt/sandcastle/bin/codex" : null,
        run: async ({ args }) => {
          assert.deepEqual(args, ["--version"]);
          return {
            exitCode: 0,
            stdout: "codex-cli 1.2.3\nTOKEN=must-not-leak",
            stderr: "",
          };
        },
      },
    });

    try {
      const result = await database.agentCatalog.test("codex");

      assert.deepEqual(result, {
        agentId: "codex",
        status: "passed",
        testedAt: "2026-07-16T08:01:00.000Z",
        summary: "Agent executable responded to its non-destructive test.",
      });
      assert.equal("TOKEN=must-not-leak" in result, false);
      assert.equal(database.pipelineRuntime.listRuns().length, 0);
    } finally {
      database.close();
    }
  });
});
