# Relay recovery follow-up — 2026-09-19

This follows the local runtime audit and the spending follow-up. No provider calls, paid trials, credentials, production sessions or installed-application data were used. The authorized $50 audit allowance remains unspent.

## Behavior changed

- A restore approval now identifies one preview of one checkout, including its canonical directory identity, HEAD, real index and Git-visible tree. The opaque receipt expires after ten minutes or restart, is consumed once, and is invalidated by a newer preview for that session. Apply captures a safety checkpoint, compares the checkout again before mutation, and checks the target tree twice afterward. A changed checkout requires a new preview; an unverified partial restore reports failure and retains its safety checkpoint.
- A shared SQLite checkout-activity receipt excludes restore and known Wanigan writers in both directions, including overlapping parent/subdirectories. Only the runtime holding the release capability can clear that receipt. Time passing or an owner disappearing does not clear it.
- Hook-capable session launches await the pre-agent checkpoint before their final launch checks and PTY spawn. Failed preparation rolls back its claim, injected files and checkpoint registration. Directory or symlink replacement during preparation refuses the launch. Quit closes launch admission and waits, within its bounded drain, for pending preparation and final checkpoint/ownership cleanup. An exited terminal with a surviving process group retains its checkout and ownership.
- Review commands claim their canonical checkout durably, so another app or daemon cannot start the same review concurrently. Missing owners and expired leases preserve an unresolved claim and truthful command-state evidence. Graceful quit interrupts only this runtime's child handles and waits for the recorded outcome. Persisted process IDs are never used as authority to terminate a recovered process.
- An expired queue lease becomes a failed, unresolved item instead of automatically becoming runnable. It retains its original owner evidence, survives ordinary failed-item pruning, and rejects a late owner's attempt to overwrite the quarantine as success.
- Headless rows have an atomic execution claim and recorded runtime owner. Reopening does not confuse an earlier live process with a dead one. Unknown execution cannot be rerun or cleared by another process's cancel request. Checkout ownership lasts through command closure and cleanup; uncertain descendants remain visible as unknown. Quit closes admission even for a pending provider preflight and gives Git inspection, usage recording and ownership release a bounded drain after child closure.
- Worktree setup and teardown participate in the same restore exclusion. A successful shell exit can still leave a background service, so the command result and unresolved ownership are recorded separately. A clean phase clears its receipt only after command closure and observed group absence. Another live runtime's phase is preserved; an unavailable owner leaves unknown execution blocked from restore. Automatic removal preserves a checkout with unresolved setup or teardown commands. Explicit force removal remains an operator decision and still cannot overlap a restore.

Queue and Headless schemas and IPC handlers were first moved into required modules in behavior-preserving commit `8b29be9`. That conversion preserved schema ordering, historical rows, idempotent migration and eleven IPC contracts. Recovery behavior belongs to the following fix commit, not the conversion.

## Evidence and boundaries

The regression fixtures use disposable Git repositories, isolated SQLite and local processes. Review tests include an actual expired 30-second lease with the owner paused, an owner killed while its command keeps writing, competing owners, a redirected background descendant, shutdown during inspection and legacy reopening. Queue tests likewise keep a real writer alive across owner death or lease loss.

The pre-launch checkpoint regression failed before the async barrier: its launch snapshot contained the first agent edit. After the fix, the snapshot contains the pre-existing dirty bytes while HEAD and the real index remain unchanged. Three additional session regressions failed before their fixes: cleanup removed a still-owned worktree, quit returned before checkpoint cleanup, and a preparing launch spawned during quit. These use production session orchestration with explicit PTY/account/timer test doubles; they are not native provider sessions.

The [renderer evidence](../visuals/relay-recovery-2026-09-19/README.md) includes before/after confirmation and refusal screenshots in both themes. Its synthetic bridge verifies that the exact preview token reaches the restore call; it does not establish native IPC or real Git restoration. The existing terminal replay probe passed all five assertions using real Electron and xterm.

## Final verification

On Node `22.23.2`, `npm test` completed with exit status 0 through all eight required gates: typecheck, shared tests, renderer style, dead code, lint, package hooks, local installation and offline smoke. The smoke suite reported **2,702 passed, 0 failed**. The shared stage includes **22 session reliability tests**; the recovery scripts appended to the slower smoke stage passed **8 Review tests, 9 Queue/Headless scenarios and 6 Worktrees tests**.

The first smoke integration run had two failing source-contract assertions still matching the old worktree environment argument and pre-guard cleanup condition. Both were updated to assert the new canonical directory and confirmed-stop condition; the final full run passed. No behavioral assertion was removed.

The separately required terminal replay probe passed all five checks. Both renderer probe runs passed three assertions and produced the before/after screenshots described above. `git diff --check` passed. These are local conformance results, not measured model quality or cost per accepted coding result.

## Remaining limits

- Quarantine is a conservative hold, not automatic process recovery. This change does not provide a reconciliation/reset UI or safely adopt processes from a dead owner. Recovered commands can remain alive, and unresolved ownership blocks the affected operations until a separate reconciliation path is implemented.
- POSIX group absence is an observation at cleanup time, not OS containment. Independently started writers and descendants that escape their original group are not comprehensively tracked. Windows has no equivalent process-tree extinction proof in these paths and conservatively retains uncertain ownership.
- Old worktree setup phases already recorded as completed before ownership receipts existed cannot be retrospectively proved free of background services. Legacy running phases are held, but completed legacy services require separate inspection. Other explicit manual Git/worktree operations are not made transactional by this change.
- Git tree checks cover Git-visible contents. They do not make the filesystem transactional, cover ignored files, or prevent an unrelated program from writing after verification.
- This is not a full installed-app crash/reopen trial with a native provider PTY. Account-aware availability, MCP conformance, provider billing and accepted-result coding trials remain separate audit work.
- Database backup restoration is a separate unresolved boundary: restoring an older database can discard newer checkout-ownership receipts. Its current pre-dialog local live-session count does not establish that every app/daemon writer has stopped. That unconverted surface needs its own module conversion and coordinated exclusion at the database swap, including a recheck after dialogs. These checkout guards do not establish safety across database rollback.

Unknown state is deliberately retained instead of being described as a stopped process, a safe retry or a completed restoration.
