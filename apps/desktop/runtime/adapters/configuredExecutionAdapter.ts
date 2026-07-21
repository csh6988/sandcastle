import type { ExecutionAdapter } from "./scriptedExecutionAdapter.js";
import { createProductionExecutionAdapter } from "./productionExecutionAdapter.js";
import { loadSandcastleExecutionRuntime } from "./sandcastleCoreRuntime.js";
import {
  createSandcastleExecutionPort,
  type SandcastleExecutionRuntime,
} from "./sandcastleExecutionPort.js";
import { createSandcastleInteractionExecutionAdapter } from "./interactionExecutionAdapter.js";

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
  loadRuntime: () => Promise<SandcastleExecutionRuntime> = loadSandcastleExecutionRuntime,
) => createSandcastleInteractionExecutionAdapter(await loadRuntime());
