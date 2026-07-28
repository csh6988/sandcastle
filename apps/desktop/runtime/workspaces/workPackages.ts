import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRegisteredCompanyAgentId } from "../agent/agentCatalog.js";
import type { RuntimeEvents } from "../events/subscription.js";
import type { ActorRef, RunSnapshotPayload } from "../interface.js";
import type { PipelineRuntime } from "../pipeline/pipelineRuntime.js";
import type {
  WorkspaceAllocationView,
  WorkspaceRuntime,
} from "./workspaceRuntime.js";

export type WorkPackageDependencyKind =
  | "artifact"
  | "commit"
  | "contract"
  | "readiness"
  | "manual";

export interface WorkPackageManifest {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly moduleScope: readonly string[];
  readonly allowedPermissions: readonly string[];
  readonly specRefs: readonly string[];
  readonly harnessRefs: readonly string[];
  readonly assignmentCriteria: {
    readonly positionIds: readonly string[];
  };
  readonly expectedArtifacts: readonly string[];
  readonly selfCheckCommands: readonly string[];
  readonly codeReviewConditions: readonly string[];
  readonly integrationConditions: readonly string[];
  readonly riskTier: "low" | "medium" | "high" | "critical";
  readonly recoveryPolicy: string;
  readonly execution: {
    readonly profileId: "software-rnd-local-isolated-git";
    readonly branchStrategy: "branch";
    readonly gitRefWriteIsolation: true;
    readonly runtimeImportOnly: true;
  };
}

export interface WorkPackageDependencyView {
  readonly predecessorWorkPackageVersionId: string;
  readonly kind: WorkPackageDependencyKind;
  readonly contractId: string | null;
  readonly contractVersion: string | null;
  readonly evidenceRef: string | null;
}

export interface WorkPackageAssignmentView {
  readonly id: string;
  readonly workPackageVersionId: string;
  readonly nodeAttemptId: string;
  readonly positionId: string;
  readonly aiMemberId: string;
  readonly agentAdapterId: string;
  readonly rationale: unknown;
  readonly allocationId: string;
  readonly interactionSessionId: string;
  readonly sandboxIdentity: string;
  readonly evidenceScope: string;
  readonly state:
    | "assigned"
    | "running"
    | "awaiting-self-check"
    | "self-check-passed"
    | "failed"
    | "superseded";
  readonly selfCheck: {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly report: unknown;
    readonly reportHash: string;
    readonly createdAt: string;
  } | null;
  readonly allocation: WorkspaceAllocationView;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkPackageVersionView {
  readonly id: string;
  readonly version: number;
  readonly applicationId: string;
  readonly repositoryReference: string;
  readonly nodeRunId: string;
  readonly manifest: WorkPackageManifest;
  readonly manifestHash: string;
  readonly status: "ready" | "superseded";
  readonly dependencies: readonly WorkPackageDependencyView[];
  readonly assignments: readonly WorkPackageAssignmentView[];
  readonly createdAt: string;
}

export interface WorkPackageView {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly technicalBaselineId: string;
  readonly state:
    | "ready"
    | "assigned"
    | "running"
    | "self-check"
    | "blocked"
    | "failed";
  readonly revision: number;
  readonly versions: readonly WorkPackageVersionView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkPackageGraphView {
  readonly projectId: string;
  readonly runId: string;
  readonly technicalBaselineId: string;
  readonly packages: readonly WorkPackageView[];
}

export interface WorkPackageContractInput {
  readonly workPackageId: string;
  readonly versionId: string;
  readonly applicationId: string;
  readonly repositoryReference: string;
  readonly nodeRunId: string;
  readonly dependencies: readonly {
    readonly predecessorWorkPackageId: string;
    readonly kind: WorkPackageDependencyKind;
    readonly contractId?: string;
    readonly contractVersion?: string;
    readonly evidenceRef?: string;
  }[];
  readonly manifest: Omit<WorkPackageManifest, "execution">;
}

export class WorkPackageRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkPackageRuntimeError";
  }
}

export interface WorkPackageRuntime {
  readonly inspect: (runId: string) => WorkPackageGraphView;
  readonly generateInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly runId: string;
    readonly technicalBaselineId: string;
    readonly packages: readonly WorkPackageContractInput[];
  }) => WorkPackageGraphView;
  readonly versionInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly workPackageId: string;
    readonly versionId: string;
    readonly dependencies: readonly {
      readonly predecessorWorkPackageVersionId: string;
      readonly kind: WorkPackageDependencyKind;
      readonly contractId?: string;
      readonly contractVersion?: string;
      readonly evidenceRef?: string;
    }[];
    readonly manifest: Omit<WorkPackageManifest, "execution">;
  }) => WorkPackageGraphView;
  readonly assignInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly workPackageId: string;
    readonly baseCommit: string;
  }) => WorkPackageGraphView;
  readonly startInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly workPackageId: string;
  }) => WorkPackageGraphView;
  readonly reworkInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly workPackageId: string;
    readonly versionId: string;
    readonly baseCommit: string;
    readonly recoveryReason: string;
    readonly dependencyVersionReplacements?: Readonly<Record<string, string>>;
  }) => WorkPackageGraphView;
  readonly recordSelfCheckInTransaction: (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly expectedRevision: number;
    readonly workPackageId: string;
    readonly status: "passed" | "failed";
    readonly commands: readonly string[];
    readonly logRefs: readonly string[];
    readonly commitEvidence: readonly string[];
    readonly summary: string;
  }) => WorkPackageGraphView;
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

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const formalExecution = {
  profileId: "software-rnd-local-isolated-git",
  branchStrategy: "branch",
  gitRefWriteIsolation: true,
  runtimeImportOnly: true,
} as const;

const assertRuntimeActor = (actor: ActorRef): void => {
  if (actor.type !== "runtime-worker" || actor.authenticatedBy !== "runtime") {
    throw new WorkPackageRuntimeError(
      "WORK_PACKAGE_ACTOR_INVALID",
      "Work Package orchestration requires an authenticated Runtime worker.",
    );
  }
};

const safeBranchSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "package";

