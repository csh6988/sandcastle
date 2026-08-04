import { z } from "zod";
import {
  StatisticsAuthorActorSchema,
  StatisticsEvidenceSnapshotViewSchema,
  StatisticsEvidenceValidationOutcomeSchema,
  StatisticsMetricIdSchema,
  type StatisticsEvidenceSnapshotView,
} from "../statistics/statisticsContracts.js";

const IdSchema = z.string().trim().min(1).max(512);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime();
const ReasonSchema = z.string().trim().min(1).max(4_000);
const EvidenceRefsSchema = z.array(IdSchema).min(1).max(64);

export const VerifiedLocalSessionHumanSchema = z
  .object({
    type: z.literal("human"),
    id: IdSchema,
    authenticatedBy: z.literal("local-session"),
  })
  .strict();

export const TrustedRuntimeWorkerSchema = z
  .object({
    type: z.literal("runtime-worker"),
    id: IdSchema,
    authenticatedBy: z.literal("runtime"),
  })
  .strict();

export const ImprovementAuthorActorSchema = StatisticsAuthorActorSchema;
export const ImprovementValidationActorSchema = z.union([
  VerifiedLocalSessionHumanSchema,
  TrustedRuntimeWorkerSchema,
]);

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
  "reconciling",
  "unknown",
  "validated",
  "rollback-requested",
  "rolled-back",
  "rollback-failed",
]);
export type ImprovementApplicationState = z.infer<
  typeof ImprovementApplicationStateSchema
>;

export const ImprovementTargetKindSchema = z.enum([
  "harness",
  "project-spec",
  "application-spec",
  "template",
  "skill-flow",
]);
export type ImprovementTargetKind = z.infer<typeof ImprovementTargetKindSchema>;

export const ImprovementProposalErrorCodeSchema = z.enum([
  "STATISTICS_EVIDENCE_UNAVAILABLE",
  "STATISTICS_EVIDENCE_STALE",
  "IMPROVEMENT_PROPOSAL_SUPERSEDED",
  "IMPROVEMENT_DECISION_EXISTS",
  "IMPROVEMENT_NOT_APPROVED",
  "IMPROVEMENT_INVALID_STATE",
  "IMPROVEMENT_TARGET_UNSUPPORTED",
  "IMPROVEMENT_APPLICATION_OPERATION_ID_REUSE",
  "IMPROVEMENT_TARGET_CONFLICT",
  "IMPROVEMENT_EVIDENCE_NOT_COMPARABLE",
  "IMPROVEMENT_APPLICATION_UNKNOWN",
]);
export type ImprovementProposalErrorCode = z.infer<
  typeof ImprovementProposalErrorCodeSchema
>;

export const GovernedRevisionRefSchema = z
  .object({
    revisionId: IdSchema,
    revisionHash: Sha256Schema,
  })
  .strict();
export type GovernedRevisionRef = z.infer<typeof GovernedRevisionRefSchema>;

export const GovernedHeadSchema = z
  .object({
    revisionId: IdSchema.nullable(),
    revisionHash: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((head, context) => {
    if ((head.revisionId === null) !== (head.revisionHash === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Governed head revision ID and hash must be present together.",
      });
    }
  });
export type GovernedHead = z.infer<typeof GovernedHeadSchema>;

export const HarnessRevisionContentSchema = z
  .object({
    principles: z.array(ReasonSchema).min(1).max(128),
    constitution: ReasonSchema,
    rules: z.array(ReasonSchema).min(1).max(256),
    examples: z
      .object({
        positive: z.array(ReasonSchema).max(128),
        negative: z.array(ReasonSchema).max(128),
      })
      .strict(),
    impactScope: z.array(IdSchema).min(1).max(128),
  })
  .strict();

export const ImprovementProjectSpecContentSchema = z
  .object({
    outcome: ReasonSchema,
    acceptanceCriteria: z.array(ReasonSchema).min(1),
    applicationBoundaries: z.array(ReasonSchema),
    crossApplicationContracts: z.array(ReasonSchema),
    deliveryConstraints: z.array(ReasonSchema),
  })
  .strict();

const ApplicationContractRefSchema = z
  .object({
    id: IdSchema,
    version: IdSchema,
  })
  .strict();

export const ImprovementApplicationSpecContentSchema = z
  .object({
    lineage: z
      .object({
        projectId: IdSchema,
        applicationId: IdSchema,
        promotedProjectSpecRevisionId: IdSchema,
        promotedProjectSpecHash: Sha256Schema,
      })
      .strict(),
    content: z
      .object({
        design: ReasonSchema,
        acceptanceCriteria: z.array(ReasonSchema).min(1),
        workPackageConstraints: z.array(ReasonSchema),
        integrationObligations: z.array(ReasonSchema),
        contractRefs: z.array(ApplicationContractRefSchema),
      })
      .strict(),
  })
  .strict();

const SafeTemplatePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    const segments = path.replaceAll("\\", "/").split("/");
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Template manifest paths must be safe relative POSIX paths.",
      });
    }
  });

