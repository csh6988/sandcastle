import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const IdSchema = z.string().trim().min(1);
const TimestampSchema = z.string().datetime();

const VerifiedLocalSessionHumanSchema = z
  .object({
    type: z.literal("human"),
    id: IdSchema,
    authenticatedBy: z.literal("local-session"),
  })
  .strict();

export const ReleaseOperationKindSchema = z.enum(["merge", "export"]);
export type ReleaseOperationKind = z.infer<typeof ReleaseOperationKindSchema>;

export const ReleaseOperationErrorCodeSchema = z.enum([
  "RELEASE_OPERATION_NOT_FOUND",
  "RELEASE_OPERATION_ID_REUSE",
  "RELEASE_AUTHORITY_CONFLICT",
  "RELEASE_TARGET_INVALID",
  "RELEASE_TARGET_CHECKED_OUT",
  "RELEASE_FAST_FORWARD_REQUIRED",
  "RELEASE_ARTIFACT_NOT_AUTHORIZED",
  "RELEASE_ARTIFACT_UNREADABLE",
  "RELEASE_DESTINATION_INVALID",
  "RELEASE_DESTINATION_CONFLICT",
  "RELEASE_OPERATION_BLOCKED",
  "RELEASE_RECONCILIATION_INVALID",
]);
export type ReleaseOperationErrorCode = z.infer<
  typeof ReleaseOperationErrorCodeSchema
>;

export const ReleaseOperationItemStateSchema = z.enum([
  "pending",
  "running",
  "reconciling",
  "succeeded",
  "failed",
  "destination-conflict",
  "unknown",
]);
export type ReleaseOperationItemState = z.infer<
  typeof ReleaseOperationItemStateSchema
>;

export const ReleaseOperationAggregateStateSchema = z.enum([
  "pending",
  "running",
  "reconciling",
  "succeeded",
  "partially-succeeded",
  "failed",
  "blocked",
]);
export type ReleaseOperationAggregateState = z.infer<
  typeof ReleaseOperationAggregateStateSchema
>;

const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Artifact destination must be an exact relative path within its canonical root.",
  );

const MergeReleaseOperationItemSchema = z
  .object({
    id: IdSchema,
    repositoryReference: IdSchema,
    sourceCommit: GitCommitSchema,
    destination: z
      .object({
        targetBranch: IdSchema,
        expectedTargetTip: GitCommitSchema,
      })
      .strict(),
  })
  .strict();

const ExportReleaseOperationItemSchema = z
  .object({
    id: IdSchema,
    artifactVersionId: IdSchema,
    destination: z
      .object({
        canonicalRoot: z.string().trim().min(1),
        expectedRootState: z.literal("preexisting-local-filesystem-root"),
        relativePath: RelativePathSchema,
        overwrite: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("create-only") }).strict(),
          z
            .object({
              kind: z.literal("replace-if-exact-digest"),
              expectedDestinationDigest: Sha256Schema,
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export const ReleaseOperationAuthorizationSchema = z
  .object({
    actor: VerifiedLocalSessionHumanSchema,
    reason: z.string().trim().min(1).max(4_000),
    evidenceRefs: z.array(IdSchema.max(512)).min(1).max(64),
  })
  .strict();

const sortedDistinctIds = <Item extends { readonly id: string }>(
  items: readonly Item[],
  context: z.RefinementCtx,
): void => {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Release operation item IDs must be unique.", path: ["items"] });
  }
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Release operation items must be in ascending ID order for deterministic serial execution.", path: ["items"] });
  }
};

export const MergeReleaseOperationCreateRequestSchema = z
  .object({
    operationId: IdSchema,
    candidateId: IdSchema,
    kind: z.literal("merge"),
    authorization: ReleaseOperationAuthorizationSchema,
    items: z.array(MergeReleaseOperationItemSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => sortedDistinctIds(value.items, context));

export const ExportReleaseOperationCreateRequestSchema = z
  .object({
    operationId: IdSchema,
    candidateId: IdSchema,
    kind: z.literal("export"),
    authorization: ReleaseOperationAuthorizationSchema,
    items: z.array(ExportReleaseOperationItemSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => sortedDistinctIds(value.items, context));

export const ReleaseOperationCreateRequestSchema = z.union([
  MergeReleaseOperationCreateRequestSchema,
  ExportReleaseOperationCreateRequestSchema,
]);
export type ReleaseOperationCreateRequest = z.infer<
  typeof ReleaseOperationCreateRequestSchema
>;

export const AcceptedDeliveryCandidateAuthoritySnapshotSchema = z
  .object({
    id: IdSchema,
    candidateId: IdSchema,
    candidateHash: Sha256Schema,
    releaseDecisionId: IdSchema,
    releaseDecisionHash: Sha256Schema,
    candidateInputId: IdSchema,
    candidateInputHash: Sha256Schema,
    gateAuthorityId: IdSchema,
    gateAuthorityHash: Sha256Schema,
    integrationGenerationId: IdSchema,
    integrationAuthorityHash: Sha256Schema,
    repositoryCommits: z.array(
      z
        .object({ repositoryReference: IdSchema, commit: GitCommitSchema })
        .strict(),
    ),
    artifactVersionIds: z.array(IdSchema),
    runId: IdSchema,
    snapshotRevisionId: IdSchema,
    authorityHash: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict();
export type AcceptedDeliveryCandidateAuthoritySnapshot = z.infer<
  typeof AcceptedDeliveryCandidateAuthoritySnapshotSchema
>;

const ReleaseOperationEffectBaseSchema = z
  .object({
    operationId: IdSchema,
    canonicalRequestHash: Sha256Schema,
    acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshotSchema,
  })
  .strict();

export const ReleaseOperationEffectRequestSchema = z.discriminatedUnion("kind", [
  ReleaseOperationEffectBaseSchema.extend({
    kind: z.literal("merge"),
    item: MergeReleaseOperationItemSchema,
  }),
  ReleaseOperationEffectBaseSchema.extend({
    kind: z.literal("export"),
    item: ExportReleaseOperationItemSchema,
    artifact: z
      .object({
        contentKind: z.enum(["managed-file", "repository-object"]),
        integrityStatus: z.literal("verified"),
        digest: Sha256Schema,
      })
      .strict(),
  }),
]);
export type ReleaseOperationEffectRequest = z.infer<
  typeof ReleaseOperationEffectRequestSchema
>;

export const ReleaseOperationReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("merge"),
      disposition: z.enum(["applied", "no-op"]),
      resultingTargetTip: GitCommitSchema,
      observedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("export"),
      disposition: z.enum(["applied", "no-op"]),
      destinationDigest: Sha256Schema,
      observedAt: TimestampSchema,
    })
    .strict(),
]);
export type ReleaseOperationReceipt = z.infer<
  typeof ReleaseOperationReceiptSchema
>;

export const ReleaseOperationDestinationConflictSchema = z
  .object({
    code: z.literal("RELEASE_DESTINATION_CONFLICT"),
    message: z.string().trim().min(1).max(4_000),
    observedDestinationState: z.unknown(),
    observedAt: TimestampSchema,
  })
  .strict();

export const ReleaseOperationUnknownSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1).max(4_000),
    observedAt: TimestampSchema,
  })
  .strict();

export const ReleaseOperationItemFinalizeSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("succeeded"), receipt: ReleaseOperationReceiptSchema })
    .strict(),
  z
    .object({ state: z.literal("failed"), failure: ReleaseOperationUnknownSchema })
    .strict(),
  z
    .object({ state: z.literal("destination-conflict"), conflict: ReleaseOperationDestinationConflictSchema })
    .strict(),
  z
    .object({ state: z.literal("unknown"), unknown: ReleaseOperationUnknownSchema })
    .strict(),
]);
export type ReleaseOperationItemFinalize = z.infer<
  typeof ReleaseOperationItemFinalizeSchema
