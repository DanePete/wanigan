# Batches view — src/renderer/src/views/Batches.tsx, src/renderer/src/styles/batches.css, src/renderer/src/styles/evals.css, src/main/batch/*.ts

49 findings. readability={"firstPaintWords": 10, "fontSizesInSheet": 3, "explainerHintNoteUses": 44, "nestedBorderDepth": 1, "notes": "First paint: h1 \"Batches\" plus the 9-word lead \"Bulk work across your repos, asynchronous, at half price.\" before the first control (\"New run\"), confirmed at Batches.tsx:228-231 and in both screenshots. batches.css declares font-size three times, all tokens (--t-micro on .bx-out, --t-body on .bx-state h4, --t-small on .bx-state p and .bx-golden-line); evals.css is the Skills sheet and is not imported by this view. Note used 44 times, Hint 0, Explainer 0. Primary content on the list screen sits one bordered container deep (.pane > .card > table); the builder's dataset preview sits two deep (.card.section > .sunk > table) and the pre-flight KV block two deep (.card > .sunk), with the inner border suppressed by `.card .sunk { border-color: transparent }`."}

notes: Screenshot verdicts: the sidebar \"Batches 2\" badge beside \"Active 0 · nothing in flight\" is a stub artifact (scripts/renderer-harness.mjs:218 seeds batch.runsInFlight={runs:2} while the Proxy answers batch.runs() with []); in product both read the same runs table over the same IN_FLIGHT statuses, so not reported. \"No runs yet\" + \"Build your first batch\" and the green \"~$0.00\" Saved tile are real code paths (Batches.tsx:311-316, 298) and are confirmed against the TSX. batches.css itself is clean: no colour, no literal sizes, three token font sizes. evals.css is not this view's sheet at all (it is the Skills sheet, globally @imported by index.css:13). The most consequential items are the unwired main-process functions (runVariant, judgePair, estimateRescue, diagnose, hitRateAcrossRuns: no caller outside src/main/batch/, none in src/main/mcp/server.ts, none in preload) because the Evals and Refusals copy tells the operator to use them; the undefined `.scroll-x` class on four tables; headless runs leaking into an unfiltered listRuns (documented as deferred debt in batch/index.ts); and the batch:refreshModels handler swallowing failures the renderer was specifically written to display. Every finding was verified in code; none rests on a screenshot alone. Notes file: <scratchpad>/research/batches-audit-notes.md

## 1. [bug/high/small] className "scroll-x" matches no overflow rule anywhere
- where: src/renderer/src/views/Batches.tsx:302
- evidence: `<div className="card scroll-x">` wraps the run table (302), the results table (1397), the batches table (1442) and `<div className="sunk scroll-x">` wraps the dataset preview (746). `grep -c scroll-x src/renderer/src/index.css` = 0; the only rule in any sheet is compact.css:79 `.table-scroll, .scroll-x, … { -webkit-overflow-scrolling: touch; }`, which sets no overflow. batches.css already defines `.bx-scroll { overflow-x: auto; }` for the newer tables.
- failure: A wide table (six-column batches tab with 30-char mono batch ids, a preview with a `content` column, a results table at the compact breakpoint) is not clipped by its card: it widens the card and the .pane scrolls sideways, which CLAUDE.md says the body must never do. The four older tables silently lack the guard the newer ones have.
- fix: Either add `.scroll-x { overflow-x: auto; }` to index.css (where `.scroll-y` lives at line 760) or replace the four `scroll-x` uses with the existing `bx-scroll`.

## 2. [bug/high/medium] Headless runs are listed and acted on as batch runs
- where: src/main/batch/index.ts:157
- evidence: listRuns(): `FROM runs r ORDER BY r.created_at DESC LIMIT 200` — no `kind` predicate. headless.ts:740-742 inserts `INSERT INTO runs (… kind …) VALUES (… 'headless' …)` with status 'submitting' and rows into `headless_rows`, not `requests`. Batches.tsx never reads `kind` (grep: only `source.kind`). The Active tile (291) counts the same statuses, RunDetail offers `batch.cancel` (1297) and `Delete run…`, and the Cost tile (1349) reads `run.cost_usd ? usd(...) : usdEst(run.est_cost_usd)`. The comment above runsInFlight in the same file acknowledges the list is not scoped and defers it.
- failure: A headless fan-out appears in the Batches list with "0 of N requests", a bar reading "No requests counted yet", cost "~$0.00 est. · no token counts returned yet" for the life of the run, and an Expires column of "—"; opening it shows a Batch-API Cancel button (cancelRun finds no `batches` rows and flips the run to 'canceling'), an Export that writes an empty file, and a Delete that removes headless evidence from a surface that never explained it was headless.
- fix: Filter listRuns (and the Active tile) to `kind IN ('batch','eval')`, or return `kind` on the row and render a kind mark plus route headless rows to the Runs view; at minimum hide Cancel/Retry/Export for non-batch kinds in RunDetail.

