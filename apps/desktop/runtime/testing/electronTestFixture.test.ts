import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createElectronTestFixture,
  deriveElectronTestFixtureRuntimeToken,
  ElectronTestFixtureError,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
} from "./electronTestFixture.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const scripts = () => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-test-scripts-"));
  const execution = join(directory, "execution.json");
  const interaction = join(directory, "interaction.json");
  writeFileSync(execution, '{"result":"passed"}', { mode: 0o600 });
  writeFileSync(interaction, '{"actions":["click"]}', { mode: 0o600 });
  return [
    {
      id: "scripted-execution",
      scriptPath: execution,
      expectedScriptHash: sha256('{"result":"passed"}'),
    },
    {
      id: "scripted-interaction",
      scriptPath: interaction,
      expectedScriptHash: sha256('{"actions":["click"]}'),
    },
  ] as const;
};

describe("Electron Test fixture", () => {
  it("creates a 0600 one-time-token fixture under the canonical temporary root and cleans it safely", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-1",
      testRunId: "test-run-1",
      testRunManifestHash: "a".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-1",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });

    assert.equal(statSync(fixture.configPath).mode & 0o777, 0o600);
    assert.equal(fixture.config.adapterIds.length, 2);
    assert.equal(
      fixture.config.companyDirectory.startsWith(fixture.root),
      true,
    );
    assert.deepEqual(
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorization: deriveElectronTestFixtureRuntimeToken(fixture.config),
        packaged: false,
        entrypoint: "electron-test-fixture",
      }).adapterIds,
      ["scripted-execution", "scripted-interaction"],
    );
    fixture.consumeIpcToken(fixture.config.ipcToken);
    assert.throws(
      () => fixture.consumeIpcToken(fixture.config.ipcToken),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_IPC_TOKEN_INVALID",
    );
    const receipt = fixture.cleanup();
    assert.equal(receipt.removed, true);
    assert.equal(existsSync(fixture.root), false);
  });

  it("fails closed for packaged builds, changed scripts, and non-allowlisted adapters", () => {
    const adapters = scripts();
    assert.throws(
      () =>
        createElectronTestFixture({
          fixtureId: "fixture-production",
          testRunId: "test-run-production",
          testRunManifestHash: "b".repeat(64),
          adapters,
          allowedAdapterIds: adapters.map((adapter) => adapter.id),
          fakeClock: "2026-07-29T00:00:00.000Z",
          repeatableIdSeed: "seed-production",
          packaged: true,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_MODE_FORBIDDEN",
    );
    assert.throws(
      () =>
        createElectronTestFixture({
          fixtureId: "fixture-forbidden",
          testRunId: "test-run-forbidden",
          testRunManifestHash: "b".repeat(64),
          adapters,
          allowedAdapterIds: ["scripted-execution"],
          fakeClock: "2026-07-29T00:00:00.000Z",
          repeatableIdSeed: "seed-forbidden",
          packaged: false,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_ADAPTER_FORBIDDEN",
    );
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-loader-production",
      testRunId: "test-run-loader-production",
      testRunManifestHash: "c".repeat(64),
      adapters,
      allowedAdapterIds: adapters.map((adapter) => adapter.id),
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-loader-production",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    assert.throws(
      () =>
        loadElectronTestFixtureConfig({
          configPath: fixture.configPath,
          authorization: deriveElectronTestFixtureRuntimeToken(fixture.config),
          packaged: true,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_MODE_FORBIDDEN",
    );
    fixture.cleanup();
  });

  it("normalizes portable evidence paths and rejects Windows, UNC, traversal, and reserved names", () => {
    assert.equal(
      normalizeTestEvidenceLocator("screenshots\\run-1\\main.png"),
      "screenshots/run-1/main.png",
    );
    for (const path of [
      "C:\\Users\\person\\capture.png",
      "\\\\server\\share\\capture.png",
      "../capture.png",
      "logs/../../capture.png",
      "screenshots/CON.txt",
      "/private/tmp/capture.png",
    ]) {
      assert.throws(
        () => normalizeTestEvidenceLocator(path),
        (error: unknown) =>
          error instanceof ElectronTestFixtureError &&
          error.code === "FIXTURE_EVIDENCE_PATH_INVALID",
      );
    }
  });
});
