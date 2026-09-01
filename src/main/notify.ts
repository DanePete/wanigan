import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import { db, resultsDir } from './db';
import { getSetting, setSetting } from './settings';
import { sendMobilePush } from './mobile';
import type { MobilePushResult } from './mobile';
import type { Attention, AttentionKind } from '../shared/types';

/**
 * Telling the human something happened, and knowing when to look.
 *
 * The Batches API can call a completion webhook — HMAC-signed, retried for a
 * day — and it is genuinely better than polling for anything with a public
 * URL. Wanigan does not have one. Receiving one on a laptop means the user
 * standing up a public tunnel and keeping it up, and it means this app opening
 * a webhook receiver to the internet. The separately opt-in phone dashboard is
 * not that: it is read-only, bearer-authenticated, bound to loopback, and can
 * only be carried to another device by the operator's private reverse proxy.
 * A webhook receiver used to sit at the bottom of this file, unreachable from
 * anywhere in the app and attached to no promise made to anyone. It is gone,
 * and polling is the whole answer.
 *
 * The reason that trade is safe is worth writing down, because it is the
 * opposite of the usual one: the failure mode that loses batches here is not a
 * missed webhook, it is a CLOSED APP. Batches advance on a timer inside the
 * main process, so quitting Wanigan stops the clock — while the API's 24-hour
 * processing expiry keeps running, and the 29-day results window keeps running
 * after that. A webhook fired at a laptop that is asleep is discarded just as
 * completely as a poll that was never made. What actually protects the work is
 * a poll schedule that knows where it is in those two clocks and tightens up at
 * the moments where the difference between 'ended' and 'expired' gets decided,
 * plus surfacing both deadlines so the human can reopen the app in time.
 *
 * The other half of the file is the promise the Settings toggle makes. It
 * defaults ON, so every announce below has to actually reach the OS or the
 * toggle is decoration — Wanigan spent a while in exactly that state, with
 * three announce functions nothing called. Which states are worth interrupting
 * a human for is therefore decided here rather than at the call sites: a caller
 * that forgot to filter would either say nothing at all or say everything, and
 * of those two the second is worse, because it is the one that gets the whole
 * feature switched off.
 */

/* ── the two clocks ──────────────────────────────────────────────────── */

/** A batch stops processing 24 hours after creation, finished or not. */
export const BATCH_TTL_MS = 24 * 60 * 60_000;

/**
 * Results stay downloadable for 29 days after the batch was created. This is
 * the clock people actually lose data to: the batch succeeded, the run went
 * green, and the .jsonl was never pulled down — by the time anyone goes looking
 * the window closed weeks ago and there is nothing left to re-download.
 */
export const RESULTS_TTL_MS = 29 * 24 * 60 * 60_000;

/* ── poll schedule ───────────────────────────────────────────────────── */

/** Floor. Below this the request rate costs more than the latency it buys. */
export const POLL_TIGHT_MS = 10_000;
/** Ceiling. Two minutes of ignorance is the most a batch is allowed to have. */
export const POLL_CEILING_MS = 120_000;
/**
 * How long a batch may sit unchanged before the interval starts widening.
 * An hour, because most batches land inside one — widening earlier trades real
 * latency on the common case for savings on the rare one.
 */
export const POLL_QUIET_GRACE_MS = 60 * 60_000;
/** Every step of quiet past the grace period doubles the interval. */
export const POLL_WIDEN_STEP_MS = 15 * 60_000;
/**
 * The last stretch before expiry, where the schedule goes tight again no matter
 * how long the batch has been silent. This is the window in which 'ended' and
 * 'expired' are decided, and the two outcomes are not close: one has results,
 * the other has nothing to download and a dead-letter queue.
 */
export const EXPIRY_ENDGAME_MS = 30 * 60_000;

/** Default lookahead for expiringSoon: long enough to notice, short enough to mean it. */
export const EXPIRY_WARNING_MS = 60 * 60_000;
/** Default lookahead for resultsExpiring. A week survives a holiday. */
export const RESULTS_WARNING_MS = 7 * 24 * 60 * 60_000;

