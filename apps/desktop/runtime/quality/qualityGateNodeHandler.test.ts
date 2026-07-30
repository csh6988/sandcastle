import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvelopeCommand } from "../interface.js";
import type { ReadyAttemptClaim } from "../pipeline/pipelineRuntime.js";
import type { ReviewerExecutionInput } from "../review/reviewerExecution.js";
import {
  openQualityGateNodeHandler,
  type DeliveryQualityNodePlan,
} from "./qualityGateNodeHandler.js";

const attempt: Extract<ReadyAttemptClaim, { readonly kind: "claimed" }> = {
  kind: "claimed",
  attemptId: "attempt-1",
  nodeRunId: "node-1",
  snapshotRevisionId: "snapshot-1",
  leaseId: "lease-1",
  leaseOwner: "delivery-quality-node-handler",
  leaseExpiresAt: "2026-07-30T00:05:00.000Z",
  operationKey: "node-attempt:attempt-1",
  executionEpoch: 1,
  fenceToken: "fence-1",
};

const reviewRequest = {} as ReviewerExecutionInput;
const reviewerAdapter = {
  capabilities: {
    executionBoundIsolation: true,
    reattachRunningOperation: true,
  },
  execute: async () => ({
    status: "unknown" as const,
    code: "RECONCILE_UNKNOWN" as const,
    message: "unused",
    evidence: [],
  }),
};

