import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import type { RuntimeEvents } from "../events/subscription.js";
import {
  CodeReviewManifestSchema,
  CodeReviewViewSchema,
  type ActorRef,
  type CodeReviewEnvelopeCommand,
  type CodeReviewManifest,
  type CodeReviewView,
  type ReviewTopicView,
} from "../interface.js";
import type { WorkPackageRuntime } from "../workspaces/workPackages.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { ReviewRuntime } from "./reviewRuntime.js";
import {
  ReviewerFindingOutputSchema,
  ReviewerRecheckOutputSchema,
} from "./reviewerExecution.js";
import { readCanonicalGitDiff } from "./reviewerWorkspace.js";

export class CodeReviewRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodeReviewRuntimeError";
  }
}

export interface ReviewerWorkspaceProvisionInput {
  readonly operationKey: string;
  readonly manifest: CodeReviewManifest;
  readonly reviewer: {
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  };
}

export type ReviewerWorkspaceProvisionResult =
  | {
      readonly status: "ready";
      readonly providerId: string;
      readonly workspaceRef: string;
      readonly capabilities: {
        readonly readOnlyFilesystem: true;
        readonly independentGitDatabase: true;
        readonly independentSessionStorage: true;
        readonly independentCredentialScope: true;
        readonly independentMutableCache: true;
        readonly inputAllowlist: true;
        readonly mechanism: string;
        readonly mechanismVersion: string;
      };
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "blocked" | "unknown";
      readonly code: "PROVIDER_ISOLATION_REQUIRED" | "RECONCILE_UNKNOWN";
      readonly message: string;
      readonly evidence: readonly string[];
    };

export interface ReviewerWorkspaceAdapter {
  readonly provision: (
    input: ReviewerWorkspaceProvisionInput,
  ) => ReviewerWorkspaceProvisionResult;
}

export const blockingReviewerWorkspaceAdapter: ReviewerWorkspaceAdapter = {
  provision: () => ({
    status: "blocked",
    code: "PROVIDER_ISOLATION_REQUIRED",
    message:
      "No reviewer provider proved an independent read-only Workspace, Session storage, credentials, and mutable cache.",
    evidence: [],
  }),
};

export interface CodeReviewRuntime {
  readonly inspect: (runId: string) => readonly CodeReviewView[];
  readonly readCompletedCoverage: (
    runId: string,
  ) => CompletedCodeReviewCoverage;
  readonly dispatchInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: CodeReviewEnvelopeCommand;
  }) => CodeReviewView;
  readonly reconcileReviewerWorkspace: (codeReviewId: string) => CodeReviewView;
  readonly reconcilePendingReviewerWorkspaces: () => void;
}

export type CompletedCodeReviewCoverage = {
  readonly coverageId: string;
  readonly coverageHash: string;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly packages: readonly {
    readonly workPackageId: string;
    readonly workPackageVersionId: string;
    readonly applicationId: string;
    readonly repositoryReference: string;
    readonly baseCommit: string;
    readonly sourceBranch: string;
    readonly sourceCommit: string;
    readonly diffHash: string;
    readonly authorityId: string;
    readonly qualityGateResultId: string;
    readonly dependencies: readonly {
      readonly predecessorWorkPackageVersionId: string;
      readonly kind:
        | "artifact"
        | "commit"
        | "contract"
        | "readiness"
        | "manual";
      readonly contractId: string | null;
      readonly contractVersion: string | null;
      readonly evidenceRef: string | null;
    }[];
    readonly contractVersions: readonly {
      readonly id: string;
      readonly version: string;
      readonly hash: string;
    }[];
    readonly integrationConditions: readonly string[];
  }[];
};

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

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const assertRuntimeActor = (actor: ActorRef): void => {
  if (actor.type !== "runtime-worker" || actor.authenticatedBy !== "runtime") {
    throw new CodeReviewRuntimeError(
      "PERMISSION_DENIED",
      "Independent Code Review Commands require a Runtime worker actor.",
    );
  }
};

