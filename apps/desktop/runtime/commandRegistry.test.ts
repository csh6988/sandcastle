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

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-command-registry-"));

const actor = {
  type: "test-driver" as const,
  id: "command-registry-test",
  authenticatedBy: "ipc-token" as const,
};

describe("Company Runtime command registry", () => {
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
