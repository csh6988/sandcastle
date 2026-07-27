import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

const createFormalProductRun = (
  database: ReturnType<typeof openCompanyDatabase>,
) => {
  const project = database.catalog.createProject({
    name: "Checkout",
    goal: "Ship a safer checkout",
  });
  const ownerSession = database.interaction.createSession({
    projectId: project.id,
    mode: "consultation",
  });
  database.interaction.addParticipant({
    sessionId: ownerSession.id,
    participantType: "ai-member",
    participantRef: "product-planner-member",
    role: "product-manager",
  });
  const revised = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "t11-proposal-revise",
    actor: humanActor,
    consumerId: "desktop-t11",
    expectedRevision: 0,
    command: {
      type: "product.proposal.revise",
      projectId: project.id,
      producerSessionId: ownerSession.id,
      content: {
        goal: "Ship a safer checkout",
        users: ["Store customers"],
        scope: ["Checkout confirmation"],
        nonGoals: ["Payment provider migration"],
        acceptanceCriteria: ["A duplicate submission creates one order"],
        constraints: ["Remain local-first"],
        risks: ["Retry races"],
        openQuestions: [],
      },
    },
  });
  assert.equal(revised.status, "succeeded");
  if (revised.status !== "succeeded") throw new Error("unreachable");
  const awaiting = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "t11-proposal-awaiting",
    actor: humanActor,
    consumerId: "desktop-t11",
    expectedRevision: revised.value.proposal!.revision,
    command: {
      type: "product.proposal.mark-awaiting-confirmation",
      projectId: project.id,
      proposalRevisionId: revised.value.proposal!.currentRevision.id,
      proposalHash: revised.value.proposal!.currentRevision.hash,
    },
  });
  assert.equal(awaiting.status, "succeeded");
  if (awaiting.status !== "succeeded") throw new Error("unreachable");
  const confirmed = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: "t11-baseline-confirm",
    actor: humanActor,
    consumerId: "desktop-t11",
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
  return {
    project,
    ownerSession,
    baseline: confirmed.value.baselines[0]!,
  };
};

const runtimeActor = (id: string) => ({
  type: "runtime-worker" as const,
  id,
  authenticatedBy: "runtime" as const,
});

