---
"@chenshaohui6988/sandcastle": patch
---

Retain larger Board phase terminal transcripts so noisy PTY output does not evict the interactive `workspace_plan` before the creating-issues phase imports it.

Hide the Board verification report action until a verification report exists, avoiding a premature "task verification not found" alert while a task is still awaiting approval.

Use task-scoped default branch prefixes for Board execution so separate Board tasks do not reuse the same `codex/workspace-task/<repo>` branch.
