---
"@chenshaohui6988/sandcastle": patch
---

Persist Board workflow progress through the file-backed BoardStore instead of a
SQLite checkpoint database, and record strict Planner/Generator/Evaluator roles
in task workflow state.
