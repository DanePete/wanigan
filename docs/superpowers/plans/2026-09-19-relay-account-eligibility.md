# Relay next phase — account-bound eligibility

Prepared from `be64bb4` on `feat/routing-suggester`, after the recovery phase closed ([handoff](2026-09-19-relay-recovery-implementation-handoff.md)). This is a source-grounded plan. It changes no runtime behaviour and ran no provider. **It is a proposal awaiting approval, not an approved scope**: the recovery plan's last section names this phase in one paragraph, and the decisions in "Open decisions" below are the operator's.

## Outcome

Before Relay offers or queues a route, Wanigan can say which account would run it, whether that account is signed in now, which models that login was actually offered, what allowance it reported, how old that reading is and when it resets — and says "unknown" wherever it cannot. A reading taken under one login never authorises a launch under another, and a decision made at preview is rechecked when the queued work actually starts.

This phase has a **$0 provider-spend scope**. Every read below is an account-native metadata read (`account/read` with `refreshToken:false`, `account/rateLimits/read`, `model/list`, `claude auth status`) or a local fixture. No inference, thread, turn or credit consumption. The $50 allowance stays untouched.

## Where the audit's findings stand today

The audit's findings are [DISC-01 to DISC-06](../../research/2026-09-19-relay-audit-execution-discovery.md). `703c46c` landed concurrent Usage/account-identity work after the audit, so its status lines are out of date. Checked against source at `be64bb4`:

| Finding | Status | Evidence in source |
| --- | --- | --- |
| DISC-01 default Codex account probes the ambient login | **Closed** | `codex-status.ts` `request(account)` builds the probe environment with `accounts.applyLaunchEnv`, the same call a launch uses; "default" now means the variable is unset. |
| DISC-02 Codex model list has no account binding or pagination | **Open** | `readCodexModels` keeps one process-global `modelsCached`. No account, no login revision, no cursor loop. The audit's own negative control — a signed-out account returning the full catalog — is why a catalog hit must never read as access. |
| DISC-03 quota buckets and fractions are lost | **Open** | `windowFrom` applies `Math.round` to `usedPercent`; the snapshot keeps only `primary` and `secondary`, so additional named buckets are dropped. |
| DISC-04 quota cache survives a reset or failed refresh | **Partly closed** | The cache key now includes `usageAccountRevision`, so a login change invalidates it. A cached window whose `resetsAt` has passed is still served until `CACHE_MS`. |
| DISC-05 backend catalog cache misses an out-of-band credential change | **Open** | `backend-catalog.ts` keys its cache by backend id only. |
| DISC-06 Claude's provider-cached usage becomes a fresh local reading | **Partly closed** | `claude-limits.ts` is keyed by login revision. Provider-reported age and reset timezone are still not carried. |

`usage-account-identity.ts` (`usageAccountRevision`) is the credential-generation key this phase needs. It hashes file identity and ordinary account metadata, never a credential. Reuse it; do not write a second one.

## Order of work

**1. Convert first.** `codex-status.ts`, `claude-limits.ts`, `limits.ts`, `usage-account-identity.ts` and `backend-catalog.ts` are legacy files in `src/main/`, reached through required Usage's facade. AGENTS.md requires the conversion and the change as two commits in that order. Move them behind required Usage (or a required `accounts-eligibility` module if Usage's trust reason does not cover launch authorisation — see decisions) as exact moves with the original facades retained, the way `b9e6f2b` moved the Anthropic helper. `unconverted-fixes.json` is empty, and this phase is not urgent by any of its three conditions, so the escape is not available.

**2. One eligibility reading, owned by one module.** A typed, main-only record per account: account id, harness, login revision, auth state, plan, model ids *offered to that login*, every quota bucket with its unrounded value, provider reset time, provider-reported age, local fetch time, and an explicit `unknown` per field. It is evidence, so it is additive in SQLite with the source and time of each observation; it is not a second copy of provider memory and stores no credential or email beyond what `AccountIdentity` already carries.

**3. Close the open findings against that record.**
- DISC-02: key the model cache by account and login revision; follow `nextCursor` to exhaustion with a bounded page count; a signed-out or failed `account/read` yields *no* model access whatever `model/list` returned.
- DISC-03: keep fractions end to end and keep every bucket the provider names. Do not infer which model draws on which bucket from a label; show buckets as reported.
- DISC-04: a window whose reset time has passed is stale regardless of cache age; a failed refresh keeps the old reading labelled stale with its failure, never silently as current.
- DISC-05: add the credential callback's revision to the backend catalog key, without reading the credential on a cache hit (the existing callback design already avoids that).
- DISC-06: carry provider-reported age and an explicit timezone basis for Claude resets; when the text gives none, the reset is unknown rather than local-midnight.

**4. Revalidate at the point of use.** Relay's preview, the queue's dispatch and the actual spawn each check the reading's login revision, age and reset against the account about to launch. A mismatch refuses with the reason; it never silently re-routes to another account, because that spends a different person's allowance.

**5. Surface it.** Usage and the Relay composer show age, reset, buckets and unknowns from the shared primitives (`Stat`, `Reading`, `Note`, `Pill`), with before/after screenshots in both themes.

## What stays unsupported, and says so

Live Claude quota, OpenRouter authentication and caps, real MCP handshakes, provider 402/429 recovery, and whether two accounts share an allowance pool are unverified by the audit and are not claimed here. Public catalog prices stay separate from account access and from observed execution. No auto-routing on "largest remaining quota".

## Interaction with the recovery phase

`usage_paid_operations` has no settlement contract, so any paid call refuses a later restore. This phase is the natural owner of that contract: an eligibility record that knows the account and the owning ledger can say when a receipt is accounted for. Treat it as a stated follow-on inside this phase, not a quiet change to Recovery's conservative read.

## Tests and verification

Pure parsing and freshness contracts in `src/shared` (`node --test`): multi-bucket and fractional values, reset-passed staleness, timezone-unknown, cursor exhaustion and the page bound. Reader tests with replaced process and network collaborators, extending `scripts/test-usage-accounts.cjs`: signed-out catalog grants nothing; login change mid-read is refused; two accounts never share a cache entry. Queue revalidation in the execution-recovery lane with a synthetic CLI. Then all eight `npm test` gates, `npm run build`, the affected probes and `git diff --check`. Run `npm test` on its own: its smoke gate fails at once with `script: tcgetattr/ioctl` when launched from a shell command that also contains a heredoc.

## Open decisions

1. **Which module owns eligibility.** Required Usage (it already owns recorded metering and these readers' facade) or a new required module whose declared reason is launch authorisation. A new module is cleaner for the trust reason; extending Usage is fewer moving parts.
2. **How stale is too stale to launch.** A refusal threshold for quota age at dispatch, versus warn-and-proceed. The audit gives no number.
3. **Whether the settlement contract is in this phase** or deferred again, given it decides whether restore is usable day to day.
4. **Coordination.** A concurrent session is editing these same files (`703c46c`, `d640a23`). This phase should start from an agreed commit, not alongside in one checkout.
