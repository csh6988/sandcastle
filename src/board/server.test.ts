import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./BoardStore.js";
import { routeApi } from "./router.js";
import { startBoardServer, type BoardServer } from "./server.js";

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

  it("rejects task creation with missing fields", async () => {
    const res = await routeApi(store, "POST", "/api/tasks", () =>
      Promise.resolve({ title: "" }),
    );
    expect(res?.status).toBe(400);
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
