# Companion across the desktop

The small Wanigan lives beside the bottom navigation on the 16 destinations
outside Mission room. Mission room keeps its large character. The small scene
stays mounted when moving between work views; changing views does not restart it.

Both sizes use the same WebGPU renderer, particle solver, gas and thermal fields,
glass optics, studio lighting, eyes, and expression controller. There is no
alternate low-detail model. The small version retains the Water/Ember choice
made in Mission room. Its idle rendering is capped at 18 frames per second,
and it renders at 200 pixels for a 64 CSS-pixel footprint. Hidden windows pause
GPU submissions; Motion Off freezes the scene while still updating status color.

## Signals and actions

| Observed state | Appearance | Meaning |
| --- | --- | --- |
| Permission request | Amber | A session is waiting for a permission decision. |
| Error | Coral | A session needs a look. |
| Finished | Mint | A turn finished, or a session ended; the label distinguishes them. |
| Working | Cool blue | Main reports a working attention signal. |
| Quiet | Original appearance | No urgent or working attention signal is present. |
| Failed read | Muted | Status is unavailable; an unsuccessful poll is not an empty fleet. |

Permission takes priority over errors and finished turns, matching the existing
attention queue. Colors are accompanied by a visible label at wide sizes and
an accessible name and tooltip at every size. Signals cover all project spaces.
Clicking a waiting state opens the existing session list above the character;
its rows open the real sessions. Clicking a quiet state opens Mission room.
No model call, agent launch, or permission approval occurs from a status change.

## Compare

| View | Dark before | Dark after | Light before | Light after |
| --- | --- | --- | --- | --- |
| Sessions | [Before](before/dark/sessions.png) | [After](after/dark/sessions.png) | [Before](before/light/sessions.png) | [After](after/light/sessions.png) |
| Fleet | [Before](before/dark/fleet.png) | [After](after/dark/fleet.png) | [Before](before/light/fleet.png) | [After](after/light/fleet.png) |
| Review | [Before](before/dark/control.png) | [After](after/dark/control.png) | [Before](before/light/control.png) | [After](after/light/control.png) |
| Settings | [Before](before/dark/settings.png) | [After](after/dark/settings.png) | [Before](before/light/settings.png) | [After](after/light/settings.png) |

Actual small renders: [permission](after/dark/permission.png),
[error](after/dark/error.png), [finished](after/dark/finished.png),
[working](after/dark/working.png), [quiet](after/dark/quiet.png).
The [attention dialog](after/dark/attention-open.png) opens above the footer.
Compact checks cover [960 pixels](after/compact-960.png) and
[720 pixels](after/compact-720.png).

## Evidence

The comparison screenshots use real Electron and GPU rendering with explicitly
synthetic bridge records. They do not depict the operator's live sessions.
[Fixture results](after/verification.json) cover status transitions, labels,
dialog bounds and focus return, canvas persistence across all other destinations,
Motion Off, and no companion model calls.

A separate [real main/preload run](real/verification.json) uses an empty temporary
profile and checks native hide/show, GPU pause/resume, Motion Off, quiet status
from IPC, and navigation back to Mission room. Its test bootstrap attaches the
debugger before loading main; this is not a production startup-handshake test.
That run measured 34 frames over 2.006 seconds, about 16.95 fps. It created no
sessions or companion turns. [Dark](real/fleet-dark.png) and
[light](real/fleet-light.png) show its actual empty Fleet state.

`npm test` passed all five required stages, including 1,509 smoke checks.
The added smoke checks cover status priority, missing and duplicate sessions,
read failures, process exit versus turn completion, and distinct transition ids.

With Node 22.23.2:

```sh
npm test
node scripts/probe-companion-presence.mjs
node scripts/probe-companion-presence-real.mjs
git diff --check
```

The probes close only their own temporary applications. They do not replace or
restart `/Applications/Wanigan.app`. The iPad/iPhone interface is unchanged.
