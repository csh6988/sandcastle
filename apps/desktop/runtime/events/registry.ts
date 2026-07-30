import { z } from "zod";

export const RUNTIME_EVENT_REGISTRY_VERSION = 17;

export type RuntimeEventRetentionClass = "transient" | "standard" | "durable";

export type RuntimeEventMappingIntent = "mapped" | "custom" | "unmapped";

export interface RuntimeEventScope {
  readonly companyId: string;
  readonly projectId?: string;
  readonly applicationId?: string;
  readonly departmentId?: string;
  readonly productProposalId?: string;
  readonly productBaselineId?: string;
  readonly projectSpecRevisionId?: string;
  readonly applicationSpecRevisionId?: string;
  readonly technicalBaselineProposalId?: string;
  readonly technicalBaselineId?: string;
  readonly snapshotRevisionId?: string;
  readonly runId?: string;
  readonly nodeRunId?: string;
  readonly nodeAttemptId?: string;
  readonly sessionId?: string;
  readonly interactionTurnId?: string;
  readonly participantId?: string;
  readonly topicId?: string;
  readonly reviewFindingId?: string;
  readonly qualityGateResultId?: string;
  readonly artifactId?: string;
  readonly artifactVersionId?: string;
  readonly workspaceAllocationId?: string;
  readonly workPackageId?: string;
  readonly workPackageVersionId?: string;
  readonly integrationGenerationId?: string;
  readonly integrationOperationId?: string;
  readonly testCaseRevisionId?: string;
  readonly testRunId?: string;
  readonly deliveryCandidateInputId?: string;
  readonly candidateGateInputId?: string;
  readonly defectId?: string;
  readonly permissionRequestId?: string;
  readonly memoryCandidateId?: string;
  readonly memoryEntryId?: string;
  readonly commandId?: string;
}

export interface RuntimeEventDefinition {
  readonly type: string;
  readonly schemaVersion: number;
  readonly requiredTopLevelIds: readonly (keyof RuntimeEventScope)[];
  readonly payloadSchema: z.ZodType;
  readonly retentionClass: RuntimeEventRetentionClass;
  readonly agUiMapping: RuntimeEventMappingIntent;
  readonly acpMapping: RuntimeEventMappingIntent;
}

export class RuntimeEventRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeEventRegistryError";
  }
}

const projectEventPayloadSchema = z
  .object({
    projectId: z.string().trim().min(1),
    revision: z.number().int().nonnegative().optional(),
    entityId: z.string().trim().min(1).optional(),
    operation: z.enum(["created", "updated", "deleted"]).optional(),
  })
  .passthrough();

const retainedCatalogEntities = [
  "department",
  "position",
  "ai-member",
  "execution-profile",
  "secret-reference",
  "skill",
  "skill-flow",
  "pipeline-draft",
  "pipeline-version",
  "position-skill-binding",
] as const;

const retainedCatalogOperations = ["created", "updated", "deleted"] as const;

const retainedCatalogEventDefinitions = retainedCatalogEntities.flatMap(
  (entity) =>
    retainedCatalogOperations.map(
      (operation) =>
        ({
          type: `${entity}.${operation}`,
          schemaVersion: 1,
          requiredTopLevelIds: ["companyId"],
          payloadSchema: z
            .object({
              entityId: z.string().trim().min(1),
              operation: z.literal(operation),
            })
            .strict(),
          retentionClass: "durable",
          agUiMapping: "unmapped",
          acpMapping: "unmapped",
        }) satisfies RuntimeEventDefinition,
    ),
);

const retainedSessionEventDefinitions = [
  {
    type: "session.created",
    payloadSchema: z.union([
      z
        .object({
          sessionId: z.string().trim().min(1),
          mode: z.enum(["consultation", "run-collaboration"]),
          projectId: z.string().trim().min(1),
        })
        .strict(),
      z
        .object({
          sessionId: z.string().trim().min(1),
          mode: z.literal("run-collaboration"),
          status: z.literal("active"),
        })
        .strict(),
    ]),
  },
  {
    type: "session.participant.added",
    payloadSchema: z
      .object({
        sessionId: z.string().trim().min(1),
        participantType: z.enum(["human", "ai-member", "system"]),
        role: z.string().trim().min(1),
      })
      .strict(),
  },
  {
    type: "session.closed",
    payloadSchema: z
      .object({
        sessionId: z.string().trim().min(1),
        status: z.literal("closed"),
      })
      .strict(),
  },
  {
    type: "session.message.created",
    payloadSchema: z
      .object({
        sessionId: z.string().trim().min(1),
        messageId: z.string().trim().min(1),
        participantId: z.string().trim().min(1),
        kind: z.enum(["text", "tool", "status"]),
        content: z.string(),
      })
      .strict(),
  },
] as const;

