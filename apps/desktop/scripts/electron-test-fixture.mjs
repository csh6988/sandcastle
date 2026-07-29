import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import { createCompanyRuntimeSupervisor } from "../dist-electron/main/companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "../dist-electron/main/runtimeIpc.js";
import { startShellServer } from "../dist-electron/server/shellServer.js";
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
  assert.equal(
    window.isFocused(),
    true,
    "Electron fixture window did not focus.",
  );
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
  workPackageVersions: [...seeded.workPackageCoverage].sort((left, right) =>
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
      ui: { kind: "button", expected: "Run Test" },
      runtime: { kind: "query", expected: "reconciling" },
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

const testScopeRisk = (() => {
  const revisionId = "electron-test-scope-risk-r1";
  const rules = [{ factorId: "electron-runtime", minimumTier: "high" }];
  const factors = [
    {
      id: "electron-runtime",
      present: true,
      evidenceRefs: ["test-case:fixture-case-1-r1"],
    },
  ];
  const evidenceRefs = ["test-case:fixture-case-1-r1"];
  const policyHash = hashValue({ schemaVersion: 1, revisionId, rules });
  return {
    schemaVersion: 1,
    policy: { revisionId, rules, hash: policyHash },
    factors,
    computedTier: "high",
    evidenceRefs,
    inputHash: hashValue({
      schemaVersion: 1,
      policyRevisionId: revisionId,
      policyHash,
      factors,
      evidenceRefs,
    }),
  };
})();

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
    "electron",
    "main-ipc",
    "preload",
    "query-view",
    "runtime-child",
    "sqlite",
  ],
  risk: testScopeRisk,
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
  await window.loadURL(
    fixtureUrl(shell.url, routeFor(seeded, placeholderOperations)),
  );
  await waitForTitle("idle");
  const screenshotBytes = window.webContents.capturePage
    ? (await window.webContents.capturePage()).toPNG()
    : Buffer.alloc(0);
  assert.ok(screenshotBytes.byteLength > 0);
  const screenshotLocator = normalizeTestEvidenceLocator(
    "screenshots/fixture-idle.png",
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
    logicalName: "fixture-idle-screenshot",
    locator: screenshotLocator,
    contentHash: sha256(screenshotBytes),
    byteSize: screenshotBytes.byteLength,
    redactionProfile: "fixture-redacted",
    retentionClass: "durable",
    metadata: { locator: screenshotLocator, renderer: "actual-app-bundle" },
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
  for (let gesture = 1; gesture <= 8; gesture += 1) {
    await clickFixtureButton();
    await waitForTitle(["ready", "pass"]);
    const view = await inspectTestRun(`gesture-${gesture}`);
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
    )}`,
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
  const audit = await supervisor.audit({ runId: seeded.runId, limit: 200 });
  const events = await supervisor.events({ afterSequence: 0, limit: 200 });
  const downstream = await query("fixture-test-pass-authority", {
    type: "test-pass-authority.inspect",
    testRunId: route.testRunId,
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
  assert.equal(health.schemaVersion, 47);
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      testRunId: recovered.view.id,
      passAuthorityHash: recovered.view.passAuthorityHash,
      integrationGenerationId: seeded.integrationAuthority.id,
      runtimePid: (await supervisor.health()).pid,
      schemaVersion: health.schemaVersion,
      auditRecords: audit.length,
      runtimeEvents: events.length,
      renderer: "dist",
      reloaded: true,
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
