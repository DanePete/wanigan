# Context view (src/renderer/src/views/Context.tsx, src/main/context/{instructions,memory,config}.ts, styles/policy.css)

28 findings. readability={"firstPaintWords": 13, "fontSizesInSheet": 6, "explainerHintNoteUses": 8, "nestedBorderDepth": 1, "notes": "firstPaintWords counts the h1 'Context' plus the 12-word lead before the Project <select> in DOM order (Context.tsx L795-799; confirmed in both screenshots). In the fixture state the first in-content control ('Type /init into a session', L1835) sits below the setup card's title, 38-word paragraph and four slot rows \u2014 about 205 words. policy.css declares 10px, 10.5px, 11px (\u00d75), 11.5px (\u00d78), 12px and var(--t-small): five literal sizes off the token scale plus one token. Context.tsx uses Note 8\u00d7, Explainer 0, Hint 0; it also has 8 local Callout uses and 13 ctx-sub heads. Primary tables sit at depth 1 (.pane > .card.section); stat tiles, Callouts and the FileBody reader sit at depth 2 (.card .sunk borders are made transparent by index.css L720, .ctx-read keeps a visible border)."}

notes: Read-only audit; no repository files were edited and nothing was run. Both screenshots were checked against the TSX and the main-process readers: the 'Slots that are still empty' card leading with slots 1,2,5,6 above sections 3 and 4 is by design (setupLeads, smoke3.ts L6391-6399) and the harness fixture is a deliberately partial project, so nothing visible in the screenshots is itself a defect; the one finding sourced from them (ctx-28) is marked stubRisk. Three memory moments: storage is legible (dir, kind, meter, dangling/orphan links); capture is not (ctx-03: nativeMemoryWrites has no caller; index mtime/frontmatter never rendered); use is half-legible (the MEMORY.md head meter exists, but the observed InstructionsLoaded record that would confirm what a real launch loaded is unexposed — ctx-02 — and the index body cannot be opened — ctx-12). The two highest-severity items are cheap to confirm at runtime: press the /init CTA with a live claude-code session (ctx-01), and grep preload/index for 'InstructionsLoaded' (ctx-02). Provider mapping used for ctx-04/05/13: claude, glm, deepseek run the claude-code harness (providers.ts L134, L232, L282); codex is its own harness (L170). Sheet and token checks: every --token and class Context.tsx references resolves in index.css/ui.css/policy.css; no NaN/Invalid Date paths found (num() coerces null, ago() returns '—' for 0, share and meter divisions are guarded).

## 1. [honesty/high/medium] The page presents the Claude Code loader as every session's context; `harness` is never read and the Codex AGENTS.md reader is never shown
- where: src/renderer/src/views/Context.tsx:795
- evidence: Head L795: "What a session launched in <path> is told before you type anything." instructions.ts L125 `harness: 'claude-code';` and L27-32: "This chain is Claude Code's loader and nobody else's. Codex reads AGENTS.md natively … `harness` on the result says which loader was predicted so a view never presents this as every agent's context." The renderer's InstructionChain mirror (L45-54) omits `harness`; `grep "\.harness" Context.tsx` is empty. codex-sessions.ts L674 `agentsChain()` returns CodexAgentsChain and has no caller in preload/index/renderer.
- failure: A project whose sessions are all Codex shows "Loads at launch 0 … Lines at launch 0" and a critical "Claude Code will NOT read this project's AGENTS.md" callout, while Codex reads AGENTS.md natively and the numbers describe a launch that never happens there. GLM/DeepSeek are on the claude-code harness (providers.ts L232, L282) so the chain does apply to them, but nothing on screen says which providers this page is about.
- fix: Read `chain.harness`; put "Claude Code sessions — claude, glm, deepseek" in a PageHead eyebrow/lead; add a Segmented harness switch; for Codex render agentsChain() under its own honest heading ("AGENTS.md files Wanigan's Codex compiler writes to; load order not predicted").

