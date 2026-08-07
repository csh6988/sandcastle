import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import {
  openReleaseOperationRuntime,
  ReleaseOperationRuntimeError,
  type ReleaseOperationArtifactReader,
} from "./releaseOperationRuntime.js";
import { ReleaseOperationErrorCodeSchema } from "./releaseOperationContracts.js";
import type {
  AcceptedDeliveryCandidateAuthoritySnapshot,
  ReleaseOperationEffectAdapter,
  ReleaseOperationPersistence,
} from "./releaseOperationContracts.js";

const hash = (digit = "a"): string => digit.repeat(64);
const commit = (digit: string): string => digit.repeat(40);
const authority: AcceptedDeliveryCandidateAuthoritySnapshot = {
  id: "accepted-authority-1",
  candidateId: "candidate-1",
  candidateHash: hash(),
  releaseDecisionId: "decision-1",
  releaseDecisionHash: hash(),
  candidateInputId: "candidate-input-1",
  candidateInputHash: hash(),
  gateAuthorityId: "gate-authority-1",
  gateAuthorityHash: hash(),
  integrationGenerationId: "generation-1",
  integrationAuthorityHash: hash(),
  repositoryCommits: [{ repositoryReference: "repository:api", commit: commit("b") }],
  artifactVersionIds: ["artifact-version-1"],
  runId: "run-1",
  snapshotRevisionId: "snapshot-1",
  authorityHash: hash(),
  createdAt: "2026-08-03T00:00:00.000Z",
};

const setup = (
  adapter: ReleaseOperationEffectAdapter,
  acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshot = authority,
  artifacts: ReleaseOperationArtifactReader = {
    metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }),
  },
  persistence?: (base: ReleaseOperationPersistence) => ReleaseOperationPersistence,
) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  return {
    database,
    runtime: openReleaseOperationRuntime(database, {
      acceptedAuthority: () => acceptedAuthority,
      artifacts,
      adapter,
      id: (() => { let value = 0; return () => `id-${++value}`; })(),
      clock: () => new Date("2026-08-03T00:00:00.000Z"),
      ...(persistence ? { persistence } : {}),
    }),
  };
};

// A recording decorator over the runtime-owned base persistence: it delegates
// every call unchanged (so behavior must be identical to raw SQL) while logging
// which durable operation crossed the ReleaseOperationPersistence seam.
const recordingPersistence = (log: string[]) => (base: ReleaseOperationPersistence): ReleaseOperationPersistence => ({
  createIntent: (input) => { log.push(`createIntent:${input.id}`); return base.createIntent(input); },
  inspect: (operationId) => { log.push(`inspect:${operationId}`); return base.inspect(operationId); },
  list: (candidateId) => { log.push(`list:${candidateId}`); return base.list(candidateId); },
  finalize: (input) => { log.push(`finalize:${input.operationId}:${input.itemFinalizations.map((entry) => `${entry.itemId}=${entry.result.state}`).join(",")}`); return base.finalize(input); },
  reconcile: (input) => { log.push(`reconcile:${input.request.operationId}:${input.request.itemId}=${input.observation.state}`); return base.reconcile(input); },
});

const mergeRequest = (operationId = "release-operation-1") => ({
  operationId,
  candidateId: authority.candidateId,
  expectedAcceptedAuthorityHash: authority.authorityHash,
  kind: "merge" as const,
  authorization: { actor: { type: "human" as const, id: "human-1", authenticatedBy: "local-session" as const }, reason: "Release the accepted candidate.", evidenceRefs: ["checklist-1"] },
  items: [{ id: "repository:api", repositoryReference: "repository:api", sourceCommit: commit("b"), destination: { targetBranch: "main", expectedTargetTip: commit("a") } }],
});

const exportRequest = (operationId: string, canonicalRoot: string) => ({
  operationId,
  candidateId: authority.candidateId,
  expectedAcceptedAuthorityHash: authority.authorityHash,
  kind: "export" as const,
  authorization: { actor: { type: "human" as const, id: "human-1", authenticatedBy: "local-session" as const }, reason: "Export the accepted Artifact.", evidenceRefs: ["checklist-1"] },
  items: [{ id: "artifact:release-notes", artifactVersionId: "artifact-version-1", destination: { canonicalRoot, expectedRootState: "preexisting-local-filesystem-root" as const, relativePath: "release-notes.md", overwrite: { kind: "create-only" as const } }}],
});

