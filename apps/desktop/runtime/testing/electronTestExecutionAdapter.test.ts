import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { runtimeQueryViewHash } from "../events/cursor.js";
import {
  createElectronTestExecutionAdapter,
  readAcknowledgedElectronTestView,
} from "./electronTestExecutionAdapter.js";
import type { TestRunView } from "./testRuntime.js";

describe("Electron Test execution adapter", () => {
  it("accepts once and returns the exact terminal result only during reconcile", async () => {
    const terminalResult = {
      schemaVersion: 1 as const,
      assertions: [],
      evidence: [],
    };
    const adapter = createElectronTestExecutionAdapter({
      fixtureId: "fixture-v1",
      terminalResult: () => terminalResult,
    });
    const request = {
      operationId: "electron-operation",
      operationKey: "test:test-run:electron-operation:request-hash",
      testRunId: "test-run",
      requestHash: "a".repeat(64),
      input: { schemaVersion: 1, fixtureId: "fixture-v1" },
    };

    assert.deepEqual(await adapter.execute(request), {
      state: "accepted",
      providerReceipt: {
        schemaVersion: 1,
        fixtureId: "fixture-v1",
        operationKey: request.operationKey,
        status: "accepted",
      },
    });
    assert.deepEqual(await adapter.reconcile(request), {
      state: "succeeded",
      providerReceipt: {
        schemaVersion: 1,
        fixtureId: "fixture-v1",
        operationKey: request.operationKey,
        status: "succeeded",
      },
      result: terminalResult,
    });
  });

  it("returns a Runtime-owned cleanup receipt from the terminal callback", async () => {
    const cleanupReceipt = {
      schemaVersion: 1 as const,
      kind: "cleanup" as const,
      receiptId: "cleanup-receipt-1",
      fixtureId: "fixture-v1",
      operationKey: "test:test-run:cleanup-operation:request-hash",
      rootFingerprint: "1".repeat(64),
      targets: [],
      artifactVersionId: "artifact-version-1",
      contentHash: "2".repeat(64),
    };
    const adapter = createElectronTestExecutionAdapter({
      fixtureId: "fixture-v1",
      terminalResult: () => ({
        schemaVersion: 1,
        assertions: [],
        evidence: [],
      }),
      terminalReceipt: () => cleanupReceipt,
    });
    const request = {
      operationId: "cleanup-operation",
      operationKey: cleanupReceipt.operationKey,
      testRunId: "test-run",
      requestHash: "a".repeat(64),
      input: { schemaVersion: 1, fixtureId: "fixture-v1" },
    };

    assert.deepEqual(
      (await adapter.reconcile(request)).providerReceipt,
      cleanupReceipt,
    );
  });

  it("correlates only an acknowledged hash of the complete authoritative Query View", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE consumed_view_sync_tokens (
        token_hash TEXT PRIMARY KEY,
        view_hash TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        consumed_at TEXT NOT NULL
      );
    `);
    const run = {
      id: "test-run",
      viewHash: "a".repeat(64),
      state: "reconciling",
      executions: [],
    } as unknown as TestRunView;
    database
      .prepare(
        "INSERT INTO consumed_view_sync_tokens(token_hash, view_hash, sequence, consumed_at) VALUES (?, ?, ?, ?)",
      )
      .run("b".repeat(64), run.viewHash, 4, "2026-07-29T00:00:00.000Z");

    assert.equal(readAcknowledgedElectronTestView(database, run), undefined);

    database
      .prepare(
        "INSERT INTO consumed_view_sync_tokens(token_hash, view_hash, sequence, consumed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "c".repeat(64),
        runtimeQueryViewHash(run),
        5,
        "2026-07-29T00:00:01.000Z",
      );
    const acknowledged = readAcknowledgedElectronTestView(database, run);
    assert.ok(acknowledged);
    assert.deepEqual(
      { ...acknowledged },
      {
        tokenHash: "c".repeat(64),
        viewHash: runtimeQueryViewHash(run),
        sequence: 5,
      },
    );
    database.close();
  });
});