## 2. [unfinished/high/small] The setup card's primary CTA "Type /init into a session" is refused by the gate behind skills:send
- where: src/renderer/src/views/Context.tsx:529
- evidence: Context.tsx L529: `await window.wanigan.skills.send(s.id, '/init');`. main/index.ts L2107-2116 routes skills:send through `skills.skillSendDecision(live, invoke)` and throws on `!decision.ok`. skills.ts L665-670: `const skill = wanted ? catalogue.skills.find((s) => s.invoke === wanted) : undefined; ... return { ok: false, code: 'unknown-skill', reason: `${wanted} is not a command in this project’s skill catalogue. Refresh the list and pick a skill from it.` }`. `/init` is a CLI built-in, not a SKILL.md, so the catalogue never contains it. The catalogue gate landed 2026-09-05 (79d7355); the button dates from 2026-08-27 (3b02fec).
- failure: Operator presses the coral CTA on a repo with no CLAUDE.md and gets the info Note "Could not reach a session: /init is not a command in this project’s skill catalogue. Refresh the list and pick a skill from it. Run /init yourself…" — a live session exists, the message is about the wrong thing, and the button can never do what its label and the 60-word explanation beneath it promise. Also L523 picks the first running session for the project regardless of harness; skills.ts L657 then refuses a Codex/generic session with a message about skill invocation forms.
- fix: Either give skillSendDecision a fixed allowlist of Claude Code built-ins ({'/init'} at least) accepted only for harness 'claude-code', or add a narrow sessions:typeCommand IPC for that one command; filter the session pick by harnessId === 'claude-code'; until then replace the button with the command to copy. Add a smoke assertion that the Context CTA's invoke passes skillSendDecision for a claude-code session.

## 3. [unfinished/high/medium] Observed launches (InstructionsLoaded) and reconcileInstructions are recorded and computed but no IPC or surface exposes them
- where: src/main/context/instructions.ts:1014
- evidence: instructions.ts L1014 `export function reconcileInstructions(chain, loaded): InstructionReconciliation | null` and hooks.ts L1133 `instructionsLoaded(sessionId)` / L1153 `instructionsLoadedSessions(projectId)`. `grep -rn "InstructionsLoaded\|instructionsLoaded" src/preload/index.ts src/main/index.ts` returns nothing; the only consumers are smoke2.ts and Timeline.tsx (one glyph row). The view's note L(scan) pushes "Wanigan records those; that record is the ground truth to reconcile against" and renders it as a bullet under "What the scan found" with nothing to click.
- failure: The 'use' moment — which files a real session actually loaded, in what order, launch vs lazy — is invisible on the one view whose subject is "what will my agent know". The operator reads a disk prediction, is told a ground-truth record exists, and cannot see it; a wrong prediction (e.g. the ./CLAUDE.md vs .claude/CLAUDE.md pair the module says the docs leave ambiguous) is never corrected on screen.
- fix: Add `context:reconcile(projectPath, projectId)` (assertManagedRoot) that calls instructionsLoadedSessions → instructionsLoaded → reconcileInstructions; expose via preload `context.reconcile`; render in Section 1 a "Last observed launch · <session> · <ago>" strip and an Observed column (● launch / ◑ lazy / · not named) beside the predicted Loads mark, with predictedOnly/observedOnly counts and a link to the session Timeline.

## 4. [missing/high/medium] Memory capture is not legible: nativeMemoryWrites exists in main with no caller, and the Memory panel never says which session wrote what
- where: src/main/accounts.ts:524
- evidence: accounts.ts L524 `export function nativeMemoryWrites(sessionId): NativeMemoryWrites | null` counts PostToolUse Write/Edit rows inside `<configDir>/projects/<slug>/memory` ("Probed on this machine … 38 PostToolUse Write/Edit rows carried paths inside …memory/, so the saves are hook-visible"). `grep -rn "nativeMemoryWrites(" src` finds no caller outside the definition and smoke. Context.tsx MemoryPanel (L1208-1300) renders only mtime (`ago(f.modified)`) per topic file and no index mtime; `modifiedFrontmatter` (L67) and `counts` (L87) are declared in the renderer mirror and never rendered.
- failure: Of the three memory moments the view must make legible, capture is missing: an operator cannot tell that session X wrote release-checklist.md twenty minutes ago, cannot see when MEMORY.md itself last changed, and cannot tell a Claude-written memory from one appended by something else (the 12.6 MB case memory.ts L(memorySizeNote) describes).
- fix: Expose `context:memoryWrites(projectId, limit)` aggregating nativeMemoryWrites over instructionsLoadedSessions/recent sessions; show in the Memory panel a "Written by" column (session title · ago) per file, the index's own modified date/frontmatter modified beside the meter, and kind counts as chips.

