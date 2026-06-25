# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository. For workflow rules, task classification, skill
activation, and delivery gates, see [AGENTS.md](./AGENTS.md). For the canonical
glossary, see [CONTEXT.md](./CONTEXT.md).

## Project Overview

**Sandcastle** is a TypeScript toolkit (library + CLI) that orchestrates AI
coding **agents** inside isolated **sandbox** environments. It manages the
lifecycle of sandboxes, branches/worktrees, prompts, and **iterations**.

Core capabilities:

- Run an **agent** (Claude Code, Codex, Copilot, Cursor, OpenCode, Pi) for one
  or more **iterations** inside a **sandbox**
- Pluggable **sandbox providers**: Docker, Podman, Vercel, Daytona, no-sandbox
- **Branch strategies**: head, merge-to-head, named branch — backed by git
  worktrees on the **host**
- Prompt templates with argument substitution and shell-expression expansion
- **Completion signal** + **completion timeout** handling for hanging processes
- **Structured output**: schema-validated JSON returned from a run
- **Session resume** and **session fork** via each agent's native mechanism
- `init` scaffolding that writes a `.sandcastle/` **config directory** into a
  host repo

The package is ESM-only, built with `tsup`, type-checked with `tsgo`, and
tested with `vitest`. Only `dist/` is published to npm.

## Module Structure

Source lives in a mostly flat `src/` with co-located tests
(`foo.ts` + `foo.test.ts`):

```
sandcastle/
├── src/
│   ├── index.ts                # Public API barrel (the package contract)
│   ├── cli.ts / main.ts        # CLI entry (bin: sandcastle)
│   ├── run.ts                  # run() — iterate an agent in a sandbox
│   ├── interactive.ts          # interactive() — interactive agent session
│   ├── runWorkspace*.ts        # runWorkspace / runWorkspaceTask orchestration
│   ├── createSandbox.ts        # createSandbox() — lower-level sandbox handle
│   ├── createWorktree.ts       # createWorktree() — host git worktree
│   ├── Orchestrator.ts         # Iteration loop / orchestration core
│   ├── SandboxProvider.ts      # Provider interfaces + factory helpers
│   ├── SandboxLifecycle.ts     # Sandbox setup/teardown + hooks
│   ├── AgentProvider.ts        # Agent providers (claudeCode, codex, ...)
│   ├── AgentStreamEmitter.ts   # Agent stream events
│   ├── WorktreeManager.ts      # Worktree creation/locking/reuse
│   ├── SessionStore.ts         # Agent session storage/transfer helpers
│   ├── Prompt*.ts              # Prompt resolve / substitute / preprocess
│   ├── Output.ts               # Structured output definitions
│   ├── Display.ts              # Terminal vs log-to-file display
│   ├── sync{In,Out}.ts         # Sync code in / commits out (isolated providers)
│   ├── sandboxes/              # Built-in sandbox providers (subpath exports)
│   │   ├── docker.ts
│   │   ├── podman.ts
│   │   ├── vercel.ts
│   │   ├── daytona.ts
│   │   └── no-sandbox.ts
│   └── templates/              # init scaffold templates (self-contained)
├── docs/
│   ├── adr/                    # Architecture Decision Records
│   ├── agents/                 # Agent operating docs
│   └── (app/, content/, ...)   # Documentation site (separate package)
├── .sandcastle/                # This repo's own dogfooding config (not shipped)
├── .changeset/                 # User-facing change notes
├── CONTEXT.md                  # Glossary / ubiquitous language
├── AGENTS.md                   # Workflow, skill activation, delivery gates
└── CLAUDE.md                   # This file
```

### Public API (`src/index.ts`)

Anything exported here is the package's public surface; treat changes as
contract changes.

- **Entry functions**: `run`, `runWorkspace`, `runWorkspaceTask`,
  `executeWorkspaceTaskPlan`, `interactive`, `createSandbox`, `createWorktree`
- **Providers**: agent providers `claudeCode`, `codex`, `copilot`, `cursor`,
  `opencode`, `pi`; sandbox provider factories `createBindMountSandboxProvider`,
  `createIsolatedSandboxProvider`
- **Output**: `Output`, `StructuredOutputError`
- **Sessions**: `transferClaudeSession`, `transferCodexSession`,
  session-path helpers
- **Errors**: `CwdError`
- Built-in providers are also reachable via subpath exports
  (`@chenshaohui6988/sandcastle/sandboxes/docker`, etc.), declared in
  `package.json#exports`.

## Build, Test, and Run Commands

```bash
# Type check (uses tsgo, the TypeScript native preview)
npm run typecheck

# Run the full test suite / a single file / by name
npm run test
npx vitest run src/run.test.ts
npx vitest run -t "merge-to-head"

# Format
npm run format        # write
npm run format:check  # check only

# Build (tsup) — postbuild copies templates and runs the public-type check
npm run build

# Release (changesets)
npm run release
```

Dogfooding runners exercise real sandboxes and need a configured
`.sandcastle/.env`:

```bash
npm run sandcastle
npm run test-podman
npm run test-vercel
npm run test-interactive
```

