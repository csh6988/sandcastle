# V1 library-first control plane decision map

This map tracks the multi-session planning work for Sandcastle v1. The current
direction is recorded in ADR 0024 (library-first local control plane) and
ADR 0026 (v1 company control plane): keep Sandcastle library-first, model the
product as a local AI **company** whose first complete **department** is the
**Software R&D department** (the current board, promoted rather than rebuilt),
then wrap it with desktop later. The board-specific implementation queue lives
in `docs/agents/board-roadmap.md`; this map should stay aligned with that
roadmap instead of duplicating every board delivery task.

## #1: Finish current board workflow baseline

Blocked by: none
Type: Discuss

### Question

What is the current implementation baseline that v1 planning should build on?

### Answer

Current evidence:

- `run()` is the single-repo orchestration surface.
- `createSandbox()` and `createWorktree()` expose lower-level reusable sandbox
  and worktree lifecycle surfaces.
- `runWorkspace()` is the lower-level multi-repository primitive for bind-mount
  sandbox providers.
- `runWorkspaceTask()` adds PRD/task planning, workspace snapshots, per-repo
  execution, and planner/repo run-event callbacks.
- `RunEvent` is the plain structured stream used by `run()`, `runWorkspace()`,
  `runWorkspaceTask()`, and the board.
- `sandcastle board` has a file-backed `BoardStore`, local HTTP/SSE server,
  embedded frontend, board tasks, board runs, token usage aggregation, and task
  launch via `runWorkspaceTask`.
- Current board work now makes the board a concrete
  PRD-to-plan-to-approval-to-execution-to-verification control plane:
  file-backed board phases, strict Board roles, plan approval, file-backed
  resume/recovery, conservative retry, phase sessions, terminal WebSocket
  support, filesystem watching, PRD-file task creation, PRD visual assets,
  workspace-plan import, planning-only export, artifact manifests,
  workspace-plan validation/fix loops, cancellation, recovery, task progress
  documents, local issue status sync, Evaluator-backed verification reports,
  stage/timeline projection, README updates, and changesets.

Verification run during this planning pass:

- `npm run typecheck` passed.
- `npx vitest run src/board/BoardStore.test.ts src/board/server.test.ts src/board/router.test.ts src/board/langGraphTaskRunner.test.ts src/board/terminalSession.test.ts src/board/launchTask.test.ts src/cli.test.ts` passed: 77 tests.

Note: the board roadmap records a newer checkpoint where board P0-P3 passed
targeted board tests, board CLI tests, `typecheck`, and `format:check` on
2026-06-30. Re-run the same chain before releasing further changes.

## #2: Public orchestration surface audit

Blocked by: #1
Type: Discuss

### Question

Which current internal shapes must become stable public or semi-public
interfaces before the control plane and desktop can depend on them?

### Answer

Unresolved. Likely candidates:

- `RunEvent`
- `RunResult`
- `WorkspaceTaskPlan`
- `WorkspaceTaskRepositoryResult`
- board task/run projections
- board task source, role profile, stage, artifact, verification, review, and
  feedback shapes
- store-facing abstractions currently hidden inside `src/board`

## #3: Board interaction audit

Blocked by: #1, #2
Type: Discuss

### Question

Which existing workflow board interactions are v1 control-plane commitments,
and which should remain internal or POC-only?

### Answer

Mostly resolved from code reading. Existing reusable interaction points:

- New board task modal creates tasks through `POST /api/tasks`.
- `sandcastle board --prd-file <prd.md>` creates a PRD-backed board task and
  enters interactive planning.
- `sandcastle board --plan-file <workspace-plan.json>` imports a reviewed plan
  directly into the approval stage.
- `sandcastle board --planning-only` keeps the interactive planning and
  approval loop, then exports planning artifacts instead of starting AFK
  execution.
- Task groups provide the primary by-task operating view.
- Status columns provide a secondary by-status run view.
- Task detail displays workflow state, prompt, plan, repository runs, and a
  task activity stream.
- Run detail displays run metadata, token usage, and live activity.
- SSE updates keep tasks, runs, and run events live.
- LangGraph-backed board phases pause at `classifying`, `aligning-prd`,
  `technical-planning`, and `creating-issues`.
