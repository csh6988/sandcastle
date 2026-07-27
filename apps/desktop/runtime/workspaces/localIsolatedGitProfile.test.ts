import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openLocalIsolatedGitProfile } from "./localIsolatedGitProfile.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-t13-source-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Sandcastle Test");
  git(root, "config", "user.email", "sandcastle@example.invalid");
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const baseCommit = git(root, "rev-parse", "HEAD");
  git(root, "branch", "work/t13", baseCommit);
  return { root, baseCommit };
};

describe("Local isolated Git execution profile", () => {
  it("provisions an independent Agent-writable Git database without a host remote", () => {
    const repository = createRepository();
    const allocationRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-t13-allocation-"),
    );
    const profile = openLocalIsolatedGitProfile();

    const provisioned = profile.provision({
      allocationId: "allocation-1",
      repositoryRoot: repository.root,
      allocationRoot,
      sourceBranch: "work/t13",
      baseCommit: repository.baseCommit,
      expectedSourceTip: repository.baseCommit,
    });

    assert.deepEqual(provisioned.capabilities, {
      profileId: "local-isolated-git",
      mechanism: "private-git-bundle-import",
      mechanismVersion: "1",
      gitRefWriteIsolation: true,
      runtimeImportOnly: true,
    });
    assert.equal(
      provisioned.privateGitIdentity.baseCommit,
      repository.baseCommit,
    );
    assert.notEqual(
      provisioned.privateGitIdentity.gitCommonDirectory,
      git(repository.root, "rev-parse", "--git-common-dir"),
    );
    assert.equal(git(provisioned.executionTreePath, "remote"), "");

    writeFileSync(
      join(provisioned.executionTreePath, "README.md"),
      "agent change\n",
    );
    git(provisioned.executionTreePath, "add", "README.md");
    git(provisioned.executionTreePath, "commit", "-m", "agent change");
    const privateCommit = git(
      provisioned.executionTreePath,
      "rev-parse",
      "HEAD",
    );
    git(
      provisioned.executionTreePath,
      "update-ref",
      "refs/heads/host-only-attack",
      privateCommit,
    );

    assert.equal(
      spawnSync(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/host-only-attack"],
        { cwd: repository.root },
      ).status,
      1,
    );
    assert.equal(
      readFileSync(join(repository.root, "README.md"), "utf8"),
      "base\n",
    );
    assert.equal(
      git(repository.root, "rev-parse", "work/t13"),
      repository.baseCommit,
    );
  });

  it("imports one validated descendant with expected-tip CAS and idempotent receipt", () => {
    const repository = createRepository();
    const allocationRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-t13-import-"),
    );
    const profile = openLocalIsolatedGitProfile();
    const provisioned = profile.provision({
      allocationId: "allocation-import",
      repositoryRoot: repository.root,
      allocationRoot,
      sourceBranch: "work/t13",
      baseCommit: repository.baseCommit,
      expectedSourceTip: repository.baseCommit,
    });
    writeFileSync(join(provisioned.executionTreePath, "feature.ts"), "ok\n");
    git(provisioned.executionTreePath, "add", "feature.ts");
    git(provisioned.executionTreePath, "commit", "-m", "feature");
    const resultCommit = git(
      provisioned.executionTreePath,
      "rev-parse",
      "HEAD",
    );

    const imported = profile.importResult({
      allocation: provisioned,
      resultCommit,
      expectedSourceTip: repository.baseCommit,
    });

    assert.equal(imported.status, "imported");
    assert.equal(imported.beforeSourceTip, repository.baseCommit);
    assert.equal(imported.afterSourceTip, resultCommit);
    assert.equal(imported.resultCommit, resultCommit);
    assert.match(imported.objectSetHash, /^[a-f0-9]{64}$/);
    assert.equal(git(repository.root, "rev-parse", "work/t13"), resultCommit);
    assert.equal(
      git(repository.root, "rev-parse", "main"),
      repository.baseCommit,
    );

    const duplicate = profile.importResult({
      allocation: provisioned,
      resultCommit,
      expectedSourceTip: repository.baseCommit,
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.objectSetHash, imported.objectSetHash);

    profile.cleanup(provisioned);
    assert.equal(existsSync(provisioned.executionTreePath), false);
  });

  it("rejects path policy violations and source-tip drift without updating any ref", () => {
    const repository = createRepository();
    const allocationRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-t13-attack-"),
    );
    const profile = openLocalIsolatedGitProfile();
    const provisioned = profile.provision({
      allocationId: "allocation-attack",
      repositoryRoot: repository.root,
      allocationRoot,
      sourceBranch: "work/t13",
      baseCommit: repository.baseCommit,
      expectedSourceTip: repository.baseCommit,
    });
    symlinkSync("../../outside", join(provisioned.executionTreePath, "escape"));
    git(provisioned.executionTreePath, "add", "escape");
    git(provisioned.executionTreePath, "commit", "-m", "path attack");
    const attackCommit = git(
      provisioned.executionTreePath,
      "rev-parse",
      "HEAD",
    );

    assert.throws(
      () =>
        profile.importResult({
          allocation: provisioned,
          resultCommit: attackCommit,
          expectedSourceTip: repository.baseCommit,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "WORKSPACE_IMPORT_PATH_VIOLATION",
    );
    assert.equal(
      git(repository.root, "rev-parse", "work/t13"),
      repository.baseCommit,
    );

    git(
      repository.root,
      "update-ref",
      "refs/heads/work/t13",
      "refs/heads/main",
    );
    writeFileSync(join(repository.root, "drift.txt"), "drift\n");
    git(repository.root, "add", "drift.txt");
    git(repository.root, "commit", "-m", "source drift");
    const driftTip = git(repository.root, "rev-parse", "HEAD");
    git(repository.root, "update-ref", "refs/heads/work/t13", driftTip);

    assert.throws(
      () =>
        profile.importResult({
          allocation: provisioned,
          resultCommit: attackCommit,
          expectedSourceTip: repository.baseCommit,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INTEGRATION_CONFLICT",
    );
    assert.equal(git(repository.root, "rev-parse", "work/t13"), driftTip);
  });
});
