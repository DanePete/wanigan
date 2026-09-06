import type http from 'node:http';
import { STALE_AFTER_MS } from '../claude-limits';
import { json, registerApiRoute, send } from './dispatch';
import { safeString } from './snapshot';
import { harnessLabel } from '../../shared/types';
import type { AccountLimits, LimitWindow, ModelConsumption, UsageSnapshot } from '../../shared/types';

/**
 * The read-only seam the Explore screens read through.
 *
 * Fleet state crosses on /api/status and nothing else; this is the second
 * boundary, for the questions that are about accounts and money rather than
 * about running sessions. It follows ./snapshot exactly, and for the same
 * reason: the response is rebuilt field by field from an allow-list, so an
 * accidental extra property on a structurally compatible source object cannot
 * cross the HTTP boundary just because it happened to be attached to it.
 *
 * Two things are deliberately not on this wire. An account's configuration
 * directory — the value that decides which login answers — is what makes work
 * and personal separable on the Mac, and a phone has no use for it. And the
 * agent's own identity answer, the email and organisation behind a login, is
 * left behind too: it is the one field on AccountLimits that identifies a
 * person rather than a quota, the question this screen asks is "what is left",
 * and the operator's own label for the account already answers "whose".
 *
 * Nothing here forces a fresh probe. The desktop's Refresh button starts real
 * CLI processes on purpose and only when someone asks; a phone screen that is
 * polled while it is open must not be a second, silent trigger for that. So the
 * route serves the reading the Mac already had and says how old it is, which is
 * the honest answer rather than a convenient one.
 */

/** The panels this seam answers for. Anything else is a 404, not a default. */
const PANELS = new Set(['spend']);

/**
 * The consumption windows the phone may ask for.
 *
 * A closed set, checked here, because everything the page sends is untrusted
 * until the main process has validated it. It is deliberately narrower than the
 * desktop's 7/14/30/90: ninety days is a reconciliation window you read at a
 * desk, and the question this screen exists to answer away from one is whether
 * money is being burned now.
 */
const DAYS = new Set([7, 14, 30]);

/**
 * How long a composed reading is reused before the source is asked again.
 *
 * The frame's watcher re-runs a visible screen's read on every poll, which is
 * every three seconds. The spend half of this payload is two grouped SQL
 * aggregates over up to thirty days of API events, run on the same synchronous
 * database handle the session recorder writes through — so re-aggregating it
 * twenty times a minute for a screen sitting in someone's pocket would spend
 * the main thread that owns the live PTYs. The ages and countdowns below are
 * recomputed per request regardless, so a reused reading is never served with a
 * frozen clock attached to it.
 */
const CACHE_MS = 15_000;

const MAX_ACCOUNTS = 40;
const MAX_WINDOWS = 12;
/** The busiest account/model pairs by output tokens, which is the order usage.ts returns. */
const MAX_ROWS = 60;
const MAX_JSON_BYTES = 256 * 1024;
/**
 * Generous on purpose. The limits half can be a live CLI probe with a
 * sixty-second bound of its own, so the three-second bound /api/status uses
 * would report a read that is working as a read that is broken.
 */
const SOURCE_TIMEOUT_MS = 45_000;

/** One limit window, as the provider reported it. */
export type MobileSpendWindow = {
  /** 'session', 'week', or whatever word the provider used. */
  kind: string;
  /** null for an all-models window; a model name otherwise. */
  scope: string | null;
  usedPercent: number;
  /**
   * The provider's own words for the reset, or null when it named no reset.
   *
   * Both this and resetsInMs are null for a window the agent printed bare, and
   * that pair is the contract the page renders "no reset time" from. A window
   * with nothing used yet has no reset to announce, and turning that absence
   * into a guessed time would be inventing a claim the provider declined to
   * make.
   */
  resetsAtText: string | null;
  /**
   * How long until the reset, measured on the Mac's clock at the moment this
   * payload was built. A phone adds the time since the bytes arrived, measured
   * on its own clock; neither clock is ever subtracted from the other, so a
   * couple of minutes of skew cannot read as a countdown that is wrong.
   */
  resetsInMs: number | null;
};

/** What one account has left, and how old that reading is. */
export type MobileSpendAccount = {
  id: string;
  label: string;
  /** The display word for the agent this login belongs to, never the harness id. */
  harnessLabel: string;
  plan: string | null;
  state: AccountLimits['state'];
  /** Why, when the state is not 'ok' — and sometimes when it is: Codex reports
   *  a spend control separately from its percentages. */
  detail: string | null;
  /** Age of the reading on the Mac's clock, or null when there was no reading. */
  readAgeMs: number | null;
  windows: MobileSpendWindow[];
};

