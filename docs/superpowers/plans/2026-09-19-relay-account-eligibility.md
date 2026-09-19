# Relay next phase — account-bound eligibility

Prepared on `feat/routing-suggester` after the recovery phase closed ([handoff](2026-09-19-relay-recovery-implementation-handoff.md)), then revised the same day against two primary-source research notes: the [Codex account protocol](../../research/2026-09-19-codex-account-protocol-sources.md) (installed `codex-cli 0.155.1`, its offline-generated types, and `openai/codex` at `rust-v0.155.1`) and [paid-request settlement](../../research/2026-09-19-paid-request-settlement-sources.md) (Anthropic's API and billing documentation and `@anthropic-ai/sdk` 0.68.0 source). This document changes no runtime behaviour and ran no provider. The four decisions that were open in the first draft are made below, each with its reason; they are the author's recommendation and the operator can overrule any of them before implementation starts.

## Implementation status — 2026-09-19

Steps 1 to 5 are implemented and committed on `feat/routing-suggester`; step 6 needed no new renderer code. Read this section before the plan below, because two things landed differently than planned and one part is deliberately unfinished.

| Step | Commit | What landed |
| --- | --- | --- |
| 1 Convert | `52ea866` | Exact moves of the five readers behind required Usage; each diff against its original is import lines only. |
| 3 Codex findings | `e54e396` | Account-bound, paginated model catalog that is never presented as access; every bucket kept; `ordinaryUsageAllowed` stated first; passed reset is stale, never recovered; keyring accounts never served from cache; API-key logins are "not applicable"; stable-surface handshake; outgoing method set pinned by test. Parsing moved to `src/shared/codex-account.ts`. |
| 3 DISC-05 | `98bf2e0` | Backend catalog cache carries a credential revision (a digest, never stored or sent). |
| 3 DISC-06 | `49c4f25` | Claude resets resolved in the printed zone; no zone means no countdown; "last-known usage" kept verbatim beside the windows. |
| 2 and 4 Module and gate | `002cc94` | Required `account-eligibility` module; login read before the synchronous stretch of both launch paths, account re-resolved inside it and required to match. |
| 5 Settlement | `cc64311`, hardened by `5940e8d` | `usage_paid_settlements` sibling table; response facts recorded at the transport; Improve prompt and the learning CLI account for their own receipts; Recovery treats only accounted-for receipts as resolved. |

**Narrowed from decision 2.** The plan said unattended work refuses when the login cannot be verified at all. It does not. A CLI too old to answer `auth status --json` or `account/read` is indistinguishable from a failed read, and refusing on it would stop every queue on a guess, while a false allow only lets the CLI fail as it does today. Unattended work is refused on evidence only: signed out, `ordinaryUsageAllowed` false, or a different login than the one a person last confirmed. An unverifiable login is said and recorded. Attended launches are never refused, because starting a session is how a signed-out account signs in; the person is told in the session's account note.

**"The reading the decision was made on" became "the login a person last confirmed".** Only an attended launch by an identified, signed-in login moves the confirmation. A swapped login therefore stays refused for unattended work until somebody has launched on it and seen the note, rather than passing on the second attempt. The stored value is a digest of what the provider reported, never an email. A plan change is not a different person and is left out of it.

**Unfinished on purpose: three owner links.** A receipt is accounted for when the provider itself answered with an error and its request id (`not-charged-provider-stated`, direct `api.anthropic.com` responses only, since an error relayed by a proxy behind `ANTHROPIC_BASE_URL` is not the provider speaking), when an owning ledger recorded the meters (`metered`), or when a CLI reported a cost (`reported-estimate`). Since `5940e8d` every outcome is bound to its receipt, response and the owner's recorded meters under an evidence hash that Recovery recomputes, so a missing, changed or mismatched owner row accounts for nothing. Each owning ledger is named in [the evidence contract](../../../src/main/paid-operation-evidence.ts) with the columns that are its meters. Three are linked: Improve prompt, the learning CLI, and Companion, which was converted into a module first (`ae89fbf`) and then linked. Three are **not**: legacy interviews, batch submission and the dry-run sample request. They live in unconverted `src/main` files, and AGENTS.md requires converting each before changing it. Until then their successful requests are recorded as answered with no recorded meters and still refuse a restore. Interviews keep only totals and the dry-run sample keeps no ledger at all, so each needs a per-request row before it can be linked, not only a call to the helper.

**Latency added to every launch.** An attended Codex launch now waits on the status read (reused for 45 seconds when the login is file-witnessed) and an attended Claude launch on `claude auth status --json`. Neither was measured against a live CLI in this phase.

**Not exercised live.** No reader was run against a real account during implementation; every behaviour above is proven with protocol doubles, real SQLite and real harmless processes. The Codex shapes come from the installed binary's offline type generator. The pagination loop has only ever seen fixture pages, because one page is the whole list today.

## Outcome

Before Wanigan starts work on an account — attended, queued, scheduled or relayed — it can say which login would run it, whether that login is signed in now, what allowance the provider reported and when, and it says "unknown" wherever it cannot. A reading taken under one login never authorises a launch under another, and the check is made again at the moment of dispatch and spawn, not only at preview.

This phase has a **$0 provider-spend scope**. Every read is account-native metadata that starts no thread or turn and consumes no credit. The $50 allowance stays untouched.

## What the research changed

Three assumptions in the first draft did not survive the source, and one capability turned out better than assumed.

- **There are no fractions to preserve.** `usedPercent` is an integer in the protocol and in the backend it comes from. DISC-03's "fractional capacity is lost" has nothing to keep on this path; only its "buckets are lost" half is real. Wanigan's `Math.round` is dead code, and removing it must not be described as restoring precision.
- **`model/list` is not an entitlement.** It is a local catalog filtered only by whether the login is ChatGPT-backed or an API key. That is why the audit's signed-out account returned the same five models. It can be shown as "the catalog this client would offer", never as access.
- **A file stat cannot see every login change.** `cli_auth_credentials_store` may be `keyring`, `auto` or `ephemeral`, and a keyring save deletes `auth.json`. `usageAccountRevision`, shipped in `703c46c`, is necessary but not sufficient: under keyring storage a cached reading can outlive a login change until its time-to-live ends. That is a small live defect this phase closes.
- **A quota read is live and free.** `account/rateLimits/read` is a dedicated backend request needing no inference. It returns every named bucket in `rateLimitsByLimitId`, credits, the backend's own `accountId`, and an `ordinaryUsageAllowed` verdict whose type comment says clients must not infer recovery from percentages or reset times. Server notifications exist but follow only a turn or login on the same connection, so they cannot replace a short poll.

## Where the audit's findings stand

| Finding | Status | What remains |
| --- | --- | --- |
| DISC-01 default Codex account probes the ambient login | Closed for status by `703c46c` | `requestModels` still reads the ambient `CODEX_HOME`; bind it with `accounts.applyLaunchEnv` as `request` already is. |
| DISC-02 model list unbound and unpaginated | Open | Key by account and login revision; follow `nextCursor` to `null` under a page bound. One page is the whole list today, so the loop is proven by fixture only and must say so. |
| DISC-03 buckets and fractions lost | Half real | Read `rateLimitsByLimitId`, falling back to `rateLimits`. Keep every bucket as reported. `normalModelSlug` is the only provider-stated link from a bucket to a model; label inference stays forbidden. |
| DISC-04 quota cache survives a reset | Partly closed | A passed `resetsAt` makes a reading stale, never recovered. `ordinaryUsageAllowed` outranks percentages; `null` is unknown, never true. |
| DISC-05 backend catalog misses a credential change | Open | Add the credential callback's revision to the cache key without reading the credential on a hit. |
| DISC-06 Claude's cached usage shown as fresh | Partly closed | Carry provider-reported age and an explicit timezone basis; when the text gives none, the reset is unknown rather than local midnight. |

## Decisions

**1. A new required module owns eligibility; Usage keeps the readers.** The check has to run where the queue dispatches and where a session spawns, and both of those are required modules. Relay is optional, and an optional module cannot own a refusal that protects somebody's allowance. Usage's declared reason is exposing recorded evidence and readings, which is a different promise from authorising a launch. So: the readers are converted behind required Usage, and a new required `account-eligibility` module owns the record and the refusal, with a declared reason that it decides whether a named login may be used, which a third party must not be able to redefine.

**2. No age threshold. Re-read at the point of use, and refuse only on evidence.** Because the Codex quota read is live and free, reasoning from a cached window is strictly worse than reading again, so the first draft's "how stale is too stale" question dissolves. At dispatch and at spawn Wanigan re-reads `account/read` and the rate limits. It refuses when the login is signed out, when the backend `accountId`, email or plan differs from the reading the decision was made on, or when `ordinaryUsageAllowed` is `false`. It does **not** refuse because quota is unknown: Claude has no equivalent free quota read, so unknown is that harness's normal state, and refusing on it would stop every existing Claude queue. Unknown is recorded and shown. The one asymmetry is identity: unattended work (queue, schedule, automatic Relay) refuses when the login cannot be verified at all, while an attended launch warns and lets the person who is present decide. A cached reading is for display only and carries its age. A refusal never re-routes to another account, because that spends a different person's allowance.

**3. The settlement contract is in this phase, as a sibling table, and nothing ages out.** Without it, one paid call refuses restore for the life of the installation, which makes restore unusable in practice. A new additive `usage_paid_settlements` row points at a receipt; the receipt itself is never updated. Three outcomes may account for a receipt:

- `metered` — a 2xx response, recorded with the provider's `request-id` and the id of the owner's ledger row. The dry-run sample request in `batch/estimate.ts` has no ledger today and needs an owner row first.
- `not-charged (provider-stated)` — an HTTP error response that carried a `request-id`. Anthropic's help centre states failed requests are not charged; the label names that source rather than asserting zero.
- `reported-estimate` — a CLI result. Anthropic documents `total_cost_usd` and the OpenTelemetry cost metric as client-side estimates, and as not relevant to billing under a subscription login, so this is accounted for as an estimate and never shown as a bill.

A transport failure, timeout or cut stream stays unresolved: there is no `request-id`, Anthropic states a request the client abandons is still charged, and no source says how much. The Admin cost report is daily and has no request or API-key dimension, and the usage report counts tokens only, so neither can settle one receipt; at most a later reconciliation can attach a labelled `window-consistent` note that settles nothing. Per-attempt receipts on SDK retries are correct and stay: the SDK source confirms the custom `fetch` runs once per attempt, and there is no idempotency key to make a retry safe. Receipts never expire, because unlike a card authorisation the provider publishes no expiry for an abandoned request.

Rejected: letting an operator acknowledgement unblock restore. The Restore screen already promises that acknowledging a warning cannot reconcile a bill, and that promise is worth more than the convenience. The honest way out for a receipt that can never settle is to **carry it forward across a restore** instead of refusing the restore, since the rule being protected is that a restore must not erase financial uncertainty, not that uncertainty must block. That changes Recovery's first-protocol refusal of cross-generation merging, so it is recorded here as the proposed following step and is not part of this phase.

**4. Convert first, in small commits, from the current head.** The working tree is clean and `origin` has not moved, so the concurrent session is idle, but it has edited exactly these files. File moves conflict worst with concurrent edits, so they go first and stay small. Recheck `git status` and the branch before every commit, as the recovery phase did.

## Order of work

1. **Convert.** Move `codex-status.ts`, `claude-limits.ts`, `limits.ts`, `usage-account-identity.ts` and `backend-catalog.ts` behind required Usage as exact moves with their facades retained, the way `b9e6f2b` moved the Anthropic helper. `unconverted-fixes.json` is empty and nothing here meets the urgent-fix escape's three conditions, so the escape is not available.
2. **Register `account-eligibility`** as a required module with its reason, an additive per-account reading table (account id, harness, login revision and whether that revision can witness a login change, auth state, `requiresOpenaiAuth`, backend `accountId`, plan, every bucket as reported, `ordinaryUsageAllowed`, reset, provider-reported age, local fetch time, the `codex --version` that produced it) and an explicit unknown per field. It stores no credential.
3. **Close the findings** in the table above against that record. For an `apiKey` Codex account, a rate-limit read refused with "chatgpt authentication required" means quota is not applicable, not a fault and not zero.
4. **Gate dispatch and spawn** per decision 2.
5. **Settlement** per decision 3, then let Recovery's reader treat an accounted-for receipt as resolved.
6. **Surface it** in Usage and the Relay composer from the shared primitives, with before and after screenshots in both themes.

## Protocol hygiene

Send `initialize` without `experimentalApi` and follow it with `initialized`; keep every field optional at the parse seam; pass `excludeResetCreditDetails: true` on background polls. Hold the no-mutation invariant by test: the reader's outgoing method set is exactly `initialize`, `initialized`, `account/read`, `account/rateLimits/read` and `model/list`, and `refreshToken` is always `false`. Methods that consume reset credits, send nudge emails, log out or start a login sit beside these reads and must never be sent. The protocol has no version number, so a `src/shared` contract test is built from the JSON Schema generated for the pinned version. Regenerating that schema is offline and belongs in the probe scripts, not in `npm test`.

## What stays unsupported, and says so

Live Claude quota, OpenRouter authentication and caps, real MCP handshakes, provider 402 and 429 recovery, whether two accounts share an allowance pool, whether the remote model catalog varies by plan, production `limitId` values beyond `codex` and `codex_other`, the format of `credits.balance`, and any Codex version other than 0.155.1. Public catalog prices stay separate from account access and from observed execution. No automatic routing on "largest remaining quota".

## Tests and verification

Pure contracts in `src/shared`: multi-bucket parsing, integer percentages, reset-passed staleness, `ordinaryUsageAllowed` precedence, timezone-unknown, cursor exhaustion and the page bound, and the settlement outcome rules. Reader tests with replaced process and network collaborators, extending `scripts/test-usage-accounts.cjs`: a signed-out catalog grants nothing; a changed `accountId` under an unchanged file revision invalidates a reading; two accounts never share a cache entry; the outgoing method set is exact. Dispatch and spawn refusal in the execution-recovery lane with a synthetic CLI. Settlement against real SQLite with a fetch double, extending `scripts/test-usage-paid-operations.cjs`. Then all eight `npm test` gates, `npm run build`, the affected probes and `git diff --check`. Run `npm test` on its own: its smoke gate fails at once with `script: tcgetattr/ioctl` when launched from a shell command that also contains a heredoc.
