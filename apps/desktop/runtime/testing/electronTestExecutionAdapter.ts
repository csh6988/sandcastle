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
  readonly viewHash: string;
  readonly sequence: number;
};

export const readAcknowledgedElectronTestView = (
  database: DatabaseSync,
  run: TestRunView,
): AcknowledgedElectronTestView | undefined =>
  database
    .prepare(
      `SELECT token_hash AS tokenHash, view_hash AS viewHash, sequence
         FROM consumed_view_sync_tokens
        WHERE view_hash = ?
        ORDER BY consumed_at DESC, token_hash DESC
        LIMIT 1`,
    )
    .get(runtimeQueryViewHash(run)) as AcknowledgedElectronTestView | undefined;

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
  readonly terminalResult: (
    request: TestExecutionRequest,
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
    const result = await input.terminalResult(request);
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
