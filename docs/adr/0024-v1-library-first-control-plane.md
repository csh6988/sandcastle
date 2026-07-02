# V1 library-first local control plane

Sandcastle v1 should remain a TypeScript library and CLI first, while making
the local **control plane** a productized consumer of that library. The goal is
not to become a full Rudder-style desktop product immediately. The goal is to
make Sandcastle's orchestration core stable enough that the workflow board and a
future desktop shell can consume the same public seams instead of reaching into
internal implementation details.

Since this direction was first written, `sandcastle board` has moved beyond a
simple task/run viewer. The board now has a concrete PRD-to-plan-to-approval-to
execution-to-verification loop: PRD-file task creation, workspace-plan import,
planning-only export, interactive planning phases, workspace-plan validation
and fix loops, cancellation, recovery, progress documents, generated local
issue status, verification reports, and a derived stage/timeline view. V1 should
stabilize these existing product primitives before adding another product layer.

## Decisions

- **Keep the orchestration core library-first.** `run()`, `createSandbox()`,
  `createWorktree()`, `runWorkspace()`, `runWorkspaceTask()`, provider
  factories, `Output`, and the **run event** stream stay the primary public
  surface. The control plane should use those surfaces rather than creating a
  parallel execution path.
- **Make the workflow board the first control plane.** `sandcastle board` is
  the productized local surface for **board tasks**, **board runs**, workflow
  phases, plan approval, run activity, usage, **planning artifacts**,
  **verification reports**, recovery, and later review and feedback. A desktop
  app can wrap this later, but should not redefine the core model.
- **Reuse the existing board interactions.** The current board already has the
  useful interaction spine: task creation, task/run selection, live SSE updates,
  run detail, usage detail, file-backed **board phases**, plan approval,
  **board planning-only mode**, phase terminals, terminal WebSocket input,
  phase completion, workspace-plan import/fix, cancellation, recovery,
  task progress, local issue status sync, verification reports, and the
  stage/timeline projection. V1 should harden these interactions instead of
  designing a separate control-plane flow.
- **Do not introduce Rudder's organization model for v1.** Organization,
  reporting line, chat, calendar, automation, and enterprise access control are
  out of scope for v1. Sandcastle's unit of coordination remains a local host
  repo or workspace plus board tasks created for that workspace.
- **Use tasks, not a second issue model.** The project already reserves
  **issue tracker** for external task sources such as GitHub Issues and Beads.
  The v1 control plane should deepen **board task** instead of introducing a
  generic "issue" object that competes with the existing vocabulary.
- **Promote existing artifacts before inventing a generic artifact system.**
  The board already writes concrete artifacts: approved planning artifacts,
  task progress, generated issue markdown with local issue status, and
  verification reports. V1 should stabilize ownership, paths, API access, and
  display for these artifacts first. A generic artifact record should be
  extracted only after those concrete artifacts expose the shared shape.
- **Keep storage swappable.** The current file-backed `BoardStore` remains the
  default local store. Because it now owns task source, workflow, stage,
  progress, issue status, verification, and artifact-like files, the store
  interface is a near-term seam rather than a desktop-only concern. If desktop
  needs SQLite later, introduce it behind this interface rather than
  hard-coding it into the orchestration core.
- **Keep review distinct from approval and verification.** The board already
  has pre-execution human approval and post-execution deterministic
  verification. V1 should add human review and feedback on top of that evidence
  instead of replacing either gate. Promotion of feedback into skills or
  workflows can come after the loop is reliable.

## Sequenced plan

1. **Stabilize current board workflow work.** Finish the in-progress
   file-backed board phases, approval resume, phase sessions, filesystem
   watching, startup sources, planning-only export, cancellation, recovery,
   verification, issue status sync, and related README/docs updates. Keep the
   existing tests green.
2. **Board contract audit.** Treat the existing board as the baseline product
   surface. Audit `BoardTaskView`, `BoardTaskStage`, `BoardTaskSource`,
   planning artifact paths, task progress paths, verification report paths,
   stage controls, and router endpoints. Decide which are v1 commitments and
   which remain POC internals.
3. **Library event and result audit.** Audit `RunEvent`, `RunResult`,
   `WorkspaceTaskPlan`, `WorkspaceTaskRepositoryResult`, and board-local
   projections. Identify the smallest additions needed for artifact references,
   human review state, feedback, and richer failure/output evidence.
4. **Verification and recovery audit.** Stabilize the semantics of
   `passed`, `failed`, `needs-recovery`, and `infra-warning`; define when
   recovery resumes execution versus returns to an interactive phase; and keep
   verification evidence readable without relying on raw transcripts.
5. **Concrete artifact audit.** Stabilize the artifact set that already exists:
   planning artifacts, progress documents, generated issue markdown with local
   issue status, verification reports, run events, usage, commits, and external
   links. The immediate product slice should follow the board roadmap: persist
   an artifact manifest, expose task artifacts through the board API, and render
   them in task detail. Only then extract a generic artifact representation if
   the shared shape is obvious.
6. **Review and feedback model.** Add board task review state with accepted,
   rejected, and changes-requested outcomes, based on the approved plan,
   verification report, run evidence, and artifacts. Keep approval before
   execution and verification after execution as separate gates.
7. **Control plane store interface.** Introduce a narrow store interface that
   the file-backed store implements before the desktop shell depends on board
   internals. The interface should cover tasks, runs/events, stage views,
   artifacts, progress, verification, review, and feedback.
8. **Board UI product pass.** Update the embedded frontend around the loop:
   task intake, source labels, phase progress, stage timeline, plan approval,
   progress/verification artifacts, recovery, run detail, review, feedback, and
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