/** One account and model pair, from Wanigan's own record of what ran. */
export type MobileSpendRow = {
  accountId: string | null;
  accountLabel: string;
  model: string;
  requests: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  costUsd: number;
  /** 'reported' only when every request in this row carried a provider cost. */
  costStatus: ModelConsumption['costStatus'];
};

export type MobileSpendTotals = {
  requests: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  costUsd: number;
  costStatus: ModelConsumption['costStatus'];
};

export type MobileSpendPayload = {
  generatedAt: number;
  /** The window these figures actually cover, so a heading can be drawn from
   *  the answer rather than from what the page asked for. */
  days: number;
  /** Past this age a limit reading is presented as stale rather than as current. */
  staleAfterMs: number;
  accounts: MobileSpendAccount[];
  rows: MobileSpendRow[];
  /** Account/model pairs before the row cap, so a truncated list can say so. */
  modelCount: number;
  truncated: boolean;
  totals: MobileSpendTotals;
};

/**
 * Where the Explore screens' bytes come from. Registered by the app rather than
 * imported here, exactly as ./snapshot and ./control do it: this module reaches
 * no further than the HTTP boundary it guards, and the offline suite can hand
 * it a fixture without a database or a CLI on the machine.
 */
export type MobileExploreSource = {
  spend: (input: { days: number }) => UsageSnapshot | Promise<UsageSnapshot>;
};

let exploreSource: MobileExploreSource | null = null;
type Cached = { at: number; snapshot: UsageSnapshot };
const cache = new Map<number, Cached>();

