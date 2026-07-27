import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ActorRef } from "../interface.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ProjectConfiguration } from "../project/projectConfiguration.js";
import {
  LocalIsolatedGitError,
  type LocalIsolatedGitImportReceipt,
  type LocalIsolatedGitProfile,
  type LocalIsolatedGitProvisionReceipt,
} from "./localIsolatedGitProfile.js";

export type WorkspaceAllocationState =
  | "planned"
  | "provisioning"
  | "ready"
  | "failed"
  | "cleanup-pending"
  | "cleaned";

export interface WorkspaceAllocationView {
  readonly id: string;
  readonly projectId: string;
  readonly applicationId: string;
  readonly executionProfileId: string;
  readonly executionProfileRevision: number;
  readonly operationKey: string;
  readonly state: WorkspaceAllocationState;
  readonly repositoryRoot: string;
  readonly allocationRoot: string;
  readonly sourceBranch: string;
  readonly baseCommit: string;
  readonly expectedSourceTip: string;
  readonly capabilitySnapshot: unknown;
  readonly capabilitySnapshotHash: string;
  readonly privateGitIdentity: unknown | null;
  readonly provisionReceipt: unknown | null;
  readonly cleanupEvidence: unknown | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly revision: number;
  readonly imports: readonly WorkspaceImportView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceImportView {
  readonly id: string;
  readonly allocationId: string;
  readonly state: "intent" | "running" | "succeeded" | "failed" | "unknown";
  readonly expectedSourceTip: string;
  readonly beforeSourceTip: string;
  readonly resultCommit: string;
  readonly objectSetHash: string | null;
  readonly receipt: LocalIsolatedGitImportReceipt | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class WorkspaceRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRuntimeError";
  }
}

export interface WorkspaceRuntime {
  readonly inspect: (allocationId: string) => WorkspaceAllocationView;
  readonly planProvisionInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly allocationId: string;
    readonly projectId: string;
    readonly applicationId: string;
    readonly executionProfileId: string;
    readonly sourceBranch: string;
    readonly baseCommit: string;
    readonly expectedSourceTip: string;
  }) => WorkspaceAllocationView;
  readonly executeProvision: (allocationId: string) => WorkspaceAllocationView;
  readonly planImportInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly allocationId: string;
    readonly resultCommit: string;
    readonly expectedSourceTip: string;
  }) => WorkspaceAllocationView;
  readonly executeImport: (importId: string) => WorkspaceAllocationView;
  readonly planCleanupInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly allocationId: string;
  }) => WorkspaceAllocationView;
  readonly executeCleanup: (allocationId: string) => WorkspaceAllocationView;
  readonly reconcile: () => void;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const parseJson = (value: string | null): unknown | null =>
  value === null ? null : (JSON.parse(value) as unknown);

const assertRuntimeActor = (actor: ActorRef): void => {
  if (actor.type !== "runtime-worker" || actor.authenticatedBy !== "runtime") {
    throw new WorkspaceRuntimeError(
      "WORKSPACE_ACTOR_INVALID",
      "Workspace operations require an authenticated Runtime worker.",
    );
  }
};

