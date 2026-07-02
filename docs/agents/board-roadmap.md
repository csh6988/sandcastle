# Board Roadmap

Last updated: 2026-06-30

This document is the durable progress tracker for the **workflow board**. Keep
it current when changing Board planning, approval, execution, verification,
recovery, or artifact behavior.

## Current Checkpoint

The Board now supports PRD-driven interactive planning, importing an existing
`workspace-plan.json`, approving generated plans, executing approved plans as
AFK repository runs, verifying delivery, recovering failed execution, and
planning-only artifact export with Board-visible artifact manifests and
export-specific approval copy.

The current working tree already contains completed Board verification,
`board --plan-file`, `board --prd-file`, and `board --planning-only` changes.
Do not revert those dirty files while continuing this roadmap.

## Capability Status

| Area                                 | Status | Evidence                                                                                                                                       |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive Board phase workflow     | Done   | `src/board/langGraphTaskRunner.ts`, `src/board/terminalSession.ts`                                                                             |
| PRD startup task source              | Done   | `src/board/prdTask.ts`, `sandcastle board --prd-file`                                                                                          |
| Imported workspace plan approval     | Done   | `src/board/workspacePlanImport.ts`, `sandcastle board --plan-file`                                                                             |
| Board issue markdown artifacts       | Done   | `src/board/localIssueMarkdown.ts`, task issue files under `.sandcastle/board/tasks/<taskId>/issues/`                                           |
| Board execution progress document    | Done   | `src/board/taskProgress.ts`                                                                                                                    |
| Post-execution verification report   | Done   | `src/board/taskVerification.ts`, `verification.md`                                                                                             |
| Verification recovery prompt context | Done   | `src/board/langGraphTaskRunner.ts` reads progress and verification reports                                                                     |
| Planning-only artifact export        | Done   | `src/board/planningArtifacts.ts`, `sandcastle board --planning-only`                                                                           |
| Board artifact visibility in UI      | Done   | `.sandcastle/board/tasks/<taskId>/artifacts.json`, `GET /api/tasks/:id/artifacts`, task detail artifact list                                   |
| Planning-only specific approval copy | Done   | `BoardTaskWorkflow.approvedPlanAction` drives export-specific stage/button copy while reusing the same approval API                            |
| End-to-end artifact export coverage  | Done   | `src/board/langGraphTaskRunner.test.ts` drives planning-only approval and asserts exported files match `workspace plan` shape                  |
| Workflow module size reduction       | Done   | Approved-plan artifact export, imported-plan approval handling, and approved-plan execution/verification are isolated in focused Board modules |

## Optimization Queue

### P0 - Make Progress And Artifacts Visible

1. Add an artifact manifest for Board planning-only export. Done.
   - Suggested path: `.sandcastle/board/tasks/<taskId>/artifacts.json`.
   - Include artifact kind, absolute path, relative display path, and created
     timestamp.
   - Keep this independent from old `.scratch` issue import/back-write
     compatibility.

2. Expose task artifacts through the Board API. Done.
   - Suggested endpoint: `GET /api/tasks/:id/artifacts`.
   - Return planning artifacts and existing task-scoped artifacts
     (`progress.md`, `verification.md`, `issues/*.md`) when present.
   - Add `src/board/server.test.ts` or router tests.

3. Render artifacts in the Board detail view. Done.
   - Show links/paths for `workspace-plan.json`, `alignment.md`,
     `technical-plan.md`, and per-repository issues after planning-only export.
   - Also show progress and verification artifacts for execution tasks.
   - Keep the UI dense and operational; avoid marketing copy.

4. Make planning-only approval copy explicit. Done.
   - Approval button can remain the same API call, but the stage/control copy
     should say export, not AFK execution, when planning-only mode is active.
   - Persist enough task/workflow metadata to let the frontend derive this
     without guessing from CLI flags.

### P1 - Strengthen Verification Coverage

1. Add an integration-style test for planning-only export after approval.
   Done.
   - Create a Board task with a plan.
   - Resume approval in planning-only mode.
   - Assert exported files exist with the same shape as `workspace plan`.
   - Prefer a focused Board workflow test or router/server test over spawning a
     long-lived HTTP server.

2. Add a CLI test for `board --planning-only --help` and, if practical, a
   short startup-path test that does not start real agents. Done.
   - Current CLI coverage only proves option visibility.

3. Keep the required Board verification chain passing:

```bash
npx vitest run src/board/*.test.ts
npx vitest run src/cli.test.ts -t "board"
npm run typecheck
npm run format:check
```

### P2 - Reduce Workflow Runner Complexity

1. Extract approved-plan export into a small module. Done.
   - Candidate module: `src/board/approvedPlanExport.ts`.
   - Keep `langGraphTaskRunner.ts` responsible for workflow transitions, not file
     rendering or manifest details.

2. Extract imported-plan approval handling. Done.
   - Imported plan tasks enter at the normal file-backed approval state and are
     handled in `resume()`.
   - Keep the behavior, but isolate it behind a small pure function or helper
     with tests.

3. Extract verification execution transition. Done.
   - `executeApprovedPlan()` now handles retries, execution, verification,
     issue status sync, and task status updates.
   - Split only after artifact visibility work is stable.

### P3 - Improve Operational Robustness

1. Revisit LangGraph SQLite dependency packaging. Done.
   - ADR 0023 removes the LangGraph/SQLite checkpoint dependency from the Board
     workflow.
   - Future work can rename the legacy workflow runner seam once call sites no
     longer depend on the old name.

2. Add recovery checks for stale phase sessions and cancelled terminals. Done.
   - The current phase-session lifecycle works but the UI should make stale
     sessions easier to diagnose.

3. Add browser QA for Board detail view. Done.
   - Especially artifact list rendering, approval/export copy, and responsive
     task detail layout.

## Recent Verification

Last full verification for the current Board checkpoint:

```bash
npx vitest run src/board/*.test.ts
npx vitest run src/cli.test.ts -t "board"
npm run typecheck
npm run format:check
```

All commands passed on 2026-06-30.

## Browser QA Evidence

P3 browser QA passed on 2026-06-30 against a temporary local Board server seeded
with a planning-only approval task and exported artifact manifest:

- Desktop viewport: task detail rendered `Awaiting export approval`, `Export
artifacts`, and six artifact rows with no horizontal overflow.
- Mobile viewport `390x844`: task detail, export approval copy, and artifact
  rows rendered with no horizontal overflow.
- Console: 0 warnings/errors.
- Network: 0 failed requests and 0 HTTP 4xx/5xx responses. The SSE stream keeps
  the page from reaching Playwright `networkidle`, so the check used page `load`
  plus a settled delay.

## Next Recommended Task

Board roadmap P0-P3 is complete. Next work should come from a fresh roadmap or
from issues discovered during broader product hardening.
