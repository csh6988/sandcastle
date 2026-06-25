---
"@chenshaohui/sandcastle": minor
---

Add workspace task orchestration for multi-repository product requests. `runWorkspaceTask()` runs a planner agent to turn a PRD or product request into automatic PRD alignment notes, a technical plan, and repository-local issues, executes selected repository tasks in parallel with managed git lifecycle, and returns plan/results grouped by repository. The lower-level `runWorkspace()` API remains available for one agent invocation that needs several repositories mounted in the same sandbox. The new `sandcastle workspace plan` and `sandcastle workspace execute` CLI steps let callers generate, review, and then execute a workspace plan without writing a TypeScript runner or hand-authoring agent-ready issues. `sandcastle workspace run` is the one-command PRD-to-commits pipeline.