describe("Quality Gate Node Handler", () => {
  it("fails closed when production has no immutable Delivery/Quality plan", async () => {
    const blocked: unknown[] = [];
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: (input) => {
          blocked.push(input);
          return {} as never;
        },
        completeClaimedAttempt: () => {
          throw new Error(
            "A missing production plan must not complete the Node.",
          );
        },
        executeQualityReviewStage: async () => {
          throw new Error(
            "A missing production plan must not run a scripted reviewer.",
          );
        },
      },
      commandRegistry: {
        execute: () => {
          throw new Error(
            "A missing production plan must not execute Commands.",
          );
        },
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(blocked, [
      {
        runId: "run-1",
        nodeRunId: "node-1",
        attemptId: "attempt-1",
        leaseId: "lease-1",
        workerId: "delivery-quality-node-handler",
        failure: {
          code: "DELIVERY_QUALITY_PLAN_UNAVAILABLE",
          message:
            "The Delivery/Quality Node has no Runtime-owned immutable Command plan.",
        },
      },
    ]);
  });

  it("uses formal Commands and lets Pipeline Runtime complete the Candidate Input Attempt", async () => {
    const commands: EnvelopeCommand[] = [];
    const completed: unknown[] = [];
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: () => {
          throw new Error("unexpected block");
        },
        completeClaimedAttempt: (input) => {
          completed.push(input);
          return {} as never;
        },
        executeQualityReviewStage: async () => {
          throw new Error("Candidate Input must not run a Reviewer.");
        },
      },
      commandRegistry: {
        execute: (envelope) => {
          commands.push(envelope.command);
          return {
            status: "succeeded",
            value: {
              id: "candidate-input-1",
              manifestHash: "a".repeat(64),
            },
            effectIds: ["audit-1"],
          } as never;
        },
      },
      plans: {
        plan: () => ({
          handlerKindId: "delivery-candidate-input@1",
          initialCommands: [
            {
              commandId: "freeze-candidate-1",
              command: {
                type: "delivery.candidate-input.freeze",
              } as EnvelopeCommand,
            },
          ],
        }),
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(
      commands.map((command) => command.type),
      ["delivery.candidate-input.freeze"],
    );
    assert.equal(completed.length, 1);
  });

  it("reuses the Pipeline Reviewer execution seam and blocks non-PASS Gate results", async () => {
    const calls: string[] = [];
    const blocked: unknown[] = [];
    const plan: DeliveryQualityNodePlan = {
      handlerKindId: "security-review@1",
      initialCommands: [
        {
          commandId: "prepare-security-1",
          command: { type: "quality-gate.input.prepare" } as EnvelopeCommand,
        },
      ],
      review: {
        reviewerSessionId: "security-session-1",
        reviewerAiMemberId: "security-reviewer-1",
        operationKey: "security-review:gate-1",
        reconcileExisting: false,
        timeoutSeconds: 60,
        request: reviewRequest,
        adapter: reviewerAdapter,
        terminalCommands: () => [
          {
            commandId: "finalize-security-1",
            command: {
              type: "quality-gate.result.finalize",
            } as EnvelopeCommand,
          },
        ],
      },
    };
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: (input) => {
          blocked.push(input);
          return {} as never;
        },
        completeClaimedAttempt: () => {
          throw new Error(
            "CONDITIONAL_PASS must not complete the Pipeline Node.",
          );
        },
        executeQualityReviewStage: async () => {
          calls.push("review");
          return {
            status: "succeeded",
            providerId: "scripted-reviewer",
            isolation: {
              readOnlyFilesystem: true,
              independentGitDatabase: true,
              independentSessionStorage: true,
              independentCredentialScope: true,
              independentMutableCache: true,
              inputAllowlist: true,
              mechanism: "fixture",
              mechanismVersion: "1",
            },
            isolationEvidence: ["artifact-version:review-isolation"],
            output: {
              result: "CONDITIONAL_PASS",
              conditions: ["close obligation"],
              evidenceRefs: ["artifact-version:review-evidence"],
            },
            terminalExecutionFactId: "execution-fact-1",
          };
        },
      },
      commandRegistry: {
        execute: (envelope) => {
          calls.push(envelope.command.type);
          return envelope.command.type === "quality-gate.result.finalize"
            ? ({
                status: "succeeded",
                value: {
                  id: "security-result-1",
                  result: "CONDITIONAL_PASS",
                  resultHash: "b".repeat(64),
                },
                effectIds: ["audit-result"],
              } as never)
            : ({ status: "succeeded", value: {}, effectIds: [] } as never);
        },
      },
      plans: { plan: () => plan },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(calls, [
      "quality-gate.input.prepare",
      "review",
      "quality-gate.result.finalize",
    ]);
    assert.equal(blocked.length, 1);
  });

  it("replays the exact formal Candidate Input Command after Pipeline recovery", async () => {
    const recoveredAttempt = {
      ...attempt,
      attemptId: "attempt-2",
      leaseId: "lease-2",
      operationKey: "node-attempt:attempt-2",
      executionEpoch: 2,
    };
    const claims = [attempt, recoveredAttempt];
    const commandIds: string[] = [];
    const completedAttemptIds: string[] = [];
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () =>
          claims.shift() ?? { kind: "no-work", reason: "no-ready-attempt" },
        blockClaimedAttempt: () => {
          throw new Error("exact Command replay must remain completable");
        },
        completeClaimedAttempt: (input) => {
          completedAttemptIds.push(input.attemptId);
          return {} as never;
        },
        executeQualityReviewStage: async () => {
          throw new Error("Candidate Input must not run a Reviewer.");
        },
      },
      commandRegistry: {
        execute: (envelope) => {
          commandIds.push(envelope.commandId);
          return {
            status: "succeeded",
            value: {
              id: "candidate-input-1",
              manifestHash: "a".repeat(64),
            },
            effectIds: ["audit-first"],
          } as never;
        },
      },
      plans: {
        plan: () => ({
          handlerKindId: "delivery-candidate-input@1",
          initialCommands: [
            {
              commandId: "freeze-candidate-1",
              command: {
                type: "delivery.candidate-input.freeze",
              } as EnvelopeCommand,
            },
          ],
        }),
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(commandIds, ["freeze-candidate-1", "freeze-candidate-1"]);
    assert.deepEqual(completedAttemptIds, ["attempt-1", "attempt-2"]);
  });
});