const createStartedProductReview = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
) => {
  const fixture = createFormalProductRun(database);
  const revised = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t11-spec-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 0,
    command: {
      type: "project-spec.revise",
      runId: fixture.baseline.runId,
      producerSessionId: fixture.ownerSession.id,
      content: {
        outcome: "Customers submit checkout exactly once.",
        acceptanceCriteria: ["Duplicate submission creates one order."],
        applicationBoundaries: ["checkout-web", "orders-api"],
        crossApplicationContracts: ["checkout-submit-v1"],
        deliveryConstraints: ["Remain local-first."],
      },
    },
  });
  assert.equal(revised.status, "succeeded");
  if (revised.status !== "succeeded") throw new Error("unreachable");
  const spec = revised.value.specRevisions[0]!;
  const sessionFor = (aiMemberId: string) => {
    const session = database.interaction.createSession({
      projectId: fixture.project.id,
      mode: "consultation",
    });
    database.interaction.addParticipant({
      sessionId: session.id,
      participantType: "ai-member",
      participantRef: aiMemberId,
      role: "review-participant",
    });
    return session.id;
  };
  const sessions = {
    moderator: sessionFor("evaluator-member"),
    reviewer: sessionFor("reviewer-member"),
    freshReviewer: sessionFor("software-architect-member"),
  };
  const topicId = `t11-topic-${suffix}`;
  const started = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t11-start-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision: 1,
    command: {
      type: "product-review.start",
      runId: fixture.baseline.runId,
      topicId,
      projectSpecRevisionId: spec.id,
      projectSpecHash: spec.hash,
      participants: [
        {
          id: `${suffix}-owner`,
          role: "owner-participant",
          aiMemberId: "product-planner-member",
          positionId: "product-planner",
          sessionId: fixture.ownerSession.id,
        },
        {
          id: `${suffix}-moderator`,
          role: "moderator",
          aiMemberId: "evaluator-member",
          positionId: "evaluator",
          sessionId: sessions.moderator,
        },
        {
          id: `${suffix}-reviewer`,
          role: "reviewer-participant",
          aiMemberId: "reviewer-member",
          positionId: "reviewer",
          sessionId: sessions.reviewer,
        },
        {
          id: `${suffix}-fresh-reviewer`,
          role: "reviewer-participant",
          aiMemberId: "software-architect-member",
          positionId: "software-architect",
          sessionId: sessions.freshReviewer,
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
  return { ...fixture, spec, sessions, sessionFor, topicId };
};

const passProductReview = (
  database: ReturnType<typeof openCompanyDatabase>,
  fixture: ReturnType<typeof createStartedProductReview>,
  expectedRevision: number,
  suffix: string,
) => {
  const revisionId = `t11-review-revision-${suffix}`;
  const revision = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t11-review-revision-command-${suffix}`,
    actor: runtimeActor("product-planner-member"),
    consumerId: "runtime-product-manager",
    expectedRevision,
    command: {
      type: "review.revision.submit",
      topicId: fixture.topicId,
      revisionId,
      ownerParticipantId: `${suffix}-owner`,
      subjectKind: "project-spec",
      subjectId: fixture.spec.id,
      subjectHash: fixture.spec.hash,
      producerAiMemberId: "product-planner-member",
      producerPositionId: "product-planner",
      producerSessionId: fixture.ownerSession.id,
      evidenceRefs: ["project-spec-review-ready"],
    },
  });
  assert.equal(revision.status, "succeeded");
  const first = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t11-review-vote-1-${suffix}`,
    actor: runtimeActor("reviewer-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: expectedRevision + 1,
    command: {
      type: "review.recheck.submit",
      topicId: fixture.topicId,
      recheckId: `t11-recheck-1-${suffix}`,
      revisionId,
      reviewerParticipantId: `${suffix}-reviewer`,
      reviewerSessionId: fixture.sessionFor("reviewer-member"),
      result: "PASS",
      conditions: [],
      evidenceRefs: ["reviewer-pass"],
    },
  });
  assert.equal(first.status, "succeeded");
  const second = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `t11-review-vote-2-${suffix}`,
    actor: runtimeActor("software-architect-member"),
    consumerId: "runtime-reviewer",
    expectedRevision: expectedRevision + 2,
    command: {
      type: "review.recheck.submit",
      topicId: fixture.topicId,
      recheckId: `t11-recheck-2-${suffix}`,
      revisionId,
      reviewerParticipantId: `${suffix}-fresh-reviewer`,
      reviewerSessionId: fixture.sessionFor("software-architect-member"),
      result: "PASS",
      conditions: [],
      evidenceRefs: ["fresh-reviewer-pass"],
    },
  });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") throw new Error("unreachable");
  assert.equal(second.value.gateResult?.result, "PASS");
  return second.value;
};

