import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { companyRuntimeAddress } from "./address.js";
import {
  createCompanyRuntimeClientFromTransport,
  createLocalRuntimeTransport,
  RuntimeClientError,
} from "./client.js";
import { RuntimeRequestSchema } from "./interface.js";
import {
  prepareCompanyRuntimeStartup,
  startCompanyRuntimeServer,
} from "./server.js";
import type { CompanyDatabase } from "./storage/sqlite.js";

const roots: string[] = [];
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};
const canonicalHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

const captureDeterministicTestRevision = async (
  clock: string,
  seed: string,
): Promise<{
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly effectIds: readonly string[];
}> => {
  const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-server-clock-"));
  roots.push(companyDir);
  let counter = 0;
  let captured:
    | {
        readonly manifestHash: string;
        readonly createdAt: string;
        readonly effectIds: readonly string[];
      }
    | undefined;
  const electronInput = { kind: "electron" };
  const cleanupInput = {
    fixtureId: "fixture-1",
    rootFingerprint: "c".repeat(64),
  };
  const server = await startCompanyRuntimeServer({
    address: companyRuntimeAddress(companyDir),
    companyDir,
    token: "server-test-token",
    testBuildFixture: {
      clock: () => new Date(clock),
      nextId: () => `${seed}:${String(++counter).padStart(4, "0")}`,
      fixtureAuthority: {
        read: () => {
          throw new Error("unused");
        },
      },
      setup: (database) => {
        const project = database.catalog.createProject({
          name: "Deterministic Test Runtime",
          goal: "Verify test-build injection",
        });
        const result = database.commandRegistry.execute({
          schemaVersion: 1,
          commandId: "deterministic-test-case-revision",
          actor: {
            type: "runtime-worker",
            id: "fixture-setup",
            authenticatedBy: "runtime",
          },
          consumerId: "fixture-setup",
          command: {
            type: "test.case-revision.register",
            testCaseId: "test-case-1",
            revisionId: "test-case-1-r1",
            projectId: project.id,
            manifest: {
              schemaVersion: 1,
              ownerPositionId: "position-test-engineer",
              requirementIds: ["requirement-19"],
              workPackageVersions: [],
              preconditions: ["exact Integration PASS"],
              uiActions: [
                { id: "action-1", kind: "click", target: "run-test" },
              ],
              assertions: [
                {
                  id: "assertion-1",
                  operationId: "operation-1",
                  ui: { kind: "text", expected: "passed" },
                  runtime: { kind: "state", expected: "passed" },
                },
              ],
              fixture: { id: "fixture-1", scriptHashes: ["a".repeat(64)] },
              executionOperations: [
                {
                  id: "operation-1",
                  kind: "electron",
                  adapterId: "scripted-test",
                  input: electronInput,
                  inputHash: canonicalHash(electronInput),
                },
                {
                  id: "cleanup-operation-1",
                  kind: "cleanup",
                  adapterId: "scripted-test",
                  input: cleanupInput,
                  inputHash: canonicalHash(cleanupInput),
                },
              ],
              evidencePolicy: {
                retentionClass: "durable",
                redactionProfile: "default",
                requiredKinds: ["ui", "runtime"],
              },
              cleanup: {
                policy: "always",
                required: true,
                operationId: "cleanup-operation-1",
                rootFingerprint: "c".repeat(64),
                targets: [
                  { kind: "repository", pathFingerprint: "d".repeat(64) },
                  { kind: "worktree", pathFingerprint: "e".repeat(64) },
                ],
              },
            },
          },
        });
        assert.equal(result.status, "succeeded");
        captured = {
          manifestHash: result.value.manifestHash,
          createdAt: result.value.createdAt,
          effectIds: result.effectIds,
        };
      },
    },
  });
  await server.close();
  assert.ok(captured);
  return captured;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Company Runtime server startup", () => {
  it("runs test-build setup before startup reconciliation", async () => {
    const calls: string[] = [];
    const database = {
      pipelineRuntime: {
        reconcilePendingExecutions: async () => calls.push("pipeline"),
      },
      interaction: {
        reconcilePendingTurns: async () => calls.push("interaction"),
      },
      codeReviewNodeHandler: {
        reconcilePending: async () => calls.push("code-review"),
      },
      integrationNodeHandler: {
        reconcilePending: async () => calls.push("integration"),
      },
      testNodeHandler: {
        reconcilePending: async () => calls.push("test"),
      },
    } as unknown as CompanyDatabase;

    await prepareCompanyRuntimeStartup(database, () => {
      calls.push("setup");
    });

    assert.deepEqual(calls, [
      "setup",
      "pipeline",
      "interaction",
      "code-review",
      "integration",
      "test",
    ]);
  });

  it("does not listen until test-build setup completes", async () => {
    const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-server-setup-"));
    roots.push(companyDir);
    const address = companyRuntimeAddress(companyDir);
    let releaseSetup!: () => void;
    const setupBlocked = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const starting = startCompanyRuntimeServer({
      address,
      companyDir,
      token: "server-test-token",
      testBuildFixture: {
        clock: () => new Date("2026-07-29T00:00:00.000Z"),
        nextId: () => "repeatable-test-id",
        fixtureAuthority: {
          read: () => {
            throw new Error("unused");
          },
        },
        setup: () => setupBlocked,
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(address), false);
    releaseSetup();
    const server = await starting;
    try {
      assert.equal(existsSync(address), true);
    } finally {
      await server.close();
    }
  });

  it("does not expose fixture setup through the public Runtime protocol", () => {
    assert.equal(
      RuntimeRequestSchema.safeParse({
        id: "fixture-setup",
        token: "token",
        kind: "command",
        command: { type: "test.fixture.setup" },
      }).success,
      false,
    );
  });

  it("routes Candidate Input and Quality Gate envelopes and fails closed on missing authority", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-server-quality-"),
    );
    roots.push(companyDir);
    const address = companyRuntimeAddress(companyDir);
    const token = "server-quality-test-token";
    const server = await startCompanyRuntimeServer({
      address,
      companyDir,
      token,
    });
    const principal = {
      type: "runtime-worker" as const,
      id: "quality-server-test",
      authenticatedBy: "runtime" as const,
    };
    const client = createCompanyRuntimeClientFromTransport(
      createLocalRuntimeTransport({ address, token }),
      token,
      { actor: principal, consumerId: "quality-server-test" },
    );
    try {
      for (const query of [
        {
          type: "delivery-candidate-input.inspect" as const,
          candidateInputId: "missing-candidate",
        },
        {
          type: "quality-gates.inspect" as const,
          candidateInputId: "missing-candidate",
        },
      ]) {
        await assert.rejects(
          client.queryEnvelope({
            schemaVersion: 1,
            requestId: `query-${query.type}`,
            principal,
            consumerId: "quality-server-test",
            query,
          }),
          (error: unknown) =>
            error instanceof RuntimeClientError &&
            error.code === "CANDIDATE_INPUT_NOT_FOUND",
        );
      }
      await assert.rejects(
        client.queryEnvelope({
          schemaVersion: 1,
          requestId: "query-delivery-candidate-missing",
          principal,
          consumerId: "quality-server-test",
          query: {
            type: "delivery-candidates.inspect",
            candidateId: "missing-delivery-candidate",
          },
        }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "DELIVERY_CANDIDATE_NOT_FOUND",
      );
      assert.deepEqual(
        (
          await client.queryEnvelope({
            schemaVersion: 1,
            requestId: "query-delivery-candidates-empty",
            principal,
            consumerId: "quality-server-test",
            query: { type: "delivery-candidates.list", runId: "missing-run" },
          })
        ).view,
        [],
      );
      await assert.rejects(
        client.queryEnvelope({
          schemaVersion: 1,
          requestId: "query-accepted-delivery-authority-missing",
          principal,
          consumerId: "quality-server-test",
          query: {
            type: "accepted-delivery-authority.inspect",
            candidateId: "missing-delivery-candidate",
          },
        }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "ACCEPTED_DELIVERY_AUTHORITY_NOT_FOUND",
      );
      const reconciled = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "quality-reconcile-missing",
        actor: principal,
        consumerId: "quality-server-test",
        command: {
          type: "quality-gate.execution.reconcile",
          executionId: "missing-execution",
          observation: { state: "unknown" },
        },
      });
      assert.equal(reconciled.status, "rejected");
      if (reconciled.status === "rejected") {
        assert.equal(reconciled.error.code, "DELIVERY_QUALITY_ACTOR_INVALID");
      }
      const release = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "release-missing-candidate",
        actor: principal,
        consumerId: "quality-server-test",
        command: {
          type: "delivery.release.decide",
          decisionId: "release-decision-missing",
          candidateId: "missing-delivery-candidate",
          expectedCandidateHash: "a".repeat(64),
          decision: "accepted",
          reason: "The immutable Candidate evidence was reviewed.",
          evidenceRefs: ["artifact-version:artifact-version-1"],
        },
      });
      assert.equal(release.status, "rejected");
      if (release.status === "rejected") {
        assert.equal(release.error.code, "DELIVERY_CANDIDATE_NOT_FOUND");
      }
      const recovery = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "release-recovery-missing-candidate",
        actor: principal,
        consumerId: "quality-server-test",
        command: {
          type: "delivery.release.recover",
          decisionId: "release-decision-rework-missing",
          candidateId: "missing-delivery-candidate",
          expectedCandidateHash: "a".repeat(64),
          authority: {
            kind: "candidate-input-recheck",
            id: "candidate-input-missing",
          },
        },
      });
      assert.equal(recovery.status, "rejected");
      if (recovery.status === "rejected") {
        assert.equal(recovery.error.code, "DELIVERY_CANDIDATE_NOT_FOUND");
      }
    } finally {
      await server.close();
    }
  });

  it("injects the fake clock and repeatable IDs into the actual Test Runtime", async () => {
    const first = await captureDeterministicTestRevision(
      "2026-07-29T00:00:00.000Z",
      "repeatable-seed",
    );
    const replay = await captureDeterministicTestRevision(
      "2026-07-29T00:00:00.000Z",
      "repeatable-seed",
    );
    const changedSeed = await captureDeterministicTestRevision(
      "2026-07-29T00:00:00.000Z",
      "changed-seed",
    );
    const changedClock = await captureDeterministicTestRevision(
      "2026-07-30T00:00:00.000Z",
      "repeatable-seed",
    );

    assert.deepEqual(replay, first);
    assert.equal(changedSeed.manifestHash, first.manifestHash);
    assert.notDeepEqual(changedSeed.effectIds, first.effectIds);
    assert.equal(changedClock.manifestHash, first.manifestHash);
    assert.notEqual(changedClock.createdAt, first.createdAt);
  });
});
