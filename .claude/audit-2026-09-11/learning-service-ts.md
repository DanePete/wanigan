# learning-service.ts — 1 findings

## src/main/learning-service.ts:1173 — [low] correctness  (CONFIRMED, sustained 3/3)

**Claim.** `unactionableCount()` counts only within one page of pending candidates, but the Inbox prints the result as a definite total of unactionable nominations.

**Evidence.**

```
src/main/learning-service.ts:1173-1174 `return candidates({ projectId, status: 'pending' }).filter(…)` — no limit is passed, so `listCandidates` applies its default page: src/main/learning/repository.ts:186 `args.push(Math.max(1, Math.min(500, filter.limit ?? 100)));` with `ORDER BY updated_at DESC LIMIT ?`. The renderer states the number as fact: src/renderer/src/views/Learning.tsx:1495 `{unactionable} unauthored nomination{pl(unactionable)} across all scopes record a repeated success…`. The codebase models this distinction elsewhere — src/main/mobile/learning.ts:385-387 returns `{ rows, floor: rows.length >= READ_LIMIT }` and the wire carries `waitingIsFloor`.
```

**Failure.** On a database with, say, 300 pending candidates of which 250 are unauthored nominations, only the 100 most recently updated pending rows are examined, so the Inbox prints at most "100 unauthored nominations across all scopes" and the sweep clears at most those; 150+ rows the sentence implicitly denies exist stay in the inbox, and the count re-renders at the cap after the sweep.

**Fix.** Either pass an explicit high limit and report a floor (as mobile/learning.ts does) or count with a dedicated SQL COUNT over all pending nominations, so the sentence states a total or admits it is a floor.

---
