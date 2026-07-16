import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DepartmentSettingsSaveError,
  saveDepartmentSettings,
} from "./departmentSettingsSave.js";

describe("Department Settings save", () => {
  it("saves changed sections in order and reports the section that failed", async () => {
    const saved: string[] = [];

    await assert.rejects(
      saveDepartmentSettings([
        {
          id: "department",
          label: "Department settings",
          save: async () => {
            saved.push("department");
          },
        },
        {
          id: "run-environment",
          label: "Default run environment",
          save: async () => {
            saved.push("run-environment");
            throw new Error("revision conflict");
          },
        },
        {
          id: "secret-reference",
          label: "Secret Reference",
          save: async () => {
            saved.push("secret-reference");
          },
        },
      ]),
      (error: unknown) =>
        error instanceof DepartmentSettingsSaveError &&
        error.operationId === "run-environment" &&
        error.message ===
          "Default run environment could not be saved: revision conflict",
    );

    assert.deepEqual(saved, ["department", "run-environment"]);
  });
});
