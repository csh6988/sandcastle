import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type SkillDiscoveryStatus =
  | "discovered"
  | "enabled"
  | "unavailable"
  | "archived";

export interface SkillCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceDirectory: string;
  readonly version: string;
  readonly locationReference: string;
  readonly requiredCapabilities: readonly string[];
  readonly status: SkillDiscoveryStatus;
}

export interface SkillCatalogView {
  readonly directories: readonly string[];
  readonly skills: readonly SkillCatalogEntry[];
}

export interface SkillCatalog {
  readonly inspect: () => SkillCatalogView;
  readonly discover: (input: {
    readonly directories?: readonly string[];
  }) => Promise<SkillCatalogView>;
  readonly enable: (skillId: string) => Promise<SkillCatalogView>;
  readonly archive: (skillId: string) => Promise<SkillCatalogView>;
}

export class SkillCatalogError extends Error {
  constructor(
    readonly code: "SKILL_NOT_FOUND" | "SKILL_IN_USE",
    message: string,
  ) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

const skillFilesUnder = async (
  directory: string,
): Promise<readonly string[]> => {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "SKILL.md" && entry.isFile()) {
        files.push(join(current, entry.name));
      } else if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".git"
      ) {
        await visit(join(current, entry.name));
      }
    }
  };
  await visit(directory);
  return files.sort();
};

const frontmatterValue = (content: string, key: string): string | null => {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  const line = content
    .slice(4, end)
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  return (
    line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "") ?? null
  );
};

const requiredCapabilitiesFrom = (content: string): readonly string[] =>
  (frontmatterValue(content, "required-capabilities") ?? "")
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);

