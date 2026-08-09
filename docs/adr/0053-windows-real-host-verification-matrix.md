# Windows real-host verification matrix

## Context

Sandcastle's cross-platform hardening (T27 Phase C) was implemented and verified
on a **macOS (darwin)** developer host with no access to a real **Windows**
host. CI does run the Desktop test suite on `windows-latest`, but only the
non-skipped tests execute there, and several Windows-specific code paths have no
test that asserts their real behavior — they are exercised, at most, against
POSIX equivalents locally.

Two kinds of Windows behavior therefore exist in the codebase, and conflating
them would let the project **falsely claim real Windows support**:

- **Emulation-covered** — pure logic that takes an explicit `platform` argument
  (or injected filesystem seams) and can be driven with `"win32"` from any host.
  These are genuinely verified by co-located tests on darwin/CI.
- **Requires-real-host** — behavior whose correctness depends on the Windows
  kernel (named-pipe transport, mandatory file locking) or Windows-only
  filesystem effects. These cannot be validated by emulation and are **not**
  verified in the current environment.

Decision D11 / research note R6 in the T27 planning record enumerate the
real-host-only behaviors. This ADR is the durable home for that boundary so the
marker comments in source and the final integration ticket cannot drift from a
single catalogue.

## Decision

Every requires-real-host behavior is marked in source with an
`UNVERIFIED(real-windows-host)` comment that cross-references this ADR (`0053`),
and is catalogued in the matrix below. The rules:

1. **Never claim real Windows support from emulation.** Emulation tests prove
   the pure logic, not the kernel behavior. Where a path is emulation-covered
   AND has a real-host tail, the marker names both.
2. **Fail closed, never fake.** A requires-real-host path must either already
   fail closed (return a non-success sentinel / throw) or fail closed on error.
   It must never return a fabricated success to appear Windows-capable.
3. **Do not cripple working paths.** Named-pipe IPC bind/connect, WAL setup, and
   `patchGitMountsForWindows` run real logic on real Windows (CI covers them on
   `windows-latest`). Adding a throwing `win32` guard purely to look cautious
   would break the very support this effort is hardening. Markers document the
   verification gap; they do not disable the path.
4. **This gap is pending, not passed.** The current darwin verification status
   is recorded below as UNVERIFIED. The final integration ticket records the
   real-Windows gap as **pending**, not as a passed check.

### Matrix — emulation-covered vs requires-real-host

| Behavior                                                                | Source                                                     | Classification                                                           | darwin/CI status                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Path/mount separator + git-dir normalization                            | `src/mountUtils.ts` (`normalizeMounts`, `parseGitdirPath`) | Emulation-covered (takes `platform`)                                     | Verified — `mountUtils.test.ts`                                |
| Company Runtime address (named-pipe vs `.sock` selection)               | `apps/desktop/runtime/address.ts`                          | Emulation-covered (takes `platform`)                                     | Verified — `address.test.ts`                                   |
| SQLite WAL journal mode set at open                                     | `apps/desktop/runtime/storage/sqlite.ts`                   | Emulation-covered (durable in file header)                               | Verified — `sqlite.test.ts`                                    |
| Named-pipe IPC **bind**                                                 | `apps/desktop/runtime/server.ts` (`listen`)                | Requires-real-host                                                       | **UNVERIFIED** — only POSIX unix-socket bind exercised         |
| Named-pipe IPC **connect**                                              | `apps/desktop/runtime/client.ts` (`createConnection`)      | Requires-real-host                                                       | **UNVERIFIED** — only POSIX unix-socket connect exercised      |
| Real WAL locking / `busy_timeout` contention under Windows file locking | `apps/desktop/runtime/storage/sqlite.ts`                   | Requires-real-host                                                       | **UNVERIFIED** — single-connection Runtime never contends here |
| `patchGitMountsForWindows` real filesystem effects                      | `src/mountUtils.ts`                                        | Requires-real-host (default non-injected FS branch)                      | **UNVERIFIED** — logic emulation-covered, real FS effects not  |
| Electron Test fixture win32 path (descriptor-relative no-follow)        | `apps/desktop/runtime/testing/electronTestFixture.ts`      | Requires-real-host — fails closed (throws)                               | **UNVERIFIED** — POSIX-only helper; win32 throws               |
| Artifact export on win32 (descriptor-relative no-follow)                | `apps/desktop/runtime/release/artifactExportAdapter.ts`    | Requires-real-host — fails closed (`unavailable` → `unknown()` finalize) | **UNVERIFIED** — POSIX openat/O_NOFOLLOW only                  |

## Consequences

- The five requires-real-host behaviors from D11/R6 (named-pipe IPC bind and
  connect, real WAL locking, export on win32, Electron fixture win32 path,
  `patchGitMountsForWindows` FS effects) each carry an
  `UNVERIFIED(real-windows-host)` marker pointing here. A completeness test
  (`apps/desktop/tests/windowsRealHostMatrix.test.ts`) asserts both the markers
  and this document stay honest, so the two cannot silently diverge.
- The **final integration ticket** references this matrix and records the
  real-Windows verification gap as **pending**, not passed. Closing the gap
  requires re-running the affected suites on a real Windows host and updating
  the darwin/CI status column accordingly.
- No `win32` path was newly gated to throw. Fail-closed here means the existing
  sentinels/throws (export, fixture) and error-path rejection (IPC, git mounts)
  — not disabling behavior that real Windows relies on.
- ADR-0006 remains the authority for _why_ the Windows git-worktree mounts work
  the way they do; this ADR only classifies its verification status.
