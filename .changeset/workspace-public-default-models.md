---
"@chenshaohui6988/sandcastle": patch
---

Use public default models for `sandcastle workspace plan/run/execute`. The CLI previously defaulted to internal routing slugs (`x6/claude-opus-4-8`, `x5/gpt-5.5`) that only resolve on company infrastructure, so external users had to pass `--model` to run at all. The workspace commands now default to the agent registry's public models (the same ones `sandcastle init` scaffolds), with a single source of truth for future model bumps. Pass `--model` (and `--planner-model`) to override.
