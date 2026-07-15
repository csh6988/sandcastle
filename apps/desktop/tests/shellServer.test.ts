import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  startShellServer,
  type ShellServerHandle,
} from "../server/shellServer.js";

const handles: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
});

const rendererFixture = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-renderer-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), "<main>Company Overview</main>");
  return directory;
};

const startShell = async (boardUrl?: string): Promise<ShellServerHandle> => {
  const shell = await startShellServer({
    boardUrl,
    rendererDist: rendererFixture(),
    port: 0,
  });
  handles.push(shell);
  return shell;
};

describe("startShellServer", () => {
  it("serves the Company renderer for application routes", async () => {
    const shell = await startShell();

    const response = await fetch(`${shell.url}/projects`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Company Overview/);
  });

  it("reports that Board compatibility APIs are unavailable when no board runs", async () => {
    const shell = await startShell();

    const response = await fetch(`${shell.url}/api/tasks`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "No active board process.",
    });
  });

  it("proxies Board compatibility APIs when a board process is active", async () => {
    const board = createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve, reject) => {
      board.once("error", reject);
      board.listen(0, "127.0.0.1", resolve);
    });
    const address = board.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    handles.push({
      close: () =>
        new Promise<void>((resolve) => {
          board.close(() => resolve());
        }),
    });
    const shell = await startShell(`http://127.0.0.1:${address.port}`);

    const response = await fetch(`${shell.url}/api/tasks`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: "/api/tasks" });
  });
});
