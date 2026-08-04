import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import { createCompanyRuntimeSupervisor } from "../dist-electron/main/companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "../dist-electron/main/runtimeIpc.js";
import { startShellServer } from "../dist-electron/server/shellServer.js";
import { companyRuntimeAddress } from "../dist-electron/runtime/address.js";
import { createCompanyRuntimeClient } from "../dist-electron/runtime/client.js";
import { EnvelopeCommandSchema } from "../dist-electron/runtime/interface.js";
import {
  applyElectronTestFixtureExitCode,
  createT26ElectronTestResult,
  createElectronTestFixture,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
  verifyTestEvidenceFile,
} from "../dist-electron/runtime/testing/electronTestFixture.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex");
const hashValue = (value) => sha256(canonicalJson(value));

const scriptRoot = mkdtempSync(
  join(tmpdir(), "sandcastle-electron-test-scripts-"),
);
const executionScript = join(scriptRoot, "execution.json");
const interactionScript = join(scriptRoot, "interaction.json");
writeFileSync(
  executionScript,
  JSON.stringify({ structuredResult: { status: "passed" } }),
  { mode: 0o600 },
);
writeFileSync(
  interactionScript,
  JSON.stringify({ response: "fixture interaction passed" }),
  { mode: 0o600 },
);

const fixture = createElectronTestFixture({
  fixtureId: "electron-test-fixture-v1",
  testRunId: "pending",
  testRunManifestHash: "0".repeat(64),
  adapters: [
    {
      id: "scripted-execution",
      scriptPath: executionScript,
      expectedScriptHash: sha256(readFileSync(executionScript)),
    },
    {
      id: "scripted-interaction",
      scriptPath: interactionScript,
      expectedScriptHash: sha256(readFileSync(interactionScript)),
    },
  ],
  allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
  fakeClock: "2026-07-29T00:00:00.000Z",
  repeatableIdSeed: "electron-test-fixture-seed-v1",
  packaged: app.isPackaged,
  entrypoint: "electron-test-fixture",
  additionalRepositoryCount: 1,
});
const humanRuntimeToken = randomBytes(32).toString("base64url");
const humanRuntimeClient = createCompanyRuntimeClient({
  address: companyRuntimeAddress(fixture.config.companyDirectory),
  token: humanRuntimeToken,
  timeoutMs: 2_000,
});
const deliveryQualityRuntimeToken = randomBytes(32).toString("base64url");
const deliveryQualityRuntimeClient = createCompanyRuntimeClient({
  address: companyRuntimeAddress(fixture.config.companyDirectory),
  token: deliveryQualityRuntimeToken,
  timeoutMs: 2_000,
});

let supervisor;
let shell;
let window;
let runtimeIpc;
let releaseFailurePoint = null;
const runtimeLogs = [];
app.commandLine.appendSwitch("disable-gpu");

const fixtureUrl = (base, route) => {
  const url = new URL(base);
  url.searchParams.set("fixture", hashValue(route));
  url.hash = `electron-test-fixture=${encodeURIComponent(JSON.stringify(route))}`;
  return url.toString();
};

const waitForTitle = async (suffix, timeoutMs = 10_000) => {
  const suffixes = Array.isArray(suffix) ? suffix : [suffix];
  const expected = suffixes.map((entry) => `Sandcastle T17 Fixture — ${entry}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = expected.find((entry) => window.getTitle() === entry);
    if (matched) return matched.slice("Sandcastle T17 Fixture — ".length);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  let statusMarkup = "unavailable";
  try {
    await debuggerSession.sendCommand("DOM.enable");
    const document = await debuggerSession.sendCommand("DOM.getDocument");
    const target = await debuggerSession.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector: "#test-status",
    });
    if (target.nodeId !== 0) {
      const status = await debuggerSession.sendCommand("DOM.getOuterHTML", {
        nodeId: target.nodeId,
      });
      statusMarkup = status.outerHTML;
    }
  } finally {
    debuggerSession.detach();
  }
  throw new Error(
    `Timed out waiting for renderer title ${expected.join(" or ")}; found ${window.getTitle()}; status ${statusMarkup}; Runtime diagnostics ${JSON.stringify(supervisor?.diagnostics())}; Runtime logs ${JSON.stringify(runtimeLogs)}.`,
  );
};

const clickElement = async (selector) => {
  app.focus({ steal: true });
  window.show();
  window.focus();
  window.webContents.focus();
  const deadline = Date.now() + 1_000;
  while (!window.isFocused() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  let point;
  try {
    await debuggerSession.sendCommand("DOM.enable");
    const document = await debuggerSession.sendCommand("DOM.getDocument");
    const target = await debuggerSession.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    assert.notEqual(
      target.nodeId,
      0,
      `Electron fixture element ${selector} was not found.`,
    );
    await debuggerSession.sendCommand("DOM.scrollIntoViewIfNeeded", {
      nodeId: target.nodeId,
    });
    const box = await debuggerSession.sendCommand("DOM.getBoxModel", {
      nodeId: target.nodeId,
    });
    point = {
      x: Math.round((box.model.border[0] + box.model.border[4]) / 2),
      y: Math.round((box.model.border[1] + box.model.border[5]) / 2),
    };
  } finally {
    debuggerSession.detach();
  }
  window.webContents.sendInputEvent({ type: "mouseMove", ...point });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
};

const waitForElement = async (selector, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debuggerSession = window.webContents.debugger;
    debuggerSession.attach("1.3");
    try {
      await debuggerSession.sendCommand("DOM.enable");
      const document = await debuggerSession.sendCommand("DOM.getDocument");
      const target = await debuggerSession.sendCommand("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector,
      });
      if (target.nodeId !== 0) return;
    } finally {
      debuggerSession.detach();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Electron fixture element ${selector}.`,
  );
};

const typeElement = async (selector, value) => {
  await waitForElement(selector);
  await clickElement(selector);
  const focusSession = window.webContents.debugger;
  focusSession.attach("1.3");
  try {
    await focusSession.sendCommand("DOM.enable");
    const document = await focusSession.sendCommand("DOM.getDocument");
    const target = await focusSession.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    assert.notEqual(target.nodeId, 0, `Input ${selector} was not found.`);
    await focusSession.sendCommand("DOM.focus", { nodeId: target.nodeId });
    const modifier = process.platform === "darwin" ? 4 : 2;
    await focusSession.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: modifier,
      commands: ["selectAll"],
    });
    await focusSession.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: modifier,
    });
    await focusSession.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await focusSession.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await focusSession.sendCommand("Input.insertText", { text: value });
  } finally {
    focusSession.detach();
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readElementState(selector);
    if (state?.value === value) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Electron keyboard input did not settle for ${selector}: ${JSON.stringify(await readElementState(selector))}`,
  );
};

const selectElementValue = async (selector, value) => {
  await waitForElement(selector);
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  let targetLabel;
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `(()=>{const select=document.querySelector(${JSON.stringify(selector)});return select?{options:[...select.options].map((option)=>({label:option.textContent,value:option.value})),value:select.value}:null})()`,
      returnByValue: true,
    });
    assert.ok(result.result.value, `Select ${selector} was not found.`);
    targetLabel = result.result.value.options.find(
      (option) => option.value === value,
    )?.label;
    assert.ok(targetLabel, `Select option ${value} was not found.`);
  } finally {
    debuggerSession.detach();
  }
  assert.match(selector, /^#[A-Za-z][\w:-]*$/);
  await clickElement("[data-project-runs] h2");
  const focusSession = window.webContents.debugger;
  focusSession.attach("1.3");
  try {
    await focusSession.sendCommand("DOM.enable");
    const document = await focusSession.sendCommand("DOM.getDocument");
    const target = await focusSession.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    assert.notEqual(target.nodeId, 0, `Select ${selector} was not found.`);
    await focusSession.sendCommand("DOM.focus", { nodeId: target.nodeId });
    const sendCharacter = async (character) => {
      await focusSession.sendCommand("Input.dispatchKeyEvent", {
        type: "char",
        key: character,
        text: character,
        unmodifiedText: character,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const result = await focusSession.sendCommand("Runtime.evaluate", {
      expression: "document.activeElement?.id ?? null",
      returnByValue: true,
    });
    assert.equal(
      result.result.value,
      selector.slice(1),
      `Keyboard focus did not reach ${selector}.`,
    );
    for (const character of targetLabel) {
      await sendCharacter(character);
    }
  } finally {
    focusSession.detach();
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readElementState(selector);
    if (state?.value === value) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Electron keyboard selection did not settle for ${selector}: ${JSON.stringify(await readElementState(selector))}`,
  );
};

const selectElementOption = async (selector, value) => {
  await waitForElement(selector);
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  let targetLabel;
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `(()=>{const select=document.querySelector(${JSON.stringify(selector)});return select?{options:[...select.options].map((option)=>({label:option.textContent,value:option.value})),value:select.value}:null})()`,
      returnByValue: true,
    });
    assert.ok(result.result.value, `Select ${selector} was not found.`);
    targetLabel = result.result.value.options.find(
      (option) => option.value === value,
    )?.label;
    assert.ok(targetLabel, `Select option ${value} was not found.`);
    await debuggerSession.sendCommand("DOM.enable");
    const document = await debuggerSession.sendCommand("DOM.getDocument");
    const target = await debuggerSession.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    assert.notEqual(target.nodeId, 0, `Select ${selector} was not found.`);
    await debuggerSession.sendCommand("DOM.scrollIntoViewIfNeeded", {
      nodeId: target.nodeId,
    });
    await debuggerSession.sendCommand("DOM.focus", { nodeId: target.nodeId });
    for (const character of targetLabel) {
      await debuggerSession.sendCommand("Input.dispatchKeyEvent", {
        type: "char",
        key: character,
        text: character,
        unmodifiedText: character,
      });
    }
  } finally {
    debuggerSession.detach();
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readElementState(selector);
    if (state?.value === value) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Electron keyboard selection did not settle for ${selector}: ${JSON.stringify(await readElementState(selector))}`,
  );
};

const waitForFile = async (path, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Runtime receipt ${path}; Runtime logs ${JSON.stringify(runtimeLogs)}.`,
  );
};

const readElementState = async (selector) => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify((()=>{const element=document.querySelector(${JSON.stringify(selector)});return element?{text:element.textContent,value:"value" in element?element.value:null,disabled:Boolean(element.disabled)}:null})())`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } finally {
    debuggerSession.detach();
  }
};

const readElementAttribute = async (selector, attribute) => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attribute)}) ?? null`,
      returnByValue: true,
    });
    return result.result.value;
  } finally {
    debuggerSession.detach();
  }
};

const waitForElementAttribute = async (
  selector,
  attribute,
  predicate,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readElementAttribute(selector, attribute);
    if (value !== null && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Electron fixture attribute ${attribute} on ${selector}.`,
  );
};

const waitForElementState = async (selector, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readElementState(selector);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Electron fixture state ${selector}.`);
};

const waitForAnyElement = async (selectors, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await readElementState(selector)) return selector;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Electron fixture elements ${selectors.join(", ")}.`,
  );
};

const clickFixtureButton = () => clickElement("#run-test");

const readFixtureObservation = async () => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify({statusText:document.querySelector("#test-status")?.textContent ?? null,buttonLabel:document.querySelector("#run-test")?.textContent ?? null})`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } finally {
    debuggerSession.detach();
  }
};

const readCandidateObservation = async () => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify((()=>{const panel=document.querySelector("[data-candidate-quality-gates]");return panel?{candidateInputId:panel.getAttribute("data-candidate-input"),authorityId:panel.getAttribute("data-candidate-authority"),sync:panel.getAttribute("data-candidate-sync"),criticalEscalationId:panel.querySelector("[data-critical-risk-escalation]")?.getAttribute("data-critical-risk-escalation")??null,authorizeCriticalVisible:Boolean(panel.querySelector("#authorize-critical-risk-continuation")),passGateCount:panel.querySelectorAll('[data-quality-gate-result="PASS"]').length,text:panel.textContent}:null})())`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } finally {
    debuggerSession.detach();
  }
};

const waitForCandidateObservation = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await readCandidateObservation();
    if (observation && predicate(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Candidate Quality Gate renderer observation; found ${JSON.stringify(await readCandidateObservation())}.`,
  );
};

const readDeliveryCandidateObservation = async () => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify((()=>{const panel=document.querySelector("[data-delivery-candidate]");return panel?{candidateId:panel.getAttribute("data-delivery-candidate-id"),manifestHash:panel.getAttribute("data-delivery-candidate-manifest-hash"),projection:panel.getAttribute("data-delivery-candidate-projection"),sync:panel.getAttribute("data-delivery-candidate-sync"),decisionId:panel.querySelector("[data-human-release-decision]")?.getAttribute("data-human-release-decision")??null,acceptVisible:Boolean(panel.querySelector("#accept-delivery-candidate")),text:panel.textContent}:null})())`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } finally {
    debuggerSession.detach();
  }
};

const waitForDeliveryCandidateObservation = async (
  predicate,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await readDeliveryCandidateObservation();
    if (observation && predicate(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Delivery Candidate renderer observation; found ${JSON.stringify(await readDeliveryCandidateObservation())}.`,
  );
};

const readReleaseOperationObservation = async () => {
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  try {
    const result = await debuggerSession.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify((()=>{const panel=document.querySelector("[data-release-operation-panel]");return panel?{authority:panel.querySelector("[data-release-authority-hash]")?.textContent??null,operations:[...panel.querySelectorAll("[data-release-operation]")].map((operation)=>({id:operation.getAttribute("data-release-operation"),text:operation.textContent,items:[...operation.querySelectorAll("[data-release-item]")].map((item)=>({id:item.getAttribute("data-release-item"),text:item.textContent}))}))}:null})())`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } finally {
    debuggerSession.detach();
  }
};

const waitForReleaseOperationObservation = async (
  predicate,
  timeoutMs = 20_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await readReleaseOperationObservation();
    if (observation && predicate(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Release operation renderer observation; found ${JSON.stringify(await readReleaseOperationObservation())}.`,
  );
};

const caseManifestFor = (seeded, operations) => ({
  schemaVersion: 1,
  ownerPositionId: seeded.testOwnerPositionId,
  requirementIds: [
    ...new Set(
      seeded.integrationAuthority.manifest.packages.flatMap(
        (entry) => entry.reviewContext.acceptanceCriteria,
      ),
    ),
  ].sort(),
  workPackageVersions: seeded.workPackageCoverage
    .map((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      workPackageVersionId: workPackage.workPackageVersionId,
      manifestHash: workPackage.manifestHash,
    }))
    .sort((left, right) =>
      left.workPackageVersionId.localeCompare(right.workPackageVersionId),
    ),
  preconditions: ["exact PASS Integration Generation is available"],
  uiActions: [
    { id: "fixture-run", kind: "click", target: "#run-test" },
    { id: "fixture-cleanup", kind: "click", target: "#run-test" },
    { id: "fixture-complete", kind: "click", target: "#run-test" },
  ],
  assertions: [
    {
      id: "fixture-pair",
      operationId: operations[0].id,
      ui: { kind: "button", expected: "Interaction Observed" },
      runtime: { kind: "query", expected: "completed" },
    },
  ],
  fixture: {
    id: fixture.config.fixtureId,
    scriptHashes: Object.values(fixture.config.scriptHashes).sort(),
  },
  executionOperations: operations,
  evidencePolicy: {
    retentionClass: "durable",
    redactionProfile: "fixture-redacted",
    requiredKinds: ["ui", "runtime", "cleanup"],
  },
  cleanup: {
    policy: "always",
    required: true,
    operationId: operations[1].id,
    rootFingerprint: fixture.config.rootFingerprint,
    targets: fixture.config.cleanupTargets.map((target) => ({
      kind: target.kind,
      pathFingerprint: target.pathFingerprint,
    })),
  },
});

