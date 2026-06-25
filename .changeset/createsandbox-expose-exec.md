---
"@chenshaohui/sandcastle": minor
---

Add `sandbox.exec(command, options?)` to the `Sandbox` handle returned by `createSandbox()` (and by `worktree.createSandbox()`). The method delegates to the provider handle's `exec()` and returns the full `ExecResult` — non-zero `exitCode` is surfaced, not thrown — so harnesses can run shell commands (tests, lints, custom verification gates) directly in the same warm sandbox between `run()` calls without reaching for the underlying provider handle. `cwd` defaults to the sandbox repo path so behavior is consistent across providers; pass `cwd` to override.
