import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BrowserWindow, Notification } from 'electron';
import { db, resultsDir } from './db';
import { getSetting, setSetting } from './settings';

/**
 * Telling the human something happened, and knowing when to look.
 *
 * The Batches API can call a completion webhook — HMAC-signed, retried for a
 * day — and it is genuinely better than polling for anything with a public
 * URL. Foreman does not have one. A desktop app can only receive a webhook if
 * the user first stands up a tunnel and keeps it up, which is a second daemon
 * to babysit in exchange for removing a request every ten seconds. So polling
 * stayed, and startWebhookReceiver below is opt-in for the minority who
 * already have an endpoint.
 *
 * The reason that trade is safe is worth writing down, because it is the
 * opposite of the usual one: the failure mode that loses batches here is not a
 * missed webhook, it is a CLOSED APP. Batches advance on a timer inside the
 * main process, so quitting Foreman stops the clock — while the API's 24-hour
 * processing expiry keeps running, and the 29-day results window keeps running
 * after that. A webhook fired at a laptop that is asleep is discarded just as
 * completely as a poll that was never made. What actually protects the work is
 * a poll schedule that knows where it is in those two clocks and tightens up at
 * the moments where the difference between 'ended' and 'expired' gets decided,
 * plus surfacing both deadlines so the human can reopen the app in time.
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

/** Labels from ATTENTION_LABEL in attention.ts that are worth a sound. */
const URGENT_LABELS = new Set(['Asking', 'Failed']);

const RUN_ENDED_DEDUPE_MS = 6 * 60 * 60_000;
const CAP_DEDUPE_MS = 5 * 60_000;
const ATTENTION_DEDUPE_MS = 5 * 60_000;
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

