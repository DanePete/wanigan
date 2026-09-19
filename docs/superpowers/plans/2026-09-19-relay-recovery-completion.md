# Relay next session — recovery completion before routing

Prepared from `4e0d23d` on `feat/routing-suggester`. This is a source-grounded implementation handoff; this planning session changes no runtime behavior and runs no providers.

## Outcome and scope

Make blocked execution understandable and safely recoverable where evidence permits, and make database restoration preserve execution and billing safety across the attended app, scheduler and CLI. A user must be able to inspect what is blocking a checkout, request a supported resolution, and see why an unknown case remains blocked.

Implement two related deliverables: **evidence-backed execution recovery** and **coordinated database restore**. Account/model/quota discovery follows this phase; MCP conformance, Auto economics and paid coding trials follow that. Read the [original audit plan](2026-09-19-relay-deep-audit.md) when reaching those later lanes, not as permission to launch them during this phase.

The audit's $50 total allowance remains authorized and unspent. This phase has a **$0 provider-spend scope**: use local fixtures. Process closure never reconciles a remote request's bill. Preserve the existing TypeSafe and telemetry admission blocks.

## Starting evidence

- `7ea1afe` / `6944cc4`: required Usage conversion and accounting fixes. Read the [spending report](../../research/2026-09-19-relay-spend-fixes.md).
- `8b29be9` / `4e0d23d`: required Queue/Headless conversion and recovery safeguards. Read the [recovery report](../../research/2026-09-19-relay-recovery-fixes.md), especially its limits.
- Last completed full verification: all eight `npm test` gates passed; 2,702 smoke assertions, 22 session reliability tests, 8 Review tests, 9 Queue/Headless scenarios and 6 Worktrees tests. Terminal replay passed five checks; restore UI fixtures passed in both themes. These are a recorded baseline, not a substitute for verifying the next change.
- Earlier audit documents and `docs/research/relay-audit-2026-09-19/` remain untracked deliberately. Preserve them; stage only the next phase's intended files. Inspect the current branch and diff because work may have advanced since this handoff.

## What source inspection establishes

| Boundary | Current fact | Consequence for this phase |
| --- | --- | --- |
| Checkout ownership | [checkout-activity.ts](../../../src/main/checkout-activity.ts), `acquireCheckoutActivity`, stores a random owner identity and canonical path. Its returned closure deletes the exact owner's row. Writers can coexist; restore is exclusive. | There is no public recovery/release API. It is not a universal lock against all new writers. A recovery action must address the relevant owner's state as well as the shared receipt. |
| Missing execution identity | [session-storage.ts](../../../src/main/modules/session-storage.ts), `checkout_activity`, stores no boot identity, process birth identity, child scope or terminal observation. Review/Headless/Worktrees separately record owner PIDs. | Today's orphan records cannot prove descendant extinction from their contents. Add prospective evidence without inventing it for old rows. |
| Multiple holds | [Review](../../../src/main/review.ts), [Headless](../../../src/main/headless.ts), [Queue](../../../src/main/queue.ts) and [Worktrees](../../../src/main/worktree-setup.ts) have distinct quarantine/owner records. Restore also reads legacy evidence. | Deleting only `checkout_activity`, changing one status, or pruning an old row is not reconciliation. Resolution must be atomic across the applicable records and preserve history. |
| Existing process controls | [platform.ts](../../../src/main/platform.ts), `killProcessTree`, accepts a live child handle and refuses an already-exited handle. | Keep stop requests scoped to a runtime that still owns the child. A PID string, elapsed lease or missing parent is insufficient authority to kill a recovered process or declare its descendants gone. |
| Billing | [suggest-usage.ts](../../../src/main/suggest-usage.ts), `beginSuggestAttempt`, blocks pending/unresolved exposure across restart/key changes; [Usage](../../../src/main/modules/usage.ts) owns recorded metering. | Local recovery must not mark remote charges zero, clear billing holds, or relabel estimates as a settled bill. |
| Backup swap | [backup.ts](../../../src/main/backup.ts), `restoreBackup`, replaces the DB/WAL/transcript/attachment set after closing this process's handle. [index.ts](../../../src/main/index.ts), `backup:restore`, checks local live counts before awaited dialogs. | Older data can erase newer safety evidence while another process still writes. A pre-dialog check and the UI singleton do not cover the daemon/CLI. |
| Work restored from the past | Queue startup dispatches waiting work; schedules and other unattended producers restart with services. | An old waiting row may represent work that already ran after the backup. Restore approval must not become permission to execute archived work again. |

