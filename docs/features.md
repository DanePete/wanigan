# Feature matrix

This beta.1 source candidate preserves all 252 feature rows from alpha.18
`627bb85212fe9e3ba0a6c36492a516dcdf4a9f36`, with their existing evidence and
qualifications. Its scope is the existing macOS Apple-silicon workflow:
project boards, terminal sessions, saved work and Needs you. No new feature
claim or broader provider, platform or accessibility support is implied.

Beta.1 acceptance checks and its own full local gate, native packages,
exact-commit GitHub workflows, publication, public downloads and website
verification remain **pending**. Alpha.18 observations are historical evidence,
not beta.1 verification. The wider audit remains open.

The remaining beta acceptance work includes opening a populated, owned
alpha.18 saved-data fixture with the exact beta source twice, and exercising
owner account-utility dispatch, completion and cancellation with stand-in
Claude and Codex executables. These checks have not run against beta.1.
They will not establish installed-app replacement, live terminal survival,
real-provider authentication or billing, physical Phone/Tailscale access,
or clean macOS 13/Gatekeeper behavior. Those boundaries remain qualified.

Alpha.18 completed its 1,114-test local full gate, desktop/phone sweeps and 72
targeted checks. Seven native stages, ten standalone command records, the
host guard and final native assembly passed for the exact source above.
The codex-review GitHub workflow passed on attempt 1. The main workflow
failed: its control crawl recorded 1,436 passes and one failure on the NS-7
review card’s “Banner shows when the cart is under $75” checkbox. Playwright
timed out during its pre-click actionability check; no criterion update was
dispatched. An unchanged, single-worker local crawl of the same surface later
passed all 39 discovered controls, including the first checkbox’s
`criteria.update` call. It did not reproduce the CI failure or its concurrent
load. The cause remains unclassified and is retained as an unresolved test
reliability risk; no product correction or confirmed intermittent cause is
claimed. This focused result does not retroactively pass main CI. Alpha.18
remains unpublished and is superseded by beta.1, without a CI rerun or website
publication. Beta.1 still requires its own full local gate and both
exact-commit GitHub workflows.

The [alpha.18 feature proof](reviews/2026-10-07/alpha18-feature-proof.md) records
its separate Tokens/History/Board component checkpoint: both typecheckers and
62/62 selected units, eight corrected Board cancellation cases, six actual
drops and four capped-Done/empty-target controls. Root individually reviewed
all 34 fresh images. These bounded fixtures retain their documented limits.

Alpha.17 completed its 1,100-test local full gate, seven native stages and both
exact-commit GitHub workflows. Its prerelease is published; fresh public DMG and
ZIP downloads matched the verified assets. Its website update passed all eight
local and live stages, with 599 assertions and 36 individually reviewed images
in each run. The broader audit remains open.

Test paths are under `src/` unless they start with `scripts/`. A test is named
`file › "its name"`. A UI sweep check (`scripts/ui-sweep.mjs`) is named by what
it fails on. Run them with:

```sh
node scripts/run-electron-node.mjs --test --test-timeout=60000 "src/**/*.test.ts"
env -u ELECTRON_RUN_AS_NODE npm run -s test:ui
```

Status:

- **proven**: a test asserts the stated outcome for its fixtures.
- **added**: proven by a test added in this pass.
- **fixed**: it was false in the code; fixed, with a test that fails without the fix.
- **corrected**: the doc claimed something untrue; the doc now says what the test proves.
- **manual**: not covered by the automated suite here; the reason is given.
- **partial**: useful automated coverage exists, with the remaining gap stated.

## Projects

| Feature | The claim | Test | Status |
|---|---|---|---|
| Open a project | A folder you open gets a short key (`NS`) and its own board; the same folder twice is one project; a missing folder is refused. | `core/core.test.ts` › "projects get keys, and cards get project-scoped keys"; `shared/rules.test.ts` › "project keys come from the name and never collide" | proven |
| Nothing written into a project | Nothing is written into the project folder to make Wanigan work. | `core/session-life.test.ts` › "working a project writes nothing into its folder"; `core/checkpoints.test.ts` › "a capture leaves the status, index, HEAD, refs and stash exactly as they were" | added |
| Change a project's key | A new key renames every card; a key in use or not a key is refused. | `core/board-rules.test.ts` › "a new key renames every card in the project; a key in use or not a key is refused" | added |
| Close a project | Refused while a session runs; a closed project leaves the rail and Needs you; opening the folder again brings it back whole. | `core/board-rules.test.ts` › "closing a project waits for its sessions, hides it and what it needs, and opening the folder again brings it back whole" | added |
| Folders the agents worked in | Offered when opening a project: ranked by conversations in 30 days, bounded, and saying when cut. | `core/agent-folders.test.ts` › "folders the agents worked in are ranked by conversations in the last 30 days, then by how recent", "the look is capped and says so when it is cut", "a record names its folder in its first few KB, or not at all"; `scripts/ui-sweep.mjs` › "the busiest folder is not first" | proven |
| Activity | Every claim, transition and session is recorded and attributable, per project and per card. | `core/board-rules.test.ts` › "activity: every change names who made it, newest first, by project and by card" | corrected (design said "global, filterable by actor"; the view is per project) |

## Cards and the board

| Feature | The claim | Test | Status |
|---|---|---|---|
| Card types | Task, bug, feature or idea, and nothing else. | `core/board-rules.test.ts` › "an edit changes what a card says…"; `core/cli.test.ts` › "file: what an agent files lands in the Inbox…" | added |
| Agents file into the Inbox | What an agent files lands in the Inbox, as its own, at the priority it gives. | `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/cli.test.ts` › "file: what an agent files lands in the Inbox, as its own, at the priority it gives" | proven |
| Agents can't claim from the Inbox | Nobody works an Inbox card the owner has not accepted. | `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/board-rules.test.ts` › "the owner starting a session on an Inbox card accepts it; an agent cannot take it from there" | corrected (design said an agent can claim an Inbox card) |
| The owner accepts from the Inbox | To Ready by a move or the A key; starting a session on it accepts it too. | `core/board-rules.test.ts` › "the owner starting a session on an Inbox card accepts it…"; `scripts/ui-sweep.mjs` › "accepted from the Inbox, did not glide into Ready" | added |
| No dragging into Working | Work starts when a session takes the card. | `core/core.test.ts` › "the owner cannot drag a card into Working"; `shared/rules.test.ts` › "the owner cannot drag work into Working or out of Done" | proven |
| Review needs evidence | An agent's submission, and the owner's move to Review, each need a file, a link or a note. | `core/core.test.ts` › "an agent claims, notes and submits through the CLI in its own terminal"; `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing, ranks never collide"; `core/cli.test.ts` › "review: evidence is a file, a link or a sentence, and none is no review" | proven |
| Only the owner approves | An agent cannot move a card to Done. | `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/access.test.ts` › "a session can call only what ACCESS gives it…" | proven |
| Approve, send back, reopen gates | Approve and send back only from Review, reopen only from Done; approving clears the flags. | `core/board-rules.test.ts` › "approve and send back only from Review, reopen only from Done; approving clears what was flagged" | added |
| Send back | To Ready, flagged; the note becomes a comment the submitting session sees in `wanigan status`. | `core/core.test.ts` › "an agent claims, notes and submits through the CLI in its own terminal" | proven |
| Reopen as not fixed | Done back to Ready, flagged, with what is still wrong as a new criterion. | `core/core.test.ts` › "an agent claims, notes and submits…"; `core/board-rules.test.ts` › "approve and send back only from Review…" | proven |
| Archive | Only the owner archives; the card leaves the board, its counts and search; nothing can work it; archiving is final. | `core/board-rules.test.ts` › "only the owner archives: the card leaves the board, its counts and search, nobody can work it, and archiving is final" | fixed (a session on an archived card was spawned before being refused; the refusal offered a Restore that does not exist); corrected (design said the owner "deletes") |
| Ranks | A card dropped between two lands between them, and ranks never collide; a new card lands on top. | `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing, ranks never collide"; `shared/rules.test.ts` › "ranks fall between their neighbours"; `core/board-rules.test.ts` › "an edit changes what a card says…" | proven |
| Priorities | P0–P3; agents are offered P0 first. | `core/cli.test.ts` › "status: the agent’s card, what was sent back, what else it holds, Ready by priority, decisions, and a pause" | added |
| What a card shows | Its priority, how long it has sat in its column, who holds it and whether they are running. | `core/board-rules.test.ts` › "an edit changes what a card says and records it, never its column or its time there; a move restarts that time", "a card says who holds it and whether they are running, from the session itself" | added |
| Edit a card | Title, description, type and priority change and are recorded; bad values are refused. | `core/board-rules.test.ts` › "an edit changes what a card says…" | added |
| Criteria | The owner ticks, rewords and removes them; an agent may only add one. | `core/board-rules.test.ts` › "criteria: the owner ticks, rewords and removes them; an agent may only add one" | added |
| Questions | `wanigan ask` raises Needs you; the owner's reply on the card settles it; a closed card asks nothing. | `core/cli.test.ts` › "ask: a question reaches Needs you…"; `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing…" | added |
| Cards across projects | Found by key, title or description in every open project; wildcards are literal. | `core/core.test.ts` › "cards can be found across every project" | proven |
| How this works | Every board draws the flow with live numbers, and a box shows its column. | `scripts/ui-sweep.mjs` › "the explainer's Review box did not show its column" | proven |
| Board keys | J/K and arrows move between cards; A and X triage the Inbox. | `scripts/ui-sweep.mjs` › "board keys did not move focus"; `shared/shortcuts.test.ts` › "the sheet’s board keys are the keys the board handles" | proven |
| Drag between columns | Drag a card to a column and a place in it; the marker shows the destination after removing the dragged card from indexing. | `scripts/ui-sweep.mjs` › forward/reverse/no-op/end marker and Escape cancellation, four gestures per theme; separate owned actual-drop proof in alpha.18 feature proof; existing `core/hardening.test.ts` board rules | fixed for checked gestures: durable eight cases pass after six intended red failures; six real browser drops verify stored/displayed order in both themes. Capped Done and empty-target checks are cancellation-only; native Electron drag and arbitrary filter/sort cases remain unverified |
| List view | The board as a table. | `scripts/ui-sweep.mjs` › route `list` renders real rows in both themes | proven |

## Claims and leases

