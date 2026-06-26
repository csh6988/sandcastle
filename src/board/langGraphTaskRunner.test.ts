import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { createLangGraphTaskWorkflow } from "./langGraphTaskRunner.js";
import type { RunEvent } from "../RunEvent.js";
import type { BoardTaskPlan } from "./BoardStore.js";
import type { WorkspaceTaskPlan } from "../runWorkspaceTask.js";

const started = (name: string, repo: string): RunEvent => ({
  type: "run-started",
  name,
  agent: "claude-code",
  model: "claude-opus-4-8",
  sandbox: "docker",
  branch: `sandcastle/${repo}`,
  maxIterations: 1,
  timestamp: new Date(),
});

const finished = (): RunEvent => ({
  type: "run-finished",
  iterationsRun: 1,
  timestamp: new Date(),
});

const failed = (message: string): RunEvent => ({
  type: "run-failed",
  message,
  timestamp: new Date(),
});

describe("createLangGraphTaskWorkflow", () => {
  let dir: string;
  let store: BoardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-langgraph-"));
    store = new BoardStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pauses after planning and resumes approved tasks from the task id checkpoint", async () => {
    const plan: WorkspaceTaskPlan = {
      technicalPlan: "review before execute",
      repositories: [{ name: "web", task: "add page" }],
    };
    const calls: string[] = [];
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      plan: async ({ onPlannerRunEvent }) => {
        calls.push("plan");
        onPlannerRunEvent(started("planner", "planner"));
        onPlannerRunEvent(finished());
        return { plan, plannerStdout: "ok" };
      },
      execute: async ({ onRepoRunEvent }) => {
        calls.push("execute");
        onRepoRunEvent("web", started("web", "web"));
        onRepoRunEvent("web", finished());
        return {
          web: {
            task: "add page",
            status: "success",
            branch: "sandcastle/web",
            commits: [],
          },
        };
      },
    });

    const task = store.createTask({
      title: "Add page",
      prompt: "Please add a page",
    });
    const reportedPlans: BoardTaskPlan[] = [];
    const runResult = await workflow.run({
      taskId: task.id,
      title: "Add page",
      prompt: "Please add a page",
      onPlan: (p) => reportedPlans.push(p),
      onRepoRunEvent: () => {},
    });

    expect(runResult.status).toBe("awaiting-approval");
    expect(reportedPlans).toEqual([plan]);
    expect(store.getTask(task.id)?.workflow?.status).toBe("awaiting-approval");

    const resumed = await workflow.resume(task.id, "approve");

    expect(resumed?.repositories.web?.status).toBe("success");
    expect(calls).toEqual(["plan", "execute"]);
    expect(store.getTask(task.id)?.status).toBe("succeeded");
  });

  it("retries failed repository execution once before aggregating the task result", async () => {
    const plan: WorkspaceTaskPlan = {
      repositories: [{ name: "api", task: "fix endpoint" }],
    };
    let attempts = 0;
    const workflow = createLangGraphTaskWorkflow({
      store,
      checkpointPath: join(dir, "workflows.sqlite"),
      maxRepoRetries: 1,
      plan: async () => ({ plan, plannerStdout: "ok" }),
      execute: async ({ onRepoRunEvent }) => {
        attempts += 1;
        onRepoRunEvent("api", started("api", "api"));
        if (attempts === 1) {
          onRepoRunEvent("api", failed("temporary failure"));
          return {
            api: {
              task: "fix endpoint",
              status: "failed",
              branch: "sandcastle/api",
              commits: [],
              error: "temporary failure",
            },
          };
        }
        onRepoRunEvent("api", finished());
        return {
          api: {
            task: "fix endpoint",
            status: "success",
            branch: "sandcastle/api",
            commits: [],
          },
        };
      },
    });

    store.createTask({ title: "Fix endpoint", prompt: "Fix it" });
    await workflow.run({
      taskId: store.listTasks()[0]!.id,
      title: "Fix endpoint",
      prompt: "Fix it",
      onPlan: () => {},
      onRepoRunEvent: () => {},
    });

    const result = await workflow.resume(store.listTasks()[0]!.id, "approve");

    expect(attempts).toBe(2);
    expect(result?.repositories.api?.status).toBe("success");
  });
});