## 3. [honesty/high/small] Model refresh failure is swallowed in main, so the "refresh failed" Note can never fire
- where: src/main/index.ts:1652
- evidence: `handle('batch:refreshModels', async () => { try { return await batch.refreshModels(); } catch (e) { return { models: [], fetchedAt: 0, source: `unavailable — ${…}` }; } })`. Batches.tsx:500-513 `refreshCatalog()` does `await window.wanigan.batch.refreshModels(); const d = await window.wanigan.batch.presets(projectId); setModels(d.models); …` and only sets `modelsErr` in its own catch, with the comment "a swallowed failure leaves the previous capability table on screen looking freshly read".
- failure: Click "Refresh models" with a bad key or offline: the handler resolves, the renderer re-reads the cached catalog, the button returns to "Refresh models", and the paragraph above still says "Capabilities read from the Models API — over a day old" — exactly the silent stale state the renderer comment says it guards against.
- fix: Rethrow in the handler (or have the renderer read the returned `source` and treat `unavailable —` as an error), then show the existing `Model refresh failed` Note.

## 4. [unfinished/high/large] Evals tab instructs the operator to do two things no control can do
- where: src/renderer/src/views/Batches.tsx:2313
- evidence: Empty state: "Copy this run in the builder, change exactly one field — the model, the effort, max_tokens, the template or the schema — and submit it." (2313) and the judge box: "Paste the id of a judge run created for this pair" (2443). Batches.tsx has no duplicate/copy/open-in-builder control (grep for duplicate|clone|Copy config: only that sentence). evals.ts exports `runVariant` (359) and `judgePair` (517); `grep -rn runVariant|judgePair src` finds no caller outside src/main/batch/, nothing in src/main/mcp/server.ts, and the preload `evals` namespace (index.ts:541-549) has only pairs/createPair/diff/summary/ingest/golden/saveGolden/goldenSource.
- failure: An operator following the on-screen instructions cannot produce a B run except by retyping the whole config by hand, and cannot produce a judge run at all — `ingestJudgement` rejects any run whose `kind !== 'eval'` (evals.ts), so the "Ingest scores" input can only ever fail with "is not a judge run". The Verdict card's "run a judge pass" sentence points at nothing.
- fix: Wire `evals:variant` and `evals:judge` IPC handlers plus preload methods; add a "Run variant" form on the Evals tab (one field + value + name) and a "Judge this pair" form (model, rubric, effort) that shows the price from priceOf before submitting; add a "Duplicate into builder" action on RunDetail that seeds NewRun's cfg.

## 5. [unfinished/high/medium] Rescue submits a paid run with no price shown; estimateRescue is unwired
- where: src/renderer/src/views/Batches.tsx:2092
- evidence: Copy under the Rescue button: "The rescue is priced before it is submitted, so it goes through the per-run spend cap rather than around it." The button (`Rescue ${num(total)} row…`) calls `window.wanigan.refusal.rescue(runId, pick)` directly. refusal.ts:87 exports `estimateRescue()` returning `{rows, costLowUsd, costHighUsd, cacheWarning}`; the preload `refusal` namespace (index.ts:529-535) has rows/summary/rescue/merge/children only and `grep -rn estimateRescue src` finds no caller outside src/main/batch/.
- failure: The operator commits spend on a second model with no dollar figure in front of them — the pricing happens in main and is never shown — which is the "do not silently spend tokens" guardrail; the builder shows an estimate before Submit, the rescue does not.
- fix: Add `refusal:estimate` IPC + preload; when a fallback model is picked, call it and render `~$low – ~$high est.` and the cacheWarning beside the button; label the button "Rescue N rows — up to ~$X est." like Submit does.

## 6. [bug/medium/small] Failed delete navigates back to the list and loses its error
- where: src/renderer/src/views/Batches.tsx:1320
- evidence: `onRun={async () => { setConfirmDelete(false); await act(() => window.wanigan.batch.remove(id), 'delete'); onBack(); }}`. `act()` catches and stores the throw in `actErr` and returns normally, so `onBack()` runs unconditionally. deleteRun (batch/index.ts:280-287) throws for IN_FLIGHT statuses and for a missing run.
- failure: Confirm delete on a run that is still 'canceling': main refuses with "Cancel the run and let it finish stopping before deleting it…", the view immediately unmounts to the run list, the message is never seen, and the run is still there with no explanation.
- fix: Have `act` return a boolean (or rethrow) and call `onBack()` only on success; keep the ConfirmNote open on failure so the error Note is visible.

## 7. [bug/medium/small] Results search fires a LIKE query per keystroke with no debounce or ordering guard
- where: src/renderer/src/views/Batches.tsx:1190
- evidence: `const loadRows = useCallback(async () => { … await window.wanigan.batch.results(id, filter, q, offset); setRows(r.rows); … }, [id, filter, q, offset]);` and `useEffect(() => { void loadRows(); }, [loadRows]);`; the input at 1387 does `onChange={(e) => { setQ(e.target.value); setOffset(0); }}`. runResults (batch/index.ts) runs `custom_id LIKE ? OR rendered LIKE ? OR output_text LIKE ? OR error_message LIKE ?` over the run's rows.
- failure: Typing "error" issues five full-scan queries over `rendered` (which holds inlined file contents on a repo audit); responses can resolve out of order so the table can settle on the rows for "erro" while the box says "error". The 8-second poll's `loadRows()` interleaves the same way.
- fix: Debounce `q` by ~250 ms and keep a request sequence number in a ref, discarding responses that are not the latest.

