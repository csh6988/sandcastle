import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeInteraction } from "../interaction.js";
import type { ActorRef } from "../interface.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { ReviewRuntime } from "../review/reviewRuntime.js";
import {
  ReviewerRecheckOutputSchema,
  type ReviewerExecutionAdapter,
  type ReviewerExecutionInput,
  type ReviewerExecutionResult,
} from "../review/reviewerExecution.js";
import type {
  AggregateIntegrationReviewExecutor,
  AggregateIntegrationReviewInput,
  AggregateIntegrationReviewResult,
} from "./integrationNodeHandler.js";

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : entry,
  );

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const actor: ActorRef = {
  type: "runtime-worker",
  id: "integration-node-handler",
  authenticatedBy: "runtime",
};

type AggregateRecordRequest = {
  readonly input: AggregateIntegrationReviewInput;
  readonly terminalExecutionFactId: string;
  readonly providerId: string;
  readonly isolation: Extract<
    ReviewerExecutionResult,
    { readonly status: "succeeded" }
  >["isolation"];
  readonly isolationEvidence: readonly string[];
  readonly producer: {
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  };
  readonly reviewer: {
    readonly participantId: string;
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  };
  readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  readonly conditions: readonly string[];
  readonly evidenceRefs: readonly string[];
};

type AggregateRecordReceipt = {
  readonly status: "succeeded";
  readonly value: {
    readonly topicId: string;
    readonly gateId: string;
    readonly recordRequest: AggregateRecordRequest;
  };
  readonly effectIds: readonly string[];
};

const assertIsolation = (
  result: Extract<ReviewerExecutionResult, { readonly status: "succeeded" }>,
): void => {
  const isolation = result.isolation;
  if (
    !isolation.readOnlyFilesystem ||
    !isolation.independentGitDatabase ||
    !isolation.independentSessionStorage ||
    !isolation.independentCredentialScope ||
    !isolation.independentMutableCache ||
    !isolation.inputAllowlist ||
    isolation.inspectedReadOnlyReviewMount !== true ||
    isolation.terminalProviderStatus !== "completed" ||
    !isolation.terminalProviderReceiptHash ||
    result.isolationEvidence.length === 0
  ) {
    throw new Error(
      "Aggregate Reviewer execution did not prove the complete independent read-only isolation receipt.",
    );
  }
};