/* ── notification plumbing ───────────────────────────────────────────── */

const SETTING_KEY = 'notifications';

/**
 * Which session states are worth taking a human away from something else, and
 * which of those are worth a sound.
 *
 * Keyed on AttentionKind and not on the word from ATTENTION_LABEL, which is
 * what this used to match against. The label is display text — one word, chosen
 * to stay distinct in a truncated rail — and it is going to get reworded at some
 * point by somebody working on the rail. A set of strings matched against it
 * fails silently when that happens: 'Asking' stops being urgent, permission
 * prompts go quiet, and nothing anywhere reports an error. The kind is the enum
 * the classifier actually decided on, and renaming a label cannot move it.
 *
 * Idle and working are absent on purpose. Idle flips on a 90-second threshold
 * and would fire for every agent that pauses to think; working fires
 * constantly. Either one turns the toggle off for good, and it takes the
 * permission prompt — the one alert that is genuinely blocking work — with it.
 */
const ANNOUNCE_KINDS = new Set<AttentionKind>(['permission', 'error', 'finished']);
const URGENT_KINDS = new Set<AttentionKind>(['permission', 'error']);

const RUN_ENDED_DEDUPE_MS = 6 * 60 * 60_000;
const CAP_DEDUPE_MS = 5 * 60_000;
const ATTENTION_RETRY_MS = 30_000;
const MAX_DEDUPE_KEYS = 500;

/* ── the switch ──────────────────────────────────────────────────────── */

/**
 * Last answer from the database, kept so a read that fails still has one.
 * Deliberately not a cache in front of the read: Settings writes this key
 * through settings.ts too, and a value that only refreshed when this module
 * wrote it would leave the toggle looking broken.
 */
let lastKnownEnabled = true;

export function notificationsEnabled(): boolean {
  try {
    lastKnownEnabled = getSetting(SETTING_KEY, '1') === '1';
  } catch {
    // The database is closed — which happens during quit, exactly when the last
    // poll cycle is trying to report what it found. The previous answer is a
    // better one than throwing out of a notification call.
  }
  return lastKnownEnabled;
}

export function setNotificationsEnabled(on: boolean): void {
  lastKnownEnabled = on;
  try {
    setSetting(SETTING_KEY, on ? '1' : '0');
  } catch {
    // Same story: the toggle still takes effect for this process even if it
    // could not be written down.
  }
}

/* ── notify ──────────────────────────────────────────────────────────── */

/**
 * Electron collects a Notification whose only reference was the local that
 * built it, and a collected one never fires its click handler. Held until the
 * OS is done with it.
 */
const live = new Set<Notification>();

export function notify(opts: {
  title: string;
  body: string;
  /** Redacted alternative when desktop detail contains a command or path. */
  mobileBody?: string;
  urgent?: boolean;
  onClick?: () => void;
  /** Internal sink controls let attention suppress only the Mac banner. */
  desktop?: boolean;
  mobile?: boolean;
  onMobileResult?: (result: MobilePushResult) => void;
  /**
   * Keep this for the attended app when the process showing it has no window.
   * Opt-in per call, and never set for anything carrying agent detail — see
   * `hold()` for why the digest is allowed so much less than a banner is.
   */
  hold?: boolean;
}): void {
  // Phone delivery is its own opt-in. A user may reasonably turn off banners
  // on the Mac while keeping the alert that lets them leave the room, so the
  // desktop toggle must not gate this sink. Delivery is bounded and failures
  // are recorded by mobile.ts; a network service never sits in the hook path.
  if (opts.mobile !== false) {
    void sendMobilePush({
      title: opts.title,
      body: opts.mobileBody ?? opts.body,
      urgent: opts.urgent === true,
    }).then(
      (result) => opts.onMobileResult?.(result),
      () => opts.onMobileResult?.({
        at: Date.now(), ok: false, skipped: false, retryable: true,
        httpStatus: null, error: 'Mobile push failed.',
      }),
    );
  }

  if (opts.desktop === false || !notificationsEnabled()) return;

  // The launchd scheduler is this same app with no window: a banner it shows
  // has nothing to raise and nobody in front of it, and the operator finds out
  // about a night of failures whenever they next happen to look. Held instead,
  // and handed over the moment an attended Wanigan opens a window.
  if (opts.hold && !hasWindow()) {
    hold({ at: Date.now(), title: opts.title, body: opts.body, urgent: opts.urgent === true });
    return;
  }

  try {
    // isSupported() is false on a Linux box with no notification daemon, and
    // the constructor itself throws before the app is ready.
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;

    const n = new Notification({
      title: opts.title,
      body: opts.body,
      // Only urgent things make a noise. Wanigan has a lot to say across a long
      // day, and an app that pings for every finished batch is an app whose
      // notifications get switched off wholesale — which costs the user the one
      // alert that actually mattered.
      silent: !opts.urgent,
      urgency: opts.urgent ? 'critical' : 'normal',
      timeoutType: opts.urgent ? 'never' : 'default',
    });

    const release = () => { live.delete(n); };
    n.on('close', release);
    n.on('failed', release);
    n.on('click', () => {
      release();
      try {
        opts.onClick?.();
      } catch {
        // A handler that throws must not surface as an unhandled error from
        // inside Electron's notification callback.
      }
    });
    live.add(n);
    n.show();
  } catch {
    // A notification is commentary on the work, never the work. This is called
    // from inside the poll loop, and a platform that refuses to show one must
    // not be able to abort the cycle that is keeping a batch moving.
  }
}

