# Sessions view (src/renderer/src/views/Sessions.tsx, src/renderer/src/styles/sessions.css): project rail, session list, tabs, run-config/Codex bars, worktree strip, attachments strip, Recent conversations, side-panel toggle, status bar

39 findings. readability={"firstPaintWords": 0, "fontSizesInSheet": 5, "explainerHintNoteUses": 7, "nestedBorderDepth": 1, "notes": "No prose precedes the first control: the Attention chip button and the rail's project '+' come first (confirmed at Sessions.tsx L563 AttentionQueue, L625-631 group-title). But ~60 words of teaching prose sit in permanent chrome on first paint below the fold-line: the Codex bar sentence (L1342, ~17 words) and the compact Explainer 'How attachments work' (L2081-2085, 43 words), both visible in the screenshots. sessions.css declares font-size five distinct ways: var(--t-micro) x2, var(--t-lead), var(--t-small) x3, 25px (L157), 16px (L209). Note x6 (L707, L1786, L1798, L2071, L2094, L2098), Explainer x1 (L2081), Hint x0. The terminal sits one bordered container deep: .session-main's column bounded by the rail's border-right and the tabbar/statusbar rules; no card wraps it."}

notes: Read-only audit; nothing in the repository was edited. Notes saved at <scratchpad>/research/sessions-view-audit-notes.md. Files read in full: src/renderer/src/views/Sessions.tsx, src/renderer/src/styles/sessions.css, src/renderer/src/components/bits.tsx; cross-checked against src/main/sessions.ts (sessionListEntries, pastSessions, renameSession, setSessionTuning, interruptSession, killSession, closeSession, markRead, exit handler), src/main/index.ts (sessions:* handlers, providers:modelCatalogue, usage:session), src/main/accounts.ts, src/main/attachments.ts, src/main/provider-packs.ts, src/main/otel.ts, src/main/db.ts, src/preload/index.ts, src/shared/types.ts, src/shared/unread.ts, src/shared/launch-fields.ts, src/renderer/src/bindings.ts, src/renderer/src/index.css (session rules, tokens), src/renderer/src/App.tsx (mount, focusSession, palette scope), src/renderer/src/components/TerminalPane.tsx (fit/resize), scripts/renderer-harness.mjs (fixtures), scripts/check-renderer-style.cjs (baselines), src/main/smoke3.ts (Sessions assertions). Screenshot artefacts identified and NOT reported: the worktree bar shows no branch name/path because the stub returns a Proxy for worktrees.status; Recent conversations are absent because the fixture's sessions.past is []. 'Codex Auto · effort Auto' and the duplicate 'platform' tabs are real code paths (fixture s2 has no model; s2/s3 share a project) and are reported. Every CSS custom property used by the view resolves (--s-1/--s-2/--r-sm/--r-md/--ok/--bad/--warning/--critical/--codex/--scrim/--shadow-popover/--plate-red all defined in index.css for both themes); every className used resolves to a rule in index.css, sessions.css, composer.css, ui.css or learning.css, or is a pure hook (.session-status-action, .session-attachments) styled only in the compact block. No TODO/FIXME in either file. Status 'starting' never reaches the renderer list (sessions.set at sessions.ts L1477 runs after status='running' at L1346), so the 'running ? pid : exited' ternaries are safe today. The Codex approval-prompt risk in S20 is reasoned from the unguarded '\\r' write, not verified against the Codex TUI. Smoke3 pins several sentences reported here (S26's '/model also sets your default', the CATALOGUE_MARK block), so fixes to those need the assertion updated in the same change. The 125 inline style objects are already counted by the style gate baseline and were not reported individually.

## 1. [bug/high/small] Forget deletes launch records with no confirmation, against the recorded T2 tier
- where: src/renderer/src/views/Sessions.tsx:767
- evidence: L767-771: `<FocusBtn className="past-x faint" title={`Forget this conversation and all ${p.continuationCount} saved launch record...`} onClick={() => window.wanigan.sessions.forget(p.id).then(...)}>×`. bits.tsx L188-198 records forget as tier T2 ("records or work are lost (forget a conversation, ...) — this component: one inline sentence ... a verb button ... and Cancel"); Git.tsx L578, Control.tsx L561, HeadlessRuns.tsx L616 and Batches.tsx L1316 all use ConfirmNote for their T2 actions. main `sessions:forget` (index.ts L1627) deletes and returns the new list.
- failure: The × sits 2px from the settle/pin buttons in a 12px-tall row; one mis-click permanently deletes N launch records and the exact-resume handle for that conversation, with no undo and no confirm — recorded evidence gone silently.
- fix: Replace the direct call with an inline `<ConfirmNote tone="error" what={`Forget this conversation and its ${n} launch records?`} verb="Forget" .../>` swapped into the row on click, matching Git/Control.

