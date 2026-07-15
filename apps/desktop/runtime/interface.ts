import { z } from "zod";

export const RuntimeHealthSchema = z.object({
  status: z.literal("ok"),
  schemaVersion: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
});

export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;

export const CompanyOverviewSchema = z.object({
  company: z.object({ id: z.string(), name: z.string() }),
  metrics: z.object({
    activeRuns: z.number().int().nonnegative(),
    waitingApprovalRuns: z.number().int().nonnegative(),
    blockedRuns: z.number().int().nonnegative(),
    completedRuns: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    departments: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
  }),
  attention: z.array(
    z.object({
      kind: z.enum(["approval", "failure"]),
      runId: z.string(),
      title: z.string(),
    }),
  ),
});

export type CompanyOverview = z.infer<typeof CompanyOverviewSchema>;

export const CompanyProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
});

export type CompanyProject = z.infer<typeof CompanyProjectSchema>;

export const ProjectEditorViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().nonnegative(),
  sharedContext: z.string(),
  repositoryReferences: z.array(z.string()),
  departmentRuns: z.array(
    z.object({
      id: z.string(),
      departmentId: z.string(),
      status: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
  createdAt: z.string().datetime(),
});

export type ProjectEditorView = z.infer<typeof ProjectEditorViewSchema>;

export const CompanyDepartmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().nonnegative(),
  builtIn: z.boolean(),
  activeRuns: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  publishedPipelineVersion: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
});

export type CompanyDepartment = z.infer<typeof CompanyDepartmentSchema>;

export const ArtifactContractSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  artifactType: z.string().trim().min(1),
  schemaVersion: z.string().trim().min(1),
  required: z.boolean(),
});

export type ArtifactContract = z.infer<typeof ArtifactContractSchema>;

export const ArtifactVersionViewSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  projectId: z.string(),
  type: z.string(),
  schemaVersion: z.string(),
  logicalName: z.string(),
  version: z.number().int().positive(),
  contentRef: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(),
  status: z.enum(["draft", "produced", "accepted", "rejected", "superseded"]),
  producer: z.object({
    runId: z.string(),
    nodeRunId: z.string(),
    nodeAttemptId: z.string(),
    snapshotRevisionId: z.string(),
    aiMemberId: z.string(),
  }),
  createdAt: z.string().datetime(),
});

export type ArtifactVersionView = z.infer<typeof ArtifactVersionViewSchema>;

export const ArtifactLineageViewSchema = z.object({
  version: ArtifactVersionViewSchema,
  inputs: z.array(z.object({ versionId: z.string(), relation: z.string() })),
});

export type ArtifactLineageView = z.infer<typeof ArtifactLineageViewSchema>;

export const SecretReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerScope: z.string(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export type SecretReference = z.infer<typeof SecretReferenceSchema>;

export const ExecutionProfileSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  name: z.string(),
  providerRef: z.string(),
  model: z.string(),
  sandboxRef: z.string(),
  branchStrategy: z.enum(["head", "merge-to-head", "branch"]),
  limits: z.object({
    timeoutSeconds: z.number().int().positive(),
    maxIterations: z.number().int().positive(),
    maxTokens: z.number().int().positive().nullable(),
  }),
  retryPolicy: z.object({
    maxAttempts: z.number().int().nonnegative(),
  }),
  permissionPolicy: z.enum(["ask", "allow-safe", "deny"]),
  secretReferenceIds: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const SkillFlowSnapshotSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  instructions: z.string(),
  skillIds: z.array(z.string()),
});

