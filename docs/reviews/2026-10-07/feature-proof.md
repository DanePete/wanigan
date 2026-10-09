# Independent Wanigan 2 feature proof audit — 7 October 2026

All 192 rows in the original `docs/features.md` at alpha.1 (`0ec5ac3ad48c3ca0e723f2b2dafe6707eea50437`) are accounted for below. Row numbers, source lines and assessments refer to that baseline; the later 213-row matrix is reviewed in [the current addendum](current-feature-proof.md). All referenced test files exist. Referenced test names resolve after curly-quote/ellipsis normalization except harmless wording drift in the J/K/V sweep message and escaped sidebar shortcut. The audit reads assertions and their fixtures; **supported** means the named tests contain meaningful outcome assertions for the stated scope, not a proof against every adversary or confirmation of a real model/native surface. Test executions are reported separately by the coordinating reviewer.

**Statuses:** supported = meaningful outcome proof for documented fixture; partial = meaningful test but a stated qualifier is not covered or overbroad; false claim = code/test contradicts the statement; unverified = explicitly manual or not exercised here. Tests use fake homes/stand-ins/local HTTP only; this agent never accesses either real Wanigan data directory.

## Original findings and proof gaps

These describe the baseline before the coordinated fixes. Later fixes and targeted UI checks are recorded in [the consolidated report](README.md); this historical matrix is not an assertion that those defects remain.

- Jev's queued work ignores a newly selected Off mode, and Accept uses pre-request criteria. The normal happy-path tests miss both races. The coordinated review fixes these races; see [Jev findings](jev-and-skills.md).
- Jev does not record each retry attempt, and older call totals disappear with retention; its test only asserts positive aggregate numbers.
- Skills intentionally excludes built-ins and Codex plugins, contrary to the matrix/README's universal claim. Jev payload includes project name and possible duplicates, not only the current card.
- The crawler can pass a button after any core call, focus movement or DOM mutation; a wrong operation can satisfy that oracle. It is useful broad smoke coverage, not semantic proof of every label.
- No mouse board-drag test exists in either UI script despite the matrix assigning it to the crawler. No comprehensive Tab traversal or visible-focus test exists. Narrow testing is dark-only1024px rather than both themes at the960px minimum.
- Feature matrix predates the git workbench: commit/stage/stash/branch/push/pull/conflict controls have tests but no individual rows here. The corrected feature matrix adds 13 git rows; see [git findings](git-and-checkpoints.md).
- Shipped migration immutability is not tested: schema11 fixture is rebuilt from current migration strings.

## Row-by-row proof matrix