## 5. [bug/medium/small] load() has no generation guard: switching project mid-scan can show project A's data under project B's head and clears busy early
- where: src/renderer/src/views/Context.tsx:427
- evidence: L427-487 `const load = useCallback(async (rescan) => { … setBusy(true); … const [ri, …] = await Promise.allSettled([...]); … setD({ chain, memory, … }); setBusy(false); }, [path, pid]);` and L489 `useEffect(() => { setD(null); setInitMsg(null); void load(false); }, [load]);`. Nothing cancels or ignores an in-flight load when `path` changes; `busy` is a single boolean.
- failure: Pick project B from the select while A's scan (a monorepo walk of up to 20,000 files) is in flight: A's setD lands after the effect's setD(null), so B's header sits over A's chain until B resolves — and if A resolves last it stays. `setBusy(false)` from A re-enables Re-scan while B is still scanning.
- fix: Keep a `useRef(0)` generation; capture it at the top of load and return early before every setD/setBusy if it moved; derive `busy` from `gen === inflight`.

## 6. [honesty/medium/small] AGENTS.md critical callout says "ignored on every single session" and drops the Claude-Code-only scoping main now produces
- where: src/renderer/src/views/Context.tsx:1179
- evidence: Context.tsx L1179-1182: `<Callout level="critical" title="Claude Code will NOT read this project’s AGENTS.md.">Nothing imports it and no CLAUDE.md is a symlink to it, so not one line of it reaches the agent. Whatever it says about this repo is being ignored on every single session.` `a.note` is rendered only in the loaded branch (L1168). instructions.ts L993-996 was rewritten to say "Codex reads AGENTS.md on its own, so this concerns Claude Code sessions only" precisely because the old sentence "was false for every Codex session in this project".
- failure: The renderer re-asserts the sentence main removed as false; an operator running Codex in this repo is told their AGENTS.md is ignored on every session.
- fix: Render `a.note` in the not-loaded branch and scope the title to "Claude Code sessions will not read this project's AGENTS.md".

## 7. [honesty/medium/medium] "No hooks in any layer. Nothing runs automatically" omits the hooks and MCP config Wanigan itself injects at every launch
- where: src/renderer/src/views/Context.tsx:1483
- evidence: Context.tsx L1483-1497: `Hooks — {plural(c.hooks.length,'hook')}` and `No hooks in any layer. Nothing runs automatically around your tool calls.`; section hint L749 "Four layers stack up." config.ts reads only the four settings layers plus plugin hooks.json. sessions.ts L1062 `if (settingsFile) injected.push('--settings', settingsFile);` L1066 `if (mcpFile) injected.push('--mcp-config', mcpFile);` — hooks.ts L318 writeHookSettings registers an http handler for every event in hookEventsFor(cliVersion) (24+ on a current CLI) plus Wanigan's own MCP server.
- failure: A session launched from Wanigan posts two dozen hook events to 127.0.0.1 and connects a Wanigan MCP server; the panel that says it lists "the hooks that will run" and "everything a project injects" reports none of it — the app's own injection is the one thing hidden on the page about injection.
- fix: Add a fifth `from: 'wanigan'` row: "Wanigan adds --settings <hooks file> (N events → 127.0.0.1:<port>) and --mcp-config (<server>) to Claude Code launches", sourced from hooks.hookEventsFor and mcp/registry; note that it is per-launch and outside the repo.

## 8. [honesty/medium/small] Cost per session is priced at Wanigan's default model when settings pick none, and the tile names that model as if the chain selected it
- where: src/renderer/src/views/Context.tsx:1632
- evidence: Context.tsx L462-464 comment: "The budget prices exactly what loads at launch, at whatever model the settings chain actually selected — not a default we invented." L1632-1636: `value={... <Est>{usd(b.usdPerSession)}</Est>}` sub `~{usd(b.usdPerSession*100)} est. per 100 sessions · {b.model}`. config.ts L842: `if (!modelId || !modelId.trim()) return { id: DEFAULT_MODEL, known: true };` L947 only appends "No model was given, so the default (…) was used." into the long `note` string.
- failure: A repo with no `model` key shows "~$0.21 est. per session · claude-opus-5" at Opus list price while the account's real default may be Sonnet; the tile's model suffix reads as an observed selection and the caveat is buried in a 90-word Note.
- fix: Return `modelSource: 'settings' | 'wanigan-default'` from contextBudget; render the tile sub as "at Wanigan's default model — no model set in settings" (or show '—' and a hint) when the source is the default.

