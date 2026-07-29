import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type {
  TestExecutionAdapter,
  TestRunView,
  TestRuntime,
} from "./testRuntime.js";
import { TestRuntimeError } from "./testRuntime.js";

export interface TestNodeHandler {
  readonly executeReady: (input: {
    readonly runId: string;
    readonly nodeRunId: string;
  }) => Promise<void>;
  readonly reconcilePending: () => Promise<number>;
  readonly cancelPending: (
    testRunId: string,
    kind?: "pause" | "cancel",
  ) => Promise<void>;
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
  readonly tests: Pick<
    TestRuntime,
    "inspect" | "execute" | "reconcile" | "cancel" | "complete"
  >;
  readonly executionAdapters?: readonly TestExecutionAdapter[];
  readonly transitionFailureInjection?: (
    point: "after-transition" | "after-effects",
  ) => void;
}): TestNodeHandler => {
  const adapters = new Map(
    (options.executionAdapters ?? []).map((adapter) => [adapter.id, adapter]),
  );
  const nodeState = (nodeRunId: string): string | null => {
    const row = options.database
      .prepare("SELECT status FROM node_runs WHERE id = ?")
      .get(nodeRunId) as { readonly status: string } | undefined;
    return row?.status ?? null;
  };

  const canonicalJson = (value: unknown): string =>
    JSON.stringify(value, Object.keys(value as object).sort());
  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");
  const transition = (input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly testRun: TestRunView;
  }): void => {
    const transitionHash = sha256(
      JSON.stringify({
        viewHash: input.testRun.viewHash,
        state: input.testRun.state,
        passAuthorityHash: input.testRun.passAuthorityHash,
        executions: input.testRun.executions.map((entry) => ({
          id: entry.id,
          state: entry.state,
          receiptHash: entry.receiptHash,
        })),
      }),
    );
    const commandId = `test-node-handler:${input.nodeRunId}:${transitionHash}`;
    if (
      options.database
        .prepare("SELECT 1 FROM command_deduplication WHERE command_id = ?")
        .get(commandId)
    )
      return;
    const requestJson = JSON.stringify({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      testRunId: input.testRun.id,
      testRunViewHash: input.testRun.viewHash,
      state: input.testRun.state,
    });
    options.database.exec("BEGIN IMMEDIATE");
    try {
      options.database
        .prepare(
          `INSERT INTO runtime_unit_of_work_context(
             slot, command_id, actor_type, actor_id, authenticated_by,
             consumer_id, schema_version
           ) VALUES (1, ?, 'runtime-worker', 'test-node-handler',
                     'company-runtime', 'test-node-handler', 1)`,
        )
        .run(commandId);
      applyTransition(input);
      options.transitionFailureInjection?.("after-transition");
      const effectIds = (
        options.database
          .prepare(
            "SELECT id FROM runtime_audit_records WHERE command_id = ? ORDER BY created_at, id",
          )
          .all(commandId) as Array<{ readonly id: string }>
      ).map((entry) => entry.id);
      options.transitionFailureInjection?.("after-effects");
      const resultJson = JSON.stringify({
        status: "succeeded",
        value: { testRunId: input.testRun.id, state: input.testRun.state },
        effectIds,
      });
      options.database
        .prepare("DELETE FROM runtime_unit_of_work_context WHERE slot = 1")
        .run();
      options.database
        .prepare(
          `INSERT INTO command_deduplication(
             command_id, actor_type, actor_id, authenticated_by, consumer_id,
             schema_version, request_hash, status, result_json, result_hash,
             effect_ids_json, completed_at
           ) VALUES (?, 'runtime-worker', 'test-node-handler', 'company-runtime',
                     'test-node-handler', 1, ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          commandId,
          sha256(requestJson),
          resultJson,
          sha256(resultJson),
          canonicalJson(effectIds),
          new Date().toISOString(),
        );
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  };

  const applyTransition = (input: {
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
    if (["passed", "failed", "cancelled", "blocked"].includes(testRun.state))
      return;
    for (const operation of testRun.manifest.executionOperations) {
      const execution = testRun.executions.find(
        (entry) => entry.id === operation.id,
      );
      if (execution?.state === "succeeded") continue;
      const adapter = adapters.get(operation.adapterId);
      if (!adapter) {
        options.pipelineRuntime.blockTestInTransaction({
          ...input,
          testRunId: testRun.id,
          failure: {
            code: "TEST_EXECUTION_ADAPTER_UNAVAILABLE",
            message: `Frozen Test adapter ${operation.adapterId} is unavailable.`,
          },
        });
        return;
      }
      try {
        if (execution) {
          testRun =
            execution.state === "not-started"
              ? await options.tests.execute({
                  testRunId: testRun.id,
                  operationId: operation.id,
                  input: operation.input,
                  adapter,
                })
              : await options.tests.reconcile({
                  testRunId: testRun.id,
                  operationId: operation.id,
                  adapter,
                });
          const reconciledExecution = testRun.executions.find(
            (entry) => entry.id === operation.id,
          );
          if (reconciledExecution?.state === "not-started") {
            testRun = await options.tests.execute({
              testRunId: testRun.id,
              operationId: operation.id,
              input: operation.input,
              adapter,
            });
          }
        } else {
          testRun = await options.tests.execute({
            testRunId: testRun.id,
            operationId: operation.id,
            input: operation.input,
            adapter,
          });
        }
      } catch (error) {
        const uncertain = options.tests.inspect(testRun.id);
        const uncertainExecution = uncertain.executions.find(
          (entry) => entry.id === operation.id,
        );
        if (
          uncertainExecution &&
          ["intent", "running", "reconciling", "unknown"].includes(
            uncertainExecution.state,
          )
        ) {
          options.pipelineRuntime.blockTestInTransaction({
            ...input,
            testRunId: uncertain.id,
            failure: {
              code: "TEST_EXECUTION_RECONCILIATION_REQUIRED",
              message:
                "The Test adapter failed after dispatch; Runtime must reconcile the frozen operation before any resend.",
            },
          });
          return;
        }
        throw error;
      }
      transition({ ...input, testRun });
      if (testRun.state !== "running") return;
    }
    if (
      testRun.manifest.executionOperations.length > 0 &&
      testRun.manifest.executionOperations.every((operation) =>
        testRun.executions.some(
          (execution) =>
            execution.id === operation.id && execution.state === "succeeded",
        ),
      )
    ) {
      try {
        testRun = options.tests.complete(testRun.id);
      } catch (error) {
        if (
          error instanceof TestRuntimeError &&
          error.code === "TEST_RUN_PASS_INCOMPLETE"
        )
          return;
        throw error;
      }
      transition({ ...input, testRun });
    }
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
      await executeReady({ runId: row.runId, nodeRunId: row.nodeRunId });
    }
    return rows.length;
  };

  const cancelPending: TestNodeHandler["cancelPending"] = async (
    testRunId,
    kind = "cancel",
  ) => {
    let run: TestRunView;
    try {
      run = options.tests.inspect(testRunId);
    } catch (error) {
      if (
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_NOT_FOUND"
      )
        return;
      throw error;
    }
    if (["passed", "failed", "cancelled"].includes(run.state)) return;
    for (const operation of run.manifest.executionOperations) {
      const execution = run.executions.find(
        (entry) => entry.id === operation.id,
      );
      if (
        !execution ||
        ["succeeded", "failed", "cancelled"].includes(execution.state)
      )
        continue;
      const adapter = adapters.get(operation.adapterId);
      if (!adapter) {
        throw new TestRuntimeError(
          "TEST_EXECUTION_ADAPTER_UNAVAILABLE",
          `Frozen Test adapter ${operation.adapterId} is unavailable for cancellation.`,
        );
      }
      run = await options.tests.cancel({
        cancelOperationId: `test-${kind}:${operation.id}`,
        kind,
        testRunId,
        operationId: operation.id,
        adapter,
      });
    }
    transition({
      runId: run.manifest.runId,
      nodeRunId: run.manifest.nodeRunId,
      testRun: run,
    });
  };

  return { executeReady, reconcilePending, cancelPending };
};
