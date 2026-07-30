import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runtimeQueryViewHash } from "../events/cursor.js";
import type {
  TestExecutionAdapter,
  TestExecutionRequest,
  TestExecutionResult,
  TestRunView,
} from "./testRuntime.js";

export type AcknowledgedElectronTestView = {
  readonly tokenHash: string;
  readonly queryHash: string;
  readonly viewHash: string;
  readonly sequence: number;
  readonly consumerId: string;
  readonly principalHash: string;
  readonly acknowledgementCommandId: string;
};

export const readAcknowledgedElectronTestView = (
  database: DatabaseSync,
  run: TestRunView,
): AcknowledgedElectronTestView | undefined => {
  const queryHash = createHash("sha256")
    .update(JSON.stringify({ type: "test-runs.inspect", testRunId: run.id }))
    .digest("hex");
  return database
    .prepare(
      `SELECT token_hash AS tokenHash, query_hash AS queryHash,
              view_hash AS viewHash, sequence, consumer_id AS consumerId,
              principal_hash AS principalHash,
              command_id AS acknowledgementCommandId
         FROM consumed_view_sync_tokens
        WHERE view_hash = ? AND query_hash = ? AND command_id IS NOT NULL
        ORDER BY consumed_at DESC, token_hash DESC
        LIMIT 1`,
    )
    .get(runtimeQueryViewHash(run), queryHash) as
    | AcknowledgedElectronTestView
    | undefined;
};

const assertFixtureRequest = (
  request: TestExecutionRequest,
  fixtureId: string,
): void => {
  const input = request.input as {
    readonly schemaVersion?: unknown;
    readonly fixtureId?: unknown;
  } | null;
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== 1 ||
    input.fixtureId !== fixtureId
  ) {
    throw new Error(
      "Electron Test execution does not match the frozen fixture identity.",
    );
  }
};

export const createElectronTestExecutionAdapter = (input: {
  readonly fixtureId: string;
  readonly selectAcknowledgedView?: (
    request: TestExecutionRequest,
  ) => AcknowledgedElectronTestView | undefined;
  readonly terminalResult: (
    request: TestExecutionRequest,
    selectedQueryView: AcknowledgedElectronTestView | undefined,
  ) => TestExecutionResult | Promise<TestExecutionResult>;
  readonly terminalReceipt?: (
    request: TestExecutionRequest,
    result: TestExecutionResult,
  ) => unknown | Promise<unknown>;
}): TestExecutionAdapter => ({
  id: "scripted-execution",
  execute: (request) => {
    assertFixtureRequest(request, input.fixtureId);
    return {
      state: "accepted",
      providerReceipt: {
        schemaVersion: 1,
        fixtureId: input.fixtureId,
        operationKey: request.operationKey,
        status: "accepted",
      },
    };
  },
  reconcile: async (request) => {
    assertFixtureRequest(request, input.fixtureId);
    const selectedQueryView = input.selectAcknowledgedView?.(request);
    const result = await input.terminalResult(request, selectedQueryView);
    if (result.assertions.length > 0 && !selectedQueryView) {
      throw new Error(
        "Electron Test assertion materialization requires the adapter-selected acknowledged Query token.",
      );
    }
    return {
      state: "succeeded",
      providerReceipt: input.terminalReceipt
        ? await input.terminalReceipt(request, result)
        : {
            schemaVersion: 1,
            fixtureId: input.fixtureId,
            operationKey: request.operationKey,
            status: "succeeded",
          },
      result,
      ...(selectedQueryView ? { selectedQueryView } : {}),
    };
  },
  cancel: (request) => {
    assertFixtureRequest(request, input.fixtureId);
    return {
      state: "cancelled",
      providerReceipt: {
        schemaVersion: 1,
        fixtureId: input.fixtureId,
        operationKey: request.operationKey,
        status: "cancelled",
      },
    };
  },
});
