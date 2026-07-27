# Sandcastle

A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations.

## Language

### Core concepts

**Sandcastle**:
The TypeScript CLI tool that orchestrates an **agent** inside a **sandbox**.
_Avoid_: "the tool", "the CLI", "RALPH"

**Sandbox**:
The isolation boundary around the **agent** -- a container, VM, or similar environment that constrains the **agent**'s access.
_Avoid_: "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature), "workspace"

**Host**:
The developer's machine where Sandcastle runs and the real git repo lives.
_Avoid_: "local" (ambiguous -- the sandbox also has a local filesystem)

**Agent**:
The AI coding tool invoked inside the **sandbox** (e.g. Claude Code, Codex).
_Avoid_: "RALPH", "the bot", "Claude" (too specific -- agent is swappable)

### Sandboxes

**Sandbox provider**:
A pluggable implementation that creates and manages a **sandbox**, injected into `run()` via the `sandbox` option.
_Avoid_: "backend", "runtime", "sandbox factory"

**Bind-mount sandbox provider**:
A **sandbox provider** where the **host** filesystem is mounted directly into the environment.
_Avoid_: "local provider", "mount provider"

**Isolated sandbox provider**:
A **sandbox provider** where the environment has its own filesystem, requiring sync to move code in and commits out.
_Avoid_: "remote provider", "sync provider"

**No-sandbox provider**:
A **sandbox provider** where no container is created -- the **agent** runs directly on the **host**.
_Avoid_: "local provider", "none provider", "host provider"

### Branching

**Branch strategy**:
Per-execution Sandcastle configuration that controls how the agent's changes relate to branches. It is independent of sandbox-provider construction; Company Runtime freezes the resolved value in the Execution Profile/Snapshot and supplies it to `run()`/`interactive()`/`createWorktree()`.
_Avoid_: "worktree mode" (old name), "branch mode"

**Head (branch strategy)**:
A **branch strategy** where the **agent** works directly in the **host** working directory -- no **worktree**, no branch indirection.
_Avoid_: `"none"` (old name), "direct"

**Merge-to-head (branch strategy)**:
A **branch strategy** where Sandcastle creates a temporary branch, the agent works on it, and changes are merged back to HEAD.
_Avoid_: `"temp-branch"` (old name), "auto-branch"

**Branch (branch strategy)**:
A **branch strategy** where commits land on an explicitly named branch provided by the caller.
_Avoid_: "named-branch"

