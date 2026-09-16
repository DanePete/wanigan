# Wanigan: unfinished and broken existing features

Audit date: 2026-09-15, America/Chicago. Scope: the current working tree, including the recent checkout-aware review implementation and other uncommitted changes. This is an audit, not an implementation change or an exhaustive certification of the product.

**Implementation follow-up:** These observations describe the pre-repair snapshot. The [repair record](2026-09-15-existing-feature-repairs.md) documents the implemented behavior and verification.

The audit found **16 concrete defects and one unfinished backend-to-UI flow**. The most consequential defects allow approval without checking every branch, let mobile freshness survive content changes, omit generated outputs from backups, and lose the connection between isolated sessions and their transcripts.

## Priorities

P1 means incorrect approval, incomplete recovery, missing session evidence, or unintended repeated execution. P2 means a reproducible workflow or evidence defect under the stated conditions. These are repair priorities, not security vulnerability ratings.

| ID | Priority | Existing feature | Failure |
| --- | --- | --- | --- |
| F01 | P1 | Mobile Git and review | Further edits to an already-modified file leave the freshness digest unchanged. |
| F02 | P1 | Goal verification | One shared verifier can approve multiple implementation branches after checking only the first. |
| F03 | P1 | Backups | Generated outputs in session attachment directories are excluded as though they were replaceable input copies. |
| F04 | P1 | Isolated session history | Transcript archival searches the base repository's location instead of the session worktree. |
| F05 | P1 | Terminal replay | Live output arriving while xterm parses its snapshot is dropped from the pooled display. |
| F06 | P1 | Headless schedules | Per-schedule overlap protection ends at queue handoff rather than run completion. |
| F07 | P2 | Goal review recovery | Completed verification has no visible rerun action after its proof becomes stale. |
| F08 | P2 | Backup inspection | New review results can be omitted from the “would discard newer work” check. |
| F09 | P2 | Session exit evidence | Signal exit normalization reaches memory but not durable history or exit broadcasts. |
| F10 | P2 | Codex quota badge | The selected session's badge reads the global default account. |
| F11 | P2 | MCP configuration | The advertised project placeholder splits paths containing spaces into separate arguments. |
| F12 | P2 | Autopilot cancellation | Canceling a waiting dispatcher item leaves the task marked queued. |
| F13 | P2 | Learned skill usage | A skill invocation can be attributed to another project's or provider's knowledge item. |
| F14 | P2 | Plugin catalog | A failed installed-list read is presented as confirmed absence. |
| F15 | P2 | Context badge | An unconfirmed transcript fallback is presented as selected-session context pressure. |
| F16 | P2 | Schedule timing | Autumn clock rollback can produce a next-fire timestamp in the past. |
| U01 | Unfinished | Attachment retention | Retention and reclaim functions exist, but have no IPC/preload/UI connection. |

## Verification method

No product code or live user database was changed. No provider, agent workload, MCP server, phone commit, or restore was launched. Disposable fixtures used `/private/tmp`.

- **Control/scheduling:** bundled current production modules with real SQLite migrations, Git worktrees and local shell checks. Only Electron host facilities were stubbed. The overlap case seeded the durable queue state produced by handoff; it did not launch a provider. The root agent independently reran this probe successfully.
- **Backups:** ran the production backup/database/review modules in isolated Electron with temporary user data, a real database, a generated-output fixture and a harmless `true` review command. Created and inspected a backup; did not restore it.
- **Mobile/integrations:** executed exact functions extracted from current TypeScript with controlled dependencies. Mobile digest inputs came from a real temporary Git repository. The root agent independently reran this probe successfully.
- **Sessions:** executed current TypeScript with controlled transcript/account/terminal fixtures. The root agent independently reran the probe. A separate real installed `node-pty` process running only `/bin/sh -c 'kill -TERM $$'` confirmed the raw signal event.
- **UI reachability:** traced renderer → preload → main calls and guards in source. This audit does not claim full live UI or phone automation coverage.

The observations below preserve the significant fixture results. Temporary runners are listed at the end; they are audit tools, not committed regression tests. The full product test suite was not rerun for this documentation-only audit.

## F01 — Mobile review and commit freshness ignore changed contents

**Trigger:** Read a modified tracked file on the phone, then let the agent modify that same file again without changing its Git status letters or path. The same problem affects a passing review gate followed by another edit.

