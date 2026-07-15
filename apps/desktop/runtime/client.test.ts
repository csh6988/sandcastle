import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocalRuntimeTransport } from "./client.js";

describe("Company Runtime client", () => {
  it("lets Pipeline Runtime own the timeout for long-running execution commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandcastle-runtime-client-"));
    const address = join(directory, "runtime.sock");
    let activeSocket: import("node:net").Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      activeSocket = socket;
      socket.on("error", () => undefined);
      socket.once("data", () => {
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({
              id: "request-1",
              ok: true,
              result: { completed: true },
            })}\n`,
          );
        }, 50);
      });
    });
    server.listen(address);
    await once(server, "listening");

    try {
      const transport = createLocalRuntimeTransport({
        address,
        token: "token",
        timeoutMs: 10,
      });

      const response = await transport.request({
        id: "request-1",
        token: "token",
        kind: "command",
        command: {
          type: "run.execute-ready",
          runId: "run-1",
          expectedRevision: 0,
        },
      });

      assert.deepEqual(response, {
        id: "request-1",
        ok: true,
        result: { completed: true },
      });
    } finally {
      activeSocket?.destroy();
      server.close();
      server.unref();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
