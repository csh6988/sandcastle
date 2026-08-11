import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { resolveGitRepositoryRoot } from "./repositoryDirectoryPicker.js";

describe("repository directory picker Windows paths", () => {
  it("normalizes an absolute Windows Git root", async () => {
    const result = await resolveGitRepositoryRoot("C:\\repo\\packages", {
      pathApi: path.win32,
      accessDirectory: async () => undefined,
      runFile: async () => ({ stdout: "C:/repo\r\n" }),
    });

    assert.equal(result, "C:\\repo");
  });
});
