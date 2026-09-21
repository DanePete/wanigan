# Codex app-server account protocol — primary sources

Researched 2026-09-19 for the [account-bound eligibility plan](../superpowers/plans/2026-09-19-relay-account-eligibility.md) and findings DISC-01 to DISC-06 in the [execution and discovery audit](2026-09-19-relay-audit-execution-discovery.md). Read-only: no source was edited, no thread or turn was started, no token was refreshed, no login or logout was performed and no credit was consumed.

## Outcome

Three of the plan's assumptions do not survive the source. **The v2 protocol has no fractional percentages**: `usedPercent` is an `i32`, rounded inside Codex before it reaches the wire, and the dedicated usage endpoint it comes from is itself integer-typed — so DISC-03's "keep fractions end to end" has nothing to keep on this path, and only the bucket half of that finding is real. **`model/list` is not an account entitlement**: it is a locally sliced catalog (bundled, disk-cached, or fetched from `/models`) filtered only by whether the login is a ChatGPT-backed one, which is exactly why a signed-out account returned the same five models. **A file stat cannot see every login change**: `cli_auth_credentials_store` may place credentials in the OS keyring, keyed by a hash of the `CODEX_HOME` path, and a keyring save *deletes* `auth.json`.

The rest is good news. `account/rateLimits/read` is a dedicated backend GET that costs no inference and is therefore fresh on demand; it already returns every named bucket in `rateLimitsByLimitId`, plus credits, an `ordinaryUsageAllowed` verdict and the backend's own `accountId`. Notifications exist but cannot replace polling for a short-lived probe. The protocol ships an official, offline schema generator, and the types below were generated from the installed binary.

## Provenance

| What | Value |
| --- | --- |
| Installed binary | `codex-cli 0.155.1` at `/opt/homebrew/bin/codex` |
| Generated types | `codex app-server generate-ts [--experimental] --out <tmp>` and `generate-json-schema --experimental --out <tmp>`, run offline into a scratch directory; 627 v2 type files |
| Repository source | `openai/codex` tag `rust-v0.155.1`, commit `be2951ea34f0d295ed0becf97079f92fa5f6950e` (sparse clone) |
| Official docs | `https://developers.openai.com/codex/app-server` and `/codex/auth`, fetched 2026-09-19. Both now answer `308` to `https://learn.chatgpt.com/docs/app-server` and `/docs/auth`; the redirect is server-supplied and the target identifies OpenAI as publisher. The docs track a newer build than 0.155.1 (see Q3), so where they differ from the generated types, the generated types describe what is installed. |

Source URLs below are of the form `https://github.com/openai/codex/blob/rust-v0.155.1/<path>`; only the path is given.

`codex-rs/app-server/README.md` at this tag no longer documents any of these methods (it covers user verification, hosted Apps MCP, thread removal, Bedrock and thread attachments). The method reference has moved to the official docs page. Do not cite the README for account methods.

## 1. `model/list`

**Established.**

Params and response, generated from the installed binary (`v2/ModelListParams.ts`, `v2/ModelListResponse.ts`):

```ts
export type ModelListParams = {
  cursor?: string | null,        // Opaque pagination cursor returned by a previous call.
  limit?: number | null,         // Optional page size; defaults to a reasonable server-side value.
  includeHidden?: boolean | null // include models hidden from the default picker list
};
export type ModelListResponse = { data: Array<Model>, nextCursor: string | null };
// nextCursor: "If None, there are no more items to return."
```

JSON Schema types `limit` as `uint32`, minimum 0.

It is paginated in form, and the implementation is a slice over an in-memory list — `codex-rs/app-server/src/request_processors/catalog_processor.rs`, `list_models`:

```rust
let effective_limit = limit.unwrap_or(total as u32).max(1) as usize;
let effective_limit = effective_limit.min(total);
let start = match cursor { Some(cursor) => cursor.parse::<usize>()..., None => 0 };
...
let next_cursor = if end < total { Some(end.to_string()) } else { None };
```

So: the **default page size is the whole list** (omit `limit` and one call returns everything); there is **no maximum** other than the list length; `limit: 0` is clamped to 1; the cursor is a stringified offset today but is documented as opaque; the end is signalled by `nextCursor: null`; an unparsable or out-of-range cursor is a JSON-RPC invalid-request error.