export const RuntimeTemplateRevisionContentSchema = z
  .object({
    manifest: z
      .array(
        z
          .object({
            path: SafeTemplatePathSchema,
            contentHash: Sha256Schema,
          })
          .strict(),
      )
      .max(10_000)
      .superRefine((entries, context) => {
        const paths = entries.map((entry) => entry.path);
        if (new Set(paths).size !== paths.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Template manifest paths must be unique.",
          });
        }
        const sorted = [...paths].sort((left, right) =>
          left.localeCompare(right),
        );
        if (paths.some((path, index) => path !== sorted[index])) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Template manifest paths must be sorted.",
          });
        }
      }),
  })
  .strict();

export const GovernedSkillFlowRevisionContentSchema = z
  .object({
    positionId: IdSchema,
    name: ReasonSchema,
    instructions: ReasonSchema,
    skillIds: z.array(IdSchema).min(1).max(256),
  })
  .strict();

export const ImprovementTargetSchema = z.discriminatedUnion("targetKind", [
  z
    .object({
      targetKind: z.literal("harness"),
      ownerId: IdSchema,
      governedHead: GovernedHeadSchema,
      content: HarnessRevisionContentSchema,
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("project-spec"),
      ownerId: IdSchema,
      governedHead: GovernedHeadSchema,
      content: ImprovementProjectSpecContentSchema,
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("application-spec"),
      ownerId: IdSchema,
      governedHead: GovernedHeadSchema,
      content: ImprovementApplicationSpecContentSchema,
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("template"),
      ownerId: IdSchema,
      governedHead: GovernedHeadSchema,
      content: RuntimeTemplateRevisionContentSchema,
    })
    .strict(),
  z
    .object({
      targetKind: z.literal("skill-flow"),
      ownerId: IdSchema,
      governedHead: GovernedHeadSchema,
      content: GovernedSkillFlowRevisionContentSchema,
    })
    .strict(),
]);
export type ImprovementTarget = z.infer<typeof ImprovementTargetSchema>;

const ExpectedMetricSchema = z
  .object({
    metricId: StatisticsMetricIdSchema,
    direction: z.enum(["increase", "decrease", "hold"]),
  })
  .strict();

export const ImprovementProposalRevisionContentSchema = z
  .object({
    evidence: StatisticsEvidenceSnapshotViewSchema,
    target: ImprovementTargetSchema,
    rootCauseHypothesis: ReasonSchema,
    impactScope: z
      .object({
        projectIds: z.array(IdSchema).min(1).max(64),
        departmentIds: z.array(IdSchema).max(64),
        positionIds: z.array(IdSchema).max(64),
      })
      .strict(),
    expectedMetrics: z.array(ExpectedMetricSchema).min(1).max(64),
    validationPolicy: z
      .object({
        metricIds: z.array(StatisticsMetricIdSchema).min(1).max(64),
        minimumComparableObservations: z.number().int().positive(),
      })
      .strict(),
    rolloutNotes: ReasonSchema,
    rollbackSource: GovernedRevisionRefSchema,
  })
  .strict()
  .superRefine((content, context) => {
    if (
      !content.impactScope.projectIds.includes(content.evidence.query.projectId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Impact scope must include the frozen evidence Project.",
      });
    }
    const comparisonMetrics = new Set(
      content.evidence.query.comparisonSet.metricIds,
    );
    for (const metricId of content.validationPolicy.metricIds) {
      if (!comparisonMetrics.has(metricId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Validation metrics must belong to the frozen comparison set.",
        });
      }
    }
  });
