import type { DatabaseSync } from "node:sqlite";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { TestRunView, TestRuntime } from "./testRuntime.js";
import { TestRuntimeError } from "./testRuntime.js";

export interface TestNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly reconcilePending: () => Promise<number>;
}

const deterministicTestRunId = (runId: string, nodeRunId: string): string =>
  `test:${runId}:${nodeRunId}`;

export const openTestNodeHandler = (options: {
  readonly database: DatabaseSync;
  readonly pipelineRuntime: Pick<
    PipelineRuntime,
    | "startTestInTransaction"
    | "blockTestInTransaction"
    | "resumeTestInTransaction"
    | "failTestInTransaction"
    | "completeTestInTransaction"
  >;
  readonly tests: Pick<TestRuntime, "inspect">;
}): TestNodeHandler => {
  const nodeState = (nodeRunId: string): string | null => {
    const row = options.database
      .prepare("SELECT status FROM node_runs WHERE id = ?")
      .get(nodeRunId) as { readonly status: string } | undefined;
    return row?.status ?? null;
  };

  const transition = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly testRun: TestRunView;
  }): void => {
    const state = nodeState(input.nodeRunId);
    if (input.testRun.state === "scheduled") {
      if (state === null || ["ready", "blocked"].includes(state)) {
        options.pipelineRuntime.startTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
        });
      }
      return;
    }
    if (["unknown", "reconciling", "blocked"].includes(input.testRun.state)) {
      if (state === null || state === "running") {
        options.pipelineRuntime.blockTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
          failure: {
            code: "TEST_EXECUTION_RECONCILIATION_REQUIRED",
            message:
              "The Test effect is not yet proven terminal and must be reconciled without resend.",
          },
        });
      }
      return;
    }
    if (input.testRun.state === "running") {
      if (state === null || state === "blocked") {
        options.pipelineRuntime.resumeTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
        });
      }
      return;
    }
    if (input.testRun.state === "passed") {
      if (!input.testRun.passAuthorityHash) {
        throw new TestRuntimeError(
          "TEST_PASS_AUTHORITY_MISSING",
          `Passed Test Run ${input.testRun.id} has no pass authority hash.`,
        );
      }
      if (state === "blocked") {
        options.pipelineRuntime.resumeTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
        });
      }
      if (state === null || state === "running" || state === "blocked") {
        options.pipelineRuntime.completeTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
          passAuthorityHash: input.testRun.passAuthorityHash,
        });
      }
      return;
    }
    if (["failed", "cancelled"].includes(input.testRun.state)) {
      if (state === null || ["ready", "running", "blocked"].includes(state)) {
        options.pipelineRuntime.failTestInTransaction({
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          testRunId: input.testRun.id,
          failure: {
            code:
              input.testRun.state === "cancelled"
                ? "TEST_RUN_CANCELLED"
                : "TEST_RUN_FAILED",
            message: `Test Run ${input.testRun.id} ended in ${input.testRun.state}.`,
          },
        });
      }
    }
  };

  const executeReady: TestNodeHandler["executeReady"] = async (input) => {
    const testRunId = deterministicTestRunId(input.runId, input.nodeRunId);
    let testRun: TestRunView;
    try {
      testRun = options.tests.inspect(testRunId);
    } catch (error) {
      if (
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_NOT_FOUND"
      ) {
        options.pipelineRuntime.startTestInTransaction({
          ...input,
          testRunId,
        });
        return;
      }
      throw error;
    }
    transition({ ...input, testRun });
  };

  const reconcilePending = async (): Promise<number> => {
    const rows = options.database
      .prepare(
        `SELECT test_runs.id AS testRunId, test_runs.run_id AS runId,
                test_runs.node_run_id AS nodeRunId
           FROM test_runs
           JOIN node_runs ON node_runs.id = test_runs.node_run_id
          WHERE node_runs.handler_kind_id = 'test@1'
            AND node_runs.status IN ('ready', 'running', 'blocked')
          ORDER BY test_runs.created_at, test_runs.id`,
      )
      .all() as Array<{
      readonly testRunId: string;
      readonly runId: string;
      readonly nodeRunId: string;
    }>;
    for (const row of rows) {
      transition({
        runId: row.runId,
        nodeRunId: row.nodeRunId,
        testRun: options.tests.inspect(row.testRunId),
      });
    }
    return rows.length;
  };

  return { executeReady, reconcilePending };
};
