---
"@ai-hero/sandcastle": patch
---

Normalize path separators when comparing worktree paths so the worktree manager works on Windows. `git worktree list --porcelain` reports forward slashes on every platform, while `node:path.join` produces backslashes on Windows, so the raw comparisons previously failed there: `create()` would reject reusing a managed worktree with a spurious "already checked out" error, and `pruneStale()` could delete every active worktree under `.sandcastle/worktrees/`.