| # / source line | Area / feature | Assessment | What the assertions actually establish / limitation |
|---|---|---|---|
| 1 / docs/features.md:29 | Projects / Open a project | supported | Asserts generated key/name, repeated-path same id, missing-path rejection; pure test checks collisions. |
| 2 / docs/features.md:30 | Projects / Nothing written into a project | partial | Hashes project files before/after Claude+shell and attachment flow; separate checkpoint test checks index bytes. No Codex launch in this test, and snapshot excludes .git/index (covered separately). |
| 3 / docs/features.md:31 | Projects / Change a project's key | supported | Asserts all fetched card keys and next sequence after rename; duplicate and invalid project keys reject. |
| 4 / docs/features.md:32 | Projects / Close a project | supported | Refuses archive with a live PTY, hides project/needs/search after stop, and reopens same project id and card state. |
| 5 / docs/features.md:33 | Projects / Wanigan 1's projects offered | intentionally removed | Synthetic Wanigan1 DB proves suggestion filtering; foreign-DB test checks sidecar bytes and uncheckpointed WAL visibility. Never uses real Wanigan1 data. |
| 6 / docs/features.md:34 | Projects / Folders the agents worked in | supported | Synthetic conversation trees check 30-day counts/order, canonicalized folders, record/session limits and cut notices. |
| 7 / docs/features.md:35 | Projects / Activity | supported | Asserts exact actor/verb sequence for create/start/claim/comment/release/exit plus per-project/card filtering. |
| 8 / docs/features.md:41 | Cards and the board / Card types | supported | Edits valid types and rejects epic; CLI file validates type. Does not exhaustively create all four types in one test. |
| 9 / docs/features.md:42 | Cards and the board / Agents file into the Inbox | supported | Session passes another status/project but resulting card is its own Inbox; CLI test checks priority and ownership. |
| 10 / docs/features.md:43 | Cards and the board / Agents can't claim from the Inbox | supported | Session claim rejects Inbox; owner start takes card and changes state/claim. |
| 11 / docs/features.md:44 | Cards and the board / The owner accepts from the Inbox | supported | Core verifies owner-start acceptance; sweep checks A-key transition and animation end state. |
| 12 / docs/features.md:45 | Cards and the board / No dragging into Working | supported | Real owner API refuses Working and pure rule forbids Done escape. |
| 13 / docs/features.md:46 | Cards and the board / Review needs evidence | supported | Both API and real shim reject evidence-free review; accepted file/link/note persists and Review state is asserted. |
| 14 / docs/features.md:47 | Cards and the board / Only the owner approves | supported | Session token approval rejects explicitly, in addition to ACCESS-wide role rejection. |
| 15 / docs/features.md:48 | Cards and the board / Approve, send back, reopen gates | supported | Wrong source columns reject, valid approval clears sentBack/reopened, reopen adds criterion. |
| 16 / docs/features.md:49 | Cards and the board / Send back | supported | Round trip through real CLI submits; owner sendBack persists note and Ready/flag; agent status sees it. |
| 17 / docs/features.md:50 | Cards and the board / Reopen as not fixed | supported | Done->Ready and reopened flag asserted; criterion text is asserted on detailed card. |
| 18 / docs/features.md:51 | Cards and the board / Archive | supported | Archive disappears from board/counts/search; session claims and owner launches reject before new session appears; restore unsupported. |
| 19 / docs/features.md:52 | Cards and the board / Ranks | supported | Real repeated between-neighbor insertions assert unique ranks and exact order; new card rank is below prior top. |
| 20 / docs/features.md:53 | Cards and the board / Priorities | supported | CLI output compares Ready order by priority; invalid P4 API update rejects. |
| 21 / docs/features.md:54 | Cards and the board / What a card shows | partial | Core verifies priority/statusAt/holder/live state; does not alone prove the card renders every field. Sweep visual inspection remains relevant. |
| 22 / docs/features.md:55 | Cards and the board / Edit a card | supported | Asserts edited fields, activity detail and stable rank/statusAt; blank title/invalid enum/priority reject. |
| 23 / docs/features.md:56 | Cards and the board / Criteria | supported | Owner edits/ticks/removes persisted criteria; session may add only on an eligible card and cannot tick/remove. |
| 24 / docs/features.md:57 | Cards and the board / Questions | supported | CLI question creates Needs row; owner's comment closes it; closed-card question suppressed. |
| 25 / docs/features.md:58 | Cards and the board / Cards across projects | partial | Named search test only asserts one project's title/key and literal percent, not description matching or positive hits from two projects. Implementation query is global; test would miss description regression. |
| 26 / docs/features.md:59 | Cards and the board / How this works | supported | Sweep opens explainer and checks its Review box routes to that column. Counts are seeded DOM checks, not exhaustive arithmetic. |
| 27 / docs/features.md:60 | Cards and the board / Board keys | supported | Sweep checks card focus movement and Inbox A/X flow; shortcut table tests match handlers. |
| 28 / docs/features.md:61 | Cards and the board / Drag between columns | unverified | Neither ui-sweep nor ui-crawl contains drag/dragTo/mouse gesture coverage. Matrix's promise that crawler covers mouse drag is stale. |
| 29 / docs/features.md:62 | Cards and the board / List view | supported | Both-theme route loop waits for actual table rows and checks overflow/error/loading state. |
| 30 / docs/features.md:68 | Claims and leases / Claim | supported | Started-on-card claim and real wanigan claim both assert resulting session/card identity. |
| 31 / docs/features.md:69 | Claims and leases / Lease | supported | Clock advance crosses lease duration; live-set sweep renews, empty live-set sweep frees Ready. |
| 32 / docs/features.md:70 | Claims and leases / Sleep | supported | Clock jumps while PTY lives; renewed expiry and claimant retained. |
| 33 / docs/features.md:71 | Claims and leases / One claimant | supported | Second token cannot claim after sleep while first worker lives; board state still names first. |
| 34 / docs/features.md:72 | Claims and leases / Note | supported | Real CLI note persists author/body and extends lease using fake clock. |
| 35 / docs/features.md:73 | Claims and leases / Release | supported | Real CLI release asserts Ready, null claim and actor activity. |
| 36 / docs/features.md:74 | Claims and leases / Released on exit | supported | Stop releases held card to Ready and persists release activity; subsequent mutation with token rejects. |
| 37 / docs/features.md:75 | Claims and leases / Hand-over | supported | Continue-on test asserts new claimant and no intermediate release event. |
| 38 / docs/features.md:81 | Sessions / Start | supported | Real PTY launch exercises providers; concurrent starts yield one fulfilled and one rejected, exactly one card session. |
| 39 / docs/features.md:82 | Sessions / Stop | supported | Owner stop is ended/Stopped and card becomes Ready; unsolicited signal has separate failed path. |
| 40 / docs/features.md:83 | Sessions / Survive the window | supported | Detached core PID survives CoreConnection.close; second connection sees same session and replay and accepts new terminal input. Actual native quit additionally needs app smoke. |
| 41 / docs/features.md:84 | Sessions / A session that fails | supported | SIGKILL becomes failed with signal detail and need; shell exit 3 becomes failed with exit detail. |
| 42 / docs/features.md:85 | Sessions / Interrupted | supported | Kills detached core, reconnects to new PID, asserts interrupted session, freed card and Needs row. Does not by itself prove killed agent child is gone. |
| 43 / docs/features.md:86 | Sessions / Resume | supported | Resume argv/account/card/cwd retained; saved conversation required; running and duplicate concurrent resume refused. |
| 44 / docs/features.md:87 | Sessions / Continue on another account | supported | Uses saved fixture transcript and other account, asserts fork id/argv and transferred claim. |
| 45 / docs/features.md:88 | Sessions / Rename | supported | Rename trims and validates, and new title appears in Needs and search. |
| 46 / docs/features.md:89 | Sessions / Promote | supported | Promotion preserves session event sequence/history and assigns claim only while live; ended promotion stays Ready. |
| 47 / docs/features.md:90 | Sessions / Attach | supported | Attach validates project, sets worker/claim for running session, leaves ended session historical; occupied-card refusal covered separately. |
| 48 / docs/features.md:91 | Sessions / Queue and deliver | partial | Tests prove wait-until-idle and bracketed paste bytes, not readiness at an initial trust prompt; dedicated claude-first-message/codex tests are needed for that boundary. |
| 49 / docs/features.md:92 | Sessions / Ephemeral | supported | Ephemeral output file absent, replay empty after stop; crash/search regression checks no persisted key marker. |
| 50 / docs/features.md:93 | Sessions / Remote Control | partial | Asserts opt-in argv, named argument, Claude-only validation and resume persistence. Does not prove real remote connectivity; README says unverified live. |
| 51 / docs/features.md:94 | Sessions / Model and effort | partial | Named test checks argv and recorded model/effort but does not resume. Codex hook resume test supplies missing persistence coverage; real model acceptance unverified. |
| 52 / docs/features.md:95 | Sessions / Named after the card | partial | Checks --name/argv; proves CLI was asked to name conversation, not that real Claude picker/title displays it. |
| 53 / docs/features.md:96 | Sessions / Terminal record | supported | Sequence ids observed and 12.5MB ASCII stream leaves <=2MB memory and <=8MB disk with newest chunk. Multi-byte/single giant chunks need separate coverage. |
| 54 / docs/features.md:97 | Sessions / Watch | supported | Pure ordering/pinning cap tests plus actual PTY-size observation; sweep spies resize calls and verifies sizes unchanged across watching. |
| 55 / docs/features.md:98 | Sessions / Overlap | supported | Two live same-folder editors raise overlap and stop clears it; not a filesystem-level proof of all agent writes. |
| 56 / docs/features.md:99 | Sessions / Chatter | supported | Relayed tool emits sender/recipient/label; database JSON and DOM exclude secret-body marker. |
| 57 / docs/features.md:100 | Sessions / Timeline as turns | supported | Pure event sequence becomes expected turns/tools/files/permissions; renderer placement covered only by seeded sweep. |
| 58 / docs/features.md:106 | Hooks, Codex and the briefing / Claude hooks | supported | Real relay receives injected hooks and split/slow body; state/Needs/briefing outcomes asserted. |
| 59 / docs/features.md:107 | Hooks, Codex and the briefing / Permission stands | supported | Idle notifications cannot clear pending permission; PostToolUse does. Covers one answered request semantics. |
| 60 / docs/features.md:108 | Hooks, Codex and the briefing / Late hooks | supported | Late hook cannot replace ended state's activity/state. |
| 61 / docs/features.md:109 | Hooks, Codex and the briefing / Briefing | supported | Actual relay response contains card/decision briefing; Codex launch argv contains edited decisions and excludes withdrawn ones. |
| 62 / docs/features.md:110 | Hooks, Codex and the briefing / Codex by OSC 9 | supported | Stand-in OSC stream drives waiting/permission/working; partial sequences bounded; empty Enter and slash commands do not create turns. |
| 63 / docs/features.md:111 | Hooks, Codex and the briefing / Codex hooks | supported | App-server stand-in enumerates hooks/hashes; all must trust; wrong/missing/modified hooks fall back and persist reason. |
| 64 / docs/features.md:112 | Hooks, Codex and the briefing / Codex thread | supported | Real relay supplies thread, synthetic rollout yields token count, fake Codex DB links History, resume argv contains thread/model/effort. |
| 65 / docs/features.md:113 | Hooks, Codex and the briefing / A shell's states | supported | Shell nonzero exit asserts code and failed need; Claude limit fixture shows limited is a separate state. Tests are appropriately separate providers. |
| 66 / docs/features.md:114 | Hooks, Codex and the briefing / Codex hooks against a new Codex | unverified | Installed Codex hook probe not run by unit suite; no real-model proof inferred. |
| 67 / docs/features.md:120 | Needs you / Permission | supported | Byte-for-byte asks preserved in core; pure hidden-character cases and both-theme DOM display test U+200B. |
| 68 / docs/features.md:121 | Needs you / Review | supported | Seen does not clear Review; sendBack/approve do. |
| 69 / docs/features.md:122 | Needs you / Question | supported | Agent question survives seen; owner comment clears it. |
| 70 / docs/features.md:123 | Needs you / Failed | supported | Failure need includes resumability from known id, clears on seen and after fake-clock three days; real saved-history validation occurs when resuming. |
| 71 / docs/features.md:124 | Needs you / Interrupted | supported | Crash integration asserts interrupted need and then clears it with seen. |
| 72 / docs/features.md:125 | Needs you / Usage limit | supported | Limit fixture records reset/account, remains limited across idle and clears/reappears per seen/reset semantics. |
| 73 / docs/features.md:126 | Needs you / Finished turn | supported | SessionStart alone raises no waiting need; Stop after prompt raises one; each later turn raises fresh news. |
| 74 / docs/features.md:127 | Needs you / Gone quiet | supported | Fake clock advances working Claude silence to quiet and seen clears; Codex 45-minute silence explicitly excluded. |
| 75 / docs/features.md:128 | Needs you / Overlap | supported | Same evidence as sessions overlap: two relayed file edits and live session stop. |
| 76 / docs/features.md:129 | Needs you / Ranking | supported | Pure sort verifies all nine kinds and oldest-first tie order; callers use that sorter. |
| 77 / docs/features.md:130 | Needs you / Seen and clear | supported | Separate tests verify seen clears informational needs while actionable permission/review/question persist. |
| 78 / docs/features.md:131 | Needs you / Reply in place | supported | Actual terminal receives reply, need persists before UserPromptSubmit, clears after hook; sweep checks same sequence. |
| 79 / docs/features.md:132 | Needs you / Reply offered where it lands | supported | Pure eligibility and DOM check Claude reply vs explanatory Codex text; no untested real Codex delivery promised. |
| 80 / docs/features.md:133 | Needs you / Every project | supported | Closing project removes its needs and reopening restores; cross-project needs gathered in core. |
| 81 / docs/features.md:134 | Needs you / The orb's colour | partial | Orb has separate failure-first signal precedence (test expects failed with both permission and interrupted); it is not the same 'most urgent' ordering as Needs rows. |
| 82 / docs/features.md:140 | Alerts and notifications / Where a need is announced | partial | Pure notification reducer proves target/dedup/leave-window decisions; actual macOS delivery and app subscription wiring require native verification. |
| 83 / docs/features.md:141 | Alerts and notifications / Bursts | supported | Pure test asserts exactly two urgent individual messages and one remainder summary. |
| 84 / docs/features.md:142 | Alerts and notifications / Levels | supported | Pure filter matches level choice; sweep asserts persisted bridge settings. Native notification execution separate. |
| 85 / docs/features.md:143 | Alerts and notifications / Alerts in the window | supported | DOM asserts alert/status roles and count, Open navigation and suppression for on-screen target. |
| 86 / docs/features.md:144 | Alerts and notifications / Native notifications | unverified | Click-route pure test exists; native notification presentation/click wasn't executed by this audit agent. |
| 87 / docs/features.md:145 | Alerts and notifications / Dock badge | unverified | No automated dock badge test; requires native app observation. |
| 88 / docs/features.md:146 | Alerts and notifications / Keep awake | partial | Tests fake powerSaveBlocker transitions while Electron main runs. Main releases blocker on quit, although core sessions can continue; 'exactly while live' is too broad. |
| 89 / docs/features.md:147 | Alerts and notifications / An honest quit | unverified | No test drives native quit dialog and once-per-launch persistence. |
| 90 / docs/features.md:153 | Worktrees and branches / A card's own branch | supported | Real git worktree separate from project created for card; launched cwd and branch diff verified. |
| 91 / docs/features.md:154 | Worktrees and branches / Setup command and `.worktreeinclude` | supported | Copies named ignored fixtures, excludes symlink/outside/unlisted, setup runs correct cwd and failure need; project git status unchanged. |
| 92 / docs/features.md:155 | Worktrees and branches / Merge refuses | supported | Merge rejects live session and dirt in both checkouts before changing target. |
| 93 / docs/features.md:156 | Worktrees and branches / Merge never forces | supported | Actual divergent branches conflict, merge aborts, HEAD/content/status/MERGE_HEAD preserved; different checked-out target rejects. |
| 94 / docs/features.md:157 | Worktrees and branches / Restore | supported | Deleted worktree recreated from existing branch with file content; unmerged branch removal leaves all intact. |
| 95 / docs/features.md:158 | Worktrees and branches / Keep the branch | supported | Re-key keeps original worktree branch/content; refusal protects unmerged commits. |
| 96 / docs/features.md:159 | Worktrees and branches / Inside a larger repository | supported | Nested project own-branch request rejects rather than launches at repository root. |
| 97 / docs/features.md:165 | Changes and diffs / Uncommitted changes | supported | Real git fixture asserts changed file list and diff content, out-of-project traversal refuses and non-repo reports git:false. |
| 98 / docs/features.md:166 | Changes and diffs / A card's branch | supported | Real worktree test includes committed and uncommitted branch changes since fork. |
| 99 / docs/features.md:167 | Changes and diffs / Odd files | partial | Symlink paths and file flood are tested. Named FIFO fixture is reached via a symlink, so does not exercise opening a bare FIFO directly; source uses lstat/read bounds. |
| 100 / docs/features.md:168 | Changes and diffs / Syntax colour | supported | Pure syntax cases cover declared languages and pathological line bounds; sweep checks rendered PHP variable spans. |
| 101 / docs/features.md:169 | Changes and diffs / Unified or side by side | supported | Pure split algorithm verifies line order/uniqueness; sweep changes layout and checks split DOM. |
| 102 / docs/features.md:170 | Changes and diffs / Viewed marks | supported | Fingerprint changes with diff content and sweep changes diff then checks Viewed no longer folds file. |
| 103 / docs/features.md:171 | Changes and diffs / J/K and V | supported | Shortcut parser excludes typing; sweep runs J/K/V from note input with per-key diagnostics (matrix's combined quoted message is stale). |
| 104 / docs/features.md:172 | Changes and diffs / Notes on lines | partial | Pure formatter verifies ordered single message; cited tests do not themselves assert renderer sends exactly once or actual agent receives it. |
| 105 / docs/features.md:178 | Per-turn checkpoints, undo and redo / A checkpoint per turn | supported | Relay+real git writes baseline and turn checkpoint in separate object store, no project ref/index/HEAD/stash change. |
| 106 / docs/features.md:179 | Per-turn checkpoints, undo and redo / Every edit in its turn | supported | Same-size same-second content edit tested against git hash-object; stale index-stat regression meaningful. |
| 107 / docs/features.md:180 | Per-turn checkpoints, undo and redo / What a turn changed | supported | Per-turn file list/diff/count/event id asserted against filesystem mutations. |
| 108 / docs/features.md:181 | Per-turn checkpoints, undo and redo / Honest when not captured | supported | Non-repo and 1ms timeout yield explicit notCaptured reason, not empty healthy diff. |
| 109 / docs/features.md:182 | Per-turn checkpoints, undo and redo / Codex too | supported | OSC completion creates checkpoint with shared-session flag; shell gets none. |
| 110 / docs/features.md:183 | Per-turn checkpoints, undo and redo / Undo and redo | supported | Actual content/binary/index checked across undo/redo, first turn retained, timeline/activity and stale button rejection asserted. |
| 111 / docs/features.md:184 | Per-turn checkpoints, undo and redo / Undo refuses | partial | Strong concrete cases for post-turn edits, commits, missing snapshots, ignored/preexisting files. 'Whenever' overstates finite tests; adversarial git attributes/filters require separate review. |
| 112 / docs/features.md:185 | Per-turn checkpoints, undo and redo / Large files | supported | 21MB untracked fixture excluded while small file and turn persist; tracked-large-file policy is outside named claim. |
| 113 / docs/features.md:191 | Attachments / Kept in Wanigan's data | supported | Bytes/path/mode and spoofed extension asserted; invalid size/name/base64/type and ended target reject. |
| 114 / docs/features.md:192 | Attachments / The owner's | supported | Session socket methods attach/list/preview reject with forbidden. |
| 115 / docs/features.md:193 | Attachments / Claude Code | partial | Raw PTY bytes and simulated image-ack timing checked including timeout fallback; real Claude image ingestion is scenario-only. |
| 116 / docs/features.md:194 | Attachments / Codex | partial | Stand-in captures exact quoted Codex image path/message sequence; actual vision recognition not demonstrated by these tests. |
| 117 / docs/features.md:195 | Attachments / Own composer only | supported | Cross-composer attachment rejected without queue mutation; attachment remains available in original composer. |
| 118 / docs/features.md:196 | Attachments / Talk to Wanigan | supported | Captures stdin single newline-delimited stream-json object, image base64/text contents and no add-dir. |
| 119 / docs/features.md:197 | Attachments / Pick, paste, drop | supported | Main file reader checks limits and sweep inserts paste/drop files preserving composer text; native picker interaction is not driven. |
| 120 / docs/features.md:203 | Tokens / A session's tokens | supported | Synthetic growing/truncated transcript counts each reply once and separates context/subagent tokens; no real transcript read by audit. |
| 121 / docs/features.md:204 | Tokens / Codex | supported | Pure growing totals/restarts/forks and concurrent core read regression assert no double counting. |
| 122 / docs/features.md:205 | Tokens / A card's tokens | supported | Pure mixed-provider sum and core card usage include multiple sessions and uncounted marker. |
| 123 / docs/features.md:211 | Search, History and resume / ⌘K | supported | Pure grouping/fuzzy navigation and both-theme DOM keycaps/last-group arrows; not every possible command is guaranteed by group test. |
| 124 / docs/features.md:212 | Search, History and resume / What agents said | supported | Actual replay search checks case/escapes/snippets plus byte/time/session/result caps and omitted notices. |
| 125 / docs/features.md:213 | Search, History and resume / History | partial | Synthetic Claude/Codex/accounts/worktree fixtures verify expected ordering and dedup. Reader is intentionally bounded; 'every conversation' is not literally unbounded. |
| 126 / docs/features.md:214 | Search, History and resume / Read | supported | Fixture transcript returns text/tool call one-liners, excludes SECRET tool result, bounds newest text and rejects traversal id. |
| 127 / docs/features.md:215 | Search, History and resume / Resume from History | supported | Captured resume argv/cwd/account/fork id plus wrong-Codex-home and paused refusal; shortcut opens reader. |
| 128 / docs/features.md:221 | Accounts, usage and limits / Found on disk | partial | Discovery searches CLI defaults and ~/.claude[-_]*/~/.codex[-_]* with known marker files, not arbitrary account folders anywhere on disk. README's 'Every account' overstates discovery. |
| 129 / docs/features.md:222 | Accounts, usage and limits / Per project | supported | Selected project account changes launch config env and persisted project account map; default clears inherited env. |
| 130 / docs/features.md:223 | Accounts, usage and limits / Manage | supported | Add/rename/default/remove reflected in store while real fixture folder remains; project fallback asserted. |
| 131 / docs/features.md:224 | Accounts, usage and limits / Same login | supported | Fake CLI identity emails drive same-login flags; no credential file used for inference. |
| 132 / docs/features.md:225 | Accounts, usage and limits / Usage | partial | Injected usage reader and pure parser prove display of fixtures/signed-out, not that current installed CLIs actually return that shape. |
| 133 / docs/features.md:226 | Accounts, usage and limits / Continue on another account | supported | Pure account selection rejects exhausted/same-login cases; core fork/transfer tested. |
| 134 / docs/features.md:227 | Accounts, usage and limits / Against the real CLIs | unverified | Real CLI/account identity/usage/models prohibited by audit safety constraints; parser fixtures only. |
| 135 / docs/features.md:228 | Accounts, usage and limits / Sign in | unverified | Demo denial tested; real login/native credential flow not exercised. |
| 136 / docs/features.md:234 | Pause, decisions / Pause | partial | Named test asks live Claude only. Codex wrap-up is covered by separate pause-wrapup.test.ts omitted from matrix; shell intentionally not asked. |
| 137 / docs/features.md:235 | Pause, decisions / Resume | supported | After resume a new shell starts and previous session can claim card. |
| 138 / docs/features.md:236 | Pause, decisions / Decisions | supported | Decision edit/remove persisted and activity recorded; launch briefing excludes withdrawn and old text for both providers. |
| 139 / docs/features.md:242 | Jev / Read | false claim | Payload explicitly includes project name and candidate keys/titles/statuses, as asserted by named test. 'Only the card leaves machine' is untrue; no raw files/transcripts sent. |
| 140 / docs/features.md:243 | Jev / Accept | partial | Normal confident criterion-bearing card accepted; zero-criterion card refused. Missing in-flight criterion-removal race allows invalid acceptance. |
| 141 / docs/features.md:244 | Jev / Off and scoring | partial | Off before creation prevents initial enqueue. Missing queued/in-flight transition-to-Off regression lets queued cards still transmit. |
| 142 / docs/features.md:245 | Jev / The key | supported | Saved dummy key mode0600, status omits secret, forget unlinks and absent key sends nothing; never real key used. |
| 143 / docs/features.md:246 | Jev / Calls and cost | false claim | Test merely checks calls>0/cost>0. ask() omits retry attempts; bounded retention discards older totals; cannot prove every call/cost as written. |
| 144 / docs/features.md:247 | Jev / Offline | supported | Closed local port creates card promptly and settles read failure/status offline with zero cost. |
| 145 / docs/features.md:248 | Jev / Under a second | unverified | No latency SLA follows from implementation or test; requires real TypeSafe measurement and network conditions, prohibited here. |
| 146 / docs/features.md:254 | AI review, drafting, Talk to Wanigan / AI review | partial | Flags restrict tools/MCP; filesystem quotes and advice-only status tested. Real CLI must enforce flags; no OS sandbox, and project/account hooks require separate boundary audit. |
| 147 / docs/features.md:255 | AI review, drafting, Talk to Wanigan / Draft with Claude | supported | Stand-in output becomes editable draft and card count unchanged; sweep fills dialog. Real language quality not asserted. |
| 148 / docs/features.md:256 | AI review, drafting, Talk to Wanigan / Talk to Wanigan | supported | No call until send; launch tools/cwd/state/continuation/stop/access/account args and retained outcomes asserted via stand-in CLI. |
| 149 / docs/features.md:257 | AI review, drafting, Talk to Wanigan / With a real model | unverified | No real model run performed; README's prior dated run is historical author report, not independent evidence here. |
| 150 / docs/features.md:263 | Skills and MCP / Skills listed | false claim | Source explicitly omits Claude built-ins, Codex .system and Codex plugins; named tests assert imagegen is absent. 'Every skill' and 'read whole' above512KB overclaim supported discovery. |
| 151 / docs/features.md:264 | Skills and MCP / Copy and remove | supported | Preview plan/file set, stale plan, no-overwrite, trash retention and symlink-destination refusal assert actual files. |
| 152 / docs/features.md:265 | Skills and MCP / MCP listed | partial | Configured fixture variants and representative secret values are tested; 'every server/secrets hidden' is bounded by supported config/parser/redaction patterns. |
| 153 / docs/features.md:266 | Skills and MCP / The store | supported | Twelve catalog records asserted and each source begins https; tests do not establish third-party quality or present availability. |
| 154 / docs/features.md:267 | Skills and MCP / Add, remove, check | supported | Stand-in records exact argv/env/cwd, preview makes no call, file confirms add/remove; user click is renderer behavior not core authorization proof. |
| 155 / docs/features.md:268 | Skills and MCP / A server that needs a key | supported | Core refuses automatic keyed add, opens ephemeral shell with typed unexecuted command; record deletion/search covered separately. |
| 156 / docs/features.md:269 | Skills and MCP / The owner's | supported | Real session token denied owner-only skills/MCP methods. |
| 157 / docs/features.md:275 | Pull requests / Open a pull request | partial | Local bare push and stand-in gh assert result/argv; known refusals happen pre-push. A later gh failure can still leave branch pushed, so 'anything it cannot finish' is too absolute. |
| 158 / docs/features.md:276 | Pull requests / To GitHub | unverified | No public GitHub push/PR was attempted, per user instruction; real local push + gh stand-in only. |
| 159 / docs/features.md:282 | The demo / Its own world | supported | Demo option roots/stand-ins, fake model list, local Jev and read-only review inspected; additional shell isolation still covered by root audit. |
| 160 / docs/features.md:283 | The demo / Its refusals | supported | Demo sign-in/MCP terminal calls reject through owner socket. |
| 161 / docs/features.md:284 | The demo / Help › Open the Demo | unverified | No named automated menu+second-native-instance test; root owns packaged-demo verification. |
| 162 / docs/features.md:290 | The `wanigan` command / On every session's PATH | supported | Actual shim launched inside PTY with session token; foreign project API tests confirm scope. |
| 163 / docs/features.md:291 | The `wanigan` command / `wanigan status` | supported | Real CLI output includes sentBack, own held cards, ordered Ready, decisions/pause; regression covers released original card. |
| 164 / docs/features.md:292 | The `wanigan` command / `wanigan claim` | supported | Real CLI takes Ready, denies Inbox/paused/other-holder fixtures; resulting claim persisted. |
| 165 / docs/features.md:293 | The `wanigan` command / `wanigan note` | supported | CLI comment requires claim and renews it, with persisted body and activity. |
| 166 / docs/features.md:294 | The `wanigan` command / `wanigan review` | supported | CLI evidence validation and core review state are asserted for file/URL/note and empty rejection. |
| 167 / docs/features.md:295 | The `wanigan` command / `wanigan file` | supported | CLI output and persisted Inbox author/type/body/priority checked; bad type exits/refuses. |
| 168 / docs/features.md:296 | The `wanigan` command / `wanigan ask` | supported | CLI ask creates exact question/Needs; owner reply comment clears question. |
| 169 / docs/features.md:297 | The `wanigan` command / `wanigan release` | supported | CLI release changes column/claim and records actor. |
| 170 / docs/features.md:298 | The `wanigan` command / `list`, `show`, `criteria`, `decisions`, `--json`, help | supported | Real CLI invocation assertions cover help/list/show/JSON/criterion/decisions and unknown exit2. |
| 171 / docs/features.md:299 | The `wanigan` command / Outside a session | supported | Outside-session CLI uses owner identity and reads card; agent-only command returns role-specific error. |
| 172 / docs/features.md:305 | Access, identity and storage / One table of who may call what | partial | Tests derive forbidden methods from ACCESS itself, proving enforcement but not that future ACCESS role assignments are correct. Separate explicit owner-only feature tests strengthen it. |
| 173 / docs/features.md:306 | Access, identity and storage / A session is its token | supported | Foreign card ids rejected across nine mutators/readers; project list/create/decisions scope overridden to session identity. |
| 174 / docs/features.md:307 | Access, identity and storage / An ended session | partial | Ended token reads and four mutations reject. Does not iterate all allowed mutators (evidence/ask/release/heartbeat/submit), though shared authorization path enforces liveness. |
| 175 / docs/features.md:308 | Access, identity and storage / Tokens and files | supported | Hash bytes and not-plaintext DB assertion, mode checks on data/socket/info/token, wrong token reject. Same-user processes remain outside security boundary. |
| 176 / docs/features.md:309 | Access, identity and storage / Hooks | partial | Own hook socket path and invalid token empty reply exercised; test does not snapshot state before/after invalid token, so 'changes nothing' has weak direct assertion. |
| 177 / docs/features.md:310 | Access, identity and storage / Migrations | partial | Builds old schema from today's MIGRATIONS.slice(0,11), so editing shipped migrations still passes. Regex excludes DROP/RENAME but not destructive DML/reordered shipped bytes. |
| 178 / docs/features.md:311 | Access, identity and storage / Storage refusals | partial | Foreign table set verified unchanged after refusal; newer DB refusal checked but byte/sidecar preservation not asserted (opening SQLite may touch metadata). |
| 179 / docs/features.md:312 | Access, identity and storage / Tests stay local | partial | One test proves inherited TYPESAFE_API_KEY is ignored by testCore. Blanket no-home/no-account/no-spend property requires all helpers/scripts inspection, not this one assertion. |
| 180 / docs/features.md:313 | Access, identity and storage / The core's idle exit | unverified | Ten-minute daemon timer lacks controllable clock/seam; no shortened automated proof. |
| 181 / docs/features.md:314 | Access, identity and storage / The bridge | partial | Owner allowlist derived from ACCESS, actual preload used by app smoke; hostile iframe/navigation sender validation is separate boundary review. |
| 182 / docs/features.md:320 | Interface / Every view in both themes | partial | 26 seeded routes run at1440x900 in both themes with DOM/loading/overflow/error checks. Narrow run is dark-only1024x700 (minimum960), and no comprehensive Tab/focus-visible check. |
| 183 / docs/features.md:321 | Interface / The rail | supported | Pure width/preference rule, menu command callback and sweep collapsed/icon/name/persistence assertions; source supports auto folding. |
| 184 / docs/features.md:322 | Interface / Keys and menus | supported | Pure shortcut map+menu tests and focused-terminal Control-K/Meta-K sweep; not comprehensive Tab navigation coverage. |
| 185 / docs/features.md:323 | Interface / Window titles | supported | Pure title formatting and route-loop document.title expectations. |
| 186 / docs/features.md:324 | Interface / Since you last looked | supported | Pure counted activity boundaries/floor labels and seeded changed-since text in sweep. |
| 187 / docs/features.md:325 | Interface / Errors | supported | Injected renderer exception leaves rail and shows crash/reload; failed send keeps error toast until Retry sends actual terminal marker. |
| 188 / docs/features.md:326 | Interface / The water orb | partial | Pure choreography time/state/reduced-motion setter tests; does not prove CSS media-query wiring or GPU rendering. GPU claim correctly separate manual row. |
| 189 / docs/features.md:327 | Interface / The orb on a real GPU | unverified | No real-GPU comparison run by this agent; root may inspect exported screenshots. Numeric 1/255 claim remains historical unless probe executed. |
| 190 / docs/features.md:328 | Interface / Showcase never amber | unverified | Showcase script contains refusal logic but was not run against native packaged GPU app here. |
| 191 / docs/features.md:329 | Interface / Packaging | unverified | Root owns fresh-clone packaging, DMG mounting, native smoke and signature/hash results; cannot infer from unit suite. |
| 192 / docs/features.md:330 | Interface / Secret scanning | unverified | Root owns gitleaks --all execution; fake-key allowlist does not itself prove scan success. |

## Referenced evidence by row

- **1 Open a project:** `core/core.test.ts` › "projects get keys, and cards get project-scoped keys"; `shared/rules.test.ts` › "project keys come from the name and never collide"
- **2 Nothing written into a project:** `core/session-life.test.ts` › "working a project writes nothing into its folder"; `core/checkpoints.test.ts` › "a capture leaves the status, index, HEAD, refs and stash exactly as they were"
- **3 Change a project's key:** `core/board-rules.test.ts` › "a new key renames every card in the project; a key in use or not a key is refused"
- **4 Close a project:** `core/board-rules.test.ts` › "closing a project waits for its sessions, hides it and what it needs, and opening the folder again brings it back whole"
- **5 Wanigan 1's projects offered:** `core/core.test.ts` › "projects from Wanigan 1 are suggested, read-only, if they still exist and are not open"; `core/history.test.ts` › "writes nothing beside it, and sees rows its writer has not checkpointed"
- **6 Folders the agents worked in:** `core/agent-folders.test.ts` › "folders the agents worked in are ranked by conversations in the last 30 days, then by how recent", "the look is capped and says so when it is cut", "a record names its folder in its first few KB, or not at all"; `scripts/ui-sweep.mjs` › "the busiest folder is not first"
- **7 Activity:** `core/board-rules.test.ts` › "activity: every change names who made it, newest first, by project and by card"
- **8 Card types:** `core/board-rules.test.ts` › "an edit changes what a card says…"; `core/cli.test.ts` › "file: what an agent files lands in the Inbox…"
- **9 Agents file into the Inbox:** `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/cli.test.ts` › "file: what an agent files lands in the Inbox, as its own, at the priority it gives"
- **10 Agents can't claim from the Inbox:** `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/board-rules.test.ts` › "the owner starting a session on an Inbox card accepts it; an agent cannot take it from there"
- **11 The owner accepts from the Inbox:** `core/board-rules.test.ts` › "the owner starting a session on an Inbox card accepts it…"; `scripts/ui-sweep.mjs` › "accepted from the Inbox, did not glide into Ready"
- **12 No dragging into Working:** `core/core.test.ts` › "the owner cannot drag a card into Working"; `shared/rules.test.ts` › "the owner cannot drag work into Working or out of Done"
- **13 Review needs evidence:** `core/core.test.ts` › "an agent claims, notes and submits through the CLI in its own terminal"; `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing, ranks never collide"; `core/cli.test.ts` › "review: evidence is a file, a link or a sentence, and none is no review"
- **14 Only the owner approves:** `core/core.test.ts` › "a session is confined to its project and cannot approve"; `core/access.test.ts` › "a session can call only what ACCESS gives it…"
- **15 Approve, send back, reopen gates:** `core/board-rules.test.ts` › "approve and send back only from Review, reopen only from Done; approving clears what was flagged"
- **16 Send back:** `core/core.test.ts` › "an agent claims, notes and submits through the CLI in its own terminal"
- **17 Reopen as not fixed:** `core/core.test.ts` › "an agent claims, notes and submits…"; `core/board-rules.test.ts` › "approve and send back only from Review…"
- **18 Archive:** `core/board-rules.test.ts` › "only the owner archives: the card leaves the board, its counts and search, nobody can work it, and archiving is final"
- **19 Ranks:** `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing, ranks never collide"; `shared/rules.test.ts` › "ranks fall between their neighbours"; `core/board-rules.test.ts` › "an edit changes what a card says…"
- **20 Priorities:** `core/cli.test.ts` › "status: the agent’s card, what was sent back, what else it holds, Ready by priority, decisions, and a pause"
- **21 What a card shows:** `core/board-rules.test.ts` › "an edit changes what a card says and records it, never its column or its time there; a move restarts that time", "a card says who holds it and whether they are running, from the session itself"
- **22 Edit a card:** `core/board-rules.test.ts` › "an edit changes what a card says…"
- **23 Criteria:** `core/board-rules.test.ts` › "criteria: the owner ticks, rewords and removes them; an agent may only add one"
- **24 Questions:** `core/cli.test.ts` › "ask: a question reaches Needs you…"; `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing…"
- **25 Cards across projects:** `core/core.test.ts` › "cards can be found across every project"
- **26 How this works:** `scripts/ui-sweep.mjs` › "the explainer's Review box did not show its column"
- **27 Board keys:** `scripts/ui-sweep.mjs` › "board keys did not move focus"; `shared/shortcuts.test.ts` › "the sheet’s board keys are the keys the board handles"
- **28 Drag between columns:** The move it makes: `core/hardening.test.ts` › "board rules: review needs evidence, closed cards ask nothing, ranks never collide". The mouse gesture: none.
- **29 List view:** `scripts/ui-sweep.mjs` › route `list` renders real rows in both themes
- **30 Claim:** `core/core.test.ts` › "hook events drive state, Needs you and the session briefing", "an agent claims, notes and submits through the CLI in its own terminal"
- **31 Lease:** `core/core.test.ts` › "a claim from a dead session expires; a live session keeps its claim"
- **32 Sleep:** `core/hardening.test.ts` › "a claim survives the machine sleeping while its session runs"
- **33 One claimant:** `core/hardening.test.ts` › "a claim survives the machine sleeping…"
- **34 Note:** `core/cli.test.ts` › "claim, note and release: a claim is taken, kept and given back, and each step is on the card"
- **35 Release:** `core/cli.test.ts` › "claim, note and release…"
- **36 Released on exit:** `core/core.test.ts` › "a session is confined to its project and cannot approve"
- **37 Hand-over:** `core/limits.test.ts` › "a usage limit is its own need, and the conversation carries on under another account with its card"
- **38 Start:** `core/core.test.ts` › "hook events drive state…"; `core/hardening.test.ts` › "a refused start leaves nothing running, and a double click starts one session"
- **39 Stop:** `core/core.test.ts` › "an ended Claude conversation resumes on the same card and account"; `core/session-life.test.ts` › "an agent that dies on its own is failed, not ended…"
- **40 Survive the window:** `main/core-process.test.ts` › "a session outlives the app that started it"
- **41 A session that fails:** `core/session-life.test.ts` › "an agent that dies on its own is failed, not ended…"; `core/needs-rules.test.ts` › "a failure stops asking after three days…"
- **42 Interrupted:** `main/core-process.test.ts` › "a core that dies is started again, and says plainly which sessions it lost"
- **43 Resume:** `core/core.test.ts` › "an ended Claude conversation resumes on the same card and account"; `core/review2.test.ts` › "a conversation carried on runs where it ran, and starts once"
- **44 Continue on another account:** `core/limits.test.ts` › "a usage limit is its own need…"
- **45 Rename:** `core/session-life.test.ts` › "a renamed session keeps its new name wherever it is shown"
- **46 Promote:** `core/session-life.test.ts` › "a one-off session becomes a card with its history, and works it while it runs"
- **47 Attach:** `core/session-life.test.ts` › "attaching a running one-off to a Ready card…"; `core/hardening.test.ts` › "a refused start leaves nothing running…"
- **48 Queue and deliver:** `core/core.test.ts` › "queued messages wait for a Claude session to be idle", "a Codex session reports waiting, asking and working from its own notifications"; `core/paste-escape.test.ts` › "a queued message cannot end its own bracketed paste"
- **49 Ephemeral:** `core/review2.test.ts` › "a terminal a key may be typed into keeps no record once it closes"; `core/ephemeral-search.test.ts` › "a key typed into an ephemeral terminal is never found by search, even after a crash"
- **50 Remote Control:** `core/attachments.test.ts` › "Remote Control is passed, named after the session, only when the owner turns it on"
- **51 Model and effort:** `core/hardening.test.ts` › "a session starts with the model and effort chosen, keeps them, and refuses anything that is not a name"
- **52 Named after the card:** `core/session-name.test.ts` › "a Claude session on a card is named after it; a one-off is not"
- **53 Terminal record:** `core/core.test.ts` › "terminal output streams to watchers with sequence numbers"; `core/scrollback.test.ts` › "memory keeps the newest 2 MB…"
- **54 Watch:** `shared/watch.test.ts` (six tests); `core/watch.test.ts` › "watching a session gives its PTY size, and a real resize is announced once"; `scripts/ui-sweep.mjs` › "a PTY changed size while it was watched"
- **55 Overlap:** `core/core.test.ts` › "two live sessions in one folder editing one file is raised, and clears when one stops"
- **56 Chatter:** `core/core.test.ts` › "agents messaging each other are recorded as who and label, never the message"; `scripts/ui-sweep.mjs` › "the message itself reached the screen"
- **57 Timeline as turns:** `shared/turns.test.ts` › "events become turns: prompt to stop, with tools, files and permission asks"
- **58 Claude hooks:** `core/core.test.ts` › "hook events drive state, Needs you and the session briefing"; `core/hardening.test.ts` › "a hook body that arrives after its header is still read"
- **59 Permission stands:** `shared/rules.test.ts` › "a permission request stands until something answers it"; `core/core.test.ts` › "hook events drive state…"
- **60 Late hooks:** `core/hardening.test.ts` › "a late hook does not rewrite how a session ended…"
- **61 Briefing:** `core/core.test.ts` › "hook events drive state…", "a Codex session reports waiting, asking and working from its own notifications"; `core/board-rules.test.ts` › "each session is told the decisions as they stand when it starts…"
- **62 Codex by OSC 9:** `core/core.test.ts` › "a Codex session reports waiting, asking and working…"; `core/hardening.test.ts` › "Codex: Enter on an empty line or a /command is not a turn"; `shared/codex.test.ts` (five tests)
- **63 Codex hooks:** `core/codex-hooks.test.ts` › "Codex hook flags define each event once…", "Codex hooks: trusted by the hashes Codex lists, asked once per version", "Codex hooks: anything short of every hook trusted launches without them, and says why", "a Codex session launches with trusted hooks only when the probe says so"
- **64 Codex thread:** `core/codex-hooks.test.ts` › "a relayed Codex hook names its thread; tokens, History and resume follow", "a Codex session whose thread is not known cannot be resumed, and says why"
- **65 A shell's states:** `core/needs-rules.test.ts` › "a failure stops asking after three days…"; `core/limits.test.ts` › "a usage limit is its own need…"
- **66 Codex hooks against a new Codex:** none
- **67 Permission:** `core/needs-answer.test.ts` › "a permission row carries the exact command, hidden characters and all, until the request is settled"; `shared/hidden.test.ts` (sixteen tests); `scripts/ui-sweep.mjs` › "the zero-width space was not spelled out"
- **68 Review:** `core/core.test.ts` › "an agent claims, notes and submits…"; `core/needs-rules.test.ts` › "looking settles a finished turn; a permission request, a review and a question wait for their answer"
- **69 Question:** `core/cli.test.ts` › "ask: …"; `core/needs-rules.test.ts` › "looking settles a finished turn…"
- **70 Failed:** `core/session-life.test.ts` › "an agent that dies on its own is failed…"; `core/needs-rules.test.ts` › "a failure stops asking after three days…"; `core/worktree-setup.test.ts` › "a new card worktree gets the ignored files…"
- **71 Interrupted:** `main/core-process.test.ts` › "a core that dies is started again…"
- **72 Usage limit:** `core/limits.test.ts` › "a usage limit is its own need…"; `shared/limits.test.ts` (five tests)
- **73 Finished turn:** `core/core.test.ts` › "hook events drive state…"; `core/needs-rules.test.ts` › "looking settles a finished turn…"
- **74 Gone quiet:** `core/core.test.ts` › "a working Claude session that goes quiet is raised; looking at it settles it"; `core/needs-rules.test.ts` › "…Codex going quiet while it works is never raised"
- **75 Overlap:** `core/core.test.ts` › "two live sessions in one folder editing one file is raised…"
- **76 Ranking:** `shared/rules.test.ts` › "needs are ranked by kind, then oldest first", "every kind of need has its place…"
- **77 Seen and clear:** `core/needs-rules.test.ts` › "looking settles a finished turn…"; `core/session-life.test.ts`; `core/limits.test.ts`
- **78 Reply in place:** `core/needs-answer.test.ts` › "a reply to a finished turn is sent at once, and the row clears when the agent starts, not when it was sent"; `scripts/ui-sweep.mjs` › "the row cleared before the agent started"
- **79 Reply offered where it lands:** `shared/hidden.test.ts` › "Reply is offered where a message is known to land and the row clears on evidence"; `scripts/ui-sweep.mjs` › "a Codex row does not say why it offers no Reply"
- **80 Every project:** `core/board-rules.test.ts` › "closing a project waits for its sessions…"
- **81 The orb's colour:** `renderer/src/orb/choreography.test.ts` › "the signal is the most urgent need, and an unread list is not an all-clear"
- **82 Where a need is announced:** `shared/notifications.test.ts` › "in front, a new alert goes to the window, not to macOS", "only needs not announced before are announced", "a need that arrived while you looked is announced when you leave, if still open"
- **83 Bursts:** `shared/notifications.test.ts` › "a burst becomes the two most urgent and one line for the rest"
- **84 Levels:** `shared/notifications.test.ts` › "only permission and failures, or nothing, as the owner chose"; `scripts/ui-sweep.mjs` › "patches did not reach the app"
- **85 Alerts in the window:** `scripts/ui-sweep.mjs` › "two alerts never showed", "Open did not go to the session asking", "an alert for something on screen"
- **86 Native notifications:** Which route a click opens: `shared/notifications.test.ts` › "a notification opens where the need is answered"
- **87 Dock badge:** none
- **88 Keep awake:** `main/awake.test.ts` (four tests)
- **89 An honest quit:** none
- **90 A card's own branch:** `core/core.test.ts` › "a card works on its own branch, and is merged back only when it is safe"
- **91 Setup command and `.worktreeinclude`:** `core/worktree-setup.test.ts` › "a new card worktree gets the ignored files .worktreeinclude names, and runs the setup command beside the agent"
- **92 Merge refuses:** `core/core.test.ts` › "a card works on its own branch…"
- **93 Merge never forces:** `core/worktree-merge.test.ts` › "a merge that conflicts is undone and changes nothing; one into a folder on another branch is refused"
- **94 Restore:** `core/hardening.test.ts` › "removing a branch is all or nothing, and a missing worktree is made again"
- **95 Keep the branch:** `core/review2.test.ts` › "own branches are refused for a project inside a larger repository, and kept across a key change"; `core/hardening.test.ts` › "removing a branch is all or nothing…"
- **96 Inside a larger repository:** `core/review2.test.ts` › "own branches are refused for a project inside a larger repository…"
- **97 Uncommitted changes:** `core/core.test.ts` › "a project’s uncommitted changes and their diffs, read-only"
- **98 A card's branch:** `core/core.test.ts` › "a card works on its own branch…"
- **99 Odd files:** `core/hardening.test.ts` › "untracked links are shown as links, odd files never block, and a flood is capped"
- **100 Syntax colour:** `shared/syntax.test.ts` (fifteen tests); `scripts/ui-sweep.mjs` › "the PHP diff shows no variables in colour"
- **101 Unified or side by side:** `shared/diff.test.ts` › "side by side: context on both sides…", "side by side shows every line once, each side in its own order"; `scripts/ui-sweep.mjs` › "Split did not show side by side"
- **102 Viewed marks:** `shared/diff.test.ts` › "a diff’s fingerprint is stable and changes with any edit"; `scripts/ui-sweep.mjs` › "a mark on a diff that has since changed still folds the file"
- **103 J/K and V:** `shared/shortcuts.test.ts` › "the sheet’s Changes keys are the keys the Changes view handles…"; `scripts/ui-sweep.mjs` › "J, K or V were taken from a note being typed"
- **104 Notes on lines:** `shared/review-notes.test.ts` › "notes become one message, in file and line order, each with its place and its code"; `shared/diff.test.ts` › "a note on a removed line attaches to the old file…"
- **105 A checkpoint per turn:** `core/checkpoints.test.ts` › "a capture leaves the status, index, HEAD, refs and stash exactly as they were"
- **106 Every edit in its turn:** `core/checkpoints.test.ts` › "an edit the same size as before, made in the second the index was written, is in a checkpoint taken a second later"
- **107 What a turn changed:** `core/checkpoints.test.ts` › "a turn shows what changed in the folder, file by file"
- **108 Honest when not captured:** `core/checkpoints.test.ts` › "a folder that is not a repository, or a capture that runs out of time, says it was not captured"
- **109 Codex too:** `core/checkpoints.test.ts` › "Codex’s “turn complete” takes a checkpoint too, and another session in the folder is noted"
- **110 Undo and redo:** `core/checkpoints.test.ts` › "undo puts the last turn back, redo puts it forward again, and both are in the timeline"; `shared/checkpoints.test.ts` › "the last turn can be undone only in a card’s worktree, at rest, alone, and fully captured"; `scripts/ui-sweep.mjs` › "the timeline does not record the undo"
- **111 Undo refuses:** `core/checkpoints.test.ts` › "undo refuses whenever it could lose or misplace work", "a checkpoint git no longer has reads as gone, and cannot be undone", "undo is refused when the turn changed .gitignore and would delete a file", "undo keeps a file that was there before the turn, though git could not see it then"
- **112 Large files:** `core/checkpoints.test.ts` › "a large untracked file is left out of a checkpoint, and its turn still records"
- **113 Kept in Wanigan's data:** `core/attachments.test.ts` › "a file is kept 0600 under Wanigan’s data folder, never in the project, and bad input is refused"; `shared/attachments.test.ts` (three tests)
- **114 The owner's:** `core/attachments.test.ts` › "a session’s own token cannot attach, list or read files"
- **115 Claude Code:** `core/attachments.test.ts` › "Claude Code is typed its images first…", "when Claude Code never shows the images, the message still goes…"
- **116 Codex:** `core/attachments.test.ts` › "Codex is pasted each image as one quoted path, then the message"
- **117 Own composer only:** `core/attachments.test.ts` › "a message can name only files that wait in its own composer"
- **118 Talk to Wanigan:** `core/attachments.test.ts` › "Talk to Wanigan sends its files inside one stream-json message"
- **119 Pick, paste, drop:** `main/picked.test.ts` › "the Attach dialog’s files are read in main, within the same limits the core keeps"; `scripts/ui-sweep.mjs` › "an image pasted and one dropped on the terminal did not both join the composer"
- **120 A session's tokens:** `core/tokens.test.ts` › "a session’s tokens come from its own transcript, read as it grows"; `shared/tokens.test.ts` (ten tests)
- **121 Codex:** `shared/tokens.test.ts` › "Codex: …" (four tests); `core/tokens-race.test.ts` › "two concurrent token reads of a grown Codex rollout count it once"
- **122 A card's tokens:** `shared/tokens.test.ts` › "a card’s Claude and Codex conversations add up as one count"
- **123 ⌘K:** `shared/palette.test.ts` (five tests); `scripts/ui-sweep.mjs` › "no key caps", "the arrow keys did not reach the last group"
- **124 What agents said:** `core/said.test.ts` (eight tests); `shared/said.test.ts` (seven tests); `scripts/ui-sweep.mjs` › "nothing an agent said was found"
- **125 History:** `core/history.test.ts` › "lists every conversation in the folder and its worktrees, newest first, once each", "search matches the title, the first prompt and the branch"
- **126 Read:** `core/history.test.ts` › "reads text turns and one-line tool calls, never tool results"
- **127 Resume from History:** `core/history.test.ts` › "resumes in its own account by id, and as another account by forking the transcript", "a Codex thread resumes only in its own home", "a paused project starts nothing"; `scripts/ui-sweep.mjs` › "⌘⇧T did not open History"
- **128 Found on disk:** `core/core.test.ts` › "existing account folders are found, and the default account sets no variable"
- **129 Per project:** `core/core.test.ts` › "existing account folders are found…"
- **130 Manage:** `core/core.test.ts` › "existing account folders are found…"; `core/accounts.test.ts` › "an account is renamed, made the default, and removed without touching its folder…"
- **131 Same login:** `core/accounts.test.ts` › "…two folders on one login are flagged"
- **132 Usage:** `core/core.test.ts` › "existing account folders are found…"; `shared/usage.test.ts` (four tests)
- **133 Continue on another account:** `shared/limits.test.ts` › "a conversation moves only to an account with room, never to the same login"; `core/limits.test.ts`
- **134 Against the real CLIs:** Their parsers, from real replies: `shared/usage.test.ts`, `shared/limits.test.ts`
- **135 Sign in:** The demo's refusal: `core/review2.test.ts` › "the demo signs nothing in and opens no terminal in the owner’s home"
- **136 Pause:** `core/core.test.ts` › "pausing a project blocks new work and asks live Claude sessions to wrap up"; `core/cli.test.ts` › "status: the agent’s card, what was sent back, what else it holds, Ready by priority, decisions, and a pause"
- **137 Resume:** `core/core.test.ts` › "pausing a project blocks new work…"
- **138 Decisions:** `core/board-rules.test.ts` › "each session is told the decisions as they stand when it starts: edited, withdrawn, Claude and Codex alike"; `core/cli.test.ts` › "decisions lists what is in force, and nothing withdrawn"
- **139 Read:** `core/jev.test.ts` › "a new Inbox card is read: action, severity, and only the card leaves the machine", "a likely duplicate is named, with the candidates Jev was asked about"; `shared/jev.test.ts` (five tests)
- **140 Accept:** `core/jev.test.ts` › "Accept mode moves a confident card that says what done means, and logs it as Jev"
- **141 Off and scoring:** `core/jev.test.ts` › "a card past triage is only scored; Off sends nothing"
- **142 The key:** `core/jev.test.ts` › "with no key, nothing is sent and the status says so", "a saved key is the core’s alone, and is never sent back", "forgetting the key removes it"
- **143 Calls and cost:** `core/jev.test.ts` › "busy answers are retried; a refused key is shown on the card and stops the queue"
- **144 Offline:** `core/jev-offline.test.ts` › "with TypeSafe out of reach, a card is filed at once, says Jev could not read it, and Jev shows offline"
- **145 Under a second:** none
- **146 AI review:** `core/core.test.ts` › "an AI review is read-only, checked against the files, and only advice"; `core/hardening.test.ts` › "an AI review cut short by a stop is recorded as failed, then and after a restart"; `core/review2.test.ts` › "AI review and drafting run with only the reading tools, and none of the account’s MCP servers"
- **147 Draft with Claude:** `core/core.test.ts` › "a card can be drafted from a rough note, and nothing is created by the draft"; `scripts/ui-sweep.mjs` › "Draft with Claude never filled the card"
- **148 Talk to Wanigan:** `core/chat.test.ts` (eleven tests)
- **149 With a real model:** Stand-ins only
- **150 Skills listed:** `core/skills.test.ts` › "every skill is listed by where it lives, for the agent that reads it", "each skill says what it is, who sees it and what can be done with it", "a SKILL.md is read whole; one that links out of its folder is refused", "listing, reading and previewing write nothing"
- **151 Copy and remove:** `core/skills.test.ts` › "a copy writes exactly the files it listed, and nothing it did not", "a copy never overwrites without asking…", "a destination that leads out of its root through a link is refused…", "remove moves a hand-managed skill to the trash…"
- **152 MCP listed:** `core/mcp.test.ts` › "every configured server is listed where it is defined, for the account that has it", "no secret value reaches a result, and harmless values stay readable"; `shared/mcp.test.ts` › "secrets are hidden wherever they hide"; `scripts/ui-sweep.mjs` › "MCP page shows secrets"
- **153 The store:** `core/mcp.test.ts` › "the store has twelve servers, each with its source"
- **154 Add, remove, check:** `core/mcp.test.ts` › "a preview shows the exact command and runs nothing", "add runs the CLI as that account, with no shell, then confirms from the file", "project scope writes the repository’s .mcp.json from inside it, and says so", "remove goes through the CLI for the right scope…", "check connections asks Claude Code itself…"
- **155 A server that needs a key:** `core/mcp.test.ts` › "a key, or a Codex browser sign-in, is finished by the owner in a terminal"; `core/review2.test.ts` › "a terminal a key may be typed into keeps no record once it closes"
- **156 The owner's:** `core/skills.test.ts` › "skills are the owner’s…"; `core/mcp.test.ts` › "MCP is the owner’s…"
- **157 Open a pull request:** `core/pull-request.test.ts` › "an approved card’s branch is pushed and its pull request opened, after every refusal that applies"; `scripts/ui-sweep.mjs` › "the pull request plan never showed"
- **158 To GitHub:** A stand-in `gh` only
- **159 Its own world:** `core/demo.test.ts` › "the demo runs on stand-ins kept in its own folder, and nothing it starts or reads is the owner’s"
- **160 Its refusals:** `core/review2.test.ts` › "the demo signs nothing in and opens no terminal in the owner’s home"; `core/demo.test.ts`
- **161 Help › Open the Demo:** none
- **162 On every session's PATH:** `core/cli.test.ts` (every test); `core/access.test.ts` › "everything a session may touch is in its own project"
- **163 `wanigan status`:** `core/cli.test.ts` › "status: …"; `core/core.test.ts` › "an agent claims, notes and submits…"
- **164 `wanigan claim`:** `core/cli.test.ts` › "claim, note and release…", "file: …", "status: …"
- **165 `wanigan note`:** `core/cli.test.ts` › "claim, note and release…"
- **166 `wanigan review`:** `core/cli.test.ts` › "review: …"; `core/core.test.ts` › "an agent claims, notes and submits…"
- **167 `wanigan file`:** `core/cli.test.ts` › "file: …"
- **168 `wanigan ask`:** `core/cli.test.ts` › "ask: …"
- **169 `wanigan release`:** `core/cli.test.ts` › "claim, note and release…"
- **170 `list`, `show`, `criteria`, `decisions`, `--json`, help:** `core/cli.test.ts` › "help lists every command…", "list and show read the board…", "ask: …", "decisions lists what is in force…"
- **171 Outside a session:** `core/cli.test.ts` › "outside a session it is the owner…"
- **172 One table of who may call what:** `core/access.test.ts` › "a session can call only what ACCESS gives it, and the owner nothing that is only an agent’s"
- **173 A session is its token:** `core/access.test.ts` › "everything a session may touch is in its own project"; `core/core.test.ts` › "a session is confined to its project and cannot approve"
- **174 An ended session:** `core/access.test.ts` › "a session that has ended keeps its token but can only read the board"
- **175 Tokens and files:** `core/access.test.ts` › "a session token is kept only as its hash…"; `core/hardening.test.ts` › "a late hook does not rewrite how a session ended; a session is not told where the data is"; `core/core.test.ts` › "a wrong token is refused"
- **176 Hooks:** `core/core.test.ts` › "hook events drive state…"
- **177 Migrations:** `core/db-upgrade.test.ts` › "a database at schema 11, with data, opens and gains everything since", "every migration adds: none drops or renames what an earlier one made"
- **178 Storage refusals:** `core/core.test.ts` › "a database Wanigan 2 did not create is refused, not adopted"; `core/db-upgrade.test.ts` › "a database from a newer Wanigan, or marked as another store, is refused and left untouched"
- **179 Tests stay local:** `core/jev-offline.test.ts` › "a test core never finds the owner’s Jev key"
- **180 The core's idle exit:** none
- **181 The bridge:** Built from ACCESS (`src/main/index.ts`); the app smoke exercises it
- **182 Every view in both themes:** `scripts/ui-sweep.mjs` › every route in `routes`, light and dark
- **183 The rail:** `shared/rail.test.ts` (three tests); `main/menu.test.ts` › "the View menu shows or hides the sidebar with ⌘\\"; `scripts/ui-sweep.mjs` › "⌘\\ did not fold the rail"
- **184 Keys and menus:** `shared/shortcuts.test.ts` (eleven tests); `main/menu.test.ts` (four tests); `scripts/ui-sweep.mjs` › "Control-K was taken from the terminal"
- **185 Window titles:** `shared/shortcuts.test.ts` › "the window title says where you are, the app last"
- **186 Since you last looked:** `shared/since.test.ts` (three tests); `scripts/ui-sweep.mjs` › "no line of what changed"
- **187 Errors:** `scripts/ui-sweep.mjs` › "a throwing view did not show the crash panel", "Retry did not send the message"
- **188 The water orb:** `renderer/src/orb/choreography.test.ts` (twelve tests)
- **189 The orb on a real GPU:** `scripts/orb-probe.mjs`
- **190 Showcase never amber:** `scripts/showcase.mjs`
- **191 Packaging:** `scripts/app-smoke.mjs --app …`
- **192 Secret scanning:** `gitleaks git . --log-opts=--all`

## Original README, SECURITY and design cross-check

- Architecture agrees with source: detached core owns PTYs/SQLite; typed method map and role table; renderer preload bridge; session CLI identity. This is a same-user cooperative boundary, not an OS sandbox; SECURITY accurately discloses that limitation.
- README's 'Every' skills/account/history language is broader than supported discovery. Skills explicitly excludes built-ins/Codex plugins; accounts auto-discovery only scans named patterns under home; history has size/record limits.
- README says Jev answers under one second and records every call/cost. Latency is historical measurement, not an enforced bound (30s HTTP timeout with retries). Retry and retention bookkeeping contradict universal accounting; queued consent/criteria races identified.
- README's 'nothing written' is qualified immediately by explicit skill/MCP/worktree actions. CONTRIBUTING's absolute sentence should carry the same qualification. Normal launch's test does not prove every Codex/project configuration shape.
- SECURITY's credential claim is supported by CLI identity probing rather than credential reads in accounts.ts; fake credential filenames are only existence markers. Full filesystem trust review is delegated.
- Design's notifications/quit/GPU/saved-views status is explicit, but architecture and feature sections retain historical descriptions: read-only Changes despite a now writable workbench, water-only despite lava-lamp mode, and null-text UI assertion absent from actual sweep regex.
- Keep-awake is in Electron main and released on quit; detached core sessions remain. The feature-matrix 'exactly while a session is live' must be qualified to the running app/setting.
- No real-model turns, TypeSafe service calls, real CLI account interrogation, or app-driven GitHub push/PR occurred during these feature-proof checks. Subsequent authorized repository/release publication is recorded in the main review report. Historical 7October scenario assertions are not independently re-proved.

## Post-audit disposition

Original row 5 (legacy Wanigan1 suggestions/history names) was intentionally removed on the owner's explicit instruction. Original row numbering remains above for a complete 192-row audit trail. The original assessment was 140 supported, 33 partial, 16 unverified and three false claims. The displayed table now has 139 supported plus one intentionally removed row; the other counts are unchanged. The current docs/features.md has 204 rows after removing that integration and adding 13 git-workbench rows.

Jev queued-Off, stale criteria, retry accounting, retained aggregate totals and tied-timestamp health regressions were observed failing before fixes. SKILL.md symlink metadata leak was likewise reproduced before fixing. Source fixes and targeted test results are in [the Jev and skills appendix](jev-and-skills.md). Final UI/packaging and aggregate checks are in [the consolidated report](README.md).