export const openCodeReviewRuntime = (
  database: DatabaseSync,
  options: {
    readonly events: Pick<RuntimeEvents, "append">;
    readonly reviewRuntime: ReviewRuntime;
    readonly workPackages: WorkPackageRuntime;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      | "blockCodeReviewInTransaction"
      | "startCodeReviewInTransaction"
      | "completeCodeReviewInTransaction"
      | "inspectRun"
    >;
    readonly artifacts: ArtifactRegistry;
    readonly reviewerWorkspaceAdapter?: ReviewerWorkspaceAdapter;
    readonly clock?: () => Date;
  },
): CodeReviewRuntime => {
  const clock = options.clock ?? (() => new Date());
  const adapter =
    options.reviewerWorkspaceAdapter ?? blockingReviewerWorkspaceAdapter;

  const manifestIsCurrent = (manifest: CodeReviewManifest): boolean => {
    try {
      const workPackage = options.workPackages
        .inspect(manifest.runId)
        .packages.find((entry) => entry.id === manifest.workPackageId);
      const activeVersion = workPackage?.versions.find(
        (version) => version.status === "ready",
      );
      const activeAssignment = activeVersion?.assignments.at(-1);
      const activeImport = activeAssignment?.allocation.imports
        .filter((entry) => entry.state === "succeeded")
        .at(-1);
      const artifact = options.artifacts.inspect(
        manifest.diffArtifactVersionId,
      ).version;
      const artifactBytes = options.artifacts.readContent(artifact.id);
      const diff = readCanonicalGitDiff({
        repositoryReference: manifest.repositoryReference,
        baseCommit: manifest.baseCommit,
        sourceCommit: manifest.sourceCommit,
      });
      return (
        activeVersion?.id === manifest.workPackageVersionId &&
        activeAssignment?.id === manifest.assignmentId &&
        activeAssignment.state === "self-check-passed" &&
        activeAssignment.nodeAttemptId === manifest.nodeAttemptId &&
        activeAssignment.selfCheck?.id === manifest.selfCheck.id &&
        activeAssignment.selfCheck.status === "passed" &&
        activeAssignment.selfCheck.reportHash === manifest.selfCheck.hash &&
        activeImport?.id === manifest.workspaceImportId &&
        activeImport.resultCommit === manifest.sourceCommit &&
        artifact.type === "canonical-diff" &&
        artifact.schemaVersion === "1" &&
        artifact.contentKind === "managed-file" &&
        artifact.status !== "superseded" &&
        artifact.integrityStatus === "verified" &&
        artifact.contentHash === manifest.diffHash &&
        artifact.contentHash === sha256(diff) &&
        artifact.producer.runId === manifest.runId &&
        artifact.producer.nodeAttemptId === manifest.nodeAttemptId &&
        artifact.producer.workPackageId === manifest.workPackageId &&
        artifactBytes.equals(diff)
      );
    } catch {
      return false;
    }
  };

  const packageHasOpenDefect = (workPackageId: string): boolean =>
    Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM code_review_defects
              WHERE work_package_id = ? AND status <> 'closed'`,
          )
          .get(workPackageId) as { readonly count: number }
      ).count,
    ) > 0;

  type ExecutionStageEvidence = {
    readonly id: string;
    readonly phase: "fresh-recheck" | "initial-finding";
    readonly operationKey: string;
    readonly state: string;
    readonly participantId: string;
    readonly sessionId: string;
    readonly providerId: string | null;
    readonly isolationReceiptJson: string | null;
    readonly isolationReceiptHash: string | null;
    readonly resultJson: string | null;
    readonly resultHash: string | null;
  };

  const readExecutionStages = (
    codeReviewId: string,
  ): readonly ExecutionStageEvidence[] =>
    database
      .prepare(
        `SELECT id, phase, operation_key AS operationKey, state,
                reviewer_participant_id AS participantId,
                reviewer_session_id AS sessionId, provider_id AS providerId,
                isolation_receipt_json AS isolationReceiptJson,
                isolation_receipt_hash AS isolationReceiptHash,
                result_json AS resultJson, result_hash AS resultHash
           FROM code_review_execution_stages
          WHERE code_review_manifest_id = ?
          ORDER BY phase`,
      )
      .all(codeReviewId) as ExecutionStageEvidence[];

  const executionEvidenceIsExact = (input: {
    readonly codeReviewId: string;
    readonly topic: ReviewTopicView;
    readonly authority?: {
      readonly initialExecutionStageId: string | null;
      readonly initialIsolationReceiptHash: string | null;
      readonly initialResultHash: string | null;
      readonly freshExecutionStageId: string | null;
      readonly freshIsolationReceiptHash: string | null;
      readonly freshResultHash: string | null;
    };
  }): boolean => {
    try {
      const stages = readExecutionStages(input.codeReviewId);
      if (stages.length !== 2) return false;
      const initial = stages.find((stage) => stage.phase === "initial-finding");
      const fresh = stages.find((stage) => stage.phase === "fresh-recheck");
      const storageIsValid = (
        stage: ExecutionStageEvidence | undefined,
      ): stage is ExecutionStageEvidence =>
        stage?.state === "succeeded" &&
        stage.operationKey ===
          `code-review:${input.codeReviewId}:${stage.phase}` &&
        Boolean(stage.providerId) &&
        stage.isolationReceiptJson !== null &&
        stage.isolationReceiptHash === sha256(stage.isolationReceiptJson) &&
        stage.resultJson !== null &&
        stage.resultHash === sha256(stage.resultJson);
      if (!storageIsValid(initial) || !storageIsValid(fresh)) return false;

      const initialOutput = ReviewerFindingOutputSchema.parse(
        parseJson<unknown>(initial.resultJson!),
      );
      const persistedFindings = input.topic.findings.filter(
        (finding) =>
          finding.reviewerParticipantId === initial.participantId &&
          finding.reviewerSessionId === initial.sessionId,
      );
      const expectedInitial = {
        findings: persistedFindings.map((finding) => ({
          severity: finding.severity,
          summary: finding.summary,
          rationale: finding.rationale,
          impact: finding.impact,
          evidenceRefs: finding.evidenceRefs,
          suggestedOwner: finding.suggestedOwner,
          blocking: finding.blocking,
          ...(finding.scopeImpact ? { scopeImpact: finding.scopeImpact } : {}),
        })),
      };
      if (canonicalJson(initialOutput) !== canonicalJson(expectedInitial)) {
        return false;
      }

      const freshOutput = ReviewerRecheckOutputSchema.parse(
        parseJson<unknown>(fresh.resultJson!),
      );
      const persistedRecheck = input.topic.rechecks.find(
        (recheck) =>
          recheck.reviewerParticipantId === fresh.participantId &&
          recheck.reviewerSessionId === fresh.sessionId,
      );
      if (
        !persistedRecheck ||
        canonicalJson(freshOutput) !==
          canonicalJson({
            result: persistedRecheck.result,
            conditions: persistedRecheck.conditions,
            evidenceRefs: persistedRecheck.evidenceRefs,
          })
      ) {
        return false;
      }
      if (input.authority) {
        return (
          input.authority.initialExecutionStageId === initial.id &&
          input.authority.initialIsolationReceiptHash ===
            initial.isolationReceiptHash &&
          input.authority.initialResultHash === initial.resultHash &&
          input.authority.freshExecutionStageId === fresh.id &&
          input.authority.freshIsolationReceiptHash ===
            fresh.isolationReceiptHash &&
          input.authority.freshResultHash === fresh.resultHash
        );
      }
      return true;
    } catch {
      return false;
    }
  };

  const appendMutation = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly topicId: string;
    readonly workPackageId: string;
    readonly workPackageVersionId: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly createdAt: string;
    readonly qualityGateResultId?: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        randomUUID(),
        input.action,
        input.entityType,
        input.entityId,
        input.runId,
        canonicalJson(input.payload),
        input.createdAt,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    options.events.append({
      type: input.eventType,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        runId: input.runId,
        topicId: input.topicId,
        workPackageId: input.workPackageId,
        workPackageVersionId: input.workPackageVersionId,
        ...(input.qualityGateResultId
          ? { qualityGateResultId: input.qualityGateResultId }
          : {}),
        commandId: input.commandId,
      },
      payload: input.payload,
      timestamp: input.createdAt,
    });
  };

  const readOne = (id: string): CodeReviewView => {
    const row = database
      .prepare(
        `SELECT manifests.id, manifests.topic_id AS topicId,
                manifests.manifest_json AS manifestJson,
                manifests.manifest_hash AS manifestHash,
                workspaces.id AS workspaceId,
                workspaces.operation_key AS operationKey,
                workspaces.state AS workspaceState,
                workspaces.reviewer_ai_member_id AS reviewerAiMemberId,
                workspaces.reviewer_position_id AS reviewerPositionId,
                workspaces.reviewer_session_id AS reviewerSessionId,
                workspaces.review_node_run_id AS reviewNodeRunId,
                workspaces.provider_id AS providerId,
                workspaces.workspace_ref AS workspaceRef,
                workspaces.capability_snapshot_hash AS capabilitySnapshotHash,
                workspaces.independence_evidence_json AS independenceEvidenceJson,
                workspaces.failure_code AS failureCode,
                workspaces.failure_message AS failureMessage
           FROM code_review_manifests AS manifests
           JOIN reviewer_workspace_intents AS workspaces
             ON workspaces.code_review_manifest_id = manifests.id
          WHERE manifests.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_NOT_FOUND",
        `Code Review ${id} was not found.`,
      );
    }
    const manifest = CodeReviewManifestSchema.parse(
      parseJson(String(row.manifestJson)),
    );
    const topic = options.reviewRuntime.inspect(String(row.topicId));
    const authority = database
      .prepare(
        `SELECT id, quality_gate_result_id AS qualityGateResultId,
                work_package_version_id AS workPackageVersionId,
                source_commit AS sourceCommit, diff_hash AS diffHash,
                reviewer_session_id AS reviewerSessionId,
                independence_evidence_hash AS independenceEvidenceHash,
                initial_execution_stage_id AS initialExecutionStageId,
                initial_isolation_receipt_hash AS initialIsolationReceiptHash,
                initial_result_hash AS initialResultHash,
                fresh_execution_stage_id AS freshExecutionStageId,
                fresh_isolation_receipt_hash AS freshIsolationReceiptHash,
                fresh_result_hash AS freshResultHash,
                created_at AS createdAt
           FROM code_review_authorities WHERE code_review_manifest_id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    const defects = database
      .prepare(
        `SELECT id, quality_gate_result_id AS qualityGateResultId, result,
                finding_ids_json AS findingIdsJson,
                obligation_json AS obligationJson,
                rework_work_package_version_id AS reworkWorkPackageVersionId,
                status, created_at AS createdAt
           FROM code_review_defects
          WHERE code_review_manifest_id = ? ORDER BY created_at, id`,
      )
      .all(id) as Array<Record<string, unknown>>;
    const evidence =
      row.independenceEvidenceJson === null
        ? null
        : String(row.independenceEvidenceJson);
    return CodeReviewViewSchema.parse({
      id: row.id,
      topicId: row.topicId,
      manifest,
      manifestHash: row.manifestHash,
      workspace: {
        id: row.workspaceId,
        operationKey: row.operationKey,
        state: row.workspaceState,
        reviewerAiMemberId: row.reviewerAiMemberId,
        reviewerPositionId: row.reviewerPositionId,
        reviewerSessionId: row.reviewerSessionId,
        reviewNodeRunId: row.reviewNodeRunId,
        providerId: row.providerId,
        workspaceRef: row.workspaceRef,
        capabilitySnapshotHash: row.capabilitySnapshotHash,
        independenceEvidenceHash: evidence ? sha256(evidence) : null,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage,
      },
      gateResult: topic.gateResult,
      authority: authority ?? null,
      defects: defects.map((defect) => ({
        id: defect.id,
        qualityGateResultId: defect.qualityGateResultId,
        result: defect.result,
        findingIds: parseJson(String(defect.findingIdsJson)),
        obligation: parseJson(String(defect.obligationJson)),
        reworkWorkPackageVersionId: defect.reworkWorkPackageVersionId,
        status: defect.status,
        createdAt: defect.createdAt,
      })),
      integrationEligible:
        authority !== undefined &&
        authority.qualityGateResultId === topic.gateResult?.id &&
        authority.workPackageVersionId === manifest.workPackageVersionId &&
        authority.sourceCommit === manifest.sourceCommit &&
        authority.diffHash === manifest.diffHash &&
        topic.gateResult?.kind === "code" &&
        topic.gateResult.result === "PASS" &&
        executionEvidenceIsExact({
          codeReviewId: String(row.id),
          topic,
          authority: authority as {
            readonly initialExecutionStageId: string | null;
            readonly initialIsolationReceiptHash: string | null;
            readonly initialResultHash: string | null;
            readonly freshExecutionStageId: string | null;
            readonly freshIsolationReceiptHash: string | null;
            readonly freshResultHash: string | null;
          },
        }) &&
        manifestIsCurrent(manifest) &&
        !packageHasOpenDefect(manifest.workPackageId),
    });
  };

  const inspect = (runId: string): readonly CodeReviewView[] => {
    const ids = database
      .prepare(
        `SELECT id FROM code_review_manifests
          WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as Array<{ readonly id: string }>;
    return ids.map((row) => readOne(row.id));
  };

  const reconcileAggregateCoverage = (current: CodeReviewView): void => {
    const node = database
      .prepare(
        `SELECT status FROM node_runs
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'code-review@1'`,
      )
      .get(current.workspace.reviewNodeRunId, current.manifest.runId) as
      | { readonly status: string }
      | undefined;
    if (node?.status !== "running") return;
    const workPackageVersionIds = options.workPackages
      .inspect(current.manifest.runId)
      .packages.map((workPackage) =>
        workPackage.versions.find((version) => version.status === "ready"),
      )
      .filter((version) => version !== undefined)
      .map((version) => version.id)
      .sort();
    const eligible = inspect(current.manifest.runId)
      .filter(
        (review) =>
          review.integrationEligible &&
          workPackageVersionIds.includes(review.manifest.workPackageVersionId),
      )
      .sort((left, right) =>
        left.manifest.workPackageVersionId.localeCompare(
          right.manifest.workPackageVersionId,
        ),
      );
    if (
      workPackageVersionIds.length === 0 ||
      eligible.length !== workPackageVersionIds.length ||
      eligible.some(
        (review, index) =>
          review.manifest.workPackageVersionId !==
            workPackageVersionIds[index] ||
          !review.authority ||
          !review.gateResult,
      )
    ) {
      return;
    }
    const authorityIds = eligible.map((review) => review.authority!.id);
    const qualityGateResultIds = eligible.map(
      (review) => review.gateResult!.id,
    );
    const coverageHash = sha256(
      canonicalJson({
        schemaVersion: 1,
        runId: current.manifest.runId,
        nodeRunId: current.workspace.reviewNodeRunId,
        workPackageVersionIds,
        authorityIds,
        qualityGateResultIds,
      }),
    );
    options.pipelineRuntime.completeCodeReviewInTransaction({
      runId: current.manifest.runId,
      nodeRunId: current.workspace.reviewNodeRunId,
      workPackageVersionIds,
      authorityIds,
      qualityGateResultIds,
      coverageHash,
    });
  };

  const createSession = (input: {
    readonly projectId: string;
    readonly runId: string;
    readonly nodeRunId: string;
    readonly aiMemberId: string;
    readonly role: string;
    readonly now: string;
  }): string => {
    const sessionId = randomUUID();
    database
      .prepare(
        `INSERT INTO interaction_sessions(
           id, mode, project_id, run_id, node_run_id, status, created_at
         ) VALUES (?, 'run-collaboration', ?, ?, ?, 'active', ?)`,
      )
      .run(sessionId, input.projectId, input.runId, input.nodeRunId, input.now);
    database
      .prepare(
        `INSERT INTO session_participants(
           id, session_id, participant_type, participant_ref, role, created_at
         ) VALUES (?, ?, 'ai-member', ?, ?, ?)`,
      )
      .run(randomUUID(), sessionId, input.aiMemberId, input.role, input.now);
    return sessionId;
  };

  const positionMember = (positionId: string) => {
    const row = database
      .prepare(
        `SELECT positions.ai_member_id AS aiMemberId
           FROM positions JOIN ai_members
             ON ai_members.id = positions.ai_member_id
          WHERE positions.id = ? AND positions.status = 'active'
            AND ai_members.status = 'active'`,
      )
      .get(positionId) as { readonly aiMemberId: string } | undefined;
    if (!row) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        `Position ${positionId} is not an active reviewer identity.`,
      );
    }
    return row.aiMemberId;
  };

  const start = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      CodeReviewEnvelopeCommand,
      { type: "code-review.start" }
    >;
  }): CodeReviewView => {
    assertRuntimeActor(input.actor);
    if (input.expectedRevision === undefined) {
      throw new CodeReviewRuntimeError(
        "EXPECTED_REVISION_REQUIRED",
        "Code Review start requires the Work Package revision.",
      );
    }
    const graphRow = database
      .prepare(
        `SELECT packages.project_id AS projectId, packages.run_id AS runId,
                packages.revision, packages.state, versions.id AS versionId,
                versions.status AS versionStatus,
                versions.repository_reference AS repositoryReference,
                versions.node_run_id AS nodeRunId,
                versions.manifest_json AS packageManifestJson,
                assignments.id AS assignmentId,
                assignments.node_attempt_id AS nodeAttemptId,
                assignments.ai_member_id AS producerAiMemberId,
                assignments.position_id AS producerPositionId,
                assignments.interaction_session_id AS producerSessionId,
                assignments.state AS assignmentState,
                assignments.allocation_id AS allocationId,
                allocations.execution_profile_id AS producerExecutionProfileId,
                allocations.base_commit AS baseCommit,
                runs.snapshot_revision_id AS snapshotRevisionId,
                self_checks.id AS selfCheckId,
                self_checks.report_json AS selfCheckReportJson,
                self_checks.report_hash AS selfCheckHash
           FROM work_packages AS packages
           JOIN work_package_versions AS versions
             ON versions.work_package_id = packages.id AND versions.status = 'ready'
           JOIN work_package_assignments AS assignments
             ON assignments.work_package_version_id = versions.id
           JOIN workspace_allocations AS allocations
             ON allocations.id = assignments.allocation_id
           JOIN department_runs AS runs ON runs.id = packages.run_id
           JOIN work_package_self_checks AS self_checks
             ON self_checks.assignment_id = assignments.id
          WHERE packages.id = ?
          ORDER BY assignments.created_at DESC LIMIT 1`,
      )
      .get(input.command.workPackageId) as Record<string, unknown> | undefined;
    if (!graphRow) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_INPUT_NOT_READY",
        "Code Review requires the active Work Package Assignment and passing self-check.",
      );
    }
    if (Number(graphRow.revision) !== input.expectedRevision) {
      throw new CodeReviewRuntimeError(
        "REVISION_CONFLICT",
        `Work Package is at revision ${String(graphRow.revision)}, not ${input.expectedRevision}.`,
      );
    }
    if (
      graphRow.state !== "self-check" ||
      graphRow.assignmentState !== "self-check-passed" ||
      graphRow.versionStatus !== "ready"
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_INPUT_NOT_READY",
        "Only the active self-check-passed Assignment can enter Code Review.",
      );
    }
    const workspaceImport = database
      .prepare(
        `SELECT id, result_commit AS resultCommit
           FROM workspace_imports
          WHERE allocation_id = ? AND state = 'succeeded'
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(String(graphRow.allocationId)) as
      | { readonly id: string; readonly resultCommit: string }
      | undefined;
    if (!workspaceImport) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_IMPORT_REQUIRED",
        "Code Review requires the exact Runtime-owned source import.",
      );
    }
    const artifact = options.artifacts.inspect(
      input.command.diffArtifactVersionId,
    ).version;
    const artifactBytes = options.artifacts.readContent(artifact.id);
    let canonicalDiff: Buffer;
    try {
      canonicalDiff = readCanonicalGitDiff({
        repositoryReference: String(graphRow.repositoryReference),
        baseCommit: String(graphRow.baseCommit),
        sourceCommit: workspaceImport.resultCommit,
      });
    } catch {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_DIFF_INVALID",
        "The canonical Diff cannot be reproduced from the frozen Repository commits.",
      );
    }
    if (
      artifact.type !== "canonical-diff" ||
      artifact.schemaVersion !== "1" ||
      artifact.contentKind !== "managed-file" ||
      artifact.projectId !== graphRow.projectId ||
      artifact.producer.runId !== graphRow.runId ||
      artifact.producer.nodeAttemptId !== graphRow.nodeAttemptId ||
      artifact.producer.workPackageId !== input.command.workPackageId ||
      artifact.status === "superseded" ||
      artifact.integrityStatus !== "verified" ||
      artifact.contentHash !== sha256(canonicalDiff) ||
      !artifactBytes.equals(canonicalDiff)
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_DIFF_INVALID",
        "The canonical Diff Artifact must be verified and produced by the exact Assignment.",
      );
    }
    const reviewerAiMemberId = positionMember(input.command.reviewerPositionId);
    if (
      reviewerAiMemberId === graphRow.producerAiMemberId ||
      input.command.reviewerPositionId === graphRow.producerPositionId
    ) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        "The producer AI member or Position cannot review its own Work Package.",
      );
    }
    const freshReviewerAiMemberId = positionMember(
      input.command.freshReviewerPositionId,
    );
    if (
      freshReviewerAiMemberId === graphRow.producerAiMemberId ||
      input.command.freshReviewerPositionId === graphRow.producerPositionId ||
      freshReviewerAiMemberId === reviewerAiMemberId ||
      input.command.freshReviewerPositionId === input.command.reviewerPositionId
    ) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        "Fresh re-review requires a second non-producer AI member and Position.",
      );
    }
    const moderatorAiMemberId = positionMember(
      input.command.moderatorPositionId,
    );
    const reviewNodes = database
      .prepare(
        `SELECT id, status FROM node_runs
          WHERE run_id = ? AND handler_kind_id = 'code-review@1'
          ORDER BY created_at, id`,
      )
      .all(String(graphRow.runId)) as Array<{
      readonly id: string;
      readonly status: string;
    }>;
    if (reviewNodes.length !== 1) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_NODE_NOT_READY",
        "Independent Code Review requires exactly one active code-review@1 Node Run.",
      );
    }
    const reviewNode = reviewNodes[0]!;
    if (
      !["queued", "ready", "blocked", "running"].includes(reviewNode.status)
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_NODE_NOT_READY",
        `Independent Code Review cannot add package coverage while the shared Code Review Node is ${reviewNode.status}.`,
      );
    }
    const reviewNodeRunId = reviewNode.id;
    const now = clock().toISOString();
    const reviewerSessionId = createSession({
      projectId: String(graphRow.projectId),
      runId: String(graphRow.runId),
      nodeRunId: reviewNodeRunId,
      aiMemberId: reviewerAiMemberId,
      role: "code-reviewer",
      now,
    });
    const moderatorSessionId = createSession({
      projectId: String(graphRow.projectId),
      runId: String(graphRow.runId),
      nodeRunId: reviewNodeRunId,
      aiMemberId: moderatorAiMemberId,
      role: "review-moderator",
      now,
    });
    const freshReviewerSessionId = createSession({
      projectId: String(graphRow.projectId),
      runId: String(graphRow.runId),
      nodeRunId: reviewNodeRunId,
      aiMemberId: freshReviewerAiMemberId,
      role: "fresh-code-reviewer",
      now,
    });
    const packageManifest = parseJson<{
      acceptanceCriteria: string[];
      allowedPermissions: string[];
      specRefs: string[];
      harnessRefs: string[];
      integrationConditions: string[];
      recoveryPolicy: string;
    }>(String(graphRow.packageManifestJson));
    const selfCheckReport = parseJson<{
      commands: string[];
      logRefs: string[];
      commitEvidence: string[];
    }>(String(graphRow.selfCheckReportJson));
    const priorDefect = database
      .prepare(
        `SELECT defects.id, defects.code_review_manifest_id AS codeReviewId,
                defects.quality_gate_result_id AS qualityGateResultId,
                defects.result, defects.finding_ids_json AS findingIdsJson,
                defects.obligation_json AS obligationJson,
                manifests.topic_id AS topicId
           FROM code_review_defects AS defects
           JOIN code_review_manifests AS manifests
             ON manifests.id = defects.code_review_manifest_id
          WHERE defects.work_package_id = ?
            AND defects.rework_work_package_version_id = ?
            AND defects.status = 'rework-created'
          ORDER BY defects.created_at, defects.id LIMIT 1`,
      )
      .get(input.command.workPackageId, String(graphRow.versionId)) as
      | {
          readonly id: string;
          readonly codeReviewId: string;
          readonly qualityGateResultId: string;
          readonly result: "CONDITIONAL_PASS" | "FAIL";
          readonly findingIdsJson: string;
          readonly obligationJson: string;
          readonly topicId: string;
        }
      | undefined;
    const priorTopic = priorDefect
      ? options.reviewRuntime.inspect(priorDefect.topicId)
      : undefined;
    const priorFindingIds = priorDefect
      ? parseJson<string[]>(priorDefect.findingIdsJson)
      : [];
    const priorObligation = priorDefect
      ? parseJson<{
          readonly evidenceRefs?: readonly unknown[];
        }>(priorDefect.obligationJson)
      : undefined;
    const obligationEvidenceRefs = (priorObligation?.evidenceRefs ?? []).filter(
      (reference): reference is string =>
        typeof reference === "string" && reference.trim().length > 0,
    );
    const resolutionMatrix = priorDefect
      ? priorFindingIds.map((findingId) => {
          const finding = priorTopic?.findings.find(
            (candidate) => candidate.id === findingId,
          );
          if (!finding || finding.evidenceRefs.length === 0) {
            throw new CodeReviewRuntimeError(
              "CODE_REVIEW_OBLIGATION_INVALID",
              `Prior Code Review finding ${findingId} is missing required evidence.`,
            );
          }
          const resolution = priorTopic?.resolutions.find(
            (candidate) => candidate.findingId === findingId,
          );
          if (!resolution || resolution.evidenceRefs.length === 0) {
            throw new CodeReviewRuntimeError(
              "CODE_REVIEW_OBLIGATION_INVALID",
              `Prior Code Review finding ${findingId} has no evidence-backed resolution.`,
            );
          }
          return {
            findingId,
            summary: finding.summary,
            evidenceRefs: finding.evidenceRefs,
            resolution: {
              id: resolution.id,
              disposition: resolution.disposition,
              response: resolution.response,
              evidenceRefs: resolution.evidenceRefs,
            },
          };
        })
      : [];
    if (priorDefect && obligationEvidenceRefs.length === 0) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_OBLIGATION_INVALID",
        `Prior Code Review Defect ${priorDefect.id} has no obligation evidence.`,
      );
    }
    const priorReview = priorDefect
      ? {
          codeReviewId: priorDefect.codeReviewId,
          topicId: priorDefect.topicId,
          qualityGateResultId: priorDefect.qualityGateResultId,
          defectId: priorDefect.id,
          result: priorDefect.result,
          findingIds: priorFindingIds,
          obligation: priorObligation,
          resolutionMatrix,
          requiredEvidenceRefs: [
            priorDefect.id,
            priorDefect.qualityGateResultId,
            ...priorFindingIds,
            ...resolutionMatrix.flatMap((entry) => entry.evidenceRefs),
            ...resolutionMatrix.map((entry) => entry.resolution.id),
            ...obligationEvidenceRefs,
            ...resolutionMatrix.flatMap(
              (entry) => entry.resolution.evidenceRefs,
            ),
          ],
        }
      : undefined;
    const run = options.pipelineRuntime.inspectRun(String(graphRow.runId));
    const reviewNodeSnapshot = run.nodes.find(
      (node) => node.id === reviewNodeRunId,
    );
    const reviewPipelineNode =
      run.snapshot.payload.pipelineVersion.graph.nodes.find(
        (node) => node.id === reviewNodeSnapshot?.pipelineNodeId,
      );
    const reviewerExecutionProfileId =
      reviewPipelineNode?.executionProfileId ??
      run.snapshot.payload.department.defaultExecutionProfileId;
    const reviewerExecutionProfile =
      run.snapshot.payload.executionProfiles.find(
        (profile) => profile.id === reviewerExecutionProfileId,
      );
    if (!reviewerExecutionProfileId || !reviewerExecutionProfile) {
      throw new CodeReviewRuntimeError(
        "RUN_SNAPSHOT_INVALID",
        "The frozen Code Review Node has no Reviewer Execution Profile.",
      );
    }
    if (reviewerExecutionProfileId === graphRow.producerExecutionProfileId) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_CREDENTIAL_SCOPE_INVALID",
        "Independent Code Review requires a Reviewer Execution Profile distinct from the producer allocation profile.",
      );
    }
    const producerCredentialReferenceIds = (
      database
        .prepare(
          `SELECT secret_reference_id AS id
             FROM execution_profile_secret_references
            WHERE execution_profile_id = ?
            ORDER BY sort_order, secret_reference_id`,
        )
        .all(String(graphRow.producerExecutionProfileId)) as Array<{
        readonly id: string;
      }>
    ).map((reference) => reference.id);
    const credentialScopes = (
      referenceIds: readonly string[],
      owner: "producer" | "Reviewer",
    ): readonly string[] =>
      referenceIds.map((referenceId) => {
        const reference = database
          .prepare(
            `SELECT provider_scope AS providerScope
               FROM secret_references
              WHERE id = ? AND status = 'active'`,
          )
          .get(referenceId) as { readonly providerScope: string } | undefined;
        if (!reference) {
          throw new CodeReviewRuntimeError(
            "REVIEWER_CREDENTIAL_SCOPE_INVALID",
            `The frozen ${owner} Secret Reference ${referenceId} is missing or archived.`,
          );
        }
        return reference.providerScope;
      });
    const producerCredentialProviderScopes = credentialScopes(
      producerCredentialReferenceIds,
      "producer",
    );
    const reviewerCredentialProviderScopes = credentialScopes(
      reviewerExecutionProfile.secretReferenceIds,
      "Reviewer",
    );
    const producerReferenceSet = new Set(producerCredentialReferenceIds);
    const producerScopeSet = new Set(producerCredentialProviderScopes);
    if (
      reviewerExecutionProfile.secretReferenceIds.some((referenceId) =>
        producerReferenceSet.has(referenceId),
      ) ||
      reviewerCredentialProviderScopes.some((scope) =>
        producerScopeSet.has(scope),
      )
    ) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_CREDENTIAL_SCOPE_INVALID",
        "Independent Code Review cannot reuse a producer Secret Reference or provider credential scope.",
      );
    }
    const manifest = CodeReviewManifestSchema.parse({
      schemaVersion: 1,
      projectId: graphRow.projectId,
      runId: graphRow.runId,
      snapshotRevisionId: graphRow.snapshotRevisionId,
      workPackageId: input.command.workPackageId,
      workPackageVersionId: graphRow.versionId,
      assignmentId: graphRow.assignmentId,
      nodeRunId: graphRow.nodeRunId,
      nodeAttemptId: graphRow.nodeAttemptId,
      repositoryReference: graphRow.repositoryReference,
      baseCommit: graphRow.baseCommit,
      workspaceImportId: workspaceImport.id,
      sourceCommit: workspaceImport.resultCommit,
      diffArtifactVersionId: artifact.id,
      diffHash: artifact.contentHash,
      specRevisionIds: packageManifest.specRefs,
      harnessSnapshotIds: packageManifest.harnessRefs,
      acceptanceCriteria: packageManifest.acceptanceCriteria,
      selfCheck: {
        id: graphRow.selfCheckId,
        hash: graphRow.selfCheckHash,
        commands: selfCheckReport.commands,
        logRefs: selfCheckReport.logRefs,
        evidenceRefs: selfCheckReport.commitEvidence,
      },
      permissions: packageManifest.allowedPermissions,
      errorHandlingInputs: [packageManifest.recoveryPolicy],
      crossApplicationImpactInputs: packageManifest.integrationConditions,
      reviewerExecutionProfileId,
      producerCredentialReferenceIds,
      reviewerCredentialReferenceIds:
        reviewerExecutionProfile.secretReferenceIds,
      producerCredentialProviderScopes,
      reviewerCredentialProviderScopes,
      ...(priorReview ? { priorReview } : {}),
      excludedContext: [
        "hidden-prompts",
        "prior-reviewer-opinions",
        "private-transcripts",
        "provider-session-history",
        "credential-values",
        "mutable-caches",
        "producer-workspace",
      ],
    });
    const manifestJson = canonicalJson(manifest);
    options.reviewRuntime.dispatchInTransaction({
      commandId: input.commandId,
      actor: input.actor,
      expectedRevision: 0,
      command: {
        type: "review.topic.create",
        topicId: input.command.topicId,
        projectId: manifest.projectId,
        runId: manifest.runId,
        title: `Independent Code Review: ${manifest.workPackageId}`,
        manifest: {
          scope: "code",
          topicId: input.command.topicId,
          supportingArtifactVersionIds: [manifest.diffArtifactVersionId],
          supportingSpecRevisionIds: manifest.specRevisionIds,
          harnessSnapshotIds: manifest.harnessSnapshotIds,
          acceptanceCriteria: manifest.acceptanceCriteria,
          excludedContext: [
            "hidden-prompts",
            "prior-reviewer-opinions",
            "private-transcripts",
            "provider-session-history",
            "credential-values",
          ],
          workPackageVersionId: manifest.workPackageVersionId,
          repositoryId: manifest.repositoryReference,
          sourceCommit: manifest.sourceCommit,
          diffArtifactVersionId: manifest.diffArtifactVersionId,
          diffHash: manifest.diffHash,
        },
        producer: {
          aiMemberId: String(graphRow.producerAiMemberId),
          positionId: String(graphRow.producerPositionId),
          sessionId: String(graphRow.producerSessionId),
        },
        participants: [
          {
            id: `${input.command.codeReviewId}:owner`,
            role: "owner-participant",
            aiMemberId: String(graphRow.producerAiMemberId),
            positionId: String(graphRow.producerPositionId),
            sessionId: String(graphRow.producerSessionId),
          },
          {
            id: `${input.command.codeReviewId}:moderator`,
            role: "moderator",
            aiMemberId: moderatorAiMemberId,
            positionId: input.command.moderatorPositionId,
            sessionId: moderatorSessionId,
          },
          {
            id: `${input.command.codeReviewId}:reviewer`,
            role: "reviewer-participant",
            aiMemberId: reviewerAiMemberId,
            positionId: input.command.reviewerPositionId,
            sessionId: reviewerSessionId,
          },
          {
            id: `${input.command.codeReviewId}:fresh-reviewer`,
            role: "reviewer-participant",
            aiMemberId: freshReviewerAiMemberId,
            positionId: input.command.freshReviewerPositionId,
            sessionId: freshReviewerSessionId,
          },
        ],
        quorum: 1,
        budget: {
          maxRounds: 2,
          maxDurationSeconds: 1_800,
          maxTokens: 20_000,
          maxCostCents: 1_000,
        },
        stopCondition: "blocking-findings-dispositioned",
        escalationPolicy: "fail-with-evidence",
      },
    });
    options.reviewRuntime.transitionIndependentExecutionInTransaction({
      commandId: input.commandId,
      actor: input.actor,
      topicId: input.command.topicId,
      state: "blocked",
    });
    database
      .prepare(
        `INSERT INTO code_review_manifests(
           id, topic_id, project_id, run_id, snapshot_revision_id,
           work_package_id, work_package_version_id, assignment_id,
           node_attempt_id, workspace_import_id, diff_artifact_version_id,
           manifest_json, manifest_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.command.codeReviewId,
        input.command.topicId,
        manifest.projectId,
        manifest.runId,
        manifest.snapshotRevisionId,
        manifest.workPackageId,
        manifest.workPackageVersionId,
        manifest.assignmentId,
        manifest.nodeAttemptId,
        manifest.workspaceImportId,
        manifest.diffArtifactVersionId,
        manifestJson,
        sha256(manifestJson),
        now,
      );
    database
      .prepare(
        `INSERT INTO reviewer_workspace_intents(
           id, code_review_manifest_id, operation_key, state,
           reviewer_ai_member_id, reviewer_position_id, reviewer_session_id,
           review_node_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'intent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${input.command.codeReviewId}:workspace`,
        input.command.codeReviewId,
        `code-review:${input.command.codeReviewId}:workspace`,
        reviewerAiMemberId,
        input.command.reviewerPositionId,
        reviewerSessionId,
        reviewNodeRunId,
        now,
        now,
      );
    if (reviewNode.status !== "running") {
      options.pipelineRuntime.startCodeReviewInTransaction({
        runId: manifest.runId,
        nodeRunId: reviewNodeRunId,
      });
    }
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "code-review.planned",
      entityType: "code-review",
      entityId: input.command.codeReviewId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      topicId: input.command.topicId,
      workPackageId: manifest.workPackageId,
      workPackageVersionId: manifest.workPackageVersionId,
      eventType: "code-review.planned",
      payload: {
        codeReviewId: input.command.codeReviewId,
        topicId: input.command.topicId,
        workPackageId: manifest.workPackageId,
        workPackageVersionId: manifest.workPackageVersionId,
        state: "intent",
        manifestHash: sha256(manifestJson),
      },
      createdAt: now,
    });
    return readOne(input.command.codeReviewId);
  };

  const converge = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision?: number;
    readonly command: Extract<
      CodeReviewEnvelopeCommand,
      { type: "code-review.converge" }
    >;
  }): CodeReviewView => {
    assertRuntimeActor(input.actor);
    const current = readOne(input.command.codeReviewId);
    if (!current.gateResult) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_GATE_PENDING",
        "Code Review cannot converge before the generic Review Gate is final.",
      );
    }
    if (current.workspace.state !== "ready") {
      throw new CodeReviewRuntimeError(
        "PROVIDER_ISOLATION_REQUIRED",
        "Code Review cannot converge without an independent read-only reviewer Workspace.",
      );
    }
    if (
      current.authority?.qualityGateResultId === current.gateResult.id ||
      current.defects.some(
        (defect) => defect.qualityGateResultId === current.gateResult?.id,
      )
    ) {
      if (current.authority) reconcileAggregateCoverage(current);
      return current;
    }
    const review = options.reviewRuntime.inspect(current.topicId);
    const initialReviewerParticipantId = `${current.id}:reviewer`;
    const freshReviewerParticipantId = `${current.id}:fresh-reviewer`;
    const initialFinding = review.findings.find(
      (finding) =>
        finding.reviewerParticipantId === initialReviewerParticipantId &&
        finding.reviewerSessionId === current.workspace.reviewerSessionId,
    );
    const initialParticipant = review.participants.find(
      (participant) => participant.id === initialReviewerParticipantId,
    );
    const revision = review.revisions.find(
      (candidate) => candidate.id === current.gateResult?.revisionId,
    );
    const freshRecheck = review.rechecks.find(
      (candidate) =>
        current.gateResult?.recheckIds.includes(candidate.id) &&
        candidate.reviewerParticipantId === freshReviewerParticipantId,
    );
    const freshParticipant = review.participants.find(
      (participant) => participant.id === freshReviewerParticipantId,
    );
    if (
      !initialParticipant ||
      !freshParticipant ||
      positionMember(initialParticipant.positionId) !==
        initialParticipant.aiMemberId ||
      positionMember(freshParticipant.positionId) !==
        freshParticipant.aiMemberId
    ) {
      throw new CodeReviewRuntimeError(
        "REVIEWER_INELIGIBLE",
        "Code Review participants must still resolve to active Reviewer Positions and AI members at convergence.",
      );
    }
    const initialSession = database
      .prepare(
        `SELECT mode, run_id AS runId, node_run_id AS nodeRunId, status
           FROM interaction_sessions WHERE id = ?`,
      )
      .get(current.workspace.reviewerSessionId) as
      | {
          readonly mode: string;
          readonly runId: string | null;
          readonly nodeRunId: string | null;
          readonly status: string;
        }
      | undefined;
    const freshSession = freshRecheck
      ? (database
          .prepare(
            `SELECT mode, run_id AS runId, node_run_id AS nodeRunId, status
               FROM interaction_sessions WHERE id = ?`,
          )
          .get(freshRecheck.reviewerSessionId) as
          | {
              readonly mode: string;
              readonly runId: string | null;
              readonly nodeRunId: string | null;
              readonly status: string;
            }
          | undefined)
      : undefined;
    if (
      !initialFinding ||
      initialFinding.evidenceRefs.length === 0 ||
      !freshParticipant.eligibility.eligible ||
      !freshRecheck ||
      freshRecheck.evidenceRefs.length === 0 ||
      current.gateResult.evidenceRefs.length === 0 ||
      !revision ||
      revision.subjectKind !== "canonical-diff" ||
      revision.subjectId !== current.manifest.diffArtifactVersionId ||
      revision.subjectHash !== current.manifest.diffHash ||
      revision.producerAiMemberId === freshParticipant.aiMemberId ||
      initialSession?.mode !== "run-collaboration" ||
      initialSession.runId !== current.manifest.runId ||
      initialSession.nodeRunId !== current.workspace.reviewNodeRunId ||
      initialSession.status !== "active" ||
      freshSession?.mode !== "run-collaboration" ||
      freshSession.runId !== current.manifest.runId ||
      freshSession.nodeRunId !== current.workspace.reviewNodeRunId ||
      freshSession.status !== "active"
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_REVIEW_PROTOCOL_INVALID",
        "Code Review convergence requires an initial independent Finding and a fresh eligible re-review Session bound to the Code Review Node.",
      );
    }
    const graph = options.workPackages.inspect(current.manifest.runId);
    const workPackage = graph.packages.find(
      (entry) => entry.id === current.manifest.workPackageId,
    );
    if (
      !workPackage ||
      workPackage.revision !== input.expectedRevision ||
      !manifestIsCurrent(current.manifest)
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_AUTHORITY_STALE",
        "The Gate no longer binds the current active Work Package Version, Assignment, import, and self-check.",
      );
    }
    const now = clock().toISOString();
    const gate = current.gateResult;
    if (gate.result === "PASS") {
      if (gate.kind !== "code" || !gate.satisfiesProductionContract) {
        throw new CodeReviewRuntimeError(
          "CODE_REVIEW_PASS_REQUIRED",
          "Only an immutable kind=code PASS can create Integration authority.",
        );
      }
      const executionStages = readExecutionStages(current.id);
      const initialExecution = executionStages.find(
        (stage) => stage.phase === "initial-finding",
      );
      const freshExecution = executionStages.find(
        (stage) => stage.phase === "fresh-recheck",
      );
      const executionIsValid = (
        stage: (typeof executionStages)[number] | undefined,
        expected: {
          readonly phase: "fresh-recheck" | "initial-finding";
          readonly participantId: string;
          readonly sessionId: string;
        },
      ): boolean =>
        stage?.state === "succeeded" &&
        stage.phase === expected.phase &&
        stage.operationKey === `code-review:${current.id}:${expected.phase}` &&
        stage.participantId === expected.participantId &&
        stage.sessionId === expected.sessionId &&
        Boolean(stage.providerId) &&
        Boolean(stage.isolationReceiptHash) &&
        Boolean(stage.resultHash);
      if (
        executionStages.length !== 2 ||
        !executionIsValid(initialExecution, {
          phase: "initial-finding",
          participantId: initialReviewerParticipantId,
          sessionId: current.workspace.reviewerSessionId,
        }) ||
        !executionIsValid(freshExecution, {
          phase: "fresh-recheck",
          participantId: freshReviewerParticipantId,
          sessionId: freshRecheck.reviewerSessionId,
        }) ||
        !executionEvidenceIsExact({ codeReviewId: current.id, topic: review })
      ) {
        throw new CodeReviewRuntimeError(
          "REVIEWER_EXECUTION_REQUIRED",
          "Integration authority requires exact succeeded initial and fresh Reviewer execution receipts.",
        );
      }
      const resolvedDefects = database
        .prepare(
          `SELECT id FROM code_review_defects
            WHERE work_package_id = ? AND status = 'rework-created'
              AND rework_work_package_version_id = ?
            ORDER BY created_at, id`,
        )
        .all(
          current.manifest.workPackageId,
          current.manifest.workPackageVersionId,
        ) as Array<{ readonly id: string }>;
      if (resolvedDefects.length > 0) {
        const priorReview = current.manifest.priorReview;
        const priorObligationEvidence =
          priorReview &&
          typeof priorReview.obligation === "object" &&
          priorReview.obligation !== null &&
          "evidenceRefs" in priorReview.obligation &&
          Array.isArray(priorReview.obligation.evidenceRefs)
            ? priorReview.obligation.evidenceRefs.filter(
                (reference): reference is string =>
                  typeof reference === "string" && reference.trim().length > 0,
              )
            : [];
        if (
          resolvedDefects.length !== 1 ||
          !priorReview ||
          priorReview.defectId !== resolvedDefects[0]?.id ||
          priorObligationEvidence.length === 0 ||
          priorReview.resolutionMatrix.some(
            (entry) =>
              entry.evidenceRefs.length === 0 ||
              !entry.resolution ||
              entry.resolution.evidenceRefs.length === 0,
          ) ||
          priorReview.requiredEvidenceRefs.some(
            (reference) => !freshRecheck.evidenceRefs.includes(reference),
          )
        ) {
          throw new CodeReviewRuntimeError(
            "CODE_REVIEW_OBLIGATION_OPEN",
            "Fresh PASS cannot close a prior obligation unless the manifest freezes it and the recheck cites every required resolution evidence reference.",
          );
        }
      }
      for (const defect of resolvedDefects) {
        const closed = database
          .prepare(
            `UPDATE code_review_defects SET status = 'closed'
              WHERE id = ? AND status = 'rework-created'`,
          )
          .run(defect.id);
        if (closed.changes !== 1) {
          throw new CodeReviewRuntimeError(
            "CODE_REVIEW_OBLIGATION_OPEN",
            `Code Review Defect ${defect.id} changed before resolution.`,
          );
        }
        appendMutation({
          commandId: input.commandId,
          actor: input.actor,
          action: "code-review.defect.closed",
          entityType: "code-review-defect",
          entityId: defect.id,
          projectId: current.manifest.projectId,
          runId: current.manifest.runId,
          topicId: current.topicId,
          workPackageId: current.manifest.workPackageId,
          workPackageVersionId: current.manifest.workPackageVersionId,
          qualityGateResultId: gate.id,
          eventType: "code-review.defect.closed",
          payload: {
            codeReviewId: current.id,
            defectId: defect.id,
            workPackageId: current.manifest.workPackageId,
            workPackageVersionId: current.manifest.workPackageVersionId,
            qualityGateResultId: gate.id,
            status: "closed",
          },
          createdAt: now,
        });
      }
      if (packageHasOpenDefect(current.manifest.workPackageId)) {
        throw new CodeReviewRuntimeError(
          "CODE_REVIEW_OBLIGATION_OPEN",
          "Open Code Review obligations for the Work Package block Integration authority.",
        );
      }
      const workspaceEvidenceHash = current.workspace.independenceEvidenceHash;
      if (!workspaceEvidenceHash) {
        throw new CodeReviewRuntimeError(
          "PROVIDER_ISOLATION_REQUIRED",
          "Reviewer independence evidence is missing.",
        );
      }
      const independenceEvidenceHash = sha256(
        canonicalJson({
          schemaVersion: 1,
          workspaceEvidenceHash,
          executions: executionStages.map((stage) => ({
            phase: stage.phase,
            operationKey: stage.operationKey,
            participantId: stage.participantId,
            sessionId: stage.sessionId,
            providerId: stage.providerId,
            isolationReceiptHash: stage.isolationReceiptHash,
            resultHash: stage.resultHash,
          })),
        }),
      );
      const authorityId = `code-review-authority:${input.command.codeReviewId}`;
      if (!manifestIsCurrent(current.manifest)) {
        throw new CodeReviewRuntimeError(
          "CODE_REVIEW_AUTHORITY_STALE",
          "The exact Code Review manifest changed before Integration authority could be recorded.",
        );
      }
      database
        .prepare(
          `INSERT INTO code_review_authorities(
             id, code_review_manifest_id, quality_gate_result_id, project_id,
             run_id, snapshot_revision_id, work_package_id,
             work_package_version_id, assignment_id, node_attempt_id,
             repository_reference, base_commit, source_commit,
             workspace_import_id, diff_artifact_version_id, diff_hash,
             self_check_id, self_check_hash, topic_id, manifest_hash,
             reviewer_session_id, independence_evidence_hash,
             initial_execution_stage_id, initial_isolation_receipt_hash,
             initial_result_hash, fresh_execution_stage_id,
             fresh_isolation_receipt_hash, fresh_result_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorityId,
          current.id,
          gate.id,
          current.manifest.projectId,
          current.manifest.runId,
          current.manifest.snapshotRevisionId,
          current.manifest.workPackageId,
          current.manifest.workPackageVersionId,
          current.manifest.assignmentId,
          current.manifest.nodeAttemptId,
          current.manifest.repositoryReference,
          current.manifest.baseCommit,
          current.manifest.sourceCommit,
          current.manifest.workspaceImportId,
          current.manifest.diffArtifactVersionId,
          current.manifest.diffHash,
          current.manifest.selfCheck.id,
          current.manifest.selfCheck.hash,
          current.topicId,
          current.manifestHash,
          freshRecheck.reviewerSessionId,
          independenceEvidenceHash,
          initialExecution!.id,
          initialExecution!.isolationReceiptHash,
          initialExecution!.resultHash,
          freshExecution!.id,
          freshExecution!.isolationReceiptHash,
          freshExecution!.resultHash,
          now,
        );
      if (!manifestIsCurrent(current.manifest)) {
        throw new CodeReviewRuntimeError(
          "CODE_REVIEW_AUTHORITY_STALE",
          "The exact Code Review manifest changed before the Pipeline Code Review barrier could advance.",
        );
      }
      reconcileAggregateCoverage(readOne(current.id));
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "code-review.authority.created",
        entityType: "code-review-authority",
        entityId: authorityId,
        projectId: current.manifest.projectId,
        runId: current.manifest.runId,
        topicId: current.topicId,
        workPackageId: current.manifest.workPackageId,
        workPackageVersionId: current.manifest.workPackageVersionId,
        qualityGateResultId: gate.id,
        eventType: "code-review.authority.created",
        payload: {
          codeReviewId: current.id,
          authorityId,
          qualityGateResultId: gate.id,
          workPackageId: current.manifest.workPackageId,
          workPackageVersionId: current.manifest.workPackageVersionId,
          result: "PASS",
          sourceCommit: current.manifest.sourceCommit,
          diffHash: current.manifest.diffHash,
          manifestHash: current.manifestHash,
        },
        createdAt: now,
      });
      return readOne(current.id);
    }
    if (!input.command.reworkVersionId || !input.command.reworkBaseCommit) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_REWORK_REQUIRED",
        "CONDITIONAL_PASS and FAIL require a fresh Work Package Version and Attempt.",
      );
    }
    const defectId = `code-review-defect:${current.id}:${gate.id}`;
    const findingIds = options.reviewRuntime
      .inspect(current.topicId)
      .findings.map((finding) => finding.id);
    database
      .prepare(
        `INSERT INTO code_review_defects(
           id, code_review_manifest_id, quality_gate_result_id,
           work_package_id, result, finding_ids_json, obligation_json,
           rework_work_package_version_id, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rework-created', ?)`,
      )
      .run(
        defectId,
        current.id,
        gate.id,
        current.manifest.workPackageId,
        gate.result,
        canonicalJson(findingIds),
        canonicalJson({
          conditions: gate.conditions,
          evidenceRefs: gate.evidenceRefs,
          freshIndependentReReviewRequired: true,
        }),
        input.command.reworkVersionId,
        now,
      );
    options.pipelineRuntime.blockCodeReviewInTransaction({
      runId: current.manifest.runId,
      nodeRunId: current.workspace.reviewNodeRunId,
      reason: "code-review-rework",
      failure: {
        code: `CODE_REVIEW_${gate.result}`,
        message: `Code Review ${gate.result} requires a fresh Work Package rework Attempt.`,
      },
    });
    options.workPackages.reworkInTransaction({
      commandId: input.commandId,
      actor: input.actor,
      expectedRevision: input.expectedRevision ?? -1,
      workPackageId: current.manifest.workPackageId,
      versionId: input.command.reworkVersionId,
      baseCommit: input.command.reworkBaseCommit,
      recoveryReason: `Code Review ${gate.result}: ${defectId}`,
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "code-review.defect.created",
      entityType: "code-review-defect",
      entityId: defectId,
      projectId: current.manifest.projectId,
      runId: current.manifest.runId,
      topicId: current.topicId,
      workPackageId: current.manifest.workPackageId,
      workPackageVersionId: current.manifest.workPackageVersionId,
      qualityGateResultId: gate.id,
      eventType: "code-review.defect.created",
      payload: {
        codeReviewId: current.id,
        defectId,
        qualityGateResultId: gate.id,
        workPackageId: current.manifest.workPackageId,
        workPackageVersionId: current.manifest.workPackageVersionId,
        result: gate.result,
        reworkWorkPackageVersionId: input.command.reworkVersionId,
      },
      createdAt: now,
    });
    return readOne(current.id);
  };

  const dispatchInTransaction: CodeReviewRuntime["dispatchInTransaction"] = (
    input,
  ) => {
    if (input.command.type === "code-review.start") {
      return start({ ...input, command: input.command });
    }
    return converge({ ...input, command: input.command });
  };

  const reconcileReviewerWorkspace = (codeReviewId: string): CodeReviewView => {
    const current = readOne(codeReviewId);
    if (current.workspace.state !== "intent") return current;
    const result = adapter.provision({
      operationKey: current.workspace.operationKey,
      manifest: current.manifest,
      reviewer: {
        aiMemberId: current.workspace.reviewerAiMemberId,
        positionId: current.workspace.reviewerPositionId,
        sessionId: current.workspace.reviewerSessionId,
      },
    });
    const now = clock().toISOString();
    const commandId = `reconcile:${current.workspace.operationKey}`;
    const actor: ActorRef = {
      type: "runtime-worker",
      id: "code-review-workspace-reconciler",
      authenticatedBy: "runtime",
    };
    const consumerId = "code-review-workspace-reconciler";
    const requestJson = canonicalJson({
      codeReviewId: current.id,
      operationKey: current.workspace.operationKey,
      manifestHash: current.manifestHash,
      result,
    });
    const requestHash = sha256(requestJson);
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          commandId,
          actor.type,
          actor.id,
          actor.authenticatedBy,
          consumerId,
        );
      if (result.status === "ready") {
        const capabilitiesJson = canonicalJson(result.capabilities);
        const evidenceJson = canonicalJson(result.evidence);
        database
          .prepare(
            `UPDATE reviewer_workspace_intents
                SET state = 'ready', provider_id = ?, workspace_ref = ?,
                    capability_snapshot_json = ?, capability_snapshot_hash = ?,
                    independence_evidence_json = ?, failure_code = NULL,
                    failure_message = NULL, updated_at = ?
              WHERE code_review_manifest_id = ? AND state = 'intent'`,
          )
          .run(
            result.providerId,
            result.workspaceRef,
            capabilitiesJson,
            sha256(capabilitiesJson),
            evidenceJson,
            now,
            current.id,
          );
        options.reviewRuntime.transitionIndependentExecutionInTransaction({
          commandId,
          actor,
          topicId: current.topicId,
          state: "active",
        });
      } else {
        database
          .prepare(
            `UPDATE reviewer_workspace_intents
                SET state = ?, independence_evidence_json = ?,
                    failure_code = ?, failure_message = ?, updated_at = ?
              WHERE code_review_manifest_id = ? AND state = 'intent'`,
          )
          .run(
            result.status,
            canonicalJson(result.evidence),
            result.code,
            result.message,
            now,
            current.id,
          );
        options.pipelineRuntime.blockCodeReviewInTransaction({
          runId: current.manifest.runId,
          nodeRunId: current.workspace.reviewNodeRunId,
          failure: {
            code: result.code,
            message: result.message,
          },
        });
      }
      appendMutation({
        commandId,
        actor,
        action: `code-review.workspace.${result.status}`,
        entityType: "reviewer-workspace",
        entityId: current.workspace.id,
        projectId: current.manifest.projectId,
        runId: current.manifest.runId,
        topicId: current.topicId,
        workPackageId: current.manifest.workPackageId,
        workPackageVersionId: current.manifest.workPackageVersionId,
        eventType: `code-review.workspace.${result.status}`,
        payload: {
          codeReviewId: current.id,
          workspaceIntentId: current.workspace.id,
          workPackageId: current.manifest.workPackageId,
          workPackageVersionId: current.manifest.workPackageVersionId,
          state: result.status,
          ...(result.status === "ready"
            ? {
                providerId: result.providerId,
                capabilitySnapshotHash: sha256(
                  canonicalJson(result.capabilities),
                ),
              }
            : { failureCode: result.code }),
        },
        createdAt: now,
      });
      const effectIds = (
        database
          .prepare(
            `SELECT id FROM runtime_audit_records
              WHERE command_id = ? ORDER BY created_at, id`,
          )
          .all(commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      const resultJson = canonicalJson({
        status: "succeeded",
        value: {
          codeReviewId: current.id,
          workspaceState: result.status,
        },
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
           ) VALUES (?, ?, ?, ?, ?, 1, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          commandId,
          actor.type,
          actor.id,
          actor.authenticatedBy,
          consumerId,
          requestHash,
          resultJson,
          sha256(resultJson),
          canonicalJson(effectIds),
          now,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return readOne(codeReviewId);
  };

  const reconcilePendingReviewerWorkspaces = (): void => {
    const ids = database
      .prepare(
        `SELECT code_review_manifest_id AS id
           FROM reviewer_workspace_intents WHERE state = 'intent'
          ORDER BY created_at, id`,
      )
      .all() as Array<{ readonly id: string }>;
    ids.forEach((row) => reconcileReviewerWorkspace(row.id));
  };

  const readCompletedCoverage = (
    runId: string,
  ): CompletedCodeReviewCoverage => {
    const node = database
      .prepare(
        `SELECT node_runs.id AS nodeRunId,
                node_runs.result_json AS nodeResultJson,
                attempts.id AS nodeAttemptId,
                attempts.structured_result_json AS attemptResultJson,
                runs.project_id AS projectId,
                runs.snapshot_revision_id AS snapshotRevisionId
           FROM node_runs
           JOIN department_runs AS runs ON runs.id = node_runs.run_id
           JOIN node_attempts AS attempts ON attempts.id = (
             SELECT candidate.id FROM node_attempts AS candidate
              WHERE candidate.node_run_id = node_runs.id
                AND candidate.status = 'succeeded'
              ORDER BY candidate.attempt_number DESC LIMIT 1
           )
          WHERE node_runs.run_id = ?
            AND node_runs.handler_kind_id = 'code-review@1'
            AND node_runs.status = 'succeeded'`,
      )
      .get(runId) as
      | {
          readonly nodeRunId: string;
          readonly nodeResultJson: string;
          readonly nodeAttemptId: string;
          readonly attemptResultJson: string;
          readonly projectId: string;
          readonly snapshotRevisionId: string;
        }
      | undefined;
    if (!node) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_COVERAGE_INCOMPLETE",
        `Department Run ${runId} has no completed code-review@1 Node Attempt.`,
      );
    }
    type CoverageResult = {
      readonly workPackageVersionIds: readonly string[];
      readonly authorityIds: readonly string[];
      readonly qualityGateResultIds: readonly string[];
      readonly coverageHash: string;
    };
    const nodeResult = parseJson<CoverageResult>(node.nodeResultJson);
    const attemptResult = parseJson<CoverageResult>(node.attemptResultJson);
    if (canonicalJson(nodeResult) !== canonicalJson(attemptResult)) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_COVERAGE_CONFLICT",
        "Completed Code Review Node and Attempt coverage results differ.",
      );
    }
    const uniqueVersions = new Set(nodeResult.workPackageVersionIds);
    const uniqueAuthorities = new Set(nodeResult.authorityIds);
    const uniqueGates = new Set(nodeResult.qualityGateResultIds);
    if (
      nodeResult.workPackageVersionIds.length === 0 ||
      nodeResult.workPackageVersionIds.length !==
        nodeResult.authorityIds.length ||
      nodeResult.workPackageVersionIds.length !==
        nodeResult.qualityGateResultIds.length ||
      uniqueVersions.size !== nodeResult.workPackageVersionIds.length ||
      uniqueAuthorities.size !== nodeResult.authorityIds.length ||
      uniqueGates.size !== nodeResult.qualityGateResultIds.length ||
      [...nodeResult.workPackageVersionIds]
        .sort()
        .some((id, index) => id !== nodeResult.workPackageVersionIds[index])
    ) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_COVERAGE_INVALID",
        "Completed Code Review coverage must contain sorted, unique, one-to-one Version, Authority, and Gate identities.",
      );
    }
    const expectedCoverageHash = sha256(
      canonicalJson({
        schemaVersion: 1,
        runId,
        nodeRunId: node.nodeRunId,
        workPackageVersionIds: nodeResult.workPackageVersionIds,
        authorityIds: nodeResult.authorityIds,
        qualityGateResultIds: nodeResult.qualityGateResultIds,
      }),
    );
    if (nodeResult.coverageHash !== expectedCoverageHash) {
      throw new CodeReviewRuntimeError(
        "CODE_REVIEW_COVERAGE_INVALID",
        "Completed Code Review coverage hash does not match its exact authority tuple.",
      );
    }
    const eligible = new Map(
      inspect(runId)
        .filter((review) => review.integrationEligible)
        .map((review) => [review.manifest.workPackageVersionId, review]),
    );
    const packages = nodeResult.workPackageVersionIds.map(
      (versionId, index) => {
        const review = eligible.get(versionId);
        if (
          !review?.authority ||
          !review.gateResult ||
          review.authority.id !== nodeResult.authorityIds[index] ||
          review.gateResult.id !== nodeResult.qualityGateResultIds[index] ||
          review.gateResult.kind !== "code" ||
          review.gateResult.result !== "PASS"
        ) {
          throw new CodeReviewRuntimeError(
            "CODE_REVIEW_COVERAGE_STALE",
            `Completed coverage authority for Work Package Version ${versionId} is no longer exact and eligible.`,
          );
        }
        const packageRow = database
          .prepare(
            `SELECT versions.application_id AS applicationId,
                  versions.repository_reference AS repositoryReference,
                  versions.manifest_json AS manifestJson,
                  allocations.source_branch AS sourceBranch,
                  packages.technical_baseline_id AS technicalBaselineId
             FROM work_package_versions AS versions
             JOIN work_packages AS packages ON packages.id = versions.work_package_id
             JOIN work_package_assignments AS assignments
               ON assignments.id = ?
             JOIN workspace_allocations AS allocations
               ON allocations.id = assignments.allocation_id
            WHERE versions.id = ? AND versions.status = 'ready'
              AND packages.run_id = ?
              AND assignments.work_package_version_id = versions.id`,
          )
          .get(review.manifest.assignmentId, versionId, runId) as
          | {
              readonly applicationId: string;
              readonly repositoryReference: string;
              readonly manifestJson: string;
              readonly sourceBranch: string;
              readonly technicalBaselineId: string;
            }
          | undefined;
        if (!packageRow) {
          throw new CodeReviewRuntimeError(
            "CODE_REVIEW_COVERAGE_STALE",
            `Work Package Version ${versionId} is no longer the active reviewed Version.`,
          );
        }
        const dependencies = database
          .prepare(
            `SELECT predecessor_work_package_version_id AS predecessorWorkPackageVersionId,
                  kind, contract_id AS contractId,
                  contract_version AS contractVersion,
                  evidence_ref AS evidenceRef
             FROM work_package_dependencies
            WHERE work_package_version_id = ?
            ORDER BY predecessor_work_package_version_id, kind`,
          )
          .all(versionId) as Array<{
          readonly predecessorWorkPackageVersionId: string;
          readonly kind:
            | "artifact"
            | "commit"
            | "contract"
            | "readiness"
            | "manual";
          readonly contractId: string | null;
          readonly contractVersion: string | null;
          readonly evidenceRef: string | null;
        }>;
        const contractVersions = dependencies
          .filter(
            (dependency) =>
              dependency.kind === "contract" &&
              dependency.contractId &&
              dependency.contractVersion,
          )
          .map((dependency) => {
            const contract = database
              .prepare(
                `SELECT contracts.content_hash AS hash
                 FROM technical_baselines AS baselines
                 JOIN cross_application_contract_revisions AS contracts
                   ON contracts.proposal_revision_id = baselines.proposal_revision_id
                WHERE baselines.id = ? AND contracts.contract_id = ?
                  AND contracts.version = ? AND contracts.compatibility = 'compatible'`,
              )
              .get(
                packageRow.technicalBaselineId,
                dependency.contractId,
                dependency.contractVersion,
              ) as { readonly hash: string } | undefined;
            if (!contract) {
              throw new CodeReviewRuntimeError(
                "CODE_REVIEW_COVERAGE_STALE",
                `Reviewed Contract ${String(dependency.contractId)}@${String(dependency.contractVersion)} is not accepted and compatible.`,
              );
            }
            return {
              id: dependency.contractId!,
              version: dependency.contractVersion!,
              hash: contract.hash,
            };
          });
        const packageManifest = parseJson<{
          readonly integrationConditions: readonly string[];
        }>(packageRow.manifestJson);
        return {
          workPackageId: review.manifest.workPackageId,
          workPackageVersionId: versionId,
          applicationId: packageRow.applicationId,
          repositoryReference: packageRow.repositoryReference,
          baseCommit: review.manifest.baseCommit,
          sourceBranch: packageRow.sourceBranch,
          sourceCommit: review.manifest.sourceCommit,
          diffHash: review.manifest.diffHash,
          authorityId: review.authority.id,
          qualityGateResultId: review.gateResult.id,
          dependencies,
          contractVersions,
          integrationConditions: packageManifest.integrationConditions,
        };
      },
    );
    return {
      coverageId: node.nodeAttemptId,
      coverageHash: nodeResult.coverageHash,
      projectId: node.projectId,
      runId,
      snapshotRevisionId: node.snapshotRevisionId,
      nodeRunId: node.nodeRunId,
      nodeAttemptId: node.nodeAttemptId,
      packages,
    };
  };

  return {
    inspect,
    readCompletedCoverage,
    dispatchInTransaction,
    reconcileReviewerWorkspace,
    reconcilePendingReviewerWorkspaces,
  };
};
