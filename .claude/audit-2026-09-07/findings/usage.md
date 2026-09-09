# Usage view: src/renderer/src/views/Usage.tsx, src/renderer/src/styles/usage.css, src/main/usage.ts, src/main/limits.ts, src/main/claude-limits.ts, src/main/codex-usage.ts

33 findings. readability={"firstPaintWords": 40, "fontSizesInSheet": 2, "explainerHintNoteUses": 3, "nestedBorderDepth": 2, "notes": "First paint: eyebrow (7 words) + 'Usage' (1) + lead paragraph (32) = 40 words precede the window select in DOM order (Usage.tsx:384-393); confirmed in both screenshots. usage.css declares two token sizes (--t-micro at 44/56/73, --t-small at 46); the TSX spells eleven more via inline style (the ratchet baseline is 45 objects). Note \u00d73 (149 spend-control, 407 error, 421 relief), Explainer 0, Hint 0. Primary content (limit meters) sits inside a bordered .sunk card (depth 1) and the meter track adds its own 1px border (depth 2); the pane itself is unbordered."}

notes: Confirmed fixed: the prior '.view' root finding — Usage.tsx:378 now roots on `.pane` (index.css:647-652 supplies the gutter) and the screenshot shows the standard gutter and sticky head. Stub artifacts, not bugs: (1) picker 'Last 14 days' over heading 'last 7 days' is renderer-harness.mjs:70 `days: 7` — but the same transient is real during any window change (USG-07); (2) the top-right 'Codex Now 0% left · resets 0m' badge is App.tsx ProviderUsageBadge under the stub and outside this area — note it reads the default Codex account via codex.status while Usage reads per account, so the two can legitimately disagree. Verified from code, not screenshot: every class in Usage.tsx resolves (u-* in usage.css, us-relief-* in ui.css:210-211, legend/viz-table/sunk/pill/label/label-stencil/mono/faint/dim/trunc/field/btn in index.css, mo-fill in styles/motion.css:48, note tones in ui.css:108-110); every custom property used is defined (--series-1..4, --critical, --warning, --t-micro/small/body, --s-1/2, --line-soft, --text-faint, --bg, --mo-p); no NaN/Invalid Date path found (fetchedAt and resetsAt are null-checked, clampDays guards the IPC input). The 30-s countdown interval is cleaned up (333-335). Not verified: whether `claude -p /usage` itself counts as a request against the limit it reads. Areas outside scope but adjacent: Insights duplicates the consumption half; the nav badge's Codex read path.

## 1. [bug/high/small] Two accounts with the same label merge into one consumption chart and indistinguishable table rows
- where: src/main/usage.ts:84
- evidence: usage.ts:84-90 maps daily rows to `{ day, accountLabel: labelFor(row.account_id), model, tokens, costUsd }` — accountId and harness are dropped. Usage.tsx:178 `const mine = points.filter((p) => p.accountLabel === accountLabel);` and 371-375 dedupes labels with `new Set([...])`. accounts.ts:150-151 seeds every harness's first account as 'Personal', so a Claude 'Personal' plus a Codex 'Personal' is the default case (the fixture and screenshot show that pair). ConsumptionTable rows at Usage.tsx:286-288 print only `row.accountLabel`; there is no harness column.
- failure: An operator with Claude 'Personal' and Codex 'Personal' sees one 'Personal' chart whose bars sum both agents' tokens, and two 'Personal · model' rows in the spend table that cannot be told apart — while the limit cards above distinguish the same two accounts by harness pill.
- fix: Carry accountId and harness on ConsumptionPoint/ModelConsumption (usage.ts already groups by l.account_id); group charts by accountId, title them `${label} · ${harnessLabel(harness)}`, add a harness column or pill to ConsumptionTable.