export const openAggregateIntegrationReviewExecutor = (options: {
  readonly database: DatabaseSync;
  readonly workspaceRoot: string;
  readonly reviewerExecutionAdapter: ReviewerExecutionAdapter;
  readonly interaction: Pick<
    RuntimeInteraction,
    "createSession" | "addParticipant"
  >;
  readonly pipelineRuntime: Pick<
    PipelineRuntime,
    "inspectRun" | "inspectExecution" | "executeIntegrationReviewStage"
  >;
  readonly reviewRuntime: Pick<
    ReviewRuntime,
    "inspect" | "recordAggregateExecutionInTransaction"
  >;
  readonly clock?: () => Date;
}): AggregateIntegrationReviewExecutor => {
  const clock = options.clock ?? (() => new Date());
  mkdirSync(options.workspaceRoot, { recursive: true, mode: 0o700 });

  const makeReadOnly = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      for (const child of readdirSync(path)) makeReadOnly(join(path, child));
      chmodSync(path, entry.mode & 0o555);
      return;
    }
    chmodSync(path, entry.mode & 0o555);
  };

  const manifestFor = (input: AggregateIntegrationReviewInput) => ({
    scope: "aggregate" as const,
    topicId: input.topicId,
    supportingArtifactVersionIds: [],
    supportingSpecRevisionIds: [],
    harnessSnapshotIds: [],
    acceptanceCriteria: [...input.acceptanceCriteria],
    excludedContext: [
      "hidden-prompts" as const,
      "prior-reviewer-opinions" as const,
      "private-transcripts" as const,
    ],
    integrationGenerationId: input.generationId,
    integrationManifestHash: input.manifestHash,
    repositoryCommits: input.repositoryCommits.map((entry) => ({ ...entry })),
  });

  const existingRecordAuthorityInTransaction = (
    input: AggregateIntegrationReviewInput,
    expectedRecordRequest?: AggregateRecordRequest,
  ): AggregateIntegrationReviewResult | null => {
    const commandId = `${input.operationKey}:record`;
    try {
      const receipt = options.database
        .prepare(
          `SELECT actor_type AS actorType, actor_id AS actorId,
                  authenticated_by AS authenticatedBy,
                  consumer_id AS consumerId, schema_version AS schemaVersion,
                  request_hash AS requestHash, status,
                  result_json AS resultJson, result_hash AS resultHash,
                  effect_ids_json AS effectIdsJson
             FROM command_deduplication WHERE command_id = ?`,
        )
        .get(commandId) as
        | {
            readonly actorType: string;
            readonly actorId: string;
            readonly authenticatedBy: string;
            readonly consumerId: string;
            readonly schemaVersion: number;
            readonly requestHash: string;
            readonly status: string;
            readonly resultJson: string;
            readonly resultHash: string;
            readonly effectIdsJson: string;
          }
        | undefined;
      if (!receipt) {
        try {
          const topic = options.reviewRuntime.inspect(input.topicId);
          if (topic.gateResult) {
            return {
              status: "unknown",
              code: "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
              message:
                "Aggregate Review authority exists without its exact record receipt.",
              evidence: { topicId: input.topicId, commandId },
            };
          }
        } catch {
          return null;
        }
        return null;
      }
      const parsed = JSON.parse(receipt.resultJson) as AggregateRecordReceipt;
      const storedEffectIds = JSON.parse(receipt.effectIdsJson) as unknown;
      const actualEffectIds = (
        options.database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      const requestHash = sha256(
        canonicalJson({
          schemaVersion: 1,
          actor,
          consumerId: "integration-node-handler",
          request: parsed.value.recordRequest,
        }),
      );
      if (
        receipt.actorType !== actor.type ||
        receipt.actorId !== actor.id ||
        receipt.authenticatedBy !== actor.authenticatedBy ||
        receipt.consumerId !== "integration-node-handler" ||
        Number(receipt.schemaVersion) !== 1 ||
        receipt.status !== "completed" ||
        sha256(receipt.resultJson) !== receipt.resultHash ||
        receipt.requestHash !== requestHash ||
        parsed.status !== "succeeded" ||
        parsed.value.topicId !== input.topicId ||
        canonicalJson(parsed.value.recordRequest.input) !==
          canonicalJson(input) ||
        (expectedRecordRequest !== undefined &&
          canonicalJson(parsed.value.recordRequest) !==
            canonicalJson(expectedRecordRequest)) ||
        !Array.isArray(parsed.effectIds) ||
        !Array.isArray(storedEffectIds) ||
        !storedEffectIds.every((effectId) => typeof effectId === "string") ||
        canonicalJson(parsed.effectIds) !== canonicalJson(storedEffectIds) ||
        canonicalJson(storedEffectIds) !== canonicalJson(actualEffectIds)
      ) {
        return {
          status: "unknown",
          code: "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
          message: "Aggregate Review record receipt identity is invalid.",
          evidence: { topicId: input.topicId, commandId },
        };
      }
      const recordRequest = parsed.value.recordRequest;
      const topic = options.reviewRuntime.recordAggregateExecutionInTransaction(
        {
          commandId,
          actor,
          topicId: input.topicId,
          projectId: recordRequest.input.projectId,
          runId: recordRequest.input.runId,
          manifest: manifestFor(recordRequest.input),
          producer: recordRequest.producer,
          reviewer: recordRequest.reviewer,
          terminalExecutionFactId: recordRequest.terminalExecutionFactId,
          result: recordRequest.result,
          conditions: recordRequest.conditions,
          evidenceRefs: recordRequest.evidenceRefs,
        },
      );
      if (topic.gateResult?.id !== parsed.value.gateId) {
        return {
          status: "unknown",
          code: "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
          message: "Aggregate Review Gate authority drifted from its receipt.",
          evidence: { topicId: input.topicId, commandId },
        };
      }
      return {
        status: "completed",
        topicId: input.topicId,
        qualityGateResultId: parsed.value.gateId,
      };
    } catch (error) {
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
        message:
          error instanceof Error
            ? error.message
            : "Aggregate Review record receipt is invalid.",
        evidence: { topicId: input.topicId, commandId },
      };
    }
  };

  const prepareWorkspace = (input: AggregateIntegrationReviewInput): string => {
    const root = join(options.workspaceRoot, sha256(input.operationKey));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const [index, repository] of input.repositoryCommits.entries()) {
      const target = join(root, `repository-${index + 1}`);
      if (existsSync(target)) {
        const current = execFileSync(
          "git",
          ["-C", target, "rev-parse", "HEAD"],
          { encoding: "utf8", stdio: "pipe" },
        ).trim();
        if (current !== repository.commit) {
          throw new Error("existing aggregate workspace commit drifted");
        }
        const dirty = execFileSync(
          "git",
          ["-C", target, "status", "--porcelain", "--untracked-files=all"],
          { encoding: "utf8", stdio: "pipe" },
        ).trim();
        if (dirty) {
          throw new Error("existing aggregate workspace tree drifted");
        }
      } else {
        execFileSync(
          "git",
          [
            "clone",
            "--no-local",
            "--no-checkout",
            repository.repositoryId,
            target,
          ],
          { stdio: "pipe" },
        );
        execFileSync(
          "git",
          ["-C", target, "checkout", "--detach", repository.commit],
          { stdio: "pipe" },
        );
      }
      makeReadOnly(target);
    }
    chmodSync(root, 0o500);
    return root;
  };

  const reviewerExecutionIdentity = (
    input: AggregateIntegrationReviewInput,
    reviewerAiMemberId: string,
  ): { readonly sessionId: string; readonly participantId: string } => {
    const role = `aggregate-reviewer:${input.generationId}`;
    const existing = options.database
      .prepare(
        `SELECT interaction_sessions.id AS sessionId,
                session_participants.id AS participantId
           FROM interaction_sessions
           JOIN session_participants
             ON session_participants.session_id = interaction_sessions.id
          WHERE interaction_sessions.project_id = ?
            AND interaction_sessions.run_id = ?
            AND interaction_sessions.node_run_id = ?
            AND interaction_sessions.mode = 'run-collaboration'
            AND interaction_sessions.status = 'active'
            AND session_participants.participant_type = 'ai-member'
            AND session_participants.participant_ref = ?
            AND session_participants.role = ?
          ORDER BY interaction_sessions.created_at,
                   interaction_sessions.id,
                   session_participants.created_at,
                   session_participants.id
          LIMIT 1`,
      )
      .get(
        input.projectId,
        input.runId,
        input.nodeRunId,
        reviewerAiMemberId,
        role,
      ) as
      | { readonly sessionId: string; readonly participantId: string }
      | undefined;
    if (existing) return existing;
    const session = options.interaction.createSession({
      projectId: input.projectId,
      mode: "run-collaboration",
      runId: input.runId,
      nodeRunId: input.nodeRunId,
    });
    const participant = options.interaction.addParticipant({
      sessionId: session.id,
      participantType: "ai-member",
      participantRef: reviewerAiMemberId,
      role,
    });
    return { sessionId: session.id, participantId: participant.id };
  };

  const execute = async (
    input: AggregateIntegrationReviewInput,
    reconcileExisting: boolean,
  ): Promise<AggregateIntegrationReviewResult> => {
    options.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = existingRecordAuthorityInTransaction(input);
      options.database.exec("COMMIT");
      if (existing) return existing;
    } catch (error) {
      options.database.exec("ROLLBACK");
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_CONFLICT",
        message:
          error instanceof Error
            ? error.message
            : "Aggregate Review authority lookup failed.",
        evidence: { operationKey: input.operationKey },
      };
    }
    const run = options.pipelineRuntime.inspectRun(input.runId);
    const node = run.nodes.find((entry) => entry.id === input.nodeRunId);
    const pipelineNode = run.snapshot.payload.pipelineVersion.graph.nodes.find(
      (entry) => entry.id === node?.pipelineNodeId,
    );
    const profileId =
      pipelineNode?.executionProfileId ??
      run.snapshot.payload.department.defaultExecutionProfileId;
    const profile = run.snapshot.payload.executionProfiles.find(
      (entry) => entry.id === profileId,
    );
    const producers = options.database
      .prepare(
        `SELECT DISTINCT
                work_package_assignments.ai_member_id AS aiMemberId,
                work_package_assignments.position_id AS positionId,
                work_package_assignments.interaction_session_id AS sessionId
           FROM integration_operations
           JOIN work_package_assignments
             ON work_package_assignments.work_package_version_id =
                integration_operations.work_package_version_id
          WHERE integration_operations.generation_id = ?
          ORDER BY aiMemberId, positionId, sessionId`,
      )
      .all(input.generationId) as Array<{
      readonly aiMemberId: string;
      readonly positionId: string;
      readonly sessionId: string;
    }>;
    const producerAiMemberIds = new Set(
      producers.map((producer) => producer.aiMemberId),
    );
    const producerPositionIds = new Set(
      producers.map((producer) => producer.positionId),
    );
    const producerSessionIds = new Set(
      producers.map((producer) => producer.sessionId),
    );
    const reviewer = run.snapshot.payload.positions.find(
      (position) =>
        position.aiMember.status === "active" &&
        !producerAiMemberIds.has(position.aiMember.id) &&
        !producerPositionIds.has(position.id),
    );
    const producer = producers[0];
    if (!profile || !producer || !reviewer) {
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_CONFIGURATION_INVALID",
        message:
          "Aggregate independent Review requires a frozen Execution Profile, producer lineage, and an independent active Reviewer.",
        evidence: { runId: input.runId },
      };
    }
    const execution = options.pipelineRuntime.inspectExecution({
      operationKey: input.operationKey,
    });
    if (
      reconcileExisting &&
      execution.facts.length === 0 &&
      execution.leases.length === 0
    ) {
      return { status: "not-applied" };
    }
    const reviewerIdentity = reviewerExecutionIdentity(
      input,
      reviewer.aiMember.id,
    );
    if (producerSessionIds.has(reviewerIdentity.sessionId)) {
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_CONFIGURATION_INVALID",
        message:
          "Aggregate independent Review cannot reuse any participating Work Package producer Session.",
        evidence: { reviewerSessionId: reviewerIdentity.sessionId },
      };
    }
    let workspaceRef: string;
    try {
      workspaceRef = prepareWorkspace(input);
    } catch (error) {
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_INVALID",
        message:
          error instanceof Error
            ? error.message
            : "Aggregate Review workspace was invalid.",
        evidence: { operationKey: input.operationKey },
      };
    }
    const result = await options.pipelineRuntime.executeIntegrationReviewStage({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      reviewerSessionId: reviewerIdentity.sessionId,
      reviewerAiMemberId: reviewer.aiMember.id,
      operationKey: input.operationKey,
      reconcileExisting,
      timeoutSeconds: profile.limits.timeoutSeconds,
      request: {
        operationKey: input.operationKey,
        phase: "fresh-recheck",
        manifest: manifestFor(
          input,
        ) as unknown as ReviewerExecutionInput["manifest"],
        workspaceRef,
        reviewNodeRunId: input.nodeRunId,
        reviewer: {
          participantId: reviewerIdentity.participantId,
          aiMemberId: reviewer.aiMember.id,
          positionId: reviewer.id,
          sessionId: reviewerIdentity.sessionId,
        },
        executionProfile: {
          agentAdapterId: profile.providerRef,
          model: profile.model,
          sandboxRef: profile.sandboxRef,
          secretReferenceIds: profile.secretReferenceIds,
          timeoutSeconds: profile.limits.timeoutSeconds,
          maxIterations: profile.limits.maxIterations,
        },
        findings: [],
        revision: null,
      },
      adapter: options.reviewerExecutionAdapter,
    });
    if (result.status !== "succeeded") {
      return {
        status: "unknown",
        code: result.status === "running" ? "RECONCILE_UNKNOWN" : result.code,
        message:
          result.status === "running"
            ? "Aggregate Reviewer execution remains running."
            : result.message,
        evidence:
          result.status === "running"
            ? { providerExecutionRef: result.providerExecutionRef }
            : result.evidence,
      };
    }
    try {
      assertIsolation(result);
      const output = ReviewerRecheckOutputSchema.parse(result.output);
      if (!result.terminalExecutionFactId) {
        throw new Error(
          "Aggregate Reviewer execution is missing its terminal Execution Fact authority.",
        );
      }
      const commandId = `${input.operationKey}:record`;
      const evidenceRefs = [
        workspaceRef,
        `execution-fact:${result.terminalExecutionFactId}`,
        ...result.isolationEvidence,
        ...output.evidenceRefs,
      ];
      const recordRequest: AggregateRecordRequest = {
        input,
        terminalExecutionFactId: result.terminalExecutionFactId,
        providerId: result.providerId,
        isolation: result.isolation,
        isolationEvidence: result.isolationEvidence,
        producer,
        reviewer: {
          participantId: reviewerIdentity.participantId,
          aiMemberId: reviewer.aiMember.id,
          positionId: reviewer.id,
          sessionId: reviewerIdentity.sessionId,
        },
        result: output.result,
        conditions: output.conditions,
        evidenceRefs,
      };
      options.database.exec("BEGIN IMMEDIATE");
      try {
        const existing = existingRecordAuthorityInTransaction(
          input,
          recordRequest,
        );
        if (existing) {
          if (existing.status === "completed") {
            options.database.exec("COMMIT");
          } else {
            options.database.exec("ROLLBACK");
          }
          return existing;
        }
        options.database
          .prepare(
            `INSERT INTO runtime_unit_of_work_context(
               slot, command_id, actor_type, actor_id, authenticated_by,
               consumer_id, schema_version
             ) VALUES (1, ?, ?, ?, ?, 'integration-node-handler', 1)`,
          )
          .run(commandId, actor.type, actor.id, actor.authenticatedBy);
        const topic =
          options.reviewRuntime.recordAggregateExecutionInTransaction({
            commandId,
            actor,
            topicId: input.topicId,
            projectId: input.projectId,
            runId: input.runId,
            manifest: manifestFor(input),
            producer,
            reviewer: {
              participantId: reviewerIdentity.participantId,
              aiMemberId: reviewer.aiMember.id,
              positionId: reviewer.id,
              sessionId: reviewerIdentity.sessionId,
            },
            terminalExecutionFactId: result.terminalExecutionFactId,
            result: output.result,
            conditions: output.conditions,
            evidenceRefs,
          });
        const effectIds = (
          options.database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(commandId) as Array<{ readonly id: string }>
        ).map((entry) => entry.id);
        const receiptJson = canonicalJson({
          status: "succeeded",
          value: {
            topicId: input.topicId,
            gateId: topic.gateResult!.id,
            recordRequest,
          },
          effectIds,
        });
        options.database
          .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
          .run();
        options.database
          .prepare(
            `INSERT INTO command_deduplication(
               command_id, actor_type, actor_id, authenticated_by, consumer_id,
               schema_version, request_hash, status, result_json, result_hash,
               effect_ids_json, completed_at
             ) VALUES (?, ?, ?, ?, 'integration-node-handler', 1, ?, 'completed',
                       ?, ?, ?, ?)`,
          )
          .run(
            commandId,
            actor.type,
            actor.id,
            actor.authenticatedBy,
            sha256(
              canonicalJson({
                schemaVersion: 1,
                actor,
                consumerId: "integration-node-handler",
                request: recordRequest,
              }),
            ),
            receiptJson,
            sha256(receiptJson),
            canonicalJson(effectIds),
            clock().toISOString(),
          );
        options.database.exec("COMMIT");
        return {
          status: "completed",
          topicId: input.topicId,
          qualityGateResultId: topic.gateResult!.id,
        };
      } catch (error) {
        options.database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      return {
        status: "unknown",
        code: "INTEGRATION_AGGREGATE_REVIEW_INVALID",
        message:
          error instanceof Error
            ? error.message
            : "Aggregate Reviewer result was invalid.",
        evidence: { operationKey: input.operationKey },
      };
    }
  };

  return {
    reconcile: (input) => execute(input, true),
    execute: (input) => execute(input, false),
  };
};
