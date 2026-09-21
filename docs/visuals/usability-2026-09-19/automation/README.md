# Automation preparation

The captures use the production renderer with an isolated Electron profile and
fictional schedule, dataset, provider and API records. They do not exercise
real scheduling, agents, paid API requests or the main-process trust boundary.

The before build is frozen at `6fd50c7` in
`/private/tmp/wanigan-usability-before-20260919/renderer`. The after build
contains the renderer changes from this task. The same fixture is used for
both. Each directory includes its machine-readable `verification.json`.

| View | Before, dark / light | After, dark / light |
| --- | --- | --- |
| Weekday schedule at 10:30 | [Dark](before/schedule-weekdays-dark.png) · [Light](before/schedule-weekdays-light.png) | [Dark](after/schedule-weekdays-dark.png) · [Light](after/schedule-weekdays-light.png) |
| Starting a batch | [Dark](before/batch-start-dark.png) · [Light](before/batch-start-light.png) | [Dark](after/batch-start-dark.png) · [Light](after/batch-start-light.png) |
| Dataset loaded, estimate still needed | [Dark](before/batch-estimate-dark.png) · [Light](before/batch-estimate-light.png) | [Dark](after/batch-estimate-dark.png) · [Light](after/batch-estimate-light.png) |
| Failed test request in a 960px window | — | [Dark](after/batch-compact-dark.png) · [Light](after/batch-compact-light.png) |

`scripts/probe-automation-usability.mjs` verifies common timing input,
incomplete-time validation, weekly Sunday selection, preserved custom cron,
batch step focus, actionable blockers, absence of requests during navigation,
explicit estimate execution, and a failed test request blocking submission.
The older `probe-schedules-workspace.mjs` continues to exercise raw cron by
choosing Custom cron first.

The final run passed all four grouped automation checks with zero renderer
errors. The existing schedule workspace probe also passed all five grouped
checks; its [record](after/schedule-regression.json) includes draft retention,
failed/stale reads, explicit scope consent, and 960/720px layouts. The final
renderer index SHA-256 was
`c826f947f5fb7ba4c5d2a723f9f5baa917d00da33aea4eed69da128eb0059236`.

Reproduce with Node 22.23.2 after the coordinated renderer build:

```sh
WANIGAN_RENDERER_ROOT=/private/tmp/wanigan-usability-before-20260919/renderer node scripts/probe-automation-usability.mjs --before
node scripts/probe-automation-usability.mjs
```

Visual inspection covered both themes, the common schedule fields and their
preview, the batch next/back row, the blocker links, and the narrower layout.
These are behavior and layout checks, not measured usability improvements.
