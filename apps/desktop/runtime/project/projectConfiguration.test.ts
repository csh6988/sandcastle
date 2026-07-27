import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { ProjectConfigurationError } from "./projectConfiguration.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-project-configuration-"));

describe("Project Configuration", () => {
  it("resolves only the production local isolated Git profile for formal Work Packages", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      assert.deepEqual(
        database.projectConfiguration.resolveFormalExecutionProfile(
          "software-rnd-local-isolated-git",
        ),
        {
          executionProfileId: "software-rnd-local-isolated-git",
          executionProfileRevision: 0,
          sandboxRef: "docker",
          branchStrategy: "branch",
          capabilities: {
            profileId: "local-isolated-git",
            mechanism: "private-git-bundle-import",
            mechanismVersion: "1",
            gitRefWriteIsolation: true,
            runtimeImportOnly: true,
          },
        },
      );

      assert.throws(
        () =>
          database.projectConfiguration.resolveFormalExecutionProfile(
            "software-rnd-default",
          ),
        (error: unknown) =>
          error instanceof ProjectConfigurationError &&
          error.code === "PROVIDER_ISOLATION_REQUIRED",
      );
    } finally {
      database.close();
    }
  });

  it("inspects, updates, and reloads persistent Project configuration", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    const project = database.catalog.createProject({
      name: "Checkout",
      goal: "Ship the checkout redesign",
    });

    try {
      assert.deepEqual(database.projectConfiguration.inspect(project.id), {
        id: project.id,
        name: "Checkout",
        goal: "Ship the checkout redesign",
        status: "active",
        revision: 0,
        sharedContext: "",
        repositoryReferences: [],
        departmentRuns: [],
        createdAt: project.createdAt,
      });

      const updated = database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: 0,
        name: "Checkout Platform",
        goal: "Ship a resilient checkout platform",
        sharedContext: "Preserve the current payment-provider contract.",
        repositoryReferences: ["/work/checkout-web", "/work/checkout-api"],
      });

      assert.equal(updated.revision, 1);
      assert.equal(updated.name, "Checkout Platform");
      assert.equal(
        updated.sharedContext,
        "Preserve the current payment-provider contract.",
      );
      assert.deepEqual(updated.repositoryReferences, [
        "/work/checkout-web",
        "/work/checkout-api",
      ]);
    } finally {
      database.close();
    }

    const reloaded = openCompanyDatabase(companyDir);
    try {
      const inspected = reloaded.projectConfiguration.inspect(project.id);
      assert.equal(inspected.revision, 1);
      assert.equal(inspected.name, "Checkout Platform");
      assert.equal(inspected.goal, "Ship a resilient checkout platform");
      assert.deepEqual(inspected.repositoryReferences, [
        "/work/checkout-web",
        "/work/checkout-api",
      ]);
      assert.deepEqual(inspected.departmentRuns, []);
    } finally {
      reloaded.close();
    }
  });

  it("rejects stale revisions and archives without deleting Project history", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    const project = database.catalog.createProject({
      name: "Archive me",
      goal: "Keep the historical configuration",
    });

    try {
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: 0,
        name: project.name,
        goal: project.goal,
        sharedContext: "Retain this context.",
        repositoryReferences: ["/work/archive-me"],
      });

      assert.throws(
        () =>
          database.projectConfiguration.update({
            projectId: project.id,
            expectedRevision: 0,
            name: "Stale overwrite",
            goal: project.goal,
            sharedContext: "Do not overwrite.",
            repositoryReferences: [],
          }),
        (error: unknown) =>
          error instanceof ProjectConfigurationError &&
          error.code === "VERSION_CONFLICT",
      );

      const archived = database.projectConfiguration.archive({
        projectId: project.id,
        expectedRevision: 1,
      });
      assert.equal(archived.status, "archived");
      assert.equal(archived.revision, 2);
      assert.deepEqual(database.catalog.projects(), []);
      assert.deepEqual(
        database.projectConfiguration.inspect(project.id).repositoryReferences,
        ["/work/archive-me"],
      );
    } finally {
      database.close();
    }
  });
});
