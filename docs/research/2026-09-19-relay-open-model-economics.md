# Relay: OpenRouter and open-model economics

Research date: 2026-09-19. Recommendation: add a deliberately small, measured
OpenRouter/open-model candidate pool after building trustworthy endpoint and
attempt accounting. Discover broadly; execute selectively. A cheaper token price
does not establish a cheaper accepted change.

## Evidence and scope

Read-only public metadata requests returned **447 catalog rows**, of which 378
declare tools, 173 declare both tools and a `reasoning_effort` parameter, and 170
declare tools plus an explicit `reasoning.supported_efforts` array. These are
catalog declarations, not tested compatibility or coding quality. The catalog
includes aliases and routers; it is not a census of every model worldwide.
The API result differs from the pricing page's rounded “500+” marketing count.
[Models API](https://openrouter.ai/api/v1/models),
[API schema](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

[Evidence snapshot](2026-09-19-openrouter-catalog-snapshot.json) preserves the
catalog retrieval time, response-byte SHA-256, counts, five selected model rows,
and five selected endpoint rows with source URLs. Endpoint rows were fetched at
17:19:53 UTC; full-catalog counts/hash at 17:24:44 UTC. No inference, account usage,
credentials, installation, or provider connection was performed. Price and
capability claims below are observations of that snapshot, not guarantees.

## Five concrete candidate endpoints

USD per million tokens; endpoint input / output / cache-read rates. Context and
output are advertised token limits. All five selected endpoints declared tools
and had status `0`; health status and declarations still require live validation.

| Model and endpoint | Input / output / cache read | Context / maximum output | Reasoning and compatibility distinction |
| --- | --- | --- | --- |
| [Qwen3 Coder 30B A3B Instruct — Novita FP8](https://openrouter.ai/api/v1/models/qwen/qwen3-coder-30b-a3b-instruct/endpoints) | $0.07 / $0.27 / unreported | 160,000 / 32,768 | No reasoning-effort parameter. Useful non-thinking candidate; do not invent low/medium/high settings. |
| [DeepSeek V4.1 Flash — DeepSeek](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints) | $0.15 / $0.60 / $0.003 | 1,048,576 / 384,000 | Model advertises `low`, `high`, `max`; defaults high. Endpoint tool-choice metadata allows auto/none but denies required/named function. Prices contain time overrides. |
| [GLM 5.3 Flash — DeepInfra FP4](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints) | $0.075 / $0.25 / $0.015 | 1,048,576 / 131,072 | Model advertises `low`, `high`, `max`; reasoning mandatory, default max. FP4 is part of the route identity. |
| [MiniMax M2.5 — Venice](https://openrouter.ai/api/v1/models/minimax/minimax-m2.5/endpoints) | $0.27 / $0.95 / $0.03 | 198,000 / 32,768 | Reasoning mandatory, but no explicit effort array and no endpoint `reasoning_effort` parameter. |
| [Kimi K2.6 — Baidu FP4](https://openrouter.ai/api/v1/models/moonshotai/kimi-k2.6/endpoints) | $0.3743 / $1.576 / $0.06304 | 262,144 / 235,929 | Reasoning optional/default enabled, but no explicit effort array or endpoint effort parameter. |

These illustrate candidates, not an ordered quality ranking. Open weights and
permissive open-source licensing are separate claims; this research verified
Qwen's license below, not licenses for every newer model in the table. Some
other endpoints had nonzero status or zero capacity metadata; zero capacity must
mean unknown/unusable for admission, not unlimited capacity.

The aggregate Qwen catalog row advertises $0.07/$0.28 and 262,144 context, while
Novita reports $0.07/$0.27 and 160,000. GLM's aggregate input/output rates are
$0.09/$0.30, while the selected DeepInfra FP4 endpoint is $0.075/$0.25. Rank
**model + endpoint + quantization + effort + billing mode**, not a model name.
[Endpoint schema](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

DeepSeek's captured weekend rates double during some weekday UTC windows in its
returned overrides. Other rows contain discount fields. Preserve the published
decimal rates and overrides; do not multiply a discount into an already returned
price without a defined contract. Missing cache-read price is unknown, not zero.
Prices exclude account/platform charges, taxes, tool charges and possible tiers.

## Fees, caching, and accounting

The current pricing page lists Standard platform fees of **5.5%**, Business
**8%**, and Standard/Business BYOK allowances of **$25,000 list-price inference
per month without BYOK fees, then 5%**. Enterprise lists a $200,000 allowance.
Use this dated policy rather than older descriptions based on request counts.
The Free plan lists 50 requests/day and excludes several routing, budget, caching
and data-policy features, so it is not an interchangeable professional baseline.
Provider-direct API usage avoids gateway fees but has its own rate, availability,
integration and metering costs. Compare actual invoices/credits by billing mode.
[Pricing](https://openrouter.ai/pricing).

BYOK uses a provider API credential, not an existing consumer subscription login.
OpenRouter can fall back from an own-key route to shared capacity; restrict that
behavior explicitly when it would change the intended payer or backend.
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok).

The API supplies `usage.cost`, upstream cost details, native token counts,
reasoning counts and cache read/write counts. A generation-ID lookup supports
later reconciliation; its upstream cost field is documented as BYOK-only and
otherwise zero/null. Those zeros do not establish free inference. Preserve the
charge source and avoid adding a component twice to an already total charge.
Codex subscription usage is not this API bill; neither catalog prices nor
cumulative CLI token totals prove what a subscription session cost.
[Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Reasoning consumes output budget and is billed accordingly. Hiding reasoning
does not remove that cost. Preserve required reasoning details across tool
roundtrips on the same authorized backend. Effort levels are model-specific:
the newer Models API `reasoning` object exposes mandatory/default-enabled state,
effort choices/defaults, and budget support. Missing effort choices are not proof
that a generic low/medium/high enum works.
[Reasoning semantics](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Sticky provider routing and stable conversation identity can improve cache hits;
an explicit `session_id` starts affinity at the first successful response.
Affinity remains best effort. Cache fields and write charges vary by provider;
Anthropic-specific request controls are not portable cache settings. Log cache
counts and resolved endpoint rather than claiming that an unchanged prefix
necessarily generated a cache hit.
[Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Routing controls and the Pareto Router

OpenRouter's default provider balancing is not a guarantee of the lowest price
per call. Explicit sorting supports price, throughput or latency. Prefer strict
provider allowlists and disabled fallback for a frozen-route comparison;
`order` alone is not an allowlist. Use `require_parameters` and exact endpoint
capabilities so an unsupported control is not silently ignored. A `max_price`
constraint is not a total session budget. Latency/throughput preferences are not
SLAs. Provider data-policy declarations need separate admission checks.
[Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

**`openrouter/pareto-code` is a relevant comparator, not an accepted-result
optimizer.** It uses a curated coding shortlist and relative Artificial Analysis
coding percentiles. `min_coding_score` selects high/medium/low tiers at 0.66 and
0.33; within a tier it chooses the cheapest available model, or fastest p50
throughput with `:nitro`. Its score is not an 80% probability of passing this
repository's tests. Up to two same-tier fallbacks handle provider errors/rate
limits, not bad code. A missing entire tier can move selection to a neighbor.
It returns the resolved model, supports best-effort session affinity, and adds no
router-specific fee. The documented router knob does not jointly choose effort,
cap per-request cost/latency, or learn from Relay review outcomes. Its changing
shortlist and upstream fallbacks need explicit backend consent/attribution in
Wanigan before use. Benchmark it as a separate routing policy after integration;
do not replace JEV blindly.
[Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router).

OpenRouter documents opt-in prompt/response logging and product-use settings,
plus retained metadata and separate upstream policies. Its ZDR routing permits
certain in-memory caching; ZDR is not a claim that all processing and metadata
stay on this machine. The gateway is an additional service handling content.
Use declared privacy preferences and recorded resolved backend identities, not
“OpenRouter” as a blanket grant to every upstream provider.
[Data collection](https://openrouter.ai/docs/guides/privacy/data-collection),
[ZDR](https://openrouter.ai/docs/guides/features/zdr).

## What Relay can actually control today

| Existing seam | Consequence for implementation |
| --- | --- |
| `src/shared/backend-catalog.ts:37,48,269–303`: catalog output is only id/label/source, capped at 500 | It discards prices, endpoints, tool capabilities and the new typed reasoning object. Reuse discovery plumbing but add a validated economic/capability contract. Report truncation explicitly. |
| `src/main/backend-catalog.ts:26`: six-hour cache and bounded request handling | Good starting point for discovery; endpoint prices/health need separately dated freshness and expiry. |
| `src/main/provider-packs.ts:705–718,1563–1566`: generic CLI must declare no headless protocol; Claude/Codex harness claims require a trusted adapter | A manifest with a model slug does not supply a working coding agent or truthful headless/usage support. |
| `src/main/provider-packs.ts:945–951`: built-in Codex exposes model/effort argv | These do not expose arbitrary OpenRouter provider preferences, session IDs or cache controls. Add an explicit runtime/backend integration. |
| `src/main/headless.ts:306–363,629–651`: headless compiler supports Claude JSON/Codex JSON and refuses generic CLI | No drop-in HTTP agent executor; Codex headless does not provide a reliable dollar-budget flag. |
| `src/main/providers.ts:370,388–400`: local backend namespace and restricted reconciliation support | Keep upstream backend identity distinct; do not automatically treat Codex/Claude usage as OpenRouter billing evidence. |

OpenAI's Codex configuration supports custom provider `base_url`, authentication
and the Responses wire protocol. OpenRouter publishes a Codex integration guide
dated June 17, 2026. That establishes a plausible compatibility path, not a
verified Wanigan profile. Wanigan must own runtime configuration in user-data,
probe declared capabilities and verify tools, efforts, resume and metering before
claiming support. Do not edit the user's repository/config merely to make it run.
[Codex config](https://learn.chatgpt.com/docs/config-file/config-reference),
[OpenRouter's integration guide](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/).

## Broad discovery, bounded execution

Proposed design, not existing behavior:

1. A main-owned module syncs the complete bounded catalog with retrieval time,
   schema/version and content hash. Filter text/tool models first; fetch endpoint
   details for a shortlist. Keep community catalogs as discovery hints and the
   actual billing endpoint as rate authority. Expose partial/truncated results.
2. Validate endpoint limits, exact tool-choice modes, effort semantics, privacy,
   availability, quantization and verified harness support before considering
   price. Namespace the backend and freeze an admissible fallback policy.
3. Preserve decimal prices, cache read/write prices, reasoning/output accounting,
   scheduled overrides, fee policy and billing mode in a dated quote. Unknown
   fields remain unknown. Never compare an API dollar quote with invented
   subscription dollars or describe local compute as zero total cost.
4. Bind the user-approved route receipt to profile/config/catalog snapshots and
   main-owned policy. Record requested and actually resolved models/endpoints,
   generation IDs, every attempt, retry, cache count, wall time and final review.
5. Measure cost and time per accepted change on fixed commits and repeatable task
   strata. A small pool should include a cheap non-thinking model, a cheap model
   with real effort control, a reliable stronger fallback and the existing native
   route. Do not pay to test all 447 rows. Escalate after objective failure with a
   bounded retry budget; keep manual override and equal review/test requirements.

The useful frontier is accepted quality, elapsed time and total attributable
cost. Catalog prices seed estimates; repository outcomes decide which candidates
earn traffic. Existing CLI subscriptions can remain economically preferable
when paid-for capacity is available, even if their API-equivalent token price is
higher. Subscription quota and opportunity cost should be a separate dimension.

## Local open models on the actual machine

The observed machine is Apple M2 Pro with 32 GiB unified memory. Qwen's official
30B A3B model is non-thinking and Apache-2.0; Ollama's Q4_K_M artifact is about
19 GB. Three billion active parameters does not mean three billion parameters
resident in memory. The remaining memory must cover macOS, Wanigan, KV cache and
runtime buffers. Larger contexts require more memory: the advertised model
context is not proof it fits this laptop at that context.
[Qwen model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct),
[Ollama artifact](https://ollama.com/library/qwen3-coder:30b),
[Ollama context guidance](https://docs.ollama.com/context-length).

A reasonable later experiment is this single model/quantization at bounded
8k/16k/32k contexts, measuring peak memory, prefill time, decode throughput,
tool fidelity and accepted edits. No local runtime/model was installed here.
Use current hardware before contemplating a purchase. Compare measured energy,
hardware amortization when relevant, setup/maintenance, occupied machine time,
human review and failure/escalation cost. Local inference may win on privacy or
idle-capacity economics while losing on elapsed time or difficult-task retries.
Only that experiment can establish the best tradeoff for this machine.
