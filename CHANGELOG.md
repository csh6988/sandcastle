# @ai-hero/sandcastle

## 0.14.0

### Minor Changes

- 3b73cb9: Make Planner / Generator / Evaluator role profiles explicit configuration. Built-in defaults define each role's responsibility, allowed/forbidden actions, and progressive skill flows; `.sandcastle/role-profiles.json` overrides any subset per role (invalid files fail fast at board startup). The resolved profiles are rendered into the Planner phase prompts, the Generator execution prompt, and the Evaluator verification prompt, and served at `GET /api/role-profiles` for the board Settings view. Agent/model preferences are advisory in v1.
- 2294fcb: Add durable multi-repository Integration Generations that consume exact independent Code Review coverage, apply reviewed changes on protected generation branches with restart-safe Git receipts, record validation and Integration defects, and expose aggregate PASS authority through the Desktop Runtime Query and event surfaces.
- 3b73cb9: Add the v1 company control plane shell to the board (ADR 0026): a company-level left navigation (Departments / Projects / Artifacts / Reviews / Settings) that defaults into the Software R&D department, backed by new `GET /api/company`, `GET /api/artifacts`, `GET /api/reviews`, and `GET /api/role-profiles` endpoints. Non-software departments are inert placeholders.
- 69a381b: Expose a bidirectional local ACP stdio facade with session load, durable Runtime Event replay, correlated outbound permissions, and stable Interaction Turn cancellation through the authenticated Company Runtime.
- 69a381b: Add AG-UI mapping and durable Runtime event cursor replay for Desktop reconnects, including stable cursor-expired errors.
- 6901343: Add local Agent discovery and safe non-interactive testing, independent Skills management with configurable directories, ordered fuzzy search, source references, and declared capability warnings, Position-level Agent and Skill configuration, versioned Skill snapshots, compact Position drawers, and separate Department overview and settings with one explicit save action in Desktop Company Runtime.
- 69a381b: Add explicit Artifact Version registration, content integrity, acceptance transitions, input lineage, and Runtime-backed Artifact inspection.
- 69a381b: Add transactional Company Runtime audit records and a durable protocol-neutral Runtime event outbox with per-consumer replay cursors.
- 6ebc773: Add the append-only Runtime event compaction-checkpoint schema (Company Runtime storage v53). The forward-only migration introduces a STRICT `runtime_event_compaction_checkpoints` table with immutability triggers that records each compaction's compacted range, retained watermark, pre-compaction integrity hash, event count, and authorizing actor. The migration is additive — it creates no destructive change to any existing table or trigger and adopts an already-present checkpoint schema instead of failing on replay, matching the existing structural drift-guard convention. Compaction behavior that writes these rows lands in a later change; this establishes the durable authority record.
- 69a381b: Add Runtime-backed Department update, archive, and copy commands plus persistent Position and AI Member configuration updates. Extend the Desktop Department detail view with edit, archive, copy, and Position controls while showing a stable unpublished Pipeline state for custom Departments.
- 69a381b: Install the built-in Software R&D Department, its five Position/AI Member records, and its initial published Pipeline Version through the Desktop Company Runtime SQLite catalog. Add the typed `department.inspect` query and a Runtime-backed Department detail view with Overview, Positions, and a read-only Pipeline sequence.
- 69a381b: Introduce the Sandcastle v1 Company Runtime-backed Desktop with persistent Company data, health and catalog operations, backup and restore, bounded crash diagnostics, and authoritative state that survives Renderer reloads. The Desktop now opens on Company Overview, Projects, and Departments instead of the retired fixed-stage Project workflow.
- 69a381b: Add Runtime-owned Interaction Sessions, messages, permission requests, decisions, and a Desktop Agent Interaction workspace.
- 69a381b: Add governed Project and AI Member Memory Candidates with exact Artifact/Event provenance, independent Review, verified human acceptance or rejection, immutable Entries, and explicit child-Snapshot selection.
- 69a381b: Add SQLite-backed Node Attempt, Node feedback, and Approval history to the Company Runtime. Human Approval now supports Request Changes for one direct upstream AI Task, failed AI Tasks can be retried manually against the frozen Snapshot Revision within their retry allowance, and the Runtime, Electron bridge, Renderer Run Detail, and packaged smoke preserve and reload the full recovery history.
- 69a381b: Add revisioned Position and AI Member lifecycle controls, Department Artifact Contracts, Execution Profiles, non-sensitive Secret References, structured Pipeline node policies, frozen Skill Flow configuration, and localized guidance when referenced configuration cannot be archived.
- 69a381b: Add persistent Department Runs and Node Runs bound to immutable Run Snapshots, with stable execution errors and Project Run start, list, and detail views that survive Desktop reloads.
- 69a381b: Add persistent Human Approval decisions, declarative Conditions, logical Parallel branches, Join dependency handling, and deterministic completion to Company Runtime Department Runs, with stable errors and reload-safe Run Detail controls.
- 69a381b: Add Runtime-backed Department Pipeline Draft inspect, save, validation, and publish commands with optimistic revisions, stable validation codes, canonical graph hashing, and immutable Pipeline Version history. Upgrade the Desktop Pipeline page to an accessible structured node/edge editor and verify custom Department v1 publication through packaged Electron smoke coverage.
- 69a381b: Add the Company Runtime production Software Development execution adapter with structured planning, implementation, review, verification, and safe same-repository workspace isolation.
- 69a381b: Add Runtime-backed Project Configuration inspect, update, and archive commands with optimistic revisions, persistent shared context and repository references, and a stable empty Department Runs view. Upgrade the Desktop Projects page with editable configuration, VERSION_CONFLICT handling, archive behavior, Runtime reload persistence, and packaged Electron smoke coverage.
- 69a381b: Add optimistic Pause, Resume, and Cancel commands across Company Runtime, Electron IPC, preload, and Desktop Run views, including AbortSignal propagation and late-worker protection.
- 69a381b: Make Department Run execution durable under concurrent workers and Runtime restarts, with bounded concurrency, protected Node Attempt ownership, and explicit recovery evidence for interrupted work.
- cc69254: Make Company Runtime event compaction retention-class aware and record an append-only checkpoint for every prune. The `runtime.events.compact` Command now consults the Runtime Event Registry retention class and deletes only non-durable events (transient and standard, such as `message.delta`, `tool.call`, and `tool.result`); durable business facts are always retained regardless of consumer acknowledgement. Compaction remains ack-gated — it never prunes past the slowest acknowledged consumer cursor — and now runs as a single writer inside one transaction that also writes a `runtime_event_compaction_checkpoints` row capturing the compacted range, the retained watermark, a pre-compaction integrity hash, the event count, and the authorizing actor. The authorizing actor is Runtime-injected from the authenticated principal (a verified local-session human or a trusted Runtime worker); any other principal is refused. No Command, Query, IPC channel, schema version, or Runtime Event Registry version changes.
- 69a381b: Add a persistent Company Skill Catalog, Position Skill bindings, revisioned and archivable Skill Flows, and optional Skill Flow selection for Pipeline AI Tasks while preserving immutable historical Pipeline Versions.
- 69a381b: Add immutable Snapshot Revision r2 Recovery Overrides for provider, model, Sandbox, limits, and validated Secret Reference IDs, with parent linkage and an explicit Recovery Attempt that does not consume normal Retry allowance.
- 69a381b: Improve Company Runtime reliability with isolated concurrent Worktree execution, explicit recovery after interruption, reconnect-safe long-running commands, Runtime diagnostics, online backups, retention controls, and cancellation that closes active interaction work safely.
- fa71558: Execute published Department Pipelines with exact versioned built-in Node Handler bindings, deterministic condition/parallel/join behavior, replay-safe expirable Human Approvals, durable skip reasons, and crash-safe Node Run scheduling without invoking an Agent for closed no-Agent graphs.
- 6655aab: Add immutable Delivery candidates, verified Human release decisions, authoritative Desktop Query Views, and destination-free accepted downstream authority.
- fa71558: Refresh Sandcastle Desktop with the light AI Factory interface, a Project-scoped Consultation flow that revises and explicitly confirms an immutable Product Baseline, atomic formal Department Run/Snapshot r1 creation, replay-only Run forks, authoritative Runtime Query/Event projection, a three-pane Run Collaboration workspace that rebinds once per Current Node transition, whitespace-safe Project creation, guarded Recovery Overrides, readable Permission decision states, and accessible local duotone SVG icons.
- 9a085c1: Add immutable Delivery Candidate Input authority and independent risk-based Security and Operability quality gates to the Desktop Company Runtime, including durable reconciliation and authoritative renderer Query Views.
- e5145a6: Gate Runtime-imported Work Package commits with two-reviewer independent Code Review authority, exact canonical Diff validation, unified leased/fenced Reviewer Execution Facts, post-launch Docker isolation inspection and terminal receipts, exact immutable two-stage result bindings, manifest-owned fresh Sessions, non-overlapping Reviewer credential scopes, aggregate multi-package coverage hashes, dynamically revalidated PASS evidence, and complete obligation/finding/resolution rework evidence.
- b5576fe: Attach workflow board terminals to the current Board phase, auto-continue phases when the agent emits the structured completion signal, and show a stable task stage/timeline in the Board UI. The creating-issues phase now imports the interactive workspace_plan visibly, rejects duplicate repository entries before approval or execution, and returns to an interactive fix state instead of falling back to a background planner run. Approval waits with an imported plan now survive board restarts and can recover back to approval if interrupted; failed approved executions can also be recovered to retry the stored workspace plan.
- 5a67048: Add optional structured recovery evidence to `run.error` runtime events. Failed
  runs from `run()`, `runWorkspace()`, and `runWorkspaceTask()` now carry an
  optional `recovery` object with a stable `RunFailureKind`
  (`infrastructure` | `agent` | `task` | `unknown`), a best-effort failure phase,
  the preserved worktree path, run log path, session id/file, completion-signal
  state, and commit evidence — all optional and Effect-free. The original error is
  still thrown unchanged. `RunFailureKind` and `RunFailureRecovery` are exported so
  library callers can route infrastructure failures differently from agent or task
  failures, and the workflow board surfaces the evidence in its recovery text.
  Message-only `run.error` events still render safely.
- 3b73cb9: Make `RuntimeEvent` the structured Sandcastle event model, expose it through `events.onRuntimeEvent`, add the AG-UI adapter, and remove the legacy `RunEvent` / `onRunEvent` compatibility surface. Workspace task event callbacks are now `onRepoRuntimeEvent` and `onPlannerRuntimeEvent`.
- fa71558: Add replay-safe model-only Interaction Turns with durable leases, fenced Execution Facts, redacted context hashing, and typed Runtime IPC delivery.
- fa71558: Add fenced lease reconciliation and reattachment for Node Attempts and standalone Interaction Turns, immutable Continuation Plans for Retry/Recovery/Fork lineage, and typed execution evidence inspection.
- fa71558: Add the Desktop Review Topic engine with frozen reviewer eligibility and quorum, immutable findings and gate evidence, bounded discussion, fresh re-review Sessions, typed Runtime IPC, and PASS-only production-gate semantics.
- fa71558: Add immutable Project Spec revisions, exact Product Review manifests, reviewer-owned scope classification, persistent readiness evidence, and PASS-only atomic promotion into a child Run Snapshot Revision across the Company Runtime, typed IPC, and Desktop views.
- fa71558: Add registered Application identities, immutable Application Spec and Technical Baseline Proposal revisions, exact cross-Application contract review inputs, and PASS-only atomic Technical Baseline promotion into child Run Snapshot revisions across the Company Runtime and Desktop contracts.
- 5ea172c: Add a formal Desktop local isolated Git execution profile with durable Workspace Allocation commands and queries, Runtime-owned expected-tip import receipts, restart reconciliation, and Docker provider resolution.
- 36c4e99: Add versioned Work Package dependency graphs, deterministic Snapshot-based assignment, isolated per-Attempt Workspace ownership, Runtime-owned commit import, permission and evidence gates, parallel/dependent execution, blocked recovery, restart reconciliation, and fresh-resource retry/rework in the Desktop Company Runtime.
- 990f614: Add an authoritative Desktop Run Supervision view with Graph, Timeline, Agent Activity, explicit interaction boundaries, precise Attempt and Turn cancellation, governed feedback interventions, Runtime command guards, and reloadable Runtime query state.
- 154b0c6: Define immutable, idempotent post-Run release-operation contracts for verified human-authorized merge and export intents.
- 3145ad3: Add Project Statistics, frozen evidence, and the append-only, human-governed Improvement proposal, application, validation, and rollback workflow.
- 6b77be5: Add immutable versioned Test Case revisions and Test Runs that consume exact PASS Integration Generation and Build Artifact lineage, enforce the frozen Work Package risk-tier floor, persist and compare exact UI/Runtime observations, prioritize unknown or missing assertion coverage as blocked, bind evidence to the adapter-selected acknowledged Query token, reconcile external effects atomically, and resolve recursive responsibility-related rework scope across Integration Generations through origin- and route-preserving successor mappings. Expose PASS Test authority through Desktop Runtime commands, queries, events, and reloadable views. The scoped Electron fixture proves the formal Runtime/Artifact flow, capability-checked descriptor-relative race-safe evidence reads, all-target quarantine cleanup, real preload-mediated interaction, reload recovery, exact v48 schema adoption, and the production fixture boundary without direct driver database writes.

