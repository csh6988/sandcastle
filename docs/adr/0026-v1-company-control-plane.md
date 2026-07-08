# V1 company control plane with one complete department

ADR 0024 decided that Sandcastle v1 stays library-first and productizes the
local **workflow board** into a **control plane**, and that v1 should model a
**software R&D department** rather than copying Rudder's whole-company
organization system. That boundary was right about scope but wrong about
product framing: users experience Sandcastle v1 as a product, and the product
they open should feel like _their local AI company_, not like one anonymous
kanban. Rudder demonstrates that the "company" framing gives agent work a
durable home; it also demonstrates how much machinery (org charts, reporting
lines, chat, calendars, budgets) Sandcastle must **not** build for v1.

This ADR remodels v1 as a **local AI company control plane** whose first and
only complete execution unit is the **Software R&D department** — the current
v0 board, promoted rather than rebuilt. It refines ADR 0024; it does not
replace it. Everything ADR 0024 says about library-first seams, board asset
reuse, storage, review/approval separation, and CopilotKit staying out of the
core remains in force.

## Decisions

### Product model

- **Company is the top-level product object.** A **company** is the local,
  single-user product boundary: one host machine, one `.sandcastle/` config
  root, one board store, one set of departments. It is a product framing and a
  navigation/ownership layer — not a tenant, not an org chart, not an access
  control domain. There is exactly one company per control plane instance in
  v1; multi-company is out of scope.
- **Department is the execution unit inside a company.** A **department**
  owns a kind of work: its workflow phases, its **Board roles** and **role
  profiles**, its task sources, its artifact kinds, and its verification
  semantics. Departments are the seam where future work types plug in.
  A department is _not_ a generic workflow engine: v1 defines the department
  shape by promoting one concrete department, not by designing an abstract
  department SDK first.
- **The Software R&D department is the v0 board, promoted.** The current
  board _is_ the first complete department. Its
  PRD → plan → approval → execution → verification loop, its strict
  Planner/Generator/Evaluator **Board roles**, and its artifact/verification/
  recovery machinery become the department's internal structure. Nothing in
  the loop is redesigned; the board is re-housed, not rebuilt.
- **Other departments are placeholders in v1.** The company shell may list
  future departments (for example content, research, or operations) as
  lightweight placeholder entries so the product communicates the model, but
  v1 commits to exactly one complete department. A placeholder department has
  a name, a description, and a "not yet operational" state — no workflow, no
  storage, no API surface beyond listing. Do not promise or scaffold their
  execution machinery.
- **Role profile is the configuration behind a Board role.** A **role
  profile** binds a role's responsibility boundary, allowed actions, selected
  **skill flows**, prompt guidance, and optional agent/model preferences. Role
  profiles belong to a department, not to the company or to an agent
  provider — Claude, Codex, Pi, or a future agent can fill the same role. The
  Evaluator prompt in `src/board/taskEvaluator.ts` (responsibility boundary,
  allowed statuses, forbidden actions) is the existing informal role profile;
  the v1 work is making that shape explicit and configurable rather than
  inventing a new one.
- **Skill flows load progressively.** A **skill flow** is the focused set of
  skills a role profile selects for a kind of work (planning, implementation,
  review, debugging, merge-conflict resolution). Selection extends the
  existing `SKILL_ROUTER.md` routing model: the profile names flows; the agent
  loads the selected flow's skills when the work starts. Copying every
  installed skill into every invocation is explicitly rejected — a role
  profile that expands to "load everything" is a bug, not a configuration.

### Reuse of the v0 board

The v0 board is an asset. These existing shapes and behaviors are the Software
R&D department's contract candidates and must be reused, not reinvented:

- `BoardTaskView`, `BoardTaskStage` (mode, timeline, action booleans,
  `terminalPhase`, `recoverPhase`), `BoardTaskSource`, `BoardRole`
  (Planner / Generator / Evaluator), and `BoardTaskArtifact`.
- The PRD → plan → approval → execution → verification workflow with its
  file-backed phases, phase sessions, and phase terminals.
- The artifact manifest (`artifacts.json`), the artifact API
  (`GET /api/tasks/:id/artifacts`), and the artifact rendering in task detail.
- Evaluator-backed verification: the deterministic report, the Evaluator run,
  `verification.md`, and the verification statuses
  (`passed`, `needs-verification`, `needs-recovery`, `infra-warning`,
  `failed`).
- Recovery, cancellation, and the phase-terminal interaction model, including
  `recoverableBoardTaskPhase` semantics.

