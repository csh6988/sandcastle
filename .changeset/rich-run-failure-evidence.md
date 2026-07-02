---
"@chenshaohui6988/sandcastle": minor
---

Add optional structured recovery evidence to `run-failed` run events. Failed
runs from `run()`, `runWorkspace()`, and `runWorkspaceTask()` now carry an
optional `recovery` object with a stable `RunFailureKind`
(`infrastructure` | `agent` | `task` | `unknown`), a best-effort failure phase,
the preserved worktree path, run log path, session id/file, completion-signal
state, and commit evidence — all optional and Effect-free. The original error is
still thrown unchanged. `RunFailureKind` and `RunFailureRecovery` are exported so
library callers can route infrastructure failures differently from agent or task
failures, and the workflow board surfaces the evidence in its recovery text.
Minimal legacy message-only `run-failed` events still render safely.