const retainedMemoryCandidateCreatedPayloadSchema = z
  .object({
    candidateId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    scope: z.enum(["project", "ai-member"]),
    status: z.literal("pending"),
  })
  .strict();

const retainedMemoryEventDefinitions = [
  {
    type: "memory.candidate.reviewed",
    payloadSchema: z
      .object({
        candidateId: z.string().trim().min(1),
        status: z.enum(["approved", "rejected"]),
        recordId: z.string().trim().min(1).nullable(),
      })
      .strict(),
  },
] as const;

const applicationRegisteredPayloadSchema = z
  .object({
    applicationId: z.string().trim().min(1),
    repositoryReference: z.string().trim().min(1),
    applicationKey: z.string().trim().min(1),
    revision: z.literal(1),
  })
  .strict();

const workspaceAllocationPayloadSchema = z
  .object({
    allocationId: z.string().trim().min(1),
    state: z.enum([
      "planned",
      "provisioning",
      "ready",
      "failed",
      "cleanup-pending",
      "cleaned",
    ]),
    sourceBranch: z.string().trim().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    expectedSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .passthrough();

const sourceImportPayloadSchema = z
  .object({
    importId: z.string().trim().min(1),
    allocationId: z.string().trim().min(1),
    state: z.enum(["intent", "running", "succeeded", "failed", "unknown"]),
    beforeSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    resultCommit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .passthrough();

const workPackageEventPayloadSchema = z
  .object({
    workPackageId: z.string().trim().min(1),
    workPackageVersionId: z.string().trim().min(1),
    state: z.enum([
      "ready",
      "assigned",
      "running",
      "self-check",
      "blocked",
      "failed",
    ]),
  })
  .passthrough();

const codeReviewEventPayloadSchema = z
  .object({
    codeReviewId: z.string().trim().min(1),
    workPackageId: z.string().trim().min(1),
    workPackageVersionId: z.string().trim().min(1),
  })
  .passthrough();

const integrationEventPayloadSchema = z
  .object({
    generationId: z.string().trim().min(1),
    state: z.enum([
      "pending",
      "running",
      "validating",
      "aggregate-review",
      "blocked",
      "failed",
      "passed",
    ]),
  })
  .passthrough();

const testCaseRevisedPayloadSchema = z
  .object({
    testCaseRevisionId: z.string().trim().min(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const testRunAcceptedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    state: z.literal("scheduled"),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const testRunExecutionPayloadSchema = (
  state: "running" | "reconciling" | "unknown" | "failed" | "cancelled",
) =>
  z
    .object({
      testRunId: z.string().trim().min(1),
      state: z.literal(state),
      operationId: z.string().trim().min(1),
    })
    .strict();

const testAssertionRecordedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    testCaseRevisionId: z.string().trim().min(1),
    assertionId: z.string().trim().min(1),
  })
  .strict();

const testEvidenceRecordedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    evidenceId: z.string().trim().min(1),
  })
  .strict();

const testDefectCreatedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    defectId: z.string().trim().min(1),
    operationId: z.string().trim().min(1).optional(),
  })
  .strict();

const testDefectClosedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    defectId: z.string().trim().min(1),
  })
  .strict();

const testRunCompletedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    state: z.literal("passed"),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    passAuthorityHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const testRunBlockedPayloadSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    state: z.literal("blocked"),
  })
  .strict();

const applicationSpecRevisedPayloadSchema = z
  .object({
    applicationSpecId: z.string().trim().min(1),
    applicationSpecRevisionId: z.string().trim().min(1),
    applicationSpecRevision: z.number().int().positive(),
    applicationSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    promotedProjectSpecRevisionId: z.string().trim().min(1),
    promotedProjectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    supersedesRevisionId: z.string().trim().min(1).nullable(),
  })
  .strict();