/** A notification you can click that does nothing is a dead end. */
function focusWanigan(): void {
  try {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  } catch {
    // No window yet, or the app is on its way out.
  }
}

function hasWindow(): boolean {
  try {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
  } catch {
    // Before `ready`, or during teardown. Treated as "no window", which is the
    // direction that keeps a notification rather than losing it.
    return false;
  }
}

/* ── where a click lands ─────────────────────────────────────────────── */

/**
 * What the banner was about, so that clicking it arrives somewhere.
 *
 * Every announcement used to raise the window and stop there, which means an
 * urgent "Asking — mnair-shop" put the operator on whichever tab happened to
 * be open — with the same number of clicks left to find the blocked agent as
 * if they had never been told. The identity was known at the moment the
 * notification was built and thrown away one line later; this carries it.
 */
export type NotificationTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'run'; runId: string };

let opener: ((target: NotificationTarget) => void) | null = null;

/**
 * Registered by whoever owns the renderer. Notifications keep working without
 * one — the window still comes forward — so a build that has not wired the
 * route yet degrades to what this file did before rather than throwing.
 */
export function setNotificationOpener(fn: ((target: NotificationTarget) => void) | null): void {
  opener = fn;
}

function reveal(target?: NotificationTarget): () => void {
  return () => {
    focusWanigan();
    if (!target || !opener) return;
    try {
      opener(target);
    } catch {
      // The window is already up, which is most of what the click was for. A
      // renderer that cannot be navigated must not surface as an error from
      // inside Electron's notification callback.
    }
  };
}

/* ── what a windowless process holds ─────────────────────────────────── */

/**
 * Notifications a process with no window kept for the attended app.
 *
 * Deliberately small and deliberately dull. This is the one sink that writes a
 * notification's text to disk, so nothing carrying agent detail is allowed in
 * — attention bodies can contain a shell command or a file name, and the
 * promise made at `announceAttention` is that those reach the OS and nowhere
 * else. Run summaries are counts, a name the operator chose and a cost, and
 * those are already in the database this is stored in.
 */
const DIGEST_KEY = 'notifications.held';
const DIGEST_MAX = 50;
/** Past this a held banner is archaeology, not news. */
const DIGEST_TTL_MS = 7 * 24 * 60 * 60_000;

type HeldNotification = { at: number; title: string; body: string; urgent: boolean };

