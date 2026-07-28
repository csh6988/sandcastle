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
            AND node_runs.handler_kind_id = 'code-review@1'
            AND node_attempts.status IN ('running', 'reconciling')
          ORDER BY node_attempts.attempt_number DESC LIMIT 1`,
      )
      .get(input.nodeRunId, input.runId) as
      | { readonly attemptId: string }
      | undefined;
    if (!attempt) {
      throw runtimeError(
        "CODE_REVIEW_EXECUTION_STATE_INVALID",
        `Code Review Node ${input.nodeRunId} has no active aggregate Attempt for Reviewer execution.`,
      );
    }

    const existing = inspectExecution(database, {
      operationKey: input.operationKey,
    });
    const existingTerminal = existing.facts.find(
      (fact) =>
        fact.status === "accepted" &&
        ["completed", "failed", "cancelled"].includes(fact.kind),
    );
    if (existingTerminal?.kind === "completed") {
      const payload =
        typeof existingTerminal.payload === "object" &&
        existingTerminal.payload !== null
          ? (existingTerminal.payload as Record<string, unknown>)
          : {};
      return payload.structuredResult as ReviewerExecutionResult;
    }
    if (existingTerminal) {
      return {
        status: "unknown",
        code: "RECONCILE_UNKNOWN",
        message: `Reviewer execution ${input.operationKey} has terminal ${existingTerminal.kind} evidence and cannot be replayed.`,
        evidence: existingTerminal.evidenceRefs,
      };
    }

    const reconciliation =
      input.reconcileExisting || existing.leases.length > 0;
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

    const issueLease = (
      leaseKind: "execution" | "reconciliation",
    ): ExecutionLeaseContext & {
      readonly target: { readonly kind: "node-attempt"; readonly id: string };
    } => {
      const issuedAt = clock();
      const issuedAtIso = issuedAt.toISOString();
      const executionEpoch =
        Math.max(0, ...existing.leases.map((lease) => lease.executionEpoch)) +
        (leaseKind === "execution" && reconciliation ? 2 : 1);
      const leaseId = randomUUID();
      const target = { kind: "node-attempt" as const, id: attempt.attemptId };
      const lease = {
        leaseId,
        leaseKind,
        operationKey: input.operationKey,
        target,
        executionEpoch,
        fenceToken: `code-review-fence:${randomUUID()}`,
      };
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `UPDATE execution_leases SET released_at = ?
              WHERE operation_key = ? AND released_at IS NULL`,
          )
          .run(issuedAtIso, input.operationKey);
        database
          .prepare(
            `INSERT INTO execution_leases(
               id, target_kind, target_id, lease_kind, operation_key,
               execution_epoch, fence_token, worker_id, issued_at,
               expires_at, renewed_at, released_at, cancel_requested
             ) VALUES (?, 'node-attempt', ?, ?, ?, ?, ?,
                       'code-review-node-handler', ?, ?, NULL, NULL, 0)`,
          )
          .run(
            leaseId,
            attempt.attemptId,
            leaseKind,
            input.operationKey,
            executionEpoch,
            lease.fenceToken,
            issuedAtIso,
            new Date(
              issuedAt.getTime() + input.timeoutSeconds * 1_000,
            ).toISOString(),
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return lease;
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
        return result;
      } finally {
        if (timeout) clearTimeout(timeout);
        clearInterval(renewal);
        database
          .prepare(
            `UPDATE execution_leases SET released_at = COALESCE(released_at, ?)
              WHERE id = ?`,
          )
          .run(clock().toISOString(), lease.leaseId);
        if (
          activeExecutions.get(attempt.attemptId)?.operationKey ===
          input.operationKey
        ) {
          activeExecutions.delete(attempt.attemptId);
        }
        resolveDone();
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
      const commandId = `code-review:execution-reattach:${reconciliationLeaseId}`;
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
             ) VALUES (1, ?, 'runtime-worker', 'code-review-node-handler',
                       'runtime', 'code-review-node-handler', 1)`,
          )
          .run(commandId);
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
             ) VALUES (?, 'runtime-worker', 'code-review-node-handler',
                       'runtime', 'code-review-node-handler', 1, ?, 'completed',
                       ?, ?, ?, ?)`,
          )
          .run(
            commandId,
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

    if (reconciliation) {
      const reconciliationLease = issueLease("reconciliation");
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
        resumeReconciledAttempt(reconciliationLease.leaseId);
        return runWithLease(issueLease("execution"), async () => result);
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
      return runWithLease(issueLease("execution"), (sink, signal) =>
        input.adapter.reattach!(
          input.request,
          result.providerExecutionRef,
          sink,
          signal,
        ),
      );
    }
    return runWithLease(issueLease("execution"), (sink, signal) =>
      input.adapter.execute(input.request, sink, signal),
    );
  };
};
