import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronPackage = require("electron/package.json");
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Sandcastle";

const spawnElectron = (executable) => {
  const child = spawn(executable, ["."], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      SANDCASTLE_DESKTOP_DEV_URL:
        process.env.SANDCASTLE_DESKTOP_DEV_URL ?? "http://localhost:5273",
    },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
};

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
};

if (process.platform !== "darwin") {
  spawnElectron(electronExecutable);
} else {
  const sourceApp = dirname(dirname(dirname(electronExecutable)));
  const devDist = join(tmpdir(), "sandcastle-desktop-dev-electron");
  const devApp = join(devDist, `${appName}.app`);
  const plist = join(devApp, "Contents", "Info.plist");
  const bundledExecutable = join(devApp, "Contents", "MacOS", "Electron");
  const devExecutable = join(devApp, "Contents", "MacOS", appName);
  const versionMarker = join(devDist, ".electron-version");
  const expectedVersion = `${electronPackage.version}:ditto-executable-name\n`;

  if (
    !existsSync(devExecutable) ||
    !existsSync(versionMarker) ||
    expectedVersion !== String(readFileSync(versionMarker))
  ) {
    rmSync(devDist, { recursive: true, force: true });
    mkdirSync(devDist, { recursive: true });
    run("/usr/bin/ditto", [sourceApp, devApp]);
    renameSync(bundledExecutable, devExecutable);
    writeFileSync(versionMarker, expectedVersion);
  }

  run("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleExecutable ${appName}`,
    plist,
  ]);
  run("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleDisplayName ${appName}`,
    plist,
  ]);
  run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleName ${appName}`, plist]);

  spawnElectron(devExecutable);
}
