# Desktop shell as a project-first local AI company workbench

ADR 0024 deferred the desktop app until the board loop was stable, and ADR 0026
framed Sandcastle v1 as a local AI company control plane whose first complete
department is Software R&D. The CopilotKit board-shell spike proved a React
desktop shell could sit outside the core, but Desktop v1 deliberately removes
the Copilot module so opening, browsing, editing, confirming, reviewing, and
binding skill flows have no default LLM token cost.

This ADR supersedes the Copilot/repository-first desktop spike shape. Desktop
v1 is an Electron-hosted project workbench: the user opens a local AI company
directory, lands on Projects, and uses repositories only as R&D execution
resources attached to a project.

## Decisions

### Desktop = Electron shell, renderer = deterministic project workbench

- The desktop app lives in `apps/desktop/` with its own `package.json`. It is
  **not** published to npm; the shipped package keeps `files: ["dist"]` and
  zero Electron or CopilotKit dependencies in the root package or `src/`.
- Electron remains the shell because Sandcastle is a Node library/CLI: the main
  process can supervise local board processes, open folders/artifacts, and
  persist personal preferences without sidecar machinery.
- The renderer is a deterministic React workbench for the local AI company:
  Projects first, then Departments and Settings. A Project moves through PRD,
  Design, R&D Execution, Review, and Artifacts. A Repository is only an
  external R&D resource linked to a Project.
- Desktop v1 has no Copilot sidebar, assistant entry point, CopilotKit runtime,
  default model, or LLM key loading path. Future AI help must be explicit,
  optional, and cost-visible.

### What the main process owns (and nothing else)

- **Local AI company directory selection**: first launch selects or creates a
  company directory, ensures `projects/` and `.sandcastle/` exist, and persists
  personal preferences such as language and last-opened project in Electron
  `userData`.
- **Board process supervision for R&D only**: when a project starts or resumes
  R&D execution for a linked repository, spawn `sandcastle board --port <free>`
  with that repository as cwd and terminate it on quit. The resolution order
  stays repo-local `node_modules/.bin/sandcastle`, `SANDCASTLE_CLI`, then this
  checkout's `dist/main.js` as the dogfooding fallback.
- **The shell server**: one local HTTP surface serves the built renderer and
  reverse-proxies `/api/*` requests, including terminal WebSocket upgrades, to
  the active board process. It does not host an LLM runtime in v1.
- **Native notifications**: subscribe to the board SSE stream while R&D
  execution is active and notify on task succeeded / failed / plan awaiting
  approval transitions.

### What the desktop app must not own

- No orchestration semantics: R&D execution actions use existing board
  endpoints with unchanged approval, cancellation, recovery, and verification
  gates.
- No board API rewrites: existing board task endpoints keep their current
  semantics; Desktop may add project/company/department APIs beside them.
- No parallel board storage: board state stays in the linked repository's
  `.sandcastle/board` store owned by the board process.
- No replacement of the embedded board: `sandcastle board` keeps its
  dependency-free embedded frontend as the default UI; Desktop is an optional
  project workbench on top of the same orchestration pipeline.

## Consequences

- The first Desktop screen changes from repository selection to local AI
  company directory selection and then Projects.
- Project data and skill-flow configuration live under the local AI company
  directory; Electron `userData` is personal preference storage only.
- The renderer can open, browse, edit, confirm, review, and bind skill flows
  without contacting an LLM endpoint.
- Desktop packaging risk is contained: killing `apps/desktop/` deletes the
  desktop product without touching the library, CLI, board, or docs.
- The board's terminal WebSockets still flow through one proxy hop while R&D is
  active; the shell server must keep `ws` upgrades wired.
- Desktop v1 has a formal Windows distribution target in addition to the
  existing macOS/Linux CI smoke coverage: Windows x64 produces an NSIS
  installer and a `win-unpacked` directory, and `windows-latest` launches the
  unpacked `Sandcastle.exe` through the same Company Runtime BrowserWindow
  smoke. The Windows installer is intentionally unsigned until release
  credentials are available; ARM64, Microsoft code signing, and auto-update
  remain separate release gates.