- Phase terminals attach an interactive terminal to the current board phase via
  WebSocket.
- The `creating-issues` phase imports a `<workspace_plan>` block, validates it,
  and returns to an interactive fix state when import fails.
- Plan approval and rejection resume the paused workflow.
- Phase completion can happen through the UI button or through the terminal
  completion signal.
- Task cancellation is available for running workflow stages.
- Recovery can restart recoverable interactive phases, resume approval, or
  continue approved execution from progress and verification evidence.
- Approved execution moves into a `verifying` phase before success.
- Verification writes `verification.md`, can run an Evaluator agent over
  deterministic evidence, and syncs generated issue markdown status.
- Planning-only approval records an artifact manifest, exposes
  `/api/tasks/:id/artifacts`, and renders task artifacts in detail.
- `BoardTaskStage` projects timeline state plus available controls
  (`canComplete`, `canApprove`, `canReject`, `canCancel`, `canRecover`) for
  the frontend.

Initial decision: v1 should reuse this spine. Artifact, review, and feedback
should be added to task detail and run detail rather than introduced as a
separate product flow.

Next decision: stabilize which parts of `BoardTaskView`, `BoardTaskStage`,
`BoardTaskSource`, `BoardRole`, `BoardTaskArtifact`, task artifact paths, and
recovery/verification statuses are contractual enough for desktop and library
consumers.

## #4: Board task source and artifact contract

Blocked by: #2, #3
Type: Discuss

### Question

Which task sources and task artifacts are v1 commitments, and how should the
board expose them without requiring consumers to know the file-backed store
layout?

### Answer

Partially resolved. Current concrete sources:

- ad-hoc board task input from `POST /api/tasks`
- PRD file input via `source: { type: "prd-file", prdFile }`
- reviewed workspace-plan input via
  `source: { type: "workspace-plan", planFile }`

Current concrete task artifacts:

- approved planning artifacts:
  `workspace-plan.json`, `alignment.md`, `technical-plan.md`, and
  `issues/*.md`
- board task progress: `.sandcastle/board/tasks/<taskId>/progress.md`
- generated board issues:
  `.sandcastle/board/tasks/<taskId>/issues/<repo>.md`
- verification report:
  `.sandcastle/board/tasks/<taskId>/verification.md`
- artifact manifest:
  `.sandcastle/board/tasks/<taskId>/artifacts.json`
- PRD visual assets copied into task-scoped board storage
- run/event/usage/commit evidence linked through board runs

Resolved for the current board: the known artifact set is exposed as
`BoardTaskArtifact` records and through `/api/tasks/:id/artifacts`. Open
decision: which artifact kinds and fields are stable enough for desktop and
public API consumers, and whether external links such as PRs/previews should
join the same artifact list or remain separate evidence.

Roadmap alignment: `docs/agents/board-roadmap.md` records artifact visibility
as done: artifact manifest, `/api/tasks/:id/artifacts`, and board detail
rendering all exist.

## #5: Stage, verification, and recovery contract

Blocked by: #2, #3, #4
Type: Discuss

### Question

Which parts of the stage/timeline, verification, and recovery model should be
public/semi-public board contracts?

### Answer

Partially resolved. Current stage model is already a useful desktop seam:

- `BoardTaskStage.mode`: `pending`, `interactive`, `background`, `approval`,
  `afk`, `complete`, `failed`
- timeline rows for classify, align PRD, technical plan, create issues,
  validate plan, approve, execute, verify
- action booleans for complete, cancel, approve, reject, recover
- `terminalPhase` for interactive phases
- `recoverPhase` for recoverable failures

Current verification statuses:

- `passed`
- `needs-verification`
- `needs-recovery`
- `infra-warning`
- `failed`

Open decisions:

- Whether `BoardTaskStage` is the stable API for any future desktop frontend.
- Whether verification status names are final for v1.
- Whether cancellation should be a failed recoverable state or a distinct task
  outcome.
- What recovery may change after approval: it should continue or repair the
  approved plan, not re-plan silently.