describe("ReleaseOperationRuntime", () => {
  it("fails closed before intent when an export adapter cannot normalize its destination", () => {
    const { database, runtime } = setup({
      execute: async () => ({
        state: "unknown",
        unknown: {
          code: "never",
          message: "never",
          observedAt: "2026-08-03T00:00:01.000Z",
        },
      }),
      reconcile: async () => ({ state: "pending" }),
    });
    const input = exportRequest("release-operation-without-normalizer", "/tmp/release");

    assert.throws(
      () => runtime.create(input, input.authorization.actor),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "RELEASE_DESTINATION_INVALID",
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM release_operations")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM release_operation_destination_claims",
          )
          .get() as { readonly count: number }
      ).count,
      0,
    );

    const merge = mergeRequest("release-operation-merge-without-normalizer");
    assert.equal(
      runtime.create(merge, merge.authorization.actor).id,
      merge.operationId,
    );
  });

  it("durably fails an export whose Artifact preparation rejects before any effect", async () => {
    let executions = 0;
    const { runtime } = setup(
      {
        normalizeCreateRequest: (request) => request,
        execute: async () => {
          executions += 1;
          return { state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } };
        },
        reconcile: async () => ({ state: "pending" }),
      },
      authority,
      { metadata: () => { throw new Error("Artifact Registry unavailable"); } },
    );
    const input = exportRequest("release-operation-preparation-failure", "/tmp/release");
    const view = await runtime.dispatch(runtime.create(input, input.authorization.actor).id);
    assert.equal(view.aggregateState, "failed");
    assert.equal(view.items[0]?.state, "failed");
    assert.equal(executions, 0);
  });

  it("freezes normalized export identity before its immutable intent and destination claim", () => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-release-runtime-"));
    try {
      const canonicalRoot = realpathSync(root);
      const alias = canonicalRoot.startsWith("/private/") ? canonicalRoot.slice(8) : `/private${canonicalRoot}`;
      const { runtime } = setup({
        normalizeCreateRequest: (request) =>
          request.kind === "export"
            ? { ...request, items: request.items.map((item) => ({ ...item, destination: { ...item.destination, canonicalRoot } })) }
            : request,
        execute: async () => ({ state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } }),
        reconcile: async () => ({ state: "pending" }),
      });
      const created = runtime.create(exportRequest("release-operation-1", alias), exportRequest("release-operation-1", alias).authorization.actor);
      assert.equal(created.request.kind, "export");
      if (created.request.kind !== "export") return;
      assert.equal(created.request.items[0]?.destination.canonicalRoot, canonicalRoot);
      assert.throws(
        () => runtime.create(exportRequest("release-operation-2", canonicalRoot), exportRequest("release-operation-2", canonicalRoot).authorization.actor),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_DESTINATION_CONFLICT",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists immutable intent before a deterministic external effect", async () => {
    const calls: string[] = [];
    const { runtime } = setup({
      execute: async (request) => {
        calls.push(request.item.id);
        return { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => ({ state: "pending" }),
    });
    const request = mergeRequest();

    const created = runtime.create(request, request.authorization.actor);
    assert.equal(created.aggregateState, "pending");
    assert.deepEqual(calls, []);
    const completed = await runtime.dispatch(created.id);
    assert.equal(completed.aggregateState, "succeeded");
    assert.deepEqual(calls, ["repository:api"]);
  });

  it("joins an existing Command transaction without committing it", () => {
    const { database, runtime } = setup({
      execute: async () => ({ state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } }),
      reconcile: async () => ({ state: "pending" }),
    });
    const request = mergeRequest();

    database.exec("BEGIN IMMEDIATE");
    runtime.create(request, request.authorization.actor);
    database.exec("ROLLBACK");

    assert.throws(
      () => runtime.inspect(request.operationId),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_OPERATION_NOT_FOUND",
    );
  });

  it("rejects changed authority or changed input under an existing operation identity", () => {
    const { runtime } = setup({
      execute: async () => ({ state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } }),
      reconcile: async () => ({ state: "pending" }),
    });
    const request = mergeRequest();
    runtime.create(request, request.authorization.actor);
    assert.equal(runtime.create(request, request.authorization.actor).id, request.operationId);
    assert.throws(
      () => runtime.create({ ...request, authorization: { ...request.authorization, reason: "Changed authorization." } }, request.authorization.actor),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_OPERATION_ID_REUSE",
    );
    assert.throws(
      () => runtime.create({ ...request, operationId: "operation-wrong-authority", expectedAcceptedAuthorityHash: hash("c") }, request.authorization.actor),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_AUTHORITY_CONFLICT",
    );
  });

  it("stops at unknown, stores append-only evidence in the view, and requires human reconciliation", async () => {
    let executions = 0;
    let database!: DatabaseSync;
    const configured = setup({
      execute: async () => {
        executions += 1;
        return { state: "unknown", unknown: { code: "TIMEOUT", message: "write outcome is not known", observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => {
        const intent = database.prepare(
          "SELECT observation_json AS observationJson FROM release_operation_reconciliations ORDER BY created_at, id LIMIT 1",
        ).get() as { readonly observationJson: string } | undefined;
        assert.deepEqual(JSON.parse(intent?.observationJson ?? "null"), {
          phase: "intent",
          evidenceRefs: ["filesystem-observation:1"],
        });
        database.exec("BEGIN IMMEDIATE");
        database.exec("ROLLBACK");
        return { state: "succeeded", receipt: { kind: "merge", disposition: "no-op", resultingTargetTip: commit("b"), observedAt: "2026-08-03T00:00:02.000Z" } };
      },
    });
    database = configured.database;
    const { runtime } = configured;
    const request = mergeRequest();
    await runtime.dispatch(runtime.create(request, request.authorization.actor).id);
    const unknown = runtime.inspect(request.operationId);
    assert.equal(unknown.aggregateState, "blocked");
    assert.equal(unknown.items[0]?.evidence.length, 2);
    await runtime.reconcile({ operationId: request.operationId, itemId: "repository:api", expectedOperationHash: unknown.canonicalRequestHash, evidenceRefs: ["filesystem-observation:1"] }, request.authorization.actor);
    assert.equal(runtime.inspect(request.operationId).aggregateState, "succeeded");
    assert.equal(executions, 1);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM release_operation_reconciliations").get() as { readonly count: number }).count,
      2,
    );
  });

  it("retains committed intent across a crash before dispatch and does not duplicate an effect after an effect-before-finalize crash", async () => {
    let firstExecutions = 0;
    const adapter: ReleaseOperationEffectAdapter = {
      execute: async () => {
        firstExecutions += 1;
        return { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => ({ state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:02.000Z" } }),
    };
    const { database } = setup(adapter);
    const crashing = openReleaseOperationRuntime(database, {
      acceptedAuthority: () => authority,
      artifacts: { metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }) },
      adapter,
      failureInjection: (point) => { if (point === "after-effect-before-finalize") throw new Error("crash"); },
    });
    const request = mergeRequest();
    crashing.create(request, request.authorization.actor);
    await assert.rejects(crashing.dispatch(request.operationId), /crash/);
    const restarted = openReleaseOperationRuntime(database, {
      acceptedAuthority: () => authority,
      artifacts: { metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }) },
      adapter,
    });
    await restarted.reconcilePending();
    assert.equal(restarted.inspect(request.operationId).aggregateState, "succeeded");
    assert.equal(firstExecutions, 1);
  });

  it("fences a second operation from claiming the same destination", () => {
    const { runtime } = setup({
      execute: async () => ({ state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } }),
      reconcile: async () => ({ state: "pending" }),
    });
    const request = mergeRequest();
    runtime.create(request, request.authorization.actor);
    assert.throws(
      () => runtime.create(mergeRequest("release-operation-2"), request.authorization.actor),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_DESTINATION_CONFLICT",
    );
  });

  it("serializes every item by frozen ordinal and continues after a known partial failure", async () => {
    const acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshot = {
      ...authority,
      repositoryCommits: [
        { repositoryReference: "repository:api", commit: commit("b") },
        { repositoryReference: "repository:web", commit: commit("d") },
      ],
    };
    const executed: string[] = [];
    const { runtime } = setup(
      {
        execute: async (effect) => {
          executed.push(effect.item.id);
          return effect.item.id === "repository:api"
            ? { state: "failed", failure: { code: "PREWRITE_REJECTED", message: "branch policy rejected", observedAt: "2026-08-03T00:00:01.000Z" } }
            : { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("e"), observedAt: "2026-08-03T00:00:02.000Z" } };
        },
        reconcile: async () => ({ state: "pending" }),
      },
      acceptedAuthority,
    );
    const request = {
      ...mergeRequest(),
      items: [
        { id: "repository:api", repositoryReference: "repository:api", sourceCommit: commit("b"), destination: { targetBranch: "main", expectedTargetTip: commit("a") } },
        { id: "repository:web", repositoryReference: "repository:web", sourceCommit: commit("d"), destination: { targetBranch: "main", expectedTargetTip: commit("c") } },
      ],
    };
    const view = await runtime.dispatch(runtime.create(request, request.authorization.actor).id);
    assert.deepEqual(executed, ["repository:api", "repository:web"]);
    assert.equal(view.aggregateState, "partially-succeeded");
    assert.deepEqual(view.nextActions, ["create-new-operation"]);
  });
});

