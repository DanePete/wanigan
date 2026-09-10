# Wanigan: a small world inside the glass

The user approved all seven proposed additions on September 10. This expands
the existing desktop character; the current glass, eyes, room lighting and
full-resolution simulation remain shared by the Mission room and small companion.

## Behavior

- Idle eyes occasionally select and follow a visible simulated bubble. Typing,
  pointing, attention and conversation take precedence. Selection stays on GPU.
- Stirring deposits blue-green light in water. Its field follows liquid velocity
  and decays after input stops; it is not a looping screen overlay.
- An actual pending companion request drives a bounded rotational water force.
  Stopping the request removes the force and leaves the water to settle.
- Pointer capture supports grabbing and flicking the vessel, including outside
  its bounds. A spring-driven handling pose transfers acceleration into water.
  Click/keyboard nudge and keyboard spin remain available at either size.
- A newly observed finished turn or answered question produces one bounded wave
  and bubble burst. Initial load, failed reads and identical polls do not replay
  celebrations. A finished process is not represented as approved work.
- A shower is an explicit play action: transported mist gathers, droplets fall
  under gravity, shell droplets collect and drain, then the chamber clears.
- Lava is a third persistent temperament. Heated cohesive particles rise, cool,
  fall, merge and separate; a reconstructed wax field supplies optics.

## Architecture and limits

Extend the existing force pass, bubble state and expression controller; add
small GPU wake, weather and wax modules. Weather is an art-directed supplied
cycle with one-way tracer coupling, not a closed thermodynamic water cycle.
Wax uses reduced cohesive particle dynamics and a smooth density surface, not
a multiphase Navier–Stokes solver. The new effect controllers add no CPU
readbacks to production; the existing liquid solver retains its diagnostics.
Advection follows the existing semi-Lagrangian method described in
[Bridson's course](https://www.cs.ubc.ca/~rbridson/fluidsimulation/).

Use one quiet appearance/play popover: Water & mist, Ember & flame, Lava lamp;
Spin, Make a splash, Bubble burst, Little rainstorm. These actions have no agent
or model side effects. No new libraries or asset services are necessary.

The small character keeps identical field resolution, geometry and shading;
only its idle cadence differs. All fields, sources, eye targets and handling
freeze for Motion Off and native hiding. Event counters are absorbed while
frozen. Modes survive navigation; status color remains independent of material.

## Verification

Numerically inspect real GPU state: containment, finite velocities, transport
and decay, directed bubble selection, vortex momentum, burst once, rain falling
and clearing, wax temperature/motion, pause, mode transitions and GPU errors.
Capture both themes and a live recording; inspect large and small output.
Exercise UI controls, drag release, keyboard, real attention transitions using
labeled fixtures, and zero model calls. Run the repository's full npm test suite
and git diff --check. Do not restart the installed app as a side effect of tests.

Self-review: this keeps the character as the one expressive focal point and
avoids adding decorative movement elsewhere. Existing authorization covers this
design; implementation can proceed without another approval round.

## Rain correction from visual review

The user observed rain without readable water interaction. Rain must visibly
indent the surface, send out ripples, and eject secondary droplets that return
to the water. Increase the bounded impact transfer and simulate secondary
ballistic droplets. Verify both visible behavior and water momentum; falling
streaks alone do not meet this requirement.
