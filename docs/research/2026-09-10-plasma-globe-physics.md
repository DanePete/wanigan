# Plasma globe: physical references and a renderer plan

Researched September 10, 2026, for Wanigan's desktop companion. This note separates measured behavior, proposed numerical approximations, and visual design choices. It is not evidence that any proposed implementation has shipped or achieved a performance target. Product source was inspected read-only.

The recommended replacement is an **exposure-averaged network of persistent, competing discharge channels**. A finite central electrode, moving attachment points, channel renewal, and concentrated shell contact should determine its appearance. Increasing the existing sine-wave amplitude would preserve the fundamental problem: eight permanent luminous strings.

## What the physical references establish

### Globes are not interchangeable with air lightning

A globe places an ionizable gas inside dielectric glass, with an AC-driven internal electrode region and capacitive coupling to the exterior. Parker's original device disclosure explicitly includes chamber geometry, gas pressure/composition, dielectric properties, and waveform as design variables. The outer glass is therefore part of the electrical system, not just a transparent collision boundary. [Parker, US4754199A, published June 28, 1988](https://patents.google.com/patent/US4754199A/en)

“Low pressure” is not universal. An experimental conference report describes commercial neon/xenon globes near **740 Torr**, powered around **25 kHz** at **5–10 kV**; voltage mainly changed filament population, while frequency changed morphology. Do not choose gas constants from a low-pressure discharge tutorial and present them as measured properties of every commercial globe. [Simmons et al., APS DPP, 2013](https://meetings-archive.aps.org/dpp/2013/jp8/28/)

For comparison, streamers are advancing ionization fronts whose tips enhance the electric field. They can precede sparks and lightning, but are not equivalent to the later hot discharge. Their electric field, charge density, light emission, and electron density are different quantities. This distinction matters visually: a luminous channel is neither a glowing parcel of heavy liquid nor a trail of slow macroscopic electrons. [Nijdam, Teunissen, and Ebert, published October 28, 2020](https://doi.org/10.1088/1361-6595/abaa05)

### Motion and repeated paths

Campanell's measured globe produced microsecond outward discharges at roughly **10 km/s**, repeating around **26 kHz**, while the visible channel pattern drifted upward at approximately **1 cm/s**. Channels persisted across many pulses, lived for seconds, branched, and sometimes migrated by exchanging branches. Roots could move on the central bulb and emerged approximately normally to it. The authors observed blue shafts and red outer tips. They attributed upward motion provisionally to convection; the microscopic origin of path memory remained unresolved. Their short-exposure measurements also distinguish instantaneous head brightness from accumulated camera brightness. [Campanell et al., Physics of Plasmas, May 2010, author manuscript](https://www.stewartzweben.com/Papers/coauthorpapers/CampanellPoP10.pdf)

The implementation implication is temporal separation: show slow evolution of a repeatedly excited path; average rapid electrical cycles into radiance. Rendering every physical pulse as a visible traveling dot, or sampling a 25 kHz sine once per frame, would create an aliasing artifact. A deliberate slow-motion diagnostic would be a different mode.

### Surface charge, conductivity, and contact

Burin's 2015 experiment measured **720 ± 20 Torr** in its commercial globe. It treats the device as a spherical dielectric-barrier discharge, observes surface rings after channels reach the glass, and discusses a variable plasma resistance within a capacitive circuit. The authors identify residual electrons, reduced neutral density, and metastable populations as possible contributors to channel persistence. They explicitly regard magnetic self-forces as unimportant at the low currents involved. These are reasons to prioritize electrical/thermal memory and the glass boundary over an MHD or magnetic-pinch explanation. The paper reports blue xenon-associated stems and red neon-associated outer regions; surface rings are fast physical events, not seconds-long ripples. [Burin et al., published online May 22, 2015; author-uploaded full text](https://www.researchgate.net/publication/277948519_On_filament_structure_and_propagation_within_a_commercial_plasma_globe), [institutional publication record](https://collaborate.princeton.edu/en/publications/on-filament-structure-and-propagation-within-a-commercial-plasma-/)

An independent experimental teaching method uses a globe to energize discharge tubes. It identifies concentration of streamers at a touching finger as capacitive coupling through the glass; increasing conductive coverage increases coupling. A pointer interaction should therefore change how the network shares excitation, rather than mechanically pull two predetermined strings. [Journal of Chemical Education, 2012, DOI 10.1021/ed200341q](https://pubs.acs.org/doi/10.1021/ed200341q)

Memory is not always simple attraction. Double-pulse experiments in nitrogen/oxygen mixtures and argon found continuation, avoidance, and eventual independence of earlier channels depending on gas and delay. Those experiments are not a calibrated neon-globe model, but they directly caution against claiming that every residual-ionization field necessarily attracts every later discharge. [Nijdam et al., 2013 preprint / 2014 publication](https://arxiv.org/abs/1310.4307)

## Why the current implementation reads as ropes

At inspection, [plasma.ts](../../src/renderer/src/orb/plasma.ts) allocates 128 nodes: eight chains of sixteen. Every chain lasts indefinitely. Its tip follows a predetermined spherical distribution, its interior follows trigonometric offsets, and each node independently springs toward that prescribed goal. Only chains zero and one approach the pointer. There are no neighbor constraints, actual branch relationships, conductance, finite electrode surface, channel lifecycle, or interaction between competing channels.

The [optics shader](../../src/renderer/src/orb/optics.ts) adds Gaussian light around each straight segment with essentially identical intensity and width. It has a point-like central glow but no substantial electrode. A renderer that evaluates independent segment kernels also changes accumulated brightness when tessellation changes unless emission is normalized. More segments alone can brighten joints without improving the mechanism.

These are local observations, not criticisms inferred from the papers. They suggest a replacement seam: keep a stable GPU buffer consumed by optics, but make its records represent a channel network with meaningful state. Preserve the existing dry-chamber selection, eye occlusion, shared glass, fixed simulation clock, and motion-off contract.

## Choosing a computational model

| Approach | What it would model | Fit for this app |
| --- | --- | --- |
| Full kinetic or plasma-fluid solver | Species densities, transport, reactions, space charge, electrode/dielectric conditions, and potentially neutral-gas heating | Appropriate research reference; substantially more work than an animated companion, with difficult calibration and spatial/time resolution requirements. |
| Coarse potential plus stochastic growth | Electric potential around conductive paths; probabilistic extension and screening; separately approximated memory and circuit loading | Useful next level if field-driven branching is essential, but a coarse grid cannot be advertised as a converged plasma simulation. |
| Persistent reduced channel network | Channel shape, lifetime, memory, effective conductance, shell attachment, bounded convection, and power redistribution | Recommended immediate architecture: controllable, inspectable, and compatible with a small WebGPU workload. |
| Existing independent spring goals | Smooth interpolation to prescribed curves | Useful only for cosmetic easing; does not provide the missing electrical behavior. |

Afivo-streamer's published fluid method combines drift, diffusion, reaction, and a Poisson field solve with adaptive refinement. Its 2017 examples used up to **100 million cells**; the authors explain why thin charge layers and small time steps make naive coarse approximation unreliable. This is evidence of multiscale difficulty, not a benchmark prediction for Wanigan's hardware. [Teunissen and Ebert, published October 30, 2017](https://homepages.cwi.nl/~ebert/2017-JPD-Jannis-afivo-streamer.pdf)

For a possible reduced field method, solve `div(epsilon * grad(phi)) = -rho` and use `E = -grad(phi)`; do not confuse potential with light. A minimal plasma-fluid system evolves electron density through drift/diffusion plus ionization and evolves positive ions through the corresponding source. Additional gas chemistry and dielectric charge are needed for a globe. Teunissen's thesis gives a concrete simple model, including these coupled equations. [Teunissen, dissertation, 2015, section 10.7](https://teunissen.net/files/phd_thesis/phd_thesis_teunissen_29_09_2015_small.pdf)

The dielectric-breakdown graphics model offers a less expensive geometric route: solve a Laplacian field, grow a connected structure probabilistically, and update the field as it grows. Kim and Lin include animation and a convolution-based luminous renderer. Their method targets lightning; it does not supply globe chemistry, AC memory, or touch-circuit behavior automatically. [Kim and Lin, March/April 2007, author paper](https://www.tkim.graphics/FAST_LIGHTNING/lightning_tvcg_2007.pdf), [author project and source](https://gamma-web.iacs.umd.edu/FAST_LIGHTNING/index.html)

## Recommended bounded WebGPU design

The following numbers and equations are **engineering proposals**, not measured material constants. Start with a reproducible reduced model and compare recordings before adding a full spatial field.

### 1. Channel state and geometry

Use approximately twelve channel slots, twenty-four to thirty-two stations per primary path, and a small separate budget of secondary branch slots. Store persistent position, tangent or velocity, conductance, memory, age, and random seed. Give every branch an explicit parent station. Do not draw adjacent buffer records as connected unless their topology says they are.

Use a finite central bulb of approximately `0.16` orb radius. Its roots live on that surface, not at one common point. Constrain the first few stations to depart along the local normal, with increasing lateral freedom farther outward. Endpoints attach to the inner glass surface. A branch can join a primary path or attach separately, but it must not float disconnected in the chamber.

Sample shape changes at fixed simulation steps. Maintain low-dimensional, correlated random forcing with a deterministic seeded generator. For example, an Ornstein–Uhlenbeck disturbance has exponentially decaying persistence and fresh bounded increments; unlike a handful of fixed sine functions, it does not repeat one identical wave choreography. Clamp accelerations, displacement, and curvature. Noise perturbs physical controls; it does not overwrite the entire path each frame.

### 2. Convection, memory, and renewal

Project an upward drift onto shell endpoint tangents: `upTangent = up - n * dot(up,n)`. Let interior stations receive a weaker smooth updraft plus bounded handling-induced circulation. Roots may slide gradually on the central bulb. Avoid applying an unconditional global spin to all endpoints: that makes a rotating wheel.

Maintain a memory scalar `h` per channel, reinforced by excitation and decayed when inactive. A simple bounded update is `dh/dt = a * power - b * h`. Interpret it as an effective preference for a previous path, not a measured electron density or temperature. A fully spatial memory texture can come later if paths need to influence other channels.

Renew the weakest or most distorted channels individually. Give birth and survival separate thresholds; a established channel should survive slightly weaker excitation than a new one requires. Fade its old geometry through a short overlap while a new route appears elsewhere, without morphing a whole path through the center of the sphere. A small number of explicit branch exchanges can provide meaningful topology changes. Use different lifetimes so no visible reset cycle synchronizes the globe.

### 3. Touch must redistribute activity

Raycast the actual pointer through the same camera mapping used by optics. Intersect the visible front glass; a constant fabricated `z = 0.6` target does not reliably match the place being touched. Reject points outside the globe disk. Account for companion rotation when expressing the target in simulation coordinates.

Give every channel a touch score based on geodesic distance between its shell endpoint and a finite contact patch. Include effective conductance and path length in the score. Allocate a bounded total current or power budget across all active channels, for example:

```text
weight_i = conductance_i * contactGain_i / max(length_i, epsilon)
share_i  = weight_i / sum(weight)
power_i  = boundedTotalPower * share_i
```

Let total excitation increase modestly with touch rather than assert exact constant-power conservation. This is a circuit-inspired resource allocation model, not a solved impedance network. One or a few nearby channels should become dominant, while distant ones visibly weaken. Sustained contact should remain energetic without becoming a white solid cone.

On fast pointer moves, allow a nearby competing channel to take over; do not require one rope to stretch around the entire globe. On release, decay the contact preference and restore a distributed population with brief hysteresis. Keep event-driven personality changes bounded: a completion may briefly raise excitation, while attention could bias activity toward a small patch. Never derive these events from invented agent state.

### 4. Radiance and the glass contact

Render continuous splines or sufficiently tessellated curve ribbons. Keep a narrow bright blue-white center within a softer violet envelope, with a warmer, somewhat wider terminal region. These are visual approximations to an exposure-integrated discharge, not a calibrated spectral renderer. Add a visible central electrode with a luminous sheath, so the channels have a readable origin and a meaningful depth anchor.

Normalize emission by arc length. Curves with twice as many segments must not acquire twice the radiance. Separate luminous width from the antialiasing footprint: at miniature size, preserve integrated energy with an appropriate minimum screen footprint rather than thickening every filament into a tube. Limit broad bloom so the spaces between paths remain dark.

A contact footprint belongs on the curved inner shell. Use the endpoint normal to orient a small elliptical halo or corona patch, including perspective foreshortening near the rim. A gentle apparent spreading footprint can communicate contact, but its slowed envelope is artistic; the measured surface discharge expands far faster than a UI frame. Do not turn this into a liquid ripple or show it detached from the glass.

Respect depth: rear filaments can be hidden by the electrode and eyes; front filaments should not all disappear behind a single flat mask. Keep glass refraction consistent. Rasterized emission can be much cheaper than testing every segment at every pixel, but screen-space compositing then needs depth/refraction handling. An alternative is per-tile segment lists with analytic ray integration. Profile either approach before raising the channel budget.

## Acceptance evidence

These are proposed checks, not current results:

1. **Temporal identity:** a ten-second recording shows recognizable channels drifting and renewing individually, with actual branch changes; it does not loop a synchronized sinusoidal pose or remain a fixed eight-spoke wheel.
2. **Touch causality:** identical seeded runs with and without touch differ in channel power allocation and endpoint distribution. Test center, edge, quick drag, hold, leave, blur, and miniature companion. The dominant contact must align with the pointer on the rendered glass.
3. **Release and memory:** after touch ends, concentration decreases and several separated endpoints recover. Path memory persists briefly without permanently locking the first selected channel.
4. **Topology and bounds:** every live branch has a valid parent; roots stay on the bulb, endpoints on the inner shell, all stations finite and inside the globe. Repeated large input impulses cannot produce unbounded conductance or invalid radiance.
5. **Optical quality:** compare tessellation counts at a fixed pose and exposure. Look for joint hotspots, polygon corners, blown-out center, disappearing miniature lines, detached shell pads, and light leaking through eyes. Inspect dark and light themes.
6. **Time and lifecycle:** compare equal elapsed simulation time at 30/60/120 Hz; motion off freezes shapes, lifetime, noise seed, contact state, and light envelope. Hidden windows stop work; rapid switching/disposal does not retain stale GPU bindings.
7. **Performance:** record GPU time at fixed resolution for the large and tiny companion separately and together. Keep readback in diagnostic probes. Set a budget after measuring the existing renderer, not from an untested estimate.

## References for visual comparison and limitations

Use the author-uploaded figures in the [2015 globe paper](https://www.researchgate.net/publication/277948519_On_filament_structure_and_propagation_within_a_commercial_plasma_globe) for actual globe morphology and camera exposure context. The [2010 author manuscript](https://www.stewartzweben.com/Papers/coauthorpapers/CampanellPoP10.pdf) provides detailed experimental sequences and captions. Links are references; no third-party image assets were copied into the product.

Teunissen's [2019 author-created streamer video](https://commons.wikimedia.org/wiki/File:Simulation_of_a_positive_streamer_discharge.webm) juxtaposes electric field, density, charge, and emitted light. It models a parallel-plate air discharge, **not a globe**, and is useful for understanding why these fields must not be conflated. [Afivo's maintained documentation](https://teunissen.net/afivo_streamer/doc-contents.html) is a reference for future field/species work; its native solver is not a drop-in WebGPU dependency.

The available globe experiments do not establish a uniquely correct microscopic model for every commercial mixture. Wanigan should describe the proposed implementation as a reduced physical model with real state and responsive interactions. It should not claim full plasma, calibrated voltage/temperature, Maxwell, or MHD simulation. The decisive product improvement is coherent cause and effect that survives prolonged interaction, both companion sizes, and honest visual inspection.

## Implementation following this research

The replacement in `plasma.ts` uses eight primary channels and four connected secondary branches, with 24 stations per path. A deterministic 60 Hz CPU solver evolves channel ages, effective memory, correlated disturbances, power, attachments and damped path motion. A stable GPU buffer carries the resulting geometry into the existing refracting WebGPU vessel. This division keeps a small state model inspectable without adding a GPU readback to the animation loop.

The electrode has finite radius 0.145 in orb coordinates. Roots move on that surface; tips live on the inner shell at radius 0.965. Geometry is constrained to the shell even under rapid pointer motion. Channels renew at different times, with fade envelopes and independent disturbances. Each secondary branch starts at a station of its explicit parent. These remain reduced geometric dynamics: the model does not calculate a self-consistent potential, electron density, species reactions, or gas temperature.

Touch is raycast through the optical camera and front glass. All primary channels receive a score based on attachment proximity and effective memory. The leading channel receives most of a bounded excitation budget; other channels dim. The total budget rises modestly during contact. Release decays contact and restores a distributed population. The glass is spherical and the discharge uses world coordinates, so handling rotations of the face do not rotate the pointer away from the actual visible shell point.

The shader evaluates a continuous distance envelope per channel, taking the maximum along that path instead of adding independent blobs at segment joints. Conservative channel bounds reject irrelevant rays. Thin blue-violet shafts, warmer terminal regions, electrode shading, and curved shell contact footprints share the same refraction and depth tests as the eyes. This is a display palette and an exposure approximation, not spectral or electrical calibration. It avoids tessellation-driven joint brightness; exact radiometric line integration and fully adaptive tessellation remain possible future improvements.

The associated snow correction uses 192 airborne powder parcels and a 48 × 48 bed. Symmetric local transfers relax steep slopes, deposited mass remains in the bed, and shaking withdraws that mass back into airborne parcels. Snow has no water coupling. About 90 seconds of active animation supplies the target volume, after which new snowfall stops. The state stays in the renderer when the companion moves between the mission room and its miniature. Motion off and hidden windows pause it; restarting the app resets decorative snow. Granular deposition is not Disney's elastoplastic MPM snow model or a calibrated snow-density simulation.

Production checks and both-theme visual evidence are recorded in [the snow/plasma verification directory](../visuals/orb-snow-plasma/README.md). The numerical checks use simulation seconds and test mass balance, deposition, shake/redeposition, capacity, contact location, power concentration, independent renewal, finite roots, bounded geometry, and cadence independence. These checks establish implementation behavior, not agreement with laboratory measurements.
