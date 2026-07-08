import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * A department inside the local AI **company** (ADR 0026). V1 ships exactly
 * one operational department — the Software R&D department (the workflow
 * board) — plus inert placeholders that only communicate the product model.
 */
export interface CompanyDepartment {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly operational: boolean;
}

/** A company project projected from `.sandcastle/workspace.json`. */
export interface CompanyProject {
  readonly name: string;
  readonly cwd: string;
  readonly kind?: string;
  readonly description?: string;
}

export interface CompanyView {
  readonly name: string;
  readonly departments: readonly CompanyDepartment[];
  readonly projects: readonly CompanyProject[];
}

export const SOFTWARE_RND_DEPARTMENT_ID = "software-rnd";

const DEPARTMENTS: readonly CompanyDepartment[] = [
  {
    id: SOFTWARE_RND_DEPARTMENT_ID,
    name: "Software R&D",
    description:
      "PRD to plan to approval to execution to verification, run by Planner, Generator, and Evaluator roles.",
    operational: true,
  },
  {
    id: "content",
    name: "Content",
    description: "Docs, articles, and content production. Not yet operational.",
    operational: false,
  },
  {
    id: "research",
    name: "Research",
    description:
      "Investigations, evaluations, and reports. Not yet operational.",
    operational: false,
  },
  {
    id: "operations",
    name: "Operations",
    description:
      "Recurring maintenance and housekeeping work. Not yet operational.",
    operational: false,
  },
];

const readWorkspaceProjects = (repoDir: string): CompanyProject[] => {
  const path = join(repoDir, ".sandcastle", "workspace.json");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The company view is a projection; a broken workspace.json should not
    // take down the board API (the workspace commands report it themselves).
    return [];
  }
  const repositories = (parsed as { repositories?: unknown } | null)
    ?.repositories;
  if (!Array.isArray(repositories)) return [];
  const projects: CompanyProject[] = [];
  for (const repo of repositories) {
    if (typeof repo !== "object" || repo === null) continue;
    const { name, cwd, kind, description } = repo as Record<string, unknown>;
    if (typeof name !== "string" || typeof cwd !== "string") continue;
    projects.push({
      name,
      cwd,
      ...(typeof kind === "string" ? { kind } : {}),
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return projects;
};

/**
 * Build the company-level view served at `GET /api/company`: the company name
 * (the host repository directory name), the department list, and projects
 * projected from `.sandcastle/workspace.json`. A pure projection over
 * existing local state — it introduces no new stored records.
 */
export const getCompanyView = (repoDir: string): CompanyView => ({
  name: basename(resolve(repoDir)),
  departments: DEPARTMENTS,
  projects: readWorkspaceProjects(repoDir),
});