| Feature | The claim | Test | Status |
|---|---|---|---|
| Claim | A session takes a card through `wanigan claim` or by being started on it. | `core/core.test.ts` › "hook events drive state, Needs you and the session briefing", "an agent claims, notes and submits through the CLI in its own terminal" | proven |
| Lease | A 30-minute lease, renewed while its session runs; a dead session's claim expires. | `core/core.test.ts` › "a claim from a dead session expires; a live session keeps its claim" | corrected (design said renewed while "live and reporting"; it is renewed while the process runs) |
| Sleep | A claim survives the machine sleeping while its session runs. | `core/hardening.test.ts` › "a claim survives the machine sleeping while its session runs" | proven |
| One claimant | Another session cannot take a claimed card. | `core/hardening.test.ts` › "a claim survives the machine sleeping…" | proven |
| Note | `wanigan note` adds a comment and renews the claim. | `core/cli.test.ts` › "claim, note and release: a claim is taken, kept and given back, and each step is on the card" | added |
| Release | `wanigan release` gives the card back to Ready, recorded as the agent's. | `core/cli.test.ts` › "claim, note and release…" | added |
| Released on exit | A session that ends gives back what it held, and says so. | `core/core.test.ts` › "a session is confined to its project and cannot approve" | proven |
| Hand-over | Continuing on another account moves the claim in one step. | `core/limits.test.ts` › "a usage limit is its own need, and the conversation carries on under another account with its card" | proven |

## Sessions

| Feature | The claim | Test | Status |
|---|---|---|---|
| Start | Card and one-off launches preflight complete briefing size/rows before preparation and recheck after awaited preparation before PTY/session insertion; reducing the owned excess permits retry. | Existing start/admission suites; `core/briefing-budget.test.ts` | partial: 15 component cases and 90 combined cases pass; both-theme owned before/after refusal/recovery passes. Late recheck does not undo preparation already completed; no real model launch claimed |
| Stop | Stopped by the owner is ended, not failed, and gives the card back. | `core/core.test.ts` › "an ended Claude conversation resumes on the same card and account"; `core/session-life.test.ts` › "an agent that dies on its own is failed, not ended…" | proven |
| Survive the window | Quitting the app never ends a session; a new window finds it and replays it. | `main/core-process.test.ts` › "a session outlives the app that started it" | proven |
| A session that fails | Exiting non-zero, or killed by a signal nobody sent, is failed and raised. | `core/session-life.test.ts` › "an agent that dies on its own is failed, not ended…"; `core/needs-rules.test.ts` › "a failure stops asking after three days…" | fixed (a process killed by a signal read as Exited) |
| Interrupted | When the core dies, the app starts it again; its sessions read as interrupted and their cards go back. | `main/core-process.test.ts` › "a core that dies is started again, and says plainly which sessions it lost" | added |
| Resume | An ended Claude conversation continues on the same card and account, where it ran, once. | `core/core.test.ts` › "an ended Claude conversation resumes on the same card and account"; `core/review2.test.ts` › "a conversation carried on runs where it ran, and starts once" | proven |
| Continue on another account | A limited conversation forks under another account with its card. | `core/limits.test.ts` › "a usage limit is its own need…" | proven |
| Rename | The new name is what Needs you and search show. | `core/session-life.test.ts` › "a renamed session keeps its new name wherever it is shown" | added |
| Promote | A one-off becomes a card, its history with it. | `core/session-life.test.ts` › "a one-off session becomes a card with its history, and works it while it runs" | added |
| Attach | A running one-off attached to a Ready card works it; one already worked is refused. | `core/session-life.test.ts` › "attaching a running one-off to a Ready card…"; `core/hardening.test.ts` › "a refused start leaves nothing running…" | added |
| Queue and deliver | A message waits until the agent is idle, then goes as one bracketed paste. | `core/core.test.ts` › "queued messages wait for a Claude session to be idle", "a Codex session reports waiting, asking and working from its own notifications"; `core/paste-escape.test.ts` › "a queued message cannot end its own bracketed paste" | proven |
| Ephemeral | A terminal a key may be typed into keeps no record, even after a crash. | `core/review2.test.ts` › "a terminal a key may be typed into keeps no record once it closes"; `core/ephemeral-search.test.ts` › "a key typed into an ephemeral terminal is never found by search, even after a crash" | proven |
| Remote Control | Claude Code only, named after the session, only when the owner turns it on. | `core/attachments.test.ts` › "Remote Control is passed, named after the session, only when the owner turns it on" | proven |
| Model and effort | Started with the model and effort chosen, kept on resume; anything not a name is refused. | `core/hardening.test.ts` › "a session starts with the model and effort chosen, keeps them, and refuses anything that is not a name" | proven |
| Named after the card | Claude's own picker and title show the card. | `core/session-name.test.ts` › "a Claude session on a card is named after it; a one-off is not" | proven |
| Terminal record | Output streams with sequence numbers; the newest 2 MB stays in memory and 8 MB on disk. | `core/core.test.ts` › "terminal output streams to watchers with sequence numbers"; `core/scrollback.test.ts` › "memory keeps the newest 2 MB…" | added |
| Watch | Up to four live terminals, the ones that most need you first; a tile never resizes its PTY. | `shared/watch.test.ts` (six tests); `core/watch.test.ts` › "watching a session gives its PTY size, and a real resize is announced once"; `scripts/ui-sweep.mjs` › "a PTY changed size while it was watched" | proven |
| Overlap | Two live sessions editing one file is raised, and clears when one stops. | `core/core.test.ts` › "two live sessions in one folder editing one file is raised, and clears when one stops" | proven |
| Codex edits | A Codex `apply_patch` counts as an edit to every file the patch names (added, updated, moved, deleted), for overlaps, commit attribution and Talk to Wanigan; edits recorded before this are carried over. The hook's shape was read from Codex's source at rust-v0.155.1. | `shared/edits.test.ts` (three tests); `core/core.test.ts` › "a Codex patch counts as an edit to every file it names…"; `core/db-upgrade.test.ts` › "edits recorded before session_edits existed are carried into it" | proven with Codex's documented payload; not yet seen from a real Codex turn |
| Chatter | Who messaged whom and the label, never the message. | `core/core.test.ts` › "agents messaging each other are recorded as who and label, never the message"; `scripts/ui-sweep.mjs` › "the message itself reached the screen" | proven |
| Timeline as turns | Events read as turns: prompt to stop, with tools, files and permission asks. | `shared/turns.test.ts` › "events become turns: prompt to stop, with tools, files and permission asks" | proven |

## Hooks, Codex and the briefing

| Feature | The claim | Test | Status |
|---|---|---|---|
| Claude hooks | Injected with `--settings`, relayed by `relay.sh`; events drive state; a slow body is still read. | `core/core.test.ts` › "hook events drive state, Needs you and the session briefing"; `core/hardening.test.ts` › "a hook body that arrives after its header is still read" | proven |
| Permission stands | A permission request stands until something answers it. | `shared/rules.test.ts` › "a permission request stands until something answers it"; `core/core.test.ts` › "hook events drive state…" | proven |
| Late hooks | A hook after the end does not rewrite how a session ended. | `core/hardening.test.ts` › "a late hook does not rewrite how a session ended…" | proven |
| Briefing | Claude/Gemini hook context and Codex launch instructions admit the whole encoded briefing within 64 KiB and bounded criteria/decision rows. Oversized late hook context yields a fixed notice and records the refusal. | `core/briefing-budget.test.ts`; existing Core/board/Gemini suites | partial: 15/15 focused, types and owned UI pass. Logical input/output accounting, not total heap/CPU or a guarantee that a late hook notice blocks a model turn |
| Codex by OSC 9 | Waiting, asking and working from Codex's own notifications; Enter on nothing is not a turn. | `core/core.test.ts` › "a Codex session reports waiting, asking and working…"; `core/hardening.test.ts` › "Codex: Enter on an empty line or a /command is not a turn"; `shared/codex.test.ts` (five tests) | proven |
| Codex hooks | Injected with `-c`, trusted by hash only after Codex's app server lists them; otherwise OSC 9 and a note why. | `core/codex-hooks.test.ts` › "Codex hook flags define each event once…", "Codex hooks: trusted by the hashes Codex lists, asked once per version", "Codex hooks: anything short of every hook trusted launches without them, and says why", "a Codex session launches with trusted hooks only when the probe says so" | proven |
| Codex thread | A relayed hook names the thread; tokens, History and resume follow. | `core/codex-hooks.test.ts` › "a relayed Codex hook names its thread; tokens, History and resume follow", "a Codex session whose thread is not known cannot be resumed, and says why" | proven |
| A shell's states | A shell reports running, ended, or failed with its exit code; a session can also be `limited`. | `core/needs-rules.test.ts` › "a failure stops asking after three days…"; `core/limits.test.ts` › "a usage limit is its own need…" | corrected (README and design said a shell is running or ended only; the design's states left out `limited`) |
| Codex hooks against a new Codex | `scripts/codex-hooks-probe.ts` re-checks a new Codex version without spending. | none | manual: runs the installed Codex |

## Needs you

| Feature | The claim | Test | Status |
|---|---|---|---|
| Permission | Raised, most urgent, with exactly what is asked, hidden and lookalike characters spelled out. | `core/needs-answer.test.ts` › "a permission row carries the exact command, hidden characters and all, until the request is settled"; `shared/hidden.test.ts` (sixteen tests); `scripts/ui-sweep.mjs` › "the zero-width space was not spelled out" | proven |
| Review | A card in Review needs the owner until approved or sent back. | `core/core.test.ts` › "an agent claims, notes and submits…"; `core/needs-rules.test.ts` › "looking settles a finished turn; a permission request, a review and a question wait for their answer" | added |
| Question | Stands until the owner answers on the card. | `core/cli.test.ts` › "ask: …"; `core/needs-rules.test.ts` › "looking settles a finished turn…" | added |
| Failed | Raised, resumable when the conversation is known, until seen; stops asking after three days. | `core/session-life.test.ts` › "an agent that dies on its own is failed…"; `core/needs-rules.test.ts` › "a failure stops asking after three days…"; `core/worktree-setup.test.ts` › "a new card worktree gets the ignored files…" | fixed (an agent killed by a signal was never raised) |
| Interrupted | Raised after the core is lost, until seen. | `main/core-process.test.ts` › "a core that dies is started again…" | added |
| Usage limit | Its own need, not a finished turn; seen settles it until the reset comes. | `core/limits.test.ts` › "a usage limit is its own need…"; `shared/limits.test.ts` (five tests) | proven |
| Finished turn | Only after a turn finishes, never at a fresh prompt; news until seen, and again on the next. | `core/core.test.ts` › "hook events drive state…"; `core/needs-rules.test.ts` › "looking settles a finished turn…" | added |
| Gone quiet | A working Claude session silent 20 minutes is raised; Codex's silence never is. | `core/core.test.ts` › "a working Claude session that goes quiet is raised; looking at it settles it"; `core/needs-rules.test.ts` › "…Codex going quiet while it works is never raised" | added |
| Overlap | Two sessions editing one file. | `core/core.test.ts` › "two live sessions in one folder editing one file is raised…" | proven |
| Ranking | Permission first, then overlap, limit, review, failed, interrupted, quiet, question, finished turns last; oldest first within a kind. | `shared/rules.test.ts` › "needs are ranked by kind, then oldest first", "every kind of need has its place…" | added; corrected (design listed four of the nine kinds) |
| Seen and clear | Looking settles a finished turn, a failure, a quiet session or a limit; never a permission, review or question. | `core/needs-rules.test.ts` › "looking settles a finished turn…"; `core/session-life.test.ts`; `core/limits.test.ts` | added |
| Reply in place | A reply to a finished turn is sent at once; the row clears when the agent starts, not when sent. | `core/needs-answer.test.ts` › "a reply to a finished turn is sent at once, and the row clears when the agent starts, not when it was sent"; `scripts/ui-sweep.mjs` › "the row cleared before the agent started" | proven |
| Reply offered where it lands | Claude Code only; a Codex row says why not. | `shared/hidden.test.ts` › "Reply is offered where a message is known to land and the row clears on evidence"; `scripts/ui-sweep.mjs` › "a Codex row does not say why it offers no Reply" | proven |
| Every project | One list across projects; a closed project asks nothing. | `core/board-rules.test.ts` › "closing a project waits for its sessions…" | added |
| The orb's colour | A failure-first signal derived from current needs; its precedence is distinct from the Needs list. | `renderer/src/orb/choreography.test.ts` › "the signal is the most urgent need, and an unread list is not an all-clear" | proven |

