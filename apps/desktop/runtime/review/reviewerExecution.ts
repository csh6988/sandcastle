import { z } from "zod";
import type { CodeReviewManifest, ReviewTopicView } from "../interface.js";

export const ReviewerFindingOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["info", "low", "medium", "high", "critical"]),
            summary: z.string().trim().min(1),
            rationale: z.string().trim().min(1),
            impact: z.string().trim().min(1),
            evidenceRefs: z.array(z.string().trim().min(1)).min(1),
            suggestedOwner: z.string().trim().min(1),
            blocking: z.boolean(),
            scopeImpact: z
              .enum(["scope-preserving", "scope-changing"])
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ReviewerRecheckOutputSchema = z
  .object({
    result: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]),
    conditions: z.array(z.string().trim().min(1)),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result === "CONDITIONAL_PASS" && value.conditions.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditions"],
        message: "CONDITIONAL_PASS requires machine-checkable conditions.",
      });
    }
    if (value.result !== "CONDITIONAL_PASS" && value.conditions.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditions"],
        message: "Only CONDITIONAL_PASS may carry conditions.",
      });
    }
  });

export type ReviewerFindingOutput = z.infer<typeof ReviewerFindingOutputSchema>;
export type ReviewerRecheckOutput = z.infer<typeof ReviewerRecheckOutputSchema>;

export type ReviewerExecutionPhase = "initial-finding" | "fresh-recheck";

export interface ReviewerExecutionInput {
  readonly operationKey: string;
  readonly phase: ReviewerExecutionPhase;
  readonly manifest: CodeReviewManifest;
  readonly workspaceRef: string;
  readonly reviewNodeRunId: string;
  readonly reviewer: {
    readonly participantId: string;
    readonly aiMemberId: string;
    readonly positionId: string;
    readonly sessionId: string;
  };
  readonly executionProfile: {
    readonly agentAdapterId: string;
    readonly model: string;
    readonly sandboxRef: string;
    readonly secretReferenceIds: readonly string[];
    readonly timeoutSeconds: number;
    readonly maxIterations: number;
  };
  readonly findings: ReviewTopicView["findings"];
  readonly revision: {
    readonly id: string;
    readonly subjectId: string;
    readonly subjectHash: string;
  } | null;
}

export type ReviewerExecutionResult =
  | {
      readonly status: "succeeded";
      readonly providerId: string;
      readonly isolation: {
        readonly readOnlyFilesystem: true;
        readonly independentGitDatabase: true;
        readonly independentSessionStorage: true;
        readonly independentCredentialScope: true;
        readonly independentMutableCache: true;
        readonly inputAllowlist: true;
        readonly mountTableHash?: string;
        readonly sessionScopeHash?: string;
        readonly cacheScopeHash?: string;
        readonly credentialScopeHash?: string;
        readonly mechanism: string;
        readonly mechanismVersion: string;
      };
      readonly isolationEvidence: readonly string[];
      readonly output: ReviewerFindingOutput | ReviewerRecheckOutput;
    }
  | {
      readonly status: "blocked" | "unknown";
      readonly code:
        | "PROVIDER_ISOLATION_REQUIRED"
        | "REVIEWER_OUTPUT_INVALID"
        | "RECONCILE_UNKNOWN";
      readonly message: string;
      readonly evidence: readonly string[];
    };

export interface ReviewerExecutionAdapter {
  readonly capabilities: {
    readonly executionBoundIsolation: boolean;
    readonly reattachRunningOperation: boolean;
  };
  readonly execute: (
    input: ReviewerExecutionInput,
  ) => Promise<ReviewerExecutionResult>;
  readonly reconcile?: (
    operationKey: string,
  ) => Promise<ReviewerExecutionResult>;
}

export const blockingReviewerExecutionAdapter: ReviewerExecutionAdapter = {
  capabilities: {
    executionBoundIsolation: false,
    reattachRunningOperation: false,
  },
  execute: async () => ({
    status: "blocked",
    code: "PROVIDER_ISOLATION_REQUIRED",
    message:
      "No Reviewer execution adapter proved a read-only Sandbox, private Session/cache/credential scopes, and allowlisted inputs.",
    evidence: [],
  }),
};

export const createScriptedReviewerExecutionAdapter = (input: {
  readonly execute: (
    request: ReviewerExecutionInput,
  ) => ReviewerExecutionResult | Promise<ReviewerExecutionResult>;
  readonly onExecute?: (request: ReviewerExecutionInput) => void;
}): ReviewerExecutionAdapter => ({
  capabilities: {
    executionBoundIsolation: true,
    reattachRunningOperation: true,
  },
  execute: async (request) => {
    input.onExecute?.(request);
    const result = await input.execute(request);
    if (result.status !== "succeeded") return result;
    return {
      ...result,
      isolation: {
        ...result.isolation,
        mountTableHash: result.isolation.mountTableHash ?? "1".repeat(64),
        sessionScopeHash: result.isolation.sessionScopeHash ?? "2".repeat(64),
        cacheScopeHash: result.isolation.cacheScopeHash ?? "3".repeat(64),
        credentialScopeHash:
          result.isolation.credentialScopeHash ?? "4".repeat(64),
      },
    };
  },
  reconcile: async () => ({
    status: "unknown",
    code: "RECONCILE_UNKNOWN",
    message: "The scripted Reviewer execution has no stored provider receipt.",
    evidence: [],
  }),
});
