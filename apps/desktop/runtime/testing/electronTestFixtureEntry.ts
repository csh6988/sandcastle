import { readFileSync } from "node:fs";
import { startCompanyRuntimeServer } from "../server.js";
import { createScriptedExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import type { ModelOnlyInteractionExecutionAdapter } from "../adapters/interactionExecutionAdapter.js";
import type { AdapterExecutionFact } from "../execution/contract.js";
import { loadElectronTestFixtureConfig } from "./electronTestFixture.js";
import {
  createElectronTestExecutionAdapter,
  readAcknowledgedElectronTestView,
} from "./electronTestExecutionAdapter.js";
import type {
  TestExecutionRequest,
  TestExecutionResult,
} from "./testRuntime.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const scriptedInteractionAdapter = (
  response: string,
): ModelOnlyInteractionExecutionAdapter => ({
  capabilities: {
    reattachRunningOperation: false,
    strongExecutionFence: true,
    enforceNoSideEffects: {
      mechanism: "model-only",
      mechanismVersion: "electron-test-fixture-1",
      policySchemaHash: "a".repeat(64),
    },
  },
  execute: async (request, sink) => {
    const facts: readonly AdapterExecutionFact[] = [
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:provider-started`,
        ordinal: 1,
        kind: "provider-started",
        schemaVersion: 1,
        payload: { providerExecutionRef: `fixture:${request.operationKey}` },
        evidenceRefs: [],
      },
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:message`,
        ordinal: 2,
        kind: "message",
        schemaVersion: 1,
        payload: { content: response },
        evidenceRefs: [],
      },
      {
        adapterSchemaVersion: 1,
        factId: `${request.operationKey}:completed`,
        ordinal: 3,
        kind: "completed",
        schemaVersion: 1,
        payload: {},
        evidenceRefs: [],
      },
    ];
    let terminalExecutionFactId = "";
    for (const fact of facts) {
      const receipt = await sink.record(fact);
      if (fact.kind === "completed") {
        terminalExecutionFactId = receipt.executionFactId;
      }
    }
    return {
      operationKey: request.operationKey,
      terminalExecutionFactId,
      status: "succeeded",
      evidenceRefs: [],
    };
  },
  cancel: async () => "not-found",
  reconcile: async () => ({ status: "unknown", evidenceRefs: [] }),
});

type FixtureExecutionInput = {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly testCaseRevisionId: string;
  readonly assertionId: string;
  readonly correlationCommandId: string;
  readonly evidence: TestExecutionResult["evidence"];
  readonly cleanupEvidence: TestExecutionResult["evidence"][number];
};

const fixtureExecutionInput = (
  request: TestExecutionRequest,
  fixtureId: string,
): FixtureExecutionInput => {
  const value = request.input as Partial<FixtureExecutionInput> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    value.fixtureId !== fixtureId ||
    typeof value.testCaseRevisionId !== "string" ||
    typeof value.assertionId !== "string" ||
    typeof value.correlationCommandId !== "string" ||
    !Array.isArray(value.evidence) ||
    !value.cleanupEvidence
  ) {
    throw new Error("Electron Test operation input is invalid.");
  }
  return value as FixtureExecutionInput;
};

const main = async (): Promise<void> => {
  const config = loadElectronTestFixtureConfig({
    configPath: requiredEnvironment("SANDCASTLE_ELECTRON_TEST_FIXTURE_CONFIG"),
    authorization: requiredEnvironment(
      "SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION",
    ),
    packaged:
      requiredEnvironment("SANDCASTLE_ELECTRON_TEST_FIXTURE_PACKAGED") === "1",
    entrypoint: "electron-test-fixture",
  });
  const executionScript = JSON.parse(
    readFileSync(
      config.adapters.find((adapter) => adapter.id === "scripted-execution")!
        .scriptPath,
      "utf8",
    ),
  ) as { readonly structuredResult?: unknown };
  const interactionScript = JSON.parse(
    readFileSync(
      config.adapters.find((adapter) => adapter.id === "scripted-interaction")!
        .scriptPath,
      "utf8",
    ),
  ) as { readonly response?: string };
  const runtime = await startCompanyRuntimeServer({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    companyDir: config.companyDirectory,
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_TOKEN"),
    consumerId: process.env.SANDCASTLE_COMPANY_RUNTIME_CONSUMER_ID,
    principal: {
      type: "human",
      id: "electron-test-fixture",
      authenticatedBy: "local-session",
    },
    executionAdapter: createScriptedExecutionAdapter({
      defaultFact: {
        kind: "succeeded",
        structuredResult: executionScript.structuredResult ?? {
          fixtureId: config.fixtureId,
        },
      },
    }),
    interactionExecutionAdapter: scriptedInteractionAdapter(
      interactionScript.response ?? "fixture interaction completed",
    ),
    testExecutionAdapterFactory: ({ database, tests }) => [
      createElectronTestExecutionAdapter({
        fixtureId: config.fixtureId,
        terminalResult: (request) => {
          const operation = fixtureExecutionInput(request, config.fixtureId);
          const run = tests.inspect(request.testRunId);
          const event = (
            database
              .prepare(
                `SELECT sequence, type, scope_json AS scopeJson
                   FROM runtime_event_outbox
                  WHERE run_id = ? AND node_run_id = ?
                    AND type IN ('test.run.reconciling', 'test.run.started')
                  ORDER BY sequence DESC`,
              )
              .all(run.manifest.runId, run.manifest.nodeRunId) as Array<{
              readonly sequence: number;
              readonly type: string;
              readonly scopeJson: string;
            }>
          ).find((candidate) => {
            const scope = JSON.parse(candidate.scopeJson) as {
              readonly testRunId?: string;
            };
            return scope.testRunId === run.id;
          });
          const consumedToken = readAcknowledgedElectronTestView(database, run);
          if (!event || !consumedToken) {
            throw new Error(
              "Electron Test execution requires an acknowledged authoritative Query View and Runtime event.",
            );
          }
          return {
            schemaVersion: 1,
            assertions: [
              {
                testCaseRevisionId: operation.testCaseRevisionId,
                assertionId: operation.assertionId,
                uiStatus: "passed",
                runtimeStatus: "passed",
                correlation: {
                  commandId: operation.correlationCommandId,
                  eventSequence: event.sequence,
                  runtimeEventType: event.type,
                  queryAsOfSequence: consumedToken.sequence,
                  queryViewHash: consumedToken.viewHash,
                  viewSyncTokenHash: consumedToken.tokenHash,
                  snapshotRevisionId: run.manifest.snapshotRevisionId,
                  runId: run.manifest.runId,
                  nodeRunId: run.manifest.nodeRunId,
                  nodeAttemptId: run.manifest.nodeAttemptId,
                  sessionId: run.manifest.sessionId,
                  artifactVersionIds: operation.evidence
                    .map((entry) => entry.artifactVersionId)
                    .filter((id): id is string => id !== null),
                },
              },
            ],
            evidence: [...operation.evidence, operation.cleanupEvidence],
          };
        },
      }),
    ],
  });
  const close = (): void => void runtime.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await runtime.closed;
};

main().catch((error) => {
  process.stderr.write(`[electron-test-fixture-runtime] ${String(error)}\n`);
  process.exitCode = 1;
});
