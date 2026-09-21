# Relay audit execution: account, catalog, quota and MCP discovery

Executed 2026-09-19 against `324bca7f137198a78583ec9b8cb07cfd1c667c71`.
This report extends the [discovery plan](2026-09-19-relay-audit-capability-discovery.md)
with executed offline evidence. The [integrated audit plan](../superpowers/plans/2026-09-19-relay-deep-audit.md)
owns authorization and the shared $50 ceiling.

**Result:** availability is not yet an input to Relay's model decision. Eight
offline fixture groups reproduced account-binding, cache, quota and freshness
limitations and checked honest unsupported states. Twenty-seven existing pure
catalog/economics/connection tests passed. These results do not establish a
signed-in account's model access or a working hosted coding loop.

No product source, native configuration or credentials were changed by this
discovery subtask. It launched no actual provider CLI, inference request, MCP
connection or billable tool. It used official documentation and repository
source. The coordinator separately owns [native account discovery](relay-audit-2026-09-19/account-discovery.json),
the [environment manifest](relay-audit-2026-09-19/environment.json), and the
[spending ledger](relay-audit-2026-09-19/spending-ledger.json); a failed native
probe is not evidence that an account is signed out.

## Reproduction and evidence

[fixtures.cjs.txt](relay-audit-2026-09-19/discovery/fixtures.cjs.txt) transpiles actual
production TypeScript with TypeScript 5.9.3 and executes it in a VM. Process,
network, account and database collaborators are explicit fixture replacements;
unlisted imports are refused. It pins the fixture process timezone to
America/Chicago and the clock to 2026-09-19. It reads no native account files.

Run from the repository with Node 22.23.2:

```sh
nvm use
node --input-type=commonjs < docs/research/relay-audit-2026-09-19/discovery/fixtures.cjs.txt
node --test src/shared/backend-catalog.test.ts src/shared/model-economics.test.ts src/shared/openrouter-connection.test.ts
```

The [result JSON](relay-audit-2026-09-19/discovery/results.json) contains fixture
inputs, observed outputs, captured RPC requests and source SHA-256 values. Its
assertions verify that the reported observations reproduce; a successful audit
assertion does **not** mean the product satisfies the desired behavior.
[The TAP output](relay-audit-2026-09-19/discovery/contracts.tap) records 27 tests,
27 passes, zero failures. This subset does not replace the coordinator's full
`npm test` baseline.

| Artifact | SHA-256 |
| --- | --- |
| `discovery/fixtures.cjs.txt` | `9fa0becbaad637575427b068e80ec39aa34cd3f729d345d241b565baf895d2dc` |
| `discovery/results.json` | `fb1336053766ef1016c8f2eb524bcfce28b1fef2d04f5c22a31b89b39136c77a` |
| `discovery/contracts.tap` | `bd8d5ff522d3f934d9b20f15cd3ef43a1441225b4e5c28783213d90dc6bb8ea0` |

## Reproduced findings

All findings below use the commit and tool versions above. Their coverage level
is **production code with substituted collaborators**, including pure parser
checks. They are not independent reproductions in native providers or Electron.
P1 means important to truthful availability and a prerequisite for quota-aware
automatic routing; P2 means a bounded stale-data limitation. No paid failure is
claimed.

### DISC-01 — explicit default Codex account can probe the ambient account

**P1, reproduced.** Entry points:
[Codex probe environment and account resolution](../../src/main/codex-status.ts),
[account environment semantics](../../src/main/accounts.ts), and
[session environment application](../../src/main/sessions.ts).

Minimal steps: resolve explicit account A with `accounts.launchEnv(A) = {}`,
matching the platform-default account contract; set fixture ambient
`CODEX_HOME=/fixture/nonselected-ambient-account`; call
`readCodexStatus(false, 'A')`. Expected: probe and session use the same selected
account. Actual: captured status spawn retained the nonselected ambient
directory. The session path calls `accounts.applyLaunchEnv`, which removes that
override for the default account. The probe only merges `launchEnv`.