export const DepartmentPipelineNodeSchema = z.object({
  id: z.string(),
  type: z.enum([
    "start",
    "ai-task",
    "human-approval",
    "condition",
    "parallel",
    "join",
    "complete",
  ]),
  name: z.string(),
  positionId: z.string().optional(),
  skillFlowId: z.string().optional(),
  skillFlowSnapshot: SkillFlowSnapshotSchema.optional(),
  instructions: z.string().optional(),
  executionProfileId: z.string().optional(),
  inputContractRefs: z.array(z.string()).optional(),
  outputContractRefs: z.array(z.string()).optional(),
  timeoutSeconds: z.number().int().optional(),
  retryMaxAttempts: z.number().int().optional(),
  maxIterations: z.number().int().optional(),
  maxTokens: z.number().int().nullable().optional(),
  approvalTitle: z.string().optional(),
  approvalPolicy: z.enum(["any", "all", "named"]).optional(),
  approverReference: z.string().optional(),
  condition: z
    .object({
      leftReference: z.string(),
      operator: z.enum(["equals", "not-equals", "exists", "not-exists", "in"]),
      value: z
        .union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
          z.null(),
        ])
        .optional(),
      branches: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          kind: z.enum(["match", "no-match", "default"]),
        }),
      ),
    })
    .strict()
    .optional(),
});

export const DepartmentPipelineEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  branchId: z.string().optional(),
});

export const DepartmentPipelineGraphSchema = z.object({
  nodes: z.array(DepartmentPipelineNodeSchema),
  edges: z.array(DepartmentPipelineEdgeSchema),
});

export const DepartmentPipelineDraftNodeSchema =
  DepartmentPipelineNodeSchema.omit({ skillFlowSnapshot: true }).extend({
    type: z.string(),
  });

export const DepartmentPipelineDraftGraphSchema = z.object({
  nodes: z.array(DepartmentPipelineDraftNodeSchema),
  edges: z.array(DepartmentPipelineEdgeSchema),
});

export type DepartmentPipelineDraftGraph = z.infer<
  typeof DepartmentPipelineDraftGraphSchema
>;

export const PipelineValidationIssueSchema = z.object({
  code: z.string(),
  messageKey: z.string(),
  nodeId: z.string().optional(),
  edge: DepartmentPipelineEdgeSchema.optional(),
});

export const PipelineValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(PipelineValidationIssueSchema),
});

export type PipelineValidationResult = z.infer<
  typeof PipelineValidationResultSchema
>;

export const DepartmentPipelineEditorViewSchema = z.object({
  department: z.object({ id: z.string(), name: z.string() }),
  positions: z.array(z.object({ id: z.string(), name: z.string() })),
  draft: z.object({
    revision: z.number().int().nonnegative(),
    graph: DepartmentPipelineDraftGraphSchema,
    updatedAt: z.string().datetime().nullable(),
  }),
  validation: PipelineValidationResultSchema,
  published: z
    .object({
      id: z.string(),
      version: z.number().int().positive(),
      graph: DepartmentPipelineGraphSchema,
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      publishedAt: z.string().datetime(),
    })
    .nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      version: z.number().int().positive(),
      graph: DepartmentPipelineGraphSchema,
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      publishedAt: z.string().datetime(),
      nodeCount: z.number().int().nonnegative(),
      edgeCount: z.number().int().nonnegative(),
    }),
  ),
});

export type DepartmentPipelineEditorView = z.infer<
  typeof DepartmentPipelineEditorViewSchema
>;

export const DepartmentInspectSchema = CompanyDepartmentSchema.omit({
  positionCount: true,
  publishedPipelineVersion: true,
}).extend({
  inputArtifactContracts: ArtifactContractSchema.array(),
  outputArtifactContracts: ArtifactContractSchema.array(),
  defaultExecutionProfileId: z.string().nullable(),
  executionProfiles: ExecutionProfileSchema.array(),
  secretReferences: SecretReferenceSchema.array(),
  positions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      responsibility: z.string(),
      revision: z.number().int().nonnegative(),
      status: z.enum(["active", "archived"]),
      aiMember: z.object({
        id: z.string(),
        displayName: z.string(),
        profile: z.string(),
        responsibilityMetadata: z.record(z.string(), z.string()),
        status: z.enum(["active", "inactive"]),
        positionId: z.string(),
      }),
    }),
  ),
  pipeline: z
    .object({
      id: z.string(),
      version: z.number().int().positive(),
      status: z.literal("published"),
      publishedAt: z.string().datetime(),
      nodes: DepartmentPipelineNodeSchema.array(),
      edges: DepartmentPipelineEdgeSchema.array(),
    })
    .nullable(),
});

