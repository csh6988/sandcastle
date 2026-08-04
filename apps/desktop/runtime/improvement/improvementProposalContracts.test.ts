import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ImprovementApplicationApplyCommandInputSchema,
  ImprovementApplicationOperationViewSchema,
  ImprovementApplicationStateSchema,
  ImprovementApplicationValidateRequestSchema,
  ImprovementProposalDecisionSchema,
  ImprovementProposalErrorCodeSchema,
  ImprovementProposalRevisionContentSchema,
  ImprovementProposalViewSchema,
  ImprovementTargetSchema,
} from "./improvementProposalContracts.js";
import { CompanyQuerySchema, EnvelopeCommandSchema } from "../interface.js";

const hash = "a".repeat(64);
const createdAt = "2026-08-04T00:00:00.000Z";

const evidence = {
  id: "statistics-evidence:1",
  query: {
    catalogVersion: "statistics@1" as const,
    projectId: "project:sandcastle",
    filters: {
      departmentIds: ["department:software-rnd"],
      aiMemberIds: [],
      modelIds: [],
      repositoryIds: ["repository:sandcastle"],
      workPackageIds: [],
      pipelineVersionIds: ["pipeline:7"],
    },
    window: {
      kind: "explicit-utc-half-open" as const,
      startInclusive: "2026-07-01T00:00:00.000Z",
      endExclusive: "2026-08-01T00:00:00.000Z",
    },
    cohort: {
      id: "cohort:before",
      filters: {
        departmentIds: ["department:software-rnd"],
        aiMemberIds: [],
        modelIds: [],
        repositoryIds: ["repository:sandcastle"],
        workPackageIds: [],
        pipelineVersionIds: ["pipeline:7"],
      },
    },
    comparisonSet: {
      id: "comparison:retry",
      metricIds: ["ordinary-retry-count" as const],
    },
  },
  queryHash: hash,
  asOfSequence: 42,
  observations: [
    {
      metricId: "ordinary-retry-count" as const,
      status: "available" as const,
      measurement: { kind: "count" as const, value: 4 },
      sourceFactFamily: "node-attempt",
      sourceFactRefs: ["node-attempt:1", "node-attempt:2"],
    },
  ],
  completeness: {
    status: "complete" as const,
    incompleteMetricIds: [],
    unavailableMetricIds: [],
  },
  frozenBy: {
    type: "runtime-worker" as const,
    id: "runtime-worker:statistics",
    authenticatedBy: "runtime" as const,
  },
  hash,
  createdAt,
};

const harnessTarget = {
  targetKind: "harness" as const,
  ownerId: "harness:software-rnd-review",
  governedHead: {
    revisionId: "harness-revision:7",
    revisionHash: hash,
  },
  content: {
    principles: ["Prefer exact evidence over inference."],
    constitution: "Review work against frozen production contracts.",
    rules: ["Back off before retrying a failed verification."],
    examples: {
      positive: ["Retry after a bounded delay with the same operation key."],
      negative: ["Blindly resend an unknown external effect."],
    },
    impactScope: ["department:software-rnd"],
  },
};

const content = {
  evidence,
  target: harnessTarget,
  rootCauseHypothesis:
    "The verification Harness permits immediate retries after an unknown result.",
  impactScope: {
    projectIds: ["project:sandcastle"],
    departmentIds: ["department:software-rnd"],
    positionIds: ["position:reviewer"],
  },
  expectedMetrics: [
    {
      metricId: "ordinary-retry-count" as const,
      direction: "decrease" as const,
    },
  ],
  validationPolicy: {
    metricIds: ["ordinary-retry-count" as const],
    minimumComparableObservations: 1,
  },
  rolloutNotes: "Validate against the next comparable cohort before selection.",
  rollbackSource: {
    revisionId: "harness-revision:7",
    revisionHash: hash,
  },
};

