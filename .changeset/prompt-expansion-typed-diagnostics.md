---
"@ai-hero/sandcastle": patch
---

Add typed diagnostics to prompt-expansion errors so a downstream orchestrator can branch on them programmatically instead of parsing the message. `PromptExpansionTimeoutError` now carries `elapsedMs` (the wall-clock time the shell expression actually ran before timing out, measured at the throw site) alongside the existing `timeoutMs`; `PromptError` carries an optional `exitCode` when the failure was a non-zero exit from a `` !`command` `` expansion. Both values are reflected in the formatted error message so a human reading the log can tell a 30s contention timeout from an instant auth failure. Follows ADR-0020 (fail-fast prompt expansion); no retry behaviour changes.