const testScopeRiskFor = (seeded, operations) => {
  const revisionId = `technical-baseline:${seeded.technicalBaselineId}:${seeded.technicalBaselineHash}`;
  const tierRank = { low: 0, medium: 1, high: 2, critical: 3 };
  const highestWorkPackageRiskTier = seeded.workPackageCoverage.reduce(
    (tier, workPackage) =>
      tierRank[workPackage.riskTier] > tierRank[tier]
        ? workPackage.riskTier
        : tier,
    "low",
  );
  const rules = [
    { factorId: "auth-permission", minimumTier: "high" },
    { factorId: "credential-materialization", minimumTier: "critical" },
    { factorId: "cross-application-contract", minimumTier: "high" },
    { factorId: "data-migration-pii", minimumTier: "high" },
    { factorId: "dependency-supply-chain", minimumTier: "medium" },
    { factorId: "destructive-action", minimumTier: "critical" },
    { factorId: "network-filesystem-scope", minimumTier: "high" },
    { factorId: "no-sandbox", minimumTier: "high" },
    { factorId: "production-deployment", minimumTier: "critical" },
    { factorId: "public-api", minimumTier: "high" },
    {
      factorId: "rollback-resource-timeout-recovery",
      minimumTier: "medium",
    },
    { factorId: "sandbox-boundary", minimumTier: "critical" },
    { factorId: "secret-environment-boundary", minimumTier: "high" },
    { factorId: "user-visible-runtime", minimumTier: "high" },
    {
      factorId: "work-package-risk-tier",
      minimumTier: highestWorkPackageRiskTier,
    },
  ];
  const permissionEvidence = seeded.workPackageCoverage.map(
    (workPackage) =>
      `work-package-version:${workPackage.workPackageVersionId}:permission:repository.write`,
  );
  const factors = [
    {
      id: "auth-permission",
      present: true,
      evidenceRefs: [
        `technical-baseline:${seeded.technicalBaselineId}:permission-policy`,
        ...permissionEvidence,
      ].sort(),
    },
    { id: "credential-materialization", present: false, evidenceRefs: [] },
    {
      id: "cross-application-contract",
      present: seeded.integrationAuthority.manifest.contractVersions.length > 0,
      evidenceRefs: seeded.integrationAuthority.manifest.contractVersions.map(
        (contract) =>
          `contract:${contract.id}:${contract.version}:${contract.hash}`,
      ),
    },
    { id: "data-migration-pii", present: false, evidenceRefs: [] },
    {
      id: "dependency-supply-chain",
      present: seeded.integrationAuthority.manifest.packages.some(
        (workPackage) => workPackage.dependencies.length > 0,
      ),
      evidenceRefs: seeded.integrationAuthority.manifest.packages
        .filter((workPackage) => workPackage.dependencies.length > 0)
        .map(
          (workPackage) =>
            `work-package-version:${workPackage.workPackageVersionId}:dependencies`,
        )
        .sort(),
    },
    { id: "destructive-action", present: false, evidenceRefs: [] },
    {
      id: "network-filesystem-scope",
      present: permissionEvidence.length > 0,
      evidenceRefs: [...permissionEvidence].sort(),
    },
    { id: "no-sandbox", present: false, evidenceRefs: [] },
    { id: "production-deployment", present: false, evidenceRefs: [] },
    { id: "public-api", present: false, evidenceRefs: [] },
    {
      id: "rollback-resource-timeout-recovery",
      present: operations.length > 0,
      evidenceRefs: [
        `execution-profile:${seeded.testExecutionProfile.id}:timeout:30`,
        ...operations.map((operation) => `test-operation:${operation.id}`),
        ...seeded.workPackageCoverage.map(
          (workPackage) =>
            `work-package-version:${workPackage.workPackageVersionId}:recovery-policy`,
        ),
      ].sort(),
    },
    {
      id: "sandbox-boundary",
      present: true,
      evidenceRefs: ["test-capability:repository-boundary"],
    },
    { id: "secret-environment-boundary", present: false, evidenceRefs: [] },
    {
      id: "user-visible-runtime",
      present: true,
      evidenceRefs: ["test-case-revision:fixture-case-1-r1"],
    },
    {
      id: "work-package-risk-tier",
      present: seeded.workPackageCoverage.length > 0,
      evidenceRefs: seeded.workPackageCoverage
        .map(
          (workPackage) =>
            `work-package-version:${workPackage.workPackageVersionId}:risk-tier:${workPackage.riskTier}`,
        )
        .sort(),
    },
  ];
  const evidenceRefs = [
    ...new Set(factors.flatMap((factor) => factor.evidenceRefs)),
  ].sort();
  const policyHash = hashValue({ schemaVersion: 1, revisionId, rules });
  const computedTier = factors
    .filter((factor) => factor.present)
    .reduce((tier, factor) => {
      const rule = rules.find((candidate) => candidate.factorId === factor.id);
      return rule && tierRank[rule.minimumTier] > tierRank[tier]
        ? rule.minimumTier
        : tier;
    }, "low");
  return {
    schemaVersion: 1,
    policy: { revisionId, rules, hash: policyHash },
    factors,
    computedTier,
    evidenceRefs,
    inputHash: hashValue({
      schemaVersion: 1,
      policyRevisionId: revisionId,
      policyHash,
      factors,
      evidenceRefs,
    }),
  };
};

const runInputFor = (seeded, caseRevisionHash, operations) => ({
  testRunId: `test:${seeded.runId}:${seeded.testNodeRunId}`,
  requestId: "fixture-test-run-request-1",
  projectId: seeded.projectId,
  runId: seeded.runId,
  snapshotRevisionId: seeded.snapshotRevisionId,
  nodeRunId: seeded.testNodeRunId,
  nodeAttemptId: seeded.testNodeAttemptId,
  sessionId: seeded.testSessionId,
  testCaseRevisions: [{ id: "fixture-case-1-r1", hash: caseRevisionHash }],
  integrationAuthority: {
    generationId: seeded.integrationAuthority.id,
    manifestHash: seeded.integrationAuthority.manifestHash,
    passAuthorityHash: seeded.integrationAuthority.passAuthorityHash,
    repositoryCommits: seeded.integrationAuthority.repositoryResults
      .map((entry) => ({
        repositoryReference: entry.repositoryReference,
        commit: entry.integratedCommit,
      }))
      .sort((left, right) =>
        left.repositoryReference.localeCompare(right.repositoryReference),
      ),
  },
  build: seeded.build,
  executionProfile: seeded.testExecutionProfile,
  companyDirectoryFingerprint: fixture.config.companyDirectoryFingerprint,
  fixture: {
    id: fixture.config.fixtureId,
    scriptHashes: Object.values(fixture.config.scriptHashes),
  },
  executionOperations: operations,
  clock: {
    instant: fixture.config.fakeClock,
    seed: fixture.config.repeatableIdSeed,
  },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    electron: process.versions.electron,
  },
  capabilities: [
    "branch",
    "electron",
    "git-ref-write-isolation",
    "main-ipc",
    "preload",
    "query-view",
    "repository-boundary",
    "runtime-import-only",
    "runtime-child",
    "sqlite",
  ],
  risk: testScopeRiskFor(seeded, operations),
});

const routeFor = (seeded, operations) => {
  const caseManifest = caseManifestFor(seeded, operations);
  const caseRevisionHash = hashValue({
    ...caseManifest,
    testCaseId: "fixture-case-1",
    revisionId: "fixture-case-1-r1",
    revision: 1,
    supersedesRevisionId: null,
    requirementIds: [...new Set(caseManifest.requirementIds)].sort(),
    preconditions: [...new Set(caseManifest.preconditions)].sort(),
    assertions: [...caseManifest.assertions].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    workPackageVersions: [...caseManifest.workPackageVersions].sort(
      (left, right) =>
        left.workPackageVersionId.localeCompare(right.workPackageVersionId),
    ),
    executionOperations: [...caseManifest.executionOperations].sort(
      (left, right) => left.id.localeCompare(right.id),
    ),
    fixture: {
      ...caseManifest.fixture,
      scriptHashes: [...new Set(caseManifest.fixture.scriptHashes)].sort(),
    },
    evidencePolicy: {
      ...caseManifest.evidencePolicy,
      requiredKinds: [
        ...new Set(caseManifest.evidencePolicy.requiredKinds),
      ].sort(),
    },
  });
  const runInput = runInputFor(seeded, caseRevisionHash, operations);
  return {
    schemaVersion: 1,
    restoreOnLoad: false,
    testRunId: runInput.testRunId,
    caseCommandId: "fixture-case-register",
    caseCommand: {
      type: "test.case-revision.register",
      testCaseId: "fixture-case-1",
      revisionId: "fixture-case-1-r1",
      projectId: seeded.projectId,
      manifest: caseManifest,
    },
    runCommandId: "fixture-test-run-create",
    runCommand: { type: "test.run.create", input: runInput },
  };
};

const manifestFor = (seeded, route) => {
  const input = route.runCommand.input;
  const testCaseRevisions = [...input.testCaseRevisions].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    ...input,
    schemaVersion: 1,
    testCaseRevisions,
    integrationAuthority: {
      ...input.integrationAuthority,
      repositoryCommits: [...input.integrationAuthority.repositoryCommits].sort(
        (left, right) =>
          left.repositoryReference.localeCompare(right.repositoryReference),
      ),
    },
    buildLineage: {
      generationId: input.integrationAuthority.generationId,
      manifestHash: input.integrationAuthority.manifestHash,
      passAuthorityHash: input.integrationAuthority.passAuthorityHash,
      repositoryCommits: [...input.integrationAuthority.repositoryCommits].sort(
        (left, right) =>
          left.repositoryReference.localeCompare(right.repositoryReference),
      ),
    },
    fixture: {
      ...input.fixture,
      scriptHashes: [...new Set(input.fixture.scriptHashes)].sort(),
    },
    executionOperations: [...input.executionOperations].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    capabilities: [...new Set(input.capabilities)].sort(),
    coverageHash: hashValue(testCaseRevisions),
    integrationCoverage: {
      coverageId: seeded.integrationAuthority.manifest.coverageId,
      coverageNodeRunId: seeded.integrationAuthority.manifest.coverageNodeRunId,
      coverageNodeAttemptId:
        seeded.integrationAuthority.manifest.coverageNodeAttemptId,
      coverageHash: seeded.integrationAuthority.manifest.coverageHash,
      packageAuthorities: seeded.integrationAuthority.manifest.packages
        .map((entry) => ({
          workPackageId: entry.workPackageId,
          workPackageVersionId: entry.workPackageVersionId,
          authorityId: entry.authorityId,
          qualityGateResultId: entry.qualityGateResultId,
          sourceCommit: entry.sourceCommit,
          diffHash: entry.diffHash,
        }))
        .sort((left, right) =>
          left.workPackageVersionId.localeCompare(right.workPackageVersionId),
        ),
      aggregateReviewId: seeded.integrationAuthority.aggregateReview.id,
      aggregateGateResultId:
        seeded.integrationAuthority.aggregateReview.qualityGateResultId,
      aggregateInputHash: seeded.integrationAuthority.aggregateReview.inputHash,
      evidenceRefs: [
        ...seeded.integrationAuthority.aggregateReview.evidence,
      ].sort(),
    },
  };
};