## 2. [bug/high/small] Opening Usage invents a Codex 'Personal' account and shows a card for an agent that is not installed
- where: src/main/limits.ts:121
- evidence: limits.ts:121 `const codexAccounts = accounts.list('codex');` and claude-limits.ts:264 `accounts.list('claude-code')`. accounts.ts:154-155 `export function list(harness) { seed(harness); ...}`; seed() at 139-151 inserts a 'Personal' row whenever `supportsAccounts(harness)` and the table is empty — no check that the CLI or directory exists. accounts.ts:161-166 listAll's own comment: 'seeding a harness the operator has never used would invent a Personal account for an agent that is not installed'. codex-status.ts:169-170 then throws 'No Codex-harness provider is installed…' which limits.ts:95-98 maps to state 'unsupported'.
- failure: Every install without Codex gets a durable agent_accounts row and a 'Personal · Codex' card reading 'No Codex-harness provider is installed, so Wanigan cannot read Codex usage status.' A Codex-only machine gets a 'Personal · Claude Code' card saying its configuration directory is missing. A row the operator never created now appears in Settings › Agents › Accounts.
- fix: In allAccountLimits use accounts.listAll() and route by harness (READABLE set already exists); reserve list(harness) for surfaces about one agent, or make seed() require the harness's provider to be detected.

## 3. [honesty/high/small] A missing or crashed claude binary, or a 60 s timeout, is reported as 'Not signed in'
- where: src/main/claude-limits.ts:239
- evidence: claude-limits.ts:212 `child.on('error', () => finish(null));` resolves `{ text: '', code: null }`; 208 the 60 s timer does the same. runAuthStatus 176-177 `const start = text.indexOf('{'); if (start < 0) return null;` ignores `code`. limitsFor 239-241 `if (!identity) { return remember({ ...base, state: 'signed-out', fetchedAt: Date.now(), detail: 'Not signed in. Start a session on this account and run /login once.' }); }`.
- failure: With claude absent from PATH, a spawn EACCES, or a hung binary, every Claude card tells the operator to run /login on an account that is signed in, and the false verdict is cached for ten minutes (238, 230).
- fix: Return spawn error / exit code from run(); when code is null or text is empty and no JSON was seen, report state 'unreadable' with the actual reason (error message, 'timed out after 60 s', 'exited with code N' — codex-status.ts:118-124 exitReason already does this).

## 4. [bug/medium/medium] Consumption (local SQLite) is held behind up to two minutes of CLI probes, under copy that says it is reading Wanigan's records
- where: src/main/usage.ts:101
- evidence: usage.ts:99-102 `const limits = await allAccountLimits(input?.force === true); return { limits, consumption: consumption(days), daily: daily(days), days };`. claude-limits.ts:28 `TIMEOUT_MS = 60_000`, 237 then 244 run auth status and the usage probe sequentially per account. Usage.tsx:460-461 meanwhile prints 'Reading Wanigan's records for the last {days} days…'.
- failure: On a slow or hung claude, the exact local record sits invisible for up to 120 s while the page claims it is reading its own database; the chart and table never appear before the slowest provider answers.
- fix: Split the IPC (usage.consumption({days}) and usage.limits({force})) or Promise.allSettled per account and stream; render the consumption half immediately.

## 5. [bug/medium/small] Changing the consumption window spawns provider CLI processes, contradicting the page's own promise
- where: src/renderer/src/views/Usage.tsx:322
- evidence: Usage.tsx:320-328 `load` depends on `days` and calls `window.wanigan.usage.snapshot({ days, force })`; the effect at 328 re-runs on every picker change. usage.ts:101 always calls `allAccountLimits`. codex-status.ts:44 `CACHE_MS = 45_000`, claude-limits.ts:39 `STALE_AFTER_MS = 10 * 60_000`. Comment at Usage.tsx:329-331: 'Re-probing on a timer would start a real CLI process behind the operator's back, so a fresh reading is always something they asked for.'
- failure: Switching 'Last 14 days' to 'Last 30 days' 46 s after the page opened starts a codex app-server; after ten minutes it starts two claude processes per Claude account — a limits read the operator did not ask for, and the Refresh button goes to 'Reading…' for it.
- fix: Have the picker call a consumption-only IPC (see USG-04), or pass `limits: false` and reuse the snapshot's limits in state.