Renames for company framing are UI-level only. Store shapes, file layouts, and
API paths do not churn for naming reasons; if a type is later promoted to a
public department contract, that promotion is its own audited change per
ADR 0024's contract audit.

### Product shape

- **The company shell is a navigation and ownership layer.** V1's product
  surface adds a company-level left navigation: **Departments**, **Projects**,
  **Artifacts**, **Reviews**, and **Settings**. Opening the product lands in
  the Software R&D department by default, because it is the only operational
  department.
  - _Departments_ lists the Software R&D department (operational) and any
    placeholder departments (inert).
  - _Projects_ is the company view over workspaces/repositories the
    departments operate on; in v1 this projects from the existing
    `workspace.json` and board task data rather than introducing a new record.
  - _Artifacts_ is the company-wide view over existing `BoardTaskArtifact`
    records across tasks; it adds filtering/navigation, not a new artifact
    system (per ADR 0024: promote existing artifacts before inventing a
    generic one).
  - _Reviews_ is the home for the human review/feedback loop that ADR 0024
    sequences after verification; until review state exists it may show
    verification reports awaiting human judgment.
  - _Settings_ covers company-level configuration: agent/sandbox defaults,
    role profiles per department, and skill-flow routing.
- **The v1 deliverable is the company shell plus one complete department.**
  Success is: a user opens the control plane, sees their company, enters the
  Software R&D department, and drives the existing full loop
  (PRD → plan → approval → execution → verification → artifacts → review)
  without touching the terminal. Breadth of departments is explicitly not a
  v1 goal.
- **Sequencing stays library-first.** The order remains: stabilize the
  library seams and board contracts (ADR 0024 audits) → company shell over the
  existing board API → optional React shell spike → desktop shell. The company
  shell must consume the same HTTP API and store projections the current
  frontend uses; it must not grow a parallel execution path.

### CopilotKit boundary

- **CopilotKit is an interaction-layer candidate only.** It may be used in a
  React board shell or the future desktop shell. It must not enter the
  orchestration core (`run()`, workspace runners, provider seams), must not be
  added to the embedded self-contained HTML board (`frontendHtml.ts`), and
  must not become a dependency of the published library package.
- **The spike is an optional separate React shell.** The spike app talks to
  the existing board HTTP API and SSE stream. It provides: a role-aware
  assistant (scoped by the current department and Board role), human-in-the-
  loop controls, frontend tools backed by board API actions, and generative UI
  for artifacts and verification evidence. Its frontend tools map onto the
  existing endpoints:
  - complete phase → `POST /api/tasks/:id/phases/:phase/complete`
  - approve / reject plan → `POST /api/tasks/:id/resume` with
    `{ "decision": "approve" | "reject" }`
  - cancel → `POST /api/tasks/:id/cancel`
  - recover → `POST /api/tasks/:id/recover`
  - open artifact → `GET /api/tasks/:id/artifacts` then open by
    `absolutePath` / `displayPath`
  - start review → the future review endpoint from ADR 0024's review model;
    until it exists the tool surfaces `GET /api/tasks/:id/verification` and
    records that review is manual
- **The assistant acts through the same gates as a human.** CopilotKit tools
  call the same endpoints with the same approval, cancellation, and recovery
  semantics. No tool may bypass plan approval or mark verification passed;
  the assistant proposes, the human (or the existing workflow) decides.

## What this ADR does not change

- The orchestration core surfaces and Effect-free public types (ADR 0021,
  ADR 0024, ADR 0025).
- The file-backed `BoardStore` default and the store-interface plan
  (ADR 0024).
- The decision to keep organization charts, reporting lines, chat, calendar,
  budgets, and enterprise access control out of scope. The company is a
  product shell, not an enterprise system.
- The review-after-verification sequencing and the approval/verification gate
  separation.

## Consequences

Positive: Sandcastle v1 gets a product identity ("your local AI company")
comparable to Rudder's while shipping only one department's worth of
machinery; the v0 board's loop, roles, artifacts, and verification become the
template every future department is measured against; the department seam
gives future work types a place to land without widening the core now.

Negative / risks: the company shell adds a second frontend surface before the
React/desktop packaging boundary is settled — mitigated by keeping the shell
API-driven and the embedded HTML board unchanged until the React shell spike
resolves packaging; placeholder departments risk looking like broken features
— mitigated by explicit "not yet operational" states; "department" could drift
into a premature generic workflow abstraction — mitigated by defining the
shape only from the one promoted department.
