# Runtime events, AG-UI adapter, and ACP facade boundary

Sandcastle phase two needs protocol integrations without coupling the core
`run()` flow to any one external protocol. AG-UI is useful for live web UI
rendering, while ACP is a broader Agent Runtime protocol boundary. Treating
either protocol as the core event model would make future orchestration changes
depend on transport-specific schemas.

## Decision

Sandcastle core emits a stable internal **runtime event** stream with dotted
event names such as `run.started`, `iteration.started`, `message.delta`,
`tool.call`, `raw`, `commit.created`, `run.finished`, and `run.error`.
Protocol integrations consume this internal stream through adapters:

- **AG-UI adapter** maps runtime events to AG-UI-style event names such as
  `RUN_STARTED`, `STEP_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`,
  `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `RAW`, and custom
  `sandcastle.commits.created` events.
- **ACP facade** will wrap Sandcastle as an external Agent Runtime boundary,
  rather than rewriting `run()` around ACP.
- Existing `logging.onAgentStreamEvent` remains a narrow raw/agent-output
  compatibility surface. Runtime events are the single structured core event
  model for Sandcastle and the workflow board.

`run()` exposes the new stream with:

```ts
events: {
  onRuntimeEvent(event) {
    // forward to AG-UI, ACP facade, logs, or observability
  },
}
```

Observer errors and rejected promises are swallowed, so protocol adapters cannot
interrupt the agent workflow.

## ACP facade sketch

The ACP facade is intentionally not implemented as a network server in this
change. The future mapping should be:

| ACP method                   | Sandcastle mapping                                     |
| ---------------------------- | ------------------------------------------------------ |
| `initialize`                 | Return Sandcastle capabilities and supported providers |
| `session/new`                | `createSandbox()` or prepare a sandbox-backed session  |
| `session/prompt`             | `sandbox.run()` / `run()` with `events.onRuntimeEvent` |
| `session/cancel`             | `AbortController.abort()` for the active run           |
| `session/update`             | Stream `RuntimeEvent` values through the ACP transport |
| `session/request_permission` | Future approval / confirmation adapter before commands |

The facade should own transport, request correlation, permissions, and external
session shape. Sandcastle core should continue to own sandbox lifecycle,
branch strategy, agent invocation, commits, completion signals, and structured
output.

## Consequences

The first protocol integration target is AG-UI because it is a thin event
mapping and immediately useful for frontends. ACP remains a wrapper design until
there is a concrete host integration that justifies a transport implementation.
