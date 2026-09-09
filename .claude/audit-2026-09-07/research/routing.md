# Multi-model routing and cost reduction across coding agents, as of 2026-09-07

Research pass for the Wanigan audit (routing-patterns). Read-only: no repository file was touched.
Verification rule: `verified=true` only where the claim was read on the vendor's own site, docs, paper
or repository. Anything from a search snippet, blog roundup or DeepWiki is `verified=false`.
Every source carries the date it was read (2026-09-07) and, where the page states one, its own date.

Raw Devin post saved beside this file as `devin-fusion.html` / `devin-fusion.txt`.

---

## 1. Devin Fusion (Cognition) — primary source, read 2026-09-07

Source: https://cognition.com/blog/devin-fusion (cognition.ai redirects here). Byline "The Cognition
Team 06.29.26". Chart footer: "Data last updated 8/7/2026 with current frontier models".

### Architecture, quoted

- "The key idea behind our architecture is to run two parallel agents: one with a frontier model, the
  other with a more cost-effective 'sidekick' model. Both are fully capable agents with their own
  toolsets and ability to gather & act on their own context."
- "the main agent should take minimal actions, and only read what is absolutely necessary. By default
  it should delegate and monitor, while making the significant decisions: the plan, the interpretation
  of ambiguity, the final review."
- Why not a plain router: "Routers often over-fit to specific benchmarks." "Prompts often do not
  contain enough information about the task to properly discern difficulty." "the user might have
  difficult followups to simple initial prompts."
- Why not an advisor tool: "We've previously explored a 'Smart Friend' tool, and Anthropic released a
  similar 'Advisor' tool ... Upon every call to the other model, the context for the task is not shared
  in a way that is cached, and you pay a very expensive price. In the sidekick setup, both the main
  model and sidekick model maintain their own persistent, cached contexts." Also: "most cached inputs
  only have a 5-minute expiry."
- Dynamic routing: "we use lightweight classifiers during task execution to signal when we need to
  switch to the main agent or use a different model entirely." "We accomplish this by switching the
  model during context compaction, which would trigger a cache miss anyway. Each time we trigger
  compaction, we take it as an opportunity to evaluate the situation and switch the model that's in
  charge, effectively getting model switching 'for free'." "we can even 'upgrade' our sidekick model
  without going back to the main model, at no extra cache penalty."
- "Largest efficiency gains are seen in implementation-focused sessions."
- Correction footnote: "We initially reported a 35% cost reduction at publication. On the latest
  FrontierCode 1.1 Extended data (updated 8/7/2026), Fusion is up to 60% cheaper".

### Benchmark table (FrontierCode 1.1 Extended, score and average cost per task), verbatim order

| Model | Score | Avg cost/task |
|---|---|---|
| Fable 5 (xhigh) | 64.9 | $10.53 |
| Opus 5 (medium) | 63.6 | $3.51 |
| Devin Fusion | 63.1 | $1.35 |
| GPT-5.6 Sol (high) | 58.7 | $3.41 |
| Kimi K3 | 58.2 | $3.12 |
| Grok 4.5 (high) | 56.6 | $1.09 |

All six rows match the numbers given in the task brief. Task count of FrontierCode 1.1 Extended is
not stated on the page.

- "Fusion with Fable 5 is 41% cheaper than a pure Fable 5 harness, versus up to 60% with Opus and
  GPT-5.5-level models. The non-Fable numbers reflect many rounds of tuning of the Devin Fusion
  harness; the Fable 5 numbers don't, since access was cut off before we could apply them."
- "On June 12, 2026, access to Fable 5 was suspended in accordance with a US government directive".
- "We enabled Fusion for a set of users internally at Cognition, and we found that 88% of their merged
  PRs were driven entirely by the automated Fusion router."

### Per-task examples (all five, verbatim numbers)