## 6. [bug/medium/small] Overlapping snapshot reads race; the last to resolve wins and Refresh re-enables early
- where: src/renderer/src/views/Usage.tsx:320
- evidence: Usage.tsx:320-328 `load` has no request token or cancellation: `.then((next) => { setSnap(next); setNow(Date.now()); }) ... .finally(() => setBusy(false))`; the effect at 328 has no cleanup. The select at 392 is not disabled while busy, and the Note action at 407 fires load(true) again.
- failure: Pick 30 then 90 quickly (or press Refresh then change the window): the 30-day snapshot can land after the 90-day one, so the heading reads 'last 30 days' and the chart shows 30 days under a picker that says 90; meanwhile the first .finally flips busy off and 'Refresh limits' re-enables while a read is still in flight.
- fix: Keep a `seq` ref, ignore results whose seq is stale, and set busy from the latest request only; or disable the select while busy.

## 7. [bug/medium/small] The spend heading reports the previous snapshot's window while a new one loads
- where: src/renderer/src/views/Usage.tsx:453
- evidence: Usage.tsx:453 `What you spent · last {snap?.days ?? days} days` reads the old snapshot until the promise resolves, which (USG-04) can take up to two minutes. The screenshot shows 'Last 14 days' over 'last 7 days'; that specific pair is a fixture artifact (renderer-harness.mjs:70 `days: 7`), but the code produces the same shape in the real app during every window change.
- failure: For the length of the probe the picker says 90 and the heading says 14, with the 14-day chart below — the exact 'neither half can be trusted' state the comment at 24-33 says the page must not show.
- fix: While busy and `snap.days !== days`, show the requested window with a 'reading…' marker, or render consumption from its own immediate read.

## 8. [bug/medium/small] The first day of every consumption window is a partial day presented as a whole one
- where: src/main/usage.ts:70
- evidence: usage.ts:70 `const since = Date.now() - window * 86_400_000;` while 72 groups by `date(e.at/1000, 'unixepoch', 'localtime')`. Same at 36 for consumption().
- failure: At 3 pm, 'Last 7 days' yields eight calendar buckets; the first bar and 'Day by day' row cover 3 pm–midnight only and read as a quiet day; the model totals differ from what an operator adds up from the daily table's stated span.
- fix: Anchor `since` to local midnight `window - 1` days ago (or mark the partial day in the caption).

## 9. [bug/medium/small] The Claude probe inherits the whole desktop environment, unlike every other spawn
- where: src/main/claude-limits.ts:196
- evidence: claude-limits.ts:195-196 `const env: Record<string, string> = {}; for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;`. codex-status.ts:126-154 probeEnv passes a minimal allowlist and says handing a probe process.env 'is the opposite of the stripping every other spawn in the main process does'. sessions.ts:129-141 and headless.ts:161-170 strip CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT, ELECTRON_RUN_AS_NODE, VSCODE_* because inheriting them makes a spawned agent 'believe it is a subprocess of that session'.
- failure: Launched from inside a Claude Code session (sessions.ts says this is common), the probe runs as a nested child session; every unrelated credential in the shell is handed to a read-only status process — CLAUDE.md: automatic probes receive only a minimal credential-free environment.
- fix: Build the env from an allowlist as probeEnv does (HOME, PATH, LANG, proxies, CLAUDE_CONFIG_DIR from launchEnv), and strip the CLAUDE_CODE_* markers.

## 10. [honesty/medium/small] Signed-out and unreadable verdicts are cached for ten minutes, so following the card's own instruction changes nothing
- where: src/main/claude-limits.ts:238
- evidence: claude-limits.ts:238 `const remember = (value) => { cache.set(account.id, { at: Date.now(), value }); return value; };` wraps the signed-out (240, 246) and unreadable (253) returns; 229-230 serves the cache for STALE_AFTER_MS unless force. The card at Usage.tsx:151-155 shows only `limits.detail` — 'Start a session on this account and run /login once.' — and nothing says Refresh is required.
- failure: The operator runs /login as told, returns to Usage (mount calls load(false)), and reads 'Not signed in' for up to ten more minutes.
- fix: Do not cache non-ok states (or cap them at ~30 s), and append 'then press Refresh limits' to the detail.

