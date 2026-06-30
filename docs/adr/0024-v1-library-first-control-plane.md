# V1 library-first local control plane

Sandcastle v1 should remain a TypeScript library and CLI first, while making
the local **control plane** a productized consumer of that library. The goal is
not to become a full Rudder-style desktop product immediately. The goal is to
make Sandcastle's orchestration core stable enough that the workflow board and a
future desktop shell can consume the same public seams instead of reaching into
internal implementation details.

## Decisions

- **Keep the orchestration core library-first.** `run()`, `createSandbox()`,
  `createWorktree()`, `runWorkspace()`, `runWorkspaceTask()`, provider
  factories, `Output`, and the **run event** stream stay the primary public
  surface. The control plane should use those surfaces rather than creating a
  parallel execution path.
- **Make the workflow board the first control plane.** `sandcastle board` is
  the productized local surface for **board tasks**, **board runs**, workflow
  phases, plan approval, run activity, usage, artifacts, review, and feedback.
  A desktop app can wrap this later, but should not redefine the core model.
- **Reuse the existing board interactions.** The current board already has the
  useful interaction spine: task creation, task/run selection, live SSE updates,
  run detail, usage detail, LangGraph **board phases**, plan approval, phase
  terminals, terminal WebSocket input, and phase completion. V1 should harden
  these interactions instead of designing a separate control-plane flow.
- **Do not introduce Rudder's organization model for v1.** Organization,
  reporting line, chat, calendar, automation, and enterprise access control are
  out of scope for v1. Sandcastle's unit of coordination remains a local host
  repo or workspace plus board tasks created for that workspace.
- **Use tasks, not a second issue model.** The project already reserves
  **issue tracker** for external task sources such as GitHub Issues and Beads.
  The v1 control plane should deepen **board task** instead of introducing a
  generic "issue" object that competes with the existing vocabulary.
- **Keep storage swappable.** The current file-backed `BoardStore` remains the
  default local store. If desktop needs SQLite later, introduce it behind a
  store interface rather than hard-coding it into the orchestration core.
- **Make review and feedback explicit but small.** V1 should support a visible
  human loop: create a board task, plan it, approve execution, inspect artifacts
  and run evidence, record review, and attach feedback. Promotion of feedback
  into skills or workflows can come after the loop is reliable.

## Sequenced plan

1. **Stabilize current board workflow work.** Finish the in-progress
   LangGraph-backed board phases, approval resume, phase sessions, filesystem
   watching, and related README/docs updates. Keep the existing tests green.
2. **Board interaction audit.** Treat the existing board as the baseline product
   surface. Audit task creation, task detail, run detail, plan rendering,
   approval, phase completion, phase terminals, live updates, and filesystem
   watching. Decide which interactions are v1 commitments and which remain POC
   internals.
3. **Library event and result audit.** Audit `RunEvent`, `RunResult`,
   `WorkspaceTaskPlan`, `WorkspaceTaskRepositoryResult`, and board-local
   projections. Identify the smallest additions needed for artifacts, review
   state, feedback, and richer failure/output evidence.
4. **Artifact model.** Add a small artifact representation that can be attached
   to board tasks and runs without requiring a database or desktop runtime.
   Initial artifact kinds should cover local file paths, URLs, pull request
   links, screenshots, and plan files.
5. **Review model.** Add board task review state with accepted, rejected, and
   changes-requested outcomes. Keep approval before execution separate from
   review after inspecting output.
6. **Feedback model.** Add durable feedback notes attached to board tasks,
   board runs, reviews, or artifacts. Do not auto-promote feedback into skills
   or prompt rules in v1.
7. **Control plane store interface.** Once the board task model grows beyond
   runs/events/tasks, introduce a narrow store interface that the file-backed
   store implements. This is the future desktop/SQLite seam.
8. **Board UI product pass.** Update the embedded frontend around the loop:
   task intake, phase progress, run detail, artifacts, review, feedback, and
   usage. Raw transcript remains a lower-level detail.
9. **Desktop shell.** Add desktop only after the board loop is stable. The
   desktop shell should start the local board/server, manage local config and
   credentials, open repositories/worktrees/artifacts, and surface native
   notifications.

## Acceptance criteria

- A user can start from `sandcastle init`, open `sandcastle board`, create a
  board task from a PRD, collaborate through board phases, approve execution,
  inspect runs and artifacts, record a review, and leave feedback.
- The same execution path remains available programmatically through the
  library APIs.
- The control plane does not require a remote service, login, or database for
  the default local workflow.
- Provider pluggability remains intact for **agent providers** and **sandbox
  providers**.
- New public types remain Effect-free and documented.

## Consequences

This path makes v1 narrower than a Rudder clone but gives Sandcastle a stronger
product surface. The desktop app becomes a shell around a mature local control
plane instead of the place where the core model is invented. The main risk is
that board storage and frontend complexity grow inside the package; the store
interface and library-first API audit are the planned pressure valves.
