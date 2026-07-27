import type { ExecutionAdapter } from "./scriptedExecutionAdapter.js";
import { createProductionExecutionAdapter } from "./productionExecutionAdapter.js";
import { loadSandcastleExecutionRuntime } from "./sandcastleCoreRuntime.js";
import {
  createSandcastleExecutionPort,
  type SandcastleExecutionRuntime,
} from "./sandcastleExecutionPort.js";
import {
  createHttpModelTransport,
  createModelOnlyInteractionExecutionAdapter,
} from "./interactionExecutionAdapter.js";

export const loadConfiguredExecutionAdapter = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  loadRuntime: () => Promise<SandcastleExecutionRuntime> = loadSandcastleExecutionRuntime,
): Promise<ExecutionAdapter | undefined> => {
  const mode =
    environment.SANDCASTLE_COMPANY_RUNTIME_EXECUTION_ADAPTER ?? "scripted";
  if (mode === "scripted") return undefined;
  if (mode !== "production") {
    throw new Error(`Unsupported Company Runtime execution adapter: ${mode}`);
  }
  return createProductionExecutionAdapter(
    createSandcastleExecutionPort(await loadRuntime()),
  );
};

export const loadConfiguredInteractionExecutionAdapter = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const mode =
    environment.SANDCASTLE_COMPANY_RUNTIME_INTERACTION_ADAPTER ?? "disabled";
  if (mode === "disabled" || mode === "scripted") return undefined;
  if (mode !== "production") {
    throw new Error(
      `Unsupported Company Runtime interaction execution adapter: ${mode}`,
    );
  }
  const endpoint = environment.SANDCASTLE_MODEL_TRANSPORT_URL;
  const credential = environment.SANDCASTLE_MODEL_TRANSPORT_CREDENTIAL;
  if (!endpoint || !credential) {
    throw new Error(
      "Production model-only interaction adapter requires a transport URL and credential.",
    );
  }
  return createModelOnlyInteractionExecutionAdapter(
    createHttpModelTransport({ endpoint, credential }),
  );
};