Evidence: `D01-codex-default-account-inherited-home`. Negative control:
`D01-D04-codex-quota-identity-reset-failure` shows nondefault account directories
override the ambient value and distinct account IDs obtain distinct quota
readings. The mismatch requires an inherited override; it is not evidence that
every default account is wrong. Impact: quota could be attributed to the wrong
login even while launch selection is correct. Owner: required `usage` extension
and its Codex reader, with the required session extension's account contract.

### DISC-02 — Codex model discovery has no selected-account binding or pagination

**P1, reproduced.** Entry points:
[readCodexModels](../../src/main/codex-status.ts) and
[live launch catalogs](../../src/main/launch-choices.ts).

Minimal steps: return model A plus a non-null `nextCursor` for ambient account A;
change ambient identity to B; call `readCodexModels()` again. Expected: complete
model evidence tied to the launch identity. Actual: A remains the answer, no
second spawn occurs, and no cursor request is emitted. `force=true` fetches B but
still drops page two. The API accepts no account ID, and its ten-minute cache
and pending read are global. Input modality metadata also does not survive this
reader's `CodexModel` projection.

Evidence: `D01-codex-model-cache-and-pagination`. The force refresh is a negative
control for a permanently stuck transport. Actual catalogs may fit one page;
this fixture proves omission when a continuation exists, not that the installed
account currently has over 200 models. Impact: wrong/incomplete access or effort
options and avoidable failed work. Owner: launch/catalog discovery extension
point; existing source is outside the module registry and requires conversion
before a nonurgent behavior change.

### DISC-03 — quota buckets and fractional remaining capacity are lost

**P1, reproduced.** Entry points:
[Codex snapshot parser](../../src/main/codex-status.ts),
[account-limit projection](../../src/main/limits.ts), and
[AccountLimits / LimitWindow](../../src/shared/types.ts).

Minimal steps: supply a legacy `codex` bucket at 99.6% and a second bucket at
2.25% in `rateLimitsByLimitId`. Expected: both bucket identities and exact
numeric usage remain available. Actual: only the legacy window survives; its
usage is rounded to 100% and remaining to zero. A map-only response loses both
windows. The account projection assigns null model scope to the retained
windows and has no bucket ID field.

Evidence: `D03-codex-buckets-fractional`. Negative control: an unknown renamed
usage field produces null, not invented zero. Fractional rounding may be fine
for presentation, but the numeric record is also rounded and cannot support a
precise eligibility decision. No current Relay exhaustion decision is claimed:
Relay does not yet consume these readings. Owner: required `usage` extension.

### DISC-04 — quota cache remains reusable across reset and failed refresh

**P2, reproduced.** Entry point:
[readCodexStatus](../../src/main/codex-status.ts). Cache is keyed by account ID
for 45 seconds, without a credential generation or reset-boundary invalidation.

Minimal steps: read A with a reset one second away, advance the fixture clock
two seconds, change A's resolved configuration, then fail a forced read. Actual:
ordinary reads still return the prior snapshot, including its now-past reset;
the failed forced refresh leaves that snapshot available. Expected for routing:
explicitly expired/failed evidence cannot establish current usable allowance.

Evidence: `D01-D04-codex-quota-identity-reset-failure`. Negative control: distinct
account IDs do not share the cache. The original `fetchedAt` is retained, so
this is not a fabricated fetch time. TTL-only caching is a reasonable display
tradeoff; the gap is using that display record as current launch authority.
External consumption and server/client clock skew were not exercised against
a provider. Owner: required `usage` extension and future eligibility extension.

### DISC-05 — backend catalog cache does not detect out-of-band credential change

**P1 for future account eligibility, reproduced at reader boundary.** Entry
point: [backendModels](../../src/main/backend-catalog.ts).