## Alerts and notifications

| Feature | The claim | Test | Status |
|---|---|---|---|
| Where a need is announced | In the window while it is in front, as a macOS notification when not; once each. | `shared/notifications.test.ts` › "in front, a new alert goes to the window, not to macOS", "only needs not announced before are announced", "a need that arrived while you looked is announced when you leave, if still open" | proven |
| Bursts | The two most urgent and one line for the rest. | `shared/notifications.test.ts` › "a burst becomes the two most urgent and one line for the rest" | proven |
| Levels | All, only permission and failures, or nothing. | `shared/notifications.test.ts` › "only permission and failures, or nothing, as the owner chose"; `scripts/ui-sweep.mjs` › "patches did not reach the app" | proven |
| Alerts in the window | One urgent alert and one status; Open goes to it; what is on screen is not an alert. | `scripts/ui-sweep.mjs` › "two alerts never showed", "Open did not go to the session asking", "an alert for something on screen" | proven |
| Native notifications | Shown by macOS; a click opens where the need is answered. | Which route a click opens: `shared/notifications.test.ts` › "a notification opens where the need is answered" | manual: macOS shows them only to a running, signed app |
| Dock badge | The count of needs. | none | manual: `app.dock` exists only in the running app |
| Keep awake | While the app is open and Keep awake is enabled, a live session holds the Mac awake; quitting releases the blocker even if the detached core still has sessions. | `main/awake.test.ts` (four tests) | proven |
| An honest quit | Quitting says sessions keep running, once per launch. | none | manual: a native dialog in the running app |
| Check for updates | GitHub's releases list is read; the newest later version is offered, a prerelease only to someone on one; drafts, unreadable tags and links off this repository are never offered; a reply that is not a releases list, a refusal, a timeout or an oversized answer is a failure with its reason, never "up to date". | `shared/updates.test.ts`; `main/updates.test.ts` › "every way GitHub can fail is a failure with its reason, never \"up to date\"", "an oversized chunked release response is cancelled before the rest is buffered", "update checks read later pages before claiming there is no stable update" | added |
| What a check sends | Only GitHub's releases list is asked, with a User-Agent that names the check and nothing about the owner; two checks at once are one request; the result is kept owner-only and remembered across launches. | `main/updates.test.ts` › "a check asks GitHub’s releases list, says only what is asking, and keeps what it found", "two checks at once are one request" | added |
| Daily check needs a yes | Nothing is checked until the owner answers the rail's question; then once a day, an hour after a failure; the demo never checks. | `main/updates.test.ts` › "the daily check waits for a yes, then asks once a day, and sooner after a failure"; `main/menu.test.ts` › "Check for Updates… sits under About, and is absent where the app never checks"; `scripts/ui-sweep.mjs` › "checked before the owner answered", "the rail never asked whether to check daily" | added |
| A new version is shown | Settings names it with Download and Release notes, and the rail says it is out; the window opens only links the check found. | `scripts/ui-sweep.mjs` › "a new version found by Check now is not shown", "the rail does not say a new version is out", "the window asked" | added |
| Check for Updates… dialog | The menu's answer: up to date, a new version with Download and Release Notes, or why the check failed. | none | manual: a native dialog in the running app |

## Models on this Mac

| Feature | The claim | Test | Status |
|---|---|---|---|
| Optional | Without LM Studio or a running Ollama nothing local is offered, the agents' own lists are unchanged, and Get refuses. | `core/local-models.test.ts` › "without LM Studio or Ollama nothing local is offered, and the agents’ own lists are unchanged" | added |
| What is on this Mac | LM Studio's real port (not 1234 when it chose another), its models and each module's state come from `lms`; models no module describes are offered as not proven. | `core/local-models.test.ts` › "LM Studio’s real port, its models and the module’s state are read from lms" | added |
| A module not downloaded | Offered with its size and "get it in Settings", and cannot start; nothing starts in its place. | `core/local-models.test.ts` › "a module not on this Mac is offered with its size, and cannot start" | added |
| Downloads | Only a reviewed module is downloaded. A reservation admits one attempt per module before preflight; cancellation/shutdown during preflight launches nothing. Free space must be finite, nonnegative and cover the complete model plus 10 GB; unreadable measurements refuse. Progress/failure remain observable, and the demo downloads nothing. | `core/local-models.test.ts`; `core/local-download-safety.test.ts` › actual owner concurrency, held preflight/cancel, shutdown and spawn-error retry; `core/local-preflight-safety.test.ts` › unreadable/invalid disk and exact-headroom edges | focused corrected; owned child/disk seams, no real model download or aggregate disk reservation |
| Claude Code on a local model | The server is started and the model loaded with the selected context before launch; failed LM Studio estimates and explicit will-not-fit results refuse forced loading. Local launch variables retain the chosen model/server, remove account keys and disable telemetry. | `core/local-models.test.ts`; `core/local-preflight-safety.test.ts` › failed estimate creates no session/PTY/load, healthy retry starts the stand-in | focused corrected; no real memory-pressure/model proof; unfamiliar zero-exit estimate wording remains a limit |
| Ollama and NVIDIA PAIR | Offered when running, launched with Codex's `--oss`, never downloaded through; a model it lacks refuses. | `core/local-models.test.ts` › "Ollama, or NVIDIA PAIR at its address, is offered when running and never downloaded through" | added |
| Project default | A project's new sessions start on its local model; only a local value is accepted. | `core/local-models.test.ts` › "a project can start its new sessions on a local model, and only on a real local value" | added |
| In the window | "On this Mac" in the model picker, explained when chosen, no effort offered; Settings › Local models; the session header says it runs on this Mac. | `scripts/ui-sweep.mjs` › "the model picker has no \"On this Mac\" group", "Settings does not show LM Studio and Qwen", "the session header does not say it runs Qwen on this Mac" | added |
| A real turn on Qwen | Claude Code on Qwen3-Coder through LM Studio, a turn with a Read tool call reported by its hooks. | `scripts/local-model-check.mjs` | manual: needs LM Studio and the 17.2 GB model; spends nothing |

## Gemini CLI

| Feature | The claim | Test | Status |
|---|---|---|---|
| Hooks from Wanigan's Gemini home | Started with GEMINI_CLI_HOME at Wanigan's own Gemini home: its seven hooks (millisecond timeouts), the owner's sign-in method and trusted folders copied in, the owner's own settings untouched and their MCP servers not loaded. | `core/gemini.test.ts` › "Gemini starts in Wanigan’s own Gemini home with its hooks and the owner’s sign-in method, and its conversation id is learnt from its hooks" | added |
| Its id from its hooks | No --session-id (Gemini restarts with the same arguments when a folder is trusted, and refuses a used id); the conversation and its transcript are learnt from SessionStart and BeforeAgent. | `core/gemini.test.ts` (same test); `scripts/gemini-check.ts` | added |
| Turns, tools and asks | Briefed once as JSON at SessionStart: after one parse, `additionalContext` begins with the human project briefing and contains actual newlines. BeforeAgent starts a turn, AfterAgent ends it; tools read as Read, Edit, Bash…; a ToolPermission notification raises an ask naming the command; model events are never recorded; nothing is printed into its window. | `core/gemini.test.ts` › "Gemini’s hooks drive the session: briefed at start, a turn, a tool read as Read, an ask raised, and the composer only after its first turn"; `shared/agent-hooks.test.ts` (Gemini tests) | fixed (component stand-in hook relay: 4/4, 53 neighbors, both typecheckers/wrappers 0; full/native/CI pending; no real model/installed-Gemini claim) |
| Refusal and cancel | No hook fires; the window title going back to Ready returns an asking or working session to its prompt. | `core/gemini.test.ts` › "Gemini: a refused permission or a cancel fires no hook, and its window title going back to Ready says so" | added |
| Composer | Refused until Gemini's first turn: its first screen may ask to sign in or to trust the folder. | `core/gemini.test.ts` (the hooks test) | added |
| Resume | Only once Gemini saved the conversation; then `--resume <id>`. | `core/gemini.test.ts` › "Gemini resumes its conversation only once it saved one" | added |
| The real CLI | The installed Gemini CLI asks about a new folder (raised in Needs you), and once trusted its SessionStart reaches Wanigan through the relay. | `scripts/gemini-check.ts` | manual: the installed CLI; no login, no model call |
| In the window | New session offers Gemini CLI with its aliases and models, and no Remote Control. | `scripts/ui-sweep.mjs` › "New session does not offer Gemini CLI", "Gemini CLI’s models are not offered", "Remote Control is offered for Gemini" | added |

## On your phone

