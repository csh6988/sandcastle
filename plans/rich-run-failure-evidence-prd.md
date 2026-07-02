# Rich Run Failure Evidence For Recovery

## Problem Statement

When a Sandcastle agent run fails, callers and the workflow board only receive
coarse failure text. A user trying to recover a failed task needs structured
evidence: where the failure happened, whether a worktree was preserved, where
the run log lives, whether an agent session was captured, whether commits were
recorded, whether the completion signal appeared, and whether the failure looks
like infrastructure trouble rather than task failure.

Today that evidence is split across thrown errors, run results, stderr, run
logs, Board progress, and verification reports. The recovery path is harder to
trust than it should be, especially for multi-repository Board tasks.

## Solution

Extend the existing run-event stream so failed and completed runs can carry
structured, Effect-free recovery evidence. Board progress and verification
should consume that evidence when available, while staying compatible with older
minimal run events.

This should not replace existing errors, logs, or verification reports. It
should make the recovery evidence already known by Sandcastle available at the
same public seam used by `run()`, `runWorkspace()`, `runWorkspaceTask()`, and
the workflow board.

## User Stories

1. As a Sandcastle CLI user, I want a failed run to tell me whether a worktree
   was preserved, so that I know where to inspect or continue.
2. As a workflow board user, I want failed repository runs to show structured
   recovery evidence, so that I can resume the right task without reading raw
   logs first.
3. As a library consumer, I want `run-failed` events to include a stable failure
   kind, so that I can route infrastructure failures differently from agent or
   task failures.
4. As a Board evaluator, I want verification to know whether the agent claimed
   completion before failing, so that infrastructure capture warnings do not
   incorrectly fail delivered work.
5. As a user recovering a task, I want the latest run log and session
   identifiers surfaced, so that I can inspect the exact context used by the
   agent.
6. As a workspace runner consumer, I want per-repository failure evidence to
   flow through the existing repository event callback, so that multi-repository
   tasks can recover only the failed repositories.
7. As a maintainer, I want the public event type to remain Effect-free, so that
   frontend and non-Effect callers can consume it.
8. As a test author, I want this behavior verified through public run,
   workspace, and Board seams, so that tests do not depend on private
   implementation details.

## Implementation Decisions

- Extend the existing run-event stream rather than adding another observer API.
- Keep the existing `run-failed.message` behavior compatible; add optional
  structured fields instead of replacing the current field.
- Add recovery evidence as plain serializable data, such as failure kind,
  failure phase, preserved worktree path, run log path, session id, session file
  path, completion signal state, and commit evidence when known.
- Preserve existing error throwing behavior. The event stream is observability
  and recovery metadata, not a new error-handling mechanism.
- Forward richer failure events through workspace and workspace-task repository
  callbacks without changing sandbox provider injection.
- Let Board progress and verification consume the new fields when present, while
  staying compatible with minimal historical `run-failed` events.
- Keep Board-specific recovery wording outside the orchestration core. The core
  should expose generic run evidence; Board should project it into task recovery
  language.

## Testing Decisions

- Test behavior through public APIs: `run`, workspace task execution callbacks,
  and Board progress or verification projection.
- Add a focused `run()` test where an agent failure emits `run-failed` with
  structured recovery evidence and still rethrows.
- Add a workspace task test proving per-repository failure evidence is tagged
  with the repository and reaches the existing callback.
- Add a Board progress or verification test proving preserved worktree, session,
  or run log evidence appears in recovery text when available.
- Keep tests using fake sandbox and fake agent seams; do not require Docker,
  Podman, or real agent execution.
- Include a compatibility test where a minimal legacy `run-failed` event still
  renders without crashing.

## Acceptance Criteria

- `run-failed` keeps its current `message` field and adds optional structured
  recovery evidence.
- `run()` emits richer `run-failed` evidence and still rethrows the original
  error.
- Workspace task per-repository callbacks receive the richer failure evidence.
- Board progress or verification renders preserved worktree, session, or run
  log evidence when present.
- Minimal legacy `run-failed` events still render safely.
- Public types remain Effect-free.
- Tests use fake sandbox and agent seams and do not require Docker, Podman, or
  real agents.

## Out of Scope

- No Board UI redesign.
- No new database or storage backend.
- No automatic recovery execution.
- No branch strategy semantic changes.
- No remote service, login, or telemetry upload.
- No provider-specific coupling in the orchestration core.

## Further Notes

This work should use the `RunEvent` seam described in ADR 0021. The goal is to
make Board recovery and library observability stronger without creating a
parallel control-plane model.
