---
"@chenshaohui6988/sandcastle": minor
---

Let `sandcastle init` capture a PRD and optionally plan from it.

- `sandcastle init --prd-file <path>` records a top-level `prdFile` field in the scaffolded `.sandcastle/workspace.json`. `sandcastle workspace plan` and `sandcastle workspace run` now default to that PRD when no explicit input flag is passed, with precedence: explicit `--prompt`/`--prompt-file`/`--prd`/`--prd-file` > configured `prdFile` > the only ready `.scratch/` issue.
- `sandcastle init --plan true` runs the planner once at the end of init to generate the plan artifacts (`workspace-plan.json`, `alignment.md`, `technical-plan.md`, and per-repository issues) using the agent and sandbox selected during init. It requires `--prd-file`, a non-custom issue tracker, and a docker/podman image built in the same init run (the planner runs the agent inside a bind-mount sandbox); when those prerequisites are not met it is skipped with a pointer to `sandcastle workspace plan`.
