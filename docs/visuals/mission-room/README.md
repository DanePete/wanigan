# Mission room evidence

- [Approved concept B](concept/approved-b.png) is the visual reference, not an application screenshot.
- [Before screenshots](../personality/before/) show the original affected views in both themes.
- [Real application captures](real/) use the production main process, typed preload and renderer with isolated user data. The project and review records are test seeds; no coding-agent session was launched.
- [Populated layout captures](after/) use the production renderer in Electron with explicitly synthetic bridge data. They verify layout and project scoping, not observed agent activity.
- [Water and mist recording](physics/live-fluid.webm) and [flame, gaze and spin recording](physics/live-flame.webm) come from the live WebGPU canvas. Neither uses generated video or prerecorded fluid animation.
- [Physics measurements](physics/verification.json) identify the exact renderer hash, numerical results and isolated GPU-completion timings. These are one-device measurements, not whole-app or cross-hardware frame-rate guarantees.

## What is live

The globe contains 8,144 PBF water particles, a 64³ gas field, transported fuel,
heat and soot, 32 buoyant bubbles and up to 32 cooling embers. Flame emission and
water/glass refraction share the ray tracer. A small HDR camera pass adds bloom
from actual rendered radiance before tone mapping.

Gaze selects targets from the conversation and overview. Fixation, fast eye
shifts, subtle corrective saccades, asymmetric blinking and slower globe turns
form a coordinated expression. Double-click the globe or use **Give him a spin**;
the rotating vessel transfers tangential momentum into the water and gas while
gravity stays in world coordinates. **Water & mist** and **Ember & flame** are
local, persistent appearance choices. They make no model request.

The native visibility bridge stops new GPU submissions on hide/minimize. A frame
already submitted may finish afterward. Motion off freezes eye pose, orientation,
liquid, fuel, heat and embers together. The real-app harness checks hide/show,
composer attention, spin, local appearance persistence and layout bounds.

The full-app harness now connects the debugger before loading the production
main module. This test-only bootstrap avoids the observed Electron 44 debugging
handshake hang; it does not change production startup. All captures and tests
use temporary profiles. The installed app is not replaced or restarted, and no
paid model request is made by the probes.

## Verified run

All five `npm test` stages passed, with **1,498 smoke assertions and no failures**.
The CPU expression probe passed. The final GPU artifact was recorded at
`2026-09-10T08:36:13.198Z` and matches the current runtime hash.
Water measured 12.0 ms median / 13.3 ms p95; fire measured
14.6 ms median / 15.7 ms p95, including GPU completion
at a 900-device-pixel canvas on the M2 Pro. No invalid particles, thermal values
or GPU errors were reported. Source-off heat fell below 0.01% of the supplied
flame's measured total, embers cooled, and the completed spin left the water
contained (maximum particle radius 0.9525, limit 0.973).

## Reproduce

Use Node 22.23.2 (`nvm use`) and then:

```sh
npm test
node scripts/probe-orb-expression.mjs
node scripts/probe-orb.mjs
node scripts/shots.mjs --out docs/visuals/mission-room/real --light
node scripts/probe-mission-room.mjs
node scripts/preview-mission-room.mjs
```

The preview command opens a separate temporary profile, registers this actual
repository, and starts no agent or model request. Closing it preserves that
profile; it never replaces or restarts the installed app.

The GPU probes require a supported physical GPU and Electron; ordinary headless
Chromium did not expose an adapter on this machine. The CPU expression probe
checks frame-rate agreement, fixation, intent priority, blinking, bounded
engagement, pause behavior and one complete spin.

## Practical limits

The flame is supplied and incompressible, with normalized excess temperature.
There is no oxygen depletion, combustion expansion, boiling or two-way thermal
feedback into the water. Wall friction, water illumination, the thermal palette
and camera bloom are bounded approximations. Liquid reconstruction is isotropic;
the gas grid and liquid surface still limit fine detail. The live renderer does
not yet reproduce the photographic material quality of the approved concept.

See [gaze and spin research](../../research/2026-09-10-orb-gaze-and-spin.md),
[fire physics](../../research/2026-09-10-orb-fire-physics.md) and the
[overall personality direction](../../research/2026-09-10-orb-personality-direction.md).
