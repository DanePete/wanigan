import type http from 'node:http';
import { listSources, listSuggestions, overview } from '../improvement-scout';
import type {
  ImprovementScoutEvidence,
  ImprovementScoutOverview,
  ImprovementScoutRun,
  ImprovementScoutSource,
  ImprovementScoutSuggestion,
} from '../../shared/types';
import { json, registerApiRoute, send } from './dispatch';
import { safeString } from './snapshot';

/**
 * The Scout's weekly digest, read from a phone.
 *
 * The Scout is a research inbox: it reads a fixed allow-list of official pages
 * on a schedule the operator armed, matches what it read against Wanigan's own
 * capability inventory with deterministic rules, and files the result as
 * proposals with their evidence attached. This is the read of that inbox, and
 * it is a read and nothing else — 'monitor' scope, GET only, no POST at any
 * scope. Turning a proposal into a Goal writes an acceptance contract against a
 * repository the phone does not have, and starting a scan is egress the
 * operator consents to at the machine holding the allow-list. Both stay on the
 * Mac, and the screen says so rather than offering a button that does something
 * smaller than its label.
 *
 * The fact this module exists to carry is the last scan's outcome. A run
 * reports 'running', 'completed', 'blocked' or 'failed', and the last three are
 * not the same fact: 'blocked' means a consent gate stopped the pass before it
 * contacted anything, and rendering that as a completed scan is the app
 * claiming an online check happened at the moment the code declined to make
 * one. The desktop view carried a constant sentence there once and said exactly
 * that; the phone is built from the fixed version rather than repeating it, so
 * the status travels as its own field and the stored explanation travels with
 * it.
 *
 * The second fact is the analyser. This build matches with local deterministic
 * rules and sends no source text to any model, which the desktop promises in
 * so many words. A promise a second surface quietly drops is worse than one
 * never made, so `analysisMethod` crosses verbatim and `deterministic` is true
 * only for the method this build actually runs — a later analyser arrives here
 * as its own name with no promise attached rather than inheriting this one.
 *
 * What deliberately does not cross: a proposal's `score`. It is a rule-table
 * output between 0 and 100 and it looks exactly like a measurement, which is
 * why the desktop queue stopped opening on it. Confidence does cross, because
 * it is labelled as rule-derived where it is shown and never sorted on.
 */

/** Open proposals composed into one response; the rest stay on the Mac. */
const MAX_PROPOSALS = 20;

/**
 * How many open proposals are read before the cap is applied.
 *
 * Reading a suggestion costs a second query for its evidence, so this is 60
 * suggestion rows plus 60 evidence reads on the same synchronous handle the
 * session recorder writes through. It is bounded rather than unbounded for
 * that reason alone, and the response says when the read itself hit this
 * ceiling so a count drawn from it is never printed as a total it is not.
 */
const READ_LIMIT = 60;

/** Evidence rows per proposal, newest first as the repository returns them. */
const MAX_EVIDENCE = 3;

/**
 * How much of a stored excerpt crosses.
 *
 * The Scout stores up to 900 characters per evidence row, and twenty proposals
 * with three sources each would put roughly 54 KB of source prose on a cellular
 * radio for a screen someone is skimming. Cut to a readable passage — and the
 * cut is announced on the row it happened to, because an excerpt that stops
 * mid-sentence with no note is indistinguishable from a source that trailed off
 * there.
 */
const EXCERPT_CHARS = 300;

/** The allow-list is a static registry of a handful of pages; this is slack. */
const MAX_SOURCES = 24;

/**
 * How long a composed reading is reused before the records are read again.
 *
 * The frame re-runs a visible screen's read on every poll, which is every three
 * seconds, and this composition is up to a hundred and twenty small synchronous
 * queries. The Scout's records change when a scan runs or when the operator
 * acts on a proposal at the Mac — neither of which happens twenty times a
 * minute — so the reading is reused briefly and its age travels with it rather
 * than being hidden.
 */
