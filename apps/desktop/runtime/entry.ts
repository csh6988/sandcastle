import { startCompanyRuntimeServer } from "./server.js";
import {
  loadConfiguredExecutionAdapter,
  loadConfiguredIntegrationValidationProvider,
  loadConfiguredInteractionExecutionAdapter,
  loadConfiguredReviewerExecutionAdapter,
} from "./adapters/configuredExecutionAdapter.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const main = async (): Promise<void> => {
  if (
    process.env.SANDCASTLE_ELECTRON_TEST_FIXTURE_CONFIG ||
    process.env.SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION
  ) {
    throw new Error(
      "Electron Test fixture configuration is accepted only by the dedicated test-only Runtime entrypoint.",
    );
  }
  const executionAdapter = await loadConfiguredExecutionAdapter();
  const interactionExecutionAdapter =
    await loadConfiguredInteractionExecutionAdapter();
  const reviewerExecutionAdapter =
    await loadConfiguredReviewerExecutionAdapter();
  const integrationValidationProvider =
    await loadConfiguredIntegrationValidationProvider();
  const acpToken = process.env.SANDCASTLE_COMPANY_RUNTIME_ACP_TOKEN;
  const acpClientId = process.env.SANDCASTLE_ACP_CLIENT_ID;
  if ((acpToken && !acpClientId) || (!acpToken && acpClientId)) {
    throw new Error(
      "SANDCASTLE_COMPANY_RUNTIME_ACP_TOKEN and SANDCASTLE_ACP_CLIENT_ID must be configured together.",
    );
  }
  const runtime = await startCompanyRuntimeServer({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    companyDir: requiredEnvironment("SANDCASTLE_COMPANY_DIR"),
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_TOKEN"),
    consumerId: process.env.SANDCASTLE_COMPANY_RUNTIME_CONSUMER_ID,
    principal: {
      type: "human",
      id: "local-desktop-user",
      authenticatedBy: "local-session",
      projectReadAuthority: ["*"],
    },
    ...(acpToken && acpClientId
      ? {
          trustedConnections: [
            {
              token: acpToken,
              principal: {
                type: "acp-client" as const,
                id: acpClientId,
                authenticatedBy: "acp-connection" as const,
              },
              consumerId: `acp:${acpClientId}`,
            },
          ],
        }
      : {}),
    executionAdapter,
    interactionExecutionAdapter,
    reviewerExecutionAdapter,
    integrationValidationProvider,
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
