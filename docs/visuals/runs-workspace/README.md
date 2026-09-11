# Runs workspace

Runs now opens on a searchable history beside the selected run's repository
outcomes. The shared page frame replaces the private header and the always-open
launch form. All, Active and Attention filters narrow the history; cost retains
its reported, partial or unreported meaning. Agent output is requested only when
its disclosure opens.

New run opens a dedicated preparation workspace. The assignment and provider
settings sit beside repository selection, the timeout, the provider's available
budget control and worktree isolation. No repositories are selected on first use.
Selecting every registered repository still requires an explicit declaration.
Providers without a budget flag describe the timeout as a duration limit, and
invalid numeric budgets cannot submit.

Drafts, provider settings, selected repositories and pending launch locks survive
navigation in the same window. Returning to the page requires a fresh declaration
when every repository is selected. Confirmed launches open their new run; a
failed launch keeps its draft. This is window memory, not durable draft storage.

Merge confirmations stay bound to the reviewed run and repository. Cancellation
now names the run in an inline confirmation. Pending actions cannot repeat, and
failed history or repository reads disable mutations against stale evidence.
Late repository responses cannot replace the newly selected run's rows. A
selection reveal and preparation transition follow the existing motion settings;
routine polling does not remount the reader.

The main-process runner, typed preload API, provider routing and merge operation
are unchanged. Viewing or preparing a run launches no agents. The miniature
companion uses the existing GPU runtime.

## Captures

These are real Electron captures with fictional projects and deterministic
bridge responses. Before captures load the preceding Schedules app archive.
After captures load the packaged Runs renderer. No real worker, provider call,
worktree merge or cancellation was used for the UI probe.

| View | Dark | Light |
| --- | --- | --- |
| Previous Runs page | [Before](before/runs-dark.png) | [Before](before/runs-light.png) |
| Previous review area | [Before](before/review-dark.png) | [Before](before/review-light.png) |
| Run history and review | [After](after/review-dark.png) | [After](after/review-light.png) |
| Recorded output | [Output](after/output-dark.png) | [Output](after/output-light.png) |
| Repository read failure | [Error](after/rows-error-dark.png) | [Error](after/rows-error-light.png) |
| Prepare a run | [Prepare](after/prepare-dark.png) | [Prepare](after/prepare-light.png) |
| Provider without a budget flag | [Limits](after/provider-limits-dark.png) | [Limits](after/provider-limits-light.png) |
| Review at 960 px | [Review](after/review-960-dark.png) | [Review](after/review-960-light.png) |
| Review at 720 px | [Review](after/review-720-dark.png) | [Review](after/review-720-light.png) |
| Preparation at 960 px | [Prepare](after/prepare-960-dark.png) | [Prepare](after/prepare-960-light.png) |
| Preparation at 720 px | [Prepare](after/prepare-720-dark.png) | [Prepare](after/prepare-720-light.png) |
| Confirmed empty history | [Empty](after/empty-dark.png) | [Empty](after/empty-light.png) |

## Verification

`npm test` passed all six required steps in the isolated source snapshot:
typecheck, **17 shared tests**, renderer style, package hooks, local-install
fixtures, and **1,574 smoke assertions**, with zero failures. See
[the complete test log](npm-test.log).

The [renderer probe](after/verification.json) exercises search, qualified cost
figures, lazy output loading, cached output, failed and out-of-order repository
reads, exact merge targets, per-run confirmations, cancellation, draft recovery,
provider capability changes, explicit repository scope, invalid budgets, failed
launches and navigation during a pending launch. It checks both review and
preparation at 960/720 pixels for horizontal overflow and verifies the stopped
reader reveal with Motion Off.

Apple silicon and Intel builds are staged in
`release/runs-workspace/mac-arm64/Wanigan.app` and
`release/runs-workspace/mac/Wanigan.app`. See [package verification](build-verification.json)
for signatures, ASAR integrity, hardened fuses, executable PTY helpers and renderer
hashes, and [the packaging log](package.log). The application was not installed or
restarted; the existing live session was left open.

An isolated copy kept other rebuilds from replacing assets during verification.
[Source hashes](source-manifest.json) identify the snapshot and any contemporaneous
working-tree differences. No commit or push was made.
