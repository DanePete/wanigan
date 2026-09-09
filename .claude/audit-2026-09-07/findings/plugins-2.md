# Plugins view (src/renderer/src/views/Plugins.tsx, src/main/plugins.ts, src/renderer/src/styles/queue.css)

34 findings. readability={"firstPaintWords": 150, "fontSizesInSheet": 8, "explainerHintNoteUses": 10, "nestedBorderDepth": 1, "notes": "firstPaintWords counts the screenshot's empty state through the empty-state copy up to the '\u25b8 search and install' control (head 16, Explainer 95, stat tiles 17, 'Installed 0' + empty copy 22); strictly, the Rescan button in the sticky head is the first interactive control after 16 words. Populated real state \u2248203 words before the first plugin card. fontSizesInSheet: queue.css declares 15 literal font-size values across 8 distinct sizes (9.5, 10, 10.5, 11, 11.5, 12, 13, 15px) plus var(--t-micro) (=11px) three times. explainerHintNoteUses: 1 Explainer + 9 Note + 0 Hint. nestedBorderDepth: primary content (.pg-card, 1px --line border) sits directly in .pane (no border) = 1; chips and result Notes inside a card are depth 2."}

notes: Screenshots (dark and light) both show the stub's empty state: '0 installed · 0 in the catalog', four zero stat tiles, an empty 'Where this comes from' table and 'CATALOG 0 available'. All of these are stub artifacts: the harness Proxy answers plugins.list with an array-like empty proxy, whereas readPlugins() always returns three roots rows (plugins.ts:363-367) and this machine has 9 installed / 54 cloned / 282 CLI-indexed / 291 cached. No screenshot-only finding is reported; every finding above is anchored in TSX/CSS/main source and, where it concerns CLI shape, in actual output captured today (`claude plugin list --json` bare array with id/enabled; `--available` returns {installed, available} with pluginId/marketplaceName/source/installCount; `claude plugin details` prints 'Always-on:   ~66 tok', so the regex at plugins.ts:575 matches). Contrast was computed for every tinted text pair in both palettes and all clear 4.5:1 (lowest: light MCP chip 4.54:1), so no contrast finding. Light theme renders correctly; theme tokens used in queue.css are all defined in index.css. Recent commits (last two days) touched none of these three files; the last Plugins commit was b74b213 (fixtures/hook events). The prior review's 412-word figure was not reproduced: the Explainer body is 95 words; the screenshot carries 150 words before 'search and install' (16 of them before the Rescan button, which is technically the first control); a populated real state carries ~203 words before the first card (head 16 + Explainer 95 + disk note 24 + stats 17 + Ask-the-CLI Note 51). Read-only audit; no repository files were modified. One scratch file written: scratchpad/avail.json (captured CLI output).

## 1. [bug/high/small] A failed `claude plugin list --json` is reported as 'the CLI does not list it' on every card
- where: src/main/plugins.ts:538
- evidence: Line 531: `const inst = await runPlugin(['list', '--json'], 30_000);` Line 538: `for (const r of pluginRows(inst.output, 'installed') ?? [])` — `inst.ok` is never checked; on failure output is '' so pluginRows returns [] and installedById stays empty. Plugins.tsx:73 `if (!row.installed) return 'absent'` then renders ENABLEMENT.absent (line 96-100): '⚠ the CLI does not list it … reinstall it, or remove the stale registration.'
- failure: A 30-second timeout, a transient CLI error, or a shape change in the installed list marks every installed plugin with a warning glyph and advice to reinstall, presented as the CLI's answer when the CLI gave none. Verified today's real output does parse (bare array with id/enabled), so this is the failure path only, but it is the path a timeout takes.
- fix: If `!inst.ok` or pluginRows returns null, do not fabricate 'not installed': return `installed: null` per row (or a note) and have enablementOf() map that to 'unread'. Also drop the second call entirely — verified `claude plugin list --json --available` already returns `{installed:[{id,enabled,...}], available:[...]}` on this CLI, so one call answers both.

