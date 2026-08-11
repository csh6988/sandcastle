# Ack-gated selective Runtime event compaction

Company Runtime needs to bound growth of replay-oriented Runtime events without
discarding durable business facts or letting a fast consumer authorize deletion
past a slower consumer. Schema v53 therefore adds an append-only **Runtime event
compaction checkpoint**, and compaction remains an explicit Company
Runtime-owned operation rather than a background or caller-owned writer.

## Decision

- The Runtime Event Registry's retention class is the sole eligibility source.
  `durable` events remain in the Runtime event outbox; only `standard` and
  `transient` events may be removed.
- Compaction is acknowledgement-gated at the slowest Runtime event cursor and
  also honors the requested retained tail. With no acknowledged cursor, no
  event is eligible. The prune and its checkpoint commit atomically under the
  single-writer Company Runtime boundary.
- Authority is injected from the authenticated principal, not accepted from the
  Command payload. Only a verified local-session human or a Runtime worker may
  authorize compaction, and the checkpoint records that actor and Command ID.
- Selective retention deliberately leaves non-contiguous persisted sequences:
  durable events keep their original sequence while eligible events between
  them may be removed. The checkpoint range is the minimum and maximum removed
  sequence and may enclose retained durable events; the removed-event count is
  the authoritative quantity.
- Each non-empty prune appends one immutable checkpoint. Its pre-compaction
  integrity hash covers the removed events' sequence, event ID, and type, not
  their payload, and records the acknowledgement watermark that bounded the
  operation.
- Compaction is not idempotent: each invocation acts on the currently eligible
  slice. Command-ID uniqueness protects checkpoint identity rather than
  deduplicating retries, and a no-op writes no checkpoint because no removal
  occurred.

## Consequences

Consumers must tolerate holes in persisted Runtime event sequences after their
acknowledged boundary and must not interpret a checkpoint range as a contiguous
deleted interval. Durable facts remain replayable, checkpoint history remains
auditable but cannot reconstruct removed payloads, and changing retention or
acknowledgement policy requires an explicit registry/domain decision rather
than a diagnostics-only implementation change.
