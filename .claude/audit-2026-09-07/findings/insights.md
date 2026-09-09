# Insights view (src/renderer/src/views/Insights.tsx, styles/insights.css, src/main/spend.ts, src/main/usage.ts, plus the preload/App wiring that feeds it)

36 findings. readability={"firstPaintWords": 121, "fontSizesInSheet": 6, "explainerHintNoteUses": 9, "nestedBorderDepth": 2, "notes": "firstPaintWords counted from the screenshot's empty state (lead 12 + status 3 + h2 5 + intro 27 + three bullets 74 = 121 before the Scope select) and confirmed against Insights.tsx:454-520. The populated state carries lead 12 + status 3 + the permanent 'Two meters, not one' Note 67 = 82 words before the Window control, more if a breach banner or Codex card is present. fontSizesInSheet = 6 distinct literal px values in insights.css (9, 10, 11, 11.5, 12, 12.5) across 17 declarations, matching the style-gate baseline of 17. explainerHintNoteUses = 9 Note uses (lines 487, 541, 548, 555, 562, 684, 1795, 1876, 1912); Explainer 0, Hint 0 \u2014 the two `<details className=\"ins-how\">` disclosures are raw and unstyled. nestedBorderDepth: plain chart cards sit at 1 (.pane has no border); budget meters and the editor sit in `.sunk` inside `.chart-card` = 2 (the `.card .sunk` transparent-border rule does not cover `.chart-card`), and the bordered `.field` inside the editor makes 3."}

notes: Method: read Insights.tsx in full, insights.css, spend.ts, usage.ts, bits.tsx, the relevant index.css/ui.css/compact.css rules, preload spend/budgets/codex namespaces, main IPC handlers (index.ts:1940-1951, 1663, 1755), otel.spendByDay/effortBreakdown, batch/index.ts insights(), codex-usage.ts, App.tsx mount site, the style-gate baselines and both screenshots. No file inside the repository was modified; nothing was run.

Screenshot verdicts: both images show the 'Nothing has been billed yet' state and are consistent with the TSX. The editor's 'Update' button, '0' inputs and 'currently $0.00 with $0.00 spent this month' are stub artifacts (the Proxy bridge makes `buds.find(...)` truthy); with a real empty list the button reads 'Set budget' and the hint 'Setting a new cap for All projects…' (Insights.tsx BudgetEditor). No finding above rests on the screenshots.

Dropped after verification: I suspected `reconcile()` asked the Admin API for the wrong grouping (`group_by[]=description`) and misread amounts. The live doc (platform.claude.com/docs/en/manage-claude/usage-cost-api) states 'When grouping by description, responses include parsed fields such as model' and 'All costs in USD, reported as decimal strings in lowest units (cents)', so both the grouping and the /100 in spend.ts are correct.

Priority order for a fix pass: INS-01/02/27 together (one preload line plus wiring unifiedSpend removes the misattribution and the dead reconstruction), then INS-03 (unpriced requests) because it changes what the totals mean, then INS-04/05 (dead CSS and dead prop), then the honesty copy items (06-08, 10-14). Recent commits (479f334 'Stop the views asserting things they never read', b74b213) touched Insights.tsx/insights.css/bits.tsx; every finding was checked against the current working tree, and the preload `sync` omission is present in HEAD.

## 1. [bug/high/small] Preload drops the window: spend.sync is always 30 days
- where: src/preload/index.ts:281
- evidence: `sync: (days?: number) => call<{ day: string; actualUsd: number; syncUsd: number }[]>('spend:sync'),` — `days` is declared and never passed to `call`. Main: `handle('spend:sync', (days?: number) => spend.syncComparison(days))` (src/main/index.ts:1942) → `windowDays(undefined)` = DEFAULT_DAYS 30 (spend.ts). Insights.tsx:345 calls `window.wanigan.spend.sync(d)` believing it is windowed; `surfaceRows()` (Insights.tsx:177) iterates the sync rows, so the sync length decides how many days every headline chart shows.
- failure: Pick 7 days: 'Spend by surface, day by day — The last 7 days' draws 30 bars and 'Interactive · 7d / Everything · 7d' are 30-day totals. Pick 90 days: still 30 bars under 'The last 90 days'; the ZeroResults button 'Widen it to 90 days' changes nothing and then says 'Nothing was billed in the last 90 days' for spend that is 31–90 days old. Spend by repository (byProject does forward days) disagrees with the stacked chart's totals on the same page.
- fix: Forward the argument (`call('spend:sync', days)`), and better: expose `spend:unified` → `spend.unifiedSpend(days)` (already written, never called) and read the three series directly. Add a smoke assertion that the preload forwards `days` for every windowed spend channel.

