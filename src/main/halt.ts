import { getSetting, setSetting } from './settings';
import type { HaltState, HaltStopReport } from '../shared/types';

/**
 * Halt and catch fire: one action that stops the whole fleet, and stays pulled.
 *
 * The distinction this module exists for is the difference between a kill and a
 * halt. Killing every process is the easy half and, on its own, it is close to
 * useless here: the reason an operator reaches for this is usually that
 * something is *re-starting* work — an autopilot dispatching the next node, a
 * schedule firing at 03:00, a queue leasing the row it just failed. Kill the
 * processes and those bring the fleet back inside a minute, which is the exact
 * moment the operator concludes the button does nothing.
 *
 * So the latch is the feature and the kill is the consequence. While it is
 * pulled, every path that could start work refuses by name, and the hook gate
 * denies every tool call from anything still breathing — a wedged CLI that
 * survived the signal cannot take one more action against a repository. It
 * survives a restart, because "I quit the app" is not a decision to resume.
 *
 * Three things it deliberately does not do:
 *
 * It does not touch git. The worst day to start writing to someone's working
 * tree is the day they hit the emergency stop; the repositories are left
 * exactly where the agents left them, and the diff is the evidence.
 *
 * It does not pretend to stop a batch the API has already accepted. That work
 * is running on someone else's machine and no local switch reaches it, so the
 * state records the count and says so rather than reporting a stop it did not
 * perform.
 *
 * It does not clear itself. Clearing is a separate, deliberate action taken at
 * the Mac — a phone may pull the handle, because being away from the desk is
 * precisely when you need it, but deciding the danger has passed is not
 * something to do from a lock screen.
 *
 * Nothing in this module imports the things it stops. Callers register a
 * stopper the way the notification opener and the mobile control gate are
 * registered, which is what keeps a module every launch path must consult from
 * being a module that imports every launch path.
 */

const SETTING_KEY = 'halt';

/** How the handle was pulled. The phone may pull; only the Mac may clear. */
export type HaltSource = 'desktop' | 'phone' | 'automatic';

/**
 * What one subsystem reported stopping. A count and a noun, so the panel can
 * say "7 sessions, 3 autopilots" without this module knowing what either is.
 */
export type { HaltStopReport, HaltState };

const CLEAR: HaltState = { halted: false, at: null, reason: null, source: null, stopped: [] };

/**
 * A subsystem that can be stopped, and the noun it counts in.
 *
 * `stop` returns how many live things it ended. It must not throw: the whole
 * point of this path is that it completes on the worst day, and one subsystem
 * whose database is wedged cannot be allowed to leave the other six running.
 */
export type HaltStopper = {
  name: string;
  stop: () => HaltStopReport | Promise<HaltStopReport>;
};

const stoppers: HaltStopper[] = [];

/**
 * Register a subsystem with the stop path. Called once per subsystem at
 * startup, in the order they should be stopped: gates and dispatchers before
 * the processes they would otherwise immediately re-launch.
 */
export function registerHaltStopper(stopper: HaltStopper): void {
  if (stoppers.some((existing) => existing.name === stopper.name)) return;
  stoppers.push(stopper);
}

/** Exported for the offline suite, which asserts every subsystem is wired. */
export function haltStopperNames(): string[] {
  return stoppers.map((stopper) => stopper.name);
}

/**
 * Last answer from the database, kept so a read that fails still has one.
 *
 * The direction of that fallback is the whole point: if the settings row cannot
 * be read, this returns whatever it last knew rather than `false`. A halt that
 * silently lifts itself because SQLite was busy is the one failure mode this
 * module must not have.
 */
let known: HaltState = CLEAR;
let loaded = false;

/**
 * Set when the latch in memory is ahead of the row on disk.
 *
 * A read is not the only way the settings row goes unavailable, and it is not
 * the interesting one. A database that is full or has gone read-only — the
 * shape of bad day this handle exists for — still answers `SELECT` perfectly
 * while refusing every `INSERT`. Without this flag the sequence was: the pull
 * fails to persist, the in-memory latch is held for the length of the cache,
 * and then the next read succeeds, returns the row that was never written, and
 * lifts the halt. Nobody asked for that, nothing reports it, and the fleet
 * comes back on its own — which is the one failure mode named at the top of
 * this file as the one this module must not have.
 *
 * So while it is set, a stored row that disagrees is not allowed to clear a
 * halt this process pulled. It also marks the state as still owed to the
 * database, which is what makes the retry below worth attempting: the promise
 * that a halt survives a restart is only kept once the row is actually written.
 */
let unpersisted = false;

/**
 * How long a cached answer is trusted before the row is read again.
 *
 * This is read on the hook path — `policy.decideFor` runs on every PreToolUse,
 * for every tool call, from every live agent, and hooks.ts disables Nagle on
 * that socket to save forty milliseconds. An uncached `SELECT` per tool call is
 * a database round trip added to the one place in the app that was tuned in
 * tens of milliseconds.
 *
 * A second is the right size because of who writes this row. Inside this
 * process every write goes through `write()` below and refreshes the cache
 * immediately, so pulling the handle is instant for the app that pulled it. The
 * TTL exists only for the other writer — the windowless launchd scheduler runs
 * the same code in a second process — and a halt reaching that process up to a
 * second late is not a meaningful window: the pull also kills its PTYs.
 */
