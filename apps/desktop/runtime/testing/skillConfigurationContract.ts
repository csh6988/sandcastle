import assert from "node:assert/strict";
import type { SkillConfigurationView } from "../interface.js";

export const scriptedSkillConfiguration: SkillConfigurationView = {
  department: { id: "software-rnd", name: "Software R&D" },
  revision: 0,
  activeSkills: [
    {
      id: "tdd",
      name: "Test-Driven Development",
      description: "Builds behavior through red-green vertical slices.",
      source: "sandcastle",
      version: "1",
      locationReference: "skill://tdd",
      status: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      archivedAt: null,
    },
  ],
  archivedSkills: [],
  positions: [
    {
      id: "software-engineer",
      name: "Software Engineer",
      skillIds: ["tdd"],
    },
  ],
  skillFlows: [
    {
      id: "implementation-flow",
      departmentId: "software-rnd",
      positionId: "software-engineer",
      name: "Implementation",
      instructions: "Implement one tested vertical slice at a time.",
      skillIds: ["tdd"],
      revision: 0,
      status: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      archivedAt: null,
    },
  ],
  pipelineNodes: [
    {
      id: "implementation",
      type: "ai-task",
      name: "Implementation",
      positionId: "software-engineer",
      skillFlowId: "implementation-flow",
    },
  ],
};

export const assertSkillConfigurationContract = (
  configuration: SkillConfigurationView,
): void => {
  assert.equal(configuration.department.id, "software-rnd");
  assert.equal(configuration.activeSkills[0]?.id, "tdd");
  assert.deepEqual(configuration.positions[0]?.skillIds, ["tdd"]);
  assert.equal(configuration.skillFlows[0]?.id, "implementation-flow");
  assert.equal(
    configuration.pipelineNodes[0]?.skillFlowId,
    "implementation-flow",
  );
};