function readDigest(): HeldNotification[] {
  let raw: string;
  try {
    raw = getSetting(DIGEST_KEY, '[]');
  } catch {
    // Same reason notificationsEnabled() keeps its last answer: the database
    // is closed during quit, which is when the last cycle is still reporting.
    return [];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const cutoff = Date.now() - DIGEST_TTL_MS;
  const out: HeldNotification[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < cutoff) continue;
    if (typeof e.title !== 'string' || typeof e.body !== 'string') continue;
    out.push({ at: e.at, title: e.title, body: e.body, urgent: e.urgent === true });
  }
  return out;
}

function writeDigest(entries: HeldNotification[]): void {
  try {
    setSetting(DIGEST_KEY, JSON.stringify(entries));
  } catch {
    // A held notification is a courtesy to the next launch, never the record
    // of the work — that is already in runs, headless_rows and schedule_runs.
  }
}

function hold(entry: HeldNotification): void {
  // Oldest first out. A month of nightly runs against a Mac nobody opened must
  // not grow a settings row without bound.
  writeDigest([...readDigest(), entry].slice(-DIGEST_MAX));
}

let draining = false;

/**
 * Show what a windowless process kept, as one banner rather than a burst.
 *
 * One is the point: the toggle survives because Wanigan interrupts rarely, and
 * eleven banners at login is exactly the morning that gets it switched off.
 * The phone sink already delivered these at the time they happened, so this
 * does not push again.
 */
export function drainNotificationDigest(): number {
  if (draining) return 0;
  draining = true;
  try {
    const held = readDigest();
    // Cleared whether or not it can be shown: a banner that could not be
    // displayed is not worth re-offering at every window for a week.
    if (held.length) writeDigest([]);
    if (!held.length || !notificationsEnabled()) return 0;

    const names = held.map((h) => h.title);
    notify({
      title: held.length === 1
        ? held[0].title
        : `${held.length} unattended runs finished while Wanigan was closed`,
      body: held.length === 1
        ? `${held[0].body} · ${whenHeld(held[0].at)}`
        : `${names.slice(0, 3).join('; ')}${names.length > 3 ? `; and ${names.length - 3} more` : ''}`,
      urgent: held.some((h) => h.urgent),
      // Delivered by the process that held them, at the time they happened.
      mobile: false,
      onClick: reveal(),
    });
    return held.length;
  } finally {
    draining = false;
  }
}

function whenHeld(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return new Date(at).toLocaleString();
}

// Wired here rather than at a start-up call site because the process that
// needs the drain is the one that has no start-up call site for it: a window
// appearing is the only signal that an attended Wanigan is present to read
// what the scheduler left.
try {
  app.on('browser-window-created', () => {
    try {
      drainNotificationDigest();
    } catch (error) {
      console.warn('[wanigan] could not show held notifications:', error);
    }
  });
} catch {
  // `app` is unavailable in a context that imported this module for its pure
  // schedule maths. Nothing else in the file depends on the listener.
}

/* ── what the operator is already looking at ─────────────────────────── */

/**
 * The session on screen, as last reported by the renderer. Null when no session
 * is selected, which is most of the app.
 */
let watchedSessionId: string | null = null;

export function setWatchedSession(sessionId: string | null): void {
  watchedSessionId = sessionId;
}

/**
 * Whether telling the human about this session would be telling them something
 * they can already see.
 *
 * Both halves are required, and each one alone gets it wrong in a different
 * direction. The renderer keeps reporting its selected session after you switch
 * to another app — it has no reason not to — so the id alone would silence
 * exactly the notification that matters most: you walked away with that session
 * open, which is the entire scenario desktop notifications exist for. Window
 * focus alone is no better: you can be sitting in Batches with the window front
 * and centre while a different agent blocks on a permission prompt you cannot
 * see.
 *
 * Deliberately fails open. If the window cannot be asked whether it is focused,
 * the notification goes out — a redundant ping costs a glance, a suppressed one
 * costs however long the agent sits there waiting.
 */
function alreadyOnScreen(sessionId: string): boolean {
  if (watchedSessionId !== sessionId) return false;
  try {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  } catch {
    return false;
  }
}

/* ── the schedule ────────────────────────────────────────────────────── */

