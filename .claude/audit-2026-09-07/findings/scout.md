# Scout (ImprovementScout) view — src/renderer/src/views/ImprovementScout.tsx, src/renderer/src/styles/improvement-scout.css, src/main/improvement-scout.ts

41 findings. readability={"firstPaintWords": 31, "fontSizesInSheet": 5, "explainerHintNoteUses": 1, "nestedBorderDepth": 2, "notes": "31 = eyebrow 'Improvement Scout \u00b7 Wanigan improvement loop' (5) + 'Scout' (1) + lead (21) + the two state pills (4) before the first control in DOM order, 'Preview locally' (TSX 534-559), which is disabled in the setup state; the first enabled control, the 'Enable Scout workspace' checkbox, comes after a further 41 words ('Schedule and consent', 'Choose when research can run', and the 33-word card paragraph at 595) \u2014 72 in total. Sheet font sizes: --t-micro, --t-small, --t-body, --t-lead, --t-title across 30 declarations (no px literals). One Explainer (723), zero Hint, zero Note \u2014 notices and hints are hand-rolled .scout-banner/.scout-state. Depth 2: .card.scout-card > .scout-toggle tiles, and .card.scout-suggestion > .scout-reason-grid / .scout-evidence / .scout-goal-picker, each a bordered box inside a bordered card (index.css 718-720 makes the inner border transparent only for nested .card/.sunk, not these classes)."}

