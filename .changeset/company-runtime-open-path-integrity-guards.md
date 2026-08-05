---
"@chenshaohui6988/sandcastle": patch
---

Harden the Company Runtime database open path: an at-target company database now re-runs the structural drift check and is rejected if tampered, and its `schema_metadata` version marker is cross-validated against the `PRAGMA user_version` mirror so a disagreement fails closed. A future/unknown schema version keeps being refused. Forward-only migration behavior is preserved and no immutable history is rewritten.