### Patch Changes

- 29eb5e3: Ask the active Board issue-generation phase to repair invalid workspace plans automatically before falling back to manual intervention.
- 29eb5e3: Add a Board branch merge action that lets users choose a repository and clean target branch before merging a completed task branch. The Board now recognizes already-merged target branches and can start a Codex or Claude Code run to resolve merge conflicts under the original task history.
- b5576fe: Expose cancellation for board AFK execution so running Execute phases can be stopped directly from the board UI.
- 29eb5e3: Constrain Board planning phase prompts so project rules and skills are read only for planning and issue generation, not implementation.
- 29eb5e3: Run a dedicated Board Evaluator agent during verification when repository agent activity exists. The verification report now includes Evaluator output plus deterministic structured evidence, skips Evaluator review when execution failed before agent work, and preserves deterministic evidence for recovery when Evaluator verification fails.
- 29eb5e3: Persist Board workflow progress through the file-backed BoardStore instead of a
  SQLite checkpoint database, and record strict Planner/Generator/Evaluator roles
  in task workflow state.
- 29eb5e3: Prevent repeated workflow phase completion markers from failing later Board phases.
- 29eb5e3: Import Board creating-issues workspace plans from a task-scoped JSON file before falling back to terminal transcript parsing, avoiding failures caused by TUI control sequences in interactive terminal output.
- 29eb5e3: Retain larger Board phase terminal transcripts so noisy PTY output does not evict the interactive `workspace_plan` before the creating-issues phase imports it.

  Hide the Board verification report action until a verification report exists, avoiding a premature "task verification not found" alert while a task is still awaiting approval.

  Use task-scoped default branch prefixes for Board execution so separate Board tasks do not reuse the same `codex/workspace-task/<repo>` branch.

- 29eb5e3: Surface exited Board phase terminals in the task stage description so stale or cancelled interactive phases are easier to diagnose.
- 29eb5e3: Add Board planning-only mode so approved Board workspace plans can export `workspace plan` artifacts without starting AFK execution. Exported planning artifacts are recorded in a task artifact manifest, exposed through the Board API, and rendered in the task detail panel. Planning-only approval now uses export-specific stage and button copy instead of AFK execution copy.

  `sandcastle board --planning-only --help` now shows the Board help instead of treating `--help` as an unknown trailing argument.

- 29eb5e3: Add a Board post-execution verification phase with persisted verification reports, task-scoped issue markdown status sync, infra/capture warning handling, recovery prompts that include verification context, a `board --plan-file` path for importing reviewed workspace plans into Board approval, and a `board --prd-file` path for starting the interactive Board planning flow from a PRD file or configured `workspace.json#prdFile`.
- 29eb5e3: Improve Board verification reports with a PRD acceptance matrix and mark tasks as needing verification when browser/backend or manual acceptance evidence is missing.
- 29eb5e3: Preserve PRD visual assets in Board tasks. Markdown PRD image references and direct image PRD files are copied into task assets, shown as Board artifacts, included in planning prompts, and made available to approved execution runs through repository-local task asset paths.
- 29eb5e3: Fix Board approved-plan execution around pre-agent infrastructure failures: sandbox create failures (e.g. missing Docker image or daemon) are now classified as infrastructure failures, verification reports them as `needs-recovery` with the real cause in the workflow error instead of a generic delivery failure, the Evaluator agent is no longer launched when only lifecycle runtime events (`run.started`/`iteration.started`/`run.error`) were recorded, execution retries only re-run the failed repositories instead of re-executing already-successful ones, and recovering a failed task always executes at least once even when the previous execution already exhausted the retry budget (previously recovery skipped straight to verification without running anything).
- b5576fe: Add board-managed execution progress documents so failed AFK execution can recover from model-agnostic progress instead of provider session state.
- 29eb5e3: Clarify Board task overview counts so task status cards do not mix repository run totals.
- 19b40cc: Show Product Baseline confirmation errors beside the action, prevent incomplete Product Proposals from appearing confirmable, start the formal Department Run after confirmation, and expose recovery for previously unstarted formal Runs.
- 29eb5e3: Fix Claude session capture for worktrees under dot-prefixed directories such as `.sandcastle`.
- 1a0a194: Localize Company Runtime Department configuration labels, Artifact Contracts, execution profiles, and secret references in the Chinese Desktop interface.
- 9b9ce3d: Clarify Department runtime configuration with localized guidance, explicit artifact contract empty states, and consistent form layout and controls.
- 5a8258e: Harden the Company Runtime database open path: an at-target company database now re-runs the structural drift check and is rejected if tampered, and its `schema_metadata` version marker is cross-validated against the `PRAGMA user_version` mirror so any disagreement — including a zeroed mirror — fails closed. A future/unknown schema version keeps being refused. Every open-path refusal (future schema, disagreeing markers, structural drift) now throws a typed `CompanyDatabaseError` carrying a stable machine-distinguishable `code` instead of a bare `Error`. Forward-only migration behavior is preserved and no immutable history is rewritten.
- 4087990: Align the Company Overview attention and inventory panels so the dashboard row has a consistent visual baseline.
- 0527248: Harden Company Runtime event-registry version handling on both reader paths. AG-UI and ACP now share a single choke point that rejects any envelope whose registry version is newer than the running registry (or below the version floor), and both fail closed on such an event instead of forwarding it. The AG-UI diagnostic for an unsupported registry version is now marked non-retryable, since a version-too-new envelope can never become readable by retrying. Forward-only compatibility with older-but-supported registry versions is preserved.
- f6adaf9: Harden the Company Runtime Release operation surface. The Release runtime now persists durable intent, terminal item finalization, reconciliation observations, and read projections through the `ReleaseOperationPersistence` contract instead of scattered inline SQL, so persistence is centralized behind one injection seam and remains transactional and behavior-preserving (transient in-flight marks and destination-claim fencing stay internal to the runtime). The thrown `ReleaseOperationRuntimeError` code is now typed from the single-source-of-truth `ReleaseOperationErrorCode` enum, so the runtime throw surface and the adapter-level item-failure codes (`RELEASE_TARGET_INVALID`, `RELEASE_TARGET_CHECKED_OUT`, `RELEASE_FAST_FORWARD_REQUIRED`) form one aligned set that cannot silently drift. All Release operations remain local merge/export; no schema version, Runtime Event Registry version, Command, Query, or IPC channel changes, and every post-Run Release invariant is preserved.
- 1b06626: Tighten the Desktop Agents catalog layout with aligned metadata, readable executable paths, capability pills, and consistent action states.
- f3b33c8: Allow Desktop Agent discovery and safe Agent tests to use their Runtime-owned
  subprocess timeouts instead of the short health-query IPC timeout.
- a142986: Make the Codex non-destructive probe work when Desktop starts outside a Git
  repository, and keep Agent executable paths readable in the catalog cards.
- 5f4b7f4: Keep Agent test loading state scoped to the card being tested, leaving other Agent actions available.
- 0f14271: Tighten Desktop Department panels and Position cards to prevent stretched whitespace, narrow metadata, and vertically wrapped Agent names.
- 69a381b: Split the Desktop project dashboard into separate Open Project and Create Project flows. Project records can now live in a selected project folder, existing project folders can be reopened from disk, and plain folders require confirmation before Desktop imports them as Sandcastle projects.
- 3bef716: Make Pipeline full-screen configuration cover the entire Desktop app and remove the redundant visible list editor below the visual canvas.
- 99f7147: Add a full-screen Department Pipeline configuration mode with Escape-to-exit behavior and a window-filling canvas and Inspector.
- 831bb95: Replace the Desktop Department Pipeline form editor with a PRD-aligned visual node canvas, draggable nodes, connection handles, automatic Draft saving, and a complete Inspector while retaining the accessible list editor.
- dd3f086: Align Desktop Project Detail and Agent Interaction with the v1 PRD by adding Project tabs and save navigation, a two-pane Department Runs workspace, and an AI Member consultation chat workspace that keeps raw Runtime events out of the main conversation.
- c0d37a7: Prioritize direct Skill name matches so Desktop catalog searches do not return unrelated description-only fuzzy matches.
- d262cdb: Refresh the Desktop Skills catalog with a compact Codex-style list layout, clearer metadata, and consistent actions.
- dfd87dd: Add Windows x64 Desktop distribution with an NSIS installer, unpacked
  Company Runtime smoke coverage on `windows-latest`, Windows-safe local IPC
  framing, and Windows npm CLI shim resolution for the optional Board process.
- b5576fe: Render board task activity as a readonly terminal-style stream and surface per-run progress from existing runtime events.
- 74f10b8: Improve Desktop Agent Interaction and Department Run visibility with structured progress, current-node context, live Run Collaboration updates, real AI Member consultation replies, clearer Position and Skill Flow selection, and dismissible Position editors.
- e00ad5a: Add an opt-in file-backed workflow engine for board tasks with plan approval,
  strict Planner/Generator/Evaluator roles, evidence-based verification, and
  conservative repository retry handling.
- b5576fe: Fix workspace `no-sandbox` session capture so host-written Claude session files are copied through the wrapper instead of leaving capture temp files missing.
- e00ad5a: Refresh the workflow board with a richer dark console visual design.
- fc61ab9: Add a real Electron Product-to-Candidate end-to-end fixture that drives the production Renderer and Runtime through formal authority, restart, cleanup, quality-gate, and waiting-for-human-release boundaries without accepting or releasing the Candidate.
- 7927fe6: Add a native folder picker for Desktop Project repository references while preserving explicit add and save confirmation steps.
- 29eb5e3: Fix managed worktree reuse on macOS when git reports temp-directory paths through `/private/var` aliases.

## 0.13.1

### Patch Changes

- Fix `sandcastle board` rendering a blank screen. The embedded frontend no longer uses `String.raw`, which emitted invalid escaped template backticks into the browser module, and React inline styles are now object props instead of strings.

## 0.13.0

### Minor Changes

