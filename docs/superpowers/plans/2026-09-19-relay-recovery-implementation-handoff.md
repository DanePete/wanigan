# Recovery implementation handoff — completed 2026-09-19

Subsequent paid-request accounting landed in `cc64311`. Its recovery safety follow-up now validates the linked evidence, preserves incomplete CLI/transport outcomes and has fresh full verification. See the [paid-evidence report](../../research/2026-09-19-relay-recovery-paid-evidence.md); it supersedes the permanent-receipt limitation recorded at this earlier checkpoint. Unknown liability and post-restore spending still remain held.

> **Status: closed. Everything below this block is the historical checkpoint and is no longer current.**
>
> - The behaviour WIP described here as uncommitted was committed by a concurrent session in `703c46c`, mixed with unrelated dock, Usage and audit work, and pushed. It was not rewritten. The partial-staging guidance below therefore no longer applies.
> - Remaining-work items 1–6 landed in `e8968c4` (pre-submission receipts, Improve prompt as a Recovery owner, host-aware storage admission, the seven-check native probe passing for the first time) and `0bc83e7` (Restore capture and note spacing).
> - Final verification on `0bc83e7`: `npm test` exit 0, smoke 2,701 passed / 0 failed, storage maintenance 15 scenarios, native Backup 6 Electron processes; build, terminal replay, native lifecycle 7/7 and the both-theme recovery probe all exit 0. $0 spent; the $50 allowance is untouched.
> - Chosen limitation, stated rather than hidden: `usage_paid_operations` has no settlement contract, so any paid call after `e8968c4` refuses a later restore on that installation. Catalog, credential-validation, pricing, Scout and push transports are not fenced at the transport. Details and evidence are in the [platform report](../../research/2026-09-19-relay-recovery-platform-evidence.md).
> - Harness note: `npm test`'s smoke gate fails at once with `script: tcgetattr/ioctl: Operation not supported on socket` when it is launched from a shell command that also contains a heredoc. Run it on its own.
> - Next phase is account-bound eligibility, scoped in the last section of the [approved plan](2026-09-19-relay-recovery-completion.md). It has no implementation plan yet.

Checkpoint requested by the user on 2026-09-19 to wrap this session and continue in another AI session. This document supplements, rather than replaces, the approved [implementation plan](2026-09-19-relay-recovery-completion.md). Read `AGENTS.md` first. The user approved implementing that scope; no new permission is needed to continue it. **The behavior implementation is unfinished and remains in the working tree.** Do not mistake the two conversion commits or earlier passing tests for a completed phase.

## Resume prompt

> Continue Wanigan in `/Users/dane/Projects/drupal/wanigan`. Read AGENTS.md, then `docs/superpowers/plans/2026-09-19-relay-recovery-implementation-handoff.md` and its original approved plan. Preserve all existing WIP and unrelated audit/UI/account changes. Finish the listed safety gaps before final verification and the behavior commit. Use Node 22.23.2, isolated temporary data/provider-pack roots, no paid providers or live trials. The $50 allowance is still entirely unspent. Keep execution, checkout exclusion and billing liability independent. Finish all eight npm test gates, terminal replay, native lifecycle, final both-theme screenshots and git diff --check. Report supported behavior and remaining unsupported cases; account eligibility is the following phase.

## Git and workspace boundaries

Branch at handoff: `feat/routing-suggester`. Recheck it and `git status --short` before editing; another user/session is actively changing this same checkout.

Committed during this work:

- `e4f45a7 refactor(storage): make Backup and connection lifecycle required modules`. Behavior-preserving extraction of Backup IPC/default helpers and Storage connection/privacy helpers. Backup retains its three public channels, native dialogs and host relaunch capability. Required Storage declares connection ownership without moving legacy business schemas.
- `b9e6f2b refactor(usage): isolate shared model transport boundaries`. Exact move of the shared Anthropic helper into `modules/usage-anthropic.ts`, original facade retained. Learning model assistance moved into `modules/learning-model-assist-runtime.ts` with relative import-depth changes only, original facade retained, new required descriptor registered. This conversion was needed for the remaining pre-submission safety fix. **No transport safety behavior has been added yet.** Exact-body comparisons against the previous HEAD, typecheck, targeted ESLint and diff check passed before commit.

