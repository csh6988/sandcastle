import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
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
  electronTestFixtureRuntimePrincipal,
  ElectronTestFixtureError,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
  verifyTestEvidenceFile,
} from "./electronTestFixture.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const waitForChildReady = async (
  source: string,
  args: readonly string[],
): Promise<ReturnType<typeof spawn>> => {
  const child = spawn(process.execPath, ["-e", source, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout!, "data");
  return child;
};

const waitForChildExit = async (
  child: ReturnType<typeof spawn>,
): Promise<void> => {
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
};

const startReplacementAfterRename = async (
  target: string,
  marker: string,
): Promise<ReturnType<typeof spawn>> =>
  waitForChildReady(
    `
      const { lstatSync, mkdirSync, writeFileSync } = require("node:fs");
      const [target, marker] = process.argv.slice(1);
      process.stdout.write("ready\\n");
      for (;;) {
        try {
          lstatSync(target);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          mkdirSync(target);
          writeFileSync(marker, "replacement\\n");
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    `,
    [target, marker],
  );

const startRepeatedSymlinkSwap = async (
  target: string,
  outside: string,
): Promise<ReturnType<typeof spawn>> =>
  waitForChildReady(
    `
      const { renameSync, symlinkSync, unlinkSync } = require("node:fs");
      const [target, outside] = process.argv.slice(1);
      const parked = target + ".parked";
      const pause = () => Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1
      );
      process.stdout.write("ready\\n");
      for (let index = 0; index < 200; index += 1) {
        renameSync(target, parked);
        symlinkSync(outside, target);
        pause();
        unlinkSync(target);
        renameSync(parked, target);
        pause();
      }
    `,
    [target, outside],
  );

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

const cleanupTargetPath = (
  fixture: ReturnType<typeof createElectronTestFixture>,
  kind: "repository" | "worktree",
): string => {
  const target = fixture.config.cleanupTargets.find(
    (candidate) => candidate.kind === kind,
  );
  assert.ok(target);
  return target.path;
};

describe("Electron Test fixture", () => {
  it("authenticates fixture Runtime commands as a Runtime worker", () => {
    assert.deepEqual(electronTestFixtureRuntimePrincipal, {
      type: "runtime-worker",
      id: "electron-test-fixture",
      authenticatedBy: "runtime",
    });
  });

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

  it("removes only frozen execution Repository and Worktree targets before PASS and preserves catalog resources until final cleanup", () => {
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

    const executionRepository = fixture.config.cleanupTargets.find(
      (target) => target.kind === "repository",
    );
    const executionWorktree = fixture.config.cleanupTargets.find(
      (target) => target.kind === "worktree",
    );
    assert.ok(executionRepository);
    assert.ok(executionWorktree);
    assert.notEqual(
      executionRepository.path,
      fixture.config.repositoryDirectory,
    );
    assert.notEqual(executionWorktree.path, fixture.config.worktreeDirectory);
    writeFileSync(
      join(executionRepository.path, "runtime-created.txt"),
      "temporary Runtime output\n",
    );
    writeFileSync(
      join(executionWorktree.path, "agent-created.txt"),
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
    assert.equal(existsSync(executionRepository.path), false);
    assert.equal(existsSync(executionWorktree.path), false);
    assert.equal(existsSync(fixture.config.repositoryDirectory), true);
    assert.equal(existsSync(fixture.config.worktreeDirectory), true);
    assert.deepEqual(fixture.cleanupExecutionResources(), receipt);
    fixture.cleanup();
    assert.equal(existsSync(fixture.root), false);
  });

  it("refuses an initially missing cleanup target without caching an absent receipt", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-cleanup-missing",
      testRunId: "test-run-cleanup-missing",
      testRunManifestHash: "8".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-cleanup-missing",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    rmSync(cleanupTargetPath(fixture, "worktree"), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => fixture.cleanupExecutionResources(),
        (error: unknown) =>
          error instanceof ElectronTestFixtureError &&
          error.code === "FIXTURE_CLEANUP_IDENTITY_MISMATCH",
      );
    }
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
      const cleanupWorktree = cleanupTargetPath(fixture, "worktree");
      rmSync(cleanupWorktree, { recursive: true });
      if (replacement === "directory") {
        mkdirSync(cleanupWorktree);
      } else {
        symlinkSync(cleanupTargetPath(fixture, "repository"), cleanupWorktree);
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

  it("deletes only quarantined execution resources when the original path is replaced after rename", async () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-cleanup-rename-race",
      testRunId: "test-run-cleanup-rename-race",
      testRunManifestHash: "7".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-cleanup-rename-race",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(
        join(
          cleanupTargetPath(fixture, "worktree"),
          `slow-delete-${index}.txt`,
        ),
        "fixture cleanup race\n",
      );
    }
    const cleanupWorktree = cleanupTargetPath(fixture, "worktree");
    const replacementMarker = join(cleanupWorktree, "replacement.txt");
    const replacement = await startReplacementAfterRename(
      cleanupWorktree,
      replacementMarker,
    );

    fixture.cleanupExecutionResources();

    assert.equal(existsSync(replacementMarker), true);
    await waitForChildExit(replacement);
    assert.equal(readFileSync(replacementMarker, "utf8"), "replacement\n");
    fixture.cleanup();
  });

  it("deletes only the quarantined fixture root when its original path is replaced after rename", async () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-root-rename-race",
      testRunId: "test-run-root-rename-race",
      testRunManifestHash: "7".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-root-rename-race",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(
        join(fixture.config.evidenceDirectory, `slow-delete-${index}.txt`),
        "fixture root cleanup race\n",
      );
    }
    const replacementMarker = join(fixture.root, "replacement.txt");
    const replacement = await startReplacementAfterRename(
      fixture.root,
      replacementMarker,
    );

    fixture.cleanup();

    assert.equal(existsSync(replacementMarker), true);
    await waitForChildExit(replacement);
    assert.equal(readFileSync(replacementMarker, "utf8"), "replacement\n");
    rmSync(fixture.root, { recursive: true });
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

  it("fails closed when descriptor-relative Python capabilities are unavailable", () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-evidence-capability-missing",
      testRunId: "test-run-evidence-capability-missing",
      testRunManifestHash: "6".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-evidence-capability-missing",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const bytes = Buffer.from("frozen fixture evidence", "utf8");
    writeFileSync(
      join(fixture.config.evidenceDirectory, "capture.png"),
      bytes,
      {
        mode: 0o600,
      },
    );

    for (const capability of ["O_NOFOLLOW", "O_DIRECTORY", "dir_fd"] as const) {
      assert.throws(
        () =>
          verifyTestEvidenceFile({
            evidenceDirectory: fixture.config.evidenceDirectory,
            locator: "capture.png",
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            byteSize: bytes.byteLength,
            testOnlyMissingDescriptorRelativeCapability: capability,
          }),
        (error: unknown) =>
          error instanceof ElectronTestFixtureError &&
          error.code === "FIXTURE_DESCRIPTOR_RELATIVE_UNAVAILABLE",
        capability,
      );
    }
    fixture.cleanup();
  });

  it("holds ancestor descriptors across a coordinated rename, symlink, and restore attack", () => {
    if (process.platform === "win32") return;
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-evidence-held-ancestor",
      testRunId: "test-run-evidence-held-ancestor",
      testRunManifestHash: "6".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-evidence-held-ancestor",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const outside = mkdtempSync(join(tmpdir(), "sandcastle-evidence-held-"));
    const safeBytes = Buffer.from("held safe evidence", "utf8");
    const outsideBytes = Buffer.from("outside replacement evidence", "utf8");
    const ancestor = join(fixture.config.evidenceDirectory, "screenshots");
    const parked = `${ancestor}.parked`;
    const outsideAncestor = join(outside, "screenshots");
    mkdirSync(ancestor);
    mkdirSync(outsideAncestor);
    writeFileSync(join(ancestor, "capture.png"), safeBytes, { mode: 0o600 });
    writeFileSync(join(outsideAncestor, "capture.png"), outsideBytes, {
      mode: 0o600,
    });
    try {
      const verified = verifyTestEvidenceFile({
        evidenceDirectory: fixture.config.evidenceDirectory,
        locator: "screenshots/capture.png",
        contentHash: createHash("sha256").update(safeBytes).digest("hex"),
        byteSize: safeBytes.byteLength,
        testOnlyAncestorSwap: {
          target: ancestor,
          parked,
          outside: outsideAncestor,
        },
      });
      assert.deepEqual(verified.bytes, safeBytes);
      assert.equal(lstatSync(ancestor).isSymbolicLink(), false);
      assert.equal(existsSync(parked), false);
    } finally {
      fixture.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never accepts outside evidence during repeated ancestor or leaf symlink replacement", async () => {
    const fixture = createElectronTestFixture({
      fixtureId: "fixture-evidence-symlink-race",
      testRunId: "test-run-evidence-symlink-race",
      testRunManifestHash: "6".repeat(64),
      adapters: scripts(),
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "seed-evidence-symlink-race",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    const outside = mkdtempSync(join(tmpdir(), "sandcastle-evidence-race-"));
    const outsideBytes = Buffer.from(
      "outside evidence must never pass",
      "utf8",
    );
    const safeBytes = Buffer.from("frozen fixture evidence", "utf8");
    const ancestor = join(fixture.config.evidenceDirectory, "screenshots");
    const outsideAncestor = join(outside, "screenshots");
    mkdirSync(ancestor);
    mkdirSync(outsideAncestor);
    const safeLeaf = join(ancestor, "capture.png");
    const outsideLeaf = join(outsideAncestor, "capture.png");
    writeFileSync(safeLeaf, safeBytes, { mode: 0o600 });
    writeFileSync(outsideLeaf, outsideBytes, { mode: 0o600 });

    for (const [target, replacement] of [
      [ancestor, outsideAncestor],
      [safeLeaf, outsideLeaf],
    ] as const) {
      const swap = await startRepeatedSymlinkSwap(target, replacement);
      let acceptedOutside = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          const verified = verifyTestEvidenceFile({
            evidenceDirectory: fixture.config.evidenceDirectory,
            locator: "screenshots/capture.png",
            contentHash: sha256(outsideBytes.toString("utf8")),
            byteSize: outsideBytes.byteLength,
          });
          acceptedOutside ||= verified.bytes.equals(outsideBytes);
        } catch (error) {
          assert.equal(error instanceof ElectronTestFixtureError, true);
        }
      }
      await waitForChildExit(swap);
      assert.equal(acceptedOutside, false);
      assert.equal(lstatSync(target).isSymbolicLink(), false);
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
