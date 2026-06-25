import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { createTaskLauncher, type TaskRunner } from "./launchTask.js";
import type { RunEvent } from "../RunEvent.js";

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
    const run: TaskRunner = async ({ onRepoRunEvent }) => {
      onRepoRunEvent("web", started("task web", "web"));
      onRepoRunEvent("web", {
        type: "run-finished",
        completionSignal: "<promise>COMPLETE</promise>",
        iterationsRun: 1,
        timestamp: new Date(),
      });
      onRepoRunEvent("api", started("task api", "api"));
      onRepoRunEvent("api", {
        type: "run-finished",
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
    const run: TaskRunner = async ({ onRepoRunEvent }) => {
      onRepoRunEvent("web", started("task web", "web"));
      onRepoRunEvent("web", {
        type: "run-failed",
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
    const run: TaskRunner = async ({ onRepoRunEvent, onPlan }) => {
      onPlan({
        alignmentSummary: "aligned interpretation",
        technicalPlan: "do it carefully",
        repositories: [
          { name: "web", task: "add page", reason: "ui change" },
          { name: "api", task: "add endpoint" },
        ],
      });
      onRepoRunEvent("web", started("task web", "web"));
      onRepoRunEvent("web", {
        type: "run-finished",
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
    expect(updated.plan?.repositories).toEqual([
      { name: "web", task: "add page", reason: "ui change" },
      { name: "api", task: "add endpoint" },
    ]);
  });

  it("records the planner phase as its own run when reported", async () => {
    const run: TaskRunner = async ({ onRepoRunEvent, onPlan }) => {
      onRepoRunEvent("(planner)", started("task planner", "planner"));
      onRepoRunEvent("(planner)", {
        type: "run-finished",
        iterationsRun: 1,
        timestamp: new Date(),
      });
      onPlan({ repositories: [{ name: "web", task: "add page" }] });
      onRepoRunEvent("web", started("task web", "web"));
      onRepoRunEvent("web", {
        type: "run-finished",
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
});
