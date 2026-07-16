import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { SkillConfigurationError } from "./skillConfiguration.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-skill-configuration-"));

describe("Skill Configuration", () => {
  it("does not commit Company Skill changes when the requested Department does not exist", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const before = database.skillConfiguration.inspect("software-rnd");
      assert.throws(
        () =>
          database.skillConfiguration.saveSkill({
            departmentId: "missing-department",
            expectedRevision: before.revision,
            name: "Must not persist",
            description: "The Department validation must happen first.",
            source: "local",
            version: "1",
            locationReference: "skill://must-not-persist",
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "DEPARTMENT_NOT_FOUND",
      );

      const afterSave = database.skillConfiguration.inspect("software-rnd");
      assert.equal(afterSave.revision, before.revision);
      assert.deepEqual(afterSave.activeSkills, before.activeSkills);

      const created = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        expectedRevision: before.revision,
        name: "Unused skill",
        description: "Remains active after a rejected archive.",
        source: "local",
        version: "1",
        locationReference: "skill://unused-transaction-test",
      });
      const unused = created.activeSkills.find(
        (skill) => skill.name === "Unused skill",
      );
      assert.ok(unused);

      assert.throws(
        () =>
          database.skillConfiguration.archiveSkill({
            departmentId: "missing-department",
            skillId: unused.id,
            expectedRevision: created.revision,
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "DEPARTMENT_NOT_FOUND",
      );
      const afterArchive = database.skillConfiguration.inspect("software-rnd");
      assert.equal(afterArchive.revision, created.revision);
      assert.equal(
        afterArchive.activeSkills.some((skill) => skill.id === unused.id),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("inspects the Company Skill Catalog, Position bindings, and Skill Flows through one interface", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const configuration = database.skillConfiguration.inspect("software-rnd");

      assert.equal(configuration.department.id, "software-rnd");
      assert.equal(configuration.revision, 0);
      assert.deepEqual(
        configuration.activeSkills.map((skill) => skill.id),
        [
          "code-review",
          "codebase-design",
          "diagnosing-bugs",
          "domain-modeling",
          "grill-with-docs",
          "pre-release",
          "tdd",
        ],
      );
      assert.deepEqual(configuration.archivedSkills, []);
      assert.deepEqual(
        configuration.positions.map((position) => ({
          id: position.id,
          skillIds: position.skillIds,
        })),
        [
          {
            id: "product-planner",
            skillIds: ["domain-modeling", "grill-with-docs"],
          },
          {
            id: "software-architect",
            skillIds: ["codebase-design", "domain-modeling"],
          },
          {
            id: "software-engineer",
            skillIds: ["diagnosing-bugs", "tdd"],
          },
          { id: "reviewer", skillIds: ["code-review"] },
          { id: "evaluator", skillIds: ["pre-release"] },
        ],
      );
      assert.deepEqual(
        configuration.skillFlows.map((flow) => ({
          id: flow.id,
          positionId: flow.positionId,
          skillIds: flow.skillIds,
          revision: flow.revision,
          status: flow.status,
        })),
        [
          {
            id: "product-alignment-flow",
            positionId: "product-planner",
            skillIds: ["grill-with-docs", "domain-modeling"],
            revision: 0,
            status: "active",
          },
          {
            id: "technical-planning-flow",
            positionId: "software-architect",
            skillIds: ["codebase-design", "domain-modeling"],
            revision: 0,
            status: "active",
          },
          {
            id: "implementation-flow",
            positionId: "software-engineer",
            skillIds: ["tdd", "diagnosing-bugs"],
            revision: 0,
            status: "active",
          },
          {
            id: "review-flow",
            positionId: "reviewer",
            skillIds: ["code-review"],
            revision: 0,
            status: "active",
          },
          {
            id: "verification-flow",
            positionId: "evaluator",
            skillIds: ["pre-release"],
            revision: 0,
            status: "active",
          },
        ],
      );
    } finally {
      database.close();
    }
  });

  it("persists a Position Skill subset and advances the configuration revision", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const updated = database.skillConfiguration.setPositionSkills({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        skillIds: ["code-review", "diagnosing-bugs", "tdd"],
      });

      assert.equal(updated.revision, 1);
      assert.deepEqual(
        updated.positions.find(
          (position) => position.id === "software-engineer",
        )?.skillIds,
        ["code-review", "diagnosing-bugs", "tdd"],
      );
      assert.deepEqual(
        database.skillConfiguration
          .inspect("software-rnd")
          .positions.find((position) => position.id === "software-engineer")
          ?.skillIds,
        ["code-review", "diagnosing-bugs", "tdd"],
      );
    } finally {
      database.close();
    }
  });

  it("creates a persistent Skill Flow from Skills bound to its Position", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const updated = database.skillConfiguration.saveSkillFlow({
        departmentId: "software-rnd",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Focused delivery",
        instructions:
          "Implement one tested behavior and stop at the delivery boundary.",
        skillIds: ["tdd"],
      });
      const created = updated.skillFlows.find(
        (flow) => flow.name === "Focused delivery",
      );

      assert.ok(created);
      assert.equal(created.departmentId, "software-rnd");
      assert.equal(created.positionId, "software-engineer");
      assert.equal(created.revision, 0);
      assert.equal(created.status, "active");
      assert.deepEqual(created.skillIds, ["tdd"]);
      assert.equal(
        database.skillConfiguration
          .inspect("software-rnd")
          .skillFlows.some((flow) => flow.id === created.id),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("rejects stale Skill Flow edits with VERSION_CONFLICT without overwriting the current revision", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const saved = database.skillConfiguration.saveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: "implementation-flow",
        positionId: "software-engineer",
        expectedRevision: 0,
        name: "Focused implementation",
        instructions: "Use the smallest tested vertical slice.",
        skillIds: ["tdd"],
      });
      assert.equal(
        saved.skillFlows.find((flow) => flow.id === "implementation-flow")
          ?.revision,
        1,
      );

      assert.throws(
        () =>
          database.skillConfiguration.saveSkillFlow({
            departmentId: "software-rnd",
            skillFlowId: "implementation-flow",
            positionId: "software-engineer",
            expectedRevision: 0,
            name: "Stale overwrite",
            instructions: "This must not replace the current flow.",
            skillIds: ["diagnosing-bugs"],
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "VERSION_CONFLICT",
      );
      const current = database.skillConfiguration
        .inspect("software-rnd")
        .skillFlows.find((flow) => flow.id === "implementation-flow");
      assert.equal(current?.name, "Focused implementation");
      assert.equal(current?.revision, 1);
      assert.deepEqual(current?.skillIds, ["tdd"]);
    } finally {
      database.close();
    }
  });

  it("archives an unused Skill Flow without deleting its history", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const created = database.skillConfiguration
        .saveSkillFlow({
          departmentId: "software-rnd",
          positionId: "software-engineer",
          expectedRevision: 0,
          name: "Temporary delivery",
          instructions: "Use TDD for this temporary flow.",
          skillIds: ["tdd"],
        })
        .skillFlows.find((flow) => flow.name === "Temporary delivery");
      assert.ok(created);

      const archived = database.skillConfiguration.archiveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: created.id,
        expectedRevision: 0,
      });
      const history = archived.skillFlows.find(
        (flow) => flow.id === created.id,
      );

      assert.equal(history?.status, "archived");
      assert.equal(history?.revision, 1);
      assert.ok(history?.archivedAt);
      assert.deepEqual(history?.skillIds, ["tdd"]);
      assert.equal(
        database.skillConfiguration
          .inspect("software-rnd")
          .skillFlows.find((flow) => flow.id === created.id)?.status,
        "archived",
      );
    } finally {
      database.close();
    }
  });

  it("creates a persistent Skill in the Company Skill Catalog", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const updated = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Release notes",
        description: "Produces concise release notes from verified changes.",
        source: "local",
        version: "2.1.0",
        locationReference: "skill://release-notes",
      });
      const created = updated.activeSkills.find(
        (skill) => skill.name === "Release notes",
      );

      assert.ok(created);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(
        created.description,
        "Produces concise release notes from verified changes.",
      );
      assert.equal(created.source, "local");
      assert.equal(created.version, "2.1.0");
      assert.equal(created.locationReference, "skill://release-notes");
      assert.equal(created.status, "active");
      assert.equal(updated.revision, 1);
      assert.equal(
        database.skillConfiguration
          .inspect("software-rnd")
          .activeSkills.some((skill) => skill.id === created.id),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("updates an active Skill without changing its stable ID", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const createdView = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Release notes",
        description: "Produces release notes.",
        source: "local",
        version: "1",
        locationReference: "skill://release-notes",
      });
      const created = createdView.activeSkills.find(
        (skill) => skill.name === "Release notes",
      );
      assert.ok(created);

      const updated = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        skillId: created.id,
        expectedRevision: 1,
        name: "Verified release notes",
        description: "Produces release notes from verified delivery evidence.",
        source: "local",
        version: "2",
        locationReference: "skill://release-notes/v2",
      });
      const saved = updated.activeSkills.find(
        (skill) => skill.id === created.id,
      );

      assert.equal(saved?.name, "Verified release notes");
      assert.equal(
        saved?.description,
        "Produces release notes from verified delivery evidence.",
      );
      assert.equal(saved?.version, "2");
      assert.equal(saved?.locationReference, "skill://release-notes/v2");
      assert.equal(updated.revision, 2);
    } finally {
      database.close();
    }
  });

  it("archives an unused Skill while preserving its Catalog history", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const createdView = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Temporary capability",
        description: "A capability used to verify archive history.",
        source: "custom",
        version: "1",
        locationReference: "skill://temporary-capability",
      });
      const created = createdView.activeSkills.find(
        (skill) => skill.name === "Temporary capability",
      );
      assert.ok(created);

      const archived = database.skillConfiguration.archiveSkill({
        departmentId: "software-rnd",
        skillId: created.id,
        expectedRevision: 1,
      });

      assert.equal(
        archived.activeSkills.some((skill) => skill.id === created.id),
        false,
      );
      const history = archived.archivedSkills.find(
        (skill) => skill.id === created.id,
      );
      assert.equal(history?.name, "Temporary capability");
      assert.equal(history?.source, "custom");
      assert.equal(history?.version, "1");
      assert.ok(history?.archivedAt);
      assert.equal(archived.revision, 2);
    } finally {
      database.close();
    }
  });

  it("rejects archiving a Skill that is still in use", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      assert.throws(
        () =>
          database.skillConfiguration.archiveSkill({
            departmentId: "software-rnd",
            skillId: "tdd",
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_IN_USE",
      );
      const current = database.skillConfiguration.inspect("software-rnd");
      assert.equal(
        current.activeSkills.some((skill) => skill.id === "tdd"),
        true,
      );
      assert.equal(current.revision, 0);
    } finally {
      database.close();
    }
  });

  it("rejects removing a Skill that an active Flow still uses", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      assert.throws(
        () =>
          database.skillConfiguration.setPositionSkills({
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 0,
            skillIds: ["tdd"],
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "POSITION_SKILL_IN_USE",
      );
      const current = database.skillConfiguration
        .inspect("software-rnd")
        .positions.find((position) => position.id === "software-engineer");
      assert.deepEqual(current?.skillIds, ["diagnosing-bugs", "tdd"]);
    } finally {
      database.close();
    }
  });

  it("returns stable errors for missing and archived Position Skill references", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      assert.throws(
        () =>
          database.skillConfiguration.setPositionSkills({
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 0,
            skillIds: ["missing-skill"],
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_NOT_FOUND",
      );
      const createdView = database.skillConfiguration.saveSkill({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Archived reference",
        description: "Used to verify archived binding validation.",
        source: "custom",
        version: "1",
        locationReference: "skill://archived-reference",
      });
      const created = createdView.activeSkills.find(
        (skill) => skill.name === "Archived reference",
      );
      assert.ok(created);
      database.skillConfiguration.archiveSkill({
        departmentId: "software-rnd",
        skillId: created.id,
        expectedRevision: 1,
      });

      assert.throws(
        () =>
          database.skillConfiguration.setPositionSkills({
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 2,
            skillIds: [created.id],
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_ARCHIVED",
      );
    } finally {
      database.close();
    }
  });

  it("excludes unavailable discovered Skills from Position selection", async () => {
    const companyDir = tempCompanyDir();
    const sourceDirectory = join(companyDir, "company-skills");
    const skillDirectory = join(sourceDirectory, "release-review");
    mkdirSync(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: Release Review\ndescription: Reviews release evidence.\n---\n",
    );
    const database = openCompanyDatabase(companyDir);

    try {
      const discovered = await database.skillCatalog.discover({
        directories: [sourceDirectory],
      });
      const skill = discovered.skills.find(
        (candidate) => candidate.locationReference === skillPath,
      );
      assert.ok(skill);
      await database.skillCatalog.enable(skill.id);
      rmSync(skillPath);
      await database.skillCatalog.discover({ directories: [sourceDirectory] });

      const configuration = database.skillConfiguration.inspect("software-rnd");
      assert.equal(
        configuration.activeSkills.some(
          (candidate) => candidate.id === skill.id,
        ),
        false,
      );
      assert.throws(
        () =>
          database.skillConfiguration.setPositionSkills({
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: configuration.revision,
            skillIds: [skill.id],
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_UNAVAILABLE",
      );
    } finally {
      database.close();
    }
  });

  it("rejects archiving a Skill Flow referenced by the current Pipeline Draft", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const pipeline = database.pipelineConfiguration.inspect("software-rnd");
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: {
          ...pipeline.draft.graph,
          nodes: pipeline.draft.graph.nodes.map((node) =>
            node.id === "implementation"
              ? { ...node, skillFlowId: "implementation-flow" }
              : node,
          ),
        },
      });

      assert.throws(
        () =>
          database.skillConfiguration.archiveSkillFlow({
            departmentId: "software-rnd",
            skillFlowId: "implementation-flow",
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_FLOW_IN_USE",
      );
      assert.equal(
        database.skillConfiguration
          .inspect("software-rnd")
          .skillFlows.find((flow) => flow.id === "implementation-flow")?.status,
        "active",
      );
    } finally {
      database.close();
    }
  });

  it("rejects archiving a Skill Flow referenced by the active Pipeline Version", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const original = database.pipelineConfiguration.inspect("software-rnd");
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: {
          ...original.draft.graph,
          nodes: original.draft.graph.nodes.map((node) =>
            node.id === "implementation"
              ? { ...node, skillFlowId: "implementation-flow" }
              : node,
          ),
        },
      });
      database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 1,
        graph: original.draft.graph,
      });

      assert.throws(
        () =>
          database.skillConfiguration.archiveSkillFlow({
            departmentId: "software-rnd",
            skillFlowId: "implementation-flow",
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof SkillConfigurationError &&
          error.code === "SKILL_FLOW_IN_USE",
      );
    } finally {
      database.close();
    }
  });

  it("allows archiving a Skill Flow referenced only by historical Pipeline Versions", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const created = database.skillConfiguration
        .saveSkillFlow({
          departmentId: "software-rnd",
          positionId: "software-engineer",
          expectedRevision: 0,
          name: "Historical delivery",
          instructions: "This flow remains referenced by a historical Version.",
          skillIds: ["tdd"],
        })
        .skillFlows.find((flow) => flow.name === "Historical delivery");
      assert.ok(created);
      const original = database.pipelineConfiguration.inspect("software-rnd");
      const selectedGraph = {
        ...original.draft.graph,
        nodes: original.draft.graph.nodes.map((node) =>
          node.id === "implementation"
            ? { ...node, skillFlowId: created.id }
            : node,
        ),
      };
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: selectedGraph,
      });
      database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 1,
      });
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 1,
        graph: original.draft.graph,
      });
      database.pipelineConfiguration.publish({
        departmentId: "software-rnd",
        expectedRevision: 2,
      });

      const archived = database.skillConfiguration.archiveSkillFlow({
        departmentId: "software-rnd",
        skillFlowId: created.id,
        expectedRevision: 0,
      });
      assert.equal(
        archived.skillFlows.find((flow) => flow.id === created.id)?.status,
        "archived",
      );
      const pipeline = database.pipelineConfiguration.inspect("software-rnd");
      assert.equal(pipeline.published?.version, 4);
      assert.equal(
        pipeline.published?.graph.nodes.some(
          (node) => node.skillFlowId === created.id,
        ),
        false,
      );
      assert.equal(
        pipeline.history
          .find((version) => version.version === 3)
          ?.graph.nodes.some((node) => node.skillFlowId === created.id),
        true,
      );
    } finally {
      database.close();
    }
  });

  it("includes current Pipeline node Skill Flow selections in the read model", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const pipeline = database.pipelineConfiguration.inspect("software-rnd");
      database.pipelineConfiguration.saveDraft({
        departmentId: "software-rnd",
        expectedRevision: 0,
        graph: {
          ...pipeline.draft.graph,
          nodes: pipeline.draft.graph.nodes.map((node) =>
            node.id === "implementation"
              ? { ...node, skillFlowId: "implementation-flow" }
              : node,
          ),
        },
      });

      const configuration = database.skillConfiguration.inspect("software-rnd");
      assert.equal(
        configuration.pipelineNodes.find((node) => node.id === "implementation")
          ?.skillFlowId,
        "implementation-flow",
      );
      assert.equal(
        configuration.pipelineNodes.find((node) => node.id === "start")
          ?.skillFlowId,
        undefined,
      );
    } finally {
      database.close();
    }
  });
});
