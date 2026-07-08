import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureCompanyDirectory } from "../main/companyDirectory.js";
import {
  bindSkillFlows,
  createSkillFlow,
  getDepartments,
  listSkillFlows,
} from "../main/skillFlowStore.js";

const tempCompanyDir = (): string => {
  const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-skills-"));
  ensureCompanyDirectory(companyDir);
  return companyDir;
};

describe("skill flow store", () => {
  it("creates custom skill flows and binds flows to AI members", () => {
    const companyDir = tempCompanyDir();

    const flow = createSkillFlow(companyDir, {
      name: "Focused TDD",
      skills: ["tdd", "review"],
    });
    const flows = listSkillFlows(companyDir);
    assert.equal(flow.id, "focused-tdd");
    assert.ok(flows.some((item) => item.id === "focused-tdd"));

    const departments = bindSkillFlows(companyDir, {
      departmentId: "software-rnd",
      memberId: "generator",
      flowIds: ["focused-tdd", "implementation-flow"],
    });
    const generator = departments
      .find((department) => department.id === "software-rnd")
      ?.members.find((member) => member.id === "generator");

    assert.deepEqual(generator?.skillFlowIds, [
      "focused-tdd",
      "implementation-flow",
    ]);
    assert.deepEqual(getDepartments(companyDir), departments);
  });
});
