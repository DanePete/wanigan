# CI merge-button assertion race

CI d0db71d passed all 522 unit tests, then the light-theme UI sweep failed with a disabled “Merge into main” button and cached empty title.

Root cause: `scripts/ui-sweep.mjs` waited for `.drawer .branch-line` (cards.get data), captured the title, then separately awaited `isDisabled()`. The independent sessions.list result could arrive between those two observations. A cached pre-response title was compared with the post-response disabled state. The UI eventually showed the correct refusal and explanation; the core independently refuses the mutation while an agent works in that checkout.

Deterministic reproduction: `/private/tmp/wanigan2-review/merge-readiness.mjs` gates sessions.list while allowing cards.get to render, captures the empty title, releases the response, and observes disabled:true plus the correct explanation. The original cached-title assertion fails with exit 1 (`merge-readiness-red.log`). With readiness awaited and title/disabled snapshotted together, dark and light both pass, exit 0 (`merge-readiness-green.log`).

Commit: `fccc63b189a96966cd00d5b74b1636e3b83eedc7` (only `scripts/ui-sweep.mjs`).

Fix: test only, `scripts/ui-sweep.mjs`: wait for the exact disabled+explanation state (bounded 8 seconds), then inspect both properties in one DOM evaluation. A missing refusal or explanation still fails; the assertion is not weakened and no production code or package assets changed. `node --check` and `git diff --check` pass. Full UI sweep against the existing build PASSED (exit 0), including both themes and the corrected card-merge assertion. Log: `ci-readiness-ui-sweep.log`. No assets were rebuilt and no production behavior changed.
