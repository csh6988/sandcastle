// Electron main process: pick a local AI company directory, optionally run
// `sandcastle board` for an explicit R&D repository compatibility path, run the
// shell server (renderer + board proxy), and surface native notifications. No
// orchestration semantics live here.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { startBoardProcess, type BoardProcessHandle } from "./boardProcess.js";
import {
  createNotificationFilter,
  watchBoardStream,
} from "./boardNotifications.js";
import { ensureCompanyDirectory } from "./companyDirectory.js";
import { createCompanyRuntimeSupervisor } from "./companyRuntimeSupervisor.js";
import { loadConfig, saveConfig } from "./config.js";
import { registerRuntimeIpc } from "./runtimeIpc.js";
import { runRuntimeBrowserWindowSmoke } from "./runtimeBrowserWindowSmoke.js";
import { resolveStartupSelection } from "./startup.js";
import {
  startShellServer,
  type ShellServerHandle,
} from "../server/shellServer.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const devUrl = process.env.SANDCASTLE_DESKTOP_DEV_URL;
const smokeResultPath = process.env.SANDCASTLE_DESKTOP_SMOKE_RESULT_PATH;
const appIconPath = join(desktopRoot, "assets", "sandcastle-icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);
const desktopAppName = "Sandcastle";

app.setName(desktopAppName);
app.setAboutPanelOptions({
  applicationName: desktopAppName,
  applicationVersion: app.getVersion(),
});

let board: BoardProcessHandle | null = null;
let shellServer: ShellServerHandle | null = null;
let window: BrowserWindow | null = null;
let streamAbort: AbortController | null = null;
let runtimeRunning = false;

const log = (line: string): void => {
  process.stdout.write(`[desktop] ${line.trimEnd()}\n`);
};

const runtimeSupervisor = createCompanyRuntimeSupervisor({
  onLog: (line) => log(`company runtime: ${line}`),
});
registerRuntimeIpc(ipcMain, () => runtimeSupervisor);

const pickCompanyDir = async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title: "Select or create the local AI company directory",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

const stopBackend = async (): Promise<void> => {
  streamAbort?.abort();
  streamAbort = null;
  try {
    await shellServer?.close();
  } finally {
    shellServer = null;
    try {
      await board?.stop();
    } finally {
      board = null;
      try {
        await runtimeSupervisor.stop();
      } finally {
        runtimeRunning = false;
      }
    }
  }
};

const startBoardForRepository = async (repoDir: string): Promise<string> => {
  streamAbort?.abort();
  streamAbort = null;
  await board?.stop();
  board = await startBoardProcess({
    repoDir,
    desktopRoot,
    onLog: (line) => log(`board: ${line}`),
  });
  log(`board server for ${repoDir} at ${board.url}`);
  streamAbort = new AbortController();
  const filter = createNotificationFilter();
  watchBoardStream({
    boardUrl: board.url,
    signal: streamAbort.signal,
    onChange: (change) => {
      const notification = filter(change);
      if (notification && Notification.isSupported()) {
        const native = new Notification(notification);
        native.on("click", () => window?.show());
        native.show();
      }
    },
    onError: (error) => log(`stream error: ${String(error)}`),
  });
  buildMenu();
  return board.url;
};

const startBackend = async (args: {
  readonly companyDir: string;
  readonly repoDir?: string;
}): Promise<void> => {
  await stopBackend();
  const company = ensureCompanyDirectory(args.companyDir);
  log(`company directory at ${company.companyDir}`);
  const runtimeHealth = await runtimeSupervisor.start(company.companyDir);
  runtimeRunning = true;
  log(
    `company runtime healthy pid=${runtimeHealth.pid} schema=${runtimeHealth.schemaVersion}`,
  );

  if (args.repoDir) {
    await startBoardForRepository(args.repoDir);
  } else {
    board = null;
    log("no active board process; R&D execution will start one later");
  }

  shellServer = await startShellServer({
    boardUrl: board?.url,
    rendererDist: join(desktopRoot, "dist"),
    port: Number(
      process.env.SANDCASTLE_DESKTOP_SHELL_PORT ?? (devUrl ? 4399 : 0),
    ),
  });
  log(`shell server at ${shellServer.url}`);
  buildMenu();
};

const switchCompany = async (): Promise<void> => {
  const companyDir = await pickCompanyDir();
  if (!companyDir) return;
  const config = loadConfig(app.getPath("userData"));
  saveConfig(app.getPath("userData"), { ...config, companyDir });
  try {
    await startBackend({ companyDir });
    window?.reload();
  } catch (error) {
    dialog.showErrorBox("Failed to open company directory", String(error));
  }
};

const buildMenu = (): void => {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "Local AI Company",
      submenu: [
        {
          label: "Switch Company Directory…",
          accelerator: "CmdOrCtrl+O",
          click: () => void switchCompany(),
        },
        {
          label: "Open Board in Browser",
          enabled: board !== null,
          click: () => {
            if (board) void shell.openExternal(board.url);
          },
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = (): void => {
  window = new BrowserWindow({
    show: !smokeResultPath,
    width: 1440,
    height: 900,
    title: desktopAppName,
    backgroundColor: "#f8fafc",
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, "dist-electron", "preload", "index.js"),
      sandbox: false,
    },
  });
  const url = devUrl ?? shellServer?.url;
  if (url) void window.loadURL(url);
  window.on("closed", () => {
    window = null;
  });
};

app.whenReady().then(async () => {
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }
  buildMenu();
  const config = loadConfig(app.getPath("userData"));
  const selection = resolveStartupSelection(process.env, config);
  let companyDir = selection.companyDir ?? null;
  if (selection.needsCompanyPicker) {
    companyDir = await pickCompanyDir();
    if (!companyDir) {
      app.quit();
      return;
    }
  }
  if (!companyDir) {
    app.quit();
    return;
  }
  saveConfig(app.getPath("userData"), {
    ...config,
    companyDir,
  });
  try {
    await startBackend({
      companyDir,
      repoDir: selection.repoDir,
    });
  } catch (error) {
    dialog.showErrorBox("Failed to open company directory", String(error));
    app.quit();
    return;
  }
  createWindow();
  if (smokeResultPath && window) {
    const smokeWindow = window;
    void (async () => {
      let exitCode = 0;
      try {
        const report = await runRuntimeBrowserWindowSmoke(smokeWindow);
        writeFileSync(
          smokeResultPath,
          `${JSON.stringify({ status: "ok", ...report }, null, 2)}\n`,
        );
      } catch (error) {
        exitCode = 1;
        writeFileSync(
          smokeResultPath,
          `${JSON.stringify({ status: "error", error: String(error) }, null, 2)}\n`,
        );
      } finally {
        await stopBackend();
        app.exit(exitCode);
      }
    })();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (board || shellServer || runtimeRunning) {
    event.preventDefault();
    void stopBackend().then(() => app.exit(0));
  }
});