Per-model fields (`v2/Model.ts`): `id`, `model`, `upgrade`, `upgradeInfo { model, upgradeCopy, modelLink, migrationMarkdown, retirementAt }`, `availabilityNux { message }`, `displayName`, `description`, `modelSpecialty`, `hidden`, `supportedReasoningEfforts: Array<{ reasoningEffort, description }>`, `defaultReasoningEffort`, `inputModalities`, `supportsPersonality`, `multiAgentVersion`, `additionalSpeedTiers` (deprecated), `serviceTiers: Array<{ id, name, description }>`, `defaultServiceTier`, `isDefault`. The docs add that a missing `inputModalities` from an older catalog should be read as `["text", "image"]`.

Account dependence — `codex-rs/app-server/src/models.rs` calls `list_models(RefreshStrategy::OnlineIfUncached, …)` and filters by `show_in_picker`. In `codex-rs/models-manager/src/manager.rs`:

- `should_refresh_models()` is true only when the endpoint uses the Codex backend, has command auth, or API-key discovery is on. Otherwise no request is made and the list is the disk cache (`models_cache.json` under `CODEX_HOME`) or the catalog bundled in the binary ("backed by bundled models, cache, and `/models`").
- When it does fetch, the cache entry carries an "opaque provider and auth identity" and an entry whose identity does not match the current endpoint is a miss.
- The only auth filter on the result is `ModelPreset::filter_by_auth`: "In ChatGPT mode, all models are visible. Otherwise, only API-supported models are shown."
- `isDefault` is recomputed locally: the first picker-visible model wins.

This explains the audit's negative control. A signed-out `CODEX_HOME` has no backend to ask, so it serves the bundled or cached catalog. The list is a *catalog the client would show in a picker*, never a statement that this login may run the model.

**Wanigan differs.** `requestModels` sends `limit: 200`, reads one page and ignores `nextCursor`. With today's implementation 200 exceeds the list, so nothing is lost in practice, but the contract permits a server-side cap later. It spawns with `probeEnv` only and never calls `accounts.applyLaunchEnv`, so it reads the ambient `CODEX_HOME` whatever account is selected, into one process-global cache. It drops `hidden`, `upgrade`, `upgradeInfo`, `serviceTiers` and `availabilityNux`.

**Not established.** Whether the remote `/models` response differs by plan or workspace (the cache identity implies it can; no source here says how). The bundled catalog's contents for 0.155.1 were not enumerated.

## 2. `account/rateLimits/read`

**Established.** Generated types (`v2/GetAccountRateLimitsResponse.ts`, `RateLimitSnapshot.ts`, `RateLimitWindow.ts`, `CreditsSnapshot.ts`):

```ts
export type GetAccountRateLimitsResponse = {
  ordinaryUsageAllowed: boolean | null, // "Null means unavailable; clients must not infer recovery from percentages or reset times."
  rateLimits: RateLimitSnapshot,        // "Backward-compatible single-bucket view"
  rateLimitsByLimitId: { [key in string]?: RateLimitSnapshot } | null, // "keyed by metered `limit_id` (for example, `codex`)"
  rateLimitResetCredits: RateLimitResetCreditsSummary | null,
  accountId: string | null,             // "Account associated with this usage snapshot, when supplied by the backend."
  rateLimitUpsell: JsonValue | null,
};
export type RateLimitSnapshot = {
  limitId: string | null, limitName: string | null,
  normalModelSlug: string | null,       // "Normal model whose display name and reasoning options describe this quota alias."
  primary: RateLimitWindow | null, secondary: RateLimitWindow | null,
  credits: CreditsSnapshot | null, individualLimit: SpendControlLimitSnapshot | null,
  spendControlReached: boolean | null,  // "`None` is unavailable, not a sparse-update recovery."
  planType: PlanType | null, rateLimitReachedType: RateLimitReachedType | null,
};
export type RateLimitWindow = { usedPercent: number, windowDurationMins: number | null, resetsAt: number | null };
export type CreditsSnapshot = { hasCredits: boolean, unlimited: boolean, balance: string | null };
```

