# Orb authoring, MCP tools, and the runtime boundary

Research checked on 2026-09-09, America/Chicago. The filename follows the investigation's requested UTC date. This is an authoring-pipeline investigation, not an installation, benchmark, or proof that a third-party tool works inside Wanigan. No software, MCP server, account, or subscription was installed or configured.

## Decision

**Use Blender to establish the visual target and author reusable assets; retain the custom WebGPU simulation in Wanigan.** The best next authoring deliverable is a controlled reference scene with the same camera, shell thickness, eyes, liquid level, lights, and background as the application. Compare that render against the actual Electron result before changing solvers. A new tool can improve the reference, geometry, lighting, and tuning workflow; its presence does not automatically improve the shipped image.

For this orb, Blender plus reviewed local Python scripts is the first choice. A pinned Blender MCP can make the scene-edit/render/inspect loop more convenient, subject to the concrete telemetry and execution findings below. Houdini is a useful optional escalation for high-quality liquid/pyro reference simulations and field exports. EmberGen is worth evaluating for fire authoring on a supported machine, but its public Mac application availability is unresolved by the sources inspected. Unity, Unreal, Spline, and PlayCanvas are credible alternatives with specific capabilities; switching to one needs a measured benefit beyond a good-looking editor preview.

This recommendation assumes the requested result must react to new pointer forces and changing application state, run locally, and remain small enough to coexist with terminals. It is an engineering judgment, not a performance result.

## What exists in this checkout

The inspected `src/renderer/src/orb/runtime.ts` imports the vendored Particles4All solver, constructs an 80³ liquid density/velocity field, invokes the separate `Gas` class, and renders through the custom `OPTICS` shader. `gas.ts` uses a 64³ grid with transport, pressure projection, a liquid obstacle mask, and buoyancy. It does not contain a fuel/oxygen/temperature combustion system. Calling this implementation fire would currently overstate its behavior. These are source observations, not numerical validation.

The implementation task reports 8,144 liquid particles on an M2 Pro. This note did not rerun that observation or benchmark the renderer. The existing [runtime physics investigation](2026-09-09-realtime-orb-physics.md) contains the upstream solver inspection and Electron compute proof. Changes elsewhere in the working tree were preserved.

## Three deliverables that are easy to confuse

| Deliverable | What it contains | What happens after a new pointer impulse? |
| --- | --- | --- |
| Authoring scene | Editable objects, materials, lights, rigs, solver settings, and cameras inside Blender/Houdini/etc. | The authoring tool may resimulate. It is not an Electron component. |
| Baked result | A video, flipbook, mesh sequence, vertex animation texture, particle cache, or volume sequence. | Playback can be warped or blended, but it does not solve a new fluid trajectory. |
| Live runtime | Numerical state, force input, boundary conditions, time integration, surface reconstruction, and rendering. | State advances from the new conditions. Stability and frame cost must be verified in the app. |

Blender explicitly documents replay/modular/all fluid caches and OpenVDB storage. Epic explicitly demonstrates baking a Niagara 3D fluid into a 2D flipbook. JangaFX's VDB export contains simulation fields but excludes later shading and lighting. Those are useful outputs, with different capabilities from a solver. [Blender cache](https://docs.blender.org/manual/id/5.0/physics/fluid/type/domain/cache.html), [Niagara Baker](https://dev.epicgames.com/documentation/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine), [EmberGen VDB export](https://docs.jangafx.com/embergen/pages/references/How-To%20Guides/exportVDB.html).

An MCP connection belongs on the authoring side of this table. It carries commands and observations between an agent and an application. None of the bridges below turns its host application's numerical engine into a portable WGSL package.

## Blender and Blender MCP

### Useful, concrete work

