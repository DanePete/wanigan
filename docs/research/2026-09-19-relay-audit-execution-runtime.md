# Relay audit execution: runtime, restore and process ownership

Executed 2026-09-19 against `324bca7f137198a78583ec9b8cb07cfd1c667c71`, Node `22.23.2`, macOS. This audit reproduced unsafe restore and incomplete process-ownership behavior using production modules with real temporary Git repositories, SQLite databases, APFS copies and local processes. It made **no provider or paid call**, changed no product source, and did not touch production user data or app processes.

The most direct user-data finding is that restoring an approved checkpoint can delete a file created **after** the preview. A safety checkpoint restored that file in the negative control, but the newly affected deletion was never reviewed. A separate test restored successfully while a real writer continued editing.

## Scope and evidence

The coordinator created the disposable source clone and independent dependency tree at `/private/tmp/wanigan-relay-audit-vxcyorcv/repo`. Fixtures used separate `runtime`, `runtime-extended` and `runtime-verification` subdirectories; subprocesses received fixture HOME and a lab-owned provider-pack path. No account credentials, native account homes, network requests, repository hooks or package lifecycle scripts were used.

Production TypeScript was transpiled without rewriting it. Substituted collaborators were the database accessor, fixture project/settings/root-policy responses, Electron's userData path, and worktree setup callback. SQLite itself, Git, filesystem operations, APFS `cp -c`, review shell commands, owner death, descendants and the 120-second queue lease were real. The two deliberate fault injections are identified separately below. Main-process modules were loaded in Node, so this is **not** evidence that the full Electron app, typed IPC or native hooks completed these scenarios.

Artifacts:

- [Reproduction harness](relay-audit-2026-09-19/runtime/runtime-fixtures.cjs.txt), including bounded fixture cleanup.
- [Core results](relay-audit-2026-09-19/runtime/core-results.json): R01–R10 and seven dependency cases.
- [Concurrent review results](relay-audit-2026-09-19/runtime/concurrency-results.json): R11.
- [Verification edge results](relay-audit-2026-09-19/runtime/verification-results.json): R12.
- [Collection and assertions](relay-audit-2026-09-19/runtime/collect-evidence.cjs.txt) and [verification receipt](relay-audit-2026-09-19/runtime/artifact-verification.json): 19 scenario records checked; all 17 recorded fixture PIDs absent afterward; sanitized artifact hashes recorded.

Artifacts substitute `$LAB`, `$WORKSPACE` and `$NODE22` for local roots. They retain timestamps, fixture session/checkpoint/run identities, Git identities, process ids, source hashes and exact production results. They contain synthetic fixture bytes only. Core execution ran from 18:56:24 to 18:58:25 UTC, including the real lease recovery; the final verification scenario finished at 18:58:55 UTC. Artifact assertions and process-cleanup checks were rerun at 19:03:05 UTC, as recorded in the final verification receipt. These short windows are not soak-test evidence.

## Reproduced findings

