import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ImprovementApplicationApplyRequestSchema,
  ImprovementApplicationFinalizeSchema,
  ImprovementApplicationOperationViewSchema,
  ImprovementProposalDecisionSchema,
  ImprovementProposalErrorCodeSchema,
  ImprovementProposalProposeRequestSchema,
  ImprovementProposalRevisionContentSchema,
  ImprovementProposalViewSchema,
} from "./improvementProposalContracts.js";
import {
  CompanyQuerySchema,
  EnvelopeCommandSchema,
  ImprovementApplicationApplyEnvelopeCommandSchema,
  ImprovementProposalDecideEnvelopeCommandSchema,
  ImprovementProposalInspectQuerySchema,
  ImprovementProposalListQuerySchema,
  ImprovementProposalProposeEnvelopeCommandSchema,
} from "../interface.js";

const hash = "a".repeat(64);
const createdAt = "2026-08-03T00:00:00.000Z";

const content = {
  evidenceQuery: "runs where verification failed on the same skill flow",
  evidenceRefs: ["run:1", "defect:2", "audit:3"],
  rootCauseHypothesis:
    "The skill flow retries without backing off, exhausting the budget.",
  proposedChange: {
    targetKind: "skill-flow" as const,
    targetId: "skill-flow:verify",
    currentRevisionRef: "skill-flow-revision:7",
    summary: "Add exponential backoff between verification retries.",
    diffRef: "diff:42",
  },
  impactScope: {
    departments: ["software-rnd"],
    projects: ["project:sandcastle"],
  },
  expectedMetrics: [
    {
      metric: "verification-retry-count",
      direction: "decrease" as const,
      baselineRef: "baseline:9",
    },
  ],
  validationPlan: "Shadow the new flow on the next 20 runs before promoting.",
  rolloutPath: "Gray-release to software-rnd, then widen once metrics hold.",
  rollbackPath:
    "Restore skill-flow-revision:7 and retain the applied revision.",
};

const proposeRequest = {
  proposalId: "improvement-proposal-1",
  revisionId: "improvement-proposal-revision-1",
  projectId: "project:sandcastle",
  departmentId: "software-rnd",
  supersedesRevisionId: null,
  proposedBy: {
    type: "runtime-worker" as const,
    id: "runtime-worker:planner",
    authenticatedBy: "runtime" as const,
  },
  content,
};

const proposalView = {
  id: "improvement-proposal-1",
  projectId: "project:sandcastle",
  departmentId: "software-rnd",
  status: "proposed" as const,
  revision: 1,
  currentRevision: {
    id: "improvement-proposal-revision-1",
    revision: 1,
    supersedesRevisionId: null,
    content,
    hash,
    proposedBy: proposeRequest.proposedBy,
    createdAt,
  },
  decision: null,
  applicationOperations: [],
  nextActions: ["revise", "decide"] as const,
  createdAt,
  updatedAt: createdAt,
};

