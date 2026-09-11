# Scout workspace · desktop redesign

Scout now opens on a proposal directory beside a selected reader. Brief,
Evidence, and Goal keep the recommendation, retained sources, and explicit
work handoff distinct. Sources and Watch have their own workspace sections;
setup no longer buries the review queue. Shared controls, theme tokens, a
quiet selection transition, and animated native checkbox switches carry the
established desktop design forward.

Search, status, order, selected proposal, reader section, and Goal destination
survive navigation. The view explains that ordering applies to its loaded set
of up to 150 proposals. Rule confidence remains labelled as rule-derived rather
than measured. Source links sit outside checkbox labels and accept only HTTPS.

Local preview still passes no network flag. A manual check explicitly requests
one online pass; saved unattended consent and the weekly schedule remain
separate. Scan feedback uses the recorded outcome and reason, including
blocked, failed, running, or unknown results. No simulation replaces a real
scan. Goal creation uses only the Scout endpoint that verifies retained official
evidence; execution remains a separate action in Review.

Failed first reads do not invent zeros. Failed refreshes retain the previous
snapshot and disable mutations until a read succeeds. Actions are serialized,
late replies after unmount are ignored, and a successful Goal receipt stays
visible even when its subsequent refresh fails. Notices persist until another
action or dismissal.

## Screenshots

| Surface | Before dark | Before light | After dark | After light |
| --- | --- | --- | --- | --- |
| Proposals | [Dark](before/proposals-dark.png) | [Light](before/proposals-light.png) | [Dark](after/proposals-dark.png) | [Light](after/proposals-light.png) |
| Evidence | [Dark](before/evidence-dark.png) | [Light](before/evidence-light.png) | [Dark](after/evidence-dark.png) | [Light](after/evidence-light.png) |
| Watch and setup | [Dark](before/watch-dark.png) | [Light](before/watch-light.png) | [Dark](after/watch-dark.png) | [Light](after/watch-light.png) |

| Additional state | Dark | Light |
| --- | --- | --- |
| Sources | [Dark](after/sources-dark.png) | [Light](after/sources-light.png) |
| Goal destination | [Dark](after/goal-dark.png) | [Light](after/goal-light.png) |
| Search | [Dark](after/search-dark.png) | [Light](after/search-light.png) |
| No matches | [Dark](after/no-match-dark.png) | [Light](after/no-match-light.png) |
| Unknown scan outcome | [Dark](after/scan-outcome-dark.png) | [Light](after/scan-outcome-light.png) |
| Goal created, refresh failed | [Dark](after/goal-refresh-unavailable-dark.png) | [Light](after/goal-refresh-unavailable-light.png) |
| Refresh unavailable | [Dark](after/read-unavailable-dark.png) | [Light](after/read-unavailable-light.png) |
| First read unavailable | [Dark](after/first-read-unavailable-dark.png) | [Light](after/first-read-unavailable-light.png) |
| Observed empty queue | [Dark](after/empty-dark.png) | [Light](after/empty-light.png) |
| Narrow proposal reader | [Dark](after/proposals-narrow-dark.png) | [Light](after/proposals-narrow-light.png) |
| Narrow sources | [Dark](after/sources-narrow-dark.png) | [Light](after/sources-narrow-light.png) |
| Narrow watch | [Dark](after/watch-narrow-dark.png) | [Light](after/watch-narrow-light.png) |

Captures use the actual renderer in isolated Electron with synthetic records at
1440 × 1000 and 1024 × 900. Before captures load the previous installed archive
with the same fixture. The probe does not change production settings, fetch
sources, call a model, create a real Goal, or launch an agent.

## Verification

`node scripts/probe-scout-workspace.mjs` passed seven interaction groups:
search and remembered navigation; proposal lifecycle; local/manual scan routing
and recorded outcomes; source and schedule consent; Goal serialization and
receipt retention; failed and delayed reads; and empty/narrow layouts and
motion preferences. There were no renderer errors or measured horizontal
overflows. Off disables the reader animation and Auto follows reduced motion.
[Recorded results](after/verification.json).

The required `npm test` passed all five stages, including **1,565 offline smoke
assertions**, with zero failures. `git diff --check` passed. Before and after
captures were inspected in both themes, including the evidence reader, source
directory, scheduling controls, and the populated narrow desktop layout.

Both Mac architectures passed strict sealed ad-hoc signature, hardened-fuse,
ASAR-integrity, and executable PTY-helper checks. They contain the same renderer;
the orb runtime still matches the prior GPU verification exactly. The graceful
installer updated `/Applications/Wanigan.app` and launched PID 50988. The
installed archive matches the verified arm64 package. [Build verification](build-verification.json).

Native inspection confirmed the Proposals/Sources/Watch sections, four stored
proposals, the selected brief and evidence reader, five existing enabled
sources, and the saved schedule permissions. Only navigation and reading were
used against production records. Wanigan is left open on Scout’s Proposals
section with Brief selected. Plugins is the next Knowledge page.
