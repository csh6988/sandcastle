import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";

const humanActor = {
  type: "human" as const,
  id: "local-user",
  authenticatedBy: "local-session" as const,
};

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-technical-review-"));

const runtimeActor = (id: string) => ({
  type: "runtime-worker" as const,
  id,
  authenticatedBy: "runtime" as const,
});

const addAiSession = (
  database: ReturnType<typeof openCompanyDatabase>,
  projectId: string,
  aiMemberId: string,
  role = "review-participant",
) => {
  const session = database.interaction.createSession({
    projectId,
    mode: "consultation",
  });
  database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: aiMemberId,
    role,
  });
  return session.id;
};

const createPromotedProductRun = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
) => {
  const project = database.catalog.createProject({
    name: `Checkout ${suffix}`,
    goal: "Ship a two-Application checkout flow",
  });
  database.projectConfiguration.update({
    projectId: project.id,
    expectedRevision: 0,
    name: project.name,
    goal: project.goal,
    sharedContext: "Web consumes the Orders API.",
    repositoryReferences: ["/work/checkout-web", "/work/orders-api"],
  });
  for (const application of [
    {
      applicationId: `checkout-web-${suffix}`,
      repositoryReference: "/work/checkout-web",
      applicationKey: "web",
      buildCommand: "npm run build:web",
      testCommand: "npm run test:web",
    },
    {
      applicationId: `orders-api-${suffix}`,
      repositoryReference: "/work/orders-api",
      applicationKey: "api",
      buildCommand: "npm run build:api",
      testCommand: "npm run test:api",
    },
  ]) {
    const registered = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `t12-register-${application.applicationKey}-${suffix}`,
      actor: humanActor,
      consumerId: "desktop-project-editor",
      expectedRevision: 0,
      command: {
        type: "application.register",
        projectId: project.id,
        ownership: "checkout-team",
        ...application,
      },
    });
    assert.equal(registered.status, "succeeded");
  }

  const productSession = addAiSession(
    database,
    project.id,
    "product-planner-member",
    "product-manager",
  );
  const proposal = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-proposal-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-t12",
    expectedRevision: 0,
    command: {
      type: "product.proposal.revise",
      projectId: project.id,
      producerSessionId: productSession,
      content: {
        goal: "Ship a two-Application checkout flow",
        users: ["Store customers"],
        scope: ["Checkout submission"],
        nonGoals: ["Payment migration"],
        acceptanceCriteria: ["One checkout creates one order"],
        constraints: ["Remain local-first"],
        risks: ["Contract drift"],
        openQuestions: [],
      },
    },
  });
  assert.equal(proposal.status, "succeeded");
  if (proposal.status !== "succeeded") throw new Error("unreachable");
  const awaiting = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-awaiting-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-t12",
    expectedRevision: proposal.value.proposal!.revision,
    command: {
      type: "product.proposal.mark-awaiting-confirmation",
      projectId: project.id,
      proposalRevisionId: proposal.value.proposal!.currentRevision.id,
      proposalHash: proposal.value.proposal!.currentRevision.hash,
    },
  });
  assert.equal(awaiting.status, "succeeded");
  if (awaiting.status !== "succeeded") throw new Error("unreachable");
  const confirmed = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-confirm-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-t12",
    expectedRevision: awaiting.value.proposal!.revision,
    command: {
      type: "confirm-product-baseline",
      projectId: project.id,
      departmentId: "software-rnd",
      proposalRevisionId: awaiting.value.proposal!.currentRevision.id,
      proposalHash: awaiting.value.proposal!.currentRevision.hash,
    },
  });
  assert.equal(confirmed.status, "succeeded");
  if (confirmed.status !== "succeeded") throw new Error("unreachable");
  const baseline = confirmed.value.baselines[0]!;
  const projectSpec = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-project-spec-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 0,
    command: {
      type: "project-spec.revise",
      runId: baseline.runId,
      producerSessionId: productSession,
      content: {
        outcome: "Web submits one order through the Orders API.",
        acceptanceCriteria: ["One checkout creates one order."],
        applicationBoundaries: [
          `checkout-web-${suffix}`,
          `orders-api-${suffix}`,
        ],
        crossApplicationContracts: ["checkout-submit-v1"],
        deliveryConstraints: ["Remain local-first."],
      },
    },
  });
  assert.equal(projectSpec.status, "succeeded");
  if (projectSpec.status !== "succeeded") throw new Error("unreachable");
  const spec = projectSpec.value.specRevisions[0]!;
  const ownerId = `product-owner-${suffix}`;
  const moderatorId = `product-moderator-${suffix}`;
  const reviewerId = `product-reviewer-${suffix}`;
  const freshId = `product-fresh-${suffix}`;
  const moderatorSession = addAiSession(
    database,
    project.id,
    "evaluator-member",
  );
  const reviewerSession = addAiSession(database, project.id, "reviewer-member");
  const architectReviewSession = addAiSession(
    database,
    project.id,
    "software-architect-member",
  );
  const topicId = `product-topic-${suffix}`;
  const started = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-review-start-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 1,
    command: {
      type: "product-review.start",
      runId: baseline.runId,
      topicId,
      projectSpecRevisionId: spec.id,
      projectSpecHash: spec.hash,
      participants: [
        {
          id: ownerId,
          role: "owner-participant",
          aiMemberId: "product-planner-member",
          positionId: "product-planner",
          sessionId: productSession,
        },
        {
          id: moderatorId,
          role: "moderator",
          aiMemberId: "evaluator-member",
          positionId: "evaluator",
          sessionId: moderatorSession,
        },
        {
          id: reviewerId,
          role: "reviewer-participant",
          aiMemberId: "reviewer-member",
          positionId: "reviewer",
          sessionId: reviewerSession,
        },
        {
          id: freshId,
          role: "reviewer-participant",
          aiMemberId: "software-architect-member",
          positionId: "software-architect",
          sessionId: architectReviewSession,
        },
      ],
      budget: {
        maxRounds: 2,
        maxDurationSeconds: 600,
        maxTokens: 8_000,
        maxCostCents: 250,
      },
    },
  });
  assert.equal(started.status, "succeeded");
  const reviewRevisionId = `product-review-revision-${suffix}`;
  const revision = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-review-revision-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 1,
    command: {
      type: "review.revision.submit",
      topicId,
      revisionId: reviewRevisionId,
      ownerParticipantId: ownerId,
      subjectKind: "project-spec",
      subjectId: spec.id,
      subjectHash: spec.hash,
      producerAiMemberId: "product-planner-member",
      producerPositionId: "product-planner",
      producerSessionId: productSession,
      evidenceRefs: ["project-spec-ready"],
    },
  });
  assert.equal(revision.status, "succeeded");
  const reviewerRecheckSession = addAiSession(
    database,
    project.id,
    "reviewer-member",
  );
  const firstPass = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-pass-1-${suffix}`,
    actor: runtimeActor("reviewer-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: 2,
    command: {
      type: "review.recheck.submit",
      topicId,
      recheckId: `product-recheck-1-${suffix}`,
      revisionId: reviewRevisionId,
      reviewerParticipantId: reviewerId,
      reviewerSessionId: reviewerRecheckSession,
      result: "PASS",
      conditions: [],
      evidenceRefs: ["reviewer-pass"],
    },
  });
  assert.equal(firstPass.status, "succeeded");
  const architectRecheckSession = addAiSession(
    database,
    project.id,
    "software-architect-member",
  );
  const secondPass = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-pass-2-${suffix}`,
    actor: runtimeActor("software-architect-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: 3,
    command: {
      type: "review.recheck.submit",
      topicId,
      recheckId: `product-recheck-2-${suffix}`,
      revisionId: reviewRevisionId,
      reviewerParticipantId: freshId,
      reviewerSessionId: architectRecheckSession,
      result: "PASS",
      conditions: [],
      evidenceRefs: ["architect-pass"],
    },
  });
  assert.equal(secondPass.status, "succeeded");
  const readinessId = `readiness-${suffix}`;
  const readiness = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-readiness-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 0,
    command: {
      type: "product-readiness.record",
      runId: baseline.runId,
      evidenceId: readinessId,
      projectSpecRevisionId: spec.id,
      projectSpecHash: spec.hash,
      producerSessionId: productSession,
      checkKey: "repositories-and-contracts",
      status: "ready",
      summary: "Both repositories and the declared contract are ready.",
      evidenceRefs: ["readiness-report"],
    },
  });
  assert.equal(readiness.status, "succeeded");
  const promoted = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-product-promote-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 1,
    command: {
      type: "product-gate.promote",
      runId: baseline.runId,
      topicId,
      projectSpecRevisionId: spec.id,
      projectSpecHash: spec.hash,
      readinessEvidenceIds: [readinessId],
    },
  });
  assert.equal(promoted.status, "succeeded");
  return { project, baseline, spec, readinessId };
};

