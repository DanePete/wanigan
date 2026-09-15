# Helper sweep · P10 · agents explain their own diff

Before and after, both themes, from `scripts/probe-helper-p10-notes.mjs`: the
actual renderer in an isolated Electron window at a 1600 × 1400 viewport, with
synthetic sessions, review and change-note services and no real agent calls.
The main-process half — `wanigan_annotate_change`, `wanigan_list_change_notes`
and `wanigan_withdraw_change_note` over loopback with real per-launch tokens,
hunk containment against a real repository's diff, redaction, the 60-note
limit, per-profile grants, staleness, and a trace of every SQL statement the
agent's calls prepare (none names a review-mark table) — runs in
`src/main/smoke39.ts`.

`before/` was shot from a build of `e77cf97` (the base of this branch) in a
scratch worktree; `after/` from this branch. Each folder's `verification.json`
lists the assertions that ran, the commit the renderer was built from, and each
screenshot with the body background it was taken on. A `-detail` file is the
code rail at full resolution, because the rail is a few hundred pixels wide in a
whole window.

| View | Before | After |
| --- | --- | --- |
| Code rail | `code-rail` — the verdict, the file list and the diff, with nothing the agent wrote about its change | `inline-note` — under the verdict, "3 notes written by the agent · 1 where the code changed since · 1 withdrawn by the agent" and Walk the agent's notes; in the diff, the note under the two lines it covers (dashed box, ✦ "written by the agent", the session title, "new lines 2–3"), those two lines carrying the agent's rule, Make it my review note and Dismiss note |
| A stale note | — | `stale-note` — the list of all notes in file order open; the test file's note with △ "the code changed since this note" and the reason in words |
| The walk | — | `walk-1`, `walk-3` — "Note 1 of 3" and "Note 3 of 3" with the path, location, the note and its mark, Previous / Next / End walk and the keys; the diff below opened at that note, outlined |
| Quoted | — | `quoted` — the operator's review tray holding "Quoted from the agent's own note on this change (Make checkout retries safe): > …", the confirmation that it reaches the session only when added to a message, and the note marked "quoted into your review notes"; its lines carry both the operator's and the agent's rule |
| Dismissed | — | `dismissed` — "2 notes written by the agent · 1 dismissed", the note gone from the diff, and the list keeping it marked dismissed |

Run it again with `npm run build && node scripts/probe-helper-p10-notes.mjs`
(add `--before --out <dir>` from a checkout of the base).
