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

export const ActorRefSchema = z.object({
  type: z.enum([
    "human",
    "electron-main",
    "acp-client",
    "runtime-worker",
    "test-driver",
  ]),
  id: z.string().trim().min(1),
  authenticatedBy: z.enum([
    "local-session",
    "ipc-token",
    "acp-connection",
    "runtime",
  ]),
});

export type ActorRef = z.infer<typeof ActorRefSchema>;

export const ProductProposalContentSchema = z
  .object({
    goal: z.string().trim().min(1),
    users: z.array(z.string().trim().min(1)),
    scope: z.array(z.string().trim().min(1)),
    nonGoals: z.array(z.string().trim().min(1)),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
    constraints: z.array(z.string().trim().min(1)),
    risks: z.array(z.string().trim().min(1)),
    openQuestions: z.array(z.string().trim().min(1)),
  })
  .strict();

export type ProductProposalContent = z.infer<
  typeof ProductProposalContentSchema
>;

export const ProductProposalRevisionViewSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  content: ProductProposalContentSchema,
  producer: z.object({
    aiMemberId: z.string(),
    positionId: z.string(),
    sessionId: z.string(),
  }),
  editedBy: z.object({
    type: z.enum([
      "human",
      "electron-main",
      "acp-client",
      "runtime-worker",
      "test-driver",
    ]),
    id: z.string().trim().min(1),
    authenticatedBy: z.enum([
      "local-session",
      "ipc-token",
      "acp-connection",
      "runtime",
    ]),
  }),
  createdAt: z.string().datetime(),
});

export const ProductProposalViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum([
    "draft",
    "clarifying",
    "awaiting-confirmation",
    "confirmed",
    "rejected",
    "needs-rework",
  ]),
  revision: z.number().int().nonnegative(),
  currentRevision: ProductProposalRevisionViewSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ProductBaselineViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceProposalRevisionId: z.string(),
  sourceProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: ProductProposalContentSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedBy: ActorRefSchema,
  confirmationCommandId: z.string(),
  confirmedAt: z.string().datetime(),
  runId: z.string(),
  snapshotRevisionId: z.string(),
});

export const ProductDiscoveryViewSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    goal: z.string(),
    revision: z.number().int().nonnegative(),
  }),
  proposal: ProductProposalViewSchema.nullable(),
  baselines: ProductBaselineViewSchema.array(),
  formalRuns: z.array(
    z.object({
      runId: z.string(),
      productBaselineId: z.string(),
      snapshotRevisionId: z.string(),
      parentRunId: z.string().nullable(),
      forkedFromSnapshotRevisionId: z.string().nullable(),
      status: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export type ProductProposalRevisionView = z.infer<
  typeof ProductProposalRevisionViewSchema
>;
export type ProductProposalView = z.infer<typeof ProductProposalViewSchema>;
export type ProductBaselineView = z.infer<typeof ProductBaselineViewSchema>;
export type ProductDiscoveryView = z.infer<typeof ProductDiscoveryViewSchema>;

export const ProjectSpecContentSchema = z
  .object({
    outcome: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    applicationBoundaries: z.array(z.string().trim().min(1)),
    crossApplicationContracts: z.array(z.string().trim().min(1)),
    deliveryConstraints: z.array(z.string().trim().min(1)),
  })
  .strict();

export const ProjectSpecRevisionViewSchema = z.object({
  id: z.string(),
  projectSpecId: z.string(),
  projectId: z.string(),
  runId: z.string(),
  productBaselineId: z.string(),
  productBaselineHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  supersedesRevisionId: z.string().nullable(),
  content: ProjectSpecContentSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  producer: z.object({
    aiMemberId: z.string(),
    positionId: z.string(),
    sessionId: z.string(),
  }),
  createdAt: z.string().datetime(),
});

export type ProjectSpecContent = z.infer<typeof ProjectSpecContentSchema>;
export type ProjectSpecRevisionView = z.infer<
  typeof ProjectSpecRevisionViewSchema
>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ApplicationViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryReference: z.string(),
  applicationKey: z.string(),
  ownership: z.string(),
  buildCommand: z.string(),
  testCommand: z.string(),
  revision: z.literal(1),
  createdAt: z.string().datetime(),
});

export type ApplicationView = z.infer<typeof ApplicationViewSchema>;

export const ApplicationContractRefSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .strict();

export const ApplicationSpecContentSchema = z
  .object({
    design: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    workPackageConstraints: z.array(z.string().trim().min(1)),
    integrationObligations: z.array(z.string().trim().min(1)),
    contractRefs: z.array(ApplicationContractRefSchema),
  })
  .strict();

export const ApplicationSpecRevisionViewSchema = z.object({
  id: z.string(),
  applicationSpecId: z.string(),
  applicationId: z.string(),
  projectId: z.string(),
  runId: z.string(),
  promotedProjectSpecRevisionId: z.string(),
  promotedProjectSpecHash: Sha256Schema,
  revision: z.number().int().positive(),
  supersedesRevisionId: z.string().nullable(),
  content: ApplicationSpecContentSchema,
  hash: Sha256Schema,
  producer: z.object({
    aiMemberId: z.string(),
    positionId: z.string(),
    sessionId: z.string(),
  }),
  createdAt: z.string().datetime(),
});

export const CrossApplicationContractInputSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
    producerApplicationId: z.string().trim().min(1),
    consumerApplicationId: z.string().trim().min(1),
    kind: z.enum(["api", "data", "event"]),
    schema: z.string().trim().min(1),
    compatibilityPolicy: z.enum(["exact", "backward-compatible"]),
    compatibility: z.enum(["compatible", "incompatible"]),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
    testCommands: z.array(z.string().trim().min(1)),
  })
  .strict();

export const TechnicalBaselineProposalContentSchema = z
  .object({
    architecture: z.string().trim().min(1),
    dependencyGraph: z.array(z.string().trim().min(1)),
    contracts: z.array(CrossApplicationContractInputSchema),
    riskPolicy: z.array(z.string().trim().min(1)),
    permissionPolicy: z.array(z.string().trim().min(1)),
    testStrategy: z.array(z.string().trim().min(1)),
  })
  .strict();

export const CrossApplicationContractRevisionViewSchema =
  CrossApplicationContractInputSchema.extend({ hash: Sha256Schema });

const ExactApplicationSpecRefSchema = z
  .object({
    applicationId: z.string().trim().min(1),
    id: z.string().trim().min(1),
    hash: Sha256Schema,
  })
  .strict();

const ExactReadinessEvidenceRefSchema = z
  .object({ id: z.string().trim().min(1), hash: Sha256Schema })
  .strict();

const ExactContractRefSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
    hash: Sha256Schema,
  })
  .strict();

export const TechnicalBaselineProposalRevisionViewSchema = z.object({
  id: z.string(),
  technicalBaselineProposalId: z.string(),
  projectId: z.string(),
  runId: z.string(),
  promotedProjectSpecRevisionId: z.string(),
  promotedProjectSpecHash: Sha256Schema,
  readinessEvidence: ExactReadinessEvidenceRefSchema.array(),
  applicationSpecRevisions: ExactApplicationSpecRefSchema.array(),
  revision: z.number().int().positive(),
  supersedesRevisionId: z.string().nullable(),
  content: TechnicalBaselineProposalContentSchema,
  hash: Sha256Schema,
  producer: z.object({
    aiMemberId: z.string(),
    positionId: z.string(),
    sessionId: z.string(),
  }),
  createdAt: z.string().datetime(),
});

export const TechnicalBaselineManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    promotedProjectSpecRevisionId: z.string().trim().min(1),
    promotedProjectSpecHash: Sha256Schema,
    readinessEvidence: ExactReadinessEvidenceRefSchema.array(),
    applicationSpecRevisions: ExactApplicationSpecRefSchema.array(),
    proposalRevisionId: z.string().trim().min(1),
    proposalRevisionHash: Sha256Schema,
    crossApplicationContracts: ExactContractRefSchema.array(),
    architecture: z.string().trim().min(1),
    dependencyGraph: z.array(z.string().trim().min(1)),
    riskPolicy: z.array(z.string().trim().min(1)),
    permissionPolicy: z.array(z.string().trim().min(1)),
    testStrategy: z.array(z.string().trim().min(1)),
  })
  .strict();

export const TechnicalBaselineViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  proposalRevisionId: z.string(),
  manifest: TechnicalBaselineManifestSchema,
  hash: Sha256Schema,
  createdAt: z.string().datetime(),
});

export const TechnicalGatePromotionViewSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  qualityGateResultId: z.string(),
  technicalBaselineId: z.string(),
  technicalBaselineHash: Sha256Schema,
  proposalRevisionId: z.string(),
  proposalRevisionHash: Sha256Schema,
  sourceSnapshotRevisionId: z.string(),
  snapshotRevisionId: z.string(),
  snapshotHash: Sha256Schema,
  createdAt: z.string().datetime(),
});

export const TechnicalReviewStateViewSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  applications: ApplicationViewSchema.array(),
  applicationSpecRevisions: ApplicationSpecRevisionViewSchema.array(),
  technicalBaselineProposals:
    TechnicalBaselineProposalRevisionViewSchema.array(),
  applicationContracts: CrossApplicationContractRevisionViewSchema.array(),
  reviewTopics: z.lazy(() => ReviewTopicViewSchema.array()),
  conditionalObligations: z.array(
    z.object({
      qualityGateResultId: z.string(),
      conditions: z.array(z.string()),
      nextTopicId: z.string().nullable(),
    }),
  ),
  acceptedBaseline: TechnicalBaselineViewSchema.nullable(),
  promotion: TechnicalGatePromotionViewSchema.nullable(),
  snapshotLineage: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      parentRevision: z.number().int().positive().nullable(),
      hash: Sha256Schema,
    }),
  ),
});

export type ApplicationSpecContent = z.infer<
  typeof ApplicationSpecContentSchema
>;
export type ApplicationSpecRevisionView = z.infer<
  typeof ApplicationSpecRevisionViewSchema
>;
export type TechnicalReviewStateView = z.infer<
  typeof TechnicalReviewStateViewSchema
>;
export type TechnicalBaselineProposalContent = z.infer<
  typeof TechnicalBaselineProposalContentSchema
>;
export type TechnicalBaselineProposalRevisionView = z.infer<
  typeof TechnicalBaselineProposalRevisionViewSchema
>;
export type TechnicalBaselineManifest = z.infer<
  typeof TechnicalBaselineManifestSchema
>;
export type TechnicalBaselineView = z.infer<typeof TechnicalBaselineViewSchema>;
export type TechnicalGatePromotionView = z.infer<
  typeof TechnicalGatePromotionViewSchema
>;