export function notify(opts: { title: string; body: string; urgent?: boolean; onClick?: () => void }): void {
  if (!notificationsEnabled()) return;
  try {
    // isSupported() is false on a Linux box with no notification daemon, and
    // the constructor itself throws before the app is ready.
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;

    const n = new Notification({
      title: opts.title,
      body: opts.body,
      // Only urgent things make a noise. Foreman has a lot to say across a long
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
function focusForeman(): void {
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
    // Foreman stays open for weeks. Drop keys nothing could still be
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

function runName(runId: string): string | null {
  try {
    const r = db().prepare('SELECT name FROM runs WHERE id = ?').get(runId) as { name: string } | undefined;
    return r?.name ?? null;
  } catch {
    return null;
  }
}

/** Failures first: an OS notification truncates the tail, never the head. */
const STATUS_ORDER = ['errored', 'expired', 'canceled', 'pending', 'succeeded'];

export function announceRunEnded(runId: string): void {
  if (!claim(`run:${runId}`, RUN_ENDED_DEDUPE_MS)) return;

  let run: { name: string; cost_usd: number } | undefined;
  let counts: { status: string; n: number }[];
  try {
    const d = db();
    run = d.prepare('SELECT name, cost_usd FROM runs WHERE id = ?').get(runId) as typeof run;
    counts = d.prepare('SELECT status, COUNT(*) n FROM requests WHERE run_id = ? GROUP BY status')
      .all(runId) as { status: string; n: number }[];
  } catch {
    return;
  }
  if (!run) return;

  counts.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const bad = counts
    .filter((c) => c.status === 'errored' || c.status === 'expired')
    .reduce((n, c) => n + c.n, 0);
  const parts = counts.map((c) => `${c.n.toLocaleString()} ${c.status}`);

  notify({
    title: `${run.name} finished`,
    body: `${parts.join(', ') || 'No results'} · ${usd(run.cost_usd)}`,
    urgent: bad > 0,
    onClick: focusForeman,
  });
}

/**
 * A run stopped at the spend cap. Always urgent: this one is not a report on
 * work that happened, it is work that did NOT happen and is waiting on a
 * decision — a silent version of it reads as "the batch is running".
 */
export function announceSpendCapTrip(runId: string, projected: number, cap: number): void {
  if (!claim(`cap:${runId}:${cap}`, CAP_DEDUPE_MS)) return;
  const name = runName(runId) ?? runId;
  notify({
    title: 'Stopped at the spend cap',
    body: `${name} is estimated at ${usd(projected)}, above your ${usd(cap)} cap. Nothing was submitted — raise the cap in Settings or cut the dataset down.`,
    urgent: true,
    onClick: focusForeman,
  });
}

/**
 * A session needs a human. `label` is the word from ATTENTION_LABEL, `detail`
 * the one-line summary the attention queue already built.
 *
 * The caller decides which states are worth interrupting for — a notification
 * per 'Working' would be unusable. Neither argument is logged or stored here;
 * detail reaches the OS notification and nowhere else, and attention.ts is
 * where the human's prompt text was already kept out of it.
 */
export function announceAttention(sessionId: string, label: string, detail: string): void {
  if (!claim(`session:${sessionId}:${label}`, ATTENTION_DEDUPE_MS)) return;
  let where: string | null = null;
  try {
    const r = db().prepare('SELECT project_name FROM session_log WHERE id = ?').get(sessionId) as
      { project_name: string } | undefined;
    where = r?.project_name ?? null;
  } catch {
    // Unnamed is worse than named, but not worse than silent.
  }
  notify({
    title: where ? `${label} — ${where}` : label,
    body: detail,
    urgent: URGENT_LABELS.has(label),
    onClick: focusForeman,
  });
}

/* ── webhook receiver (opt-in) ───────────────────────────────────────── */

export const WEBHOOK_PATH = '/webhooks/anthropic';
/** Replay window. A delivery older than this is refused however well it is signed. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** A completion event is a few hundred bytes. Anything near this is not one. */
const WEBHOOK_MAX_BODY = 256 * 1024;
const WEBHOOK_REQUEST_BUDGET_MS = 5000;

export type WebhookEvent = {
  /** e.g. 'batch.completed'. 'unknown' when the payload did not name itself. */
  type: string;
  /** The event's own id, for de-duplicating redeliveries. */
  id: string | null;
  /** The batch the event is about, when it is about one. */
  batchId: string | null;
  raw: unknown;
};

type Receiver = { server: http.Server; port: number; secret: string };

let receiver: Receiver | null = null;
const receiverSockets = new Set<Socket>();
const webhookListeners = new Set<(e: WebhookEvent) => void>();

/**
 * Called for every verified delivery. Returns an unsubscribe.
 *
 * The right handler is one that kicks a poll: the event says something moved,
 * and the API remains the only thing that knows what. Acting on the payload's
 * contents directly would mean trusting counts from a body that arrived over
 * the network to be newer than the ones we fetched ourselves.
 */
export function onWebhook(handler: (e: WebhookEvent) => void): () => void {
  webhookListeners.add(handler);
  return () => { webhookListeners.delete(handler); };
}

export function webhookReceiverUrl(): string | null {
  return receiver ? `http://127.0.0.1:${receiver.port}${WEBHOOK_PATH}` : null;
}

/**
 * Starts the completion-webhook endpoint. OFF by default and never started
 * implicitly — nothing else in this module calls it, and it should stay that
 * way: an app that opens a listening port because a feature flag defaulted on
 * is an app that opened a port the user never agreed to.
 *
 * Bound to 127.0.0.1, which is not a contradiction — the endpoint is reachable
 * because the user is running a tunnel (cloudflared, ngrok, an ssh -R) that
 * connects to it from this machine. Binding 0.0.0.0 instead would publish it on
 * every café Wi-Fi the laptop joins, and the signature check is not a reason to
 * do that: it is a reason the endpoint is safe from forgery, not a reason to
 * offer it to strangers.
 */
export async function startWebhookReceiver(port: number, secret: string): Promise<{ url: string }> {
  if (receiver) {
    // Port 0 means "any port", so it is already satisfied by whatever the OS
    // assigned. Comparing the request against the ASSIGNED port would make a
    // second start(0, …) — reopening Settings, a retry, any caller that treats
    // start as idempotent — throw "already listening on 51234, stop it before
    // moving it to 0", which is both untrue and impossible to act on.
    if (port !== 0 && receiver.port !== port) {
      throw new Error(
        `The webhook receiver is already listening on port ${receiver.port}. ` +
        `Stop it before moving it to ${port}.`
      );
    }
    return { url: webhookReceiverUrl()! };
  }
  if (!secret.trim()) {
    throw new Error(
      'A webhook receiver needs the signing secret from the Console (it starts with "whsec_"). ' +
      'Without it every delivery has to be refused as unverifiable, which is worse than not listening at all.'
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${port} is not a usable port. Use 0 to let the OS pick one, or a number from 1 to 65535.`);
  }

  const srv = http.createServer((req, res) => { handleWebhook(req, res, secret); });
  // A tunnel holds its connection open between deliveries; without these the
  // app waits on an idle one at quit instead of closing.
  srv.keepAliveTimeout = 5000;
  srv.headersTimeout = 10_000;
  srv.on('connection', (s: Socket) => {
    receiverSockets.add(s);
    s.on('close', () => receiverSockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (e: NodeJS.ErrnoException) => {
      const why = e.code === 'EADDRINUSE'
        ? `port ${port} is already in use — pick another, or use 0 to let the OS choose`
        : e.message;
      reject(new Error(
        `Foreman could not open the webhook receiver: ${why}. Batches still advance on polling.`
      ));
    };
    srv.once('error', fail);
    srv.listen(port, '127.0.0.1', () => { srv.off('error', fail); resolve(); });
  });

  const addr = srv.address();
  if (typeof addr !== 'object' || addr === null) {
    srv.close();
    throw new Error('The webhook receiver started without a port. Stop it and try again.');
  }
  // Socket noise after startup — a tunnel dropping mid-delivery — must not
  // reach the process error handler and take the app down.
  srv.on('error', () => {});

  receiver = { server: srv, port: addr.port, secret };
  return { url: webhookReceiverUrl()! };
}

export function stopWebhookReceiver(): void {
  const r = receiver;
  receiver = null;
  if (!r) return;
  try { r.server.close(); } catch { /* never listened */ }
  // close() only refuses new connections; an established keep-alive socket
  // keeps the event loop — and therefore the quit — waiting.
  for (const s of receiverSockets) { try { s.destroy(); } catch { /* already gone */ } }
  receiverSockets.clear();
}

/**
 * Verifies one delivery.
 *
 * Signed content is `webhookId + '.' + timestamp + '.' + rawBody`, which is the
 * Standard Webhooks wire format Anthropic signs with. Leaving the id out is not
 * a laxer check, it is a different digest: every genuine delivery then fails
 * verification, Foreman answers 401, and the sender retries for 24 hours while
 * the Console's delivery log makes it look like the signing secret is wrong.
 *
 * Over the RAW body: re-encoding the parsed JSON changes key order and
 * whitespace, and every signature then fails for a payload that was perfectly
 * genuine.
 */
export function verifyWebhookSignature(secret: string, webhookId: string, timestamp: string, rawBody: string, signature: string): boolean {
  // No id means nothing that can be verified — the digest cannot be formed
  // without it, so accepting the delivery would mean accepting it unchecked.
  if (!secret || !webhookId || !timestamp || !signature) return false;

  const sentAt = parseTimestamp(timestamp);
  if (sentAt === null) return false;
  // Both directions. Rejecting only old timestamps leaves a captured delivery
  // dated a year ahead replayable forever, and clock skew between the sender
  // and this laptop makes a small future allowance necessary anyway.
  if (Math.abs(Date.now() - sentAt) > WEBHOOK_TOLERANCE_MS) return false;

  let digest: Buffer;
  try {
    digest = createHmac('sha256', signingKey(secret)).update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8').digest();
  } catch {
    return false;
  }
  const hex = digest.toString('hex');
  const b64 = digest.toString('base64');

  // During a secret rotation the sender signs with both keys and sends the
  // signatures space-separated in one header; one match is a match. Each may
  // carry a scheme prefix ("v1,<sig>"), which is not part of the digest.
  for (const token of signature.trim().split(/\s+/)) {
    const comma = token.indexOf(',');
    const value = comma >= 0 ? token.slice(comma + 1) : token;
    if (constantTimeEqual(value, hex) || constantTimeEqual(value, b64)) return true;
  }
  return false;
}

/**
 * Never `===`. String comparison returns at the first differing byte, and
 * anything that can post to this endpoint can time that and walk out a valid
 * signature one byte at a time. Length is compared openly because the digest
 * length is fixed by SHA-256 and public.
 */
function constantTimeEqual(given: string, want: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook secrets are issued as `whsec_<base64>`, and the bytes that signed the
 * delivery are the DECODED base64 — not the printable string. Keying the HMAC
 * with the string produces a digest that can never match, and the only symptom
 * is every delivery being rejected as forged, which reads like an attack rather
 * than a configuration mistake.
 */
function signingKey(secret: string): Buffer {
  const s = secret.trim();
  return s.startsWith('whsec_') ? Buffer.from(s.slice(6), 'base64') : Buffer.from(s, 'utf8');
}

/** Unix seconds is what the spec sends; milliseconds is what hand-rolled senders send. */
function parseTimestamp(timestamp: string): number | null {
  const n = Number(timestamp.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  // A millisecond value below 1e12 would be 1970, so the ambiguity is not real.
  return n < 1e12 ? n * 1000 : n;
}

function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse, secret: string): void {
  const url = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || url !== WEBHOOK_PATH) {
    end(res, 404);
    return;
  }

  readBody(req).then((body) => {
    if (!body.ok) { end(res, body.status); return; }

    // All three headers are part of the signature. Reading only two is how the
    // receiver ends up recomputing a digest the sender never produced.
    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    const signature = header(req, 'webhook-signature');
    if (!verifyWebhookSignature(secret, id, timestamp, body.text, signature)) {
      // 401, not 200. The sender retries for 24 hours on a non-2xx, which is
      // pointless for a bad signature but honest — silently accepting an
      // unverified delivery is how a forged one gets treated as real.
      end(res, 401);
      return;
    }

    // Answer before doing anything. The sender treats a slow response as a
    // failed delivery and redelivers, so a listener that takes a second to run
    // would manufacture duplicates of an event that arrived exactly once.
    end(res, 204);

    const event = parseWebhookEvent(body.text);
    // A signed body we cannot parse is ours and still useless; redelivery will
    // not make it parseable, which is why it was already answered 204.
    if (!event) return;
    for (const listener of webhookListeners) {
      try {
        listener(event);
      } catch {
        // One bad listener must not stop the others, or the socket cleanup.
      }
    }
  }).catch(() => { end(res, 400); });
}

function header(req: http.IncomingMessage, name: string): string {
  const v = req.headers[name];
  return typeof v === 'string' ? v : '';
}

type BodyResult = { ok: true; text: string } | { ok: false; status: number };

/**
 * The raw body, or the status to answer with.
 *
 * An oversized delivery pauses the request rather than destroying it, so the
 * 413 actually reaches the sender. Destroying the socket first is the obvious
 * version and the wrong one: the delivery then shows up in the Console's log as
 * a connection error, which sends whoever is debugging it to look at their
 * tunnel instead of at the payload. `connection: close` on the reply takes the
 * socket down once the answer has flushed.
 */
function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // A body still arriving after this is a stuck socket, not a slow sender,
    // and there is nothing to answer on a socket that is not moving.
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, status: 408 }); }, WEBHOOK_REQUEST_BUDGET_MS);

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > WEBHOOK_MAX_BODY) {
        req.pause();
        chunks = [];
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

function end(res: http.ServerResponse, status: number): void {
  try {
    res.writeHead(status, { 'content-length': '0', connection: 'close' });
    res.end();
  } catch {
    // The tunnel hung up first.
  }
}

function parseWebhookEvent(text: string): WebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const o = parsed as Record<string, unknown>;
  const data = typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : {};
  const objectId = typeof data.id === 'string' ? data.id : null;
  return {
    type: typeof o.type === 'string' ? o.type : 'unknown',
    id: typeof o.id === 'string' ? o.id : null,
    batchId: objectId && objectId.startsWith('msgbatch') ? objectId : null,
    raw: parsed,
  };
}
