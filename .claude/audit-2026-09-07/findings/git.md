# Git view (src/renderer/src/views/Git.tsx, styles/git.css, components/ReviewGate.tsx, main/git.ts, main/gh.ts, main/review.ts, main/worktrees.ts)

50 findings. readability={"firstPaintWords": 23, "fontSizesInSheet": 7, "explainerHintNoteUses": 6, "nestedBorderDepth": 1, "notes": "firstPaintWords: title 'Git' + the 22-word lead (Git.tsx:449-450) precede the first control (the repository select). fontSizesInSheet: git.css declares 13 literal px font-size declarations (matches the gate baseline) across 5 distinct literal values (9.5, 11, 11.5, 12.5, 13px) plus var(--t-small) and var(--t-micro) = 7 distinct declared sizes, 6 distinct rendered sizes. explainerHintNoteUses: Git.tsx has Note \u00d74 (466, 574, 575, 585) + ConfirmNote \u00d71 (578), Explainer 0, Hint 0; ReviewGate.tsx Note \u00d71 (38) = 6. nestedBorderDepth: the primary content (commit rows and file rows) sits inside .gt-col separated only by hairline dividers (border-left/border-bottom), i.e. one level of rule, no closed bordered box; the Review gate is a .sunk box holding a bordered .field textarea (depth 2) and the commit textarea is a bordered box inside the column (depth 2)."}

notes: Screenshots (dark-git.png, light-git.png) are entirely stub-driven — scripts/renderer-harness.mjs has no git.status/log/gh fixture, so `st.detached`, `st.operation`, `pr.status.kind`, `pr.checks` all answer as truthy proxies. Consequently 'HEAD (detached)', '↑ ↓' with no digits, 'PR # · 0 · ✓ 0 check ·', '⚠ in progress', 'Pull 0'/'Push 0' and 'changes 0 / stash 0' beside 'No commits yet.' are harness artefacts, not product bugs: gh.ts summariseChecks returns null for an empty rollup (so '0 check' cannot occur) and toPr requires a positive integer number; Pull/Push only append a count when non-zero. No finding above rests on a screenshot alone; each cites TSX/CSS/main-process lines. Already-fixed items re-checked and NOT reported: '-f' branch refusal, stash@{n} validation, subdirectory scoping of reads/acts, 'No commits yet' before a read, view memory and scroll keys, project-id reconciliation, unborn-branch header parsing (all present in current files). Light-theme token check: every custom property used by git.css and Git.tsx (--series-1..4, --claude, --accent-soft, --good-soft, --bg-sunk, --bg-soft, --line-soft, --text-faint, --text-dim, --warning, --bad, --good, --r-sm, --t-small, --t-micro, --s-2, --s-3) is defined in both palettes; no undefined property found. Inline style objects (32 in Git.tsx, 8 in ReviewGate.tsx) are gate-ratcheted and not reported individually.

## 1. [bug/high/medium] Commit graph draws no pass-through lines, so any branch spanning more than one row breaks
- where: src/renderer/src/views/Git.tsx:653
- evidence: Each row's 34px SVG draws only its own parent links: `{c.parents.map((p) => { ... return <path d={`M${cx},${ROW / 2} C${cx},${ROW} ${px},${0} ${px},${down ? ROW : 0}`} .../> })}` (lines 653-663). Nothing emits a vertical segment for a lane whose commit and parent are non-adjacent; main's `assignLanes` (git.ts:420-438) tracks lane occupancy but does not export it.
- failure: On any non-linear history (a 3-commit side branch merged into main) the main lane vanishes for the intervening rows and reappears at the parent, so the graph is unreadable exactly at merges — the one place a graph earns its column.
- fix: Have `log()` emit per-commit `through: number[]` (the lanes still open at that row, straight from the `lanes[]` array in assignLanes) and draw a full-height line per open lane in each row's SVG.

## 2. [bug/high/small] Failed git log/branches/stash reads are rendered as an empty repository
- where: src/main/git.ts:450
- evidence: `if (!r.ok) return [];` in `log` (450), `branches` (500) and `stashes` (518). The renderer then prints `No commits yet.` (Git.tsx:690), an empty branch list and `No stashes.` (863) because `st` was read successfully.
- failure: A 30s timeout on a large or network-mounted repo, or any git error, shows a repository with no history, no branches and no stashes — a claim never observed — with no error anywhere on screen.
- fix: Throw as `status()` does (`if (!r.ok) fail(r.err)`) so `load()`'s catch blanks the workbench and shows the reason, or return `{ok:false, reason}` and render a could-not-read EmptyState per list.