| Feature | The claim | Test | Status |
|---|---|---|---|
| Pairing | A code works once, for one phone, and is refused after it is used or replaced; ten wrong codes in a minute and pairing waits. | `core/phone/phone.test.ts` › "a pairing code works once, for one phone, and is refused after it is used or replaced", "guessing pairing codes is slowed: ten wrong ones and pairing waits" | added |
| Acting from a phone | A paired phone reads and acts as the owner, and Activity says it was that phone. | `core/phone/phone.test.ts` › "a paired phone reads and acts as the owner, and Activity says it was from that phone"; `scripts/phone-sweep.mjs` › "Activity does not say the phone did it" | added |
| What a phone cannot reach | Account list metadata is readable; account changes, settings, Git, keys and pairing management are refused. After the complete RPC body, current token and Can act permission are checked before dispatch: held actions after revocation refuse, and forgotten tokens fail. | `core/phone/phone.test.ts` › allowlist; `core/phone/gateway-auth-safety.test.ts` › held card/session requests after Can act/Forget, exact unchanged rows, healthy reads and restored-control retry | focused corrected; early authentication retained, already-dispatched work is not canceled |
| The gateway | Loopback only; only the phone page’s own files; another Host or Origin refused; terminal output only when watched; forgetting ends its stream. Malformed URLs return a controlled error. SSE admits at most 4 streams per device/32 globally and caps each response’s pending UTF-8 output accounting at 2 MiB; slots remain charged until native close. | `core/phone/phone.test.ts`; `core/phone/gateway-safety.test.ts`; `core/phone/gateway-sse-safety.test.ts` › admission, multibyte/chunk/terminator budget, native close, forget/Off and other-owner recovery | focused corrected; exact queue edges injected on real sockets, not total-memory or real-network exhaustion proof |
| Tailscale | Its state read from its CLI (missing, stopped, no HTTPS, ready); Wanigan adds and removes only `/wanigan`, never the root and never `serve reset`; the command shown is the command run. | `core/phone/tailscale.test.ts` (three tests) | added |
| On until turned off | Phone access and pairing survive core restarts. Off invalidates older On continuations and closes local HTTP/SSE before external mount cleanup; overlapping listener transitions and mount mutations respect newer intent. Terminal stop preserves saved On but refuses same-instance re-enable; a new Core restores access. | `core/phone/phone.test.ts`; `core/phone/phone-disable-safety.test.ts`; `core/phone/phone-lifecycle.test.ts`; reconciled `gateway-sse-safety.test.ts` › actual replacement Core/token/output | focused corrected; external commands may finish after dispatch, queued cleanup may be skipped at terminal stop; enclosing Core startup remains separate |
| Notifications | Web Push is encrypted (RFC 8291) and signed (VAPID ES256); newly needed work is announced once. A gone response clears only the dispatched device/endpoint/key/auth subscription, preserving a different replacement. A canceled needs timer does not prevent delivery after settled re-enable. | `core/phone/push.test.ts`; `core/phone/push-replacement.test.ts` › changed endpoint/keys, unchanged gone neighbor and decrypted stand-in payload; `core/phone/phone-disable-safety.test.ts` › timer recovery | focused corrected; byte-identical resubscription is one identity, and no real push/iPhone delivery was verified |
| Settings › Phone | Says what Tailscale still needs, shows the command before running it, a QR code that decodes to the pairing address, the paired phone appearing, Can act, Forget, and Send a test notification only when a phone takes them. | `scripts/phone-sweep.mjs` › "Settings does not show the command before it is run", "the QR code holds", "the Mac does not list the paired phone", "a test notification is offered with no phone taking them" | added |
| The phone page | On an iPhone the QR link keeps the code for the Home Screen app, and in Chrome, Firefox or Edge there offers Open in Safari; elsewhere it pairs from the QR link after naming the phone; Needs you, a terminal typed into, a new session, a card made and accepted; no sideways scroll at 390px or 360px; a read-only phone is refused in words; a forgotten phone goes back to pairing.  Terminal input shares one per-link FIFO, with 128-call/256-KiB body budgets. Uncertain delivery cancels queued suffixes including Enter and pauses until deliberate review/reload; it is never automatically replayed. | `scripts/phone-sweep.mjs` (both themes; Safari and Chrome on an iPhone by user agent) ; `renderer/src/phone/bridge.test.ts` › owned-shell order/lost-reply outcomes and exact admission boundaries | fixed ordering: 24 focused new/neighbor cases, the corrected52 full gate and both-theme lost-reply renderer cases pass. Per-link serialized payload bound, no new deadline or total-heap guarantee |
| A real iPhone | Home Screen install, notifications arriving on the lock screen, and the page through a real Tailscale address. | — | manual: needs the owner's phone and Tailscale account |

## Worktrees and branches

| Feature | The claim | Test | Status |
|---|---|---|---|
| A card's own branch | Its own worktree, never the project folder. | `core/core.test.ts` › "a card works on its own branch, and is merged back only when it is safe" | proven |
| Setup command and `.worktreeinclude` | Ignored files named are copied; the setup command runs beside the agent; a failed setup is raised. | `core/worktree-setup.test.ts` › "a new card worktree gets the ignored files .worktreeinclude names, and runs the setup command beside the agent" | proven |
| Merge refuses | While the session runs, or either checkout has uncommitted work. | `core/core.test.ts` › "a card works on its own branch…" | proven |
| Merge never forces | A conflict is undone with nothing changed; a folder on another branch is refused. | `core/worktree-merge.test.ts` › "a merge that conflicts is undone and changes nothing; one into a folder on another branch is refused" | added |
| Restore | A worktree deleted by hand is made again from its branch. | `core/hardening.test.ts` › "removing a branch is all or nothing, and a missing worktree is made again" | proven |
| Keep the branch | Across a project key change, and never removed while unmerged. | `core/review2.test.ts` › "own branches are refused for a project inside a larger repository, and kept across a key change"; `core/hardening.test.ts` › "removing a branch is all or nothing…" | proven |
| Inside a larger repository | Refused, since the agent would start at the wrong root. | `core/review2.test.ts` › "own branches are refused for a project inside a larger repository…" | proven |

## Changes and diffs

| Feature | The claim | Test | Status |
|---|---|---|---|
| Uncommitted changes | A project’s changes and diffs are read-only; outside paths refuse. Command-scoped prefixes preserve paths under tested Git 2.40/2.55 preferences. Unreadable untracked files now refuse instead of returning a false-empty diff; healthy retries preserve the index and file bytes. | Existing `core/core.test.ts`, `core/git-prefix-compat.test.ts`; `core/git-untracked-read.test.ts` › actual owner-RPC EACCES and recovery | component fixed: 61-case suite including seven new cases and both typechecks pass; full/native/CI pending. No all-version or external-writer claim |
| A card's branch | Everything it changed since it forked, committed or not. | `core/core.test.ts` › "a card works on its own branch…" | proven |
| Odd files | Links are described without following their targets; FIFOs/directories are not opened as regular files. Oversized workbench reads refuse with an explanation, while binary and genuinely empty files keep their existing outcomes. | `core/hardening.test.ts`; `core/git-untracked-read.test.ts` › exact size/cap-plus-one, link, binary, empty and FIFO controls | component verified on owned fixtures; broader platform/path forms remain unproven |
| Syntax colour | PHP, Twig, YAML, JS/TS, CSS and more. | `shared/syntax.test.ts` (fifteen tests); `scripts/ui-sweep.mjs` › "the PHP diff shows no variables in colour" | proven |
| Unified or side by side | Each side in its own order. | `shared/diff.test.ts` › "side by side: context on both sides…", "side by side shows every line once, each side in its own order"; `scripts/ui-sweep.mjs` › "Split did not show side by side" | proven |
| Viewed marks | A mark per file that clears when the diff changes. | `shared/diff.test.ts` › "a diff’s fingerprint is stable and changes with any edit"; `scripts/ui-sweep.mjs` › "a mark on a diff that has since changed still folds the file" | proven |
| J/K and V | Between files; never taken from a note being typed. | `shared/shortcuts.test.ts` › "the sheet’s Changes keys are the keys the Changes view handles…"; `scripts/ui-sweep.mjs` › "J, K or V were taken from a note being typed" | proven |
| Notes on lines | Sent to the agent as one message, in file and line order. | `shared/review-notes.test.ts` › "notes become one message, in file and line order, each with its place and its code"; `shared/diff.test.ts` › "a note on a removed line attaches to the old file…" | proven |

## Git workbench