| Finding | Severity / status | Exact observation and consequence | Owner / source |
| --- | --- | --- | --- |
| RT-01: apply is not bound to the preview | High; reproduced, R01 | Preview listed one `tracked.txt` restoration and zero deletions. Creating `unreviewed.txt` afterward and applying the same checkpoint returned `ok:true`, restored one file and deleted one. The post-preview file was deleted without refreshed review. Restoring the returned safety checkpoint recovered its original bytes; HEAD and index hashes were unchanged. Recovery helps, but does not bind approval to the changed file set. | Required Checkpoints extension; [plan/apply](../../src/main/checkpoints.ts#L356), [CodePanel sends only checkpoint id](../../src/renderer/src/components/CodePanel.tsx#L262). |
| RT-02: restore accepts an active writer | High; reproduced, R02 | A real child appended to `live.txt` every 30 ms. Preview and apply succeeded while the writer remained alive; apply reported deletion and the file existed again 150 ms later. The returned success did not describe a stable restored tree. No live-session ownership check was supplied by the fixture or read by this production entrypoint. | Required Checkpoints extension; [preconditions](../../src/main/checkpoints.ts#L342), [apply](../../src/main/checkpoints.ts#L385). |
| RT-03: review owner death leaves a command running while recovery says it stopped | High; reproduced at module/process boundary, R07 | Production `review.runAt` launched a detached shell with a child writer. SIGKILL ended its real Node owner; the descendant remained alive and its sentinel grew from 6 to 60 bytes. A fresh module/database connection swept the row to `failed`, appending “the commands went with it.” No process lookup or termination accompanied that assertion. The harness then killed the owned group. | Required Review extension; [detached spawn](../../src/main/review.ts#L288), [recovery sweep](../../src/main/review.ts#L198). |
| RT-04: concurrent review processes can both own one checkout | High at shared-database boundary; reproduced, R11 | Two real Node owners loaded production Review against the same database/checkout. Both owners and both command descendants remained alive. The second process marked the first row failed, then created its own running row. Same-process `activeRoots` correctly rejects duplicate checks, but is not a durable cross-process lease. Whether an actual supported UI/daemon combination can reach this entrypoint concurrently remains unexecuted. | Required Review extension; [process-local active roots](../../src/main/review.ts#L357), [sweep age rule](../../src/main/review.ts#L198). |
| RT-05: checkpoint registration has no pre-edit barrier | Medium; reproduced at registration boundary, R06 | Pre-existing dirty bytes were written before `registerSessionCheckpoints`. An actual child immediately replaced them after registration returned. The first successful `session-start` checkpoint contained `agent first edit`, not the pre-agent dirty bytes. This fixture deliberately sets `hooksCapable:true`; it proves the asynchronous ordering problem and **does not** establish native hook support. Production Sessions spawns the PTY before calling registration, which offers no stronger barrier. | Required Checkpoints and Sessions extensions; [async registration](../../src/main/checkpoints.ts#L92), [PTY spawn](../../src/main/sessions.ts#L1618), [later registration](../../src/main/sessions.ts#L1728). |
| RT-06: an expired queue lease is not proof its child stopped | High recovery design concern; reproduced for a registered fixture runner, R10 | Two real owners competed for one production queue row: only one started while its lease was valid. After that owner was SIGKILLed, its detached writer survived. At **120,469 ms**, without clock substitution or database-expiry edits, the second owner recovered the lease and started a second writer. Both were writing; attempts increased from 0 to 1. This is not an observed duplicate provider call: the registered runner was a sentinel adapter. | Queue execution kernel; [atomic claim](../../src/main/queue.ts#L453), [expired-lease recovery](../../src/main/queue.ts#L630). |

RT-03 also reproduced with a Node owner handling SIGTERM by `process.exit(0)` (R08; sentinel 6→54 bytes). That is a **normal Node owner exit**, not an execution of Electron's `before-quit` handler. Source inspection of [before-quit](../../src/main/index.ts#L867) and [stopServices](../../src/main/index.ts#L1570) found awaited session/headless shutdown but no review-command shutdown handle. The full app's graceful-quit guarantee remains blocked pending an isolated app fixture.

RT-06 must not be inflated into a production duplicate-spend claim. [Headless `sweepInterruptedRows`](../../src/main/headless.ts#L552) marks earlier running rows errored, and [runRow](../../src/main/headless.ts#L908) refuses to rerun terminal rows. That is a relevant mitigation absent from the generic sentinel runner. Headless agents are [actually detached](../../src/main/headless.ts#L1318), so the survivor concern is relevant, but provider-side cancellation, production runner reconciliation and the native PTY lifecycle require their own execution evidence. Its interrupted-row text also claims the agent went away without storing a process-ownership proof.

No fixes were made. Checkpoints and Review already have required module declarations; any Sessions/queue/headless changes must follow the repository's current extension rules. The affected restore and recovery paths should not be used to justify a live paid trial until their unresolved guarantees are addressed.

## Passing controls and deliberate limits

| Boundary | Observed result | Evidence |
| --- | --- | --- |
| Restore safety-capture failure | Injecting a failing `runGit(add)` returned `ok:false`, zero restored/deleted files, no safety id, and unchanged user bytes. This proves the failure branch, not actual filesystem exhaustion. | R03 |
| Restore file replaced by external symlink | Git restored the checkpoint's regular file; external target bytes remained unchanged. | R04 |
| Missing captured checkout | Renaming the checkout made apply refuse instead of restoring into another directory. | R05 |
| APFS private dependency preparation and relink | Real clone created a directory with independent files. Removing the entire private dependency directory and relinking created another private directory; parent sentinel remained unchanged. The removal is a filesystem fixture, not a real package-manager conformance run. | W-private-copy |
| Root external dependency alias | Refused because the alias did not name the project's dependency folder; parent unchanged. | W-root-external |
| Nested external dependency alias | Actual copied dependency tree was rejected because a nested symlink escaped the private checkout; parent unchanged. | W-nested-external |
| Existing shared hardlink | Refused the existing dependency file with link count 2; parent unchanged. | W-hardlink-existing |
| Hardlinked source copied privately | Source files had link count 2; actual APFS copy produced target link count 1 and was accepted. This is safe isolation, not a requirement to reject all source hardlinks. | W-hardlink-source |
| Clone error and ENOSPC transport | Injected `cp` close code 1 plus failure/ENOSPC stderr yielded explicit refusal and no shared fallback. Parent remained unchanged. The live volume was not filled. | W-clone-failure, W-disk-full |
| Same-process verification overlap | Second `runAt` rejected “already running”; the first durable receipt was `running` before the command completed. | R09 |
| Same-size/restored-mtime mutation | Previously current pass became noncurrent after changing nine bytes to different nine bytes and restoring mtime. | R09 |
| Bounded noisy command | 180,000 characters of real process output were capped at 128 KiB plus an explicit truncation note. | R09 |
| Newer failure under the same recipe | Changing an external gate fixture caused a newer run to fail with the same recipe hash; the older successful run no longer verified. | R12 |
| Ignored dependency input | Changing `node_modules/ignored.txt` left the prior pass current. This is the documented Git-visible-input limit, not evidence the dependency was verified. | R12 |
| Unsupported symlink and 17 MiB file | Commands exited successfully, but freshness was `unavailable` with the explicit limit and `isCurrentPass` returned false. A passed command row is not a verified checkout. | R12 |
| Real-byte hashing | Eight random 8 MiB files (64 MiB, not sparse) fingerprinted in 188.63 ms; HEAD/index unchanged. Warm filesystem, one sample, same host; not a cold production asset benchmark or throughput guarantee. | R12 |
| Fixture cleanup | All 17 recorded owners, groups and writer PIDs were absent when evidence assertions ran. | artifact-verification.json |

## P0 completion accounting and remaining blockers

| Planned P0 runtime boundary | Executed evidence | Concrete remaining boundary |
| --- | --- | --- |
| Process death, leases and two competing runners | Actual owner SIGKILL, valid-lease nonduplication, real expiry/recovery and continuing old/new writes (R10); concurrent production review runners (R11). | Actual `createSession`/native PTY plus production headless recovery were not launched. The current harness isolates module accessors and uses a sentinel runner. It cannot prove the full app ties a durable lease to live process ownership or prevents duplicate paid calls. Requires an isolated installed/development app and a credential-free real provider fixture through its launch path. |
| Private dependencies, links and clone/disk failure | Real APFS copy, relink, root/nested symlinks, existing hardlink refusal, source hardlink separation; injected clone failure and ENOSPC refusal. | Real full-disk/cross-volume failure needs a disposable bounded filesystem/image, not filling the shared host volume. No such image was provisioned. The local package-manager install/removal and setup-before-launch boundaries are covered by the existing baseline suite where applicable; this new fixture directly tests preparation/relink only. |
| Restore preview mutation, writer, symlink, safety failure | Preview mutation deletion and live writer reproduced; successful safety undo, file symlink outside-target preservation, missing checkout and injected safety failure controls. | Mid-apply ancestor-symlink swap and real disk failure were not injected. Root validation is a fixture allowlist, so this is not independent testing of production managed-root policy or the renderer confirmation flow. Those need an explicit race barrier/full app fixture. |
| Review descendants on graceful quit/crash | Actual production command descendants survive Node owner SIGKILL/normal exit; reopened SQLite records are falsely certain they stopped. | Full Electron `before-quit`/`stopServices` execution, renderer recovery and complete app crash/reopen remain unexecuted. A minimal Electron wrapper would not close this gap; it needs the production startup/shutdown graph. |

P1 limits: native Claude/Codex hook delivery, terminal readiness, renderer reattachment, actual package installation, both-theme review UI and retained-checkout application restart were not executed by this sub-audit. The coordinator's baseline and other sub-audits are distinct evidence. No screenshot or unit fixture is presented as a real provider run.

## Reproduction and verification

Use a **fresh disposable base per invocation**; these scripts intentionally retain their SQLite/Git fixtures for inspection. Use the pinned private clone's dependencies and Node from `.nvmrc`. Example, replacing the local roots with a newly prepared lab:

```sh
source ~/.nvm/nvm.sh
nvm use 22.23.2
RUNTIME_AUDIT_SOURCE=/private/tmp/your-lab/repo RUNTIME_AUDIT_BASE=/private/tmp/your-lab/runtime node docs/research/relay-audit-2026-09-19/runtime/runtime-fixtures.cjs.txt
RUNTIME_AUDIT_SOURCE=/private/tmp/your-lab/repo RUNTIME_AUDIT_BASE=/private/tmp/your-lab/runtime-extended node docs/research/relay-audit-2026-09-19/runtime/runtime-fixtures.cjs.txt extended
RUNTIME_AUDIT_SOURCE=/private/tmp/your-lab/repo RUNTIME_AUDIT_BASE=/private/tmp/your-lab/runtime-verification node docs/research/relay-audit-2026-09-19/runtime/runtime-fixtures.cjs.txt verification-edges
RUNTIME_AUDIT_LAB=/private/tmp/your-lab node docs/research/relay-audit-2026-09-19/runtime/collect-evidence.cjs.txt
```

The last command validates the reported observations and fixture cleanup, sanitizes evidence into this dated artifact directory, and refreshes hashes. It asserts observed regressions as findings; an exit code of zero means the evidence assertions passed, **not** that Relay passed its safety criteria. The coordinator owns the complete `npm test` baseline, terminal probe and shared financial ledger; this sub-audit made no changes to them.
