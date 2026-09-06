import type http from 'node:http';
import { cancelHeadless, headlessRuns } from '../headless';
import type { HeadlessRun } from '../../shared/types';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';

/**
 * What this Mac is spending right now with nobody at the keyboard, and the one
 * write a paired device may make against it: stop it.
 *
 * A headless run is a fan-out — one prompt, many repositories, each with its own
 * agent process and its own CLI budget. It is the work in Wanigan that costs
 * money while the operator is asleep, on a train, or in a meeting, and until
 * this route the only way to end one was to walk back to the machine. That is
 * the whole reason this exists: of every write a phone could make, cancelling a
 * run that is burning tokens is the one with a number attached to not making it.
 *
 * The scope split is ./manage's, for ./manage's reason. Reading is 'monitor',
 * because a monitor that cannot say whether the Mac is spending money has a hole
 * in exactly the place someone opens it to look. Cancelling is 'control' and
 * POST, so the dispatcher's separate remote-control opt-in refuses it outright
 * when the operator has not enabled that, and it draws on the same
 * twenty-writes-a-minute window as launching an agent rather than an allowance
 * of its own.
 *
 * Deleting a run is deliberately absent and is not an unfinished build. A run
 * row is the only record that the work happened and what it cost; the desktop
 * already refuses to delete one that may still be spending, and a phone is a
 * worse place to make an irreversible decision about an audit trail than the
 * machine holding it. Cancelling stops the spend and keeps the record.
 *
 * The batch runs on the Batches screen are the other kind of unattended work
 * that spends money, and they are not here. shared/mobile-nav.ts gives them
 * their own destination ('batches' narrows the desktop's Batches tab) while this
 * markup composes into 'runs', and folding one screen's subject into another is
 * how a phone quietly stops being a view of the same product. Their cancel is
 * also a different promise — it reaches Anthropic over the network and leaves
 * the run 'canceling' until the remote batches wind down — which deserves its
 * own screen rather than a footnote on this one.
 */

/**
 * How far back the run list is read. The desktop's own Runs view asks for the
 * same fifty on a three-second poll, so this is a cost the main process already
 * pays whenever that screen is open rather than a new one — and it is read
 * rather than cached, because a cancel has to be visible in the very next poll.
 */
const RUN_READ_LIMIT = 50;

/** A cap on what one response carries; the page is a phone on a radio. */
const MAX_LIVE_RUNS = 12;

/**
 * What the phone is told when the run records will not open. It names the two
 * facts the page cannot establish on its own — the Mac was reached, and nothing
 * was written — rather than restating the failure the page already prints above
 * it. A database error can carry a local path or a table name, so it does not
 * travel.
 */
const READ_FAILED = 'The Mac answered, but its record of the runs would not open. Nothing has been changed.';

/**
 * The run states, as a closed set the page can render.
 *
 * 'canceling' is on this list and matters more than the rest. `cancelHeadless`
 * writes it and leaves it there: a repository whose agent is already running
 * closes itself out through its own exit path, so the run stays in this state
 * for as long as the agents take to die. A wire shape that could not say
 * 'canceling' would have the phone reporting a run as stopped the instant
 * someone tapped, which is the one thing a cancel button must never do.
 *
 * 'unknown' is the other value that must not be smoothed away. It is what a
 * status this build has never been taught to read becomes, and the honest
 * answer for such a run is that Wanigan recorded a state this screen cannot
 * name — never one of the four it happens to recognise.
 */
export type MobileRunStatus =
  | 'submitting' | 'in_progress' | 'canceling' | 'ended' | 'failed' | 'unknown';

export type MobileRun = {
  id: string;
  name: string;
  /** The agent model the fan-out was started with, never a path or a prompt. */
  model: string;
  status: MobileRunStatus;
  /** Whether this run still has work in Wanigan's hands. */
  live: boolean;
  /** Whether a cancel from this device would actually reach something. */
  cancelable: boolean;
  /** What the agents that have finished reported, in dollars. */
  costUsd: number;
  /** How complete that figure is over the repositories that have *finished*. */
  costStatus: HeadlessRun['costStatus'];
  /**
   * Whether any repository is still running.
   *
   * Separate from costStatus on purpose, because the two answer different
   * questions and collapsing them loses the one a phone is for. costStatus is
   * the desktop's own reading over finished repositories, and it says
   * 'reported' for a run where nothing has finished yet — which is true of the
   * empty set and catastrophic as a caption, since it would print $0.00 beside
   * three agents that are spending money at that moment. While this is false
   * the figure is a floor, and the page says so.
   */
  costFinal: boolean;
  succeeded: number;
  failed: number;
  blocked: number;
  /** Repositories queued or running: what a cancel would reach. */
  open: number;
  filesChanged: number;
  startedAt: number;
  endedAt: number | null;
};

