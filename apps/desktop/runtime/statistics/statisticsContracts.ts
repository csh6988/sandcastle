import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(512);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcTimestampSchema = z
  .string()
  .datetime()
  .refine((value) => value.endsWith("Z"), "Timestamp must be UTC.");

const canonicalIdList = z
  .array(IdSchema)
  .max(256)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canonical dimension values must be unique.",
      });
    }
    const sorted = [...values].sort((left, right) => left.localeCompare(right));
    if (values.some((value, index) => value !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canonical dimension values must be sorted.",
      });
    }
  });

export const StatisticsCatalogVersionSchema = z.literal("statistics@1");
export type StatisticsCatalogVersion = z.infer<
  typeof StatisticsCatalogVersionSchema
>;

export const StatisticsDimensionSchema = z.enum([
  "department",
  "ai-member",
  "model",
  "repository",
  "work-package",
  "pipeline-version",
]);
export type StatisticsDimension = z.infer<typeof StatisticsDimensionSchema>;

export const StatisticsMetricIdSchema = z.enum([
  "product-baseline-confirmation-count",
  "product-baseline-confirmation-latency",
  "review-finding-count",
  "review-discussion-round-count",
  "review-recheck-pass-rate",
  "readiness-blocker-count",
  "governed-execution-concurrency",
  "ordinary-retry-count",
  "recovery-attempt-count",
  "code-review-defect-incidence",
  "integration-conflict-rate",
  "test-pass-rate",
  "electron-ui-runtime-mismatch-rate",
  "department-run-failure-rate",
  "node-attempt-failure-rate",
  "lease-interruption-rate",
  "human-approval-wait",
  "governed-intervention-rate",
  "delivery-candidate-acceptance-rate",
  "release-item-success-rate",
  "memory-promotion-rate",
  "memory-selection-rate",
  "security-operability-high-risk-closure-rate",
  "whole-run-token-cost",
  "complete-model-attribution",
  "heterogeneous-defect-aggregate-rate",
]);
export type StatisticsMetricId = z.infer<typeof StatisticsMetricIdSchema>;

export const StatisticsCanonicalFiltersSchema = z
  .object({
    departmentIds: canonicalIdList,
    aiMemberIds: canonicalIdList,
    modelIds: canonicalIdList,
    repositoryIds: canonicalIdList,
    workPackageIds: canonicalIdList,
    pipelineVersionIds: canonicalIdList,
  })
  .strict();
export type StatisticsCanonicalFilters = z.infer<
  typeof StatisticsCanonicalFiltersSchema
>;

export const StatisticsFilterInputSchema = z
  .object({
    departmentIds: z.array(IdSchema).max(256).optional(),
    aiMemberIds: z.array(IdSchema).max(256).optional(),
    modelIds: z.array(IdSchema).max(256).optional(),
    repositoryIds: z.array(IdSchema).max(256).optional(),
    workPackageIds: z.array(IdSchema).max(256).optional(),
    pipelineVersionIds: z.array(IdSchema).max(256).optional(),
  })
  .strict();

export const StatisticsWindowSchema = z
  .object({
    kind: z.literal("explicit-utc-half-open"),
    startInclusive: UtcTimestampSchema,
    endExclusive: UtcTimestampSchema,
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.startInclusive) >= Date.parse(window.endExclusive)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Statistics window must end after it starts.",
      });
    }
  });
export type StatisticsWindow = z.infer<typeof StatisticsWindowSchema>;

export const StatisticsCohortSchema = z
  .object({
    id: IdSchema,
    filters: StatisticsCanonicalFiltersSchema,
  })
  .strict();

const canonicalMetricList = z
  .array(StatisticsMetricIdSchema)
  .min(1)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Comparison metric IDs must be unique.",
      });
    }
    const sorted = [...values].sort((left, right) => left.localeCompare(right));
    if (values.some((value, index) => value !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Comparison metric IDs must be sorted.",
      });
    }
  });

export const StatisticsComparisonSetSchema = z
  .object({
    id: IdSchema,
    metricIds: canonicalMetricList,
  })
  .strict();

export const StatisticsCanonicalQuerySchema = z
  .object({
    catalogVersion: StatisticsCatalogVersionSchema,
    projectId: IdSchema,
    filters: StatisticsCanonicalFiltersSchema,
    window: StatisticsWindowSchema,
    cohort: StatisticsCohortSchema,
    comparisonSet: StatisticsComparisonSetSchema,
  })
  .strict();
export type StatisticsCanonicalQuery = z.infer<
  typeof StatisticsCanonicalQuerySchema
>;

export const StatisticsInspectInputSchema = z
  .object({
    catalogVersion: StatisticsCatalogVersionSchema.optional(),
    projectId: IdSchema,
    filters: StatisticsFilterInputSchema.optional(),
    window: StatisticsWindowSchema,
    cohort: z
      .object({
        id: IdSchema,
        filters: StatisticsFilterInputSchema.optional(),
      })
      .strict(),
    comparisonSet: z
      .object({
        id: IdSchema,
        metricIds: z.array(StatisticsMetricIdSchema).min(1).max(64),
      })
      .strict(),
  })
  .strict();
export type StatisticsInspectInput = z.infer<
  typeof StatisticsInspectInputSchema