## 9. [honesty/medium/small] Memory directory tile asserts "not inside a git repository" for a state main also uses when git could not be run
- where: src/renderer/src/views/Context.tsx:1211
- evidence: Context.tsx L1209-1213: `'project-root': 'keyed off this directory, because it is not inside a git repository'`. memory.ts L315-320: `const repo = repoFor(abs).repo; if (!repo) { // Outside a repo — or with no way to ask git — … return { dir, derivedFrom: 'project-root' }; }` and L670 `if (lookup?.unavailable)` pushes a note that git "is not on the PATH this app inherits". The comment at memory.ts L(git) says collapsing the two "is how the panel came to state 'not inside a git repository' as a fact about the filesystem when all that happened was that a subprocess failed" — the Stat sub still does exactly that.
- failure: App launched from Finder without git on PATH: the tile states the repo is not a git repository, points at the wrong slug, and the correct explanation sits in a bullet at the bottom of the panel.
- fix: Add `derivedFrom: 'git-unavailable'` (or `gitUnavailable: string | null`) to MemoryState and phrase the tile as "keyed off this directory because Wanigan could not run git (…)".

## 10. [honesty/medium/small] "Also injected" lists MCP servers main says will not connect (disabled / unapproved) with no state on the row
- where: src/renderer/src/views/Context.tsx:1559
- evidence: Context.tsx L1559 `<h3 className="ctx-sub">Also injected — …` with rows from `c.mcp` (L1420-1424) carrying only name/transport/target/scope. config.ts L626 `notes.push(`Configured in .mcp.json but disabled for this project, so it will not connect: …`)` and L628 `…not yet approved here, so Claude Code will ask before connecting: …` — approval state exists only as free text in notes.
- failure: A disabled server appears under a heading that says it is injected; the operator has to cross-read a bullet 200px lower to learn it will not connect.
- fix: Add `state: 'approved' | 'unapproved' | 'disabled' | 'unknown'` to McpEntry and render a Mark column; keep the note.

## 11. [missing/medium/small] Permission allow/ask rules are counts only, so a committed `Bash(*)` allow is invisible while project hooks get a supply-chain callout
- where: src/renderer/src/views/Context.tsx:1535
- evidence: Context.tsx L1535-1556: columns `Allow` `Ask` `Deny` as `num(p.allow.length)` etc.; only `p.deny.slice(0, 6)` is listed. config.ts readPermissions (L~390) returns the full allow/ask/deny arrays. The hooks section (L1484-1491) warns "they run on your machine with your permissions. Read the commands below before you trust them"; nothing equivalent for a project-scope allow list.
- failure: A cloned repo's .claude/settings.json can pre-approve `Bash(*)` or `Write(*)`; this panel shows "Allow 1" and nothing else, so the one thing an operator should read before trusting the repo is hidden.
- fix: List allow and ask rules (first 6 + "+N more", full list on disclosure) and raise a warning Callout when a project/local layer allows a wildcard Bash/Write/Edit.

## 12. [missing/medium/small] MEMORY.md — the one memory file that loads at start — cannot be opened or dated in this view
- where: src/renderer/src/views/Context.tsx:1208
- evidence: L1208 `const topics = m.files.filter((f) => !f.isIndex);` — the table (L1250-1300) with the FileBody disclosure is built from `topics` only; `m.index` is used solely in `shows.memory` (L661). The meter (IndexMeter L1332) shows counts but no path, modified time or body.
- failure: An over-budget index says "20 lines dropped" and the operator cannot see which 20 lines here — the reading pane exists for topic files but not for the file it matters for.
- fix: Render an index row above the meter (name, modified via ago/fullDate, link count, FileBody disclosure) and highlight the dropped tail in the reader using loadedLines.

