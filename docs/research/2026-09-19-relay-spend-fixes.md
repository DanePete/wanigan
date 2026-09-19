# Relay spending fixes — 2026-09-19

Implements CR-01 through CR-04 from the [deep audit](2026-09-19-relay-deep-audit-results.md). The approved scope is spending evidence and admission; recovery and account-aware routing remain subsequent work. No paid provider trials are part of this change.

## Behavior

- OTLP metric and request-log receipts are stored atomically with their aggregates. Exact retries, including reordered attributes, do not add another charge or request. Identity retains decimal nanosecond precision, and distinct late delta intervals still accumulate.
- Explicit zero-dollar deltas remain reported zero. Missing, malformed, cumulative or unspecified cost/token exports leave persistent unknown coverage. Conflicting values for the same metric point do likewise; a subsequent valid delta cannot erase the unresolved evidence.
- Automatic spending requires cost coverage for observed model/source activity. A newer meter from another source cannot hide an outstanding cost. Request-log dollars provide a lower bound rather than a second charge. Zero-token exports do not imply new paid activity.
- TypeSafe reserves a durable request identity before calling the service. Success updates that row; timeout, transport failure, HTTP refusal, unreadable response or missing input metering retain unknown liability. Pending, unresolved and legacy calls without input metering prevent another submission, including after restart or key replacement.
- Reported token counts, local price estimates and actual charges remain distinct. A metered TypeSafe response is not described as a reconciled bill.

The existing required Usage extension owns the telemetry schema. Commit `7ea1afe` moves that schema without changing behavior, before the accounting changes. Schema additions preserve existing rows and can run repeatedly.

## Boundaries

There is no trustworthy TypeSafe reconciliation/reset API in this patch. An unresolved request therefore keeps TypeSafe calls blocked. Logs without sufficient source attribution are conservative: an ambiguous source cannot borrow the newest candidate's cost timestamp. Manual routes remain available through the existing routing behavior.

Legacy telemetry aggregates retain their values; this change cannot reconstruct duplicates or failed requests that old versions never recorded. Telemetry coverage concerns observed activity and admission of the next automatic action, not a hard provider cap on an already running request.

The receiver continues requesting delta temporality. Its treatment of stream identity, attributes and timestamps follows the [OpenTelemetry metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/); unsupported temporalities are retained as unresolved evidence rather than summed as deltas.

## Verification

The regression suites exercise authenticated OTLP HTTP → SQLite → public usage readers → automatic spending admission, and the public TypeSafe verify/routing paths with an offline transport. Migration, retry after collector restart, failed writes, in-flight admission and database reopen cases are included in focused checks.

- Node `22.23.2`; `npm test` exited 0. All eight gates passed, ending with **2,688 smoke assertions passed, 0 failed**. The native suite used a fresh temporary user-data directory and provider-pack root.
- The new telemetry suite passed **37 checks** in focused Electron execution and again inside the full suite. Running its earlier 26-case revision against audited telemetry commit `324bca7` produced **17 expected failures**, preserving passing migration/out-of-order controls.
- Focused TypeSafe verification passed **100 checks**, including a real on-disk SQLite close/reopen and fresh module load. The original timeout and legacy missing-meter cases failed before their fixes.
- The schema-only conversion preserved all **242 original schema records**, including rootpages, and existing rows across repeated migration. The final additive telemetry migration was also checked for idempotence and preserved legacy evidence.
- Final `npm run typecheck`, targeted ESLint and `git diff --check` passed. Provider inference calls made for implementation or verification: **0**.
