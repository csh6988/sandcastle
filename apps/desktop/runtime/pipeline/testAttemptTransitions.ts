import type { DatabaseSync } from "node:sqlite";

type TestTransitionInput = {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly testRunId: string;
};

type TestFailureInput = TestTransitionInput & {
  readonly failure: {
    readonly code: string;
    readonly message: string;
  };
};

type RuntimeMutation = {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly eventType: string;
  readonly additionalEventType?: string;
  readonly runId?: string;
  readonly nodeRunId?: string;
  readonly nodeAttemptId?: string;
  readonly before?: unknown;
  readonly after: unknown;
  readonly createdAt: string;
};

export interface TestAttemptTransitions {
  readonly start: (input: TestTransitionInput) => {
    readonly nodeAttemptId: string;
  };
  readonly block: (input: TestFailureInput) => void;
  readonly resume: (input: TestTransitionInput) => void;
  readonly fail: (input: TestFailureInput) => void;
  readonly complete: (
    input: TestTransitionInput & { readonly passAuthorityHash: string },
  ) => void;
}

export const openTestAttemptTransitions = (input: {
  readonly database: DatabaseSync;
  readonly clock: () => Date;
  readonly canonicalJson: (value: unknown) => string;
  readonly appendRuntimeMutation: (mutation: RuntimeMutation) => void;
  readonly refreshQueuedNodes: (runId: string, now: string) => void;
  readonly createAttemptId: () => string;
  readonly invalid: (code: string, message: string) => never;
}): TestAttemptTransitions => {
  const start: TestAttemptTransitions["start"] = (transition) => {
    const current = input.database
      .prepare(
        `SELECT node_runs.status AS nodeStatus,
                node_runs.attempt_count AS attemptCount,
                node_runs.handler_kind_id AS handlerKindId,
                department_runs.status AS runStatus,
                department_runs.snapshot_revision_id AS snapshotRevisionId
           FROM node_runs
           JOIN department_runs ON department_runs.id = node_runs.run_id
          WHERE node_runs.id = ? AND node_runs.run_id = ?`,
      )
      .get(transition.nodeRunId, transition.runId) as
      | {
          readonly nodeStatus: string;
          readonly attemptCount: number;
          readonly handlerKindId: string;
          readonly runStatus: string;
          readonly snapshotRevisionId: string;
        }
      | undefined;
    if (
      !current ||
      current.handlerKindId !== "test@1" ||
      !["ready", "blocked"].includes(current.nodeStatus) ||
      !["ready", "running", "blocked"].includes(current.runStatus)
    ) {
      input.invalid(
        "TEST_START_STATE_INVALID",
        `Test Node Run ${transition.nodeRunId} cannot start from its current Pipeline state.`,
      );
    }
    const now = input.clock().toISOString();
    const nodeAttemptId = input.createAttemptId();
    const result = input.canonicalJson({ testRunId: transition.testRunId });
    input.database
      .prepare(
        `UPDATE node_runs
            SET status = 'running', attempt_count = attempt_count + 1,
                result_json = ?, failure_code = NULL, failure_message = NULL,
                updated_at = ?
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'test@1'
            AND status IN ('ready', 'blocked')`,
      )
      .run(result, now, transition.nodeRunId, transition.runId);
    input.database
      .prepare(
        `UPDATE department_runs
            SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'blocked')`,
      )
      .run(now, transition.runId);
    input.database
      .prepare(
        `INSERT INTO node_attempts(
           id, node_run_id, attempt_number, snapshot_revision_id, reason,
           status, structured_result_json, failure_code, failure_message,
           created_at, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        nodeAttemptId,
        transition.nodeRunId,
        current.attemptCount + 1,
        current.snapshotRevisionId,
        current.attemptCount === 0 ? "initial" : "recovery",
        result,
        now,
        now,
      );
    input.appendRuntimeMutation({
      action: "node.test-start",
      entityType: "node-run",
      entityId: transition.nodeRunId,
      eventType: "node.status.changed",
      additionalEventType: "node.started",
      runId: transition.runId,
      nodeRunId: transition.nodeRunId,
      nodeAttemptId,
      before: { status: current.nodeStatus },
      after: {
        status: "running",
        runStatus: "running",
        testRunId: transition.testRunId,
      },
      createdAt: now,
    });
    return { nodeAttemptId };
  };

  const block: TestAttemptTransitions["block"] = (transition) => {
    const now = input.clock().toISOString();
    const node = input.database
      .prepare(
        `UPDATE node_runs
            SET status = 'blocked', failure_code = ?, failure_message = ?,
                updated_at = ?
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'test@1'
            AND status IN ('ready', 'running', 'blocked')`,
      )
      .run(
        transition.failure.code,
        transition.failure.message,
        now,
        transition.nodeRunId,
        transition.runId,
      );
    if (node.changes !== 1) {
      input.invalid(
        "TEST_BLOCK_STATE_INVALID",
        `Test Node Run ${transition.nodeRunId} is not blockable.`,
      );
    }
    input.database
      .prepare(
        `UPDATE node_attempts
            SET status = 'reconciling', recoverable = 1, failure_code = ?,
                failure_message = ?, completed_at = NULL
          WHERE id = (
            SELECT id FROM node_attempts WHERE node_run_id = ?
              AND status IN ('running', 'reconciling')
            ORDER BY attempt_number DESC LIMIT 1
          )`,
      )
      .run(
        transition.failure.code,
        transition.failure.message,
        transition.nodeRunId,
      );
    const run = input.database
      .prepare(
        `UPDATE department_runs
            SET status = CASE WHEN status = 'paused' THEN status ELSE 'blocked' END,
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'blocked', 'paused')`,
      )
      .run(now, transition.runId);
    if (run.changes !== 1) {
      input.invalid(
        "TEST_BLOCK_STATE_INVALID",
        `Department Run ${transition.runId} is not blockable.`,
      );
    }
    input.appendRuntimeMutation({
      action: "run.test-blocked",
      entityType: "department-run",
      entityId: transition.runId,
      eventType: "run.blocked",
      runId: transition.runId,
      nodeRunId: transition.nodeRunId,
      before: { status: "running" },
      after: {
        status: "blocked",
        testRunId: transition.testRunId,
        failure: transition.failure,
      },
      createdAt: now,
    });
  };

  const resume: TestAttemptTransitions["resume"] = (transition) => {
    const now = input.clock().toISOString();
    const runStatus = input.database
      .prepare("SELECT status FROM department_runs WHERE id = ?")
      .get(transition.runId) as { readonly status: string } | undefined;
    if (runStatus?.status === "paused") return;
    const node = input.database
      .prepare(
        `UPDATE node_runs
            SET status = 'running', failure_code = NULL,
                failure_message = NULL, updated_at = ?
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'test@1'
            AND status = 'blocked'`,
      )
      .run(now, transition.nodeRunId, transition.runId);
    const attempt = input.database
      .prepare(
        `UPDATE node_attempts
            SET status = 'running', recoverable = 0, failure_code = NULL,
                failure_message = NULL, completed_at = NULL
          WHERE id = (
            SELECT id FROM node_attempts WHERE node_run_id = ?
              AND status = 'reconciling'
            ORDER BY attempt_number DESC LIMIT 1
          )`,
      )
      .run(transition.nodeRunId);
    const run = input.database
      .prepare(
        `UPDATE department_runs
            SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'blocked'`,
      )
      .run(now, transition.runId);
    if (node.changes !== 1 || attempt.changes !== 1 || run.changes !== 1) {
      input.invalid(
        "TEST_RESUME_STATE_INVALID",
        `Test Node Run ${transition.nodeRunId} has no reconciling Attempt to resume.`,
      );
    }
    input.appendRuntimeMutation({
      action: "node.test-reconciled",
      entityType: "node-run",
      entityId: transition.nodeRunId,
      eventType: "node.status.changed",
      additionalEventType: "node.started",
      runId: transition.runId,
      nodeRunId: transition.nodeRunId,
      before: { status: "blocked" },
      after: {
        status: "running",
        runStatus: "running",
        testRunId: transition.testRunId,
      },
      createdAt: now,
    });
  };

  const fail: TestAttemptTransitions["fail"] = (transition) => {
    const now = input.clock().toISOString();
    const node = input.database
      .prepare(
        `UPDATE node_runs
            SET status = 'failed', failure_code = ?, failure_message = ?,
                updated_at = ?
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'test@1'
            AND status IN ('ready', 'running', 'blocked')`,
      )
      .run(
        transition.failure.code,
        transition.failure.message,
        now,
        transition.nodeRunId,
        transition.runId,
      );
    input.database
      .prepare(
        `UPDATE node_attempts
            SET status = 'failed', recoverable = 0, failure_code = ?,
                failure_message = ?, completed_at = ?
          WHERE id = (
            SELECT id FROM node_attempts WHERE node_run_id = ?
              AND status IN ('running', 'reconciling')
            ORDER BY attempt_number DESC LIMIT 1
          )`,
      )
      .run(
        transition.failure.code,
        transition.failure.message,
        now,
        transition.nodeRunId,
      );
    input.database
      .prepare(
        `UPDATE department_runs
            SET status = 'failed', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'blocked')`,
      )
      .run(now, transition.runId);
    if (node.changes !== 1) {
      input.invalid(
        "TEST_FAIL_STATE_INVALID",
        `Test Node Run ${transition.nodeRunId} cannot fail from its current state.`,
      );
    }
    input.appendRuntimeMutation({
      action: "node.test-failed",
      entityType: "node-run",
      entityId: transition.nodeRunId,
      eventType: "node.status.changed",
      additionalEventType: "node.failed",
      runId: transition.runId,
      nodeRunId: transition.nodeRunId,
      before: { status: "running" },
      after: {
        status: "failed",
        runStatus: "failed",
        testRunId: transition.testRunId,
        failure: transition.failure,
      },
      createdAt: now,
    });
  };

  const complete: TestAttemptTransitions["complete"] = (transition) => {
    const now = input.clock().toISOString();
    const result = {
      testRunId: transition.testRunId,
      passAuthorityHash: transition.passAuthorityHash,
    };
    const node = input.database
      .prepare(
        `UPDATE node_runs
            SET status = 'succeeded', result_json = ?, failure_code = NULL,
                failure_message = NULL, updated_at = ?
          WHERE id = ? AND run_id = ? AND handler_kind_id = 'test@1'
            AND status = 'running'`,
      )
      .run(
        input.canonicalJson(result),
        now,
        transition.nodeRunId,
        transition.runId,
      );
    const attempt = input.database
      .prepare(
        `UPDATE node_attempts
            SET status = 'succeeded', structured_result_json = ?,
                failure_code = NULL, failure_message = NULL, completed_at = ?
          WHERE id = (
            SELECT id FROM node_attempts WHERE node_run_id = ?
              AND status = 'running'
            ORDER BY attempt_number DESC LIMIT 1
          )`,
      )
      .run(input.canonicalJson(result), now, transition.nodeRunId);
    if (node.changes !== 1 || attempt.changes !== 1) {
      input.invalid(
        "TEST_COMPLETE_STATE_INVALID",
        `Test Node Run ${transition.nodeRunId} has no running Attempt to complete.`,
      );
    }
    input.refreshQueuedNodes(transition.runId, now);
    input.database
      .prepare(
        `UPDATE department_runs
            SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(now, transition.runId);
    input.appendRuntimeMutation({
      action: "node.test-complete",
      entityType: "node-run",
      entityId: transition.nodeRunId,
      eventType: "node.status.changed",
      additionalEventType: "node.succeeded",
      runId: transition.runId,
      nodeRunId: transition.nodeRunId,
      before: { status: "running" },
      after: { status: "succeeded", ...result },
      createdAt: now,
    });
  };

  return { start, block, resume, fail, complete };
};