const CACHE_MS = 15_000;

const MAX_JSON_BYTES = 256 * 1024;

/**
 * What the phone is told when the Scout's records will not open. It names the
 * fact the page cannot establish on its own — the Mac was reached — rather than
 * restating the failure the page is already printing above it. A database error
 * can carry a local path or a table name, so it does not travel.
 */
const READ_FAILED = 'The Mac answered, but its record of the Scout would not open.';

/**
 * A scan's outcome, as a closed set the page can render.
 *
 * 'unknown' is here as a second fence rather than the first. ../improvement-
 * scout's own mapper already narrows the stored column, and it narrows it by
 * coercing anything unfamiliar to 'completed' — which is the one direction this
 * boundary must never inherit. Narrowing again here means a status this build
 * has never been taught to read arrives on the phone as a status this build
 * cannot name, and the day that mapper learns a fifth word the phone will say
 * so instead of quietly reporting a success.
 */
export type MobileScoutRunStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'unknown';

const RUN_STATUSES = new Map<string, MobileScoutRunStatus>([
  ['running', 'running'],
  ['completed', 'completed'],
  ['blocked', 'blocked'],
  ['failed', 'failed'],
]);

const RUN_MODES = new Map<string, ImprovementScoutRun['mode']>([
  ['manual', 'manual'],
  ['preview', 'preview'],
  ['scheduled', 'scheduled'],
]);

const PROPOSAL_STATUSES = new Map<string, MobileScoutProposal['status']>([
  ['new', 'new'],
  ['reviewed', 'reviewed'],
  ['snoozed', 'snoozed'],
  ['dismissed', 'dismissed'],
  ['goal-created', 'goal-created'],
]);

const SOURCE_STATUSES = new Map<string, MobileScoutSource['lastStatus']>([
  ['never', 'never'],
  ['ok', 'ok'],
  ['failed', 'failed'],
  ['skipped', 'skipped'],
]);

/** One scan, with the outcome it actually had. */
export type MobileScoutRun = {
  mode: ImprovementScoutRun['mode'];
  status: MobileScoutRunStatus;
  /**
   * Whether this pass was permitted to contact a source at all. A completed
   * local pass and a completed online pass are different events, and a screen
   * that renders them identically claims an online check that never happened.
   */
  networkAllowed: boolean;
  sourceCount: number;
  evidenceCount: number;
  proposalCount: number;
  startedAt: number;
  endedAt: number | null;
  /** Wanigan's own stored account of how the pass ended, bounded. */
  detail: string | null;
  /** Written only for a pass that broke; null for one a consent gate stopped. */
  error: string | null;
};

export type MobileScoutEvidence = {
  title: string;
  /** https only, or null. A source that will not parse as one gets no link. */
  url: string | null;
  publisher: string | null;
  publishedAt: number | null;
  excerpt: string;
  /** True when the passage above stops because this boundary cut it. */
  excerptTruncated: boolean;
};

export type MobileScoutProposal = {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: 'new' | 'reviewed' | 'snoozed' | 'dismissed' | 'goal-created';
  whyNow: string;
  recommendation: string;
  effort: ImprovementScoutSuggestion['effort'];
  risk: ImprovementScoutSuggestion['risk'];
  /** A rule-table output between 0 and 1. Labelled as such where it is shown. */
  confidence: number;
  foundAt: number;
  /** Whether a Goal already exists for this proposal — the id itself stays on the Mac. */
  goalLinked: boolean;
  evidence: MobileScoutEvidence[];
  /** Evidence rows before the per-proposal cap, so a shortened list can say so. */
  evidenceCount: number;
  evidenceTruncated: boolean;
};

export type MobileScoutSource = {
  label: string;
  publisher: string;
  enabled: boolean;
  lastStatus: 'never' | 'ok' | 'failed' | 'skipped';
  lastCheckedAt: number | null;
  lastDetail: string | null;
};

