import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import { createCompanyRuntimeSupervisor } from "../dist-electron/main/companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "../dist-electron/main/runtimeIpc.js";
import { startShellServer } from "../dist-electron/server/shellServer.js";
import { EnvelopeCommandSchema } from "../dist-electron/runtime/interface.js";
import {
  applyElectronTestFixtureExitCode,
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
});

let supervisor;
let shell;
let window;
let runtimeIpc;
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

const clickFixtureButton = async () => {
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
      selector: "#run-test",
    });
    assert.notEqual(target.nodeId, 0, "Electron fixture button was not found.");
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
      expression: `JSON.stringify((()=>{const panel=document.querySelector("[data-candidate-quality-gates]");return panel?{candidateInputId:panel.getAttribute("data-candidate-input"),authorityId:panel.getAttribute("data-candidate-authority"),sync:panel.getAttribute("data-candidate-sync"),passGateCount:panel.querySelectorAll('[data-quality-gate-result="PASS"]').length,text:panel.textContent}:null})())`,
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
    { id: "sandbox-boundary", present: false, evidenceRefs: [] },
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
  const seeded = setupReceipt.seeded;
  assert.ok(seeded?.integrationAuthority?.passAuthorityHash);
  await supervisor.stop();

  shell = await startShellServer({
    rendererDist: join(desktopRoot, "dist"),
    port: 0,
  });
  runtimeIpc = registerRuntimeIpc(ipcMain, () => supervisor, {
    getWindow: () => window,
    allowedOrigins: [new URL(shell.url).origin],
    createMessageChannel: () => new MessageChannelMain(),
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
  await supervisor.start(fixture.config.companyDirectory);
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
  let terminalView;
  for (let gesture = 1; gesture <= 12; gesture += 1) {
    await clickFixtureButton();
    await waitForTitle("working");
    await waitForTitle(["ready", "pass"]);
    let view = await inspectTestRun(`gesture-${gesture}`);
    if (view.executions.some((entry) => entry.state === "reconciling")) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
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
  const qualityReceiptPath = join(
    fixture.config.evidenceDirectory,
    "runtime",
    "candidate-quality-gates.json",
  );
  for (
    let attempt = 0;
    attempt < 400 && !existsSync(qualityReceiptPath);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    existsSync(qualityReceiptPath),
    true,
    `Candidate Quality Gate setup receipt was not materialized; Runtime logs ${JSON.stringify(runtimeLogs)}.`,
  );
  const qualityReceipt = JSON.parse(readFileSync(qualityReceiptPath, "utf8"));
  assert.equal(statSync(qualityReceiptPath).mode & 0o777, 0o600);
  assert.equal(qualityReceipt.schemaVersion, 1);
  const candidateInspection = await query("fixture-candidate-input", {
    type: "delivery-candidate-input.inspect",
    candidateInputId: qualityReceipt.candidateInputId,
  });
  const candidate = candidateInspection.view;
  assert.equal(candidate.manifestHash, qualityReceipt.candidateInputHash);
  assert.equal(candidate.manifest.risk.tier, qualityReceipt.candidateRiskTier);
  assert.equal(
    candidate.manifest.tests[0]?.passAuthorityHash,
    downstream.view.passAuthorityHash,
  );
  const gateResults = {
    security: { id: qualityReceipt.securityGateResultId },
    operability: { id: qualityReceipt.operabilityGateResultId },
  };
  const execute = async (commandId, command) => {
    const result = await supervisor.executeEnvelope({
      schemaVersion: 1,
      commandId,
      actor: {
        type: "human",
        id: "electron-test-fixture",
        authenticatedBy: "local-session",
      },
      consumerId: "electron-test-fixture-driver",
      command,
    });
    assert.equal(
      result.status,
      "succeeded",
      result.status === "rejected"
        ? `${result.error.code}: ${result.error.message}`
        : undefined,
    );
    return result.value;
  };
  const beforeAuthority = await query(
    "fixture-quality-gates-before-authority",
    {
      type: "quality-gates.inspect",
      candidateInputId: candidate.id,
    },
  );
  assert.equal(beforeAuthority.view.authority, null);
  assert.equal(beforeAuthority.view.gateResults.length, 2);

  const candidateRoute = {
    ...route,
    restoreOnLoad: true,
    candidateInputId: candidate.id,
  };
  await window.loadURL(fixtureUrl(shell.url, candidateRoute));
  await waitForTitle("pass");
  const blockedCandidateObservation = await waitForCandidateObservation(
    (observation) =>
      observation.candidateInputId === candidate.id &&
      observation.authorityId === "blocked" &&
      observation.sync === "ready" &&
      observation.passGateCount === 2,
  );
  const authority = await execute("fixture-candidate-input-authorize", {
    type: "delivery.candidate-input.authorize",
    authorityId: "fixture-candidate-input-authority",
    candidateInputId: candidate.id,
    expectedCandidateInputHash: candidate.manifestHash,
    securityGateResultId: gateResults.security.id,
    operabilityGateResultId: gateResults.operability.id,
  });
  const eventRefreshedCandidateObservation = await waitForCandidateObservation(
    (observation) =>
      observation.authorityId === authority.id &&
      observation.sync === "ready" &&
      observation.passGateCount === 2,
  );
  await window.loadURL(fixtureUrl(shell.url, candidateRoute));
  await waitForTitle("pass");
  const reloadedCandidateObservation = await waitForCandidateObservation(
    (observation) =>
      observation.authorityId === authority.id &&
      observation.sync === "ready" &&
      observation.passGateCount === 2,
  );
  const finalQualityView = await query("fixture-quality-gates-final", {
    type: "quality-gates.inspect",
    candidateInputId: candidate.id,
  });
  assert.equal(
    finalQualityView.view.authority?.authorityHash,
    authority.authorityHash,
  );
  assert.equal(
    finalQualityView.view.gateResults.every((entry) => entry.result === "PASS"),
    true,
  );
  const finalAudit = await supervisor.audit({
    runId: seeded.runId,
    limit: 1_000,
  });
  const finalEvents = await supervisor.events({
    afterSequence: 0,
    limit: 1_000,
  });
  assert.equal(
    finalEvents.some(
      (event) =>
        event.type === "delivery.candidate-input.authorized" &&
        event.payload?.deliveryCandidateInputId === candidate.id,
    ),
    true,
  );
  const recoveredInteraction = await query("fixture-interaction-recovered", {
    type: "interaction.inspect",
    sessionId: seeded.interactionSessionId,
  });
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
  assert.equal(health.schemaVersion, 49);
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      testRunId: recovered.view.id,
      passAuthorityHash: recovered.view.passAuthorityHash,
      integrationGenerationId: seeded.integrationAuthority.id,
      runtimePid: (await supervisor.health()).pid,
      schemaVersion: health.schemaVersion,
      auditRecords: finalAudit.length,
      runtimeEvents: finalEvents.length,
      renderer: "dist",
      reloaded: true,
      deliveryCandidateInputId: candidate.id,
      deliveryCandidateInputHash: candidate.manifestHash,
      candidateRiskTier: candidate.manifest.risk.tier,
      securityGateResultId: gateResults.security.id,
      operabilityGateResultId: gateResults.operability.id,
      candidateAuthorityHash: authority.authorityHash,
      candidateRenderer: {
        beforeAuthority: blockedCandidateObservation.authorityId,
        eventRefreshed: eventRefreshedCandidateObservation.authorityId,
        reloaded: reloadedCandidateObservation.authorityId,
      },
      scope:
        "T18 Candidate/Gate Query View only; not T21 Product-to-Candidate E2E",
    })}\n`,
  );
};

const cleanup = async () => {
  runtimeIpc?.revokeWindow();
  window?.destroy();
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
    await run();
  } catch (error) {
    process.stderr.write(
      `[electron-test-fixture] ${String(error?.stack ?? error)}\n`,
    );
    exitCode = 1;
  } finally {
    await cleanup();
    applyElectronTestFixtureExitCode(process, exitCode);
  }
});
