# Company Shell And Role Profiles Split PRD

## Problem Statement

The snapshot contains a second work line that productizes the workflow board as
the Software R&D department inside a local company control plane and makes Board
role profiles explicit. This work is mixed with RuntimeEvent and desktop
changes. It needs a separate PR so reviewers can focus on the board product
surface, prompt boundaries, configuration, and HTTP API additions.

## Solution

Extract the company shell and role profile work into its own split after the
RuntimeEvent split. The embedded board remains the default dependency-free UI,
but gains a company-level navigation layer and role profile settings. Planner,
Generator, and Evaluator profiles become explicit configuration with built-in
defaults and partial local overrides.

This split should include the company projection, role profile loader/rendering,
board API endpoints, embedded frontend navigation/pages, CLI prompt injection,
tests, ADR, docs, and changesets. It should exclude the desktop app and any
RuntimeEvent-only refactor hunks already handled by the RuntimeEvent split.

## User Stories

1. As a board user, I want to open Sandcastle as a local company control plane,
   so that the board has a clear product home.
2. As a user, I want the board to land in the Software R&D department by
   default, so that the existing PRD-to-verification loop remains primary.
3. As a user, I want placeholder departments to be clearly inert, so that I do
   not mistake future departments for broken features.
4. As a user, I want a Projects page based on existing workspace config, so
   that I can see what repositories the department operates on.
5. As a user, I want company-wide Artifacts and Reviews pages, so that I can
   find generated outputs and verification-ready tasks across the board.
6. As a maintainer, I want Planner, Generator, and Evaluator role profiles
   explicit, so that prompt boundaries are configurable and reviewable.
7. As a board operator, I want `.sandcastle/role-profiles.json` partial
   overrides, so that local teams can tune role guidance without changing code.
8. As a user, I want invalid role profile config to fail fast, so that a board
   run does not silently ignore bad role boundaries.
9. As a reviewer, I want role profile agent/model preferences to stay advisory
   in v1, so that CLI flags remain the source of execution selection.

## Implementation Decisions

- Model company as a local product shell, not an enterprise organization,
  tenant, or access-control boundary.
- Model department as the execution unit. V1 ships exactly one operational
  department: Software R&D.
- Keep existing board task, run, store, file layout, and API semantics. Company
  framing is a shell over the board, not a storage rewrite.
- Serve company state as a projection from existing local state.
- Serve role profiles through a board API endpoint for the Settings view.
- Make role profile config a partial per-role JSON override under the
  `.sandcastle` config root.
- Render resolved role profiles into Planner phase prompts, Generator execution
  prompts, and Evaluator verification prompts.
- Keep skill flows progressive: profiles name focused flows, but prompts must
  reject copying every installed skill into every invocation.
- Keep non-operational departments as inert placeholders with no workflow,
  storage, or execution API.
- Keep desktop-specific project workbench behavior out of this split.

## Testing Decisions

- Test company projection without requiring a real board server.
- Test role profile defaults, partial overrides, invalid config failure, and
  prompt rendering.
- Test board router endpoints for company, role profiles, artifacts, and
  reviews through the existing route API seam.
- Test embedded frontend output for the company navigation and default Software
  R&D department shell at the server boundary.
- Test CLI prompt builders for Planner and Generator role profile boundaries.
- Use existing board store and CLI prompt helper seams. Do not run real agents.

## Acceptance Criteria

- The embedded board exposes company navigation with Departments, Projects,
  Artifacts, Reviews, and Settings.
- Opening the board defaults to the Software R&D department.
- Company, role profile, artifact, and review endpoints are covered by tests.
- Role profile defaults cover Planner, Generator, and Evaluator.
- Partial local overrides merge with defaults and invalid config fails fast.
- Planner, Generator, and Evaluator prompts include the resolved role profile
  section.
- Role profile docs, glossary terms, ADR, and changesets are consistent.
- Verification passes:

```bash
npx vitest run src/board/company.test.ts src/board/roleProfiles.test.ts src/board/server.test.ts src/cli.test.ts
npm run typecheck
npm run format:check
```

## Out of Scope

- No Desktop app.
- No CopilotKit or React shell in the published package.
- No new organization chart, reporting line, chat, calendar, budget, or access
  control model.
- No new generic department SDK.
- No change to board task storage or existing board workflow semantics.
- No RuntimeEvent public API work beyond consuming the already-landed event
  model.

## Further Notes

Mixed files need hunk-level handling:

- In CLI code, include role profile imports, loading, prompt rendering, and
  role profile server option.
- In CLI tests, include role profile prompt tests.
- In embedded board HTML, include company navigation, company pages, settings,
  and related API calls.
- In board server tests, include company, artifacts, reviews, role profiles,
  and company shell HTML assertions.
- In docs, include company and role profile language, not desktop-specific
  product workbench language unless needed for ADR sequencing.