## 2. [honesty/high/medium] Every card says enabled state is not on disk; it is, and Wanigan already reads it elsewhere
- where: src/renderer/src/views/Plugins.tsx:85
- evidence: Line 85-86: blurb: 'Nothing on disk records whether Claude Code has this switched on — installed_plugins.json and the plugin folder note the installation and stop there.' Line 299: '<strong>Enabled state is not recorded on disk.</strong>'. But ~/.claude/settings.json on this machine carries enabledPlugins: {'claude-security@claude-plugins-official': false, 'code-simplifier@...': true, ... 9 entries}, and src/main/context/config.ts:494-502 enabledPlugins(layers) already reads `l.read.value?.enabledPlugins` across settings layers for the Context view.
- failure: At first paint every installed card shows '? enabled state not read' with both Disable and Enable offered, and the operator is told the only way to learn a fact that is in a JSON file Wanigan already parses is to press a button that shells out to the CLI twice (60s + 30s timeouts). The sentence is false as written, on a surface whose stated value is 'say the true thing'.
- fix: In readPlugins(), read enabledPlugins from the same settings layers context/config.ts uses (share the reader), set `enabled: boolean | null` on each InstalledPlugin, map it to on/off in enablementOf() before consulting `cat`, and reword the blurb/Note to describe the settings layer that answered (and which layer wins). Keep the CLI ask for the catalog only.

## 3. [honesty/high/small] Offline catalog rows hardcode enabled:false, so installed plugins render '✓ disabled' in green
- where: src/renderer/src/views/Plugins.tsx:178
- evidence: Line 176-178: `const rows: CatalogItem[] = cat ?? (st?.available ?? []).map((a) => ({ ..., installed: a.installed, enabled: false, source: a.source }))`. Line 520: `<span className="pg-yes">✓ {a.enabled ? 'installed' : 'disabled'}</span>` with .pg-yes { color: var(--good) } (queue.css:62).
- failure: While the catalog is loading and after any CLI failure (cat stays null, catNote set), an operator opening 'search and install' sees each installed plugin marked '✓ disabled' in the good/green tone — a state the disk scan does not know, contradicting the same page's own 'enabled state not read' mark on the card above. A check-mark beside the word 'disabled' is also a glyph/word contradiction even when true.
- fix: Model the fallback as `enabled: null`; render 'installed' alone when null, and use a neutral mark (not --good) for 'disabled'. With PG-01 the settings.json value can fill it truthfully.

## 4. [bug/medium/small] Cost button silently does nothing when the CLI fails
- where: src/renderer/src/views/Plugins.tsx:168
- evidence: Lines 165-172: `const d = await window.wanigan.plugins.details(name); setCost(...d.alwaysOnTokens); if (d.text) setReading(...)`. plugins.ts:574 on failure returns `{ text: '', alwaysOnTokens: null, error: r.error }` — `d.error` is never read in the view, and nothing sets a busy state during the 45s timeout (plugins.ts:573).
- failure: With Claude Code missing from PATH or the CLI erroring, pressing Cost produces no dialog, no number, no error and no working indicator; the operator presses it again. The preload type even declares `error: string | null` (preload:488).
- fix: If `d.error`, setResult({ id: p.id, ok: false, text: d.error }); show 'working…' on the card while pending (reuse `working`).

## 5. [bug/medium/small] Three catalog counts on one screen disagree
- where: src/renderer/src/views/Plugins.tsx:215
- evidence: Line 215 head: `{st.available.length} in the catalog`; line 458 section: `{st.available.length} available` (disk: 54 directories verified); line 469 placeholder: `Search ${catalog.length} plugins…` where catalog is `cat` after the CLI answers (282 rows verified). Line 539: 'Showing 200 of {num(catalog.length)}'.
- failure: After 'Ask the CLI' the page reads '54 in the catalog', 'CATALOG 54 available' and 'Search 282 plugins…' simultaneously.
- fix: One count, derived from `cat ?? st.available` (or the on-disk cache per PG-06) and used in all three places; say 'cloned' vs 'indexed' if both are kept.

