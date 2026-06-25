import { exec } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentProvider } from "./AgentProvider.js";
import { runWorkspace } from "./runWorkspace.js";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
} from "./SandboxProvider.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "README.md"), "# Test\n");
  await execAsync("git add README.md", { cwd: dir });
  await execAsync('git commit -m "initial"', { cwd: dir });
};

const createRepo = async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-workspace-repo-"));
  await initRepo(dir);
  return dir;
};

const workspaceAgentOutput = (output: string): string =>
  JSON.stringify({ type: "result", result: output });

const testAgent: AgentProvider = {
  name: "test-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: ({ prompt }) => ({ command: "agent", stdin: prompt }),
  parseStreamLine: (line) => {
    const parsed = JSON.parse(line) as { result?: string };
    return typeof parsed.result === "string"
      ? [{ type: "result", result: parsed.result }]
      : [];
  },
};

const createWorkspaceProvider = (
  onAgent: (args: {
    cwd: string;
    prompt: string;
    mounts: ReadonlyMap<string, string>;
  }) => Promise<string>,
) => {
  const createCalls: BindMountCreateOptions[] = [];
  const provider = createBindMountSandboxProvider({
    name: "workspace-test",
    create: async (options): Promise<BindMountSandboxHandle> => {
      createCalls.push(options);
      const mounts = new Map(
        options.mounts.map((mount) => [mount.sandboxPath, mount.hostPath]),
      );
      const translateCwd = (cwd?: string) =>
        cwd !== undefined && mounts.has(cwd) ? mounts.get(cwd)! : cwd;
      const primarySandboxPath =
        options.mounts.find((mount) => mount.hostPath === options.worktreePath)
          ?.sandboxPath ?? "/home/agent/workspace";
      const handle: BindMountSandboxHandle = {
        worktreePath: primarySandboxPath,
        exec: async (command, execOptions) => {
          const cwd = translateCwd(execOptions?.cwd) ?? options.worktreePath;
          if (command === "agent") {
            const result = await onAgent({
              cwd,
              prompt: execOptions?.stdin ?? "",
              mounts,
            });
            const stdout = workspaceAgentOutput(result);
            execOptions?.onLine?.(stdout);
            return { stdout, stderr: "", exitCode: 0 };
          }
          const { stdout, stderr } = await execAsync(command, { cwd });
          return { stdout, stderr, exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
      return handle;
    },
  });
  return { provider, createCalls };
};

describe("runWorkspace", () => {
  it("creates a worktree and sandbox mount for each repository", async () => {
    const core = await createRepo();
    const web = await createRepo();
    let seenPrompt = "";
    const { provider, createCalls } = createWorkspaceProvider(
      async ({ prompt }) => {
        seenPrompt = prompt;
        return "<promise>COMPLETE</promise>";
      },
    );

    const result = await runWorkspace({
      repositories: [
        {
          name: "core",
          cwd: core,
          branchStrategy: { type: "branch", branch: "codex/core" },
        },
        {
          name: "web",
          cwd: web,
          branchStrategy: { type: "branch", branch: "codex/web" },
        },
      ],
      primaryRepository: "core",
      agent: testAgent,
      sandbox: provider,
      prompt: "work across repos",
      logging: { type: "stdout" },
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sandboxPath: "/home/agent/repos/core" }),
        expect.objectContaining({ sandboxPath: "/home/agent/repos/web" }),
      ]),
    );
    expect(result.repositories.core!.worktreePath).toContain(
      ".sandcastle/worktrees/codex-core",
    );
    expect(result.repositories.web!.worktreePath).toContain(
      ".sandcastle/worktrees/codex-web",
    );
    expect(seenPrompt).toContain("Sandcastle workspace repositories:");
    expect(seenPrompt).toContain(
      "- core (primary): /home/agent/repos/core on branch codex/core",
    );
    expect(seenPrompt).toContain(
      "- web: /home/agent/repos/web on branch codex/web",
    );
  });

  it("returns commits grouped by repository", async () => {
    const core = await createRepo();
    const web = await createRepo();
    const { provider } = createWorkspaceProvider(async ({ cwd, mounts }) => {
      const webCwd = mounts.get("/home/agent/repos/web")!;
      writeFileSync(join(cwd, "core.txt"), "core");
      await execAsync("git add core.txt && git commit -m core-change", {
        cwd,
      });
      writeFileSync(join(webCwd, "web.txt"), "web");
      await execAsync("git add web.txt && git commit -m web-change", {
        cwd: webCwd,
      });
      return "<promise>COMPLETE</promise>";
    });

    const result = await runWorkspace({
      repositories: [
        {
          name: "core",
          cwd: core,
          branchStrategy: { type: "branch", branch: "codex/core-change" },
        },
        {
          name: "web",
          cwd: web,
          branchStrategy: { type: "branch", branch: "codex/web-change" },
        },
      ],
      primaryRepository: "core",
      agent: testAgent,
      sandbox: provider,
      prompt: "commit in both repos",
      logging: { type: "stdout" },
    });

    expect(result.repositories.core!.commits).toHaveLength(1);
    expect(result.repositories.web!.commits).toHaveLength(1);

    const { stdout: coreMessage } = await execAsync(
      "git log -1 --format=%s codex/core-change",
      { cwd: core },
    );
    const { stdout: webMessage } = await execAsync(
      "git log -1 --format=%s codex/web-change",
      { cwd: web },
    );
    expect(coreMessage.trim()).toBe("core-change");
    expect(webMessage.trim()).toBe("web-change");
  });

  it("preserves only the dirty repository worktree", async () => {
    const core = await createRepo();
    const web = await createRepo();
    const { provider } = createWorkspaceProvider(async ({ mounts }) => {
      const webCwd = mounts.get("/home/agent/repos/web")!;
      writeFileSync(join(webCwd, "dirty.txt"), "dirty");
      return "<promise>COMPLETE</promise>";
    });

    const result = await runWorkspace({
      repositories: [
        {
          name: "core",
          cwd: core,
          branchStrategy: { type: "branch", branch: "codex/clean-core" },
        },
        {
          name: "web",
          cwd: web,
          branchStrategy: { type: "branch", branch: "codex/dirty-web" },
        },
      ],
      primaryRepository: "core",
      agent: testAgent,
      sandbox: provider,
      prompt: "leave one repo dirty",
      logging: { type: "stdout" },
    });

    expect(result.repositories.core!.preservedWorktreePath).toBeUndefined();
    expect(result.repositories.web!.preservedWorktreePath).toBeDefined();
    expect(existsSync(result.repositories.core!.worktreePath)).toBe(false);
    expect(existsSync(result.repositories.web!.worktreePath)).toBe(true);
    expect(
      readFileSync(
        join(result.repositories.web!.worktreePath, "dirty.txt"),
        "utf-8",
      ),
    ).toBe("dirty");
  });

  it("throws clear validation errors for invalid workspace options", async () => {
    const repo = await createRepo();
    const missing = join(
      mkdtempSync(join(tmpdir(), "missing-parent-")),
      "nope",
    );
    const { provider } = createWorkspaceProvider(async () => {
      return "<promise>COMPLETE</promise>";
    });

    await expect(
      runWorkspace({
        repositories: [
          { name: "repo", cwd: repo },
          { name: "repo", cwd: repo },
        ],
        primaryRepository: "repo",
        agent: testAgent,
        sandbox: provider,
        prompt: "x",
        logging: { type: "stdout" },
      }),
    ).rejects.toThrow('duplicate repository name "repo"');

    await expect(
      runWorkspace({
        repositories: [{ name: "repo", cwd: repo }],
        primaryRepository: "other",
        agent: testAgent,
        sandbox: provider,
        prompt: "x",
        logging: { type: "stdout" },
      }),
    ).rejects.toThrow('primaryRepository "other" was not found');

    await expect(
      runWorkspace({
        repositories: [{ name: "repo", cwd: missing }],
        primaryRepository: "repo",
        agent: testAgent,
        sandbox: provider,
        prompt: "x",
        logging: { type: "stdout" },
      }),
    ).rejects.toThrow("cwd does not exist");

    const isolated = createIsolatedSandboxProvider({
      name: "isolated-test",
      create: async () => {
        throw new Error("should not start");
      },
    });

    await expect(
      runWorkspace({
        repositories: [{ name: "repo", cwd: repo }],
        primaryRepository: "repo",
        agent: testAgent,
        sandbox: isolated,
        prompt: "x",
        logging: { type: "stdout" },
      }),
    ).rejects.toThrow("bind-mount sandbox providers only");
  });
});
