import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ActorRef } from "../interface.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type {
  DeliveryCandidateInputGateAuthority,
  QualityGateRuntime,
} from "../quality/qualityGateRuntime.js";
import type {
  CandidateInputRuntime,
  DeliveryCandidateInputManifest,
  DeliveryCandidateInputView,
} from "./candidateInputRuntime.js";
import type { TestRuntime } from "../testing/testRuntime.js";

export class DeliveryRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryRuntimeError";
  }
}

export type DeliveryCandidateManifest = {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly candidateInput: {
    readonly id: string;
    readonly hash: string;
    readonly manifest: DeliveryCandidateInputManifest;
  };
  readonly gateAuthority: DeliveryCandidateInputGateAuthority;
  readonly projectId: string;
  readonly runId: string;
  readonly snapshot: DeliveryCandidateInputManifest["snapshot"];
  readonly source: {
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly humanReleaseNodeRunId: string;
  };
  readonly product: DeliveryCandidateInputManifest["product"];
  readonly technical: DeliveryCandidateInputManifest["technical"];
  readonly codeReviewCoverage: DeliveryCandidateInputManifest["codeReviewCoverage"];
  readonly integration: DeliveryCandidateInputManifest["integration"];
  readonly repositoryCommits: DeliveryCandidateInputManifest["repositoryCommits"];
  readonly contracts: DeliveryCandidateInputManifest["contracts"];
  readonly tests: DeliveryCandidateInputManifest["tests"];
  readonly testCaseRevisions: DeliveryCandidateInputManifest["testCaseRevisions"];
  readonly artifacts: DeliveryCandidateInputManifest["artifacts"];
  readonly risk: DeliveryCandidateInputManifest["risk"];
  readonly evidence: DeliveryCandidateInputManifest["evidence"];
  readonly environment: DeliveryCandidateInputManifest["environment"];
  readonly evidencePolicy: DeliveryCandidateInputManifest["evidencePolicy"];
  readonly lineage: {
    readonly sourceCandidateId: string | null;
    readonly lineageHash: string;
  };
};

export type DeliveryCandidateProjection =
  | "awaiting-decision"
  | "accepted"
  | "rejected"
  | "changes-requested"
  | "superseded";

export type HumanReleaseDecisionKind =
  | "accepted"
  | "rejected"
  | "changes-requested";

export type ReleaseReworkResponsibility = {
  readonly kind:
    | "defect"
    | "work-package"
    | "contract"
    | "test"
    | "gate"
    | "aggregate"
    | "unknown";
  readonly id?: string;
  readonly summary: string;
};

export type ReleaseRework = {
  readonly scope: "same-boundary" | "boundary-changing";
  readonly responsibility: ReleaseReworkResponsibility;
  readonly childRunId?: string;
};

export type ReleaseReworkAuthority = {
  readonly kind:
    | "work-package-version"
    | "test-rework-run"
    | "candidate-input-recheck";
  readonly id: string;
};

export type ReleaseReworkActivation = {
  readonly id: string;
  readonly decisionId: string;
  readonly reworkRecordId: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly targetNodeRunId: string;
  readonly authority: ReleaseReworkAuthority & {
    readonly hash: string;
    readonly lineage: unknown;
    readonly lineageHash: string;
  };
  readonly actor: ActorRef & {
    readonly type: "human";
    readonly authenticatedBy: "local-session";
  };
  readonly commandId: string;
  readonly createdAt: string;
  readonly activationHash: string;
};

export type HumanReleaseDecision = {
  readonly id: string;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly decision: HumanReleaseDecisionKind;
  readonly actor: ActorRef & {
    readonly type: "human";
    readonly authenticatedBy: "local-session";
  };
  readonly reason: string;
  readonly comment: string | null;
  readonly evidenceRefs: readonly string[];
  readonly rework: ReleaseRework | null;
  readonly childRunId: string | null;
  readonly decisionHash: string;
  readonly createdAt: string;
};

export type DeliveryCandidateView = {
  readonly id: string;
  readonly requestId: string;
  readonly manifest: DeliveryCandidateManifest;
  readonly manifestHash: string;
  readonly projection: DeliveryCandidateProjection;
  readonly decision: HumanReleaseDecision | null;
  readonly recoveryActivation: ReleaseReworkActivation | null;
  readonly supersededByCandidateId: string | null;
  readonly createdAt: string;
};

export type AcceptedDeliveryCandidateAuthority = {
  readonly id: string;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly releaseDecisionId: string;
  readonly releaseDecisionHash: string;
  readonly candidateInputId: string;
  readonly candidateInputHash: string;
  readonly gateAuthorityId: string;
  readonly gateAuthorityHash: string;
  readonly integrationGenerationId: string;
  readonly integrationAuthorityHash: string;
  readonly repositoryCommits: DeliveryCandidateManifest["repositoryCommits"];
  readonly artifactVersionIds: readonly string[];
  readonly runId: string;
  readonly snapshotRevisionId: string;
  readonly authorityHash: string;
  readonly createdAt: string;
};

type DeliveryPipelineRuntime = Pick<
  PipelineRuntime,
  | "completeDeliveryCandidateInTransaction"
  | "resolveHumanReleaseNodeInTransaction"
  | "applyHumanReleaseDecisionInTransaction"
  | "activateHumanReleaseReworkInTransaction"
  | "validateReleaseBoundaryChildInTransaction"
>;

export interface DeliveryRuntime {
  readonly assemble: (input: {
    readonly candidateId: string;
    readonly requestId: string;
    readonly candidateInputId: string;
    readonly expectedCandidateInputHash: string;
    readonly expectedGateAuthorityHash: string;
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly leaseId: string;
    readonly workerId: string;
  }) => DeliveryCandidateView;
  readonly inspect: (candidateId: string) => DeliveryCandidateView;
  readonly inspectRun: (runId: string) => readonly DeliveryCandidateView[];
  readonly decide: (input: {
    readonly actor: ActorRef;
    readonly decisionId: string;
    readonly candidateId: string;
    readonly expectedCandidateHash: string;
    readonly decision: HumanReleaseDecisionKind;
    readonly reason: string;
    readonly comment?: string;
    readonly evidenceRefs: readonly string[];
    readonly rework?: ReleaseRework;
  }) => DeliveryCandidateView;
  readonly recover: (input: {
    readonly actor: ActorRef;
    readonly candidateId: string;
    readonly expectedCandidateHash: string;
    readonly decisionId: string;
    readonly authority: ReleaseReworkAuthority;
    readonly commandId?: string;
  }) => DeliveryCandidateView;
  readonly acceptedAuthority: (
    candidateId: string,
  ) => AcceptedDeliveryCandidateAuthority;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");

const parseJson = <Value>(value: string, label: string): Value => {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new DeliveryRuntimeError(
      "DELIVERY_DATA_INVALID",
      `${label} is invalid JSON: ${String(error)}`,
    );
  }
};

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort();