const ReviewInputManifestBaseShape = {
  topicId: z.string().trim().min(1),
  supportingArtifactVersionIds: z.array(z.string().trim().min(1)),
  supportingSpecRevisionIds: z.array(z.string().trim().min(1)),
  harnessSnapshotIds: z.array(z.string().trim().min(1)),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  excludedContext: z.array(
    z.enum([
      "hidden-prompts",
      "prior-reviewer-opinions",
      "private-transcripts",
      "provider-session-history",
      "credential-values",
    ]),
  ),
};

export const ReviewInputManifestSchema = z.discriminatedUnion("scope", [
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("product"),
      productBaselineId: z.string().trim().min(1),
      productBaselineHash: Sha256Schema,
      projectSpecRevisionId: z.string().trim().min(1),
      projectSpecHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("technical"),
      promotedProjectSpecRevisionId: z.string().trim().min(1),
      promotedProjectSpecHash: Sha256Schema,
      readinessEvidence: ExactReadinessEvidenceRefSchema.array(),
      applicationSpecRevisions: ExactApplicationSpecRefSchema.array(),
      technicalBaselineProposalId: z.string().trim().min(1),
      technicalBaselineProposalHash: Sha256Schema,
      crossApplicationContracts: ExactContractRefSchema.array(),
    })
    .strict(),
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("code"),
      workPackageVersionId: z.string().trim().min(1),
      repositoryId: z.string().trim().min(1),
      sourceCommit: z.string().trim().min(1),
      diffArtifactVersionId: z.string().trim().min(1),
      diffHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("aggregate"),
      integrationGenerationId: z.string().trim().min(1),
      integrationManifestHash: Sha256Schema,
      repositoryCommits: z.array(
        z
          .object({
            repositoryId: z.string().trim().min(1),
            commit: z.string().trim().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("verification"),
      verificationSubject: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("test"),
            integrationGenerationId: z.string().trim().min(1),
            repositoryCommits: z.array(
              z
                .object({
                  repositoryId: z.string().trim().min(1),
                  commit: z.string().trim().min(1),
                })
                .strict(),
            ),
            testCaseRevisionIds: z.array(z.string().trim().min(1)),
            testRunIds: z.array(z.string().trim().min(1)),
          })
          .strict(),
        z
          .object({
            kind: z.literal("candidate-final"),
            deliveryCandidateInputId: z.string().trim().min(1),
            deliveryCandidateInputHash: Sha256Schema,
          })
          .strict(),
      ]),
      evidenceIds: z.array(z.string().trim().min(1)),
    })
    .strict(),
  z
    .object({
      ...ReviewInputManifestBaseShape,
      scope: z.literal("memory"),
      memoryCandidateId: z.string().trim().min(1),
      memoryCandidateRevisionId: z.string().trim().min(1),
      memoryCandidateRevisionHash: Sha256Schema,
      targetScope: z.enum(["project", "ai-member"]),
      targetProjectId: z.string().trim().min(1),
      targetAiMemberId: z.string().trim().min(1).nullable(),
      redactionPolicyVersion: z.string().trim().min(1),
      redactionPolicyHash: Sha256Schema,
      sourceArtifactVersions: z.array(
        z.object({ id: z.string().trim().min(1), hash: Sha256Schema }).strict(),
      ),
      sourceEventRanges: z.array(
        z
          .object({
            runId: z.string().trim().min(1),
            fromSequence: z.number().int().positive(),
            toSequence: z.number().int().positive(),
          })
          .strict(),
      ),
    })
    .strict(),
]);

export const ReviewParticipantRoleSchema = z.enum([
  "owner-participant",
  "reviewer-participant",
  "moderator",
]);

export const ReviewParticipantInputSchema = z
  .object({
    id: z.string().trim().min(1),
    role: ReviewParticipantRoleSchema,
    aiMemberId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
  })
  .strict();

export const ReviewBudgetSchema = z
  .object({
    maxRounds: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive(),
    maxTokens: z.number().int().nonnegative(),
    maxCostCents: z.number().int().nonnegative(),
  })
  .strict();

export const ReviewFindingSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  reviewerParticipantId: z.string(),
  reviewerSessionId: z.string(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  summary: z.string(),
  rationale: z.string(),
  impact: z.string(),
  evidenceRefs: z.array(z.string()),
  suggestedOwner: z.string(),
  blocking: z.boolean(),
  scopeImpact: z
    .enum(["scope-preserving", "scope-changing"])
    .nullable()
    .optional(),
  createdAt: z.string().datetime(),
});

export const ReviewResolutionSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  findingId: z.string(),
  participantId: z.string(),
  disposition: z.enum(["accepted", "disputed", "resolved", "rejected"]),
  response: z.string(),
  evidenceRefs: z.array(z.string()),
  revisedSubjectId: z.string().nullable(),
  revisedSubjectHash: Sha256Schema.nullable(),
  createdAt: z.string().datetime(),
});

export const ReviewDiscussionSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  round: z.number().int().positive(),
  status: z.enum(["open", "closed"]),
  conflictFindingIds: z.array(z.string()),
  boundedPrompt: z.string(),
  tokensUsed: z.number().int().nonnegative(),
  costCentsUsed: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  stopReason: z.string().nullable(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const ReviewRevisionSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
  subjectHash: Sha256Schema,
  producerAiMemberId: z.string(),
  producerPositionId: z.string(),
  producerSessionId: z.string(),
  evidenceRefs: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export const ReviewRecheckSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  revisionId: z.string(),
  reviewerParticipantId: z.string(),
  reviewerSessionId: z.string(),
  result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]),
  conditions: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  eligibilitySnapshotHash: Sha256Schema,
  createdAt: z.string().datetime(),
});

export const QualityGateResultViewSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  kind: z.enum([
    "product",
    "technical",
    "code",
    "aggregate",
    "verification",
    "memory",
  ]),
  manifest: ReviewInputManifestSchema,
  manifestHash: Sha256Schema,
  revisionId: z.string().nullable(),
  result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]),
  satisfiesProductionContract: z.boolean(),
  conditions: z.array(z.string()),
  recheckIds: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export const ReviewTopicViewSchema = z.object({
  topic: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    kind: z.enum([
      "product",
      "technical",
      "code",
      "aggregate",
      "verification",
      "memory",
    ]),
    status: z.enum([
      "scheduled",
      "independent-review",
      "discussion",
      "revision",
      "re-review",
      "blocked",
      "PASS",
      "CONDITIONAL_PASS",
      "FAIL",
    ]),
    revision: z.number().int().positive(),
    manifest: ReviewInputManifestSchema,
    manifestHash: Sha256Schema,
    producer: z.object({
      aiMemberId: z.string(),
      positionId: z.string(),
      sessionId: z.string(),
    }),
    quorum: z.number().int().positive(),
    budget: ReviewBudgetSchema,
    budgetUsed: z.object({
      rounds: z.number().int().nonnegative(),
      durationSeconds: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      costCents: z.number().int().nonnegative(),
    }),
    stopCondition: z.literal("blocking-findings-dispositioned"),
    escalationPolicy: z.literal("fail-with-evidence"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  participants: z.array(
    ReviewParticipantInputSchema.extend({
      eligibility: z.object({
        eligible: z.boolean(),
        reasons: z.array(
          z.enum([
            "role-excluded",
            "producer-ai-member",
            "producer-position",
            "producer-session",
            "session-not-independent",
            "session-not-found",
            "session-project-mismatch",
            "position-member-mismatch",
          ]),
        ),
        snapshotHash: Sha256Schema,
      }),
    }),
  ),
  findings: z.array(ReviewFindingSchema),
  resolutions: z.array(ReviewResolutionSchema),
  discussions: z.array(ReviewDiscussionSchema),
  revisions: z.array(ReviewRevisionSchema),
  rechecks: z.array(ReviewRecheckSchema),
  gateResult: QualityGateResultViewSchema.nullable(),
});

export type ReviewInputManifest = z.infer<typeof ReviewInputManifestSchema>;
export type ReviewParticipantInput = z.infer<
  typeof ReviewParticipantInputSchema
>;
export type ReviewTopicView = z.infer<typeof ReviewTopicViewSchema>;

export const ProductReviewStateViewSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  productBaselineId: z.string(),
  productBaselineHash: z.string().regex(/^[a-f0-9]{64}$/),
  specRevisions: ProjectSpecRevisionViewSchema.array(),
  reviewTopics: ReviewTopicViewSchema.array(),
  readinessEvidence: z.array(
    z.object({
      id: z.string(),
      checkKey: z.string(),
      status: z.enum(["ready", "blocked"]),
      summary: z.string(),
      evidenceRefs: z.array(z.string()),
      projectSpecRevisionId: z.string(),
      projectSpecHash: Sha256Schema,
      producer: z.object({
        aiMemberId: z.string(),
        positionId: z.string(),
        sessionId: z.string(),
      }),
      createdAt: z.string().datetime(),
    }),
  ),
  readinessBlockers: z.array(z.string()),
  promotion: z
    .object({
      id: z.string(),
      topicId: z.string(),
      qualityGateResultId: z.string(),
      projectSpecRevisionId: z.string(),
      projectSpecHash: Sha256Schema,
      readinessEvidenceIds: z.array(z.string()),
      sourceSnapshotRevisionId: z.string(),
      snapshotRevisionId: z.string(),
      snapshotHash: Sha256Schema,
      createdAt: z.string().datetime(),
    })
    .nullable(),
  snapshotLineage: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      parentRevision: z.number().int().positive().nullable(),
      hash: Sha256Schema,
    }),
  ),
});

export type ProductReviewStateView = z.infer<
  typeof ProductReviewStateViewSchema
>;

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

export const ArtifactContentKindSchema = z.enum([
  "managed-file",
  "repository-object",
  "external-reference",
]);

export const ArtifactIntegrityStatusSchema = z.enum([
  "verified",
  "unavailable",
  "failed",
]);

export const ArtifactProducerContextSchema = z.object({
  projectId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  snapshotRevisionId: z.string().trim().min(1),
  nodeRunId: z.string().trim().min(1),
  nodeAttemptId: z.string().trim().min(1),
  aiMemberId: z.string().trim().min(1),
  positionId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  workPackageId: z.string().trim().min(1).optional(),
  interactionTurnId: z.string().trim().min(1).optional(),
});

export const ArtifactRegistrationContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed-file"),
    encoding: z.literal("base64"),
    data: z.string(),
    mediaType: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("repository-object"),
    repositoryRef: z.string().trim().min(1),
    commitId: z.string().regex(/^[a-f0-9]{40,64}$/),
    objectId: z.string().regex(/^[a-f0-9]{40,64}$/),
    objectKind: z.enum(["commit", "tree", "blob", "tag"]),
  }),
  z.object({
    kind: z.literal("external-reference"),
    provider: z.string().trim().min(1),
    namespace: z.string().trim().min(1),
    objectId: z.string().trim().min(1),
    providerVersion: z.string().trim().min(1).optional(),
    etag: z.string().trim().min(1).optional(),
    digest: z.string().trim().min(1).optional(),
    retrievalRef: z.string().trim().min(1),
    verifierMetadata: z.unknown().optional(),
  }),
]);

