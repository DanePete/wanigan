# Helper sweep · P4 — cost, quota and context

Screenshots of every view this package changed, in both palettes, taken by
`scripts/probe-helper-p4-cost.mjs` against the built renderer in plain Chromium
with the preload bridge stubbed (`scripts/renderer-harness.mjs`). Every
`cost.*` channel is answered by a fixture typed after
`src/shared/cost-types.ts`, so these prove layout, wording and both themes —
not IPC, SQLite or the CLIs, which `smoke33.ts` covers.

- `before/` — the base commit (`feat/helper-sweep` at 36c2daf), built in a
  scratch worktree and photographed at the same navigation state with
  `--before`. The probe asserts each new element is absent there.
- `after/` — this branch. The probe asserts each new element rendered, has no
  clipped headings or values, and shows no `NaN`/`undefined`/`[object Object]`;
  `verification.json` records every check (63 after, 25 before, 0 failed).

| View | before | after |
|---|---|---|
| Insights › Spending | `insights-where-the-money-went`, `insights-codex-credits` (the report without them) | Where the money went (+ `insights-yield-drill-through`), Codex plan sessions in credits |
| Insights › Tokens & pace | `insights-cost-by-cause` | Cost by cause |
| Context › Instructions | `context-instructions` | `context-instructions-stale-references` |
| Context › Codex loader | `context-agents-md` (the only Codex surface before) | `context-codex-loader`, `context-codex-skills` |
| Context › Subagents | `context-settings` (agents listed without the mark) | `context-subagents` |
| Skills | `skills-sources` | `skills-listing-cost`, `skills-manual-only-confirm` |
| Schedules detail | `schedules-detail` | `schedules-admission-and-memory`, `schedules-previous-runs-section` |
| Usage | `usage-window-share` | `usage-window-share` |
| Learning › Inbox | `learning-inbox-codex-budget` | `learning-inbox-codex-budget` |
| Sessions composer | `sessions-composer` | `sessions-composer` (cold-cache note) |
| Sessions › Timeline | `sessions-timeline` | `sessions-timeline-anatomy` |

Reproduce: `npm run build && node scripts/probe-helper-p4-cost.mjs`. For
`before/`, copy the probe into a checkout of the base commit, build there, and
run it with `--before --out <this folder>/before`.

Known stub artifacts, not product findings: Context's "Reported by a session"
block reads "last report NaNd ago" because `context.observed` has no fixture in
the shared harness; the Skills header counts "0 Claude Code skills" for the same
reason.