describe("Product Review Runtime", () => {
  it("appends an immutable Project Spec Revision with a canonical hash bound to the Product Baseline", () => {
    const database = openCompanyDatabase(
      mkdtempSync(join(tmpdir(), "sandcastle-product-review-")),
    );
    try {
      const fixture = createFormalProductRun(database);
      const content = {
        outcome: "Customers submit checkout exactly once.",
        acceptanceCriteria: ["Duplicate submission creates one order."],
        applicationBoundaries: ["checkout-web", "orders-api"],
        crossApplicationContracts: ["checkout-submit-v1"],
        deliveryConstraints: [
          "Local-first Company Runtime remains authoritative.",
        ],
      };
      const result = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-project-spec-r1",
        actor: {
          type: "runtime-worker",
          id: "product-planner-member",
          authenticatedBy: "runtime",
        },
        consumerId: "runtime-product-manager",
        expectedRevision: 0,
        command: {
          type: "project-spec.revise",
          runId: fixture.baseline.runId,
          producerSessionId: fixture.ownerSession.id,
          content,
        },
      });

      assert.equal(result.status, "succeeded");
      if (result.status !== "succeeded") return;
      const revision = result.value.specRevisions[0]!;
      assert.equal(revision.revision, 1);
      assert.equal(revision.productBaselineId, fixture.baseline.id);
      assert.equal(revision.productBaselineHash, fixture.baseline.hash);
      assert.equal(revision.hash, hash(content));
      assert.deepEqual(revision.content, content);
      assert.deepEqual(
        database.commandRegistry.execute({
          schemaVersion: 1,
          commandId: "t11-project-spec-r1",
          actor: runtimeActor("product-planner-member"),
          consumerId: "runtime-product-manager",
          expectedRevision: 0,
          command: {
            type: "project-spec.revise",
            runId: fixture.baseline.runId,
            producerSessionId: fixture.ownerSession.id,
            content,
          },
        }),
        result,
      );
      const conflicting = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-project-spec-r1",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 0,
        command: {
          type: "project-spec.revise",
          runId: fixture.baseline.runId,
          producerSessionId: fixture.ownerSession.id,
          content: { ...content, outcome: "Conflicting content." },
        },
      });
      assert.equal(conflicting.status, "rejected");
      if (conflicting.status !== "rejected") return;
      assert.equal(conflicting.error.code, "COMMAND_ID_REUSE");
    } finally {
      database.close();
    }
  });

  it("starts Product Review from the exact Baseline and Spec while keeping the Product manager owner-only", () => {
    const database = openCompanyDatabase(
      mkdtempSync(join(tmpdir(), "sandcastle-product-review-")),
    );
    try {
      const fixture = createFormalProductRun(database);
      const spec = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-project-spec-review-r1",
        actor: {
          type: "runtime-worker",
          id: "product-planner-member",
          authenticatedBy: "runtime",
        },
        consumerId: "runtime-product-manager",
        expectedRevision: 0,
        command: {
          type: "project-spec.revise",
          runId: fixture.baseline.runId,
          producerSessionId: fixture.ownerSession.id,
          content: {
            outcome: "Customers submit checkout exactly once.",
            acceptanceCriteria: ["Duplicate submission creates one order."],
            applicationBoundaries: ["checkout-web", "orders-api"],
            crossApplicationContracts: ["checkout-submit-v1"],
            deliveryConstraints: ["Remain local-first."],
          },
        },
      });
      assert.equal(spec.status, "succeeded");
      if (spec.status !== "succeeded") return;
      const revision = spec.value.specRevisions[0]!;
      const sessionFor = (aiMemberId: string) => {
        const session = database.interaction.createSession({
          projectId: fixture.project.id,
          mode: "consultation",
        });
        database.interaction.addParticipant({
          sessionId: session.id,
          participantType: "ai-member",
          participantRef: aiMemberId,
          role: "review-participant",
        });
        return session.id;
      };
      const started = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-product-review-start",
        actor: {
          type: "runtime-worker",
          id: "product-planner-member",
          authenticatedBy: "runtime",
        },
        consumerId: "runtime-product-manager",
        expectedRevision: 1,
        command: {
          type: "product-review.start",
          runId: fixture.baseline.runId,
          topicId: "t11-product-topic",
          projectSpecRevisionId: revision.id,
          projectSpecHash: revision.hash,
          participants: [
            {
              id: "product-owner",
              role: "owner-participant",
              aiMemberId: "product-planner-member",
              positionId: "product-planner",
              sessionId: fixture.ownerSession.id,
            },
            {
              id: "product-moderator",
              role: "moderator",
              aiMemberId: "evaluator-member",
              positionId: "evaluator",
              sessionId: sessionFor("evaluator-member"),
            },
            {
              id: "product-reviewer",
              role: "reviewer-participant",
              aiMemberId: "reviewer-member",
              positionId: "reviewer",
              sessionId: sessionFor("reviewer-member"),
            },
            {
              id: "product-fresh-reviewer",
              role: "reviewer-participant",
              aiMemberId: "software-architect-member",
              positionId: "software-architect",
              sessionId: sessionFor("software-architect-member"),
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
      if (started.status !== "succeeded") return;
      const topic = started.value.reviewTopics[0]!;
      assert.equal(topic.topic.manifest.scope, "product");
      if (topic.topic.manifest.scope !== "product") return;
      assert.equal(topic.topic.manifest.productBaselineId, fixture.baseline.id);
      assert.equal(
        topic.topic.manifest.productBaselineHash,
        fixture.baseline.hash,
      );
      assert.equal(topic.topic.manifest.projectSpecRevisionId, revision.id);
      assert.equal(topic.topic.manifest.projectSpecHash, revision.hash);
      assert.deepEqual(
        topic.participants.map((participant: any) => ({
          id: participant.id,
          eligible: participant.eligibility.eligible,
        })),
        [
          { id: "product-owner", eligible: false },
          { id: "product-moderator", eligible: false },
          { id: "product-reviewer", eligible: true },
          { id: "product-fresh-reviewer", eligible: true },
        ],
      );
    } finally {
      database.close();
    }
  });

  it("persists readiness blockers and keeps the formal Run blocked", () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-product-review-blocked-"),
    );
    const database = openCompanyDatabase(companyDir);
    const fixture = createStartedProductReview(database, "blocked");
    const recorded = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "t11-readiness-blocked",
      actor: runtimeActor("product-planner-member"),
      consumerId: "runtime-product-manager",
      expectedRevision: 0,
      command: {
        type: "product-readiness.record",
        runId: fixture.baseline.runId,
        evidenceId: "readiness-dependency-blocked",
        projectSpecRevisionId: fixture.spec.id,
        projectSpecHash: fixture.spec.hash,
        producerSessionId: fixture.ownerSession.id,
        checkKey: "external-dependency",
        status: "blocked",
        summary: "The checkout dependency contract is not ready.",
        evidenceRefs: ["dependency-check-log"],
      },
    });
    assert.equal(recorded.status, "succeeded");
    if (recorded.status !== "succeeded") return;
    assert.deepEqual(recorded.value.readinessBlockers, [
      "readiness-dependency-blocked",
    ]);
    assert.equal(
      database.pipelineRuntime.inspectRun(fixture.baseline.runId).run.status,
      "blocked",
    );
    database.close();

    const reopened = openCompanyDatabase(companyDir);
    try {
      assert.deepEqual(
        reopened.productReview.inspect(fixture.baseline.runId)
          .readinessBlockers,
        ["readiness-dependency-blocked"],
      );
      assert.equal(
        reopened.pipelineRuntime.inspectRun(fixture.baseline.runId).run.status,
        "blocked",
      );
    } finally {
      reopened.close();
    }
  });

  it("promotes only an exact PASS gate and readiness set into one child Snapshot Revision", () => {
    const database = openCompanyDatabase(
      mkdtempSync(join(tmpdir(), "sandcastle-product-review-promote-")),
    );
    try {
      const fixture = createStartedProductReview(database, "promote");
      const readiness = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-readiness-ready",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 0,
        command: {
          type: "product-readiness.record",
          runId: fixture.baseline.runId,
          evidenceId: "readiness-contracts-ready",
          projectSpecRevisionId: fixture.spec.id,
          projectSpecHash: fixture.spec.hash,
          producerSessionId: fixture.ownerSession.id,
          checkKey: "application-contracts",
          status: "ready",
          summary: "Application boundaries and contracts are explicit.",
          evidenceRefs: ["contract-readiness-report"],
        },
      });
      assert.equal(readiness.status, "succeeded");
      passProductReview(database, fixture, 1, "promote");

      const mismatch = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-promote-mismatch",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 1,
        command: {
          type: "product-gate.promote",
          runId: fixture.baseline.runId,
          topicId: fixture.topicId,
          projectSpecRevisionId: fixture.spec.id,
          projectSpecHash:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          readinessEvidenceIds: ["readiness-contracts-ready"],
        },
      });
      assert.equal(mismatch.status, "rejected");
      if (mismatch.status !== "rejected") return;
      assert.equal(mismatch.error.code, "SPEC_CONTRACT_MISMATCH");

      const envelope = {
        schemaVersion: 1 as const,
        commandId: "t11-promote-pass",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 1,
        command: {
          type: "product-gate.promote" as const,
          runId: fixture.baseline.runId,
          topicId: fixture.topicId,
          projectSpecRevisionId: fixture.spec.id,
          projectSpecHash: fixture.spec.hash,
          readinessEvidenceIds: ["readiness-contracts-ready"],
        },
      };
      const promoted = database.commandRegistry.execute(envelope);
      assert.equal(promoted.status, "succeeded");
      if (promoted.status !== "succeeded") return;
      assert.deepEqual(database.commandRegistry.execute(envelope), promoted);
      assert.equal(promoted.value.snapshotLineage.length, 2);
      assert.equal(promoted.value.snapshotLineage[1]?.parentRevision, 1);
      assert.equal(
        promoted.value.promotion?.sourceSnapshotRevisionId,
        fixture.baseline.snapshotRevisionId,
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(fixture.baseline.runId).snapshot
          .payload.productGatePromotion?.acceptedProjectSpecRevisionId,
        fixture.spec.id,
      );
      assert.deepEqual(
        database.events
          .readAfter(0, 200)
          .filter((event) =>
            ["product-gate.passed", "snapshot.promoted"].includes(event.type),
          )
          .map((event) => event.type),
        ["product-gate.passed", "snapshot.promoted"],
      );
    } finally {
      database.close();
    }
  });

  it("keeps a reviewer-owned scope-changing Finding as a permanent promotion block after disposition", () => {
    const database = openCompanyDatabase(
      mkdtempSync(join(tmpdir(), "sandcastle-product-review-scope-")),
    );
    try {
      const fixture = createStartedProductReview(database, "scope");
      const finding = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-scope-finding",
        actor: runtimeActor("reviewer-member"),
        consumerId: "runtime-reviewer",
        expectedRevision: 1,
        command: {
          type: "review.finding.submit",
          topicId: fixture.topicId,
          findingId: "scope-changing-finding",
          reviewerParticipantId: "scope-reviewer",
          reviewerSessionId: fixture.sessions.reviewer,
          severity: "high",
          summary: "The confirmed scope must include refund handling.",
          rationale: "The current Product Baseline excludes a required flow.",
          impact: "Confirmed scope changes.",
          evidenceRefs: ["refund-flow-evidence"],
          suggestedOwner: "scope-owner",
          blocking: false,
          scopeImpact: "scope-changing",
        },
      });
      assert.equal(finding.status, "succeeded");
      const disposition = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-scope-disposition",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 2,
        command: {
          type: "review.finding.disposition",
          topicId: fixture.topicId,
          resolutionId: "scope-resolution",
          findingId: "scope-changing-finding",
          participantId: "scope-owner",
          disposition: "rejected",
          response: "The owner does not accept the proposed scope change.",
          evidenceRefs: [],
        },
      });
      assert.equal(disposition.status, "succeeded");
      passProductReview(database, fixture, 3, "scope");
      const readiness = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-scope-readiness",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 0,
        command: {
          type: "product-readiness.record",
          runId: fixture.baseline.runId,
          evidenceId: "scope-readiness-ready",
          projectSpecRevisionId: fixture.spec.id,
          projectSpecHash: fixture.spec.hash,
          producerSessionId: fixture.ownerSession.id,
          checkKey: "scope-readiness",
          status: "ready",
          summary: "All scope-preserving readiness checks pass.",
          evidenceRefs: ["scope-readiness-report"],
        },
      });
      assert.equal(readiness.status, "succeeded");
      const blocked = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "t11-scope-promote",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-product-manager",
        expectedRevision: 1,
        command: {
          type: "product-gate.promote",
          runId: fixture.baseline.runId,
          topicId: fixture.topicId,
          projectSpecRevisionId: fixture.spec.id,
          projectSpecHash: fixture.spec.hash,
          readinessEvidenceIds: ["scope-readiness-ready"],
        },
      });
      assert.equal(blocked.status, "rejected");
      if (blocked.status !== "rejected") return;
      assert.equal(
        blocked.error.code,
        "PRODUCT_SCOPE_CHANGE_RECONFIRM_REQUIRED",
      );
      assert.equal(
        database.productReview.inspect(fixture.baseline.runId).promotion,
        null,
      );
      assert.equal(
        database.review.inspect(fixture.topicId).findings[0]?.scopeImpact,
        "scope-changing",
      );
    } finally {
      database.close();
    }
  });

  it("rolls back a promotion crash without a partial Snapshot and retries the same Command after restart", () => {
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-product-review-crash-"),
    );
    let crash = true;
    const database = openCompanyDatabase(companyDir, {
      productReviewRuntime: {
        promotionFailure: (point) => {
          if (crash && point === "after-snapshot") {
            throw new Error("simulated product promotion crash");
          }
        },
      },
    });
    const fixture = createStartedProductReview(database, "crash");
    const readiness = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "t11-crash-readiness",
      actor: runtimeActor("product-planner-member"),
      consumerId: "runtime-product-manager",
      expectedRevision: 0,
      command: {
        type: "product-readiness.record",
        runId: fixture.baseline.runId,
        evidenceId: "crash-readiness-ready",
        projectSpecRevisionId: fixture.spec.id,
        projectSpecHash: fixture.spec.hash,
        producerSessionId: fixture.ownerSession.id,
        checkKey: "crash-safety",
        status: "ready",
        summary: "Promotion recovery is ready.",
        evidenceRefs: ["crash-safety-test"],
      },
    });
    assert.equal(readiness.status, "succeeded");
    passProductReview(database, fixture, 1, "crash");
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "t11-crash-promote",
      actor: runtimeActor("product-planner-member"),
      consumerId: "runtime-product-manager",
      expectedRevision: 1,
      command: {
        type: "product-gate.promote" as const,
        runId: fixture.baseline.runId,
        topicId: fixture.topicId,
        projectSpecRevisionId: fixture.spec.id,
        projectSpecHash: fixture.spec.hash,
        readinessEvidenceIds: ["crash-readiness-ready"],
      },
    };
    assert.throws(
      () => database.commandRegistry.execute(envelope),
      /simulated product promotion crash/,
    );
    assert.equal(
      database.productReview.inspect(fixture.baseline.runId).snapshotLineage
        .length,
      1,
    );
    assert.equal(
      database.productReview.inspect(fixture.baseline.runId).promotion,
      null,
    );
    database.close();

    crash = false;
    const reopened = openCompanyDatabase(companyDir);
    try {
      const promoted = reopened.commandRegistry.execute(envelope);
      assert.equal(promoted.status, "succeeded");
      if (promoted.status !== "succeeded") return;
      assert.equal(promoted.value.snapshotLineage.length, 2);
      assert.deepEqual(reopened.commandRegistry.execute(envelope), promoted);
    } finally {
      reopened.close();
    }
  });
});
