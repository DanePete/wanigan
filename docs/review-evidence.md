# Review checks and checkout evidence

Session Review runs the project's saved recipe in the selected session's recorded
checkout. Main resolves the session ID to its saved project and worktree; the
renderer cannot supply a directory. A missing or replaced worktree refuses a
run instead of falling back to the primary checkout. Project checks remain
available from Changes, with their own history.

Each new run records the canonical working directory, session identity when
applicable, HEAD, the exact command list and recipe hash, and content fingerprints
before and after execution. Command exit codes and output remain historical
facts. Their content comparison can be **Content matches**, **Stale**, or
**Unverified** without rewriting a recorded pass as a command failure.

The comparison covers the entire Git checkout: HEAD, staged index entries and
flags, tracked file contents and permissions, and non-ignored untracked files.
Changes during execution make the result stale even when all commands exit zero.
Later content, revision, staging or recipe changes invalidate the comparison.
Restoring exactly the same content and recipe can match a previously stable run.

Ignored files, installed tools, environment settings and inputs outside the
checkout are not captured. This is not a reproducible environment or an atomic
filesystem snapshot. The reader makes two content passes and checks metadata for
detected concurrent edits. Only fingerprints are retained, not source copies.

The bounded reader supports at most 20,000 files, 1 GiB total content,
16 MiB per file, 8 MiB of Git metadata per command and 15 seconds per snapshot.
Non-Git projects, symlinks, submodules, unsupported paths, read failures and
exhausted bounds leave a run unverified. Commands may still run and retain their
observed results. An unverified result cannot provide a current goal proof.

While the panel is visible, running checks refresh every two seconds and settled
comparisons refresh every thirty seconds. Returning to the window or using
Refresh results also compares again. The displayed comparison describes the
last read; it does not promise that a running agent has stopped editing.

Goal verification records the review-run ID with its proof. Completing a verify
task or approving a goal rechecks the actual checkout and saved recipe in main.
Legacy, stale and unavailable evidence is refused. A goal, recipe or latest proof
changed during that asynchronous read must be reviewed again before the decision
is committed. The final decision also refuses an in-progress rerun or a newer
failed or incomplete run for the same checkout and recipe, including runs started
outside the goal. Successful commands without a current comparison produce a
recorded proof, not a passed proof.

SQLite migration adds nullable session and evidence columns. Existing runs and
proofs remain readable, but cannot acquire provenance retroactively: rerun their
checks to establish a current comparison.

Regression coverage is in `src/main/smoke-review.ts`,
`src/main/smoke-audit-integrations.ts` and the Control section of
`src/main/smoke3.ts`, using real temporary repositories, worktrees, sparse
large-checkout fixtures and shell commands. `scripts/probe-review-checkout.mjs`
checks the renderer with clearly labeled synthetic data. Before/after captures in both themes are under
[`docs/visuals/review-checkout-2026-09-15`](visuals/review-checkout-2026-09-15).