>;

export const ReleaseOperationPartialFinalizeSchema = z
  .object({
    operationId: IdSchema,
    itemFinalizations: z
      .array(
        z
          .object({ itemId: IdSchema, result: ReleaseOperationItemFinalizeSchema })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ReleaseOperationPartialFinalize = z.infer<
  typeof ReleaseOperationPartialFinalizeSchema
>;

export const ReleaseOperationReconcileRequestSchema = z
  .object({
    operationId: IdSchema,
    itemId: IdSchema,
    actor: VerifiedLocalSessionHumanSchema,
    evidenceRefs: z.array(IdSchema.max(512)).min(1).max(64),
  })
  .strict();
export type ReleaseOperationReconcileRequest = z.infer<
  typeof ReleaseOperationReconcileRequestSchema
>;

export const ReleaseOperationReconcileObservationSchema = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("pending") }).strict(),
    z.object({ state: z.literal("running") }).strict(),
    z.object({ state: z.literal("succeeded"), receipt: ReleaseOperationReceiptSchema }).strict(),
    z.object({ state: z.literal("failed"), failure: ReleaseOperationUnknownSchema }).strict(),
    z.object({ state: z.literal("destination-conflict"), conflict: ReleaseOperationDestinationConflictSchema }).strict(),
    z.object({ state: z.literal("unknown"), unknown: ReleaseOperationUnknownSchema }).strict(),
  ],
);
export type ReleaseOperationReconcileObservation = z.infer<
  typeof ReleaseOperationReconcileObservationSchema
>;

const ReleaseOperationItemViewSchema = z
  .object({
    id: IdSchema,
    state: ReleaseOperationItemStateSchema,
    receipt: ReleaseOperationReceiptSchema.nullable(),
    evidence: z.array(z.unknown()),
    updatedAt: TimestampSchema,
  })
  .passthrough();

export const ReleaseOperationViewSchema = z
  .object({
    id: IdSchema,
    request: ReleaseOperationCreateRequestSchema,
    acceptedAuthority: AcceptedDeliveryCandidateAuthoritySnapshotSchema,
    canonicalRequestHash: Sha256Schema,
    aggregateState: ReleaseOperationAggregateStateSchema,
    counts: z
      .object({
        pending: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        reconciling: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        destinationConflict: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(ReleaseOperationItemViewSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ReleaseOperationView = z.infer<typeof ReleaseOperationViewSchema>;

export interface ReleaseOperationPersistence {
  readonly createIntent: (input: ReleaseOperationView) => ReleaseOperationView;
  readonly inspect: (operationId: string) => ReleaseOperationView;
  readonly list: (candidateId?: string) => readonly ReleaseOperationView[];
  readonly finalize: (
    input: ReleaseOperationPartialFinalize,
  ) => ReleaseOperationView;
  readonly reconcile: (input: {
    readonly request: ReleaseOperationReconcileRequest;
    readonly observation: ReleaseOperationReconcileObservation;
  }) => ReleaseOperationView;
}

export interface ReleaseOperationEffectAdapter {
  readonly execute: (
    request: ReleaseOperationEffectRequest,
  ) => Promise<ReleaseOperationItemFinalize>;
  readonly reconcile: (
    request: ReleaseOperationEffectRequest,
    evidenceRefs: readonly string[],
  ) => Promise<ReleaseOperationReconcileObservation>;
}
