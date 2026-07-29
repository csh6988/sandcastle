import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createElectronTestFixture,
  ElectronTestFixtureError,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
  verifyTestEvidenceFile,
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
  it("atomically consumes a separate 0600 authorization claim and never stores the reusable token in config", () => {
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
    assert.equal(statSync(fixture.authorizationClaimPath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(fixture.configPath, "utf8").includes(fixture.authorization),
      false,
    );
    assert.equal("ipcToken" in fixture.config, false);
    assert.equal(fixture.config.adapterIds.length, 2);
    assert.equal(
      fixture.config.companyDirectory.startsWith(fixture.root),
      true,
    );
    assert.deepEqual(
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorization: fixture.authorization,
        packaged: false,
        entrypoint: "electron-test-fixture",
      }).adapterIds,
      ["scripted-execution", "scripted-interaction"],
    );
    assert.throws(
      () =>
        loadElectronTestFixtureConfig({
          configPath: fixture.configPath,
          authorization: fixture.authorization,
          packaged: false,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
    );
    const receipt = fixture.cleanup();
    assert.equal(receipt.removed, true);
    assert.equal(existsSync(fixture.root), false);
  });

  it("creates a real temporary Git repository and linked worktree", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-git",
      testRunId: "test-run-git",
      testRunManifestHash: "9".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-git",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });

    assert.equal(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: fixture.config.repositoryDirectory,
        encoding: "utf8",
      }).trim(),
      "true",
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.config.repositoryDirectory,
        encoding: "utf8",
      }).trim(),
      fixture.config.repositoryCommit,
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: fixture.config.worktreeDirectory,
        encoding: "utf8",
      }).trim(),
      fixture.config.worktreeDirectory,
    );
    fixture.cleanup();
  });

  it("resolves evidence locators to exact fixture bytes and rejects hash or size mismatches", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-evidence",
      testRunId: "test-run-evidence",
      testRunManifestHash: "8".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-evidence",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const bytes = Buffer.from("real renderer evidence", "utf8");
    mkdirSync(join(fixture.config.evidenceDirectory, "screenshots"));
    writeFileSync(
      join(fixture.config.evidenceDirectory, "screenshots", "test-run.png"),
      bytes,
      { mode: 0o600 },
    );

    assert.equal(
      verifyTestEvidenceFile({
        evidenceDirectory: fixture.config.evidenceDirectory,
        locator: "screenshots/test-run.png",
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      }),
      join(fixture.config.evidenceDirectory, "screenshots", "test-run.png"),
    );
    assert.throws(
      () =>
        verifyTestEvidenceFile({
          evidenceDirectory: fixture.config.evidenceDirectory,
          locator: "screenshots/test-run.png",
          contentHash: "7".repeat(64),
          byteSize: bytes.byteLength,
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_EVIDENCE_MISMATCH",
    );
    fixture.cleanup();
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
          authorization: fixture.authorization,
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