const run = async () => {
  supervisor = createCompanyRuntimeSupervisor({
    runtimeEntry: join(
      desktopRoot,
      "dist-electron",
      "runtime",
      "testing",
      "electronTestFixtureEntry.js",
    ),
    environmentForLaunch: () => {
      const claim = fixture.issueAuthorizationClaim();
      return {
        SANDCASTLE_ELECTRON_TEST_FIXTURE_CONFIG: fixture.configPath,
        SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION_CLAIM:
          claim.authorizationClaimPath,
        SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION: claim.authorization,
        SANDCASTLE_ELECTRON_TEST_FIXTURE_PACKAGED: app.isPackaged ? "1" : "0",
        SANDCASTLE_ELECTRON_TEST_FIXTURE_HUMAN_TOKEN: humanRuntimeToken,
        SANDCASTLE_ELECTRON_TEST_FIXTURE_DELIVERY_QUALITY_TOKEN:
          deliveryQualityRuntimeToken,
        ...(releaseFailurePoint
          ? {
              SANDCASTLE_ELECTRON_TEST_FIXTURE_RELEASE_FAILURE_POINT:
                releaseFailurePoint,
            }
          : {}),
      };
    },
    onLog: (line) => runtimeLogs.push(line),
  });
  await supervisor.start(fixture.config.companyDirectory);
  const setupReceiptPath = join(
    fixture.config.evidenceDirectory,
    "runtime",
    "setup-authority.json",
  );
  const setupReceipt = JSON.parse(readFileSync(setupReceiptPath, "utf8"));
  assert.equal(setupReceipt.schemaVersion, 1);
  assert.equal(setupReceipt.fixtureId, fixture.config.fixtureId);
  assert.equal(setupReceipt.rootFingerprint, fixture.config.rootFingerprint);
  const preparation = setupReceipt.preparation;
  assert.ok(preparation?.projectId);
  assert.equal(setupReceipt.seeded, undefined);

  shell = await startShellServer({
    rendererDist: join(desktopRoot, "dist"),
    port: 0,
  });
  const rendererRuntime = {
    ...supervisor,
    executeEnvelope: humanRuntimeClient.executeEnvelope,
    queryEnvelope: humanRuntimeClient.queryEnvelope,
    openSubscription: humanRuntimeClient.openSubscription,
    readSubscription: humanRuntimeClient.readSubscription,
    closeSubscription: humanRuntimeClient.closeSubscription,
  };
  runtimeIpc = registerRuntimeIpc(ipcMain, () => rendererRuntime, {
    getWindow: () => window,
    allowedOrigins: [new URL(shell.url).origin],
    createMessageChannel: () => new MessageChannelMain(),
    principal: {
      type: "human",
      id: "electron-test-fixture",
      authenticatedBy: "local-session",
    },
    consumerId: "electron-test-fixture-human-release",
  });
  window = new BrowserWindow({
    show: true,
    width: 960,
    height: 720,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, "dist-electron", "preload", "index.cjs"),
      sandbox: true,
    },
  });

  await window.loadURL(shell.url);
  if (process.env.SANDCASTLE_ELECTRON_TEST_FORCE_FAILURE === "after-window") {
    throw new Error("Electron test fixture forced failure after window.");
  }
  await waitForElement('[data-nav="projects"]');
  await clickElement('[data-nav="projects"]');
  await waitForElement(`[data-project-id="${preparation.projectId}"]`);
  await clickElement(`[data-project-id="${preparation.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${preparation.projectId}"]`);
  await clickElement('[data-project-tab="runs"]');
  await waitForElement("[data-start-department-run]");
  await selectElementValue("#project-run-department", preparation.departmentId);
  assert.equal(
    (await readElementState("#project-run-department"))?.value,
    preparation.departmentId,
  );
  await clickElement("[data-start-department-run]");
  await waitForElement("[data-project-consultation]");
  const consultationEntry = await waitForAnyElement([
    ".project-consultation-composer textarea",
    "[data-consultation-start]",
  ]);
  if (consultationEntry === "[data-consultation-start]") {
    await clickElement("[data-consultation-start]");
  }
  await waitForElement(".project-consultation-composer textarea");
  await typeElement(
    ".project-consultation-composer textarea",
    "Exercise the real Product consultation through BrowserWindow gestures.",
  );
  await clickElement(".project-consultation-composer button");
  await waitForElementState(
    "[data-product-proposal-revise]",
    (state) => state.disabled === false,
  );
  const proposalFields = {
    goal: "Verify the real Product-to-Candidate authority chain.",
    users: "Electron Test fixture",
    scope: "T21 Product-to-Candidate plus T22 Release operations",
    nonGoals: "T26\nT27\nDeployment\nNetwork\nRemote Release effects",
    acceptanceCriteria:
      "The exact frozen Diff is independently reviewed.\nThe formal Candidate is accepted by a verified human.\nMerge and export Release operations use exact destination authority, durable receipts, and restart reconciliation.",
    constraints:
      "Use only temporary fixture Repositories and export destinations.\nUse schema v51 and Event Registry v19.",
    risks: "Fixture evidence must remain inside its temporary root.",
    openQuestions: "",
  };
  for (const [field, value] of Object.entries(proposalFields)) {
    await typeElement(`[data-product-proposal-field="${field}"]`, value);
  }
  for (const [field, value] of Object.entries(proposalFields)) {
    assert.equal(
      (await readElementState(`[data-product-proposal-field="${field}"]`))
        ?.value,
      value,
      `Product proposal field ${field} changed before submission.`,
    );
  }
  await clickElement("[data-product-proposal-revise]");
  try {
    await waitForElementState(
      "[data-product-proposal-awaiting]",
      (state) => state.disabled === false,
    );
  } catch (error) {
    throw new Error(
      `${String(error)}; proposal=${JSON.stringify(await readElementState("[data-product-proposal-identity]"))}; projectError=${JSON.stringify(await readElementState("[data-project-error-code]"))}`,
    );
  }
  await clickElement("[data-product-proposal-awaiting]");
  await waitForElementState(
    "[data-consultation-confirm]",
    (state) => state.disabled === false,
  );
  await clickElement("[data-consultation-confirm]");
  const downstreamReceiptPath = join(
    fixture.config.evidenceDirectory,
    "runtime",
    "downstream-authority.json",
  );
  await waitForFile(downstreamReceiptPath);
  const downstreamReceipt = JSON.parse(
    readFileSync(downstreamReceiptPath, "utf8"),
  );
  assert.equal(downstreamReceipt.schemaVersion, 1);
  assert.equal(downstreamReceipt.fixtureId, fixture.config.fixtureId);
  const seeded = downstreamReceipt.seeded;
  assert.ok(seeded?.integrationAuthority?.passAuthorityHash);
  assert.equal(seeded.projectId, preparation.projectId);

  const cleanupContract = {
    rootFingerprint: fixture.config.rootFingerprint,
    targets: fixture.config.cleanupTargets.map((target) => ({
      kind: target.kind,
      pathFingerprint: target.pathFingerprint,
    })),
  };
  const placeholderOperations = [
    {
      id: "fixture-01-electron-operation",
      kind: "electron",
      adapterId: "scripted-execution",
      input: {
        schemaVersion: 1,
        fixtureId: fixture.config.fixtureId,
        action: "electron-assertion",
        testCaseRevisionId: "fixture-case-1-r1",
        assertionId: "fixture-pair",
        correlationCommandId: "fixture-test-run-create",
        evidence: [],
      },
    },
    {
      id: "fixture-02-cleanup-operation",
      kind: "cleanup",
      adapterId: "scripted-execution",
      input: {
        schemaVersion: 1,
        fixtureId: fixture.config.fixtureId,
        action: "cleanup",
        testCaseRevisionId: "fixture-case-1-r1",
        assertionId: null,
        evidence: [],
        cleanup: cleanupContract,
      },
    },
  ].map((operation) => ({
    ...operation,
    inputHash: hashValue(operation.input),
  }));
  const interactionCommandId = "fixture-interaction-prompt";
  const interactionContent = "Exercise the real Electron renderer gesture.";
  const interactionResponse = "fixture interaction passed";
  const preparationRoute = {
    ...routeFor(seeded, placeholderOperations),
    interactionPrompt: {
      commandId: interactionCommandId,
      sessionId: seeded.interactionSessionId,
      participantId: seeded.interactionHumanParticipantId,
      content: interactionContent,
      expectedResponse: interactionResponse,
    },
  };
  const caseCommand = EnvelopeCommandSchema.safeParse(
    preparationRoute.caseCommand,
  );
  const runCommand = EnvelopeCommandSchema.safeParse(
    preparationRoute.runCommand,
  );
  assert.equal(
    caseCommand.success,
    true,
    caseCommand.success ? undefined : caseCommand.error.message,
  );
  assert.equal(
    runCommand.success,
    true,
    runCommand.success ? undefined : runCommand.error.message,
  );
  await window.loadURL(fixtureUrl(shell.url, preparationRoute));
  await waitForTitle("idle");
  await clickFixtureButton();
  await waitForTitle("observed");
  const uiObservation = await readFixtureObservation();
  const interactionInspection = await supervisor.queryEnvelope({
    schemaVersion: 1,
    requestId: "fixture-interaction-inspect-after-gesture",
    principal: {
      type: "test-driver",
      id: "electron-test-fixture",
      authenticatedBy: "ipc-token",
    },
    consumerId: "electron-test-fixture-driver",
    query: {
      type: "interaction.inspect",
      sessionId: seeded.interactionSessionId,
    },
  });
  const interactionTurn = interactionInspection.view.turns.find(
    (turn) => turn.commandId === interactionCommandId,
  );
  const interactionOutput = interactionInspection.view.messages.find(
    (message) => message.id === interactionTurn?.outputMessageId,
  );
  assert.ok(interactionTurn, "Interaction Turn was not persisted.");
  assert.ok(interactionOutput, "Interaction output Message was not persisted.");
  const expectedAssertionContract = {
    schemaVersion: 1,
    ui: {
      statusText: "observed",
      buttonLabel: "Interaction Observed",
    },
    runtime: {
      interactionSessionId: seeded.interactionSessionId,
      interactionCommandId,
      interactionTurnStatus: "completed",
      interactionResponse,
    },
  };
  const observedAssertionContract = {
    schemaVersion: 1,
    ui: uiObservation,
    runtime: {
      interactionSessionId: interactionInspection.view.session.id,
      interactionCommandId: interactionTurn?.commandId,
      interactionTurnStatus: interactionTurn?.status,
      interactionResponse: interactionOutput?.content,
    },
  };
  assert.equal(
    canonicalJson(observedAssertionContract),
    canonicalJson(expectedAssertionContract),
    "Electron expected and observed assertion contracts differ.",
  );
  const screenshotBytes = window.webContents.capturePage
    ? (await window.webContents.capturePage()).toPNG()
    : Buffer.alloc(0);
  assert.ok(screenshotBytes.byteLength > 0);
  const screenshotLocator = normalizeTestEvidenceLocator(
    "screenshots/fixture-observed.png",
  );
  mkdirSync(join(fixture.config.evidenceDirectory, "screenshots"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(fixture.config.evidenceDirectory, screenshotLocator),
    screenshotBytes,
    { mode: 0o600 },
  );
  verifyTestEvidenceFile({
    evidenceDirectory: fixture.config.evidenceDirectory,
    locator: screenshotLocator,
    contentHash: sha256(screenshotBytes),
    byteSize: screenshotBytes.byteLength,
  });
  const runtimePayloadBytes = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      fixtureId: fixture.config.fixtureId,
      runId: seeded.runId,
      integrationGenerationId: seeded.integrationAuthority.id,
      integrationManifestHash: seeded.integrationAuthority.manifestHash,
      integrationPassAuthorityHash:
        seeded.integrationAuthority.passAuthorityHash,
      assertionContract: {
        expected: expectedAssertionContract,
        observed: observedAssertionContract,
      },
      interaction: {
        sessionId: seeded.interactionSessionId,
        turnId: interactionTurn.id,
        inputMessageId: interactionTurn.inputMessageId,
        outputMessageId: interactionTurn.outputMessageId,
        commandId: interactionTurn.commandId,
        status: interactionTurn.status,
        response: interactionOutput.content,
      },
    }),
  );
  const runtimeLocator = normalizeTestEvidenceLocator(
    "payload/runtime-authority.json",
  );
  mkdirSync(join(fixture.config.evidenceDirectory, "payload"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(fixture.config.evidenceDirectory, runtimeLocator),
    runtimePayloadBytes,
    { mode: 0o600 },
  );
  verifyTestEvidenceFile({
    evidenceDirectory: fixture.config.evidenceDirectory,
    locator: runtimeLocator,
    contentHash: sha256(runtimePayloadBytes),
    byteSize: runtimePayloadBytes.byteLength,
  });

  const screenshotEvidence = {
    id: "fixture-screenshot",
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: "fixture-pair",
    kind: "screenshot",
    artifactType: "test-screenshot",
    mediaType: "image/png",
    logicalName: "fixture-observed-screenshot",
    locator: screenshotLocator,
    contentHash: sha256(screenshotBytes),
    byteSize: screenshotBytes.byteLength,
    redactionProfile: "fixture-redacted",
    retentionClass: "durable",
    metadata: {
      locator: screenshotLocator,
      renderer: "actual-app-bundle",
      capturedAfterInteractionTurnId: interactionTurn.id,
    },
  };
  const runtimeEvidence = {
    id: "fixture-runtime-payload",
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: "fixture-pair",
    kind: "runtime",
    artifactType: "test-runtime-payload",
    mediaType: "application/json",
    logicalName: "fixture-runtime-authority",
    locator: runtimeLocator,
    contentHash: sha256(runtimePayloadBytes),
    byteSize: runtimePayloadBytes.byteLength,
    redactionProfile: "fixture-redacted",
    retentionClass: "durable",
    metadata: { locator: runtimeLocator, source: "authoritative-runtime" },
  };
  const cleanupSource = {
    schemaVersion: 1,
    fixtureId: fixture.config.fixtureId,
    rootFingerprint: fixture.config.rootFingerprint,
    targets: fixture.config.cleanupTargets.map((target) => ({
      kind: target.kind,
      pathFingerprint: target.pathFingerprint,
      state: "absent",
    })),
  };
  const cleanupBytes = Buffer.from(canonicalJson(cleanupSource));
  const cleanupLocator = normalizeTestEvidenceLocator(
    "cleanup/execution-resources.json",
  );
  const cleanupEvidence = {
    id: "fixture-cleanup-receipt",
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: null,
    kind: "cleanup",
    artifactType: "test-cleanup-receipt",
    mediaType: "application/json",
    logicalName: "fixture-execution-resource-cleanup",
    locator: cleanupLocator,
    contentHash: sha256(cleanupBytes),
    byteSize: cleanupBytes.byteLength,
    redactionProfile: "fixture-redacted",
    retentionClass: "durable",
    metadata: {
      verified: true,
      rootFingerprint: fixture.config.rootFingerprint,
    },
  };
  const electronOperationInput = {
    schemaVersion: 1,
    fixtureId: fixture.config.fixtureId,
    action: "electron-assertion",
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: "fixture-pair",
    correlationCommandId: "fixture-test-run-create",
    assertionContract: expectedAssertionContract,
    evidence: [screenshotEvidence, runtimeEvidence],
  };
  const cleanupOperationInput = {
    schemaVersion: 1,
    fixtureId: fixture.config.fixtureId,
    action: "cleanup",
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: null,
    evidence: [cleanupEvidence],
    cleanup: cleanupContract,
  };
  const operations = [
    {
      id: "fixture-01-electron-operation",
      kind: "electron",
      adapterId: "scripted-execution",
      input: electronOperationInput,
      inputHash: hashValue(electronOperationInput),
    },
    {
      id: "fixture-02-cleanup-operation",
      kind: "cleanup",
      adapterId: "scripted-execution",
      input: cleanupOperationInput,
      inputHash: hashValue(cleanupOperationInput),
    },
  ];
  await supervisor.stop();
  const route = routeFor(seeded, operations);
  fixture.issueAuthorizationClaim();
  const expectedTestRunManifestHash = hashValue(manifestFor(seeded, route));
  fixture.bindTestRunManifestHash(expectedTestRunManifestHash);

  const query = (requestId, value) =>
    supervisor.queryEnvelope({
      schemaVersion: 1,
      requestId,
      principal: {
        type: "test-driver",
        id: "electron-test-fixture",
        authenticatedBy: "ipc-token",
      },
      consumerId: "electron-test-fixture-driver",
      query: value,
    });
  const inspectTestRun = async (stage) => {
    const inspected = await query(`fixture-inspect:${stage}`, {
      type: "test-runs.inspect",
      testRunId: route.testRunId,
    });
    assert.equal(inspected.view.manifestHash, expectedTestRunManifestHash);
    return inspected.view;
  };

  const health = await supervisor.start(fixture.config.companyDirectory);
  assert.throws(
    () =>
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorizationClaimPath: fixture.authorizationClaimPath,
        authorization: fixture.authorization,
        packaged: false,
        entrypoint: "electron-test-fixture",
      }),
    (error) => error?.code === "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
  );
  await window.loadURL(fixtureUrl(shell.url, route));
  await waitForTitle("idle");
  let cleanupMaterialized = false;
  let restartHealth;
  let restartTestRunState;
  let restartElectronReceiptHash;
  let terminalView;
  for (let gesture = 1; gesture <= 30; gesture += 1) {
    await clickFixtureButton();
    const afterGesture = await waitForTitle(["working", "ready", "pass"]);
    if (afterGesture === "working") {
      await waitForTitle(["ready", "pass"]);
    }
    let view = await inspectTestRun(`gesture-${gesture}`);
    if (view.executions.some((entry) => entry.state === "reconciling")) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const reconciled = await inspectTestRun(
          `gesture-${gesture}-reconcile-${attempt}`,
        );
        view = reconciled;
        if (
          reconciled.state === "passed" ||
          !reconciled.executions.some((entry) => entry.state === "reconciling")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (view.state === "passed") {
      terminalView = view;
      break;
    }
    const electronExecution = view.executions.find(
      (entry) => entry.id === "fixture-01-electron-operation",
    );
    const cleanupExecution = view.executions.find(
      (entry) => entry.id === "fixture-02-cleanup-operation",
    );
    if (
      !cleanupMaterialized &&
      electronExecution?.state === "succeeded" &&
      cleanupExecution?.state !== "succeeded"
    ) {
      if (!restartHealth) {
        const eventsBeforeRestart = await supervisor.events({
          afterSequence: 0,
          limit: 1_000,
        });
        await supervisor.stop();
        restartHealth = await supervisor.start(fixture.config.companyDirectory);
        const restartedTestRun = await inspectTestRun("pre-cleanup-restart");
        const restartedElectron = restartedTestRun.executions.find(
          (entry) => entry.id === "fixture-01-electron-operation",
        );
        const restartedCleanup = restartedTestRun.executions.find(
          (entry) => entry.id === "fixture-02-cleanup-operation",
        );
        assert.equal(restartedElectron?.state, "succeeded");
        assert.equal(
          restartedElectron?.receiptHash,
          electronExecution.receiptHash,
        );
        assert.equal(
          restartedTestRun.executions.filter(
            (entry) => entry.id === "fixture-01-electron-operation",
          ).length,
          1,
        );
        assert.notEqual(restartedCleanup?.state, "succeeded");
        const eventsAfterRestart = await supervisor.events({
          afterSequence: 0,
          limit: 1_000,
        });
        const electronEventCount = (events) =>
          events.filter(
            (event) =>
              event.testRunId === route.testRunId &&
              event.payload?.operationId === "fixture-01-electron-operation",
          ).length;
        assert.equal(
          electronEventCount(eventsAfterRestart),
          electronEventCount(eventsBeforeRestart),
        );
        restartTestRunState = restartedTestRun.state;
        restartElectronReceiptHash = restartedElectron?.receiptHash;
        await window.loadURL(
          fixtureUrl(shell.url, { ...route, restoreOnLoad: true }),
        );
        await waitForTitle(["ready", "pass"]);
        view = restartedTestRun;
      }
      const cleanupReceipt = fixture.cleanupExecutionResources();
      assert.equal(canonicalJson(cleanupReceipt), canonicalJson(cleanupSource));
      mkdirSync(join(fixture.config.evidenceDirectory, "cleanup"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        join(fixture.config.evidenceDirectory, cleanupLocator),
        cleanupBytes,
        { mode: 0o600 },
      );
      verifyTestEvidenceFile({
        evidenceDirectory: fixture.config.evidenceDirectory,
        locator: cleanupLocator,
        contentHash: cleanupEvidence.contentHash,
        byteSize: cleanupEvidence.byteSize,
      });
      cleanupMaterialized = true;
    }
  }
  assert.equal(
    terminalView?.state,
    "passed",
    `Electron fixture did not reach PASS: ${JSON.stringify(
      await inspectTestRun("gesture-limit"),
    )}; Runtime logs: ${JSON.stringify(runtimeLogs)}`,
  );
  await waitForTitle("pass");

  await window.loadURL(
    fixtureUrl(shell.url, { ...route, restoreOnLoad: true }),
  );
  await waitForTitle("pass");

  const recovered = await query("fixture-test-run-inspect", {
    type: "test-runs.inspect",
    testRunId: route.testRunId,
  });
  const pipeline = await supervisor.inspectRun(seeded.runId);
  const audit = await supervisor.audit({ runId: seeded.runId, limit: 1_000 });
  const interactionAudit = await supervisor.audit({ limit: 1_000 });
  const events = await supervisor.events({ afterSequence: 0, limit: 1_000 });
  const downstream = await query("fixture-test-pass-authority", {
    type: "test-pass-authority.inspect",
    testRunId: route.testRunId,
  });
  const candidateInputId = `${fixture.config.fixtureId}:delivery-candidate-input`;
  const advancePipelineNode = async (pipelineNodeId) => {
    const before = await supervisor.inspectRun(seeded.runId);
    await waitForElementState(
      "[data-run-continue]",
      (state) => state.disabled === false,
    );
    await clickElement("[data-run-continue]");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await supervisor.inspectRun(seeded.runId);
      const node = current.nodes.find(
        (entry) => entry.pipelineNodeId === pipelineNodeId,
      );
      if (
        node?.status === "succeeded" ||
        (pipelineNodeId === "candidate" &&
          current.run.status === "waiting-human-release")
      ) {
        return current;
      }
      if (current.run.status === "blocked" || current.run.status === "failed") {
        throw new Error(
          `Pipeline ${pipelineNodeId} stopped in ${current.run.status}: ${JSON.stringify(current.nodes)}`,
        );
      }
      if (current.run.revision === before.run.revision) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const current = await supervisor.inspectRun(seeded.runId);
    const node = current.nodes.find(
      (entry) => entry.pipelineNodeId === pipelineNodeId,
    );
    throw new Error(
      `Timed out advancing Pipeline Node ${pipelineNodeId}: ${JSON.stringify({ run: current.run, node, runtimeLogs })}.`,
    );
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await window.loadURL(shell.url);
    await waitForElement('[data-nav="projects"]');
    await clickElement('[data-nav="projects"]');
    try {
      await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await clickElement(`[data-project-id="${seeded.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
  await clickElement('[data-project-tab="runs"]');
  await waitForElement(`[data-run-detail="${seeded.runId}"]`);

  const candidateInputPipeline = await advancePipelineNode("candidate-input");
  assert.equal(
    candidateInputPipeline.nodes.find(
      (node) => node.pipelineNodeId === "candidate-input",
    )?.status,
    "succeeded",
  );
  const candidateInspection = await query("fixture-candidate-input", {
    type: "delivery-candidate-input.inspect",
    candidateInputId,
  });
  const candidate = candidateInspection.view;
  assert.equal(candidate.id, candidateInputId);
  assert.equal(candidate.manifest.risk.tier, "critical");
  assert.equal(
    candidate.manifest.tests[0]?.passAuthorityHash,
    downstream.view.passAuthorityHash,
  );

  await clickElement('[data-project-tab="reviews"]');
  const awaitingCriticalEscalationObservation =
    await waitForCandidateObservation(
      (observation) =>
        observation.candidateInputId === candidate.id &&
        observation.criticalEscalationId === null &&
        observation.authorizeCriticalVisible === true,
    );
  await clickElement("#authorize-critical-risk-continuation");
  const authorizedCriticalEscalationObservation =
    await waitForCandidateObservation(
      (observation) =>
        typeof observation.criticalEscalationId === "string" &&
        observation.authorizeCriticalVisible === false &&
        observation.sync === "ready",
    );

  await clickElement('[data-project-tab="runs"]');
  await waitForElement(`[data-run-supervision="${seeded.runId}"]`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await advancePipelineNode("security");
  await advancePipelineNode("operability");
  const waitingPipeline = await advancePipelineNode("candidate");
  assert.equal(waitingPipeline.run.status, "waiting-human-release");
  assert.equal(
    waitingPipeline.nodes.find(
      (node) => node.pipelineNodeId === "human-release",
    )?.status,
    "waiting-approval",
  );

  const finalQualityView = await query("fixture-quality-gates-final", {
    type: "quality-gates.inspect",
    candidateInputId: candidate.id,
  });
  assert.ok(finalQualityView.view.authority?.authorityHash);
  assert.equal(finalQualityView.view.gateResults.length, 2);
  assert.equal(
    finalQualityView.view.gateResults.every((entry) => entry.result === "PASS"),
    true,
  );
  const securityGateResult = finalQualityView.view.gateResults.find(
    (entry) => entry.id === finalQualityView.view.authority.security.resultId,
  );
  const operabilityGateResult = finalQualityView.view.gateResults.find(
    (entry) =>
      entry.id === finalQualityView.view.authority.operability.resultId,
  );
  assert.ok(securityGateResult);
  assert.ok(operabilityGateResult);

  const deliveryCandidateId = `${fixture.config.fixtureId}:delivery-candidate`;
  const deliveryInspection = await query("fixture-delivery-candidate", {
    type: "delivery-candidates.inspect",
    candidateId: deliveryCandidateId,
  });
  const deliveryCandidate = deliveryInspection.view;
  assert.equal(deliveryCandidate.projection, "awaiting-decision");
  assert.equal(deliveryCandidate.decision, null);

  let awaitingDeliveryObservation;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickElement('[data-project-tab="reviews"]');
    try {
      awaitingDeliveryObservation = await waitForDeliveryCandidateObservation(
        (observation) =>
          observation.candidateId === deliveryCandidate.id &&
          observation.manifestHash === deliveryCandidate.manifestHash &&
          observation.projection === "awaiting-decision" &&
          observation.sync === "ready" &&
          observation.acceptVisible === true,
        5_000,
      );
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      if (await readElementState("[data-integration-diagnostic] button")) {
        await clickElement("[data-integration-diagnostic] button");
        continue;
      }
      await window.reload();
      await waitForElement('[data-nav="projects"]');
      await clickElement('[data-nav="projects"]');
      await waitForElement(`[data-project-id="${seeded.projectId}"]`);
      await clickElement(`[data-project-id="${seeded.projectId}"]`);
      await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
    }
  }
  assert.ok(awaitingDeliveryObservation);
  const reviewsCursorStates = (records) =>
    records
      .filter(
        (record) =>
          record.action === "runtime.events.acknowledged" &&
          record.entityId === "electron-test-fixture-human-release",
      )
      .map((record) => record.after)
      .filter(
        (state) =>
          state &&
          Number.isInteger(state.sequence) &&
          Number.isInteger(state.subscriptionGeneration),
      )
      .sort(
        (left, right) =>
          left.subscriptionGeneration - right.subscriptionGeneration ||
          left.sequence - right.sequence,
      );
  const auditsBeforeRendererReload = await supervisor.audit({ limit: 1_000 });
  const eventsBeforeRendererReload = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  const cursorBeforeRendererReload = reviewsCursorStates(
    auditsBeforeRendererReload,
  ).at(-1);
  assert.ok(cursorBeforeRendererReload);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await window.reload();
    await waitForElement('[data-nav="projects"]');
    await clickElement('[data-nav="projects"]');
    try {
      await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await clickElement(`[data-project-id="${seeded.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
  await clickElement('[data-project-tab="reviews"]');
  let reloadedCandidateObservation;
  let reloadedDeliveryObservation;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      reloadedCandidateObservation = await waitForCandidateObservation(
        (observation) =>
          observation.candidateInputId === candidate.id &&
          observation.authorityId === finalQualityView.view.authority?.id &&
          observation.sync === "ready",
        3_000,
      );
      reloadedDeliveryObservation = await waitForDeliveryCandidateObservation(
        (observation) =>
          observation.candidateId === deliveryCandidate.id &&
          observation.manifestHash === deliveryCandidate.manifestHash &&
          observation.projection === "awaiting-decision" &&
          observation.sync === "ready" &&
          observation.decisionId === null,
        3_000,
      );
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      if (await readElementState("[data-integration-diagnostic] button")) {
        await clickElement("[data-integration-diagnostic] button");
        continue;
      }
      await window.reload();
      await waitForElement('[data-nav="projects"]');
      await clickElement('[data-nav="projects"]');
      await waitForElement(`[data-project-id="${seeded.projectId}"]`);
      await clickElement(`[data-project-id="${seeded.projectId}"]`);
      await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
      await clickElement('[data-project-tab="reviews"]');
    }
  }
  assert.ok(reloadedCandidateObservation);
  assert.ok(reloadedDeliveryObservation);
  const auditsAfterRendererReload = await supervisor.audit({ limit: 1_000 });
  const eventsAfterRendererReload = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  const cursorAfterRendererReload = reviewsCursorStates(
    auditsAfterRendererReload,
  ).at(-1);
  assert.ok(cursorAfterRendererReload);
  assert.ok(
    cursorAfterRendererReload.subscriptionGeneration >
      cursorBeforeRendererReload.subscriptionGeneration,
  );
  assert.ok(
    cursorAfterRendererReload.sequence >= cursorBeforeRendererReload.sequence,
  );
  assert.equal(
    eventsAfterRendererReload.length,
    eventsBeforeRendererReload.length,
  );

  const productDiscovery = await query("fixture-product-final", {
    type: "product.discovery.inspect",
    projectId: seeded.projectId,
  });
  const productBaseline = productDiscovery.view.baselines.find(
    (baseline) => baseline.runId === seeded.runId,
  );
  assert.ok(productBaseline);
  assert.deepEqual(
    productDiscovery.view.proposal?.currentRevision.content.scope,
    ["T21 Product-to-Candidate plus T22 Release operations"],
  );
  const technicalReview = await query("fixture-technical-lineage", {
    type: "technical-review.inspect",
    runId: seeded.runId,
  });
  const workPackages = await query("fixture-work-package-lineage", {
    type: "work-packages.inspect",
    runId: seeded.runId,
  });
  const codeReviews = await query("fixture-code-review-lineage", {
    type: "code-reviews.inspect",
    runId: seeded.runId,
  });
  const integrationGenerations = await query("fixture-integration-lineage", {
    type: "integration-generations.inspect",
    runId: seeded.runId,
  });
  const testPassAuthority = await query("fixture-test-lineage", {
    type: "test-pass-authority.inspect",
    testRunId: route.testRunId,
  });
  const productReview = await query("fixture-product-review-lineage", {
    type: "product-review.inspect",
    runId: seeded.runId,
  });
  const projectArtifacts = {
    view: await humanRuntimeClient.query({
      type: "artifacts.list",
      projectId: seeded.projectId,
    }),
  };
  const candidateManifest = candidate.manifest;
  const deliveryManifest = deliveryCandidate.manifest;
  const acceptedTechnicalBaseline = technicalReview.view.acceptedBaseline;
  assert.ok(acceptedTechnicalBaseline);
  assert.equal(candidateManifest.product.baselineId, productBaseline.id);
  assert.equal(candidateManifest.product.baselineHash, productBaseline.hash);
  assert.equal(
    candidateManifest.product.sourceProposalRevisionId,
    productBaseline.sourceProposalRevisionId,
  );
  assert.equal(
    candidateManifest.product.sourceProposalHash,
    productBaseline.sourceProposalHash,
  );
  const projectSpecRevision = productReview.view.specRevisions.find(
    (revision) =>
      revision.id === candidateManifest.product.projectSpecRevisionId,
  );
  assert.ok(projectSpecRevision);
  assert.equal(
    projectSpecRevision.hash,
    candidateManifest.product.projectSpecHash,
  );
  assert.equal(
    candidateManifest.technical.baselineId,
    acceptedTechnicalBaseline.id,
  );
  assert.equal(
    candidateManifest.technical.baselineHash,
    acceptedTechnicalBaseline.hash,
  );
  assert.equal(
    canonicalJson(candidateManifest.technical.manifest),
    canonicalJson(acceptedTechnicalBaseline.manifest),
  );
  const queriedIntegrationGeneration = integrationGenerations.view.find(
    (generation) => generation.id === candidateManifest.integration.id,
  );
  assert.ok(queriedIntegrationGeneration);
  assert.equal(
    canonicalJson(queriedIntegrationGeneration),
    canonicalJson(candidateManifest.integration),
  );
  assert.equal(
    canonicalJson(candidateManifest.tests),
    canonicalJson([testPassAuthority.view]),
  );
  const queriedWorkPackageVersions = workPackages.view.packages
    .flatMap((workPackage) => workPackage.versions)
    .filter((version) =>
      candidateManifest.codeReviewCoverage.some(
        (coverage) => coverage.workPackageVersionId === version.id,
      ),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    queriedWorkPackageVersions.map((version) => version.id),
    candidateManifest.codeReviewCoverage
      .map((coverage) => coverage.workPackageVersionId)
      .sort(),
  );
  const queriedCodeReviewLineage = candidateManifest.codeReviewCoverage
    .map((coverage) => {
      const review = codeReviews.view.find(
        (entry) =>
          entry.manifest.workPackageVersionId === coverage.workPackageVersionId,
      );
      assert.ok(review);
      assert.ok(review.authority);
      assert.ok(review.gateResult);
      assert.equal(
        review.manifestHash,
        coverage.reviewContext.codeReviewManifestHash,
      );
      assert.equal(review.authority.id, coverage.authorityId);
      assert.equal(
        review.authority.qualityGateResultId,
        coverage.qualityGateResultId,
      );
      assert.equal(review.authority.sourceCommit, coverage.sourceCommit);
      assert.equal(review.authority.diffHash, coverage.diffHash);
      return review;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const queriedRepositoryCommits =
    queriedIntegrationGeneration.repositoryResults
      .map((result) => ({
        repositoryReference: result.repositoryReference,
        commit: result.integratedCommit,
      }))
      .sort((left, right) =>
        left.repositoryReference.localeCompare(right.repositoryReference),
      );
  assert.equal(
    queriedRepositoryCommits.every((entry) => entry.commit !== null),
    true,
  );
  assert.equal(
    canonicalJson(queriedRepositoryCommits),
    canonicalJson(candidateManifest.repositoryCommits),
  );
  const queriedCandidateArtifacts = projectArtifacts.view
    .filter((artifact) =>
      candidateManifest.artifacts.some((entry) => entry.id === artifact.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const queriedCandidateArtifactsWithAuthority = queriedCandidateArtifacts.map(
    (artifact) =>
      artifact.id === testPassAuthority.view.build.artifactVersionId
        ? {
            ...artifact,
            producer: {
              ...artifact.producer,
              integrationAuthority: testPassAuthority.view.integrationAuthority,
            },
          }
        : artifact,
  );
  assert.equal(
    canonicalJson(queriedCandidateArtifactsWithAuthority),
    canonicalJson(
      [...candidateManifest.artifacts].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    ),
  );
  assert.equal(
    canonicalJson(deliveryManifest.candidateInput),
    canonicalJson({
      id: candidate.id,
      hash: candidate.manifestHash,
      manifest: candidate.manifest,
    }),
  );
  assert.equal(
    canonicalJson(deliveryManifest.gateAuthority),
    canonicalJson(finalQualityView.view.authority),
  );
  for (const key of [
    "product",
    "technical",
    "codeReviewCoverage",
    "integration",
    "repositoryCommits",
    "contracts",
    "tests",
    "testCaseRevisions",
    "artifacts",
    "risk",
    "evidence",
    "environment",
    "evidencePolicy",
  ]) {
    assert.equal(
      canonicalJson(deliveryManifest[key]),
      canonicalJson(candidateManifest[key]),
      `Delivery Candidate ${key} lineage differs from its frozen Candidate Input.`,
    );
  }
  const lineageReport = {
    canonicalMatch: true,
    technicalBaseline: {
      id: acceptedTechnicalBaseline.id,
      hash: acceptedTechnicalBaseline.hash,
      proposalRevisionId: candidateManifest.technical.proposalRevisionId,
      proposalRevisionHash: candidateManifest.technical.proposalRevisionHash,
    },
    workPackageVersions: queriedWorkPackageVersions.map((version) => ({
      id: version.id,
      manifestHash: version.manifestHash,
    })),
    codeReviews: queriedCodeReviewLineage.map((review) => ({
      id: review.id,
      manifestHash: review.manifestHash,
      authorityId: review.authority.id,
      qualityGateResultId: review.authority.qualityGateResultId,
      qualityGateManifestHash: review.gateResult.manifestHash,
    })),
    repositories: candidateManifest.repositoryCommits,
    artifacts: queriedCandidateArtifacts.map((artifact) => ({
      id: artifact.id,
      identityHash: artifact.identityHash,
      contentHash: artifact.contentHash,
    })),
    testAuthorities: candidateManifest.tests.map((test) => ({
      testRunId: test.testRunId,
      manifestHash: test.manifestHash,
      passAuthorityHash: test.passAuthorityHash,
    })),
    gateAuthority: {
      id: finalQualityView.view.authority.id,
      hash: finalQualityView.view.authority.authorityHash,
      securityResultId: finalQualityView.view.authority.security.resultId,
      securityResultHash: finalQualityView.view.authority.security.resultHash,
      operabilityResultId: finalQualityView.view.authority.operability.resultId,
      operabilityResultHash:
        finalQualityView.view.authority.operability.resultHash,
    },
    candidateInput: { id: candidate.id, manifestHash: candidate.manifestHash },
    candidate: {
      id: deliveryCandidate.id,
      manifestHash: deliveryCandidate.manifestHash,
    },
  };

  const measureAuthorityCounts = async (label) => {
    const [runs, discovery, artifacts, gates, candidates] = await Promise.all([
      humanRuntimeClient
        .query({
          type: "runs.list",
          projectId: seeded.projectId,
        })
        .then((view) => ({ view })),
      query(`fixture-counts:${label}:product`, {
        type: "product.discovery.inspect",
        projectId: seeded.projectId,
      }),
      humanRuntimeClient
        .query({
          type: "artifacts.list",
          projectId: seeded.projectId,
        })
        .then((view) => ({ view })),
      query(`fixture-counts:${label}:gates`, {
        type: "quality-gates.inspect",
        candidateInputId: candidate.id,
      }),
      query(`fixture-counts:${label}:candidates`, {
        type: "delivery-candidates.list",
        runId: seeded.runId,
      }),
    ]);
    const audits = await supervisor.audit({ limit: 1_000 });
    const runtimeEvents = await supervisor.events({
      afterSequence: 0,
      limit: 1_000,
    });
    const snapshotRevisionOneIds = new Set(
      discovery.view.baselines.flatMap((baseline) => {
        const formalRun = discovery.view.formalRuns.find(
          (run) => run.runId === baseline.runId,
        );
        const run = runs.view.find((entry) => entry.run.id === baseline.runId);
        return formalRun?.productBaselineId === baseline.id &&
          formalRun.snapshotRevisionId === run?.run.snapshotRevisionId &&
          run?.run.productBaselineId === baseline.id
          ? [baseline.snapshotRevisionId]
          : [];
      }),
    );
    assert.equal(
      snapshotRevisionOneIds.size,
      1,
      `${label} replay measurement must resolve exactly one Product-confirmation r1 Snapshot.`,
    );
    assert.equal(
      snapshotRevisionOneIds.has(productBaseline.snapshotRevisionId),
      true,
    );
    return {
      runs: runs.view.length,
      baselines: discovery.view.baselines.length,
      snapshotRevisionOne: snapshotRevisionOneIds.size,
      attempts: runs.view.reduce(
        (total, run) =>
          total +
          run.nodes.reduce(
            (runTotal, node) => runTotal + node.attempts.length,
            0,
          ),
        0,
      ),
      artifacts: artifacts.view.length,
      gateInputs: gates.view.gateInputs.length,
      gateResults: gates.view.gateResults.length,
      gateAuthorities: gates.view.authority ? 1 : 0,
      candidates: candidates.view.length,
      audits: audits.length,
      events: runtimeEvents.length,
    };
  };
  const measureCandidateRestartState = async () => {
    const [runs, candidateInput, gates, candidates] = await Promise.all([
      humanRuntimeClient.query({
        type: "runs.list",
        projectId: seeded.projectId,
      }),
      humanRuntimeClient.query({
        type: "delivery-candidate-input.inspect",
        candidateInputId: candidate.id,
      }),
      humanRuntimeClient.query({
        type: "quality-gates.inspect",
        candidateInputId: candidate.id,
      }),
      humanRuntimeClient.query({
        type: "delivery-candidates.list",
        runId: seeded.runId,
      }),
    ]);
    const run = runs.find((entry) => entry.run.id === seeded.runId);
    const restartedCandidate = candidates.find(
      (entry) => entry.id === deliveryCandidate.id,
    );
    assert.ok(run);
    assert.ok(restartedCandidate);
    const formalAudits = await supervisor.audit({
      runId: seeded.runId,
      limit: 1_000,
    });
    const runtimeEvents = await supervisor.events({
      afterSequence: 0,
      limit: 1_000,
    });
    return {
      run: {
        id: run.run.id,
        hash: hashValue(run),
        snapshotRevisionId: run.run.snapshotRevisionId,
        productBaselineId: run.run.productBaselineId,
        status: run.run.status,
      },
      candidateInput: {
        id: candidateInput.id,
        manifestHash: candidateInput.manifestHash,
        entityHash: hashValue(candidateInput),
      },
      gates: {
        entityHash: hashValue(gates),
        inputIds: gates.gateInputs.map((entry) => entry.id).sort(),
        resultHashes: gates.gateResults
          .map((entry) => [entry.id, entry.resultHash])
          .sort(([left], [right]) => left.localeCompare(right)),
        authorityId: gates.authority?.id,
        authorityHash: gates.authority?.authorityHash,
      },
      candidate: {
        id: restartedCandidate.id,
        manifestHash: restartedCandidate.manifestHash,
        entityHash: hashValue(restartedCandidate),
      },
      counts: {
        runs: runs.length,
        nodes: run.nodes.length,
        attempts: run.nodes.reduce(
          (total, node) => total + node.attempts.length,
          0,
        ),
        gateInputs: gates.gateInputs.length,
        gateResults: gates.gateResults.length,
        gateAuthorities: gates.authority ? 1 : 0,
        candidates: candidates.length,
        formalAudits: formalAudits.length,
        runtimeEvents: runtimeEvents.length,
      },
      formalAuditHash: hashValue(formalAudits),
      runtimeEventHash: hashValue(runtimeEvents),
    };
  };

  const candidateRestartPidBefore = restartHealth.pid;
  const candidateRestartClaimBefore = basename(fixture.authorizationClaimPath);
  const candidateRestartAuthorityCountsBefore = await measureAuthorityCounts(
    "candidate-restart-before",
  );
  const candidateRestartStateBefore = await measureCandidateRestartState();
  const cursorBeforeCandidateRestart = reviewsCursorStates(
    await supervisor.audit({ limit: 1_000 }),
  ).at(-1);
  assert.ok(cursorBeforeCandidateRestart);
  await supervisor.stop();
  const candidateRestartHealth = await supervisor.start(
    fixture.config.companyDirectory,
  );
  const candidateRestartClaimAfter = basename(fixture.authorizationClaimPath);
  assert.equal(candidateRestartHealth.schemaVersion, 52);
  assert.notEqual(candidateRestartHealth.pid, candidateRestartPidBefore);
  assert.notEqual(candidateRestartClaimAfter, candidateRestartClaimBefore);
  const candidateRestartAuthorityCountsAfter = await measureAuthorityCounts(
    "candidate-restart-after",
  );
  const candidateRestartStateAfter = await measureCandidateRestartState();
  assert.equal(
    canonicalJson(candidateRestartAuthorityCountsAfter),
    canonicalJson(candidateRestartAuthorityCountsBefore),
  );
  assert.equal(
    canonicalJson(candidateRestartStateAfter),
    canonicalJson(candidateRestartStateBefore),
  );
  const eventsBeforeCandidateRestartReconnect = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await window.reload();
    await waitForElement('[data-nav="projects"]');
    await clickElement('[data-nav="projects"]');
    try {
      await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await clickElement(`[data-project-id="${seeded.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
  await clickElement('[data-project-tab="reviews"]');
  const restartedCandidateObservation = await waitForCandidateObservation(
    (observation) =>
      observation.candidateInputId === candidate.id &&
      observation.authorityId === finalQualityView.view.authority?.id &&
      observation.sync === "ready",
  );
  const restartedDeliveryObservation =
    await waitForDeliveryCandidateObservation(
      (observation) =>
        observation.candidateId === deliveryCandidate.id &&
        observation.manifestHash === deliveryCandidate.manifestHash &&
        observation.projection === "awaiting-decision" &&
        observation.sync === "ready" &&
        observation.decisionId === null,
    );
  const candidateRestartAudits = await supervisor.audit({ limit: 1_000 });
  const cursorAfterCandidateRestart = reviewsCursorStates(
    candidateRestartAudits,
  ).at(-1);
  assert.ok(cursorAfterCandidateRestart);
  assert.ok(
    cursorAfterCandidateRestart.subscriptionGeneration >
      cursorBeforeCandidateRestart.subscriptionGeneration,
  );
  assert.ok(
    cursorAfterCandidateRestart.sequence >=
      cursorBeforeCandidateRestart.sequence,
  );
  const eventsAfterCandidateRestartReconnect = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  assert.equal(
    canonicalJson(eventsAfterCandidateRestartReconnect),
    canonicalJson(eventsBeforeCandidateRestartReconnect),
  );
  const candidateRestartEvidence = {
    before: candidateRestartStateBefore,
    after: candidateRestartStateAfter,
    runtime: {
      before: {
        pid: candidateRestartPidBefore,
        authorizationClaim: candidateRestartClaimBefore,
      },
      after: {
        pid: candidateRestartHealth.pid,
        authorizationClaim: candidateRestartClaimAfter,
      },
    },
    authorityCounts: {
      before: candidateRestartAuthorityCountsBefore,
      after: candidateRestartAuthorityCountsAfter,
    },
    renderer: {
      candidateInputId: restartedCandidateObservation.candidateInputId,
      candidateId: restartedDeliveryObservation.candidateId,
      candidateManifestHash: restartedDeliveryObservation.manifestHash,
      sync: restartedDeliveryObservation.sync,
      before: cursorBeforeCandidateRestart,
      after: cursorAfterCandidateRestart,
      runtimeEventCount: {
        before: eventsBeforeCandidateRestartReconnect.length,
        after: eventsAfterCandidateRestartReconnect.length,
      },
    },
  };
  const humanActor = {
    type: "human",
    id: "electron-test-fixture",
    authenticatedBy: "local-session",
  };
  const deliveryQualityActor = {
    type: "runtime-worker",
    id: "delivery-quality-node-handler",
    authenticatedBy: "runtime",
  };
  const replayEnvelope = (client, actor, consumerId, envelope) =>
    client.executeEnvelope({
      schemaVersion: 1,
      actor,
      consumerId,
      ...envelope,
    });
  const authorityCountsBeforeReplay = await measureAuthorityCounts("before");
  const productReplayEnvelope = {
    commandId: productBaseline.confirmationCommandId,
    expectedRevision: productDiscovery.view.proposal.revision,
    command: {
      type: "confirm-product-baseline",
      projectId: seeded.projectId,
      departmentId: preparation.departmentId,
      proposalRevisionId: productBaseline.sourceProposalRevisionId,
      proposalHash: productBaseline.sourceProposalHash,
    },
  };
  const productReplay = await replayEnvelope(
    humanRuntimeClient,
    humanActor,
    "electron-test-fixture-human-release",
    productReplayEnvelope,
  );
  assert.equal(productReplay.status, "succeeded");
  const replayedProductBaseline = productReplay.value.baselines.find(
    (baseline) => baseline.id === productBaseline.id,
  );
  assert.equal(
    canonicalJson(replayedProductBaseline),
    canonicalJson(productBaseline),
  );

  const gateFinalizeReplays = [];
  for (const gateResult of [securityGateResult, operabilityGateResult]) {
    const kind = gateResult.id.includes(":security-")
      ? "security"
      : "operability";
    const commandId = `${fixture.config.fixtureId}:${kind}-gate-result-finalize`;
    const replay = await replayEnvelope(
      deliveryQualityRuntimeClient,
      deliveryQualityActor,
      "delivery-quality-node-handler",
      {
        commandId,
        command: {
          type: "quality-gate.result.finalize",
          candidateGateResultId: gateResult.id,
          gateInputId: gateResult.gateInputId,
          executionId: gateResult.manifest.execution.id,
          qualityGateResultId: gateResult.qualityGateResultId,
        },
      },
    );
    assert.equal(replay.status, "succeeded");
    assert.equal(canonicalJson(replay.value), canonicalJson(gateResult));
    gateFinalizeReplays.push({ kind, commandId, result: replay });
  }
  const gateAuthorityReplay = await replayEnvelope(
    deliveryQualityRuntimeClient,
    deliveryQualityActor,
    "delivery-quality-node-handler",
    {
      commandId: `${fixture.config.fixtureId}:candidate-input-authorize`,
      command: {
        type: "delivery.candidate-input.authorize",
        authorityId: finalQualityView.view.authority.id,
        candidateInputId: candidate.id,
        expectedCandidateInputHash: candidate.manifestHash,
        securityGateResultId: finalQualityView.view.authority.security.resultId,
        operabilityGateResultId:
          finalQualityView.view.authority.operability.resultId,
      },
    },
  );
  assert.equal(gateAuthorityReplay.status, "succeeded");
  assert.equal(
    canonicalJson(gateAuthorityReplay.value),
    canonicalJson(finalQualityView.view.authority),
  );
  const candidateExecution = {
    view: await humanRuntimeClient.query({
      type: "execution.inspect",
      targetKind: "node-attempt",
      targetId: deliveryManifest.source.nodeAttemptId,
    }),
  };
  const candidateLease = candidateExecution.view.leases.find(
    (lease) =>
      lease.leaseKind === "execution" &&
      lease.workerId === "delivery-quality-node-handler",
  );
  assert.ok(candidateLease);
  const candidateReplay = await replayEnvelope(
    deliveryQualityRuntimeClient,
    deliveryQualityActor,
    "delivery-quality-node-handler",
    {
      commandId: `${fixture.config.fixtureId}:delivery-candidate-assemble`,
      command: {
        type: "delivery.candidate.assemble",
        candidateId: deliveryCandidate.id,
        requestId: deliveryCandidate.requestId,
        candidateInputId: candidate.id,
        expectedCandidateInputHash: candidate.manifestHash,
        expectedGateAuthorityHash:
          finalQualityView.view.authority.authorityHash,
        nodeRunId: deliveryManifest.source.nodeRunId,
        nodeAttemptId: deliveryManifest.source.nodeAttemptId,
        leaseId: candidateLease.leaseId,
        workerId: "delivery-quality-node-handler",
      },
    },
  );
  assert.equal(candidateReplay.status, "succeeded");
  assert.equal(
    canonicalJson(candidateReplay.value),
    canonicalJson(deliveryCandidate),
  );
  const authorityCountsAfterReplay = await measureAuthorityCounts("after");
  assert.equal(
    canonicalJson(authorityCountsAfterReplay),
    canonicalJson(authorityCountsBeforeReplay),
  );
  const duplicateReplayEvidence = {
    counts: {
      before: authorityCountsBeforeReplay,
      after: authorityCountsAfterReplay,
    },
    commands: [
      {
        commandId: productReplayEnvelope.commandId,
        identity: productBaseline.id,
        authorityHash: productBaseline.hash,
        resultHash: hashValue(productReplay),
        effectIds: productReplay.effectIds,
      },
      ...gateFinalizeReplays.map(({ kind, commandId, result }) => ({
        commandId,
        identity: `${kind}:${result.value.id}`,
        authorityHash: result.value.resultHash,
        receiptHash: result.value.manifest.execution.receiptHash,
        resultHash: hashValue(result),
        effectIds: result.effectIds,
      })),
      {
        commandId: `${fixture.config.fixtureId}:candidate-input-authorize`,
        identity: gateAuthorityReplay.value.id,
        authorityHash: gateAuthorityReplay.value.authorityHash,
        resultHash: hashValue(gateAuthorityReplay),
        effectIds: gateAuthorityReplay.effectIds,
      },
      {
        commandId: `${fixture.config.fixtureId}:delivery-candidate-assemble`,
        identity: candidateReplay.value.id,
        authorityHash: candidateReplay.value.manifestHash,
        resultHash: hashValue(candidateReplay),
        effectIds: candidateReplay.effectIds,
      },
    ],
  };

  const ackQuery = await humanRuntimeClient.queryEnvelope({
    schemaVersion: 1,
    requestId: "fixture-duplicate-ack-query",
    principal: humanActor,
    consumerId: "electron-test-fixture-human-release",
    query: {
      type: "delivery-candidates.inspect",
      candidateId: deliveryCandidate.id,
    },
  });
  assert.ok(ackQuery.viewSyncToken);
  const duplicateAckEnvelope = {
    commandId: `${fixture.config.fixtureId}:duplicate-reviews-ack`,
    command: {
      type: "ack-runtime-events",
      sequence: ackQuery.asOfSequence,
      viewSyncToken: ackQuery.viewSyncToken,
    },
  };
  const auditBeforeFirstAck = await supervisor.audit({ limit: 1_000 });
  const eventsBeforeFirstAck = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  const firstAck = await replayEnvelope(
    humanRuntimeClient,
    humanActor,
    "electron-test-fixture-human-release",
    duplicateAckEnvelope,
  );
  assert.equal(firstAck.status, "succeeded");
  const auditAfterFirstAck = await supervisor.audit({ limit: 1_000 });
  const eventsAfterFirstAck = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  assert.equal(auditAfterFirstAck.length, auditBeforeFirstAck.length + 1);
  assert.equal(eventsAfterFirstAck.length, eventsBeforeFirstAck.length);
  const duplicateAck = await replayEnvelope(
    humanRuntimeClient,
    humanActor,
    "electron-test-fixture-human-release",
    duplicateAckEnvelope,
  );
  assert.equal(canonicalJson(duplicateAck), canonicalJson(firstAck));
  const auditAfterDuplicateAck = await supervisor.audit({ limit: 1_000 });
  const eventsAfterDuplicateAck = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  assert.equal(auditAfterDuplicateAck.length, auditAfterFirstAck.length);
  assert.equal(eventsAfterDuplicateAck.length, eventsAfterFirstAck.length);
  const duplicateAckEvidence = {
    commandId: duplicateAckEnvelope.commandId,
    subscriptionGeneration: duplicateAck.value.subscriptionGeneration,
    barrierSequence: duplicateAck.value.barrierSequence,
    resultHash: hashValue(duplicateAck),
    auditCount: {
      before: auditBeforeFirstAck.length,
      afterFirst: auditAfterFirstAck.length,
      afterDuplicate: auditAfterDuplicateAck.length,
    },
    runtimeEventCount: {
      before: eventsBeforeFirstAck.length,
      afterFirst: eventsAfterFirstAck.length,
      afterDuplicate: eventsAfterDuplicateAck.length,
    },
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await window.reload();
    await waitForElement('[data-nav="projects"]');
    await clickElement('[data-nav="projects"]');
    try {
      await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await clickElement(`[data-project-id="${seeded.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
  await clickElement('[data-project-tab="reviews"]');
  await waitForDeliveryCandidateObservation(
    (observation) =>
      observation.candidateId === deliveryCandidate.id &&
      observation.projection === "awaiting-decision" &&
      observation.sync === "ready" &&
      observation.acceptVisible === true,
  );
  await clickElement("#accept-delivery-candidate");
  const acceptedDeliveryObservation = await waitForDeliveryCandidateObservation(
    (observation) =>
      observation.candidateId === deliveryCandidate.id &&
      observation.manifestHash === deliveryCandidate.manifestHash &&
      observation.projection === "accepted" &&
      observation.sync === "ready" &&
      typeof observation.decisionId === "string" &&
      observation.acceptVisible === false,
  );
  await waitForElement("[data-release-operation-panel]");
  const acceptedAuthorityInspection = await query(
    "fixture-accepted-delivery-authority",
    {
      type: "accepted-delivery-authority.inspect",
      candidateId: deliveryCandidate.id,
    },
  );
  const acceptedAuthority = acceptedAuthorityInspection.view;
  assert.equal(acceptedAuthority.candidateId, deliveryCandidate.id);
  assert.equal(acceptedAuthority.candidateHash, deliveryCandidate.manifestHash);
  assert.equal(
    acceptedAuthority.repositoryCommits.length,
    deliveryManifest.repositoryCommits.length,
  );
  assert.ok(acceptedAuthority.artifactVersionIds.length >= 2);

  const git = (repositoryDirectory, ...args) =>
    execFileSync("git", ["-C", repositoryDirectory, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  const fixtureRepositories = [
    {
      repositoryDirectory: fixture.config.repositoryDirectory,
      repositoryCommit: fixture.config.repositoryCommit,
    },
    ...(fixture.config.additionalRepositories ?? []),
  ];
  assert.equal(
    acceptedAuthority.repositoryCommits.length,
    fixtureRepositories.length,
  );
  const releaseRepositories = fixtureRepositories.map(
    (configuration, index) => {
      const authority = acceptedAuthority.repositoryCommits.find(
        (repository) =>
          repository.repositoryReference === configuration.repositoryDirectory,
      );
      assert.ok(
        authority,
        `Fixture Repository ${index + 1} lacks accepted authority.`,
      );
      assert.doesNotThrow(() =>
        git(
          configuration.repositoryDirectory,
          "merge-base",
          "--is-ancestor",
          configuration.repositoryCommit,
          authority.commit,
        ),
      );
      return {
        authority,
        directory: configuration.repositoryDirectory,
        baseCommit: configuration.repositoryCommit,
      };
    },
  );
  assert.equal(releaseRepositories.length, 2);
  const createReleaseTarget = ({ directory, branch, tip }) => {
    const ref = `refs/heads/${branch}`;
    git(directory, "update-ref", ref, tip);
    assert.equal(git(directory, "rev-parse", `${ref}^{commit}`), tip);
    assert.equal(
      git(directory, "worktree", "list", "--porcelain")
        .split("\n")
        .some((line) => line === `branch ${ref}`),
      false,
    );
    return ref;
  };
  const reloadProjectReviews = async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await window.reload();
      await waitForElement('[data-nav="projects"]');
      await clickElement('[data-nav="projects"]');
      try {
        await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    await clickElement(`[data-project-id="${seeded.projectId}"]`);
    await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
    await clickElement('[data-project-tab="reviews"]');
    await waitForDeliveryCandidateObservation(
      (observation) =>
        observation.candidateId === deliveryCandidate.id &&
        observation.projection === "accepted" &&
        observation.sync === "ready",
    );
    await waitForElement("[data-release-operation-panel]");
  };
  const releaseOperationsForCandidate = async (stage) =>
    (
      await query(`fixture-release-operations:${stage}`, {
        type: "release-operations.list",
        candidateId: deliveryCandidate.id,
      })
    ).view;
  const waitForReleaseOperation = async (stage, predicate) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const operations = await releaseOperationsForCandidate(stage);
      const operation = operations.find(predicate);
      if (operation) return operation;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for Release operation ${stage}: ${JSON.stringify(await releaseOperationsForCandidate(`${stage}:timeout`))}.`,
    );
  };
  const fillReleaseAuthorization = async (reason) => {
    await typeElement("[data-release-reason]", reason);
    await typeElement(
      "[data-release-evidence]",
      `delivery-candidate:${deliveryCandidate.id}`,
    );
    await clickElement("[data-release-confirm]");
    await waitForElementState(
      "[data-release-create]",
      (state) => state.disabled === false,
    );
  };
  const submitMerge = async ({ destinations, reason }) => {
    for (const destination of destinations) {
      await typeElement(
        `[data-merge-target="${destination.repositoryReference}"]`,
        destination.targetBranch,
      );
      await typeElement(
        `[data-merge-tip="${destination.repositoryReference}"]`,
        destination.expectedTargetTip,
      );
    }
    await fillReleaseAuthorization(reason);
    await clickElement("[data-release-create]");
  };
  const submitExport = async ({ root, items, reason }) => {
    await clickElement('[data-release-kind="export"]');
    await typeElement("[data-export-root]", root);
    for (const item of items) {
      await clickElement(`[data-export-artifact="${item.artifactVersionId}"]`);
      await typeElement(
        `[data-export-path="${item.artifactVersionId}"]`,
        item.relativePath,
      );
    }
    await fillReleaseAuthorization(reason);
    await clickElement("[data-release-create]");
  };

  const mergeDestinations = releaseRepositories.map((repository, index) => {
    const targetBranch = `release/t22-partial-merge-${index + 1}`;
    return {
      repositoryReference: repository.authority.repositoryReference,
      targetBranch,
      expectedTargetTip: repository.baseCommit,
      targetRef: createReleaseTarget({
        directory: repository.directory,
        branch: targetBranch,
        tip: repository.baseCommit,
      }),
      ...repository,
    };
  });
  const driftDestination = mergeDestinations[1];
  assert.ok(driftDestination);
  const releaseBaseTree = git(
    driftDestination.directory,
    "rev-parse",
    `${driftDestination.baseCommit}^{tree}`,
  );
  const driftCommit = execFileSync(
    "git",
    [
      "-C",
      driftDestination.directory,
      "commit-tree",
      releaseBaseTree,
      "-p",
      driftDestination.baseCommit,
    ],
    {
      input: "fixture release destination drift\n",
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Sandcastle Electron Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Sandcastle Electron Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    },
  ).trim();
  git(
    driftDestination.directory,
    "update-ref",
    driftDestination.targetRef,
    driftCommit,
    driftDestination.baseCommit,
  );
  const operationsBeforeMerge =
    await releaseOperationsForCandidate("before-merge");
  await submitMerge({
    destinations: mergeDestinations,
    reason:
      "Verify independent durable results for the exact accepted Repository destinations.",
  });
  const mergeOperation = await waitForReleaseOperation(
    "merge-partially-succeeded",
    (operation) =>
      operation.request.kind === "merge" &&
      operation.request.items.length === 2 &&
      operation.aggregateState === "partially-succeeded",
  );
  assert.equal(
    (await releaseOperationsForCandidate("after-partial-merge-gesture")).length,
    operationsBeforeMerge.length + 1,
  );
  assert.equal(mergeOperation.aggregateState === "succeeded", false);
  assert.equal(
    new Set(
      mergeOperation.request.items.map((item) => item.repositoryReference),
    ).size,
    2,
  );
  for (const destination of mergeDestinations) {
    const requested = mergeOperation.request.items.find(
      (item) => item.repositoryReference === destination.repositoryReference,
    );
    assert.equal(requested?.sourceCommit, destination.authority.commit);
    assert.equal(requested?.destination.targetBranch, destination.targetBranch);
    assert.equal(
      requested?.destination.expectedTargetTip,
      destination.expectedTargetTip,
    );
  }
  assert.equal(mergeOperation.counts.succeeded, 1);
  assert.equal(mergeOperation.counts.destinationConflict, 1);
  const succeededMerge = mergeOperation.items.find(
    (item) =>
      item.repositoryReference === mergeDestinations[0]?.repositoryReference,
  );
  assert.equal(succeededMerge?.state, "succeeded");
  assert.equal(succeededMerge?.receipt?.kind, "merge");
  assert.equal(
    succeededMerge?.receipt?.resultingTargetTip,
    mergeDestinations[0]?.authority.commit,
  );
  assert.equal(
    git(
      mergeDestinations[0].directory,
      "rev-parse",
      `${mergeDestinations[0].targetRef}^{commit}`,
    ),
    mergeDestinations[0].authority.commit,
  );
  const conflictedMerge = mergeOperation.items.find(
    (item) => item.repositoryReference === driftDestination.repositoryReference,
  );
  assert.equal(conflictedMerge?.state, "destination-conflict");
  assert.equal(
    git(
      driftDestination.directory,
      "rev-parse",
      `${driftDestination.targetRef}^{commit}`,
    ),
    driftCommit,
  );
  const partialMergeEvents = (
    await supervisor.events({ afterSequence: 0, limit: 1_000 })
  ).filter(
    (event) =>
      event.type === "delivery.release-operation.invalidated" &&
      event.payload?.releaseOperationId === mergeOperation.id,
  );
  assert.ok(partialMergeEvents.length > 0);
  await waitForReleaseOperationObservation((observation) =>
    observation.operations.some(
      (operation) =>
        operation.id === mergeOperation.id &&
        operation.text.includes("partially-succeeded"),
    ),
  );
  await reloadProjectReviews();
  await waitForReleaseOperationObservation((observation) =>
    observation.operations.some(
      (operation) =>
        operation.id === mergeOperation.id &&
        operation.text.includes("partially-succeeded"),
    ),
  );

  const exportRoot = join(fixture.root, "release-exports");
  mkdirSync(exportRoot, { mode: 0o700 });
  const exportedArtifactId = acceptedAuthority.artifactVersionIds[0];
  const exportedArtifact = projectArtifacts.view.find(
    (artifact) => artifact.id === exportedArtifactId,
  );
  assert.ok(exportedArtifact);
  await reloadProjectReviews();
  await submitExport({
    root: exportRoot,
    items: [
      {
        artifactVersionId: exportedArtifactId,
        relativePath: "applied/artifact.bin",
      },
    ],
    reason:
      "Export the exact accepted Artifact Version with create-only authority.",
  });
  const exportOperation = await waitForReleaseOperation(
    "export-succeeded",
    (operation) =>
      operation.request.kind === "export" &&
      operation.request.items.some(
        (item) => item.destination.relativePath === "applied/artifact.bin",
      ) &&
      operation.aggregateState === "succeeded",
  );
  const exportedPath = join(exportRoot, "applied", "artifact.bin");
  assert.equal(
    sha256(readFileSync(exportedPath)),
    exportedArtifact.contentHash,
  );
  assert.equal(
    exportOperation.items[0]?.receipt?.destinationDigest,
    exportedArtifact.contentHash,
  );
  assert.equal(
    exportOperation.request.items[0]?.destination.overwrite.kind,
    "create-only",
  );

  const partialArtifactIds = acceptedAuthority.artifactVersionIds.slice(0, 2);
  const partialSuccessPath = "partial/succeeded.bin";
  const partialConflictPath = "partial/conflict.bin";
  mkdirSync(join(exportRoot, "partial"), { mode: 0o700 });
  writeFileSync(join(exportRoot, partialConflictPath), "preexisting-conflict", {
    mode: 0o600,
  });
  await reloadProjectReviews();
  await submitExport({
    root: exportRoot,
    items: [
      {
        artifactVersionId: partialArtifactIds[0],
        relativePath: partialSuccessPath,
      },
      {
        artifactVersionId: partialArtifactIds[1],
        relativePath: partialConflictPath,
      },
    ],
    reason: "Verify durable per-item partial export results.",
  });
  const partialExportOperation = await waitForReleaseOperation(
    "export-partial",
    (operation) =>
      operation.request.kind === "export" &&
      operation.request.items.some(
        (item) => item.destination.relativePath === partialSuccessPath,
      ) &&
      operation.aggregateState === "partially-succeeded",
  );
  assert.equal(partialExportOperation.counts.succeeded, 1);
  assert.equal(partialExportOperation.counts.destinationConflict, 1);
  assert.equal(
    readFileSync(join(exportRoot, partialConflictPath), "utf8"),
    "preexisting-conflict",
  );
  assert.equal(
    sha256(readFileSync(join(exportRoot, partialSuccessPath))),
    projectArtifacts.view.find(
      (artifact) => artifact.id === partialArtifactIds[0],
    )?.contentHash,
  );

  const reconcileRoot = join(fixture.root, "release-reconcile");
  const parkedReconcileRoot = join(fixture.root, "release-reconcile-parked");
  const reconcileRelativePath = "crash/recovered.bin";
  mkdirSync(reconcileRoot, { mode: 0o700 });
  releaseFailurePoint = "after-effect-before-finalize";
  await supervisor.stop();
  const releaseCrashHealth = await supervisor.start(
    fixture.config.companyDirectory,
  );
  releaseFailurePoint = null;
  await reloadProjectReviews();
  await submitExport({
    root: reconcileRoot,
    items: [
      {
        artifactVersionId: exportedArtifactId,
        relativePath: reconcileRelativePath,
      },
    ],
    reason:
      "Exercise crash recovery after the external effect and before finalization.",
  });
  const reconcileExportPath = join(reconcileRoot, reconcileRelativePath);
  await waitForFile(reconcileExportPath);
  const runningReleaseOperation = await waitForReleaseOperation(
    "effect-before-finalize",
    (operation) =>
      operation.request.kind === "export" &&
      operation.request.items.some(
        (item) => item.destination.relativePath === reconcileRelativePath,
      ) &&
      operation.items[0]?.state === "running",
  );
  renameSync(reconcileRoot, parkedReconcileRoot);
  symlinkSync(parkedReconcileRoot, reconcileRoot, "dir");
  await supervisor.stop();
  const releaseReconcileHealth = await supervisor.start(
    fixture.config.companyDirectory,
  );
  assert.notEqual(releaseReconcileHealth.pid, releaseCrashHealth.pid);
  const unknownReleaseOperation = await waitForReleaseOperation(
    "restart-unknown",
    (operation) =>
      operation.id === runningReleaseOperation.id &&
      operation.items[0]?.state === "unknown",
  );
  assert.equal(unknownReleaseOperation.aggregateState, "blocked");
  assert.equal(unknownReleaseOperation.nextActions.includes("reconcile"), true);
  await reloadProjectReviews();
  await waitForReleaseOperationObservation((observation) =>
    observation.operations.some(
      (operation) =>
        operation.id === unknownReleaseOperation.id &&
        operation.text.includes("unknown"),
    ),
  );
  unlinkSync(reconcileRoot);
  renameSync(parkedReconcileRoot, reconcileRoot);
  await typeElement(
    `[data-release-operation="${unknownReleaseOperation.id}"] [data-release-reconcile-evidence]`,
    `filesystem-observation:${unknownReleaseOperation.id}`,
  );
  await clickElement(
    `[data-release-operation="${unknownReleaseOperation.id}"] [data-release-reconcile]`,
  );
  const reconciledReleaseOperation = await waitForReleaseOperation(
    "human-reconciled",
    (operation) =>
      operation.id === unknownReleaseOperation.id &&
      operation.aggregateState === "succeeded",
  );
  assert.equal(reconciledReleaseOperation.items[0]?.state, "succeeded");
  assert.equal(
    reconciledReleaseOperation.items[0]?.receipt?.destinationDigest,
    exportedArtifact.contentHash,
  );
  await reloadProjectReviews();
  const reloadedReleaseObservation = await waitForReleaseOperationObservation(
    (observation) =>
      observation.operations.some(
        (operation) =>
          operation.id === reconciledReleaseOperation.id &&
          operation.text.includes("succeeded"),
      ),
  );

  const t26MetricId = "product-baseline-confirmation-count";
  const t26ConsumerId = "electron-test-fixture-human-release";
  const executeT26 = async (commandId, command) => {
    const result = await humanRuntimeClient.executeEnvelope({
      schemaVersion: 1,
      commandId,
      actor: humanActor,
      consumerId: t26ConsumerId,
      command,
    });
    assert.equal(
      result.status,
      "succeeded",
      result.status === "rejected"
        ? `${result.error.code}: ${result.error.message}`
        : undefined,
    );
    if (result.status !== "succeeded") {
      throw new Error(`T26 Command ${commandId} was rejected.`);
    }
    return result;
  };
  const waitForT26Proposal = async (proposalId, predicate) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const proposals = await humanRuntimeClient.query({
        type: "improvement-proposals.list",
        projectId: seeded.projectId,
      });
      const proposal = proposals.find((entry) => entry.id === proposalId);
      if (proposal && predicate(proposal)) return proposal;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for T26 proposal ${proposalId}.`);
  };
  const waitForT26Application = async (operationId, predicate) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const applications = await humanRuntimeClient.query({
        type: "improvement-applications.list",
        projectId: seeded.projectId,
      });
      const application = applications.find(
        (entry) => entry.id === operationId,
      );
      if (application && predicate(application)) return application;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for T26 application ${operationId}.`);
  };
  const repositoryState = (configuration) => ({
    repositoryDirectory: configuration.repositoryDirectory,
    repositoryHead: git(configuration.repositoryDirectory, "rev-parse", "HEAD"),
    repositoryIndex: git(configuration.repositoryDirectory, "ls-files", "-s"),
    repositoryStatus: git(
      configuration.repositoryDirectory,
      "status",
      "--short",
      "--untracked-files=all",
    ),
    worktreeDirectory: configuration.worktreeDirectory,
    worktreeHead: git(configuration.worktreeDirectory, "rev-parse", "HEAD"),
    worktreeIndex: git(configuration.worktreeDirectory, "ls-files", "-s"),
    worktreeStatus: git(
      configuration.worktreeDirectory,
      "status",
      "--short",
      "--untracked-files=all",
    ),
  });
  const t26Repositories = [
    {
      repositoryDirectory: fixture.config.repositoryDirectory,
      worktreeDirectory: fixture.config.worktreeDirectory,
    },
    ...(fixture.config.additionalRepositories ?? []),
  ];
  const captureT26Invariants = async () => ({
    run: await humanRuntimeClient.query({
      type: "run.inspect",
      runId: seeded.runId,
    }),
    pipeline: await humanRuntimeClient.query({
      type: "department.pipeline.inspect",
      departmentId: preparation.departmentId,
    }),
    skills: await humanRuntimeClient.query({
      type: "department.skill-configuration.inspect",
      departmentId: preparation.departmentId,
    }),
    repositories: t26Repositories.map(repositoryState),
  });
  const t26InvariantsBefore = await captureT26Invariants();
  assert.equal(
    t26InvariantsBefore.run.run.snapshotRevisionId,
    seeded.snapshotRevisionId,
  );
  assert.equal(
    t26InvariantsBefore.repositories.every(
      (repository) =>
        repository.repositoryStatus === "" && repository.worktreeStatus === "",
    ),
    true,
  );

  const t26Project = await humanRuntimeClient.query({
    type: "project.inspect",
    projectId: seeded.projectId,
  });
  const t26ProjectStart = Date.parse(t26Project.createdAt);
  const sourceQuery = {
    projectId: seeded.projectId,
    window: {
      kind: "explicit-utc-half-open",
      startInclusive: t26Project.createdAt,
      endExclusive: new Date(
        Math.max(Date.now(), t26ProjectStart + 24 * 60 * 60 * 1_000),
      ).toISOString(),
    },
    cohort: { id: "cohort:t26-electron-source" },
    comparisonSet: {
      id: "comparison:t26-electron-source",
      metricIds: [t26MetricId],
    },
  };
  const sourceEvidenceResult = await executeT26("fixture:t26:source-evidence", {
    type: "statistics.evidence.freeze",
    evidenceSnapshotId: "statistics-evidence:t26:source",
    query: sourceQuery,
  });
  const sourceEvidence = sourceEvidenceResult.value;
  const sourceMetric = sourceEvidence.observations.find(
    (observation) => observation.metricId === t26MetricId,
  );
  assert.equal(sourceMetric?.status, "available");
  assert.equal(sourceMetric?.measurement?.kind, "count");
  assert.equal(sourceMetric?.measurement?.value, 0);
  const sourceOwnerId = "harness:t26-electron";
  const bootstrapHarnessContent = {
    principles: ["Preserve governed history."],
    constitution: "Restore only exact governed revisions.",
    rules: ["Require an exact rollback source."],
    examples: { positive: [], negative: [] },
    impactScope: ["electron-test-fixture"],
  };
  const bootstrapRevision = {
    revisionId: `improvement-genesis:${sha256(
      canonicalJson({
        ownerId: "harness:t26-electron",
        targetKind: "harness",
      }),
    ).slice(0, 48)}`,
    revisionHash: sha256(canonicalJson(bootstrapHarnessContent)),
  };
  const sourceProposalId = "improvement-proposal:t26:source";
  const sourceProposalRevisionId = "improvement-proposal-revision:t26:source:1";
  const sourceContent = {
    evidence: sourceEvidence,
    target: {
      targetKind: "harness",
      ownerId: sourceOwnerId,
      governedHead: bootstrapRevision,
      content: {
        principles: ["Use exact frozen evidence."],
        constitution: "Keep the disposable Electron Harness bounded.",
        rules: ["Apply only reviewed Runtime-owned revisions."],
        examples: { positive: [], negative: [] },
        impactScope: [seeded.projectId],
      },
    },
    rootCauseHypothesis: "The Harness needs one governed source revision.",
    impactScope: {
      projectIds: [seeded.projectId],
      departmentIds: [],
      positionIds: [],
    },
    expectedMetrics: [{ metricId: t26MetricId, direction: "decrease" }],
    validationPolicy: {
      metricIds: [t26MetricId],
      minimumComparableObservations: 1,
    },
    rolloutNotes:
      "Create the disposable rollback source through formal Runtime Commands.",
    rollbackSource: bootstrapRevision,
  };
  const sourceCreated = await executeT26("fixture:t26:source-create", {
    type: "improvement.proposal.create",
    proposal: {
      proposalId: sourceProposalId,
      revisionId: sourceProposalRevisionId,
      projectId: seeded.projectId,
      departmentId: null,
      content: sourceContent,
    },
  });
  const sourceRevision = sourceCreated.value.revisions.find(
    (revision) => revision.id === sourceProposalRevisionId,
  );
  assert.ok(sourceRevision);
  await executeT26("fixture:t26:source-propose", {
    type: "improvement.proposal.propose",
    proposalId: sourceProposalId,
    proposalRevisionId: sourceRevision.id,
    expectedProposalRevisionHash: sourceRevision.hash,
  });
  const sourceDecisionConfirmation =
    "I confirm the exact disposable T26 source revision and frozen evidence.";
  await executeT26("fixture:t26:source-request-decision", {
    type: "improvement.proposal.request-decision",
    proposalId: sourceProposalId,
    proposalRevisionId: sourceRevision.id,
    expectedProposalRevisionHash: sourceRevision.hash,
    confirmation: sourceDecisionConfirmation,
  });
  const sourceApproved = await executeT26("fixture:t26:source-approve", {
    type: "improvement.proposal.decide",
    proposalId: sourceProposalId,
    proposalRevisionId: sourceRevision.id,
    expectedProposalRevisionHash: sourceRevision.hash,
    decision: "approved",
    confirmation: sourceDecisionConfirmation,
    reason: "The source Harness revision is exact, bounded, and disposable.",
    evidenceRefs: [sourceEvidence.id],
  });
  const sourceDecision = sourceApproved.value.revisions.find(
    (revision) => revision.id === sourceRevision.id,
  )?.decision;
  assert.ok(sourceDecision);
  const sourceOperationId = "improvement-application:t26:source";
  await executeT26("fixture:t26:source-apply", {
    type: "improvement.application.apply",
    application: {
      operationId: sourceOperationId,
      proposalId: sourceProposalId,
      proposalRevisionId: sourceRevision.id,
      expectedProposalRevisionHash: sourceRevision.hash,
      approvedDecisionId: sourceDecision.id,
      expectedApprovedDecisionHash: sourceDecision.hash,
      target: sourceContent.target,
      confirmation:
        "I confirm applying the exact disposable source Harness revision.",
      reason:
        "Establish the exact source revision required for restoring rollback.",
      evidenceRefs: [sourceEvidence.id, sourceDecision.id],
    },
  });
  const sourceApplication = await waitForT26Application(
    sourceOperationId,
    (application) => application.state === "applied",
  );
  const sourceTargetRevision = sourceApplication.receipts.find(
    (receipt) => receipt.phase === "apply" && receipt.targetRevision !== null,
  )?.targetRevision;
  assert.ok(sourceTargetRevision);

  await clickElement('[data-project-tab="improvements"]');
  await waitForElement("[data-project-improvements]");
  await waitForElementState(
    `[data-statistics-metric="${t26MetricId}"][data-statistics-observation-status="available"]`,
    (state) => state.text.endsWith("0"),
  );
  await clickElement("[data-statistics-inspect]");
  await waitForElementState(
    `[data-statistics-metric="${t26MetricId}"][data-statistics-observation-status="available"]`,
    (state) => state.text.endsWith("0"),
  );
  await clickElement("[data-statistics-freeze]");
  const beforeEvidenceId = await waitForElementAttribute(
    "[data-statistics-evidence]",
    "data-statistics-evidence",
    (value) => value !== sourceEvidence.id,
  );
  const beforeEvidence = await humanRuntimeClient.query({
    type: "statistics-evidence.inspect",
    evidenceSnapshotId: beforeEvidenceId,
  });
  const beforeMetric = beforeEvidence.observations.find(
    (observation) => observation.metricId === t26MetricId,
  );
  assert.equal(beforeMetric?.status, "available");
  assert.equal(beforeMetric?.measurement?.kind, "count");
  assert.equal(beforeMetric?.measurement?.value, 0);

  const proposalsBeforeRendererCreate = await humanRuntimeClient.query({
    type: "improvement-proposals.list",
    projectId: seeded.projectId,
  });
  await selectElementOption(
    '[data-improvement-proposal-field="metricId"]',
    t26MetricId,
  );
  const t26ProposalFields = {
    targetOwnerId: sourceOwnerId,
    governedHeadRevisionId: sourceTargetRevision.revisionId,
    governedHeadRevisionHash: sourceTargetRevision.revisionHash,
    principle: "Keep exact improvement evidence restart-safe.",
    constitution: "Apply only one approved disposable Harness revision.",
    rule: "Re-query authoritative Views after every invalidation.",
    rootCauseHypothesis:
      "Without governed receipts, renderer recovery can overstate an Improvement effect.",
    rolloutNotes:
      "Validate with an exact comparable frozen window, then restore the source revision.",
    rollbackRevisionId: sourceTargetRevision.revisionId,
    rollbackRevisionHash: sourceTargetRevision.revisionHash,
  };
  for (const [field, value] of Object.entries(t26ProposalFields)) {
    await typeElement(`[data-improvement-proposal-field="${field}"]`, value);
  }
  await waitForElementState(
    "[data-improvement-proposal-create]",
    (state) => state.disabled === false,
  );
  await clickElement("[data-improvement-proposal-create]");
  let changedProposal;
  const changedProposalDeadline = Date.now() + 20_000;
  while (Date.now() < changedProposalDeadline) {
    const proposals = await humanRuntimeClient.query({
      type: "improvement-proposals.list",
      projectId: seeded.projectId,
    });
    changedProposal = proposals.find(
      (proposal) =>
        !proposalsBeforeRendererCreate.some(
          (prior) => prior.id === proposal.id,
        ),
    );
    if (changedProposal) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(changedProposal);
  await waitForElementAttribute(
    `[data-improvement-proposal="${changedProposal.id}"]`,
    "data-improvement-proposal-state",
    (value) => value === "draft",
  );
  const changedRevision = changedProposal.revisions.find(
    (revision) => revision.id === changedProposal.currentRevisionId,
  );
  assert.ok(changedRevision);
  assert.equal(changedRevision.content.evidence.id, beforeEvidence.id);
  assert.equal(changedRevision.content.evidence.hash, beforeEvidence.hash);
  assert.deepEqual(
    changedRevision.content.target.governedHead,
    sourceTargetRevision,
  );

  const decisionConfirmation =
    "I confirm this exact T26 proposal revision, evidence, governed head, and rollback source.";
  await typeElement(
    "[data-improvement-decision-confirmation]",
    decisionConfirmation,
  );
  await clickElement(
    `[data-improvement-propose-proposal="${changedProposal.id}"]`,
  );
  changedProposal = await waitForT26Proposal(
    changedProposal.id,
    (proposal) => proposal.currentState === "proposed",
  );
  await clickElement(
    `[data-improvement-request-decision="${changedProposal.id}"]`,
  );
  changedProposal = await waitForT26Proposal(
    changedProposal.id,
    (proposal) => proposal.currentState === "awaiting-human",
  );
  const applicationsBeforeApproval = await humanRuntimeClient.query({
    type: "improvement-applications.list",
    projectId: seeded.projectId,
  });
  const sourceReceiptBeforeApproval = sourceApplication.receipts[0];
  await typeElement(
    "[data-improvement-decision-reason]",
    "The exact T26 Harness change is bounded, evidence-backed, and reversible.",
  );
  await clickElement(
    `[data-improvement-approve-proposal="${changedProposal.id}"]`,
  );
  changedProposal = await waitForT26Proposal(
    changedProposal.id,
    (proposal) => proposal.currentState === "approved",
  );
  const approvedRevision = changedProposal.revisions.find(
    (revision) => revision.id === changedProposal.currentRevisionId,
  );
  const approvedDecision = approvedRevision?.decision;
  assert.ok(approvedRevision);
  assert.ok(approvedDecision);
  const applicationsAfterApproval = await humanRuntimeClient.query({
    type: "improvement-applications.list",
    projectId: seeded.projectId,
  });
  assert.deepEqual(
    applicationsAfterApproval.map((application) => application.id).sort(),
    applicationsBeforeApproval.map((application) => application.id).sort(),
  );
  const sourceAfterApproval = applicationsAfterApproval.find(
    (application) => application.id === sourceOperationId,
  );
  assert.equal(
    canonicalJson(sourceAfterApproval?.receipts[0]),
    canonicalJson(sourceReceiptBeforeApproval),
  );

  const changedOperationId = "improvement-application:t26:changed";
  await typeElement(
    "#improvement-application-operation-id",
    changedOperationId,
  );
  await typeElement(
    "#improvement-application-confirmation",
    "I confirm applying the exact approved T26 Harness revision.",
  );
  await typeElement(
    "#improvement-application-reason",
    "Exercise the governed T26 apply, restart, validation, and rollback flow.",
  );
  await clickElement(
    `[data-improvement-apply-proposal="${changedProposal.id}"]`,
  );
  const unknownApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "unknown",
  );
  await waitForElementAttribute(
    `[data-improvement-application="${changedOperationId}"]`,
    "data-improvement-application-state",
    (value) => value === "unknown",
  );
  assert.equal(unknownApplication.receipts.length, 0);
  assert.equal(
    unknownApplication.observations.at(-1)?.outcome,
    "insufficient-evidence",
  );
  await clickElement(
    `[data-improvement-reconcile-application="${changedOperationId}"]`,
  );
  let changedApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "applied",
  );
  await waitForElementAttribute(
    `[data-improvement-application="${changedOperationId}"]`,
    "data-improvement-application-state",
    (value) => value === "applied",
  );
  assert.equal(
    changedApplication.reconciliations.some(
      (entry) =>
        entry.result === "unknown" &&
        entry.evidenceRefs.includes(
          "fixture:t26:apply-inspection:insufficient",
        ),
    ),
    true,
  );
  assert.equal(changedApplication.receipts.length, 1);
  const appliedReceipt = changedApplication.receipts.find(
    (receipt) => receipt.phase === "apply" && receipt.targetRevision !== null,
  );
  assert.ok(appliedReceipt?.targetRevision);
  const applicationsBeforeDuplicateGesture = await humanRuntimeClient.query({
    type: "improvement-applications.list",
    projectId: seeded.projectId,
  });
  await clickElement(
    `[data-improvement-apply-proposal="${changedProposal.id}"]`,
  );
  const duplicateApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "applied",
  );
  const applicationsAfterDuplicateGesture = await humanRuntimeClient.query({
    type: "improvement-applications.list",
    projectId: seeded.projectId,
  });
  assert.deepEqual(
    applicationsAfterDuplicateGesture
      .map((application) => application.id)
      .sort(),
    applicationsBeforeDuplicateGesture
      .map((application) => application.id)
      .sort(),
  );
  assert.equal(
    canonicalJson(duplicateApplication.receipts),
    canonicalJson(changedApplication.receipts),
  );

  const t26CursorBeforeRestart = reviewsCursorStates(
    await supervisor.audit({ limit: 1_000 }),
  ).at(-1);
  assert.ok(t26CursorBeforeRestart);
  const t26PidBeforeRestart = (await supervisor.health()).pid;
  await supervisor.stop();
  const t26RestartHealth = await supervisor.start(
    fixture.config.companyDirectory,
  );
  assert.notEqual(t26RestartHealth.pid, t26PidBeforeRestart);
  assert.equal(t26RestartHealth.schemaVersion, 52);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await window.reload();
    await waitForElement('[data-nav="projects"]');
    await clickElement('[data-nav="projects"]');
    try {
      await waitForElement(`[data-project-id="${seeded.projectId}"]`, 5_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await clickElement(`[data-project-id="${seeded.projectId}"]`);
  await waitForElement(`[data-runtime-project-id="${seeded.projectId}"]`);
  await clickElement('[data-project-tab="improvements"]');
  await waitForElementAttribute(
    `[data-improvement-application="${changedOperationId}"]`,
    "data-improvement-application-state",
    (value) => value === "applied",
  );
  const restartedApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "applied",
  );
  assert.equal(restartedApplication.id, changedApplication.id);
  assert.equal(
    canonicalJson(restartedApplication.receipts),
    canonicalJson(changedApplication.receipts),
  );
  let t26CursorAfterRestart;
  const t26CursorDeadline = Date.now() + 10_000;
  while (Date.now() < t26CursorDeadline) {
    t26CursorAfterRestart = reviewsCursorStates(
      await supervisor.audit({ limit: 1_000 }),
    ).at(-1);
    if (
      t26CursorAfterRestart &&
      t26CursorAfterRestart.subscriptionGeneration >
        t26CursorBeforeRestart.subscriptionGeneration
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(t26CursorAfterRestart);
  assert.ok(
    t26CursorAfterRestart.subscriptionGeneration >
      t26CursorBeforeRestart.subscriptionGeneration,
  );
  assert.ok(t26CursorAfterRestart.sequence >= t26CursorBeforeRestart.sequence);

  const beforeWindowDuration =
    Date.parse(beforeEvidence.query.window.endExclusive) -
    Date.parse(beforeEvidence.query.window.startInclusive);
  const appliedAt = restartedApplication.receipts.find(
    (receipt) => receipt.phase === "apply" && receipt.targetRevision !== null,
  )?.createdAt;
  assert.ok(appliedAt);
  const afterWindowStart = new Date(
    Math.max(
      Date.parse(beforeEvidence.query.window.endExclusive),
      Date.parse(appliedAt),
    ),
  ).toISOString();
  const afterWindow = {
    startInclusive: afterWindowStart,
    endExclusive: new Date(
      Date.parse(afterWindowStart) + beforeWindowDuration,
    ).toISOString(),
  };
  await typeElement(
    "[data-statistics-window-start]",
    afterWindow.startInclusive,
  );
  await typeElement("[data-statistics-window-end]", afterWindow.endExclusive);
  await clickElement("[data-statistics-inspect]");
  await waitForElementAttribute(
    "[data-statistics-view-window-start]",
    "data-statistics-view-window-start",
    (value) => value === afterWindow.startInclusive,
  );
  await waitForElementAttribute(
    "[data-statistics-view-window-end]",
    "data-statistics-view-window-end",
    (value) => value === afterWindow.endExclusive,
  );
  await typeElement(
    `[data-improvement-validation-reason="${changedOperationId}"]`,
    "The following exact window retains the same authoritative baseline count.",
  );
  await clickElement(
    `[data-improvement-validate-application="${changedOperationId}"]`,
  );
  changedApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "validated",
  );
  const validation = changedApplication.validations.at(-1);
  assert.equal(validation?.outcome, "unchanged");
  const afterEvidence = validation?.afterEvidence;
  assert.ok(afterEvidence);
  const afterMetric = afterEvidence.observations.find(
    (observation) => observation.metricId === t26MetricId,
  );
  assert.equal(afterMetric?.status, "available");
  assert.equal(afterMetric?.measurement?.kind, "count");
  assert.equal(afterMetric?.measurement?.value, 0);
  assert.deepEqual(afterEvidence.query.filters, beforeEvidence.query.filters);
  assert.deepEqual(afterEvidence.query.cohort, beforeEvidence.query.cohort);
  assert.deepEqual(
    afterEvidence.query.comparisonSet,
    beforeEvidence.query.comparisonSet,
  );
  assert.equal(
    afterEvidence.query.window.startInclusive,
    afterWindow.startInclusive,
  );
  assert.equal(
    afterEvidence.query.window.endExclusive,
    afterWindow.endExclusive,
  );
  await waitForElementAttribute(
    `[data-improvement-application="${changedOperationId}"]`,
    "data-improvement-application-state",
    (value) => value === "validated",
  );

  await typeElement(
    `[data-improvement-rollback-confirmation="${changedOperationId}"]`,
    "I confirm restoring the exact governed T26 source Harness revision.",
  );
  await typeElement(
    `[data-improvement-rollback-reason="${changedOperationId}"]`,
    "Complete the disposable T26 proof without changing active configuration.",
  );
  await clickElement(
    `[data-improvement-rollback-application="${changedOperationId}"]`,
  );
  changedApplication = await waitForT26Application(
    changedOperationId,
    (application) => application.state === "rolled-back",
  );
  const rollback = changedApplication.rollbacks.at(-1);
  const rollbackReceipt = changedApplication.receipts.find(
    (receipt) =>
      receipt.phase === "rollback" && receipt.targetRevision !== null,
  );
  assert.ok(rollback?.restoringRevision);
  assert.ok(rollbackReceipt?.targetRevision);
  assert.equal(
    rollback.sourceRevision.revisionId,
    sourceTargetRevision.revisionId,
  );
  assert.equal(
    rollback.restoringRevision.revisionHash,
    sourceTargetRevision.revisionHash,
  );
  assert.equal(
    changedApplication.receipts.some(
      (receipt) =>
        receipt.phase === "apply" &&
        receipt.targetRevision?.revisionId ===
          appliedReceipt.targetRevision.revisionId,
    ),
    true,
  );
  await waitForElementAttribute(
    `[data-improvement-application="${changedOperationId}"]`,
    "data-improvement-application-state",
    (value) => value === "rolled-back",
  );

  const t26InvariantsAfter = await captureT26Invariants();
  const t26InvariantProof = {
    runUnchanged:
      canonicalJson(t26InvariantsAfter.run.run) ===
      canonicalJson(t26InvariantsBefore.run.run),
    snapshotUnchanged:
      canonicalJson(t26InvariantsAfter.run.snapshot) ===
        canonicalJson(t26InvariantsBefore.run.snapshot) &&
      t26InvariantsAfter.run.run.snapshotRevisionId ===
        seeded.snapshotRevisionId,
    publishedConfigurationUnchanged:
      canonicalJson(t26InvariantsAfter.pipeline.published) ===
      canonicalJson(t26InvariantsBefore.pipeline.published),
    activeConfigurationUnchanged:
      canonicalJson(t26InvariantsAfter.skills) ===
      canonicalJson(t26InvariantsBefore.skills),
    repositoryFilesUnchanged:
      canonicalJson(t26InvariantsAfter.repositories) ===
      canonicalJson(t26InvariantsBefore.repositories),
  };
  assert.equal(Object.values(t26InvariantProof).every(Boolean), true);
  const t26Result = createT26ElectronTestResult({
    schemaVersion: 52,
    eventRegistryVersion: 20,
    statistics: {
      catalogVersion: beforeEvidence.query.catalogVersion,
      metricId: t26MetricId,
      beforeEvidenceId: beforeEvidence.id,
      beforeEvidenceHash: beforeEvidence.hash,
      beforeAsOfSequence: beforeEvidence.asOfSequence,
      beforeValue: beforeMetric.measurement.value,
      beforeCompleteness: beforeEvidence.completeness.status,
      afterEvidenceId: afterEvidence.id,
      afterEvidenceHash: afterEvidence.hash,
      afterAsOfSequence: afterEvidence.asOfSequence,
      afterValue: afterMetric.measurement.value,
      afterCompleteness: afterEvidence.completeness.status,
    },
    proposal: {
      proposalId: changedProposal.id,
      proposalRevisionId: approvedRevision.id,
      proposalRevisionHash: approvedRevision.hash,
      decisionId: approvedDecision.id,
      decisionHash: approvedDecision.hash,
      approvalCreatedTargetRevision: false,
    },
    application: {
      operationId: changedApplication.id,
      canonicalRequestHash: changedApplication.canonicalRequestHash,
      deterministicEffectId: changedApplication.deterministicEffectId,
      appliedReceiptId: appliedReceipt.id,
      appliedReceiptHash: appliedReceipt.hash,
      appliedRevisionId: appliedReceipt.targetRevision.revisionId,
      appliedRevisionHash: appliedReceipt.targetRevision.revisionHash,
      rollbackReceiptId: rollbackReceipt.id,
      rollbackReceiptHash: rollbackReceipt.hash,
      restoringRevisionId: rollback.restoringRevision.revisionId,
      restoringRevisionHash: rollback.restoringRevision.revisionHash,
      sourceRevisionId: sourceTargetRevision.revisionId,
      sourceRevisionHash: sourceTargetRevision.revisionHash,
      validationOutcome: changedApplication.validations.at(-1).outcome,
    },
    invariants: t26InvariantProof,
    resilience: {
      rendererReloaded: true,
      runtimeRestarted: t26RestartHealth.pid !== t26PidBeforeRestart,
      eventAckRecovered:
        t26CursorAfterRestart.subscriptionGeneration >
          t26CursorBeforeRestart.subscriptionGeneration &&
        t26CursorAfterRestart.sequence >= t26CursorBeforeRestart.sequence,
      duplicateReplayRevisionCountStable:
        canonicalJson(duplicateApplication.receipts) ===
          canonicalJson(restartedApplication.receipts) &&
        applicationsBeforeDuplicateGesture.length ===
          applicationsAfterDuplicateGesture.length,
      applicationIdentityStable:
        restartedApplication.id === changedApplication.id,
      receiptStable:
        canonicalJson(restartedApplication.receipts) ===
        canonicalJson(duplicateApplication.receipts),
      verifiedHumanReconciliation: changedApplication.reconciliations.some(
        (entry) =>
          entry.result === "unknown" &&
          entry.evidenceRefs.includes(
            "fixture:t26:apply-inspection:insufficient",
          ),
      ),
      noBlindResend:
        unknownApplication.receipts.length === 0 &&
        changedApplication.receipts.filter(
          (receipt) => receipt.phase === "apply",
        ).length === 1,
    },
    cleanup: {
      rootFingerprint: fixture.config.rootFingerprint,
      disposableResourcesOnly: fixture.config.cleanupTargets.every((target) =>
        target.path.startsWith(`${fixture.root}/`),
      ),
    },
  });

  const finalAudit = await supervisor.audit({
    runId: seeded.runId,
    limit: 1_000,
  });
  const finalEvents = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  const eventRegistryReplay = await humanRuntimeClient.query({
    type: "ag-ui.events",
    afterSequence: 0,
    limit: 1_000,
  });
  const eventRegistrySources = eventRegistryReplay.events.map(
    (event) => event.payload.source,
  );
  const t26FormalEventTypes = [
    "statistics.evidence.invalidated",
    "improvement.proposal.invalidated",
    "improvement.application.invalidated",
  ];
  const t26FormalEventTypeSet = new Set(t26FormalEventTypes);
  const t26FormalRegistryEvidence = eventRegistrySources
    .map((source) => ({
      eventId: source.eventId,
      type: finalEvents.find((event) => event.eventId === source.eventId)?.type,
      registryVersion: source.registryVersion,
    }))
    .filter((event) => t26FormalEventTypeSet.has(event.type));
  assert.deepEqual(
    [...new Set(t26FormalRegistryEvidence.map((event) => event.type))].sort(),
    [...t26FormalEventTypes].sort(),
  );
  assert.deepEqual(
    [
      ...new Set(
        t26FormalRegistryEvidence.map((event) => event.registryVersion),
      ),
    ],
    [20],
  );
  assert.equal(
    finalEvents.filter(
      (event) =>
        event.type === "delivery.candidate-input.frozen" &&
        event.payload?.deliveryCandidateInputId === candidate.id,
    ).length,
    1,
  );
  assert.equal(
    finalEvents.filter(
      (event) =>
        event.type === "delivery.candidate.created" &&
        event.payload?.deliveryCandidateId === deliveryCandidate.id,
    ).length,
    1,
  );
  for (const gateResult of [securityGateResult, operabilityGateResult]) {
    assert.equal(
      finalEvents.filter(
        (event) =>
          event.type === "quality-gate.result.recorded" &&
          event.payload?.candidateGateResultId === gateResult.id,
      ).length,
      1,
    );
  }
  assert.equal(
    finalEvents.filter(
      (event) =>
        event.type === "delivery.candidate-input.authorized" &&
        event.payload?.deliveryCandidateInputId === candidate.id,
    ).length,
    1,
  );
  assert.equal(
    finalEvents.filter(
      (event) =>
        event.type === "delivery.release.accepted" &&
        event.payload?.deliveryCandidateId === deliveryCandidate.id,
    ).length,
    1,
  );
  assert.ok(restartHealth);
  assert.equal(restartHealth.schemaVersion, 52);

  const recoveredInteraction = {
    view: await humanRuntimeClient.query({
      type: "interaction.inspect",
      sessionId: seeded.interactionSessionId,
    }),
  };
  const recoveredTurn = recoveredInteraction.view.turns.find(
    (turn) => turn.commandId === interactionCommandId,
  );
  const recoveredOutput = recoveredInteraction.view.messages.find(
    (message) => message.id === recoveredTurn?.outputMessageId,
  );
  const interactionStarted = events.find(
    (event) =>
      event.type === "interaction.turn.started" &&
      event.payload?.operationKey === recoveredTurn?.executionOperationKey,
  );
  assert.ok(interactionStarted);
  const cursorRecoveredEvents = await supervisor.events({
    afterSequence: interactionStarted.sequence - 1,
    limit: 1_000,
  });
  assert.equal(recovered.view.state, "passed");
  assert.equal(recovered.view.executions[0]?.state, "succeeded");
  assert.ok(recovered.view.executions[0]?.receiptHash);
  assert.equal(recovered.view.assertions[0]?.uiStatus, "passed");
  assert.equal(recovered.view.assertions[0]?.runtimeStatus, "passed");
  assert.ok(recovered.view.assertions[0]?.correlation.viewSyncTokenHash);
  assert.equal(recovered.view.evidence.length, 3);
  assert.equal(
    pipeline.nodes.find((node) => node.pipelineNodeId === "test")?.status,
    "succeeded",
  );
  assert.equal(
    audit.some((record) => record.action === "node.test-complete"),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "test.run.completed"),
    true,
  );
  assert.equal(downstream.view.testRunId, route.testRunId);
  assert.equal(recoveredTurn?.status, "completed");
  assert.ok(recoveredTurn?.terminalExecutionFactId);
  assert.ok(recoveredTurn?.providerExecutionRef);
  assert.equal(recoveredOutput?.content, interactionResponse);
  assert.equal(
    interactionAudit.some(
      (record) =>
        record.action === "interaction.turn.accept" &&
        record.entityId === recoveredTurn?.id,
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "interaction.turn.completed" &&
        event.payload?.operationKey === recoveredTurn?.executionOperationKey,
    ),
    true,
  );
  assert.equal(
    cursorRecoveredEvents.some(
      (event) =>
        event.type === "interaction.turn.completed" &&
        event.payload?.operationKey === recoveredTurn?.executionOperationKey,
    ),
    true,
  );
  assert.equal(health.schemaVersion, 52);
  assert.ok(eventRegistrySources.length > 0);
  const eventTypeById = new Map(
    finalEvents.map((event) => [event.eventId, event.type]),
  );
  const t22FormalEventTypes = [
    "product.proposal.revised",
    "product.proposal.awaiting-confirmation",
    "product.baseline.confirmed",
    "department-run.formalized",
    "product-gate.passed",
    "snapshot.promoted",
    "technical-gate.passed",
    "technical-baseline.accepted",
    "work-package.self-check",
    "code-review.authority.created",
    "integration.generation.completed",
    "test.run.completed",
    "delivery.candidate-input.frozen",
    "quality-gate.result.recorded",
    "delivery.candidate-input.authorized",
    "delivery.candidate.created",
    "run.waiting-human-release",
    "delivery.release.accepted",
    "delivery.release-operation.invalidated",
  ];
  const t22FormalEventTypeSet = new Set(t22FormalEventTypes);
  const t22FormalRegistryEvidence = eventRegistrySources
    .map((source) => ({
      eventId: source.eventId,
      type: eventTypeById.get(source.eventId),
      registryVersion: source.registryVersion,
    }))
    .filter((event) => t22FormalEventTypeSet.has(event.type));
  assert.deepEqual(
    [...new Set(t22FormalRegistryEvidence.map((event) => event.type))].sort(),
    [...t22FormalEventTypes].sort(),
  );
  assert.deepEqual(
    [
      ...new Set(
        t22FormalRegistryEvidence.map((event) => event.registryVersion),
      ),
    ],
    [20],
  );
  const scopedFormalEventTypes = new Set([
    ...t22FormalEventTypes,
    ...t26FormalEventTypes,
  ]);
  const otherSetupEvents = eventRegistrySources
    .map((source) => ({
      eventId: source.eventId,
      type: eventTypeById.get(source.eventId),
      registryVersion: source.registryVersion,
    }))
    .filter((event) => !scopedFormalEventTypes.has(event.type));
  process.stdout.write(
    `${JSON.stringify({
      ...t26Result,
      prerequisiteFixture: {
        scope: "disposable T21 Product-to-Candidate and T22 Release setup",
        releaseDecisionAcceptance: true,
        destinationRefUpdate: true,
        export: true,
      },
      product: {
        projectId: seeded.projectId,
        proposalRevisionId: productDiscovery.view.proposal?.currentRevision.id,
        proposalHash: productDiscovery.view.proposal?.currentRevision.hash,
        baselineId: productBaseline.id,
        baselineHash: productBaseline.hash,
        runId: productBaseline.runId,
        snapshotRevisionId: productBaseline.snapshotRevisionId,
        snapshotRevision: 1,
      },
      testRunId: recovered.view.id,
      passAuthorityHash: recovered.view.passAuthorityHash,
      integrationAuthority: {
        generationId: seeded.integrationAuthority.id,
        manifestHash: seeded.integrationAuthority.manifestHash,
        passAuthorityHash: seeded.integrationAuthority.passAuthorityHash,
      },
      runtimePid: (await supervisor.health()).pid,
      schemaVersion: (await supervisor.health()).schemaVersion,
      eventRegistryVersion: 20,
      eventRegistryEvidence: {
        scope: "exact T26 Statistics and Improvement invalidation events",
        typedControlFramesExcluded: true,
        formalEvents: t26FormalRegistryEvidence,
        prerequisiteFormalEvents: t22FormalRegistryEvidence,
        otherSetupEventCount: otherSetupEvents.length,
        otherSetupRegistryVersions: [
          ...new Set(otherSetupEvents.map((event) => event.registryVersion)),
        ],
        otherSetupEventTypes: [
          ...new Set(otherSetupEvents.map((event) => event.type)),
        ].sort(),
      },
      auditRecords: finalAudit.length,
      runtimeEvents: finalEvents.length,
      testCorrelation: {
        commandId: recovered.view.assertions[0]?.correlation.commandId,
        runtimeEventType:
          recovered.view.assertions[0]?.correlation.runtimeEventType,
        queryViewHash: recovered.view.assertions[0]?.correlation.queryViewHash,
        viewSyncTokenHash:
          recovered.view.assertions[0]?.correlation.viewSyncTokenHash,
      },
      candidateInput: {
        id: candidate.id,
        manifestHash: candidate.manifestHash,
        riskTier: candidate.manifest.risk.tier,
        criticalEscalationId: finalQualityView.view.criticalEscalation?.id,
      },
      gates: {
        security: {
          id: securityGateResult.id,
          result: securityGateResult.result,
          resultHash: securityGateResult.resultHash,
        },
        operability: {
          id: operabilityGateResult.id,
          result: operabilityGateResult.result,
          resultHash: operabilityGateResult.resultHash,
        },
        authorityId: finalQualityView.view.authority?.id,
        authorityHash: finalQualityView.view.authority?.authorityHash,
      },
      candidateRenderer: {
        awaitingCriticalEscalation:
          awaitingCriticalEscalationObservation.authorizeCriticalVisible,
        authorizedCriticalEscalation:
          authorizedCriticalEscalationObservation.criticalEscalationId,
      },
      candidate: {
        id: deliveryCandidate.id,
        manifestHash: deliveryCandidate.manifestHash,
        projection: "accepted",
        decisionId: acceptedDeliveryObservation.decisionId,
        rendererProjection: acceptedDeliveryObservation.projection,
      },
      release: {
        authorityId: acceptedAuthority.id,
        authorityHash: acceptedAuthority.authorityHash,
        merge: {
          operationId: mergeOperation.id,
          aggregateState: mergeOperation.aggregateState,
          counts: mergeOperation.counts,
          succeeded: {
            repositoryReference: mergeDestinations[0]?.repositoryReference,
            targetBranch: mergeDestinations[0]?.targetBranch,
            resultingTargetTip: succeededMerge?.receipt?.resultingTargetTip,
          },
          destinationConflict: {
            repositoryReference: driftDestination.repositoryReference,
            targetBranch: driftDestination.targetBranch,
            targetTip: git(
              driftDestination.directory,
              "rev-parse",
              `${driftDestination.targetRef}^{commit}`,
            ),
            state: conflictedMerge?.state,
          },
        },
        export: {
          operationId: exportOperation.id,
          destinationDigest:
            exportOperation.items[0]?.receipt?.destinationDigest,
          partialOperationId: partialExportOperation.id,
          partialCounts: partialExportOperation.counts,
        },
        reconciliation: {
          operationId: reconciledReleaseOperation.id,
          before: unknownReleaseOperation.aggregateState,
          after: reconciledReleaseOperation.aggregateState,
          restartPid: releaseReconcileHealth.pid,
          rendererReloaded: reloadedReleaseObservation.operations.some(
            (operation) => operation.id === reconciledReleaseOperation.id,
          ),
        },
      },
      lineage: lineageReport,
      duplicateReplay: duplicateReplayEvidence,
      resilience: {
        rendererReload: {
          candidateQualitySync: reloadedCandidateObservation.sync,
          deliveryCandidateSync: reloadedDeliveryObservation.sync,
          candidateInputId: reloadedCandidateObservation.candidateInputId,
          candidateId: reloadedDeliveryObservation.candidateId,
          candidateManifestHash: reloadedDeliveryObservation.manifestHash,
          projection: reloadedDeliveryObservation.projection,
          before: cursorBeforeRendererReload,
          after: cursorAfterRendererReload,
          runtimeEventCount: {
            before: eventsBeforeRendererReload.length,
            after: eventsAfterRendererReload.length,
          },
        },
        runtimeRestartStage: "test-before-cleanup",
        runtimeRestartTestRunState: restartTestRunState,
        runtimeRestartElectronReceiptHash: restartElectronReceiptHash,
        runtimeRestartPid: restartHealth.pid,
        candidateCrossRuntimeRestart: true,
        candidateRestart: candidateRestartEvidence,
        duplicateCommandCountStable:
          canonicalJson(authorityCountsBeforeReplay) ===
          canonicalJson(authorityCountsAfterReplay),
        duplicateCandidateInputFacts: finalEvents.filter(
          (event) =>
            event.type === "delivery.candidate-input.frozen" &&
            event.payload?.deliveryCandidateInputId === candidate.id,
        ).length,
        duplicateCandidateFacts: finalEvents.filter(
          (event) =>
            event.type === "delivery.candidate.created" &&
            event.payload?.deliveryCandidateId === deliveryCandidate.id,
        ).length,
        duplicateAck: duplicateAckEvidence,
        cursorRecoveredInteraction: true,
      },
      cleanup: {
        executionResourcesRemoved: cleanupMaterialized,
        evidenceContentHash: cleanupEvidence.contentHash,
        rootFingerprint: fixture.config.rootFingerprint,
      },
      runStatus: waitingPipeline.run.status,
    })}\n`,
  );
};

const cleanup = async () => {
  window?.webContents.stop();
  runtimeIpc?.revokeWindow();
  if (window) {
    app.once("window-all-closed", (event) => event.preventDefault());
    window.destroy();
  }
  await supervisor?.stop().catch(() => undefined);
  await shell?.close().catch(() => undefined);
  fixture.cleanup();
  assert.equal(existsSync(fixture.root), false);
  rmSync(scriptRoot, { recursive: true, force: true });
  assert.equal(existsSync(scriptRoot), false);
};

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    if (process.env.SANDCASTLE_ELECTRON_TEST_FORCE_FAILURE === "1") {
      throw new Error("Electron test fixture forced failure.");
    }
    await run();
  } catch (error) {
    process.exitCode = 1;
    exitCode = 1;
    process.stderr.write(
      `[electron-test-fixture] ${String(error?.stack ?? error)}\n`,
    );
  } finally {
    await cleanup();
    process.exitCode = exitCode;
    applyElectronTestFixtureExitCode(app, exitCode);
  }
});