For exact backup entrypoints, conversion boundaries and failure cases, read the [backup investigation](../../research/2026-09-19-relay-backup-recovery-next-phase.md).

## Design constraints to preserve

**Separate three questions.** Track execution state, checkout mutability and financial liability separately. An owner disappearing does not prove the command stopped. A command stopping does not prove its bill settled. A user acknowledging a warning does not establish either fact.

**Make recovery a required module.** Use `WaniganModule` and the renderer view registry. Put inspection, resolution receipts and typed IPC behind a required Recovery extension with its trust reason declared. Add a narrow declared adapter point for the owning modules if needed; use it for built-ins too. Keep each existing table's owner explicit. If ownership of `checkout_activity` moves from Sessions, make that a separate behavior-preserving conversion preserving bootstrap order and historical rows. Do not wire a new ad hoc recovery table/view/handler triple into the core.

**Keep evidence authoritative.** Use additive schemas and durable, bounded resolution receipts. Retain operation/claim identity, observed evidence source and time, the decision, and the relevant database generation. A successful reconciliation records why it was valid; it does not rewrite a failed/interrupted run into success or remove the original cost evidence.

**Reconcile only supported evidence.** Inspection can return `owned/live`, `confirmed finished`, `unknown`, or `unsupported`, with an explanation and allowed actions. For a currently cooperating owner, request termination through that owner and await its matching completion evidence. For an orphan, first establish what the platform can prove. Process/boot identity is a candidate observation, not by itself proof that descendants or remote requests ended. A historical row lacking adequate evidence stays blocked. No generic “mark safe” action should enable automatic work.

**Bind changes to a reviewed state.** Any release or retry decision needs a short-lived, one-use main-issued receipt binding the exact claims, operation revisions, canonical checkout identity and storage generation. Revalidate immediately before the atomic state transition. A concurrent claim, late completion, changed checkout or repeated apply invalidates it. Reconciliation itself does not enqueue a retry. A separately requested retry gets normal account/profile/tool/budget admission and a new attempt linked to the prior one.

**Keep the storage barrier outside what it protects.** Backup restore needs an inter-process maintenance barrier and generation/restore journal that replacing `wanigan.db` cannot erase. This is an operational interlock, not a second unsynchronized copy of business evidence. Specify its owner, format, permissions, crash transitions and recovery behavior. The database remains canonical for execution/billing history. Unreadable or ambiguous interlock state blocks mutation; an expired timeout does not authorize stealing the barrier.

**Fence every participating process.** App, daemon and CLI must observe maintenance before opening/reopening the DB and at admission to side effects. Existing timers being stopped is not proof that in-flight runners, HTTP ingestion, finalizers or cached SQLite statements are quiescent. Participants must drain and close their old-generation handles; a missing acknowledgement refuses the swap. A newly started scheduler waits outside the barrier. Restore itself does not silently terminate agents or uninstall/reconfigure the scheduler; stopping running work is a separate deliberate operation. Explicitly account for older/incompatible participants; do not claim safety for uncooperative processes the protocol cannot exclude.

**Restore into inspection first.** Before services restart, make restored queue jobs, schedules, pending approvals and other unattended producers non-dispatchable until reconciled. For the first supported restore path, refuse the swap while current execution or remote liability remains unresolved; defer any cross-generation merge until it has its own proven contract. Preserve retained newer evidence for inspection. Even without pending requests, older spend totals are not current budget evidence: keep automatic paid admission held until post-backup spending is reconciled. A local process check does not resolve an already submitted batch/API request. Cancellation, partial swap and coordinator death must leave one identifiable generation and retained originals, never an automatically runnable mixture.

## Implementation order and completion checks