- **More buckets than two: yes.** Each snapshot has a `primary` and `secondary` window, and there is one snapshot per metered limit in `rateLimitsByLimitId`. The docs' example shows `codex` and `codex_other`. `rateLimits` is the `codex` entry, or the first if none is named `codex` (`account_processor.rs`, `get_account_rate_limits_response`). Additional buckets may carry `normalModelSlug`, which is the provider's own statement of which model a quota alias describes — the only sanctioned bucket-to-model link.
- **`usedPercent` is an integer.** JSON Schema: `{"format": "int32", "type": "integer"}`. Rust, `codex-rs/app-server-protocol/src/protocol/v2/account.rs`: `pub used_percent: i32` with `used_percent: value.used_percent.round() as i32`. The core type is `f64` (`codex-rs/protocol/src/protocol.rs`, "Percentage (0-100) of the window that has been consumed"), and response *headers* are parsed as `f64`, but the usage endpoint this method reads is integer at the origin: `codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs` has `pub used_percent: i32`. No fraction exists on this path at any layer.
- **`resetsAt`** is absolute Unix **seconds** (`int64`, nullable). Core comment: "Unix timestamp (seconds since epoch) when the window resets"; docs: "`resetsAt` is a Unix timestamp (seconds) for the next reset". The backend also has a relative `reset_after_seconds`, which Codex discards.
- **`windowDurationMins`** is the window length in minutes (`int64`, nullable), derived from the backend's `limit_window_seconds` rounded **up** to a whole minute, and `null` when the backend reports zero or less (`backend-client/src/client.rs`, `window_minutes_from_seconds`).
- **Credits.** `hasCredits`, `unlimited` and `balance` (a string, nullable) pass through from the backend's credit status. Docs: "`credits` is included when the server returns remaining workspace credit details." The unit and format of `balance` are not stated anywhere inspected. `individualLimit { limit: string, used: string, remainingPercent: int32, resetsAt: int64 }` is a per-person spend control. `rateLimitReachedType` is one of `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`.
- **Params** are optional: `supportsLunaReserve` ("allow the backend to record experiment exposure after ordinary usage is blocked" — a passive reader must leave this false; the backend client comments "Opt in only for clients that can apply Reserve, not for passive account usage readers") and `excludeResetCreditDetails` ("Skip the separate reset-credit detail lookup for background usage polls").
- **Signed out or API-key login is an error, not an empty result**: `"codex account authentication required to read rate limits"` and `"chatgpt authentication required to read rate limits"`. An empty backend answer is also an error ("no snapshots returned").
- `ordinaryUsageAllowed` and `rateLimitUpsell` are returned only when the backend's `account_id` and `user_id` both match the active login; `accountId` is passed through unfiltered.

**Wanigan differs.** `snapshot()` reads only `rateLimits.primary` and `.secondary`, so every other bucket, `credits`, `individualLimit`, `rateLimitReachedType`, `ordinaryUsageAllowed`, `accountId`, `limitId` and `limitName` are dropped. `windowFrom`'s `Math.round` is a no-op on an integer, not a loss. `resetsAt * 1000` is correct. Sending `params: null` is accepted (the schema is `NullableGetAccountRateLimitsParams`) and, because `excludeResetCreditDetails` defaults to false, each poll also makes the second reset-credit detail request.

**Not established.** The set of `limitId` values in production beyond the documented `codex` and `codex_other`; the format of `credits.balance`; whether `accountId` is populated for every plan.

## 3. `account/read`

**Established.** Generated types:

```ts
export type GetAccountParams = { refreshToken?: boolean };
// "When `true`, requests a proactive token refresh before returning. In managed auth mode this
//  triggers the normal refresh-token flow. In external auth mode this flag is ignored."
export type GetAccountResponse = { account: Account | null, requiresOpenaiAuth: boolean };
export type Account =
  | { "type": "apiKey" }
  | { "type": "chatgpt", email: string | null, planType: PlanType }
  | { "type": "amazonBedrock", usesCodexManagedCredentials: boolean };
export type PlanType = "free" | "go" | "plus" | "pro" | "prolite" | "team"
  | "self_serve_business_prolite" | "self_serve_business_usage_based" | "business" | "ent26"
  | "enterprise_cbp_automation" | "enterprise_cbp_usage_based" | "enterprise"
  | "edu" | "edu_plus" | "edu_pro" | "unknown";
```

Signed out is `account: null`. The docs give both `{ "account": null, "requiresOpenaiAuth": true }` and `{ "account": null, "requiresOpenaiAuth": false }` and explain: "`requiresOpenaiAuth` reflects the active provider; when `false`, Codex can run without OpenAI credentials." So `account: null` means *no OpenAI login*, which is "cannot launch" only when `requiresOpenaiAuth` is true. `email` "is `null` when the ChatGPT account doesn't have an email address". The handler reloads the latest config before answering (`get_account_response` calls `load_latest_config`).

