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
import { openCompanyDatabase } from "../dist-electron/runtime/storage/sqlite.js";
import {
  createElectronTestFixture,
  loadElectronTestFixtureConfig,
  normalizeTestEvidenceLocator,
  verifyTestEvidenceFile,
} from "../dist-electron/runtime/testing/electronTestFixture.js";
import { createIntegrationAuthorityFixture } from "../dist-electron/runtime/testing/integrationAuthorityFixture.js";

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
  const expected = `Sandcastle T17 Fixture — ${suffix}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.getTitle() === expected) return;
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
    `Timed out waiting for renderer title ${expected}; found ${window.getTitle()}; status ${statusMarkup}; Runtime diagnostics ${JSON.stringify(supervisor?.diagnostics())}; Runtime logs ${JSON.stringify(runtimeLogs)}.`,
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

const registerEvidence = (database, seeded, input) => {
  const artifact = database.artifactRegistry.registerVersion({
    projectId: seeded.projectId,
    type: input.type,
    schemaVersion: "1",
    logicalName: input.logicalName,
    content: input.bytes,
    status: "produced",
    producer: {
      runId: seeded.runId,
      nodeRunId: seeded.testNodeRunId,
      nodeAttemptId: seeded.testNodeAttemptId,
      snapshotRevisionId: seeded.snapshotRevisionId,
      aiMemberId: seeded.testOwnerAiMemberId,
      positionId: seeded.testOwnerPositionId,
      sessionId: seeded.testSessionId,
    },
  });
  return {
    id: input.id,
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: "fixture-pair",
    kind: input.kind,
    mediaType: input.mediaType,
    contentHash: artifact.contentHash,
    byteSize: artifact.byteSize,
    artifactVersionId: artifact.id,
    redactionProfile: "fixture-redacted",
    retentionClass: "durable",
    locator: artifact.contentRef,
    metadata: input.metadata,
  };
};

const caseManifestFor = (seeded, operation) => ({
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
  uiActions: [{ id: "fixture-click", kind: "click", target: "#run-test" }],
  assertions: [
    {
      id: "fixture-pair",
      operationId: operation.id,
      ui: { kind: "button", expected: "Run Test" },
      runtime: { kind: "query", expected: "reconciling" },
    },
  ],
  fixture: {
    id: fixture.config.fixtureId,
    scriptHashes: Object.values(fixture.config.scriptHashes).sort(),
  },
  executionOperations: [operation],
  evidencePolicy: {
    retentionClass: "durable",
    redactionProfile: "fixture-redacted",
    requiredKinds: ["runtime", "screenshot"],
  },
  cleanup: { policy: "always", required: true },
});

const runInputFor = (seeded, caseRevisionHash, operation) => ({
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
  executionOperations: [operation],
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
});

const routeFor = (seeded, operation) => {
  const caseManifest = caseManifestFor(seeded, operation);
  const caseRevisionHash = hashValue({
    ...caseManifest,
    testCaseId: "fixture-case-1",
    revisionId: "fixture-case-1-r1",
    revision: 1,
    supersedesRevisionId: null,
  });
  const runInput = runInputFor(seeded, caseRevisionHash, operation);
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
  const seeded = await createIntegrationAuthorityFixture({
    companyDirectory: fixture.config.companyDirectory,
    companyDirectoryFingerprint: fixture.config.companyDirectoryFingerprint,
    fixtureId: fixture.config.fixtureId,
    repositoryDirectory: fixture.config.repositoryDirectory,
    worktreeDirectory: fixture.config.worktreeDirectory,
    fakeClock: fixture.config.fakeClock,
    repeatableIdSeed: fixture.config.repeatableIdSeed,
  });
  supervisor = createCompanyRuntimeSupervisor({
    runtimeEntry: join(
      desktopRoot,
      "dist-electron",
      "runtime",
      "testing",
      "electronTestFixtureEntry.js",
    ),
    environment: {
      SANDCASTLE_ELECTRON_TEST_FIXTURE_CONFIG: fixture.configPath,
      SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION: fixture.authorization,
      SANDCASTLE_ELECTRON_TEST_FIXTURE_PACKAGED: app.isPackaged ? "1" : "0",
    },
    onLog: (line) => runtimeLogs.push(line),
  });
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

  const placeholderOperation = {
    id: "fixture-electron-operation",
    kind: "electron",
    adapterId: "scripted-execution",
    input: { schemaVersion: 1, fixtureId: fixture.config.fixtureId },
  };
  placeholderOperation.inputHash = hashValue(placeholderOperation.input);
  await window.loadURL(
    fixtureUrl(shell.url, routeFor(seeded, placeholderOperation)),
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

  const evidenceDatabase = openCompanyDatabase(fixture.config.companyDirectory);
  let screenshotEvidence;
  let runtimeEvidence;
  try {
    screenshotEvidence = registerEvidence(evidenceDatabase, seeded, {
      id: "fixture-screenshot",
      kind: "screenshot",
      type: "test-screenshot",
      mediaType: "image/png",
      logicalName: "fixture-idle-screenshot",
      bytes: screenshotBytes,
      metadata: { locator: screenshotLocator, renderer: "actual-app-bundle" },
    });
    runtimeEvidence = registerEvidence(evidenceDatabase, seeded, {
      id: "fixture-runtime-payload",
      kind: "runtime",
      type: "test-runtime-payload",
      mediaType: "application/json",
      logicalName: "fixture-runtime-authority",
      bytes: runtimePayloadBytes,
      metadata: { locator: runtimeLocator, source: "authoritative-runtime" },
    });
  } finally {
    evidenceDatabase.close();
  }

  const marker = readFileSync(
    join(fixture.config.companyDirectory, ".sandcastle-test-company"),
    "utf8",
  );
  const rootFingerprint = sha256(`${fixture.root}\n${marker}`);
  const operationInput = {
    schemaVersion: 1,
    fixtureId: fixture.config.fixtureId,
    testCaseRevisionId: "fixture-case-1-r1",
    assertionId: "fixture-pair",
    correlationCommandId: "fixture-test-run-create",
    evidence: [screenshotEvidence, runtimeEvidence],
    cleanupEvidence: {
      id: "fixture-cleanup-receipt",
      testCaseRevisionId: "fixture-case-1-r1",
      assertionId: null,
      kind: "cleanup",
      mediaType: "application/json",
      contentHash: rootFingerprint,
      byteSize: 0,
      artifactVersionId: null,
      redactionProfile: "fixture-redacted",
      retentionClass: "durable",
      locator: null,
      metadata: { verified: true, rootFingerprint },
    },
  };
  const operation = {
    id: "fixture-electron-operation",
    kind: "electron",
    adapterId: "scripted-execution",
    input: operationInput,
    inputHash: hashValue(operationInput),
  };
  const route = routeFor(seeded, operation);
  fixture.bindTestRunManifestHash(hashValue(manifestFor(seeded, route)));

  const health = await supervisor.start(fixture.config.companyDirectory);
  await window.loadURL(fixtureUrl(shell.url, route));
  await waitForTitle("idle");
  await clickFixtureButton();
  await waitForTitle("ready");
  await clickFixtureButton();
  await waitForTitle("pass");

  await window.loadURL(
    fixtureUrl(shell.url, { ...route, restoreOnLoad: true }),
  );
  await waitForTitle("pass");

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
  assert.throws(
    () =>
      loadElectronTestFixtureConfig({
        configPath: fixture.configPath,
        authorization: fixture.authorization,
        packaged: false,
        entrypoint: "electron-test-fixture",
      }),
    (error) => error?.code === "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
  );

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
    app.exit(exitCode);
  }
});
