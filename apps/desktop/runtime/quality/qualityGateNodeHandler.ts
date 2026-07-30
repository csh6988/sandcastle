import type { CompanyCommandRegistry } from "../commandRegistry.js";
import type { EnvelopeCommand, EnvelopeCommandResult } from "../interface.js";
import type {
  PipelineRuntime,
  ReadyAttemptClaim,
} from "../pipeline/pipelineRuntime.js";
import type {
  ReviewerExecutionAdapter,
  ReviewerExecutionInput,
  ReviewerExecutionResult,
} from "../review/reviewerExecution.js";

export type DeliveryQualityHandlerKind =
  | "delivery-candidate-input@1"
  | "security-review@1"
  | "operability-review@1";

export type PlannedDeliveryQualityCommand = {
  readonly commandId: string;
  readonly command: EnvelopeCommand;
};

export type DeliveryQualityNodePlan = {
  readonly handlerKindId: DeliveryQualityHandlerKind;
  readonly initialCommands: readonly PlannedDeliveryQualityCommand[];
  readonly review?: {
    readonly reviewerSessionId: string;
    readonly reviewerAiMemberId: string;
    readonly operationKey: string;
    readonly reconcileExisting: boolean;
    readonly timeoutSeconds: number;
    readonly request: ReviewerExecutionInput;
    readonly adapter: ReviewerExecutionAdapter;
    readonly terminalCommands: (
      result: Extract<
        ReviewerExecutionResult,
        { readonly status: "succeeded" }
      >,
    ) => readonly PlannedDeliveryQualityCommand[];
  };
};

export interface DeliveryQualityNodePlanProvider {
  readonly plan: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly attempt: Extract<ReadyAttemptClaim, { readonly kind: "claimed" }>;
  }) => DeliveryQualityNodePlan;
}

export interface QualityGateNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
}

const workerId = "delivery-quality-node-handler";

