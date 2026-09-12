# store.ts — 1 findings

## src/main/store.ts:105 — [medium] orphaned-data  (PLAUSIBLE, sustained 2/3)

**Claim.** Removing a project deletes only the projects row, so every learning signal, candidate and knowledge item scoped to it survives with a dangling `project_id`, while the confirmation panel asks to remove "everything recorded against it" and its "What survives" column enumerates only sessions.

**Evidence.**

```
src/main/store.ts:105-107 `export function removeProject(id: string) { db().prepare('DELETE FROM projects WHERE id = ?').run(id); }`, reached by index.ts:1934 `handle('projects:remove', (id: string) => { removeProject(id); return listProjects(); });` — nothing else. `foreign_keys` is ON (db.ts:63) but db.ts:736 declares `project_id TEXT` on `knowledge_items` with no REFERENCES, and the same holds for `knowledge_candidates` and `learning_signals`. The copy: Settings.tsx:1554 `title={`Remove “${project.name}” and everything recorded against it?`}` and :1558-1559 "The repository on disk is untouched — only Wanigan's record of the work goes", over a table (Settings.tsx:1571-1601) whose "What survives" column lists Goals, nodes, proofs, checkpoints/claims and sessions, and nothing learned. `readRemovalCost` (Settings.tsx:1511-1535) queries only `control.list` and `sessions.past`.
```

**Failure.** Remove a project that has learning history. Learning → scope "Everything" → Knowledge still lists its items and Overview's "Approved · active items · now" station still counts them, with no project left to reach them under project scope. Its pending proposals stay in the Inbox demanding a decision; pressing Apply on one fails with "The candidate project is no longer available." (learning-service.ts:1529) — for a proposal the removal dialog said had been removed.

**Fix.** Either cascade in `removeProject` (delete or tombstone `learning_signals`, `knowledge_candidates` and project-scoped `knowledge_items` for that id) or, if surviving the project is the intended behaviour, count them in `readRemovalCost` and add the row: "Learned items and proposals filed under it — N — the rows stay and lose the project they pointed at; applying one afterwards is refused."

**Dissent (the verifier who refuted).** The mechanical facts reproduce, but every limb of the claimed failure fails on inspection, and the surviving data is this repository's stated contract rather than a leak.

VERIFIED AS STATED: /Users/dane/Projects/drupal/wanigan/src/main/store.ts:105-107 is a bare `DELETE FROM projects WHERE id = ?`; its only non-smoke caller is /Users/dane/Projects/drupal/wanigan/src/main/index.ts:1934 `handle('projects:remove', (id: string) => { removeProject(id); return listProjects(); });`; there is no removal hook anywhere (no `projectRemoved`/`project-removed` symbol in src/); `foreign_keys = ON` at db.ts:63; and learning_signals (db.ts:697), knowledge_items (db.ts:736) and knowledge_candidates (db.ts:775) all declare `project_id TEXT` with no REFERENCES. So the rows do survive with an unresolvable project_id, and `listKnowledgeItems` with no projectId key returns them (/Users/dane/Projects/drupal/wanigan/src/main/learning/repository.ts:466 `if (filter.projectId !== undefined)`), which the Everything scope does (Learning.tsx:61-62 `sel === 'all' ? undefined : ...`).

WHY IT IS NOT A DEFECT — the survival is designed and documented:
1. db.ts:682-685, directly above the learning schema: "Keeping this migration additive is important: uninstalling a provider pack must never erase the knowledge or evidence produced while it was installed." AGENTS.md makes knowledge_items/knowledge_versions "the canonical, provider-neutral source of truth" and the database "the source of truth. Make migrations additive." A cascade from a projects row into canonical knowledge is the thing that doctrine forbids.
2. /Users/dane/Projects/drupal/wanigan/src/main/learning-service.ts:1617-1619 designs for this exact state by name: "Reversal must survive the provider profile or project registration going away."
3. /Users/dane/Projects/drupal/wanigan/src/main/learning/repository.ts:657 carries the recorded fallback for a project row that can no longer answer: `const candidateRoot = projectRootPath(candidate.projectId);` then `fileEvidenceForSignal(signal.detail_json, candidateRoot ?? signal.project_path)`. `projectRootPath` returning null is an anticipated input, not an accident.
4. Settings.tsx:1102 already prints, for a removed pack, "sessions, history and knowledge were kept" — the app states this lifecycle out loud.

WHY THE CLAIMED OUTCOMES DO NOT FOLLOW:
- "pressing Apply on one fails" does not happen on the pending Inbox rows described. The Apply button renders only for approved/promoted candidates (Learning.tsx:1725 `['approved', 'promoted'].includes(candidate.status) && <button ... Apply to`), so a pending proposal has no Apply control at all.
- When it does throw, the throw is the correct answer, not a bug: there is no filesystem root to write into. And it is not specific to removal — `projectById` resolves through `listProjects()`, which filters `fs.existsSync(r.path)` (store.ts:30, commented "A directory that is not there right now is not the same thing as a project the user removed"), so learning-service.ts:1529 already fires for a project sitting on an unmounted disk. The wording "no longer available" is written for both.
- No count is wrong. Orphan items genuinely are active items, so the "Approved / active items · now" station (Learning.tsx:621) is accurate under Everything; under project scope they are excluded by `project_id IS ?` (repository.ts:466) and cannot reach another project's briefing (repository.ts:832 `(i.scope='personal' OR i.project_id IS ?)`), so there is no leak either. Nothing renders a stale project name: Learning labels items by kind/scope/pathScope (Learning.tsx:2161, 2375), never by a per-item project lookup.
- The copy contradiction rests on the heading alone, and the body under it is precise: "Wanigan deletes the project row, and the database cascades from there through its Goals into every node, claim, checkpoint, proof, trace event, resume receipt and model outcome underneath" (Settings.tsx:1554-1560). The panel's own doc comment scopes it to "What a removal actually takes with it, counted from the record" (Settings.tsx:1484), and "What survives" is a per-row note — every row has one, and only the sessions row has a survivor — not the global inventory the finding reads it as.

Net: no wrong output, wrong render, wrong money or crash. What remains is an argument that the heading could be narrower, which is a copy opinion and below the bar.

---
