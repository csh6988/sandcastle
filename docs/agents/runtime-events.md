# Durable Runtime Events

The desktop Runtime owns a registry-first, transport-neutral event stream. The
stream is persisted in SQLite and is authoritative across process restarts.

## Registry and outbox

Registry version 1 currently defines `project.created`, `project.updated`, and
`project.deleted`. Each event has a versioned `EventEnvelope`, a global
monotonic sequence, a `companyId` and `projectId` scope, and a validated
payload. Project catalog triggers append the canonical event in the same
transaction as the catalog mutation and its audit record.

The outbox is global and unfiltered. Consumers must apply their own scope
filtering and deduplicate by `eventId`; hidden or unmapped events still occupy
sequence numbers.

## Subscriptions and acknowledgement

`openSubscription` takes only the authenticated principal and consumer ID. The
Runtime starts at the durable acknowledged cursor, creates a generation, and
atomically supersedes the previous generation. `readSubscription` returns a
bounded batch and advances only that generation's delivered boundary.

Normal `ack-runtime-events` commands must name the active generation and cannot
advance beyond its contiguous delivered sequence. Acknowledgement updates the
cursor and audit record in one transaction and never appends another outbox
event. Replaying the same command ID returns the stored result; reusing it for a
different request returns `COMMAND_ID_REUSE`.

## View synchronisation and recovery

Verified Query envelopes return `{ view, asOfSequence, viewSyncToken }` from one
SQLite read snapshot. The signed, short-lived token binds the authenticated
principal, consumer, query, view, and sequence. A View-sync Ack consumes the
token exactly once, rebases the durable cursor to `asOfSequence`, and
supersedes any active subscription generation.

`CURSOR_AHEAD` and `CURSOR_EXPIRED` are deterministic recovery signals. The
client must perform barrier → Query → View-sync Ack → open before replaying the
unfiltered stream.
