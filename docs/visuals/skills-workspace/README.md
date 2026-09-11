# Skills workspace · desktop redesign

Skills now separates Library, Write, and Sources. The library keeps its search
and source filters beside a selected workflow reader, with distinct SKILL.md
and Details sections. The reader displays the file's actual text, its origin,
invocation, and helper-file count. Reading and the catalogue scroll independently.

The writer puts the authored instructions beside the exact generated document.
Editing a field or changing providers invalidates the preview. Installation is
an explicit action after review; blocking diagnostics disable it. Successful
provider receipts remain visible when another provider fails, and retries target
only the failed providers. Nothing is automatically committed. The existing
local formatter is used; this form does not call a model.

Project pins, queries, filters, selected files, reader sections, and writer
inputs survive navigation. The writer waits for its project before initializing
its remembered form. Switching projects requires a fresh preview. Delayed reads
cannot replace a newer selection or scope, and failed rescans preserve the last
observation while disabling session typing. Typing an invocation never presses
Enter; the main process still validates the selected session's support.

This remains the Claude Code catalogue exposed by the existing view, including
its explicit partial built-in coverage. Authoring can also produce Codex skill
files; the installation receipt explains that those files do not appear in this
catalogue. The redesign does not broaden provider support.

Shared controls, typography, color, and motion tokens drive the presentation.
The old Skills rules in `evals.css` have been replaced by `skills.css`, and their
literal-font allowance retired. Selection and preview changes settle once;
Off disables that motion and Auto follows the operating system. The existing
companion remains in the shared frame.

## Screenshots

| View | Before dark | Before light | After dark | After light |
| --- | --- | --- | --- | --- |
| Library | [Dark](before/library-dark.png) | [Light](before/library-light.png) | [Dark](after/library-dark.png) | [Light](after/library-light.png) |
| Reader | [Dark](before/reader-dark.png) | [Light](before/reader-light.png) | [Dark](after/reader-dark.png) | [Light](after/reader-light.png) |
| Writer | [Dark](before/writer-dark.png) | [Light](before/writer-light.png) | [Dark](after/writer-dark.png) | [Light](after/writer-light.png) |
| Sources | [Dark](before/sources-dark.png) | [Light](before/sources-light.png) | [Dark](after/sources-dark.png) | [Light](after/sources-light.png) |

| Additional view | Dark | Light |
| --- | --- | --- |
| Details | [Dark](after/details-dark.png) | [Light](after/details-light.png) |
| Search | [Dark](after/search-dark.png) | [Light](after/search-light.png) |
| No matches | [Dark](after/no-match-dark.png) | [Light](after/no-match-light.png) |
| Failed file read | [Dark](after/read-unavailable-dark.png) | [Light](after/read-unavailable-light.png) |
| Truncated document | [Dark](after/truncated-dark.png) | [Light](after/truncated-light.png) |
| Failed rescan | [Dark](after/scan-unavailable-dark.png) | [Light](after/scan-unavailable-light.png) |
| Document preview | [Dark](after/preview-dark.png) | [Light](after/preview-light.png) |
| Blocking diagnostics | [Dark](after/blocked-draft-dark.png) | [Light](after/blocked-draft-light.png) |
| Partial installation | [Dark](after/partial-install-dark.png) | [Light](after/partial-install-light.png) |
| Installed receipts | [Dark](after/installed-dark.png) | [Light](after/installed-light.png) |
| Empty catalogue | [Dark](after/empty-dark.png) | [Light](after/empty-light.png) |
| Narrow library | [Dark](after/library-narrow-dark.png) | [Light](after/library-narrow-light.png) |
| Narrow writer | [Dark](after/write-narrow-dark.png) | [Light](after/write-narrow-light.png) |
| Narrow sources | [Dark](after/sources-narrow-dark.png) | [Light](after/sources-narrow-light.png) |

Captures use the actual renderer in isolated Electron with synthetic records,
at 1440 × 1000 and a 1024 × 900 narrow desktop window. Before captures read the
previous installed archive with the same fixture. No real agent is launched,
model called, session typed into, or skill file installed by this probe.

## Verification

`node scripts/probe-skills-workspace.mjs` passed eight interaction groups:
search and keyboard selection; delayed and failed file reads; project isolation
and rescan failures; explicit copy/reveal/type actions; authoring and preview
invalidation; partial installation and retries; draft retention across project
and page navigation; and motion, narrow layout, and observed empty states.
There were no renderer errors or horizontal page/panel overflow at the measured
narrow width. [Recorded results](after/verification.json).

The required `npm test` passed all five stages, including **1,564 offline smoke
assertions** with zero failures. `git diff --check` passed. Screenshots were
visually inspected in both themes, including the library, writer preview,
source provenance, empty state, and narrow desktop layout.

Both Mac architectures passed strict sealed ad-hoc signature, hardened-fuse,
ASAR-integrity, and executable PTY-helper verification with the same renderer
hash. The graceful local installer installed the arm64 build and reopened
`/Applications/Wanigan.app` as PID 34188. The installed archive matches the
verified package; hashes are in [build verification](build-verification.json).

Native inspection confirmed Library/Write/Sources navigation, the project
selector, search and source filters, 36 observed catalogue records, and the
selected file's reader and invocation. Only navigation and reading were
exercised against production records. The last inspected app state was Skills
Library. Scout is the next Knowledge page.
