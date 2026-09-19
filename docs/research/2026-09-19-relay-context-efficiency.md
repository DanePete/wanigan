# Relay context efficiency — primary-source research, 2026-09-19

Recommendation: first reduce repeated discovery and oversized observations, while
preserving test evidence and measuring accepted results. Then evaluate bounded
context controls and effort escalation. Cache tuning is a separate experiment:
fewer transmitted tokens do not necessarily mean lower billed cost.

This memo reads local implementation and ten primary-source groups. No paid
calls, installations, provider configuration changes, or product edits were
made. Documentation was retrieved on 2026-09-19; mutable docs and repository
branches are not proof that the trial's Codex 0.154.0/0.155.1 implements every
current feature. Proposed improvements below are hypotheses, not measured gains.

## What the live evidence and implementation actually establish

The [three live trials](2026-09-19-relay-live-trials.md) recorded 6,181,000
cumulative input tokens, including 5,789,568 cached tokens: **93.7% cached** by
arithmetic over the recorded counters. These are repeated whole-session inputs,
not a six-million-token prompt, an invoice, or evidence that 93.7% of cost was
saved. Tasks, effort, models and work differed; there was no controlled comparison
and no final human-approved outcome.

- [codex-usage.ts](../../src/main/codex-usage.ts), lines 54–74 and 105–117, reads
  native cumulative counters, separates cached input from `inTokens`, and does
  not invent a dollar amount. It does not extract a cache-write counter or
  reasoning-output breakdown. Insights deduplicates conversation IDs at lines
  122–142, but session rows receive a thread's cumulative counters.
- [control-outcomes.ts](../../src/main/control-outcomes.ts), lines 14–47,
  preserves all launched attempts and unknown dollar cost. However, its frozen
  attempt token fields include only `inTokens` and `outTokens`; cached input is
  absent. That is insufficient for comparing context policies from outcome rows.
- [control.ts](../../src/main/control.ts), lines 694–758, starts a fresh phase
  session with objective, phase instructions, acceptance checks and a goal
  capsule. Its input exposes provider/account/model/effort/permission choices,
  not cache options, compaction thresholds, arbitrary provider options or a
  live effort-update protocol.
- [sessions.ts](../../src/main/sessions.ts), lines 1311–1369, already injects
  query-scoped learning context plus the goal capsule through proven instruction
  channels. [learning/briefing.ts](../../src/main/learning/briefing.ts), lines
  156–220, bounds retrieval to 64–8,000 estimated tokens (default 1,200), ranks
  relevance, filters backend compatibility, and revalidates citations. Reuse
  this boundary; do not add a second unbounded memory prompt.
- [provider-packs.ts](../../src/main/provider-packs.ts), lines 945–951, declares
  Codex model and effort argv. [relay.ts](../../src/main/relay.ts), lines 174–201,
  narrows efforts against the model catalogue. Current
  [Codex hooks](../../src/main/codex-hooks.ts), lines 14–34, are observation only;
  they do not authorize rewriting tools or claiming a tool-output filter works.

## Ten useful primary-source groups

### 1. OpenAI prompt caching: preserve useful prefixes, meter writes as well as reads

