import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { CompanyCommandSchema } from "../interface.js";
import { CompanyCatalogError } from "./companyCatalog.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-company-catalog-"));

describe("Company Catalog Phase 1 configuration", () => {
  it("rejects secret values at the shared Runtime command boundary", () => {
    assert.equal(
      CompanyCommandSchema.safeParse({
        type: "secret-reference.create",
        departmentId: "software-rnd",
        name: "OpenAI",
        providerScope: "openai",
        secretValue: "must-not-enter-runtime",
      }).success,
      false,
    );
    assert.equal(
      CompanyCommandSchema.safeParse({
        type: "execution-profile.save",
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Unsafe",
        providerRef: "openai",
        model: "gpt-5",
        sandboxRef: "docker",
        branchStrategy: "head",
        timeoutSeconds: 600,
        maxIterations: 5,
        maxTokens: null,
        retryMaxAttempts: 1,
        permissionPolicy: "ask",
        secretReferenceIds: [],
        apiKey: "must-not-enter-runtime",
        environment: { OPENAI_API_KEY: "must-not-enter-runtime" },
      }).success,
      false,
    );
  });

  it("creates, updates, and archives the first Position and AI Member in a blank Department", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const department = database.catalog.createDepartment({ name: "Design" });
      const created = database.catalog.createPosition({
        departmentId: department.id,
        name: "Product Designer",
        responsibility: "Designs accessible product flows.",
        aiMemberDisplayName: "Ada",
        aiMemberProfile: "A pragmatic product designer.",
        aiMemberResponsibilityMetadata: { discipline: "product-design" },
      });
      const position = created.positions[0];
      assert.ok(position);
      assert.equal(position.revision, 0);
      assert.equal(position.status, "active");
      assert.equal(position.aiMember.status, "active");
      assert.equal(position.aiMember.positionId, position.id);

      const updated = database.catalog.updatePosition({
        departmentId: department.id,
        positionId: position.id,
        expectedRevision: 0,
        name: "Senior Product Designer",
        responsibility: "Owns accessible product flows.",
        aiMemberDisplayName: "Ada Lovelace",
        aiMemberProfile: "A senior, pragmatic product designer.",
        aiMemberResponsibilityMetadata: { discipline: "product-design" },
        aiMemberStatus: "active",
      });
      const updatedPosition = updated.positions[0];
      assert.equal(updatedPosition?.id, position.id);
      assert.equal(updatedPosition?.aiMember.id, position.aiMember.id);
      assert.equal(updatedPosition?.revision, 1);
      assert.equal(updatedPosition?.name, "Senior Product Designer");

      assert.throws(
        () =>
          database.catalog.updatePosition({
            departmentId: department.id,
            positionId: position.id,
            expectedRevision: 0,
            name: "Stale overwrite",
            responsibility: "Must not be committed.",
            aiMemberDisplayName: "Stale member",
            aiMemberProfile: "Must not be committed.",
            aiMemberResponsibilityMetadata: {},
            aiMemberStatus: "inactive",
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        database.catalog.inspectDepartment(department.id).positions[0]?.name,
        "Senior Product Designer",
      );

      const archived = database.catalog.archivePosition({
        departmentId: department.id,
        positionId: position.id,
        expectedRevision: 1,
      });
      assert.equal(archived.positions[0]?.status, "archived");
      assert.equal(archived.positions[0]?.revision, 2);
      assert.equal(archived.positions[0]?.aiMember.status, "inactive");
    } finally {
      database.close();
    }
  });

  it("persists a Position default Agent and rejects unregistered adapter IDs", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const current = database.catalog.inspectDepartment("software-rnd");
      const engineer = current.positions.find(
        (position) => position.id === "software-engineer",
      );
      assert.ok(engineer);

      const updated = database.catalog.updatePosition({
        departmentId: "software-rnd",
        positionId: engineer.id,
        expectedRevision: engineer.revision,
        name: engineer.name,
        responsibility: engineer.responsibility,
        aiMemberDisplayName: engineer.aiMember.displayName,
        aiMemberProfile: engineer.aiMember.profile,
        aiMemberResponsibilityMetadata:
          engineer.aiMember.responsibilityMetadata,
        aiMemberStatus: engineer.aiMember.status,
        defaultAgentId: "claude-code",
      });
      assert.equal(
        updated.positions.find((position) => position.id === engineer.id)
          ?.defaultAgentId,
        "claude-code",
      );

      assert.throws(
        () =>
          database.catalog.updatePosition({
            departmentId: "software-rnd",
            positionId: engineer.id,
            expectedRevision: engineer.revision + 1,
            name: engineer.name,
            responsibility: engineer.responsibility,
            aiMemberDisplayName: engineer.aiMember.displayName,
            aiMemberProfile: engineer.aiMember.profile,
            aiMemberResponsibilityMetadata:
              engineer.aiMember.responsibilityMetadata,
            aiMemberStatus: engineer.aiMember.status,
            defaultAgentId: "renderer-display-name",
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "AGENT_NOT_REGISTERED",
      );
    } finally {
      database.close();
    }
  });

  it("saves Position identity, default Agent, and Skills as one configuration", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const current = database.catalog.inspectDepartment("software-rnd");
      const engineer = current.positions.find(
        (position) => position.id === "software-engineer",
      );
      assert.ok(engineer);
      const configuration = database.catalog.configurePosition({
        departmentId: "software-rnd",
        positionId: engineer.id,
        expectedRevision: engineer.revision,
        expectedSkillRevision: 0,
        name: "Senior Software Engineer",
        responsibility: "Owns implementation and verification fixes.",
        aiMemberDisplayName: "Implementation Lead",
        aiMemberProfile: engineer.aiMember.profile,
        aiMemberResponsibilityMetadata:
          engineer.aiMember.responsibilityMetadata,
        aiMemberStatus: engineer.aiMember.status,
        defaultAgentId: "claude-code",
        skillIds: ["code-review", "diagnosing-bugs", "tdd"],
      });

      const saved = configuration.department.positions.find(
        (position) => position.id === engineer.id,
      );
      assert.equal(saved?.name, "Senior Software Engineer");
      assert.equal(saved?.defaultAgentId, "claude-code");
      assert.deepEqual(
        configuration.skills.positions.find(
          (position) => position.id === engineer.id,
        )?.skillIds,
        ["code-review", "diagnosing-bugs", "tdd"],
      );
    } finally {
      database.close();
    }
  });

  it("rejects cross-Department Position updates and archive while active configuration references the Position", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const other = database.catalog.createDepartment({ name: "Other" });
      assert.throws(
        () =>
          database.catalog.updatePosition({
            departmentId: other.id,
            positionId: "software-engineer",
            expectedRevision: 0,
            name: "Software Engineer",
            responsibility: "Must stay in Software R&D.",
            aiMemberDisplayName: "Engineer",
            aiMemberProfile: "",
            aiMemberResponsibilityMetadata: {},
            aiMemberStatus: "active",
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "POSITION_OUTSIDE_DEPARTMENT",
      );
      assert.throws(
        () =>
          database.catalog.archivePosition({
            departmentId: "software-rnd",
            positionId: "software-engineer",
            expectedRevision: 0,
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "POSITION_IN_USE",
      );
      assert.equal(
        database.catalog
          .inspectDepartment("software-rnd")
          .positions.find((position) => position.id === "software-engineer")
          ?.status,
        "active",
      );
    } finally {
      database.close();
    }
  });

  it("stores Execution Profiles separately from AI Member identity and exposes Secret References without secret values", () => {
    const database = openCompanyDatabase(tempCompanyDir());

    try {
      const withReference = database.catalog.createSecretReference({
        departmentId: "software-rnd",
        name: "OpenAI production",
        providerScope: "openai",
      });
      const reference = withReference.secretReferences.find(
        (candidate) => candidate.name === "OpenAI production",
      );
      assert.ok(reference);

      const withProfile = database.catalog.saveExecutionProfile({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Isolated delivery",
        providerRef: "openai",
        model: "gpt-5",
        sandboxRef: "docker",
        branchStrategy: "merge-to-head",
        timeoutSeconds: 900,
        maxIterations: 8,
        maxTokens: 100_000,
        retryMaxAttempts: 2,
        permissionPolicy: "ask",
        secretReferenceIds: [reference.id],
      });
      const profile = withProfile.executionProfiles.find(
        (candidate) => candidate.name === "Isolated delivery",
      );
      assert.ok(profile);
      assert.equal(profile.revision, 0);
      assert.deepEqual(profile.secretReferenceIds, [reference.id]);
      assert.equal(
        withProfile.positions.find(
          (position) => position.id === "software-engineer",
        )?.aiMember.id,
        "software-engineer-member",
      );

      const configured = database.catalog.updateDepartment({
        departmentId: "software-rnd",
        expectedRevision: 0,
        name: "Software R&D",
        description:
          "Turns product goals into reviewed and verified software delivery.",
        inputArtifactContracts: [
          {
            id: "task-input",
            name: "Task input",
            artifactType: "application/vnd.sandcastle.task+json",
            schemaVersion: "1",
            required: true,
          },
        ],
        outputArtifactContracts: [
          {
            id: "verified-delivery",
            name: "Verified delivery",
            artifactType: "application/vnd.sandcastle.delivery+json",
            schemaVersion: "1",
            required: true,
          },
        ],
        defaultExecutionProfileId: profile.id,
      });
      assert.equal(configured.defaultExecutionProfileId, profile.id);
      assert.equal(configured.revision, 1);
      assert.equal(JSON.stringify(configured).includes("secretValue"), false);
      assert.equal(JSON.stringify(configured).includes("apiKey"), false);
      assert.equal(JSON.stringify(configured).includes("token"), false);

      assert.throws(
        () =>
          database.catalog.updateDepartment({
            departmentId: "software-rnd",
            expectedRevision: 0,
            name: "Stale overwrite",
            description: "Must not persist.",
            inputArtifactContracts: [],
            outputArtifactContracts: [],
            defaultExecutionProfileId: null,
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "VERSION_CONFLICT",
      );
      assert.equal(
        database.catalog.inspectDepartment("software-rnd")
          .defaultExecutionProfileId,
        profile.id,
      );

      const updatedProfile = database.catalog.saveExecutionProfile({
        departmentId: "software-rnd",
        executionProfileId: profile.id,
        expectedRevision: 0,
        name: "Isolated delivery v2",
        providerRef: "openai",
        model: "gpt-5",
        sandboxRef: "docker",
        branchStrategy: "merge-to-head",
        timeoutSeconds: 1_200,
        maxIterations: 8,
        maxTokens: 100_000,
        retryMaxAttempts: 2,
        permissionPolicy: "ask",
        secretReferenceIds: [reference.id],
      });
      assert.equal(
        updatedProfile.executionProfiles.find(
          (candidate) => candidate.id === profile.id,
        )?.revision,
        1,
      );
      assert.throws(
        () =>
          database.catalog.saveExecutionProfile({
            departmentId: "software-rnd",
            executionProfileId: profile.id,
            expectedRevision: 0,
            name: "Stale profile",
            providerRef: "openai",
            model: "gpt-5",
            sandboxRef: "docker",
            branchStrategy: "head",
            timeoutSeconds: 600,
            maxIterations: 5,
            maxTokens: null,
            retryMaxAttempts: 1,
            permissionPolicy: "ask",
            secretReferenceIds: [],
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "VERSION_CONFLICT",
      );

      assert.throws(
        () =>
          database.catalog.archiveExecutionProfile({
            departmentId: "software-rnd",
            executionProfileId: profile.id,
            expectedRevision: 1,
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "EXECUTION_PROFILE_IN_USE",
      );
      assert.throws(
        () =>
          database.catalog.archiveSecretReference({
            departmentId: "software-rnd",
            secretReferenceId: reference.id,
          }),
        (error: unknown) =>
          error instanceof CompanyCatalogError &&
          error.code === "SECRET_REFERENCE_IN_USE",
      );
    } finally {
      database.close();
    }
  });
});
