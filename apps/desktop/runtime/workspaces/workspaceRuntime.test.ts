import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase } from "../storage/sqlite.js";
import {
  openLocalIsolatedGitProfile,
  type LocalIsolatedGitProvisionReceipt,
} from "./localIsolatedGitProfile.js";

const runtimeActor = {
  type: "runtime-worker" as const,
  id: "workspace-orchestrator",
  authenticatedBy: "runtime" as const,
};

const humanActor = {
  type: "human" as const,
  id: "local-user",
  authenticatedBy: "local-session" as const,
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-workspace-repository-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Workspace Test");
  git(root, "config", "user.email", "workspace-test@sandcastle.invalid");
  execFileSync("sh", ["-c", "printf baseline > README.md"], { cwd: root });
  git(root, "add", "README.md");
  git(root, "commit", "-m", "baseline");
  const baseCommit = git(root, "rev-parse", "HEAD");
  git(root, "branch", "work/source", baseCommit);
  return { root, baseCommit, sourceBranch: "work/source" };
};

const registerApplication = (
  database: ReturnType<typeof openCompanyDatabase>,
  repositoryRoot: string,
) => {
  const project = database.catalog.createProject({
    name: "Workspace Runtime",
    goal: "Run one isolated Work Package",
  });
  database.projectConfiguration.update({
    projectId: project.id,
    expectedRevision: 0,
    name: project.name,
    goal: project.goal,
    sharedContext: "The Runtime owns source imports.",
    repositoryReferences: [repositoryRoot],
  });
  const applicationId = `application-${project.id}`;
  const registered = database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `register-${project.id}`,
    actor: humanActor,
    consumerId: "workspace-test",
    expectedRevision: 0,
    command: {
      type: "application.register",
      applicationId,
      projectId: project.id,
      repositoryReference: repositoryRoot,
      applicationKey: "runtime-test",
      ownership: "software-rnd",
      buildCommand: "npm run build",
      testCommand: "npm test",
    },
  });
  assert.equal(registered.status, "succeeded");
  return { projectId: project.id, applicationId };
};

const planAllocation = (
  database: ReturnType<typeof openCompanyDatabase>,
  input: {
    readonly allocationId: string;
    readonly projectId: string;
    readonly applicationId: string;
    readonly repositoryRoot: string;
    readonly sourceBranch: string;
    readonly baseCommit: string;
    readonly executionProfileId?: string;
  },
) =>
  database.commandRegistry.execute({
    schemaVersion: 1,
    commandId: `provision-${input.allocationId}`,
    actor: runtimeActor,
    consumerId: "workspace-test",
    expectedRevision: 0,
    command: {
      type: "workspace-allocation.provision",
      allocationId: input.allocationId,
      projectId: input.projectId,
      applicationId: input.applicationId,
      executionProfileId:
        input.executionProfileId ?? "software-rnd-local-isolated-git",
      sourceBranch: input.sourceBranch,
      baseCommit: input.baseCommit,
      expectedSourceTip: input.baseCommit,
    },
  });