## 8. [bug/medium/small] Extended output stays checked and disabled after switching to a model that lacks it
- where: src/renderer/src/views/Batches.tsx:878
- evidence: `<input type="checkbox" disabled={!model?.extendedOutput} checked={!!cfg.extendedOutput} …>`; the model select's onChange (826) is `patch({ model: e.target.value }); invalidate();` and never clears `extendedOutput`. build.ts errors with `${model.label} does not support the extended-output beta.` and the cap line (843) prints 300000.
- failure: Pick Opus 5 with extended output on, then switch to Haiku 4.5: the box is greyed but still ticked, "cap 300,000" still shows, Estimate returns the error and Submit is blocked, and there is no way to untick except switching back to a supporting model.
- fix: In the model onChange, clear `extendedOutput` (and clamp `maxTokens`) when the new model's `extendedOutput` is false; never render a disabled control in a state the operator cannot leave.

## 9. [bug/medium/small] Model select silently shows the first option when cfg.model is not in the catalog
- where: src/renderer/src/views/Batches.tsx:825
- evidence: `<select className="field" aria-label="Model" … value={cfg.model}>` renders only `models.map(...)`; `model = models.find((m) => m.id === cfg?.model)` may be undefined (cfg is a remembered draft from view memory, or a preset id absent from a Models-API catalog filtered to `supportsBatch`). Line 843 then prints `cap {num(… model?.maxTokens ?? 0)}` = "cap 0".
- failure: A native select with a value matching no option displays its first option, so the form reads "Opus 5" while `cfg.model` — the string actually sent to the API — is something else; the effort row disappears and the cap reads 0 with no explanation.
- fix: When `!model`, prepend an option `{cfg.model} — not in the catalog` so the select is truthful, and replace "cap 0" with "cap unknown for this model".

## 10. [bug/medium/small] Upload-cache Delete removes an organisation-wide remote file with no confirmation
- where: src/renderer/src/views/Batches.tsx:1683
- evidence: `<button className="btn btn-danger bx-f" … disabled={busy !== null} onClick={() => void remove(f)}>` calls `uploads.remove(f.hash)` → files.ts:305-322 `deleteUpload()` → `client().beta.files.delete(row.file_id, …)`. The same file's prune copy admits "the Files API is organisation-wide, and another tool's files live there too." bits.tsx documents tier T2 (records lost) as "this component: one inline sentence … a verb button … and Cancel" via ConfirmNote, which this view already imports.
- failure: One mis-click deletes the remote file every later run was going to reuse for free; the next run with the same bytes re-uploads, and any other tool referencing that file_id fails.
- fix: Wrap the delete in the existing ConfirmNote ("Delete <name> from the Files API. Runs that reuse it will re-upload it.").

## 11. [bug/medium/medium] Filter, effort and pair pills expose no pressed state; tabs have no tab semantics
- where: src/renderer/src/views/Batches.tsx:1383
- evidence: Results filter: `<button key={f} className="pill" onClick=…>` with only an inline background swap (1383); the same pattern for effort (860), pair pills (2355) and the eval row filter (2476). Only the source picker carries `aria-pressed` (725). Tabs: `<div className="tabs">{tabs.map((t) => <button … className={activeTab === t ? 'tab-on bx-f' : 'bx-f'}>` (1369-1371) with no role or aria-selected. CLAUDE.md names `Segmented`/`Chip` for this; ui.css styles `[aria-pressed='true']`.
- failure: A screen-reader or keyboard user tabbing through "all succeeded failed pending" hears four unlabelled buttons with no indication which filter is active, and the run-detail tabs read as six unrelated buttons.
- fix: Replace the four pill groups with `Segmented` (or `Chip` with `pressed`) and give the tab strip `role="tablist"`/`role="tab"`/`aria-selected`.

## 12. [bug/medium/small] "Choose file…" has no keyboard route
- where: src/renderer/src/views/Batches.tsx:1089
- evidence: `<label className="btn" …> Choose file… <input type="file" style={{ display: 'none' }} …/> </label>` — a `display:none` input is removed from the tab order and a `<label>` is not focusable, so nothing in this control receives focus.
- failure: The CSV/JSONL picker can only be reached by pointer; every other control in the builder is reachable by Tab.
- fix: Use the `.sr-only` class (ui.css:189) on the input instead of `display:none`, or make the label a real `<button>` that calls `inputRef.current.click()`.

## 13. [honesty/medium/small] An ended run that billed nothing shows the pre-submission estimate as "not yet returned"
- where: src/renderer/src/views/Batches.tsx:1349
- evidence: `<Stat label="Cost" value={run.cost_usd ? usd(run.cost_usd) : usdEst(run.est_cost_usd)} sub={run.cost_usd ? 'priced from returned token counts' : 'est. · no token counts returned yet'} />`; same branch in the list at 346-347. results.ts rollUp() writes `cost_usd = 0` when every row carried zero usage (all errored/expired/canceled), and a 'failed' submission never gets counts at all.
- failure: A run whose batch expired with 100% of rows unanswered, or whose submission failed, reads "~$4.20 est. · no token counts returned yet" forever — the estimate is presented as a pending charge on a run that is over and cost $0.
- fix: Branch on `run.status` / `run.ended_at`: for a finished run with `cost_usd === 0` show "$0.00 · nothing billed"; keep the estimate only while `live`.

