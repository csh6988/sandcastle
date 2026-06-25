# Run-event stream: a logging-mode-independent observability seam

Sandcastle's progress and agent output have historically been observable in two
ways only: the `Display` layer (an interactive terminal UI or an appended log
file) and the `AgentStreamEvent` callback. The callback is the single
programmatic, structured feed of agent activity, but it is wired **only in
log-to-file mode** (`run()` builds it from `logging.onAgentStreamEvent`), it
carries agent stdout activity only (`text` / `toolCall` / `raw`), and it omits
run lifecycle (start/finish/failure), iteration boundaries, token `usage`, and
commits. Anything wanting to render a run — for example a workflow board — had
to either parse the human-readable log file or fork the orchestration core.

We add a **run-event stream**: a single discriminated-union `RunEvent` type and
an Effect service seam (`RunEventEmitter`) that the orchestration core emits to.
`run()` exposes it through a new top-level `onRunEvent` callback that works in
**both** logging modes, decoupling structured observability from where
human-readable output happens to go. The stream covers the full shape a
consumer needs: `run-started` / `run-finished` / `run-failed`, `iteration-started`,
`agent-text`, `agent-tool-call`, `usage` (carrying the agent model name), and
`commit`.

## Decisions

- **Additive, not a replacement.** `AgentStreamEvent` and
  `logging.onAgentStreamEvent` keep their exact current behavior. `RunEvent` is
  a superset feed on a separate seam, so existing forwarders are untouched.
- **Optional service, no new hard requirement.** The orchestrator reads the
  emitter via `Effect.serviceOption(RunEventEmitter)`, so the emitter is used
  when provided and silently absent otherwise. This keeps `orchestrate`'s
  requirement channel unchanged and means existing tests and call sites need no
  edits.
- **Effect-free public types.** `RunEvent` is a plain discriminated union with
  no Effect types, so it can be exported from `src/index.ts` and consumed by a
  non-Effect host (the board server) without violating the public-type
  effect-free constraint.
- **Model on the provider.** `AgentProvider` gains an optional `model` field so
  `usage` events can attribute tokens per model. It is optional to avoid
  breaking test fakes and third-party providers; consumers fall back to the
  provider `name` when it is absent.
- **Callback errors are swallowed.** Like `AgentStreamEmitter`, a thrown error
  in `onRunEvent` is caught and discarded — a broken observer must never kill a
  run.

## Considered alternatives

- **Extend `AgentStreamEvent` in place and make it work in stdout mode.**
  Rejected: it would change the meaning of an existing public type and its
  file-mode-only contract, and it has no natural place for run lifecycle,
  iteration, or commit events.
- **Make `RunEventEmitter` a required service on `orchestrate`.** Rejected: it
  would force every existing test and internal caller to provide a layer.
  `serviceOption` gives the same emit points with zero blast radius.

## Consequences

The board (persistence + HTTP/SSE server) consumes `onRunEvent` to record and
stream runs without parsing logs or importing Effect. Future run-level signals
(e.g. structured-output extraction, retries) can be added as new `RunEvent`
variants without touching the logging layers.