export type MobileRunsPayload = {
  generatedAt: number;
  /** Only the runs still in flight — capped, newest first. */
  runs: MobileRun[];
  /** Live runs before the cap, so a truncated list can say it is one. */
  liveCount: number;
  truncated: boolean;
  /**
   * The newest run that is no longer in flight, or null when there is none.
   *
   * It is here so the empty state can tell its two cases apart. "Nothing is
   * running" over a Mac that has run twenty fan-outs this week and over a Mac
   * that has never run one are different facts, and a screen that renders them
   * identically is the empty-fleet-on-a-sleeping-Mac problem wearing another
   * name.
   */
  latest: MobileRun | null;
};

/**
 * The stored statuses, mapped onto what the phone is allowed to claim.
 *
 * A Map rather than an object literal for the reason ./manage and ./control
 * both give: a status read out of a row is a string, and `toString` or
 * `constructor` resolving to something inherited from Object.prototype would be
 * a lookup hit that never came from this table.
 *
 * It is keyed on `string` rather than on HeadlessRun['status'] because that
 * union is a lie by omission — headlessRuns() casts the column straight to it,
 * and 'canceling', which cancelHeadless writes, is not one of its four members.
 * Reading the column back as the string it is, and narrowing here, is what
 * keeps a cancelled run from arriving on the wire as an unlisted value.
 */
const RUN_STATUSES = new Map<string, MobileRunStatus>([
  ['submitting', 'submitting'],
  ['in_progress', 'in_progress'],
  ['canceling', 'canceling'],
  ['ended', 'ended'],
  ['failed', 'failed'],
]);

/** Statuses that mean Wanigan still considers this run its business. */
const IN_FLIGHT: ReadonlySet<MobileRunStatus> = new Set(['submitting', 'in_progress', 'canceling']);

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

/**
 * Rebuilt field by field, like every other response that leaves this process.
 *
 * Two fields on HeadlessRun are deliberately not among them. The prompt is not
 * on the run summary at all, and `error` is never written for a headless run —
 * the column exists for the batch runs that share the table — so carrying it
 * would put a field on the wire that can only ever be null here and would
 * become a channel for a stack trace the day somebody starts filling it in.
 */
function wireRun(run: HeadlessRun): MobileRun {
  const raw = run as HeadlessRun & Record<string, unknown>;
  const status = RUN_STATUSES.get(String(raw.status)) ?? 'unknown';
  const open = count(raw.open);
  return {
    id: safeString(raw.id, 120),
    name: safeString(raw.name, 160, 'Unnamed run'),
    model: safeString(raw.model, 120, 'unnamed model'),
    status,
    // The `|| open > 0` is not belt and braces. A run whose recorded status this
    // build cannot name is exactly the run somebody needs to find on this
    // screen, and dropping it because the word was unfamiliar would hide a
    // fan-out that is still spending from the surface built to stop it.
    live: IN_FLIGHT.has(status) || open > 0,
    // Not derived from the status, because cancelHeadless is not either: it
    // acts on the queued and running rows, whatever the run row says above
    // them. Already-stopping is the one exclusion, so that tapping twice cannot
    // read as "the first tap did nothing".
    cancelable: open > 0 && status !== 'canceling',
    costUsd: Math.max(0, finite(raw.costUsd)),
    costStatus: raw.costStatus === 'partial' || raw.costStatus === 'unreported' ? raw.costStatus : 'reported',
    costFinal: open === 0,
    succeeded: count(raw.succeeded),
    failed: count(raw.failed),
    blocked: count(raw.blocked),
    open,
    filesChanged: count(raw.filesChanged),
    startedAt: count(raw.createdAt),
    endedAt: raw.endedAt === null ? null : finite(raw.endedAt, 0) || null,
  };
}