## 14. [honesty/medium/small] Submit button prints a dollar ceiling for a model with no published rate
- where: src/renderer/src/views/Batches.tsx:978
- evidence: `{submitting ? 'Submitting…' : est ? `Submit — up to ${usdEst(est.costHighUsd)} est.` : 'Submit'}`. estimate.ts sets `unpricedModel` and its notes say "every cost here is … rates standing in — a placeholder, not this model's price"; the renderer only renders those notes as faint `<p>`s (line ~960) and never reads `est.unpricedModel`. submit.ts refuses only when a spend cap is armed; with cap 0 it records `est_cost_usd` from the stand-in.
- failure: With the cap off, the operator clicks "Submit — up to ~$3.10 est." for a model Wanigan cannot price, the run stores that stand-in figure, and the run list then shows "~$3.10 est." as if it were this model's estimate.
- fix: When `est.unpricedModel` is set, label the button "Submit — price unknown for this model", drop the tilde figure from the Est. cost tile, and pass `cost: 0`/flag so the row is stored as unpriced rather than as an estimate.

## 15. [honesty/medium/small] "Saved vs sync" is an estimate painted in the observed-good colour
- where: src/renderer/src/views/Batches.tsx:298
- evidence: `<Stat label="Saved vs sync" value={usdEst(spent)} tone="var(--ok)" sub="est. · batch rates are 50% of list" />` — tone is unconditional. Both screenshots show a green "~$0.00" with "Spent $0.00" beside it. The comment above it says it is "a modelled counterfactual … arithmetic, not an invoice line".
- failure: A green figure reads as an observed win; here it is arithmetic on a published discount, and at $0 spent it is a green zero — the learning-UX doctrine in project memory bans exactly a green that is not observed.
- fix: Drop the tone (or use `--text-dim`), and hide the tile until `spent > 0`.

## 16. [honesty/medium/small] Stat tiles print 0 and $0.00 before the first read has returned
- where: src/renderer/src/views/Batches.tsx:289
- evidence: `<div className="stat-grid"> <Stat label="Runs" value={num(runs.length)} /> …` renders unconditionally while `loading` is true (`useState(true)` at 176); only the table body shows "Reading your batch runs…" (311). `runs` starts as `[]`, so the tiles read Runs 0 · Active 0 · Spent $0.00 · Saved ~$0.00.
- failure: For the duration of the first `batch.runs()` read the page asserts an empty workspace above a table that says it is still reading — two different claims on one screen, and on a slow disk the zeros are what the operator sees first.
- fix: Render the tiles through `Reading` (or with `—` values) until `loading` is false, as the shared primitive was written for.

## 17. [honesty/medium/small] Delete copy says results are removed from this machine; the archive stays on disk
- where: src/renderer/src/views/Batches.tsx:1317
- evidence: ConfirmNote: "The results are removed from this machine and cannot be downloaded again." deleteRun (batch/index.ts:280-287) runs only `DELETE FROM runs WHERE id = ?`; cascades cover `requests`/`batches`/`events`, but results.ts writes `results/<batchId>.jsonl` in resultsDir() and `grep -rn unlinkSync|rmSync|resultsDir() src/main` finds no deletion outside results.ts. "cannot be downloaded again" is also untrue inside the 29-day API window.
- failure: The operator is told the evidence is gone; the full raw result archive (prompts and outputs) remains in user-data with nothing listing it, and the sentence overstates both what was removed and what the API still holds.
- fix: Either unlink each batch's archive in deleteRun (after collecting batch ids) or rewrite the sentence to say the run's rows are removed from the database and the archive files remain at <path>.

## 18. [unfinished/medium/medium] cachediag.diagnose() and hitRateAcrossRuns() have no IPC; the preflight panel re-implements the undercount diagnose() fixes
- where: src/main/batch/cachediag.ts:104
- evidence: `export async function diagnose(cfg, prefixTokens, requests)` (104) with the comment "estimate() measures only the flagged blocks … that number is discarded and re-measured here rather than believed" (131-132), plus VOLATILE_PATTERNS detection; `export function hitRateAcrossRuns` (285). `grep -rn "diagnose(\|hitRateAcrossRuns" src` finds no caller outside src/main/batch/; preload `cache` has hitRate/minimum/ttl only (index.ts:536-540). CachePreflight (Batches.tsx:1747-1800) computes `underFloor = cachedBlock && minimum !== null && prefixTokens > 0 && prefixTokens < minimum` from the estimate's flagged-blocks count and says "so an entry will be written" (1779).
- failure: A config with an 8,000-token uncached context block ahead of a 300-token cached instruction reads "The prefix is under the floor" in the builder — the false alarm cachediag.ts says it exists to end — and the timestamp/UUID invalidator scan never reaches the operator; the cross-run hit-rate history has no surface either.
- fix: Add `cache:diagnose` (and optionally `cache:history`) IPC + preload, call diagnose() from CachePreflight and render its `reasons` list in place of the three renderer-side Notes.

