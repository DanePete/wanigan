import { db } from './db';
import * as accounts from './accounts';
import { PROVIDERS, providerById } from './providers';
import { listProjects, projectById } from './store';
import { redactCredentials } from './redact';
import {
  admissionVerdict, excerptOf, isFiveHourWindow, previousRunsSection, windowShares,
  DEFAULT_KEEP_RUNS, DEFAULT_QUIET_MINUTES, DEFAULT_RESERVE_PCT, type AdmissionVerdict, type ScheduleOutcome,
} from '../shared/schedule-guard';
import type { AccountLimits } from '../shared/types';
import type { ScheduleCostSettings, WindowShareReport } from '../shared/cost-types';

/**
 * The quota-aware half of schedules, and the evidence it reads.
 *
 * Imported by schedule.ts, so it imports nothing that imports schedule.ts —
 * headless.ts in particular hands its finished outcome in rather than being
 * reached for, which would close schedule → schedule-cost → headless →
 * schedule at load time.
 */

/* ── settings ─────────────────────────────────────────────────────────── */

type SettingsRow = { schedule_id: string; admission: number; reserve_pct: number; quiet_minutes: number; remember: number; keep_runs: number };

export function scheduleCostSettings(scheduleId: string): ScheduleCostSettings {
  const row = db().prepare('SELECT * FROM schedule_cost_settings WHERE schedule_id = ?').get(scheduleId) as SettingsRow | undefined;
  return {
    scheduleId,
    admission: row?.admission === 1,
    reservePct: row?.reserve_pct ?? DEFAULT_RESERVE_PCT,
    quietMinutes: row?.quiet_minutes ?? DEFAULT_QUIET_MINUTES,
    remember: row?.remember === 1,
    keepRuns: row?.keep_runs ?? DEFAULT_KEEP_RUNS,
  };
}

export function setScheduleCostSettings(scheduleId: string, patch: Partial<Omit<ScheduleCostSettings, 'scheduleId'>>): ScheduleCostSettings {
  const exists = db().prepare('SELECT 1 FROM schedules WHERE id = ?').get(scheduleId);
  if (!exists) throw new Error('That schedule no longer exists.');
  const cur = scheduleCostSettings(scheduleId);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const int = (v: unknown, fallback: number, lo: number, hi: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.max(lo, Math.min(hi, n));
  };
  const next: ScheduleCostSettings = {
    scheduleId,
    admission: bool(patch.admission, cur.admission),
    reservePct: int(patch.reservePct, cur.reservePct, 0, 95),
    quietMinutes: int(patch.quietMinutes, cur.quietMinutes, 0, 240),
    remember: bool(patch.remember, cur.remember),
    keepRuns: int(patch.keepRuns, cur.keepRuns, 1, 20),
  };
  db().prepare(`
    INSERT INTO schedule_cost_settings (schedule_id, admission, reserve_pct, quiet_minutes, remember, keep_runs, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(schedule_id) DO UPDATE SET admission=excluded.admission, reserve_pct=excluded.reserve_pct,
      quiet_minutes=excluded.quiet_minutes, remember=excluded.remember, keep_runs=excluded.keep_runs, updated_at=excluded.updated_at
  `).run(scheduleId, next.admission ? 1 : 0, next.reservePct, next.quietMinutes, next.remember ? 1 : 0, next.keepRuns, Date.now());
  return next;
}

/* ── evidence ─────────────────────────────────────────────────────────── */

/** Called wherever limits are read in-app, so another process can apply admission without probing. */
export function recordLimitReadings(rows: readonly AccountLimits[]): void {
  try {
    const up = db().prepare(`
      INSERT INTO account_limit_readings (account_id, harness, kind, scope, used_percent, resets_at, fetched_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id, kind, scope) DO UPDATE SET used_percent=excluded.used_percent, resets_at=excluded.resets_at,
        fetched_at=excluded.fetched_at, harness=excluded.harness
    `);
    db().transaction(() => {
      for (const row of rows) {
        if (row.state !== 'ok' || row.fetchedAt === null) continue;
        for (const w of row.windows) up.run(row.accountId, row.harness, w.kind, w.scope ?? '', w.usedPercent, w.resetsAt, row.fetchedAt);
      }
    })();
  } catch (e) {
    console.warn('[wanigan] limit readings not recorded:', e);
  }
}

