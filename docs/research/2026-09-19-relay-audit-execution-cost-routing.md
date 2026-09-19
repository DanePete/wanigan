# Relay audit execution: cost and routing

Executed 2026-09-19 at `324bca7f137198a78583ec9b8cb07cfd1c667c71`, Node `v22.23.2`. This report adds executed evidence to the earlier [cost](2026-09-19-relay-audit-cost-coverage.md) and [routing](2026-09-19-relay-audit-routing-coverage.md) coverage notes; it does not replace them. **No provider inference, credential read, paid request or product-source change was made by this audit lane. Actual API spend: $0; unresolved real paid liabilities: none.** Synthetic dollar values below are fixture inputs, never bills.

The local audit reproduced spending-accounting gaps that block using Relay's current meters as the complete audit ledger: a delayed cost export can permit another automatic action against an understated total; replayed exports inflate totals; a successful explicit-zero export is discarded; and ambiguous JEV request failures leave no attempt row. The launch guards themselves passed the tested pause, halt, ownership, budget, route-account and profile mutations. Manual previews stayed free, and preview authority was rejected after in-flight profile, capability and credential changes.

## Evidence and reproducibility

The [standalone harness](relay-audit-2026-09-19/cost-routing/audit-fixtures.cjs.txt) executes unmodified production TypeScript through a fixture loader. It runs:

- The actual OTLP HTTP receiver on an ephemeral `127.0.0.1` port, actual parser/writer/usage reader, actual table DDL, and real in-memory SQLite. Sessions are synthetic logged sessions; backend billing eligibility, Codex reconciliation and goal-trace writes are substituted. There is no real exporter, provider or invoice.
- Actual Control implementation and module migration, using the repository's existing fixture factory with real SQLite. Session preparation, provider registry, queue and PTY are explicit doubles. A counted `createSession` boundary is not a real process.
- Actual Relay preview, JEV client/usage writer and public model-price module with fixture credentials, profile/catalogue data and fetch responses. JEV fault responses and account identities are synthetic. Price requests are captured rather than transmitted.

The final command exited 0 and emitted **50 case records** in [results.json](relay-audit-2026-09-19/cost-routing/results.json), with [stdout/stderr](relay-audit-2026-09-19/cost-routing/fixtures.txt). The `.txt` suffix keeps the reproduction harness a documentation artifact outside application/test discovery; Node executes it directly from the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use
node docs/research/relay-audit-2026-09-19/cost-routing/audit-fixtures.cjs.txt
```

The default sandbox refused the localhost bind with `listen EPERM`; the same local-only harness then ran with approved sandbox escalation. During fixture construction, two loader-only errors were corrected (a doubled `.ts` suffix and a missing unused completion-listener stub). Neither was a product failure. The final artifact and log correspond to the completed run at `2026-09-19T19:00:04.842Z`.

These independently rerun pure contracts passed **69/69**, exit 0; [full output](relay-audit-2026-09-19/cost-routing/pure-tests.txt):

```sh
node --test src/shared/automatic-spend.test.ts src/shared/decision-receipts.test.ts \
  src/shared/relay-route.test.ts src/shared/relay-routing.test.ts \
  src/shared/suggest-questions.test.ts src/shared/model-economics.test.ts \
  src/shared/token-evidence.test.ts
