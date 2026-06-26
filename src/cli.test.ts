import { exec } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveBoardPlanningConfig } from "./cli.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("workspace");
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).toContain("podman");
      expect(output).toContain("no-sandbox");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("workspace --help shows run subcommand", async () => {
    const { stdout } = await runCli("workspace --help", process.cwd());
    expect(stdout).toContain("plan");
    expect(stdout).toContain("execute");
    expect(stdout).toContain("run");
  });

  it("--help shows the board command", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("board");
  });

  it("board --help exposes the port and data-dir options", async () => {
    const { stdout } = await runCli("board --help", process.cwd());
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--data-dir");
    expect(stdout).toContain("--workflow");
    expect(stdout).toContain("no-sandbox");
  });

  it("board uses the current repository as planner context when workspace config is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-board-"));

    const resolved = resolveBoardPlanningConfig(
      join(hostDir, ".sandcastle", "workspace.json"),
      hostDir,
      false,
    );

    expect(resolved.configPath).toBe(`${hostDir}#planning-repository`);
    expect(resolved.config.repositories).toEqual([
      { name: basename(hostDir).toLowerCase(), cwd: "." },
    ]);
  });

  it("workspace plan --help exposes PRD input options", async () => {
    const { stdout } = await runCli("workspace plan --help", process.cwd());
    expect(stdout).toContain("--prd");
    expect(stdout).toContain("--prd-file");
    expect(stdout).toContain("--artifacts-dir");
  });

  it("workspace execute --help exposes plan input options", async () => {
    const { stdout } = await runCli("workspace execute --help", process.cwd());
    expect(stdout).toContain("--plan-file");
    expect(stdout).toContain("--artifacts-dir");
  });

  it("workspace execute uses the plan workspace snapshot without requiring workspace config", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workspace-"));
    await mkdir(join(hostDir, ".scratch", "workspace-task"), {
      recursive: true,
    });
    await writeFile(
      join(hostDir, ".scratch", "workspace-task", "workspace-plan.json"),
      JSON.stringify({
        workspace: {
          repositories: [{ name: "other", cwd: "." }],
        },
        repositories: [{ name: "app", task: "Implement app behavior" }],
      }),
    );

    try {
      await runCli("workspace execute", hostDir);
      expect.fail("Expected command to fail before starting an agent");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('unknown repository "app"');
      expect(output).not.toContain("Failed to read workspace config");
      expect(output).not.toContain(".sandcastle/workspace.json");
    }
  });

  it("workspace run --help exposes PRD input options", async () => {
    const { stdout } = await runCli("workspace run --help", process.cwd());
    expect(stdout).toContain("--prd");
    expect(stdout).toContain("--prd-file");
    expect(stdout).toContain("--artifacts-dir");
  });

  it("workspace run uses the only ready local issue as the default prompt file", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workspace-"));
    await mkdir(join(hostDir, ".sandcastle"), { recursive: true });
    await mkdir(join(hostDir, ".scratch", "feature", "issues"), {
      recursive: true,
    });
    await writeFile(
      join(hostDir, ".sandcastle", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "app", cwd: "." },
          { name: "app", cwd: "." },
        ],
      }),
    );
    await writeFile(
      join(hostDir, ".scratch", "feature", "issues", "01-feature.md"),
      "# Feature\n\nStatus: ready-for-agent\n\nImplement it.\n",
    );

    try {
      await runCli("workspace run --dry-run", hostDir);
      expect.fail("Expected command to fail before starting an agent");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('duplicate repository name "app"');
      expect(output).not.toContain("--prompt");
      expect(output).not.toContain("--prompt-file");
    }
  });

  it("workspace run rejects multiple workspace input sources", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workspace-"));
    await mkdir(join(hostDir, ".sandcastle"), { recursive: true });
    await writeFile(
      join(hostDir, ".sandcastle", "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "app", cwd: "." }],
      }),
    );

    try {
      await runCli('workspace run --prd "prd" --prompt "prompt"', hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("Pass only one workspace input source");
      expect(output).toContain("--prompt");
      expect(output).toContain("--prd");
    }
  });

  it("init --help exposes the PRD recording and planning flags", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--prd-file");
    expect(stdout).toContain("--plan");
  });

  it("init records --prd-file into the workspace config", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-init-prd-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await runCli(
      "init --agent claude-code --sandbox docker --issue-tracker github-issues " +
        "--template blank --create-label false --build-image false " +
        "--prd-file docs/prd.md --plan false",
      hostDir,
    );

    const workspaceConfig = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "workspace.json"), "utf-8"),
    ) as { prdFile?: string };
    expect(workspaceConfig.prdFile).toBe("docs/prd.md");
  });

  it("workspace plan falls back to the configured prdFile when no source is passed", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workspace-prd-"));
    await mkdir(join(hostDir, ".sandcastle"), { recursive: true });
    await writeFile(
      join(hostDir, ".sandcastle", "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "app", cwd: "." }],
        prdFile: "missing-prd.md",
      }),
    );

    try {
      await runCli("workspace plan", hostDir);
      expect.fail("Expected command to fail reading the configured PRD");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      // It used the configured prdFile (and failed reading it) rather than
      // falling back to the local-issue lookup.
      expect(output).toContain("missing-prd.md");
      expect(output).not.toContain("No ready local issues");
    }
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).toContain("beads");
      expect(output).toContain("custom");
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
    expect(entries).toContain("workspace.json");
  });

  it("init --sandbox no-sandbox scaffolds without requiring --build-image", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox no-sandbox --issue-tracker beads",
      hostDir,
    );

    expect(stdout).toContain("No sandbox image was generated");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("prompt.md");
    expect(entries).toContain("main.mts");
    expect(entries).not.toContain("Dockerfile");
    expect(entries).not.toContain("Containerfile");
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker custom ignores --build-image and scaffolds without trying to build", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    // --build-image is meaningless for the custom tracker (Dockerfile is
    // deliberately broken until configured) and must be silently ignored
    // rather than fail-fast or attempt a build.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker custom --build-image true",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
  });
});
