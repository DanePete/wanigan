# Learning workspace · desktop redesign

Learning now has a section directory, a knowledge library beside a focused
reader, and an Inbox that opens one proposal at a time. Overview starts with
items needing attention, followed by the recorded pipeline and its day chart.
The scope selector remains visible above every section.

The knowledge reader separates Text, Evidence, and History. The library keeps
search, status filters, path grouping, text checks, and explicit bulk retirement.
The exact briefing payload is available through a disclosure above the library;
Context retains the per-entry preview, learning switches, token ceiling,
model-assistance controls, and diagnostics. Approval and applying a provider
file remain separate actions. No selection launches work or spends tokens.

Project scope changes clear the previous scope's content immediately. Request
revisions discard delayed item, search, and briefing responses. Failed reads
are distinct from observed empty stores, and failed refreshes retain the last
observation while disabling mutation controls. The attention link opens the
Inbox's decision filter; manually selected filters survive ordinary navigation.
Library selections, reader sections, search, and candidate edits are remembered
for their scope. The teaching dialog keeps focus while typing and retains its
draft when closed.

The shared frame, controls, typography, colors, and motion tokens drive the
presentation. Learning's two remaining literal font sizes were removed and its
style allowance retired. A selected record or reader section settles once;
Off disables this motion and Auto follows the operating system. The accepted
companion stays present in the app frame.

## Screenshots

| View | Before dark | Before light | After dark | After light |
| --- | --- | --- | --- | --- |
| Overview | [Dark](before/overview-dark.png) | [Light](before/overview-light.png) | [Dark](after/overview-dark.png) | [Light](after/overview-light.png) |
| Inbox | [Dark](before/inbox-dark.png) | [Light](before/inbox-light.png) | [Dark](after/inbox-dark.png) | [Light](after/inbox-light.png) |
| Library | [Dark](before/knowledge-dark.png) | [Light](before/knowledge-light.png) | [Dark](after/knowledge-dark.png) | [Light](after/knowledge-light.png) |
| Selected knowledge | [Dark](before/item-dark.png) | [Light](before/item-light.png) | [Dark](after/item-dark.png) | [Light](after/item-light.png) |
| Context | [Dark](before/context-dark.png) | [Light](before/context-light.png) | [Dark](after/context-dark.png) | [Light](after/context-light.png) |
| Teach | [Dark](before/teach-dark.png) | [Light](before/teach-light.png) | [Dark](after/teach-dark.png) | [Light](after/teach-light.png) |

| Additional view | Dark | Light |
| --- | --- | --- |
| Evidence and freshness | [Dark](after/evidence-dark.png) | [Light](after/evidence-light.png) |
| Version history | [Dark](after/history-dark.png) | [Light](after/history-light.png) |
| Proposal evidence | [Dark](after/proposal-evidence-dark.png) | [Light](after/proposal-evidence-light.png) |
| Exact payload | [Dark](after/payload-dark.png) | [Light](after/payload-light.png) |
| Briefing preview | [Dark](after/briefing-dark.png) | [Light](after/briefing-light.png) |
| Retirement | [Dark](after/retire-dark.png) | [Light](after/retire-light.png) |
| Failed item | [Dark](after/item-unavailable-dark.png) | [Light](after/item-unavailable-light.png) |
| Failed scope | [Dark](after/scope-unavailable-dark.png) | [Light](after/scope-unavailable-light.png) |
| Failed refresh | [Dark](after/refresh-unavailable-dark.png) | [Light](after/refresh-unavailable-light.png) |
| Empty Inbox | [Dark](after/inbox-empty-dark.png) | [Light](after/inbox-empty-light.png) |
| Empty library | [Dark](after/library-empty-dark.png) | [Light](after/library-empty-light.png) |
| Narrow library | [Dark](after/library-narrow-dark.png) | [Light](after/library-narrow-light.png) |
| Narrow Inbox | [Dark](after/inbox-narrow-dark.png) | [Light](after/inbox-narrow-light.png) |

Captures use the actual renderer in isolated Electron with synthetic records,
at 1440 × 1000 and a 1024 × 900 narrow desktop window. Before captures read the
previous installed archive with the same fixture and project. These are UI
checks, not production agent outcomes; no real model or agent is launched.

## Verification

`node scripts/probe-learning-workspace.mjs` passed 11 interaction groups:
reader sections and keyboard navigation; delayed/failed item reads; remembered
search and filters; project/personal scope isolation; proposal drafts and
separate approval/apply actions; teaching focus and submission; retirement;
briefing isolation; failed refreshes and Inbox deep links; motion and narrow
desktop layout; and observed empty states. There were no renderer errors and
no horizontal page or panel overflow at the measured narrow width.
[Recorded results](after/verification.json).

The final required `npm test` passed all five stages, including **1,564 offline
smoke assertions** with zero failures. `git diff --check` passed. The screenshots
were visually inspected in both themes, including the library reader, proposal
review, evidence, failed reads, empty states, and narrow desktop layout.

Both Mac architectures passed strict sealed ad-hoc signature, hardened-fuse,
ASAR-integrity, and executable PTY-helper verification with the same renderer
hash. The graceful local installer installed the arm64 build and reopened
`/Applications/Wanigan.app` as PID 67773. The installed archive matches the
verified package; hashes are in [build verification](build-verification.json).

Native inspection confirmed the new directory, Overview, scope control,
knowledge list, selected Text/Evidence/History reader, and recorded citations.
Only navigation and reading were exercised against production records. The app
was left open on Learning's Overview. Skills is the next Knowledge page.
