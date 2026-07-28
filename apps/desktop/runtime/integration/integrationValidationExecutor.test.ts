import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  openIsolatedIntegrationValidationExecutor,
  type IntegrationValidationProvider,
} from "./integrationValidationExecutor.js";

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const repositoryFixture = () => {
  const repository = mkdtempSync(
    join(tmpdir(), "integration-validation-repo-"),
  );
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "runtime@example.test"]);
  git(repository, ["config", "user.name", "Runtime"]);
  writeFileSync(join(repository, "package.json"), JSON.stringify({}));
  writeFileSync(
    join(repository, "verify.sh"),
    "#!/bin/sh\nprintf executable\n",
  );
  chmodSync(join(repository, "verify.sh"), 0o755);
  git(repository, ["add", "package.json", "verify.sh"]);
  git(repository, ["commit", "-qm", "fixture"]);
  return {
    repository,
    integratedCommit: git(repository, ["rev-parse", "HEAD"]),
  };
};

const inputFor = (
  repository: string,
  integratedCommit: string,
  kind: "build-test" | "contract" = "build-test",
) => ({
  operationKey: `generation-1:${kind}`,
  generationId: "generation-1",
  manifestHash: "a".repeat(64),
  repositoryReference: repository,
  integratedCommit,
  responsibleWorkPackageVersionIds: ["package-v1"],
  validation: {
    id: `validation:${"b".repeat(64)}`,
    repositoryReference: repository,
    kind,
    commands: [["npm", "run", kind === "contract" ? "test:contract" : "test"]],
    evidenceRefs: kind === "contract" ? ["contract-fixture"] : [],
    responsibleWorkPackageVersionIds: ["package-v1"],
    ...(kind === "build-test"
      ? { condition: "npm run test" }
      : {
          contract: {
            id: "contract-api",
            version: "1",
            hash: "c".repeat(64),
            producerApplicationId: "application-api",
            consumerApplicationId: "application-web",
          },
        }),
    identityHash: "b".repeat(64),
  },
});