/**
 * How long to wait before asking about this batch again, in milliseconds.
 *
 * Pure, and it takes its clock as an argument: the interesting cases are hour
 * nineteen and the last ten minutes before expiry, and those have to be
 * testable without a database, a network or a fake timer.
 *
 * `lastChangedAt` is when the batch's status or counts last actually moved, not
 * when it was last polled. Polling proves nothing about progress, and a
 * schedule that widened on "time since we last asked" would never widen at all.
 * Null means nothing has moved since it was created.
 */
export function pollIntervalFor(batchCreatedAt: number, lastChangedAt: number | null, nowMs: number = Date.now()): number {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const created = Number.isFinite(batchCreatedAt) ? batchCreatedAt : now;

  // The endgame outranks everything below. Once expiry is close the only
  // question left is which of the two outcomes this batch gets, so pay the
  // extra requests — and keep paying past the deadline, because the transition
  // still has to be observed before the run can be closed out honestly.
  if (created + BATCH_TTL_MS - now <= EXPIRY_ENDGAME_MS) return POLL_TIGHT_MS;

  // Quiet time, not age. A twelve-hour-old batch that reported new counts a
  // minute ago is moving and deserves the tight interval; a twenty-minute-old
  // one that has never reported anything does not get to be treated as fresh
  // forever. A change resets this to zero, which is what "reset to tight
  // whenever something changed" means in one expression rather than a branch.
  const moved = lastChangedAt !== null && Number.isFinite(lastChangedAt)
    ? Math.min(lastChangedAt, now)
    : created;
  const quiet = Math.max(0, now - Math.max(created, moved));

  if (quiet <= POLL_QUIET_GRACE_MS) return POLL_TIGHT_MS;

  // Doubling per step past the grace period: 10s at one hour, 20s at 1h15,
  // 40s at 1h30, 80s at 1h45, ceiling by two hours. Progressive rather than a
  // cliff, so a batch that wakes up at 1h20 is not being watched at two-minute
  // resolution the moment it starts moving again.
  const steps = (quiet - POLL_QUIET_GRACE_MS) / POLL_WIDEN_STEP_MS;
  return Math.round(Math.min(POLL_CEILING_MS, POLL_TIGHT_MS * Math.pow(2, steps)));
}

/* ── clock one: processing expiry ────────────────────────────────────── */

export type ExpiringBatch = { runId: string; runName: string; batchId: string; expiresAt: number };

/**
 * Batches whose 24-hour processing window closes inside `withinMs`.
 *
 * Only ones still ahead of their deadline. A batch already past expires_at is
 * not approaching anything — expireStale() in batch/poll.ts closes it out
 * within the minute — and listing it here would pin it to the banner forever on
 * exactly the occasion the poller is not running to clear it.
 */
export function expiringSoon(withinMs: number = EXPIRY_WARNING_MS): ExpiringBatch[] {
  const now = Date.now();
  try {
    return db().prepare(`
      SELECT b.run_id runId, r.name runName, b.id batchId, b.expires_at expiresAt
      FROM batches b JOIN runs r ON r.id = b.run_id
      WHERE b.processing_status != 'ended'
        AND b.expires_at IS NOT NULL
        AND b.expires_at > ? AND b.expires_at <= ?
      ORDER BY b.expires_at ASC
    `).all(now, now + Math.max(0, withinMs)) as ExpiringBatch[];
  } catch {
    // Read for a banner. A closed or busy database is not worth taking a poll
    // cycle down for; the next tick asks again.
    return [];
  }
}

/* ── clock two: results expiry ───────────────────────────────────────── */

export type ExpiringResults = { runId: string; runName: string; endedAt: number; downloadableUntil: number };

/**
 * Finished runs whose results stop being downloadable inside `withinMs`.
 *
 * A separate and much longer clock than expiringSoon, and the dangerous one
 * precisely because it is slow: the batch succeeded a month ago, the run reads
 * as ended, and nothing about the UI suggests a deadline is running. The 29
 * days count from batch creation, not from when the batch ended, so a batch
 * that took twenty hours to run has already burned a day of it.
 *
 * Only runs with something still to lose are listed — a batch whose .jsonl is
 * already archived on this machine cannot expire out from under anyone. That
 * check is also what catches the case nobody would think to look for: a batch
 * expireStale() marked ingested without ever writing a file.
 */
