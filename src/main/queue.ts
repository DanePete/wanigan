import { randomUUID } from 'node:crypto';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import {
  DEFAULT_SLOTS,
  type QueueItem,
  type QueueKind,
  type QueueSlots,
  type QueueState,
} from '../shared/types';

/**
 * One dispatcher in front of every surface that starts work: PTY sessions,
 * headless fan-outs and batch submissions.
 *
 * The `queue` table is the state. Nothing here caches rows in memory and hands
 * them back later: after a crash, an in-memory view that disagrees with SQLite
 * is worse than having no queue at all, because the app would confidently show
 * work it is not doing. Every tick re-reads ready work with a query, and the
 * only in-memory structures are the registered runners (code, not state) and
 * the set of ids this process currently has in flight.
 */

export type QueueRunner = (payload: unknown, item: QueueItem) => Promise<void>;

const DISPATCH_INTERVAL = 3_000;
/** Bounds the work one tick can do; the next tick picks up the rest. */
const READY_LIMIT = 200;
const MAX_ATTEMPTS = 5;

const RETRY_BASE_MS = 15_000;
const RETRY_FACTOR = 2;
const RETRY_CAP_MS = 10 * 60_000;

// The desktop window and launchd service intentionally share one queue
// database. A process-local `inFlight` map cannot prove a row belongs to a
// crashed worker, so a claim has a durable owner and a renewable lease instead.
// Two minutes tolerates a briefly blocked event loop without spuriously
// launching a second paid worker; a crashed worker is still recovered promptly.
const LEASE_MS = 120_000;
const LEASE_RENEW_MS = 30_000;
const DISPATCHER_OWNER = `queue-${process.pid}-${randomUUID()}`;

/**
 * A 429 gets a much longer first pause than an ordinary failure.
 *
 * The Batches API counts every request *inside* a submitted batch against the
 * organisation's rate limits, not just the HTTP call that submitted it. So a
 * dispatcher that only throttles submissions protects nothing: one accepted
 * 100k-row batch keeps consuming the limit for as long as it sits in the
 * provider's queue, and everything dispatched behind it does not get rate
 * limited so much as starved — it reaches its 24-hour expiry with requests
 * still pending. Backing off hard on the first 429, rather than hammering,
 * is what keeps a run inside its expiry window.
 */
const RATE_LIMIT_BASE_MS = 60_000;

/** A typo of 400 in the slots field must not try to open 400 PTYs. */
const MAX_SLOT = 64;

/** done/canceled rows are noise after a week; failed rows are evidence. */
const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;
const KEEP_FAILED_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_TICKS = 100;

const runners = new Map<QueueKind, QueueRunner>();
/** Ids this process has handed to a runner and not yet finalised. */
const inFlight = new Map<string, Promise<void>>();

let ticking = false;
let timer: NodeJS.Timeout | null = null;
let onChangeCb: (() => void) | null = null;
let tickCount = 0;

type QueueRow = {
  id: string;
  kind: string;
  state: string;
  priority: number;
  label: string;
  payload_json: string;
  blocked_by: string | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
};

/**
 * Deliberately drops payload_json. A QueueItem is what the renderer sees, and a
 * headless payload carries the prompt text — that stays in the database and
 * never crosses the IPC boundary or reaches a log.
 */
function mapRow(r: QueueRow): QueueItem {
  return {
    id: r.id,
    // kind and state are only ever written from the typed values below.
    kind: r.kind as QueueKind,
    state: r.state as QueueState,
    priority: r.priority,
    label: r.label,
    blockedBy: r.blocked_by,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    error: r.error,
  };
}

/* ── enqueue / inspect ───────────────────────────────────────────────── */

