# Sandcastle desktop

Electron shell around the local Sandcastle control plane (ADR 0027). Lives
outside the core package and is never shipped to npm.

Responsibilities (and nothing more):

- **Company directory management**: selects or creates a local AI company
  directory, keeps company/project data there, and reserves Electron `userData`
  for personal preferences.
- **R&D process management**: when a project uses a linked repository for R&D
  execution, spawns `sandcastle board` for that repository (repo-local
  `node_modules/.bin/sandcastle` first, `SANDCASTLE_CLI` override, this
  checkout's `dist/main.js` as dogfooding fallback), and cleans it up on quit.
- **Shell server**: one local HTTP surface that serves the built renderer,
  and reverse-proxies `/api/*` calls — including the terminal WebSockets — to
  the active board process.
- **Native notifications**: subscribes to the board SSE stream and notifies on
  task succeeded / failed / plan awaiting approval while R&D execution is
  active.
- **Renderer**: a deterministic React project workbench. Desktop v1 is
  Projects-first: Project work moves through PRD, Design, R&D Execution,
  Review, and Artifacts. Repositories are linked R&D resources, not the
  top-level navigation object.

Desktop v1 has no Copilot sidebar, assistant entry point, CopilotKit runtime,
default model, or LLM key loading path. Opening, browsing, editing,
confirming, reviewing, and binding skill flows should not consume LLM tokens.

## Run it

```bash
cd apps/desktop
npm install

# Development (Vite HMR + Electron)
npm run dev

# Packaged-mode run (build renderer + main, then launch Electron)
npm run start

# Unpacked distributable (release/)
npm run dist
```

On first launch the app asks for the local AI company directory, ensures the
`projects/` and `.sandcastle/` structure exists, then opens the shell without
starting a board process. Board process startup is reserved for R&D execution
against a linked repository.

Environment overrides (mainly for scripted runs):

- `SANDCASTLE_DESKTOP_COMPANY_DIR` — skip the company directory picker.
- `SANDCASTLE_DESKTOP_REPO` — temporary R&D compatibility path that starts a
  board process for an explicit repository.
- `SANDCASTLE_DESKTOP_SHELL_PORT` — fix the shell server port.
- `SANDCASTLE_DESKTOP_DEV_URL` — load the window from a Vite dev server.
- `SANDCASTLE_CLI` — explicit path to the sandcastle CLI.

## Layout

- `renderer/` — React UI (Vite).
- `main/` — Electron main process (company directory picker, optional board
  child process, native notifications).
- `server/` — the shell server shared by dev and packaged modes.

## Non-goals

- No CopilotKit in Desktop v1, `src/`, or the shipped package.
- No new orchestration semantics — every action is an existing board endpoint.
- The embedded HTML board (`sandcastle board`) stays the dependency-free
  default UI; the desktop app is an optional shell on top.
