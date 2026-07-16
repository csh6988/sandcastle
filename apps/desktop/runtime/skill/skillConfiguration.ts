import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DepartmentPipelineDraftGraphSchema,
  SkillConfigurationViewSchema,
  type SkillConfigurationView,
} from "../interface.js";

export interface SkillConfiguration {
  readonly inspect: (departmentId: string) => SkillConfigurationView;
  readonly validatePipelineSelection: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly skillFlowId: string;
  }) =>
    | "SKILL_FLOW_NOT_FOUND"
    | "SKILL_FLOW_ARCHIVED"
    | "SKILL_FLOW_OUTSIDE_DEPARTMENT"
    | "SKILL_FLOW_POSITION_MISMATCH"
    | null;
  readonly copyDepartmentConfiguration: (input: {
    readonly sourceDepartmentId: string;
    readonly departmentId: string;
    readonly positionIds: ReadonlyMap<string, string>;
    readonly copiedAt: string;
  }) => ReadonlyMap<string, string>;
  readonly saveSkill: (input: {
    readonly departmentId: string;
    readonly skillId?: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly version: string;
    readonly locationReference: string;
  }) => SkillConfigurationView;
  readonly archiveSkill: (input: {
    readonly departmentId: string;
    readonly skillId: string;
    readonly expectedRevision: number;
  }) => SkillConfigurationView;
  readonly setPositionSkills: (input: {
    readonly departmentId: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly skillIds: readonly string[];
  }) => SkillConfigurationView;
  readonly saveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId?: string;
    readonly positionId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly instructions: string;
    readonly skillIds: readonly string[];
  }) => SkillConfigurationView;
  readonly archiveSkillFlow: (input: {
    readonly departmentId: string;
    readonly skillFlowId: string;
    readonly expectedRevision: number;
  }) => SkillConfigurationView;
}

export class SkillConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillConfigurationError";
  }
}

