import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CandidateInputRuntime,
  CandidateRiskTier,
  DeliveryCandidateInputView,
} from "../delivery/candidateInputRuntime.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ActorRef } from "../interface.js";

export type CandidateGateKind = "security" | "operability";

export type CandidateGateReviewDepth =
  | "lightweight"
  | "targeted"
  | "deep-independent"
  | "deep-independent-escalated";

export type CandidateGateCheck = {
  readonly id: string;
  readonly requiredEvidenceKinds: readonly (
    | "artifact"
    | "runtime-fact"
    | "static-analysis"
    | "dynamic-analysis"
    | "recovery"
  )[];
  readonly selfAttestationSufficient: false;
};

export type CandidateGateInputManifest = {
  readonly schemaVersion: 1;
  readonly gateInputId: string;
  readonly kind: CandidateGateKind;
  readonly candidateInput: {
    readonly id: string;
    readonly hash: string;
  };
  readonly risk: DeliveryCandidateInputView["manifest"]["risk"];
  readonly reviewDepth: CandidateGateReviewDepth;
  readonly reviewer: {
    readonly participantId: string;
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
    readonly independenceSnapshotHash: string;
  };
  readonly source: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeAttemptId: string;
    readonly handlerKindId: string;
    readonly attemptNumber: number;
    readonly snapshotRevisionId: string;
    readonly leaseId: string;
    readonly workerId: string;
  };
  readonly checkCatalog: {
    readonly revisionId: string;
    readonly hash: string;
    readonly checks: readonly CandidateGateCheck[];
  };
  readonly requiredEvidence: readonly {
    readonly checkId: string;
    readonly kinds: CandidateGateCheck["requiredEvidenceKinds"];
  }[];
  readonly supportingEvidenceRefs: readonly string[];
  readonly snapshotRef: {
    readonly id: string;
    readonly hash: string;
  };
  readonly harnessSnapshotRefs: readonly {
    readonly id: string;
    readonly hashes: readonly string[];
  }[];
  readonly executionProfileRefs: readonly {
    readonly id: string;
    readonly hash: string;
  }[];
  readonly environment: DeliveryCandidateInputView["manifest"]["environment"];
  readonly capabilities: readonly string[];
  readonly priorGateInputId: string | null;
};

export type CandidateGateInputView = {
  readonly id: string;
  readonly requestId: string;
  readonly manifest: CandidateGateInputManifest;
  readonly manifestHash: string;
  readonly state:
    | "scheduled"
    | "running"
    | "reconciling"
    | "unknown"
    | "blocked"
    | "completed";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CandidateGateDefectView = {
  readonly id: string;
  readonly gateInputId: string;
  readonly checkId: string;
  readonly responsibility: unknown;
  readonly evidence: unknown;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
};

export type CandidateGateObligationView = {
  readonly id: string;
  readonly gateInputId: string;
  readonly defectId: string | null;
  readonly checkId: string;
  readonly description: string;
  readonly evidence: unknown;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt: string | null;
};

export type CandidateGateResultManifest = {
  readonly schemaVersion: 1;
  readonly gateInputId: string;
  readonly gateInputHash: string;
  readonly candidateInput: CandidateGateInputManifest["candidateInput"];
  readonly execution: {
    readonly id: string;
    readonly factHash: string;
    readonly receiptHash: string;
  };
  readonly review: {
    readonly topicId: string;
    readonly qualityGateResultId: string;
    readonly manifestHash: string;
    readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  };
  readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  readonly checks: readonly CandidateGateCheckOutcome[];
  readonly findingIds: readonly string[];
  readonly conditions: readonly string[];
  readonly evidenceRefs: readonly string[];
};

export type CandidateGateResultView = {
  readonly id: string;
  readonly gateInputId: string;
  readonly qualityGateResultId: string;
  readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  readonly manifest: CandidateGateResultManifest;
  readonly resultHash: string;
  readonly defects: readonly CandidateGateDefectView[];
  readonly obligations: readonly CandidateGateObligationView[];
  readonly createdAt: string;
};

export type DeliveryCandidateInputGateAuthority = {
  readonly id: string;
  readonly candidateInputId: string;
  readonly candidateInputHash: string;
  readonly security: {
    readonly gateInputId: string;
    readonly gateInputHash: string;
    readonly resultId: string;
    readonly resultHash: string;
    readonly qualityGateResultId: string;
  };
  readonly operability: {
    readonly gateInputId: string;
    readonly gateInputHash: string;
    readonly resultId: string;
    readonly resultHash: string;
    readonly qualityGateResultId: string;
  };
  readonly risk: DeliveryCandidateInputView["manifest"]["risk"];
  readonly evidenceRefs: readonly string[];
  readonly authorityHash: string;
  readonly createdAt: string;
};

export type CriticalRiskEscalationDecision = {
  readonly id: string;
  readonly candidateInputId: string;
  readonly candidateInputHash: string;
  readonly decision: "authorize-gate-continuation" | "reject";
  readonly actor: ActorRef & {
    readonly type: "human";
    readonly authenticatedBy: "local-session";
  };
  readonly risk: DeliveryCandidateInputView["manifest"]["risk"];
  readonly riskHash: string;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly decisionHash: string;
  readonly createdAt: string;
};

export type CandidateGateExecutionView = {
  readonly id: string;
  readonly gateInputId: string;
  readonly operationKey: string;
  readonly request: unknown;
  readonly requestHash: string;
  readonly state:
    | "intent"
    | "running"
    | "reconciling"
    | "unknown"
    | "succeeded"
    | "failed"
    | "cancelled";
  readonly factHash: string | null;
  readonly receiptHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type CandidateGateCheckOutcome = {
  readonly checkId: string;
  readonly status: "passed" | "missing" | "failed" | "unknown";
  readonly evidence: readonly {
    readonly kind: string;
    readonly ref: string;
  }[];
  readonly responsibility: unknown;
};

export type PrepareCandidateGateInput = {
  readonly actor: ActorRef;
  readonly gateInputId: string;
  readonly requestId: string;
  readonly kind: CandidateGateKind;
  readonly candidateInputId: string;
  readonly expectedCandidateInputHash: string;
  readonly expectedRiskTier: CandidateRiskTier;
  readonly nodeRunId: string;
  readonly nodeAttemptId: string;
  readonly reviewTopicId: string;
  readonly reviewerParticipantId: string;
  readonly priorGateInputId?: string;
};

export interface QualityGateRuntime {
  readonly decideCriticalEscalation: (input: {
    readonly actor: ActorRef;
    readonly escalationId: string;
    readonly candidateInputId: string;
    readonly expectedCandidateInputHash: string;
    readonly decision: CriticalRiskEscalationDecision["decision"];
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  }) => CriticalRiskEscalationDecision;
  readonly prepare: (
    input: PrepareCandidateGateInput,
  ) => CandidateGateInputView;
  readonly inspect: (gateInputId: string) => CandidateGateInputView;
  readonly finalize: (input: {
    readonly candidateGateResultId: string;
    readonly gateInputId: string;
    readonly executionId: string;
    readonly qualityGateResultId: string;
  }) => CandidateGateResultView;
  readonly inspectResult: (
    candidateGateResultId: string,
  ) => CandidateGateResultView;
  readonly authorize: (input: {
    readonly authorityId: string;
    readonly candidateInputId: string;
    readonly expectedCandidateInputHash: string;
    readonly securityGateResultId: string;
    readonly operabilityGateResultId: string;
  }) => DeliveryCandidateInputGateAuthority;
  readonly downstreamAuthority: (
    candidateInputId: string,
  ) => DeliveryCandidateInputGateAuthority;
  readonly acceptExecution: (input: {
    readonly executionId: string;
    readonly gateInputId: string;
    readonly operationKey: string;
    readonly request: unknown;
  }) => CandidateGateExecutionView;
  readonly markExecutionRunning: (
    executionId: string,
  ) => CandidateGateExecutionView;
  readonly reconcileExecution: (input: {
    readonly executionId: string;
    readonly observation:
      | { readonly state: "not-started" | "running" | "unknown" }
      | {
          readonly state: "succeeded" | "failed" | "cancelled";
          readonly fact: unknown;
          readonly receiptHash: string;
        };
  }) => CandidateGateExecutionView;
  readonly view: (candidateInputId: string) => {
    readonly candidateInput: DeliveryCandidateInputView;
    readonly gateInputs: readonly CandidateGateInputView[];
    readonly gateResults: readonly CandidateGateResultView[];
    readonly authority: DeliveryCandidateInputGateAuthority | null;
  };
}

export class QualityGateRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QualityGateRuntimeError";
  }
}

const SECURITY_CHECKS = [
  "permission-auth",
  "secret-reference",
  "environment-forwarding",
  "sandbox-worktree-git-boundary",
  "network-filesystem-scope",
  "dependency-supply-chain",
  "data-pii-migration-destructive-action",
  "public-api",
  "cross-application-trust",
  "sensitive-logs",
  "rollback",
  "credential-materialization",
] as const;

const OPERABILITY_CHECKS = [
  "startup-build",
  "logs-telemetry",
  "runtime-events-outbox",
  "timeout-lease",
  "retry-reconcile",
  "crash-recovery",
  "resource-exhaustion",
  "backup-restore",
  "migration-upgrade",
  "rollback",
  "cross-application-operations",
] as const;

