# Relay audit: account, model, quota and MCP discovery

Source baseline: `324bca7f137198a78583ec9b8cb07cfd1c667c71`. Research date: 2026-09-19. This note inspects source and official documentation; it does not verify a signed-in account, connect a server, or make inference requests. The installed OpenRouter credential state has not been checked. The integrated [next-session plan](../superpowers/plans/2026-09-19-relay-deep-audit.md) owns the single approved $50 allowance.

## What is already present, and where the joins are missing

| Surface | Observed implementation | Audit consequence |
| --- | --- | --- |
| Account limits | [limits.ts](../../src/main/limits.ts) combines Claude and Codex readers and gives other harnesses an explicit unsupported result. [AccountLimits](../../src/shared/types.ts) records source time, windows and unknown states. | Preserve these distinctions when routing; recorded local consumption cannot establish remaining subscription allowance. |
| Codex quota | [codex-status.ts](../../src/main/codex-status.ts) uses the account's launch environment and a 45-second cache. `snapshot()` reads only `rateLimits`; window percentages are rounded. | Test multiple quota buckets, fractional percentages, reset boundaries, stale readings and concurrent use outside Wanigan. A single window cannot describe every model's allowance. |
| Codex models | The same module requests `model/list`, has one global ten-minute model cache, uses the ambient probe environment and reads one page of 200 rows. It does not accept an account id. | Test two accounts with different catalogs and a non-null next cursor. Catalog identity must follow the chosen account/harness/backend; a default account's answer cannot prove another account's access. |
| Other backend catalogs | [backend-catalog.ts](../../src/main/backend-catalog.ts) marks fallback versus live data honestly, but keys its six-hour cache by backend id. | Test credential rotation, two identities using one backend and revoked access. Do not silently carry one credential's live answer into another credential's eligibility. |
| Claude quota | [claude-limits.ts](../../src/main/claude-limits.ts) invokes `claude -p /usage` and parses human text. It stamps the probe time and parses reset dates in machine-local time while retaining provider text. | Verify this exact command with the installed CLI before treating it as a free structured probe. Test provider-cached answers, command rejection, format changes, timezone differences and subscription/API authentication. A response received now may contain older data. |
| Routing | [relay.ts](../../src/main/relay.ts) builds candidates without joining the above quota/access readers; [JEV questions](../../src/shared/suggest-questions.ts) express cost preference without numerical outcome economics. | This is a missing integration, not proof of intelligent account selection. Measure legal choice, available choice and economic outcome separately. |
| OpenRouter | [connection module](../../src/main/modules/openrouter-connection.ts) stores credentials/status locally; [profile](../../src/main/modules/openrouter-connection/profile.ts) is generic/manual with unsupported MCP and unpriced execution. | Key presence is not authenticated access. Public prices are not an account wallet. A manual success alone cannot enable automatic routing. |
| MCP | [registry](../../src/main/mcp/registry.ts) owns scoped server configuration/trust; [capabilities](../../src/main/mcp/capabilities.ts) binds Wanigan server tokens to sessions/projects. [Provider capabilities](../../src/main/providers.ts) determine injection support. | Test inbound tools supplied to an agent separately from Wanigan's own MCP server. Saved/enabled configuration does not establish successful authentication, tool discovery or calling support in each harness. |

These are source observations. Failure scenarios below still require execution; do not report them as reproduced production failures.

## Official interfaces worth testing