## 19. [missing/medium/small] A rescue or retry child has no link back to its parent run
- where: src/renderer/src/views/Batches.tsx:1287
- evidence: RunDetail's head renders `{run.id} · {run.model}` and never reads `run.parent_run_id`, which runDetail() returns on the row (RunRow has `parent_run_id`); the list only appends `' · retry'` (332) with no target. The refusal lane's Merge button lives on the parent's Refusals tab (2113-2140), reachable only from the parent.
- failure: Open a rescue child from the list (or land on it via `onOpen(r.runId)` after clicking Rescue) and there is no way to get to the parent to merge the answers back except scanning the list for a name that matches.
- fix: When `run.parent_run_id` is set, render an info Note "Rescue of <parent name>" / "Retry of …" with an `onOpen` button, using the rescue marker from refusal.children to pick the noun.

## 20. [missing/medium/small] Batches tab hides whether an ended batch's results were ever downloaded
- where: src/renderer/src/views/Batches.tsx:1444
- evidence: Columns are `Batch · Status · Requests · Counts · Expires · Polled`. The row from `SELECT * FROM batches` (batch/index.ts runDetail) also carries `results_ingested_at`, `ended_at` and `results_url`; poll.ts keeps polling an ended batch until `results_ingested_at` is set, and notify.resultsExpiring() keys the 29-day warning on the archive existing.
- failure: An ended batch whose download keeps failing looks identical to one whose results are safely on disk; the operator sees "ended" with a counts string and cannot tell which of the two the expiring-results warning is about.
- fix: Add an "Ingested" column (`ago(b.results_ingested_at)` or "not yet", with the -1 in-flight sentinel shown as "downloading…").

## 21. [polish/medium/medium] Page heads are hand-rolled instead of PageHead; empty states hand-rolled instead of EmptyState
- where: src/renderer/src/views/Batches.tsx:226
- evidence: `<div className="pane-head"><div><h1>Batches</h1><p className="dim">…</p></div><button className="btn btn-primary" …>` (226-233); the builder and detail heads (650, 684, 1214, 1287) each repeat a `<button className="faint" style={{ fontSize: 'var(--t-small)' }}>← Batches</button>` with an inline-styled h1; seven empty/error states use `.bx-state` `<h4>/<p>` (e.g. 1652, 1997, 2313) while bits.tsx exports `PageHead`, `EmptyState` (with `could-not-read`/`nothing-yet` postures) and `Reading`. CLAUDE.md lists exactly these primitives.
- failure: The back affordance, title scale and empty-state posture differ from the other views (and from each other across the three Batches screens); the style gate's 206-inline-style baseline for this file is largely these.
- fix: Route the three heads through `PageHead` (with a `compact` builder head and an `actions` slot), and the `.bx-state` blocks through `EmptyState` with the matching posture.

## 22. [polish/medium/medium] Forty-four Notes and long hero prose where a Hint or tooltip would do
- where: src/renderer/src/views/Batches.tsx:1846
- evidence: `grep -c "<Note"` = 44, `<Hint|<Explainer` = 0. CacheObserved's `.hero-sub` carries a 60-word paragraph (1846-1852: "Observed, not promised: hits inside a batch are best-effort — … The same config can read 90% one week and 40% the next."), CachePreflight ends on a 35-word paragraph (1796-1798), UploadToggle's Note is 80 words (1575-1582), and the Dry-run explanation (929-931) sits permanently under two buttons.
- failure: Every diagnostic reads as a warning banner and the teaching prose competes with the numbers; the Hint/Explainer primitives (remembered disclosure, 64ch measure) exist for exactly this and are unused here.
- fix: Move the best-effort sentence into one `Hint` under the hero, convert the UploadToggle and dry-run paragraphs to `Explainer`s with ids, and reserve `Note` for failures and results.

## 23. [modernize/medium/medium] Status-pill badges used as filter and selection controls
- where: src/renderer/src/index.css:338
- evidence: `.pill { … padding: 1px 7px; … font-size: var(--t-micro); font-weight: 600; }` — a 1px-padded badge — is the element behind the source picker (Batches.tsx:725), effort levels (860), results filter (1383), pair chooser (2355) and eval filter (2476), each selected by an inline `{ background: 'var(--accent)', color: 'var(--bg)' }` swap.
- failure: Sub-20px tap targets in a status-badge shape read as read-only chips, not controls, and the coral fill for "selected" is the same colour as the primary CTA beside them; Linear/Raycast use a segmented control at control height with a neutral raised fill for the selected segment.
- fix: Replace every pill-as-button with the `Segmented` primitive (ui.css `.seg button[aria-pressed='true'] { background: var(--bg-selected) }`), at `--control-h-sm`.

## 24. [modernize/medium/medium] One coral accent does CTA, live count, cost tile, selection and focus
- where: src/renderer/src/views/Batches.tsx:291
- evidence: `Stat label="Active" … tone={active.length ? 'var(--accent)' : undefined}` (291), `Stat label="Est. cost" … tone="var(--accent)"` (943), selected pills `background: 'var(--accent)'` (725, 860, 1383…), preset cards `borderColor: 'var(--accent)', background: 'var(--accent-soft)'` (695-697), `.bx-f:focus-visible { outline: 2px solid var(--accent) }` (batches.css), plus the `btn-primary` New run/Submit/Rescue/Pair buttons.
- failure: On the builder the eye cannot rank the selected recipe, the selected source arm, the estimate tile and the Submit button — all coral; a modern surface keeps the accent for the single next action and expresses selection and emphasis in neutral weight and fill.
- fix: Selection through `--bg-selected`/border weight (Segmented/Chip), tiles in default text colour with a Mark for state, focus ring in a dedicated `--focus` token; leave accent on Submit/New run only.