export const openSkillConfiguration = (
  database: DatabaseSync,
): SkillConfiguration => {
  const requireDepartment = (
    departmentId: string,
  ): { readonly id: string; readonly name: string } => {
    const department = database
      .prepare("SELECT id, name FROM departments WHERE id = ?")
      .get(departmentId) as
      | { readonly id: string; readonly name: string }
      | undefined;
    if (!department) {
      throw new SkillConfigurationError(
        "DEPARTMENT_NOT_FOUND",
        `Department ${departmentId} was not found.`,
      );
    }
    return department;
  };

  const inspect = (departmentId: string): SkillConfigurationView => {
    const department = requireDepartment(departmentId);
    const metadata = database
      .prepare(
        "SELECT revision FROM skill_configuration_metadata WHERE id = 'company'",
      )
      .get() as { readonly revision: number };
    const activeSkills = database
      .prepare(
        `SELECT skills.id,
                skills.name,
                skills.description,
                skills.source,
                skills.version,
                skills.location_ref AS locationReference,
                skills.status,
                skills.created_at AS createdAt,
                skills.archived_at AS archivedAt
           FROM skills
      LEFT JOIN skill_discovery_entries
             ON skill_discovery_entries.id = skills.id
          WHERE skills.status = 'active'
            AND (
              skill_discovery_entries.id IS NULL OR
              skill_discovery_entries.status = 'enabled'
            )
       ORDER BY skills.id`,
      )
      .all();
    const archivedSkills = database
      .prepare(
        `SELECT id, name, source, version, archived_at AS archivedAt
           FROM skills
          WHERE status = 'archived'
       ORDER BY archived_at, id`,
      )
      .all();
    const positions = (
      database
        .prepare(
          `SELECT id, name
             FROM positions
            WHERE department_id = ?
         ORDER BY sort_order, id`,
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly name: string;
      }>
    ).map((position) => ({
      ...position,
      skillIds: (
        database
          .prepare(
            `SELECT skill_id AS skillId
               FROM position_skill_bindings
              WHERE position_id = ?
           ORDER BY skill_id`,
          )
          .all(position.id) as Array<{ readonly skillId: string }>
      ).map((binding) => binding.skillId),
    }));
    const skillFlows = (
      database
        .prepare(
          `SELECT id,
                  department_id AS departmentId,
                  position_id AS positionId,
                  name,
                  instructions,
                  revision,
                  status,
                  created_at AS createdAt,
                  updated_at AS updatedAt,
                  archived_at AS archivedAt
             FROM skill_flows
            WHERE department_id = ?
         ORDER BY sort_order, id`,
        )
        .all(departmentId) as Array<{
        readonly id: string;
        readonly departmentId: string;
        readonly positionId: string;
        readonly name: string;
        readonly instructions: string;
        readonly revision: number;
        readonly status: "active" | "archived";
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly archivedAt: string | null;
      }>
    ).map((flow) => ({
      ...flow,
      skillIds: (
        database
          .prepare(
            `SELECT skill_id AS skillId
               FROM skill_flow_skills
              WHERE skill_flow_id = ?
           ORDER BY sort_order`,
          )
          .all(flow.id) as Array<{ readonly skillId: string }>
      ).map((selection) => selection.skillId),
    }));
    const draft = database
      .prepare(
        "SELECT graph_json AS graphJson FROM pipeline_drafts WHERE department_id = ?",
      )
      .get(departmentId) as { readonly graphJson: string } | undefined;
    const activePipeline = database
      .prepare(
        `SELECT pipeline_versions.graph_json AS graphJson
           FROM departments
           LEFT JOIN pipeline_versions
             ON pipeline_versions.id = departments.active_pipeline_version_id
          WHERE departments.id = ?`,
      )
      .get(departmentId) as { readonly graphJson: string | null } | undefined;
    const pipelineGraph = draft?.graphJson ?? activePipeline?.graphJson ?? null;
    const pipelineNodes = pipelineGraph
      ? DepartmentPipelineDraftGraphSchema.parse(JSON.parse(pipelineGraph))
          .nodes
      : [];

    return SkillConfigurationViewSchema.parse({
      department,
      revision: Number(metadata.revision),
      activeSkills,
      archivedSkills,
      positions,
      skillFlows,
      pipelineNodes,
    });
  };

  return {
    inspect,
    copyDepartmentConfiguration: (input) => {
      const bindings = database
        .prepare(
          `SELECT position_skill_bindings.position_id AS positionId,
                  position_skill_bindings.skill_id AS skillId
             FROM position_skill_bindings
             JOIN positions ON positions.id = position_skill_bindings.position_id
            WHERE positions.department_id = ?
         ORDER BY positions.sort_order, position_skill_bindings.skill_id`,
        )
        .all(input.sourceDepartmentId) as Array<{
        readonly positionId: string;
        readonly skillId: string;
      }>;
      const insertBinding = database.prepare(
        "INSERT INTO position_skill_bindings(position_id, skill_id, bound_at) VALUES (?, ?, ?)",
      );
      for (const binding of bindings) {
        const positionId = input.positionIds.get(binding.positionId);
        if (!positionId) {
          throw new Error(
            `Copied Position mapping is missing ${binding.positionId}.`,
          );
        }
        insertBinding.run(positionId, binding.skillId, input.copiedAt);
      }

      const flows = database
        .prepare(
          `SELECT id,
                  position_id AS positionId,
                  name,
                  instructions,
                  revision,
                  status,
                  sort_order AS sortOrder,
                  archived_at AS archivedAt
             FROM skill_flows
            WHERE department_id = ?
         ORDER BY sort_order, id`,
        )
        .all(input.sourceDepartmentId) as Array<{
        readonly id: string;
        readonly positionId: string;
        readonly name: string;
        readonly instructions: string;
        readonly revision: number;
        readonly status: "active" | "archived";
        readonly sortOrder: number;
        readonly archivedAt: string | null;
      }>;
      const flowIds = new Map(
        flows.map((flow) => [flow.id, randomUUID()] as const),
      );
      const insertFlow = database.prepare(
        `INSERT INTO skill_flows(
           id, department_id, position_id, name, instructions, revision,
           status, sort_order, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSelection = database.prepare(
        "INSERT INTO skill_flow_skills(skill_flow_id, skill_id, sort_order) VALUES (?, ?, ?)",
      );
      for (const flow of flows) {
        const flowId = flowIds.get(flow.id);
        const positionId = input.positionIds.get(flow.positionId);
        if (!flowId || !positionId) {
          throw new Error(
            `Copied Skill Flow mapping is incomplete for ${flow.id}.`,
          );
        }
        insertFlow.run(
          flowId,
          input.departmentId,
          positionId,
          flow.name,
          flow.instructions,
          flow.revision,
          flow.status,
          flow.sortOrder,
          input.copiedAt,
          input.copiedAt,
          flow.status === "archived" ? input.copiedAt : null,
        );
        const selections = database
          .prepare(
            `SELECT skill_id AS skillId, sort_order AS sortOrder
               FROM skill_flow_skills
              WHERE skill_flow_id = ?
           ORDER BY sort_order`,
          )
          .all(flow.id) as Array<{
          readonly skillId: string;
          readonly sortOrder: number;
        }>;
        for (const selection of selections) {
          insertSelection.run(flowId, selection.skillId, selection.sortOrder);
        }
      }
      database
        .prepare(
          "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
        )
        .run(input.copiedAt);
      return flowIds;
    },
    validatePipelineSelection: (input) => {
      const flow = database
        .prepare(
          `SELECT department_id AS departmentId,
                  position_id AS positionId,
                  status
             FROM skill_flows
            WHERE id = ?`,
        )
        .get(input.skillFlowId) as
        | {
            readonly departmentId: string;
            readonly positionId: string;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (!flow) return "SKILL_FLOW_NOT_FOUND";
      if (flow.status === "archived") return "SKILL_FLOW_ARCHIVED";
      if (flow.departmentId !== input.departmentId) {
        return "SKILL_FLOW_OUTSIDE_DEPARTMENT";
      }
      if (flow.positionId !== input.positionId) {
        return "SKILL_FLOW_POSITION_MISMATCH";
      }
      return null;
    },
    saveSkill: (input) => {
      requireDepartment(input.departmentId);
      const existing = input.skillId
        ? (database
            .prepare("SELECT status FROM skills WHERE id = ?")
            .get(input.skillId) as
            | { readonly status: "active" | "archived" }
            | undefined)
        : undefined;
      if (input.skillId && !existing) {
        throw new SkillConfigurationError(
          "SKILL_NOT_FOUND",
          `Skill ${input.skillId} was not found.`,
        );
      }
      if (existing?.status === "archived") {
        throw new SkillConfigurationError(
          "SKILL_ARCHIVED",
          `Skill ${input.skillId} is archived.`,
        );
      }
      const skillId = input.skillId ?? randomUUID();
      const updatedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        const metadata = database
          .prepare(
            "SELECT revision FROM skill_configuration_metadata WHERE id = 'company'",
          )
          .get() as { readonly revision: number };
        const currentRevision = Number(metadata.revision);
        if (currentRevision !== input.expectedRevision) {
          throw new SkillConfigurationError(
            "VERSION_CONFLICT",
            `Skill Configuration revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
          );
        }
        if (existing) {
          database
            .prepare(
              `UPDATE skills
                  SET name = ?,
                      description = ?,
                      source = ?,
                      version = ?,
                      location_ref = ?
                WHERE id = ?`,
            )
            .run(
              input.name,
              input.description,
              input.source,
              input.version,
              input.locationReference,
              skillId,
            );
        } else {
          database
            .prepare(
              `INSERT INTO skills(
                 id, company_id, name, description, source, version, location_ref,
                 status, created_at, archived_at
               ) VALUES (?, 'company', ?, ?, ?, ?, ?, 'active', ?, NULL)`,
            )
            .run(
              skillId,
              input.name,
              input.description,
              input.source,
              input.version,
              input.locationReference,
              updatedAt,
            );
        }
        database
          .prepare(
            "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
          )
          .run(updatedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.departmentId);
    },
    archiveSkill: (input) => {
      requireDepartment(input.departmentId);
      const skill = database
        .prepare("SELECT status FROM skills WHERE id = ?")
        .get(input.skillId) as
        | { readonly status: "active" | "archived" }
        | undefined;
      if (!skill) {
        throw new SkillConfigurationError(
          "SKILL_NOT_FOUND",
          `Skill ${input.skillId} was not found.`,
        );
      }
      if (skill.status === "archived") {
        throw new SkillConfigurationError(
          "SKILL_ARCHIVED",
          `Skill ${input.skillId} is already archived.`,
        );
      }
      const binding = database
        .prepare(
          "SELECT 1 AS present FROM position_skill_bindings WHERE skill_id = ? LIMIT 1",
        )
        .get(input.skillId);
      const activeFlow = database
        .prepare(
          `SELECT 1 AS present
             FROM skill_flow_skills
             JOIN skill_flows ON skill_flows.id = skill_flow_skills.skill_flow_id
            WHERE skill_flow_skills.skill_id = ?
              AND skill_flows.status = 'active'
            LIMIT 1`,
        )
        .get(input.skillId);
      if (binding || activeFlow) {
        throw new SkillConfigurationError(
          "SKILL_IN_USE",
          `Skill ${input.skillId} must be removed from Positions and active Skill Flows before it can be archived.`,
        );
      }

      const archivedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        const metadata = database
          .prepare(
            "SELECT revision FROM skill_configuration_metadata WHERE id = 'company'",
          )
          .get() as { readonly revision: number };
        const currentRevision = Number(metadata.revision);
        if (currentRevision !== input.expectedRevision) {
          throw new SkillConfigurationError(
            "VERSION_CONFLICT",
            `Skill Configuration revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
          );
        }
        database
          .prepare(
            "UPDATE skills SET status = 'archived', archived_at = ? WHERE id = ?",
          )
          .run(archivedAt, input.skillId);
        database
          .prepare(
            "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
          )
          .run(archivedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.departmentId);
    },
    setPositionSkills: (input) => {
      const skillIds = [...new Set(input.skillIds)].sort();
      if (skillIds.length !== input.skillIds.length) {
        throw new SkillConfigurationError(
          "SKILL_SELECTION_DUPLICATE",
          "Position Skill selections must be unique.",
        );
      }
      const position = database
        .prepare("SELECT id FROM positions WHERE id = ? AND department_id = ?")
        .get(input.positionId, input.departmentId);
      if (!position) {
        throw new SkillConfigurationError(
          "POSITION_OUTSIDE_DEPARTMENT",
          `Position ${input.positionId} does not belong to Department ${input.departmentId}.`,
        );
      }
      for (const skillId of skillIds) {
        const skill = database
          .prepare(
            `SELECT skills.status,
                    skill_discovery_entries.status AS discoveryStatus
               FROM skills
          LEFT JOIN skill_discovery_entries
                 ON skill_discovery_entries.id = skills.id
              WHERE skills.id = ?`,
          )
          .get(skillId) as
          | {
              readonly status: "active" | "archived";
              readonly discoveryStatus: string | null;
            }
          | undefined;
        if (!skill) {
          throw new SkillConfigurationError(
            "SKILL_NOT_FOUND",
            `Skill ${skillId} was not found.`,
          );
        }
        if (skill.status === "archived") {
          throw new SkillConfigurationError(
            "SKILL_ARCHIVED",
            `Skill ${skillId} is archived.`,
          );
        }
        if (skill.discoveryStatus && skill.discoveryStatus !== "enabled") {
          throw new SkillConfigurationError(
            "SKILL_UNAVAILABLE",
            `Skill ${skillId} is unavailable on this machine.`,
          );
        }
      }
      const currentSkillIds = (
        database
          .prepare(
            "SELECT skill_id AS skillId FROM position_skill_bindings WHERE position_id = ?",
          )
          .all(input.positionId) as Array<{ readonly skillId: string }>
      ).map((binding) => binding.skillId);
      const requestedSkillIds = new Set(skillIds);
      for (const removedSkillId of currentSkillIds.filter(
        (skillId) => !requestedSkillIds.has(skillId),
      )) {
        const activeFlow = database
          .prepare(
            `SELECT skill_flows.id
               FROM skill_flows
               JOIN skill_flow_skills
                 ON skill_flow_skills.skill_flow_id = skill_flows.id
              WHERE skill_flows.position_id = ?
                AND skill_flows.status = 'active'
                AND skill_flow_skills.skill_id = ?
              LIMIT 1`,
          )
          .get(input.positionId, removedSkillId);
        if (activeFlow) {
          throw new SkillConfigurationError(
            "POSITION_SKILL_IN_USE",
            `Skill ${removedSkillId} must be removed from active Skill Flows before it can be removed from Position ${input.positionId}.`,
          );
        }
      }

      database.exec("BEGIN IMMEDIATE");
      try {
        const metadata = database
          .prepare(
            "SELECT revision FROM skill_configuration_metadata WHERE id = 'company'",
          )
          .get() as { readonly revision: number };
        const currentRevision = Number(metadata.revision);
        if (currentRevision !== input.expectedRevision) {
          throw new SkillConfigurationError(
            "VERSION_CONFLICT",
            `Skill Configuration revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
          );
        }
        database
          .prepare("DELETE FROM position_skill_bindings WHERE position_id = ?")
          .run(input.positionId);
        const insertBinding = database.prepare(
          "INSERT INTO position_skill_bindings(position_id, skill_id, bound_at) VALUES (?, ?, ?)",
        );
        const updatedAt = new Date().toISOString();
        for (const skillId of skillIds) {
          insertBinding.run(input.positionId, skillId, updatedAt);
        }
        database
          .prepare(
            "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
          )
          .run(updatedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.departmentId);
    },
    saveSkillFlow: (input) => {
      const existing = input.skillFlowId
        ? (database
            .prepare(
              `SELECT department_id AS departmentId,
                      position_id AS positionId,
                      revision,
                      status
                 FROM skill_flows
                WHERE id = ?`,
            )
            .get(input.skillFlowId) as
            | {
                readonly departmentId: string;
                readonly positionId: string;
                readonly revision: number;
                readonly status: "active" | "archived";
              }
            | undefined)
        : undefined;
      if (input.skillFlowId && !existing) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_NOT_FOUND",
          `Skill Flow ${input.skillFlowId} was not found.`,
        );
      }
      if (
        existing?.departmentId !== undefined &&
        existing.departmentId !== input.departmentId
      ) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_OUTSIDE_DEPARTMENT",
          `Skill Flow ${input.skillFlowId} does not belong to Department ${input.departmentId}.`,
        );
      }
      if (existing?.status === "archived") {
        throw new SkillConfigurationError(
          "SKILL_FLOW_ARCHIVED",
          `Skill Flow ${input.skillFlowId} is archived.`,
        );
      }
      if (existing && existing.positionId !== input.positionId) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_POSITION_IMMUTABLE",
          `Skill Flow ${input.skillFlowId} cannot move to another Position.`,
        );
      }
      const currentRevision = Number(existing?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new SkillConfigurationError(
          "VERSION_CONFLICT",
          `Skill Flow revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
        );
      }
      const position = database
        .prepare("SELECT id FROM positions WHERE id = ? AND department_id = ?")
        .get(input.positionId, input.departmentId);
      if (!position) {
        throw new SkillConfigurationError(
          "POSITION_OUTSIDE_DEPARTMENT",
          `Position ${input.positionId} does not belong to Department ${input.departmentId}.`,
        );
      }
      const skillIds = [...input.skillIds];
      if (new Set(skillIds).size !== skillIds.length) {
        throw new SkillConfigurationError(
          "SKILL_SELECTION_DUPLICATE",
          "Skill Flow selections must be unique.",
        );
      }
      for (const skillId of skillIds) {
        const skill = database
          .prepare("SELECT status FROM skills WHERE id = ?")
          .get(skillId) as
          | { readonly status: "active" | "archived" }
          | undefined;
        if (!skill) {
          throw new SkillConfigurationError(
            "SKILL_NOT_FOUND",
            `Skill ${skillId} was not found.`,
          );
        }
        if (skill.status !== "active") {
          throw new SkillConfigurationError(
            "SKILL_ARCHIVED",
            `Skill ${skillId} is archived.`,
          );
        }
        const binding = database
          .prepare(
            "SELECT 1 AS present FROM position_skill_bindings WHERE position_id = ? AND skill_id = ?",
          )
          .get(input.positionId, skillId);
        if (!binding) {
          throw new SkillConfigurationError(
            "SKILL_NOT_BOUND_TO_POSITION",
            `Skill ${skillId} is not bound to Position ${input.positionId}.`,
          );
        }
      }

      const skillFlowId = input.skillFlowId ?? randomUUID();
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        if (existing) {
          const current = database
            .prepare(
              "SELECT revision FROM skill_flows WHERE id = ? AND status = 'active'",
            )
            .get(skillFlowId) as { readonly revision: number } | undefined;
          if (Number(current?.revision ?? -1) !== input.expectedRevision) {
            throw new SkillConfigurationError(
              "VERSION_CONFLICT",
              `Skill Flow revision ${input.expectedRevision} changed before save.`,
            );
          }
          database
            .prepare(
              `UPDATE skill_flows
                  SET name = ?,
                      instructions = ?,
                      revision = revision + 1,
                      updated_at = ?
                WHERE id = ?`,
            )
            .run(input.name, input.instructions, now, skillFlowId);
          database
            .prepare("DELETE FROM skill_flow_skills WHERE skill_flow_id = ?")
            .run(skillFlowId);
        } else {
          const sortOrder =
            Number(
              (
                database
                  .prepare(
                    "SELECT MAX(sort_order) AS sortOrder FROM skill_flows WHERE department_id = ?",
                  )
                  .get(input.departmentId) as {
                  readonly sortOrder: number | null;
                }
              ).sortOrder ?? -1,
            ) + 1;
          database
            .prepare(
              `INSERT INTO skill_flows(
                 id, department_id, position_id, name, instructions, revision,
                 status, sort_order, created_at, updated_at, archived_at
               ) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, NULL)`,
            )
            .run(
              skillFlowId,
              input.departmentId,
              input.positionId,
              input.name,
              input.instructions,
              sortOrder,
              now,
              now,
            );
        }
        const insertSelection = database.prepare(
          "INSERT INTO skill_flow_skills(skill_flow_id, skill_id, sort_order) VALUES (?, ?, ?)",
        );
        skillIds.forEach((skillId, index) => {
          insertSelection.run(skillFlowId, skillId, index);
        });
        database
          .prepare(
            "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
          )
          .run(now);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.departmentId);
    },
    archiveSkillFlow: (input) => {
      const flow = database
        .prepare(
          `SELECT department_id AS departmentId, revision, status
             FROM skill_flows
            WHERE id = ?`,
        )
        .get(input.skillFlowId) as
        | {
            readonly departmentId: string;
            readonly revision: number;
            readonly status: "active" | "archived";
          }
        | undefined;
      if (!flow) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_NOT_FOUND",
          `Skill Flow ${input.skillFlowId} was not found.`,
        );
      }
      if (flow.departmentId !== input.departmentId) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_OUTSIDE_DEPARTMENT",
          `Skill Flow ${input.skillFlowId} does not belong to Department ${input.departmentId}.`,
        );
      }
      if (flow.status === "archived") {
        throw new SkillConfigurationError(
          "SKILL_FLOW_ARCHIVED",
          `Skill Flow ${input.skillFlowId} is already archived.`,
        );
      }
      if (Number(flow.revision) !== input.expectedRevision) {
        throw new SkillConfigurationError(
          "VERSION_CONFLICT",
          `Skill Flow revision ${input.expectedRevision} does not match current revision ${flow.revision}.`,
        );
      }
      const graphUsesSkillFlow = (graphJson: string | null): boolean => {
        if (!graphJson) return false;
        return DepartmentPipelineDraftGraphSchema.parse(
          JSON.parse(graphJson),
        ).nodes.some((node) => node.skillFlowId === input.skillFlowId);
      };
      const draft = database
        .prepare(
          "SELECT graph_json AS graphJson FROM pipeline_drafts WHERE department_id = ?",
        )
        .get(input.departmentId) as { readonly graphJson: string } | undefined;
      const activeVersion = database
        .prepare(
          `SELECT pipeline_versions.graph_json AS graphJson
             FROM departments
             LEFT JOIN pipeline_versions
               ON pipeline_versions.id = departments.active_pipeline_version_id
            WHERE departments.id = ?`,
        )
        .get(input.departmentId) as
        | { readonly graphJson: string | null }
        | undefined;
      if (
        graphUsesSkillFlow(draft?.graphJson ?? null) ||
        graphUsesSkillFlow(activeVersion?.graphJson ?? null)
      ) {
        throw new SkillConfigurationError(
          "SKILL_FLOW_IN_USE",
          `Skill Flow ${input.skillFlowId} must be removed from the current Pipeline Draft and active Pipeline Version before it can be archived.`,
        );
      }

      const archivedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database
          .prepare(
            `UPDATE skill_flows
                SET status = 'archived',
                    revision = revision + 1,
                    updated_at = ?,
                    archived_at = ?
              WHERE id = ? AND revision = ? AND status = 'active'`,
          )
          .run(
            archivedAt,
            archivedAt,
            input.skillFlowId,
            input.expectedRevision,
          );
        if (result.changes === 0) {
          throw new SkillConfigurationError(
            "VERSION_CONFLICT",
            `Skill Flow revision ${input.expectedRevision} changed before archive.`,
          );
        }
        database
          .prepare(
            "UPDATE skill_configuration_metadata SET revision = revision + 1, updated_at = ? WHERE id = 'company'",
          )
          .run(archivedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.departmentId);
    },
  };
};
