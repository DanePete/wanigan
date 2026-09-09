# Plugins view (src/renderer/src/views/Plugins.tsx, src/main/plugins.ts, src/renderer/src/styles/queue.css)

42 findings. readability={"firstPaintWords": 121, "fontSizesInSheet": 9, "explainerHintNoteUses": 10, "nestedBorderDepth": 1, "notes": "firstPaintWords: in the screenshot state (0 installed) the explanatory prose before the first data row is the Explainer title (4) + body (96) + the empty-installed sentence (21) = 121; counting the head text (11) and stat captions (17) gives 149. On a populated machine the prose before the first card is 198 (head 11, explainer 100, catalog Note 24, stat captions 17, enabled-state Note 46). The prior 412-word figure is not reproducible from the current TSX; it likely included per-card sentences. Strictly the first interactive control is Rescan in the head, preceded by 11 words. fontSizesInSheet: queue.css declares 8 distinct literal px sizes (9.5, 10, 10.5, 11, 11.5, 12, 13, 15) across 15 declarations (the gate baseline) plus var(--t-micro) \u2014 9 distinct declarations, 8 distinct rendered sizes. explainerHintNoteUses: 1 Explainer + 0 Hint + 9 Note. nestedBorderDepth: installed cards (.pg-card, bordered) sit directly in .pane, which has no border \u2014 depth 1; catalog rows sit in one bordered .pg-cat grid \u2014 depth 1."}

notes: Read-only audit; nothing in the repository was touched. Verified against: Plugins.tsx, plugins.ts, queue.css, compact.css, index.css, ui.css, bits.tsx, useDialog.ts, preload/index.ts, main/index.ts (validators and handlers), context/config.ts, skills.ts, Skills.tsx, smoke3.ts, check-renderer-style.cjs, and the live ~/.claude/plugins tree plus ~/.claude/settings.json on this machine (read-only). The Claude Code 2.1.263 binary strings confirm `plugin details` prints 'Always-on:   ~N tok' via toLocaleString, that `plugin list --json --available` rows carry pluginId/name/description/version/updatedAt/marketplace_name, that `marketplace remove <name>` exists, and that plugin-catalog-cache.json is the CLI's own cache. Screenshot notes: both PNGs are stub output — the renderer harness has no plugins fixture, so every zero, '0 marketplaces' and the empty 'Where this comes from' table (real code always emits three root rows, plugins.ts:363-367) are stub artifacts, not product defects; no finding here rests on the screenshot alone. Contrast: every faint/dim/good/warning pair used at small sizes measures ≥4.65:1 in both palettes, so no colour-contrast finding; the issue is size (PL-21), not ratio. .pg-head (line 210) confirmed matching no rule in any sheet; smoke3.ts:4896 asserts the rule's absence, so the fix is to drop the class from the TSX (PL-17). Not reported: inline style objects (ratchet), and the Sep 7 commit's aria-label additions which are present and correct.

## 1. [bug/high/small] A failed CLI catalog call is stored as an answered, empty catalog: cards then claim "The CLI answered" and the disk fallback disappears
- where: src/renderer/src/views/Plugins.tsx:148
- evidence: Line 148: setCat(r.plugins as CatalogItem[]); src/main/plugins.ts:533 returns { plugins: [], note: avail.error } when the CLI is missing or fails and :544-547 does the same for an unrecognised shape. Line 201: const askFailed = !cat && catNote !== null; — `[]` is truthy so askFailed is false. Line 280: {st.installed.length > 0 && !cat && (…Ask the CLI…)} hides the retry. enablementOf(id, []) returns 'unlisted' whose blurb (101-105) says 'The CLI answered and its catalog has no entry with this id, usually because the marketplace it came from was removed.' Line 176: const rows = cat ?? (st?.available ?? []) drops the 54 disk rows, and 512 prints 'Nothing in the catalog matches “”'.
- failure: With Claude Code not on PATH (or an older/newer CLI JSON shape) every card says the CLI answered and does not know the plugin, the retry button vanishes, and the catalog section shows a search-miss message for an empty query while the disk scan had 54 rows a second earlier. The warn Note with the real reason appears only inside the collapsed catalog.
- fix: Return an explicit ok flag from catalog() and in loadCatalog set cat only when ok (setCat(r.note ? null : r.plugins)); treat empty CLI output (pluginRows returning [] for null output, plugins.ts:519) as a note too. Keep the disk rows when cat is null and branch the empty message on q.

