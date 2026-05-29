---
"@ai-hero/sandcastle": patch
---

`Sandbox.run()` (from `createSandbox()`) and `Worktree.run()` (from `createWorktree()`) now emit the run-complete status line and the `Context window: NNNk` line for each iteration with usage data, mirroring the behaviour of the top-level `run()` entry point. Previously these lines only showed up from `run()`, so callers using the lower-level wrappers never saw the completion status or token-count summaries even when usage was available.
