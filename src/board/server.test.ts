import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore, type BoardTaskWorkflowPhase } from "./BoardStore.js";
import { routeApi } from "./router.js";
import { startBoardServer, type BoardServer } from "./server.js";
import type { BoardTerminalManager } from "./terminalSession.js";

const noBody = () => Promise.resolve({});

describe("routeApi", () => {
  let dir: string;
  let store: BoardStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-router-"));
    store = new BoardStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns undefined for non-API paths so the HTTP layer serves the frontend", async () => {
    expect(await routeApi(store, "GET", "/", noBody)).toBeUndefined();
    expect(await routeApi(store, "GET", "/anything", noBody)).toBeUndefined();
  });

  it("lists runs", async () => {
    store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    const res = await routeApi(store, "GET", "/api/runs", noBody);
    expect(res?.status).toBe(200);
    expect((res?.body as unknown[]).length).toBe(1);
  });

  it("returns a single run, its events and usage", async () => {
    const run = store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    store.recordEvent(run.id, {
      type: "usage",
      usage: {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 2,
      },
      model: "claude-opus-4-8",
      iteration: 1,
      timestamp: new Date(),
    });
    expect(
      (await routeApi(store, "GET", `/api/runs/${run.id}`, noBody))?.status,
    ).toBe(200);
    const events = await routeApi(
      store,
      "GET",
      `/api/runs/${run.id}/events`,
      noBody,
    );
    expect((events?.body as unknown[]).length).toBe(1);
    const usage = await routeApi(
      store,
      "GET",
      `/api/runs/${run.id}/usage`,
      noBody,
    );
    expect((usage?.body as { model: string }[])[0]!.model).toBe(
      "claude-opus-4-8",
    );
  });

  it("404s an unknown run", async () => {
    const res = await routeApi(
      store,
      "GET",
      "/api/runs/does-not-exist",
      noBody,
    );
    expect(res?.status).toBe(404);
  });

  it("creates a task and invokes the launcher", async () => {
    const launched: string[] = [];
    const res = await routeApi(
      store,
      "POST",
      "/api/tasks",
      () => Promise.resolve({ title: "Add feature", prompt: "do it" }),
      (task) => launched.push(task.id),
    );
    expect(res?.status).toBe(201);
    const created = res?.body as { id: string; title: string };
    expect(created.title).toBe("Add feature");
    expect(launched).toEqual([created.id]);
  });

  it("returns tasks with a stable display stage", async () => {
    const task = store.createTask({ title: "Stage me", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "creating-issues",
        currentPhase: "creating-issues",
        substatus: "fixing-workspace-plan",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const list = await routeApi(store, "GET", "/api/tasks", noBody);
    expect(
      (list?.body as Array<{ stage: { label: string } }>)[0],
    ).toMatchObject({
      stage: {
        label: "Fix workspace plan",
        mode: "interactive",
        terminalPhase: "creating-issues",
      },
    });

    const single = await routeApi(
      store,
      "GET",
      `/api/tasks/${task.id}`,
      noBody,
    );
    expect(single?.body).toMatchObject({
      id: task.id,
      stage: {
        label: "Fix workspace plan",
        canComplete: true,
        canCancel: true,
      },
    });
  });

  it("returns a board task progress document", async () => {
    const task = store.createTask({ title: "Progress", prompt: "do it" });
    store.updateTask(task.id, {
      plan: {
        repositories: [{ name: "web", task: "add page" }],
      },
    });

    const res = await routeApi(
      store,
      "GET",
      `/api/tasks/${task.id}/progress`,
      noBody,
    );

    expect(res?.status).toBe(200);
    expect((res?.body as { markdown: string }).markdown).toContain(
      "# Board Execution Progress",
    );
  });

  it("404s missing board task progress", async () => {
    const task = store.createTask({ title: "No progress", prompt: "do it" });

    const res = await routeApi(
      store,
      "GET",
      `/api/tasks/${task.id}/progress`,
      noBody,
    );

    expect(res?.status).toBe(404);
    expect(res?.body).toEqual({ error: "task progress not found" });
  });

  it("rejects task creation with missing fields", async () => {
    const res = await routeApi(store, "POST", "/api/tasks", () =>
      Promise.resolve({ title: "" }),
    );
    expect(res?.status).toBe(400);
  });

  it("resumes a paused task with an approval decision", async () => {
    const task = store.createTask({ title: "Approve me", prompt: "do it" });
    const resumed: Array<{ id: string; decision: string }> = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/resume`,
      () => Promise.resolve({ decision: "approve" }),
      undefined,
      (t, decision) => resumed.push({ id: t.id, decision }),
    );

    expect(res?.status).toBe(202);
    expect(resumed).toEqual([{ id: task.id, decision: "approve" }]);
  });

  it("returns phase terminal status and resizes a running phase terminal", async () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    const phase: BoardTaskWorkflowPhase = "classifying";
    const resized: Array<{
      id: string;
      phase: BoardTaskWorkflowPhase;
      cols: number;
      rows: number;
    }> = [];
    const terminalManager = {
      getPhase: (id: string, requestedPhase: BoardTaskWorkflowPhase) =>
        id === task.id && requestedPhase === phase
          ? { taskId: task.id, phase, status: "running" }
          : undefined,
      resizePhase: (
        id: string,
        requestedPhase: BoardTaskWorkflowPhase,
        cols: number,
        rows: number,
      ) => {
        resized.push({ id, phase: requestedPhase, cols, rows });
        return true;
      },
    } as unknown as BoardTerminalManager;

    const status = await routeApi(
      store,
      "GET",
      `/api/tasks/${task.id}/phases/${phase}/terminal`,
      noBody,
      undefined,
      undefined,
      terminalManager,
    );
    expect(status?.body).toMatchObject({
      taskId: task.id,
      phase,
      status: "running",
    });

    const resize = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/phases/${phase}/terminal/resize`,
      () => Promise.resolve({ cols: 80, rows: 24 }),
      undefined,
      undefined,
      terminalManager,
    );
    expect(resize?.status).toBe(202);
    expect(resized).toEqual([{ id: task.id, phase, cols: 80, rows: 24 }]);
  });

  it("completes a workflow phase through the phase API", async () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    const completed: Array<{ id: string; phase: BoardTaskWorkflowPhase }> = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/phases/classifying/complete`,
      noBody,
      undefined,
      undefined,
      undefined,
      (t, phase) => completed.push({ id: t.id, phase }),
    );

    expect(res?.status).toBe(202);
    expect(completed).toEqual([{ id: task.id, phase: "classifying" }]);
  });

  it("passes an inline workspace plan through the phase completion API", async () => {
    const task = store.createTask({ title: "Interactive", prompt: "do it" });
    const completed: Array<{
      id: string;
      phase: BoardTaskWorkflowPhase;
      workspacePlanText?: string;
    }> = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/phases/creating-issues/complete`,
      () =>
        Promise.resolve({
          workspacePlan: { repositories: [{ name: "web", task: "Do it" }] },
        }),
      undefined,
      undefined,
      undefined,
      (t, phase, options) =>
        completed.push({
          id: t.id,
          phase,
          workspacePlanText: options?.workspacePlanText,
        }),
    );

    expect(res?.status).toBe(202);
    expect(completed).toEqual([
      {
        id: task.id,
        phase: "creating-issues",
        workspacePlanText:
          '<workspace_plan>{"repositories":[{"name":"web","task":"Do it"}]}</workspace_plan>',
      },
    ]);
  });

  it("recovers a failed task when its error is a persisted phase interrupt", async () => {
    const task = store.createTask({ title: "Recover", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      error: JSON.stringify([
        {
          id: "interrupt-id",
          value: { taskId: task.id, title: task.title, phase: "aligning-prd" },
        },
      ]),
    });
    const recovered: string[] = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/recover`,
      noBody,
      undefined,
      undefined,
      undefined,
      undefined,
      (t) => recovered.push(t.id),
    );

    expect(res?.status).toBe(202);
    expect(res?.body).toEqual({
      status: "recovering",
      phase: "aligning-prd",
    });
    expect(recovered).toEqual([task.id]);
  });

  it("does not recover a failed task without a recoverable workflow phase", async () => {
    const task = store.createTask({ title: "Failed", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      error: "One or more repository executions failed.",
      workflow: {
        status: "failed",
        currentPhase: "running",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/recover`,
      noBody,
    );

    expect(res?.status).toBe(409);
    expect(res?.body).toEqual({ error: "task failure is not recoverable" });
  });

  it("recovers a failed transient workflow error from the latest interactive phase session", async () => {
    const task = store.createTask({ title: "Retry planner", prompt: "do it" });
    store.updateTask(task.id, {
      status: "failed",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds",
      workflow: {
        status: "failed",
        phaseSessions: {
          "creating-issues": {
            taskId: task.id,
            phase: "creating-issues",
            pid: 123,
            status: "exited",
            startedAt: "2026-06-26T06:50:00.000Z",
          },
        },
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });
    const recovered: string[] = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/recover`,
      noBody,
      undefined,
      undefined,
      undefined,
      undefined,
      (t) => recovered.push(t.id),
    );

    expect(res?.status).toBe(202);
    expect(res?.body).toEqual({
      status: "recovering",
      phase: "creating-issues",
    });
    expect(recovered).toEqual([task.id]);
  });

  it("recovers old planner idle failures without phase metadata as creating-issues", async () => {
    const task = store.createTask({
      title: "Old planner timeout",
      prompt: "do it",
    });
    store.updateTask(task.id, {
      status: "failed",
      error:
        "runWorkspace repository failed on branch sandcastle/planner: Agent idle for 90 seconds — no output received.",
      workflow: {
        status: "failed",
        checkpointThreadId: task.id,
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/recover`,
      noBody,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
    );

    expect(res?.status).toBe(202);
    expect(res?.body).toEqual({
      status: "recovering",
      phase: "creating-issues",
    });
  });

  it("cancels a running workflow task through the task API", async () => {
    const task = store.createTask({ title: "Cancel me", prompt: "do it" });
    store.updateTask(task.id, {
      status: "running",
      workflow: {
        status: "planning",
        currentPhase: "creating-issues",
        updatedAt: "2026-06-26T07:00:00.000Z",
      },
    });
    const cancelled: string[] = [];

    const res = await routeApi(
      store,
      "POST",
      `/api/tasks/${task.id}/cancel`,
      noBody,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (t) => cancelled.push(t.id),
    );

    expect(res?.status).toBe(202);
    expect(res?.body).toEqual({ status: "cancelling" });
    expect(cancelled).toEqual([task.id]);
  });
});

