import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import {
  openReleaseOperationRuntime,
} from "./releaseOperationRuntime.js";
import type {
  AcceptedDeliveryCandidateAuthoritySnapshot,
  ReleaseOperationEffectAdapter,
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
) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  return {
    database,
    runtime: openReleaseOperationRuntime(database, {
      acceptedAuthority: () => acceptedAuthority,
      artifacts: {
        metadata: () => ({ contentKind: "managed-file", integrityStatus: "verified", digest: hash("b") }),
      },
      adapter,
      id: (() => { let value = 0; return () => `id-${++value}`; })(),
      clock: () => new Date("2026-08-03T00:00:00.000Z"),
    }),
  };
};

const mergeRequest = (operationId = "release-operation-1") => ({
  operationId,
  candidateId: authority.candidateId,
  expectedAcceptedAuthorityHash: authority.authorityHash,
  kind: "merge" as const,
  authorization: { actor: { type: "human" as const, id: "human-1", authenticatedBy: "local-session" as const }, reason: "Release the accepted candidate.", evidenceRefs: ["checklist-1"] },
  items: [{ id: "repository:api", repositoryReference: "repository:api", sourceCommit: commit("b"), destination: { targetBranch: "main", expectedTargetTip: commit("a") } }],
});

describe("ReleaseOperationRuntime", () => {
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
    const { runtime } = setup({
      execute: async () => {
        executions += 1;
        return { state: "unknown", unknown: { code: "TIMEOUT", message: "write outcome is not known", observedAt: "2026-08-03T00:00:01.000Z" } };
      },
      reconcile: async () => ({ state: "succeeded", receipt: { kind: "merge", disposition: "no-op", resultingTargetTip: commit("b"), observedAt: "2026-08-03T00:00:02.000Z" } }),
    });
    const request = mergeRequest();
    await runtime.dispatch(runtime.create(request, request.authorization.actor).id);
    const unknown = runtime.inspect(request.operationId);
    assert.equal(unknown.aggregateState, "blocked");
    assert.equal(unknown.items[0]?.evidence.length, 2);
    await runtime.reconcile({ operationId: request.operationId, itemId: "repository:api", expectedOperationHash: unknown.canonicalRequestHash, evidenceRefs: ["filesystem-observation:1"] }, request.authorization.actor);
    assert.equal(runtime.inspect(request.operationId).aggregateState, "succeeded");
    assert.equal(executions, 1);
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
