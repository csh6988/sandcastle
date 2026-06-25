import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BoardStore } from "./BoardStore.js";
import { routeApi, type TaskLauncher } from "./router.js";
import { BOARD_FRONTEND_HTML } from "./frontendHtml.js";

export interface BoardServerOptions {
  readonly store: BoardStore;
  /** Port to listen on. Use 0 for an OS-assigned ephemeral port (tests). */
  readonly port?: number;
  /** Host/interface to bind. Defaults to 127.0.0.1 (local only). */
  readonly host?: string;
  /** Optional launcher invoked when a task is created via the API. */
  readonly launchTask?: TaskLauncher;
}

export interface BoardServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

/**
 * Start the local workflow-board HTTP server.
 *
 * Serves the self-contained frontend at `/`, a small JSON REST API under
 * `/api/*`, and a Server-Sent Events stream at `/api/stream` that replays
 * existing runs and then pushes live board changes from the store's in-process
 * subscription. Binds to localhost by default.
 */
export const startBoardServer = (
  options: BoardServerOptions,
): Promise<BoardServer> => {
  const { store } = options;
  const host = options.host ?? "127.0.0.1";

  // Surface runs/tasks written by other processes to the same board directory.
  store.startWatching();

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Server-Sent Events: replay then live-stream board changes.
    if (method === "GET" && pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `event: snapshot\ndata: ${JSON.stringify(store.listRuns())}\n\n`,
      );
      const unsubscribe = store.subscribe((change) => {
        res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
      });
      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      return;
    }

    void routeApi(
      store,
      method,
      pathname,
      () => readBody(req),
      options.launchTask,
    ).then((apiResponse) => {
      if (apiResponse) {
        const payload = JSON.stringify(apiResponse.body);
        res.writeHead(apiResponse.status, {
          "content-type": "application/json",
        });
        res.end(payload);
        return;
      }
      // Fall through: serve the frontend for any non-API GET.
      if (method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(BOARD_FRONTEND_HTML);
        return;
      }
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
    });
  });

  return new Promise<BoardServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 4318, host, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      resolve({
        server,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((res) => {
            store.close();
            server.close(() => res());
          }),
      });
    });
  });
};