let lastInputWrite = 0;
/** At most one write every five seconds; the timestamp is all that is kept. */
export function noteOperatorInput(at = Date.now()): void {
  if (at - lastInputWrite < 5_000) return;
  lastInputWrite = at;
  try {
    db().prepare('INSERT INTO operator_input (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = MAX(at, excluded.at)').run(at);
  } catch { /* evidence only */ }
}

export function lastOperatorInputAt(): number | null {
  const typed = db().prepare('SELECT at FROM operator_input WHERE id = 1').get() as { at: number } | undefined;
  // A prompt submitted from anywhere a hook sees — the phone included — is input too.
  const prompt = db().prepare("SELECT MAX(at) AS at FROM session_events WHERE event = 'UserPromptSubmit'").get() as { at: number | null };
  const values = [typed?.at ?? null, prompt.at].filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : null;
}

function fiveHourReading(accountId: string): { usedPercent: number; fetchedAt: number } | null {
  const rows = db().prepare("SELECT kind, scope, used_percent, fetched_at FROM account_limit_readings WHERE account_id = ? AND scope = ''")
    .all(accountId) as { kind: string; scope: string; used_percent: number; fetched_at: number }[];
  const hit = rows.filter((r) => isFiveHourWindow(r.kind)).sort((a, b) => b.fetched_at - a.fetched_at)[0];
  return hit ? { usedPercent: hit.used_percent, fetchedAt: hit.fetched_at } : null;
}

/**
 * The accounts a headless fire would run under: the provider its payload names,
 * or the first registered profile that declares a headless protocol — the same
 * preference order the runner uses, without the installed-CLI proof it adds at
 * dispatch — resolved per repository it would touch.
 */
function accountsForFire(payload: Record<string, unknown>, projectId: string | null): { label: string; id: string | null }[] {
  const named = typeof payload.providerId === 'string' ? providerById(payload.providerId) : undefined;
  const def = named ?? PROVIDERS.find((p) => p.headless !== 'none');
  if (!def) return [];
  const projects = projectId ? [projectById(projectId)].filter(Boolean) : listProjects();
  const out = new Map<string, { label: string; id: string | null }>();
  for (const project of projects) {
    try {
      const resolved = accounts.resolve({ harness: def.harness, projectId: project!.id });
      if (resolved.account) out.set(resolved.account.id, { label: resolved.account.label, id: resolved.account.id });
      else out.set(`none:${def.harness}`, { label: `${def.label} (no account)`, id: null });
    } catch {
      out.set(`none:${def.harness}`, { label: `${def.label} (account unresolved)`, id: null });
    }
  }
  return [...out.values()];
}

/** Null when the fire may proceed; otherwise the recorded reason it was skipped. */
export function admissionRefusal(schedule: { id: string; kind: string; payload: unknown; projectId: string | null }, now: number): string | null {
  if (schedule.kind !== 'headless') return null;
  const settings = scheduleCostSettings(schedule.id);
  if (!settings.admission) return null;
  const payload = (schedule.payload && typeof schedule.payload === 'object' ? schedule.payload : {}) as Record<string, unknown>;
  const verdict: AdmissionVerdict = admissionVerdict({
    now,
    reservePct: settings.reservePct,
    quietMinutes: settings.quietMinutes,
    accounts: accountsForFire(payload, schedule.projectId).map((a) => ({ label: a.label, reading: a.id ? fiveHourReading(a.id) : null })),
    lastOperatorInputAt: lastOperatorInputAt(),
  });
  return verdict.admit ? null : verdict.reason;
}

/* ── memory ───────────────────────────────────────────────────────────── */

