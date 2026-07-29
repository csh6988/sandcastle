import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type { TestRunView, TestRuntime } from "./testRuntime.js";
import { TestRuntimeError } from "./testRuntime.js";
import { openTestNodeHandler } from "./testNodeHandler.js";

const runView = (state: TestRunView["state"]): TestRunView =>
  ({
    id: "test:run-1:node-1",
    state,
    passAuthorityHash: state === "passed" ? "a".repeat(64) : null,
    manifest: {
      runId: "run-1",
      nodeRunId: "node-1",
      executionOperations: [],
    },
    executions: [],
  }) as unknown as TestRunView;

describe("Test Node Handler", () => {
  it("requests only Pipeline-owned start, reconcile, and completion transitions", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    const transitions: string[] = [];
    let state: TestRunView["state"] | null = null;
    const pipelineRuntime = {
      startTestInTransaction: () => {
        transitions.push("start");
        return { nodeAttemptId: "attempt-1" };
      },
      blockTestInTransaction: () => transitions.push("block"),
      resumeTestInTransaction: () => transitions.push("resume"),
      failTestInTransaction: () => transitions.push("fail"),
      completeTestInTransaction: () => transitions.push("complete"),
    } as Pick<
      PipelineRuntime,
      | "startTestInTransaction"
      | "blockTestInTransaction"
      | "resumeTestInTransaction"
      | "failTestInTransaction"
      | "completeTestInTransaction"
    >;
    const tests = {
      inspect: () => runView(state ?? "scheduled"),
    } as unknown as Pick<
      TestRuntime,
      "inspect" | "execute" | "reconcile" | "cancel" | "complete"
    >;
    const handler = openTestNodeHandler({ database, pipelineRuntime, tests });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "unknown";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "running";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    state = "passed";
    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(transitions, ["start", "block", "resume", "complete"]);
    database.close();
  });

  it("executes and reconciles only the adapter identity frozen by the Test Run", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    const calls: string[] = [];
    let view: TestRunView = {
      ...runView("scheduled"),
      manifest: {
        ...runView("scheduled").manifest,
        executionOperations: [
          {
            id: "operation-1",
            kind: "electron" as const,
            adapterId: "scripted-test",
            input: { fixture: true },
            inputHash: "a".repeat(64),
          },
        ],
      },
    };
    const tests = {
      inspect: () => view,
      execute: async () => {
        calls.push("execute");
        view = {
          ...view,
          state: "running" as const,
          executions: [
            {
              id: "operation-1",
              state: "succeeded" as const,
              requestHash: "b".repeat(64),
              receiptHash: "c".repeat(64),
            },
          ],
        };
        return view;
      },
      reconcile: async () => {
        calls.push("reconcile");
        return view;
      },
      cancel: async () => {
        calls.push("cancel");
        return view;
      },
      complete: () => {
        calls.push("complete-runtime");
        view = {
          ...view,
          state: "passed" as const,
          passAuthorityHash: "d".repeat(64),
        };
        return view;
      },
    } as Pick<
      TestRuntime,
      "inspect" | "execute" | "reconcile" | "cancel" | "complete"
    >;
    const pipelineRuntime = {
      startTestInTransaction: () => calls.push("start-pipeline"),
      blockTestInTransaction: () => calls.push("block-pipeline"),
      resumeTestInTransaction: () => calls.push("resume-pipeline"),
      failTestInTransaction: () => calls.push("fail-pipeline"),
      completeTestInTransaction: () => calls.push("complete-pipeline"),
    } as unknown as Pick<
      PipelineRuntime,
      | "startTestInTransaction"
      | "blockTestInTransaction"
      | "resumeTestInTransaction"
      | "failTestInTransaction"
      | "completeTestInTransaction"
    >;
    const handler = openTestNodeHandler({
      database,
      pipelineRuntime,
      tests,
      executionAdapters: [
        {
          id: "scripted-test",
          execute: () => ({
            state: "succeeded",
            providerReceipt: { id: "receipt-1" },
          }),
          reconcile: () => ({ state: "unknown" }),
          cancel: () => ({ state: "cancelled" }),
        },
      ],
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });
    await handler.cancelPending(view.id);

    assert.deepEqual(calls, [
      "start-pipeline",
      "execute",
      "resume-pipeline",
      "complete-runtime",
      "complete-pipeline",
    ]);
    database.close();
  });

  it("governs an unexpected adapter failure as reconciliation-required", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    let view: TestRunView = {
      ...runView("scheduled"),
      manifest: {
        ...runView("scheduled").manifest,
        executionOperations: [
          {
            id: "operation-1",
            kind: "electron" as const,
            adapterId: "scripted-test",
            input: { fixture: true },
            inputHash: "a".repeat(64),
          },
        ],
      },
    };
    const failures: Array<{ readonly code: string }> = [];
    const handler = openTestNodeHandler({
      database,
      pipelineRuntime: {
        startTestInTransaction: () => ({ nodeAttemptId: "attempt-1" }),
        blockTestInTransaction: (input) => failures.push(input.failure),
        resumeTestInTransaction: () => undefined,
        failTestInTransaction: () => undefined,
        completeTestInTransaction: () => undefined,
      },
      tests: {
        inspect: () => view,
        execute: async () => {
          view = {
            ...view,
            state: "running",
            executions: [
              {
                id: "operation-1",
                state: "running",
                requestHash: "b".repeat(64),
                receiptHash: null,
              },
            ],
          };
          throw new Error("adapter transport crashed");
        },
      } as unknown as Pick<
        TestRuntime,
        "inspect" | "execute" | "reconcile" | "cancel" | "complete"
      >,
      executionAdapters: [
        {
          id: "scripted-test",
          execute: () => ({ state: "unknown" }),
          reconcile: () => ({ state: "unknown" }),
          cancel: () => ({ state: "unknown" }),
        },
      ],
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.deepEqual(
      failures.map((failure) => failure.code),
      ["TEST_EXECUTION_RECONCILIATION_REQUIRED"],
    );
    database.close();
  });

  it("does not claim cancellation when no Test Run owns an external effect", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    const handler = openTestNodeHandler({
      database,
      pipelineRuntime: {
        startTestInTransaction: () => ({ nodeAttemptId: "attempt-1" }),
        blockTestInTransaction: () => undefined,
        resumeTestInTransaction: () => undefined,
        failTestInTransaction: () => undefined,
        completeTestInTransaction: () => undefined,
      },
      tests: {
        inspect: () => {
          throw new TestRuntimeError(
            "TEST_RUN_NOT_FOUND",
            "No Test Run accepted this effect.",
          );
        },
      } as unknown as Pick<
        TestRuntime,
        "inspect" | "execute" | "reconcile" | "cancel" | "complete"
      >,
    });

    await handler.cancelPending("test:run-1:node-1");

    database.close();
  });

  it("rolls back a Pipeline Test transition when its trusted worker receipt cannot commit", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("CREATE TABLE transition_probe(id TEXT PRIMARY KEY) STRICT");
    const handler = openTestNodeHandler({
      database,
      pipelineRuntime: {
        startTestInTransaction: () => {
          database
            .prepare("INSERT INTO transition_probe(id) VALUES ('start')")
            .run();
          return { nodeAttemptId: "attempt-1" };
        },
        blockTestInTransaction: () => undefined,
        resumeTestInTransaction: () => undefined,
        failTestInTransaction: () => undefined,
        completeTestInTransaction: () => undefined,
      },
      tests: {
        inspect: () => runView("scheduled"),
      } as unknown as Pick<
        TestRuntime,
        "inspect" | "execute" | "reconcile" | "cancel" | "complete"
      >,
      transitionFailureInjection: (point) => {
        if (point === "after-transition") throw new Error("receipt-crash");
      },
    });

    await assert.rejects(
      handler.executeReady({ runId: "run-1", nodeRunId: "node-1" }),
      /receipt-crash/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM transition_probe").get()
        ?.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM command_deduplication WHERE consumer_id = 'test-node-handler'",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      database.prepare("SELECT 1 FROM runtime_unit_of_work_context").get(),
      undefined,
    );
    database.close();
  });

  it("executes exactly once after reconciliation proves an operation was not started", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    let view: TestRunView = {
      ...runView("reconciling"),
      manifest: {
        ...runView("reconciling").manifest,
        executionOperations: [
          {
            id: "operation-1",
            kind: "electron" as const,
            adapterId: "scripted-test",
            input: { fixture: true },
            inputHash: "a".repeat(64),
          },
        ],
      },
      executions: [
        {
          id: "operation-1",
          state: "reconciling" as const,
          requestHash: "b".repeat(64),
          receiptHash: null,
        },
      ],
    };
    let executions = 0;
    let reconciliations = 0;
    const handler = openTestNodeHandler({
      database,
      pipelineRuntime: {
        startTestInTransaction: () => ({ nodeAttemptId: "attempt-1" }),
        blockTestInTransaction: () => undefined,
        resumeTestInTransaction: () => undefined,
        failTestInTransaction: () => undefined,
        completeTestInTransaction: () => undefined,
      },
      tests: {
        inspect: () => view,
        reconcile: async () => {
          reconciliations += 1;
          view = {
            ...view,
            executions: [{ ...view.executions[0]!, state: "not-started" }],
          };
          return view;
        },
        execute: async () => {
          executions += 1;
          view = {
            ...view,
            state: "running" as const,
            executions: [
              {
                ...view.executions[0]!,
                state: "succeeded" as const,
                receiptHash: "c".repeat(64),
              },
            ],
          };
          return view;
        },
        complete: () => view,
      } as unknown as Pick<
        TestRuntime,
        "inspect" | "execute" | "reconcile" | "cancel" | "complete"
      >,
      executionAdapters: [
        {
          id: "scripted-test",
          execute: () => ({ state: "unknown" }),
          reconcile: () => ({ state: "unknown" }),
        },
      ],
    });

    await handler.executeReady({ runId: "run-1", nodeRunId: "node-1" });

    assert.equal(reconciliations, 1);
    assert.equal(executions, 1);
    database.close();
  });
});
