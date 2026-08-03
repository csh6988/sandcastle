import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import { createElectronTestFixture } from "./electronTestFixture.js";
import {
  createIntegrationAuthorityFixture,
  createIntegrationAuthorityFixtureDeliveryQualityPlans,
  createIntegrationAuthorityFixturePreparation,
  createIntegrationAuthorityFixtureRuntimeOptions,
} from "./integrationAuthorityFixture.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fixtureRoots: string[] = [];
const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Integration authority fixture", () => {
  it("derives exact Candidate Gate observations from the scripted Reviewer terminal output", async () => {
    const runtimeOptions = createIntegrationAuthorityFixtureRuntimeOptions({
      companyDirectory: "/tmp/fixture-company",
      companyDirectoryFingerprint: "company-fingerprint",
      fixtureId: "integration-authority-gate-output-v1",
      repositoryDirectory: "/tmp/fixture-repository",
      worktreeDirectory: "/tmp/fixture-worktree",
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "integration-authority-gate-output-seed",
    });

    const result = await runtimeOptions.reviewerExecutionAdapter.execute({
      operationKey: "node-attempt:security-1",
      phase: "fresh-recheck",
      manifest: {
        supportingEvidenceRefs: [
          "artifact-version:build-1",
          "test-pass-authority:test-run-1:pass",
        ],
        candidateGate: {
          gateInputId: "security-gate-input-1",
          candidateInputId: "candidate-input-1",
          checks: [
            {
              id: "startup-build",
              requiredEvidenceKinds: ["artifact", "runtime-fact"],
            },
          ],
        },
      } as never,
      workspaceRef: "project-1",
      reviewNodeRunId: "security-node-1",
      reviewer: {
        participantId: "reviewer-participant-1",
        aiMemberId: "reviewer-1",
        positionId: "reviewer-position-1",
        sessionId: "reviewer-session-1",
      },
      executionProfile: {
        agentAdapterId: "scripted-execution",
        model: "fixture-v1",
        sandboxRef: "docker",
        secretReferenceIds: [],
        timeoutSeconds: 30,
        maxIterations: 1,
      },
      findings: [],
      revision: {
        id: "security-review-revision-1",
        subjectId: "security-gate-input-1",
        subjectHash: "a".repeat(64),
      },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded" || !("result" in result.output)) return;
    assert.deepEqual(result.output.evidenceRefs, [
      "artifact-version:build-1",
      "test-pass-authority:test-run-1:pass",
    ]);
    assert.deepEqual(result.output.gateExecution, {
      schemaVersion: 1,
      gateInputId: "security-gate-input-1",
      checks: [
        {
          checkId: "startup-build",
          status: "passed",
          evidence: [
            { kind: "artifact", ref: "artifact-version:build-1" },
            {
              kind: "runtime-fact",
              ref: "test-pass-authority:test-run-1:pass",
            },
          ],
          responsibility: {
            kind: "aggregate",
            candidateIds: ["candidate-input-1"],
          },
        },
      ],
      resolutions: [],
    });
  });

  it("fails closed when a Candidate Gate Reviewer terminal result omits exact check observations", () => {
    const candidate = {
      id: "candidate-input-1",
      manifestHash: "a".repeat(64),
      manifest: {
        integration: {
          manifest: {
            packages: [
              {
                reviewContext: {
                  acceptanceCriteria: ["The exact Candidate is reviewed."],
                },
              },
            ],
          },
        },
        artifacts: [{ id: "artifact-version:build-1" }],
        product: { projectSpecRevisionId: "project-spec-1" },
        technical: {
          applicationSpecRevisions: [{ id: "application-spec-1" }],
        },
        tests: [{ fixture: { id: "fixture-1" } }],
        producer: {
          aiMemberId: "producer-1",
          positionId: "producer-position-1",
          sessionId: "producer-session-1",
        },
        evidence: [{ id: "artifact-version:build-1" }],
        risk: { tier: "critical" },
      },
    };
    const plan = createIntegrationAuthorityFixtureDeliveryQualityPlans({
      fixtureId: "gate-plan-fixture-v1",
      database: {
        pipelineRuntime: {
          inspectRun: () => ({
            nodes: [{ id: "security-node-1", pipelineNodeId: "security" }],
            snapshot: {
              payload: {
                pipelineVersion: {
                  handlers: [
                    {
                      nodeId: "security",
                      handlerKindId: "security-review@1",
                    },
                  ],
                },
              },
            },
          }),
        },
        candidateInputs: { inspect: () => candidate },
      } as never,
      seeded: {
        projectId: "project-1",
        gateReview: {
          moderator: {
            aiMemberId: "moderator-1",
            positionId: "moderator-position-1",
            sessionId: "moderator-session-1",
          },
          reviewer: {
            aiMemberId: "reviewer-1",
            positionId: "reviewer-position-1",
            sessionId: "reviewer-session-1",
            freshSessionId: "reviewer-session-2",
          },
        },
      } as never,
      tests: {} as never,
      reviewerExecutionAdapter: {} as never,
      executableHash: "b".repeat(64),
    }).plan({
      runId: "run-1",
      nodeRunId: "security-node-1",
      attempt: {
        kind: "claimed",
        attemptId: "security-attempt-1",
        nodeRunId: "security-node-1",
        snapshotRevisionId: "snapshot-1",
        leaseId: "security-lease-1",
        leaseOwner: "delivery-quality-node-handler",
        leaseExpiresAt: "2026-07-29T00:05:00.000Z",
        operationKey: "node-attempt:security-attempt-1",
        executionEpoch: 1,
        fenceToken: "security-fence-1",
      },
    });
    const gateInput = {
      id: "security-gate-input-1",
      manifestHash: "c".repeat(64),
      manifest: {
        supportingEvidenceRefs: ["artifact-version:build-1"],
        checkCatalog: {
          checks: [
            { id: "startup-build", requiredEvidenceKinds: ["artifact"] },
          ],
        },
      },
    };
    const context = {
      result: () => ({ command: {} as never, value: gateInput }),
    };

    assert.throws(
      () =>
        plan.review?.terminalCommands(
          {
            status: "succeeded",
            providerId: "scripted-execution",
            isolation: {
              readOnlyFilesystem: true,
              independentGitDatabase: true,
              independentSessionStorage: true,
              independentCredentialScope: true,
              independentMutableCache: true,
              inputAllowlist: true,
              mechanism: "fixture",
              mechanismVersion: "1",
            },
            isolationEvidence: ["artifact-version:build-1"],
            output: {
              result: "PASS",
              conditions: [],
              evidenceRefs: ["artifact-version:build-1"],
            },
            terminalExecutionFactId: "execution-fact-1",
          },
          context,
        ),
      /exact Candidate Gate execution observations/,
    );

    const gateExecution = {
      schemaVersion: 1 as const,
      gateInputId: gateInput.id,
      checks: [
        {
          checkId: "startup-build",
          status: "passed" as const,
          evidence: [
            { kind: "artifact" as const, ref: "artifact-version:build-1" },
          ],
          responsibility: {
            kind: "aggregate" as const,
            candidateIds: [candidate.id],
          },
        },
      ],
      resolutions: [],
    };
    const reviewerResult = (output: unknown) =>
      ({
        status: "succeeded",
        providerId: "scripted-execution",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: ["artifact-version:build-1"],
        output,
        terminalExecutionFactId: "execution-fact-1",
      }) as never;
    for (const result of ["FAIL", "CONDITIONAL_PASS"] as const) {
      assert.throws(
        () =>
          plan.review!.terminalCommands(
            reviewerResult({
              result,
              conditions: result === "FAIL" ? [] : ["condition-1"],
              evidenceRefs: ["artifact-version:build-1"],
              gateExecution,
            }),
            context,
          ),
        /unconditional PASS with every Candidate Gate check passed/,
      );
    }
    assert.throws(
      () =>
        plan.review!.terminalCommands(
          reviewerResult({
            result: "PASS",
            conditions: [],
            evidenceRefs: ["artifact-version:build-1"],
            gateExecution: {
              ...gateExecution,
              checks: gateExecution.checks.map((check) => ({
                ...check,
                status: "failed",
              })),
            },
          }),
          context,
        ),
      /unconditional PASS with every Candidate Gate check passed/,
    );
    assert.throws(
      () =>
        plan.review!.terminalCommands(
          {
            status: "succeeded",
            providerId: "scripted-execution",
            isolation: {
              readOnlyFilesystem: true,
              independentGitDatabase: true,
              independentSessionStorage: true,
              independentCredentialScope: true,
              independentMutableCache: true,
              inputAllowlist: true,
              mechanism: "fixture",
              mechanismVersion: "1",
            },
            isolationEvidence: ["artifact-version:build-1"],
            output: {
              result: "PASS",
              conditions: [],
              evidenceRefs: ["artifact-version:build-1"],
              gateExecution: {
                ...gateExecution,
                gateInputId: "different-gate-input",
              },
            },
            terminalExecutionFactId: "execution-fact-1",
          },
          context,
        ),
      /exact Candidate Gate execution observations/,
    );
    const commands = plan.review!.terminalCommands(
      {
        status: "succeeded",
        providerId: "scripted-execution",
        isolation: {
          readOnlyFilesystem: true,
          independentGitDatabase: true,
          independentSessionStorage: true,
          independentCredentialScope: true,
          independentMutableCache: true,
          inputAllowlist: true,
          mechanism: "fixture",
          mechanismVersion: "1",
        },
        isolationEvidence: ["artifact-version:build-1"],
        output: {
          result: "PASS",
          conditions: [],
          evidenceRefs: ["artifact-version:build-1"],
          gateExecution,
        },
        terminalExecutionFactId: "execution-fact-1",
      },
      context,
    );
    const reconcile = commands.find(
      (entry) =>
        typeof entry !== "function" &&
        entry.command.type === "quality-gate.execution.reconcile",
    );
    assert.ok(reconcile && typeof reconcile !== "function");
    assert.deepEqual(
      (
        reconcile.command as {
          readonly observation: { readonly fact: unknown };
        }
      ).observation.fact,
      gateExecution,
    );
    assert.match(
      (
        reconcile.command as {
          readonly observation: { readonly receiptHash: string };
        }
      ).observation.receiptHash,
      /^[a-f0-9]{64}$/,
    );
  });

  it("continues from the exact renderer-confirmed Product Baseline and formal Run", async () => {
    const scriptRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-integration-authority-product-scripts-"),
    );
    fixtureRoots.push(scriptRoot);
    const executionScript = join(scriptRoot, "execution.json");
    const interactionScript = join(scriptRoot, "interaction.json");
    writeFileSync(executionScript, JSON.stringify({ status: "passed" }), {
      mode: 0o600,
    });
    writeFileSync(
      interactionScript,
      JSON.stringify({ response: "fixture interaction passed" }),
      { mode: 0o600 },
    );
    const electronFixture = createElectronTestFixture({
      fixtureId: "integration-authority-product-fixture-v1",
      testRunId: "pending",
      testRunManifestHash: "0".repeat(64),
      adapters: [
        {
          id: "scripted-execution",
          scriptPath: executionScript,
          expectedScriptHash: sha256(JSON.stringify({ status: "passed" })),
        },
        {
          id: "scripted-interaction",
          scriptPath: interactionScript,
          expectedScriptHash: sha256(
            JSON.stringify({ response: "fixture interaction passed" }),
          ),
        },
      ],
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "integration-authority-product-fixture-seed",
      packaged: false,
      entrypoint: "electron-test-fixture",
      additionalRepositoryCount: 1,
    });
    fixtureCleanups.push(() => void electronFixture.cleanup());
    const fixtureInput = {
      companyDirectory: electronFixture.config.companyDirectory,
      companyDirectoryFingerprint:
        electronFixture.config.companyDirectoryFingerprint,
      fixtureId: electronFixture.config.fixtureId,
      repositoryDirectory: electronFixture.config.repositoryDirectory,
      worktreeDirectory: electronFixture.config.worktreeDirectory,
      repositoryDirectories: [
        electronFixture.config.repositoryDirectory,
        ...(electronFixture.config.additionalRepositories ?? []).map(
          (repository) => repository.repositoryDirectory,
        ),
      ],
      fakeClock: electronFixture.config.fakeClock,
      repeatableIdSeed: electronFixture.config.repeatableIdSeed,
    };
    const runtimeOptions =
      createIntegrationAuthorityFixtureRuntimeOptions(fixtureInput);
    const database = openCompanyDatabase(
      electronFixture.config.companyDirectory,
      {
        clock: runtimeOptions.clock,
        executionAdapter: runtimeOptions.executionAdapter,
        codeReviewRuntime: {
          reviewerExecutionAdapter: runtimeOptions.reviewerExecutionAdapter,
        },
        integrationRuntime: {
          validationProvider: runtimeOptions.integrationValidationProvider,
        },
      },
    );

    try {
      const preparation = createIntegrationAuthorityFixturePreparation({
        ...fixtureInput,
        database,
      });
      const actor = {
        type: "human" as const,
        id: "electron-test-fixture",
        authenticatedBy: "local-session" as const,
      };
      const proposal = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${fixtureInput.fixtureId}:renderer-product-proposal-revise`,
        actor,
        consumerId: "electron-test-fixture-renderer",
        expectedRevision: 0,
        command: {
          type: "product.proposal.revise",
          projectId: preparation.projectId,
          producerSessionId: preparation.productSessionId,
          content: {
            goal: "Verify the real Product-to-Candidate authority chain.",
            users: ["Electron Test fixture"],
            scope: ["T21 Product-to-Candidate authority"],
            nonGoals: ["Release operation"],
            acceptanceCriteria: [
              "The exact frozen Diff is independently reviewed.",
            ],
            constraints: ["Use only the temporary fixture Repository."],
            risks: ["Fixture evidence must remain inside its temporary root."],
            openQuestions: [],
          },
        },
      });
      assert.equal(proposal.status, "succeeded");
      if (proposal.status !== "succeeded" || !proposal.value.proposal) return;
      const awaiting = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${fixtureInput.fixtureId}:renderer-product-proposal-awaiting`,
        actor,
        consumerId: "electron-test-fixture-renderer",
        expectedRevision: proposal.value.proposal.revision,
        command: {
          type: "product.proposal.mark-awaiting-confirmation",
          projectId: preparation.projectId,
          proposalRevisionId: proposal.value.proposal.currentRevision.id,
          proposalHash: proposal.value.proposal.currentRevision.hash,
        },
      });
      assert.equal(awaiting.status, "succeeded");
      if (awaiting.status !== "succeeded" || !awaiting.value.proposal) return;
      const confirmed = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: `${fixtureInput.fixtureId}:renderer-product-baseline-confirm`,
        actor,
        consumerId: "electron-test-fixture-renderer",
        expectedRevision: awaiting.value.proposal.revision,
        command: {
          type: "confirm-product-baseline",
          projectId: preparation.projectId,
          departmentId: preparation.departmentId,
          proposalRevisionId: awaiting.value.proposal.currentRevision.id,
          proposalHash: awaiting.value.proposal.currentRevision.hash,
        },
      });
      assert.equal(confirmed.status, "succeeded");
      if (confirmed.status !== "succeeded") return;
      const baseline = confirmed.value.baselines[0];
      assert.ok(baseline);
      database.interaction.closeSession(preparation.productSessionId);

      const created = await createIntegrationAuthorityFixture({
        ...fixtureInput,
        database,
        preparation,
        confirmedProduct: {
          productBaselineId: baseline.id,
          productBaselineHash: baseline.hash,
          runId: baseline.runId,
          snapshotRevisionId: baseline.snapshotRevisionId,
        },
      });

      assert.equal(created.projectId, preparation.projectId);
      assert.equal(created.runId, baseline.runId);
      assert.equal(created.integrationAuthority.repositoryResults.length, 2);
      const expectedCoverage = database.workPackages
        .inspect(created.runId)
        .packages.map((workPackage) => {
          const version = workPackage.versions.at(-1);
          assert.ok(version);
          return {
            workPackageId: workPackage.id,
            workPackageVersionId: version.id,
            manifestHash: version.manifestHash,
            riskTier: version.manifest.riskTier,
          };
        })
        .sort((left, right) =>
          left.workPackageVersionId.localeCompare(right.workPackageVersionId),
        );
      assert.equal(created.workPackageCoverage.length, 2);
      assert.deepEqual(
        [...created.workPackageCoverage].sort((left, right) =>
          left.workPackageVersionId.localeCompare(right.workPackageVersionId),
        ),
        expectedCoverage,
      );
      assert.deepEqual(
        created.workPackageCoverage
          .map((coverage) => coverage.workPackageVersionId)
          .sort(),
        created.integrationAuthority.manifest.packages
          .map((workPackage) => workPackage.workPackageVersionId)
          .sort(),
      );
      for (const repository of [
        electronFixture.config.repositoryDirectory,
        ...(electronFixture.config.additionalRepositories ?? []).map(
          (additional) => additional.repositoryDirectory,
        ),
      ]) {
        const worktrees = execFileSync(
          "git",
          ["-C", repository, "worktree", "list", "--porcelain"],
          { encoding: "utf8" },
        )
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length));
        assert.ok(worktrees.length > 0, `${repository} has no Worktrees.`);
        for (const worktree of worktrees) {
          const status = execFileSync(
            "git",
            [
              "-C",
              worktree,
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ],
            { encoding: "utf8" },
          );
          assert.equal(status, "", `${worktree} is dirty:\n${status}`);
        }
      }
      assert.equal(
        database.pipelineRuntime.inspectRun(created.runId).snapshot.payload
          .productBaseline?.id,
        baseline.id,
      );
      const plans = createIntegrationAuthorityFixtureDeliveryQualityPlans({
        fixtureId: fixtureInput.fixtureId,
        database,
        seeded: created,
        tests: {
          downstreamAuthority: () => ({ capabilities: ["electron"] }) as never,
        },
        reviewerExecutionAdapter: runtimeOptions.reviewerExecutionAdapter,
        executableHash: "f".repeat(64),
      });
      const candidateInputPlan = plans.plan({
        runId: created.runId,
        nodeRunId: created.deliveryQuality.candidateInputNodeRunId,
        attempt: {
          kind: "claimed",
          attemptId: "candidate-input-attempt-1",
          nodeRunId: created.deliveryQuality.candidateInputNodeRunId,
          snapshotRevisionId: created.snapshotRevisionId,
          leaseId: "candidate-input-lease-1",
          leaseOwner: "delivery-quality-node-handler",
          leaseExpiresAt: "2026-07-29T00:05:00.000Z",
          operationKey: "node-attempt:candidate-input-attempt-1",
          executionEpoch: 1,
          fenceToken: "candidate-input-fence-1",
        },
      });
      assert.equal(
        candidateInputPlan.handlerKindId,
        "delivery-candidate-input@1",
      );
      const freezeStep = candidateInputPlan.initialCommands[0];
      assert.notEqual(typeof freezeStep, "function");
      if (!freezeStep || typeof freezeStep === "function") return;
      assert.deepEqual(
        candidateInputPlan.initialCommands.map((entry) =>
          typeof entry === "function" ? "factory" : entry.command.type,
        ),
        ["delivery.candidate-input.freeze"],
      );
      assert.deepEqual(freezeStep.command, {
        type: "delivery.candidate-input.freeze",
        candidateInputId: `${fixtureInput.fixtureId}:delivery-candidate-input`,
        requestId: `${fixtureInput.fixtureId}:delivery-candidate-input-request`,
        projectId: created.projectId,
        runId: created.runId,
        snapshotRevisionId: created.snapshotRevisionId,
        nodeRunId: created.deliveryQuality.candidateInputNodeRunId,
        nodeAttemptId: "candidate-input-attempt-1",
        producer: {
          ...created.deliveryQuality.producer,
          sessionId: created.deliveryQuality.candidateInputSessionId,
        },
        requiredTestRunIds: [`test:${created.runId}:${created.testNodeRunId}`],
        environment: {
          platform: process.platform,
          architecture: process.arch,
          electronVersion: process.versions.electron ?? process.version,
          executableHash: "f".repeat(64),
          capabilityProfileHash: sha256(JSON.stringify(["electron"])),
        },
        evidencePolicy: {
          revisionId: "electron-test-fixture-evidence@1",
          redactionProfile: "fixture-redacted",
          retentionClass: "durable",
          maxItemBytes: 20 * 1024 * 1024,
          maxTotalBytes: 40 * 1024 * 1024,
        },
      });
      const auditDatabase = new DatabaseSync(database.path, { readOnly: true });
      try {
        assert.equal(
          Number(
            (
              auditDatabase
                .prepare(
                  `SELECT COUNT(*) AS count
                     FROM command_deduplication
                    WHERE command_id IN (?, ?, ?)`,
                )
                .get(
                  `${fixtureInput.fixtureId}:product-proposal-revise`,
                  `${fixtureInput.fixtureId}:product-proposal-awaiting`,
                  `${fixtureInput.fixtureId}:product-baseline-confirm`,
                ) as { readonly count: unknown }
            ).count,
          ),
          0,
        );
      } finally {
        auditDatabase.close();
      }
    } finally {
      database.close();
    }
  });

  it("creates exact T15 and T16 PASS authority through Runtime handlers", async () => {
    const scriptRoot = mkdtempSync(
      join(tmpdir(), "sandcastle-integration-authority-scripts-"),
    );
    fixtureRoots.push(scriptRoot);
    const executionScript = join(scriptRoot, "execution.json");
    const interactionScript = join(scriptRoot, "interaction.json");
    writeFileSync(executionScript, JSON.stringify({ status: "passed" }), {
      mode: 0o600,
    });
    writeFileSync(
      interactionScript,
      JSON.stringify({ response: "fixture interaction passed" }),
      { mode: 0o600 },
    );
    const electronFixture = createElectronTestFixture({
      fixtureId: "integration-authority-fixture-v1",
      testRunId: "pending",
      testRunManifestHash: "0".repeat(64),
      adapters: [
        {
          id: "scripted-execution",
          scriptPath: executionScript,
          expectedScriptHash: sha256(JSON.stringify({ status: "passed" })),
        },
        {
          id: "scripted-interaction",
          scriptPath: interactionScript,
          expectedScriptHash: sha256(
            JSON.stringify({ response: "fixture interaction passed" }),
          ),
        },
      ],
      allowedAdapterIds: ["scripted-execution", "scripted-interaction"],
      fakeClock: "2026-07-29T00:00:00.000Z",
      repeatableIdSeed: "integration-authority-fixture-seed",
      packaged: false,
      entrypoint: "electron-test-fixture",
    });
    fixtureCleanups.push(() => void electronFixture.cleanup());

    const fixtureInput = {
      companyDirectory: electronFixture.config.companyDirectory,
      companyDirectoryFingerprint:
        electronFixture.config.companyDirectoryFingerprint,
      fixtureId: electronFixture.config.fixtureId,
      repositoryDirectory: electronFixture.config.repositoryDirectory,
      worktreeDirectory: electronFixture.config.worktreeDirectory,
      fakeClock: electronFixture.config.fakeClock,
      repeatableIdSeed: electronFixture.config.repeatableIdSeed,
    };
    const runtimeOptions =
      createIntegrationAuthorityFixtureRuntimeOptions(fixtureInput);
    const database = openCompanyDatabase(
      electronFixture.config.companyDirectory,
      {
        clock: runtimeOptions.clock,
        executionAdapter: runtimeOptions.executionAdapter,
        codeReviewRuntime: {
          reviewerExecutionAdapter: runtimeOptions.reviewerExecutionAdapter,
        },
        integrationRuntime: {
          validationProvider: runtimeOptions.integrationValidationProvider,
        },
      },
    );
    const created = await createIntegrationAuthorityFixture({
      ...fixtureInput,
      database,
    });

    try {
      const frozenCoverage = created.workPackageCoverage[0];
      assert.ok(frozenCoverage);
      const persistedWorkPackageVersion = database.workPackages
        .inspect(created.runId)
        .packages.find((entry) => entry.id === frozenCoverage.workPackageId)
        ?.versions.find(
          (entry) => entry.id === frozenCoverage.workPackageVersionId,
        );
      assert.ok(persistedWorkPackageVersion);
      assert.equal(
        frozenCoverage.manifestHash,
        persistedWorkPackageVersion.manifestHash,
      );
      const authority = database.integrations.readPassAuthority(
        created.integrationAuthority.id,
      );
      assert.deepEqual(authority, created.integrationAuthority);
      assert.deepEqual(
        database.artifactRegistry.inspect(created.build.artifactVersionId)
          .version.producer.integrationAuthority,
        {
          generationId: authority.id,
          manifestHash: authority.manifestHash,
          passAuthorityHash: authority.passAuthorityHash,
          repositoryCommits: authority.repositoryResults.map((entry) => ({
            repositoryReference: entry.repositoryReference,
            commit: entry.integratedCommit!,
          })),
        },
      );
      assert.equal(
        database.codeReviews.inspect(created.runId)[0]?.integrationEligible,
        true,
      );
      assert.equal(
        database.pipelineRuntime
          .inspectRun(created.runId)
          .nodes.find((node) => node.pipelineNodeId === "integration")?.status,
        "succeeded",
      );
      const prerequisiteCommandIds = [
        "application-register",
        "product-proposal-revise",
        "product-proposal-awaiting",
        "product-baseline-confirm",
        "project-spec-revise",
        "product-review-start",
        "product-review-revision",
        "product-review-pass-primary",
        "product-review-pass-fresh",
        "product-readiness-record",
        "product-gate-promote",
        "application-spec-revise",
        "technical-proposal-revise",
        "technical-review-start",
        "technical-review-revision",
        "technical-review-pass-primary",
        "technical-review-pass-fresh",
        "technical-gate-promote",
        "work-package-generate",
        "work-package-assign",
        "work-package-start",
        "work-package-self-check",
        "canonical-diff-register",
        "canonical-diff-finalize",
        "build-register",
        "build-finalize",
      ].map((suffix) => `${electronFixture.config.fixtureId}:${suffix}`);
      const auditDatabase = new DatabaseSync(database.path, { readOnly: true });
      try {
        for (const commandId of prerequisiteCommandIds) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM command_deduplication WHERE command_id = ?",
                  )
                  .get(commandId) as { readonly count: unknown }
              ).count,
            ),
            1,
            commandId,
          );
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE command_id = ?",
                  )
                  .get(commandId) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${commandId}:audit`,
          );
        }
        for (const action of [
          "workspace-allocation.ready",
          "source-import.planned",
          "source-import.completed",
          "attempt.complete",
        ]) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_audit_records WHERE action = ?",
                  )
                  .get(action) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${action}:audit`,
          );
        }
        assert.equal(
          Number(
            (
              auditDatabase
                .prepare(
                  `SELECT COUNT(*) AS count
                     FROM execution_facts facts
                     JOIN work_package_assignments assignments
                       ON assignments.node_attempt_id = facts.target_id
                    WHERE facts.kind = 'completed'
                      AND facts.status = 'accepted'`,
                )
                .get() as {
                readonly count: unknown;
              }
            ).count,
          ) > 0,
          true,
          "development execution terminal fact",
        );
        for (const eventType of [
          "workspace-allocation.ready",
          "source-import.completed",
          "execution.completed",
        ]) {
          assert.equal(
            Number(
              (
                auditDatabase
                  .prepare(
                    "SELECT COUNT(*) AS count FROM runtime_event_outbox WHERE type = ?",
                  )
                  .get(eventType) as { readonly count: unknown }
              ).count,
            ) > 0,
            true,
            `${eventType}:outbox`,
          );
        }
      } finally {
        auditDatabase.close();
      }
    } finally {
      database.close();
    }
  });
});
