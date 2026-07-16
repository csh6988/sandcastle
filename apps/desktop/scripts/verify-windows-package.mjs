import assert from "node:assert/strict";
import { openSync, readSync, readdirSync, statSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktopRoot, "release");
const installers = readdirSync(releaseDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      /^Sandcastle-.+-windows-x64-setup\.exe$/u.test(entry.name),
  )
  .map((entry) => join(releaseDir, entry.name));

assert.deepEqual(
  installers.length,
  1,
  `Expected one Windows x64 NSIS installer, found: ${installers.join(", ")}`,
);

const [installer] = installers;
assert.ok(installer);
assert.ok(
  statSync(installer).size > 1_000_000,
  "Windows installer is unexpectedly small.",
);

const handle = openSync(installer, "r");
try {
  const signature = Buffer.alloc(2);
  readSync(handle, signature, 0, signature.length, 0);
  assert.equal(signature.toString("ascii"), "MZ");
} finally {
  closeSync(handle);
}

process.stdout.write(`Verified Windows x64 NSIS installer: ${installer}\n`);
