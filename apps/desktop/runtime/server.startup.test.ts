import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompanyDatabase } from "./storage/sqlite.js";
import { reconcileCompanyRuntimeStartup } from "./server.js";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("Company Runtime startup reconciliation", () => {
  it("awaits Integration reconciliation after Code Review before startup can continue", async () => {
    const integration = deferred();
    const order: string[] = [];
    const database = {
      pipelineRuntime: {
        reconcilePendingExecutions: async () => order.push("pipeline"),
      },
      interaction: {
        reconcilePendingTurns: async () => order.push("interaction"),
      },
      codeReviewNodeHandler: {
        reconcilePending: async () => order.push("code-review"),
      },
      integrationNodeHandler: {
        reconcilePending: async () => {
          order.push("integration-start");
          await integration.promise;
          order.push("integration-complete");
          return 1;
        },
      },
      testNodeHandler: {
        reconcilePending: async () => {
          order.push("test");
          return 1;
        },
      },
      releaseOperations: {
        reconcilePending: async () => {
          order.push("release");
          return 1;
        },
      },
      improvementApplications: {
        reconcilePending: async () => {
          order.push("improvement-application");
          return 1;
        },
      },
    } as unknown as CompanyDatabase;
    let settled = false;
    const startup = reconcileCompanyRuntimeStartup(database).then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(order, [
      "pipeline",
      "interaction",
      "code-review",
      "integration-start",
    ]);
    integration.resolve();
    await startup;
    assert.equal(settled, true);
    assert.deepEqual(order.slice(-4), [
      "integration-complete",
      "test",
      "release",
      "improvement-application",
    ]);
  });

  it("propagates Integration reconciliation rejection instead of racing database close", async () => {
    const failure = new Error("integration reconcile failed");
    const database = {
      pipelineRuntime: { reconcilePendingExecutions: async () => undefined },
      interaction: { reconcilePendingTurns: async () => undefined },
      codeReviewNodeHandler: { reconcilePending: async () => 0 },
      integrationNodeHandler: {
        reconcilePending: async () => {
          throw failure;
        },
      },
    } as unknown as CompanyDatabase;
    await assert.rejects(
      reconcileCompanyRuntimeStartup(database),
      (error: unknown) => error === failure,
    );
  });
});