## #6: Company, departments, and role profiles

Blocked by: #2, #3, #5
Type: Discuss

### Question

How should Sandcastle model the v1 product as a local AI company, and how
should each role map to focused skill flows?

### Answer

Resolved in ADR 0026 for the top-level model, partially resolved for role
profiles. V1 is a **company** control plane whose only complete execution unit
is the **Software R&D department**:

- **Company** is the top-level product object: one host, one `.sandcastle/`
  root, one board store, a set of departments. A product framing and
  navigation/ownership layer, not a tenant or org chart. Exactly one company
  per control plane instance in v1.
- **Department** is the execution unit that owns one kind of work: workflow
  phases, Board roles, role profiles, task sources, artifact kinds, and
  verification semantics. V1 defines the department shape by promoting the one
  concrete department, not by designing an abstract department SDK.
- **Software R&D department** is the v0 board, promoted rather than rebuilt.
  Its PRD-to-plan-to-approval-to-execution-to-verification loop, strict Board
  roles, artifacts, verification, recovery, and cancellation all carry over
  unchanged. Renames for company framing are UI-level only; store shapes,
  file layouts, and API paths do not churn for naming reasons.
- Other departments are inert placeholders in v1: a name, a description, and a
  "not yet operational" state. No workflow, no storage, no API surface beyond
  listing.

Rudder remains the reference for what **not** to build: no org charts,
reporting lines, chat, calendar, budgets, or enterprise access control.
Sandcastle should not copy Rudder's whole-company machinery; it borrows only
the "company as product home" framing. Within the Software R&D department the
existing role model holds:

- Planner: turns PRDs into alignment, technical plan, workspace plan, and Board
  issues. It should prefer planning/domain/refactor/design skill flows.
- Generator: executes only approved repository issues. It should prefer
  implementation/TDD/runtime-verification skill flows.
- Evaluator: verifies recorded evidence and acceptance criteria. It should
  prefer review/QA/verification skill flows and must not implement.

Role profiles belong to a department, not to the company or an agent provider.
The existing Evaluator prompt in `src/board/taskEvaluator.ts` (responsibility
boundary, allowed statuses, forbidden actions) is the informal role profile the
explicit shape should be extracted from. Skill flows must load progressively:
the profile names flows, the agent loads the selected flow's skills when the
work starts, and "load every installed skill" is rejected as a configuration.

Resolved decisions (implemented in `src/board/roleProfiles.ts`):

- Role profiles live in a separate file: `.sandcastle/role-profiles.json`, with
  built-in defaults and partial per-role overrides. Invalid files fail fast at
  board startup; `SKILL_ROUTER.md` stays the skill-flow catalog the profiles
  point at.
- The resolved profiles are rendered into the Planner phase prompts, the
  Generator execution prompt, and the Evaluator verification prompt, and are
  served at `GET /api/role-profiles` for the company shell Settings view.
- Agent/model preferences on a profile are advisory in v1: the shape carries
  optional `agent` / `model` fields, but the CLI flags still decide which
  agent actually runs.

Open decisions:

- Whether advisory agent/model preferences should become binding (per-role
  agent selection) in a later slice.
- How far v1 goes beyond Planner/Generator/Evaluator before becoming too close
  to Rudder's company-wide role model.

## #7: Review and feedback loop

Blocked by: #2, #3, #4, #5, #6
Type: Discuss

### Question

How should Sandcastle represent post-execution review and feedback while
keeping approval before execution as a separate workflow gate?

### Answer

Unresolved, but the previous model needs reframing. The board now has two
existing gates:

- pre-execution human approval of the generated or imported workspace plan
- post-execution deterministic verification of execution evidence

Human review should sit after verification and should consume the approved plan,
progress document, verification report, generated issue status, run evidence,
and artifacts. Initial hypothesis: review is a decision on a board task
(`accepted`, `rejected`, `changes-requested`). Feedback is a note attached to a
board task, board run, review, or artifact. Feedback should not auto-promote
into skills or workflow rules in v1.

## #8: Control plane store interface

Blocked by: #4, #5, #6, #7
Type: Discuss

### Question