export type MobileScoutPayload = {
  generatedAt: number;
  /**
   * How old the composed reading was when it was served, measured entirely on
   * the Mac's clock. The phone adds the time since the bytes arrived, measured
   * on its own; the two clocks are never subtracted from each other, so skew
   * cannot read as staleness that never happened.
   */
  readAgeMs: number;
  workspaceEnabled: boolean;
  onlineResearchEnabled: boolean;
  weeklyEnabled: boolean;
  cadenceLabel: string;
  /** Null unless the weekly schedule is actually armed. Never a guessed time. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRun: MobileScoutRun | null;
  /** The analyser's own name for itself, carried verbatim. */
  analysisMethod: string;
  /** True only for the analyser this build runs. A later one inherits no promise. */
  deterministic: boolean;
  pendingProposals: number;
  sourceCount: number;
  enabledSourceCount: number;
  sources: MobileScoutSource[];
  proposals: MobileScoutProposal[];
  /** Open proposals read before the cap above. */
  openCount: number;
  truncated: boolean;
  /** True when the read hit READ_LIMIT, so `openCount` is a floor and not a total. */
  readCapped: boolean;
};

/** The caps, exported so the offline suite can prove them rather than restate them. */
export const MOBILE_SCOUT_LIMITS = {
  proposals: MAX_PROPOSALS,
  readLimit: READ_LIMIT,
  evidencePerProposal: MAX_EVIDENCE,
  excerptChars: EXCERPT_CHARS,
  sources: MAX_SOURCES,
} as const;

/**
 * The analyser whose promise this build is entitled to make.
 *
 * Compared as a value rather than trusted as a type: the field is read out of a
 * record, and a build that starts writing something else there must arrive here
 * as "not this", not as "still deterministic because the type says so".
 */
const DETERMINISTIC_METHOD = 'deterministic-rules';

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An https link, or nothing.
 *
 * Evidence URLs come from the static source registry rather than from a page,
 * so this is not the first fence — but the mobile boundary rebuilds every
 * response from an allow-list on principle, and a link is the one field on this
 * wire a reader will tap. An absurdly long one is dropped whole rather than
 * sliced: a truncated URL is a link that goes somewhere else.
 */