export function scheduleOutcomes(scheduleId: string, limit = DEFAULT_KEEP_RUNS): ScheduleOutcome[] {
  return (db().prepare('SELECT at, status, files_changed, excerpt FROM schedule_outcomes WHERE schedule_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(scheduleId, Math.max(1, Math.min(20, limit))) as { at: number; status: string; files_changed: number | null; excerpt: string | null }[])
    .map((r) => ({ at: r.at, status: r.status, filesChanged: r.files_changed, excerpt: r.excerpt }));
}

/** The section the next fire of this schedule would carry, or null when memory is off or empty. */
export function previousRunsFor(scheduleId: string): string | null {
  const settings = scheduleCostSettings(scheduleId);
  if (!settings.remember) return null;
  return previousRunsSection(scheduleOutcomes(scheduleId, settings.keepRuns));
}

/**
 * A finished headless run, as its schedule remembers it. The result text is
 * redacted before the excerpt is cut, so a credential that straddles the
 * 600-character mark cannot leave its first half behind.
 */
export function recordScheduleOutcome(input: {
  scheduleId: string; fireId: number; runId: string; status: string; filesChanged: number | null; results: { project: string; text: string | null }[];
}): void {
  const combined = input.results
    .filter((r) => r.text && r.text.trim())
    .map((r) => (input.results.length > 1 ? `${r.project}: ${r.text!.trim()}` : r.text!.trim()))
    .join('\n');
  const excerpt = excerptOf(redactCredentials(combined));
  const d = db();
  d.transaction(() => {
    d.prepare('INSERT INTO schedule_outcomes (schedule_id, fire_id, run_id, at, status, files_changed, excerpt) VALUES (?,?,?,?,?,?,?)')
      .run(input.scheduleId, input.fireId, input.runId, Date.now(), input.status, input.filesChanged, excerpt);
    const keep = scheduleCostSettings(input.scheduleId).keepRuns;
    d.prepare(`DELETE FROM schedule_outcomes WHERE schedule_id = ? AND id NOT IN
      (SELECT id FROM schedule_outcomes WHERE schedule_id = ? ORDER BY at DESC, id DESC LIMIT ?)`).run(input.scheduleId, input.scheduleId, keep);
  })();
}

/* ── window share ─────────────────────────────────────────────────────── */

export function windowShare(liveIds: ReadonlySet<string>): WindowShareReport {
  const now = Date.now();
  const readings = db().prepare("SELECT account_id, harness, kind, used_percent, resets_at, fetched_at FROM account_limit_readings WHERE scope = ''")
    .all() as { account_id: string; harness: string; kind: string; used_percent: number; resets_at: number | null; fetched_at: number }[];
  const fiveHour = new Map(readings.filter((r) => isFiveHourWindow(r.kind)).map((r) => [r.account_id, r] as const));
  const WINDOW = 5 * 60 * 60_000;
  const claudeAccounts = accounts.listAll().filter((a) => a.harness === 'claude-code');
  const out: WindowShareReport['accounts'] = [];
  for (const account of claudeAccounts) {
    const reading = fiveHour.get(account.id) ?? null;
    const reset = reading?.resets_at && reading.resets_at > now ? reading.resets_at : null;
    const start = reset ? reset - WINDOW : now - WINDOW;
    const rows = db().prepare(`
      SELECT e.session_id, SUM(e.in_tokens + e.out_tokens + e.cache_read + e.cache_write) AS tokens, s.title, s.project_name
      FROM session_api_events e JOIN session_log s ON s.id = e.session_id
      WHERE e.kind = 'request' AND e.at >= ? AND s.account_id = ?
      GROUP BY e.session_id
    `).all(start, account.id) as { session_id: string; tokens: number; title: string | null; project_name: string }[];
    const [shares] = windowShares(rows.map((r) => ({ sessionId: r.session_id, accountId: account.id, tokens: r.tokens })));
    const meta = new Map(rows.map((r) => [r.session_id, r] as const));
    out.push({
      accountId: account.id,
      label: account.label,
      windowStart: start,
      windowFrom: reset ? 'reported-reset' : 'rolling',
      usedPercent: reading?.used_percent ?? null,
      readingAt: reading?.fetched_at ?? null,
      totalTokens: shares?.total ?? 0,
      sessions: (shares?.sessions ?? []).map((s) => ({
        ...s, live: liveIds.has(s.sessionId), title: meta.get(s.sessionId)?.title ?? null, project: meta.get(s.sessionId)?.project_name ?? null,
      })),
    });
  }
  return {
    accounts: out,
    note: 'Shares are of the tokens Wanigan’s own Claude Code sessions reported in the window, not of the provider’s limit: work outside Wanigan, and Codex sessions (whose counters are not timestamped per request), are not in them.',
  };
}
