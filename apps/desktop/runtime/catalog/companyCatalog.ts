import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactContractSchema,
  DepartmentPipelineDraftGraphSchema,
  DepartmentPipelineGraphSchema,
  ExecutionProfileSchema,
  SecretReferenceSchema,
  type ArtifactContract,
  type CompanyDepartment,
  type CompanyOverview,
  type CompanyProject,
  type DepartmentInspect,
} from "../interface.js";
import {
  canonicalPipelineJson,
  pipelineHash,
} from "../pipeline/canonicalPipeline.js";
import type { SkillConfiguration } from "../skill/skillConfiguration.js";

export interface CompanyCatalog {
  readonly overview: () => CompanyOverview;
  readonly projects: () => readonly CompanyProject[];
  readonly createProject: (input: {
    readonly name: string;
    readonly goal: string;
  }) => CompanyProject;
  readonly departments: () => readonly CompanyDepartment[];
  readonly createDepartment: (input: {
    readonly name: string;
  }) => CompanyDepartment;
  readonly updateDepartment: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly inputArtifactContracts: readonly ArtifactContract[];
    readonly outputArtifactContracts: readonly ArtifactContract[];
    readonly defaultExecutionProfileId: string | null;
  }) => DepartmentInspect;
  readonly archiveDepartment: (input: {
    readonly departmentId: string;
    readonly expectedRevision: number;
  }) => DepartmentInspect;
  readonly createPosition: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
  }) => DepartmentInspect;
  readonly updatePosition: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly responsibility: string;
    readonly aiMemberDisplayName: string;
    readonly aiMemberProfile: string;
    readonly aiMemberResponsibilityMetadata: Readonly<Record<string, string>>;
    readonly aiMemberStatus: "active" | "inactive";
  }) => DepartmentInspect;
  readonly archivePosition: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
  }) => DepartmentInspect;
  readonly createSecretReference: (input: {
    readonly departmentId: string;
    readonly name: string;
    readonly providerScope: string;
  }) => DepartmentInspect;
  readonly archiveSecretReference: (input: {
    readonly departmentId: string;
    readonly secretReferenceId: string;
  }) => DepartmentInspect;
  readonly saveExecutionProfile: (input: {
    readonly departmentId: string;
    readonly executionProfileId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly providerRef: string;
    readonly model: string;
    readonly sandboxRef: string;
    readonly branchStrategy: "head" | "merge-to-head" | "branch";
    readonly timeoutSeconds: number;
    readonly maxIterations: number;
    readonly maxTokens: number | null;
    readonly retryMaxAttempts: number;
    readonly permissionPolicy: "ask" | "allow-safe" | "deny";
    readonly secretReferenceIds: readonly string[];
  }) => DepartmentInspect;
  readonly archiveExecutionProfile: (input: {
    readonly departmentId: string;
    readonly executionProfileId: string;
    readonly expectedRevision: number;
  }) => DepartmentInspect;
  readonly copyDepartment: (input: {
    readonly departmentId: string;
    readonly name: string;
  }) => DepartmentInspect;
  readonly inspectDepartment: (departmentId: string) => DepartmentInspect;
}

export class CompanyCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyCatalogError";
  }
}

