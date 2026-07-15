# Pipeline Runtime durable Node leases

Pipeline Runtime stores a time-bounded Node lease on each Node Attempt and owns claim, renewal, completion, failure, release, and expiry recovery in SQLite transactions. An expired or released lease becomes an explicitly recoverable failure rather than being silently requeued, so side-effecting Agent work is never duplicated after a Runtime crash; protocol, Supervisor, IPC, and Renderer layers only observe the resulting state.