| Feature | The claim | Test | Status |
|---|---|---|---|
| Status and missing git | Branch/upstream/ahead/behind plus staged, unstaged, untracked and conflicted files; missing git differs from a non-repository. | `core/workbench.test.ts` › "status: branch, upstream, ahead and behind, and the four lists…" | proven |
| Stage and discard | Whole files, hunks or picked lines; stale diffs refuse before applying. | `core/workbench.test.ts` › "staging: files, all, a hunk, picked lines, unstaging lines, and discarding a hunk; a stale diff is refused", "parts of a file with no last newline apply in real git, staged and unstaged"; `shared/patch.test.ts` | proven |
| Staging refresh | A new file leaving Untracked can still answer an overlapping diff refresh without an error; its staged and remaining changed content stay visible. | `core/workbench.test.ts` › "an untracked diff refreshed after whole-file or partial staging is empty, without hiding staged work"; `scripts/ui-crawl.mjs` › "Staging a new file tolerates a diff refresh before status moves it out of Untracked" | fixed (the alpha.2 path guard rejected an expected refresh race) |
| Commit and amend | Only staged work is committed; empty index and unacknowledged secret findings refuse, and failures name their cause. Failed staged fingerprints and mid-scan staged mutation refuse without changing exact HEAD, symbolic HEAD, refs, index or working bytes; a healthy retry commits only staged content. | `core/workbench.test.ts`; `core/git-secret-state.test.ts` › partial fingerprint failure and second-fingerprint mutation; actual sentinels and two guard-removal mutants | additional outcome proof; Git behavior unchanged by this batch and post-final-check external writers remain possible |
| Write with Claude | On request, the initial prompt uses staged diff and read-only tools; failed reads refuse before launch and a valid bounded prefix is marked cut. Candidate prefix compatibility preserves the staged-only stand-in draft on actual Git 2.40/2.55. | `core/workbench.test.ts`, `core/commit-message-read-failure.test.ts`, `core/git-prefix-compat.test.ts` › staged/unstaged/untracked sentinels and owned draft; candidate 47-test Git group | candidate focused and both-version fixture pass; full/native passed; exact-commit CI/publication pending. Reading tools may later inspect other repository context; real model quality is unverified |
| Commit graph | Lists branch history, message/author filters and per-card commits, with commit details. | `core/workbench.test.ts` › "history: a graph across branches, a filter by message or author, a card’s commits named by its key, and a commit’s detail" | proven |
| Branch operations | Make, switch, merge, abort and delete, with ref validation and explicit unmerged deletion. | `core/workbench.test.ts` › "branches: make, switch, merge clean and conflicted, abort, delete merged and unmerged; a ref like an option is refused" | proven |
| Busy checkout | File/branch-changing operations refuse while a live agent uses the same checkout, including one opened as another project; staging and pushing remain available. | `core/workbench.test.ts` › "a live agent in the checkout…", "an agent in a checkout opened as another project still blocks changes to that checkout" | fixed (the same checkout under another project was missed) |
| Stashes | Save/show/apply/pop/drop retain existing identity/concurrency guards. Candidate command-scoped prefixes preserve tracked/untracked preview paths/content on actual Git 2.40/2.55 without the 2.55-unsafe string-prefix arguments. | `core/workbench.test.ts`, `core/stash-prefix.test.ts`, `core/git-prefix-compat.test.ts`; prior separate 12-configuration actual-Git matrix and fresh candidate two-version owner fixture | candidate focused proof; full/native passed; exact-commit CI/publication pending. Normal write hooks and Git index-cache maintenance remain; arbitrary versions/shapes are unproven |
| Fetch, push, pull | Push plan and scan; set upstream; no force push; pull fast-forwards or explains divergence. Every configured push URL is shown; changing the reviewed HEAD, push URL, branch or fetched tracking history requires a fresh plan. | `core/workbench.test.ts` › remote operations and all push URLs; `core/git-push-destination.test.ts` › changed push URL, remote branch and tracking history | fixed: stale-plan fixtures preserve real bare remotes; external Git writers are not excluded |
| Secret scan | Scans added textual outgoing content, including merge resolutions, with configured patterns; binaries, unsupported shapes and unchanged PEM headers may escape. Incomplete 200-commit/16-MiB scans require acknowledgement tied to checked content and destination. Failed/changed staged fingerprints refuse and preserve exact Git state. | `shared/secret-scan.test.ts`; `core/workbench.test.ts`; `core/pull-request.test.ts`; `core/git-secret-limits.test.ts`; `core/git-secret-state.test.ts` › failed-read and mid-scan mutation refusal/state/retry | additional exact-state proof; heuristic coverage and external-writer race after final checking remain, with no secret-free-publication guarantee |
| Conflict resolution | Reads base/ours/theirs; resolves hunks, binary sides, deletions, hand edits and rename pairs. Inline/indented markers remain text; complete whole-line marker blocks inside multiline strings are ambiguous and require explicit marker preservation when hand-resolving. Stale resolver content cannot overwrite newer edits. | `core/conflicts.test.ts` › "resolving: hunk choices written and staged…", "a whole file taken from one side…", "a stale resolver never overwrites edits made after the conflict was shown", "marking a conflict resolved as edited preserves a dangling symbolic link", "a rename on both branches can be resolved without leaving either renamed copy behind"; `shared/conflict.test.ts` | fixed (stale resolver and dangling links); partial for literal marker recognition; listed git fixtures proven |
| Finish a conflict | Diverged pull merges only when asked; merge and cherry-pick states remain visible until resolved/continued/aborted. | `core/conflicts.test.ts` › "a pull that cannot fast-forward merges only when asked…", "a cherry-pick that conflicts is named, resolved, and continued with git’s message" | proven |
| Outside paths | An untracked diff cannot follow an ancestor directory link outside the checkout. | `core/workbench.test.ts` › "an untracked diff cannot read through a directory link outside the checkout" | fixed |

## Per-turn checkpoints, undo and redo

| Feature | The claim | Test | Status |
|---|---|---|---|
| A checkpoint per turn | Written through a copy of the index into Wanigan's own object store. | `core/checkpoints.test.ts` › "a capture leaves the status, index, HEAD, refs and stash exactly as they were" | proven |
| Every edit in its turn | A checkpoint holds the folder as `git status` sees it, a same-size edit in the second the index was written included. | `core/checkpoints.test.ts` › "an edit the same size as before, made in the second the index was written, is in a checkpoint taken a second later" | fixed (the copied index was stamped later than the real one, so git trusted a stale entry; "a turn shows what changed…" failed now and then under load) |
| What a turn changed | File by file, in the timeline. | `core/checkpoints.test.ts` › "a turn shows what changed in the folder, file by file" | proven |
| Honest when not captured | Not a repository, or out of time, says so. | `core/checkpoints.test.ts` › "a folder that is not a repository, or a capture that runs out of time, says it was not captured" | proven |
| Codex too | Its "turn complete" takes one. | `core/checkpoints.test.ts` › "Codex’s “turn complete” takes a checkpoint too, and another session in the folder is noted" | proven |
| Undo and redo | The last turn, in a card's worktree at rest, remains inspectable and recorded. Availability assessments use separate temporary object stores and retain no new persistent objects for the tested changed-file, failure and concurrent cases; captures and exported snapshot behavior stay unchanged. No old-object pruning is claimed. | `core/checkpoints.test.ts` › "undo puts the last turn back, redo puts it forward again, and both are in the timeline"; `shared/checkpoints.test.ts` › "the last turn can be undone only in a card’s worktree, at rest, alone, and fully captured"; `core/checkpoints-assessment-storage.test.ts` (four actual red/green cases); `scripts/ui-sweep.mjs` › "the timeline does not record the undo" | fixed (component: 4/4, 20 neighbors; full/native/CI pending; type children 0, original cache-cleanup wrappers 1 preserved) |
| Undo refuses | Listed unsafe states refuse the actual Undo action, preserving files/modes, index, commit and symbolic HEAD, refs and checkpoint rows. | `core/checkpoints.test.ts` › "undo refuses whenever it could lose or misplace work", missing-object, hidden-file, ignore-change and other-project-agent cases; two action-guard mutants rejected | proven for listed refusal fixtures; not every possible concurrent external mutation |
| Large files | Left out, and the turn still records. | `core/checkpoints.test.ts` › "a large untracked file is left out of a checkpoint, and its turn still records" | proven |

## Attachments

| Feature | The claim | Test | Status |
|---|---|---|---|
| Kept in Wanigan's data | 0600 under the data folder, never in the project; bad input refused; judged by bytes. A refused unlink retains the pending row for retry; partial `dropUnsent` progress forgets only successfully removed files. Sent files remain and already-missing files can be forgotten. Filesystem and SQLite changes are not atomic; no old-orphan pruning or session-crash guarantee is claimed. | `core/attachments.test.ts` › "a file is kept 0600 under Wanigan’s data folder, never in the project, and bad input is refused"; `shared/attachments.test.ts` (three tests); `core/attachment-removal-failure.test.ts` (four actual permission/partial-progress/missing/sent cases) | fixed (final component: 4/4, 17 neighbors, both typecheckers/wrappers 0; full/native/CI pending; earlier test-only type failure preserved) |
| The owner's | A session's own token cannot attach, list or read files. | `core/attachments.test.ts` › "a session’s own token cannot attach, list or read files" | proven |
| Claude Code | Images typed first, waits until shown, then the message. | `core/attachments.test.ts` › "Claude Code is typed its images first…", "when Claude Code never shows the images, the message still goes…" | proven |
| Codex | Each image as one quoted path. | `core/attachments.test.ts` › "Codex is pasted each image as one quoted path, then the message" | proven |
| Own composer only | A message names only files waiting in its own composer. | `core/attachments.test.ts` › "a message can name only files that wait in its own composer" | proven |
| Talk to Wanigan | Files go inside one stream-json message. | `core/attachments.test.ts` › "Talk to Wanigan sends its files inside one stream-json message" | proven |
| Pick, paste, drop | The Attach dialog keeps the core's limits; paste and drop join the composer. | `main/picked.test.ts` › "the Attach dialog’s files are read in main, within the same limits the core keeps"; `scripts/ui-sweep.mjs` › "an image pasted and one dropped on the terminal did not both join the composer" | proven |

## Tokens

| Feature | The claim | Test | Status |
|---|---|---|---|
| A session's tokens | Re-read a replaced, shrunk or same-size timestamp-changed transcript; preserve existing append and per-reply counting semantics. | `core/tokens-freshness.test.ts` › six direct cases; `core/codex-hooks.test.ts` › real owner `sessions.tokens` and `cards.tokens` reads in both orders | fixed for observed device/inode/size/mtime/ctime changes; repeated reads refresh 100 to 250, append/incomplete/concurrent controls pass. Unchanged-all-metadata and prefix-rewrite-plus-growth freshness, real provider activity and renderer refresh remain unverified |
| Codex | Running totals per request, restarts and forks counted honestly, once under a race. | `shared/tokens.test.ts` › "Codex: …" (four tests); `core/tokens-race.test.ts` › "two concurrent token reads of a grown Codex rollout count it once" | proven |
| Gemini CLI | Counted from the chat file Gemini's own BeforeAgent hook names, read only inside Wanigan's Gemini home: each reply once by id (Gemini writes a reply again when its tool calls arrive), cached input apart, thoughts as output, tool-use prompt tokens as input, subagent chats in the total but never context; context is the latest request's prompt. A file named anywhere else is not read, and says so. | `shared/tokens.test.ts` › "Gemini: …" (three tests, against `core/fixtures/gemini-0.46-chat.jsonl`, written by Gemini CLI 0.46 itself with `--fake-responses`); `core/gemini.test.ts` › "Gemini’s tokens come from the chat file its own hook named, inside Wanigan’s Gemini home, and nowhere else" | added: the file's shape is the real CLI's; its numbers came from fake responses, so a real model's usage reporting is unverified |
| A card's tokens | Its conversations add up as one count, including refreshed transcript data without double-counting a resumed thread. | `shared/tokens.test.ts` › card conversation sum; `core/codex-hooks.test.ts` › both token owner RPC orders, repeated reads and resumed-thread deduplication | fixed for the two owned RPC fixtures; same metadata limits as session totals. No real account/provider or automatic renderer-refresh claim |

## Search, History and resume