describe("startBoardServer", () => {
  let dir: string;
  let store: BoardStore;
  let server: BoardServer;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "board-http-"));
    store = new BoardStore(dir);
    server = await startBoardServer({ store, port: 0 });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the frontend HTML at the root", async () => {
    const res = await fetch(server.url + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Sandcastle Board");
    expect(body).toContain("Managed agent console");
    expect(body).toContain("--glow");
    expect(body).toContain("return html`");
    expect(body).not.toContain("html\\`");
    expect(body).not.toMatch(/\sstyle="/);
  });

  it("serves board controls for overview and task-level details", async () => {
    const res = await fetch(server.url + "/");
    const body = await res.text();
    expect(body).toContain("Task overview");
    expect(body).toContain("Task details");
    expect(body).toContain("Current stage");
    expect(body).toContain("Workflow timeline");
    expect(body).toContain("Task activity");
    expect(body).toContain("readonly terminal");
    expect(body).toContain("currentIteration");
    expect(body).toContain("last: ");
    expect(body).toContain("resize-handle");
    expect(body).toContain("Phase terminal");
    expect(body).toContain("Complete phase");
    expect(body).toContain(
      "Completion signal sent. Waiting for workflow update…",
    );
    expect(body).toContain("Cancel issue generation");
    expect(body).toContain("Validating workspace plan");
    expect(body).toContain("Fix workspace plan");
    expect(body).toContain("Recover / Continue from failed phase");
    expect(body).toContain("Approve plan");
    expect(body).toContain("Board issue");
    expect(body).toContain("Task failed before any repository run started.");
    expect(body).not.toContain(
      "No interactive terminal session is attached to this task.",
    );
    expect(body).not.toContain('"phase " + currentPhase');
  });

  it("serves the runs API as JSON", async () => {
    store.createRun({
      name: "r1",
      agent: "claude-code",
      sandbox: "docker",
      branch: "main",
      maxIterations: 1,
    });
    const res = await fetch(server.url + "/api/runs");
    expect(res.headers.get("content-type")).toContain("application/json");
    const runs = (await res.json()) as unknown[];
    expect(runs.length).toBe(1);
  });

  it("creates a task over HTTP", async () => {
    const res = await fetch(server.url + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T", prompt: "P" }),
    });
    expect(res.status).toBe(201);
    expect(store.listTasks().length).toBe(1);
  });

  it("streams a snapshot over SSE", async () => {
    const controller = new AbortController();
    const res = await fetch(server.url + "/api/stream", {
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