Minimal steps: read backend X under fixture credential A; repeat with B and
then a missing credential before TTL expiry. Actual: both calls return A's
catalog as `source: live` with its original timestamp, without invoking the
credential callback. Expected for selected-account discovery: B and absent
credentials cannot inherit A's account evidence. Cache identity is backend ID
only, for six hours.

Evidence: `D01-backend-cache-credential-change`. Negative control: explicit
`forgetBackendCatalog` yields an honestly published fallback with null fetch
time, and then a fresh B catalog. **The normal generic key UI paths already
mitigate this:** [key save/clear IPC](../../src/main/index.ts) verifies/reseeds on
save and forgets on clear. The fixture does not demonstrate that normal UI key
rotation is broken; it covers another identity, environment change or other
unobserved credential change under one backend ID. Owner: backend catalog
extension point; preserve the existing UI invalidation when converting it.

### DISC-06 — Claude provider-cached usage can become a fresh local reading

**P1, reproduced with human-text fixtures.** Entry points:
[parseUsage, parseResetAt and limitsFor](../../src/main/claude-limits.ts),
[Usage freshness display](../../src/renderer/src/views/Usage.tsx).

Minimal steps: return authenticated fixture identity and human text containing
`Showing last-known usage (50 minutes ago)` plus a valid usage window. Actual:
`limitsFor` returns `state: ok`, `detail: null`, and a current `fetchedAt`; the
provider-age warning is lost. A Tokyo reset at Sep 20, 9pm parses as Chicago
9pm, 14 hours after the correct epoch. Expected: preserve provider age and do
not invent a cross-zone countdown. Raw reset wording is preserved correctly.

Evidence: `D05-claude-provider-age-and-timezone`. Negative control: unrecognized
window text returns no windows; 12.5% remains fractional. The native CLI may
reject print-mode `/usage` entirely; this fixture proves behavior **if** that
text reaches this reader, not native conformance. No `claude -p /usage` was run
here because its no-inference behavior needs independent verification. Owner:
required `usage` extension.

## D01–D12 coverage disposition

| Case | Executed evidence / source result | What remains unknown or blocked |
| --- | --- | --- |
| D01 | DISC-01/02/05 and account/cache controls above. | Actual catalogs for two signed-in identities and revocation behavior belong to native discovery. |
| D02 | Source: Relay candidate/profile proof includes declared model/effort and profile fingerprint; no account-access/quota/MCP evidence is joined. | Account model/tool disappearance between preview, queue and actual spawn is not exercised here. Routing/race fixtures belong to the coordinator's other lane. |
| D03 | DISC-03 executes multi-bucket and fractional parsing. | Live model-to-bucket scope mapping and independent/shared consumption need provider evidence. |
| D04 | DISC-04 executes local reset/failure/cache boundaries. | External-device consumption, server clock skew, and truthful recovery in the native UI remain unexecuted. |
| D05 | DISC-06 executes stale-note and timezone fixtures. | Native print-mode conformance, actual provider cache wording and API/subscription billing behavior are unverified. |
| D06 | `D06-openrouter-local-key-state` executes absent, present and unreadable fixture credentials. Present remains `not-tested`/`unpriced`. | Expired/revoked authentication, zero/null cap, wallet and in-flight headroom need an authenticated metadata adapter/read; no such read was bought or faked. |
| D07 | 27 pure contracts include endpoint tools, effort, capacity, freshness and price constraints. Economics remains public-catalog data. | No user-filtered catalog is joined to Relay; no live tool loop or account/privacy exclusion was verified. |
| D08 | Source: no quota-bucket reservation is present in Relay's candidate path. | Two real goals sharing an allowance and provider 402/429 recovery were not executed by this discovery lane. Global budget tests are separate. |
| D09 | `D09-D10-mcp-status-is-evidence-of-use` confirms historical usage status does not claim connected/authenticated/ready. | No inbound MCP client discovery/OAuth lifecycle in this registry; native authentication, pagination and tool-change invalidation need a supported harness path. |
| D10 | Same fixture preserves completed-call failure counts, including a never-used server with zero recorded calls. | It does not exercise remote `isError`, timeout, cancellation or permission revocation; Wanigan's own MCP server is a separate direction. |
| D11 | Source: registry injects server configuration; Relay has no task-specific external tool manifest or billing reservation join. | Hundreds-of-tools context overhead and billable external MCP calls remain unmeasured. |
| D12 | Source and fixtures preserve OpenRouter manual/unpriced status; exact-model/no-catalog Relay refusal exists. | A unified connect/refresh/wait/paid-alternative explanation cannot be evaluated end-to-end before eligibility and account metadata are joined. |