The initial HEAD was `5951b99`, after `6944cc4` spending safeguards and `4e0d23d` recovery safeguards. Existing untracked audit reports, `docs/research/relay-audit-2026-09-19/` and the deep-audit plan were deliberately preserved. Do not add them indiscriminately.

Concurrent work outside this phase includes Usage/account identity (`claude-limits`, `codex-status`, `limits`, `usage-account-identity`, Usage view/CSS, shared types, usage tests, guide); navigation/Board/Git/Context/Sessions/App/CodePanel/styles; and many unrelated renderer probes and visual directories. These are not this implementation. Do not reset or stage them for this phase.

Three files need partial staging:

- `package.json`: this phase adds `test-storage-runtime.cjs` to shared tests and adds Recovery inspection, Storage maintenance and native Backup tests to `test:execution-recovery`. The `test-usage-accounts.cjs` addition is concurrent work.
- `src/renderer/src/views/registry.tsx`: this phase adds only the Recovery import and `recovery: () => <Recovery />`. Board/Context prop changes are concurrent work.
- `src/main/smoke3.ts`: this phase needs only the Review source-contract regex accepting the multiline `registerModuleIpc` context. Usage and dock changes are concurrent work.

All current changes in `src/main/index.ts`, `src/preload/index.ts`, `src/shared/view-registry.ts` and Settings' Backup section were this phase at handoff. Inspect again before staging because the shared checkout is live. The index was clean after the conversion commit; no behavior WIP is staged.

## Implemented WIP and its contracts

### Storage coordination

`src/main/storage-maintenance.ts`, `modules/storage-connection.ts`, guarded migration integration in `db.ts` and `module-registry.ts`, and [protocol report](../../research/2026-09-19-storage-maintenance-protocol.md):

- Private external `.storage-control/journal.sqlite` plus `format.json`, outside replaceable backup data. SQLite `BEGIN IMMEDIATE`, FULL/DELETE journaling, random identity/generation and durable participant tokens. PIDs are diagnostic only. No timeout, expiry or missing PID reaps an owner.
- Registers before opening the main DB. Guards database methods, cached statements, iterators, transactions and the statement's database escape. Guards late required-module migrations using the same control→main lock order. Main DB generation and device/inode checks detect out-of-band replacement.
- Restore is bound to an opaque revision including external revision and SQLite data/schema/total-change observations. Another process's native commit invalidates preview even without a control revision bump.
- Explicit peer close acknowledgement required. Foreign/unacknowledged participant refuses restore; no force-kill or stale-owner takeover. `lsof` inventory refuses observed unregistered handles on macOS/Linux. Inventory failure/Windows is unsupported. A snapshot cannot exclude a future uncooperative old binary: do not claim OS containment.
- Journal phases prepared/closed/swapping/published/failed/canceled. A failed/interrupted swap retains the journal and originals and refuses normal reopen. No generic unlock/repair action exists. Published databases open in inspection with automation and spending held.
- Public mutation is refused in inspection. Required additive migrations are privileged at startup, so do not call the database bytes immutable. Existing lazy `CREATE ... IF NOT EXISTS` reads are allowed only through a single-statement, query-only no-op check.
- Reviewer found a prepare-time PRAGMA bypass. It is fixed: native preparation now occurs only after admission; only a closed lexical list of read PRAGMAs is admitted as read. Comment/semicolon/EXPLAIN variants and actual SQLite `query_only` state are tested.

### Required Recovery and supported release

`modules/recovery.ts`, `recovery-contract.ts`, `recovery.ts`, `recovery-inspection.ts`, `review-recovery.ts`, `shared/recovery.ts`, owner declarations in Sessions/Queue/Headless/Worktrees/Suggest/Usage/Review:

- Required Recovery module owns typed inspect/preview/apply and additive `recovery_resolutions`; required owning modules declare narrow read/reconcile adapters. Existing business table ownership stays in place. Direct Backup callers get mandatory built-in readers even before host registration.
- Inspection separates execution (`owned/live`, `confirmed finished`, `unknown`, `unsupported`), checkout exclusion and billing exposure. Missing required schemas produce unavailable evidence, never an empty permission to restore. Journal paths remain inspectable when business evidence is unavailable.
- Five-minute one-use main-issued receipts bind generation, complete observation revision and canonical checkout identity (real path, device/inode/birth/link identity). New preview supersedes prior same-key receipt; failed apply consumes it. Apply runs an immediate transaction, rechecks all evidence, invokes the exact owner transition and appends a bounded receipt. No retry, cost rewrite or unrelated claim deletion.
- Supported successful release is intentionally narrow: Review's live owner finishes successful canonical checkout preparation, loses its lease before **any reviewed command spawn attempt**, finalizes its failed run and records exact owner/run/shared-claim proof. Once the runtime is no longer active, the adapter can release those exact claims. The failed result and independent liability remain. A local Git preparation timeout/unavailable fingerprint stays unknown; preparation itself runs processes.
- Spawned legacy orphans, escaped descendants and missing birth/boot/scope evidence remain unsupported. Local probe demonstrated an escaped redirected child still writing after parent close and original-group ESRCH. See [platform evidence](../../research/2026-09-19-relay-recovery-platform-evidence.md).
- Liability readers cover TypeSafe pending/unresolved, Headless missing reported cost, the actual telemetry coverage predicate, active/failed batch submissions, ended batches lacking results, and explicitly lost results despite a positive ingestion stamp; also unmetered/unknown learning results, companion turns with missing cost, and legacy interviews lacking complete per-call accounting. Legacy interviews conservatively block even when committed because a later success can overwrite an earlier request failure. No billing settlement action is provided.

### Backup and operator flow

`backup.ts`, `modules/backup.ts`, Settings Backup copy, registered `Recovery.tsx`/`recovery.css`, preload and shared view registry:

- Native confirmation forwards an expiring one-use Backup preview bound to source canonical identity/digest and live generation/revision. The actual swap rechecks evidence under the external barrier. Unknown execution or remote liability refuses it. Source changes, live changes and reused receipts refuse it.
- Verified staging, generation stamping, DB/WAL/transcript/artifact replacement, retained originals and inspection publication. v1 preserves omitted artifacts; v2 rebases verified attachments; credentials/trust are not restored. Partial failure rolls files back where possible but retains failed maintenance, rather than claiming a safe automatic resume.
- Late review found that stopping timers cannot prove old async callbacks drained. New required helper `modules/storage-runtime.ts` monotonically remembers whether this host started services. Actual Backup swap refuses such a host, including direct Backup calls.
- In an ordinary attended runtime, the existing Restore button first offers **Restart for restore**. It rechecks recorded execution/liability before requesting normal quit, then relaunches with `--storage-maintenance`. That fresh process skips credentials and background services. Return to Settings→Backup to choose a backup. There is a deliberately small offline IPC allowlist and in-flight IPC count. A completed restore relaunches without the argument but durable inspection still holds services and paid work.
- CLI now checks storage before credentials and refuses restored inspection; daemon checks before starting. Module fire-and-forget events explicitly refuse inspection/maintenance. `companion:history` and `sessions:past` were removed from the offline allowlist because they mutate/backfill during nominal reads.
- This fresh maintenance flow and its latest host changes are only partially verified; see remaining work. There is no post-restore spending reconciliation or general resume action in this phase. Quitting and normally reopening cancels preparation mode, not restored-generation holds.

## Remaining work — safety blockers first

1. **Durable pre-submission liability still missing.** Shared SDK dry-run has no pending or final ledger; learning invocation records only after the child completes and can swallow record failure. A graceful exit can close the participant while a request remains billable. Fresh maintenance startup cannot reconstruct missing historical evidence. The new conversion is the seam to fix this through required modules.
   Proposed bounded design from review: required Usage owns additive `usage_paid_operations(id, source, at)` or an equivalently explicit unresolved-evidence table. Before actual paid SDK fetch or learning CLI spawn, synchronously record a bounded prospective receipt and check Storage paid admission. Preserve missing settlement as unresolved; do not invent zero or clear it because fetch/child completed. Do not record prompts, URL query strings, bodies, credentials or argv. New SDK fetch wrapper must recheck at **actual send after awaited work**, including retries; CLI gate must be immediately before spawn. SDK shared helper is `modules/usage-anthropic.ts`; learning `run` is in `modules/learning-model-assist-runtime.ts`. Keep the source facade APIs stable. Tests should use a local fetch double and harmless synthetic process, including maintenance appearing after an earlier await. A conservative receipt with no settlement contract means these operations block later restore even after reported success; explain this limitation if chosen. Do not silently refactor normal budget/account admission into this phase.