const technicalProposalRevisedPayloadSchema = z
  .object({
    technicalBaselineProposalId: z.string().trim().min(1),
    proposalRevisionId: z.string().trim().min(1),
    proposalRevision: z.number().int().positive(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    promotedProjectSpecRevisionId: z.string().trim().min(1),
    promotedProjectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    applicationSpecRevisionIds: z.array(z.string().trim().min(1)),
    contractRefs: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          version: z.string().trim().min(1),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    supersedesRevisionId: z.string().trim().min(1).nullable(),
  })
  .strict();

const technicalGatePassedPayloadSchema = z
  .object({
    promotionId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    qualityGateResultId: z.string().trim().min(1),
    proposalRevisionId: z.string().trim().min(1),
    proposalRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const technicalBaselineAcceptedPayloadSchema = z
  .object({
    promotionId: z.string().trim().min(1),
    technicalBaselineId: z.string().trim().min(1),
    technicalBaselineHash: z.string().regex(/^[a-f0-9]{64}$/),
    applicationSpecRevisionIds: z.array(z.string().trim().min(1)),
  })
  .strict();

const artifactEventPayloadSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    artifactVersionId: z.string().trim().min(1),
    contentKind: z
      .enum(["managed-file", "repository-object", "external-reference"])
      .optional(),
    integrityStatus: z.enum(["verified", "unavailable", "failed"]).optional(),
  })
  .passthrough();

const memoryEventPayloadSchema = z
  .object({
    candidateId: z.string().trim().min(1).optional(),
    candidateRevisionId: z.string().trim().min(1).optional(),
    candidateRevisionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    decisionId: z.string().trim().min(1).optional(),
    entryId: z.string().trim().min(1).nullable().optional(),
    entryHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    snapshotRevisionId: z.string().trim().min(1).optional(),
    snapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .passthrough();

const productProposalEventPayloadSchema = z
  .object({
    productProposalId: z.string().trim().min(1),
    proposalRevisionId: z.string().trim().min(1),
    proposalRevision: z.number().int().positive(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["clarifying", "awaiting-confirmation"]),
  })
  .strict();

const productBaselineConfirmedPayloadSchema = z
  .object({
    productBaselineId: z.string().trim().min(1),
    sourceProposalRevisionId: z.string().trim().min(1),
    sourceProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string().trim().min(1),
    snapshotRevisionId: z.string().trim().min(1),
    agentOverrideId: z.string().trim().min(1).nullable().optional(),
    parentRunId: z.string().trim().min(1).optional(),
    forkedFromSnapshotRevisionId: z.string().trim().min(1).optional(),
    confirmedBy: z.object({
      type: z.literal("human"),
      id: z.string().trim().min(1),
      authenticatedBy: z.literal("local-session"),
    }),
  })
  .strict();

const projectSpecRevisedPayloadSchema = z
  .object({
    projectSpecId: z.string().trim().min(1),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecRevision: z.number().int().positive(),
    projectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    productBaselineId: z.string().trim().min(1),
    productBaselineHash: z.string().regex(/^[a-f0-9]{64}$/),
    supersedesRevisionId: z.string().trim().min(1).nullable(),
  })
  .strict();

const productReadinessPayloadSchema = z
  .object({
    evidenceId: z.string().trim().min(1),
    checkKey: z.string().trim().min(1),
    status: z.enum(["ready", "blocked"]),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceRefs: z.array(z.string().trim().min(1)),
  })
  .strict();

const productGatePassedPayloadSchema = z
  .object({
    promotionId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    qualityGateResultId: z.string().trim().min(1),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
    readinessEvidenceIds: z.array(z.string().trim().min(1)),
  })
  .strict();

const snapshotPromotedPayloadSchema = z
  .object({
    promotionId: z.string().trim().min(1),
    sourceSnapshotRevisionId: z.string().trim().min(1),
    snapshotRevisionId: z.string().trim().min(1),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const departmentRunFormalizedPayloadSchema = z
  .object({
    runId: z.string().trim().min(1),
    productBaselineId: z.string().trim().min(1),
    snapshotRevisionId: z.string().trim().min(1),
    status: z.literal("ready"),
    agentOverrideId: z.string().trim().min(1).nullable().optional(),
    parentRunId: z.string().trim().min(1).optional(),
    forkedFromSnapshotRevisionId: z.string().trim().min(1).optional(),
  })
  .strict();

const pipelineNodeEventPayloadSchema = z
  .object({
    status: z.string().trim().min(1).optional(),
    runStatus: z.string().trim().min(1).optional(),
    failureCode: z.string().trim().min(1).optional(),
    decision: z.string().trim().min(1).optional(),
  })
  .passthrough();

const pipelineRunEventPayloadSchema = z
  .object({ status: z.string().trim().min(1).optional() })
  .passthrough();

const interactionTurnEventPayloadSchema = z
  .object({
    status: z
      .enum([
        "running",
        "reconciling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ])
      .optional(),
    operationKey: z.string().trim().min(1).optional(),
    executionLeaseId: z.string().trim().min(1).optional(),
    executionEpoch: z.number().int().positive().optional(),
    mechanism: z.literal("model-only").optional(),
    mechanismVersion: z.string().trim().min(1).optional(),
    contextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    contextSchemaHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    messageId: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    terminalExecutionFactId: z.string().trim().min(1).optional(),
    failureCode: z.string().trim().min(1).optional(),
  })
  .passthrough();

const toolCallEventPayloadSchema = z
  .object({
    toolCallId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    args: z.unknown(),
    evidenceRefs: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const toolResultEventPayloadSchema = z
  .object({
    toolCallId: z.string().trim().min(1),
    content: z.unknown(),
    messageId: z.string().trim().min(1).optional(),
    evidenceRefs: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const permissionEventPayloadSchema = z
  .object({
    permissionId: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    status: z.enum(["pending", "approved", "denied", "expired"]),
  })
  .passthrough();

const executionEventPayloadSchema = z
  .object({
    operationKey: z.string().trim().min(1),
    executionFactId: z.string().trim().min(1).optional(),
    factId: z.string().trim().min(1).optional(),
    ordinal: z.number().int().positive().optional(),
    kind: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1),
  })
  .passthrough();

const reviewEventPayloadSchema = z
  .object({
    topicId: z.string().trim().min(1),
    status: z.string().trim().min(1).optional(),
    revision: z.number().int().positive().optional(),
    manifestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    findingId: z.string().trim().min(1).optional(),
    qualityGateResultId: z.string().trim().min(1).optional(),
    result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]).optional(),
  })
  .passthrough();

const deliveryCandidateInputEventPayloadSchema = z
  .object({
    deliveryCandidateInputId: z.string().trim().min(1),
    manifestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    authorityId: z.string().trim().min(1).optional(),
    authorityHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    riskTier: z.enum(["low", "medium", "high", "critical"]).optional(),
    state: z.string().trim().min(1).optional(),
  })
  .passthrough();

const candidateGateEventPayloadSchema = z
  .object({
    candidateGateInputId: z.string().trim().min(1),
    candidateGateResultId: z.string().trim().min(1).optional(),
    executionId: z.string().trim().min(1).optional(),
    kind: z.enum(["security", "operability"]).optional(),
    result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]).optional(),
    manifestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resultHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    requestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    state: z.string().trim().min(1).optional(),
  })
  .passthrough();

const pipelineEventDefinitions = [
  "run.created",
  "run.started",
  "run.forked",
  "run.paused",
  "run.resumed",
  "run.blocked",
  "run.cancelled",
  "run.intervention.recorded",
  "snapshot.revision.created",
  "node.queued",
  "node.started",
  "node.skipped",
  "node.waiting-approval",
  "node.succeeded",
  "node.failed",
  "node.status.changed",
  "node.condition.selected",
  "attempt.ready",
  "attempt.started",
  "attempt.reconciling",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.interrupted",
  "attempt.lease.renewed",
  "approval.requested",
  "approval.decided",
  "approval.request-changes",
  "approval.expired",
] as const;

const definitions = [
  {
    type: "project.created",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId"],
    payloadSchema: projectEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "unmapped",
    acpMapping: "unmapped",
  },
  {
    type: "project.updated",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId"],
    payloadSchema: projectEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "unmapped",
    acpMapping: "unmapped",
  },
  {
    type: "project.deleted",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId"],
    payloadSchema: projectEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "unmapped",
    acpMapping: "unmapped",
  },
  ...retainedCatalogEventDefinitions,
  ...retainedSessionEventDefinitions.map(
    (definition) =>
      ({
        ...definition,
        schemaVersion: 1,
        requiredTopLevelIds: ["companyId"],
        retentionClass: "durable",
        agUiMapping: "unmapped",
        acpMapping: "unmapped",
      }) satisfies RuntimeEventDefinition,
  ),
  ...retainedMemoryEventDefinitions.map(
    (definition) =>
      ({
        ...definition,
        schemaVersion: 1,
        requiredTopLevelIds: ["companyId"],
        retentionClass: "durable",
        agUiMapping: "unmapped",
        acpMapping: "unmapped",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "application.registered",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId", "applicationId"],
    payloadSchema: applicationRegisteredPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...[
    "workspace-allocation.planned",
    "workspace-allocation.ready",
    "workspace-allocation.failed",
    "workspace-allocation.cleanup-requested",
    "workspace-allocation.cleaned",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "applicationId",
          "workspaceAllocationId",
        ],
        payloadSchema: workspaceAllocationPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  ...[
    "source-import.planned",
    "source-import.completed",
    "source-import.failed",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "applicationId",
          "workspaceAllocationId",
        ],
        payloadSchema: sourceImportPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "application-spec.revised",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "applicationId",
      "applicationSpecRevisionId",
      "projectSpecRevisionId",
      "runId",
    ],
    payloadSchema: applicationSpecRevisedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "technical-proposal.revised",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "technicalBaselineProposalId",
      "projectSpecRevisionId",
      "runId",
    ],
    payloadSchema: technicalProposalRevisedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "technical-gate.passed",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "technicalBaselineProposalId",
      "technicalBaselineId",
      "projectSpecRevisionId",
      "snapshotRevisionId",
      "runId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: technicalGatePassedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "technical-baseline.accepted",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "technicalBaselineProposalId",
      "technicalBaselineId",
      "projectSpecRevisionId",
      "snapshotRevisionId",
      "runId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: technicalBaselineAcceptedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...["product.proposal.revised", "product.proposal.awaiting-confirmation"].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: ["companyId", "projectId", "productProposalId"],
        payloadSchema: productProposalEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "product.baseline.confirmed",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId", "productBaselineId"],
    payloadSchema: productBaselineConfirmedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "spec.revised",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "productBaselineId",
      "projectSpecRevisionId",
      "runId",
    ],
    payloadSchema: projectSpecRevisedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "product-readiness.recorded",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "productBaselineId",
      "projectSpecRevisionId",
      "runId",
    ],
    payloadSchema: productReadinessPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "product-gate.passed",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "productBaselineId",
      "projectSpecRevisionId",
      "snapshotRevisionId",
      "runId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: productGatePassedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "snapshot.promoted",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "projectSpecRevisionId",
      "snapshotRevisionId",
      "runId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: snapshotPromotedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "department-run.formalized",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "departmentId",
      "productBaselineId",
      "runId",
      "snapshotRevisionId",
    ],
    payloadSchema: departmentRunFormalizedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...[
    "review.scheduled",
    "review.finding.created",
    "review.finding.dispositioned",
    "review.discussion.round",
    "review.revision.created",
    "review.recheck.completed",
    "quality-gate.completed",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "topicId",
          ...(type.startsWith("review.finding.")
            ? (["reviewFindingId"] as const)
            : []),
          ...(type === "quality-gate.completed"
            ? (["qualityGateResultId"] as const)
            : []),
        ],
        payloadSchema: reviewEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "memory.candidate.created",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId"],
    payloadSchema: z.union([
      retainedMemoryCandidateCreatedPayloadSchema,
      memoryEventPayloadSchema,
    ]),
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "memory.review.started",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "memoryCandidateId",
      "topicId",
    ],
    payloadSchema: memoryEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "memory.reviewed",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "memoryCandidateId",
      "topicId",
    ],
    payloadSchema: memoryEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "memory.accepted",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "memoryCandidateId",
      "memoryEntryId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: memoryEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "memory.rejected",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "memoryCandidateId",
      "topicId",
      "qualityGateResultId",
    ],
    payloadSchema: memoryEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  {
    type: "memory.selected",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "runId",
      "snapshotRevisionId",
      "memoryEntryId",
    ],
    payloadSchema: memoryEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...[
    "artifact.registered",
    "artifact.finalized",
    "artifact.integrity-failed",
    "artifact.superseded",
    "artifact.version.created",
    "artifact.version.status.changed",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "artifactId",
          "artifactVersionId",
        ],
        payloadSchema: artifactEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  ...pipelineEventDefinitions.map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "departmentId",
          "runId",
        ],
        payloadSchema:
          type.startsWith("run.") || type === "snapshot.revision.created"
            ? pipelineRunEventPayloadSchema
            : pipelineNodeEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  ...[
    "work-package.ready",
    "work-package.versioned",
    "work-package.assigned",
    "work-package.blocked",
    "work-package.started",
    "work-package.self-check",
    "work-package.failed",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "runId",
          "workPackageId",
          "workPackageVersionId",
        ],
        payloadSchema: workPackageEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  ...[
    "code-review.planned",
    "code-review.workspace.ready",
    "code-review.workspace.blocked",
    "code-review.workspace.unknown",
    "code-review.execution.started",
    "code-review.execution.completed",
    "code-review.execution.blocked",
    "code-review.execution.unknown",
    "code-review.authority.created",
    "code-review.defect.created",
    "code-review.defect.closed",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "runId",
          "topicId",
          "workPackageId",
          "workPackageVersionId",
        ],
        payloadSchema: codeReviewEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  ...[
    "integration.generation.started",
    "integration.generation.validating",
    "integration.validation.recorded",
    "integration.generation.aggregate-review",
    "integration.generation.blocked",
    "integration.generation.failed",
    "integration.generation.completed",
    "integration.operation.intent-recorded",
    "integration.operation.finalized",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "runId",
          "nodeRunId",
          "integrationGenerationId",
          ...(type.startsWith("integration.operation.")
            ? (["integrationOperationId", "commandId"] as const)
            : []),
        ],
        payloadSchema: integrationEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "test.case.revised",
    schemaVersion: 1,
    requiredTopLevelIds: ["companyId", "projectId", "testCaseRevisionId"],
    payloadSchema: testCaseRevisedPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...(
    [
      ["test.run.accepted", testRunAcceptedPayloadSchema, []],
      ["test.run.started", testRunExecutionPayloadSchema("running"), []],
      [
        "test.run.reconciling",
        testRunExecutionPayloadSchema("reconciling"),
        [],
      ],
      ["test.run.unknown", testRunExecutionPayloadSchema("unknown"), []],
      [
        "test.assertion.recorded",
        testAssertionRecordedPayloadSchema,
        ["testCaseRevisionId"],
      ],
      ["test.evidence.recorded", testEvidenceRecordedPayloadSchema, []],
      ["test.defect.created", testDefectCreatedPayloadSchema, ["defectId"]],
      ["test.defect.closed", testDefectClosedPayloadSchema, ["defectId"]],
      ["test.run.completed", testRunCompletedPayloadSchema, []],
      ["test.run.failed", testRunExecutionPayloadSchema("failed"), []],
      ["test.run.blocked", testRunBlockedPayloadSchema, []],
      ["test.run.cancelled", testRunExecutionPayloadSchema("cancelled"), []],
    ] as const
  ).map(
    ([type, payloadSchema, additionalTopLevelIds]) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "runId",
          "nodeRunId",
          "testRunId",
          ...additionalTopLevelIds,
        ],
        payloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "delivery.candidate-input.frozen",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "runId",
      "deliveryCandidateInputId",
    ],
    payloadSchema: deliveryCandidateInputEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...[
    "quality-gate.input.prepared",
    "quality-gate.execution.accepted",
    "quality-gate.execution.reconciled",
    "quality-gate.result.recorded",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "runId",
          "deliveryCandidateInputId",
          "candidateGateInputId",
        ],
        payloadSchema: candidateGateEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "delivery.candidate-input.authorized",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "runId",
      "deliveryCandidateInputId",
    ],
    payloadSchema: deliveryCandidateInputEventPayloadSchema,
    retentionClass: "durable",
    agUiMapping: "custom",
    acpMapping: "custom",
  },
  ...[
    "interaction.turn.started",
    "interaction.turn.reconciling",
    "message.delta",
    "usage.recorded",
    "interaction.turn.completed",
    "interaction.turn.failed",
    "interaction.turn.cancelled",
    "interaction.turn.interrupted",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "sessionId",
          "interactionTurnId",
        ],
        payloadSchema: interactionTurnEventPayloadSchema,
        retentionClass: type === "message.delta" ? "standard" : "durable",
        agUiMapping: type === "message.delta" ? "mapped" : "custom",
        acpMapping: type === "message.delta" ? "mapped" : "custom",
      }) satisfies RuntimeEventDefinition,
  ),
  {
    type: "tool.call",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "sessionId",
      "interactionTurnId",
    ],
    payloadSchema: toolCallEventPayloadSchema,
    retentionClass: "standard",
    agUiMapping: "mapped",
    acpMapping: "mapped",
  },
  {
    type: "tool.result",
    schemaVersion: 1,
    requiredTopLevelIds: [
      "companyId",
      "projectId",
      "sessionId",
      "interactionTurnId",
    ],
    payloadSchema: toolResultEventPayloadSchema,
    retentionClass: "standard",
    agUiMapping: "mapped",
    acpMapping: "mapped",
  },
  ...["permission.requested", "permission.decided"].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: ["companyId"],
        payloadSchema: permissionEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "mapped",
      }) satisfies RuntimeEventDefinition,
  ),
  ...[
    "execution.leased",
    "execution.fact.accepted",
    "execution.fact.stale",
    "execution.fact.conflict",
    "execution.completed",
    "execution.failed",
    "execution.cancelled",
    "execution.lease.lost",
    "execution.interrupted",
    "execution.reattached",
  ].map(
    (type) =>
      ({
        type,
        schemaVersion: 1,
        requiredTopLevelIds: [
          "companyId",
          "projectId",
          "departmentId",
          "runId",
          "nodeRunId",
          "nodeAttemptId",
        ],
        payloadSchema: executionEventPayloadSchema,
        retentionClass: "durable",
        agUiMapping: "custom",
        acpMapping: "custom",
      }) satisfies RuntimeEventDefinition,
  ),
] as const satisfies readonly RuntimeEventDefinition[];

