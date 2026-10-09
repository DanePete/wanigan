# Staging refresh regression found by the full crawler

Commit: `e21d97ad8bc181aeab63ca707f196c42b0c56475`.

Severity: P2 (a false error during a successful staging operation; no file or index loss demonstrated).

This was introduced by my earlier untracked-diff containment fix during this review and shipped in alpha.2. The full local crawl caught it: its 19 failures all reported the same refused `git.diff`, nine on the project Changes view and ten in NS-13's merge worktree. The report is preserved at `/private/tmp/wanigan2-review/alpha2-crawl-failure/report.json` and `.md`; the originating full run remains in `current-test.log`.

## Cause and reproduction

`src/renderer/src/components/FileDiff.tsx:70` and the parent Changes status query both subscribe to git events. Staging a previously untracked file emits that event. The old Untracked diff can therefore refresh before status removes its component. `src/core/git-client.ts:210` then refuses it because it is now indexed.

Deterministic reproduction using `testCore()` only: write a two-line new file, read its untracked diff, stage it, then ask for that same untracked diff before asking for new status. The new regression initially failed with the exact crawler error: `That is not an untracked file in this project.`

## Correction

When the requested file is no longer untracked, Git is asked whether that exact literal path is now in the index. If so, the old untracked area returns an empty diff, consistently with the existing staged/changed area behavior when a file leaves that area. No file content is read in this path. Paths absent from both lists still refuse; the ancestor-link and `.git/config` containment tests stay unchanged and pass.

The regression also stages only one of two lines, verifies the old untracked area is empty, verifies the index contains only the chosen line, verifies the remaining line is shown as Changed, and verifies the working file retains both lines. Unstaging restores the original untracked diff.

## Verification

- `core/workbench.test.ts` — “an untracked diff refreshed after whole-file or partial staging is empty, without hiding staged work”: red before correction, green afterward.
- Existing “an untracked diff cannot read through a directory link outside the checkout”: green unchanged.
- Typecheck: pass.
- Complete workbench/conflict suites: 29 tests passed, 0 failed (`staging-workbench-tests.log`, 25.7 seconds).
- Deterministic browser check: added to the normal crawler Checks surface. It holds the status refresh until the old Untracked diff request returns, stages the file through its real checkbox, and requires an empty diff, no error, and the new Unstage control. The focused Checks surface passed all 29 checks in 28.6 seconds (`staging-crawl-checks.log`).
- The browser check was written after the core correction; its product-failure red run was not observed. The core regression supplied the pre-fix red evidence. Two browser-test setup failures (an offscreen lazy diff, then an immediate checkbox-state expectation while status was deliberately held) were corrected before its green run.
- `git diff --check`: pass.
- The complete `npm test` rerun passed, exit 0: 523 units, full UI sweep and all crawl jobs. The two previously failing views passed 440 and 307 controls; aggregate crawl: 2,129 passed, zero failed. Full counts are in the main review report.

The product correction changes only the core diff reader; its regression tests and feature-proof row accompany it. No renderer behavior, crawler allow-list or production safety refusal was bypassed to make the test pass. No real user data, credentials, model turns or repositories were used.