| Task | Class | Cost | Score | Cognition's note |
|---|---|---|---|---|
| Modernize search.js to ES6 + full make/Playwright/e2e suite | refactor / easy / js | -62% ($3.55 → $1.37) | +2 (98 → 100) | "The cost was in the tests, not the code. Delegating that saved 62% at no cost to quality." |
| Rip out OpenTracing across Mattermost server | deprecation / medium / go | -32% ($3.80 → $2.57) | -1 (98 → 97) | "Mechanical work fully handed off: much cheaper at the same quality." |
| JSON-Schema oneOf-with-const in Python model generation | feature / medium / python | -38% ($5.08 → $3.13) | -4 (54 → 50) | "Devin reaches the same partial result either way, so the sidekick just makes it cheaper" |
| Team selector in search bar (React/Redux), behind a flag | feature / hard / ts | -28% ($6.84 → $4.91) | **-27 (54 → 27)** | "graded on its judgment calls. Devin delegated the coding, and the subtle intent was lost. When the judgment is the deliverable, delegating it backfires." |
| LangChain4j WebSocket MCP transport into Quarkus | feature / hard / java | -25% ($5.25 → $3.93) | +12 (69 → 81) | "Hard but mechanical work still hands off cleanly, and here it even beat Devin solo." |

The load-bearing caveat for Wanigan: the cost saving on the judgment-heavy task (28%) was *smaller*
than on the mechanical ones, and it halved the score. The pattern that wins is "mechanical or
verification-heavy work to the cheap agent; plan, ambiguity, final review kept on the frontier model".

---

## 2. Claude Code (Anthropic) — primary docs, read 2026-09-07

### Subagent model selection (https://code.claude.com/docs/en/sub-agents)

- `model` frontmatter: "Model alias: ... `sonnet`, `opus`, `haiku`, or `fable`"; "Full model ID ...
  Accepts the same values as the `--model` flag"; "`inherit`: use the same model as the main conversation".
- Resolution order: "1. The per-invocation `model` parameter 2. The subagent definition's `model`
  frontmatter ... 3. The `CLAUDE_CODE_SUBAGENT_MODEL` environment variable ... 4. The main
  conversation's model".
- "Setting `CLAUDE_CODE_SUBAGENT_MODEL` by itself doesn't change the model the built-in Explore and
  Plan subagents run on." To force every subagent/teammate/workflow agent: also set
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.
- "As of v2.1.198, Explore inherits the main conversation's model instead of always running on Haiku.
  On the Claude API, the inherited model is capped at Opus".
- Subagent `effort` frontmatter: "Options: `low`, `medium`, `high`, `xhigh`, `max`; available levels
  depend on the model". Thinking is inherited; "There is no per-subagent thinking setting."

### Model config / effort (https://code.claude.com/docs/en/model-config)

- Effort values `low, medium, high, xhigh, max, ultracode`; Fable 5.1/5, Opus 5, Sonnet 5, Opus 4.8/4.7
  take low…max; Opus 4.6/Sonnet 4.6 take low, medium, high, max. Default `high` (Opus 4.7 defaults xhigh).
- Set via `/effort <level>`, `CLAUDE_CODE_EFFORT_LEVEL`, `claude --effort xhigh`, or settings
  `effortLevel` / `modelSettings.<model>.effort`.
- Aliases include `opusplan` ("Opus for planning, switches to Sonnet for execution"), `best`, `fable`,
  `opus`, `sonnet`, `haiku`, `[1m]` variants.
- Env: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL` (v2.1.236+), `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL` ("Default model for subagents/teammates/workflow agents").
- Automatic switching exists only as a safety-classifier fallback (Fable → Opus 5 / Opus 4.8 by category),
  controllable with `"switchModelsOnFlag": false` (v2.1.219+). There is **no** cost-driven auto-routing.
- Settings precedence page: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` lets a host app's model config beat
  managed `model`/`fallbackModel`/`modelOverrides` and `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`.

### Advisor tool (https://code.claude.com/docs/en/advisor)

- "The advisor tool lets Claude consult a second, typically stronger model at key moments ... The
  advisor receives the full conversation, including every tool call and result". Experimental,
  "requires the Anthropic API"; not on Bedrock/Vertex/Foundry.
- Enable: `/advisor opus`, `advisorModel` setting, `--advisor` flag (not listed in `--help`).
- "The advisor must be at least as capable as the main model." Pairing table (Haiku 4.5 main → Fable/
  Opus/Sonnet advisors; Fable main → Fable only, etc.).
- "Claude decides when to call it ... There is no setting to cap or force advisor calls".
- Cost: "each call consumes tokens at the advisor model's rates in addition to your main model's usage";
  "The advisor model's own read of the conversation is not cached. Each advisor call processes the full
  transcript anew" — this is exactly the cache cost the Devin post criticises.
