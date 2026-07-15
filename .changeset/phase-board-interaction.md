---
"@chenshaohui6988/sandcastle": minor
---

Attach workflow board terminals to the current Board phase, auto-continue phases when the agent emits the structured completion signal, and show a stable task stage/timeline in the Board UI. The creating-issues phase now imports the interactive workspace_plan visibly, rejects duplicate repository entries before approval or execution, and returns to an interactive fix state instead of falling back to a background planner run. Approval waits with an imported plan now survive board restarts and can recover back to approval if interrupted; failed approved executions can also be recovered to retry the stored workspace plan.