## 25. [bug/low/small] "Retry N failed" counts one set and retries another
- where: src/renderer/src/views/Batches.tsx:1299
- evidence: `{!live && failed > 0 && <button …>{… `Retry ${num(failed)} failed`}` where `failed = errored + expired + canceled` (1235). submit.ts retryFailed selects `status IN ('errored','expired','canceled','pending')` and throws "No failed, expired or unsent requests" otherwise.
- failure: A run abandoned with 40 pending rows and 0 failed shows no Retry button at all; a run with 3 failed and 40 pending shows "Retry 3 failed" and resubmits 43 rows.
- fix: Count `failed + pending` for a non-live run and label it "Retry N unanswered".

## 26. [bug/low/small] Soonest batch expiry sorted as strings
- where: src/renderer/src/views/Batches.tsx:1243
- evidence: `const soonest = d.batches.filter(…).map((b: any) => b.expires_at).filter(Boolean).sort()[0];` — `Array.prototype.sort()` without a comparator sorts numbers lexicographically.
- failure: Correct today only because every epoch-ms value has 13 digits; the intent is numeric and the code says otherwise.
- fix: `.sort((a, b) => a - b)[0]` or `Math.min(...)`.

## 27. [bug/low/small] Clearing the schema textarea collapses the disclosure mid-edit
- where: src/renderer/src/views/Batches.tsx:897
- evidence: `<details style={{ marginTop: 13 }} open={!!cfg.schemaJson}>` with the textarea inside it; React re-applies `open` whenever the prop value changes between renders.
- failure: Select-all + delete in the schema box flips `open` from true to false, the details collapses and the textarea (with focus) disappears under the summary.
- fix: Make `open` uncontrolled (`defaultOpen`-style via a ref or local state initialised from `!!cfg.schemaJson`).

## 28. [bug/low/small] Effort control hidden while an effort is still sent
- where: src/renderer/src/views/Batches.tsx:854
- evidence: `{model && model.efforts.length > 0 && ( … effort pills … )}`; models.ts fallbackCatalog() returns `efforts: []` for the local table, while presets.ts sets `effort: 'medium'` / `'high'` and build.ts always writes `output_config.effort = cfg.effort`.
- failure: Without a fetched catalog the "largest cost lever" is invisible and unchangeable, yet the preset's effort ships in every request.
- fix: When `efforts` is empty but `cfg.effort` is set, show a read-only line "Effort: medium (from recipe; catalog not read)" with a clear button.

## 29. [bug/low/small] Changing project silently replaces an edited source with the preset's
- where: src/renderer/src/views/Batches.tsx:538
- evidence: `changeProject`: `setCfg((c) => (c ? { ...c, projectId: id, ...(p ? { source: p.config.source } : {}) } : c))` where `p` is the preset matching `cfg.preset`.
- failure: An operator who tuned the glob pattern or wrote a drush command, then picked a different project, gets the recipe's default source back with no notice.
- fix: Only rewrite `root`/`cwd` from the new project path, or ask with a ConfirmNote before replacing an edited source.

## 30. [bug/low/small] Sticky pre-flight aside can outgrow the viewport with Submit at its bottom
- where: src/renderer/src/index.css:711
- evidence: `.builder-side { position: sticky; top: 0; }` with no max-height or overflow; the aside (Batches.tsx:915-1000) stacks two buttons, a paragraph, error/warn Notes, a 2-tile stat grid, a KV block, the whole CachePreflight lane (three Notes plus two paragraphs), a 170px dry-run `<pre>`, and the Submit button last.
- failure: When the aside is taller than the window it sticks at its top edge, so the Submit button is only visible once the main column has been scrolled to its end; on a short main column it never scrolls into view at all.
- fix: Give `.builder-side` `max-height: 100vh; overflow-y: auto` (or align-self: start with `top` set to the head height) and move the Submit row above the diagnostics.

## 31. [bug/low/small] stat-grid-5 uses 1fr tracks the sibling rule was fixed to avoid
- where: src/renderer/src/index.css:726
- evidence: `.stat-grid-5 { display: grid; grid-template-columns: repeat(5, 1fr); …}` directly under `.stat-grid { … repeat(4, minmax(0, 1fr)) }` whose comment says "minmax(0, 1fr), not 1fr: a track's automatic minimum is its own content". Batches.tsx:1338 overrides to `repeat(6, minmax(0, 1fr))` inline only when `refused`.
- failure: With five tiles the sub lines "priced from returned token counts" and "declined — rescue on another model" set a content minimum that can push the grid past the page measure between the wide and compact breakpoints.
- fix: `repeat(5, minmax(0, 1fr))`, and move the six-column variant into the sheet as a modifier.

## 32. [honesty/low/small] "Runs" tile silently caps at the 200-row read
- where: src/renderer/src/views/Batches.tsx:290
- evidence: `<Stat label="Runs" value={num(runs.length)} />` and `spent = runs.reduce(...)` (218) over `batch.runs()`, which is `LIMIT 200` (batch/index.ts:157). The cap is only mentioned in the footer that appears after "Draw all" ("Main returns at most 200; anything older is not read.").
- failure: With 260 runs the tile reads "Runs 200" and "Spent" omits sixty runs' cost with nothing on the default screen saying so.
- fix: Have listRuns return `{rows, total}` (a COUNT(*) is cheap) and label the tile "200 of 260 read" or sum spend in SQL.