## 2. [bug/high/small] surfaceRows rebuilds surfaces by subtraction and paints session spend as headless
- where: src/renderer/src/views/Insights.tsx:181
- evidence: `const session = Math.min(s.get(r.day) ?? 0, r.actualUsd); const headless = Math.max(0, r.actualUsd - session - batch);` — session comes from byDay (windowed correctly), batch/headless are inferred from the sync series (always 30 days per INS-01). Any day present in sync but absent from byDay gets session=0 and the whole CLI figure lands in `headless`. spend.ts:131 `unifiedSpend()` returns `{ sessionUsd, batchUsd, headlessUsd }` exactly and has no callers (grep over src).
- failure: With the 7-day window, days 8–30 show every dollar of interactive session spend as the green 'Headless' slot; the legend, table and aria-label all repeat the wrong split. The doc comment above the function ('this cannot drift from the totals it is built from') is false under the shipped preload.
- fix: Delete surfaceRows; call unifiedSpend(days) through a new `spend:unified` channel and compute `sync` locally as session+headless+2×batch (or keep syncComparison for the second chart). One source, no reconstruction.

## 3. [honesty/high/medium] Unpriced session requests are summed as $0.00 and read as free
- where: src/main/spend.ts:88
- evidence: `SELECT ${localDay('at')} AS day, COALESCE(SUM(cost_usd), 0) AS usd FROM session_api_events WHERE at >= ? GROUP BY day` — no count of requests that carried no cost. usage.ts:62-64 in the same tree says the opposite: 'A provider that reports no cost is not free, and a total that silently treats it as zero is a number pretending to be a bill' and returns `costStatus: reported|partial|unreported`. Insights renders `cents(r.costUsd)` beside `num(r.requests)` in the effort table and `unit()` (Insights.tsx:104) prints '$0.00' for a genuine zero; its own comment worries that '$0.00 against 3,200 requests … reads as free'. No Insights surface reads costStatus (grep: only Usage, Fleet, HeadlessRuns do).
- failure: An operator on Codex/GLM/DeepSeek plans (or a Claude account whose telemetry omits cost) sees Sessions $0.00, '0% interactive', effort rows like 'default · $0.00 · 3,200 requests', and a budget that can never breach — the page states a bill that was never measured. CodexActivity only partly covers Codex, and only when totalTokens > 0.
- fix: Have the spend feeders return `pricedRequests`/`unpricedRequests` (as usage.consumption does) per day/effort/project; render a quiet Pill 'n requests unpriced' on TwoSpeeds, Spend by surface, Effort and Spend by repository, and word totals as 'at least' when unpriced > 0.

## 4. [bug/medium/small] 'How this is derived' disclosure has no CSS — its rules are inside a broken trailing comment
- where: src/renderer/src/views/Insights.tsx:2475
- evidence: Lines 2474-2481: `/* ── styles ─── This view has no feature stylesheet of its own and index.css belongs to the shell, so the rules live here, scoped to .insights .ins-how > summary { cursor: pointer; color: var(--text-faint); font-size: var(--t-micro); margin-top: 4px; } .insights .ins-how > summary:hover { … } .insights .ins-how > p { … } .insights and hoisted once by React. Not one colour is declared … */` — three CSS rules spliced into a comment. `<details className="ins-how">` at 807 and 987; `grep ins-how src/renderer/src/styles` finds nothing.
- failure: Both 'How this is derived' disclosures render with the browser-default summary (body-size text, default marker, no pointer cursor) and their body at body size/colour, unlike every other `details > summary` in the app (queue.css:74, usage.css:56). The comment also asserts the view has no stylesheet while `insights.css` is imported at line 4.
- fix: Move the three rules into insights.css (tokens only), delete the dead comment block, and add the two disclosures to the style gate's `Explainer`-or-sheet check.

