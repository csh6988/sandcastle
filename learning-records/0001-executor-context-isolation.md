# Executor context isolation is central

The user identified that repository or issue execution should be handled by corresponding isolated executor invocations, rather than one shared agent context doing all repository work. Future lessons should preserve this model: planner context is intentionally cross-repository, executor context is repo-local with only the approved plan shared in.
