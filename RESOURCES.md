# Sandcastle multi-repository delivery resources

## Knowledge

- [CONTEXT.md](./CONTEXT.md)
  Canonical Sandcastle vocabulary. Use for terms such as sandbox, agent, worktree, branch strategy, iteration, task, and completion signal.
- [README.md](./README.md)
  Public workflow documentation. Use for CLI/API behavior around `run()`, `runWorkspace()`, `runWorkspaceTask()`, and `sandcastle workspace`.
- [src/runWorkspaceTask.ts](./src/runWorkspaceTask.ts)
  High-level PRD-to-repository execution pipeline. Use for planner prompt shape, plan validation, executor prompt shape, dry run, and result aggregation.
- [src/runWorkspace.ts](./src/runWorkspace.ts)
  Lower-level multi-repository sandbox primitive. Use for worktree preparation, repository mounting, multi-repo prompt manifest, and cleanup.
- [src/Orchestrator.ts](./src/Orchestrator.ts)
  Core iteration loop. Use for completion signals, timeouts, agent invocation, session capture, and commit collection.
- [src/cli.ts](./src/cli.ts)
  CLI wiring for `workspace plan`, `workspace execute`, and `workspace run`. Use for artifact paths, input-source rules, and command-level delivery output.
- [src/runWorkspaceTask.test.ts](./src/runWorkspaceTask.test.ts)
  Executable examples of planner selection, dry run, executing an existing plan, and validation failures.

## Wisdom (Communities)

- Project issue tracker: `mattpocock/sandcastle`
  Use for checking whether multi-repository workflow behavior matches the maintainers' intended product direction.

## Gaps

- No single checked-in architecture diagram currently explains PRD-to-delivery flow end to end.
