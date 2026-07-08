---
"@chenshaohui6988/sandcastle": minor
---

Make `RuntimeEvent` the structured Sandcastle event model, expose it through `events.onRuntimeEvent`, add the AG-UI adapter, and remove the legacy `RunEvent` / `onRunEvent` compatibility surface. Workspace task event callbacks are now `onRepoRuntimeEvent` and `onPlannerRuntimeEvent`.