## 11. [honesty/medium/small] The provider's verbatim reset time is never shown once the date parses, though the parser depends on it being the primary display
- where: src/renderer/src/views/Usage.tsx:78
- evidence: Usage.tsx:75-86 resetLabel: `if (window.resetsAt === null) return 'resets ' + resetsAtText; const left = window.resetsAt - now; ...` — when resetsAt is set only the countdown is returned; resetsAtText is not rendered or put in a title. claude-limits.ts:85-88: 'Built in local time deliberately… one elsewhere is off by its offset, which is why the verbatim text stays the primary display.' The fixture prints '(America/Chicago)'.
- failure: A machine in a different zone from the account's (travel, a work account pinned to a US zone) shows 'resets in 2h 27m' that is hours wrong, and the operator has no way to see 'Sep 6 at 8:59pm (America/Chicago)'.
- fix: Render `title={window.resetsAtText ?? undefined}` on the reset span at minimum; better, print both ('resets in 2h 27m · Sep 6 at 8:59pm (America/Chicago)').

## 12. [missing/medium/medium] Signed-out, unreadable and unsupported cards look identical and offer no action
- where: src/renderer/src/views/Usage.tsx:151
- evidence: Usage.tsx:151-155 every non-ok state renders `<p className="dim">{limits.detail ?? 'No reading.'}</p>` — no Mark, Pill tone, or button. The detail text instructs 'Start a session on this account and run /login once.' but the card has no path to a session or to Settings › Agents › Accounts (Settings.tsx:54). Screenshot: the gemini-cli card is a grey paragraph indistinguishable from what a failed Claude read would be.
- failure: A failed read (a problem) and an unsupported harness (expected) read the same at a glance; the operator is told what to do and given nothing to do it with.
- fix: Use Mark/Pill with tone per state (bad for signed-out/unreadable, quiet for unsupported) and an action slot ('New session on Work…', 'Open accounts').

## 13. [polish/medium/small] Head, section heads and pills are hand-rolled instead of PageHead, SectionHead and Pill
- where: src/renderer/src/views/Usage.tsx:382
- evidence: Usage.tsx:382-400 `<header className="pane-head">` with a bare `<div style={{ display: 'flex', gap: 8 }}>` action slot (ui.css:29 has .pane-actions); 435, 453, 493 `<div className="label">` where SectionHead (bits.tsx:265) is the primitive; 127-129 `<span className="pill">` ×3 where Pill (bits.tsx:28) exists; the view's `.us-relief-line/.us-relief-how` rules sit in ui.css:210-211 rather than usage.css. CLAUDE.md: a new view roots on .pane with PageHead and composes SectionHead, Pill…
- failure: Any change to the head or section primitives leaves Usage behind; the style gate's intent is bypassed by a raw header that matches the classes but not the component.
- fix: Replace with PageHead(eyebrow,title,lead,actions), SectionHead, Pill; move the relief rules into usage.css.

## 14. [polish/medium/small] Tone-less pills render as bare bold words, so 'stale' is invisible as a chip
- where: src/renderer/src/views/Usage.tsx:127
- evidence: Usage.tsx:127-129 `<span className="pill">{harnessLabel(limits.harness)}</span>`, `{limits.plan}`, `stale`. index.css:338-342 `.pill { display:inline-flex; padding:1px 7px; border-radius; font-size; font-weight:600 }` — no background or border unless a tone-* class is present (345-351). Screenshot confirms: 'Claude Code' and 'max' show no chip boundary in either theme.
- failure: The harness and plan read as stray words after the account name; the 'stale' warning — the one that changes a decision — carries no visual weight.
- fix: `tone-quiet` for harness/plan, `tone-warn` (or Pill with reason) for stale.

## 15. [modernize/medium/small] A 32-word lead in a sticky header, plus two more 45–50-word paragraphs, where a one-liner and an Explainer would do
- where: src/renderer/src/views/Usage.tsx:386
- evidence: Usage.tsx:384-389 eyebrow 'What is left, and what you spent' + 32-word `<p className="dim" style={{ maxWidth: '70ch' }}>` inside `.pane-head`, which index.css:684-694 makes sticky; 467-471 a 45-word empty state; 494-498 a 50-word caveat. bits.tsx:241-244: the eyebrow is 'the view's section noun or nothing — never an app-name slogan'; Explainer at bits.tsx:383 is the collapsed-by-default primitive.
- failure: Every visit and every scroll of a 90-day table carries ~110px of reasoning above the data; Linear/Raycast-style surfaces put the rationale behind a disclosure and lead with the numbers.
- fix: Lead: 'Live limits per account; consumption from Wanigan's own record.' Move the why into an Explainer; eyebrow 'Explore' or none.

