import { getSetting, setSetting } from './settings';
import {
  matchIncident, nextStatusDelay, parseIncidents, statusSourceFor, type StatusSource,
} from '../shared/provider-incidents';
import type { ProviderIncident, ProviderStatusReport, Session } from '../shared/types';

/**
 * Whether the provider is having an outage, asked of its public status page.
 *
 * A failing session with an open incident on its provider is a different
 * problem from a failing session: one wants the operator debugging their
 * repository, the other wants them to stop. So the attention verdict for an
 * error or a stall names an open incident when one matches — and only then,
 * because an incident is evidence about the provider, not about this session.
 *
 * What leaves the machine is a plain GET of a public JSON document: no
 * credential, no cookie, no project name, nothing about any session. It is
 * still a request someone else's server sees, which is why it has a switch,
 * sits on the egress report, and only runs while there is something it could
 * explain: a live session, or a failure recorded in the last few minutes.
 */

const SETTING = 'provider_status_checks';
/** A status page is a few hundred kilobytes at most; anything past this is not one. */
const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** How often the timer wakes to ask whether a read is due; the read itself is rarer. */
const TICK_MS = 30_000;

/**
 * The URLs, verified with a real GET on 2026-09-14. status.claude.com serves
 * the unresolved list directly; status.openai.com answers that path with a 404,
 * so its full list is read and filtered — see shared/provider-incidents.ts.
 */
export const STATUS_PAGES: Record<StatusSource, { primary: string; fallback: string | null }> = {
  'status.claude.com': {
    primary: 'https://status.claude.com/api/v2/incidents/unresolved.json',
    fallback: 'https://status.claude.com/api/v2/incidents.json',
  },
  'status.openai.com': {
    primary: 'https://status.openai.com/api/v2/incidents.json',
    fallback: null,
  },
};

type PageState = {
  incidents: ProviderIncident[];
  lastCheckedAt: number | null;
  lastError: string | null;
  failures: number;
  nextAt: number;
};

const pages = new Map<StatusSource, PageState>();
let timer: ReturnType<typeof setInterval> | null = null;
let wanted: (() => { sources: StatusSource[] }) | null = null;
let inFlight = false;

export function statusChecksEnabled(): boolean {
  try { return getSetting(SETTING, '1') !== '0'; } catch { return true; }
}

export function setStatusChecksEnabled(on: boolean): ProviderStatusReport {
  setSetting(SETTING, on ? '1' : '0');
  // Switching it off drops what was read: an incident nobody is checking on any
  // more must not keep appearing in verdicts as if it were current.
  if (!on) pages.clear();
  return statusReport();
}

function state(source: StatusSource): PageState {
  let s = pages.get(source);
  if (!s) {
    s = { incidents: [], lastCheckedAt: null, lastError: null, failures: 0, nextAt: 0 };
    pages.set(source, s);
  }
  return s;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      // No cookie jar, no credential, no referrer: this is a public document and
      // the request should carry nothing a public document does not need.
      credentials: 'omit',
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_BODY) throw new Error('the status page answered with more than a status page holds');
    const textBody = await res.text();
    if (textBody.length > MAX_BODY) throw new Error('the status page answered with more than a status page holds');
    let body: unknown = null;
    try { body = JSON.parse(textBody); } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Read one page now. Resolves either way; a failure is recorded, never thrown. */
export async function readStatusPage(source: StatusSource, now: number = Date.now()): Promise<void> {
  const s = state(source);
  const { primary, fallback } = STATUS_PAGES[source];
  try {
    let { status, body } = await getJson(primary);
    if (status === 404 && fallback) ({ status, body } = await getJson(fallback));
    if (status !== 200) throw new Error(`${source} answered HTTP ${status}`);
    const parsed = parseIncidents(body, source, now);
    if (!parsed) throw new Error(`${source} answered with something that is not an incident list`);
    s.incidents = parsed;
    s.lastError = null;
    s.failures = 0;
  } catch (error) {
    s.failures += 1;
    s.lastError = error instanceof Error ? error.message : String(error);
    // What was read before stays as it was, marked by lastCheckedAt; it is not
    // replaced with an empty list that would read as "all clear".
  } finally {
    s.lastCheckedAt = now;
    s.nextAt = now + nextStatusDelay(s.failures);
  }
}

async function tick(): Promise<void> {
  if (inFlight || !statusChecksEnabled() || !wanted) return;
  const now = Date.now();
  const due = wanted().sources.filter((source) => state(source).nextAt <= now);
  if (!due.length) return;
  inFlight = true;
  try { await Promise.all(due.map((source) => readStatusPage(source, now))); }
  finally { inFlight = false; }
}

/**
 * Start the poller. `want` names the pages worth reading right now — the
 * backends of live sessions and of sessions that failed recently — and an
 * empty answer means no request is made at all.
 */
export function startProviderStatusPoller(want: () => { sources: StatusSource[] }): void {
  wanted = want;
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();
}

export function stopProviderStatusPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The pages a set of sessions would need, deduplicated. */
export function sourcesFor(sessions: readonly Session[]): StatusSource[] {
  const out = new Set<StatusSource>();
  for (const s of sessions) {
    const source = statusSourceFor(s.backendId ?? null);
    if (source) out.add(source);
  }
  return [...out];
}

/** The open incident that matches this session's provider, from the last read. */
export function incidentForSession(session: Pick<Session, 'backendId' | 'model'>): ProviderIncident | null {
  if (!statusChecksEnabled()) return null;
  const source = statusSourceFor(session.backendId ?? null);
  if (!source) return null;
  const s = pages.get(source);
  return s ? matchIncident(s.incidents, source, session.model ?? null) : null;
}

export function statusReport(): ProviderStatusReport {
  const all = [...pages.values()];
  const checked = all.map((p) => p.lastCheckedAt).filter((v): v is number => v !== null);
  const errors = [...pages.entries()].filter(([, p]) => p.lastError).map(([source, p]) => `${source}: ${p.lastError}`);
  const next = all.map((p) => p.nextAt).filter((v) => v > 0);
  return {
    enabled: statusChecksEnabled(),
    lastCheckedAt: checked.length ? Math.max(...checked) : null,
    lastError: errors.length ? errors.join(' · ') : null,
    nextCheckAt: next.length ? Math.min(...next) : null,
    incidents: all.flatMap((p) => p.incidents),
  };
}

/** Smoke only: stand in for a page read, so matching is tested without the network. */
export function __setIncidentsForTest(source: StatusSource, incidents: ProviderIncident[] | null): void {
  if (incidents === null) { pages.delete(source); return; }
  const s = state(source);
  s.incidents = incidents;
  s.lastCheckedAt = Date.now();
}