export type DepartmentInspect = z.infer<typeof DepartmentInspectSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  version: z.string(),
  locationReference: z.string(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export type Skill = z.infer<typeof SkillSchema>;

export const SkillFlowSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  positionId: z.string(),
  name: z.string(),
  instructions: z.string(),
  skillIds: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export type SkillFlow = z.infer<typeof SkillFlowSchema>;

export const SkillConfigurationViewSchema = z.object({
  department: z.object({ id: z.string(), name: z.string() }),
  revision: z.number().int().nonnegative(),
  activeSkills: SkillSchema.array(),
  archivedSkills: SkillSchema.pick({
    id: true,
    name: true,
    source: true,
    version: true,
    archivedAt: true,
  }).array(),
  positions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      skillIds: z.array(z.string()),
    }),
  ),
  skillFlows: SkillFlowSchema.array(),
  pipelineNodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      positionId: z.string().optional(),
      skillFlowId: z.string().optional(),
    }),
  ),
});

export type SkillConfigurationView = z.infer<
  typeof SkillConfigurationViewSchema
>;

export const DepartmentRunStatusSchema = z.enum([
  "ready",
  "running",
  "waiting-approval",
  "blocked",
  "failed",
  "recovering",
  "completed",
  "paused",
  "cancelled",
]);

export type DepartmentRunStatus = z.infer<typeof DepartmentRunStatusSchema>;

export const NodeRunStatusSchema = z.enum([
  "queued",
  "ready",
  "running",
  "waiting-permission",
  "waiting-approval",
  "paused",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

const RunSnapshotProjectSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  goal: z.string(),
  sharedContext: z.string(),
  repositoryReferences: z.array(z.string()),
});

const RunSnapshotDepartmentSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  description: z.string(),
  inputArtifactContracts: ArtifactContractSchema.array(),
  outputArtifactContracts: ArtifactContractSchema.array(),
  defaultExecutionProfileId: z.string().nullable(),
});

const RunSnapshotPositionSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  responsibility: z.string(),
  aiMember: z.object({
    id: z.string(),
    displayName: z.string(),
    profile: z.string(),
    responsibilityMetadata: z.record(z.string(), z.string()),
    status: z.enum(["active", "inactive"]),
  }),
});

const RunSnapshotExecutionProfileSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  providerRef: z.string(),
  model: z.string(),
  sandboxRef: z.string(),
  branchStrategy: z.enum(["head", "merge-to-head", "branch"]),
  limits: z.object({
    timeoutSeconds: z.number().int().positive(),
    maxIterations: z.number().int().positive(),
    maxTokens: z.number().int().positive().nullable(),
  }),
  retryPolicy: z.object({ maxAttempts: z.number().int().nonnegative() }),
  permissionPolicy: z.enum(["ask", "allow-safe", "deny"]),
  secretReferenceIds: z.array(z.string()),
});

export const RunSnapshotPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  project: RunSnapshotProjectSchema,
  department: RunSnapshotDepartmentSchema,
  pipelineVersion: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    graph: DepartmentPipelineGraphSchema,
  }),
  skillFlows: SkillFlowSnapshotSchema.array(),
  positions: RunSnapshotPositionSchema.array(),
  executionProfiles: RunSnapshotExecutionProfileSchema.array(),
  runLimits: z.object({ maxActiveNodes: z.number().int().positive() }),
});

export type RunSnapshotPayload = z.infer<typeof RunSnapshotPayloadSchema>;

export const RunSnapshotSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  parentRevision: z.number().int().positive().nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalJson: z.string(),
  payload: RunSnapshotPayloadSchema,
});

