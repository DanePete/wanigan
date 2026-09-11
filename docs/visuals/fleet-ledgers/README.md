# Fleet, Usage, and Insights — desktop redesign

This production pass continues the approved Mission Room B direction and the
[Sessions and Changes workspaces](../desktop-workspaces/README.md). It uses the
existing desktop frame, companion, palette, and shared controls.

Fleet now has a selectable session roster and a larger inspector. Selection
stays on the same session when live attention changes the order. Switching
sessions clears an unfinished stop confirmation; neither sorting nor opening
the metrics ledger signals an agent. Large rosters scroll independently and
remember their position. The full comparison table, agent teams, and externally
observed sessions remain available below the working surface.

Usage is organized by account identity. The selected account's provider limits
sit beside its recorded consumption; identically named accounts remain separate
by harness and ID. All accounts is still available. Account selection is local
and does not trigger a provider probe. Missing costs, unsupported limits,
freshness, reset times, and partial cost labels remain explicit. Late responses
from an earlier reporting window cannot overwrite the current window, and a
failed refresh retains the last successful records.

Insights has four reports: Spending, Tokens & pace, Budgets, and Batch reports.
The existing charts and accounting sources remain intact. Report navigation
stays available while scrolling, and reports remain mounted so switching them
preserves budget and reconciliation drafts. The reporting window and selected
meter survive navigation away from Insights. Report-specific text identifies
which values are windowed, all-time, or month-to-date.

## Verification

`npm test` passed all five required stages, including 1,531 offline main-process
assertions with zero failures. The renderer probe passed eight behavior groups,
including a 21-session roster, with zero page errors. `git diff --check` passed.

## Installed build

The verified arm64 build was installed at `/Applications/Wanigan.app` and
launched successfully. Its installed ASAR hash matches the packaged build;
[build-verification.json](build-verification.json) records the bundle and
renderer digests, signature checks, and installed-copy verification.

The final native window inspection could not be completed: the computer-use
connection repeatedly returned `timeoutReached` after relaunch, including after
reconnecting. The process remained alive. A further graceful reopen was declined
and made no file changes. No force quit was performed. The screenshot and
interaction evidence above comes from the isolated actual-renderer checks.

## Visual evidence

The `before` and `after` folders contain actual Electron renderer screenshots in
both themes, using deterministic sample data. The after set also includes the
Tokens & pace report and 820px desktop windows. These are renderer fixtures,
not live account data or fabricated production telemetry.

- [Fleet, dark](after/fleet-dark.png) · [Fleet, light](after/fleet-light.png)
- [Usage, dark](after/usage-dark.png) · [Usage, light](after/usage-light.png)
- [Insights, dark](after/insights-dark.png) · [Insights, light](after/insights-light.png)
- [Renderer checks](after/verification.json)

Run `node scripts/probe-fleet-ledgers.mjs` after building to reproduce the
renderer checks. It uses a fresh Electron profile and a synthetic preload
bridge. No real agent is signalled, no budget is changed, no provider is called,
and no reconciliation request is sent. Motion is reduced for settled captures.

This pass covers these three desktop routes. Review, Settings, the remaining
project surfaces, knowledge tools, and automation screens remain in the broader
redesign plan; iPad and iPhone work follows the desktop pass.
