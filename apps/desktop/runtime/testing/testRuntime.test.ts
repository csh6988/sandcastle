import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { migrateCompanyDatabase } from "../storage/migrations.js";
import { openRuntimeEvents } from "../events/subscription.js";
import type { IntegrationGenerationView } from "../integration/integrationRuntime.js";
import { openTestRuntime, TestRuntimeError } from "./testRuntime.js";

const hash = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);

const passedGeneration = (): IntegrationGenerationView =>
  ({
    id: "generation-1",
    manifest: {
      schemaVersion: 1,
      generationId: "generation-1",
      generation: 1,
      projectId: "project-1",
      runId: "run-1",
      snapshotRevisionId: "snapshot-1",
      nodeRunId: "integration-node-1",
      coverageId: "coverage-1",
      coverageNodeRunId: "review-node-1",
      coverageNodeAttemptId: "review-attempt-1",
      coverageHash: hash("a"),
      repositories: [
        {
          repositoryReference: "repo-a",
          baseCommit: commit("1"),
          integrationBranch: "integration/run-1/g1",
        },
      ],
      packages: [],
      dependencyOrder: [],
      contractVersions: [],
      integrationConditions: [],
      requiredValidations: [],
    },
    manifestHash: hash("b"),
    state: "passed",
    repositoryResults: [
      {
        id: "repository-result-1",
        repositoryReference: "repo-a",
        baseCommit: commit("1"),
        integrationBranch: "integration/run-1/g1",
        state: "succeeded",
        expectedTip: commit("1"),
        integratedCommit: commit("2"),
        validationRecords: [],
      },
    ],
    operations: [],
    defects: [],
    aggregateReview: {
      id: "aggregate-review-1",
      topicId: "topic-1",
      qualityGateResultId: "gate-1",
      input: {},
      inputHash: hash("c"),
      result: "PASS",
      evidence: ["artifact-version:evidence-1"],
    },
    passAuthorityHash: hash("d"),
  }) as IntegrationGenerationView;

const openFixture = (withEvents = false) => {
  const database = new DatabaseSync(":memory:");
  migrateCompanyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const generation = passedGeneration();
  const events = withEvents ? openRuntimeEvents(database) : undefined;
  const runtime = openTestRuntime(database, {
    integrationAuthority: { readPassAuthority: () => generation },
    ...(events ? { events } : {}),
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
  });
  const revisionInput = {
    testCaseId: "case-1",
    revisionId: "case-1-r1",
    projectId: "project-1",
    manifest: {
      schemaVersion: 1 as const,
      ownerPositionId: "position-test-engineer",
      requirementIds: ["requirement-19"],
      workPackageVersions: [],
      preconditions: ["integration authority is PASS"],
      uiActions: [{ id: "action-1", kind: "click", target: "run-test" }],
      assertions: [
        {
          id: "assertion-1",
          ui: { kind: "text", expected: "passed" },
          runtime: { kind: "test-run-state", expected: "passed" },
        },
      ],
      fixture: { id: "fixture-1", scriptHashes: [hash("e")] },
      evidencePolicy: {
        retentionClass: "durable" as const,
        redactionProfile: "default",
        requiredKinds: ["ui", "runtime"],
      },
      cleanup: { policy: "always", required: true },
    },
  };
  const revision = runtime.registerCaseRevision(revisionInput);
  const runInput = {
    testRunId: "test-run-1",
    requestId: "request-1",
    projectId: "project-1",
    runId: "run-1",
    snapshotRevisionId: "snapshot-1",
    nodeRunId: "test-node-1",
    nodeAttemptId: "test-attempt-1",
    sessionId: "test-session-1",
    testCaseRevisions: [{ id: revision.id, hash: revision.manifestHash }],
    integrationAuthority: {
      generationId: generation.id,
      manifestHash: generation.manifestHash,
      passAuthorityHash: generation.passAuthorityHash!,
      repositoryCommits: [
        { repositoryReference: "repo-a", commit: commit("2") },
      ],
    },
    build: { artifactVersionId: "build-1", digest: hash("f") },
    executionProfile: { id: "profile-1", hash: hash("1") },
    companyDirectoryFingerprint: hash("2"),
    fixture: { id: "fixture-1", scriptHashes: [hash("e")] },
    clock: { instant: "2026-07-29T00:00:00.000Z", seed: "seed-1" },
    environment: { platform: "darwin", architecture: "arm64" },
    capabilities: ["electron", "runtime-query"],
  };
  return {
    database,
    events,
    generation,
    runtime,
    revision,
    revisionInput,
    runInput,
  };
};

