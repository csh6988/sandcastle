import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CompanyDirectoryLayout {
  readonly companyDir: string;
  readonly projectsDir: string;
  readonly sandcastleDir: string;
}

export const ensureCompanyDirectory = (
  companyDir: string,
): CompanyDirectoryLayout => {
  const projectsDir = join(companyDir, "projects");
  const sandcastleDir = join(companyDir, ".sandcastle");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(sandcastleDir, { recursive: true });

  return {
    companyDir,
    projectsDir,
    sandcastleDir,
  };
};
