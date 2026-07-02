---
"@chenshaohui6988/sandcastle": patch
---

Run a dedicated Board Evaluator agent during verification when repository agent activity exists. The verification report now includes Evaluator output plus deterministic structured evidence, skips Evaluator review when execution failed before agent work, and preserves deterministic evidence for recovery when Evaluator verification fails.
