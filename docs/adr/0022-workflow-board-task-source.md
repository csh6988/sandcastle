# Workflow board: a local observability view and write-back task source

Until now a Sandcastle run could only be observed in the terminal or by tailing
a **run log**. There was no way to see runs at a glance, watch live agent
activity outside the terminal, or assign work without editing files and invoking
the CLI. We add a **workflow board**: a local web view started with
`sandcastle board` that consumes the **runtime event** stream (ADR 0028) to persist
and visualize runs, and that can itself create work — a **board task** — that is
fanned out into per-repository **board runs** via `runWorkspaceTask`.

## Decisions

- **File-backed store, no SQLite native dependency.** Runs, their event streams,
  and tasks are persisted as JSON / NDJSON files under `.sandcastle/board/`. The
  board is an optional, local feature; a native build dependency (e.g.
  `better-sqlite3`) would burden _every_ install of the published package and
  add cross-platform build risk for users who never open the board. The store
  hides this behind a narrow `BoardStore` surface so the engine stays swappable.
  This is a deliberate deviation from the plan's "SQLite" wording.
- **The board is bundled in the CLI, not a separate package.** `sandcastle board`
  must ship in `dist`, so the board store, router, server, and embedded frontend
  live under `src/board/` and are bundled like the rest of the CLI. No extra
  files are added to `package.json#files` (still `dist` only).
- **Frontend embedded as a string.** The React frontend is a single
  self-contained HTML string (React + `htm` from an ESM CDN, no build step). It
  works identically under `tsx` and from the bundled `dist/main.js` with no asset
  copy and nothing extra in the package.
- **Decoupled from the orchestration core.** The HTTP router takes an injected
  `TaskLauncher`; the launcher takes an injected `TaskRunner`. The CLI binds the
  real `runWorkspaceTask` (with the resolved agent, sandbox, and repositories).
  The board modules import only types from the core, keeping them testable
  without a real agent and avoiding a hard coupling to a specific provider.
- **Write-back via the existing workspace task pipeline.** Creating a board task
  triggers `runWorkspaceTask`, which plans and fans the work out per repository.
  Each repo's `run()` forwards its **runtime event** stream through
  `onRepoRuntimeEvent`, recorded into the store and linked to the task. The
  board is therefore a **task** source that reuses the existing pipeline rather
  than introducing a parallel execution path.
- **Local by default.** The server binds to `127.0.0.1`. Remote/team deployment
  is explicitly out of scope for this iteration.

## Considered alternatives

- **Ship a separate `@sandcastle/board` package.** Rejected for now: a bundled
  subcommand is simpler to install and dogfood; the narrow `BoardStore` seam
  leaves extraction possible later.
- **Add `better-sqlite3`.** Rejected: native dependency cost and cross-platform
  build risk for an optional local feature outweigh the query benefits at this
  scale; file-backed storage is adequate and dependency-free.
- **Tail the run log to populate the board.** Rejected: the log is
  human-readable text without stable structure; the runtime event stream is the
  intended structured seam (ADR 0021).

## Consequences

Token _cost_ is intentionally not computed — only token counts are shown — and
no NVIDIA/NIM integration is introduced; usage comes from the existing
`IterationUsage` the agent providers already report. Live SSE updates rely on
the store's in-process subscription, so a board started in one process sees live
updates for runs launched by that process (including its own task launches);
runs written by a separate process appear on refresh. A future iteration can add
file-watching or a shared store for cross-process live updates.