## 16. [modernize/medium/medium] No at-a-glance answer: the page's question ('can I keep working?') is answered only when something hits 100%
- where: src/renderer/src/views/Usage.tsx:434
- evidence: Usage.tsx:420-432 the relief Note appears only for usedPercent ≥ 100 (354); otherwise the operator scans 3–4 cards × 3 meters (8px bordered tracks at 107, mono micro percent at 103) with per-card 'read 4:54:16 PM' timestamps (158, seconds precision) to find the tightest window. Stat (bits.tsx:137) and ago() (bits.tsx:560) exist.
- failure: Reads as a wall of equal-weight meters; the Cursor/Devin pattern is a summary strip (account · plan · worst window %, resets in) above the detail, with one 'read 3m ago' in the head instead of one per card.
- fix: Add a Stat row per account (worst window, tone by band) above the grid; replace per-card timestamps with `ago(fetchedAt)` driven by the existing `now` tick; thin the track to 4px with no border.

## 17. [bug/low/small] Series colours are assigned per account, so one model wears a different hue in each chart
- where: src/renderer/src/views/Usage.tsx:180
- evidence: Usage.tsx:180 `const models = [...new Set(mine.map((p) => p.model))].sort();` inside DailyChart (per account), 212 `className={SERIES[modelIndex % SERIES.length]}`.
- failure: With two accounts on screen, the same model is blue in one legend and orange in the next, and the reader compares the wrong bars.
- fix: Compute the model→series map once over all points in Usage() and pass it to DailyChart.

## 18. [bug/low/small] Axis labels stay pinned while the bars scroll, and a non-overlay scrollbar eats the plot height
- where: src/renderer/src/styles/usage.css:24
- evidence: usage.css:24-30 `.u-bars { ... height: var(--u-plot-h); overflow-x: auto; }` with 18-19 `--u-plot-h: 116px; --u-col-min: 14px;`; 43 `.u-axis { display: flex; justify-content: space-between; }` is a sibling outside the scroller. 90 days × (14px + 4px gap) ≈ 1.6 kpx > `--page-max: 1120px` (index.css:113).
- failure: On the 90-day window the first/last-day labels no longer mark the visible ends once scrolled; on Windows/Linux a ~15px classic scrollbar shrinks the 116px plot so every bar is drawn short.
- fix: Put the axis inside the scroller (or add tick labels per week) and reserve the scrollbar with `scrollbar-gutter: stable` or padding.

## 19. [honesty/low/small] 'resetting now' is asserted indefinitely once a cached reading's reset epoch passes
- where: src/renderer/src/views/Usage.tsx:79
- evidence: Usage.tsx:79 `if (left <= 0) return 'resetting now';` recomputed by the 30 s tick at 333 against a reading up to ten minutes old (claude-limits.ts:230) with no re-probe.
- failure: A 100% window shows 'exhausted · resetting now' for up to ten minutes after the reset happened; the meter is still red although the operator may already have room.
- fix: Past the epoch say 'reset was due {text}; this reading is older — refresh' and stop colouring it as exhausted.

## 20. [honesty/low/small] The 'What contributed' caveat is a hardcoded paraphrase of a line the parser discards
- where: src/renderer/src/views/Usage.tsx:494
- evidence: Usage.tsx:494-498: 'The agent's own breakdown, quoted as given. It describes this as approximate and based only on sessions on this machine — it does not include other devices or claude.ai — so it is shown as written'. The real reply (smoke3.ts:4239) carries 'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.' but parseUsage (claude-limits.ts:132-140) keeps only indented lines under a period, so that sentence is dropped and re-stated by hand.
- failure: If Claude changes or removes its caveat, Wanigan keeps asserting a method statement on the provider's behalf that the provider no longer makes — under a heading that says it is quoted as given.
- fix: Capture the line(s) between the 'What's contributing' header and the first period block into UsageFactors (e.g. `caveat: string | null`) and print that; drop the paraphrase.

