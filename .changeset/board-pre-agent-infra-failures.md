---
"@chenshaohui6988/sandcastle": patch
---

Fix Board approved-plan execution around pre-agent infrastructure failures: sandbox create failures (e.g. missing Docker image or daemon) are now classified as infrastructure failures, verification reports them as `needs-recovery` with the real cause in the workflow error instead of a generic delivery failure, the Evaluator agent is no longer launched when only lifecycle runtime events (`run.started`/`iteration.started`/`run.error`) were recorded, execution retries only re-run the failed repositories instead of re-executing already-successful ones, and recovering a failed task always executes at least once even when the previous execution already exhausted the retry budget (previously recovery skipped straight to verification without running anything).