## 5. [bug/medium/small] Overlapping loads: a beat's response can overwrite a newer window, and a quiet beat ends 'Refreshing…' early
- where: src/renderer/src/views/Insights.tsx:313
- evidence: `const load = useCallback(async (d: number, quiet = false) => { … setByDay(bd); setSync(sy); … setBusy(false); }` — reads are keyed by window for TTL (`spend:${d}`) but results are applied with no check that `d` is still `daysRef.current`; line 412 `setBusy(false)` runs unconditionally for quiet beats too (a TTL-skipped beat resolves almost instantly).
- failure: Beat fires load(30, quiet) at T; operator clicks 90 at T+50ms; the beat's byDay(30) resolves after the 90-day read and overwrites it while the header says 90 days. Separately, a quiet beat that completes during an unquiet load clears 'Refreshing…' while the real read is still in flight.
- fix: After each windowed await: `if (d !== daysRef.current) return;`. Track a load token and only clear `busy` for the load that set it.

## 6. [honesty/medium/small] Every card footer says the number came from the 'Claude Code CLI'
- where: src/renderer/src/views/Insights.tsx:51
- evidence: `cli: { glyph: '◐', word: 'CLI meter', detail: "the agent's own accounting, banked as the Claude Code CLI reported it" }` — printed under ~9 cards via `Meters`. spend.ts CACHE_NOTE_CLI in the same data: 'Claude Code reports these counters over OTLP; Codex contributes its exact local rollout counters.' CLAUDE.md: route behaviour by declared harness, not hardcoded ids.
- failure: Under Codex, GLM or DeepSeek sessions the page attributes the sessions figure to a CLI that never ran; a reader reconciling against a Codex plan is sent to the wrong instrument.
- fix: Word the meter as 'the harness's own accounting, banked as reported' and list the harnesses actually present in the window (session_log.harness_id) in the footer.

## 7. [honesty/medium/small] ZeroResults asserts 'There is spend on record' when there may be none, and renders a zero for a failed read
- where: src/renderer/src/views/Insights.tsx:448
- evidence: `const everSpent = hasBatch || win.total > 0 || cacheTotal > 0 || effort.some((e) => e.costUsd > 0 || e.requests > 0) || buds.some((b) => b.spentUsd > 0) || (codexUsage?.totalTokens ?? 0) > 0;` gates the full page; inside it, `ZeroResults` (1054) prints 'Nothing was billed in the last N days. There is spend on record, just not inside this window.' whenever `grand <= 0`. A failed spend read (errs.spend set, byDay/sync empty) also lands here.
- failure: A Codex-only or budget-only operator (tokens, zero dollars) is told there is spend on record and offered 'Widen it to 90 days', which then says nothing was billed in 90 days either. When the spend read failed, the chart states 'Nothing was billed' about a series that was never read — the warn Note above says 'stale', the card below says 'zero'.
- fix: Split `everSpent` into dollars-ever vs activity-ever; use `EmptyState` postures: `could-not-read` when errs.spend, `nothing-yet` when no dollars anywhere, `nothing-in-scope` only when dollars exist outside the window.

## 8. [honesty/medium/small] 'Saved by batching' presents a counterfactual as observed money, in green
- where: src/renderer/src/views/Insights.tsx:766
- evidence: `<Stat label="Saved by batching" value={usd(saved)} tone={saved > 0 ? 'var(--good)' : undefined} …>` where `saved = win.sync - win.total` and spend.ts syncComparison defines syncUsd as 'what the same work would have cost run synchronously' (batch × 2). By construction `saved` equals the batch column (the SyncComparison table says so).
- failure: A hypothetical carrying no estimate grammar sits beside three observed tiles with the same typography and a success colour; the operator reads $X as cash saved rather than 'list price minus what batch was billed'.
- fix: Relabel 'Synchronous list price · est.' with the delta as the sub, quiet tone, or drop the tile (the SyncComparison card already states the identity).

