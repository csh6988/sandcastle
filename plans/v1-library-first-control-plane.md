# V1 library-first control plane decision map

This map tracks the multi-session planning work for Sandcastle v1. The current
direction is recorded in ADR 0024: keep Sandcastle library-first, productize the
local workflow board into a **control plane**, then wrap it with desktop later.
The board-specific implementation queue lives in
`docs/agents/board-roadmap.md`; this map should stay aligned with that roadmap
instead of duplicating every board delivery task.

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
- In-progress uncommitted board work now makes the board a concrete
  PRD-to-plan-to-approval-to-execution-to-verification control plane:
  LangGraph board phases, plan approval, checkpoint resume, conservative retry,
  phase sessions, terminal WebSocket support, filesystem watching, PRD-file
  task creation, workspace-plan import, planning-only export, workspace-plan
  validation/fix loops, cancellation, recovery, task progress documents, local
  issue status sync, verification reports, stage/timeline projection, README
  updates, and changesets.

Verification run during this planning pass:

- `npm run typecheck` passed.
- `npx vitest run src/board/BoardStore.test.ts src/board/server.test.ts src/board/router.test.ts src/board/langGraphTaskRunner.test.ts src/board/terminalSession.test.ts src/board/launchTask.test.ts src/cli.test.ts` passed: 77 tests.

Note: these verification results predate the latest board-mode additions. Re-run
targeted board tests and `format:check` before treating the updated baseline as
delivered.

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
- board task source, stage, artifact, verification, review, and feedback shapes
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
- Verification writes `verification.md` and syncs generated issue markdown
  status.
- `BoardTaskStage` projects timeline state plus available controls
  (`canComplete`, `canApprove`, `canReject`, `canCancel`, `canRecover`) for
  the frontend.

Initial decision: v1 should reuse this spine. Artifact, review, and feedback
should be added to task detail and run detail rather than introduced as a
separate product flow.

Next decision: stabilize which parts of `BoardTaskView`, `BoardTaskStage`,
`BoardTaskSource`, task artifact paths, and recovery/verification statuses are
contractual enough for desktop and library consumers.

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
- run/event/usage/commit evidence linked through board runs

Open decision: whether v1 needs a generic `BoardArtifact` record now, or
whether a smaller `BoardTaskArtifactsView` can expose these known artifacts
first. Do not design screenshots, PR links, or arbitrary URLs until the existing
artifact set is stable.

Roadmap alignment: `docs/agents/board-roadmap.md` currently makes artifact
visibility the P0 slice: persist an artifact manifest, expose task artifacts
through `/api/tasks/:id/artifacts`, and render artifacts in the board detail
view.

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
- `failed`
- `needs-recovery`
- `infra-warning`

Open decisions:

- Whether `BoardTaskStage` is the stable API for any future desktop frontend.
- Whether verification status names are final for v1.
- Whether cancellation should be a failed recoverable state or a distinct task
  outcome.
- What recovery may change after approval: it should continue or repair the
  approved plan, not re-plan silently.

## #6: Review and feedback loop

Blocked by: #2, #3, #4, #5
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

## #7: Control plane store interface

Blocked by: #4, #5, #6
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

## #8: Board product pass

Blocked by: #4, #5, #6, #7
Type: Prototype

### Question

What should the workflow board UI show to make the task-to-review loop usable
without exposing raw transcripts as the default experience?

### Answer

Unresolved. Prototype after the model questions settle. The UI pass should not
start from a blank slate; it should preserve the current stage/timeline,
approval, terminal, cancel/recover, progress, verification, run detail, and
usage interactions. The likely product work is information architecture:

- show task source and startup path clearly
- make planning artifacts, progress, issue markdown, verification, and run
  evidence first-class inspection surfaces
- make human review/feedback the next action after verification
- keep raw transcript and terminal output available but not the default summary

## #9: Desktop shell boundary

Blocked by: #7, #8
Type: Discuss

### Question

What should the desktop app own, and what must remain owned by the library and
local control plane?

### Answer

Unresolved. Initial hypothesis: desktop owns startup, config, credential
helpers, native notifications, and opening repos/worktrees/artifacts. It should
not own orchestration semantics or redefine board task/run/review models.

## Current next implementation slice

Blocked by: #1, #2, #3
Type: Discuss

### Question

What should the next coding slice stabilize before any desktop work begins?

### Answer

Recommended slice:

1. Treat `BoardTaskView`, `BoardTaskStage`, `BoardTaskSource`, known task
   artifact paths, and verification status as the board control-plane contract.
2. Implement the roadmap P0 artifact visibility slice: artifact manifest,
   artifact API, and board detail rendering for planning artifacts, progress,
   generated issue markdown, and verification.
3. Add tests around the exact JSON shape returned by `/api/tasks` and
   `/api/tasks/:id` for PRD-file tasks, imported workspace-plan tasks,
   planning-only approval, verification failures, infra warnings, cancellation,
   and recovery.
4. Add a narrow artifact/progress/verification API view instead of making
   frontend or desktop callers know `.sandcastle/board/tasks/<taskId>/...`
   paths.
5. Only after that, add human review and feedback on top of existing approval
   and verification.
