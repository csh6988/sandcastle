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
issue status, artifact manifests, Evaluator-backed verification reports,
Board-visible task artifacts, and a derived stage/timeline view. V1 should
stabilize these existing product primitives before adding another product layer.

ADR 0026 refines the product framing on top of this decision: v1 is a local
**company** control plane whose first complete **department** is the
**Software R&D department** — the current board, promoted rather than rebuilt.
Where this ADR says "model Sandcastle as a software R&D department, not a whole
company", read it together with ADR 0026: the company exists as a product shell
and navigation layer, while the department boundary below still holds — v1
ships exactly one complete department and no organization-system machinery.

## Decisions

- **Keep the orchestration core library-first.** `run()`, `createSandbox()`,
  `createWorktree()`, `runWorkspace()`, `runWorkspaceTask()`, provider
  factories, `Output`, and the **runtime event** stream stay the primary public
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
- **Model Sandcastle as a software R&D department, not a whole company.**
  Rudder is useful as a reference for a local, productized control plane with
  multiple roles. Sandcastle v1 should keep the narrower product boundary: a
  **software R&D department** with Board roles such as Planner, Generator, and
  Evaluator. Other company roles can be future role profiles, but they should
  not widen the v1 core.
- **Attach skills to role profiles, not to agents globally.** Each Board role
  should eventually select a focused **skill flow**: planning skills for
  Planner, implementation/TDD skills for Generator, review/verification skills
  for Evaluator. This should extend `SKILL_ROUTER.md` and project guidance
  rather than loading every installed skill into every agent invocation.
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
- **Keep CopilotKit out of the orchestration core.** CopilotKit is a promising
  React frontend layer for chat, generative UI, shared app state, frontend
  tools, and human-in-the-loop interactions. It should be evaluated for a
  future React board or desktop shell, not added to the published library core
  while the board frontend is still an embedded self-contained HTML asset.

## Sequenced plan

1. **Stabilize current board workflow work.** Keep the file-backed board phases,
   approval resume, phase sessions, filesystem watching, startup sources,
   planning-only export, artifact visibility, cancellation, recovery,
   Evaluator-backed verification, issue status sync, and related README/docs
   updates green.
2. **Board contract audit.** Treat the existing board as the baseline product
   surface. Audit `BoardTaskView`, `BoardTaskStage`, `BoardTaskSource`,
   planning artifact paths, task progress paths, verification report paths,
   stage controls, and router endpoints. Decide which are v1 commitments and
   which remain POC internals.
3. **Library event and result audit.** Audit `RuntimeEvent`, `RunResult`,
   `WorkspaceTaskPlan`, `WorkspaceTaskRepositoryResult`, and board-local
   projections. Identify the smallest additions needed for artifact references,
   human review state, feedback, and richer failure/output evidence.
4. **Verification and recovery audit.** Stabilize the semantics of
   `passed`, `needs-verification`, `needs-recovery`, `infra-warning`, and
   `failed`; define when recovery resumes execution versus returns to an
   interactive phase; and keep verification evidence readable without relying on
   raw transcripts.
5. **Concrete artifact audit.** Stabilize the artifact set that already exists:
   planning artifacts, progress documents, generated issue markdown with local
   issue status, verification reports, artifact manifests, PRD visual assets,
   runtime events, usage, commits, and external links. The initial artifact
   manifest/API/detail-view slice is complete; the next artifact work should
   decide what is stable enough for desktop and public API consumers.
6. **Role profile and skill-flow model.** Make Planner, Generator, and
   Evaluator role profiles explicit enough that each can select focused skill
   flows without coupling the orchestration core to a specific agent or skill
   runtime.
7. **Review and feedback model.** Add board task review state with accepted,
   rejected, and changes-requested outcomes, based on the approved plan,
   verification report, run evidence, and artifacts. Keep approval before
   execution and verification after execution as separate gates.
8. **Control plane store interface.** Introduce a narrow store interface that
   the file-backed store implements before the desktop shell depends on board
   internals. The interface should cover tasks, runs/events, stage views,
   artifacts, progress, verification, role profiles, review, and feedback.
9. **Board UI product pass.** Update the embedded frontend around the loop:
   task intake, source labels, phase progress, stage timeline, plan approval,
   progress/verification artifacts, recovery, run detail, review, feedback, and
   usage. Raw transcript remains a lower-level detail.
10. **CopilotKit/React frontend spike.** Prototype whether a React board shell
    can use CopilotKit for role-aware chat, human-in-the-loop controls,
    frontend tools backed by board API actions, and generative UI for artifacts
    and verification evidence. Keep this outside the core package until the
    frontend packaging boundary is clear.
11. **Desktop shell.** Add desktop only after the board loop is stable. The
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
