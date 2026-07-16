import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const releaseDir = join(desktopRoot, "release");

const findPackagedExecutable = (directory) => {
  const candidates = [];
  const visit = (current, depth) => {
    if (depth > 6 || !existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (
        (process.platform === "darwin" &&
          path.endsWith(".app/Contents/MacOS/Sandcastle")) ||
        (process.platform === "win32" && entry.name === "Sandcastle.exe") ||
        (process.platform === "linux" &&
          ["sandcastle", "Sandcastle"].includes(entry.name) &&
          basename(current).includes("unpacked"))
      ) {
        candidates.push(path);
      }
    }
  };
  visit(directory, 0);
  assert.equal(
    candidates.length,
    1,
    `Expected one packaged executable, found: ${candidates.join(", ")}`,
  );
  return candidates[0];
};

const tempRoot = mkdtempSync(join(tmpdir(), "sandcastle-packaged-smoke-"));
const companyDir = join(tempRoot, "company");
const userDataDir = join(tempRoot, "user-data");
const resultPath = join(tempRoot, "result.json");
const executable = findPackagedExecutable(releaseDir);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.SANDCASTLE_DESKTOP_COMPANY_DIR = companyDir;
env.SANDCASTLE_DESKTOP_SMOKE_RESULT_PATH = resultPath;

const args = [`--user-data-dir=${userDataDir}`];
if (process.platform === "linux") args.push("--no-sandbox");

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "inherit" });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Packaged app smoke timed out after 30 seconds."));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  const report = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf8"))
    : null;
  assert.deepEqual(
    result,
    { code: 0, signal: null },
    `Packaged app failed: ${JSON.stringify(report)}`,
  );
  assert.ok(report, "Smoke result file was not written.");
  assert.equal(report.status, "ok");
  assert.equal(report.beforeReload.pid, report.afterReload.pid);
  assert.equal(report.beforeReload.startedAt, report.afterReload.startedAt);
  assert.equal(report.overviewVisible, true);
  assert.equal(report.projectsPageVisible, true);
  assert.ok(report.projectRuntimeId);
  assert.equal(report.projectRevision, 1);
  assert.deepEqual(report.projectRepositoryReferences, ["/work/checkout-api"]);
  assert.equal(report.projectVersionConflictVisible, true);
  assert.equal(
    report.projectReloadSharedContext,
    "Reloaded from the authoritative Runtime.",
  );
  assert.equal(report.archivedProjectVisible, false);
  assert.equal(report.departmentsPageVisible, true);
  assert.equal(report.departmentRuntimeId, "software-rnd");
  assert.equal(report.departmentPositionCount, 5);
  assert.equal(report.pipelineVersion, 3);
  assert.equal(report.pipelineDraftRevision, 1);
  assert.deepEqual(report.pipelineNodeIds, [
    "start",
    "product-alignment",
    "technical-plan",
    "plan-approval",
    "repository-execution",
    "implementation",
    "join",
    "review",
    "verification",
    "human-acceptance",
    "complete",
  ]);
  assert.equal(report.pipelineValidationVisible, true);
  assert.deepEqual(report.pipelineHistoryVersions, [3, 2, 1]);
  assert.equal(report.updatedDepartmentName, "Product Engineering");
  assert.equal(report.updatedMemberDisplayName, "Delivery Engineer");
  assert.equal(report.skillConfigurationRevision, 6);
  assert.deepEqual(report.positionSkillIds, ["code-review", "tdd"]);
  assert.ok(report.createdSkillFlowId);
  assert.equal(report.skillFlowRevision, 1);
  assert.equal(report.skillFlowConflictVisible, true);
  assert.equal(report.skillBlockedArchiveVisible, true);
  assert.match(
    report.skillBlockedArchiveMessage,
    /cannot be archived|无法归档/,
  );
  assert.equal(report.archivedSkillFlowStatus, "archived");
  assert.equal(report.pipelineSkillFlowId, "implementation-flow");
  assert.equal(report.reloadPipelineSkillFlowId, "implementation-flow");
  assert.equal(
    report.pipelineInstructions,
    "Implement the BrowserWindow vertical slice.",
  );
  assert.equal(
    report.pipelineExecutionProfileId,
    report.configuredExecutionProfileId,
  );
  assert.ok(report.configuredSecretReferenceId);
  assert.equal(report.positionLifecycleStatus, "archived");
  assert.notEqual(report.copiedDepartmentId, "software-rnd");
  assert.equal(report.archivedDepartmentVisible, false);
  assert.equal(report.unpublishedPipelineVisible, true);
  assert.equal(report.customPublishedPipelineVersion, 1);
  assert.equal(report.reloadPublishedPipelineVersion, 1);
  assert.ok(report.runRuntimeId);
  assert.equal(report.runStatus, "completed");
  assert.match(report.runSnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(report.runResolvedAgentId, "claude-code");
  assert.equal(report.runAgentSource, "run-override");
  assert.equal(report.runAttemptCount, 2);
  assert.equal(report.runApprovalCycles, 2);
  assert.equal(report.reloadRunStatus, "completed");
  assert.equal(report.interactionSessionStatus, "closed");
  assert.equal(report.permissionStatus, "approved");
  assert.ok(report.agUiEventCount > 0);
  assert.equal(report.memoryRecordVersion, 1);
  assert.equal(report.backupSchemaVersion, 23);
  assert.equal(report.legacyBoardNavigationVisible, false);
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      executable,
      runtimePid: report.beforeReload.pid,
    })}\n`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
