import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CompanyDirectoryLayout {
  readonly companyDir: string;
  readonly projectsDir: string;
  readonly sandcastleDir: string;
}

const writeJsonIfMissing = (path: string, value: unknown): void => {
  if (existsSync(path)) return;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const ensureCompanyDirectory = (
  companyDir: string,
): CompanyDirectoryLayout => {
  const projectsDir = join(companyDir, "projects");
  const sandcastleDir = join(companyDir, ".sandcastle");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(sandcastleDir, { recursive: true });

  writeJsonIfMissing(join(sandcastleDir, "project-index.json"), {
    projects: [],
  });
  writeJsonIfMissing(join(sandcastleDir, "skill-flows.json"), {
    flows: [],
  });
  writeJsonIfMissing(join(sandcastleDir, "role-profiles.json"), {
    departments: [],
  });

  return {
    companyDir,
    projectsDir,
    sandcastleDir,
  };
};
