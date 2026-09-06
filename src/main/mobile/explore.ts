import type http from 'node:http';
import { STALE_AFTER_MS } from '../claude-limits';
import { json, registerApiRoute, send } from './dispatch';
import { safeString } from './snapshot';
import { harnessLabel } from '../../shared/types';
import type { AccountLimits, LimitWindow, ModelConsumption, UsageSnapshot } from '../../shared/types';
// A type, so nothing in spend.ts is loaded to serve this route. The shape is
// imported rather than restated because the wiring in index.ts has to hand over
// exactly what spend.ts decided, and a second declaration of it here is how the
// two start describing different breaches.
import type { BudgetBreach } from '../spend';

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
 *
 * The third thing on this wire is the breach reading below, which is the reason
 * the screen gets opened at all. It is composed here rather than on the page
 * because both halves of it are decisions — which line was crossed, and whether
 * a reading establishes anything — and a decision made in the renderer is a
 * decision made outside the trust boundary.
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
 * the main thread that owns the live PTYs. The budget half is a further handful
 * of month-to-date sums per budget on record, on that same handle, which is why
 * it is held to the same window. The ages and countdowns below are recomputed
 * per request regardless, so a reused reading is never served with a frozen
 * clock attached to it.
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

/**
 * The percentage at which a limit window is reported as close to its limit.
 *
 * The same number the desktop's Usage meter paints critical at, and the same
 * number this screen's own meter already bands at. A phone that called a window
 * "close" at a different figure from the Mac would be a second vocabulary for
 * one fact, and two surfaces disagreeing about one reading is worse than either
 * of them being blunt.
 */
const NEAR_PERCENT = 95;

/** Caps on the two breach lists. Neither is a place to page through. */
const MAX_BUDGET_BREACHES = 12;
const MAX_LIMIT_BREACHES = 24;

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

/* ── the breach reading ────────────────────────────────────────────────────
 *
 * What the fleet cost and what each account has left are both answers to
 * questions somebody sat down and asked. The reason to open this screen away
 * from a desk is a different question: has something gone past a line, and does
 * it need me now. So the breach reading is composed first and printed first.
 *
 * Two kinds of line exist in this build and they stay apart because they are
 * different kinds of fact. A budget is a monthly cap the operator set for
 * themselves under Insights › Budgets, measured against Wanigan's own recorded
 * spend; spend.ts decides which of its three lines was crossed and this route
 * repeats that decision rather than recomputing it, so the phone and the Mac
 * cannot come to different conclusions about the same dollar. A limit window is
 * the provider's own ceiling, read live from the account, and Wanigan holds
 * exactly one reading of it.
 *
 * That single reading is why nothing here says "since". No history of a
 * window's percentage is kept anywhere, so the moment it crossed its limit was
 * never observed, and printing one would be an invention dressed as evidence.
 * What each entry carries instead is the value that was measured and the age of
 * the reading carrying it — which is what separates a state from a rumour, and
 * is the whole of what Wanigan can stand behind.
 *
 * One figure on this screen is arithmetic about days that have not happened:
 * spend.ts's run rate. It travels with basis 'estimate' and it is the only
 * entry that does, so the page can say so where the figure is read rather than
 * under it. Nothing is blended into a score — each line reports itself, and a
 * budget being fine has never meant an account has room.
 */

/** One monthly budget that is past one of its three lines. */
export type MobileSpendBudgetBreach = {
  /** Which line was crossed, in spend.ts's own words. 'unknown' is a reason
   *  this build does not recognise, and the page prints only measured figures
   *  for it rather than guessing which line it was. */
  reason: BudgetBreach['reason'] | 'unknown';
  /**
   * Whether the figure that crossed the line was measured or projected.
   *
   * Carried rather than left for the page to infer from the reason, because
   * this is the one distinction on the screen that must survive a later edit to
   * either side: an estimate has to announce itself at the point it is read.
   */
  basis: 'measured' | 'estimate';
  /** The project this cap covers, or null for the cap over everything. Two
   *  scopes can share a display name, which is the only reason the id travels. */
  scopeId: string | null;
  /** The operator's own name for that scope. A project name, never its path. */
  scopeName: string;
  limitUsd: number;
  spentUsd: number;
  /** The warning line, in dollars and as the percentage that set it. */
  warnUsd: number;
  warnPercent: number;
  /** Month-end spend at the rate of the days so far. An estimate, always. */
  projectedUsd: number;
  /** The month these figures cover, in the Mac's own words, and how far into
   *  it the run rate was taken — which is what makes a run rate readable. */
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
};

