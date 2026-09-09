# Control view (src/renderer/src/views/Control.tsx, styles/control.css, main/control.ts, main/goal-trace.ts, main/automation.ts)

32 findings. readability={"firstPaintWords": 20, "fontSizesInSheet": 6, "explainerHintNoteUses": 10, "nestedBorderDepth": 2, "notes": "firstPaintWords counts eyebrow (3) + h1 (1) + lead (16) before the first control, the 'Show: How Control works' toggle, matching the screenshot state where the Explainer is folded because there are zero goals. On any install with one or more goals the Explainer opens by default (defaultHidden={ready && dockets.length === 0}, Control.tsx:440) and puts roughly 240 more words of prose in a three-column grid above the form. fontSizesInSheet: control.css declares 13px, 12px, 10px literals plus var(--t-micro), var(--t-small), var(--t-body) - six distinct declarations, five distinct rendered sizes (--t-small is 12px); eleven px literals in total, equal to the style-gate baseline. explainerHintNoteUses in Control.tsx: 1 Explainer, 6 Hint, 3 Note (plus 2 ConfirmNote); PlanEditor.tsx adds 3 Hints when the graph is open. nestedBorderDepth: the create-form fields sit one bordered container deep (.card > .field); node cards and plan rows sit two deep (.card > .control-node/.control-plan-row > .field), with .card .card border-color:transparent from index.css:720 hiding the third line but not the third box."}

notes: The build plan's premise is stale: a task-graph UI exists and is wired end to end. Control.tsx:7 imports PlanEditor; the create call sends `plan: toPlanNodes(plan)` (Control.tsx ~253); main validates it in buildPlan (control.ts ~300-390, node cap, dependency cap, cycle walk, single terminal review, claim overlap); smoke3.ts:7206-7215 asserts that wiring by source string. The editor is collapsed behind "Design the graph" (Control.tsx ~472-481) and the closed state says "The four phases every goal gets" only while the rows still equal DEFAULT_DOCKET_PLAN. So "every docket gets the same fixed four phases" is no longer true; what remains true is that nothing *other* than a human drawing rows can propose a graph (Scout/triage/autopilot all take the default). Screenshots: the "No project added yet" frame is almost certainly a harness artifact - scripts/renderer-harness.mjs:217 answers `projects.list` with two fixture projects - but the code path is real for a fresh install, so no finding rests on that frame alone. Nothing in these files carries a TODO/FIXME. automation.ts is unrelated to the view (an argv marker for the projects:add channel) and has no defects I could find. goal-trace.ts is sound; its only consumer-facing defect is the count/rows mismatch reported below. Severity ordering: the one high-severity honesty item (verification runs on a tree without the implementation) is a main-process fact that the Control view then presents as "Proof bundle" evidence gating Approve; it deserves attention before any polish here.

## 1. [bug/high/medium] A task's session exiting at runtime never changes the task; Control keeps showing 'running' and holds its claims
- where: src/main/control.ts:1073
- evidence: `export function reconcileRunningNodes()` is the only writer that moves a 'running' node when its session is gone, and index.ts:1016 calls it once at startup. The session exit observer (index.ts:1152) only calls `notify.announceAttention` and `syncAwake()`; grep for work_nodes outside control.ts finds only goal-trace.ts's SELECT. Control renders `<span className={`control-status ${node.status}`}>` from that stored status (Control.tsx:674) while 'Safe recovery' on the same screen computes liveness from listSessions() (control.ts:655-661).
- failure: An agent finishes or crashes; the node card still reads 'running' with 'Mark complete' offered and its file claims stay held (blocking sibling claims project-wide) until Wanigan is restarted. Directly beneath it the Safe recovery row for the same node says 'exact — no Wanigan writer is active'. Two contradictory statuses for one task on one screen.
- fix: Add a control.onSessionExit(sessionId) hook invoked from the exit observer that applies the reconcile rule to that one node (mark failed with the 'session ended' detail, release claims, setDocketPhase) and broadcasts a change so the view reloads.

