import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyElectronTestFixtureExitCode,
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
  it("preserves a failed Electron fixture as a non-zero process exit", () => {
    const exits: number[] = [];
    applyElectronTestFixtureExitCode({ exit: (code) => exits.push(code) }, 1);
    applyElectronTestFixtureExitCode({ exit: (code) => exits.push(code) }, 0);
    assert.deepEqual(exits, [1, 0]);
  });

  it("binds immutable config to a fresh one-time authorization claim on every launch", () => {
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
    const firstAuthorization = fixture.authorization;
    const firstClaimPath = fixture.authorizationClaimPath;
    assert.deepEqual(
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorizationClaimPath: fixture.authorizationClaimPath,
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
          authorizationClaimPath: fixture.authorizationClaimPath,
          authorization: fixture.authorization,
          packaged: false,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
    );
    const immutableConfigHash = fixture.config.configHash;
    const restartClaim = fixture.issueAuthorizationClaim();
    assert.notEqual(restartClaim.authorization, firstAuthorization);
    assert.notEqual(restartClaim.authorizationClaimPath, firstClaimPath);
    assert.equal(fixture.config.configHash, immutableConfigHash);
    assert.equal(
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorizationClaimPath: restartClaim.authorizationClaimPath,
        authorization: restartClaim.authorization,
        packaged: false,
        entrypoint: "electron-test-fixture",
      }).configHash,
      immutableConfigHash,
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

  it("removes frozen Repository and Worktree targets before PASS and verifies their post-delete absence idempotently", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-cleanup",
      testRunId: "test-run-cleanup",
      testRunManifestHash: "8".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-cleanup",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });

    writeFileSync(
      join(fixture.config.repositoryDirectory, "runtime-created.txt"),
      "temporary Runtime output\n",
    );
    writeFileSync(
      join(fixture.config.worktreeDirectory, "agent-created.txt"),
      "temporary Agent output\n",
    );
    const receipt = fixture.cleanupExecutionResources();
    assert.deepEqual(
      receipt.targets.map((target) => [target.kind, target.state]),
      [
        ["repository", "absent"],
        ["worktree", "absent"],
      ],
    );
    assert.equal(existsSync(fixture.config.repositoryDirectory), false);
    assert.equal(existsSync(fixture.config.worktreeDirectory), false);
    assert.deepEqual(fixture.cleanupExecutionResources(), receipt);
    fixture.cleanup();
  });

  it("refuses replaced or symbolic-link cleanup targets", () => {
    for (const replacement of ["directory", "symlink"] as const) {
      const fixture = createElectronTestFixture({
        fixtureId: `fixture-cleanup-${replacement}`,
        testRunId: `test-run-cleanup-${replacement}`,
        testRunManifestHash: "7".repeat(64),
        adapters: scripts(),
        allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
        fakeClock: "2026-07-29T00:00:00.000Z",
        repeatableIdSeed: `seed-cleanup-${replacement}`,
        packaged: false,
        entrypoint: "electron-test-fixture",
      });
      rmSync(fixture.config.worktreeDirectory, { recursive: true });
      if (replacement === "directory") {
        mkdirSync(fixture.config.worktreeDirectory);
      } else {
        symlinkSync(
          fixture.config.repositoryDirectory,
          fixture.config.worktreeDirectory,
        );
      }
      assert.throws(
        () => fixture.cleanupExecutionResources(),
        (error: unknown) =>
          error instanceof ElectronTestFixtureError &&
          error.code === "FIXTURE_CLEANUP_IDENTITY_MISMATCH",
        replacement,
      );
      fixture.cleanup();
    }
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

    const verified = verifyTestEvidenceFile({
      evidenceDirectory: fixture.config.evidenceDirectory,
      locator: "screenshots/test-run.png",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    });
    assert.equal(
      verified.path,
      join(fixture.config.evidenceDirectory, "screenshots", "test-run.png"),
    );
    assert.deepEqual(verified.bytes, bytes);
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

  it("rejects symbolic links in every unresolved evidence path component", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-evidence-symlink",
      testRunId: "test-run-evidence-symlink",
      testRunManifestHash: "6".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-evidence-symlink",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const outside = mkdtempSync(join(tmpdir(), "sandcastle-evidence-outside-"));
    const outsideFile = join(outside, "capture.png");
    const bytes = Buffer.from("outside evidence", "utf8");
    writeFileSync(outsideFile, bytes, { mode: 0o600 });
    symlinkSync(
      outsideFile,
      join(fixture.config.evidenceDirectory, "final.png"),
    );
    symlinkSync(outside, join(fixture.config.evidenceDirectory, "linked"));
    for (const locator of ["final.png", "linked/capture.png"]) {
      assert.throws(
        () =>
          verifyTestEvidenceFile({
            evidenceDirectory: fixture.config.evidenceDirectory,
            locator,
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            byteSize: bytes.byteLength,
          }),
        (error: unknown) =>
          error instanceof ElectronTestFixtureError &&
          error.code === "FIXTURE_SYMLINK_FORBIDDEN",
      );
    }
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a symbolic-link fixture config before consuming authorization", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-config-symlink",
      testRunId: "test-run-config-symlink",
      testRunManifestHash: "5".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-config-symlink",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const linkedConfig = join(fixture.root, "linked-fixture.json");
    symlinkSync(fixture.configPath, linkedConfig);
    assert.throws(
      () =>
        loadElectronTestFixtureConfig({
          configPath: linkedConfig,
          authorizationClaimPath: fixture.authorizationClaimPath,
          authorization: fixture.authorization,
          packaged: false,
          entrypoint: "electron-test-fixture",
        }),
      (error: unknown) =>
        error instanceof ElectronTestFixtureError &&
        error.code === "FIXTURE_SYMLINK_FORBIDDEN",
    );
    assert.equal(existsSync(fixture.authorizationClaimPath), true);
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
          authorizationClaimPath: fixture.authorizationClaimPath,
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
