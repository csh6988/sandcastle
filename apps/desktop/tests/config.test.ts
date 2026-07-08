import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../main/config.js";

const tempUserDataDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-desktop-user-data-"));

describe("desktop config", () => {
  it("persists local AI company preferences in Electron userData", () => {
    const userDataDir = tempUserDataDir();

    saveConfig(userDataDir, {
      companyDir: "/tmp/company",
      language: "zh",
      lastProjectId: "project-1",
      repoDir: "/tmp/repo",
    });

    assert.deepEqual(loadConfig(userDataDir), {
      companyDir: "/tmp/company",
      language: "zh",
      lastProjectId: "project-1",
      repoDir: "/tmp/repo",
    });
  });
});
