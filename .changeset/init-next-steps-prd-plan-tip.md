---
"@chenshaohui6988/sandcastle": patch
---

Point `sandcastle init` next steps at the PRD-first workspace flow. After scaffolding, init now reminds users they can run `sandcastle workspace plan --prd-file <path>` to turn a PRD into PRD alignment, a technical plan, and per-repository issues under `.scratch/` (then `workspace execute`, or `workspace run` for both). The hint appears for the blank and template-driven flows; the custom issue tracker keeps its focused setup steps.
