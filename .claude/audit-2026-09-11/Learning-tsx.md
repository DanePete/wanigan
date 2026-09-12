# Learning.tsx — 24 findings

## src/renderer/src/views/Learning.tsx:391 — [high] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The Inbox and Overview derive "nothing waits for a decision" from a 100-row page of candidates ordered by updated_at, so once a store holds more than 100 candidates the app tells the operator the inbox is clear while its own unbounded count, shown on the same screen, says proposals are waiting.

**Evidence.**

```
Learning.tsx:391 `window.wanigan.learning.candidates({ projectId: scopeParam, limit: 100 })` — repository.ts:187 applies that as `ORDER BY updated_at DESC LIMIT ?` over *all* statuses. Learning.tsx:1184 `const pending = candidates.filter((c) => c.status === 'pending');` then Learning.tsx:1200-1201 `{ key: 'p', ok: true, word: 'inbox clear', text: 'Nothing waits for a decision.' ... }`. Learning.tsx:1516 `<Empty title="The Inbox is clear" body="Nothing needs a decision in this scope..." frame={emptyFrame} />`. Meanwhile Learning.tsx:540 `overview.pending > 0 && <span className="sec-count">{overview.pending}</span>` is fed by learning-service.ts:237 `SELECT COUNT(*) n FROM knowledge_candidates WHERE status IN ('pending','approved','snoozed')` with no limit.
```

