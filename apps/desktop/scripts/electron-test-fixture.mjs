import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import { DatabaseSync } from "node:sqlite";
import { createCompanyRuntimeSupervisor } from "../dist-electron/main/companyRuntimeSupervisor.js";
import { registerRuntimeIpc } from "../dist-electron/main/runtimeIpc.js";
import { openCompanyDatabase } from "../dist-electron/runtime/storage/sqlite.js";
import { createScriptedExecutionAdapter } from "../dist-electron/runtime/adapters/scriptedExecutionAdapter.js";
import {
  createElectronTestFixture,
  deriveElectronTestFixtureRuntimeToken,
  normalizeTestEvidenceLocator,
} from "../dist-electron/runtime/testing/electronTestFixture.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
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
let window;
let runtimeIpc;
app.commandLine.appendSwitch("disable-gpu");

const seedAuthority = async () => {
  const database = openCompanyDatabase(fixture.config.companyDirectory, {
    executionAdapter: createScriptedExecutionAdapter(),
    clock: () => new Date(fixture.config.fakeClock),
  });
  const project = database.catalog.createProject({
    name: "Electron Test Fixture",
    goal: "Verify a scoped versioned Test Run through the real desktop boundary.",
  });
  const department = database.catalog.createDepartment({ name: "Quality" });
  const position = database.catalog.createPosition({
    departmentId: department.id,
    name: "Test engineer",
    responsibility: "Own independent UI and Runtime assertions.",
    aiMemberDisplayName: "Fixture Tester",
    aiMemberProfile: "Independent deterministic Test engineer.",
    aiMemberResponsibilityMetadata: { scope: "test" },
  }).positions[0];
  assert.ok(position);
  const profile = database.catalog.saveExecutionProfile({
    departmentId: department.id,
    expectedRevision: 0,
    name: "Fixture scripted execution",
    providerRef: "scripted-execution",
    model: "fixture-v1",
    sandboxRef: "no-sandbox",
    branchStrategy: "head",
    timeoutSeconds: 30,
    maxIterations: 1,
    maxTokens: null,
    retryMaxAttempts: 0,
    permissionPolicy: "deny",
    secretReferenceIds: [],
  }).executionProfiles[0];
  assert.ok(profile);
  database.catalog.updateDepartment({
    departmentId: department.id,
    expectedRevision: 0,
    name: department.name,
    description: "Scoped Electron Test fixture.",
    inputArtifactContracts: [],
    outputArtifactContracts: [],
    defaultExecutionProfileId: profile.id,
  });
  const draft = database.pipelineConfiguration.saveDraft({
    departmentId: department.id,
    expectedRevision: 0,
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          handlerKindId: "run-start@1",
        },
        {
          id: "test",
          type: "ai-task",
          name: "Test",
          positionId: position.id,
          handlerKindId: "test@1",
        },
        {
          id: "complete",
          type: "complete",
          name: "Complete",
          handlerKindId: "run-complete@1",
        },
      ],
      edges: [
        { from: "start", to: "test" },
        { from: "test", to: "complete" },
      ],
    },
  });
  database.pipelineConfiguration.publish({
    departmentId: department.id,
    expectedRevision: draft.draft.revision,
  });
  const started = database.pipelineRuntime.startRun({
    projectId: project.id,
    departmentId: department.id,
  });
  const running = await database.pipelineRuntime.executeReady({
    runId: started.run.id,
    expectedRevision: started.run.revision,
  });
  const testNode = running.nodes.find((node) => node.pipelineNodeId === "test");
  const testAttempt = testNode?.attempts.at(-1);
  const frozenProfile = running.snapshot.payload.executionProfiles.find(
    (entry) => entry.id === profile.id,
  );
  assert.equal(testNode?.status, "running");
  assert.ok(testAttempt);
  assert.ok(frozenProfile);
  const session = database.interaction.createSession({
    projectId: project.id,
    mode: "run-collaboration",
    runId: running.run.id,
    nodeRunId: testNode.id,
  });
  database.interaction.addParticipant({
    sessionId: session.id,
    participantType: "ai-member",
    participantRef: position.aiMember.id,
    role: "test-engineer",
  });

  const generationId = "fixture-generation-1";
  const repositoryReference = "fixture/repository";
  const integratedCommit = "2".repeat(40);
  const aggregateInput = {
    fixtureId: fixture.config.fixtureId,
    scope: "aggregate",
  };
  const aggregateInputHash = sha256(canonicalJson(aggregateInput));
  const generationManifest = {
    schemaVersion: 1,
    generationId,
    generation: 1,
    projectId: project.id,
    runId: running.run.id,
    snapshotRevisionId: running.snapshot.id,
    nodeRunId: testNode.id,
    coverageId: "fixture-coverage-1",
    coverageNodeRunId: testNode.id,
    coverageNodeAttemptId: testAttempt.id,
    coverageHash: "a".repeat(64),
    repositories: [
      {
        repositoryReference,
        baseCommit: "1".repeat(40),
        integrationBranch: `integration/${running.run.id}/g1`,
      },
    ],
    packages: [],
    dependencyOrder: [],
    contractVersions: [],
    integrationConditions: [],
    requiredValidations: [],
  };
  const generationManifestHash = sha256(canonicalJson(generationManifest));
  const aggregateEvidence = ["artifact-version:fixture-integration-evidence"];
  const passAuthorityHash = sha256(
    canonicalJson({
      schemaVersion: 1,
      integrationGenerationId: generationId,
      integrationManifestHash: generationManifestHash,
      repositoryCommits: [
        { repositoryId: repositoryReference, commit: integratedCommit },
      ],
      aggregateQualityGateResultId: "fixture-aggregate-gate-1",
      aggregateManifestHash: aggregateInputHash,
      evidence: aggregateEvidence,
    }),
  );
  const raw = new DatabaseSync(database.path);
  raw.exec("PRAGMA foreign_keys = OFF");
  const now = fixture.config.fakeClock;
  raw
    .prepare(
      `INSERT INTO integration_generations(
    id, project_id, run_id, snapshot_revision_id, node_run_id, generation,
    coverage_id, coverage_node_run_id, coverage_node_attempt_id, coverage_hash,
    manifest_json, manifest_hash, state, pass_authority_hash, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?)`,
    )
    .run(
      generationId,
      project.id,
      running.run.id,
      running.snapshot.id,
      testNode.id,
      generationManifest.coverageId,
      testNode.id,
      testAttempt.id,
      generationManifest.coverageHash,
      canonicalJson(generationManifest),
      generationManifestHash,
      passAuthorityHash,
      now,
      now,
    );
  raw
    .prepare(
      `INSERT INTO integration_repository_results(
    id, generation_id, repository_reference, base_commit, integration_branch,
    state, expected_tip, integrated_commit, validation_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, '{}', ?, ?)`,
    )
    .run(
      "fixture-repository-result-1",
      generationId,
      repositoryReference,
      "1".repeat(40),
      generationManifest.repositories[0].integrationBranch,
      "1".repeat(40),
      integratedCommit,
      now,
      now,
    );
  raw
    .prepare(
      `INSERT INTO integration_aggregate_reviews(
    id, generation_id, topic_id, quality_gate_result_id, input_json, input_hash,
    result, evidence_json, pass_authority_hash, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'PASS', ?, ?, ?)`,
    )
    .run(
      "fixture-aggregate-review-1",
      generationId,
      "fixture-topic-1",
      "fixture-aggregate-gate-1",
      canonicalJson(aggregateInput),
      aggregateInputHash,
      canonicalJson(aggregateEvidence),
      passAuthorityHash,
      now,
    );
  raw.close();

  const caseManifestInput = {
    schemaVersion: 1,
    ownerPositionId: position.id,
    requirementIds: [
      "acceptance-19",
      "acceptance-20",
      "acceptance-21",
      "acceptance-22",
    ],
    workPackageVersions: [],
    preconditions: ["exact PASS Integration Generation is available"],
    uiActions: [{ id: "fixture-click", kind: "click", target: "#run-test" }],
    assertions: [
      {
        id: "fixture-pair",
        ui: { kind: "text", expected: "Test ready" },
        runtime: { kind: "query", expected: "scheduled" },
      },
    ],
    fixture: {
      id: fixture.config.fixtureId,
      scriptHashes: Object.values(fixture.config.scriptHashes),
    },
    evidencePolicy: {
      retentionClass: "durable",
      redactionProfile: "fixture-redacted",
      requiredKinds: ["ui", "runtime", "screenshot"],
    },
    cleanup: { policy: "always", required: true },
  };
  const caseRevision = database.testRuns.registerCaseRevision({
    testCaseId: "fixture-case-1",
    revisionId: "fixture-case-1-r1",
    projectId: project.id,
    manifest: caseManifestInput,
  });
  const runInput = {
    testRunId: `test:${running.run.id}:${testNode.id}`,
    requestId: "fixture-test-run-request-1",
    projectId: project.id,
    runId: running.run.id,
    snapshotRevisionId: running.snapshot.id,
    nodeRunId: testNode.id,
    nodeAttemptId: testAttempt.id,
    sessionId: session.id,
    testCaseRevisions: [
      { id: caseRevision.id, hash: caseRevision.manifestHash },
    ],
    integrationAuthority: {
      generationId,
      manifestHash: generationManifestHash,
      passAuthorityHash,
      repositoryCommits: [{ repositoryReference, commit: integratedCommit }],
    },
    build: {
      artifactVersionId: "artifact-version:fixture-build",
      digest: "b".repeat(64),
    },
    executionProfile: {
      id: profile.id,
      hash: sha256(canonicalJson(frozenProfile)),
    },
    companyDirectoryFingerprint: fixture.config.companyDirectoryFingerprint,
    fixture: {
      id: fixture.config.fixtureId,
      scriptHashes: Object.values(fixture.config.scriptHashes),
    },
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
  };
  const testCaseRevisions = [...runInput.testCaseRevisions].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const manifest = {
    ...runInput,
    schemaVersion: 1,
    testCaseRevisions,
    integrationAuthority: {
      ...runInput.integrationAuthority,
      repositoryCommits: [
        ...runInput.integrationAuthority.repositoryCommits,
      ].sort((a, b) =>
        a.repositoryReference.localeCompare(b.repositoryReference),
      ),
    },
    fixture: {
      ...runInput.fixture,
      scriptHashes: [...new Set(runInput.fixture.scriptHashes)].sort(),
    },
    capabilities: [...new Set(runInput.capabilities)].sort(),
    coverageHash: sha256(canonicalJson(testCaseRevisions)),
    integrationCoverage: {
      coverageId: generationManifest.coverageId,
      coverageNodeRunId: generationManifest.coverageNodeRunId,
      coverageNodeAttemptId: generationManifest.coverageNodeAttemptId,
      coverageHash: generationManifest.coverageHash,
      packageAuthorities: [],
      aggregateReviewId: "fixture-aggregate-review-1",
      aggregateGateResultId: "fixture-aggregate-gate-1",
      aggregateInputHash,
      evidenceRefs: aggregateEvidence,
    },
  };
  fixture.bindTestRunManifestHash(sha256(canonicalJson(manifest)));
  database.close();
  return {
    project,
    running,
    testNode,
    testAttempt,
    caseRevision,
    caseManifestInput,
    runInput,
  };
};

