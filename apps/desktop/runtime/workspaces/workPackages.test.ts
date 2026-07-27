import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionAdapter,
  ExecutionAdapterInput,
} from "../adapters/scriptedExecutionAdapter.js";
import type { CommandResult, WorkPackageGraphView } from "../interface.js";
import {
  canonicalPipelineJson,
  pipelineHash,
} from "../pipeline/canonicalPipeline.js";
import { defaultNodeHandlerRegistry } from "../pipeline/nodeHandlerRegistry.js";
import { openCompanyDatabase } from "../storage/sqlite.js";

const runtimeActor = {
  type: "runtime-worker" as const,
  id: "delivery-coordinator-member",
  authenticatedBy: "runtime" as const,
};

const humanActor = {
  type: "human" as const,
  id: "local-user",
  authenticatedBy: "local-session" as const,
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepository = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `sandcastle-work-package-${name}-`));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Work Package Test");
  git(root, "config", "user.email", "work-package@sandcastle.invalid");
  execFileSync("sh", ["-c", `printf ${name} > README.md`], { cwd: root });
  git(root, "add", "README.md");
  git(root, "commit", "-m", `${name} baseline`);
  return { root, baseCommit: git(root, "rev-parse", "HEAD") };
};

const manifest = (positionIds: readonly string[]) => ({
  objective: "Implement one bounded repository change.",
  acceptanceCriteria: ["The package behavior is covered by tests."],
  moduleScope: ["src/package.ts"],
  allowedPermissions: ["repository.write"],
  specRefs: ["application-spec:r1"],
  harnessRefs: ["tdd@1"],
  assignmentCriteria: { positionIds: [...positionIds] },
  expectedArtifacts: ["source-commit"],
  selfCheckCommands: ["npm test"],
  codeReviewConditions: ["Independent review is required by T15."],
  integrationConditions: ["The package source commit remains isolated."],
  riskTier: "medium" as const,
  recoveryPolicy: "Create a new version and Attempt.",
});

const createParallelAdapter = (firstWaveSize = 2) => {
  const requests: ExecutionAdapterInput[] = [];
  let active = 0;
  let maxActive = 0;
  let firstWaveArrivals = 0;
  let releaseFirstWave!: () => void;
  const firstWave = new Promise<void>((resolve) => {
    releaseFirstWave = resolve;
  });
  const adapter: ExecutionAdapter = {
    maxConcurrentNodes: 2,
    capabilities: {
      reattachRunningOperation: false,
      strongExecutionFence: true,
      enforceNoSideEffects: false,
    },
    execute: async (input) => {
      requests.push(input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (requests.length <= firstWaveSize) {
        firstWaveArrivals += 1;
        if (firstWaveArrivals === firstWaveSize) releaseFirstWave();
        await firstWave;
      }
      const workPackage =
        input.request?.sideEffectPolicy === "formal"
          ? input.request.immutableContext.workPackage
          : undefined;
      let resultCommit: string | undefined;
      if (workPackage) {
        writeFileSync(
          join(workPackage.executionTreePath, `${workPackage.id}.txt`),
          `${workPackage.id}:${input.attempt.id}\n`,
        );
        git(workPackage.executionTreePath, "add", `${workPackage.id}.txt`);
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          `implement ${workPackage.id}`,
        );
        resultCommit = git(workPackage.executionTreePath, "rev-parse", "HEAD");
      }
      active -= 1;
      return {
        kind: "succeeded" as const,
        structuredResult: {
          nodeId: input.node.id,
          ...(resultCommit ? { commits: [{ sha: resultCommit }] } : {}),
        },
        ...(workPackage?.id === "package-b"
          ? {
              artifacts: [
                {
                  type: "implementation-report",
                  schemaVersion: "1",
                  logicalName: "package-b-report",
                  content: "package-b evidence",
                },
              ],
            }
          : {}),
      };
    },
  };
  return { adapter, requests, maxActive: () => maxActive };
};