1. **Establish the isolated baseline.** Read `AGENTS.md`, this plan and the two completed reports. Use Node `22.23.2`; record `git status`, commit, fresh userData and a separate `WANIGAN_PROVIDER_PACKS_DIR`. Inspect existing fixtures before adding new ones. Finish with a reproducible list of known current behavior and fixture roots. Keep the installed app, actual scheduler registration, credentials and production userData out of experiments.
2. **Convert Backup before changing it.** Move its existing IPC and associated helpers into a required module while preserving public channels, native dialogs, manifest validation, artifact rebasing, trust exclusions, retained originals and relaunch behavior. Keep the conversion scoped to Backup rather than moving all Settings or legacy DB tables. Add only the host capability the module genuinely needs; extract an unconverted connection-lifecycle boundary separately if the implementation must change it. Commit the conversion separately after schema/IPC/source contracts and applicable tests pass.
3. **Define recovery and maintenance contracts.** Build the required Recovery module/read model and module adapters. Write pure state-transition tests for evidence sufficiency, independent liability, generations, stale receipts and allowed actions. Include additive/idempotent migration and legacy-row cases. Resolve the boot/child-identity and storage-lock capability questions with bounded local probes and official platform documentation before claiming support. Finish when supported transitions are explicit and unknown cases have a tested refusal.
4. **Close the database-swap race.** Introduce the inter-process barrier, peer drain/handle closure, generation check and crash journal. Call the guard at the actual swap boundary as well as the IPC path; direct module callers receive the same refusal. Startup remains in recovery mode until the restored state is reconciled. Finish when two real processes sharing one temporary data root cannot write through or admit work across a swap, including after coordinator death.
5. **Implement evidence-backed resolution.** Inspect/preview/apply through typed main-process APIs and owner adapters. Atomically update only the exact validated claims and append the resolution receipt; preserve billing holds and prior outcomes. Cover one supported successful release, concurrent invalidation, repeated apply and an unsupported legacy orphan. Finish when the successful control really permits the intended later action, while uncertainty still refuses it.
6. **Ship the operator path and verify.** A registered view exposes affected checkout/operation, observation age/source, separate execution and billing status, and the reason for each permitted or unavailable action. Use shared UI primitives and both-theme before/after screenshots. Run `npm test`, `npm run probe:terminal`, targeted native lifecycle tests and `git diff --check`; document evidence levels and remaining unsupported cases. Commit behavior separately from conversion and leave a concise report.

Work in reviewable steps. If the platform cannot support a proposed recovery transition safely, complete the supported inspection/refusal path and record the concrete blocker. Do not weaken the existing quarantine to finish a checklist, and do not present that result as complete automatic recovery.

## Required adversarial cases

| Case | Required result |
| --- | --- |
| Live foreign owner / reused PID / missing parent | No stolen claim, no signal based only on persisted PID, no false completion. |
| Redirected descendant / setup service / escaped child scope | Observed survivors retain exclusion; unsupported containment remains explicit. |
| Graceful completion control | The owning runtime records final evidence, releases only its exact claims and permits the intended subsequent operation. |
| Legacy orphan without birth/boot/scope evidence | Visible unknown state; no invented migration proof or automatic retry. |
| Preview → new claim, symlink/directory change, late owner result, repeated apply | Stale resolution refused; no unrelated claim cleared. |
| Local process stopped, remote request unresolved | Billing hold and pending liability survive; no zero-dollar assertion. |
| Restore dialog open while new work starts elsewhere | Final swap recheck/barrier refuses or safely drains; the early count is not relied on. |
| App + scheduler/CLI hold SQLite handles; third participant starts during maintenance | Old handles cannot write after swap; new participant cannot open/admit work. Missing peer acknowledgement blocks restore. |
| Older backup omits newer ownership/TypeSafe/usage evidence | Unresolved execution/liability refuses restore in this phase. After an otherwise permitted restore, older spend totals cannot authorize paid work until spending is reconciled. |
| Backup contains waiting jobs, due schedules and pending automatic actions | Inspection mode starts without replay; explicit later admission is required. |
| Crash at barrier acquisition, drain, file swap, publication or relaunch; corrupt/missing journal | No automatic unlock or half-generation execution; retained originals and a precise recovery state remain available. |
| Same backup restored twice / interrupted restoration resumed | Idempotent storage recovery and no duplicate command or remote submission. |
| Native lifecycle fixture | Credential-free synthetic CLI goes through the real Electron launch/quit/reopen path; label it synthetic, never a real-provider trial. |

Use the existing `scripts/test-{session-reliability,review-recovery,queue-recovery,worktree-recovery}.cjs`, checkpoint smoke and backup smoke as starting points. Put process tests in the slower execution-recovery/smoke lane; keep pure transition tests in `src/shared`. Capture exact passing commands and counts for the final revision rather than relying on this plan's baseline numbers.

## Handoff to the following phase

Once recovery's supported paths and backup coordination meet these criteria, continue with account-bound eligibility from the original audit: launch-equivalent account resolution, credential-generation cache keys, paginated catalogs, preserved quota buckets/reset/source age, and final queued revalidation. Keep public catalogs separate from account access and observed execution. The later live lane still requires the original audit ledger, provider-side bounds and all unresolved-liability guards before any part of the $50 is spent.
