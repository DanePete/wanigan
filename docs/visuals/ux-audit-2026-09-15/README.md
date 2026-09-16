# Desktop UX audit evidence — September 15, 2026

This is an audit and design proposal, not a shipped redesign or an after-capture.
The analysis and proposed delivery sequence are in the
[deep dive](../../research/2026-09-15-desktop-ux-deep-dive.md).

## Current app

`current/` contains 52 screenshots of the current built Electron app: all 17
destinations in dark/light, launch/search/help/planning overlays, companion
controls, and six compact views. `scripts/shots.mjs` uses an isolated temporary
profile and the real main/preload bridge. It registers this repository and seeds
authored local goal/learning records. No coding agent is launched. It does not
read or modify the running user's Wanigan database.

The runner completed with no renderer errors and all 11 of its checks passed.
It does not establish agent/provider behavior or human usability. The build had
non-fatal chunk-size and mixed-import warnings.

Reproduce from the repository root with Node 22.23.2:

```sh
npm run build
node scripts/shots.mjs --out docs/visuals/ux-audit-2026-09-15/current --light
```

- [Verification and geometry](current/verification.json)
- [Runtime log](current/runtime-log.txt)
- [Home, dark](current/dark/mission.png) / [light](current/light/mission.png)
- [Sessions, dark](current/dark/sessions.png) / [light](current/light/sessions.png)
- [Review, dark](current/dark/control.png) / [light](current/light/control.png)
- [Launcher, dark](current/dark/overlay-new-session.png) / [light](current/light/overlay-new-session.png)
- [Home at 960×760](current/narrow/mission.png)

## Focused problem reproductions

`probes/` uses a real built renderer with a synthetic bridge in an isolated
Electron window. Every screenshot carries a fixture label. It reproduces context
loss, sidebar focus/Escape behavior, name-search failures, and a returned Git
read error displayed as no changes. These experiments do not run real Git,
main/preload, agents or persistence.

- [Probe provenance and reproduction](probes/README.md)
- [Observed inputs and results](probes/verification.json)

## Proposed Home

The [editable concept](../../research/2026-09-15-workbench-concept.html) contains
fictional work and local presentation interactions only. Its terminal and changes
previews are explicitly illustrative. It makes no network calls and cannot
launch, approve, write, or stop work. `concept/` contains six captures and a
[verification record](concept/verification.json): 22 checks passed, covering work
selection, action previews, project filters, navigation controls, and both themes
at 1024/736/360/320 pixels. No page errors or network requests occurred. The
standalone run omits optional host Tweak/Lucide support. Those captures are
proposals, not the current app or a production implementation.

The source manifest records the baseline source/build hashes for this audit.
Existing uncommitted session permission work is part of that baseline and was
not changed by this pass.