- 4e7cf1f: Bump the Codex default model from `gpt-5.4` to `gpt-5.5` in `sandcastle init` scaffolding, the interactive agent picker, and the `workspace plan/run/execute` default (all sourced from the agent registry). Pass `--model` to override.
- 1e15922: Bump default Claude Code model from `claude-opus-4-7` to `claude-opus-4-8`. The new default applies to the `DEFAULT_MODEL` constant, the `claude-code` agent entry surfaced by `sandcastle init`, and the scaffolded templates (`blank`, `parallel-planner`, `parallel-planner-with-review`). Passing an explicit model to `claudeCode(...)` is unaffected.
- 0f577a4: Add `sandbox.exec(command, options?)` to the `Sandbox` handle returned by `createSandbox()` (and by `worktree.createSandbox()`). The method delegates to the provider handle's `exec()` and returns the full `ExecResult` — non-zero `exitCode` is surfaced, not thrown — so harnesses can run shell commands (tests, lints, custom verification gates) directly in the same warm sandbox between `run()` calls without reaching for the underlying provider handle. `cwd` defaults to the sandbox repo path so behavior is consistent across providers; pass `cwd` to override.
- 17a9040: Allow `sandcastle init` to scaffold runners with the `no-sandbox` provider. Selecting no-sandbox rewrites generated templates to import and call `noSandbox()`, skips Dockerfile/Containerfile generation, and skips image-build prompts because the agent runs directly on the host.
- 4e7cf1f: Let `sandcastle init` capture a PRD and optionally plan from it.
  - `sandcastle init --prd-file <path>` records a top-level `prdFile` field in the scaffolded `.sandcastle/workspace.json`. `sandcastle workspace plan` and `sandcastle workspace run` now default to that PRD when no explicit input flag is passed, with precedence: explicit `--prompt`/`--prompt-file`/`--prd`/`--prd-file` > configured `prdFile` > the only ready `.scratch/` issue.
  - `sandcastle init --plan true` runs the planner once at the end of init to generate the plan artifacts (`workspace-plan.json`, `alignment.md`, `technical-plan.md`, and per-repository issues) using the agent and sandbox selected during init. It requires `--prd-file`, a non-custom issue tracker, and a docker/podman image built in the same init run (the planner runs the agent inside a bind-mount sandbox); when those prerequisites are not met it is skipped with a pointer to `sandcastle workspace plan`.

- 4e7cf1f: Scaffold a default `.sandcastle/workspace.json` during `sandcastle init` and snapshot the selected workspace into each generated `workspace-plan.json`. The default config gives single-repository projects a starter candidate workspace, while each PRD or issue plan now carries the exact repository set used for later execution.
- 4e7cf1f: Add a `sandcastle local-issue` command for running local markdown issues with `noSandbox()` and a host worktree.
- 4e7cf1f: Add workspace task orchestration for multi-repository product requests. `runWorkspaceTask()` runs a planner agent to turn a PRD or product request into automatic PRD alignment notes, a technical plan, and repository-local issues, executes selected repository tasks in parallel with managed git lifecycle, and returns plan/results grouped by repository. The lower-level `runWorkspace()` API remains available for one agent invocation that needs several repositories mounted in the same sandbox. The new `sandcastle workspace plan` and `sandcastle workspace execute` CLI steps let callers generate, review, and then execute a workspace plan without writing a TypeScript runner or hand-authoring agent-ready issues. `sandcastle workspace run` is the one-command PRD-to-commits pipeline.
- 4e7cf1f: Add a structured run-event stream and a local workflow board. `run()` gains an `onRunEvent` callback that works in both logging modes (unlike the file-mode-only `onAgentStreamEvent`) and emits the full run shape — `run-started`/`run-finished`/`run-failed`, `iteration-started`, `agent-text`, `agent-tool-call`, token `usage` (carrying the agent model), and `commit`. `AgentProvider` now exposes an optional `model`. `runWorkspaceTask()` forwards per-repo events via `onRepoRunEvent`, surfaces the planner phase via `onPlannerRunEvent`, and reports the extracted plan early via `onPlan`; `runWorkspace()` also accepts `onRunEvent`. The new `sandcastle board` command starts a local web board (HTTP + Server-Sent Events, file-backed under `.sandcastle/board/`) with a by-task view that groups per-repository runs under their parent task and renders the workspace plan, a by-status kanban, live agent activity, per-repo progress, and per-model token counts. Tasks created on the board fan out into per-repository runs via `runWorkspaceTask`, and the board watches its data directory so runs written by other processes appear without a refresh. The new public `RunEvent` type is exported and remains Effect-free. See ADRs 0021 and 0022.

### Patch Changes

- 4e7cf1f: Point `sandcastle init` next steps at the PRD-first workspace flow. After scaffolding, init now reminds users they can run `sandcastle workspace plan --prd-file <path>` to turn a PRD into PRD alignment, a technical plan, and per-repository issues under `.scratch/` (then `workspace execute`, or `workspace run` for both). The hint appears for the blank and template-driven flows; the custom issue tracker keeps its focused setup steps.
- 4e7cf1f: Scaffold `.sandcastle/SKILL_ROUTER.md` during `sandcastle init` so generated runners carry a companion skill-flow guide for Codex and Claude Code setups. The README now teaches the recommended learning path, business flow, first practice run, and best practices for using that router before project work starts.
- 4e7cf1f: Fix `sandcastle workspace plan/run/execute` reading the wrong `.env`. They resolved the env file relative to the installed package (`<package>/.sandcastle/.env`), which only exists when the package _is_ the repo (dogfooding); for `npm install`ed users it pointed inside `node_modules` and silently loaded no credentials. These commands (and `init --plan`) now read the user's repo at `<cwd>/.sandcastle/.env` — where `sandcastle init` writes it — while still honoring the `SANDCASTLE_ENV_FILE` override. The host-side `local-issue` command keeps its existing package-relative behavior.
- 4e7cf1f: Use public default models for `sandcastle workspace plan/run/execute`. The CLI previously defaulted to internal routing slugs (`x6/claude-opus-4-8`, `x5/gpt-5.5`) that only resolve on company infrastructure, so external users had to pass `--model` to run at all. The workspace commands now default to the agent registry's public models (the same ones `sandcastle init` scaffolds), with a single source of truth for future model bumps. Pass `--model` (and `--planner-model`) to override.

## 0.11.0

### Minor Changes

- 9f3f6d5: Add `maxRetries` to `Output.object` and `Output.string` for built-in retry of structured-output runs. When extraction or validation fails, `run()` resumes the failed agent session and feeds back a token-efficient description of the error so the agent can re-emit a corrected tag, up to `maxRetries` extra attempts (default: `0`). Retries require an agent provider that supports session resumption (`claudeCode`, `codex`, `pi`); calling `run()` with `maxRetries > 0` against a non-resumable provider (`cursor`, `opencode`, `copilot`) fails at entry with a clear error.
- bce86dd: Add `resumeSession` to `sandbox.run()` and expose `.resume(prompt, options?)` / `.fork(prompt, options?)` on `SandboxRunResult`. The new options mirror `RunOptions.resumeSession` and `RunResult.resume()/fork()`, but continue the agent session _inside an existing long-lived `createSandbox()` container_ — so the container, worktree, and on-ready dependencies stay warm across implement → review → edit phases instead of each phase paying container boot. Resume is gated on the session-capture fix in this release; non-bind-mount providers skip capture and therefore have nothing to resume from.

### Patch Changes

- bce86dd: Fix `createSandbox().run()` and `createWorktree().run()` not capturing the agent session on bind-mount providers — `iterations[].usage` stayed `undefined`, and the resulting `"Context window: NNNk"` line never printed. The `reuseFactoryLayer` that both entry points install was dropping `bindMountHandle` from the `SandboxInfo` it passed to the orchestrator, so the session-capture gate (`provider.captureSessions && provider.sessionStorage && sessionId && bindMountHandle`) silently no-op'd. The handle is now plumbed through, gated on `sandbox.tag === "bind-mount"` so isolated and no-sandbox providers still bypass capture cleanly.
- f7879c5: Fix `createWorktree({ branchStrategy: { type: "merge-to-head" } })` not merging the agent's commits back to the host's current branch. `wt.run()`, `wt.interactive()`, and `wt.createSandbox()` previously forwarded the worktree's temp branch as an explicit branch, which routed `SandboxLifecycle` through its "explicit branch" path and skipped the merge step entirely — commits landed on the temp branch but never on HEAD. They now pass `branch: undefined` (so the lifecycle records the host's current branch and merges back to it) while keeping the worktree's source branch alive for subsequent calls.
- 0e1df92: Fix Cursor Dockerfile failing on macOS hosts where the user's GID is `20` (already used by the `dialout` group in `node:22-bookworm`). `groupmod`/`usermod` in the Cursor template now use `-o` (`--non-unique`), matching the other agent templates.
- 702d829: Fix `noSandbox()` failing with `spawn sh ENOENT` in PowerShell / `cmd.exe` on Windows. The provider now routes `exec` commands through `cmd.exe /d /s /c` on Windows and spawns interactive agents with `shell: true` so npm `.cmd`/`.ps1` wrappers (e.g. `claude.cmd`) resolve via `PATHEXT`. POSIX hosts are unchanged.
- 9a895ba: Fix Docker bind-mount sandbox failing on Windows hosts with `too many colons` when launched via `interactive()` (non-head strategy), `worktree.interactive()`, or `worktree.run()`. These three entry points called `resolveGitMounts` but skipped the `patchGitMountsForWindows` step, so the parent `.git` mount kept its `C:\...` sandbox path and Docker rejected the resulting volume string. They now mirror the existing wiring in `SandboxFactory` and `createSandbox`.
- 595e21e: Improve the `WorktreeManager` error raised when the requested branch is already checked out in the host's main working tree (or any other unmanaged worktree). The message now explains why this happens — sandcastle's branch and merge-to-head strategies run the agent in a git worktree under `.sandcastle/worktrees/`, and git refuses to check out the same branch in two worktrees at once — and tells the caller to pick a different branch or switch the main working tree first. No behaviour change: sandcastle still does not attempt smart recovery here.

## 0.10.0

### Minor Changes

- e445b70: Add `verbose` option to the `logging` configuration on `run()`, `createSandbox().run()`, and `createWorktree().run()`.

  When set to `true`:
  - In file mode (`{ type: "file", path, verbose: true }`), every raw stdout line the agent emits is appended verbatim to the same log file at `path` in real time, interleaved with the human-readable log output.
  - In stdout/terminal mode (`{ type: "stdout", verbose: true }`), raw lines are written to `process.stdout`.

  Includes lines the provider's stream parser would otherwise drop (e.g. tool-use blocks for unrecognised tools) — exactly what's needed to debug a stuck or unexpectedly silent agent.

  A new `{ type: "raw"; line; iteration; timestamp }` variant is also surfaced through `onAgentStreamEvent`, so callers forwarding to external observability systems get every raw line too.

## 0.9.0

### Minor Changes

- 47184de: Capture Claude Code subagent / workflow session transcripts to the host alongside the main session. Previously only the main `<sessionId>.jsonl` was copied off the sandbox; transcripts written by the `Agent` tool and the `Workflow` tool under `<sessionId>/subagents/agent-*.jsonl` were lost on teardown. They are now captured with the same sandbox→host `cwd` rewrite. Failure to capture an individual subagent transcript is best-effort and logs a warning; the main session capture remains fatal on failure.

### Patch Changes