| Feature | The claim | Test | Status |
|---|---|---|---|
| ⌘K | Projects, cards, sessions and commands, in groups, with key caps. | `shared/palette.test.ts` (five tests); `scripts/ui-sweep.mjs` › "no key caps", "the arrow keys did not reach the last group" | proven |
| What agents said | Session output searched in any case, escape codes gone, bounded and saying so. | `core/said.test.ts` (eight tests); `shared/said.test.ts` (seven tests); `scripts/ui-sweep.mjs` › "nothing an agent said was found" | proven |
| History | Claude/Codex conversations across configured accounts, newest first; complete search precedes the result limit. Request and retained-cache limits remain. Observed identity, edit and permission metadata changes invalidate retained results. | Existing History/cache/schema/resource-budget suites; `core/history-cache.test.ts` › six paired warm/cold owner reads: Claude/Codex × atomic replacement, in-place edit and chmod000; recovery and byte preservation | fixed for six controlled metadata cases; 35 including neighbors and combined typechecks pass. Existing provider-specific cold omission/refusal is preserved. No unchanged-all-stamps, ACL-without-metadata, live-WAL-replacement or renderer-event guarantee; logical budgets are not total CPU/heap control |
| Read | Text turns and tool-call summaries retain existing 300,000-character/2,000-turn bounds. Discovery refusal prevents choosing an earlier match from a partially inspected source set. Database/WAL copy admission checks pinned regular descriptors before copying. | Existing History/FIFO/streaming/read-only-db suites; `core/history-resource-budget.test.ts` › actual healthy rollout read then later-account budget refusal, preserved bytes and zero sessions | partial: logical aggregate input and materialization admission added; copy/query CPU time, transient overhead and atomic external-writer snapshots are not guaranteed |
| Resume from History | Continue by id in its own account, or Claude fork into another; paused projects and ambiguous IDs refuse. An over-budget later account also refuses before launch, even if an earlier match exists. | Existing History/schema/cache suites; `core/history-resource-budget.test.ts` › separate actual read/resume refusals with an earlier readable conversation and zero launched sessions | partial: owned budget/ambiguity outcomes pass; real-provider resume, every account form and same-stamp permission freshness remain unverified |

## Accounts, usage and limits

| Feature | The claim | Test | Status |
|---|---|---|---|
| Found on disk | Default account folders and recognized Claude/Codex alternate folders under a configured home retain their account identity; a missing CLI identity is unknown. | `core/core.test.ts`; `core/account-discovery.test.ts` › both separators, mixed/Unicode suffix labels, lookalike/empty/missing-marker negatives, exact stub-prober paths, stable IDs and unchanged fixture folders/files | proven for named fixtures with stand-in probes; no real CLI/account sign-in is tested |
| Per project | Each project picks its own account. | `core/core.test.ts` › "existing account folders are found…" | proven |
| Manage | Add, rename, make default, remove; removing leaves the folder; a project that used it falls back. | `core/core.test.ts` › "existing account folders are found…"; `core/accounts.test.ts` › "an account is renamed, made the default, and removed without touching its folder…" | added |
| Same login | Two folders on one login are flagged. | `core/accounts.test.ts` › "…two folders on one login are flagged" | added |
| Usage | Session and week limits per account, read from the CLIs; signed out is said, never a number. | `core/core.test.ts` › "existing account folders are found…"; `shared/usage.test.ts` (four tests) | proven |
| Continue on another account | Only to an account with room, never the same login. | `shared/limits.test.ts` › "a conversation moves only to an account with room, never to the same login"; `core/limits.test.ts` | proven |
| Against the real CLIs | Identity, usage and Codex's models read from the installed CLIs. | Their parsers, from real replies: `shared/usage.test.ts`, `shared/limits.test.ts` | manual: reading them runs the owner's real CLIs as the owner's real accounts |
| Sign in | A terminal for an account's sign-in. | The demo's refusal: `core/review2.test.ts` › "the demo signs nothing in and opens no terminal in the owner’s home" | manual: it runs the real CLI's login in the owner's home |

## Pause, decisions

| Feature | The claim | Test | Status |
|---|---|---|---|
| Pause | No new sessions or claims; live agents asked to wrap up; nothing running killed. | `core/core.test.ts` › "pausing a project blocks new work and asks live Claude sessions to wrap up"; `core/cli.test.ts` › "status: the agent’s card, what was sent back, what else it holds, Ready by priority, decisions, and a pause" | proven |
| Resume | New work allowed again. | `core/core.test.ts` › "pausing a project blocks new work…" | proven |
| Decisions | Recorded, edited and withdrawn; each session told those in force when it starts. | `core/board-rules.test.ts` › "each session is told the decisions as they stand when it starts: edited, withdrawn, Claude and Codex alike"; `core/cli.test.ts` › "decisions lists what is in force, and nothing withdrawn" | added |

## Jev

| Feature | The claim | Test | Status |
|---|---|---|---|
| Read | An Inbox card is read for action, severity and duplicates. Its text/criteria may contain entered code; the payload includes project name and at most five candidate keys/titles/statuses, without candidate descriptions, project files or transcripts. Action/duplicate probabilities must be finite numbers in [0, 1]. The panel states this boundary and keeps the accept-mode qualifier. | `core/jev.test.ts`, `shared/jev.test.ts`, `core/jev-review-proof.test.ts`, `shared/jev-probability.test.ts`; [actual Jev UI proof](reviews/2026-10-07/alpha11-feature-proof.md#selected-jev-before-and-after-images) › both themes/widths/read-accept modes | copy corrected; request/accounting behavior unchanged, actual UI with injected seeding, no real model-quality proof |
| Accept | Moves only an Inbox card with usable confidence at or above the acceptance threshold and matching assessed title, body, type, priority and criterion text. Invalid new or legacy probabilities cannot authorize acceptance or duplicate decisions. | `core/jev.test.ts`, `core/jev-races.test.ts`, `core/jev-review-proof.test.ts`; `core/jev-probability.test.ts` › nine real card outcomes with one accounted HTTP call; `shared/jev-probability.test.ts` › endpoint/threshold/legacy defenses | fixed impossible-confidence acceptance; owner-edit/threshold fixtures pass; existing accepted cards and historical display fields are not rewritten |
| Off and scoring | Off prevents new requests, queued reads and retries; an HTTP request already sent cannot be recalled. A card past triage is only scored. | `core/jev.test.ts` › "a card past triage is only scored; Off sends nothing"; `core/jev-races.test.ts` › "turning Jev off while two reads are in flight prevents queued cards being sent", "turning Jev off prevents a busy response from being retried" | fixed (queued reads and retries ignored a later Off choice) |
| The key | The core's alone, never sent back; forgetting removes it; no key, nothing sent. | `core/jev.test.ts` › "with no key, nothing is sent and the status says so", "a saved key is the core’s alone, and is never sent back", "forgetting the key removes it" | proven |
| Calls and cost | Every HTTP attempt counts. Only numeric nonnegative safe token integers contribute to the estimated subtotal; unknown successful usage keeps total cost unknown. Counts/subtotal survive pruning; legacy usage stays unknown. A refused key clears waiting reads while admitted work settles. | `core/jev-usage.test.ts`, existing Jev suites; `core/jev-review-proof.test.ts` › two admitted, three waiting, 401 refusal and explicit retry; `scripts/ui-regressions.mjs` › unknown/partial cost in both themes | fixed: focused core and both-theme renderer proofs pass; reported usage estimate is not a bill |
| Offline | The board never waits for Jev; the card says it was not read; Jev shows offline. | `core/jev-offline.test.ts` › "with TypeSafe out of reach, a card is filed at once, says Jev could not read it, and Jev shows offline" | added |
| Under a second | Typical response latency requires a real measurement; no sub-second guarantee is enforced. | none | manual: a real TypeSafe call with a real key |

## AI review, drafting, Talk to Wanigan

| Feature | The claim | Test | Status |
|---|---|---|---|
| AI review | Read-only tools, quotes checked against the files, advice only, a failure says why; a stop is recorded. | `core/core.test.ts` › "an AI review is read-only, checked against the files, and only advice"; `core/hardening.test.ts` › "an AI review cut short by a stop is recorded as failed, then and after a restart"; `core/review2.test.ts` › "AI review and drafting run with only the reading tools, and none of the account’s MCP servers" | proven |
| Draft with Claude | A card from a note, reading the project; nothing is created by the draft. | `core/core.test.ts` › "a card can be drafted from a rough note, and nothing is created by the draft"; `scripts/ui-sweep.mjs` › "Draft with Claude never filled the card" | proven |
| Talk to Wanigan | Nothing runs until sent; read-only in a project, no tools across projects; follow-ups continue; stop; owner only. | `core/chat.test.ts` (eleven tests) | proven |
| With a real model | Each of the three, run by the real `claude -p`. | Stand-ins only | manual: a real run spends a turn of the owner's plan |

## Skills and MCP

| Feature | The claim | Test | Status |
|---|---|---|---|
| Skills listed | Personal/project and supported Claude plugin sources retain existing containment rules. One complete operation admits at most 4,096 file attempts, 128 MiB of input/metadata, 32,768 structural items and 65,536 directory entries; exhaustion refuses instead of returning an earlier partial list. | `core/config-read-budget.test.ts`; existing plugin, limits and consent suites | partial: 17 focused/162 including neighbors and both types pass; malformed/permission peers and Codex built-in/plugin-cache exclusions covered. Both-theme refusal/recovery UI passes; full/native/CI pending; logical accounting is not parser/heap/CPU control |
| Copy and remove | Fresh discovery and destination checks share the operation budget before copy/removal. Alpha.13 content-bound approval and captured writes remain unchanged; same-size/mtime changes still require fresh approval. | `core/config-read-budget.test.ts`; `core/skills-copy-consent.test.ts` and existing Skills suites | partial: late discovery exhaustion blocks cached actions and recovers on the same Core; actual copy-race fixture now targets copy enumeration after discovery. Exact-content approval and ancestor refusal preserved; no atomic arbitrary-writer or rollback guarantee |
| MCP listed | Existing contained, bounded per-file reads share complete-operation limits for raw input, root metadata, all parsed structural items and directory entries, including ignored values. Exhaustion is a fixed refusal, while ordinary malformed/permission sources retain scoped notes and healthy peers. | `core/config-read-budget.test.ts`; existing MCP/plugin/schema/masking suites | partial: 17 focused/162 including neighbors and both types pass; Both-theme refusal/recovery UI passes; full/native/CI pending. No universal masking, parser-heap/SQL-CPU or atomic external-writer claim |
| The store | Twelve well-known servers, each with its source. | `core/mcp.test.ts` › "the store has twelve servers, each with its source" | proven |
| Add, remove, check | Deliberate MCP actions retain account CLI routing. Preflight exhaustion refuses before dispatch; post-command exhaustion explicitly reports that the command may have changed the file and verification is incomplete. | `core/config-read-budget.test.ts`; existing MCP pre/postcheck suites | partial: zero stand-in dispatch before preflight refusal, qualified late refusal and same-Core recovery tested. A refusal does not undo dispatched work; no actual provider/MCP-network operation |
| A server that needs a key | Finished in a terminal, never handed to Wanigan, no record kept. | `core/mcp.test.ts` › "a key, or a Codex browser sign-in, is finished by the owner in a terminal"; `core/review2.test.ts` › "a terminal a key may be typed into keeps no record once it closes" | proven |
| The owner's | A session cannot list, read, copy, remove, add or check. | `core/skills.test.ts` › "skills are the owner’s…"; `core/mcp.test.ts` › "MCP is the owner’s…" | proven |

## Pull requests

| Feature | The claim | Test | Status |
|---|---|---|---|
| Open a pull request | Only an approved card's branch, after a plan that shows what goes where. Known preconditions are checked before pushing; a later GitHub failure can still leave the branch pushed. | `core/pull-request.test.ts` › "an approved card’s branch is pushed and its pull request opened, after every refusal that applies"; `scripts/ui-sweep.mjs` › "the pull request plan never showed" | proven |
| To GitHub | Pushed and opened with the owner's `gh`. | A stand-in `gh` only | manual: a real push and pull request |

## Live view

Verified by hand against the owner's own local sites (Drupal 11; WordPress) on 9 Oct 2026: the
real app driven with Playwright, every step a whole-window screenshot. The UI sweeps do not reach it: their bridge has
no view to lay over the page, and nothing there serves a site.

| Feature | The claim | Test | Status |
|---|---|---|---|
| Off until switched on | Settings › Live view; Drupal, WordPress and other sites each on or off; switching it off takes the view away. | `main/awake.test.ts` › settings validation; the owner's Drupal site by hand | added |
| Finding the site | From `.ddev` (overrides in order), `wp-config.php`, a dev script or `.lando.yml`; nothing started, nothing reached. | `core/live.test.ts` › "a ddev Drupal site is found…", "a WordPress site is found…"; `shared/live.test.ts` › ddev configs | added |
| Certificates | Only one issued by this Mac's mkcert authority for the site's host is trusted beyond Chromium's own verdict. | the owner's Drupal site by hand (mkcert not in the Keychain) | manual (a native session handler) |
| Edits followed | Every file an edit names, Codex's patches included; a reload once quiet, longer for Sass and PHP (opcache); stylesheets swapped in place. | `shared/edits.test.ts`; `core/live.test.ts` › "an agent’s edits, turns and start reach the live view…" | added |
| What made each part | Twig debug's BEGIN/END, suggestions and component start/end comments, data-component-id, the helpers' marks, Elementor's attributes, nested by containment, in page order. | `shared/live-names.test.ts` (8 tests); `shared/live-tree.test.ts` (6 tests); 83 to 115 regions on the owner's Drupal site, 12 on the WordPress site | added |
| Overrides | A contrib or core template names the more specific file to create in the owner's theme. | `shared/live-names.test.ts` › "an override…" | added |
| A component's props | Each top-level prop of its .component.yml: name, type (a theme's own types too), title, required; nothing nested, any indent width. | `shared/live.test.ts` › "a component’s props…" | added |
| Words saved by hand | Saved to the owner's own template only when written there exactly once; contrib, core, two matches and Twig strings with quotes refused; a revert only while the file is as the edit left it. | `core/live.test.ts` › "words changed by hand" (3 tests) | added |
| Fields saved by hand | A plain text field through the Drupal helper, as the user logged in in the view, as a new revision; formatted fields refused. | the owner's Drupal site by hand (a term's name saved and put back) | manual (needs a running Drupal) |
| The Drupal helper | Plan shown first; module folder kept out of git; ddev drush install; Twig development mode with the previous values kept in Drupal's state; removal puts them back. | `core/live.test.ts` › "the Drupal helper, before anything is written" (3 tests); the owner's Drupal site end to end by hand | partial (install and removal need ddev) |
| The WordPress helper | One must-use plugin file with its token, kept out of git, runs nothing; removal deletes it. | the owner's WordPress site end to end by hand | manual (needs a running WordPress) |
| Content changes followed | The helper's count of cache tag invalidations (Drupal) or content saves (WordPress) reloads the view; a site that keeps changing stops it. | the owner's sites by hand (drush, wp-cli) | manual |
| Before and after | A session's first before, its last after, a card's newest twelve; full page at 1440 CSS pixels, past the browser's cache; changed areas boxed. | `core/live.test.ts` › "a card’s before and after" (2 tests); a renamed term found as one area | partial (the capture needs a window) |
| Not on phones | A phone's stream carries no live view edits, site settings, hand edits or screenshots. | `core/phone/gateway-sse-safety.test.ts` › "a phone stream carries board news but never the live view’s…" | added |

