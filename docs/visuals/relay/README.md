# Relay · the sluice

Captures from `scripts/shots-browser.mjs` (renderer harness, main process
stubbed) on 2026-09-18, both themes.

| File | What it shows |
| --- | --- |
| `relay-dark-after.png`, `relay-light-after.png` | The new Relay view: the rig (five vessels, funnel floors, gates, pipes), the fluid tier with the solver running in the Plan vessel, the composer, Now and Forecast. A new destination has no "before". |
| `settings-*-before.png` | Settings › App at commit `8238529`, before the `fluid` preference existed. |
| `settings-*-after.png` | The same pane with the Fluid options beside Motion. |

What the water is: the vendored Position Based Fluids solver (`src/renderer/src/relay/fluid/solver.ts`) running against the rig as its boundary, rendered in screen space (`render.ts`). The harness has WebGL2 via SwiftShader, so the fluid tier is what it captured; on a machine without WebGL2 float targets the rig's own animated level renders instead.

Known harness noise, verified pre-existing at `8238529` by building that commit in a throwaway worktree and running the same script: the Changes, Schedules and Settings views throw inside the stub (`'hint'`, `'length'`, `.match`) because the harness answers their IPC with placeholder shapes. Those are not regressions of this change and are not fixed by it.
