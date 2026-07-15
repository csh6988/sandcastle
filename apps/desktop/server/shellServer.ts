// Local HTTP shell for the Electron renderer. Company data flows through the
// authenticated preload bridge; this server only serves static assets and
// retains the optional Board proxy used by the execution compatibility path.
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

export interface ShellServerOptions {
  /** Board server URL to proxy /api/* to, e.g. http://127.0.0.1:4318. */
  readonly boardUrl?: string;
  /** Directory with the built renderer (index.html + assets). */
  readonly rendererDist: string;
  /** Port to listen on; 0 picks a free port. */
  readonly port: number;
}

export interface ShellServerHandle {
  readonly url: string;
  readonly server: Server;
  readonly close: () => Promise<void>;
}

export const startShellServer = async (
  options: ShellServerOptions,
): Promise<ShellServerHandle> => {
  const app = express();
  const boardProxy = createProxyMiddleware({
    target: options.boardUrl ?? "http://127.0.0.1:9",
    changeOrigin: true,
    ws: true,
    pathFilter: "/api",
  });

  app.use("/api", (_req, res, next) => {
    if (!options.boardUrl) {
      res.status(503).json({ error: "No active board process." });
      return;
    }
    next();
  });
  app.use(boardProxy);

  app.use(express.static(options.rendererDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(join(options.rendererDist, "index.html"));
  });

  const server = createServer(app);
  server.on("upgrade", (req, socket, head) => {
    if (options.boardUrl && req.url?.startsWith("/api/")) {
      boardProxy.upgrade(req, socket as never, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