export type ImprovementProposalRevisionContent = z.infer<
  typeof ImprovementProposalRevisionContentSchema
>;

const ImprovementProposalCreateBaseSchema = z
  .object({
    proposalId: IdSchema,
    revisionId: IdSchema,
    projectId: IdSchema,
    departmentId: IdSchema.nullable(),
    content: ImprovementProposalRevisionContentSchema,
  })
  .strict();

export const ImprovementProposalCreateCommandInputSchema =
  ImprovementProposalCreateBaseSchema;

export const ImprovementProposalCreateRequestSchema =
  ImprovementProposalCreateBaseSchema.extend({
    actor: ImprovementAuthorActorSchema,
  }).strict();
export type ImprovementProposalCreateRequest = z.infer<
  typeof ImprovementProposalCreateRequestSchema
>;

const ImprovementProposalReviseBaseSchema = z
  .object({
    proposalId: IdSchema,
    revisionId: IdSchema,
    supersedesRevisionId: IdSchema,
    expectedSupersededRevisionHash: Sha256Schema,
    content: ImprovementProposalRevisionContentSchema,
  })
  .strict();

export const ImprovementProposalReviseCommandInputSchema =
  ImprovementProposalReviseBaseSchema;

export const ImprovementProposalReviseRequestSchema =
  ImprovementProposalReviseBaseSchema.extend({
    actor: ImprovementAuthorActorSchema,
  }).strict();
export type ImprovementProposalReviseRequest = z.infer<
  typeof ImprovementProposalReviseRequestSchema
>;

export const ImprovementProposalTransitionCommandInputSchema = z
  .object({
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    expectedProposalRevisionHash: Sha256Schema,
  })
  .strict();

export const ImprovementProposalTransitionRequestSchema =
  ImprovementProposalTransitionCommandInputSchema.extend({
    actor: ImprovementAuthorActorSchema,
  }).strict();
export type ImprovementProposalTransitionRequest = z.infer<
  typeof ImprovementProposalTransitionRequestSchema
>;

export const ImprovementProposalRequestDecisionCommandInputSchema =
  ImprovementProposalTransitionCommandInputSchema.extend({
    confirmation: ReasonSchema,
  }).strict();

export const ImprovementProposalRequestDecisionRequestSchema =
  ImprovementProposalRequestDecisionCommandInputSchema.extend({
    actor: ImprovementAuthorActorSchema,
  }).strict();