The current [API prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
distinguishes GPT-5.6+ from earlier models: reads cost 0.1× ordinary input,
writes 1.25×, minimum cacheable prefix is 1,024 visible tokens, and
`prompt_cache_options.ttl` currently accepts `30m`. The input buckets are
disjoint: ordinary input = total input − cached reads − cache writes. Keys on
these models separate cache accounting; they are not required to improve routing.
Earlier-model retention and key guidance differs. Stable instructions/tool
definitions help; rewriting history, compaction and relevant parameter changes
can reset reuse. These are **API semantics**, not verified Codex subscription
billing or supported Relay knobs. A retained session does not guarantee a hit.

Relay inference: do not insert changing task IDs before reusable material if
the harness permits a stable shared prefix. Today the goal capsule precedes
the briefing (`sessions.ts:1364`) and contains task identity near its start
(`sessions.ts:889–891`). Test ordering only after ensuring instruction meaning
is preserved; the CLI's complete rendered prefix is outside Relay's control.

### 2. Codex has context controls, but Relay must expose and verify them deliberately

The [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents `tool_output_token_limit` as the budget for storing each tool output
in history; `model_auto_compact_token_limit` triggers compaction; unset values
use model defaults. `model_auto_compact_token_limit_scope` distinguishes total
context from growth after a preserved prefix. These are not interchangeable
with a model's context-window size, reasoning effort, or output-token limit.

Relay inference: a provider-version-tested, invocation-scoped launch capability
could compare smaller observation budgets with defaults. Do not silently change
global Codex config, claim these settings are supported by every installed
version, or make aggressive early compaction the universal cheap mode. Current
Relay contracts expose neither control. A lower output cap also needs a reliable
way to retrieve omitted errors and source lines.

### 3. Adaptive effort is real, but API support does not imply CLI control

OpenAI's [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
documents `configuration_update` for changing effort while retaining the original
request prefix. Current support is specifically GPT-6 Astra, standard,
single-agent Responses requests. It is not a general model-switch protocol.

Relay can already choose model plus supported effort at each new stage or retry.
Prefer observable escalation triggers—failed acceptance check, unresolved
cross-module change, repeated unsuccessful repair—over repeated expensive
self-assessments. A live mid-turn effort change needs a new proven harness
interface. Exact Codex recovery intentionally leaves saved thread settings with
Codex (`sessions.ts:1403–1421`); it is not a safe shortcut to reroute effort.

### 4. Anthropic context engineering: references and relevant state beat bulk loading

[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
(2025-09-29) describes just-in-time retrieval using paths and other lightweight
references, compact state, and task-specific context. It is engineering guidance,
not a Relay benchmark or a promise that every shorter prompt performs better.

Relay proposal: append a compact task manifest containing likely entry points,
module ownership, acceptance commands and unresolved questions. Keep full source
available on demand. Do not put every historical plan, transcript or repository
file into the initial prompt. Preserve approved rules and their provenance.

### 5. Anthropic tool search and programmatic processing target different overhead

[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
(2025-11-24) separates deferred tool definitions from filtering intermediate
results in code. Its reported 85% tool-definition reduction and 37% token
reduction on complex research are vendor experiments, not expected Relay savings.
Deferred loading preserves the initial prefix by adding tools when discovered.

Relay proposal: measure definition overhead before adding a tool-search layer.
For Wanigan-owned tools, return selected fields or aggregates where appropriate,
with a route to full evidence. Current PTY integration cannot substitute API
`defer_loading` or programmatic-tool fields for a CLI's native tool machinery.
Batch independent local reads in deterministic code; additional model agents
are not necessary just to count, filter or sort data.

### 6. Claude Code exposes useful diagnostics; examples still need engineering review

The current [Claude Code cost guide](https://code.claude.com/docs/en/costs)
documents cache diagnostics, effort selection, and isolating verbose work in
subagents. Its `/usage` attribution is approximate local history, not a complete
cross-device bill; MCP attribution changed in v2.1.222. It also notes that
compaction itself consumes input. Reasoning budgets are model-dependent;
adaptive models ignore nonzero fixed `MAX_THINKING_TOKENS` budgets.

Do not copy its illustrative test-filter hook unchanged: it pipes the command
through `grep` and `head` without preserving the original exit status. By shell
semantics, that can misreport a failed test command. Relay must record the
original command's exit and raw evidence before summarizing output. Subagents
can reduce the parent's context while increasing total tokens; attribute both.

### 7. Aider's repository map is a practical deterministic retrieval reference

[Aider's map documentation](https://aider.chat/docs/repomap.html) describes a
token-budgeted selection of symbols/signatures from the repository, with a
default map target of 1k tokens that can expand. The actual
[repomap implementation](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
constructs a dependency graph and uses personalized PageRank biased toward
mentioned/chat files. This is implemented selection, not a model-generated
repository summary. The cited page does not establish causal cost savings.

Relay proposal: start with a cheaper local index of entry points, imports and
changed-file neighbors, keyed by checkout identity. Cap it, cite paths, and
invalidate it after relevant edits. Compare search/read tool turns and missed
dependencies before adopting a full graph index. A read-only map is a locator,
not authoritative instructions and not grounds to omit files from review hashes.

### 8. SWE-agent's interface findings favor focused reads, with a version warning

The [SWE-agent ACI documentation](https://swe-agent.com/latest/background/aci/)
reports useful 100-line file windows, concise file-level search matches and
explicit empty-command success, alongside edit-time linting. These are historical
interface findings; the project now says it is maintenance-only and superseded
by mini-swe-agent. Do not transplant its 100-line setting as a universal optimum.

Relay proposal: teach bounded search/read behavior in task context and use
precise file references. A Wanigan-owned reader could return path, line range,
truncation status and a continuation locator. Existing CLI tools remain the
execution surface until an alternative is implemented and tested end to end.

### 9. RTK is a filtering implementation to study, not a savings guarantee

RTK's [README](https://github.com/rtk-ai/rtk/blob/develop/README.md) measures
estimated tokens using bytes/4. Its actual
[size guard](https://github.com/rtk-ai/rtk/blob/develop/src/core/guard.rs)
only refuses output that is larger by that estimator; it does not prove semantic
completeness. Its [recovery implementation](https://github.com/rtk-ai/rtk/blob/develop/src/core/tee.rs)
distinguishes failures-only from always-archive behavior. These mutable branches
were read, not installed or executed; pin a reviewed revision before adoption.

Relay proposal: first summarize Wanigan-owned verification output, preserving
raw artifacts, exact exit code, failure identities, warnings and an explicit
truncation/retrieval marker. Do not transparently rewrite arbitrary shell pipes
or JSON consumed by another process. Evaluate filter recall as well as output
size; a large reduction can simply mean missing evidence.

### 10. A recent controlled context study supports testing, not assuming transfer

[Less Context, Better Agents](https://arxiv.org/html/2606.10209v1)
(2026-06-08 preprint) evaluates 50 expense-itemization tasks over five runs.
With the user model held fixed, last-five-tool-pairs plus summarization reports
91.6% completion versus 71.0% for full history, with 62.7% fewer tokens. This is
an ERP workflow, not repository editing. Reported token totals include agent and
user-model usage; the paper does not establish cache-weighted dollar savings.

Relay inference: test compact structured handoffs at phase boundaries, not
arbitrary deletion of a CLI's conversation. Retain objective, decisions,
changed paths, failed approaches, exact verification references and open risks.
Keep original evidence retrievable; use a paid summarizer only when measured
benefit exceeds its own cost and semantic processing stays on the allowed backend.

## Small implementation sequence and measurement contract

1. **Complete context accounting first.** Extend frozen attempt evidence with
   input-total and distinct cache-read/write/ordinary-input fields where reported;
   record unsupported fields as unknown, not zero. Include conversation ID,
   counter baseline/end, metering source, provider/profile/backend, CLI version,
   billing mode, requested/effective model and effort, and policy version.
   Delta cumulative counters for resumed threads and avoid counting them twice.
   Keep API rate estimates separate from subscription usage and actual spend.
2. **Pilot a bounded task manifest plus local search guidance.** Use current
   capsule/briefing delivery and module ownership. Start with repository paths,
   acceptance commands and selected symbols; no new inference call. Compare
   discovery turns, bytes returned, rereads, acceptance and reviewer correction.
3. **Pilot evidence-preserving summaries in the Review module.** Run required
   commands unchanged; retain the full output and exit. Show concise counts and
   complete failures with a full-log reference. Offline fixtures must cover
   late failures, warnings, malformed output, empty output and truncation.
4. **Then compare provider-specific context/effort policies.** Keep current
   defaults as control. Add only version-proven launch controls through typed
   capabilities. Compare effort escalation and observation caps independently
   before combining them. Scheduling related eligible work on the same route
   may preserve reuse, but must not override correctness, account isolation or
   latency needs. Do not send paid keepalive prompts merely to warm a cache.

Evaluate paired tasks from the same commit and environment, fixed provider,
model and effort for context experiments, and the same acceptance gate. Counter-
balance order and separate naturally warm from cold runs. Include router calls,
summarization, every failed attempt and child agent where measured. Report
accepted tasks/hour, time to accepted result, first-pass acceptance, regressions,
reviewer correction, tool turns, uncached/read/write input and output separately.
Unknown spend stays unknown; missing child metering weakens the total label.

A policy should be adopted only when quality is at least maintained and total
cost or throughput improves on those measurements. Whole-session token totals,
filter byte reduction, vendor benchmarks and three successful integrations are
useful diagnostics, but none alone establishes that result for Relay.