export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const DepartmentRunViewSchema = z.object({
  run: z.object({
    id: z.string(),
    projectId: z.string(),
    departmentId: z.string(),
    pipelineVersionId: z.string(),
    snapshotRevisionId: z.string(),
    parentRunId: z.string().nullable(),
    forkedFromSnapshotRevisionId: z.string().nullable(),
    status: DepartmentRunStatusSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  snapshot: RunSnapshotSchema,
  nodes: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      pipelineNodeId: z.string(),
      nodeType: DepartmentPipelineNodeSchema.shape.type,
      status: NodeRunStatusSchema,
      attemptCount: z.number().int().nonnegative(),
      attempts: z.array(
        z.object({
          id: z.string(),
          attemptNumber: z.number().int().positive(),
          snapshotRevisionId: z.string(),
          reason: z.enum(["initial", "request-changes", "retry", "recovery"]),
          recoverable: z.boolean(),
          status: z.enum([
            "ready",
            "running",
            "succeeded",
            "failed",
            "cancelled",
          ]),
          result: z.unknown().nullable(),
          failure: z
            .object({ code: z.string(), message: z.string() })
            .nullable(),
          feedback: z.array(
            z.object({
              id: z.string(),
              kind: z.enum(["request-changes", "retry"]),
              content: z.string(),
              sourceApprovalId: z.string().nullable(),
              createdAt: z.string().datetime(),
            }),
          ),
          createdAt: z.string().datetime(),
          startedAt: z.string().datetime().nullable(),
          completedAt: z.string().datetime().nullable(),
        }),
      ),
      approvals: z.array(
        z.object({
          id: z.string(),
          cycle: z.number().int().positive(),
          status: z.enum(["pending", "decided"]),
          decision: z.enum(["approve", "request-changes", "reject"]).nullable(),
          createdAt: z.string().datetime(),
          decidedAt: z.string().datetime().nullable(),
        }),
      ),
      requiredDependencyIds: z.array(z.string()),
      result: z.unknown().nullable(),
      failure: z.object({ code: z.string(), message: z.string() }).nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
});

export type DepartmentRunView = z.infer<typeof DepartmentRunViewSchema>;

export const RuntimeAuditRecordSchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  runId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: z.string().datetime(),
});

export type RuntimeAuditRecord = z.infer<typeof RuntimeAuditRecordSchema>;

export const RuntimeEventRecordSchema = z.object({
  sequence: z.number().int().positive(),
  eventId: z.string(),
  type: z.string(),
  runId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});

export type RuntimeEventRecord = z.infer<typeof RuntimeEventRecordSchema>;

export const InteractionSessionViewSchema = z.object({
  id: z.string(),
  mode: z.enum(["consultation", "run-collaboration"]),
  projectId: z.string(),
  runId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  status: z.enum(["active", "closed"]),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const SessionParticipantViewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  participantType: z.enum(["human", "ai-member", "system"]),
  participantRef: z.string(),
  role: z.string(),
  createdAt: z.string().datetime(),
});

export const SessionMessageViewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  participantId: z.string(),
  kind: z.enum(["text", "tool", "status"]),
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const PermissionRequestViewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  scope: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});

export const InteractionViewSchema = z.object({
  session: InteractionSessionViewSchema,
  participants: z.array(SessionParticipantViewSchema),
  messages: z.array(SessionMessageViewSchema),
  permissions: z.array(PermissionRequestViewSchema),
});

export type InteractionView = z.infer<typeof InteractionViewSchema>;
export type InteractionSessionView = z.infer<
  typeof InteractionSessionViewSchema
>;
export type SessionParticipantView = z.infer<
  typeof SessionParticipantViewSchema
>;
export type SessionMessageView = z.infer<typeof SessionMessageViewSchema>;
export type PermissionRequestView = z.infer<typeof PermissionRequestViewSchema>;

export const AgUiEventSchema = z.object({
  type: z.enum([
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "TEXT_MESSAGE_CONTENT",
    "PERMISSION_REQUESTED",
    "PERMISSION_DECIDED",
    "ARTIFACT_CREATED",
    "RAW_RUNTIME_EVENT",
  ]),
  runId: z.string().nullable(),
  eventId: z.string(),
  sequence: z.number().int().positive(),
  payload: z.unknown(),
});

