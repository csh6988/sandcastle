import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCompanyDatabase, type CompanyDatabase } from "./storage/sqlite.js";
import type { ManagedFileCrashPoint } from "./artifactRegistry.js";

const tempCompanyDir = (): string =>
  mkdtempSync(join(tmpdir(), "sandcastle-artifact-registry-"));

const createProject = (database: CompanyDatabase, name = "Artifacts") =>
  database.catalog.createProject({ name, goal: "Verify artifacts" });

const producerFor = (projectId: string) => ({
  projectId,
  runId: "run-1",
  snapshotRevisionId: "snapshot-1",
  nodeRunId: "node-1",
  nodeAttemptId: "attempt-1",
  aiMemberId: "member-1",
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe("Artifact Registry", () => {
  it("stages and finalizes a managed-file through a durable write journal", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const project = database.catalog.createProject({
        name: "Journal",
        goal: "Exercise crash-safe artifact writes",
      });
      const registration = database.artifactRegistry.register({
        projectId: project.id,
        type: "test-evidence",
        schemaVersion: "1",
        logicalName: "journal-evidence",
        content: {
          kind: "managed-file",
          bytes: Buffer.from("journal payload"),
          mediaType: "text/plain",
        },
        producer: {
          projectId: project.id,
          runId: "run-1",
          snapshotRevisionId: "snapshot-1",
          nodeRunId: "node-1",
          nodeAttemptId: "attempt-1",
          aiMemberId: "member-1",
        },
      });

      assert.equal(registration.contentKind, "managed-file");
      assert.equal(registration.journalState, "renamed");
      assert.equal(registration.finalized, false);

      const version = database.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      });
      assert.equal(version.contentKind, "managed-file");
      assert.equal(version.integrityStatus, "verified");
      assert.equal(version.lifecycle, "finalized");
      assert.equal(version.contentRef.startsWith("/"), false);
      assert.deepEqual(
        database.artifactRegistry.readContent(version.id),
        Buffer.from("journal payload"),
      );
    } finally {
      database.close();
    }
  });

  for (const crashPoint of [
    "after-prepared",
    "after-temp-fsync",
    "after-written",
    "after-rename",
    "after-directory-fsync",
    "after-renamed",
  ] as const satisfies readonly ManagedFileCrashPoint[]) {
    it(`reconciles managed-file crash point ${crashPoint} after Runtime restart`, () => {
      const companyDir = tempCompanyDir();
      let registrationId = "";
      const crashing = openCompanyDatabase(companyDir, {
        artifactRegistry: {
          managedFileCrash: (point, currentRegistrationId) => {
            if (point !== crashPoint) return;
            registrationId = currentRegistrationId;
            throw new Error(`simulated crash at ${point}`);
          },
        },
      });
      const project = createProject(crashing, `Crash ${crashPoint}`);
      assert.throws(
        () =>
          crashing.artifactRegistry.register({
            projectId: project.id,
            type: "test-evidence",
            schemaVersion: "1",
            logicalName: `crash-${crashPoint}`,
            content: {
              kind: "managed-file",
              bytes: Buffer.from(`payload-${crashPoint}`),
            },
            producer: producerFor(project.id),
          }),
        new RegExp(`simulated crash at ${crashPoint}`),
      );
      assert.ok(registrationId);
      crashing.close();

      const recovered = openCompanyDatabase(companyDir);
      try {
        const versions = recovered.artifactRegistry.listVersions(project.id);
        if (crashPoint === "after-prepared") {
          assert.deepEqual(versions, []);
          assert.throws(
            () => recovered.artifactRegistry.finalize({ registrationId }),
            (error: unknown) =>
              error instanceof Error && error.message.includes("not ready"),
          );
        } else {
          assert.equal(versions.length, 1);
          assert.equal(versions[0]?.integrityStatus, "verified");
          assert.equal(
            recovered.artifactRegistry
              .readContent(versions[0]!.id)
              .toString("utf8"),
            `payload-${crashPoint}`,
          );
        }
      } finally {
        recovered.close();
      }
    });
  }

  it("registers and reads a repository-object after its Worktree is removed", () => {
    const companyDir = tempCompanyDir();
    const repositoryDir = tempCompanyDir();
    execFileSync("git", ["init", "-q", repositoryDir]);
    execFileSync("git", [
      "-C",
      repositoryDir,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", repositoryDir, "config", "user.name", "Test"]);
    const filePath = join(repositoryDir, "README.md");
    writeFileSync(filePath, "base repository object");
    git(repositoryDir, "add", "README.md");
    git(repositoryDir, "commit", "-m", "initial");
    const worktreeParent = tempCompanyDir();
    const worktreeDir = join(worktreeParent, "artifact-worktree");
    git(
      repositoryDir,
      "worktree",
      "add",
      "-q",
      "-b",
      "artifact-worktree",
      worktreeDir,
      "HEAD",
    );
    writeFileSync(join(worktreeDir, "README.md"), "repository object");
    git(worktreeDir, "add", "README.md");
    git(worktreeDir, "commit", "-m", "worktree artifact");
    const commitId = git(worktreeDir, "rev-parse", "HEAD");
    const objectId = git(worktreeDir, "rev-parse", "HEAD:README.md");
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Repository object");
      const projectView = database.projectConfiguration.inspect(project.id);
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: projectView.revision,
        name: projectView.name,
        goal: projectView.goal,
        sharedContext: projectView.sharedContext,
        repositoryReferences: [repositoryDir],
      });
      const registration = database.artifactRegistry.register({
        projectId: project.id,
        type: "source-file",
        schemaVersion: "1",
        logicalName: "README.md",
        content: {
          kind: "repository-object",
          repositoryRef: repositoryDir,
          commitId,
          objectId,
          objectKind: "blob",
        },
        producer: producerFor(project.id),
      });
      const version = database.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      });
      git(repositoryDir, "worktree", "remove", "--force", worktreeDir);
      assert.equal(version.contentKind, "repository-object");
      assert.equal(version.integrityStatus, "verified");
      assert.equal(version.contentRef.startsWith("/"), false);
      assert.equal(
        database.artifactRegistry.readContent(version.id).toString("utf8"),
        "repository object",
      );
    } finally {
      database.close();
    }
  });

  it("requires repository-object references to be registered on the Project", () => {
    const companyDir = tempCompanyDir();
    const repositoryDir = tempCompanyDir();
    execFileSync("git", ["init", "-q", repositoryDir]);
    git(repositoryDir, "config", "user.email", "test@example.com");
    git(repositoryDir, "config", "user.name", "Test");
    writeFileSync(join(repositoryDir, "README.md"), "repository object");
    git(repositoryDir, "add", "README.md");
    git(repositoryDir, "commit", "-m", "initial");
    const commitId = git(repositoryDir, "rev-parse", "HEAD");
    const objectId = git(repositoryDir, "rev-parse", "HEAD:README.md");
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Unregistered repository");
      assert.throws(
        () =>
          database.artifactRegistry.register({
            projectId: project.id,
            type: "source-file",
            schemaVersion: "1",
            logicalName: "README.md",
            content: {
              kind: "repository-object",
              repositoryRef: repositoryDir,
              commitId,
              objectId,
              objectKind: "blob",
            },
            producer: producerFor(project.id),
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ARTIFACT_REPOSITORY_NOT_REGISTERED",
      );
    } finally {
      database.close();
    }
  });

  it("rejects a repository commit object that is not reachable from the declared commit", () => {
    const companyDir = tempCompanyDir();
    const repositoryDir = tempCompanyDir();
    execFileSync("git", ["init", "-q", repositoryDir]);
    git(repositoryDir, "config", "user.email", "test@example.com");
    git(repositoryDir, "config", "user.name", "Test");
    writeFileSync(join(repositoryDir, "README.md"), "base");
    git(repositoryDir, "add", "README.md");
    git(repositoryDir, "commit", "-m", "base");
    const baseCommitId = git(repositoryDir, "rev-parse", "HEAD");
    git(repositoryDir, "switch", "-q", "--orphan", "unrelated");
    writeFileSync(join(repositoryDir, "other.txt"), "unrelated");
    git(repositoryDir, "add", "other.txt");
    git(repositoryDir, "commit", "-m", "unrelated");
    const unrelatedCommitId = git(repositoryDir, "rev-parse", "HEAD");
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Unreachable repository object");
      const projectView = database.projectConfiguration.inspect(project.id);
      database.projectConfiguration.update({
        projectId: project.id,
        expectedRevision: projectView.revision,
        name: projectView.name,
        goal: projectView.goal,
        sharedContext: projectView.sharedContext,
        repositoryReferences: [repositoryDir],
      });
      assert.throws(
        () =>
          database.artifactRegistry.register({
            projectId: project.id,
            type: "source-commit",
            schemaVersion: "1",
            logicalName: "unrelated",
            content: {
              kind: "repository-object",
              repositoryRef: repositoryDir,
              commitId: baseCommitId,
              objectId: unrelatedCommitId,
              objectKind: "commit",
            },
            producer: producerFor(project.id),
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ARTIFACT_REPOSITORY_IDENTITY_MISMATCH",
      );
    } finally {
      database.close();
    }
  });

  it("persists external verifier metadata and marks unavailable references", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir, {
      artifactRegistry: {
        externalVerifier: (input) => ({
          status: input.objectId === "missing" ? "unavailable" : "verified",
          verifierMetadata: { provider: input.provider, checked: true },
          evidence: {
            reason: input.objectId === "missing" ? "404" : undefined,
          },
        }),
      },
    });
    try {
      const project = createProject(database, "External references");
      const registration = database.artifactRegistry.register({
        projectId: project.id,
        type: "build",
        schemaVersion: "1",
        logicalName: "latest-build",
        content: {
          kind: "external-reference",
          provider: "ci",
          namespace: "builds",
          objectId: "missing",
          providerVersion: "2026.07.23",
          digest: "sha256:deadbeef",
          retrievalRef: "ci://builds/missing",
          verifierMetadata: { requestId: "redacted" },
        },
        producer: producerFor(project.id),
      });
      const version = database.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      });
      assert.equal(version.contentKind, "external-reference");
      assert.equal(version.integrityStatus, "unavailable");
      assert.equal(
        (version.integrityDescriptor as { provider?: string }).provider,
        "ci",
      );
      assert.equal(version.contentRef.includes("ci://"), false);
      const integrityEvent = database.events
        .readAfter(0, 100)
        .find((event) => event.type === "artifact.integrity-failed");
      assert.equal(integrityEvent?.artifactId, version.artifactId);
      assert.equal(integrityEvent?.artifactVersionId, version.id);
      assert.equal(
        (integrityEvent?.payload as { integrityStatus?: string })
          .integrityStatus,
        "unavailable",
      );
    } finally {
      database.close();
    }
  });

  it("reconciles external availability changes once across Runtime restarts", () => {
    const companyDir = tempCompanyDir();
    let available = true;
    const options = {
      artifactRegistry: {
        externalVerifier: (input: {
          readonly provider: string;
          readonly namespace: string;
          readonly objectId: string;
          readonly retrievalRef: string;
        }) => ({
          status: available ? ("verified" as const) : ("unavailable" as const),
          verifierMetadata: { provider: input.provider, available },
          evidence: available ? { checked: true } : { reason: "provider-down" },
        }),
      },
    };
    const first = openCompanyDatabase(companyDir, options);
    let versionId = "";
    try {
      const project = createProject(first, "External restart");
      const registration = first.artifactRegistry.register({
        projectId: project.id,
        type: "build",
        schemaVersion: "1",
        logicalName: "restart-build",
        content: {
          kind: "external-reference",
          provider: "ci",
          namespace: "builds",
          objectId: "build-1",
          retrievalRef: "ci://builds/build-1",
          verifierMetadata: { requestId: "request-1" },
        },
        producer: producerFor(project.id),
      });
      versionId = first.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      }).id;
      assert.equal(
        first.artifactRegistry.inspect(versionId).version.integrityStatus,
        "verified",
      );
    } finally {
      first.close();
    }

    available = false;
    const recovered = openCompanyDatabase(companyDir, options);
    try {
      assert.equal(
        recovered.artifactRegistry.inspect(versionId).version.integrityStatus,
        "unavailable",
      );
      assert.equal(
        recovered.events
          .readAfter(0, 100)
          .filter((event) => event.type === "artifact.integrity-failed").length,
        1,
      );
    } finally {
      recovered.close();
    }

    const reopened = openCompanyDatabase(companyDir, options);
    try {
      assert.equal(
        reopened.events
          .readAfter(0, 100)
          .filter((event) => event.type === "artifact.integrity-failed").length,
        1,
      );
    } finally {
      reopened.close();
    }
  });

  it("deduplicates identical content and rejects lineage cycles", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Lineage");
      const input = {
        projectId: project.id,
        type: "evidence",
        schemaVersion: "1",
        logicalName: "lineage",
        content: {
          kind: "managed-file" as const,
          bytes: Buffer.from("same content"),
        },
        producer: producerFor(project.id),
      };
      const first = database.artifactRegistry.register(input);
      const pendingDuplicate = database.artifactRegistry.register(input);
      assert.equal(pendingDuplicate.registrationId, first.registrationId);
      const firstVersion = database.artifactRegistry.finalize({
        registrationId: first.registrationId,
      });
      const duplicate = database.artifactRegistry.register(input);
      assert.equal(duplicate.versionId, firstVersion.id);
      const second = database.artifactRegistry.register({
        ...input,
        content: {
          kind: "managed-file",
          bytes: Buffer.from("semantic change"),
        },
        inputVersionIds: [firstVersion.id],
      });
      const secondVersion = database.artifactRegistry.finalize({
        registrationId: second.registrationId,
      });
      assert.notEqual(secondVersion.id, firstVersion.id);
      const superseded = database.artifactRegistry.supersede({
        versionId: firstVersion.id,
        supersededByVersionId: secondVersion.id,
      });
      assert.equal(superseded.lifecycle, "superseded");
      assert.throws(
        () =>
          database.artifactRegistry.supersede({
            versionId: secondVersion.id,
            supersededByVersionId: firstVersion.id,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ARTIFACT_LINEAGE_CYCLE",
      );
    } finally {
      database.close();
    }
  });

  it("records an integrity failure after a managed file is tampered with", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Integrity");
      const registration = database.artifactRegistry.register({
        projectId: project.id,
        type: "evidence",
        schemaVersion: "1",
        logicalName: "tamper",
        content: {
          kind: "managed-file",
          bytes: Buffer.from("original"),
        },
        producer: producerFor(project.id),
      });
      const version = database.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      });
      writeFileSync(join(companyDir, version.contentRef), "tampered");
      assert.equal(database.artifactRegistry.verify(version.id), "failed");
      const integrityEvents = database.events
        .readAfter(0, 100)
        .filter((event) => event.type === "artifact.integrity-failed");
      assert.equal(integrityEvents.length, 1);
      assert.equal(integrityEvents[0]?.artifactId, version.artifactId);
      assert.equal(integrityEvents[0]?.artifactVersionId, version.id);
      assert.equal(
        (integrityEvents[0]?.payload as { integrityStatus?: string })
          .integrityStatus,
        "failed",
      );
      assert.throws(
        () => database.artifactRegistry.readContent(version.id),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ARTIFACT_INTEGRITY_FAILED",
      );
    } finally {
      database.close();
    }
  });

  it("quarantines unknown managed-file temp and final files without touching known files", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    let knownContentRef = "";
    try {
      const project = createProject(database, "Orphan files");
      const registration = database.artifactRegistry.register({
        projectId: project.id,
        type: "known-evidence",
        schemaVersion: "1",
        logicalName: "known",
        content: {
          kind: "managed-file",
          bytes: Buffer.from("known content"),
        },
        producer: producerFor(project.id),
      });
      knownContentRef = database.artifactRegistry.finalize({
        registrationId: registration.registrationId,
      }).contentRef;
    } finally {
      database.close();
    }

    const artifactRoot = join(companyDir, ".sandcastle", "artifacts");
    const orphanDir = join(artifactRoot, "orphan");
    mkdirSync(orphanDir, { recursive: true });
    const orphanTemp = join(orphanDir, "unknown.bin.tmp-registration");
    const orphanFinal = join(orphanDir, "unknown.bin");
    writeFileSync(orphanTemp, "orphan temp");
    writeFileSync(orphanFinal, "orphan final");

    const recovered = openCompanyDatabase(companyDir);
    try {
      assert.equal(existsSync(join(companyDir, knownContentRef)), true);
      assert.equal(existsSync(orphanTemp), false);
      assert.equal(existsSync(orphanFinal), false);
      const quarantined = readdirSync(join(artifactRoot, ".quarantine"));
      assert.equal(
        quarantined.some((name) => name.includes("unknown.bin")),
        true,
      );
    } finally {
      recovered.close();
    }
  });

  it("executes register and finalize through replay-safe Runtime Commands", () => {
    const companyDir = tempCompanyDir();
    const database = openCompanyDatabase(companyDir);
    try {
      const project = createProject(database, "Artifact Commands");
      const registerEnvelope = {
        schemaVersion: 1 as const,
        commandId: "artifact-register-command-1",
        actor: {
          type: "test-driver" as const,
          id: "artifact-test",
          authenticatedBy: "ipc-token" as const,
        },
        consumerId: "artifact-consumer",
        command: {
          type: "artifact.version.register" as const,
          projectId: project.id,
          artifactType: "command-evidence",
          artifactSchemaVersion: "1",
          logicalName: "command-evidence",
          content: {
            kind: "managed-file" as const,
            encoding: "base64" as const,
            data: Buffer.from("command payload").toString("base64"),
          },
          producer: producerFor(project.id),
          inputVersionIds: [],
        },
      };
      const registered = database.commandRegistry.execute(registerEnvelope);
      assert.equal(registered.status, "succeeded");
      if (registered.status !== "succeeded") return;
      assert.ok(registered.effectIds.length > 0);
      assert.deepEqual(
        database.commandRegistry.execute(registerEnvelope),
        registered,
      );

      const finalized = database.commandRegistry.execute({
        ...registerEnvelope,
        commandId: "artifact-finalize-command-1",
        command: {
          type: "artifact.version.finalize" as const,
          registrationId: registered.value.registrationId,
        },
      });
      assert.equal(finalized.status, "succeeded");
      if (finalized.status !== "succeeded") return;
      assert.equal(finalized.value.integrityStatus, "verified");
      assert.ok(finalized.effectIds.length > 0);
      assert.deepEqual(
        database.artifactRegistry
          .listVersionsForRun("run-1")
          .map((version) => version.id),
        [finalized.value.id],
      );
      const events = database.events.readAfter(0, 100);
      const artifactEvents = events.filter((event) =>
        event.type.startsWith("artifact."),
      );
      assert.deepEqual(
        artifactEvents.map((event) => event.type),
        ["artifact.registered", "artifact.finalized"],
      );
      assert.ok(
        artifactEvents.every(
          (event) =>
            event.artifactId === finalized.value.artifactId &&
            event.artifactVersionId === finalized.value.id,
        ),
      );
    } finally {
      database.close();
    }
  });

  it("registers immutable Artifact Versions with content integrity and input lineage", async () => {
    const database = openCompanyDatabase(tempCompanyDir());
    try {
      const project = database.catalog.createProject({
        name: "Checkout",
        goal: "Ship checkout",
      });
      const started = database.pipelineRuntime.startRun({
        projectId: project.id,
        departmentId: "software-rnd",
      });
      const waiting = await database.pipelineRuntime.executeReady({
        runId: started.run.id,
        expectedRevision: started.run.revision,
      });
      const node = waiting.nodes.find(
        (candidate) => candidate.pipelineNodeId === "product-alignment",
      );
      const attempt = node?.attempts[0];
      assert.ok(node && attempt);
      const position = waiting.snapshot.payload.positions.find(
        (candidate) => candidate.id === "product-planner",
      );
      assert.ok(position);

      const first = database.artifactRegistry.registerVersion({
        projectId: project.id,
        type: "verification-report",
        schemaVersion: "1",
        logicalName: "checkout-verification",
        content: "evidence",
        status: "produced",
        producer: {
          runId: started.run.id,
          nodeRunId: node.id,
          nodeAttemptId: attempt.id,
          snapshotRevisionId: waiting.snapshot.id,
          aiMemberId: position.aiMember.id,
        },
      });
      const second = database.artifactRegistry.registerVersion({
        projectId: project.id,
        type: "verification-report",
        schemaVersion: "1",
        logicalName: "checkout-verification",
        content: "evidence v2",
        status: "produced",
        producer: {
          runId: started.run.id,
          nodeRunId: node.id,
          nodeAttemptId: attempt.id,
          snapshotRevisionId: waiting.snapshot.id,
          aiMemberId: position.aiMember.id,
        },
        inputVersionIds: [first.id],
      });
      const accepted = database.artifactRegistry.setStatus({
        versionId: second.id,
        expectedStatus: "produced",
        status: "accepted",
      });

      assert.equal(first.version, 1);
      assert.equal(second.version, 2);
      assert.equal(accepted.status, "accepted");
      assert.equal(
        first.contentHash,
        "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e",
      );
      assert.equal(
        database.artifactRegistry.readContent(first.id).toString("utf8"),
        "evidence",
      );
      assert.equal(first.contentRef.startsWith("/"), false);
      assert.deepEqual(database.artifactRegistry.lineage(second.id), [
        { versionId: first.id, relation: "input" },
      ]);
      assert.deepEqual(
        database.artifactRegistry
          .listVersions(project.id)
          .map((version) => version.version),
        [1, 2],
      );
    } finally {
      database.close();
    }
  });
});