>;

export const StatisticsMeasurementSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("count"), value: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("rate"),
      numerator: z.number().int().nonnegative(),
      denominator: z.number().int().positive(),
      value: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("duration"),
      milliseconds: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("concurrency"),
      maximum: z.number().int().nonnegative(),
      intervalCount: z.number().int().nonnegative(),
    })
    .strict(),
]);

const StatisticsObservationBaseSchema = z.object({
  metricId: StatisticsMetricIdSchema,
  sourceFactFamily: IdSchema,
  sourceFactRefs: z.array(IdSchema).max(10_000),
});

export const StatisticsMetricObservationSchema = z.discriminatedUnion(
  "status",
  [
    StatisticsObservationBaseSchema.extend({
      status: z.literal("available"),
      measurement: StatisticsMeasurementSchema,
    }).strict(),
    StatisticsObservationBaseSchema.extend({
      status: z.literal("incomplete"),
      reason: z.string().trim().min(1).max(4_000),
      missingFactKinds: z.array(IdSchema).min(1).max(64),
    }).strict(),
    StatisticsObservationBaseSchema.extend({
      status: z.literal("unavailable"),
      reason: z.string().trim().min(1).max(4_000),
      unavailableReasonCode: z.enum([
        "unsupported-by-statistics-at-1",
        "missing-authoritative-facts",
        "missing-dimension-attribution",
        "missing-denominator-authority",
        "missing-paired-timestamps",
      ]),
    }).strict(),
  ],
);
export type StatisticsMetricObservation = z.infer<
  typeof StatisticsMetricObservationSchema
>;

export const StatisticsCompletenessSchema = z
  .object({
    status: z.enum(["complete", "incomplete", "unavailable"]),
    incompleteMetricIds: z.array(StatisticsMetricIdSchema),
    unavailableMetricIds: z.array(StatisticsMetricIdSchema),
  })
  .strict();

const VerifiedLocalSessionHumanSchema = z
  .object({
    type: z.literal("human"),
    id: IdSchema,
    authenticatedBy: z.literal("local-session"),
  })
  .strict();

const TrustedRuntimeWorkerSchema = z
  .object({
    type: z.literal("runtime-worker"),
    id: IdSchema,
    authenticatedBy: z.literal("runtime"),
  })
  .strict();

export const StatisticsAuthorActorSchema = z.union([
  VerifiedLocalSessionHumanSchema,
  TrustedRuntimeWorkerSchema,
]);
export type StatisticsAuthorActor = z.infer<typeof StatisticsAuthorActorSchema>;

export const StatisticsProjectReaderSchema = z.union([
  VerifiedLocalSessionHumanSchema.extend({
    projectReadAuthority: z.array(IdSchema).min(1),
  }).strict(),
  TrustedRuntimeWorkerSchema.extend({
    projectReadAuthority: z.array(IdSchema).min(1),
  }).strict(),
  z
    .object({
      type: z.literal("electron-main"),
      id: IdSchema,
      authenticatedBy: z.literal("ipc-token"),
      projectReadAuthority: z.array(IdSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("acp-client"),
      id: IdSchema,
      authenticatedBy: z.literal("acp-connection"),
      projectReadAuthority: z.array(IdSchema).min(1),
    })
    .strict(),
]);
export type StatisticsProjectReader = z.infer<
  typeof StatisticsProjectReaderSchema
>;

export const StatisticsViewSchema = z
  .object({
    query: StatisticsCanonicalQuerySchema,
    asOfSequence: z.number().int().nonnegative(),
    observations: z.array(StatisticsMetricObservationSchema),
    completeness: StatisticsCompletenessSchema,
    generatedAt: UtcTimestampSchema,
  })
  .strict();
export type StatisticsView = z.infer<typeof StatisticsViewSchema>;

export const StatisticsEvidenceSnapshotViewSchema = z
  .object({
    id: IdSchema,
    query: StatisticsCanonicalQuerySchema,
    queryHash: Sha256Schema,
    asOfSequence: z.number().int().nonnegative(),
    observations: z.array(StatisticsMetricObservationSchema),
    completeness: StatisticsCompletenessSchema,
    frozenBy: StatisticsAuthorActorSchema,
    hash: Sha256Schema,
    createdAt: UtcTimestampSchema,
  })
  .strict();
export type StatisticsEvidenceSnapshotView = z.infer<
  typeof StatisticsEvidenceSnapshotViewSchema
>;

export const StatisticsEvidenceFreezeCommandInputSchema = z
  .object({
    evidenceSnapshotId: IdSchema,
    query: StatisticsInspectInputSchema,
  })
  .strict();
export type StatisticsEvidenceFreezeCommandInput = z.infer<
  typeof StatisticsEvidenceFreezeCommandInputSchema
>;

export const StatisticsEvidenceFreezeRequestSchema =
  StatisticsEvidenceFreezeCommandInputSchema.extend({
    actor: StatisticsAuthorActorSchema,
  }).strict();

export const StatisticsEvidenceSnapshotRefSchema = z
  .object({
    id: IdSchema,
    hash: Sha256Schema,
  })
  .strict();

export const StatisticsEvidenceValidationOutcomeSchema = z.enum([
  "improved",
  "unchanged",
  "regressed",
]);
