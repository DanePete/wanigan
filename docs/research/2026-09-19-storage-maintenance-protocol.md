# Storage maintenance protocol

Implemented for the approved recovery phase, with no provider calls. The required Storage module owns connection lifecycle, the operational interlock, and generation publication. The evidence database remains canonical for execution and billing records.

## Record and ownership

`<userData>/.storage-control/` is private (`0700`) and excluded from backup contents. `format.json` anchors protocol version 1 and a random root identity; `journal.sqlite` (`0600`, SQLite DELETE journal, synchronous FULL) contains:

- Current generation, monotonic coordination revision, mode, operation identity and the current database device/inode.
- Random participant identities, declared app/scheduler/CLI role, protocol version, diagnostic PID and explicit closed-handle acknowledgements.
- Restore operation identity, source/destination generation, verified manifest digest, staging/retained paths, phase, timestamps and bounded failure detail.

It does not copy execution outcomes, costs or liability. PID and timestamps never authorize signaling, takeover or deletion. A crashed participant remains unacknowledged. A missing, replaced, corrupt or incompatible journal/marker refuses access; first-time adoption stamps the live database with its generation. Removing the entire interlock cannot adopt an already-stamped database as a fresh generation. Main database inode replacement outside publication fences cached handles and subsequent opens.

## Lock and revision rules

All participating app, scheduler and CLI database opens go through Storage. Control transactions precede evidence-database transactions. Native bootstrap and late module migrations share that ordering. Public connections, cached statements, transaction variants, statement database references and iterators validate their generation and maintenance state. A closed old-generation handle cannot reopen itself.

A restore preview binds an opaque revision: the control revision plus the reviewing connection's SQLite `data_version`, `total_changes()` and `schema_version`. The SQLite observations matter because a main-database commit and a control-database commit are separate durability boundaries. A foreign main-database commit remains observable even if its external counter never committed. Receipts are process-bound; these per-connection observations are not advertised as portable sequence numbers. No-op lazy schema reads do not advance the revision.

The initial supported restore path refuses every foreign participant lacking an explicit close acknowledgement. It does not automatically drain or terminate a daemon, stop an agent, steal a lease, or infer completion from a dead PID. A participant's native close must succeed before its acknowledgement is recorded. An asynchronous database backup prevents that acknowledgement.

A bounded `lsof` inventory also refuses observed unregistered database handles. The inventory is a snapshot, not an exclusion primitive. An older binary that ignores the protocol could open after the snapshot; safety is supported only for cooperating builds. Platforms without a usable inventory receive an unsupported restore refusal. Neither the protocol nor `lsof` constitutes OS containment.

## Restore transitions

| Phase | State and permitted next transition |
| --- | --- |
| Before admission | Revalidate preview generation/revision, peer closures, observed foreign handles and current execution/liability refusal under the control transaction. |
| `prepared` | Barrier is durable; new opens and all public database access refuse. Stamp only the staged database. Cancellation may restore the prior mode while the current native handle remains open. |
| `closed` | Current native handle checkpointed/closed and explicitly acknowledged. There is no automatic cancellation/reopen. |
| `swapping` | Journal records intent before the first filesystem rename. Retained originals and staged paths remain attributable if the coordinator dies. |
| `published` | Validate installed generation/integrity, then atomically publish new generation/inode and `inspection` mode. |
| `failed` | Barrier remains owned and startup refuses main-database opening, including after filesystem rollback. Failure detail and retained/staging paths are preserved. |

A crash before an atomic control transaction commits rolls back that transaction; its process participant remains unknown. A crash after barrier publication never causes timed unlock. A crash after final publication reopens only for inspection. Startup refusal names the operation, phase, journal and retained/staging paths. Ambiguous states have no automatic repair in this phase.

## Inspection mode

Public database access is read-only. Automatic work and paid admission refuse independently. Controlled additive bootstrap/module migrations may still update schema and seed module definitions; this is not a promise that archived bytes never change. A legacy getter's single `CREATE TABLE/INDEX IF NOT EXISTS` can run only under temporary SQLite `query_only`, proving it is a no-op. New tables, multiple statements, DML and disabling read-only through public APIs refuse.

The host does not start producer services in inspection mode. There is no generic unlock action. Restored waiting jobs, approvals and old spend totals remain historical information. Post-restore work/spending reconciliation remains unsupported in this phase.

## Verification

`node scripts/test-storage-maintenance.cjs` runs the production coordinator and connection code with real SQLite files and separate credential-free Node processes. Its `node:sqlite` adapter supplies the synchronous driver interface; these are synthetic local process fixtures, not provider trials. Fifteen scenarios cover cached handles, peer refusal/close, third-process startup, stale revisions including a native commit outside the interlock, observed legacy handles, cancellation/repeated apply, four SIGKILL points, dead participants, database replacement, incompatible/corrupt state and missing/replaced journal files. It also verifies real Settings reads, mutation refusal, historical automation/spending holds and private permissions. Native Backup integration and application lifecycle are verified separately by the phase's native fixtures.
