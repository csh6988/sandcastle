import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().trim().min(1);
const TimestampSchema = z.string().datetime();
const ReasonSchema = z.string().trim().min(1).max(4_000);
const EvidenceRefsSchema = z.array(IdSchema.max(512)).min(1).max(64);

const VerifiedLocalSessionHumanSchema = z
  .object({
    type: z.literal("human"),
    id: IdSchema,
    authenticatedBy: z.literal("local-session"),
  })
  .strict();

/**
 * The Runtime worker that produced an Improvement proposal from exact evidence.
 * Only a bound Runtime worker may author a proposal revision; the human seam is
 * reserved for the separate append-only decision.
 */
const RuntimeWorkerActorSchema = z
  .object({
    type: z.literal("runtime-worker"),
    id: IdSchema,
    authenticatedBy: z.literal("runtime"),
  })
  .strict();

export const ImprovementProposalStateSchema = z.enum([
  "draft",
  "proposed",
  "awaiting-human",
  "approved",
  "rejected",
]);
export type ImprovementProposalState = z.infer<
  typeof ImprovementProposalStateSchema
>;

export const ImprovementApplicationStateSchema = z.enum([
  "applying",
  "applied",
  "apply-failed",
  "validated",
  "rollback-requested",
  "rolled-back",
]);
export type ImprovementApplicationState = z.infer<
  typeof ImprovementApplicationStateSchema
>;

export const ImprovementTargetKindSchema = z.enum([
  "harness",
  "spec",
  "template",
  "skill-flow",
]);
export type ImprovementTargetKind = z.infer<typeof ImprovementTargetKindSchema>;

export const ImprovementProposalErrorCodeSchema = z.enum([
  "IMPROVEMENT_PROPOSAL_NOT_FOUND",
  "IMPROVEMENT_PROPOSAL_ID_REUSE",
  "IMPROVEMENT_PROPOSAL_REVISION_CONFLICT",
  "IMPROVEMENT_PROPOSAL_TERMINAL",
  "IMPROVEMENT_PROPOSAL_IDENTITY_CONFLICT",
  "IMPROVEMENT_DECISION_EXISTS",
  "IMPROVEMENT_HUMAN_DECISION_REQUIRED",
  "IMPROVEMENT_PROPOSAL_NOT_APPROVED",
  "IMPROVEMENT_APPLY_NOT_AUTHORIZED",
  "IMPROVEMENT_APPLICATION_ID_REUSE",
  "IMPROVEMENT_APPLICATION_NOT_FOUND",
  "IMPROVEMENT_TARGET_INVALID",
  "IMPROVEMENT_ROLLBACK_INVALID",
  "IMPROVEMENT_EVIDENCE_INCOMPLETE",
]);
export type ImprovementProposalErrorCode = z.infer<
  typeof ImprovementProposalErrorCodeSchema
>;

const ProposedChangeSchema = z.discriminatedUnion("targetKind", [
  z
    .object({
      targetKind: z.literal("harness"),
      targetId: IdSchema,
      currentRevisionRef: IdSchema.nullable(),
      summary: ReasonSchema,
      diffRef: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("spec"),
      targetId: IdSchema,
      currentRevisionRef: IdSchema.nullable(),
      summary: ReasonSchema,
      diffRef: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("template"),
      targetId: IdSchema,
      currentRevisionRef: IdSchema.nullable(),
      summary: ReasonSchema,
      diffRef: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("skill-flow"),
      targetId: IdSchema,
      currentRevisionRef: IdSchema.nullable(),
      summary: ReasonSchema,
      diffRef: IdSchema.optional(),
    })
    .strict(),
]);

const ExpectedMetricSchema = z
  .object({
    metric: IdSchema,
    direction: z.enum(["increase", "decrease", "hold"]),
    baselineRef: IdSchema,
  })
  .strict();

/**
 * The full evidence-backed content of one Improvement-proposal revision. It is
 * hashed and frozen per revision; evidence is modeled as abstract Run/Audit/
 * Event/Defect/Artifact refs, never a raw failure log or a hard Statistics-table
 * dependency (no Statistics module exists yet).
 */
export const ImprovementProposalRevisionContentSchema = z
  .object({
    evidenceQuery: z.string().trim().min(1).max(4_000),
    evidenceRefs: EvidenceRefsSchema,
    rootCauseHypothesis: ReasonSchema,
    proposedChange: ProposedChangeSchema,
    impactScope: z
      .object({
        departments: z.array(IdSchema).max(64),
        projects: z.array(IdSchema).max(64),
        positions: z.array(IdSchema).max(64).optional(),
      })
      .strict(),
    expectedMetrics: z.array(ExpectedMetricSchema).min(1).max(64),
    validationPlan: ReasonSchema,
    rolloutPath: ReasonSchema,
    rollbackPath: ReasonSchema,
  })
  .strict();