notes: Screenshot triage: both shots are the stubbed harness. 'Scout paused', '0 enabled', '0/0' and 'No sources are configured yet' are stub artifacts, not bugs — main settings() defaults enabled=true (improvement-scout.ts 206) and listSources() always maps the five-entry TRUSTED_SOURCES registry (277-292), so the empty-sources state is unreachable in the real app. The one visual defect I did confirm from the screenshot (scout-01, checkboxes centred above their labels) is also proven by CSS specificity at improvement-scout.css 103 vs 104, so it is not stub-dependent. Verified against git log: the last commits touching these files (61ee461, b74b213, 479f334, f614502) fixed the live-region and page-head issues and none of the findings above; I re-read the current files rather than the diffs. Not reported: the single inline style at TSX 781 (already in the gate's baseline as 'views/ImprovementScout.tsx': 1). Cross-checks worth a later pass: mobile/scout.ts already carries run.detail, run.mode/networkAllowed, and per-source lastStatus/lastCheckedAt/lastDetail, so scout-03/04/10 are cases of the desktop being behind the phone rather than missing data. Egress.ts 186 shares the stale 'Research now' string with scout-19.

## 1. [bug/high/small] Consent toggles render as columns: checkbox floats centred above its label
- where: src/renderer/src/styles/improvement-scout.css:103
- evidence: .scout-setting-grid > label, .scout-goal-picker > label { display: flex; min-width: 0; flex-direction: column; gap: 5px; }  — the three <label className="scout-toggle"> (TSX 597, 602, 607) are direct children of .scout-setting-grid, and (0,1,1) beats .scout-toggle's (0,1,0) `display:flex; align-items:center` at CSS 104-116. Both screenshots show every checkbox centred on its own row above the bold label, not beside it.
- failure: The three consent checkboxes read as three untethered boxes floating in 165px-tall tiles; the checkbox is visually separated from 'Enable Scout workspace' and its explanatory line, which is the control the whole page depends on.
- fix: Scope the column rule to the select wrappers only (`.scout-setting-grid > label:not(.scout-toggle)`) or give the two select labels their own class; keep .scout-toggle a row with the box leading.

## 2. [bug/high/small] Status filter keeps a value that no longer exists; select shows 'All statuses' while hiding everything
- where: src/renderer/src/views/ImprovementScout.tsx:497
- evidence: const statuses = useMemo(() => ['all', ...new Set(suggestions.map((item) => item.status))], [suggestions]); … <select className="field" value={status} … >{statuses.map(…)}</select> (748). `status` is never reset when its option disappears.
- failure: Filter to 'new', press 'Mark reviewed' on the last new proposal: load(true) drops 'new' from the options, the controlled select falls back to displaying 'All statuses', but state is still 'new' so the queue shows 'No proposal matches these filters.' with no filter visibly applied.
- fix: Add an effect that resets `status` to 'all' when it is not in `statuses`, or build the options from the fixed status list (new/reviewed/snoozed/dismissed/goal-created) with counts via Chip.

## 3. [bug/high/small] A blocked scan shows only the word 'blocked'; the recorded reason is discarded
- where: src/renderer/src/views/ImprovementScout.tsx:171
- evidence: normalizeRun reads id/mode/status/networkAllowed/startedAt/finishedAt/suggestionCount/error and no `detail`. Main writes the reason into `detail` with `error` null for every blocked outcome: finish('blocked', { detail: 'No official Scout sources are enabled…' }) (837) and the paused-schedule path (890-894). The card falls through to `overview.latestRun.error ?? overview.latestRun.status` (648).
- failure: A weekly watch blocked because the operator disabled the last source shows '⁃ blocked' with no sentence saying why; the reason exists in SQLite and reaches the phone (MobileScoutRun.detail) but not the Mac.
- fix: Carry `detail` through normalizeRun and render it for blocked/failed/preview outcomes.

## 4. [honesty/high/small] 'Last scan' shows a local preview exactly like an online scan: '✓ completed · 0 proposals'
- where: src/renderer/src/views/ImprovementScout.tsx:645
- evidence: {overview.latestRun.status === 'completed' ? `completed · ${overview.latestRun.suggestionCount} …proposals` : …} — `mode` and `networkAllowed` are normalised (176-178) but never rendered. Main records the distinction: run() finishes a preview with detail 'Local capability inventory refreshed. No official source was contacted…' (improvement-scout.ts 829-832); the phone renders 'A local pass: the capability inventory was refreshed and no official source was contacted.' (smoke3.ts 2279).
- failure: After 'Preview locally' the summary card says a scan completed with 0 proposals, which reads as 'the sources were checked and nothing was found' when nothing was contacted — the claim the mobile module comment says the desktop once made and was fixed.
- fix: Branch on `networkAllowed`/`mode`: 'local pass · no source contacted' vs 'online · read N sources · M proposals'; carry `detail` (see scout-04).

## 5. [bug/medium/small] Failed-scan error (up to 1,500 chars) is clipped to one nowrap line with no tooltip
- where: src/renderer/src/styles/improvement-scout.css:87
- evidence: .scout-stat small { overflow: hidden; … font-size: var(--t-micro); text-overflow: ellipsis; white-space: nowrap; } — the <small> holds `overview.latestRun.error` (TSX 648), which main builds as `failures.join(' · ').slice(0, 1_500)` (improvement-scout.ts 865) or the stale-run sentence (761).
- failure: 'GitHub changelog: Official source returned HTTP 403. · Claude Code changelog: Source response exce…' — the operator sees one truncated fragment inside a 108px stat card and cannot read which sources failed.
- fix: Render the outcome as a wrapping line under the stat grid (or a Note tone=error) instead of inside the stat's <small>; keep the glyph + word in the card.

## 6. [bug/medium/small] Every action error is announced as 'Scout could not load'
- where: src/renderer/src/views/ImprovementScout.tsx:570
- evidence: {error && <div className="scout-banner error" role="alert"><span>!</span><div><strong>Scout could not load</strong><p>{error}</p>…} — act() writes every thrown action into the same `error` state (414-425).
- failure: 'Choose the project this Goal belongs to first.', 'An AI Improvement Scout run is already in progress…', 'This proposal already has a Control Goal…' and 'The scan was blocked before it ran…' all appear under a heading that says the page failed to load, while the page is fully loaded.
- fix: Separate loadError from actionError (or Note tone=error with the action's own label: 'Could not create Goal', 'Scan did not run').

## 7. [bug/medium/small] Keyboard focus is dropped when a proposal's action button unmounts after a status change
- where: src/renderer/src/views/ImprovementScout.tsx:783
- evidence: {suggestion.status === 'new' && <button …>Mark reviewed</button>} {suggestion.status === 'reviewed' && <button …>Snooze</button>} … each button is conditional on the status it changes.
- failure: Press Enter on 'Mark reviewed': updateSuggestion → load(true) re-renders the card without that button; the focused element is removed and focus returns to <body>, so a keyboard/VoiceOver user loses their place in the queue.
- fix: Give each <article> tabIndex={-1} and move focus to it after the update, or keep a stable button whose label changes.

## 8. [bug/medium/small] 'Next review' says 'not scheduled' while printing a cadence, and 'below' points the wrong way in setup order
- where: src/renderer/src/views/ImprovementScout.tsx:651
- evidence: <strong className="scout-date">{settings.weeklyEnabled && settings.enabled && settings.networkEnabled ? formatWhen(overview.nextRunAt) : 'not scheduled'}</strong><small>{settings.weeklyEnabled ? overview.cadenceLabel : 'enable a weekly watch below'}</small> — the two use different predicates; and in the needsSetup branch (593-652) the settings card renders ABOVE this grid.
- failure: With Weekly watch on and unattended checks off the card reads 'not scheduled / Every Saturday at 09:00'. In the setup state the sub-line tells the operator to enable a weekly watch 'below' when the toggle is above.
- fix: Use one predicate (scheduledResearchAllowed) for both lines and drop the directional word ('turn on Weekly watch').

## 9. [bug/medium/small] Disabled-source rows fade 11px text to ~2.3:1 in light theme
- where: src/renderer/src/styles/improvement-scout.css:138
- evidence: .scout-source.disabled { opacity: .62; } applied to a row whose <small> is `color: var(--text-faint); font-size: var(--t-micro)` (135). Light --text-faint #706459 at 62% over --bg-sunk #eee6dc ≈ #a09589 → ≈2.3:1. Same pattern at .scout-suggestion.status-dismissed { opacity: .76 } (159).
- failure: An excluded source's description and a dismissed proposal's summary fall below 4.5:1, so the state the operator most needs to re-read (what did I turn off / dismiss?) is the least legible.
- fix: Do not fade text; mark the row with the checkbox state plus a 'excluded' Pill, and keep text at token colour.

## 10. [honesty/medium/small] 'Linked evidence: N sources' counts snapshots, not sources
- where: src/renderer/src/views/ImprovementScout.tsx:775
- evidence: <strong>{suggestion.evidence.length} source{…}</strong> (also 791). Main inserts one evidence row per source per run (insertEvidence 675-690) and links each to the same fingerprinted suggestion (upsertSuggestion 719-720; LIMIT 12 at 332).
- failure: After three weekly passes matching the Claude Code changelog, the LSP proposal reads '3 sources' when it has one source read three times — the count that is supposed to be the one observed figure in the reason grid overstates support.
- fix: Count distinct sourceId: 'N snapshots from M sources'.

## 11. [honesty/medium/medium] Evidence excerpt is the first 900 chars of the page, not the passage that matched
- where: src/main/improvement-scout.ts:596
- evidence: excerpt: text.slice(0, MAX_EXCERPT) — while rulesFor matches `rule.keywords.some((term) => hasTerm(document.text, term))` over up to 96 KB (672).
- failure: The 'Evidence' panel shows a changelog's navigation/header boilerplate as the evidence for 'Evaluate a language-server diagnostic bridge'; the word 'lsp' the rule matched is nowhere in what the operator is shown.
- fix: Store a window around the first hit of the matched term per rule and record the term matched on the suggestion_evidence link.

## 12. [honesty/medium/medium] Rules fire on trivially present words and never check freshness; content_hash is stored but never compared
- where: src/main/improvement-scout.ts:653
- evidence: keywords: ['model', 'agent', 'api'] (653); ['release', 'latest release', 'releases api'] (645); ['mcp', …] (637). content_hash is inserted (678-683) and never read back for comparison; an existing suggestion has why_now rewritten to '… currently matches …' on every run (703-705).
- failure: 'Why it surfaced now' claims something fresh matched when the same unchanged page containing 'api' re-matches every Saturday; the proposals are effectively constant and 'found <date>' plus 'currently matches' present that as observed novelty.
- fix: Compare the new hash with the previous evidence row for that source; only refresh why_now on change and say 'unchanged since <date>' otherwise; tighten keywords to phrases.

## 13. [honesty/medium/small] Confidence/effort/risk are per-rule constants rendered to two decimals as if computed
- where: src/renderer/src/views/ImprovementScout.tsx:776
- evidence: <div><small>Confidence · rule-derived</small><strong>{ruleConfidence(suggestion.confidence)}</strong></div> → e.g. '0.72', which is the literal `confidence: 0.72` in GAP_RULES (improvement-scout.ts 630; 638, 646, 654 likewise for effort/risk).
- failure: The reason grid puts one observed count beside three hardcoded literals in the same typographic cell; the learning doctrine bans a bare confidence figure, and 'rule-derived' does not tell the reader it never varies.
- fix: Label as 'rule constant' and show the rule id, or drop the decimal until it is measured against outcomes.

## 14. [unfinished/medium/medium] scout.runs is wired end to end but no surface shows run history
- where: src/renderer/src/views/ImprovementScout.tsx:96
- evidence: runs?: (limit?: number) => Promise<unknown>; is declared and never called; preload exposes `runs` (preload/index.ts 410) and main implements listRuns with mode/status/sourceCount/evidenceCount/suggestionCount/detail/error (improvement-scout.ts 392-415).
- failure: Only the latest run is visible; the operator cannot see the sequence of preview/manual/scheduled passes, which failed, or when the last online pass actually happened once a preview has overwritten the 'Last scan' card.
- fix: A compact run ledger under the stat grid (mode · outcome · sources read · proposals · when).

## 15. [missing/medium/medium] Per-source last-check outcome is recorded and shown on the phone but not on the desktop list
- where: src/renderer/src/views/ImprovementScout.tsx:221
- evidence: normalizeSource keeps id/label/description/url/enabled only; main returns lastCheckedAt, lastStatus ('never'|'ok'|'failed'|'skipped'), lastDetail (improvement-scout.ts 288-290), written by updateSourceStatus after every fetch (850, 857). MobileScoutSource carries all three (mobile/scout.ts).
- failure: An operator cannot see that 'GitHub changelog' returned HTTP 403 on the last three weekly passes; the source row looks identical to one that has never been checked.
- fix: Render a Mark (glyph + word) and 'checked <date>' per row, with lastDetail on failure.

## 16. [missing/medium/medium] No refresh affordance and no live update; a run shown as 'still running' never resolves on screen
- where: src/renderer/src/views/ImprovementScout.tsx:404
- evidence: useEffect(() => { void load(); }, [load]); — the only reads are on mount and after the operator's own actions; no events subscription and no Refresh button in .scout-head-actions (555-564). 'still running' (647) is rendered from latestRun.status.
- failure: A weekly scan that completes while Scout is open never appears; if the operator opens the view during a scheduled pass the card says '◐ still running' until they toggle a setting.
- fix: Add a 'Re-read' head action and subscribe to a scout run-finished event (or poll while latestRun.status === 'running').

## 17. [polish/medium/medium] Every primitive is hand-rolled: head, stats, pills, notes, empty state, chips
- where: src/renderer/src/views/ImprovementScout.tsx:534
- evidence: <header className="scout-head"> … <span className="label-stencil"> … <h1>Scout</h1> instead of PageHead; .scout-stat vs Stat; .scout-state vs Pill; .scout-banner vs Note; .scout-empty vs EmptyState; .scout-chip vs Pill; .scout-card-head vs SectionHead. The sheet's own comment admits the head drifted from PageHead (improvement-scout.css 25-28).
- failure: Scout is the one Explore view whose head, stat tiles and notices are visibly different weights and paddings from Insights/Usage/Learning beside it in the same rail, and the style-gate rule in CLAUDE.md is not met.
- fix: Replace in order: PageHead → Note → Stat → Pill/Mark → EmptyState/Reading → SectionHead; delete the matching .scout-* rules.

## 18. [polish/medium/small] Sixty lines of JSX duplicated verbatim to swap the order of two sections
- where: src/renderer/src/views/ImprovementScout.tsx:593
- evidence: {needsSetup ? (<> <section className="scout-grid">…</section> <section className="scout-stat-grid">…</section> </>) : (<> <section className="scout-stat-grid">…</section> <section className="scout-grid">…</section> </>)} — 593-652 and 656-715 are byte-identical apart from order.
- failure: Any fix to a stat card or toggle must be made twice; scout-08's copy defect already differs in meaning between the two copies because of the order.
- fix: const settingsSection = …; const summarySection = …; render needsSetup ? [settings, summary] : [summary, settings].

## 19. [polish/medium/small] Success notice self-dismisses after 9 s, taking the 'Open Goal in Control →' link with it
- where: src/renderer/src/views/ImprovementScout.tsx:410
- evidence: const timer = window.setTimeout(() => setNotice(null), 9_000); — bits.tsx Note doctrine: 'No timers — the operator is watching agents, not this notice.'
- failure: An operator who creates a Goal and looks at the terminal for ten seconds returns to find the confirmation and its link gone.
- fix: Use Note with onDismiss and no timer.

## 20. [modernize/medium/medium] Four 108px stat cards with 20px digits for numbers that are 0–5
- where: src/renderer/src/styles/improvement-scout.css:80
- evidence: .scout-stat { … min-height: 108px; …} .scout-stat strong { font-size: var(--t-title); …} — the values are pendingSuggestions (max 4 rules), enabledSourceCount/sourceCount (max 5), and two dates. Screenshot: a full-width row of four boxed tiles above another full-width boxed filter bar.
- failure: Half the first screen is chrome around single digits; next to Linear's inline meta line or Raycast's one-row summary the page reads as a dashboard template.
- fix: One summary line under the head ('0 to review · 5/5 sources · last scan Sat 9:00 ✓ online · next Sat 9:00'), or Stat tiles at --t-lead in a single sunk row.

## 21. [bug/low/small] Main copy names a 'Research now' button and 'Settings' that do not exist
- where: src/main/improvement-scout.ts:831
- evidence: detail: '… click Research now for one explicit online pass …' (831); egress.ts 186 'Only when you explicitly press Research now'; run() throws 'AI Improvement Scout is disabled in Settings.' (804). The button is 'Run scout now' (TSX 563) and the toggle lives on the Scout view (598), not Settings.
- failure: The stored run detail and the egress report direct the operator to a button and a view that are not there.
- fix: Rename to 'Run scout now' and 'in Scout'.

## 22. [bug/low/small] aria-expanded without aria-controls on 'Inspect evidence'
- where: src/renderer/src/views/ImprovementScout.tsx:782
- evidence: <button className="btn" type="button" aria-expanded={inspected} onClick={…}>{inspected ? 'Hide evidence' : 'Inspect evidence'}</button> — the disclosed <div className="scout-inspection"> (789) has no id.
- failure: A screen reader announces expanded/collapsed but cannot jump to the region it controls.
- fix: id={`scout-inspection-${suggestion.id}`} on the div and aria-controls on the button.

## 23. [bug/low/small] Two sources of truth for 'enabled sources' on one page
- where: src/renderer/src/views/ImprovementScout.tsx:635
- evidence: <strong>{overview.enabledSourceCount}/{overview.sourceCount}</strong> (DB COUNT/SUM over improvement_scout_sources, improvement-scout.ts 433-434) vs <span className="scout-state muted">{sources.filter((source) => source.enabled).length} enabled</span> (622; registry-mapped listSources 277-292).
- failure: A source removed from TRUSTED_SOURCES in an upgrade leaves its row counted in the stat card ('4/6') but absent from the list ('4 enabled'); the same figure can disagree with itself.
- fix: Derive both from listSources().

## 24. [honesty/low/small] Policy promises drawn in the success colour with the observed-completion glyph
- where: src/renderer/src/styles/improvement-scout.css:94
- evidence: .scout-safety-list span { color: var(--ok); font-weight: 800; } on four '✓' bullets (TSX 729-732) — the same '✓' is RUN_GLYPH.completed (TSX 134) coloured --good at .scout-run-outcome.completed (273).
- failure: Four green ticks that assert what Scout will never do sit on the same page as one green tick that reports a scan actually completing; nothing distinguishes a promise from an observation.
- fix: Plain list bullets in --text-faint for the promises; keep the tick for observed outcomes only.

## 25. [honesty/low/small] 'Snooze' sets a status with no wake-up
- where: src/renderer/src/views/ImprovementScout.tsx:784
- evidence: onClick={() => void updateSuggestion(suggestion, 'snoozed', 'Proposal snoozed. Reopen it whenever it becomes relevant again.')} — main stores the status only (improvement-scout.ts 915-918); no until-date, no reminder.
- failure: The verb implies the proposal will come back; it never does unless the operator reopens it by hand.
- fix: Rename to 'Set aside' or add a snooze-until date the scheduler honours.

## 26. [unfinished/low/medium] Proposal notes are supported by main and stored but no surface writes or shows them
- where: src/main/improvement-scout.ts:909
- evidence: if (patch.note !== undefined) { … note = patch.note?.trim() || null; } (up to MAX_NOTE 4,000 chars); the renderer's normalizeSuggestion never reads `note` and no input sends it.
- failure: The one place an operator could record why they snoozed or dismissed a proposal exists in the schema and IPC but not in the UI.
- fix: A note textarea in the inspection panel with a Save button, shown as prose on the card when present.

## 27. [missing/low/small] Evidence shows 'Publisher/date not supplied' though retrievedAt is always recorded
- where: src/renderer/src/views/ImprovementScout.tsx:791
- evidence: <small>{[evidence.publisher, evidence.publishedAt ? formatDate(evidence.publishedAt) : null].filter(Boolean).join(' · ') || 'Publisher/date not supplied'}</small> — normalizeEvidence (232-241) drops `retrievedAt`, which main always sets (324); publishedAt is only found for pages with <time datetime> (538-544).
- failure: Most evidence rows print no date at all, when the honest and always-available date is when Wanigan fetched the page.
- fix: Show 'retrieved <date>' always and 'published <date>' when known.

## 28. [polish/low/small] Three different loading renderings on one view; Reading primitive unused
- where: src/renderer/src/views/ImprovementScout.tsx:760
- evidence: {loading && <div className="scout-empty"><span>◌</span><div><h3>Reading local Scout records…</h3>…} plus EmptyState posture="nothing-yet" title="Reading local Scout records" (577) plus filterStatus 'Reading local Scout records…' (526). bits.tsx exports Reading (aria-busy, role=status) for exactly this.
- failure: A re-read after 'Try again' shows two 'Reading…' blocks at once (filter status and results), neither with aria-busy.
- fix: Wrap the stat grid and queue in <Reading what="local Scout records"> and delete .scout-empty's loading branch.

## 29. [polish/low/medium] Filter bar: native selects with a 43-char option, bottom-aligned to a four-line paragraph
- where: src/renderer/src/views/ImprovementScout.tsx:748
- evidence: <select …>{statuses.map(…)}</select> / <option value="effort">Smallest effort first · unestimated last</option> (749) / <input placeholder="Search proposals"> (750); CSS .scout-filterbar { align-items: end } (140). Screenshot: 'Review queue / 0 proposals / Nothing proposed yet. / The order here…' on the left with the three controls hanging at the bottom right.
- failure: Sibling views filter with Chip/Segmented; here the status chip-with-count pattern is a dropdown, and the bar's height is set by prose rather than by the controls.
- fix: SectionHead label='Review queue' count=N + status Chips with counts + Segmented for order + the search field; one status sentence beneath.

## 30. [polish/low/small] Disabled controls carry no reason
- where: src/renderer/src/views/ImprovementScout.tsx:608
- evidence: <input type="checkbox" checked={settings.weeklyEnabled} disabled={busy !== null || !settings.enabled || !settings.networkEnabled} …> (608), same at 603; 'Create linked Goal' disabled={… || suggestion.evidence.length === 0} (792) — none has a title or Hint naming the gate.
- failure: The Weekly watch box is greyed with 'Runs only when research is allowed' as its only hint; the operator has to guess that 'Allow unattended official-source checks' is the gate. A greyed 'Create linked Goal' says nothing about missing evidence unless the inspection is opened.
- fix: Hint under each: 'Needs Allow unattended checks', 'Needs at least one retained source'.

## 31. [polish/low/small] Queue filter, order, search and inspection are not remembered across tab switches
- where: src/renderer/src/views/ImprovementScout.tsx:365
- evidence: const [status, setStatus] = useState('all'); const [query, setQuery] = useState(''); … const [sort, setSort] = useState<'newest'|'effort'>('newest'); const [inspectedId, setInspectedId] = useState<string|null>(null); — Batches, Git, Fleet, Control, Learning and Usage use useViewMemory (components/viewMemory.ts 115).
- failure: Open a proposal's evidence, jump to Control to check a Goal, come back: filter, order and the open inspection are reset.
- fix: useViewMemory('status'|'sort'|'query'|'inspected').

## 32. [polish/low/small] Stale placement claims: sheet comment and README say Scout lives under Learning
- where: src/renderer/src/styles/improvement-scout.css:52
- evidence: /* Scout lives inside Learning's established scroll well. Let that one owner handle the scrollbar … */ — routes.ts 39/75 list 'scout' as a top-level Explore route (⌘⇧I) and Learning.tsx 307 says 'Scout is a top-level view now'; README.md 459 still opens with '**Learning → Scout**'.
- failure: The README sends a new operator to a Learning tab that no longer contains Scout.
- fix: Update the comment and README to 'Explore → Scout (⌘⇧I)'.

## 33. [polish/low/small] Dead selectors for states the main process never produces
- where: src/renderer/src/styles/improvement-scout.css:179
- evidence: .scout-status.new, .scout-status.review {…} (179); .scout-suggestion.status-goal_created (158) and .scout-status.goal_created (182); .scout-chip.risk-medium (185). Main emits statuses new/reviewed/snoozed/dismissed/goal-created (safeSuggestionStatus 342-345) and risks low/elevated/high (339-341).
- failure: None visible; the rules document states that do not exist and pad the sheet the gate reviews by hand.
- fix: Remove `.review`, `goal_created` and `risk-medium` variants.

## 34. [polish/low/small] Eight literal paddings in the sheet; the gate ratchets font px and durations but not padding
- where: src/renderer/src/styles/improvement-scout.css:109
- evidence: padding: 7px 9px; (109) — also padding: 3px 8px (36), 9px 10px (126), 2px 7px (169), 8px 9px (190), 9px 10px (196), 10px (207), 9px 10px (218). CLAUDE.md: a surface sheet 'spells no font size, padding or duration as a literal'. check-renderer-style.cjs checks 3 and 4 cover font px and durations only.
- failure: Toggle tiles, source rows, reason cells and evidence boxes each pick their own inset, which is why the setup card and the proposal card do not share a rhythm.
- fix: Map to --s-1/--s-2/--s-3 and the pill's inset token.

## 35. [polish/low/small] The 'deterministic rules, no model' sentence appears three times
- where: src/renderer/src/views/ImprovementScout.tsx:726
- evidence: Explainer p: 'This build uses local deterministic matching rules over allowed sources; it does not send source text to a provider model…' (726); bullet: 'The current analyzer is deterministic; no source text is sent to an AI model.' (730); pill title: 'The current Scout builds proposals with local deterministic matching rules; it does not send source text to a provider model.' (551).
- failure: About 70 words of explainer prose plus a tooltip restate one fact; the head pill 'local rules' already names it.
- fix: Keep the pill and one explainer sentence; drop bullet 2 and the tooltip.

## 36. [polish/low/small] 'Why it surfaced now' exposes rule ids as jargon
- where: src/main/improvement-scout.ts:711
- evidence: `${source.publisher} source “${evidence.title}” matched the deterministic ${rule.id} rule.` (711; 704 'currently matches') → 'Anthropic source “Claude Code changelog” matched the deterministic lsp-diagnostic-bridge rule.'
- failure: The one sentence meant to justify the proposal to a person names an internal identifier instead of the term found and the capability Wanigan lacks.
- fix: 'The Claude Code changelog mentions “language server”, and Wanigan has no diagnostic bridge yet.'

## 37. [polish/low/small] Duplicate Goal CTA on one card
- where: src/renderer/src/views/ImprovementScout.tsx:787
- evidence: {goalId && <button className="btn btn-primary" …>Open linked Goal</button>} in the actions row and, in the inspection goal picker, {goalId ? <button className="btn btn-primary" …>Open Goal in Control →</button> : …} (792).
- failure: Two primary buttons with different labels for the same action on the same card once evidence is open.
- fix: Keep one; the picker shows a Pill 'Goal linked' with a text link.

## 38. [polish/low/small] Local time shows '9 AM' while the cadence line shows '09:00'
- where: src/renderer/src/views/ImprovementScout.tsx:613
- evidence: new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' }) → '9 AM'; overview.cadenceLabel comes from describeCron → `every ${DOW} at ${hh}:${mi}` (schedule.ts 153-156) → 'Every Saturday at 09:00'.
- failure: The same setting is printed in two clock formats a few rows apart.
- fix: Format the cadence in the renderer from weekday/hour with the same toLocaleTimeString call.

## 39. [modernize/low/small] Accent used for links, glyphs, borders, pills and both primary buttons
- where: src/renderer/src/styles/improvement-scout.css:227
- evidence: .scout-empty > span { color: var(--accent) } (227); .scout-banner > span (68); .scout-source a (136); .scout-evidence a (214); .scout-goal-link (223); .scout-status.new (179); .scout-suggestion.status-new border-left (155); plus .btn-primary ×2 in the head.
- failure: On a card with a new proposal the left rule, the status pill, two 'Open source ↗' links and the Create Goal button are all coral, so the one action the accent should mark has no priority.
- fix: Links in --text with underline on hover, glyphs in --text-faint, keep the accent for the primary action and the 'new' marker only.

## 40. [modernize/low/medium] Consent settings as three bordered checkbox tiles inside a bordered card
- where: src/renderer/src/styles/improvement-scout.css:104
- evidence: .scout-toggle { display: flex; … min-height: 38px; padding: 7px 9px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-sunk); …} inside .card.scout-card; two selects on a second row with an empty third column (grid 102).
- failure: Three boxes-in-a-box with a 33-word paragraph above them; Cursor/Raycast settings are a switch list (label left, switch right, one-line hint) with the schedule summarised inline.
- fix: A switch-row list: Workspace / Unattended checks / Weekly watch, and 'Every Saturday · 9 AM' as an inline editable summary.

## 41. [modernize/low/large] Proposal cards stack six blocks each; a list + detail pane would keep the queue scannable
- where: src/renderer/src/views/ImprovementScout.tsx:766
- evidence: <article className="card scout-suggestion …"> title/summary (768) → 4-cell reason grid (774-779) → why-now blockquote (780) → 3–5 buttons (781-788) → optional inspection with recommendation, evidence list and goal picker (789-793).
- failure: With four proposals the page is four tall cards each carrying its own action row; the reader cannot scan titles against status and effort in one glance.
- fix: Left list (title · status Pill · effort · found) and a right detail pane holding reason codes, evidence, note and the single Goal action, as Conductor's review and Linear's issue list do.

