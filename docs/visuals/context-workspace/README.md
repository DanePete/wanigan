# Context workspace · desktop redesign

Context now has a seven-area directory, a focused report, and a separate source
reader. It follows the [approved desktop direction](../desktop-workspaces/README.md)
with the existing system typography, charcoal and porcelain surfaces, and shared
status and navigation primitives.

Instructions and rules use file lists that retain load order, scope, imports,
warnings, sizes, and managed provenance. Selecting a file opens its read-only
source beside the report. The memory index is directly readable, along with
topic files. Settings and hooks keep their layered evidence tables; permission
rules can be expanded to read every allow, ask, and deny entry.

Each area stays mounted while changing sections. The selected area, source,
instruction filters, and report scroll positions are remembered per project
during navigation. A narrower desktop turns the directory into a tab row and
gives the source the working area; closing it restores the report. Sections and
sources reveal with brief motion, respecting Off and system Reduce Motion.

Project changes remount the scoped workspace immediately. Scan revisions discard
late responses; source reads have their own cancellation boundary. A rescan
reloads the selected source, and a file absent from the new scan loses its old
preview. Failed file reads offer a retry and truncated previews say so. The
reader renders file contents as text, with optional line wrapping.

The memory meter now shows the scanner's reported loaded/dropped **lines** and
compares file size with the byte cap separately. It does not invent loaded bytes
from the cap. Startup estimates retain their notation; the configured briefing
ceiling is shown as a setting. The page identifies which readings concern the
Claude Code harness and keeps Codex compiler targets distinct from a predicted
Codex load order.

The existing `/init` action remains explicit and only types into a running
Claude Code session in the selected project. It does not create a session or
press Enter. This redesign does not change the main-process file allowlists,
projection permissions, or learning controls.

## Screenshots

| Area | Before | After |
| --- | --- | --- |
| Instructions | [Dark](before/instructions-dark.png), [light](before/instructions-light.png) | [Dark](after/instructions-dark.png), [light](after/instructions-light.png) |
| Rules | [Dark](before/rules-dark.png), [light](before/rules-light.png) | [Dark](after/rules-dark.png), [light](after/rules-light.png) |
| AGENTS.md | [Dark](before/agents-dark.png), [light](before/agents-light.png) | [Dark](after/agents-dark.png), [light](after/agents-light.png) |
| Memory | [Dark](before/memory-dark.png), [light](before/memory-light.png) | [Dark](after/memory-dark.png), [light](after/memory-light.png) |
| Settings & hooks | [Dark](before/config-dark.png), [light](before/config-light.png) | [Dark](after/config-dark.png), [light](after/config-light.png) |
| Startup budget | [Dark](before/budget-dark.png), [light](before/budget-light.png) | [Dark](after/budget-dark.png), [light](after/budget-light.png) |
| Learning briefing | [Dark](before/learning-dark.png), [light](before/learning-light.png) | [Dark](after/learning-dark.png), [light](after/learning-light.png) |
| Source reader | — | [Dark](after/source-dark.png), [light](after/source-light.png) |

Each area also has `after/<area>-narrow-<theme>.png` at an 820 × 960 desktop
window size (`chain` names Instructions). The regular captures use a 1440 × 1000
window. The narrow source is shown in [dark](after/source-narrow-dark.png) and
[light](after/source-narrow-light.png).

These are the actual renderer in isolated Electron with synthetic files and
recording services. Before captures use the verified previous Board release's
renderer archive, so both versions receive the same corrected fixtures. No
production files, credentials, or agent responses were copied into these
screenshots. They are layout and interaction evidence, not operational claims.

## Verification

`node scripts/probe-context-workspace.mjs` passed ten interaction groups with no
renderer errors. [Verification](after/verification.json) records section and
keyboard navigation, source identity and focus restoration, read failures and
truncation, remembered filters, memory and permission evidence, delayed project
reads, partial failures, rescans, reduced motion, narrow layout, and explicit
`/init` routing. All seven narrow areas had no page-level horizontal overflow.

The probe makes no real agent calls or file writes through Wanigan. Its `/init`
check records the intended command in a fixture. The obsolete source assertion
that pinned setup-card placement in the former long report was retired; the
renderer probe exercises the replacement empty-area action directly. The style
gate's Context allowance was reduced from 113 to 44 inline objects and the
surface stylesheet from 16 literal font sizes to zero.

The required `npm test` passed all five stages, including **1,540 offline smoke
assertions**, with zero failures. `git diff --check` passed. Final screenshots
were visually inspected in both themes, including the source reader, permission
tables, and the full-width memory meter.

Both Mac architectures passed sealed ad-hoc signature, archive-integrity,
hardened-fuse, and executable PTY-helper verification. The arm64 bundle was
installed through the graceful local installer and relaunched; the installed
archive matches the verified build. [Build evidence](build-verification.json)
records the hashes.

Native inspection confirmed the seven-area directory and a successful real
instruction-file read in the installed app. The source remained read-only,
retained its path and byte count, and received keyboard focus. The app was left
on Context with the selected project's CLAUDE.md open. No Wanigan-started agent
sessions were running before installation. Native inspection changed only
navigation and the destination-list visibility; it did not send a command,
modify a source file, or change provider settings. Production file contents
were not copied into this evidence directory.