export type ImprovementProposalRevisionContent = z.infer<
  typeof ImprovementProposalRevisionContentSchema
>;

export const ImprovementProposalProposeRequestSchema = z
  .object({
    proposalId: IdSchema,
    revisionId: IdSchema,
    projectId: IdSchema,
    departmentId: IdSchema,
    supersedesRevisionId: IdSchema.nullable(),
    proposedBy: RuntimeWorkerActorSchema,
    content: ImprovementProposalRevisionContentSchema,
  })
  .strict();
export type ImprovementProposalProposeRequest = z.infer<
  typeof ImprovementProposalProposeRequestSchema
>;

export const ImprovementProposalProposeCommandInputSchema = z
  .object({
    proposalId: IdSchema,
    revisionId: IdSchema,
    projectId: IdSchema,
    departmentId: IdSchema,
    supersedesRevisionId: IdSchema.nullable(),
    content: ImprovementProposalRevisionContentSchema,
  })
  .strict();
export type ImprovementProposalProposeCommandInput = z.infer<
  typeof ImprovementProposalProposeCommandInputSchema
>;

export const ImprovementProposalDecisionSchema = z
  .object({
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    expectedProposalRevisionHash: Sha256Schema,
    decision: z.enum(["approved", "rejected"]),
    actor: VerifiedLocalSessionHumanSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();
export type ImprovementProposalDecision = z.infer<
  typeof ImprovementProposalDecisionSchema
>;

export const ImprovementProposalDecideCommandInputSchema = z
  .object({
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    expectedProposalRevisionHash: Sha256Schema,
    decision: z.enum(["approved", "rejected"]),
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();
export type ImprovementProposalDecideCommandInput = z.infer<
  typeof ImprovementProposalDecideCommandInputSchema
>;

export const ImprovementApplicationAuthorizationSchema = z
  .object({
    actor: VerifiedLocalSessionHumanSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementApplicationAuthorizationInputSchema = z
  .object({
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementApplicationApplyRequestSchema = z
  .object({
    applicationOperationId: IdSchema,
    proposalId: IdSchema,
    approvedDecisionId: IdSchema,
    expectedApprovedDecisionHash: Sha256Schema,
    targetKind: ImprovementTargetKindSchema,
    targetId: IdSchema,
    expectedTargetRevisionRef: IdSchema.nullable(),
    authorization: ImprovementApplicationAuthorizationSchema,
  })
  .strict();
export type ImprovementApplicationApplyRequest = z.infer<
  typeof ImprovementApplicationApplyRequestSchema
>;

export const ImprovementApplicationApplyCommandInputSchema = z
  .object({
    applicationOperationId: IdSchema,
    proposalId: IdSchema,
    approvedDecisionId: IdSchema,
    expectedApprovedDecisionHash: Sha256Schema,
    targetKind: ImprovementTargetKindSchema,
    targetId: IdSchema,
    expectedTargetRevisionRef: IdSchema.nullable(),
    authorization: ImprovementApplicationAuthorizationInputSchema,
  })
  .strict();
export type ImprovementApplicationApplyCommandInput = z.infer<
  typeof ImprovementApplicationApplyCommandInputSchema
>;

const ImprovementApplicationValidationEvidenceSchema = z
  .object({
    metric: IdSchema,
    beforeRef: IdSchema,
    afterRef: IdSchema,
    observedAt: TimestampSchema,
  })
  .strict();

/**
 * The append-only outcome of an application operation. Contracts for finalize
 * and rollback are defined now; their Runtime is deferred to a later T26 slice
 * (the foundation ships propose/decide/apply-intent only).
 */
export const ImprovementApplicationFinalizeSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("applied"),
        targetRevisionRef: IdSchema,
        validationEvidence: z
          .array(ImprovementApplicationValidationEvidenceSchema)
          .max(64),
        observedAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("apply-failed"),
        failure: z
          .object({
            code: ImprovementProposalErrorCodeSchema,
            message: ReasonSchema,
          })
          .strict(),
        observedAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("validated"),
        validationEvidence: z
          .array(ImprovementApplicationValidationEvidenceSchema)
          .min(1)
          .max(64),
        observedAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("rollback-requested"),
        reason: ReasonSchema,
        observedAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("rolled-back"),
        rollbackRevisionRef: IdSchema,
        observedAt: TimestampSchema,
      })
      .strict(),
  ],
);
export type ImprovementApplicationFinalize = z.infer<
  typeof ImprovementApplicationFinalizeSchema
>;

export const ImprovementApplicationRollbackRequestSchema = z
  .object({
    applicationOperationId: IdSchema,
    proposalId: IdSchema,
    expectedApplicationHash: Sha256Schema,
    actor: VerifiedLocalSessionHumanSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();
export type ImprovementApplicationRollbackRequest = z.infer<
  typeof ImprovementApplicationRollbackRequestSchema
>;

/**
 * The effect seam a later slice fills with a concrete Harness/Spec/template/
 * Skill-Flow revision writer. The foundation defines the interface only, exactly
 * as T22 defined `ReleaseOperationEffectAdapter` before its real adapters.
 */
export interface ImprovementApplicationEffectAdapter {
  readonly apply: (
    request: ImprovementApplicationApplyRequest,
  ) => Promise<ImprovementApplicationFinalize>;
  readonly rollback: (
    request: ImprovementApplicationRollbackRequest,
    evidenceRefs: readonly string[],
  ) => Promise<ImprovementApplicationFinalize>;
}

const ImprovementProposalRevisionViewSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    supersedesRevisionId: IdSchema.nullable(),
    content: ImprovementProposalRevisionContentSchema,
    hash: Sha256Schema,
    proposedBy: RuntimeWorkerActorSchema,
    createdAt: TimestampSchema,
  })
  .strict();

const ImprovementProposalDecisionViewSchema = z
  .object({
    id: IdSchema,
    proposalRevisionId: IdSchema,
    proposalRevisionHash: Sha256Schema,
    decision: z.enum(["approved", "rejected"]),
    decidedBy: VerifiedLocalSessionHumanSchema,
    reason: ReasonSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementApplicationOperationViewSchema = z
  .object({
    id: IdSchema,
    proposalId: IdSchema,
    approvedDecisionId: IdSchema,
    approvedDecisionHash: Sha256Schema,
    targetKind: ImprovementTargetKindSchema,
    targetId: IdSchema,
    canonicalRequestHash: Sha256Schema,
    state: ImprovementApplicationStateSchema,
    targetRevisionRef: IdSchema.nullable(),
    rollbackRevisionRef: IdSchema.nullable(),
    validationEvidence: z.array(ImprovementApplicationValidationEvidenceSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ImprovementApplicationOperationView = z.infer<
  typeof ImprovementApplicationOperationViewSchema
>;

export const ImprovementProposalNextActionSchema = z.enum([
  "revise",
  "decide",
  "apply",
  "rollback",
]);
export type ImprovementProposalNextAction = z.infer<
  typeof ImprovementProposalNextActionSchema
>;

export const ImprovementProposalViewSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    departmentId: IdSchema,
    status: ImprovementProposalStateSchema,
    revision: z.number().int().positive(),
    currentRevision: ImprovementProposalRevisionViewSchema,
    decision: ImprovementProposalDecisionViewSchema.nullable(),
    applicationOperations: z.array(ImprovementApplicationOperationViewSchema),
    nextActions: z.array(ImprovementProposalNextActionSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ImprovementProposalView = z.infer<
  typeof ImprovementProposalViewSchema
>;

/**
 * Persistence seam for the Improvement-proposal aggregates. Every mutator is
 * append-only at the storage layer; the returned Views are projections over the
 * append-only revisions, decision, and application operations. The foundation
 * defines the interface only — no concrete implementation or dispatcher wiring.
 */
export interface ImprovementProposalPersistence {
  readonly createProposalIntent: (
    input: ImprovementProposalView,
  ) => ImprovementProposalView;
  readonly appendRevision: (
    request: ImprovementProposalProposeRequest,
  ) => ImprovementProposalView;
  readonly inspect: (proposalId: string) => ImprovementProposalView;
  readonly list: (input: {
    readonly projectId?: string;
    readonly departmentId?: string;
  }) => readonly ImprovementProposalView[];
  readonly recordDecision: (
    decision: ImprovementProposalDecision,
  ) => ImprovementProposalView;
  readonly createApplicationIntent: (
    request: ImprovementApplicationApplyRequest,
  ) => ImprovementApplicationOperationView;
  readonly finalizeApplication: (input: {
    readonly applicationOperationId: string;
    readonly result: ImprovementApplicationFinalize;
  }) => ImprovementApplicationOperationView;
  readonly rollbackApplication: (input: {
    readonly request: ImprovementApplicationRollbackRequest;
    readonly result: ImprovementApplicationFinalize;
  }) => ImprovementApplicationOperationView;
}
