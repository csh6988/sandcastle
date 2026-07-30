import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { createElectronTestFixture } from "./electronTestFixture.js";
import {
  createIntegrationAuthorityFixture,
  createIntegrationAuthorityFixtureRuntimeOptions,
} from "./integrationAuthorityFixture.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fixtureRoots: string[] = [];
const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Integration authority fixture", () => {
  it("creates exact T15 and T16 PASS authority through Runtime handlers", async () => {
    const scriptRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-integration-authority-scripts-"),
    );
    fixtureRoots.push(scriptRoot);
    const executionScript = join(scriptRoot, "execution.json");
    const interactionScript = join(scriptRoot, "interaction.json");
    writeFileSync(executionScript, JSON.stringify({ status: "passed" }), {
      mode: 0o600,
    });
    writeFileSync(
      interactionScript,
      JSON.stringify({ response: "fixture interaction passed" }),
      { mode: 0o600 },
    );
    const electronFixture = createElectronTestFixture({
      fixtureId: "integration-authority-fixture-v1",
      testRunId: "pending",
      testRunManifestHash: "0".repeat(64),
      adapters: [
        {
          id: "scripted-execution",
          scriptPath: executionScript,
          expectedScriptHash: sha256(JSON.stringify({ status: "passed" })),
        },
        {
          id: "scripted-interaction",
          scriptPath: interactionScript,
          expectedScriptHash: sha256(
            JSON.stringify({ response: "fixture interaction passed" }),
          ),
        },
      ],
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "integration-authority-fixture-seed",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    fixtureCleanups.push(() => void electronFixture.cleanup());

    const fixtureInput = {
      companyDirectory: electronFixture.config.companyDirectory,
      companyDirectoryFingerprint:
        electronFixture.config.companyDirectoryFingerprint,
      fixtureId: electronFixture.config.fixtureId,
      repositoryDirectory: electronFixture.config.repositoryDirectory,
      worktreeDirectory: electronFixture.config.worktreeDirectory,
      fakeClock: electronFixture.config.fakeClock,
      repeatableIdSeed: electronFixture.config.repeatableIdSeed,
    };
    const runtimeOptions =
      createIntegrationAuthorityFixtureRuntimeOptions(fixtureInput);
    const database = openCompanyDatabase(
      electronFixture.config.companyDirectory,
      {
        clock: runtimeOptions.clock,
        executionAdapter: runtimeOptions.executionAdapter,
        codeReviewRuntime: {
          reviewerExecutionAdapter: runtimeOptions.reviewerExecutionAdapter,
        },
        integrationRuntime: {
          validationProvider: runtimeOptions.integrationValidationProvider,
        },
      },
    );
    const created = await createIntegrationAuthorityFixture({
      ...fixtureInput,
      database,
    });

    try {
      const frozenCoverage = created.workPackageCoverage[0];
      assert.ok(frozenCoverage);
      const persistedWorkPackageVersion = database.workPackages
        .inspect(created.runId)
        .packages.find((entry) => entry.id === frozenCoverage.workPackageId)
        ?.versions.find(
          (entry) => entry.id === frozenCoverage.workPackageVersionId,
        );
      assert.ok(persistedWorkPackageVersion);
      assert.equal(
        frozenCoverage.manifestHash,
        persistedWorkPackageVersion.manifestHash,
      );
      const authority = database.integrations.readPassAuthority(
        created.integrationAuthority.id,
      );
      assert.deepEqual(authority, created.integrationAuthority);
      assert.deepEqual(
        database.artifactRegistry.inspect(created.build.artifactVersionId)
          .version.producer.integrationAuthority,
        {
          generationId: authority.id,
          manifestHash: authority.manifestHash,
          passAuthorityHash: authority.passAuthorityHash,
          repositoryCommits: authority.repositoryResults.map((entry) => ({
            repositoryReference: entry.repositoryReference,
            commit: entry.integratedCommit!,
          })),
        },
      );
      assert.equal(
        database.codeReviews.inspect(created.runId)[0]?.integrationEligible,
        true,
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(created.runId)
          .nodes.find((node) => node.pipelineNodeId === "integration")?.status,
        "succeeded",
      );
      const prerequisiteCommandIds = [
        "application-register",
        "product-proposal-revise",
        "product-proposal-awaiting",
        "product-baseline-confirm",
        "project-spec-revise",
        "product-review-start",
        "product-review-revision",
        "product-review-pass-primary",
        "product-review-pass-fresh",
        "product-readiness-record",
        "product-gate-promote",
        "application-spec-revise",
        "technical-proposal-revise",
        "technical-review-start",
        "technical-review-revision",
        "technical-review-pass-primary",
        "technical-review-pass-fresh",
        "technical-gate-promote",
        "work-package-generate",
        "work-package-assign",
        "work-package-start",
        "work-package-self-check",
        "canonical-diff-register",
        "canonical-diff-finalize",
        "build-register",
        "build-finalize",
      ].map((suffix) => `${electronFixture.config.fixtureId}:${suffix}`);
      const auditDatabase = new DatabaseSync(database.path, { readOnly: true });
      try {
        for (const commandId of prerequisiteCommandIds) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
                  )
                  .get(commandId) as { readonly count: unknown }
              ).count,
            ),
            1,
            commandId,
          );
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
                  )
                  .get(commandId) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${commandId}:audit`,
          );
        }
        for (const action of [
          "workspace-allocation.ready",
          "source-import.planned",
          "source-import.completed",
          "attempt.complete",
        ]) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE action = ?",
                  )
                  .get(action) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${action}:audit`,
          );
        }
        assert.equal(
          Number(
            (
              auditDatabase
                .prepare(
                  `SELECT COUNT(*) AS count
                     FROM execution_facts facts
                     JOIN work_package_assignments assignments
                       ON assignments.node_attempt_id = facts.target_id
                    WHERE facts.kind = 'completed'
                      AND facts.status = 'accepted'`,
                )
                .get() as {
                readonly count: unknown;
              }
            ).count,
          ) > 0,
          true,
          "development execution terminal fact",
        );
        for (const eventType of [
          "workspace-allocation.ready",
          "source-import.completed",
          "execution.completed",
        ]) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = ?",
                  )
                  .get(eventType) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${eventType}:outbox`,
          );
        }
      } finally {
        auditDatabase.close();
      }
    } finally {
      database.close();
    }
  });
});
