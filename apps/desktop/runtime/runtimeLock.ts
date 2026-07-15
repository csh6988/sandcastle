import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface RuntimeLockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly startedAt: string;
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLock = (lockPath: string): RuntimeLockRecord | null => {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as {
      readonly ownerId?: unknown;
      readonly pid?: unknown;
      readonly startedAt?: unknown;
    };
    if (
      typeof value.ownerId !== "string" ||
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as RuntimeLockRecord;
  } catch {
    return null;
  }
};

export const acquireCompanyRuntimeLock = (companyDir: string): (() => void) => {
  const runtimeDir = join(companyDir, ".sandcastle", "runtime");
  const lockPath = join(runtimeDir, "runtime.lock");
  const ownerId = randomUUID();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({
            ownerId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })}\n`,
        );
      } finally {
        closeSync(descriptor);
      }
      return () => {
        if (readLock(lockPath)?.ownerId === ownerId) {
          rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing && processIsAlive(existing.pid)) {
        throw new Error(
          `Company Runtime is already running with pid ${existing.pid}.`,
        );
      }
      rmSync(lockPath, { force: true });
    }
  }

  throw new Error("Company Runtime lock could not be acquired.");
};
