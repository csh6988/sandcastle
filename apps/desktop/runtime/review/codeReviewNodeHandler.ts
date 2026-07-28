import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import type { CompanyCommandRegistry } from "../commandRegistry.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { RuntimeInteraction } from "../interaction.js";
import type {
  ActorRef,
  CodeReviewView,
  DepartmentRunView,
  ReviewTopicView,
} from "../interface.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { WorkPackageRuntime } from "../workspaces/workPackages.js";
import type { CodeReviewRuntime } from "./codeReviewRuntime.js";
import type { ReviewRuntime } from "./reviewRuntime.js";
import {
  ReviewerFindingOutputSchema,
  ReviewerRecheckOutputSchema,
  blockingReviewerExecutionAdapter,
  type ReviewerExecutionAdapter,
  type ReviewerExecutionInput,
  type ReviewerExecutionPhase,
  type ReviewerExecutionResult,
} from "./reviewerExecution.js";

export class CodeReviewNodeHandlerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodeReviewNodeHandlerError";
  }
}

export interface CodeReviewNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly reconcilePending: () => Promise<number>;
}

const actor = (id: string): ActorRef => ({
  type: "runtime-worker",
  id,
  authenticatedBy: "runtime",
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const requireSucceeded = <T extends { readonly status: string }>(
  result: T,
): Extract<T, { readonly status: "succeeded" }> => {
  if (result.status !== "succeeded") {
    const rejected = result as T & {
      readonly error?: { readonly code: string; readonly message: string };
    };
    throw new CodeReviewNodeHandlerError(
      rejected.error?.code ?? "CODE_REVIEW_COMMAND_REJECTED",
      rejected.error?.message ?? "Code Review worker Command was rejected.",
    );
  }
  return result as Extract<T, { readonly status: "succeeded" }>;
};

export const openCodeReviewNodeHandler = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly commandRegistry: CompanyCommandRegistry;
    readonly codeReviews: CodeReviewRuntime;
    readonly reviewRuntime: ReviewRuntime;
    readonly workPackages: WorkPackageRuntime;
    readonly artifacts: ArtifactRegistry;
    readonly interaction: Pick<
      RuntimeInteraction,
      "createSession" | "addParticipant"
    >;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      "inspectRun" | "blockCodeReviewInTransaction" | "executeCodeReviewStage"
    >;
    readonly reviewerExecutionAdapter?: ReviewerExecutionAdapter;
    readonly clock?: () => Date;
  },
): CodeReviewNodeHandler => {
  const clock = options.clock ?? (() => new Date());
  const executionAdapter =
    options.reviewerExecutionAdapter ?? blockingReviewerExecutionAdapter;
  const workerActor = actor("code-review-node-handler");

  const persistStage = (input: {
    readonly review: CodeReviewView;
    readonly phase: ReviewerExecutionPhase;
    readonly participantId: string;
    readonly sessionId: string;
    readonly operationKey: string;
    readonly state: "running" | "succeeded" | "blocked" | "unknown";
    readonly result?: Extract<ReviewerExecutionResult, { status: "succeeded" }>;
    readonly failure?: Extract<
      ReviewerExecutionResult,
      { status: "blocked" | "unknown" }
    >;
  }): void => {
    const now = clock().toISOString();
    const commandId = `${input.operationKey}:${input.state}`;
    const existingReceipt = database
      .prepare("SELECT 1 FROM command_deduplication WHERE command_id = ?")
      .get(commandId);
    if (existingReceipt) return;
    const requestJson = canonicalJson({
      codeReviewId: input.review.id,
      phase: input.phase,
      operationKey: input.operationKey,
      state: input.state,
      result: input.result ?? null,
      failure: input.failure ?? null,
    });
    const stageId = `${input.review.id}:${input.phase}`;
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, 'code-review-node-handler', 1)`,
        )
        .run(
          commandId,
          workerActor.type,
          workerActor.id,
          workerActor.authenticatedBy,
        );
      const isolationJson = input.result
        ? canonicalJson({
            capabilities: input.result.isolation,
            evidence: input.result.isolationEvidence,
          })
        : null;
      const resultJson = input.result
        ? canonicalJson(input.result.output)
        : null;
      database
        .prepare(
          `INSERT INTO code_review_execution_stages(
             id, code_review_manifest_id, phase, operation_key, state,
             reviewer_participant_id, reviewer_session_id, provider_id,
             isolation_receipt_json, isolation_receipt_hash,
             result_json, result_hash, failure_code, failure_message,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(code_review_manifest_id, phase) DO UPDATE SET
             state = excluded.state,
             provider_id = excluded.provider_id,
             isolation_receipt_json = excluded.isolation_receipt_json,
             isolation_receipt_hash = excluded.isolation_receipt_hash,
             result_json = excluded.result_json,
             result_hash = excluded.result_hash,
             failure_code = excluded.failure_code,
             failure_message = excluded.failure_message,
             updated_at = excluded.updated_at`,
        )
        .run(
          stageId,
          input.review.id,
          input.phase,
          input.operationKey,
          input.state,
          input.participantId,
          input.sessionId,
          input.result?.providerId ?? null,
          isolationJson,
          isolationJson ? sha256(isolationJson) : null,
          resultJson,
          resultJson ? sha256(resultJson) : null,
          input.failure?.code ?? null,
          input.failure?.message ?? null,
          now,
          now,
        );
      if (input.result) {
        const capabilitiesJson = canonicalJson(input.result.isolation);
        const evidenceJson = canonicalJson(input.result.isolationEvidence);
        database
          .prepare(
            `UPDATE reviewer_workspace_intents
                SET provider_id = ?, capability_snapshot_json = ?,
                    capability_snapshot_hash = ?,
                    independence_evidence_json = ?, updated_at = ?
              WHERE code_review_manifest_id = ? AND state = 'ready'`,
          )
          .run(
            input.result.providerId,
            capabilitiesJson,
            sha256(capabilitiesJson),
            evidenceJson,
            now,
            input.review.id,
          );
      }
      if (input.failure) {
        options.pipelineRuntime.blockCodeReviewInTransaction({
          runId: input.review.manifest.runId,
          nodeRunId: input.review.workspace.reviewNodeRunId,
          failure: {
            code: input.failure.code,
            message: input.failure.message,
          },
        });
      }
      const eventType =
        input.state === "running"
          ? "code-review.execution.started"
          : input.state === "succeeded"
            ? "code-review.execution.completed"
            : input.state === "blocked"
              ? "code-review.execution.blocked"
              : "code-review.execution.unknown";
      const payload = {
        codeReviewId: input.review.id,
        topicId: input.review.topicId,
        workPackageId: input.review.manifest.workPackageId,
        workPackageVersionId: input.review.manifest.workPackageVersionId,
        phase: input.phase,
        operationKey: input.operationKey,
        state: input.state,
        ...(input.result
          ? {
              providerId: input.result.providerId,
              isolationReceiptHash: isolationJson
                ? sha256(isolationJson)
                : null,
            }
          : {}),
        ...(input.failure ? { failureCode: input.failure.code } : {}),
      };
      database
        .prepare(
          `INSERT INTO runtime_audit_records(
             id, action, entity_type, entity_id, run_id, node_run_id,
             before_json, after_json, created_at, command_id, actor_type,
             actor_id, authenticated_by, consumer_id
           ) VALUES (?, ?, 'code-review-execution', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?,
                     'code-review-node-handler')`,
        )
        .run(
          `${stageId}:${input.state}`,
          eventType,
          stageId,
          input.review.manifest.runId,
          input.review.workspace.reviewNodeRunId,
          canonicalJson(payload),
          now,
          commandId,
          workerActor.type,
          workerActor.id,
          workerActor.authenticatedBy,
        );
      options.events.append({
        type: eventType,
        scope: {
          companyId: "company",
          projectId: input.review.manifest.projectId,
          runId: input.review.manifest.runId,
          nodeRunId: input.review.workspace.reviewNodeRunId,
          topicId: input.review.topicId,
          workPackageId: input.review.manifest.workPackageId,
          workPackageVersionId: input.review.manifest.workPackageVersionId,
          commandId,
        },
        payload,
        timestamp: now,
      });
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      const receiptJson = canonicalJson({
        status: "succeeded",
        value: { stageId, state: input.state },
        effectIds,
      });
      database
        .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
        .run();
      database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, 'code-review-node-handler', 1, ?, 'completed',
                     ?, ?, ?, ?)`,
        )
        .run(
          commandId,
          workerActor.type,
          workerActor.id,
          workerActor.authenticatedBy,
          sha256(requestJson),
          receiptJson,
          sha256(receiptJson),
          canonicalJson(effectIds),
          now,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const stageRow = (reviewId: string, phase: ReviewerExecutionPhase) =>
    database
      .prepare(
        `SELECT operation_key AS operationKey, state, result_json AS resultJson,
                reviewer_participant_id AS participantId,
                reviewer_session_id AS sessionId
           FROM code_review_execution_stages
          WHERE code_review_manifest_id = ? AND phase = ?`,
      )
      .get(reviewId, phase) as
      | {
          readonly operationKey: string;
          readonly state: "running" | "succeeded" | "blocked" | "unknown";
          readonly resultJson: string | null;
          readonly participantId: string;
          readonly sessionId: string;
        }
      | undefined;

  const allowedEvidence = (review: CodeReviewView): Set<string> =>
    new Set([
      review.manifest.diffArtifactVersionId,
      review.manifest.selfCheck.id,
      ...review.manifest.selfCheck.logRefs,
      ...review.manifest.selfCheck.evidenceRefs,
      ...review.manifest.specRevisionIds,
      ...review.manifest.harnessSnapshotIds,
      ...(review.manifest.priorReview?.requiredEvidenceRefs ?? []),
    ]);

  const assertEvidenceAllowed = (
    review: CodeReviewView,
    evidenceRefs: readonly string[],
  ): void => {
    const allowed = allowedEvidence(review);
    if (
      evidenceRefs.length === 0 ||
      evidenceRefs.some((reference) => !allowed.has(reference))
    ) {
      throw new CodeReviewNodeHandlerError(
        "CODE_REVIEW_EVIDENCE_INVALID",
        "Reviewer evidence must be non-empty and drawn only from the frozen Code Review manifest.",
      );
    }
  };

  const validateExecutionOutput = (
    review: CodeReviewView,
    phase: ReviewerExecutionPhase,
    output: unknown,
  ) => {
    if (phase === "initial-finding") {
      const parsed = ReviewerFindingOutputSchema.parse(output);
      for (const finding of parsed.findings) {
        assertEvidenceAllowed(review, finding.evidenceRefs);
      }
      return parsed;
    }
    const parsed = ReviewerRecheckOutputSchema.parse(output);
    assertEvidenceAllowed(review, parsed.evidenceRefs);
    if (
      review.manifest.priorReview?.requiredEvidenceRefs.some(
        (reference) => !parsed.evidenceRefs.includes(reference),
      )
    ) {
      throw new CodeReviewNodeHandlerError(
        "CODE_REVIEW_OBLIGATION_OPEN",
        "Fresh re-review must cite every frozen prior Defect, Gate, and finding before it can close the obligation.",
      );
    }
    return parsed;
  };

  const assertExecutionIsolation = (
    result: Extract<ReviewerExecutionResult, { status: "succeeded" }>,
  ): void => {
    const isolation = result.isolation as Record<string, unknown>;
    const required = [
      "readOnlyFilesystem",
      "independentGitDatabase",
      "independentSessionStorage",
      "independentCredentialScope",
      "independentMutableCache",
      "inputAllowlist",
    ];
    if (
      result.providerId.trim().length === 0 ||
      result.isolationEvidence.length === 0 ||
      required.some((capability) => isolation[capability] !== true) ||
      typeof isolation.mountTableHash !== "string" ||
      isolation.mountTableHash.length !== 64 ||
      typeof isolation.sessionScopeHash !== "string" ||
      isolation.sessionScopeHash.length !== 64 ||
      typeof isolation.cacheScopeHash !== "string" ||
      isolation.cacheScopeHash.length !== 64 ||
      typeof isolation.credentialScopeHash !== "string" ||
      isolation.credentialScopeHash.length !== 64 ||
      typeof isolation.providerOperationId !== "string" ||
      isolation.providerOperationId.trim().length === 0 ||
      isolation.inspectedReadOnlyReviewMount !== true ||
      typeof isolation.inspectedEnvironmentHash !== "string" ||
      isolation.inspectedEnvironmentHash.length !== 64 ||
      typeof isolation.inspectedAt !== "string" ||
      !Number.isFinite(Date.parse(isolation.inspectedAt)) ||
      isolation.terminalProviderStatus !== "completed" ||
      typeof isolation.terminalProviderReceiptHash !== "string" ||
      isolation.terminalProviderReceiptHash.length !== 64 ||
      result.isolation.mechanism.trim().length === 0 ||
      result.isolation.mechanismVersion.trim().length === 0
    ) {
      throw new CodeReviewNodeHandlerError(
        "PROVIDER_ISOLATION_REQUIRED",
        "Reviewer execution did not return a complete execution-bound isolation receipt.",
      );
    }
  };

  const persistIsolationFailure = (input: {
    readonly review: CodeReviewView;
    readonly phase: ReviewerExecutionPhase;
    readonly participantId: string;
    readonly sessionId: string;
    readonly operationKey: string;
    readonly error: unknown;
  }): never => {
    const failure = {
      status: "blocked" as const,
      code: "PROVIDER_ISOLATION_REQUIRED" as const,
      message:
        input.error instanceof Error
          ? input.error.message
          : "Reviewer execution isolation could not be proven.",
      evidence: [],
    };
    persistStage({
      review: input.review,
      phase: input.phase,
      participantId: input.participantId,
      sessionId: input.sessionId,
      operationKey: input.operationKey,
      state: "blocked",
      failure,
    });
    throw new CodeReviewNodeHandlerError(failure.code, failure.message);
  };

  const persistInvalidOutput = (input: {
    readonly review: CodeReviewView;
    readonly phase: ReviewerExecutionPhase;
    readonly participantId: string;
    readonly sessionId: string;
    readonly operationKey: string;
    readonly error: unknown;
  }): never => {
    const failure = {
      status: "blocked" as const,
      code: "REVIEWER_OUTPUT_INVALID" as const,
      message:
        input.error instanceof Error
          ? input.error.message
          : "Reviewer structured output violated the frozen Code Review contract.",
      evidence: [],
    };
    persistStage({
      review: input.review,
      phase: input.phase,
      participantId: input.participantId,
      sessionId: input.sessionId,
      operationKey: input.operationKey,
      state: "blocked",
      failure,
    });
    throw new CodeReviewNodeHandlerError(failure.code, failure.message);
  };

  const executeStage = async (input: ReviewerExecutionInput) => {
    const review = options.codeReviews
      .inspect(input.manifest.runId)
      .find(
        (candidate) =>
          candidate.manifest.workPackageVersionId ===
          input.manifest.workPackageVersionId,
      );
    if (!review) {
      throw new CodeReviewNodeHandlerError(
        "CODE_REVIEW_NOT_FOUND",
        "The Reviewer execution lost its Code Review manifest.",
      );
    }
    const persisted = stageRow(review.id, input.phase);
    if (persisted?.state === "succeeded" && persisted.resultJson) {
      return parseJson<unknown>(persisted.resultJson);
    }
    if (persisted?.state === "blocked" || persisted?.state === "unknown") {
      throw new CodeReviewNodeHandlerError(
        persisted.state === "blocked"
          ? "PROVIDER_ISOLATION_REQUIRED"
          : "RECONCILE_UNKNOWN",
        `Reviewer execution ${persisted.operationKey} is ${persisted.state}.`,
      );
    }
    if (!persisted) {
      persistStage({
        review,
        phase: input.phase,
        participantId: input.reviewer.participantId,
        sessionId: input.reviewer.sessionId,
        operationKey: input.operationKey,
        state: "running",
      });
    }
    const result = await options.pipelineRuntime.executeCodeReviewStage({
      runId: input.manifest.runId,
      nodeRunId: input.reviewNodeRunId,
      reviewerSessionId: input.reviewer.sessionId,
      reviewerAiMemberId: input.reviewer.aiMemberId,
      operationKey: input.operationKey,
      reconcileExisting: persisted?.state === "running",
      timeoutSeconds: input.executionProfile.timeoutSeconds,
      request: input,
      adapter: executionAdapter,
    });
    if (result.status === "running") {
      throw new CodeReviewNodeHandlerError(
        "RECONCILE_UNKNOWN",
        `Reviewer execution ${input.operationKey} remained running after reattachment.`,
      );
    }
    if (result.status !== "succeeded") {
      persistStage({
        review,
        phase: input.phase,
        participantId: input.reviewer.participantId,
        sessionId: input.reviewer.sessionId,
        operationKey: input.operationKey,
        state: result.status,
        failure: result,
      });
      throw new CodeReviewNodeHandlerError(result.code, result.message);
    }
    try {
      assertExecutionIsolation(result);
    } catch (error) {
      return persistIsolationFailure({
        review,
        phase: input.phase,
        participantId: input.reviewer.participantId,
        sessionId: input.reviewer.sessionId,
        operationKey: input.operationKey,
        error,
      });
    }
    let output: ReturnType<typeof validateExecutionOutput>;
    try {
      output = validateExecutionOutput(review, input.phase, result.output);
    } catch (error) {
      return persistInvalidOutput({
        review,
        phase: input.phase,
        participantId: input.reviewer.participantId,
        sessionId: input.reviewer.sessionId,
        operationKey: input.operationKey,
        error,
      });
    }
    persistStage({
      review,
      phase: input.phase,
      participantId: input.reviewer.participantId,
      sessionId: input.reviewer.sessionId,
      operationKey: input.operationKey,
      state: "succeeded",
      result,
    });
    return output;
  };

  const profileFor = (
    run: DepartmentRunView,
    nodeRunId: string,
    review: CodeReviewView,
  ): ReviewerExecutionInput["executionProfile"] => {
    const nodeRun = run.nodes.find((node) => node.id === nodeRunId);
    const pipelineNode = run.snapshot.payload.pipelineVersion.graph.nodes.find(
      (node) => node.id === nodeRun?.pipelineNodeId,
    );
    const profileId =
      pipelineNode?.executionProfileId ??
      run.snapshot.payload.department.defaultExecutionProfileId;
    const profile = run.snapshot.payload.executionProfiles.find(
      (candidate) => candidate.id === profileId,
    );
    if (!profile) {
      throw new CodeReviewNodeHandlerError(
        "RUN_SNAPSHOT_INVALID",
        "The Code Review Node has no frozen Execution Profile.",
      );
    }
    if (
      review.manifest.reviewerExecutionProfileId !== profile.id ||
      JSON.stringify(review.manifest.reviewerCredentialReferenceIds ?? []) !==
        JSON.stringify(profile.secretReferenceIds)
    ) {
      throw new CodeReviewNodeHandlerError(
        "REVIEWER_CREDENTIAL_SCOPE_INVALID",
        "Reviewer execution must use the exact frozen Code Review Execution Profile and Secret References.",
      );
    }
    return {
      agentAdapterId: profile.providerRef,
      model: profile.model,
      sandboxRef: profile.sandboxRef,
      secretReferenceIds: profile.secretReferenceIds,
      timeoutSeconds: profile.limits.timeoutSeconds,
      maxIterations: profile.limits.maxIterations,
    };
  };

  const reviewerPositions = (
    run: DepartmentRunView,
    producerAiMemberId: string,
    producerPositionId: string,
  ) => {
    const eligible = run.snapshot.payload.positions.filter(
      (position) =>
        position.aiMember.status === "active" &&
        position.aiMember.id !== producerAiMemberId &&
        position.id !== producerPositionId,
    );
    const initial =
      eligible.find((position) => position.id === "reviewer") ?? eligible[0];
    const fresh = eligible.find(
      (position) =>
        position.id !== initial?.id &&
        position.aiMember.id !== initial?.aiMember.id &&
        position.id !== "evaluator",
    );
    const moderator =
      eligible.find(
        (position) =>
          position.id === "evaluator" &&
          position.id !== initial?.id &&
          position.id !== fresh?.id,
      ) ??
      eligible.find(
        (position) => position.id !== initial?.id && position.id !== fresh?.id,
      );
    if (!initial || !fresh || !moderator) {
      throw new CodeReviewNodeHandlerError(
        "REVIEWER_INELIGIBLE",
        "Code Review requires two distinct non-producer Reviewers and a moderator in the frozen Snapshot.",
      );
    }
    return { initial, fresh, moderator };
  };

  const driveReview = async (
    run: DepartmentRunView,
    current: CodeReviewView,
  ): Promise<void> => {
    if (
      current.workspace.state !== "ready" ||
      !current.workspace.workspaceRef
    ) {
      return;
    }
    const profile = profileFor(run, current.workspace.reviewNodeRunId, current);
    let topic = options.reviewRuntime.inspect(current.topicId);
    const initialParticipantId = `${current.id}:reviewer`;
    const freshParticipantId = `${current.id}:fresh-reviewer`;
    const initialParticipant = topic.participants.find(
      (participant) => participant.id === initialParticipantId,
    );
    const freshParticipant = topic.participants.find(
      (participant) => participant.id === freshParticipantId,
    );
    if (!initialParticipant || !freshParticipant) {
      throw new CodeReviewNodeHandlerError(
        "REVIEWER_INELIGIBLE",
        "The Code Review Topic lost its frozen Reviewer participants.",
      );
    }
    const freshSessionRole = `fresh-code-recheck:${current.id}`;
    const persistedFreshStage = stageRow(current.id, "fresh-recheck");
    const existingFreshSession = database
      .prepare(
        `SELECT sessions.id
           FROM interaction_sessions AS sessions
           JOIN session_participants AS participants
             ON participants.session_id = sessions.id
          WHERE sessions.project_id = ? AND sessions.run_id = ?
            AND sessions.node_run_id = ? AND sessions.mode = 'run-collaboration'
            AND sessions.status = 'active'
            AND participants.participant_type = 'ai-member'
            AND participants.participant_ref = ?
            AND participants.role = ?
          ORDER BY sessions.created_at, sessions.id LIMIT 1`,
      )
      .get(
        current.manifest.projectId,
        current.manifest.runId,
        current.workspace.reviewNodeRunId,
        freshParticipant.aiMemberId,
        freshSessionRole,
      ) as { readonly id: string } | undefined;
    let freshExecutionSessionId =
      persistedFreshStage?.sessionId ?? existingFreshSession?.id;
    if (!freshExecutionSessionId) {
      const session = options.interaction.createSession({
        projectId: current.manifest.projectId,
        mode: "run-collaboration",
        runId: current.manifest.runId,
        nodeRunId: current.workspace.reviewNodeRunId,
      });
      options.interaction.addParticipant({
        sessionId: session.id,
        participantType: "ai-member",
        participantRef: freshParticipant.aiMemberId,
        role: freshSessionRole,
      });
      freshExecutionSessionId = session.id;
    }
    if (
      !topic.findings.some(
        (finding) => finding.reviewerParticipantId === initialParticipantId,
      )
    ) {
      const output = ReviewerFindingOutputSchema.parse(
        await executeStage({
          operationKey: `code-review:${current.id}:initial-finding`,
          phase: "initial-finding",
          manifest: current.manifest,
          workspaceRef: current.workspace.workspaceRef,
          reviewNodeRunId: current.workspace.reviewNodeRunId,
          reviewer: {
            participantId: initialParticipant.id,
            aiMemberId: initialParticipant.aiMemberId,
            positionId: initialParticipant.positionId,
            sessionId: initialParticipant.sessionId,
          },
          executionProfile: profile,
          findings: topic.findings,
          revision: null,
        }),
      );
      for (const [index, finding] of output.findings.entries()) {
        assertEvidenceAllowed(current, finding.evidenceRefs);
        topic = requireSucceeded(
          options.commandRegistry.execute({
            schemaVersion: 1,
            commandId: `code-review:${current.id}:finding:${index + 1}`,
            actor: actor(initialParticipant.aiMemberId),
            consumerId: "code-review-node-handler",
            expectedRevision: topic.topic.revision,
            command: {
              type: "review.finding.submit",
              topicId: current.topicId,
              findingId: `${current.id}:finding:${index + 1}`,
              reviewerParticipantId: initialParticipant.id,
              reviewerSessionId: initialParticipant.sessionId,
              ...finding,
            },
          }),
        ).value as ReviewTopicView;
      }
    }
    topic = options.reviewRuntime.inspect(current.topicId);
    const owner = topic.participants.find(
      (participant) => participant.role === "owner-participant",
    );
    if (!owner) {
      throw new CodeReviewNodeHandlerError(
        "REVIEW_OWNER_REQUIRED",
        "The Code Review Topic lost its frozen owner participant.",
      );
    }
    for (const finding of topic.findings.filter(
      (candidate) =>
        !topic.resolutions.some(
          (resolution) => resolution.findingId === candidate.id,
        ),
    )) {
      topic = requireSucceeded(
        options.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `code-review:${current.id}:finding:${finding.id}:disposition`,
          actor: actor(owner.aiMemberId),
          consumerId: "code-review-node-handler",
          expectedRevision: topic.topic.revision,
          command: {
            type: "review.finding.disposition",
            topicId: current.topicId,
            resolutionId: `${finding.id}:owner-disposition`,
            findingId: finding.id,
            participantId: owner.id,
            disposition: "rejected",
            response:
              "The exact reviewed Diff is not mutated inside Code Review; the fresh independent recheck decides whether rework is required.",
            evidenceRefs: [current.manifest.diffArtifactVersionId],
          },
        }),
      ).value as ReviewTopicView;
    }
    if (topic.revisions.length === 0) {
      topic = requireSucceeded(
        options.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `code-review:${current.id}:revision`,
          actor: actor(owner.aiMemberId),
          consumerId: "code-review-node-handler",
          expectedRevision: topic.topic.revision,
          command: {
            type: "review.revision.submit",
            topicId: current.topicId,
            revisionId: `${current.id}:revision`,
            ownerParticipantId: owner.id,
            subjectKind: "canonical-diff",
            subjectId: current.manifest.diffArtifactVersionId,
            subjectHash: current.manifest.diffHash,
            producerAiMemberId: topic.topic.producer.aiMemberId,
            producerPositionId: topic.topic.producer.positionId,
            producerSessionId: topic.topic.producer.sessionId,
            evidenceRefs: [current.manifest.selfCheck.id],
          },
        }),
      ).value as ReviewTopicView;
    }
    const revision = topic.revisions.at(-1)!;
    if (!topic.gateResult) {
      const output = ReviewerRecheckOutputSchema.parse(
        await executeStage({
          operationKey: `code-review:${current.id}:fresh-recheck`,
          phase: "fresh-recheck",
          manifest: current.manifest,
          workspaceRef: current.workspace.workspaceRef,
          reviewNodeRunId: current.workspace.reviewNodeRunId,
          reviewer: {
            participantId: freshParticipant.id,
            aiMemberId: freshParticipant.aiMemberId,
            positionId: freshParticipant.positionId,
            sessionId: freshExecutionSessionId,
          },
          executionProfile: profile,
          findings: topic.findings,
          revision: {
            id: revision.id,
            subjectId: revision.subjectId,
            subjectHash: revision.subjectHash,
          },
        }),
      );
      assertEvidenceAllowed(current, output.evidenceRefs);
      const result =
        output.result === "PASS" &&
        topic.findings.some((finding) => finding.blocking)
          ? "FAIL"
          : output.result;
      topic = requireSucceeded(
        options.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `code-review:${current.id}:fresh-recheck`,
          actor: actor(freshParticipant.aiMemberId),
          consumerId: "code-review-node-handler",
          expectedRevision: topic.topic.revision,
          command: {
            type: "review.recheck.submit",
            topicId: current.topicId,
            recheckId: `${current.id}:fresh-recheck`,
            revisionId: revision.id,
            reviewerParticipantId: freshParticipant.id,
            reviewerSessionId: freshExecutionSessionId,
            result,
            conditions: result === "CONDITIONAL_PASS" ? output.conditions : [],
            evidenceRefs: output.evidenceRefs,
          },
        }),
      ).value as ReviewTopicView;
    }
    if (!topic.gateResult) return;
    const workPackage = options.workPackages
      .inspect(current.manifest.runId)
      .packages.find(
        (candidate) => candidate.id === current.manifest.workPackageId,
      );
    if (!workPackage) {
      throw new CodeReviewNodeHandlerError(
        "WORK_PACKAGE_NOT_FOUND",
        "The Code Review Work Package disappeared before convergence.",
      );
    }
    const terminal = topic.gateResult.result;
    requireSucceeded(
      options.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `code-review:${current.id}:converge:${topic.gateResult.id}`,
        actor: workerActor,
        consumerId: "code-review-node-handler",
        expectedRevision: workPackage.revision,
        command: {
          type: "code-review.converge",
          codeReviewId: current.id,
          ...(terminal === "PASS"
            ? {}
            : {
                reworkVersionId: `${current.manifest.workPackageVersionId}:rework:${topic.gateResult.id}`,
                reworkBaseCommit: current.manifest.sourceCommit,
              }),
        },
      }),
    );
  };

  const startMissingReviews = async (
    run: DepartmentRunView,
    nodeRunId: string,
  ): Promise<void> => {
    const graph = options.workPackages.inspect(run.run.id);
    for (const workPackage of graph.packages) {
      const activeVersion = workPackage.versions.find(
        (version) => version.status === "ready",
      );
      const assignment = activeVersion?.assignments.at(-1);
      if (!activeVersion || assignment?.state !== "self-check-passed") continue;
      const existing = options.codeReviews
        .inspect(run.run.id)
        .find(
          (review) => review.manifest.workPackageVersionId === activeVersion.id,
        );
      if (existing) {
        if (!existing.authority && existing.defects.length === 0) {
          await driveReview(run, existing);
        }
        continue;
      }
      const diff = options.artifacts
        .listVersionsForRun(run.run.id)
        .find(
          (artifact) =>
            artifact.type === "canonical-diff" &&
            artifact.schemaVersion === "1" &&
            artifact.status !== "superseded" &&
            artifact.producer.nodeAttemptId === assignment.nodeAttemptId &&
            artifact.producer.workPackageId === workPackage.id,
        );
      if (!diff) continue;
      const positions = reviewerPositions(
        run,
        assignment.aiMemberId,
        assignment.positionId,
      );
      const codeReviewId = `code-review:${activeVersion.id}:${diff.id}`;
      requireSucceeded(
        options.commandRegistry.execute({
          schemaVersion: 1,
          commandId: `${codeReviewId}:start`,
          actor: workerActor,
          consumerId: "code-review-node-handler",
          expectedRevision: workPackage.revision,
          command: {
            type: "code-review.start",
            codeReviewId,
            topicId: `${codeReviewId}:topic`,
            workPackageId: workPackage.id,
            diffArtifactVersionId: diff.id,
            reviewerPositionId: positions.initial.id,
            freshReviewerPositionId: positions.fresh.id,
            moderatorPositionId: positions.moderator.id,
          },
        }),
      );
      const prepared =
        options.codeReviews.reconcileReviewerWorkspace(codeReviewId);
      if (prepared.workspace.reviewNodeRunId !== nodeRunId) {
        throw new CodeReviewNodeHandlerError(
          "CODE_REVIEW_NODE_NOT_READY",
          "The Code Review manifest was attached to a different Pipeline Node.",
        );
      }
      if (prepared.workspace.state === "ready") {
        await driveReview(run, prepared);
      }
    }
    const activeVersionIds = graph.packages
      .map((workPackage) =>
        workPackage.versions.find((version) => version.status === "ready"),
      )
      .filter((version) => version !== undefined)
      .map((version) => version.id)
      .sort();
    const eligible = options.codeReviews
      .inspect(run.run.id)
      .filter(
        (review) =>
          review.integrationEligible &&
          activeVersionIds.includes(review.manifest.workPackageVersionId),
      )
      .sort((left, right) =>
        left.manifest.workPackageVersionId.localeCompare(
          right.manifest.workPackageVersionId,
        ),
      );
    if (
      activeVersionIds.length > 0 &&
      eligible.length === activeVersionIds.length &&
      eligible.every(
        (review, index) =>
          review.manifest.workPackageVersionId === activeVersionIds[index] &&
          review.authority !== null &&
          review.gateResult !== null,
      )
    ) {
      const anchor = eligible[0]!;
      const anchorPackage = graph.packages.find(
        (workPackage) => workPackage.id === anchor.manifest.workPackageId,
      );
      if (anchorPackage) {
        const coverageKey = sha256(
          canonicalJson({
            activeVersionIds,
            authorityIds: eligible.map((review) => review.authority!.id),
          }),
        );
        requireSucceeded(
          options.commandRegistry.execute({
            schemaVersion: 1,
            commandId: `code-review:coverage-reconcile:${coverageKey}`,
            actor: workerActor,
            consumerId: "code-review-node-handler",
            expectedRevision: anchorPackage.revision,
            command: {
              type: "code-review.converge",
              codeReviewId: anchor.id,
            },
          }),
        );
      }
    }
  };

  const executeReady: CodeReviewNodeHandler["executeReady"] = async (input) => {
    const run = options.pipelineRuntime.inspectRun(input.runId);
    const node = run.nodes.find(
      (candidate) => candidate.id === input.nodeRunId,
    );
    if (node?.handler?.handlerKindId !== "code-review@1") {
      throw new CodeReviewNodeHandlerError(
        "CODE_REVIEW_NODE_NOT_FOUND",
        `Node Run ${input.nodeRunId} is not the frozen code-review@1 Node.`,
      );
    }
    await startMissingReviews(run, input.nodeRunId);
  };

  const reconcilePending = async (): Promise<number> => {
    const rows = database
      .prepare(
        `SELECT DISTINCT manifests.run_id AS runId,
                         workspaces.review_node_run_id AS nodeRunId
           FROM code_review_manifests AS manifests
           JOIN reviewer_workspace_intents AS workspaces
             ON workspaces.code_review_manifest_id = manifests.id
           JOIN node_runs
             ON node_runs.id = workspaces.review_node_run_id
          WHERE workspaces.state = 'ready'
            AND node_runs.status = 'running'
          ORDER BY manifests.run_id, workspaces.review_node_run_id`,
      )
      .all() as Array<{ readonly runId: string; readonly nodeRunId: string }>;
    for (const row of rows) await executeReady(row);
    return rows.length;
  };

  return { executeReady, reconcilePending };
};
