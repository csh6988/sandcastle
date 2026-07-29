import { readFileSync } from "node:fs";
import { startCompanyRuntimeServer } from "../server.js";
import { createScriptedExecutionAdapter } from "../adapters/scriptedExecutionAdapter.js";
import type { ModelOnlyInteractionExecutionAdapter } from "../adapters/interactionExecutionAdapter.js";
import type { AdapterExecutionFact } from "../execution/contract.js";
import { loadElectronTestFixtureConfig } from "./electronTestFixture.js";

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