**Failure.** A store with 66 pending nominations and ~200 decided rows (the shape the sweep's own comment at learning-service.ts:1161 measured). The operator clicks the Inbox's "Clear them" sweep; sweepUnactionable rejects 42 rows and repository.ts reviewCandidate sets `updated_at=now` on each, so those 42 now occupy the newest slots. The next `load()` returns 100 rows dominated by just-rejected and recently-touched candidates; the oldest still-pending proposals — the ones NeedsAttention was boasting had "waited 3 weeks" — fall off the page. The Inbox pane then renders "The Inbox is clear · Nothing needs a decision in this scope" and Overview renders "✓ inbox clear — Nothing waits for a decision", while the tab badge beside them shows 24 and the pipeline spine shows "Proposed 24 · await your decision". Those proposals are unreachable from every status filter, because every filter narrows the same 100 rows. Under a project scope there is not even a hedge: learning-service.ts:1486-1493 runs two `listCandidates` calls each capped at 100 and merges them, so `candidates.length` lands anywhere in 100–200 and the `candidates.length === 100` disclosure at Learning.tsx:1529 never fires.

**Fix.** Stop deriving decision-state claims from the paged list. Either request the open statuses explicitly (`candidates({ projectId: scopeParam, status: ['pending','approved','snoozed','failed'], limit: 100 })`) and read the totals from `overview.pending`/`pipeline.awaitingDecision` for every count and every "clear" claim, or have main return a total alongside the page and gate the "inbox clear"/"Nothing waits" copy on that total being 0. The `=== 100` truncation notice should be `>=` and must account for the two-query merge.

---

## src/renderer/src/views/Learning.tsx:1520 — [high] focus-management  (CONFIRMED, sustained 3/3)

**Claim.** The Inbox proposal search box unmounts the moment its own query stops matching, so focus is destroyed mid-typing and the rest of the word is dropped.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:1520-1521 — `{visible.length > 0 && <div className="learning-proposals">` / `<aside className="learning-proposal-list" aria-label="Proposals"><input className="field" type="search" aria-label="Search proposals" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a proposal…" />` and the replacement at 1528 — `{visible.length === 0 && query && <div className="learning-actions"><input className="field" type="search" aria-label="Search proposals" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn" onClick={() => setQuery('')}>Clear search</button></div>}`. `visible` is computed at 1421: `const visible = candidates.filter(c => `${c.title} ${c.proposedText}`.toLowerCase().includes(query.trim().toLowerCase()))…`
```

**Failure.** Learning → Inbox with at least one proposal listed. Put focus in "Find a proposal…" and type a word that narrows to nothing — e.g. typing "auth" where the 'a'/'au' prefixes match but 'aut' does not. On that keystroke `visible.length` goes 1→0, so the whole `.learning-proposals` subtree containing the focused <input> unmounts and a second, differently-parented `<input aria-label="Search proposals">` mounts inside `.learning-actions`. These are two different positions in the same children array, so React cannot reuse the DOM node; Chromium resets focus to <body>. The caret disappears, the remaining keystrokes of the word go nowhere, and Backspace no longer edits the query — the user must find and click the replacement box (which has moved out of the left rail into the action row and lost its placeholder) to continue or to clear the search.

**Fix.** Hoist the search <input> above both conditionals so it occupies one stable position in the children array and stays mounted whether or not `visible` is empty; drop the duplicate at 1528 and leave only the "Clear search" button in that branch.

---

## src/renderer/src/views/Learning.tsx:1612 — [high] non-atomic-action  (CONFIRMED, sustained 3/3)

**Claim.** "Approve to knowledge" is two sequential IPC calls with no rollback, and act()'s catch does not reload — so when the second call refuses, the candidate is left permanently stuck at 'approved' while the card still shows it as 'pending'.

**Evidence.**

```
Learning.tsx:1612-1615 `const approve = () => act(key, async () => {\n    await window.wanigan.learning.reviewCandidate(candidate.id, 'approve');\n    await window.wanigan.learning.promoteCandidate(candidate.id);\n  }, 'Approved into canonical knowledge. …');` — and act()'s failure path at Learning.tsx:458-460 `catch (e) { if (alive.current) setError(message(e)); return false; }` (the success path at :456 is the only `await load(true)`). Main refuses the second call on two ordinary conditions: learning-service.ts:772-775 `refuseUnauthoredNomination` → 'This candidate is a nomination, not a claim… Edit its text before promoting it, or reject it.' and repository.ts:592-596 (a conflict re-found at promotion time). The first call has already committed: repository.ts:411-422 `approve: ['pending', 'snoozed'] … throw new Error(`${article} ${candidate.status} candidate cannot be ${past[action]}.`)`.
```

**Failure.** Consolidation writes an unauthored nomination ("Unexplained repetition: read", proposedText starting with NOMINATION_MARKER; learning-service.ts:755-766) as a pending Inbox row. Click "Approve to knowledge": reviewCandidate commits pending→approved, promoteCandidate throws the nomination refusal, act() shows that refusal and skips the reload, so the card still reads 'pending' with Approve and Edit enabled. On the next reload (any later successful action, or the 5-minute learningChanged push) the card flips to 'approved' and the row is dead in every direction: Approve now throws "An approved candidate cannot be approved.", Edit is disabled (`undecided = ['pending','snoozed']`, Learning.tsx:1581/1723), the Inbox sweep only scans status 'pending' (learning-service.ts:1173), and model-assisted phrasing refuses it (`if (current.status !== 'pending') return null`, repository.ts:382). The only remaining action is Reject — the exact opposite of what the refusal message told the operator to do.

**Fix.** Give main one handler that runs reviewCandidate+promoteCandidate inside a single db().transaction so a refused promotion rolls the status back, and have CandidateCard call that. At minimum, add `await load(true)` (or `setRefreshTick`) to act()'s catch at Learning.tsx:458 so the card stops asserting a status the database no longer holds.

---

## src/renderer/src/views/Learning.tsx:1725 — [high] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The Inbox's "Apply to <provider>" button is hidden once a candidate reaches status 'applied', so one approved candidate can only ever be projected to a single provider from the UI — contradicting the AGENTS.md rule that one approved candidate compiles independently for each requested provider, which the main process fully supports.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:1725 — `{PROJECTABLE_KINDS.includes(candidate.targetKind) && ['approved', 'promoted'].includes(candidate.status) && <button ... onClick={() => void act(key, () => window.wanigan.learning.applyCandidate(candidate.id, target), ...)}>Apply to {…}</button>}`. Main deliberately allows the second apply: src/main/learning-service.ts:1551 `if (candidate.status !== 'promoted' && candidate.status !== 'applied') throw new Error('Approve and promote this candidate before applying a provider projection.')`, and src/main/learning/projections.ts:222 accepts a candidate whose status is `'approved' || 'promoted' || 'applied'`. src/main/learning-service.ts:1960 (`forgeSkill`) proves the loop works: `return targets.map((providerId) => ({ providerId, projection: applyCandidateToProvider(candidate.id, providerId).projection, ... }))`. src/main/learning/projections.ts:255 is what closes the door in the UI: `db().prepare("UPDATE knowledge_candidates SET status='applied',updated_at=? WHERE id=?")`.
```

**Failure.** An `instruction`-kind candidate is approved and applied to the Claude Code profile. applyProjection sets the candidate's status to 'applied'. On the next render the reviewer picks 'Codex' in the still-visible "Provider targets" select, but the Apply button is gone — `['approved','promoted'].includes('applied')` is false — so AGENTS.md and CLAUDE.md can never hold the same learned instruction. The only route back is Undo on the Claude projection (which reverts the candidate to 'promoted' and deletes the Claude file), apply to Codex, and lose Claude. The provider dropdown remains a live control with no action behind it.

**Fix.** Include 'applied' in the status list so the button mirrors what main accepts: `['approved', 'promoted', 'applied'].includes(candidate.status)`. Optionally disable it for the provider(s) already listed in the candidate's applied projections rather than hiding it entirely.

---

## src/renderer/src/views/Learning.tsx:2038 — [high] correctness  (CONFIRMED, sustained 3/3)

**Claim.** Knowledge's bulk retire resolves the picked ids against `items` (the newest 200 in scope) while the checkboxes and the "Select all N" button are driven by `listed` (search results), so ticked rows that are not in `items` are silently dropped from the destructive action.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:2037-2039 — `const pickedItems = picked\n    .map((id) => items.find((item) => item.id === id))\n    .filter((item): item is KnowledgeItem => item !== undefined);` while the source of the ids is the search list: line 2030 `const listed = results ?? items;`, line 2033 `const unsynthesized = activeListed.filter(...)`, line 2120 `onClick={() => setPicked(unsynthesized.map((item) => item.id))}` ("Select all N"), and the row checkbox at line 2158 `checked={picked.includes(item.id)}`. The two lists genuinely differ: `items` is `learning.knowledge({ projectId: scopeParam, limit: 200 })` → src/main/learning/repository.ts:473 `ORDER BY updated_at DESC LIMIT ?`, while `results` is `learning.search(query, { limit: 80 })` → src/main/learning/repository.ts:850 `ORDER BY rank,i.confidence DESC,i.updated_at DESC LIMIT ?`. The renderer already knows the 200-cap is reachable: line 2176 `{!results && items.length === 200 && <p className="faint">Showing the newest 200 items — older ones are not listed here.</p>}`.
```

**Failure.** A store holds 260 active knowledge items. The operator searches, and three hits have text identical to their title; one of them was last updated a year ago and so falls outside the newest-200 `items` page. They press "Select all 3" — all three rows render ticked — but the bulk bar reads "2 selected", RetireDialog lists 2, and `retire(reason, pickedItems)` retires 2. The third stays active and keeps being refused at retrieval. Ticking that row on its own is worse: `pickedItems.length` is 0, so the bulk bar never appears and the checkbox looks like a dead control.

**Fix.** Resolve the picked ids against the same pool the checkboxes come from, e.g. `const pool = results ? [...items, ...results] : items;` then `picked.map((id) => pool.find((item) => item.id === id))` (de-duplicating by id), so every ticked row is a retired row.

---

## src/renderer/src/views/Learning.tsx:2796 — [high] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** The learning-spend sentence joins three numbers drawn from three different populations, so the call count attached to "this month" is a capped, all-time, all-status figure and the average is lifetime, not monthly.

**Evidence.**

```
Learning.tsx:2796-2797 — `? `$${status.monthToDateUsd.toFixed(2)} recorded this month across ${status.runs.length} call${pl(status.runs.length)} read back`` + `${status.averageCostUsd === null ? '' : `, averaging $${status.averageCostUsd.toFixed(4)} a call`}.`` . But learning-model-assist.ts:718-721 fills `runs` with `SELECT at, provider_id, status, cost_usd, cost_reported FROM learning_model_runs ORDER BY at DESC LIMIT 20` — no month predicate and no status predicate — while monthToDateUsd() (learning-model-assist.ts:232-235) filters `WHERE at >= ? AND cost_reported=1`, and averageCostUsd() (709-712) filters `WHERE cost_reported=1` with no date bound. `status.runs` is used nowhere else in either view (only `.length` at 2796).
```

**Failure.** Operator makes 35 phrasing calls this month totalling $4.12, of which 6 were status='failed'. The card reads "$4.12 recorded this month across 20 calls read back" — 20 is the SQL page size, not a count of anything, and it silently includes the failed calls that contributed $0. Worse across a month boundary: 0 calls this month, 20 priced calls last month → "$0.00 recorded this month across 20 calls read back, averaging $0.1290 a call", which reads as twenty free calls made this month. The averaging clause is the lifetime mean of every priced call ever, presented inside a sentence whose subject is "this month".

**Fix.** Return the counts the sentence actually claims instead of a page length: add `monthToDateCalls` (`SELECT COUNT(*) FROM learning_model_runs WHERE at >= ? AND cost_reported=1`) and a month-scoped average to ModelAssistStatus, and render those. Leave `runs` as what it is — the most recent 20 rows for a list — and stop deriving a count from it.

---

## src/renderer/src/views/Learning.tsx:525 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** "Teach Wanigan" stays enabled while the learning master switch is off, and the refusal it produces names "Optimize" — a surface that no longer exists anywhere in the app.

**Evidence.**

```
Learning.tsx:525 `<TeachButton project={...} providers={availableProviders} busy={busy} onRun={fn => act('teach', fn, 'Added to the Learning Inbox with its source attached.')} />` — rendered unconditionally, and TeachButton receives no `settings`. Main: learning-service.ts:337 `if (!learningSettings().enabled) throw new Error('Learning is switched off in Optimize.');`. The view has no Optimize tab — Learning.tsx:64-71 lists Overview/Inbox/Knowledge/Context, and Learning.tsx:80-83 `const TARGET_TAB: Record<string, LearningTab> = { ... optimize: 'context', context: 'context' }` exists precisely because `optimize` is the pre-rename id; `grep -rn "Optimize" src/renderer/src` finds no label, tab or view by that name.
```

**Failure.** Turn the master switch off in Context (the view then renders "Learning paused" in the Overview header and "○ paused — nothing recorded, nothing deleted" on the switch itself). Open "Teach Wanigan", type a title and a paragraph of knowledge, click "Add to Inbox": a red banner reads "Learning is switched off in Optimize." and sends the operator looking for a tab that does not exist. Nothing on the button or the sheet said the action was unavailable.

**Fix.** Pass `settings.enabled` into TeachButton and either disable the trigger with a one-line reason or state it in the sheet; and correct the main-process message to name Context ("Learning is switched off — turn it on in Learning → Context.").

---

## src/renderer/src/views/Learning.tsx:925 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The signals chart's clip caption asserts "Recording began <date>" from the first non-empty day *inside the selected window*, which is a false statement of fact whenever signals exist before that window — a condition this same component already measures and reports a few lines below.

**Evidence.**

```
Learning.tsx:920-926: `const firstIdx = rows.findIndex((r) => r.total > 0);` ... `const clipNote = total > 0 && shown.length < rows.length ? \`Recording began ${fmtDay(rows[firstIdx].day)} — showing ${shown.length} of the ${windowDays}-day window; earlier days had no signals.\` : null;`. `rows` is `pipeline.signalsByDay`, which ledger.ts:540 zero-fills for every day of the window, so `firstIdx` is only the first day *of the window* with a signal. The component already holds the fact that disproves the claim — Learning.tsx:950 `{pipeline.signalsAllTime > pipeline.signals && (<p className="faint">Signals were recorded before this window.` — and never consults it here.
```

**Failure.** An operator who used Wanigan heavily for months, paused for a month, then ran two sessions yesterday and today, on the 30-day window: `rows[0..27].total === 0`, `firstIdx === 28`, `span === 2`, `shownDays === max(2,7) === 7`, so `shown.length (7) < rows.length (30)` and the caption prints "Recording began Sep 10 — showing 7 of the 30-day window; earlier days had no signals." Recording began months earlier, and `pipeline.signalsAllTime` (already on screen's data) is far greater than `pipeline.signals`. In a view whose every other caption is written to keep "observed" apart from "inferred", this is an inferred origin date printed as an observation.

**Fix.** Gate the origin clause on the fact that is actually available: when `pipeline.signalsAllTime > pipeline.signals`, say "showing the N recorded days of the {windowDays}-day window; earlier days in this window had no signals" and drop "Recording began" — it may only be asserted when `signalsAllTime === signals`.

---

## src/renderer/src/views/Learning.tsx:1089 — [medium] false-attribution  (CONFIRMED, sustained 3/3)

**Claim.** The "Consolidate now" notice attributes a zero-candidate pass to the one cause the main process has already ruled out: a cluster that was consumed as claimless had to clear the two-observations/two-independent-tasks gate first.

**Evidence.**

```
Learning.tsx:1085-1089 `return r.candidates > 0 ? … : partial ? … : 'Consolidation finished: no new candidates — nothing repeated across enough independent sessions yet.';`. In main, learning-service.ts:1045 `if (cluster.observations < 2 || cluster.taskCount < 2) continue;` runs *before* learning-service.ts:1072-1075 `if (!template && !claimPossible(cluster.signals)) { processed += markSignalsProcessed(signalIds); claimless++; continue; }`. Every claimless consumption therefore repeated across ≥2 independent tasks by construction. The same pass's paragraph makes the contradiction visible: Learning.tsx:1104-1105 `consumed <strong>{latest.processed…}</strong> signal{…} into candidates · produced <strong>{latest.candidates…}</strong> candidate{…}`.
```

**Failure.** With hooks on, let two `Read` tool-success signals be recorded in two different sessions (the dominant real case — learning-service.ts:1063-1071 records that 42 of 66 pending candidates in a real database were exactly this). Press "Consolidate now". The pass clusters them, passes the 2/2 gate, finds no template, `claimPossible` returns false, `processed` becomes 2 and `candidates` stays 0. `partitionsRead === partitionsTotal`, so `partial` is false and the toast reads "no new candidates — nothing repeated across enough independent sessions yet" — the opposite of what happened. The heartbeat paragraph then reads "consumed 2 signals into candidates · produced 0 candidates".

**Fix.** Return the `claimless` and `boundaries` tallies the pass already counts (learning-service.ts:1128-1133 logs them to the console) in `ConsolidationOutcome`, and branch the notice on them: "Consolidation finished: 2 signals repeated ordinary successful work, so they carry no claim and were consumed rather than proposed." Reword the heartbeat to "consumed N signals" rather than "into candidates".

---

## src/renderer/src/views/Learning.tsx:1111 — [medium] keyboard-unreachable-tooltip  (CONFIRMED, sustained 3/3)

**Claim.** Two native `title` tooltips in Learning.tsx are invisible to the style gate's tooltip ratchet because its OPEN_TAG regex stops at the first `>` inside a JSX expression; one of them is the only place the per-pass consolidation figures exist.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:1111-1113 — `<span key={r.id} className={r.candidates > 0 ? 'hit' : ''}` / `style={{ height: `${4 + Math.round((r.candidates / maxC) * 18)}px` }}` / `title={`${when(r.at)} · ${triggerWords(r.trigger)} · consumed ${r.processed} · ${r.candidates} candidate${pl(r.candidates)} · auto-applied ${r.autoApplied} · ${r.durationMs}ms`} />`, and 884-885 — `<button className="how-step-tab" onClick={() => onNavigate(step.tab)}` / `title={`Open the ${step.label} tab`}>`. The gate at scripts/check-renderer-style.cjs:473 — `const OPEN_TAG = /<([a-zA-Z][\w.]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>/g;` — whose attribute group excludes `>` and only skips `"`/`'` strings, so it terminates at the `>` in `r.candidates > 0` and at the `>` of `() =>`.
```

**Failure.** Run `node scripts/check-renderer-style.cjs --print-baseline`: it reports `"views/Learning.tsx": 4` tooltips, matching TITLE_TOOLTIP_BASELINE, while a brace-depth-aware scan of the same file finds 6 intrinsic-element `title=` attributes (645, 884, 891, 1111, 1492, 1722). Two consequences. (a) In Learning → Overview, the consolidation heartbeat strip is `<div className="heartbeat-strip" role="img" aria-label=…>` (1108-1109) whose aria-label names only the newest pass; the trigger, signals consumed, candidates produced, auto-applied count and duration of every other recorded pass are stated nowhere on the page and are reachable only by mouse hover — nothing for a keyboard or touch user, and the children are inside role="img" so they are not in the accessibility tree at all. (b) The ratchet whose comment says "a file may only ever go down" and "Any future rise needs the same kind of explanation" does not hold: any new `title=` written after an arrow function or a `>` comparison in the same opening tag scores 0 and passes.

**Fix.** Replace OPEN_TAG's attribute group with the brace-depth-aware scanner `unnamedControls` already uses (scripts/check-renderer-style.cjs:511-523), then re-baseline; and put the strip's per-pass figures on the page — a short list or a focusable button per bar — instead of in `title`.

---

## src/renderer/src/views/Learning.tsx:1198 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** "Worth your attention" states how long the oldest pending proposal has waited, computed from a page of the 100 most-recently-updated candidates — which is exactly the page that drops the oldest rows first.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:1185-1198 — `const pending = candidates.filter((c) => c.status === 'pending');` / `const oldest = pending.length ? Math.min(...pending.map((c) => c.createdAt)) : null;` / `` `${pending.length} proposals wait in the Inbox — the oldest has waited ${fmtDur(Date.now() - (oldest ?? Date.now()))}. Evidence waits for your decision.` ``. `candidates` is fetched once at Learning.tsx:391 as `window.wanigan.learning.candidates({ projectId: scopeParam, limit: 100 })`, and the backing query is src/main/learning/repository.ts:187 `ORDER BY updated_at DESC LIMIT ?`. The same component already receives an uncapped COUNT for this stage: `overview.pending` (src/main/learning-service.ts:1155 `SELECT COUNT(*) n FROM knowledge_candidates WHERE status IN ('pending','approved','snoozed')…`), which it uses at Learning.tsx:1182 only for `overview.quarantined`.
```

**Failure.** On a store with 140 candidates in scope (the file's own comments cite a real database with 66 pending rows alone), the read returns only the newest 100 by `updated_at`, so an untouched proposal created 60 days ago is not in the array. The row renders "100 proposals wait in the Inbox — the oldest has waited 4d" when the true figures are 140-plus and 60 days. The Inbox tab guards against exactly this with `{candidates.length === 100 && <p className="faint">Showing the newest 100 proposals — older ones are not listed here.</p>}` (line 1543); this card makes a definite claim with no such guard.

**Fix.** Have main return the pending count and the oldest `created_at` for the scope (they are one `SELECT COUNT(*), MIN(created_at)`), and read them here instead of deriving both from the capped page; or, minimally, suppress the "oldest has waited" clause and mark the count as a floor when `candidates.length` is at the limit.

---

## src/renderer/src/views/Learning.tsx:1495 — [medium] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** The "unauthored nominations across all scopes" count is silently ceilinged at 100 by the default query limit, and is stated as a fact with no cap disclosure on the one toolbar whose neighbouring list does disclose its cap.

**Evidence.**

```
Learning.tsx:1495 — `{unactionable} unauthored nomination{pl(unactionable)} across all scopes record a repeated success, so no review of {unactionable === 1 ? 'it' : 'them'} could reach a claim.` fed by `window.wanigan.learning.unactionableCount()` at 1416, called with no argument. learning-service.ts:1172-1176 — `function unactionableNominations(projectId?: string | null) { return candidates({ projectId, status: 'pending' }).filter(…) }` — no limit is passed, so repository.ts:186 applies `filter.limit ?? 100`. The filter then runs over only those 100 rows. The same toolbar's proposal list, twenty lines below, does carry `Showing the newest 100 proposals` (Learning.tsx:1529), and Heartbeat explicitly rejects this exact trap in its own docstring (Learning.tsx:1047-1050: "`runs` is a bounded page of the most recent 20, so its length is a page size").
```

**Failure.** A store with 260 pending candidates, 200 of them repeated-success nominations (the surrounding comment records 42 of 66 on a real database, so the 100 cap is reachable). The line reads "100 unauthored nominations across all scopes record a repeated success" while the Inbox badge beside it reads 260. "Clear them" sweeps only that batch and reports "100 proposals cleared", after which the count re-reads and shows another 100 — an operator told a definite number has to guess how many times to press. Separately, Learning.tsx:1418 `.catch(() => setUnactionable(0))` turns a failed count into a silent 0, which hides the offer entirely rather than saying the count could not be read.

**Fix.** Count in SQL rather than by filtering a page — or pass an explicit high limit and return whether it was hit — and render the failed read as "could not be counted" instead of falling back to 0.

---

## src/renderer/src/views/Learning.tsx:1529 — [medium] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** The "Showing the newest N" truncation notices test list length for exact equality with the per-query cap, but in project scope main merges two capped queries — so the notice vanishes exactly when truncation is happening, and appears when it is not.

**Evidence.**

```
Learning.tsx:1529 — `{candidates.length === 100 && (<p className="faint">Showing the newest 100 proposals — older ones are not listed here.</p>)}` and Learning.tsx:2173 — `{!results && items.length === 200 && (<p className="faint">Showing the newest 200 items — older ones are not listed here.</p>)}`. The lists are fetched with `limit: 100` / `limit: 200` (Learning.tsx:395-397). In project scope main runs the query twice: learning-service.ts:1487-1493 — `filter.projectId ? [...listCandidates({projectId: filter.projectId, …, limit: filter.limit}), ...listCandidates({projectId: null, …, limit: filter.limit})].filter(dedupe)` — and learning-service.ts:1640-1643 does the same for knowledge. Each half is capped independently by `Math.max(1, Math.min(500, filter.limit ?? 100))` (repository.ts:186). The signals notice one row below (Learning.tsx:1547) is correct only because listSignals is a single query.
```

**Failure.** Scope set to a project holding 140 candidates, with 12 personal-scope candidates. Main returns the newest 100 project rows plus 12 personal rows = 112; 40 project proposals were dropped and the truncation notice does not render, because 112 !== 100. The Inbox sidebar badge beside it shows `overview.pending` (Learning.tsx:540), which is an exact SQL COUNT (learning-service.ts:237), so the two disagree with nothing on screen explaining why. The inverse also fires: 60 project + 40 personal = exactly 100, and the notice claims a truncation that did not occur.

**Fix.** Have main report the truncation rather than making the renderer infer it — return a `truncated` flag (or the exact total) alongside the rows — or, failing that, test `>=` against the per-scope worst case instead of `===` against a single cap.

---

## src/renderer/src/views/Learning.tsx:1625 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** Re-targeting a personal-scope candidate to kind "rule" sends `scope: 'path'` with no project id, which main always rejects — the guard next to it pre-empts the selector refusal but not this one, and its own comment claims a behaviour the code does not implement for this branch.

**Evidence.**

```
Learning.tsx:1623-1626: `// 'path' is what a selector means; anything else drops back off it, and a` / `// personal candidate keeps its scope because it has no project to hold.` / `scope: kind === 'rule' ? 'path' : candidate.scope === 'path' ? 'project' : candidate.scope,` — the `kind === 'rule'` branch is taken first and never consults `candidate.scope`. The Save button's only extra guard is Learning.tsx:1617-1618 `const retargetReady = kind !== 'rule' || selector.trim().length > 0;` whose comment says "repository.ts refuses one without it -- so the button is refused here rather than letting main throw". Main: repository.ts:349 `if (next.scope !== 'personal' && !next.projectId) throw new Error('Project and path-scoped candidates need a project id.');` and updateCandidate never receives a projectId from this caller.
```

**Failure.** Teach Wanigan a personal memory (TeachButton defaults to `scope: 'personal'`, `projectId: null`), open it in the Inbox, click Edit, set Kind to "Rule — writes to the provider file, for one path" and type `src/main/**`. `retargetReady` is true so "Save edit" is enabled; the call throws "Project and path-scoped candidates need a project id." There is no control in the editor that can attach a project, so the edit can never be saved and the operator's typed text is stuck in a modal whose save button will keep failing.

**Fix.** Either omit the `rule` option (or disable it) when `candidate.scope === 'personal' && !candidate.projectId`, or extend the patch to carry `projectId` and require one before enabling Save — folding it into `retargetReady` alongside the selector check, which is where the same class of pre-emption already lives.

---

## src/renderer/src/views/Learning.tsx:2004 — [medium] stale-response-wins  (PLAUSIBLE, sustained 2/3)

**Claim.** `choose()` invalidates the freshness generation but not the detail generation, so an in-flight knowledge-item read for the previous selection can land in the newly selected item's pane.

**Evidence.**

```
Learning.tsx:2004-2008 `const choose = (item: KnowledgeItem) => { setSelected(item); setDetail(null); … setDetailErr(null);\n    freshSeq.current++;\n    if (item.id === selected?.id) void refetch(item.id); };` — `freshSeq.current++` is there, `seq.current++` is not, and `seq` is the guard refetch() checks (`const mine = ++seq.current; … if (seq.current !== mine) return; setDetail(d); setRelations(rel);`, Learning.tsx:1990-2002).
```

**Failure.** Click item A, then click item B before A's `item()`+`relations()` round trip returns (the window is between the click handler and React's passive-effect flush that starts B's read). A's response passes the stale `seq` check and writes `setDetail(detailA)` under selection B. The header is guarded by `sel` (:2074) so it shows B's title and text, but the citation list, version history, projection rows and ROI figures at :2203-2320 read `detail` unguarded, so they are A's. If B's own read then fails, it stays that way: the error branch is gated on `detailErr && !detail` (:2181) and `detail` is no longer null, so the wrong item's evidence remains on screen under B's title with no error shown.

**Fix.** Add `seq.current++` next to `freshSeq.current++` in `choose()` so a selection change invalidates the in-flight detail read, and render `detailErr` even when a stale `detail` is still on screen.

**Dissent (the verifier who refuted).** Checked Learning.tsx:1971-2012 and 2179-2320, the render's error branches, the git history of these exact lines, and the comparable detail-pane in Batches.tsx. Three things refute it.

1. The seq ownership is intentional, not an omission. `git log -L 2004,2012:src/renderer/src/views/Learning.tsx` shows commit 07b6c99 rewriting exactly these lines: it removed the unconditional `void refetch(item.id)` from `choose()`, moved the fetch into `useEffect(..., [refreshTick, selected?.id, refetch])` under the new comment "Selection, returning to this tab, and recorded changes all re-read the item", and in the same hunk *added* `freshSeq.current++`. The asymmetry the finding points at is the point of that commit: `freshSeq` must be bumped in `choose()` because nothing else ever bumps it (`recheck()` is button-driven only, Learning.tsx:2013-2027), whereas `seq` is bumped by `refetch()` itself (`const mine = ++seq.current`, :1991) and every selection change now routes through the effect that calls it. The leftover `if (item.id === selected?.id) void refetch(item.id)` exists solely for the re-click/Retry case the effect cannot see. The same ownership is the house pattern: Batches.tsx:1096-1119 bumps `detailSeq` only inside `loadDetail` and drives it from `useEffect(() => { void loadDetail(); }, [loadDetail])` keyed on the id.

2. The stated persistent failure does not hold. The finding says the wrong item's evidence "remains on screen under B's title with no error shown" because the error branch is gated on `detailErr && !detail` (:2181). But Learning.tsx:2204 renders `{detailErr && <p className="learning-status bad">✕ {detailErr}</p>}` inline, and `readerArea` defaults to `'text'` (:1968), which is the branch containing :2204. In the default state a failed read for B is displayed. The silent variant requires the operator to have previously left the reader parked on Evidence or History — a second precondition the finding does not state.

3. The window is one task boundary, not "between the click handler and the effect" in any practical sense. `choose()` runs inside a discrete event; React commits synchronously and posts the passive-effect flush on the scheduler's MessageChannel during that same commit. Any `learning:item` reply dispatched after the commit is queued behind that message and loses the race, so the reply must already have been queued while the click's own render was executing. The realistic outcome is then a sub-frame flash that `refetch(B)` — already queued — overwrites one round trip later, not a stuck pane.

A `seq.current++` in `choose()` would be harmless and would close the theoretical window, so this is not provably safe by construction. But it is not defensible as a medium-severity defect: the guard placement is a deliberate, git-documented design shared with the rest of the codebase, and the concrete failure as written is contradicted by :2204.

---

## src/renderer/src/views/Learning.tsx:2037 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** Knowledge renders its checkboxes from the search results but resolves the checked ids against the unsearched `items` page, so selecting a search hit that is not on that page silently produces no selection — the bulk bar never appears and "Select all N" retires fewer than N.

**Evidence.**

```
Learning.tsx:2029 `const listed = results ?? items;` and Learning.tsx:2033 `const visible = listed.filter(...)` drive the rows and their `<input type="checkbox" className="knowledge-pick" checked={picked.includes(item.id)}` at Learning.tsx:2160. But Learning.tsx:2037-2039 `const pickedItems = picked.map((id) => items.find((item) => item.id === id)).filter((item): item is KnowledgeItem => item !== undefined);` looks only in `items`, and the bulk bar is gated on it: Learning.tsx:2130 `{pickedItems.length > 0 && (`. The two lists come from different queries with different caps: Learning.tsx:392 `knowledge({ projectId: scopeParam, limit: 200 })` (newest 200 by updated_at, all statuses) versus Learning.tsx:2005 `search(query.trim(), { projectId: scopeParam, limit: 80 })` (FTS rank over active items, repository.ts:850 `ORDER BY rank,i.confidence DESC,i.updated_at DESC`).
```

**Failure.** A store with more than 200 knowledge items in scope. Search for a phrase that matches an older active item; it appears in the results list with a checkbox. Tick it: the box shows checked, `picked` holds the id, `items.find` returns undefined, `pickedItems` is empty and the "1 selected / Retire selected…" bar never renders — the checkbox is inert with no explanation. With a mix, "Select all 5" under the unsynthesized-text filter (Learning.tsx:2122, which maps `unsynthesized` derived from `listed`) produces a bar reading "3 selected" and a confirmation dialog listing 3 items.

**Fix.** Resolve against the list the checkboxes were drawn from: `picked.map((id) => listed.find(...) ?? items.find(...))`. The comment at Learning.tsx:2034 ("Ids, not items: the picked rows are re-read from the reloaded list") is the right intent — it just needs `listed` as the lookup source.

---

## src/renderer/src/views/Learning.tsx:2605 — [medium] wrong-render  (CONFIRMED, sustained 3/3)

**Claim.** BriefingInspector's empty-result branch has no case for "everything that ranked was held back", so it prints "Retrieval ran and matched nothing / No active knowledge ranked" directly beneath the Held-back list that has just said those items ranked — and points the operator at the wrong fix.

**Evidence.**

```
Learning.tsx:2601-2605 `<HeldBackList briefing={result} />` then `{result.entries.length === 0 ? (queryUsed === false ? … : <Empty title="Retrieval ran and matched nothing" body="No active knowledge ranked for this query in this scope. … a broader query or a different project scope may match." />)`  the sibling inspector at Learning.tsx:1849-1851 has the missing branch: `: result.omitted > 0 ? { title: 'Nothing would be injected — everything that ranked was held back', …`
```

**Failure.** Set the briefing ceiling to 200 and preview a query that ranks one 400-token instruction. briefing.ts:211 counts it as `omittedBudget` and returns `entries: []`, so the panel renders "1 cut by the token ceiling — they ranked, and nothing was left of the budget. Raising the briefing ceiling admits these." and immediately under it "Retrieval ran and matched nothing — No active knowledge ranked for this query in this scope … a broader query or a different project scope may match." Two adjacent elements contradict each other and the visible advice (broaden the query, change scope) is the one thing that will not help. Same render for three stale-cited items (`omittedStale`).

**Fix.** Add the `result.omitted > 0` branch the sibling component at 1849-1851 already has, so a fully held-back retrieval is named as such instead of reported as no match.

---

## src/renderer/src/views/Learning.tsx:2680 — [medium] swallowed-failure  (PLAUSIBLE, sustained 2/3)

**Claim.** In the one control that can spend money, both model-assist reads render every failure — and a legitimate `null` answer — as nothing at all, so "Review what would be sent…" is indistinguishable from a dead button and the card asserts "no profile is approved" for a read that never returned.

**Evidence.**

```
Learning.tsx:2680-2684 `const showPreview = (providerId, model) => { void window.wanigan.learning.modelAssistPreview(providerId, model ?? null).then(setPreview).catch(() => setPreview(null)); };` with the only consumer at :2692 `{preview ? (…) : null}` — and main returns null rather than throwing for an unroutable profile: learning-model-assist.ts:149-152 `if (!def) return null; const protocol = String(def.headless ?? 'none'); if (protocol === 'none') return null;`. The status read is the same shape at Learning.tsx:2662-2665 `.then(setStatus).catch(() => setStatus(null))`, while the card's own doc comment at :2640-2642 says "When it is off, `status.routing.detail` says which of the three refused, by name. A control that silently does nothing is the thing this card exists to avoid."
```

**Failure.** (a) Pick a profile whose pack has been disabled or uninstalled since the provider list was read and press "Review what would be sent…": modelAssistPreview resolves to null, `preview` stays null, and the button produces no panel and no message, permanently. (b) modelAssistStatus rejects (any DB error): `status` becomes null, so `status?.consent` is falsy and the card replaces the "Approved: <provider> … Withdraw approval" line with the "Choose a profile…" picker — asserting that no profile is approved when a consent record may exist — while the checkbox is disabled (`!settings.allowModelAssistance && !status?.consent`, :2775) with `refusal` null, i.e. greyed out with no reason given. This is the bug class Settings.tsx:520-527 documents as already fixed for the three key reads.

**Fix.** Keep a `previewErr`/`statusErr` beside each state and render it: on a null preview say the profile can no longer be routed, on a rejected status say the card could not read consent/routing rather than drawing the approval picker.

**Dissent (the verifier who refuted).** The code shape is quoted accurately (Learning.tsx:2680-2684 and :2662-2665 both collapse failure to null, consumed at :2692 and :2697), but neither stated failure state reproduces. (a) The `protocol === 'none'` null branch cannot be reached from this picker: `eligible` filters on `capabilities.headlessJson` (:2671), and that flag can only be true when `headless !== 'none'` — all five built-in profiles declare a protocol (provider-packs.ts:871/911/939/963/994), local packs are forced false at providers.ts:544 (`if (def.source === 'local') return false;`), and the adapter route is refused by provider-adapter.ts:108-110 (`if (key === 'headlessJson') return profile.headless !== undefined && profile.headless !== 'none' && …`); the codex help-text widening at providers.ts:603 requires the builtin codex profile, which declares `codex-json`. The `!def` branch requires the profile to vanish between read and click, and the finding's own repro is closed: pack enable/disable/remove exists only in SettingsView (preload/index.ts:83-102, Settings.tsx:1253), and App.tsx:1403 vs :1424 are exclusive branches so Learning/ModelAssistCard unmounts (pick and preview reset), while re-entering the tab re-reads providers via App.tsx:525 (`if (tab === 'context' || tab === 'learning' || tab === 'scout') void loadShell()`) and App.tsx:520 on focus — the disabled profile is not in the list to pick. (b) I found no reachable rejection of modelAssistStatus that spares the surrounding view: the pack registry is written never to throw (provider-packs.ts:1340+ collects `diagnostics`; manifestLocations :1148-1152 catches readdir; readManifest returns {errors}; compileProviderProfile :1080-1137 returns {} for a missing credential rather than throwing), the lone `throw` at providers.ts:470 iterates the same snapshot runtimeById reads so is unreachable, and accounts.resolve only throws on the explicitAccountId branch (accounts.ts:391-392) which this call does not use — leaving only a SQLite failure, which would equally break learning.settings() and the reads that made the card render. Residual not claimed as reproduction: `pick` survives a focus-triggered loadShell (no remount), so an out-of-band deletion/edit of a pack on disk while the picker is open would leave a stale id with the button enabled and the click producing nothing — a filesystem race, not the described state. Separately, `status` is null for the initial IPC round-trip, so the picker branch flashes even with consent stored; that is a frame, not a persistent false assertion.

---

## src/renderer/src/views/Learning.tsx:2697 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** When routing refuses with 'profile-changed', the model-assist card renders the instruction "Review and approve it again" while rendering no control that can re-approve — the approval picker exists only in the `!status.consent` branch.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:2697 `{status?.consent ? (` … 2709 `<button className="btn" …>Withdraw approval</button>` … 2711 `) : eligible.length ? (` … 2720 `<button className="btn" disabled={!pick} onClick={() => showPreview(pick, modelDraft)}>Review what would be sent…</button>`. `showPreview` (line 2680) is the only caller that can set `preview`, and `preview` is the only thing that renders the Approve button. Meanwhile line 2782 renders `{refusal ? <p className="faint">{refusal.detail}</p> : null}` where the detail text comes from src/main/learning-model-assist.ts:325: `detail: \`${def.label} has changed since it was approved. Review and approve it again.\``.
```

**Failure.** A trusted provider pack is upgraded, so `def.profileFingerprint !== consent.fingerprint`. `assessRouting` returns 'profile-changed', `settings().allowModelAssistance` goes false, the header flips to "Deterministic only", and the card prints "Codex CLI has changed since it was approved. Review and approve it again." The consent record still exists, so the `status?.consent` branch wins and the profile picker plus "Review what would be sent…" are never rendered. The only buttons on the card are "Withdraw approval" and a checkbox whose save is refused by the same verdict. The operator cannot follow the instruction they are given, and model-assisted phrasing stays off permanently unless they guess that Withdraw is the prerequisite.

**Fix.** Render the profile picker / "Review what would be sent…" control whenever `status.routing.ok === false` and the reason is re-approvable ('profile-changed'), not only when `status.consent` is null — or make the consented line itself offer "Review this profile again…" calling `showPreview(status.consent.providerId, status.consent.model)`.

---

## src/renderer/src/views/Learning.tsx:2796 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The learning budget governor prints the all-time run count and the all-time average cost inside a sentence framed "this month", on the one control in Wanigan that spends money.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:2796-2797 — `` `$${status.monthToDateUsd.toFixed(2)} recorded this month across ${status.runs.length} call${pl(status.runs.length)} read back` + `${status.averageCostUsd === null ? '' : `, averaging $${status.averageCostUsd.toFixed(4)} a call`}.` ``. `monthToDateUsd` is month-scoped and priced-only (src/main/learning-model-assist.ts:228 `WHERE at >= ? AND cost_reported=1`, with `startOfMonth()`), but `runs` is neither month-scoped nor status-filtered (src/main/learning-model-assist.ts:706 `SELECT at, provider_id, status, cost_usd, cost_reported FROM learning_model_runs ORDER BY at DESC LIMIT 20`) and `averageCostUsd` is all-time (line 692 `FROM learning_model_runs WHERE cost_reported=1`, no `at` bound).
```

**Failure.** March records 12 priced phrasing calls totalling $1.50. On 2 April, with no calls made, the card reads "$0.00 recorded this month across 12 calls read back, averaging $0.1250 a call." — asserting 12 calls this month when there were none. In the other direction, 50 calls in one month print as "across 20 calls read back" because of the `LIMIT 20`, and `runs` also counts rows whose `status` is 'failed' or 'refused' (recorded by `recordRun` at src/main/learning-model-assist.ts:236 with `costUsd: null`), so calls that spent nothing are reported as calls in a spend sentence.

**Fix.** Either scope the sentence to what is actually month-scoped — drop the count and the average from the "this month" clause — or add a month-scoped, ok-status, `cost_reported=1` count to `ModelAssistStatus` and print that. The 20-row `runs` page is a recent-activity list, not a monthly total, and should not be described as one.

---

## src/renderer/src/views/Learning.tsx:2824 — [medium] error-identification  (PLAUSIBLE, sustained 2/3)

**Claim.** An out-of-range briefing ceiling is silently discarded and the field snapped back, with no message anywhere, so the operator is left believing a value was saved that never was.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:2821-2825 — `const commitCeiling = () => {` / `const n = Number(ceilingDraft);` / `if (Number.isFinite(n) && n >= 200 && n <= 8000 && n !== settings.briefingMaxTokens) void save({ briefingMaxTokens: n });` / `else setCeilingDraft(String(settings.briefingMaxTokens));` / `};`. The preceding comment justifies only the draft-then-commit shape ("main rejects values outside 200–8000, so per-keystroke saves would fail mid-typing"), not the silent discard. Main has the sentence the user needs, at src/main/learning-service.ts:213 — `if (!Number.isFinite(value) || value < 200 || value > 8_000) throw new Error('Briefing ceiling must be 200–8,000 tokens.');`
```

**Failure.** Learning → Context → "Adaptive context router". Type 9000 (or 0, or 20, or a non-number) into "Briefing ceiling · tokens" and press Tab or Enter. The field silently reverts to the stored value — 1200 on a default install — and nothing is rendered: no Note, no inline error, no live-region text, and the view's `error` state is never set because `save()` is never called, so main's "Briefing ceiling must be 200–8,000 tokens." is never reached. The operator walks away believing briefings are now capped at 9000 tokens while every session is still cut at 1200. For a screen-reader user the only signal is that the field's value changed under them with no announcement.

**Fix.** In the else branch, surface the reason before reverting — set the same sentence main uses through the view's existing error/Note path (e.g. `setError('Briefing ceiling must be 200–8,000 tokens.')`) — so the refusal is stated rather than performed silently.

**Dissent (the verifier who refuted).** Read Learning.tsx:2818-2825 and 2864, its comment, act() at 447-462, the twin commitBudget at 2674-2678, learning-service.ts:211-214, settings.ts:218-223, Context.tsx:1234-1238, and git -S history for both fields. The behaviour is real but the stated failure is not. (1) No surface ever renders the rejected value as saved: the snap-back writes the stored value back, and Context's "Budget ceiling" Stat reads the same settings field, so after the commit everything shows 1200 — the truth. The claim "the operator walks away believing briefings are now capped at 9000" requires some surface to assert 9000; none does. There is no wrong output, wrong render, wrong persisted value, wrong money or crash — only a missing explanatory sentence. (2) Saved and not-saved are distinguishable: act() sets a notice ("Learning controls updated. New sessions use the new retrieval policy.") on every successful save, so a rejected entry is marked by the absence of that toast plus a field that visibly returns to stored truth. (3) The shape is the author's stated design for exactly this range and is used twice in different commits — commitCeiling (197af15) and commitBudget at 2674-2678 (a941c9b, min 0/max 10,000, identical else-branch) — a convention, not a one-site oversight; min={200} max={8000} are declared on the input (AT-exposed spinbutton range) and the range is spelled in prose at Learning.tsx:1161 "user-set, 200–8,000". (4) It matches the repo's own documented rule rather than violating it: Settings.tsx:455-472 records the bug this shape avoids — a numeric box holding a plausible number nobody set, which Save then wrote over the operator's real value; reverting to stored truth is that decision. Conceded: save() is never called, so learning-service.ts:213's "Briefing ceiling must be 200–8,000 tokens." never reaches the renderer, and no smoke assertion (grep briefingMaxTokens/ceiling over src/main/smoke*.ts returns nothing) nor commit message pins the silence. The residue is a missing explanatory message on a field that never misreports state — polish, below this audit's bar of a specific wrong output, render, money or crash. Medium rather than high because the recorded learning-UX doctrine ("reason codes on every automated decision", "banned: silent lossy steps") argues for adding that sentence.

---

## src/renderer/src/views/Learning.tsx:2890 — [medium] suppressed-finding  (PLAUSIBLE, sustained 2/3)

**Claim.** The Context tab hides every 'unused' diagnostic and tells the operator the rule "fires on age alone" because nothing records item use — a claim two production metric writers have since falsified, so a finding now computed from recorded evidence is suppressed behind a false explanation.

**Evidence.**

```
Learning.tsx:2827-2830 `// invocation/use_success/use_failure row exists for it. Nothing in this build // writes those rows — the only production writer of artifact_metrics records // tokens_loaded — so the rule reduces to age and is not evidence of disuse.`  Learning.tsx:2833 `const findings = diagnostics.filter((d) => d.kind !== 'unused');`  Learning.tsx:2890-2891 "Nothing in this build records a knowledge item being used, so that rule fires on age alone — it is not evidence that anything is unused."  learning-service.ts:1836 `metric: 'invocation'` (reached from observeSessionEvent, wired at index.ts:920)  ledger.ts:372 `metric: 'cited'`  optimizer.ts:91 `if (item.createdAt < unusedBefore && (!use.n || (use.last_at ?? 0) < unusedBefore))`
```

**Failure.** Item A is 90 days old and its projected skill was invoked yesterday: `use.n = 1`, `last_at` recent, so optimizer.ts:91 does not fire — proving the rule discriminates on recorded use, not age. Item B is 90 days old with no invocation and no transcript citation in 45 days: the rule fires, the row is stripped from the list at Learning.tsx:2833, its own wording ("check its briefing deliveries before retiring or narrowing it", optimizer.ts:94-95) is never shown, and the operator reads that the rule fired on age alone and is not evidence of anything. A real evidence-backed finding is presented as noise.

**Fix.** Restore the 'unused' rows to the diagnostics list — optimizer.ts:93-97 already words them as a prompt to look rather than proof — and rewrite the paragraph to say what the rule actually reads now: hook-observed `Skill` calls and `wanigan:<id>` transcript citations in the window.

**Dissent (the verifier who refuted).** The finding's central technical claim — that "two production metric writers have since falsified" the comment — is wrong on both writers, so the filter's explanation is accurate as shipped.

(1) ledger.ts:372 `metric: 'cited'` sits in `recordTranscriptCitations` (src/main/learning/ledger.ts:331). Its ONLY callers are src/main/smoke4.ts:1645/:1652/:1664 — the offline smoke suite, reached via the dynamic `await import('./smoke4')` at src/main/smoke.ts:203 — plus two re-export lines (learning-service.ts:37, :2005). No IPC channel exists for it: the entire learning surface in src/preload/index.ts:694-794 exposes no scan call, and nothing on the session-exit path invokes it, despite its own doc comment at ledger.ts:330 saying "Never throws: it runs on the session-exit path." Production writes zero `cited` rows. The wired reader `transcriptCitationSummary` (ledger.ts:291, used at :429) is read-only.

(2) learning-service.ts:1836 `metric: 'invocation'` is unreachable in production because of its own guard at learning-service.ts:1831: `if (event.event !== 'PostToolUse' || event.toolName !== 'Skill' || !event.summary) return;`. The sole producer of `SessionEvent.summary` is `summarise()` at src/main/hooks.ts:797 (called at :708, stored at :728-735), and hooks.ts contains NO occurrence of "skill" case-insensitively anywhere. A `Skill` PostToolUse therefore falls through both switches to the default at hooks.ts:863-865: `const p = firstPath(ti); if (p) return tail(p); return clip(str(ti.command) ?? str(ti.description) ?? str(input.message), MAX_SUMMARY);` with `PATH_KEYS = ['file_path','path','notebook_path']` (hooks.ts:966). Claude Code's Skill tool input is `{skill, args}` — every key misses, `str()` returns null for non-strings (hooks.ts:1021-1024), and `clip(null, …)` returns null (hooks.ts:1027-1028). Summary is null, so recordSkillInvocation returns before recordMetric. The repo's own fixtures confirm this shape: smoke4.ts:769 inserts a PostToolUse/Skill row with a NULL summary, and ledger.ts:261-265 counts null-summary Skill rows as `unrecorded`. The smoke test that does exercise the metric (smoke4.ts:1618-1620) hands observeSessionEvent a hand-built event with `summary: reSkill.name`, bypassing summarise() entirely — which is why the gate passes while production records nothing.

Consequence: failure scenario A (use.n = 1, recent last_at) cannot occur. With `cited` unwritten, `invocation` unwritten, and `tokens_loaded` excluded from the `metric IN ('invocation','use_success','use_failure','cited')` filter at optimizer.ts:58-60, useStmt returns n = 0 for every item, so optimizer.ts:91 genuinely reduces to `item.createdAt < unusedBefore`. Learning.tsx:2827-2831 and the operator sentence at :2890-2891 are both true for a real build; no evidence-backed finding is being suppressed and no wrong render results.

Residual, immaterial: three comments are stale (ledger.ts:330's claimed session-exit caller does not exist; ledger.ts:261-262 says the hook recorder "fills with the skill name only" when it fills null; Learning.tsx's metric list omits 'cited'). Documentation drift only — it changes no render, no money, and drops no diagnostic, so it does not sustain the finding as written.

---

## src/renderer/src/views/Learning.tsx:926 — [low] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The signals chart asserts "Recording began <date>" from the first non-empty day inside the selected window, which is false whenever signals exist before the window — a fact the component is handed in `pipeline.signalsAllTime` and already uses correctly two branches away.

**Evidence.**

```
src/renderer/src/views/Learning.tsx:921-927 — `const firstIdx = rows.findIndex((r) => r.total > 0);` … `const clipNote = total > 0 && shown.length < rows.length ? \`Recording began ${fmtDay(rows[firstIdx].day)} — showing ${shown.length} of the ${windowDays}-day window; earlier days had no signals.\` : null;`. `rows` is `pipeline.signalsByDay`, which only covers the window. The out-of-window fact is available and used in the sibling branch at line 951: `{pipeline.signalsAllTime > pipeline.signals && (<p className="faint">Signals were recorded before this window. …</p>)}`, and the shared type documents it that way (src/shared/types.ts:2869 "Same project scoping, no time window — lets 'outside this window' be a fact.").
```

**Failure.** An operator ran sessions heavily two months ago, stopped, then ran one yesterday. With the 30-day window selected, `firstIdx` is day 29, `span` is 1, `shownDays` is 7, and the caption under the chart reads "Recording began Sep 10 — showing 7 of the 30-day window; earlier days had no signals." Recording actually began two months earlier; `pipeline.signalsAllTime > pipeline.signals` is true and disproves the sentence. On a legibility surface whose stated contract is that every line is a count over stored rows, this prints an inference as an observation.

**Fix.** Gate the wording on the fact already in hand: when `pipeline.signalsAllTime > pipeline.signals`, say "No signals in the earlier days of this window; more were recorded before it" and reserve "Recording began …" for `pipeline.signalsAllTime === pipeline.signals`.

---

## src/renderer/src/views/Learning.tsx:1361 — [low] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The Teach sheet enables "Add to Inbox" for scope "Project path" with the path pattern left blank, which main refuses outright.

**Evidence.**

```
Learning.tsx:1361 `disabled={busy !== null || !title.trim() || !text.trim()}` — the guard never mentions `pathScope`. Learning.tsx:1340 `pathScope: scope === 'path' ? pathScope.trim() || null : null` deliberately sends null for a blank box. Main: learning-service.ts:371 `if (input.scope === 'path' && !input.pathScope?.trim()) throw new Error('Path-scoped teaching needs a path selector.');`. The same class of pre-emption is implemented for the Inbox editor's rule selector at Learning.tsx:1617 ("the button is refused here rather than letting main throw") but not here.
```

**Failure.** Open Teach Wanigan with a project selected, fill in a title and the knowledge, set Scope to "Project path", leave "Path pattern" empty (it is a plain optional-looking text box with placeholder `src/payments/**`), click "Add to Inbox". The call throws "Path-scoped teaching needs a path selector." and shows as a red error banner over the view, with no indication that the empty field was the cause.

**Fix.** Extend the disabled expression to `|| (scope === 'path' && !pathScope.trim())` and give the button a title naming the missing selector, mirroring `retargetReady` in CandidateCard.

---
