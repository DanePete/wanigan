# Wanigan · physical personality

The first signature collection connects the companion's material to observed
events. This extends the existing intentional gaze, blink, spin and thought
vortex rather than replacing the shared WebGPU character.

| Interaction | What happens | Source |
| --- | --- | --- |
| Typing | Small, throttled impulses disturb the water; the existing conversation vortex takes over while a request is pending. | Composer input and pending request state. |
| Failure | A vertical rotating flame replaces the visible chamber briefly, then the chosen material returns with a quiet unresolved tint. | A new recorded session error or failed companion request. Repeated polls and clustered errors cannot sustain an endless storm. |
| Recovery | A blue core unwinds after an answered request following a failed one in the same conversation scope. | An answered companion turn; clearing attention, cancellation and elapsed time do not imply success. |
| Context | Colliding iridescent gas pockets crowd the chamber. | Fresh occupancy for the explicitly followed session, an exact conversation match and a CLI-reported window. Assumed windows and unmatched/stale transcripts remain labelled without a pressure performance. |
| Compaction | The pockets gather; a completed hook adds a small pearl that settles into the water. | PreCompact/PostCompact hooks for the followed session. Up to six visual keepsakes persist across page navigation during this follow scope. They are not saved semantic memories or proof of token savings. |
| Float | The same water mass lifts into a suspended blob, can be stirred, and settles when gravity returns. | Explicit Float/restore control or G while the orb has focus. |

Open **Wanigan appearance and play** in Mission to find Float and the session
selector. The miniature uses the same renderer, fields and choreography. Its
existing lower idle draw frequency remains in place. Motion Off and reduced
motion freeze the simulation; status text remains available and received events
are consumed without a later replay. Incidental play never submits a question.

## Physics and limits

Water remains the existing 8,144-particle position-based fluid. Float changes
gravity continuously and applies a gentle centering force; it is an artistic
microgravity interaction, not an orbital mechanics model. Particle buffers and
momentum are preserved when restoring gravity and during a temporary fire scene.

The fire whirl drives the existing 64³ advected velocity, fuel, heat and soot
fields with tangential force, entrainment and a central updraft. Pressure
projection and spherical boundaries still apply. Its temperature is normalized;
there is no oxygen transport, literal boiling, evaporation or thermal coupling
to the hidden water. A temporary flame chamber never draws fire over water.

Context uses 24 bounded colliding pockets and at most six denser keepsakes.
Bodies sample solved gas/water flow; immersed keepsakes receive drag and buoyancy
and supply bounded contact forces back to the water. Their thin-film appearance
and the conversion from a cloud into a pearl are illustrative optics.

The current context IPC supports the Claude harness. Codex's unsupported state
is explicit; cumulative token consumption is never used as occupancy. Timeouts
already classified by the companion service as cancelled retain that outcome;
the orb does not reinterpret error text or invent an API failure category.

## Captures and verification

Before captures use the installed app archive in an isolated Electron profile.
All screenshots and test events below use fictional fixtures, never user work.

| Surface | Dark | Light |
| --- | --- | --- |
| Before Mission | [Dark](before/mission-dark.png) | [Light](before/mission-light.png) |
| Before controls | [Dark](before/play-dark.png) | [Light](before/play-light.png) |
| Float controls | [Dark](ui/float-controls-dark.png) | [Light](ui/float-controls-light.png) |
| Failed request | [Dark](ui/request-failure-dark.png) | [Light](ui/request-failure-light.png) |
| Answered recovery | [Dark](ui/request-recovery-dark.png) | [Light](ui/request-recovery-light.png) |
| Context crowding | [Dark](ui/context-crowding-dark.png) | [Light](ui/context-crowding-light.png) |
| Compaction keepsake | [Dark](ui/compaction-keepsake-dark.png) | [Light](ui/compaction-keepsake-light.png) |
| Miniature failure | [Dark](ui/mini-failure-dark.png) | [Light](ui/mini-failure-light.png) |
| Suspended water detail | [Dark](physics/float-dark.png) | [Light](physics/float-light.png) |
| Fire detail | [Dark](physics/whirl-dark.png) | [Light](physics/whirl-light.png) |

The physics probe compares actual particle positions: mean water height rose
from −0.467 to +0.310 vessel units and returned to −0.467, retaining all 8,144
particles with finite positions inside the vessel. It also checks gathering,
settling, bounded thermal values and GPU validation errors. See
[physics results](physics/verification.json) and [UI results](ui/verification.json).

The source checks cover baseline reads, polling deduplication, cancellation,
recovery, clustered errors, stale/assumed context, scoped history, paused events
and large/mini timing. Package verification compares the renderer and GPU bundle
hashes with the tested build and checks the sealed signature, hardened fuses,
archive integrity and executable PTY helper.

Final verification: `npm test` passed with **1,594 smoke assertions and zero
failures**. Four signature UI groups, five existing personality UI groups and
the GPU physics checks passed. The signature probe also passed against the
actual packaged archive. Both architectures contain the same renderer and
verified GPU runtime. [Build verification](build-verification.json),
[packaged renderer checks](packaged/verification.json), and
[source snapshot hashes](source-manifest.json) retain the evidence.

Concurrent work was building the shared checkout, so release verification used
a temporary source copy with its own native dependencies and output directory.
The source copy includes the concurrent launch-dialog label change. No existing
working-tree edits were reverted and no commit or push was made.

Installed at `/Applications/Wanigan.app` and reopened in Mission (PID 5780).
The installed archive and renderer hashes match the verified arm64 package.
The live play menu exposes Float and Follow context. The authorized restart
ended the three owned terminal processes; saved application records remain.
