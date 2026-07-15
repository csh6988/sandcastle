# Sandcastle desktop

Electron shell around the local Sandcastle control plane (ADR 0027). Lives
outside the core package and is never shipped to npm.

Responsibilities (and nothing more):

- **Company Runtime supervision**: starts one authenticated local Runtime per
  Company Directory, keeps SQLite as the only v1 company data source, and
  preserves that process across Renderer reloads.
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
- **Renderer**: a Company-first React control plane. Company Overview is the
  default page; Projects and Departments use typed Runtime Commands and
  Queries. The built-in Software R&D Department exposes Runtime-backed
  Overview, editable Department and Position/AI Member configuration, and its
  Pipeline Draft editor. Drafts use optimistic revisions, server-side DAG
  validation, and explicit publish to immutable, SHA-256-addressed Pipeline
  Versions with preserved history. Positions configure a Company-wide Skill
  Catalog subset and persistent, revisioned Skill Flows; AI Task nodes may
  select an active Flow owned by their Position, and publication freezes that
  Flow configuration into the immutable Pipeline Version. Departments own
  revisioned input/output Artifact Contracts and a default Execution Profile;
  AI Task nodes can select a constrained Profile override plus instructions,
  contract references, timeout, retry, and limits. Secret References contain
  only non-sensitive identifiers and provider scope. Custom Departments can
  create, update, and archive Position/AI Member pairs and publish v1 without
  using the historical JSON stores. Departments can be copied or archived.
  Projects expose Runtime-backed name, goal, shared context, repository
  references, optimistic revision updates, and archive behavior without a
  fixed PRD/Design/R&D/Review stage machine. Project detail can start and
  inspect Department Runs. Starting a Run creates an immutable, canonical
  SHA-256 Run Snapshot r1 from the active published Pipeline Version and the
  resolved Project, Department, Position, AI Member, Skill Flow, Execution
  Profile, Secret Reference IDs, Artifact Contracts, limits, and node
  configuration. Department Run, Node Run, Node Attempt, Node feedback, and
  Approval history, Runtime audit/outbox records, and Artifact Version lineage
  are stored in SQLite schema v20 and reload entirely from the
  Company Runtime. The Phase 2 scripted pipeline supports Start, AI Task,
  Human Approval Approve/Request Changes/Reject decisions, declarative
  Condition selection, logical Parallel branches, Join, and Complete without
  invoking a real Agent. Request Changes requires one direct upstream AI Task,
  records immutable feedback, creates a new Attempt against the same Snapshot
  Revision, and returns to Approval after the Attempt succeeds. A failed AI
  Task can be retried manually within its frozen retry allowance, with optional
  feedback; every prior Attempt and failure remains inspectable. AI Task
  execution uses durable Node leases owned by Pipeline Runtime. Claims
  are atomic across workers, renewal and completion require the current lease,
  expired or released work becomes an explicit recoverable failure, and the
  frozen Run concurrency limit is enforced before invoking the Execution
  Adapter. Run controls use optimistic revisions: Pause/Resume persists the
  prior Run state, Cancel invalidates active Attempt ownership, propagates an
  AbortSignal to the Node Handler, waits for it to stop, and rejects late
  results. Condition references use the closed
  `snapshot.<path>` and `nodes.<nodeId>.result.<path>` forms; they never execute
  JavaScript. Parallel makes every dependency-satisfied branch Ready together,
  while the Scripted Execution Adapter executes those Ready nodes sequentially
  in frozen graph order. This is deterministic logical parallelism with
  durable scheduling ownership, not yet concurrent Sandbox or Worktree
  execution in the deterministic Scripted adapter. The opt-in Production
  Execution Adapter reuses the core `run()` and `runWorkspaceTask()` seams for
  Product Alignment, Technical Plan, Repository Implementation, Independent
  Review, and Delivery Verification; non-isolated same-repository work is
  serialized, isolated `head` execution is serialized because it shares the
  host repository, and isolated `branch`/`merge-to-head` execution may run
  concurrently in independent Worktrees.
  Failed AI Tasks can also create Snapshot Revision r2 through a Recovery
  Override limited to provider, model, Sandbox, limits, and validated Secret
  Reference IDs. The prior Snapshot remains immutable, r2 records its parent,
  and the new `recovery` Attempt binds to r2 without consuming the normal Retry
  allowance; goal, Pipeline Version, inputs, and Approval history are not part
  of the Recovery command.

Desktop v1 has no Copilot sidebar, assistant entry point, CopilotKit runtime,
default model, or LLM key loading path. Opening the Company Directory and
managing catalog records does not consume LLM tokens.

## Run it

```bash
cd apps/desktop
npm install

# Development (Vite HMR + Electron)
npm run dev

# 10,000 Run / 100,000 Runtime event local capacity gate
npm run test:runtime-capacity

# Packaged-mode run (build renderer + main, then launch Electron)
npm run start

# Unpacked distributable (release/)
npm run dist
```

On first launch the app asks for the local AI company directory, ensures the
`projects/` and `.sandcastle/` structure exists, starts the Company Runtime,
installs the built-in Software R&D Department catalog and initial published
Pipeline Version through a numbered SQLite migration, and opens Company
Overview without starting a board process. The optional Board child process
remains an execution compatibility adapter, not a company data store or
first-level UI.

Environment overrides (mainly for scripted runs):

- `SANDCASTLE_DESKTOP_COMPANY_DIR` — skip the company directory picker.
- `SANDCASTLE_DESKTOP_REPO` — temporary R&D compatibility path that starts a
  board process for an explicit repository.
- `SANDCASTLE_DESKTOP_SHELL_PORT` — fix the shell server port.
- `SANDCASTLE_DESKTOP_DEV_URL` — load the window from a Vite dev server.
- `SANDCASTLE_CLI` — explicit path to the sandcastle CLI.
- `SANDCASTLE_COMPANY_RUNTIME_EXECUTION_ADAPTER=production` — opt into the
  Production Execution Adapter in the Runtime child process. The default is
  the deterministic Scripted adapter used by smoke tests.

## Layout

- `renderer/` — Company-first React UI (Vite).
- `runtime/` — typed Company Runtime, deep Company Catalog, Project
  Configuration, Pipeline Configuration, Pipeline Runtime, and Skill
  Configuration modules, Scripted and Production Execution Adapters, SQLite adapter,
  migrations, backups, and local IPC server/client.
- `preload/` — allowlisted Runtime bridge for the Renderer.
- `main/` — Electron supervisor, company directory picker, optional Board child
  process, and native notifications.
- `server/` — static Renderer server and optional Board reverse proxy.

## Non-goals

- No CopilotKit in Desktop v1, `src/`, or the shipped package.
- No Company/Project/Department state stored in the historical JSON project
  store.
- The Phase 2 scripted Run tracer remains deterministic and does not invoke a
  real Agent, Sandbox, or Worktree. Production execution is opt-in through the
  Runtime environment. The remaining v1 slices include Artifact Registry,
  RuntimeEvent Outbox, AG-UI, ACP, Memory, or Discussion Topics. Execution
  Profiles and Secret References never store credential values; Run Snapshots
  contain Secret Reference IDs only.
- The embedded HTML board (`sandcastle board`) remains an execution primitive,
  not the Desktop v1 default UI or company data contract.