Codex documents `model/list` with effort options and pagination, and `account/rateLimits/read` with a backward-compatible single bucket plus `rateLimitsByLimitId`. Bind discovery to the same account used for launch, retain bucket identity, and verify against the installed CLI protocol. These documented interfaces motivate the account/cache and bucket tests above. [Codex App Server](https://learn.chatgpt.com/docs/app-server).

Claude documents `/usage` for subscription allowance and API usage, including last-known readings after a failed refresh. This documentation does not establish that Wanigan's exact print-mode invocation produces its expected text. That needs native conformance testing with bounded invocation and billing observation. [Claude usage documentation](https://code.claude.com/docs/en/costs).

OpenRouter offers a public model catalog and an authenticated `/api/v1/models/user` list filtered by user preferences, privacy settings and guardrails. Use those as separate evidence: a listed model still needs an available compatible endpoint and a successful coding/tool conformance trial. [Model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [user-filtered models](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails).

`GET /api/v1/key` reports key spending limits, remaining allowance and usage. Account credit, per-key allowance and in-flight limits are separate constraints. A key without a cap is not unlimited account credit. [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits). The account-wide `/api/v1/credits` endpoint currently documents a management-key requirement; a normal inference key must not be given broader privileges merely to draw a balance widget. A denied read should remain unavailable. [Credits API](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

OpenRouter also publishes an official remote MCP server at `https://mcp.openrouter.ai/mcp`. Its documented tools include model/endpoint discovery, documentation, credit and generation lookups; `send-message` purchases inference. OAuth creates a dedicated expiring, capped key. Recheck the displayed scope and cap during connection. This can help research and diagnosis; Relay execution still needs its own verified API, metering and tool path. [Official MCP announcement](https://openrouter.ai/blog/announcements/openrouter-mcp-server/).

The Codex plugin directory search for OpenRouter returned no matching plugin during this session. That is a directory result, not a claim that OpenRouter lacks an MCP service. The official MCP guide timed out during research; the announcement above was retrieved. No plugin or MCP server was installed.

For MCP, pin the negotiated protocol and SDK version in each fixture. `tools/list`, pagination, `tools/call`, declared capabilities and error behavior must agree with that version; test invalidation appropriate to that version instead of mixing draft and released contracts. Tool annotations alone do not authorize a side effect. [MCP tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Discovery record required for each candidate

Record opaque profile/backend/account ids and fingerprints; executable and harness version; authentication mode; requested and observed model; supported effort/context/modalities; endpoint and tool compatibility; quota bucket identities and units; remaining amount or percentage and reset time; spend control; evidence source, fetched time, provider observation time if available, and expiry. Keep unavailable, unauthenticated, unsupported, stale and known-exhausted distinct.

Key caps, account credit, rate limits, rolling subscription windows and local machine capacity need distinct fields. Shared model quotas consume one bucket, not one independent allowance per model. Unknown pending consumption cannot be converted to zero. An open-weight model hosted by an API is still billed; a local model has capacity, latency and operating costs even when it has no API charge.

An eligibility decision should say why a route is usable now, what remains uncertain, when it was checked, and what invalidates it. Refresh bounded metadata after login, credential/profile changes, access errors and relevant reset times. Deduplicate concurrent reads; back off on provider errors; avoid polling every model or every open UI pane.

## Twelve next-session cases

| ID | Scenario | Required result |
| --- | --- | --- |
| D01 | Two accounts return disjoint models; rotate one key; paginate a catalog. | No identity/cache leakage or silently omitted page; access evidence follows the launch account. |
| D02 | Model disappears or its effort/tool support changes between preview, queue and spawn. | Stale decision is refused or deliberately refreshed; no invisible substitute or paid retry. |
| D03 | Codex supplies two limit ids, overlapping model scopes and fractional usage. | Preserve independent/shared bucket identities and limiting constraints; no duplicated allowance or rounded false exhaustion. |
| D04 | Quota resets, provider clock differs, another device uses allowance, and a refresh fails. | Source age is visible; stale/unknown is never asserted as usable capacity; next action explains refresh or wait. |
| D05 | Claude print-mode probe rejects `/usage`, returns cached data, or changes text/timezone. | No fabricated current reading; no unaccounted model invocation or endless refresh; retain raw reset wording when conversion is uncertain. |
| D06 | OpenRouter key missing/expired/revoked; cap zero/null; account credit unavailable. | Authentication, key allowance and wallet are distinct; missing management scope never prompts automatic privilege expansion. |
| D07 | User-filtered catalog excludes a cheap public model; tool support differs by endpoint. | Eligibility honors account/privacy/tool constraints before price. Endpoint metadata alone does not certify a real tool loop. |
| D08 | Two Relay goals share one exhausted/resetting bucket and one global budget. | Reservations/queue checks prevent both spending the same headroom; provider 402/429 has bounded recovery without account-limit circumvention. |
| D09 | MCP OAuth expires; server is reachable but `tools/list` fails/changes/pages. | Show connected versus ready separately; changed capability invalidates relevant route evidence; no secret in renderer or logs. |
| D10 | Required MCP tool returns `isError`, times out, or permission is revoked before call. | Failure stays a failure, pending work cancels coherently, unavailable tools do not become successful task evidence. |
| D11 | MCP exposes hundreds of tools or a billable inference tool. | Discover task-relevant tools; measure context overhead. Billable calls reserve from the same $50 ledger and do not bypass model routing policy. |
| D12 | Route needs an unconnected service, included allowance is depleted, or all reliable data is unknown. | Plain-language options: connect/sign in, refresh, wait until reset, or use a metered paid route within the chosen cap. No silent new subscription/top-up. |

## Onboarding handoff

First inspect Wanigan's safe connection status. If OpenRouter is not connected, the user can sign in or create an account and create a dedicated bounded key at [OpenRouter API keys](https://openrouter.ai/settings/keys), then enter it in Wanigan's OpenRouter connection controls. Do not paste a key into a chat, issue, shell command history or audit artifact. The existing save operation does not validate the credential. [Quickstart](https://openrouter.ai/docs/quickstart), [current local connection contract](../openrouter-connection.md).

For the optional official MCP connection, use a verified Wanigan-owned runtime configuration path and browser OAuth when supported. Do not copy installation commands that alter global CLI settings or the project simply to make a trial work. Record a missing OAuth/configuration extension point if necessary. Keep metadata discovery separate from billable test inference and account-wide management operations. Connection and signup steps should be shown only when needed, with the exact missing capability explained.
