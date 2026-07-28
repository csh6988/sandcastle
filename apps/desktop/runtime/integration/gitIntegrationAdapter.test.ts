import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GitIntegrationAdapterError,
  openLocalGitIntegrationAdapter,
} from "./gitIntegrationAdapter.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

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

describe("Local Git Integration Adapter", () => {
  it("applies exact full base-to-source tree deltas with generation-ref CAS and exact replay", () => {
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

    const first = adapter.execute(firstRequest);
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

    const second = adapter.execute(
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

    const replay = adapter.execute(
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
      adapter.reconcile(
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

  it("leaves the generation ref unchanged on conflict and protects every non-generation ref", () => {
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
    const first = adapter.execute(
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

    const conflicted = adapter.execute(
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

    assert.throws(
      () =>
        adapter.execute({
          ...request({
            root: fixture.root,
            base: fixture.base,
            sourceBranch: "work/api",
            sourceCommit: apiConflict,
            expectedTip: fixture.base,
            operationId: "protected-ref",
          }),
          integrationBranch: "main",
        }),
      (error: unknown) =>
        error instanceof GitIntegrationAdapterError &&
        error.code === "INTEGRATION_REF_INVALID",
    );
  });

  it("rejects symbolic refs, linked Worktrees, nested roots, and leaf symlink Repository paths", () => {
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
    assert.throws(
      () => adapter.execute(baseRequest),
      (error: unknown) =>
        error instanceof GitIntegrationAdapterError &&
        error.code === "INTEGRATION_REF_INVALID",
    );
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    git(
      fixture.root,
      "symbolic-ref",
      "--delete",
      "refs/heads/integration/run-1/g1",
    );

    const applied = adapter.execute(baseRequest);
    assert.equal(applied.status, "succeeded");
    if (applied.status !== "succeeded") return;
    const linked = mkdtempSync(join(tmpdir(), "sandcastle-t16-linked-"));
    roots.push(linked);
    rmSync(linked, { recursive: true, force: true });
    git(fixture.root, "worktree", "add", linked, "integration/run-1/g1");
    assert.throws(
      () =>
        adapter.execute(
          request({
            root: fixture.root,
            base: fixture.base,
            sourceBranch: "work/web",
            sourceCommit: fixture.web,
            expectedTip: applied.resultingCommit,
            operationId: "operation-checked-out",
          }),
        ),
      (error: unknown) =>
        error instanceof GitIntegrationAdapterError &&
        error.code === "INTEGRATION_REF_INVALID",
    );

    const nested = join(fixture.root, "nested");
    mkdirSync(nested);
    assert.throws(
      () =>
        adapter.execute({
          ...baseRequest,
          repositoryReference: nested,
        }),
      (error: unknown) =>
        error instanceof GitIntegrationAdapterError &&
        error.code === "INTEGRATION_REPOSITORY_INVALID",
    );
    const symlink = `${fixture.root}-symlink`;
    roots.push(symlink);
    symlinkSync(fixture.root, symlink);
    assert.throws(
      () => adapter.execute({ ...baseRequest, repositoryReference: symlink }),
      (error: unknown) =>
        error instanceof GitIntegrationAdapterError &&
        error.code === "INTEGRATION_REPOSITORY_INVALID",
    );
  });
});
