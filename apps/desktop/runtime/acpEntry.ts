import { createAcpStdioFacade, serveAcpStdio } from "./acp.js";
import { createCompanyRuntimeClient } from "./client.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const main = async (): Promise<void> => {
  const client = createCompanyRuntimeClient({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_TOKEN"),
  });
  await serveAcpStdio({
    facade: createAcpStdioFacade(client),
    stdin: process.stdin,
    stdout: process.stdout,
  });
};

main().catch((error) => {
  process.stderr.write(`[company-acp] ${String(error)}\n`);
  process.exitCode = 1;
});