export const AgUiReplayViewSchema = z.object({
  events: z.array(AgUiEventSchema),
  nextSequence: z.number().int().nonnegative(),
});

export type AgUiReplayView = z.infer<typeof AgUiReplayViewSchema>;

export const MemoryCandidateViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scope: z.enum(["project", "ai-member"]),
  aiMemberId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  sourceArtifactVersionId: z.string().nullable(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "discarded"]),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
});

export const MemoryRecordViewSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  projectId: z.string(),
  scope: z.enum(["project", "ai-member"]),
  ownerId: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

export const MemoryReviewViewSchema = z.object({
  candidate: MemoryCandidateViewSchema,
  record: MemoryRecordViewSchema.nullable(),
});

export type MemoryCandidateView = z.infer<typeof MemoryCandidateViewSchema>;
export type MemoryRecordView = z.infer<typeof MemoryRecordViewSchema>;
export type MemoryReviewView = z.infer<typeof MemoryReviewViewSchema>;

export const RuntimeDiagnosticsViewSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  sqliteIntegrity: z.string(),
  databaseBytes: z.number().int().nonnegative(),
  runtimeEventCount: z.number().int().nonnegative(),
  pendingRuntimeEventCount: z.number().int().nonnegative(),
  auditRecordCount: z.number().int().nonnegative(),
  activeLeaseCount: z.number().int().nonnegative(),
  cursorCount: z.number().int().nonnegative(),
});

export type RuntimeDiagnosticsView = z.infer<
  typeof RuntimeDiagnosticsViewSchema
>;

export const RuntimeBackupViewSchema = z.object({
  path: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type RuntimeBackupView = z.infer<typeof RuntimeBackupViewSchema>;

export const CompanyQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.health") }),
  z.object({ type: z.literal("company.overview") }),
  z.object({ type: z.literal("projects.list") }),
  z.object({ type: z.literal("project.inspect"), projectId: z.string() }),
  z.object({ type: z.literal("departments.list") }),
  z.object({ type: z.literal("department.inspect"), departmentId: z.string() }),
  z.object({
    type: z.literal("department.skill-configuration.inspect"),
    departmentId: z.string(),
  }),
  z.object({
    type: z.literal("department.pipeline.inspect"),
    departmentId: z.string(),
  }),
  z.object({
    type: z.literal("department.pipeline.validate"),
    departmentId: z.string(),
    graph: DepartmentPipelineDraftGraphSchema,
  }),
  z.object({
    type: z.literal("runs.list"),
    projectId: z.string().optional(),
  }),
  z.object({ type: z.literal("run.inspect"), runId: z.string() }),
  z.object({
    type: z.literal("runtime.audit"),
    runId: z.string().optional(),
    limit: z.number().int().positive().max(1_000).optional(),
  }),
  z.object({
    type: z.literal("runtime.events"),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1_000),
  }),
  z.object({
    type: z.literal("runtime.events.consumer"),
    consumerId: z.string().trim().min(1),
    limit: z.number().int().positive().max(1_000),
  }),
  z.object({ type: z.literal("artifacts.list"), projectId: z.string() }),
  z.object({ type: z.literal("artifact.inspect"), versionId: z.string() }),
  z.object({ type: z.literal("interactions.list"), projectId: z.string() }),
  z.object({ type: z.literal("interaction.inspect"), sessionId: z.string() }),
  z.object({
    type: z.literal("ag-ui.events"),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1_000),
  }),
  z.object({
    type: z.literal("memory.candidates.list"),
    projectId: z.string(),
  }),
  z.object({ type: z.literal("memory.records.list"), projectId: z.string() }),
  z.object({ type: z.literal("runtime.diagnostics") }),
]);

export type CompanyQuery = z.infer<typeof CompanyQuerySchema>;