## 21. [honesty/low/small] claudeBin() routes by the hardcoded profile id 'claude' while accounts are routed by harness
- where: src/main/claude-limits.ts:146
- evidence: claude-limits.ts:145-148 `const def = providerById('claude'); return def?.bin ?? 'claude';` vs 264 `accounts.list('claude-code')`. CLAUDE.md: 'Route behavior by declared harness/headless/capabilities, not by hardcoded profile ids such as claude'.
- failure: A Claude-harness account whose profile comes from a pack with a different id is probed with whatever `claude` is on PATH, which may be a different install from the one its sessions run.
- fix: Resolve the binary from the provider whose harnessId is 'claude-code' (as codex-status.ts:168 does for codex).

## 22. [unfinished/low/small] Meter declares a `delay` prop it never reads; the stagger it served is gone
- where: src/renderer/src/views/Usage.tsx:96
- evidence: Usage.tsx:96 `function Meter({ window, now }: { window: LimitWindow; now: number; delay: number })` and 143 `<Meter ... delay={index * 110} />`; the body never references delay and the comment at 93-95 says the bar is drawn at its value with no motion.
- failure: Dead API that invites a future reader to reintroduce a stagger the motion doctrine removed.
- fix: Delete the prop and the `index * 110` argument.

## 23. [unfinished/low/small] AccountLimits.state includes 'stale' that nothing produces; staleness is recomputed in the renderer with a duplicated constant
- where: src/shared/types.ts:1485
- evidence: types.ts:1485 `state: 'ok' | 'signed-out' | 'unreadable' | 'unsupported' | 'stale';` — grep of src/main finds no producer. Usage.tsx:119 `const stale = limits.fetchedAt !== null && now - limits.fetchedAt > 10 * 60_000;` duplicates claude-limits.ts:39 `STALE_AFTER_MS = 10 * 60_000` by hand; Codex's own bound is 45 s (codex-status.ts:44).
- failure: The two thresholds drift silently; a Codex reading is called fresh for ten minutes although its reader would re-read after 45 s.
- fix: Move the bound(s) to shared/types and have the renderer read them per harness, or drop the unused union member.

## 24. [unfinished/low/small] 'No accounts are configured yet.' is unreachable and, if reached, a dead end
- where: src/renderer/src/views/Usage.tsx:447
- evidence: Usage.tsx:446-447 `{snap && snap.limits.length === 0 && (<p className="faint">No accounts are configured yet.</p>)}`. allLimits (claude-limits.ts:264) calls accounts.list('claude-code') which seeds a 'Personal' row (accounts.ts:154-155), so limits is never empty; and the message has no link to Settings › Agents while EmptyState supports an `action` and App has go('settings') (App.tsx:631).
- failure: Copy that cannot appear, and would strand the operator if it did.
- fix: Either delete it or turn it into `EmptyState posture="nothing-yet"` with an 'Add an account' action once USG-03 stops seeding.

## 25. [missing/low/small] Cache writes and effort are recorded but not shown; the 'Cached' column is reads only
- where: src/main/usage.ts:40
- evidence: usage.ts:40-44 sums in_tokens, out_tokens, cache_read only; db.ts:247-249 session_api_events also stores `cache_write` and `effort`. Usage.tsx:277 heads the column 'Cached'.
- failure: Cache writes are the premium-priced token class on Anthropic; an operator reconciling cost against tokens cannot from this table.
- fix: Sum cache_write, add a 'Cache write' column (or split Cached into read/write in the title), optionally an effort breakdown.

## 26. [missing/low/small] Spend is shown without the budget or cap the app already keeps
- where: src/renderer/src/views/Usage.tsx:453
- evidence: Usage.tsx has no read of window.wanigan.budgets or settings; preload/index.ts:285-288 exposes `budgets.list`, `budgets.breached`, and 190 `settings.get → spendCapUsd`.
- failure: 'What you spent' answers how much but not against what; a breached monthly budget is invisible on the one page titled Usage.
- fix: Show the monthly budget and breach state beside the spend total (a Stat tile), or a one-line Note when budgets.breached() is non-empty.

## 27. [polish/low/small] Two tables on one screen with two header styles and two number formats
- where: src/renderer/src/views/Usage.tsx:274
- evidence: Usage.tsx:240 the daily table uses `.viz-table` (index.css:870-871: uppercase micro faint th); 274-278 ConsumptionTable is a raw `<table>` with `th className="label"` (index.css:324-327: small/500/dim) and inline paddings. The daily table prints exact `fmt.format(value)` (257) while the consumption table prints `compact()` '128.4k' (290-292) with no exact figure in a title.
- failure: The same page teaches two table vocabularies; a reader cannot get the exact in/out count the app has.
- fix: Use .viz-table for both; put the exact number in `title` or show it on hover.

