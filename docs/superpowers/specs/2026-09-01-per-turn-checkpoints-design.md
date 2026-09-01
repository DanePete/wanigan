# Per-turn checkpoints — design

Date: 2026-09-01
Status: approved (sections 1–7 reviewed in chat)
Scope: Tier 1, item 1 of the t3code-comparison roadmap

## Problem

Wanigan records one git baseline per session (`captureBaseline` in
`src/main/sessions.ts`): a HEAD hash plus a list of already-dirty paths. That
supports "diff/revert the whole session against launch," but cannot answer
"what did turn 3 change?" or "restore to just before my last prompt." Worse,
pre-session dirty work is not snapshotted at all — reverting a file the user
had already modified discards their work, and the plan text says so.

t3code brackets every turn with workspace checkpoints stored as hidden git
refs, giving exact per-turn diffs and message-level revert. That mechanism is
more aligned with Wanigan's "recorded evidence is the source of truth" premise
than our single baseline.

## Decisions (approved in chat)

- Hidden refs in the user's repo are acceptable; repos must otherwise stay
  untouched (no HEAD/index/worktree writes, no config or hook pollution).
- V1 ships backend + a minimal Turns UI in the code panel.
- Capture is on by default for hook-capable sessions in git repos, with a
  visible global setting to disable.
- Boundary source is the hook bus (approach A). Providers without verified
  hook support get an honest "unsupported" state — never simulation. A
  transcript-driven feeder may later reuse the same capture queue if timing
  proves sound.

## Capture mechanics

New module `src/main/checkpoints.ts`. All git through `runGit` (credential
hardening, timeouts); repo root passes `assertManagedRoot`; root resolves from
the session's own cwd, so worktree sessions checkpoint their worktree.

Per capture, with `GIT_INDEX_FILE` pointing at a per-session temp index kept
in Wanigan's user-data dir (reused across turns so git's stat cache makes
captures incremental):

1. `git add -A .` — respects `.gitignore`; captures untracked agent files.
2. `git write-tree` → tree hash. If equal to the previous checkpoint's tree,
   record `skipped-unchanged` and stop.
3. `git commit-tree <tree> -p <prev>` with a fixed Wanigan author identity.
4. `git update-ref refs/wanigan/checkpoints/<sessionId>` — one ref per
   session; the commit chain keeps every turn reachable.

Budget 30s per capture, bounded buffers. Failures record a `failed` row with
reason; two consecutive timeouts auto-disable capture for the session with a
visible note. Submodules are recorded as gitlink pointers, not recursed.
Detached HEAD is fine. HEAD, the real index, branches, and the working tree
are never written during capture.

## Turn model

`checkpoints.ts` subscribes to the hook bus; captures run on a per-session
serial queue off the hook request path (the 2s hook response budget is
untouched).

| Hook event         | Kind            | Notes                                    |
| ------------------ | --------------- | ---------------------------------------- |
| SessionStart       | `session-start` | Turn 0; makes pre-session dirty work restorable |
| UserPromptSubmit   | `turn-start`    | Turn N; stores 160-char prompt excerpt   |
| Stop               | `turn-end`      | Turn N; turn diff = start N → end N      |
| exit / SessionEnd  | `session-end`   | Final state even on crash/kill           |

Rows are facts; the UI derives pairs. An unpaired `turn-start` diffs to the
next boundary. Gates at SessionStart: harness hooks capability, git repo
present, setting enabled.

## Schema (additive, `migratePhases`)

```sql
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  kind          TEXT NOT NULL,      -- session-start | turn-start | turn-end | session-end | pre-revert
  at            INTEGER NOT NULL,
  repo_root     TEXT NOT NULL,
  commit_hash   TEXT,               -- null when capture failed
  tree_hash     TEXT,
  prompt        TEXT,
  files_changed INTEGER,
  status        TEXT NOT NULL DEFAULT 'ok',  -- ok | failed | skipped-unchanged
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_checkpoints
  ON session_checkpoints(session_id, turn, at);
```

Loose coupling to `session_log` (no FK), matching `session_events`. The turn
counter lives in memory per live session and recovers from `MAX(turn)`.

## Retention & repo hygiene

- Session delete also deletes the session's ref and rows.
- The existing event-retention setting extends to checkpoints; when the repo
  is gone, rows drop and the ref is abandoned.
- Settings → Projects & safety gains "Remove Wanigan checkpoints from this
  repo": counts refs, plan-then-apply, `update-ref -d` + row purge.
- Wanigan never runs `git gc`; unreachable objects age out normally.
  `refs/wanigan/*` appearing in `git log --all` is an accepted trade-off.

## IPC + Turns UI

Channels, main-side validated (sender + id checks, `sessions:*` pattern):

- `checkpoints:list(sessionId)` → rows
- `checkpoints:diff(sessionId, fromId, toId)` → name-status list + capped
  patch + `truncated` flag
- `checkpoints:revertPlan(sessionId, checkpointId)` → per-file plan
- `checkpoints:revert(sessionId, checkpointId)` → per-file results

Typed preload wrappers. `CodePanel` gains a **Turns** tab: turn number, kind
glyph, prompt excerpt, time, files-changed count, status (failures visible);
selecting a turn renders its diff in the existing viewer. Honest empty states
for unsupported providers and failed captures.

## Revert

Plan-first, `revert.ts` language. Plan = diff(checkpoint commit, current
tree) listing restore/delete per file. Apply:

1. Capture a `pre-revert` checkpoint (revert is itself undoable).
2. `git restore --source=<commit> --worktree -- .`
3. Delete files present now but absent in the target (from the diff list),
   symlink-safe containment as in `revert.ts`.
4. Per-file failure reporting. Working tree only.

## Testing

Offline main-process smoke coverage (`smoke*.ts` pattern): temp repo fixture,
drive the exported capture API directly. Asserts: pre-session dirty state
restorable; turn chain ordering; unchanged-tree dedup; diff correctness;
revert restores and deletes; `pre-revert` exists after revert; ref + row
cleanup on session delete; non-git cwd disabled; failures recorded honestly.
Full `npm test` on Node 22.23.2 before handoff.

## Boundaries

- No provider is claimed hook-capable until verified end to end (Claude only
  at ship time).
- Never auto-commit to user branches; never write outside `refs/wanigan/`.
- A capture must never block a hook response or a session.
