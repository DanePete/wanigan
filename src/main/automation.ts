import { app } from 'electron';

/**
 * The launch marker that tells "the operator started this run" apart from "the
 * page asked".
 *
 * One channel needs the distinction. `projects:add` inserts a directory into
 * the projects table, and roots.ts builds `managedRoots()` from exactly that
 * table — so anything that can name a path can widen the allow-list every
 * other guard reads, and a widened allow-list is not an allow-list. The
 * renderer therefore does not get to widen it: registering a root is the
 * operator's own action, taken in the main-process folder picker
 * (`projects:pick`), which names the exact directory before a row is written.
 *
 * scripts/shots.mjs still needs the raw path form. It drives the built app
 * through Playwright to capture every view, and a headless run cannot click a
 * native folder picker — a window-modal sheet with nobody to dismiss it hangs
 * the run rather than failing it. So the raw channel answers a run started
 * with this marker, and nothing else.
 *
 * This is not a privilege boundary, and describing it as one would be false.
 * Nothing here sandboxes or contains a process: whoever chooses Wanigan's argv
 * can already act as the user. What the marker does is smaller and exact — it
 * takes the renderer out of the set of callers that can reach the channel at
 * all. Argv is fixed by whoever launched the process and is not writable
 * afterwards, so no message from the page can put the flag there.
 *
 * `app.isPackaged` narrows it again: an installed Wanigan refuses the marker
 * however it was launched, on the same reasoning `developmentRendererUrl()` in
 * index.ts already states — a launch-time switch must never turn a shipped app
 * into a more privileged one. The raw channel is reachable only from an
 * unpackaged developer build that a person started by hand.
 *
 * Unrelated to the compound-learning engine's `automation` setting, which
 * decides whether a learned candidate may auto-apply. This module is only
 * about how the process was launched.
 */
export const AUTOMATION_ARGV = '--wanigan-automation';

/**
 * Whether the marker is present on an argv.
 *
 * Argv only: this reads no packaging state and no environment, so a caller can
 * test the parsing against an argv it supplies. It is the parsing half, not
 * the gate — call `automationRun()` to decide whether a channel may answer.
 */
export function automationArgv(argv: readonly string[] = process.argv): boolean {
  return argv.includes(AUTOMATION_ARGV);
}

/**
 * Whether automation-only channels answer at all: an unpackaged build launched
 * with the marker, and nothing else. This is the gate to call.
 */
export function automationRun(argv: readonly string[] = process.argv): boolean {
  return !app.isPackaged && automationArgv(argv);
}
