# Session checkout review verification

Captured with `scripts/probe-review-checkout.mjs` in an isolated Electron renderer using synthetic bridge data. The probe does not run Wanigan's main process, real agents, Git commands, or user-data mutations. Every screenshot is labelled as a synthetic fixture. These checks establish renderer behavior and requested API arguments; the main-process smoke suite separately verifies actual checkout execution and content comparison.

## Before and after

| View | Before | After |
| --- | --- | --- |
| Session Review, dark | [Before](before/session-review-dark.png) | [Current content](after/session-review-dark.png) |
| Session Review, light | [Before](before/session-review-light.png) | [Current content](after/session-review-light.png) |
| Project checks, dark | [Before](before/project-review-dark.png) | [After](after/project-review-dark.png) |
| Project checks, light | [Before](before/project-review-light.png) | [After](after/project-review-light.png) |

The baseline renderer was preserved before the implementation changed. It explicitly shows project-checkout checks alongside a different session worktree. The after view identifies the session checkout and separates the historical command outcome from the current content comparison.

Additional after states, each in both themes:

- Stale content: [dark](after/session-review-stale-dark.png), [light](after/session-review-stale-light.png).
- Comparison unavailable: [dark](after/session-review-comparison-unavailable-dark.png), [light](after/session-review-comparison-unavailable-light.png).
- Historical evidence without checkout identity: [dark](after/session-review-unverified-dark.png), [light](after/session-review-unverified-light.png).
- 1024px desktop with a deliberately long checkout path: [dark](after/session-review-1024-long-path-dark.png), [light](after/session-review-1024-long-path-light.png).

## Verification

The final probe passed 11 checks with no page errors: correct session history/run scope, project-only scope, stale comparison behavior, unchanged historical command outcomes, unavailable and legacy evidence labels, preservation of an unsaved recipe during refresh, scope switching, and long-path wrapping without horizontal overflow. [Machine-readable result](after/verification.json).

Visual inspection found readable labels and controls in both themes. Longer result detail scrolls within the check pane; the 1024px view wraps the checkout path and result summary without horizontal overflow.

The probe reproduced a misleading success notice that continued to claim matching content after the result became stale. The implementation changed that notice to describe the completed command outcome only, and the regression check now passes.

Run against the current built renderer with Node 22.23.2:

```sh
node scripts/probe-review-checkout.mjs
```

`--before` uses the session's preserved temporary baseline renderer; the baseline screenshots and result JSON are the durable record if that temporary directory is later removed. Neither screenshot capture mode touches the running Wanigan application.