## 9. [honesty/medium/small] Reconcile tile claims 'no admin key' for every unreconciled outcome
- where: src/renderer/src/views/Insights.tsx:1904
- evidence: `sub={reconciled ? "the organisation's actual charges" : 'no admin key — nothing reported'}` where `reconciled = !!res && res.reportedUsd > 0`. spend.ts `unreconciled(note)` returns reportedUsd 0 for a rejected key (401/403), an unreachable API, an unrecognised payload, a page-cap overrun and an empty batch-tier window — each with a different note.
- failure: With ANTHROPIC_ADMIN_KEY set and rejected, the stat tile says there is no key; the truth is only in the Note below it. Same for 'Delta · needs both sides to mean anything'.
- fix: Return a `reason` code from reconcile (`no-key | rejected | unreachable | empty-window | partial`) and word each tile from it, or sub 'nothing reported — see note'.

## 10. [unfinished/medium/medium] onOpenRun is never supplied: Cost-per-run bars and names are inert
- where: src/renderer/src/App.tsx:1276
- evidence: `{tab === 'insights' && <InsightsView />}` — no `onOpenRun`, no `projects`. Insights.tsx:2369 `/** Cost per run over time. Bars are clickable — the chart is a way into a run. */`, 2421 `style={{ cursor: onOpenRun ? 'pointer' : undefined }}`, 2456 `{onOpenRun ? <button className="ins-inline" …> : String(r.name)}`. grep shows `onOpenRun` exists only inside Insights.tsx.
- failure: The chart's stated purpose ('a way into a run') is unreachable: bars are not clickable, run names are plain text, and there is no route from a cost figure to the run that produced it. When it is wired, `<rect onClick>` has no tabindex/role, so keyboard users still cannot open a run from the chart.
- fix: App passes `onOpenRun={(id) => { setBatchSeed/focus(id); go('batches'); }}` (Batches already accepts a seed) and `projects={projects}` (the fallback read is documented as temporary). Keep the table button as the accessible path and give the rect `tabIndex={0}` + Enter handling or drop its onClick.

## 11. [missing/medium/medium] No per-harness / per-account / per-model view of session spend
- where: src/main/usage.ts:37
- evidence: usage.consumption() already groups `session_api_events` by `l.account_id` and `e.model` with a costStatus; session_log carries provider_id/harness_id. Insights' only model breakdown is batch (`SpendByModel`, Insights.tsx:2256) and 'Sessions' lumps Claude, Codex, GLM and DeepSeek.
- failure: The first question a multi-provider operator asks — which harness/account is costing me — has no answer on the spend page, only on Usage.
- fix: A `spend:byHarness(days)` feeder (harness × account × model with priced/unpriced counts) and one card with bars + table, slot colours by harness.

## 12. [missing/medium/small] A budget can be set but never removed
- where: src/preload/index.ts:285
- evidence: `budgets: { list, set, breached, reconcile, accuracy }` — no remove; spend.ts `setBudget` is an upsert; the editor offers only 'Enter 0 to keep tracking this scope without capping it' and lists dead scopes as `${b.scopeName} (removed)` forever (Insights.tsx BudgetEditor).
- failure: A removed project's budget row stays in the grid and the select indefinitely; the operator's only option is a zero cap that still renders a meter.
- fix: `budgets:remove(scopeId)` (DELETE FROM budgets) + a T2 ConfirmNote 'Remove budget' in the editor.

## 13. [polish/medium/small] Window selector re-implements Segmented with a new .ins-seg family
- where: src/renderer/src/views/Insights.tsx:577
- evidence: `<div className="ins-seg" role="group" aria-label="Reporting window in days">` with three always-tabbable buttons; insights.css:44-54 `.ins-seg …[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }`. bits.tsx:294 `Segmented` provides roving tabindex, arrow/Home/End keys and the `.seg` selected state (`--bg-selected`). CLAUDE.md forbids a new class family beside a primitive.
- failure: Different keyboard model and different selected colour from every other segmented control in the app; three tab stops instead of one.
- fix: `<Segmented options={WINDOWS.map(d => ({ value: String(d), label: `${d} days` }))} value={String(days)} onChange={(v) => setDays(Number(v))} label="Reporting window" />`; delete `.ins-seg`.

