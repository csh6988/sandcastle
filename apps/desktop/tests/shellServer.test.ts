import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  startShellServer,
  type ShellServerHandle,
} from "../server/shellServer.js";
import { ensureCompanyDirectory } from "../main/companyDirectory.js";

const handles: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
});

const startBoardStub = async (handler: (url: string, body: string) => void) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      handler(req.url ?? "", body);
      const isCreateTask = req.method === "POST" && req.url === "/api/tasks";
      res.statusCode = isCreateTask ? 201 : 418;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          isCreateTask
            ? { id: "board-task-1" }
            : { proxied: true, url: req.url },
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const handle = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  handles.push(handle);
  return handle;
};

const startShell = async ({
  boardUrl,
  companyDir,
  openPath,
  ensureBoardForRepository,
}: {
  boardUrl?: string;
  companyDir?: string;
  openPath?: (path: string) => void;
  ensureBoardForRepository?: (repoDir: string) => Promise<string>;
}): Promise<ShellServerHandle> => {
  const rendererDist = join(tmpdir(), "sandcastle-desktop-renderer-test");
  mkdirSync(rendererDist, { recursive: true });
  const shell = await startShellServer({
    boardUrl,
    companyDir,
    openPath,
    ensureBoardForRepository,
    rendererDist,
    port: 0,
  });
  handles.push(shell);
  return shell;
};