## 2. [honesty/high/large] Verify's 'review gate' runs on a tree that does not contain the implementation
- where: src/main/control.ts:685
- evidence: runProof: `const run = await review.runAt(project.id, node.worktree ?? project.path);` — and startNode launches every node with `isolate: true` (control.ts:552), which createWorktree fulfils with `git worktree add -b branch dir startPoint` where `startPoint = baseBranch ?? head` (worktrees.ts:342,365). No merge or worktree hand-off exists between nodes (grep 'merge' in control.ts: none), and GoalCapsule/goalCapsuleText carry no worktree path (sessions.ts:771-790). DEFAULT_DOCKET_PLAN's verify phase nevertheless instructs 'Run the project review gate and targeted checks in the implementation worktree' (types.ts:1144).
- failure: Operator presses 'Run review gate' on a ready verify node: the gate runs in the operator's main checkout (node.worktree is null until the node starts). If the verify node was started, it runs in a fresh worktree cut from the base branch, without the implement node's edits. Either way Control records 'N review command(s) passed' in the Proof bundle and completeNode then allows Approve on that proof — a green that was not observed against the change. The verify agent itself is launched in 'plan' mode (control.ts:551) with no way to find the implementation worktree.
- fix: Resolve the verification tree from the verify node's implement prerequisite (its work_nodes.worktree), run the gate there, and write the tree path and HEAD into the proof summary; refuse 'Run review gate' with a sentence when no implementation worktree exists; hand the verify session that worktree path (capsule field or cwd) rather than a fresh isolate.

## 3. [bug/medium/small] Control never refreshes on its own: no subscription to queue:changed, session exit or session list
- where: src/renderer/src/views/Control.tsx:244
- evidence: The only loads are `useEffect(() => { void load(); }, [load]);`, the hashchange listener, and the tail of each `act`. Main broadcasts 'queue:changed' when the 10-second autopilot sweep enqueues (index.ts:976-987, AUTOPILOT_SWEEP_MS = 10_000 at index.ts:267) and when the dispatcher moves, and preload exposes on.queueChanged / on.exit / on.sessions (preload/index.ts:698+); none is used here.
- failure: Arm autopilot and watch the goal: tasks are queued, launched and finish in main while the board stays frozen at the last click. The operator reads 'ready' for a task that is already running and spending, until they press something.
- fix: Subscribe to window.wanigan.on.queueChanged and on.exit in a mount effect (with cleanup) and call load(selected) debounced; optionally on.sessions for liveness.

## 4. [bug/medium/small] Every goal selection performs two full loads (14 IPC calls) and a slow response can revert the operator's selection
- where: src/renderer/src/views/Control.tsx:225
- evidence: `const load = useCallback(async (focus?) => { ... setSelected(id) ... }, [selected]);` followed by `useEffect(() => { void load(); }, [load]);` (line 244). choose(id) calls load(id) → setSelected(id) → load's identity changes → the effect fires load() again, which re-reads the hash and fetches list/outcomes/events/get/mcpTasks/resumeReceipts/traces a second time. No sequence guard: `.control-docket` buttons are not disabled while busy, so a click on B while A's load is in flight lets A's later resolution call setSelected(A)/setDetail(A).
- failure: Doubled main-process work on every click (listDockets runs autopilotSpend + usageForMany per row); on a slow read the goal the operator just clicked flips back to the previous one.
- fix: Hold `selected` in a ref inside load (deps []), keep a monotonically increasing request id and ignore stale resolutions, and split the mount load from the selection load.

## 5. [bug/medium/small] An action error is rendered as 'Could not read your goals' with a Try-again button when the list is empty
- where: src/renderer/src/views/Control.tsx:509
- evidence: `{ready && error !== null && dockets.length === 0 && (<EmptyState posture="could-not-read" title="Could not read your goals" cue={error} action={<button ... onClick={() => void load()}>Try again</button>} />)}` — but `act` writes the same `error` state for every action (`catch (e) { setError(errText(e)); }`, line ~247).
- failure: Fresh install, first goal, budget typed as 'ten': main refuses 'Budget must be a number between 0 and 100,000 USD.' The top Note shows it, and the Goals card simultaneously shows '✕ Could not read your goals — Budget must be a number…' with a Try again that reloads the list. The list was read fine.
- fix: Keep separate loadError and actionError states; drive the EmptyState from loadError only.