export const openDeliveryRuntime = (
  database: DatabaseSync,
  options: {
    readonly candidateInputs: Pick<CandidateInputRuntime, "inspect">;
    readonly qualityGates: Pick<QualityGateRuntime, "downstreamAuthority">;
    readonly tests?: Pick<TestRuntime, "downstreamAuthority">;
    readonly pipelineRuntime: DeliveryPipelineRuntime;
    readonly events?: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): DeliveryRuntime => {
  const clock = options.clock ?? (() => new Date());

  const appendMutation = (input: {
    readonly type: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly candidateId: string;
    readonly candidateInputId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly snapshotRevisionId: string;
    readonly nodeRunId?: string;
    readonly nodeAttemptId?: string;
    readonly releaseDecisionId?: string;
    readonly payload: unknown;
    readonly timestamp: string;
  }): void => {
    const context = database
      .prepare(
        `SELECT command_id AS commandId, actor_type AS actorType,
                actor_id AS actorId, authenticated_by AS authenticatedBy,
                consumer_id AS consumerId
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as
      | {
          readonly commandId: string;
          readonly actorType: string;
          readonly actorId: string;
          readonly authenticatedBy: string;
          readonly consumerId: string | null;
        }
      | undefined;
    if (!context) return;
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.type,
        input.entityType,
        input.entityId,
        input.runId,
        input.nodeRunId ?? null,
        canonicalJson(input.payload),
        input.timestamp,
        context.commandId,
        context.actorType,
        context.actorId,
        context.authenticatedBy,
        context.consumerId,
      );
    options.events?.append({
      type: input.type,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        runId: input.runId,
        snapshotRevisionId: input.snapshotRevisionId,
        deliveryCandidateId: input.candidateId,
        deliveryCandidateInputId: input.candidateInputId,
        commandId: context.commandId,
        ...(input.releaseDecisionId
          ? { releaseDecisionId: input.releaseDecisionId }
          : {}),
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
        ...(input.nodeAttemptId ? { nodeAttemptId: input.nodeAttemptId } : {}),
      },
      payload: input.payload,
      timestamp: input.timestamp,
    });
  };

  const readDecision = (candidateId: string): HumanReleaseDecision | null => {
    const row = database
      .prepare(
        `SELECT id, candidate_id AS candidateId, candidate_hash AS candidateHash,
                run_id AS runId, snapshot_revision_id AS snapshotRevisionId,
                decision, actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy, reason, comment,
                evidence_refs_json AS evidenceRefsJson, rework_json AS reworkJson,
                rework_hash AS reworkHash, child_run_id AS childRunId,
                decision_hash AS decisionHash, created_at AS createdAt
           FROM human_release_decisions WHERE candidate_id = ?`,
      )
      .get(candidateId) as
      | {
          readonly id: string;
          readonly candidateId: string;
          readonly candidateHash: string;
          readonly runId: string;
          readonly snapshotRevisionId: string;
          readonly decision: HumanReleaseDecisionKind;
          readonly actorType: "human";
          readonly actorId: string;
          readonly authenticatedBy: "local-session";
          readonly reason: string;
          readonly comment: string | null;
          readonly evidenceRefsJson: string;
          readonly reworkJson: string | null;
          readonly reworkHash: string | null;
          readonly childRunId: string | null;
          readonly decisionHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) return null;
    const evidenceRefs = parseJson<readonly string[]>(
      row.evidenceRefsJson,
      `Human release decision ${row.id} evidence`,
    );
    const rework = row.reworkJson
      ? parseJson<ReleaseRework>(
          row.reworkJson,
          `Human release decision ${row.id} rework`,
        )
      : null;
    const decision = {
      id: row.id,
      candidateId: row.candidateId,
      candidateHash: row.candidateHash,
      runId: row.runId,
      snapshotRevisionId: row.snapshotRevisionId,
      decision: row.decision,
      actor: {
        type: row.actorType,
        id: row.actorId,
        authenticatedBy: row.authenticatedBy,
      },
      reason: row.reason,
      comment: row.comment,
      evidenceRefs,
      rework,
      childRunId: row.childRunId,
      createdAt: row.createdAt,
    };
    if (
      (rework && sha256(rework) !== row.reworkHash) ||
      (!rework && row.reworkHash !== null) ||
      sha256(decision) !== row.decisionHash
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_INTEGRITY_FAILED",
        `Human release decision ${row.id} failed immutable integrity validation.`,
      );
    }
    return { ...decision, decisionHash: row.decisionHash };
  };

  const readRecoveryActivation = (
    candidateId: string,
  ): ReleaseReworkActivation | null => {
    const row = database
      .prepare(
        `SELECT activation_json AS activationJson,
                activation_hash AS activationHash,
                authority_hash AS authorityHash,
                lineage_json AS lineageJson,
                lineage_hash AS lineageHash
           FROM delivery_release_rework_activations
          WHERE candidate_id = ?`,
      )
      .get(candidateId) as
      | {
          readonly activationJson: string;
          readonly activationHash: string;
          readonly authorityHash: string;
          readonly lineageJson: string;
          readonly lineageHash: string;
        }
      | undefined;
    if (!row) return null;
    const activation = parseJson<
      Omit<ReleaseReworkActivation, "activationHash">
    >(
      row.activationJson,
      `Release rework activation for Delivery Candidate ${candidateId}`,
    );
    if (
      sha256(activation) !== row.activationHash ||
      activation.authority.hash !== row.authorityHash ||
      canonicalJson(activation.authority.lineage) !== row.lineageJson ||
      activation.authority.lineageHash !== row.lineageHash ||
      sha256(activation.authority.lineage) !== row.lineageHash
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_ACTIVATION_INTEGRITY_FAILED",
        `Release rework activation for Delivery Candidate ${candidateId} failed immutable integrity validation.`,
      );
    }
    return { ...activation, activationHash: row.activationHash };
  };

  const inspect = (candidateId: string): DeliveryCandidateView => {
    const row = database
      .prepare(
        `SELECT id, request_id AS requestId, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, created_at AS createdAt
           FROM delivery_candidates WHERE id = ?`,
      )
      .get(candidateId) as
      | {
          readonly id: string;
          readonly requestId: string;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_NOT_FOUND",
        `Delivery Candidate ${candidateId} was not found.`,
      );
    }
    const manifest = parseJson<DeliveryCandidateManifest>(
      row.manifestJson,
      `Delivery Candidate ${candidateId}`,
    );
    if (sha256(manifest) !== row.manifestHash) {
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_INTEGRITY_FAILED",
        `Delivery Candidate ${candidateId} failed immutable manifest validation.`,
      );
    }
    const decision = readDecision(candidateId);
    const recoveryActivation = readRecoveryActivation(candidateId);
    const successor = database
      .prepare(
        `SELECT id FROM delivery_candidates
          WHERE supersedes_candidate_id = ? ORDER BY created_at, id LIMIT 1`,
      )
      .get(candidateId) as { readonly id: string } | undefined;
    const projection: DeliveryCandidateProjection =
      decision?.decision === "accepted"
        ? "accepted"
        : successor
          ? "superseded"
          : decision
            ? decision.decision
            : "awaiting-decision";
    return {
      id: row.id,
      requestId: row.requestId,
      manifest,
      manifestHash: row.manifestHash,
      projection,
      decision,
      recoveryActivation,
      supersededByCandidateId: successor?.id ?? null,
      createdAt: row.createdAt,
    };
  };

  const inspectRun = (runId: string): readonly DeliveryCandidateView[] =>
    (
      database
        .prepare(
          `SELECT id FROM delivery_candidates
            WHERE run_id = ? ORDER BY created_at, id`,
        )
        .all(runId) as Array<{ readonly id: string }>
    ).map((row) => inspect(row.id));

  const assemble: DeliveryRuntime["assemble"] = (input) => {
    const candidateInput = options.candidateInputs.inspect(
      input.candidateInputId,
    );
    if (candidateInput.manifestHash !== input.expectedCandidateInputHash) {
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_INPUT_CONFLICT",
        `Delivery Candidate Input ${input.candidateInputId} does not match the expected immutable hash.`,
      );
    }
    let gateAuthority: DeliveryCandidateInputGateAuthority;
    try {
      gateAuthority = options.qualityGates.downstreamAuthority(
        input.candidateInputId,
      );
    } catch (error) {
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_AUTHORITY_BLOCKED",
        `Delivery Candidate Input ${input.candidateInputId} has no exact downstream Gate authority: ${String(error)}`,
      );
    }
    if (
      gateAuthority.candidateInputId !== candidateInput.id ||
      gateAuthority.candidateInputHash !== candidateInput.manifestHash ||
      gateAuthority.authorityHash !== input.expectedGateAuthorityHash
    ) {
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_AUTHORITY_CONFLICT",
        `Delivery Candidate Input ${input.candidateInputId} does not match the expected T18 authority.`,
      );
    }
    const lineageHash = sha256({
      projectId: candidateInput.manifest.projectId,
      runId: candidateInput.manifest.runId,
      productBaselineId: candidateInput.manifest.product.baselineId,
      repositoryReferences: candidateInput.manifest.repositoryCommits.map(
        (entry) => entry.repositoryReference,
      ),
    });
    const prior = database
      .prepare(
        `SELECT id FROM delivery_candidates
          WHERE run_id = ? AND candidate_input_id <> ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(candidateInput.manifest.runId, candidateInput.id) as
      | { readonly id: string }
      | undefined;
    if (prior) {
      const priorView = inspect(prior.id);
      if (priorView.projection === "accepted") {
        throw new DeliveryRuntimeError(
          "DELIVERY_CANDIDATE_ACCEPTED_TERMINAL",
          `Accepted Delivery Candidate ${prior.id} cannot be superseded.`,
        );
      }
      if (priorView.projection === "rejected") {
        throw new DeliveryRuntimeError(
          "DELIVERY_CANDIDATE_EXPLICIT_FORK_REQUIRED",
          `Rejected Delivery Candidate ${prior.id} requires an explicit child Run.`,
        );
      }
    }
    const { humanReleaseNodeRunId } =
      options.pipelineRuntime.resolveHumanReleaseNodeInTransaction({
        runId: candidateInput.manifest.runId,
        candidateNodeRunId: input.nodeRunId,
      });
    const manifest = {
      schemaVersion: 1,
      candidateId: input.candidateId,
      candidateInput: {
        id: candidateInput.id,
        hash: candidateInput.manifestHash,
        manifest: candidateInput.manifest,
      },
      gateAuthority,
      projectId: candidateInput.manifest.projectId,
      runId: candidateInput.manifest.runId,
      snapshot: candidateInput.manifest.snapshot,
      source: {
        nodeRunId: input.nodeRunId,
        nodeAttemptId: input.nodeAttemptId,
        humanReleaseNodeRunId,
      },
      product: candidateInput.manifest.product,
      technical: candidateInput.manifest.technical,
      codeReviewCoverage: candidateInput.manifest.codeReviewCoverage,
      integration: candidateInput.manifest.integration,
      repositoryCommits: candidateInput.manifest.repositoryCommits,
      contracts: candidateInput.manifest.contracts,
      tests: candidateInput.manifest.tests,
      testCaseRevisions: candidateInput.manifest.testCaseRevisions,
      artifacts: candidateInput.manifest.artifacts,
      risk: candidateInput.manifest.risk,
      evidence: candidateInput.manifest.evidence,
      environment: candidateInput.manifest.environment,
      evidencePolicy: candidateInput.manifest.evidencePolicy,
      lineage: {
        sourceCandidateId: prior?.id ?? null,
        lineageHash,
      },
    } satisfies DeliveryCandidateManifest;
    const manifestHash = sha256(manifest);
    const requestHash = sha256(input);
    const existing = database
      .prepare(
        `SELECT id, request_id AS requestId, request_hash AS requestHash,
                manifest_hash AS manifestHash
           FROM delivery_candidates
          WHERE id = ? OR request_id = ? OR candidate_input_id = ?`,
      )
      .get(input.candidateId, input.requestId, candidateInput.id) as
      | {
          readonly id: string;
          readonly requestId: string;
          readonly requestHash: string;
          readonly manifestHash: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.id === input.candidateId &&
        existing.requestId === input.requestId &&
        existing.requestHash === requestHash &&
        existing.manifestHash === manifestHash
      ) {
        return inspect(existing.id);
      }
      throw new DeliveryRuntimeError(
        "DELIVERY_CANDIDATE_CONFLICT",
        `The exact Candidate Input authority already binds a different Delivery Candidate request.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO delivery_candidates(
           id, request_id, project_id, run_id, snapshot_revision_id,
           candidate_input_id, candidate_input_hash, gate_authority_id,
           gate_authority_hash, source_node_run_id, source_node_attempt_id,
           supersedes_candidate_id, lineage_hash, manifest_json, manifest_hash,
           request_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.candidateId,
        input.requestId,
        candidateInput.manifest.projectId,
        candidateInput.manifest.runId,
        candidateInput.manifest.snapshot.id,
        candidateInput.id,
        candidateInput.manifestHash,
        gateAuthority.id,
        gateAuthority.authorityHash,
        input.nodeRunId,
        input.nodeAttemptId,
        prior?.id ?? null,
        lineageHash,
        canonicalJson(manifest),
        manifestHash,
        requestHash,
        now,
      );
    options.pipelineRuntime.completeDeliveryCandidateInTransaction({
      runId: candidateInput.manifest.runId,
      snapshotRevisionId: candidateInput.manifest.snapshot.id,
      nodeRunId: input.nodeRunId,
      nodeAttemptId: input.nodeAttemptId,
      leaseId: input.leaseId,
      workerId: input.workerId,
      candidateId: input.candidateId,
      candidateHash: manifestHash,
      completedAt: now,
    });
    appendMutation({
      type: "delivery.candidate.created",
      entityType: "delivery-candidate",
      entityId: input.candidateId,
      candidateId: input.candidateId,
      candidateInputId: candidateInput.id,
      projectId: candidateInput.manifest.projectId,
      runId: candidateInput.manifest.runId,
      snapshotRevisionId: candidateInput.manifest.snapshot.id,
      nodeRunId: input.nodeRunId,
      nodeAttemptId: input.nodeAttemptId,
      payload: {
        deliveryCandidateId: input.candidateId,
        deliveryCandidateInputId: candidateInput.id,
        candidateHash: manifestHash,
        candidateInputHash: candidateInput.manifestHash,
        gateAuthorityId: gateAuthority.id,
        gateAuthorityHash: gateAuthority.authorityHash,
        supersedesCandidateId: prior?.id ?? null,
      },
      timestamp: now,
    });
    return inspect(input.candidateId);
  };

  const acceptedAuthority: DeliveryRuntime["acceptedAuthority"] = (
    candidateId,
  ) => {
    const row = database
      .prepare(
        `SELECT id, authority_json AS authorityJson,
                authority_hash AS authorityHash, created_at AS createdAt
           FROM accepted_delivery_candidate_authorities
          WHERE candidate_id = ?`,
      )
      .get(candidateId) as
      | {
          readonly id: string;
          readonly authorityJson: string;
          readonly authorityHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new DeliveryRuntimeError(
        "ACCEPTED_DELIVERY_AUTHORITY_NOT_FOUND",
        `Delivery Candidate ${candidateId} has no accepted downstream authority.`,
      );
    }
    const authority = parseJson<
      Omit<AcceptedDeliveryCandidateAuthority, "authorityHash" | "createdAt">
    >(row.authorityJson, `Accepted Delivery Candidate authority ${row.id}`);
    if (sha256(authority) !== row.authorityHash) {
      throw new DeliveryRuntimeError(
        "ACCEPTED_DELIVERY_AUTHORITY_INTEGRITY_FAILED",
        `Accepted Delivery Candidate authority ${row.id} failed immutable integrity validation.`,
      );
    }
    return {
      ...authority,
      authorityHash: row.authorityHash,
      createdAt: row.createdAt,
    };
  };

  const decide: DeliveryRuntime["decide"] = (input) => {
    if (
      input.actor.type !== "human" ||
      input.actor.authenticatedBy !== "local-session"
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_ACTOR_INVALID",
        "Human release requires actor {type:'human', authenticatedBy:'local-session'}.",
      );
    }
    const candidate = inspect(input.candidateId);
    if (candidate.manifestHash !== input.expectedCandidateHash) {
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_CANDIDATE_CONFLICT",
        `Delivery Candidate ${input.candidateId} does not match the expected immutable hash.`,
      );
    }
    const reason = input.reason.trim();
    const comment = input.comment?.trim() || null;
    const evidenceRefs = uniqueSorted(
      input.evidenceRefs.map((ref) => ref.trim()),
    );
    if (
      reason.length === 0 ||
      reason.length > 4_000 ||
      (comment?.length ?? 0) > 4_000 ||
      evidenceRefs.length === 0 ||
      evidenceRefs.length > 64 ||
      evidenceRefs.some((ref) => ref.length === 0 || ref.length > 512)
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_EVIDENCE_INVALID",
        "Human release requires a bounded reason, optional bounded comment, and evidence references.",
      );
    }
    const rework = input.rework ?? null;
    if (
      (input.decision === "changes-requested" && !rework) ||
      (input.decision !== "changes-requested" && rework) ||
      (rework &&
        (rework.responsibility.summary.trim().length === 0 ||
          rework.responsibility.summary.length > 1_000 ||
          (rework.scope === "same-boundary" &&
            rework.childRunId !== undefined) ||
          (rework.scope === "boundary-changing" &&
            !rework.childRunId?.trim()) ||
          (!["aggregate", "unknown"].includes(rework.responsibility.kind) &&
            !rework.responsibility.id?.trim())))
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_INVALID",
        "changes-requested requires one bounded same-boundary or boundary-changing responsibility record.",
      );
    }
    const existing = readDecision(candidate.id);
    if (existing) {
      if (
        existing.id === input.decisionId &&
        existing.candidateHash === candidate.manifestHash &&
        existing.decision === input.decision &&
        existing.actor.type === input.actor.type &&
        existing.actor.id === input.actor.id &&
        existing.actor.authenticatedBy === input.actor.authenticatedBy &&
        existing.reason === reason &&
        existing.comment === comment &&
        canonicalJson(existing.evidenceRefs) === canonicalJson(evidenceRefs) &&
        canonicalJson(existing.rework) === canonicalJson(rework)
      ) {
        return inspect(candidate.id);
      }
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_EXISTS",
        `Delivery Candidate ${candidate.id} already has a Human release decision.`,
      );
    }
    if (candidate.projection !== "awaiting-decision") {
      throw new DeliveryRuntimeError(
        "RELEASE_DECISION_CANDIDATE_STATE_INVALID",
        `Delivery Candidate ${candidate.id} is ${candidate.projection} and cannot accept a decision.`,
      );
    }
    const now = clock().toISOString();
    const childRunId = rework?.childRunId?.trim() || null;
    if (rework?.scope === "boundary-changing") {
      options.pipelineRuntime.validateReleaseBoundaryChildInTransaction({
        sourceRunId: candidate.manifest.runId,
        sourceSnapshotRevisionId: candidate.manifest.snapshot.id,
        childRunId: childRunId!,
      });
    }
    options.pipelineRuntime.applyHumanReleaseDecisionInTransaction({
      runId: candidate.manifest.runId,
      humanReleaseNodeRunId: candidate.manifest.source.humanReleaseNodeRunId,
      candidateId: candidate.id,
      candidateHash: candidate.manifestHash,
      decisionId: input.decisionId,
      decision: input.decision,
      ...(childRunId ? { childRunId } : {}),
      decidedAt: now,
    });
    const persistedDecision = {
      id: input.decisionId,
      candidateId: candidate.id,
      candidateHash: candidate.manifestHash,
      runId: candidate.manifest.runId,
      snapshotRevisionId: candidate.manifest.snapshot.id,
      decision: input.decision,
      actor: {
        type: input.actor.type,
        id: input.actor.id,
        authenticatedBy: input.actor.authenticatedBy,
      },
      reason,
      comment,
      evidenceRefs,
      rework,
      childRunId,
      createdAt: now,
    } satisfies Omit<HumanReleaseDecision, "decisionHash">;
    const decisionHash = sha256(persistedDecision);
    database
      .prepare(
        `INSERT INTO human_release_decisions(
           id, candidate_id, candidate_hash, run_id, snapshot_revision_id,
           decision, actor_type, actor_id, authenticated_by, reason, comment,
           evidence_refs_json, rework_json, rework_hash, child_run_id,
           decision_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'human', ?, 'local-session', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.decisionId,
        candidate.id,
        candidate.manifestHash,
        candidate.manifest.runId,
        candidate.manifest.snapshot.id,
        input.decision,
        input.actor.id,
        reason,
        comment,
        canonicalJson(evidenceRefs),
        rework ? canonicalJson(rework) : null,
        rework ? sha256(rework) : null,
        childRunId,
        decisionHash,
        now,
      );
    if (rework) {
      database
        .prepare(
          `INSERT INTO delivery_release_rework_records(
             id, decision_id, candidate_id, run_id, scope,
             responsibility_json, responsibility_hash, child_run_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `release-rework:${input.decisionId}`,
          input.decisionId,
          candidate.id,
          candidate.manifest.runId,
          rework.scope,
          canonicalJson(rework.responsibility),
          sha256(rework.responsibility),
          childRunId,
          now,
        );
    }
    if (input.decision === "accepted") {
      const integration = candidate.manifest.integration as unknown as {
        readonly id?: string;
        readonly passAuthorityHash?: string;
      };
      if (!integration.id || !integration.passAuthorityHash) {
        throw new DeliveryRuntimeError(
          "ACCEPTED_DELIVERY_AUTHORITY_INCOMPLETE",
          `Delivery Candidate ${candidate.id} lacks exact Integration authority.`,
        );
      }
      const authority = {
        id: `accepted-authority:${input.decisionId}`,
        candidateId: candidate.id,
        candidateHash: candidate.manifestHash,
        releaseDecisionId: input.decisionId,
        releaseDecisionHash: decisionHash,
        candidateInputId: candidate.manifest.candidateInput.id,
        candidateInputHash: candidate.manifest.candidateInput.hash,
        gateAuthorityId: candidate.manifest.gateAuthority.id,
        gateAuthorityHash: candidate.manifest.gateAuthority.authorityHash,
        integrationGenerationId: integration.id,
        integrationAuthorityHash: integration.passAuthorityHash,
        repositoryCommits: candidate.manifest.repositoryCommits,
        artifactVersionIds: uniqueSorted(
          candidate.manifest.artifacts.map((artifact) => artifact.id),
        ),
        runId: candidate.manifest.runId,
        snapshotRevisionId: candidate.manifest.snapshot.id,
      };
      const authorityHash = sha256(authority);
      database
        .prepare(
          `INSERT INTO accepted_delivery_candidate_authorities(
             id, candidate_id, release_decision_id, authority_json,
             authority_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authority.id,
          candidate.id,
          input.decisionId,
          canonicalJson(authority),
          authorityHash,
          now,
        );
    }
    appendMutation({
      type:
        input.decision === "accepted"
          ? "delivery.release.accepted"
          : input.decision === "rejected"
            ? "delivery.release.rejected"
            : "delivery.release.changes-requested",
      entityType: "human-release-decision",
      entityId: input.decisionId,
      releaseDecisionId: input.decisionId,
      candidateId: candidate.id,
      candidateInputId: candidate.manifest.candidateInput.id,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      snapshotRevisionId: candidate.manifest.snapshot.id,
      payload: {
        humanReleaseDecisionId: input.decisionId,
        deliveryCandidateId: candidate.id,
        deliveryCandidateInputId: candidate.manifest.candidateInput.id,
        candidateHash: candidate.manifestHash,
        decision: input.decision,
        decisionHash,
        evidenceRefs,
        reworkScope: rework?.scope ?? null,
        childRunId,
      },
      timestamp: now,
    });
    return inspect(candidate.id);
  };

  const recover: DeliveryRuntime["recover"] = (input) => {
    if (
      input.actor.type !== "human" ||
      input.actor.authenticatedBy !== "local-session"
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_ACTOR_INVALID",
        "Human release rework recovery requires a verified local-session human.",
      );
    }
    const candidate = inspect(input.candidateId);
    if (candidate.manifestHash !== input.expectedCandidateHash) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_CANDIDATE_CONFLICT",
        `Delivery Candidate ${input.candidateId} does not match the expected immutable hash.`,
      );
    }
    const decision = candidate.decision;
    if (
      !decision ||
      decision.id !== input.decisionId ||
      decision.decision !== "changes-requested" ||
      decision.rework?.scope !== "same-boundary"
    ) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_DECISION_INVALID",
        `Human release decision ${input.decisionId} is not awaiting same-boundary rework.`,
      );
    }
    const existingActivation = readRecoveryActivation(candidate.id);
    if (existingActivation) {
      const exactReplay =
        existingActivation.decisionId === input.decisionId &&
        existingActivation.authority.kind === input.authority.kind &&
        existingActivation.authority.id === input.authority.id &&
        existingActivation.actor.id === input.actor.id &&
        existingActivation.actor.type === input.actor.type &&
        existingActivation.actor.authenticatedBy ===
          input.actor.authenticatedBy;
      if (!exactReplay) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_ACTIVATION_EXISTS",
          `Human release decision ${input.decisionId} already has a different immutable recovery activation.`,
        );
      }
      return inspect(candidate.id);
    }
    const responsibility = decision.rework.responsibility;
    if (responsibility.kind === "unknown") {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_RESPONSIBILITY_UNRESOLVED",
        "Unknown Human release responsibility must remain blocked until one exact formal responsibility is selected.",
      );
    }
    let effectiveKind = responsibility.kind;
    let effectiveId = responsibility.id?.trim();
    let targetNodeRunId: string | undefined;
    let authorityLineage: unknown;
    let exactTestDefectId: string | undefined;
    const requireCandidateInputRecheck = (): void => {
      if (
        input.authority.kind !== "candidate-input-recheck" ||
        input.authority.id !== candidate.manifest.candidateInput.id
      ) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_INVALID",
          `Release recheck must bind exact Delivery Candidate Input ${candidate.manifest.candidateInput.id}.`,
        );
      }
      targetNodeRunId =
        candidate.manifest.candidateInput.manifest.sourceNode.nodeRunId;
      authorityLineage = {
        candidateInputId: candidate.manifest.candidateInput.id,
        candidateInputHash: candidate.manifest.candidateInput.hash,
        gateAuthorityId: candidate.manifest.gateAuthority.id,
        gateAuthorityHash: candidate.manifest.gateAuthority.authorityHash,
        sourceNodeRunId: targetNodeRunId,
      };
    };
    if (responsibility.kind === "aggregate") {
      requireCandidateInputRecheck();
    } else if (!effectiveId) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
        `Release rework responsibility ${responsibility.kind} requires an exact persisted identity.`,
      );
    }
    if (responsibility.kind === "gate") {
      const exactGateIds = [
        candidate.manifest.gateAuthority.security.gateInputId,
        candidate.manifest.gateAuthority.security.resultId,
        candidate.manifest.gateAuthority.security.qualityGateResultId,
        candidate.manifest.gateAuthority.operability.gateInputId,
        candidate.manifest.gateAuthority.operability.resultId,
        candidate.manifest.gateAuthority.operability.qualityGateResultId,
      ];
      if (!exactGateIds.includes(effectiveId!)) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
          `Gate responsibility ${effectiveId} is not frozen by Delivery Candidate ${candidate.id}.`,
        );
      }
      requireCandidateInputRecheck();
    } else if (responsibility.kind === "contract") {
      if (input.authority.kind !== "work-package-version") {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_KIND_INVALID",
          "Contract responsibility requires rework of one formally responsible Work Package.",
        );
      }
      const routed = database
        .prepare(
          `SELECT prior.id
             FROM integration_generations AS generations,
                  json_each(json_extract(generations.manifest_json, '$.requiredValidations')) AS validation,
                  json_each(json_extract(validation.value, '$.responsibleWorkPackageVersionIds')) AS responsible
             JOIN work_package_versions AS prior ON prior.id = responsible.value
             JOIN work_package_versions AS fresh
               ON fresh.id = ? AND fresh.work_package_id = prior.work_package_id
            WHERE generations.id = ?
              AND generations.run_id = ?
              AND json_extract(validation.value, '$.contract.id') = ?
            LIMIT 1`,
        )
        .get(
          input.authority.id,
          (candidate.manifest.integration as { readonly id: string }).id,
          candidate.manifest.runId,
          effectiveId!,
        ) as { readonly id: string } | undefined;
      if (!routed) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
          `Contract responsibility ${effectiveId} has no exact formally responsible Work Package route.`,
        );
      }
      effectiveKind = "work-package";
      effectiveId = routed.id;
    } else if (responsibility.kind === "defect") {
      const gateDefect = database
        .prepare(
          `SELECT defects.id
             FROM candidate_gate_defects AS defects
             JOIN candidate_gate_inputs AS inputs ON inputs.id = defects.gate_input_id
            WHERE defects.id = ? AND inputs.candidate_input_id = ?`,
        )
        .get(effectiveId!, candidate.manifest.candidateInput.id);
      if (gateDefect) {
        requireCandidateInputRecheck();
      } else {
        const testDefect = database
          .prepare(
            `SELECT tests.id AS testRunId
               FROM test_defects AS defects
               JOIN test_runs AS tests ON tests.id = defects.test_run_id
              WHERE defects.id = ? AND tests.run_id = ?`,
          )
          .get(effectiveId!, candidate.manifest.runId) as
          | { readonly testRunId: string }
          | undefined;
        if (testDefect) {
          effectiveKind = "test";
          effectiveId = testDefect.testRunId;
          exactTestDefectId = responsibility.id;
        } else {
          if (input.authority.kind !== "work-package-version") {
            throw new DeliveryRuntimeError(
              "RELEASE_REWORK_AUTHORITY_KIND_INVALID",
              "Integration Defect responsibility requires rework of one formally responsible Work Package.",
            );
          }
          const integrationDefect = database
            .prepare(
              `SELECT prior.id
                 FROM integration_defects AS defects,
                      json_each(json_extract(defects.responsibility_json, '$.workPackageVersionIds')) AS responsible
                 JOIN integration_generations AS generations
                   ON generations.id = defects.generation_id
                 JOIN work_package_versions AS prior ON prior.id = responsible.value
                 JOIN work_package_versions AS fresh
                   ON fresh.id = ? AND fresh.work_package_id = prior.work_package_id
                WHERE defects.id = ? AND generations.run_id = ?
                LIMIT 1`,
            )
            .get(input.authority.id, effectiveId!, candidate.manifest.runId) as
            | { readonly id: string }
            | undefined;
          if (!integrationDefect) {
            throw new DeliveryRuntimeError(
              "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
              `Defect responsibility ${effectiveId} has no exact Candidate Gate, Test, or Integration route.`,
            );
          }
          effectiveKind = "work-package";
          effectiveId = integrationDefect.id;
        }
      }
    }
    if (!targetNodeRunId && effectiveKind === "work-package") {
      if (input.authority.kind !== "work-package-version") {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_KIND_INVALID",
          "Work Package responsibility requires a fresh Work Package Version authority.",
        );
      }
      const frozenVersionIds = candidate.manifest.codeReviewCoverage.flatMap(
        (entry) => {
          const versionId = (
            entry as { readonly workPackageVersionId?: unknown }
          ).workPackageVersionId;
          return typeof versionId === "string" ? [versionId] : [];
        },
      );
      const prior =
        frozenVersionIds.length === 0
          ? undefined
          : (database
              .prepare(
                `SELECT versions.id, versions.work_package_id AS workPackageId,
                  versions.version, versions.node_run_id AS nodeRunId
             FROM work_package_versions AS versions
             JOIN work_packages AS packages
               ON packages.id = versions.work_package_id
            WHERE packages.run_id = ?
              AND versions.id IN (${frozenVersionIds.map(() => "?").join(", ")})
              AND (versions.id = ? OR versions.work_package_id = ?)
         ORDER BY versions.version DESC LIMIT 1`,
              )
              .get(
                candidate.manifest.runId,
                ...frozenVersionIds,
                effectiveId!,
                effectiveId!,
              ) as
              | {
                  readonly id: string;
                  readonly workPackageId: string;
                  readonly version: number;
                  readonly nodeRunId: string;
                }
              | undefined);
      if (!prior || !frozenVersionIds.includes(prior.id)) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
          `Work Package responsibility ${effectiveId} is not frozen by Delivery Candidate ${candidate.id}.`,
        );
      }
      const fresh = database
        .prepare(
          `SELECT fresh.node_run_id AS nodeRunId,
                  fresh.id AS freshVersionId,
                  fresh.version AS freshVersion,
                  fresh.work_package_id AS workPackageId,
                  prior.id AS priorVersionId,
                  audit.command_id AS reworkCommandId
             FROM work_package_versions AS fresh
             JOIN work_package_versions AS prior ON prior.id = ?
             JOIN work_package_assignments AS assignment
               ON assignment.work_package_version_id = fresh.id
              AND assignment.state IN ('assigned', 'running', 'awaiting-self-check', 'self-check-passed')
             JOIN workspace_allocations AS allocation
               ON allocation.id = assignment.allocation_id
              AND allocation.work_package_version_id = fresh.id
             JOIN node_attempts AS attempt
               ON attempt.id = assignment.node_attempt_id
              AND attempt.node_run_id = fresh.node_run_id
              AND attempt.status IN ('ready', 'running', 'succeeded')
             JOIN runtime_audit_records AS audit
               ON audit.action = 'work-package.rework'
              AND audit.entity_type = 'work-package'
              AND audit.entity_id = fresh.work_package_id
              AND audit.run_id = ?
              AND audit.node_run_id = fresh.node_run_id
              AND audit.actor_type = 'runtime-worker'
              AND audit.authenticated_by = 'runtime'
              AND json_extract(audit.after_json, '$.workPackageVersionId') = fresh.id
             JOIN command_deduplication AS receipt
               ON receipt.command_id = audit.command_id
              AND receipt.status = 'completed'
              AND receipt.actor_type = audit.actor_type
              AND receipt.actor_id = audit.actor_id
              AND receipt.authenticated_by = audit.authenticated_by
            WHERE fresh.id = ?
              AND fresh.work_package_id = prior.work_package_id
              AND fresh.version > prior.version
              AND fresh.status = 'ready'
              AND prior.status = 'superseded'
              AND fresh.node_run_id = prior.node_run_id
            LIMIT 1`,
        )
        .get(prior.id, candidate.manifest.runId, input.authority.id) as
        | {
            readonly nodeRunId: string;
            readonly freshVersionId: string;
            readonly freshVersion: number;
            readonly workPackageId: string;
            readonly priorVersionId: string;
            readonly reworkCommandId: string;
          }
        | undefined;
      if (!fresh) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_INVALID",
          `Work Package Version ${input.authority.id} is not a fresh formal rework authority for ${prior.id}.`,
        );
      }
      targetNodeRunId = fresh.nodeRunId;
      authorityLineage = {
        workPackageId: fresh.workPackageId,
        priorVersionId: fresh.priorVersionId,
        freshVersionId: fresh.freshVersionId,
        freshVersion: fresh.freshVersion,
        nodeRunId: fresh.nodeRunId,
        reworkCommandId: fresh.reworkCommandId,
      };
    } else if (!targetNodeRunId && effectiveKind === "test") {
      if (input.authority.kind !== "test-rework-run") {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_KIND_INVALID",
          "Test responsibility requires a fresh Test rework Run authority.",
        );
      }
      if (
        !candidate.manifest.tests.some((test) => test.testRunId === effectiveId)
      ) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_RESPONSIBILITY_NOT_FOUND",
          `Test responsibility ${effectiveId} is not frozen by Delivery Candidate ${candidate.id}.`,
        );
      }
      const rework = database
        .prepare(
          `SELECT fresh.run_id AS runId,
                  fresh.snapshot_revision_id AS snapshotRevisionId,
                  rework.id AS reworkId,
                  rework.defect_id AS defectId,
                  rework.lineage_hash AS reworkLineageHash,
                  resolutions.id AS resolutionId,
                  resolutions.resolution_hash AS resolutionHash,
                  fresh.pass_authority_hash AS passAuthorityHash
             FROM test_rework_runs AS rework
             JOIN test_runs AS fresh ON fresh.id = rework.fresh_test_run_id
             JOIN test_defect_resolutions AS resolutions
               ON resolutions.defect_id = rework.defect_id
              AND json_extract(resolutions.resolution_json, '$.resolvedByTestRunId') = fresh.id
              AND json_extract(resolutions.resolution_json, '$.passAuthorityHash') = fresh.pass_authority_hash
             JOIN runtime_audit_records AS accepted
               ON accepted.action = 'test.run.accepted'
              AND accepted.entity_type = 'test-run'
              AND accepted.entity_id = fresh.id
             JOIN command_deduplication AS accepted_receipt
               ON accepted_receipt.command_id = accepted.command_id
              AND accepted_receipt.status = 'completed'
              AND accepted_receipt.actor_type = accepted.actor_type
              AND accepted_receipt.actor_id = accepted.actor_id
              AND accepted_receipt.authenticated_by = accepted.authenticated_by
             JOIN runtime_audit_records AS completed
               ON completed.action = 'test.run.completed'
              AND completed.entity_type = 'test-run'
              AND completed.entity_id = fresh.id
             JOIN command_deduplication AS completed_receipt
               ON completed_receipt.command_id = completed.command_id
              AND completed_receipt.status = 'completed'
              AND completed_receipt.actor_type = completed.actor_type
              AND completed_receipt.actor_id = completed.actor_id
              AND completed_receipt.authenticated_by = completed.authenticated_by
            WHERE rework.prior_test_run_id = ?
              AND rework.fresh_test_run_id = ?
              AND (? IS NULL OR rework.defect_id = ?)
              AND fresh.state = 'passed'
              AND fresh.pass_authority_hash IS NOT NULL
            LIMIT 1`,
        )
        .get(
          effectiveId!,
          input.authority.id,
          exactTestDefectId ?? null,
          exactTestDefectId ?? null,
        ) as
        | {
            readonly runId: string;
            readonly snapshotRevisionId: string;
            readonly reworkId: string;
            readonly defectId: string;
            readonly reworkLineageHash: string;
            readonly resolutionId: string;
            readonly resolutionHash: string;
            readonly passAuthorityHash: string;
          }
        | undefined;
      if (
        !rework ||
        rework.runId !== candidate.manifest.runId ||
        rework.snapshotRevisionId !== candidate.manifest.snapshot.id ||
        !options.tests
      ) {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_INVALID",
          `Test Run ${input.authority.id} is not a fresh formal PASS rework authority for ${effectiveId}.`,
        );
      }
      try {
        options.tests.downstreamAuthority(input.authority.id);
      } catch {
        throw new DeliveryRuntimeError(
          "RELEASE_REWORK_AUTHORITY_INVALID",
          `Test Run ${input.authority.id} failed exact downstream authority validation.`,
        );
      }
      targetNodeRunId =
        candidate.manifest.candidateInput.manifest.sourceNode.nodeRunId;
      authorityLineage = {
        reworkId: rework.reworkId,
        defectId: rework.defectId,
        priorTestRunId: effectiveId!,
        freshTestRunId: input.authority.id,
        reworkLineageHash: rework.reworkLineageHash,
        resolutionId: rework.resolutionId,
        resolutionHash: rework.resolutionHash,
        passAuthorityHash: rework.passAuthorityHash,
        runId: rework.runId,
        snapshotRevisionId: rework.snapshotRevisionId,
      };
    } else if (!targetNodeRunId) {
      throw new DeliveryRuntimeError(
        "RELEASE_REWORK_AUTHORITY_UNSUPPORTED",
        `Formal recovery authority for ${responsibility.kind} responsibility is invalid.`,
      );
    }
    const now = clock().toISOString();
    const commandContext = database
      .prepare(
        `SELECT command_id AS commandId
           FROM runtime_unit_of_work_context WHERE slot = 1`,
      )
      .get() as { readonly commandId: string } | undefined;
    const lineageHash = sha256(authorityLineage);
    const activation = {
      id: `release-rework-activation:${decision.id}`,
      decisionId: decision.id,
      reworkRecordId: `release-rework:${decision.id}`,
      candidateId: candidate.id,
      runId: candidate.manifest.runId,
      snapshotRevisionId: candidate.manifest.snapshot.id,
      targetNodeRunId: targetNodeRunId!,
      authority: {
        kind: input.authority.kind,
        id: input.authority.id,
        hash: sha256({
          kind: input.authority.kind,
          id: input.authority.id,
          lineageHash,
        }),
        lineage: authorityLineage,
        lineageHash,
      },
      actor: {
        type: "human" as const,
        id: input.actor.id,
        authenticatedBy: "local-session" as const,
      },
      commandId:
        input.commandId ??
        commandContext?.commandId ??
        `direct-release-recovery:${decision.id}`,
      createdAt: now,
    } satisfies Omit<ReleaseReworkActivation, "activationHash">;
    const activationHash = sha256(activation);
    options.pipelineRuntime.activateHumanReleaseReworkInTransaction({
      runId: candidate.manifest.runId,
      humanReleaseNodeRunId: candidate.manifest.source.humanReleaseNodeRunId,
      decisionId: decision.id,
      targetNodeRunId: targetNodeRunId!,
      authority: {
        kind: activation.authority.kind,
        id: activation.authority.id,
        hash: activation.authority.hash,
        lineageHash: activation.authority.lineageHash,
      },
      activatedAt: now,
    });
    database
      .prepare(
        `INSERT INTO delivery_release_rework_activations(
           id, decision_id, rework_record_id, candidate_id, run_id,
           snapshot_revision_id, target_node_run_id, authority_kind,
           authority_id, authority_hash, lineage_json, lineage_hash,
           actor_type, actor_id, authenticated_by, command_id,
           activation_json, activation_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?,
                   'local-session', ?, ?, ?, ?)`,
      )
      .run(
        activation.id,
        activation.decisionId,
        activation.reworkRecordId,
        activation.candidateId,
        activation.runId,
        activation.snapshotRevisionId,
        activation.targetNodeRunId,
        activation.authority.kind,
        activation.authority.id,
        activation.authority.hash,
        canonicalJson(activation.authority.lineage),
        activation.authority.lineageHash,
        activation.actor.id,
        activation.commandId,
        canonicalJson(activation),
        activationHash,
        activation.createdAt,
      );
    appendMutation({
      type: "delivery.release.rework-activated",
      entityType: "release-rework-activation",
      entityId: activation.id,
      releaseDecisionId: decision.id,
      candidateId: candidate.id,
      candidateInputId: candidate.manifest.candidateInput.id,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      snapshotRevisionId: candidate.manifest.snapshot.id,
      nodeRunId: activation.targetNodeRunId,
      payload: {
        releaseDecisionId: decision.id,
        deliveryCandidateId: candidate.id,
        deliveryCandidateInputId: candidate.manifest.candidateInput.id,
        activationId: activation.id,
        targetNodeRunId: activation.targetNodeRunId,
        authorityKind: activation.authority.kind,
        authorityId: activation.authority.id,
        authorityHash: activation.authority.hash,
        lineageHash: activation.authority.lineageHash,
        activationHash,
      },
      timestamp: now,
    });
    return inspect(candidate.id);
  };

  return {
    assemble,
    inspect,
    inspectRun,
    decide,
    recover,
    acceptedAuthority,
  };
};