describe("startShellServer", () => {
  it("starts without an active board process", async () => {
    const shell = await startShell({});

    const response = await fetch(`${shell.url}/api/runs`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "No active board process.",
    });
  });

  it("proxies the former CopilotKit path instead of hosting an LLM runtime", async () => {
    const seenUrls: string[] = [];
    const board = await startBoardStub((url) => seenUrls.push(url));
    const shell = await startShell({ boardUrl: board.url });

    const response = await fetch(`${shell.url}/api/copilotkit`);

    assert.equal(response.status, 418);
    assert.deepEqual(seenUrls, ["/api/copilotkit"]);
  });

  it("serves Desktop project APIs from the company directory", async () => {
    const companyDir = join(tmpdir(), `sandcastle-company-api-${Date.now()}`);
    ensureCompanyDirectory(companyDir);
    const shell = await startShell({ companyDir });

    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Checkout Redesign",
        summary: "Improve checkout.",
        repositories: ["/repo/app"],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { id: string };

    const listResponse = await fetch(`${shell.url}/api/projects`);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as {
      projects: Array<{ id: string; name: string }>;
    };
    assert.deepEqual(
      listed.projects.map((project) => ({
        id: project.id,
        name: project.name,
      })),
      [{ id: created.id, name: "Checkout Redesign" }],
    );

    const detailResponse = await fetch(
      `${shell.url}/api/projects/${created.id}`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as {
      id: string;
      rd: { repositories: string[] };
    };
    assert.equal(detail.id, created.id);
    assert.deepEqual(detail.rd.repositories, ["/repo/app"]);
  });

  it("serves Markdown document save and confirmation APIs", async () => {
    const companyDir = join(tmpdir(), `sandcastle-company-docs-${Date.now()}`);
    ensureCompanyDirectory(companyDir);
    const shell = await startShell({ companyDir });
    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Document Flow",
        summary: "Edit markdown.",
      }),
    });
    const project = (await createdResponse.json()) as { id: string };

    const savePrd = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "# PRD\n" }),
      },
    );
    assert.equal(savePrd.status, 200);

    const postSavePrd = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "# Wrong method\n" }),
      },
    );
    assert.equal(postSavePrd.status, 503);
    assert.deepEqual(await postSavePrd.json(), {
      error: "No active board process.",
    });

    const prdResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd`,
    );
    assert.deepEqual(await prdResponse.json(), { markdown: "# PRD\n" });

    const confirmPrdResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/prd/confirm`,
      { method: "POST" },
    );
    assert.equal(confirmPrdResponse.status, 200);
    const confirmed = (await confirmPrdResponse.json()) as {
      status: string;
      prd: { status: string };
    };
    assert.equal(confirmed.status, "prd-confirmed");
    assert.equal(confirmed.prd.status, "confirmed");

    const skipResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/design/skip`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "No design needed." }),
      },
    );
    assert.equal(skipResponse.status, 200);
    const skipped = (await skipResponse.json()) as {
      status: string;
      design: { status: string; skippedReason: string };
    };
    assert.equal(skipped.status, "design-ready");
    assert.equal(skipped.design.status, "skipped");
    assert.equal(skipped.design.skippedReason, "No design needed.");
  });

  it("imports Markdown documents and opens their containing folders", async () => {
    const companyDir = join(
      tmpdir(),
      `sandcastle-company-import-${Date.now()}`,
    );
    const sourcePath = join(companyDir, "source.md");
    const openedPaths: string[] = [];
    ensureCompanyDirectory(companyDir);
    writeFileSync(sourcePath, "# Imported PRD\n");
    const shell = await startShell({
      companyDir,
      openPath: (path) => openedPaths.push(path),
    });
    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Import Flow",
        summary: "Import markdown.",
      }),
    });
    const project = (await createdResponse.json()) as { id: string };

    const importResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePath }),
      },
    );
    assert.equal(importResponse.status, 200);
    const prdResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd`,
    );
    assert.deepEqual(await prdResponse.json(), {
      markdown: "# Imported PRD\n",
    });

    const openResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/documents/prd/open-folder`,
      { method: "POST" },
    );
    assert.equal(openResponse.status, 200);
    assert.deepEqual(openedPaths, [
      join(companyDir, "projects", project.id, "prd"),
    ]);
  });

  it("starts Project R&D by creating an existing board task", async () => {
    const companyDir = join(tmpdir(), `sandcastle-company-rd-${Date.now()}`);
    const boardRequests: Array<{ url: string; body: unknown }> = [];
    ensureCompanyDirectory(companyDir);
    const board = await startBoardStub((url, body) => {
      boardRequests.push({ url, body: body ? JSON.parse(body) : undefined });
    });
    const shell = await startShell({ companyDir, boardUrl: board.url });
    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "R&D Flow",
        summary: "Execute implementation.",
        repositories: ["/repo/app"],
      }),
    });
    const project = (await createdResponse.json()) as { id: string };
    await fetch(`${shell.url}/api/projects/${project.id}/documents/prd`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# PRD\n" }),
    });
    await fetch(`${shell.url}/api/projects/${project.id}/prd/confirm`, {
      method: "POST",
    });
    await fetch(`${shell.url}/api/projects/${project.id}/design/skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No design needed." }),
    });

    const rdResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/rd/start`,
      { method: "POST" },
    );

    assert.equal(rdResponse.status, 200);
    const inRd = (await rdResponse.json()) as {
      status: string;
      rd: { currentBoardTaskId: string | null };
    };
    assert.equal(inRd.status, "in-rd");
    assert.equal(inRd.rd.currentBoardTaskId, "board-task-1");
    assert.equal(boardRequests[0]?.url, "/api/tasks");
    assert.equal(
      (boardRequests[0]?.body as { title?: string }).title,
      "R&D Flow",
    );
    assert.match(
      (boardRequests[0]?.body as { prompt?: string }).prompt ?? "",
      /# PRD/,
    );
  });

  it("starts a board process for the linked repository when R&D begins", async () => {
    const companyDir = join(
      tmpdir(),
      `sandcastle-company-rd-lazy-${Date.now()}`,
    );
    const requestedRepos: string[] = [];
    ensureCompanyDirectory(companyDir);
    const board = await startBoardStub(() => {});
    const shell = await startShell({
      companyDir,
      ensureBoardForRepository: async (repoDir) => {
        requestedRepos.push(repoDir);
        return board.url;
      },
    });
    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Lazy R&D",
        summary: "Start board on demand.",
        repositories: ["/repo/lazy"],
      }),
    });
    const project = (await createdResponse.json()) as { id: string };
    await fetch(`${shell.url}/api/projects/${project.id}/documents/prd`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# PRD\n" }),
    });
    await fetch(`${shell.url}/api/projects/${project.id}/prd/confirm`, {
      method: "POST",
    });
    await fetch(`${shell.url}/api/projects/${project.id}/design/skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No design needed." }),
    });

    const rdResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/rd/start`,
      { method: "POST" },
    );

    assert.equal(rdResponse.status, 200);
    assert.deepEqual(requestedRepos, ["/repo/lazy"]);
  });

  it("serves Department AI member skill-flow bindings", async () => {
    const companyDir = join(
      tmpdir(),
      `sandcastle-company-skills-${Date.now()}`,
    );
    ensureCompanyDirectory(companyDir);
    const shell = await startShell({ companyDir });

    const createResponse = await fetch(`${shell.url}/api/skill-flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Focused TDD",
        skills: ["tdd", "review"],
      }),
    });
    assert.equal(createResponse.status, 201);
    const flow = (await createResponse.json()) as { id: string };
    assert.equal(flow.id, "focused-tdd");

    const bindResponse = await fetch(
      `${shell.url}/api/departments/software-rnd/members/generator/skill-flows`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowIds: ["focused-tdd"] }),
      },
    );
    assert.equal(bindResponse.status, 200);

    const departmentsResponse = await fetch(`${shell.url}/api/departments`);
    const departments = (await departmentsResponse.json()) as {
      departments: Array<{
        id: string;
        members: Array<{ id: string; skillFlowIds: string[] }>;
      }>;
    };
    const generator = departments.departments
      .find((department) => department.id === "software-rnd")
      ?.members.find((member) => member.id === "generator");
    assert.deepEqual(generator?.skillFlowIds, ["focused-tdd"]);
  });

  it("serves Project review decisions and artifact manifests", async () => {
    const companyDir = join(
      tmpdir(),
      `sandcastle-company-review-${Date.now()}`,
    );
    ensureCompanyDirectory(companyDir);
    const shell = await startShell({ companyDir });
    const createdResponse = await fetch(`${shell.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Review Flow",
        summary: "Review delivery.",
      }),
    });
    const project = (await createdResponse.json()) as { id: string };
    await fetch(`${shell.url}/api/projects/${project.id}/documents/prd`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# PRD\n" }),
    });
    await fetch(`${shell.url}/api/projects/${project.id}/prd/confirm`, {
      method: "POST",
    });
    await fetch(`${shell.url}/api/projects/${project.id}/design/skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No design needed." }),
    });
    await fetch(`${shell.url}/api/projects/${project.id}/rd/mark-verified`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardTaskId: "task-1" }),
    });

    const changesResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/review/request-changes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeScope: "Rerun R&D only" }),
      },
    );
    assert.equal(changesResponse.status, 200);
    assert.equal(
      ((await changesResponse.json()) as { status: string }).status,
      "changes-requested",
    );

    const artifactsResponse = await fetch(
      `${shell.url}/api/projects/${project.id}/artifacts`,
    );
    assert.equal(artifactsResponse.status, 200);
    assert.deepEqual(await artifactsResponse.json(), { artifacts: [] });
  });
});