export const openQualityGateNodeHandler = (options: {
  readonly pipelineRuntime: Pick<
    PipelineRuntime,
    | "claimReadyAttempt"
    | "blockClaimedAttempt"
    | "completeClaimedAttempt"
    | "executeQualityReviewStage"
  >;
  readonly commandRegistry: Pick<CompanyCommandRegistry, "execute">;
  readonly plans?: DeliveryQualityNodePlanProvider;
  readonly leaseDurationMs?: number;
}): QualityGateNodeHandler => {
  const block = (
    attempt: Extract<ReadyAttemptClaim, { readonly kind: "claimed" }>,
    runId: string,
    failure: { readonly code: string; readonly message: string },
    terminalExecutionFactId?: string,
  ): void => {
    options.pipelineRuntime.blockClaimedAttempt({
      runId,
      nodeRunId: attempt.nodeRunId,
      attemptId: attempt.attemptId,
      leaseId: attempt.leaseId,
      workerId,
      ...(terminalExecutionFactId ? { terminalExecutionFactId } : {}),
      failure,
    });
  };

  const executeCommands = (
    commands: readonly PlannedDeliveryQualityCommand[],
  ) => {
    let last:
      | {
          readonly command: EnvelopeCommand;
          readonly value: EnvelopeCommandResult<EnvelopeCommand>;
        }
      | undefined;
    for (const planned of commands) {
      const result = options.commandRegistry.execute({
        schemaVersion: 1,
        commandId: planned.commandId,
        actor: {
          type: "runtime-worker",
          id: workerId,
          authenticatedBy: "runtime",
        },
        consumerId: workerId,
        command: planned.command,
      });
      if (result.status === "rejected") {
        return { ok: false as const, error: result.error };
      }
      last = {
        command: planned.command,
        value: result.value as EnvelopeCommandResult<EnvelopeCommand>,
      };
    }
    return { ok: true as const, last };
  };

  const executeReady: QualityGateNodeHandler["executeReady"] = async (
    input,
  ) => {
    const attempt = options.pipelineRuntime.claimReadyAttempt({
      ...input,
      workerId,
      leaseDurationMs: options.leaseDurationMs ?? 300_000,
    });
    if (attempt.kind === "no-work") return;
    if (!options.plans) {
      block(attempt, input.runId, {
        code: "DELIVERY_QUALITY_PLAN_UNAVAILABLE",
        message:
          "The Delivery/Quality Node has no Runtime-owned immutable Command plan.",
      });
      return;
    }

    const plan = options.plans.plan({ ...input, attempt });
    const initial = executeCommands(plan.initialCommands);
    if (!initial.ok) {
      block(attempt, input.runId, initial.error);
      return;
    }
    if (plan.handlerKindId === "delivery-candidate-input@1") {
      const value = initial.last?.value as
        | { readonly id?: string; readonly manifestHash?: string }
        | undefined;
      if (!value?.id || !value.manifestHash) {
        block(attempt, input.runId, {
          code: "DELIVERY_CANDIDATE_INPUT_RESULT_INVALID",
          message:
            "Delivery Candidate Input Command did not return immutable identity and manifest hash.",
        });
        return;
      }
      options.pipelineRuntime.completeClaimedAttempt({
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        attemptId: attempt.attemptId,
        leaseId: attempt.leaseId,
        workerId,
        result: {
          deliveryCandidateInputId: value.id,
          manifestHash: value.manifestHash,
        },
      });
      return;
    }
    if (!plan.review) {
      block(attempt, input.runId, {
        code: "QUALITY_GATE_REVIEW_PLAN_INVALID",
        message: `${plan.handlerKindId} requires an independent Reviewer execution plan.`,
      });
      return;
    }

    const reviewer = await options.pipelineRuntime.executeQualityReviewStage({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      handlerKindId: plan.handlerKindId,
      reviewerSessionId: plan.review.reviewerSessionId,
      reviewerAiMemberId: plan.review.reviewerAiMemberId,
      operationKey: plan.review.operationKey,
      reconcileExisting: plan.review.reconcileExisting,
      timeoutSeconds: plan.review.timeoutSeconds,
      request: plan.review.request,
      adapter: plan.review.adapter,
    });
    if (reviewer.status !== "succeeded") {
      block(
        attempt,
        input.runId,
        {
          code:
            reviewer.status === "running"
              ? "QUALITY_GATE_RECONCILIATION_REQUIRED"
              : reviewer.code,
          message:
            reviewer.status === "running"
              ? "The independent Reviewer operation is still running and must be reconciled."
              : reviewer.message,
        },
        "terminalExecutionFactId" in reviewer
          ? reviewer.terminalExecutionFactId
          : undefined,
      );
      return;
    }
    const terminal = executeCommands(plan.review.terminalCommands(reviewer));
    if (!terminal.ok) {
      block(
        attempt,
        input.runId,
        terminal.error,
        reviewer.terminalExecutionFactId,
      );
      return;
    }
    const value = terminal.last?.value as
      | {
          readonly id?: string;
          readonly result?: "PASS" | "CONDITIONAL_PASS" | "FAIL";
          readonly resultHash?: string;
        }
      | undefined;
    if (value?.result !== "PASS" || !value.id || !value.resultHash) {
      block(
        attempt,
        input.runId,
        {
          code: "QUALITY_GATE_NOT_PASS",
          message: `${plan.handlerKindId} did not produce immutable PASS authority.`,
        },
        reviewer.terminalExecutionFactId,
      );
      return;
    }
    options.pipelineRuntime.completeClaimedAttempt({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      attemptId: attempt.attemptId,
      leaseId: attempt.leaseId,
      workerId,
      terminalExecutionFactId: reviewer.terminalExecutionFactId,
      result: {
        candidateGateResultId: value.id,
        result: value.result,
        resultHash: value.resultHash,
      },
    });
  };

  return { executeReady };
};