2. **Uninspected Prompt Improve liability.** `prompt_improve_usage` is absent from Recovery. Its required module persists pending before SDK; failed/canceled/timeout rows can lack input/output/estimated cost, with explicit possible-billing text. Add a module-owned adapter and required-schema handling/tests. Do not treat an estimate as proof of a settled bill. Review all legacy remote readers for similar omissions.
3. **Direct maintenance admission.** `--storage-maintenance` intentionally leaves the external storage mode active until an actual restore. `assertStorageAdmission` currently sees only that persisted mode, so a direct paid API call can pass despite the offline runtime flag. Integrate the required runtime hold at the side-effect admission boundary, test it, and include raw TypeSafe/Suggest paths that bypass shared Anthropic. IPC allowlisting covers normal UI but is not universal transport fencing. Raw catalogs, credential validation, pricing and notification transports also bypass the shared SDK; decide their supported inspection behavior explicitly. Do not claim all direct transports are fenced without tests.
4. Verify the new fresh-start operator flow end to end and update wording/probe contracts if needed. The latest native probe includes maintenance UI reachability and actual Backup create/inspect; **its seven-check version has not run**. Existing four-check launch/quit/reopen version passed before extension. Be alert for startup reads that write and accidentally make the maintenance UI unusable; do not broaden the allowlist on a method-name guess.
5. Run final verification against the actual intended commit. Concurrent unrelated edits already caused source-contract failures. Prefer a temporary frozen verification snapshot of HEAD plus scoped WIP, with `node_modules` linked from this checkout, or a carefully isolated worktree. Do not copy entire current renderer/account WIP into this phase. Shared-file hunks above need selective application. Do not reset the user's working tree to manufacture a clean test run.
6. Regenerate final both-theme after screenshots, inspect them, update the evidence report with final commands/counts and limitations, then commit **only this behavior implementation**. The current screenshots precede latest spacing, remote evidence and maintenance restart copy. Account-aware eligibility remains next phase.

## Verification evidence and fixture boundaries

Always `source ~/.nvm/nvm.sh` then `nvm use 22.23.2` before npm/Node commands. No paid provider was invoked. Data/provider packs live under disposable `/private/tmp` roots; production userData, installed app, scheduler registration and sessions were not used for fixtures.

Recorded passing checks during implementation (not all against the final WIP):

- Full typecheck, shared tests, renderer style, dead-code and lint passed before late runtime additions.
- Review: 13 tests, including supported release and unavailable-preparation refusal; real lease case takes about 36 seconds.
- Recovery inspection: 15 tests, with independent owner/liability matrices, real SQLite/filesystem and actual telemetry accounting. External Storage status is an explicit test double. Latest matrix also includes companion and committed legacy interview uncertainty.
- Storage maintenance: 15 real subprocess/SQLite scenarios, including foreign/cached handles, third startup, dead token refusal, stale revision/native foreign commit, crash phases, replaced/corrupt/missing control, main-file replacement, inspection/no replay and PRAGMA regression.
- Native Backup: six isolated Electron process scenarios across v1/v2 restore/reopen and interrupted rename/failed reopen. This uses real better-sqlite3 and module registration with no services/providers. Strong process-crash evidence; **not whole-machine/power-loss durability proof**. Existing file-copy/rename code does not fsync every artifact and parent directory.
- Native lifecycle: four prior checks passed (synthetic CLI through real main/preload/PTY, normal quit, completed history after reopen, no remaining claim). Seven-check extension is unrun.
- Initial screenshot probe: both themes, three checks, no page errors, synthetic bridge/actual renderer. These are presentation evidence, not native restoration proof.
- Latest helper tests cover monotonic live-host refusal, offline allowlist, in-flight and failed-call drain, and restored inspection. Backup module fixture covers maintenance restart confirmation/cancel.

The last full `npm test` attempt did **not** pass: first seven gates passed, smoke reported 2,696 passed/5 failed. Four were concurrent Usage/Git/dock source-contract changes; one was the old multiline module-context regex, now updated in its own hunk. First sandboxed native attempt also exited 6; native/loopback fixtures require the normal approved launch permissions. Do not reuse baseline 2,702 as this revision's result. Logs: `/private/tmp/wanigan-recovery-npm-test.log`, `/private/tmp/wanigan-recovery-storage.log`, `/private/tmp/wanigan-recovery-inspection.log`. Temporary files may disappear; recreate evidence rather than assume it.