## 33. [unfinished/low/small] Source picker offers a single arm once a session has seeded files
- where: src/renderer/src/views/Batches.tsx:724
- evidence: `(cfg.source.kind === 'files' ? (['files'] as const) : (['csv', 'jsonl', 'glob', 'command', 'golden'] as const)).map(…)` — with a files source the picker renders one pressed pill and no other choice; the only way out is `applyPreset`, which is not labelled as such.
- failure: After a hand-over the operator cannot switch to a golden set or a CSV without first clicking a recipe and losing the name and prompts they typed.
- fix: Render the full arm list with 'files' added when present; switching arms already discards the source deliberately (selectSource).

## 34. [missing/low/small] Events tab shows the newest 100 with time-only stamps and no truncation notice
- where: src/renderer/src/views/Batches.tsx:1470
- evidence: `{new Date(e.at).toLocaleTimeString()}` per row; runDetail() selects `… ORDER BY at DESC LIMIT 100` (batch/index.ts:243). A retry or an expired batch logs tens of warn/error lines per poll (poll.ts) so 100 is reached on a two-day run.
- failure: A run that spanned two days shows "14:02:11" twice with no date between them, and the 101st-and-older events (including the original submission lines) are silently absent.
- fix: Show a date when the day changes, print "newest 100 of N" from a COUNT, and add a level glyph via `Mark`.

## 35. [missing/low/small] Run detail never names the project
- where: src/main/batch/index.ts:229
- evidence: runDetail() returns `run` (with `project_id`) but no project name; the list row computes `project_name` via subquery (158). RunDetail renders `{run.id} · {run.model}` only (Batches.tsx:1293).
- failure: Two runs named "Review 4 changed files" on different repos are indistinguishable once opened.
- fix: Join the project name in runDetail (or resolve `project_id` against the `projects` prop) and print it under the title.

## 36. [polish/low/small] until() formats a 29-day deadline as hours
- where: src/renderer/src/views/Batches.tsx:281
- evidence: `{until(row.downloadableUntil).text}` for the results-expiry Note; bits.tsx:569 `until()` returns `${h}h ${m}m` and flags urgent under two hours — written for the 24-hour clock.
- failure: "downloadable until 9/13/2026 (144h 0m)" beside a date is noise; the warning window is seven days, so every row reads as a three-digit hour count.
- fix: Add a day-granularity branch to until() (or use `dur()`), and let urgency mean under one day here.

## 37. [polish/low/small] Duration rendered as raw minutes
- where: src/renderer/src/views/Batches.tsx:1352
- evidence: `${Math.max(1, Math.round((run.ended_at - run.submitted_at) / 60000))}m` while bits.tsx:538 exports `dur(ms)` ("3m 05s", "2h 14m").
- failure: An overnight batch reads "1,380m"; the shared formatter would say "23h 00m".
- fix: Import and use `dur(run.ended_at - run.submitted_at)`.

## 38. [polish/low/small] Detail poll effect tears down and rebuilds on every read
- where: src/renderer/src/views/Batches.tsx:1200
- evidence: `useEffect(() => { if (!d) return; … const t = setInterval(beat, 8000); document.addEventListener('visibilitychange', beat); return () => {…}; }, [d, loadDetail, loadRows]);` — each `beat` calls `loadDetail`, which `setD` with a new object, so the effect re-runs and the interval restarts from zero.
- failure: The cadence is 8s-plus-read-time rather than 8s, and the listener is re-registered every beat; harmless but the wrong shape for a timer.
- fix: Depend on `d?.run.status` (or a `live` boolean) instead of `d`.

## 39. [polish/low/small] List polls 200 rows plus a per-batch fs.stat every 8 seconds with nothing in flight
- where: src/renderer/src/views/Batches.tsx:211
- evidence: `const t = setInterval(() => { if (!document.hidden) void load(); }, 8000);` where `load()` calls `batch.runs()` (five correlated subqueries per row, batch/index.ts:148-158) and `notify.resultsExpiring()` (an `fs.statSync` per candidate batch, notify.ts:594-600); `batchChanged` is also subscribed.
- failure: An idle workspace with 200 finished runs re-runs ~1,000 subqueries every eight seconds while the tab is visible.
- fix: Poll only while `active.length > 0` and rely on `on.batchChanged` otherwise.

## 40. [polish/low/small] Results tab count tracks the current filter, not the run
- where: src/renderer/src/views/Batches.tsx:1373
- evidence: `{t === 'results' && total ? ` (${num(total)})` : ''}` where `total` is the filtered/searched count from runResults.
- failure: Type in the search box and the tab strip re-labels itself "Results (3)", reading as if the run had three results.
- fix: Use `run.total_requests` in the tab label and show the filtered count beside the pager only.

## 41. [polish/low/small] Pager hard-codes 50 and ignores the page size main returns
- where: src/renderer/src/views/Batches.tsx:1426
- evidence: `{num(offset + 1)}–{num(Math.min(offset + 50, total))} of {num(total)}` and `setOffset(offset + 50)`; runResults returns `{ rows, total, offset, pageSize }`.
- failure: A change to the main-process page size desynchronises the pager silently.
- fix: Keep `pageSize` from the response in state and use it.

