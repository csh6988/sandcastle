import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openLocalGitReleaseAdapter } from "./gitReleaseAdapter.js";

const roots: string[] = [];
const hash = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-t22-release-"));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release@test.invalid");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "release/source");
  writeFileSync(join(root, "source.txt"), "source\n");
  git(root, "add", "source.txt");
  git(root, "commit", "-m", "source");
  const source = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "parking", base);
  return { root, base, source };
};

const request = (fixture: ReturnType<typeof repository>) => ({
  kind: "merge" as const,
  operationId: "release-operation-1",
  canonicalRequestHash: createHash("sha256").update("release-operation-1").digest("hex"),
  acceptedAuthority: {
    id: "authority-1",
    candidateId: "candidate-1",
    candidateHash: hash,
    releaseDecisionId: "decision-1",
    releaseDecisionHash: hash,
    candidateInputId: "candidate-input-1",
    candidateInputHash: hash,
    gateAuthorityId: "gate-authority-1",
    gateAuthorityHash: hash,
    integrationGenerationId: "generation-1",
    integrationAuthorityHash: hash,
    repositoryCommits: [{ repositoryReference: fixture.root, commit: fixture.source }],
    artifactVersionIds: [],
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    authorityHash: hash,
    createdAt: "2026-08-03T00:00:00.000Z",
  },
  item: {
    id: "repository:main",
    repositoryReference: fixture.root,
    sourceCommit: fixture.source,
    destination: { targetBranch: "main", expectedTargetTip: fixture.base },
  },
});

const wrapper = (source: string): string => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-t22-release-wrapper-"));
  roots.push(root);
  const executable = join(root, "git-wrapper.mjs");
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return executable;
};

describe("Local Git Release Adapter", () => {
  it("fast-forwards the selected release target with an exact expected-tip CAS", async () => {
    const fixture = repository();

    const result = await openLocalGitReleaseAdapter().execute(request(fixture));

    assert.deepEqual(result.state, "succeeded");
    if (result.state !== "succeeded") return;
    assert.equal(result.receipt.kind, "merge");
    if (result.receipt.kind !== "merge") return;
    assert.equal(result.receipt.disposition, "applied");
    assert.equal(result.receipt.resultingTargetTip, fixture.source);
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.source);
  });

  it("treats a target already containing the exact accepted source as a no-op", async () => {
    const fixture = repository();
    git(fixture.root, "update-ref", "refs/heads/main", fixture.source, fixture.base);

    const result = await openLocalGitReleaseAdapter().execute(request(fixture));

    assert.equal(result.state, "succeeded");
    if (result.state !== "succeeded") return;
    assert.equal(result.receipt.kind, "merge");
    if (result.receipt.kind !== "merge") return;
    assert.equal(result.receipt.disposition, "no-op");
    assert.equal(result.receipt.resultingTargetTip, fixture.source);
  });

  it("rejects a selected target checked out in any worktree", async () => {
    const fixture = repository();
    git(fixture.root, "switch", "main");

    const result = await openLocalGitReleaseAdapter().execute(request(fixture));

    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.failure.code, "RELEASE_TARGET_CHECKED_OUT");
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
  });

  it("refuses a divergent source without creating a merge commit", async () => {
    const fixture = repository();
    git(fixture.root, "switch", "main");
    writeFileSync(join(fixture.root, "main.txt"), "main\n");
    git(fixture.root, "add", "main.txt");
    git(fixture.root, "commit", "-m", "main divergence");
    const divergentTarget = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "parking");

    const result = await openLocalGitReleaseAdapter().execute({
      ...request(fixture),
      item: { ...request(fixture).item, destination: { targetBranch: "main", expectedTargetTip: divergentTarget } },
    });

    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.failure.code, "RELEASE_FAST_FORWARD_REQUIRED");
    assert.equal(git(fixture.root, "rev-parse", "main"), divergentTarget);
  });

  it("reports an expected-tip CAS drift as a destination conflict", { skip: process.platform === "win32" }, async () => {
    const fixture = repository();
    git(fixture.root, "switch", "-c", "drift", fixture.base);
    writeFileSync(join(fixture.root, "drift.txt"), "drift\n");
    git(fixture.root, "add", "drift.txt");
    git(fixture.root, "commit", "-m", "drift");
    const drift = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "parking");
    const executable = wrapper(`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("update-ref")) {
  spawnSync("git", ["-C", ${JSON.stringify(fixture.root)}, "update-ref", "refs/heads/main", ${JSON.stringify(drift)}, ${JSON.stringify(fixture.base)}], { stdio: "inherit" });
}
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);

    const result = await openLocalGitReleaseAdapter({ gitExecutable: executable }).execute(request(fixture));

    assert.equal(result.state, "destination-conflict");
    assert.equal(git(fixture.root, "rev-parse", "main"), drift);
  });

  it("requires the item source to be the exact accepted authority Repository commit", async () => {
    const fixture = repository();

    const result = await openLocalGitReleaseAdapter().execute({
      ...request(fixture),
      acceptedAuthority: { ...request(fixture).acceptedAuthority, repositoryCommits: [{ repositoryReference: fixture.root, commit: fixture.base }] },
    });

    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.failure.code, "RELEASE_ARTIFACT_NOT_AUTHORIZED");
  });

  it("rejects protected integration targets and unsafe Git storage before writing", { skip: process.platform === "win32" }, async () => {
    const fixture = repository();
    const protectedTarget = await openLocalGitReleaseAdapter().execute({
      ...request(fixture),
      item: { ...request(fixture).item, destination: { targetBranch: "integration/run-1/g1", expectedTargetTip: fixture.base } },
    });
    assert.equal(protectedTarget.state, "failed");
    if (protectedTarget.state === "failed") assert.equal(protectedTarget.failure.code, "RELEASE_TARGET_INVALID");

    writeFileSync(join(fixture.root, ".git", "objects", "info", "alternates"), "/tmp/other-objects\n");
    const alternates = await openLocalGitReleaseAdapter().execute(request(fixture));
    assert.equal(alternates.state, "failed");
    if (alternates.state === "failed") assert.equal(alternates.failure.code, "RELEASE_DESTINATION_INVALID");
    rmSync(join(fixture.root, ".git", "objects", "info", "alternates"));

    writeFileSync(join(fixture.root, ".git", "commondir"), ".git\n");
    const commonDir = await openLocalGitReleaseAdapter().execute(request(fixture));
    assert.equal(commonDir.state, "failed");
    if (commonDir.state === "failed") assert.equal(commonDir.failure.code, "RELEASE_DESTINATION_INVALID");
  });

  it("rejects symbolic ref and object/ref storage leaves", { skip: process.platform === "win32" }, async () => {
    const fixture = repository();
    git(fixture.root, "symbolic-ref", "refs/heads/main", "refs/heads/parking");
    const symbolic = await openLocalGitReleaseAdapter().execute(request(fixture));
    assert.equal(symbolic.state, "failed");
    git(fixture.root, "symbolic-ref", "--delete", "refs/heads/main");
    git(fixture.root, "update-ref", "refs/heads/main", fixture.base);

    const storage = repository();
    const outside = mkdtempSync(join(tmpdir(), "sandcastle-t22-release-outside-"));
    roots.push(outside);
    rmSync(join(storage.root, ".git", "objects"), { recursive: true, force: true });
    symlinkSync(join(outside, "objects"), join(storage.root, ".git", "objects"));
    const unsafe = await openLocalGitReleaseAdapter().execute(request(storage));
    assert.equal(unsafe.state, "failed");
    if (unsafe.state === "failed") assert.equal(unsafe.failure.code, "RELEASE_DESTINATION_INVALID");
  });

  it("uses a bounded scrubbed Git environment", { skip: process.platform === "win32" }, async () => {
    const fixture = repository();
    const environmentRoot = mkdtempSync(join(tmpdir(), "sandcastle-t22-release-env-"));
    roots.push(environmentRoot);
    const observed = join(environmentRoot, "environment.json");
    const executable = wrapper(`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ secret: process.env.SANDCASTLE_T22_SECRET, global: process.env.GIT_CONFIG_GLOBAL, noSystem: process.env.GIT_CONFIG_NOSYSTEM, hooks: process.env.GIT_CONFIG_VALUE_0, prompt: process.env.GIT_TERMINAL_PROMPT, replace: process.env.GIT_NO_REPLACE_OBJECTS }));