## 3. [modernize/high/large] The diff is squeezed into the 38% right column under the file lists while the wide column holds one-line commit rows
- where: src/renderer/src/styles/git.css:20
- evidence: `.gt { display: grid; grid-template-columns: minmax(0,1fr) minmax(320px, 38%); }` and the detail pane is rendered inside the second `.gt-col`: `{detail && (<div style={{ borderTop: '1px solid var(--line)', flex: 1, minHeight: 0, ... }}>` (Git.tsx:895-900), splitting that column with the changes list.
- failure: Reviewing a diff — the prior review's headline gap — happens in ~500px at 11.5px with the changes list and commit box crowding it; Cursor, Conductor and T3 Code give the diff the main area with a narrow file tree beside it.
- fix: Three-region layout (history | files | diff as main) or a detail mode that swaps the diff into the wide column with Esc/close to return; keep the commit box docked.

## 4. [modernize/high/large] Diff has no line numbers, file segmentation, hunk collapse, word-level highlight, wrap toggle or syntax colour
- where: src/renderer/src/views/Git.tsx:100
- evidence: `{lines.map((l, i) => { const cls = ... ; return <div key={i} className={cls}>{l || ' '}</div>; })}` over the raw `git show --patch` text; `.gt-diff { white-space: pre; overflow: auto; font-size: 11.5px }` (git.css:73-74).
- failure: A reviewer cannot cite a line, jump between files, collapse an unchanged file, or see which token changed — the baseline every competitor's diff pane meets.
- fix: Parse `diff --git` and `@@ -a,b +c,d @@` into per-file blocks with sticky file heads (+n −m from `d.files`), old/new gutters, intra-line highlight for paired −/+ lines, and a wrap toggle.

## 5. [bug/medium/small] Push is enabled on a detached HEAD and the confirm reads 'Push null'
- where: src/renderer/src/views/Git.tsx:532
- evidence: `disabled={!!busy || (st.ahead === 0 && !!st.upstream)}` and `what: ... : `Push ${st.branch} and set origin as its upstream.`` (534-536). `status()` leaves `branch=null` and `upstream=null` when detached (git.ts:359), so the button is enabled and `push()` receives `branch: undefined`, sending a bare `git push`.
- failure: Operator on a detached checkout sees an enabled coral Push, a confirmation sentence 'Push null and set origin as its upstream. This leaves your machine.', and then git's 'You are not currently on a branch' as a red note.
- fix: Disable Push (and Stage all & commit) when `st.detached || !st.branch`, with title 'Detached HEAD — check out a branch to push.'

## 6. [bug/medium/small] Stash pop/apply/drop and per-file stage/unstage are not disabled while an action runs; act() has no re-entrancy guard
- where: src/renderer/src/views/Git.tsx:855
- evidence: `<button className="gt-chip" onClick={() => void act('Pop', () => window.wanigan.git.stashApply(st.root, s.index, true))}>pop</button>` (856) and the `gt-go` buttons at 742 and 776 carry no `disabled={!!busy}`, unlike the checkout/merge chips (822, 829). `act()` (330-340) sets busy but never returns early when busy is already set.
- failure: A double-click on `pop` runs `git stash pop stash@{0}` twice — the second pops the next stash and drops it; overlapping `git add` calls collide on index.lock and surface as red notes; the second act's `finally` clears the first's busy state.
- fix: Early-return in `act` when `busy` is set and add `disabled={!!busy}` to every act trigger (stage/unstage all, +/−, apply/pop/drop, ↻).

## 7. [bug/medium/medium] Merging a worktree branch from the Branches pane bypasses every worktree merge guard
- where: src/renderer/src/views/Git.tsx:829
- evidence: Branches lists every `refs/heads/*` including `wanigan/<slug>-<id>` (git.ts:499) with a `merge` chip → `window.wanigan.git.merge(st.root, b.name)` → `git merge --no-edit <name> --` (git.ts:638). `mergeWorktree` (worktrees.ts:548-645) refuses a dirty worktree, an unknown ahead count and a dirty target, and aborts on conflict; none of that runs here.
- failure: An agent's worktree branch merged from this pane takes the committed half and silently leaves uncommitted work in the worktree; on conflict the main tree is left mid-merge with '⚠ merge in progress' and no abort control (see G-25).
- fix: Read `worktrees.list(st.repoRoot)` (already in preload) and, for a branch checked out in a Wanigan worktree, route `merge` through `worktrees.merge` and label the row with its session; at minimum name the worktree in the confirm sentence.

## 8. [bug/medium/small] Diff classifier fades added/removed lines that begin with ++ or --
- where: src/renderer/src/views/Git.tsx:101
- evidence: `const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : ... l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''` — the header test runs first with no space requirement.
- failure: An added `++i;`, a removed markdown `---` rule, a removed `--flag` shell line, or an added YAML `---` document start renders in `--text-faint` header colour instead of green/red, so real changes disappear into the header tint during review.
- fix: Treat `+++ `/`--- ` (with the space) as meta only before the first `@@` of each file; after a hunk header, `+`/`-` always win.

