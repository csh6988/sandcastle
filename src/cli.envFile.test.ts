import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceEnvFile } from "./cli.js";

describe("resolveWorkspaceEnvFile", () => {
  const original = process.env.SANDCASTLE_ENV_FILE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SANDCASTLE_ENV_FILE;
    } else {
      process.env.SANDCASTLE_ENV_FILE = original;
    }
  });

  it("defaults to the user repo's .sandcastle/.env under cwd", () => {
    delete process.env.SANDCASTLE_ENV_FILE;
    expect(resolveWorkspaceEnvFile("/home/alice/myapp")).toBe(
      resolve("/home/alice/myapp", ".sandcastle", ".env"),
    );
  });

  it("does not resolve into the installed package directory", () => {
    delete process.env.SANDCASTLE_ENV_FILE;
    const result = resolveWorkspaceEnvFile("/home/alice/myapp");
    expect(result).not.toContain("node_modules");
  });

  it("honors the SANDCASTLE_ENV_FILE override", () => {
    process.env.SANDCASTLE_ENV_FILE = "/custom/env/.env";
    expect(resolveWorkspaceEnvFile("/home/alice/myapp")).toBe(
      resolve("/custom/env/.env"),
    );
  });
});
