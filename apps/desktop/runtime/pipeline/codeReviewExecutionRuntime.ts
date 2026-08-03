import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createExecutionFactSink,
  ExecutionFactError,
  inspectExecution,
} from "../execution/executionFacts.js";
import type {
  ExecutionEventSink,
  ExecutionLeaseContext,
} from "../execution/contract.js";
import type {
  ReviewerExecutionAdapter,
  ReviewerExecutionInput,
  ReviewerExecutionResult,
} from "../review/reviewerExecution.js";
import { canonicalPipelineJson, pipelineHash } from "./canonicalPipeline.js";

export interface ActivePipelineExecution {
  readonly attemptId: string;
  readonly runId: string;
  readonly operationKey: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly cancel?: () => Promise<unknown>;
}

export interface CodeReviewStageExecutionInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly reviewerSessionId: string;
  readonly reviewerAiMemberId: string;
  readonly operationKey: string;
  readonly reconcileExisting: boolean;
  readonly timeoutSeconds: number;
  readonly request: ReviewerExecutionInput;
  readonly adapter: ReviewerExecutionAdapter;
  readonly executionLease?: ExecutionLeaseContext & {
    readonly target: {
      readonly kind: "node-attempt";
      readonly id: string;
    };
  };
  readonly handlerKindId:
    | "code-review@1"
    | "integration@1"
    | "security-review@1"
    | "operability-review@1";
  readonly workerId:
    | "code-review-node-handler"
    | "integration-node-handler"
    | "delivery-quality-node-handler";
}