describe("Improvement proposal contracts", () => {
  it("binds one immutable Statistics evidence snapshot and one strict target", () => {
    assert.doesNotThrow(() =>
      ImprovementProposalRevisionContentSchema.parse(content),
    );
    assert.doesNotThrow(() => ImprovementTargetSchema.parse(harnessTarget));
    assert.throws(() =>
      ImprovementProposalRevisionContentSchema.parse({
        ...content,
        evidenceQuery: "opaque moving query",
      }),
    );
    assert.throws(() =>
      ImprovementTargetSchema.parse({
        ...harnessTarget,
        targetKind: "spec",
      }),
    );
    assert.throws(() =>
      ImprovementTargetSchema.parse({
        targetKind: "template",
        ownerId: "template:unsafe",
        governedHead: { revisionId: null, revisionHash: null },
        content: {
          manifest: [{ path: "../escape", contentHash: hash }],
        },
      }),
    );
    assert.throws(() =>
      ImprovementTargetSchema.parse({
        targetKind: "template",
        ownerId: "template:unsorted",
        governedHead: { revisionId: null, revisionHash: null },
        content: {
          manifest: [
            { path: "z-last.md", contentHash: hash },
            { path: "a-first.md", contentHash: hash },
          ],
        },
      }),
    );
    assert.throws(() =>
      ImprovementTargetSchema.parse({
        targetKind: "template",
        ownerId: "template:duplicate",
        governedHead: { revisionId: null, revisionHash: null },
        content: {
          manifest: [
            { path: "same.md", contentHash: hash },
            { path: "same.md", contentHash: "b".repeat(64) },
          ],
        },
      }),
    );
    assert.throws(() =>
      ImprovementTargetSchema.parse({
        targetKind: "skill-flow",
        ownerId: "skill-flow:duplicate",
        governedHead: { revisionId: null, revisionHash: null },
        content: {
          positionId: "position:reviewer",
          name: "Review",
          instructions: "Review exact evidence.",
          skillIds: ["code-review", "code-review"],
        },
      }),
    );
  });

  it("freezes all approved application states and exact error codes", () => {
    for (const state of [
      "applying",
      "applied",
      "apply-failed",
      "reconciling",
      "unknown",
      "validated",
      "rollback-requested",
      "rolled-back",
      "rollback-failed",
    ] as const) {
      assert.equal(ImprovementApplicationStateSchema.parse(state), state);
    }

    for (const code of [
      "STATISTICS_EVIDENCE_UNAVAILABLE",
      "STATISTICS_EVIDENCE_STALE",
      "IMPROVEMENT_PROPOSAL_SUPERSEDED",
      "IMPROVEMENT_DECISION_EXISTS",
      "IMPROVEMENT_NOT_APPROVED",
      "IMPROVEMENT_INVALID_STATE",
      "IMPROVEMENT_TARGET_UNSUPPORTED",
      "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
      "IMPROVEMENT_TARGET_CONFLICT",
      "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE",
      "IMPROVEMENT_APPLICATION_UNKNOWN",
    ] as const) {
      assert.equal(ImprovementProposalErrorCodeSchema.parse(code), code);
    }
    assert.throws(() =>
      ImprovementProposalErrorCodeSchema.parse(
        "IMPROVEMENT_APPLICATION_ID_REUSE",
      ),
    );
  });

  it("keeps renderer Commands actor-free and exposes every approved discriminator", () => {
    const queries = [
      {
        type: "statistics.inspect",
        projectId: "project:sandcastle",
        query: evidence.query,
      },
      { type: "statistics-evidence.inspect", evidenceSnapshotId: evidence.id },
      { type: "improvement-proposals.list", projectId: "project:sandcastle" },
      { type: "improvement-proposal.inspect", proposalId: "proposal:1" },
      {
        type: "improvement-applications.list",
        projectId: "project:sandcastle",
      },
      { type: "improvement-application.inspect", operationId: "operation:1" },
    ] as const;
    for (const query of queries) {
      assert.doesNotThrow(() => CompanyQuerySchema.parse(query));
    }
    assert.throws(() =>
      CompanyQuerySchema.parse({
        type: "improvement-proposals.inspect",
        proposalId: "proposal:1",
      }),
    );

    const commands = [
      {
        type: "statistics.evidence.freeze",
        evidenceSnapshotId: evidence.id,
        query: evidence.query,
      },
      {
        type: "improvement.proposal.create",
        proposal: {
          proposalId: "proposal:1",
          revisionId: "proposal-revision:1",
          projectId: "project:sandcastle",
          departmentId: "department:software-rnd",
          content,
        },
      },
      {
        type: "improvement.proposal.revise",
        proposal: {
          proposalId: "proposal:1",
          revisionId: "proposal-revision:2",
          supersedesRevisionId: "proposal-revision:1",
          expectedSupersededRevisionHash: hash,
          content,
        },
      },
      {
        type: "improvement.proposal.propose",
        proposalId: "proposal:1",
        proposalRevisionId: "proposal-revision:2",
        expectedProposalRevisionHash: hash,
      },
      {
        type: "improvement.proposal.request-decision",
        proposalId: "proposal:1",
        proposalRevisionId: "proposal-revision:2",
        expectedProposalRevisionHash: hash,
        confirmation: "Request an exact human decision.",
      },
      {
        type: "improvement.proposal.decide",
        proposalId: "proposal:1",
        proposalRevisionId: "proposal-revision:2",
        expectedProposalRevisionHash: hash,
        decision: "approved",
        confirmation: "Approve this exact revision and governed head.",
        reason: "Frozen evidence supports the bounded change.",
        evidenceRefs: ["review:1"],
      },
      {
        type: "improvement.application.apply",
        application: {
          operationId: "operation:1",
          proposalId: "proposal:1",
          proposalRevisionId: "proposal-revision:2",
          expectedProposalRevisionHash: hash,
          approvedDecisionId: "decision:2",
          expectedApprovedDecisionHash: hash,
          target: harnessTarget,
          confirmation: "Append the approved governed Harness revision.",
          reason: "Apply the approved exact revision.",
          evidenceRefs: ["decision:2"],
        },
      },
      {
        type: "improvement.application.validate",
        validation: {
          operationId: "operation:1",
          expectedOperationHash: hash,
          afterEvidence: evidence,
          reason: "Compare the approved metric set.",
          evidenceRefs: ["statistics-evidence:1"],
        },
      },
      {
        type: "improvement.application.rollback",
        rollback: {
          operationId: "operation:1",
          expectedOperationHash: hash,
          appliedRevision: {
            revisionId: "harness-revision:8",
            revisionHash: hash,
          },
          expectedGovernedHead: {
            revisionId: "harness-revision:8",
            revisionHash: hash,
          },
          rollbackSource: {
            revisionId: "harness-revision:7",
            revisionHash: hash,
          },
          confirmation: "Append a restoring revision and retain history.",
          reason: "Comparable evidence regressed.",
          evidenceRefs: ["validation:1"],
        },
      },
    ] as const;
    for (const command of commands) {
      assert.doesNotThrow(() => EnvelopeCommandSchema.parse(command));
      assert.ok(!("actor" in command));
    }
  });

  it("permits one exact decision per revision and keeps application history append-only", () => {
    const decision = ImprovementProposalDecisionSchema.parse({
      id: "decision:2",
      proposalId: "proposal:1",
      proposalRevisionId: "proposal-revision:2",
      proposalRevisionHash: hash,
      evidenceSnapshotId: evidence.id,
      evidenceSnapshotHash: hash,
      target: harnessTarget,
      decision: "approved",
      confirmation: "Approve this exact revision and governed head.",
      actor: {
        type: "human",
        id: "human:1",
        authenticatedBy: "local-session",
      },
      reason: "Frozen evidence supports the bounded change.",
      evidenceRefs: ["review:1"],
      hash,
      createdAt,
    });
    assert.equal(decision.proposalRevisionId, "proposal-revision:2");

    assert.doesNotThrow(() =>
      ImprovementProposalViewSchema.parse({
        id: "proposal:1",
        projectId: "project:sandcastle",
        departmentId: "department:software-rnd",
        currentRevisionId: "proposal-revision:2",
        currentState: "approved",
        revisions: [
          {
            id: "proposal-revision:2",
            revision: 2,
            supersedesRevisionId: "proposal-revision:1",
            content,
            hash,
            authoredBy: {
              type: "human",
              id: "human:1",
              authenticatedBy: "local-session",
            },
            lifecycle: [
              { state: "draft", confirmation: null, createdAt },
              { state: "proposed", confirmation: null, createdAt },
              {
                state: "awaiting-human",
                confirmation: "I confirm this exact proposal revision.",
                createdAt,
              },
            ],
            decision,
            createdAt,
          },
        ],
        nextActions: ["apply"],
        createdAt,
        updatedAt: createdAt,
      }),
    );

    assert.doesNotThrow(() =>
      ImprovementApplicationOperationViewSchema.parse({
        id: "operation:1",
        projectId: "project:sandcastle",
        proposalId: "proposal:1",
        proposalRevisionId: "proposal-revision:2",
        proposalRevisionHash: hash,
        approvedDecisionId: "decision:2",
        approvedDecisionHash: hash,
        target: harnessTarget,
        canonicalRequestHash: hash,
        state: "reconciling",
        deterministicEffectId: "improvement-effect:operation:1:apply",
        confirmation: "I confirm this exact approved revision.",
        reason: "Apply the bounded Harness revision.",
        evidenceRefs: ["decision:2"],
        appliedBy: {
          type: "human",
          id: "human:1",
          authenticatedBy: "local-session",
        },
        latestError: {
          code: "IMPROVEMENT_APPLICATION_UNKNOWN",
          message: "The target effect cannot yet be proven.",
        },
        receipts: [],
        observations: [
          {
            id: "observation:1",
            phase: "apply",
            outcome: "insufficient-evidence",
            evidenceRefs: ["target-inspection:1"],
            hash,
            observedAt: createdAt,
          },
        ],
        reconciliations: [],
        validations: [],
        rollbacks: [],
        nextActions: ["reconcile"],
        createdAt,
        updatedAt: createdAt,
      }),
    );
  });

  it("separates human-only apply from human-or-worker validation authority", () => {
    assert.doesNotThrow(() =>
      ImprovementApplicationApplyCommandInputSchema.parse({
        operationId: "operation:1",
        proposalId: "proposal:1",
        proposalRevisionId: "proposal-revision:2",
        expectedProposalRevisionHash: hash,
        approvedDecisionId: "decision:2",
        expectedApprovedDecisionHash: hash,
        target: harnessTarget,
        confirmation: "Append the approved governed Harness revision.",
        reason: "Apply the approved exact revision.",
        evidenceRefs: ["decision:2"],
      }),
    );
    assert.doesNotThrow(() =>
      ImprovementApplicationValidateRequestSchema.parse({
        operationId: "operation:1",
        expectedOperationHash: hash,
        afterEvidence: evidence,
        actor: {
          type: "runtime-worker",
          id: "runtime-worker:statistics",
          authenticatedBy: "runtime",
        },
        reason: "Compare the exact metric set.",
        evidenceRefs: ["statistics-evidence:1"],
      }),
    );
  });
});