export interface RuntimeEventRegistry {
  readonly version: number;
  readonly list: () => readonly RuntimeEventDefinition[];
  readonly get: (type: string) => RuntimeEventDefinition | undefined;
  readonly validate: (input: {
    readonly type: string;
    readonly scope: RuntimeEventScope;
    readonly payload: unknown;
    readonly schemaVersion?: number;
  }) => RuntimeEventDefinition;
}

export const createRuntimeEventRegistry = (): RuntimeEventRegistry => {
  const entries = new Map<string, RuntimeEventDefinition>(
    definitions.map((definition) => [definition.type, definition]),
  );
  return {
    version: RUNTIME_EVENT_REGISTRY_VERSION,
    list: () => [...definitions],
    get: (type) => entries.get(type),
    validate: (input) => {
      const definition = entries.get(input.type);
      if (!definition) {
        throw new RuntimeEventRegistryError(
          "RUNTIME_EVENT_UNREGISTERED",
          `Runtime event ${input.type} is not registered.`,
        );
      }
      if (
        input.schemaVersion !== undefined &&
        input.schemaVersion !== definition.schemaVersion
      ) {
        throw new RuntimeEventRegistryError(
          "RUNTIME_EVENT_SCHEMA_UNSUPPORTED",
          `Runtime event ${input.type} schema ${input.schemaVersion} is not registered.`,
        );
      }
      const missing = definition.requiredTopLevelIds.filter(
        (id) => !input.scope[id],
      );
      if (missing.length > 0) {
        throw new RuntimeEventRegistryError(
          "RUNTIME_EVENT_SCOPE_INVALID",
          `Runtime event ${input.type} requires top-level ${missing.join(", ")}.`,
        );
      }
      try {
        definition.payloadSchema.parse(input.payload);
      } catch (error) {
        throw new RuntimeEventRegistryError(
          "RUNTIME_EVENT_PAYLOAD_INVALID",
          `Runtime event ${input.type} payload is invalid: ${String(error)}`,
        );
      }
      return definition;
    },
  };
};