export const openWorkspaceRuntime = (
  database: DatabaseSync,
  options: {
    readonly projectConfiguration: Pick<
      ProjectConfiguration,
      "resolveFormalExecutionProfile"
    >;
    readonly profile: LocalIsolatedGitProfile;
    readonly events: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): WorkspaceRuntime => {
  const clock = options.clock ?? (() => new Date());

  const readImport = (row: Record<string, unknown>): WorkspaceImportView => ({
    id: String(row.id),
    allocationId: String(row.allocationId),
    state: row.state as WorkspaceImportView["state"],
    expectedSourceTip: String(row.expectedSourceTip),
    beforeSourceTip: String(row.beforeSourceTip),
    resultCommit: String(row.resultCommit),
    objectSetHash:
      row.objectSetHash === null ? null : String(row.objectSetHash),
    receipt: parseJson(
      row.receiptJson === null ? null : String(row.receiptJson),
    ) as LocalIsolatedGitImportReceipt | null,
    failure:
      row.failureCode === null
        ? null
        : {
            code: String(row.failureCode),
            message: String(row.failureMessage),
          },
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  });

  const inspect = (allocationId: string): WorkspaceAllocationView => {
    const row = database
      .prepare(
        `SELECT id, project_id AS projectId, application_id AS applicationId,
                execution_profile_id AS executionProfileId,
                execution_profile_revision AS executionProfileRevision,
                operation_key AS operationKey, state,
                repository_root AS repositoryRoot,
                allocation_root AS allocationRoot,
                source_branch AS sourceBranch, base_commit AS baseCommit,
                expected_source_tip AS expectedSourceTip,
                capability_snapshot_json AS capabilitySnapshotJson,
                capability_snapshot_hash AS capabilitySnapshotHash,
                private_git_identity_json AS privateGitIdentityJson,
                provision_receipt_json AS provisionReceiptJson,
                cleanup_evidence_json AS cleanupEvidenceJson,
                failure_code AS failureCode, failure_message AS failureMessage,
                revision, created_at AS createdAt, updated_at AS updatedAt
           FROM workspace_allocations WHERE id = ?`,
      )
      .get(allocationId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_ALLOCATION_NOT_FOUND",
        `Workspace Allocation ${allocationId} was not found.`,
      );
    }
    const imports = (
      database
        .prepare(
          `SELECT id, allocation_id AS allocationId, state,
                  expected_source_tip AS expectedSourceTip,
                  before_source_tip AS beforeSourceTip,
                  result_commit AS resultCommit,
                  object_set_hash AS objectSetHash,
                  receipt_json AS receiptJson, failure_code AS failureCode,
                  failure_message AS failureMessage,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM workspace_imports WHERE allocation_id = ?
         ORDER BY created_at, id`,
        )
        .all(allocationId) as Array<Record<string, unknown>>
    ).map(readImport);
    return {
      id: String(row.id),
      projectId: String(row.projectId),
      applicationId: String(row.applicationId),
      executionProfileId: String(row.executionProfileId),
      executionProfileRevision: Number(row.executionProfileRevision),
      operationKey: String(row.operationKey),
      state: row.state as WorkspaceAllocationState,
      repositoryRoot: String(row.repositoryRoot),
      allocationRoot: String(row.allocationRoot),
      sourceBranch: String(row.sourceBranch),
      baseCommit: String(row.baseCommit),
      expectedSourceTip: String(row.expectedSourceTip),
      capabilitySnapshot: JSON.parse(String(row.capabilitySnapshotJson)),
      capabilitySnapshotHash: String(row.capabilitySnapshotHash),
      privateGitIdentity: parseJson(
        row.privateGitIdentityJson === null
          ? null
          : String(row.privateGitIdentityJson),
      ),
      provisionReceipt: parseJson(
        row.provisionReceiptJson === null
          ? null
          : String(row.provisionReceiptJson),
      ),
      cleanupEvidence: parseJson(
        row.cleanupEvidenceJson === null
          ? null
          : String(row.cleanupEvidenceJson),
      ),
      failure:
        row.failureCode === null
          ? null
          : {
              code: String(row.failureCode),
              message: String(row.failureMessage),
            },
      revision: Number(row.revision),
      imports,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  };

  const appendAudit = (input: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly projectId: string;
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly before: unknown;
    readonly after: unknown;
    readonly now: string;
  }): string => {
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        id,
        input.action,
        input.entityType,
        input.entityId,
        canonicalJson(input.before),
        canonicalJson(input.after),
        input.now,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    return id;
  };

  const planProvisionInTransaction: WorkspaceRuntime["planProvisionInTransaction"] =
    (input) => {
      assertRuntimeActor(input.actor);
      if (input.expectedRevision !== 0) {
        throw new WorkspaceRuntimeError(
          "VERSION_CONFLICT",
          "A new Workspace Allocation requires expectedRevision 0.",
        );
      }
      const application = database
        .prepare(
          `SELECT project_id AS projectId,
                  repository_reference AS repositoryRoot
             FROM application_references WHERE id = ?`,
        )
        .get(input.applicationId) as
        | { readonly projectId: string; readonly repositoryRoot: string }
        | undefined;
      if (!application || application.projectId !== input.projectId) {
        throw new WorkspaceRuntimeError(
          "APPLICATION_NOT_FOUND",
          `Application ${input.applicationId} is not registered in Project ${input.projectId}.`,
        );
      }
      const profile =
        options.projectConfiguration.resolveFormalExecutionProfile(
          input.executionProfileId,
        );
      const capabilitySnapshot = {
        ...profile.capabilities,
        executionProfileId: profile.executionProfileId,
        executionProfileRevision: profile.executionProfileRevision,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
      };
      const capabilitySnapshotJson = canonicalJson(capabilitySnapshot);
      const now = clock().toISOString();
      const allocationRoot = join(
        application.repositoryRoot,
        ".sandcastle",
        "workspace-allocations",
        input.allocationId,
      );
      database
        .prepare(
          `INSERT INTO workspace_allocations(
             id, project_id, application_id, execution_profile_id,
             execution_profile_revision, operation_key, state,
             repository_root, allocation_root, source_branch, base_commit,
             expected_source_tip, capability_snapshot_json,
             capability_snapshot_hash, provision_command_id,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          input.allocationId,
          input.projectId,
          input.applicationId,
          profile.executionProfileId,
          profile.executionProfileRevision,
          `workspace-allocation:${input.allocationId}`,
          application.repositoryRoot,
          allocationRoot,
          input.sourceBranch,
          input.baseCommit,
          input.expectedSourceTip,
          capabilitySnapshotJson,
          sha256(capabilitySnapshotJson),
          input.commandId,
          now,
          now,
        );
      appendAudit({
        action: "workspace-allocation.planned",
        entityType: "workspace-allocation",
        entityId: input.allocationId,
        projectId: input.projectId,
        commandId: input.commandId,
        actor: input.actor,
        before: null,
        after: { state: "planned", capabilitySnapshot },
        now,
      });
      options.events.append({
        type: "workspace-allocation.planned",
        scope: {
          companyId: "company",
          projectId: input.projectId,
          applicationId: input.applicationId,
          workspaceAllocationId: input.allocationId,
          commandId: input.commandId,
        },
        payload: {
          allocationId: input.allocationId,
          state: "planned",
          sourceBranch: input.sourceBranch,
          baseCommit: input.baseCommit,
          expectedSourceTip: input.expectedSourceTip,
          capabilitySnapshotHash: sha256(capabilitySnapshotJson),
        },
        timestamp: now,
      });
      return inspect(input.allocationId);
    };

  const internalTransaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const finishAllocation = (
    allocation: WorkspaceAllocationView,
    result:
      | {
          readonly kind: "ready";
          readonly receipt: LocalIsolatedGitProvisionReceipt;
        }
      | {
          readonly kind: "failed";
          readonly code: string;
          readonly message: string;
        },
  ): WorkspaceAllocationView =>
    internalTransaction(() => {
      const now = clock().toISOString();
      const actor: ActorRef = {
        type: "runtime-worker",
        id: "workspace-runtime",
        authenticatedBy: "runtime",
      };
      if (result.kind === "ready") {
        database
          .prepare(
            `UPDATE workspace_allocations
                SET state = 'ready', private_git_identity_json = ?,
                    provision_receipt_json = ?, failure_code = NULL,
                    failure_message = NULL, revision = revision + 1,
                    updated_at = ? WHERE id = ?`,
          )
          .run(
            canonicalJson(result.receipt.privateGitIdentity),
            canonicalJson(result.receipt),
            now,
            allocation.id,
          );
        appendAudit({
          action: "workspace-allocation.ready",
          entityType: "workspace-allocation",
          entityId: allocation.id,
          projectId: allocation.projectId,
          commandId: allocation.operationKey,
          actor,
          before: { state: allocation.state },
          after: {
            state: "ready",
            privateGitIdentity: result.receipt.privateGitIdentity,
          },
          now,
        });
        options.events.append({
          type: "workspace-allocation.ready",
          scope: {
            companyId: "company",
            projectId: allocation.projectId,
            applicationId: allocation.applicationId,
            workspaceAllocationId: allocation.id,
          },
          payload: {
            allocationId: allocation.id,
            state: "ready",
            sourceBranch: allocation.sourceBranch,
            baseCommit: allocation.baseCommit,
            expectedSourceTip: allocation.expectedSourceTip,
            privateGitIdentity: result.receipt.privateGitIdentity,
          },
          timestamp: now,
        });
      } else {
        database
          .prepare(
            `UPDATE workspace_allocations
                SET state = 'failed', failure_code = ?, failure_message = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?`,
          )
          .run(result.code, result.message, now, allocation.id);
        appendAudit({
          action: "workspace-allocation.failed",
          entityType: "workspace-allocation",
          entityId: allocation.id,
          projectId: allocation.projectId,
          commandId: allocation.operationKey,
          actor,
          before: { state: allocation.state },
          after: { state: "failed", code: result.code },
          now,
        });
        options.events.append({
          type: "workspace-allocation.failed",
          scope: {
            companyId: "company",
            projectId: allocation.projectId,
            applicationId: allocation.applicationId,
            workspaceAllocationId: allocation.id,
          },
          payload: {
            allocationId: allocation.id,
            state: "failed",
            sourceBranch: allocation.sourceBranch,
            baseCommit: allocation.baseCommit,
            expectedSourceTip: allocation.expectedSourceTip,
            failureCode: result.code,
          },
          timestamp: now,
        });
      }
      return inspect(allocation.id);
    });

  const executeProvision = (allocationId: string): WorkspaceAllocationView => {
    const allocation = inspect(allocationId);
    if (allocation.state === "ready") return allocation;
    if (allocation.state !== "planned" && allocation.state !== "provisioning") {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_ALLOCATION_STATE_INVALID",
        `Workspace Allocation ${allocationId} cannot be provisioned from ${allocation.state}.`,
      );
    }
    internalTransaction(() => {
      database
        .prepare(
          "UPDATE workspace_allocations SET state = 'provisioning', updated_at = ? WHERE id = ?",
        )
        .run(clock().toISOString(), allocationId);
    });
    try {
      mkdirSync(allocation.allocationRoot, { recursive: true });
      const receipt = options.profile.provision({
        allocationId: allocation.id,
        repositoryRoot: allocation.repositoryRoot,
        allocationRoot: allocation.allocationRoot,
        sourceBranch: allocation.sourceBranch,
        baseCommit: allocation.baseCommit,
        expectedSourceTip: allocation.expectedSourceTip,
      });
      return finishAllocation(allocation, { kind: "ready", receipt });
    } catch (error) {
      const code =
        error instanceof LocalIsolatedGitError
          ? error.code
          : "WORKSPACE_PROVISION_FAILED";
      return finishAllocation(allocation, {
        kind: "failed",
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const planImportInTransaction: WorkspaceRuntime["planImportInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    const allocation = inspect(input.allocationId);
    if (allocation.revision !== input.expectedRevision) {
      throw new WorkspaceRuntimeError(
        "VERSION_CONFLICT",
        `Workspace Allocation revision ${input.expectedRevision} does not match ${allocation.revision}.`,
      );
    }
    if (allocation.state !== "ready") {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_ALLOCATION_STATE_INVALID",
        "Only a ready Workspace Allocation can import an execution result.",
      );
    }
    if (input.expectedSourceTip !== allocation.expectedSourceTip) {
      throw new WorkspaceRuntimeError(
        "INTEGRATION_CONFLICT",
        "Import expected source tip does not match the frozen allocation tip.",
      );
    }
    const requestHash = sha256(
      canonicalJson({
        allocationId: input.allocationId,
        resultCommit: input.resultCommit,
        expectedSourceTip: input.expectedSourceTip,
      }),
    );
    const existing = database
      .prepare(
        "SELECT id FROM workspace_imports WHERE allocation_id = ? AND request_hash = ?",
      )
      .get(input.allocationId, requestHash) as
      | { readonly id: string }
      | undefined;
    if (!existing) {
      const now = clock().toISOString();
      const importId = randomUUID();
      database
        .prepare(
          `INSERT INTO workspace_imports(
               id, allocation_id, command_id, request_hash, state,
               expected_source_tip, before_source_tip, result_commit,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'intent', ?, ?, ?, ?, ?)`,
        )
        .run(
          importId,
          input.allocationId,
          input.commandId,
          requestHash,
          input.expectedSourceTip,
          input.expectedSourceTip,
          input.resultCommit,
          now,
          now,
        );
      appendAudit({
        action: "source-import.planned",
        entityType: "workspace-import",
        entityId: importId,
        projectId: allocation.projectId,
        commandId: input.commandId,
        actor: input.actor,
        before: null,
        after: { allocationId: allocation.id, state: "intent", requestHash },
        now,
      });
      options.events.append({
        type: "source-import.planned",
        scope: {
          companyId: "company",
          projectId: allocation.projectId,
          applicationId: allocation.applicationId,
          workspaceAllocationId: allocation.id,
          commandId: input.commandId,
        },
        payload: {
          importId,
          allocationId: allocation.id,
          state: "intent",
          beforeSourceTip: input.expectedSourceTip,
          resultCommit: input.resultCommit,
        },
        timestamp: now,
      });
    }
    return inspect(input.allocationId);
  };

  const executeImport = (importId: string): WorkspaceAllocationView => {
    const row = database
      .prepare(
        "SELECT allocation_id AS allocationId FROM workspace_imports WHERE id = ?",
      )
      .get(importId) as { readonly allocationId: string } | undefined;
    if (!row) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_IMPORT_NOT_FOUND",
        `Workspace import ${importId} was not found.`,
      );
    }
    const allocation = inspect(row.allocationId);
    const workspaceImport = allocation.imports.find(
      (entry) => entry.id === importId,
    )!;
    if (workspaceImport.state === "succeeded") return allocation;
    if (
      workspaceImport.state !== "intent" &&
      workspaceImport.state !== "running"
    ) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_IMPORT_STATE_INVALID",
        `Workspace import ${importId} cannot run from ${workspaceImport.state}.`,
      );
    }
    if (allocation.provisionReceipt === null) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_PROVISION_RECEIPT_MISSING",
        `Workspace Allocation ${allocation.id} has no provision receipt.`,
      );
    }
    internalTransaction(() => {
      database
        .prepare(
          "UPDATE workspace_imports SET state = 'running', updated_at = ? WHERE id = ?",
        )
        .run(clock().toISOString(), importId);
    });
    try {
      const receipt = options.profile.importResult({
        allocation:
          allocation.provisionReceipt as LocalIsolatedGitProvisionReceipt,
        resultCommit: workspaceImport.resultCommit,
        expectedSourceTip: workspaceImport.expectedSourceTip,
      });
      return internalTransaction(() => {
        const now = clock().toISOString();
        database
          .prepare(
            `UPDATE workspace_imports
                SET state = 'succeeded', object_set_hash = ?, receipt_json = ?,
                    failure_code = NULL, failure_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(receipt.objectSetHash, canonicalJson(receipt), now, importId);
        appendAudit({
          action: "source-import.completed",
          entityType: "workspace-import",
          entityId: importId,
          projectId: allocation.projectId,
          commandId: workspaceImport.id,
          actor: {
            type: "runtime-worker",
            id: "workspace-runtime",
            authenticatedBy: "runtime",
          },
          before: { state: workspaceImport.state },
          after: receipt,
          now,
        });
        options.events.append({
          type: "source-import.completed",
          scope: {
            companyId: "company",
            projectId: allocation.projectId,
            applicationId: allocation.applicationId,
            workspaceAllocationId: allocation.id,
          },
          payload: {
            importId,
            allocationId: allocation.id,
            state: "succeeded",
            beforeSourceTip: receipt.beforeSourceTip,
            afterSourceTip: receipt.afterSourceTip,
            resultCommit: receipt.resultCommit,
            objectSetHash: receipt.objectSetHash,
          },
          timestamp: now,
        });
        return inspect(allocation.id);
      });
    } catch (error) {
      const code =
        error instanceof LocalIsolatedGitError
          ? error.code
          : "WORKSPACE_IMPORT_FAILED";
      return internalTransaction(() => {
        const now = clock().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        database
          .prepare(
            `UPDATE workspace_imports
                SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(code, message, now, importId);
        appendAudit({
          action: "source-import.failed",
          entityType: "workspace-import",
          entityId: importId,
          projectId: allocation.projectId,
          commandId: workspaceImport.id,
          actor: {
            type: "runtime-worker",
            id: "workspace-runtime",
            authenticatedBy: "runtime",
          },
          before: { state: workspaceImport.state },
          after: { state: "failed", code, message },
          now,
        });
        options.events.append({
          type: "source-import.failed",
          scope: {
            companyId: "company",
            projectId: allocation.projectId,
            applicationId: allocation.applicationId,
            workspaceAllocationId: allocation.id,
          },
          payload: {
            importId,
            allocationId: allocation.id,
            state: "failed",
            beforeSourceTip: workspaceImport.beforeSourceTip,
            resultCommit: workspaceImport.resultCommit,
            failureCode: code,
          },
          timestamp: now,
        });
        return inspect(allocation.id);
      });
    }
  };

  const planCleanupInTransaction: WorkspaceRuntime["planCleanupInTransaction"] =
    (input) => {
      assertRuntimeActor(input.actor);
      const allocation = inspect(input.allocationId);
      if (allocation.revision !== input.expectedRevision) {
        throw new WorkspaceRuntimeError(
          "VERSION_CONFLICT",
          "Workspace Allocation revision changed.",
        );
      }
      if (allocation.state === "cleaned") return allocation;
      if (
        allocation.imports.some(
          (workspaceImport) =>
            workspaceImport.state === "intent" ||
            workspaceImport.state === "running" ||
            workspaceImport.state === "unknown",
        )
      ) {
        throw new WorkspaceRuntimeError(
          "WORKSPACE_IMPORT_PENDING",
          "Workspace Allocation cleanup requires all import intents to be terminal.",
        );
      }
      const now = clock().toISOString();
      database
        .prepare(
          `UPDATE workspace_allocations
              SET state = 'cleanup-pending', cleanup_command_id = ?,
                  revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(input.commandId, now, allocation.id);
      appendAudit({
        action: "workspace-allocation.cleanup-requested",
        entityType: "workspace-allocation",
        entityId: allocation.id,
        projectId: allocation.projectId,
        commandId: input.commandId,
        actor: input.actor,
        before: { state: allocation.state },
        after: { state: "cleanup-pending" },
        now,
      });
      options.events.append({
        type: "workspace-allocation.cleanup-requested",
        scope: {
          companyId: "company",
          projectId: allocation.projectId,
          applicationId: allocation.applicationId,
          workspaceAllocationId: allocation.id,
          commandId: input.commandId,
        },
        payload: {
          allocationId: allocation.id,
          state: "planned",
          sourceBranch: allocation.sourceBranch,
          baseCommit: allocation.baseCommit,
          expectedSourceTip: allocation.expectedSourceTip,
          requestedState: "cleanup-pending",
        },
        timestamp: now,
      });
      return inspect(allocation.id);
    };

  const executeCleanup = (allocationId: string): WorkspaceAllocationView => {
    const allocation = inspect(allocationId);
    if (allocation.state === "cleaned") return allocation;
    if (allocation.state !== "cleanup-pending") {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_ALLOCATION_STATE_INVALID",
        `Workspace Allocation ${allocationId} is not pending cleanup.`,
      );
    }
    options.profile.cleanup(
      allocation.provisionReceipt as LocalIsolatedGitProvisionReceipt,
    );
    return internalTransaction(() => {
      const now = clock().toISOString();
      const evidence = {
        executionTreePath: (
          allocation.provisionReceipt as LocalIsolatedGitProvisionReceipt
        ).executionTreePath,
        cleanedAt: now,
      };
      database
        .prepare(
          `UPDATE workspace_allocations
              SET state = 'cleaned', cleanup_evidence_json = ?,
                  revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(canonicalJson(evidence), now, allocation.id);
      appendAudit({
        action: "workspace-allocation.cleaned",
        entityType: "workspace-allocation",
        entityId: allocation.id,
        projectId: allocation.projectId,
        commandId: allocation.operationKey,
        actor: {
          type: "runtime-worker",
          id: "workspace-runtime",
          authenticatedBy: "runtime",
        },
        before: { state: allocation.state },
        after: { state: "cleaned", cleanupEvidence: evidence },
        now,
      });
      options.events.append({
        type: "workspace-allocation.cleaned",
        scope: {
          companyId: "company",
          projectId: allocation.projectId,
          applicationId: allocation.applicationId,
          workspaceAllocationId: allocation.id,
        },
        payload: {
          allocationId: allocation.id,
          state: "cleaned",
          sourceBranch: allocation.sourceBranch,
          baseCommit: allocation.baseCommit,
          expectedSourceTip: allocation.expectedSourceTip,
          cleanupEvidence: evidence,
        },
        timestamp: now,
      });
      return inspect(allocation.id);
    });
  };

  const reconcile = (): void => {
    const allocations = database
      .prepare(
        `SELECT id, state FROM workspace_allocations
          WHERE state IN ('planned', 'provisioning', 'cleanup-pending')
       ORDER BY created_at, id`,
      )
      .all() as Array<{
      readonly id: string;
      readonly state: WorkspaceAllocationState;
    }>;
    for (const allocation of allocations) {
      if (allocation.state === "cleanup-pending") executeCleanup(allocation.id);
      else executeProvision(allocation.id);
    }
    const imports = database
      .prepare(
        `SELECT id FROM workspace_imports WHERE state IN ('intent', 'running')
         ORDER BY created_at, id`,
      )
      .all() as Array<{ readonly id: string }>;
    for (const workspaceImport of imports) executeImport(workspaceImport.id);
  };

  return {
    inspect,
    planProvisionInTransaction,
    executeProvision,
    planImportInTransaction,
    executeImport,
    planCleanupInTransaction,
    executeCleanup,
    reconcile,
  };
};
