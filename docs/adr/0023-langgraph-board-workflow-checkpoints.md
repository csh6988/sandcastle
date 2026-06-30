# LangGraph board workflow checkpoints

The workflow board now uses a LangGraph-backed **board task** workflow by
default. This mode keeps the existing board UI, file-backed **BoardStore**, and
**run event** persistence, but uses a LangGraph state graph to pause at
interactive **board phases**, wait for approval, resume from a checkpoint,
execute repositories, and retry failed repository execution once.

## Decisions

- **LangGraph is the task workflow, not the board store.** ADR 0022 keeps
  `BoardStore` dependency-free and file-backed. That remains true: task and run
  metadata stay in JSON / NDJSON under `.sandcastle/board/`. LangGraph stores
  only workflow checkpoints.
- **SQLite is scoped to workflow checkpoints.** The SQLite file defaults to
  `.sandcastle/board/workflows.sqlite`. The native dependency cost is accepted
  for this runtime because durable interrupt/resume is part of the board task
  workflow.
- **The existing `TaskRunner` seam remains the integration point.** The
  LangGraph runner implements the same board task contract used by the launcher.
  The HTTP server and frontend continue to observe changes through the same
  store and SSE stream.
- **Interactive phases are workflow-scoped.** `classifying`, `aligning-prd`,
  `technical-planning`, and `creating-issues` each expose a **phase session**
  keyed by board task id and phase. Emitting the structured phase completion
  signal, or using the board's Continue button as a fallback, resumes the graph;
  the terminal process lifecycle does not mark the task succeeded or failed.
  Issue generation stays interactive through final Board issue creation. After
  `creating-issues` completes, the board visibly imports and validates the
  `<workspace_plan>` block from the phase transcript; import failures return to
  the same interactive phase as a workspace-plan fix state rather than starting
  a background planner run.
- **User-facing stages are distinct from checkpoint status.** The board derives
  task-card labels, detail timeline rows, and available controls from a stable
  display stage model. `workflow.status` and `currentPhase` remain internal
  checkpoint/progress fields and are not concatenated directly in the UI.
- **Human approval is task-scoped.** The graph uses the board task id as the
  LangGraph `thread_id`, so a task can be resumed by approving or rejecting the
  plan through the board API.
- **Retries are conservative.** The POC retries failed repository execution once
  and then records the aggregate task result. More advanced retry policies can
  be added after the side effects of duplicate worktrees, branches, and commits
  are better understood.

## Consequences

The LangGraph workflow adds `@langchain/langgraph` and
`@langchain/langgraph-checkpoint-sqlite` to the runtime dependency set. The
SQLite checkpoint package depends on `better-sqlite3`. A future packaging pass
can move the workflow runner behind a separately installed optional integration
if this native dependency is too costly for default installs.
