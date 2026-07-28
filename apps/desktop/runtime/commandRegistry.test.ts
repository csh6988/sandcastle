import assert from "node:assert/strict";
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
import type { IntegrationRuntime } from "./integration/integrationRuntime.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-command-registry-"));

const actor = {
  type: "test-driver" as const,
  id: "command-registry-test",
  authenticatedBy: "ipc-token" as const,
};

describe("Company Runtime command registry", () => {
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
