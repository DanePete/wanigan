/**
 * Public status pages, read as evidence about a failing session.
 *
 * Both pages were fetched on 2026-09-14 to settle their shape rather than
 * assuming one:
 *
 *  - status.claude.com is Atlassian Statuspage. `/api/v2/incidents/unresolved.json`
 *    answers 200 with `incidents[]`, each carrying `components[].name`,
 *    `incident_updates[].affected_components[].name`, `status`, `impact` and a
 *    `shortlink`. Components are named "Claude Code", "Claude API
 *    (api.anthropic.com)", "claude.ai", and so on.
 *  - status.openai.com is not Statuspage. It serves a compatible
 *    `/api/v2/incidents.json` (200) and `/api/v2/summary.json`, but
 *    `/incidents/unresolved.json` is a 404, and its incidents carry no
 *    component list at all. So unresolved ones are filtered here, and matching
 *    for Codex has only the incident's name to go on — which the match below
 *    says rather than pretending it read a component.
 *
 * Everything here is pure: the page body goes in, a list comes out, and the
 * fetch — the only part that leaves the machine — stays in main.
 */
import type { ProviderIncident } from './types';

export type StatusSource = ProviderIncident['source'];

/** The statuses a page uses once an incident is over. */
const CLOSED = new Set(['resolved', 'postmortem', 'completed']);

const MAX_INCIDENTS = 20;
const MAX_NAME = 160;

function text(v: unknown, max = MAX_NAME): string | null {
  if (typeof v !== 'string') return null;
  const flat = v.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function epoch(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** An incident page link on the page's own host, or null for anything else. */
function incidentUrl(source: StatusSource, id: string | null, shortlink: unknown): string | null {
  // A shortlink is Statuspage's own redirector. It is followed only when it is
  // https on the host Statuspage uses, so a body that names some other URL
  // cannot put it behind a button in Wanigan.
  const short = typeof shortlink === 'string' ? shortlink.trim() : '';
  if (/^https:\/\/stspg\.io\/[A-Za-z0-9]+$/.test(short)) return short;
  if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return `https://${source}/incidents/${id}`;
  return null;
}

/**
 * The unresolved incidents in one page body. Anything unparseable is an empty
 * list, and the caller reports the read as failed rather than as "no incidents"
 * — those two must not look the same.
 */
export function parseIncidents(body: unknown, source: StatusSource, readAt: number): ProviderIncident[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { incidents?: unknown }).incidents;
  if (!Array.isArray(raw)) return null;
  const out: ProviderIncident[] = [];
  for (const item of raw) {
    if (out.length >= MAX_INCIDENTS) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const status = text(r.status, 32);
    const name = text(r.name);
    if (!status || !name || CLOSED.has(status)) continue;
    const id = text(r.id, 64);
    const url = incidentUrl(source, id, r.shortlink);
    if (!url) continue;
    const components = new Set<string>();
    if (Array.isArray(r.components)) {
      for (const c of r.components) {
        const n = c && typeof c === 'object' ? text((c as Record<string, unknown>).name, 80) : null;
        if (n) components.add(n);
      }
    }
    if (Array.isArray(r.incident_updates)) {
      for (const u of r.incident_updates) {
        const affected = u && typeof u === 'object' ? (u as Record<string, unknown>).affected_components : null;
        if (!Array.isArray(affected)) continue;
        for (const c of affected) {
          const n = c && typeof c === 'object' ? text((c as Record<string, unknown>).name, 80) : null;
          if (n) components.add(n);
        }
      }
    }
    out.push({
      source, name, status, impact: text(r.impact, 16), components: [...components], url,
      startedAt: epoch(r.started_at) ?? epoch(r.created_at), readAt,
    });
  }
  return out;
}

/**
 * Which page speaks for a session, from the backend it actually talks to.
 *
 * The backend and not the harness: a GLM or DeepSeek session runs the Claude
 * Code CLI against somebody else's API, and an Anthropic outage says nothing
 * about it. Null for every backend without a page Wanigan reads.
 */
export function statusSourceFor(backendId: string | null | undefined): StatusSource | null {
  const id = backendId?.trim();
  if (id === 'anthropic') return 'status.claude.com';
  if (id === 'openai') return 'status.openai.com';
  return null;
}

const CLAUDE_COMPONENT = /^(claude code|claude api\b)/i;
const CLAUDE_MODEL_FAMILY = /\b(opus|sonnet|haiku|fable|mythos)\b/i;
const OPENAI_NAME = /\b(codex|api)\b/i;

/**
 * The open incident that could explain a failure on this session, or null.
 *
 * Claude: an incident naming the "Claude Code" or "Claude API" component, or
 * one whose title names the model family this session runs ("Elevated errors
 * for Claude Fable 5.1"). OpenAI: an incident whose title says Codex or API,
 * since its page lists no components. Major before minor, then the newest.
 */
export function matchIncident(
  incidents: readonly ProviderIncident[],
  source: StatusSource | null,
  model: string | null | undefined,
): ProviderIncident | null {
  if (!source) return null;
  const family = model ? CLAUDE_MODEL_FAMILY.exec(model)?.[1]?.toLowerCase() ?? null : null;
  const matches: ProviderIncident[] = [];
  for (const incident of incidents) {
    if (incident.source !== source) continue;
    if (source === 'status.claude.com') {
      const named = incident.components.filter((c) => CLAUDE_COMPONENT.test(c));
      const byModel = !!family && new RegExp(`\\b${family}\\b`, 'i').test(incident.name);
      if (!named.length && !byModel) continue;
      matches.push({ ...incident, components: named.length ? named : [`${family} (named in the incident title)`] });
    } else {
      if (!OPENAI_NAME.test(incident.name)) continue;
      matches.push({ ...incident, components: ['named in the incident title — this page lists no components'] });
    }
  }
  const weight = (i: ProviderIncident) => (i.impact === 'critical' ? 3 : i.impact === 'major' ? 2 : i.impact === 'minor' ? 1 : 0);
  matches.sort((a, b) => weight(b) - weight(a) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return matches[0] ?? null;
}

/** How often a page is read at most, and the ceiling a failing page backs off to. */
export const STATUS_INTERVAL_MS = 3 * 60_000;
export const STATUS_BACKOFF_CEILING_MS = 30 * 60_000;

/** The wait before the next read: the interval after a success, doubling after each failure. */
export function nextStatusDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return STATUS_INTERVAL_MS;
  return Math.min(STATUS_BACKOFF_CEILING_MS, STATUS_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 8));
}