**Worktree**:
A git worktree created under `<repository-root>/.sandcastle/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**; a Sandbox temp directory is not a Worktree.
_Avoid_: "workspace", "branch copy", "clone"

**Execution tree**:
The Agent-writable filesystem/Git database inside an isolated Sandbox for one formal **Workspace allocation**. It is initialized from an exact base but cannot access the host/shared Git common directory; its commit/patch/bundle output reaches the Runtime-owned host **Worktree** and source branch only through a verified importer.
_Avoid_: **Worktree** (the host-side import destination), a bind mount exposing shared `.git`, Repository root

**Work Package**:
A formally versioned implementation contract produced from an approved **Technical Baseline**. Each version belongs to exactly one Application and Repository and declares its objective, acceptance criteria, dependencies, module scope, required permissions, assignment criteria, required `branch` strategy/isolation, expected Artifacts, and integration conditions. It does not own concrete runtime resources: every **Node attempt** gets its own **Workspace allocation** and assigned AI member. Cross-Repository goals use dependent Work Packages rather than one multi-write attempt.
_Avoid_: **Task** (reserved for an issue-tracker work item), "subtask" (does not express the frozen execution contract), sharing one writable Worktree between parallel Agents

**Workspace allocation**:
The Attempt-owned, idempotently provisioned execution tuple that resolves one Work Package Version to an assigned AI member, source branch, Worktree, **execution tree**, Sandbox, Company Runtime-owned Interaction session, optional provider Agent session, operation key, and cleanup evidence. For a formal Work Package, the Agent cannot write the host/shared Git common directory: its execution tree produces commits/patches and a Runtime-owned importer may advance only the allocated source branch. Reattachment may reuse an allocation only for the same non-terminal Attempt; a Retry or rework Attempt receives new writable resources.
_Avoid_: Work Package Version (static contract), sharing an allocation across Attempts, treating provider Agent session as the Interaction session

**Integration branch**:
A dedicated, generation-scoped branch that assembles approved **Work Package** changes in declared dependency order. Each participating Repository has its own Integration branch for an **Integration Generation**. Only an **Integration operation** with frozen inputs, independent review status, expected branch tip, conflict evidence, and test results may advance it; a package that has not passed Code Review cannot be silently included. The Integration branch is an intermediate delivery surface, not the user's final target branch.
_Avoid_: **Target branch** (that is the host branch selected by a branch strategy), "shared workspace" (parallel work remains isolated), silently cherry-picking unreviewed changes

**Integration Generation**:
An immutable, Project-level integration manifest for one bounded assembly attempt across all participating Repositories. It freezes each Repository's base commit, independently approved Work Package source commits, dependency order, and cross-application contract versions, and owns one Integration branch per Repository. A partial failure fails the generation; recovery creates a new generation rather than continuing from an unverified mixed tip.
_Avoid_: "integration run" (ambiguous with a Department run), one mutable cross-repository branch, reusing a partially failed branch without rebuilding from frozen inputs

**Integration operation**:
One idempotent application of an approved source commit to a Repository's generation-scoped **Integration branch**, identified by an operation ID, expected Integration-branch tip, source commit, and evidence result. It may produce an **Integration defect**, but it cannot modify the Developer's source branch, the user's **Target branch**, or bypass an independent Code Review result.
_Avoid_: "merge command" (the operation also owns validation and evidence), an unrecorded cherry-pick, direct repair on the Integration branch

**Integration defect**:
A traceable defect raised when Work Package changes cannot be combined or fail a cross-package contract, build, or integration check. It links the affected packages, branches, Worktrees, evidence, and responsible owner, and returns through the ordinary review and rework loop instead of being fixed invisibly by the orchestrator.
_Avoid_: "merge hiccup" (the defect has delivery impact), mutating a developer's branch without a recorded intervention

**Source branch**:
The branch the **agent** works on -- determined by the **branch strategy**.
_Avoid_: "working branch", "agent branch"

**Target branch**:
The **host**'s active branch at `run()` time -- the branch Sandcastle merges into when using **merge-to-head**.
_Avoid_: "base branch", "destination branch", "merge target"

**Release target branch**:
A user-selected Repository branch that an accepted **Delivery candidate** may be merged into by a separately authorized merge-kind **Release operation**, together with its expected tip. It is chosen at release time and is unrelated to the legacy `merge-to-head` **Target branch** captured at `run()` start.
_Avoid_: **Target branch** (branch-strategy term), **Integration branch** (pre-release assembly), production environment

### Agents

**Agent provider**:
A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.
_Avoid_: "agent adapter", "agent driver"

**Company Agent Adapter**:
A formally registered adapter for one locally installed **agent** that exposes a stable identifier, human-readable metadata, availability detection, and a minimal non-destructive test. It is the Company Runtime's integration record, not an AI member identity or a model selection.
_Avoid_: "agent provider" (the published Sandcastle library seam), display name as a persistent ID, custom command entry

**Agent Catalog**:
The Company Runtime read model of registered **Company Agent Adapters** and their latest local detection results. It describes what the host can use without owning a Department Run or silently selecting a fallback agent.
_Avoid_: "model catalog", "agent list" (too narrow), treating detection as execution

**Position Agent Binding**:
The default **Company Agent Adapter** reference owned by a **Position**. A **Department Run** snapshots this binding and may use an explicit temporary override, while the **AI member** identity remains unchanged.
_Avoid_: department-level agent, AI member provider, implicit fallback

### Execution

**Agent invoker**:
The Effect service (`Context.Tag`) that wraps the raw call handing a fully-resolved **prompt** to the **agent provider** for one **iteration**. The seam used to substitute a recording or scripted fake in tests without running a real **agent**.
_Avoid_: "agent runner", "agent caller"

**Iteration**:
A single invocation of the **agent** inside the **sandbox**, producing at most one commit against one **task**.
_Avoid_: "run" (ambiguous with the JS `run()` function), "cycle", "loop"

**AFK run**:
An automatic **agent** execution that is allowed to continue while the user is not actively watching or interacting with the computer. In the **workflow board**, AFK runs are reserved for approved execution after the generated workspace plan has been approved.
_Avoid_: "background run" (too broad), "autonomous run" (less specific about user attention)

**Task**:
A work item from the **issue tracker** that the **agent** selects and works on during an **iteration**.
_Avoid_: "job", "work item", "ticket"

**Completion signal**:
The `<promise>COMPLETE</promise>` marker in the **agent**'s output indicating all actionable tasks are finished. A pure termination signal -- carries no payload. Distinct from **structured output**.
_Avoid_: "done flag", "exit signal", conflating with **structured output**

**Hanging process**:
An **agent** invocation that has emitted its **completion signal** but whose underlying process has not exited (typically because a spawned child -- a `gh`/git subprocess or long-lived MCP server -- inherited the exec's stdout pipe and is keeping it open). The signal is visible in the buffered stream; only EOF is missing. Resolved by the **completion timeout** rather than waiting out the full **idle timeout**. Distinct from a genuinely stuck **agent**, which has produced no output at all.
_Avoid_: "stuck agent" (implies stuck _mid-work_, not done-but-not-exited), "zombie process", "lingering process", "hung sandbox"

**Completion timeout**:
A silence-based grace window that takes over from the **idle timeout** once a **completion signal** is detected in the **agent**'s output. Reset by every subsequent output line so trailing data (token-usage events, terminal `result` events, **structured output** tags emitted after the signal) is still captured. On expiry the run resolves **successfully** with a warning that the process is hanging -- in contrast to **idle timeout** expiry, which fails the run. Configured via `completionTimeoutSeconds`; default 60 seconds. Independent of `idleTimeoutSeconds` -- they cover different phases.
_Avoid_: "grace period" (too generic), "post-completion timeout", "completion grace window", "drain timeout"

**Structured output**:
A schema-validated JSON payload emitted by the **agent** inside a caller-specified XML tag and returned to the caller of `run()`. Configured via `output: Output.object({ tag, schema })`. Orthogonal to the **completion signal** -- a run can use either, both, or neither. The caller owns the prompt-side instruction telling the agent to emit the tag; Sandcastle does not inject it, and `run()` errors early if the resolved prompt does not contain the configured tag.
_Avoid_: "output payload", "result", "JSON output"

**Output schema**:
The Standard Schema validator (e.g. Zod, Valibot) the caller passes alongside the XML tag name to parse and validate **structured output**.
_Avoid_: "validator", "result schema"

### Prompts

**Prompt**:
The instruction text passed to the **agent** at the start of each **iteration**.
_Avoid_: "system prompt" (too specific), "instructions" (too vague), "message"

**Inline prompt**:
A **prompt** provided as a string via the `prompt` option. Passed through to the **agent** as-is — no **prompt argument substitution**, no **prompt expansion**.
_Avoid_: "dynamic prompt", "string prompt"

**Prompt template**:
A **prompt** sourced from a file via the `promptFile` option. May contain `{{KEY}}` placeholders and `` !`command` `` **shell expressions**, which are resolved via **prompt argument substitution** and **prompt expansion** before being passed to the **agent**.
_Avoid_: "prompt file" (refers to the option, not the concept), "template prompt"

**Prompt argument**:
A runtime **template argument** passed via `promptArgs` in `run()` that substitutes a `{{KEY}}` placeholder in a **prompt**.
_Avoid_: "prompt variable" (ambiguous with env vars), "template variable", "parameter"

**Prompt argument substitution**:
**Template argument substitution** applied to a **prompt** at runtime, using the **prompt arguments** map.
_Avoid_: "template expansion", "interpolation", "variable substitution"

**Prompt expansion**:
The preprocessing step that evaluates **shell expressions** in a **prompt**, replacing them with their stdout.
_Avoid_: "prompt preprocessing" (too generic), "command expansion"

**Shell expression**:
A `` !`command` `` marker in a **prompt** that evaluates a shell command inside the **sandbox**.
_Avoid_: "command" (overloaded), "inline command", "prompt command"

**Built-in prompt argument**:
A **prompt argument** that Sandcastle injects automatically -- not provided by the user via `promptArgs`.
_Avoid_: "system variable", "auto argument", "default prompt argument"

### Hooks

**Host hook**:
A lifecycle hook that runs on the **host** machine, not inside the **sandbox**. Host hooks are `{ command: string }` — no `sudo`, no `cwd`.
_Avoid_: "local hook"

**Sandbox hook**:
A lifecycle hook that runs inside the **sandbox** container. Sandbox hooks are `{ command: string; sudo?: boolean }`.
_Avoid_: "container hook", "remote hook"

### Init

**Init**:
The CLI command that scaffolds the **config directory** in a **host** repo.
_Avoid_: "create", "bootstrap", "new"

**Config directory**:
The `.sandcastle/` directory in a **host** repo containing sandbox configuration.
_Avoid_: ".sandcastle folder", "sandcastle dir"

**Issue tracker**:
A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads). Used loosely -- Beads is a dependency-aware task tracker rather than a literal issue tracker, but "issue tracker" is the umbrella term.
_Avoid_: "backlog manager" (retired name), "task source"

**Template argument**:
A named `{{KEY}}` placeholder in a scaffold template (Dockerfile, prompt `.md` file) that **init** replaces with a value derived from the user's choices.
_Avoid_: "placeholder", "variable"

**Template argument substitution**:
The preprocessing step during **init** that replaces **template arguments** with their resolved values.
_Avoid_: "template expansion", "interpolation"

### Infrastructure

**Build-image**:
A provider-namespaced CLI command that rebuilds the image (e.g. `sandcastle docker build-image`).
_Avoid_: "setup-sandbox" (old name)

**Remove-image**:
A provider-namespaced CLI command that removes the image (e.g. `sandcastle docker remove-image`).
_Avoid_: "cleanup-sandbox" (old name)

**Agent session**:
The **agent**'s persisted conversation record. Storage shape and location are owned by the **agent provider** -- Claude Code writes a `<session-id>.jsonl` under `~/.claude/projects/<encoded-cwd>/`; other agents use their own conventions (e.g. `~/.codex/sessions/`, `~/.pi/agent/sessions/`, OpenCode's SQLite store). Resumable when the **agent provider** declares session-storage support; the resume mechanism is the agent's native flag (e.g. `claude --resume`, `codex exec resume`, `pi --session`).
_Avoid_: "chat history", "transcript"

**Interaction session**:
A Company Runtime-owned, durable conversation scope that binds an **AI member**, participants, mode, Project/Run/Node context, permissions, and an optional underlying **Agent session**. It is the shared Desktop/ACP authority for interaction metadata, not the provider-owned transcript or an execution attempt.
_Avoid_: **Agent session** (provider-owned persistence), **Node attempt** (formal execution identity), "chat tab" (UI-only)

**Interaction turn**:
One bounded prompt execution inside an **Interaction session**, with a stable ID, status, command identity, event range, cancellation result, and optional **Node attempt** binding. Consultation and product-discovery turns cannot create formal side effects and own an **execution lease** targeting the turn; a run-collaboration turn shares the bound Node attempt's Snapshot, permission policy, execution operation key, and **Node lease**.
_Avoid_: closing the whole Interaction session to cancel one turn, an untracked background Promise, treating a consultation answer as an official Artifact

**Session resume**:
Continuing an **agent session** by appending new turns to the same session record -- the session ID is unchanged and the prior record is mutated in place. Exposed as `RunResult.resume()`.
_Avoid_: "continue", "follow-up"

**Session fork**:
Branching an **agent session** into a new record with a new session ID, leaving the parent record byte-for-byte unchanged. Uses the **agent**'s native fork flag (`claude --fork-session`, `codex exec fork`). Exposed as `RunResult.fork()`. Isolates the session only -- not the **source branch** or **sandbox**.
_Avoid_: "branch" (overloaded with git branches), "copy session"

### Display

**Log-to-file mode**:
The display mode where Sandcastle writes iteration progress and agent output to a **run log**.
_Avoid_: "file mode", "file logging", "quiet mode"

**Run log**:
A log file written to `.sandcastle/logs/` during a run session.
_Avoid_: "log file" (too generic), "output file"

**Terminal mode**:
The display mode where Sandcastle renders an interactive UI in the terminal with spinners and styled status messages.
_Avoid_: "stdout mode", "interactive mode", "CLI mode" (ambiguous with the CLI itself)

**Agent stream event**:
A single item in the **agent**'s output stream -- either a `text` chunk or a `toolCall` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`. Narrower than a **runtime event**, which is its logging-mode-independent superset.
_Avoid_: "log event" (the log file contains more than just agent output), "display entry" (internal UI type)