export const ArtifactRegistrationViewSchema = z.object({
  registrationId: z.string(),
  versionId: z.string(),
  artifactId: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  contentKind: ArtifactContentKindSchema,
  journalState: z.enum([
    "prepared",
    "written",
    "renamed",
    "finalized",
    "failed",
  ]),
  finalized: z.boolean(),
});

export type ArtifactRegistrationView = z.infer<
  typeof ArtifactRegistrationViewSchema
>;

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
  contentKind: ArtifactContentKindSchema.optional(),
  integrityStatus: ArtifactIntegrityStatusSchema.optional(),
  lifecycle: z.enum(["finalized", "superseded"]).optional(),
  identityHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  integrityDescriptor: z.unknown().optional(),
  status: z.enum(["draft", "produced", "accepted", "rejected", "superseded"]),
  producer: z.object({
    runId: z.string(),
    nodeRunId: z.string(),
    nodeAttemptId: z.string(),
    snapshotRevisionId: z.string(),
    aiMemberId: z.string(),
    positionId: z.string().optional(),
    sessionId: z.string().optional(),
    workPackageId: z.string().optional(),
    interactionTurnId: z.string().optional(),
  }),
  createdAt: z.string().datetime(),
});

export type ArtifactVersionView = z.infer<typeof ArtifactVersionViewSchema>;

export const ArtifactLineageViewSchema = z.object({
  version: ArtifactVersionViewSchema,
  inputs: z.array(z.object({ versionId: z.string(), relation: z.string() })),
});

export type ArtifactLineageView = z.infer<typeof ArtifactLineageViewSchema>;

export const ArtifactLineageGraphViewSchema = z.object({
  rootVersionId: z.string(),
  versions: z.array(ArtifactVersionViewSchema),
  edges: z.array(
    z.object({
      fromVersionId: z.string(),
      toVersionId: z.string(),
      relation: z.string(),
    }),
  ),
});

export type ArtifactLineageGraphView = z.infer<
  typeof ArtifactLineageGraphViewSchema
>;

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

export const AgentCapabilitySchema = z.enum([
  "non-interactive",
  "structured-output",
  "session-resume",
]);

export const AgentCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["installed", "not-installed", "detection-failed"]),
  version: z.string().nullable(),
  executablePath: z.string().nullable(),
  lastDetectedAt: z.string().datetime(),
  capabilities: AgentCapabilitySchema.array(),
  errorCode: z.string().nullable(),
});

export const AgentCatalogViewSchema = z.object({
  agents: AgentCatalogEntrySchema.array(),
});

export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntrySchema>;
export type AgentCatalogView = z.infer<typeof AgentCatalogViewSchema>;

export const AgentTestResultSchema = z.object({
  agentId: z.string(),
  status: z.enum(["passed", "failed"]),
  testedAt: z.string().datetime(),
  summary: z.string(),
});

export type AgentTestResult = z.infer<typeof AgentTestResultSchema>;

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
  handlerKindId: z
    .string()
    .regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/)
    .optional(),
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
  approvalExpiresAfterSeconds: z.number().int().positive().optional(),
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

export const NodeHandlerBindingSchema = z.object({
  nodeId: z.string(),
  handlerKindId: z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/),
  inputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const NodeHandlerRegistrySnapshotSchema = z.object({
  version: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

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
      handlerRegistry: NodeHandlerRegistrySnapshotSchema,
      handlers: NodeHandlerBindingSchema.array(),
      publishedAt: z.string().datetime(),
    })
    .nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      version: z.number().int().positive(),
      graph: DepartmentPipelineGraphSchema,
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      handlerRegistry: NodeHandlerRegistrySnapshotSchema,
      handlers: NodeHandlerBindingSchema.array(),
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
      defaultAgentId: z.string(),
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

export const SkillCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sourceDirectory: z.string(),
  version: z.string(),
  locationReference: z.string(),
  requiredCapabilities: z.string().array().optional(),
  status: z.enum(["discovered", "enabled", "unavailable", "archived"]),
});

export const SkillCatalogViewSchema = z.object({
  directories: z.string().array(),
  skills: SkillCatalogEntrySchema.array(),
});

export type SkillCatalogView = z.infer<typeof SkillCatalogViewSchema>;

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

export const PositionConfigurationResultSchema = z.object({
  department: DepartmentInspectSchema,
  skills: SkillConfigurationViewSchema,
});

export type PositionConfigurationResult = z.infer<
  typeof PositionConfigurationResultSchema
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
  "superseded",
]);

export type DepartmentRunStatus = z.infer<typeof DepartmentRunStatusSchema>;

export const NodeRunStatusSchema = z.enum([
  "queued",
  "ready",
  "running",
  "waiting-permission",
  "waiting-approval",
  "paused",
  "blocked",
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
  defaultAgentId: z.string(),
  resolvedAgentId: z.string(),
  agentSource: z.enum(["position-default", "run-override"]),
  skillIds: z.array(z.string()),
  skillSnapshots: z
    .array(
      z.object({
        id: z.string(),
        version: z.string(),
      }),
    )
    .optional(),
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
  productBaseline: z
    .object({
      id: z.string(),
      sourceProposalRevisionId: z.string(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  productGatePromotion: z
    .object({
      topicId: z.string(),
      qualityGateResultId: z.string(),
      acceptedProjectSpecRevisionId: z.string(),
      acceptedProjectSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
      readinessEvidenceIds: z.array(z.string()),
      promotedAt: z.string().datetime(),
    })
    .optional(),
  technicalGatePromotion: z
    .object({
      qualityGateResultId: z.string(),
      acceptedTechnicalBaselineId: z.string(),
      acceptedTechnicalBaselineHash: Sha256Schema,
      acceptedApplicationSpecRevisions: ExactApplicationSpecRefSchema.array(),
      promotedAt: z.string().datetime(),
    })
    .optional(),
  memorySelections: z
    .array(
      z.object({
        entryId: z.string(),
        entryVersion: z.number().int().positive(),
        entryHash: Sha256Schema,
        scope: z.enum(["project", "ai-member"]),
        ownerId: z.string(),
        targetProjectId: z.string(),
        selectionReason: z.string(),
        policyHash: Sha256Schema,
        selectedAt: z.string().datetime(),
      }),
    )
    .optional(),
  project: RunSnapshotProjectSchema,
  department: RunSnapshotDepartmentSchema,
  pipelineVersion: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    graph: DepartmentPipelineGraphSchema,
    handlerRegistry: NodeHandlerRegistrySnapshotSchema.optional(),
    handlers: NodeHandlerBindingSchema.array().optional(),
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

export const ContinuationPlanSchema = z.object({
  id: z.string(),
  kind: z.enum(["recovery", "fork"]),
  sourceRunId: z.string(),
  targetRunId: z.string(),
  sourceSnapshotRevisionId: z.string(),
  targetSnapshotRevisionId: z.string(),
  targetNodeRunId: z.string().nullable(),
  mode: z.enum(["recovery", "replay", "reconfigure"]),
  runRevision: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  items: z.array(
    z.object({
      ordinal: z.number().int().nonnegative(),
      pipelineNodeId: z.string(),
      sourceNodeRunId: z.string().nullable(),
      targetNodeRunId: z.string(),
      disposition: z.enum(["rerun", "reuse-evidence", "skip", "blocked"]),
      evidenceRefs: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});

export type ContinuationPlan = z.infer<typeof ContinuationPlanSchema>;

export const ExecutionInspectionViewSchema = z.object({
  operationKey: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("node-attempt"), id: z.string() }),
    z.object({ kind: z.literal("interaction-turn"), id: z.string() }),
  ]),
  terminalFactId: z.string().nullable(),
  leases: z.array(
    z.object({
      leaseId: z.string(),
      leaseKind: z.enum(["execution", "reconciliation"]),
      executionEpoch: z.number().int().positive(),
      fenceToken: z.string(),
      workerId: z.string(),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      renewedAt: z.string().datetime().nullable(),
      releasedAt: z.string().datetime().nullable(),
      cancelRequested: z.boolean(),
    }),
  ),
  facts: z.array(
    z.object({
      id: z.string(),
      operationKey: z.string(),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("node-attempt"), id: z.string() }),
        z.object({ kind: z.literal("interaction-turn"), id: z.string() }),
      ]),
      leaseId: z.string(),
      leaseKind: z.enum(["execution", "reconciliation"]),
      executionEpoch: z.number().int().positive(),
      fenceToken: z.string(),
      adapterSchemaVersion: z.number().int().positive(),
      factId: z.string(),
      ordinal: z.number().int().positive(),
      kind: z.enum([
        "provider-started",
        "agent-session",
        "message",
        "tool-call",
        "tool-result",
        "permission-request",
        "checkpoint",
        "artifact",
        "commit",
        "usage",
        "not-started",
        "completed",
        "failed",
        "cancelled",
      ]),
      schemaVersion: z.number().int().positive(),
      payload: z.unknown(),
      evidenceRefs: z.array(z.string()),
      canonicalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(["accepted", "duplicate", "stale", "conflict"]),
      effectIds: z.array(z.string()),
      createdAt: z.string().datetime(),
    }),
  ),
});

export type ExecutionInspectionView = z.infer<
  typeof ExecutionInspectionViewSchema
>;

