import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      releaseOperations: {
        reconcilePending: async () => {
          calls.push("release");
          return [];
        },
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
      "release",
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
      assert.deepEqual(
        (
          await client.queryEnvelope({
            schemaVersion: 1,
            requestId: "query-release-operations-empty",
            principal,
            consumerId: "quality-server-test",
            query: {
              type: "release-operations.list",
              candidateId: "missing-delivery-candidate",
            },
          })
        ).view,
        [],
      );
      await assert.rejects(
        client.queryEnvelope({
          schemaVersion: 1,
          requestId: "query-release-operation-missing",
          principal,
          consumerId: "quality-server-test",
          query: {
            type: "release-operations.inspect",
            operationId: "missing-release-operation",
          },
        }),
        (error: unknown) =>
          error instanceof RuntimeClientError &&
          error.code === "RELEASE_OPERATION_NOT_FOUND",
      );
      const releaseOperation = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "release-operation-invalid-actor",
        actor: principal,
        consumerId: "quality-server-test",
        command: {
          type: "delivery.release-operation.create",
          operation: {
            operationId: "release-operation-1",
            candidateId: "missing-delivery-candidate",
            expectedAcceptedAuthorityHash: "a".repeat(64),
            kind: "merge",
            authorization: {
              reason: "Release accepted authority.",
              evidenceRefs: ["checklist-1"],
            },
            items: [
              {
                id: "repository:api",
                repositoryReference: "/tmp/disposable-repository",
                sourceCommit: "b".repeat(40),
                destination: {
                  targetBranch: "main",
                  expectedTargetTip: "c".repeat(40),
                },
              },
            ],
          },
        },
      });
      assert.equal(releaseOperation.status, "rejected");
      if (releaseOperation.status === "rejected") {
        assert.equal(
          releaseOperation.error.code,
          "ACCEPTED_DELIVERY_AUTHORITY_NOT_FOUND",
        );
      }
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

  it("routes Project-scoped Statistics queries and evidence freeze through the typed tunnel", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-server-statistics-"),
    );
    roots.push(companyDir);
    const address = companyRuntimeAddress(companyDir);
    const token = "server-statistics-test-token";
    const actor = {
      type: "human" as const,
      id: "statistics-reader",
      authenticatedBy: "local-session" as const,
    };
    const server = await startCompanyRuntimeServer({
      address,
      companyDir,
      token,
      principal: actor,
      consumerId: "statistics-server-test",
      trustedConnections: [
        {
          token: "statistics-fixture-only-token",
          principal: {
            type: "test-driver",
            id: "fixture-only",
            authenticatedBy: "ipc-token",
          },
          consumerId: "fixture-only",
        },
      ],
    });
    const client = createCompanyRuntimeClientFromTransport(
      createLocalRuntimeTransport({ address, token }),
      token,
      { actor, consumerId: "statistics-server-test" },
    );
    try {
      const project = await client.execute({
        type: "project.create",
        name: "Statistics",
        goal: "Inspect governed facts",
      });
      const query = {
        projectId: project.id,
        window: {
          kind: "explicit-utc-half-open" as const,
          startInclusive: "2026-08-01T00:00:00.000Z",
          endExclusive: "2026-08-02T00:00:00.000Z",
        },
        cohort: { id: "cohort:empty" },
        comparisonSet: {
          id: "comparison:empty",
          metricIds: [
            "review-finding-count" as const,
            "product-baseline-confirmation-count" as const,
          ],
        },
      };
      const inspected = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "query-statistics",
        principal: actor,
        consumerId: "statistics-server-test",
        query: { type: "statistics.inspect", projectId: project.id, query },
      });
      assert.deepEqual(
        inspected.view.observations.map((entry) =>
          entry.status === "available" ? entry.measurement : entry.status,
        ),
        [
          { kind: "count", value: 0 },
          { kind: "count", value: 0 },
        ],
      );

      const frozen = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:freeze-server-statistics",
        actor,
        consumerId: "statistics-server-test",
        command: {
          type: "statistics.evidence.freeze",
          evidenceSnapshotId: "statistics-evidence:server",
          query,
        },
      });
      assert.equal(frozen.status, "succeeded");
      if (frozen.status !== "succeeded") assert.fail("freeze must succeed");
      const evidence = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "query-statistics-evidence",
        principal: actor,
        consumerId: "statistics-server-test",
        query: {
          type: "statistics-evidence.inspect",
          evidenceSnapshotId: frozen.value.id,
        },
      });
      assert.deepEqual(evidence.view, frozen.value);

      const fixtureClient = createCompanyRuntimeClientFromTransport(
        createLocalRuntimeTransport({
          address,
          token: "statistics-fixture-only-token",
        }),
        "statistics-fixture-only-token",
        {
          actor: {
            type: "test-driver",
            id: "fixture-only",
            authenticatedBy: "ipc-token",
          },
          consumerId: "fixture-only",
        },
      );
      await assert.rejects(
        fixtureClient.queryEnvelope({
          schemaVersion: 1,
          requestId: "query-statistics-fixture-only",
          principal: {
            type: "test-driver",
            id: "fixture-only",
            authenticatedBy: "ipc-token",
          },
          consumerId: "fixture-only",
          query: { type: "statistics.inspect", projectId: project.id, query },
        }),
        (error: unknown) =>
          error instanceof RuntimeClientError && error.code === "FORBIDDEN",
      );
    } finally {
      await server.close();
    }
  });

  it("routes immutable evidence-backed Improvement proposal authoring and queries through the typed tunnel", async () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-server-improvement-proposals-"),
    );
    roots.push(companyDir);
    const address = companyRuntimeAddress(companyDir);
    const token = "server-improvement-proposal-test-token";
    const actor = {
      type: "human" as const,
      id: "improvement-author",
      authenticatedBy: "local-session" as const,
    };
    const server = await startCompanyRuntimeServer({
      address,
      companyDir,
      token,
      principal: actor,
      consumerId: "improvement-proposal-server-test",
    });
    const client = createCompanyRuntimeClientFromTransport(
      createLocalRuntimeTransport({ address, token }),
      token,
      { actor, consumerId: "improvement-proposal-server-test" },
    );
    try {
      const project = await client.execute({
        type: "project.create",
        name: "Improvement proposals",
        goal: "Govern exact revisions",
      });
      const frozen = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:freeze-improvement-proposal-server-evidence",
        actor,
        consumerId: "improvement-proposal-server-test",
        command: {
          type: "statistics.evidence.freeze",
          evidenceSnapshotId: "statistics-evidence:improvement-proposal-server",
          query: {
            projectId: project.id,
            window: {
              kind: "explicit-utc-half-open",
              startInclusive: "2026-08-01T00:00:00.000Z",
              endExclusive: "2026-08-02T00:00:00.000Z",
            },
            cohort: { id: "cohort:improvement-proposal-server" },
            comparisonSet: {
              id: "comparison:improvement-proposal-server",
              metricIds: ["review-finding-count"],
            },
          },
        },
      });
      assert.equal(frozen.status, "succeeded");
      if (frozen.status !== "succeeded") assert.fail("freeze must succeed");

      const created = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:create-improvement-proposal-server",
        actor,
        consumerId: "improvement-proposal-server-test",
        command: {
          type: "improvement.proposal.create",
          proposal: {
            proposalId: "improvement-proposal:server",
            revisionId: "improvement-proposal-revision:server:1",
            projectId: project.id,
            departmentId: null,
            content: {
              evidence: frozen.value,
              target: {
                targetKind: "harness",
                ownerId: "harness:server-review",
                governedHead: { revisionId: null, revisionHash: null },
                content: {
                  principles: ["Use exact frozen evidence."],
                  constitution: "Review immutable production contracts.",
                  rules: ["Bind proposals to one frozen snapshot."],
                  examples: {
                    positive: ["Inspect the exact evidence hash."],
                    negative: ["Use a moving dashboard query."],
                  },
                  impactScope: [project.id],
                },
              },
              rootCauseHypothesis:
                "Review guidance does not require frozen Statistics evidence.",
              impactScope: {
                projectIds: [project.id],
                departmentIds: [],
                positionIds: [],
              },
              expectedMetrics: [
                { metricId: "review-finding-count", direction: "decrease" },
              ],
              validationPolicy: {
                metricIds: ["review-finding-count"],
                minimumComparableObservations: 1,
              },
              rolloutNotes: "Validate with the next comparable cohort.",
              rollbackSource: {
                revisionId: "harness:server-review:source",
                revisionHash: "a".repeat(64),
              },
            },
          },
        },
      });
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded") assert.fail("create must succeed");

      const revision = created.value.revisions[0];
      if (!revision) assert.fail("proposal revision must exist");
      const proposed = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:propose-improvement-proposal-server",
        actor,
        consumerId: "improvement-proposal-server-test",
        command: {
          type: "improvement.proposal.propose",
          proposalId: created.value.id,
          proposalRevisionId: revision.id,
          expectedProposalRevisionHash: revision.hash,
        },
      });
      assert.equal(proposed.status, "succeeded");
      if (proposed.status !== "succeeded") assert.fail("propose must succeed");
      const confirmation =
        "I confirm this exact proposal revision, evidence, target head, and Harness content.";
      const requested = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:request-improvement-proposal-server-decision",
        actor,
        consumerId: "improvement-proposal-server-test",
        command: {
          type: "improvement.proposal.request-decision",
          proposalId: proposed.value.id,
          proposalRevisionId: revision.id,
          expectedProposalRevisionHash: revision.hash,
          confirmation,
        },
      });
      assert.equal(requested.status, "succeeded");
      if (requested.status !== "succeeded") {
        assert.fail("request decision must succeed");
      }
      const approved = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "command:approve-improvement-proposal-server",
        actor,
        consumerId: "improvement-proposal-server-test",
        command: {
          type: "improvement.proposal.decide",
          proposalId: requested.value.id,
          proposalRevisionId: revision.id,
          expectedProposalRevisionHash: revision.hash,
          decision: "approved",
          confirmation,
          reason: "The frozen proposal boundary is exact.",
          evidenceRefs: [frozen.value.id],
        },
      });
      assert.equal(approved.status, "succeeded");
      if (approved.status !== "succeeded") assert.fail("approve must succeed");
      assert.equal(approved.value.currentState, "approved");

      const sqlite = new DatabaseSync(
        join(companyDir, ".sandcastle", "company.sqlite"),
      );
      for (const table of [
        "governed_harness_revisions",
        "runtime_template_revisions",
        "governed_skill_flow_revisions",
        "improvement_application_operations",
      ]) {
        assert.equal(
          (
            sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              readonly count: number;
            }
          ).count,
          0,
          table,
        );
      }
      sqlite.close();

      const listed = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "query-improvement-proposals",
        principal: actor,
        consumerId: "improvement-proposal-server-test",
        query: { type: "improvement-proposals.list", projectId: project.id },
      });
      const inspected = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "query-improvement-proposal",
        principal: actor,
        consumerId: "improvement-proposal-server-test",
        query: {
          type: "improvement-proposal.inspect",
          proposalId: created.value.id,
        },
      });
      assert.deepEqual(listed.view, [approved.value]);
      assert.deepEqual(inspected.view, approved.value);
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