export const ImprovementProposalDecideCommandInputSchema = z
  .object({
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    expectedProposalRevisionHash: Sha256Schema,
    decision: z.enum(["approved", "rejected"]),
    confirmation: ReasonSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementProposalDecisionSchema = z
  .object({
    id: IdSchema,
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    proposalRevisionHash: Sha256Schema,
    evidenceSnapshotId: IdSchema,
    evidenceSnapshotHash: Sha256Schema,
    target: ImprovementTargetSchema,
    decision: z.enum(["approved", "rejected"]),
    confirmation: ReasonSchema,
    actor: VerifiedLocalSessionHumanSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
    hash: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict();
export type ImprovementProposalDecision = z.infer<
  typeof ImprovementProposalDecisionSchema
>;

export const ImprovementProposalDecideRequestSchema =
  ImprovementProposalDecideCommandInputSchema.extend({
    decisionId: IdSchema,
    actor: VerifiedLocalSessionHumanSchema,
  }).strict();

const ImprovementApplicationApplyBaseSchema = z
  .object({
    operationId: IdSchema,
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    expectedProposalRevisionHash: Sha256Schema,
    approvedDecisionId: IdSchema,
    expectedApprovedDecisionHash: Sha256Schema,
    target: ImprovementTargetSchema,
    confirmation: ReasonSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementApplicationApplyCommandInputSchema =
  ImprovementApplicationApplyBaseSchema;
export type ImprovementApplicationApplyCommandInput = z.infer<
  typeof ImprovementApplicationApplyCommandInputSchema
>;

export const ImprovementApplicationApplyRequestSchema =
  ImprovementApplicationApplyBaseSchema.extend({
    actor: VerifiedLocalSessionHumanSchema,
  }).strict();
export type ImprovementApplicationApplyRequest = z.infer<
  typeof ImprovementApplicationApplyRequestSchema
>;

const ImprovementApplicationValidateBaseSchema = z
  .object({
    operationId: IdSchema,
    expectedOperationHash: Sha256Schema,
    afterEvidence: StatisticsEvidenceSnapshotViewSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementApplicationValidateCommandInputSchema =
  ImprovementApplicationValidateBaseSchema;
export const ImprovementApplicationValidateRequestSchema =
  ImprovementApplicationValidateBaseSchema.extend({
    actor: ImprovementValidationActorSchema,
  }).strict();

const ImprovementApplicationRollbackBaseSchema = z
  .object({
    operationId: IdSchema,
    expectedOperationHash: Sha256Schema,
    appliedRevision: GovernedRevisionRefSchema,
    expectedGovernedHead: GovernedRevisionRefSchema,
    rollbackSource: GovernedRevisionRefSchema,
    confirmation: ReasonSchema,
    reason: ReasonSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .strict();

export const ImprovementApplicationRollbackCommandInputSchema =
  ImprovementApplicationRollbackBaseSchema;
export const ImprovementApplicationRollbackRequestSchema =
  ImprovementApplicationRollbackBaseSchema.extend({
    actor: VerifiedLocalSessionHumanSchema,
  }).strict();

export const ImprovementApplicationReceiptSchema = z
  .object({
    id: IdSchema,
    phase: z.enum(["apply", "rollback"]),
    disposition: z.enum(["applied", "no-op", "failed"]),
    targetRevision: GovernedRevisionRefSchema.nullable(),
    evidenceRefs: z.array(IdSchema).max(64),
    hash: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementApplicationObservationSchema = z
  .object({
    id: IdSchema,
    phase: z.enum(["apply", "rollback"]),
    outcome: z.enum([
      "exact-match",
      "proven-absent",
      "conflict",
      "insufficient-evidence",
    ]),
    evidenceRefs: z.array(IdSchema).min(1).max(64),
    hash: Sha256Schema,
    observedAt: TimestampSchema,
  })
  .strict();

export const ImprovementApplicationReconciliationSchema = z
  .object({
    id: IdSchema,
    phase: z.enum(["apply", "rollback"]),
    result: z.enum(["finalized", "retry-permitted", "unknown"]),
    evidenceRefs: z.array(IdSchema).min(1).max(64),
    hash: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementApplicationValidationSchema = z
  .object({
    id: IdSchema,
    beforeEvidence: StatisticsEvidenceSnapshotViewSchema,
    afterEvidence: StatisticsEvidenceSnapshotViewSchema,
    outcome: StatisticsEvidenceValidationOutcomeSchema,
    hash: Sha256Schema,
    validatedBy: ImprovementValidationActorSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementApplicationRollbackViewSchema = z
  .object({
    id: IdSchema,
    appliedRevision: GovernedRevisionRefSchema,
    sourceRevision: GovernedRevisionRefSchema,
    expectedGovernedHead: GovernedRevisionRefSchema,
    restoringRevision: GovernedRevisionRefSchema.nullable(),
    state: z.enum(["requested", "rolled-back", "failed", "unknown"]),
    evidenceRefs: z.array(IdSchema).max(64),
    hash: Sha256Schema,
    requestedBy: VerifiedLocalSessionHumanSchema,
    createdAt: TimestampSchema,
  })
  .strict();

const ImprovementProposalLifecycleEntrySchema = z
  .object({
    state: z.enum(["draft", "proposed", "awaiting-human"]),
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementProposalRevisionViewSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    supersedesRevisionId: IdSchema.nullable(),
    content: ImprovementProposalRevisionContentSchema,
    hash: Sha256Schema,
    authoredBy: ImprovementAuthorActorSchema,
    lifecycle: z.array(ImprovementProposalLifecycleEntrySchema),
    decision: ImprovementProposalDecisionSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict();

export const ImprovementProposalNextActionSchema = z.enum([
  "revise",
  "propose",
  "request-decision",
  "approve",
  "reject",
  "apply",
]);

export const ImprovementProposalViewSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    departmentId: IdSchema.nullable(),
    currentRevisionId: IdSchema,
    currentState: ImprovementProposalStateSchema,
    revisions: z.array(ImprovementProposalRevisionViewSchema).min(1),
    nextActions: z.array(ImprovementProposalNextActionSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ImprovementProposalView = z.infer<
  typeof ImprovementProposalViewSchema
>;

export const ImprovementApplicationNextActionSchema = z.enum([
  "validate",
  "rollback",
  "reconcile",
]);

export const ImprovementApplicationOperationViewSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    proposalId: IdSchema,
    proposalRevisionId: IdSchema,
    proposalRevisionHash: Sha256Schema,
    approvedDecisionId: IdSchema,
    approvedDecisionHash: Sha256Schema,
    target: ImprovementTargetSchema,
    canonicalRequestHash: Sha256Schema,
    state: ImprovementApplicationStateSchema,
    deterministicEffectId: IdSchema,
    receipts: z.array(ImprovementApplicationReceiptSchema),
    observations: z.array(ImprovementApplicationObservationSchema),
    reconciliations: z.array(ImprovementApplicationReconciliationSchema),
    validations: z.array(ImprovementApplicationValidationSchema),
    rollbacks: z.array(ImprovementApplicationRollbackViewSchema),
    nextActions: z.array(ImprovementApplicationNextActionSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ImprovementApplicationOperationView = z.infer<
  typeof ImprovementApplicationOperationViewSchema
>;

export interface ImprovementApplicationEffectAdapter {
  readonly inspectEffect: (input: {
    readonly operationId: string;
    readonly target: ImprovementTarget;
    readonly phase: "apply" | "rollback";
  }) => Promise<
    | {
        readonly outcome: "exact-match";
        readonly revision: GovernedRevisionRef;
        readonly evidenceRefs: readonly string[];
      }
    | {
        readonly outcome:
          | "proven-absent"
          | "conflict"
          | "insufficient-evidence";
        readonly evidenceRefs: readonly string[];
      }
  >;
  readonly appendRevision: (input: {
    readonly operationId: string;
    readonly target: ImprovementTarget;
    readonly phase: "apply" | "rollback";
    readonly expectedGovernedHead: GovernedHead;
  }) => Promise<{
    readonly revision: GovernedRevisionRef;
    readonly disposition: "applied" | "no-op";
    readonly evidenceRefs: readonly string[];
  }>;
}

export interface ImprovementProposalPersistence {
  readonly create: (
    request: z.infer<typeof ImprovementProposalCreateRequestSchema>,
  ) => ImprovementProposalView;
  readonly revise: (
    request: z.infer<typeof ImprovementProposalReviseRequestSchema>,
  ) => ImprovementProposalView;
  readonly transition: (
    request: z.infer<typeof ImprovementProposalTransitionRequestSchema>,
  ) => ImprovementProposalView;
  readonly decide: (
    request: z.infer<typeof ImprovementProposalDecideRequestSchema>,
  ) => ImprovementProposalView;
  readonly inspect: (proposalId: string) => ImprovementProposalView;
  readonly list: (projectId: string) => readonly ImprovementProposalView[];
}

export interface ImprovementApplicationPersistence {
  readonly createIntent: (
    request: ImprovementApplicationApplyRequest,
  ) => ImprovementApplicationOperationView;
  readonly appendReceipt: (
    operationId: string,
    receipt: z.infer<typeof ImprovementApplicationReceiptSchema>,
  ) => ImprovementApplicationOperationView;
  readonly appendObservation: (
    operationId: string,
    observation: z.infer<typeof ImprovementApplicationObservationSchema>,
  ) => ImprovementApplicationOperationView;
  readonly appendReconciliation: (
    operationId: string,
    reconciliation: z.infer<typeof ImprovementApplicationReconciliationSchema>,
  ) => ImprovementApplicationOperationView;
  readonly appendValidation: (
    operationId: string,
    validation: z.infer<typeof ImprovementApplicationValidationSchema>,
  ) => ImprovementApplicationOperationView;
  readonly appendRollback: (
    operationId: string,
    rollback: z.infer<typeof ImprovementApplicationRollbackViewSchema>,
  ) => ImprovementApplicationOperationView;
  readonly inspect: (
    operationId: string,
  ) => ImprovementApplicationOperationView;
  readonly list: (
    projectId: string,
  ) => readonly ImprovementApplicationOperationView[];
}

export type ImprovementEvidenceSnapshot = StatisticsEvidenceSnapshotView;