**Observed:** Two different patches produced identical status/path rows and the same digest, `eee87d1681495f233f2cde81b8a52eed`. This is ordinary content change, not a hash collision.

**Cause:** [mobile/git.ts](../../src/main/mobile/git.ts#L427) defines the reading using branch, operation, file path/status/location and dropped count. `repoDigest` at line 467 hashes those fields, without content, index object identities or HEAD. The commit handler at lines 1422–1439 accepts the matching digest and calls `gitCommit` with `all: true`; [git.ts](../../src/main/git.ts#L629) translates that to `git commit -a`. Gate freshness uses the same digest at lines 1283 and 1309 rather than the persisted checkout evidence. [The mobile page](../../src/main/mobile/page/sections/git.ts#L497) nevertheless says the gate passed against exactly these files.

**Impact:** The commit handler can accept a reading predating the bytes it commits, and the gate can retain a misleading current/pass indication. No actual phone commit was attempted; digest equality was reproduced, while acceptance and commit behavior were traced through the handler.

**Repair:** Bind review claims and commit intent to content-sensitive checkout evidence. Use stale/unavailable states when identity cannot be established, and avoid wording that implies an atomic guarantee against concurrent filesystem edits.

## F02 — Shared verification checks one implementation branch but approves the goal

**Trigger:** Two parallel implementation tasks A and B have separate worktrees. One verification task depends on both, followed by final review. This is an accepted graph; [Control's guide](../../src/renderer/src/views/Control.tsx#L564) describes parallel implementation followed by review.

**Observed:** Put a `broken` file only in B and use the real recipe `test ! -f broken`. It fails in B, but shared verification selects A and final review accepts the goal:

```json
{"proofStatus":"passed","selectedTree":"A","goalStatus":"accepted","treeBActuallyFails":true}
```

**Cause:** [control.ts](../../src/main/control.ts#L774) `verificationTree()` returns the first reachable live implementation worktree. `runProof()` at line 787 checks only that cwd. Final approval at line 886 checks all verification nodes, which does not establish that all implementation branches, or their combined result, were tested. The current content-freshness guard correctly identifies A; it cannot extend A's proof to B.

**Repair:** Refuse ambiguous shared verification or require an explicit integration checkout with recorded source revisions. Separate per-branch tests help coverage but do not prove that the combined changes work together.

## F03 — Backups omit generated outputs while calling them replaceable copies

**Trigger:** An agent creates a report, image or other sole-copy output in its session attachment directory; the operator relies on a Wanigan backup for machine migration or disk recovery.

**Observed:** A real backup omitted a fixture output that existed only under the session attachment tree. Its exclusion list said every attachment is a copy of a file the user already has.

**Cause:** [backup.ts](../../src/main/backup.ts#L50) makes that assertion in `EXCLUDED`. The actual copy steps at lines 290 and 309 preserve the database and transcript files, not session attachment directories. In contrast, [sessions.ts](../../src/main/sessions.ts#L1690) preserves those directories on exit specifically because agents place generated reports/assets there, and [Settings](../../src/renderer/src/views/Settings.tsx#L5123) explains that saved conversations depend on those outputs.

**Impact:** Backup recovery onto a fresh machine can restore the conversation record without its only output files. The omission is declared, but its justification incorrectly implies the files are recoverable elsewhere. This probe tested backup contents, not a restore or an actual disk-loss event.

**Repair:** Include agent-produced artifacts, or offer an explicit artifact backup inventory/option. Replace the claim that everything in this directory is a replaceable input copy. Coordinate this with U01 before exposing cleanup.

## F04 — Isolated Claude sessions archive from the wrong directory

**Trigger:** Transcript archival is enabled. A Claude-harness session runs in an isolated worktree and writes its conversation under that cwd.

**Observed:** A synthetic exact transcript existed under the worktree's Claude project directory. The current exit call using the base project path returned `ok:false`; the same locator using the worktree found it with `exact:true`. Adding a different conversation under the base directory caused the fallback to select that unrelated file.

**Cause:** [sessions.ts](../../src/main/sessions.ts#L1687) calls `archiveSession(id, live.meta.projectPath, ...)`, although metadata separately retains `worktree`. [transcripts.ts](../../src/main/transcripts.ts#L336) derives the search directories from the supplied path and never corrects it from the recorded worktree. The live context reader already uses `s.worktree ?? s.projectPath` in [main/index.ts](../../src/main/index.ts#L2195).

**Impact:** Recent/history can lack an archive even though the exact source transcript exists. A lifetime fallback can attach another root-repository conversation; its inexact warning is retained and displayed, so this is not wholly undisclosed substitution. The failed archive return is ignored by the exit handler.

**Repair:** Use the recorded effective session cwd for archival and related transcript lookup. Preserve exact/fallback provenance and add an isolated-worktree archive regression.

## F05 — Terminal replay drops output during asynchronous parsing

**Trigger:** First mount a running terminal. Main returns its scrollback snapshot; new output arrives before xterm finishes parsing that snapshot. Large replay buffers increase the opportunity.

**Observed:** The controlled xterm probe received `SNAPSHOT`, then `POST-SNAPSHOT-OUTPUT`, then completed parsing and received `LATER-OUTPUT`. The actual component wrote only:

```json
["SNAPSHOT", "LATER-OUTPUT"]
```

**Cause:** [TerminalPane.tsx](../../src/renderer/src/components/TerminalPane.tsx#L140) drops broadcasts whenever `priming` is true. At line 296, priming remains true until xterm's asynchronous parse callback. Output arriving after the snapshot is not included in that snapshot, and `pendingLocal` buffers only locally composed text. The main IPC ordering assumption covers the snapshot boundary, not this extra parsing interval.

**Impact:** Bytes remain absent from the current pooled terminal display, potentially disturbing TUI cursor state. Ordinary navigation does not repair it because priming happens once. Main still retains bytes in its bounded ring; rebuilding the pane may recover retained bytes. This is not evidence of deleted provider transcripts or database records.

**Repair:** Separate snapshot/stream ordering from suppression of xterm's outbound replies during replay, or buffer post-snapshot chunks until parsing ends. Preserve the existing prevention of duplicate pre-snapshot output.

## F06 — Scheduled headless work loses overlap protection after handoff

**Trigger:** A schedule's period is shorter than its headless run. Its parent queue item hands off to repository child items, then another occurrence becomes due before the children finish.

**Observed:** With the first `schedule_runs` row still running, a second tick enqueued another occurrence:

```json
{"firstFireStatus":"running","secondFire":1,"history":[{"status":"running"},{"status":"queued"}]}
```

**Cause:** [schedule.ts](../../src/main/schedule.ts#L237) counts outstanding queue rows carrying `payload.scheduleId`. The parent awaits `startHeadlessRun()` in [main/index.ts](../../src/main/index.ts#L1000), but [headless.ts](../../src/main/headless.ts#L713) returns after enqueueing child work. Child payloads at main/index.ts line 1067 carry `{runId, projectId}`, without the schedule identity. The parent finishes while the actual run is unfinished. This contradicts schedule.ts lines 689–695, which explicitly promise that long runs are skipped rather than stacked.

**Impact:** With spare global worker slots, successive runs for the same schedule can overlap. With all slots busy, an extra occurrence can queue instead of being skipped; that waiting parent then suppresses further occurrences until handoff. As handoffs proceed, multiple runs can remain unfinished. Global queue capacity remains enforced. The fixture reproduced durable-state handling; provider execution and resulting spend were not exercised.

**Repair:** Keep per-schedule suppression tied to unfinished run ownership through completion/cancellation/failure, including restart recovery, rather than just the handoff queue row.

## F07 — Completed verification has no visible stale-proof recovery action

**Trigger:** Finish verification, then edit checked content or the recipe before final review. Approval correctly refuses the stale proof and tells the operator to rerun the gate.

**Observed:** A new standalone check passed with current evidence, but the verification task remained bound to its old run. Approval still failed, and reopening returned: `Only a failed or canceled task can be reopened; this task is completed.`

**Cause:** [Control.tsx](../../src/renderer/src/views/Control.tsx#L681) defines actionable tasks as ready/running and only shows Run gate for actionable verification tasks at line 695. [control.ts](../../src/main/control.ts#L1204) limits reopen to failed/canceled tasks. Goal proof binds a specific review run at lines 822 and 843, so standalone checks do not update that binding. Calling `control.runProof(completedVerifyId)` directly works, but there is no visible action for it in this state.

**Impact:** The correct refusal becomes a workflow dead end in Control. This is a recovery gap exposed by the recent stronger freshness check, not a reason to weaken that check.

**Repair:** Expose a deliberate rerun for completed verification, rebinding the task's proof while preserving downstream approval checks.

## F08 — Backup inspection can miss newer review evidence

**Trigger:** Take a backup, then save/run a standalone review without a newer learning signal or another clocked event. Disabling learning is one concrete desktop path: [observeReviewResult](../../src/main/learning-service.ts#L1900) then returns without recording a signal.

**Observed:** The real review run passed and ended at `1789524950368`, but inspection still reported the fixture's old timestamp:

```json
{"backupEvidenceAt":2000,"currentLatestEvidenceAt":2000,"wouldDiscardNewer":false,"problems":[]}
```

**Cause:** [backup.ts](../../src/main/backup.ts#L154) omits `review_runs` and `review_recipes` from `EVIDENCE_CLOCKS`. Inspection compares only the resulting maxima at lines 520–521. [Settings](../../src/renderer/src/views/Settings.tsx#L5530) turns false into the broad assertion that restoring would drop no recorded work.

**Impact:** The warning can hide a rollback of newer check results and recipe changes. A learning signal can incidentally advance the clock, so this is not claimed for every desktop check. Restore moves the replaced database aside; the defect is an inaccurate loss warning, not immediate irrecoverable deletion. No restore was performed.

**Repair:** Include review lifecycle/recipe updates in the evidence clock and test each durable feature's contribution. Avoid asserting database equivalence from an incomplete maximum timestamp.

## F09 — Signal-killed sessions retain exit code zero in durable records

**Trigger:** node-pty reports a signal separately with raw `exitCode:0`. A disposable real shell killed by SIGTERM produced `{"exitCode":0,"signal":15}`.

**Observed:** The current exit-handler fragment produced:

```json
{"liveExitCode":143,"persistedExitCode":0,"broadcastExitCode":0}
```

**Cause:** [sessions.ts](../../src/main/sessions.ts#L1651) normalizes the live metadata to `128 + signal`, then saves raw `exitCode` at line 1663 and broadcasts it at line 1730. [TerminalPane.tsx](../../src/renderer/src/components/TerminalPane.tsx#L191) prints that broadcast value. Recent's API reads the durable value; the new SessionHistory view does not itself display exit codes.

**Impact:** The terminal exit line and lasting operational evidence report zero while live metadata correctly says 143. Not every operator stop or crash necessarily produces this exact raw event.

**Repair:** Use the normalized value consistently in persistence and broadcasts. Verify ordinary numeric exits as well as signal exits.

## F10 — Selected Codex quota is read from the default account

**Trigger:** Select a Codex session launched with a non-default account or a project account override.

**Observed:** The exact account resolver chose `/fixture/default` with no identity, versus `/fixture/session` with the frozen session account. The current badge path sends no identity. No real account or network request was made.

**Cause:** [App.tsx](../../src/renderer/src/App.tsx#L1505) calls `codex.status(force)`. [preload/index.ts](../../src/preload/index.ts#L196) accepts only that flag, and [main/index.ts](../../src/main/index.ts#L2144) calls `readCodexStatus` without an account. [codex-status.ts](../../src/main/codex-status.ts#L290) then resolves the global default, despite already supporting account-scoped reads. Launch separately freezes the correct account in [sessions.ts](../../src/main/sessions.ts#L1382).

**Impact:** Changing the selected session or refreshing can continue to show another account's remaining/reset windows under a selected-session label.

**Repair:** Pass session identity through the typed API and resolve its frozen account in main. Do not allow a renderer-supplied path to select account files.

## F11 — MCP project-path substitution breaks arguments containing spaces

**Trigger:** Use Settings' advertised arguments, `-y @modelcontextprotocol/server-filesystem {{PROJECT_PATH}}`, for `/private/tmp/My Project`.

**Observed:** The real config-writing function with filesystem/trust fixtures generated:

```json
["-y", "@modelcontextprotocol/server-filesystem", "/private/tmp/My", "Project"]
```

**Cause:** [mcp/registry.ts](../../src/main/mcp/registry.ts#L696) runs `splitArgs(fill(s.args))`: expansion happens before tokenization. Consent preview at line 309 uses the same ordering. [Settings](../../src/renderer/src/views/Settings.tsx#L4530) supplies the unquoted example and describes one entry as reusable across projects.

**Impact:** A common project path becomes multiple arguments and can fail or point the server at unintended roots. No server was launched. Manually quoting the placeholder helps ordinary space-only paths, but the advertised configuration remains broken.

**Repair:** Parse the saved argument template first, then expand within each argv element. Keep consent preview and launch config identical.

## F12 — Queue cancellation strands an autopilot task as queued

**Trigger:** Arm autopilot, cancel a waiting task in Settings → Dispatcher, then disarm/rearm or try to start it normally.

**Observed:** `cancelQueued()` returned true; sweeping after rearm added no work:

```json
{"enqueuedAgain":0,"node":{"status":"ready","queued":true,"sessionId":null},"queueState":"canceled"}
```

**Cause:** [queue.ts](../../src/main/queue.ts#L193) changes only the queue row. [control.ts](../../src/main/control.ts#L1364) only enqueues tasks with a null dispatch marker; disarm at line 1254 changes only the autopilot flag. A canceled item never reaches the runner that would clear its marker. [Control](../../src/renderer/src/views/Control.tsx#L691) and [Board](../../src/renderer/src/views/Board.tsx#L256) hide ordinary Start for queued tasks.

**Impact:** Normal Start/rearm cannot recover the task. There is a less obvious workaround: Agent task records → Cancel task, then Reopen clears the marker. It is therefore stranded in the normal flow, not permanently unrecoverable.

**Repair:** Synchronize cancellation with the owning task's state or reconcile canceled/missing queue ownership before rendering and dispatching.

## F13 — Skill-use metrics can credit the wrong knowledge item

**Trigger:** Two projects have applied learned skills with the same directory name. The current session invokes the older project's skill after the other project's projection was applied more recently. Plugin namespaces can also collide.

**Observed:** With newer project B and older project A projections named `review/SKILL.md`, the resolver returned B for `review`, for `unrelated-plugin:review`, and even as a fallback for another provider. No live metrics were written.

**Cause:** [learning-service.ts](../../src/main/learning-service.ts#L1809) accepts identifier/provider without project or execution root, strips namespaces, queries applied projections globally newest-first, matches basename, then falls back across providers. The real Skill observation path writes invocation metrics against that choice at lines 1833–1841. [optimizer.ts](../../src/main/learning/optimizer.ts#L57) counts those item metrics and uses them in its no-observed-use decision.

**Impact:** Usage/ROI evidence is credited to an item that was not invoked while the actual item can appear unused. This finding concerns operational attribution, not cross-provider semantic content transfer.

**Repair:** Resolve within the session's applicable provider/project/scope, preserve namespaces, and leave ambiguous observations unattributed.

## F14 — Plugin installed-list failures become confirmed absence

**Trigger:** CLI catalog refresh reads available entries successfully, but reading installed plugins times out or fails.

**Observed:** A successful available-list fixture and failed installed-list fixture produced `note:null`, `installed:false`, `enabled:false`, and renderer state `absent` even when local settings indicated registration.

**Cause:** [plugins.ts](../../src/main/plugins.ts#L565) checks only available-list success, turns failed installed output into an empty map, then returns no error note at line 597. [Plugins.tsx](../../src/renderer/src/views/Plugins.tsx#L103) treats that as a reliable CLI catalog; its resolver at lines 46–51 overrides local evidence. The page then labels the discrepancy and says enablement was read from the CLI.

**Impact:** A read failure is misrepresented as an observed absence, making working plugins look incorrectly registered. No actual CLI was launched for this fixture.

**Repair:** Preserve unavailable installed-state independently, or propagate the error so the existing local-scan fallback remains authoritative.

## F15 — Context badge drops fallback provenance

**Trigger:** A selected Claude session lacks its exact conversation file, but another transcript in the same search roots falls within its lifetime window.

**Observed:** The actual label formatter returned `ctx 95% · 190k/200k` for both an unconfirmed lifetime fallback and a fresh exact sample. The header also applied the same near-full styling.

**Cause:** [transcripts.ts](../../src/main/transcripts.ts#L927) returns `conversationMatch:'lifetime-fallback'` plus timestamp and window provenance. [provider-status.ts](../../src/shared/provider-status.ts#L134) and [App.tsx](../../src/renderer/src/App.tsx#L1572) omit the match distinction; App's line 1596 treats the percentage as selected-session pressure. [The orb reader](../../src/renderer/src/orb/context-story.ts#L18) already marks unconfirmed readings and excludes unmatched pressure. App also calls every known window “assumed” even when the reader reports a CLI-sourced window.

**Impact:** Another parallel conversation can make the selected session appear nearly full. An old exact reading alone is not evidence of incorrect identity: the tooltip already says “last recorded turn.” The central defect is undisclosed fallback identity and its use as pressure.

**Repair:** Share provenance-aware formatting and pressure eligibility, exposing match, timestamp and reported/assumed window source consistently.

## F16 — DST rollback can calculate a next fire in the past

**Trigger:** In `America/Chicago`, calculate a next fire during the second occurrence of 01:10 on 2026-11-01, such as after wake/reopen or rearming during the repeated hour.

**Observed:** The production function returned:

```json
{"cron":"* * * * *","from":"2026-11-01T07:10:00.000Z","next":"2026-11-01T06:11:00.000Z","nextIsPast":true}
```

**Cause:** [schedule.ts](../../src/main/schedule.ts#L93) starts with local-time setters that resolve the ambiguous clock time to its first occurrence. The return at line 136 does not enforce strictly-after. The scheduler selects overdue entries at line 611, stores the calculated next value at line 711 and ticks every 20 seconds at line 771.

**Impact:** A schedule can remain overdue after firing and dispatch again as queue items finish, contrary to the documented once-on-reopen behavior. Capacity and outstanding-work checks still apply. A continuously running schedule already advanced beyond the repeated hour need not hit this case. The past timestamp was reproduced; a full hour of dispatch was not run.

**Repair:** Advance candidate instants monotonically and require `next > from`, preserving explicit local cron semantics for both repeated and skipped hours.

## U01 — Attachment retention exists in main but is not connected

[attachments.ts](../../src/main/attachments.ts#L1097) implements retention settings, a reclaim plan at line 1205, and execution at line 1334. Searching production call sites found no main IPC, preload or renderer route to these functions. [Settings](../../src/renderer/src/views/Settings.tsx#L5130) explicitly admits that this screen cannot measure or reclaim the directories.

This is an unfinished flow, not a falsely functioning button. Session directories accumulate, including generated outputs. Finish the preview/selection/confirmation and reporting flow only after resolving the backup coverage in F03; reuse the existing backend protections rather than introducing blanket deletion.

Two other inspected boundaries are already explicit product limitations: Codex transcript archival is unsupported, and the A/B register stores supplied outcomes rather than launching paired evaluations ([Learning.tsx](../../src/renderer/src/views/Learning.tsx#L2948)). They were not counted as newly discovered defects.

## Suggested repair sequence

1. Close false approval/commit claims: F01, F02; complete verification recovery at the same time (F07).
2. Preserve output and session evidence: F03, F04, F05, F09; correct backup loss detection (F08).
3. Correct unattended lifecycle ownership: F06, F12, F16.
4. Correct account, argument and evidence attribution: F10, F11, F13, F14, F15.
5. Finish attachment retention (U01) once its recovery and artifact-preservation behavior is reviewable.

Each repair should turn its triggering case into a regression at the narrowest meaningful boundary. Keep the existing freshness guard, queue limits, explicit unsupported states and restore safeguards.

## Temporary reproduction inventory

These files were created for this audit under `/private/tmp`; the durable observations are recorded above because temporary files can disappear.

| Area | Runner/build files | Observed result |
| --- | --- | --- |
| Control, queue, schedule | `wanigan-audit-control-build.cjs`, `wanigan-audit-control-probe.cjs` | Build and execution exited 0; reproduced all five cases. Latest root fixture: `wanigan-control-audit-kZLJRv`. |
| Backup | `wanigan-audit-backup.ts`, `wanigan-audit-backup-runner.mjs` | Isolated Electron execution exited 0; result at `wanigan-audit-backup-8fHw1D/result.json`. |
| Mobile, MCP, learning, plugins | `wanigan-audit-integrations-probe.mjs` | Assertions passed; root rerun exited 0. |
| Transcript, terminal, quota, context, exit handler | `wanigan-audit-sessions-probe.cjs` | All five source probes passed; root rerun exited 0. |
| Actual PTY signal event | `wanigan-audit-nodepty-exit.cjs` | Exited 0 after printing `{"exitCode":0,"signal":15}`. |

Node probes used the repository's pinned Node 22.23.2. The Control runner used Electron Node mode for the native SQLite binding. No claim is made that these isolated probes replace the required product suite when implementing fixes.
