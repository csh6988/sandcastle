import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentProvider } from "./AgentProvider.js";
import {
  executeWorkspaceTaskPlan,
  runWorkspaceTask,
} from "./runWorkspaceTask.js";
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
} from "./SandboxProvider.js";
import type { RunEvent } from "./RunEvent.js";

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
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-workspace-task-repo-"));
  await initRepo(dir);
  return dir;
};

const streamResult = (output: string): string =>
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

const createWorkspaceTaskProvider = (
  onAgent: (args: {
    cwd: string;
    prompt: string;
    mounts: ReadonlyMap<string, string>;
  }) => Promise<string>,
) => {
  const createCalls: BindMountCreateOptions[] = [];
  const provider = createBindMountSandboxProvider({
    name: "workspace-task-test",
    create: async (options): Promise<BindMountSandboxHandle> => {
      createCalls.push(options);
      const mounts = new Map(
        options.mounts.map((mount) => [mount.sandboxPath, mount.hostPath]),
      );
      const translateCwd = (cwd?: string) =>
        cwd !== undefined && mounts.has(cwd) ? mounts.get(cwd)! : cwd;
      const defaultSandboxPath =
        options.mounts.find((mount) => mount.hostPath === options.worktreePath)
          ?.sandboxPath ?? "/home/agent/workspace";

      return {
        worktreePath: defaultSandboxPath,
        exec: async (command, execOptions) => {
          const cwd = translateCwd(execOptions?.cwd) ?? options.worktreePath;
          if (command === "agent") {
            const result = await onAgent({
              cwd,
              prompt: execOptions?.stdin ?? "",
              mounts,
            });
            const stdout = streamResult(result);
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
    },
  });
  return { provider, createCalls };
};

describe("runWorkspaceTask", () => {
  it("plans affected repositories and executes only selected repositories", async () => {
    const api = await createRepo();
    const web = await createRepo();
    const executed: string[] = [];
    let executorPrompt = "";
    const { provider } = createWorkspaceTaskProvider(
      async ({ cwd, prompt }) => {
        if (prompt.includes("workspace task planner")) {
          return `<workspace_plan>{"alignment":{"summary":"Expose robot source downstream.","assumptions":["Use existing enum values."],"domainTerms":[{"term":"robot source","meaning":"Provider that handled the robot session."}]},"technicalPlan":"Add the field to the frontend contract and verify display.","repositories":[{"name":"web","task":"Add UI field","reason":"frontend owns UI","issue":{"title":"Add robot source to the UI","body":"Status: ready-for-agent\\n\\n## What to build\\n\\nRender robot source."}}]}</workspace_plan><promise>COMPLETE</promise>`;
        }
        executed.push(cwd);
        executorPrompt = prompt;
        await writeFile(join(cwd, "ui.txt"), "done");
        await execAsync("git add ui.txt && git commit -m web-task", { cwd });
        return "<promise>COMPLETE</promise>";
      },
    );

    const result = await runWorkspaceTask({
      repositories: [
        { name: "api", cwd: api, kind: "backend" },
        { name: "web", cwd: web, kind: "frontend" },
      ],
      prompt: "Add a UI-only field",
      agent: testAgent,
      sandbox: provider,
      branchPrefix: "codex/task",
      logging: { type: "stdout" },
    });

    expect(result.plan.repositories).toEqual([
      {
        name: "web",
        task: "Add UI field",
        reason: "frontend owns UI",
        issue: {
          title: "Add robot source to the UI",
          body: "Status: ready-for-agent\n\n## What to build\n\nRender robot source.",
        },
      },
    ]);
    expect(result.plan.technicalPlan).toBe(
      "Add the field to the frontend contract and verify display.",
    );
    expect(result.plan.alignment).toEqual({
      summary: "Expose robot source downstream.",
      assumptions: ["Use existing enum values."],
      domainTerms: [
        {
          term: "robot source",
          meaning: "Provider that handled the robot session.",
        },
      ],
    });
    expect(result.plan.workspace).toEqual({
      repositories: [
        { name: "api", cwd: api, kind: "backend" },
        { name: "web", cwd: web, kind: "frontend" },
      ],
      branchPrefix: "codex/task",
    });
    expect(Object.keys(result.repositories)).toEqual(["web"]);
    expect(result.repositories.web!.status).toBe("success");
    expect(result.repositories.web!.branch).toBe("codex/task/web");
    expect(result.repositories.web!.commits).toHaveLength(1);
    expect(executorPrompt).toContain("# Add robot source to the UI");
    expect(executorPrompt).toContain("Render robot source.");
    expect(executed).toHaveLength(1);
    const { stdout: apiBranches } = await execAsync("git branch --list", {
      cwd: api,
    });
    expect(apiBranches).not.toContain("codex/task/api");
  });

  it("dryRun returns the plan without executing repository tasks", async () => {
    const api = await createRepo();
    let executorCalls = 0;
    const { provider } = createWorkspaceTaskProvider(async ({ prompt }) => {
      if (prompt.includes("workspace task planner")) {
        return `<workspace_plan>{"repositories":[{"name":"api","task":"Add API"}]}</workspace_plan><promise>COMPLETE</promise>`;
      }
      executorCalls++;
      return "<promise>COMPLETE</promise>";
    });

    const result = await runWorkspaceTask({
      repositories: [{ name: "api", cwd: api, kind: "backend" }],
      prompt: "Add API",
      agent: testAgent,
      sandbox: provider,
      dryRun: true,
      logging: { type: "stdout" },
    });

    expect(result.plan.repositories).toHaveLength(1);
    expect(result.repositories).toEqual({});
    expect(executorCalls).toBe(0);
  });

  it("executes repositories from the planner workspace snapshot", async () => {
    const plannerRepo = await createRepo();
    const web = await createRepo();
    const executed: string[] = [];
    const { provider } = createWorkspaceTaskProvider(
      async ({ cwd, prompt }) => {
        if (prompt.includes("workspace task planner")) {
          return `<workspace_plan>{"workspace":{"repositories":[{"name":"web","cwd":${JSON.stringify(web)},"kind":"frontend"}]},"technicalPlan":"Use the web repository only.","repositories":[{"name":"web","task":"Add page","reason":"PRD only affects UI"}]}</workspace_plan><promise>COMPLETE</promise>`;
        }
        executed.push(cwd);
        await writeFile(join(cwd, "page.txt"), "done");
        await execAsync("git add page.txt && git commit -m web-task", { cwd });
        return "<promise>COMPLETE</promise>";
      },
    );

    const result = await runWorkspaceTask({
      repositories: [{ name: "planner", cwd: plannerRepo }],
      prompt: "Add a page",
      agent: testAgent,
      sandbox: provider,
      allowPlannerWorkspace: true,
      logging: { type: "stdout" },
    });

    expect(result.plan.workspace?.repositories).toEqual([
      { name: "web", cwd: web, kind: "frontend" },
    ]);
    expect(Object.keys(result.repositories)).toEqual(["web"]);
    expect(result.repositories.web!.status).toBe("success");
    expect(executed).toHaveLength(1);
  });

  it("executes an existing workspace plan without running the planner", async () => {
    const api = await createRepo();
    let plannerCalls = 0;
    let executorCalls = 0;
    const { provider } = createWorkspaceTaskProvider(
      async ({ prompt, cwd }) => {
        if (prompt.includes("workspace task planner")) {
          plannerCalls++;
          return `<workspace_plan>{"repositories":[]}</workspace_plan><promise>COMPLETE</promise>`;
        }
        executorCalls++;
        await writeFile(join(cwd, "api.txt"), "done");
        await execAsync("git add api.txt && git commit -m api-task", { cwd });
        return "<promise>COMPLETE</promise>";
      },
    );

    const result = await executeWorkspaceTaskPlan({
      repositories: [{ name: "api", cwd: api, kind: "backend" }],
      plan: {
        technicalPlan: "Use the existing approved plan.",
        repositories: [
          {
            name: "api",
            task: "Add API behavior",
            issue: {
              title: "Add API behavior",
              body: "Status: ready-for-agent\n\nImplement API behavior.",
            },
          },
        ],
      },
      agent: testAgent,
      sandbox: provider,
      branchPrefix: "codex/existing-plan",
      logging: { type: "stdout" },
    });

    expect(plannerCalls).toBe(0);
    expect(executorCalls).toBe(1);
    expect(result.api!.status).toBe("success");
    expect(result.api!.branch).toBe("codex/existing-plan/api");
    expect(result.api!.commits).toHaveLength(1);
  });

  it("rejects duplicate plan repositories before starting repository runs", async () => {
    const api = await createRepo();
    const runEvents: RunEvent[] = [];
    const { provider, createCalls } = createWorkspaceTaskProvider(async () => {
      throw new Error("executor should not start");
    });

    await expect(
      executeWorkspaceTaskPlan({
        repositories: [{ name: "api", cwd: api, kind: "backend" }],
        plan: {
          technicalPlan: "Invalid duplicate plan.",
          repositories: [
            { name: "api", task: "Add first API behavior" },
            { name: "api", task: "Add second API behavior" },
          ],
        },
        agent: testAgent,
        sandbox: provider,
        branchPrefix: "codex/duplicate-plan",
        logging: { type: "stdout" },
        onRepoRunEvent: (_repo, event) => runEvents.push(event),
      }),
    ).rejects.toThrow(
      'Workspace plan contains duplicate repository "api". Combine same-repository issues into one repository entry or use distinct repository names.',
    );

    expect(createCalls).toEqual([]);
    expect(runEvents).toEqual([]);
  });

  it("rejects planner output that references an unknown repository", async () => {
    const api = await createRepo();
    const { provider } = createWorkspaceTaskProvider(async () => {
      return `<workspace_plan>{"repositories":[{"name":"missing","task":"Nope"}]}</workspace_plan><promise>COMPLETE</promise>`;
    });

    await expect(
      runWorkspaceTask({
        repositories: [{ name: "api", cwd: api, kind: "backend" }],
        prompt: "Add API",
        agent: testAgent,
        sandbox: provider,
        logging: { type: "stdout" },
      }),
    ).rejects.toThrow('Planner referenced unknown repository "missing"');
  });
});
