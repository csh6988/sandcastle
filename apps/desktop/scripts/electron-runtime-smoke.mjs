import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { createCompanyRuntimeSupervisor } from "../dist-electron/main/companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "../dist-electron/main/runtimeIpc.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-electron-smoke-"));
const supervisor = createCompanyRuntimeSupervisor();
let window;

app.commandLine.appendSwitch("disable-gpu");

const cleanup = async () => {
  window?.destroy();
  await supervisor?.stop();
};

const run = async () => {
  registerRuntimeIpc(ipcMain, () => supervisor);
  const started = await supervisor.start(companyDir);
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, "dist-electron", "preload", "index.js"),
      sandbox: false,
    },
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><title>runtime smoke</title>")}`,
  );

  const beforeReload = await window.webContents.executeJavaScript(
    "window.sandcastle.runtime.health()",
    true,
  );
  const beforeSkills = await window.webContents.executeJavaScript(
    'window.sandcastle.runtime.inspectSkillConfiguration("software-rnd")',
    true,
  );
  const project = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.createProject({
      name: "Electron smoke",
      goal: "Verify the Department Run preload path."
    })`,
    true,
  );
  const startedRun = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.startRun({
      projectId: ${JSON.stringify(project.id)},
      departmentId: "software-rnd"
    })`,
    true,
  );
  const advancedRun = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.executeReady({
      runId: ${JSON.stringify(startedRun.run.id)},
      expectedRevision: ${startedRun.run.revision}
    })`,
    true,
  );
  assert.equal(advancedRun.run.status, "waiting-approval");
  const approval = advancedRun.nodes.find(
    (node) =>
      node.nodeType === "human-approval" && node.status === "waiting-approval",
  );
  assert.ok(approval);
  const requestedRun = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.decideApproval({
      runId: ${JSON.stringify(advancedRun.run.id)},
      nodeRunId: ${JSON.stringify(approval.id)},
      expectedRevision: ${advancedRun.run.revision},
      decision: "request-changes",
      feedback: "Add recovery evidence."
    })`,
    true,
  );
  const waitingAgain = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.executeReady({
      runId: ${JSON.stringify(requestedRun.run.id)},
      expectedRevision: ${requestedRun.run.revision}
    })`,
    true,
  );
  assert.equal(waitingAgain.run.status, "waiting-approval");
  assert.equal(
    waitingAgain.nodes.find((node) => node.pipelineNodeId === "technical-plan")
      ?.attempts.length,
    2,
  );
  const secondApproval = waitingAgain.nodes.find(
    (node) =>
      node.nodeType === "human-approval" && node.status === "waiting-approval",
  );
  assert.ok(secondApproval);
  const approvedRun = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.decideApproval({
      runId: ${JSON.stringify(waitingAgain.run.id)},
      nodeRunId: ${JSON.stringify(secondApproval.id)},
      expectedRevision: ${waitingAgain.run.revision},
      decision: "approve"
    })`,
    true,
  );
  let completedRun = approvedRun;
  while (completedRun.run.status !== "completed") {
    completedRun = await window.webContents.executeJavaScript(
      `window.sandcastle.runtime.executeReady({
        runId: ${JSON.stringify(completedRun.run.id)},
        expectedRevision: ${completedRun.run.revision}
      })`,
      true,
    );
    if (completedRun.run.status === "waiting-approval") {
      const nextApproval = completedRun.nodes.find(
        (node) =>
          node.nodeType === "human-approval" &&
          node.status === "waiting-approval",
      );
      assert.ok(nextApproval);
      completedRun = await window.webContents.executeJavaScript(
        `window.sandcastle.runtime.decideApproval({
          runId: ${JSON.stringify(completedRun.run.id)},
          nodeRunId: ${JSON.stringify(nextApproval.id)},
          expectedRevision: ${completedRun.run.revision},
          decision: "approve"
        })`,
        true,
      );
    }
  }
  const reloaded = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await reloaded;
  const afterReload = await window.webContents.executeJavaScript(
    "window.sandcastle.runtime.health()",
    true,
  );
  const afterSkills = await window.webContents.executeJavaScript(
    'window.sandcastle.runtime.inspectSkillConfiguration("software-rnd")',
    true,
  );
  const afterRun = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.inspectRun(${JSON.stringify(startedRun.run.id)})`,
    true,
  );

  assert.equal(beforeReload.pid, started.pid);
  assert.equal(afterReload.pid, started.pid);
  assert.equal(afterReload.startedAt, beforeReload.startedAt);
  assert.equal(
    beforeSkills.activeSkills.some((skill) => skill.id === "tdd"),
    true,
  );
  assert.equal(afterSkills.skillFlows.length, beforeSkills.skillFlows.length);
  assert.equal(completedRun.run.status, "completed");
  assert.equal(afterRun.run.status, "completed");
  assert.equal(afterRun.snapshot.hash, startedRun.snapshot.hash);
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      runtimePid: started.pid,
      preload: join(desktopRoot, "dist-electron", "preload", "index.js"),
    })}\n`,
  );
};

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    process.stderr.write(`[electron-runtime-smoke] ${String(error)}\n`);
    exitCode = 1;
  } finally {
    await cleanup();
    app.exit(exitCode);
  }
});