interface RuntimeMutationInput {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly eventType: string;
  readonly runId?: string;
  readonly nodeRunId?: string;
  readonly before?: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

interface ExecutionEventInput {
  readonly type: string;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export const openCodeReviewExecutionRuntime = (options: {
  readonly database: DatabaseSync;
  readonly clock: () => Date;
  readonly activeExecutions: Map<string, ActivePipelineExecution>;
  readonly appendRuntimeMutation: (input: RuntimeMutationInput) => void;
  readonly appendExecutionEvent: (input: ExecutionEventInput) => void;
  readonly runtimeError: (code: string, message: string) => Error;
}): ((
  input: CodeReviewStageExecutionInput,
) => Promise<ReviewerExecutionResult>) => {
  const {
    database,
    clock,
    activeExecutions,
    appendRuntimeMutation,
    appendExecutionEvent,
    runtimeError,
  } = options;

  return async (input) => {
    const attempt = database
      .prepare(
        `SELECT node_attempts.id AS attemptId
           FROM node_attempts
           JOIN node_runs ON node_runs.id = node_attempts.node_run_id
          WHERE node_runs.id = ? AND node_runs.run_id = ?
            AND node_runs.handler_kind_id = ?
            AND node_attempts.status IN ('running', 'reconciling')
          ORDER BY node_attempts.attempt_number DESC LIMIT 1`,
      )
      .get(input.nodeRunId, input.runId, input.handlerKindId) as
      | { readonly attemptId: string }
      | undefined;
    if (!attempt) {
      throw runtimeError(
        "CODE_REVIEW_EXECUTION_STATE_INVALID",
        `Node ${input.nodeRunId} has no active Attempt for independent Reviewer execution.`,
      );
    }

    const existing = inspectExecution(database, {
      operationKey: input.operationKey,
    });
    if (input.executionLease) {
      const lease = existing.leases.find(
        (candidate) => candidate.leaseId === input.executionLease?.leaseId,
      );
      if (
        input.executionLease.operationKey !== input.operationKey ||
        input.executionLease.target.id !== attempt.attemptId ||
        existing.target.kind !== "node-attempt" ||
        existing.target.id !== attempt.attemptId ||
        !lease ||
        lease.leaseKind !== "execution" ||
        lease.executionEpoch !== input.executionLease.executionEpoch ||
        lease.fenceToken !== input.executionLease.fenceToken ||
        lease.releasedAt !== null ||
        Date.parse(lease.expiresAt) <= clock().getTime()
      ) {
        throw runtimeError(
          "CODE_REVIEW_EXECUTION_STATE_INVALID",
          `Node ${input.nodeRunId} cannot reuse an invalid Reviewer execution Lease.`,
        );
      }
    }
    const existingTerminal = existing.facts.find(
      (fact) =>
        fact.status === "accepted" &&
        ["completed", "failed", "cancelled"].includes(fact.kind),
    );
    if (existingTerminal && existingTerminal.kind !== "completed") {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: `Reviewer execution ${input.operationKey} has terminal ${existingTerminal.kind} evidence and cannot be replayed.`,
        evidence: existingTerminal.evidenceRefs,
      };
    }

    const reconciliation =
      input.reconcileExisting ||
      existing.leases.some(
        (lease) => lease.leaseId !== input.executionLease?.leaseId,
      );
    const providerExecutionRef = [...existing.facts]
      .reverse()
      .filter(
        (fact) =>
          fact.status === "accepted" && fact.kind === "provider-started",
      )
      .map((fact) =>
        typeof fact.payload === "object" &&
        fact.payload !== null &&
        typeof (fact.payload as Record<string, unknown>)
          .providerExecutionRef === "string"
          ? String(
              (fact.payload as Record<string, unknown>).providerExecutionRef,
            )
          : undefined,
      )
      .find((value): value is string => Boolean(value));

    const busyResult = (): ReviewerExecutionResult =>
      providerExecutionRef
        ? { status: "running", providerExecutionRef }
        : {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message: `Reviewer execution ${input.operationKey} already has an active execution claim whose provider result is not yet provable.`,
            evidence: [],
          };

    const activeLease = existing.leases.find(
      (lease) =>
        lease.releasedAt === null &&
        Date.parse(lease.expiresAt) > clock().getTime(),
    );
    if (activeLease && activeLease.leaseId !== input.executionLease?.leaseId) {
      return busyResult();
    }

    const issueLease = (
      leaseKind: "execution" | "reconciliation",
    ):
      | (ExecutionLeaseContext & {
          readonly target: {
            readonly kind: "node-attempt";
            readonly id: string;
          };
        })
      | null => {
      const issuedAt = clock();
      const issuedAtIso = issuedAt.toISOString();
      const leaseId = randomUUID();
      const target = { kind: "node-attempt" as const, id: attempt.attemptId };
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = database
          .prepare(
            `SELECT id, expires_at AS expiresAt
               FROM execution_leases
              WHERE operation_key = ? AND released_at IS NULL
              ORDER BY execution_epoch DESC LIMIT 1`,
          )
          .get(input.operationKey) as
          | { readonly id: string; readonly expiresAt: string }
          | undefined;
        if (current) {
          if (
            leaseKind !== "reconciliation" ||
            Date.parse(current.expiresAt) > issuedAt.getTime()
          ) {
            database.exec("COMMIT");
            return null;
          }
          const released = database
            .prepare(
              `UPDATE execution_leases SET released_at = ?
                WHERE id = ? AND released_at IS NULL AND expires_at <= ?`,
            )
            .run(issuedAtIso, current.id, issuedAtIso);
          if (Number(released.changes) !== 1) {
            database.exec("COMMIT");
            return null;
          }
        }
        const epoch = database
          .prepare(
            `SELECT COALESCE(MAX(execution_epoch), 0) + 1 AS executionEpoch
               FROM execution_leases WHERE operation_key = ?`,
          )
          .get(input.operationKey) as { readonly executionEpoch: number };
        const lease = {
          leaseId,
          leaseKind,
          operationKey: input.operationKey,
          target,
          executionEpoch: Number(epoch.executionEpoch),
          fenceToken: `code-review-fence:${randomUUID()}`,
        };
        database
          .prepare(
            `INSERT INTO execution_leases(
               id, target_kind, target_id, lease_kind, operation_key,
               execution_epoch, fence_token, worker_id, issued_at,
               expires_at, renewed_at, released_at, cancel_requested
             ) VALUES (?, 'node-attempt', ?, ?, ?, ?, ?,
                       ?, ?, ?, NULL, NULL, 0)`,
          )
          .run(
            leaseId,
            attempt.attemptId,
            leaseKind,
            input.operationKey,
            lease.executionEpoch,
            lease.fenceToken,
            input.workerId,
            issuedAtIso,
            new Date(
              issuedAt.getTime() + input.timeoutSeconds * 1_000,
            ).toISOString(),
          );
        database.exec("COMMIT");
        return lease;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    const runWithLease = async (
      lease: ExecutionLeaseContext & {
        readonly target: {
          readonly kind: "node-attempt";
          readonly id: string;
        };
      },
      execute: (
        sink: ExecutionEventSink,
        signal: AbortSignal,
      ) => Promise<ReviewerExecutionResult>,
      releaseLease = true,
    ): Promise<ReviewerExecutionResult> => {
      const controller = new AbortController();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const currentProviderRef = (): string | undefined =>
        [
          ...inspectExecution(database, { operationKey: input.operationKey })
            .facts,
        ]
          .reverse()
          .filter(
            (fact) =>
              fact.status === "accepted" && fact.kind === "provider-started",
          )
          .map((fact) =>
            typeof fact.payload === "object" &&
            fact.payload !== null &&
            typeof (fact.payload as Record<string, unknown>)
              .providerExecutionRef === "string"
              ? String(
                  (fact.payload as Record<string, unknown>)
                    .providerExecutionRef,
                )
              : undefined,
          )
          .find((value): value is string => Boolean(value));
      activeExecutions.set(attempt.attemptId, {
        attemptId: attempt.attemptId,
        runId: input.runId,
        operationKey: input.operationKey,
        controller,
        done,
        ...(input.adapter.cancel
          ? {
              cancel: () =>
                input.adapter.cancel!(input.operationKey, currentProviderRef()),
            }
          : {}),
      });
      const baseSink = createExecutionFactSink({
        database,
        lease,
        target: lease.target,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        attemptId: attempt.attemptId,
        now: clock,
        appendEvent: (event) =>
          appendExecutionEvent({
            ...event,
            runId: input.runId,
            nodeRunId: input.nodeRunId,
            attemptId: attempt.attemptId,
            payload: event.payload,
            createdAt: event.timestamp,
          }),
        applyAcceptedFact: ({ fact, now }) => {
          if (fact.kind !== "message") return [];
          const payload =
            typeof fact.payload === "object" && fact.payload !== null
              ? (fact.payload as Record<string, unknown>)
              : {};
          const content =
            typeof payload.content === "string" ? payload.content.trim() : "";
          if (!content) {
            throw new ExecutionFactError(
              "EXECUTION_ADAPTER_PROTOCOL",
              "Reviewer message Fact requires non-empty content.",
            );
          }
          const participant = database
            .prepare(
              `SELECT id FROM session_participants
                WHERE session_id = ? AND participant_type = 'ai-member'
                  AND participant_ref = ?
                ORDER BY created_at, id LIMIT 1`,
            )
            .get(input.reviewerSessionId, input.reviewerAiMemberId) as
            | { readonly id: string }
            | undefined;
          if (!participant) {
            throw new ExecutionFactError(
              "EXECUTION_ADAPTER_PROTOCOL",
              "Reviewer message Fact lost its frozen Session participant.",
            );
          }
          const messageId = randomUUID();
          database
            .prepare(
              `INSERT INTO session_messages(
                 id, session_id, participant_id, kind, content, created_at
               ) VALUES (?, ?, ?, 'text', ?, ?)`,
            )
            .run(
              messageId,
              input.reviewerSessionId,
              participant.id,
              content,
              now,
            );
          return [messageId];
        },
      });
      const sink: ExecutionEventSink = { record: baseSink.record };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const renewalIntervalMs = Math.max(
        250,
        Math.min(30_000, Math.floor((input.timeoutSeconds * 1_000) / 3)),
      );
      const renewal = setInterval(() => {
        const renewedAt = clock();
        const renewed = database
          .prepare(
            `UPDATE execution_leases
                SET renewed_at = ?, expires_at = ?
              WHERE id = ? AND released_at IS NULL`,
          )
          .run(
            renewedAt.toISOString(),
            new Date(
              renewedAt.getTime() + input.timeoutSeconds * 1_000,
            ).toISOString(),
            lease.leaseId,
          );
        if (renewed.changes !== 1) controller.abort();
      }, renewalIntervalMs);
      renewal.unref();
      try {
        const execution = execute(sink, controller.signal);
        const timed = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              runtimeError(
                "EXECUTION_TIMEOUT",
                `Reviewer execution ${input.operationKey} exceeded ${input.timeoutSeconds}s.`,
              ),
            );
          }, input.timeoutSeconds * 1_000);
        });
        const result = await Promise.race([execution, timed]);
        if (timeout) clearTimeout(timeout);
        if (result.status === "running") {
          throw runtimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "A Reviewer execute/reattach call cannot return running.",
          );
        }
        if (controller.signal.aborted) {
          return {
            status: "unknown",
            code: "RECONCILE_UNKNOWN",
            message:
              "Reviewer execution was locally aborted and requires provider reconciliation.",
            evidence: [],
          };
        }
        if (result.status === "unknown") return result;
        const ordinal =
          Math.max(
            0,
            ...inspectExecution(database, {
              operationKey: input.operationKey,
            })
              .facts.filter(
                (fact) => fact.executionEpoch === lease.executionEpoch,
              )
              .map((fact) => fact.ordinal),
          ) + 1;
        const receipt = await sink.record({
          adapterSchemaVersion: 1,
          factId: `${input.operationKey}:completed:${lease.executionEpoch}`,
          ordinal,
          kind: "completed",
          schemaVersion: 1,
          payload: { structuredResult: result },
          evidenceRefs:
            result.status === "succeeded"
              ? result.isolationEvidence
              : result.evidence,
        });
        if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
          throw runtimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "Reviewer terminal Execution Fact was not accepted.",
          );
        }
        return {
          ...result,
          terminalExecutionFactId: receipt.executionFactId,
        };
      } finally {
        if (timeout) clearTimeout(timeout);
        clearInterval(renewal);
        if (releaseLease) {
          database
            .prepare(
              `UPDATE execution_leases SET released_at = COALESCE(released_at, ?)
                WHERE id = ?`,
            )
            .run(clock().toISOString(), lease.leaseId);
        }
        if (
          activeExecutions.get(attempt.attemptId)?.operationKey ===
          input.operationKey
        ) {
          activeExecutions.delete(attempt.attemptId);
        }
        resolveDone();
      }
    };

    type CompletedReviewerExecutionResult = Exclude<
      ReviewerExecutionResult,
      { readonly status: "running" | "unknown" }
    >;

    const acceptedCompletedResult = (details: {
      readonly executionFactId: string;
      readonly expectedLease?: ExecutionLeaseContext;
      readonly reportedResult?: CompletedReviewerExecutionResult;
    }): CompletedReviewerExecutionResult => {
      const fact = inspectExecution(database, {
        operationKey: input.operationKey,
      }).facts.find((candidate) => candidate.id === details.executionFactId);
      if (
        !fact ||
        fact.status !== "accepted" ||
        fact.kind !== "completed" ||
        (details.expectedLease &&
          (fact.leaseId !== details.expectedLease.leaseId ||
            fact.leaseKind !== "reconciliation" ||
            fact.executionEpoch !== details.expectedLease.executionEpoch ||
            fact.fenceToken !== details.expectedLease.fenceToken))
      ) {
        throw runtimeError(
          "EXECUTION_ADAPTER_PROTOCOL",
          `Reviewer reconciliation did not reference an accepted completed Fact under the active reconciliation lease.`,
        );
      }
      const payload =
        typeof fact.payload === "object" &&
        fact.payload !== null &&
        !Array.isArray(fact.payload)
          ? (fact.payload as Record<string, unknown>)
          : {};
      const structuredResult = payload.structuredResult;
      if (
        typeof structuredResult !== "object" ||
        structuredResult === null ||
        !["succeeded", "blocked"].includes(
          String(
            (structuredResult as { readonly status?: unknown }).status ?? "",
          ),
        )
      ) {
        throw runtimeError(
          "EXECUTION_ADAPTER_PROTOCOL",
          "Reviewer completed Fact requires an exact terminal structured result.",
        );
      }
      if (details.reportedResult) {
        const {
          terminalExecutionFactId: _terminalExecutionFactId,
          ...reportedResult
        } = details.reportedResult;
        if (pipelineHash(structuredResult) !== pipelineHash(reportedResult)) {
          throw runtimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "Reviewer reconciliation result does not match its accepted completed Fact.",
          );
        }
      }
      const completedResult =
        structuredResult as CompletedReviewerExecutionResult;
      return { ...completedResult, terminalExecutionFactId: fact.id };
    };

    const continueAfterTerminalReconciliation = (details: {
      readonly terminalExecutionFactId: string;
    }): void => {
      const commandPrefix =
        input.workerId === "code-review-node-handler"
          ? "code-review"
          : input.workerId === "integration-node-handler"
            ? "integration-review"
            : "delivery-quality-review";
      const commandId = `${commandPrefix}:terminal-reconciliation:${details.terminalExecutionFactId}`;
      const request = {
        operationKey: input.operationKey,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        terminalExecutionFactId: details.terminalExecutionFactId,
      };
      const requestHash = pipelineHash(request);
      const existingReceipt = database
        .prepare(
          `SELECT status, request_hash AS requestHash,
                  result_json AS resultJson, result_hash AS resultHash
             FROM command_deduplication WHERE command_id = ?`,
        )
        .get(commandId) as
        | {
            readonly status: string;
            readonly requestHash: string;
            readonly resultJson: string | null;
            readonly resultHash: string | null;
          }
        | undefined;
      if (existingReceipt) {
        let receipt: unknown;
        try {
          receipt = existingReceipt.resultJson
            ? (JSON.parse(existingReceipt.resultJson) as unknown)
            : null;
        } catch (error) {
          throw runtimeError(
            "COMMAND_RECEIPT_INVALID",
            `Code Review terminal reconciliation receipt is invalid JSON: ${String(error)}`,
          );
        }
        const value =
          typeof receipt === "object" && receipt !== null
            ? (receipt as { readonly value?: unknown }).value
            : undefined;
        const receiptValue =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        if (
          existingReceipt.status !== "completed" ||
          existingReceipt.requestHash !== requestHash ||
          !existingReceipt.resultHash ||
          pipelineHash(receipt) !== existingReceipt.resultHash ||
          receiptValue.continuationAttemptId !== attempt.attemptId ||
          receiptValue.terminalExecutionFactId !==
            details.terminalExecutionFactId
        ) {
          throw runtimeError(
            "COMMAND_REPLAY_CONFLICT",
            "Code Review terminal reconciliation receipt does not match the current continuation Attempt.",
          );
        }
        return;
      }
      const current = database
        .prepare(
          `SELECT node_attempts.status AS attemptStatus,
                  node_attempts.attempt_number AS attemptNumber,
                  node_attempts.snapshot_revision_id AS snapshotRevisionId,
                  node_runs.status AS nodeStatus,
                  node_runs.attempt_count AS attemptCount,
                  department_runs.status AS runStatus
             FROM node_attempts
             JOIN node_runs ON node_runs.id = node_attempts.node_run_id
             JOIN department_runs ON department_runs.id = node_runs.run_id
            WHERE node_attempts.id = ? AND node_runs.id = ?
              AND department_runs.id = ?`,
        )
        .get(attempt.attemptId, input.nodeRunId, input.runId) as
        | {
            readonly attemptStatus: string;
            readonly attemptNumber: number;
            readonly snapshotRevisionId: string;
            readonly nodeStatus: string;
            readonly attemptCount: number;
            readonly runStatus: string;
          }
        | undefined;
      if (
        !current ||
        !["running", "reconciling"].includes(current.attemptStatus)
      ) {
        return;
      }
      const validActiveState =
        (current.attemptStatus === "running" &&
          current.nodeStatus === "running" &&
          current.runStatus === "running") ||
        (current.attemptStatus === "reconciling" &&
          current.nodeStatus === "blocked" &&
          current.runStatus === "blocked");
      if (!validActiveState || current.attemptCount !== current.attemptNumber) {
        throw runtimeError(
          "CODE_REVIEW_EXECUTION_STATE_INVALID",
          `Code Review Node Attempt ${attempt.attemptId} cannot continue after terminal reconciliation from ${current.attemptStatus}/${current.nodeStatus}/${current.runStatus}.`,
        );
      }
      const terminalFact = inspectExecution(database, {
        operationKey: input.operationKey,
      }).facts.find(
        (candidate) => candidate.id === details.terminalExecutionFactId,
      );
      if (
        !terminalFact ||
        terminalFact.target.kind !== "node-attempt" ||
        terminalFact.target.id !== attempt.attemptId
      ) {
        throw runtimeError(
          "EXECUTION_ADAPTER_PROTOCOL",
          "The first terminal reconciliation must target the aggregate Attempt being interrupted.",
        );
      }
      const now = clock().toISOString();
      const nextAttemptId = randomUUID();
      const nextAttemptNumber = current.attemptNumber + 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT INTO runtime_unit_of_work_context(
               slot, command_id, actor_type, actor_id, authenticated_by,
               consumer_id, schema_version
             ) VALUES (1, ?, 'runtime-worker', ?, 'runtime', ?, 1)`,
          )
          .run(commandId, input.workerId, input.workerId);
        const interrupted = database
          .prepare(
            `UPDATE node_attempts
                SET status = 'interrupted', recoverable = 1,
                    failure_code = 'EXECUTION_RECONCILED_TERMINAL_RESULT',
                    failure_message = 'Provider completion was recovered; aggregate processing continues in a fresh Attempt.',
                    completed_at = ?, terminal_execution_fact_id = ?
              WHERE id = ? AND status = ?`,
          )
          .run(
            now,
            details.terminalExecutionFactId,
            attempt.attemptId,
            current.attemptStatus,
          );
        const resumedNode = database
          .prepare(
            `UPDATE node_runs
                SET status = 'running', attempt_count = ?, result_json = NULL,
                    failure_code = NULL, failure_message = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND status = ?
                AND attempt_count = ?`,
          )
          .run(
            nextAttemptNumber,
            now,
            input.nodeRunId,
            input.runId,
            current.nodeStatus,
            current.attemptNumber,
          );
        const resumedRun = database
          .prepare(
            `UPDATE department_runs
                SET status = 'running', revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND status = ?`,
          )
          .run(now, input.runId, current.runStatus);
        if (
          interrupted.changes !== 1 ||
          resumedNode.changes !== 1 ||
          resumedRun.changes !== 1
        ) {
          throw runtimeError(
            "CODE_REVIEW_EXECUTION_STATE_INVALID",
            `Code Review Node Attempt ${attempt.attemptId} cannot continue after its reconciled terminal Fact.`,
          );
        }
        database
          .prepare(
            `INSERT INTO node_attempts(
               id, node_run_id, attempt_number, snapshot_revision_id, reason,
               status, structured_result_json, failure_code, failure_message,
               created_at, started_at, completed_at
             ) VALUES (?, ?, ?, ?, 'recovery', 'running', NULL, NULL, NULL,
                       ?, ?, NULL)`,
          )
          .run(
            nextAttemptId,
            input.nodeRunId,
            nextAttemptNumber,
            current.snapshotRevisionId,
            now,
            now,
          );
        appendRuntimeMutation({
          action: "attempt.code-review-terminal-reconciled",
          entityType: "node-attempt",
          entityId: attempt.attemptId,
          eventType: "attempt.interrupted",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          before: {
            attemptStatus: current.attemptStatus,
            nodeStatus: current.nodeStatus,
            runStatus: current.runStatus,
          },
          after: {
            attemptStatus: "interrupted",
            terminalExecutionFactId: details.terminalExecutionFactId,
          },
          createdAt: now,
        });
        appendRuntimeMutation({
          action: "attempt.code-review-recovery",
          entityType: "node-attempt",
          entityId: nextAttemptId,
          eventType: "attempt.started",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          before: null,
          after: {
            attemptStatus: "running",
            attemptNumber: nextAttemptNumber,
            reason: "recovery",
            nodeStatus: "running",
            runStatus: "running",
          },
          createdAt: now,
        });
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(commandId) as Array<{ readonly id: string }>
        ).map((entry) => entry.id);
        const receipt = {
          status: "succeeded",
          value: {
            interruptedAttemptId: attempt.attemptId,
            continuationAttemptId: nextAttemptId,
            terminalExecutionFactId: details.terminalExecutionFactId,
          },
          effectIds,
        };
        database
          .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
          .run();
        database
          .prepare(
            `INSERT INTO command_deduplication(
               command_id, actor_type, actor_id, authenticated_by, consumer_id,
               schema_version, request_hash, status, result_json, result_hash,
               effect_ids_json, completed_at
             ) VALUES (?, 'runtime-worker', ?, 'runtime', ?, 1, ?, 'completed',
                       ?, ?, ?, ?)`,
          )
          .run(
            commandId,
            input.workerId,
            input.workerId,
            requestHash,
            canonicalPipelineJson(receipt),
            pipelineHash(receipt),
            canonicalPipelineJson(effectIds),
            now,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    const resumeReconciledAttempt = (reconciliationLeaseId: string): void => {
      const current = database
        .prepare(
          `SELECT node_attempts.status AS attemptStatus,
                  node_runs.status AS nodeStatus,
                  department_runs.status AS runStatus
             FROM node_attempts
             JOIN node_runs ON node_runs.id = node_attempts.node_run_id
             JOIN department_runs ON department_runs.id = node_runs.run_id
            WHERE node_attempts.id = ? AND node_runs.id = ?
              AND department_runs.id = ?`,
        )
        .get(attempt.attemptId, input.nodeRunId, input.runId) as
        | {
            readonly attemptStatus: string;
            readonly nodeStatus: string;
            readonly runStatus: string;
          }
        | undefined;
      if (!current || current.attemptStatus !== "reconciling") return;
      const now = clock().toISOString();
      const commandPrefix =
        input.workerId === "code-review-node-handler"
          ? "code-review"
          : input.workerId === "integration-node-handler"
            ? "integration-review"
            : "delivery-quality-review";
      const commandId = `${commandPrefix}:execution-reattach:${reconciliationLeaseId}`;
      const request = {
        operationKey: input.operationKey,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        attemptId: attempt.attemptId,
        providerExecutionRef,
      };
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT INTO runtime_unit_of_work_context(
               slot, command_id, actor_type, actor_id, authenticated_by,
               consumer_id, schema_version
             ) VALUES (1, ?, 'runtime-worker', ?, 'runtime', ?, 1)`,
          )
          .run(commandId, input.workerId, input.workerId);
        const resumedAttempt = database
          .prepare(
            `UPDATE node_attempts
                SET status = 'running', recoverable = 0,
                    failure_code = NULL, failure_message = NULL,
                    completed_at = NULL
              WHERE id = ? AND status = 'reconciling'`,
          )
          .run(attempt.attemptId);
        const resumedNode = database
          .prepare(
            `UPDATE node_runs
                SET status = 'running', failure_code = NULL,
                    failure_message = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND status = 'blocked'`,
          )
          .run(now, input.nodeRunId, input.runId);
        const resumedRun = database
          .prepare(
            `UPDATE department_runs
                SET status = 'running', revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND status = 'blocked'`,
          )
          .run(now, input.runId);
        if (
          resumedAttempt.changes !== 1 ||
          resumedNode.changes !== 1 ||
          resumedRun.changes !== 1
        ) {
          throw runtimeError(
            "CODE_REVIEW_EXECUTION_STATE_INVALID",
            `Code Review Node Attempt ${attempt.attemptId} cannot resume its reconciled provider operation.`,
          );
        }
        appendRuntimeMutation({
          action: "attempt.code-review-reattach",
          entityType: "node-attempt",
          entityId: attempt.attemptId,
          eventType: "attempt.started",
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          before: current,
          after: {
            attemptStatus: "running",
            nodeStatus: "running",
            runStatus: "running",
          },
          createdAt: now,
        });
        const effectIds = (
          database
            .prepare(
              `SELECT id FROM runtime_audit_records
                WHERE command_id = ? ORDER BY created_at, id`,
            )
            .all(commandId) as Array<{ readonly id: string }>
        ).map((entry) => entry.id);
        const receipt = {
          status: "succeeded",
          value: {
            attemptId: attempt.attemptId,
            operationKey: input.operationKey,
          },
          effectIds,
        };
        database
          .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
          .run();
        database
          .prepare(
            `INSERT INTO command_deduplication(
               command_id, actor_type, actor_id, authenticated_by, consumer_id,
               schema_version, request_hash, status, result_json, result_hash,
               effect_ids_json, completed_at
             ) VALUES (?, 'runtime-worker', ?, 'runtime', ?, 1, ?, 'completed',
                       ?, ?, ?, ?)`,
          )
          .run(
            commandId,
            input.workerId,
            input.workerId,
            pipelineHash(request),
            canonicalPipelineJson(receipt),
            pipelineHash(receipt),
            canonicalPipelineJson(effectIds),
            now,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    if (existingTerminal?.kind === "completed") {
      const result = acceptedCompletedResult({
        executionFactId: existingTerminal.id,
      });
      if (result.status === "succeeded" && !input.executionLease) {
        continueAfterTerminalReconciliation({
          terminalExecutionFactId: existingTerminal.id,
        });
      }
      return result;
    }

    if (reconciliation) {
      const reconciliationLease = issueLease("reconciliation");
      if (!reconciliationLease) return busyResult();
      const sink = createExecutionFactSink({
        database,
        lease: reconciliationLease,
        target: reconciliationLease.target,
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        attemptId: attempt.attemptId,
        now: clock,
        appendEvent: (event) =>
          appendExecutionEvent({
            ...event,
            runId: input.runId,
            nodeRunId: input.nodeRunId,
            attemptId: attempt.attemptId,
            payload: event.payload,
            createdAt: event.timestamp,
          }),
      });
      let result: ReviewerExecutionResult;
      try {
        result = input.adapter.reconcile
          ? await input.adapter.reconcile(
              input.operationKey,
              sink,
              providerExecutionRef,
            )
          : {
              status: "unknown",
              code: "RECONCILE_UNKNOWN",
              message:
                "The Reviewer provider cannot safely reconcile a running operation.",
              evidence: [],
            };
      } finally {
        database
          .prepare(
            `UPDATE execution_leases SET released_at = COALESCE(released_at, ?)
              WHERE id = ?`,
          )
          .run(clock().toISOString(), reconciliationLease.leaseId);
      }
      if (result.status !== "running") {
        if (result.status === "unknown") return result;
        if (!result.terminalExecutionFactId) {
          throw runtimeError(
            "EXECUTION_ADAPTER_PROTOCOL",
            "Reviewer terminal reconciliation must reference its accepted completed Fact.",
          );
        }
        const acceptedResult = acceptedCompletedResult({
          executionFactId: result.terminalExecutionFactId,
          expectedLease: reconciliationLease,
          reportedResult: result,
        });
        if (acceptedResult.status === "succeeded") {
          continueAfterTerminalReconciliation({
            terminalExecutionFactId: result.terminalExecutionFactId,
          });
        }
        return acceptedResult;
      }
      if (
        input.adapter.capabilities.reattachRunningOperation !== true ||
        !input.adapter.reattach
      ) {
        return {
          status: "unknown",
          code: "RECONCILE_UNKNOWN",
          message:
            "The Reviewer provider reported a running operation but cannot reattach it.",
          evidence: [result.providerExecutionRef],
        };
      }
      resumeReconciledAttempt(reconciliationLease.leaseId);
      const executionLease = issueLease("execution");
      if (!executionLease) return busyResult();
      return runWithLease(executionLease, (sink, signal) =>
        input.adapter.reattach!(
          input.request,
          result.providerExecutionRef,
          sink,
          signal,
        ),
      );
    }
    const executionLease = input.executionLease ?? issueLease("execution");
    if (!executionLease) return busyResult();
    return runWithLease(
      executionLease,
      (sink, signal) => input.adapter.execute(input.request, sink, signal),
      input.executionLease === undefined,
    );
  };
};