## 13. [polish/medium/medium] The view hand-rolls its head, empty, loading, sub-heads, marks, callouts and chips instead of the shared primitives
- where: src/renderer/src/views/Context.tsx:782
- evidence: Head L782-830 builds `<div className="pane-head"><h1>` by hand (PageHead exists, bits.tsx L245); empty state L577 `<div className="card"><h2 …>` (EmptyState L338); loading L594 `<div className="card chart-empty">Reading …` (Reading L359); 13× `<h3 className="ctx-sub">` (SectionHead L265); local `Mark` L217 with inline `style={{ color }}` shadows bits' tone-based Mark L103; `Callout` L241 duplicates Note with a title; `ctx-chip` (9 uses) is a `*-chip` family CLAUDE.md forbids; L812 `<select className="field" style={{ width: 'auto' }}>` where ui.css L24 `.field.field-inline` exists. Gate baseline for this file is 113 inline style objects (check-renderer-style.cjs L65).
- failure: Context looks and behaves slightly differently from every sibling view (different focus ring, different pressed-chip colour, different sub-head face), and every future primitive fix skips it.
- fix: Migrate head→PageHead(compact), empty→EmptyState, loading→Reading, ctx-sub→SectionHead, filters→Chip, local Mark→bits Mark with a `tone` (add series tones if needed), Callout→Note with a leading <strong> title, ctx-chip→pill; drop the inline width for .field-inline.

## 14. [modernize/medium/medium] Thirteen uppercase-tracked eyebrows, symbol-font glyphs, accent-on-hover paths and four banner styles make the page read as a dense report rather than a scannable tool
- where: src/renderer/src/styles/policy.css:119
- evidence: policy.css L119 `.ctx-sub { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; … }` used 13×; L57 `.ctx-open:hover .ctx-path { color: var(--accent); }`; L91 `.ctx-filter.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }`; Context.tsx L166-215 scope/load marks use ⛨ ⌂ ↑ ◆ ○ § ↳ ● ◑ ⊘ ◇ ✕ ❖ ⧉ from Miscellaneous Symbols (weight varies by fallback font); Callout warning/critical (L241) plus Note info/ok give four banner treatments; instruction rows pack a button, up to five chips and N warning lines into one cell (L920-968).
- failure: Next to Linear/Raycast the hierarchy is carried by tracking and colour rather than size and spacing; the accent (CTA + pressed chip + hover path + focus ring) has no one meaning; rows have no consistent height so scanning the load order is slow.
- fix: Sentence-case sub-heads with tabular counts (SectionHead); Chip with bg-selected for filters; hover = underline/bg-hover, accent reserved for the CTA; one inline alert primitive with a Lucide icon; two-line rows (path + one-line meta) with a trailing status Mark and a chevron `Icon` disclosure, warnings collapsed behind a ⚠ count that expands inline.

## 15. [bug/low/small] Instructions table prints "0" lines for an oversize or unreadable file that was never counted
- where: src/renderer/src/views/Context.tsx:971
- evidence: L971 `<td className="r">{f.exists ? num(f.lines) : '—'}</td>`. instructions.ts L177 `if (size > MAX_LOADED_BYTES) return 0;` (countLinesOnDisk) and record() leaves lines 0 when readCapped fails.
- failure: A 5 MB CLAUDE.md shows "0" lines beside "5.00 MB", reading as an empty file rather than an uncounted one.
- fix: Have main return `lines: null` for uncounted files and render '—'; or in the view treat `f.bytes > 4 MiB || warnings.some(unreadable)` as '—'.

## 16. [bug/low/small] RulesPanel rel() strips the root by prefix without a separator, mangling sibling-directory paths
- where: src/renderer/src/views/Context.tsx:1025
- evidence: L1025 `const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);` versus the correct test at L638 `inProject = (p) => p === project.path || p.startsWith(project.path + '/') || p.startsWith(project.path + '\\')`.
- failure: Root `/Users/x/app` with a user rule symlinked from `/Users/x/app-shared/rules/a.md` renders as `shared/rules/a.md`.
- fix: Reuse inProject's separator check in rel().