## 2. [bug/medium/small] Recent conversations go stale when a session exits
- where: src/renderer/src/views/Sessions.tsx:384
- evidence: L384 `const offList = window.wanigan.on.sessions((list) => setSessions(list));` is the only push subscription; `refreshPast` (L268-275) is called only from `refresh()` on mount, create, resume, rename and worktree actions. main broadcasts `session:exit` and `session:list` on exit (sessions.ts L1667) and `pastSessions()` (sessions.ts L1763-1767) excludes a conversation only while its execution is non-exited, so the exited conversation belongs in Recent immediately. Fleet.tsx L281 subscribes `on.exit`; Sessions does not.
- failure: An agent finishes and exits; its tab shows 'exited 0' but Recent (and the empty state's 'Resume <project>' button, L929-933) does not list it until the operator launches, renames or leaves and re-enters the view — the operator concludes the conversation was not recorded.
- fix: Subscribe `window.wanigan.on.exit(() => void refreshPast())` in the same effect, or diff the pushed list for a status flip to 'exited' and call `refreshPast()`.

## 3. [bug/medium/small] Tabs for two sessions in one project are the same word
- where: src/renderer/src/views/Sessions.tsx:876
- evidence: L876 `{nameOf(s) || s.projectName}` and L873 `aria-label={`${nameOf(s) || s.projectName}, ${...} session`}`. `nameOf` is `displayTitle ?? ''` (L549). Screenshot (both themes) shows tabs 'storefront', 'platform', 'platform ×' for fixtures s2 (codex) and s3 (claude) — the fixture has no displayTitle so this is the code path, not the stub. The file's own comment (L207-212) acknowledges 'Three agents in one repo were three identical rows'.
- failure: Two or three agents in one repository produce identical tab text and identical accessible names; only a 6px provider-tinted dot separates them, which fails greyscale and VoiceOver. The rail shows the provider on its second line; the tab strip does not.
- fix: Fall back to `${s.projectName} · ${providerLabel}` (and include provider in the aria-label); when two tabs still collide, suffix an ordinal. main already derives `displayTitle` from the launch prompt (sessions.ts L1379) — surface that first.

## 4. [bug/medium/small] Effort slider types a slash command into the agent on every pointer-up, changed or not
- where: src/renderer/src/views/Sessions.tsx:1566
- evidence: L1566 `onPointerUp={() => send('effort', levels[effortIdx])}` and L1567 `onKeyUp` for Arrow keys; `send` (L1508-1522) calls `sessions.setTuning`, which in main writes `/${field} ${value}\r` straight into the PTY (sessions.ts L2058 `writeSession(sessionId, `/${field} ${value}\r`)`). No comparison against `session.effort` or the last sent value.
- failure: Clicking the thumb without moving it, or tapping the track on iPad, injects `/effort high⏎` into a running agent; if the operator had a half-typed prompt in the TUI, the `\r` submits it. Home/End/PageUp keys move the slider without sending at all.
- fix: Keep `lastSent` in a ref; in `send`, return when `value === (lastSent ?? session.effort)`. Send on `onChange` debounce or on any key that changed the value, not just Arrow.

## 5. [bug/medium/small] Multi-account badge only counts claude-code accounts; Codex accounts never show on rows
- where: src/renderer/src/views/Sessions.tsx:233
- evidence: L233 `window.wanigan.accounts.list('claude-code').then((rows) => setMultiAccount(rows.length > 1))` gates the `accountLabel` suffix at L675. accounts.ts L31-34 `HARNESS_CONFIG_ENV = { 'claude-code': ..., codex: 'CODEX_HOME' }` and `supportsAccounts()` L69 — Codex accounts are a first-class feature and `meta.accountLabel` is frozen per session for any harness (sessions.ts L1323). CLAUDE.md: route by declared harness, not hardcoded ids.
- failure: An operator with two Codex accounts and one Claude account sees no account label on any Codex row, so two Codex sessions signed in as different logins are indistinguishable — the exact case the badge exists for.
- fix: Count accounts across the harnesses present in `sessions` (`Promise.all(harnesses.map(h => accounts.list(h)))`) or decide per row: show the label when more than one account exists for that row's `harnessId`.

## 6. [bug/medium/small] Every '×' button in the view is announced as 'multiplication sign'
- where: src/renderer/src/views/Sessions.tsx:767
- evidence: L767-771 forget `×` has `title` only; L1792 and L2105 `<FocusBtn className="past-x faint" title="Dismiss" ...>×`. Accessible-name computation takes name-from-content ('×') before `title`, so the title never becomes the name. The tab-close (L881) and chip-remove (L2135) buttons do carry `aria-label`, so the pattern is known in the file.
- failure: VoiceOver reads 'multiplication sign, button' for the destructive forget control and both dismiss controls; a screen-reader user cannot tell forget from dismiss.
- fix: Add `aria-label={`Forget ${p.title ?? p.projectName}`}` and `aria-label="Dismiss"` respectively.

## 7. [bug/medium/small] Every visit first paints the compact one-column layout, then snaps to the real one
- where: src/renderer/src/views/Sessions.tsx:204
- evidence: L203-204 `useState(true)` for both `compactLayout` and `sessionPickerCompact`; the measurement is a `useEffect` (L302-321) which runs after paint. sessions.css L83-88 `.sessions--compact-picker { grid-template-columns: minmax(0, 1fr) }` and L96-106 translate the rail off-screen. TerminalPane's ResizeObserver (TerminalPane.tsx L288-298) refits and calls `sessions.resize` on each host size change. App.tsx unmounts Sessions on every tab change (comment at L235-236), so this happens on every return to the view.
- failure: Each switch back to Sessions: the rail pops in a frame late and the PTY receives two resizes (full-width then rail-width), redrawing the TUI twice; on a 1440px window the code rail also blinks. The comment says starting collapsed avoids flashing two rails, but it trades that for flashing zero.
- fix: Run the first `measure()` in `useLayoutEffect` (before paint), and/or seed the two flags from the last measurement kept in a module-level ref so a remount starts at the right answer.

## 8. [honesty/medium/small] Codex bar prints 'Auto' for a model and effort Wanigan never read
- where: src/renderer/src/views/Sessions.tsx:1333
- evidence: L1333 `{session.model || 'Auto'} · effort {session.effort || 'Auto'}`. `Session.model` is `opts.model || undefined` (sessions.ts L1268) — absent means no --model was passed. The sibling RunConfigBar renders the same absence as `<option value="">CLI default</option>` (L1545) and a `◦ CLI default` Mark (L1578-1579) with the sentence 'Wanigan does not read what that default is' (types.ts L235). Screenshot shows 'Codex Auto · effort Auto' for fixture s2 which has no model — code, not stub.
- failure: An operator reads 'Auto' as an observed setting; Codex's actual default comes from its config.toml and is not 'Auto'. Contradicts CLAUDE.md 'do not present an estimate or a guess as observed fact' and the bar four lines below it.
- fix: Render the same `Mark glyph="◦" word="CLI default"` used by RunConfigBar for an absent model/effort; only print a value main recorded.

## 9. [honesty/medium/small] 'End session' tooltip claims the conversation is lost; it is resumable from Recent
- where: src/renderer/src/views/Sessions.tsx:1079
- evidence: L1079 `title="End the session entirely. The conversation goes with it."` → `sessions.kill`. main `killSession` (sessions.ts L2136-2143) only calls `proc.kill()`; the exit handler writes `ended_at`/`exit_code` (L1600-1604) and keeps `conversation_id`, and `pastSessions()` (L1763-1767) offers every exited lineage as an exact resume.
- failure: Operators avoid ending runaway sessions because the UI tells them the conversation will be destroyed; in fact it appears in Recent with a ↻ resume button seconds later.
- fix: Title: 'End the session. The conversation stays in Recent and can be resumed.'

## 10. [honesty/medium/small] Model select shows 'CLI default' for a running model that is not in the catalogue
- where: src/renderer/src/views/Sessions.tsx:1545
- evidence: L1538-1550: controlled `<select value={model}>` whose options are `<option value="">CLI default</option>` plus `shown.rows`. When no option matches, React's ReactDOMSelect selects the first non-disabled option, i.e. 'CLI default'. `LaunchOptions.model` accepts 'a full id' (types.ts L233); main records observed switches via `recordObservedModel` accepting any `MODEL_ID` (sessions.ts L2085-2098, L2041); the published catalogue is aliases plus observed rows (launch-choices.ts L243-257) and a `declared` pack list is whatever the manifest wrote.
- failure: A session launched with `claude-opus-4-1-20250805`, or one the CLI moved to a fallback model (PostModelSwitch), shows the picker at 'CLI default' — the opposite of the bar's stated purpose.
- fix: When `model && !shown.rows.some(r => r.value === model)`, prepend `<option value={model}>{model} (as running)</option>`; keep the Mark's provenance word.

## 11. [honesty/medium/medium] RunConfigBar treats every non-Codex harness as Claude Code and types /model and /effort into it
- where: src/renderer/src/views/Sessions.tsx:1295
- evidence: L1295-1296 `const tunable = harness !== 'codex' && session.status === 'running' && (launched?.supports.model === true || launched?.supports.effort === true)`. provider-packs.ts L640-643 accepts `harness` of 'claude-code' | 'codex' | 'generic-cli'; main's `setSessionTuning` (sessions.ts L2057) refuses only `harnessId === 'codex'` and then writes `/${field} ${value}\r` to the PTY. L1593-1594 promises '/model also sets your default for new sessions'. CLAUDE.md: 'Route behavior by declared harness ... do not imply that a provider supports ... until Wanigan has verified support end to end.'
- failure: A generic-cli pack profile that declares supports.model/effort (its manifest's launch fields) gets a Model select and an Effort slider that type Claude Code slash commands into a CLI that may treat them as a prompt, under a sentence claiming Claude-specific persistence behaviour.
- fix: Gate `tunable` on `harness === 'claude-code'` in the renderer and mirror the check in `setSessionTuning`; for other harnesses render an honest 'This profile declares a model field, but Wanigan has no verified way to change it on a running <harness> session.'

## 12. [missing/medium/small] Session rows and status bar show a pid instead of elapsed time or last activity
- where: src/renderer/src/views/Sessions.tsx:664
- evidence: L664 `{s.status === 'running' ? `pid ${s.pid}` : `exited ${s.exitCode}`}` and L1054-1056 in the status bar. `Session` carries `createdAt` and `endedAt` (types.ts L196-197) — `grep createdAt Sessions.tsx` returns nothing. main stamps output activity every second for the attention queue (OUTPUT_NOTE_MS, sessions.ts ~L515) and Recent rows already print `ago(p.startedAt)` (L744). Screenshot: 'pid 4021', 'pid 4088', 'exited 0'.
- failure: An operator scanning nine agents cannot see which has been running 3 hours or which exited 2 minutes ago without opening Fleet; the pid is a debugger's number nobody acts on from this rail.
- fix: Second line: `running · ${dur(now - createdAt)}` / `exited ${code} · ${ago(endedAt)}`; keep the pid in the row's `title`. Reuse `dur`/`ago` from bits.

## 13. [missing/medium/medium] No observed spend or tokens for the active session on this surface
- where: src/renderer/src/views/Sessions.tsx:1051
- evidence: Status bar L1051-1082 renders path, pid and four text buttons. main records `session_api_events` with `cost_usd`, `in_tokens`, `out_tokens` per session (db.ts L236-250), exposes `usage:session` (index.ts L1773, preload L202 `usage.session`) with a `costStatus: 'reported' | 'unavailable'` (types.ts L443-451), and Fleet.tsx L218 already reads `usage.many` for its cards. Sessions.tsx never calls the usage namespace.
- failure: The view the operator spends the day in cannot answer 'what has this session cost so far'; they must switch to Fleet, which unmounts the terminal.
- fix: Read `usage.session(active.id)` on select and on `session:event`, render `$0.42 reported · 12.1k in / 3.4k out` in the status bar, and 'cost not reported' when `costStatus === 'unavailable'`.

## 14. [modernize/medium/medium] One coral accent carries selection, notification, CTA, readout and decoration on this screen
- where: src/renderer/src/views/Sessions.tsx:683
- evidence: L683 unread pill `background: 'var(--accent-soft)', color: 'var(--accent)'`; index.css L780-783 `.session-item.active { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--plate-red) }`; L1335 Codex 'Change model & effort…' as `btn-primary`; L1065 'teach Wanigan' in accent; L1575 effort readout in accent; L733 pinned star; L972 drop overlay; sessions.css L27-29 picker count pill. Screenshot: coral on New session, the attention card border, nav selection, badge '3', the selected row, the Codex CTA, the cursor and 'teach Wanigan' at once.
- failure: Nothing on the screen is visually primary: the selected row, an unread count and a secondary Codex control all shout at the same volume, so the eye has no path.
- fix: Selection: neutral raised ground (`--bg-selected`) with a 2px `--text` rule; counts: `pill tone-quiet`; Codex 'Change model' as `.btn`; keep accent for the one primary action (New session) and the attention chip, as Linear/Cursor do.

## 15. [modernize/medium/medium] Six always-visible icon buttons per two rail rows; row actions should reveal on hover/focus or fold into a menu
- where: src/renderer/src/views/Sessions.tsx:690
- evidence: L690-694 a ✎ button on every live row (screenshot shows three pencils); L750-771 ★/☆, ⤓/⤒ and × on every Recent row, all `.past-x` at `--t-lead` (index.css L985). None is hover-revealed; on a 184px rail (index.css L630) three of them take ~60px of the row.
- failure: The rail reads as a toolbar per row rather than a list; the destructive × sits permanently beside the resume target. Raycast/Linear show row actions on hover/focus-within and put the rest under ⋯ with keyboard access.
- fix: `.past-row .past-x { opacity: 0 } .past-row:hover .past-x, .past-row:focus-within .past-x { opacity: 1 }` (still focusable), or a single ⋯ menu per row with Pin / Archive / Forget… items.

## 16. [bug/low/small] ⌘⌫ closes the tab while the operator is deleting text in the rename field
- where: src/renderer/src/views/Sessions.tsx:453
- evidence: L447-456: the handler returns only for `el?.closest('.terminal-host')` or an open dialog, then `if (e.key === 'Backspace' && activeRef.current) { ... if (s?.status === 'exited') { e.preventDefault(); void closeTab(s.id); } }`. The rename `<input className="field">` (L636-646) is inside the rail with no guard; `inField()` exists in bindings.ts L108.
- failure: Renaming a session while the active tab is an exited one: ⌘⌫ (macOS delete-to-line-start) closes the exited tab and shifts the active session instead of editing the name.
- fix: Add `if (inField(el)) return;` at the top of the handler alongside the terminal guard.

## 17. [bug/low/small] closeTab runs a parent callback inside a setState updater
- where: src/renderer/src/views/Sessions.tsx:420
- evidence: L416-423 `setSessions((prev) => { const next = prev.filter(...); if (activeRef.current === id && next[next.length - 1]) { onActiveChange(...); } return next; })`. main.tsx L8 wraps the app in `<React.StrictMode>`, which double-invokes updater functions in development; updaters must be pure.
- failure: In dev the parent's `focusSession` (App.tsx L594-598) fires twice per close; in production it is fragile against React batching and reads as a side effect nobody expects in an updater.
- fix: Compute `next` from `sessionsRef.current`, call `onActiveChange` outside, then `setSessions(next)`.

## 18. [bug/low/small] Resume is enabled for a conversation whose project has been removed from Wanigan
- where: src/renderer/src/views/Sessions.tsx:725
- evidence: L725 `disabled={!p.live || resuming !== null}` where `live` is `fs.existsSync(project_path)` (sessions.ts L1826); L355 passes `projectId: p.projectId ?? ''`; main `createSession` throws 'Project not found — it may have been removed.' (sessions.ts L924-925). `PastSession.projectId` is nullable (types.ts L294).
- failure: The row reads 'Resume this exact conversation in /path' and the click produces an error toast instead; nothing tells the operator to re-add the folder.
- fix: Disable when `p.projectId === null || !projects.some(x => x.id === p.projectId)` with title 'Add this folder back as a project to resume it', or offer 'Add project' inline.

## 19. [bug/low/small] Effort slider silently shows 'high' for a recorded effort not on the frozen scale
- where: src/renderer/src/views/Sessions.tsx:1496
- evidence: L1496-1499 `const i = levels.indexOf(session.effort ?? ''); return i >= 0 ? i : Math.max(0, Math.min(2, levels.length - 1));` and L1575 prints `levels[effortIdx]` in accent; the honest Mark at L1577-1579 fires only on `!session.effort`.
- failure: A session whose row carries an effort the profile's declared scale does not list (older row, pack scale changed) reads 'high' in accent with no qualifier — a value Wanigan invented.
- fix: When `indexOf < 0 && session.effort`, render a `Mark tone="warn" word="not on this scale"` naming `session.effort` and leave the slider unpressed.

## 20. [bug/low/small] Worktree marker on a session row is a bare glyph with a tooltip
- where: src/renderer/src/views/Sessions.tsx:660
- evidence: L660 `{s.worktree && <span className="faint" title="Runs in its own git worktree"> ⑂</span>}`; the tab strip (L868-884) carries no worktree indication at all. bits.tsx's own rule: 'Always drawn beside a word — an icon alone is a guess'.
- failure: Screen readers announce '⑂'; touch has no tooltip; the tab for a worktree session looks identical to one editing the repo directly, which is the difference that decides whether Merge/Discard apply.
- fix: `<span className="sr-only">in worktree</span>` beside the glyph (or `Mark glyph="⑂" word="worktree" tone="quiet"`), and the same mark on the tab.

## 21. [bug/low/small] Codex 'Change model' / 'Plan' send Enter with no regard for a pending approval prompt
- where: src/renderer/src/views/Sessions.tsx:1318
- evidence: L1318-1324 `window.wanigan.sessions.write(session.id, `${command}\r`)` with no state check; main `writeSession` (sessions.ts L2001-2015) has no guard either, while main does track `providerAwaitingApproval` for Codex (sessions.ts L2127). The buttons are enabled whenever `session.status === 'running'` (L1301).
- failure: With a Codex approval prompt on screen, the typed characters are ignored by the picker and the trailing `\r` can select the highlighted option — plausibly approving a command the operator meant to read first. (Not verified against the Codex TUI; the risk is the unguarded `\r`.)
- fix: Disable both buttons (title: 'Answer the approval prompt first') while the attention queue reports `permission` for this session, and have main refuse `sessions:write` of a bare slash command while `providerAwaitingApproval`.

## 22. [honesty/low/small] Attachment cost sum counts unpriced images as $0
- where: src/renderer/src/views/Sessions.tsx:2035
- evidence: L2035 `const priced = images.reduce((n, a) => n + (att.cost[a.id] ?? 0), 0);` rendered at L2044 as `≈ {usd(priced)} when read`. attachments.ts L800-806 returns `estimatedUsd: null` when no published rate exists ('No published rate means no price — null, not a figure borrowed'), and `useAttachments` also stores null on an inspect failure (L1857).
- failure: Three images, one unpriced: the strip says '≈ $0.02 when read' as if it were the total, the exact rounding-up the main process refused to do.
- fix: Track `unpriced = images.filter(a => att.cost[a.id] === null).length` and render '≈ $0.02 + 1 unpriced' or omit the sum while any is null.

## 23. [honesty/low/small] Interrupt tooltip names Claude Code on every harness
- where: src/renderer/src/views/Sessions.tsx:1072
- evidence: L1072 `title="Stop the current turn. The session stays open — this is the Escape key Claude Code listens for. ⌘."` rendered for any running session; `interruptSession` (sessions.ts L2121-2131) writes `\x1b` to every harness and has a Codex-specific branch.
- failure: On a Codex or generic-cli session the tooltip attributes the behaviour to a different product; the operator cannot tell whether Escape means anything to the agent they are looking at.
- fix: 'Sends Escape to the agent — the key Claude Code and Codex use to stop a turn. The session stays open. ⌘.' or branch the sentence on `harnessId`.

## 24. [honesty/low/small] '/model also sets your default for new sessions' is an unobserved claim about the CLI
- where: src/renderer/src/views/Sessions.tsx:1593
- evidence: L1593-1594 `Typed into the session as a slash command. /model also sets your default for new sessions.` Wanigan's own write path `setSessionTuning` (sessions.ts L2050-2068) updates only this session's `session_log` row and meta; the 'default for new sessions' is the CLI's own persistence, which Wanigan neither triggers nor reads back, and the New session dialog reads its defaults from Wanigan's settings, not from the CLI. smoke3.ts L5114 pins the sentence.
- failure: An operator changes model here, opens New session, and sees Wanigan's own default unchanged — the sentence promised something this app does not do.
- fix: Drop the second sentence, or make it true: have `setSessionTuning` also write Wanigan's launch default and say 'Wanigan will offer this model for new sessions'.

## 25. [unfinished/low/small] Side-panel toggle prints the raw pane id as its label
- where: src/renderer/src/views/Sessions.tsx:891
- evidence: L891 `{compactLayout ? 'terminal full width' : railOpen ? '⟨ hide' : `${pane} ⟩`}` where `pane` is 'code' | 'timeline' | 'learning' (L1250). Screenshot top-right of the tab strip reads 'code ⟩'. bits.tsx ships `Icon name="panel"` (L505) for exactly this control.
- failure: A lowercase identifier with a chevron floats at the strip's right edge; it reads as a stray word rather than 'open the side panel', and its text changes with state so muscle memory never lands.
- fix: `<Icon name="panel" /> Panel` with `aria-pressed={railOpen}` and the current pane plus ⌘B in the title; 'terminal full width' becomes a disabled title, not a label.

## 26. [unfinished/low/small] Status-bar cheat sheet omits ⌘E and ⌘. and misses the composer
- where: src/renderer/src/views/Sessions.tsx:1083
- evidence: L1083 `<span>⌘T new session · ⌥⌘←→ switch · ⌘⌫ close · ⌘B side panel</span>`; bindings.ts L56-72 lists 'composer' ⌘E and 'interrupt' ⌘. in the same 'Sessions view' group, and the shell's cheat sheet derives from that table.
- failure: The one place the view teaches its chords leaves out the two most used while an agent runs; the list is hand-typed and will drift from bindings.ts again.
- fix: Render from `BINDINGS.filter(b => b.group === 'Sessions view')` so the strip and the sheet are one record.

## 27. [missing/low/medium] Recent conversations cannot be searched or filtered anywhere
- where: src/renderer/src/views/Sessions.tsx:776
- evidence: Recent renders up to `PAST_ACTIVE_CAP` (40, L112) unsettled rows plus pins plus a 40-row settled shelf, paged by 'Show 8 more' (L785-789, L807-811), in a `clamp(184px, 22%, 248px)` column (index.css L630). App.tsx L934-938: the ⌘K palette indexes live sessions only ('an exited session is a record').
- failure: Finding the budgeting thread from three weeks ago means paging 8 rows at a time through a 200px rail; the palette will not find it.
- fix: A `field-inline` filter at the head of Recent matching title/project/model, or add Recent rows to the palette under their own group.

## 28. [missing/low/small] Merge is offered when the worktree has nothing to merge
- where: src/renderer/src/views/Sessions.tsx:1732
- evidence: L1732 `disabled={busy !== null || !branch}` while L1723-1727 prints 'nothing uncommitted · no commits yet' for `info.dirty === 0 && info.ahead === 0` (both fields on `WorktreeInfo`, types.ts L926-927). Screenshot shows 'nothing uncommitted · no commits yet' beside an enabled Merge.
- failure: Clicking Merge on an empty branch round-trips to git and returns a refusal Note; the enabled button implies work is waiting to be merged.
- fix: Disable when `info.ahead === 0` with title 'No commits on this branch yet'; keep enabled for dirty>0 so the refusal can explain committing first.

## 29. [polish/low/small] Loading, error and empty states are hand-rolled instead of Reading/EmptyState
- where: src/renderer/src/views/Sessions.tsx:902
- evidence: L900-903 `<div className="empty"><p className="dim">Reading the session list…</p></div>`; L905-914 and L918-923 `<h1 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>` inside `.empty`. bits.tsx exports `Reading` (L317) and `EmptyState` with 'nothing-yet' / 'could-not-read' postures (L297-311), which CLAUDE.md names as the composition set for views.
- failure: Three postures with three different typographic treatments from the rest of the app (no glyph, h1 at title size where EmptyState uses h2), and the retry layout differs from Git/Control.
- fix: `<Reading what="the session list" />`, `<EmptyState posture="could-not-read" title="The session list did not load" cue={listErr} action={Retry} />`, `<EmptyState posture="nothing-yet" title="No sessions running" .../>`.

## 30. [polish/low/small] Worktree discard confirm and trust banner re-implement ConfirmNote and Note inline
- where: src/renderer/src/views/Sessions.tsx:1755
- evidence: L1755-1783 a hand-built warning-soft block with 'Keep it' / 'Delete it and lose the changes' buttons; L1609-1625 `TrustBanner` is a `role="status"` div with inline warning colours. bits.tsx `ConfirmNote` (L200-215) is the recorded T2 shape ('discard changes' is named in its comment) and `Note tone="warn"` is the banner shape; a Note that mounts already filled with role=status is not announced (bits.tsx L157-160).
- failure: Two more one-off warning treatments (padding, radius, weight) beside the shared ones on the same screen; the trust banner's role never announces.
- fix: `<ConfirmNote tone="error" what={…} verb={confirm.dirty > 0 ? 'Delete it and lose the changes' : 'Delete the worktree'} busy={busy==='discard'} .../>`; `<Note tone="warn" role="none">` for the persistent banner.

## 31. [polish/low/small] Side-panel tabs are a hand-rolled segmented control without arrow-key navigation
- where: src/renderer/src/views/Sessions.tsx:1237
- evidence: L1237-1246 `Seg` renders `.code-tab` buttons with `aria-pressed` inside a `role="group"` (L1012); bits.tsx `Segmented` (L372-400) provides the same aria-pressed model plus roving tabindex, ArrowLeft/Right, Home/End.
- failure: Tab stops on all three buttons and no arrow movement, unlike every other segmented control in the app.
- fix: `<Segmented label="Side panel" value={pane} onChange={(v) => setPane(active.id, v)} options={[{value:'code',label:'Code',title:…},…]} />`.

## 32. [polish/low/small] Local size() duplicates the exported bits.size() with different rounding
- where: src/renderer/src/views/Sessions.tsx:131
- evidence: L129-136 `function size(n: number): string { … toFixed(n < 10 * KB ? 1 : 0) … }`; bits.tsx L437-445 exports `size(bytes)` with the same signature and a KB…TB ladder. `num` and `usd` are already imported from bits on L19.
- failure: An attachment chip and the Usage view can print the same byte count differently.
- fix: Delete the local helper and import `size` from bits.

## 33. [polish/low/small] Rail group headers are inline-styled spans rather than SectionHead, and carry jargon
- where: src/renderer/src/views/Sessions.tsx:626
- evidence: L625-632 `<div className="group-title"><span style={{ fontWeight: 600, fontSize: 'var(--t-small)' }}>{p.name}</span>…`; L777-780 Recent header `<span className="label">Recent conversations</span><span className="faint" …>exact resume</span>`. bits.tsx `SectionHead` (L341-349) is the recorded head with a count slot and a right slot.
- failure: Project headers and the Recent header use two different type treatments; 'exact resume' is an engineering term shown to the operator with no verb.
- fix: `<SectionHead label={p.name} count={list.length} right={branch + '+' button} />`; replace 'exact resume' with nothing (the row's ↻ title already explains) or 'resumable'.

## 34. [polish/low/small] Operator-facing labels use engineering vocabulary
- where: src/renderer/src/views/Sessions.tsx:2061
- evidence: L2061 button 'Name again' with title 'Attaching already names these files in your prompt. Use this to name them again — after clearing the input, say.'; L833 'Recover exact Codex UUID…'; L760-763 'Settle' / 'Un-settle'; L779 'exact resume'. Screenshot confirms 'Name again' and 'Recover exact Codex UUID…' on first paint.
- failure: A newcomer cannot guess what 'Name again' does to a file or what 'settle' does to a conversation without reading a tooltip; touch has no tooltip.
- fix: 'Insert path again' / 'Re-add to prompt'; 'Resume a Codex thread by id…'; 'Archive' / 'Unarchive' (the shelf is an archive by behaviour).

## 35. [polish/low/small] sessions.css spells two literal font sizes and three !important overrides
- where: src/renderer/src/styles/sessions.css:157
- evidence: L157 `font-size: 25px;` (.session-picker-close), L209 `font-size: 16px;` (.session-picker-glyph); L254 `align-items: flex-start !important;`, L256 `gap: 7px !important;`, L261 `margin-left: 0 !important;` to beat the inline styles in AttachStrip (Sessions.tsx L2025-2050). CLAUDE.md: a surface sheet 'spells no font size … as a literal'; the gate baseline holds sessions.css at 2 (check-renderer-style.cjs L110).
- failure: The close glyph and the ☰ ignore the type scale, and the attachment strip's compact layout depends on !important winning over inline styles — the first refactor of AttachStrip breaks the iPad layout silently.
- fix: `font-size: var(--t-title)` / `var(--t-lead)`; move AttachStrip's layout to `.session-attachments-head` rules in the sheet so the compact block needs no !important.

## 36. [polish/low/small] Recent row's timestamp is the start time but reads as recency
- where: src/renderer/src/views/Sessions.tsx:744
- evidence: L744 `{' · '}{ago(p.startedAt)}` appended after provider · model · effort · launches; `PastSession` also carries `endedAt` (types.ts L302).
- failure: '· 4h ago' on a conversation resumed 20 minutes ago says when it was first started; the operator sorting by 'what did I touch last' is misled.
- fix: Show `ago(p.endedAt ?? p.startedAt)` with a title 'last ended …', or label it 'started 4h ago'.

## 37. [modernize/low/medium] Three stacked bands under the terminal: attachments strip, composer, status bar
- where: src/renderer/src/views/Sessions.tsx:2025
- evidence: AttachStrip L2025-2110 renders a labelled band with two buttons and a 43-word Explainer even when nothing is staged (screenshot: ~100px band 'Attachments none staged … + Add files / Name again'), above the Composer (L985-996) and the status bar (L1051-1084).
- failure: The terminal loses ~180px of height to chrome that is empty most of the day; the operator's eye crosses three horizontal rules to reach the prompt.
- fix: Fold '+ Add files' and staged chips into the composer's leading slot (Cursor/T3 pattern) and render the strip only when `att.items.length > 0 || att.rejects.length > 0`; move the explainer to the first-attach moment.

## 38. [modernize/low/small] Controls are typographic glyphs where the shared Icon set exists
- where: src/renderer/src/views/Sessions.tsx:887
- evidence: L887 `+<span> New</span>`, L862 `☰`, L891 `⟨ hide` / `⟩`, L747 `↻`, L1067 `◇ teach Wanigan`, L1075 `⎋ interrupt`, L694 `✎`, L770 `×`. bits.tsx `Icon` (L487-525) ships plus, panel, chevron, x and 'is always drawn beside a word'.
- failure: Mixed Unicode weights and baselines (☰ vs ⟩ vs ✎) render at different optical sizes per font fallback, so the strip reads as a terminal UI rather than an app; Devin/Conductor use one stroke-weight icon set.
- fix: `<Icon name="plus" /> New`, `<Icon name="panel" /> Panel`, `<Icon name="x" />` with aria-labels; keep text glyphs only for status marks.

## 39. [modernize/low/small] A Tamagotchi occupies the bottom of the primary work rail
- where: src/renderer/src/views/Sessions.tsx:841
- evidence: L838-841 `{/* Lives below the fold of the rail … */} <Pet />` inside `<aside className="session-rail">`; Pet.tsx L1-30 describes an emulated P1 with care windows and evolution; pet.css carries 10 literal font sizes (check-renderer-style.cjs L104).
- failure: On a short window the pet competes with Recent for rail height and draws attention below the session list; Linear/Devin keep the work rail to work. This is a deliberate mascot, so the question is placement, not existence.
- fix: Move it to a collapsible dock or the empty state, remembered per machine like the composer (`wanigan.pet` flag), and out of the `aria-hidden` compact rail.

