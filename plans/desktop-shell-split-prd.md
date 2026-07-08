# Desktop Shell Split PRD

## Problem Statement

The snapshot contains an Electron desktop shell under `apps/desktop` plus
desktop-specific ADR and PRD material. This work is distinct from the root
library, CLI, and embedded board. It needs to land separately so reviewers can
evaluate packaging, app boundaries, local company directory behavior, project
workbench behavior, and generated artifact risk without mixing those concerns
into RuntimeEvent or board company-shell PRs.

## Solution

Extract Desktop into its own split after RuntimeEvent and Company/RoleProfiles.
The desktop app remains an optional app boundary with its own package, scripts,
tests, and build. It must not leak Electron, React, desktop dependencies, or
desktop generated output into the root published library package.

Desktop v1 is project-first and deterministic. It selects a local AI company
directory, stores company/project data under that directory, supervises board
processes only for R&D execution, and uses existing board endpoints for
orchestration actions. It does not own orchestration semantics and does not add
CopilotKit or default LLM activity.

## User Stories

1. As a desktop user, I want to select or create a local AI company directory,
   so that project data has a clear local home.
2. As a user, I want Projects to be the first desktop surface, so that delivery
   work is organized around PRD, design, R&D execution, review, and artifacts.
3. As a user, I want repositories linked as R&D resources, so that source code
   stays in place and is not copied into the project directory.
4. As a user, I want project data stored in the company directory, so that
   Electron userData only contains personal preferences.
5. As a maintainer, I want Desktop to supervise board processes for R&D only,
   so that orchestration remains owned by the board and core library.
6. As a user, I want the desktop shell server to proxy board APIs and terminal
   WebSockets, so that the renderer can use existing board actions.
7. As a user, I want native notifications for board state changes, so that long
   running R&D execution is visible outside the browser.
8. As a maintainer, I want Desktop dependencies isolated from the root package,
   so that npm publishing remains library-only.
9. As a reviewer, I want generated desktop build output and screenshots kept
   out by default, so that the PR stays auditable.

## Implementation Decisions

- Keep Desktop in `apps/desktop` with its own package metadata, TypeScript
  configs, Vite config, tests, and build scripts.
- Keep root package publishing unchanged; Desktop is not part of the root
  library package.
- Make Desktop project-first rather than repository-first.
- Store company-owned project data under the selected local AI company
  directory.
- Use Electron userData only for personal preferences such as language, last
  opened project, and window state.
- Spawn or supervise `sandcastle board` only when R&D execution needs an active
  board process.
- Proxy existing board HTTP APIs and terminal WebSockets rather than rewriting
  board semantics.
- Keep Desktop deterministic in v1: no Copilot sidebar, no CopilotKit runtime,
  no default LLM token consumption, and no assistant entry point.
- Keep generated outputs, desktop release products, local dependency
  directories, and QA screenshots out unless explicitly approved.

## Testing Decisions

- Use Desktop's package-level tests for main-process stores, config,
  shell-server behavior, renderer view models, and markdown preview behavior.
- Use Desktop's package-level typecheck to cover renderer and main process
  TypeScript configs.
- Use Desktop's package-level build to cover Vite renderer output and main
  process compilation.
- Do not run Electron packaging by default; packaging/signing is outside this
  split unless the user explicitly asks.
- Do not require a real board process for unit tests when a fake or local seam
  is available.

## Acceptance Criteria

- Desktop app source, tests, configs, package lock, README, and desktop ADR/PRD
  land in a dedicated split.
- Root library package does not gain Electron, React, or Desktop runtime
  dependencies.
- Root published files policy remains library-only.
- Desktop generated output, release output, dependency directories, and QA
  screenshots are not committed by default.
- Desktop verification passes:

```bash
cd apps/desktop
npm run test
npm run typecheck
npm run build
```

- If root docs or ignore files are edited, root format verification also
  passes:

```bash
cd /Users/chenshaohui/IdeaProjects/sandcastle
npm run format:check
```

## Out of Scope

- No RuntimeEvent API refactor.
- No company shell or role profile behavior in the embedded board beyond the
  already-landed dependency it consumes.
- No CopilotKit runtime.
- No installer, code signing, auto-update, or cross-platform packaging release.
- No committing QA screenshots unless explicitly requested.
- No new orchestration semantics or board endpoint rewrites.

## Further Notes

The existing `plans/desktop-shell-ux-refresh-prd.md` describes product behavior.
This split PRD describes how to land the Desktop work safely as a repository
change. A later agent should keep those two documents aligned if Desktop
behavior changes during implementation.