function serveRuns(res: http.ServerResponse): void {
  try {
    const runs = headlessRuns(RUN_READ_LIMIT).map(wireRun);
    const live = runs.filter((run) => run.live);
    json(res, 200, {
      generatedAt: Date.now(),
      runs: live.slice(0, MAX_LIVE_RUNS),
      liveCount: live.length,
      truncated: live.length > MAX_LIVE_RUNS,
      latest: runs.find((run) => !run.live) ?? null,
    } satisfies MobileRunsPayload);
  } catch {
    json(res, 503, { error: READ_FAILED });
  }
}

/**
 * Why this run cannot be stopped, in the words the page prints, or null when it
 * can be.
 *
 * Both branches are refusals rather than quiet successes. Answering "ok" to a
 * cancel that reached nothing is how an operator ends up believing they stopped
 * something they did not, which on this particular screen is a bill.
 */
function whyNotStoppable(run: MobileRun): string | null {
  if (run.cancelable) return null;
  if (run.status === 'canceling') {
    return 'That run is already stopping. Wanigan has asked its agents to quit and is waiting for them to go.';
  }
  return 'Nothing on that run is still running, so there is nothing left to stop.';
}

/**
 * Cancel one headless run.
 *
 * The id arrives from a browser and is untrusted until this process has agreed
 * on it, so it is matched against the same `headlessRuns()` list the device was
 * shown before anything is signalled. That is not only a guard against a
 * malformed string: the runs table also holds the batch runs, whose cancel
 * reaches the Anthropic API over the network and is a different promise
 * entirely, and a membership test against the headless list is what keeps a
 * string from this route from reaching one of those.
 *
 * The stop itself is ../headless's `cancelHeadless` and never SQL of this
 * module's own. That function signals the live process trees, escalates to
 * SIGKILL on a grace timer, marks only the rows that had no agent to kill, and
 * writes the log line the operator audits. A second implementation here would
 * be a second set of those rules, and the one that ran from a pocket would be
 * the one nobody read.
 *
 * What comes back is the run re-read from the database, never a description of
 * what was asked for. A repository whose agent is running closes itself out
 * through its own exit path, so the run is still 'canceling' when this returns
 * and the honest answer is "stopping", not "stopped". The page says whichever
 * of those the Mac actually reports.
 */
async function serveCancel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 2_048);
  const action = typeof body?.action === 'string' ? body.action : '';
  if (action !== 'cancel') {
    json(res, 400, { error: 'Cancelling is the only change this device can make to a run.' });
    return;
  }
  const id = safeString(body?.id, 120);
  if (!id) { json(res, 400, { error: 'Choose a run.' }); return; }

  let before: MobileRun | undefined;
  try {
    before = headlessRuns(RUN_READ_LIMIT).map(wireRun).find((run) => run.id === id);
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }
  if (!before) {
    json(res, 404, { error: 'That is not a run this device can cancel.' });
    return;
  }
  const refusal = whyNotStoppable(before);
  if (refusal) {
    // 409 rather than 400: the request is well formed and the id is real, and
    // what is wrong is the state of the run on the Mac. The page tells the two
    // apart so it can say "already stopping" instead of "bad request".
    json(res, 409, { error: refusal });
    return;
  }

  let reached = 0;
  try {
    reached = cancelHeadless(id);
  } catch (error) {
    json(res, 400, {
      error: safeString(error instanceof Error ? error.message : String(error), 240,
        'Wanigan refused that cancellation.'),
    });
    return;
  }

  let after: MobileRun | null = null;
  try {
    after = headlessRuns(RUN_READ_LIMIT).map(wireRun).find((run) => run.id === id) ?? null;
  } catch {
    // The stop already happened; a read that fails after it is not a reason to
    // report a failure. The page has a branch for a 200 that carries no run,
    // and it claims nothing about the outcome.
    after = null;
  }
  // "reached", not "stopped". cancelHeadless counts the agents it signalled
  // plus the queued repositories it dropped, and a signalled agent is one that
  // has been asked to quit rather than one that has gone.
  json(res, 200, { ok: true, reached, run: after });
}

registerApiRoute({
  path: '/api/runs',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveRuns(res),
});

registerApiRoute({
  path: '/api/runs',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => serveCancel(req, res),
});
