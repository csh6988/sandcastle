# Review Topic runtime contract

The Review Runtime in `apps/desktop/runtime/review/` is the Company Runtime's single writer for generic Review Topics. Product, technical, code, aggregate, and verification flows supply a strict discriminated `ReviewInputManifest`; later tickets bind those generic Topics to their promotion flows.

Topic creation freezes participant roles, producer identity, eligibility snapshots, the eligible-reviewer quorum, exact manifest/hash, acceptance criteria, excluded-context labels, discussion budget, stop condition, and escalation policy. Owner-participants and moderators can respond and append dispositions but cannot submit independent Findings or vote. A reviewer whose AI member, Position, or Session matches the reviewed producer is ineligible.

Participant Commands are also actor-bound: only the matching authenticated Runtime worker may act for an AI member/Session (`test-driver` is reserved for deterministic tests). A Renderer or local human principal cannot claim an eligible reviewer ID and manufacture a Finding or Gate vote.

Findings and Review revisions are immutable. Finding dispositions are append-only so the resolution matrix cannot erase the original reviewer evidence. Discussion rounds may contain only disputed or high/critical Findings and stop at the frozen round, duration, Token, or cost budget. Exhaustion records an immutable `FAIL` Quality Gate Result with evidence.

Re-review binds the latest exact revision/hash. Each vote must use a new active Interaction Session for the frozen reviewer identity, and final quorum must include at least one eligible reviewer who did not submit an initial Finding. Any counted `FAIL` yields `FAIL`; otherwise any counted `CONDITIONAL_PASS` yields `CONDITIONAL_PASS`; only unanimous `PASS` with no unresolved blocking Finding yields `PASS`. The Query View exposes `satisfiesProductionContract`, which is true only for `PASS`.

Review Commands use the formal Command Envelope and Topic revision for concurrency. The synchronous state transitions do not acquire an Execution Lease: Command receipt deduplication and the Topic revision are the fence. Mutation, audit, Runtime Event outbox, deterministic receipt, and trigger context commit in one SQLite Unit of Work. Duplicate Commands replay the stored result; conflicting Command ID reuse is rejected.
