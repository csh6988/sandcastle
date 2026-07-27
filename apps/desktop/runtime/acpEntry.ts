import { once } from "node:events";
import { createAcpFacade, serveAcpStdio } from "./acp.js";
import { createCompanyRuntimeClient } from "./client.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const main = async (): Promise<void> => {
  const clientId = requiredEnvironment("SANDCASTLE_ACP_CLIENT_ID");
  const client = createCompanyRuntimeClient({
    address: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ADDRESS"),
    token: requiredEnvironment("SANDCASTLE_COMPANY_RUNTIME_ACP_TOKEN"),
  });
  const send = async (
    message: Parameters<ReturnType<typeof createAcpFacade>["receive"]>[0],
  ) => {
    if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
      await once(process.stdout, "drain");
    }
  };
  const facade = createAcpFacade({
    client,
    connection: {
      clientId,
      consumerId: `acp:${clientId}`,
    },
    send,
  });
  await serveAcpStdio({
    facade,
    stdin: process.stdin,
    stdout: process.stdout,
  });
};

main().catch((error) => {
  process.stderr.write(`[company-acp] ${String(error)}\n`);
  process.exitCode = 1;
});