## 14. [polish/medium/medium] Eight hand-rolled empty states and a bare loading sentence instead of EmptyState/Reading
- where: src/renderer/src/views/Insights.tsx:472
- evidence: `<div className="card chart-empty"><p>Reading the ledger…</p>…` (loading), `<h2 style={{ fontSize: 'var(--t-lead)' }}>Nothing has been billed yet</h2>` (507), and `<div className="chart-empty"><p>…</p><p className="ins-zero-sub">` in ZeroResults, Effort, Cache, Budgets, Reconcile ×2, EstimateAccuracy. bits.tsx:338 `EmptyState` (three postures) and 359 `Reading` ('render the final frame as children so nothing jumps').
- failure: No posture glyph, no could-not-read state, inconsistent sizes; `ready` waits for all nine reads (Promise.all) so the whole page is a sentence until the slowest all-time scan finishes, then jumps.
- fix: `Reading what="the ledger"` with the stat grid as children; `EmptyState posture=…` per card with the retry/widen action in `action`.

## 15. [polish/medium/small] Page head is hand-rolled rather than PageHead; status text carries an inline font size
- where: src/renderer/src/views/Insights.tsx:454
- evidence: `<div className="pane-head"><div><h1>Insights</h1><p className="dim">…</p></div><div className="faint" style={{ fontSize: 'var(--t-small)' }}>…` — bits.tsx:245 `PageHead` is the recorded frame (eyebrow/title/lead/actions); sibling Usage.tsx:382 uses the frame with a stencil eyebrow.
- failure: The one place the stencil eyebrow belongs is absent here while the view differs from its neighbours in head structure.
- fix: `<PageHead eyebrow="Explore" title="Insights" lead="…" actions={<span className="faint">{status}</span>} />`.

## 16. [polish/medium/small] Pills and status marks hand-rolled with inline colours instead of Pill/Mark tones
- where: src/renderer/src/views/Insights.tsx:672
- evidence: `function MarkPill({ m }) { return <span className="pill" style={{ background: m.bg, color: m.fg }}>` with `budgetMark` returning `fg: 'var(--critical)', bg: 'var(--critical-soft)'`; line 720 `<span className="pill" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>No per-thread invoice</span>`; status cells in three tables repeat `<span aria-hidden style={{ color: m.fg, fontWeight: 700 }}>`. bits.tsx:28/103 `Pill tone=` and `Mark glyph word tone` exist; bits' header: 'Colour never enters this file as a literal'.
- failure: Two token families (`--warn` vs `--warning`) for the same meaning on one page; tones drift from the palette's pill rules (index.css:345-351).
- fix: Map budgetMark/ratioMark/Outcomes to `Tone` and render `<Mark>` / `<Pill tone>`; delete the fg/bg fields.

## 17. [polish/medium/small] The two-meter caption is printed under every card (~11 times) and again as a permanent Note
- where: src/renderer/src/views/Insights.tsx:61
- evidence: `function Meters({ of, extra })` renders '◐ CLI meter — the agent's own accounting…' and '◑ Wanigan meter — Wanigan's arithmetic…' under SurfaceOverTime, SyncComparison, SpendByProject, Effort, Cache, Budgets, Reconcile, EstimateAccuracy, TokenFlow, SpendByModel, SpendOverTime; line 562 adds an undismissable `<Note tone="info">Two meters, not one.…</Note>` (67 words) above the first control.
- failure: Roughly 330 repeated words per page; the page's real data starts below a paragraph the operator has read on every visit. `Explainer` (bits.tsx:383) exists precisely for remembered teaching prose.
- fix: One `<Explainer id="insights-meters">` at the top; footers become the two glyphs with `title` tooltips and the surface-specific `extra` only.

## 18. [polish/medium/medium] Card subtitles are 60–80-word essays; one 'How this is derived' explains palette order instead
- where: src/renderer/src/views/Insights.tsx:807
- evidence: `<details className="ins-how"><summary>How this is derived</summary><p>Sessions are always slot 1, batches slot 2, headless slot 3 — the order is fixed … colour vision deficiency.</p>` — the body is about hue slots, not derivation. SyncComparison, Budgets, Reconcile, UnifiedCache and EstimateAccuracy each open with a `.sub` paragraph of ~65–80 words before any figure.
- failure: Every card reads as a document; the number the operator came for sits below a paragraph. The disclosure's title promises derivation and delivers a palette note.
- fix: One-line `.sub`, the rest behind `Explainer`/`Hint`; write the 807 body as the actual derivation (unifiedSpend three series, local-day buckets).