The MCP boundary is intentional in today's implementation:
[serverStatuses](../../src/main/mcp/registry.ts) reports historical hook evidence,
not connection health. HTTP entries emitted by `writeMcpConfig` contain a URL;
there is no external HTTP credential/OAuth state in that configuration record.
The built-in local Wanigan server's session bearer is separate. Harness-owned
OAuth may still work in a native CLI, but that is not proof Wanigan can discover
or display its current status. OpenRouter's experimental profile explicitly
declares MCP unsupported in [its manifest](../../src/main/modules/openrouter-connection/profile.ts).

## Current official interfaces, checked 2026-09-19

Codex documents `model/list` with a continuation cursor, effort options and
input modalities. Its rate-limit response distinguishes the legacy single
bucket from `rateLimitsByLimitId`, with bucket IDs, window duration and reset
epoch. The current docs also expose `rateLimitReachedType` and workspace
credits; the local parser only reads `spendControlReached`. This schema
difference needs installed-version evidence before declaring a native
regression. The offline reproductions above establish local data loss for the
supplied shapes. [Official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server).

Claude documents retaining usage bars from the last 60 minutes when refresh
fails, with a last-known note. Therefore response receipt time alone cannot
establish provider freshness. The docs do not by themselves verify Wanigan's
exact print-mode invocation. [Official Claude usage documentation](https://code.claude.com/docs/en/costs).

OpenRouter's authenticated `GET /api/v1/models/user` applies user provider,
privacy and guardrail filters. With neither offset nor limit it documents a
full list; explicit pagination uses offset/limit. Public catalog membership is
a different fact. [User-filtered models API](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails).

`GET /api/v1/key` distinguishes key cap, remaining credit, reset policy and
usage. Null cap/remaining does not prove an unlimited account wallet. Account
credit, key cap and the in-flight spending budget are separate constraints;
402 metadata identifies the source, and bounded recovery should honor
`Retry-After`. Its free-model daily request counter is separate from paid
credit and does not report every rate limit. Do not create another key/account
to evade a limit. [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits).
The account-wide credits endpoint explicitly requires a management key;
unavailable wallet access must not trigger an automatic privilege upgrade.
[Credits API](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

OpenRouter's official remote server is `https://mcp.openrouter.ai/mcp`. The
announcement documents metadata/endpoint/credit/generation tools and billable
`send-message`. OAuth creates a separate key with a default seven-day expiry
and $10 cap, editable on consent. This cap is not the shared audit ledger.
The linked connection guide failed retrieval in this research pass, so these
are announcement-level setup facts, not a witnessed OAuth flow.
[Official OpenRouter MCP announcement](https://openrouter.ai/blog/announcements/openrouter-mcp-server/).

The MCP 2025-11-25 tools contract includes paginated `tools/list`, optional
list-change notifications, and a tool-result `isError` distinct from protocol
failure. A connector fixture must pin the protocol actually negotiated by the
installed harness; mixing this specification with a different implementation
version cannot certify compatibility. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

OpenRouter's Codex guide says environment-key authentication can leave model
metadata unavailable, while its command-based authentication enables catalog
refresh. Wanigan deliberately uses `env_key` and invocation-scoped configuration.
This explains a documented limitation; it does not authorize copying the
guide's shell helper or editing global configuration. Native coding and billing
still need conformance. [OpenRouter Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli),
[local connection contract](../openrouter-connection.md).

## Coordinator's native snapshot: corroboration and limits

The coordinator subsequently recorded actual Codex 0.155.1 read-only RPCs
between 18:58:14 and 18:58:18 UTC on 2026-09-19. This is a separate evidence
level from the mocked fixture results above. The source is the sanitized
[account-discovery snapshot](relay-audit-2026-09-19/account-discovery.json), not
an inference from file presence or the model catalog.

| Account label | Native authentication / quota answer | Catalog answer |
| --- | --- | --- |
| Personal | ChatGPT `pro`; weekly `codex` bucket 91% used; `base_model_inference` bucket 0% used, labeled `gpt-reserve`. | Five model rows; pagination complete. |
| gamedev | ChatGPT `prolite`; weekly `codex` bucket 100% used; `rateLimitReachedType: rate_limit_reached`. | Five model rows; pagination complete. |
| Temporary | ChatGPT `prolite`; weekly `codex` bucket 0% used. | Five model rows; pagination complete. |
| temp2 | No authenticated account type; quota read returned an authentication error. | Five model rows nevertheless; pagination complete. |

The three authenticated snapshots report no credit balance and no reached spend
control; neither field overrides the separately reported subscription limit.
The artifact retains reset epochs. These are account observations at one time,
not continuing capacity guarantees. Account labels/configuration directories do
not prove independent billing principals or independent allowances.

Personal's two actual buckets establish that multi-bucket handling is relevant
on this machine; DISC-03 proves the local parser drops that extra structure.
The `gpt-reserve` label does **not** establish which catalog model consumes the
bucket. The unauthenticated temp2 catalog is a direct negative control against
using `model/list` success as authentication or paid-launch authority. No model
execution or accepted coding result follows from any of these metadata reads.

## Ranked implementation joins

1. **Bind availability to the account that will launch.** Resolve account before
   discovery and use the same environment application as sessions. Cache by
   opaque account identity plus credential generation, resolved configuration,
   backend/endpoint and catalog contract. The existing
   [profile fingerprint](../../src/main/providers.ts) hashes profile data, not
   the resolved login. `providerKeyFingerprint` in [keys.ts](../../src/main/keys.ts)
   is a masked key preview, not a unique or cryptographic fingerprint. Do not
   promote it into authorization or copy secret fragments into audit records.
2. **Keep quota evidence lossless and expire it explicitly.** Preserve bucket
   ID, scope, units, fractional usage, provider observation time when present,
   local fetch time, expiry and last-refresh failure separately. Keep unknown,
   stale, signed-out, unsupported and exhausted distinct. Join shared bucket
   reservations across queued goals; recheck after resets and immediately
   before paid spawn. Cache/deduplicate reads without treating every UI mount
   or force refresh as permission for unbounded probing.
3. **Add authenticated OpenRouter metadata through its extension.** Separate
   `/models/user`, `/key`, optional authorized wallet data, endpoint capability,
   native conformance and observed bill. Existing
   [model economics](../../src/main/modules/model-economics.ts) already persists
   public snapshots and [quotes](../../src/shared/model-economics.ts) account for
   declared tools, effort and token limits; those quotes contain neither an
   account access proof nor total trajectory cost. Hosted open-weight models
   can join the same contract. Open weights do not imply local execution, zero
   API charges or coding acceptance; no such model was ranked here.
4. **Expose task-required MCP readiness at the harness boundary.** Join selected
   account, consent, authentication expiry, negotiated protocol, full tool-list
   revision, permitted calls and cancellation/error evidence. Preserve the
   registry's honest historical-use display until live evidence exists. Bring
   billable tools under the same reservations and attribution as model calls.
5. **Feed only eligible options into economic selection.** Extend Relay's
   [profile/candidate and decision binding](../../src/main/relay.ts) with the
   above evidence revisions and the budget decision. Preserve manual choice.
   Rank expected total accepted-result cost only after trials account for
   routing, repairs, paid review and failures; no catalog or third-party
   benchmark answers that objective by itself.

Use the `usage`, `openrouter-connection`, `model-economics`, `relay` and required
session modules as owners where they already exist. Catalog/MCP discovery needs
an explicit extension point; repository rules require conversion before
nonurgent changes to unconverted surfaces. This audit did not take the urgent
in-place-fix escape.

## Conditional connection handoff

Only if the coordinator's native inventory says the API credential is missing:
sign in or create an account at [OpenRouter](https://openrouter.ai/), create a
dedicated key on [API keys](https://openrouter.ai/settings/keys), and give it a
cap no larger than the coordinator's remaining authorized allocation. Enter
the key into Wanigan's existing OpenRouter connection control, not chat or a
shell command. Saving establishes encrypted storage only; authenticated
metadata and bounded coding/billing conformance remain separate prerequisites.
An unreadable stored key calls for resolving that state rather than assuming
the user lacks an account.

Only if an optional OpenRouter MCP connection is absent and a supported
Wanigan-owned runtime/OAuth path exists: add the official HTTPS endpoint through
that path, inspect the browser consent's expiry/cap, then verify authentication
and `tools/list` without calling `send-message`. Keep that OAuth key distinct
from the inference profile's key. If the runtime/OAuth path is absent, record
the extension-point blocker; do not use global `mcp add/login` commands or
repository configuration as a shortcut. No signup, key or MCP installation was
performed by this discovery subtask.

## Public hosted-model metadata sample

At 19:08:34 UTC on 2026-09-19, unauthenticated HTTPS GETs returned the complete
public catalog: 447 rows, `total_count: 447`, and `links.next: null`. The
[sanitized artifact](relay-audit-2026-09-19/discovery/public-openrouter.json)
retains six text/tool-declaring hosted candidates, selected by newest catalog
creation date within the requested families. This is not a price or quality
leaderboard, a license/open-weights determination, or account-access evidence.
[Official public catalog](https://openrouter.ai/api/v1/models).

| Hosted candidate | Catalog context tokens |
| --- | ---: |
| `deepseek/deepseek-v4.1-flash` | 1,048,576 |
| `deepseek/deepseek-v4-flash-vision-exp` | 1,048,576 |
| `qwen/qwen3.8-max-0902` | 1,000,000 |
| `qwen/qwen3.8-flash` | 1,000,000 |
| `mistralai/mistral-medium-3-5` | 262,144 |
| `z-ai/glm-5.3-flashx` | 1,048,576 |

Two endpoint reads also returned HTTP 200: DeepSeek v4.1 Flash reported 22
endpoints (six retained), and Qwen3.8 Max reported one (retained). The saved
endpoint rows include declared `tools`, `tool_choice`, context/output limits,
provider/tag, quantization and pricing. DeepSeek's catalog pricing and two of
the retained endpoints contain conditional overrides, preserved in full;
flattening them into one price would lose conditions. No endpoint tool loop
was executed. [DeepSeek endpoint metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints),
[Qwen endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.8-max-0902/endpoints).

Raw prompt/completion prices are USD per token; cache and conditional prices
remain separate fields. These public declarations do not establish account
eligibility, future availability, invoice charges or cost per accepted result.
[Official model schema](https://openrouter.ai/docs/guides/overview/models).

The default sandbox initially failed DNS; the approved metadata-only escalation
succeeded. The three GETs were repeated once to preserve conditional pricing
omitted by the initial sanitizer. No key, inference endpoint or MCP tool was
used. The final artifact records request times and source body hashes; its
SHA-256 is `9d2810267651a2287ccfb8c4907e6cf45547bb78c358d4788717ec4dda85f7fb`.
