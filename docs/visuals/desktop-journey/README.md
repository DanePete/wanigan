# Desktop journey polish — September 11, 2026

This pass connects the approved desktop redesign through planning, agent work,
attention, review, and acceptance. The established silver/charcoal frame, shared
controls, and detailed GPU character remain in place.

The session header now has a compact return trail to the exact recorded goal and
task. Its typed read resolves ownership from SQLite, checks the renderer's ID,
and returns no link for missing or ambiguous ownership. Navigation carries both
IDs through the goal fragment. It does not infer ownership from a project name,
scan a truncated goal list, or start work.

A contextual companion beside the goal brief points to the next recorded step:
a failed task, a human review, a running session, queued work, or a ready task.
These links navigate to the relevant controls; starting a task and recording a
decision remain explicit actions. A small nudge gets a brief mischievous response.

Acceptance has a finish state with the recorded decision note, retained evidence,
and a route into the next planning conversation. Wanigan reacts once to newly
observed acceptance. Initial history reads, failed decisions, refreshes, and a
recovered data connection do not replay the celebration. Motion Off and the OS
reduced-motion preference remain authoritative.

The companion's attention list identifies the session, project, actual reported
request, and the action its link opens. A finished turn gets its own reaction even
while another session still needs permission. The terminal attention strip keeps
unreported attention distinct from no live sessions and discards stale reads.

## Visual evidence

All records and terminal text in these captures are deliberately authored test
fixtures. No provider was launched, no paid request was sent, and no user's
repository was changed by the renderer probes. Before captures load the previous
staged desktop-redesign app archive; after captures use this pass.

| Step | Before dark / light | After dark / light |
| --- | --- | --- |
| Planning | [Dark](before/planning-dark.png) · [Light](before/planning-light.png) | [Dark](after/planning-dark.png) · [Light](after/planning-light.png) |
| Saved plan | [Dark](before/saved-dark.png) · [Light](before/saved-light.png) | [Dark](after/saved-dark.png) · [Light](after/saved-light.png) |
| Ready task | [Dark](before/ready-dark.png) · [Light](before/ready-light.png) | [Dark](after/ready-dark.png) · [Light](after/ready-light.png) |
| Session | [Dark](before/session-dark.png) · [Light](before/session-light.png) | [Dark](after/session-dark.png) · [Light](after/session-light.png) |
| Attention | [Dark](before/attention-dark.png) · [Light](before/attention-light.png) | [Dark](after/attention-dark.png) · [Light](after/attention-light.png) |
| Review | [Dark](before/review-dark.png) · [Light](before/review-light.png) | [Dark](after/review-dark.png) · [Light](after/review-light.png) |
| Acceptance | [Dark](before/accepted-dark.png) · [Light](before/accepted-light.png) | [Dark](after/accepted-dark.png) · [Light](after/accepted-light.png) |

Additional captures cover blocked work, unavailable reads, and long names at
1080, 1280, and 1720 pixels. The journey probe exercises failed approval, exact
session return, late lookup responses after switching sessions, read recovery,
keyboard focus, and a fresh plan after acceptance. Its delayed-response check
also caught duplicate sibling React keys; the session trail now owns a distinct key.

## Verification and staged builds

`npm test` passed all six required steps, including **24 shared tests** and
**1,580 offline smoke assertions**. Renderer style, native packaging hooks,
local-installer fixtures, and typechecking passed. `git diff --check` is clean.
See [test output](npm-test.log) and the [verification record](verification.json).

All **17 broader probes** passed: the fourteen desktop workspace probes, terminal
replay, companion signature interactions, and companion GPU physics. The final
packaged renderer then passed the complete journey and focused review probes.
See [broader results](regression/verification.json), [packaged journey output](packaged-probe.log),
and [final review output](regression/final-packaged-review.log). There were no
renderer errors in the journey. Visual evidence includes 14 before screenshots
and 24 after screenshots across both themes.

Apple silicon and Intel apps are staged at:

- `release/desktop-journey/mac-arm64/Wanigan.app`
- `release/desktop-journey/mac/Wanigan.app`

Both passed strict signature verification, archive integrity checks, hardened
Electron fuse checks, and architecture checks for the application, PTY helper,
PTY addon, and SQLite binding. The renderer, main process, preload, and physics
bundles match across architectures and match the isolated source snapshot.
The [source manifest](source-manifest.json) records 372 matching source/config
files. [Build verification](build-verification.json) records the bundle hashes.
The [packaging log](package.log) includes restoration of the host native modules.
These are local ad hoc signed builds, not notarized distribution releases.

The GPU physics runtime is byte-for-byte unchanged from the previous staged app:
`489b4a8c1bab47627a784510ea3360b4906ad0504d176085429b3891dced357b`.

Installation was deliberately left pending: the installed Wanigan still owns a
live Claude process. Quitting it would end that process. The saved application
was neither replaced nor restarted during this pass. When that session can end,
the existing installer can apply the Apple silicon build:

```sh
npm run install:mac:arm64 -- --source release/desktop-journey/mac-arm64/Wanigan.app
```