const evidenceKindsFor = (
  kind: CandidateGateKind,
  checkId: string,
): CandidateGateCheck["requiredEvidenceKinds"] => {
  if (kind === "security") {
    if (
      checkId === "sandbox-worktree-git-boundary" ||
      checkId === "network-filesystem-scope" ||
      checkId === "rollback" ||
      checkId === "credential-materialization"
    ) {
      return ["artifact", "runtime-fact", "dynamic-analysis"];
    }
    return ["artifact", "static-analysis"];
  }
  if (
    checkId === "retry-reconcile" ||
    checkId === "crash-recovery" ||
    checkId === "backup-restore" ||
    checkId === "migration-upgrade" ||
    checkId === "rollback"
  ) {
    return ["artifact", "runtime-fact", "recovery"];
  }
  return ["artifact", "runtime-fact"];
};

const checksFor = (kind: CandidateGateKind): readonly CandidateGateCheck[] =>
  (kind === "security" ? SECURITY_CHECKS : OPERABILITY_CHECKS).map((id) => ({
    id,
    requiredEvidenceKinds: evidenceKindsFor(kind, id),
    selfAttestationSufficient: false,
  }));

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
    throw new QualityGateRuntimeError(
      "QUALITY_GATE_DATA_INVALID",
      `${label} is invalid JSON: ${String(error)}`,
    );
  }
};

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort();

const riskRank: Readonly<Record<CandidateRiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const depthFor = (tier: CandidateRiskTier): CandidateGateReviewDepth => {
  switch (tier) {
    case "low":
      return "lightweight";
    case "medium":
      return "targeted";
    case "high":
      return "deep-independent";
    case "critical":
      return "deep-independent-escalated";
  }
};

const validateRisk = (
  candidate: DeliveryCandidateInputView,
  expectedRiskTier: CandidateRiskTier,
): void => {
  const factorFloor = candidate.manifest.risk.factors
    .filter((factor) => factor.present)
    .reduce<CandidateRiskTier>(
      (tier, factor) =>
        riskRank[factor.minimumTier] > riskRank[tier]
          ? factor.minimumTier
          : tier,
      "low",
    );
  if (
    candidate.manifest.risk.tier !== expectedRiskTier ||
    riskRank[candidate.manifest.risk.tier] < riskRank[factorFloor]
  ) {
    throw new QualityGateRuntimeError(
      "QUALITY_GATE_RISK_CONFLICT",
      `Quality Gate expected ${expectedRiskTier} risk but exact Candidate Input requires at least ${factorFloor} and records ${candidate.manifest.risk.tier}.`,
    );
  }
};

const hasExactKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function validateSucceededFact(
  fact: unknown,
  gateInput: CandidateGateInputView,
  executionId: string,
  receiptHash?: string,
): asserts fact is {
  readonly schemaVersion: 1;
  readonly gateInputId: string;
  readonly checks: readonly CandidateGateCheckOutcome[];
  readonly resolutions: readonly {
    readonly subjectType: "defect" | "obligation";
    readonly subjectId: string;
    readonly evidenceRefs: readonly string[];
  }[];
} {
  if (
    !hasExactKeys(fact, [
      "schemaVersion",
      "gateInputId",
      "checks",
      "resolutions",
    ]) ||
    fact.schemaVersion !== 1 ||
    fact.gateInputId !== gateInput.id ||
    !Array.isArray(fact.checks) ||
    !Array.isArray(fact.resolutions)
  ) {
    throw new QualityGateRuntimeError(
      "QUALITY_GATE_FACT_SCHEMA_INVALID",
      `Gate execution ${executionId} fact must use the exact succeeded-fact schema.`,
    );
  }
  const frozenRefs = new Set(gateInput.manifest.supportingEvidenceRefs);
  const evidenceAllowed = (kind: string, ref: string): boolean => {
    const exactExecutionRef =
      ref === `quality-gate-execution:${executionId}:fact` ||
      ref === `candidate-gate-execution:${executionId}:fact` ||
      (receiptHash !== undefined &&
        (ref ===
          `quality-gate-execution:${executionId}:receipt:${receiptHash}` ||
          ref ===
            `candidate-gate-execution:${executionId}:receipt:${receiptHash}`));
    if (kind === "runtime-fact" && exactExecutionRef) return true;
    if (!frozenRefs.has(ref)) return false;
    if (kind === "artifact" || kind === "static-analysis")
      return ref.startsWith("artifact-version:");
    if (kind === "runtime-fact")
      return (
        ref.startsWith("test-pass-authority:") ||
        ref.startsWith("integration-pass-authority:") ||
        ref.startsWith(`candidate-gate-execution:${executionId}:`)
      );
    if (kind === "dynamic-analysis")
      return (
        ref.startsWith("test-evidence:") || ref.startsWith("artifact-version:")
      );
    return (
      ref.startsWith("test-evidence:") ||
      ref.startsWith("test-pass-authority:") ||
      ref.startsWith("integration-pass-authority:") ||
      ref.startsWith("artifact-version:")
    );
  };
  for (const check of fact.checks) {
    if (
      !hasExactKeys(check, [
        "checkId",
        "status",
        "evidence",
        "responsibility",
      ]) ||
      typeof check.checkId !== "string" ||
      !["passed", "missing", "failed", "unknown"].includes(
        String(check.status),
      ) ||
      !Array.isArray(check.evidence) ||
      !hasExactKeys(check.responsibility, ["kind", "candidateIds"]) ||
      check.responsibility.kind !== "aggregate" ||
      !Array.isArray(check.responsibility.candidateIds) ||
      check.responsibility.candidateIds.length !== 1 ||
      check.responsibility.candidateIds[0] !==
        gateInput.manifest.candidateInput.id
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_FACT_SCHEMA_INVALID",
        `Gate execution ${executionId} contains an invalid check or responsibility record.`,
      );
    }
    for (const evidence of check.evidence) {
      if (
        !hasExactKeys(evidence, ["kind", "ref"]) ||
        typeof evidence.kind !== "string" ||
        typeof evidence.ref !== "string" ||
        ![
          "artifact",
          "runtime-fact",
          "static-analysis",
          "dynamic-analysis",
          "recovery",
        ].includes(evidence.kind) ||
        !evidenceAllowed(evidence.kind, evidence.ref)
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_EVIDENCE_REF_INVALID",
          `Gate execution ${executionId} cites an unsupported or mislabeled evidence reference (${String(evidence.kind)}:${String(evidence.ref)}).`,
        );
      }
    }
  }
  for (const resolution of fact.resolutions) {
    if (
      !hasExactKeys(resolution, ["subjectType", "subjectId", "evidenceRefs"]) ||
      !["defect", "obligation"].includes(String(resolution.subjectType)) ||
      typeof resolution.subjectId !== "string" ||
      !Array.isArray(resolution.evidenceRefs) ||
      resolution.evidenceRefs.some(
        (ref) => typeof ref !== "string" || !frozenRefs.has(ref),
      )
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_FACT_SCHEMA_INVALID",
        `Gate execution ${executionId} contains an invalid resolution record.`,
      );
    }
  }
}

const requireVerifiedHumanEscalation = (
  candidate: DeliveryCandidateInputView,
  escalation: CriticalRiskEscalationDecision | null,
): void => {
  if (
    candidate.manifest.risk.tier === "critical" &&
    (escalation?.decision !== "authorize-gate-continuation" ||
      escalation.candidateInputId !== candidate.id ||
      escalation.candidateInputHash !== candidate.manifestHash ||
      escalation.riskHash !== sha256(candidate.manifest.risk))
  ) {
    throw new QualityGateRuntimeError(
      "QUALITY_GATE_HUMAN_ESCALATION_REQUIRED",
      "Critical Candidate Gate input may be prepared for escalation, but finalization and downstream authority require a verified human escalation authority.",
    );
  }
};

