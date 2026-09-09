# Fleet view (src/renderer/src/views/Fleet.tsx, src/renderer/src/styles/fleet.css, src/main/fleet-snapshot.ts, src/main/observed.ts, plus the ObservedBand/TeamPanel components it mounts)

41 findings. readability={"firstPaintWords": 13, "fontSizesInSheet": 9, "explainerHintNoteUses": 4, "nestedBorderDepth": 2, "notes": "firstPaintWords = title 'Fleet' (1) + lead 'Every agent on one screen. Whoever is blocked sorts to the top.' (12) before the Sort Segmented, which is DOM-after in the same PageHead; before the first data row (a Stat tile) the operator also reads 'Agent teams (0) 0 tasks' (5) and the blocked banner (12 words + link) \u2014 ~30 words. fontSizesInSheet counts distinct declarations in fleet.css: 10, 10.5, 11, 11.5, 12, 12.5, 13, 14px plus var(--t-lead) (16 declarations, 15 literal \u2014 the gate's baseline). explainerHintNoteUses counts Fleet.tsx only: Note \u00d74 (lines 442, 487, 499, 510), Hint 0, Explainer 0; the mounted ObservedBand adds 1 Hint and up to 3 Notes, TeamPanel none. nestedBorderDepth: pane \u2192 .fleet-card (1px + 3px left border) \u2192 .fleet-metric (1px border) = 2; the table sits at 1 (.card)."}

notes: Read-only audit; nothing in the repository was edited. Screenshot claims were checked against the TSX and main: (1) the exited card reading 'Idle for 1h 30m' is a stub artifact — renderer-harness.mjs gives s3 no attention row and Fleet falls back to 'idle' (F20), whereas attention.ts classify() always returns finished/error for an exited session; (2) 'Agent teams (0)' without its note is the stub's truthy `enabled` proxy, though the '(0)' heading itself is real code (F37); (3) the ObservedBand is absent from the shots only because they end at the table header. On the task's explicit question: observed.ts (now 510 lines) is NOT surface-less — ObservedBand.tsx calls state/list/setEnabled and Fleet mounts it in both the empty and populated branches, with smoke3.ts:5635-5665 asserting it; BUILD-PLAN.md:285-286 and 744 are stale (F24), and the only remaining gap is the Settings › Privacy toggle the band's own copy already claims exists (F23). The DIN stencil eyebrow face is not used by Fleet at all (no `eyebrow` prop; h1 is the system face at --t-display), so the prior stencil complaint does not apply here. Every CSS custom property referenced by fleet.css and observed.css (--r-sm, --r-md, --s-1/2/3, --mo-state, --mo-ease, --series-1, --line-soft, --warning, --critical, --serious, --good, --t-lead) was confirmed defined in index.css or motion.css; no className in Fleet.tsx is unmatched by a rule. Contrast ratios were computed with node from the token hex values (dark faint/sunk 6.79, light faint/sunk 4.65). Inline style objects (29 in Fleet.tsx) were not reported individually per the ratchet.

## 1. [bug/high/small] Blocked banner is role=alert and mutates its wait time every second
- where: src/renderer/src/views/Fleet.tsx:510
- evidence: `<Note tone="error">` with no `role` prop; bits.tsx Note: `const r = role ?? (tone === 'error' ? 'alert' : 'status')`. Line 519 inside it: `{s.projectName} — {dur(Date.now() - (attention[s.id]?.since ?? Date.now()))}`, re-rendered by the 1s clock at line 270. The comment at 339-344 says the banner 'cannot be the live region' because a reader 'would re-read the whole alert on every tick' — but it is one.
- failure: VoiceOver/NVDA re-announce '1 agent is waiting on you … storefront — 4m 35s' every second while a permission prompt is open; the deliberate polite sentence at line 507 is drowned out by the very noise the comment set out to avoid.
- fix: Pass `role="none"` on this Note (the sr-only `<p aria-live="polite">` at 507 already announces membership), or move the live duration out of the alert into a non-live span.

