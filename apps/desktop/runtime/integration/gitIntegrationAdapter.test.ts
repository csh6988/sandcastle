import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openLocalGitIntegrationAdapter } from "./gitIntegrationAdapter.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-t16-git-"));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Integration Test");
  git(root, "config", "user.email", "integration@test.invalid");
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-c", "work/api", base);
  writeFileSync(join(root, "api.txt"), "api\n");
  git(root, "add", "api.txt");
  git(root, "commit", "-m", "api package");
  const api = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-c", "work/web", base);
  writeFileSync(join(root, "web.txt"), "web\n");
  git(root, "add", "web.txt");
  git(root, "commit", "-m", "web package");
  const web = git(root, "rev-parse", "HEAD");
  git(root, "switch", "main");
  return { root, base, api, web };
};

const request = (input: {
  readonly root: string;
  readonly base: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly expectedTip: string;
  readonly operationId: string;
}) => ({
  operationId: input.operationId,
  generationId: "generation-1",
  repositoryReference: input.root,
  integrationBranch: "integration/run-1/g1",
  baseCommit: input.base,
  sourceBranch: input.sourceBranch,
  sourceCommit: input.sourceCommit,
  expectedTip: input.expectedTip,
  requestHash: createHash("sha256").update(input.operationId).digest("hex"),
  idempotencyKey: `integration:generation-1:${input.operationId}`,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Git.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Local Git Integration Adapter", () => {
  it("does not execute Repository-local reference transaction hooks", async () => {
    const fixture = repository();
    const marker = join(fixture.root, "hook-executed");
    const hook = join(fixture.root, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`);
    chmodSync(hook, 0o755);

    const result = await openLocalGitIntegrationAdapter().execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "operation-hook-safe",
      }),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(existsSync(marker), false);
  });

  it("applies exact full base-to-source tree deltas with generation-ref CAS and exact replay", async () => {
    const fixture = repository();
    const adapter = openLocalGitIntegrationAdapter();
    const firstRequest = request({
      root: fixture.root,
      base: fixture.base,
      sourceBranch: "work/api",
      sourceCommit: fixture.api,
      expectedTip: fixture.base,
      operationId: "operation-api",
    });

    const first = await adapter.execute(firstRequest);
    assert.equal(first.status, "succeeded");
    if (first.status !== "succeeded") return;
    assert.equal(
      git(fixture.root, "rev-parse", "integration/run-1/g1"),
      first.resultingCommit,
    );
    assert.equal(
      git(fixture.root, "show", `${first.resultingCommit}:api.txt`),
      "api",
    );
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    assert.equal(git(fixture.root, "rev-parse", "work/api"), fixture.api);

    const second = await adapter.execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/web",
        sourceCommit: fixture.web,
        expectedTip: first.resultingCommit,
        operationId: "operation-web",
      }),
    );
    assert.equal(second.status, "succeeded");
    if (second.status !== "succeeded") return;
    assert.equal(
      git(fixture.root, "show", `${second.resultingCommit}:api.txt`),
      "api",
    );
    assert.equal(
      git(fixture.root, "show", `${second.resultingCommit}:web.txt`),
      "web",
    );

    const replay = await adapter.execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/web",
        sourceCommit: fixture.web,
        expectedTip: first.resultingCommit,
        operationId: "operation-web",
      }),
    );
    assert.deepEqual(replay, second);
    assert.deepEqual(
      await adapter.reconcile(
        request({
          root: fixture.root,
          base: fixture.base,
          sourceBranch: "work/web",
          sourceCommit: fixture.web,
          expectedTip: first.resultingCommit,
          operationId: "operation-web",
        }),
      ),
      second,
    );
  });

  it("leaves the generation ref unchanged on conflict and protects every non-generation ref", async () => {
    const fixture = repository();
    git(fixture.root, "switch", "work/api");
    writeFileSync(join(fixture.root, "shared.txt"), "api change\n");
    git(fixture.root, "add", "shared.txt");
    git(fixture.root, "commit", "-m", "api conflict");
    const apiConflict = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "work/web");
    writeFileSync(join(fixture.root, "shared.txt"), "web change\n");
    git(fixture.root, "add", "shared.txt");
    git(fixture.root, "commit", "-m", "web conflict");
    const webConflict = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "main");
    const adapter = openLocalGitIntegrationAdapter();
    const first = await adapter.execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: apiConflict,
        expectedTip: fixture.base,
        operationId: "operation-api-conflict",
      }),
    );
    assert.equal(first.status, "succeeded");
    if (first.status !== "succeeded") return;

    const conflicted = await adapter.execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/web",
        sourceCommit: webConflict,
        expectedTip: first.resultingCommit,
        operationId: "operation-web-conflict",
      }),
    );
    assert.equal(conflicted.status, "conflict");
    assert.equal(
      git(fixture.root, "rev-parse", "integration/run-1/g1"),
      first.resultingCommit,
    );
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    assert.equal(git(fixture.root, "rev-parse", "work/web"), webConflict);

    const protectedRef = await adapter.execute({
      ...request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: apiConflict,
        expectedTip: fixture.base,
        operationId: "protected-ref",
      }),
      integrationBranch: "main",
    });
    assert.equal(protectedRef.status, "failed");
    if (protectedRef.status !== "failed") return;
    assert.equal(protectedRef.writeStatus, "not-started");
    assert.equal(protectedRef.code, "INTEGRATION_REF_INVALID");
  });

  it("rejects symbolic refs, linked Worktrees, nested roots, and leaf symlink Repository paths", async () => {
    const fixture = repository();
    const adapter = openLocalGitIntegrationAdapter();
    const baseRequest = request({
      root: fixture.root,
      base: fixture.base,
      sourceBranch: "work/api",
      sourceCommit: fixture.api,
      expectedTip: fixture.base,
      operationId: "operation-security",
    });

    git(
      fixture.root,
      "symbolic-ref",
      "refs/heads/integration/run-1/g1",
      "refs/heads/main",
    );
    const symbolicRef = await adapter.execute(baseRequest);
    assert.equal(symbolicRef.status, "failed");
    if (symbolicRef.status !== "failed") return;
    assert.equal(symbolicRef.writeStatus, "not-started");
    assert.equal(symbolicRef.code, "INTEGRATION_REF_INVALID");
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    git(
      fixture.root,
      "symbolic-ref",
      "--delete",
      "refs/heads/integration/run-1/g1",
    );

    const applied = await adapter.execute(baseRequest);
    assert.equal(applied.status, "succeeded");
    if (applied.status !== "succeeded") return;
    const linked = mkdtempSync(join(tmpdir(), "sandcastle-t16-linked-"));
    roots.push(linked);
    rmSync(linked, { recursive: true, force: true });
    git(fixture.root, "worktree", "add", linked, "integration/run-1/g1");
    const checkedOut = await adapter.execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/web",
        sourceCommit: fixture.web,
        expectedTip: applied.resultingCommit,
        operationId: "operation-checked-out",
      }),
    );
    assert.equal(checkedOut.status, "failed");
    if (checkedOut.status !== "failed") return;
    assert.equal(checkedOut.writeStatus, "not-started");
    assert.equal(checkedOut.code, "INTEGRATION_REF_INVALID");

    const nested = join(fixture.root, "nested");
    mkdirSync(nested);
    const nestedRoot = await adapter.execute({
      ...baseRequest,
      repositoryReference: nested,
    });
    assert.equal(nestedRoot.status, "failed");
    if (nestedRoot.status !== "failed") return;
    assert.equal(nestedRoot.writeStatus, "not-started");
    assert.equal(nestedRoot.code, "INTEGRATION_REPOSITORY_INVALID");
    const symlink = `${fixture.root}-symlink`;
    roots.push(symlink);
    symlinkSync(fixture.root, symlink);
    const symlinkRoot = await adapter.execute({
      ...baseRequest,
      repositoryReference: symlink,
    });
    assert.equal(symlinkRoot.status, "failed");
    if (symlinkRoot.status !== "failed") return;
    assert.equal(symlinkRoot.writeStatus, "not-started");
    assert.equal(symlinkRoot.code, "INTEGRATION_REPOSITORY_INVALID");
  });

  it("rejects a Repository whose .git directory is a symlink without changing the target refs", async () => {
    const target = repository();
    const attacker = repository();
    rmSync(join(attacker.root, ".git"), { recursive: true, force: true });
    symlinkSync(join(target.root, ".git"), join(attacker.root, ".git"));
    assert.throws(() => git(target.root, "rev-parse", "integration/run-1/g1"));

    const result = await openLocalGitIntegrationAdapter().execute(
      request({
        root: attacker.root,
        base: target.base,
        sourceBranch: "work/api",
        sourceCommit: target.api,
        expectedTip: target.base,
        operationId: "git-directory-symlink",
      }),
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.writeStatus, "not-started");
    assert.equal(result.code, "INTEGRATION_REPOSITORY_INVALID");
    assert.throws(() => git(target.root, "rev-parse", "integration/run-1/g1"));
    assert.equal(git(target.root, "rev-parse", "main"), target.base);
    assert.equal(git(target.root, "rev-parse", "work/api"), target.api);
  });

  it("rejects nested Git refs symlinks without changing the target Repository refs", async () => {
    const target = repository();
    const attackerParent = mkdtempSync(
      join(tmpdir(), "sandcastle-t16-git-attacker-"),
    );
    roots.push(attackerParent);
    const attacker = join(attackerParent, "repository");
    execFileSync("git", ["clone", "--no-local", target.root, attacker], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const refsBefore = git(
      target.root,
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/heads",
      "refs/tags",
    );
    rmSync(join(attacker, ".git", "refs"), { recursive: true, force: true });
    symlinkSync(
      join(target.root, ".git", "refs"),
      join(attacker, ".git", "refs"),
    );

    const result = await openLocalGitIntegrationAdapter().execute(
      request({
        root: attacker,
        base: target.base,
        sourceBranch: "work/api",
        sourceCommit: target.api,
        expectedTip: target.base,
        operationId: "nested-refs-symlink",
      }),
    );

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.writeStatus, "not-started");
    assert.equal(result.code, "INTEGRATION_REPOSITORY_INVALID");
    assert.equal(
      git(
        target.root,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/heads",
        "refs/tags",
      ),
      refsBefore,
    );
    assert.throws(() => git(target.root, "rev-parse", "integration/run-1/g1"));
  });

  it(
    "revalidates target ref storage immediately before compare-and-swap",
    { skip: process.platform === "win32" },
    async () => {
      const target = repository();
      const attacker = repository();
      const wrapperRoot = mkdtempSync(
        join(tmpdir(), "sandcastle-t16-ref-swap-wrapper-"),
      );
      roots.push(wrapperRoot);
      const marker = join(wrapperRoot, "refs-swapped");
      const wrapper = join(wrapperRoot, "git-wrapper.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync("git", args, { stdio: "inherit" });
if (result.status === 0 && args.includes("commit-tree")) {
  rmSync(${JSON.stringify(join(attacker.root, ".git", "refs"))}, { recursive: true, force: true });
  symlinkSync(${JSON.stringify(join(target.root, ".git", "refs"))}, ${JSON.stringify(join(attacker.root, ".git", "refs"))});
  writeFileSync(${JSON.stringify(marker)}, "swapped\\n");
}
process.exit(result.status ?? 1);
`,
      );
      chmodSync(wrapper, 0o755);
      const refsBefore = git(
        target.root,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/heads",
        "refs/tags",
      );

      const result = await openLocalGitIntegrationAdapter({
        gitExecutable: wrapper,
      }).execute(
        request({
          root: attacker.root,
          base: attacker.base,
          sourceBranch: "work/api",
          sourceCommit: attacker.api,
          expectedTip: attacker.base,
          operationId: "ref-storage-swapped-before-cas",
        }),
      );

      assert.equal(existsSync(marker), true);
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.writeStatus, "not-started");
      assert.equal(result.code, "INTEGRATION_REPOSITORY_INVALID");
      assert.equal(
        git(
          target.root,
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          "refs/heads",
          "refs/tags",
        ),
        refsBefore,
      );
      assert.throws(() =>
        git(target.root, "rev-parse", "integration/run-1/g1"),
      );
    },
  );

  it(
    "rejects object storage symlinks before attempting any object or ref write",
    { skip: process.platform === "win32" },
    async () => {
      const target = repository();
      const attacker = repository();
      rmSync(join(attacker.root, ".git", "objects"), {
        recursive: true,
        force: true,
      });
      symlinkSync(
        join(target.root, ".git", "objects"),
        join(attacker.root, ".git", "objects"),
      );
      const wrapperRoot = mkdtempSync(
        join(tmpdir(), "sandcastle-t16-object-write-wrapper-"),
      );
      roots.push(wrapperRoot);
      const marker = join(wrapperRoot, "write-attempted");
      const wrapper = join(wrapperRoot, "git-wrapper.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (["apply", "write-tree", "commit-tree", "update-ref"].some((command) => args.includes(command))) {
  appendFileSync(${JSON.stringify(marker)}, "write\\n");
}
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      );
      chmodSync(wrapper, 0o755);

      const result = await openLocalGitIntegrationAdapter({
        gitExecutable: wrapper,
      }).execute(
        request({
          root: attacker.root,
          base: attacker.base,
          sourceBranch: "work/api",
          sourceCommit: attacker.api,
          expectedTip: attacker.base,
          operationId: "object-storage-symlink",
        }),
      );

      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.writeStatus, "not-started");
      assert.equal(result.code, "INTEGRATION_REPOSITORY_INVALID");
      assert.equal(existsSync(marker), false);
      assert.throws(() =>
        git(target.root, "rev-parse", "integration/run-1/g1"),
      );
    },
  );

  it("treats timeout and cancellation as unknown without writing the generation ref", async () => {
    const fixture = repository();
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledResult = await openLocalGitIntegrationAdapter({
      signal: cancelled.signal,
    }).execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "cancelled-operation",
      }),
    );
    assert.equal(cancelledResult.status, "unknown");
    assert.throws(() => git(fixture.root, "rev-parse", "integration/run-1/g1"));

    const timeoutResult = await openLocalGitIntegrationAdapter({
      timeoutMs: 1,
    }).execute(
      request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "timeout-operation",
      }),
    );
    assert.equal(timeoutResult.status, "unknown");
    assert.throws(() => git(fixture.root, "rev-parse", "integration/run-1/g1"));
  });

  it(
    "interrupts the exact in-flight Git child and requires reconciliation without a duplicate ref write",
    { skip: process.platform === "win32" },
    async () => {
      const fixture = repository();
      const wrapperRoot = mkdtempSync(
        join(tmpdir(), "sandcastle-t16-git-wrapper-"),
      );
      roots.push(wrapperRoot);
      const marker = join(wrapperRoot, "update-ref.marker");
      const wrapper = join(wrapperRoot, "git-wrapper.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("update-ref")) {
  appendFileSync(${JSON.stringify(marker)}, "started\\n");
  process.on("SIGTERM", () => {
    appendFileSync(${JSON.stringify(marker)}, "aborted\\n");
    process.exit(143);
  });
  setInterval(() => {}, 1_000);
} else {
  const result = spawnSync("git", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
      );
      chmodSync(wrapper, 0o755);
      const operation = request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "operation-cancel-in-flight",
      });
      const adapter = openLocalGitIntegrationAdapter({
        gitExecutable: wrapper,
        timeoutMs: 10_000,
      });

      const executing = adapter.execute(operation);
      await waitFor(() => existsSync(marker));
      await adapter.cancel?.(operation.operationId);
      const result = await executing;

      assert.equal(result.status, "unknown");
      await waitFor(() => readFileSync(marker, "utf8").includes("aborted"));
      assert.match(readFileSync(marker, "utf8"), /started\naborted/);
      assert.deepEqual(
        await openLocalGitIntegrationAdapter().reconcile(operation),
        { status: "not-applied" },
      );
      assert.throws(() =>
        git(fixture.root, "rev-parse", "integration/run-1/g1"),
      );
      assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
      assert.equal(git(fixture.root, "rev-parse", "work/api"), fixture.api);
    },
  );

  it("accepts a canonical Repository reached through a parent realpath alias and rejects Windows ref separators", async () => {
    const fixture = repository();
    const parentAlias = `${fixture.root}-parent-alias`;
    roots.push(parentAlias);
    symlinkSync(dirname(fixture.root), parentAlias);
    const aliasedRoot = join(parentAlias, basename(fixture.root));
    const result = await openLocalGitIntegrationAdapter().execute(
      request({
        root: aliasedRoot,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "realpath-alias",
      }),
    );
    assert.equal(result.status, "succeeded");

    const windowsRef = await openLocalGitIntegrationAdapter().execute({
      ...request({
        root: fixture.root,
        base: fixture.base,
        sourceBranch: "work/api",
        sourceCommit: fixture.api,
        expectedTip: fixture.base,
        operationId: "windows-ref",
      }),
      integrationBranch: "integration\\run-1\\g1",
    });
    assert.equal(windowsRef.status, "failed");
    if (windowsRef.status !== "failed") return;
    assert.equal(windowsRef.writeStatus, "not-started");
    assert.equal(windowsRef.code, "INTEGRATION_REF_INVALID");
  });
});
