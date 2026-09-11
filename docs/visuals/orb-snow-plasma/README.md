# Dry snow and the plasma globe

This revision responds to the request for a dry snow globe that fills in roughly
1–2 minutes and a substantially more convincing plasma globe. The primary-source
investigation and its implementation limits are in the [plasma research report](../../research/2026-09-10-plasma-globe-physics.md).

Snow now falls into a granular bed, with no water drag, liquid surface, bubbles,
rain, dew or inherited flame. Flakes slide down steep bare glass; deposited
powder forms slopes and drifts. The target volume is supplied in about 90 seconds
of active animation. Snowfall stops at capacity. Shaking withdraws powder from
the bed, throws it into the air and lets it settle again, preserving mass.
The pile survives navigation between the mission room and miniature companion.
The small companion keeps the same fill timing at its lower rendering frequency.
Motion Off and hidden windows pause it. An application restart resets this
renderer-local decorative state.

Plasma now has a finite electrode, eight primary paths and four connected
branches. Persistent channels drift, renew independently and retain effective
memory. A camera ray locates the pointer on the curved inner glass; nearby paths
compete for excitation, concentrating it into a bright contact channel. Release
restores a distributed pattern. The same geometry drives both companion sizes.
The shader uses a continuous per-path light envelope, narrow blue-violet shafts,
warm contact regions, and depth occlusion at the electrode and eyes.

These are bounded reduced physical models, not calibrated MPM snow, electrical
charge transport, or plasma chemistry. The small state solvers run at fixed
60 Hz steps on the CPU; WebGPU renders their evolving geometry through the
existing glass. No recorded animation or model calls drive these effects.

## Visual evidence

Before captures were copied from the preceding verified installed build, with
its runtime digest recorded in [provenance](before/provenance.json). All after
captures use real Electron and WebGPU in isolated profiles. Full UI captures
contain explicitly synthetic project/session fixtures, never private app data.

| View | Dark before | Dark after | Light before | Light after |
| --- | --- | --- | --- | --- |
| Snow | [Before](before/snow-detail-dark.png) | [30 seconds](after/snow-30s-dark.png) | [Before](before/snow-detail-light.png) | [90 seconds](after/snow-90s-light.png) |
| Plasma | [Before](before/plasma-detail-dark.png) | [Idle](after/plasma-idle-dark.png) | [Before](before/plasma-detail-light.png) | [Contact](after/plasma-light.png) |
| Desktop snow | [Before](before/snow-dark.png) | [After](ui/material-7-dark.png) | [Before](before/snow-light.png) | [After](ui/material-7-light.png) |
| Desktop plasma | [Before](before/plasma-dark.png) | [After](ui/material-8-dark.png) | [Before](before/plasma-light.png) | [After](ui/material-8-light.png) |
| Miniature snow | [Before](before/mini-7-dark.png) | [After](ui/mini-7-dark.png) | [Before](before/mini-7-light.png) | [After](ui/mini-7-light.png) |
| Miniature plasma | [Before](before/mini-8-dark.png) | [After](ui/mini-8-dark.png) | [Before](before/mini-8-light.png) | [After](ui/mini-8-light.png) |

Recordings: [snow shaking and settling](after/snow.webm), [moving plasma contact](after/plasma.webm).
The 30/60/90-second stills advance the actual production solver to those times;
they are checkpoints, not a claim that the test waited 90 wall-clock seconds.

## Verification

The required `npm test` completed with **1,509 assertions passing, zero failing**.
The [deterministic solver report](after/physics.json) checks supply, deposition,
capacity, shake/redeposition, mass balance, contact location, power concentration,
release, independent renewal, electrode roots, containment under rapid input,
and equal trajectories at different rendering cadences.

The [GPU report](after/verification.json) records both materials, captured runtime
digest and measured render time including queue completion. Its counterfactual
moves the real water simulation while holding the snow and camera fixed; the
snow pixels remain identical. The [other-material report](regression/verification.json)
covers the eight preserved materials. The [UI report](ui/ui-verification.json)
covers all ten choices, both sizes, snow retention, miniature timing, pointer
capture, Motion Off, session-event boundaries and no automatic model requests.

The [native-window check](real/verification.json) passed in a fresh profile with
the real main process and preload: hiding stopped GPU submissions, showing
resumed them, Motion Off froze rendering, and no sessions or conversations were
created. The miniature rendered at approximately 17 frames per second.

At 90 simulation seconds the bed contains about 98% of its target volume; by
120 seconds it is full. Mass error after filling is below 0.000001 volume units.
The full-bed shake lifts about 12% of the powder, which subsequently settles.
The GPU harness measured approximately 15 ms median for plasma at 900 × 900,
including queue completion. These are local measurements, not device-independent
performance guarantees or laboratory calibration.

Installing is a separate step: a full Wanigan quit ends live PTYs. The verified
desktop package is recorded in [package verification](package-verification.json).
After explicit user approval, the arm64 package was installed into
`/Applications/Wanigan.app` and relaunched. Its installed archive matches the
verified package, the installed signature and integrity checks pass, and the
actual Mission room window reopened. The user will reopen their agent session.

```sh
source "$HOME/.nvm/nvm.sh" && nvm use
npm test
npm run build
node scripts/probe-orb-snow-plasma-physics.mjs docs/visuals/orb-snow-plasma/after
node scripts/probe-orb-materials.mjs docs/visuals/orb-snow-plasma/after --only=snow,plasma --record
node scripts/probe-orb-materials.mjs docs/visuals/orb-snow-plasma/regression --only=water,fire,lava,ferro,ink,jelly,honey,pearls
node scripts/probe-orb-materials-ui.mjs --output=docs/visuals/orb-snow-plasma/ui
node scripts/probe-companion-presence-real.mjs docs/visuals/orb-snow-plasma/real
node scripts/probe-orb-expression.mjs
git diff --check
```