## 19. [modernize/medium/small] One coral does selection, categorical tag, every inline action, focus and the CTA
- where: src/renderer/src/styles/insights.css:54
- evidence: `.ins-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }`, `.ins-tag { background: var(--accent-soft); color: var(--accent); }` ('high effort'), `.ins-inline { color: var(--accent); text-decoration: underline; }` ('Show all 30 daily rows', 'Retry now', 'Widen it to 90 days', 'Edit', run names), `:focus-visible { outline: 2px solid var(--accent) }`, plus the Update/Reconcile primary buttons.
- failure: Nothing on the page is visually primary because everything is; a high-effort tag reads as an action.
- fix: Selection → `.seg`'s `--bg-selected`; tag → quiet outline pill; inline actions → `--text-dim` with underline on hover and a chevron Icon where they disclose; keep coral for the single primary button per card (Linear/Raycast convention).

## 20. [modernize/medium/medium] Cards are documents, not instruments: 13.5px title + paragraph + chart + legend + full table, every time
- where: src/renderer/src/index.css:852
- evidence: `.chart-card h3 { font-size: var(--t-body); font-weight: 600; }` followed in Insights by a 40–80-word `.sub`, then svg/bars, a `.legend`, then a `viz-table` always expanded; only the daily rows are behind 'Show all N daily rows'.
- failure: Eleven stacked cards, each ~500px tall, where the figure the operator scans for is neither first nor largest; the page cannot be read at a glance.
- fix: Card head = label (SectionHead) + hero figure + one meta line right-aligned; chart; legend inline with the head; table behind a 'Show table' toggle (already the pattern for daily rows). Consider a 2-column grid for the four small cards (Effort, Cache, Estimate, Outcomes).

## 21. [bug/low/small] Breach banner is double-announced: aria-live wrapper around a role=alert Note
- where: src/renderer/src/views/Insights.tsx:536
- evidence: `<div aria-live="polite"><BreachBanner breached={breached} /></div>` — `Note` already renders `role="alert"` (error) or `role="status"` (bits.tsx:179-182), whose own comment says never combine a role and aria-live.
- failure: VoiceOver reads the breach twice; an error-tone banner is announced assertively and politely.
- fix: Remove the wrapper div.

## 22. [bug/low/small] spend.ts sums cost over every event kind; usage.ts sums requests only
- where: src/main/spend.ts:91
- evidence: `FROM session_api_events WHERE at >= ? GROUP BY day` (also spendByProject 209-218) with no kind filter; usage.ts:48 `WHERE e.kind='request'`. otel.ts records kinds 'request', 'error' (79, 583) and 'refusal'. Plausible only: error/refusal rows probably carry a null cost today.
- failure: If any non-request event ever carries a cost, Insights and Usage disagree on the same session's dollars with no explanation.
- fix: Add `AND kind = 'request'` to every cost sum in spend.ts (or assert cost_usd IS NULL on other kinds in the writer).

## 23. [honesty/low/small] Green '✓ Reconciled' for any non-zero report, regardless of agreement
- where: src/renderer/src/views/Insights.tsx:1836
- evidence: `reconciled ? { glyph: '✓', word: 'Reconciled', fg: 'var(--good)', bg: 'var(--good-soft)' } : …` — keyed on `res.reportedUsd > 0`, not on `res.accuracy`.
- failure: A 12% agreement (or an untiered whole-bill comparison) still wears the success mark in the card head.
- fix: Neutral 'Compared' pill; colour only when `accuracy` clears a stated band, and say 'batch-tier' vs 'whole bill' in the pill.

## 24. [honesty/low/small] Reconcile footer always says the reported column is the whole bill
- where: src/renderer/src/views/Insights.tsx:2003
- evidence: `The reported column is the organisation's whole bill for the window, including work Wanigan never ran` — unconditional. spend.ts: `const relevant = tiered ? items.filter((i) => i.tier === 'batch') : items;` and the returned note already says which case applied.
- failure: When the report carries service tiers the comparison is batch-tier only and the footer contradicts the note two lines above it.
- fix: Render the footer from `res.note` / a `scope` field; drop the hardcoded sentence.

