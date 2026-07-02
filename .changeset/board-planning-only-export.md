---
"@chenshaohui6988/sandcastle": patch
---

Add Board planning-only mode so approved Board workspace plans can export `workspace plan` artifacts without starting AFK execution. Exported planning artifacts are recorded in a task artifact manifest, exposed through the Board API, and rendered in the task detail panel. Planning-only approval now uses export-specific stage and button copy instead of AFK execution copy.

`sandcastle board --planning-only --help` now shows the Board help instead of treating `--help` as an unknown trailing argument.