const clickButton = async () => {
  const bounds = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('#run-test').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
};

const waitFor = async (expression, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript(expression, true);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
};

const run = async () => {
  const seeded = await seedAuthority();
  fixture.consumeIpcToken(fixture.config.ipcToken);
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
      SANDCASTLE_ELECTRON_TEST_FIXTURE_AUTHORIZATION:
        deriveElectronTestFixtureRuntimeToken(fixture.config),
      SANDCASTLE_ELECTRON_TEST_FIXTURE_PACKAGED: app.isPackaged ? "1" : "0",
    },
  });
  runtimeIpc = registerRuntimeIpc(ipcMain, () => supervisor, {
    getWindow: () => window,
    allowedOrigins: ["null"],
    createMessageChannel: () => new MessageChannelMain(),
  });
  const health = await supervisor.start(fixture.config.companyDirectory);
  window = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, "dist-electron", "preload", "index.cjs"),
      sandbox: true,
    },
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><button id="run-test">Run Test</button><output id="status">Idle</output>`)}`,
  );
  await window.webContents.executeJavaScript(
    `(() => {
    const runInput = ${JSON.stringify(seeded.runInput)};
    const caseInput = ${JSON.stringify({
      testCaseId: "fixture-case-1",
      revisionId: "fixture-case-1-r1",
      projectId: seeded.project.id,
      manifest: seeded.caseManifestInput,
    })};
    let phase = 0;
    const must = (result) => {
      if (result.status !== 'succeeded') throw new Error(result.error.code + ': ' + result.error.message);
      return result.value;
    };
    document.querySelector('#run-test').addEventListener('click', async () => {
      try {
        if (phase === 0) {
          must(await window.sandcastle.execute({ commandId: 'fixture-case-register', command: { type: 'test.case-revision.register', ...caseInput } }));
          must(await window.sandcastle.execute({ commandId: 'fixture-test-run-create', command: { type: 'test.run.create', input: runInput } }));
          const query = await window.sandcastle.query({ type: 'test-runs.inspect', testRunId: runInput.testRunId });
          if (query.view.state !== 'scheduled') throw new Error('Test Run was not scheduled.');
          document.querySelector('#status').textContent = 'Test ready';
          document.querySelector('#run-test').textContent = 'Complete Test Run';
          window.__fixturePhase = 'ready';
          phase = 1;
          return;
        }
        const query = await window.sandcastle.query({ type: 'test-runs.inspect', testRunId: runInput.testRunId });
        const uiPassed = document.querySelector('#status').textContent === 'Test ready';
        const runtimePassed = query.view.state === 'scheduled' && query.view.manifest.runId === runInput.runId;
        must(await window.sandcastle.execute({ commandId: 'fixture-screenshot-evidence', command: {
          type: 'test.evidence.record', id: 'fixture-screenshot', testRunId: runInput.testRunId,
          testCaseRevisionId: 'fixture-case-1-r1', assertionId: 'fixture-pair', kind: 'screenshot', mediaType: 'image/png',
          contentHash: window.__fixtureScreenshot.hash, byteSize: window.__fixtureScreenshot.byteSize,
          artifactVersionId: 'artifact-version:fixture-ui', redactionProfile: 'fixture-redacted', retentionClass: 'durable',
          locator: window.__fixtureScreenshot.locator, metadata: { commandId: 'fixture-test-run-create', renderer: true }
        } }));
        must(await window.sandcastle.execute({ commandId: 'fixture-runtime-evidence', command: {
          type: 'test.evidence.record', id: 'fixture-runtime-payload', testRunId: runInput.testRunId,
          testCaseRevisionId: 'fixture-case-1-r1', assertionId: 'fixture-pair', kind: 'runtime', mediaType: 'application/json',
          contentHash: '${"c".repeat(64)}', byteSize: 64, artifactVersionId: 'artifact-version:fixture-runtime',
          redactionProfile: 'fixture-redacted', retentionClass: 'durable', locator: 'payload/runtime-query.json',
          metadata: { asOfSequence: query.asOfSequence, viewHash: query.view.viewHash }
        } }));
        const correlated = await window.sandcastle.query({ type: 'test-runs.inspect', testRunId: runInput.testRunId });
        must(await window.sandcastle.execute({ commandId: 'fixture-paired-assertion', command: {
          type: 'test.assertion.record', testRunId: runInput.testRunId, testCaseRevisionId: 'fixture-case-1-r1', assertionId: 'fixture-pair',
          uiStatus: uiPassed ? 'passed' : 'failed', runtimeStatus: runtimePassed ? 'passed' : 'failed', correlation: {
            commandId: 'fixture-test-run-create', eventSequence: correlated.asOfSequence, queryAsOfSequence: correlated.asOfSequence,
            queryViewHash: correlated.view.viewHash, snapshotRevisionId: runInput.snapshotRevisionId, runId: runInput.runId,
            nodeRunId: runInput.nodeRunId, nodeAttemptId: runInput.nodeAttemptId, sessionId: runInput.sessionId,
            artifactVersionIds: ['artifact-version:fixture-ui', 'artifact-version:fixture-runtime']
          }
        } }));
        const passed = must(await window.sandcastle.execute({ commandId: 'fixture-test-run-complete', command: { type: 'test.run.complete', testRunId: runInput.testRunId } }));
        document.querySelector('#status').textContent = passed.state === 'passed' ? 'PASS' : passed.state;
        window.__fixtureResult = passed;
        window.__fixturePhase = 'complete';
      } catch (error) {
        window.__fixtureError = String(error && error.stack ? error.stack : error);
      }
    });
  })()`,
    true,
  );
  await clickButton();
  await waitFor("window.__fixturePhase === 'ready' || window.__fixtureError");
  const firstPhaseError = await window.webContents.executeJavaScript(
    "window.__fixtureError || null",
  );
  if (firstPhaseError) throw new Error(firstPhaseError);
  const screenshot = await window.webContents.capturePage();
  const screenshotBytes = screenshot.toPNG();
  const locator = normalizeTestEvidenceLocator("screenshots/test-run.png");
  writeFileSync(
    join(fixture.config.evidenceDirectory, "test-run.png"),
    screenshotBytes,
    { mode: 0o600 },
  );
  await window.webContents.executeJavaScript(
    `window.__fixtureScreenshot = ${JSON.stringify({ hash: sha256(screenshotBytes), byteSize: screenshotBytes.byteLength, locator })}`,
  );
  await clickButton();
  await waitFor(
    "window.__fixturePhase === 'complete' || window.__fixtureError",
  );
  const rendererError = await window.webContents.executeJavaScript(
    "window.__fixtureError || null",
  );
  assert.equal(rendererError, null);
  const passed = await window.webContents.executeJavaScript(
    "window.__fixtureResult",
  );
  assert.equal(passed.state, "passed");
  assert.equal(passed.manifestHash, fixture.config.testRunManifestHash);

  await supervisor.stop();
  await supervisor.start(fixture.config.companyDirectory);
  runtimeIpc.revokeWindow();
  await window.reload();
  const recovered = await window.webContents.executeJavaScript(
    `window.sandcastle.query({ type: 'test-runs.inspect', testRunId: ${JSON.stringify(seeded.runInput.testRunId)} })`,
    true,
  );
  const pipeline = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.inspectRun(${JSON.stringify(seeded.running.run.id)})`,
    true,
  );
  const audit = await window.webContents.executeJavaScript(
    `window.sandcastle.runtime.audit({ runId: ${JSON.stringify(seeded.running.run.id)}, limit: 100 })`,
    true,
  );
  const events = await window.webContents.executeJavaScript(
    "window.sandcastle.runtime.events({ afterSequence: 0, limit: 100 })",
    true,
  );
  assert.equal(recovered.view.state, "passed");
  assert.equal(
    pipeline.nodes.find((node) => node.pipelineNodeId === "test")?.status,
    "succeeded",
  );
  assert.equal(
    audit.some((record) => record.action === "test.run.completed"),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "test.run.completed"),
    true,
  );
  assert.equal(health.schemaVersion, 47);
  process.stdout.write(
    `${JSON.stringify({ status: "ok", testRunId: recovered.view.id, passAuthorityHash: recovered.view.passAuthorityHash, runtimePid: (await supervisor.health()).pid, schemaVersion: health.schemaVersion, auditRecords: audit.length, runtimeEvents: events.length })}\n`,
  );
};

const cleanup = async () => {
  window?.destroy();
  await supervisor?.stop().catch(() => undefined);
  if (fixture) fixture.cleanup();
  rmSync(scriptRoot, { recursive: true, force: true });
};

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    process.stderr.write(
      `[electron-test-fixture] ${String(error && error.stack ? error.stack : error)}\n`,
    );
    exitCode = 1;
  } finally {
    await cleanup();
    app.exit(exitCode);
  }
});