## 9. [bug/medium/small] Graph geometry uses unfiltered indices while rows are filtered
- where: src/renderer/src/views/Git.tsx:658
- evidence: `const rowIndex = new Map(commits.map((c, i) => [c.hash, i]))` (565) but rows come from `shownCommits.map((c, i) => ...)` (646) and the curve direction is `const down = pi > i;` where `pi` indexes `commits` and `i` indexes `shownCommits`. Lane x-positions also come from the full list.
- failure: Type anything in 'Filter message or author' and the remaining rows draw curves upward to parents that are below them and toward lanes with no rows — a graph that is simply wrong.
- fix: Hide the `gt-graph` column while `commitNeedle !== ''` (the note already says the filter is over loaded rows), or recompute lanes over `shownCommits`.

## 10. [bug/medium/small] Local branches containing a slash are styled as remote refs; tags styled as branches
- where: src/renderer/src/views/Git.tsx:670
- evidence: `className={`gt-ref${r.includes('HEAD') ? ' head' : r.includes('/') ? ' remote' : ''}`}` — `feature/login` gets `.remote` (faint, `--bg-sunk`), `tag: v1.0` gets the accent branch style.
- failure: Ref chips misreport locality: a reviewer scanning for which commits are on the remote reads local topic branches as pushed.
- fix: Have `log()` emit refs as `{name, kind: 'head'|'local'|'remote'|'tag'}` using the `refs/` prefixes from `%D` resolution (or match against `branches()` remote names), and style by kind.

## 11. [bug/medium/small] Checkout of a remote-tracking branch strips only 'origin/', landing other remotes in detached HEAD
- where: src/renderer/src/views/Git.tsx:823
- evidence: `onClick={() => void act('Checkout', () => window.wanigan.git.checkout(st.root, b.name.replace(/^origin\//, '')))}`. `branches()` (git.ts:508) already knows `remote: true` from `refs/remotes/`.
- failure: For `upstream/main` or `fork/feature` the whole name is passed, `git checkout upstream/main --` succeeds in detached HEAD, the view reports 'Checkout done.' and the bar flips to 'HEAD (detached)'.
- fix: Send `{name, remote}` and have main run `git switch -c <short> --track <remote>/<short>` (or `checkout --track`) for remote rows.

## 12. [bug/medium/small] fileDiff failure is presented as 'No textual diff (binary, or a mode change only)'
- where: src/main/git.ts:719
- evidence: `return r.ok ? r.out : '';` and the renderer: `patch: d || 'No textual diff (binary, or a mode change only).'` (Git.tsx:367).
- failure: A `git diff` that timed out or errored (e.g. a locked index, a huge file) reads as a binary/mode-only change and the reviewer moves on.
- fix: `if (!r.ok) fail(r.err)` so the existing catch shows the error; a genuinely empty diff stays ''.

## 13. [bug/medium/small] className 'go' and 'bad' match no rule: branch/stash action chips hug the name, failed gate summary is not red
- where: src/renderer/src/views/Git.tsx:820
- evidence: `<span className="go" style={{ display: 'flex', gap: 5 }}>` (820, 854) — no `.go` rule in any sheet; `.gt-file .p` has no `flex:1` (git.css:59). ReviewGate.tsx:43 `<summary className={r.status === 'passed' ? 'faint' : 'bad'}>` — `.bad` exists only as `.sc-meta .bad` (schedule.css:43).
- failure: In Branches and Stash the checkout/merge/delete and apply/pop/drop chips sit at a ragged x right after each name instead of a right-aligned action column; in the review gate a failed run's '✕ failed' renders in default text colour, distinguishable from passed only by the glyph.
- fix: Add `.gt-file .go { margin-left: auto; display: flex; gap: var(--s-1) }` (drop the inline object) and use `<Mark>`/`tone-bad` in ReviewGate.

## 14. [bug/medium/small] Long diff title overflows the 38% column and inherits the 11px dim uppercase-label style
- where: src/renderer/src/views/Git.tsx:897
- evidence: `<div className="gt-sec-h"><span className="t" style={{ textTransform: 'none', letterSpacing: 0 }}>{detail.title}</span></div>` with `.gt-sec-h { display: flex }` and `.gt-sec-h .t { font-size: 11px; ... color: var(--text-dim) }` (git.css:49-50); no `min-width:0`/ellipsis on `.t`.
- failure: A repo-relative path such as `web/modules/custom/commerce_dynamics/src/Controller/CheckoutController.php` cannot shrink, pushes past the column and gives the whole `.pane` (overflow-y:auto) a horizontal scrollbar; the name of the file under review is the least legible text in the column.
- fix: A `.gt-detail-title` at `--t-small` in `--text` with `min-width:0; overflow:hidden; text-overflow:ellipsis` and a `title=` attribute.

