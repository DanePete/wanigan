# helper sweep · P1 · approvals and the policy gate

Before and after shots of every surface this package changed, in both themes,
from `scripts/probe-helper-p1-policy.mjs`.

- `before/` — the base commit `36c2daf` (feat/helper-sweep when this branch was
  cut), built in a scratch worktree and shot with `--before`.
- `after/` — this branch.

Both runs use the real renderer in an isolated Electron window with every
service stubbed, and the phone page bundled from `src/main/mobile/page.ts` with
a fixture `/api/status`. They prove layout, both palettes and that each new
element rendered without horizontal clipping; they prove nothing about the main
process, which `src/main/smoke30.ts` covers. `after/verification.json` lists the
seven assertions that passed and every file written.

| Shot | What changed |
| --- | --- |
| `fleet-inspector` | A session waiting on approval shows what `npm run analyze` runs, the paths and hosts it names, whether it is reversible, and that the script changed since launch. The element capture starts mid-inspector because the inspector scrolls. |
| `settings-trust-panels` | The unattended-runs grant switch with its rule, and the gate self-test line. |
| `settings-trust-counts` | Observed approval counts for the last day, every duration marked inferred, and a recorded fast run. |
| `settings-ledger` | A ledger row's per-command trace, opened: which command in the line fired `bash.sudo`, through `env › bash -c › sudo`. |
| `settings-egress` | Exposure leads, each labelled "lead, not proof", at the end of the egress report. |
| `context-settings` | The `autoMode` block Wanigan writes into `--settings`, read-only, `"$defaults"` first. |
| `skills-reader` | A skill's capability surface grew since approval: the delta, a critical finding, and "Approve this surface". |
| `timeline` | A session's policy evidence on its timeline: an exposure lead, a pinned history rewrite, the rewriting command and a tripwire. |
| `phone-card` | The phone's session card for a waiting approval, with the same explanation, bounded. |

All fixture data is generic (`/example/…`, `*.example.net`).