const result = spawnSync("git", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    process.env.SANDCASTLE_T22_SECRET = "must-not-reach-git";
    try {
      await openLocalGitReleaseAdapter({ gitExecutable: executable }).execute(request(fixture));
    } finally {
      delete process.env.SANDCASTLE_T22_SECRET;
    }

    const environment = JSON.parse(readFileSync(observed, "utf8"));
    assert.equal(environment.secret, undefined);
    assert.deepEqual(environment, {
      global: "/dev/null",
      noSystem: "1",
      hooks: "/dev/null",
      prompt: "0",
      replace: "1",
    });
  });

  it("reconciles an effect completed before durable finalization without resending it", async () => {
    const fixture = repository();
    const adapter = openLocalGitReleaseAdapter();
    const operation = request(fixture);
    const effect = await adapter.execute(operation);
    assert.equal(effect.state, "succeeded");

    const observed = await adapter.reconcile(operation, []);

    assert.equal(observed.state, "succeeded");
    if (observed.state !== "succeeded") return;
    assert.equal(observed.receipt.disposition, "applied");
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.source);
  });

  it("returns unknown reconciliation when Git cannot prove a target state", async () => {
    const fixture = repository();
    const observed = await openLocalGitReleaseAdapter({ gitExecutable: join(fixture.root, "missing-git") }).reconcile(request(fixture), []);

    assert.equal(observed.state, "unknown");
  });

  it("serializes concurrent writes for one target while CAS remains authoritative", { skip: process.platform === "win32" }, async () => {
    const fixture = repository();
    const lockRoot = mkdtempSync(join(tmpdir(), "sandcastle-t22-release-lock-"));
    roots.push(lockRoot);
    const marker = join(lockRoot, "update-ref.count");
    const executable = wrapper(`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("update-ref")) {
  appendFileSync(${JSON.stringify(marker)}, "write\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    const adapter = openLocalGitReleaseAdapter({ gitExecutable: executable });
    const first = request(fixture);
    const second = { ...request(fixture), operationId: "release-operation-2" };

    const [firstResult, secondResult] = await Promise.all([adapter.execute(first), adapter.execute(second)]);

    assert.equal(firstResult.state, "succeeded");
    assert.equal(secondResult.state, "succeeded");
    assert.equal(readFileSync(marker, "utf8"), "write\n");
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.source);
    assert.equal(existsSync(marker), true);
  });
});
