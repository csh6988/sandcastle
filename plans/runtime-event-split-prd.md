# RuntimeEvent Split PRD

## Problem Statement

Sandcastle currently has a completed RuntimeEvent refactor mixed with unrelated
company, role profile, and desktop work. The user needs RuntimeEvent to land as
its own coherent PR: RuntimeEvent becomes the single structured core event
model, legacy RunEvent and onRunEvent compatibility are removed, AG-UI adapter
support is added, and the workflow board consumes the new event names.

Mixing this with company shell or desktop work makes the API review harder and
raises the risk of shipping unrelated product surface in the same release.

## Solution

Extract a RuntimeEvent-only split from the snapshot. The split should include
the core event model, public exports, callback renames, board event consumers,
AG-UI adapter, tests, docs, ADR, and changeset. It should exclude role profile
prompting, company navigation/pages, company APIs, desktop app files, and broad
planning docs unless the hunk directly documents RuntimeEvent behavior.

RuntimeEvent should be the only structured core event model. External protocols
consume it through adapters such as the AG-UI adapter; future ACP work remains a
facade boundary and is not implemented here.

## User Stories

1. As a library consumer, I want one stable runtime event model, so that I do
   not need to choose between RunEvent and RuntimeEvent.
2. As a caller of `run`, I want `events.onRuntimeEvent`, so that protocol
   adapters and observability sinks can consume structured runtime events.
3. As a workspace runner caller, I want repository and planner callbacks named
   around runtime events, so that the API vocabulary is consistent.
4. As a board user, I want the board to keep recording runs and usage after the
   event rename, so that existing board workflows still work.
5. As an AG-UI integration author, I want a small adapter from RuntimeEvent to
   AG-UI-style events, so that frontend event streams do not depend on
   Sandcastle internals.
6. As a maintainer, I want RunEvent removed rather than maintained as a legacy
   alias, so that the codebase has one event vocabulary.
7. As a documentation reader, I want README, docs, glossary, and ADR language
   to use RuntimeEvent consistently, so that public API guidance matches code.
8. As a release manager, I want a dedicated changeset for this public API
   change, so that release notes are accurate.

## Implementation Decisions

- Introduce `RuntimeEvent` as the plain, Effect-free discriminated union for
  structured runtime events.
- Use dotted event names such as `run.started`, `iteration.started`,
  `message.delta`, `tool.call`, `tool.result`, `raw`, `usage.recorded`,
  `commit.created`, `run.finished`, and `run.error`.
- Correlate all events with a stable `runId`.
- Replace `onRunEvent` with `events.onRuntimeEvent` on run and workspace
  surfaces.
- Replace workspace task callbacks with runtime-event names for repository and
  planner streams.
- Preserve callback fault isolation: thrown or rejected observer errors must not
  abort a run.
- Remove the legacy `RunEvent` module and public export.
- Export the AG-UI adapter and AG-UI event type from the public barrel.
- Keep AG-UI as an adapter output only. Do not make AG-UI or ACP the core event
  model.
- Keep company shell, role profile, and desktop behavior out of this split.

## Testing Decisions

- Test through public run and workspace seams, not private emit helpers.
- Keep fake sandbox and fake agent tests; do not require real agents or real
  sandbox providers.
- Cover both logging modes for `events.onRuntimeEvent`.
- Cover observer errors and rejected observer promises being swallowed.
- Cover board storage and projection of renamed event types.
- Cover AG-UI adapter mappings for lifecycle, text, tool, usage, commit, raw,
  and error events.
- Cover failure recovery evidence flowing on `run.error`.

## Acceptance Criteria

- `RunEvent` and `onRunEvent` are no longer part of the public API.
- `RuntimeEvent`, `RuntimeEventHandler`, failure evidence types, and the AG-UI
  adapter are exported intentionally.
- Board run recording, progress, verification, usage aggregation, and SSE
  updates work with RuntimeEvent names.
- RuntimeEvent docs and ADRs are consistent.
- The RuntimeEvent changeset describes the API break/new adapter clearly.
- Verification passes:

```bash
npm run typecheck
npm run test
npm run format:check
npm run build
```

## Out of Scope

- No company control plane shell.
- No role profile configuration or prompt injection.
- No desktop app.
- No CopilotKit integration.
- No ACP network transport implementation.
- No generated artifacts or screenshots.

## Further Notes

Mixed files need hunk-level handling:

- In CLI code, keep runtime callback/API renames and exclude role profile
  loading/prompting.
- In embedded board HTML, keep event display and event kind renames and exclude
  company navigation/pages.
- In board server tests, keep runtime event expectations and exclude company,
  artifact, review, and role profile endpoint tests.
- In docs and glossary, keep RuntimeEvent/AG-UI/ACP text and exclude broad
  company/desktop vocabulary.
