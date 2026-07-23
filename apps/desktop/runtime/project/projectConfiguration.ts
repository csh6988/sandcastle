import type { DatabaseSync } from "node:sqlite";
import {
  ProjectEditorViewSchema,
  type ProjectEditorView,
} from "../interface.js";

export class ProjectConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectConfigurationError";
  }
}

export interface ProjectConfiguration {
  readonly inspect: (projectId: string) => ProjectEditorView;
  readonly update: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
    readonly repositoryReferences: readonly string[];
  }) => ProjectEditorView;
  readonly updateInTransaction: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly goal: string;
    readonly sharedContext: string;
    readonly repositoryReferences: readonly string[];
  }) => ProjectEditorView;
  readonly archive: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
  }) => ProjectEditorView;
}

export const openProjectConfiguration = (
  database: DatabaseSync,
): ProjectConfiguration => {
  const inspect = (projectId: string): ProjectEditorView => {
    const project = database
      .prepare(
        `SELECT id,
                name,
                goal,
                status,
                revision,
                shared_context AS sharedContext,
                created_at AS createdAt
           FROM projects
          WHERE id = ?`,
      )
      .get(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    const repositoryReferences = (
      database
        .prepare(
          `SELECT repository_ref AS repositoryReference
             FROM project_repository_references
            WHERE project_id = ?
         ORDER BY sort_order`,
        )
        .all(projectId) as Array<{ readonly repositoryReference: string }>
    ).map((reference) => reference.repositoryReference);
    const departmentRuns = (
      database
        .prepare(
          `SELECT id,
                  department_id AS departmentId,
                  status,
                  created_at AS createdAt
             FROM department_runs
            WHERE project_id = ?
         ORDER BY created_at, id`,
        )
        .all(projectId) as Array<{
        readonly id: string;
        readonly departmentId: string;
        readonly status: string;
        readonly createdAt: string;
      }>
    ).map((run) => ({ ...run }));

    return ProjectEditorViewSchema.parse({
      ...project,
      repositoryReferences,
      departmentRuns,
    });
  };

  const updateInTransaction: ProjectConfiguration["updateInTransaction"] = (
    input,
  ) => {
    const repositoryReferences = input.repositoryReferences.map((reference) =>
      reference.trim(),
    );
    if (
      repositoryReferences.some((reference) => reference.length === 0) ||
      new Set(repositoryReferences).size !== repositoryReferences.length
    ) {
      throw new ProjectConfigurationError(
        "PROJECT_CONFIGURATION_INVALID",
        "Project repository references must be non-empty and unique.",
      );
    }

    const current = database
      .prepare("SELECT revision FROM projects WHERE id = ?")
      .get(input.projectId) as { readonly revision: number } | undefined;
    if (!current) {
      throw new Error(`Project ${input.projectId} was not found.`);
    }
    const currentRevision = Number(current.revision);
    if (currentRevision !== input.expectedRevision) {
      throw new ProjectConfigurationError(
        "VERSION_CONFLICT",
        `Project revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
      );
    }

    database
      .prepare(
        `UPDATE projects
              SET name = ?,
                  goal = ?,
                  shared_context = ?,
                  revision = revision + 1
            WHERE id = ?`,
      )
      .run(input.name, input.goal, input.sharedContext, input.projectId);
    database
      .prepare("DELETE FROM project_repository_references WHERE project_id = ?")
      .run(input.projectId);
    const insertReference = database.prepare(
      `INSERT INTO project_repository_references(
           project_id, repository_ref, sort_order
         ) VALUES (?, ?, ?)`,
    );
    repositoryReferences.forEach((reference, index) => {
      insertReference.run(input.projectId, reference, index);
    });
    return inspect(input.projectId);
  };

  return {
    inspect,
    updateInTransaction,
    update: (input) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = updateInTransaction(input);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    archive: (input) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = database
          .prepare("SELECT revision FROM projects WHERE id = ?")
          .get(input.projectId) as { readonly revision: number } | undefined;
        if (!current) {
          throw new Error(`Project ${input.projectId} was not found.`);
        }
        const currentRevision = Number(current.revision);
        if (currentRevision !== input.expectedRevision) {
          throw new ProjectConfigurationError(
            "VERSION_CONFLICT",
            `Project revision ${input.expectedRevision} does not match current revision ${currentRevision}.`,
          );
        }
        database
          .prepare(
            `UPDATE projects
                SET status = 'archived',
                    revision = revision + 1
              WHERE id = ?`,
          )
          .run(input.projectId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect(input.projectId);
    },
  };
};