When should `BoardStore` become a replaceable control plane store interface,
and what is the smallest interface that keeps file storage viable while leaving
room for desktop SQLite later?

### Answer

Unresolved, but more urgent than the original plan. `BoardStore` now owns:

- board task and board run records
- run events and usage aggregation
- task source
- current Board role / future role profile
- workflow state
- stage projection
- task progress documents
- generated issue markdown and local issue status
- verification reports
- filesystem watching and SSE change publication

ADR 0024 says file-backed storage remains the default and SQLite should enter
behind an interface, not inside the orchestration core. The next design pass
should define the smallest interface the existing frontend/server and a future
desktop shell can share.

## #9: Company shell and board product pass

Blocked by: #4, #5, #6, #7, #8
Type: Prototype

### Question

What should the v1 company shell and the workflow board UI show to make the
task-to-review loop usable without exposing raw transcripts as the default
experience?

### Answer

Direction resolved in ADR 0026; prototype after the model questions settle.
The company shell is a navigation and ownership layer over the existing board
API, with a company-level left navigation:

- **Departments**: the Software R&D department (operational) plus inert
  placeholder departments. Opening the product lands in the Software R&D
  department by default.
- **Projects**: a company view over workspaces/repositories, projected from
  the existing `workspace.json` and board task data — no new record type.
- **Artifacts**: a company-wide view over existing `BoardTaskArtifact` records
  across tasks; filtering and navigation only, no new artifact system.
- **Reviews**: home for the post-verification human review loop from #7;
  until review state exists, it shows verification reports awaiting judgment.
- **Settings**: agent/sandbox defaults, per-department role profiles, and
  skill-flow routing.

Inside the department, the UI pass should not start from a blank slate; it
should preserve the current stage/timeline, approval, terminal, cancel/recover,
progress, verification, run detail, and usage interactions. The likely product
work is information architecture:

- show task source and startup path clearly
- make planning artifacts, progress, issue markdown, verification, and run
  evidence first-class inspection surfaces
- make human review/feedback the next action after verification
- keep raw transcript and terminal output available but not the default summary

The v1 core deliverable is the company shell plus one complete Software R&D
department. Renames for company framing are UI-level only; store shapes and
API paths do not churn for naming reasons.

## #10: CopilotKit frontend integration spike

Blocked by: #8, #9
Type: Prototype

### Question

Can CopilotKit improve the board/desktop frontend without weakening the
library-first orchestration core?

### Answer

Initial research says yes, but only as a frontend shell candidate. CopilotKit's
useful primitives are React provider/runtime integration, chat/sidebar UI,
frontend tools/actions, shared app context, generative UI, multi-agent panels,
and human-in-the-loop controls. These map naturally to Sandcastle's board API:

- expose selected task, stage, artifacts, verification report, and workspace as
  frontend context
- turn board actions into frontend tools backed by existing endpoints:
  - complete phase: `POST /api/tasks/:id/phases/:phase/complete`
  - approve/reject plan: `POST /api/tasks/:id/resume` with
    `{ "decision": "approve" | "reject" }`
  - cancel: `POST /api/tasks/:id/cancel`
  - recover: `POST /api/tasks/:id/recover`
  - open artifact: `GET /api/tasks/:id/artifacts`, then open by
    `absolutePath`/`displayPath`
  - start review: the future review endpoint from #7; until it exists the
    tool surfaces `GET /api/tasks/:id/verification` and records that review is
    manual
- render generative UI for verification summaries, artifact lists, and role
  recommendations
- offer role-scoped assistants for Planner, Generator, Evaluator, and later
  other software R&D roles — scoped by the current department and Board role

The assistant acts through the same gates as a human: its tools call the same
endpoints with the same approval, cancellation, and recovery semantics, and no
tool may bypass plan approval or mark verification passed.

Do not add CopilotKit to the current embedded board HTML. The package currently
ships a single self-contained frontend string with CDN-loaded React/htm/xterm
and no frontend build step. A CopilotKit spike should happen after extracting a
real React board/desktop shell, or as a separate app that talks to the existing
board API. CopilotKit must never enter the orchestration core or become a
dependency of the published library package (ADR 0026).

