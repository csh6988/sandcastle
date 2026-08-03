import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ArtifactRegistry, ArtifactVersionView } from "../artifactRegistry.js";
import type { ReleaseOperationEffectRequest } from "./releaseOperationContracts.js";
import { createArtifactExportAdapter } from "./artifactExportAdapter.js";

const roots: string[] = [];
const hash = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const destination = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-release-export-"));
  roots.push(root);
  return root;
};

const request = (
  root: string,
  bytes: Buffer,
  overrides: Partial<ReleaseOperationEffectRequest & { readonly item: object }> = {},
): Extract<ReleaseOperationEffectRequest, { readonly kind: "export" }> => {
  const digest = hash(bytes);
  return {
    operationId: "release-operation-1",
    canonicalRequestHash: "a".repeat(64),
    acceptedAuthority: {
      id: "authority-1",
      candidateId: "candidate-1",
      candidateHash: "a".repeat(64),
      releaseDecisionId: "decision-1",
      releaseDecisionHash: "a".repeat(64),
      candidateInputId: "candidate-input-1",
      candidateInputHash: "a".repeat(64),
      gateAuthorityId: "gate-authority-1",
      gateAuthorityHash: "a".repeat(64),
      integrationGenerationId: "generation-1",
      integrationAuthorityHash: "a".repeat(64),
      repositoryCommits: [],
      artifactVersionIds: ["artifact-version-1"],
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      authorityHash: "a".repeat(64),
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    kind: "export",
    item: {
      id: "artifact:release-notes",
      artifactVersionId: "artifact-version-1",
      destination: {
        canonicalRoot: root,
        expectedRootState: "preexisting-local-filesystem-root",
        relativePath: "release/release-notes.md",
        overwrite: { kind: "create-only" },
      },
    },
    artifact: { contentKind: "managed-file", integrityStatus: "verified", digest },
    ...overrides,
  } as Extract<ReleaseOperationEffectRequest, { readonly kind: "export" }>;
};

const artifacts = (bytes: Buffer, overrides: Partial<ArtifactVersionView> = {}): Pick<
  ArtifactRegistry,
  "inspect" | "verify" | "readContent"
> => {
  const version: ArtifactVersionView = {
    id: "artifact-version-1",
    artifactId: "artifact-1",
    projectId: "project-1",
    type: "release-notes",
    schemaVersion: "1",
    logicalName: "release-notes",
    version: 1,
    contentRef: "managed/release-notes",
    contentHash: hash(bytes),
    byteSize: bytes.byteLength,
    contentKind: "managed-file",
    integrityStatus: "verified",
    lifecycle: "finalized",
    identityHash: "b".repeat(64),
    integrityDescriptor: {},
    status: "accepted",
    producer: {
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "node-1",
      nodeAttemptId: "attempt-1",
      aiMemberId: "member-1",
    },
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
  return {
    inspect: () => ({ version, inputs: [] }),
    verify: () => version.integrityStatus,
    readContent: () => bytes,
  };
};

describe("Artifact export release adapter", () => {
  it("exports verified managed Artifact bytes through the registry seam", async () => {
    const root = destination();
    mkdirSync(join(root, "release"));
    const bytes = Buffer.from("release notes\n");
    const result = await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).execute(
      request(root, bytes),
    );

    assert.equal(result.state, "succeeded");
    assert.deepEqual(readFileSync(join(root, "release", "release-notes.md")), bytes);
  });

  it("allows verified repository-object Artifact bytes without provider retrieval", async () => {
    const root = destination();
    const bytes = Buffer.from("repository blob\n");
    const result = await createArtifactExportAdapter({
      artifacts: artifacts(bytes, { contentKind: "repository-object" }),
    }).execute(request(root, bytes, { artifact: { contentKind: "repository-object", integrityStatus: "verified", digest: hash(bytes) } }));

    assert.equal(result.state, "succeeded");
    assert.deepEqual(readFileSync(join(root, "release", "release-notes.md")), bytes);
  });

  it("rejects external references without attempting provider retrieval", async () => {
    const root = destination();
    const bytes = Buffer.from("external");
    const result = await createArtifactExportAdapter({
      artifacts: artifacts(bytes, { contentKind: "external-reference" }),
    }).execute(request(root, bytes, { artifact: { contentKind: "managed-file", integrityStatus: "verified", digest: hash(bytes) } }));

    assert.equal(result.state, "failed");
    if (result.state === "failed") assert.equal(result.failure.code, "RELEASE_ARTIFACT_UNREADABLE");
  });

  it("rejects path traversal, Windows device paths, reserved names, and aliases canonicalized through /tmp", async () => {
    const root = destination();
    const bytes = Buffer.from("safe");
    const adapter = createArtifactExportAdapter({ artifacts: artifacts(bytes) });
    for (const relativePath of ["../escape", "a//b", "a/./b", "a\\b", "C:/escape", "\\\\server\\share", "CON", "a/file.txt:stream", "a/name. "]) {
      const result = await adapter.execute(request(root, bytes, {
        item: {
          ...request(root, bytes).item,
          destination: { ...request(root, bytes).item.destination, relativePath },
        },
      }));
      assert.equal(result.state, "failed", relativePath);
    }
    const aliased = root.replace(/^\/private\/tmp\//, "/tmp/");
    const result = await adapter.execute(request(aliased, bytes));
    assert.equal(result.state, "succeeded");
  });

  it("canonicalizes an export root before immutable intent and rejects an unprovable root", () => {
    const root = destination();
    const bytes = Buffer.from("intent-root");
    const adapter = createArtifactExportAdapter({ artifacts: artifacts(bytes) });
    const alias = root.startsWith("/private/") ? root.slice(8) : `/private${root}`;
    const intent = (canonicalRoot: string) => ({
      operationId: "release-operation-1",
      candidateId: "candidate-1",
      expectedAcceptedAuthorityHash: "a".repeat(64),
      kind: "export" as const,
      authorization: {
        actor: { type: "human" as const, id: "human-1", authenticatedBy: "local-session" as const },
        reason: "Export the accepted Artifact.",
        evidenceRefs: ["checklist:1"],
      },
      items: [{ ...request(canonicalRoot, bytes).item }],
    });
    const normalized = adapter.normalizeCreateRequest!(intent(alias));
    assert.equal(normalized.kind, "export");
    if (normalized.kind !== "export") return;
    assert.equal(normalized.items[0]?.destination.canonicalRoot, realpathSync(root));
    assert.throws(() =>
      adapter.normalizeCreateRequest!(intent(join(root, "missing"))),
    );
  });

  it("rejects symbolic-link roots, ancestors, and leaves without writing outside the root", async () => {
    const root = destination();
    const outside = destination();
    const bytes = Buffer.from("safe");
    const alias = `${root}-alias`;
    roots.push(alias);
    symlinkSync(root, alias);
    let result = await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).execute(request(alias, bytes));
    assert.equal(result.state, "failed");

    mkdirSync(join(root, "release"));
    symlinkSync(outside, join(root, "release", "linked"));
    result = await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).execute(request(root, bytes, {
      item: { ...request(root, bytes).item, destination: { ...request(root, bytes).item.destination, relativePath: "release/linked/out.md" } },
    }));
    assert.equal(result.state, "failed");
    symlinkSync(join(outside, "outside.md"), join(root, "release", "leaf.md"));
    result = await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).execute(request(root, bytes, {
      item: { ...request(root, bytes).item, destination: { ...request(root, bytes).item.destination, relativePath: "release/leaf.md" } },
    }));
    assert.equal(result.state, "destination-conflict");
    assert.equal(existsSync(join(outside, "outside.md")), false);
  });

  it("uses create-only and replace-if-exact-digest compare-and-swap policies", async () => {
    const root = destination();
    mkdirSync(join(root, "release"));
    const bytes = Buffer.from("new");
    const path = join(root, "release", "release-notes.md");
    writeFileSync(path, "old");
    const adapter = createArtifactExportAdapter({ artifacts: artifacts(bytes) });
    let result = await adapter.execute(request(root, bytes));
    assert.equal(result.state, "destination-conflict");
    result = await adapter.execute(request(root, bytes, {
      item: { ...request(root, bytes).item, destination: { ...request(root, bytes).item.destination, overwrite: { kind: "replace-if-exact-digest", expectedDestinationDigest: hash(Buffer.from("old")) } } },
    }));
    assert.equal(result.state, "succeeded");
    assert.deepEqual(readFileSync(path), bytes);
  });

  it("fails closed when bytes change between Artifact verification and reading", async () => {
    const root = destination();
    const frozen = Buffer.from("frozen");
    const result = await createArtifactExportAdapter({
      artifacts: {
        ...artifacts(frozen),
        readContent: () => Buffer.from("changed"),
      },
    }).execute(request(root, frozen));

    assert.equal(result.state, "failed");
    if (result.state === "failed") assert.equal(result.failure.code, "RELEASE_ARTIFACT_UNREADABLE");
  });

  it("leaves only an owned no-follow temporary file after a temp-fsync crash and reconciles rename and receipt crashes", async () => {
    const root = destination();
    mkdirSync(join(root, "release"));
    const bytes = Buffer.from("crash-safe");
    const operation = request(root, bytes);
    const tempCrash = await createArtifactExportAdapter({
      artifacts: artifacts(bytes),
      testOnlyCrashAt: "after-temp-fsync",
    }).execute(operation);
    assert.equal(tempCrash.state, "unknown");
    const temp = readdirSync(join(root, "release")).find((entry) => entry.includes("sandcastle-release-"));
    assert.ok(temp);
    assert.equal(lstatSync(join(root, "release", temp)).mode & 0o777, 0o600);
    assert.equal((await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).reconcile(operation, ["observation:1"])).state, "pending");

    rmSync(join(root, "release", temp));
    const renameCrash = await createArtifactExportAdapter({
      artifacts: artifacts(bytes),
      testOnlyCrashAt: "after-rename",
    }).execute(operation);
    assert.equal(renameCrash.state, "unknown");
    assert.equal((await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).reconcile(operation, ["observation:1"])).state, "succeeded");

    rmSync(join(root, "release", "release-notes.md"));
    const receiptCrash = await createArtifactExportAdapter({
      artifacts: artifacts(bytes),
      testOnlyCrashAt: "before-receipt",
    }).execute(operation);
    assert.equal(receiptCrash.state, "unknown");
    assert.equal((await createArtifactExportAdapter({ artifacts: artifacts(bytes) }).reconcile(operation, ["observation:1"])).state, "succeeded");
  });

  it("reconciles exact output, expected pre-state, and destination drift", async () => {
    const root = destination();
    mkdirSync(join(root, "release"));
    const bytes = Buffer.from("expected");
    const adapter = createArtifactExportAdapter({ artifacts: artifacts(bytes) });
    let observation = await adapter.reconcile(request(root, bytes), ["observation:1"]);
    assert.equal(observation.state, "pending");
    writeFileSync(join(root, "release", "release-notes.md"), bytes);
    observation = await adapter.reconcile(request(root, bytes), ["observation:1"]);
    assert.equal(observation.state, "succeeded");
    writeFileSync(join(root, "release", "release-notes.md"), "drift");
    observation = await adapter.reconcile(request(root, bytes), ["observation:1"]);
    assert.equal(observation.state, "destination-conflict");
  });
});