export function enqueue(kind: QueueKind, label: string, payload: unknown, priority = 100): QueueItem {
  const name = label.trim();
  if (!name) throw new Error('A queued item needs a label — it is the only thing the user sees while it waits.');

  let payloadJson: string;
  try {
    payloadJson = payload === undefined ? 'null' : (JSON.stringify(payload) ?? 'null');
  } catch {
    throw new Error(
      `The payload for "${name}" cannot be stored as JSON. The queue survives a restart, so pass ids and plain values — not live objects, streams or handles.`
    );
  }

  const row: QueueRow = {
    id: `q_${randomUUID().slice(0, 8)}`,
    kind,
    state: 'waiting',
    priority: Math.round(priority),
    label: name,
    payload_json: payloadJson,
    blocked_by: null,
    attempts: 0,
    next_attempt_at: null,
    created_at: Date.now(),
    started_at: null,
    ended_at: null,
    error: null,
    lease_owner: null,
    lease_expires_at: null,
  };

  db().prepare(`
    INSERT INTO queue (id, kind, state, priority, label, payload_json, blocked_by, attempts, next_attempt_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.id, row.kind, row.state, row.priority, row.label, row.payload_json,
    row.blocked_by, row.attempts, row.next_attempt_at, row.created_at
  );

  emit();
  return mapRow(row);
}

/** Active work first, then the most recently finished — what a queue view wants. */
export function listQueue(limit = 200): QueueItem[] {
  const rows = db().prepare(`
    SELECT *, CASE state WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END AS rank_
    FROM queue
    ORDER BY rank_,
      CASE WHEN state IN ('running','waiting') THEN priority ELSE 0 END,
      CASE WHEN state IN ('running','waiting') THEN created_at ELSE -COALESCE(ended_at, created_at) END
    LIMIT ?
  `).all(Math.max(1, Math.round(limit))) as QueueRow[];
  return rows.map(mapRow);
}

export function queueCounts(): Record<QueueState, number> {
  const out: Record<QueueState, number> = { waiting: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  const rows = db().prepare('SELECT state, COUNT(*) n FROM queue GROUP BY state')
    .all() as { state: string; n: number }[];
  for (const r of rows) {
    if (r.state in out) out[r.state as QueueState] = r.n;
  }
  return out;
}

/**
 * Cancels an item that has not started. A running item belongs to whatever
 * started it — killing a live PTY or an in-flight batch from here would leave
 * that surface's own bookkeeping behind, so cancel it there instead.
 */
export function cancelQueued(id: string): boolean {
  const res = db().prepare(
    "UPDATE queue SET state='canceled', ended_at=?, blocked_by=NULL, next_attempt_at=NULL WHERE id=? AND state='waiting'"
  ).run(Date.now(), id);
  if (res.changes) emit();
  return res.changes > 0;
}

/* ── slots ───────────────────────────────────────────────────────────── */

/** Shared with allSettings() in settings.ts — one key, so the Settings panel
 *  and the dispatcher can never report different slot counts. */
const SLOTS_KEY = 'slots';

function clampSlot(v: unknown, fallback: number, floor = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(floor, Math.min(MAX_SLOT, Math.round(n)));
}

/**
 * Read fresh every tick, so a settings change takes effect without a restart.
 * A hand-written 0 is honoured as "hold this surface" rather than corrected,
 * because silently dispatching work the file says to hold is the worse bug.
 */
export function slots(): QueueSlots {
  let parsed: unknown;
  try {
    parsed = JSON.parse(getSetting(SLOTS_KEY, '{}'));
  } catch {
    // A hand-edited or half-written value must not stop the dispatcher dead.
    return { ...DEFAULT_SLOTS };
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<Record<keyof QueueSlots, unknown>>;
  return {
    session: clampSlot(o.session, DEFAULT_SLOTS.session),
    headless: clampSlot(o.headless, DEFAULT_SLOTS.headless),
    batch: clampSlot(o.batch, DEFAULT_SLOTS.batch),
  };
}

/**
 * Lowering a count never stops work already running — it only narrows what the
 * next tick dispatches. Tearing down a live session to satisfy a settings
 * change would destroy whatever the user was doing in it.
 */
export function setSlots(next: Partial<QueueSlots>): QueueSlots {
  const cur = slots();
  // Floor of 1 on write: the shared reader in settings.ts floors there too, so
  // persisting a 0 would leave the Settings panel showing 4 while the queue
  // held everything back — the same key reading two different ways.
  const merged: QueueSlots = {
    session: next.session === undefined ? cur.session : clampSlot(next.session, cur.session, 1),
    headless: next.headless === undefined ? cur.headless : clampSlot(next.headless, cur.headless, 1),
    batch: next.batch === undefined ? cur.batch : clampSlot(next.batch, cur.batch, 1),
  };
  setSetting(SLOTS_KEY, JSON.stringify(merged));
  emit();
  return merged;
}

/* ── runners ─────────────────────────────────────────────────────────── */

/**
 * The surfaces register themselves. Re-registering replaces, so a dev reload
 * does not leave a dead closure holding a kind hostage.
 */
export function registerRunner(kind: QueueKind, run: QueueRunner): void {
  runners.set(kind, run);
}

/* ── dispatch ────────────────────────────────────────────────────────── */

export function startDispatcher(onChange?: () => void): void {
  onChangeCb = onChange ?? null;
  if (timer) return;
  timer = setInterval(() => { void tick(); }, DISPATCH_INTERVAL);
  // A 3s heartbeat must not be the reason the app refuses to quit.
  timer.unref?.();
  void tick();
}

export function stopDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  onChangeCb = null;
  // Runners already in flight keep going; their completion handlers still
  // finalise their rows, so the table stays truthful either way.
}

/**
 * Re-entrancy guard, not an optimisation: a runner that takes longer than the
 * interval would otherwise let a second tick read the same 'waiting' row and
 * dispatch it twice — two agents in one worktree, or a batch submitted twice.
 */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await dispatch();
  } catch (e) {
    // Every call site is `void tick()` and the main process installs no
    // unhandledRejection handler, so a throw from dispatch — a SQLITE_BUSY from
    // another writer on the same database is the realistic one — would either
    // take Electron down with every live PTY, or vanish with no trace of why
    // the queue stopped moving. A logged, skipped tick recovers on the next
    // interval.
    console.warn('[wanigan] queue dispatch failed; skipping this tick:', e);
  } finally {
    ticking = false;
  }
}

/** Awaits everything this process currently has in flight. For a clean quit. */
export async function drain(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

async function dispatch(): Promise<void> {
  const d = db();
  const now = Date.now();
  let moved = recoverExpiredLeases(now);

  const limits = slots();
  const used: Record<QueueKind, number> = { session: 0, headless: 0, batch: 0 };
  const running = d.prepare("SELECT kind, COUNT(*) n FROM queue WHERE state='running' GROUP BY kind")
    .all() as { kind: string; n: number }[];
  for (const r of running) {
    if (r.kind in used) used[r.kind as QueueKind] = r.n;
  }

  const ready = d.prepare(`
    SELECT * FROM queue
    WHERE state='waiting' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY priority, created_at
    LIMIT ?
  `).all(now, READY_LIMIT) as QueueRow[];

  for (const row of ready) {
    const kind = row.kind as QueueKind;
    const run = runners.get(kind);

    // A kind nobody has wired yet waits rather than fails: the work is still
    // valid, the app simply has not registered that surface in this build.
    if (!run) {
      moved = setBlocked(row, 'no runner registered') || moved;
      continue;
    }

    const limit = limits[kind] ?? 0;
    if (used[kind] >= limit) {
      moved = setBlocked(row, limit === 0
        ? `${kind} slots are set to 0 — raise the slot count in Settings to let this start.`
        : `All ${limit} ${kind} slot${limit === 1 ? '' : 's'} are busy — this starts when one frees up.`
      ) || moved;
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // Retrying an unreadable payload can only fail again, so stop now.
      d.prepare("UPDATE queue SET state='failed', ended_at=?, blocked_by=NULL, error=? WHERE id=? AND state='waiting'")
        .run(now, 'Stored payload is not readable JSON — remove this item and start the work again.', row.id);
      moved = true;
      continue;
    }

    // Atomic claim: the WHERE clause is what stops a concurrent tick or
    // process from running this item twice. The durable lease prevents a new
    // process from mistaking another process's in-memory work for an orphan.
    const claimed = d.prepare(
      "UPDATE queue SET state='running', started_at=?, blocked_by=NULL, error=NULL, lease_owner=?, lease_expires_at=? WHERE id=? AND state='waiting'"
    ).run(now, DISPATCHER_OWNER, now + LEASE_MS, row.id);
    if (claimed.changes !== 1) continue;

    used[kind]++;
    moved = true;
    const item = mapRow({
      ...row,
      state: 'running',
      started_at: now,
      blocked_by: null,
      error: null,
      lease_owner: DISPATCHER_OWNER,
      lease_expires_at: now + LEASE_MS,
    });
    const p = runItem(run, item, payload);
    inFlight.set(item.id, p);
  }

  if (++tickCount % PRUNE_EVERY_TICKS === 0) prune();
  if (moved) emit();
}

/**
 * Runners are started, not awaited: a headless run can hold its slot for ten
 * minutes, and a tick that waited for it would stall every other surface.
 * Completion is finalised here instead.
 */
async function runItem(run: QueueRunner, item: QueueItem, payload: unknown): Promise<void> {
  const stopHeartbeat = startLeaseHeartbeat(item.id);
  try {
    await run(payload, item);
    finish(item.id);
  } catch (e) {
    failOrRetry(item.id, e);
  } finally {
    stopHeartbeat();
    inFlight.delete(item.id);
    emit();
  }
}

function startLeaseHeartbeat(id: string): () => void {
  const heartbeat = setInterval(() => {
    try {
      // If this ever affects zero rows, another process has legitimately
      // recovered the expired row. The stale runner may finish its own cleanup,
      // but it can no longer alter the queue's authoritative state.
      db().prepare(
        "UPDATE queue SET lease_expires_at=? WHERE id=? AND state='running' AND lease_owner=?"
      ).run(Date.now() + LEASE_MS, id, DISPATCHER_OWNER);
    } catch (error) {
      // The next heartbeat normally recovers a transient lock. Do not turn a
      // worker's real result into an unhandled exception because SQLite was
      // briefly busy with another Wanigan process.
      console.warn('[wanigan] queue lease heartbeat failed:', error);
    }
  }, LEASE_RENEW_MS);
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

function finish(id: string) {
  db().prepare(
    "UPDATE queue SET state='done', ended_at=?, blocked_by=NULL, error=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND state='running' AND lease_owner=?"
  ).run(Date.now(), id, DISPATCHER_OWNER);
}

function failOrRetry(id: string, e: unknown) {
  const d = db();
  const row = d.prepare(
    "SELECT * FROM queue WHERE id=? AND state='running' AND lease_owner=?"
  ).get(id, DISPATCHER_OWNER) as QueueRow | undefined;
  // Gone, resolved, or reclaimed after this worker stopped reporting — do not
  // let a stale process resurrect or complete somebody else's queue row.
  if (!row) return;

  const message = e instanceof Error ? e.message : String(e);
  const attempts = row.attempts + 1;
  const now = Date.now();

  if (attempts >= MAX_ATTEMPTS) {
    d.prepare(
      "UPDATE queue SET state='failed', attempts=?, ended_at=?, next_attempt_at=NULL, blocked_by=NULL, error=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND state='running' AND lease_owner=?"
    ).run(attempts, now, `${message} (gave up after ${attempts} attempts)`, id, DISPATCHER_OWNER);
    return;
  }

  const limited = isRateLimited(e);
  const delay = backoff(attempts, limited);
  const at = now + delay;
  const blocked = limited
    ? `Rate limited by the API — waiting ${Math.round(delay / 1000)}s before attempt ${attempts + 1} of ${MAX_ATTEMPTS}.`
    : `Attempt ${attempts} failed — retrying in ${Math.round(delay / 1000)}s.`;

  d.prepare(
    "UPDATE queue SET state='waiting', attempts=?, next_attempt_at=?, started_at=NULL, blocked_by=?, error=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND state='running' AND lease_owner=?"
  ).run(attempts, at, blocked, message, id, DISPATCHER_OWNER);
}

/**
 * Exponential, then jittered across the whole window. The jitter is the point:
 * a rate-limit storm fails twenty items within the same second, and a fixed
 * delay would march all twenty back onto the API on the same instant and earn
 * the same 429 again.
 */
function backoff(attempts: number, limited: boolean): number {
  const base = limited ? RATE_LIMIT_BASE_MS : RETRY_BASE_MS;
  const raw = Math.min(RETRY_CAP_MS, base * Math.pow(RETRY_FACTOR, attempts - 1));
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}

/**
 * 429 arrives in several shapes depending on who threw: the SDK sets `status`,
 * a wrapped fetch sets `statusCode`, and a rethrown error may only carry the
 * text. 529 (overloaded) earns the same restraint.
 */
function isRateLimited(e: unknown): boolean {
  const err = e as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  if (err && (err.status === 429 || err.statusCode === 429 || err.status === 529)) return true;
  const msg = String(err?.message ?? e).toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit') ||
    msg.includes('too many requests') || msg.includes('overloaded');
}

function setBlocked(row: QueueRow, reason: string): boolean {
  if (row.blocked_by === reason) return false;
  db().prepare('UPDATE queue SET blocked_by=? WHERE id=?').run(reason, row.id);
  return true;
}

/**
 * A row is reclaimable only after its durable lease expires. This is the
 * distinction that a fresh desktop process needs: a live launchd worker is not
 * an orphan merely because its in-memory map lives in another process.
 *
 * Pre-lease rows from older Wanigan builds have NULL expiry and are deliberately
 * recovered once; the conditional UPDATE makes concurrent upgrade starts safe.
 */
function recoverExpiredLeases(now: number): boolean {
  const result = db().prepare(
    "UPDATE queue SET state='waiting', started_at=NULL, blocked_by=?, lease_owner=NULL, lease_expires_at=NULL WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
  ).run(
    'The prior Wanigan worker stopped reporting before this completed — it is queued again from the start.',
    now
  );
  return result.changes > 0;
}

/** Keeps the table from growing without bound across months of use. */
export function prune(): number {
  const now = Date.now();
  const done = db().prepare(
    "DELETE FROM queue WHERE state IN ('done','canceled') AND COALESCE(ended_at, created_at) < ?"
  ).run(now - KEEP_DONE_MS);
  const failed = db().prepare(
    "DELETE FROM queue WHERE state='failed' AND COALESCE(ended_at, created_at) < ?"
  ).run(now - KEEP_FAILED_MS);
  return done.changes + failed.changes;
}

function emit() {
  if (!onChangeCb) return;
  // A window that has gone away throws on send; that must not stop the queue.
  try { onChangeCb(); } catch { /* the next change re-notifies */ }
}