export type CompanyQueryResult<Query extends CompanyQuery> =
  Query["type"] extends "runtime.health"
    ? RuntimeHealth
    : Query["type"] extends "company.overview"
      ? CompanyOverview
      : Query["type"] extends "projects.list"
        ? readonly CompanyProject[]
        : Query["type"] extends "project.inspect"
          ? ProjectEditorView
          : Query["type"] extends "departments.list"
            ? readonly CompanyDepartment[]
            : Query["type"] extends "department.inspect"
              ? DepartmentInspect
              : Query["type"] extends "department.skill-configuration.inspect"
                ? SkillConfigurationView
                : Query["type"] extends "department.pipeline.inspect"
                  ? DepartmentPipelineEditorView
                  : Query["type"] extends "department.pipeline.validate"
                    ? PipelineValidationResult
                    : Query["type"] extends "runs.list"
                      ? readonly DepartmentRunView[]
                      : Query["type"] extends "runtime.audit"
                        ? readonly RuntimeAuditRecord[]
                        : Query["type"] extends
                              | "runtime.events"
                              | "runtime.events.consumer"
                          ? readonly RuntimeEventRecord[]
                          : Query["type"] extends "artifacts.list"
                            ? readonly ArtifactVersionView[]
                            : Query["type"] extends "artifact.inspect"
                              ? ArtifactLineageView
                              : Query["type"] extends "interactions.list"
                                ? readonly InteractionView[]
                                : Query["type"] extends "interaction.inspect"
                                  ? InteractionView
                                  : Query["type"] extends "ag-ui.events"
                                    ? AgUiReplayView
                                    : Query["type"] extends "memory.candidates.list"
                                      ? readonly MemoryCandidateView[]
                                      : Query["type"] extends "memory.records.list"
                                        ? readonly MemoryRecordView[]
                                        : Query["type"] extends "runtime.diagnostics"
                                          ? RuntimeDiagnosticsView
                                          : DepartmentRunView;