```

Root's same-revision isolated baseline separately passed all eight repository stages, with the eighth retried after a sandbox Electron failure: **2,620 smoke checks, 0 failures**. Its production Relay/SQLite checks include Manual create, one batch per Auto preview, unchanged create reuse, two concurrent creates yielding one docket, key/input mutation rejection and exact expiry. These are existing transport-fixture tests, not a second independent real-provider reproduction. The log was inspected at `/private/tmp/wanigan-relay-audit-vxcyorcv/logs/smoke-native.log`, including routing lines 2129–2177; root retains the durable baseline artifacts.

## Owned P0 boundary coverage

| Boundary | Executed result | Evidence level and remaining limit |
| --- | --- | --- |
| Global ledger / reservations | Two independent `$50` goal budgets each launch one fixture session. No aggregate audit reservation exists in this product path; JEV has a separate estimate ledger. | Actual Control + SQLite; process/meter collaborators substituted. Root's external shared ledger remains necessary. This confirms scope, not a claim that the product promised a global cap. |
| Missing and mixed session cost | No prior session launches; missing cost and mixed known/unknown sessions refuse at dequeue and after async preparation, with no session or retained claim. | Actual Control + SQLite and fixture meters, plus pure predicate tests. |
| Explicit zero | An OTLP dollar datapoint explicitly carrying `0` gets HTTP 200 but no metric row; reader returns `unavailable`. | Real HTTP/SQLite receiver reproduction, CR-03. A directly inserted zero row still passes existing smoke, explaining the gap. |
| Duplicate / out-of-order | Replayed identical `$0.40` delta becomes `$0.80`. Distinct out-of-order `$0.20` + `$0.30` deltas total `$0.50` and retain the newest timestamp. | Real HTTP/SQLite receiver reproduction, CR-02; distinct export negative control passes. |
| Delayed spend | `$0.20` metric followed by a newer request log reporting `$2` remains `reported` at `$0.20`, and the `$1` predicate allows another action; late `$2` delta then blocks at `$2.20`. | Actual HTTP/SQLite reader and pure production guard; actual Control separately allows a prior session presented as reported `$0.20`. No hosted billing or real paid launch occurred. CR-01. |
| Failure after request submission | Synthetic timeout-after-submission, HTTP 500 and 429 each produce no JEV usage row; unreadable 200 produces an unknown row. | Actual JEV client/SQLite, substituted transport. Fixture establishes lost liability evidence, not that a provider billed a particular failed request. CR-04. |
| Pause/halt/budget/profile/ownership before dequeue | Each refuses with zero attempted session creation and no retained claim. | Actual Control + SQLite; no real typed IPC or process. |
| Same changes during preparation | Each reaches one blocked preparation but produces zero launches, zero session bindings and zero retained claims. Missing/partial new cost behaves the same. | Actual Control final pre-spawn callback called by session double. |
| Account route changes | Changing `work_nodes.account_id` during preparation refuses. Changing it before dequeue launches using the current account pin. | Current-dequeue behavior is observed, not automatically classified as a bug: queue payloads carry a node identity, not a frozen route. Default/project-account or native credential replacement under an unchanged account ID is not exercised. See blocker below. |
| Real IPC/PTY account/authority admission | **Blocked in this lane.** No safe dollar-metered provider admission or attributable invoice was established, and the fixture does not control native account login changes. | Real typed IPC to harmless PTY and native account/default credential races remain separate runtime work. Do not promote the fixture guard result into real-provider conformance. |

Process death, multi-process queue ownership, private dependency isolation, restore and review-descendant shutdown are assigned to the runtime lane, not counted as cost/routing executions here.

## Reproduced findings

### CR-01 — Incomplete cost coverage can authorize the next automatic action

**Severity:** High, P0 spending-lane blocker. **Status:** reproduced at the reader/guard boundary; hosted overspend not attempted. **Owner:** telemetry/evidence kernel plus Control automatic admission.

Minimal case `OTLP-DELAYED`: export a `$0.20` cost delta at T, then a request log at T+5s with `cost_usd=2`, withholding the corresponding cost metric. `usageFor()` returns `$0.20`, `costStatus='reported'`, and a fresh `lastAt` from the log. `automaticSpendVerdict({budgetUsd:1,...})` allows the next paid action. After the delayed metric, total `$2.20` yields `cap`. `CONTROL-delayed-covered-session` shows actual Control accepts that reported partial session total.

Expected by the audit plan: unresolved known exposure must stop new paid work. Actual: cost presence anywhere in a session is treated as coverage of that session; later activity cannot mark it incomplete. [`usageForMany`](../../src/main/otel.ts#L877) sets `reported` on any cost row and updates `lastAt` from request logs; [`autopilotSpend`](../../src/main/control.ts#L191) counts a session as covered solely by that status; the [spend predicate](../../src/shared/automatic-spend.ts#L14) has no freshness/completeness/reservation input.

Negative control: submitting the late metric changes the verdict to refusal without changing budget or route. Distinct missing sessions already block correctly, so the issue is **within-session completeness**, not the missing-session predicate. Consequence: the next stage/repair may start while earlier liability already exceeds the cap. A live provider's timing/billing remains unmeasured.

### CR-02 — OTLP retry duplicates accumulate as new spend

**Severity:** Medium, P0 accounting-boundary failure. **Status:** reproduced with real local HTTP/SQLite. **Owner:** telemetry/evidence kernel.

Minimal case `OTLP-DUPLICATE`: POST exactly the same metric payload twice, including session, attributes, start/end nanoseconds and `$0.40` value. Each gets HTTP 200. The first read is `$0.40`, the second `$0.80`; the timestamp is unchanged. `OTLP-DUPLICATE-LOG` likewise records two requests from the same log export.

Expected: repeated delivery of the same export cannot become a second charge/request. Actual: [`recordMetrics`](../../src/main/otel.ts#L685) adds every parsed value, while [`recordEvents`](../../src/main/otel.ts#L734) inserts every event. No export/point identity is retained for deduplication. Distinct out-of-order deltas still add correctly (`OTLP-OUT-OF-ORDER`), so dropping every older timestamp would also be incorrect.

Consequence: false budget halts, inflated displayed spend/request counts and distorted accepted-result comparisons. This does not prove an actual CLI exporter replay was observed; replay is the injected fault. Native exporter delivery guarantees still need independent conformance.

Related defensive case `OTLP-CUMULATIVE`: temporality=2 values `$0.20`, then `$0.50`, become `$0.70`. The [parser](../../src/main/otel.ts#L526) accepts any sum without validating temporality. Wanigan requests delta export, so this is an unsupported-exporter robustness finding, not evidence that the installed CLI currently emits cumulative metrics.

### CR-03 — Explicit reported zero disappears during ingestion

**Severity:** Medium, availability/accounting defect. **Status:** reproduced with real local HTTP/SQLite. **Owner:** telemetry/evidence kernel.

Minimal case `OTLP-ZERO`: send a valid tracked dollar sum whose value is zero. HTTP 200, zero metric rows, `costUsd=0`, `costStatus='unavailable'`, `lastAt=null`; the next automatic action refuses as unknown spend. Expected: explicit zero remains distinct from no report.

Root cause: [`parseMetrics`](../../src/main/otel.ts#L533) skips `value === 0`; [`blankUsage`](../../src/main/otel.ts#L759) and the reader correctly require a dollar row, so no downstream reader can recover the lost fact. Existing [cost smoke](../../src/main/smoke-relay-cost.ts#L37) inserts the zero row directly, bypassing the faulty ingest boundary. No model or invoice is involved.

### CR-04 — Ambiguous JEV requests leave no durable attempt/liability

**Severity:** High, P0 audit-ledger blocker. **Status:** reproduced with transport faults and actual SQLite. **Owner:** `suggest` extension.

The `JEV-timeout-after-submission`, `JEV-http-500` and `JEV-http-429` cases each execute one fetch boundary and add zero rows. `JEV-unreadable-200` records an unknown row; `JEV-reported-200` records one estimated row. Halt refuses before fetch (`JEV-HALT`). No retries occur inside one call.

Expected: reserve/log an attempt before submission and retain unresolved liability when request acceptance/billing is ambiguous. Actual: [`ask`](../../src/main/modules/suggest.ts#L206) writes usage only after successful HTTP status; transport failure and non-2xx return first. [`suggest_usage`](../../src/main/suggest-usage.ts#L5) records successful calls, with no request reservation/status or account/billing reconciliation identity.

The timeout fixture means “the synthetic transport accepted the request then reported a timeout”; it does not prove vendor billing. A 429 may be free. Both must remain distinguishable from “no request occurred” until a trustworthy billing rule or provider evidence resolves them. Repeated user previews can therefore accumulate unrecorded potential liability even though each individual call avoids automatic retries. Root's audit ledger must retain any such future attempt; paid JEV trials remain blocked here.

## Routing and price results

| Case | Result |
| --- | --- |
| Manual preview with default, model-only, effort-only, model+effort | Zero fetches in all four cases, both JEV capabilities enabled. Operator choices survive; unconstrained values use declared defaults. |
| Manual creation / account inheritance | Root's same-revision production smoke passed zero-inference creation and model-only/effort-only account propagation. |
| In-flight profile fingerprint change or removal | One synthetic request is recorded, then preview rejects changed authority. |
| In-flight full key change retaining display prefix/suffix | Rejected after the response; the actual full-key digest detects the mutation. |
| In-flight capability switch-off | Rejected; no stale receipt is returned. |
| Reused, modified, simultaneous and exactly expired create receipts | Root's production Relay/SQLite smoke passed one unchanged reuse, input/key mismatch rejection, renderer mutation resistance, one winner from two creates, and refusal exactly at expiry with no replacement request. |
| Confidence, legal pairs, mandatory stages | Pure contracts passed all tested boundaries; this is legality/fallback evidence, not calibration of coding quality. |
| Explicit-workload prices | Pure contracts preserve decimal arithmetic, unknown/conditional/cache prices, stale and future snapshot refusal, endpoint eligibility and workload-dependent ranking. |
| Price transport | Synthetic fetches request only fixed public metadata URLs, `GET`, `credentials: omit`, `redirect: error`, no Authorization. Actual redirect-server behavior is not exercised. |
| Failed refresh / bounds | HTTP 503, invalid JSON and streamed body above 8 MiB preserve prior snapshot ID/date, report error, release lease. Exact 2 MiB endpoint overflow is not separately exercised here. |
| Refresh concurrency / recovery | One request while a competing refresh observes the lease; expired lease permits one new request. This is one process with actual SQLite, not a two-process crash test. |
| Disable or halt between endpoint requests | Only catalogue plus first endpoint request occurs in each fixture; remaining endpoints are refused. Requests already in flight are not claimed to be cancelled. |
| Stalled response stream | Abort propagated by the fixture fetch transport at approximately 12 seconds; error surfaced and lease released. This checks real timer/orchestration, not a live remote server. |

Price snapshots remain separate from Relay selection. [`profileFor`](../../src/main/relay.ts#L176) supplies legal models/efforts and descriptions; it does not join account quota, access, MCP readiness or numerical price quotes. These tests do not establish a cheapest accepted-result optimizer.

The official TypeSafe [models reference](https://docs.typesafe.ai/models), read on 2026-09-19 without authentication, lists `$0.042` per million input tokens and free output, matching `SUGGEST_RATES`. It currently maps `jev-latest` to `jev-1.13.0` and documents authenticated `GET /v1/models`. The code's [verify comment](../../src/main/modules/suggest.ts#L279) still says there is no catalogue and performs a billable evaluation. **Source/docs mismatch, not an authenticated endpoint test.** The next connection workflow should verify the read-only catalogue before assuming inference is necessary. The constant rate has no fetched-at/expiry evidence; today's checked numerical match does not supply future freshness or invoice reconciliation.

## Limits and next changes

The account mutation fixture covers the route's account ID, not a login/key replacement within an unchanged account, nor a project/default account change while `account_id` is null. [Session launch](../../src/main/sessions.ts#L1555) resolves account identity late; [Control's callback](../../src/main/control.ts#L2009) compares stored route fields and profile fingerprint. Native authentication identity is not attested by this test. Keep this a concrete unexecuted boundary until an isolated account/PTY fixture or bounded provider trial exists.

Prioritize a complete request/attempt liability model shared by automatic admission and the audit ledger; preserve unknown exposure before allowing another paid action. Then make telemetry ingestion preserve explicit zero and reconcile replay/temporality without losing legitimate out-of-order deltas. Add regression cases at the HTTP-ingest boundary, where direct-SQL smoke did not see these failures. Retain current Manual behavior and receipt checks. Actual provider meter/invoice conformance must precede any accepted-result dollar ranking.

All findings above retain their competing explanations and evidence limits. No claim of cheaper coding, improved quality, human acceptance or causal token savings is supported by this free audit.

Artifact SHA-256 at handoff:

```text
b299796e728a8d93cf58ec61a13ab32eab4e9267a305e5fe00ce9c0e26013296  audit-fixtures.cjs.txt
f47e4316aea866453f7a1fa2a4889b500685b1387d8b372b59f9062e3ea70db6  fixtures.txt
63a97c1ef7103c7021c6dcdf9692a4c9bd05562755571155b582e3581f301844  pure-tests.txt
39b77f831d52920e43edd6cf615202912f7c14c1eeeab31b859ee932f33e5c00  results.json
```
