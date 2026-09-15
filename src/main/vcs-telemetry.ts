import { db } from './db';
import { pickVcsAttributes } from '../shared/spend-yield';

/**
 * Repository attributes out of Claude Code's own telemetry.
 *
 * With OTEL_METRICS_INCLUDE_REPOSITORY set (otelEnv does, from 2.1.269 on the
 * CLI ignores it before then), the CLI attaches `vcs.repository.*` and
 * `vcs.owner.name`/`vcs.provider.name` to the common attributes of every metric
 * datapoint and log record. The names and the placement were read out of the
 * 2.1.271 binary: they are added to the same attribute object as
 * `organization.id`, not to the OTLP resource. Both places are read here anyway,
 * so a build that moves them to the resource does not silently empty this.
 *
 * Kept apart from otel.ts's parser because it answers a different question.
 * That parser banks money and tokens; this banks which repository the CLI
 * itself said it was in, which spend yield shows beside the cwd Wanigan
 * launched in. They should agree. When they do not, the CLI's claim is the one
 * that saw the git state, and the surface names both.
 */

type Attrs = Record<string, string>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function flatten(items: unknown): Attrs {
  const out: Attrs = {};
  for (const item of list(items)) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key.startsWith('vcs.')) continue;
    const value = isRecord(item.value) ? item.value.stringValue : undefined;
    if (typeof value === 'string') out[item.key] = value;
  }
  return out;
}

function sessionOf(resource: unknown): string | null {
  for (const item of list(isRecord(resource) ? resource.attributes : null)) {
    if (!isRecord(item) || item.key !== 'wanigan.session.id') continue;
    const value = isRecord(item.value) ? item.value.stringValue : undefined;
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/[^A-Za-z0-9._:-]/g, '_');
  }
  return null;
}

/** Every vcs.* attribute set in one OTLP/JSON export, per Wanigan session. */
export function vcsAttributesOf(payload: unknown): { sessionId: string; attrs: Attrs }[] {
  const found = new Map<string, Attrs>();
  if (!isRecord(payload)) return [];
  const note = (sessionId: string | null, attrs: Attrs) => {
    if (!sessionId) return;
    const picked = pickVcsAttributes(attrs);
    if (!Object.keys(picked).length) return;
    found.set(sessionId, { ...(found.get(sessionId) ?? {}), ...picked });
  };
  for (const rm of list(payload.resourceMetrics)) {
    if (!isRecord(rm)) continue;
    const sessionId = sessionOf(rm.resource);
    note(sessionId, flatten(isRecord(rm.resource) ? rm.resource.attributes : null));
    for (const sm of list(rm.scopeMetrics)) {
      for (const m of list(isRecord(sm) ? sm.metrics : null)) {
        if (!isRecord(m)) continue;
        const body = isRecord(m.sum) ? m.sum : isRecord(m.gauge) ? m.gauge : null;
        for (const dp of list(body?.dataPoints)) note(sessionId, flatten(isRecord(dp) ? dp.attributes : null));
      }
    }
  }
  for (const rl of list(payload.resourceLogs)) {
    if (!isRecord(rl)) continue;
    const sessionId = sessionOf(rl.resource);
    note(sessionId, flatten(isRecord(rl.resource) ? rl.resource.attributes : null));
    for (const sl of list(rl.scopeLogs)) {
      for (const rec of list(isRecord(sl) ? sl.logRecords : null)) note(sessionId, flatten(isRecord(rec) ? rec.attributes : null));
    }
  }
  return [...found].map(([sessionId, attrs]) => ({ sessionId, attrs }));
}

/** Called from the receiver after the export has been banked; never throws into it. */
export function recordVcsAttributes(payload: unknown): void {
  try {
    const rows = vcsAttributesOf(payload);
    if (!rows.length) return;
    const now = Date.now();
    const up = db().prepare(`
      INSERT INTO session_vcs_attrs (session_id, key, value, first_at, last_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id, key, value) DO UPDATE SET last_at = excluded.last_at
    `);
    db().transaction(() => {
      for (const row of rows) for (const [key, value] of Object.entries(row.attrs)) up.run(row.sessionId, key, value, now, now);
    })();
  } catch (e) {
    console.warn('[wanigan] vcs attributes not recorded:', e);
  }
}

/** What the CLI said about a session's repository, latest value per key. */
export function vcsAttributesFor(sessionIds: string[]): Map<string, Attrs> {
  const out = new Map<string, Attrs>();
  for (let i = 0; i < sessionIds.length; i += 400) {
    const chunk = sessionIds.slice(i, i + 400);
    if (!chunk.length) continue;
    const rows = db().prepare(`
      SELECT session_id, key, value FROM session_vcs_attrs WHERE session_id IN (${chunk.map(() => '?').join(',')})
      ORDER BY last_at ASC
    `).all(...chunk) as { session_id: string; key: string; value: string }[];
    for (const row of rows) out.set(row.session_id, { ...(out.get(row.session_id) ?? {}), [row.key]: row.value });
  }
  return out;
}