export const openQualityGateRuntime = (
  database: DatabaseSync,
  options: {
    readonly candidates: Pick<CandidateInputRuntime, "inspect">;
    readonly events?: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): QualityGateRuntime => {
  const clock = options.clock ?? (() => new Date());

  const appendMutation = (input: {
    readonly type: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly candidateInputId: string;
    readonly gateInputId?: string;
    readonly qualityGateResultId?: string;
    readonly projectId: string;
    readonly runId: string;
    readonly nodeRunId?: string;
    readonly nodeAttemptId?: string;
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
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
        ...(input.nodeAttemptId ? { nodeAttemptId: input.nodeAttemptId } : {}),
        deliveryCandidateInputId: input.candidateInputId,
        commandId: context.commandId,
        ...(input.gateInputId
          ? { candidateGateInputId: input.gateInputId }
          : {}),
        ...(input.qualityGateResultId
          ? { qualityGateResultId: input.qualityGateResultId }
          : {}),
      },
      payload: input.payload,
      timestamp: input.timestamp,
    });
  };

  const readCriticalEscalation = (
    candidateInputId: string,
  ): CriticalRiskEscalationDecision | null => {
    const row = database
      .prepare(
        `SELECT id, candidate_input_id AS candidateInputId,
                candidate_input_hash AS candidateInputHash, decision,
                actor_type AS actorType, actor_id AS actorId,
                authenticated_by AS authenticatedBy, risk_json AS riskJson,
                risk_hash AS riskHash, reason,
                evidence_refs_json AS evidenceRefsJson,
                decision_hash AS decisionHash, created_at AS createdAt
           FROM candidate_critical_escalations
          WHERE candidate_input_id = ?`,
      )
      .get(candidateInputId) as
      | {
          readonly id: string;
          readonly candidateInputId: string;
          readonly candidateInputHash: string;
          readonly decision: CriticalRiskEscalationDecision["decision"];
          readonly actorType: "human";
          readonly actorId: string;
          readonly authenticatedBy: "local-session";
          readonly riskJson: string;
          readonly riskHash: string;
          readonly reason: string;
          readonly evidenceRefsJson: string;
          readonly decisionHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) return null;
    const risk = parseJson<CriticalRiskEscalationDecision["risk"]>(
      row.riskJson,
      `Critical escalation ${row.id} risk`,
    );
    const evidenceRefs = parseJson<readonly string[]>(
      row.evidenceRefsJson,
      `Critical escalation ${row.id} evidence`,
    );
    const decision = {
      id: row.id,
      candidateInputId: row.candidateInputId,
      candidateInputHash: row.candidateInputHash,
      decision: row.decision,
      actor: {
        type: row.actorType,
        id: row.actorId,
        authenticatedBy: row.authenticatedBy,
      },
      risk,
      riskHash: row.riskHash,
      reason: row.reason,
      evidenceRefs,
      createdAt: row.createdAt,
    };
    if (
      sha256(risk) !== row.riskHash ||
      sha256(decision) !== row.decisionHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_HUMAN_ESCALATION_INTEGRITY_FAILED",
        `Critical-risk escalation ${row.id} failed immutable integrity validation.`,
      );
    }
    return { ...decision, decisionHash: row.decisionHash };
  };

  const decideCriticalEscalation: QualityGateRuntime["decideCriticalEscalation"] =
    (input) => {
      if (
        input.actor.type !== "human" ||
        input.actor.authenticatedBy !== "local-session"
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_HUMAN_ESCALATION_ACTOR_INVALID",
          "Critical-risk escalation requires actor {type:'human', authenticatedBy:'local-session'}.",
        );
      }
      const candidate = options.candidates.inspect(input.candidateInputId);
      if (
        candidate.manifest.risk.tier !== "critical" ||
        candidate.manifestHash !== input.expectedCandidateInputHash
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_HUMAN_ESCALATION_INPUT_CONFLICT",
          `Delivery Candidate Input ${input.candidateInputId} is not the exact frozen critical-risk input.`,
        );
      }
      const reason = input.reason.trim();
      const evidenceRefs = uniqueSorted(
        input.evidenceRefs.map((ref) => ref.trim()),
      );
      if (
        reason.length === 0 ||
        reason.length > 4_000 ||
        evidenceRefs.length === 0 ||
        evidenceRefs.length > 64 ||
        evidenceRefs.some((ref) => ref.length === 0 || ref.length > 512)
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_HUMAN_ESCALATION_EVIDENCE_INVALID",
          "Critical-risk escalation requires a bounded reason and evidence references.",
        );
      }
      const now = clock().toISOString();
      const riskHash = sha256(candidate.manifest.risk);
      const decision = {
        id: input.escalationId,
        candidateInputId: candidate.id,
        candidateInputHash: candidate.manifestHash,
        decision: input.decision,
        actor: {
          type: input.actor.type,
          id: input.actor.id,
          authenticatedBy: input.actor.authenticatedBy,
        },
        risk: candidate.manifest.risk,
        riskHash,
        reason,
        evidenceRefs,
        createdAt: now,
      } satisfies Omit<CriticalRiskEscalationDecision, "decisionHash">;
      const decisionHash = sha256(decision);
      const existing = readCriticalEscalation(candidate.id);
      if (existing) {
        if (
          existing.id === input.escalationId &&
          existing.decisionHash === decisionHash
        ) {
          return existing;
        }
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_HUMAN_ESCALATION_EXISTS",
          `Delivery Candidate Input ${candidate.id} already has a critical-risk escalation decision.`,
        );
      }
      database
        .prepare(
          `INSERT INTO candidate_critical_escalations(
             id, candidate_input_id, candidate_input_hash, decision,
             actor_type, actor_id, authenticated_by, risk_json, risk_hash,
             reason, evidence_refs_json, decision_hash, created_at
           ) VALUES (?, ?, ?, ?, 'human', ?, 'local-session', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.escalationId,
          candidate.id,
          candidate.manifestHash,
          input.decision,
          input.actor.id,
          canonicalJson(candidate.manifest.risk),
          riskHash,
          reason,
          canonicalJson(evidenceRefs),
          decisionHash,
          now,
        );
      appendMutation({
        type:
          input.decision === "authorize-gate-continuation"
            ? "quality-gate.critical-escalation.authorized"
            : "quality-gate.critical-escalation.rejected",
        entityType: "critical-risk-escalation",
        entityId: input.escalationId,
        candidateInputId: candidate.id,
        projectId: candidate.manifest.projectId,
        runId: candidate.manifest.runId,
        payload: {
          criticalEscalationId: input.escalationId,
          deliveryCandidateInputId: candidate.id,
          candidateInputHash: candidate.manifestHash,
          decision: input.decision,
          riskTier: candidate.manifest.risk.tier,
          riskHash,
          evidenceRefs,
        },
        timestamp: now,
      });
      return readCriticalEscalation(candidate.id)!;
    };

  const inspect = (gateInputId: string): CandidateGateInputView => {
    const row = database
      .prepare(
        `SELECT id, request_id AS requestId, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, state, created_at AS createdAt,
                updated_at AS updatedAt
           FROM candidate_gate_inputs WHERE id = ?`,
      )
      .get(gateInputId) as
      | {
          readonly id: string;
          readonly requestId: string;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly state: CandidateGateInputView["state"];
          readonly createdAt: string;
          readonly updatedAt: string;
        }
      | undefined;
    if (!row) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_INPUT_NOT_FOUND",
        `Candidate Gate input ${gateInputId} was not found.`,
      );
    }
    const manifest = parseJson<CandidateGateInputManifest>(
      row.manifestJson,
      `Candidate Gate input ${gateInputId}`,
    );
    if (sha256(manifest) !== row.manifestHash) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_INPUT_HASH_MISMATCH",
        `Candidate Gate input ${gateInputId} no longer matches its immutable manifest hash.`,
      );
    }
    return {
      id: row.id,
      requestId: row.requestId,
      manifest,
      manifestHash: row.manifestHash,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const readDefects = (
    gateInputId: string,
  ): readonly CandidateGateDefectView[] =>
    database
      .prepare(
        `SELECT id, gate_input_id AS gateInputId, check_id AS checkId,
                responsibility_json AS responsibilityJson,
                evidence_json AS evidenceJson, status,
                created_at AS createdAt, closed_at AS closedAt
           FROM candidate_gate_defects WHERE gate_input_id = ?
           ORDER BY created_at, id`,
      )
      .all(gateInputId)
      .map((entry) => {
        const row = entry as {
          readonly id: string;
          readonly gateInputId: string;
          readonly checkId: string;
          readonly responsibilityJson: string;
          readonly evidenceJson: string;
          readonly status: "open" | "closed";
          readonly createdAt: string;
          readonly closedAt: string | null;
        };
        return {
          id: row.id,
          gateInputId: row.gateInputId,
          checkId: row.checkId,
          responsibility: parseJson(
            row.responsibilityJson,
            `Defect ${row.id} responsibility`,
          ),
          evidence: parseJson(row.evidenceJson, `Defect ${row.id} evidence`),
          status: row.status,
          createdAt: row.createdAt,
          closedAt: row.closedAt,
        };
      });

  const readObligations = (
    gateInputId: string,
  ): readonly CandidateGateObligationView[] =>
    database
      .prepare(
        `SELECT id, gate_input_id AS gateInputId, defect_id AS defectId,
                check_id AS checkId, description, evidence_json AS evidenceJson,
                status, created_at AS createdAt, closed_at AS closedAt
           FROM candidate_gate_obligations WHERE gate_input_id = ?
           ORDER BY created_at, id`,
      )
      .all(gateInputId)
      .map((entry) => {
        const row = entry as {
          readonly id: string;
          readonly gateInputId: string;
          readonly defectId: string | null;
          readonly checkId: string;
          readonly description: string;
          readonly evidenceJson: string;
          readonly status: "open" | "closed";
          readonly createdAt: string;
          readonly closedAt: string | null;
        };
        return {
          id: row.id,
          gateInputId: row.gateInputId,
          defectId: row.defectId,
          checkId: row.checkId,
          description: row.description,
          evidence: parseJson(
            row.evidenceJson,
            `Obligation ${row.id} evidence`,
          ),
          status: row.status,
          createdAt: row.createdAt,
          closedAt: row.closedAt,
        };
      });

  const inspectResult = (
    candidateGateResultId: string,
  ): CandidateGateResultView => {
    const row = database
      .prepare(
        `SELECT id, gate_input_id AS gateInputId,
                quality_gate_result_id AS qualityGateResultId, result,
                result_json AS resultJson, result_hash AS resultHash,
                created_at AS createdAt
           FROM candidate_gate_results WHERE id = ?`,
      )
      .get(candidateGateResultId) as
      | {
          readonly id: string;
          readonly gateInputId: string;
          readonly qualityGateResultId: string;
          readonly result: CandidateGateResultView["result"];
          readonly resultJson: string;
          readonly resultHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_RESULT_NOT_FOUND",
        `Candidate Gate result ${candidateGateResultId} was not found.`,
      );
    }
    const manifest = parseJson<CandidateGateResultManifest>(
      row.resultJson,
      `Candidate Gate result ${candidateGateResultId}`,
    );
    if (sha256(manifest) !== row.resultHash || manifest.result !== row.result) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_RESULT_HASH_MISMATCH",
        `Candidate Gate result ${candidateGateResultId} no longer matches its immutable result hash.`,
      );
    }
    return {
      id: row.id,
      gateInputId: row.gateInputId,
      qualityGateResultId: row.qualityGateResultId,
      result: row.result,
      manifest,
      resultHash: row.resultHash,
      defects: readDefects(row.gateInputId),
      obligations: readObligations(row.gateInputId),
      createdAt: row.createdAt,
    };
  };

  const readReview = (
    input: PrepareCandidateGateInput,
    candidate: DeliveryCandidateInputView,
  ) => {
    const topic = database
      .prepare(
        `SELECT project_id AS projectId, run_id AS runId, kind, manifest_json AS manifestJson,
                producer_ai_member_id AS producerAiMemberId,
                producer_position_id AS producerPositionId,
                producer_session_id AS producerSessionId
           FROM review_topics WHERE id = ?`,
      )
      .get(input.reviewTopicId) as
      | {
          readonly projectId: string;
          readonly runId: string | null;
          readonly kind: string;
          readonly manifestJson: string;
          readonly producerAiMemberId: string;
          readonly producerPositionId: string;
          readonly producerSessionId: string;
        }
      | undefined;
    const manifest = topic
      ? parseJson<{
          readonly scope?: string;
          readonly verificationSubject?: {
            readonly kind?: string;
            readonly deliveryCandidateInputId?: string;
            readonly deliveryCandidateInputHash?: string;
          };
        }>(topic.manifestJson, `Review Topic ${input.reviewTopicId}`)
      : undefined;
    if (
      !topic ||
      topic.kind !== "verification" ||
      topic.projectId !== candidate.manifest.projectId ||
      topic.runId !== candidate.manifest.runId ||
      manifest?.scope !== "verification" ||
      manifest.verificationSubject?.kind !== "candidate-final" ||
      manifest.verificationSubject.deliveryCandidateInputId !== candidate.id ||
      manifest.verificationSubject.deliveryCandidateInputHash !==
        candidate.manifestHash ||
      topic.producerAiMemberId !== candidate.manifest.producer.aiMemberId ||
      topic.producerPositionId !== candidate.manifest.producer.positionId ||
      topic.producerSessionId !== candidate.manifest.producer.sessionId
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_REVIEW_TOPIC_INVALID",
        `Review Topic ${input.reviewTopicId} is not bound to the exact Delivery Candidate Input and producer.`,
      );
    }
    const reviewer = database
      .prepare(
        `SELECT role, ai_member_id AS aiMemberId, position_id AS positionId,
                session_id AS sessionId, eligible,
                eligibility_snapshot_hash AS independenceSnapshotHash
           FROM review_participants WHERE id = ? AND topic_id = ?`,
      )
      .get(input.reviewerParticipantId, input.reviewTopicId) as
      | {
          readonly role: string;
          readonly aiMemberId: string;
          readonly positionId: string;
          readonly sessionId: string;
          readonly eligible: number;
          readonly independenceSnapshotHash: string;
        }
      | undefined;
    const forbidden = candidate.manifest.forbiddenReviewerIdentities ?? [
      { ...candidate.manifest.producer, reason: "producer" as const },
    ];
    const collides = forbidden.some(
      (identity) =>
        reviewer?.aiMemberId === identity.aiMemberId ||
        reviewer?.positionId === identity.positionId ||
        reviewer?.sessionId === identity.sessionId,
    );
    if (
      !reviewer ||
      reviewer.role !== "reviewer-participant" ||
      reviewer.eligible !== 1 ||
      collides
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_REVIEWER_NOT_INDEPENDENT",
        `Review participant ${input.reviewerParticipantId} collides with a frozen producer/coordinator/Test engineer identity on AI member, Position, or Session.`,
      );
    }
    return reviewer;
  };

  const readSource = (
    input: PrepareCandidateGateInput,
    candidate: DeliveryCandidateInputView,
  ): CandidateGateInputManifest["source"] => {
    const source = database
      .prepare(
        `SELECT nodes.run_id AS runId,
                nodes.handler_kind_id AS handlerKindId,
                nodes.status AS nodeStatus,
                nodes.attempt_count AS attemptCount,
                attempts.attempt_number AS attemptNumber,
                attempts.snapshot_revision_id AS snapshotRevisionId,
                attempts.status AS attemptStatus,
                attempts.lease_id AS leaseId,
                attempts.lease_owner AS leaseOwner,
                attempts.lease_expires_at AS leaseExpiresAt
           FROM node_runs nodes
           JOIN node_attempts attempts ON attempts.node_run_id = nodes.id
          WHERE nodes.id = ? AND attempts.id = ?`,
      )
      .get(input.nodeRunId, input.nodeAttemptId) as
      | {
          readonly runId: string;
          readonly handlerKindId: string | null;
          readonly nodeStatus: string;
          readonly attemptCount: number;
          readonly attemptNumber: number;
          readonly snapshotRevisionId: string;
          readonly attemptStatus: string;
          readonly leaseId: string | null;
          readonly leaseOwner: string | null;
          readonly leaseExpiresAt: string | null;
        }
      | undefined;
    const leaseExpiresAt = source?.leaseExpiresAt
      ? Date.parse(source.leaseExpiresAt)
      : Number.NaN;
    if (
      input.actor.type !== "runtime-worker" ||
      input.actor.authenticatedBy !== "runtime" ||
      !source ||
      source.runId !== candidate.manifest.runId ||
      source.handlerKindId !== `${input.kind}-review@1` ||
      source.nodeStatus !== "running" ||
      source.attemptStatus !== "running" ||
      source.attemptNumber !== source.attemptCount ||
      source.snapshotRevisionId !== candidate.manifest.snapshot.id ||
      !source.leaseId?.trim() ||
      source.leaseOwner !== input.actor.id ||
      !Number.isFinite(leaseExpiresAt) ||
      leaseExpiresAt <= clock().getTime()
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_SOURCE_ATTEMPT_INVALID",
        `Candidate Gate ${input.kind} source must be the exact current running ${input.kind}-review@1 Attempt held by the authenticated Runtime worker.`,
      );
    }
    return {
      runId: source.runId,
      nodeRunId: input.nodeRunId,
      nodeAttemptId: input.nodeAttemptId,
      handlerKindId: source.handlerKindId,
      attemptNumber: source.attemptNumber,
      snapshotRevisionId: source.snapshotRevisionId,
      leaseId: source.leaseId,
      workerId: input.actor.id,
    };
  };

  const prepare = (
    input: PrepareCandidateGateInput,
  ): CandidateGateInputView => {
    const candidate = options.candidates.inspect(input.candidateInputId);
    if (
      candidate.id !== input.candidateInputId ||
      candidate.manifest.candidateInputId !== input.candidateInputId ||
      candidate.manifestHash !== input.expectedCandidateInputHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_CANDIDATE_CONFLICT",
        `Candidate Gate input does not match exact Delivery Candidate Input ${input.candidateInputId}.`,
      );
    }
    validateRisk(candidate, input.expectedRiskTier);
    const source = readSource(input, candidate);
    const reviewer = readReview(input, candidate);
    if (input.priorGateInputId) {
      const prior = inspect(input.priorGateInputId);
      const priorResult = database
        .prepare(
          `SELECT result FROM candidate_gate_results WHERE gate_input_id = ?`,
        )
        .get(prior.id) as
        | { readonly result: CandidateGateResultView["result"] }
        | undefined;
      const openPriorItems = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM candidate_gate_defects
               WHERE gate_input_id = ? AND status = 'open') +
             (SELECT COUNT(*) FROM candidate_gate_obligations
               WHERE gate_input_id = ? AND status = 'open') AS count`,
        )
        .get(prior.id, prior.id) as { readonly count: number };
      if (
        prior.manifest.kind !== input.kind ||
        prior.manifest.candidateInput.id !== candidate.id ||
        prior.manifest.candidateInput.hash !== candidate.manifestHash ||
        prior.manifest.reviewer.sessionId === reviewer.sessionId ||
        !priorResult ||
        priorResult.result === "PASS" ||
        openPriorItems.count === 0
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_FRESH_REVIEW_INVALID",
          `Candidate Gate input ${input.gateInputId} is not a fresh independent re-review of unresolved input ${input.priorGateInputId}.`,
        );
      }
    }
    const checks = checksFor(input.kind);
    const catalogIdentity = {
      revisionId: `${input.kind}-gate-check-catalog@1`,
      checks,
    };
    const manifest: CandidateGateInputManifest = {
      schemaVersion: 1,
      gateInputId: input.gateInputId,
      kind: input.kind,
      candidateInput: { id: candidate.id, hash: candidate.manifestHash },
      risk: candidate.manifest.risk,
      reviewDepth: depthFor(candidate.manifest.risk.tier),
      reviewer: {
        participantId: input.reviewerParticipantId,
        aiMemberId: reviewer.aiMemberId,
        positionId: reviewer.positionId,
        sessionId: reviewer.sessionId,
        independenceSnapshotHash: reviewer.independenceSnapshotHash,
      },
      source,
      checkCatalog: {
        ...catalogIdentity,
        hash: sha256(catalogIdentity),
      },
      requiredEvidence: checks.map((check) => ({
        checkId: check.id,
        kinds: check.requiredEvidenceKinds,
      })),
      supportingEvidenceRefs: uniqueSorted([
        ...candidate.manifest.evidence.map(
          (entry) => `test-evidence:${entry.id}`,
        ),
        ...candidate.manifest.artifacts.map(
          (entry) => `artifact-version:${entry.id}`,
        ),
        ...candidate.manifest.evidence.flatMap((entry) => [
          `test-pass-authority:${entry.testRunId}`,
          ...(entry.artifactVersionId
            ? [`artifact-version:${entry.artifactVersionId}`]
            : []),
        ]),
        ...candidate.manifest.tests.map(
          (entry) => `test-pass-authority:${entry.testRunId}`,
        ),
        `integration-pass-authority:${candidate.manifest.integration.id}`,
      ]),
      snapshotRef: {
        id: candidate.manifest.snapshot.id,
        hash: candidate.manifest.snapshot.hash,
      },
      harnessSnapshotRefs: candidate.manifest.tests
        .map((entry) => ({
          id: entry.fixture.id,
          hashes: uniqueSorted(entry.fixture.scriptHashes),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      executionProfileRefs: candidate.manifest.tests
        .map((entry) => entry.executionProfile)
        .sort((left, right) => left.id.localeCompare(right.id)),
      environment: candidate.manifest.environment,
      capabilities: uniqueSorted(
        candidate.manifest.tests.flatMap((entry) => entry.capabilities),
      ),
      priorGateInputId: input.priorGateInputId ?? null,
    };
    const manifestHash = sha256(manifest);
    const requestHash = sha256(input);
    const byId = database
      .prepare(
        `SELECT id, request_hash AS requestHash, manifest_hash AS manifestHash
           FROM candidate_gate_inputs WHERE id = ? OR request_id = ?`,
      )
      .get(input.gateInputId, input.requestId) as
      | {
          readonly id: string;
          readonly requestHash: string;
          readonly manifestHash: string;
        }
      | undefined;
    if (byId) {
      if (
        byId.id === input.gateInputId &&
        byId.requestHash === requestHash &&
        byId.manifestHash === manifestHash
      ) {
        return inspect(byId.id);
      }
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_INPUT_CONFLICT",
        `Candidate Gate input ${input.gateInputId} or request ${input.requestId} already binds different authority.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO candidate_gate_inputs(
           id, request_id, candidate_input_id, candidate_input_hash, kind,
           node_run_id, node_attempt_id, review_topic_id, prior_gate_input_id,
           reviewer_position_id, reviewer_session_id, manifest_json,
           manifest_hash, request_hash, risk_tier, review_depth, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      )
      .run(
        input.gateInputId,
        input.requestId,
        candidate.id,
        candidate.manifestHash,
        input.kind,
        input.nodeRunId,
        input.nodeAttemptId,
        input.reviewTopicId,
        input.priorGateInputId ?? null,
        reviewer.positionId,
        reviewer.sessionId,
        canonicalJson(manifest),
        manifestHash,
        requestHash,
        candidate.manifest.risk.tier,
        manifest.reviewDepth,
        now,
        now,
      );
    appendMutation({
      type: "quality-gate.input.prepared",
      entityType: "candidate-gate-input",
      entityId: input.gateInputId,
      candidateInputId: candidate.id,
      gateInputId: input.gateInputId,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      nodeRunId: input.nodeRunId,
      nodeAttemptId: input.nodeAttemptId,
      payload: {
        candidateGateInputId: input.gateInputId,
        deliveryCandidateInputId: candidate.id,
        kind: input.kind,
        manifestHash,
        riskTier: candidate.manifest.risk.tier,
        reviewDepth: manifest.reviewDepth,
      },
      timestamp: now,
    });
    return inspect(input.gateInputId);
  };

  const finalize: QualityGateRuntime["finalize"] = (input) => {
    const gateInput = inspect(input.gateInputId);
    const candidateForEscalation = options.candidates.inspect(
      gateInput.manifest.candidateInput.id,
    );
    requireVerifiedHumanEscalation(
      candidateForEscalation,
      readCriticalEscalation(candidateForEscalation.id),
    );
    const gateInputRow = database
      .prepare(
        `SELECT review_topic_id AS reviewTopicId FROM candidate_gate_inputs
          WHERE id = ?`,
      )
      .get(input.gateInputId) as { readonly reviewTopicId: string };
    const execution = database
      .prepare(
        `SELECT state, fact_hash AS factHash, receipt_hash AS receiptHash
           FROM candidate_gate_executions WHERE id = ? AND gate_input_id = ?`,
      )
      .get(input.executionId, input.gateInputId) as
      | {
          readonly state: string;
          readonly factHash: string | null;
          readonly receiptHash: string | null;
        }
      | undefined;
    const factRow = database
      .prepare(
        `SELECT fact_json AS factJson, fact_hash AS factHash
           FROM candidate_gate_execution_facts WHERE execution_id = ?`,
      )
      .get(input.executionId) as
      | { readonly factJson: string; readonly factHash: string }
      | undefined;
    if (
      !execution ||
      execution.state !== "succeeded" ||
      !execution.factHash ||
      !execution.receiptHash ||
      !factRow ||
      factRow.factHash !== execution.factHash ||
      sha256(factRow.factJson) !== factRow.factHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_NOT_TERMINAL",
        `Gate execution ${input.executionId} does not have one exact succeeded fact and receipt.`,
      );
    }
    const fact = parseJson<{
      readonly schemaVersion: 1;
      readonly gateInputId: string;
      readonly checks: readonly CandidateGateCheckOutcome[];
      readonly resolutions?: readonly {
        readonly subjectType: "defect" | "obligation";
        readonly subjectId: string;
        readonly evidenceRefs: readonly string[];
      }[];
    }>(factRow.factJson, `Gate execution ${input.executionId} fact`);
    validateSucceededFact(
      fact,
      gateInput,
      input.executionId,
      execution.receiptHash,
    );
    const expectedCheckIds = gateInput.manifest.checkCatalog.checks.map(
      (check) => check.id,
    );
    if (
      fact.schemaVersion !== 1 ||
      fact.gateInputId !== input.gateInputId ||
      fact.checks.length !== expectedCheckIds.length ||
      uniqueSorted(fact.checks.map((check) => check.checkId)).join("\0") !==
        uniqueSorted(expectedCheckIds).join("\0")
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_FACT_CATALOG_INCOMPLETE",
        `Gate execution ${input.executionId} does not cover the exact frozen check catalog.`,
      );
    }
    if (fact.checks.some((check) => check.status === "unknown")) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_UNKNOWN",
        `Gate execution ${input.executionId} is unknown and cannot create a synthetic result.`,
      );
    }
    const effectiveChecks = gateInput.manifest.checkCatalog.checks.map(
      (required) => {
        const actual = fact.checks.find(
          (check) => check.checkId === required.id,
        )!;
        const evidenceKinds = new Set(
          actual.evidence.map((entry) => entry.kind),
        );
        const evidenceComplete = required.requiredEvidenceKinds.every((kind) =>
          evidenceKinds.has(kind),
        );
        return actual.status === "passed" && !evidenceComplete
          ? { ...actual, status: "missing" as const }
          : actual;
      },
    );
    const qualityGate = database
      .prepare(
        `SELECT topic_id AS topicId, kind, manifest_json AS manifestJson,
                manifest_hash AS manifestHash, result,
                conditions_json AS conditionsJson,
                evidence_refs_json AS evidenceRefsJson
           FROM quality_gate_results WHERE id = ?`,
      )
      .get(input.qualityGateResultId) as
      | {
          readonly topicId: string;
          readonly kind: string;
          readonly manifestJson: string;
          readonly manifestHash: string;
          readonly result: "PASS" | "CONDITIONAL_PASS" | "FAIL";
          readonly conditionsJson: string;
          readonly evidenceRefsJson: string;
        }
      | undefined;
    if (
      !qualityGate ||
      qualityGate.topicId !== gateInputRow.reviewTopicId ||
      qualityGate.kind !== "verification" ||
      sha256(qualityGate.manifestJson) !== qualityGate.manifestHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_REVIEW_RESULT_INVALID",
        `Quality Gate Result ${input.qualityGateResultId} is not the exact generic Review result for this input.`,
      );
    }
    const findings = database
      .prepare(
        `SELECT findings.id, findings.severity, findings.blocking,
                findings.evidence_refs_json AS evidenceRefsJson,
                (SELECT disposition FROM review_resolutions resolutions
                  WHERE resolutions.finding_id = findings.id
                  ORDER BY resolutions.created_at DESC, resolutions.id DESC
                  LIMIT 1) AS disposition
           FROM review_findings findings WHERE findings.topic_id = ?
          ORDER BY findings.created_at, findings.id`,
      )
      .all(gateInputRow.reviewTopicId) as Array<{
      readonly id: string;
      readonly severity: "info" | "low" | "medium" | "high" | "critical";
      readonly blocking: number;
      readonly evidenceRefsJson: string;
      readonly disposition:
        | "accepted"
        | "disputed"
        | "resolved"
        | "rejected"
        | null;
    }>;
    const openFindings = findings.filter(
      (finding) =>
        finding.disposition !== "resolved" &&
        finding.disposition !== "rejected",
    );
    const criticalFinding = openFindings.some(
      (finding) =>
        finding.blocking === 1 ||
        finding.severity === "critical" ||
        finding.severity === "high",
    );
    const conditionalFinding = openFindings.some(
      (finding) =>
        finding.blocking === 0 &&
        finding.severity !== "critical" &&
        finding.severity !== "high",
    );
    const failedCheck = effectiveChecks.some(
      (check) => check.status === "failed",
    );
    const missingCheck = effectiveChecks.some(
      (check) => check.status === "missing",
    );
    const result: CandidateGateResultView["result"] =
      criticalFinding || failedCheck || qualityGate.result === "FAIL"
        ? "FAIL"
        : conditionalFinding ||
            missingCheck ||
            qualityGate.result === "CONDITIONAL_PASS"
          ? "CONDITIONAL_PASS"
          : "PASS";
    const priorOpenDefects = gateInput.manifest.priorGateInputId
      ? readDefects(gateInput.manifest.priorGateInputId).filter(
          (entry) => entry.status === "open",
        )
      : [];
    const priorOpenObligations = gateInput.manifest.priorGateInputId
      ? readObligations(gateInput.manifest.priorGateInputId).filter(
          (entry) => entry.status === "open",
        )
      : [];
    const resolutions = fact.resolutions ?? [];
    if (result === "PASS" && gateInput.manifest.priorGateInputId) {
      const expectedResolutions = [
        ...priorOpenDefects.map((entry) => `defect:${entry.id}`),
        ...priorOpenObligations.map((entry) => `obligation:${entry.id}`),
      ].sort();
      const actualResolutions = resolutions
        .map((entry) => `${entry.subjectType}:${entry.subjectId}`)
        .sort();
      if (
        actualResolutions.join("\0") !== expectedResolutions.join("\0") ||
        resolutions.some((entry) => entry.evidenceRefs.length === 0)
      ) {
        throw new QualityGateRuntimeError(
          "QUALITY_GATE_REVIEW_RESOLUTION_INCOMPLETE",
          `Fresh PASS ${input.candidateGateResultId} must resolve every prior open Defect and obligation with evidence.`,
        );
      }
    }
    const conditions = parseJson<readonly string[]>(
      qualityGate.conditionsJson,
      `Quality Gate Result ${input.qualityGateResultId} conditions`,
    );
    const evidenceRefs = uniqueSorted([
      ...parseJson<readonly string[]>(
        qualityGate.evidenceRefsJson,
        `Quality Gate Result ${input.qualityGateResultId} evidence`,
      ),
      ...effectiveChecks.flatMap((check) =>
        check.evidence.map((entry) => entry.ref),
      ),
      ...openFindings.flatMap((finding) =>
        parseJson<readonly string[]>(
          finding.evidenceRefsJson,
          `Review Finding ${finding.id} evidence`,
        ),
      ),
    ]);
    const manifest: CandidateGateResultManifest = {
      schemaVersion: 1,
      gateInputId: gateInput.id,
      gateInputHash: gateInput.manifestHash,
      candidateInput: gateInput.manifest.candidateInput,
      execution: {
        id: input.executionId,
        factHash: execution.factHash,
        receiptHash: execution.receiptHash,
      },
      review: {
        topicId: gateInputRow.reviewTopicId,
        qualityGateResultId: input.qualityGateResultId,
        manifestHash: qualityGate.manifestHash,
        result: qualityGate.result,
      },
      result,
      checks: effectiveChecks,
      findingIds: findings.map((finding) => finding.id),
      conditions,
      evidenceRefs,
    };
    const resultHash = sha256(manifest);
    const existing = database
      .prepare(
        `SELECT id, result_hash AS resultHash FROM candidate_gate_results
          WHERE id = ? OR gate_input_id = ?`,
      )
      .get(input.candidateGateResultId, input.gateInputId) as
      | { readonly id: string; readonly resultHash: string }
      | undefined;
    if (existing) {
      if (
        existing.id === input.candidateGateResultId &&
        existing.resultHash === resultHash
      ) {
        return inspectResult(existing.id);
      }
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_RESULT_CONFLICT",
        `Candidate Gate input ${input.gateInputId} already has a different immutable result.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO candidate_gate_results(
           id, gate_input_id, quality_gate_result_id, result, result_json,
           result_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.candidateGateResultId,
        input.gateInputId,
        input.qualityGateResultId,
        result,
        canonicalJson(manifest),
        resultHash,
        now,
      );
    const insertDefect = database.prepare(
      `INSERT INTO candidate_gate_defects(
         id, gate_input_id, check_id, responsibility_json, evidence_json,
         status, created_at, closed_at
       ) VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)`,
    );
    for (const check of effectiveChecks.filter(
      (entry) => entry.status === "failed",
    )) {
      insertDefect.run(
        `${input.candidateGateResultId}:defect:${check.checkId}`,
        input.gateInputId,
        check.checkId,
        canonicalJson(check.responsibility),
        canonicalJson(check.evidence),
        now,
      );
    }
    for (const finding of openFindings.filter(
      (entry) =>
        entry.blocking === 1 ||
        entry.severity === "critical" ||
        entry.severity === "high",
    )) {
      insertDefect.run(
        `${input.candidateGateResultId}:defect:finding:${finding.id}`,
        input.gateInputId,
        `review-finding:${finding.id}`,
        canonicalJson({
          kind: "aggregate",
          candidateIds: [gateInput.manifest.candidateInput.id],
        }),
        canonicalJson(
          parseJson(
            finding.evidenceRefsJson,
            `Review Finding ${finding.id} evidence`,
          ),
        ),
        now,
      );
    }
    const insertObligation = database.prepare(
      `INSERT INTO candidate_gate_obligations(
         id, gate_input_id, defect_id, check_id, description, evidence_json,
         status, created_at, closed_at
       ) VALUES (?, ?, NULL, ?, ?, ?, 'open', ?, NULL)`,
    );
    for (const check of effectiveChecks.filter(
      (entry) => entry.status === "missing",
    )) {
      insertObligation.run(
        `${input.candidateGateResultId}:obligation:${check.checkId}`,
        input.gateInputId,
        check.checkId,
        `Provide every required evidence kind for ${check.checkId} and complete a fresh independent re-review.`,
        canonicalJson(check.evidence),
        now,
      );
    }
    for (const finding of openFindings.filter(
      (entry) =>
        entry.blocking === 0 &&
        entry.severity !== "critical" &&
        entry.severity !== "high",
    )) {
      insertObligation.run(
        `${input.candidateGateResultId}:obligation:finding:${finding.id}`,
        input.gateInputId,
        `review-finding:${finding.id}`,
        `Resolve or reject lower-severity Review Finding ${finding.id} with a fresh independent re-review.`,
        canonicalJson(
          parseJson(
            finding.evidenceRefsJson,
            `Review Finding ${finding.id} evidence`,
          ),
        ),
        now,
      );
    }
    conditions.forEach((condition, index) => {
      insertObligation.run(
        `${input.candidateGateResultId}:obligation:review:${index + 1}`,
        input.gateInputId,
        `review-condition:${index + 1}`,
        condition,
        canonicalJson({ qualityGateResultId: input.qualityGateResultId }),
        now,
      );
    });
    if (result === "PASS" && gateInput.manifest.priorGateInputId) {
      for (const resolution of resolutions) {
        if (resolution.subjectType === "obligation") {
          database
            .prepare(
              `INSERT INTO candidate_gate_obligation_resolutions(
                 id, obligation_id, fresh_gate_input_id, evidence_json,
                 resolution_hash, created_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `${input.candidateGateResultId}:resolution:${resolution.subjectId}`,
              resolution.subjectId,
              gateInput.id,
              canonicalJson(resolution.evidenceRefs),
              sha256({
                obligationId: resolution.subjectId,
                freshGateInputId: gateInput.id,
                evidenceRefs: resolution.evidenceRefs,
              }),
              now,
            );
          database
            .prepare(
              `UPDATE candidate_gate_obligations
                  SET status = 'closed', closed_at = ? WHERE id = ?`,
            )
            .run(now, resolution.subjectId);
        } else {
          database
            .prepare(
              `INSERT INTO candidate_gate_defect_resolutions(
                 id, defect_id, fresh_gate_input_id, evidence_json,
                 resolution_hash, created_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `${input.candidateGateResultId}:resolution:${resolution.subjectId}`,
              resolution.subjectId,
              gateInput.id,
              canonicalJson(resolution.evidenceRefs),
              sha256({
                defectId: resolution.subjectId,
                freshGateInputId: gateInput.id,
                evidenceRefs: resolution.evidenceRefs,
              }),
              now,
            );
          database
            .prepare(
              `UPDATE candidate_gate_defects
                  SET status = 'closed', closed_at = ? WHERE id = ?`,
            )
            .run(now, resolution.subjectId);
        }
      }
    }
    database
      .prepare(
        `UPDATE candidate_gate_inputs
            SET state = 'completed', updated_at = ? WHERE id = ?`,
      )
      .run(now, input.gateInputId);
    const candidate = options.candidates.inspect(
      gateInput.manifest.candidateInput.id,
    );
    appendMutation({
      type: "quality-gate.result.recorded",
      entityType: "candidate-gate-result",
      entityId: input.candidateGateResultId,
      candidateInputId: candidate.id,
      gateInputId: gateInput.id,
      qualityGateResultId: input.qualityGateResultId,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      payload: {
        candidateGateInputId: gateInput.id,
        candidateGateResultId: input.candidateGateResultId,
        qualityGateResultId: input.qualityGateResultId,
        result,
        resultHash,
      },
      timestamp: now,
    });
    return inspectResult(input.candidateGateResultId);
  };

  const readAuthority = (
    candidateInputId: string,
  ): DeliveryCandidateInputGateAuthority => {
    const row = database
      .prepare(
        `SELECT id, authority_json AS authorityJson,
                authority_hash AS authorityHash, created_at AS createdAt
           FROM delivery_candidate_input_authorities WHERE candidate_input_id = ?`,
      )
      .get(candidateInputId) as
      | {
          readonly id: string;
          readonly authorityJson: string;
          readonly authorityHash: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_DOWNSTREAM_AUTHORITY_NOT_FOUND",
        `Delivery Candidate Input ${candidateInputId} has no dual-Gate PASS authority.`,
      );
    }
    const stored = parseJson<
      Omit<DeliveryCandidateInputGateAuthority, "authorityHash" | "createdAt">
    >(
      row.authorityJson,
      `Delivery Candidate Input ${candidateInputId} Gate authority`,
    );
    if (sha256(stored) !== row.authorityHash) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_DOWNSTREAM_AUTHORITY_HASH_MISMATCH",
        `Delivery Candidate Input ${candidateInputId} Gate authority is not immutable.`,
      );
    }
    return {
      ...stored,
      authorityHash: row.authorityHash,
      createdAt: row.createdAt,
    };
  };

  const ensureNoOpenItems = (candidateInputId: string): void => {
    const open = database
      .prepare(
        `SELECT
           (SELECT COUNT(*)
              FROM candidate_gate_defects defects
              JOIN candidate_gate_inputs inputs ON inputs.id = defects.gate_input_id
             WHERE inputs.candidate_input_id = ? AND defects.status = 'open') +
           (SELECT COUNT(*)
              FROM candidate_gate_obligations obligations
              JOIN candidate_gate_inputs inputs ON inputs.id = obligations.gate_input_id
             WHERE inputs.candidate_input_id = ? AND obligations.status = 'open') AS count`,
      )
      .get(candidateInputId, candidateInputId) as { readonly count: number };
    if (open.count > 0) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_DOWNSTREAM_BLOCKED",
        `Delivery Candidate Input ${candidateInputId} still has open Gate Defects or obligations.`,
      );
    }
  };

  const exactPass = (
    resultId: string,
    kind: CandidateGateKind,
    candidate: DeliveryCandidateInputView,
  ) => {
    const result = inspectResult(resultId);
    const gateInput = inspect(result.gateInputId);
    if (
      result.result !== "PASS" ||
      gateInput.manifest.kind !== kind ||
      gateInput.manifest.candidateInput.id !== candidate.id ||
      gateInput.manifest.candidateInput.hash !== candidate.manifestHash ||
      result.manifest.candidateInput.id !== candidate.id ||
      result.manifest.candidateInput.hash !== candidate.manifestHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_DOWNSTREAM_BLOCKED",
        `${kind} Gate result ${resultId} is not an exact PASS for Delivery Candidate Input ${candidate.id}.`,
      );
    }
    return { result, gateInput };
  };

  const authorize: QualityGateRuntime["authorize"] = (input) => {
    const candidate = options.candidates.inspect(input.candidateInputId);
    requireVerifiedHumanEscalation(
      candidate,
      readCriticalEscalation(candidate.id),
    );
    if (
      candidate.id !== input.candidateInputId ||
      candidate.manifestHash !== input.expectedCandidateInputHash
    ) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_CANDIDATE_CONFLICT",
        `Delivery Candidate Input ${input.candidateInputId} changed before Gate authority materialization.`,
      );
    }
    ensureNoOpenItems(candidate.id);
    const security = exactPass(
      input.securityGateResultId,
      "security",
      candidate,
    );
    const operability = exactPass(
      input.operabilityGateResultId,
      "operability",
      candidate,
    );
    const authority = {
      id: input.authorityId,
      candidateInputId: candidate.id,
      candidateInputHash: candidate.manifestHash,
      security: {
        gateInputId: security.gateInput.id,
        gateInputHash: security.gateInput.manifestHash,
        resultId: security.result.id,
        resultHash: security.result.resultHash,
        qualityGateResultId: security.result.qualityGateResultId,
      },
      operability: {
        gateInputId: operability.gateInput.id,
        gateInputHash: operability.gateInput.manifestHash,
        resultId: operability.result.id,
        resultHash: operability.result.resultHash,
        qualityGateResultId: operability.result.qualityGateResultId,
      },
      risk: candidate.manifest.risk,
      evidenceRefs: uniqueSorted([
        ...security.result.manifest.evidenceRefs,
        ...operability.result.manifest.evidenceRefs,
      ]),
    };
    const authorityHash = sha256(authority);
    const existing = database
      .prepare(
        `SELECT id, authority_hash AS authorityHash
           FROM delivery_candidate_input_authorities
          WHERE id = ? OR candidate_input_id = ?`,
      )
      .get(input.authorityId, candidate.id) as
      | { readonly id: string; readonly authorityHash: string }
      | undefined;
    if (existing) {
      if (
        existing.id === input.authorityId &&
        existing.authorityHash === authorityHash
      ) {
        return readAuthority(candidate.id);
      }
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_DOWNSTREAM_AUTHORITY_CONFLICT",
        `Delivery Candidate Input ${candidate.id} already binds different Gate authority.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO delivery_candidate_input_authorities(
           id, candidate_input_id, security_gate_result_id,
           operability_gate_result_id, authority_json, authority_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.authorityId,
        candidate.id,
        security.result.id,
        operability.result.id,
        canonicalJson(authority),
        authorityHash,
        now,
      );
    appendMutation({
      type: "delivery.candidate-input.authorized",
      entityType: "delivery-candidate-input-authority",
      entityId: input.authorityId,
      candidateInputId: candidate.id,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      payload: {
        deliveryCandidateInputId: candidate.id,
        authorityId: input.authorityId,
        authorityHash,
        securityGateResultId: security.result.id,
        operabilityGateResultId: operability.result.id,
      },
      timestamp: now,
    });
    return readAuthority(candidate.id);
  };

  const downstreamAuthority: QualityGateRuntime["downstreamAuthority"] = (
    candidateInputId,
  ) => {
    const candidate = options.candidates.inspect(candidateInputId);
    requireVerifiedHumanEscalation(
      candidate,
      readCriticalEscalation(candidate.id),
    );
    ensureNoOpenItems(candidateInputId);
    const authority = readAuthority(candidateInputId);
    if (candidate.manifestHash !== authority.candidateInputHash) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_CANDIDATE_CONFLICT",
        `Delivery Candidate Input ${candidateInputId} changed after Gate authority materialization.`,
      );
    }
    exactPass(authority.security.resultId, "security", candidate);
    exactPass(authority.operability.resultId, "operability", candidate);
    return authority;
  };

  const inspectExecution = (
    executionId: string,
  ): CandidateGateExecutionView => {
    const row = database
      .prepare(
        `SELECT id, gate_input_id AS gateInputId, operation_key AS operationKey,
                request_json AS requestJson, request_hash AS requestHash, state,
                fact_hash AS factHash, receipt_hash AS receiptHash,
                created_at AS createdAt, updated_at AS updatedAt
           FROM candidate_gate_executions WHERE id = ?`,
      )
      .get(executionId) as
      | {
          readonly id: string;
          readonly gateInputId: string;
          readonly operationKey: string;
          readonly requestJson: string;
          readonly requestHash: string;
          readonly state: CandidateGateExecutionView["state"];
          readonly factHash: string | null;
          readonly receiptHash: string | null;
          readonly createdAt: string;
          readonly updatedAt: string;
        }
      | undefined;
    if (!row || sha256(row.requestJson) !== row.requestHash) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_NOT_FOUND",
        `Candidate Gate execution ${executionId} was not found with an intact request.`,
      );
    }
    return {
      id: row.id,
      gateInputId: row.gateInputId,
      operationKey: row.operationKey,
      request: parseJson(
        row.requestJson,
        `Gate execution ${executionId} request`,
      ),
      requestHash: row.requestHash,
      state: row.state,
      factHash: row.factHash,
      receiptHash: row.receiptHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const acceptExecution: QualityGateRuntime["acceptExecution"] = (input) => {
    inspect(input.gateInputId);
    const requestJson = canonicalJson(input.request);
    const requestHash = sha256(requestJson);
    const existing = database
      .prepare(
        `SELECT id, gate_input_id AS gateInputId, operation_key AS operationKey,
                request_hash AS requestHash
           FROM candidate_gate_executions WHERE id = ? OR operation_key = ?`,
      )
      .get(input.executionId, input.operationKey) as
      | {
          readonly id: string;
          readonly gateInputId: string;
          readonly operationKey: string;
          readonly requestHash: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.id === input.executionId &&
        existing.gateInputId === input.gateInputId &&
        existing.operationKey === input.operationKey &&
        existing.requestHash === requestHash
      ) {
        return inspectExecution(existing.id);
      }
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_CONFLICT",
        `Gate execution ${input.executionId} or operation ${input.operationKey} already binds a different request.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `INSERT INTO candidate_gate_executions(
           id, gate_input_id, operation_key, request_json, request_hash, state,
           fact_hash, receipt_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'intent', NULL, NULL, ?, ?)`,
      )
      .run(
        input.executionId,
        input.gateInputId,
        input.operationKey,
        requestJson,
        requestHash,
        now,
        now,
      );
    const gateInput = inspect(input.gateInputId);
    const candidate = options.candidates.inspect(
      gateInput.manifest.candidateInput.id,
    );
    appendMutation({
      type: "quality-gate.execution.accepted",
      entityType: "candidate-gate-execution",
      entityId: input.executionId,
      candidateInputId: candidate.id,
      gateInputId: gateInput.id,
      projectId: candidate.manifest.projectId,
      runId: candidate.manifest.runId,
      payload: {
        candidateGateInputId: gateInput.id,
        executionId: input.executionId,
        operationKey: input.operationKey,
        requestHash,
        state: "intent",
      },
      timestamp: now,
    });
    return inspectExecution(input.executionId);
  };

  const markExecutionRunning: QualityGateRuntime["markExecutionRunning"] = (
    executionId,
  ) => {
    const execution = inspectExecution(executionId);
    if (execution.state === "running") return execution;
    if (execution.state !== "intent") {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_STATE_CONFLICT",
        `Gate execution ${executionId} cannot start from ${execution.state}.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE candidate_gate_executions
            SET state = 'running', updated_at = ? WHERE id = ?`,
      )
      .run(now, executionId);
    database
      .prepare(
        `UPDATE candidate_gate_inputs
            SET state = 'running', updated_at = ? WHERE id = ?`,
      )
      .run(now, execution.gateInputId);
    return inspectExecution(executionId);
  };

  const reconcileExecution: QualityGateRuntime["reconcileExecution"] = (
    input,
  ) => {
    const execution = inspectExecution(input.executionId);
    const terminalObservation =
      input.observation.state === "succeeded" ||
      input.observation.state === "failed" ||
      input.observation.state === "cancelled"
        ? input.observation
        : null;
    if (
      execution.state === "succeeded" ||
      execution.state === "failed" ||
      execution.state === "cancelled"
    ) {
      if (
        terminalObservation?.state === execution.state &&
        execution.factHash ===
          sha256(canonicalJson(terminalObservation.fact)) &&
        execution.receiptHash === terminalObservation.receiptHash
      ) {
        return execution;
      }
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_TERMINAL_CONFLICT",
        `Terminal Gate execution ${input.executionId} cannot accept conflicting reconciliation evidence.`,
      );
    }
    const now = clock().toISOString();
    const appendReconciliation = (input: {
      readonly state: CandidateGateExecutionView["state"];
      readonly factHash?: string;
      readonly receiptHash?: string;
    }): void => {
      const gateInput = inspect(execution.gateInputId);
      const candidate = options.candidates.inspect(
        gateInput.manifest.candidateInput.id,
      );
      appendMutation({
        type: "quality-gate.execution.reconciled",
        entityType: "candidate-gate-execution",
        entityId: execution.id,
        candidateInputId: candidate.id,
        gateInputId: gateInput.id,
        projectId: candidate.manifest.projectId,
        runId: candidate.manifest.runId,
        payload: {
          candidateGateInputId: gateInput.id,
          executionId: execution.id,
          state: input.state,
          ...(input.factHash ? { factHash: input.factHash } : {}),
          ...(input.receiptHash ? { receiptHash: input.receiptHash } : {}),
        },
        timestamp: now,
      });
    };
    if (input.observation.state === "unknown") {
      database
        .prepare(
          `UPDATE candidate_gate_executions
              SET state = 'unknown', fact_hash = NULL, receipt_hash = NULL,
                  updated_at = ? WHERE id = ?`,
        )
        .run(now, input.executionId);
      database
        .prepare(
          `UPDATE candidate_gate_inputs
              SET state = 'unknown', updated_at = ? WHERE id = ?`,
        )
        .run(now, execution.gateInputId);
      appendReconciliation({ state: "unknown" });
      return inspectExecution(input.executionId);
    }
    if (input.observation.state === "not-started") {
      database
        .prepare(
          `UPDATE candidate_gate_executions
              SET state = 'intent', fact_hash = NULL, receipt_hash = NULL,
                  updated_at = ? WHERE id = ?`,
        )
        .run(now, input.executionId);
      database
        .prepare(
          `UPDATE candidate_gate_inputs
              SET state = 'scheduled', updated_at = ? WHERE id = ?`,
        )
        .run(now, execution.gateInputId);
      appendReconciliation({ state: "intent" });
      return inspectExecution(input.executionId);
    }
    if (input.observation.state === "running") {
      database
        .prepare(
          `UPDATE candidate_gate_executions
              SET state = 'reconciling', updated_at = ? WHERE id = ?`,
        )
        .run(now, input.executionId);
      database
        .prepare(
          `UPDATE candidate_gate_inputs
              SET state = 'reconciling', updated_at = ? WHERE id = ?`,
        )
        .run(now, execution.gateInputId);
      appendReconciliation({ state: "reconciling" });
      return inspectExecution(input.executionId);
    }
    if (!terminalObservation) {
      throw new QualityGateRuntimeError(
        "QUALITY_GATE_EXECUTION_STATE_CONFLICT",
        `Gate execution ${input.executionId} has an unsupported reconciliation observation.`,
      );
    }
    if (terminalObservation.state === "succeeded") {
      const gateInput = inspect(execution.gateInputId);
      validateSucceededFact(
        terminalObservation.fact,
        gateInput,
        input.executionId,
        terminalObservation.receiptHash,
      );
    }
    const factJson = canonicalJson(terminalObservation.fact);
    const factHash = sha256(factJson);
    database
      .prepare(
        `INSERT INTO candidate_gate_execution_facts(
           execution_id, fact_json, fact_hash, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(input.executionId, factJson, factHash, now);
    database
      .prepare(
        `UPDATE candidate_gate_executions
            SET state = ?, fact_hash = ?, receipt_hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        terminalObservation.state,
        factHash,
        terminalObservation.receiptHash,
        now,
        input.executionId,
      );
    if (terminalObservation.state !== "succeeded") {
      database
        .prepare(
          `UPDATE candidate_gate_inputs
              SET state = 'blocked', updated_at = ? WHERE id = ?`,
        )
        .run(now, execution.gateInputId);
    }
    appendReconciliation({
      state: terminalObservation.state,
      factHash,
      receiptHash: terminalObservation.receiptHash,
    });
    return inspectExecution(input.executionId);
  };

  const view: QualityGateRuntime["view"] = (candidateInputId) => {
    const candidateInput = options.candidates.inspect(candidateInputId);
    const gateInputIds = (
      database
        .prepare(
          `SELECT id FROM candidate_gate_inputs WHERE candidate_input_id = ?
            ORDER BY created_at, id`,
        )
        .all(candidateInputId) as Array<{ readonly id: string }>
    ).map((row) => row.id);
    const resultIds = (
      database
        .prepare(
          `SELECT results.id
             FROM candidate_gate_results results
             JOIN candidate_gate_inputs inputs ON inputs.id = results.gate_input_id
            WHERE inputs.candidate_input_id = ?
            ORDER BY results.created_at, results.id`,
        )
        .all(candidateInputId) as Array<{ readonly id: string }>
    ).map((row) => row.id);
    let authority: DeliveryCandidateInputGateAuthority | null = null;
    try {
      authority = readAuthority(candidateInputId);
    } catch (error) {
      if (
        !(error instanceof QualityGateRuntimeError) ||
        error.code !== "QUALITY_GATE_DOWNSTREAM_AUTHORITY_NOT_FOUND"
      ) {
        throw error;
      }
    }
    return {
      candidateInput,
      gateInputs: gateInputIds.map(inspect),
      gateResults: resultIds.map(inspectResult),
      authority,
    };
  };

  return {
    decideCriticalEscalation,
    prepare,
    inspect,
    finalize,
    inspectResult,
    authorize,
    downstreamAuthority,
    acceptExecution,
    markExecutionRunning,
    reconcileExecution,
    view,
  };
};
