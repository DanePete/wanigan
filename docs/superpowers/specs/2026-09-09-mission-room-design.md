# Wanigan Mission room

Approved direction: concept B, selected by the user on September 9, 2026. This
replaces the earlier visual explorations. The user authorized an end-to-end
redesign of the existing app and an orb that serves as a conversational companion.

## Experience

Mission room opens on a material glass orb and a short briefing across projects.
The briefing comes from observed session states. Under this horizontal stage,
projects form a continuous shelf, ordered by attention. Project spaces in the
window chrome narrow the view; the global dock opens Mission room, Sessions,
Fleet, reviews and knowledge. A destination drawer and the existing command
palette retain access to every current view and every existing shortcut.

The orb contains an actual three-dimensional Position Based Fluids particle
volume, constrained by a spherical vessel, and a separate Eulerian vapor field
with advection, pressure projection and buoyancy. This replaces the rejected
spring-heightfield shader. No still character, sprite loop or warped image stands
in for simulation. Glass and water refract the view through their separate
interfaces; eyes are geometry within the vessel. Pointer drag applies bounded
impulses to the liquid. It settles under gravity, viscosity and surface tension.

Motion off freezes decorative movement, auto respects reduced motion, and hidden
views stop drawing. The scene runs on a dedicated WebGPU device with bounded
resolution, particle count and queued work. Unsupported GPUs show an honest
unavailable state. The orb never moves or overlays a terminal. Blender MCP is an
authoring option; its offline simulation cache is not the interactive runtime.
See the [physics research](../../research/2026-09-09-realtime-orb-physics.md).

## Visual system

The selected dark concept establishes charcoal glass, silver lettering and a
restrained ice-blue accent. The light counterpart uses porcelain, graphite and
blue. Base palette: charcoal #171e24, raised slate #202930, silver #f1f5f8,
muted silver #aebcc8, ice #a6d9f8; light porcelain #f4f6f8 and graphite #1c2731.
System SF-style typography carries both interface and display text. The Mission
room briefing has generous display scale; working views retain compact readable
controls. Glass is concentrated in the orb, chrome and dock. Working documents
remain opaque and legible. Shared tokens and primitives carry both themes across
all existing views.

## Companion

The first connected conversational transport uses the existing Anthropic API
connection, with an explicit model selector and send action. No background model
calls run on mount, refresh, project selection or notifications. The message
composer identifies the connection and the context sent. No microphone affordance
is shown until a real voice transport exists.

Main assembles a bounded operational snapshot: registered project names and
branches, session identities, providers, lifecycle and attention states. It does
not send raw agent prompts, replies, terminal output, file contents or paths.
This keeps cross-provider summaries operational. The companion explains missing
evidence instead of claiming it read a session transcript. The model has no tools,
filesystem access, agent-launch authority or permission-approval authority.

Questions and answers persist locally, separately from learning records. Main
owns validation, conversation history and the source snapshot. Responses can
reference only source identifiers present in that snapshot; the renderer resolves
these into project/session navigation. Each explicit question makes at most one
bounded request, with cancellation and timeout. Usage is recorded when reported;
unreported usage remains unknown. The global halt stops pending requests and
refuses new calls. Missing credentials produce a setup path while the local
briefing and project shelf remain useful.

## Integration and preservation

Existing route ids and digit shortcuts keep their meanings. Mission room is an
additional route. Project selection is made explicit on scoped views; broader
views state their scope. Existing agent sessions, terminal I/O, git review gates,
provider packs, accounts, learning boundaries, schedules and data stay intact.
Schema additions preserve existing records. Development runs in an isolated
profile; the installed application is not replaced or restarted.

## Verification

Verify route reachability, keyboard focus, project scoping, companion validation,
bounded evidence and source links, failures, cancellation, halt, persisted chat,
and request/usage accounting with offline fixtures. Inspect real Electron
screenshots of all affected views in both themes and narrow layouts. Check the
orb visually and with motion off. Run the complete repository `npm test` suite
and `git diff --check`. Do not spend model tokens merely to validate UI.

## Implementation order

1. Add the Mission room route, project navigation, dock and shared visual tokens.
2. Build the glass orb and the operational briefing/project shelf.
3. Connect the main-owned companion conversation and typed preload API.
4. Align project selection and existing working surfaces with the shared frame.
5. Run offline behavior checks, full tests and screenshot review; resolve failures.

Self-review: scope, data flow, model-call authority, fallback states and acceptance
checks are explicit. The selected design is already approved; no second visual
approval is required to implement these details.


## September 10: expressive physics extension

The user explicitly requested intentional gaze and blinks, a globe that can spin,
and a substantially larger fire effect. Implemented two persistent temperaments,
three flame roots, transported fuel/heat/soot, inertial cooling embers, HDR bloom,
fixations and corrective saccades, fast-close/slow-open blinks, eye-led globe turns,
and bounded tangential vessel drag. The native visibility bridge pauses new GPU
submissions independently of document visibility. Motion off freezes all physical
and expression state. These effects do not launch agents or bill model calls.

The detailed behavior and research sources are in
[the gaze/spin notes](../../research/2026-09-10-orb-gaze-and-spin.md), with
[recordings and verification](../../visuals/mission-room/README.md).


## September 10: the room and the review workspace

Continue the approved composition with a shorter Mission stage, localized
lighting behind the briefing, a purposeful single-project shelf, and a compact
companion popover. Appearance and play are explicit; the globe also keeps its
direct manipulation. Use native top-layer popover behavior and anchored
positioning so the controls stay near their trigger without entering the
layout or clipping under the project shelf.

The Review destination, formerly labeled Control, opens on a goal list beside
the selected record. New goal opens a sheet with the existing validated fields;
closing it retains the draft while the view remains mounted. The shared dialog
owns focus and dismissal. Main still validates creation and starting an agent
remains separate. A collapsed execution summary names autopilot state and, when
armed, the frozen provider and cap. Secondary metadata, events and guidance use
disclosure. IDs, shortcut positions and existing deep links remain stable.

The current layout and remaining per-view work are detailed in the
[UI audit](../../research/2026-09-10-ui-design-audit.md) and
[primary-source study](../../research/2026-09-10-desktop-ui-primary-sources.md).
[Visual evidence](../../visuals/ui-deep-dive/README.md) distinguishes this pass
from the earlier Mission room implementation and from the approved concept.