The docs describe the Bedrock variant with `credentialSource: "codexManaged" | "awsManaged"`; the installed 0.155.1 has `usesCodexManagedCredentials: boolean`. That is direct evidence the shape moves between releases and that the published docs lead the installed build.

**Wanigan differs.** `accountIdentity` treats `account: null` as `signed-out` without reading `requiresOpenaiAuth`, and treats any non-empty `type` as signed in, including `apiKey` — for which `account/rateLimits/read` then returns an error by design, not a fault. `refreshToken: false` is correct and is what keeps the read side-effect free.

**Not established.** Nothing material.

## 4. Server notifications

**Established.** `ServerNotification.ts` for the installed version names three account notifications, all on the stable (non-experimental) surface:

```ts
"account/updated"            -> { authMode: AuthMode | null, planType: PlanType | null }
"account/rateLimits/updated" -> { rateLimits: RateLimitSnapshot }
"account/login/completed"    -> { loginId: string | null, success: boolean, error: string | null, onboardingEntrypoint: ... | null }
```

`AuthMode` is `"apikey" | "chatgpt" | "chatgptAuthTokens" | "headers" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey" | "bedrockAccessKeys"`. There is no per-model or `model/list` change notification; `model/rerouted`, `model/verification` and `model/safetyBuffering/updated` are thread-scoped.

The generated doc comment on `AccountRateLimitsUpdatedNotification` is the contract: "Sparse rolling rate-limit update. Clients should merge available values into the most recent `account/rateLimits/read` response or refetch that snapshot. Nullable account metadata may be unavailable in a rolling update and does not clear a previously observed value."

Where they come from decides whether they help:

- `account/rateLimits/updated` is emitted from `handle_token_count_event` in `codex-rs/app-server/src/bespoke_event_handling.rs` — that is, from a **turn's** token-count event, carrying limits parsed from inference response headers. It carries one snapshot, not the by-id map. A connection that runs no turn never receives one.
- `account/updated` is emitted by `account_processor.rs` after a login or logout performed **through that same app-server**. `AuthManager`'s own doc comment (`codex-rs/login/src/auth/manager.rs`) says: "External modifications to `auth.json` will NOT be observed until `reload()` is called explicitly." A login made by another process — `codex login` in a terminal — raises nothing.

**Consequence.** For Wanigan's short-lived, read-only probe these notifications never fire. They cannot replace polling. They would become useful only if Wanigan held a long-lived app-server per session that ran the turns, which it does not: sessions are PTY launches of the CLI.

**Not established.** Whether any notification fires on a backend-side plan change with no local action. None was found.

## 5. Where Codex gets rate-limit data

**Established.** Two separate paths.

1. **Dedicated endpoint (what `account/rateLimits/read` uses).** `codex-rs/backend-client/src/client/rate_limit_resets.rs`: a `GET` to `{base}/wham/usage` (ChatGPT path style; the test fixture is `https://chatgpt.com/backend-api/wham/usage`) or `{base}/api/codex/usage`. Every call is a live request with the login's credentials; the handler keeps no cache. The payload includes `rate_limit`, `additional_rate_limits`, credits, reset credits, `account_id` and `user_id`. With details not excluded, a second GET goes to the reset-credits endpoint.
2. **Inference response headers (what feeds the notification and the TUI during a turn).** `codex-rs/codex-api/src/rate_limits.rs` parses `x-codex-primary-used-percent`, `-primary-window-minutes`, `-primary-reset-at`, the `secondary` equivalents and `-limit-name`, with the prefix derived from the limit id (`codex_other` becomes `x-codex-other-…`).

So a read with no recent inference is **not** stale or empty: it is a fresh backend answer at no inference cost. How fresh the *backend's* number is — whether `/wham/usage` lags a turn that finished a second ago — is not stated in any source inspected.

Note the method list also contains `account/rateLimitResetCredit/consume` and `account/sendAddCreditsNudgeEmail`. Both mutate or spend. `codex-status.ts` sends neither, and the header comment's promise ("no reset/consume operation") should be kept as a tested invariant now that the mutating method demonstrably exists beside the read.

**Not established.** Backend-side latency or caching of the usage endpoint; any rate limit on polling it.

## 6. `CODEX_HOME`, credential storage and what a file stat can see

**Established.** `codex-rs/config/src/types.rs`:

```rust
/// Determine where Codex should store CLI auth credentials.
pub enum AuthCredentialsStoreMode {
    #[default]
    /// Persist credentials in CODEX_HOME/auth.json.
    File,
    /// Persist credentials in the keyring. Fail if unavailable.
    Keyring,
    /// Use keyring when available; otherwise, fall back to a file in CODEX_HOME.
    Auto,
    /// Store credentials in memory only for the current process.
    Ephemeral,
}
```

The config key is `cli_auth_credentials_store`, documented on the official auth page with the same four values, and "Admins can enforce `cli_auth_credentials_store` … through local authentication requirements. Users can't override those". The default is `file`. This machine's `~/.codex/config.toml` does not set it.

`codex-rs/login/src/auth/storage.rs`: the keyring service is `"Codex Auth"` and the entry key is `cli|` plus the first 16 hex characters of SHA-256 of the **canonicalised `CODEX_HOME` path**. So `CODEX_HOME` selects the login in every mode — by directory in `file` mode, by path hash in `keyring` mode. A keyring `save` then calls `delete_file_if_exists`, removing `auth.json`. `auto` loads keyring first and falls back to the file.

Separately, `codex-rs/login/src/auth/manager.rs` defines `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` environment sources. App-server constructs its `AuthManager` with `enable_codex_api_key_env: false` (`codex-rs/app-server/src/lib.rs`), and Wanigan's `probeEnv` passes none of them, so the probe is unaffected; a *launched* CLI session whose environment carries one may authenticate differently from what the probe reported.

What `usageAccountRevision` (stat of `auth.json` and `config.toml`) can and cannot detect:

| Situation | Detectable by file stat |
| --- | --- |
| `file` mode: login, logout, account switch, token refresh | Yes — `auth.json` is rewritten. Token refresh also changes it, so the revision moves without the identity changing; that is a harmless extra invalidation. |
| Switching store mode in `config.toml` | Yes — `config.toml` changes. |
| Moving from file to keyring at login | Yes, once — `auth.json` disappears. |
| `keyring` mode, or `auto` with a working keyring: login, logout or account switch thereafter | **No.** Neither file changes. |
| `ephemeral` mode | No, and the login does not outlive the process that made it, so a probe process cannot see it at all. |
| Store mode enforced by managed requirements outside `CODEX_HOME` | No. |
| Environment-supplied credentials on a launched session | No. |

Stat-ing the keyring is not an option and reading it is out of bounds. The detectable signal that survives every mode is the *answer*: `account/read` (type, email, plan) plus the backend's `accountId` from `account/rateLimits/read`.

