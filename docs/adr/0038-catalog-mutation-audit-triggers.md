# Catalog mutations emit Runtime audit and outbox records

## Context

Company Runtime audit and Runtime event outbox records must cover configuration
changes as well as Pipeline Runtime transitions. Catalog and configuration
modules already own their SQLite transactions, so duplicating event writes in
every caller would make the audit contract shallow and easy to bypass.

## Decision

Schema v19 installs SQLite `AFTER INSERT`, `AFTER UPDATE`, and `AFTER DELETE`
triggers for Company Catalog, Skill, Pipeline configuration, and Position Skill
binding tables. Triggers append an ID-only audit payload and protocol-neutral
event in the same SQLite transaction as the mutation. Secret values and full
configuration payloads are never copied into the audit/outbox records.

## Consequences

- Every configuration mutation is observable through the same durable Runtime
  event stream used by Desktop, AG-UI, and ACP.
- Existing deep module interfaces remain unchanged and cannot accidentally omit
  the audit write.
- Historical migrations remain immutable; the trigger set is additive in v19.
- Consumers must filter the shared outbox by entity or Run when they need a
  focused view.
