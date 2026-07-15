import { createHash } from "node:crypto";
import { posix } from "node:path";

const addressHash = (companyDir: string): string =>
  createHash("sha256").update(companyDir).digest("hex").slice(0, 20);

export const companyRuntimeAddressForPlatform = (
  companyDir: string,
  platform: NodeJS.Platform,
): string => {
  const hash = addressHash(companyDir);
  if (platform === "win32") {
    return `\\\\.\\pipe\\sandcastle-company-runtime-${hash}`;
  }

  const companyAddress = posix.join(
    companyDir,
    ".sandcastle",
    "runtime",
    "company-runtime.sock",
  );
  return Buffer.byteLength(companyAddress) <= 100
    ? companyAddress
    : `/tmp/sandcastle-company-runtime-${hash}.sock`;
};

export const companyRuntimeAddress = (companyDir: string): string =>
  companyRuntimeAddressForPlatform(companyDir, process.platform);
