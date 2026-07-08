import type { DesktopConfig } from "./config.js";

export interface DesktopStartupEnv {
  readonly SANDCASTLE_DESKTOP_COMPANY_DIR?: string;
  readonly SANDCASTLE_DESKTOP_REPO?: string;
}

export interface StartupSelection {
  readonly companyDir?: string;
  readonly repoDir?: string;
  readonly needsCompanyPicker: boolean;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value && value.trim().length > 0 ? value : undefined;

export const resolveStartupSelection = (
  env: DesktopStartupEnv,
  config: DesktopConfig,
): StartupSelection => {
  const companyDir =
    nonEmpty(env.SANDCASTLE_DESKTOP_COMPANY_DIR) ?? nonEmpty(config.companyDir);
  const repoDir = nonEmpty(env.SANDCASTLE_DESKTOP_REPO);

  return {
    companyDir,
    repoDir,
    needsCompanyPicker: !companyDir,
  };
};
