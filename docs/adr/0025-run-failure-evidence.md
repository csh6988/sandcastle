# Structured run-failure evidence on the run-event stream

ADR 0021 introduced the **run event** stream and anticipated that "future
run-level signals can be added as new `RunEvent` variants without touching the
logging layers." Recovering a failed run — especially a multi-repository
**workflow board** task — needs more than the coarse `run-failed.message` text:
a user (or the board) wants to know _where_ the failure happened, whether a
worktree was preserved, where the **run log** lives, whether an agent
**session** was captured, whether commits were recorded, whether the
**completion signal** appeared, and whether the failure looks like
infrastructure trouble rather than task failure. Today that evidence is split
across thrown errors, run results, stderr, run logs, board progress, and
verification reports, so the recovery path is harder to trust than it should be.

We extend the existing `run-failed` **run event** with an optional, structured,
Effect-free `recovery` object (**run failure evidence**) and a stable **run
failure kind**. `run()` and the workspace runners populate it and still rethrow
the original error; board progress consumes it when present and falls back
safely when absent.

## Decisions

- **Additive on the existing seam, not a new mechanism.** We add an optional
  nested `recovery?` object to the existing `run-failed` variant rather than a
  new event type or a parallel observer/control-plane API. `message` and
  `timestamp` are unchanged; `recovery` is the anticipated additive path from
  ADR 0021, so this extends 0021 rather than contradicting it.
- **Observability/recovery metadata, not error handling.** The original error is
  still thrown from `run()` and the workspace runners, and
  `options.signal?.throwIfAborted()` still surfaces an abort reason verbatim.
  The event stream carries evidence Sandcastle already knows; it does not become
  a new way to signal or recover from failure.
- **Effect-free public types.** `RunFailureKind`
  (`infrastructure | agent | task | unknown`) and `RunFailureRecovery` are plain
  types exported from `src/index.ts`, so non-Effect/library callers can route
  infrastructure failures differently from agent or task failures. The
  public-type effect-free check (`check-public-types-effect-free.mjs`) still
  passes.
- **Every field optional; legacy events still render.** All recovery fields are
  optional and plain-serializable, so a minimal/legacy `run-failed` event
  (message-only) round-trips through the board store and renders without
  crashing. The store serializes any `RunEvent` generically, so no `BoardStore`
  change was needed.
- **Classification lives in one pure helper.** `src/RunFailureEvidence.ts`
  classifies a caught error into a kind/phase (from its `_tag`, then its `name`,
  then a message signal) and gathers evidence into the `recovery` object. Emit
  sites stay thin, and the logic is unit-tested without a real agent. The
  message-signal classifier (`isInfrastructureFailureMessage`) keeps the
  `infrastructure` decision consistent for consumers that only have a legacy
  message.
- **Board-specific wording stays in the board layer.** The core exposes generic
  evidence; `src/board/taskProgress.ts` projects it into task-recovery language
  (preserved worktree, run log, session, "claimed completion before failing").

## Considered alternatives

- **A new `run-recovery` event alongside `run-failed`.** Rejected: it splits the
  failure into two events consumers must correlate, and duplicates the
  `run-failed` timing. A nested optional object on the existing variant is
  simpler and matches ADR 0021's additive-variant guidance.
- **Return the evidence only on the thrown error / `RunResult`.** Rejected: the
  board and other non-Effect observers consume the event stream, not the throw;
  the evidence must be at the same public seam used by `run()`,
  `runWorkspace()`, `runWorkspaceTask()`, and the board.
- **Compute a rich `failurePhase` from orchestration state.** Deferred: the
  orchestrate error reaching `run()`'s catch is Effect-wrapped, so we read the
  unwrapped tagged error via a non-intrusive `tapError` and use a best-effort
  phase string. A precise per-step phase can be added later without changing the
  public shape.

## Consequences

Library consumers can branch on `recovery.failureKind` to treat infrastructure
failures differently from agent or task failures, and can surface the preserved
worktree, run log, and session for recovery. Board progress renders that
evidence in its recovery/next-step text and can tell whether the agent claimed
completion before failing, so infrastructure-capture warnings do not
incorrectly fail delivered work. Future evidence fields can be added as further
optional properties on `recovery` without breaking existing consumers.
