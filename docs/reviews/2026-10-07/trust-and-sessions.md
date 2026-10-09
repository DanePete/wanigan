# Wanigan 2 independent trust/session review

Reviewed the Wanigan 2 checkout on `codex-review`. All nine code fixes below shipped in [`bd3e03c`](https://github.com/DanePete/wanigan-2/commit/bd3e03c9ccbb39a7b84f9c10c889fee2febc6575). Line references describe the reviewed working tree on 2026-10-07. No forbidden application-data directory was read or touched. No real agent turn or real `claude -p` ran. Temporary cores used fake homes and stand-in agents. Local CLI `--help`/`--version` inspection did not run a model.

## Findings, ranked

### P1 — Two cores could claim and recover the same store

- Location: `src/core/core.ts:106` and `:168`; `src/core/server.ts` socket binding previously unlinked an existing socket after a separate launch probe.
- Reproduction: start a real test core and live stand-in shell, construct/start a second `Core` with the same temporary data directory. Previously the second core started, marked the first session lost and could replace its socket. A constructor also cleared the shared checkpoints directory before startup admission.
- Fixed: claim the store with an immediate SQLite transaction before constructing runtime services, writing hook/shim files or clearing checkpoint indexes. The lease records PID, random instance identity, and locale-stable process birth time. Clean stop releases only its own lease; dead/reused PID can be reclaimed. A second core is refused before runtime side effects.
- Test: `src/core/single-core.test.ts`, “a second core for the same store cannot recover the first core’s live sessions or take its socket.” Original failed with missing expected rejection; fixed test passes and verifies first session remains running, original socket still answers, and a planted active checkpoint index remains byte-for-byte present.
- Limit: opening the database still applies additive migrations before store admission. This patch has no new migrations, but a future mixed-version schema change should move migration admission earlier. Process birth identification fails closed if the OS cannot report it; the returned `ps` timestamp is second-resolution, not a cryptographic process identity.

### P1 — A read-only advisory run did not suppress project/custom hooks and skills

- Location: `src/core/headless.ts:10` and `src/core/chat.ts:52`.
- Reproduction: inspect the argv actually sent to a stand-in Claude by read-only review/drafting/chat. It limited tools and MCP but lacked an instruction to disable custom settings, hooks, skills and plugins. Those customizations can be selected from agent-writable project content; tool restrictions alone do not establish that they are disabled.
- Fixed: advisory processes additionally receive `--safe-mode --setting-sources ''`. The installed Claude 2.1.293 help explicitly describes safe mode as disabling hooks, skills, plugins and configuration customizations while preserving authentication. Normal owner-launched coding sessions retain normal CLI behavior.
- Tests: `headless.test.ts`, “a read-only run disables custom settings, hooks and skills in its actual launch”; `chat.test.ts` actual captured-launch assertions. Both new argv assertions failed before source changes and passed afterward.
- Evidence limit: this is a demonstrated missing launch boundary and an observed corrected argv contract, not a model-powered exploit demonstration. Under the no-model-spend rule, actual Claude enforcement was not exercised. Older Claude releases without these flags will fail rather than run the unsafe fallback. Custom settings used for provider routing may also be excluded; README compatibility wording is owned by root.

### P1 — New PTYs could race git mutations after the “quiet checkout” check

- Location: `src/core/sessions.ts:275`, using the shared common-git-directory queue from `src/core/git-lock.ts`.
- Reproduction: hold an admitted git mutation after its quiet check, then start a stand-in coding session in the same repository. Previously the launcher ran while the mutation was still held.
- Fixed: launches, worktree creation and PTY spawn wait in the same per-common-git-directory queue as owner git mutations. Linked worktrees share the gate. This closes the app-internal race; external editors and git processes remain outside Wanigan’s queue.
- Tests: `session-git-race.test.ts`, “an agent launch waits until a pending checkout mutation finishes.” Observed pre-fix `launched === true` failure; post-fix it remains false until the mutation completes.
- Follow-up reproduced: pause/project-close/card-archive during that wait could still spawn an agent (paused/archived card then failed only when claiming; a closed project continued). `checkStart` now refreshes project/card and revalidates at queue admission and again immediately before spawn after asynchronous preparation. Three new tests failed before the follow-up fix and pass afterward with no launcher call and no session row.

### P2 — Automatic build replacement could kill newly admitted work or background answers

- Location: `src/main/core-process.ts:143`, `src/core/core.ts:143`, `src/core/server.ts:132`, `src/shared/protocol.ts:101`.
- Reproduction: mismatch handler previously read `sessions.list({live:true})`, saw zero and later SIGTERMed that PID. A session could start between check and kill; AI review/chat/Jev and account sign-in PTYs were not counted.
- Fixed: owner-only `core.stopIfIdle` synchronously checks admitted requests, all PTYs and background service work, freezes further requests, acknowledges, then shuts the core itself down. Main waits for that exit instead of automatically signaling. Old cores lacking the method are kept and require the existing explicit restart decision. No reservation is left awaiting a living window.
- Tests: `restart-idle.test.ts` verifies racing start refusal after accepted shutdown, refusal while a start request is admitted before its PTY exists, all service busy flags, an actual running stand-in review surviving the request, and a PTY omitted from board-session enumeration. The missing method tests initially failed, and the utility-terminal test separately failed with `{stopping:true,live:0,busy:false}` before the all-PTY correction. `main/core-process.test.ts` verifies a legacy core with `not_found` is not killed, plus quiet/live mismatch behavior. `jev-races.test.ts` is another reviewer’s complementary pending-key reservation coverage.
- Utility test limitation: it starts a real stand-in shell PTY and suppresses session enumeration to exercise the unlisted-PTY distinction; it does not run a real login flow.

### P2 — Codex composer could answer a startup/trust dialog

- Location: `src/core/sessions.ts:687`.
- Reproduction: start Codex stand-in, let the first screen print but emit no lifecycle notification, then queue a message. Previously text and Enter were delivered; a real first screen can instead be a folder-trust question.
- Fixed: Codex composer refuses until lifecycle evidence exists, explicitly directing the owner to answer startup questions and send the first message in the terminal. Later messages deliver after a turn’s notification/hook. No refused message is silently queued.
- Test: `codex-first-message.test.ts`, “the Codex composer refuses before lifecycle evidence, then delivers after a turn.” Original failed with missing rejection; fixed test confirms no written text or pending item before the first turn and successful delivery after a real OSC Stop notification from the stand-in. Attachment test now supplies the initial Stop hook before using the Codex composer.

### P2 — Sensitive terminals left disk output, including orphaned sign-in logs

- Location: `src/core/sessions.ts:149`, `:216`, `:436`; `src/core/scrollback.ts:18`.
- Reproduction: run a temporary ephemeral shell, type a fake secret, and inspect its own test data directory while live. It created a `.log` file. Sign-in terminals also wrote logs despite having no session row, so recovery driven by session rows did not remove their orphaned logs after a crash.
- Fixed: ephemeral and sign-in terminal scrollback is memory-only from the start. Recovery removes historical `signin-<uuid>.log`/`.log.tmp` records left by older builds. Ordinary session history keeps its disk tail.
- Tests: `ephemeral-search.test.ts` new “live replay in memory and never creates a disk record” plus “recovery removes sign-in records ... without needing a session row”; each observed failing before its correction, then passing. Existing crash/search behavior still passes.
- Limitation: old non-sign-in ephemeral compaction `.log.tmp` leftovers were not separately exercised; current sensitive terminals cannot create them. Files deliberately written by the agent itself are outside this scrollback guarantee.

### P2 — Agent-selected quote path could block the core on a FIFO

- Location: `src/core/review.ts:200`.
- Reproduction: create a FIFO in a temporary project and have an AI-review result cite a quote from that path. The quote verifier’s synchronous `readFileSync` blocked waiting for a writer, freezing the core. A pre-read size check also did not bound a file that grew afterward.
- Fixed: open nonblocking without following a last-component symlink; inspect the opened descriptor; accept only regular files; read at most 2 MiB + 1 and refuse oversized/growing input. Explicit scratch evidence remains supported.
- Test: `review-quotes.test.ts`, “a quote naming a FIFO is refused without blocking the core.” Original subprocess hit its 2-second timeout; fixed test returns `unsure`/`quoteFound:false` promptly. Existing inside/explicit-outside/other-outside quote tests pass.

### P2 — Literal strings in project Codex TOML caused quadratic parsing

- Location: `src/shared/toml.ts:210`.
- Reproduction: a one-line `args` array containing 650,000 `'x'` values (~2.6 MB, below MCP’s 4 MB accepted-file limit). The parser searched the entire remaining document for a newline for every string. Local measurement was ~18 seconds near this size; the regression subprocess timed out at 3 seconds.
- Fixed: inspect only the current quoted span for a newline.
- Test: `shared/toml.test.ts`, “a one-line config full of literal strings is read within a bounded time.” Red ETIMEDOUT before fix, green around 0.2 seconds afterward. Shared TOML and actual MCP suites also passed. No evaluation/shell interpretation is introduced.

### P3 — A single oversized terminal chunk bypassed the in-memory tail cap

- Location: `src/core/scrollback.ts:25`.
- Reproduction: append one 4 MiB string; the previous trimming loop only discarded chunks when there were at least two, retaining the entire oversized chunk.
- Fixed: trim an individual chunk to the tail limit before queueing it. Sequence and normal disk recording remain intact; sensitive terminals remain memory-only.
- Test: `scrollback.test.ts` oversized-chunk assertion failed before fix and now confirms the exact newest tail and size cap.

## Correct behavior verified

- `ACCESS` is the server-side method admission boundary, not merely a TypeScript/UI convention. `access.test.ts` calls every owner-only method from a real authenticated session socket and every session-only method from the owner, and checks unknown methods. New `core.stopIfIdle` is owner-only and covered by that enumeration.
- Session card operations reject foreign projects; explicit foreign `projectId` inputs are ignored in favor of the caller’s session project for scoped listings/creation. Ended session tokens retain only read access. Tests verify no foreign comments/cards were created.
- Session tokens are stored as hashes; private core directory/socket/token/info modes are tested as 0700/0600. This does not sandbox same-UID agents: SECURITY.md explicitly and correctly says processes already running as the user can read the owner’s files.
- Hook relay uses the per-session token, has a separate hook socket and never grants owner RPC access. Late hooks do not rewrite an ended session. Delayed hook bodies and malformed/oversized socket input have regression coverage. Claude/Codex hook definitions and Codex exact-hash trust/fallback are exercised with stand-in probes and the real relay.
- Claude first-message delivery already waits for its prompt hook, even after the no-hooks fallback changes displayed state. Bracketed-paste escape sanitization prevents a message from ending its own paste and injecting terminal keystrokes.
- Session life and resume tests exercise saved fake transcripts, lost/failed state, card release/claim, model/effort validation, refusal without spawning, and double-click reservation. `session-life.test.ts` verifies normal operation writes no settings/hooks/memory into the temporary project.
- Real spawned core-process tests demonstrate window disconnect survival, SIGKILL recovery with lost-session reporting, actionable startup failure, and build mismatch behavior. Headless stand-ins exercise deadlines and SIGTERM-resistant child cleanup. None run a model.
- Existing per-file terminal limits, attachment caps, headless time/output limits, evidence shape validation, prototype-key rejection in TOML, and bounded card/chat framing were inspected and selectively tested. Agent-writable text is treated as text, not owner RPC or a shell program, in those paths.

## Executed verification

All npm/Electron commands selected Node 22.23.2 with `nvm use` and unset `ELECTRON_RUN_AS_NODE` in the launching environment.

- Final `npm run typecheck`: PASS.
- Final focused command: `node scripts/run-electron-node.mjs --test src/core/restart-idle.test.ts src/core/session-git-race.test.ts src/core/single-core.test.ts src/main/core-process.test.ts`: PASS, 16 tests, exit 0 (~6.8 seconds).
- Immediately preceding broader command included the above (before the final utility case), plus `hardening.test.ts`, `worktree-setup.test.ts`, `board-rules.test.ts`: PASS, 39 tests, exit 0 (~14.7 seconds).
- Earlier targeted runs passed: shared TOML/shared MCP/core MCP (19 tests); headless/chat/review coverage (18); Codex-first-message/Claude-first-message/attachments/Codex-hooks/review-quotes (19); sensitive scrollback/access/session-life/paste escape coverage (20); and access/Jev races/replacement/core-process coverage (23). The root full-suite run is the final aggregate gate; do not substitute these overlapping counts for unique total coverage.
- `git diff --check`: PASS after final source edit.
- Each new bug regression above was observed failing before its corresponding fix, then passing. The active checkpoint preservation assertion extends the already-red single-owner test after moving admission earlier.

## Unverified and residual limits

- No actual model call, account login, real Remote Control session, external provider billing/metering, or real Claude/Codex lifecycle through a generated turn was performed. Stand-ins prove Wanigan’s transport, argv, state and recovery, not the CLI’s full runtime enforcement. Claude safe-mode requires a supporting CLI; no silent unsafe fallback exists.
- Slow-reader socket backpressure, sustained connection floods, and a long-duration disk/memory soak were not tested. Per-input and per-scrollback caps are not a global retention policy: accumulated SQLite history, attachments and many session files can still grow. The review does not certify a global resource quota or adversarial same-UID containment.
- Migration admission precedes the newly added core ownership lease; a future shipped schema migration needs mixed-version live-core analysis. No shipped migration was edited here.
- Fresh clone/install/package, release checksum/mount/demo isolation, all feature rows, renderer accessibility and full git/checkpoint semantics belong to parallel reviewers/root. This report does not claim those checks.