/** Register the only source of bytes returned by /api/explore. */
export function configureMobileExploreSource(source: MobileExploreSource | null): void {
  exploreSource = source;
  // A new source is a new answer. Serving the old one for another fifteen
  // seconds would be this route reporting a reading nothing on the Mac holds.
  cache.clear();
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function money(value: unknown): number {
  return Math.max(0, finite(value));
}

function costStatus(value: unknown): ModelConsumption['costStatus'] {
  return value === 'partial' || value === 'unreported' ? value : 'reported';
}

const STATES: ReadonlySet<string> = new Set(['ok', 'signed-out', 'unreadable', 'unsupported', 'stale']);

function wireWindow(raw: LimitWindow & Record<string, unknown>, now: number): MobileSpendWindow {
  const resetsAt = raw.resetsAt === null ? null : finite(raw.resetsAt, 0) || null;
  return {
    kind: safeString(raw.kind, 40, 'limit window'),
    scope: raw.scope === null ? null : safeString(raw.scope, 60) || null,
    usedPercent: Math.max(0, Math.min(100, finite(raw.usedPercent))),
    // Kept verbatim because it is the primary display: claude-limits.ts parses
    // the epoch on a best-effort basis and says so, and the words the agent
    // printed are true even on a machine in another time zone.
    resetsAtText: raw.resetsAtText === null ? null : safeString(raw.resetsAtText, 120) || null,
    // Signed on purpose: a window that has just passed its reset reads as
    // "resetting now" on the page rather than as a countdown clamped to zero.
    resetsInMs: resetsAt === null ? null : resetsAt - now,
  };
}

function wireAccount(input: AccountLimits, now: number): MobileSpendAccount {
  const raw = input as AccountLimits & Record<string, unknown>;
  const windows = Array.isArray(raw.windows) ? raw.windows.slice(0, MAX_WINDOWS) : [];
  const fetchedAt = raw.fetchedAt === null ? null : finite(raw.fetchedAt, 0) || null;
  return {
    id: safeString(raw.accountId, 120),
    label: safeString(raw.accountLabel, 120, 'Unnamed account'),
    harnessLabel: safeString(harnessLabel(safeString(raw.harness, 60)), 60, 'Agent'),
    plan: raw.plan === null ? null : safeString(raw.plan, 60) || null,
    state: STATES.has(String(raw.state)) ? raw.state : 'unreadable',
    detail: raw.detail === null ? null : safeString(raw.detail, 400) || null,
    // Measured here rather than sent as a timestamp. The phone would otherwise
    // have to subtract a Mac clock from its own, which turns a couple of
    // minutes of skew into staleness that never happened.
    readAgeMs: fetchedAt === null ? null : Math.max(0, now - fetchedAt),
    windows: windows.map((window) => wireWindow(window as LimitWindow & Record<string, unknown>, now)),
  };
}

function wireRow(input: ModelConsumption): MobileSpendRow {
  const raw = input as ModelConsumption & Record<string, unknown>;
  return {
    // Carried for the same reason ./snapshot carries it: two accounts can share
    // a label, and without the id they collapse into one row on the page.
    accountId: raw.accountId === null ? null : safeString(raw.accountId, 120) || null,
    accountLabel: safeString(raw.accountLabel, 120, 'No account'),
    model: safeString(raw.model, 120, 'unnamed model'),
    requests: count(raw.requests),
    inTokens: count(raw.inTokens),
    outTokens: count(raw.outTokens),
    cacheRead: count(raw.cacheRead),
    costUsd: money(raw.costUsd),
    costStatus: costStatus(raw.costStatus),
  };
}

/**
 * The fleet's cost for the window, and how much of it the providers actually
 * reported.
 *
 * A provider that reported nothing is not a provider that cost nothing, so the
 * status travels with the figure and the page never prints an unreported total
 * as $0.00. With no rows at all the vacuous 'reported' is the true answer: no
 * request was made, so nothing was withheld and the zero is a real zero.
 */
function wireTotals(rows: readonly MobileSpendRow[]): MobileSpendTotals {
  const totals = {
    requests: 0, inTokens: 0, outTokens: 0, cacheRead: 0, costUsd: 0,
    costStatus: 'reported' as ModelConsumption['costStatus'],
  };
  for (const row of rows) {
    totals.requests += row.requests;
    totals.inTokens += row.inTokens;
    totals.outTokens += row.outTokens;
    totals.cacheRead += row.cacheRead;
    totals.costUsd += row.costUsd;
  }
  const reported = rows.filter((row) => row.costStatus === 'reported').length;
  const unreported = rows.filter((row) => row.costStatus === 'unreported').length;
  totals.costStatus = reported === rows.length ? 'reported'
    : unreported === rows.length ? 'unreported'
      : 'partial';
  return totals;
}

/**
 * Structural typing lets a caller hold extra properties even when the function
 * says UsageSnapshot. Rebuild the response from an allow-list so those
 * properties never cross the HTTP boundary — and so the daily series, which is
 * the shape of last week's curve rather than an answer to "am I burning
 * money", stays on the Mac where the reconciliation tables are.
 */
function spendPayload(input: UsageSnapshot, days: number, now: number): MobileSpendPayload {
  const value = input as UsageSnapshot & Record<string, unknown>;
  const accounts = Array.isArray(value.limits) ? value.limits.slice(0, MAX_ACCOUNTS) : [];
  const consumption = Array.isArray(value.consumption) ? value.consumption : [];
  const rows = consumption.map(wireRow);
  return {
    generatedAt: now,
    // The window the source answered for, not the one that was asked. A page
    // that draws its heading from its own request can caption fourteen days of
    // figures "last 30 days" and never notice.
    days: DAYS.has(count(value.days)) ? count(value.days) : days,
    staleAfterMs: STALE_AFTER_MS,
    accounts: accounts.map((account) => wireAccount(account, now)),
    rows: rows.slice(0, MAX_ROWS),
    modelCount: rows.length,
    truncated: rows.length > MAX_ROWS,
    // Deliberately over every row, not over the rows that survived the cap: a
    // truncated list must not quietly reduce the total it sits under.
    totals: wireTotals(rows),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('explore source timed out')), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function spendSnapshot(days: number): Promise<UsageSnapshot> {
  const hit = cache.get(days);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.snapshot;
  const source = exploreSource;
  if (!source) throw new Error('unconfigured');
  const snapshot = await withTimeout(Promise.resolve().then(() => source.spend({ days })), SOURCE_TIMEOUT_MS);
  cache.set(days, { at: Date.now(), snapshot });
  return snapshot;
}

async function serveExplore(res: http.ServerResponse, url: URL): Promise<void> {
  const panel = url.searchParams.get('panel') ?? '';
  if (!PANELS.has(panel)) { json(res, 404, { error: 'Wanigan has no such explore panel.' }); return; }

  const asked = Number(url.searchParams.get('days'));
  if (!DAYS.has(asked)) {
    // Refused rather than clamped. A clamp answers a question nobody asked and
    // the figures would then disagree with whatever the caller believes it
    // requested, which is the one failure a spend screen must not have.
    json(res, 400, { error: 'Ask for a 7, 14 or 30 day window.' });
    return;
  }
  if (!exploreSource) { json(res, 503, { error: 'The mobile explore source is not configured.' }); return; }

  try {
    const body = JSON.stringify(spendPayload(await spendSnapshot(asked), asked, Date.now()));
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
      json(res, 503, { error: 'The mobile spend reading is too large to serve safely.' });
      return;
    }
    send(res, 200, 'application/json; charset=utf-8', body);
  } catch {
    // Source errors can carry local paths, database details, or the text a CLI
    // printed on its way to failing. The phone needs to know the read failed,
    // not which local byte made it fail.
    json(res, 503, { error: 'Wanigan could not read what the accounts have left.' });
  }
}

registerApiRoute({
  path: '/api/explore',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res, url) => serveExplore(res, url),
});
