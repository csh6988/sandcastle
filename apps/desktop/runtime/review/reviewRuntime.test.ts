import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { companyRuntimeAddress } from "../address.js";
import { createCompanyRuntimeClient } from "../client.js";
import { startCompanyRuntimeServer } from "../server.js";
import { ReviewInputManifestSchema } from "../interface.js";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import { openReviewRuntime, ReviewRuntimeError } from "./reviewRuntime.js";

const companyDirs: string[] = [];

const tempCompanyDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-review-"));
  companyDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of companyDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

const createReviewFixture = (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
  budget = {
    maxRounds: 2,
    maxDurationSeconds: 600,
    maxTokens: 8_000,
    maxCostCents: 250,
  },
) => {
  const project = database.catalog.createProject({
    name: `Review ${suffix}`,
    goal: "Review an exact code revision independently",
  });
  const sessionFor = (aiMemberId: string) => {
    const session = database.interaction.createSession({
      projectId: project.id,
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
    owner: sessionFor("product-planner-member"),
    moderator: sessionFor("evaluator-member"),
    producer: sessionFor("software-engineer-member"),
    reviewer: sessionFor("reviewer-member"),
    freshReviewer: sessionFor("software-architect-member"),
  };
  const topicId = `review-topic-${suffix}`;
  const manifest = {
    scope: "code" as const,
    topicId,
    supportingArtifactVersionIds: [`artifact-${suffix}`],
    supportingSpecRevisionIds: [`spec-${suffix}`],
    harnessSnapshotIds: [`harness-${suffix}`],
    acceptanceCriteria: ["The exact diff passes its contract tests."],
    excludedContext: [
      "hidden-prompts" as const,
      "prior-reviewer-opinions" as const,
      "private-transcripts" as const,
    ],
    workPackageVersionId: `work-package-${suffix}`,
    repositoryId: `repository-${suffix}`,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    diffArtifactVersionId: `diff-artifact-${suffix}`,
    diffHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const command = {
    type: "review.topic.create" as const,
    topicId,
    projectId: project.id,
    title: `Independent code review ${suffix}`,
    manifest,
    producer: {
      aiMemberId: "software-engineer-member",
      positionId: "software-engineer",
      sessionId: sessions.producer,
    },
    participants: [
      {
        id: `${suffix}-owner`,
        role: "owner-participant" as const,
        aiMemberId: "product-planner-member",
        positionId: "product-planner",
        sessionId: sessions.owner,
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
        id: `${suffix}-fresh-reviewer`,
        role: "reviewer-participant" as const,
        aiMemberId: "software-architect-member",
        positionId: "software-architect",
        sessionId: sessions.freshReviewer,
      },
    ],
    budget,
    stopCondition: "blocking-findings-dispositioned" as const,
    escalationPolicy: "fail-with-evidence" as const,
  };
  const envelopeFor = (commandId: string, expectedRevision: number) => ({
    schemaVersion: 1 as const,
    commandId,
    actor: {
      type: "test-driver" as const,
      id: "review-test",
      authenticatedBy: "ipc-token" as const,
    },
    consumerId: "review-test-consumer",
    expectedRevision,
  });
  const created = database.commandRegistry.execute({
    ...envelopeFor(`create-${suffix}`, 0),
    command,
  });
  assert.equal(created.status, "succeeded");
  return {
    project,
    sessions,
    topicId,
    manifest,
    command,
    envelopeFor,
    sessionFor,
  };
};

describe("Review Runtime", () => {
  it("creates a Topic with a frozen exact manifest, eligible reviewers, and default quorum", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Review engine",
        goal: "Review an exact code revision independently",
      });
      const sessionFor = (aiMemberId: string) => {
        const session = database.interaction.createSession({
          projectId: project.id,
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
      const ownerSessionId = sessionFor("product-planner-member");
      const moderatorSessionId = sessionFor("evaluator-member");
      const producerSessionId = sessionFor("software-engineer-member");
      const reviewerSessionId = sessionFor("reviewer-member");
      const freshReviewerSessionId = sessionFor("software-architect-member");

      const manifest = {
        scope: "code" as const,
        topicId: "review-topic-1",
        supportingArtifactVersionIds: ["artifact-evidence-1"],
        supportingSpecRevisionIds: ["spec-r3"],
        harnessSnapshotIds: ["harness-r2"],
        acceptanceCriteria: ["The exact diff passes its contract tests."],
        excludedContext: [
          "hidden-prompts" as const,
          "prior-reviewer-opinions" as const,
          "private-transcripts" as const,
        ],
        workPackageVersionId: "work-package-v4",
        repositoryId: "repository-1",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        diffArtifactVersionId: "diff-artifact-v4",
        diffHash:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "review-topic-create-command-1",
        actor: {
          type: "test-driver" as const,
          id: "review-test",
          authenticatedBy: "ipc-token" as const,
        },
        consumerId: "review-test-consumer",
        expectedRevision: 0,
        command: {
          type: "review.topic.create" as const,
          topicId: manifest.topicId,
          projectId: project.id,
          title: "Independent code review",
          manifest,
          producer: {
            aiMemberId: "software-engineer-member",
            positionId: "software-engineer",
            sessionId: producerSessionId,
          },
          participants: [
            {
              id: "owner",
              role: "owner-participant" as const,
              aiMemberId: "product-planner-member",
              positionId: "product-planner",
              sessionId: ownerSessionId,
            },
            {
              id: "moderator",
              role: "moderator" as const,
              aiMemberId: "evaluator-member",
              positionId: "evaluator",
              sessionId: moderatorSessionId,
            },
            {
              id: "producer-as-reviewer",
              role: "reviewer-participant" as const,
              aiMemberId: "software-engineer-member",
              positionId: "software-engineer",
              sessionId: producerSessionId,
            },
            {
              id: "reviewer",
              role: "reviewer-participant" as const,
              aiMemberId: "reviewer-member",
              positionId: "reviewer",
              sessionId: reviewerSessionId,
            },
            {
              id: "fresh-reviewer",
              role: "reviewer-participant" as const,
              aiMemberId: "software-architect-member",
              positionId: "software-architect",
              sessionId: freshReviewerSessionId,
            },
          ],
          budget: {
            maxRounds: 2,
            maxDurationSeconds: 600,
            maxTokens: 8_000,
            maxCostCents: 250,
          },
          stopCondition: "blocking-findings-dispositioned" as const,
          escalationPolicy: "fail-with-evidence" as const,
        },
      };

      const created = database.commandRegistry.execute(envelope);
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded") return;
      assert.deepEqual(database.commandRegistry.execute(envelope), created);
      assert.equal(created.value.topic.id, manifest.topicId);
      assert.equal(created.value.topic.status, "independent-review");
      assert.equal(created.value.topic.revision, 1);
      assert.equal(created.value.topic.quorum, 2);
      assert.equal(created.value.topic.manifestHash, hash(manifest));
      assert.deepEqual(created.value.topic.manifest, manifest);
      assert.deepEqual(
        created.value.participants.map((participant) => ({
          id: participant.id,
          eligible: participant.eligibility.eligible,
          reasons: participant.eligibility.reasons,
        })),
        [
          { id: "owner", eligible: false, reasons: ["role-excluded"] },
          { id: "moderator", eligible: false, reasons: ["role-excluded"] },
          {
            id: "producer-as-reviewer",
            eligible: false,
            reasons: [
              "producer-ai-member",
              "producer-position",
              "producer-session",
            ],
          },
          { id: "reviewer", eligible: true, reasons: [] },
          { id: "fresh-reviewer", eligible: true, reasons: [] },
        ],
      );
      assert.deepEqual(
        database.review.inspect(manifest.topicId),
        created.value,
      );
      assert.ok(created.effectIds.length > 0);
      const event = database.events
        .readAfter(0, 100)
        .find((candidate) => candidate.type === "review.scheduled");
      assert.equal(event?.topicId, manifest.topicId);
      assert.equal(event?.projectId, project.id);
      assert.equal(
        ReviewInputManifestSchema.safeParse({
          ...manifest,
          rawCredential: "must-not-cross-the-review-boundary",
        }).success,
        false,
      );
    } finally {
      database.close();
    }
  });

  it("preserves findings through bounded discussion and produces a fresh unanimous PASS", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createReviewFixture(database, "lifecycle");
      const impersonated = database.commandRegistry.execute({
        ...fixture.envelopeFor("finding-impersonated", 1),
        actor: {
          type: "human" as const,
          id: "local-user",
          authenticatedBy: "local-session" as const,
        },
        command: {
          type: "review.finding.submit" as const,
          topicId: fixture.topicId,
          findingId: "finding-impersonated",
          reviewerParticipantId: "lifecycle-reviewer",
          reviewerSessionId: fixture.sessions.reviewer,
          severity: "high" as const,
          summary: "Impersonated finding",
          rationale: "The caller does not own this reviewer identity.",
          impact: "Review evidence would be forged.",
          evidenceRefs: ["manifest:lifecycle"],
          suggestedOwner: "lifecycle-owner",
          blocking: true,
        },
      });
      assert.equal(impersonated.status, "rejected");
      if (impersonated.status !== "rejected") return;
      assert.equal(impersonated.error.code, "REVIEW_ACTOR_MISMATCH");
      const finding = database.commandRegistry.execute({
        ...fixture.envelopeFor("finding-lifecycle", 1),
        command: {
          type: "review.finding.submit" as const,
          topicId: fixture.topicId,
          findingId: "finding-lifecycle-1",
          reviewerParticipantId: "lifecycle-reviewer",
          reviewerSessionId: fixture.sessions.reviewer,
          severity: "high" as const,
          summary: "The retry path lacks evidence.",
          rationale: "The exact diff does not cover recovery.",
          impact: "A crashed operation could remain ambiguous.",
          evidenceRefs: ["test-log-before-revision"],
          suggestedOwner: "lifecycle-owner",
          blocking: true,
        },
      });
      assert.equal(finding.status, "succeeded");
      if (finding.status !== "succeeded") return;
      assert.equal(finding.value.findings.length, 1);
      const integrity = new DatabaseSync(database.path);
      try {
        assert.throws(
          () =>
            integrity
              .prepare("UPDATE review_findings SET summary = ? WHERE id = ?")
              .run("rewritten", "finding-lifecycle-1"),
          /immutable/i,
        );
      } finally {
        integrity.close();
      }
      assert.deepEqual(
        database.commandRegistry.execute({
          ...fixture.envelopeFor("owner-cannot-find", 2),
          command: {
            type: "review.finding.submit" as const,
            topicId: fixture.topicId,
            findingId: "owner-finding",
            reviewerParticipantId: "lifecycle-owner",
            reviewerSessionId: fixture.sessions.owner,
            severity: "low" as const,
            summary: "Owner opinion",
            rationale: "Owners cannot submit independent findings.",
            impact: "Self-approval risk",
            evidenceRefs: ["manifest:lifecycle"],
            suggestedOwner: "lifecycle-owner",
            blocking: false,
          },
        }),
        {
          status: "rejected",
          error: {
            code: "REVIEWER_INELIGIBLE",
            message:
              "Review participant lifecycle-owner is not an eligible reviewer.",
          },
          effectIds: [],
        },
      );

      const disposition = database.commandRegistry.execute({
        ...fixture.envelopeFor("disposition-lifecycle", 2),
        command: {
          type: "review.finding.disposition" as const,
          topicId: fixture.topicId,
          resolutionId: "resolution-lifecycle-1",
          findingId: "finding-lifecycle-1",
          participantId: "lifecycle-owner",
          disposition: "disputed" as const,
          response: "The revision will add crash/restart evidence.",
          evidenceRefs: ["recovery-plan"],
        },
      });
      assert.equal(disposition.status, "succeeded");

      const opened = database.commandRegistry.execute({
        ...fixture.envelopeFor("discussion-open-lifecycle", 3),
        command: {
          type: "review.discussion.open" as const,
          topicId: fixture.topicId,
          discussionId: "discussion-lifecycle-1",
          moderatorParticipantId: "lifecycle-moderator",
          conflictFindingIds: ["finding-lifecycle-1"],
          boundedPrompt: "Resolve only the recovery evidence conflict.",
        },
      });
      assert.equal(opened.status, "succeeded");

      const closed = database.commandRegistry.execute({
        ...fixture.envelopeFor("discussion-close-lifecycle", 4),
        command: {
          type: "review.discussion.close" as const,
          topicId: fixture.topicId,
          discussionId: "discussion-lifecycle-1",
          moderatorParticipantId: "lifecycle-moderator",
          durationSeconds: 90,
          tokensUsed: 900,
          costCentsUsed: 25,
          stopReason: "owner-revision-required",
        },
      });
      assert.equal(closed.status, "succeeded");

      const resolved = database.commandRegistry.execute({
        ...fixture.envelopeFor("resolution-lifecycle", 5),
        command: {
          type: "review.finding.disposition" as const,
          topicId: fixture.topicId,
          resolutionId: "resolution-lifecycle-2",
          findingId: "finding-lifecycle-1",
          participantId: "lifecycle-owner",
          disposition: "resolved" as const,
          response: "Crash/restart evidence is now attached.",
          evidenceRefs: ["crash-restart-test"],
          revisedSubjectId: "diff-artifact-lifecycle-r2",
          revisedSubjectHash:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      });
      assert.equal(resolved.status, "succeeded");

      const revision = database.commandRegistry.execute({
        ...fixture.envelopeFor("revision-lifecycle", 6),
        command: {
          type: "review.revision.submit" as const,
          topicId: fixture.topicId,
          revisionId: "review-revision-lifecycle-1",
          ownerParticipantId: "lifecycle-owner",
          subjectKind: "diff-artifact-version",
          subjectId: "diff-artifact-lifecycle-r2",
          subjectHash:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          producerAiMemberId: "product-planner-member",
          producerPositionId: "product-planner",
          producerSessionId: fixture.sessions.owner,
          evidenceRefs: ["crash-restart-test"],
        },
      });
      assert.equal(revision.status, "succeeded");
      if (revision.status !== "succeeded") return;
      assert.equal(revision.value.topic.status, "re-review");

      const reviewerRecheckSession = fixture.sessionFor("reviewer-member");
      const freshRecheckSession = fixture.sessionFor(
        "software-architect-member",
      );
      const firstVote = database.commandRegistry.execute({
        ...fixture.envelopeFor("recheck-lifecycle-1", 7),
        command: {
          type: "review.recheck.submit" as const,
          topicId: fixture.topicId,
          recheckId: "recheck-lifecycle-1",
          revisionId: "review-revision-lifecycle-1",
          reviewerParticipantId: "lifecycle-reviewer",
          reviewerSessionId: reviewerRecheckSession,
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["crash-restart-test"],
        },
      });
      assert.equal(firstVote.status, "succeeded");
      if (firstVote.status !== "succeeded") return;
      assert.equal(firstVote.value.gateResult, null);

      const secondVoteEnvelope = {
        ...fixture.envelopeFor("recheck-lifecycle-2", 8),
        command: {
          type: "review.recheck.submit" as const,
          topicId: fixture.topicId,
          recheckId: "recheck-lifecycle-2",
          revisionId: "review-revision-lifecycle-1",
          reviewerParticipantId: "lifecycle-fresh-reviewer",
          reviewerSessionId: freshRecheckSession,
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["independent-verification"],
        },
      };
      const passed = database.commandRegistry.execute(secondVoteEnvelope);
      assert.equal(passed.status, "succeeded");
      if (passed.status !== "succeeded") return;
      assert.equal(passed.value.topic.status, "PASS");
      assert.equal(passed.value.gateResult?.result, "PASS");
      assert.equal(passed.value.gateResult?.satisfiesProductionContract, true);
      assert.equal(
        passed.value.gateResult?.manifestHash,
        hash(fixture.manifest),
      );
      assert.deepEqual(
        passed.value.findings.map((candidate) => candidate.id),
        ["finding-lifecycle-1"],
      );
      assert.deepEqual(
        passed.value.resolutions.map((candidate) => candidate.disposition),
        ["disputed", "resolved"],
      );
      assert.deepEqual(
        database.commandRegistry.execute(secondVoteEnvelope),
        passed,
      );
      const gateIntegrity = new DatabaseSync(database.path);
      try {
        assert.throws(
          () =>
            gateIntegrity
              .prepare(
                "UPDATE quality_gate_results SET result = 'FAIL' WHERE topic_id = ?",
              )
              .run(fixture.topicId),
          /immutable/i,
        );
      } finally {
        gateIntegrity.close();
      }
      assert.deepEqual(
        database.commandRegistry.execute({
          ...secondVoteEnvelope,
          command: { ...secondVoteEnvelope.command, result: "FAIL" as const },
        }),
        {
          status: "rejected",
          error: {
            code: "COMMAND_ID_REUSE",
            message:
              "Command recheck-lifecycle-2 was already used for a different request.",
          },
          effectIds: [],
        },
      );
      assert.deepEqual(
        database.events
          .readAfter(0, 100)
          .filter((event) => event.topicId === fixture.topicId)
          .map((event) => event.type),
        [
          "review.scheduled",
          "review.finding.created",
          "review.finding.dispositioned",
          "review.discussion.round",
          "review.discussion.round",
          "review.finding.dispositioned",
          "review.revision.created",
          "review.recheck.completed",
          "review.recheck.completed",
          "quality-gate.completed",
        ],
      );
    } finally {
      database.close();
    }
  });

  it("stops at the frozen discussion budget and records an immutable FAIL Gate Result", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createReviewFixture(database, "budget", {
        maxRounds: 1,
        maxDurationSeconds: 60,
        maxTokens: 100,
        maxCostCents: 10,
      });
      assert.equal(
        database.commandRegistry.execute({
          ...fixture.envelopeFor("finding-budget", 1),
          command: {
            type: "review.finding.submit" as const,
            topicId: fixture.topicId,
            findingId: "finding-budget-1",
            reviewerParticipantId: "budget-reviewer",
            reviewerSessionId: fixture.sessions.reviewer,
            severity: "critical" as const,
            summary: "A critical conflict remains.",
            rationale: "The exact subject lacks required safety evidence.",
            impact: "The subject cannot proceed safely.",
            evidenceRefs: ["critical-evidence"],
            suggestedOwner: "budget-owner",
            blocking: true,
          },
        }).status,
        "succeeded",
      );
      assert.equal(
        database.commandRegistry.execute({
          ...fixture.envelopeFor("disposition-budget", 2),
          command: {
            type: "review.finding.disposition" as const,
            topicId: fixture.topicId,
            resolutionId: "resolution-budget-1",
            findingId: "finding-budget-1",
            participantId: "budget-owner",
            disposition: "disputed" as const,
            response: "The conflict cannot be resolved in the current input.",
            evidenceRefs: ["owner-response"],
          },
        }).status,
        "succeeded",
      );
      assert.equal(
        database.commandRegistry.execute({
          ...fixture.envelopeFor("discussion-open-budget", 3),
          command: {
            type: "review.discussion.open" as const,
            topicId: fixture.topicId,
            discussionId: "discussion-budget-1",
            moderatorParticipantId: "budget-moderator",
            conflictFindingIds: ["finding-budget-1"],
            boundedPrompt: "Attempt one bounded resolution round.",
          },
        }).status,
        "succeeded",
      );
      const failed = database.commandRegistry.execute({
        ...fixture.envelopeFor("discussion-close-budget", 4),
        command: {
          type: "review.discussion.close" as const,
          topicId: fixture.topicId,
          discussionId: "discussion-budget-1",
          moderatorParticipantId: "budget-moderator",
          durationSeconds: 61,
          tokensUsed: 101,
          costCentsUsed: 11,
        },
      });
      assert.equal(failed.status, "succeeded");
      if (failed.status !== "succeeded") return;
      assert.equal(failed.value.topic.status, "FAIL");
      assert.equal(failed.value.gateResult?.result, "FAIL");
      assert.equal(failed.value.gateResult?.satisfiesProductionContract, false);
      assert.equal(failed.value.gateResult?.revisionId, null);
      assert.deepEqual(failed.value.gateResult?.recheckIds, []);
      assert.ok(
        failed.value.gateResult?.evidenceRefs.includes(
          "review-budget-exhausted",
        ),
      );
      assert.deepEqual(
        database.events
          .readAfter(0, 100)
          .filter((event) => event.topicId === fixture.topicId)
          .map((event) => event.type),
        [
          "review.scheduled",
          "review.finding.created",
          "review.finding.dispositioned",
          "review.discussion.round",
          "review.discussion.round",
          "quality-gate.completed",
        ],
      );
    } finally {
      database.close();
    }
  });

  it("requires fresh eligible voters and aggregates CONDITIONAL_PASS without satisfying production", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = createReviewFixture(database, "conditional");
      const revision = database.commandRegistry.execute({
        ...fixture.envelopeFor("revision-conditional", 1),
        command: {
          type: "review.revision.submit" as const,
          topicId: fixture.topicId,
          revisionId: "review-revision-conditional-1",
          ownerParticipantId: "conditional-owner",
          subjectKind: "diff-artifact-version",
          subjectId: "diff-artifact-conditional-r2",
          subjectHash:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          producerAiMemberId: "product-planner-member",
          producerPositionId: "product-planner",
          producerSessionId: fixture.sessions.owner,
          evidenceRefs: ["revised-subject"],
        },
      });
      assert.equal(revision.status, "succeeded");

      const staleSession = database.commandRegistry.execute({
        ...fixture.envelopeFor("recheck-stale-session", 2),
        command: {
          type: "review.recheck.submit" as const,
          topicId: fixture.topicId,
          recheckId: "recheck-stale-session",
          revisionId: "review-revision-conditional-1",
          reviewerParticipantId: "conditional-reviewer",
          reviewerSessionId: fixture.sessions.reviewer,
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["stale-session-evidence"],
        },
      });
      assert.equal(staleSession.status, "rejected");
      if (staleSession.status !== "rejected") return;
      assert.equal(staleSession.error.code, "FRESH_REVIEW_SESSION_REQUIRED");

      const reviewerSession = fixture.sessionFor("reviewer-member");
      const freshReviewerSession = fixture.sessionFor(
        "software-architect-member",
      );
      assert.equal(
        database.commandRegistry.execute({
          ...fixture.envelopeFor("recheck-conditional-1", 2),
          command: {
            type: "review.recheck.submit" as const,
            topicId: fixture.topicId,
            recheckId: "recheck-conditional-1",
            revisionId: "review-revision-conditional-1",
            reviewerParticipantId: "conditional-reviewer",
            reviewerSessionId: reviewerSession,
            result: "CONDITIONAL_PASS" as const,
            conditions: ["verification:test-run-42"],
            evidenceRefs: ["conditional-evidence"],
          },
        }).status,
        "succeeded",
      );
      const conditional = database.commandRegistry.execute({
        ...fixture.envelopeFor("recheck-conditional-2", 3),
        command: {
          type: "review.recheck.submit" as const,
          topicId: fixture.topicId,
          recheckId: "recheck-conditional-2",
          revisionId: "review-revision-conditional-1",
          reviewerParticipantId: "conditional-fresh-reviewer",
          reviewerSessionId: freshReviewerSession,
          result: "PASS" as const,
          conditions: [],
          evidenceRefs: ["pass-evidence"],
        },
      });
      assert.equal(conditional.status, "succeeded");
      if (conditional.status !== "succeeded") return;
      assert.equal(conditional.value.topic.status, "CONDITIONAL_PASS");
      assert.equal(conditional.value.gateResult?.result, "CONDITIONAL_PASS");
      assert.equal(
        conditional.value.gateResult?.satisfiesProductionContract,
        false,
      );
      assert.deepEqual(conditional.value.gateResult?.conditions, [
        "verification:test-run-42",
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back Topic, audit, outbox, and receipt together across crash/restart", () => {
    const companyDir = tempCompanyDir();
    const crashing = openCompanyDatabase(companyDir, {
      reviewRuntime: {
        mutationFailure: () => {
          throw new Error("simulated review process crash");
        },
      },
    });
    assert.throws(
      () => createReviewFixture(crashing, "crash"),
      /simulated review process crash/,
    );
    crashing.close();

    const recovered = openCompanyDatabase(companyDir);
    try {
      assert.deepEqual(recovered.review.list({}), []);
      assert.equal(
        recovered.events
          .readAfter(0, 1_000)
          .some((event) => event.topicId === "review-topic-crash"),
        false,
      );
      const retried = createReviewFixture(recovered, "crash");
      assert.equal(
        recovered.review.inspect(retried.topicId).topic.status,
        "independent-review",
      );
    } finally {
      recovered.close();
    }
  });

  it("replays only an exact aggregate execution authority", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      INSERT INTO positions(
        id, department_id, name, responsibility, ai_member_id, sort_order, created_at
      ) VALUES
        ('developer-position', 'department', 'Developer', 'Produce', 'developer-ai', 1, '2026-07-28T00:00:00.000Z'),
        ('developer-position-b', 'department', 'Developer B', 'Produce', 'developer-ai-b', 2, '2026-07-28T00:00:00.000Z'),
        ('reviewer-position', 'department', 'Reviewer', 'Review', 'reviewer-ai', 3, '2026-07-28T00:00:00.000Z');
      INSERT INTO integration_generations(
        id, project_id, run_id, snapshot_revision_id, node_run_id, generation,
        coverage_id, coverage_node_run_id, coverage_node_attempt_id,
        coverage_hash, manifest_json, manifest_hash, state,
        pass_authority_hash, failure_code, failure_message, created_at, updated_at
      ) VALUES (
        'generation-1', 'project-1', 'run-1', 'snapshot-1', 'integration-node', 1,
        'coverage-1', 'coverage-node', 'coverage-attempt', '${"c".repeat(64)}',
        '{}', '${"a".repeat(64)}', 'aggregate-review', NULL, NULL, NULL,
        '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
      );
      INSERT INTO work_package_assignments(
        id, work_package_version_id, node_attempt_id, position_id, ai_member_id,
        agent_adapter_id, rationale_json, allocation_id, interaction_session_id,
        sandbox_identity, evidence_scope, state, created_at, updated_at
      ) VALUES
        ('assignment-1', 'version-1', 'attempt-1', 'developer-position',
         'developer-ai', 'scripted', '{}', 'allocation-1', 'developer-session',
         'sandbox-1', 'evidence-1', 'self-check-passed',
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
        ('assignment-2', 'version-2', 'attempt-2', 'developer-position-b',
         'developer-ai-b', 'scripted', '{}', 'allocation-2', 'developer-session-b',
         'sandbox-2', 'evidence-2', 'self-check-passed',
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
      INSERT INTO integration_operations(
        id, generation_id, repository_result_id, work_package_id,
        work_package_version_id, authority_id, quality_gate_result_id, ordinal,
        source_branch, source_commit, diff_hash, expected_tip, request_json,
        request_hash, idempotency_key, state, receipt_json, receipt_hash,
        resulting_commit, failure_code, failure_message, created_at, updated_at
      ) VALUES
        ('operation-1', 'generation-1', 'repository-result-1', 'package-1',
         'version-1', 'authority-1', 'gate-1', 0, 'work/package-1',
         '${"1".repeat(40)}', '${"2".repeat(64)}', '${"3".repeat(40)}', '{}',
         '${"4".repeat(64)}', 'integration:generation-1:operation-1', 'succeeded',
         '{}', '${"5".repeat(64)}', '${"6".repeat(40)}', NULL, NULL,
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
        ('operation-2', 'generation-1', 'repository-result-2', 'package-2',
         'version-2', 'authority-2', 'gate-2', 1, 'work/package-2',
         '${"7".repeat(40)}', '${"8".repeat(64)}', '${"9".repeat(40)}', '{}',
         '${"b".repeat(64)}', 'integration:generation-1:operation-2', 'succeeded',
         '{}', '${"c".repeat(64)}', '${"d".repeat(40)}', NULL, NULL,
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
    `);
    database
      .prepare(
        `INSERT INTO interaction_sessions(
           id, mode, project_id, run_id, node_run_id, status, created_at, closed_at
         ) VALUES ('aggregate-session', 'run-collaboration', 'project-1',
                   'run-1', 'integration-node', 'active', ?, NULL)`,
      )
      .run("2026-07-28T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO session_participants(
           id, session_id, participant_type, participant_ref, role, created_at
         ) VALUES ('aggregate-participant', 'aggregate-session', 'ai-member',
                   'reviewer-ai', 'aggregate-reviewer:generation-1', ?)`,
      )
      .run("2026-07-28T00:00:00.000Z");
    const runtime = openReviewRuntime(database, {
      events: { append: () => ({}) as never },
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    const input = {
      commandId: "generation-1:aggregate-review:record",
      actor: {
        type: "runtime-worker" as const,
        id: "integration-node-handler",
        authenticatedBy: "runtime" as const,
      },
      topicId: "integration-review:generation-1",
      projectId: "project-1",
      runId: "run-1",
      manifest: {
        scope: "aggregate" as const,
        topicId: "integration-review:generation-1",
        supportingArtifactVersionIds: [],
        supportingSpecRevisionIds: [],
        harnessSnapshotIds: [],
        acceptanceCriteria: ["npm test"],
        excludedContext: [
          "hidden-prompts" as const,
          "prior-reviewer-opinions" as const,
          "private-transcripts" as const,
        ],
        integrationGenerationId: "generation-1",
        integrationManifestHash: "a".repeat(64),
        repositoryCommits: [
          { repositoryId: "repository-1", commit: "b".repeat(40) },
        ],
      },
      producer: {
        aiMemberId: "developer-ai",
        positionId: "developer-position",
        sessionId: "developer-session",
      },
      reviewer: {
        participantId: "aggregate-participant",
        aiMemberId: "reviewer-ai",
        positionId: "reviewer-position",
        sessionId: "aggregate-session",
      },
      terminalExecutionFactId: "aggregate-terminal-fact",
      result: "PASS" as const,
      conditions: [],
      evidenceRefs: [
        "execution-fact:aggregate-terminal-fact",
        "isolation-receipt",
      ],
    };

    database.exec("BEGIN IMMEDIATE");
    const first = runtime.recordAggregateExecutionInTransaction(input);
    database.exec("COMMIT");
    const eligibility = JSON.parse(
      String(
        database
          .prepare(
            "SELECT eligibility_snapshot_json AS value FROM review_participants WHERE id = ?",
          )
          .get(input.reviewer.participantId)!.value,
      ),
    ) as { readonly producerLineage: readonly unknown[] };
    assert.equal(eligibility.producerLineage.length, 2);
    database.exec("BEGIN IMMEDIATE");
    const replay = runtime.recordAggregateExecutionInTransaction(input);
    database.exec("COMMIT");
    assert.deepEqual(replay, first);

    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        runtime.recordAggregateExecutionInTransaction({
          ...input,
          result: "FAIL",
        }),
      (error: unknown) =>
        error instanceof ReviewRuntimeError &&
        error.code === "REVIEW_AGGREGATE_EXECUTION_CONFLICT",
    );
    database.exec("ROLLBACK");
    assert.equal(runtime.inspect(input.topicId).gateResult?.result, "PASS");
    database.close();
  });

  it("rejects an aggregate Reviewer who matches any frozen producer identity", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const now = "2026-07-28T00:00:00.000Z";
    database.exec(`
      INSERT INTO positions(
        id, department_id, name, responsibility, ai_member_id, sort_order, created_at
      ) VALUES
        ('developer-position-a', 'department', 'Developer A', 'Produce', 'developer-ai-a', 1, '${now}'),
        ('developer-position-b', 'department', 'Developer B', 'Produce', 'developer-ai-b', 2, '${now}');
      INSERT INTO interaction_sessions(
        id, mode, project_id, run_id, node_run_id, status, created_at, closed_at
      ) VALUES
        ('developer-session-a', 'run-collaboration', 'project-1', 'run-1', 'development-node-a', 'active', '${now}', NULL),
        ('developer-session-b', 'run-collaboration', 'project-1', 'run-1', 'integration-node', 'active', '${now}', NULL);
      INSERT INTO session_participants(
        id, session_id, participant_type, participant_ref, role, created_at
      ) VALUES
        ('aggregate-participant', 'developer-session-b', 'ai-member',
         'developer-ai-b', 'aggregate-reviewer:generation-1', '${now}');
      INSERT INTO integration_generations(
        id, project_id, run_id, snapshot_revision_id, node_run_id, generation,
        coverage_id, coverage_node_run_id, coverage_node_attempt_id,
        coverage_hash, manifest_json, manifest_hash, state,
        pass_authority_hash, failure_code, failure_message, created_at, updated_at
      ) VALUES (
        'generation-1', 'project-1', 'run-1', 'snapshot-1', 'integration-node', 1,
        'coverage-1', 'coverage-node', 'coverage-attempt', '${"c".repeat(64)}',
        '{}', '${"d".repeat(64)}', 'aggregate-review', NULL, NULL, NULL,
        '${now}', '${now}'
      );
      INSERT INTO work_package_assignments(
        id, work_package_version_id, node_attempt_id, position_id, ai_member_id,
        agent_adapter_id, rationale_json, allocation_id, interaction_session_id,
        sandbox_identity, evidence_scope, state, created_at, updated_at
      ) VALUES
        ('assignment-a', 'version-a', 'attempt-a', 'developer-position-a',
         'developer-ai-a', 'scripted', '{}', 'allocation-a', 'developer-session-a',
         'sandbox-a', 'evidence-a', 'self-check-passed', '${now}', '${now}'),
        ('assignment-b', 'version-b', 'attempt-b', 'developer-position-b',
         'developer-ai-b', 'scripted', '{}', 'allocation-b', 'developer-session-b',
         'sandbox-b', 'evidence-b', 'self-check-passed', '${now}', '${now}');
      INSERT INTO integration_operations(
        id, generation_id, repository_result_id, work_package_id,
        work_package_version_id, authority_id, quality_gate_result_id, ordinal,
        source_branch, source_commit, diff_hash, expected_tip, request_json,
        request_hash, idempotency_key, state, receipt_json, receipt_hash,
        resulting_commit, failure_code, failure_message, created_at, updated_at
      ) VALUES
        ('operation-a', 'generation-1', 'repository-a', 'package-a', 'version-a',
         'authority-a', 'gate-a', 0, 'work/a', '${"1".repeat(40)}',
         '${"2".repeat(64)}', '${"3".repeat(40)}', '{}', '${"4".repeat(64)}',
         'integration:generation-1:operation-a', 'succeeded', '{}', '${"5".repeat(64)}',
         '${"6".repeat(40)}', NULL, NULL, '${now}', '${now}'),
        ('operation-b', 'generation-1', 'repository-b', 'package-b', 'version-b',
         'authority-b', 'gate-b', 1, 'work/b', '${"7".repeat(40)}',
         '${"8".repeat(64)}', '${"9".repeat(40)}', '{}', '${"a".repeat(64)}',
         'integration:generation-1:operation-b', 'succeeded', '{}', '${"b".repeat(64)}',
         '${"c".repeat(40)}', NULL, NULL, '${now}', '${now}');
    `);
    const runtime = openReviewRuntime(database, {
      events: { append: () => ({}) as never },
      clock: () => new Date(now),
    });
    const manifest = {
      scope: "aggregate" as const,
      topicId: "integration-review:generation-1",
      supportingArtifactVersionIds: [],
      supportingSpecRevisionIds: [],
      harnessSnapshotIds: [],
      acceptanceCriteria: ["npm test"],
      excludedContext: [
        "hidden-prompts" as const,
        "prior-reviewer-opinions" as const,
        "private-transcripts" as const,
      ],
      integrationGenerationId: "generation-1",
      integrationManifestHash: "d".repeat(64),
      repositoryCommits: [
        { repositoryId: "repository-1", commit: "e".repeat(40) },
      ],
    };

    database.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(
        () =>
          runtime.recordAggregateExecutionInTransaction({
            commandId: "generation-1:aggregate-review:record",
            actor: {
              type: "runtime-worker",
              id: "integration-node-handler",
              authenticatedBy: "runtime",
            },
            topicId: manifest.topicId,
            projectId: "project-1",
            runId: "run-1",
            manifest,
            producer: {
              aiMemberId: "developer-ai-a",
              positionId: "developer-position-a",
              sessionId: "developer-session-a",
            },
            reviewer: {
              participantId: "aggregate-participant",
              aiMemberId: "developer-ai-b",
              positionId: "developer-position-b",
              sessionId: "developer-session-b",
            },
            terminalExecutionFactId: "aggregate-terminal-fact",
            result: "PASS",
            conditions: [],
            evidenceRefs: ["execution-fact:aggregate-terminal-fact"],
          }),
        (error: unknown) =>
          error instanceof ReviewRuntimeError &&
          error.code === "REVIEWER_INELIGIBLE",
      );
    } finally {
      database.exec("ROLLBACK");
    }
    assert.equal(
      Number(
        database.prepare("SELECT COUNT(*) AS count FROM review_topics").get()!
          .count,
      ),
      0,
    );
    assert.equal(
      Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM quality_gate_results")
          .get()!.count,
      ),
      0,
    );
    database.close();
  });

  it("serves Review Commands and authoritative Views through the Runtime transport", async () => {
    const companyDir = tempCompanyDir();
    const setup = openCompanyDatabase(companyDir);
    const fixture = createReviewFixture(setup, "transport");
    const raw = new DatabaseSync(setup.path);
    raw.exec("DELETE FROM review_topics WHERE id = 'review-topic-transport'");
    raw.close();
    setup.close();

    const runtime = await startCompanyRuntimeServer({
      address: companyRuntimeAddress(companyDir),
      companyDir,
      token: "review-token",
      principal: {
        type: "human",
        id: "local-review-user",
        authenticatedBy: "local-session",
      },
    });
    try {
      const client = createCompanyRuntimeClient({
        address: runtime.address,
        token: "review-token",
      });
      const created = await client.executeEnvelope({
        schemaVersion: 1,
        commandId: "transport-create-command",
        actor: {
          type: "human",
          id: "untrusted-renderer-actor",
          authenticatedBy: "local-session",
        },
        consumerId: "renderer-review",
        expectedRevision: 0,
        command: fixture.command,
      });
      assert.equal(created.status, "succeeded");
      const inspected = await client.queryEnvelope({
        schemaVersion: 1,
        requestId: "transport-review-query",
        principal: {
          type: "human",
          id: "untrusted-renderer-actor",
          authenticatedBy: "local-session",
        },
        consumerId: "renderer-review",
        query: {
          type: "review.topic.inspect",
          topicId: fixture.topicId,
        },
      });
      assert.equal(inspected.view.topic.id, fixture.topicId);
      assert.equal(inspected.view.topic.manifestHash, hash(fixture.manifest));
      assert.equal(inspected.asOfSequence > 0, true);
    } finally {
      await runtime.close();
    }
  });
});