const CACHE_MS = 1_000;
let readAt = 0;

function parse(raw: string): HaltState {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return CLEAR; }
  if (!value || typeof value !== 'object') return CLEAR;
  const row = value as Partial<HaltState>;
  if (row.halted !== true) return CLEAR;
  const source = row.source === 'phone' || row.source === 'automatic' || row.source === 'desktop'
    ? row.source
    : null;
  return {
    halted: true,
    at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null,
    reason: typeof row.reason === 'string' ? row.reason.slice(0, 500) : null,
    source,
    stopped: Array.isArray(row.stopped)
      ? row.stopped.filter((entry): entry is HaltStopReport =>
        Boolean(entry) && typeof entry === 'object'
          && typeof (entry as HaltStopReport).name === 'string'
          && typeof (entry as HaltStopReport).stopped === 'number').slice(0, 20)
      : [],
  };
}

/** The latch, read through the database so another window cannot disagree. */
export function haltState(): HaltState {
  if (loaded && Date.now() - readAt < CACHE_MS) {
    return { ...known, stopped: known.stopped.map((entry) => ({ ...entry })) };
  }
  try {
    const stored = parse(getSetting(SETTING_KEY, ''));
    if (unpersisted && known.halted && !stored.halted) {
      // The row does not know about this halt because the write that would
      // have told it failed. Try again — a full disk gets emptied and a
      // read-only mount gets remounted — and either way keep the latch.
      try {
        setSetting(SETTING_KEY, JSON.stringify(known));
        unpersisted = false;
      } catch { /* still refusing writes; the in-memory latch stands */ }
    } else {
      known = stored;
      unpersisted = false;
    }
    loaded = true;
    readAt = Date.now();
  } catch {
    // Closed or busy during quit, which is exactly when the last poll cycle is
    // still asking. The previous answer is a better one than throwing, and a
    // better one than false.
  }
  return { ...known, stopped: known.stopped.map((entry) => ({ ...entry })) };
}

export function halted(): boolean {
  return haltState().halted;
}

function write(state: HaltState): void {
  known = state;
  loaded = true;
  // Stamped here so a pull or a clear is visible to this process on the very
  // next call rather than up to a second later. The cache above exists for the
  // other process, not for this one.
  readAt = Date.now();
  try {
    setSetting(SETTING_KEY, state.halted ? JSON.stringify(state) : '');
    unpersisted = false;
  } catch (error) {
    // Recorded before it is re-thrown, so a caller that swallows this — pullHalt
    // does, deliberately — still leaves the latch marked as owed to the row.
    unpersisted = true;
    throw error;
  }
}

/** Exported for the offline suite, which proves an unwritable row cannot lift a halt. */
export function haltPersisted(): boolean {
  return !unpersisted;
}

/**
 * Thrown by every guarded entry point. Its own class so a caller can tell "the
 * fleet is stopped" apart from "this particular launch was invalid", and so the
 * renderer can render it as the halt banner rather than as a random failure.
 */
export class HaltedError extends Error {
  readonly halted = true;
  constructor(what: string) {
    super(`Wanigan is halted, so it will not ${what}. Clear the halt in Wanigan to start work again.`);
    this.name = 'HaltedError';
  }
}

/**
 * The guard every launch path calls. `what` completes the sentence "it will
 * not …", so it reads as a verb phrase: 'start a session', 'fire a schedule'.
 */
export function refuseIfHalted(what: string): void {
  if (halted()) throw new HaltedError(what);
}

/**
 * Pull the handle.
 *
 * The latch is written *before* anything is stopped, and that order is the
 * load-bearing part. Stopping first leaves a window — however short — in which
 * an autopilot sweep or a queue tick can start something the stop pass has
 * already walked past, and the operator is then looking at a halted fleet with
 * one session in it that nobody can explain. Latching first means anything that
 * races is refused by the guard on its way in.
 *
 * Every stopper runs even if an earlier one fails, for the reason stated at the
 * top of the file: this has to complete on the worst day.
 */
export async function pullHalt(input: { reason?: string; source?: HaltSource } = {}): Promise<HaltState> {
  const at = Date.now();
  const source = input.source ?? 'desktop';
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 500)
    : null;

  // Latch first. See above.
  const pulled: HaltState = { halted: true, at, reason, source, stopped: [] };
  try {
    write(pulled);
  } catch {
    // The database refused the write. Hold it in memory anyway: for this
    // process the fleet is stopped, which is most of what was asked for, and a
    // halt that failed to persist is still better than one that did not happen.
    known = pulled;
    loaded = true;
  }

  const reports: HaltStopReport[] = [];
  for (const stopper of stoppers) {
    try {
      reports.push(await stopper.stop());
    } catch (error) {
      reports.push({
        name: stopper.name,
        stopped: 0,
        note: `did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
      });
    }
  }

  const settled: HaltState = { ...pulled, stopped: reports };
  try { write(settled); } catch { known = settled; }
  return haltState();
}

/**
 * Release it. Deliberately takes no arguments and records nothing: this is the
 * operator saying the danger has passed, and the interesting record is the pull.
 */
export function clearHalt(): HaltState {
  write(CLEAR);
  return haltState();
}
