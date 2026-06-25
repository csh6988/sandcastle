# AGENTS.md

## Project Skill Activation

This project uses the shared Node/TypeScript profile: `node-typescript`.

For most tasks, start requirement clarification from `grill-with-docs` and
implementation from `tdd`. This file is the project-specific source of truth for
`sandcastle`; when it is stricter than a generic skill about clarification,
artifacts, verification, or delivery gates, follow this file.

Do not read every installed skill during a task. Use only skills active in the
current profile, or skills explicitly named by the user in the current task.

Active skills (the `node-typescript` profile):

| Skill                           | When to use                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `grill-with-docs`               | Clarify a Medium/Large task; produces ADRs + glossary entries as terms/decisions resolve |
| `domain-modeling`               | Maintain `CONTEXT.md` vocabulary when introducing or renaming a concept                  |
| `codebase-design`               | Design deep modules behind small interfaces (the Effect core, new providers)             |
| `decision-mapping`              | Capture a durable trade-off as an ADR in `docs/adr/`                                     |
| `tdd`                           | Build a feature or fix a bug test-first with co-located `*.test.ts`                      |
| `diagnosing-bugs`               | Reproduce and isolate a bug before changing code                                         |
| `improve-codebase-architecture` | Plan a larger refactor or architectural improvement                                      |
| `review`                        | Review a change before delivery / merge                                                  |
| `resolving-merge-conflicts`     | Resolve conflicts (worktree / merge-to-head work)                                        |
| `to-prd`                        | Turn a rough idea into a PRD                                                             |
| `to-issues`                     | Turn a PRD or request into GitHub issues                                                 |
| `triage`                        | Triage GitHub issues and external PRs                                                    |
| `setup-matt-pocock-skills`      | One-time setup of the shared skill toolchain                                             |
| `grilling`                      | Standalone relentless clarification interview (also used by `grill-with-docs`)           |
| `handoff`                       | Hand a task to another agent or session                                                  |

`karpathy-guidelines` is embedded in the global Codex AGENTS instructions and
must not be used as a project skill.

There is no Java-style senior-engineer hard gate in this repo. The delivery gate
is the verification chain in the "Delivery Gate" section below
(`typecheck` + `test` + `format:check` + changeset) plus ADR and `CONTEXT.md`
discipline. `CONTEXT.md` is the canonical glossary and overrides any synonym a
generic skill might introduce.

## Project Structure And Boundaries

`sandcastle` is a TypeScript ESM library and CLI that orchestrates an **agent**
inside a **sandbox**. It is built with `tsup`, type-checked with `tsgo`, and
tested with `vitest`. Source lives in a mostly flat `src/` with co-located
tests.

- `src/` — library and CLI source. Tests are co-located as `*.test.ts` next to
  the file under test (e.g. `run.ts` + `run.test.ts`). Windows-path behavior is
  isolated in `*.windowsPath.test.ts` / `*-windowsMounts.test.ts`.
- `src/index.ts` — the public API barrel. Anything exported here is part of the
  package's public surface; treat changes to it as contract changes.
- `src/sandboxes/` — built-in **sandbox provider** implementations (`docker`,
  `podman`, `vercel`, `daytona`, `no-sandbox`). Each is also a published
  subpath export in `package.json#exports`.
- `src/templates/` — scaffold templates copied verbatim into a user repo during
  **init**. Templates must stay self-contained (see ADR `0009`); do not import
  shared repo code into a template.
- `src/cli.ts` / `src/main.ts` — CLI entry (`bin: sandcastle`).
- `.sandcastle/` — this repo's own dogfooding config (Dockerfile, runners,
  `.env.example`). Not shipped to npm.
- `docs/adr/` — Architecture Decision Records, the durable decision log.
- `docs/agents/` — agent-facing operating docs (issue tracker, triage labels,
  domain docs, provider/tracker extension guides).
- `docs/` (the `app/`, `content/`, etc. subtree) — the documentation site
  (separate `package.json`).
- `CONTEXT.md` — the project glossary / ubiquitous language.

Only `dist/` is published (`package.json#files`). Repo meta files
(`AGENTS.md`, `CLAUDE.md`, `docs/`, `.sandcastle/`) are not shipped.

## Task Classification

Classify every task first, then choose the workflow depth.

### Small Change

Use this path for:

- Single-point bugs
- Logging, small config, copy, or comment changes
- Changes that do not alter the public API surface (`src/index.ts` / subpath
  exports)
- Changes that do not alter a domain concept in `CONTEXT.md`
- Changes that do not change a documented ADR decision
- Changes confined to one module and its co-located test

Workflow:

1. Locate the relevant code
2. Make the smallest safe change
3. Add or update the co-located `*.test.ts` when behavior changes
4. Run the narrowest useful verification, then `npm run typecheck`
5. Report the delivery result