Final checkpoint check after all source edits stopped: full `npm run typecheck`, `node scripts/test-backup-module.cjs`, `node scripts/test-storage-runtime.cjs`, `node scripts/test-recovery-inspection.cjs` (15/15) and `git diff --check` all exited 0. Recovery log: `/private/tmp/wanigan-recovery-handoff-check.log`. These are targeted passing checks, not the required final full verification.

Final required commands after fixing blockers:

```sh
source ~/.nvm/nvm.sh
nvm use 22.23.2
npm test
npm run build
npm run probe:terminal
node scripts/probe-recovery-native.mjs
node scripts/probe-recovery.mjs
git diff --check
```

`npm test` includes the new slower tests through `smoke`→`test:execution-recovery`. Final native lifecycle and terminal replay still need running. `scripts/probe-recovery.mjs --before` uses the preserved actual baseline renderer at `/private/tmp/wanigan-recovery-maintenance-before-renderer`; committed source baseline was `5951b99`. Existing before screenshots are already preserved in `docs/visuals/relay-recovery-completion-2026-09-19/before`. Do not regenerate “before” from current code. After output goes to the corresponding `after` directory.

### Keychain popup reported by user

The user saw repeated macOS “Keychain Not Found — Electron Key” during native fixture development. We told them to Cancel, not Reset To Defaults. Native work stopped; read-only process inventory found no native-recovery fixture instances remaining. Another unrelated design-preview process belonged to concurrent work and was left alone. No system Keychain reset or production credential operation was performed.

Corrections: test Electron launches use `--use-mock-keychain` (smoke, terminal replay, Backup, recovery UI/native probes); native production-main lifecycle fixture also installs an explicit unavailable `safeStorage` facade before importing main. Encryption is an explicit untested boundary and should remain so. The previous four-check native rerun passed without further reported popup. Preserve both mechanisms. Merely using a temporary HOME is insufficient, because Electron availability can initialize its OS encryptor. Primary-source rationale is linked in the platform report. Do not relaunch old probe versions or solve test isolation by resetting the user's Keychain.

## Phase-owned uncommitted files

Whole-file scope at checkpoint, subject to reinspection if later changed:

```text
scripts/probe-recovery-native.mjs
scripts/probe-recovery.mjs
scripts/probe-terminal-replay.mjs
scripts/smoke.mjs
scripts/test-backup-module.cjs
scripts/test-backup-recovery.cjs
scripts/test-review-recovery.cjs
scripts/test-recovery-inspection.cjs
scripts/test-session-modules.cjs
scripts/test-storage-maintenance.cjs
scripts/test-storage-runtime.cjs
src/main/backup.ts
src/main/db.ts
src/main/index.ts
src/main/module-registry.ts
src/main/modules/backup.ts
src/main/modules/headless.ts
src/main/modules/queue.ts
src/main/modules/recovery.ts
src/main/modules/register.ts
src/main/modules/review.ts
src/main/modules/sessions.ts
src/main/modules/storage-connection.ts
src/main/modules/storage-runtime.ts
src/main/modules/suggest.ts
src/main/modules/usage.ts
src/main/modules/worktrees.ts
src/main/recovery-contract.ts
src/main/recovery-inspection.ts
src/main/recovery.ts
src/main/review-recovery.ts
src/main/review.ts
src/main/smoke-audit-backup.ts
src/main/storage-maintenance.ts
src/main/telemetry-accounting.ts
src/preload/index.ts
src/renderer/src/styles/recovery.css
src/renderer/src/views/Recovery.tsx
src/renderer/src/views/Settings.tsx
src/shared/recovery.test.ts
src/shared/recovery.ts
src/shared/view-registry.ts
docs/research/2026-09-19-relay-recovery-platform-evidence.md
docs/research/2026-09-19-storage-maintenance-protocol.md
docs/visuals/relay-recovery-completion-2026-09-19/
```

Plus the three partial files identified above. `telemetry-accounting.ts` changes only the map value parameter type to the consumed `costStatus` shape; runtime predicate is unchanged. The Storage and platform reports are supporting evidence, not a final implementation-complete report. Their discussion of the learning reservation gap remains true until the new transport behavior actually ships and is tested.

All three subagents stopped at this checkpoint. No fixture process was intentionally left running. No paid trial began; **$0 spent, full original $50 allowance unspent**.