describe("Workspace Runtime", () => {
  it("rejects a non-isolated profile before persisting a formal allocation", () => {
    const repository = createRepository();
    const database = openCompanyDatabase(
      mkdtempSync(join(tmpdir(), "sandcastle-workspace-company-")),
    );
    try {
      const application = registerApplication(database, repository.root);
      const result = planAllocation(database, {
        allocationId: "allocation-rejected",
        ...application,
        repositoryRoot: repository.root,
        sourceBranch: repository.sourceBranch,
        baseCommit: repository.baseCommit,
        executionProfileId: "software-rnd-default",
      });

      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") throw new Error("unreachable");
      assert.equal(result.error.code, "PROVIDER_ISOLATION_REQUIRED");
      assert.throws(() => database.workspaces.inspect("allocation-rejected"));
    } finally {
      database.close();
    }
  });

  it("reconciles a committed Git CAS into one durable import receipt after restart", () => {
    const repository = createRepository();
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-workspace-company-"),
    );
    let database = openCompanyDatabase(companyDir);
    const application = registerApplication(database, repository.root);
    const planned = planAllocation(database, {
      allocationId: "allocation-reconcile",
      ...application,
      repositoryRoot: repository.root,
      sourceBranch: repository.sourceBranch,
      baseCommit: repository.baseCommit,
    });
    assert.equal(planned.status, "succeeded");
    if (planned.status !== "succeeded") throw new Error("unreachable");
    assert.equal(planned.value.state, "planned");
    assert.ok(planned.effectIds.length >= 1);
    assert.ok(
      database.events
        .readAfter(0, 100)
        .some((event) => event.type === "workspace-allocation.planned"),
    );

    const ready = database.workspaces.executeProvision("allocation-reconcile");
    assert.equal(ready.state, "ready");
    assert.equal(
      (ready.capabilitySnapshot as { gitRefWriteIsolation: boolean })
        .gitRefWriteIsolation,
      true,
    );
    assert.notEqual(ready.privateGitIdentity, null);
    const provisionReceipt =
      ready.provisionReceipt as LocalIsolatedGitProvisionReceipt;
    execFileSync("sh", ["-c", "printf isolated > result.txt"], {
      cwd: provisionReceipt.executionTreePath,
    });
    git(provisionReceipt.executionTreePath, "add", "result.txt");
    git(provisionReceipt.executionTreePath, "commit", "-m", "isolated result");
    const resultCommit = git(
      provisionReceipt.executionTreePath,
      "rev-parse",
      "HEAD",
    );

    const importPlan = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "import-allocation-reconcile",
      actor: runtimeActor,
      consumerId: "workspace-test",
      expectedRevision: ready.revision,
      command: {
        type: "source-import.execute",
        allocationId: ready.id,
        resultCommit,
        expectedSourceTip: repository.baseCommit,
      },
    });
    assert.equal(importPlan.status, "succeeded");
    if (importPlan.status !== "succeeded") throw new Error("unreachable");
    assert.equal(importPlan.value.imports[0]?.state, "intent");
    assert.ok(importPlan.effectIds.length >= 1);

    openLocalIsolatedGitProfile().importResult({
      allocation: provisionReceipt,
      resultCommit,
      expectedSourceTip: repository.baseCommit,
    });
    assert.equal(
      git(repository.root, "rev-parse", repository.sourceBranch),
      resultCommit,
    );
    database.close();

    database = openCompanyDatabase(companyDir);
    try {
      const inspected = database.workspaces.inspect("allocation-reconcile");
      assert.equal(inspected.imports.length, 1);
      assert.equal(inspected.imports[0]?.state, "succeeded");
      assert.equal(inspected.imports[0]?.receipt?.status, "duplicate");
      assert.equal(inspected.imports[0]?.receipt?.afterSourceTip, resultCommit);

      const duplicate = database.commandRegistry.execute({
        schemaVersion: 1,
        commandId: "import-allocation-reconcile",
        actor: runtimeActor,
        consumerId: "workspace-test",
        expectedRevision: ready.revision,
        command: {
          type: "source-import.execute",
          allocationId: ready.id,
          resultCommit,
          expectedSourceTip: repository.baseCommit,
        },
      });
      assert.deepEqual(duplicate, importPlan);
    } finally {
      database.close();
    }
  });

  it("keeps tip drift failed without force update and reconciles cleanup", () => {
    const repository = createRepository();
    const companyDir = mkdtempSync(
      join(tmpdir(), "sandcastle-workspace-company-"),
    );
    let database = openCompanyDatabase(companyDir);
    const application = registerApplication(database, repository.root);
    const planned = planAllocation(database, {
      allocationId: "allocation-conflict",
      ...application,
      repositoryRoot: repository.root,
      sourceBranch: repository.sourceBranch,
      baseCommit: repository.baseCommit,
    });
    assert.equal(planned.status, "succeeded");
    const ready = database.workspaces.executeProvision("allocation-conflict");
    const receipt = ready.provisionReceipt as LocalIsolatedGitProvisionReceipt;
    execFileSync("sh", ["-c", "printf result > result.txt"], {
      cwd: receipt.executionTreePath,
    });
    git(receipt.executionTreePath, "add", "result.txt");
    git(receipt.executionTreePath, "commit", "-m", "result");
    const resultCommit = git(receipt.executionTreePath, "rev-parse", "HEAD");

    git(repository.root, "checkout", repository.sourceBranch);
    execFileSync("sh", ["-c", "printf drift > drift.txt"], {
      cwd: repository.root,
    });
    git(repository.root, "add", "drift.txt");
    git(repository.root, "commit", "-m", "source drift");
    const driftTip = git(repository.root, "rev-parse", "HEAD");

    const importPlan = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "import-allocation-conflict",
      actor: runtimeActor,
      consumerId: "workspace-test",
      expectedRevision: ready.revision,
      command: {
        type: "source-import.execute",
        allocationId: ready.id,
        resultCommit,
        expectedSourceTip: repository.baseCommit,
      },
    });
    assert.equal(importPlan.status, "succeeded");
    if (importPlan.status !== "succeeded") throw new Error("unreachable");
    const failed = database.workspaces.executeImport(
      importPlan.value.imports[0]!.id,
    );
    assert.equal(failed.imports[0]?.failure?.code, "INTEGRATION_CONFLICT");
    assert.equal(
      git(repository.root, "rev-parse", repository.sourceBranch),
      driftTip,
    );

    const cleanup = database.commandRegistry.execute({
      schemaVersion: 1,
      commandId: "cleanup-allocation-conflict",
      actor: runtimeActor,
      consumerId: "workspace-test",
      expectedRevision: failed.revision,
      command: {
        type: "workspace-allocation.cleanup",
        allocationId: ready.id,
      },
    });
    assert.equal(cleanup.status, "succeeded");
    database.close();

    database = openCompanyDatabase(companyDir);
    try {
      const cleaned = database.workspaces.inspect(ready.id);
      assert.equal(cleaned.state, "cleaned");
      assert.notEqual(cleaned.cleanupEvidence, null);
      database.workspaces.reconcile();
      assert.equal(database.workspaces.inspect(ready.id).state, "cleaned");
    } finally {
      database.close();
    }
  });
});
