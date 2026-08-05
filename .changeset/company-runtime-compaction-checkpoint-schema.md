---
"@chenshaohui6988/sandcastle": minor
---

Add the append-only Runtime event compaction-checkpoint schema (Company Runtime storage v53). The forward-only migration introduces a STRICT `runtime_event_compaction_checkpoints` table with immutability triggers that records each compaction's compacted range, retained watermark, pre-compaction integrity hash, event count, and authorizing actor. The migration is additive — it creates no destructive change to any existing table or trigger and adopts an already-present checkpoint schema instead of failing on replay, matching the existing structural drift-guard convention. Compaction behavior that writes these rows lands in a later change; this establishes the durable authority record.
