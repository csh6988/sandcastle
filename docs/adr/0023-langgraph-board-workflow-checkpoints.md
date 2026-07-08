# File-backed board workflow state

The workflow board uses the existing file-backed `BoardStore` as the durable
state for **board task** workflow progress. The Board keeps the same task UI,
phase flow, approval gate, runtime-event persistence, progress documents, and
verification reports, but workflow resume now comes from task JSON, plan
artifacts, progress documents, verification reports, and runtime-event files under
`.sandcastle/board/` instead of a SQLite checkpoint database.

## Decisions

- **BoardStore is the workflow checkpoint.** Task and run metadata stay in JSON
  / NDJSON under `.sandcastle/board/`. The task record stores the current phase,
  current **Board role**, approval action, retry count, verification status,
  phase sessions, and messages needed to resume or recover the workflow.
- **No SQLite checkpoint database.** The board no longer writes
  `.sandcastle/board/workflows.sqlite` and no longer depends on LangGraph,
  `@langchain/langgraph-checkpoint-sqlite`, or `better-sqlite3`. This keeps the
  default install free of a native SQLite dependency and makes the docs match
  the implementation.
- **Board roles are strict responsibility boundaries.** Planner phases may read
  repository docs and produce planning artifacts, but must not implement or
  commit. The Generator runs only approved repository issues and recovery stays
  inside the approved plan. The Evaluator writes the verification report and
  must verify acceptance criteria from recorded evidence rather than trusting a
  successful run or completion signal alone.
- **Interactive phases are workflow-scoped.** `classifying`, `aligning-prd`,
  `technical-planning`, and `creating-issues` each expose a **phase session**
  keyed by board task id and phase. Emitting the structured phase completion
  signal, or using the board's Continue button as a fallback, advances the
  stored task workflow state; the terminal process lifecycle does not mark the
  task succeeded or failed.
- **Issue generation stays interactive.** After `creating-issues` completes,
  the board imports and validates the `<workspace_plan>` block from the phase
  transcript. Import failures return to the same interactive phase as a
  workspace-plan fix state rather than starting a background planner run.
- **Existing workspace plans can enter at approval.** `sandcastle board
--plan-file <workspace-plan.json>` imports a reviewed plan as a **board task**
  already waiting for approval, providing the workflow-board equivalent of
  `workspace execute --plan-file`.
- **Recovery stays model-agnostic.** Failed approved executions recover from the
  stored plan plus the Board progress document and verification report. Recovery
  prompts instruct the Generator not to re-plan, regenerate Board issues, or
  redo repositories already marked succeeded unless verification proves they
  regressed.
- **Delivery verification is a separate Evaluator phase.** Approved repository
  execution transitions from `running` to `verifying` before a **board task**
  can succeed. The Board first renders deterministic structured evidence, then
  runs an **Evaluator run** when repository agent activity was recorded. The
  **Board verification report** contains Evaluator output plus the deterministic
  evidence, approved repositories, local issue status, repository execution
  results, linked **runtime event** evidence, completion-signal and commit evidence,
  errors, infrastructure/capture failures, and suggested next action.
- **Deterministic verification remains the fallback evidence.** If no
  repository agent activity was recorded, the Evaluator is skipped and the
  verification report states that no delivery was reviewed. If the Evaluator
  fails, the deterministic report is still written into `verification.md` so
  recovery can continue from stored progress and verification artifacts.
- **Infrastructure/capture failures are not delivery failures by default.**
  Conservative error-message classification handles known Sandcastle-side
  capture failures such as session capture, `copyFileOut`, and transcript
  capture problems. If a failed repository result also has both agent completion
  evidence and commit evidence, verification records `infra-warning` instead of
  treating the delivery as failed.

## Consequences

The board workflow no longer has a separate database artifact to back up,
inspect, or migrate. Durable recovery depends on keeping
`.sandcastle/board/tasks/<taskId>.json`, task-scoped artifacts, run records, and
runtime event streams together.

The legacy `createLangGraphTaskWorkflow` name remains as an internal API
compatibility point while the workflow implementation shifts to BoardStore
state. Future cleanup can rename that seam once downstream CLI, router, and test
call sites no longer depend on the old name.
