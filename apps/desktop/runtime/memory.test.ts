import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createProductionExecutionAdapter,
  type SoftwareDevelopmentExecutionInput,
} from "./adapters/productionExecutionAdapter.js";
import { openCompanyDatabase } from "./storage/sqlite.js";

const humanActor = {
  type: "human" as const,
  id: "local-user",
  authenticatedBy: "local-session" as const,
};

const runtimeActor = (id: string) => ({
  type: "runtime-worker" as const,
  id,
  authenticatedBy: "runtime" as const,
});

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-reviewed-memory-"));

const execute = (
  database: ReturnType<typeof openCompanyDatabase>,
  input: unknown,
) => database.commandRegistry.execute(input as never) as any;

const createAiSession = (
  database: ReturnType<typeof openCompanyDatabase>,
  projectId: string,
  aiMemberId: string,
  role: string,
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

const createFormalRun = async (
  database: ReturnType<typeof openCompanyDatabase>,
  suffix: string,
) => {
  const project = database.catalog.createProject({
    name: `Checkout ${suffix}`,
    goal: "Ship a safer checkout",
  });
  const producerSessionId = createAiSession(
    database,
    project.id,
    "product-planner-member",
    "product-manager",
  );
  const proposal = execute(database, {
    schemaVersion: 1,
    commandId: `memory-proposal-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-memory",
    expectedRevision: 0,
    command: {
      type: "product.proposal.revise",
      projectId: project.id,
      producerSessionId,
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
  assert.equal(proposal.status, "succeeded");
  const awaiting = execute(database, {
    schemaVersion: 1,
    commandId: `memory-awaiting-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-memory",
    expectedRevision: proposal.value.proposal.revision,
    command: {
      type: "product.proposal.mark-awaiting-confirmation",
      projectId: project.id,
      proposalRevisionId: proposal.value.proposal.currentRevision.id,
      proposalHash: proposal.value.proposal.currentRevision.hash,
    },
  });
  assert.equal(awaiting.status, "succeeded");
  const confirmed = execute(database, {
    schemaVersion: 1,
    commandId: `memory-confirm-${suffix}`,
    actor: humanActor,
    consumerId: "desktop-memory",
    expectedRevision: awaiting.value.proposal.revision,
    command: {
      type: "confirm-product-baseline",
      projectId: project.id,
      departmentId: "software-rnd",
      proposalRevisionId: awaiting.value.proposal.currentRevision.id,
      proposalHash: awaiting.value.proposal.currentRevision.hash,
    },
  });
  assert.equal(confirmed.status, "succeeded");
  const baseline = confirmed.value.baselines[0];
  const startedRun = database.pipelineRuntime.startFormalizedRun({
    projectId: project.id,
    departmentId: "software-rnd",
  });
  const executedRun = await database.pipelineRuntime.executeReady({
    runId: startedRun.run.id,
    expectedRevision: startedRun.run.revision,
  });
  const sourceNode = executedRun.nodes.find((node) => node.attempts.length > 0);
  assert.ok(sourceNode);
  const sourceAttempt = sourceNode.attempts[0];
  assert.ok(sourceAttempt);
  return {
    project,
    producerSessionId,
    baseline,
    sourceNode,
    sourceAttempt,
  };
};

describe("Reviewed Memory", () => {
  it("promotes exact reviewed evidence once and freezes an explicit future Snapshot selection", async () => {
    const companyDir = tempCompanyDir();
    let database = openCompanyDatabase(companyDir);
    try {
      const fixture = await createFormalRun(database, "accepted");
      const artifact = database.artifactRegistry.registerVersion({
        projectId: fixture.project.id,
        type: "review-evidence",
        schemaVersion: "1",
        logicalName: "checkout-review.md",
        content:
          "Payment-provider compatibility must be checked before deploy.",
        status: "produced",
        producer: {
          runId: fixture.baseline.runId,
          snapshotRevisionId: fixture.baseline.snapshotRevisionId,
          nodeRunId: fixture.sourceNode.id,
          nodeAttemptId: fixture.sourceAttempt.id,
          aiMemberId: "product-planner-member",
          positionId: "product-planner",
          sessionId: fixture.producerSessionId,
        },
      });
      const runEvents = database.pipelineRuntime.runtimeEvents({
        afterSequence: 0,
        limit: 1_000,
      });
      const sourceSequences = runEvents
        .filter((event) => event.runId === fixture.baseline.runId)
        .map((event) => event.sequence);
      assert.ok(sourceSequences.length > 0);

      const proposed = execute(database, {
        schemaVersion: 1,
        commandId: "memory-candidate-propose-accepted",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        command: {
          type: "memory.candidate.propose",
          candidateId: "memory-candidate-accepted",
          revisionId: "memory-candidate-revision-accepted",
          projectId: fixture.project.id,
          scope: "project",
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: fixture.producerSessionId,
          },
          content:
            "Checkout deploys require payment-provider compatibility checks.",
          redactionPolicy: {
            version: "redaction-v1",
            hash: "7f2b38422f7e1c4f6432eaceff54447166018186464fb3801e27b89f8409fe44",
          },
          sourceArtifactVersions: [
            { id: artifact.id, hash: artifact.contentHash },
          ],
          sourceEventRanges: [
            {
              runId: fixture.baseline.runId,
              fromSequence: Math.min(...sourceSequences),
              toSequence: Math.max(...sourceSequences),
            },
          ],
        },
      });
      assert.equal(proposed.status, "succeeded");
      assert.equal(proposed.value.status, "draft");
      assert.equal(proposed.value.decision, null);
      assert.equal(database.memory.listEntries(fixture.project.id).length, 0);

      const moderatorSessionId = createAiSession(
        database,
        fixture.project.id,
        "evaluator-member",
        "moderator",
      );
      const reviewerSessionId = createAiSession(
        database,
        fixture.project.id,
        "reviewer-member",
        "reviewer",
      );
      const freshReviewerSessionId = createAiSession(
        database,
        fixture.project.id,
        "software-architect-member",
        "reviewer",
      );
      const started = execute(database, {
        schemaVersion: 1,
        commandId: "memory-review-start-accepted",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        expectedRevision: 1,
        command: {
          type: "memory.review.start",
          candidateId: "memory-candidate-accepted",
          candidateRevisionId: "memory-candidate-revision-accepted",
          candidateRevisionHash: proposed.value.currentRevision.hash,
          topicId: "memory-topic-accepted",
          participants: [
            {
              id: "memory-owner",
              role: "owner-participant",
              aiMemberId: "product-planner-member",
              positionId: "product-planner",
              sessionId: fixture.producerSessionId,
            },
            {
              id: "memory-moderator",
              role: "moderator",
              aiMemberId: "evaluator-member",
              positionId: "evaluator",
              sessionId: moderatorSessionId,
            },
            {
              id: "memory-reviewer",
              role: "reviewer-participant",
              aiMemberId: "reviewer-member",
              positionId: "reviewer",
              sessionId: reviewerSessionId,
            },
            {
              id: "memory-fresh-reviewer",
              role: "reviewer-participant",
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
        },
      });
      assert.equal(started.status, "succeeded");
      const reviewStartEvents = database.pipelineRuntime
        .runtimeEvents({ afterSequence: 0, limit: 1_000 })
        .filter(
          (event) =>
            event.payload &&
            typeof event.payload === "object" &&
            "candidateId" in event.payload &&
            event.payload.candidateId === "memory-candidate-accepted",
        );
      assert.equal(
        reviewStartEvents.filter(
          (event) => event.type === "memory.review.started",
        ).length,
        1,
      );
      assert.equal(
        reviewStartEvents.filter((event) => event.type === "memory.reviewed")
          .length,
        0,
      );

      const revision = execute(database, {
        schemaVersion: 1,
        commandId: "memory-review-revision-accepted",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        expectedRevision: 1,
        command: {
          type: "review.revision.submit",
          topicId: "memory-topic-accepted",
          revisionId: "memory-reviewed-revision-accepted",
          ownerParticipantId: "memory-owner",
          subjectKind: "memory-candidate",
          subjectId: "memory-candidate-revision-accepted",
          subjectHash: proposed.value.currentRevision.hash,
          producerAiMemberId: "product-planner-member",
          producerPositionId: "product-planner",
          producerSessionId: fixture.producerSessionId,
          evidenceRefs: [artifact.id],
        },
      });
      assert.equal(revision.status, "succeeded");
      const firstVote = execute(database, {
        schemaVersion: 1,
        commandId: "memory-review-vote-1-accepted",
        actor: runtimeActor("reviewer-member"),
        consumerId: "runtime-memory-reviewer",
        expectedRevision: 2,
        command: {
          type: "review.recheck.submit",
          topicId: "memory-topic-accepted",
          recheckId: "memory-recheck-1-accepted",
          revisionId: "memory-reviewed-revision-accepted",
          reviewerParticipantId: "memory-reviewer",
          reviewerSessionId: createAiSession(
            database,
            fixture.project.id,
            "reviewer-member",
            "reviewer",
          ),
          result: "PASS",
          conditions: [],
          evidenceRefs: [artifact.id],
        },
      });
      assert.equal(firstVote.status, "succeeded");
      const secondVote = execute(database, {
        schemaVersion: 1,
        commandId: "memory-review-vote-2-accepted",
        actor: runtimeActor("software-architect-member"),
        consumerId: "runtime-memory-reviewer",
        expectedRevision: 3,
        command: {
          type: "review.recheck.submit",
          topicId: "memory-topic-accepted",
          recheckId: "memory-recheck-2-accepted",
          revisionId: "memory-reviewed-revision-accepted",
          reviewerParticipantId: "memory-fresh-reviewer",
          reviewerSessionId: createAiSession(
            database,
            fixture.project.id,
            "software-architect-member",
            "reviewer",
          ),
          result: "PASS",
          conditions: [],
          evidenceRefs: [artifact.id],
        },
      });
      assert.equal(secondVote.status, "succeeded");

      const decisionCommand = {
        schemaVersion: 1,
        commandId: "memory-decision-accepted",
        actor: humanActor,
        consumerId: "desktop-memory",
        command: {
          type: "memory.candidate.decide",
          candidateId: "memory-candidate-accepted",
          candidateRevisionId: "memory-candidate-revision-accepted",
          candidateRevisionHash: proposed.value.currentRevision.hash,
          topicId: "memory-topic-accepted",
          decision: "accepted",
        },
      };
      const aiDecision = execute(database, {
        ...decisionCommand,
        commandId: "memory-decision-ai-rejected",
        actor: runtimeActor("product-planner-member"),
      });
      assert.equal(aiDecision.status, "rejected");
      assert.equal(aiDecision.error.code, "MEMORY_HUMAN_DECISION_REQUIRED");
      assert.equal(database.memory.listEntries(fixture.project.id).length, 0);
      database.close();
      database = openCompanyDatabase(companyDir, {
        memoryRuntime: {
          commandFailure: (point) => {
            if (point === "before-receipt") {
              throw new Error("simulated Memory decision crash");
            }
          },
        },
      });
      assert.throws(
        () => execute(database, decisionCommand),
        /simulated Memory decision crash/,
      );
      assert.equal(database.memory.listEntries(fixture.project.id).length, 0);
      database.close();
      database = openCompanyDatabase(companyDir);

      const decided = execute(database, decisionCommand);
      assert.equal(decided.status, "succeeded");
      assert.equal(decided.value.entry.version, 1);
      assert.equal(decided.value.decision.entryId, decided.value.entry.id);
      assert.equal(database.memory.listEntries(fixture.project.id).length, 1);

      database.close();
      database = openCompanyDatabase(companyDir);
      const decidedCandidate = database.memory.listCandidates(
        fixture.project.id,
      )[0];
      assert.ok(decidedCandidate?.decision);
      assert.deepEqual(decidedCandidate.decision, decided.value.decision);
      assert.equal(
        database.pipelineRuntime
          .runtimeEvents({ afterSequence: 0, limit: 1_000 })
          .filter(
            (event) =>
              event.type === "memory.reviewed" &&
              typeof event.payload === "object" &&
              event.payload !== null &&
              "qualityGateResultId" in event.payload &&
              event.payload.qualityGateResultId ===
                decided.value.decision.qualityGateResultId,
          ).length,
        1,
      );

      const replay = execute(database, {
        schemaVersion: 1,
        commandId: "memory-decision-accepted",
        actor: humanActor,
        consumerId: "desktop-memory",
        command: {
          type: "memory.candidate.decide",
          candidateId: "memory-candidate-accepted",
          candidateRevisionId: "memory-candidate-revision-accepted",
          candidateRevisionHash: proposed.value.currentRevision.hash,
          topicId: "memory-topic-accepted",
          decision: "accepted",
        },
      });
      assert.deepEqual(replay, decided);
      assert.equal(database.memory.listEntries(fixture.project.id).length, 1);
      const conflictingReuse = execute(database, {
        ...decisionCommand,
        command: { ...decisionCommand.command, decision: "rejected" },
      });
      assert.equal(conflictingReuse.status, "rejected");
      assert.equal(conflictingReuse.error.code, "COMMAND_ID_REUSE");

      const runBeforeSelection = database.pipelineRuntime.inspectRun(
        fixture.baseline.runId,
      );
      const selected = execute(database, {
        schemaVersion: 1,
        commandId: "memory-select-accepted",
        actor: humanActor,
        consumerId: "desktop-memory",
        expectedRevision: runBeforeSelection.run.revision,
        command: {
          type: "memory.entry.select-for-run",
          runId: fixture.baseline.runId,
          sourceSnapshotRevisionId: runBeforeSelection.run.snapshotRevisionId,
          entryRefs: [
            {
              id: decided.value.entry.id,
              version: decided.value.entry.version,
              hash: decided.value.entry.hash,
            },
          ],
          selectionReason: "Use reviewed checkout operating constraints.",
          policyHash:
            "3b335d6f0f2c06e2040609c5eddb2782f04daacfb4ec0b3bcc6f31a9083014a5",
        },
      });
      assert.equal(selected.status, "succeeded");
      assert.equal(selected.value.selections.length, 1);
      assert.notEqual(
        selected.value.snapshotRevisionId,
        runBeforeSelection.run.snapshotRevisionId,
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(fixture.baseline.runId).snapshot
          .payload.memorySelections?.[0]?.entryId,
        decided.value.entry.id,
      );
      assert.equal(
        runBeforeSelection.snapshot.payload.memorySelections,
        undefined,
      );
      const selectedRun = database.pipelineRuntime.inspectRun(
        fixture.baseline.runId,
      );
      const duplicateSelection = execute(database, {
        schemaVersion: 1,
        commandId: "memory-select-duplicate",
        actor: humanActor,
        consumerId: "desktop-memory",
        expectedRevision: selectedRun.run.revision,
        command: {
          type: "memory.entry.select-for-run",
          runId: selectedRun.run.id,
          sourceSnapshotRevisionId: selectedRun.snapshot.id,
          entryRefs: [
            {
              id: decided.value.entry.id,
              version: decided.value.entry.version,
              hash: decided.value.entry.hash,
            },
          ],
          selectionReason: "Do not duplicate frozen Memory.",
          policyHash:
            "3b335d6f0f2c06e2040609c5eddb2782f04daacfb4ec0b3bcc6f31a9083014a5",
        },
      });
      assert.equal(duplicateSelection.status, "rejected");
      assert.equal(duplicateSelection.error.code, "MEMORY_SELECTION_DUPLICATE");

      const otherProject = await createFormalRun(database, "selection-scope");
      const otherRun = database.pipelineRuntime.inspectRun(
        otherProject.baseline.runId,
      );
      const crossProjectSelection = execute(database, {
        schemaVersion: 1,
        commandId: "memory-select-cross-project",
        actor: humanActor,
        consumerId: "desktop-memory",
        expectedRevision: otherRun.run.revision,
        command: {
          type: "memory.entry.select-for-run",
          runId: otherRun.run.id,
          sourceSnapshotRevisionId: otherRun.snapshot.id,
          entryRefs: [
            {
              id: decided.value.entry.id,
              version: decided.value.entry.version,
              hash: decided.value.entry.hash,
            },
          ],
          selectionReason: "Attempt to cross a Project boundary.",
          policyHash:
            "3b335d6f0f2c06e2040609c5eddb2782f04daacfb4ec0b3bcc6f31a9083014a5",
        },
      });
      assert.equal(crossProjectSelection.status, "rejected");
      assert.equal(
        crossProjectSelection.error.code,
        "MEMORY_SCOPE_PROJECT_MISMATCH",
      );

      const productionCalls: SoftwareDevelopmentExecutionInput[] = [];
      database.close();
      database = openCompanyDatabase(companyDir, {
        executionAdapter: createProductionExecutionAdapter({
          execute: async (input) => {
            productionCalls.push(input);
            return {
              kind: "failed",
              code: "TEST_STOP_AFTER_MEMORY_LOAD",
              message: "Stop after proving selected Memory was loaded.",
            };
          },
        }),
      });
      const memoryRun = database.pipelineRuntime.startRun({
        projectId: fixture.project.id,
        departmentId: "software-rnd",
      });
      const selectedForExecution = execute(database, {
        schemaVersion: 1,
        commandId: "memory-select-production-execution",
        actor: humanActor,
        consumerId: "desktop-memory",
        expectedRevision: memoryRun.run.revision,
        command: {
          type: "memory.entry.select-for-run",
          runId: memoryRun.run.id,
          sourceSnapshotRevisionId: memoryRun.snapshot.id,
          entryRefs: [
            {
              id: decided.value.entry.id,
              version: decided.value.entry.version,
              hash: decided.value.entry.hash,
            },
          ],
          selectionReason: "Load reviewed Memory for formal execution.",
          policyHash:
            "3b335d6f0f2c06e2040609c5eddb2782f04daacfb4ec0b3bcc6f31a9083014a5",
        },
      });
      assert.equal(selectedForExecution.status, "succeeded");
      await database.pipelineRuntime.executeReady({
        runId: memoryRun.run.id,
        expectedRevision: database.pipelineRuntime.inspectRun(memoryRun.run.id)
          .run.revision,
      });
      assert.deepEqual(productionCalls[0]?.memoryEntries, [
        {
          id: decided.value.entry.id,
          version: decided.value.entry.version,
          hash: decided.value.entry.hash,
          scope: "project",
          ownerId: fixture.project.id,
          content:
            "Checkout deploys require payment-provider compatibility checks.",
          redactionPolicy: {
            version: "redaction-v1",
            hash: "7f2b38422f7e1c4f6432eaceff54447166018186464fb3801e27b89f8409fe44",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects target AI Member self-review and unsupported or sensitive redaction inputs", async () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const fixture = await createFormalRun(database, "memory-policy");
      const artifact = database.artifactRegistry.registerVersion({
        projectId: fixture.project.id,
        type: "review-evidence",
        schemaVersion: "1",
        logicalName: "memory-policy.md",
        content: "Reviewed source evidence.",
        status: "produced",
        producer: {
          runId: fixture.baseline.runId,
          snapshotRevisionId: fixture.baseline.snapshotRevisionId,
          nodeRunId: fixture.sourceNode.id,
          nodeAttemptId: fixture.sourceAttempt.id,
          aiMemberId: "product-planner-member",
          positionId: "product-planner",
          sessionId: fixture.producerSessionId,
        },
      });
      const sourceSequences = database.pipelineRuntime
        .runtimeEvents({ afterSequence: 0, limit: 1_000 })
        .filter((event) => event.runId === fixture.baseline.runId)
        .map((event) => event.sequence);
      assert.ok(sourceSequences.length > 0);
      const source = {
        redactionPolicy: {
          version: "redaction-v1",
          hash: "7f2b38422f7e1c4f6432eaceff54447166018186464fb3801e27b89f8409fe44",
        },
        sourceArtifactVersions: [
          { id: artifact.id, hash: artifact.contentHash },
        ],
        sourceEventRanges: [
          {
            runId: fixture.baseline.runId,
            fromSequence: Math.min(...sourceSequences),
            toSequence: Math.max(...sourceSequences),
          },
        ],
      };
      for (const [suffix, content] of [
        [
          "bearer",
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
        ],
        ["api-key", "api_key: abcdefghijklmnopqrstuvwxyz"],
        ["github", "github_pat_11AAABBBCCCDDDEEEFFF000111222333444"],
        ["aws", "aws_access_key_id=AKIAIOSFODNN7EXAMPLE"],
      ] as const) {
        const rejected = execute(database, {
          schemaVersion: 1,
          commandId: `memory-sensitive-${suffix}`,
          actor: runtimeActor("product-planner-member"),
          consumerId: "runtime-memory-producer",
          command: {
            type: "memory.candidate.propose",
            candidateId: `memory-sensitive-${suffix}`,
            revisionId: `memory-sensitive-${suffix}-r1`,
            projectId: fixture.project.id,
            scope: "project",
            producer: {
              aiMemberId: "product-planner-member",
              positionId: "product-planner",
              sessionId: fixture.producerSessionId,
            },
            content,
            ...source,
          },
        });
        assert.equal(rejected.status, "rejected");
        assert.equal(rejected.error.code, "MEMORY_CANDIDATE_SENSITIVE");
      }
      const unsupportedPolicy = execute(database, {
        schemaVersion: 1,
        commandId: "memory-policy-unsupported",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        command: {
          type: "memory.candidate.propose",
          candidateId: "memory-policy-unsupported",
          revisionId: "memory-policy-unsupported-r1",
          projectId: fixture.project.id,
          scope: "project",
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: fixture.producerSessionId,
          },
          content: "Use reviewed exact evidence.",
          ...source,
          redactionPolicy: {
            version: "redaction-v1",
            hash: "f".repeat(64),
          },
        },
      });
      assert.equal(unsupportedPolicy.status, "rejected");
      assert.equal(
        unsupportedPolicy.error.code,
        "MEMORY_REDACTION_POLICY_UNSUPPORTED",
      );

      const proposed = execute(database, {
        schemaVersion: 1,
        commandId: "memory-target-self-review-propose",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        command: {
          type: "memory.candidate.propose",
          candidateId: "memory-target-self-review",
          revisionId: "memory-target-self-review-r1",
          projectId: fixture.project.id,
          scope: "ai-member",
          aiMemberId: "reviewer-member",
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: fixture.producerSessionId,
          },
          content: "Keep review evidence tied to exact revisions.",
          ...source,
        },
      });
      assert.equal(proposed.status, "succeeded");
      const selfReview = execute(database, {
        schemaVersion: 1,
        commandId: "memory-target-self-review-start",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        expectedRevision: 1,
        command: {
          type: "memory.review.start",
          candidateId: "memory-target-self-review",
          candidateRevisionId: "memory-target-self-review-r1",
          candidateRevisionHash: proposed.value.currentRevision.hash,
          topicId: "memory-target-self-review-topic",
          participants: [
            {
              id: "memory-target-owner",
              role: "owner-participant",
              aiMemberId: "product-planner-member",
              positionId: "product-planner",
              sessionId: fixture.producerSessionId,
            },
            {
              id: "memory-target-moderator",
              role: "moderator",
              aiMemberId: "evaluator-member",
              positionId: "evaluator",
              sessionId: createAiSession(
                database,
                fixture.project.id,
                "evaluator-member",
                "moderator",
              ),
            },
            {
              id: "memory-target-reviewer",
              role: "reviewer-participant",
              aiMemberId: "reviewer-member",
              positionId: "reviewer",
              sessionId: createAiSession(
                database,
                fixture.project.id,
                "reviewer-member",
                "reviewer",
              ),
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
      assert.equal(selfReview.status, "rejected");
      assert.equal(selfReview.error.code, "MEMORY_REVIEWER_SELF_APPROVAL");
    } finally {
      database.close();
    }
  });

  it("rejects source evidence and Project Memory selection across Project scope", async () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const source = await createFormalRun(database, "source-project");
      const target = await createFormalRun(database, "target-project");
      const artifact = database.artifactRegistry.registerVersion({
        projectId: source.project.id,
        type: "review-evidence",
        schemaVersion: "1",
        logicalName: "source-only.md",
        content: "Source Project only.",
        status: "produced",
        producer: {
          runId: source.baseline.runId,
          snapshotRevisionId: source.baseline.snapshotRevisionId,
          nodeRunId: source.sourceNode.id,
          nodeAttemptId: source.sourceAttempt.id,
          aiMemberId: "product-planner-member",
        },
      });
      const rejected = execute(database, {
        schemaVersion: 1,
        commandId: "memory-cross-project-source",
        actor: runtimeActor("product-planner-member"),
        consumerId: "runtime-memory-producer",
        command: {
          type: "memory.candidate.propose",
          candidateId: "memory-cross-project",
          revisionId: "memory-cross-project-r1",
          projectId: target.project.id,
          scope: "project",
          producer: {
            aiMemberId: "product-planner-member",
            positionId: "product-planner",
            sessionId: target.producerSessionId,
          },
          content: "Leak source-only context.",
          redactionPolicy: {
            version: "redaction-v1",
            hash: "7f2b38422f7e1c4f6432eaceff54447166018186464fb3801e27b89f8409fe44",
          },
          sourceArtifactVersions: [
            { id: artifact.id, hash: artifact.contentHash },
          ],
          sourceEventRanges: [
            {
              runId: target.baseline.runId,
              fromSequence: 1,
              toSequence: 1,
            },
          ],
        },
      });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.error.code, "MEMORY_SOURCE_PROJECT_MISMATCH");
      assert.equal(database.memory.listCandidates(target.project.id).length, 0);
    } finally {
      database.close();
    }
  });
});
