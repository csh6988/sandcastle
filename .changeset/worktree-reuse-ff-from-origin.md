---
"@ai-hero/sandcastle": patch
---

Fix `createSandbox` (and `createWorktree`) reusing a stale worktree when called twice for the same named branch. A reused worktree holds a local copy of the branch that never moves on its own, so a re-run loop (review → push fixes → re-run) was reading stale code even though `origin/<branch>` had moved ahead.

On the **clean** worktree-reuse path of the **branch** strategy, sandcastle now runs `git fetch origin <branch>` followed by `git merge --ff-only origin/<branch>` so the worktree picks up new upstream commits. The refresh only runs when it is provably safe — clean tree and strictly behind origin. **Dirty**, **diverged** (unpushed commits), or **fetch fails** (offline) → skip the refresh, reuse as-is, log why. Fetch failure is non-fatal and never breaks the run. First creation, the merge-to-head strategy, and the head strategy are untouched. See ADR 0003 for the full rationale.