const createTechnicalProposalFixture = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
  compatibility: "compatible" | "incompatible" = "compatible",
) => {
  const fixture = createPromotedProductRun(database, suffix);
  const architectSession = addAiSession(
    database,
    fixture.project.id,
    "software-architect-member",
  );
  const revisions = [
    {
      applicationId: `checkout-web-${suffix}`,
      design: "Submit an idempotent checkout command.",
      obligation: "Produce checkout-submit-v1.",
    },
    {
      applicationId: `orders-api-${suffix}`,
      design: "Validate and persist an idempotent checkout command.",
      obligation: "Consume checkout-submit-v1.",
    },
  ].map((application) => {
    const result = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `t12-spec-${application.applicationId}`,
      actor: runtimeActor("software-architect-member"),
      consumerId: "runtime-software-architect",
      expectedRevision: 0,
      command: {
        type: "application-spec.revise" as const,
        runId: fixture.baseline.runId,
        applicationId: application.applicationId,
        promotedProjectSpecRevisionId: fixture.spec.id,
        promotedProjectSpecHash: fixture.spec.hash,
        producerSessionId: architectSession,
        content: {
          design: application.design,
          acceptanceCriteria: ["The checkout contract is satisfied."],
          workPackageConstraints: ["Keep each Application isolated."],
          integrationObligations: [application.obligation],
          contractRefs: [{ id: "checkout-submit", version: "1" }],
        },
      },
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") throw new Error("unreachable");
    return result.value.applicationSpecRevisions.find(
      (revision) => revision.applicationId === application.applicationId,
    )!;
  });
  const content = {
    architecture: "Web sends idempotent commands to the Orders API.",
    dependencyGraph: ["checkout-web -> orders-api"],
    contracts: [
      {
        id: "checkout-submit",
        version: "1",
        producerApplicationId: `checkout-web-${suffix}`,
        consumerApplicationId: `orders-api-${suffix}`,
        kind: "api" as const,
        schema: "POST /orders { checkoutId: string } -> { orderId: string }",
        compatibilityPolicy: "exact" as const,
        compatibility,
        evidenceRefs: [`contract-check:${compatibility}`],
        testCommands: ["npm run test:contract"],
      },
    ],
    riskPolicy: ["Reject duplicate checkout IDs."],
    permissionPolicy: ["No production credentials."],
    testStrategy: ["Run producer and consumer contract suites."],
  };
  const proposal = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-proposal-${suffix}-r1`,
    actor: runtimeActor("software-architect-member"),
    consumerId: "runtime-software-architect",
    expectedRevision: 0,
    command: {
      type: "technical-baseline-proposal.revise" as const,
      runId: fixture.baseline.runId,
      producerSessionId: architectSession,
      applicationSpecRevisions: revisions.map((revision) => ({
        id: revision.id,
        hash: revision.hash,
      })),
      content,
    },
  });
  assert.equal(proposal.status, "succeeded");
  if (proposal.status !== "succeeded") throw new Error("unreachable");
  return {
    ...fixture,
    architectSession,
    revisions,
    content,
    proposal: proposal.value.technicalBaselineProposals[0]!,
  };
};

const startTechnicalReview = (
  database: ReturnType<typeof openCompanyDatabase>,
  fixture: ReturnType<typeof createTechnicalProposalFixture>,
  suffix: string,
  options: { readonly priorQualityGateResultId?: string } = {},
) => {
  const sessions = {
    moderator: addAiSession(database, fixture.project.id, "evaluator-member"),
    reviewer: addAiSession(database, fixture.project.id, "reviewer-member"),
    fresh: addAiSession(
      database,
      fixture.project.id,
      "software-engineer-member",
    ),
  };
  const topicId = `technical-topic-${suffix}`;
  const result = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-technical-start-${suffix}`,
    actor: runtimeActor("software-architect-member"),
    consumerId: "runtime-software-architect",
    expectedRevision: fixture.proposal.revision,
    command: {
      type: "technical-review.start" as const,
      runId: fixture.baseline.runId,
      topicId,
      technicalBaselineProposalId: fixture.proposal.id,
      technicalBaselineProposalHash: fixture.proposal.hash,
      ...options,
      participants: [
        {
          id: `${suffix}-owner`,
          role: "owner-participant" as const,
          aiMemberId: "software-architect-member",
          positionId: "software-architect",
          sessionId: fixture.architectSession,
        },
        {
          id: `${suffix}-moderator`,
          role: "moderator" as const,
          aiMemberId: "evaluator-member",
          positionId: "evaluator",
          sessionId: sessions.moderator,
        },
        {
          id: `${suffix}-reviewer`,
          role: "reviewer-participant" as const,
          aiMemberId: "reviewer-member",
          positionId: "reviewer",
          sessionId: sessions.reviewer,
        },
        {
          id: `${suffix}-fresh`,
          role: "reviewer-participant" as const,
          aiMemberId: "software-engineer-member",
          positionId: "software-engineer",
          sessionId: sessions.fresh,
        },
      ],
      budget: {
        maxRounds: 2,
        maxDurationSeconds: 600,
        maxTokens: 8_000,
        maxCostCents: 250,
      },
    },
  });
  return { result, sessions, topicId };
};

