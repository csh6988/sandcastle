# Work Package and allocation lifecycle

Formal Work Packages are generated from the Technical Baseline frozen by the active Run Snapshot. Every version names one Application, one Repository, one existing `development@1` Node Run, its package contract, and producer-first dependencies. Generate producer packages before consumers; the Runtime rejects cycles, missing producers, duplicate package identities, and Application/Repository mismatches atomically.

Assignment uses active Positions frozen in the Snapshot. The Runtime filters out inactive AI members and unregistered Agent adapters, then chooses deterministically by the fewest active assignments and Position ID. Assignment creates one Node Attempt, source branch, Workspace Allocation, Runtime Interaction Session, Sandbox identity, operation key, and evidence scope. Formal packages always use `software-rnd-local-isolated-git`, `branch`, `gitRefWriteIsolation=true`, and `runtimeImportOnly=true`; there is no bind-mount, no-sandbox, `head`, or `merge-to-head` fallback.

The lifecycle is:

```text
ready -> assigned -> running -> self-check
          \-> blocked / failed
                     \-> blocked / failed
self-check --rework--> new version + new Attempt + new allocation
```

An unmet dependency rejects assignment, so no allocation is created. Every edge reads its own exact authority rather than sharing one generic completion flag: Artifact evidence must come from an Attempt assigned to the predecessor Version (and may pin an exact Artifact Version), commit evidence is that Version's succeeded Runtime import, Contract evidence is the exact compatible Contract revision accepted by the Technical Baseline, readiness names one ready evidence record accepted by that Baseline, and manual evidence names one approved Human Approval Node Run. One frozen `development@1` Node Run owns at most one active Work Package Version. A package-bound Attempt cannot be claimed until its exact allocation is Ready and `work-package.start` records the execution transition. A failed or unknown allocation records `work-package.blocked` and blocks the Run; retry creates fresh resources.

The assigned Position and Agent adapter execute only inside the allocation's execution tree and source branch. Work Package permissions are an allowlist applied before the Execution Profile or human Permission policy. Artifacts record that actual assignment's AI member, Position, Interaction Session, Work Package, Node Run, and Attempt. A successful execution must return an exact commit, which the Runtime-owned importer validates and imports. The package remains `running` until import succeeds; tip drift records a failed import and blocks the Run without rewriting the already succeeded execution Attempt. Startup reconciliation resumes the same non-terminal allocation, projects succeeded or failed import authority back into the package and Run, and never adopts unknown directories; cleanup remains retryable and preserves import receipts.

A passing Developer self-check must include the manifest's declared commands, log references, and the exact Runtime-imported commit. Pipeline successors of a succeeded package-bound `development@1` Node stay queued until the current active Version's exact Assignment is `self-check-passed`; the self-check transaction then delegates successor release to the Pipeline Runtime. A graph-defined skipped package branch still satisfies its Join without an Assignment. The report stores structured evidence only and never creates Code Review approval or Integration authority.
