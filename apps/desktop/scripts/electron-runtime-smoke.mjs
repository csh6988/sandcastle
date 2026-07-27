import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
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
  const runtimeIpc = registerRuntimeIpc(ipcMain, () => supervisor, {
    getWindow: () => window,
    allowedOrigins: ["null"],
    createMessageChannel: () => new MessageChannelMain(),
  });
  const started = await supervisor.start(companyDir);
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, "dist-electron", "preload", "index.cjs"),
      sandbox: true,
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
  const streamHandle = await window.webContents.executeJavaScript(
    "window.sandcastle.openEventStream((frame) => { window.__sandcastleFrames = [...(window.__sandcastleFrames ?? []), frame]; })",
    true,
  );
  const projectBeforeUpdate = await window.webContents.executeJavaScript(
    `window.sandcastle.query({ type: "project.inspect", projectId: ${JSON.stringify(project.id)} })`,
    true,
  );
  await window.webContents.executeJavaScript(
    `window.sandcastle.execute({
      commandId: "electron-smoke-project-update-1",
      expectedRevision: ${projectBeforeUpdate.view.revision},
      command: {
        type: "project.update",
        projectId: ${JSON.stringify(project.id)},
        name: "Electron smoke updated",
        goal: "Verify the typed tunnel.",
        sharedContext: "typed tunnel",
        repositoryReferences: []
      }
    })`,
    true,
  );
  const streamEvent = await window.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        const event = (window.__sandcastleFrames ?? []).find((frame) => frame.value?.kind === "event");
        if (event) return resolve(event);
        if (Date.now() > deadline) return reject(new Error("Runtime event did not reach the renderer."));
        setTimeout(check, 20);
      };
      check();
    })`,
    true,
  );
  assert.equal(streamEvent.subscriptionId, streamHandle.subscriptionId);
  assert.equal(
    streamEvent.subscriptionGeneration,
    streamHandle.subscriptionGeneration,
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
  runtimeIpc.revokeWindow();
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
  const recovery = await window.webContents.executeJavaScript(
    `window.sandcastle.query({ type: "project.inspect", projectId: ${JSON.stringify(project.id)} })`,
    true,
  );
  const recoveryAck = await window.webContents.executeJavaScript(
    `window.sandcastle.execute({
      commandId: "electron-smoke-view-sync-1",
      command: {
        type: "ack-runtime-events",
        sequence: ${recovery.asOfSequence},
        viewSyncToken: ${JSON.stringify(recovery.viewSyncToken)}
      }
    })`,
    true,
  );
  const reopened = await window.webContents.executeJavaScript(
    "window.sandcastle.openEventStream((frame) => { window.__sandcastleFrames = [...(window.__sandcastleFrames ?? []), frame]; })",
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
  assert.equal(recoveryAck.status, "succeeded");
  assert.equal(reopened.barrierSequence, recovery.asOfSequence);
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      runtimePid: started.pid,
      preload: join(desktopRoot, "dist-electron", "preload", "index.cjs"),
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