## 2. [bug/high/small] 'was ended' is claimed before any exit is observed; the no-process branch is unreachable for stop
- where: src/renderer/src/views/Fleet.tsx:373
- evidence: `const ok = action === 'interrupt' ? await …interrupt(…) : await …kill(…)`; then `ok ? … \`${session.projectName} was ended.\` : { ok: false, text: \`… had no live process to ${verb}\` }`. src/main/index.ts:1605: `handle('sessions:kill', (id: string) => { killSession(id); return true; })`; sessions.ts:2136-2142 `killSession` returns void and silently returns when `!s` or status is exited.
- failure: Cards re-sort under the pointer (the ConfirmRow comment says so). Stop on a card that just exited prints 'platform was ended.' though nothing was signalled; on a live process the ok Note says 'was ended' while the card beneath still reads 'Running · pid 4088' until session:exit arrives. The 'had no live process to stop' sentence can never render.
- fix: Make `sessions:kill` return whether a live process was signalled (mirror `interruptSession`'s boolean), and phrase the ok Note as 'Stop sent to X' until `on.exit` confirms, then 'X ended (code n)'.

## 3. [bug/medium/small] Keyboard focus is dropped when the confirm row replaces the controls
- where: src/renderer/src/views/Fleet.tsx:735
- evidence: `onClick={() => setAsking(c.action)}` unmounts the control row (725-741) and mounts `ConfirmRow` (779-808), which has no autoFocus; `onCancel={() => setAsking(null)}` restores nothing.
- failure: After pressing 'stop' with the keyboard, focus falls to body; the confirm question must be re-tabbed to through the whole card, and if the grid re-sorts in between the next Tab lands on a different agent.
- fix: autoFocus the 'leave it alone' button in ConfirmRow and return focus to the originating control via a ref on cancel/complete.

## 4. [bug/medium/small] observedState prints 'undefined' as the registry path when no Claude config root exists
- where: src/main/observed.ts:494
- evidence: `const registry = registries.find((dir) => fs.existsSync(dir)) ?? registries[0];` then 503: `\`Wanigan is not looking. Turn this on and it reads ${registry} — one file per running Claude process\``. accounts.ts readRoots: `configDirs(harness)` keeps only accounts whose dir `present` (114, 468) and adds the ambient dir only `if (ambient)` — so a machine with no ~/.claude and no CLAUDE_CONFIG_DIR yields `[]`.
- failure: The band's off-state Note reads 'Turn this on and it reads undefined — one file per running Claude process'.
- fix: Fall back to `path.join(os.homedir(), '.claude', 'sessions')` for the sentence, or say 'no Claude config directory was found on this machine'.

## 5. [honesty/medium/small] Table promises the sparkline values and prints two; 'em dash = no samples' contract is false
- where: src/renderer/src/views/Fleet.tsx:949
- evidence: Lines 891-892: 'including the values each sparkline draws'. Lines 949-950: `{vals.length ? rate(last) : '—'}` / `{peak > 0 ? rate(peak) : '—'}`. Footer 958-961: 'An em dash means the collector has no samples yet, not zero throughput.' otel.ts:891-937 `throughput()` always returns an n-length array (`new Array(n).fill(0)` … `return rates.slice()`), so `vals.length` is 24 for every fetched session.
- failure: A session with no output samples shows 'tok/s now 0.0' beside 'tok/s peak —' while its own card says 'no data yet'; the footer's promised em dash appears only in the one poll before sparks load.
- fix: Gate `now` on `peak > 0` (or on `u.lastAt`) exactly as `peak` is; either print the 24 values (a details row or title) or change the sentence to 'the latest and peak rate of each sparkline'.

## 6. [honesty/medium/small] Footer states a cache-pricing fact for every provider row
- where: src/renderer/src/views/Fleet.tsx:959
- evidence: `Tokens are input plus output; cached reads are billed at a tenth of the input rate and are counted separately on each card.` — under a table containing Codex rows whose Cost is 'Not reported' and GLM rows marked 'est.' (costFigure 109-135).
- failure: Asserts a billing rate Wanigan has not verified per backend; contradicts CLAUDE.md's rule against presenting an unverified rate as fact on the same screen that carefully marks GLM dollars as an estimate.
- fix: Drop the rate clause or scope it: 'On Anthropic's published price list a cached read costs a tenth of an input token; other backends are not priced here.'

## 7. [honesty/medium/small] Private provider-name map ignores the frozen profile label and the shared humanizer
- where: src/renderer/src/views/Fleet.tsx:26
- evidence: `const PROVIDER: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', glm: 'GLM' }; const providerName = (id) => PROVIDER[id] || id || 'unknown provider'`. provider-status.ts:53-58 already knows `deepseek`; line 85 `frozenLabel || registered?.label?.trim() || humanizeProviderId(session.providerId)` is how Sessions names a provider; CLAUDE.md: 'Route behavior by declared harness… not by hardcoded profile ids such as claude, codex, or glm'.
- failure: A DeepSeek or pack-profile session prints its raw id ('deepseek', 'acme-pack.glm') in the card pill and table while the Sessions view prints the profile label — the same session named two ways.
- fix: Export `humanizeProviderId` and label with `s.providerProfile?.label ?? humanizeProviderId(s.providerId)`; delete the local map.

## 8. [honesty/medium/small] ObservedBand copy names a Settings switch that does not exist
- where: src/renderer/src/components/ObservedBand.tsx:187
- evidence: 'The switch is called “Sessions started outside Wanigan” and it is one of Wanigan's own settings' and button title at 266 'Turns off the “Sessions started outside Wanigan” setting'. grep of Settings.tsx and the whole renderer for 'outside Wanigan' / 'observed_sessions' / observed.setEnabled finds only ObservedBand; .claude/BUILD-PLAN.md:742 still lists 'Add the observed-sessions consent switch to Settings › Privacy' as future work.
- failure: An operator sent to Settings by this sentence finds nothing; the only switch is the band's own button at the bottom of Fleet.
- fix: Either land the planned Settings › Privacy toggle or reword: 'It is one of Wanigan's own settings and the switch is here, below.'

## 9. [missing/medium/small] Session title / displayTitle never shown; two cards on one repo are indistinguishable
- where: src/renderer/src/views/Fleet.tsx:675
- evidence: `<span className="fleet-name">{s.projectName}</span>` (and 927 in the table). types.ts Session carries `title` and `displayTitle` ('The user-facing name: renamed by hand, or derived from the launch prompt'); Sessions.tsx:554 renders displayTitle; fleet-snapshot.ts:110 ships `title` to the phone.
- failure: Two sessions on the same repository (the screenshot's two 'platform' cards) differ only by provider pill; a session the operator renamed keeps its rename everywhere except the screen built for eight agents.
- fix: Name line = `s.displayTitle ?? s.title`, projectName as the secondary line; same in the Session column.

## 10. [missing/medium/small] Account is frozen on the session and sent to the phone, but absent from the desktop Fleet
- where: src/renderer/src/views/Fleet.tsx:681
- evidence: fleet-snapshot.ts:116 `account: accountOf(session)` with the comment 'for an operator holding a phone'; types.ts `accountLabel?: string | null` on Session; Sessions.tsx:672 `{multiAccount && s.accountLabel && \` · ${s.accountLabel}\`}`. Fleet.tsx has no reference to accountLabel (grep).
- failure: With two Claude logins, Fleet cannot say which account a blocked or expensive session runs under — the phone can.
- fix: Append `s.accountLabel` to the meta line and a Table column when more than one distinct account is present in the list.

## 11. [missing/medium/small] The observed band — the count that corrects 'nothing is running' — is the last thing on the page
- where: src/renderer/src/views/Fleet.tsx:616
- evidence: `<ObservedBand />` is rendered after `FleetTable` (610), under a 13-column table with `minWidth: 940`; observed.ts:14-23 argues this is 'the one number the whole app is built around… wrong silently'. The screenshot ends at the table header; the band is below the fold.
- failure: With eight Wanigan sessions on screen, nine VS Code sessions are reported two screens down; the stat tiles still say '2 running'.
- fix: A fifth Stat tile 'Outside Wanigan · n' (count from observed.list when enabled, 'off' when not) that scrolls to the band; keep the band's rows where they are.

## 12. [polish/medium/small] A private .fleet-chip family instead of the shared Chip, with an accent pressed state
- where: src/renderer/src/styles/fleet.css:14
- evidence: `.fleet-chip {…}`, `.fleet-chip.on { border-color: var(--accent); … background: var(--accent-soft); }`, `.fleet-chip-n` (13-25); Fleet.tsx:571-586 builds them by hand. ui.css:40-53 `.chip[aria-pressed='true'] { background: var(--bg-selected); border-color: var(--text-faint) }`; compact.css:77 has to list `.fleet-chip` separately for touch targets. CLAUDE.md: compose `Chip` 'rather than adding a new *-card, *-head or *-chip class family'.
- failure: Two chip looks in one app, and the coral accent is spent on a filter state the primitive deliberately keeps neutral.
- fix: `<Chip pressed={only===k} count={counts[k]} onToggle={…}>{glyph}{word}</Chip>`; delete `.fleet-chip*` and the compact.css entry.

## 13. [polish/medium/small] Loading and filter-empty states are hand-rolled instead of Reading / EmptyState
- where: src/renderer/src/views/Fleet.tsx:426
- evidence: `<div className="card fleet-blank"><p>Reading the fleet…</p>` (426-435) and `<h2>No session is … right now</h2> … 'That is usually the good outcome.'` (588-598); fleet.css:144-150. bits.tsx Reading: 'Loading is not empty… No spinner'; EmptyState `nothing-in-scope`: 'rows exist, none match this window or filter'.
- failure: The view's blank frames use `--t-lead` and a 30px-padded card while every other surface's empty state uses the EmptyState postures; the editorial line is opinion, not observation.
- fix: `<Reading what="the fleet">` with the stat-grid frame as children; `<EmptyState posture="nothing-in-scope" title=… action={Show all}>`; drop `.fleet-blank`.

## 14. [modernize/medium/medium] Underlined lowercase text-links as the card's action controls
- where: src/renderer/src/views/Fleet.tsx:731
- evidence: `<button className="fleet-inline" … >{c.glyph} {word}</button>` for '⎋ interrupt' / '■ stop' (731-739), 'open →' (719-722); fleet.css:28-32 `.fleet-inline { text-decoration: underline; … }` with `:hover { text-decoration-thickness: 2px }`.
- failure: Reads as 2010 web hyperlinks next to Linear/Raycast, where row actions are quiet icon buttons with a tooltip and a kbd hint, or one '…' overflow menu; underline is reserved for prose links.
- fix: Icon-button trio (Lucide square / corner-up-left / arrow-right via the existing `Icon`) with `title` and visible word on hover, or a single row menu; keep the glyph+word rule inside the menu items.

## 15. [modernize/medium/small] Bordered metric boxes inside a bordered card
- where: src/renderer/src/styles/fleet.css:114
- evidence: `.fleet-metric { … border-radius: 7px; background: var(--bg-sunk); border: 1px solid var(--line-soft); }` inside `.fleet-card { border: 1px solid var(--line); border-left-width: 3px }`; index.css:718-720 argues 'a card at every depth wearing the same line made hierarchy a matter of counting borders'.
- failure: Three boxes per card × eight cards = 24 nested frames on screen; the eye counts borders instead of reading numbers.
- fix: One unbordered three-column row with hairline dividers, label above a tabular number (the Stat idiom), background-free.

## 16. [modernize/medium/medium] The 13-column table is always rendered beneath the cards
- where: src/renderer/src/views/Fleet.tsx:881
- evidence: `FleetTable` renders unconditionally after the grid (610) with `minWidth: 940` and thirteen `<th>` (898-910); its own copy says it is 'the same rows as the cards above, in the same order'.
- failure: Every operator scrolls past two copies of the fleet; the observed band (the one place the count is most wrong) ends up under both.
- fix: A Segmented density toggle (Cards | Table) like Linear's board/list, remembered in view memory; or fold the table into a disclosure under a SectionHead.

## 17. [bug/low/small] Dead focus rule: the card is a div that can never be focused
- where: src/renderer/src/styles/fleet.css:158
- evidence: `.fleet-card:focus-visible, … { outline: 2px solid var(--accent) }`; Fleet.tsx:653 `<div className={\`fleet-card…\`} onClick={onOpen} style={{ cursor: 'pointer' }}>` — no tabIndex anywhere in the file (grep), so whole-card open is mouse-only.
- failure: The selector matches nothing; keyboard users rely solely on the small 'open →' button at the card foot.
- fix: Delete the selector, or make the card `tabIndex={0}` with an Enter/Space handler if whole-card open is intended for keyboard.

## 18. [bug/low/small] Stalled note prints 'from —' when the list arrived by push before any successful poll
- where: src/renderer/src/views/Fleet.tsx:489
- evidence: `const offList = window.wanigan.on.sessions((list) => { setSessions(list); nudge(); })` (282) can populate `sessions` while `updatedAt` is still 0; the warn Note reads `the cards below are the last good read, from {ago(updatedAt)}` and bits `ago(0)` returns '—'.
- failure: 'Live updates stalled. … from —' — a sentence with a blank where its only fact should be.
- fix: `updatedAt ? \`from ${ago(updatedAt)}\` : 'as the main process last pushed them'`.

## 19. [bug/low/small] Desktop and phone disagree on the fallback kind for a session with no attention row
- where: src/renderer/src/views/Fleet.tsx:628
- evidence: `const kind = att?.kind ?? 'idle'` (also 306, 390) vs fleet-snapshot.ts:97-105 `kind: session.status === 'exited' ? 'finished' : 'idle'`. attention.ts:373-436 always classifies an exited session as finished/error, so the desktop fallback fires only between a `session:list` push (282) and the 120ms nudge. The screenshot's 'Idle for 1h 30m / Exited code 0' card is exactly this branch — a stub artifact (fixture s3 has no attention row), but the code path exists.
- failure: For one frame a just-pushed exited session reads 'Idle' with a growing 'for' timer; two projections of one fleet encode the rule twice.
- fix: Export one `fallbackAttention(session)` from shared and use it in both; or defer rendering a card until its attention row arrives.

## 20. [bug/low/small] An attention kind outside the union can be shown but never counted or filtered
- where: src/renderer/src/views/Fleet.tsx:576
- evidence: `ATTENTION_ORDER.filter((k) => counts[k]).map(…)` builds chips only for known kinds, while the grid renders any kind via `MARK[kind] ?? UNKNOWN` (629) and the 'Unknown' mark; `counts` (303-310) keys by whatever main sends.
- failure: If main ever ships a new kind, sessions in it appear in 'All' with a grey 'Unknown' mark but no chip, no count and no way to isolate them.
- fix: Build chips from `Object.keys(counts)` ordered by ATTENTION_ORDER with unknowns last, using UNKNOWN for the mark.

## 21. [honesty/low/small] 'Spend' sort ranks estimates and unreported costs as if they were bills
- where: src/renderer/src/views/Fleet.tsx:393
- evidence: `const d = usageOf(b.id).costUsd - usageOf(a.id).costUsd` with hint 'Most expensive session first' (57); costFigure (109-135) distinguishes reported / unverified / none only for display.
- failure: A Codex session whose cost is 'Not reported' sorts as $0 regardless of real spend; a GLM 'est.' figure outranks a smaller invoiced one under a label that says 'most expensive'.
- fix: Sort reported before unverified before none, then by amount; hint 'By reported cost; estimates and unreported sessions last'.

## 22. [honesty/low/small] Sparkline aria-label reports the bucket count as a sample count
- where: src/renderer/src/views/Fleet.tsx:862
- evidence: `aria-label={\`Output throughput, ${n} samples oldest to newest…\`}` where `n = values.length`, and otel.ts throughput() always returns `buckets` (24) entries regardless of how many api events exist.
- failure: A screen reader hears '24 samples' for a session with three requests.
- fix: Say '24 intervals across the session' or pass the real row count from usage.requests.

## 23. [honesty/low/small] Trust column shows today's default as if it were the session's frozen trust
- where: src/renderer/src/views/Fleet.tsx:922
- evidence: `const trust = s.trust ?? defaultTrust;` (also 604) with `title={trustCopy(trust).detail}`; sessions.ts:1004 freezes trust at launch, so only legacy rows lack it.
- failure: A pre-trust session reads '◈ project' with the tooltip describing an enforced gate that was never recorded for it.
- fix: Print 'not recorded' with a neutral glyph when `s.trust` is absent.

## 24. [honesty/low/small] Build plan says observed.ts has zero renderer surface; it has a full one
- where: .claude/BUILD-PLAN.md:285
- evidence: '`src/main/observed.ts` is 465 lines of finished… code with three IPC channels and zero renderer surface' (285-286) and 'observed.setEnabled has zero renderer callers today' (744). ObservedBand.tsx:97 `observed.state()`, 100 `observed.list()`, 144 `observed.setEnabled(on)`; Fleet.tsx mounts `<ObservedBand />` at 476 and 616; smoke3.ts:5635-5665 asserts both mounts and the verbatim notice. observed.ts is now 510 lines.
- failure: The plan directs future work at a gap that closed; the remaining real gap is the Settings entry (F23).
- fix: Update lines 285-286 and 744 to describe ObservedBand and narrow item 742 to the Settings toggle.

## 25. [missing/low/small] No way to clear an exited card from Fleet
- where: src/renderer/src/views/Fleet.tsx:715
- evidence: Exited card foot renders only `Exited … · {ago(s.endedAt)}` and 'open →'; preload sessions.close (index.ts:100) and `handle('sessions:close', …)` (main/index.ts:1606) exist and Sessions binds ⌘⌫ to it.
- failure: Exited sessions accumulate in the grid and in '3 cards' with no action on this surface but opening them.
- fix: Add a 'close' fleet-inline on exited cards calling `sessions.close(id)` then `load(false)`.

## 26. [missing/low/small] API errors and refusals are recorded but not surfaced on card or table
- where: src/renderer/src/views/Fleet.tsx:700
- evidence: Metrics show Cost/Tokens/Lines only (699-711; table 943-951). SessionUsage has `errors` and `refusals`; fleet-snapshot.ts:126 ships `errors` and totals it for the phone.
- failure: A session with a dozen failed API calls reads identical to a healthy one until attention flips to 'error'.
- fix: Append `· N errors` to the Cost metric sub when > 0 and add an Errors column.

## 27. [polish/low/small] Note retry/dismiss bypass the primitive's action and onDismiss slots
- where: src/renderer/src/views/Fleet.tsx:490
- evidence: `<button className="fleet-inline" onClick={() => void load(true)}>Retry now</button>` inside a Note (490), `<button className="fleet-inline" onClick={() => setActed(null)}>Dismiss</button>` (502), `<button className="btn fleet-retry" style={{ marginTop: 8 }}>` (448). bits.tsx Note accepts `action` and `onDismiss` and renders `.btn.btn-sm`.
- failure: Three different retry/dismiss affordances in one view; the underlined inline button inside a note exists nowhere else.
- fix: `action={{ label: 'Retry now', run: () => load(true) }}` and `onDismiss={() => setActed(null)}`.

## 28. [polish/low/small] SR_ONLY inline object is a fifth copy of .sr-only
- where: src/renderer/src/views/Fleet.tsx:36
- evidence: `const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, … clipPath: 'inset(50%)' }` used at 507; ui.css `.sr-only` carries the byte-equivalent recipe with the comment 'There were four of these… Four copies of one utility is four places to fix'.
- failure: The consolidation the sheet documents is undone by one view.
- fix: `<p aria-live="polite" className="sr-only">`.

## 29. [polish/low/small] fleet-snapshot duplicates ATTENTION_ORDER as a literal map
- where: src/main/fleet-snapshot.ts:162
- evidence: `const order = new Map([['permission', 0], ['error', 1], ['finished', 2], ['idle', 3], ['working', 4]])` — types.ts:694 exports `ATTENTION_ORDER` and attention.ts exports `rank()` 'so the renderer can re-sort… without drifting'.
- failure: A new attention kind added to the shared order silently sorts to 99 on the phone.
- fix: `ATTENTION_ORDER.indexOf(kind)` or reuse `rank` on the picked fields.

## 30. [polish/low/small] Eight literal font sizes, three of them half-pixel values off the type scale
- where: src/renderer/src/styles/fleet.css:74
- evidence: grep: 10.5px ×4, 11.5px ×2, 12.5px ×2, 10px ×2, 11px ×2, 12px, 13px, 14px (15 literals, ratchet baseline `'fleet.css': 15` in check-renderer-style.cjs:101); the scale is 10/11/12/13.5/15/20/28 (index.css:93-99).
- failure: Nine distinct sizes in one 164-line sheet; 10.5/11.5/12.5 exist nowhere else in the app.
- fix: Map to --t-tiny/--t-micro/--t-small/--t-body and let the baseline ratchet to 0.

## 31. [polish/low/small] .fleet-kbd hardcodes a mono stack instead of --mono
- where: src/renderer/src/styles/fleet.css:154
- evidence: `font-family: ui-monospace, 'SF Mono', Menlo, monospace;` while index.css:275 `.mono { font-family: var(--mono) }` and `--mono` is a declared token.
- failure: The ⌘T kbd can drift from every other monospace glyph in the app.
- fix: `font-family: var(--mono)`.

## 32. [polish/low/small] Sheet comments describe deleted rules and a button the card no longer is
- where: src/renderer/src/styles/fleet.css:80
- evidence: `display: -webkit-box;   /* a span, because a <p> inside a <button> is invalid */` — Fleet.tsx:649-653 says 'A div, not a button'; lines 7-10 narrate a removed `.fleet-seg/.fleet-segbtn` pair and 'one of this sheet's two literal-duration debts' that no longer exist.
- failure: A reader trusts the comment and keeps a span for a constraint that vanished.
- fix: Delete both comments; keep the span if the clamp needs it, and say why.

## 33. [polish/low/small] Local dur() formats differently from the shared dur()
- where: src/renderer/src/views/Fleet.tsx:79
- evidence: Fleet: `${m}m ${s % 60}s` → '3m 5s'; bits.tsx:538-548 dur: `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s` → '3m 05s', and '840ms' below a second.
- failure: The same wait reads '3m 5s' on Fleet and '3m 05s' on Runs/Sessions; two functions to maintain for one idea.
- fix: Import `dur` from bits (it already has the finite guard) or add a `{ coarse: true }` option there.

## 34. [polish/low/small] 'For' column header and a prose paragraph where a Hint would do
- where: src/renderer/src/views/Fleet.tsx:900
- evidence: `<th>For</th>` meaning time in the current state; 889-893 `<h3>Every session, in numbers</h3><p className="dim" …>The same rows as the cards above, in the same order, including…</p>`.
- failure: 'For' is unreadable without the card context; the paragraph explains the table's existence rather than naming it.
- fix: Header 'In state' (or 'Waiting'); replace the paragraph with `<SectionHead label="Every session" count={rows.length}>` and a one-line Hint.

## 35. [polish/low/small] 'Agent teams (0)' heading is a reachable state
- where: src/renderer/src/components/TeamPanel.tsx:58
- evidence: `state.teams.length === 1 ? 'Agent team' : \`Agent teams (${state.teams.length})\`` renders whenever `enabled` (teams.ts:247 env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1') and no team exists, followed by the note 'Agent teams are enabled but none is running…'. The screenshot shows this heading without its note — the stub's truthy `enabled` proxy — so the missing note is a stub artifact; the '(0)' heading is real code.
- failure: A bordered card titled 'Agent teams (0) · 0 tasks' sits above the fleet whenever the env flag is on and nothing is running.
- fix: Use `SectionHead label="Agent teams" count={n}` and an `EmptyState posture="nothing-yet"` for the zero case, or render nothing until a team exists.

## 36. [polish/low/small] 10px faint captions sit at the AA floor in light theme
- where: src/renderer/src/styles/fleet.css:123
- evidence: `.fleet-metric > span:last-child { font-size: 10px }` on a `.faint` span (Fleet.tsx:818); light `--text-faint: #706459` on `--bg-sunk: #eee6dc` computes to 4.65:1 (dark: 6.79:1). `.fleet-spark-cap` is also 10px (108).
- failure: '41 requests', '91,000 cached', 'output tok/s' are the smallest, lowest-contrast text on the view, exactly at the threshold.
- fix: Use `--t-micro` (11px) and `--text-dim` for metric subs; keep `--text-faint` for the caption only.

## 37. [polish/low/small] Remembered 'Asking' filter leaves no pressed indicator once the last prompt clears
- where: src/renderer/src/views/Fleet.tsx:552
- evidence: `onSelect={blocked.length ? () => setOnly(…) : undefined}` turns the tile into an inert div while `only` (view memory, 159) may still be 'permission'; the 'Asking' chip disappears (576) and 'All' is unpressed.
- failure: Narrow to Asking, answer the prompt in Sessions, come back: a blank grid, no pressed control anywhere, only the blank-state sentence explains why.
- fix: Keep the tile pressable when `only === 'permission'` (so it can be un-pressed), or reset `only` to 'all' when its count reaches zero.

## 38. [modernize/low/small] Monospace 10.5px meta line is the least scannable element on the card
- where: src/renderer/src/styles/fleet.css:72
- evidence: `.fleet-meta { … font-size: 10.5px; color: var(--text-dim) }` applied with `className="fleet-meta mono"` (Fleet.tsx:681) carrying 'claude-opus-5 · default effort · ◈ project · isolated'.
- failure: Model, effort, trust and worktree read as one grey code string; Cursor/Devin show the model as a quiet pill and settings as icon+word.
- fix: Sans `--t-small`; model as `Pill tone="quiet"`, trust as `Mark`, mono only for the branch name.

## 39. [modernize/low/small] Head chrome: floating 'Sort' label over a segmented control and an 'every 3s' caption
- where: src/renderer/src/views/Fleet.tsx:415
- evidence: `<span className="label">Sort</span><Segmented …/><span className="faint fleet-updated">{updatedAt ? \`updated ${ago(updatedAt)}\` : 'never updated'} · every 3s</span>`; the poll is skipped when hidden (260) and when busy (211), so 'every 3s' is a nominal cadence.
- failure: Three stacked right-aligned fragments; the polling interval is implementation detail nobody acts on.
- fix: 'Sort · Attention ▾' menu button; freshness as a small dot with `title="updated 2s ago"`, turning amber when stalled.

## 40. [modernize/low/small] Hero number carries words, and 'cards' is jargon
- where: src/renderer/src/views/Fleet.tsx:530
- evidence: `<Stat label="Agents" value={\`${num(totals.running)} running\`} sub={\`${num(totals.exited)} exited · ${num(sessions.length)} cards\`}`.
- failure: The `--t-title` value slot renders '2 running' at 20px; 'cards' names the UI, not the fleet.
- fix: value={num(totals.running)} label="Agents running" sub="1 exited · 3 sessions".

## 41. [modernize/low/medium] Sparkline has no time reference and no hover value
- where: src/renderer/src/views/Fleet.tsx:830
- evidence: `Spark` draws 24 buckets stretched over `Math.max(last - first, n * 1000)` (otel.ts) with only 'output tok/s' and 'now · peak' captions; no span, no axis, no tooltip.
- failure: A 16-minute session and a 6-hour one draw identical-looking lines; the operator cannot tell when the peak happened.
- fix: Caption the span ('over 16m') from usage.lastAt − createdAt; add a `<title>` per bucket or a pointer-tracked readout.

