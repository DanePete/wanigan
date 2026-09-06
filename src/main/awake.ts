import { powerMonitor, powerSaveBlocker } from 'electron';
import type { AwakeReason, AwakeState } from '../shared/types';

/**
 * Holding the Mac awake while agents are working, and only while they are.
 *
 * Leaving the laptop at home stopped meaning the agents kept going: macOS idles
 * to sleep on its own schedule, and a PTY streaming a coding agent's output is
 * not something it counts as activity. This module takes one power-save blocker
 * while there is a live agent or an enabled phone dashboard, and gives it back
 * the moment neither is true.
 *
 * Three decisions are load bearing.
 *
 * The blocker is 'prevent-app-suspension', never 'prevent-display-sleep'. The
 * screen going dark is what a laptop left at home should do; the machine
 * suspending underneath a running agent is not, and asking for the display
 * would keep a bright panel on in an empty room for no benefit at all.
 *
 * There is exactly one blocker. powerSaveBlocker.start() returns a fresh id on
 * every call and Electron keeps the machine awake until every one of those ids
 * has been stopped, so starting one per session would leave a Mac that never
 * sleeps again with no id left in this process to release it. Every path in
 * here goes through take()/release(), and both are idempotent.
 *
 * Nothing holds the blocker merely because Wanigan is open. An app that quietly
 * keeps a laptop awake for its own window drains a battery its owner believes
 * is idle. That is also why the state is reported rather than left implicit,
 * and why `held` is read back from Electron instead of being set to true
 * because we asked: a screen that says "holding your Mac awake" when no blocker
 * exists is exactly the kind of claim this codebase does not make.
 */

/**
 * The two facts main already knows. This module observes neither for itself —
 * it has no opinion about what a session is, and giving it one would mean a
 * second place that could disagree with the session list about who is running.
 */
export type AwakeDemand = {
  /** Live agents: interactive PTYs plus detached headless rows. */
  sessions: number;
  /** The phone dashboard is switched on, so a device may be polling this Mac. */
  dashboard: boolean;
};

/** A sentence for a person, not a log — the bound tailnet.ts uses for the same job. */
const MESSAGE_CAP = 200;

/**
 * Electron numbers power-save blockers from zero and increments on every
 * start(), so the first id a process ever receives is 0. `if (blockerId)` would
 * read that as "nothing is held" and leak the blocker for the life of the app;
 * null is the only sentinel that cannot collide with a real id.
 */
let blockerId: number | null = null;
let heldSince: number | null = null;
let wanted: AwakeReason | null = null;
let liveSessions = 0;
let failure: string | null = null;

function reasonFor(demand: AwakeDemand | null): AwakeReason | null {
  if (!demand) return null;
  const running = demand.sessions > 0;
  if (running && demand.dashboard) return 'both';
  if (running) return 'sessions';
  return demand.dashboard ? 'dashboard' : null;
}

/** Electron's answer, not ours. See the module note on why this is read back. */
function stillHeld(): boolean {
  if (blockerId === null) return false;
  try {
    return powerSaveBlocker.isStarted(blockerId);
  } catch {
    return false;
  }
}

/**
 * Whether this Mac is running on its battery.
 *
 * False is also what an unreadable power source reports, and that is
 * deliberate. "You are on battery, so a closed lid will still suspend" is the
 * exceptional claim on this screen; making it about a machine Wanigan could not
 * actually ask would be inventing the one warning the operator is most likely
 * to act on.
 */
function batteryPowered(): boolean {
  try {
    return powerMonitor.onBatteryPower === true;
  } catch {
    return false;
  }
}

function note(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.slice(0, MESSAGE_CAP);
}

/**
 * Take the one blocker, or record why it could not be taken. Returning early
 * when an id is already held is what keeps a reconcile per session launch from
 * becoming a blocker per session launch.
 */
function take(): void {
  if (blockerId !== null) return;
  try {
    const id = powerSaveBlocker.start('prevent-app-suspension');
    if (powerSaveBlocker.isStarted(id)) {
      blockerId = id;
      heldSince = Date.now();
      failure = null;
      return;
    }
    // An id that is not started is one we can neither rely on nor keep: stop it
    // so the count in Electron stays balanced, and say so rather than reporting
    // a hold nobody has.
    try { powerSaveBlocker.stop(id); } catch { /* nothing was started to stop */ }
    failure = 'macOS did not accept the request to keep this Mac awake.';
  } catch (e) {
    failure = note(e);
  }
}

/**
 * Give the blocker back. The id is cleared before stop() runs on purpose: if
 * stop() throws there is nothing further this process can do about that id, and
 * keeping it would leave the module believing it holds a blocker it will never
 * release — a permanently "held" state that no later reconcile could clear.
 */
function release(): void {
  const id = blockerId;
  blockerId = null;
  heldSince = null;
  // Cleared before the stop rather than after it: once nothing wants the Mac
  // awake there is nothing left to report, and a failure kept from the last
  // attempt would leave an idle Wanigan showing an error about a hold nobody
  // is asking for. A stop that actually fails sets it again below.
  failure = null;
  if (id === null) return;
  try {
    powerSaveBlocker.stop(id);
  } catch (e) {
    failure = note(e);
  }
}

/**
 * What is true right now. `reason` and `since` are gated on the blocker Electron
 * reports rather than on the demand, so a hold that failed reads as "not held,
 * and here is why" instead of a confident sentence about power management that
 * never happened.
 */
export function awakeState(): AwakeState {
  const held = stillHeld();
  return {
    held,
    reason: held ? wanted : null,
    sessions: liveSessions,
    since: held ? heldSince : null,
    onBattery: batteryPowered(),
    error: failure,
  };
}

/**
 * Bring the blocker into line with what main just observed. Null means nothing
 * wants the Mac awake — the quit path says it that way, and so does any caller
 * that has already established there is no live work.
 *
 * Safe to call as often as the session list changes: with an unchanged demand
 * it reads one boolean out of Electron and returns.
 */
export function reconcileAwake(demand: AwakeDemand | null): AwakeState {
  liveSessions = demand && Number.isFinite(demand.sessions)
    ? Math.max(0, Math.trunc(demand.sessions))
    : 0;
  wanted = reasonFor(demand);
  if (wanted) take();
  else release();
  return awakeState();
}

/**
 * The blocker id, for the suite only.
 *
 * A leaked blocker is a laptop that never sleeps again, and the failure looks
 * like nothing at all from outside: the state says held, which it is, and the
 * machine stays up long after the last agent exited. The id is the only thing
 * that distinguishes one hold from a second one stacked on top of it, so the
 * assertion that reconciling twice does not start a second blocker has to be
 * able to see it. It stays out of AwakeState because an OS handle is not
 * something the renderer has any use for.
 */
export const __test = {
  blockerId: (): number | null => blockerId,
};