## 42. [polish/low/small] Detail tab is not remembered while the page is
- where: src/renderer/src/views/Batches.tsx:1158
- evidence: `const [tab, setTab] = useState<DetailTab>('results');` beside `useViewMemory<Page>('page', …)` in the parent, which restores `{ page: 'detail', id }` after a tab swap.
- failure: Leave a run on its Evals tab to check a session and come back: the run is restored but lands on Results.
- fix: `useViewMemory<DetailTab>(`tab:${id}`, 'results')`.

## 43. [polish/low/small] Two primary CTAs on the empty list
- where: src/renderer/src/views/Batches.tsx:314
- evidence: `<button className="btn btn-primary" onClick={onNew}>New run</button>` in the head (231) and `<button className="btn btn-primary" … onClick={onNew}>Build your first batch</button>` inside the empty table cell (314); both visible in the screenshots.
- failure: Two coral buttons doing the same thing on one screen; the empty state should carry the call and the head a secondary.
- fix: Use `EmptyState` with the primary action and demote the head button while `!runs.length`.

## 44. [polish/low/small] bytesLabel duplicates the shared size() formatter
- where: src/renderer/src/views/Batches.tsx:64
- evidence: `function bytesLabel(n: number): string { if (n < 1024) return …B; … KB; … MB; … GB }` while bits.tsx exports `size(bytes)` with the same job and a `—` guard for non-finite input.
- failure: Two spellings of the same number ("412.0 KB" here, "412 KB" elsewhere) and one guard missing.
- fix: Import `size` from bits and delete `bytesLabel`.

## 45. [polish/low/small] Renderer restates the estimate's 25% assumption
- where: src/renderer/src/views/Batches.tsx:957
- evidence: `~${num(Math.round(est.worstCaseOutputTokens * 0.25 / est.requests))} tok/row est.` while estimate.ts owns `LOW_OUTPUT_FRACTION = 0.25` "so the number in the arithmetic and the number in the note it is declared by cannot drift apart".
- failure: Changing the fraction in main leaves the pre-flight card printing a different per-row figure from the note beneath it.
- fix: Return `assumedOutputPerRow` from estimate() and print that.

## 46. [polish/low/small] evals.css is the Skills sheet under an evals name
- where: src/renderer/src/styles/evals.css:1
- evidence: Header comment: "skills — owned by the skills phase (22)"; every selector is `.skills-*`/`.skill-*`; it is `@import`ed globally by index.css:13 and Batches.tsx imports only batches.css. The gate lists it under both `'evals.css': 19, 'skills.css': 19` "so the rename lands without a false failure", and it still carries 19 literal px font sizes (e.g. `font-size: 12.5px`, `10.5px`, `11.5px`, `13.5px`).
- failure: The Evals tab has no sheet, the file named for it styles a different view, and the next engineer looking for Batches' A/B rules opens the wrong file.
- fix: Rename to skills.css, update the @import and drop the duplicate gate key; tokenise the 19 literals in the same pass.

## 47. [modernize/low/medium] Run-detail action row is five equal-weight buttons
- where: src/renderer/src/views/Batches.tsx:1295
- evidence: `<div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>` holding Cancel run (btn-danger), Retry N failed, Export JSONL, Export CSV and Delete run… as siblings under a display-size h1 with `{run.id} · {run.model}` in mono micro beneath.
- failure: Two export buttons and a delete at equal visual weight beside a live cancel; Linear/Devin put one primary contextual action inline and the rest behind an overflow or a single Export menu, with the identifier row as a compact meta strip.
- fix: One `Export ▾` control (JSONL/CSV), Retry/Cancel as the contextual primary, Delete in an overflow menu; use `PageHead compact` with a `Mark` for status and a meta line of project · model · id.

## 48. [modernize/low/small] Preset cards signal selection by colour only, with no pressed semantics
- where: src/renderer/src/views/Batches.tsx:695
- evidence: `<button … className="sunk preset" style={cfg.preset === p.id || (!cfg.preset && p.id === 'blank') ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}>` — no `aria-pressed`, no glyph, three flat cards in `.preset-grid`.
- failure: Keyboard and screen-reader users get no selected state; sighted users get a coral tint that is also the hover of the primary button. Conductor/Cursor show a check mark or radio and keep the surface neutral.
- fix: Render the recipe grid as radio-role cards (`aria-pressed` or `role="radio"`), selected border in `--text-faint` with a leading ✓ glyph via `Mark`.

## 49. [modernize/low/medium] Run list rows lack a status glyph and a scannable hierarchy
- where: src/renderer/src/views/Batches.tsx:324
- evidence: Each row is a name button, a mono micro subline `{r.model}{project}{' · retry'}`, a `Pill status`, a 5px `Bar` with a three-token legend, mono cost with a tilde, and `ago()`; seven columns at `--t-small`.
- failure: Status is a coloured word only (Pill), progress is a hairline that needs a legend, and the row has no leading glyph, so scanning a long list for the failed run means reading every status cell; Linear and T3 lead the row with a status glyph and put counts in tabular columns.
- fix: Lead with `Mark` (glyph + word), collapse the legend into the bar's title and a right-aligned `ok / failed / pending` tabular triple, drop the mono micro subline to a dim sans meta line.

