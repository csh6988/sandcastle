import { startCompanyRuntimeServer } from "./server.js";
import {
  loadConfiguredExecutionAdapter,
  loadConfiguredInteractionExecutionAdapter,
} from "./adapters/configuredExecutionAdapter.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const main = async (): Promise<void> => {
  const executionAdapter = await loadConfiguredExecutionAdapter();
  const interactionExecutionAdapter =
    await loadConfiguredInteractionExecutionAdapter();
  const runtime = await startCompanyRuntimeServer({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    companyDir: requiredEnvironment("SANDCASTLE_COMPANY_DIR"),
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_TOKEN"),
    executionAdapter,
    interactionExecutionAdapter,
  });
  const close = (): void => {
    void runtime.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await runtime.closed;
};

main().catch((error) => {
  process.stderr.write(`[company-runtime] ${String(error)}\n`);
  process.exitCode = 1;
});