## 15. [bug/medium/small] Refresh button named '↻'; pane tabs, toggle chips and file rows expose no pressed state
- where: src/renderer/src/views/Git.tsx:57
- evidence: `<button className="gt-chip" onClick={onRefresh} title=...>↻</button>` (57-60); pane tabs `className={`gt-chip${pane === p ? ' on' : ''}`}` (701) and the `showAll` chip (626) carry `.on` with no `aria-pressed`; `.gt-file` buttons (735, 769) have `.on` but no `aria-pressed` while `.gt-row` does (648).
- failure: VoiceOver reads '↻, button', 'changes, button' with no state, and the selected file in Changes is not announced; keyboard users cannot tell which pane is open.
- fix: `aria-label="Check pull request status again"`; `Segmented` for the three panes; `aria-pressed` on the toggle chip and `.gt-file` buttons.

## 16. [bug/medium/small] A closed (not merged) PR hides 'Create PR' permanently for that branch
- where: src/renderer/src/views/Git.tsx:512
- evidence: `{pr?.status.kind === 'none' && (<button ... Create PR`; `pickPr` returns 'whatever GitHub touched most recently' when nothing is open (gh.ts:177-183), so a branch with one closed PR reports `kind:'pr', state:'closed'`.
- failure: Operator closes a PR by mistake or resumes the branch later; Wanigan shows 'PR #12 · closed' and offers no way to open a new one.
- fix: Show the button when `kind === 'none'` or `pr.state` is `closed`/`merged`, labelled 'Open another PR'.

## 17. [honesty/medium/small] commitDiff cuts the patch at 400,000 chars with no marker, and a failed `git show` reads as an empty commit
- where: src/main/git.ts:488
- evidence: `return { files, patch: patch.ok ? patch.out.slice(0, 400_000) : '' };` — the renderer's truncation note (Git.tsx:107-111) counts lines only, and `''` is what an empty commit also returns.
- failure: A large commit ends mid-hunk under 4,000 lines and is shown as complete; a `git show` error shows a blank pane titled with the commit as if it changed nothing.
- fix: Return `{patch, truncated, bytes}` and have `Diff` say 'cut at 400 KB'; fail on `!patch.ok`.

## 18. [honesty/medium/small] Opening the view spawns `gh pr list` (a GitHub network call) although the head says Wanigan 'only reads it until you press a button'
- where: src/renderer/src/views/Git.tsx:318
- evidence: `useEffect(() => { void loadPr(); }, [loadPr, branch]);` → `gh.prStatusReport` → `runGh(bin, scope.repoRoot, LIST_ARGS(state.branch))` (gh.ts:234) and, on failure, `runGh(bin, ..., ['auth','status'])` (239). Only the manual ↻ tooltip says 'this asks your GitHub host through gh' (58); the lead reads 'Wanigan only reads it until you press a button here.' (450).
- failure: On open, on every project switch and on every branch change GitHub (or an Enterprise host) is contacted without a press — contrary to CLAUDE.md's 'keep external side effects explicit' — and the sentence on screen implies the opposite.
- fix: Make the first PR read manual (chip: 'Check for a PR · asks GitHub through gh') or add a setting and amend the lead to disclose the automatic gh read; keep the 60s cache.

## 19. [honesty/medium/small] A review gate run in flight is rendered as '✕ running' in the failed style
- where: src/renderer/src/components/ReviewGate.tsx:43
- evidence: `{r.status === 'passed' ? '✓' : '✕'} {r.status}` where `ReviewRun.status` is `'running' | 'passed' | 'failed'` (types.ts:1038) and `runAt` inserts `'running'` rows (review.ts:231) that control.runProof can start concurrently.
- failure: A gate started by a goal's verify task shows in Git as a failure while it is still running.
- fix: Three-way `Mark` (running/passed/failed) via `markOf`.

