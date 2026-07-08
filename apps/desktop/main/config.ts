import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DesktopConfig {
  readonly companyDir?: string;
  readonly language?: "en" | "zh";
  readonly lastProjectId?: string;
  /** Temporary compatibility path for the repository-first desktop spike. */
  readonly repoDir?: string;
}

const configPath = (userDataDir: string): string =>
  join(userDataDir, "config.json");

export const loadConfig = (userDataDir: string): DesktopConfig => {
  const path = configPath(userDataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DesktopConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

export const saveConfig = (
  userDataDir: string,
  config: DesktopConfig,
): void => {
  const path = configPath(userDataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};