describe("ReleaseOperationRuntime persistence seam (T27 D1)", () => {
  it("routes every durable state transition through the injected ReleaseOperationPersistence", async () => {
    const log: string[] = [];
    const { runtime } = setup(
      {
        execute: async () => ({ state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:01.000Z" } }),
        reconcile: async () => ({ state: "pending" }),
      },
      authority,
      undefined,
      recordingPersistence(log),
    );
    const request = mergeRequest();

    const created = runtime.create(request, request.authorization.actor);
    assert.equal(created.aggregateState, "pending");
    const completed = await runtime.dispatch(created.id);
    assert.equal(completed.aggregateState, "succeeded");
    runtime.list(request.candidateId);

    // The durable lifecycle — intent creation, terminal finalize, and read
    // projections — must be observable at the persistence seam, proving the
    // runtime delegates rather than issuing its own raw SQL for these.
    assert.ok(log.some((entry) => entry === `createIntent:${request.operationId}`), `expected createIntent, saw ${JSON.stringify(log)}`);
    assert.ok(log.some((entry) => entry.startsWith(`finalize:${request.operationId}:repository:api=succeeded`)), `expected terminal finalize, saw ${JSON.stringify(log)}`);
    assert.ok(log.some((entry) => entry === `list:${request.candidateId}`), `expected list, saw ${JSON.stringify(log)}`);
  });

  it("preserves behavior identically when persistence is decorated (idempotent create, ID reuse, terminal aggregate)", async () => {
    const log: string[] = [];
    const { runtime } = setup(
      {
        execute: async () => ({ state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:01.000Z" } }),
        reconcile: async () => ({ state: "pending" }),
      },
      authority,
      undefined,
      recordingPersistence(log),
    );
    const request = mergeRequest();

    // Idempotent create returns the same operation identity, unchanged.
    const first = runtime.create(request, request.authorization.actor);
    assert.equal(runtime.create(request, request.authorization.actor).id, first.id);
    // Divergent canonical request under the same identity still fails closed.
    assert.throws(
      () => runtime.create({ ...request, authorization: { ...request.authorization, reason: "Changed authorization." } }, request.authorization.actor),
      (error: unknown) => error instanceof ReleaseOperationRuntimeError && error.code === "RELEASE_OPERATION_ID_REUSE",
    );
    const completed = await runtime.dispatch(first.id);
    assert.equal(completed.aggregateState, "succeeded");
    assert.equal(completed.items[0]?.state, "succeeded");
  });

  it("rolls the seam back with the enclosing Command transaction (no partial durable intent)", () => {
    const log: string[] = [];
    const { database, runtime } = setup(
      {
        execute: async () => ({ state: "unknown", unknown: { code: "never", message: "never", observedAt: "2026-08-03T00:00:01.000Z" } }),
        reconcile: async () => ({ state: "pending" }),
      },
      authority,
      undefined,
      recordingPersistence(log),
    );
    const request = mergeRequest();

    database.exec("BEGIN IMMEDIATE");
    runtime.create(request, request.authorization.actor);
    database.exec("ROLLBACK");

    // createIntent must have crossed the seam, yet its writes are discarded with
    // the outer transaction — the persistence facade never commits on its own.
    assert.ok(log.includes(`createIntent:${request.operationId}`));
    assert.throws(
      () => runtime.inspect(request.operationId),
      (error: unknown) => error instanceof ReleaseOperationRuntimeError && error.code === "RELEASE_OPERATION_NOT_FOUND",
    );
  });
});

describe("ReleaseOperationRuntime error-code surface (T27 D1)", () => {
  it("types the runtime error code from the frozen ReleaseOperationErrorCode enum", () => {
    // Every code the runtime can throw must be a member of the single-source-of-
    // truth contract enum; this pins the alignment so the two cannot drift.
    const thrown = new ReleaseOperationRuntimeError("RELEASE_OPERATION_NOT_FOUND", "probe");
    assert.equal(ReleaseOperationErrorCodeSchema.parse(thrown.code), "RELEASE_OPERATION_NOT_FOUND");
  });

  it("keeps adapter-level target/fast-forward codes representable on the aligned surface", () => {
    // RELEASE_TARGET_INVALID / _CHECKED_OUT / _FAST_FORWARD_REQUIRED are adapter
    // Item failures; after alignment they remain valid members of the same enum
    // that types the runtime error surface, so failure and thrown codes are one set.
    for (const code of ["RELEASE_TARGET_INVALID", "RELEASE_TARGET_CHECKED_OUT", "RELEASE_FAST_FORWARD_REQUIRED"] as const) {
      assert.equal(ReleaseOperationErrorCodeSchema.parse(code), code);
    }
  });
});

describe("ReleaseOperationRuntime reconcile/claim edges (T27 D2)", () => {
  it("stops the serial worker at the first unknown item and leaves later items pending", async () => {
    const acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshot = {
      ...authority,
      repositoryCommits: [
        { repositoryReference: "repository:api", commit: commit("b") },
        { repositoryReference: "repository:web", commit: commit("d") },
      ],
    };
    const executed: string[] = [];
    const { runtime } = setup(
      {
        execute: async (effect) => {
          executed.push(effect.item.id);
          return effect.item.id === "repository:api"
            ? { state: "unknown", unknown: { code: "TIMEOUT", message: "write outcome is not known", observedAt: "2026-08-03T00:00:01.000Z" } }
            : { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("e"), observedAt: "2026-08-03T00:00:02.000Z" } };
        },
        reconcile: async () => ({ state: "pending" }),
      },
      acceptedAuthority,
    );
    const request = {
      ...mergeRequest(),
      items: [
        { id: "repository:api", repositoryReference: "repository:api", sourceCommit: commit("b"), destination: { targetBranch: "main", expectedTargetTip: commit("a") } },
        { id: "repository:web", repositoryReference: "repository:web", sourceCommit: commit("d"), destination: { targetBranch: "main", expectedTargetTip: commit("c") } },
      ],
    };

    const view = await runtime.dispatch(runtime.create(request, request.authorization.actor).id);

    // The first item's unknown outcome halts the serial worker: the second item
    // is never executed and stays pending, and the aggregate is blocked so the
    // only forward move is a verified-human reconciliation.
    assert.deepEqual(executed, ["repository:api"]);
    assert.equal(view.aggregateState, "blocked");
    assert.equal(view.items[0]?.state, "unknown");
    assert.equal(view.items[1]?.state, "pending");
    assert.equal(view.counts.unknown, 1);
    assert.equal(view.counts.pending, 1);
    assert.deepEqual(view.nextActions, ["reconcile"]);
  });

  it("treats an adapter-reported destination conflict as terminal, remediated only by a new operation with no resend or rollback", async () => {
    let executions = 0;
    let reconciliations = 0;
    const { database, runtime } = setup({
      execute: async () => {
        executions += 1;
        return {
          state: "destination-conflict",
          conflict: {
            code: "RELEASE_DESTINATION_CONFLICT",
            message: "the Release target changed during its expected-tip compare-and-swap",
            observedDestinationState: { observedTargetTip: commit("f") },
            observedAt: "2026-08-03T00:00:01.000Z",
          },
        };
      },
      reconcile: async () => {
        reconciliations += 1;
        return { state: "pending" };
      },
    });
    const request = mergeRequest();

    const view = await runtime.dispatch(runtime.create(request, request.authorization.actor).id);

    // Destination drift is terminal: the item is a destination conflict, the only
    // remediation offered is a brand-new operation (never reconcile), and the
    // effect is neither rolled back nor resent — execute ran exactly once and the
    // observe-only reconcile path was never entered.
    assert.equal(view.items[0]?.state, "destination-conflict");
    assert.equal(view.counts.destinationConflict, 1);
    assert.equal(view.aggregateState, "failed");
    assert.deepEqual(view.nextActions, ["create-new-operation"]);
    assert.equal(view.items[0]?.receipt, null);
    assert.equal(executions, 1);
    assert.equal(reconciliations, 0);
    // The fenced destination claim is released so no phantom hold survives, yet
    // remediation is still a new operation rather than a retry of this one.
    assert.equal(
      (
        database
          .prepare("SELECT is_active AS isActive FROM release_operation_destination_claims WHERE operation_id = ?")
          .get(request.operationId) as { readonly isActive: number }
      ).isActive,
      0,
    );
  });

  it("resumes a crashed in-flight item by reconciling, never by re-executing the effect", async () => {
    let executions = 0;
    let reconciliations = 0;
    const adapter: ReleaseOperationEffectAdapter = {
      execute: async () => {
        executions += 1;
        return { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => {
        reconciliations += 1;
        return { state: "succeeded", receipt: { kind: "merge", disposition: "applied", resultingTargetTip: commit("c"), observedAt: "2026-08-03T00:00:02.000Z" } };
      },
    };
    const { database } = setup(adapter);
    const crashing = openReleaseOperationRuntime(database, {
      acceptedAuthority: () => authority,
      artifacts: { metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }) },
      adapter,
      failureInjection: (point) => { if (point === "after-effect-before-finalize") throw new Error("crash"); },
    });
    const request = mergeRequest();
    crashing.create(request, request.authorization.actor);
    await assert.rejects(crashing.dispatch(request.operationId), /crash/);
    assert.equal(executions, 1);

    // A fresh runtime with no crash injection resumes the in-flight item. It must
    // OBSERVE via reconcile rather than re-run execute, so the external effect is
    // applied at most once even though finalize never committed pre-crash.
    const restarted = openReleaseOperationRuntime(database, {
      acceptedAuthority: () => authority,
      artifacts: { metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }) },
      adapter,
    });
    await restarted.reconcilePending();
    assert.equal(restarted.inspect(request.operationId).aggregateState, "succeeded");
    assert.equal(executions, 1);
    assert.equal(reconciliations, 1);
  });

  it("never auto-resends or auto-reconciles a blocked unknown item during the resume sweep", async () => {
    let executions = 0;
    let reconciliations = 0;
    const adapter: ReleaseOperationEffectAdapter = {
      execute: async () => {
        executions += 1;
        return { state: "unknown", unknown: { code: "TIMEOUT", message: "write outcome is not known", observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => {
        reconciliations += 1;
        return { state: "succeeded", receipt: { kind: "merge", disposition: "no-op", resultingTargetTip: commit("b"), observedAt: "2026-08-03T00:00:02.000Z" } };
      },
    };
    const { runtime } = setup(adapter);
    const request = mergeRequest();
    await runtime.dispatch(runtime.create(request, request.authorization.actor).id);
    assert.equal(runtime.inspect(request.operationId).aggregateState, "blocked");
    assert.equal(executions, 1);

    // The resume sweep only reconciles pending/running/reconciling aggregates. A
    // blocked unknown item is human-gated, so the sweep must skip it entirely:
    // neither the effect nor the observe path fires until a verified human
    // explicitly reconciles.
    const swept = await runtime.reconcilePending();
    assert.ok(!swept.some((view) => view.id === request.operationId));
    assert.equal(executions, 1);
    assert.equal(reconciliations, 0);
    assert.equal(runtime.inspect(request.operationId).aggregateState, "blocked");
  });
});