## 17. [bug/low/small] The view-scoped focus rule forces border-radius 4px, so pill filter chips change shape on keyboard focus
- where: src/renderer/src/styles/policy.css:9
- evidence: policy.css L9-13 `.ctx :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }` (specificity 0,2,0) beats L85-89 `.ctx-filter { … border-radius: 999px; …}` (0,1,0).
- failure: Tabbing onto "● at launch 3" squares the pill for the duration of focus, then it snaps back.
- fix: Remove `border-radius` from the focus rule (outline follows the element's own radius) or use `outline-offset` only.

## 18. [bug/low/small] Filter chips have no aria-pressed; the active filter is colour-and-class only
- where: src/renderer/src/views/Context.tsx:891
- evidence: L891-899 `<button className={`ctx-filter${only === 'all' ? ' on' : ''}`} onClick=…>` and `<button key={k} className={`ctx-filter${only === k ? ' on' : ''}`} … title={LOADS[k].blurb}>` — no aria-pressed, no role=group. bits.tsx L276 `Chip` renders `aria-pressed={pressed}`.
- failure: A screen reader announces six identical buttons; which set is filtering the table is not announced. Also an accent-filled pressed state (`.ctx-filter.on` L91) diverges from Chip's bg-selected convention.
- fix: Replace with `<Chip pressed count>` inside a `role="group" aria-label="Show"`; delete .ctx-filter.

## 19. [bug/low/small] Memory directory path in a `1fr 1fr` grid can force horizontal overflow of the pane
- where: src/renderer/src/index.css:727
- evidence: index.css L727 `.stat-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }` (min-content minimum, unlike `.stat-grid`'s `minmax(0,1fr)` L725). Context.tsx L1218 `<Stat label="Memory directory" value={<span className="mono" …>{m.dir}</span>}` — no word-break; `.stat-tile` (ui.css L82) sets no overflow. compact.css only collapses to one column at ≤460px.
- failure: `~/.claude/projects/-Users-dane-Projects-drupal-wanigan/memory` in a ~700px pane pushes the column wider than the pane, contradicting policy.css's "The pane never scrolls sideways".
- fix: `minmax(0,1fr)` on .stat-2 and `word-break: break-all` on the value (or `.ctx-path`).

## 20. [honesty/low/small] Learning panel copy over-claims: "a capsule is retrieved for every task" and "the first prompt is the query"
- where: src/renderer/src/views/Context.tsx:1756
- evidence: L1756 sub `'a capsule is retrieved for every task'`; L1770 "the first prompt is the query, and the capsule packs only matching items". sessions.ts L1103 `query: opts.initialPrompt?.trim() ?? ''` (the New Session dialog's optional prompt, at launch, not the first typed prompt); learning-service.ts L1678-1679 delivery is `'append-system-prompt'` for claude-code, `'developer-instructions'` for codex, `'none'` otherwise.
- failure: A session started with an empty initial prompt gets an empty-query retrieval; a generic-cli pack session gets nothing — the panel says both received a capsule.
- fix: Phrase: "Retrieved once at launch from the New Session prompt (empty prompt = empty query); delivered to Claude Code and Codex sessions only."

## 21. [honesty/low/small] Budget ceiling wraps a configured exact setting in the estimate grammar (tilde + est.)
- where: src/renderer/src/views/Context.tsx:1747
- evidence: L1747-1750 `<Stat label="Budget ceiling" value={settings ? <Est>{num(settings.briefingMaxTokens)}</Est> : '—'}` with the comment "denominated in estimated tokens, so it wears the same mark". The view's own rule (L1613-1618) reserves the mark for estimated values; briefingMaxTokens is a stored setting.
- failure: "~4,000 est." beside a value the operator typed into Settings dilutes the one notation the page teaches for estimates.
- fix: Render plain `num(settings.briefingMaxTokens)` with sub "a setting, counted in estimated tokens".

## 22. [honesty/low/small] IndexMeter's Bytes row invents loaded/dropped bytes that main computes but does not return
- where: src/renderer/src/views/Context.tsx:1338
- evidence: L1337-1338 `{ key: 'Bytes', used: b.bytes, limit: b.byteLimit, loaded: Math.min(b.bytes, b.byteLimit), dropped: Math.max(0, b.bytes - b.byteLimit) }`. memory.ts budgetFor tracks `used` (bytes of lines that fit whole) and `cut: 'lines' | 'bytes'` but returns only lines/loadedLines/droppedLines.
- failure: A 300-line, 30 KB index cut at the 200-line cap shows "Bytes: 25.0 KB loads, 5.0 KB dropped" while the real loaded byte count is whatever the first 200 lines weigh; the aria-label and table repeat the invented split.
- fix: Return `loadedBytes` and `cutBy` from budgetFor and use them; say which cap fired.

## 23. [missing/low/small] No "scanned at" time, so an operator cannot tell how fresh the prediction is
- where: src/renderer/src/views/Context.tsx:431
- evidence: L431 `if (rescan) { try { await window.wanigan.context.refresh(path); } catch {} }` — the initial load(false) serves a cache up to 15 s (instructions.ts TTL_MS) / 20 s (config.ts TTL_MS) old and nothing on screen records when the scan ran; InstructionChain has no `scannedAt`.
- failure: After editing CLAUDE.md the operator sees stale numbers with no cue to re-scan.
- fix: Return `scannedAt` from the readers and show "Scanned <ago>" beside Re-scan.

## 24. [polish/low/small] Dead rules .ctx-num and .ctx-kv, and the sheet is still named policy.css
- where: src/renderer/src/styles/policy.css:20
- evidence: policy.css L20 `.ctx-num {…}` and L115-117 `.ctx-kv …` — `grep -rn "ctx-num\|ctx-kv" src/renderer/src` finds no TSX use. L1-5 comment: "The file is still named policy.css because index.css imports it by that name"; the gate lists both names (`'policy.css': 16, 'context.css': 16`, check-renderer-style.cjs L105).
- failure: Two selectors nobody can hit and a sheet a new contributor will not find under the view's name.
- fix: Delete the two rules; rename to context.css and update the @import and the gate entry.

## 25. [polish/low/small] Error copy shipped to the operator speculates about unregistered IPC channels that are all registered
- where: src/renderer/src/views/Context.tsx:279
- evidence: L277-281 PanelError: "If the message says there is no handler, the main process has not registered <channel> yet — the reader module exists, the IPC channel does not." L611-616 likewise: "that is a wiring gap, not a broken project". main/index.ts L2417-2433 registers context:instructions/memory/config/budget/read/memoryBody/agentsMd/refresh.
- failure: A real failure (folder moved, EACCES) is prefaced by a paragraph about a development state that no longer exists.
- fix: Drop the wiring sentence; keep the path/permissions guidance and the retry.

## 26. [polish/low/small] Memory section chip counts the index while the panel heading counts topics
- where: src/renderer/src/views/Context.tsx:736
- evidence: L736 `right={d.memory ? <span className="ctx-chip">{plural(d.memory.files.length, 'file')}</span>` (files includes MEMORY.md, memory.ts L~850) vs L1250 `Topic files — {plural(topics.length, 'file')}`; the screenshot shows "2 files" over a panel listing one topic file.
- failure: Two counts for one directory a few lines apart.
- fix: Chip: "1 topic file + index" or count topics only.

## 27. [polish/low/small] [stubRisk] Browser-harness fixtures for Context disagree with the real types, so the screenshots exercise none of the config/budget panels
- where: scripts/renderer-harness.mjs:202
- evidence: renderer-harness.mjs L202 `{ layer: 'project local', file: '…settings.local.json', exists: false }` (real shape: `layer: 'local', path`), L208 `ctxBudget = { files: [], totalTokens: 0, totalCostUsd: 0, model: null, note: null }` (real: estTokens/usdPerSession/totalBytes/skippedBytes), L195 memory `counts: { instruction, memory, reference, index }` and kinds 'index'/'memory' (real MemoryKind has neither). Context.tsx `LAYER[l.layer]` would be undefined for 'project local' if `shows.config` were ever true.
- failure: Both screenshots show only sections 3 and 4; Settings, Budget, Rules and Instructions panels are never rendered by the sweep, so a regression there stays green.
- fix: Shape the fixtures from the exported types (import them in a typed fixture module) and include one layer with exists:true and one at-launch file so budget and config render.

## 28. [modernize/low/small] The setup card puts ~200 words of prose above its only control
- where: src/renderer/src/views/Context.tsx:1797
- evidence: Setup L1797-1850: title + 38-word paragraph + per-slot `what` (16-26 words) and `how` (10-22 words) for every unfilled slot, then the button at L1835 and a 45-word footnote. In the fixture screenshot the CTA sits ~500px below the section title.
- failure: The page's next action is at the bottom of an essay; Linear/Devin-style setup lists lead with a checklist and a single action.
- fix: Render slots as a checklist row each: status Mark (○ missing / ● present), mono name, one-line `how`, with `what` behind a Hint or title; move the CTA to the card head.