## 20. [unfinished/medium/medium] commitDiff's per-file numstat is computed on every click and never shown
- where: src/renderer/src/views/Git.tsx:349
- evidence: main returns `{ files: [{path, added, removed}], patch }` (git.ts:482-488); the renderer keeps only `setDetail({ title: `${c.short} · ${c.subject}`, patch: d.patch })`.
- failure: The file list with +/- counts — the first thing every commit/PR viewer shows — costs a `git show --numstat` per click and is discarded; the operator scrolls a raw patch to learn which files changed.
- fix: Render a file strip above the patch (path, +n −m, click to jump to that file's hunk).

## 21. [unfinished/medium/medium] Commit body, author email, branch dates/subjects and stash dates are read and dropped
- where: src/renderer/src/views/Git.tsx:668
- evidence: `log()` returns `body`, `email` (git.ts:462-464); `branches()` returns `at`, `subject` (510); `stashes()` returns `at`, `label` (521). The detail title is `${c.short} · ${c.subject}` (349); branch rows show name and ↑↓ only, subject as a tooltip (816); stash rows show subject only (853).
- failure: No commit message body or date in the detail pane, no 'last commit 3d ago' on branches, so stale-branch triage and reading an agent's multi-paragraph commit are impossible here.
- fix: A commit header block (author, absolute date, body) above the patch; a date column on branches and stashes.

## 22. [missing/medium/medium] An in-progress merge/rebase/cherry-pick/revert is announced but cannot be aborted or continued
- where: src/renderer/src/views/Git.tsx:510
- evidence: `{st.operation && <span className="gt-op">⚠ {st.operation} in progress</span>}`; `status()` detects MERGE_HEAD/rebase-*/CHERRY_PICK_HEAD/REVERT_HEAD (git.ts:391-397); grep finds no abort/continue channel in git.ts or preload.
- failure: After a conflicting `merge` chip the operator is left with the warning, conflicted rows, and a terminal as the only way to `git merge --abort`.
- fix: `git:abortOperation` (`merge|rebase|cherry-pick|revert --abort`) behind ConfirmNote, and `--continue` once conflicts are staged.

## 23. [missing/medium/small] Conflicted files cannot be marked resolved from the view
- where: src/renderer/src/views/Git.tsx:715
- evidence: Conflicted rows are `<button key={f.path} className="gt-file" onClick={() => void openFile(f, false)}>` only — no `gt-go` '+' sibling as changed rows have (776-777) — and 'stage all' maps `[...st.unstaged, ...st.untracked]` (755), excluding `st.conflicted`.
- failure: After resolving a conflict in an editor there is no `git add` here; the Conflicted section can never be cleared from Wanigan.
- fix: Add the stage control on conflicted rows (label 'Mark resolved') and include them in stage all.

## 24. [missing/medium/medium] Worktrees are absent from the repository view that Wanigan itself creates them for
- where: src/renderer/src/views/Git.tsx:612
- evidence: Preload exposes `worktrees.list(repoRoot)`, `status`, `merge`, `remove`, `relink` (preload:226-237); they are used only per session (Sessions.tsx:1645-1694) and for orphans in Settings (4393); smoke3 pins that the palette hint 'does not claim the worktree UI that lives in Settings'. Branches shows `wanigan/*` rows with no link to a worktree or session.
- failure: 'One project's repository' cannot list the agent checkouts branched from it, their dirty/ahead counts or which session owns them; landing agent work means visiting each session.
- fix: A fourth right-hand pane 'Worktrees' over `worktrees.list(st.repoRoot)` with dirty/ahead/session and the guarded merge/remove.

## 25. [missing/medium/medium] A running gate cannot be cancelled and shows no progress
- where: src/renderer/src/components/ReviewGate.tsx:35
- evidence: `run` awaits `window.wanigan.review.run(projectId)`; `COMMAND_TIMEOUT_MS = 10 * 60_000` per command for up to 20 commands (review.ts:9, 15); results are written per command (239) but no `review:cancel` channel exists and the panel only flips the button to 'Running…'.
- failure: A hung `npm test` holds 'Running…' for ten minutes with no stop; the per-command evidence already on disk is invisible until the end.
- fix: `review:cancel` that reuses the existing process-group `stop()`; poll `history` while running to show commands as they finish.

## 26. [polish/medium/medium] Git builds its own chip/section-head/ref families instead of Segmented, Chip, SectionHead and Pill
- where: src/renderer/src/styles/git.css:80
- evidence: `.gt-chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }` (83) and `.gt-sec-h .t { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; ... }` (50) duplicate `.chip[aria-pressed='true']` (a fill, not the accent — ui.css:37-38) and `.sub`; the same `gt-chip` is a filter (626), a tab (701), a benign action (824) and a destructive one (836, 859).
- failure: 'all branches' and 'changes 0' light up in the CTA coral and compete with Push; delete/drop look identical to checkout/apply; the view reads as its own design system beside the rest of the app.
- fix: `Segmented` for the three panes, `Chip` for the toggle, `SectionHead` for section heads, `btn btn-sm` and `btn-danger` for actions, `Pill` for refs and PR state.

## 27. [polish/medium/small] The review gate card takes ~190px above the workbench on every visit
- where: src/renderer/src/views/Git.tsx:612
- evidence: `<ReviewGate projectId={projectId} />` rendered unconditionally between the toolbar and `.gt`; the component is a `section.sunk` with a 52px textarea, two buttons and history (ReviewGate.tsx:36-44). Both screenshots show the history list starting at ~520px of a 1250px frame.
- failure: The least-used control on the page pushes the working surface a third of the way down the window, whether or not a recipe exists.
- fix: Fold it into a fourth right-hand pane ('Gate') with the last run's mark in the tab label, or a remembered disclosure.

## 28. [modernize/medium/medium] Toolbar reads as five text buttons and bare glyphs rather than a branch control with a sync action and a state pill
- where: src/renderer/src/views/Git.tsx:504
- evidence: `<span className="gt-branch">{...}</span><span className="gt-track">{st.upstream ? <>↑<span className="a">{st.ahead}</span> ↓<span className="b">{st.behind}</span> {st.upstream}</> : 'no upstream'}</span>` then a `PrChip` coloured by `PR_TONE` text colour, then Fetch / Pull n / Push n (524-542).
- failure: Branch, tracking, PR and three transport buttons sit as loose text at three sizes; the PR state is a text-coloured pill in the same shape as filters; nothing carries an icon.
- fix: Branch as an icon menu-button (Raycast/Linear style) opening the branch list; one tabular '↑2 ↓0' `Pill`; PR state as a toned `Pill`; a single Sync split-button with Fetch/Pull in its menu and Push as the primary.

## 29. [bug/low/small] 'could-not-read' ✕ posture shown while the first project read is merely in flight
- where: src/renderer/src/views/Git.tsx:479
- evidence: `<EmptyState posture="could-not-read" title="Your project list has not been read yet" ...>` whenever `!projectsRead`; App.tsx sets it true only on success (286) and the refresh catch is empty (430), so in-flight and failed are one flag.
- failure: On a cold start the operator opening Git sees a red ✕ 'could not read' glyph for a read that is simply still running.
- fix: Render `<Reading what="your project list" />` until the shell reports either a list or a failed read (pass a tri-state or `projectsError`).

## 30. [bug/low/small] PR create form is rendered inside a role=status live region
- where: src/renderer/src/views/Git.tsx:585
- evidence: `<Note tone="warn">` wrapping `<input aria-label="Pull request title" ...>` and `<textarea aria-label="Pull request body" ...>` (588-591); `Note` resolves `role` to 'status' for warn (bits.tsx:181).
- failure: Every keystroke in the title/body mutates a live region, which screen readers re-announce.
- fix: Pass `role="none"` (supported by Note) or render the form in a plain `.sunk` panel.

## 31. [bug/low/small] 'gh not installed' state has no refresh, contradicting gh.ts's own promise
- where: src/renderer/src/views/Git.tsx:62
- evidence: The `missing` arm returns only a `<span>` (62-69) — `{refresh}` is omitted — while gh.ts:86-90 says 'an operator who installs gh mid-run should see the chip work on the next refresh, not after a restart.'
- failure: After installing gh the chip stays 'PRs: gh not installed' until the operator switches project or branch.
- fix: Render `{refresh}` in the missing arm.

## 32. [bug/low/small] 'Stash everything with that message' reads the commit textarea that is not on the stash pane
- where: src/renderer/src/views/Git.tsx:866
- evidence: `onClick={() => void act('Stash', () => window.wanigan.git.stashSave(st.root, msg))}` and `Stash everything{msg.trim() ? ' with that message' : ''}` — `msg` is the Commit message textarea rendered only when `pane === 'changes'` (784).
- failure: The button points at 'that message' with nothing visible; a half-typed commit draft becomes a stash label unseen.
- fix: A dedicated stash-message `field` in the stash pane; leave the commit draft alone.

## 33. [bug/low/small] Enter does nothing in the new-branch box; no ⌘Enter to commit
- where: src/renderer/src/views/Git.tsx:911
- evidence: `<input className="field" aria-label="New branch name" ... onChange=... />` and a sibling button with `onClick` — no `<form>`/`onKeyDown`; the commit `<textarea>` (784) likewise.
- failure: Keyboard users type a name, press Enter, nothing happens; every git client and editor commits on ⌘Enter.
- fix: Wrap NewBranch in `<form onSubmit>`; add ⌘/Ctrl+Enter on the commit textarea (guarded by the same disabled conditions).

## 34. [bug/low/small] Ref chips at 9.5px sit below the palette's declared 10px legibility floor
- where: src/renderer/src/styles/git.css:43
- evidence: `.gt-ref { font-size: 9.5px; padding: 1px 5px; ... background: var(--accent-soft); color: var(--accent); }` vs index.css:91-93 '--t-tiny is for a glyph or a unit beside a number, never for a sentence: 10px metadata is the contrast floor this palette refuses.'
- failure: Branch and tag names — the only place a ref name is shown in the log — render below the app's own floor, accent on accent-soft.
- fix: Use `--t-micro` (or the `Pill` primitive) and reserve the accent for HEAD.

## 35. [honesty/low/small] History count reads as a total when the log is capped at 150
- where: src/renderer/src/views/Git.tsx:621
- evidence: `{st ? commits.length : '—'}` beside 'History' while `load()` asks `git.log(s.root, { limit: 150, all: showAll })` (263); the 'loaded' qualifier appears only in the filter note (683).
- failure: Any repo with >150 commits shows 'HISTORY 150' and there is no way to load older commits.
- fix: Show '150 loaded' / '150+' and add a 'Load older' control that raises the limit.

## 36. [unfinished/low/small] Status.subpath is computed in main but the renderer never learns a project is a subdirectory
- where: src/renderer/src/views/Git.tsx:8
- evidence: Renderer `type Status` (8-13) omits `repoRoot`/`subpath` that `GitStatus` carries (git.ts:29-46); every write refuses with a paragraph via `acting()` (298-310) but Commit/Push/Discard render enabled.
- failure: For a monorepo package project every act button is live and each press fails with the same long refusal; the scoping of reads is never disclosed.
- fix: Read `subpath`; show a Note ('Reads are scoped to `packages/web`; writes are off — add `<repoRoot>` as a project') and disable the act buttons with that title.

## 37. [unfinished/low/small] commit --amend is wired end to end with no control
- where: src/preload/index.ts:365
- evidence: `commit: (root, msg, opts?: { amend?: boolean; all?: boolean })`, handler at index.ts:2135 and `if (opts.amend) args.push('--amend')` (git.ts:615); Git.tsx never passes `amend`.
- failure: A capability that rewrites the last commit exists behind the bridge but cannot be reached; a typo in a commit message means a terminal.
- fix: An 'Amend last commit' checkbox next to Commit, behind the T2 ConfirmNote since it rewrites history.

## 38. [missing/low/small] No remotes are read; Push assumes 'origin' exists
- where: src/main/git.ts:659
- evidence: `if (opts.setUpstream && opts.branch) args.push('-u', 'origin', refArg(opts.branch, 'A push'));` and the confirm 'Push ${st.branch} and set origin as its upstream' (Git.tsx:536); grep finds no `git remote` call.
- failure: A repo with no remote or one named `upstream`/`gitlab` shows an enabled Push whose confirmation names a remote that does not exist; the error arrives only after the press.
- fix: Read `git remote` in `status()`; disable Push with the reason when there is none and let the operator pick when there are several.

## 39. [missing/low/small] PR creation ignores unpushed commits and cannot fill the body from them
- where: src/renderer/src/views/Git.tsx:518
- evidence: `setForm({ title: commits.find((c) => c.head)?.subject ?? '', body: '', draft: false, base: '' })`; Create PR is disabled only on `!st.upstream` (513); gh.ts:322 passes `--body=` verbatim.
- failure: With ↑3 showing, the operator opens a PR that lacks three commits; the body is always blank while `gh pr create --fill` and every competitor pre-fill it from `base..HEAD`.
- fix: Refuse or warn when `st.ahead > 0` ('Push 3 commits first'); prefill body from the commit subjects/bodies between base and HEAD.

## 40. [missing/low/small] History filter cannot match a commit hash
- where: src/renderer/src/views/Git.tsx:568
- evidence: `commits.filter((c) => c.subject.toLowerCase().includes(commitNeedle) || c.author.toLowerCase().includes(commitNeedle))`.
- failure: Pasting a sha from a session transcript or a review run finds nothing.
- fix: Add `c.hash.startsWith(commitNeedle)` and update the placeholder.

## 41. [missing/low/small] Review gate shows no exit codes, durations, run time or recipe age
- where: src/renderer/src/components/ReviewGate.tsx:43
- evidence: Render is `<code>{x.command}</code><pre>{x.output || '(no output)'}</pre>` while results carry `exitCode` and `durationMs`, runs carry `startedAt/endedAt`, and `recipe.updatedAt` is returned (types.ts:1035-1039) and unused.
- failure: A failed gate does not say which command failed or its exit code, or how long the run took; the operator reads raw output to find out.
- fix: Per-command `Mark` with exit code and `dur(durationMs)`; run duration in the summary; 'recipe saved 2d ago'.

## 42. [polish/low/small] Cancelling the consent dialog is shown as a red error alert
- where: src/renderer/src/components/ReviewGate.tsx:34
- evidence: `saveRecipeWithConsent` throws `'Cancelled. The review commands were not saved...'` (review.ts:94-96) and the panel does `setError(...)` → `<Note tone="error">` (38), which mounts with role=alert.
- failure: Pressing Cancel produces an error alert for a choice the operator made on purpose.
- fix: Return `{saved:false, cancelled:true}` and show a quiet status note, or swallow the cancel.

## 43. [polish/low/small] Branch rows highlight on hover but are not clickable; remote and local branches interleave by date
- where: src/renderer/src/views/Git.tsx:812
- evidence: `<div key={b.name} className="gt-file" style={{ cursor: 'default' }}>` while `.gt-file:hover { background: var(--bg-sunk) }` (git.css:56); `branches()` sorts current-first then by date over both `refs/heads` and `refs/remotes` (git.ts:513).
- failure: Forty `origin/*` rows interleave with local ones with only a ☁/○ glyph to tell them apart, no filter, and rows that look pressable and are not.
- fix: Group Local / Remote under SectionHead counts, share the filter box, drop hover on non-interactive rows.

## 44. [polish/low/small] Four separate notice bands (error, ok, confirm, PR form) stack above the workbench; the ok note never dismisses
- where: src/renderer/src/views/Git.tsx:574
- evidence: `{err && <div className="gt-notice">...}{ok && <div className="gt-notice">...}{confirm && <div className="gt-confirm">...}{creating && ... <div className="gt-notice">` (574-610), each with `--s-2 --s-3` padding plus the pane's `gap: var(--s-4)`; `ok` is cleared only by the next act or project change (332, 246), and `act()` keeps `ok` when the follow-up `load()` fails.
- failure: 'Commit done.' and 'The last read of this repository failed' stack; 'Pushed.' persists for the session; a fetch's multi-line stderr runs together in a prose Note.
- fix: One notice slot; ok via `announce()`; clear `ok` in `load()`'s catch; `white-space: pre-line` for git output.

## 45. [polish/low/small] Commit rows have no tooltip, hash or absolute date; 'ago' can go negative
- where: src/renderer/src/views/Git.tsx:676
- evidence: `<span className="gt-who">{c.author.split(' ')[0]} · {ago(c.at)}</span>` and no `title` on the row (647); `ago()` returns `${s}s ago` for a negative `s` (bits.tsx:562-564).
- failure: 'Dane · 1095d ago' for a three-year-old commit, an ellipsed subject with no way to read it, and '-340s ago' for a commit authored on a fast clock.
- fix: `title` with short hash, full author and `toLocaleString()`; show the short hash in mono; clamp `ago` at 0.

## 46. [polish/low/small] No loading state between clicking a commit/file and its patch arriving
- where: src/renderer/src/views/Git.tsx:344
- evidence: `setSel({ kind: 'commit', hash: c.hash });` immediately, `setDetail(...)` only after `await window.wanigan.git.commitDiff(...)` (347-349); the previous patch stays on screen under the new highlight.
- failure: For a large commit the row highlights while the pane still shows the last file's diff, which reads as this commit's diff.
- fix: `setDetail(null)` (or a Reading frame) before the IPC call.

## 47. [polish/low/small] The sixth graph lane borrows the Claude brand colour
- where: src/renderer/src/views/Git.tsx:28
- evidence: `const LANE_C = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--accent)', 'var(--claude)'];`
- failure: A commit lane painted in the provider tint reads as 'Claude's commits' beside an accent lane that reads as selection.
- fix: Add `--series-5/--series-6` tokens and drop accent/claude from the lane palette.

## 48. [polish/low/small] Commit textarea re-implements .field
- where: src/renderer/src/styles/git.css:68
- evidence: `.gt-commit textarea { width: 100%; min-height: 58px; resize: vertical; background: var(--bg-sunk); border: 1px solid var(--line); border-radius: 6px; ... font-size: 12.5px; padding: 7px 9px; }` plus its own `:focus` rule (71), duplicating `.field` (index.css:308-313).
- failure: A second input style with a different radius and size next to the `.field` inputs above it.
- fix: `className="field"` on the textarea and delete the rule.

## 49. [modernize/low/small] Status letters are bare coloured mono glyphs with no legend or tooltip
- where: src/renderer/src/views/Git.tsx:771
- evidence: `<span className="st" style={{ color: STAT_TONE[f.untracked ? '?' : f.work] ?? 'var(--text-dim)' }}>{f.untracked ? '?' : f.work}</span>` with `.gt-file .st { width: 12px; font-weight: 700; font-family: ui-monospace; font-size: 11px }` (git.css:58).
- failure: 'M', 'A', 'D', 'R', 'U', '?' rely on git literacy; a rename shows 'R' with no old path; there is no hover word.
- fix: `title="Modified"` etc. and tint the filename (Cursor/VS Code pattern) with the letter as a secondary glyph; show `old → new` for renames (main already skips the source field at git.ts:374).

## 50. [modernize/low/small] No motion or affordance on state change: staged files jump lists, busy is an ellipsis
- where: src/renderer/src/views/Git.tsx:525
- evidence: `{busy === 'Fetch' ? '…' : 'Fetch'}`; rows move between Staged and Changed on the next status read with no transition (`.gt-file` has no `transition`, git.css:54-57), and focus is lost when the pressed `gt-go` button unmounts.
- failure: A stage click feels like nothing happened until the 8-second poll or the reconcile lands; keyboard focus falls to body after every +/−.
- fix: `transition: background var(--mo-state)` on rows, a disabled-with-label busy state, and move focus to the row's new sibling after a stage/unstage.