describe("Test Runtime", () => {
  it("accepts only the exact closed PASS Integration Generation authority", () => {
    const { database, generation, runtime, runInput } = openFixture();
    const run = runtime.createRun(runInput);
    assert.equal(run.state, "scheduled");

    (
      generation.defects as Array<IntegrationGenerationView["defects"][number]>
    ).push({
      id: "defect-1",
      kind: "aggregate",
      status: "open",
      responsibility: {},
      evidence: {},
    });
    assert.throws(
      () =>
        runtime.createRun({
          ...runInput,
          testRunId: "test-run-2",
          requestId: "request-2",
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "INTEGRATION_AUTHORITY_INELIGIBLE",
    );
    database.close();
  });

  it("keeps Test Case revisions and Test Run manifests immutable with stable replay conflicts", () => {
    const { database, runtime, revision, revisionInput, runInput } =
      openFixture();
    assert.deepEqual(runtime.registerCaseRevision(revisionInput), revision);
    assert.throws(
      () =>
        runtime.registerCaseRevision({
          ...revisionInput,
          manifest: { ...revisionInput.manifest, preconditions: ["changed"] },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_CASE_REVISION_CONFLICT",
    );

    const first = runtime.createRun(runInput);
    assert.deepEqual(runtime.createRun(runInput), first);
    assert.throws(
      () =>
        runtime.createRun({
          ...runInput,
          environment: { ...runInput.environment, platform: "win32" },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_REQUEST_CONFLICT",
    );
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE test_case_revisions SET manifest_hash = ? WHERE id = ?",
          )
          .run(hash("9"), revision.id),
      /Test Case revision is immutable/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE test_runs SET manifest_hash = ? WHERE id = ?")
          .run(hash("9"), first.id),
      /Test Run manifest is immutable/,
    );
    database.close();
  });

  it("requires paired UI and Runtime assertions with correlated immutable evidence before PASS", () => {
    const { database, runtime, revision, runInput } = openFixture();
    runtime.createRun(runInput);
    const correlation = {
      commandId: "command-1",
      eventSequence: 8,
      queryAsOfSequence: 8,
      queryViewHash: runtime.inspect(runInput.testRunId).viewHash,
      snapshotRevisionId: runInput.snapshotRevisionId,
      runId: runInput.runId,
      nodeRunId: runInput.nodeRunId,
      nodeAttemptId: runInput.nodeAttemptId,
      sessionId: runInput.sessionId,
      artifactVersionIds: ["artifact-version-1"],
    };
    runtime.recordAssertion({
      testRunId: runInput.testRunId,
      testCaseRevisionId: revision.id,
      assertionId: "assertion-1",
      uiStatus: "passed",
      runtimeStatus: "missing",
      correlation,
    });
    runtime.recordEvidence({
      id: "evidence-1",
      testRunId: runInput.testRunId,
      testCaseRevisionId: revision.id,
      assertionId: "assertion-1",
      kind: "ui",
      mediaType: "image/png",
      contentHash: hash("4"),
      byteSize: 42,
      artifactVersionId: "artifact-version-1",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/screenshot.png",
      metadata: { commandId: "command-1" },
    });
    assert.throws(
      () => runtime.complete(runInput.testRunId),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_PASS_INCOMPLETE",
    );

    const fresh = openFixture();
    fresh.runtime.createRun(fresh.runInput);
    fresh.runtime.recordAssertion({
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      uiStatus: "passed",
      runtimeStatus: "passed",
      correlation: {
        ...correlation,
        artifactVersionIds: ["artifact-version-ui", "artifact-version-runtime"],
        queryViewHash: fresh.runtime.inspect(fresh.runInput.testRunId).viewHash,
      },
    });
    fresh.runtime.recordEvidence({
      id: "evidence-1",
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      kind: "runtime",
      mediaType: "application/json",
      contentHash: hash("5"),
      byteSize: 42,
      artifactVersionId: "artifact-version-runtime",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/runtime.json",
      metadata: { eventSequence: 8, queryViewHash: hash("3") },
    });
    assert.throws(
      () => fresh.runtime.complete(fresh.runInput.testRunId),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_RUN_PASS_INCOMPLETE",
    );
    const uiEvidence = {
      id: "evidence-ui",
      testRunId: fresh.runInput.testRunId,
      testCaseRevisionId: fresh.revision.id,
      assertionId: "assertion-1",
      kind: "screenshot",
      mediaType: "image/png",
      contentHash: hash("6"),
      byteSize: 42,
      artifactVersionId: "artifact-version-ui",
      redactionProfile: "default",
      retentionClass: "durable",
      locator: "evidence/ui.png",
      metadata: { commandId: "command-1" },
    } as const;
    fresh.runtime.recordEvidence(uiEvidence);
    fresh.runtime.recordEvidence(uiEvidence);
    assert.throws(
      () =>
        fresh.runtime.recordEvidence({
          ...uiEvidence,
          locator: "evidence/changed.png",
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_EVIDENCE_CONFLICT",
    );
    const passed = fresh.runtime.complete(fresh.runInput.testRunId);
    assert.equal(passed.state, "passed");
    assert.match(passed.passAuthorityHash!, /^[a-f0-9]{64}$/);
    assert.equal(
      fresh.runtime.downstreamAuthority(passed.id).integrationAuthority
        .generationId,
      "generation-1",
    );
    fresh.database.close();
    database.close();
  });

  it("reconciles crash, timeout, cancellation, and accepted non-terminal effects without blind resend", async () => {
    const { database, runtime, runInput } = openFixture();
    runtime.createRun(runInput);
    let executions = 0;
    const adapter = {
      execute: () => {
        executions += 1;
        return {
          state: "accepted" as const,
          providerReceipt: { id: "provider-1" },
        };
      },
      reconcile: () => ({
        state: "succeeded" as const,
        providerReceipt: { id: "provider-1" },
        evidenceRef: "execution-fact:1",
      }),
      cancel: () => ({ state: "unknown" as const }),
    };
    const accepted = await runtime.execute({
      testRunId: runInput.testRunId,
      operationId: "operation-1",
      input: { kind: "electron" },
      adapter,
    });
    assert.equal(accepted.state, "reconciling");
    await assert.rejects(
      runtime.execute({
        testRunId: runInput.testRunId,
        operationId: "operation-1",
        input: { kind: "electron" },
        adapter,
      }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_EXECUTION_RECONCILIATION_REQUIRED",
    );
    assert.equal(executions, 1);
    const reconciled = await runtime.reconcile({
      testRunId: runInput.testRunId,
      operationId: "operation-1",
      adapter,
    });
    assert.equal(reconciled.state, "running");
    assert.equal(executions, 1);

    const second = openFixture();
    second.runtime.createRun(second.runInput);
    await second.runtime.execute({
      testRunId: second.runInput.testRunId,
      operationId: "operation-2",
      input: { kind: "contract" },
      adapter,
    });
    const cancelled = await second.runtime.cancel({
      testRunId: second.runInput.testRunId,
      operationId: "operation-2",
      adapter,
    });
    assert.equal(cancelled.state, "unknown");
    second.database.close();
    database.close();
  });

  it("reconciles crashes on both sides of the external effect without duplicating it", async () => {
    const beforeEffect = openFixture(true);
    beforeEffect.runtime.createRun(beforeEffect.runInput);
    let beforeExecutions = 0;
    const beforeAdapter = {
      execute: () => {
        beforeExecutions += 1;
        return { state: "succeeded" as const, evidenceRef: "fact:before" };
      },
      reconcile: () => ({ state: "not-started" as const }),
    };
    await assert.rejects(
      beforeEffect.runtime.execute({
        testRunId: beforeEffect.runInput.testRunId,
        operationId: "operation-before",
        input: { kind: "runtime" },
        adapter: beforeAdapter,
        failureInjection: (point) => {
          if (point === "after-intent") throw new Error("crash-after-intent");
        },
      }),
      /crash-after-intent/,
    );
    assert.equal(beforeExecutions, 0);
    await beforeEffect.runtime.reconcile({
      testRunId: beforeEffect.runInput.testRunId,
      operationId: "operation-before",
      adapter: beforeAdapter,
    });
    assert.equal(
      (
        beforeEffect.events
          ?.readAfter(0, 100)
          .slice()
          .reverse()
          .find((event) => event.type === "test.run.started")?.payload as
          | { readonly state?: string }
          | undefined
      )?.state,
      "reconciling",
    );
    const resumed = await beforeEffect.runtime.execute({
      testRunId: beforeEffect.runInput.testRunId,
      operationId: "operation-before",
      input: { kind: "runtime" },
      adapter: beforeAdapter,
    });
    assert.equal(resumed.state, "running");
    assert.equal(beforeExecutions, 1);

    const afterEffect = openFixture();
    afterEffect.runtime.createRun(afterEffect.runInput);
    let afterExecutions = 0;
    const afterAdapter = {
      execute: () => {
        afterExecutions += 1;
        return { state: "succeeded" as const, evidenceRef: "fact:after" };
      },
      reconcile: () => ({
        state: "succeeded" as const,
        evidenceRef: "fact:after",
      }),
    };
    await assert.rejects(
      afterEffect.runtime.execute({
        testRunId: afterEffect.runInput.testRunId,
        operationId: "operation-after",
        input: { kind: "electron" },
        adapter: afterAdapter,
        failureInjection: (point) => {
          if (point === "after-effect") throw new Error("crash-after-effect");
        },
      }),
      /crash-after-effect/,
    );
    assert.equal(afterExecutions, 1);
    const reconciled = await afterEffect.runtime.reconcile({
      testRunId: afterEffect.runInput.testRunId,
      operationId: "operation-after",
      adapter: afterAdapter,
    });
    assert.equal(reconciled.state, "running");
    assert.equal(afterExecutions, 1);
    beforeEffect.database.close();
    afterEffect.database.close();
  });

  it("rejects stale Query correlation even when the Test Run view hash still matches", () => {
    const fixture = openFixture(true);
    fixture.runtime.createRun(fixture.runInput);
    const view = fixture.runtime.inspect(fixture.runInput.testRunId);
    assert.throws(
      () =>
        fixture.runtime.recordAssertion({
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "assertion-1",
          uiStatus: "passed",
          runtimeStatus: "passed",
          correlation: {
            commandId: "stale-command",
            eventSequence: 0,
            queryAsOfSequence: 0,
            queryViewHash: view.viewHash,
            snapshotRevisionId: fixture.runInput.snapshotRevisionId,
            runId: fixture.runInput.runId,
            nodeRunId: fixture.runInput.nodeRunId,
            nodeAttemptId: fixture.runInput.nodeAttemptId,
            sessionId: fixture.runInput.sessionId,
            artifactVersionIds: ["artifact-version-1"],
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_ASSERTION_CORRELATION_INVALID",
    );
    fixture.database.close();
  });

  it("tracks discriminated defect responsibility, immutable resolution, and fresh rerun authority", () => {
    const fixture = openFixture();
    fixture.runtime.createRun(fixture.runInput);
    const responsibilities = [
      {
        kind: "work-package" as const,
        workPackageId: "package-1",
        workPackageVersionId: "package-1-v1",
      },
      {
        kind: "contract" as const,
        contractId: "contract-1",
        version: "1",
        producerApplicationId: "app-api",
        consumerApplicationId: "app-web",
        candidateWorkPackageVersionIds: ["package-1-v1", "package-2-v1"],
      },
      {
        kind: "aggregate" as const,
        candidateWorkPackageVersionIds: ["package-1-v1", "package-2-v1"],
      },
      {
        kind: "unknown" as const,
        candidateWorkPackageVersionIds: ["package-1-v1"],
        reason: "Evidence cannot uniquely attribute the mismatch.",
      },
    ];
    responsibilities.forEach((responsibility, index) => {
      fixture.runtime.recordDefect({
        id: `defect-${index + 1}`,
        testRunId: fixture.runInput.testRunId,
        testCaseRevisionId: fixture.revision.id,
        assertionId: "assertion-1",
        responsibility,
        evidence: { refs: [`evidence-${index + 1}`] },
      });
    });
    assert.throws(
      () =>
        fixture.runtime.recordDefect({
          id: "defect-outside-frozen-scope",
          testRunId: fixture.runInput.testRunId,
          testCaseRevisionId: fixture.revision.id,
          assertionId: "missing-assertion",
          responsibility: responsibilities[0]!,
          evidence: { refs: ["evidence-outside-frozen-scope"] },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_SCOPE_INVALID",
    );
    assert.throws(
      () =>
        fixture.runtime.closeDefect({
          defectId: "defect-1",
          resolutionId: "resolution-without-evidence",
          resolution: {},
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "TEST_DEFECT_RESOLUTION_INVALID",
    );
    const closed = fixture.runtime.closeDefect({
      defectId: "defect-1",
      resolutionId: "resolution-1",
      resolution: { evidenceRefs: ["fix-evidence-1"] },
    });
    assert.equal(
      closed.defects.find((defect) => defect.id === "defect-1")?.status,
      "closed",
    );
    assert.deepEqual(
      fixture.runtime.closeDefect({
        defectId: "defect-1",
        resolutionId: "resolution-1",
        resolution: { evidenceRefs: ["fix-evidence-1"] },
      }),
      closed,
    );
    assert.throws(
      () =>
        fixture.runtime.createRun({
          ...fixture.runInput,
          testRunId: "test-run-code-change",
          requestId: "request-code-change",
          integrationAuthority: {
            ...fixture.runInput.integrationAuthority,
            repositoryCommits: [
              { repositoryReference: "repo-a", commit: commit("3") },
            ],
          },
        }),
      (error: unknown) =>
        error instanceof TestRuntimeError &&
        error.code === "INTEGRATION_AUTHORITY_INELIGIBLE",
    );
    const fixtureRevision = fixture.runtime.registerCaseRevision({
      ...fixture.revisionInput,
      revisionId: "case-1-r2",
      supersedesRevisionId: fixture.revision.id,
      manifest: {
        ...fixture.revisionInput.manifest,
        fixture: { id: "fixture-2", scriptHashes: [hash("8")] },
      },
    });
    const fresh = fixture.runtime.createRun({
      ...fixture.runInput,
      testRunId: "test-run-fixture-change",
      requestId: "request-fixture-change",
      testCaseRevisions: [
        { id: fixtureRevision.id, hash: fixtureRevision.manifestHash },
      ],
      fixture: { id: "fixture-2", scriptHashes: [hash("8")] },
    });
    assert.equal(
      fresh.manifest.integrationAuthority.generationId,
      fixture.generation.id,
    );
    assert.notEqual(
      fresh.manifestHash,
      fixture.runtime.inspect(fixture.runInput.testRunId).manifestHash,
    );
    fixture.database.close();
  });
});