Small changes do not require ADRs or full TDD ceremony, but changed behavior
must still be covered by a co-located test and pass `typecheck`.

### Medium Change

Use this path for:

- New or changed public API (`run`, `interactive`, `createSandbox`,
  `createWorktree`, provider factories, `Output`, etc.)
- A new behavior branch in an existing **sandbox provider**, **agent provider**,
  or **issue tracker**
- Changes to timeout, completion-signal, structured-output, or session
  resume/fork behavior
- Changes that touch templates, init scaffolding, or cross-module flows

Workflow:

1. Use `grill-with-docs` to clarify requirements, acceptance criteria, domain
   terms, and flow boundaries before planning or coding
2. Confirm unresolved questions are answered by the user, answered by local
   evidence, or explicitly marked as blockers
3. Use `tdd` — write a failing co-located test first, then minimal code
4. Keep `CONTEXT.md` vocabulary; add a term if you introduce a new concept
5. Add a changeset under `.changeset/` for any user-facing change
6. Run targeted `vitest` for the touched files, then `typecheck` and
   `format:check`
7. Self-check public-API stability and cross-provider consistency

### Large Change

Use this path for:

- New **sandbox provider**, **agent provider**, or **issue tracker**
- Changes to core orchestration (`Orchestrator`, `run`, `interactive`,
  `SandboxLifecycle`, `WorktreeManager`, sync in/out)
- Changes to **branch strategy** semantics, worktree mounting, or session
  storage contracts
- Changes with cross-platform (Windows path/mount) risk or compatibility risk
- Changes that affect multiple subpath exports at once

Workflow:

1. Use `grill-with-docs` to clarify goals, non-goals, terms, main flow,
   exception flow, and acceptance criteria before planning or coding
2. Confirm unresolved questions are answered by the user, answered by local
   evidence, or explicitly marked as blockers
3. Use `codebase-design` / `domain-modeling` for the design when relevant; aim
   for deep modules behind small interfaces
4. Record durable trade-offs as an ADR in `docs/adr/` (use `decision-mapping`)
5. When adding a provider or tracker, follow the matching guide in
   `docs/agents/` (`adding-an-agent-provider.md`,
   `adding-an-issue-tracker.md`)
6. Implement by vertical slice with TDD; keep Windows-path behavior tested
7. Run the full test suite plus `typecheck` and `format:check`
8. Update `README.md`, `CONTEXT.md`, and the docs site when behavior or
   vocabulary changes
9. Use `handoff` when another agent or session must continue the work

## Requirement Clarification

Medium and Large tasks must start with `grill-with-docs`. Do only enough local
exploration to avoid asking questions already answered by repository evidence
(`CONTEXT.md`, ADRs, existing tests), then ask the user one clarification
question at a time. Do not create or update implementation plans, ADRs, tests,
or production code until the first grill question has been answered.

Medium and Large tasks must clarify:

- Goal and non-goals
- Key domain terms (and whether they already exist in `CONTEXT.md`)
- Main flow and exception flow
- Public API shape (inputs, outputs, error types)
- Behavior across **bind-mount**, **isolated**, and **no-sandbox** providers
- Behavior across **branch strategies** (head / merge-to-head / branch)
- Timeout, completion-signal, and session resume/fork implications
- Acceptance criteria
- Unknowns and risks (especially cross-platform)

If domain terms, the public API, or flow boundaries are unclear, clarify them
before coding.

## Architecture And Domain Rules

When a task touches design:

- Keep providers pluggable. A **sandbox provider**, **agent provider**, and
  **issue tracker** are injected, not hardcoded; do not couple orchestration to
  a specific provider.
- Prefer deep modules: small public interface, substantial private
  implementation. New surface area in `src/index.ts` should be deliberate.
- Use the project's Effect-based service seams (e.g. the **agent invoker**) so
  tests can substitute recording/scripted fakes instead of running a real
  agent.
- Keep templates self-contained (ADR `0009`); never import repo code into
  `src/templates/`.
- Do not invent a second vocabulary for an existing concept (sandbox, agent,
  iteration, task, prompt, worktree, branch strategy, completion signal,
  structured output, session). Use the `CONTEXT.md` term and avoid the listed
  `_Avoid_` synonyms.
- Map new behavior onto an existing flow, or record it as an explicit new
  decision (ADR).

Artifact locations:

- Durable decisions: `docs/adr/NNNN-<slug>.md`
- Glossary / ubiquitous language: `CONTEXT.md`
- Agent operating docs: `docs/agents/`
- User-facing change notes: `.changeset/`

Do not create scattered top-level documentation files unless the user explicitly
asks for a local draft.

## Delivery Gate

There is no external senior-engineer skill gate. Before delivery, confirm:

- `npm run typecheck` passes (`tsgo --noEmit`)
- `npm run test` (or the targeted `vitest` subset) passes for touched behavior
- `npm run format:check` passes (Prettier)
- Behavior changes are covered by a co-located `*.test.ts`
- A changeset exists for any user-facing change (see "Documentation And
  Progress")
- Public type exports stay effect-free where required
  (`scripts/check-public-types-effect-free.mjs`, run via `postbuild`)
- New or changed code matches the touched file's style
- No unrelated refactoring or formatting churn
- No user-owned dirty worktree changes were overwritten
- No secrets, runtime artifacts, or large files were introduced

## TDD And Verification

New behavior and bug fixes should be test-first when practical:

1. Write one co-located behavior test that can fail
2. Implement the minimum code to pass
3. Refactor while green
4. Continue with the next behavior slice

Tests verify behavior through public interfaces, not implementation details.
Substitute fakes at the agent/sandbox seams rather than running real agents.

Verification strategy:

- Small: run the relevant targeted test, then `npm run typecheck`
- Medium: run `vitest` for the touched files, then `typecheck` and
  `format:check`
- Large: run the full suite plus `typecheck` and `format:check`; keep
  Windows-path tests passing

Common commands:

```bash
npm run typecheck                 # tsgo --noEmit
npm run test                      # vitest run (full suite)
npx vitest run src/run.test.ts    # one file
npx vitest run -t "merge-to-head" # by test name
npm run format:check              # prettier --check .
npm run build                     # tsup (+ postbuild public-type check)
```

Dogfooding runners (real sandboxes; require a configured `.sandcastle/.env`):

```bash
npm run sandcastle                # build + run .sandcastle/run.ts
npm run test-podman               # build + podman runner
npm run test-vercel               # build + vercel runner
npm run test-interactive          # build + interactive runner
```

If standard verification is blocked by an unrelated dirty worktree, report the
blocker and run the narrowest meaningful verification still possible.

## Security And Operations

- Never commit credentials, tokens, or private keys. Provider credentials live
  in `.sandcastle/.env` (gitignored); only `.sandcastle/.env.example` is
  tracked.
- Do not log raw tokens, signed URLs, full env dumps, or sensitive agent output.
- Treat any change that forwards host environment into a sandbox
  (`EnvResolver`, `mergeProviderEnv`) as security-sensitive; do not widen the
  forwarded set without justification.
- Be careful with mount and worktree paths — the host repo and real git history
  are mounted into bind-mount sandboxes. Avoid changes that could let an agent
  escape the intended path boundary.
- Validate that dogfooding config changes do not leak into the shipped package
  (`package.json#files` is `dist` only).

## Documentation And Progress

For user-facing changes, add a changeset to `.changeset`. Check existing
changesets first to avoid duplicates. We use `@changesets/cli`. Make all
bugfixes `patch`, all new features or breaking changes `minor` (pre-1.0). Use
`package.json#name` for the changeset name.

Update documentation when a change touches:

- The public API or subpath exports
- Provider, tracker, branch-strategy, timeout, or session behavior
- Init scaffolding or templates
- Domain vocabulary (update `CONTEXT.md`)
- Durable technical decisions (add/update an ADR in `docs/adr/`)

When changing public-facing behavior, check `README.md` and the docs site
(`docs/content/`) to see if documentation needs updating.

## Handoff Rule

When a task must continue in another agent or session, create a handoff with
`handoff`. Include:

- Current goal
- Current branch and working directory
- Changed files
- Completed and remaining behavior
- Verification already run and results
- Failed commands and reasons
- Open risks (especially cross-platform)
- Next explicit commands or edit points
- User-owned changes that must not be reverted

Do not rely on chat history alone for handoff.

## Agent Operating Docs

- **Issue tracker**: Issues live as GitHub issues in `mattpocock/sandcastle`;
  external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.
- **Triage labels**: Default canonical labels and agent-provider support. See
  `docs/agents/triage-labels.md`.
- **Domain docs**: Single-context layout — `CONTEXT.md` + `docs/adr/` at the
  repo root. See `docs/agents/domain.md`.
- **Adding a provider/tracker**: See `docs/agents/adding-an-agent-provider.md`
  and `docs/agents/adding-an-issue-tracker.md`.

## Completion Gates

Before completion, self-check:

- Behavior matches the requirement
- Public API surface is stable (or the change is intentional and documented)
- `typecheck`, tests, and `format:check` pass
- Behavior is covered by co-located tests
- Cross-provider and cross-platform behavior was considered
- Documentation, `CONTEXT.md`, and changesets are synchronized
- `git diff` contains only task-related changes
- Unverified items and open risks are clearly stated

Delivery notes must include:

- What changed
- Affected modules and exports
- Verification commands and results
- Unverified items and reasons
- Whether any risk remains
- Suggested next steps when useful