**Spike landed:** `spikes/copilotkit-board-shell/` implements this as a
separate Vite/React app over the board API (see the roadmap's "Next
Recommended Task" item 4 for the tool mapping). Findings: CopilotKit v2's
`useAgentContext` / `useFrontendTool` / `useHumanInTheLoop` cover the readable
context, tool, and approval-gate needs directly; the v2 React provider
defaults to the single-endpoint transport, so the self-hosted runtime must
serve `mode: "single-route"`; and the human-in-the-loop cards keep
approve/reject/cancel as human clicks against the existing endpoints, so no
workflow gate moved into the assistant.

## #11: Desktop shell boundary

Blocked by: #8, #9, #10
Type: Discuss

### Question

What should the desktop app own, and what must remain owned by the library and
local control plane?

### Answer

Resolved by ADR 0027 and implemented in `apps/desktop/` (Electron, own
`package.json`, never published). The desktop app owns exactly:

- repository selection (persisted in Electron `userData`, switchable via menu)
- supervising a `sandcastle board` child process for the selected repo
  (repo-local CLI first, `SANDCASTLE_CLI` override, this checkout's
  `dist/main.js` as dogfooding fallback)
- the shell server: built renderer + CopilotKit runtime at `/api/copilotkit`
  (LLM keys stay in the main process, read from env or the repo's
  `.sandcastle/.env`) + reverse proxy for every other `/api/*` call including
  the terminal WebSockets
- native notifications from the board SSE stream (succeeded / failed / plan
  awaiting approval)

The renderer is the CopilotKit React shell grown out of the #10 spike, now
with the company navigation (Software R&D / Departments / Projects /
Artifacts / Reviews / Settings) over the existing company APIs. It does not
own orchestration semantics, board storage, or the task/run/review models;
the embedded board stays the dependency-free default UI.

## Current next implementation slice

Blocked by: #1, #2, #3, #6, #10
Type: Discuss

### Question

What should the next coding slice stabilize before any desktop work begins?

### Answer

Recommended slice (per ADR 0026: company shell + one complete Software R&D
department):

1. Treat `BoardTaskView`, `BoardTaskStage`, `BoardTaskSource`, `BoardRole`,
   `BoardTaskArtifact`, and verification status as the Software R&D
   department's contract candidate set — these become the template shapes any
   future department is measured against.
2. **Done.** Role profiles are explicit configuration in
   `src/board/roleProfiles.ts`: built-in Planner/Generator/Evaluator defaults,
   partial overrides from `.sandcastle/role-profiles.json`, progressive
   skill-flow prompt instructions, and injection into the Planner phase,
   Generator execution, and Evaluator verification prompts.
3. **Done (embedded shell).** The embedded board frontend now carries the
   company-level navigation (Departments / Projects / Artifacts / Reviews /
   Settings) over new company APIs (`/api/company`, `/api/artifacts`,
   `/api/reviews`, `/api/role-profiles`), landing in the Software R&D
   department by default. Placeholder departments are inert entries only.
4. **Done (spike, promoted).** The CopilotKit board shell spike proved a
   role-aware assistant over the existing board API: board state (company
   view, role profiles, task stages, selected task workflow/plan/artifacts)
   shared as agent context, and six frontend tools mapped 1:1 onto existing
   board endpoints — `completePhase`, `decideApproval`, `cancelTask`,
   `recoverTask`, `openArtifacts`, `startReview`. Approval and cancellation
   are human-in-the-loop: the assistant renders the decision card, a person
   clicks, and the click calls the same `resume`/`cancel` endpoint the
   embedded board uses. The spike has since been promoted into the desktop
   renderer at `apps/desktop/renderer/` (ADR 0027); the embedded board and
   published package stay CopilotKit-free.
5. **Done (desktop shell).** `apps/desktop/` wraps the control plane in an
   Electron shell per ADR 0027: repo picker, `sandcastle board` child
   process, shell server (renderer + CopilotKit runtime + board proxy with
   WebSocket upgrades), and native notifications. See #11.
6. Next: add human review and feedback on top of existing approval,
   verification, artifacts, and role profiles.
