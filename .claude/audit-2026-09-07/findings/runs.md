# Runs (HeadlessRuns) view — src/renderer/src/views/HeadlessRuns.tsx, src/renderer/src/styles/runs.css, src/main/headless.ts, src/main/queue.ts

40 findings. readability={"firstPaintWords": 58, "fontSizesInSheet": 4, "explainerHintNoteUses": 4, "nestedBorderDepth": 3, "notes": "firstPaintWords counted from the dark screenshot and confirmed against TSX 408-421: eyebrow (4) + title (1) + lead (25) + '2 projects available' (3) + 'Configure' (1) + 'Start a fan-out' (3) + section sub-line (15) + '1 of 2' (3) + the first control's label 'Run name optional' (3) before the first input. runs.css declares var(--t-small), var(--t-lead), var(--t-micro), var(--t-body). Explainer 0, Hint 0, Note 4 (lines 417, 481, 482, 599) plus one ConfirmNote (616). Primary content depth: .card.hr-launch (1) \u2192 .hr-project-picker 1px line (2) \u2192 .hr-project chip border (3); the detail rows sit card \u2192 .hr-row rule \u2192 details/pre."}

notes: Read-only audit; no repository files were touched. Screenshots: the blank Provider select and the absent trust Note in both shots are harness artifacts — scripts/renderer-harness.mjs:57-60 gives every provider `capabilities: {}` so `installed` (TSX 139) is empty; the underlying no-provider state (R13) is confirmed from the code path, not the image. Everything else was checked against TSX/CSS/main. The DIN stencil face appears at exactly one site in this view (line 408), so the typography concern here is the eyebrow's content (slogan) rather than spread. Recent commits (f58254f today, 0d2dc7a/efb7cb2 yesterday) fixed the all-projects declaration, argv/recipe injection and dead CSS; none of the findings above re-report those — R1 and R2 are new interactions of today's `projectKey` change (which correctly protects `chosen` from project identity churn) with the provider effect and tab mounting that still reset on churn. smoke3.ts 5485-5580 pins the loaded gate, rows-keyed-to-run and fingerprint behaviours; nothing here contradicts them. Contrast figures in R33 were computed from the palette hexes in index.css:71-84 and 180-193.

## 1. [bug/high/small] Window focus resets model, effort and provider options mid-form
- where: src/renderer/src/views/HeadlessRuns.tsx:159
- evidence: Effect deps `}, [providerId, provider?.launchFields, modelField?.defaultValue, effortField?.defaultValue]);` (149-159) call setModel/setEffort/setProviderOptions to defaults. App.tsx:286 `setProviders(pv); setProjects(pj);` runs unconditionally from loadShell, which App.tsx:456 fires on every window focus (`const onFocus = () => { void loadShell().catch(() => {}); };`). providers.ts:728-729 `launchFieldsFor` maps to fresh objects, so `provider?.launchFields` is a new reference each time.
- failure: Operator picks a model and a reasoning effort, switches to a terminal to check something, comes back: both selects and every provider-specific option are back at their defaults. With a required select the Start button also flips back to disabled with a 'is required' warning the operator already satisfied.
- fix: Key the effect on a stable fingerprint (providerId + JSON of launchFields ids/defaults), or make App compare provider shape before setProviders the way it already does for projects/sessions.

## 2. [bug/medium/medium] Form draft is destroyed by leaving the tab
- where: src/renderer/src/views/HeadlessRuns.tsx:117
- evidence: All form state is component-local useState (`const [name, setName] = useState('')`, `const [prompt, setPrompt] = useState('')`, chosen at 93, budget 122) and App.tsx:1295 mounts the view conditionally: `{tab === 'runs' && <HeadlessRuns projects={projects} providers={providers} />}`.
- failure: Draft a three-paragraph task, press ⌘9 to check a branch in Git, press ⌘0 to return: prompt, run name, selection, budget and timeout are all gone. Other views (Batches, Git, Sessions, Settings) persist drafts through prefs; this one does not.
- fix: Persist the draft (prompt, name, chosen ids, budget, minutes, isolate, providerId) via prefs.set('runs.draft', …) on change and hydrate on mount, or lift the draft into App state.