const seedPromotedTechnicalRun = (
  database: ReturnType<typeof openCompanyDatabase>,
  input: {
    readonly projectId: string;
    readonly repositoryA: string;
    readonly repositoryB: string;
    readonly positionIds: readonly string[];
    readonly includeSelfCheckSuccessor?: boolean;
    readonly includeSecondPackagePredecessor?: boolean;
    readonly includeSkippedPackagePredecessor?: boolean;
  },
) => {
  const runId = `run-${input.projectId}`;
  const snapshotRevisionId = `snapshot-${input.projectId}`;
  const technicalBaselineId = `technical-baseline-${input.projectId}`;
  const technicalBaselineHash = "a".repeat(64);
  const now = "2026-07-27T08:00:00.000Z";
  const workPackageNodes = ["package-a", "package-b", "package-c"].map(
    (id) => ({
      id,
      type: "ai-task" as const,
      name: id,
      positionId: input.positionIds[0],
      handlerKindId: "development@1",
      executionProfileId: "software-rnd-local-isolated-git",
    }),
  );
  const successorNode = {
    id: "after-package-a",
    type: "join" as const,
    name: "After package A",
    handlerKindId: "package-join@1",
  };
  const nodes = input.includeSelfCheckSuccessor
    ? [...workPackageNodes, successorNode]
    : workPackageNodes;
  const graph = {
    nodes,
    edges: input.includeSelfCheckSuccessor
      ? [
          { from: "package-a", to: successorNode.id },
          ...(input.includeSecondPackagePredecessor ||
          input.includeSkippedPackagePredecessor
            ? [{ from: "package-b", to: successorNode.id }]
            : []),
        ]
      : [],
  };
  const payload = {
    schemaVersion: 1 as const,
    technicalGatePromotion: {
      qualityGateResultId: `technical-gate-${input.projectId}`,
      acceptedTechnicalBaselineId: technicalBaselineId,
      acceptedTechnicalBaselineHash: technicalBaselineHash,
      acceptedApplicationSpecRevisions: [],
      promotedAt: now,
    },
    project: {
      id: input.projectId,
      revision: 1,
      name: "Parallel packages",
      goal: "Execute isolated Work Packages",
      sharedContext: "Package C consumes package A evidence.",
      repositoryReferences: [input.repositoryA, input.repositoryB],
    },
    department: {
      id: "software-rnd",
      revision: 0,
      name: "Software R&D",
      description: "Executes isolated delivery work.",
      inputArtifactContracts: [],
      outputArtifactContracts: [],
      defaultExecutionProfileId: "software-rnd-local-isolated-git",
    },
    pipelineVersion: {
      id: "software-rnd-pipeline-v1",
      version: 1,
      hash: pipelineHash(graph),
      graph,
      handlerRegistry: {
        version: defaultNodeHandlerRegistry.version,
        hash: defaultNodeHandlerRegistry.hash,
      },
      handlers: nodes.map((node) => {
        const handler = defaultNodeHandlerRegistry.resolve(
          node.type,
          node.handlerKindId,
        )!;
        return {
          nodeId: node.id,
          handlerKindId: handler.handlerKindId,
          inputSchemaHash: handler.inputSchemaHash,
          outputSchemaHash: handler.outputSchemaHash,
        };
      }),
    },
    skillFlows: [],
    positions: input.positionIds.map((positionId, index) => ({
      id: positionId,
      revision: 0,
      name: `Package Engineer ${index + 1}`,
      responsibility: "Implements one isolated Work Package.",
      defaultAgentId: "codex",
      resolvedAgentId: "codex",
      agentSource: "position-default" as const,
      skillIds: [],
      aiMember: {
        id: `member-${positionId}`,
        displayName: `Engineer ${index + 1}`,
        profile: "Repository-scoped developer",
        responsibilityMetadata: { focus: "development" },
        status: "active" as const,
      },
    })),
    executionProfiles: [
      {
        id: "software-rnd-local-isolated-git",
        revision: 0,
        name: "Local Isolated Git (Docker)",
        providerRef: "codex",
        model: "default",
        sandboxRef: "docker",
        branchStrategy: "branch" as const,
        limits: {
          timeoutSeconds: 60,
          maxIterations: 10,
          maxTokens: null,
        },
        retryPolicy: { maxAttempts: 1 },
        permissionPolicy: "ask" as const,
        secretReferenceIds: [],
      },
    ],
    runLimits: { maxActiveNodes: 2 },
  };
  const snapshotJson = canonicalPipelineJson(payload);
  const snapshotHash = pipelineHash(payload);
  const raw = new DatabaseSync(database.path);
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("PRAGMA busy_timeout = 5000");
  try {
    raw
      .prepare(
        `INSERT INTO department_runs(
           id, project_id, department_id, status, created_at,
           pipeline_version_id, snapshot_revision_id, revision, updated_at
         ) VALUES (?, ?, 'software-rnd', 'ready', ?,
                   'software-rnd-pipeline-v1', ?, 0, ?)`,
      )
      .run(runId, input.projectId, now, snapshotRevisionId, now);
    raw
      .prepare(
        `INSERT INTO run_snapshot_revisions(
           id, run_id, revision, schema_version, canonical_json, hash,
           created_at, parent_revision
         ) VALUES (?, ?, 1, 1, ?, ?, ?, NULL)`,
      )
      .run(snapshotRevisionId, runId, snapshotJson, snapshotHash, now);
    raw
      .prepare(
        `INSERT INTO technical_baselines(
           id, project_id, run_id, proposal_revision_id, manifest_json,
           manifest_hash, created_at
         ) VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        technicalBaselineId,
        input.projectId,
        runId,
        `proposal-${input.projectId}`,
        technicalBaselineHash,
        now,
      );
    raw
      .prepare(
        `INSERT INTO technical_gate_promotions(
           id, project_id, run_id, topic_id, quality_gate_result_id,
           technical_baseline_id, technical_baseline_hash,
           proposal_revision_id, proposal_revision_hash,
           source_snapshot_revision_id, snapshot_revision_id, snapshot_hash,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `promotion-${input.projectId}`,
        input.projectId,
        runId,
        `topic-${input.projectId}`,
        `technical-gate-${input.projectId}`,
        technicalBaselineId,
        technicalBaselineHash,
        `proposal-${input.projectId}`,
        "b".repeat(64),
        snapshotRevisionId,
        snapshotRevisionId,
        snapshotHash,
        now,
      );
    const insertNode = raw.prepare(
      `INSERT INTO node_runs(
         id, run_id, pipeline_node_id, node_type, status, attempt_count,
         required_dependency_ids_json, result_json, failure_code,
         failure_message, created_at, updated_at, handler_kind_id,
         input_schema_hash, output_schema_hash
       ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    );
    nodes.forEach((node) => {
      const handler = defaultNodeHandlerRegistry.resolve(
        node.type,
        node.handlerKindId,
      )!;
      insertNode.run(
        `node-${node.id}`,
        runId,
        node.id,
        node.type,
        node.id === successorNode.id
          ? "queued"
          : input.includeSkippedPackagePredecessor && node.id === "package-a"
            ? "skipped"
            : "ready",
        JSON.stringify(
          node.id === successorNode.id
            ? input.includeSecondPackagePredecessor ||
              input.includeSkippedPackagePredecessor
              ? ["package-a", "package-b"]
              : ["package-a"]
            : [],
        ),
        now,
        now,
        handler.handlerKindId,
        handler.inputSchemaHash,
        handler.outputSchemaHash,
      );
    });
  } finally {
    raw.close();
  }
  return {
    runId,
    snapshotRevisionId,
    technicalBaselineId,
    nodeRunIds: {
      a: "node-package-a",
      b: "node-package-b",
      c: "node-package-c",
    },
  };
};

const setup = (
  executionAdapter?: ExecutionAdapter,
  options?: {
    readonly includeSelfCheckSuccessor?: boolean;
    readonly includeSecondPackagePredecessor?: boolean;
    readonly includeSkippedPackagePredecessor?: boolean;
  },
) => {
  const companyDir = mkdtempSync(join(tmpdir(), "sandcastle-work-packages-"));
  const parallel = createParallelAdapter();
  const database = openCompanyDatabase(companyDir, {
    executionAdapter: executionAdapter ?? parallel.adapter,
  });
  const repositoryA = createRepository("repository-a");
  const repositoryB = createRepository("repository-b");
  const project = database.catalog.createProject({
    name: "Parallel packages",
    goal: "Execute isolated Work Packages",
  });
  database.projectConfiguration.update({
    projectId: project.id,
    expectedRevision: 0,
    name: project.name,
    goal: project.goal,
    sharedContext: "Package C consumes package A evidence.",
    repositoryReferences: [repositoryA.root, repositoryB.root],
  });
  const applications = [
    { id: "application-a", repository: repositoryA.root },
    { id: "application-b", repository: repositoryB.root },
  ];
  for (const application of applications) {
    const registered = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: `register-${application.id}`,
      actor: humanActor,
      consumerId: "work-package-test",
      expectedRevision: 0,
      command: {
        type: "application.register",
        applicationId: application.id,
        projectId: project.id,
        repositoryReference: application.repository,
        applicationKey: application.id,
        ownership: "software-rnd",
        buildCommand: "npm run build",
        testCommand: "npm test",
      },
    });
    assert.equal(registered.status, "succeeded");
  }
  const positionIds = ["package-engineer-a", "package-engineer-b"];
  const raw = new DatabaseSync(database.path);
  try {
    const insertMember = raw.prepare(
      `INSERT INTO ai_members(
         id, department_id, display_name, status, created_at, profile,
         responsibility_metadata_json
       ) VALUES (?, 'software-rnd', ?, 'active', ?, ?, ?)`,
    );
    const insertPosition = raw.prepare(
      `INSERT INTO positions(
         id, department_id, name, responsibility, ai_member_id, sort_order,
         created_at, revision, status, default_agent_id
       ) VALUES (?, 'software-rnd', ?, ?, ?, ?, ?, 0, 'active', 'codex')`,
    );
    positionIds.forEach((positionId, index) => {
      const memberId = `member-${positionId}`;
      const now = `2026-07-27T08:00:0${index}.000Z`;
      insertMember.run(
        memberId,
        `Engineer ${index + 1}`,
        now,
        "Repository-scoped developer",
        '{"focus":"development"}',
      );
      insertPosition.run(
        positionId,
        `Package Engineer ${index + 1}`,
        "Implements one isolated Work Package.",
        memberId,
        20 + index,
        now,
      );
    });
  } finally {
    raw.close();
  }
  const seeded = seedPromotedTechnicalRun(database, {
    projectId: project.id,
    repositoryA: repositoryA.root,
    repositoryB: repositoryB.root,
    positionIds,
    includeSelfCheckSuccessor: options?.includeSelfCheckSuccessor,
    includeSecondPackagePredecessor: options?.includeSecondPackagePredecessor,
    includeSkippedPackagePredecessor: options?.includeSkippedPackagePredecessor,
  });
  return {
    companyDir,
    database,
    parallel,
    project,
    repositoryA,
    repositoryB,
    positionIds,
    ...seeded,
  };
};

const execute = (
  database: ReturnType<typeof openCompanyDatabase>,
  commandId: string,
  expectedRevision: number,
  command: Record<string, unknown>,
): CommandResult<WorkPackageGraphView> =>
  database.commandRegistry.execute({
    schemaVersion: 1,
    commandId,
    actor: runtimeActor,
    consumerId: "work-package-test",
    expectedRevision,
    command: command as never,
  }) as CommandResult<WorkPackageGraphView>;

const packageContracts = (fixture: ReturnType<typeof setup>) => [
  {
    workPackageId: "package-a",
    versionId: "package-a-v1",
    applicationId: "application-a",
    repositoryReference: fixture.repositoryA.root,
    nodeRunId: fixture.nodeRunIds.a,
    dependencies: [],
    manifest: manifest(fixture.positionIds),
  },
  {
    workPackageId: "package-b",
    versionId: "package-b-v1",
    applicationId: "application-b",
    repositoryReference: fixture.repositoryB.root,
    nodeRunId: fixture.nodeRunIds.b,
    dependencies: [],
    manifest: manifest(fixture.positionIds),
  },
  {
    workPackageId: "package-c",
    versionId: "package-c-v1",
    applicationId: "application-a",
    repositoryReference: fixture.repositoryA.root,
    nodeRunId: fixture.nodeRunIds.c,
    dependencies: [
      {
        predecessorWorkPackageId: "package-a",
        kind: "artifact" as const,
      },
    ],
    manifest: manifest(fixture.positionIds),
  },
];

const advancePackageAToSelfCheck = async (
  fixture: ReturnType<typeof setup>,
  commandPrefix: string,
) => {
  const assigned = execute(
    fixture.database,
    `${commandPrefix}-assign-producer`,
    0,
    {
      type: "work-package.assign",
      workPackageId: "package-a",
      baseCommit: fixture.repositoryA.baseCommit,
    },
  );
  assert.equal(assigned.status, "succeeded");
  if (assigned.status !== "succeeded") throw new Error("unreachable");
  const assignment = assigned.value.packages
    .find((entry) => entry.id === "package-a")!
    .versions.at(-1)!
    .assignments.at(-1)!;
  fixture.database.workspaces.executeProvision(assignment.allocationId);
  assert.equal(
    execute(fixture.database, `${commandPrefix}-start-producer`, 1, {
      type: "work-package.start",
      workPackageId: "package-a",
    }).status,
    "succeeded",
  );
  const beforeExecution = fixture.database.pipelineRuntime.inspectRun(
    fixture.runId,
  );
  await fixture.database.pipelineRuntime.executeReady({
    runId: fixture.runId,
    expectedRevision: beforeExecution.run.revision,
  });
  const importedCommit = fixture.database.workspaces
    .inspect(assignment.allocationId)
    .imports.find((entry) => entry.state === "succeeded")!.resultCommit;
  assert.equal(
    execute(fixture.database, `${commandPrefix}-self-check-producer`, 3, {
      type: "work-package.self-check",
      workPackageId: "package-a",
      status: "passed",
      commands: ["npm test"],
      logRefs: ["log:package-a"],
      commitEvidence: [importedCommit],
      summary: "Producer self-check passed.",
    }).status,
    "succeeded",
  );
  return { assignment, importedCommit };
};

describe("Work Package Runtime", () => {
  it("rejects non-producer order and Application/Repository mismatches before generation", () => {
    const fixture = setup();
    try {
      const contracts = packageContracts(fixture);
      const wrongOrder = execute(fixture.database, "generate-wrong-order", 0, {
        type: "work-package.generate",
        runId: fixture.runId,
        technicalBaselineId: fixture.technicalBaselineId,
        packages: [contracts[2], contracts[0], contracts[1]],
      });
      assert.equal(wrongOrder.status, "rejected");
      if (wrongOrder.status === "rejected") {
        assert.equal(
          wrongOrder.error.code,
          "WORK_PACKAGE_PRODUCER_ORDER_INVALID",
        );
      }

      const duplicateNode = execute(
        fixture.database,
        "generate-duplicate-node",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            { ...contracts[1], nodeRunId: contracts[0]!.nodeRunId },
          ],
        },
      );
      assert.equal(duplicateNode.status, "rejected");
      if (duplicateNode.status === "rejected") {
        assert.equal(duplicateNode.error.code, "WORK_PACKAGE_NODE_DUPLICATE");
      }

      const ownershipMismatch = execute(
        fixture.database,
        "generate-ownership-mismatch",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            {
              ...contracts[0],
              repositoryReference: fixture.repositoryB.root,
            },
          ],
        },
      );
      assert.equal(ownershipMismatch.status, "rejected");
      if (ownershipMismatch.status === "rejected") {
        assert.equal(
          ownershipMismatch.error.code,
          "WORK_PACKAGE_APPLICATION_REPOSITORY_MISMATCH",
        );
      }
      const contractWithoutId = execute(
        fixture.database,
        "generate-contract-without-id",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "contract",
                },
              ],
            },
          ],
        },
      );
      assert.equal(contractWithoutId.status, "rejected");
      if (contractWithoutId.status === "rejected") {
        assert.equal(
          contractWithoutId.error.code,
          "WORK_PACKAGE_CONTRACT_ID_REQUIRED",
        );
      }
      const contractWithoutVersion = execute(
        fixture.database,
        "generate-contract-without-version",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "contract",
                  contractId: "checkout-api",
                },
              ],
            },
          ],
        },
      );
      assert.equal(contractWithoutVersion.status, "rejected");
      if (contractWithoutVersion.status === "rejected") {
        assert.equal(
          contractWithoutVersion.error.code,
          "WORK_PACKAGE_CONTRACT_VERSION_REQUIRED",
        );
      }
      const undeclaredManualGate = execute(
        fixture.database,
        "generate-undeclared-manual-gate",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "manual",
                  evidenceRef: fixture.nodeRunIds.a,
                },
              ],
            },
          ],
        },
      );
      assert.equal(undeclaredManualGate.status, "rejected");
      if (undeclaredManualGate.status === "rejected") {
        assert.equal(
          undeclaredManualGate.error.code,
          "WORK_PACKAGE_MANUAL_GATE_UNDECLARED",
        );
      }
      const readinessWithoutEvidence = execute(
        fixture.database,
        "generate-readiness-without-evidence",
        0,
        {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "readiness",
                },
              ],
            },
          ],
        },
      );
      assert.equal(readinessWithoutEvidence.status, "rejected");
      if (readinessWithoutEvidence.status === "rejected") {
        assert.equal(
          readinessWithoutEvidence.error.code,
          "WORK_PACKAGE_DEPENDENCY_EVIDENCE_REQUIRED",
        );
      }
      assert.equal(
        fixture.database.workPackages.inspect(fixture.runId).packages.length,
        0,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a new Version that introduces a reverse producer dependency", () => {
    const fixture = setup();
    try {
      const generated = execute(fixture.database, "generate-for-version", 0, {
        type: "work-package.generate",
        runId: fixture.runId,
        technicalBaselineId: fixture.technicalBaselineId,
        packages: packageContracts(fixture),
      });
      assert.equal(generated.status, "succeeded");

      const reversed = execute(fixture.database, "version-package-a", 0, {
        type: "work-package.version",
        workPackageId: "package-a",
        versionId: "package-a-v2",
        dependencies: [
          {
            predecessorWorkPackageVersionId: "package-c-v1",
            kind: "artifact",
          },
        ],
        manifest: manifest(fixture.positionIds),
      });

      assert.equal(reversed.status, "rejected");
      if (reversed.status === "rejected") {
        assert.equal(
          reversed.error.code,
          "WORK_PACKAGE_PRODUCER_ORDER_INVALID",
        );
      }
      const packageA = fixture.database.workPackages
        .inspect(fixture.runId)
        .packages.find((entry) => entry.id === "package-a")!;
      assert.equal(packageA.revision, 0);
      assert.equal(packageA.versions.length, 1);
    } finally {
      fixture.database.close();
    }
  });

  it("versions by Work Package graph reachability instead of Pipeline node array order", () => {
    const fixture = setup();
    try {
      assert.equal(
        execute(fixture.database, "generate-for-reachability", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: packageContracts(fixture),
        }).status,
        "succeeded",
      );
      const versioned = execute(
        fixture.database,
        "version-package-a-with-later-node-producer",
        0,
        {
          type: "work-package.version",
          workPackageId: "package-a",
          versionId: "package-a-v2",
          dependencies: [
            {
              predecessorWorkPackageVersionId: "package-b-v1",
              kind: "commit",
            },
          ],
          manifest: manifest(fixture.positionIds),
        },
      );
      assert.equal(versioned.status, "succeeded");
    } finally {
      fixture.database.close();
    }
  });

  it("does not supersede a Version while its package is assigned", () => {
    const fixture = setup();
    try {
      assert.equal(
        execute(fixture.database, "generate-assigned-version", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      assert.equal(
        execute(fixture.database, "assign-before-version", 0, {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        }).status,
        "succeeded",
      );

      const versioned = execute(fixture.database, "version-while-assigned", 1, {
        type: "work-package.version",
        workPackageId: "package-a",
        versionId: "package-a-v2",
        dependencies: [],
        manifest: manifest(fixture.positionIds),
      });

      assert.equal(versioned.status, "rejected");
      if (versioned.status === "rejected") {
        assert.equal(versioned.error.code, "WORK_PACKAGE_STATE_INVALID");
      }
      const assignment = fixture.database.workPackages.inspect(fixture.runId)
        .packages[0]!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(fixture.database, "start-before-version", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const runningVersion = execute(
        fixture.database,
        "version-while-running",
        2,
        {
          type: "work-package.version",
          workPackageId: "package-a",
          versionId: "package-a-v2-running",
          dependencies: [],
          manifest: manifest(fixture.positionIds),
        },
      );
      assert.equal(runningVersion.status, "rejected");
      if (runningVersion.status === "rejected") {
        assert.equal(runningVersion.error.code, "WORK_PACKAGE_STATE_INVALID");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("blocks the Work Package and Run when its isolated allocation fails", () => {
    const fixture = setup();
    try {
      assert.equal(
        execute(fixture.database, "generate-blocked-package", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const assigned = execute(fixture.database, "assign-blocked-package", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const allocationId =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!.allocationId;
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `UPDATE workspace_allocations
                SET state = 'failed', failure_code = 'INPUT_DRIFT',
                    failure_message = 'The expected source tip changed.'
              WHERE id = ?`,
          )
          .run(allocationId);
      } finally {
        raw.close();
      }

      const started = execute(fixture.database, "start-blocked-package", 1, {
        type: "work-package.start",
        workPackageId: "package-a",
      });
      assert.equal(started.status, "succeeded");
      if (started.status !== "succeeded") throw new Error("unreachable");
      assert.equal(started.value.packages[0]!.state, "blocked");
      assert.equal(
        fixture.database.pipelineRuntime.inspectRun(fixture.runId).run.status,
        "blocked",
      );
      const eventDatabase = new DatabaseSync(fixture.database.path);
      try {
        const events = eventDatabase
          .prepare(
            `SELECT type FROM runtime_event_outbox
              WHERE type IN ('run.blocked', 'work-package.blocked')
           ORDER BY sequence`,
          )
          .all() as Array<{ readonly type: string }>;
        assert.deepEqual(
          events.map((event) => event.type),
          ["run.blocked", "work-package.blocked"],
        );
      } finally {
        eventDatabase.close();
      }
    } finally {
      fixture.database.close();
    }
  });

  it("unlocks a commit dependency only after the Runtime imports the producer commit", async () => {
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (input) => {
        const workPackage =
          input.request?.sideEffectPolicy === "formal"
            ? input.request.immutableContext.workPackage
            : undefined;
        if (!workPackage) {
          return { kind: "succeeded", structuredResult: {} };
        }
        writeFileSync(
          join(workPackage.executionTreePath, `${workPackage.id}.txt`),
          "commit dependency evidence\n",
        );
        git(workPackage.executionTreePath, "add", `${workPackage.id}.txt`);
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          `implement ${workPackage.id}`,
        );
        return {
          kind: "succeeded",
          structuredResult: {
            commits: [
              {
                sha: git(workPackage.executionTreePath, "rev-parse", "HEAD"),
              },
            ],
          },
        };
      },
    };
    const fixture = setup(adapter);
    try {
      const contracts = packageContracts(fixture);
      assert.equal(
        execute(fixture.database, "generate-commit-dependency", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "commit",
                },
              ],
            },
          ],
        }).status,
        "succeeded",
      );
      const assignedA = execute(fixture.database, "assign-commit-producer", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assignedA.status, "succeeded");
      if (assignedA.status !== "succeeded") throw new Error("unreachable");
      const allocationId =
        assignedA.value.packages[0]!.versions[0]!.assignments[0]!.allocationId;
      fixture.database.workspaces.executeProvision(allocationId);
      assert.equal(
        execute(fixture.database, "start-commit-producer", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const beforeExecution = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: beforeExecution.run.revision,
      });
      const imported = fixture.database.workspaces
        .inspect(allocationId)
        .imports.some((entry) => entry.state === "succeeded");
      assert.equal(imported, true);
      assert.equal(
        execute(fixture.database, "assign-commit-consumer", 0, {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        }).status,
        "succeeded",
      );
      const reassignedFromSelfCheck = execute(
        fixture.database,
        "assign-commit-producer-from-self-check",
        3,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(reassignedFromSelfCheck.status, "rejected");
      if (reassignedFromSelfCheck.status === "rejected") {
        assert.equal(
          reassignedFromSelfCheck.error.code,
          "WORK_PACKAGE_STATE_INVALID",
        );
      }
    } finally {
      fixture.database.close();
    }
  });

  it("binds Artifact dependencies to an Attempt assigned to the exact predecessor Version", async () => {
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (input) => {
        const workPackage =
          input.request?.sideEffectPolicy === "formal"
            ? input.request.immutableContext.workPackage
            : undefined;
        if (!workPackage) {
          return { kind: "succeeded", structuredResult: {} };
        }
        writeFileSync(
          join(workPackage.executionTreePath, "artifact-source.txt"),
          "artifact source\n",
        );
        git(workPackage.executionTreePath, "add", "artifact-source.txt");
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          "produce artifact source",
        );
        return {
          kind: "succeeded",
          structuredResult: {
            commits: [
              {
                sha: git(workPackage.executionTreePath, "rev-parse", "HEAD"),
              },
            ],
          },
        };
      },
    };
    const fixture = setup(adapter);
    try {
      const contracts = packageContracts(fixture);
      assert.equal(
        execute(fixture.database, "generate-exact-artifact", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            {
              ...contracts[0],
              manifest: {
                ...contracts[0]!.manifest,
                expectedArtifacts: ["implementation-report"],
              },
            },
            contracts[2],
          ],
        }).status,
        "succeeded",
      );
      const assigned = execute(
        fixture.database,
        "assign-exact-artifact-producer",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(fixture.database, "start-exact-artifact-producer", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const beforeExecution = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: beforeExecution.run.revision,
      });
      const importedCommit = fixture.database.workspaces
        .inspect(assignment.allocationId)
        .imports.find((entry) => entry.state === "succeeded")!.resultCommit;
      assert.equal(
        execute(fixture.database, "self-check-exact-artifact-producer", 3, {
          type: "work-package.self-check",
          workPackageId: "package-a",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-a"],
          commitEvidence: [importedCommit],
          summary: "Producer self-check passed.",
        }).status,
        "succeeded",
      );

      const rogueAttemptId = "rogue-package-a-attempt";
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `INSERT INTO node_attempts(
               id, node_run_id, attempt_number, snapshot_revision_id, reason,
               status, created_at, completed_at
             ) VALUES (?, ?, 2, ?, 'retry', 'succeeded', ?, ?)`,
          )
          .run(
            rogueAttemptId,
            fixture.nodeRunIds.a,
            fixture.snapshotRevisionId,
            "2026-07-27T09:00:00.000Z",
            "2026-07-27T09:00:00.000Z",
          );
      } finally {
        raw.close();
      }
      fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.project.id,
        type: "implementation-report",
        schemaVersion: "1",
        logicalName: "rogue-same-node-report",
        content: "not produced by the assigned Work Package Attempt",
        status: "produced",
        producer: {
          runId: fixture.runId,
          nodeRunId: fixture.nodeRunIds.a,
          nodeAttemptId: rogueAttemptId,
          snapshotRevisionId: fixture.snapshotRevisionId,
          aiMemberId: assignment.aiMemberId,
        },
      });
      const blocked = execute(
        fixture.database,
        "assign-consumer-with-rogue-artifact",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(blocked.status, "rejected");
      if (blocked.status === "rejected") {
        assert.equal(blocked.error.code, "WORK_PACKAGE_DEPENDENCY_BLOCKED");
      }

      fixture.database.artifactRegistry.registerVersion({
        projectId: fixture.project.id,
        type: "implementation-report",
        schemaVersion: "1",
        logicalName: "assigned-attempt-report",
        content: "produced by the assigned Work Package Attempt",
        status: "produced",
        producer: {
          runId: fixture.runId,
          nodeRunId: fixture.nodeRunIds.a,
          nodeAttemptId: assignment.nodeAttemptId,
          snapshotRevisionId: fixture.snapshotRevisionId,
          aiMemberId: assignment.aiMemberId,
          positionId: assignment.positionId,
          sessionId: assignment.interactionSessionId,
          workPackageId: "package-a",
        },
      });
      assert.equal(
        execute(fixture.database, "assign-consumer-with-exact-artifact", 0, {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        }).status,
        "succeeded",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("does not satisfy a pinned Artifact dependency with only the predecessor source commit", async () => {
    const fixture = setup();
    try {
      const contracts = packageContracts(fixture);
      assert.equal(
        execute(fixture.database, "generate-pinned-artifact", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "artifact",
                  evidenceRef: "artifact-version-required",
                },
              ],
            },
          ],
        }).status,
        "succeeded",
      );
      await advancePackageAToSelfCheck(fixture, "pinned-artifact");

      const blocked = execute(
        fixture.database,
        "assign-pinned-artifact-consumer",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(blocked.status, "rejected");
      if (blocked.status === "rejected") {
        assert.equal(blocked.error.code, "WORK_PACKAGE_DEPENDENCY_BLOCKED");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("requires the exact compatible Contract version frozen by the dependency edge", async () => {
    const fixture = setup();
    try {
      const raw = new DatabaseSync(fixture.database.path);
      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        const insertContract = raw.prepare(
          `INSERT INTO cross_application_contract_revisions(
             proposal_revision_id, contract_id, version,
             producer_application_id, consumer_application_id, kind,
             schema_text, compatibility_policy, compatibility,
             evidence_refs_json, test_commands_json, content_hash, created_at
           ) VALUES (?, 'checkout-api', ?, 'application-a', 'application-b',
                     'api', '{}', 'exact', ?, '[]', '[]', ?, ?)`,
        );
        insertContract.run(
          `proposal-${fixture.project.id}`,
          "1",
          "incompatible",
          "c".repeat(64),
          "2026-07-27T08:10:00.000Z",
        );
        insertContract.run(
          `proposal-${fixture.project.id}`,
          "2",
          "compatible",
          "d".repeat(64),
          "2026-07-27T08:11:00.000Z",
        );
      } finally {
        raw.close();
      }
      const contracts = packageContracts(fixture);
      assert.equal(
        execute(fixture.database, "generate-exact-contract", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [
            contracts[0],
            {
              ...contracts[2],
              dependencies: [
                {
                  predecessorWorkPackageId: "package-a",
                  kind: "contract",
                  contractId: "checkout-api",
                  contractVersion: "1",
                },
              ],
            },
          ],
        }).status,
        "succeeded",
      );
      await advancePackageAToSelfCheck(fixture, "exact-contract");

      const graph = fixture.database.workPackages.inspect(fixture.runId);
      assert.equal(
        graph.packages
          .find((entry) => entry.id === "package-c")!
          .versions.at(-1)!.dependencies[0]!.contractVersion,
        "1",
      );
      const blocked = execute(
        fixture.database,
        "assign-exact-contract-consumer",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(blocked.status, "rejected");
      if (blocked.status === "rejected") {
        assert.equal(blocked.error.code, "WORK_PACKAGE_DEPENDENCY_BLOCKED");
      }
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a formal execution Permission outside the Work Package allowlist", async () => {
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (_input, sink) => {
        assert.ok(sink);
        await sink.record({
          adapterSchemaVersion: 1,
          factId: "permission-outside-package",
          ordinal: 1,
          kind: "permission-request",
          schemaVersion: 1,
          payload: { scope: "process.spawn" },
          evidenceRefs: [],
        });
        return {
          kind: "failed",
          code: "PERMISSION_TEST_DID_NOT_REJECT",
          message: "Permission Fact unexpectedly passed the Work Package gate.",
        };
      },
    };
    const fixture = setup(adapter);
    try {
      assert.equal(
        execute(fixture.database, "generate-permission-package", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const assigned = execute(
        fixture.database,
        "assign-permission-package",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const allocationId =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!.allocationId;
      fixture.database.workspaces.executeProvision(allocationId);
      assert.equal(
        execute(fixture.database, "start-permission-package", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const beforeExecution = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await assert.rejects(
        () =>
          fixture.database.pipelineRuntime.executeReady({
            runId: fixture.runId,
            expectedRevision: beforeExecution.run.revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "WORK_PACKAGE_PERMISSION_DENIED",
      );
      assert.equal(
        fixture.database.workPackages.inspect(fixture.runId).packages[0]!.state,
        "failed",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("blocks after import tip drift without rewriting the succeeded Attempt", async () => {
    let repositoryRoot = "";
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (input) => {
        const workPackage =
          input.request?.sideEffectPolicy === "formal"
            ? input.request.immutableContext.workPackage
            : undefined;
        assert.ok(workPackage);
        writeFileSync(
          join(workPackage.executionTreePath, "result.txt"),
          "isolated result\n",
        );
        git(workPackage.executionTreePath, "add", "result.txt");
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          "produce isolated result",
        );
        const resultCommit = git(
          workPackage.executionTreePath,
          "rev-parse",
          "HEAD",
        );
        writeFileSync(join(repositoryRoot, "drift.txt"), "runtime drift\n");
        git(repositoryRoot, "add", "drift.txt");
        git(repositoryRoot, "commit", "-m", "advance source tip");
        git(
          repositoryRoot,
          "update-ref",
          `refs/heads/${workPackage.sourceBranch}`,
          git(repositoryRoot, "rev-parse", "HEAD"),
        );
        return {
          kind: "succeeded",
          structuredResult: { commits: [{ sha: resultCommit }] },
        };
      },
    };
    const fixture = setup(adapter);
    repositoryRoot = fixture.repositoryA.root;
    try {
      assert.equal(
        execute(fixture.database, "generate-drift-package", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const assigned = execute(fixture.database, "assign-drift-package", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(fixture.database, "start-drift-package", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const beforeExecution = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      const blocked = await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: beforeExecution.run.revision,
      });
      assert.equal(blocked.run.status, "blocked");
      const attempt = blocked.nodes
        .find((node) => node.id === fixture.nodeRunIds.a)!
        .attempts.find((entry) => entry.id === assignment.nodeAttemptId)!;
      assert.equal(attempt.status, "succeeded");
      const failedPackage = fixture.database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(failedPackage.state, "failed");
      assert.equal(
        failedPackage.versions[0]!.assignments[0]!.allocation.imports[0]!.state,
        "failed",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("reconciles a post-terminal import failure after restart before projecting self-check", async () => {
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (input) => {
        const workPackage =
          input.request?.sideEffectPolicy === "formal"
            ? input.request.immutableContext.workPackage
            : undefined;
        assert.ok(workPackage);
        writeFileSync(
          join(workPackage.executionTreePath, "restart-result.txt"),
          "restart result\n",
        );
        git(workPackage.executionTreePath, "add", "restart-result.txt");
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          "produce restart result",
        );
        return {
          kind: "succeeded",
          structuredResult: {
            commits: [
              {
                sha: git(workPackage.executionTreePath, "rev-parse", "HEAD"),
              },
            ],
          },
        };
      },
    };
    const fixture = setup(adapter);
    let database = fixture.database;
    try {
      assert.equal(
        execute(database, "generate-restart-import", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const assigned = execute(database, "assign-restart-import", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!;
      database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(database, "start-restart-import", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const mutableWorkspaces = database.workspaces as unknown as {
        executeImport: typeof database.workspaces.executeImport;
      };
      mutableWorkspaces.executeImport = () => {
        throw new Error("simulated crash after terminal transaction");
      };
      const beforeExecution = database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: fixture.runId,
            expectedRevision: beforeExecution.run.revision,
          }),
        /simulated crash/,
      );
      const beforeRestart = database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(beforeRestart.state, "running");
      assert.equal(beforeRestart.versions[0]!.assignments[0]!.state, "running");
      writeFileSync(
        join(fixture.repositoryA.root, "restart-drift.txt"),
        "advance import destination\n",
      );
      git(fixture.repositoryA.root, "add", "restart-drift.txt");
      git(fixture.repositoryA.root, "commit", "-m", "advance import tip");
      git(
        fixture.repositoryA.root,
        "update-ref",
        `refs/heads/${assignment.allocation.sourceBranch}`,
        git(fixture.repositoryA.root, "rev-parse", "HEAD"),
      );
      database.close();
      database = openCompanyDatabase(fixture.companyDir, {
        executionAdapter: adapter,
      });
      const afterRestart = database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(afterRestart.state, "failed");
      assert.equal(
        afterRestart.versions[0]!.assignments[0]!.allocation.imports[0]!.state,
        "failed",
      );
      const run = database.pipelineRuntime.inspectRun(fixture.runId);
      assert.equal(run.run.status, "blocked");
      assert.equal(
        run.nodes.find((node) => node.id === fixture.nodeRunIds.a)!.attempts[0]!
          .status,
        "succeeded",
      );
    } finally {
      database.close();
    }
  });

  it("projects self-check only after restart reconciliation imports the exact commit", async () => {
    const adapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async (input) => {
        const workPackage =
          input.request?.sideEffectPolicy === "formal"
            ? input.request.immutableContext.workPackage
            : undefined;
        if (!workPackage) {
          return { kind: "succeeded", structuredResult: {} };
        }
        writeFileSync(
          join(workPackage.executionTreePath, "restart-success.txt"),
          "restart success\n",
        );
        git(workPackage.executionTreePath, "add", "restart-success.txt");
        git(
          workPackage.executionTreePath,
          "-c",
          "user.name=Work Package Test",
          "-c",
          "user.email=work-package@sandcastle.invalid",
          "commit",
          "-m",
          "produce restart success",
        );
        return {
          kind: "succeeded",
          structuredResult: {
            commits: [
              {
                sha: git(workPackage.executionTreePath, "rev-parse", "HEAD"),
              },
            ],
          },
        };
      },
    };
    const fixture = setup(adapter);
    let database = fixture.database;
    try {
      assert.equal(
        execute(database, "generate-restart-import-success", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const assigned = execute(database, "assign-restart-import-success", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment =
        assigned.value.packages[0]!.versions[0]!.assignments[0]!;
      database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(database, "start-restart-import-success", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const mutableWorkspaces = database.workspaces as unknown as {
        executeImport: typeof database.workspaces.executeImport;
      };
      mutableWorkspaces.executeImport = () => {
        throw new Error("simulated crash before successful import");
      };
      const beforeExecution = database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await assert.rejects(
        () =>
          database.pipelineRuntime.executeReady({
            runId: fixture.runId,
            expectedRevision: beforeExecution.run.revision,
          }),
        /simulated crash/,
      );
      assert.equal(
        database.workPackages.inspect(fixture.runId).packages[0]!.state,
        "running",
      );
      database.close();
      database = openCompanyDatabase(fixture.companyDir, {
        executionAdapter: adapter,
      });
      const afterRestart = database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(afterRestart.state, "self-check");
      assert.equal(
        afterRestart.versions[0]!.assignments[0]!.state,
        "awaiting-self-check",
      );
      assert.equal(
        afterRestart.versions[0]!.assignments[0]!.allocation.imports[0]!.state,
        "succeeded",
      );
      assert.equal(
        database.pipelineRuntime.inspectRun(fixture.runId).run.status,
        "running",
      );
    } finally {
      database.close();
    }
  });

  it("retries the same Version with a fresh Attempt branch and resources", async () => {
    const failingAdapter: ExecutionAdapter = {
      capabilities: {
        reattachRunningOperation: false,
        strongExecutionFence: true,
        enforceNoSideEffects: false,
      },
      execute: async () => ({
        kind: "failed",
        code: "TEST_RETRY_REQUIRED",
        message: "Force a retry of the same Work Package Version.",
      }),
    };
    const fixture = setup(failingAdapter);
    try {
      assert.equal(
        execute(fixture.database, "generate-retry-package", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: [packageContracts(fixture)[0]],
        }).status,
        "succeeded",
      );
      const firstAssignmentResult = execute(
        fixture.database,
        "assign-retry-package-first",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(firstAssignmentResult.status, "succeeded");
      if (firstAssignmentResult.status !== "succeeded") {
        throw new Error("unreachable");
      }
      const firstAssignment =
        firstAssignmentResult.value.packages[0]!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(
        firstAssignment.allocationId,
      );
      assert.equal(
        execute(fixture.database, "start-retry-package-first", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      const beforeFailure = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: beforeFailure.run.revision,
      });
      const failedPackage = fixture.database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(failedPackage.state, "failed");

      const retried = execute(
        fixture.database,
        "assign-retry-package-second",
        failedPackage.revision,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(retried.status, "succeeded");
      if (retried.status !== "succeeded") throw new Error("unreachable");
      const assignments = retried.value.packages[0]!.versions[0]!.assignments;
      const secondAssignment = assignments[assignments.length - 1]!;
      assert.equal(
        fixture.database.pipelineRuntime.inspectRun(fixture.runId).run.status,
        "running",
      );
      assert.equal(
        fixture.database.pipelineRuntime
          .runtimeEvents({ afterSequence: 0, limit: 1_000 })
          .some((event) => event.type === "run.resumed"),
        true,
      );
      assert.equal(secondAssignment.positionId, firstAssignment.positionId);
      assert.notEqual(
        firstAssignment.nodeAttemptId,
        secondAssignment.nodeAttemptId,
      );
      assert.notEqual(
        firstAssignment.allocationId,
        secondAssignment.allocationId,
      );
      assert.notEqual(
        firstAssignment.interactionSessionId,
        secondAssignment.interactionSessionId,
      );
      assert.notEqual(
        firstAssignment.sandboxIdentity,
        secondAssignment.sandboxIdentity,
      );
      assert.notEqual(
        firstAssignment.evidenceScope,
        secondAssignment.evidenceScope,
      );
      assert.notEqual(
        firstAssignment.allocation.sourceBranch,
        secondAssignment.allocation.sourceBranch,
      );
      assert.notEqual(
        firstAssignment.allocation.operationKey,
        secondAssignment.allocation.operationKey,
      );
      const retryAttempt = fixture.database.pipelineRuntime
        .inspectRun(fixture.runId)
        .nodes.find((node) => node.id === fixture.nodeRunIds.a)!
        .attempts.find(
          (attempt) => attempt.id === secondAssignment.nodeAttemptId,
        )!;
      assert.equal(retryAttempt.reason, "retry");
      fixture.database.workspaces.executeProvision(
        secondAssignment.allocationId,
      );
      const retryPackage = fixture.database.workPackages.inspect(fixture.runId)
        .packages[0]!;
      assert.equal(
        execute(
          fixture.database,
          "start-retry-package-second",
          retryPackage.revision,
          {
            type: "work-package.start",
            workPackageId: "package-a",
          },
        ).status,
        "succeeded",
      );
      const beforeRetryExecution = fixture.database.pipelineRuntime.inspectRun(
        fixture.runId,
      );
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: beforeRetryExecution.run.revision,
      });
      assert.equal(
        fixture.database.pipelineRuntime.inspectRun(fixture.runId).run.status,
        "failed",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("keeps Pipeline successors queued until the exact Work Package Assignment passes Developer self-check", async () => {
    const fixture = setup(createParallelAdapter(1).adapter, {
      includeSelfCheckSuccessor: true,
    });
    try {
      assert.equal(
        execute(fixture.database, "generate-self-check-gate", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: packageContracts(fixture),
        }).status,
        "succeeded",
      );
      const assigned = execute(fixture.database, "assign-self-check-gate", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment = assigned.value.packages.find(
        (entry) => entry.id === "package-a",
      )!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(fixture.database, "start-self-check-gate", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );

      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: 0,
      });
      let run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      assert.equal(
        run.nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "queued",
      );
      const importedCommit = fixture.database.workspaces
        .inspect(assignment.allocationId)
        .imports.find((entry) => entry.state === "succeeded")!.resultCommit;

      assert.equal(
        execute(fixture.database, "pass-self-check-gate", 3, {
          type: "work-package.self-check",
          workPackageId: "package-a",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-a"],
          commitEvidence: [importedCommit],
          summary: "Developer self-check passed before successor release.",
        }).status,
        "succeeded",
      );
      run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      assert.equal(
        run.nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "ready",
      );

      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: run.run.revision,
      });
      assert.equal(
        fixture.database.pipelineRuntime
          .inspectRun(fixture.runId)
          .nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "succeeded",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("lets a skipped package branch satisfy a Join while a succeeded package still waits for self-check", async () => {
    const fixture = setup(createParallelAdapter(1).adapter, {
      includeSelfCheckSuccessor: true,
      includeSkippedPackagePredecessor: true,
    });
    try {
      assert.equal(
        execute(fixture.database, "generate-skipped-package-join", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: packageContracts(fixture),
        }).status,
        "succeeded",
      );
      const assigned = execute(
        fixture.database,
        "assign-skipped-package-join",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-b",
          baseCommit: fixture.repositoryB.baseCommit,
        },
      );
      assert.equal(assigned.status, "succeeded");
      if (assigned.status !== "succeeded") throw new Error("unreachable");
      const assignment = assigned.value.packages.find(
        (entry) => entry.id === "package-b",
      )!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(assignment.allocationId);
      assert.equal(
        execute(fixture.database, "start-skipped-package-join", 1, {
          type: "work-package.start",
          workPackageId: "package-b",
        }).status,
        "succeeded",
      );

      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: 0,
      });
      let run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      assert.equal(
        run.nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "queued",
      );
      const importedCommit = fixture.database.workspaces
        .inspect(assignment.allocationId)
        .imports.find((entry) => entry.state === "succeeded")!.resultCommit;

      assert.equal(
        execute(fixture.database, "pass-skipped-package-join", 3, {
          type: "work-package.self-check",
          workPackageId: "package-b",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-b"],
          commitEvidence: [importedCommit],
          summary: "Selected branch self-check passed.",
        }).status,
        "succeeded",
      );
      run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      assert.equal(
        run.nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "ready",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("ignores a superseded Assignment when gating the current Work Package Version", async () => {
    const fixture = setup(createParallelAdapter(1).adapter, {
      includeSelfCheckSuccessor: true,
      includeSecondPackagePredecessor: true,
    });
    try {
      assert.equal(
        execute(fixture.database, "generate-current-version-gate", 0, {
          type: "work-package.generate",
          runId: fixture.runId,
          technicalBaselineId: fixture.technicalBaselineId,
          packages: packageContracts(fixture),
        }).status,
        "succeeded",
      );
      const assignedA = execute(
        fixture.database,
        "assign-current-version-a",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-a",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      const assignedB = execute(
        fixture.database,
        "assign-current-version-b",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-b",
          baseCommit: fixture.repositoryB.baseCommit,
        },
      );
      assert.equal(assignedA.status, "succeeded");
      assert.equal(assignedB.status, "succeeded");
      if (
        assignedA.status !== "succeeded" ||
        assignedB.status !== "succeeded"
      ) {
        throw new Error("unreachable");
      }
      const firstAssignmentA = assignedA.value.packages.find(
        (entry) => entry.id === "package-a",
      )!.versions[0]!.assignments[0]!;
      const assignmentB = assignedB.value.packages.find(
        (entry) => entry.id === "package-b",
      )!.versions[0]!.assignments[0]!;
      fixture.database.workspaces.executeProvision(
        firstAssignmentA.allocationId,
      );
      fixture.database.workspaces.executeProvision(assignmentB.allocationId);
      assert.equal(
        execute(fixture.database, "start-current-version-a-v1", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: 0,
      });
      const importedA1 = fixture.database.workspaces
        .inspect(firstAssignmentA.allocationId)
        .imports.find((entry) => entry.state === "succeeded")!.resultCommit;
      assert.equal(
        execute(fixture.database, "pass-current-version-a-v1", 3, {
          type: "work-package.self-check",
          workPackageId: "package-a",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-a-v1"],
          commitEvidence: [importedA1],
          summary: "Version one passed before rework.",
        }).status,
        "succeeded",
      );
      assert.equal(
        fixture.database.pipelineRuntime
          .inspectRun(fixture.runId)
          .nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "queued",
      );

      const reworked = execute(
        fixture.database,
        "rework-current-version-a",
        4,
        {
          type: "work-package.rework",
          workPackageId: "package-a",
          versionId: "package-a-v2",
          baseCommit: fixture.repositoryA.baseCommit,
          recoveryReason: "Exercise current Version successor gating.",
        },
      );
      assert.equal(reworked.status, "succeeded");
      if (reworked.status !== "succeeded") throw new Error("unreachable");
      const reworkedA = reworked.value.packages.find(
        (entry) => entry.id === "package-a",
      )!;
      const currentAssignmentA = reworkedA.versions.at(-1)!.assignments[0]!;
      const raw = new DatabaseSync(fixture.database.path);
      try {
        raw
          .prepare(
            `UPDATE work_package_assignments
                SET state = 'self-check-passed'
              WHERE id = ?`,
          )
          .run(firstAssignmentA.id);
      } finally {
        raw.close();
      }
      fixture.database.workspaces.executeProvision(
        currentAssignmentA.allocationId,
      );
      assert.equal(
        execute(
          fixture.database,
          "start-current-version-a-v2",
          reworkedA.revision,
          {
            type: "work-package.start",
            workPackageId: "package-a",
          },
        ).status,
        "succeeded",
      );
      let run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: run.run.revision,
      });
      assert.equal(
        fixture.database.workPackages
          .inspect(fixture.runId)
          .packages.find((entry) => entry.id === "package-a")!
          .versions.at(-1)!.assignments[0]!.state,
        "awaiting-self-check",
      );

      assert.equal(
        execute(fixture.database, "start-current-version-b", 1, {
          type: "work-package.start",
          workPackageId: "package-b",
        }).status,
        "succeeded",
      );
      run = fixture.database.pipelineRuntime.inspectRun(fixture.runId);
      await fixture.database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: run.run.revision,
      });
      const importedB = fixture.database.workspaces
        .inspect(assignmentB.allocationId)
        .imports.find((entry) => entry.state === "succeeded")!.resultCommit;
      assert.equal(
        execute(fixture.database, "pass-current-version-b", 3, {
          type: "work-package.self-check",
          workPackageId: "package-b",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-b"],
          commitEvidence: [importedB],
          summary: "Second predecessor passed.",
        }).status,
        "succeeded",
      );
      assert.equal(
        fixture.database.pipelineRuntime
          .inspectRun(fixture.runId)
          .nodes.find((node) => node.pipelineNodeId === "after-package-a")
          ?.status,
        "queued",
      );
    } finally {
      fixture.database.close();
    }
  });

  it("assigns unique isolated Attempts, schedules independent packages in parallel, gates dependencies, and reworks with fresh resources", async () => {
    const fixture = setup();
    let database = fixture.database;
    try {
      const generated = execute(database, "generate-packages", 0, {
        type: "work-package.generate",
        runId: fixture.runId,
        technicalBaselineId: fixture.technicalBaselineId,
        packages: packageContracts(fixture),
      });
      assert.equal(generated.status, "succeeded");
      if (generated.status !== "succeeded") throw new Error("unreachable");
      assert.equal(generated.value.packages.length, 3);
      assert.deepEqual(
        generated.value.packages.map(
          (entry) => entry.versions[0]!.manifest.execution,
        ),
        Array.from({ length: 3 }, () => ({
          profileId: "software-rnd-local-isolated-git",
          branchStrategy: "branch",
          gitRefWriteIsolation: true,
          runtimeImportOnly: true,
        })),
      );

      const dependentBlocked = execute(
        database,
        "assign-package-c-blocked",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(dependentBlocked.status, "rejected");
      if (dependentBlocked.status === "rejected") {
        assert.equal(
          dependentBlocked.error.code,
          "WORK_PACKAGE_DEPENDENCY_BLOCKED",
        );
      }

      const assignedA = execute(database, "assign-package-a", 0, {
        type: "work-package.assign",
        workPackageId: "package-a",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      const assignedB = execute(database, "assign-package-b", 0, {
        type: "work-package.assign",
        workPackageId: "package-b",
        baseCommit: fixture.repositoryB.baseCommit,
      });
      assert.equal(assignedA.status, "succeeded");
      assert.equal(assignedB.status, "succeeded");
      if (
        assignedA.status !== "succeeded" ||
        assignedB.status !== "succeeded"
      ) {
        throw new Error("unreachable");
      }
      const assignmentA =
        assignedA.value.packages[0]!.versions[0]!.assignments[0]!;
      const packageB = assignedB.value.packages.find(
        (entry) => entry.id === "package-b",
      )!;
      const assignmentB = packageB.versions[0]!.assignments[0]!;
      assert.notEqual(assignmentA.positionId, assignmentB.positionId);
      assert.equal(assignmentA.agentAdapterId, "codex");
      assert.notEqual(assignmentA.nodeAttemptId, assignmentB.nodeAttemptId);
      assert.notEqual(assignmentA.allocationId, assignmentB.allocationId);
      assert.notEqual(
        assignmentA.interactionSessionId,
        assignmentB.interactionSessionId,
      );
      assert.notEqual(assignmentA.sandboxIdentity, assignmentB.sandboxIdentity);
      assert.notEqual(assignmentA.evidenceScope, assignmentB.evidenceScope);
      assert.notEqual(
        assignmentA.allocation.sourceBranch,
        assignmentB.allocation.sourceBranch,
      );
      assert.notEqual(
        assignmentA.allocation.allocationRoot,
        assignmentB.allocation.allocationRoot,
      );

      database.workspaces.executeProvision(assignmentA.allocationId);
      database.workspaces.executeProvision(assignmentB.allocationId);
      const readyGraph = database.workPackages.inspect(fixture.runId);
      const readyA = readyGraph.packages.find(
        (entry) => entry.id === "package-a",
      )!;
      const readyB = readyGraph.packages.find(
        (entry) => entry.id === "package-b",
      )!;
      assert.notEqual(
        readyA.versions[0]!.assignments[0]!.allocation.provisionReceipt,
        null,
      );
      assert.notEqual(
        readyB.versions[0]!.assignments[0]!.allocation.provisionReceipt,
        null,
      );

      assert.equal(
        execute(database, "start-package-a", 1, {
          type: "work-package.start",
          workPackageId: "package-a",
        }).status,
        "succeeded",
      );
      assert.equal(
        execute(database, "start-package-b", 1, {
          type: "work-package.start",
          workPackageId: "package-b",
        }).status,
        "succeeded",
      );
      await database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: 0,
      });
      assert.equal(fixture.parallel.maxActive(), 2);
      assert.equal(fixture.parallel.requests.length, 2);
      for (const request of fixture.parallel.requests) {
        assert.equal(request.request?.sideEffectPolicy, "formal");
        assert.ok(request.request?.immutableContext.workPackage);
        assert.equal(
          request.request?.immutableContext.workPackage?.sandboxIdentity.startsWith(
            "sandbox:",
          ),
          true,
        );
        assert.match(
          request.request?.immutableContext.workPackage?.executionTreePath ??
            "",
          /execution-tree$/,
        );
        assert.notEqual(
          request.request?.immutableContext.workPackage?.executionTreePath,
          request.request?.immutableContext.workPackage?.repositoryReference,
        );
      }
      const packageBArtifact = database.artifactRegistry
        .listVersionsForRun(fixture.runId)
        .find((entry) => entry.logicalName === "package-b-report");
      assert.ok(packageBArtifact);
      assert.equal(
        packageBArtifact.producer.aiMemberId,
        assignmentB.aiMemberId,
      );
      assert.equal(
        packageBArtifact.producer.positionId,
        assignmentB.positionId,
      );
      assert.equal(
        packageBArtifact.producer.sessionId,
        assignmentB.interactionSessionId,
      );
      assert.equal(packageBArtifact.producer.workPackageId, "package-b");

      let graph = database.workPackages.inspect(fixture.runId);
      const completedA = graph.packages.find(
        (entry) => entry.id === "package-a",
      )!;
      const importedA =
        completedA.versions[0]!.assignments[0]!.allocation.imports.find(
          (entry) => entry.state === "succeeded",
        );
      assert.ok(importedA);
      assert.equal(
        git(
          fixture.repositoryA.root,
          "rev-parse",
          assignmentA.allocation.sourceBranch,
        ),
        importedA.resultCommit,
      );
      assert.equal(
        completedA.versions[0]!.assignments[0]!.state,
        "awaiting-self-check",
      );
      const artifactDependencyStillBlocked = execute(
        database,
        "assign-package-c-before-artifact-evidence",
        0,
        {
          type: "work-package.assign",
          workPackageId: "package-c",
          baseCommit: fixture.repositoryA.baseCommit,
        },
      );
      assert.equal(artifactDependencyStillBlocked.status, "rejected");
      if (artifactDependencyStillBlocked.status === "rejected") {
        assert.equal(
          artifactDependencyStillBlocked.error.code,
          "WORK_PACKAGE_DEPENDENCY_BLOCKED",
        );
      }
      const incompleteSelfCheck = execute(
        database,
        "self-check-package-a-incomplete",
        3,
        {
          type: "work-package.self-check",
          workPackageId: "package-a",
          status: "passed",
          commands: [],
          logRefs: [],
          commitEvidence: [],
          summary: "Claims success without evidence.",
        },
      );
      assert.equal(incompleteSelfCheck.status, "rejected");
      if (incompleteSelfCheck.status === "rejected") {
        assert.equal(
          incompleteSelfCheck.error.code,
          "WORK_PACKAGE_SELF_CHECK_EVIDENCE_REQUIRED",
        );
      }
      const staleCommitSelfCheck = execute(
        database,
        "self-check-package-a-stale-commit",
        3,
        {
          type: "work-package.self-check",
          workPackageId: "package-a",
          status: "passed",
          commands: ["npm test"],
          logRefs: ["log:package-a"],
          commitEvidence: [fixture.repositoryA.baseCommit],
          summary: "Claims success for the pre-execution commit.",
        },
      );
      assert.equal(staleCommitSelfCheck.status, "rejected");
      if (staleCommitSelfCheck.status === "rejected") {
        assert.equal(
          staleCommitSelfCheck.error.code,
          "WORK_PACKAGE_SELF_CHECK_COMMIT_MISMATCH",
        );
      }
      const selfCheckedA = execute(database, "self-check-package-a", 3, {
        type: "work-package.self-check",
        workPackageId: "package-a",
        status: "passed",
        commands: ["npm test"],
        logRefs: ["log:package-a"],
        commitEvidence: [importedA.resultCommit],
        summary: "Package A checks passed.",
      });
      assert.equal(selfCheckedA.status, "succeeded");
      if (selfCheckedA.status !== "succeeded") throw new Error("unreachable");
      const report = selfCheckedA.value.packages.find(
        (entry) => entry.id === "package-a",
      )!.versions[0]!.assignments[0]!.selfCheck!.report as {
        readonly approval: boolean;
      };
      assert.equal(report.approval, false);
      const cleanupAllocation = database.workspaces.inspect(
        assignmentA.allocationId,
      );
      database.workspaces.planCleanupInTransaction({
        commandId: "cleanup-package-a",
        actor: runtimeActor,
        expectedRevision: cleanupAllocation.revision,
        allocationId: assignmentA.allocationId,
      });
      const cleanedAllocation = database.workspaces.executeCleanup(
        assignmentA.allocationId,
      );
      assert.equal(cleanedAllocation.state, "cleaned");
      assert.equal(
        cleanedAllocation.imports.some((entry) => entry.state === "succeeded"),
        true,
      );

      const assignedC = execute(database, "assign-package-c", 0, {
        type: "work-package.assign",
        workPackageId: "package-c",
        baseCommit: fixture.repositoryA.baseCommit,
      });
      assert.equal(assignedC.status, "succeeded");
      if (assignedC.status !== "succeeded") throw new Error("unreachable");
      const assignmentC = assignedC.value.packages.find(
        (entry) => entry.id === "package-c",
      )!.versions[0]!.assignments[0]!;
      database.workspaces.executeProvision(assignmentC.allocationId);
      assert.equal(
        execute(database, "start-package-c", 1, {
          type: "work-package.start",
          workPackageId: "package-c",
        }).status,
        "succeeded",
      );
      const runBeforeC = database.pipelineRuntime.inspectRun(fixture.runId);
      await database.pipelineRuntime.executeReady({
        runId: fixture.runId,
        expectedRevision: runBeforeC.run.revision,
      });
      assert.equal(fixture.parallel.requests.length, 3);

      const reworked = execute(database, "rework-package-a", 4, {
        type: "work-package.rework",
        workPackageId: "package-a",
        versionId: "package-a-v2",
        baseCommit: fixture.repositoryA.baseCommit,
        recoveryReason: "Address the next independent review finding.",
      });
      assert.equal(reworked.status, "succeeded");
      if (reworked.status !== "succeeded") throw new Error("unreachable");
      const reworkedA = reworked.value.packages.find(
        (entry) => entry.id === "package-a",
      )!;
      assert.equal(reworkedA.versions.length, 2);
      const oldAssignment = reworkedA.versions[0]!.assignments[0]!;
      const newAssignment = reworkedA.versions[1]!.assignments[0]!;
      assert.equal(oldAssignment.state, "superseded");
      assert.notEqual(oldAssignment.nodeAttemptId, newAssignment.nodeAttemptId);
      assert.notEqual(oldAssignment.allocationId, newAssignment.allocationId);
      assert.notEqual(
        oldAssignment.interactionSessionId,
        newAssignment.interactionSessionId,
      );
      assert.notEqual(
        oldAssignment.sandboxIdentity,
        newAssignment.sandboxIdentity,
      );
      assert.notEqual(oldAssignment.evidenceScope, newAssignment.evidenceScope);
      assert.notEqual(
        oldAssignment.allocation.sourceBranch,
        newAssignment.allocation.sourceBranch,
      );

      database.close();
      database = openCompanyDatabase(fixture.companyDir, {
        executionAdapter: fixture.parallel.adapter,
      });
      graph = database.workPackages.inspect(fixture.runId);
      const recoveredAssignment = graph.packages.find(
        (entry) => entry.id === "package-a",
      )!.versions[1]!.assignments[0]!;
      assert.equal(
        recoveredAssignment.allocationId,
        newAssignment.allocationId,
      );
      assert.equal(
        recoveredAssignment.interactionSessionId,
        newAssignment.interactionSessionId,
      );
      assert.equal(
        graph.packages.find((entry) => entry.id === "package-a")!.versions[1]!
          .assignments.length,
        1,
      );
      assert.equal(
        database.workspaces.inspect(recoveredAssignment.allocationId).state,
        "ready",
      );
    } finally {
      database.close();
    }
  });
});
