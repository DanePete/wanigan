# Workflow usability evidence

These captures accompany the [workflow source audit](../../research/2026-09-19-workflow-ui-audit.md)
and the [primary-source design research](../../research/2026-09-19-usability-sources.md).

The production renderer is served in an isolated browser with explicit
fictional session, attention, report, and relay records. Execution and mutation
calls are refused by the fixture. These captures establish presentation and
renderer interaction behavior, not real workloads, IPC, provider support,
persistence, or measured usability improvement.

The before renderer was frozen at
`/private/tmp/wanigan-usability-before-20260919/renderer`. Each phase's
`verification.json` records its renderer directory, index hash, screenshot
names, viewports, and outcome. Headless Chromium cannot provide a WebGPU
adapter here; the existing orb fallback is visible and the exact environment
limitation is recorded separately from unexpected UI errors.

The probe covers:

- Fleet's selected session before and after it leaves a live status filter,
  including an empty filtered list and removal of the actual record.
- Finished-turn inspection language while preserving explicit Stopped labels.
- Empty Insights report access, deliberate budget creation, retention of an
  unsaved budget across report switches, and unpriced recorded activity.
- Relay review and stale-refresh behavior. After assertions cover launch,
  forecast, stage completion, verification, reopening and final decisions,
  while evidence and session navigation remain available.
- Home's finished-session action and its explanation of the Review work step.

Representative views are captured in dark and light themes, including compact
Fleet, Insights, and Relay layouts. The before run captures existing behavior;
the after run asserts the intended transitions.

Both recorded runs passed with no unexpected browser errors. The baseline
contains 22 screenshots; the final renderer passed all five grouped regression
checks and contains 24 screenshots. Representative captures were visually
inspected in both themes, including compact layouts. The final renderer index
SHA-256 is `c826f947f5fb7ba4c5d2a723f9f5baa917d00da33aea4eed69da128eb0059236`.

Reproduce using Node 22.23.2. Build the final renderer before the after run:

```sh
WANIGAN_RENDERER_ROOT=/path/to/frozen/renderer node scripts/probe-workflow-usability.mjs before
node scripts/probe-workflow-usability.mjs after
```

Main-process verification remains the separate repository `npm test` suite.