## 2. [honesty/high/medium] "Nothing on disk records whether Claude Code has this switched on" is false; settings.json records it and Wanigan's own Context module reads it
- where: src/renderer/src/views/Plugins.tsx:85
- evidence: Line 85: blurb: 'Nothing on disk records whether Claude Code has this switched on — installed_plugins.json and the plugin folder note the installation and stop there.' Line 299: <strong>Enabled state is not recorded on disk.</strong>. src/main/plugins.ts readPlugins() (272-373) reads installed_plugins.json, marketplaces/ and known_marketplaces.json only. But ~/.claude/settings.json on this machine carries "enabledPlugins": { "claude-security@claude-plugins-official": false, "github@claude-plugins-official": true, … } and src/main/context/config.ts:494-501 function enabledPlugins(layers) already reads `l.read.value?.enabledPlugins` from every settings layer.
- failure: On every visit every installed card wears "? enabled state not read", a 46-word plumbing Note sits above the list, and the only primary button on the page ("Ask the CLI which are enabled") shells out to `claude plugin list` twice with a 90 s worst case — to learn a fact one JSON read would answer. Today claude-security is recorded as disabled and Wanigan shows it as unread; the Hooks stat (266-268) also counts hooks from plugins settings marks off, which is the opposite of what Context does with the same file.
- fix: In readPlugins() read enabledPlugins from the user/project/local settings layers (reuse context/config.ts's reader), derive 'on'/'off' per id, and keep the CLI call as a confirmation/refresh rather than the only source. Delete the "not recorded on disk" Note and the unread blurb; reword to "from settings.json" and show the layer.

## 3. [bug/medium/small] Cost button does nothing visible when the details call fails
- where: src/renderer/src/views/Plugins.tsx:165
- evidence: Lines 165-172: const d = await window.wanigan.plugins.details(name); setCost(… d.alwaysOnTokens); if (d.text) setReading(…). src/main/plugins.ts:574 returns { text: '', alwaysOnTokens: null, error: r.error } on failure; d.error is never read.
- failure: With Claude Code not found, or `claude plugin details` erroring, clicking Cost changes nothing on screen and the CLI's error text is discarded.
- fix: Render d.error in the card's result Note (setResult({ id, ok: false, text: d.error })).

## 4. [bug/medium/small] A failed README/SKILL.md open or Cost call raises the page banner that says the scan is stale and offers Rescan
- where: src/renderer/src/views/Plugins.tsx:228
- evidence: Line 228: {err} What is listed below is the last scan that succeeded, not the state on disk now. with action Rescan (225-227). read() at 135-141 and showCost() at 171 both catch into setErr(...).
- failure: Opening a symlinked or removed document produces 'Wanigan will not follow a plugin document… What is listed below is the last scan that succeeded' — a true list is called stale and the offered remedy (Rescan) is unrelated to the failure.
- fix: Keep a separate fileErr state rendered beside the item/reader, or pass a plain error Note without the scan sentence for those paths.

## 5. [bug/medium/small] Concurrent plugin actions race: other cards stay enabled, one result slot, and the first finally clears the second's working state
- where: src/renderer/src/views/Plugins.tsx:154
- evidence: act() 154-163 uses a single `working` id and single `result`; finally { setWorking(null); setConfirming(null); }. Disable/Enable are disabled only when working === p.id (419, 428); Cost (437) and Readme are never disabled; marketplace buttons use !!working.
- failure: Disable on card A then Enable on card B runs two `claude plugin` processes that both rewrite installed_plugins.json/settings.json; A's completion sets working to null so B's 'working…' vanishes mid-run, and B's result overwrites A's.
- fix: Disable every mutating button while working !== null (or hold a Set of ids and per-id results) and serialise calls in main.

## 6. [bug/medium/small] Keyboard focus is dropped after Disable, Enable or Install because the pressed button unmounts
- where: src/renderer/src/views/Plugins.tsx:417
- evidence: {state !== 'off' && (<button …Disable)} (417) and {state !== 'on' && (<button …Enable)} (425) unmount after act() reloads the catalog; the catalog Install button (522-524) becomes a <span className="pg-yes"> (520); the confirm's primary button (502) is removed by setConfirming(null) in finally (162). No focus management exists.
- failure: A keyboard or VoiceOver user presses Enable; the answer arrives and focus lands on document.body, so the next Tab starts from the top of the window and the result Note is only announced, never reached.
- fix: Keep both actions mounted and reflect state with aria-pressed/disabled, or move focus to the result Note / the card article after act() resolves.

## 7. [honesty/medium/small] Explainer promises plugin cost "is in Context (⌘⇧C)"; Context records plugin hooks, never a cost
- where: src/renderer/src/views/Plugins.tsx:242
- evidence: Line 242-243: 'What an enabled plugin costs a session is in Context (⌘⇧C)'. src/main/context/config.ts:527-552 pluginHooks() reads hooks.json and counts agents/commands per enabled plugin; grep for always-on/tokens/cost across src/main/context/*.ts and Context.tsx returns nothing plugin-related; Context.tsx mentions plugin only as a settings layer (200-205).
- failure: An operator follows the chord to Context looking for the token cost of a plugin and finds a hooks list; the only cost surface is the Cost button on this page, which the sentence does not mention.
- fix: Delete the clause or replace it with 'Cost on a card asks the CLI for its always-on estimate'.

## 8. [honesty/medium/medium] Explainer says a plugin's skills are listed in Skills; Skills scans the marketplace clone, so an installed plugin can be absent and 45 uninstalled ones are shown as "installed by a plugin"
- where: src/renderer/src/views/Plugins.tsx:243
- evidence: Line 243: 'the skills it ships are listed in Skills (⌘⇧S)'. src/main/skills.ts:382-397 scanPlugins() walks path.join(pluginRoot, 'marketplaces')/<mkt>/{plugins,external_plugins}/*/skills — never installed_plugins.json or cache/. Skills.tsx:57 labels that source 'installed by a plugin'. On this machine mattpocock-skills is installed (installed_plugins.json) but has no directory under marketplaces/, while the clone holds 54 plugins of which 9 are installed. src/main/plugins.ts:13-21 warns against exactly this confusion.
- failure: The Skills view lists skills of ~45 plugins the operator never installed as plugin-installed, and omits the skills of an installed plugin whose source is a separate repository — the sentence on this page sends them there to look.
- fix: Skills should walk installPath from installed_plugins.json (cache/<mkt>/<plugin>/<version>/skills) and, if it keeps the clone, label those rows 'in the catalog, not installed'. Until then reword the explainer.

## 9. [honesty/medium/small] Head and Catalog counts keep the on-disk clone number (54) after the CLI has answered 291
- where: src/renderer/src/views/Plugins.tsx:215
- evidence: Line 215: {st.installed.length} installed · {st.available.length} in the catalog; line 458: <span className="n">{st.available.length} available</span>; but the search placeholder at 469 says `Search ${catalog.length} plugins…` where catalog is cat when loaded. plugins.ts:446-452 records that the clone understates the catalog by a factor of five.
- failure: With the catalog open the page says 'Catalog 54 available' above a field that says 'Search 291 plugins…'.
- fix: When cat is loaded use cat.length and name the source: '54 cloned · 291 in the CLI catalog'.

## 10. [honesty/medium/medium] Plugin store is hard-wired to ~/.claude/plugins; a CLAUDE_CONFIG_DIR account has a different store, and the page never says which it reads
- where: src/main/plugins.ts:24
- evidence: Line 24: const ROOT = path.join(os.homedir(), '.claude', 'plugins'); src/main/skills.ts:100-112 documents 'configDir is CLAUDE_CONFIG_DIR: an account launched under one keeps its personal skills and plugins under that directory, not ~/.claude' and roots plugins at path.join(base, 'plugins'). runPlugin (491) passes Wanigan's process.env, so the CLI may read a third location.
- failure: An operator running Claude Code under CLAUDE_CONFIG_DIR sees the wrong account's plugins labelled 'Claude Code plugins', and Enable/Install act on whatever directory the CLI resolves — possibly not the one listed under 'Where this comes from'.
- fix: Accept a configDir like skills.ts, show the resolved directory in the head lead or roots table, and pass the same CLAUDE_CONFIG_DIR to runPlugin explicitly.

## 11. [unfinished/medium/medium] marketRemove and per-marketplace update have no surface; the marketplace rows ignore the present/installLocation fields main computes
- where: src/renderer/src/views/Plugins.tsx:560
- evidence: Lines 560-565 render name, source and ago(lastUpdated) only; the Market type (18) declares present and installLocation, which are never read (grep m.present → none). src/preload/index.ts:500 marketRemove and :496 marketUpdate(name) exist; src/main/index.ts:2333 handles plugins:marketRemove; plugins.ts:350 computes present from fs.existsSync(loc).
- failure: A marketplace whose clone was deleted shows a name and a date with no warning, and the only way to remove or refresh one marketplace is the terminal.
- fix: Per-row 'absent' mark, an Update button, and Remove behind ConfirmNote wired to marketRemove.

## 12. [missing/medium/medium] The CLI's own plugin-catalog-cache.json (291 plugins, per-model always-on/on-invoke tokens, components, install counts) is never read
- where: src/main/plugins.ts:529
- evidence: catalog() at 529-565 shells out to `claude plugin list --json --available` (60 s) then `list --json` (30 s); details() at 572-581 parses 'Always-on:' out of CLI text for one number. ~/.claude/plugins/plugin-catalog-cache.json exists (491 KB, fetchedAt 2026-09-05) with catalog.plugins[id].tokens["claude-opus-4-7"].always_on/on_invoke, components{skills,hooks,mcpServers,lspServers}, unique_installs, last_updated, marketplace_entry; the 2.1.263 binary names that file as its cache. readPlugins() roots (363-367) do not list it.
- failure: Offline the page shows 54 'in the catalog' when the CLI's cache says 291; cost is one number for one model, obtained by a 45 s subprocess per click; hooks/MCP/LSP declared for uninstalled catalog rows are invisible at the moment of consent.
- fix: Read the cache file (size-bounded, validated) and label it with fetchedAt as 'the CLI's cached catalog'; show always-on per model beside on-invoke, and the components in the install confirmation. Keep the CLI for install/enable.

## 13. [polish/medium/small] One missing plugin produces four notices: a main-process note, an aggregated renderer Note, a ✕ missing mark and a warning border
- where: src/renderer/src/views/Plugins.tsx:249
- evidence: src/main/plugins.ts:288 notes.push(`${id} is registered as installed but ${dir} is gone…`); Plugins.tsx 249-251 renders every st.notes as an info Note, 252-259 renders its own '{n} registered plugin(s) … missing from disk' warn Note, 383 renders '✕ missing' in the card meta, queue.css:16 .pg-card.gone paints the border warning.
- failure: Two banners with role=status/alert say the same thing in different words above a card that already says it twice.
- fix: Drop the main-process note (keep the data) and let the renderer's single warn Note plus the card mark carry it.

## 14. [polish/medium/small] The '4 installed of 54 in the catalog…' info Note repeats the head count as a status-role paragraph on every visit
- where: src/main/plugins.ts:355
- evidence: Lines 355-358 push `${installed.length} installed of ${available.length} in the catalog. The marketplace directory holds everything on offer, not what you have — only the installed list runs.`; Plugins.tsx:249 renders it as <Note tone="info"> (role=status) directly under the head whose 215 already reads '4 installed · 54 in the catalog'.
- failure: 24 words of plumbing explanation, announced to screen readers on mount, restating the count two lines above it.
- fix: Delete the note; put 'only installed plugins run' as the Catalog section's title attribute or Hint.

## 15. [polish/medium/small] Explainer opens by default over an empty page; siblings pass defaultHidden when there is nothing to show
- where: src/renderer/src/views/Plugins.tsx:235
- evidence: Line 235: <Explainer id="plugins-guide" title="What these plugins are"> with a 96-word paragraph (236-246). Control.tsx:440, Schedules.tsx:396 and ImprovementScout.tsx:723 pass defaultHidden={… === 0}; commit b74b213 ('Views with nothing to show opened on an essay about it') touched Plugins only to add aria-labels. Screenshot shows 100 words above four zero tiles.
- failure: A first-run operator reads a paragraph about what a plugin is not before seeing that there are none and no marketplaces.
- fix: defaultHidden={st.installed.length === 0} and cut the paragraph to two sentences; move 'nothing here extends Wanigan' into the PageHead lead.

## 16. [polish/medium/small] Empty state is a paragraph that sends the operator to a terminal command while the page has its own Install button, and claims a catalog that does not exist with zero marketplaces
- where: src/renderer/src/views/Plugins.tsx:311
- evidence: Lines 310-313: 'No plugins installed. The catalog below lists what the marketplaces offer — install one with /plugin install <name> in any session.' The catalog rows at 522-524 carry an Install button; the Add-marketplace field (479-484) is inside the collapsed catalog; EmptyState (bits.tsx) exists with posture 'nothing-yet' and an action slot.
- failure: With 0 marketplaces (the screenshot state) the sentence promises a catalog below that is empty, and the one thing that would fix it — adding the official marketplace — is behind '▸ search and install'.
- fix: <EmptyState posture="nothing-yet" title="No plugins installed" action={open catalog or Add marketplace}/>; when st.marketplaces.length === 0 lead with the Add field.

## 17. [polish/medium/small] Hand-rolled page head with a dead .pg-head class instead of PageHead
- where: src/renderer/src/views/Plugins.tsx:210
- evidence: Lines 210-221: <div className="pane-head pg-head"><div className="pg-title"><span className="label-stencil">…</span><h1>Plugins</h1></div><span className="pg-count">…</span><div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>. No sheet defines .pg-head (grep across src/renderer/src); smoke3.ts:4896 asserts !/\.pg-head\s*\{/. PageHead (bits.tsx) provides eyebrow/title/lead/actions and .pane-actions.
- failure: A className that matches no rule stays in the markup; the count is 12px mono where every other head's lead is .dim sans, so this head reads differently from Fleet/Control/Git.
- fix: <PageHead eyebrow="Claude Code plugins" title="Plugins" lead="4 installed · 54 cloned" actions={<button className="btn">Rescan</button>} /> and delete .pg-title/.pg-count.

## 18. [polish/medium/small] Section heads are a private .pg-sec-h family rather than SectionHead
- where: src/renderer/src/views/Plugins.tsx:272
- evidence: Lines 272, 456, 547: <div className="pg-sec-h"><h2>Installed</h2><span className="n">…</span>; queue.css:47-53 styles the h2 as 11px uppercase letterspaced and .n as mono. bits.tsx SectionHead renders .sec-head with .label and .sec-count (ui.css:31-33). CLAUDE.md names *-head families as the thing not to add.
- failure: Three uppercase micro headings in this view versus sentence-case labels on the views that adopted the primitive; the count sits in a different face from every other section count.
- fix: <SectionHead label="Installed" count={n} right={askButton} /> and delete .pg-sec-h.

## 19. [polish/medium/small] Enablement marks are inline-coloured spans with var() strings instead of Mark with a Tone
- where: src/renderer/src/views/Plugins.tsx:381
- evidence: Line 381-384: <span title={mark.blurb} style={{ color: mark.tone }}><span aria-hidden="true">{mark.glyph}</span> {mark.word}</span>; ENABLEMENT (81-105) carries tone: 'var(--text-faint)' / 'var(--good)' / 'var(--warning)'. bits.tsx Mark takes tone: Tone and renders .mark tone-*.
- failure: Colour is chosen per view rather than by the palette, and 'enabled state not read' at 11px faint is the only status text in the app not in the shared mark style.
- fix: Map Enablement → Tone ('on'→'ok','off'→'quiet','absent'→'warn','unread'/'unlisted'→'quiet') and render <Mark glyph word tone title/>.

## 20. [polish/medium/small] Install confirmation renders above the list, off-screen after scrolling, without moving focus, and is hand-rolled rather than ConfirmNote
- where: src/renderer/src/views/Plugins.tsx:492
- evidence: Lines 492-509 render the {confirming && …} warn Note before <div className="pg-cat"> (514); setConfirming(a) at 524 does no scroll or focus; bits.tsx ConfirmNote is the recorded T2 shape.
- failure: Press Install on row 150 of 200 and nothing visible changes; the question is 1,500 px up the page.
- fix: Render <ConfirmNote what={origin sentence} verb={`Install ${name}`} …/> directly under the row and focus its Cancel button.

## 21. [modernize/medium/medium] Card action row is four identical grey buttons, two of them opposite verbs
- where: src/renderer/src/views/Plugins.tsx:415
- evidence: Lines 415-444: Disable, Enable, Cost, Readme as .btn at var(--t-small) with inline padding, plus 'working…' text; only 'off' promotes Enable to btn-primary.
- failure: Nine cards show up to 36 same-weight buttons; the operator scans for which of Disable/Enable is the live choice.
- fix: A role="switch" bound to the observed state (title carries the `claude plugin` verb), with Cost and Readme as quiet text actions in the meta row, the way Linear and Raycast put the state control first and secondary reads after.

## 22. [bug/low/small] Catalog shows a green check beside 'disabled', and every installed row reads '✓ disabled' while the CLI is still loading
- where: src/renderer/src/views/Plugins.tsx:520
- evidence: Line 520: <span className="pg-yes">✓ {a.enabled ? 'installed' : 'disabled'}</span>; queue.css:62 .pg-yes colour var(--good). Lines 176-179 build rows from st.available with enabled: false whenever cat is null — which is the state while catBusy and after a thrown loadCatalog.
- failure: Opening the catalog shows nine green '✓ disabled' rows for a few seconds, then flips eight of them to '✓ installed'; a plugin that really is disabled keeps a green check.
- fix: Render Mark on/off; for disk rows say 'installed · state not read' in quiet tone.

## 23. [bug/low/small] Unguarded statSync in the catalog walk throws the whole scan on a dangling symlink
- where: src/main/plugins.ts:322
- evidence: Line 322: if (!fs.statSync(dir).isDirectory()) continue; inside the marketplaces loop; every neighbouring read is try/caught but this one is not.
- failure: One broken symlink under marketplaces/<mkt>/plugins rejects plugins:list, and the view renders only the error Note with no installed list.
- fix: Wrap in try/catch and continue.

## 24. [bug/low/small] Only the first registry entry per plugin is read, dropping a second scope
- where: src/main/plugins.ts:283
- evidence: Line 282-283: const list = Array.isArray(raw) ? raw : [raw]; const e = (list[0] ?? {}) …; installed_plugins.json version 2 stores an array per id; src/main/context/config.ts:509-515 iterates every entry.
- failure: A plugin installed at user and project scope shows once with the first scope and path; a stale second entry is never flagged as missing.
- fix: Iterate entries and emit one card per scope, or a scope list on one card.

## 25. [bug/low/small] Empty catalog shows 'Nothing in the catalog matches “”' with no search typed
- where: src/renderer/src/views/Plugins.tsx:512
- evidence: Line 512: {catalog.length === 0 ? (<p className="faint">Nothing in the catalog matches “{q}”.</p>) — no branch on q.
- failure: With zero marketplaces (or after PL-02) the page reports a search miss for an empty query.
- fix: Branch: q ? 'Nothing matches “q”' : 'No marketplace is added yet — add one above.'

## 26. [honesty/low/small] Directory size stops silently at 4,000 entries but is displayed as exact
- where: src/main/plugins.ts:130
- evidence: Lines 130-145 dirSize(dir, budget = 4000) returns early once seen > budget with no flag; Plugins.tsx:375 renders kb(p.bytes) beside the marketplace and scope.
- failure: A large plugin reports a plausible, under-counted size with nothing marking it partial.
- fix: Return { bytes, partial } and render '≥ 3.2 MB' when partial.

## 27. [honesty/low/small] Always-on parser depends on the CLI's locale number format and reads one model's figure
- where: src/main/plugins.ts:575
- evidence: Line 575: /Always-on:\s*~?([\d,]+)\s*tok/i. The 2.1.263 binary prints `  Always-on:   ~${V.toLocaleString()} tok   added to every session` and 'Token counts are estimates'; runPlugin (491) passes Wanigan's process.env (LANG) to the CLI; the binary picks K=Y[E[0]] — the first model.
- failure: Under a de/fr locale '1.081' captures as 1 and the card shows '~1 est. tokens every session'; under any locale the figure is for one unnamed model.
- fix: Strip all non-digits, or take the per-model numbers from plugin-catalog-cache.json (PL-05) and name the model.

## 28. [honesty/low/small] Install runs marketplace-declared commands with Wanigan's full environment; the consent names -y but not that
- where: src/main/plugins.ts:491
- evidence: Line 488-491: exec(bin, ['plugin', ...args], { …, env: { ...process.env, PATH: await shellPath() } }); install() at 589-593 passes -y. Plugins.tsx:496-500 says 'it passes -y, which accepts the marketplace-declared install command on your behalf'. CLAUDE.md: automatic probes receive only a minimal credential-free environment.
- failure: The consent sentence describes the flag but not that the install command inherits every variable in the main process.
- fix: Say it in the dialog, or run install with a minimal env (PATH, HOME, CLAUDE_CONFIG_DIR).

## 29. [missing/low/small] Install always uses user scope and the consent never says so, though main accepts project/local
- where: src/renderer/src/views/Plugins.tsx:503
- evidence: Line 503: window.wanigan.plugins.install(confirming.id) — no scope; src/main/index.ts:415-424 pluginScope accepts 'user'|'project'|'local'; the consent text (496-500) names -y but not that the plugin will load in every project of this account.
- failure: An operator cannot install a plugin for one repository from here, and is not told the install is account-wide.
- fix: A Segmented scope choice inside the confirmation and the sentence 'for every project under this account'.

## 30. [polish/low/small] Loading state is a bare dim paragraph instead of the Reading primitive
- where: src/renderer/src/views/Plugins.tsx:195
- evidence: Line 195: if (!st) return <div className="pane pg-wrap"><p className="dim">Reading your plugins…</p></div>; bits.tsx Reading renders role=status aria-busy with the final frame as children.
- failure: No status role for assistive tech and the layout jumps from one line to head+stats+sections when data lands.
- fix: <Reading what="your plugins">{head and empty stat grid}</Reading>.

## 31. [polish/low/small] .pg-chip duplicates .pill; the hooks chip repeats its text in a title and wraps a 14-event list into a multi-line pill
- where: src/renderer/src/views/Plugins.tsx:341
- evidence: Line 341-343: <span className="pg-chip hook" title={p.hookEvents.join(', ')}>⚑ hooks: {p.hookEvents.join(', ')}</span>; queue.css:28-32 .pg-chip {font-size: 11px; border-radius: 999px …} .pg-chip.hook/.mcp set colour pairs that .pill.tone-warn/.tone-accent already define.
- failure: A plugin registering many events renders a 999px-radius capsule three lines tall; the tooltip adds nothing the text does not say.
- fix: Use <Pill status="hooks" tone="warn"/> with 'hooks · 14' and list the events inside the expanded items.

## 32. [polish/low/small] Words set below the 10px floor the type scale reserves for glyphs
- where: src/renderer/src/styles/queue.css:43
- evidence: queue.css:43 .pg-item .k { font-size: 9.5px; … text-transform: uppercase } renders 'skill/command/agent'; :62 .pg-yes { font-size: 10px } renders 'installed/disabled'; :21 .pg-ver 10.5px. index.css:91-93: '--t-tiny is for a glyph or a unit beside a number, never for a sentence: 10px metadata is the contrast floor this palette refuses.'
- failure: The kind label and the installed state are the smallest words in the app, in faint colour, on the row the operator clicks to open a file.
- fix: Use var(--t-micro) and the .sub class for .k; var(--t-micro) for .pg-yes/.pg-ver.

## 33. [polish/low/small] Cost is keyed and requested by plugin name, not id
- where: src/renderer/src/views/Plugins.tsx:437
- evidence: Line 437: onClick={() => void showCost(p.name)}; 169: setCost((c) => ({ ...c, [name]: … })); 390: cost[p.name]. plugins.ts:573 runs ['details', name].
- failure: Two plugins with one name across marketplaces share a cost slot and the CLI is asked an ambiguous name.
- fix: Key by p.id and pass the id to details.

## 34. [polish/low/small] 'Where this comes from' table has no header, mixes presence and dates in one column, and omits the two files that actually decide state
- where: src/renderer/src/views/Plugins.tsx:548
- evidence: Lines 548-568: <table className="viz-table"> with no thead; root rows put '✓ found'/'absent' in td.n while marketplace rows put ago(m.lastUpdated) there; labels 'Installed/Catalog/Registry' vs lowercase 'marketplace'. settings.json (enabledPlugins) and plugin-catalog-cache.json are not listed (plugins.ts:363-367).
- failure: The right-aligned column reads '✓ found' on one row and '2h ago' on the next with no heading to say which is which.
- fix: Add a thead, split presence and updated into two columns, add the settings and catalog-cache rows.

## 35. [polish/low/small] The two CLI calls behind 'Ask the CLI' run sequentially with a 90 s ceiling and no cancel
- where: src/main/plugins.ts:530
- evidence: Lines 530-531: const avail = await runPlugin(['list','--json','--available'], 60_000); const inst = await runPlugin(['list','--json'], 30_000); Plugins.tsx:284 shows 'Asking the CLI…' with the button disabled.
- failure: On a slow marketplace fetch the page sits on a disabled button for over a minute.
- fix: Promise.all the two calls; surface elapsed time or a cancel.

## 36. [polish/low/small] aria-expanded toggles without aria-controls
- where: src/renderer/src/views/Plugins.tsx:354
- evidence: Line 354: <button className="pg-expand" aria-expanded={!!isOpen}; 459-461 the catalog toggle likewise; neither the .pg-items list nor the catalog body has an id.
- failure: A screen reader announces expanded/collapsed with nothing to jump to.
- fix: Give the controlled regions ids and set aria-controls.

## 37. [polish/low/small] The plugins sheet is named queue.css
- where: src/renderer/src/styles/queue.css:1
- evidence: queue.css:1 '/* plugins — the Plugins view. */'; index.css:12 @import './styles/queue.css'; /* plugins */; check-renderer-style.cjs:106 lists 'queue.css': 15, 'plugins.css': 15 as 'two sheets due to be renamed'.
- failure: Nobody grepping for the Plugins styles finds them; CLAUDE.md names sheets styles/<surface>.css.
- fix: Rename to plugins.css and drop the duplicate baseline key.

## 38. [modernize/low/small] ASCII triangle disclosures with mismatched labels where the shared Icon set has chevrons
- where: src/renderer/src/views/Plugins.tsx:356
- evidence: Line 356: {isOpen ? '▾ hide what it provides' : `▸ show ${items.length} item…`}; 461: {showCatalog ? '▾ hide' : '▸ search and install'}; queue.css:35 .pg-expand 11.5px accent text. bits.tsx ships Icon 'chevron-right'/'chevron-down'.
- failure: The open and closed labels are different sentences, and the accent-coloured text link is the same colour as the CTA, MCP chips and cost figure beside it.
- fix: <Icon name="chevron-right"/> plus 'Show 3 items' / 'Hide 3 items', in text-dim, accent only on hover/focus.

## 39. [modernize/low/medium] Reader dialog dumps SKILL.md as raw pre-wrapped monospace
- where: src/renderer/src/views/Plugins.tsx:611
- evidence: Line 611: <div className="pg-reader-b" tabIndex={0}>{text}</div>; queue.css:69-70 .pg-reader-b { font-family: ui-monospace …; font-size: 12px; white-space: pre-wrap }.
- failure: Frontmatter dashes, headings and fenced code all read as one 12px monospace block up to 200 KB.
- fix: Render frontmatter as a key/value strip and the body as markdown with headings and code blocks, as a reading surface next to Cursor or Devin would.

## 40. [modernize/low/small] Four hero-digit stat tiles for counts the cards already carry
- where: src/renderer/src/views/Plugins.tsx:262
- evidence: Lines 262-269: Stat Installed/Skills/Commands/Hooks in .stat-grid above a list whose every card repeats '3 skills', '2 commands', 'hooks: …' as chips (335-346).
- failure: A full row of vertical space for four numbers restated on the next screen; with nine plugins the digits never exceed two characters.
- fix: Fold into the PageHead lead ('9 installed · 58 skills · 2 register hooks') and give the space to the list.

## 41. [modernize/low/small] Three small-caps voices in the first 400 px: stencil eyebrow, uppercase section h2, mono count
- where: src/renderer/src/views/Plugins.tsx:212
- evidence: Line 212 <span className="label-stencil">Claude Code plugins</span>; queue.css:52 .pg-sec-h h2 { text-transform: uppercase; letter-spacing: .1em }; queue.css:10 .pg-count mono 12px. index.css:320-333 says the stencil is one eyebrow per surface and .label is the working label.
- failure: CLAUDE CODE PLUGINS, INSTALLED, CATALOG and WHERE THIS COMES FROM compete at the same weight; the page has no single hierarchy the eye can follow.
- fix: One stencil eyebrow via PageHead; SectionHead's sentence-case .label for sections.

## 42. [modernize/low/medium] Catalog as a 1px-gap grid of boxes with a 10px state and a micro Install button
- where: src/renderer/src/views/Plugins.tsx:515
- evidence: Lines 515-535 .pg-cat-row inside .pg-cat (queue.css:55-62: auto-fill 260px, gap 1px, line-clamp 2); Install is .btn at var(--t-micro) with 2px 8px padding; no keyboard navigation between rows.
- failure: 291 rows become a wall of equal boxes; the operator cannot arrow through results and the verb is the smallest thing in each box.
- fix: A single-column list with the search pinned, name + one-line description + trailing state/verb, arrow-key navigation, marketplace as a muted suffix — the Raycast/Cursor extension-list shape.