const passTechnicalReview = (
  database: ReturnType<typeof openCompanyDatabase>,
  fixture: ReturnType<typeof createTechnicalProposalFixture>,
  started: ReturnType<typeof startTechnicalReview>,
  suffix: string,
) => {
  const revisionId = `technical-review-revision-${suffix}`;
  const revision = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-technical-revision-${suffix}`,
    actor: runtimeActor("software-architect-member"),
    consumerId: "runtime-software-architect",
    expectedRevision: 1,
    command: {
      type: "review.revision.submit" as const,
      topicId: started.topicId,
      revisionId,
      ownerParticipantId: `${suffix}-owner`,
      subjectKind: "technical-baseline-proposal",
      subjectId: fixture.proposal.id,
      subjectHash: fixture.proposal.hash,
      producerAiMemberId: "software-architect-member",
      producerPositionId: "software-architect",
      producerSessionId: fixture.architectSession,
      evidenceRefs: ["technical-proposal-ready"],
    },
  });
  assert.equal(revision.status, "succeeded");
  const first = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-technical-pass-1-${suffix}`,
    actor: runtimeActor("reviewer-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: 2,
    command: {
      type: "review.recheck.submit" as const,
      topicId: started.topicId,
      recheckId: `technical-pass-1-${suffix}`,
      revisionId,
      reviewerParticipantId: `${suffix}-reviewer`,
      reviewerSessionId: addAiSession(
        database,
        fixture.project.id,
        "reviewer-member",
      ),
      result: "PASS" as const,
      conditions: [],
      evidenceRefs: ["reviewer-pass"],
    },
  });
  assert.equal(first.status, "succeeded");
  const second = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t12-technical-pass-2-${suffix}`,
    actor: runtimeActor("software-engineer-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: 3,
    command: {
      type: "review.recheck.submit" as const,
      topicId: started.topicId,
      recheckId: `technical-pass-2-${suffix}`,
      revisionId,
      reviewerParticipantId: `${suffix}-fresh`,
      reviewerSessionId: addAiSession(
        database,
        fixture.project.id,
        "software-engineer-member",
      ),
      result: "PASS" as const,
      conditions: [],
      evidenceRefs: ["fresh-reviewer-pass"],
    },
  });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded" || !second.value.gateResult) {
    throw new Error("Technical Review did not produce a Gate Result.");
  }
  assert.equal(second.value.gateResult.result, "PASS");
  return second.value.gateResult;
};

describe("Technical Review Runtime", () => {
  it("registers stable Project-scoped Applications before Specs reference them", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship a two-Application checkout flow",
      });
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: 0,
        name: project.name,
        goal: project.goal,
        sharedContext: "Web consumes the Orders API.",
        repositoryReferences: ["/work/checkout-web", "/work/orders-api"],
      });

      const envelope = {
        schemaVersion: 1 as const,
        commandId: "t12-register-web",
        actor: humanActor,
        consumerId: "desktop-project-editor",
        expectedRevision: 0,
        command: {
          type: "application.register" as const,
          applicationId: "checkout-web",
          projectId: project.id,
          repositoryReference: "/work/checkout-web",
          applicationKey: "web",
          ownership: "checkout-team",
          buildCommand: "npm run build",
          testCommand: "npm test",
        },
      };
      const registered = database.commandRegistry.execute(envelope);

      assert.equal(registered.status, "succeeded");
      assert.deepEqual(database.commandRegistry.execute(envelope), registered);
      const applications = database.technicalReview.listApplications(
        project.id,
      );
      assert.equal(applications.length, 1);
      assert.deepEqual(applications[0], {
        id: "checkout-web",
        projectId: project.id,
        repositoryReference: "/work/checkout-web",
        applicationKey: "web",
        ownership: "checkout-team",
        buildCommand: "npm run build",
        testCommand: "npm test",
        revision: 1,
        createdAt: applications[0]?.createdAt,
      });
      assert.match(applications[0]?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

      const conflicting = database.commandRegistry.execute({
        ...envelope,
        commandId: "t12-register-web-conflict",
        command: {
          ...envelope.command,
          repositoryReference: "/work/orders-api",
        },
      });
      assert.equal(conflicting.status, "rejected");
      if (conflicting.status === "rejected") {
        assert.equal(conflicting.error.code, "APPLICATION_ALREADY_REGISTERED");
      }
    } finally {
      database.close();
    }
  });

  it("appends immutable Application Spec revisions bound to the promoted Project Spec", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createPromotedProductRun(database, "specs");
      const architectSession = addAiSession(
        database,
        fixture.project.id,
        "software-architect-member",
      );
      const first = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-web-spec-r1",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 0,
        command: {
          type: "application-spec.revise" as const,
          runId: fixture.baseline.runId,
          applicationId: "checkout-web-specs",
          promotedProjectSpecRevisionId: fixture.spec.id,
          promotedProjectSpecHash: fixture.spec.hash,
          producerSessionId: architectSession,
          content: {
            design: "Submit checkout commands through the Orders API.",
            acceptanceCriteria: ["A submitted checkout receives one order ID."],
            workPackageConstraints: ["Do not embed order persistence in web."],
            integrationObligations: ["Consume checkout-submit-v1."],
            contractRefs: [{ id: "checkout-submit", version: "1" }],
          },
        },
      });
      assert.equal(first.status, "succeeded");
      if (first.status !== "succeeded") throw new Error("unreachable");
      const firstRevision = first.value.applicationSpecRevisions[0]!;
      assert.equal(firstRevision.revision, 1);
      assert.equal(firstRevision.applicationId, "checkout-web-specs");
      assert.equal(
        firstRevision.promotedProjectSpecRevisionId,
        fixture.spec.id,
      );
      assert.equal(firstRevision.supersedesRevisionId, null);
      assert.match(firstRevision.hash, /^[a-f0-9]{64}$/);

      const second = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-web-spec-r2",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 1,
        command: {
          type: "application-spec.revise" as const,
          runId: fixture.baseline.runId,
          applicationId: "checkout-web-specs",
          promotedProjectSpecRevisionId: fixture.spec.id,
          promotedProjectSpecHash: fixture.spec.hash,
          producerSessionId: architectSession,
          content: {
            ...firstRevision.content,
            design:
              "Submit idempotent checkout commands through the Orders API.",
          },
        },
      });
      assert.equal(second.status, "succeeded");
      if (second.status !== "succeeded") throw new Error("unreachable");
      assert.equal(second.value.applicationSpecRevisions.length, 2);
      assert.equal(
        second.value.applicationSpecRevisions[1]?.supersedesRevisionId,
        firstRevision.id,
      );
      assert.notEqual(
        second.value.applicationSpecRevisions[1]?.hash,
        firstRevision.hash,
      );

      const mismatch = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-api-spec-upstream-mismatch",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 0,
        command: {
          type: "application-spec.revise" as const,
          runId: fixture.baseline.runId,
          applicationId: "orders-api-specs",
          promotedProjectSpecRevisionId: fixture.spec.id,
          promotedProjectSpecHash: "0".repeat(64),
          producerSessionId: architectSession,
          content: {
            design: "Accept checkout commands and persist orders.",
            acceptanceCriteria: ["One idempotency key creates one order."],
            workPackageConstraints: ["Keep persistence behind the API."],
            integrationObligations: ["Produce checkout-submit-v1."],
            contractRefs: [{ id: "checkout-submit", version: "1" }],
          },
        },
      });
      assert.equal(mismatch.status, "rejected");
      if (mismatch.status === "rejected") {
        assert.equal(mismatch.error.code, "SPEC_CONTRACT_MISMATCH");
      }
    } finally {
      database.close();
    }
  });

  it("reviews an immutable Technical Baseline Proposal with exact Spec and contract hashes", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createPromotedProductRun(database, "proposal");
      const architectSession = addAiSession(
        database,
        fixture.project.id,
        "software-architect-member",
      );
      const reviseSpec = (
        applicationId: string,
        design: string,
        obligation: string,
      ) => {
        const result = database.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `t12-${applicationId}-spec`,
          actor: runtimeActor("software-architect-member"),
          consumerId: "runtime-software-architect",
          expectedRevision: 0,
          command: {
            type: "application-spec.revise" as const,
            runId: fixture.baseline.runId,
            applicationId,
            promotedProjectSpecRevisionId: fixture.spec.id,
            promotedProjectSpecHash: fixture.spec.hash,
            producerSessionId: architectSession,
            content: {
              design,
              acceptanceCriteria: ["The checkout contract is satisfied."],
              workPackageConstraints: ["Keep each Application isolated."],
              integrationObligations: [obligation],
              contractRefs: [{ id: "checkout-submit", version: "1" }],
            },
          },
        });
        assert.equal(result.status, "succeeded");
        if (result.status !== "succeeded") throw new Error("unreachable");
        return result.value.applicationSpecRevisions.find(
          (revision) => revision.applicationId === applicationId,
        )!;
      };
      const webSpec = reviseSpec(
        "checkout-web-proposal",
        "Submit an idempotent checkout command.",
        "Produce checkout-submit-v1.",
      );
      const apiSpec = reviseSpec(
        "orders-api-proposal",
        "Validate and persist an idempotent checkout command.",
        "Consume checkout-submit-v1.",
      );

      const proposal = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-proposal-r1",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 0,
        command: {
          type: "technical-baseline-proposal.revise" as const,
          runId: fixture.baseline.runId,
          producerSessionId: architectSession,
          applicationSpecRevisions: [
            { id: webSpec.id, hash: webSpec.hash },
            { id: apiSpec.id, hash: apiSpec.hash },
          ],
          content: {
            architecture: "Web sends idempotent commands to the Orders API.",
            dependencyGraph: ["checkout-web -> orders-api"],
            contracts: [
              {
                id: "checkout-submit",
                version: "1",
                producerApplicationId: "checkout-web-proposal",
                consumerApplicationId: "orders-api-proposal",
                kind: "api" as const,
                schema:
                  "POST /orders { checkoutId: string } -> { orderId: string }",
                compatibilityPolicy: "exact" as const,
                compatibility: "compatible" as const,
                evidenceRefs: ["contract-check:checkout-submit-v1"],
                testCommands: ["npm run test:contract"],
              },
            ],
            riskPolicy: ["Reject duplicate checkout IDs."],
            permissionPolicy: ["No production credentials."],
            testStrategy: ["Run producer and consumer contract suites."],
          },
        },
      });
      assert.equal(proposal.status, "succeeded");
      if (proposal.status !== "succeeded") throw new Error("unreachable");
      assert.equal(proposal.value.acceptedBaseline, null);
      const proposalRevision = proposal.value.technicalBaselineProposals[0]!;
      const contract = proposal.value.applicationContracts[0]!;
      assert.match(proposalRevision.hash, /^[a-f0-9]{64}$/);
      assert.match(contract.hash, /^[a-f0-9]{64}$/);

      const moderatorSession = addAiSession(
        database,
        fixture.project.id,
        "evaluator-member",
      );
      const reviewerSession = addAiSession(
        database,
        fixture.project.id,
        "reviewer-member",
      );
      const freshReviewerSession = addAiSession(
        database,
        fixture.project.id,
        "software-engineer-member",
      );
      const started = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-review-start",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 1,
        command: {
          type: "technical-review.start" as const,
          runId: fixture.baseline.runId,
          topicId: "technical-topic-proposal",
          technicalBaselineProposalId: proposalRevision.id,
          technicalBaselineProposalHash: proposalRevision.hash,
          participants: [
            {
              id: "technical-owner",
              role: "owner-participant" as const,
              aiMemberId: "software-architect-member",
              positionId: "software-architect",
              sessionId: architectSession,
            },
            {
              id: "technical-moderator",
              role: "moderator" as const,
              aiMemberId: "evaluator-member",
              positionId: "evaluator",
              sessionId: moderatorSession,
            },
            {
              id: "technical-reviewer",
              role: "reviewer-participant" as const,
              aiMemberId: "reviewer-member",
              positionId: "reviewer",
              sessionId: reviewerSession,
            },
            {
              id: "technical-fresh-reviewer",
              role: "reviewer-participant" as const,
              aiMemberId: "software-engineer-member",
              positionId: "software-engineer",
              sessionId: freshReviewerSession,
            },
          ],
          budget: {
            maxRounds: 2,
            maxDurationSeconds: 600,
            maxTokens: 8_000,
            maxCostCents: 250,
          },
        },
      });
      assert.equal(started.status, "succeeded");
      if (started.status !== "succeeded") throw new Error("unreachable");
      const topic = started.value.reviewTopics.find(
        (candidate) => candidate.topic.id === "technical-topic-proposal",
      )!;
      assert.equal(topic.topic.manifest.scope, "technical");
      if (topic.topic.manifest.scope !== "technical") return;
      assert.equal(
        topic.topic.manifest.promotedProjectSpecHash,
        fixture.spec.hash,
      );
      assert.deepEqual(topic.topic.manifest.applicationSpecRevisions, [
        {
          applicationId: webSpec.applicationId,
          id: webSpec.id,
          hash: webSpec.hash,
        },
        {
          applicationId: apiSpec.applicationId,
          id: apiSpec.id,
          hash: apiSpec.hash,
        },
      ]);
      assert.deepEqual(topic.topic.manifest.crossApplicationContracts, [
        { id: contract.id, version: contract.version, hash: contract.hash },
      ]);
      assert.equal(
        topic.participants.find(
          (participant) => participant.id === "technical-owner",
        )?.eligibility.eligible,
        false,
      );

      const selfReview = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-architect-self-review",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 1,
        command: {
          type: "review.finding.submit" as const,
          topicId: "technical-topic-proposal",
          findingId: "architect-self-finding",
          reviewerParticipantId: "technical-owner",
          reviewerSessionId: architectSession,
          severity: "high" as const,
          summary: "Owner cannot review its own proposal.",
          rationale: "Separation of duties is mandatory.",
          impact: "Would permit self-approval.",
          evidenceRefs: ["adr-0041"],
          suggestedOwner: "software-architect",
          blocking: true,
        },
      });
      assert.equal(selfReview.status, "rejected");
      if (selfReview.status === "rejected") {
        assert.equal(selfReview.error.code, "REVIEWER_INELIGIBLE");
      }
      assert.equal(
        database.technicalReview.inspect(fixture.baseline.runId)
          .acceptedBaseline,
        null,
      );
    } finally {
      database.close();
    }
  });

  it("links CONDITIONAL_PASS obligations to a new Proposal and fresh Technical Review", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createTechnicalProposalFixture(database, "conditional");
      const started = startTechnicalReview(database, fixture, "conditional-r1");
      assert.equal(started.result.status, "succeeded");
      const reviewRevisionId = "technical-review-revision-conditional-r1";
      const revision = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-revision-conditional-r1",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 1,
        command: {
          type: "review.revision.submit" as const,
          topicId: started.topicId,
          revisionId: reviewRevisionId,
          ownerParticipantId: "conditional-r1-owner",
          subjectKind: "technical-baseline-proposal",
          subjectId: fixture.proposal.id,
          subjectHash: fixture.proposal.hash,
          producerAiMemberId: "software-architect-member",
          producerPositionId: "software-architect",
          producerSessionId: fixture.architectSession,
          evidenceRefs: ["technical-proposal-ready"],
        },
      });
      assert.equal(revision.status, "succeeded");
      const conditionalVote = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-conditional-vote",
        actor: runtimeActor("reviewer-member"),
        consumerId: "runtime-reviewer",
        expectedRevision: 2,
        command: {
          type: "review.recheck.submit" as const,
          topicId: started.topicId,
          recheckId: "technical-conditional-recheck",
          revisionId: reviewRevisionId,
          reviewerParticipantId: "conditional-r1-reviewer",
          reviewerSessionId: addAiSession(
            database,
            fixture.project.id,
            "reviewer-member",
          ),
          result: "CONDITIONAL_PASS" as const,
          conditions: ["Add a machine-verifiable rollback contract test."],
          evidenceRefs: ["rollback-gap"],
        },
      });
      assert.equal(conditionalVote.status, "succeeded");
      const passVote = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-conditional-pass-vote",
        actor: runtimeActor("software-engineer-member"),
        consumerId: "runtime-reviewer",
        expectedRevision: 3,
        command: {
          type: "review.recheck.submit" as const,
          topicId: started.topicId,
          recheckId: "technical-conditional-pass-recheck",
          revisionId: reviewRevisionId,
          reviewerParticipantId: "conditional-r1-fresh",
          reviewerSessionId: addAiSession(
            database,
            fixture.project.id,
            "software-engineer-member",
          ),
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["architecture-pass"],
        },
      });
      assert.equal(passVote.status, "succeeded");
      if (passVote.status !== "succeeded") throw new Error("unreachable");
      assert.equal(passVote.value.gateResult?.result, "CONDITIONAL_PASS");
      const conditionalGateId = passVote.value.gateResult!.id;

      const revisedProposal = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-proposal-conditional-r2",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 1,
        command: {
          type: "technical-baseline-proposal.revise" as const,
          runId: fixture.baseline.runId,
          producerSessionId: fixture.architectSession,
          applicationSpecRevisions: fixture.revisions.map((item) => ({
            id: item.id,
            hash: item.hash,
          })),
          content: {
            ...fixture.content,
            testStrategy: [
              ...fixture.content.testStrategy,
              "Run a machine-verifiable rollback contract test.",
            ],
          },
        },
      });
      assert.equal(revisedProposal.status, "succeeded");
      if (revisedProposal.status !== "succeeded")
        throw new Error("unreachable");
      const r2 = revisedProposal.value.technicalBaselineProposals[1]!;
      const r2Fixture = { ...fixture, proposal: r2 };

      const missingLink = startTechnicalReview(
        database,
        r2Fixture,
        "conditional-r2-missing-link",
      );
      assert.equal(missingLink.result.status, "rejected");
      if (missingLink.result.status === "rejected") {
        assert.equal(
          missingLink.result.error.code,
          "CONDITIONAL_OBLIGATIONS_LINK_REQUIRED",
        );
      }

      const linked = startTechnicalReview(
        database,
        r2Fixture,
        "conditional-r2-linked",
        { priorQualityGateResultId: conditionalGateId },
      );
      assert.equal(linked.result.status, "succeeded");
      if (linked.result.status !== "succeeded") throw new Error("unreachable");
      assert.deepEqual(linked.result.value.conditionalObligations, [
        {
          qualityGateResultId: conditionalGateId,
          conditions: ["Add a machine-verifiable rollback contract test."],
          nextTopicId: linked.topicId,
        },
      ]);
      assert.equal(linked.result.value.acceptedBaseline, null);
    } finally {
      database.close();
    }
  });

  it("materializes an accepted Technical Baseline and child Snapshot only from a fresh PASS", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createTechnicalProposalFixture(database, "promotion");
      const started = startTechnicalReview(database, fixture, "promotion");
      assert.equal(started.result.status, "succeeded");
      const sourceSnapshotRevisionId = database.pipelineRuntime.inspectRun(
        fixture.baseline.runId,
      ).run.snapshotRevisionId;
      assert.equal(
        database.technicalReview.inspect(fixture.baseline.runId)
          .acceptedBaseline,
        null,
      );

      const beforePass = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-technical-promote-before-pass",
        actor: runtimeActor("delivery-coordinator-member"),
        consumerId: "runtime-delivery-coordinator",
        expectedRevision: 2,
        command: {
          type: "technical-gate.promote" as const,
          runId: fixture.baseline.runId,
          parentSnapshotRevisionId: sourceSnapshotRevisionId,
          gateResultId: "missing-technical-gate",
        },
      });
      assert.equal(beforePass.status, "rejected");
      if (beforePass.status === "rejected") {
        assert.equal(beforePass.error.code, "TECHNICAL_GATE_NOT_PASS");
      }

      const gate = passTechnicalReview(database, fixture, started, "promotion");
      const architectPromotion = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-architect-promote-technical-gate",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-software-architect",
        expectedRevision: 2,
        command: {
          type: "technical-gate.promote" as const,
          runId: fixture.baseline.runId,
          parentSnapshotRevisionId: sourceSnapshotRevisionId,
          gateResultId: gate.id,
        },
      });
      assert.equal(architectPromotion.status, "rejected");
      if (architectPromotion.status === "rejected") {
        assert.equal(
          architectPromotion.error.code,
          "TECHNICAL_GATE_ACTOR_INVALID",
        );
      }

      const envelope = {
        schemaVersion: 1 as const,
        commandId: "t12-promote-technical-gate-pass",
        actor: runtimeActor("delivery-coordinator-member"),
        consumerId: "runtime-delivery-coordinator",
        expectedRevision: 2,
        command: {
          type: "technical-gate.promote" as const,
          runId: fixture.baseline.runId,
          parentSnapshotRevisionId: sourceSnapshotRevisionId,
          gateResultId: gate.id,
        },
      };
      const promoted = database.commandRegistry.execute(envelope);
      assert.equal(promoted.status, "succeeded");
      if (promoted.status !== "succeeded") return;
      assert.deepEqual(database.commandRegistry.execute(envelope), promoted);
      assert.equal(promoted.value.snapshotLineage.length, 3);
      assert.equal(promoted.value.snapshotLineage[2]?.parentRevision, 2);
      assert.notEqual(promoted.value.acceptedBaseline?.id, fixture.proposal.id);
      assert.equal(
        promoted.value.acceptedBaseline?.proposalRevisionId,
        fixture.proposal.id,
      );
      assert.equal(
        "qualityGateResultId" in
          (promoted.value.acceptedBaseline?.manifest ?? {}),
        false,
      );
      assert.equal(promoted.value.promotion?.qualityGateResultId, gate.id);
      assert.equal(
        database.pipelineRuntime.inspectRun(fixture.baseline.runId).snapshot
          .payload.technicalGatePromotion?.acceptedTechnicalBaselineId,
        promoted.value.acceptedBaseline?.id,
      );
      const conflictingReuse = database.commandRegistry.execute({
        ...envelope,
        command: { ...envelope.command, gateResultId: "different-gate" },
      });
      assert.equal(conflictingReuse.status, "rejected");
      if (conflictingReuse.status === "rejected") {
        assert.equal(conflictingReuse.error.code, "COMMAND_ID_REUSE");
      }
    } finally {
      database.close();
    }
  });

  it("keeps incompatible Cross-Application Contract evidence as a promotion blocker", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createTechnicalProposalFixture(
        database,
        "incompatible",
        "incompatible",
      );
      const started = startTechnicalReview(database, fixture, "incompatible");
      assert.equal(started.result.status, "succeeded");
      const gate = passTechnicalReview(
        database,
        fixture,
        started,
        "incompatible",
      );
      const blocked = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t12-promote-incompatible-contract",
        actor: runtimeActor("delivery-coordinator-member"),
        consumerId: "runtime-delivery-coordinator",
        expectedRevision: 2,
        command: {
          type: "technical-gate.promote" as const,
          runId: fixture.baseline.runId,
          parentSnapshotRevisionId: database.pipelineRuntime.inspectRun(
            fixture.baseline.runId,
          ).run.snapshotRevisionId,
          gateResultId: gate.id,
        },
      });
      assert.equal(blocked.status, "rejected");
      if (blocked.status === "rejected") {
        assert.equal(blocked.error.code, "TECHNICAL_CONTRACT_INCOMPATIBLE");
      }
      const state = database.technicalReview.inspect(fixture.baseline.runId);
      assert.equal(state.acceptedBaseline, null);
      assert.equal(state.promotion, null);
      assert.deepEqual(
        state.applicationContracts.find(
          (contract) => contract.compatibility === "incompatible",
        )?.evidenceRefs,
        ["contract-check:incompatible"],
      );
    } finally {
      database.close();
    }
  });

  it("rolls back a promotion crash and retries the same Command after restart", () => {
    const companyDir = tempCompanyDir();
    let crash = true;
    const database = openCompanyDatabase(companyDir, {
      technicalReviewRuntime: {
        promotionFailure: (point) => {
          if (crash && point === "after-snapshot") {
            throw new Error("simulated technical promotion crash");
          }
        },
      },
    });
    const fixture = createTechnicalProposalFixture(database, "crash");
    const started = startTechnicalReview(database, fixture, "crash");
    assert.equal(started.result.status, "succeeded");
    const gate = passTechnicalReview(database, fixture, started, "crash");
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "t12-crash-promote-technical-gate",
      actor: runtimeActor("delivery-coordinator-member"),
      consumerId: "runtime-delivery-coordinator",
      expectedRevision: 2,
      command: {
        type: "technical-gate.promote" as const,
        runId: fixture.baseline.runId,
        parentSnapshotRevisionId: database.pipelineRuntime.inspectRun(
          fixture.baseline.runId,
        ).run.snapshotRevisionId,
        gateResultId: gate.id,
      },
    };
    assert.throws(
      () => database.commandRegistry.execute(envelope),
      /simulated technical promotion crash/,
    );
    assert.equal(
      database.technicalReview.inspect(fixture.baseline.runId).snapshotLineage
        .length,
      2,
    );
    assert.equal(
      database.technicalReview.inspect(fixture.baseline.runId).acceptedBaseline,
      null,
    );
    database.close();

    crash = false;
    const reopened = openCompanyDatabase(companyDir);
    try {
      const promoted = reopened.commandRegistry.execute(envelope);
      assert.equal(promoted.status, "succeeded");
      if (promoted.status !== "succeeded") return;
      assert.equal(promoted.value.snapshotLineage.length, 3);
      assert.deepEqual(reopened.commandRegistry.execute(envelope), promoted);
    } finally {
      reopened.close();
    }
  });
});
