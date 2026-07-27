# Execution recovery

Company Runtime recovers a running Node Attempt or standalone Interaction Turn by preserving its stable execution operation key and moving the target to `reconciling`. It never silently returns uncertain work to a queue and never treats lease expiry, process exit, or a human decision as proof that an external provider stopped.

## Reconciliation flow

1. Runtime releases the lost execution Lease, records the target as `reconciling`, and blocks replacement work.
2. One recovery worker claims the target with a unique reconciliation Lease, the next execution epoch, and a new fence token.
3. The Adapter reports through the Runtime-bound Execution Fact sink.
4. An accepted `not-started` Fact must carry a non-empty Provider receipt and evidence reference. It settles the original target as `interrupted`.
5. An accepted `completed`, `failed`, or `cancelled` Fact settles the original target without creating another Attempt or Turn.
6. `running` may continue only when the Adapter declares reattachment support. Runtime first issues a new execution Lease/fence and then calls `reattach` with the unchanged operation key.
7. `unknown`, unsupported reattachment, or an Adapter error leaves the target blocked. A later reconciliation claim uses another epoch.

Old owners may still submit diagnostic Facts, but an expired or released fence can only persist them as `stale`; it cannot mutate the Attempt, Turn, Artifact, Permission, Node, or Run.

Pause and cancellation both abort the local worker without treating that abort as external termination evidence. Pause preserves the Run as `paused`; its active Attempt/Node become `reconciling`/`blocked`, and Resume returns the Run to `blocked` until reconciliation settles the Attempt. Cancellation also marks each active execution Lease as cancel-requested, releases its old fence, and asks the Adapter to cancel. A cancellation response without an accepted terminal Fact is advisory only: `unknown`, `not-found`, or an unproven local abort leaves the Attempt and Run `reconciling`/`blocked`. Only an accepted `cancelled` Fact, or later reconciliation evidence under a new fence, can settle the target.

## Retry, Recovery, and Fork

- Retry creates a new Node Attempt under the existing Snapshot and consumes the frozen retry allowance.
- Recovery creates a new Snapshot revision plus a new `recovery` Attempt. It does not mutate the parent Snapshot or consume the ordinary retry allowance.
- Fork creates a child Run and Snapshot, writes its Continuation Plan, and atomically marks the parent Run `superseded`.

Recovery and Fork write one immutable Continuation Plan in the same transaction. The Plan and every Plan Item reject both update and deletion. Every graph Node/Gate receives exactly one disposition: `rerun`, `reuse-evidence`, `skip`, or `blocked`. Reused evidence references the persisted terminal Fact; downstream work is not inferred again after restart.

## Inspection and shutdown

`run.inspect` returns the latest Continuation Plan for the target Run. The typed `execution.inspect` Query accepts a `node-attempt` or `interaction-turn` target and returns its operation key, Lease epochs/fences, accepted or diagnostic Facts, evidence references, and terminal Fact identity through the existing Runtime Query tunnel.

During draining shutdown, Runtime aborts local workers and waits for their terminal Facts. Any operation still lacking a proven terminal state is persisted as `reconciling`, its Lease is released, and restart recovery follows the same flow above.

Model-only consultation retains its existing capability boundary during recovery: no shell, filesystem, Worktree, Sandbox, Tool, Permission, Artifact, or commit effect is admitted, and credentials remain inside the trusted Model Transport closure.