/**
 * Why one account or one of its windows is not clear.
 *
 * 'stale' and 'unread' are here because "nothing is wrong" needs a successful
 * read behind it. A reading Wanigan could not take, and a reading old enough
 * that it calls itself stale, are each their own answer — reporting either as
 * clear would be the empty fleet on a sleeping Mac wearing a spend screen's
 * name.
 */
export type MobileSpendLimitReason = 'past' | 'control' | 'near' | 'unread' | 'stale';

export type MobileSpendLimitBreach = {
  reason: MobileSpendLimitReason;
  accountId: string;
  accountLabel: string;
  harnessLabel: string;
  /** The state the reading came back in, so the page words an unread account
   *  from the state rather than by parsing the sentence below back apart. */
  accountState: AccountLimits['state'];
  /** The window, when this is about one; null when it is about the account. */
  kind: string | null;
  scope: string | null;
  /** What was measured. null when nothing was, and never a rate. */
  usedPercent: number | null;
  /** Age of the reading on the Mac's clock; null when there was never one. */
  readAgeMs: number | null;
  resetsAtText: string | null;
  resetsInMs: number | null;
  /** The provider's or Wanigan's own sentence, never a paraphrase of one. */
  detail: string | null;
  /**
   * Another account of the same agent whose same window still has room, in the
   * same reading. A measured pairing, not advice about where to work.
   */
  relief: { accountLabel: string; usedPercent: number } | null;
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
  /**
   * Whether the budgets could be read at all.
   *
   * false is "Wanigan could not read them", which is a different answer from an
   * empty list — that one says every budget on record was checked and none is
   * past a line. sessions.ts already holds the other half of this rule: an
   * unreadable budgets table is evidence about spend and never a gate on work,
   * so a failure here must not take the limits and the cost reading down with
   * it.
   */
  budgetsRead: boolean;
  /** Budgets past one of their lines, most-pressed first — spend.ts's own
   *  order, which puts a cap genuinely exceeded above one only trending over. */
  budgetBreaches: MobileSpendBudgetBreach[];
  budgetBreachesOmitted: number;
  /** Budgets on record that actually carry a cap. A budget of 0 tracks spend
   *  without capping it and cannot be breached, so it is not counted here — and
   *  a count of zero is why the page must not say "no budget is over". */
  budgetsCapped: number;
  /** Accounts and windows that are not clear, worst first. */
  limitBreaches: MobileSpendLimitBreach[];
  limitBreachesOmitted: number;
  /** Windows that were read, are not stale, and are below nearPercent. The
   *  evidence behind "nothing is over its limit"; never a score. */
  clearWindows: number;
  /** The figure clearWindows was counted against, so the page's sentence names
   *  the same number the reading used. */
  nearPercent: number;
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
  /**
   * The budget reading, which is a second call because it is a second question.
   *
   * `breached` is spend.ts's own answer, in its own order, and `capped` is how
   * many budgets on record carry a cap at all. Both are needed: an empty
   * `breached` alongside a `capped` of zero means nothing was checked, and a
   * page told only the first of those would print "no budget is over" for an
   * operator who has never set one.
   *
   * Asked at most once per CACHE_MS, and only while the Spend screen is open.
   */
  budgets: () => MobileExploreBudgets | Promise<MobileExploreBudgets>;
};

export type MobileExploreBudgets = {
  breached: readonly BudgetBreach[];
  capped: number;
};

let exploreSource: MobileExploreSource | null = null;
type Cached = { at: number; snapshot: UsageSnapshot };
const cache = new Map<number, Cached>();
/** Held apart from `cache` because a budget does not depend on the consumption
 *  window: keying it by days would read the same month three times over. */
let budgetCache: { at: number; value: MobileExploreBudgets } | null = null;