export function resultsExpiring(withinMs: number = RESULTS_WARNING_MS): ExpiringResults[] {
  const now = Date.now();
  type Row = { batchId: string; runId: string; runName: string; endedAt: number; createdAt: number };
  let rows: Row[];
  try {
    rows = db().prepare(`
      SELECT b.id batchId, b.run_id runId, r.name runName, r.ended_at endedAt, b.created_at createdAt
      FROM batches b JOIN runs r ON r.id = b.run_id
      WHERE r.ended_at IS NOT NULL
        AND b.created_at > ? AND b.created_at <= ?
      ORDER BY b.created_at ASC
    `).all(now - RESULTS_TTL_MS, now + Math.max(0, withinMs) - RESULTS_TTL_MS) as Row[];
  } catch {
    return [];
  }

  // One line per run, carrying the earliest deadline among the batches still
  // only held server-side — that is the date after which the run's results are
  // incomplete, which is the date worth showing.
  const byRun = new Map<string, ExpiringResults>();
  for (const row of rows) {
    if (haveLocalCopy(row.batchId)) continue;
    const downloadableUntil = row.createdAt + RESULTS_TTL_MS;
    const seen = byRun.get(row.runId);
    if (!seen || downloadableUntil < seen.downloadableUntil) {
      byRun.set(row.runId, { runId: row.runId, runName: row.runName, endedAt: row.endedAt, downloadableUntil });
    }
  }
  return [...byRun.values()].sort((a, b) => a.downloadableUntil - b.downloadableUntil);
}

/**
 * Whether this batch's results are already on this machine.
 *
 * Size decides, not existence: a zero-byte archive is what an ingest that died
 * mid-stream leaves behind, and by presence alone it is indistinguishable from
 * a complete one — which would silently drop the run off the warning list at
 * the exact moment it needs to be on it.
 */
function haveLocalCopy(batchId: string): boolean {
  try {
    return fs.statSync(path.join(resultsDir(), `${batchId}.jsonl`)).size > 0;
  } catch {
    return false;
  }
}

/* ── announcements ───────────────────────────────────────────────────── */

const said = new Map<string, number>();

/**
 * Attention is a state transition, not a five-minute bucket. The classifier
 * carries the exact hook-event or PTY-exit identity: repeated refreshes keep it,
 * while a second permission prompt or completed turn gets a new value even if
 * it follows seconds later. Each sink claims independently because looking at
 * a session may suppress its Mac banner but must never suppress the phone alert.
 */
const attentionSaid = new Map<string, {
  transitionId: string;
  state: 'pending' | 'sent' | 'failed' | 'rejected';
  at: number;
}>();

/** Reconsider current transitions after the operator changes phone delivery. */
export function resetMobileAttentionDelivery(): void {
  for (const key of attentionSaid.keys()) {
    if (key.startsWith('mobile:')) attentionSaid.delete(key);
  }
}

function claimAttention(
  sink: 'desktop' | 'mobile',
  a: Attention,
): boolean {
  const key = `${sink}:${a.sessionId}:${a.kind}`;
  const previous = attentionSaid.get(key);
  const now = Date.now();
  if (previous?.transitionId === a.transitionId) {
    if (sink === 'desktop' || previous.state !== 'failed' || now - previous.at < ATTENTION_RETRY_MS) {
      return false;
    }
  }
  if (attentionSaid.size > MAX_DEDUPE_KEYS * 2) {
    for (const [k, value] of attentionSaid) {
      if (now - value.at > RUN_ENDED_DEDUPE_MS) attentionSaid.delete(k);
    }
  }
  attentionSaid.set(key, {
    transitionId: a.transitionId,
    state: sink === 'mobile' ? 'pending' : 'sent',
    at: now,
  });
  return true;
}