**Not established.** Whether any first-party tool sets `keyring` or `auto` by default on macOS for new installs (the enum default is `file`; the desktop app's behaviour was not inspected).

## 7. Protocol stability and schema generation

**Established.**

- The whole subcommand is labelled experimental by the binary itself: `codex app-server --help` prints "[experimental] Run the app server or related tooling", and both generators are "[experimental] Generate …".
- Within it there are two tiers, per the official docs: "Some app-server methods and fields are intentionally gated behind `experimentalApi` capability. Omit `capabilities` (or set `experimentalApi` to `false`) to stay on the stable API surface, and the server rejects experimental methods/fields."
- There is **no protocol version number** to negotiate. The v1/v2 split is a source-tree organisation (`protocol/v1.rs`, `protocol/v2/`), and the docs say of the generators: "Each output is specific to the Codex version you ran, so the generated artifacts match that version exactly." The CLI version is the protocol version.
- `codex app-server generate-ts --out <dir>` and `generate-json-schema --out <dir>` exist, take `--experimental` to include the gated surface, and ran offline here without touching the network or the login.
- Diffing the stable and `--experimental` TypeScript output: `model/list`, `account/read`, `account/rateLimits/read`, `account/usage/read` and the three account notifications are all in the **stable** set. The experimental-only account methods are `account/bedrock/discover` and `account/bedrock/setup`.
- The docs specify the handshake as `initialize` followed by an `initialized` notification.

**Wanigan differs.** It sends `capabilities: { experimentalApi: true }` for reads that need none of it, opting into a surface the vendor reserves the right to change, and its comment calls the protocol "versioned". It does not send `initialized`; the reads work without it on 0.155.1, which is observed behaviour and not a documented guarantee.

**Not established.** Any written compatibility promise for the stable tier across releases. The Bedrock field rename in Q3 shows stable-tier response shapes do change.

## Consequences for the eligibility plan

1. **Drop "keep fractions" from DISC-03; keep "keep every bucket".** The wire type is `i32` and so is the backend's. Store `usedPercent` as the integer reported and do not display decimals that were never observed. Remove `Math.round` only because it is dead, and do not describe its removal as restoring precision. Keep the shared type numeric so a future header-fed path, which is `f64`, would not need a migration.
2. **Read `rateLimitsByLimitId`, falling back to `rateLimits` when it is null.** Persist per bucket: `limitId`, `limitName`, `normalModelSlug`, both windows, `credits`, `individualLimit`, `spendControlReached`, `rateLimitReachedType`, `planType`. Show buckets as reported; `normalModelSlug` is the only provider-stated link from a bucket to a model and label inference stays forbidden.
3. **Carry `ordinaryUsageAllowed` as its own field and let it outrank percentages.** The type's own comment forbids inferring recovery from percentages or reset times. `null` is `unknown`, never `true`. This bears directly on DISC-04: a passed `resetsAt` makes a reading *stale*, not *recovered*.
4. **Record the backend `accountId` with each reading and compare it across reads.** It is ordinary account metadata, not a credential, and it is the one login-change signal that works in keyring mode. A changed `accountId`, `email` or `planType` under an unchanged file revision is a login change and must invalidate the reading. Whether storing it fits `AccountIdentity`'s existing bounds is the operator's decision.
5. **File-stat login detection is necessary but not sufficient.** Keep `usageAccountRevision`, and add: read `cli_auth_credentials_store` from the account's `config.toml`; when it is `keyring`, `auto` or `ephemeral`, mark the revision as unable to witness a login change, shorten trust accordingly and say so in the UI rather than presenting the reading as login-bound. The revalidation at dispatch and spawn in the plan's step 4 should then be a fresh `account/read`, not a stat.
6. **Notifications cannot replace polling.** `account/rateLimits/updated` only follows a turn on the same connection and `account/updated` only follows a login made through the same server. Keep the short-lived poll. Do not add a long-lived listener for this phase.
7. **A rate-limit read is fresh and free of inference, so prefer re-reading to extrapolating.** At dispatch, re-read rather than reason from a cached window. Pass `excludeResetCreditDetails: true` on background polls to halve the requests, and never send `supportsLunaReserve`.
8. **Paginate `model/list` anyway, cheaply.** Omit `limit` or keep it, follow `nextCursor` until `null`, bound the loop (the plan's page bound stands), and treat the cursor as opaque. Today one page is always the whole list, so the test must use a fixture; do not claim the loop was exercised live.
9. **Key the model cache by account and login revision, and bind the probe to the account.** `requestModels` must call `accounts.applyLaunchEnv` as `request` does; today it reads the ambient `CODEX_HOME`. Then name the result honestly: it is the *catalog this client would offer*, not access. The plan's rule that a signed-out or failed `account/read` yields no model access is confirmed by source, and should extend to `type: "apiKey"` being a different catalog (`supported_in_api` only) from a ChatGPT login.
10. **Distinguish "signed out" from "no OpenAI login required".** Read `requiresOpenaiAuth`. And treat `account/rateLimits/read` failing with "chatgpt authentication required" for an `apiKey` account as *quota not applicable*, not as a fault or as zero usage.
11. **Stay on the stable surface.** Send `initialize` without `experimentalApi` for these reads, follow it with `initialized`, and keep every field optional at the parse seam. Add a `src/shared` contract test built from the generated JSON Schema for the pinned version, and record the `codex --version` that produced each reading so a shape change is attributable. Regenerating the schema is offline and belongs in the probe scripts, not in `npm test`.
12. **Hold the no-mutation invariant by test.** `account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `account/logout` and `account/login/start` sit beside the reads. Assert that the reader's outgoing method set is exactly `initialize`, `initialized`, `account/read`, `account/rateLimits/read` and `model/list`, and that `refreshToken` is always `false`.

## Not established, collected

- Whether the remote `/models` catalog varies by plan or workspace, and the bundled catalog's contents.
- Production `limitId` values beyond `codex` and `codex_other`; the unit and format of `credits.balance`; whether `accountId` is always populated.
- Backend latency, caching or polling limits for `/wham/usage`.
- Whether any first-party installer defaults to keyring storage on macOS.
- Any cross-release compatibility promise for the stable tier.
- Behaviour of Codex versions other than 0.155.1. Everything above is pinned to that tag.