export const DepartmentRunViewSchema = z.object({
  run: z.object({
    id: z.string(),
    projectId: z.string(),
    departmentId: z.string(),
    pipelineVersionId: z.string(),
    snapshotRevisionId: z.string(),
    productBaselineId: z.string().nullable(),
    parentRunId: z.string().nullable(),
    forkedFromSnapshotRevisionId: z.string().nullable(),
    status: DepartmentRunStatusSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  snapshot: RunSnapshotSchema,
  continuationPlan: ContinuationPlanSchema.nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      pipelineNodeId: z.string(),
      nodeType: DepartmentPipelineNodeSchema.shape.type,
      handler: NodeHandlerBindingSchema.optional(),
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
            "reconciling",
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
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
          status: z.enum(["pending", "decided", "expired", "cancelled"]),
          decision: z.enum(["approve", "request-changes", "reject"]).nullable(),
          requestedAction: z.string(),
          inputManifestHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          eligibleHumanPolicy: z.unknown(),
          expiresAt: z.string().datetime().nullable(),
          decisionActor: ActorRefSchema.nullable(),
          decisionCommandId: z.string().nullable(),
          createdAt: z.string().datetime(),
          decidedAt: z.string().datetime().nullable(),
          expiredAt: z.string().datetime().nullable(),
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
  decisionActor: ActorRefSchema.nullable().optional(),
  decisionCommandId: z.string().nullable().optional(),
});

export const InteractionTurnViewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  inputMessageId: z.string(),
  outputMessageId: z.string().nullable(),
  status: z.enum([
    "queued",
    "running",
    "reconciling",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  commandId: z.string(),
  executionOperationKey: z.string(),
  executionLeaseId: z.string().nullable(),
  executionEpoch: z.number().int().positive().nullable(),
  fenceToken: z.string().nullable(),
  mechanism: z.literal("model-only"),
  mechanismVersion: z.string(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  contextSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  terminalExecutionFactId: z.string().nullable(),
  providerExecutionRef: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const InteractionViewSchema = z.object({
  session: InteractionSessionViewSchema,
  participants: z.array(SessionParticipantViewSchema),
  messages: z.array(SessionMessageViewSchema),
  turns: z.array(InteractionTurnViewSchema),
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
export type InteractionTurnView = z.infer<typeof InteractionTurnViewSchema>;
export type PermissionRequestView = z.infer<typeof PermissionRequestViewSchema>;

export const RunSupervisionViewSchema = z.object({
  run: DepartmentRunViewSchema.shape.run,
  snapshot: z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  graph: z.object({
    nodes: z.array(
      z.object({
        nodeRunId: z.string(),
        pipelineNodeId: z.string(),
        name: z.string(),
        type: z.string(),
        status: NodeRunStatusSchema,
        attemptId: z.string().nullable(),
      }),
    ),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  timeline: z.array(RuntimeEventRecordSchema),
  agentActivities: z.array(
    z.object({
      aiMemberId: z.string(),
      aiMemberName: z.string(),
      positionId: z.string(),
      positionName: z.string(),
      agentAdapterId: z.string(),
      model: z.string(),
      sessionId: z.string().nullable(),
      runId: z.string(),
      snapshotRevisionId: z.string(),
      nodeRunId: z.string(),
      attemptId: z.string().nullable(),
      workPackageId: z.string().nullable(),
      worktree: z.string().nullable(),
      status: z.union([
        NodeRunStatusSchema,
        z.literal("reconciling"),
        z.literal("interrupted"),
      ]),
      startedAt: z.string().datetime().nullable(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative().nullable(),
      nextAction: z.string(),
    }),
  ),
  interactions: z.array(
    z.object({
      boundary: z.enum(["consultation", "run-collaboration"]),
      session: InteractionSessionViewSchema,
      turns: z.array(InteractionTurnViewSchema),
      permissions: z.array(PermissionRequestViewSchema),
    }),
  ),
  interventions: z.array(
    z.object({
      id: z.string(),
      nodeRunId: z.string(),
      attemptId: z.string().nullable(),
      snapshotRevisionId: z.string(),
      actorId: z.string(),
      reason: z.string(),
      feedback: z.string(),
      outcome: z.enum(["feedback", "new-attempt"]),
      createdAt: z.string().datetime(),
    }),
  ),
  allowedCommands: z.object({
    pause: z.boolean(),
    resume: z.boolean(),
    cancelAttemptIds: z.array(z.string()),
    cancelTurnIds: z.array(z.string()),
    decidePermissionIds: z.array(z.string()),
    interveneNodeRunIds: z.array(z.string()),
  }),
});

export type RunSupervisionView = z.infer<typeof RunSupervisionViewSchema>;

export const AgUiEventSchema = z.object({
  type: z.enum([
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "STEP_FAILED",
    "TEXT_MESSAGE_CONTENT",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "CUSTOM",
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

export const MemoryDecisionRecordSchema = z.object({
  id: z.string(),
  candidateRevisionId: z.string(),
  candidateRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  qualityGateResultId: z.string(),
  decision: z.enum(["accepted", "rejected"]),
  decidedBy: ActorRefSchema,
  createdAt: z.string().datetime(),
  entryId: z.string().nullable(),
});

export const MemoryCandidateViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scope: z.enum(["project", "ai-member"]),
  aiMemberId: z.string().nullable(),
  status: z.enum(["draft", "review", "accepted", "rejected"]),
  revision: z.number().int().positive(),
  currentRevision: z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    supersedesRevisionId: z.string().nullable(),
    content: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    redactionPolicy: z.object({
      version: z.string(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    sourceArtifactVersions: z.array(
      z.object({ id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    ),
    sourceEventRanges: z.array(
      z.object({
        runId: z.string(),
        fromSequence: z.number().int().positive(),
        toSequence: z.number().int().positive(),
      }),
    ),
    producer: z.object({
      aiMemberId: z.string(),
      positionId: z.string(),
      sessionId: z.string(),
    }),
    createdAt: z.string().datetime(),
  }),
  reviewTopicId: z.string().nullable(),
  decision: MemoryDecisionRecordSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MemoryEntryViewSchema = z.object({
  id: z.string(),
  candidateRevisionId: z.string(),
  projectId: z.string(),
  scope: z.enum(["project", "ai-member"]),
  ownerId: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  redactionPolicy: z.object({
    version: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  qualityGateResultId: z.string(),
  decisionId: z.string(),
  createdAt: z.string().datetime(),
});

export const LegacyMemoryRecordViewSchema = z.object({
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

export const MemoryDecisionViewSchema = z.object({
  candidate: MemoryCandidateViewSchema,
  decision: MemoryDecisionRecordSchema,
  entry: MemoryEntryViewSchema.nullable(),
});

export const RunMemorySelectionViewSchema = z.object({
  snapshotRevisionId: z.string(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  selections: z.array(
    z.object({
      entryId: z.string(),
      entryVersion: z.number().int().positive(),
      entryHash: z.string().regex(/^[a-f0-9]{64}$/),
      selectionReason: z.string(),
      policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

export type MemoryCandidateView = z.infer<typeof MemoryCandidateViewSchema>;
export type MemoryDecisionRecord = z.infer<typeof MemoryDecisionRecordSchema>;
export type MemoryEntryView = z.infer<typeof MemoryEntryViewSchema>;
export type LegacyMemoryRecordView = z.infer<
  typeof LegacyMemoryRecordViewSchema
>;
export type MemoryDecisionView = z.infer<typeof MemoryDecisionViewSchema>;
export type RunMemorySelectionView = z.infer<
  typeof RunMemorySelectionViewSchema
>;

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

export const WorkspaceImportReceiptSchema = z
  .object({
    allocationId: z.string().trim().min(1),
    status: z.enum(["imported", "duplicate"]),
    beforeSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    afterSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    resultCommit: z.string().regex(/^[a-f0-9]{40}$/),
    resultTree: z.string().regex(/^[a-f0-9]{40}$/),
    objectSetHash: Sha256Schema,
    changedPaths: z.array(z.string()),
  })
  .strict();

export const WorkspaceImportViewSchema = z
  .object({
    id: z.string().trim().min(1),
    allocationId: z.string().trim().min(1),
    state: z.enum(["intent", "running", "succeeded", "failed", "unknown"]),
    expectedSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    beforeSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    resultCommit: z.string().regex(/^[a-f0-9]{40}$/),
    objectSetHash: Sha256Schema.nullable(),
    receipt: WorkspaceImportReceiptSchema.nullable(),
    failure: z
      .object({ code: z.string().trim().min(1), message: z.string() })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceAllocationViewSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1),
    executionProfileId: z.string().trim().min(1),
    executionProfileRevision: z.number().int().nonnegative(),
    operationKey: z.string().trim().min(1),
    workPackageVersionId: z.string().trim().min(1).nullable(),
    nodeAttemptId: z.string().trim().min(1).nullable(),
    interactionSessionId: z.string().trim().min(1).nullable(),
    sandboxIdentity: z.string().trim().min(1).nullable(),
    evidenceScope: z.string().trim().min(1).nullable(),
    state: z.enum([
      "planned",
      "provisioning",
      "ready",
      "failed",
      "cleanup-pending",
      "cleaned",
    ]),
    repositoryRoot: z.string().trim().min(1),
    allocationRoot: z.string().trim().min(1),
    sourceBranch: z.string().trim().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    expectedSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
    capabilitySnapshot: z.unknown(),
    capabilitySnapshotHash: Sha256Schema,
    privateGitIdentity: z.unknown().nullable(),
    provisionReceipt: z.unknown().nullable(),
    cleanupEvidence: z.unknown().nullable(),
    failure: z
      .object({ code: z.string().trim().min(1), message: z.string() })
      .strict()
      .nullable(),
    revision: z.number().int().nonnegative(),
    imports: z.array(WorkspaceImportViewSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceAllocationView = z.infer<
  typeof WorkspaceAllocationViewSchema
>;

export const WorkPackageManifestSchema = z
  .object({
    objective: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
    moduleScope: z.array(z.string().trim().min(1)),
    allowedPermissions: z.array(z.string().trim().min(1)),
    specRefs: z.array(z.string().trim().min(1)),
    harnessRefs: z.array(z.string().trim().min(1)),
    assignmentCriteria: z
      .object({ positionIds: z.array(z.string().trim().min(1)) })
      .strict(),
    expectedArtifacts: z.array(z.string().trim().min(1)),
    selfCheckCommands: z.array(z.string().trim().min(1)),
    codeReviewConditions: z.array(z.string().trim().min(1)),
    integrationConditions: z.array(z.string().trim().min(1)),
    riskTier: z.enum(["low", "medium", "high", "critical"]),
    recoveryPolicy: z.string().trim().min(1),
    execution: z
      .object({
        profileId: z.literal("software-rnd-local-isolated-git"),
        branchStrategy: z.literal("branch"),
        gitRefWriteIsolation: z.literal(true),
        runtimeImportOnly: z.literal(true),
      })
      .strict(),
  })
  .strict();

const WorkPackageManifestInputSchema = WorkPackageManifestSchema.omit({
  execution: true,
});

const WorkPackageDependencyKindSchema = z.enum([
  "artifact",
  "commit",
  "contract",
  "readiness",
  "manual",
]);

export const WorkPackageAssignmentViewSchema = z
  .object({
    id: z.string().trim().min(1),
    workPackageVersionId: z.string().trim().min(1),
    nodeAttemptId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    aiMemberId: z.string().trim().min(1),
    agentAdapterId: z.string().trim().min(1),
    rationale: z.unknown(),
    allocationId: z.string().trim().min(1),
    interactionSessionId: z.string().trim().min(1),
    sandboxIdentity: z.string().trim().min(1),
    evidenceScope: z.string().trim().min(1),
    state: z.enum([
      "assigned",
      "running",
      "awaiting-self-check",
      "self-check-passed",
      "failed",
      "superseded",
    ]),
    selfCheck: z
      .object({
        id: z.string().trim().min(1),
        status: z.enum(["passed", "failed"]),
        report: z.unknown(),
        reportHash: Sha256Schema,
        createdAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    allocation: WorkspaceAllocationViewSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkPackageVersionViewSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
    applicationId: z.string().trim().min(1),
    repositoryReference: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    manifest: WorkPackageManifestSchema,
    manifestHash: Sha256Schema,
    status: z.enum(["ready", "superseded"]),
    dependencies: z.array(
      z
        .object({
          predecessorWorkPackageVersionId: z.string().trim().min(1),
          kind: WorkPackageDependencyKindSchema,
          contractId: z.string().trim().min(1).nullable(),
          contractVersion: z.string().trim().min(1).nullable(),
          evidenceRef: z.string().trim().min(1).nullable(),
        })
        .strict(),
    ),
    assignments: z.array(WorkPackageAssignmentViewSchema),
    createdAt: z.string().datetime(),
  })
  .strict();

export const WorkPackageViewSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    technicalBaselineId: z.string().trim().min(1),
    state: z.enum([
      "ready",
      "assigned",
      "running",
      "self-check",
      "blocked",
      "failed",
    ]),
    revision: z.number().int().nonnegative(),
    versions: z.array(WorkPackageVersionViewSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkPackageGraphViewSchema = z
  .object({
    projectId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    technicalBaselineId: z.string().trim().min(1),
    packages: z.array(WorkPackageViewSchema),
  })
  .strict();

export type WorkPackageGraphView = z.infer<typeof WorkPackageGraphViewSchema>;

export const CompanyQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.health") }),
  z.object({ type: z.literal("agent.catalog.inspect") }),
  z.object({ type: z.literal("skill.discovery.inspect") }),
  z.object({ type: z.literal("company.overview") }),
  z.object({ type: z.literal("projects.list") }),
  z.object({ type: z.literal("project.inspect"), projectId: z.string() }),
  z.object({
    type: z.literal("workspace-allocation.inspect"),
    allocationId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("work-packages.inspect"),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("applications.list"),
    projectId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("review.topic.inspect"),
    topicId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("review.topics.list"),
    projectId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("product.discovery.inspect"),
    projectId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("product-review.inspect"),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("technical-review.inspect"),
    runId: z.string().trim().min(1),
  }),
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
    type: z.literal("run.supervision.inspect"),
    runId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("execution.inspect"),
    targetKind: z.enum(["node-attempt", "interaction-turn"]),
    targetId: z.string().trim().min(1),
  }),
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
  z.object({
    type: z.literal("artifact.lineage.inspect"),
    versionId: z.string(),
  }),
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
  z.object({ type: z.literal("memory.entries.list"), projectId: z.string() }),
  z.object({ type: z.literal("memory.selections.list"), runId: z.string() }),
  z.object({
    type: z.literal("memory.legacy-records.list"),
    projectId: z.string(),
  }),
  z.object({ type: z.literal("runtime.diagnostics") }),
]);

export type CompanyQuery = z.infer<typeof CompanyQuerySchema>;

export const QueryEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().trim().min(1),
  principal: ActorRefSchema,
  consumerId: z.string().trim().min(1),
  query: CompanyQuerySchema,
});

export type QueryEnvelope<Query extends CompanyQuery = CompanyQuery> = Omit<
  z.infer<typeof QueryEnvelopeSchema>,
  "query"
> & { readonly query: Query };

export interface QueryResult<View> {
  readonly view: View;
  readonly asOfSequence: number;
  readonly viewSyncToken?: string;
}

export type CompanyQueryResult<Query extends CompanyQuery> =
  Query["type"] extends "runtime.health"
    ? RuntimeHealth
    : Query["type"] extends "agent.catalog.inspect"
      ? AgentCatalogView
      : Query["type"] extends "skill.discovery.inspect"
        ? SkillCatalogView
        : Query["type"] extends "company.overview"
          ? CompanyOverview
          : Query["type"] extends "projects.list"
            ? readonly CompanyProject[]
            : Query["type"] extends "project.inspect"
              ? ProjectEditorView
              : Query["type"] extends "workspace-allocation.inspect"
                ? WorkspaceAllocationView
                : Query["type"] extends "work-packages.inspect"
                  ? WorkPackageGraphView
                  : Query["type"] extends "applications.list"
                    ? readonly ApplicationView[]
                    : Query["type"] extends "review.topic.inspect"
                      ? ReviewTopicView
                      : Query["type"] extends "review.topics.list"
                        ? readonly ReviewTopicView[]
                        : Query["type"] extends "product.discovery.inspect"
                          ? ProductDiscoveryView
                          : Query["type"] extends "product-review.inspect"
                            ? ProductReviewStateView
                            : Query["type"] extends "technical-review.inspect"
                              ? TechnicalReviewStateView
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
                                          : Query["type"] extends "run.supervision.inspect"
                                            ? RunSupervisionView
                                            : Query["type"] extends "execution.inspect"
                                              ? ExecutionInspectionView
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
                                                      : Query["type"] extends "artifact.lineage.inspect"
                                                        ? ArtifactLineageGraphView
                                                        : Query["type"] extends "interactions.list"
                                                          ? readonly InteractionView[]
                                                          : Query["type"] extends "interaction.inspect"
                                                            ? InteractionView
                                                            : Query["type"] extends "ag-ui.events"
                                                              ? AgUiReplayView
                                                              : Query["type"] extends "memory.candidates.list"
                                                                ? readonly MemoryCandidateView[]
                                                                : Query["type"] extends "memory.records.list"
                                                                  ? readonly LegacyMemoryRecordView[]
                                                                  : Query["type"] extends "memory.entries.list"
                                                                    ? readonly MemoryEntryView[]
                                                                    : Query["type"] extends "memory.selections.list"
                                                                      ? readonly RunMemorySelectionView[]
                                                                      : Query["type"] extends "memory.legacy-records.list"
                                                                        ? readonly LegacyMemoryRecordView[]
                                                                        : Query["type"] extends "runtime.diagnostics"
                                                                          ? RuntimeDiagnosticsView
                                                                          : DepartmentRunView;

export const ArtifactRegisterEnvelopeCommandSchema = z
  .object({
    type: z.literal("artifact.version.register"),
    projectId: z.string().trim().min(1),
    artifactType: z.string().trim().min(1),
    artifactSchemaVersion: z.string().trim().min(1),
    logicalName: z.string().trim().min(1),
    content: ArtifactRegistrationContentSchema,
    producer: ArtifactProducerContextSchema,
    inputVersionIds: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const WorkspaceAllocationProvisionEnvelopeCommandSchema = z
  .object({
    type: z.literal("workspace-allocation.provision"),
    allocationId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1),
    executionProfileId: z.string().trim().min(1),
    sourceBranch: z.string().trim().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    expectedSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();

export const SourceImportExecuteEnvelopeCommandSchema = z
  .object({
    type: z.literal("source-import.execute"),
    allocationId: z.string().trim().min(1),
    resultCommit: z.string().regex(/^[a-f0-9]{40}$/),
    expectedSourceTip: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();

export const WorkspaceAllocationCleanupEnvelopeCommandSchema = z
  .object({
    type: z.literal("workspace-allocation.cleanup"),
    allocationId: z.string().trim().min(1),
  })
  .strict();

export type WorkspaceEnvelopeCommand =
  | z.infer<typeof WorkspaceAllocationProvisionEnvelopeCommandSchema>
  | z.infer<typeof SourceImportExecuteEnvelopeCommandSchema>
  | z.infer<typeof WorkspaceAllocationCleanupEnvelopeCommandSchema>;

const WorkPackageDependencyInputSchema = z
  .object({
    predecessorWorkPackageId: z.string().trim().min(1),
    kind: WorkPackageDependencyKindSchema,
    contractId: z.string().trim().min(1).optional(),
    contractVersion: z.string().trim().min(1).optional(),
    evidenceRef: z.string().trim().min(1).optional(),
  })
  .strict();

const WorkPackageVersionDependencyInputSchema = z
  .object({
    predecessorWorkPackageVersionId: z.string().trim().min(1),
    kind: WorkPackageDependencyKindSchema,
    contractId: z.string().trim().min(1).optional(),
    contractVersion: z.string().trim().min(1).optional(),
    evidenceRef: z.string().trim().min(1).optional(),
  })
  .strict();

export const WorkPackageGenerateEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.generate"),
    runId: z.string().trim().min(1),
    technicalBaselineId: z.string().trim().min(1),
    packages: z.array(
      z
        .object({
          workPackageId: z.string().trim().min(1),
          versionId: z.string().trim().min(1),
          applicationId: z.string().trim().min(1),
          repositoryReference: z.string().trim().min(1),
          nodeRunId: z.string().trim().min(1),
          dependencies: z.array(WorkPackageDependencyInputSchema),
          manifest: WorkPackageManifestInputSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const WorkPackageVersionEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.version"),
    workPackageId: z.string().trim().min(1),
    versionId: z.string().trim().min(1),
    dependencies: z.array(WorkPackageVersionDependencyInputSchema),
    manifest: WorkPackageManifestInputSchema,
  })
  .strict();

export const WorkPackageAssignEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.assign"),
    workPackageId: z.string().trim().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();

export const WorkPackageStartEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.start"),
    workPackageId: z.string().trim().min(1),
  })
  .strict();

export const WorkPackageReworkEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.rework"),
    workPackageId: z.string().trim().min(1),
    versionId: z.string().trim().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    recoveryReason: z.string().trim().min(1),
  })
  .strict();

export const WorkPackageSelfCheckEnvelopeCommandSchema = z
  .object({
    type: z.literal("work-package.self-check"),
    workPackageId: z.string().trim().min(1),
    status: z.enum(["passed", "failed"]),
    commands: z.array(z.string().trim().min(1)),
    logRefs: z.array(z.string().trim().min(1)),
    commitEvidence: z.array(z.string().trim().min(1)),
    summary: z.string().trim().min(1),
  })
  .strict();

export type WorkPackageEnvelopeCommand =
  | z.infer<typeof WorkPackageGenerateEnvelopeCommandSchema>
  | z.infer<typeof WorkPackageVersionEnvelopeCommandSchema>
  | z.infer<typeof WorkPackageAssignEnvelopeCommandSchema>
  | z.infer<typeof WorkPackageStartEnvelopeCommandSchema>
  | z.infer<typeof WorkPackageReworkEnvelopeCommandSchema>
  | z.infer<typeof WorkPackageSelfCheckEnvelopeCommandSchema>;

export const ArtifactFinalizeEnvelopeCommandSchema = z
  .object({
    type: z.literal("artifact.version.finalize"),
    registrationId: z.string().trim().min(1),
  })
  .strict();

export const ArtifactSupersedeEnvelopeCommandSchema = z
  .object({
    type: z.literal("artifact.version.supersede"),
    versionId: z.string().trim().min(1),
    supersededByVersionId: z.string().trim().min(1),
  })
  .strict();

export type ArtifactEnvelopeCommand =
  | z.infer<typeof ArtifactRegisterEnvelopeCommandSchema>
  | z.infer<typeof ArtifactFinalizeEnvelopeCommandSchema>
  | z.infer<typeof ArtifactSupersedeEnvelopeCommandSchema>;

export const CompanyCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.shutdown") }),
  z.object({ type: z.literal("agent.catalog.discover") }),
  z.object({
    type: z.literal("agent.test"),
    agentId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("skill.discovery.refresh"),
    directories: z.array(z.string().trim().min(1)).default([]),
  }),
  z.object({
    type: z.literal("skill.discovery.enable"),
    skillId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("skill.discovery.archive"),
    skillId: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("runtime.backup") }),
  ArtifactRegisterEnvelopeCommandSchema,
  ArtifactFinalizeEnvelopeCommandSchema,
  ArtifactSupersedeEnvelopeCommandSchema,
  z
    .object({
      type: z.literal("ack-runtime-events"),
      sequence: z.number().int().nonnegative(),
      subscriptionGeneration: z.number().int().positive().optional(),
      viewSyncToken: z.string().trim().min(1).optional(),
    })
    .strict(),
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
    type: z.literal("interaction.prompt"),
    sessionId: z.string().trim().min(1),
    participantId: z.string().trim().min(1),
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
    type: z.literal("application.register"),
    applicationId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    repositoryReference: z.string().trim().min(1),
    applicationKey: z.string().trim().min(1),
    ownership: z.string().trim().min(1),
    buildCommand: z.string().trim().min(1),
    testCommand: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("application-spec.revise"),
    runId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1),
    promotedProjectSpecRevisionId: z.string().trim().min(1),
    promotedProjectSpecHash: Sha256Schema,
    producerSessionId: z.string().trim().min(1),
    content: ApplicationSpecContentSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("technical-baseline-proposal.revise"),
    runId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    applicationSpecRevisions: z
      .array(z.object({ id: z.string(), hash: Sha256Schema }).strict())
      .min(1),
    content: TechnicalBaselineProposalContentSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("technical-review.start"),
    runId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    technicalBaselineProposalId: z.string().trim().min(1),
    technicalBaselineProposalHash: Sha256Schema,
    priorQualityGateResultId: z.string().trim().min(1).optional(),
    participants: z.array(ReviewParticipantInputSchema).min(3),
    quorum: z.number().int().positive().optional(),
    budget: ReviewBudgetSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("technical-gate.promote"),
    runId: z.string().trim().min(1),
    parentSnapshotRevisionId: z.string().trim().min(1),
    gateResultId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("product.proposal.revise"),
    projectId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    content: ProductProposalContentSchema,
  }),
  z.object({
    type: z.literal("product.proposal.mark-awaiting-confirmation"),
    projectId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    proposalRevisionId: z.string().trim().min(1),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type: z.literal("confirm-product-baseline"),
    projectId: z.string().trim().min(1),
    departmentId: z.string().trim().min(1),
    agentOverrideId: z.string().trim().min(1).optional(),
    forkSourceRunId: z.string().trim().min(1).optional(),
    forkSourceSnapshotRevisionId: z.string().trim().min(1).optional(),
    expectedRevision: z.number().int().nonnegative(),
    proposalRevisionId: z.string().trim().min(1),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type: z.literal("fork-department-run"),
    sourceRunId: z.string().trim().min(1),
    sourceSnapshotRevisionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1),
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
    defaultAgentId: z.string().trim().min(1).optional(),
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
    defaultAgentId: z.string().trim().min(1).optional(),
    aiMemberDisplayName: z.string().trim().min(1),
    aiMemberProfile: z.string(),
    aiMemberResponsibilityMetadata: z.record(z.string(), z.string()),
    aiMemberStatus: z.enum(["active", "inactive"]),
  }),
  z.object({
    type: z.literal("position.configure"),
    departmentId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    expectedSkillRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    responsibility: z.string().trim().min(1),
    aiMemberDisplayName: z.string().trim().min(1),
    aiMemberProfile: z.string(),
    aiMemberResponsibilityMetadata: z.record(z.string(), z.string()),
    aiMemberStatus: z.enum(["active", "inactive"]),
    defaultAgentId: z.string().trim().min(1),
    skillIds: z.array(z.string().trim().min(1)),
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
    agentOverrideId: z.string().trim().min(1).optional(),
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
    mode: z.enum(["replay", "reconfigure"]).optional(),
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
    type: z.literal("run.approval.retry"),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
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

export const ProjectUpdateEnvelopeCommandSchema = z
  .object({
    type: z.literal("project.update"),
    projectId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    sharedContext: z.string(),
    repositoryReferences: z.array(z.string().trim().min(1)),
  })
  .strict();

export type ProjectUpdateEnvelopeCommand = z.infer<
  typeof ProjectUpdateEnvelopeCommandSchema
>;

export const ApplicationRegisterEnvelopeCommandSchema = z
  .object({
    type: z.literal("application.register"),
    applicationId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    repositoryReference: z.string().trim().min(1),
    applicationKey: z.string().trim().min(1),
    ownership: z.string().trim().min(1),
    buildCommand: z.string().trim().min(1),
    testCommand: z.string().trim().min(1),
  })
  .strict();

export const ApplicationSpecReviseEnvelopeCommandSchema = z
  .object({
    type: z.literal("application-spec.revise"),
    runId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1),
    promotedProjectSpecRevisionId: z.string().trim().min(1),
    promotedProjectSpecHash: Sha256Schema,
    producerSessionId: z.string().trim().min(1),
    content: ApplicationSpecContentSchema,
  })
  .strict();

export const TechnicalBaselineProposalReviseEnvelopeCommandSchema = z
  .object({
    type: z.literal("technical-baseline-proposal.revise"),
    runId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    applicationSpecRevisions: z
      .array(z.object({ id: z.string(), hash: Sha256Schema }).strict())
      .min(1),
    content: TechnicalBaselineProposalContentSchema,
  })
  .strict();

export const TechnicalReviewStartEnvelopeCommandSchema = z
  .object({
    type: z.literal("technical-review.start"),
    runId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    technicalBaselineProposalId: z.string().trim().min(1),
    technicalBaselineProposalHash: Sha256Schema,
    priorQualityGateResultId: z.string().trim().min(1).optional(),
    participants: z.array(ReviewParticipantInputSchema).min(3),
    quorum: z.number().int().positive().optional(),
    budget: ReviewBudgetSchema,
  })
  .strict();

export const TechnicalGatePromoteEnvelopeCommandSchema = z
  .object({
    type: z.literal("technical-gate.promote"),
    runId: z.string().trim().min(1),
    parentSnapshotRevisionId: z.string().trim().min(1),
    gateResultId: z.string().trim().min(1),
  })
  .strict();

export const AckRuntimeEventsEnvelopeCommandSchema = z
  .object({
    type: z.literal("ack-runtime-events"),
    sequence: z.number().int().nonnegative(),
    subscriptionGeneration: z.number().int().positive().optional(),
    viewSyncToken: z.string().trim().min(1).optional(),
  })
  .strict();

export type AckRuntimeEventsEnvelopeCommand = z.infer<
  typeof AckRuntimeEventsEnvelopeCommandSchema
>;

export const ProductProposalReviseEnvelopeCommandSchema = z
  .object({
    type: z.literal("product.proposal.revise"),
    projectId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    content: ProductProposalContentSchema,
  })
  .strict();

export const ProductProposalMarkAwaitingEnvelopeCommandSchema = z
  .object({
    type: z.literal("product.proposal.mark-awaiting-confirmation"),
    projectId: z.string().trim().min(1),
    proposalRevisionId: z.string().trim().min(1),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const ConfirmProductBaselineEnvelopeCommandSchema = z
  .object({
    type: z.literal("confirm-product-baseline"),
    projectId: z.string().trim().min(1),
    departmentId: z.string().trim().min(1),
    agentOverrideId: z.string().trim().min(1).optional(),
    forkSourceRunId: z.string().trim().min(1).optional(),
    forkSourceSnapshotRevisionId: z.string().trim().min(1).optional(),
    proposalRevisionId: z.string().trim().min(1),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const ForkDepartmentRunEnvelopeCommandSchema = z
  .object({
    type: z.literal("fork-department-run"),
    sourceRunId: z.string().trim().min(1),
    sourceSnapshotRevisionId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

export const ProjectSpecReviseEnvelopeCommandSchema = z
  .object({
    type: z.literal("project-spec.revise"),
    runId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    content: ProjectSpecContentSchema,
  })
  .strict();

export const ProductReviewStartEnvelopeCommandSchema = z
  .object({
    type: z.literal("product-review.start"),
    runId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecHash: Sha256Schema,
    participants: z.array(ReviewParticipantInputSchema).min(3),
    quorum: z.number().int().positive().optional(),
    budget: ReviewBudgetSchema,
  })
  .strict();

export const ProductReadinessRecordEnvelopeCommandSchema = z
  .object({
    type: z.literal("product-readiness.record"),
    runId: z.string().trim().min(1),
    evidenceId: z.string().trim().min(1),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecHash: Sha256Schema,
    producerSessionId: z.string().trim().min(1),
    checkKey: z.string().trim().min(1),
    status: z.enum(["ready", "blocked"]),
    summary: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)),
  })
  .strict();

export const ProductGatePromoteEnvelopeCommandSchema = z
  .object({
    type: z.literal("product-gate.promote"),
    runId: z.string().trim().min(1),
    topicId: z.string().trim().min(1),
    projectSpecRevisionId: z.string().trim().min(1),
    projectSpecHash: Sha256Schema,
    readinessEvidenceIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const InteractionPromptEnvelopeCommandSchema = z
  .object({
    type: z.literal("interaction.prompt"),
    sessionId: z.string().trim().min(1),
    participantId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const NodeAttemptCancelEnvelopeCommandSchema = z
  .object({
    type: z.literal("node-attempt.cancel"),
    runId: z.string().trim().min(1),
    attemptId: z.string().trim().min(1),
  })
  .strict();

export const PermissionDecideEnvelopeCommandSchema = z
  .object({
    type: z.literal("permission.decide"),
    permissionId: z.string().trim().min(1),
    expectedStatus: z.literal("pending"),
    decision: z.enum(["approved", "denied"]),
  })
  .strict();

export const SupervisionInteractionTurnCancelEnvelopeCommandSchema = z
  .object({
    type: z.literal("interaction-turn.cancel"),
    runId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
  })
  .strict();

export const InteractionTurnCancelEnvelopeCommandSchema = z
  .object({
    type: z.literal("interaction.turn.cancel"),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
  })
  .strict();

export const GovernedInterventionEnvelopeCommandSchema = z
  .object({
    type: z.literal("run.governed-intervention"),
    runId: z.string().trim().min(1),
    nodeRunId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(1_000),
    feedback: z.string().trim().min(1).max(10_000),
    outcome: z.enum(["feedback", "new-attempt"]),
  })
  .strict();

const MemoryProducerSchema = z
  .object({
    aiMemberId: z.string().trim().min(1),
    positionId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
  })
  .strict();

const ExactMemoryEntryRefSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
    hash: Sha256Schema,
  })
  .strict();

export const MemoryCandidateProposeEnvelopeCommandSchema = z
  .object({
    type: z.literal("memory.candidate.propose"),
    candidateId: z.string().trim().min(1),
    revisionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    scope: z.enum(["project", "ai-member"]),
    aiMemberId: z.string().trim().min(1).optional(),
    producer: MemoryProducerSchema,
    content: z.string().trim().min(1).max(20_000),
    redactionPolicy: z
      .object({ version: z.string().trim().min(1), hash: Sha256Schema })
      .strict(),
    sourceArtifactVersions: z
      .array(z.object({ id: z.string().trim().min(1), hash: Sha256Schema }))
      .min(1),
    sourceEventRanges: z
      .array(
        z
          .object({
            runId: z.string().trim().min(1),
            fromSequence: z.number().int().positive(),
            toSequence: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    supersedesRevisionId: z.string().trim().min(1).optional(),
  })
  .strict();

export const MemoryReviewStartEnvelopeCommandSchema = z
  .object({
    type: z.literal("memory.review.start"),
    candidateId: z.string().trim().min(1),
    candidateRevisionId: z.string().trim().min(1),
    candidateRevisionHash: Sha256Schema,
    topicId: z.string().trim().min(1),
    participants: z.array(ReviewParticipantInputSchema).min(3),
    quorum: z.number().int().positive().optional(),
    budget: ReviewBudgetSchema,
  })
  .strict();

export const MemoryCandidateDecideEnvelopeCommandSchema = z
  .object({
    type: z.literal("memory.candidate.decide"),
    candidateId: z.string().trim().min(1),
    candidateRevisionId: z.string().trim().min(1),
    candidateRevisionHash: Sha256Schema,
    topicId: z.string().trim().min(1),
    decision: z.enum(["accepted", "rejected"]),
  })
  .strict();

export const MemoryEntrySelectForRunEnvelopeCommandSchema = z
  .object({
    type: z.literal("memory.entry.select-for-run"),
    runId: z.string().trim().min(1),
    sourceSnapshotRevisionId: z.string().trim().min(1),
    entryRefs: z.array(ExactMemoryEntryRefSchema).min(1),
    selectionReason: z.string().trim().min(1),
    policyHash: Sha256Schema,
  })
  .strict();

export type MemoryEnvelopeCommand =
  | z.infer<typeof MemoryCandidateProposeEnvelopeCommandSchema>
  | z.infer<typeof MemoryReviewStartEnvelopeCommandSchema>
  | z.infer<typeof MemoryCandidateDecideEnvelopeCommandSchema>
  | z.infer<typeof MemoryEntrySelectForRunEnvelopeCommandSchema>;

export const ReviewTopicCreateEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.topic.create"),
    topicId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    runId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    manifest: ReviewInputManifestSchema,
    producer: z
      .object({
        aiMemberId: z.string().trim().min(1),
        positionId: z.string().trim().min(1),
        sessionId: z.string().trim().min(1),
      })
      .strict(),
    participants: z.array(ReviewParticipantInputSchema).min(3),
    quorum: z.number().int().positive().optional(),
    budget: ReviewBudgetSchema,
    stopCondition: z.literal("blocking-findings-dispositioned"),
    escalationPolicy: z.literal("fail-with-evidence"),
  })
  .strict();

export const ReviewFindingSubmitEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.finding.submit"),
    topicId: z.string().trim().min(1),
    findingId: z.string().trim().min(1),
    reviewerParticipantId: z.string().trim().min(1),
    reviewerSessionId: z.string().trim().min(1),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    summary: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    impact: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)),
    suggestedOwner: z.string().trim().min(1),
    blocking: z.boolean(),
    scopeImpact: z.enum(["scope-preserving", "scope-changing"]).optional(),
  })
  .strict();

export const ReviewFindingDispositionEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.finding.disposition"),
    topicId: z.string().trim().min(1),
    resolutionId: z.string().trim().min(1),
    findingId: z.string().trim().min(1),
    participantId: z.string().trim().min(1),
    disposition: z.enum(["accepted", "disputed", "resolved", "rejected"]),
    response: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)),
    revisedSubjectId: z.string().trim().min(1).optional(),
    revisedSubjectHash: Sha256Schema.optional(),
  })
  .strict();

export const ReviewDiscussionOpenEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.discussion.open"),
    topicId: z.string().trim().min(1),
    discussionId: z.string().trim().min(1),
    moderatorParticipantId: z.string().trim().min(1),
    conflictFindingIds: z.array(z.string().trim().min(1)).min(1),
    boundedPrompt: z.string().trim().min(1),
  })
  .strict();

export const ReviewDiscussionCloseEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.discussion.close"),
    topicId: z.string().trim().min(1),
    discussionId: z.string().trim().min(1),
    moderatorParticipantId: z.string().trim().min(1),
    durationSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    costCentsUsed: z.number().int().nonnegative(),
    stopReason: z.string().trim().min(1).optional(),
  })
  .strict();

export const ReviewRevisionSubmitEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.revision.submit"),
    topicId: z.string().trim().min(1),
    revisionId: z.string().trim().min(1),
    ownerParticipantId: z.string().trim().min(1),
    subjectKind: z.string().trim().min(1),
    subjectId: z.string().trim().min(1),
    subjectHash: Sha256Schema,
    producerAiMemberId: z.string().trim().min(1),
    producerPositionId: z.string().trim().min(1),
    producerSessionId: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)),
  })
  .strict();

export const ReviewRecheckSubmitEnvelopeCommandSchema = z
  .object({
    type: z.literal("review.recheck.submit"),
    topicId: z.string().trim().min(1),
    recheckId: z.string().trim().min(1),
    revisionId: z.string().trim().min(1),
    reviewerParticipantId: z.string().trim().min(1),
    reviewerSessionId: z.string().trim().min(1),
    result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]),
    conditions: z.array(z.string().trim().min(1)),
    evidenceRefs: z.array(z.string().trim().min(1)),
  })
  .strict();

export type ReviewEnvelopeCommand =
  | z.infer<typeof ReviewTopicCreateEnvelopeCommandSchema>
  | z.infer<typeof ReviewFindingSubmitEnvelopeCommandSchema>
  | z.infer<typeof ReviewFindingDispositionEnvelopeCommandSchema>
  | z.infer<typeof ReviewDiscussionOpenEnvelopeCommandSchema>
  | z.infer<typeof ReviewDiscussionCloseEnvelopeCommandSchema>
  | z.infer<typeof ReviewRevisionSubmitEnvelopeCommandSchema>
  | z.infer<typeof ReviewRecheckSubmitEnvelopeCommandSchema>;

export type ProductEnvelopeCommand =
  | z.infer<typeof ProductProposalReviseEnvelopeCommandSchema>
  | z.infer<typeof ProductProposalMarkAwaitingEnvelopeCommandSchema>
  | z.infer<typeof ConfirmProductBaselineEnvelopeCommandSchema>
  | z.infer<typeof ForkDepartmentRunEnvelopeCommandSchema>;

export type ProductReviewEnvelopeCommand =
  | z.infer<typeof ProjectSpecReviseEnvelopeCommandSchema>
  | z.infer<typeof ProductReviewStartEnvelopeCommandSchema>
  | z.infer<typeof ProductReadinessRecordEnvelopeCommandSchema>
  | z.infer<typeof ProductGatePromoteEnvelopeCommandSchema>;

export type TechnicalReviewEnvelopeCommand =
  | z.infer<typeof ApplicationSpecReviseEnvelopeCommandSchema>
  | z.infer<typeof TechnicalBaselineProposalReviseEnvelopeCommandSchema>
  | z.infer<typeof TechnicalReviewStartEnvelopeCommandSchema>
  | z.infer<typeof TechnicalGatePromoteEnvelopeCommandSchema>;

export const EnvelopeCommandSchema = z.discriminatedUnion("type", [
  ProjectUpdateEnvelopeCommandSchema,
  ApplicationRegisterEnvelopeCommandSchema,
  ApplicationSpecReviseEnvelopeCommandSchema,
  TechnicalBaselineProposalReviseEnvelopeCommandSchema,
  TechnicalReviewStartEnvelopeCommandSchema,
  TechnicalGatePromoteEnvelopeCommandSchema,
  AckRuntimeEventsEnvelopeCommandSchema,
  ProductProposalReviseEnvelopeCommandSchema,
  ProductProposalMarkAwaitingEnvelopeCommandSchema,
  ConfirmProductBaselineEnvelopeCommandSchema,
  ForkDepartmentRunEnvelopeCommandSchema,
  ProjectSpecReviseEnvelopeCommandSchema,
  ProductReviewStartEnvelopeCommandSchema,
  ProductReadinessRecordEnvelopeCommandSchema,
  ProductGatePromoteEnvelopeCommandSchema,
  InteractionPromptEnvelopeCommandSchema,
  NodeAttemptCancelEnvelopeCommandSchema,
  SupervisionInteractionTurnCancelEnvelopeCommandSchema,
  GovernedInterventionEnvelopeCommandSchema,
  MemoryCandidateProposeEnvelopeCommandSchema,
  MemoryReviewStartEnvelopeCommandSchema,
  MemoryCandidateDecideEnvelopeCommandSchema,
  MemoryEntrySelectForRunEnvelopeCommandSchema,
  PermissionDecideEnvelopeCommandSchema,
  InteractionTurnCancelEnvelopeCommandSchema,
  ReviewTopicCreateEnvelopeCommandSchema,
  ReviewFindingSubmitEnvelopeCommandSchema,
  ReviewFindingDispositionEnvelopeCommandSchema,
  ReviewDiscussionOpenEnvelopeCommandSchema,
  ReviewDiscussionCloseEnvelopeCommandSchema,
  ReviewRevisionSubmitEnvelopeCommandSchema,
  ReviewRecheckSubmitEnvelopeCommandSchema,
  ArtifactRegisterEnvelopeCommandSchema,
  ArtifactFinalizeEnvelopeCommandSchema,
  ArtifactSupersedeEnvelopeCommandSchema,
  WorkspaceAllocationProvisionEnvelopeCommandSchema,
  SourceImportExecuteEnvelopeCommandSchema,
  WorkspaceAllocationCleanupEnvelopeCommandSchema,
  WorkPackageGenerateEnvelopeCommandSchema,
  WorkPackageVersionEnvelopeCommandSchema,
  WorkPackageAssignEnvelopeCommandSchema,
  WorkPackageStartEnvelopeCommandSchema,
  WorkPackageReworkEnvelopeCommandSchema,
  WorkPackageSelfCheckEnvelopeCommandSchema,
]);

export type EnvelopeCommand = z.infer<typeof EnvelopeCommandSchema>;

export type EnvelopeCommandResult<Command extends EnvelopeCommand> =
  Command["type"] extends "ack-runtime-events"
    ? {
        readonly acknowledged: true;
        readonly subscriptionGeneration: number;
        readonly barrierSequence: number;
        readonly auditId: string;
      }
    : Command["type"] extends WorkspaceEnvelopeCommand["type"]
      ? WorkspaceAllocationView
      : Command["type"] extends WorkPackageEnvelopeCommand["type"]
        ? WorkPackageGraphView
        : Command["type"] extends "application.register"
          ? ApplicationView
          : Command["type"] extends
                | "application-spec.revise"
                | "technical-baseline-proposal.revise"
                | "technical-review.start"
                | "technical-gate.promote"
            ? TechnicalReviewStateView
            : Command["type"] extends "interaction.prompt"
              ? InteractionTurnView
              : Command["type"] extends
                    | "node-attempt.cancel"
                    | "interaction-turn.cancel"
                    | "run.governed-intervention"
                ? RunSupervisionView
                : Command["type"] extends "interaction.turn.cancel"
                  ? InteractionTurnView
                  : Command["type"] extends "permission.decide"
                    ? PermissionRequestView
                    : Command["type"] extends
                          | "memory.candidate.propose"
                          | "memory.review.start"
                      ? MemoryCandidateView
                      : Command["type"] extends "memory.candidate.decide"
                        ? MemoryDecisionView
                        : Command["type"] extends "memory.entry.select-for-run"
                          ? RunMemorySelectionView
                          : Command["type"] extends ReviewEnvelopeCommand["type"]
                            ? ReviewTopicView
                            : Command["type"] extends ProductReviewEnvelopeCommand["type"]
                              ? ProductReviewStateView
                              : Command["type"] extends ProductEnvelopeCommand["type"]
                                ? ProductDiscoveryView
                                : Command["type"] extends "artifact.version.register"
                                  ? ArtifactRegistrationView
                                  : Command["type"] extends
                                        | "artifact.version.finalize"
                                        | "artifact.version.supersede"
                                    ? ArtifactVersionView
                                    : ProjectEditorView;

export const CommandEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.string().trim().min(1),
  actor: ActorRefSchema,
  consumerId: z.string().trim().min(1).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  command: EnvelopeCommandSchema,
});

export type CommandEnvelope<
  Command extends EnvelopeCommand = ProjectUpdateEnvelopeCommand,
> = Omit<z.infer<typeof CommandEnvelopeSchema>, "command"> & {
  readonly command: Command;
};

export interface CommandSucceeded<Value> {
  readonly status: "succeeded";
  readonly value: Value;
  readonly effectIds: readonly string[];
}

export interface CommandRejected {
  readonly status: "rejected";
  readonly error: { readonly code: string; readonly message: string };
  readonly effectIds: readonly string[];
}

export type CommandResult<Value = ProjectEditorView> =
  | CommandSucceeded<Value>
  | CommandRejected;

export const CommandResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    value: z.unknown(),
    effectIds: z.array(z.string()),
  }),
  z.object({
    status: z.literal("rejected"),
    error: z.object({ code: z.string(), message: z.string() }),
    effectIds: z.array(z.string()),
  }),
]);

export const QueryResultSchema = z.object({
  view: z.unknown(),
  asOfSequence: z.number().int().nonnegative(),
  viewSyncToken: z.string().optional(),
});

export type CompanyCommandResult<Command extends CompanyCommand> =
  Command["type"] extends "runtime.shutdown"
    ? { readonly stopping: true }
    : Command["type"] extends "agent.catalog.discover"
      ? AgentCatalogView
      : Command["type"] extends "agent.test"
        ? AgentTestResult
        : Command["type"] extends
              | "skill.discovery.refresh"
              | "skill.discovery.enable"
              | "skill.discovery.archive"
          ? SkillCatalogView
          : Command["type"] extends "runtime.backup"
            ? RuntimeBackupView
            : Command["type"] extends "ack-runtime-events"
              ? {
                  readonly acknowledged: true;
                  readonly subscriptionGeneration: number;
                  readonly barrierSequence: number;
                  readonly auditId: string;
                }
              : Command["type"] extends "artifact.version.status"
                ? ArtifactVersionView
                : Command["type"] extends "artifact.version.register"
                  ? ArtifactRegistrationView
                  : Command["type"] extends
                        | "artifact.version.finalize"
                        | "artifact.version.supersede"
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
                              : Command["type"] extends "interaction.prompt"
                                ? InteractionTurnView
                                : Command["type"] extends
                                      | "permission.request"
                                      | "permission.decide"
                                  ? PermissionRequestView
                                  : Command["type"] extends "runtime.events.compact"
                                    ? {
                                        readonly deleted: number;
                                        readonly retained: number;
                                      }
                                    : Command["type"] extends "project.create"
                                      ? CompanyProject
                                      : Command["type"] extends
                                            | "product.proposal.revise"
                                            | "product.proposal.mark-awaiting-confirmation"
                                            | "confirm-product-baseline"
                                            | "fork-department-run"
                                        ? ProductDiscoveryView
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
                                              : Command["type"] extends "position.configure"
                                                ? PositionConfigurationResult
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
                                                        | "run.approval.retry"
                                                        | "run.node.retry"
                                                    ? DepartmentRunView
                                                    : DepartmentInspect;

export const EventEnvelopeSchema = z.object({
  registryVersion: z.number().int().positive().optional(),
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  eventId: z.string(),
  type: z.string(),
  companyId: z.string(),
  projectId: z.string().optional(),
  applicationId: z.string().optional(),
  departmentId: z.string().optional(),
  positionId: z.string().optional(),
  aiMemberId: z.string().optional(),
  companyAgentAdapterId: z.string().optional(),
  skillId: z.string().optional(),
  skillFlowId: z.string().optional(),
  executionProfileId: z.string().optional(),
  repositoryReferenceId: z.string().optional(),
  productProposalId: z.string().optional(),
  productBaselineId: z.string().optional(),
  projectSpecRevisionId: z.string().optional(),
  applicationSpecRevisionId: z.string().optional(),
  technicalBaselineProposalId: z.string().optional(),
  technicalBaselineId: z.string().optional(),
  pipelineVersionId: z.string().optional(),
  runId: z.string().optional(),
  snapshotRevisionId: z.string().optional(),
  nodeRunId: z.string().optional(),
  nodeAttemptId: z.string().optional(),
  nodeLeaseId: z.string().optional(),
  executionLeaseId: z.string().optional(),
  executionOperationKey: z.string().optional(),
  executionFactId: z.string().optional(),
  workPackageId: z.string().optional(),
  workPackageVersionId: z.string().optional(),
  workspaceAllocationId: z.string().optional(),
  integrationGenerationId: z.string().optional(),
  integrationOperationId: z.string().optional(),
  sessionId: z.string().optional(),
  interactionTurnId: z.string().optional(),
  participantId: z.string().optional(),
  topicId: z.string().optional(),
  artifactId: z.string().optional(),
  reviewFindingId: z.string().optional(),
  qualityGateResultId: z.string().optional(),
  artifactVersionId: z.string().optional(),
  defectId: z.string().optional(),
  permissionRequestId: z.string().optional(),
  nodeApprovalRequestId: z.string().optional(),
  nodeApprovalDecisionId: z.string().optional(),
  testCaseRevisionId: z.string().optional(),
  testRunId: z.string().optional(),
  securityReviewId: z.string().optional(),
  operabilityReviewId: z.string().optional(),
  deliveryCandidateInputId: z.string().optional(),
  deliveryCandidateId: z.string().optional(),
  releaseDecisionId: z.string().optional(),
  releaseOperationId: z.string().optional(),
  memoryCandidateId: z.string().optional(),
  memoryEntryId: z.string().optional(),
  improvementProposalId: z.string().optional(),
  improvementApplicationOperationId: z.string().optional(),
  commandId: z.string().optional(),
  timestamp: z.string().datetime(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const RuntimeSubscriptionHandleSchema = z.object({
  subscriptionId: z.string().trim().min(1),
  subscriptionGeneration: z.number().int().positive(),
  barrierSequence: z.number().int().nonnegative(),
});

export type RuntimeSubscriptionHandle = z.infer<
  typeof RuntimeSubscriptionHandleSchema
>;

export const RuntimeSubscriptionBatchSchema = z.object({
  events: z.array(EventEnvelopeSchema),
  nextSequence: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type RuntimeSubscriptionBatch = z.infer<
  typeof RuntimeSubscriptionBatchSchema
>;

export const RuntimeRequestSchema = z.union([
  z.object({
    id: z.string(),
    token: z.string().min(1),
    kind: z.literal("subscription.open"),
  }),
  z.object({
    id: z.string(),
    token: z.string().min(1),
    kind: z.literal("subscription.read"),
    subscriptionId: z.string().trim().min(1),
    subscriptionGeneration: z.number().int().positive(),
    limit: z.number().int().positive().max(1_000),
  }),
  z.object({
    id: z.string(),
    token: z.string().min(1),
    kind: z.literal("subscription.close"),
    subscriptionId: z.string().trim().min(1),
    subscriptionGeneration: z.number().int().positive(),
  }),
  z
    .object({
      id: z.string(),
      token: z.string().min(1),
      kind: z.literal("query"),
      envelope: QueryEnvelopeSchema,
      query: CompanyQuerySchema.optional(),
    })
    .transform((request) => ({
      ...request,
      query: request.query ?? request.envelope.query,
    })),
  z
    .object({
      id: z.string(),
      token: z.string().min(1),
      kind: z.literal("command"),
      envelope: CommandEnvelopeSchema,
      command: CompanyCommandSchema.optional(),
    })
    .transform((request) => ({
      ...request,
      command:
        request.command ??
        ({
          ...request.envelope.command,
          expectedRevision: request.envelope.expectedRevision ?? 0,
        } as CompanyCommand),
    })),
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

export type RuntimeRequestInput = z.input<typeof RuntimeRequestSchema>;
export type RuntimeRequest = z.output<typeof RuntimeRequestSchema>;

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
  queryEnvelope<Query extends CompanyQuery>(
    envelope: QueryEnvelope<Query>,
  ): Promise<QueryResult<CompanyQueryResult<Query>>>;
  executeEnvelope<Command extends EnvelopeCommand>(
    envelope: CommandEnvelope<Command>,
  ): Promise<CommandResult<EnvelopeCommandResult<Command>>>;
  openSubscription(): Promise<RuntimeSubscriptionHandle>;
  readSubscription(input: {
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
    readonly limit: number;
  }): Promise<RuntimeSubscriptionBatch>;
  closeSubscription(input: {
    readonly subscriptionId: string;
    readonly subscriptionGeneration: number;
  }): Promise<void>;
}
