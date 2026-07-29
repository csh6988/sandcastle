import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { createElectronTestFixture } from "./electronTestFixture.js";
import { createIntegrationAuthorityFixture } from "./integrationAuthorityFixture.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fixtureRoots: string[] = [];
const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Integration authority fixture", () => {
  it("creates exact T15 and T16 PASS authority through Runtime handlers", async () => {
    const scriptRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-integration-authority-scripts-"),
    );
    fixtureRoots.push(scriptRoot);
    const executionScript = join(scriptRoot, "execution.json");
    const interactionScript = join(scriptRoot, "interaction.json");
    writeFileSync(executionScript, JSON.stringify({ status: "passed" }), {
      mode: 0o600,
    });
    writeFileSync(
      interactionScript,
      JSON.stringify({ response: "fixture interaction passed" }),
      { mode: 0o600 },
    );
    const electronFixture = createElectronTestFixture({
      fixtureId: "integration-authority-fixture-v1",
      testRunId: "pending",
      testRunManifestHash: "0".repeat(64),
      adapters: [
        {
          id: "scripted-execution",
          scriptPath: executionScript,
          expectedScriptHash: sha256(JSON.stringify({ status: "passed" })),
        },
        {
          id: "scripted-interaction",
          scriptPath: interactionScript,
          expectedScriptHash: sha256(
            JSON.stringify({ response: "fixture interaction passed" }),
          ),
        },
      ],
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "integration-authority-fixture-seed",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    fixtureCleanups.push(() => void electronFixture.cleanup());

    const created = await createIntegrationAuthorityFixture({
      companyDirectory: electronFixture.config.companyDirectory,
      companyDirectoryFingerprint:
        electronFixture.config.companyDirectoryFingerprint,
      fixtureId: electronFixture.config.fixtureId,
      repositoryDirectory: electronFixture.config.repositoryDirectory,
      worktreeDirectory: electronFixture.config.worktreeDirectory,
      fakeClock: electronFixture.config.fakeClock,
      repeatableIdSeed: electronFixture.config.repeatableIdSeed,
    });

    const database = openCompanyDatabase(
      electronFixture.config.companyDirectory,
    );
    try {
      const authority = database.integrations.readPassAuthority(
        created.integrationAuthority.id,
      );
      assert.deepEqual(authority, created.integrationAuthority);
      assert.equal(
        database.codeReviews.inspect(created.runId)[0]?.integrationEligible,
        true,
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(created.runId)
          .nodes.find((node) => node.pipelineNodeId === "integration")?.status,
        "succeeded",
      );
    } finally {
      database.close();
    }
  });
});
