# Helper sweep · P11 · dependencies, finished

Before and after, both themes, from `scripts/probe-helper-p11-deps.mjs`: the
built renderer in Chromium with the preload bridge stubbed
(`scripts/renderer-harness.mjs`). The advisory report on screen is not typed by
hand; the probe builds it with `assembleAdvisoryReport` from
`src/shared/dependency-advisories.ts`, the function main uses. These shots prove
layout, wording and both palettes. The main-process half — attribution against a
real repository's checkpoints, and the lookup against a loopback stand-in for
OSV, npm and PyPI — is checked by `src/main/smoke40.ts`.

`before/` was shot from a build of `feat/helper-sweep` (e77cf97) in a scratch
worktree, with this branch's probe and renderer harness copied in so both sides
use the same stub. `after/` is from this branch. Each folder's
`verification.json` lists the assertions that ran, the commit the renderer was
built from, and the body background of each screenshot.

| View | Before | After |
| --- | --- | --- |
| Code rail › Dependencies | `code-rail-dependencies` — the changes, the session's install commands, and "No registry or advisory lookup was made." | `code-rail-dependencies` — each change says where it came from: "before the first checkpoint", "turn 2 ↗" with the install command that ran in that turn, "outside the recorded turns" with where, and an upgrade touched in two turns naming both; then Advisories with its Check advisories button |
| Code rail › Advisories | — | `code-rail-advisories` — after a check: the requests it sent per host; the malware advisory first, its MAL- id before its GHSA id; a version published 30 h ago flagged "new, review"; "none listed" worded as not a finding of safety; a rate-limited lookup as unknown with its reason; a cached answer with its age; a Cargo requirement not looked up and why |
| Code rail › coverage | — | `code-rail-advisory-coverage` — coverage per ecosystem for advisories and for publish times: covered, error with the reason, not covered |
| Code rail › lookups off | — | `advisories-off` — no button, only where to turn lookups on |
| Turns | `turn-jump` — Turn 2 selected by hand | `turn-jump` — the same view reached by pressing "turn 2 ↗" on p-retry |
| Settings › Privacy & data | `settings-observation` — the provider status switch, the row above where the new one sits | `settings-observation` — "Dependency advisory lookups", off, naming api.osv.dev, registry.npmjs.org and pypi.org and exactly what is sent |

Run it again with `npm run build && node scripts/probe-helper-p11-deps.mjs`
(add `--before --out <dir>` from a checkout of the base).
