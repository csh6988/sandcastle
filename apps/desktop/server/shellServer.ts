// Shell server for the desktop app: one HTTP surface that serves the built
// renderer and reverse-proxies /api/* calls (including terminal WebSockets) to
// the real board server.
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  acceptDelivery,
  confirmDesign,
  confirmPrd,
  createProject,
  importProjectDocument,
  listProjects,
  markRdVerified,
  projectDocumentFolder,
  readProjectArtifacts,
  readProjectDocument,
  readProject,
  rejectDelivery,
  requestChanges,
  saveProjectDocument,
  skipDesign,
  startRdExecution,
  type ProjectDocumentKind,
} from "../main/projectStore.js";
import {
  bindSkillFlows,
  createSkillFlow,
  getDepartments,
  listSkillFlows,
} from "../main/skillFlowStore.js";

export interface ShellServerOptions {
  /** Local AI company directory for Desktop-owned project APIs. */
  readonly companyDir?: string;
  /** Native opener supplied by Electron main for folder/artifact actions. */
  readonly openPath?: (path: string) => Promise<void> | void;
  /** Starts or returns a board process for a linked R&D repository. */
  readonly ensureBoardForRepository?: (repoDir: string) => Promise<string>;
  /** Board server URL to proxy /api/* to, e.g. http://127.0.0.1:4318 */
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
  let activeBoardUrl = options.boardUrl;
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/projects", (_req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    res.json({ projects: listProjects(options.companyDir) });
  });

  app.post("/api/projects", (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const body = req.body as {
      readonly name?: unknown;
      readonly summary?: unknown;
      readonly repositories?: unknown;
    };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: "Project name is required." });
      return;
    }
    if (typeof body.summary !== "string") {
      res.status(400).json({ error: "Project summary is required." });
      return;
    }
    const repositories = Array.isArray(body.repositories)
      ? body.repositories.filter(
          (repository): repository is string => typeof repository === "string",
        )
      : [];
    res.status(201).json(
      createProject(options.companyDir, {
        name: body.name,
        summary: body.summary,
        repositories,
      }),
    );
  });

  app.get(/^\/api\/projects\/([^/]+)$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const projectId = decodeURIComponent(req.params[0] ?? "");
    try {
      res.json(readProject(options.companyDir, projectId));
    } catch {
      res.status(404).json({ error: "Project not found." });
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json({
        markdown: readProjectDocument(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
          decodeURIComponent(req.params[1] ?? "") as ProjectDocumentKind,
        ),
      });
    } catch {
      res.status(404).json({ error: "Document not found." });
    }
  });

  app.put(/^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const body = req.body as { readonly markdown?: unknown };
    if (typeof body.markdown !== "string") {
      res.status(400).json({ error: "Markdown is required." });
      return;
    }
    try {
      res.json(
        saveProjectDocument(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
          decodeURIComponent(req.params[1] ?? "") as ProjectDocumentKind,
          body.markdown,
        ),
      );
    } catch {
      res.status(404).json({ error: "Document not found." });
    }
  });

  app.post(
    /^\/api\/projects\/([^/]+)\/documents\/([^/]+)\/import$/,
    (req, res) => {
      if (!options.companyDir) {
        res.status(503).json({ error: "No active company directory." });
        return;
      }
      const body = req.body as { readonly sourcePath?: unknown };
      if (typeof body.sourcePath !== "string") {
        res.status(400).json({ error: "Source path is required." });
        return;
      }
      try {
        res.json(
          importProjectDocument(
            options.companyDir,
            decodeURIComponent(req.params[0] ?? ""),
            decodeURIComponent(req.params[1] ?? "") as ProjectDocumentKind,
            body.sourcePath,
          ),
        );
      } catch {
        res.status(404).json({ error: "Document not found." });
      }
    },
  );

  app.post(
    /^\/api\/projects\/([^/]+)\/documents\/([^/]+)\/open-folder$/,
    async (req, res) => {
      if (!options.companyDir) {
        res.status(503).json({ error: "No active company directory." });
        return;
      }
      if (!options.openPath) {
        res.status(501).json({ error: "Native open is not available." });
        return;
      }
      try {
        const folder = projectDocumentFolder(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
          decodeURIComponent(req.params[1] ?? "") as ProjectDocumentKind,
        );
        await options.openPath(folder);
        res.json({ opened: folder });
      } catch {
        res.status(404).json({ error: "Document not found." });
      }
    },
  );

  app.post(/^\/api\/projects\/([^/]+)\/prd\/confirm$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json(
        confirmPrd(options.companyDir, decodeURIComponent(req.params[0] ?? "")),
      );
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/design\/confirm$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json(
        confirmDesign(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
        ),
      );
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/design\/skip$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const body = req.body as { readonly reason?: unknown };
    try {
      res.json(
        skipDesign(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
          typeof body.reason === "string" ? body.reason : "",
        ),
      );
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/rd\/start$/, async (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const projectId = decodeURIComponent(req.params[0] ?? "");
    try {
      const project = readProject(options.companyDir, projectId);
      if (!activeBoardUrl) {
        const repoDir = project.rd.repositories[0];
        if (!repoDir || !options.ensureBoardForRepository) {
          res.status(503).json({ error: "No active board process." });
          return;
        }
        activeBoardUrl = await options.ensureBoardForRepository(repoDir);
      }
      const prd = readProjectDocument(options.companyDir, projectId, "prd");
      const design =
        project.design.status === "skipped"
          ? `Design skipped: ${project.design.skippedReason}`
          : readProjectDocument(options.companyDir, projectId, "design");
      const boardResponse = await fetch(new URL("/api/tasks", activeBoardUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: project.name,
          prompt: `# Project R&D Execution

Project: ${project.name}

Summary:
${project.summary}

Repositories:
${project.rd.repositories.map((repository) => `- ${repository}`).join("\n") || "- none"}

Confirmed PRD:
${prd}

Design input:
${design}
`,
        }),
      });
      const boardTask = (await boardResponse.json()) as {
        readonly id?: unknown;
      };
      if (!boardResponse.ok || typeof boardTask.id !== "string") {
        res.status(502).json({ error: "Board task creation failed." });
        return;
      }
      res.json(startRdExecution(options.companyDir, projectId, boardTask.id));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/rd\/mark-verified$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const projectId = decodeURIComponent(req.params[0] ?? "");
    const body = req.body as { readonly boardTaskId?: unknown };
    try {
      const project = readProject(options.companyDir, projectId);
      if (project.status !== "in-rd") {
        startRdExecution(
          options.companyDir,
          projectId,
          typeof body.boardTaskId === "string"
            ? body.boardTaskId
            : "board-task",
        );
      }
      res.json(markRdVerified(options.companyDir, projectId));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/review\/accept$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json(
        acceptDelivery(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
        ),
      );
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(
    /^\/api\/projects\/([^/]+)\/review\/request-changes$/,
    (req, res) => {
      if (!options.companyDir) {
        res.status(503).json({ error: "No active company directory." });
        return;
      }
      const body = req.body as { readonly changeScope?: unknown };
      try {
        res.json(
          requestChanges(
            options.companyDir,
            decodeURIComponent(req.params[0] ?? ""),
            typeof body.changeScope === "string"
              ? body.changeScope
              : "Rerun R&D only",
          ),
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(/^\/api\/projects\/([^/]+)\/review\/reject$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json(
        rejectDelivery(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
        ),
      );
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/artifacts$/, (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    try {
      res.json(
        readProjectArtifacts(
          options.companyDir,
          decodeURIComponent(req.params[0] ?? ""),
        ),
      );
    } catch {
      res.status(404).json({ error: "Artifacts not found." });
    }
  });

  app.get("/api/departments", (_req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    res.json({ departments: getDepartments(options.companyDir) });
  });

  app.get("/api/skill-flows", (_req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    res.json({ skillFlows: listSkillFlows(options.companyDir) });
  });

  app.post("/api/skill-flows", (req, res) => {
    if (!options.companyDir) {
      res.status(503).json({ error: "No active company directory." });
      return;
    }
    const body = req.body as {
      readonly name?: unknown;
      readonly skills?: unknown;
    };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: "Skill flow name is required." });
      return;
    }
    res.status(201).json(
      createSkillFlow(options.companyDir, {
        name: body.name,
        skills: Array.isArray(body.skills)
          ? body.skills.filter(
              (skill): skill is string => typeof skill === "string",
            )
          : [],
      }),
    );
  });

  app.put(
    /^\/api\/departments\/([^/]+)\/members\/([^/]+)\/skill-flows$/,
    (req, res) => {
      if (!options.companyDir) {
        res.status(503).json({ error: "No active company directory." });
        return;
      }
      const body = req.body as { readonly flowIds?: unknown };
      res.json({
        departments: bindSkillFlows(options.companyDir, {
          departmentId: decodeURIComponent(req.params[0] ?? ""),
          memberId: decodeURIComponent(req.params[1] ?? ""),
          flowIds: Array.isArray(body.flowIds)
            ? body.flowIds.filter(
                (flowId): flowId is string => typeof flowId === "string",
              )
            : [],
        }),
      });
    },
  );

  // Mounted at the app root with pathFilter (not app.use("/api", ...)) so
  // express does not strip the /api prefix before the request reaches board.
  const boardProxy = createProxyMiddleware({
    target: activeBoardUrl ?? "http://127.0.0.1:9",
    router: () => activeBoardUrl ?? "http://127.0.0.1:9",
    changeOrigin: true,
    ws: true,
    pathFilter: "/api",
  });
  app.use("/api", (_req, res, next) => {
    if (!activeBoardUrl) {
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
  // Terminal sessions upgrade to WebSocket on /api/tasks/:id/.../terminal/ws.
  server.on("upgrade", (req, socket, head) => {
    if (activeBoardUrl && req.url?.startsWith("/api/")) {
      boardProxy.upgrade(req, socket as never, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
};
