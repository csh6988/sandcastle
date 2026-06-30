# V1 library-first control plane decision map

This map tracks the multi-session planning work for Sandcastle v1. The current
direction is recorded in ADR 0024: keep Sandcastle library-first, productize the
local workflow board into a **control plane**, then wrap it with desktop later.

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
- In-progress uncommitted board work adds LangGraph board phases, plan approval,
  checkpoint resume, conservative retry, phase sessions, terminal WebSocket
  support, filesystem watching, README updates, and changesets.

Verification run during this planning pass:

- `npm run typecheck` passed.
- `npx vitest run src/board/BoardStore.test.ts src/board/server.test.ts src/board/router.test.ts src/board/langGraphTaskRunner.test.ts src/board/terminalSession.test.ts src/board/launchTask.test.ts src/cli.test.ts` passed: 77 tests.

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
- artifact, review, and feedback shapes
- store-facing abstractions currently hidden inside `src/board`

## #3: Board interaction audit

Blocked by: #1, #2
Type: Discuss

### Question

Which existing workflow board interactions are v1 control-plane commitments,
and which should remain internal or POC-only?

### Answer

Partially resolved from code reading. Existing reusable interaction points:

- New board task modal creates tasks through `POST /api/tasks`.
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
- Plan approval and rejection resume the paused workflow.
- Phase completion can happen through the UI button or through the terminal
  completion signal.

Initial decision: v1 should reuse this spine. Artifact, review, and feedback
should be added to task detail and run detail rather than introduced as a
separate product flow.

## #4: Artifact model

Blocked by: #2, #3
Type: Discuss

### Question

What is the smallest artifact model that makes agent work inspectable without
turning Sandcastle into a document management system?

### Answer

Unresolved. Initial hypothesis: artifact records need id, owner
(`board-task` or `board-run`), kind, title, locator, created timestamp, and
optional metadata. Kinds should start with file path, URL, pull request link,
screenshot, and plan file.

## #5: Review and feedback loop

Blocked by: #2, #3, #4
Type: Discuss

### Question

How should Sandcastle represent post-execution review and feedback while
keeping approval before execution as a separate workflow gate?

### Answer

Unresolved. Initial hypothesis: review is a decision on a board task or
artifact (`accepted`, `rejected`, `changes-requested`). Feedback is a note
attached to a board task, board run, review, or artifact. Feedback should not
auto-promote into skills or workflow rules in v1.

## #6: Control plane store interface

Blocked by: #4, #5
Type: Discuss

### Question

When should `BoardStore` become a replaceable control plane store interface,
and what is the smallest interface that keeps file storage viable while leaving
room for desktop SQLite later?

### Answer

Unresolved. ADR 0024 says file-backed storage remains the default and SQLite
should enter behind an interface, not inside the orchestration core.

## #7: Board product pass

Blocked by: #4, #5, #6
Type: Prototype

### Question

What should the workflow board UI show to make the task-to-review loop usable
without exposing raw transcripts as the default experience?

### Answer

Unresolved. Prototype after the model questions settle.

## #8: Desktop shell boundary

Blocked by: #6, #7
Type: Discuss

### Question

What should the desktop app own, and what must remain owned by the library and
local control plane?

### Answer

Unresolved. Initial hypothesis: desktop owns startup, config, credential
helpers, native notifications, and opening repos/worktrees/artifacts. It should
not own orchestration semantics or redefine board task/run/review models.
