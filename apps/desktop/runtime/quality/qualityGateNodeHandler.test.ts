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
    const expectedRevisions: Array<number | undefined> = [];
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
          expectedRevisions.push(envelope.expectedRevision);
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
              expectedRevision: 0,
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
    assert.deepEqual(expectedRevisions, [0]);
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

  it("runs exact downstream authorization Commands only after a PASS Gate result", async () => {
    const commandTypes: string[] = [];
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: () => {
          throw new Error("PASS must not block");
        },
        completeClaimedAttempt: () => ({}) as never,
        executeQualityReviewStage: async () => ({
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
            result: "PASS",
            conditions: [],
            evidenceRefs: ["artifact-version:review-evidence"],
          },
          terminalExecutionFactId: "execution-fact-1",
        }),
      },
      commandRegistry: {
        execute: (envelope) => {
          commandTypes.push(envelope.command.type);
          return envelope.command.type === "quality-gate.result.finalize"
            ? ({
                status: "succeeded",
                value: {
                  id: "operability-result-1",
                  result: "PASS",
                  resultHash: "b".repeat(64),
                },
                effectIds: [],
              } as never)
            : ({ status: "succeeded", value: {}, effectIds: [] } as never);
        },
      },
      plans: {
        plan: () => ({
          handlerKindId: "operability-review@1",
          initialCommands: [],
          review: {
            reviewerSessionId: "reviewer-session-1",
            reviewerAiMemberId: "reviewer-1",
            reconcileExisting: false,
            timeoutSeconds: 60,
            request: reviewRequest,
            adapter: reviewerAdapter,
            terminalCommands: () => [
              {
                commandId: "finalize-operability-1",
                command: {
                  type: "quality-gate.result.finalize",
                } as EnvelopeCommand,
              },
            ],
          },
          afterPassCommands: [
            {
              commandId: "authorize-candidate-input-1",
              command: {
                type: "delivery.candidate-input.authorize",
              } as EnvelopeCommand,
            },
          ],
        }),
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(commandTypes, [
      "quality-gate.result.finalize",
      "delivery.candidate-input.authorize",
    ]);
  });

  it("blocks the claimed Attempt when the Reviewer terminal output cannot build exact Gate Commands", async () => {
    const blocked: unknown[] = [];
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: (input) => {
          blocked.push(input);
          return {} as never;
        },
        completeClaimedAttempt: () => {
          throw new Error("invalid Reviewer output must not complete");
        },
        executeQualityReviewStage: async () => ({
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
            result: "PASS",
            conditions: [],
            evidenceRefs: ["artifact-version:review-evidence"],
          },
          terminalExecutionFactId: "execution-fact-1",
        }),
      },
      commandRegistry: {
        execute: () =>
          ({ status: "succeeded", value: {}, effectIds: [] }) as never,
      },
      plans: {
        plan: () => ({
          handlerKindId: "security-review@1",
          initialCommands: [],
          review: {
            reviewerSessionId: "reviewer-session-1",
            reviewerAiMemberId: "reviewer-1",
            reconcileExisting: false,
            timeoutSeconds: 60,
            request: reviewRequest,
            adapter: reviewerAdapter,
            terminalCommands: () => {
              throw new Error(
                "Reviewer terminal result requires exact Candidate Gate execution observations.",
              );
            },
          },
        }),
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0], {
      runId: "run-1",
      nodeRunId: "node-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      workerId: "delivery-quality-node-handler",
      terminalExecutionFactId: "execution-fact-1",
      failure: {
        code: "DELIVERY_QUALITY_REVIEW_OUTPUT_INVALID",
        message:
          "Reviewer terminal result requires exact Candidate Gate execution observations.",
      },
    });
  });

  it("builds later Commands and the Reviewer request from an earlier authoritative Command result", async () => {
    const commands: EnvelopeCommand[] = [];
    const commandActors: unknown[] = [];
    let reviewerRequest: ReviewerExecutionInput | undefined;
    let reviewerExecutionInput: unknown;
    const handler = openQualityGateNodeHandler({
      pipelineRuntime: {
        claimReadyAttempt: () => attempt,
        blockClaimedAttempt: () => {
          throw new Error("authoritative staged plan must not block");
        },
        completeClaimedAttempt: () => ({}) as never,
        executeQualityReviewStage: async (input) => {
          reviewerExecutionInput = input;
          reviewerRequest = input.request;
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
              result: "PASS",
              conditions: [],
              evidenceRefs: ["artifact-version:review-evidence"],
            },
            terminalExecutionFactId: "execution-fact-1",
          };
        },
      },
      commandRegistry: {
        execute: (envelope) => {
          commands.push(envelope.command);
          commandActors.push(envelope.actor);
          if (envelope.command.type === "quality-gate.input.prepare") {
            return {
              status: "succeeded",
              value: {
                id: "gate-input-1",
                manifestHash: "a".repeat(64),
              },
              effectIds: [],
            } as never;
          }
          if (envelope.command.type === "quality-gate.result.finalize") {
            return {
              status: "succeeded",
              value: {
                id: "security-result-1",
                result: "PASS",
                resultHash: "b".repeat(64),
              },
              effectIds: [],
            } as never;
          }
          return { status: "succeeded", value: {}, effectIds: [] } as never;
        },
      },
      plans: {
        plan: () => ({
          handlerKindId: "security-review@1",
          initialCommands: [
            {
              commandId: "prepare-gate-input-1",
              command: {
                type: "quality-gate.input.prepare",
              } as EnvelopeCommand,
            },
            (context) => {
              const prepared = context.result("prepare-gate-input-1").value as {
                readonly id: string;
                readonly manifestHash: string;
              };
              return {
                commandId: "submit-review-revision-1",
                actor: {
                  type: "runtime-worker",
                  id: "producer-1",
                  authenticatedBy: "runtime",
                },
                command: {
                  type: "review.revision.submit",
                  subjectId: prepared.id,
                  subjectHash: prepared.manifestHash,
                } as EnvelopeCommand,
              };
            },
          ],
          review: {
            reviewerSessionId: "reviewer-session-1",
            reviewerAiMemberId: "reviewer-1",
            reconcileExisting: false,
            timeoutSeconds: 60,
            request: (context) => {
              const prepared = context.result("prepare-gate-input-1").value as {
                readonly id: string;
                readonly manifestHash: string;
              };
              return {
                ...reviewRequest,
                revision: {
                  id: "revision-1",
                  subjectId: prepared.id,
                  subjectHash: prepared.manifestHash,
                },
              };
            },
            adapter: reviewerAdapter,
            terminalCommands: () => [
              {
                commandId: "finalize-security-1",
                actor: {
                  type: "runtime-worker",
                  id: "reviewer-1",
                  authenticatedBy: "runtime",
                },
                command: {
                  type: "quality-gate.result.finalize",
                } as EnvelopeCommand,
              },
            ],
          },
        }),
      },
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(commands[1], {
      type: "review.revision.submit",
      subjectId: "gate-input-1",
      subjectHash: "a".repeat(64),
    });
    assert.deepEqual(reviewerRequest?.revision, {
      id: "revision-1",
      subjectId: "gate-input-1",
      subjectHash: "a".repeat(64),
    });
    assert.deepEqual(reviewerExecutionInput, {
      runId: "run-1",
      nodeRunId: "node-1",
      handlerKindId: "security-review@1",
      reviewerSessionId: "reviewer-session-1",
      reviewerAiMemberId: "reviewer-1",
      operationKey: "node-attempt:attempt-1",
      reconcileExisting: false,
      timeoutSeconds: 60,
      request: {
        operationKey: "node-attempt:attempt-1",
        revision: {
          id: "revision-1",
          subjectId: "gate-input-1",
          subjectHash: "a".repeat(64),
        },
      },
      adapter: reviewerAdapter,
      executionLease: {
        leaseId: "lease-1",
        leaseKind: "execution",
        operationKey: "node-attempt:attempt-1",
        target: { kind: "node-attempt", id: "attempt-1" },
        executionEpoch: 1,
        fenceToken: "fence-1",
      },
    });
    assert.deepEqual(commandActors, [
      {
        type: "runtime-worker",
        id: "delivery-quality-node-handler",
        authenticatedBy: "runtime",
      },
      {
        type: "runtime-worker",
        id: "producer-1",
        authenticatedBy: "runtime",
      },
      {
        type: "runtime-worker",
        id: "reviewer-1",
        authenticatedBy: "runtime",
      },
    ]);
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