describe("Improvement proposal contracts", () => {
  it("rejects unknown fields projected onto an Improvement proposal view", () => {
    assert.throws(() =>
      ImprovementProposalViewSchema.parse({
        ...proposalView,
        currentRevision: {
          ...proposalView.currentRevision,
          unexpected: "must-not-project",
        },
      }),
    );
    assert.throws(() =>
      ImprovementProposalRevisionContentSchema.parse({
        ...content,
        proposedChange: {
          ...content.proposedChange,
          unexpected: "must-not-project",
        },
      }),
    );
  });

  it("freezes a proposal revision with its evidence-backed content and runtime author", () => {
    const request =
      ImprovementProposalProposeRequestSchema.parse(proposeRequest);
    assert.equal(request.proposedBy.type, "runtime-worker");
    assert.equal(request.content.proposedChange.targetKind, "skill-flow");
    assert.doesNotThrow(() =>
      ImprovementProposalViewSchema.parse(proposalView),
    );

    const applyRequest = ImprovementApplicationApplyRequestSchema.parse({
      applicationOperationId: "improvement-application-1",
      proposalId: "improvement-proposal-1",
      approvedDecisionId: "improvement-decision-1",
      expectedApprovedDecisionHash: hash,
      targetKind: "skill-flow",
      targetId: "skill-flow:verify",
      expectedTargetRevisionRef: "skill-flow-revision:7",
      authorization: {
        actor: {
          type: "human",
          id: "human-1",
          authenticatedBy: "local-session",
        },
        reason: "Approve applying the backoff change.",
        evidenceRefs: ["improvement-decision:1"],
      },
    });
    assert.equal(
      applyRequest.authorization.actor.authenticatedBy,
      "local-session",
    );

    assert.doesNotThrow(() =>
      ImprovementApplicationOperationViewSchema.parse({
        id: "improvement-application-1",
        proposalId: "improvement-proposal-1",
        approvedDecisionId: "improvement-decision-1",
        approvedDecisionHash: hash,
        targetKind: "skill-flow",
        targetId: "skill-flow:verify",
        canonicalRequestHash: hash,
        state: "applying",
        targetRevisionRef: null,
        rollbackRevisionRef: null,
        validationEvidence: [],
        createdAt,
        updatedAt: createdAt,
      }),
    );

    assert.doesNotThrow(() =>
      ImprovementApplicationFinalizeSchema.parse({
        state: "applied",
        targetRevisionRef: "skill-flow-revision:8",
        validationEvidence: [],
        observedAt: createdAt,
      }),
    );
    assert.doesNotThrow(() =>
      ImprovementApplicationFinalizeSchema.parse({
        state: "rolled-back",
        rollbackRevisionRef: "skill-flow-revision:9",
        observedAt: createdAt,
      }),
    );
  });

  it("keeps human actor injection separate from command inputs and freezes expected hashes", () => {
    const proposeCommand = {
      type: "improvement.proposal.propose",
      proposal: {
        proposalId: "improvement-proposal-1",
        revisionId: "improvement-proposal-revision-1",
        projectId: "project:sandcastle",
        departmentId: "software-rnd",
        supersedesRevisionId: null,
        content,
      },
    } as const;
    const decideCommand = {
      type: "improvement.proposal.decide",
      proposalId: "improvement-proposal-1",
      proposalRevisionId: "improvement-proposal-revision-1",
      expectedProposalRevisionHash: hash,
      decision: "approved",
      reason: "Evidence supports the backoff change.",
      evidenceRefs: ["improvement-review:1"],
    } as const;
    const applyCommand = {
      type: "improvement.application.apply",
      application: {
        applicationOperationId: "improvement-application-1",
        proposalId: "improvement-proposal-1",
        approvedDecisionId: "improvement-decision-1",
        expectedApprovedDecisionHash: hash,
        targetKind: "skill-flow",
        targetId: "skill-flow:verify",
        expectedTargetRevisionRef: "skill-flow-revision:7",
        authorization: {
          reason: "Apply the approved change.",
          evidenceRefs: ["improvement-decision:1"],
        },
      },
    } as const;

    assert.doesNotThrow(() =>
      ImprovementProposalProposeEnvelopeCommandSchema.parse(proposeCommand),
    );
    assert.doesNotThrow(() =>
      ImprovementProposalDecideEnvelopeCommandSchema.parse(decideCommand),
    );
    assert.doesNotThrow(() =>
      ImprovementApplicationApplyEnvelopeCommandSchema.parse(applyCommand),
    );
    assert.doesNotThrow(() => EnvelopeCommandSchema.parse(proposeCommand));
    assert.doesNotThrow(() => EnvelopeCommandSchema.parse(decideCommand));
    assert.doesNotThrow(() => EnvelopeCommandSchema.parse(applyCommand));

    // The renderer-facing propose input carries no actor.
    assert.ok(!("proposedBy" in proposeCommand.proposal));
    // The runtime-facing decision requires the verified local-session human.
    assert.doesNotThrow(() =>
      ImprovementProposalDecisionSchema.parse({
        proposalId: "improvement-proposal-1",
        proposalRevisionId: "improvement-proposal-revision-1",
        expectedProposalRevisionHash: hash,
        decision: "approved",
        actor: {
          type: "human",
          id: "human-1",
          authenticatedBy: "local-session",
        },
        reason: "Evidence supports the backoff change.",
        evidenceRefs: ["improvement-review:1"],
      }),
    );

    assert.doesNotThrow(() =>
      ImprovementProposalInspectQuerySchema.parse({
        type: "improvement-proposals.inspect",
        proposalId: "improvement-proposal-1",
      }),
    );
    assert.doesNotThrow(() =>
      ImprovementProposalListQuerySchema.parse({
        type: "improvement-proposals.list",
        projectId: "project:sandcastle",
      }),
    );
    assert.doesNotThrow(() =>
      CompanyQuerySchema.parse({
        type: "improvement-proposals.inspect",
        proposalId: "improvement-proposal-1",
      }),
    );
    assert.doesNotThrow(() =>
      CompanyQuerySchema.parse({
        type: "improvement-proposals.list",
        departmentId: "software-rnd",
      }),
    );

    assert.equal(
      ImprovementProposalErrorCodeSchema.parse(
        "IMPROVEMENT_APPLICATION_ID_REUSE",
      ),
      "IMPROVEMENT_APPLICATION_ID_REUSE",
    );
  });
});
