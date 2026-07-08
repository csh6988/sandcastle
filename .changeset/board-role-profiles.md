---
"@chenshaohui6988/sandcastle": minor
---

Make Planner / Generator / Evaluator role profiles explicit configuration. Built-in defaults define each role's responsibility, allowed/forbidden actions, and progressive skill flows; `.sandcastle/role-profiles.json` overrides any subset per role (invalid files fail fast at board startup). The resolved profiles are rendered into the Planner phase prompts, the Generator execution prompt, and the Evaluator verification prompt, and served at `GET /api/role-profiles` for the board Settings view. Agent/model preferences are advisory in v1.
