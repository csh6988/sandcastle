# Mixed Worktree Split And Landing PRD

## Problem Statement

The current release snapshot branch contains multiple finished or partially
finished work lines in one commit: the RuntimeEvent refactor, company control
plane shell, role profiles, desktop shell, and planning documents. A later
agent needs to split this safely into reviewable PRs without losing user work,
committing generated artifacts, or mixing unrelated product decisions into the
RuntimeEvent release.

The immediate user need is an operational plan that can be followed one split at
a time from the release snapshot.

## Solution

Use the release snapshot as a preservation point, then create focused branches
or commits from it for each work line. RuntimeEvent should land first because it
is the core API and event-model rename. Company and role profile work should
land second because it builds on the board and CLI prompts. Desktop should land
third because it is an optional app boundary with its own package and generated
artifact risk. Broad roadmap and planning prose should land separately when it
does not describe shipped behavior in the same PR.

Each split must be made with hunk-level review for mixed files. The next agent
must not use destructive checkout/reset/clean commands against user work.

## User Stories

1. As a maintainer, I want the mixed worktree split into focused PRs, so that
   each review has a clear behavioral scope.
2. As a reviewer, I want RuntimeEvent changes separated from company and
   desktop changes, so that I can evaluate the public API refactor without UI
   or product shell noise.
3. As a later agent, I want exact file and hunk boundaries, so that I can stage
   the right changes without guessing.
4. As a user, I want the current snapshot preserved, so that no existing dirty
   work is lost while the split happens.
5. As a maintainer, I want generated artifacts excluded, so that release PRs do
   not carry local build output or large screenshots by accident.
6. As a release manager, I want verification commands per split, so that each
   PR has evidence matched to its blast radius.
7. As a documentation reviewer, I want roadmap-only prose separated from code
   PRs, so that shipped behavior and future direction are not conflated.
8. As a package maintainer, I want changesets assigned to the correct split, so
   that release notes match the code that actually lands.

## Implementation Decisions

- Treat the release snapshot branch as the source of truth for the preserved
  mixed state.
- Create one focused branch or commit for each work line:
  RuntimeEvent, Company/RoleProfiles, Desktop, and optional planning/docs.
- Use hunk-level staging for mixed files rather than whole-file staging.
- Keep the RuntimeEvent split limited to the core runtime event model, AG-UI
  adapter, callback renames, board event consumers, and RuntimeEvent docs.
- Keep Company/RoleProfiles limited to company endpoints, role profile config,
  embedded company shell UI, role prompt injection, and related docs.
- Keep Desktop limited to the Electron app, desktop-specific ADR/PRD, and
  desktop build ignore rules.
- Keep broad decision maps and roadmap rewrites in a docs/planning split unless
  a paragraph is required to document a shipped behavior in the same PR.
- Do not stage generated output, desktop `node_modules`, desktop release
  output, or desktop QA screenshots without explicit user confirmation.

## Testing Decisions

- RuntimeEvent split must run the full root verification chain because it
  changes public API, board event consumers, and build-time public type checks.
- Company/RoleProfiles split should run focused board and CLI tests first, then
  root typecheck and format check.
- Desktop split should run the desktop app's own tests, typecheck, and build
  from its package directory.
- Planning/docs split normally needs format check only unless it edits code or
  package metadata.
- Tests should use existing fake sandbox, fake agent, board store, and HTTP
  router seams. Do not require Docker, Podman, Vercel, real agents, or desktop
  packaging.

## Acceptance Criteria

- RuntimeEvent, Company/RoleProfiles, Desktop, and planning/docs can each be
  reviewed independently.
- Mixed files are split by intent, not by filename alone.
- No generated artifacts, local dependency directories, secrets, or unrelated
  dirty work are committed.
- Each split has its own changeset/docs ownership.
- Each split has documented verification commands and results before delivery.
- The release snapshot remains available as a fallback preservation point.

## Out of Scope

- No implementation changes beyond splitting existing work.
- No redesign of RuntimeEvent, company shell, role profiles, or desktop product
  behavior during the split.
- No destructive git cleanup.
- No publishing to npm or creating a release.
- No committing desktop QA screenshots unless the user explicitly asks.

## Further Notes

Safe inspection commands for the next agent:

```bash
git status --short --untracked-files=all
git diff --name-status
git diff --stat
git diff -- src/cli.ts src/cli.test.ts src/board/frontendHtml.ts src/board/server.test.ts
```

When in doubt, ask the user before including screenshots, broad planning docs,
or desktop release artifacts.