function safeHttpsUrl(value: unknown): string | null {
  const raw = safeString(value, 1_200);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.href.length <= 1_000 ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A passage short enough for a phone, and an honest answer about whether it is
 * the whole one. safeString collapses control characters and runs of whitespace
 * first, so a source whose stored excerpt is long only because it is full of
 * newlines comes through complete rather than being reported as cut.
 */
function boundedExcerpt(value: unknown): { excerpt: string; truncated: boolean } {
  const clean = safeString(value, EXCERPT_CHARS + 1);
  if (clean.length <= EXCERPT_CHARS) return { excerpt: clean, truncated: false };
  return { excerpt: clean.slice(0, EXCERPT_CHARS), truncated: true };
}

function wireEvidence(input: ImprovementScoutEvidence): MobileScoutEvidence {
  const raw = input as ImprovementScoutEvidence & Record<string, unknown>;
  const bounded = boundedExcerpt(raw.excerpt);
  return {
    title: safeString(raw.title, 260, 'Untitled source'),
    url: safeHttpsUrl(raw.url),
    publisher: safeString(raw.publisher, 120) || null,
    publishedAt: finiteOrNull(raw.publishedAt),
    excerpt: bounded.excerpt,
    excerptTruncated: bounded.truncated,
  };
}

/**
 * One proposal, rebuilt field by field.
 *
 * `score` is absent on purpose and its absence is the point: it is a rule-table
 * constant that reads as a measurement, and the desktop queue stopped leading
 * with it for exactly that reason. `contentHash`, the evidence row ids and the
 * linked Goal id are absent too — the first two are integrity bookkeeping with
 * no reader on a phone, and the third is a handle to a Control record this
 * device cannot open. Whether a Goal exists is the part that changes what the
 * screen says, so that crosses as a boolean.
 */
export function mobileScoutProposal(input: ImprovementScoutSuggestion): MobileScoutProposal {
  const raw = input as ImprovementScoutSuggestion & Record<string, unknown>;
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  return {
    id: safeString(raw.id, 120),
    title: safeString(raw.title, 200, 'Untitled proposal'),
    summary: safeString(raw.summary, 600, 'No summary was recorded.'),
    category: safeString(raw.category, 80, 'Improvement'),
    status: PROPOSAL_STATUSES.get(String(raw.status)) ?? 'new',
    whyNow: safeString(raw.whyNow, 400),
    recommendation: safeString(raw.recommendation, 600),
    effort: raw.effort === 'small' || raw.effort === 'large' ? raw.effort : 'medium',
    risk: raw.risk === 'low' || raw.risk === 'high' ? raw.risk : 'elevated',
    confidence: Math.max(0, Math.min(1, finite(raw.confidence))),
    foundAt: count(raw.createdAt),
    goalLinked: typeof raw.goalId === 'string' && raw.goalId.length > 0,
    evidence: evidence.slice(0, MAX_EVIDENCE).map(wireEvidence),
    evidenceCount: evidence.length,
    evidenceTruncated: evidence.length > MAX_EVIDENCE,
  };
}

/**
 * One scan's own account of itself.
 *
 * `detail` and `error` both cross because the Scout writes them in different
 * places: a pass a consent gate stopped carries its reason in `detail` and
 * nothing in `error`, and a pass that broke carries both. A wire shape that
 * carried only one of them would have left the phone printing a bare status
 * word for exactly the outcome the operator most needs explained.
 */
export function mobileScoutRun(input: ImprovementScoutRun): MobileScoutRun {
  const raw = input as ImprovementScoutRun & Record<string, unknown>;
  return {
    mode: RUN_MODES.get(String(raw.mode)) ?? 'manual',
    status: RUN_STATUSES.get(String(raw.status)) ?? 'unknown',
    networkAllowed: raw.networkAllowed === true,
    sourceCount: count(raw.sourceCount),
    evidenceCount: count(raw.evidenceCount),
    proposalCount: count(raw.suggestionCount),
    startedAt: count(raw.startedAt),
    endedAt: finiteOrNull(raw.endedAt),
    detail: safeString(raw.detail, 400) || null,
    error: safeString(raw.error, 400) || null,
  };
}

function wireSource(input: ImprovementScoutSource): MobileScoutSource {
  const raw = input as ImprovementScoutSource & Record<string, unknown>;
  return {
    label: safeString(raw.label, 120, 'Unnamed source'),
    publisher: safeString(raw.publisher, 120, 'Unnamed publisher'),
    enabled: raw.enabled === true,
    lastStatus: SOURCE_STATUSES.get(String(raw.lastStatus)) ?? 'never',
    lastCheckedAt: finiteOrNull(raw.lastCheckedAt),
    // A failed check's stored reason is the only thing that makes it
    // actionable. Bounded, because it is a fetch error the Scout copied.
    lastDetail: safeString(raw.lastDetail, 240) || null,
  };
}

/** The three reads this screen is composed from, held together so the offline
 *  suite can compose a payload without a database under it. */
export type MobileScoutReading = {
  overview: ImprovementScoutOverview;
  sources: readonly ImprovementScoutSource[];
  /** Open proposals in the order the repository files them, already capped at READ_LIMIT. */
  open: readonly ImprovementScoutSuggestion[];
};

/**
 * The digest, rebuilt from an allow-list.
 *
 * The proposal order is left exactly as the repository returned it and is never
 * re-sorted here. Re-sorting a capped read by date would produce "the newest of
 * the sixty Wanigan happened to return", which looks like a chronology and is
 * not one; the page says the order is a filing order instead, which is what the
 * desktop queue settled on for the same reason.
 */
export function mobileScoutPayload(reading: MobileScoutReading, composedAt: number, now: number): MobileScoutPayload {
  const view = reading.overview as ImprovementScoutOverview & Record<string, unknown>;
  const open = reading.open.slice(0, READ_LIMIT);
  const method = safeString(view.analysisMethod, 60, DETERMINISTIC_METHOD);
  const latest = view.latestRun as ImprovementScoutRun | null | undefined;
  return {
    generatedAt: composedAt,
    readAgeMs: Math.max(0, now - composedAt),
    workspaceEnabled: view.enabled === true,
    onlineResearchEnabled: view.networkEnabled === true,
    weeklyEnabled: view.weeklyEnabled === true,
    cadenceLabel: safeString(view.cadenceLabel, 80, 'weekly'),
    // Carried as ../improvement-scout reports it, which is null unless the
    // schedule row is actually armed. A next time invented for a disarmed
    // schedule would be the phone promising background egress nobody allowed.
    nextRunAt: finiteOrNull(view.nextRunAt),
    lastRunAt: finiteOrNull(view.lastRunAt),
    lastRun: latest ? mobileScoutRun(latest) : null,
    analysisMethod: method,
    deterministic: method === DETERMINISTIC_METHOD,
    pendingProposals: count(view.pendingSuggestions),
    sourceCount: count(view.sourceCount),
    enabledSourceCount: count(view.enabledSourceCount),
    sources: reading.sources.slice(0, MAX_SOURCES).map(wireSource),
    proposals: open.slice(0, MAX_PROPOSALS).map(mobileScoutProposal),
    openCount: open.length,
    truncated: open.length > MAX_PROPOSALS,
    readCapped: open.length >= READ_LIMIT,
  };
}

type Cached = { at: number; payload: MobileScoutPayload };
let cached: Cached | null = null;

/**
 * The open review queue, and only it.
 *
 * Snoozed and dismissed proposals are deliberately not read. This is a
 * narrowing with a reason rather than a missing filter: the phone shows the
 * work still waiting on a decision, and reopening something a human already
 * put down is a decision made against the repository it is about. The page
 * names the omission so an operator who cannot find a dismissed proposal knows
 * where it is rather than believing it is gone.
 */
function compose(now: number): MobileScoutPayload {
  return mobileScoutPayload({
    overview: overview(),
    sources: listSources(),
    open: listSuggestions({ status: ['new', 'reviewed'], limit: READ_LIMIT }),
  }, now, now);
}

function digest(now: number): MobileScoutPayload {
  if (cached && now - cached.at < CACHE_MS) {
    // Recomposed only in the one field that is a clock. Serving a cached
    // reading with a frozen age attached would be this route reporting a read
    // as fresher than it is on the single screen whose subject is how long ago
    // something last ran.
    return { ...cached.payload, readAgeMs: Math.max(0, now - cached.payload.generatedAt) };
  }
  const payload = compose(now);
  cached = { at: now, payload };
  return payload;
}

function serveScout(res: http.ServerResponse): void {
  let body: string;
  try {
    body = JSON.stringify(digest(Date.now()));
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    // Refused rather than silently shortened. Every cap above is announced in
    // the payload it applies to, and a response trimmed here would be the one
    // shortening the page could not tell its reader about.
    json(res, 503, { error: 'The Scout digest is too large to serve safely.' });
    return;
  }
  send(res, 200, 'application/json; charset=utf-8', body);
}

// GET and nothing else, at 'monitor'. There is deliberately no companion POST:
// every write the Scout offers — running a scan, reviewing, dismissing,
// creating a Goal — is either egress or a commitment against a working tree,
// and both are consent decisions Wanigan takes at the Mac.
registerApiRoute({
  path: '/api/scout',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveScout(res),
});