export const CompanyCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.shutdown") }),
  z.object({ type: z.literal("runtime.backup") }),
  z.object({
    type: z.literal("artifact.version.status"),
    versionId: z.string().trim().min(1),
    expectedStatus: z.enum([
      "draft",
      "produced",
      "accepted",
      "rejected",
      "superseded",
    ]),
    status: z.enum(["draft", "produced", "accepted", "rejected", "superseded"]),
  }),
  z.object({
    type: z.literal("runtime.events.ack"),
    consumerId: z.string().trim().min(1),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("interaction.session.create"),
    projectId: z.string().trim().min(1),
    mode: z.enum(["consultation", "run-collaboration"]),
    runId: z.string().trim().min(1).optional(),
    nodeRunId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("interaction.session.close"),
    sessionId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("interaction.participant.add"),
    sessionId: z.string().trim().min(1),
    participantType: z.enum(["human", "ai-member", "system"]),
    participantRef: z.string().trim().min(1),
    role: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("interaction.message.add"),
    sessionId: z.string().trim().min(1),
    participantId: z.string().trim().min(1),
    kind: z.enum(["text", "tool", "status"]),
    content: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("permission.request"),
    sessionId: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    expiresAt: z.string().datetime().optional(),
  }),
  z.object({
    type: z.literal("permission.decide"),
    permissionId: z.string().trim().min(1),
    expectedStatus: z.literal("pending"),
    decision: z.enum(["approved", "denied"]),
  }),
  z.object({
    type: z.literal("memory.candidate.create"),
    projectId: z.string().trim().min(1),
    scope: z.enum(["project", "ai-member"]),
    aiMemberId: z.string().trim().min(1).optional(),
    sourceSessionId: z.string().trim().min(1).optional(),
    sourceRunId: z.string().trim().min(1).optional(),
    sourceArtifactVersionId: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1).max(20_000),
  }),
  z.object({
    type: z.literal("memory.candidate.review"),
    candidateId: z.string().trim().min(1),
    expectedStatus: z.literal("pending"),
    decision: z.enum(["approved", "discarded"]),
  }),
  z.object({
    type: z.literal("runtime.events.compact"),
    retainLast: z.number().int().nonnegative().max(100_000),
  }),
  z.object({
    type: z.literal("project.create"),
    name: z.string().trim().min(1),
    goal: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("project.update"),
    projectId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    sharedContext: z.string(),
    repositoryReferences: z.array(z.string().trim().min(1)),
  }),
  z.object({
    type: z.literal("project.archive"),
    projectId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("department.create"),
    name: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("department.update"),
    departmentId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    description: z.string().trim(),
    inputArtifactContracts: ArtifactContractSchema.array(),
    outputArtifactContracts: ArtifactContractSchema.array(),
    defaultExecutionProfileId: z.string().trim().min(1).nullable(),
  }),
  z.object({
    type: z.literal("department.archive"),
    departmentId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("department.copy"),
    departmentId: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("position.create"),
    departmentId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    responsibility: z.string().trim().min(1),
    aiMemberDisplayName: z.string().trim().min(1),
    aiMemberProfile: z.string(),
    aiMemberResponsibilityMetadata: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("position.update"),
    departmentId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    responsibility: z.string().trim().min(1),
    aiMemberDisplayName: z.string().trim().min(1),
    aiMemberProfile: z.string(),
    aiMemberResponsibilityMetadata: z.record(z.string(), z.string()),
    aiMemberStatus: z.enum(["active", "inactive"]),
  }),
  z.object({
    type: z.literal("position.archive"),
    departmentId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z
    .object({
      type: z.literal("secret-reference.create"),
      departmentId: z.string().trim().min(1),
      name: z.string().trim().min(1),
      providerScope: z.string().trim().min(1),
    })
    .strict(),
  z.object({
    type: z.literal("secret-reference.archive"),
    departmentId: z.string().trim().min(1),
    secretReferenceId: z.string().trim().min(1),
  }),
  z
    .object({
      type: z.literal("execution-profile.save"),
      departmentId: z.string().trim().min(1),
      executionProfileId: z.string().trim().min(1).optional(),
      expectedRevision: z.number().int().nonnegative(),
      name: z.string().trim().min(1),
      providerRef: z.string().trim().min(1),
      model: z.string().trim().min(1),
      sandboxRef: z.string().trim().min(1),
      branchStrategy: z.enum(["head", "merge-to-head", "branch"]),
      timeoutSeconds: z.number().int().positive(),
      maxIterations: z.number().int().positive(),
      maxTokens: z.number().int().positive().nullable(),
      retryMaxAttempts: z.number().int().nonnegative(),
      permissionPolicy: z.enum(["ask", "allow-safe", "deny"]),
      secretReferenceIds: z.array(z.string().trim().min(1)),
    })
    .strict(),
  z.object({
    type: z.literal("execution-profile.archive"),
    departmentId: z.string().trim().min(1),
    executionProfileId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("skill.catalog.save"),
    departmentId: z.string().trim().min(1),
    skillId: z.string().trim().min(1).optional(),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    description: z.string().trim(),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    locationReference: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("skill.catalog.archive"),
    departmentId: z.string().trim().min(1),
    skillId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("position.skills.set"),
    departmentId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    skillIds: z.array(z.string().trim().min(1)),
  }),
  z.object({
    type: z.literal("skill-flow.save"),
    departmentId: z.string().trim().min(1),
    skillFlowId: z.string().trim().min(1).optional(),
    positionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    instructions: z.string(),
    skillIds: z.array(z.string().trim().min(1)),
  }),
  z.object({
    type: z.literal("skill-flow.archive"),
    departmentId: z.string().trim().min(1),
    skillFlowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("department.pipeline.draft.save"),
    departmentId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    graph: DepartmentPipelineDraftGraphSchema,
  }),
  z.object({
    type: z.literal("department.pipeline.publish"),
    departmentId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("run.start"),
    projectId: z.string().trim().min(1),
    departmentId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("run.execute-ready"),
    runId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("run.fork"),
    runId: z.string().trim().min(1),
    snapshotRevisionId: z.string().trim().min(1),
    fromNodeRunId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("run.pause"),
    runId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("run.resume"),
    runId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("run.cancel"),
    runId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("run.recover"),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    override: z
      .object({
        providerRef: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
        sandboxRef: z.string().trim().min(1).optional(),
        timeoutSeconds: z.number().int().positive().optional(),
        maxIterations: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().nullable().optional(),
        secretReferenceIds: z.array(z.string().trim().min(1)).optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal("run.approval.decide"),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    decision: z.enum(["approve", "request-changes", "reject"]),
    feedback: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.node.retry"),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    feedback: z.string().optional(),
  }),
]);

export type CompanyCommand = z.infer<typeof CompanyCommandSchema>;

export type CompanyCommandResult<Command extends CompanyCommand> =
  Command["type"] extends "runtime.shutdown"
    ? { readonly stopping: true }
    : Command["type"] extends "runtime.backup"
      ? RuntimeBackupView
      : Command["type"] extends "artifact.version.status"
        ? ArtifactVersionView
        : Command["type"] extends "runtime.events.ack"
          ? { readonly acknowledged: true }
          : Command["type"] extends "interaction.session.create"
            ? InteractionSessionView
            : Command["type"] extends "interaction.session.close"
              ? InteractionSessionView
              : Command["type"] extends "interaction.participant.add"
                ? SessionParticipantView
                : Command["type"] extends "interaction.message.add"
                  ? SessionMessageView
                  : Command["type"] extends
                        | "permission.request"
                        | "permission.decide"
                    ? PermissionRequestView
                    : Command["type"] extends "memory.candidate.create"
                      ? MemoryCandidateView
                      : Command["type"] extends "memory.candidate.review"
                        ? MemoryReviewView
                        : Command["type"] extends "runtime.events.compact"
                          ? {
                              readonly deleted: number;
                              readonly retained: number;
                            }
                          : Command["type"] extends "project.create"
                            ? CompanyProject
                            : Command["type"] extends
                                  | "project.update"
                                  | "project.archive"
                              ? ProjectEditorView
                              : Command["type"] extends "department.create"
                                ? CompanyDepartment
                                : Command["type"] extends
                                      | "skill.catalog.save"
                                      | "skill.catalog.archive"
                                      | "position.skills.set"
                                      | "skill-flow.save"
                                      | "skill-flow.archive"
                                  ? SkillConfigurationView
                                  : Command["type"] extends
                                        | "department.pipeline.draft.save"
                                        | "department.pipeline.publish"
                                    ? DepartmentPipelineEditorView
                                    : Command["type"] extends
                                          | "run.start"
                                          | "run.execute-ready"
                                          | "run.fork"
                                          | "run.pause"
                                          | "run.resume"
                                          | "run.cancel"
                                          | "run.recover"
                                          | "run.approval.decide"
                                          | "run.node.retry"
                                      ? DepartmentRunView
                                      : DepartmentInspect;

export const EventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  eventId: z.string(),
  type: z.string(),
  companyId: z.string(),
  projectId: z.string().optional(),
  departmentId: z.string().optional(),
  runId: z.string().optional(),
  nodeRunId: z.string().optional(),
  sessionId: z.string().optional(),
  participantId: z.string().optional(),
  topicId: z.string().optional(),
  timestamp: z.string().datetime(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const RuntimeRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    token: z.string().min(1),
    kind: z.literal("query"),
    query: CompanyQuerySchema,
  }),
  z.object({
    id: z.string(),
    token: z.string().min(1),
    kind: z.literal("command"),
    command: CompanyCommandSchema,
  }),
]);

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

export const RuntimeErrorSchema = z.object({
  name: z.string().default("RuntimeError"),
  code: z.string(),
  message: z.string(),
});

export const RuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    error: RuntimeErrorSchema,
  }),
]);

export type RuntimeResponse = z.infer<typeof RuntimeResponseSchema>;

export interface CompanyRuntimeClient {
  query<Query extends CompanyQuery>(
    query: Query,
  ): Promise<CompanyQueryResult<Query>>;
  execute<Command extends CompanyCommand>(
    command: Command,
  ): Promise<CompanyCommandResult<Command>>;
}