## 25. [honesty/low/small] 'Refreshes every 15s' overstates; no 'as of' time is shown
- where: src/renderer/src/views/Insights.tsx:460
- evidence: `{busy ? 'Refreshing…' : 'Refreshes every 15s'}` while the TTL table reuses effort/cache for 90 s, accuracy 120 s, budgets/codex 60 s, batch 30 s; `readAt` timestamps exist per read and are never displayed.
- failure: After a failed beat the operator cannot tell how old any card is; the header promises a cadence most cards do not keep.
- fix: 'Spend series every 15 s · read 14:03:12' in the head, or a per-card 'as of' from readAt.

## 26. [honesty/low/small] Token flow says 'every token this workspace has been billed for' but is batch-only
- where: src/renderer/src/views/Insights.tsx:2203
- evidence: `Every token this workspace has been billed for, by kind.` fed by `batch?.totals` from batch/index.ts:63-69 `FROM runs WHERE submitted_at IS NOT NULL`. Likewise 2260 'Total billed per model across every submitted batch run' for Wanigan-priced (not billed) figures.
- failure: Session and headless tokens — usually the majority — are absent from a card that says 'every token'.
- fix: 'Every token billed to batch runs, by kind'; 'Wanigan-priced spend per model'.

## 27. [unfinished/low/small] Windowed feeders in spend.ts are exported and never called
- where: src/main/spend.ts:131
- evidence: `export function unifiedSpend(days?)`, `spendBySurface(days?)`, `effortDistribution(days?)` (the windowed, per-surface effort with the doc comment about the otel copy) have no callers in src (grep, excluding spend.ts itself); the view uses otel.spendByDay + syncComparison + otel.effortBreakdown instead.
- failure: The honest three-series feeder exists but the page rebuilds the same data by subtraction (INS-02); the windowed effort split with its 'asked-for vs reported' caveat is unreachable.
- fix: Wire unifiedSpend (fixes INS-01/02); either expose effortDistribution behind a window toggle on the Effort card or delete the dead exports.

## 28. [missing/low/small] BudgetBreach reason/summary/month are computed but the renderer re-derives its own mark with a different precedence
- where: src/renderer/src/views/Insights.tsx:656
- evidence: `budgetMark`: over → 'Trending over' (projected) → 'Past warning' → 'On track'. spend.ts breachOf: over-budget → warning-threshold → projected-over, plus `summary` and `window.monthLabel`. preload:288 types `breached` as `BudgetState[]`, discarding those fields.
- failure: A scope past its warning line and projected over is 'Trending over' in the banner but 'past the 80% warning line' in a launch refusal; the month is never named ('day 5 of 30' of what?).
- fix: Type the channel as BudgetBreach[]; render `summary` and `monthLabel`; derive the pill from `reason`.

## 29. [missing/low/small] Codex 'last activity' is returned and never shown; empty-state save does not refresh breaches
- where: src/renderer/src/views/Insights.tsx:519
- evidence: codex-usage.ts:143 sets `total.lastAt`; CodexActivity renders conversations/tokens only. `<BudgetEditor projects={projects} buds={buds} onSaved={setBuds} />` in the empty state, whereas the Budgets card's onSaved also re-reads `budgets.breached()`.
- failure: No way to tell the Codex counters are current; a first cap set below existing spend shows no breach banner until the next beat.
- fix: Render `ago(usage.lastAt)` as the card's meta; share one onSaved that refreshes breached.

## 30. [polish/low/small] Off-scale literals: 9px glyph, 11.5/12.5px text, a literal font-family and a specificity-boosted focus ring
- where: src/renderer/src/styles/insights.css:145
- evidence: `.insights .ins-meter-proj { … font-size: 9px; …}` (index.css:91-93 sets 10px as the floor); `font-size: 11.5px` ×9, `12.5px` ×2 (17 literal sizes, gate baseline 17); `.ins-tag { … font-family: ui-sans-serif, system-ui, sans-serif; }` (121); `.insights :focus-visible { outline: 2px solid var(--accent); … border-radius: 5px; }` (8-12) outranks the global `:where(...)`:focus-visible rule (index.css:1014) and forces a radius on every focused element.
- failure: Type sizes that exist nowhere else in the app; the projection marker is below the stated contrast floor; the view carries its own focus ring.
- fix: Replace with `--t-micro`/`--t-small`/`--t-tiny` and the mono/sans tokens; delete the focus override so the shell rule applies.

