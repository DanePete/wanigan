# Ten more desktop design phases

Implemented September 11, 2026. [Research and primary sources](../../research/2026-09-11-desktop-next-ten-phases.md).

This pass brings the established desktop design into the smaller workflows people use repeatedly. It introduces no animation library, new provider integration or automatic model calls.

## Before and after

These are actual Electron renderer captures with authored project, session and code fixtures. They are visual/interaction evidence, not observations of a real agent workload. Every paired view was captured in both themes. The baseline was built before this pass; the previous working-tree changes were preserved.

| Phase | Result | Before | After |
| --- | --- | --- | --- |
| 1 · Command search | Categories, a selected-action preview, stable async selection and normal caret keys. | [Dark](before/commands-dark.png) · [Light](before/commands-light.png) | [Dark](after/commands-dark.png) · [Light](after/commands-light.png) |
| 2 · Shortcut discovery | Search the actual binding list by action, key or context. | [Dark](before/shortcuts-dark.png) · [Light](before/shortcuts-light.png) | [Dark](after/shortcuts-dark.png) · [Light](after/shortcuts-light.png) |
| 3 · Session launch | A wider form, live launch summary, section navigation and a persistent Start action. | [Dark](before/launch-dark.png) · [Light](before/launch-light.png) | [Dark](after/launch-dark.png) · [Light](after/launch-light.png) |
| 4 · Drafting | A writing surface and searchable saved prompts; restoring does not send. | [Dark](before/composer-dark.png) · [Light](before/composer-light.png) | [Dark](after/composer-dark.png) · [Light](after/composer-light.png) |
| 5 · Activity timeline | Events first, with tool timing available on demand and explicit filter recovery. | [Dark](before/timeline-dark.png) · [Light](before/timeline-light.png) | [Dark](after/timeline-dark.png) · [Light](after/timeline-light.png) |
| 6 · Code reading | A full desktop reader with previous/next matching lines, wrapping and focus return. | [Dark](before/reader-dark.png) · [Light](before/reader-light.png) | [Dark](after/reader-dark.png) · [Light](after/reader-light.png) |
| 7 · Alerts and recovery | Urgency in words and symbols, time, readable actions, and an honest view recovery screen. | [Dark](before/alerts-dark.png) · [Light](before/alerts-light.png) | [Dark](after/alerts-dark.png) · [Light](after/alerts-light.png) |
| 8 · Narrow windows | A full-width Details view; terminal, draft and selected file survive resizing. | [Dark](before/compact-dark.png) · [Light](before/compact-light.png) | [Dark](after/compact-dark.png) · [Light](after/compact-light.png) |
| 9 · Accessibility | Solid materials, stronger boundaries and real focus outlines under supported media preferences. | [Dark](before/appearance-dark.png) · [Light](before/appearance-light.png) | [Dark](after/appearance-dark.png) · [Light](after/appearance-light.png) |
| 10 · Play with Wanigan | A visible invitation, named play control, material guidance and feedback beside the globe. | [Dark](before/play-dark.png) · [Light](before/play-light.png) | [Dark](after/play-dark.png) · [Light](after/play-light.png) |

More useful states:

- Saved prompts: [before, dark](before/saved-prompts-dark.png), [before, light](before/saved-prompts-light.png), [after, dark](after/saved-prompts-dark.png), [after, light](after/saved-prompts-light.png).
- Code search: [dark](after/reader-search-dark.png), [light](after/reader-search-light.png).
- Compact details: [dark](after/compact-details-dark.png), [light](after/compact-details-light.png).
- Short launch window: [dark](after/launch-short-dark.png), [light](after/launch-short-light.png).
- View recovery: [before, dark](before/recovery-dark.png), [before, light](before/recovery-light.png), [after, dark](after/recovery-dark.png), [after, light](after/recovery-light.png).
- Increased contrast: [dark](after/contrast-dark.png), [light](after/contrast-light.png).
- Forced colours: [dark preference](after/forced-colors-dark.png), [light preference](after/forced-colors-light.png). The emulated system palette determines these colours.
- Reduced transparency: [dark](after/opaque-dark.png), [light](after/opaque-light.png).

## Verification

- Node 22.23.2; `npm test`: typecheck, 24 shared tests, renderer style gate, packaging-hook fixtures, local-installer fixtures, and 1,582 offline smoke assertions passed.
- `npm run probe:chords`: 10 direct-effect checks and two bridge-consumption checks passed. Its eight control-local skips are named in the probe; the new renderer probe exercises the changed palette, saved-prompt and reader interactions directly.
- `node scripts/probe-next-ten.mjs`: all 13 workflow groups passed, including deliberately reordered transcript replies, a refused launch, view-render recovery, keyboard focus, narrow layouts and real GPU material changes. [Machine-readable result](after/verification.json).
- `node scripts/probe-orb-materials-ui.mjs --output=docs/visuals/next-ten/materials`: all ten material choices, both character sizes, snow continuity, play actions, conversation vortex, one answer burst, event deduplication and motion-off checks passed with no renderer errors. [GPU verification](materials/ui-verification.json).
- `npm run build` and `git diff --check` passed.

The renderer probe cannot establish main-process integration: its preload methods are authored fixtures. It creates a separate Electron profile and sends no real provider requests, repository actions or PTY writes. The main-process checks run offline through the repository’s smoke suite.

Accessibility checks emulate Chromium media features. They verify the renderer response to reduced motion, increased contrast, forced colours and reduced transparency; they do not claim that every native macOS preference is forwarded automatically by Electron.

## Build delivery

Both macOS installers were rebuilt from this source: `release/Wanigan-0.1.0-arm64.dmg` for Apple silicon and `release/Wanigan-0.1.0.dmg` for Intel. All 25 packaged output files match the tested build in each architecture, and both app bundles pass `codesign --verify --deep --strict`. These are local, ad-hoc signed builds, not notarized distribution releases. [Build hashes and verification](build-verification.json).

The new build has not been installed. The running Wanigan app was left open so its live agent sessions were not interrupted.

## Implementation notes

The code reader now uses the shared dialog lifecycle. Its search counts matching lines, and Enter/Shift+Enter cycle those lines. Command search retains selected identity while transcript results arrive, discards late replies to older queries, and distinguishes an unavailable archive from no matches.

Normal alerts retain their original arrival-based expiry; urgent alerts remain until dismissed. View recovery no longer asserts that an unobserved session is still running. A session that is starting is also described as starting in the composer, with sending still blocked until its prompt is ready.

Compact Details keeps the terminal mounted. A side panel opened on the desktop retains its file selection when the window narrows; returning to the terminal keeps the draft. No window close or installed-app restart is part of these checks.

The play panel leaves the globe visible at desktop widths. Opening Play brings the full companion into view, and the picker stays bounded below the header even after the Mission room has been scrolled. Rain, splash and bubble buttons select water; ink selects the ink material. Session-driven effects still come from their existing recorded signals, and appearance/play does not launch agent work.
