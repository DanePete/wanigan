# Compact project switcher

The project strip is now one bounded control showing All spaces or the selected
project. Its menu searches names and folder paths, marks the selected space,
keeps the full list scrollable, and includes Add space. The header no longer
grows as projects are added.

The menu uses the shared dialog contract, arrow-key selection, Enter, Escape,
and a short opening transition that respects reduced motion. A backdrop click
now prevents the browser's default focus change from overriding the shared
dialog's focus restoration.

## Screenshots

These are isolated Electron fixtures with fictional projects and sessions.
They make no provider requests and do not read personal project data. Before
captures load the installed app archive; after captures load the rebuilt app archive.

| View | Dark | Light |
| --- | --- | --- |
| Before, 20 projects | [Header](before/header-20-dark.png) | [Header](before/header-20-light.png) |
| After, 20 projects | [Header](after/header-20-dark.png) | [Header](after/header-20-light.png) |
| Searchable menu | [Menu](after/switcher-20-dark.png) | [Menu](after/switcher-20-light.png) |
| Last of 80 projects | [Menu](after/switcher-80-dark.png) | [Menu](after/switcher-80-light.png) |
| No search matches | [Empty search](after/no-match-dark.png) | [Empty search](after/no-match-light.png) |
| 960-pixel window | [Menu](after/switcher-960-dark.png) | [Menu](after/switcher-960-light.png) |
| 720-pixel window | [Menu](after/switcher-720-dark.png) | [Menu](after/switcher-720-light.png) |

## Verification

`npm test` passed: typecheck, renderer style, packaging hooks, local installer
fixtures, and **1,594 smoke assertions, zero failures**. See [the test log](npm-test.log).

`node scripts/probe-space-switcher.mjs` passed six interaction groups with no
renderer errors. It checks name/path search, keyboard selection, focus trapping
and restoration, outside-click dismissal, project scope in Sessions/Changes/
Context, Add space, zero projects, and 20/80-project lists. Header width stays
constant with project count; menu bounds are checked at 1280, 960, and 720 pixels.
See [the interaction record](after/verification.json).

Build and verification ran in an isolated source/dependency copy so another
session building this working tree could not replace renderer chunks during a
check. [Source hashes](source-manifest.json) identify that snapshot. Concurrent
onboarding edits made after the snapshot remain in the working tree and are
outside this header build.

## Mac builds

Both architectures rebuilt successfully and contain the same renderer. Their
ad-hoc resource seals, hardened fuses, ASAR integrity and executable PTY helpers
were verified. The GPU runtime hash is unchanged from the prior physics checks.
See [package verification](build-verification.json) and [the build log](package.log).

The app bundles are staged under `release/space-switcher/mac-arm64/Wanigan.app`
and `release/space-switcher/mac/Wanigan.app`. The installed app was left running
because it had an active Claude session. A full app restart ends live agent
processes.