export const openCompanyCatalog = (
  database: DatabaseSync,
  companyName: string,
  skillConfiguration: SkillConfiguration,
): CompanyCatalog => {
  database
    .prepare(
      `INSERT INTO company_profile(id, name, default_locale, created_at)
       VALUES ('company', ?, 'en', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    )
    .run(companyName, new Date().toISOString());

  const projects = (): readonly CompanyProject[] =>
    (
      database
        .prepare(
          "SELECT id, name, goal, status, created_at AS createdAt FROM projects WHERE status = 'active' ORDER BY created_at, id",
        )
        .all() as Array<CompanyProject>
    ).map((project) => ({ ...project }));

  const departments = (): readonly CompanyDepartment[] =>
    (
      database
        .prepare(
          `SELECT departments.id,
                  departments.name,
                  departments.description,
                  departments.status,
                  departments.revision,
                  departments.built_in AS builtIn,
                  departments.created_at AS createdAt,
                  COUNT(DISTINCT active_runs.id) AS activeRuns,
                  COUNT(DISTINCT positions.id) AS positionCount,
                  pipeline_versions.version AS publishedPipelineVersion
             FROM departments
        LEFT JOIN department_runs AS active_runs
               ON active_runs.department_id = departments.id
              AND active_runs.status IN ('running', 'paused', 'recovering', 'waiting-approval')
        LEFT JOIN positions
               ON positions.department_id = departments.id
        LEFT JOIN pipeline_versions
               ON pipeline_versions.id = departments.active_pipeline_version_id
            WHERE departments.status = 'active'
         GROUP BY departments.id
         ORDER BY departments.built_in DESC, departments.created_at, departments.id`,
        )
        .all() as Array<{
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly status: "active" | "archived";
        readonly revision: number;
        readonly builtIn: number;
        readonly createdAt: string;
        readonly activeRuns: number;
        readonly positionCount: number;
        readonly publishedPipelineVersion: number | null;
      }>
    ).map((department) => ({
      ...department,
      builtIn: department.builtIn === 1,
      revision: Number(department.revision),
      activeRuns: Number(department.activeRuns),
      positionCount: Number(department.positionCount),
      publishedPipelineVersion:
        department.publishedPipelineVersion === null
          ? null
          : Number(department.publishedPipelineVersion),
    }));

  const inspectDepartment = (departmentId: string): DepartmentInspect => {
    const department = database
      .prepare(
        `SELECT departments.id,
                departments.name,
                departments.description,
                departments.status,
                departments.revision,
                departments.input_artifact_contracts_json AS inputArtifactContractsJson,
                departments.output_artifact_contracts_json AS outputArtifactContractsJson,
                departments.default_execution_profile_id AS defaultExecutionProfileId,
                departments.built_in AS builtIn,
                departments.created_at AS createdAt,
                COUNT(DISTINCT active_runs.id) AS activeRuns,
                pipeline_versions.id AS pipelineId,
                pipeline_versions.version AS pipelineVersion,
                pipeline_versions.status AS pipelineStatus,
                pipeline_versions.graph_json AS graphJson,
                pipeline_versions.published_at AS publishedAt
           FROM departments
      LEFT JOIN department_runs AS active_runs
             ON active_runs.department_id = departments.id
            AND active_runs.status IN ('running', 'paused', 'recovering', 'waiting-approval')
      LEFT JOIN pipeline_versions
             ON pipeline_versions.id = departments.active_pipeline_version_id
          WHERE departments.id = ?
       GROUP BY departments.id`,
      )
      .get(departmentId) as
      | {
          readonly id: string;
          readonly name: string;
          readonly description: string;
          readonly status: "active" | "archived";
          readonly revision: number;
          readonly inputArtifactContractsJson: string;
          readonly outputArtifactContractsJson: string;
          readonly defaultExecutionProfileId: string | null;
          readonly builtIn: number;
          readonly createdAt: string;
          readonly activeRuns: number;
          readonly pipelineId: string | null;
          readonly pipelineVersion: number | null;
          readonly pipelineStatus: string | null;
          readonly graphJson: string | null;
          readonly publishedAt: string | null;
        }
      | undefined;
    if (!department)
      throw new Error(`Department ${departmentId} was not found.`);
    const positions = (
      database
        .prepare(
          `SELECT positions.id,
                  positions.name,
                  positions.responsibility,
                  positions.revision,
                  positions.status,
                  ai_members.id AS aiMemberId,
                  ai_members.display_name AS aiMemberDisplayName,
                  ai_members.profile AS aiMemberProfile,
                  ai_members.responsibility_metadata_json AS aiMemberResponsibilityMetadataJson,
                  ai_members.status AS aiMemberStatus
             FROM positions
             JOIN ai_members ON ai_members.id = positions.ai_member_id
            WHERE positions.department_id = ?
         ORDER BY positions.sort_order, positions.id`,
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly name: string;
        readonly responsibility: string;
        readonly revision: number;
        readonly status: "active" | "archived";
        readonly aiMemberId: string;
        readonly aiMemberDisplayName: string;
        readonly aiMemberProfile: string;
        readonly aiMemberResponsibilityMetadataJson: string;
        readonly aiMemberStatus: "active" | "inactive";
      }>
    ).map((position) => ({
      id: position.id,
      name: position.name,
      responsibility: position.responsibility,
      revision: Number(position.revision),
      status: position.status,
      aiMember: {
        id: position.aiMemberId,
        displayName: position.aiMemberDisplayName,
        profile: position.aiMemberProfile,
        responsibilityMetadata: JSON.parse(
          position.aiMemberResponsibilityMetadataJson,
        ) as Record<string, string>,
        status: position.aiMemberStatus,
        positionId: position.id,
      },
    }));
    const pipeline =
      department.pipelineId !== null &&
      department.pipelineVersion !== null &&
      department.pipelineStatus === "published" &&
      department.graphJson !== null &&
      department.publishedAt !== null
        ? {
            id: department.pipelineId,
            version: Number(department.pipelineVersion),
            status: "published" as const,
            publishedAt: department.publishedAt,
            ...DepartmentPipelineGraphSchema.parse(
              JSON.parse(department.graphJson),
            ),
          }
        : null;

    const executionProfiles = (
      database
        .prepare(
          `SELECT id,
                  department_id AS departmentId,
                  name,
                  provider_ref AS providerRef,
                  model,
                  sandbox_ref AS sandboxRef,
                  branch_strategy AS branchStrategy,
                  timeout_seconds AS timeoutSeconds,
                  max_iterations AS maxIterations,
                  max_tokens AS maxTokens,
                  retry_max_attempts AS retryMaxAttempts,
                  permission_policy AS permissionPolicy,
                  revision,
                  status,
                  created_at AS createdAt,
                  updated_at AS updatedAt,
                  archived_at AS archivedAt
             FROM execution_profiles
            WHERE department_id = ?
         ORDER BY created_at, id`,
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly departmentId: string;
        readonly name: string;
        readonly providerRef: string;
        readonly model: string;
        readonly sandboxRef: string;
        readonly branchStrategy: "head" | "merge-to-head" | "branch";
        readonly timeoutSeconds: number;
        readonly maxIterations: number;
        readonly maxTokens: number | null;
        readonly retryMaxAttempts: number;
        readonly permissionPolicy: "ask" | "allow-safe" | "deny";
        readonly revision: number;
        readonly status: "active" | "archived";
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly archivedAt: string | null;
      }>
    ).map((profile) =>
      ExecutionProfileSchema.parse({
        id: profile.id,
        departmentId: profile.departmentId,
        name: profile.name,
        providerRef: profile.providerRef,
        model: profile.model,
        sandboxRef: profile.sandboxRef,
        branchStrategy: profile.branchStrategy,
        limits: {
          timeoutSeconds: Number(profile.timeoutSeconds),
          maxIterations: Number(profile.maxIterations),
          maxTokens:
            profile.maxTokens === null ? null : Number(profile.maxTokens),
        },
        retryPolicy: { maxAttempts: Number(profile.retryMaxAttempts) },
        permissionPolicy: profile.permissionPolicy,
        secretReferenceIds: (
          database
            .prepare(
              `SELECT secret_reference_id AS secretReferenceId
                 FROM execution_profile_secret_references
                WHERE execution_profile_id = ?
             ORDER BY sort_order`,
            )
            .all(profile.id) as Array<{ readonly secretReferenceId: string }>
        ).map((reference) => reference.secretReferenceId),
        revision: Number(profile.revision),
        status: profile.status,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        archivedAt: profile.archivedAt,
      }),
    );
    const secretReferences = SecretReferenceSchema.array().parse(
      database
        .prepare(
          `SELECT id,
                  name,
                  provider_scope AS providerScope,
                  status,
                  created_at AS createdAt,
                  archived_at AS archivedAt
             FROM secret_references
         ORDER BY created_at, id`,
        )
        .all(),
    );

    return {
      id: department.id,
      name: department.name,
      description: department.description,
      status: department.status,
      revision: Number(department.revision),
      builtIn: department.builtIn === 1,
      activeRuns: Number(department.activeRuns),
      createdAt: department.createdAt,
      inputArtifactContracts: ArtifactContractSchema.array().parse(
        JSON.parse(department.inputArtifactContractsJson),
      ),
      outputArtifactContracts: ArtifactContractSchema.array().parse(
        JSON.parse(department.outputArtifactContractsJson),
      ),
      defaultExecutionProfileId: department.defaultExecutionProfileId,
      executionProfiles,
      secretReferences,
      positions,
      pipeline,
    };
  };

  return {
    overview: () => {
      const profile = database
        .prepare("SELECT id, name FROM company_profile WHERE id = 'company'")
        .get() as { readonly id: string; readonly name: string };
      const count = (table: string): number =>
        Number(
          (
            database
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get() as {
              readonly count: number;
            }
          ).count,
        );
      const statusCount = (status: string): number =>
        Number(
          (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM department_runs WHERE status = ?",
              )
              .get(status) as { readonly count: number }
          ).count,
        );
      return {
        company: profile,
        metrics: {
          activeRuns:
            statusCount("running") +
            statusCount("paused") +
            statusCount("recovering"),
          waitingApprovalRuns: statusCount("waiting-approval"),
          blockedRuns: statusCount("blocked"),
          completedRuns: statusCount("completed"),
          projects: count("projects"),
          departments: count("departments"),
          artifacts: count("artifacts"),
        },
        attention: [],
      };
    },
    projects,
    createProject: ({ name, goal }) => {
      const project: CompanyProject = {
        id: randomUUID(),
        name,
        goal,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      database
        .prepare(
          "INSERT INTO projects(id, company_id, name, goal, status, created_at) VALUES (?, 'company', ?, ?, ?, ?)",
        )
        .run(
          project.id,
          project.name,
          project.goal,
          project.status,
          project.createdAt,
        );
      return project;
    },
    departments,
    createDepartment: ({ name }) => {
      const department: CompanyDepartment = {
        id: randomUUID(),
        name,
        description: "",
        status: "active",
        revision: 0,
        builtIn: false,
        activeRuns: 0,
        positionCount: 0,
        publishedPipelineVersion: null,
        createdAt: new Date().toISOString(),
      };
      database
        .prepare(
          `INSERT INTO departments(
             id, company_id, name, status, created_at, description, built_in
           ) VALUES (?, 'company', ?, ?, ?, ?, 0)`,
        )
        .run(
          department.id,
          department.name,
          department.status,
          department.createdAt,
          department.description,
        );
      return department;
    },
    updateDepartment: ({
      departmentId,
      expectedRevision,
      name,
      description,
      inputArtifactContracts,
      outputArtifactContracts,
      defaultExecutionProfileId,
    }) => {
      const validateContractIds = (
        contracts: readonly ArtifactContract[],
        direction: "input" | "output",
      ): void => {
        const parsed = ArtifactContractSchema.array().parse(contracts);
        if (
          new Set(parsed.map((contract) => contract.id)).size !== parsed.length
        ) {
          throw new CompanyCatalogError(
            "ARTIFACT_CONTRACT_DUPLICATE",
            `Department ${direction} Artifact Contract IDs must be unique.`,
          );
        }
      };
      validateContractIds(inputArtifactContracts, "input");
      validateContractIds(outputArtifactContracts, "output");
      if (defaultExecutionProfileId) {
        const profile = database
          .prepare(
            "SELECT 1 AS present FROM execution_profiles WHERE id = ? AND department_id = ? AND status = 'active'",
          )
          .get(defaultExecutionProfileId, departmentId);
        if (!profile) {
          throw new CompanyCatalogError(
            "EXECUTION_PROFILE_OUTSIDE_DEPARTMENT",
            `Execution Profile ${defaultExecutionProfileId} is not active in Department ${departmentId}.`,
          );
        }
      }
      const result = database
        .prepare(
          `UPDATE departments
              SET name = ?,
                  description = ?,
                  input_artifact_contracts_json = ?,
                  output_artifact_contracts_json = ?,
                  default_execution_profile_id = ?,
                  revision = revision + 1
            WHERE id = ? AND revision = ?`,
        )
        .run(
          name,
          description,
          JSON.stringify(inputArtifactContracts),
          JSON.stringify(outputArtifactContracts),
          defaultExecutionProfileId,
          departmentId,
          expectedRevision,
        );
      if (result.changes === 0) {
        const exists = database
          .prepare("SELECT 1 AS present FROM departments WHERE id = ?")
          .get(departmentId);
        throw new CompanyCatalogError(
          exists ? "VERSION_CONFLICT" : "DEPARTMENT_NOT_FOUND",
          exists
            ? `Department revision ${expectedRevision} is stale.`
            : `Department ${departmentId} was not found.`,
        );
      }
      return inspectDepartment(departmentId);
    },
    archiveDepartment: ({ departmentId, expectedRevision }) => {
      const result = database
        .prepare(
          "UPDATE departments SET status = 'archived', revision = revision + 1 WHERE id = ? AND revision = ?",
        )
        .run(departmentId, expectedRevision);
      if (result.changes === 0) {
        const exists = database
          .prepare("SELECT 1 AS present FROM departments WHERE id = ?")
          .get(departmentId);
        throw new CompanyCatalogError(
          exists ? "VERSION_CONFLICT" : "DEPARTMENT_NOT_FOUND",
          exists
            ? `Department revision ${expectedRevision} is stale.`
            : `Department ${departmentId} was not found.`,
        );
      }
      return inspectDepartment(departmentId);
    },
    createPosition: ({
      departmentId,
      name,
      responsibility,
      aiMemberDisplayName,
      aiMemberProfile,
      aiMemberResponsibilityMetadata,
    }) => {
      const department = database
        .prepare(
          "SELECT 1 AS present FROM departments WHERE id = ? AND status = 'active'",
        )
        .get(departmentId);
      if (!department) {
        throw new CompanyCatalogError(
          "DEPARTMENT_NOT_FOUND",
          `Active Department ${departmentId} was not found.`,
        );
      }
      const positionId = randomUUID();
      const memberId = randomUUID();
      const createdAt = new Date().toISOString();
      const sortOrder =
        Number(
          (
            database
              .prepare(
                "SELECT MAX(sort_order) AS sortOrder FROM positions WHERE department_id = ?",
              )
              .get(departmentId) as { readonly sortOrder: number | null }
          ).sortOrder ?? -1,
        ) + 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT INTO ai_members(
               id, department_id, display_name, status, created_at, profile,
               responsibility_metadata_json
             ) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            memberId,
            departmentId,
            aiMemberDisplayName,
            createdAt,
            aiMemberProfile,
            JSON.stringify(aiMemberResponsibilityMetadata),
          );
        database
          .prepare(
            `INSERT INTO positions(
               id, department_id, name, responsibility, ai_member_id, sort_order,
               created_at, revision, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
          )
          .run(
            positionId,
            departmentId,
            name,
            responsibility,
            memberId,
            sortOrder,
            createdAt,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectDepartment(departmentId);
    },
    updatePosition: ({
      departmentId,
      positionId,
      expectedRevision,
      name,
      responsibility,
      aiMemberDisplayName,
      aiMemberProfile,
      aiMemberResponsibilityMetadata,
      aiMemberStatus,
    }) => {
      const position = database
        .prepare(
          `SELECT ai_member_id AS aiMemberId, revision, status
             FROM positions
            WHERE id = ? AND department_id = ?`,
        )
        .get(positionId, departmentId) as
        | {
            readonly aiMemberId: string;
            readonly revision: number;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (!position) {
        throw new CompanyCatalogError(
          "POSITION_OUTSIDE_DEPARTMENT",
          `Position ${positionId} does not belong to Department ${departmentId}.`,
        );
      }
      if (position.status === "archived") {
        throw new CompanyCatalogError(
          "POSITION_ARCHIVED",
          `Position ${positionId} is archived.`,
        );
      }
      if (Number(position.revision) !== expectedRevision) {
        throw new CompanyCatalogError(
          "VERSION_CONFLICT",
          `Position revision ${expectedRevision} does not match current revision ${position.revision}.`,
        );
      }

      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database
          .prepare(
            `UPDATE positions
                SET name = ?, responsibility = ?, revision = revision + 1
              WHERE id = ? AND department_id = ? AND revision = ? AND status = 'active'`,
          )
          .run(
            name,
            responsibility,
            positionId,
            departmentId,
            expectedRevision,
          );
        if (result.changes === 0) {
          throw new CompanyCatalogError(
            "VERSION_CONFLICT",
            `Position revision ${expectedRevision} changed before save.`,
          );
        }
        database
          .prepare(
            `UPDATE ai_members
                SET display_name = ?, profile = ?, responsibility_metadata_json = ?, status = ?
              WHERE id = ? AND department_id = ?`,
          )
          .run(
            aiMemberDisplayName,
            aiMemberProfile,
            JSON.stringify(aiMemberResponsibilityMetadata),
            aiMemberStatus,
            position.aiMemberId,
            departmentId,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectDepartment(departmentId);
    },
    archivePosition: ({ departmentId, positionId, expectedRevision }) => {
      const position = database
        .prepare(
          `SELECT ai_member_id AS aiMemberId, revision, status
             FROM positions
            WHERE id = ? AND department_id = ?`,
        )
        .get(positionId, departmentId) as
        | {
            readonly aiMemberId: string;
            readonly revision: number;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (!position) {
        throw new CompanyCatalogError(
          "POSITION_OUTSIDE_DEPARTMENT",
          `Position ${positionId} does not belong to Department ${departmentId}.`,
        );
      }
      if (position.status === "archived") {
        throw new CompanyCatalogError(
          "POSITION_ARCHIVED",
          `Position ${positionId} is already archived.`,
        );
      }
      if (Number(position.revision) !== expectedRevision) {
        throw new CompanyCatalogError(
          "VERSION_CONFLICT",
          `Position revision ${expectedRevision} does not match current revision ${position.revision}.`,
        );
      }
      const activeFlow = database
        .prepare(
          "SELECT 1 AS present FROM skill_flows WHERE position_id = ? AND status = 'active' LIMIT 1",
        )
        .get(positionId);
      const graphReferencesPosition = (graphJson: string | null): boolean =>
        graphJson
          ? DepartmentPipelineDraftGraphSchema.parse(
              JSON.parse(graphJson),
            ).nodes.some((node) => node.positionId === positionId)
          : false;
      const draft = database
        .prepare(
          "SELECT graph_json AS graphJson FROM pipeline_drafts WHERE department_id = ?",
        )
        .get(departmentId) as { readonly graphJson: string } | undefined;
      const activeVersion = database
        .prepare(
          `SELECT pipeline_versions.graph_json AS graphJson
             FROM departments
             LEFT JOIN pipeline_versions
               ON pipeline_versions.id = departments.active_pipeline_version_id
            WHERE departments.id = ?`,
        )
        .get(departmentId) as { readonly graphJson: string | null } | undefined;
      if (
        activeFlow ||
        graphReferencesPosition(draft?.graphJson ?? null) ||
        graphReferencesPosition(activeVersion?.graphJson ?? null)
      ) {
        throw new CompanyCatalogError(
          "POSITION_IN_USE",
          `Position ${positionId} is referenced by an active Skill Flow, Pipeline Draft, or active Pipeline Version.`,
        );
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database
          .prepare(
            `UPDATE positions
                SET status = 'archived', revision = revision + 1
              WHERE id = ? AND department_id = ? AND revision = ? AND status = 'active'`,
          )
          .run(positionId, departmentId, expectedRevision);
        if (result.changes === 0) {
          throw new CompanyCatalogError(
            "VERSION_CONFLICT",
            `Position revision ${expectedRevision} changed before archive.`,
          );
        }
        database
          .prepare("UPDATE ai_members SET status = 'inactive' WHERE id = ?")
          .run(position.aiMemberId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectDepartment(departmentId);
    },
    createSecretReference: ({ departmentId, name, providerScope }) => {
      inspectDepartment(departmentId);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO secret_references(
             id, company_id, name, provider_scope, status, created_at, archived_at
           ) VALUES (?, 'company', ?, ?, 'active', ?, NULL)`,
        )
        .run(id, name, providerScope, createdAt);
      return inspectDepartment(departmentId);
    },
    archiveSecretReference: ({ departmentId, secretReferenceId }) => {
      inspectDepartment(departmentId);
      const reference = database
        .prepare("SELECT status FROM secret_references WHERE id = ?")
        .get(secretReferenceId) as
        | { readonly status: "active" | "archived" }
        | undefined;
      if (!reference) {
        throw new CompanyCatalogError(
          "SECRET_REFERENCE_NOT_FOUND",
          `Secret Reference ${secretReferenceId} was not found.`,
        );
      }
      if (reference.status === "archived") {
        throw new CompanyCatalogError(
          "SECRET_REFERENCE_ARCHIVED",
          `Secret Reference ${secretReferenceId} is already archived.`,
        );
      }
      const inUse = database
        .prepare(
          `SELECT 1 AS present
             FROM execution_profile_secret_references
             JOIN execution_profiles
               ON execution_profiles.id = execution_profile_secret_references.execution_profile_id
            WHERE execution_profile_secret_references.secret_reference_id = ?
              AND execution_profiles.status = 'active'
            LIMIT 1`,
        )
        .get(secretReferenceId);
      if (inUse) {
        throw new CompanyCatalogError(
          "SECRET_REFERENCE_IN_USE",
          `Secret Reference ${secretReferenceId} is used by an active Execution Profile.`,
        );
      }
      const archivedAt = new Date().toISOString();
      database
        .prepare(
          "UPDATE secret_references SET status = 'archived', archived_at = ? WHERE id = ?",
        )
        .run(archivedAt, secretReferenceId);
      return inspectDepartment(departmentId);
    },
    saveExecutionProfile: (input) => {
      inspectDepartment(input.departmentId);
      if (
        new Set(input.secretReferenceIds).size !==
        input.secretReferenceIds.length
      ) {
        throw new CompanyCatalogError(
          "SECRET_REFERENCE_DUPLICATE",
          "Execution Profile Secret References must be unique.",
        );
      }
      for (const referenceId of input.secretReferenceIds) {
        const reference = database
          .prepare(
            "SELECT 1 AS present FROM secret_references WHERE id = ? AND status = 'active'",
          )
          .get(referenceId);
        if (!reference) {
          throw new CompanyCatalogError(
            "SECRET_REFERENCE_NOT_FOUND",
            `Active Secret Reference ${referenceId} was not found.`,
          );
        }
      }
      const existing = input.executionProfileId
        ? (database
            .prepare(
              `SELECT department_id AS departmentId, revision, status
                 FROM execution_profiles
                WHERE id = ?`,
            )
            .get(input.executionProfileId) as
            | {
                readonly departmentId: string;
                readonly revision: number;
                readonly status: "active" | "archived";
              }
            | undefined)
        : undefined;
      if (input.executionProfileId && !existing) {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_NOT_FOUND",
          `Execution Profile ${input.executionProfileId} was not found.`,
        );
      }
      if (
        existing?.departmentId !== undefined &&
        existing.departmentId !== input.departmentId
      ) {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_OUTSIDE_DEPARTMENT",
          `Execution Profile ${input.executionProfileId} does not belong to Department ${input.departmentId}.`,
        );
      }
      if (existing?.status === "archived") {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_ARCHIVED",
          `Execution Profile ${input.executionProfileId} is archived.`,
        );
      }
      const currentRevision = Number(existing?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new CompanyCatalogError(
          "VERSION_CONFLICT",
          `Execution Profile revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const id = input.executionProfileId ?? randomUUID();
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        if (existing) {
          const result = database
            .prepare(
              `UPDATE execution_profiles
                  SET name = ?, provider_ref = ?, model = ?, sandbox_ref = ?,
                      branch_strategy = ?, timeout_seconds = ?, max_iterations = ?,
                      max_tokens = ?, retry_max_attempts = ?, permission_policy = ?,
                      revision = revision + 1, updated_at = ?
                WHERE id = ? AND department_id = ? AND revision = ? AND status = 'active'`,
            )
            .run(
              input.name,
              input.providerRef,
              input.model,
              input.sandboxRef,
              input.branchStrategy,
              input.timeoutSeconds,
              input.maxIterations,
              input.maxTokens,
              input.retryMaxAttempts,
              input.permissionPolicy,
              now,
              id,
              input.departmentId,
              input.expectedRevision,
            );
          if (result.changes === 0) {
            throw new CompanyCatalogError(
              "VERSION_CONFLICT",
              `Execution Profile revision ${input.expectedRevision} changed before save.`,
            );
          }
          database
            .prepare(
              "DELETE FROM execution_profile_secret_references WHERE execution_profile_id = ?",
            )
            .run(id);
        } else {
          database
            .prepare(
              `INSERT INTO execution_profiles(
                 id, department_id, name, provider_ref, model, sandbox_ref,
                 branch_strategy, timeout_seconds, max_iterations, max_tokens,
                 retry_max_attempts, permission_policy, revision, status,
                 created_at, updated_at, archived_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, NULL)`,
            )
            .run(
              id,
              input.departmentId,
              input.name,
              input.providerRef,
              input.model,
              input.sandboxRef,
              input.branchStrategy,
              input.timeoutSeconds,
              input.maxIterations,
              input.maxTokens,
              input.retryMaxAttempts,
              input.permissionPolicy,
              now,
              now,
            );
        }
        const insertReference = database.prepare(
          `INSERT INTO execution_profile_secret_references(
             execution_profile_id, secret_reference_id, sort_order
           ) VALUES (?, ?, ?)`,
        );
        input.secretReferenceIds.forEach((referenceId, index) => {
          insertReference.run(id, referenceId, index);
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectDepartment(input.departmentId);
    },
    archiveExecutionProfile: ({
      departmentId,
      executionProfileId,
      expectedRevision,
    }) => {
      const profile = database
        .prepare(
          `SELECT revision, status
             FROM execution_profiles
            WHERE id = ? AND department_id = ?`,
        )
        .get(executionProfileId, departmentId) as
        | {
            readonly revision: number;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (!profile) {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_OUTSIDE_DEPARTMENT",
          `Execution Profile ${executionProfileId} does not belong to Department ${departmentId}.`,
        );
      }
      if (profile.status === "archived") {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_ARCHIVED",
          `Execution Profile ${executionProfileId} is already archived.`,
        );
      }
      if (Number(profile.revision) !== expectedRevision) {
        throw new CompanyCatalogError(
          "VERSION_CONFLICT",
          `Execution Profile revision ${expectedRevision} does not match current revision ${profile.revision}.`,
        );
      }
      const defaultUse = database
        .prepare(
          "SELECT 1 AS present FROM departments WHERE id = ? AND default_execution_profile_id = ?",
        )
        .get(departmentId, executionProfileId);
      const graphUsesProfile = (graphJson: string | null): boolean =>
        graphJson
          ? DepartmentPipelineDraftGraphSchema.parse(
              JSON.parse(graphJson),
            ).nodes.some(
              (node) => node.executionProfileId === executionProfileId,
            )
          : false;
      const draft = database
        .prepare(
          "SELECT graph_json AS graphJson FROM pipeline_drafts WHERE department_id = ?",
        )
        .get(departmentId) as { readonly graphJson: string } | undefined;
      const activeVersion = database
        .prepare(
          `SELECT pipeline_versions.graph_json AS graphJson
             FROM departments
             LEFT JOIN pipeline_versions
               ON pipeline_versions.id = departments.active_pipeline_version_id
            WHERE departments.id = ?`,
        )
        .get(departmentId) as { readonly graphJson: string | null } | undefined;
      if (
        defaultUse ||
        graphUsesProfile(draft?.graphJson ?? null) ||
        graphUsesProfile(activeVersion?.graphJson ?? null)
      ) {
        throw new CompanyCatalogError(
          "EXECUTION_PROFILE_IN_USE",
          `Execution Profile ${executionProfileId} is the Department default or is referenced by the current Pipeline.`,
        );
      }
      const archivedAt = new Date().toISOString();
      const result = database
        .prepare(
          `UPDATE execution_profiles
              SET status = 'archived', revision = revision + 1,
                  updated_at = ?, archived_at = ?
            WHERE id = ? AND department_id = ? AND revision = ? AND status = 'active'`,
        )
        .run(
          archivedAt,
          archivedAt,
          executionProfileId,
          departmentId,
          expectedRevision,
        );
      if (result.changes === 0) {
        throw new CompanyCatalogError(
          "VERSION_CONFLICT",
          `Execution Profile revision ${expectedRevision} changed before archive.`,
        );
      }
      return inspectDepartment(departmentId);
    },
    copyDepartment: ({ departmentId, name }) => {
      const source = inspectDepartment(departmentId);
      const copiedDepartmentId = randomUUID();
      const copiedAt = new Date().toISOString();
      const positionIds = new Map(
        source.positions.map((position) => [position.id, randomUUID()]),
      );
      const memberIds = new Map(
        source.positions.map((position) => [
          position.aiMember.id,
          randomUUID(),
        ]),
      );
      const executionProfileIds = new Map(
        source.executionProfiles.map((profile) => [profile.id, randomUUID()]),
      );
      const copiedPipelineId = source.pipeline ? randomUUID() : null;
      const copiedDefaultExecutionProfileId = source.defaultExecutionProfileId
        ? (executionProfileIds.get(source.defaultExecutionProfileId) ?? null)
        : null;

      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT INTO departments(
               id, company_id, name, status, created_at, description, built_in,
               active_pipeline_version_id, revision, input_artifact_contracts_json,
               output_artifact_contracts_json, default_execution_profile_id
             ) VALUES (?, 'company', ?, 'active', ?, ?, 0, ?, 0, ?, ?, ?)`,
          )
          .run(
            copiedDepartmentId,
            name,
            copiedAt,
            source.description,
            copiedPipelineId,
            JSON.stringify(source.inputArtifactContracts),
            JSON.stringify(source.outputArtifactContracts),
            copiedDefaultExecutionProfileId,
          );

        const insertMember = database.prepare(
          `INSERT INTO ai_members(
             id, department_id, display_name, status, created_at, profile,
             responsibility_metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertPosition = database.prepare(
          `INSERT INTO positions(
             id, department_id, name, responsibility, ai_member_id, sort_order,
             created_at, revision, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        );
        source.positions.forEach((position, index) => {
          const memberId = memberIds.get(position.aiMember.id);
          const positionId = positionIds.get(position.id);
          if (!memberId || !positionId) {
            throw new Error("Department copy ID mapping was incomplete.");
          }
          insertMember.run(
            memberId,
            copiedDepartmentId,
            position.aiMember.displayName,
            position.aiMember.status,
            copiedAt,
            position.aiMember.profile,
            JSON.stringify(position.aiMember.responsibilityMetadata),
          );
          insertPosition.run(
            positionId,
            copiedDepartmentId,
            position.name,
            position.responsibility,
            memberId,
            index,
            copiedAt,
            position.status,
          );
        });

        const insertProfile = database.prepare(
          `INSERT INTO execution_profiles(
             id, department_id, name, provider_ref, model, sandbox_ref,
             branch_strategy, timeout_seconds, max_iterations, max_tokens,
             retry_max_attempts, permission_policy, revision, status,
             created_at, updated_at, archived_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        );
        const insertProfileReference = database.prepare(
          `INSERT INTO execution_profile_secret_references(
             execution_profile_id, secret_reference_id, sort_order
           ) VALUES (?, ?, ?)`,
        );
        for (const profile of source.executionProfiles) {
          const profileId = executionProfileIds.get(profile.id);
          if (!profileId) {
            throw new Error(
              `Copied Execution Profile mapping is missing ${profile.id}.`,
            );
          }
          insertProfile.run(
            profileId,
            copiedDepartmentId,
            profile.name,
            profile.providerRef,
            profile.model,
            profile.sandboxRef,
            profile.branchStrategy,
            profile.limits.timeoutSeconds,
            profile.limits.maxIterations,
            profile.limits.maxTokens,
            profile.retryPolicy.maxAttempts,
            profile.permissionPolicy,
            profile.status,
            copiedAt,
            copiedAt,
            profile.status === "archived" ? copiedAt : null,
          );
          profile.secretReferenceIds.forEach((referenceId, index) => {
            insertProfileReference.run(profileId, referenceId, index);
          });
        }

        const skillFlowIds = skillConfiguration.copyDepartmentConfiguration({
          sourceDepartmentId: departmentId,
          departmentId: copiedDepartmentId,
          positionIds,
          copiedAt,
        });

        if (source.pipeline && copiedPipelineId) {
          const graph = {
            nodes: source.pipeline.nodes.map((node) => ({
              ...node,
              ...(node.positionId
                ? { positionId: positionIds.get(node.positionId) }
                : {}),
              ...(node.skillFlowId
                ? { skillFlowId: skillFlowIds.get(node.skillFlowId) }
                : {}),
              ...(node.skillFlowSnapshot
                ? {
                    skillFlowSnapshot: {
                      ...node.skillFlowSnapshot,
                      id:
                        skillFlowIds.get(node.skillFlowSnapshot.id) ??
                        node.skillFlowSnapshot.id,
                    },
                  }
                : {}),
              ...(node.executionProfileId
                ? {
                    executionProfileId: executionProfileIds.get(
                      node.executionProfileId,
                    ),
                  }
                : {}),
            })),
            edges: source.pipeline.edges,
          };
          database
            .prepare(
              `INSERT INTO pipeline_versions(
                 id, department_id, version, status, graph_json, published_at, hash
               ) VALUES (?, ?, ?, 'published', ?, ?, ?)`,
            )
            .run(
              copiedPipelineId,
              copiedDepartmentId,
              source.pipeline.version,
              canonicalPipelineJson(graph),
              copiedAt,
              pipelineHash(graph),
            );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspectDepartment(copiedDepartmentId);
    },
    inspectDepartment,
  };
};