describe("Isolated Integration validation executor", () => {
  it("prepares Git workspaces with a minimal environment and ignores hostile global filters and hooks", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const root = mkdtempSync(join(tmpdir(), "integration-safe-git-env-"));
    const hookMarker = join(root, "hook-ran");
    const filterMarker = join(root, "filter-ran");
    const hookDirectory = join(root, "hooks");
    execFileSync("mkdir", ["-p", hookDirectory]);
    writeFileSync(
      join(hookDirectory, "post-checkout"),
      `#!/bin/sh\nprintf hook > '${hookMarker}'\n`,
      { mode: 0o755 },
    );
    const globalConfig = join(root, "hostile.gitconfig");
    const globalAttributes = join(root, "hostile.attributes");
    writeFileSync(globalAttributes, "* filter=leak\n");
    writeFileSync(
      globalConfig,
      `[core]\n\thooksPath = ${hookDirectory}\n\tattributesFile = ${globalAttributes}\n[filter "leak"]\n\tsmudge = sh -c 'printf filter > ${filterMarker}; cat'\n\trequired = true\n`,
    );
    const gitPath = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const environmentLog = join(root, "environment.log");
    const wrapper = join(root, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nenv >> '${environmentLog}'\nprintf '%s\\n' __CALL__ >> '${environmentLog}'\nexec '${gitPath}' "$@"\n`,
      { mode: 0o755 },
    );
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    const priorSecret = process.env.SANDCASTLE_TEST_SECRET;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.SANDCASTLE_TEST_SECRET = "must-not-reach-git";
    try {
      const executor = openIsolatedIntegrationValidationExecutor({
        evidenceRoot: join(root, "evidence"),
        gitExecutable: wrapper,
        provider: {
          execute: async (input) => {
            input.onOperationStarted({
              providerId: "fixture",
              providerOperationId: "safe-git-env",
              evidenceRefs: [],
            });
            return {
              status: "completed",
              exitCode: 0,
              providerId: "fixture",
              providerOperationId: "safe-git-env",
              terminalReceiptHash: "a".repeat(64),
              evidenceRefs: [],
              output: "passed",
            };
          },
          inspect: async () => "not-found",
          cancel: async () => "not-found",
        },
      });

      assert.equal(
        (await executor.execute(inputFor(repository, integratedCommit))).status,
        "passed",
      );
    } finally {
      if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
      if (priorSecret === undefined) delete process.env.SANDCASTLE_TEST_SECRET;
      else process.env.SANDCASTLE_TEST_SECRET = priorSecret;
    }
    const logged = readFileSync(environmentLog, "utf8");
    assert.doesNotMatch(logged, /must-not-reach-git/);
    assert.doesNotMatch(logged, new RegExp(globalConfig));
    assert.equal(existsSync(hookMarker), false);
    assert.equal(existsSync(filterMarker), false);
  });

  it("cancels a hung Git checkout into durable unknown without starting or retrying the provider", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const root = mkdtempSync(join(tmpdir(), "integration-safe-git-cancel-"));
    const gitPath = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const checkoutLog = join(root, "checkout.log");
    const wrapper = join(root, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" checkout "*)\n    printf checkout >> '${checkoutLog}'\n    trap 'exit 143' TERM INT\n    while :; do sleep 1; done\n    ;;\nesac\nexec '${gitPath}' "$@"\n`,
      { mode: 0o755 },
    );
    let providerExecutions = 0;
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: join(root, "evidence"),
      gitExecutable: wrapper,
      workspaceGitTimeoutMs: 10_000,
      provider: {
        execute: async () => {
          providerExecutions += 1;
          throw new Error("provider must not start");
        },
        inspect: async () => "unknown",
        cancel: async () => "unknown",
      },
    });
    const input = inputFor(repository, integratedCommit);
    const executing = executor.execute(input);
    for (
      let attempt = 0;
      attempt < 100 && !existsSync(checkoutLog);
      attempt++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(checkoutLog), true);
    const cancelled = await executor.cancel!(input);
    const terminal = await executing;

    assert.equal(cancelled.status, "unknown");
    assert.equal(terminal.status, "unknown");
    assert.equal((await executor.execute(input)).status, "unknown");
    assert.equal(readFileSync(checkoutLog, "utf8"), "checkout");
    assert.equal(providerExecutions, 0);
  });

  it("atomically fences concurrent execution before the provider starts", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    let executes = 0;
    let enteredProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    let releaseProvider!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: IntegrationValidationProvider = {
      execute: async (input) => {
        executes += 1;
        enteredProvider();
        await released;
        input.onOperationStarted({
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-concurrent",
          evidenceRefs: ["provider-started"],
        });
        return {
          status: "completed",
          exitCode: 0,
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-concurrent",
          terminalReceiptHash: "f".repeat(64),
          evidenceRefs: ["validation-terminal-receipt"],
          output: "tests passed",
        };
      },
      inspect: async () => "running",
      cancel: async () => "unknown",
    };
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: mkdtempSync(
        join(tmpdir(), "integration-validation-concurrent-"),
      ),
      provider,
    });
    const input = inputFor(repository, integratedCommit);

    const first = executor.execute(input);
    await entered;
    const secondResult = executor.execute(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observedExecutions = executes;
    releaseProvider();
    const [firstResult, second] = await Promise.all([first, secondResult]);
    assert.equal(second.status, "unknown");
    assert.equal(observedExecutions, 1);
    assert.equal(firstResult.status, "passed");
  });

  it("runs only frozen argv in an exact read-only input through the provider and replays the terminal receipt", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const calls: unknown[] = [];
    const provider: IntegrationValidationProvider = {
      execute: async (input) => {
        calls.push(input);
        assert.equal(
          git(input.workspaceRef, ["rev-parse", "HEAD"]),
          integratedCommit,
        );
        assert.deepEqual(input.commands, [["npm", "run", "test"]]);
        const executable = join(input.workspaceRef, "verify.sh");
        assert.equal(statSync(executable).mode & 0o222, 0);
        assert.notEqual(statSync(executable).mode & 0o111, 0);
        assert.equal(
          execFileSync(executable, { encoding: "utf8" }),
          "executable",
        );
        input.onOperationStarted({
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-1",
          evidenceRefs: [
            "docker:network:none",
            "mount:/validation-input:readonly",
          ],
        });
        return {
          status: "completed",
          exitCode: 0,
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-1",
          terminalReceiptHash: "d".repeat(64),
          evidenceRefs: ["validation-log", "validation-terminal-receipt"],
          output: "tests passed",
        };
      },
      inspect: async () => "not-found",
      cancel: async () => "not-found",
    };
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: mkdtempSync(
        join(tmpdir(), "integration-validation-evidence-"),
      ),
      provider,
    });
    const input = inputFor(repository, integratedCommit);

    const result = await executor.execute(input);
    assert.equal(result.status, "passed");
    assert.deepEqual(await executor.reconcile(input), result);
    assert.equal(calls.length, 1);
  });

  it("never reissues validation after its terminal record is corrupt or deleted", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const evidenceRoot = mkdtempSync(
      join(tmpdir(), "integration-validation-completion-fence-"),
    );
    let executes = 0;
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot,
      provider: {
        execute: async (providerInput) => {
          executes += 1;
          providerInput.onOperationStarted({
            providerId: "sandcastle-docker-validation",
            providerOperationId: "container-completion-fence",
            evidenceRefs: ["provider-started"],
          });
          return {
            status: "completed",
            exitCode: 0,
            providerId: "sandcastle-docker-validation",
            providerOperationId: "container-completion-fence",
            terminalReceiptHash: "e".repeat(64),
            evidenceRefs: ["terminal-receipt"],
            output: "tests passed",
          };
        },
        inspect: async () => "not-found",
        cancel: async () => "not-found",
      },
    });
    const input = inputFor(repository, integratedCommit);
    assert.equal((await executor.execute(input)).status, "passed");
    const record = join(
      evidenceRoot,
      `${createHash("sha256").update(input.operationKey).digest("hex")}.json`,
    );

    writeFileSync(record, "{corrupt", { mode: 0o600 });
    assert.equal((await executor.execute(input)).status, "unknown");
    assert.equal(executes, 1);

    unlinkSync(record);
    assert.equal((await executor.execute(input)).status, "unknown");
    assert.equal(executes, 1);
  });

  it("rejects a reused validation workspace with tracked or untracked drift", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const evidenceRoot = mkdtempSync(
      join(tmpdir(), "integration-validation-drift-"),
    );
    const input = inputFor(repository, integratedCommit);
    const workspace = join(
      evidenceRoot,
      `workspace-${createHash("sha256").update(input.operationKey).digest("hex")}`,
    );
    execFileSync(
      "git",
      ["clone", "--no-local", "--no-checkout", repository, workspace],
      { stdio: "pipe" },
    );
    git(workspace, ["checkout", "--detach", integratedCommit]);
    writeFileSync(join(workspace, "package.json"), '{"drifted":true}');
    writeFileSync(join(workspace, "untracked.txt"), "untracked");
    let executes = 0;
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot,
      provider: {
        execute: async () => {
          executes += 1;
          throw new Error("provider must not execute a drifted workspace");
        },
        inspect: async () => "unknown",
        cancel: async () => "unknown",
      },
    });

    const result = await executor.execute(input);

    assert.equal(result.status, "unknown");
    assert.equal(executes, 0);
  });

  it("keeps provider-started execution unknown after a crash and never resends it", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    let executes = 0;
    const provider: IntegrationValidationProvider = {
      execute: async (input) => {
        executes += 1;
        input.onOperationStarted({
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-crashed",
          evidenceRefs: ["provider-started"],
        });
        throw new Error(
          "crash after command execution before terminal receipt",
        );
      },
      inspect: async () => "not-running",
      cancel: async () => "not-found",
    };
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: mkdtempSync(
        join(tmpdir(), "integration-validation-crash-"),
      ),
      provider,
    });
    const input = inputFor(repository, integratedCommit);

    const first = await executor.execute(input);
    const replay = await executor.execute(input);
    assert.equal(first.status, "unknown");
    assert.equal(replay.status, "unknown");
    assert.equal(executes, 1);
  });

  it("dispatches cancellation to the exact provider operation and keeps the result reconcilable", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const cancelled: string[] = [];
    const provider: IntegrationValidationProvider = {
      execute: async (input) => {
        input.onOperationStarted({
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-cancel",
          evidenceRefs: ["provider-started"],
        });
        throw new Error("provider remains externally uncertain");
      },
      inspect: async () => "not-running",
      cancel: async (providerOperationId) => {
        cancelled.push(providerOperationId);
        return "cancelled";
      },
    };
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: mkdtempSync(
        join(tmpdir(), "integration-validation-cancel-"),
      ),
      provider,
    });
    const input = inputFor(repository, integratedCommit);
    await executor.execute(input);

    const result = await executor.cancel!(input);

    assert.deepEqual(cancelled, ["container-cancel"]);
    assert.equal(result.status, "unknown");
    if (result.status === "unknown") {
      assert.equal(
        (result.evidence as { readonly cancellation: string }).cancellation,
        "cancelled",
      );
    }
  });

  it("executes frozen Contract commands and binds fixture plus Runtime evidence on failure", async () => {
    const { repository, integratedCommit } = repositoryFixture();
    const provider: IntegrationValidationProvider = {
      execute: async (input) => {
        assert.deepEqual(input.commands, [["npm", "run", "test:contract"]]);
        input.onOperationStarted({
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-contract",
          evidenceRefs: ["provider-started"],
        });
        return {
          status: "completed",
          exitCode: 1,
          providerId: "sandcastle-docker-validation",
          providerOperationId: "container-contract",
          terminalReceiptHash: "e".repeat(64),
          evidenceRefs: ["runtime-validation-log"],
          output: "contract failed",
        };
      },
      inspect: async () => "not-found",
      cancel: async () => "not-found",
    };
    const executor = openIsolatedIntegrationValidationExecutor({
      evidenceRoot: mkdtempSync(
        join(tmpdir(), "integration-validation-contract-"),
      ),
      provider,
    });

    const result = await executor.execute(
      inputFor(repository, integratedCommit, "contract"),
    );
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.status === "failed" && result.contractFailure
        ? {
            ...result.contractFailure,
            runtimeEvidenceRef: undefined,
          }
        : null,
      {
        producerApplicationId: "application-api",
        consumerApplicationId: "application-web",
        contractId: "contract-api",
        contractVersion: "1",
        fixtureRef: "contract-fixture",
        runtimeEvidenceRef: undefined,
      },
    );
    assert.match(
      result.status === "failed"
        ? (result.contractFailure?.runtimeEvidenceRef ?? "")
        : "",
      /\.log$/,
    );
  });
});