## 6. [bug/medium/small] Enable/Disable can run concurrently on two cards; only the last result survives
- where: src/renderer/src/views/Plugins.tsx:419
- evidence: Line 419/428: `disabled={working === p.id}` — only the clicked card's buttons disable. Line 154-163 act(): `setWorking(id); setResult(null); … await load(true); if (cat) await loadCatalog();` — one `result` slot, one `working` slot.
- failure: Click Enable on A then Disable on B before A returns: two `claude plugin` processes write settings.json concurrently, `working` flips to B so A's 'working…' vanishes, A's result Note is overwritten by B's, and load(true)/loadCatalog run twice.
- fix: Disable all card actions while `working !== null` (as the catalog Install already does with `!!working`, line 523), or keep a per-id result map.

## 7. [bug/medium/small] A successful Enable/Disable is not reflected on the card unless the CLI was asked earlier; a failed re-ask leaves stale state silently
- where: src/renderer/src/views/Plugins.tsx:160
- evidence: Line 160: `if (cat) await loadCatalog();` — with cat null the card stays 'enabled state not read' and both buttons remain after the command succeeded. loadCatalog() (144-152) on failure only `setCatNote(...)`, leaving `cat` at its previous value; `askFailed = !cat && catNote !== null` (201) is then false, so the stale on/off marks and the single-direction buttons are shown with no warning outside the collapsed catalog section.
- failure: Operator presses Enable, sees 'Done.', and the card still says its state has not been read with Enable still on offer; or after a later CLI failure the card shows yesterday's enablement as current with no indication.
- fix: After a successful setEnabled, re-read enablement (from settings.json per PG-01, or loadCatalog()). On a loadCatalog failure after a prior success, keep `cat` but set a `catStale` flag that the section Note and marks reflect.

