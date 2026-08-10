# T27 final integration — Windows real-host verification status

This is the durable final-integration record for the T27 umbrella
(upgrade/retention/cross-platform/Release hardening). It closes the loop with
[ADR-0053](../adr/0053-windows-real-host-verification-matrix.md): that ADR
forward-references "the final integration ticket", and this document is that
ticket's committed artifact, citing `0053` so the matrix link is navigable in
both directions rather than one-way.

## Integration

T27 integrates onto the wave-1 integration line as a pure fast-forward: the
implementation branch is a linear descendant of the integration reference with
no divergence, so the ordered ticket commits (contract freeze → open-path
integrity → registry-version choke point → v53 compaction-checkpoint schema →
retention-class compaction → Release persistence/error-code alignment →
reconcile/claim edge coverage → cross-platform pure-logic coverage →
real-Windows honesty markers) apply without conflict. Company Runtime storage
lands at schema v53; the Runtime Event Registry version is unchanged.

## Verification status

The full chain — build, both type-checks, formatting, and both packages' test
suites — was verified green on a **macOS (darwin)** host. CI additionally runs
the Desktop suite on `windows-latest`, where the named-pipe transport happy path
and the platform-parameterized pure logic are exercised unguarded.

Real Windows-kernel and Windows-only-filesystem behavior remains outside that
coverage. Per ADR-0053, the real-Windows verification gap is recorded as
**pending, not passed**: the requires-real-host rows in the ADR-0053 matrix
(named-pipe bind/connect ACL and disconnect semantics, real WAL lock
contention, `patchGitMountsForWindows` filesystem effects, the Electron test
fixture win32 path, and artifact export on win32) stay UNVERIFIED until the
affected suites are re-run on a real Windows host and the matrix's darwin/CI
status column is updated accordingly.

This is a deliberate honest boundary. No `win32` path was gated to throw purely
to look cautious; every requires-real-host path either already fails closed or
fails closed on error, and none fabricates a success to appear Windows-capable.
Closing the gap is a real-host verification task, not a code change.