const requiredCapabilitiesAt = (path: string): readonly string[] => {
  try {
    return requiredCapabilitiesFrom(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
};

const stableSkillId = (path: string): string =>
  `local-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;

export const openSkillCatalog = (
  database: DatabaseSync,
  options: {
    readonly clock?: () => Date;
    readonly defaultDirectories?: readonly string[];
  } = {},
): SkillCatalog => {
  const clock = options.clock ?? (() => new Date());

  const inspect = (): SkillCatalogView => {
    const directories = database
      .prepare("SELECT path FROM skill_source_directories ORDER BY path")
      .all()
      .map((row) => (row as { readonly path: string }).path);
    const discoveredRows = database
      .prepare(
        `SELECT id, name, description, source_directory AS sourceDirectory,
                location_ref AS locationReference, fingerprint AS version,
                status
           FROM skill_discovery_entries
          ORDER BY name, id`,
      )
      .all() as Array<Omit<SkillCatalogEntry, "requiredCapabilities">>;
    const discovered = discoveredRows.map(
      (skill): SkillCatalogEntry => ({
        ...skill,
        requiredCapabilities: requiredCapabilitiesAt(skill.locationReference),
      }),
    );
    const discoveredIds = new Set(discovered.map((skill) => skill.id));
    const configured = (
      database
        .prepare(
          `SELECT id, name, description, source, version,
                  location_ref AS locationReference, status
             FROM skills
            ORDER BY name, id`,
        )
        .all() as Array<{
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly source: string;
        readonly version: string;
        readonly locationReference: string;
        readonly status: "active" | "archived";
      }>
    )
      .filter((skill) => !discoveredIds.has(skill.id))
      .map(
        (skill): SkillCatalogEntry => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          sourceDirectory: skill.source,
          version: skill.version,
          locationReference: skill.locationReference,
          requiredCapabilities: [],
          status: skill.status === "active" ? "enabled" : "archived",
        }),
      );
    return { directories, skills: [...discovered, ...configured] };
  };

  return {
    inspect,
    enable: async (skillId) => {
      const discovered = database
        .prepare(
          `SELECT id, name, description, source_directory AS sourceDirectory,
                  location_ref AS locationReference, fingerprint
             FROM skill_discovery_entries
            WHERE id = ?`,
        )
        .get(skillId) as
        | {
            readonly id: string;
            readonly name: string;
            readonly description: string;
            readonly sourceDirectory: string;
            readonly locationReference: string;
            readonly fingerprint: string;
          }
        | undefined;
      if (!discovered) {
        throw new SkillCatalogError(
          "SKILL_NOT_FOUND",
          `Discovered Skill ${skillId} was not found.`,
        );
      }
      const now = clock().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `UPDATE skill_discovery_entries SET status = 'enabled' WHERE id = ?`,
          )
          .run(skillId);
        database
          .prepare(
            `INSERT INTO skills(
               id, company_id, name, description, source, version, location_ref,
               status, created_at, archived_at
             ) VALUES (?, 'company', ?, ?, ?, ?, ?, 'active', ?, NULL)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               source = excluded.source,
               version = excluded.version,
               location_ref = excluded.location_ref,
               status = 'active',
               archived_at = NULL`,
          )
          .run(
            discovered.id,
            discovered.name,
            discovered.description,
            discovered.sourceDirectory,
            discovered.fingerprint,
            discovered.locationReference,
            now,
          );
        database
          .prepare(
            `UPDATE skill_configuration_metadata
                SET revision = revision + 1, updated_at = ?
              WHERE id = 'company'`,
          )
          .run(now);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect();
    },
    archive: async (skillId) => {
      const exists = database
        .prepare(
          "SELECT 1 AS present FROM skill_discovery_entries WHERE id = ?",
        )
        .get(skillId);
      if (!exists) {
        throw new SkillCatalogError(
          "SKILL_NOT_FOUND",
          `Discovered Skill ${skillId} was not found.`,
        );
      }
      const inUse = database
        .prepare(
          `SELECT 1 AS present
             FROM position_skill_bindings
            WHERE skill_id = ?
            UNION ALL
           SELECT 1 AS present
             FROM skill_flow_skills
            WHERE skill_id = ?
            LIMIT 1`,
        )
        .get(skillId, skillId);
      if (inUse) {
        throw new SkillCatalogError(
          "SKILL_IN_USE",
          `Skill ${skillId} must be removed from Positions and Skill Flows before it can be archived.`,
        );
      }
      const now = clock().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            "UPDATE skill_discovery_entries SET status = 'archived' WHERE id = ?",
          )
          .run(skillId);
        database
          .prepare(
            `UPDATE skills SET status = 'archived', archived_at = ? WHERE id = ?`,
          )
          .run(now, skillId);
        database
          .prepare(
            `UPDATE skill_configuration_metadata
                SET revision = revision + 1, updated_at = ?
              WHERE id = 'company'`,
          )
          .run(now);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return inspect();
    },
    discover: async ({ directories = [] }) => {
      const now = clock().toISOString();
      const persistedDirectories = database
        .prepare("SELECT path FROM skill_source_directories")
        .all()
        .map((row) => (row as { readonly path: string }).path);
      const normalizedDirectories = [
        ...new Set(
          [
            ...(options.defaultDirectories ?? []),
            ...persistedDirectories,
            ...directories,
          ].map((directory) => resolve(directory)),
        ),
      ].sort();
      const saveDirectory = database.prepare(
        "INSERT OR IGNORE INTO skill_source_directories(path, created_at) VALUES (?, ?)",
      );
      const saveSkill = database.prepare(
        `INSERT INTO skill_discovery_entries(
           id, name, description, source_directory, location_ref, fingerprint,
           status, discovered_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           source_directory = excluded.source_directory,
           location_ref = excluded.location_ref,
           fingerprint = excluded.fingerprint,
           status = CASE
             WHEN skill_discovery_entries.status IN ('enabled', 'archived')
               THEN skill_discovery_entries.status
             ELSE 'discovered'
           END,
           last_seen_at = excluded.last_seen_at`,
      );
      const seen = new Set<string>();
      for (const directory of normalizedDirectories) {
        saveDirectory.run(directory, now);
        for (const path of await skillFilesUnder(directory)) {
          const content = await readFile(path, "utf8");
          const id = stableSkillId(path);
          seen.add(id);
          saveSkill.run(
            id,
            frontmatterValue(content, "name") ?? basename(resolve(path, "..")),
            frontmatterValue(content, "description") ?? "",
            directory,
            path,
            `sha256:${createHash("sha256").update(content).digest("hex")}`,
            now,
            now,
          );
        }
      }
      const rows = database
        .prepare(
          `SELECT id, source_directory AS sourceDirectory, status
             FROM skill_discovery_entries`,
        )
        .all() as Array<{
        readonly id: string;
        readonly sourceDirectory: string;
        readonly status: SkillDiscoveryStatus;
      }>;
      const markUnavailable = database.prepare(
        `UPDATE skill_discovery_entries
            SET status = 'unavailable'
          WHERE id = ? AND status != 'archived'`,
      );
      for (const row of rows) {
        if (
          normalizedDirectories.includes(row.sourceDirectory) &&
          !seen.has(row.id)
        ) {
          markUnavailable.run(row.id);
        }
      }
      return inspect();
    },
  };
};