export const openWorkPackageRuntime = (
  database: DatabaseSync,
  options: {
    readonly workspaces: WorkspaceRuntime;
    readonly pipelineRuntime: Pick<
      PipelineRuntime,
      | "prepareWorkPackageAttemptInTransaction"
      | "blockWorkPackageAttemptInTransaction"
      | "releaseWorkPackageSuccessorsInTransaction"
    >;
    readonly events: Pick<RuntimeEvents, "append">;
    readonly clock?: () => Date;
  },
): WorkPackageRuntime => {
  const clock = options.clock ?? (() => new Date());

  const appendMutation = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly action: string;
    readonly eventType: string;
    readonly projectId: string;
    readonly runId: string;
    readonly workPackageId: string;
    readonly workPackageVersionId?: string;
    readonly nodeRunId?: string;
    readonly nodeAttemptId?: string;
    readonly workspaceAllocationId?: string;
    readonly sessionId?: string;
    readonly payload: unknown;
    readonly now: string;
  }): void => {
    database
      .prepare(
        `INSERT INTO runtime_audit_records(
           id, action, entity_type, entity_id, run_id, node_run_id,
           before_json, after_json, created_at, command_id, actor_type,
           actor_id, authenticated_by, consumer_id
         ) VALUES (?, ?, 'work-package', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?,
                   (SELECT consumer_id FROM runtime_unit_of_work_context WHERE slot = 1))`,
      )
      .run(
        randomUUID(),
        input.action,
        input.workPackageId,
        input.runId,
        input.nodeRunId ?? null,
        canonicalJson(input.payload),
        input.now,
        input.commandId,
        input.actor.type,
        input.actor.id,
        input.actor.authenticatedBy,
      );
    options.events.append({
      type: input.eventType,
      scope: {
        companyId: "company",
        projectId: input.projectId,
        runId: input.runId,
        ...(input.workPackageVersionId
          ? { workPackageVersionId: input.workPackageVersionId }
          : {}),
        workPackageId: input.workPackageId,
        ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
        ...(input.nodeAttemptId ? { nodeAttemptId: input.nodeAttemptId } : {}),
        ...(input.workspaceAllocationId
          ? { workspaceAllocationId: input.workspaceAllocationId }
          : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        commandId: input.commandId,
      },
      payload: input.payload,
      timestamp: input.now,
    });
  };

  const inspect = (runId: string): WorkPackageGraphView => {
    const run = database
      .prepare(
        `SELECT project_id AS projectId FROM department_runs WHERE id = ?`,
      )
      .get(runId) as { readonly projectId: string } | undefined;
    if (!run) {
      throw new WorkPackageRuntimeError(
        "RUN_NOT_FOUND",
        `Department Run ${runId} was not found.`,
      );
    }
    const baseline = database
      .prepare(
        `SELECT technical_baseline_id AS technicalBaselineId
           FROM technical_gate_promotions WHERE run_id = ?`,
      )
      .get(runId) as { readonly technicalBaselineId: string } | undefined;
    const packageRows = database
      .prepare(
        `SELECT id, project_id AS projectId, run_id AS runId,
                technical_baseline_id AS technicalBaselineId, state, revision,
                created_at AS createdAt, updated_at AS updatedAt
           FROM work_packages WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    const packages = packageRows.map((packageRow): WorkPackageView => {
      const versionRows = database
        .prepare(
          `SELECT id, version, application_id AS applicationId,
                  repository_reference AS repositoryReference,
                  node_run_id AS nodeRunId, manifest_json AS manifestJson,
                  manifest_hash AS manifestHash, status,
                  created_at AS createdAt
             FROM work_package_versions
            WHERE work_package_id = ? ORDER BY version`,
        )
        .all(String(packageRow.id)) as Array<Record<string, unknown>>;
      const versions = versionRows.map((versionRow): WorkPackageVersionView => {
        const dependencyRows = database
          .prepare(
            `SELECT predecessor_work_package_version_id AS predecessorWorkPackageVersionId,
                    kind, contract_id AS contractId,
                    contract_version AS contractVersion,
                    evidence_ref AS evidenceRef
               FROM work_package_dependencies
              WHERE work_package_version_id = ?
           ORDER BY predecessor_work_package_version_id, kind`,
          )
          .all(String(versionRow.id)) as Array<Record<string, unknown>>;
        const dependencies = dependencyRows.map(
          (dependency): WorkPackageDependencyView => ({
            predecessorWorkPackageVersionId: String(
              dependency.predecessorWorkPackageVersionId,
            ),
            kind: dependency.kind as WorkPackageDependencyKind,
            contractId:
              dependency.contractId === null
                ? null
                : String(dependency.contractId),
            contractVersion:
              dependency.contractVersion === null
                ? null
                : String(dependency.contractVersion),
            evidenceRef:
              dependency.evidenceRef === null
                ? null
                : String(dependency.evidenceRef),
          }),
        );
        const assignmentRows = database
          .prepare(
            `SELECT id, work_package_version_id AS workPackageVersionId,
                    node_attempt_id AS nodeAttemptId, position_id AS positionId,
                    ai_member_id AS aiMemberId,
                    agent_adapter_id AS agentAdapterId,
                    rationale_json AS rationaleJson, allocation_id AS allocationId,
                    interaction_session_id AS interactionSessionId,
                    sandbox_identity AS sandboxIdentity,
                    evidence_scope AS evidenceScope, state,
                    created_at AS createdAt, updated_at AS updatedAt
               FROM work_package_assignments
              WHERE work_package_version_id = ? ORDER BY created_at, id`,
          )
          .all(String(versionRow.id)) as Array<Record<string, unknown>>;
        const assignments = assignmentRows.map(
          (assignmentRow): WorkPackageAssignmentView => {
            const selfCheck = database
              .prepare(
                `SELECT id, status, report_json AS reportJson,
                        report_hash AS reportHash, created_at AS createdAt
                   FROM work_package_self_checks WHERE assignment_id = ?`,
              )
              .get(String(assignmentRow.id)) as
              | Record<string, unknown>
              | undefined;
            return {
              id: String(assignmentRow.id),
              workPackageVersionId: String(assignmentRow.workPackageVersionId),
              nodeAttemptId: String(assignmentRow.nodeAttemptId),
              positionId: String(assignmentRow.positionId),
              aiMemberId: String(assignmentRow.aiMemberId),
              agentAdapterId: String(assignmentRow.agentAdapterId),
              rationale: parseJson(String(assignmentRow.rationaleJson)),
              allocationId: String(assignmentRow.allocationId),
              interactionSessionId: String(assignmentRow.interactionSessionId),
              sandboxIdentity: String(assignmentRow.sandboxIdentity),
              evidenceScope: String(assignmentRow.evidenceScope),
              state: assignmentRow.state as WorkPackageAssignmentView["state"],
              selfCheck: selfCheck
                ? {
                    id: String(selfCheck.id),
                    status: selfCheck.status as "passed" | "failed",
                    report: parseJson(String(selfCheck.reportJson)),
                    reportHash: String(selfCheck.reportHash),
                    createdAt: String(selfCheck.createdAt),
                  }
                : null,
              allocation: options.workspaces.inspect(
                String(assignmentRow.allocationId),
              ),
              createdAt: String(assignmentRow.createdAt),
              updatedAt: String(assignmentRow.updatedAt),
            };
          },
        );
        return {
          id: String(versionRow.id),
          version: Number(versionRow.version),
          applicationId: String(versionRow.applicationId),
          repositoryReference: String(versionRow.repositoryReference),
          nodeRunId: String(versionRow.nodeRunId),
          manifest: parseJson(String(versionRow.manifestJson)),
          manifestHash: String(versionRow.manifestHash),
          status: versionRow.status as "ready" | "superseded",
          dependencies,
          assignments,
          createdAt: String(versionRow.createdAt),
        };
      });
      return {
        id: String(packageRow.id),
        projectId: String(packageRow.projectId),
        runId: String(packageRow.runId),
        technicalBaselineId: String(packageRow.technicalBaselineId),
        state: packageRow.state as WorkPackageView["state"],
        revision: Number(packageRow.revision),
        versions,
        createdAt: String(packageRow.createdAt),
        updatedAt: String(packageRow.updatedAt),
      };
    });
    return {
      projectId: run.projectId,
      runId,
      technicalBaselineId: baseline?.technicalBaselineId ?? "",
      packages,
    };
  };

  const promotedBaseline = (runId: string, technicalBaselineId: string) => {
    const row = database
      .prepare(
        `SELECT department_runs.project_id AS projectId,
                department_runs.snapshot_revision_id AS snapshotRevisionId,
                technical_baselines.manifest_hash AS technicalBaselineHash,
                run_snapshot_revisions.canonical_json AS snapshotJson
           FROM department_runs
           JOIN technical_baselines
             ON technical_baselines.run_id = department_runs.id
            AND technical_baselines.id = ?
           JOIN technical_gate_promotions
             ON technical_gate_promotions.run_id = department_runs.id
            AND technical_gate_promotions.technical_baseline_id = technical_baselines.id
            AND technical_gate_promotions.snapshot_revision_id = department_runs.snapshot_revision_id
           JOIN run_snapshot_revisions
             ON run_snapshot_revisions.id = department_runs.snapshot_revision_id
          WHERE department_runs.id = ?`,
      )
      .get(technicalBaselineId, runId) as
      | {
          readonly projectId: string;
          readonly snapshotRevisionId: string;
          readonly technicalBaselineHash: string;
          readonly snapshotJson: string;
        }
      | undefined;
    if (!row) {
      throw new WorkPackageRuntimeError(
        "TECHNICAL_BASELINE_NOT_PROMOTED",
        `Technical Baseline ${technicalBaselineId} is not the promoted baseline for Run ${runId}.`,
      );
    }
    const snapshot = parseJson<RunSnapshotPayload>(row.snapshotJson);
    if (
      snapshot.technicalGatePromotion?.acceptedTechnicalBaselineId !==
        technicalBaselineId ||
      snapshot.technicalGatePromotion.acceptedTechnicalBaselineHash !==
        row.technicalBaselineHash
    ) {
      throw new WorkPackageRuntimeError(
        "TECHNICAL_BASELINE_SNAPSHOT_MISMATCH",
        `Run ${runId} does not freeze Technical Baseline ${technicalBaselineId}.`,
      );
    }
    return { ...row, snapshot };
  };

  const validateDependencyAuthority = (
    runId: string,
    workPackageId: string,
    dependency: {
      readonly kind: WorkPackageDependencyKind;
      readonly contractId?: string;
      readonly contractVersion?: string;
      readonly evidenceRef?: string;
    },
  ): void => {
    if (dependency.kind === "contract" && !dependency.contractId?.trim()) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_CONTRACT_ID_REQUIRED",
        `Work Package ${workPackageId} contract dependencies require an exact Contract ID.`,
      );
    }
    if (dependency.kind === "contract" && !dependency.contractVersion?.trim()) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_CONTRACT_VERSION_REQUIRED",
        `Work Package ${workPackageId} contract dependencies require an exact Contract version.`,
      );
    }
    if (dependency.kind !== "contract" && dependency.contractId) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_CONTRACT_ID_INVALID",
        `Work Package ${workPackageId} may bind a Contract ID only to a contract dependency.`,
      );
    }
    if (dependency.kind !== "contract" && dependency.contractVersion) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_CONTRACT_VERSION_INVALID",
        `Work Package ${workPackageId} may bind a Contract version only to a contract dependency.`,
      );
    }
    if (
      ["readiness", "manual"].includes(dependency.kind) &&
      !dependency.evidenceRef?.trim()
    ) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_DEPENDENCY_EVIDENCE_REQUIRED",
        `Work Package ${workPackageId} ${dependency.kind} dependencies require an exact evidence reference.`,
      );
    }
    if (
      ["commit", "contract"].includes(dependency.kind) &&
      dependency.evidenceRef
    ) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_DEPENDENCY_EVIDENCE_INVALID",
        `Work Package ${workPackageId} may not bind an evidence reference to a ${dependency.kind} dependency.`,
      );
    }
    if (
      dependency.kind === "manual" &&
      !database
        .prepare(
          `SELECT 1 AS present FROM node_runs
              WHERE run_id = ? AND id = ? AND node_type = 'human-approval'`,
        )
        .get(runId, dependency.evidenceRef ?? null)
    ) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_MANUAL_GATE_UNDECLARED",
        `Work Package ${workPackageId} cannot wait on a manual dependency unless the Pipeline declares Human Approval.`,
      );
    }
  };

  const validateContract = (
    projectId: string,
    runId: string,
    contract: WorkPackageContractInput,
  ): void => {
    const application = database
      .prepare(
        `SELECT repository_reference AS repositoryReference
           FROM application_references
          WHERE id = ? AND project_id = ?`,
      )
      .get(contract.applicationId, projectId) as
      | { readonly repositoryReference: string }
      | undefined;
    if (
      !application ||
      application.repositoryReference !== contract.repositoryReference
    ) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_APPLICATION_REPOSITORY_MISMATCH",
        `Work Package ${contract.workPackageId} must belong to exactly one registered Application and Repository.`,
      );
    }
    const node = database
      .prepare(
        `SELECT handler_kind_id AS handlerKindId
           FROM node_runs WHERE id = ? AND run_id = ?`,
      )
      .get(contract.nodeRunId, runId) as
      | { readonly handlerKindId: string | null }
      | undefined;
    if (node?.handlerKindId !== "development@1") {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_NODE_INVALID",
        `Work Package ${contract.workPackageId} must map to a frozen development@1 Node Run.`,
      );
    }
    const activePackage = database
      .prepare(
        `SELECT work_packages.id
           FROM work_package_versions
           JOIN work_packages
             ON work_packages.id = work_package_versions.work_package_id
          WHERE work_packages.run_id = ?
            AND work_package_versions.node_run_id = ?
            AND work_package_versions.status = 'ready'
          LIMIT 1`,
      )
      .get(runId, contract.nodeRunId) as { readonly id: string } | undefined;
    if (activePackage) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_NODE_DUPLICATE",
        `Node Run ${contract.nodeRunId} already belongs to active Work Package ${activePackage.id}.`,
      );
    }
    for (const dependency of contract.dependencies) {
      validateDependencyAuthority(runId, contract.workPackageId, dependency);
    }
  };

  const validateInitialGraph = (
    packages: readonly WorkPackageContractInput[],
  ): void => {
    const indexById = new Map<string, number>();
    const packageIdByNodeRunId = new Map<string, string>();
    packages.forEach((workPackage, index) => {
      if (indexById.has(workPackage.workPackageId)) {
        throw new WorkPackageRuntimeError(
          "WORK_PACKAGE_DUPLICATE",
          `Work Package ${workPackage.workPackageId} is duplicated.`,
        );
      }
      indexById.set(workPackage.workPackageId, index);
      const existingPackageId = packageIdByNodeRunId.get(workPackage.nodeRunId);
      if (existingPackageId) {
        throw new WorkPackageRuntimeError(
          "WORK_PACKAGE_NODE_DUPLICATE",
          `Node Run ${workPackage.nodeRunId} cannot own both Work Package ${existingPackageId} and ${workPackage.workPackageId}.`,
        );
      }
      packageIdByNodeRunId.set(
        workPackage.nodeRunId,
        workPackage.workPackageId,
      );
    });
    packages.forEach((workPackage, index) => {
      for (const dependency of workPackage.dependencies) {
        const predecessorIndex = indexById.get(
          dependency.predecessorWorkPackageId,
        );
        if (predecessorIndex === undefined) {
          throw new WorkPackageRuntimeError(
            "WORK_PACKAGE_DEPENDENCY_NOT_FOUND",
            `Dependency ${dependency.predecessorWorkPackageId} was not generated with ${workPackage.workPackageId}.`,
          );
        }
        if (predecessorIndex >= index) {
          throw new WorkPackageRuntimeError(
            "WORK_PACKAGE_PRODUCER_ORDER_INVALID",
            `Work Package ${workPackage.workPackageId} must follow producer ${dependency.predecessorWorkPackageId}.`,
          );
        }
      }
    });
  };

  const insertVersion = (input: {
    readonly workPackageId: string;
    readonly versionId: string;
    readonly version: number;
    readonly applicationId: string;
    readonly repositoryReference: string;
    readonly nodeRunId: string;
    readonly manifest: Omit<WorkPackageManifest, "execution">;
    readonly dependencies: readonly {
      readonly predecessorWorkPackageVersionId: string;
      readonly kind: WorkPackageDependencyKind;
      readonly contractId?: string;
      readonly contractVersion?: string;
      readonly evidenceRef?: string;
    }[];
    readonly now: string;
  }): void => {
    const manifest: WorkPackageManifest = {
      ...input.manifest,
      execution: formalExecution,
    };
    const manifestJson = canonicalJson(manifest);
    database
      .prepare(
        `INSERT INTO work_package_versions(
           id, work_package_id, version, application_id,
           repository_reference, node_run_id, manifest_json, manifest_hash,
           status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
      )
      .run(
        input.versionId,
        input.workPackageId,
        input.version,
        input.applicationId,
        input.repositoryReference,
        input.nodeRunId,
        manifestJson,
        sha256(manifestJson),
        input.now,
      );
    const insertDependency = database.prepare(
      `INSERT INTO work_package_dependencies(
         work_package_version_id, predecessor_work_package_version_id,
         kind, contract_id, contract_version, evidence_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const dependency of input.dependencies) {
      insertDependency.run(
        input.versionId,
        dependency.predecessorWorkPackageVersionId,
        dependency.kind,
        dependency.contractId ?? null,
        dependency.contractVersion ?? null,
        dependency.evidenceRef ?? null,
        input.now,
      );
    }
  };

  const generateInTransaction: WorkPackageRuntime["generateInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    if (input.expectedRevision !== 0) {
      throw new WorkPackageRuntimeError(
        "VERSION_CONFLICT",
        "Initial Work Package generation requires expectedRevision 0.",
      );
    }
    const baseline = promotedBaseline(input.runId, input.technicalBaselineId);
    if (input.packages.length === 0) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_EMPTY",
        "Work Package generation requires at least one package.",
      );
    }
    validateInitialGraph(input.packages);
    input.packages.forEach((contract) =>
      validateContract(baseline.projectId, input.runId, contract),
    );
    const now = clock().toISOString();
    const versionByPackageId = new Map(
      input.packages.map((workPackage) => [
        workPackage.workPackageId,
        workPackage.versionId,
      ]),
    );
    for (const contract of input.packages) {
      database
        .prepare(
          `INSERT INTO work_packages(
               id, project_id, run_id, technical_baseline_id, state,
               revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'ready', 0, ?, ?)`,
        )
        .run(
          contract.workPackageId,
          baseline.projectId,
          input.runId,
          input.technicalBaselineId,
          now,
          now,
        );
      insertVersion({
        ...contract,
        version: 1,
        dependencies: contract.dependencies.map((dependency) => ({
          predecessorWorkPackageVersionId: versionByPackageId.get(
            dependency.predecessorWorkPackageId,
          )!,
          kind: dependency.kind,
          ...(dependency.contractId
            ? { contractId: dependency.contractId }
            : {}),
          ...(dependency.contractVersion
            ? { contractVersion: dependency.contractVersion }
            : {}),
          ...(dependency.evidenceRef
            ? { evidenceRef: dependency.evidenceRef }
            : {}),
        })),
        now,
      });
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "work-package.generate",
        eventType: "work-package.ready",
        projectId: baseline.projectId,
        runId: input.runId,
        workPackageId: contract.workPackageId,
        workPackageVersionId: contract.versionId,
        nodeRunId: contract.nodeRunId,
        payload: {
          workPackageId: contract.workPackageId,
          workPackageVersionId: contract.versionId,
          state: "ready",
          applicationId: contract.applicationId,
          repositoryReference: contract.repositoryReference,
          nodeRunId: contract.nodeRunId,
        },
        now,
      });
    }
    return inspect(input.runId);
  };

  const currentPackage = (workPackageId: string) => {
    const row = database
      .prepare(
        `SELECT work_packages.project_id AS projectId,
                work_packages.run_id AS runId,
                work_packages.technical_baseline_id AS technicalBaselineId,
                work_packages.state, work_packages.revision,
                department_runs.snapshot_revision_id AS snapshotRevisionId,
                work_package_versions.id AS versionId,
                work_package_versions.version,
                work_package_versions.application_id AS applicationId,
                work_package_versions.repository_reference AS repositoryReference,
                work_package_versions.node_run_id AS nodeRunId,
                work_package_versions.manifest_json AS manifestJson
           FROM work_packages
           JOIN department_runs ON department_runs.id = work_packages.run_id
           JOIN work_package_versions
             ON work_package_versions.work_package_id = work_packages.id
            AND work_package_versions.status = 'ready'
          WHERE work_packages.id = ?`,
      )
      .get(workPackageId) as
      | {
          readonly projectId: string;
          readonly runId: string;
          readonly technicalBaselineId: string;
          readonly state: WorkPackageView["state"];
          readonly revision: number;
          readonly snapshotRevisionId: string;
          readonly versionId: string;
          readonly version: number;
          readonly applicationId: string;
          readonly repositoryReference: string;
          readonly nodeRunId: string;
          readonly manifestJson: string;
        }
      | undefined;
    if (!row) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_NOT_FOUND",
        `Work Package ${workPackageId} was not found.`,
      );
    }
    return row;
  };

  const assertRevision = (
    workPackage: ReturnType<typeof currentPackage>,
    expectedRevision: number,
  ): void => {
    if (Number(workPackage.revision) !== expectedRevision) {
      throw new WorkPackageRuntimeError(
        "VERSION_CONFLICT",
        `Work Package revision ${expectedRevision} does not match current revision ${workPackage.revision}.`,
      );
    }
  };

  const assertDependenciesSatisfied = (versionId: string): void => {
    const dependencies = database
      .prepare(
        `SELECT dependencies.predecessor_work_package_version_id AS predecessorVersionId,
                dependencies.kind,
                dependencies.contract_id AS contractId,
                dependencies.contract_version AS contractVersion,
                dependencies.evidence_ref AS evidenceRef,
                predecessor.manifest_json AS predecessorManifestJson,
                packages.run_id AS runId,
                packages.technical_baseline_id AS technicalBaselineId
           FROM work_package_dependencies AS dependencies
           JOIN work_package_versions AS current_version
             ON current_version.id = dependencies.work_package_version_id
           JOIN work_packages AS packages
             ON packages.id = current_version.work_package_id
           JOIN work_package_versions AS predecessor
             ON predecessor.id = dependencies.predecessor_work_package_version_id
          WHERE dependencies.work_package_version_id = ?
       ORDER BY dependencies.predecessor_work_package_version_id,
                dependencies.kind`,
      )
      .all(versionId) as Array<{
      readonly predecessorVersionId: string;
      readonly kind: WorkPackageDependencyKind;
      readonly contractId: string | null;
      readonly contractVersion: string | null;
      readonly evidenceRef: string | null;
      readonly predecessorManifestJson: string;
      readonly runId: string;
      readonly technicalBaselineId: string;
    }>;
    for (const dependency of dependencies) {
      const passedSelfCheck = Boolean(
        database
          .prepare(
            `SELECT 1 AS present FROM work_package_assignments
              WHERE work_package_version_id = ?
                AND state = 'self-check-passed' LIMIT 1`,
          )
          .get(dependency.predecessorVersionId),
      );
      const importedCommit = Boolean(
        database
          .prepare(
            `SELECT 1 AS present
               FROM work_package_assignments
               JOIN workspace_imports
                 ON workspace_imports.allocation_id = work_package_assignments.allocation_id
              WHERE work_package_assignments.work_package_version_id = ?
                AND workspace_imports.state = 'succeeded'
              LIMIT 1`,
          )
          .get(dependency.predecessorVersionId),
      );
      let satisfied = false;
      if (dependency.kind === "artifact") {
        const predecessorManifest = parseJson<WorkPackageManifest>(
          dependency.predecessorManifestJson,
        );
        const producedArtifact = Boolean(
          database
            .prepare(
              `SELECT 1 AS present
                 FROM artifact_versions
                 JOIN work_package_assignments
                   ON work_package_assignments.node_attempt_id =
                      artifact_versions.producing_node_attempt_id
                WHERE work_package_assignments.work_package_version_id = ?
                  AND artifact_versions.status IN ('produced', 'accepted')
                  AND (? IS NULL OR artifact_versions.id = ?)
                LIMIT 1`,
            )
            .get(
              dependency.predecessorVersionId,
              dependency.evidenceRef,
              dependency.evidenceRef,
            ),
        );
        satisfied =
          passedSelfCheck &&
          (producedArtifact ||
            (dependency.evidenceRef === null &&
              predecessorManifest.expectedArtifacts.includes("source-commit") &&
              importedCommit));
      } else if (dependency.kind === "commit") {
        satisfied = importedCommit;
      } else if (dependency.kind === "contract") {
        satisfied =
          passedSelfCheck &&
          Boolean(
            dependency.contractId &&
            dependency.contractVersion &&
            database
              .prepare(
                `SELECT 1 AS present
                     FROM technical_baselines
                     JOIN cross_application_contract_revisions
                       ON cross_application_contract_revisions.proposal_revision_id =
                          technical_baselines.proposal_revision_id
                    WHERE technical_baselines.id = ?
                      AND cross_application_contract_revisions.contract_id = ?
                      AND cross_application_contract_revisions.version = ?
                      AND cross_application_contract_revisions.compatibility = 'compatible'
                    LIMIT 1`,
              )
              .get(
                dependency.technicalBaselineId,
                dependency.contractId,
                dependency.contractVersion,
              ),
          );
      } else if (dependency.kind === "readiness") {
        const readiness = database
          .prepare(
            `SELECT evidence.status,
                    proposal.readiness_evidence_json AS acceptedEvidenceJson
               FROM product_readiness_evidence AS evidence
               JOIN technical_baselines AS baseline ON baseline.id = ?
               JOIN technical_baseline_proposal_revisions AS proposal
                 ON proposal.id = baseline.proposal_revision_id
              WHERE evidence.id = ? AND evidence.run_id = ?`,
          )
          .get(
            dependency.technicalBaselineId,
            dependency.evidenceRef,
            dependency.runId,
          ) as
          | {
              readonly status: "ready" | "blocked";
              readonly acceptedEvidenceJson: string;
            }
          | undefined;
        const acceptedEvidence = readiness
          ? parseJson<readonly { readonly id: string }[]>(
              readiness.acceptedEvidenceJson,
            )
          : [];
        satisfied =
          readiness?.status === "ready" &&
          acceptedEvidence.some((entry) => entry.id === dependency.evidenceRef);
      } else {
        satisfied = Boolean(
          database
            .prepare(
              `SELECT 1 AS present FROM approvals
                WHERE run_id = ? AND node_run_id = ?
                  AND status = 'decided' AND decision = 'approve'
                LIMIT 1`,
            )
            .get(dependency.runId, dependency.evidenceRef),
        );
      }
      if (satisfied) continue;
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_DEPENDENCY_BLOCKED",
        `Predecessor Work Package Version ${dependency.predecessorVersionId} has no satisfied ${dependency.kind} evidence.`,
      );
    }
  };

  const selectAssignment = (workPackage: ReturnType<typeof currentPackage>) => {
    const snapshot = parseJson<RunSnapshotPayload>(
      String(
        (
          database
            .prepare(
              `SELECT canonical_json AS canonicalJson
                 FROM run_snapshot_revisions WHERE id = ?`,
            )
            .get(workPackage.snapshotRevisionId) as {
            readonly canonicalJson: string;
          }
        ).canonicalJson,
      ),
    );
    const manifest = parseJson<WorkPackageManifest>(workPackage.manifestJson);
    const eligible = snapshot.positions
      .filter(
        (position) =>
          position.aiMember.status === "active" &&
          isRegisteredCompanyAgentId(position.resolvedAgentId) &&
          (manifest.assignmentCriteria.positionIds.length === 0 ||
            manifest.assignmentCriteria.positionIds.includes(position.id)),
      )
      .map((position) => {
        const count = database
          .prepare(
            `SELECT COUNT(*) AS count
               FROM work_package_assignments
               JOIN work_package_versions
                 ON work_package_versions.id = work_package_assignments.work_package_version_id
               JOIN work_packages
                 ON work_packages.id = work_package_versions.work_package_id
              WHERE work_packages.run_id = ?
                AND work_package_assignments.position_id = ?
                AND work_package_assignments.state IN (
                  'assigned', 'running', 'awaiting-self-check'
                )`,
          )
          .get(workPackage.runId, position.id) as { readonly count: number };
        return { position, assignmentCount: Number(count.count) };
      })
      .sort(
        (left, right) =>
          left.assignmentCount - right.assignmentCount ||
          left.position.id.localeCompare(right.position.id),
      );
    const selected = eligible[0];
    if (!selected) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_ASSIGNMENT_UNAVAILABLE",
        `Work Package ${workPackage.versionId} has no eligible active Snapshot Position with a registered Agent adapter.`,
      );
    }
    return selected;
  };

  const assignCurrentVersion = (input: {
    readonly commandId: string;
    readonly actor: ActorRef;
    readonly workPackage: ReturnType<typeof currentPackage> & {
      readonly id: string;
    };
    readonly baseCommit: string;
    readonly reason: "initial" | "retry";
  }): void => {
    if (!/^[a-f0-9]{40}$/.test(input.baseCommit)) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_BASE_COMMIT_INVALID",
        "Work Package assignment requires an exact 40-character Git commit.",
      );
    }
    assertDependenciesSatisfied(input.workPackage.versionId);
    const selected = selectAssignment(input.workPackage);
    const now = clock().toISOString();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const allocationId = randomUUID();
    const sessionId = randomUUID();
    const sandboxIdentity = `sandbox:${allocationId}`;
    const evidenceScope = `work-package-attempt:${attemptId}`;
    const operationKey = `work-package-attempt:${attemptId}`;
    const sourceBranch = `sandcastle/wp/${safeBranchSegment(
      input.workPackage.id ?? input.workPackage.versionId,
    )}/attempt-${safeBranchSegment(attemptId)}`;
    options.pipelineRuntime.prepareWorkPackageAttemptInTransaction({
      runId: input.workPackage.runId,
      nodeRunId: input.workPackage.nodeRunId,
      snapshotRevisionId: input.workPackage.snapshotRevisionId,
      attemptId,
      operationKey,
      reason: input.reason,
    });
    database
      .prepare(
        `INSERT INTO interaction_sessions(
           id, mode, project_id, run_id, node_run_id, status, created_at,
           closed_at
         ) VALUES (?, 'run-collaboration', ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(
        sessionId,
        input.workPackage.projectId,
        input.workPackage.runId,
        input.workPackage.nodeRunId,
        now,
      );
    database
      .prepare(
        `INSERT INTO session_participants(
           id, session_id, participant_type, participant_ref, role, created_at
         ) VALUES (?, ?, 'ai-member', ?, 'developer', ?)`,
      )
      .run(randomUUID(), sessionId, selected.position.aiMember.id, now);
    options.workspaces.planProvisionInTransaction({
      commandId: input.commandId,
      actor: input.actor,
      expectedRevision: 0,
      allocationId,
      projectId: input.workPackage.projectId,
      applicationId: input.workPackage.applicationId,
      executionProfileId: formalExecution.profileId,
      sourceBranch,
      baseCommit: input.baseCommit,
      expectedSourceTip: input.baseCommit,
      operationKey,
      workPackageVersionId: input.workPackage.versionId,
      nodeAttemptId: attemptId,
      interactionSessionId: sessionId,
      sandboxIdentity,
      evidenceScope,
    });
    const rationale = {
      policy: "least-active-then-position-id",
      eligiblePositionIds: [selected.position.id],
      selectedPositionId: selected.position.id,
      priorActiveAssignments: selected.assignmentCount,
    };
    database
      .prepare(
        `INSERT INTO work_package_assignments(
           id, work_package_version_id, node_attempt_id, position_id,
           ai_member_id, agent_adapter_id, rationale_json, allocation_id,
           interaction_session_id, sandbox_identity, evidence_scope, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
      )
      .run(
        assignmentId,
        input.workPackage.versionId,
        attemptId,
        selected.position.id,
        selected.position.aiMember.id,
        selected.position.resolvedAgentId,
        canonicalJson(rationale),
        allocationId,
        sessionId,
        sandboxIdentity,
        evidenceScope,
        now,
        now,
      );
    database
      .prepare(
        `UPDATE work_packages
            SET state = 'assigned', revision = revision + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, input.workPackage.id ?? "");
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "work-package.assign",
      eventType: "work-package.assigned",
      projectId: input.workPackage.projectId,
      runId: input.workPackage.runId,
      workPackageId: input.workPackage.id ?? "",
      workPackageVersionId: input.workPackage.versionId,
      nodeRunId: input.workPackage.nodeRunId,
      nodeAttemptId: attemptId,
      workspaceAllocationId: allocationId,
      sessionId,
      payload: {
        workPackageId: input.workPackage.id,
        workPackageVersionId: input.workPackage.versionId,
        state: "assigned",
        assignmentId,
        positionId: selected.position.id,
        aiMemberId: selected.position.aiMember.id,
        agentAdapterId: selected.position.resolvedAgentId,
        allocationId,
        nodeAttemptId: attemptId,
        interactionSessionId: sessionId,
        sandboxIdentity,
        evidenceScope,
        sourceBranch,
      },
      now,
    });
  };

  const assignInTransaction: WorkPackageRuntime["assignInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    const workPackage = {
      ...currentPackage(input.workPackageId),
      id: input.workPackageId,
    };
    assertRevision(workPackage, input.expectedRevision);
    if (!["ready", "blocked", "failed"].includes(workPackage.state)) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_STATE_INVALID",
        `Work Package ${input.workPackageId} cannot be assigned from ${workPackage.state}.`,
      );
    }
    assignCurrentVersion({
      commandId: input.commandId,
      actor: input.actor,
      workPackage,
      baseCommit: input.baseCommit,
      reason: ["blocked", "failed"].includes(workPackage.state)
        ? "retry"
        : "initial",
    });
    return inspect(workPackage.runId);
  };

  const versionInTransaction: WorkPackageRuntime["versionInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    const workPackage = {
      ...currentPackage(input.workPackageId),
      id: input.workPackageId,
    };
    assertRevision(workPackage, input.expectedRevision);
    if (workPackage.state !== "ready") {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_STATE_INVALID",
        `Work Package ${input.workPackageId} cannot be versioned from ${workPackage.state}.`,
      );
    }
    for (const dependency of input.dependencies) {
      validateDependencyAuthority(
        workPackage.runId,
        input.workPackageId,
        dependency,
      );
      const predecessor = database
        .prepare(
          `SELECT work_packages.id AS workPackageId,
                    work_packages.run_id AS runId
               FROM work_package_versions
               JOIN work_packages
                 ON work_packages.id = work_package_versions.work_package_id
              WHERE work_package_versions.id = ?`,
        )
        .get(dependency.predecessorWorkPackageVersionId) as
        | {
            readonly workPackageId: string;
            readonly runId: string;
          }
        | undefined;
      if (!predecessor || predecessor.runId !== workPackage.runId) {
        throw new WorkPackageRuntimeError(
          "WORK_PACKAGE_DEPENDENCY_NOT_FOUND",
          `Work Package Version ${dependency.predecessorWorkPackageVersionId} was not found.`,
        );
      }
      if (
        predecessor.workPackageId === input.workPackageId ||
        database
          .prepare(
            `WITH RECURSIVE predecessor_chain(version_id) AS (
               SELECT predecessor_work_package_version_id
                 FROM work_package_dependencies
                WHERE work_package_version_id = ?
               UNION
               SELECT dependencies.predecessor_work_package_version_id
                 FROM work_package_dependencies AS dependencies
                 JOIN predecessor_chain
                   ON predecessor_chain.version_id =
                      dependencies.work_package_version_id
             )
             SELECT 1 AS present
               FROM predecessor_chain
               JOIN work_package_versions
                 ON work_package_versions.id = predecessor_chain.version_id
              WHERE work_package_versions.work_package_id = ?
              LIMIT 1`,
          )
          .get(dependency.predecessorWorkPackageVersionId, input.workPackageId)
      ) {
        throw new WorkPackageRuntimeError(
          "WORK_PACKAGE_PRODUCER_ORDER_INVALID",
          `Work Package ${input.workPackageId} must follow producer ${predecessor.workPackageId}.`,
        );
      }
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE work_package_versions SET status = 'superseded'
            WHERE id = ? AND status = 'ready'`,
      )
      .run(workPackage.versionId);
    insertVersion({
      workPackageId: input.workPackageId,
      versionId: input.versionId,
      version: Number(workPackage.version) + 1,
      applicationId: workPackage.applicationId,
      repositoryReference: workPackage.repositoryReference,
      nodeRunId: workPackage.nodeRunId,
      manifest: input.manifest,
      dependencies: input.dependencies,
      now,
    });
    database
      .prepare(
        `UPDATE work_packages
              SET state = 'ready', revision = revision + 1, updated_at = ?
            WHERE id = ?`,
      )
      .run(now, input.workPackageId);
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "work-package.version",
      eventType: "work-package.versioned",
      projectId: workPackage.projectId,
      runId: workPackage.runId,
      workPackageId: input.workPackageId,
      workPackageVersionId: input.versionId,
      nodeRunId: workPackage.nodeRunId,
      payload: {
        workPackageId: input.workPackageId,
        workPackageVersionId: input.versionId,
        supersedesWorkPackageVersionId: workPackage.versionId,
        state: "ready",
      },
      now,
    });
    return inspect(workPackage.runId);
  };

  const startInTransaction: WorkPackageRuntime["startInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    const workPackage = {
      ...currentPackage(input.workPackageId),
      id: input.workPackageId,
    };
    assertRevision(workPackage, input.expectedRevision);
    assertDependenciesSatisfied(workPackage.versionId);
    const assignment = database
      .prepare(
        `SELECT assignments.id, assignments.node_attempt_id AS nodeAttemptId,
                  assignments.allocation_id AS allocationId,
                  assignments.interaction_session_id AS interactionSessionId,
                  allocations.state AS allocationState
             FROM work_package_assignments AS assignments
             JOIN workspace_allocations AS allocations
               ON allocations.id = assignments.allocation_id
            WHERE assignments.work_package_version_id = ?
              AND assignments.state = 'assigned'
         ORDER BY assignments.created_at DESC LIMIT 1`,
      )
      .get(workPackage.versionId) as
      | {
          readonly id: string;
          readonly nodeAttemptId: string;
          readonly allocationId: string;
          readonly interactionSessionId: string;
          readonly allocationState: string;
        }
      | undefined;
    if (!assignment) {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_ALLOCATION_NOT_READY",
        `Work Package ${input.workPackageId} requires a ready isolated Workspace Allocation before execution.`,
      );
    }
    if (["failed", "unknown"].includes(assignment.allocationState)) {
      const now = clock().toISOString();
      database
        .prepare(
          `UPDATE work_package_assignments
              SET state = 'failed', updated_at = ? WHERE id = ?`,
        )
        .run(now, assignment.id);
      database
        .prepare(
          `UPDATE work_packages
              SET state = 'blocked', revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, input.workPackageId);
      options.pipelineRuntime.blockWorkPackageAttemptInTransaction({
        runId: workPackage.runId,
        nodeRunId: workPackage.nodeRunId,
        nodeAttemptId: assignment.nodeAttemptId,
        workspaceAllocationId: assignment.allocationId,
        failure: {
          code: "WORKSPACE_ALLOCATION_FAILED",
          message: `Workspace Allocation ${assignment.allocationId} is ${assignment.allocationState}.`,
        },
      });
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "work-package.block",
        eventType: "work-package.blocked",
        projectId: workPackage.projectId,
        runId: workPackage.runId,
        workPackageId: input.workPackageId,
        workPackageVersionId: workPackage.versionId,
        nodeRunId: workPackage.nodeRunId,
        nodeAttemptId: assignment.nodeAttemptId,
        workspaceAllocationId: assignment.allocationId,
        sessionId: assignment.interactionSessionId,
        payload: {
          workPackageId: input.workPackageId,
          workPackageVersionId: workPackage.versionId,
          state: "blocked",
          allocationId: assignment.allocationId,
          allocationState: assignment.allocationState,
          failureCode: "WORKSPACE_ALLOCATION_FAILED",
        },
        now,
      });
      return inspect(workPackage.runId);
    }
    if (assignment.allocationState !== "ready") {
      throw new WorkPackageRuntimeError(
        "WORK_PACKAGE_ALLOCATION_NOT_READY",
        `Work Package ${input.workPackageId} requires a ready isolated Workspace Allocation before execution.`,
      );
    }
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE work_package_assignments
              SET state = 'running', updated_at = ? WHERE id = ?`,
      )
      .run(now, assignment.id);
    database
      .prepare(
        `UPDATE work_packages
              SET state = 'running', revision = revision + 1, updated_at = ?
            WHERE id = ?`,
      )
      .run(now, input.workPackageId);
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "work-package.start",
      eventType: "work-package.started",
      projectId: workPackage.projectId,
      runId: workPackage.runId,
      workPackageId: input.workPackageId,
      workPackageVersionId: workPackage.versionId,
      nodeRunId: workPackage.nodeRunId,
      nodeAttemptId: assignment.nodeAttemptId,
      workspaceAllocationId: assignment.allocationId,
      sessionId: assignment.interactionSessionId,
      payload: {
        workPackageId: input.workPackageId,
        workPackageVersionId: workPackage.versionId,
        state: "running",
        nodeAttemptId: assignment.nodeAttemptId,
        allocationId: assignment.allocationId,
      },
      now,
    });
    return inspect(workPackage.runId);
  };

  const recordSelfCheckInTransaction: WorkPackageRuntime["recordSelfCheckInTransaction"] =
    (input) => {
      assertRuntimeActor(input.actor);
      const workPackage = {
        ...currentPackage(input.workPackageId),
        id: input.workPackageId,
      };
      assertRevision(workPackage, input.expectedRevision);
      const assignment = database
        .prepare(
          `SELECT id, node_attempt_id AS nodeAttemptId,
                  allocation_id AS allocationId,
                  interaction_session_id AS interactionSessionId,
                  (SELECT manifest_json FROM work_package_versions
                    WHERE id = work_package_assignments.work_package_version_id)
                    AS manifestJson,
                  (SELECT result_commit FROM workspace_imports
                    WHERE allocation_id = work_package_assignments.allocation_id
                      AND state = 'succeeded'
                 ORDER BY created_at DESC LIMIT 1) AS importedResultCommit
             FROM work_package_assignments
            WHERE work_package_version_id = ?
              AND state = 'awaiting-self-check'
         ORDER BY created_at DESC LIMIT 1`,
        )
        .get(workPackage.versionId) as
        | {
            readonly id: string;
            readonly nodeAttemptId: string;
            readonly allocationId: string;
            readonly interactionSessionId: string;
            readonly manifestJson: string;
            readonly importedResultCommit: string | null;
          }
        | undefined;
      if (!assignment) {
        throw new WorkPackageRuntimeError(
          "WORK_PACKAGE_SELF_CHECK_NOT_READY",
          `Work Package ${input.workPackageId} has no successful Attempt awaiting self-check evidence.`,
        );
      }
      if (input.status === "passed") {
        if (
          input.commands.length === 0 ||
          input.logRefs.length === 0 ||
          input.commitEvidence.length === 0
        ) {
          throw new WorkPackageRuntimeError(
            "WORK_PACKAGE_SELF_CHECK_EVIDENCE_REQUIRED",
            "A passing Developer self-check requires commands, logs, and commit evidence.",
          );
        }
        const manifest = parseJson<WorkPackageManifest>(
          assignment.manifestJson,
        );
        const missingCommand = manifest.selfCheckCommands.find(
          (command) => !input.commands.includes(command),
        );
        if (missingCommand) {
          throw new WorkPackageRuntimeError(
            "WORK_PACKAGE_SELF_CHECK_COMMAND_MISSING",
            `Developer self-check did not execute declared command ${missingCommand}.`,
          );
        }
        if (
          !assignment.importedResultCommit ||
          input.commitEvidence.length !== 1 ||
          input.commitEvidence[0] !== assignment.importedResultCommit
        ) {
          throw new WorkPackageRuntimeError(
            "WORK_PACKAGE_SELF_CHECK_COMMIT_MISMATCH",
            "Developer self-check commit evidence must equal the Runtime-imported source commit.",
          );
        }
      }
      const report = {
        status: input.status,
        commands: input.commands,
        logRefs: input.logRefs,
        commitEvidence: input.commitEvidence,
        summary: input.summary,
        approval: false,
      };
      const reportJson = canonicalJson(report);
      const now = clock().toISOString();
      const selfCheckId = randomUUID();
      database
        .prepare(
          `INSERT INTO work_package_self_checks(
             id, assignment_id, node_attempt_id, status, report_json,
             report_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          selfCheckId,
          assignment.id,
          assignment.nodeAttemptId,
          input.status,
          reportJson,
          sha256(reportJson),
          now,
        );
      database
        .prepare(
          `UPDATE work_package_assignments SET state = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.status === "passed" ? "self-check-passed" : "failed",
          now,
          assignment.id,
        );
      database
        .prepare(
          `UPDATE work_packages
              SET state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.status === "passed" ? "self-check" : "failed",
          now,
          input.workPackageId,
        );
      if (input.status === "passed") {
        options.pipelineRuntime.releaseWorkPackageSuccessorsInTransaction({
          runId: workPackage.runId,
          nodeRunId: workPackage.nodeRunId,
          assignmentId: assignment.id,
        });
      }
      appendMutation({
        commandId: input.commandId,
        actor: input.actor,
        action: "work-package.self-check",
        eventType: "work-package.self-check",
        projectId: workPackage.projectId,
        runId: workPackage.runId,
        workPackageId: input.workPackageId,
        workPackageVersionId: workPackage.versionId,
        nodeRunId: workPackage.nodeRunId,
        nodeAttemptId: assignment.nodeAttemptId,
        workspaceAllocationId: assignment.allocationId,
        sessionId: assignment.interactionSessionId,
        payload: {
          workPackageId: input.workPackageId,
          workPackageVersionId: workPackage.versionId,
          state: input.status === "passed" ? "self-check" : "failed",
          selfCheckId,
          status: input.status,
          reportHash: sha256(reportJson),
          approval: false,
        },
        now,
      });
      return inspect(workPackage.runId);
    };

  const reworkInTransaction: WorkPackageRuntime["reworkInTransaction"] = (
    input,
  ) => {
    assertRuntimeActor(input.actor);
    const workPackage = {
      ...currentPackage(input.workPackageId),
      id: input.workPackageId,
    };
    assertRevision(workPackage, input.expectedRevision);
    const manifest = parseJson<WorkPackageManifest>(workPackage.manifestJson);
    const dependencies = database
      .prepare(
        `SELECT predecessor_work_package_version_id AS predecessorWorkPackageVersionId,
                  kind, contract_id AS contractId,
                  contract_version AS contractVersion,
                  evidence_ref AS evidenceRef
             FROM work_package_dependencies WHERE work_package_version_id = ?`,
      )
      .all(workPackage.versionId) as Array<{
      readonly predecessorWorkPackageVersionId: string;
      readonly kind: WorkPackageDependencyKind;
      readonly contractId: string | null;
      readonly contractVersion: string | null;
      readonly evidenceRef: string | null;
    }>;
    const now = clock().toISOString();
    database
      .prepare(
        `UPDATE work_package_assignments SET state = 'superseded', updated_at = ?
            WHERE work_package_version_id = ? AND state <> 'superseded'`,
      )
      .run(now, workPackage.versionId);
    database
      .prepare(
        `UPDATE work_package_versions SET status = 'superseded'
            WHERE id = ?`,
      )
      .run(workPackage.versionId);
    insertVersion({
      workPackageId: input.workPackageId,
      versionId: input.versionId,
      version: Number(workPackage.version) + 1,
      applicationId: workPackage.applicationId,
      repositoryReference: workPackage.repositoryReference,
      nodeRunId: workPackage.nodeRunId,
      manifest: {
        ...manifest,
        recoveryPolicy: input.recoveryReason,
      },
      dependencies: dependencies.map((dependency) => ({
        predecessorWorkPackageVersionId:
          input.dependencyVersionReplacements?.[
            dependency.predecessorWorkPackageVersionId
          ] ?? dependency.predecessorWorkPackageVersionId,
        kind: dependency.kind,
        ...(dependency.contractId ? { contractId: dependency.contractId } : {}),
        ...(dependency.contractVersion
          ? { contractVersion: dependency.contractVersion }
          : {}),
        ...(dependency.evidenceRef
          ? { evidenceRef: dependency.evidenceRef }
          : {}),
      })),
      now,
    });
    database
      .prepare(
        `UPDATE work_packages
              SET state = 'ready', revision = revision + 1, updated_at = ?
            WHERE id = ?`,
      )
      .run(now, input.workPackageId);
    const revised = {
      ...currentPackage(input.workPackageId),
      id: input.workPackageId,
    };
    assignCurrentVersion({
      commandId: input.commandId,
      actor: input.actor,
      workPackage: revised,
      baseCommit: input.baseCommit,
      reason: "retry",
    });
    appendMutation({
      commandId: input.commandId,
      actor: input.actor,
      action: "work-package.rework",
      eventType: "work-package.versioned",
      projectId: workPackage.projectId,
      runId: workPackage.runId,
      workPackageId: input.workPackageId,
      workPackageVersionId: input.versionId,
      nodeRunId: workPackage.nodeRunId,
      payload: {
        workPackageId: input.workPackageId,
        workPackageVersionId: input.versionId,
        supersedesWorkPackageVersionId: workPackage.versionId,
        state: "assigned",
        recoveryReason: input.recoveryReason,
      },
      now,
    });
    return inspect(workPackage.runId);
  };

  return {
    inspect,
    generateInTransaction,
    versionInTransaction,
    assignInTransaction,
    startInTransaction,
    reworkInTransaction,
    recordSelfCheckInTransaction,
  };
};