**Runtime event**:
The protocol-neutral structured lifecycle and stream event model emitted by Sandcastle core or the **Company Runtime**. Core run events keep their published `run.*` / `iteration.*` names and are surfaced through `events.onRuntimeEvent`; Company-domain events use distinct names such as `department-run.*`, `node-run.*`, and `node-attempt.*` and are persisted in the **Runtime event outbox** with a global sequence. Runtime events are the only source for protocol adapters such as the **AG-UI adapter** and **ACP facade**; adapter events never become a second state model.
_Avoid_: "run event" (old name), "AG-UI event" (an adapter output), "ACP event" (a facade concern), "log event"

**Runtime audit record**:
An immutable record of a Company Runtime state mutation, including the affected entity, prior state when available, resulting state, verified actor, Command ID, and timestamp. It is written with the current-state mutation and is distinct from a **runtime event**, which is the replayable protocol-neutral observation. A Runtime-event Cursor acknowledgment is audited but does not emit another event into the acknowledged stream.
_Avoid_: "event log" (ambiguous with the outbox), "application log"

**Runtime event outbox**:
The durable, append-only queue of protocol-neutral **runtime events** persisted in the same SQLite transaction as Company Runtime state changes. Consumers advance independent cursors so AG-UI, ACP, and diagnostics can replay without becoming state owners.
_Avoid_: "message queue" (implies a remote broker), "event source" (v1 is not full event sourcing)

**Runtime event cursor**:
The durable highest contiguous global Runtime-event sequence acknowledged by one authenticated consumer. A consumer has only one active subscription generation: opening or View-syncing supersedes older handles, so an old stream cannot advance the new stream's delivered boundary. The consumer either acknowledges events delivered by its active generation or applies an authoritative Query View and consumes its short-lived view-sync token to rebase to that View's `asOfSequence`; it then replays every later sequence and filters locally. Acknowledgments update the cursor and audit record but never emit another event into the same outbox.
_Avoid_: "last delivered event" (application and acknowledgment are distinct), a per-view offset, `delivered_at` as one global delivery truth

**AG-UI adapter**:
A protocol adapter that maps **runtime events** to AG-UI-style event names (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, etc.) for the Desktop **agent interaction workspace** and other web UI/event-stream consumers. It carries live messages, steps, tool activity, usage, and Sandcastle-specific artifact or approval updates without making AG-UI part of core orchestration.
_Avoid_: "AG-UI runtime" (Sandcastle runtime events remain internal), "frontend event model"

**ACP facade**:
A v1 local protocol boundary that exposes Sandcastle's AI members and sessions to external ACP clients by mapping initialization, session creation, prompting, cancellation, updates, and permission requests onto existing Sandcastle operations. It runs through stdio or local IPC, uses the same permissions and runtime events as Desktop, and never replaces `run()` or the **sandbox provider** model.
_Avoid_: "ACP core", "public ACP service" (v1 is local-only), treating an ACP session as an AI-member identity

**Run failure evidence**:
Optional structured, plain (Effect-free) recovery metadata carried on a `run.error` **runtime event** (the `recovery` object) alongside the unchanged `message`. Surfaces what Sandcastle already knows about a failed run so a caller or the **workflow board** can recover: **run failure kind** and failure phase, preserved worktree path, **run log** path, **session** id/file, whether the **completion signal** was seen, and commit SHAs. Every field is optional. Observability/recovery metadata only — it never replaces the thrown error, logs, or verification reports.
_Avoid_: "error details" (too generic), "failure report" (reserved for the Board verification report), "diagnostics" (overloaded with prompt diagnostics)

**Run failure kind**:
The stable, coarse classification of why a run failed, carried on **run failure evidence**: `infrastructure` (the sandbox/host environment failed), `agent` (the agent process failed), `task` (the agent ran but did not satisfy the task contract, e.g. structured-output validation), or `unknown`. Lets a library consumer route infrastructure failures differently from agent or task failures without pattern-matching error text.
_Avoid_: "error type" (ambiguous with the tagged `SandboxError` classes), "failure category", "severity"

**Company failure kind**:
The Company Runtime domain classification `infrastructure | agent | task | quality | permission | unknown` used for Node, Gate, and recovery evidence. It maps core **run failure kind** values without changing that public four-value runtime-event contract and adds Company-only quality/permission outcomes.
_Avoid_: extending **run failure kind** in place, HTTP error classes, risk severity

### Workflow board

**Control plane**:
The productized local coordination layer built on top of Sandcastle's orchestration core. It records **board tasks**, **board runs**, plans, review state, feedback, and artifacts so humans can inspect and steer agent work from a local surface.
_Avoid_: "dashboard" (too generic), "desktop app" (one possible shell), "Rudder clone"

**Workflow board**:
A local web view of runs, started with `sandcastle board`. Consumes the **runtime event** stream to persist and visualize **board runs** -- a kanban grouped by status, live **agent** activity, per-repo progress, and per-model token usage -- replacing terminal-only observation. Serves a self-contained HTML frontend, a small JSON REST API, and a Server-Sent Events stream from a file-backed store under `.sandcastle/board/`.
_Avoid_: "dashboard" (too generic), "UI", "console"

**Board run**:
A single `run()` invocation as recorded on the **workflow board** -- its metadata plus fields derived from the **runtime event** stream (status, completion, commit count, token usage). Linked to a **board task** when launched from one.
_Avoid_: "job", "session" (overloaded), conflating with the JS **iteration**

**Board task**:
A unit of work created on the **workflow board** (title + prompt/PRD), created from a PRD file, or imported from an existing `workspace-plan.json` that is fanned out into per-repository **board runs** via `runWorkspaceTask`. The board acts as a **task** source that writes back into the orchestration core. See ADR 0022.
_Avoid_: "ticket", "issue" (reserved for the **issue tracker**), "job"

**Board task source**:
The origin of a **board task** as recorded by the **workflow board**. Current sources are manual board entry, PRD file input, and imported `workspace-plan.json` input. The source explains where the task came from; it is not the same as an **issue tracker**.
_Avoid_: "issue source" (conflicts with **issue tracker**), "task source" (already too close to **Task** from an **issue tracker**)

**Board role**:
One of the strict responsibilities in a **board task** workflow: Planner turns requirements into reviewed plans and Board issues, Generator executes only the approved plan, and Evaluator verifies delivery against recorded evidence. A **board phase** may expose the current **Board role**, but the role is the responsibility boundary rather than the UI step name.
_Avoid_: "agent role" (too broad), "worker" (ambiguous), conflating with **board phase**

