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
Configuration on a **sandbox provider** that controls how the agent's changes relate to branches, set at provider construction time.
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
A git worktree created in `.sandcastle/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**.
_Avoid_: "workspace", "branch copy", "clone"

**Source branch**:
The branch the **agent** works on -- determined by the **branch strategy**.
_Avoid_: "working branch", "agent branch"

**Target branch**:
The **host**'s active branch at `run()` time -- the branch Sandcastle merges into when using **merge-to-head**.
_Avoid_: "base branch", "destination branch", "merge target"

### Agents

**Agent provider**:
A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.
_Avoid_: "agent adapter", "agent driver"

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
The structured lifecycle and stream event model emitted by Sandcastle core for a run. Surfaced to callers through `events.onRuntimeEvent` and used by the **workflow board**. Uses stable dotted event names such as `run.started`, `iteration.started`, `message.delta`, `tool.call`, `tool.result`, `raw`, `commit.created`, `usage.recorded`, `run.finished`, and `run.error`, all correlated by a `runId`. **Runtime events** are the source for protocol adapters such as the **AG-UI adapter** and future **ACP facade**.
_Avoid_: "run event" (old name), "AG-UI event" (an adapter output), "ACP event" (a facade concern), "log event"

**AG-UI adapter**:
A protocol adapter that maps **runtime events** to AG-UI-style event names (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, etc.) for web UI/event-stream consumers. It does not change how Sandcastle runs an **agent** and does not make AG-UI part of core orchestration.
_Avoid_: "AG-UI runtime" (Sandcastle runtime events remain internal), "frontend event model"

**ACP facade**:
A future runtime boundary that exposes Sandcastle to external Agent Runtime protocol clients by mapping ACP methods onto existing Sandcastle operations. The **ACP facade** wraps Sandcastle; it does not replace `run()` or the **sandbox provider** model.
_Avoid_: "ACP core", "ACP server" (unless referring to a concrete transport implementation)

**Run failure evidence**:
Optional structured, plain (Effect-free) recovery metadata carried on a `run.error` **runtime event** (the `recovery` object) alongside the unchanged `message`. Surfaces what Sandcastle already knows about a failed run so a caller or the **workflow board** can recover: **run failure kind** and failure phase, preserved worktree path, **run log** path, **session** id/file, whether the **completion signal** was seen, and commit SHAs. Every field is optional. Observability/recovery metadata only — it never replaces the thrown error, logs, or verification reports.
_Avoid_: "error details" (too generic), "failure report" (reserved for the Board verification report), "diagnostics" (overloaded with prompt diagnostics)

**Run failure kind**:
The stable, coarse classification of why a run failed, carried on **run failure evidence**: `infrastructure` (the sandbox/host environment failed), `agent` (the agent process failed), `task` (the agent ran but did not satisfy the task contract, e.g. structured-output validation), or `unknown`. Lets a library consumer route infrastructure failures differently from agent or task failures without pattern-matching error text.
_Avoid_: "error type" (ambiguous with the tagged `SandboxError` classes), "failure category", "severity"

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
The top-level v1 product object: the local AI company a user opens in the **control plane** -- one host machine, one `.sandcastle/` config root, one board store, and the **departments** that operate inside it. A product framing and navigation/ownership layer, not a tenant, org chart, or access-control domain. Exactly one company per control plane instance in v1. See ADR 0026.
_Avoid_: "organization" (Rudder's enterprise term), "tenant", "workspace" (overloaded with the multi-repo workspace)

**Department**:
An execution unit inside the **company** that owns one kind of work: its workflow phases, **Board roles**, **role profiles**, task sources, artifact kinds, and verification semantics. V1 ships exactly one complete department -- the **Software R&D department** -- plus optional inert placeholder departments that only communicate the product model. Not a generic workflow engine.
_Avoid_: "team" (role/skill boundary matters), "module" (too code-shaped), "workflow" (a department owns workflows, it is not one)

**Software R&D department**:
The first complete **department** in the v1 **company**: the current **workflow board** promoted rather than rebuilt -- a local software-development operating unit made of **Board roles**, repositories, task artifacts, review loops, and skill-guided agent work. Its PRD-to-plan-to-approval-to-execution-to-verification loop is the template future departments are measured against.
_Avoid_: "company" (the department lives inside one), "organization" when referring to the v1 Sandcastle scope, "team" when the role/skill boundary matters, "the board" when the department product boundary is meant

**Role profile**:
The configuration behind a **Board role**: its responsibility boundary, allowed actions, preferred skill flows, prompt guidance, and optional agent/model preferences. Role profiles belong to a **department**, not to the **company** or an **agent provider** -- any agent can fill the same role. A role profile describes how a role should work; it is not the same as an **agent provider**.
_Avoid_: "persona" (too vague), "agent role" (too broad), "model config" (too narrow)

**Skill flow**:
A selected set of skills and operating instructions used for a specific kind of software work, such as planning, implementation, review, debugging, or merge-conflict resolution. A **role profile** may choose one or more skill flows, but the flow should still be loaded progressively instead of copying every available skill into context.
_Avoid_: "skill bundle" when it implies loading everything at once, "prompt pack" (too narrow)

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

**Board branch merge**:
A **workflow board** action that merges a **board task** repository's recorded **source branch** into a human-selected **target branch** on the **host**. The action requires a clean target repository working tree and does not auto-stash or overwrite uncommitted changes.
_Avoid_: "auto-merge" (implies no human target selection), "deploy" (too broad)

**Phase session**:
An interactive terminal session attached to a specific **board task** and **board phase**. A phase session lets the user collaborate with the **agent** during that phase, and can advance the workflow by emitting the structured phase completion signal. Its process exit does not determine the **board task** result; the file-backed board task workflow does.
_Avoid_: "task terminal" (too broad), "agent run" (reserved for **board run** / **runtime event** backed execution)

**Artifact**:
A durable output from a **board run** or **board task** that a human can inspect, such as a file path, generated document, screenshot, preview URL, pull request link, or plan artifact. Artifacts are evidence of work, distinct from raw agent transcript text.
_Avoid_: "output" (too broad), "result" (ambiguous with `RunResult`)

**Review**:
A human decision on a **board task** or **artifact** that marks the work as accepted, rejected, or needing changes before the next execution step.
_Avoid_: "approval" when quality judgment is meant; approval is the existing workflow gate before execution

**Feedback**:
A durable note attached to a **board task**, **board run**, **review**, or **artifact** describing what should influence future work. Feedback is input for later context, skills, or workflows; it is not automatically promoted into them.
_Avoid_: "memory" (too broad), "lesson" (promotion outcome, not the raw note)
