import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { acquireCompanyRuntimeLock } from "../runtimeLock.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

export interface CompanyDatabaseBackup {
  readonly path: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
}

const validateDatabaseFile = (path: string): number => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      throw new Error("Company database backup integrity check failed.");
    }
    const row = database
      .prepare("SELECT value FROM schema_metadata WHERE key = ?")
      .get("schema_version") as { readonly value?: unknown } | undefined;
    const version = Number(row?.value);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error("Company database backup schema version is invalid.");
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported company database backup schema version ${version}.`,
      );
    }
    return version;
  } finally {
    database.close();
  }
};

export const createCompanyDatabaseBackup = async (
  database: DatabaseSync,
  companyDir: string,
): Promise<CompanyDatabaseBackup> => {
  const createdAt = new Date().toISOString();
  const backupDir = join(companyDir, ".sandcastle", "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const path = join(
    backupDir,
    `company-${createdAt.replaceAll(":", "-")}-${randomUUID()}.sqlite`,
  );
  try {
    await backup(database, path);
    chmodSync(path, 0o600);
    return {
      path,
      schemaVersion: validateDatabaseFile(path),
      createdAt,
    };
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
};

export const restoreCompanyDatabaseBackup = async (
  companyDir: string,
  backupPath: string,
): Promise<void> => {
  const sandcastleDir = join(companyDir, ".sandcastle");
  const releaseLock = acquireCompanyRuntimeLock(companyDir);
  try {
    validateDatabaseFile(backupPath);
    mkdirSync(sandcastleDir, { recursive: true });
    const databasePath = join(sandcastleDir, "company.sqlite");
    const restorePath = join(
      sandcastleDir,
      `.company-restore-${randomUUID()}-${basename(backupPath)}`,
    );
    const previousPath = `${databasePath}.previous-${randomUUID()}`;
    copyFileSync(backupPath, restorePath);

    let previousMoved = false;
    try {
      validateDatabaseFile(restorePath);
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      if (existsSync(databasePath)) {
        renameSync(databasePath, previousPath);
        previousMoved = true;
      }
      renameSync(restorePath, databasePath);
      rmSync(previousPath, { force: true });
    } catch (error) {
      rmSync(restorePath, { force: true });
      if (previousMoved && !existsSync(databasePath)) {
        renameSync(previousPath, databasePath);
      }
      throw error;
    }
  } finally {
    releaseLock();
  }
};
