import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReleaseOperationEffectRequestSchema,
  ReleaseOperationErrorCodeSchema,
  ReleaseOperationCreateRequestSchema,
  ReleaseOperationViewSchema,
} from "./releaseOperationContracts.js";
import {
  ReleaseOperationCreateEnvelopeCommandSchema,
  ReleaseOperationInspectQuerySchema,
  ReleaseOperationListQuerySchema,
  ReleaseOperationReconcileEnvelopeCommandSchema,
} from "../interface.js";

const hash = "a".repeat(64);

describe("Release operation contracts", () => {
  it("freezes a merge operation with its accepted authority and serial items", () => {
    const request = ReleaseOperationCreateRequestSchema.parse({
      operationId: "release-operation-1",
      candidateId: "candidate-1",
      expectedAcceptedAuthorityHash: hash,
      kind: "merge",
      authorization: {
        actor: {
          type: "human",
          id: "human-1",
          authenticatedBy: "local-session",
        },
        reason: "Release the accepted candidate to its selected branches.",
        evidenceRefs: ["release-checklist:1"],
      },
      items: [
        {
          id: "repository:api",
          repositoryReference: "repository:api",
          sourceCommit: "b".repeat(40),
          destination: {
            targetBranch: "main",
            expectedTargetTip: "c".repeat(40),
          },
        },
        {
          id: "repository:web",
          repositoryReference: "repository:web",
          sourceCommit: "d".repeat(40),
          destination: {
            targetBranch: "main",
            expectedTargetTip: "e".repeat(40),
          },
        },
      ],
    });

    assert.deepEqual(
      request.items.map((item) => item.id),
      ["repository:api", "repository:web"],
    );
    assert.doesNotThrow(() =>
      ReleaseOperationViewSchema.parse({
        id: "release-operation-1",
        request,
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
          repositoryCommits: [
            { repositoryReference: "repository:api", commit: "b".repeat(40) },
            { repositoryReference: "repository:web", commit: "d".repeat(40) },
          ],
          artifactVersionIds: ["artifact-version-1"],
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          authorityHash: hash,
          createdAt: "2026-08-03T00:00:00.000Z",
        },
        canonicalRequestHash: hash,
        nextActions: [],
        aggregateState: "pending",
        counts: {
          pending: 2,
          running: 0,
          reconciling: 0,
          succeeded: 0,
          failed: 0,
          destinationConflict: 0,
          unknown: 0,
        },
        items: request.items.map((item) => ({
          ...item,
          state: "pending",
          receipt: null,
          evidence: [],
          updatedAt: "2026-08-03T00:00:00.000Z",
        })),
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      }),
    );
  });

  it("keeps human actor injection separate from command inputs and freezes expected hashes", () => {
    assert.doesNotThrow(() =>
      ReleaseOperationCreateEnvelopeCommandSchema.parse({
        type: "delivery.release-operation.create",
        operation: {
          operationId: "release-operation-1",
          candidateId: "candidate-1",
          expectedAcceptedAuthorityHash: hash,
          kind: "export",
          authorization: {
            reason: "Export the accepted artifact.",
            evidenceRefs: ["release-checklist:1"],
          },
          items: [
            {
              id: "artifact:release-notes",
              artifactVersionId: "artifact-version-1",
              destination: {
                canonicalRoot: "/tmp/releases",
                expectedRootState: "preexisting-local-filesystem-root",
                relativePath: "release-notes.md",
                overwrite: { kind: "create-only" },
              },
            },
          ],
        },
      }),
    );
    assert.doesNotThrow(() =>
      ReleaseOperationReconcileEnvelopeCommandSchema.parse({
        type: "delivery.release-operation.reconcile",
        operationId: "release-operation-1",
        itemId: "artifact:release-notes",
        expectedOperationHash: hash,
        evidenceRefs: ["filesystem-observation:1"],
      }),
    );
    assert.doesNotThrow(() =>
      ReleaseOperationInspectQuerySchema.parse({
        type: "release-operations.inspect",
        operationId: "release-operation-1",
      }),
    );
    assert.doesNotThrow(() =>
      ReleaseOperationListQuerySchema.parse({
        type: "release-operations.list",
        candidateId: "candidate-1",
      }),
    );
    assert.throws(() => ReleaseOperationListQuerySchema.parse({ type: "release-operations.list" }));
    assert.doesNotThrow(() =>
      ReleaseOperationEffectRequestSchema.parse({
        operationId: "release-operation-1",
        canonicalRequestHash: hash,
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
          repositoryCommits: [],
          artifactVersionIds: ["artifact-version-1"],
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          authorityHash: hash,
          createdAt: "2026-08-03T00:00:00.000Z",
        },
        kind: "export",
        item: {
          id: "artifact:release-notes",
          artifactVersionId: "artifact-version-1",
          destination: {
            canonicalRoot: "/tmp/releases",
            expectedRootState: "preexisting-local-filesystem-root",
            relativePath: "release-notes.md",
            overwrite: { kind: "create-only" },
          },
        },
        artifact: {
          contentKind: "managed-file",
          integrityStatus: "verified",
          digest: hash,
        },
      }),
    );
    assert.equal(
      ReleaseOperationErrorCodeSchema.parse("RELEASE_OPERATION_ID_REUSE"),
      "RELEASE_OPERATION_ID_REUSE",
    );
    assert.doesNotThrow(() =>
      ReleaseOperationViewSchema.parse({
        id: "release-operation-next-actions",
        request: ReleaseOperationCreateRequestSchema.parse({
          operationId: "release-operation-next-actions",
          candidateId: "candidate-1",
          expectedAcceptedAuthorityHash: hash,
          kind: "merge",
          authorization: {
            actor: { type: "human", id: "human-1", authenticatedBy: "local-session" },
            reason: "Retry after destination drift.",
            evidenceRefs: ["release-checklist:2"],
          },
          items: [{ id: "repository:api", repositoryReference: "repository:api", sourceCommit: "b".repeat(40), destination: { targetBranch: "main", expectedTargetTip: "c".repeat(40) } }],
        }),
        acceptedAuthority: { id: "authority-1", candidateId: "candidate-1", candidateHash: hash, releaseDecisionId: "decision-1", releaseDecisionHash: hash, candidateInputId: "candidate-input-1", candidateInputHash: hash, gateAuthorityId: "gate-authority-1", gateAuthorityHash: hash, integrationGenerationId: "generation-1", integrationAuthorityHash: hash, repositoryCommits: [], artifactVersionIds: [], runId: "run-1", snapshotRevisionId: "snapshot-1", authorityHash: hash, createdAt: "2026-08-03T00:00:00.000Z" },
        canonicalRequestHash: hash,
        aggregateState: "blocked",
        counts: { pending: 0, running: 0, reconciling: 0, succeeded: 0, failed: 0, destinationConflict: 0, unknown: 1 },
        items: [],
        nextActions: ["reconcile", "create-new-operation"],
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      }),
    );
  });
});
