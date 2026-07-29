import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "./storage/sqlite.js";
import type { CommandEnvelope } from "./interface.js";
import {
  CompanyCommandError,
  openCompanyCommandRegistry,
} from "./commandRegistry.js";
import { openProjectConfiguration } from "./project/projectConfiguration.js";
import { RUNTIME_EVENT_REGISTRY_VERSION } from "./events/registry.js";
import { migrateCompanyDatabase } from "./storage/migrations.js";
import type {
  IntegrationGenerationView,
  IntegrationRuntime,
} from "./integration/integrationRuntime.js";
import { openIntegrationRuntime } from "./integration/integrationRuntime.js";
import { openRuntimeEvents } from "./events/subscription.js";
import { openTestRuntime } from "./testing/testRuntime.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-command-registry-"));

const actor = {
  type: "test-driver" as const,
  id: "command-registry-test",
  authenticatedBy: "ipc-token" as const,
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

describe("Company Runtime command registry", () => {
  it("persists Test Case revision, audit, outbox, trigger context, and replay receipt in one unit of work", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Test checkout",
      });
      const electronInput = { kind: "electron" };
      const cleanupInput = {
        fixtureId: "fixture-1",
        rootFingerprint: "c".repeat(64),
      };
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "test-case-revision-command-1",
        actor,
        consumerId: "desktop-test-engineer",
        command: {
          type: "test.case-revision.register" as const,
          testCaseId: "test-case-1",
          revisionId: "test-case-1-r1",
          projectId: project.id,
          manifest: {
            schemaVersion: 1 as const,
            ownerPositionId: "position-test-engineer",
            requirementIds: ["requirement-19"],
            workPackageVersions: [],
            preconditions: ["exact Integration PASS"],
            uiActions: [{ id: "action-1", kind: "click", target: "run-test" }],
            assertions: [
              {
                id: "assertion-1",
                operationId: "operation-1",
                ui: { kind: "text", expected: "passed" },
                runtime: { kind: "state", expected: "passed" },
              },
            ],
            fixture: { id: "fixture-1", scriptHashes: ["a".repeat(64)] },
            executionOperations: [
              {
                id: "operation-1",
                kind: "electron" as const,
                adapterId: "scripted-test",
                input: electronInput,
                inputHash: canonicalHash(electronInput),
              },
              {
                id: "cleanup-operation-1",
                kind: "cleanup" as const,
                adapterId: "scripted-test",
                input: cleanupInput,
                inputHash: canonicalHash(cleanupInput),
              },
            ],
            evidencePolicy: {
              retentionClass: "durable" as const,
              redactionProfile: "default",
              requiredKinds: ["ui", "runtime"],
            },
            cleanup: {
              policy: "always",
              required: true,
              operationId: "cleanup-operation-1",
              rootFingerprint: "c".repeat(64),
              targets: [
                {
                  kind: "repository" as const,
                  pathFingerprint: "d".repeat(64),
                },
                { kind: "worktree" as const, pathFingerprint: "e".repeat(64) },
              ],
            },
          },
        },
      };

      const first = database.commandRegistry.execute(envelope);
      const replay = database.commandRegistry.execute(envelope);
      assert.deepEqual(replay, first);
      assert.equal(first.status, "succeeded");
      assert.equal(first.effectIds.length, 1);
      const event = database.events
        .readAfter(0, 100)
        .find((entry) => entry.type === "test.case.revised");
      assert.equal(event?.testCaseRevisionId, "test-case-1-r1");
      assert.equal(event?.registryVersion, 16);

      const inspected = new DatabaseSync(database.path);
      try {
        assert.equal(
          Number(
            (
              inspected
                .prepare(
                  "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
                )
                .get(envelope.commandId) as { readonly count: unknown }
            ).count,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              inspected
                .prepare(
                  "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ? AND actor_id = ? AND consumer_id = ?",
                )
                .get(envelope.commandId, actor.id, envelope.consumerId) as {
                readonly count: unknown;
              }
            ).count,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              inspected
                .prepare(
                  "SELECT COUNT(*) AS count FROM runtime_unit_of_work_context",
                )
                .get() as { readonly count: unknown }
            ).count,
          ),
          0,
        );
      } finally {
        inspected.close();
      }
    } finally {
      database.close();
    }
  });

  it("persists Test defect record context and replay-safe close routing", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const clock = () => new Date("2026-07-29T00:00:00.000Z");
    const frozenProfile = { id: "profile-test-command" };
    const frozenProfileHash = createHash("sha256")
      .update(JSON.stringify(frozenProfile))
      .digest("hex");
    database
      .prepare(
        `INSERT INTO run_snapshot_revisions(
           id, run_id, revision, schema_version, canonical_json, hash, created_at
         ) VALUES (?, ?, 1, 1, ?, ?, ?)`,
      )
      .run(
        "snapshot-test-command",
        "run-test-command",
        JSON.stringify({ executionProfiles: [frozenProfile] }),
        "0".repeat(64),
        clock().toISOString(),
      );
    database.exec(`
      INSERT INTO positions(id, department_id, name, responsibility, ai_member_id, sort_order, created_at)
      VALUES ('position-test-engineer', 'software-rnd', 'Test engineer', 'Independent testing', 'tester-ai', 1, '${clock().toISOString()}');
      INSERT INTO interaction_sessions(id, mode, project_id, run_id, node_run_id, status, created_at)
      VALUES ('test-session-command', 'run-collaboration', 'project-test-command', 'run-test-command', 'test-node-command', 'active', '${clock().toISOString()}');
      INSERT INTO session_participants(id, session_id, participant_type, participant_ref, role, created_at)
      VALUES ('tester-participant-command', 'test-session-command', 'ai-member', 'tester-ai', 'test-engineer', '${clock().toISOString()}');
      INSERT INTO artifacts(id, project_id, type, logical_name, status, created_at)
      VALUES ('build-artifact-command', 'project-test-command', 'build', 'Test build', 'accepted', '${clock().toISOString()}');
      INSERT INTO artifact_versions(id, artifact_id, version, content_ref, content_hash, byte_size, status, producing_run_id, snapshot_revision_id, created_at)
      VALUES ('build-test-command', 'build-artifact-command', 1, 'artifacts/build.tar', '${"f".repeat(64)}', 42, 'accepted', 'run-test-command', 'snapshot-test-command', '${clock().toISOString()}');
      INSERT INTO artifacts(id, project_id, type, logical_name, status, created_at)
      VALUES ('resolution-artifact-command', 'project-test-command', 'test-evidence', 'Resolution evidence', 'accepted', '${clock().toISOString()}');
      INSERT INTO artifact_versions(id, artifact_id, version, content_ref, content_hash, byte_size, status, producing_run_id, snapshot_revision_id, created_at)
      VALUES ('resolution-evidence-command', 'resolution-artifact-command', 1, 'evidence/resolution.json', '${"4".repeat(64)}', 18, 'accepted', 'run-test-command', 'snapshot-test-command', '${clock().toISOString()}');
    `);
    const generation = {
      id: "generation-test-command",
      manifest: {
        schemaVersion: 1 as const,
        generationId: "generation-test-command",
        generation: 1,
        projectId: "project-test-command",
        runId: "run-test-command",
        snapshotRevisionId: "snapshot-test-command",
        nodeRunId: "integration-node-test-command",
        coverageId: "coverage-test-command",
        coverageNodeRunId: "review-node-test-command",
        coverageNodeAttemptId: "review-attempt-test-command",
        coverageHash: "a".repeat(64),
        repositories: [
          {
            repositoryReference: "repo-test-command",
            baseCommit: "1".repeat(40),
            integrationBranch: "integration/run-test-command/g1",
          },
        ],
        packages: [],
        dependencyOrder: [],
        contractVersions: [],
        integrationConditions: [],
        requiredValidations: [],
      },
      manifestHash: "b".repeat(64),
      state: "passed" as const,
      repositoryResults: [
        {
          id: "repository-result-test-command",
          repositoryReference: "repo-test-command",
          baseCommit: "1".repeat(40),
          integrationBranch: "integration/run-test-command/g1",
          state: "succeeded" as const,
          expectedTip: "1".repeat(40),
          integratedCommit: "2".repeat(40),
          validationRecords: [],
        },
      ],
      operations: [],
      defects: [],
      aggregateReview: {
        id: "aggregate-review-test-command",
        topicId: "topic-test-command",
        qualityGateResultId: "gate-test-command",
        input: {},
        inputHash: "c".repeat(64),
        result: "PASS" as const,
        evidence: ["artifact-version:test-command"],
      },
      passAuthorityHash: "d".repeat(64),
    } as IntegrationGenerationView;
    const events = openRuntimeEvents(database, { clock });
    const electronInput = { kind: "electron" };
    const cleanupInput = {
      fixtureId: "fixture-test-command",
      rootFingerprint: "2".repeat(64),
    };
    const testRuntime = openTestRuntime(database, {
      integrationAuthority: { readPassAuthority: () => generation },
      fixtureAuthority: {
        read: () => ({
          fixtureId: "fixture-test-command",
          companyDirectoryFingerprint: "2".repeat(64),
          scriptHashes: ["e".repeat(64)],
          adapterIds: ["scripted-test"],
        }),
      },
      events,
      clock,
    });
    const revision = testRuntime.registerCaseRevision({
      testCaseId: "case-test-command",
      revisionId: "case-test-command-r1",
      projectId: "project-test-command",
      manifest: {
        schemaVersion: 1,
        ownerPositionId: "position-test-engineer",
        requirementIds: [],
        workPackageVersions: [],
        preconditions: ["exact Integration PASS"],
        uiActions: [{ id: "action-1", kind: "click", target: "run-test" }],
        assertions: [
          {
            id: "assertion-1",
            operationId: "operation-1",
            ui: { kind: "text", expected: "passed" },
            runtime: { kind: "state", expected: "passed" },
          },
        ],
        fixture: { id: "fixture-test-command", scriptHashes: ["e".repeat(64)] },
        executionOperations: [
          {
            id: "operation-1",
            kind: "electron",
            adapterId: "scripted-test",
            input: electronInput,
            inputHash: canonicalHash(electronInput),
          },
          {
            id: "cleanup-operation-command",
            kind: "cleanup",
            adapterId: "scripted-test",
            input: cleanupInput,
            inputHash: canonicalHash(cleanupInput),
          },
        ],
        evidencePolicy: {
          retentionClass: "durable",
          redactionProfile: "default",
          requiredKinds: ["ui", "runtime"],
        },
        cleanup: {
          policy: "always",
          required: true,
          operationId: "cleanup-operation-command",
          rootFingerprint: "2".repeat(64),
          targets: [
            { kind: "repository", pathFingerprint: "3".repeat(64) },
            { kind: "worktree", pathFingerprint: "4".repeat(64) },
          ],
        },
      },
    });
    testRuntime.createRun({
      testRunId: "test-run-command",
      requestId: "test-run-command-request",
      projectId: "project-test-command",
      runId: "run-test-command",
      snapshotRevisionId: "snapshot-test-command",
      nodeRunId: "test-node-command",
      nodeAttemptId: "test-attempt-command",
      sessionId: "test-session-command",
      testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
      integrationAuthority: {
        generationId: generation.id,
        manifestHash: generation.manifestHash,
        passAuthorityHash: generation.passAuthorityHash!,
        repositoryCommits: [
          { repositoryReference: "repo-test-command", commit: "2".repeat(40) },
        ],
      },
      build: {
        artifactVersionId: "build-test-command",
        digest: "f".repeat(64),
      },
      executionProfile: {
        id: "profile-test-command",
        hash: frozenProfileHash,
      },
      companyDirectoryFingerprint: "2".repeat(64),
      fixture: { id: "fixture-test-command", scriptHashes: ["e".repeat(64)] },
      executionOperations: [
        {
          id: "operation-1",
          kind: "electron",
          adapterId: "scripted-test",
          input: electronInput,
          inputHash: canonicalHash(electronInput),
        },
        {
          id: "cleanup-operation-command",
          kind: "cleanup",
          adapterId: "scripted-test",
          input: cleanupInput,
          inputHash: canonicalHash(cleanupInput),
        },
      ],
      clock: { instant: clock().toISOString(), seed: "seed-test-command" },
      environment: { platform: "darwin", architecture: "arm64" },
      capabilities: ["electron", "runtime-query"],
      risk: (() => {
        const rules = [
          { factorId: "command-test", minimumTier: "medium" as const },
        ];
        const policyHash = canonicalHash({
          schemaVersion: 1,
          revisionId: "command-test-risk-r1",
          rules,
        });
        const factors = [
          {
            id: "command-test",
            present: true,
            evidenceRefs: ["test-case:case-test-command-r1"],
          },
        ];
        const evidenceRefs = ["test-case:case-test-command-r1"];
        return {
          schemaVersion: 1 as const,
          policy: {
            revisionId: "command-test-risk-r1",
            rules,
            hash: policyHash,
          },
          factors,
          computedTier: "medium" as const,
          evidenceRefs,
          inputHash: canonicalHash({
            schemaVersion: 1,
            policyRevisionId: "command-test-risk-r1",
            policyHash,
            factors,
            evidenceRefs,
          }),
        };
      })(),
    });
    const assertionCorrelation = {
      commandId: "test-run-command",
      eventSequence: 1,
      runtimeEventType: "test.run.started",
      queryAsOfSequence: 1,
      queryViewHash: "9".repeat(64),
      viewSyncTokenHash: "a".repeat(64),
      snapshotRevisionId: "snapshot-test-command",
      runId: "run-test-command",
      nodeRunId: "test-node-command",
      nodeAttemptId: "test-attempt-command",
      sessionId: "test-session-command",
      artifactVersionIds: ["resolution-evidence-command"],
    };
    const assertionResult = {
      testRunId: "test-run-command",
      operationId: "operation-1",
      testCaseRevisionId: revision.id,
      assertionId: "assertion-1",
      required: true,
      uiStatus: "failed",
      runtimeStatus: "passed",
      correlation: assertionCorrelation,
    };
    const assertionResultHash = canonicalHash(assertionResult);
    const operationStorageId = `test-execution:${canonicalHash({
      testRunId: "test-run-command",
      operationId: "operation-1",
    })}`;
    database
      .prepare(
        `INSERT INTO test_execution_operations(
           id, test_run_id, operation_key, request_json, request_hash, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
      )
      .run(
        operationStorageId,
        "test-run-command",
        "test:test-run-command:operation-1:fixture",
        JSON.stringify({
          operationId: "operation-1",
          operationKey: "test:test-run-command:operation-1:fixture",
          testRunId: "test-run-command",
          requestHash: "8".repeat(64),
          input: electronInput,
        }),
        "8".repeat(64),
        clock().toISOString(),
        clock().toISOString(),
      );
    database
      .prepare(
        `INSERT INTO test_assertion_results(
           id, test_run_id, operation_id, test_case_revision_id, assertion_id,
           required, ui_status, runtime_status, correlation_json, result_hash,
           created_at
         ) VALUES (?, ?, ?, ?, ?, 1, 'failed', 'passed', ?, ?, ?)`,
      )
      .run(
        "assertion-result-command",
        "test-run-command",
        operationStorageId,
        revision.id,
        "assertion-1",
        JSON.stringify(assertionCorrelation),
        assertionResultHash,
        clock().toISOString(),
      );
    database
      .prepare(
        `INSERT INTO test_evidence(
           id, test_run_id, operation_id, test_case_revision_id, assertion_id,
           kind, media_type, content_hash, byte_size, artifact_version_id,
           redaction_profile, retention_class, locator, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "resolution-evidence-command",
        "test-run-command",
        operationStorageId,
        revision.id,
        "assertion-1",
        "runtime",
        "application/json",
        "4".repeat(64),
        18,
        "resolution-evidence-command",
        "default",
        "durable",
        "evidence/resolution.json",
        "{}",
        clock().toISOString(),
      );
    const commandTestRuntime = {
      ...testRuntime,
      closeDefect: () => ({
        ...testRuntime.inspect("test-run-command"),
        defects: testRuntime
          .inspect("test-run-command")
          .defects.map((defect) => ({
            ...defect,
            status: "closed" as const,
            closedAt: clock().toISOString(),
          })),
      }),
    } as unknown as typeof testRuntime;
    const preparedRun = testRuntime.inspect("test-run-command");
    assert.equal(preparedRun.assertions[0]?.resultHash, assertionResultHash);
    assert.equal(preparedRun.evidence[0]?.id, "resolution-evidence-command");
    const registry = openCompanyCommandRegistry(
      database,
      openProjectConfiguration(database),
      undefined,
      clock,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      commandTestRuntime,
    );
    const record = {
      schemaVersion: 1 as const,
      commandId: "test-defect-record-command",
      actor,
      consumerId: "desktop-test-engineer",
      command: {
        type: "test.defect.record" as const,
        id: "test-defect-command",
        testRunId: "test-run-command",
        testCaseRevisionId: revision.id,
        assertionId: "assertion-1",
        responsibility: {
          kind: "ui-runtime-contract" as const,
          owner: "shared" as const,
        },
        evidence: {
          schemaVersion: 1 as const,
          kind: "assertion" as const,
          assertion: {
            testCaseRevisionId: revision.id,
            assertionId: "assertion-1",
            resultHash: assertionResultHash,
          },
          evidenceRefs: ["resolution-evidence-command"],
        },
      },
    };
    const recorded = registry.execute(record);
    assert.deepEqual(registry.execute(record), recorded);
    assert.equal(recorded.status, "succeeded", JSON.stringify(recorded));
    if (recorded.status !== "succeeded") assert.fail("record command failed");
    assert.equal(
      (
        (
          recorded.value as {
            readonly defects: readonly { readonly status: string }[];
          }
        ).defects[0] as { readonly status: string } | undefined
      )?.status,
      "open",
    );
    const conflictingRecord = registry.execute({
      ...record,
      command: {
        ...record.command,
        evidence: {
          ...record.command.evidence,
          evidenceRefs: ["artifact-version:changed"],
        },
      },
    });
    assert.equal(conflictingRecord.status, "rejected");
    if (conflictingRecord.status === "rejected") {
      assert.equal(conflictingRecord.error.code, "COMMAND_ID_REUSE");
    }

    const close = {
      schemaVersion: 1 as const,
      commandId: "test-defect-close-command",
      actor,
      consumerId: "desktop-test-engineer",
      command: {
        type: "test.defect.close" as const,
        defectId: "test-defect-command",
        resolutionId: "test-defect-resolution-command",
        resolution: {
          schemaVersion: 1 as const,
          resolvedByTestRunId: "fresh-pass-test-run-command",
          passAuthorityHash: "5".repeat(64),
          assertions: [
            {
              testCaseRevisionId: revision.id,
              assertionId: "assertion-1",
              resultHash: "6".repeat(64),
              evidenceRefs: ["fresh-pass-evidence-command"],
            },
          ],
        },
      },
    };
    const closed = registry.execute(close);
    assert.deepEqual(registry.execute(close), closed);
    assert.equal(closed.status, "succeeded");
    if (closed.status !== "succeeded") assert.fail("close command failed");
    assert.equal(
      (
        (
          closed.value as {
            readonly defects: readonly { readonly status: string }[];
          }
        ).defects[0] as { readonly status: string } | undefined
      )?.status,
      "closed",
    );
    const conflictingClose = registry.execute({
      ...close,
      command: {
        ...close.command,
        resolution: {
          ...close.command.resolution,
          passAuthorityHash: "7".repeat(64),
        },
      },
    });
    assert.equal(conflictingClose.status, "rejected");
    if (conflictingClose.status === "rejected") {
      assert.equal(conflictingClose.error.code, "COMMAND_ID_REUSE");
    }

    assert.equal(
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ? AND actor_id = ? AND consumer_id = ?",
            )
            .get(record.commandId, actor.id, "desktop-test-engineer") as {
            readonly count: unknown;
          }
        ).count,
      ),
      1,
    );
    for (const commandId of [record.commandId, close.commandId]) {
      assert.equal(
        Number(
          (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
              )
              .get(commandId) as { readonly count: unknown }
          ).count,
        ),
        1,
      );
    }
    assert.equal(
      events
        .readAfter(0, 100)
        .filter((event) => event.type.startsWith("test.defect.")).length,
      1,
    );
    assert.equal(
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_unit_of_work_context",
            )
            .get() as { readonly count: unknown }
        ).count,
      ),
      0,
    );
    database.close();
  });

  it("replays Integration Commands and rejects changed input under the same Command ID", () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    const projectConfiguration = openProjectConfiguration(database);
    let dispatchCount = 0;
    const integrationRuntime = {
      dispatchInTransaction: (input: {
        readonly command: { readonly generationId: string };
      }) => {
        dispatchCount += 1;
        return {
          id: input.command.generationId,
          manifest: {
            schemaVersion: 1,
            generationId: input.command.generationId,
            generation: 1,
            projectId: "project-1",
            runId: "run-1",
            snapshotRevisionId: "snapshot-1",
            nodeRunId: "integration-node-1",
            coverageId: "coverage-1",
            coverageNodeRunId: "code-review-node-1",
            coverageNodeAttemptId: "code-review-attempt-1",
            coverageHash: "a".repeat(64),
            repositories: [],
            packages: [],
            dependencyOrder: [],
            contractVersions: [],
            integrationConditions: [],
            requiredValidations: [],
          },
          manifestHash: "b".repeat(64),
          state: "pending",
          repositoryResults: [],
          operations: [],
          defects: [],
          aggregateReview: null,
          passAuthorityHash: null,
        };
      },
    } as unknown as IntegrationRuntime;
    const registry = openCompanyCommandRegistry(
      database,
      projectConfiguration,
      undefined,
      () => new Date("2026-07-28T00:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      integrationRuntime,
    );
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "integration-command-1",
      actor: {
        type: "runtime-worker" as const,
        id: "integration-node-handler",
        authenticatedBy: "runtime" as const,
      },
      consumerId: "integration-node-handler",
      command: {
        type: "integration.generation.start" as const,
        generationId: "generation-1",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    };

    const first = registry.execute(envelope);
    const replay = registry.execute(envelope);
    const changed = registry.execute({
      ...envelope,
      command: { ...envelope.command, generationId: "generation-2" },
    });

    assert.deepEqual(replay, first);
    assert.equal(dispatchCount, 1);
    assert.equal(changed.status, "rejected");
    if (changed.status === "rejected") {
      assert.equal(changed.error.code, "COMMAND_ID_REUSE");
    }
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM runtime_unit_of_work_context")
          .get() as { readonly count: number }
      ).count,
      0,
    );
    const storedReceipt = database
      .prepare(
        `SELECT result_json AS resultJson, result_hash AS resultHash,
                effect_ids_json AS effectIdsJson
           FROM command_deduplication
          WHERE command_id = ?`,
      )
      .get(envelope.commandId) as {
      readonly resultJson: string;
      readonly resultHash: string;
      readonly effectIdsJson: string;
    };
    database
      .prepare(
        "UPDATE command_deduplication SET result_json = ? WHERE command_id = ?",
      )
      .run(
        JSON.stringify({
          status: "rejected",
          error: { code: "TAMPERED", message: "tampered" },
          effectIds: [],
        }),
        envelope.commandId,
      );
    assert.throws(
      () => registry.execute(envelope),
      (error) =>
        error instanceof CompanyCommandError &&
        error.code === "COMMAND_RECEIPT_INVALID",
    );
    database
      .prepare(
        `UPDATE command_deduplication
            SET result_json = ?, result_hash = ?
          WHERE command_id = ?`,
      )
      .run(storedReceipt.resultJson, "c".repeat(64), envelope.commandId);
    assert.throws(
      () => registry.execute(envelope),
      (error) =>
        error instanceof CompanyCommandError &&
        error.code === "COMMAND_RECEIPT_INVALID",
    );
    database
      .prepare(
        `UPDATE command_deduplication
            SET result_hash = ?, effect_ids_json = ?
          WHERE command_id = ?`,
      )
      .run(storedReceipt.resultHash, '["tampered-effect"]', envelope.commandId);
    assert.throws(
      () => registry.execute(envelope),
      (error) =>
        error instanceof CompanyCommandError &&
        error.code === "COMMAND_RECEIPT_INVALID",
    );
    database.close();
  });

  it("persists validation audit, event, receipt, and effectIds atomically and replays without duplicates", async () => {
    const database = new DatabaseSync(":memory:");
    migrateCompanyDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO department_runs(
           id, project_id, department_id, status, created_at,
           snapshot_revision_id, revision, updated_at
         ) VALUES ('run-1', 'project-1', 'department-1', 'running', ?,
                   'snapshot-1', 0, ?)`,
      )
      .run(clock().toISOString(), clock().toISOString());
    const events = openRuntimeEvents(database, { clock });
    const integrationRuntime = openIntegrationRuntime(database, {
      events,
      codeReviews: {
        readCompletedCoverage: () => ({
          coverageId: "coverage-1",
          coverageHash: "a".repeat(64),
          projectId: "project-1",
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          nodeRunId: "code-review-node-1",
          nodeAttemptId: "code-review-attempt-1",
          packages: [
            {
              workPackageId: "package-1",
              workPackageVersionId: "package-v1",
              applicationId: "application-1",
              repositoryReference: "/repositories/api",
              baseCommit: "1".repeat(40),
              sourceBranch: "work/package-1",
              sourceCommit: "2".repeat(40),
              diffHash: "b".repeat(64),
              authorityId: "authority-1",
              qualityGateResultId: "gate-1",
              reviewContext: {
                codeReviewManifestId: "code-review-1",
                codeReviewManifestHash: "c".repeat(64),
                diffArtifactVersionId: "diff-1",
                specRevisionIds: ["spec-1"],
                harnessSnapshotIds: ["harness-1"],
                acceptanceCriteria: ["The API remains correct."],
                selfCheckEvidenceRefs: ["self-check-1"],
              },
              dependencies: [],
              contractVersions: [],
              integrationConditions: ["npm test"],
            },
          ],
        }),
      },
      pipelineRuntime: {
        startIntegrationInTransaction: () => undefined,
        blockIntegrationInTransaction: () => undefined,
        failIntegrationInTransaction: () => undefined,
        requeueIntegrationRecoveryInTransaction: () => undefined,
        completeIntegrationInTransaction: () => undefined,
      },
      gitAdapter: {
        execute: (input) => ({
          status: "succeeded",
          beforeTip: input.expectedTip,
          afterTip: input.sourceCommit,
          resultingCommit: input.sourceCommit,
          receipt: { operationId: input.operationId },
        }),
        reconcile: () => ({ status: "not-applied" }),
      },
      clock,
    });
    const registry = openCompanyCommandRegistry(
      database,
      openProjectConfiguration(database),
      undefined,
      clock,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      integrationRuntime,
    );
    const runtimeActor = {
      type: "runtime-worker" as const,
      id: "integration-node-handler",
      authenticatedBy: "runtime" as const,
    };
    const started = registry.execute({
      schemaVersion: 1,
      commandId: "integration-start-real",
      actor: runtimeActor,
      consumerId: "integration-node-handler",
      command: {
        type: "integration.generation.start",
        generationId: "generation-real",
        runId: "run-1",
        nodeRunId: "integration-node-1",
      },
    });
    assert.equal(started.status, "succeeded", JSON.stringify(started));
    await integrationRuntime.executePending("generation-real");
    const validationId =
      integrationRuntime.inspect("run-1")[0]!.manifest.requiredValidations[0]!
        .id;
    const envelope = {
      schemaVersion: 1 as const,
      commandId: "integration-validation-real",
      actor: runtimeActor,
      consumerId: "integration-node-handler",
      command: {
        type: "integration.validation.record" as const,
        generationId: "generation-real",
        validationId,
        repositoryReference: "/repositories/api",
        status: "passed" as const,
        kind: "build-test" as const,
        evidenceRefs: ["build-log"],
        responsibleWorkPackageVersionIds: [],
      },
    };
    const first = registry.execute(envelope);
    const replay = registry.execute(envelope);
    assert.deepEqual(replay, first);
    assert.equal(first.status, "succeeded");
    assert.equal(first.effectIds.length, 2);
    assert.equal(
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
            )
            .get(envelope.commandId) as { readonly count: number }
        ).count,
      ),
      2,
    );
    assert.equal(
      events
        .readAfter(0, 100)
        .filter((event) => event.type === "integration.validation.recorded")
        .length,
      1,
    );
    assert.equal(
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
            )
            .get(envelope.commandId) as { readonly count: number }
        ).count,
      ),
      1,
    );
    database.close();
  });

  it("persists an idempotent ACP Permission decision, receipt, and registry-valid events in one unit of work", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const session = database.interaction.createSession({
        projectId: project.id,
        mode: "consultation",
      });
      const permission = database.interaction.requestPermission({
        sessionId: session.id,
        scope: "repository.write",
      });
      const envelope = {
        schemaVersion: 1 as const,
        commandId: "acp:editor-1:permission:event-permission-1",
        actor: {
          type: "acp-client" as const,
          id: "editor-1",
          authenticatedBy: "acp-connection" as const,
        },
        consumerId: "acp:editor-1",
        command: {
          type: "permission.decide" as const,
          permissionId: permission.id,
          expectedStatus: "pending" as const,
          decision: "denied" as const,
        },
      };

      const first = database.commandRegistry.execute(envelope);
      const replay = database.commandRegistry.execute(envelope);

      assert.deepEqual(replay, first);
      assert.equal(first.status, "succeeded");
      assert.equal(first.value.status, "denied");
      assert.equal(first.value.decisionCommandId, envelope.commandId);
      const events = database.events
        .readAfter(0, 100)
        .filter((event) => event.type.startsWith("permission."));
      assert.deepEqual(
        events.map((event) => ({
          type: event.type,
          registryVersion: event.registryVersion,
          projectId: event.projectId,
          sessionId: event.sessionId,
          permissionRequestId: event.permissionRequestId,
        })),
        [
          {
            type: "permission.requested",
            registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
            projectId: project.id,
            sessionId: session.id,
            permissionRequestId: permission.id,
          },
          {
            type: "permission.decided",
            registryVersion: RUNTIME_EVENT_REGISTRY_VERSION,
            projectId: project.id,
            sessionId: session.id,
            permissionRequestId: permission.id,
          },
        ],
      );

      const inspected = new DatabaseSync(database.path);
      try {
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
              )
              .get(envelope.commandId) as { readonly count: number }
          ).count,
          1,
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM runtime_unit_of_work_context",
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
      } finally {
        inspected.close();
      }
    } finally {
      database.close();
    }
  });

  it("replays a completed project.update before checking the current revision", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const envelope: CommandEnvelope = {
        schemaVersion: 1,
        commandId: "command-project-update-1",
        actor,
        consumerId: "desktop-test",
        expectedRevision: 0,
        command: {
          type: "project.update",
          projectId: project.id,
          name: "Checkout Platform",
          goal: "Ship resilient checkout",
          sharedContext: "Preserve payment contracts.",
          repositoryReferences: ["/work/checkout"],
        },
      };

      const first = database.commandRegistry.execute(envelope);
      const replay = database.commandRegistry.execute(envelope);

      assert.deepEqual(replay, first);
      assert.equal(first.status, "succeeded");
      assert.equal(first.value.revision, 1);
      assert.equal(first.effectIds.length, 1);
      assert.equal(
        database.projectConfiguration.inspect(project.id).revision,
        1,
      );

      const inspected = new DatabaseSync(database.path);
      try {
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
              )
              .get(envelope.commandId) as { readonly count: number }
          ).count,
          1,
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ? AND actor_id = ?",
              )
              .get(envelope.commandId, actor.id) as { readonly count: number }
          ).count,
          1,
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM runtime_unit_of_work_context",
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
      } finally {
        inspected.close();
      }
    } finally {
      database.close();
    }
  });

  it("rejects command ID reuse when any canonical input differs", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const envelope: CommandEnvelope = {
        schemaVersion: 1,
        commandId: "command-project-update-reused",
        actor,
        consumerId: "desktop-test",
        expectedRevision: 0,
        command: {
          type: "project.update",
          projectId: project.id,
          name: "Checkout Platform",
          goal: "Ship resilient checkout",
          sharedContext: "",
          repositoryReferences: [],
        },
      };
      assert.equal(
        database.commandRegistry.execute(envelope).status,
        "succeeded",
      );

      const reused = database.commandRegistry.execute({
        ...envelope,
        command: { ...envelope.command, name: "Conflicting input" },
      });

      assert.deepEqual(reused, {
        status: "rejected",
        error: {
          code: "COMMAND_ID_REUSE",
          message:
            "Command command-project-update-reused was already used for a different request.",
        },
        effectIds: [],
      });
      assert.equal(
        database.projectConfiguration.inspect(project.id).name,
        "Checkout Platform",
      );
      assert.throws(
        () =>
          database.commandRegistry.execute({
            ...envelope,
            commandId: "command-with-untrusted-business-identity",
            command: {
              ...envelope.command,
              actor: {
                type: "human",
                id: "payload-claim",
                authenticatedBy: "local-session",
              },
              consumerId: "payload-consumer",
            },
          } as CommandEnvelope),
        /unrecognized key/i,
      );
    } finally {
      database.close();
    }
  });

  it("persists deterministic revision rejection and rolls back every write on receipt failure", () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const stale: CommandEnvelope = {
        schemaVersion: 1,
        commandId: "command-project-update-stale",
        actor,
        consumerId: "desktop-test",
        expectedRevision: 7,
        command: {
          type: "project.update",
          projectId: project.id,
          name: "Never applied",
          goal: "Never applied",
          sharedContext: "",
          repositoryReferences: [],
        },
      };
      const rejected = database.commandRegistry.execute(stale);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.error.code, "VERSION_CONFLICT");
      assert.deepEqual(database.commandRegistry.execute(stale), rejected);

      const inspected = new DatabaseSync(database.path);
      try {
        inspected.exec(`
          CREATE TRIGGER fail_command_receipt
          BEFORE INSERT ON command_deduplication
          BEGIN
            SELECT RAISE(ABORT, 'injected receipt failure');
          END;
        `);
      } finally {
        inspected.close();
      }

      assert.throws(
        () =>
          database.commandRegistry.execute({
            ...stale,
            commandId: "command-project-update-rollback",
            expectedRevision: 0,
            command: { ...stale.command, name: "Must roll back" },
          }),
        /injected receipt failure/,
      );
      assert.equal(
        database.projectConfiguration.inspect(project.id).revision,
        0,
      );

      const verified = new DatabaseSync(database.path);
      try {
        assert.equal(
          (
            verified
              .prepare(
                "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
              )
              .get("command-project-update-rollback") as {
              readonly count: number;
            }
          ).count,
          0,
        );
        assert.equal(
          (
            verified
              .prepare(
                "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
              )
              .get("command-project-update-rollback") as {
              readonly count: number;
            }
          ).count,
          0,
        );
        assert.equal(
          (
            verified
              .prepare(
                "SELECT COUNT(*) AS count FROM runtime_unit_of_work_context",
              )
              .get() as { readonly count: number }
          ).count,
          0,
        );
      } finally {
        verified.close();
      }
    } finally {
      database.close();
    }
  });

  it("replays a completed receipt after restart and retries STORE_BUSY with the same command ID", () => {
    const companyDir = tempCompanyDir();
    const firstDatabase = openCompanyDatabase(companyDir);
    const project = firstDatabase.catalog.createProject({
      name: "Checkout",
      goal: "Ship checkout",
    });
    const envelope: CommandEnvelope = {
      schemaVersion: 1,
      commandId: "command-project-update-restart",
      actor,
      consumerId: "desktop-test",
      expectedRevision: 0,
      command: {
        type: "project.update",
        projectId: project.id,
        name: "Checkout Platform",
        goal: "Ship resilient checkout",
        sharedContext: "",
        repositoryReferences: [],
      },
    };
    const completed = firstDatabase.commandRegistry.execute(envelope);
    const databasePath = firstDatabase.path;
    firstDatabase.close();

    const restarted = openCompanyDatabase(companyDir);
    try {
      assert.deepEqual(restarted.commandRegistry.execute(envelope), completed);
    } finally {
      restarted.close();
    }

    const executor = new DatabaseSync(databasePath);
    executor.exec("PRAGMA busy_timeout = 1");
    const registry = openCompanyCommandRegistry(
      executor,
      openProjectConfiguration(executor),
    );
    const lockHolder = new DatabaseSync(databasePath);
    lockHolder.exec("BEGIN IMMEDIATE");
    const busyEnvelope = {
      ...envelope,
      commandId: "command-project-update-busy",
      expectedRevision: 1,
      command: { ...envelope.command, name: "Checkout Runtime" },
    };
    try {
      assert.throws(
        () => registry.execute(busyEnvelope),
        (error: unknown) =>
          error instanceof CompanyCommandError && error.code === "STORE_BUSY",
      );
    } finally {
      lockHolder.exec("ROLLBACK");
      lockHolder.close();
    }
    try {
      const retried = registry.execute(busyEnvelope);
      assert.equal(retried.status, "succeeded");
      assert.equal(retried.value.revision, 2);
    } finally {
      executor.close();
    }
  });
});
