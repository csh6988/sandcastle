import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { BoardStore } from "./BoardStore.js";
import { routeApi, type TaskLauncher, type TaskResumer } from "./router.js";
import { BOARD_FRONTEND_HTML } from "./frontendHtml.js";
import type { BoardTerminalManager } from "./terminalSession.js";

export interface BoardServerOptions {
  readonly store: BoardStore;
  /** Port to listen on. Use 0 for an OS-assigned ephemeral port (tests). */
  readonly port?: number;
  /** Host/interface to bind. Defaults to 127.0.0.1 (local only). */
  readonly host?: string;
  /** Optional launcher invoked when a task is created via the API. */
  readonly launchTask?: TaskLauncher;
  /** Optional resumer invoked when a paused task receives an approval decision. */
  readonly resumeTask?: TaskResumer;
  /** Optional interactive terminal session manager for board tasks. */
  readonly terminalManager?: BoardTerminalManager;
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

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const writeWebSocketText = (socket: Duplex, text: string): void => {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
};

const readWebSocketFrames = (
  chunk: Buffer<ArrayBufferLike>,
  onText: (text: string) => void,
): Buffer<ArrayBufferLike> => {
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const first = chunk[offset]!;
    const second = chunk[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > chunk.length) break;
      length = chunk.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > chunk.length) break;
      const bigLength = chunk.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) break;
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (offset + frameLength > chunk.length) break;
    const mask = masked
      ? chunk.subarray(offset + headerLength, offset + headerLength + 4)
      : undefined;
    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(
      chunk.subarray(payloadStart, payloadStart + length),
    );
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i]! ^ mask[i % 4]!;
      }
    }
    if (opcode === 0x1) onText(payload.toString("utf8"));
    offset += frameLength;
  }
  return chunk.subarray(offset);
};

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
      options.resumeTask,
      options.terminalManager,
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

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/terminal\/ws$/);
    if (!match || !options.terminalManager) {
      socket.destroy();
      return;
    }
    const taskId = decodeURIComponent(match[1]!);
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !options.terminalManager.get(taskId)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const unsubscribe = options.terminalManager.subscribe(taskId, (data) => {
      writeWebSocketText(socket, data);
    });
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = readWebSocketFrames(Buffer.concat([pending, chunk]), (text) => {
        options.terminalManager?.write(taskId, text);
      });
    });
    socket.on("close", () => unsubscribe?.());
    socket.on("error", () => unsubscribe?.());
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
            options.terminalManager?.close();
            server.close(() => res());
          }),
      });
    });
  });
};
