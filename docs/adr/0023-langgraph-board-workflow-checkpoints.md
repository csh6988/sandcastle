# LangGraph board workflow checkpoints

The workflow board can now opt into a LangGraph-backed **board task** workflow
with `sandcastle board --workflow langgraph`. This mode keeps the existing
board UI, file-backed **BoardStore**, and **run event** persistence, but uses a
LangGraph state graph to pause after planning, wait for approval, resume from a
checkpoint, execute repositories, and retry failed repository execution once.

## Decisions

- **LangGraph is an opt-in task workflow, not the board store.** ADR 0022 keeps
  `BoardStore` dependency-free and file-backed. That remains true: task and run
  metadata stay in JSON / NDJSON under `.sandcastle/board/`. LangGraph stores
  only workflow checkpoints.
- **SQLite is scoped to workflow checkpoints.** The SQLite file defaults to
  `.sandcastle/board/workflows.sqlite` and is only created when
  `--workflow langgraph` is selected. The native dependency cost is accepted for
  this opt-in runtime because durable interrupt/resume is the feature being
  tested.
- **The existing `TaskRunner` seam remains the integration point.** The
  LangGraph runner implements the same board task contract used by the legacy
  `runWorkspaceTask` launcher. The HTTP server and frontend continue to observe
  changes through the same store and SSE stream.
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
SQLite checkpoint package depends on `better-sqlite3`; users who never pass
`--workflow langgraph` still use the original board task path, but package
installation now includes the dependency. A future packaging pass can move the
workflow runner behind a separately installed optional integration if this
native dependency is too costly for default installs.
