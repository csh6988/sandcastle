# Desktop IPC and Runtime Event stream

The Desktop renderer reaches Company Runtime through one schema-validated
Electron tunnel. The canonical preload interface is:

- `execute` for verified Command envelopes;
- `query` for verified Query envelopes;
- `openEventStream` for the MessagePort Runtime Event stream;
- `closeEventStream` for the callback barrier and generation-fenced close.

Legacy preload methods remain migration adapters for renderer paths that have
not moved yet. They must not introduce new Electron channels. The migrated
`project.inspect` and `project.update` adapters call the canonical tunnel.
Execution recovery uses that same tunnel: `run.inspect` includes the immutable
Continuation Plan, while `execution.inspect` returns the fenced Lease and Fact
evidence for one Node Attempt or standalone Interaction Turn. Neither query
grants Adapter, filesystem, Sandbox, Worktree, Tool, or Permission capability.

## Trusted context

Renderer payloads never carry trusted actor, principal, or consumer identity.
Electron main injects the authenticated `electron-main` principal and the
Desktop-process consumer ID before calling Company Runtime. Company Runtime
continues to authenticate the local IPC token and owns the durable cursor.

The tunnel accepts only the registered BrowserWindow's current main frame at
the exact configured renderer origin. It rejects subframes, stale senders,
wrong origins, unknown schema fields, unsupported schema versions, and payloads
over the configured byte limit.

## MessagePort lifecycle

Each frame contains the Runtime subscription ID, subscription generation,
barrier sequence, and one event or transport control value. Main and preload
both discard frames whose generation is not current.

Preload grants one credit only after the previous renderer callback settles.
Main never reads or forwards more events than the bounded credit window. This
pauses delivery under renderer backpressure without dropping durable state
events.

`closeEventStream` first invalidates the preload generation, stops granting
credit, waits for the active callback, and only then asks main to close the
matching Runtime subscription. A stale close cannot affect a newer generation.
Navigation, renderer loss, reload, and BrowserWindow destruction revoke the
old main-side Port before it can deliver another frame.

## Reload and disconnect recovery

Renderer recovery follows one order:

1. close the old stream and wait for its callback barrier;
2. query an authoritative View and apply it;
3. execute `ack-runtime-events` with the one-time View-sync token;
4. open a new event stream and accept only its generation;
5. apply replayed events above the returned barrier sequence and acknowledge
   only the highest contiguous sequence.

If Runtime disconnects, main sends a bounded `runtime.disconnected` control
frame and closes the Port. The renderer repeats the same View-sync recovery
before reopening.