## Architecture Patterns and Conventions

### Effect-based core

The orchestration core is built on [Effect](https://effect.website). Pluggable
behavior is exposed through service seams (`Context.Tag`), most importantly the
**agent invoker** — the seam that hands a fully-resolved **prompt** to the
**agent provider** for one **iteration**. Tests substitute a recording or
scripted fake at this seam instead of running a real agent.

Public type exports are kept effect-free where required; `postbuild` runs
`scripts/check-public-types-effect-free.mjs` to enforce this.

### Provider pluggability

Three pluggable axes, all injected rather than hardcoded:

- **Sandbox provider** — creates and manages a sandbox. Two shapes:
  **bind-mount** (host filesystem mounted in) and **isolated** (own filesystem,
  sync in/out), plus the **no-sandbox** provider (agent runs on the host).
- **Agent provider** — builds commands and parses output for a specific agent.
- **Issue tracker** — pluggable source of **tasks**, selected during init.

When adding one, follow `docs/agents/adding-an-agent-provider.md` or
`docs/agents/adding-an-issue-tracker.md`.

### Branch strategies and worktrees

A **branch strategy** (set at provider construction) controls how the agent's
changes relate to git branches:

- **head** — work directly in the host working directory, no worktree
- **merge-to-head** — temp branch, agent works on it, changes merged back to
  HEAD
- **branch** — commits land on an explicitly named branch

Non-head strategies use a git **worktree** in `.sandcastle/worktrees/` on the
host. For bind-mount providers the worktree is mounted in; for isolated
providers it is the sync source/destination. See ADRs `0003`, `0006`, `0007`,
`0017`.

### Completion, timeouts, and structured output

- **Completion signal**: the `<promise>COMPLETE</promise>` marker indicating all
  tasks are done.
- **Completion timeout**: a silence-based grace window that takes over from the
  **idle timeout** once the signal is seen, so trailing output is captured and a
  **hanging process** resolves successfully (ADR `0019`).
- **Structured output**: schema-validated JSON inside a caller-specified XML tag,
  configured via `Output.object({ tag, schema })` (ADR `0010`). The caller owns
  the prompt-side instruction; `run()` errors early if the resolved prompt lacks
  the tag.

### Sessions

Agent session storage is owned by the **agent provider** (ADR `0012`).
**Session resume** appends turns to the same record (ADR `0011`, `0016`);
**session fork** branches into a new record, isolating the session only — not
the branch or sandbox (ADR `0018`).

## Coding Standards (MUST Follow)

- **Language**: TypeScript ESM. Use `.js` extension specifiers in imports
  (e.g. `import { run } from "./run.js"`) as the existing code does.
- **Tests are co-located**: put `foo.test.ts` next to `foo.ts`. Isolate
  Windows-path behavior in `*.windowsPath.test.ts` / `*-windowsMounts.test.ts`.
- **Test behavior, not implementation**: exercise public interfaces; substitute
  fakes at the agent/sandbox seams. A test should survive an internal refactor.
- **Use the glossary**: when naming a domain concept in code, tests, or docs,
  use the term defined in `CONTEXT.md` and avoid its listed `_Avoid_` synonyms.
- **Keep templates self-contained**: never import repo code into
  `src/templates/` (ADR `0009`).
- **Public surface is deliberate**: only add to `src/index.ts` when the export
  is meant to be public; effect-laden types must not leak into public exports.
- **Format with Prettier**: run `npm run format` before delivery; avoid
  unrelated formatting churn.
- **No secrets**: provider credentials belong in `.sandcastle/.env`
  (gitignored). Never log raw tokens, signed URLs, or full env dumps.

## Architecture Decision Records

Durable technical decisions live in `docs/adr/` and are the source of truth for
those trade-offs. Read the ADRs touching the area you're working in before
changing it; if your change contradicts an ADR, surface it explicitly rather
than silently overriding (add or supersede an ADR for durable changes).

## Testing

- Framework: `vitest` (config in `vitest.config.ts`, setup in
  `src/testSetup.ts`).
- Test fakes/helpers: `src/testSandbox.ts`, `src/sandboxes/test-*.ts`.
- Run targeted tests during development; run the full suite plus `typecheck` and
  `format:check` before delivery.

## Documentation and Changesets

User-facing changes need a changeset under `.changeset/`, and public behavior or
vocabulary changes should sync `README.md`, `CONTEXT.md`, and the docs site
(`docs/content/`). The full rules (changeset type, naming, delivery gates, task
classification) live in [AGENTS.md](./AGENTS.md) — this file does not duplicate
them. The `.agents/skills/pre-release` skill reviews changeset hygiene before a
release.

## Important Notes

- ESM-only package; Node + npm (`packageManager: npm@10.9.2`).
- Type checking uses `tsgo` (TypeScript native preview), not `tsc`.
- `@vercel/sandbox` and `@daytona/sdk` are optional peer dependencies.
- Only `dist/` is published; all repo meta and docs stay out of the package.
- Cross-platform matters: Windows path/mount behavior has dedicated tests — keep
  them green.