## 6. [bug/medium/small] The explainer's responsive rules target a class that no element carries, so its 920px-minimum grid never collapses
- where: src/renderer/src/styles/control.css:111
- evidence: `@media (max-width: 1180px) { .control-guide { grid-template-columns: 1fr 1fr; } ... }` and `@media (max-width: 980px) { .control-grid, .control-guide { grid-template-columns: 1fr; } ... }` — but the grid is `.control-guide-body { grid-template-columns: minmax(220px,.65fr) minmax(360px,1fr) minmax(300px,.9fr); gap: 20px }` (line 14). Control.tsx:440-441 renders `<Explainer id="control-guide">` (bits.tsx emits id="explainer-control-guide" class "explainer") wrapping `<div className="control-guide-body">`. grep for a `control-guide` class in src/renderer: none.
- failure: On any install with ≥1 goal the Explainer opens by default; below roughly 1240px of window (sidebar 288 + gutters + 920px of tracks) the three-column guide overflows the pane horizontally and the whole page scrolls sideways. The `.control-example { grid-column: 1 / -1 }` fallback is equally dead.
- fix: Rename the selectors in both media queries to `.control-guide-body` (or use minmax(0,1fr) tracks).

## 7. [bug/medium/small] Event inbox binds each event to the create form's hidden project; an unassigned event can never be triaged
- where: src/renderer/src/views/Control.tsx:383
- evidence: `await window.wanigan.control.addEvent({ projectId: projectId || null, source: eventSource, kind: eventKind, summary: eventSummary });` — the event card (line 548) has no project control and rows render only status/kind/summary. triageEvent throws 'Assign this event to a project before creating work.' when project_id is null (control.ts ~805) and no surface can assign one.
- failure: On an install with no project selected in the create card, 'Add event' succeeds, 'Create goal' on that event fails forever with an instruction to assign a project that nothing offers. When a project is selected, the event is bound to it without the operator seeing which.
- fix: Add a project select to the event card (default: the create card's), print projectName on each row, and offer 'Assign project' on orphan rows.

## 8. [honesty/medium/small] Outcome router prints unreported cost as '$0.00'
- where: src/main/control.ts:714
- evidence: storeOutcome writes `usage?.costStatus === 'reported' ? usage.costUsd : 0` into work_model_outcomes.cost_usd; outcomes() sums it as total_cost_usd; ModelOutcome (types.ts:1240-1250) has no cost-status field; Control.tsx:550 renders `<td>{usd(outcome.totalCostUsd)}</td>` and usd(0) is '$0.00' (bits.tsx:530-531).
- failure: A model whose sessions reported no cost is ranked in a table whose Cost column reads '$0.00' — the 'reported nothing' vs 'reported zero' conflation commit 9123caf fixed for the autopilot card, still live one card down.
- fix: Store NULL for unreported cost, carry `reportedSamples`/`costStatus` on ModelOutcome, and render '—' or 'n of m reported' instead of a dollar figure.

## 9. [honesty/medium/small] 'does not invent a winner from … a single run' contradicts the ordering, which ranks one accepted sample first
- where: src/renderer/src/views/Control.tsx:550
- evidence: Copy: 'This ranks only completed goal evidence; it does not invent a winner from token volume or a single run.' Query: `ORDER BY accepted DESC,tests_passed DESC,samples DESC` (control.ts:767) with no minimum sample count.
- failure: After one approved goal the table's top row is a model with 1 sample, 100% accept — exactly the single-run winner the sentence says it will not produce.
- fix: Either reword ('Ordered by approvals; one sample is one sample') or require samples ≥ 2 to rank and list singletons below a rule.

## 10. [honesty/medium/small] 'ready for the evolving MCP Tasks adapter' promises an integration that does not exist
- where: src/renderer/src/views/Control.tsx:551
- evidence: `<span className="label">MCP task compatibility</span><p className="faint">Goal tasks have durable working/input-required/completed/cancelled state ready for the evolving MCP Tasks adapter.</p>` — grep for mcp_task_records / mcpTasks / McpTaskRecord outside control.ts finds only the table DDL (db.ts:1109) and the IPC handler (index.ts:2274). No MCP server code reads or exposes these records.
- failure: An operator reads that goal tasks are consumable over MCP Tasks; nothing serves them. CLAUDE.md: do not imply MCP support until verified end to end.
- fix: Retitle the block 'Task records' and describe what is true (an internal status mirror with a cancel action); drop the adapter sentence until an adapter exists.

## 11. [honesty/medium/small] Start silently launches implement tasks in acceptEdits and everything else in plan mode; the UI shows only provider and model
- where: src/main/control.ts:551
- evidence: `permissionMode: input.permissionMode?.trim() || (node.kind === 'implement' ? 'acceptEdits' : 'plan')` — preload control.start accepts effort and permissionMode (preload/index.ts:449-450) but Control sends `{ providerId, model }` only (Control.tsx:300). The launch row (Control.tsx:528) has 'Provider for next task' and 'Model override'; the notice says 'Isolated agent session launched from this task's contract.' acceptEdits per types.ts:1859: 'Edits under the working directory go ahead'.
- failure: The operator, described in CLAUDE.md as the constraint, starts an implement task without being told edits will be auto-approved; the verify task is started in plan mode while its instructions tell it to run the gate.
- fix: Show the permission mode and effort that will be used on the launch row (a read-only Mark per node kind), and allow override through the fields the preload already accepts.

## 12. [unfinished/medium/small] A task queued by autopilot is indistinguishable from a ready one; pressing Start spawns and kills a duplicate session
- where: src/main/control.ts:1024
- evidence: sweepAutopilot claims `UPDATE work_nodes SET dispatch_state='queued' WHERE ... status='pending'`; mapNodes (control.ts:190-208) never surfaces dispatch_state and DocketNode (types.ts:1150-1166) has no such field (grep dispatchState in shared/renderer/preload: none). Control renders `{node.status === 'ready' && <button className="btn btn-primary" onClick={onStart}>Start isolated task</button>}` (Control.tsx:675).
- failure: With autopilot armed the operator sees 'ready · Start isolated task' on a task the dispatcher is about to launch. Pressing it races: startNode creates a second worktree and PTY, the atomic UPDATE fails, and the loser is killed with 'This task was already started by another action; the duplicate session was stopped.' — a worktree created and torn down, and possibly a first prompt billed.
- fix: Map dispatch_state into DocketNode as `queued: boolean`, render 'queued by autopilot' via Mark and hide Start while queued.

## 13. [polish/medium/medium] Two status vocabularies on one page: a private .control-status pill family beside the shared Mark, with a missing 'new' rule
- where: src/renderer/src/styles/control.css:49
- evidence: `.control-status { ... font: 700 10px/1.3 var(--mono); text-transform: uppercase; }` with its own tone table at 50-54 (no `.control-status.new`), used for node, proof, receipt, trace, event and MCP task rows (Control.tsx:540-551, 674), while goal rows, prerequisites and the autopilot card use `<Mark>` from markOf (bits.tsx:99). MARKS gives 'new' a warn tone; the pill falls to grey.
- failure: The same word 'completed' appears as a green uppercase mono pill on one row and as '✓ completed' sans on the next; a new inbox event is grey here and warn-toned everywhere else.
- fix: Replace `.control-status` with Mark (or Pill with tone from markOf) and delete the private family — a ratchet-down for the style gate.

## 14. [modernize/medium/medium] Node cards stack up to five controls in a right column and render a disabled note input on every inert task
- where: src/renderer/src/views/Control.tsx:675
- evidence: `.control-node-actions { width: min(340px, 44%); display: grid; gap: 7px; }` (control.css:81) holds Start / Reopen / Run review gate / note input / claim row / Approve-Request-Reject or Mark complete; the note `<input ... disabled={!actionable}>` renders on blocked and completed nodes too.
- failure: A four-node default goal shows four greyed inputs and a ragged column of buttons; the eye cannot find the one task that is actionable.
- fix: One row per task (status Mark, kind, title, 'waits on' inline) with a single primary action and an overflow menu (Linear/Conductor pattern); show the note and claim fields only on the actionable node, in an inline drawer.

## 15. [bug/low/small] Dead rule: .control-goal-meta a targets an anchor that no longer exists
- where: src/renderer/src/styles/control.css:41
- evidence: `.control-goal-meta a { color: var(--accent); }` — grep for `<a ` in Control.tsx: none; the meta row holds two spans and a 'Copy goal ID' button (Control.tsx:520-527).
- failure: None visible; it is one of three dead selectors in the sheet (with the two .control-guide media rules) that a reader takes as evidence of an anchor.
- fix: Delete the rule.

## 16. [honesty/low/small] Goal trace heading counts 8 fetched signals but the list shows 5
- where: src/renderer/src/views/Control.tsx:541
- evidence: `window.wanigan.control.traces(id, 8)` (line 235); `<h3>{traces.length} recent signal{...}</h3>` then `traces.slice(0, 5).map(...)`.
- failure: A goal with eight or more trace rows reads '8 recent signals' above five rows; nothing says three are hidden.
- fix: Fetch 5, or show 'showing 5 of N' and a disclosure for the rest.

## 17. [honesty/low/small] Acceptance checks are silently truncated to 16 lines and 1,000 characters each
- where: src/main/control.ts:411
- evidence: `.map((v) => v.trim()).filter(Boolean).slice(0, 16).map((v) => v.slice(0, 1_000));` — the create card's `missing` gate (Control.tsx:395-400) checks only that the field is non-empty and the notice says 'Goal created.'
- failure: Twenty checks typed 'one per line' become sixteen stored ones with no message; the review that gates Approve then evaluates a contract the operator did not write.
- fix: Refuse with a count in main (like the 40-node cap) and mirror the limit in the field label.

## 18. [honesty/low/small] '$0.00 reported' sits beside 'nothing reported'
- where: src/renderer/src/views/Control.tsx:614
- evidence: `<span className="mono">{usd(auto.spendUsd)} reported</span>` unconditionally, next to `<Mark ... word={spend.word}>` which is 'nothing reported' or 'no session yet' for spendStatus 'unreported'/'none' (SPEND_MARKS, lines 44-49).
- failure: The fact row reads '$20.00 cap · $0.00 reported · ? nothing reported' — a reported zero and a reported nothing in one line.
- fix: Render '— reported' (or omit the figure) when spendStatus is 'unreported' or 'none'.

## 19. [honesty/low/small] Autopilot copy omits the cadence and the slot limit that govern when 'ready' tasks actually move
- where: src/renderer/src/views/Control.tsx:340
- evidence: Arm notice: 'Ready tasks other than Review are dispatched without further approval until reported spend reaches the cap or a halt is recorded.' Main sweeps every AUTOPILOT_SWEEP_MS = 10_000 (index.ts:267) and hands rows to the queue dispatcher, which applies the `node` slot limit (queue.registerRunner('node'), index.ts:956; settings.slots.node).
- failure: An armed goal shows several 'ready' tasks that do not start; nothing on the card says dispatch is a 10-second sweep bounded by the node slot count.
- fix: One Hint: 'Checked every 10 s; starts are bounded by the node slot limit in Settings.'

## 20. [unfinished/low/small] With no enabled provider the launch row renders an empty select and Start fails with a bare 'Provider is required.'
- where: src/renderer/src/views/Control.tsx:528
- evidence: `<select className="field" value={providerId}>{enabledProviders.map(...)}</select>` with `enabledProviders = providers.filter((p) => !!p.path)` (line 219); 'Start isolated task' (line 675) is gated only on busy; startNode's safeText throws 'Provider is required.' (control.ts:55-57). Only the autopilot card explains this case ('No provider is enabled…', line 635).
- failure: A blank dropdown with no sentence, and a Start that errors after the click.
- fix: Render a Hint under the launch row and disable Start when enabledProviders is empty.

## 21. [missing/low/small] No way to remove a spend cap, although main supports and guards it
- where: src/main/control.ts:971
- evidence: `export function setDocketBudget(docketId, budgetUsd: number | null)` accepts null and refuses it while armed ('Disarm autopilot before removing this goal's budget…'); the card offers only `{cap === null ? 'Set cap' : 'Update cap'}` with the button disabled on an empty draft (Control.tsx:623-625).
- failure: A cap set by mistake can only be raised to 100,000, never cleared; the guard sentence main wrote can never be read.
- fix: Add a 'Remove cap' secondary button that sends null when disarmed.

## 22. [missing/low/small] Triaged events do not link to the goal they created; inbox and goal list are silently capped
- where: src/renderer/src/views/Control.tsx:549
- evidence: Event rows render status, kind, summary only; ControlEvent.docketId (types.ts:1259) is unused. The inbox shows `.slice(0, 6)` of up to 80 events with no count; control.list() uses listDockets' default limit 80 (control.ts:290) and the Goals card prints `{dockets.length}` as the total (line 490).
- failure: An operator cannot get from a triaged event to its goal; past 80 goals the count and the filter chips describe a truncated list as if it were all of them.
- fix: Render 'goal →' on triaged rows using the existing #goal= hash; show 'n of N' for both lists or page them.

## 23. [polish/low/small] Disabled full-width 'Create goal' is visually a text field
- where: src/renderer/src/views/Control.tsx:485
- evidence: `<button className="btn btn-primary" disabled={...}>` is a grid child of `.control-create { display: grid }` (control.css:24) so it stretches; the shared rule `.btn-primary:disabled { background: var(--bg-sunk); border-color: var(--line); color: var(--text-dim); opacity: 1; font-weight: 400; }` (index.css:304) gives it the same fill, border and weight as `.field`. Both screenshots show it sitting under the Budget input as an identical box; the only other button on the card is `justify-self: start` (control.css:105).
- failure: The primary action reads as an empty input until the form is complete.
- fix: `.control-create > .btn-primary { justify-self: start; }` or keep the primary silhouette at reduced opacity with the reason text beside it.

## 24. [polish/low/small] The 'Isolated agent session launched…' notice is set after Control has unmounted
- where: src/renderer/src/views/Control.tsx:299
- evidence: `const start = (node) => act(..., async () => { const launched = ...; await load(detail?.id); if (launched.sessionId) onOpenSession(launched.sessionId); }, 'Isolated agent session launched from this task's contract.');` — App.openSession calls go('sessions') (App.tsx:582-585), unmounting Control before act reaches setNotice.
- failure: The message is never seen; on return to Control the notice is gone.
- fix: Drop the message, or hand it to the shell's announce so it shows on Sessions.

## 25. [polish/low/small] Checkpoint stays offered on finished tasks while its note field is disabled
- where: src/renderer/src/views/Control.tsx:674
- evidence: `{node.sessionId && <button className="btn" onClick={onCheckpoint}>Checkpoint</button>}` versus `<input ... placeholder="Evidence or handoff note" disabled={!actionable} />` (line 676); checkpoint falls back to `notes[node.id] || 'Operator checkpoint.'` (line 304).
- failure: On a completed node the operator can press Checkpoint but cannot type a note, so every such checkpoint is titled 'Operator checkpoint.'
- fix: Gate Checkpoint on actionable, or keep the note field enabled whenever Checkpoint is shown.

## 26. [polish/low/small] Release and triage 'Create goal' buttons ignore the busy guard every other action uses
- where: src/renderer/src/views/Control.tsx:542
- evidence: `<button className="btn" onClick={() => void act(`release-${claim.id}`, ...)}>Release</button>` and `<button className="btn" onClick={() => void triage(event)}>Create goal</button>` (line 549) have no `disabled={busy !== null}`, unlike Dismiss beside it.
- failure: Double-clicks queue overlapping acts; the second triage returns 'This event has already been triaged or dismissed.' as an error over a success.
- fix: Add the busy guard.

## 27. [polish/low/small] Budget fields accept any text and Title has no length cap; refusals arrive only after submit
- where: src/renderer/src/views/Control.tsx:470
- evidence: Budget: `<input className="field" inputMode="decimal" value={budget} ...>` submitted as `Number(budget)` (line 251); the `missing` gate (395-400) ignores it. Title `<input className="field" value={title}>` has no maxLength although PlanEditor's title uses maxLength={180} (PlanEditor.tsx:349) and main refuses at 180 (control.ts:405).
- failure: 'Create goal' is enabled with budget 'ten' or a 200-character title and fails afterwards; the plan editor and the goal form disagree about the same rule.
- fix: Add budget validity to `missing`, maxLength={180} on Title, and inputMode plus a pattern on the cap field.

## 28. [polish/low/small] Review-gate refusal names no place to configure the gate
- where: src/main/control.ts:685
- evidence: review.runAt throws 'Add at least one review command before running a gate.' (review.ts:225) which Control shows verbatim in the error Note; nothing in the node card or the Explainer says the recipe lives in the Git view.
- failure: The operator sees a refusal with no route to satisfy it.
- fix: Append the location to the error, or render a Hint beside 'Run review gate' when the project has no recipe.

## 29. [polish/low/small] The explainer, open by default on any install with goals, is ~240 words in a three-column grid above the form
- where: src/renderer/src/views/Control.tsx:440
- evidence: `<Explainer id="control-guide" title="How Control works" defaultHidden={ready && dockets.length === 0}>` wraps a definition paragraph, four numbered steps and a worked example; the create card sits below it (comment at 435-439 measured 686px).
- failure: Every return to Control on a working install starts with a screen of prose before the first control; the learning-UX doctrine in memory prefers one line per concept beside the control it explains.
- fix: Use the Explainer's `compact` form for one sentence, and move each step next to its section as a Hint (the node card already carries 'Waits on…').

## 30. [modernize/low/medium] Evidence quadrant uses count-as-headline h3s and an unbounded proof list
- where: src/renderer/src/views/Control.tsx:540
- evidence: `<h3>{detail.proofs.length} record{...}</h3>` / `<h3>{detail.checkpoints.length} checkpoint{...}</h3>` / `<h3>{receipts.length === 0 ? 'No launched task yet' : ...}</h3>` with `.control-evidence h3` (control.css:85); proofs are mapped without a slice while every gate run and every autopilot halt inserts a work_proofs row (control.ts:688, 935).
- failure: A long-running goal grows a wall of 12px paragraphs under a headline that is a number; checkpoints are cut at four with no 'more' while proofs are not cut at all.
- fix: Use SectionHead with count for each quadrant, compact rows with a Mark, and a 'show all' disclosure at five.

## 31. [modernize/low/small] Goal list rows are bespoke boxed buttons with a plate-red inset; three bordered layers stack before the first field
- where: src/renderer/src/styles/control.css:42
- evidence: `.control-docket { border: 1px solid var(--line); background: var(--bg-raised); border-radius: 8px; padding: 11px; ... }` and `.control-docket.selected { box-shadow: inset 3px 0 0 var(--plate-red); }` inside `.card.control-list`, itself inside the pane; node cards repeat the pattern (`.control-node { border: 1px solid var(--line); border-radius: 9px }`, line 72).
- failure: Boxes inside boxes with 8px and 9px radii beside the token --r-md; selection carries a third colour (plate-red) beside the coral accent and the warn/ok tones.
- fix: Hairline-separated rows (like Sessions) with the shared `--bg-selected` fill only; radii from --r-md; drop the private 8/9px values.

## 32. [modernize/low/small] 10px uppercase mono pills and table heads read as a 2015 dashboard beside the app's own .pill and .sub tokens
- where: src/renderer/src/styles/control.css:98
- evidence: `.control-table th { font: 700 10px var(--mono); text-transform: uppercase; }` and `.control-status { font: 700 10px/1.3 var(--mono); text-transform: uppercase; }` (line 49) while index.css defines `.sub` (11px, 600, .06em) and `.pill` (t-micro) for exactly these roles.
- failure: Two extra type styles on one view, both below the 11px floor the scale defines.
- fix: Use `.sub` for table heads and Pill/Mark for statuses; two ratchet points off the sheet's literal count.