## 8. [bug/medium/small] Install confirmation renders above a 200-row grid, off-screen from the row that was clicked
- where: src/renderer/src/views/Plugins.tsx:492
- evidence: Lines 492-510 render `{confirming && <Note tone="warn">…Install…Cancel</Note>}` before `<div className="pg-cat">` (514); rows are `catalog.slice(0, 200)` (515) in a minmax(260px) grid (queue.css:55). The Install button (522-524) only `setConfirming(a)`; nothing scrolls or moves focus.
- failure: Clicking Install on a row far down the grid produces no visible change in the viewport; the consent prompt (the one that stands in for the CLI's -y prompt) is out of sight, and the row's button is now disabled with no explanation.
- fix: Render the confirmation inline in the clicked row (the same slot `result` already uses at line 528-532), or use ConfirmNote and move focus to its Cancel button via the existing dialog pattern.

## 9. [honesty/medium/medium] Explainer promises a plugin cost in Context and plugin skills in Skills; Context has no such figure and Skills scans the catalog clone, not the installed copy
- where: src/renderer/src/views/Plugins.tsx:242
- evidence: Lines 242-244: 'What an enabled plugin costs a session is in Context (⌘⇧C), and the skills it ships are listed in Skills (⌘⇧S).' grep of src/main/context/*.ts for a plugin token figure finds none — config.ts:527-553 only lists plugin hooks and counts agent/command files. src/main/skills.ts:383-397 scanPlugins() walks `marketplaces/<mkt>/plugins|external_plugins/*/skills` (the 54-directory catalog clone) and never `plugins/cache/` — the exact conflation plugins.ts:13-21 warns against.
- failure: An operator following ⌘⇧C finds no plugin cost; one following ⌘⇧S sees skills from every cloned catalog plugin, installed or not, and none from the installed cache version that actually loads. The only cost number Wanigan has is this page's own Cost button.
- fix: Drop the Context clause (or say 'hooks and MCP servers an enabled plugin adds are in Context'); point the Skills scan at installed_plugins.json installPath directories with the marketplace clone as fallback, as context/config.ts:509-525 pluginDir() already does.

## 10. [unfinished/medium/small] marketRemove and per-marketplace update exist in preload and main but no control reaches them
- where: src/preload/index.ts:500
- evidence: preload:496 `marketUpdate: (name?: string)`, :500 `marketRemove: (name: string)`; main index.ts:2333 `handle('plugins:marketRemove', …marketplaceName(name))` with validator at 438. Renderer grep: the only caller file is Plugins.tsx and it never calls marketRemove or marketUpdate(name); the 'Where this comes from' table (Plugins.tsx:560-566) lists each marketplace with name, source and age only.
- failure: A marketplace, once added, cannot be removed or refreshed individually from the surface that added it; the operator must go to the terminal, and the 'unlisted' card state (line 101-105) explains a consequence of removal that this UI cannot cause.
- fix: Add Update and Remove (T2 ConfirmNote) actions to each marketplace row; show `present` (computed at plugins.ts:350, never rendered) so a marketplace whose clone is gone is visible.

## 11. [missing/medium/medium] The CLI's own on-disk catalog cache (291 plugins, per-model token costs, components, install counts) is never read
- where: src/main/plugins.ts:446
- evidence: Comment lines 446-453: 'the CLI knows … the full marketplace catalog — 285 plugins here, against the 54 that happen to be cloned … fetched on demand'. On disk ~/.claude/plugins/plugin-catalog-cache.json (verified): {version:1, fetchedAt, catalog:{generated_at, marketplace_sha, plugins:{'<id>': {tokens:{'claude-opus-4-7':{always_on:1081,on_invoke:25462},...}, components:{skills:5,hooks:0,mcpServers:0,lspServers:0,...}, unique_installs:2966, marketplace_entry:{author,category,description,homepage,name,source}, version, sha}}}} — 291 rows. readPlugins() (272-373) reads only marketplaces/ directories; details() (572-581) shells out 45s per plugin to regex '~66 tok' out of text the cache already holds.
- failure: The head says '54 in the catalog' when 291 are on disk; the full catalog and every plugin's always-on cost sit behind two CLI shell-outs with 60s/45s timeouts that need Claude Code on PATH, and the per-card cost is one press per plugin. On a machine with no network the offline count is understated fivefold.
- fix: Read plugin-catalog-cache.json in readPlugins() (validated by shape, size-capped like readJson), surface its fetchedAt as provenance ('catalog as the CLI cached it 3h ago'), fill always-on cost per card from tokens[model] marked est., and keep the CLI path as an explicit refresh. Note the cache's model keys are the provenance of the estimate — show which model it was computed for.

## 12. [missing/medium/medium] MCP server destinations the CLI reports for a plugin are not shown before consent
- where: src/renderer/src/views/Plugins.tsx:346
- evidence: Line 346: `<span className="pg-chip mcp">MCP: {p.mcpServers.join(', ')}</span>` — names only, from .mcp.json keys (plugins.ts:184-191). Verified `claude plugin list --json` returns per-plugin `mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } } }`. The install confirmation (495-500) says 'A plugin can ship hooks, an MCP server or an LSP' generically.
- failure: An operator enabling or installing a plugin cannot see that it will open an HTTP MCP connection to a named host carrying a bearer token from their environment — the egress fact the product's guardrails single out.
- fix: Read `.mcp.json` server entries (type, url/command) in mcpServersOf() and show type + host per server on the card and in the confirmation; redact header values.

## 13. [modernize/medium/large] Card actions: four outlined buttons plus a 'why?' disclosure and an eight-item 11px meta row per card
- where: src/renderer/src/views/Plugins.tsx:413
- evidence: Lines 413-444: Disable / Enable / Cost / Readme as `.btn`s in a wrapped flex row; 371-393 `.pg-meta` with marketplace, scope, author, size, 'updated 3d ago', the enablement mark, '✕ missing', and the cost figure in accent; 404-412 `<details className="pg-why"><summary>why?</summary>`.
- failure: Nine cards at 340px each read as nine small forms; the primary fact (on/off) is a faint 11px word at the end of a meta row while 'Cost' and 'Readme' get the same weight as the state-changing action.
- fix: A list row per plugin (name, version, origin) with a switch for enabled (state and control in one, disabled with a reason while unread), the always-on cost as a quiet tabular figure filled from the on-disk cache (PG-06), and Readme/Reveal/Details in an overflow menu — the shape Raycast's extension list and Cursor's extensions panel use.

## 14. [bug/low/small] Empty catalog message renders 'matches “”' with empty quotes
- where: src/renderer/src/views/Plugins.tsx:512
- evidence: Line 511-512: `catalog.length === 0 ? <p className="faint">Nothing in the catalog matches “{q}”.</p>` — reached with q === '' when no marketplace is cloned, when the CLI failed, or while catBusy with no disk rows.
- failure: Visible literal 'Nothing in the catalog matches “”.' on first open with no marketplaces.
- fix: Branch: q ? 'Nothing matches “q”' : catBusy ? Reading : 'No marketplace has been added yet' with the Add field beside it.

## 15. [bug/low/small] An unguarded statSync in the marketplace walk can take down the whole view
- where: src/main/plugins.ts:322
- evidence: Line 320-322: `for (const n of names) { const dir = path.join(base, n); if (!fs.statSync(dir).isDirectory()) continue;` — readdirSync at 319 is wrapped, statSync is not; a dangling symlink or an entry removed between the two calls throws ENOENT out of readPlugins().
- failure: The IPC returns an error and the renderer shows only the 'Try again' Note (188-194) with no head, for every plugin, because of one broken entry in a catalog directory.
- fix: Use `readdirSync(base, { withFileTypes: true })` and `e.isDirectory()`, or wrap the stat in try/catch and skip.

## 16. [bug/low/small] Three text sizes sit below the sheet's own 10px/11px floor
- where: src/renderer/src/styles/queue.css:43
- evidence: queue.css:43 `.pg-item .k { … font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint)`; :62 `.pg-yes { font-size: 10px; }`; :21 `.pg-ver { font-size: 10.5px; }`. index.css:91-92: '--t-tiny is for a glyph or a unit beside a number, never for a sentence: 10px metadata is the contrast floor this palette refuses.' (Computed contrast still passes: text-faint on bg-soft 7.61:1 dark, 5.66:1 light.)
- failure: 9.5px uppercase faint kind labels ('command', 'agent') in the expanded item list are the smallest text in the app and illegible on a non-retina display; the version string beside a 15px name is 10.5px.
- fix: --t-micro for all three; these are among the 15 literal px sizes the gate baseline holds for queue.css.

## 17. [honesty/low/small] 'Claude Code skips it silently' is a claim about the CLI Wanigan has not observed
- where: src/renderer/src/views/Plugins.tsx:257
- evidence: Line 257: 'Claude Code skips {them/it} silently.' and plugins.ts:288 'or Claude Code will skip it silently.' Nothing in the module reads CLI behaviour for a missing installPath; the fact Wanigan has is that the directory does not exist.
- failure: States another program's behaviour as observed fact; if the CLI errors loudly on a missing plugin the sentence is simply wrong.
- fix: Say what is known: 'its files are not on disk, so nothing it provides can load' (the wording context/config.ts:541 already uses).

## 18. [honesty/low/small] Hooks stat is painted warning whenever any plugin registers a hook
- where: src/renderer/src/views/Plugins.tsx:268
- evidence: Line 266-268: `<Stat label="Hooks" … tone={st.installed.some((p) => p.hookEvents.length) ? 'var(--warning)' : undefined} />`.
- failure: A yellow hero digit signals a problem for what is a normal count; nothing was observed to be wrong. Colour is doing the alarming without a reason code.
- fix: Neutral tone; if hooks deserve attention, say why beside the count ('N run code on this machine') rather than colouring the number.

## 19. [honesty/low/small] Directory size stops counting at 4000 entries and is shown as the total
- where: src/main/plugins.ts:130
- evidence: Line 130-145: `function dirSize(dir, budget = 4000) { … if (++seen > budget) return; …}` returns the partial total; Plugins.tsx:375 renders `kb(p.bytes)` with no marker.
- failure: A large plugin shows a size that is a floor, presented as observed.
- fix: Return `{bytes, partial}` and render '≥ 12 MB' or omit when partial.

## 20. [unfinished/low/small] Install scope is always 'user'; the bridge and validator support project/local
- where: src/renderer/src/views/Plugins.tsx:503
- evidence: Line 503: `window.wanigan.plugins.install(confirming.id)` — no scope argument. preload:492-493 accepts `scope?: PluginScope`; main index.ts:417-425 pluginScope() validates 'user'|'project'|'local'.
- failure: An operator cannot install a plugin for one project from Wanigan even though the whole path is wired and validated.
- fix: A Segmented scope choice inside the confirmation, defaulting to user, with the project scope naming the active project.

## 21. [unfinished/low/small] Empty state sends the operator to a slash command while the page's own Install flow sits one disclosure below
- where: src/renderer/src/views/Plugins.tsx:310
- evidence: Lines 310-313: 'No plugins installed. The catalog below lists what the marketplaces offer — install one with /plugin install <name> in any session.' The Catalog section (455-464) is collapsed by default behind '▸ search and install' and installs via plugins.install.
- failure: Copy contradicts the surface: the first-run instruction bypasses the consent dialog this view built for exactly that action.
- fix: Use EmptyState posture 'nothing-yet' with the action being a button that opens the catalog (setShowCatalog(true) + loadCatalog()).

## 22. [missing/low/small] Fields the scan computes and never shows: homepage, installedAt, scannedAt, marketplace present/installLocation, installCount
- where: src/renderer/src/views/Plugins.tsx:371
- evidence: Renderer never references `homepage` (plugins.ts:203), `installedAt` (295), `scannedAt` (369), Market `installLocation`/`present` (348-350) — grep confirms only type declarations. `installCount` (verified on every `--available` row, e.g. 2966) is dropped at plugins.ts:550-562.
- failure: No 'scanned 12s ago' beside Rescan (the 15s TTL cache at plugins.ts:270 means Rescan can return the same snapshot with no cue); no link to a plugin's homepage before consent; a marketplace whose clone directory is gone is indistinguishable from a healthy one; 282 catalog rows with no ranking signal.
- fix: Render scannedAt in the head lead, homepage as an external link on the card and in the confirm, `present` in the marketplace table, and sort/label the catalog by installCount.

## 23. [polish/low/small] A missing plugin is announced four times at first paint
- where: src/renderer/src/views/Plugins.tsx:249
- evidence: plugins.ts:288 pushes 'X is registered as installed but <path> is gone. Reinstall it, or Claude Code will skip it silently.' into notes, rendered at 249-251 as an info Note; 252-259 render a second warn Note '{n} registered plugin(s) … missing from disk (names). Claude Code skips them silently.'; the card wears `.gone` (326, queue.css:16) and '✕ missing' (384).
- failure: Two paragraphs above the fold say the same thing with different tones (info then warn), then the card says it twice more.
- fix: Drop main's per-plugin note (keep it in the typed field), keep the single warn Note and the card mark.

## 24. [polish/low/small] `pg-head` matches no rule; `pg-wrap` is styled only in compact.css while queue.css says it was deleted
- where: src/renderer/src/views/Plugins.tsx:210
- evidence: Line 210: `<div className="pane-head pg-head">`. No `.pg-head` rule in any sheet (grep), and smoke3.ts:4896 asserts `!/\.pg-head\s*\{/.test(cascadeQueue)`. Lines 190/195/204 `className="pane pg-wrap"`; queue.css:3-9 comment says .pg-wrap 'is deleted', yet compact.css:32 still styles `.sc-wrap, .pg-wrap { padding: … }` at 720px.
- failure: A dead class name on the head, and a comment that contradicts the one live rule for the wrapper.
- fix: Remove `pg-head`; either remove `pg-wrap` and the compact.css rule (letting .pane's 720px step apply) or correct the comment.

## 25. [polish/low/small] Head is hand-built instead of PageHead, with a stencil eyebrow that repeats the title
- where: src/renderer/src/views/Plugins.tsx:210
- evidence: Lines 210-221 build `.pane-head` by hand: `<span className="label-stencil">Claude Code plugins</span><h1>Plugins</h1>` plus a private `.pg-count` mono span (queue.css:10-11, literal 12px and a private monospace stack rather than --mono) and an inline `marginLeft:auto` action div. bits.tsx:245-263 PageHead has eyebrow/title/lead/actions.
- failure: Eyebrow 'CLAUDE CODE PLUGINS' over 'Plugins' says the same word twice in two faces; the count line uses a fourth typeface treatment; Skills (line 370) uses .pane-head bare, so the two neighbours' heads differ.
- fix: `<PageHead eyebrow="Claude Code" title="Plugins" lead={count} actions={<button>Rescan</button>} />`; delete .pg-count/.pg-title.

## 26. [polish/low/medium] Private section-head, chip and disclosure families where SectionHead, Pill and Icon exist
- where: src/renderer/src/styles/queue.css:47
- evidence: queue.css:47-53 `.pg-sec-h h2 { font-size: var(--t-micro); text-transform: uppercase }` with `.n` count; :28-32 `.pg-chip`, `.pg-chip.hook`, `.pg-chip.mcp`; :35 `.pg-expand` with text glyphs '▸'/'▾' (Plugins.tsx:356, 462). bits.tsx:265 SectionHead, :28 Pill (tone classes), :464+ Icon('chevron-right'|'chevron-down').
- failure: CLAUDE.md forbids a new *-chip/*-head family; three of them here, each with its own literal sizes.
- fix: SectionHead for the three sections; Pill tone-warn/tone-quiet for hooks/MCP/counts; Icon chevrons in a `.btn-link`-style disclosure.

## 27. [polish/low/small] Seven buttons re-spell .btn-sm inline
- where: src/renderer/src/views/Plugins.tsx:418
- evidence: Lines 280, 418, 427, 435, 439 (and 522 with --t-micro): `className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}`. index.css:291 `.btn-sm { min-height: var(--control-h-sm); padding: 3px 9px; font-size: var(--t-small); }`.
- failure: Six of the view's 38 baseline inline style objects are a class that already exists; the inline copies also miss .btn-sm's min-height so these buttons are shorter than every other small button.
- fix: className="btn btn-sm".

## 28. [polish/low/small] Local kb() duplicates bits.size(); enablement mark bypasses Mark; loading bypasses Reading; confirm bypasses ConfirmNote
- where: src/renderer/src/views/Plugins.tsx:24
- evidence: Line 24 `const kb = (b) => …` vs bits.tsx:548 size(). Lines 381-383 `<span title={mark.blurb} style={{ color: mark.tone }}>` with tone strings 'var(--good)' etc. (82-106) vs bits.tsx:103 Mark with tone classes. Line 195 `<p className="dim">Reading your plugins…</p>` vs bits.tsx:359 Reading (aria-busy, role=status). Lines 494-508 warn Note with hand-rolled Install/Cancel vs bits.tsx:198 ConfirmNote.
- failure: Four primitives re-implemented with small drift: the mark has no glyph box alignment, the loading line is not announced, the confirm's primary button is inside the Note body rather than the actions slot.
- fix: Use size(), Mark, Reading, ConfirmNote.

## 29. [polish/low/small] Plugin shapes are duplicated in the renderer and the bridge is `any`, though shared/types.ts exists for exactly this
- where: src/renderer/src/views/Plugins.tsx:5
- evidence: Line 5: '/* Shapes mirror src/main/plugins.ts; the renderer cannot import from main. */' followed by 17 lines of hand-copied types. preload:484-485 `list: () => call<any>('plugins:list'), refresh: () => call<any>('plugins:refresh')`. src/shared/types.ts:3042 already holds `PluginScope`, and preload imports ~90 types from it.
- failure: The 'typed preload API' the trust-boundary rule relies on is untyped here; the two copies can drift (the renderer's Market type already carries fields never rendered).
- fix: Move InstalledPlugin/AvailablePlugin/CatalogPlugin/PluginState/PluginAction/MarketplaceInfo to shared/types.ts and type the six calls.

## 30. [polish/low/small] The Plugins stylesheet is named queue.css and the gate has been waiting for the rename
- where: src/renderer/src/styles/queue.css:1
- evidence: queue.css:1 '/* plugins — the Plugins view. */'; index.css:12 `@import './styles/queue.css';   /* plugins */`; check-renderer-style.cjs:106 `'queue.css': 15, 'plugins.css': 15,` under the comment 'Two sheets due to be renamed are listed under both names so the rename lands without a false failure; delete the old name when it does.'
- failure: Nobody grepping for the Plugins sheet finds it; the gate carries a phantom baseline row.
- fix: git mv to plugins.css, update the import and the smoke3.ts:4893 sourceOf path, delete the 'queue.css' baseline row.

## 31. [polish/low/small] catalog() shells out twice in series when one call carries both lists
- where: src/main/plugins.ts:530
- evidence: Lines 530-531: `const avail = await runPlugin(['list','--json','--available'], 60_000); const inst = await runPlugin(['list','--json'], 30_000);` Verified the --available response is `{installed:[…enabled…], available:[…]}`.
- failure: Ask the CLI takes two process spawns back to back (each re-running detectProviders() via claudeBin() at 473-476), and a failure of the first still spends the second.
- fix: One call; read both keys; fall back to the second call only if `installed` is absent from the shape.

## 32. [modernize/low/medium] Catalog is a grid of 260px cells behind a text-glyph disclosure, with search inside it
- where: src/renderer/src/styles/queue.css:55
- evidence: queue.css:55-57 `.pg-cat { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1px; background: var(--line-soft) }` (1px fake borders); Plugins.tsx:459-463 '▸ search and install' toggle; the search field (468) only exists after the toggle; 2-line clamped descriptions (queue.css:59-61).
- failure: Scanning 200 cells in a 3-4 column masonry is slower than a list; there is no sort, no origin, no install count on the row; search is a click away and has no ⌘F/`/` affordance.
- fix: Full-width rows (name · marketplace · installs · origin · Install) with the search field always visible at the section head, sorted by installCount, origin shown as a Pill so the consent dialog is not the first time it appears.

## 33. [modernize/low/small] Accent coral carries five unrelated meanings on this page
- where: src/renderer/src/styles/queue.css:32
- evidence: queue.css:32 `.pg-chip.mcp { border-color: var(--accent); color: var(--accent); background: var(--accent-soft) }`; :35 `.pg-expand { color: var(--accent) }` (both disclosures); Plugins.tsx:389 cost figure `style={{ color: 'var(--accent)' }}`; `.btn-primary` for 'Ask the CLI' (280) and the confirm's Install (502); focus rings (queue.css:37).
- failure: An 'MCP: github' chip reads as a call to action; the estimate figure reads as the most important number on the card; the two disclosures look like primary links.
- fix: MCP chip in tone-quiet or tone-warn (it is a trust fact, like hooks); disclosures in --text-dim with an Icon chevron; the estimate in --text-dim with 'est.'; accent only on the one primary button.

## 34. [modernize/low/medium] Reader dialog renders SKILL.md and README as raw monospace text
- where: src/renderer/src/views/Plugins.tsx:611
- evidence: Line 611: `<div className="pg-reader-b" tabIndex={0}>{text}</div>` with queue.css:69-70 `font-family: ui-monospace…; white-space: pre-wrap`. Reader title at 603 uses inline `fontSize: var(--t-lead)`.
- failure: A 200 KB markdown document with frontmatter, headings and code fences appears as a wall of 12px monospace; the Skills view is the surface that owns skill reading and this one duplicates it worse.
- fix: Hand the path to the Skills reader (or a shared markdown renderer with frontmatter folded), keep the truncation notice.