## 31. [polish/low/small] SVG axis and end labels are 10px in --text-faint (12 sites)
- where: src/renderer/src/views/Insights.tsx:823
- evidence: `<text x={PAD_L - 8} y={y + 3.5} fontSize="10" textAnchor="end" fill="var(--text-faint)"` and the same for day labels, 'sync/actual/same', 'oldest/newest'. index.css:91-93: '10px metadata is the contrast floor this palette refuses' for a sentence.
- failure: Tick values (the only place the y-scale is stated) are the faintest, smallest text on the page in both themes.
- fix: A `.chart-tick` class at `--t-micro` in `--text-dim`; drop the fontSize attributes.

## 32. [polish/low/small] Editor hint names a removed project by raw id
- where: src/renderer/src/views/Insights.tsx:1688
- evidence: In BudgetEditor: `const named = scopeId === '' ? 'All projects' : (projects.find((p) => p.id === scopeId)?.name ?? scopeId);` while the select renders the same scope as `{b.scopeName} (removed)`.
- failure: 'Updating the cap for prj_01H…' under a select that says 'platform (removed)'.
- fix: Fall back to `buds.find(b => b.scopeId === scopeId)?.scopeName` before the id.

## 33. [polish/low/small] Enter does nothing in the budget editor or the reconcile dates
- where: src/renderer/src/views/Insights.tsx:1729
- evidence: BudgetEditor and Reconcile render `<input className="field" …>` inside `<div className="ins-editor-row">` with a click-only `<button … onClick={() => void save()}>`; no `<form onSubmit>`.
- failure: Keyboard users type a cap, press Enter, and nothing happens; they must tab to the button.
- fix: Wrap each row in `<form onSubmit={(e) => { e.preventDefault(); void save(); }}>` and make the primary button `type="submit"`.

## 34. [polish/low/small] Outcomes counts pending in 'succeeded of N'; Effort sub prints a 0%-of-0% clause
- where: src/renderer/src/views/Insights.tsx:2336
- evidence: `{num(ok)} of {num(total)} requests succeeded` where `total` sums every status including `pending`. EffortDistribution's sub always renders 'xhigh and max are {pct} of the spend from {pct} of the requests' even when `high.length === 0`.
- failure: '40 of 100 requests succeeded' while 60 are still pending reads as a 40% success rate; 'xhigh and max are 0% of the spend from 0% of the requests' is noise on a page with no high-effort rows.
- fix: Denominator = settled requests, with pending stated separately; skip the clause when `highReqs === 0`.

## 35. [polish/low/small] Filter note omits that the whole batch section is all-time
- where: src/renderer/src/views/Insights.tsx:585
- evidence: `Scopes the two time-series charts and the totals beside them. Effort, cache and estimator accuracy are all-time; budgets are month-to-date.` — Total batch spend (629 `usd(t.cost)`), Token flow, Spend by model, Request outcomes and Cost per run are also all-time (batch/index.ts has no window).
- failure: An operator on the 7-day window reads 'Total batch spend' as a 7-day figure.
- fix: '…Effort, cache, estimator accuracy and every batch card are all-time' and an 'all-time' Chip in the batch divider.

## 36. [modernize/low/medium] Hover and iconography rely on native <title> and Unicode glyphs
- where: src/renderer/src/views/Insights.tsx:870
- evidence: Day hit-rects carry `<title>` only (`<rect … fill="transparent"><title>{…}</title></rect>`); bars use `title=` attributes; meters/marks use ◐ ◑ ▲ ✕ ◦ ⊘ ⏱ characters inline with prose. bits.tsx ships a Lucide `Icon` set 'always drawn beside a word'.
- failure: Tooltips appear after the OS delay, unstyled and not in both themes; glyphs render differently per font fallback and are invisible to touch/keyboard.
- fix: One small positioned tooltip component shared by the three SVGs (hover + focus), `Icon` beside meter words, and glyphs only inside `Mark`.