- Feature-flag gated: "In a session where a variable that turns flag fetching off is set, such as
  `DISABLE_TELEMETRY`, the advisor stays off."
- Advisor strategy blog (https://claude.com/blog/the-advisor-strategy): SWE-bench Multilingual Sonnet 4.6
  + Opus advisor: +2.7 points, 11.9% lower cost per task (caveat: solo used adaptive thinking, advisor
  run had thinking off). BrowseComp: Haiku 4.5 + Opus advisor 41.2% vs 19.7% solo, "trails Sonnet solo
  by 29% but costs 85% less per task". Terminal-Bench 2.0 improved (thinking off in all runs).

### Fast mode (https://code.claude.com/docs/en/fast-mode and platform fast-mode page)

- "/fast" toggles; Opus 5 and Opus 4.8 only; "$10/$50" per MTok input/output; "not a different model".
- Cache trap: "The first time you enable fast mode in a conversation, you pay the full fast mode uncached
  input token price for the entire conversation context" — "Requests at different speeds do not share
  cached prefixes." Opus 4.7 fast mode removed 2026-07-24. Subscription plans bill fast mode to usage
  credits. In `-p` mode `/fast` only works when launched with `--settings '{"fastMode": true}'`.
- Guidance quoted: standard mode is better for "Long autonomous tasks", "Batch processing or CI/CD
  pipelines", "Cost-sensitive workloads".

---

## 3. Codex CLI (OpenAI) — primary docs, read 2026-09-07

- Config reference (https://learn.chatgpt.com/docs/config-file/config-reference): `model` string;
  `model_reasoning_effort: "minimal | low | medium | high | xhigh"` ("Responses API only; `xhigh` is
  model-dependent"); `service_tier` ("fast" for priority); `--profile <name>` reads
  `$CODEX_HOME/<name>.config.toml`; `model_catalog_json`; `model_auto_compact_token_limit`.
- Developer settings (https://learn.chatgpt.com/docs/developer-settings): `codex --model gpt-5.5`,
  `codex --config model_reasoning_effort='"high"'`, `codex --profile deep-review`; flags/`--config`
  have highest precedence; `/model` and `/debug-config` in the TUI.
- Models page (https://learn.chatgpt.com/docs/models): Astra, 5.6 Sol ("most capable"), 5.6 Terra
  ("Balanced"), 5.6 Luna ("Fast and affordable ... lowest cost"). Effort ladder Light/Low, Medium,
  High/Extra High, Max ("more time to reason about a single task"), and **Ultra**: "uses subagents to
  accelerate complex work". "If you don't specify a model, the ChatGPT desktop app, Codex CLI, or IDE
  extension uses a recommended model."
- **No auto/cost router found in Codex docs.** The only "automatic" behaviour is the recommended
  default when `model` is unset. (Wanigan's `NewSessionDialog.tsx:666-667` says Codex's picker has
  "Auto choices" — I could not verify that wording against current docs; treat as needs re-check.)

---

## 4. Cursor — primary docs and blog, read 2026-09-07

- Docs (https://cursor.com/docs/models): "On Teams and Enterprise plans, Cursor Router picks the model
  for each Auto request based on your optimization mode." Modes Cost / Balance / Intelligence. "All Auto
  modes bill at the list price of the model each request is routed to." Third-party models add "a Cursor
  Token Rate of $0.25 per million tokens". Composer 2.5: $0.50 in / $2.50 out; fast variant $3 / $15.
- Router docs (https://cursor.com/docs/cursor-router): "Cost: Uses the previous Auto routing logic. It
  optimizes token spend." "Balance: Optimizes for intelligence, speed, and cost." "Intelligence: Routes to
  the most capable models for harder tasks, at a lower cost than running a single frontier model."
  Enterprise Auto Cost flat pricing "$1.25/1M input and cache write, $0.25/1M cache read, $6.00/1M output"
  until September 7, 2026. Visibility: admins choose whether to "Display which model Auto routed to at
  the start of each response, or keep it hidden" — **default hidden**, "results are judged on their own
  merit rather than by model name". Admins can "Impose Auto" (Soft/Hard).
- Blog "How Cursor Router chooses the right model" (2026-08-06): trained on "hundreds of thousands of
  turns"; features "task category, along with recent tool calls and the broader context"; satisfaction
  inferred "from what the user does next. Moving on to the next task is a strong positive signal, while
  correcting the agent is a strong negative one." Claims: "Auto Intelligence delivers above Fable-level
  user satisfaction at 68% lower cost", "Auto Balance outperforms Opus 4.8 at 41% lower cost", both
  "relative to Opus 4.8". Pool named: Grok, Sol, Opus, Fable, Opus 5.
- Composer 2.5 post (2026-05-18): "built on the same open-source checkpoint as Composer 2, Moonshot's
  Kimi K2.5"; no mention of Auto.

## 5. GitHub Copilot — primary docs, read 2026-09-07

https://docs.github.com/en/copilot/concepts/models/auto-model-selection
- "One system tracks real-time system health and availability, while the other evaluates task complexity."
- "Routing occurs along natural cache boundaries to avoid additional cache related costs."
- "10% discount on model costs while using auto model selection in Copilot Chat, Copilot CLI, GitHub
  Copilot app, or Copilot cloud agent" (paid plans).
- "You can see which model was used for each Copilot response." (Visible after the fact — the opposite
  of Cursor's default.)
- Agent pools: Codex agent → GPT-5.3-Codex, GPT-5.4, GPT-5.4 nano; Claude agent → Opus 4.7, Sonnet 4.6.
  Exclusions: plan-unavailable, admin-blocked, data-residency/FedRAMP-restricted, evaluation models.

## 6. Amp (Sourcegraph) — primary, read 2026-09-07

- Manual (https://ampcode.com/manual): modes via "The Dial": `low`, `medium`, `high`, `ultra`; "Choose a
  mode based on the task rather than the model name." Subagents Review, Search, Oracle, Librarian,
  Read Thread; "Amp chooses subagents automatically for suitable tasks, mostly in `medium` mode".
- "The Dial" post (2026-07-09): "The old modes were models in disguise: each name hid a model, a prompt,
  a reasoning effort". Model per mode at time of post: ultra = Claude Fable 5 with GPT-5.6 Sol oracle;
  high = GPT-5.6 Sol extended reasoning with Fable 5 oracle; medium = GPT-5.6 Sol medium with
  higher-effort oracle; low = GLM-5.2 with GPT-5.6 Sol oracle. Plugins can register custom modes.
  (Older names smart/deep/rush/large are retired per the search snippet — verified=false for that detail.)

## 7. OpenCode, Crush, Kilo, Cline, Roo, Gemini CLI — read 2026-09-07

- **OpenCode** (https://opencode.ai/docs/agents/): per-agent `model` in `provider/model-id` form; "If you
  don't specify a model, primary agents use the model globally configured"; subagents "use the model of
  the primary agent that invoked the subagent". Example Plan agent on a Haiku model. No auto router.
- **Crush**: README and schema.json contain no "large/small" prose; the schema's `models` is "Model
  configurations for different model types" and `SelectedModel.reasoning_effort` is "Reasoning effort
  level for OpenAI models that support it". The large/small split (large for coder agent, small for task
  agent/titles) comes from DeepWiki and GitHub issues #2748/#2141 — verified=false.
- **Kilo** (https://kilo.ai/docs/code-with-ai/agents/auto-model): tiers Frontier ("different models for
  reasoning-heavy tasks (planning, architecture, debugging) versus implementation tasks"), Efficient
  ("Session-aware routing that classifies the difficulty of each request"), Free (OpenRouter free
  models). Visibility: users "see which underlying models are used, as well as the cost, in the expanded
  model picker"; underlying models "updated server-side".
- **Cline** (https://docs.cline.bot/features/plan-and-act): "You can configure separate models for Plan
  and Act modes ... a stronger reasoning model for planning and a faster model for implementation."
  Table rows: Cost optimization = GLM 4.6 | Grok Code Fast; Maximum quality = Claude Opus | Claude Sonnet;
  Speed = Gemini 3 Flash | Cerebras.
- **Roo Code** (https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles): "In the
  Prompts tab, you can explicitly associate a specific Configuration Profile with each Mode."
  Orchestrator/Boomerang: "Each subtask operates in complete isolation with its own conversation history";
  orchestrator "can't ... read files, write files, call MCPs, or run commands". No cost guidance.
- **Gemini CLI** (https://geminicli.com/docs/get-started/gemini-3/): "Auto routing first determines
  whether a prompt involves a complex or simple operation. For simple prompts, it will automatically use
  Gemini 2.5 Flash. For complex prompts, if Gemini 3 Pro is enabled, it will use Gemini 3 Pro; otherwise,
  it will use Gemini 2.5 Pro." Opt out via `/model` → Pro. The model-routing doc adds that utility calls
  use "a silent fallback chain for `gemini-2.5-flash-lite` ... `gemini-2.5-flash` and `gemini-2.5-pro`"
  and quota failures "initiate the fallback process". Which model classifies (Flash-Lite / local Gemma
  3 1B) came from search snippets — verified=false.

## 8. Standalone routers — read 2026-09-07

- **RouteLLM** (arXiv 2406.18665, v4 2025-02-23; GitHub lm-sys/RouteLLM): "reduce costs by up to 85%
  while maintaining 95% GPT-4 performance on widely-used benchmarks like MT Bench"; routers mf,
  sw_ranking, bert, causal_llm, random; "same performance as commercial offerings while being >40%
  cheaper". Single-prompt chat benchmarks, not agentic.
- **Not Diamond** (https://www.notdiamond.ai/): "5%+ accuracy gains, 20%+ cost savings" marketing claims;
  case study "$1.2M (25% cost reduction)" for 1,000 engineers at $300/month; docs page gives no numbers.
- **Martian**: route.withmartian.com failed TLS handshake from here (blocked); withmartian.com is a
  research page with no router numbers. "up to 98%" / "20%-97%" savings are from third-party coverage
  — verified=false.
- **OpenRouter Auto** (https://openrouter.ai/docs/features/model-routing): "A fast, lightweight classifier
  assigns each prompt one of ~30 fine-grained task types"; ranks by community "Share of Spend" over a
  trailing 7-day window; cost bands `low, medium, high, xhigh, max`; "You pay the standard rate for
  whichever model is selected. There is no additional fee"; session stickiness "remembers the model a
  conversation landed on". Does not mention Not Diamond.
- **LiteLLM Auto-Router** blog (2026-07-27): Haiku 4.5 / Sonnet 5 / Opus 5 tiers; "40.4% cheaper at 97.1%
  of frontier quality" on 220 prompts; "74.5% cheaper at 87.3%" on RouterArena 8,399 queries; "SWE-bench
  Lite: Largest quality reduction at 21% cost savings". Vendor's own benchmark.

## 9. Published evidence on cost vs quality in agentic coding

- **TwinRouterBench** (arXiv 2605.18859, v2 2026-05-22): step-level routing benchmark; static track "970
  router-visible prefixes from 520 instances across SWE-bench, BFCL, mtRAG, QMSum, and PinchBench";
  dynamic track on SWE-bench Verified measuring "actual API expenditure". Motivation: routers are usually
  evaluated on single prompts; agents make many sequential calls.
- **SWE-Router** (arXiv 2607.00053, 2026-06-30): lets "a cheap model run for a few exploratory turns"
  before escalating; Bayes-optimality theorem that "conditioning on the partial trajectory never harms
  routing"; "maintaining the majority of the performances of the stronger model". Search snippet
  (verified=false) adds the important line that on public per-task results "solve sets are largely
  nested, and routing for accuracy offers little headroom, but routing for cost only requires predicting
  when a cheaper model will suffice".
- **Scrouting / SuperScout** (arXiv 2608.04804, 2026-08-05): SWE-bench Pro Python slice (266 tasks);
  "matches the best single model's solve rate (159 of 266 for SuperScout, 158 for the best model) at
  about a fifth of the total cost per solve"; searcher "less than half a cent of GPU time per task";
  "the handoff rather than the routing decision carries the result".
- **Triage** (arXiv 2604.07494, 2026-04-08): SWE-bench Lite, 300 tasks, three tiers; routes to "the
  cheapest model tier whose output passes the same verification gate as the expensive model"; two
  conditions: light-tier pass rate on healthy code must exceed the inter-tier cost ratio, and code
  health must discriminate tier with effect size p̂ ≥ 0.56.
- Devin per-task table (section 1) is the clearest public evidence that *which work* is delegated,
  not *whether* to route, decides the quality outcome.

Synthesis: every vendor with a router (Cursor, Copilot, Kilo, OpenRouter, LiteLLM, Devin) uses a cheap
classifier plus a cache-boundary switch, and every honest evaluation shows cost savings of 20-60% with a
quality loss that is small on mechanical/verification work and large on judgment work. Nobody has shown
routing that *raises* accuracy on SWE-style benchmarks beyond the best single model by more than noise.

---

## 10. What Wanigan actually holds (code read 2026-09-07, all paths absolute under the Wanigan repository)

Wanigan does not own a harness. It spawns real CLIs as PTYs (`src/main/sessions.ts`) or `-p`/`exec`
runs (`src/main/headless.ts`) and records what they report. So the Devin/Cursor levers map like this:

| Devin/vendor lever | Wanigan equivalent | Where |
|---|---|---|
| Choose frontier vs cheap model per task | Profile + `--model` per launch, intersected with the backend catalogue | `src/main/launch-choices.ts:112-160`, `src/main/providers.ts:143-155` (claude `--model`/`--effort`), `:180-196` (codex `--model`, `--config model_reasoning_effort="…"`), `:241-253` (GLM: no effort), `:284-293` (DeepSeek) |
| Effort / reasoning level | `effort` launch field; Codex efforts narrowed to what the installed CLI reports | `src/shared/launch-fields.ts:88-135`, `src/main/codex-status.ts:260-263` |
| Sidekick / subagent on a cheaper model | **No launch field.** `CLAUDE_CODE_SUBAGENT_MODEL` is only inherited from the operator's shell because `agentEnv` copies `process.env` | `src/main/sessions.ts:240-262`; pack env denylist at `src/main/provider-packs.ts:54-63` does not refuse it, so a local pack *could* set it as a literal (shown at consent) |
| Tier remap (opus/sonnet/haiku → cheaper vendor) | Built-in GLM/DeepSeek profiles set `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`; haiku tier → `glm-5.3-flash` / `deepseek-v4-flash` | `src/main/providers.ts:267-274, 302-309`; manifest form `src/main/provider-packs.ts:930-960` |
| Cheaper profile for unattended fan-out | Operator picks provider + model + effort in the Runs form | `src/renderer/src/views/HeadlessRuns.tsx:85,119-120,426-440`; compiled at `src/main/headless.ts:266-311` |
| Per-run spend cap | Claude only: `--max-budget-usd` handed to the CLI. Codex: "no budget flag of its own and reports no cost, so cfg.timeoutMs is the only ceiling" | `src/main/headless.ts:280-282, 303-306` |
| Per-repo / global monthly budget | `budgets` table, warn fraction, projection | `src/shared/types.ts:1736-1755`, `src/main/spend.ts:581-700` |
| Cost per outcome, so the operator learns | `work_model_outcomes(provider_id, model, task_kind, accepted, tests_passed, cost_usd)` filled on review decision; rendered as "Outcome router" | `src/main/control.ts:704-714, 763-775`; `src/main/db.ts:1078-1092`; `src/renderer/src/views/Control.tsx:550` |
| Effort → cost | Session requests grouped by effort, dearest first | `src/main/spend.ts:322-370`, `src/renderer/src/views/Insights.tsx:1267-1365` |
| Per-request model observed (subagent model shows up here) | OTLP `claude_code.cost.usage` keyed by `['model','effort']`; per-session `models[]` | `src/main/otel.ts:44`, `:769-776`; telemetry-gated at `src/main/sessions.ts:265` |
| Honest cost basis | Only `anthropic` is reconcilable; GLM/DeepSeek/Codex dollars are "unverified" | `src/main/providers.ts:382, 406-412`; `src/main/otel.ts:684-700` |
| Never hidden routing | Profile fingerprint frozen per session/run; launch refused if it changes | `src/main/headless.ts:577-580, 653-656, 863` |
| A/B of routing choices | `learning/experiments.ts` fixes provider/model/effort/commit but "does not launch workloads" | `src/main/learning/experiments.ts:1-60, 200-260` |

What Wanigan cannot do, and should say so rather than fake: mid-session model switching at compaction
(the harness owns compaction), classifier-driven routing inside a turn, and any cross-provider "auto"
model. The nearest honest analogues are (a) opusplan / advisor / `CLAUDE_CODE_SUBAGENT_MODEL` passed
through explicitly and recorded, and (b) choosing a cheaper profile for verification-heavy or mechanical
fan-outs — exactly the two classes where Devin's own table shows no quality loss.

---

## 11. Findings (each with file:line, quote, consequence, fix, size)

F1. **No subagent-model lever, the cheapest documented Claude Code saving.**
`src/main/sessions.ts:244-252` copies `process.env` wholesale into the child; nothing in
`src/main/providers.ts:143-155` or the shipped Claude launch fields emits `CLAUDE_CODE_SUBAGENT_MODEL`
(or `_FORCE`). Consequence: an operator can only get Explore/Task subagents onto Haiku by exporting the
variable in the shell that launched Wanigan, and `session_log` (`src/main/db.ts:170-184`) then records
nothing about it, so the cheaper run is indistinguishable afterwards from a full-price one. Fix: add an
optional `subagentModel` launch field for the `claude-code` harness compiled to the env pair, show it in
the launch consent, persist it beside `model`/`effort` in `session_log` and `runs.config_json`. Size: M.

F2. **Outcome router totals unmetered cost as $0 and ranks it cheapest.**
`src/main/control.ts:709-713`: `usage?.costStatus === 'reported' ? usage.costUsd : 0`, and
`outcomes()` at `:765-767` does `SUM(o.cost_usd) ... ORDER BY accepted DESC,tests_passed DESC,samples DESC`.
`Control.tsx:550` renders `usd(outcome.totalCostUsd)`. Consequence: a GLM/DeepSeek/Codex phase whose CLI
reported no cost shows "$0.00" next to an Anthropic phase's real dollars, which is the CLAUDE.md
"unpriced call ... never totalled as spend" rule broken on the one surface built to teach the operator
which profile to use. Ordering by raw `accepted` count also favours whichever profile ran most. Fix:
add `cost_status` to `work_model_outcomes` (additive), render "unreported" and exclude from the money
column; order by rate with a minimum-sample guard. Size: M.

F3. **Budgets add unverified GLM/DeepSeek "dollars" to verified Anthropic ones.**
`src/main/spend.ts:646-651`: `SELECT COALESCE(SUM(e.cost_usd), 0) ... FROM session_api_events e` with
no backend filter, while the per-session path (`src/main/otel.ts:684-700`) labels the same rows
unverified. Consequence: a $50 project budget can warn or "breach" (`budgetBreached`, `:792`) on a Z.ai
flat-plan session whose dollars are "the CLI's arithmetic about a model it is not billing for"
(`providers.ts:222-229`). Fix: split `BudgetState.spentUsd` into reconcilable vs unverified using
`backendCostBasis`, and only the reconcilable half can breach. Size: M.

F4. **Scheduled runs route to "first installed provider" and cap at a constant.**
`src/main/index.ts:472-475` `defaultHeadlessProviderId` returns the first provider with `headlessJson`;
`:262` `SCHEDULED_BUDGET_USD = 2` and `:888` pass it regardless of provider. Consequence: which profile
spends at 03:00 depends on detection order, and for Codex the $2 "cap" is silently not a cap
(`headless.ts:280-282`). Fix: require an explicit provider on a schedule, and show "cap: $2 (Claude) /
timeout only (Codex)" on the Schedules row. Size: S.

F5. **Cross-profile cost-per-success cannot be computed from headless rows.**
`src/main/db.ts:319-336` `headless_rows` has no `provider_id`/`model`; `src/main/headless.ts:748` writes
`runs.model = cfg.model?.trim() || cfg.providerId`, so once a model is named the profile is gone from the
row and lives only in `config_json`. Consequence: the question the Devin table answers ("cheapest
profile that still passes on this repo") has no query. Fix: additive columns `provider_id`,
`profile_fingerprint`, `model`, `effort` on `headless_rows`; a `spend:byProfile` rollup joining
`status IN ('succeeded')` and `cost_reported=1`. Size: M.

F6. **Mid-session `/model` and `/effort` are sent but not recorded.**
`src/renderer/src/views/Sessions.tsx:1424` ("these controls send exactly that" — slash commands typed
into the PTY); `session_log.model/effort` are launch-time only; per-request model is captured only
when `flags().telemetry` is on (`src/main/sessions.ts:265`). Consequence: with telemetry off, a session
that was switched to Opus xhigh is recorded as the Sonnet it launched with. Fix: log a `session_events`
row "requested /model X" (a request, not proof) when the control sends it. Size: S.

F7. **Stale claim of a Codex "Auto" model in the launch dialog.**
`src/renderer/src/components/NewSessionDialog.tsx:666-667`: "opens Codex's own picker, including its
Auto choices and reasoning levels." Current OpenAI docs describe only a "recommended model" default and
no Auto entry. Consequence: text promises a routing choice Wanigan has not verified. Fix: re-verify
against the installed CLI's `/model` picker; otherwise drop "Auto". Size: XS.

F8. **Effort distribution reports spend, never outcome.**
`src/main/spend.ts:322-370` and `Insights.tsx:1267-1365` show cost by effort with a "high effort" tag but
no success/accept signal; the outcome table (F2) is per provider/model/task_kind but not per effort
(`work_model_outcomes` has no `effort` column, `db.ts:1078-1090`). Consequence: the operator sees that
xhigh is 60% of spend but not whether it was worth it. Fix: add `effort` to `work_model_outcomes` and
to the Outcome router grouping. Size: S.

F9. **A/B registry exists but cannot answer a routing question.**
`src/main/learning/experiments.ts` fixes provider/model/effort/commit and the CLAUDE.md note says it
"does not launch workloads; a manually closed run remains an estimate". Consequence: the only causal
instrument Wanigan has for "cheaper profile, same quality" is one the operator must run by hand. Fix:
none required now; keep the label honest and point the Outcome router at it. Size: —.

---

## 12. Recommendations for Wanigan (ordered by value / size)

1. Ship F1: an explicit, consented, recorded `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` launch field — the
   Claude-side analogue of Devin's sidekick, using the harness's own documented mechanism.
2. Fix F2/F3 together: never total an unreported or unverified figure as dollars in Outcome router or
   budgets; carry `costStatus`/`costBasis` through both.
3. Ship F5 + F8: provider/model/effort on headless rows and outcomes, then a "cost per accepted result
   by profile, per task kind" view. That is the operator-learning loop the Devin table demonstrates.
4. Add "recommended for delegation" copy on the Runs form grounded in the evidence: verification-heavy
   and mechanical prompts (test runs, deprecations, upstream-reuse) to a cheaper profile; plan / review
   / ambiguous features on the frontier profile. State the Devin caveat verbatim.
5. Keep saying no to hidden routing. Cursor's default is to hide the routed model; Copilot and Kilo show
   it. Wanigan's values require the Copilot/Kilo stance, and F6 is where it currently slips.

## 13. Sources (all read 2026-09-07)

Primary: cognition.com/blog/devin-fusion (2026-06-29, data 2026-08-07); code.claude.com/docs/en/{sub-agents,
model-config,advisor,fast-mode,settings}; platform.claude.com/docs/en/build-with-claude/fast-mode;
claude.com/blog/the-advisor-strategy; learn.chatgpt.com/docs/{config-file/config-reference,
developer-settings,models}; cursor.com/docs/{models,cursor-router}; cursor.com/blog/{how-cursor-router-works
(2026-08-06),composer-2-5 (2026-05-18)}; docs.github.com/en/copilot/concepts/models/auto-model-selection;
ampcode.com/manual; ampcode.com/news/the-dial (2026-07-09); opencode.ai/docs/agents; kilo.ai/docs/code-with-ai/agents/auto-model;
docs.cline.bot/features/plan-and-act; roocodeinc.github.io/Roo-Code/features/{boomerang-tasks,api-configuration-profiles};
geminicli.com/docs/get-started/gemini-3; github.com/google-gemini/gemini-cli docs/cli/model-routing.md;
openrouter.ai/docs/features/model-routing; notdiamond.ai; arxiv.org/abs/{2406.18665,2605.18859,2607.00053,2608.04804,2604.07494};
github.com/lm-sys/RouteLLM; docs.litellm.ai/blog/auto-router-cost-quality-benchmark (2026-07-27);
raw.githubusercontent.com/charmbracelet/crush/main/{README.md,schema.json}.
Blocked: route.withmartian.com (TLS handshake failure). Secondary only: Crush large/small (DeepWiki),
Gemini classifier model, Amp legacy mode names, Martian percentages.