**Company**:
The top-level v1 product object: the local AI company a user opens in the **control plane** -- one host machine, one **local AI company directory**, one Company Runtime-owned `company.db`, file-backed content, and the **departments** that operate inside it. It is not a tenant or org-chart domain. The legacy workflow-board store is a separate historical execution surface and is never a second Company state writer or dual-write target.
_Avoid_: "organization" (Rudder's enterprise term), "tenant", "workspace" (overloaded with the multi-repo workspace)

**Company Runtime**:
The Electron-supervised local process that is the single writer for one local AI company directory. It validates authenticated Command envelopes, owns SQLite transactions, audit, Runtime-event outbox, cursors, Interaction sessions, Artifacts, and formal domain persistence; Renderer, ACP, AI members, and execution adapters can request or report facts but cannot become state writers.
_Avoid_: "backend server" (v1 is local and process-scoped), **Pipeline Runtime** (one internal state machine), Renderer-owned state

**Pipeline Runtime**:
The Company Runtime module that exclusively transitions Department run, Node run, Node attempt, **execution lease**, dependency, and quality-gate state for a frozen **department pipeline**. It consumes structured Handler and Adapter facts; it never interprets free-form Agent text as a state mutation.
_Avoid_: **Company Runtime** (broader persistence boundary), "scheduler" (only one responsibility), an AI coordinator as state authority

**Department**:
An execution unit inside the **company** that owns one **department pipeline**, including its positions, task inputs, artifact kinds, and verification semantics. V1 lets users create, copy, and edit departments instead of limiting the company to a fixed set of built-in or placeholder departments.
_Avoid_: "team" (role/skill boundary matters), "module" (too code-shaped), "workflow" (a department owns workflows, it is not one)

**Department pipeline**:
The explicit, visual flow owned by one **department** that coordinates positions to transform a task input into one or more **artifacts**. Its v1 graph uses `start`, `ai-task`, `human-approval`, `condition`, `parallel`, `join`, and `complete` nodes; it is editable and resumable but does not allow arbitrary code nodes or an AI member to silently rewrite the overall flow while it runs.
_Avoid_: "workflow" (too generic), "board" (the current board is only the Software R&D implementation), "process" (does not express the product execution contract)

**Node Handler Kind**:
A canonical versioned discriminator such as `development@1` that selects one built-in Handler implementation inside a compatible closed-set Department-pipeline node type. Its registry entry defines input/output schema hashes, permissions, failure mapping, and contract tests. Pipeline Versions, Run Snapshots, and Node runs freeze the exact ID and registry hash; a current same-named implementation cannot reinterpret historical execution.
_Avoid_: "node type" (the ADR 0031 type set remains closed), user-supplied code, an unversioned switch branch

**Pipeline Draft**:
The mutable, revisioned **department pipeline** graph being edited before publication. Saving a Pipeline Draft never changes the Department's active **Pipeline Version**.
_Avoid_: "working version" (confuses a mutable draft with an immutable published version), "current pipeline" (ambiguous between draft and active published version)

**Pipeline Version**:
An immutable published **department pipeline** graph with a Department-local version number and integrity identity. Publishing freezes the selected **skill flow** meaning for that version, creates a new Pipeline Version, and preserves every earlier version.
_Avoid_: "draft version" (published versions are immutable), "pipeline snapshot" (reserved for the broader **run configuration snapshot**)

**Department run**:
One formal execution record of a versioned **department pipeline** for a **project**, always created atomically with `r1`. A Product-Baseline confirmation creates a root Run or a child Run for a newly confirmed Baseline. An explicit fork may replay a chosen immutable Snapshot with the same Baseline, or reconfigure declared Repository/Pipeline/execution inputs while invalidating affected downstream Gate promotions; it never shares mutable state with the parent or changes the confirmed goal/acceptance boundary. Its later Start node only schedules formal Node runs.
_Avoid_: "project stage" (stages belong to the selected pipeline), "board task" (the current Software R&D implementation), "agent session" (one run may involve several members and sessions)

**Run configuration snapshot**:
The immutable execution contract captured atomically whenever confirmation or explicit fork formalizes a **department run**, covering the confirmed Product Baseline, department pipeline graph and Handler registry, positions, AI-member configuration, selected skills and skill flows, execution defaults, and artifact contracts. The later Start node only schedules formal Node runs. Later accepted Specs, readiness evidence, or a **Technical Baseline** enter downstream execution only through an appended **Snapshot revision**; live configuration never changes an existing revision.
_Avoid_: "current config" (mutable), "backup" (the snapshot is an execution contract), "copy" (does not express version identity)

**Snapshot revision**:
An immutable, integrity-identified revision of a **run configuration snapshot** used by one **department run**. The first revision is `r1`; a `PASS` **Quality Gate Result** may explicitly promote accepted Spec, readiness, or Technical Baseline inputs into a later revision linked to its parent, while every earlier revision remains unchanged and inspectable. A conditional or failed result cannot promote a Snapshot.
_Avoid_: "snapshot version" (confuses a run-scoped revision with a Pipeline Version), "updated snapshot" (revisions are appended rather than mutated)

**Node run**:
The persistent execution state of one closed-set node type and versioned Handler kind from the frozen **department pipeline** inside a **department run**, including its dependency state, selected **snapshot revision**, status, and attempts. The Pipeline Runtime owns every Node run state transition; an AI member, execution adapter, or renderer may report facts but cannot write the state directly.
_Avoid_: "agent run" (a Node run may use an agent but is a pipeline concept), "pipeline step" (does not express persistent execution identity), "task" (reserved for an issue-tracker work item)

**Node attempt**:
One bounded execution attempt within a **Node run** using a specific **snapshot revision**. Retrying the same Node run creates a new attempt without replacing the earlier attempt's evidence or changing the Node run's stable identity.
_Avoid_: "retry" when referring to the persisted execution record, "iteration" (one agent invocation inside Sandcastle core), "node run" (an attempt belongs to a Node run)

**Recovery Attempt**:
A **Node attempt** created by an allowed Recovery Override and bound to a new **Snapshot revision**. A Recovery Attempt preserves the parent revision and prior evidence and does not consume the ordinary Retry allowance.
_Avoid_: treating Recovery Attempt as a normal Retry, mutating the parent Snapshot revision, or changing the project goal through recovery

**Continuation plan**:
An immutable Fork/Recovery decision manifest that compares source and target Snapshots and assigns every affected Node/Gate one explicit disposition: rerun, reuse exact immutable evidence, graph-defined skip, or blocked. It records the invalidation closure, Artifact provenance, target Attempt/subgraph, budget, and Run revision; Runtime never infers continuation ad hoc after a crash.
_Avoid_: “resume from where it stopped” without a manifest, copying mutable Node state into a child Run, reusing evidence whose Handler/schema/input hash changed

**Execution lease**:
A durable, time-bounded, fenced ownership record targeting exactly one **Node attempt** or standalone **Interaction turn**, with kind `execution` or `reconciliation` and one stable execution operation key. Runtime stamps Adapter facts from the active lease context; expiry moves the target to explicit reconciliation, and stale owners cannot mutate state.
_Avoid_: an unfenced callback, a worker-local mutex, using a Command ID as operation ownership

**Node lease**:
An **execution lease** whose target is a **Node attempt**. A proven running operation may continue only through supported reattachment; a new Attempt requires provider terminal evidence or a verifiable strong fence. Unknown/unobservable execution remains reconciling and blocked—human acceptance alone cannot assert that it stopped.
_Avoid_: "lock" (does not express expiry and recovery), "claim" when referring to the persisted ownership record, "worker session" (not an Agent session)

**Execution operation key**:
A stable identifier bound to one Node attempt or standalone Interaction turn and its external execution across **execution lease** ownership changes. For a Work Package it also binds the Workspace allocation. Every persisted Adapter fact is Runtime-stamped with the current lease epoch/fence token plus unique fact ID/ordinal; stale owners may remain useful evidence but cannot mutate current state. Production and scripted adapters use the key to deduplicate, cancel, reattach, and reconcile.
_Avoid_: Command ID (the Command only accepts/schedules work), Lease ID (ownership may change while the operation identity remains), generating a new key for an unknown retry

**Execution fact**:
A versioned, append-only Adapter report for one execution operation, identified by fact ID, ordinal, and canonical payload hash. The Adapter submits an unfenced body to a Runtime-bound sink; Runtime persists the envelope stamped with the active execution/reconciliation lease. It may describe provider/session start, messages, Tools, checkpoints, Artifacts, commits, usage, or one terminal outcome. `not-started` is terminal only when its accepted fact carries Provider receipt/evidence proving the operation key never began; a bare reconcile status is not evidence. Only a fact accepted under the active fence can drive Company Runtime state.
_Avoid_: free-form Agent text as a state mutation, an unfenced callback, overwriting a terminal fact

**Node feedback**:
A durable human instruction attached to a **Node run** and consumed by a later **Node attempt**, such as changes requested at a human-approval gate. Node feedback does not mutate the **run configuration snapshot**, replace evidence from an earlier attempt, or become project or AI-member memory automatically.
_Avoid_: "prompt edit" (the frozen execution contract is unchanged), "approval result" (the feedback guides a later attempt), "memory" (promotion is a separate explicit action)

**Software R&D department**:
The built-in, runnable **department** template in the v1 **company**: the current **workflow board** promoted into a software-delivery **department pipeline** made of positions, repositories, artifacts, review loops, and skill-guided agent work. Users may copy or edit it, and its PRD-to-plan-to-approval-to-execution-to-verification flow is a default template rather than the definition of every department.
_Avoid_: "company" (the department lives inside one), "organization" when referring to the v1 Sandcastle scope, "team" when the role/skill boundary matters, "the board" when the department product boundary is meant

**Project**:
A durable business-delivery goal and shared context that groups **department runs**, **artifacts**, and any number of **Repository references** or applications. A Project is the delivery object; a repository is only one code resource linked to it. Its visible progress comes from the pipelines the user runs for it, including a shared Project Spec and coordinated per-application Work Packages when several repositories participate.
_Avoid_: "repository" when referring to the company goal, "board task" or "department run" when referring to the whole project, assuming one Project maps to exactly one repository

**Application**:
A Project-scoped, independently described software unit with one Application reference, ownership, build/test entry points, contracts, and an **Application Spec**. An Application references one Repository, while a monorepo may contain multiple Applications; the Application is the cross-repository contract participant, not necessarily an independently deployed service.
_Avoid_: "repository" (a Repository may contain several Applications), "service" (not every Application is deployed as a service), an unregistered folder name

**Repository reference**:
A Project-scoped pointer to a source repository that a future **department run** may use. Linking a repository does not make it the **project**, copy its contents into the Company Directory, or start execution.
_Avoid_: "project repository" (a project may reference several repositories), "workspace" (overloaded), "department run" (linking is configuration, not execution)

**Project Spec**:
The versioned, project-wide production contract derived from the confirmed Product Baseline. It records the shared outcome, acceptance criteria, application boundaries, cross-application API and data contracts, delivery constraints, and the mapping to per-application Specs and Work Packages. Product Review always binds one exact Project Spec Revision and its integrity identity.
_Avoid_: "PRD file" (the Spec also governs cross-application production), "technical plan" (only one part of the contract), copying one repository's Spec as the Project definition

**Project Spec Revision**:
One immutable, integrity-identified revision of a **Project Spec**, bound to the exact **Product Baseline** from which it was derived. Product Review may accept a later revision, but no revision rewrites its predecessor or changes the confirmed requirement boundary.
_Avoid_: "current spec" without an ID/hash, mutating a reviewed draft, silently treating a scope change as a revision

**Readiness Evidence**:
An immutable result of one named readiness check over an exact **Project Spec Revision**, carrying its evidence references and either `ready` or `blocked`. A blocked result remains inspectable and blocks the current **department run** from Product Gate promotion.
_Avoid_: "readiness flag" (the evidence is durable and identified), deleting a failed check, treating Review Findings as readiness records

**Product Gate Promotion**:
The single append-only act permitted only by a `PASS` Product **Quality Gate Result** that fixes the accepted **Project Spec Revision** and exact ready **Readiness Evidence** into a new child **Snapshot revision**. `CONDITIONAL_PASS`, `FAIL`, any readiness blocker, or any scope-changing Product Review Finding prevents promotion in the current Run.
_Avoid_: "approve spec" (promotion includes readiness and Snapshot lineage), overwriting a Snapshot, promoting a conditional result

**Application Spec**:
The versioned production contract for one **Application** participating in a **Project Spec**. It refines the shared contracts into Application-specific design, acceptance criteria, Work Package constraints, and integration obligations without redefining the Project-level goal or silently diverging from cross-application contracts.
_Avoid_: "repository README", "independent project plan" (the Application Spec remains subordinate to the Project Spec), unversioned implementation notes

**Application Spec Revision**:
One immutable, integrity-identified revision of an **Application Spec**, bound to one registered **Application**, one exact promoted **Project Spec Revision**, and the applicable **Cross-Application Contracts**. A later revision supersedes rather than mutates its predecessor.
_Avoid_: "current application design" without an ID/hash, silently rebinding a revision to another Application or Project Spec

**Cross-Application Contract**:
An immutable, versioned API, data, or event agreement between producer and consumer **Applications**, identified by an exact version and content hash. An incompatibility is durable gate evidence and cannot be overridden by selecting a newer unreviewed contract.
_Avoid_: an unversioned interface note, a repository-only contract, treating compatibility as a mutable boolean

**Technical Baseline proposal**:
An immutable proposal revision assembled from the promoted Project Spec, Repository-readiness evidence, Application Spec revisions, architecture and dependency graph, cross-application contracts, risk/permission policy, and Test strategy. It is the exact hashed input to Technical Review; a revised design creates a new proposal revision, and it is not yet the accepted Technical Baseline.
_Avoid_: **Technical Baseline** (accepted only after a PASS Gate), a mutable draft, including its own future Gate Result in the reviewed-content hash

**Technical Baseline**:
The immutable accepted manifest materialized only after Technical Review returns a `PASS` **Quality Gate Result** over an exact **Technical Baseline proposal** hash. It records the exact proposal and reviewed input identities, while the separate **Technical Gate Promotion** records the acceptance Gate as external metadata so the Gate identity does not enter the accepted manifest hash recursively. Work Package fan-out reads only a Technical Baseline frozen by a later Snapshot revision.
_Avoid_: "technical design file" (the baseline is a canonical multi-artifact manifest), a live draft, changing an Application Spec after promotion without a new gate

**Technical Gate Promotion**:
The single append-only act permitted only by a fresh `PASS` Technical **Quality Gate Result** that materializes one accepted **Technical Baseline** and freezes its exact Project Spec, readiness, Application Spec, proposal, and Cross-Application Contract identities into a child **Snapshot revision**. Conditional, failed, incompatible, or stale inputs create no accepted baseline and no Snapshot.
_Avoid_: "approve architecture" (promotion also fixes all exact inputs and lineage), materializing the accepted baseline before Review, promoting a conditional result

**Spec**:
A versioned production contract that explains how a confirmed requirement is decomposed, designed, implemented, inspected, and verified. **Project Spec** and **Application Spec** are scoped forms of Spec; a Spec references its acceptance criteria, inputs, constraints, Harness, Artifacts, dependencies, and quality gates and is frozen by a Run Snapshot.
_Avoid_: "plan" when the execution contract and quality gates matter, "prompt" (a Spec is a durable Artifact), an unversioned design note used as the authority for a Run

**Local AI company directory**:
The host directory a user opens in Desktop v1 containing Company Runtime-owned `company.db`, immutable Snapshot/Artifact content, project files, Skill Flow/role configuration, indexes, journals, and backups. Electron `userData` stores personal preferences only. Legacy Board metadata remains in its own store and is not imported or dual-written into this directory.
_Avoid_: "repository", "workspace" (overloaded), "userData" when referring to company-owned data

**Position**:
A persistent seat in a **department pipeline** that defines one responsibility and is occupied by exactly one **AI member** in v1. A position configures the member's complete skill catalog and owns the expected inputs, actions, and artifacts at its points in the pipeline; each pipeline node activates only the skills or **skill flows** needed for that node.
_Avoid_: "Board role" (the current Software R&D implementation), "persona", "pipeline phase" (a position may participate in more than one phase)

**AI member**:
A long-lived digital employee inside a **department**, with a stable identity, position, responsibilities, bound **skill flows**, memory, and work history. Its identity is independent of the replaceable agent provider, model, sandbox, and execution limits used for a particular run; changing those execution choices does not create a new member or discard reviewed memory.
_Avoid_: "chat agent", "persona", "bot", a provider/model name, conflating the member with one agent process or session

**Product manager**:
The user-facing **position** and **AI member** that owns pre-run requirement discovery, clarification, and the **Product proposal** for a **project**. The Product manager works directly with the user until the requirement boundary becomes a confirmed **Product Baseline**, then hands that formal input to the **Delivery coordinator** for the downstream **department run**; it does not silently assume architecture or delivery authority.
_Avoid_: "intake bot" (the role owns product reasoning, not only message collection), "Delivery coordinator" (the handoff separates product discovery from delivery orchestration), an omnipotent agent that approves its own proposal

**Product proposal**:
A versioned, pre-confirmation statement produced by the **Product manager** that collects the user's goal, users, scope, non-goals, acceptance candidates, constraints, risks, and open questions. It becomes a **Product Baseline** only after the user explicitly confirms the requirement boundary; before then it is not a formal development input.
_Avoid_: "Product Baseline" (confirmation is still pending), "prompt summary" (the proposal is a reviewable product object)

**Product Baseline**:
The immutable, user-confirmed product requirement boundary derived from one **Product proposal** revision. Its confirmation Command atomically creates the downstream **department run** and `r1`; it records the accepted goal, users, scope, non-goals, acceptance criteria, constraints, and known risks without pre-approving architecture or implementation.
_Avoid_: "Product proposal" (not yet confirmed), "Project Spec" (the Spec explains how the confirmed requirement is produced)

**Delivery coordinator**:
The orchestration **position** and **AI member** that takes responsibility after the user has explicitly confirmed the product requirement boundary. The Delivery coordinator advances the downstream **department pipeline**, convenes the required role-specific reviews and execution sessions, tracks their evidence and gates, and escalates decisions without replacing the Product manager, architect, implementers, reviewers, testers, human approver, or **Company Runtime** as the state authority.
_Avoid_: "Company Runtime" (the Runtime enforces state and policy), "Product manager" (the roles have an explicit handoff), "super-agent" or an agent that implements and approves its own work

**Supervised autonomy**:
The operating mode in which a **department run** advances automatically between its declared human gates while remaining continuously observable and interruptible by a human operator. Every active role and Agent session must expose its identity, goal, input and Snapshot references, messages or structured decision rationale, tool calls and results, permission requests, Artifact and Diff updates, status and attempts, usage and cost, review findings, and proposed next transition through replayable **runtime events** and the **run record**. Supervised autonomy requires pause, cancel, inspect, and governed intervention controls; it never means hidden execution or permission to bypass approval and Snapshot boundaries.
_Avoid_: "fully autonomous" when execution cannot be inspected or interrupted, raw private chain-of-thought as an observability contract, UI-only progress indicators without authoritative Runtime evidence

**Governed intervention**:
A human action taken against an active **department run** or Agent session through the **supervised autonomy** controls. Observation and a side-channel consultation do not mutate execution. A material change to requirements, constraints, permissions, or requested work requires the affected execution to pause and records explicit feedback against the current **Node run**; continuing work creates a new **Snapshot revision** or **Node attempt** while preserving the prior evidence and lineage.
_Avoid_: "live prompt edit" (it bypasses the frozen execution contract), overwriting an active Agent session, silently changing a Run or Snapshot from the renderer

**Execution Profile**:
A reusable **department** configuration that selects a **Company Agent Adapter** reference, model, Sandbox provider reference, branch strategy, limits, retry policy, permission policy, and non-sensitive **Secret References** for future execution. At execution time the Company Agent Adapter resolves the published **agent provider** seam; the profile does not persist that implementation as a second identity. It is independent of **AI member** identity.
Desktop may present an Execution Profile to ordinary users as a **run environment**; that is a UI label, not a second domain concept. Advanced editing still uses the canonical fields above.
_Avoid_: "AI member profile" (identity metadata), "provider credentials", "agent identity" as domain synonyms

**Secret Reference**:
A non-sensitive company-owned identifier and provider scope that points to credentials held outside Company Runtime state. It never contains a token, API key, private key, environment dump, or secret value.
_Avoid_: "secret" when the value is meant, "credential record", "environment variable"

**Artifact Contract**:
A stable, schema-versioned declaration of an Artifact kind accepted or produced by a **department pipeline** or node. It describes configuration compatibility without creating an Artifact or Artifact Registry entry.
_Avoid_: "Artifact" (a concrete deliverable), "file type" (too narrow), "output format" (direction-specific)

**AI member memory**:
Reviewed, durable **Memory entries** attached to an **AI member**, such as stable working preferences and reusable experience. Project-specific knowledge reaches this scope only through an explicit candidate, independent review, and human decision; every future Run still selects exact entries in its Snapshot under the target Project's permissions.
_Avoid_: "chat history", "transcript", "automatic learning" (promotion is controlled)

**AI member consultation**:
A user conversation with an **AI member** for discussion, clarification, or advice in a visible project and execution context. Consultation cannot directly mutate a department run or create an official artifact; the user must explicitly convert relevant content into a new run, node feedback, or reviewed memory.
_Avoid_: "department run" (consultation is not formal execution), "artifact" (conversation output is unofficial until promoted), "automatic memory"

**Agent interaction workspace**:
The contextual Desktop surface for live interaction with an **AI member**, either as an informal **AI member consultation** or as collaboration on a specific department-run node. It renders AG-UI events for messages, tools, steps, permissions, usage, artifacts, and status while applying the same run snapshot, approval, memory, and artifact boundaries to Desktop and external ACP sessions.
_Avoid_: "chat sidebar" (too narrow and context-free), "terminal" (one evidence view), "ACP client" (one external access path)

**Discussion topic**:
A project-, department-run-, or pipeline-node-scoped conversation space where a human and multiple **AI members** can discuss one explicit goal in a bounded, threaded channel. A topic records role-discriminated participants (`owner-participant | reviewer-participant | moderator`), referenced artifacts, budget, maximum rounds, stop conditions, and a reviewed conclusion; conversation alone does not change a run, create an official artifact, or become memory. A **Review topic** is the governed form used by product and technical reviews: only eligible reviewer-participants first submit independent findings and count toward quorum/Gate votes, the moderator brings only material conflicts into discussion, and an owner-participant revises the proposal before independent re-review.
_Avoid_: "group chat" (misses scope and execution controls), "company channel" (too broad), "department run" (discussion is not formal execution)

**Review topic**:
A bounded **Discussion topic** attached to a product proposal, technical design, implementation Diff, or verification result. It has a declared review scope and acceptance criteria, preserves each eligible reviewer-participant's independent finding before discussion, records owner responses, conflict resolution, and evidence, and freezes the reviewer quorum used for its final Gate vote. Owner-participants and moderators do not submit independent findings or count toward quorum/Gate votes. Fresh re-review must introduce at least one eligible reviewer who did not submit an initial finding, and a `PASS` requires every counted eligible vote to pass with no blocking finding. A Review topic cannot approve its own output or bypass a human gate declared by the pipeline.
_Avoid_: "free-form debate" (the topic has a finite quality objective), "approval chat" (discussion is evidence for a gate, not the authority), merging participant answers into one anonymous opinion

**Quality Gate Result**:
An immutable terminal result (`PASS`, `CONDITIONAL_PASS`, or `FAIL`) over one kind-discriminated exact input-manifest hash, with evidence and conditions. Product, Repository-readiness, technical, code, aggregate, Test, and final-candidate gates freeze their own required IDs/revisions/hashes rather than relying on generic Artifact lists. A Review-topic result remains blocked until its frozen eligible-reviewer quorum is met; any counted `FAIL` vote yields `FAIL`, otherwise any counted `CONDITIONAL_PASS` yields `CONDITIONAL_PASS`, and only unanimous counted `PASS` votes with no blocking finding yield `PASS`. Only `PASS` satisfies a downstream production contract or promotes a Snapshot.
_Avoid_: "current review status" (mutable projection), a chat conclusion, treating low-risk conditions as a PASS

**Project memory**:
Accepted **Memory entries** containing durable context, decisions, constraints, and feedback scoped to one **project**. They are available only when exact revisions are selected into a later Run Snapshot and remain isolated from other projects unless a separately reviewed candidate is promoted into **AI member memory**.
_Avoid_: "company memory" (broader scope), "run history" (audit evidence rather than curated context)

**Memory candidate**:
A versioned, redacted proposal derived from exact Run Record, Artifact, Review, or human-feedback evidence for either Project-memory or AI-member-memory scope. It moves through draft and independent review to one append-only human accept/reject decision; producer text, raw transcript, or a single failure never promotes itself.
_Avoid_: accepted memory, automatic summarisation with write authority, copying secrets or private reasoning

**Memory entry**:
An immutable accepted Memory-candidate revision bound to one Project or AI member and its promotion evidence. Formal execution can load it only through an exact **run configuration snapshot** selection; there is no mutable “latest memory” lookup.
_Avoid_: **Run record** (source evidence), unreviewed notes, a globally visible prompt

**Run record**:
The auditable evidence of a **department run**, correlated by participating **AI member**, Agent session, Snapshot revision, Node run, and attempt, including transcripts, structured decision rationale, events, commands, tool calls and results, permission decisions, Artifact and Diff updates, review findings, usage, costs, transitions, interventions, and failures. A run record supports live supervision, inspection, replay, and recovery but is not automatically loaded as **project memory** or **AI member memory**.
_Avoid_: "memory" (records are evidence until curated), "artifact" (records describe execution rather than delivery)

**Role profile**:
The configuration behind a **Board role**: its responsibility boundary, allowed actions, preferred skill flows, prompt guidance, and optional agent/model preferences. Role profiles belong to a **department**, not to the **company** or an **agent provider** -- any agent can fill the same role. A role profile describes how a role should work; it is not the same as an **agent provider**.
_Avoid_: "persona" (too vague), "agent role" (too broad), "model config" (too narrow)

**Skill**:
A stable, versioned capability reference in the **company**-wide Skill Catalog that a **position** may bind for use by its **skill flows**. A Skill is reusable across departments, while each position explicitly owns the subset available to its flows.
_Avoid_: "prompt" (too narrow), "skill flow" (a flow selects and instructs multiple skills), department-owned skill copies

**Pipeline Skill Snapshot**:
The immutable Skill-Flow configuration frozen when a **Pipeline Version** is published: selected Skill IDs, source fingerprints, instructions, order, and Handler applicability. It preserves what that Pipeline Version declared without resolving a later catalog state.
_Avoid_: **Run Skill Snapshot** (the later Run-scoped resolution), a mutable Skill Flow, resolving a published Pipeline from the current Skill Catalog

**Run Skill Snapshot**:
The Run-scoped resolution that references the selected **Pipeline Skill Snapshot** and freezes the exact Skill source identity, fingerprint/version, and applicability used at Run formalization. It preserves auditable identity after an external `SKILL.md` changes or disappears, but not executable source bytes: replay or a new Attempt must resolve the same fingerprint or block with `SKILL_VERSION_UNAVAILABLE`.
_Avoid_: claiming fingerprint metadata makes missing source replayable, copying Skill source content into Runtime state, resolving a historical Run from the current Skill Catalog

**Skill Capability Requirement**:
A non-sensitive declaration in a Skill source frontmatter that names an Agent capability the Skill expects. Runtime preserves the declaration as discovery metadata and Desktop shows it as a warning; it does not create an Agent/Skill compatibility matrix.
_Avoid_: silently hiding a Skill for an Agent, copying credentials into Skill metadata, treating a warning as a hard binding constraint

**Skill Discovery**:
The process of finding formally readable `SKILL.md` sources in configured host directories and projecting their stable references, descriptions, and fingerprints into the company-wide Skill Catalog without copying their contents into Company Runtime state.
_Avoid_: manual skill registration, skill import (the source remains external), agent-specific skill list

**Skill flow**:
A selected subset of a **position**'s skills and operating instructions activated by a **department pipeline** node for a specific kind of work, such as planning, implementation, review, debugging, or merge-conflict resolution. The **AI member** keeps its identity and memory across nodes, but each execution loads only the current node's selected flow instead of the member's complete skill catalog.
_Avoid_: "skill bundle" when it implies loading everything at once, "prompt pack" (too narrow)

**Desktop shell**:
The optional Electron app in `apps/desktop/` that provides the project-first **company** workbench, selects a **local AI company directory**, supervises its Company Runtime, and exposes only a narrowed preload bridge to the renderer. A legacy workflow-board process may remain an isolated compatibility/execution surface, but its API/store is not Company state and is never dual-written. The shell does not own orchestration semantics.
_Avoid_: "the app" (ambiguous), "desktop board" (legacy surface), "client" (too generic), treating a Board API as the Company Runtime

**Evaluator run**:
The **Evaluator** **agent** invocation in the **verifying** **board phase**. It reviews the PRD, approved plan, **Board progress document**, repository **runtime events**, commits, errors, and deterministic evidence, then writes or enriches the **Board verification report**. It must not plan, implement, or commit.
_Avoid_: "static verification", "post-run summary", treating a successful **completion signal** as proof of delivery

**Board verification report**:
The task-scoped delivery report written during **verifying**. It contains the **Evaluator run** output plus structured deterministic evidence and the final verification status (`passed`, `needs-verification`, `needs-recovery`, `infra-warning`, or `failed`).
_Avoid_: "test report" (too narrow), "run summary" (too broad)

**PRD visual asset**:
An image file discovered from a PRD-backed **board task** -- either a Markdown image reference or a direct image PRD file -- that is copied into task-scoped storage and made available to planning and execution agents as part of the product requirements.
_Avoid_: "attachment" (too generic), "screenshot" (too narrow), "image prompt" (implies model-specific transport)

**Planning artifact**:
A file produced from an approved or exported workspace plan that lets a human inspect the plan outside the live **workflow board**. The current artifact set is `workspace-plan.json`, `alignment.md`, `technical-plan.md`, and repository issue markdown under `issues/*.md`.
_Avoid_: "document" (too generic), "report" (reserved for verification-style summaries)

**Local issue status**:
The status line recorded for a repository-local markdown issue, originally `status: ready-for-agent` under `.scratch/**/issues/*.md`. The **workflow board** writes generated Board issues as task-scoped markdown artifacts under `.sandcastle/board/tasks/<taskId>/issues/<repo>.md` and updates the same status line as execution and verification advance: `ready-for-agent`, `in-progress`, `succeeded`, `needs-recovery`, `verification-failed`, or `infra-warning`.
_Avoid_: "task status" (ambiguous with **board task** status), "run status" (reserved for **board run** lifecycle)

**Board phase**:
A named step in a file-backed **board task** workflow, such as `classifying`, `aligning-prd`, `technical-planning`, `creating-issues`, `awaiting-approval`, `running`, or `verifying`. All phases before Board issues are generated are interactive Planner phases: `classifying`, `aligning-prd`, `technical-planning`, and `creating-issues` expose a **phase session** so the user can collaborate with the **agent** before any issue-generation handoff or approved **AFK run**. The `running` phase is the Generator role, and the `verifying` phase is the Evaluator role that runs after approved repository execution and before a **board task** can succeed.
_Avoid_: "step" (ambiguous with **iteration**), "stage" (use only in UI copy when necessary)

**Board planning-only mode**:
A **workflow board** mode where approving the generated workspace plan exports the same planning artifacts as `workspace plan` (`workspace-plan.json`, `alignment.md`, `technical-plan.md`, and `issues/*.md`) and then completes the **board task** without starting an approved **AFK run**.
_Avoid_: "dry run" (already used by workspace execution), "plan import" (that starts from an existing plan), "no-op execution"

**Verification report**:
A deterministic **board task** artifact written after approved **AFK run** execution, usually at `.sandcastle/board/tasks/<taskId>/verification.md`. It summarizes planned repositories, execution results, run evidence, completion-signal and commit evidence, delivery errors, infrastructure/capture failures, and the suggested next action. It separates "the **agent** produced work" from "the **board task** delivery was verified".
_Avoid_: "test report" (too narrow), "execution result" (the report verifies execution results rather than replacing them)

**Test case**:
A versioned, executable acceptance description owned by the Test Engineer position. It identifies the requirement or Work Package coverage, preconditions, actions, expected UI and authoritative Runtime outcomes, permitted fixtures, and evidence to capture. A user-visible behavior is not covered merely because a button or label exists; the Test case must assert the public UI and Runtime contract together where both are in scope.
_Avoid_: "checklist item" (does not define executable evidence), "snapshot" (a screenshot is only one possible observation), testing component internals instead of public behavior

**Test run**:
One recorded execution of one or more **Test cases** against a declared build, Company Directory, **Execution Profile**, and Runtime fixture. It preserves the environment, inputs, UI actions, Runtime payloads, screenshots, logs, timing, and final status so a result can be replayed or compared without relying on memory or a manually refreshed page.
_Avoid_: "QA session" (too informal), "smoke test" (only one possible suite), treating a green UI assertion as the authoritative Runtime result

**Test defect**:
A traceable failure raised by a **Test run** against a requirement, Work Package, Artifact, Runtime contract, or interaction expectation. It links the failing Test case, exact evidence, affected revision and Node run when applicable, and the suspected owner; fixing it follows the same review and re-test loop as an **Integration defect**.
_Avoid_: "bug note" (lacks reproducible evidence), silently changing a Test case to hide a failure

**Repository readiness check**:
A pre-execution check that confirms every repository and application named by a Project or **Work Package** can participate safely in the declared pipeline. It records repository identity and revision, clean/dirty state policy, branch and Worktree capability, build and test entry points, required local services or secrets by reference, cross-application contracts, and any blocking readiness defect before development starts.
_Avoid_: "clone check" (readiness is broader than fetching code), silently repairing a repository before recording its starting state

**Security review**:
An independent, evidence-backed review of a product proposal, technical design, Work Package, or **Delivery Candidate Input** for unauthorized access, secret exposure, unsafe tool or sandbox permissions, dependency and supply-chain risk, data handling, and relevant compliance constraints. The review depth is selected by risk; every final candidate includes a PASS result bound to its exact input manifest.
_Avoid_: "security scan" (the review also evaluates design and permissions), treating a clean scanner result as complete security evidence

**Operability review**:
An independent review of whether an exact **Delivery Candidate Input** can be built, observed, recovered, upgraded, and operated within its declared environment. It covers logging and telemetry, failure and retry behavior, resource and timeout limits, deployment or rollback evidence, and cross-application operational contracts; depth is risk-based and every final candidate includes its PASS result.
_Avoid_: "SRE sign-off" (the review is evidence and a gate, not a personal approval), checking only production deployment syntax

**Delivery Candidate Input**:
An immutable pre-candidate manifest that freezes one Integration Generation, exact per-Repository commits, approved Artifacts and contracts, Test evidence, Snapshot, and risk summary before final Security and Operability gates run. Those Gate Results bind this input ID/hash; only after every required result is PASS can Runtime assemble a Delivery candidate, avoiding a gate that refers to a not-yet-created candidate.
_Avoid_: **Delivery candidate** (which additionally contains the final PASS Gate Results), a mutable staging list, a review scope inferred from a moving Integration branch

**Delivery candidate**:
The immutable set assembled from one exact **Delivery Candidate Input** plus all required `PASS` Quality Gate Results, including Security and Operability, and waiting for the human release decision. Accepted, rejected, and changes-requested are projections of the separate decision, not mutable fields on the candidate. A Delivery candidate is not deployed or marked released merely because all Agent gates passed.
_Avoid_: "done" (the human release decision is still pending), "release" (release is a later controlled action), a mutable latest build

**Human release decision**:
The explicit, single append-only human action that accepts, rejects, or sends back a **Delivery candidate** after every declared Agent and quality gate has a `PASS` **Quality Gate Result**. Accepting completes the Run and permits a separate **Release operation**; rejecting terminates that Run's release path, while changes-requested creates traceable same-Run rework or a child Run when frozen boundaries must change. No outcome rewrites historical evidence or adds a second decision to the same manifest.
_Avoid_: "automatic release" (the decision is a separate gate), "approval button" without candidate evidence, treating all Agent PASS results as a release decision

**Release operation**:
An independently authorized, idempotent post-decision operation with a discriminated kind. `merge` freezes each Repository's integrated source commit, **Release target branch**, and expected tip; `export` freezes Artifact Version IDs, destination reference, expected destination state, and overwrite policy without inventing a branch. Both record partial results and reconciliation evidence and are distinct from Integration and deployment.
_Avoid_: **Integration operation** (writes only generation branches), automatic deployment, forcing an export to have a Git target, retrying against a changed destination without renewed human confirmation

**Harness**:
The versioned set of standards that constrains how a role and pipeline node may produce and inspect work: principles, project or department constitution, explicit rules, and positive/negative cases. A Harness answers "according to what standards"; a **Spec** answers "how this requirement is produced". A Run snapshots the Harness references it used, and a Harness change requires review, an impact scope, and a validation result.
_Avoid_: "prompt pack" (a Harness is a governed standard, not only instructions), "global system prompt", silently changing rules during a Run

**Harness snapshot**:
The immutable Run-scoped reference to the exact Harness revisions, fingerprints, and applicability rules used by a Node run or quality gate. It preserves the standard used for historical evidence without copying mutable Harness configuration into later runs.
_Avoid_: "current Harness" (mutable), "prompt snapshot" (a Harness is a governed standard, not only instructions)

**Defect**:
A traceable failure of a requirement, contract, quality gate, or execution condition that links evidence, affected revision, suspected owner, and a bounded rework path. **Integration defect** and **Test defect** are scoped Defect kinds; a Defect never replaces the evidence that caused it.
_Avoid_: "bug note" (lacks evidence and ownership), silently editing the failed input to make a gate pass

**Independent finding**:
A reviewer-owned observation recorded before any Review topic discussion, with scope, severity, evidence, rationale, and disposition. Independent findings remain individually attributable even when the moderator later groups conflicts into a bounded discussion.
_Avoid_: "consensus comment" (the finding must precede consensus), an anonymous aggregate opinion

**Improvement proposal**:
An evidence-backed, versioned suggestion produced from **run records**, review findings, Test defects, cost and timing metrics, or repeated intervention patterns. It names the suspected root cause, proposed Harness/Spec/Skill Flow/template change, expected impact, validation plan, and rollback path. An Improvement proposal is advisory until a human approves it; approval authorizes a separate **Improvement application operation**, not an implicit configuration mutation.
_Avoid_: "automatic learning" (promotion is governed), "model fine-tuning" (the proposal may change process artifacts), a raw failure log without a proposed change and validation plan

**Improvement application operation**:
An idempotent, human-authorized operation that applies one approved Improvement-proposal revision by creating a new Harness, Spec, template, or Skill Flow revision and recording validation evidence. Applying does not change a current Run or automatically publish the new revision; rollback creates another restoring revision rather than deleting history.
_Avoid_: "auto-tuning", editing an active Snapshot, overwriting the applied revision during rollback

**Board branch merge**:
A **workflow board** action that merges a **board task** repository's recorded **source branch** into a human-selected **target branch** on the **host**. The action requires a clean target repository working tree and does not auto-stash or overwrite uncommitted changes.
_Avoid_: "auto-merge" (implies no human target selection), "deploy" (too broad)

**Phase session**:
An interactive terminal session attached to a specific **board task** and **board phase**. A phase session lets the user collaborate with the **agent** during that phase, and can advance the workflow by emitting the structured phase completion signal. Its process exit does not determine the **board task** result; the file-backed board task workflow does.
_Avoid_: "task terminal" (too broad), "agent run" (reserved for **board run** / **runtime event** backed execution)

**Artifact**:
A typed, versioned deliverable produced or registered by a **department run** with one content kind: Runtime-managed file bytes, immutable Repository object, or provider-versioned external reference. Commits and versioned PR/build objects can be Artifacts; a branch, preview URL, or “latest” object is only a locator until resolved to an immutable object ID/version/digest. Each version records producer lineage and a kind-specific integrity descriptor and must be verified before satisfying a Gate.
_Avoid_: "output" (too broad), "result" (ambiguous with `RunResult`), treating a mutable URL/branch as immutable evidence, applying local-file hash rules to every external object

**Review**:
A human decision on a **board task** or **artifact** that marks the work as accepted, rejected, or needing changes before the next execution step.
_Avoid_: "approval" when quality judgment is meant; approval is the existing workflow gate before execution

**Feedback**:
A durable note attached to a **board task**, **board run**, **review**, or **artifact** describing what should influence future work. Feedback is input for later context, skills, or workflows; it is not automatically promoted into them.
_Avoid_: "memory" (too broad), "lesson" (promotion outcome, not the raw note)