## The demo

| Feature | The claim | Test | Status |
|---|---|---|---|
| Its own world | Sample projects, stand-in agents, its own data; nothing real touched and no model called. | `core/demo.test.ts` › "the demo runs on stand-ins kept in its own folder, and nothing it starts or reads is the owner’s" | fixed (choosing Codex started the owner's own Codex to list models) |
| Its refusals | It signs nothing in and opens no terminal in the owner's home. | `core/review2.test.ts` › "the demo signs nothing in and opens no terminal in the owner’s home"; `core/demo.test.ts` | proven |
| Help › Open the Demo | A second instance beside the owner's. | none | manual: the menu and the second instance exist only in the running app |

## The `wanigan` command

| Feature | The claim | Test | Status |
|---|---|---|---|
| On every session's PATH | Acting as that session, only inside its project. | `core/cli.test.ts` (every test); `core/access.test.ts` › "everything a session may touch is in its own project" | proven |
| `wanigan status` | Its card, cards sent back to it, others it holds, the top of Ready by priority, decisions, a pause. | `core/cli.test.ts` › "status: …"; `core/core.test.ts` › "an agent claims, notes and submits…" | fixed (a card it held was hidden once it had released its own) |
| `wanigan claim` | Takes a card; refused from the Inbox, while paused, or held by another. | `core/cli.test.ts` › "claim, note and release…", "file: …", "status: …" | proven |
| `wanigan note` | A comment that renews the claim; refused without one. | `core/cli.test.ts` › "claim, note and release…" | added |
| `wanigan review` | Evidence as a file, a URL or a sentence; none is refused. | `core/cli.test.ts` › "review: …"; `core/core.test.ts` › "an agent claims, notes and submits…" | proven |
| `wanigan file` | Into the Inbox with type, body and priority; a wrong type is refused. | `core/cli.test.ts` › "file: …" | added |
| `wanigan ask` | Raises Needs you; the owner's reply lands on the card. | `core/cli.test.ts` › "ask: …" | added |
| `wanigan release` | Gives a card back. | `core/cli.test.ts` › "claim, note and release…" | added |
| `list`, `show`, `criteria`, `decisions`, `--json`, help | Read the board; add a criterion; unknown commands exit 2. | `core/cli.test.ts` › "help lists every command…", "list and show read the board…", "ask: …", "decisions lists what is in force…" | added |
| Outside a session | It is the owner: it reads a card; an agent's command is refused by name. | `core/cli.test.ts` › "outside a session it is the owner…" | fixed ("not available to a owner") |

## Access, identity and storage

| Feature | The claim | Test | Status |
|---|---|---|---|
| One table of who may call what | Every method in ACCESS is refused to the role it is not for; nothing outside it exists. | `core/access.test.ts` › "a session can call only what ACCESS gives it, and the owner nothing that is only an agent’s" | added |
| A session is its token | Confined to its own project; another project's card is refused for every method. | `core/access.test.ts` › "everything a session may touch is in its own project"; `core/core.test.ts` › "a session is confined to its project and cannot approve" | added |
| An ended session | Keeps its token, can read the board, cannot change it. | `core/access.test.ts` › "a session that has ended keeps its token but can only read the board" | added |
| Tokens and files | A session token kept only as its hash; owner token, sockets and data folder the owner's alone (0600/0700); a session is not told where the data is. | `core/access.test.ts` › "a session token is kept only as its hash…"; `core/hardening.test.ts` › "a late hook does not rewrite how a session ended; a session is not told where the data is"; `core/core.test.ts` › "a wrong token is refused" | added |
| Hooks | Hook events arrive on their own socket and call no methods; an unknown token changes nothing. | `core/core.test.ts` › "hook events drive state…" | corrected (design listed `hook` as a role in the method map) |
| Migrations | Additive upgrades retain all 21 published SQL strings. The schema-11 upgrade fixture is a frozen independent export of published alpha.15 rather than rebuilt from the current migration array. | `core/db-upgrade.test.ts`; `core/fixtures/schema-11-alpha15.sql` | partial: six tests pass; an intentional shipped-SQL mutation fails the digest assertion. Production db.ts/migrations unchanged; no real owner-store or new corruption/recovery claim |
| Storage refusals | A database Wanigan 2 did not create, one from a newer Wanigan, or another store, is refused untouched. | `core/core.test.ts` › "a database Wanigan 2 did not create is refused, not adopted"; `core/db-upgrade.test.ts` › "a database from a newer Wanigan, or marked as another store, is refused and left untouched" | added |
| Tests stay local | No test reads the owner's home, accounts, Jev key or data, or spends. | `core/jev-offline.test.ts` › "a test core never finds the owner’s Jev key" | fixed (a test core read `TYPESAFE_API_KEY` from the login shell, and a replaced account prober also replaced the home folder) |
| The core's idle exit | It shuts itself down only when nothing is live and no window has connected for ten minutes; a pending Jev key lookup counts as work. | `core/jev-races.test.ts` › "a Jev read is busy while its key is being checked…" (pending-work boundary only) | manual: a ten-minute timer in the daemon's entry, with no seam to shorten it |
| The bridge | Main forwards only the owner's methods to the window. | Built from ACCESS (`src/main/index.ts`); the app smoke exercises it | manual: needs the Electron window (`npm run smoke:app`) |

## Interface

| Feature | The claim | Test | Status |
|---|---|---|---|
| Seeded routes in both themes | Listed routes at 1440×900 use real seeded data and check errors, malformed text, page overflow and loading. Selected narrow routes run at 1024×700 in dark only. | `scripts/ui-sweep.mjs` › every route in `routes`, light and dark | proven |
| The rail | Folds to icons with ⌘\\ or on its own when narrow; remembered. | `shared/rail.test.ts` (three tests); `main/menu.test.ts` › "the View menu shows or hides the sidebar with ⌘\\"; `scripts/ui-sweep.mjs` › "⌘\\ did not fold the rail" | proven |
| Keys and menus | One table for keys, menus and the sheet; ⌘K never taken from a terminal by Control. Targeted confirmation and paused-session dialogs take focus, contain Tab and restore focus on Escape. | `shared/shortcuts.test.ts` (eleven tests); `main/menu.test.ts` (four tests); `scripts/ui-sweep.mjs` › "Control-K was taken from the terminal", "the confirmation did not take keyboard focus", "a disabled preferred control left focus outside the dialog", "Escape did not restore focus" | fixed (text-only dialogs and disabled preferred controls could leave keyboard focus behind the modal) |
| Window titles | Say where you are, the app last. | `shared/shortcuts.test.ts` › "the window title says where you are, the app last" | proven |
| Since you last looked | What agents did since, counted, one line. | `shared/since.test.ts` (three tests); `scripts/ui-sweep.mjs` › "no line of what changed" | proven |
| Errors | A view that throws shows its crash panel and the rest stays; an error toast stays until dismissed and offers Retry. | `scripts/ui-sweep.mjs` › "a throwing view did not show the crash panel", "Retry did not send the message" | proven |
| The water orb | Swirls while thinking, a fire whirl on failure, a blue flame on recovery, a celebration when clear; motion reduced is respected. | `renderer/src/orb/choreography.test.ts` (twelve tests) | proven |
| The orb on a real GPU | A disposed mount cannot configure or release a replacement’s context, or publish readiness after its completed frame is delivered late. | Five actual native lifecycle cases and healthy controls recorded in the [alpha.16 proof](reviews/2026-10-07/alpha16-feature-proof.md); `scripts/orb-probe.mjs` records animation frames | measured: pristine 2 pass/3 fail, corrected 5 pass on one Chromium/Apple Metal adapter. No numerical 1/255 reference comparison, whole-React or all-GPU claim |
| Showcase never amber | Screenshots for posts refuse Wanigan in amber. | `scripts/showcase.mjs` | manual: the packaged app on a real GPU |
| Release links | The README download and source clone select the packaged version. | `main/release-links.test.ts` › "the README download and source clone select the packaged version" | fixed |
| Packaging | `npm run dist:mac` restores source package metadata and attempts native dependency restoration after packaging. A failed/missing/signaled restoration cannot report success after a successful package; prior packaging failure remains a failure. | `main/dist-mac.test.ts` › nine executable-stand-in outcomes; `scripts/app-smoke.mjs --app …` remains the native gate | wrapper focused proof and actual alpha.11 packaging/post-package source smoke/app/ZIP/DMG checks passed; ad-hoc signature integrity, not notarization |
| Secret scanning | No secrets in any branch's history. | `gitleaks git . --log-opts=--all` | manual: an external tool, not part of `npm test` |

## Audit regressions

| Feature | The claim | Test | Status |
|---|---|---|---|
| Bounded protocol input | Core and client reject oversized unfinished authentication lines; line limits span fragments, and one connection has at most 128 active RPC handlers. | `core/server.test.ts` › "the core closes an oversized unfinished authentication line promptly", "one connection cannot queue an unbounded number of active core requests"; `client/client.test.ts` › "an oversized unfinished handshake is refused before buffering arbitrary peer output"; `shared/line-reader.test.ts` | fixed |
| Drafts during sends | Completing an earlier comment, criterion, session message or chat send does not clear text edited while it waited, even when the replacement text matches the original. | `scripts/ui-regressions.mjs` › comment/criterion/session/chat-next-draft and retyped-draft, both themes | fixed |
| Git read failures | Failed/malformed counts, published history, stash and staged reads refuse. Unreadable untracked reads also refuse; oversized/link workbench notes are not a successful empty patch. Original state survives and valid retries work. | `core/git-read-failures.test.ts`, `core/commit-message-read-failure.test.ts`, `core/git-untracked-read.test.ts` | fixed for named reads and owned fixtures; 61-case component suite including seven new cases passes; full/native/CI pending |
| Socket resource bounds | Existing connection/RPC/output admission remains. Hook reply strings add a 64 MiB UTF-8 check after production and before any response frame prefix; excess destroys that owned socket without partial framing. | `core/hook-output.test.ts`, `core/hook-framing.test.ts`; existing socket tests | partial: four focused/nine framing cases and combined90 pass; exact byte boundary, multibyte, no-prefix and recovery covered. Producer string allocation and total process memory are outside this bound |
| Session admission during shutdown | The existing synchronous barrier refuses preparing/fresh starts before awaited Phone close and drains existing children normally. Candidate Core startup cancellation refuses late readiness/timers and retains native bind ownership until close before releasing the store. | Existing `core/session-shutdown-admission.test.ts`, `core/session-safety.test.ts`; `core/core-start-stop.test.ts` › four held-start/native-bind cases; candidate 33-test lifecycle group and source-native smoke | existing admission evidence preserved; candidate focused/source-native pass, full/native passed; exact-commit CI/publication pending. No daemon-crash, repeated-start or new native-bind deadline guarantee |
| Missing worktree on resume | Resume refuses when the conversation's worktree is gone rather than redirecting it to the main checkout. | `core/session-safety.test.ts` › "resuming a removed worktree refuses instead of moving its conversation to the main checkout" | fixed |
| Terminal replay focus | Delayed first replay preserves the focused composer and its draft; initial replay may focus an otherwise unfocused terminal. | `scripts/ui-regressions.mjs` › `terminal-late-replay-keeps-composer-focus`, `terminal-late-replay-initial-focus`, both themes | fixed |
| Checkpoint read errors | Failed checkpoint reads remove stale timeline/panel/open-confirmation actions; failed cached turn-change reads disable confirmation. Recovery restores real data/actions without an Undo/Redo request during failure. | `scripts/ui-regressions.mjs` › `checkpoint-read-error`, `checkpoint-cached-undo-read-error`, `checkpoint-cached-redo-read-error`, `undo-dialog-cached-diff-error`, both themes | fixed cached-diff confirmation; focused browser proof passes. Redo display and reconnect notification are controlled stand-ins; guard-mutant status is recorded in the addendum |
| Visible focus and radio keys | Primary-button and selected-radio focus have a painted outline; segmented choices support arrows, Home and End. | `scripts/ui-regressions.mjs` › `keyboard-focus-visible`, `segmented-keyboard`, both themes; transparent-outline mutation rejected | fixed; selected controls, not every focusable element |
| Crawler target identity | A replaced control must be unambiguous; removed targets, old siblings and ambiguous replacements are not clicked as the original. | `scripts/ui-regressions.mjs` › crawler replacement, neighbor, ambiguity and reload cases, both themes | fixed; generic click success still does not prove label semantics |
| Bounded HTTP bodies | Jev stops oversized success/error replies at a 1-MiB application buffer limit; update replies retain a shared 2-MiB page budget. Oversized declared lengths are refused before pulling, and over-limit streams are cancelled. | `core/jev-response.test.ts` › chunked 200/401/429 and oversized Content-Length; `main/updates.test.ts` › oversized chunked releases and pagination budgets | fixed; synthetic HTTP streams, not a real service or transport-memory measurement |
| Explicit push scope | Workbench and card-PR publication disable implicit annotated-tag following and submodule pushes, regardless of repository configuration; existing tags and local dependency work stay intact. | `core/git-push-scope.test.ts` › workbench/card-PR × annotated tag/submodule commit, four actual-Git fixtures | fixed; temporary bare remotes and stand-in gh; arbitrary repository hooks remain outside this scope |

| Client cleanup and admission | Serialization refusal preserves the connection; write failure/EOF clears pending work and closes transport. Admit at most 128 pending calls, role-sized JSON bodies and 64 MiB of queued UTF-8 wire bytes. Local limit refusal sends nothing and preserves accepted calls and later recovery. | `client/client-send-failure.test.ts`, `client/client.test.ts`, `client/client-admission.test.ts` › real sockets, reentrant serialization, exact role limits, byte accounting, unsent refusal and drain/reply recovery | fixed; body caps count UTF-16 code units, queue cap counts bytes. Injected exact queue edge and attachment-size arithmetic are not an RSS or attachment end-to-end proof |
| Hook body parsing | Fragmented hook frames are scanned once with bounded copying and one completed-frame parse; relay replies do not require sender EOF. Existing total connection cap includes post-reply bytes. | `core/hook-framing.test.ts`, `shared/hook-reader.test.ts`; delayed-body/deadline neighbors; post-reply-cap mutant rejected | fixed for measured frames and compatibility fixtures; legacy malformed EOF/scalar/numeric-prefix behavior preserved |

## Coverage limits

The crawler (`scripts/ui-crawl.mjs`) explores controls in the seeded demo with
bounded depth. Its generic success check accepts a core call, changed DOM,
changed focus or navigation; it does not prove that every label performed the
correct operation. The sweep supplies explicit outcome assertions for selected
workflows, including initial focus, Tab containment and Escape restoration for
selected dialogs in both themes. Neither script performs comprehensive Tab
traversal or visible-focus checks on every control. The Board sweep now checks
four real browser drag/cancel gestures per theme; the separate six-drop proof
checks stored order and naturally settled images. These do not establish native
Electron drag or every filter/sort combination. The automated narrow sweep remains 1024px in dark; the independent review adds
manual 960px checks in both themes. These establish the checked screens, not
a blanket accessibility or narrow-window pass.

## Totals

| Coverage | Rows |
|---|---|
| Features and rules | 266 |

The statuses describe the evidence attached to each row. Historical test-count
snapshots are omitted because they drift as regressions are added.

A manual row is manual for one of these reasons: a native macOS surface (the
notifications, the dock badge, the quit dialog, the demo's menu item, the bridge
behind the window); a real call that spends (`claude -p`, TypeSafe, GitHub); the
owner's real CLIs and accounts (sign-in, identity, usage, Codex's models and its
hook probe); a real GPU or a packaged app (the orb, the showcase, packaging); a
timer with no seam (the core's ten-minute idle exit); a tool outside `npm test`
(gitleaks). The Board row separately bounds its new automated mouse coverage.

## Alpha.13 CI correction checkpoint — 2026-10-08

This checkpoint follows the historical candidate statements above and changes no
feature row. The original alpha.13 commit
`a06d11ab1d342534a40643ac943d27f02525a8fe` passed the local full gate:
985/985 units, desktop and Phone sweeps, 72 targeted cases, and a crawler with
1,428 passes, zero failures and 368 controls gone before their turn. The actual
npm and durable supervisor exits were zero. The gone controls remain a coverage
gap; this is evidence for the original commit.

Its codex-review CI run `37816570156` failed while looking for the merge-conflict
UI after 985 units passed. A controlled probe in both themes demonstrated that
rapid close/reopen hash changes can retain a drawer with stale fixture data.
Waiting for actual drawer detachment before reopening satisfies the unchanged
conflict and resolution assertions. The probe's expected five-second action
timeout is asserted inside a successful diagnostic run; it is not a failing
full-suite execution or a reconstruction of the original CI event order.

The selected correction changes only the UI sweep's fixture sequencing and
prerequisite diagnostics. Its corrected full gate, new exact-commit CI on both
branches, fresh native/package checks, release and website update remain
pending. The [appended evidence](reviews/2026-10-07/continued-audit.md#alpha13-ci-fixture-correction-and-controlled-proof)
preserves the original failure and the narrower controlled proof. No production
feature or audit-completion claim follows from this test correction.