## 28. [polish/low/small] Cost cell rounds priced requests to $0.00 and skips thousands separators; usd() exists
- where: src/renderer/src/views/Usage.tsx:297
- evidence: Usage.tsx:297 `${row.costStatus === 'partial' ? '≥' : ''}$${row.costUsd.toFixed(2)}` under a title 'Every request carried a provider cost.' (294). bits.tsx:530-535 usd(): `<$0.01` for sub-cent, locale separators ≥ $100.
- failure: A reported $0.004 row prints '$0.00' beside a tooltip saying every request was priced; '$1234.50' has no separator.
- fix: Use usd(row.costUsd).

## 29. [polish/low/small] Meter severity is colour-only until 100%
- where: src/renderer/src/views/Usage.tsx:60
- evidence: Usage.tsx:60-64 tone(): `>= 95 → var(--critical)`, `>= 75 → var(--warning)`; only 112 `{exhausted ? 'exhausted · ' : ''}` adds a word, and only at ≥100. The chart at 196-202 was given an aria-label for exactly this class of problem.
- failure: A window at 96% is red with no text cue; in greyscale or to a screen reader it is '96% used' with the same weight as 20%.
- fix: Append a word for the two bands ('near limit', 'high') or use a Pill with reason beside the percent.

## 30. [polish/low/small] Sections and cards have no heading elements
- where: src/renderer/src/views/Usage.tsx:435
- evidence: Usage.tsx:435, 453, 493 `<div className="label">` inside `<section>` with no h2 or aria-labelledby; 123 the account name is `<strong>`. index.css:259-263: 'h2 a section or a card that owns a region of the page'.
- failure: No landmarks to jump between 'What is left' and 'What you spent'; card names are not navigable headings.
- fix: SectionHead rendering an h2 (or aria-labelledby on the section), h3 for the card name.

## 31. [polish/low/small] Relief note copy: mid-sentence capital and '0%' that reads as 0% left
- where: src/renderer/src/views/Usage.tsx:424
- evidence: Usage.tsx:424-425 `<strong>{item.exhausted}</strong> has nothing left on {item.window}. <strong>{item.spare}</strong> is at {item.sparePercent}% on the same window.` with windowTitle() returning 'This week · Fable' (88-91). Screenshot: 'Personal has nothing left on This week · Fable. Work is at 0% on the same window.'
- failure: 'at 0%' beside 'nothing left' is read as 'also empty' by a skimmer; the sentence is the page's one recommendation.
- fix: 'Work has used 0% of its this-week Fable window' / lower-case the window title inside a sentence.

## 32. [polish/low/small] Claude's five-hour window is 'Session' while Codex's is '5h window' on the same page
- where: src/main/limits.ts:36
- evidence: limits.ts:36-43 windowKind(): 10080→'week', 1440→'day', else `${minutes/60}h window`; Usage.tsx:89 maps Claude 'session'→'Session'. The fixture renders both side by side (screenshot: 'Session' vs '5h window').
- failure: The same rolling span is named two ways one card apart; the comment at limits.ts:29-34 wants one word for one span.
- fix: Title Claude's as 'Session (5h)' or map 300 minutes to 'session' where Claude's documented session length matches.

## 33. [modernize/low/small] Refresh is the coral primary CTA and the window picker is a native select; neighbours use Segmented
- where: src/renderer/src/views/Usage.tsx:392
- evidence: Usage.tsx:392-398 `<select className="field">` and `<button className="btn btn-primary">Refresh limits</button>`. bits.tsx:294 Segmented exists; Insights.tsx:223 offers `[7, 30, 90]` while Usage offers `[7, 14, 30, 90]` (35).
- failure: The accent marks 'the action on this page' and here that action is a re-read; the two Explore neighbours disagree on which windows exist.
- fix: Secondary .btn with the refresh icon (Icon set, bits.tsx:478) plus 'read 3m ago'; Segmented 7/14/30/90 shared with Insights.