Create the exact glass shell and eye geometry, arrange a controlled studio light rig, expose a small expression rig, render reference views, and export static meshes. Blender is GPL software, but the Blender Foundation says artwork and output files remain usable commercially. Buying a software license is not necessary for this authoring route. Third-party assets still retain their own licenses. [Blender licensing](https://www.blender.org/about/license/).

For automation, deterministic Blender Python scripts can generate the same scene repeatedly, set its parameters, render it, and export selected assets. This is often easier to review than a long sequence of interactive edits. Use interactive MCP when seeing and adjusting the current scene saves work. The official Blender Python API is the underlying application API; MCP is an optional wrapper. [Blender Python API](https://docs.blender.org/api/current/).

The `ahujasid/blender-mcp` project is explicitly third-party. Its architecture is a Python MCP server plus an addon that receives commands inside Blender. It supports scene/object inspection, material manipulation, Python execution, screenshots, and optional asset/model services. Prerequisites currently state Blender 3.0+, Python 3.10+, and `uv`; the addon still needs a running Blender GUI for its timer-driven command loop. [README](https://github.com/ahujasid/blender-mcp), [addon GUI guard and command queue](https://github.com/ahujasid/blender-mcp/blob/main/addon.py).

### Current source findings that affect adoption

The inspected package metadata says version **1.9.1**, MIT. The commit listing showed a September 7, 2026 head with abbreviated id `5f8ddaf`. That is a research snapshot, not an instruction to install whatever `main` contains later. Pin and inspect the actual package/addon bytes together before use. [Package metadata](https://github.com/ahujasid/blender-mcp/blob/main/pyproject.toml), [commit history](https://github.com/ahujasid/blender-mcp/commits/main/), [license](https://github.com/ahujasid/blender-mcp/blob/main/LICENSE).

**Telemetry is enabled by default in the current README.** August 2026 terms describe collecting prompts, generated code, screenshots, scene metadata, trajectories, and manual Blender edits, with possible training/research/dataset use. The terms also say minimal usage records remain when content consent is off, although another paragraph broadly says no data is collected. Treat the specific minimum-record language and code as the relevant evidence; unchecking the checkbox is not evidence of zero egress. [Current README telemetry section](https://github.com/ahujasid/blender-mcp#telemetry-control), [terms](https://github.com/ahujasid/blender-mcp/blob/main/TERMS_AND_CONDITIONS.md).

The source's `TelemetryCollector._is_disabled()` recognizes `DISABLE_TELEMETRY`, `BLENDER_MCP_DISABLE_TELEMETRY`, and `MCP_DISABLE_TELEMETRY`, accepting values including `true` and `1`. It sets the collector disabled. The MCP `disable_telemetry` tool, by contrast, explicitly says minimal usage counts still apply. For a local-only workflow, use the environment disable path **and** addon consent off, then verify actual egress on the installed build. This source inspection is not a completed network audit. [Collector](https://github.com/ahujasid/blender-mcp/blob/main/src/blender_mcp/telemetry.py), [disable tool](https://github.com/ahujasid/blender-mcp/blob/main/src/blender_mcp/server.py).

The addon ultimately executes supplied Python using `exec(code, namespace)` with access to `bpy`. The newer server-side safe mode checks scripts before forwarding them, but a Python allowlist is not an OS sandbox. A Blender process can read/write files through its application APIs. Keep the service on loopback, use an isolated authoring scene, and review destructive commands. Do not put this control endpoint inside Wanigan's renderer. [Addon execution](https://github.com/ahujasid/blender-mcp/blob/main/addon.py), [server safe-mode path](https://github.com/ahujasid/blender-mcp/blob/main/src/blender_mcp/server.py).

The `soozs1/Blender-MCP` fork claims removed telemetry, token authentication, restricted egress, and an optional AST guard. These are useful review targets, not grounds to call the fork audited or safer overall without inspecting its installed revision. It still exposes Python execution and explicitly disclaims sandboxing. It was not installed or exercised here. [Fork documentation](https://github.com/soozs1/Blender-MCP).

The recommended first connection would expose inspection, material/geometry edits, render, and export only. Hyper3D/Hunyuan3D and other hosted generation services add no necessary capability for a sphere and small eye rig; leave them disabled and uncredentialed. No model-generation credits are included in the local MIT server license. Wanigan's own runtime configuration rules take precedence over setup examples that write harness files into a project.

### Export boundary

Use GLB for geometry, supported PBR values, textures, and the eye rig's supported animation. Blender's exporter maps transmission, volume absorption, and IOR through glTF extensions. That is material data, not a promise that every runtime reproduces Cycles or renders nested glass and water correctly. A Blender procedural shader graph is not portable executable WGSL. [Blender 5.1 exporter manual](https://docs.blender.org/manual/en/5.1/addons/import_export/scene_gltf2.html), [Khronos transmission extension](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_transmission).

In particular, `KHR_materials_volume` describes optical properties of a material's interior. It is not a fluid solver or a time-varying smoke grid. Export mesh/material assets and manually map supported optical parameters into the orb shader; keep the runtime fluid field and interface traversal explicit. [Khronos volume specification](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_volume).

## Houdini: strongest optional simulation reference, separate runtime

Houdini's sparse Pyro solver has actual density, temperature, and velocity fields plus a flame field and shaping controls. Its documentation distinguishes sparse regions from dense simulation, and says this solver's OpenCL acceleration requires dense mode. Therefore “GPU accelerated Houdini” is not sufficient to infer that any chosen Pyro network is fast or even fully GPU resident. [Sparse Pyro reference](https://www.sidefx.com/docs/houdini/nodes/dop/pyrosolver_sparse.html).

Use it to author and compare small controlled cases: buoyant fire in a vessel, a sloshing liquid reference, vortices around the eye geometry, temperature/density ramps, and volume extinction. Export snapshots or caches as reference data, or derive low-resolution initial fields and reusable masks. The useful transfer is the result and parameters; recreating a microsolver network in WGSL is additional implementation work. Houdini Engine licenses support asset cooking in other authoring applications; the store's examples are Maya and game editors such as Unity/Unreal, not a browser fluid runtime. [Pyro workflow](https://www.sidefx.com/docs/houdini/pyro/lookdev.html), [Engine license description](https://www.sidefx.com/buy/).

Current Houdini 22 requirements support Apple Silicon Macs, require 16 GB RAM, recommend 32 GB+, and strongly recommend 64 GB for fluids. They also list CPU/NVIDIA OptiX support for Karma XPU, so Apple Silicon host support does not establish Apple GPU support for every renderer. These requirements are a reason to keep reference domains bounded, not a measured M2 Pro result. [H22 requirements](https://www.sidefx.com/Support/system-requirements/).

The comparison page currently lists Indie at **$299/year or $449/two years**, limited commercial use and at most three licenses per facility. Apprentice is free for noncommercial work and has output restrictions. Do not turn an Apprentice experiment into shipping commercial assets by changing filenames. Check actual eligibility and purchase terms if this optional route is selected. [Product comparison](https://www.sidefx.com/products/compare/), [Apprentice description](https://www.sidefx.com/buy/).

Practical third-party MCP candidates exist. `rheadsh/houdini-mcp` exposes node creation, connections, parameter setting, cooking, rendering, animation, DOP inspection, and viewport capture; its code is MIT. Its documented security limitations include no authentication/per-tool authorization and incomplete path coverage: plain output parameters and executable expressions remain powerful. The repository's Houdini/Python compatibility claims are not end-to-end verification on this machine. [MCP README](https://github.com/rheadsh/houdini-mcp), [license](https://github.com/rheadsh/houdini-mcp/blob/main/LICENSE). The older `capoom/houdini-mcp` repository redirects to a different repository; avoid installing from an obsolete tutorial. [Redirect](https://github.com/capoom/houdini-mcp).

## EmberGen: rapid fire look development, with an unresolved Mac release

EmberGen's documented export pipeline is particularly relevant to fire. It can export VDB fields after volume processing; shading and lighting applied later do not travel with those fields. Its default export channels are density and flames, and its Blender shader guidance maps the temperature attribute to `flames`. Consequently, a VDB appearing different in another renderer can be a transfer-function/lighting issue rather than a simulation failure. [VDB export guide](https://docs.jangafx.com/embergen/pages/references/How-To%20Guides/exportVDB.html).

The current public sources do **not** justify an unconditional “EmberGen works on your M2 Pro” statement:

- The indexed download page lists **1.2.11, August 19, 2026**, Windows/Linux downloads, and also an M-series requirements table including M2 Pro as minimum. A direct page extraction intermittently returned no releases, so the table alone does not identify a Mac application artifact. [Download page](https://jangafx.com/software/embergen/download).
- The vendor's roadmap says M-series Mac support is completed **internally**, with an explicit warning that this does not mean publicly available. Its scriptable API is still marked on target. [Roadmap](https://jangafx.com/roadmap/embergen).
- Mac Apple Silicon links in the floating-license guide are **license-server programs**. They do not prove the simulation application has a Mac build. [Licensing guide](https://docs.jangafx.com/licensing/index.html).

Before evaluating locally, identify an actual official EmberGen application build for Apple Silicon and its matching release notes. If that cannot be obtained, use Blender/Houdini locally or an already authorized supported Windows/Linux workstation. Do not buy a license based on the generic Mac table. This is a deliberately unresolved availability finding, not a claim that a Mac release is impossible.

Current Indie node-locked permanent pricing shows **$300 for EmberGen**, **$180 optional annual maintenance**; the Elemental Suite is **$525**, with **$315 optional annual maintenance**. Indie eligibility is constrained by revenue/funding criteria. The EULA allows a 30-day evaluation but says trial exports cannot be used commercially until a license is purchased. No purchase was made. [Pricing](https://jangafx.com/software/pricing?license=nodelocked&rebill=permanent&type=indie), [EULA](https://jangafx.com/legal/end-user-license-agreement).

No shipped official EmberGen MCP or embeddable browser solver SDK was verified. The documented scripting roadmap is not a callable interface. Use documented GUI/export workflows for evaluation; do not promise a nonexistent bridge or redistribute the application as Wanigan's fluid engine. A baked flipbook may be acceptable for a small transient spark accent, but not as the replacement for the responsive main fire volume.

## Unreal and Unity: real effects tools, expensive architectural detours

### Unreal Niagara

Niagara Fluids provides 2D/3D gas and liquid templates, including simulation and rendering settings. Epic's reference distinguishes reusable gas simulation inheritance from cinematic emission variants. This is real engine simulation authoring, while its flipbook baker is explicitly an optimization that turns a 3D effect into sprite playback. [Fluids reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine), [Baker workflow](https://dev.epicgames.com/documentation/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine).

**Unreal 5.8 now has an official Unreal MCP plugin.** It runs inside the editor, executes tool requests serially on the game thread, and uses local HTTP/SSE rather than stdio. Its docs say no authentication layer and loopback-only default behavior. Epic's setup reference enables both `ModelContextProtocol` and `AllToolsets`; transport alone does not expose editing tools. This is a stronger starting point than assuming all Unreal integrations are third-party. It was not installed or tested here. [Official MCP documentation](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor), [Epic setup source](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin/blob/main/skills/unreal-mcp/references/setup.md).

A Niagara-labelled repository can still be an extension template or an inspection/export helper. For example, the inspected `IvanMurzak/Unreal-AI-Niagara` README described a template, whereas `Mingxi-Farron/unreal_mcp_niagara_toolset` describes exporting a Niagara system to T3D/text. Neither name alone proves complete fluid authoring. [Template repository](https://github.com/IvanMurzak/Unreal-AI-Niagara), [export helper](https://github.com/Mingxi-Farron/unreal_mcp_niagara_toolset).

No direct Niagara-to-WGSL runtime export was verified. A native Unreal process embedded or streamed into Electron would add another engine/process/lifecycle and needs separate latency, packaging, offline, and license work. Epic's current licensing page distinguishes runtime-distributed products from seat-based uses, and states a 5% royalty on directly attributable lifetime gross product revenue above $1 million for its royalty route. Baked non-engine results and embedding runtime code are different license cases. [Unreal licensing](https://www.unrealengine.com/license).

### Unity VFX Graph

The old claim that VFX Graph cannot run in a browser is now too broad. **Unity 6.6, released September 1, 2026, promotes WebGPU to a production-supported graphics API**, with compute shaders, GPU skinning, indirect rendering, and VFX Graph available to Web builds. Unity's announcement describes URP support and says WebGL 2 remains the default: WebGPU must be enabled explicitly. [Official 6.6 release announcement](https://discussions.unity.com/t/unity-6-6-is-now-available/1735357), [6000.6.0f1 release notes](https://unity.com/releases/editor/whats-new/6000.6.0f1), [6.6 WebGPU manual](https://docs.unity3d.com/6000.6/Documentation/Manual/WebGPU.html).

The apparent documentation conflict is version-specific: the **6.3 LTS** manual still labels its WebGPU backend experimental; it must not be used to describe **6.6** availability. The Web Graphics team's August 24 announcement explicitly says WebGPU exits experimental status in 6000.6. API fallback is not solver fallback: a WebGL 2 path cannot execute the same WebGPU-only compute workload unchanged. For a new evaluation use a pinned 6.6 build and its matching render/VFX packages, then test device support and the full effect. [6.3 documentation](https://docs.unity3d.com/6000.3/Documentation/Manual/WebGPU.html), [official WebGPU support announcement](https://discussions.unity.com/t/webgpu-out-of-experimental-in-unity-6-6/1734694).

This makes a Unity WebGPU build a legitimate prototype candidate, but VFX Graph is not itself proof of a closed-vessel liquid/combustion solver. Such a build also includes Unity's runtime and needs an integration/build/asset pipeline. Benchmark its complete Electron deployment, alpha composition, nested transmission, startup, memory, and idle behavior before considering a migration.

Unity now documents an **official experimental CLI with `unity mcp`**, exposing connected Editor commands over stdio and requiring its Editor/Pipeline setup. Prefer investigating that current supported route. Third-party `CoplayDev/unity-mcp` also exists, advertises editor/asset/script/test tools, and carries MIT licensing; this licenses the bridge, not Unity. [Official CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference), [CLI release notes](https://docs.unity.com/en-us/unity-cli/release-notes), [Coplay project](https://github.com/CoplayDev/unity-mcp), [Coplay license](https://github.com/CoplayDev/unity-mcp/blob/main/LICENSE).

Unity's current terms define Authorized Agentic Access through a Unity-operated/designated gateway with authorized participants. The existence of an MIT bridge is therefore not evidence that its use is currently authorized by Unity's software terms. This investigation does not make that legal determination; the practical recommendation is the documented official connection. [Unity terms](https://unity.com/legal/terms-of-service).

Unity's pricing also distinguishes entertainment from industry use. The product page lists Pro from **$2,310/year**, and Industry requirements for qualifying non-game applications. Do not assume a coding-agent control surface qualifies for the free Personal entertainment offering solely because it has a character. No paid Unity tier is required for the recommended Blender/custom-WebGPU route. [Unity pricing and eligibility](https://unity.com/products).

## Web-focused authoring and engine options

| Option | Verified capability | Implication for this orb |
| --- | --- | --- |
| Custom WebGPU + existing solver | The local checkout already owns solver buffers, density fields, gas, and optics. | Best control over nested glass/volume traversal and resource cost. Requires shader/solver expertise and good visual tooling. |
| Three.js WebGPURenderer | TSL/node materials, compute integration, and an official 3D volumetric-fire example. | Useful source and scene tooling. Porting does not remove the need to implement the vessel's optical interfaces. |
| Babylon.js | Engine with a dedicated fluid-rendering subsystem; upstream examples distinguish rendering from simulation. | Useful screen-space-fluid and inspector reference. Rendering particles as fluid does not establish their physical dynamics. |
| PlayCanvas | WebGPU compute shaders/storage buffers and an editor/material pipeline. | Plausible visual workbench if editor integration saves enough time; custom solver and optics remain required. |
| Spline | Official desktop MCP, editable scenes, events, particles, and web exports. | Useful expressive-motion/blocking prototype. Documented particle forces are not proof of pressure-projected liquid or combustion. |

Sources: [Three renderer](https://threejs.org/manual/en/webgpurenderer), [Three fire source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_fire.html), [Babylon engine](https://github.com/BabylonJS/Babylon.js), [original fluid renderer/examples](https://github.com/Popov72/FluidRendering), [PlayCanvas compute](https://developer.playcanvas.com/user-manual/graphics/shaders/compute-shaders/), [Spline particles](https://docs.spline.design/designing-in-3-d/animation/particles).

The Three fire source contains actual velocity/dye transport, divergence, pressure iterations, and gradient subtraction alongside artistic noise/detail. Use it as an inspectable numerical/rendering reference; copying a glowing noise expression alone would discard the part that makes it a flow simulation. The current Wanigan gas solver can evolve toward a fire solver without first changing its scene engine. That is a proposed development direction, not a claim that current gas already burns. [Three fire source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_fire.html).

Three.js and PlayCanvas engine code are MIT; Babylon is Apache-2.0; Particles4All is MIT. Preserve notices when adapting source. A hosted editor subscription, asset license, and engine source license are separate decisions. [Three license](https://github.com/mrdoob/three.js/blob/dev/LICENSE), [PlayCanvas license](https://github.com/playcanvas/engine/blob/main/LICENSE), [Babylon license](https://github.com/BabylonJS/Babylon.js/blob/master/license.md), [Particles4All license](https://github.com/matsuoka-601/Particles4All/blob/main/LICENSE).

Spline's MCP is now bundled in its Mac/Windows desktop app, communicates locally, and can inspect/edit scenes and capture screenshots. Its docs also say app startup registers supported MCP clients automatically; scene editing and cloud AI generation must not be conflated. Cloud generation still uses Spline's hosted services. Review those client-config writes before installation in a Wanigan workflow. [Official Spline MCP](https://docs.spline.design/generate/spline-mcp-server).

Spline's code-export documentation lists Vanilla JS, React, Three.js, and related targets, but says animations/events are enabled only in Vanilla JS and React export. Export modes therefore have materially different behavior. No supported route for importing Wanigan's existing GPU buffers or replacing Spline's internal optics was verified. [Code export](https://docs.spline.design/exporting-your-scene/web/exporting-as-code). Its plan/export/AI limits should be checked for an actual experiment; this research does not recommend a paid Spline plan. [Pricing](https://spline.design/pricing).

## Materials, environment, and useful baked data

Use a studio environment with broad bright sources and dark separation to make the shell readable. Keep the lighting identical in the authoring reference and app. This is a proposed look-development method: freezing illumination makes it possible to attribute a visual mismatch to roughness, absorption, surface normals, or interface traversal instead of changing everything together.

Poly Haven assets are CC0, including HDRIs, and may be redistributed in products. Its live API has separate terms: the July 2026 API page says commercial use is free but requires clear source attribution and a unique User-Agent. The app needs no live asset API: select an environment during authoring, record provenance, and bundle the processed map locally. [Asset license](https://polyhaven.com/license), [current API terms](https://polyhaven.com/our-api).

Use physically meaningful material parameters and document their units, while treating values as tunable appearance inputs until validated. A useful handoff contains:

1. Static eye/eyelid geometry, pivots, a small expression rig, and approved poses.
2. Shell inner/outer radius and material IOR/roughness/attenuation settings.
3. An HDR environment plus a reference of its orientation, exposure, and backdrop.
4. Initial fluid fill and optional volume emission masks as data, not a movie pretending to be state.
5. Optional low-resolution noise/detail textures. Advect or evaluate them within the runtime flow; label nonphysical detail as appearance work.
6. Reference stills and short simulation sequences, including side/three-quarter views that reveal depth.

A smoke VDB can be resampled offline into a bounded 3D texture for a starting condition or test fixture. A VDB sequence retained as playback is still a cache. Bringing in velocity and density does not magically transfer a solver's pressure state, boundary treatment, combustion model, units, or licensing. Import only fields with a defined meaning and compare them against a known diagnostic case.

## Concrete local pipeline and acceptance gates

### 1. Establish the same scene in two renderers

Build a disposable Blender scene with an analytic/smooth sphere shell, separate inner wall, stationary water reference surface, eyes, a neutral studio HDR rig, and exactly matched camera. Render the approved view plus side and close-up views. Record all optical parameters and light settings in a small text manifest. Do not ship a new engine or a baked animation at this stage.

### 2. Match static optics before adding complexity

Render the identical static state through Wanigan. Compare water/glass separation, eye depth, Fresnel highlights, total internal reflection behavior, absorption through different path lengths, edge antialiasing, and transparent composition in both app themes. A static mismatch is actionable without confusing it with simulation motion.

### 3. Prove responsive fluid behavior

Replay a fixed series of bounded impulses. Capture visible motion plus diagnostic fields and numerical measurements. Let the liquid rebound and settle after input ends; confirm cavity confinement and stable frame stepping. Evaluate the gas flow with a passive density plume before upgrading it to fire. No particle count, solver label, or editor capture is a substitute for this evidence.

### 4. Add fire as its own physical model

For responsive fire, introduce explicit transported temperature and fuel/burn-state fields, bounded sources, buoyancy tied to temperature/density, and a defined combustion/extinction approximation. Treat heat emission, smoke absorption/scattering, and small-scale detail as rendering choices tied to those fields. Decide explicitly whether the vessel is an artistic energy source or models finite oxygen; a sealed globe with perpetual flame is not a validated combustion chamber. This is a proposed model scope, not existing implementation.

Author a small reference fire in Blender/Houdini or, once availability is proven, EmberGen. Use it to compare plume shape, roll-up, extinction, emission ramps, self-shadowing, and glass response. Do not attempt to reproduce every offline effect before measuring the orb at its actual display size.

### 5. Export small assets; measure the shipped composition

Keep assets local and versioned with provenance. Drive the eyes and source strengths from deliberate application states without continuously regenerating geometry or making model calls. Measure GPU time separately for liquid solving, field reconstruction, gas/fire solving, optics, and post-processing. Include actual hardware, pixel resolution, frame rate distribution, memory, and terminal responsiveness. Pause work when hidden or motion is disabled, and verify device-loss cleanup.

Acceptance requires real Electron images in both themes, a responsive interaction recording, numerical checks, and resource measurements. Offline tool previews establish a visual reference; they do not establish runtime quality or performance. This pipeline is intended to locate the largest fidelity gap first and keep every additional tool accountable to a concrete improvement.

## Remaining uncertainties

- No Blender/MCP/Unity/Unreal/Houdini/Spline/EmberGen installation or end-to-end bridge call was performed. Advertised compatibility remains unverified locally.
- EmberGen public Apple Silicon application availability remains unresolved despite Mac-related vendor pages.
- Upstream pages and `main`/`dev` branches can change. Pin chosen code and exported artifacts when implementation begins.
- No third-party bridge was security-audited, and no engine was benchmarked against the current custom renderer in this task.
- Prices and plan eligibility above are dated observations from primary pages, not purchases or a determination of the user's eligibility.
