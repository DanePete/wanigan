# Attention and session state (helper sweep · P2)

One probe, `scripts/probe-helper-p2-attention.mjs`, both themes, 1440×900.
Before is `feat/helper-sweep` (36c2daf) built in a detached scratch worktree
with the same script copied in and `--before`; after is
`feat/helper-p2-attention`. Both run the built renderer in plain Chromium with
the preload bridge stubbed, so these are evidence about layout and wording,
never about hooks, IPC or persistence — `src/main/smoke31.ts` covers those.

The fixture hands both builds the same attention records, including the new
`helper` field. The before build ignores that field, which is the comparison:
same queue, nothing to act on. One artifact of that: the before strip reads
"2 denied by auto mode", because the old count grouped by kind and took the
first label — the after build groups by word, which is the fix it shows.

| Shot | What changed |
| --- | --- |
| `strip-*` | The denial chip carries **Tell it to retry** and **Open the timeline**; the incident chip carries a status-page link; a question chip says how many options and "answer in the terminal"; the snoozed session is counted ("1 snoozed") and has no chip; counts group by word. |
| `session-tab-running-*` | Returning to a tab after two minutes shows **Since you last looked**: turns, files changed, failed commands, reported cost, current verdict, and Claude's own recap labelled as Claude's. The tab's `⋯` menu offers **Mark unread** and the four snooze presets. |
| `session-tab-exited-*` | An exited tab has an in-place **Resume** ("starts a new process on this same conversation") instead of "resume it from Recent", and a session that stopped on a rate limit offers **Resume at** a stated time from the last limit reading. |
| `fleet-inspector-denial-*` | The inspector shows the classifier's reason, the exact retry line, the two actions, and the snooze presets. |
| `fleet-inspector-question-*` | An open AskUserQuestion lists its options read-only, with why Wanigan does not type the answer. |
| `settings-status-*` | **Provider status checks**, default on, saying it is a plain public GET with no user data. |

Assertions are in each folder's `verification.json`: every route is checked to
have rendered, and in after mode each new control is checked present and not
clipped. Each PNG was opened and read, not just counted.