function settleMobileAttention(a: Attention, result: MobilePushResult): void {
  const key = `mobile:${a.sessionId}:${a.kind}`;
  const current = attentionSaid.get(key);
  if (current?.transitionId !== a.transitionId) return;
  attentionSaid.set(key, {
    ...current,
    // A disabled sink has not consumed the transition: if the operator enables
    // phone alerts while a prompt is still waiting, the periodic attention
    // check should deliver it. Both skips and network failures retry locally
    // after the same bounded backoff; only an accepted ntfy publish is final.
    state: result.ok ? 'sent' : result.retryable ? 'failed' : 'rejected',
    at: Date.now(),
  });
}

/**
 * True the first time this key comes up inside `windowMs`, false for a repeat.
 *
 * The poll loop revisits the same run every tick, so without this a run that
 * ended would be announced every ten seconds until the user closed the app.
 */
function claim(key: string, windowMs: number): boolean {
  const now = Date.now();
  const last = said.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  if (said.size > MAX_DEDUPE_KEYS) {
    // Wanigan stays open for weeks. Drop keys nothing could still be
    // deduplicating against rather than growing for the life of the process.
    for (const [k, at] of said) if (now - at > RUN_ENDED_DEDUPE_MS) said.delete(k);
  }
  said.set(key, now);
  return true;
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Failures first: an OS notification truncates the tail, never the head. */
const STATUS_ORDER = ['errored', 'expired', 'canceled', 'pending', 'succeeded'];
/**
 * The same idea for a fan-out, whose rows are repositories rather than
 * requests. 'blocked' is a failure and reads like one: it is a repository the
 * trust level refused to run, which is a decision the operator has to see.
 */
const ROW_STATUS_ORDER = ['errored', 'timeout', 'blocked', 'canceled', 'running', 'pending', 'succeeded'];
const BAD_STATUSES = new Set(['errored', 'expired', 'timeout', 'blocked']);

/**
 * A run reached its end state.
 *
 * Both shapes of run land here, and they count different tables: a batch's
 * outcome is its requests, a headless fan-out's is one row per repository.
 * Reading `requests` for a fan-out was not a smaller answer, it was a wrong
 * one — no rows at all, rendered as "No results · $0.00" for twelve repos
 * that had just spent an hour working.
 */
export function announceRunEnded(runId: string): void {
  if (!claim(`run:${runId}`, RUN_ENDED_DEDUPE_MS)) return;

  let run: { name: string; cost_usd: number; kind: string } | undefined;
  let counts: { status: string; n: number }[];
  try {
    const d = db();
    run = d.prepare('SELECT name, cost_usd, kind FROM runs WHERE id = ?').get(runId) as typeof run;
    counts = run?.kind === 'headless'
      ? d.prepare('SELECT status, COUNT(*) n FROM headless_rows WHERE run_id = ? GROUP BY status')
        .all(runId) as { status: string; n: number }[]
      : d.prepare('SELECT status, COUNT(*) n FROM requests WHERE run_id = ? GROUP BY status')
        .all(runId) as { status: string; n: number }[];
  } catch {
    return;
  }
  if (!run) return;

  const order = run.kind === 'headless' ? ROW_STATUS_ORDER : STATUS_ORDER;
  counts.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const bad = counts.filter((c) => BAD_STATUSES.has(c.status)).reduce((n, c) => n + c.n, 0);
  const parts = counts.map((c) => `${c.n.toLocaleString()} ${c.status}`);

  notify({
    title: `${run.name} finished`,
    body: `${parts.join(', ') || 'No results'} · ${usd(run.cost_usd)}`,
    urgent: bad > 0,
    // Counts, an operator-chosen name and a cost — nothing an agent wrote, so
    // this is one of the two things the windowless scheduler may keep.
    hold: true,
    onClick: reveal({ kind: 'run', runId }),
  });
}

/**
 * A submission was refused by the spend cap. Always urgent: this one is not a
 * report on work that happened, it is work that did NOT happen and is waiting
 * on a decision — a silent version of it reads as "the batch is running".
 *
 * Takes the run's NAME, not a run id, and that is not a convenience. The cap is
 * checked in createAndSubmitRun before newRunId() is called, because a run that
 * was refused must not leave a row behind claiming it exists. So at the only
 * moment this function can be called there is no run id to pass and no row to
 * look a name up in — an id-shaped signature here could only ever be satisfied
 * by inventing one, and the notification would name a run the user cannot open.
 * The name is what they typed into the form, which is also what they will
 * recognise.
 */
export function announceSpendCapTrip(name: string, projected: number, cap: number): void {
  if (!claim(`cap:${name}:${cap}`, CAP_DEDUPE_MS)) return;
  notify({
    title: 'Stopped at the spend cap',
    body: `${name} is estimated at ${usd(projected)}, above your ${usd(cap)} cap. Nothing was submitted — raise the cap in Settings or cut the dataset down.`,
    urgent: true,
    // No target, for the same reason there is no run id above: the refusal
    // happens before the row exists, so there is nothing to deep-link to. The
    // window still comes forward, on the form the operator was last using.
    onClick: reveal(),
  });
}

/**
 * A session needs a human.
 *
 * This is the function the app's binding constraint is answered by. One
 * operator can only watch one screen, and Fleet is described as "the view you
 * leave open on a second monitor while eight agents work" — which is only true
 * if leaving it is safe. A blocked agent that waits in silence until somebody
 * happens to look does not cost a notification, it costs the wall-clock time of
 * every agent downstream of it.
 *
 * Takes the whole Attention rather than a loose (id, label, detail) triple.
 * That is what lets the interrupt-worthiness decision key on `kind` instead of
 * on display text, and it removes the failure where a caller pairs one
 * session's label with another's detail — which would be a notification that
 * reads perfectly and is wrong, the worst kind this app can send.
 *
 * Nothing here is logged or stored; `detail` reaches the OS notification and
 * nowhere else, and attention.ts is where the human's own prompt text was
 * already kept out of it. Safe to call on every hook event: the filters below
 * are cheap and the transition identity does the rest.
 */
export function announceAttention(a: Attention): void {
  if (!ANNOUNCE_KINDS.has(a.kind)) return;

  // A focused Wanigan window means only that the Mac banner would be redundant.
  // It says nothing about whether the human is still physically at the desk,
  // which is precisely why the separately opt-in phone sink exists.
  const sendMobile = claimAttention('mobile', a);
  const sendDesktop = !alreadyOnScreen(a.sessionId)
    && claimAttention('desktop', a);
  if (!sendMobile && !sendDesktop) return;

  let where: string | null = null;
  try {
    const r = db().prepare('SELECT project_name FROM session_log WHERE id = ?').get(a.sessionId) as
      { project_name: string } | undefined;
    where = r?.project_name ?? null;
  } catch {
    // Unnamed is worse than named, but not worse than silent.
  }
  const message = {
    title: where ? `${a.label} — ${where}` : a.label,
    // The classifier supplies a detail for all three announced kinds, but the
    // field is nullable and a notification with an empty body is a rectangle
    // that says nothing. Send them somewhere instead.
    body: a.detail ?? 'Open Wanigan to see where it stopped.',
    // Hook details can contain a shell command or file name. That is useful on
    // the trusted desktop and needless at an external push provider; the
    // project/state/wait is enough to decide whether to walk back to the Mac.
    mobileBody: mobileAttentionBody(a),
    urgent: URGENT_KINDS.has(a.kind),
    // The session is the whole content of the alert. Raising the window onto
    // whatever tab was last open leaves the operator with the same search they
    // would have had if nothing had told them.
    onClick: reveal({ kind: 'session', sessionId: a.sessionId }),
  };
  if (sendMobile) notify({
    ...message,
    desktop: false,
    mobile: true,
    onMobileResult: (result) => settleMobileAttention(a, result),
  });
  if (sendDesktop) notify({ ...message, desktop: true, mobile: false });
}

export function mobileAttentionBody(a: Attention): string {
  const elapsed = Math.max(0, Date.now() - a.since);
  const seconds = Math.floor(elapsed / 1000);
  const waited = seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (a.kind === 'permission') return `Waiting for approval for ${waited}.`;
  if (a.kind === 'error') return `Failed ${waited} ago.`;
  return `Turn finished ${waited} ago.`;
}