/** Register the only source of bytes returned by /api/explore. */
export function configureMobileExploreSource(source: MobileExploreSource | null): void {
  exploreSource = source;
  // A new source is a new answer. Serving the old one for another fifteen
  // seconds would be this route reporting a reading nothing on the Mac holds.
  cache.clear();
  budgetCache = null;
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

/**
 * spend.ts's three reasons, checked rather than trusted.
 *
 * The union comes from this process, so an unrecognised value means a fixture
 * lied about a shape — and the page's answer to that is the same one the runs
 * screen already gives an unrecognised status: name it as unrecognised and
 * print only what was measured. Quietly re-labelling it as one of the three
 * would be this route inventing which line was crossed.
 */
const BUDGET_REASONS: ReadonlySet<string> = new Set(['over-budget', 'warning-threshold', 'projected-over']);

function wireBudget(input: BudgetBreach): MobileSpendBudgetBreach {
  const raw = input as BudgetBreach & Record<string, unknown>;
  const reason = BUDGET_REASONS.has(String(raw.reason)) ? raw.reason : 'unknown';
  const window = (raw.window ?? {}) as Record<string, unknown>;
  const warnAt = Math.max(0, Math.min(1, finite(raw.warnAt)));
  return {
    reason,
    // Only the run rate is arithmetic about a month that has not happened, so
    // only the run rate is an estimate. Everything else on this entry is a sum
    // over rows the providers already reported.
    basis: reason === 'projected-over' ? 'estimate' : 'measured',
    scopeId: raw.scopeId === null || raw.scopeId === undefined ? null : safeString(raw.scopeId, 120) || null,
    scopeName: safeString(raw.scopeName, 120, 'This budget'),
    limitUsd: money(raw.limitUsd),
    spentUsd: money(raw.spentUsd),
    warnUsd: money(raw.warnUsd),
    warnPercent: Math.round(warnAt * 100),
    projectedUsd: money(raw.projectedUsd),
    monthLabel: safeString(window.monthLabel, 40, 'this month'),
    daysElapsed: count(window.daysElapsed),
    daysInMonth: count(window.daysInMonth),
  };
}

/** An account's wired row beside the harness id that decides what it can be
 *  compared with. The id itself stays off the wire; only the label crosses. */
type WiredAccount = { row: MobileSpendAccount; harness: string };

const windowKey = (kind: string, scope: string | null): string => `${kind}:${scope ?? 'all'}`;

/**
 * Another account of the same agent whose same window still has room.
 *
 * The same comparison the desktop's Usage screen makes, with the same three
 * clauses and for the same reasons: the same harness, because a Codex login
 * with room does not help an exhausted Claude window; the same window kind and
 * model scope, because a session limit is not a weekly one; and both readings
 * complete, because this reports a measured pairing rather than an opinion
 * about where the next agent should run. The emptiest alternative, so the
 * sentence names one account instead of listing every candidate.
 */
function reliefFor(
  source: WiredAccount,
  window: MobileSpendWindow,
  all: readonly WiredAccount[],
): MobileSpendLimitBreach['relief'] {
  const key = windowKey(window.kind, window.scope);
  let best: MobileSpendLimitBreach['relief'] = null;
  for (const other of all) {
    if (other.row.id === source.row.id || other.harness !== source.harness) continue;
    if (other.row.state !== 'ok') continue;
    for (const candidate of other.row.windows) {
      if (windowKey(candidate.kind, candidate.scope) !== key) continue;
      if (candidate.usedPercent >= 100) continue;
      if (!best || candidate.usedPercent < best.usedPercent) {
        best = { accountLabel: other.row.label, usedPercent: candidate.usedPercent };
      }
    }
  }
  return best;
}

const LIMIT_RANK: Record<MobileSpendLimitReason, number> = {
  past: 0, control: 1, near: 2, unread: 3, stale: 4,
};

/**
 * Every account reading that is not clear, and the count of the windows that
 * are.
 *
 * A window is measured against NEAR_PERCENT and nothing else; there is no
 * blended figure for an account and none for the fleet, because "this login is
 * 80% healthy" is not a sentence anyone can act on. An account that could not
 * be read at all reports that, an account whose reading has gone stale reports
 * that, and neither is counted as clear.
 *
 * A complete reading can still carry something the percentages do not say:
 * limits.ts attaches a detail to an otherwise-fine account exactly once, for
 * the Codex spend control, and that is the fact which explains a refused run
 * while every window still looks fine. It is passed through in the provider's
 * own words rather than classified here.
 */
function limitBreachesFor(
  all: readonly WiredAccount[],
  staleAfterMs: number,
): { breaches: MobileSpendLimitBreach[]; clearWindows: number } {
  const breaches: MobileSpendLimitBreach[] = [];
  let clearWindows = 0;

  for (const entry of all) {
    const row = entry.row;
    const stale = row.readAgeMs !== null && row.readAgeMs > staleAfterMs;
    const base: Omit<MobileSpendLimitBreach, 'reason'> = {
      accountId: row.id,
      accountLabel: row.label,
      harnessLabel: row.harnessLabel,
      accountState: row.state,
      kind: null,
      scope: null,
      usedPercent: null,
      readAgeMs: row.readAgeMs,
      resetsAtText: null,
      resetsInMs: null,
      detail: row.detail,
      relief: null,
    };

    if (row.state !== 'ok') {
      // 'stale' is a state the Mac declares about its own reading; everything
      // else here is an account Wanigan could not get an answer out of. Which
      // one it was travels as accountState, so the page words it from the state
      // rather than by reading the sentence back apart.
      breaches.push({ ...base, reason: row.state === 'stale' ? 'stale' : 'unread' });
      continue;
    }
    if (!row.windows.length) {
      breaches.push({ ...base, reason: 'unread' });
      continue;
    }

    let named = 0;
    for (const window of row.windows) {
      if (window.usedPercent < NEAR_PERCENT) {
        // Only a reading Wanigan still calls current counts as clear. A stale
        // one is not evidence that the window is below the line now; it is
        // evidence of where it was.
        if (!stale) clearWindows += 1;
        continue;
      }
      named += 1;
      breaches.push({
        ...base,
        reason: window.usedPercent >= 100 ? 'past' : 'near',
        kind: window.kind,
        scope: window.scope,
        usedPercent: window.usedPercent,
        resetsAtText: window.resetsAtText,
        resetsInMs: window.resetsInMs,
        // The account's sentence belongs to the account entry below, not
        // repeated under each of its windows.
        detail: null,
        relief: window.usedPercent >= 100 ? reliefFor(entry, window, all) : null,
      });
    }
    if (row.detail !== null) { breaches.push({ ...base, reason: 'control' }); named += 1; }
    // Said only when nothing else about this account was said. A stale reading
    // that already reported a full window does not need a second card to
    // report that it is old; the age travels on the entry either way.
    if (!named && stale) breaches.push({ ...base, reason: 'stale' });
  }

  breaches.sort((a, b) =>
    LIMIT_RANK[a.reason] - LIMIT_RANK[b.reason]
    || (b.usedPercent ?? -1) - (a.usedPercent ?? -1)
    || a.accountLabel.localeCompare(b.accountLabel)
    || (a.kind ?? '').localeCompare(b.kind ?? ''));
  return { breaches, clearWindows };
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
function spendPayload(
  input: UsageSnapshot,
  budgets: MobileExploreBudgets | null,
  days: number,
  now: number,
): MobileSpendPayload {
  const value = input as UsageSnapshot & Record<string, unknown>;
  const accounts = Array.isArray(value.limits) ? value.limits.slice(0, MAX_ACCOUNTS) : [];
  const consumption = Array.isArray(value.consumption) ? value.consumption : [];
  const rows = consumption.map(wireRow);
  // Wired once, then read twice: the cards below and the breach reading above
  // are built from the same array, so a figure cannot be rounded one way at the
  // top of the screen and another way in the middle of it.
  const wired: WiredAccount[] = accounts.map((account) => ({
    row: wireAccount(account, now),
    harness: safeString((account as AccountLimits & Record<string, unknown>).harness, 60),
  }));
  const limits = limitBreachesFor(wired, STALE_AFTER_MS);
  const breached = budgets && Array.isArray(budgets.breached) ? budgets.breached : [];
  const budgetBreaches = breached.map(wireBudget);
  return {
    generatedAt: now,
    // The window the source answered for, not the one that was asked. A page
    // that draws its heading from its own request can caption fourteen days of
    // figures "last 30 days" and never notice.
    days: DAYS.has(count(value.days)) ? count(value.days) : days,
    staleAfterMs: STALE_AFTER_MS,
    accounts: wired.map((entry) => entry.row),
    budgetsRead: budgets !== null,
    // Sliced, never re-sorted: spend.ts already ordered these most-pressed
    // first, and a second ordering rule here is how the two surfaces start
    // disagreeing about which budget matters most.
    budgetBreaches: budgetBreaches.slice(0, MAX_BUDGET_BREACHES),
    budgetBreachesOmitted: Math.max(0, budgetBreaches.length - MAX_BUDGET_BREACHES),
    budgetsCapped: budgets === null ? 0 : count(budgets.capped),
    limitBreaches: limits.breaches.slice(0, MAX_LIMIT_BREACHES),
    limitBreachesOmitted: Math.max(0, limits.breaches.length - MAX_LIMIT_BREACHES),
    clearWindows: limits.clearWindows,
    nearPercent: NEAR_PERCENT,
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

/**
 * The budget reading, or null when it could not be taken.
 *
 * Null travels rather than throwing, and that is the point: an unreadable
 * budgets table is a fact about the budgets, not a reason to stop reporting
 * what the accounts have left and what the fleet spent. sessions.ts made the
 * same call for the same reason at the one place that starts an agent. Only
 * successes are cached, so a table that comes back is reported the moment it
 * does.
 */
async function budgetReading(): Promise<MobileExploreBudgets | null> {
  const hit = budgetCache;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const source = exploreSource;
  if (!source) return null;
  try {
    const value = await withTimeout(Promise.resolve().then(() => source.budgets()), SOURCE_TIMEOUT_MS);
    budgetCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
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
    const [snapshot, budgets] = await Promise.all([spendSnapshot(asked), budgetReading()]);
    const body = JSON.stringify(spendPayload(snapshot, budgets, asked, Date.now()));
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
