import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { createTaskLauncher, type TaskRunner } from "./launchTask.js";
import type { RuntimeEvent } from "../RuntimeEvent.js";

const started = (name: string, repo: string): RuntimeEvent => ({
  type: "run.started",
  runId: "run-1",
  name,
  agent: "claude-code",
  model: "claude-opus-4-8",
  sandbox: "docker",
  branch: `sandcastle/${repo}`,
  maxIterations: 1,
  timestamp: new Date(),
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("createTaskLauncher", () => {
  let dir: string;
  let store: BoardStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-launch-"));
    store = new BoardStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records per-repo runs linked to the task and marks it succeeded", async () => {
    const run: TaskRunner = async ({ onRepoRuntimeEvent }) => {
      onRepoRuntimeEvent("web", started("task web", "web"));
      onRepoRuntimeEvent("web", {
        type: "run.finished",
        runId: "run-1",
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        iterationsRun: 1,
        timestamp: new Date(),
      });
      onRepoRuntimeEvent("api", started("task api", "api"));
      onRepoRuntimeEvent("api", {
        type: "run.finished",
        runId: "run-1",
        commits: [],
        iterationsRun: 1,
        timestamp: new Date(),
      });
      return {
        repositories: {
          web: { status: "success" },
          api: { status: "success" },
        },
      };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "Add X", prompt: "do X" });
    launch(task);
    await flush();

    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.taskId === task.id)).toBe(true);
    expect(new Set(runs.map((r) => r.repo))).toEqual(new Set(["web", "api"]));
    expect(store.getTask(task.id)?.status).toBe("succeeded");
  });

  it("marks the task failed when a repository run fails", async () => {
    const run: TaskRunner = async ({ onRepoRuntimeEvent }) => {
      onRepoRuntimeEvent("web", started("task web", "web"));
      onRepoRuntimeEvent("web", {
        type: "run.error",
        runId: "run-1",
        message: "agent crashed",
        timestamp: new Date(),
      });
      return { repositories: { web: { status: "failed" } } };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "Add Y", prompt: "do Y" });
    launch(task);
    await flush();

    expect(store.getTask(task.id)?.status).toBe("failed");
    const run0 = store.listRuns()[0]!;
    expect(run0.status).toBe("failed");
    expect(run0.error).toBe("agent crashed");
  });

  it("stores the plan on the task as soon as the runner reports it", async () => {
    const run: TaskRunner = async ({ onRepoRuntimeEvent, onPlan }) => {
      onPlan({
        alignmentSummary: "aligned interpretation",
        technicalPlan: "do it carefully",
        workspace: {
          repositories: [{ name: "web", cwd: "/repo/web", kind: "frontend" }],
        },
        repositories: [
          { name: "web", task: "add page", reason: "ui change" },
          { name: "api", task: "add endpoint" },
        ],
      });
      onRepoRuntimeEvent("web", started("task web", "web"));
      onRepoRuntimeEvent("web", {
        type: "run.finished",
        runId: "run-1",
        commits: [],
        iterationsRun: 1,
        timestamp: new Date(),
      });
      return { repositories: { web: { status: "success" } } };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "Plan me", prompt: "do it" });
    launch(task);
    await flush();

    const updated = store.getTask(task.id)!;
    expect(updated.plan?.alignmentSummary).toBe("aligned interpretation");
    expect(updated.plan?.technicalPlan).toBe("do it carefully");
    expect(updated.plan?.workspace).toEqual({
      repositories: [{ name: "web", cwd: "/repo/web", kind: "frontend" }],
    });
    expect(updated.plan?.repositories).toEqual([
      { name: "web", task: "add page", reason: "ui change" },
      { name: "api", task: "add endpoint" },
    ]);
  });

  it("updates the board progress document from repository lifecycle events", async () => {
    const run: TaskRunner = async ({ onRepoRuntimeEvent, onPlan }) => {
      onPlan({ repositories: [{ name: "web", task: "add page" }] });
      onRepoRuntimeEvent("web", started("task web", "web"));
      onRepoRuntimeEvent("web", {
        type: "tool.call",
        runId: "run-1",
        toolCallId: "tool-1",
        name: "ReadFile",
        args: "src/page.ts",
        iteration: 1,
        timestamp: new Date(),
      });
      onRepoRuntimeEvent("web", {
        type: "run.error",
        runId: "run-1",
        message: "verification failed",
        timestamp: new Date(),
      });
      return { repositories: { web: { status: "failed" } } };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "Progress", prompt: "do it" });
    launch(task);
    await flush();

    const progress = store.readTaskProgress(task.id)!;
    expect(progress).toContain("## Repository: web");
    expect(progress).toContain("Status: needs_recovery");
    expect(progress).toContain("tool call: ReadFile src/page.ts");
    expect(progress).toContain("Address the last failure: verification failed");
  });

  it("records the planner phase as its own run when reported", async () => {
    const run: TaskRunner = async ({ onRepoRuntimeEvent, onPlan }) => {
      onRepoRuntimeEvent("(planner)", started("task planner", "planner"));
      onRepoRuntimeEvent("(planner)", {
        type: "run.finished",
        runId: "run-1",
        commits: [],
        iterationsRun: 1,
        timestamp: new Date(),
      });
      onPlan({ repositories: [{ name: "web", task: "add page" }] });
      onRepoRuntimeEvent("web", started("task web", "web"));
      onRepoRuntimeEvent("web", {
        type: "run.finished",
        runId: "run-1",
        commits: [],
        iterationsRun: 1,
        timestamp: new Date(),
      });
      return { repositories: { web: { status: "success" } } };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "With planner", prompt: "do it" });
    launch(task);
    await flush();

    const repos = store.listRuns().map((r) => r.repo);
    expect(new Set(repos)).toEqual(new Set(["(planner)", "web"]));
  });

  it("marks the task failed when the runner throws", async () => {
    const run: TaskRunner = async () => {
      throw new Error("planner failed");
    };
    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({ title: "Z", prompt: "do Z" });
    launch(task);
    await flush();
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("planner failed");
  });

  it("keeps the task running when the workflow pauses for plan approval", async () => {
    const run: TaskRunner = async ({ onPlan }) => {
      onPlan({
        technicalPlan: "Review this before execution.",
        repositories: [
          {
            name: "web",
            task: "Implement the UI",
            issue: {
              title: "Implement the UI",
              body: "Use the approved technical plan.",
            },
          },
        ],
      });
      return {
        repositories: {},
        status: "awaiting-approval",
      };
    };

    const launch = createTaskLauncher({ store, run });
    const task = store.createTask({
      title: "Needs approval",
      prompt: "Plan it",
    });
    launch(task);
    await flush();

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("running");
    expect(updated.workflow?.status).toBe("awaiting-approval");
    expect(updated.plan?.repositories[0]?.issue).toEqual({
      title: "Implement the UI",
      body: "Use the approved technical plan.",
    });
  });
});
