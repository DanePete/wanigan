# checkpoints.ts — 1 findings

## src/main/checkpoints.ts:521 — [low] correctness  (CONFIRMED, sustained 3/3)

**Claim.** `removeRepoCheckpoints` reports the number of refs it found, not the number it deleted: every `update-ref -d` result is discarded and every row-delete failure is swallowed, yet both are returned as removals.

**Evidence.**

```
src/main/checkpoints.ts:515-521 — `for (const ref of refs) { await runGit(root, ['update-ref', '-d', ref], { timeout: 8_000 }); }` (return value never inspected) and `for (const id of uniqueIds) { try { db().prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(id); } catch { /* next prune retries */ } }`, then `return { refs: refs.length, rows: uniqueIds.length, applied: true };`. runGit never throws — it returns `{ ok: false, … }` (src/main/git.ts:135-140). The renderer turns that into a claim: src/renderer/src/views/Settings.tsx:1759 `Removed ${done.refs} snapshot ref${…} from “${p.name}”.`
```

**Failure.** With the repository's ref store locked by a concurrent git process, or `.git` read-only, or a timeout at 8s on a large ref list, every `update-ref -d` fails and every checkpoint ref survives — while Settings reports "Removed 12 snapshot refs from “app”" and the panel closes. The operator believes the reclaim happened; a re-scan still lists the same refs.

**Fix.** Count successes: increment only when `runGit(...).ok` is true (and when the DELETE does not throw), and return the deleted counts, reporting any remainder as not removed.

---