## 3. [bug/medium/small] Clicking a 'run finished' notification selects the newest run, not the one named
- where: src/renderer/src/App.tsx:900
- evidence: App.tsx:898-900 `window.wanigan.on.notificationOpened((route) => { if (route.kind === 'session') {…} else go('runs'); });` drops route.runId. HeadlessRuns.tsx:76 takes only `{ projects, providers }` and load() at 193 does `setSelected((old) => old && next.some(…) ? old : (next[0]?.id ?? null))`.
- failure: Two fan-outs running; the older one finishes and macOS shows 'nightly audit finished · 2 succeeded, 1 errored'. Clicking it opens Runs with the newer run selected; the operator has to find the one the banner was about.
- fix: Pass a `revealRunId` prop (like Settings' `jump` at App.tsx:1297) and setSelected to it on change.

## 4. [bug/medium/small] Cancelled repositories are counted nowhere
- where: src/main/headless.ts:1550
- evidence: headlessRuns() counts `h.status='succeeded'` (1550), `IN ('errored','timeout')` failed, `'blocked'`, and `IN ('pending','running')` open (1553); 'canceled' is in none. HeadlessRuns.tsx:530 prints `{r.succeeded} passed · {r.failed} failed · {r.blocked} blocked · {r.open} open` and the Succeeded Stat sub at 562 `${num(current.failed)} failed · ${num(current.blocked)} blocked`.
- failure: Cancel a 5-repository fan-out before agents spawn: history row reads '0 passed · 0 failed · 0 blocked · 0 open' and the Succeeded tile '0 · 0 failed · 0 blocked' — five repositories vanish from every count and the run looks like it did nothing rather than was stopped.
- fix: Add a `canceled` count to HeadlessRun (one more subquery) and print it; show the run status as a Pill (Cancelled) instead of relying on counts.

## 5. [bug/medium/small] A non-numeric budget silently becomes 'no budget flag'
- where: src/renderer/src/views/HeadlessRuns.tsx:309
- evidence: `const perRepoBudget = Math.max(0, Number(budget) || 0);` with a free-text input at 474 (`<input className="field" inputMode="decimal" value={budget} …/>`), canStart at 310-311 never checks it, and headless.ts:306 passes the flag only when > 0: `...(cfg.maxBudgetUsd > 0 ? ['--max-budget-usd', String(cfg.maxBudgetUsd)] : [])`. The only 'no budget flag passed' copy (501, 504) appears when every project is selected.
- failure: Type '2,50' or '$2' (or clear the field) for a three-of-eight fan-out: the field still reads as a budget, the button says 'Run in 3 repos', and the agents launch with no --max-budget-usd at all.
- fix: Validate: type=number min=0 step=0.01; when the parsed value is 0 or the string is non-numeric, show an inline 'No budget flag will be passed — nothing caps spend' beside the field and require an explicit tick, not only in the all-projects declaration.

## 6. [honesty/medium/small] '$0.00 · CLI-reported; never estimated' on a run where no agent has reported
- where: src/renderer/src/views/HeadlessRuns.tsx:390
- evidence: `if (ran.length === 0) return { kind: 'reported' as const, missing: 0 };` (389-390) where ran = succeeded|timeout rows. The Cost Stat then prints `usd(totals.cost)` (573) = '$0.00' with sub `'CLI-reported; never estimated'` (579). headless.ts:1577 makes the same choice for the history row: `Number(r.priceable) === 0 … ? 'reported'`.
- failure: Select a run whose rows are all running, all pending, all blocked by trust, or all cancelled: the Cost tile states a CLI reported $0.00 and that nothing was estimated, while no CLI has reported anything. Mid-run this is a live wrong number that changes to the real one minutes later.
- fix: Add a fourth kind ('none') when ran.length === 0: value '—', sub 'no repository has reported yet' / 'no agent ran'. Mirror in headlessRuns costStatus.

## 7. [honesty/medium/small] Budget field shown for Codex, which has no budget flag
- where: src/main/headless.ts:280
- evidence: `// Codex has no budget flag of its own and reports no cost, so cfg.timeoutMs is the only ceiling a Codex row has.` and the codex-json argv (282-290) carries no budget. HeadlessRuns.tsx:474 renders 'CLI budget / repository' for every provider, and the lead at 411 says 'Each repository gets its own timeout and CLI budget'.
- failure: Operator selects Codex, sets $2 per repository, reads the lead sentence, and believes spend is capped; nothing is, and the row will also show 'no cost reported' afterwards.
- fix: Expose a per-provider 'budgetFlag' capability on ProviderInfo and hide/disable the field with 'Codex takes no budget flag; the timeout is the only ceiling' when it is false. Fix the lead to match.

## 8. [missing/medium/medium] The run's event log is written for this surface and no surface can read it
- where: src/main/headless.ts:1007
- evidence: `logEvent(runId, 'warn', `${row.project_name}: running with no policy gate — ` + (… 'Hooks are off in Settings' …) + ', so nothing this agent does reaches the ledger.')`; also 885 blocked-by-trust, 1244 'reported no cost. Recorded as $0.00', 1637 'Cancelled — N running agents stopped, N repositories dropped', 596 restart sweep. db.ts:1347-1350 inserts into `events`; grep finds no IPC handler or preload method reading events by run_id.
- failure: A Trusted fan-out ran at bypassPermissions with hooks off; the row shows 'succeeded · 3 files · $0.41' and nothing on screen says its actions never reached the ledger. 'Nothing happens you can't see afterward' is written to a table with no reader.
- fix: Add headless:events(runId) → SessionEvent-like rows and a 'Run log' list under the stats (warn/error first).

## 9. [missing/medium/medium] Pending rows never say why they are waiting
- where: src/renderer/src/views/HeadlessRuns.tsx:607
- evidence: Row prints `{row.status}` = 'pending'. Rows are dispatched through the queue (index.ts:946-949 `queue.enqueue('headless', `${name} · ${runId}`, { runId, projectId })`), which records the reason in blocked_by (queue.ts:358-362 'All N headless slots are busy — this starts when one frees up.'), but the view never calls queue.list() or subscribes to on.queueChanged (preload:252, 729).
- failure: An 8-repository fan-out with headless slots at 3 shows five rows 'pending · 0 files · $0.00' for the whole run with nothing that says a slot limit is the reason or where to raise it.
- fix: Join queue items by payload (runId, projectId) into HeadlessRowSummary (a `waitingBecause` string) or show the slot count and 'N queued behind M slots' in the detail title.

## 10. [missing/medium/small] Duration, exit code, worktree path and account are recorded but not shown
- where: src/renderer/src/views/HeadlessRuns.tsx:607
- evidence: headless.ts:1249 writes `status=?, cost_usd=?, cost_reported=?, duration_ms=?, exit_code=?, output=?, error=?, files_changed=?, worktree=?, ended_at=?, account_id=?`; HeadlessRowSummary carries durationMs, exitCode, worktree, startedAt, endedAt (types.ts:983-991); the row line prints only status, files, cost. bits.tsx:539 already exports dur().
- failure: A 'timeout' row does not say it ran 15m; a 'succeeded' row with a worktree does not say where it is, so the operator cannot open the diff before pressing Squash merge; the account the row billed is invisible.
- fix: A meta line `dur(durationMs) · exit N · <worktree path>` with a Reveal action (browse.reveal exists, preload:508) and the account label.

## 11. [polish/medium/small] Hand-rolled page head: title scrolls away and the eyebrow is a slogan
- where: src/renderer/src/views/HeadlessRuns.tsx:406
- evidence: `<header className="hr-head">` with `<span className="label-stencil">Headless runs · unattended workflows</span>` (408). index.css:684-693 gives sticky/rule treatment only to `.pane > .pane-head:first-child`; bits.tsx:241-244: 'The eyebrow is the view's section noun or nothing — never an app-name slogan and never an accent kicker'. Runs is one of the views not using PageHead.
- failure: On a long history the title leaves the screen (the defect index.css:671-677 describes); the eyebrow restates the title and adds a tagline, unlike Fleet/Control/Git/Settings.
- fix: `<PageHead eyebrow="Manage" title="Runs" lead={…} actions={<Pill …/>} />`, delete .hr-head, .hr-head-copy, .hr-head-status.

## 12. [polish/medium/small] Private head/pill families duplicate SectionHead, Pill and sec-count
- where: src/renderer/src/styles/runs.css:23
- evidence: `.hr-head-status, .hr-step, .hr-count { … border-radius: var(--r-pill); … }` and `.hr-section-head` (29-31) reimplement ui.css:31-33 `.sec-head/.sec-count` and index.css `.pill`. TSX 420-423, 484, 517 use them instead of SectionHead/Pill.
- failure: Three pill styles on one screen (accent step, grey count, grey status) that match no other view's section heads; CLAUDE.md asks new UI to compose the primitives rather than add *-head/*-chip families.
- fix: SectionHead label='Recent runs' count={runs.length}; Pill tone='quiet' for the project count; drop the step pills.

## 13. [bug/low/small] Run status printed as a raw enum, and 'canceling' is outside the type
- where: src/renderer/src/views/HeadlessRuns.tsx:558
- evidence: `<p className="faint" aria-live="polite" aria-atomic="true">{current.model} · {current.status} · {current.open} open</p>`. headless.ts:1600 writes `UPDATE runs SET status='canceling'`, but types.ts:1018 declares `status: 'submitting' | 'in_progress' | 'ended' | 'failed'`.
- failure: The detail line reads 'claude · in_progress · 2 open' and, after Cancel run, 'claude · canceling · 2 open' — an underscore identifier announced by the live region; the type lies about what can arrive.
- fix: Add 'canceling' to HeadlessRun.status; render status through a word map and a Pill (Live / Stopping / Ended).

## 14. [bug/low/small] --code-fg is read but defined in no sheet; monospace stack spelled literally
- where: src/renderer/src/styles/runs.css:94
- evidence: `.hr-output pre { … background: var(--code-bg, var(--bg)); color: var(--code-fg, var(--text-dim)); … font: var(--t-small)/1.55 ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace; }`. index.css defines --code-bg at 152 and 216 only; grep finds no --code-fg anywhere. index.css:89 defines `--mono`.
- failure: The fallback always wins, so a future --code-bg retune changes the pane background with no matching foreground token to follow; the literal font stack drifts from --mono if that token changes.
- fix: Define --code-fg beside --code-bg in both palettes (or drop the var), and use `font: var(--t-small)/1.55 var(--mono)`.

## 15. [bug/low/medium] After a successful squash merge the row still offers 'Squash merge…' and says nothing
- where: src/renderer/src/views/HeadlessRuns.tsx:366
- evidence: `if (!r.merged) throw new Error(r.detail); setConfirmMerge(null); await load();` — r.detail on success ('Squashed N commits, touching N files', worktrees.ts:635-640) is discarded; the rows effect is keyed to `signature` (250) which a merge does not change; runMerge (worktrees.ts:548-640) never touches headless_rows.worktree, and the button condition at 608 is `row.worktree && row.status === 'succeeded'`.
- failure: Press Squash merge, confirm: the ConfirmNote closes and nothing else changes — the same button is still there. Press it again and the error at the top of the page says 'has no commits that main does not already have — nothing to merge'.
- fix: Show r.detail in an ok Note beside the row, bump rowsNonce, and record the merge on the row (a merged_at column or null the worktree) so the button becomes 'Merged'.

## 16. [bug/low/small] Merge and cancel errors appear at the top of the page, not where the action was
- where: src/renderer/src/views/HeadlessRuns.tsx:417
- evidence: `{err && <Note tone="error">{err}</Note>}` sits above the launch card; merge() sets it at 368 and cancel() at 337 from the bottom of the workspace; it has no onDismiss and is cleared only by the next start (315).
- failure: Squash merge a row at the foot of a twelve-row run: the failure detail renders roughly a screen and a half above the button, out of view, and stays there while the operator switches to other runs.
- fix: Render merge failures inside the row (replace the ConfirmNote with an error Note), cancel failures under the detail title, give the Note onDismiss, and clear err on selection change.

## 17. [bug/low/small] Cancel run has no busy state or result feedback
- where: src/renderer/src/views/HeadlessRuns.tsx:336
- evidence: `try { await window.wanigan.headless.cancel(current.id); await load(); }` discards the returned count; headless.ts:1637 logs 'Cancelled — N running agents stopped, N repositories dropped before starting' only to the unread events table; the button at 559 is never disabled while the call is in flight.
- failure: Press Cancel run: nothing visibly acknowledges it until rows close out; a second click sends a second cancel; the operator never learns how many agents were actually signalled versus dropped.
- fix: Disable while pending, then an ok Note with the returned count ('Stopped 2 agents, dropped 3 queued repositories').

## 18. [honesty/low/small] History count is capped at 50 but presented as the database count
- where: src/renderer/src/views/HeadlessRuns.tsx:517
- evidence: `<span className="hr-count">{loaded ? runs.length : '—'}</span>` fed by `window.wanigan.headless.runs(50)` (185); comment at 514 'The count is a claim about the database'.
- failure: An operator with 60 runs sees '50'.
- fix: Return a total from headless:runs or label the pill '50 most recent'.

## 19. [honesty/low/small] Copy promises an isolated worker regardless of the checkbox and trust
- where: src/renderer/src/views/HeadlessRuns.tsx:447
- evidence: `Wanigan launches an isolated worker for each selected repository.` and lead 411-412 'isolated worktrees stay on by default'; the checkbox at 475 can be off, and headless.ts:913 `if (cfg.isolate && gate.mode !== 'plan')` never creates a worktree for a read-only project.
- failure: With 'isolate in worktrees' unticked the sentence above the prompt still says the worker is isolated; a read-only repository is never isolated even when ticked.
- fix: Key the sentence to `isolate`, and note under the checkbox that read-only projects run in place.

## 20. [honesty/low/small] Provider id printed in the model slot
- where: src/main/headless.ts:748
- evidence: `model: cfg.model?.trim() || cfg.providerId,` and HeadlessRuns.tsx:558 prints `{current.model} · …`.
- failure: A run launched with the provider default model reads 'claude · ended · 0 open', presenting an id as a model name.
- fix: Carry providerId on HeadlessRun; print 'Claude Code · provider default model'.

## 21. [honesty/low/medium] Trust warning names 'this project' on a multi-repository form and hides which chips will be blocked
- where: src/renderer/src/views/HeadlessRuns.tsx:482
- evidence: `{provider.label} is allowed only when this project is Trusted: Wanigan cannot enforce its Claude-style unattended policy boundary yet.` The main check (headless.ts:644) refuses the whole start naming only the first non-Trusted project; Project (types.ts:175-179) carries no trust so the picker cannot mark them.
- failure: Select Codex and five repositories, one of them Project-trust: the note talks about 'this project', the chips look identical, and the refusal on Start names one repository the operator then has to hunt for.
- fix: Read trust per project (policy namespace) and mark chips 'not Trusted — will be blocked'; reword: 'Codex runs unattended only in Trusted repositories; 1 of your 5 is not.'

## 22. [honesty/low/small] Errored rows print '$0.00' as a measured figure
- where: src/renderer/src/views/HeadlessRuns.tsx:67
- evidence: `if (row.status !== 'succeeded' && row.status !== 'timeout') return usd(row.costUsd);` — costReported is ignored for 'errored'; headless.ts:1241 only warns for succeeded/timeout although an errored agent (is_error result) can carry a cost or none.
- failure: A repository whose agent crashed after spending, and one whose agent never reported, both read 'errored · 0 files · $0.00'.
- fix: Apply costReported to every row with exitCode !== null; print 'no cost reported' for unreported ones.

## 23. [unfinished/low/small] Empty Provider dropdown with no explanation when nothing headless-capable is installed
- where: src/renderer/src/views/HeadlessRuns.tsx:426
- evidence: `const installed = providers.filter((p) => p.path && p.capabilities.headlessJson);` (139); effect at 161-165 sets providerId to '' when none match; 426-428 renders `<select className="field" value={providerId}…>{installed.map(…)}</select>` with zero options; the submit copy at 508 says only 'complete provider requirements'. providers.ts:509 makes headlessJson false for a local pack until its adapter is trusted. (The screenshots show this state, but only because renderer-harness.mjs:57-60 fixtures carry `capabilities: {}` — a stub artifact; the code path is real.)
- failure: An operator whose only providers are untrusted local packs, or who has no CLI on PATH, sees a blank dropdown and a disabled 'Run in 0 repos' with copy that never names the cause.
- fix: When installed.length === 0 replace the form head with an EmptyState: 'No installed provider declares a headless protocol — install Claude Code or Codex, or trust a pack's capability adapter in Settings.'

## 24. [missing/low/small] Zero registered projects renders an empty picker and 'Run in 0 repos'
- where: src/renderer/src/views/HeadlessRuns.tsx:486
- evidence: `{projects.map((p) => <button …>)}` with no empty branch; head copy at 484 `{chosen.size} selected · each receives the same task independently.`; button at 508 `Run in ${chosen.size} repo…`.
- failure: A fresh install lands on a Repositories box containing nothing, '0 selected', and a disabled button, with no route to add a project.
- fix: EmptyState posture nothing-yet with 'Add a project' pointing at Settings/Sessions.

## 25. [missing/low/medium] Policy ledger for a fan-out row is unreachable from the run
- where: src/main/headless.ts:474
- evidence: `const hookSessionId = (runId: string, projectId: string) => `h_${runId}__${projectId}`;` registers a policy context per row; preload:338 `ledger: (limit?, deniedOnly?)` is global and LedgerEntry (types.ts:1929) has sessionId but nothing filters by it.
- failure: The operator sees 'succeeded · 3 files' and cannot get from that row to the list of tool calls Wanigan allowed and denied for it.
- fix: Add a sessionId filter to policy:ledger and a 'Ledger' link per row.

## 26. [missing/low/small] A scheduled run does not say which schedule started it or what budget it used
- where: src/main/headless.ts:26
- evidence: `scheduleFire?: ScheduleFire;` lives only inside config_json; HeadlessRun (types.ts:1015-1031) has no schedule field; index.ts:880 names the run `${from ?? 'scheduled'} · ${new Date().toLocaleString()}` and passes SCHEDULED_BUDGET_USD / SCHEDULED_TIMEOUT_MS the view never shows.
- failure: Two runs named 'nightly audit · 9/7/2026, 3:00:12 AM' with no link back to the schedule and no statement of the budget the scheduler chose on the operator's behalf.
- fix: Carry scheduleId/name, maxBudgetUsd, timeoutMs and providerId into HeadlessRun; print 'from schedule X · $N/repo · 15 min' under the title.

## 27. [missing/low/medium] The prompt and settings a past run was launched with are not visible
- where: src/renderer/src/views/HeadlessRuns.tsx:558
- evidence: Detail title shows `{current.model} · {current.status} · {current.open} open`; HeadlessRun has submittedAt/endedAt/totalRequests (types.ts:1024-1026) and config_json holds prompt, timeoutMs, maxBudgetUsd, isolate — none is surfaced.
- failure: Reviewing yesterday's run, the operator cannot see what task was sent, how long each repository was allowed, or whether isolation was on.
- fix: A collapsed 'Configuration' Reading block with prompt, provider, budget, timeout, isolate, and wall-clock (submittedAt→endedAt).

## 28. [polish/low/small] '1 files'
- where: src/renderer/src/views/HeadlessRuns.tsx:607
- evidence: `<span className="faint">{row.status} · {row.filesChanged} files · {rowCost(row)}</span>`
- failure: A row that changed one file reads 'succeeded · 1 files · $0.41'.
- fix: Pluralise (the ConfirmNote at 617 already does).

## 29. [polish/low/small] Three vocabularies for one outcome and raw status words
- where: src/renderer/src/views/HeadlessRuns.tsx:530
- evidence: History: `{r.succeeded} passed`; Stat label 'Succeeded' (562); row `{row.status}` prints 'succeeded', 'errored', 'timeout', 'canceled' verbatim (607); button 'Run in N repos' (508) vs 'repositories' everywhere else.
- failure: The same repository is 'passed' on the left and 'succeeded' on the right; 'timeout' and 'errored' are not sentences an operator would write.
- fix: One STATUS_WORD map (Succeeded / Failed / Timed out / Blocked / Cancelled / Waiting / Running) rendered through Pill tones; 'repositories' throughout.

## 30. [polish/low/small] 'Run name optional' reads as one three-word label
- where: src/renderer/src/styles/runs.css:35
- evidence: `.hr-field .label em { font-family: inherit; font-style: normal; font-weight: 500; … color: var(--text-faint); }` for TSX 425 `Run name <em>optional</em>`; dim vs faint differ by a few luminance points (#c5b9a6 / #b4a895 dark), and both screenshots show a run-on label.
- failure: The optionality is invisible; the operator reads 'Run name optional' as the field's name.
- fix: 'Run name · optional' or move 'optional' into the placeholder/Hint.

## 31. [polish/low/small] The every-repository declaration is engineering rationale addressed to the operator
- where: src/renderer/src/views/HeadlessRuns.tsx:503
- evidence: `Selecting every repository is the one request that reaches the runner looking exactly like a payload that named none, so it is said here rather than inferred. Right now that is all {projects.length} of them, at {usd(perRepoBudget)} each.`
- failure: 'runner' and 'payload' are internal words; the operator has to read two sentences to learn the one fact they need (all N, $X each, up to $Y).
- fix: Checkbox label 'Run in all N registered repositories — up to $Y if each spends its $X budget'; keep the why in a Hint.

## 32. [polish/low/small] 'Select all projects' sits in the launch footer, not the picker it acts on
- where: src/renderer/src/views/HeadlessRuns.tsx:479
- evidence: The button is rendered inside `.hr-launch-footer` beside the budget and isolate controls, above the `.hr-project-picker` (483) whose chips it selects; both screenshots show it on the budget row.
- failure: A control that edits the box below it lives in the row about budget and worktrees.
- fix: Move it into `.hr-project-picker-head`'s right slot (or SectionHead right).

## 33. [polish/low/small] Several small aria misuses
- where: src/renderer/src/views/HeadlessRuns.tsx:528
- evidence: History items use `aria-pressed={r.id === selected}` for a single-select list (528); `<div className="hr-provider-fields" aria-label="Provider-specific options">` has no role (449) so the label is not announced; 'Squash merge…' has aria-expanded with no aria-controls (609); `<section className="card hr-detail">` has no accessible name unlike its siblings (536); run names are ellipsised (runs.css:73) with no title (529).
- failure: A screen reader hears 'pressed' toggles that cannot be unpressed, an unlabelled group, and an expander pointing nowhere; a long run name cannot be read in full.
- fix: role=listbox/aria-selected or aria-current on the history; role=group on the provider fields; aria-controls ids; aria-labelledby on the detail card; title on the name.

## 34. [polish/low/small] Selection painted with the accent instead of --bg-selected; light-theme pairs dip under 4.5:1
- where: src/renderer/src/styles/runs.css:72
- evidence: `.hr-run.on { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }`, `.hr-project.on` (61) and `.hr-step` (27) all use accent/accent-soft. index.css:58-64 names --bg-selected 'the one fill for "this row is chosen" … so selection can leave the accent', already used by ui.css:49 chips and :66 segmented and control.css:47. Measured: light accent on accent-soft 4.54:1, light faint on accent-soft (selected run's small text) 4.41:1 against the 4.5:1 contract at index.css:50-52.
- failure: The one coral hue does CTA, selection, step pills, checkmarks, focus and checkbox tint on this screen, and the selected run's timestamp is below contract in light mode.
- fix: Use --bg-selected with the plate-red inset like control.css:47; drop accent from .hr-step.

## 35. [modernize/low/medium] '1 of 2' / '2 of 2' wizard pills on a one-page form
- where: src/renderer/src/views/HeadlessRuns.tsx:422
- evidence: `<span className="hr-step">1 of 2</span>` on the card head and `2 of 2` (484) on the nested picker inside the same card; the form reads 'Choose the agent and guardrails first, then pick the repositories'.
- failure: Numbered steps imply paging that does not exist; the accent pills compete with the only real CTA.
- fix: The Linear/Conductor composer shape: the task textarea first and largest, a single compact row of chips beneath it (provider · model · effort · timeout · budget), repositories as a checklist, and one sticky primary button. No step numerals.

## 36. [modernize/low/small] History rows are three lines of 11px faint text with no state glyph
- where: src/renderer/src/styles/runs.css:74
- evidence: `.hr-run span, .hr-run small { color: var(--text-faint); font-size: var(--t-micro); line-height: 1.4; }` for TSX 528-533 which prints name, 'N passed · N failed · N blocked · N open', cost · ago. A live run is distinguishable only by 'open' being non-zero.
- failure: Scanning ten runs for the one still live or the one that failed means reading forty numbers, most of them zero.
- fix: Devin/Cursor-style row: name, a Pill (Live / Ended / Cancelled), a compact '3/4 ✓' with failure counts only when non-zero in tone colour, cost and time right-aligned in tabular numerals; zeros muted.

## 37. [modernize/low/medium] Repository chips show only a name; no branch, trust, or checkbox affordance
- where: src/renderer/src/views/HeadlessRuns.tsx:486
- evidence: `<span aria-hidden="true" className="hr-project-mark">{chosen.has(p.id) ? '✓' : '+'}</span>{p.name}` in a bordered circle (runs.css:62); Project carries `branch` (types.ts:179) that is never shown.
- failure: The operator fans out to 'storefront' without seeing it is on a feature branch or that it is read-only and will be blocked.
- fix: A checklist with checkbox, name, branch in mono, trust Pill, and a 'Select all (N)' at the head — the same list Sessions' launch dialog already knows how to draw.

## 38. [modernize/low/medium] Output is a 260px <pre> behind a disclosure with no copy or open actions
- where: src/renderer/src/styles/runs.css:94
- evidence: `.hr-output pre { max-height: 260px; overflow: auto; … }` under `<details className="hr-output">` (TSX 628-649); stderr and result text are merged into one block by headless.ts:1224-1228.
- failure: Reading a 64 KB output means scrolling a small box; nothing copies it, nothing opens the worktree, and an error and the agent's final message are not separated.
- fix: A log pane primitive: mono, wrap toggle, Copy, 'Open worktree', with error and result as labelled sections.

## 39. [modernize/low/small] Three-second full-list poll where a push channel already exists
- where: src/renderer/src/views/HeadlessRuns.tsx:213
- evidence: `const t = setInterval(() => { if (document.hidden) return; reload(); }, 3000);` over headless:runs (seven subqueries per run); main already sends 'queue:changed' on every dispatch and finish (index.ts:954, 965, 980) and preload exposes `on.queueChanged` (729).
- failure: An idle Runs tab with fifty finished runs re-runs 350 subqueries every three seconds while nothing is changing.
- fix: Refresh on on.queueChanged plus a 15-30s fallback; keep the fingerprint gate.

## 40. [modernize/low/small] Three title-size stat tiles for numbers that are usually 0 or —
- where: src/renderer/src/views/HeadlessRuns.tsx:561
- evidence: `<div className="stat-grid hr-stats">` with Succeeded / Changed / Cost at --t-title (ui.css:83); Cost's sub-line carries a full sentence ('no repository reported a cost, so there is no figure to show', 576).
- failure: The hero digits are mostly '0' and '—'; the one figure that earns emphasis (cost with its provenance) shares weight with two counts already visible in the row list.
- fix: One count strip (Succeeded · Failed · Blocked · Cancelled · Waiting) in body size, and Cost as the single Stat with a short provenance Pill (Reported / Partial / Unreported).