- 86aec83: `sandcastle init` now scaffolds `CLAUDE_CODE_OAUTH_TOKEN=` (with a commented `ANTHROPIC_API_KEY=` fallback) for the Claude Code agent, and the next-steps copy points users at `claude setup-token` instead of the closed issue #191.
- 03dcc25: Guard `substitutePromptArgs` against `undefined`/`null` values in `promptArgs`. Previously, a present-but-nullish value (e.g. `{ TITLE: undefined }` from an orchestrator's `JSON.parse` output) bypassed the existence check and crashed with an unguarded `TypeError` on `.toString()`. Now surfaces a clean `PromptError` naming the offending key. `findMissingPromptArgKeys` also treats present-but-nullish values as missing, so the interactive prompt-fill flow asks the user to supply the value rather than failing through.

## 0.8.0

### Minor Changes

- cf92a17: Add `permissionMode` to `claudeCode()` and `approvalsReviewer` to `codex()` — provider-level options for AI-mediated per-tool approval, an alternative to full bypass for AFK host runs (`noSandbox()` + `run()`).

  `claudeCode({ permissionMode: "auto" })` emits `--permission-mode auto` instead of `--dangerously-skip-permissions`. Accepts any of Claude's permission modes: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.

  `codex({ approvalsReviewer: "auto_review" })` swaps `--dangerously-bypass-approvals-and-sandbox` for `-a on-request -s danger-full-access -c approvals_reviewer="auto_review"` so Codex's reviewer agent evaluates each approval prompt.

### Patch Changes

- 932302b: Bump the Codex default model from `gpt-5.4-mini` to `gpt-5.4` in `sandcastle init` scaffolding and the interactive agent picker. The previous default was underpowered for implementation work.
- c6c3026: Fix `opencode()` interactive sessions (and the `init` scaffold's opencode `setupCommand`) seeding the prompt with `-p`, which is the `opencode run`/`attach` basic-auth password flag, not a prompt seed. Use `--prompt` (the TUI's long-form-only seed flag) instead. The TUI pre-fills the textbox but does not auto-submit (see [sst/opencode#3937](https://github.com/sst/opencode/issues/3937)).

## 0.7.0

### Minor Changes

- 22113ca: `sandcastle init` now supports fully non-interactive setup. Every interactive prompt has a paired CLI flag (`--issue-tracker`, `--create-label`, `--build-image`, `--install-template-deps`) on top of the existing `--agent` / `--template` / `--sandbox` / `--model` / `--image-name`. When stdin is not a TTY and a flag is missing for a prompt that would otherwise fire, init fails fast with a message naming the missing flag instead of crashing on the prompt library.

### Patch Changes

- 0b397a1: Strengthen the `simple-loop` and `sequential-reviewer` prompts so an empty pre-expanded `LIST_TASKS_COMMAND` result is treated as ground truth, not as a stale snapshot. The "do not re-query" hint now frames the filtered list as the sole source of truth, and the `# Done` completion criterion explicitly equates an empty list with completion. Prevents the agent from running its own unfiltered `gh issue list` when the filtered list is `[]`.
- c6880a4: Fix `createSandbox` (and `createWorktree`) reusing a stale worktree when called twice for the same named branch. A reused worktree holds a local copy of the branch that never moves on its own, so a re-run loop (review → push fixes → re-run) was reading stale code even though `origin/<branch>` had moved ahead.

  On the **clean** worktree-reuse path of the **branch** strategy, sandcastle now runs `git fetch origin <branch>` followed by `git merge --ff-only origin/<branch>` so the worktree picks up new upstream commits. The refresh only runs when it is provably safe — clean tree and strictly behind origin. **Dirty**, **diverged** (unpushed commits), or **fetch fails** (offline) → skip the refresh, reuse as-is, log why. Fetch failure is non-fatal and never breaks the run. First creation, the merge-to-head strategy, and the head strategy are untouched. See ADR 0003 for the full rationale.

## 0.6.6

### Patch Changes

- ddc26ba: Add `completionTimeoutSeconds` to handle agents that emit the completion signal but never exit. When an agent prints `<promise>COMPLETE</promise>` (or any configured `completionSignal`) but a child process it spawned — a `gh`/git subprocess, a long-lived MCP server, etc. — keeps the exec's stdout pipe open, the parent never reaches EOF. Previously the run waited the full `idleTimeoutSeconds` (default 10 minutes) before failing with `AgentIdleTimeoutError`, discarding any commits the agent had already made. The orchestrator now scans buffered output as it streams, and once a completion signal is detected it swaps the idle timer for a shorter **completion timeout** (default 60 seconds). On expiry the iteration resolves successfully with a warning, `result.commits` and `result.completionSignal` are populated, and session capture runs as normal. The timer resets on every subsequent output line so trailing data (Codex `turn.completed` usage, Claude Code terminal `result`, structured-output tags emitted after the marker) is still captured. A clean process exit always wins the race, so healthy runs gain zero added latency. The new `completionTimeoutSeconds` option (also accepted by `createSandbox()` and `createWorktree()` runs) tunes the window; it is independent of `idleTimeoutSeconds` and is not clamped against it. See ADR 0019.
- e078db5: `Sandbox.run()` (from `createSandbox()`) and `Worktree.run()` (from `createWorktree()`) now emit the run-complete status line and the `Context window: NNNk` line for each iteration with usage data, mirroring the behaviour of the top-level `run()` entry point. Previously these lines only showed up from `run()`, so callers using the lower-level wrappers never saw the completion status or token-count summaries even when usage was available.
- 932aa70: Add resume support to the `pi()` agent provider. Pi sessions captured during a run can now be continued via `RunResult.resume(prompt)` or `run({ resumeSession: "<id>" })`, mirroring Claude Code and Codex. Pi's JSONL session under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<id>.jsonl` is captured to the host with its header `cwd` rewritten and resumed back into the sandbox via `pi --session <id>`. Session capture defaults to on; opt out with `pi("model", { captureSessions: false })`. Pi's print-mode `--no-session` flag is no longer hard-coded so iterations are persisted by default.
- 1201b4d: Add a `thinking` option to the `pi()` agent provider. Pass `pi("model", { thinking: "high" })` to forward `--thinking <level>` to the pi CLI. Accepted levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`.
- b9b9712: Add typed diagnostics to prompt-expansion errors so a downstream orchestrator can branch on them programmatically instead of parsing the message. `PromptExpansionTimeoutError` now carries `elapsedMs` (the wall-clock time the shell expression actually ran before timing out, measured at the throw site) alongside the existing `timeoutMs`; `PromptError` carries an optional `exitCode` when the failure was a non-zero exit from a `` !`command` `` expansion. Both values are reflected in the formatted error message so a human reading the log can tell a 30s contention timeout from an instant auth failure. Follows ADR-0020 (fail-fast prompt expansion); no retry behaviour changes.
- 72637ae: Replace the `SessionStore`-based public API with pure JSONL transfer helpers. The previous `hostSessionStore`, `sandboxSessionStore`, `codexHostSessionStore`, `codexSandboxSessionStore` exports and the `SessionStore` type were the implementation seam used internally to read/write agent session files. They are now removed in favour of pure-string helpers — `transferClaudeSession(jsonl, fromCwd, toCwd)` and `transferCodexSession(jsonl, fromCwd, toCwd)` — that rewrite a session JSONL without touching the filesystem. Path helpers (`claudeHostSessionPath`, `claudeSandboxSessionPath`, `encodeProjectPath`) and the host-side scan utilities (`findClaudeSessionOnHost`, `findCodexSessionOnHost`, `HostSessionLookup`) are exposed instead, so callers building a custom `AgentSessionStorage` do their own file I/O at the call site. The built-in `claudeCode()` and `codex()` providers are unchanged for end users — only direct consumers of the removed store factories need to migrate.
- 58f335f: Add `RunResult.fork(prompt, options?)` as the sibling of `RunResult.resume()` for fan-out workflows. Both run exactly one iteration that continues from the last captured agent session, but `.fork()` leaves the parent session JSONL intact and writes the child under a new session id — the underlying mechanism is `claude --resume <id> --fork-session` for Claude Code and `codex exec fork <id>` for Codex. `fork` is present only on results from providers with `sessionStorage` (Claude Code, Codex).

  Fork isolates the agent session only — not the branch, worktree, or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires giving each child a distinct branch via `branchStrategy: { type: "branch", branch: "..." }`; the default `head` and `merge-to-head` strategies are not safe for concurrent forks. See ADR 0018 for the design rationale and the fan-out caveat.

  Also: `generateTempBranchName` now appends a 6-hex-char random suffix to its `sandcastle/<YYYYMMDD-HHMMSS>` format. The previous second-granularity timestamp collided under any concurrent invocation, not just fork.

- b46dae7: Fix `syncOut` failing on the second run against the same isolated sandbox. `git am` rewrites SHAs on the host, so on every run after the first the previous host `HEAD` was unknown to the sandbox and `git format-patch hostHead..HEAD` aborted with `fatal: Invalid revision range`, losing the run's commits when the sandbox was torn down.

  `syncOut` now tracks the last-synced commit in a sandbox-owned ref `refs/sandcastle/sync-base` and uses it as the patch base, falling back to host `HEAD` only when the ref is absent (run 1). The same ref is read by `SandboxLifecycle` via the new exported `countCommitsToSync` helper, fixing the related "No commits to sync out" misreport on run 2+. See ADR 0017.

## 0.6.5

### Patch Changes

- 0b2ec99: Detect the host package manager (npm, pnpm, yarn, or bun) during `sandcastle init` and use it for the install commands shown in the next steps. For templates that import `zod` on the host (the planner templates), init now offers to install it with the detected package manager when it isn't already declared — preventing the `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` crash on the first run.

## 0.6.4

### Patch Changes

- 157dafc: Add a hint to the `sequential-reviewer` and `simple-loop` implement prompts noting that the issue list is already filtered and discouraging an unfiltered re-query, so the agent is less likely to bypass the configured label filter when the list is empty.

## 0.6.3

### Patch Changes

- 1a7e2f5: Add a "Custom" issue tracker option to `sandcastle init`. Selecting it scaffolds the project in a deliberately broken-until-configured state plus a `.sandcastle/SETUP_ISSUE_TRACKER.md` prompt you feed to your coding agent, which wires up your own issue tracker by editing the scaffolded files in place. Init skips the image build for this option (the Dockerfile is intentionally unfinished) and prints a per-agent setup command in the next steps.
- 8f79a12: Use the scoped package name (`@ai-hero/sandcastle`) in the quick-start docs so `npx` resolves this package rather than the unrelated unscoped `sandcastle` package on npm. Also refresh the docs site getting-started page, which referenced removed `sandcastle init`/`sandcastle run` commands.
- b7595bc: Rename the "backlog manager" concept to "issue tracker" across `sandcastle init` — the selection prompt now reads "Select an issue tracker:", and the generated Dockerfile placeholder is `{{ISSUE_TRACKER_TOOLS}}`. Pure rename with no behaviour change.

## 0.6.2

### Patch Changes

- b141975: The `codex()` agent provider now surfaces per-iteration token usage from its `turn.completed` stream events, so the `Context window: NNNk` line is reported for Codex runs (previously only Claude Code). Codex's `{ input_tokens, cached_input_tokens, output_tokens }` shape is mapped onto Sandcastle's usage model with the cached portion counted as cache-read tokens, avoiding double-counting in the display. Usage flows directly from the stream, so it works even when session capture is disabled or there is no bind-mount.

## 0.6.1

### Patch Changes

- e2c5431: `copilot()` agent provider now parses the `copilot --output-format json` JSONL stream. Text deltas (`assistant.message_delta`), `bash` tool calls (`tool.execution_start`), the final assistant message (`assistant.message`), and the session id (terminal `result` event) are surfaced as `StreamEvent`s, so the Orchestrator's `result.stdout`, `logging.onAgentStreamEvent` timeline, and stderr-empty error fallback now work for Copilot the same as they do for Claude Code, Codex, and Pi. Previously `parseStreamLine` was a no-op.
- d0afa21: Make planner branch names deterministic. The parallel-planner and parallel-planner-with-review templates previously asked the agent to assign a branch name in the format `sandcastle/issue-{id}-{slug}`, where the slug was re-derived on every planning iteration. Because each iteration runs a fresh agent, this produced a different branch each time, forking new branches off HEAD and discarding accumulated progress. The format is now the deterministic `sandcastle/issue-{id}`, so re-planning the same issue resumes the existing branch.
- abac106: Fix `resumeSession` precheck false-negative for the no-sandbox provider. When running on the host with no sandbox, the agent writes its session in place under a cwd-derived directory that Sandcastle was reconstructing from the host repo path — missing the worktree path, symlink-resolved paths (e.g. macOS `/tmp` → `/private/tmp`), and the agent's `.`→`-` encoding. The precheck now locates the session by its unique id via a new `findByIdOnHost` capability on `AgentSessionStorage`, so no-sandbox resume works regardless of how the agent encodes its cwd. Sandboxed (docker/podman) runs are unchanged.
- f34bf0a: Add a `copilot` agent provider for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (`@github/copilot`). Use it like the other agent factories: `copilot("claude-sonnet-4.5")`. Authentication is via `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. `sandcastle init` now offers GitHub Copilot CLI as an agent option, with a Dockerfile that installs the CLI via `npm install -g @github/copilot`.
- 6bcaa7a: The `parallel-planner` and `parallel-planner-with-review` init templates now parse the planner's `<plan>` output with `Output.object` and a Zod schema instead of a bespoke regex helper. The templates depend on Zod, but any [Standard Schema](https://standardschema.dev) validator (Valibot, ArkType, …) works; `sandcastle init` now reminds you to install one. A missing tag or malformed plan JSON now throws `StructuredOutputError`.
- f64e203: Fix the `sequential-reviewer` template processing the entire backlog in a single pass: the implementer now runs for one iteration so each outer loop handles one issue on its own branch, and the loop stops once the backlog is exhausted. Also fix the empty review diff in both `sequential-reviewer` and `parallel-planner-with-review` templates — `review-prompt.md` now diffs the branch against `{{TARGET_BRANCH}}` (the fork point) instead of `{{SOURCE_BRANCH}}`, which equals the branch itself and always produced an empty diff.
- 6165660: Share a single `SIGINT`/`SIGTERM`/`exit` handler across sandboxes. Previously every `createSandbox()`, `docker()`, and `podman()` sandbox added its own process signal listeners, so running more than ~5 concurrent sandboxes tripped Node's `MaxListenersExceededWarning`. Cleanup now routes through one shared registry that installs a single listener per event and fans out to each sandbox's teardown.

  Behavior change on interrupt: with a Docker/Podman sandbox, the container's signal handler used to call `process.exit` before `createSandbox()`'s handler ran, so the "Worktree preserved" recovery guidance was silently skipped. The shared handler runs every teardown (container removal **and** the guidance) before exiting once with code 1, so the guidance now prints on `Ctrl-C`.

- 46eb483: Fix worktree creation failing under non-English git locales. `WorktreeManager` matched git's human-readable stderr (e.g. "invalid reference") to decide control flow, but git localizes those strings, so in a non-English locale the new-branch fallback never fired and worktree creation broke outright. Git is now invoked with `LC_ALL=C` so its messages are always English and machine-stable.

## 0.6.0

### Minor Changes

- bc9216f: Add a `cursor()` agent provider. Cursor is selectable during `sandcastle init` (with a provider-specific Dockerfile and `CURSOR_API_KEY` env scaffold) and importable directly as `cursor(model, options?)`. Print mode runs the Cursor Agent CLI with `--output-format stream-json`, passing the prompt as a positional argument (guarded against the argv size limit) and parsing Cursor's top-level `tool_call` events. Cursor is non-resumable (no filesystem-backed session storage), consistent with ADR 0012/0016.

### Patch Changes

- 8562a7e: Fix the Beads `CLOSE_TASK_COMMAND` template, which passed the completion message as a positional argument (`bd close <ID> "Completed by Sandcastle"`). `bd close` parsed it as a second issue ID and errored. It now uses the `--reason=` flag.
- 825aadf: Fix `RangeError: Invalid string length` crash on long agent runs. When streaming `exec` output via `onLine`, sandbox providers accumulated every line and joined them into one string at completion; past V8's ~512MB max string length this threw inside a `close` event handler — an uncaught exception that bypassed `Promise.allSettled` and took down the whole run, including parallel pipelines. Streamed stdout and stderr are now kept in a bounded rolling tail (default 64KiB, configurable per provider via `maxOutputTailChars`). Live output to `onLine` is unaffected.
- 73e9e7c: Add `"xhigh"` to the `ClaudeCodeOptions.effort` union to match the Claude CLI's `--effort` levels.
- 746e0ca: Add resume support for the Codex agent provider and move session storage behind provider-owned session stores.

  The per-provider session transfer is now owned by the provider's `sessionStorage.transfer` (ADR 0012). The free `transferSession` export is removed from the public API — agent providers apply their own format-specific `cwd` rewriting internally.

- 2318bb4: Add a `devices` option to the Docker and Podman sandbox providers that maps to `--device` flags, exposing host devices to the container (e.g. `/dev/kvm`). Each entry is a full device spec in `host[:container[:permissions]]` form; when omitted, no `--device` flags are added. SELinux `--security-opt` handling is intentionally out of scope and left to the user.
- c878b14: Add a `cpus` option to the Docker and Podman sandbox providers that maps to the `--cpus` flag on `docker run` / `podman run`, limiting the CPU resources available to the container. Accepts fractional values (e.g. `1.5`); when omitted, the container is left unconstrained.
- b233f40: Expose more sandbox lifecycle timeouts via the `Timeouts` interface. In addition to `copyToWorktreeMs`, you can now override `gitSetupMs` (in-sandbox git setup commands, default 10 000 ms), `commitCollectionMs` (collecting the run's commits, default 30 000 ms), and `mergeToHostMs` (merging a temp branch back to the host branch, default 30 000 ms). These are accepted anywhere `timeouts` already is — `run()`, `createSandbox()`, `interactive()`, and `createWorktree()`. Unset keys keep their defaults.
- 702c761: Fix `sandcastle init` ignoring the selected sandbox provider in the generated main file. Choosing Podman now rewrites the `docker` import and `docker()` call sites to `podman`, instead of always scaffolding `docker`.
- 18ae734: Expand the generated `.env.example` comment for `GH_TOKEN` (GitHub Issues backlog manager) to link the fine-grained token creation page and list the required repository permissions: Issues (Read and write) and Metadata (Read).
- 15d70ef: Add a `groups` option to the Docker and Podman sandbox providers that maps to `--group-add` flags, granting the container user supplementary group membership (e.g. for a bind-mounted Docker socket). Accepts group names or numeric GIDs; when omitted, no `--group-add` flags are added.
- cd5fd13: Fix `sandcastle docker build-image` / `podman build-image` failing on macOS hosts. The generated Dockerfile now aligns the agent UID/GID with `groupmod -o` / `usermod -o` (`--non-unique`), so a host GID that collides with a reserved GID in `node:22-bookworm` (notably macOS's primary group `staff` = GID 20, occupied by `dialout`) no longer aborts the build with `GID '20' already exists`. Existing scaffolds need to re-run `sandcastle init` or add `-o` to the `groupmod`/`usermod` line by hand.
- f1d5ddc: Fix worktree management on Windows by normalizing path separators. `git worktree list` reports paths with forward slashes even on Windows, while `node:path.join` uses backslashes — so `create()` would misclassify a reusable managed worktree as an external one and throw "already checked out", and `pruneStale()` would treat every active worktree as orphaned and delete it out from under running sandboxes. Path comparisons now normalize separators before matching.
- bca035e: Add an `agent` option to `opencode()`, mapping to OpenCode's own `--agent` flag (e.g. `opencode("model", { agent: "build" })`). It selects a named agent/mode inside OpenCode for both headless (`run`) and interactive invocations, and is distinct from Sandcastle's `--agent` provider selector.
- 1e23181: Fix dropped OpenCode output. The print command now passes `--format json` so OpenCode emits the structured event stream the parser consumes — previously it emitted plain text, so the parser received nothing and live output, tool calls, and the session ID were all dropped. `--dangerously-skip-permissions` is now passed in the sandbox so runs no longer hang on permission prompts. `parseStreamLine` surfaces assistant text and the final result from `text` events, tool calls from `tool_use` events (`bash`, `webfetch`, `task`, with a JSON fallback for other tools, gated on the completed status), the session ID from `step_start`, and error messages from `error` events.
- a3f1c04: Fix orphaned worktrees when sandbox start fails (e.g. a missing Docker image). `run()`, `createSandbox()`, and `interactive()` now remove the freshly-created worktree if any setup step after worktree creation fails, instead of leaving it behind to require a manual `git worktree remove --force`. Covers all three worktree-creating branch strategies for bind-mount, isolated, and no-sandbox providers.
- 0b74ab6: Raise the GitHub Issues backlog manager's list command to `--limit 100` so the parallel planner sees the full backlog instead of `gh`'s default 30, preventing foundation issues from being silently truncated out of the dependency graph.
- fbad1a4: Retry transient git setup exec failures during `withSandboxLifecycle`. Under heavy parallelism the `git config` / `git rev-parse` commands run at sandbox start could fail with exit 126 (`cannot exec`) or 137 (killed) from a momentary container exec race rather than a real git error. These are now retried (each attempt still bounded by the existing per-command timeout); genuine non-transient git failures and hangs still fail fast. `ExecError` also gains an optional `exitCode` field carrying the failing command's exit code.
- 8aee234: Add a `--sandbox` flag to `sandcastle init` to select the sandbox provider (`docker` or `podman`) non-interactively, mirroring `--agent`.
- 87285a7: Fix `syncOut` deleting the entire `.sandcastle` directory after a successful sync. Cleanup of temporary patch artifacts removed the whole `.sandcastle` directory once `patches/` was empty, wiping tracked files (e.g. `Dockerfile`, config) from the synced worktree. It now removes only the `patches/` directory.

## 0.5.12

### Patch Changes

- 581dc80: `StructuredOutputError` now carries `sessionId` and `sessionFilePath` from the run that produced the failed output, so callers can resume that session with feedback to re-emit corrected output instead of repeating the work.

## 0.5.11

### Patch Changes

- 5ac972a: Bump default Claude Code model from `claude-opus-4-6` to `claude-opus-4-7`.
- 7cefd7c: Allow `noSandbox()` in `run()` and `createSandbox()`. Previously it was only accepted by `interactive()`. Use this when running Sandcastle from inside an already-isolated environment (containerized CI, VM, sandbox host) and you want the agent to operate directly on the host without a nested container.

## 0.5.10

### Patch Changes

- 95d63a4: Apply `:z` SELinux label by default on Docker bind mounts, matching the existing Podman behavior. Adds `selinuxLabel` option to `DockerOptions` (`"z"` | `"Z"` | `false`, default `"z"`). Extracts shared `formatVolumeMount` from Podman provider into `src/mountUtils.ts` so both providers use the same volume-mount formatter.
- 9bf43df: Auto-create parent directories for file-target bind mounts under `/home/agent`. When a user mount targets a single file whose sandbox-side parent directory may not exist in the image (e.g. `/home/agent/.codex/auth.json`), both Docker and Podman providers now run `mkdir -p` + `chown` on the parent at container start. File mounts whose parent is outside `/home/agent` fail at config time with a clear error and remediation guidance.
- adbb3cc: Add `variant` option to the `opencode` agent provider for controlling reasoning effort via opencode's `--variant` CLI flag.

## 0.5.9

### Patch Changes

- 1b742cb: Replace hardcoded "GitHub issues" language in simple-loop and sequential-reviewer templates with backlog-agnostic wording so scaffolded projects read correctly regardless of the chosen backlog manager.
- a85d6c0: Add Docker UID alignment via build-arg and pre-flight diagnostic. Dockerfile templates now accept `AGENT_UID`/`AGENT_GID` build-args (default 1000) and `sandcastle docker build-image` defaults them to the host UID/GID. The Docker provider gains `containerUid`/`containerGid` options and a pre-flight `docker image inspect` check that catches UID mismatches before container start. See ADR-0014.
- 856e6b7: fix: unescape `\n`, `\r`, `\t`, and `\\` in double-quoted `.env` values to match standard dotenv semantics
- 77590d0: fix: sequential-reviewer template uses createSandbox so implementer and reviewer share a branch

  The sequential-reviewer template previously used `merge-to-head` for the implementer, which merged the temp branch into HEAD and deleted it. The reviewer then tried to create a worktree for the host branch (e.g. `main`), which was already checked out — causing a git worktree conflict.

  Restructured to use `createSandbox()` with an explicit named branch, so both the implementer and reviewer run in the same sandbox on the same branch. This matches the pattern used by the parallel-planner-with-review template.

- c9f8348: Fix Docker mount failures on Windows hosts by switching from `-v host:sandbox` to `--mount type=bind,source=...,target=...` format (avoiding colon ambiguity with drive letters), and adding missing `patchGitMountsForWindows` calls in `createSandbox` and `createSandboxFromWorktree` code paths.
- 0fd2e74: Add structured output support: `Output.object({ tag, schema })` and `Output.string({ tag })` extract typed, validated payloads from agent stdout. Adds `output` option to `RunOptions` with overloaded return type, `StructuredOutputError` for extraction failures, and entry-time validation for `maxIterations === 1` and tag-in-prompt checks.

## 0.5.8

### Patch Changes

- 7400ead: Add a short hint to the `parallel-planner` and `parallel-planner-with-review` plan prompts noting that the issues list is already filtered, so the planner agent is less likely to requery and pick up issues outside the configured filter.
- 21b6442: Fix Windows hosts emitting backslash separators for in-container paths during session capture/resume and `copyPaths`. `sandboxSessionStore`, `defaultSessionPathsLayer`, and `startSandbox`'s `copyPaths` now use POSIX joins for paths that target the Linux container, so `docker cp` / `podman cp` no longer reject them on Windows.

## 0.5.7

### Patch Changes

- 904ad82: Fix `PromptError: Prompt argument "{{TASK_ID}}" has no matching value in promptArgs` thrown on every iteration of the `simple-loop`, `sequential-reviewer`, and `parallel-planner*` merge flows after `sandcastle init`. The `VIEW_TASK_COMMAND` and `CLOSE_TASK_COMMAND` registry values used to embed `{{TASK_ID}}`, which got baked into prompts whose runtime promptArgs do not include `TASK_ID`. They now use a plain `<ID>` placeholder for the agent to fill in from surrounding context.

## 0.5.6

### Patch Changes

- 54b5111: Add `timeouts.copyToWorktreeMs` option to override the host-to-worktree copy timeout (default: 60 000 ms).
- d8484ca: Surface fallback `cp -R` failures from `copyToWorktree` as a typed `CopyToWorktreeError` instead of silently swallowing them
- b6cc84f: Fix `WorktreeManager.pruneStale` deleting active worktrees when `.sandcastle` (or any ancestor of the repo directory) is a symlink. `git worktree list` returns canonicalized paths, so the un-canonicalized prefix never matched the active set and parallel `createSandbox()` calls would wipe each other's worktrees mid-run, surfacing as `spawn /bin/sh ENOENT`.
- 26920ca: Fix `branchStrategy.baseBranch` being silently dropped when calling `sandcastle.run()` with a worktree-based sandbox. New branches now correctly fork from the requested `baseBranch` instead of the host's HEAD.
- bbb0f39: Fix `encodeProjectPath` to handle Windows paths by replacing backslashes with hyphens and stripping drive-letter colons, producing a valid single directory-name component on Windows.
- b2123e4: Add optional `timeoutMs` field to hook objects, allowing per-hook timeout overrides with fallback to the default 60s
- a658fcc: Update Quick Start install command to recommend `--save-dev` and note that Sandcastle is a dev/CI tool
- 425b77e: Use APFS clonefile (`cp -cR`) on macOS for copy-to-worktree instead of GNU `--reflink=auto`, giving Mac users instant copy-on-write on APFS volumes

## 0.5.5

### Patch Changes

- e868d2d: Fix `createWorktree` failing with "already exists" when reusing a preserved mid-rebase worktree. Collision detection now also matches by target path, covering the detached-HEAD state during an in-progress rebase.

## 0.5.4

### Patch Changes

- 9c8516d: Surface agent error details in `AgentError` when stderr is empty. Error events emitted to stdout by Codex and Pi, plus OpenCode's result text, are now parsed and included in the error message instead of being dropped.
- b2cc893: Show context window size per iteration in the run summary. Each iteration with usage data emits a `Context window: NNNk` line (tokens rounded up to the nearest 1000) in both terminal and log-to-file mode.
- 2843c1b: Support `baseBranch` when creating sandboxes, so new branches can be forked from a specified ref. Available both on `createSandbox` and in the named branch strategy.
- d860e84: Fix Beads Dockerfile build failure on arm64 hosts (e.g. Apple Silicon). The image now builds on both amd64 and arm64.
- fdd9b9e: Fix built-in review prompt templates so they respect the configured source branch instead of always diffing against `main`.
- cfbeb67: Fix parallel-planner-with-review template to capture reviewer result and merge commits from both implementer and reviewer runs
- eb03260: Fix transient worktree creation failure when `branch.autoSetupMerge` or `push.autoSetupRemote` is enabled globally
- 4032e64: Inline prompts (`prompt: "..."`) are now passed to the agent literally — no `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. Fixes #453: callers that build inline prompts from arbitrary content (issue bodies, PR descriptions) no longer fail when that content happens to contain `{{...}}`. Passing `promptArgs` alongside an inline prompt is now an error; use `promptFile` to opt into template behavior.
- 6bc4d74: Fix `PromptPreprocessor` executing `` !`...` `` patterns that arrive via `promptArgs` substitution. Argument values are now treated as inert data: only shell blocks written in the raw template are executed. Previously, any caller passing text through `promptArgs` (issue titles, bodies, docs excerpts, etc.) could hit spurious command execution — or, with untrusted inputs, remote shell execution — because the preprocessor scanned the fully-assembled prompt after substitution.
- 359907e: Add `onAgentStreamEvent` option to `logging` in log-to-file mode. The callback receives each `text` chunk and `toolCall` emitted by the agent, with the iteration number and a timestamp, so callers can forward the agent's output stream to an external observability system. Errors thrown by the callback are swallowed so a broken forwarder cannot kill the run.
- ce1bf1b: Support tilde expansion in `sandboxPath` for Docker and Podman mount configs.

  Users can now write `sandboxPath: "~/.npm"` and it expands to `/home/agent/.npm` inside the sandbox. The expansion uses the provider's declared `sandboxHomedir` (`"/home/agent"` for Docker and Podman). Using `~` in `sandboxPath` with a provider that has no `sandboxHomedir` throws a descriptive error at mount resolution time.

## 0.5.3

### Patch Changes

- 2e7147b: Show commit-aware sync logs only for isolated sandboxes. Displays "Syncing N commit(s) to host" when commits exist or "No commits to sync out" when there are none, instead of the generic "Syncing changes to host" message. Bind-mount providers no longer show sync logs since sync-out only applies to isolated sandboxes.
- b0d5400: Fix git worktree mounts broken on Windows hosts (issue #410). On Windows, the parent `.git` directory is now mounted at a deterministic POSIX path inside the sandbox, and the worktree's `.git` file is patched with a corrected `gitdir:` path that resolves inside the Linux container.

## 0.5.2

### Patch Changes

- 1c71374: Add AbortSignal support for cancelling runs and interactive sessions. Pass `signal` to `run()`, `interactive()`, `Sandbox.run()`, `Sandbox.interactive()`, or any Worktree equivalent. Aborting kills the in-flight agent subprocess; handles remain usable for subsequent calls. Lifecycle hooks (`host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady`) are also cancelled when the signal fires.
- 148905b: Expose per-iteration token usage on `IterationResult` via a new `usage?: IterationUsage` field. Returns raw token counts (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) for Claude Code runs. Non-Claude agent providers return `undefined`.
- 95ef2bd: Fix Codex agent provider not logging output during runs.
- 6ca70c1: Fix session resume failing with `docker cp (in) failed` / `podman cp (in) failed` when the sandbox's project directory didn't yet exist.
- 8d4e8ef: Fix Windows paths breaking Docker/Podman volume mounts. Backslashes in host paths and Windows-style sandbox paths are now normalized before reaching the container runtime.
- a971e1e: Faster sandbox startup — remove the recursive `chown` that ran on every Docker and Podman container start. Add `containerUid`/`containerGid` options to the Podman provider for controlling in-container ownership.
- 49c461e: Fix duplicate command entries appearing in the task log. Each command now appears once (with its token count).
- a2dff20: Remove `throwOnDuplicateWorktree` option; worktrees are now always reused — clean worktrees log a message, dirty worktrees log a warning.
- 51d668c: Fix runs failing when prompts exceed 128 KB on Linux. Prompts are now delivered via stdin instead of command-line arguments, avoiding the `execve(2)` argument size limit.
- 308a1f6: `Worktree.run()` now accepts `resumeSession` to resume a prior Claude Code session by ID, matching the existing support on top-level `run()`.

## 0.5.1

### Patch Changes

- ba6121e: Add a `cwd` option to `createSandbox()`, `createWorktree()`, `run()`, and `interactive()`. When provided, `cwd` replaces `process.cwd()` as the host repo directory used for worktrees, `.sandcastle/.env`, logs, patches, and git operations, letting you drive Sandcastle from outside the target repo. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is raised when the path does not exist or is not a directory.
- f872268: Fix session capture, which always failed with "Could not find the file". Sandcastle was looking for session JSONLs under a `sessions/` subdirectory that Claude Code does not actually use.

## 0.5.0

### Minor Changes

- 800e743: Restructure hooks API to group by execution location (`host` vs `sandbox`). The old flat `hooks: { onSandboxReady }` shape is replaced with `hooks: { host?: { onWorktreeReady?, onSandboxReady? }, sandbox?: { onSandboxReady? } }`. Host hooks run on the developer's machine; sandbox hooks run inside the container. Breaking change (pre-1.0).

### Patch Changes

- 4515aa9: Add `copyFileIn` and `copyFileOut` methods to `BindMountSandboxHandle` for moving individual files between the host and the sandbox. Docker uses `docker cp`, Podman uses `podman cp`, and the new `testBindMount()` provider uses a plain filesystem copy.
- 3aa9d9a: Fix Podman sandbox failing on macOS when host UID differs from 1000 by chowning /home/agent to the host UID:GID after container start, matching Docker provider behavior.
- 0a84413: **Breaking:** Replace `RunResult.iterationsRun` with `RunResult.iterations: IterationResult[]`. Each `IterationResult` carries an optional `sessionId` extracted from Claude Code's stream-json init line. Consumers needing the iteration count should read `iterations.length`. Non-Claude agent providers produce `sessionId: undefined`. The same change applies to `OrchestrateResult`, `SandboxRunResult`, and `WorktreeRunResult`.
- 85eb071: Add session capture and resume for Claude Code:
  - **Capture:** after each iteration, the agent's session is saved to the host at `~/.claude/projects/<encoded>/sessions/<id>.jsonl` so it can be replayed or inspected locally with Claude Code's usual tooling. Adds `captureSessions` option to `claudeCode()` (default `true`) and `sessionFilePath` to `IterationResult`.
  - **Resume:** adds `resumeSession` option to `run()` for continuing a prior Claude Code conversation in a new sandbox run. Incompatible with `maxIterations > 1`.
  - Exposes the underlying `SessionStore` interface and `transferSession` helper for users who want to move sessions between the host and a sandbox directly.

## 0.4.8

### Patch Changes

- c8cfcc6: Add timeout to the isolated provider `copyPaths` loop in `startSandbox`. The entire copy loop is now wrapped with `withTimeout` (120s), producing a `CopyToWorktreeTimeoutError` on expiry, consistent with the per-step timeout pattern used elsewhere in the sandbox lifecycle.
- bab11e9: Add `network` option to Docker and Podman sandbox providers for custom container networking
- a2c580f: Make Dockerfile generation aware of the selected backlog manager. When "beads" is chosen, the Dockerfile installs beads CLI tools instead of GitHub CLI.
- a2fd5ad: Generate `.env.example` dynamically during `sandcastle init` based on selected agent and backlog manager instead of copying a static file from the template directory.
- 20741fe: Fix parallel-planner templates to use {{CLOSE_TASK_COMMAND}} placeholder instead of hardcoded "close the issue" language, and replace "GitHub issue" with backlog-agnostic wording
- b7880ec: Make `prompt`/`promptFile` optional in `interactive()` — when neither is provided, the agent TUI launches with no initial prompt (the full prompt pipeline is skipped).
- aea1131: Add per-step timeouts across the sandbox lifecycle. Every lifecycle step is now wrapped with `Effect.timeoutFail` via a `withTimeout` utility, producing a step-specific tagged error on expiry. Breaking: `TimeoutError` renamed to `AgentIdleTimeoutError` with `timeoutMs` field replacing `idleTimeoutSeconds`.
- c261079: Support relative paths in MountConfig for bind-mount sandbox providers. `hostPath` relative paths resolve from `process.cwd()`, and `sandboxPath` relative paths resolve from the sandbox repo directory.
- d13acc3: Remove unnecessary `copyToWorktree` and `branchStrategy` from planner and merger agents in parallel planner templates. These lightweight agents (maxIterations: 1) now default to head mode, avoiding the overhead of copying node_modules into worktrees.
- 0f8a99a: Remove semaphore concurrency limiter from parallel-planner-with-review template. Issue pipelines now run concurrently via Promise.allSettled without a concurrency cap, matching the parallel-planner template.
- bf23e83: Rename workspace terminology back to worktree across the codebase. All public API types and functions renamed from `Workspace*` to `Worktree*` (e.g. `createWorktree()`, `Worktree`, `WorktreeBranchStrategy`). `copyToWorkspace` renamed to `copyToWorktree`. `sandboxWorkspacePath` renamed to `sandboxRepoPath` and `SANDBOX_WORKSPACE_DIR` to `SANDBOX_REPO_DIR` for sandbox-internal paths. Source files renamed accordingly (`WorktreeManager.ts`, `CopyToWorktree.ts`, `createWorktree.ts`).

## 0.4.7

### Patch Changes

- 6d0c1fb: Make `sandbox` optional in `InteractiveOptions`, defaulting to `noSandbox()`

## 0.4.6

### Patch Changes

- fdeccd4: Change agent provider `buildPrintCommand` and `buildInteractiveArgs` to accept an options object `{ prompt, dangerouslySkipPermissions }` instead of a bare prompt string. The `claudeCode()` factory now conditionally includes `--dangerously-skip-permissions` based on the boolean.
- f413493: Add backlog manager selection to `sandcastle init` (GitHub Issues or Beads). All templates use placeholders (`{{LIST_TASKS_COMMAND}}`, `{{VIEW_TASK_COMMAND}}`, `{{CLOSE_TASK_COMMAND}}`) replaced at scaffold time with the correct commands for the chosen manager. Parallel-planner uses `{ id: string }` instead of `{ number: number }` in plan JSON, `TASK_ID` instead of `ISSUE_NUMBER` in prompt args, and raw IDs in log output. Selecting Beads skips the "Create Sandcastle label" step.
- 0e2e5fe: Fix `sandcastle init` to strip `--label Sandcastle` from scaffolded prompt files when user declines label creation
- f413493: Add `interactive()` API for launching interactive agent sessions inside sandboxes, replacing the old `interactive` CLI command. Includes the `sandbox.interactive()` method on `createSandbox()`, full prompt preprocessing (promptFile, shell expressions, argument substitution), all three branch strategies, `onSandboxReady` hooks, `copyToWorkspace` for worktree providers, env resolution, and `interactiveExec` on Docker and Podman providers. ClackDisplay now shows intro/summary and progress (creating worktree, copying files, starting sandbox, syncing, merging, commit collection) for interactive sessions.
- 29d224d: Add interactive arg collection for missing prompt arguments. When `interactive()` encounters `{{KEY}}` placeholders with no matching prompt argument, it prompts the user at the terminal via `@clack/prompts` text input. Built-in args (`SOURCE_BRANCH`, `TARGET_BRANCH`) are excluded from prompting. `run()` behavior is unchanged.
- 83a86f6: Add no-sandbox provider for interactive mode. `noSandbox()` runs the agent directly on the host with no container isolation — only accepted by `interactive()`, not `run()` or `createSandbox()`. The agent does not receive `--dangerously-skip-permissions`, so the user manages permissions themselves. Import from `@ai-hero/sandcastle/sandboxes/no-sandbox`.
- f413493: Fix Podman integration: rootless mode support with `--userns=keep-id` flag (configurable via `userns` option), pre-flight image existence check, Podman Machine detection on macOS/Windows, 5s timeout on signal handler cleanup, correct `:ro,z` syntax for SELinux-labeled readonly bind mounts, and `interactiveExec` for interactive agent sessions via `podman exec -it`.
- 0cde1a2: Add PodmanLifecycle module and `sandcastle podman build-image` / `sandcastle podman remove-image` CLI commands, mirroring the existing Docker CLI commands for Podman users.
- 530a8af: Fix Podman container crashes: rename base image's `node` user (UID 1000) to `agent` instead of creating a new user, so `--userns=keep-id` maps to the correct home directory owner. Override entrypoint in `podman run` to avoid double-sleep when the image already defines `ENTRYPOINT ["sleep", "infinity"]`.
- 8bcb78e: Add post-agent logging to withSandboxLifecycle for syncing, merging, and commit collection phases
- 1844288: Rename `copyToSandbox` option to `copyToWorkspace` across the public API (`run()`, `interactive()`, `createSandbox()`) and rename internal module `CopyToSandbox.ts` to `CopyToWorkspace.ts`. This aligns with the formalized distinction between "sandbox" (isolation boundary) and "workspace" (directory where the agent runs). No behavior changes.
- 35feb6f: Add sandbox provider selection (Docker / Podman) to `sandcastle init`. Selecting Podman writes `Containerfile` instead of `Dockerfile` and uses Podman-specific build commands.
- c54e389: Show per-command estimated token counts in the "Expanding shell expressions" taskLog after shell expressions resolve

## 0.4.5

### Patch Changes

- e84ffe3: Add a Codex `effort` option that forwards `model_reasoning_effort` to Codex for exec and interactive runs.

## 0.4.4

### Patch Changes

- 98d22da: Add `applyToHost` lifecycle callback to `SandboxInfo` so isolated providers can sync changes to the host worktree before host-side git operations. Fix `baseHead` recording to use the host worktree instead of the sandbox, ensuring correct commit collection after `syncOut` creates new SHAs via `format-patch`/`am`.
- be40c63: `createSandbox()` now uses the shared `startSandbox` helper, adding support for isolated sandbox providers (e.g. Vercel, Daytona). Each `run()` call syncs commits back to the host worktree via `applyToHost`.
- 0d393c9: Write SandboxError messages to the log file when run() fails in file-logging mode
- c0a4db3: Isolated sandbox providers now create worktrees, matching the bind-mount lifecycle. This enables proper branch strategy support (merge-to-head and named branches) and failure-mode worktree preservation for isolated providers.
- 973ed21: Run onSandboxReady hooks and shell expressions in parallel for faster environment setup
- 4f99506: Allow optional whitespace inside prompt argument placeholders so that both `{{ARG}}` and `{{ ARG }}` resolve identically

## 0.4.3

### Patch Changes

- e3fd351: Add `sudo` option to hook commands and `exec()` interface for running commands with elevated privileges inside sandboxes
- a30acb3: Strip matching surrounding quotes from .env file values so that `KEY="value"` and `KEY='value'` are parsed as `value` instead of including literal quote characters
- f1fdd4f: Log files now append between runs instead of overwriting. Each run writes a `--- Run started: <ISO timestamp> ---` delimiter header, preserving logs from previous runs of the same branch+agent combination.

## 0.4.2

### Patch Changes

- cd2a219: Fix templates crashing with "copyToSandbox is not supported with head branch strategy" by adding explicit `branchStrategy: { type: "merge-to-head" }` to all template `run()` calls that use `copyToSandbox`.
- 2cafddd: Use sandbox provider's `workspacePath` instead of hardcoded `/home/agent/workspace` for sandbox-side commands, fixing Vercel sandbox support where the workspace is at `/vercel/sandbox/workspace`.

## 0.4.1

### Patch Changes

- 0bb95e2: Add CODING_STANDARDS.md to reviewer-based templates (sequential-reviewer, parallel-planner-with-review) so the reviewer agent has concrete standards to enforce during code review.
- bb444af: Add optional `mounts` config to `docker()` and `podman()` providers for mounting host directories (e.g. package manager caches) into sandbox containers. Each mount supports `hostPath` (with `~` expansion), `sandboxPath`, and optional `readonly` flag. Throws a clear error if a host path does not exist.
- 16315da: Add Daytona isolated sandbox provider (`@ai-hero/sandcastle/sandboxes/daytona`)
- a8e7d72: Add OpenCode as a built-in agent provider. The `opencode()` factory returns an `AgentProvider` that invokes `opencode run` with raw stdout passthrough (no JSON stream parsing). Includes CLI registry entry, init scaffold with Dockerfile template, and documentation.
- 9d6dfba: Add `parallel-planner-with-review` template that combines parallel execution with per-branch code review using `createSandbox`. Also fix `maxIterations` defaults: sequential-reviewer reviewer 10→1, parallel-planner merger 10→1.
- 859f2f5: Add Podman sandbox provider (`sandcastle/sandboxes/podman`) as a bind-mount provider mirroring Docker's behavior with SELinux label support
- d917d69: Allow sandbox providers and agent providers to accept `env: Record<string, string>` at construction time. Provider env is merged with the `.sandcastle/.env` resolver output at launch, with provider values taking precedence. Agent and sandbox provider env must not have overlapping keys.
- 6192024: Add `throwOnDuplicateWorktree` option to `RunOptions` and `CreateSandboxOptions`. When set to `false`, a worktree collision reuses the existing worktree instead of failing. Defaults to `true` (current behavior).
- 22ec222: Add Vercel isolated sandbox provider (`sandcastle/sandboxes/vercel`) using `@vercel/sandbox` SDK
- 0d08a33: Buffer Pi provider text deltas before display to prevent one-word-per-line terminal output in stdout mode
- 448c9da: Support directories in `copyIn` for isolated sandbox providers and rename `copyOut` to `copyFileOut`
- c30f690: Derive CLI version from package.json instead of hardcoding it.
- 6e7738d: Fix sequential-reviewer template: replace broken prompt argument placeholders with self-contained issue selection and closure logic matching the simple-loop pattern
- a43cfe4: Merge `exec` and `execStreaming` into a single `exec` method with an optional `onLine` callback in options.

  **Breaking change (pre-1.0):** The `execStreaming` method has been removed from `BindMountSandboxHandle`, `IsolatedSandboxHandle`, and `SandboxService`. Use `exec(command, { onLine: (line) => ... })` instead.

  **Migration:** Replace `handle.execStreaming(cmd, onLine, { cwd })` with `handle.exec(cmd, { onLine, cwd })`.

- d1b75e4: Move `branchStrategy` from sandbox provider config to `run()` options. Branch strategy is now specified as an optional field on `RunOptions` instead of on provider factory functions like `docker()`. When omitted, defaults to `{ type: "head" }` for bind-mount providers and `{ type: "merge-to-head" }` for isolated providers. Using `{ type: "head" }` with an isolated provider now throws a clear runtime error.
- 8265b88: Remove Docker-specific language from JSDoc comments on provider-agnostic APIs
- 90c017d: Reset idle timer on any stdout line from the sandbox, not just parsed structured events. This prevents false idle timeouts for providers that emit non-JSON output (e.g. TUI-based agents).

## 0.4.0

### Minor Changes

- 40a756f: Replace `worktree` config with `branchStrategy` on the sandbox provider. Define `BranchStrategy` types (`head`, `merge-to-head`, `branch`) and wire them into bind-mount and isolated providers. `IsolatedSandboxProvider` exposes `branchStrategy` (defaulting to `{ type: "merge-to-head" }`), `testIsolated()` accepts a `branchStrategy` option, and TypeScript prevents `{ type: "head" }` on isolated providers at compile time. The deprecated `worktree` field on `RunOptions` and the `WorktreeMode` type have been removed. README documentation, code examples, the "How it works" section, and option tables have been updated to use `branchStrategy` terminology throughout.

### Patch Changes

- 6a16d69: Make chownInContainer non-fatal so sandbox startup doesn't crash when chown -R fails on macOS VirtioFS read-only bind mounts
- 105f1ef: Fix pi parser to handle current pi-mono JSON stream format
- 7bf0961: Remove TokenUsage feature from all providers and orchestrator. The TokenUsage interface, extractUsage helper, formatUsageRows function, and usage summary display have been deleted. ParsedStreamEvent's result variant no longer carries a usage field.
- c8df3a1: Point users to #191 for using Claude subscription instead of an API key in .env.example, README, and init CLI output

## 0.3.0

### Minor Changes

- 5b04e73: ### Breaking changes
  - `sandbox` is now a required option on `run()` and `createSandbox()`
  - `imageName` removed from top-level `RunOptions` and `CreateSandboxOptions` — image configuration now lives inside the sandbox provider (e.g. `docker({ imageName })`)
  - `docker()` factory is exported exclusively from `@ai-hero/sandcastle/sandboxes/docker`
  - `sandcastle build-image` and `sandcastle remove-image` are now `sandcastle docker build-image` and `sandcastle docker remove-image`

  ### New features
  - Pluggable sandbox provider abstraction with bind-mount and isolated provider types
  - `createBindMountSandboxProvider` and `createIsolatedSandboxProvider` factories
  - Filesystem-based test isolated provider
  - Git bundle sync-in for isolated providers
  - `copyToSandbox` support for isolated providers via `copyIn` after sync-in
  - Git format-patch/am sync-out for committed changes
  - Git diff/apply sync-out for uncommitted changes
  - Untracked file extraction via `copyOut` back to the host
  - Artifact persistence and recovery for failed sync-out (patches saved to `.sandcastle/patches/<timestamp>/`)

## 0.2.4

### Patch Changes

- 4d79ab9: Add optional `effort` parameter to `claudeCode()` for controlling Claude Code's reasoning effort level (`low`, `medium`, `high`, `max`)

## 0.2.3

### Patch Changes

- 01846be: Fix Docker sandbox failing when run from a git worktree. When `.git` is a worktree file (not a directory), also mount the parent repository's `.git` directory so git can resolve the repository inside the container.

## 0.2.2

### Patch Changes

- 008e539: Use `.mts` extension for scaffolded main file to fix ESM resolution in projects without `"type": "module"` in package.json. When the project's package.json has `"type": "module"`, the file is scaffolded as `main.ts` instead.

## 0.2.1

### Patch Changes

- fc62054: Fixed npm global install permission error in PI and Codex agent Dockerfiles by running `npm install -g` as root before switching to the `agent` user.

## 0.2.0

### Minor Changes

- 674e426: Add `{ mode: 'none' }` worktree variant that bind-mounts the host working directory directly into the sandbox container. No worktree is created, pruned, or cleaned up, and no merge step runs after iterations complete. Commits go directly onto the host's checked-out branch. `copyToSandbox` throws a runtime error with `mode: 'none'`. Both `SOURCE_BRANCH` and `TARGET_BRANCH` built-in prompt arguments resolve to the host's current branch.

### Patch Changes

- 77765bb: Add codex agent provider: `codex(model)` factory, stream parser for Codex CLI's `--json` JSONL output, Dockerfile template, init scaffolding, and CLI support
- 1f2134d: Add pi as a supported agent provider. `pi(model)` factory function is exported from `@ai-hero/sandcastle`. Pi's `--mode json` JSONL output is parsed correctly (message_update, tool_execution_start, agent_end events). `sandcastle init --agent pi` scaffolds a working setup with pi's Dockerfile and correct `main.ts`. `sandcastle interactive --agent pi` launches an interactive pi session.
- 3aff5f5: Refactor AgentProvider to runtime-only factory pattern. `run()` now requires `agent: claudeCode("model")` instead of `model: "..."`. The `claudeCode` factory and `AgentProvider` type are now exported from the package. Removed: `getAgentProvider`, `parseStreamJsonLine`, `formatToolCall`, `DEFAULT_MODEL` from public API.
- 75b4400: Bump default idle timeout from 5 minutes to 10 minutes to reduce spurious TimeoutError failures during long agent operations
- c62b429: Wire CLI interactive command for multi-agent support. The `interactive` command now accepts `--agent` and `--model` flags, uses the provider's `buildInteractiveArgs()` for docker exec, and displays the provider name in status messages.
- b1dd427: Add `createSandbox()` programmatic API for reusable sandboxes across multiple `run()` calls
- 54e76e0: Decouple init scaffolding from runtime providers. `envManifest` and `dockerfileTemplate` removed from `AgentProvider` interface. `sandcastle init` now has `--agent` and `--model` flags with interactive agent selection. Dockerfile templates owned by init's internal registry. Each template carries a static `.env.example` file copied as-is during scaffold. Scaffolded `main.ts` is rewritten with the selected agent factory and model.
- f35fa48: Log periodic idle warnings every minute of agent inactivity
- fabf0f7: Use run name instead of agent name in worktree and branch naming. When a `name` is provided to `run()`, worktree directories and temp branches now include the run name (e.g. `sandcastle/<name>/<timestamp>`) instead of the agent provider name. Renamed `sanitizeAgentName` to `sanitizeName`.
- cce183a: Replace top-level `branch` option on `RunOptions` with a `worktree` discriminated union that explicitly models two workspace modes: `{ mode: 'temp-branch' }` (default) and `{ mode: 'branch', branch: string }`. This is a breaking change — the old `branch` field is removed.

## 0.1.8

### Patch Changes

- 783b4cd: Base worktree cleanup on uncommitted changes rather than run success/failure.

  Previously, worktrees were always preserved on failure and always removed on success. Now the decision is based on whether the worktree has uncommitted changes (unstaged modifications, staged changes, or untracked files):
  - Success + clean worktree: remove silently (same as before)
  - Success + dirty worktree: preserve and print "uncommitted changes" message
  - Failure + clean worktree: remove and print "no uncommitted changes" message
  - Failure + dirty worktree: preserve with current preservation message

  `RunResult` now includes an optional `preservedWorktreePath` field set when a successful run leaves a worktree behind due to uncommitted changes. `TimeoutError.preservedWorktreePath` and `AgentError.preservedWorktreePath` are only set when the worktree is actually preserved (dirty), not on every failure.

## 0.1.7

### Patch Changes

- 5eef716: Inject `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` as built-in prompt arguments. These are available in any prompt without passing them via `promptArgs`. Passing either key in `promptArgs` now fails with an error.
- 78ef034: Fix sandbox crash on macOS by setting `HOME=/home/agent` in the container environment. Previously, Docker's `--user` flag caused `HOME` to default to `/`, making `git config --global` fail with a permission error on `//.gitconfig`.
- fed9a66: Replace wall-clock timeout with idle-based timeout that resets on each agent output event.
  - Rename `timeoutSeconds` → `idleTimeoutSeconds` in `RunOptions` and `OrchestrateOptions`
  - Change default from 1200s (20 min) to 300s (5 min)
  - Timeout now tracks from last received message (text or tool call), not run start
  - Error message updated to: "Agent idle for N seconds — no output received. Consider increasing the idle timeout with --idle-timeout."

- b16e0e0: Support multiple completion signals via `completionSignal: string | string[]`. The result field `wasCompletionSignalDetected: boolean` is replaced by `completionSignal?: string` — the matched signal string, or `undefined` if none fired.
- 0f48ef8: Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

  When a run session ends in failure, the sandbox (Docker container) is removed but the
  worktree is now preserved on the host. A message is printed with the worktree path and
  manual cleanup instructions. On successful completion, both the sandbox and worktree
  are removed as before.

  `TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
  so programmatic callers can inspect or build on the preserved worktree.

## 0.1.6

### Patch Changes

- 1cd8bdb: Remove single-branch shortcut in parallel-planner template; always use the merge agent

## 0.1.5

### Patch Changes

- 1cd8bdb: Close GitHub issue when single-branch merge is performed directly in parallel-planner template

## 0.1.4

### Patch Changes

- 8e08f7e: Document custom completion signal in the Early termination README section
- 6f9d3be: Fix CLI option tables to show correct default `--image-name` as `sandcastle:<repo-dir-name>` instead of `sandcastle:local`
- 4c94c5f: Fix README incorrectly describing `.sandcastle/prompt.md` as a default for `promptFile`. Neither `prompt` nor `promptFile` has a default — omitting both causes an error. The `.sandcastle/prompt.md` path is a convention scaffolded by `sandcastle init`, not an automatic fallback.
- 0d93587: Include run name in log filename to prevent overwrites in multi-agent workflows. When `name` is passed to `run()`, it is appended to the log filename (e.g. `main-implementer.log` instead of `main.log`).
- 26683b5: Lead the API section with a simple run() example before the full options reference.
- 3e32b7b: Remove `sandcastle interactive` CLI command documentation from README
- 762642e: Remove stale `patches/` entry from scaffolded `.sandcastle/.gitignore`. Nothing in Sandcastle creates a `.sandcastle/patches/` directory — the worktree-based architecture eliminated patch-based sync.

## 0.1.3

### Patch Changes

- 8b43a04: Remove pnpm/corepack from default sandbox Dockerfile template. The base Node.js image already includes npm, so the `corepack enable` step is unnecessary overhead. All init templates now use `npm install` and `npm run` instead of pnpm equivalents.
- 925506d: Replace pnpm with npm in README documentation
- 74b3f3b: Replace pnpm with npm in scaffold templates. All generated prompt files and main.ts hooks now use `npm install` and `npm run` instead of pnpm, consistent with the project's migration to npm.

## 0.1.2

### Patch Changes

- 3ece5cb: Removed unused `mkdir -p /home/agent/repos` from Dockerfile template. The workspace is bind-mounted at `/home/agent/workspace`, so this directory was never used.

## 0.1.1

### Patch Changes

- 0f61f59: Filter issue lists by `Sandcastle` label in all templates. `sandcastle init` now offers to create the label on the repo.

## 0.1.0

### Minor Changes

- a5cff39: Hide `agent` option from public API. The `agent` field has been removed from `RunOptions` and the `--agent` CLI flag has been removed from `init` and `interactive` commands. Agent selection is now hardcoded to `claude-code` internally. The agent provider system remains as an internal implementation detail.

### Patch Changes

- f11fd90: Add JSDoc comments to all public-facing type properties: `RunResult`, `LoggingOption`, and `PromptArgs`.
- 1fc5e32: Add kitchen-sink `run()` example to README with inline JSDoc-style comments on every option. Also updates the `RunOptions` table to remove the hidden `agent` field, fix the `maxIterations` default (1, not 5), fix the `timeoutSeconds` default (1200, not 900), update the `imageName` default, and add the missing `name` and `copyToSandbox` fields. Removes the removed `--agent` flag from the `sandcastle init` and `sandcastle interactive` CLI tables.
- b713226: Migrate from npm to pnpm across the project (issue #168).
  - Added `packageManager: "pnpm@10.7.0"` to `package.json`
  - Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
  - Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
  - Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
  - Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
  - Updated `README.md` development and hooks examples to use pnpm
  - Updated `InitService.ts` next-steps text to reference pnpm

- cd429c0: Replace --ff-only with regular merge for worktree merge-back (issue #162)

  When the agent finishes, Sandcastle now uses `git merge` instead of `git merge --ff-only` to integrate the temp branch back into the host branch. This allows users to make commits on the host branch while Sandcastle is running without causing merge-back failures. Fast-forward still happens naturally when the host branch hasn't moved; only the requirement that it _must_ fast-forward is removed.

- db3adec: Show run name instead of provider name in log-to-file summary (issue #160).

  When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.

- df9fe6c: Surface tool calls in run logs (issues #163, #164, #165, #166).

  `parseStreamJsonLine` now returns an array of events per line. Assistant messages may produce `text` and/or `tool_call` items. Tool calls are filtered to an allowlist (Bash, WebSearch, WebFetch, Agent) with per-tool arg extraction, and displayed interleaved with agent text output. The Display service gains a `toolCall(name, formattedArgs)` method rendered as a dim-styled step in terminal mode and a plain log line in log-to-file mode.

- dbe5989: Update 'How it works' section in README to describe the worktree-based architecture, replacing the outdated sync-in/sync-out description. Also fix related references to sync-in/sync-out throughout the README.
