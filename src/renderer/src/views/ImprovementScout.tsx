import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '@shared/types';
import '../styles/improvement-scout.css';

/**
 * The Scout is deliberately a research-and-review surface, not a self-updater.
 * It may fetch only explicitly enabled sources, then produces proposals with
 * their evidence attached. Code, settings, packages and agent work still need
 * a separate, visible human action.
 *
 * This view normalises the small IPC DTOs at its boundary. That keeps the
 * presentation stable when the local scanner learns new source metadata while
 * avoiding a second copy of scanner policy in the renderer.
 */

type JsonObject = Record<string, unknown>;

type ScoutOverview = {
  enabled: boolean;
  weeklyEnabled: boolean;
  networkEnabled: boolean;
  cadenceLabel: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  pendingSuggestions: number;
  sourceCount: number;
  enabledSourceCount: number;
  analysisMethod: string;
};

type ScoutSettings = {
  enabled: boolean;
  weeklyEnabled: boolean;
  networkEnabled: boolean;
  /** Local weekly day, Sunday = 0. Kept numeric so the main scheduler can use it directly. */
  weekday: number;
  hour: number;
  providerId: string | null;
};

type ScoutSource = {
  id: string;
  label: string;
  description: string;
  url: string | null;
  enabled: boolean;
};

type ScoutEvidence = {
  title: string;
  url: string | null;
  publisher: string | null;
  excerpt: string;
  publishedAt: number | null;
};

type ScoutSuggestion = {
  id: string;
  title: string;
  summary: string;
  status: string;
  category: string;
  score: number | null;
  confidence: number | null;
  effort: string;
  risk: string;
  whyNow: string;
  recommendation: string;
  evidence: ScoutEvidence[];
  createdAt: number | null;
  goalId: string | null;
};

type ScoutGoalReceipt = { goalId: string; goalUrl?: string | null };

type ScoutApi = {
  overview: () => Promise<unknown>;
  settings: () => Promise<unknown>;
  setSettings: (patch: JsonObject) => Promise<unknown>;
  sources: () => Promise<unknown>;
  setSourceEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  runs?: (limit?: number) => Promise<unknown>;
  suggestions: (filter?: JsonObject) => Promise<unknown>;
  suggestion?: (id: string) => Promise<unknown>;
  updateSuggestion: (id: string, patch: JsonObject) => Promise<unknown>;
  /** `preview` is hard local-only; an online pass needs an explicit allowNetwork flag. */
  run: (input?: { mode?: 'manual' | 'preview'; allowNetwork?: boolean }) => Promise<unknown>;
  createGoal?: (id: string, input?: { projectId?: string | null }) => Promise<ScoutGoalReceipt>;
};

type Notice = { message: string; goalId?: string } | null;

const EMPTY_OVERVIEW: ScoutOverview = {
  enabled: false,
  weeklyEnabled: false,
  networkEnabled: false,
  cadenceLabel: 'weekly',
  lastRunAt: null,
  nextRunAt: null,
  pendingSuggestions: 0,
  sourceCount: 0,
  enabledSourceCount: 0,
  analysisMethod: 'deterministic-rules',
};

const EMPTY_SETTINGS: ScoutSettings = {
  enabled: false,
  weeklyEnabled: false,
  networkEnabled: false,
  weekday: 6,
  hour: 9,
  providerId: null,
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function asRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numeric(value: unknown, fallback: number | null = null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function timestamp(value: unknown): number | null {
  const numberValue = numeric(value);
  if (numberValue !== null) return numberValue > 100_000_000_000 ? numberValue : numberValue * 1_000;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeOverview(value: unknown): ScoutOverview {
  const raw = asRecord(value) ?? {};
  return {
    enabled: bool(raw.enabled ?? raw.researchEnabled),
    weeklyEnabled: bool(raw.weeklyEnabled ?? raw.scheduleEnabled),
    networkEnabled: bool(raw.networkEnabled ?? raw.allowNetwork),
    cadenceLabel: string(raw.cadenceLabel ?? raw.cadence, 'weekly'),
    lastRunAt: timestamp(raw.lastRunAt ?? raw.lastScanAt),
    nextRunAt: timestamp(raw.nextRunAt ?? raw.nextScanAt),
    pendingSuggestions: numeric(raw.pendingSuggestions ?? raw.newSuggestions ?? raw.suggestionCount, 0) ?? 0,
    sourceCount: numeric(raw.sourceCount ?? raw.sources, 0) ?? 0,
    enabledSourceCount: numeric(raw.enabledSourceCount ?? raw.enabledSources, 0) ?? 0,
    analysisMethod: string(raw.analysisMethod, 'deterministic-rules'),
  };
}

function normalizeSettings(value: unknown): ScoutSettings {
  const raw = asRecord(value) ?? {};
  const rawWeekday = raw.weekday ?? raw.dayOfWeek;
  const weekday = typeof rawWeekday === 'number' && Number.isInteger(rawWeekday) && rawWeekday >= 0 && rawWeekday <= 6
    ? rawWeekday
    : typeof rawWeekday === 'string'
      ? Math.max(0, WEEKDAYS.findIndex((day) => day.toLowerCase() === rawWeekday.toLowerCase()))
      : 6;
  return {
    enabled: bool(raw.enabled ?? raw.researchEnabled),
    weeklyEnabled: bool(raw.weeklyEnabled ?? raw.scheduleEnabled),
    networkEnabled: bool(raw.networkEnabled ?? raw.allowNetwork),
    weekday,
    hour: Math.max(0, Math.min(23, Math.round(numeric(raw.hour ?? raw.hourLocal, 9) ?? 9))),
    providerId: typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null,
  };
}

function normalizeSource(value: unknown, index: number): ScoutSource {
  const raw = asRecord(value) ?? {};
  return {
    id: string(raw.id, `source-${index}`),
    label: string(raw.label ?? raw.name ?? raw.publisher, `Source ${index + 1}`),
    description: string(raw.description ?? raw.detail ?? raw.kind, 'Research source'),
    url: safeUrl(raw.url ?? raw.homepage ?? raw.feedUrl),
    enabled: bool(raw.enabled),
  };
}

function normalizeEvidence(value: unknown, index: number): ScoutEvidence {
  const raw = asRecord(value) ?? {};
  return {
    title: string(raw.title ?? raw.headline ?? raw.source, `Evidence ${index + 1}`),
    url: safeUrl(raw.url ?? raw.href ?? raw.sourceUrl),
    publisher: string(raw.publisher ?? raw.sourceName) || null,
    excerpt: string(raw.excerpt ?? raw.summary ?? raw.quote ?? raw.detail),
    publishedAt: timestamp(raw.publishedAt ?? raw.date ?? raw.createdAt),
  };
}

function normalizeSuggestion(value: unknown, index: number): ScoutSuggestion {
  const raw = asRecord(value) ?? {};
  const id = string(raw.id, `suggestion-${index}`);
  return {
    id,
    title: string(raw.title ?? raw.name, 'Untitled proposal'),
    summary: string(raw.summary ?? raw.description ?? raw.rationale, 'No summary was supplied.'),
    status: string(raw.status, 'new').toLowerCase().replace(/\s+/g, '_'),
    category: string(raw.category ?? raw.kind, 'Improvement'),
    score: numeric(raw.score ?? raw.priorityScore ?? raw.impactScore),
    confidence: normaliseConfidence(raw.confidence),
    effort: string(raw.effort ?? raw.estimatedEffort, 'Unestimated'),
    risk: string(raw.risk ?? raw.riskLevel, 'elevated').toLowerCase(),
    whyNow: string(raw.whyNow ?? raw.reason ?? raw.timing),
    recommendation: string(raw.recommendation ?? raw.proposedWork ?? raw.proposedTask ?? raw.nextStep),
    evidence: array(raw.evidence ?? raw.sources).map(normalizeEvidence),
    createdAt: timestamp(raw.createdAt ?? raw.discoveredAt ?? raw.updatedAt),
    goalId: string(raw.goalId ?? raw.docketId) || null,
  };
}

function normaliseConfidence(value: unknown): number | null {
  const n = numeric(value);
  if (n === null) return null;
  return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function scout(): ScoutApi {
  const candidate = (window.wanigan as unknown as { scout?: ScoutApi }).scout;
  if (!candidate) throw new Error('Improvement Scout is unavailable until Wanigan finishes starting.');
  return candidate;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatWhen(at: number | null): string {
  if (!at) return 'not yet';
  return new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDate(at: number | null): string {
  if (!at) return 'date not supplied';
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function score(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}/100`;
}

function goalHref(id: string): string {
  return `#goal=${encodeURIComponent(id)}`;
}

export default function ImprovementScout({ projects, onOpenGoal }: {
  projects: Project[];
  /** App-level route hand-off. `#goal=` alone cannot select the Control view. */
  onOpenGoal?: (id: string) => void;
}) {
  const [overview, setOverview] = useState<ScoutOverview>(EMPTY_OVERVIEW);
  const [settings, setSettings] = useState<ScoutSettings>(EMPTY_SETTINGS);
  const [sources, setSources] = useState<ScoutSource[]>([]);
  const [suggestions, setSuggestions] = useState<ScoutSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'score' | 'newest' | 'effort'>('score');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [goalProjectId, setGoalProjectId] = useState('');
  const [goalIds, setGoalIds] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = scout();
      const [nextOverview, nextSettings, nextSources, nextSuggestions] = await Promise.all([
        api.overview(), api.settings(), api.sources(), api.suggestions({ limit: 150 }),
      ]);
      setOverview(normalizeOverview(nextOverview));
      setSettings(normalizeSettings(nextSettings));
      setSources(array(nextSources).map(normalizeSource));
      setSuggestions(array(nextSuggestions).map(normalizeSuggestion));
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!goalProjectId && projects[0]) setGoalProjectId(projects[0].id);
  }, [goalProjectId, projects]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 9_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const act = useCallback(async (key: string, work: () => Promise<void>, message?: Notice) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      if (message) setNotice(message);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }, []);

  const patchSettings = useCallback((patch: JsonObject, message: string) => act(
    'settings',
    async () => { await scout().setSettings(patch); await load(); },
    { message },
  ), [act, load]);

  const toggleSource = useCallback((source: ScoutSource, enabled: boolean) => act(
    `source-${source.id}`,
    async () => { await scout().setSourceEnabled(source.id, enabled); await load(); },
    { message: `${source.label} is ${enabled ? 'included' : 'excluded'} from future scans.` },
  ), [act, load]);

  const run = useCallback((mode: 'manual' | 'preview') => act(
    `run-${mode}`,
    async () => {
      await scout().run(mode === 'manual' ? { mode, allowNetwork: true } : { mode });
      await load();
    },
    { message: mode === 'preview'
      ? 'Local preview complete. No external source was contacted, nothing was scheduled, and no agent was started.'
      : 'One explicit allow-listed online check completed. It did not enable the weekly watch or start an agent.' },
  ), [act, load]);

  const updateSuggestion = useCallback((suggestion: ScoutSuggestion, nextStatus: string, message: string) => act(
    `suggestion-${suggestion.id}-${nextStatus}`,
    async () => { await scout().updateSuggestion(suggestion.id, { status: nextStatus }); await load(); },
    { message },
  ), [act, load]);

  const createGoal = useCallback((suggestion: ScoutSuggestion) => act(
    `goal-${suggestion.id}`,
    async () => {
      if (!goalProjectId) throw new Error('Choose the project this Goal belongs to first.');
      const api = scout();
      // Do not fall back to Control#create: the Scout-specific endpoint proves
      // retained official evidence and writes that evidence into the Goal.
      // A renderer paired with an old main process must fail closed instead of
      // quietly producing an uncited, unlinked work item.
      if (!api.createGoal) {
        throw new Error('Scout Goal linking needs a Wanigan restart to finish updating its local services.');
      }
      const receipt: ScoutGoalReceipt = await api.createGoal(suggestion.id, { projectId: goalProjectId });
      setGoalIds((previous) => ({ ...previous, [suggestion.id]: receipt.goalId }));
      await load();
      setNotice({ message: 'Goal created. It is linked to this proposal and its evidence; no agent was started.', goalId: receipt.goalId });
    },
  ), [act, goalProjectId, load]);

  const openGoal = useCallback((id: string) => {
    const link = goalHref(id);
    if (window.location.hash !== link) window.history.replaceState(null, '', link);
    onOpenGoal?.(id);
  }, [onOpenGoal]);

  const statuses = useMemo(() => ['all', ...new Set(suggestions.map((item) => item.status))], [suggestions]);
  const filteredSuggestions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = suggestions.filter((item) => {
      if (status !== 'all' && item.status !== status) return false;
      if (!normalized) return true;
      return [item.title, item.summary, item.category, item.whyNow, item.recommendation]
        .some((part) => part.toLowerCase().includes(normalized));
    });
    return matches.sort((a, b) => {
      if (sort === 'newest') return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (sort === 'effort') return a.effort.localeCompare(b.effort);
      return (b.score ?? -1) - (a.score ?? -1) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }, [query, sort, status, suggestions]);

  return (
    <div className="scout-view">
      <header className="scout-head">
        <div className="scout-head-copy">
          <span className="label">Wanigan improvement loop</span>
          <h2>Improvement Scout</h2>
          <p>Track explicitly enabled, source-backed changes in the agent ecosystem, compare them to Wanigan’s capability inventory, and review the resulting proposals here.</p>
        </div>
        <div className="scout-head-actions">
          <span className={`scout-state ${settings.enabled && settings.networkEnabled ? (settings.weeklyEnabled ? 'on' : 'warn') : 'muted'}`}>
            {settings.enabled && settings.networkEnabled ? (settings.weeklyEnabled ? `weekly watch · ${WEEKDAYS[settings.weekday]}` : 'online research on · schedule off') : settings.enabled ? 'scheduled online research off' : 'Scout paused'}
          </span>
          <span className="scout-state muted" title="The current Scout builds proposals with local deterministic matching rules; it does not send source text to a provider model.">
            {overview.analysisMethod === 'deterministic-rules' ? 'local rules' : overview.analysisMethod}
          </span>
          <button className="btn" type="button" disabled={loading || busy !== null || !settings.enabled}
                  title={settings.enabled ? 'Refresh the local capability inventory without contacting a source.' : 'Enable Scout workspace below before running it.'}
                  onClick={() => void run('preview')}>
            {busy === 'run-preview' ? 'Previewing…' : 'Preview locally'}
          </button>
          <button className="btn btn-primary" type="button" disabled={loading || busy !== null || !settings.enabled}
                  title={settings.enabled ? 'Make one explicit allow-listed online source check without enabling the weekly watch.' : 'Enable Scout workspace below before running it.'}
                  onClick={() => void run('manual')}>
            {busy === 'run-manual' ? 'Scanning…' : 'Run scout now'}
          </button>
        </div>
      </header>

      <div className="scout-scroll">
        <div className="scout-stack">
          {error && <div className="scout-banner error" role="alert"><span aria-hidden="true">!</span><div><strong>Scout could not load</strong><p>{error}</p></div></div>}
          {notice && <div className="scout-banner ok" role="status"><span aria-hidden="true">✓</span><div><strong>{notice.message}</strong>{notice.goalId && <p><a className="scout-goal-link" href={goalHref(notice.goalId)} onClick={() => onOpenGoal?.(notice.goalId!)}>Open Goal in Control →</a></p>}</div></div>}

          <section className="scout-stat-grid" aria-label="Improvement Scout summary">
            <article className="card scout-stat"><span className="label">New to review</span><strong>{overview.pendingSuggestions.toLocaleString()}</strong><small>source-backed proposals</small></article>
            <article className="card scout-stat"><span className="label">Research sources</span><strong>{overview.enabledSourceCount}/{overview.sourceCount}</strong><small>enabled for the next scan</small></article>
            <article className="card scout-stat"><span className="label">Last scan</span><strong className="scout-date">{formatWhen(overview.lastRunAt)}</strong><small>local run history</small></article>
            <article className="card scout-stat"><span className="label">Next review</span><strong className="scout-date">{settings.weeklyEnabled && settings.enabled && settings.networkEnabled ? formatWhen(overview.nextRunAt) : 'not scheduled'}</strong><small>{settings.weeklyEnabled ? overview.cadenceLabel : 'enable a weekly watch below'}</small></article>
          </section>

          <section className="card scout-guide" aria-labelledby="scout-safety-title">
            <div>
              <span className="label">A controlled research loop</span>
              <h3 id="scout-safety-title">Ideas are not updates.</h3>
              <p>This build uses local deterministic matching rules over allowed sources; it does not send source text to a provider model. Scout can collect release notes and trusted source metadata on a schedule, but it cannot modify Wanigan, install anything, change your provider, deploy code, or start an agent. A proposal becomes work only when you create a Goal and then choose to start its task.</p>
            </div>
            <ul className="scout-safety-list">
              <li><span aria-hidden="true">✓</span><span>Scheduled online research stays off until you explicitly allow it.</span></li>
              <li><span aria-hidden="true">✓</span><span>The current analyzer is deterministic; no source text is sent to an AI model.</span></li>
              <li><span aria-hidden="true">✓</span><span>Each proposal retains its source evidence and uncertainty.</span></li>
              <li><span aria-hidden="true">✓</span><span>Creating a Goal preserves the evidence; it does not launch work.</span></li>
            </ul>
          </section>

          <section className="scout-grid">
            <article className="card scout-card">
              <div className="scout-card-head"><div><span className="label">Schedule and consent</span><h3>Choose when research can run</h3><p>Weekly scans use only the sources enabled in the adjacent list. Local preview never contacts a source; “Run scout now” is a one-time, visible allow-listed online check and never enables the weekly schedule.</p></div></div>
              <div className="scout-setting-grid">
                <label className="scout-toggle">
                  <input type="checkbox" checked={settings.enabled} disabled={busy !== null}
                         onChange={(event) => void patchSettings({ enabled: event.target.checked }, event.target.checked ? 'Scout workspace enabled. Online checks remain off until you explicitly allow them.' : 'Scout workspace paused. Existing proposals stay available for review.')} />
                  <span><strong>Enable Scout workspace</strong><small>Controls the local research inbox and its schedule.</small></span>
                </label>
                <label className="scout-toggle">
                  <input type="checkbox" checked={settings.networkEnabled} disabled={busy !== null || !settings.enabled}
                         onChange={(event) => void patchSettings({ networkEnabled: event.target.checked }, event.target.checked ? 'Online source checks are permitted for your selected allow-list.' : 'Online source checks are blocked. You can still review existing local proposals.')} />
                  <span><strong>Allow unattended official-source checks</strong><small>Explicitly permits your source allow-list on the weekly watch.</small></span>
                </label>
                <label className="scout-toggle">
                  <input type="checkbox" checked={settings.weeklyEnabled} disabled={busy !== null || !settings.enabled || !settings.networkEnabled}
                         onChange={(event) => void patchSettings({ weeklyEnabled: event.target.checked }, event.target.checked ? 'Weekly watch enabled.' : 'Weekly watch paused.')} />
                  <span><strong>Weekly watch</strong><small>Runs only when research is allowed.</small></span>
                </label>
                <label><span className="label">Local time</span><select className="field" value={settings.hour} disabled={busy !== null || !settings.enabled} onChange={(event) => void patchSettings({ hour: Number(event.target.value) }, 'Weekly scan time updated.')}>
                  {Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' })}</option>)}
                </select></label>
                <label><span className="label">Day</span><select className="field" value={settings.weekday} disabled={busy !== null || !settings.enabled} onChange={(event) => void patchSettings({ weekday: Number(event.target.value) }, 'Weekly scan day updated.')}>
                  {WEEKDAYS.map((day, index) => <option value={index} key={day}>{day}</option>)}
                </select></label>
              </div>
            </article>

            <article className="card scout-card sources">
              <div className="scout-card-head"><div><span className="label">Source allow-list</span><h3>What Scout can read</h3><p>Only switch on sources you want checked. Each link opens the source itself, not a Wanigan summary.</p></div><span className="scout-state muted">{sources.filter((source) => source.enabled).length} enabled</span></div>
              <div className="scout-sources">
                {sources.length === 0 && <p className="scout-no-evidence">No sources are configured yet. Scout cannot research until a trusted source is available.</p>}
                {sources.map((source) => <label className={`scout-source ${source.enabled ? '' : 'disabled'}`} key={source.id}>
                  <input type="checkbox" checked={source.enabled} disabled={busy !== null} onChange={(event) => void toggleSource(source, event.target.checked)} aria-label={`Include ${source.label} in Scout research`} />
                  <span className="scout-source-copy"><strong>{source.label}</strong><small>{source.description}</small></span>
                  {source.url && <a href={source.url} target="_blank" rel="noreferrer">Source ↗</a>}
                </label>)}
              </div>
            </article>
          </section>

          <section className="card scout-filterbar" aria-label="Filter Scout proposals">
            <div className="scout-filter-copy"><span className="label">Review queue</span><h3>{filteredSuggestions.length} proposal{filteredSuggestions.length === 1 ? '' : 's'}</h3><p>Ranked proposals are suggestions, not a claim that the feature is appropriate for your setup.</p></div>
            <div className="scout-filter-controls">
              <label><span className="label">Status</span><select className="field" value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map((item) => <option value={item} key={item}>{item === 'all' ? 'All statuses' : displayStatus(item)}</option>)}</select></label>
              <label><span className="label">Order</span><select className="field" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="score">Highest score</option><option value="newest">Newest first</option><option value="effort">Effort</option></select></label>
              <label><span className="label">Find</span><input className="field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search proposals" /></label>
            </div>
          </section>

          <section className="scout-results" aria-live="polite">
            {loading && <div className="scout-empty"><span aria-hidden="true">◌</span><div><h3>Reading local Scout records…</h3><p>Nothing is being scanned while this dashboard loads.</p></div></div>}
            {!loading && filteredSuggestions.length === 0 && <div className="scout-empty"><span aria-hidden="true">⌕</span><div><h3>{suggestions.length ? 'No proposal matches these filters' : 'No proposals yet'}</h3><p>{suggestions.length ? 'Clear a filter or try another search.' : 'Enable sources, then run a visible preview or schedule a weekly scan. Scout will never apply an update by itself.'}</p></div></div>}
            {filteredSuggestions.map((suggestion) => {
              const inspected = inspectedId === suggestion.id;
              const goalId = goalIds[suggestion.id] ?? suggestion.goalId;
              const creating = busy === `goal-${suggestion.id}`;
              return <article className={`card scout-suggestion status-${suggestion.status}`} key={suggestion.id}>
                <div className="scout-suggestion-top">
                  <div className="scout-suggestion-title"><span className="label">{suggestion.category} · found {formatDate(suggestion.createdAt)}</span><h3>{suggestion.title}</h3><p>{suggestion.summary}</p></div>
                  <span className={`scout-status ${suggestion.status}`}>{displayStatus(suggestion.status)}</span>
                </div>
                <div className="scout-score-grid" aria-label="Proposal assessment">
                  <div><small>Priority score</small><strong>{score(suggestion.score)}</strong></div>
                  <div><small>Confidence</small><strong>{pct(suggestion.confidence)}</strong></div>
                  <div><small>Effort</small><strong>{suggestion.effort}</strong></div>
                  <div><small>Risk</small><strong><span className={`scout-chip risk-${suggestion.risk}`}>{suggestion.risk}</span></strong></div>
                </div>
                {suggestion.whyNow && <div className="scout-why"><strong>Why it surfaced now:</strong> {suggestion.whyNow}</div>}
                <div className="scout-actions" style={{ marginTop: 'var(--s-3)' }}>
                  <button className="btn" type="button" aria-expanded={inspected} onClick={() => setInspectedId((current) => current === suggestion.id ? null : suggestion.id)}>{inspected ? 'Hide evidence' : 'Inspect evidence'}</button>
                  {suggestion.status === 'new' && <button className="btn" type="button" disabled={busy !== null} onClick={() => void updateSuggestion(suggestion, 'reviewed', 'Proposal marked reviewed. Its source evidence remains attached.')}>{busy === `suggestion-${suggestion.id}-reviewed` ? 'Saving…' : 'Mark reviewed'}</button>}
                  {suggestion.status === 'reviewed' && <button className="btn" type="button" disabled={busy !== null} onClick={() => void updateSuggestion(suggestion, 'snoozed', 'Proposal snoozed. Reopen it whenever it becomes relevant again.')}>{busy === `suggestion-${suggestion.id}-snoozed` ? 'Snoozing…' : 'Snooze'}</button>}
                  {['snoozed', 'dismissed'].includes(suggestion.status) && <button className="btn" type="button" disabled={busy !== null} onClick={() => void updateSuggestion(suggestion, 'new', 'Proposal reopened for review.')}>{busy === `suggestion-${suggestion.id}-new` ? 'Reopening…' : 'Reopen'}</button>}
                  {!goalId && suggestion.status !== 'dismissed' && <button className="btn" type="button" disabled={busy !== null} onClick={() => void updateSuggestion(suggestion, 'dismissed', 'Proposal dismissed. Its evidence remains in the local record.')}>{busy === `suggestion-${suggestion.id}-dismissed` ? 'Dismissing…' : 'Dismiss'}</button>}
                  {goalId && <button className="btn btn-primary" type="button" onClick={() => openGoal(goalId)}>Open linked Goal</button>}
                </div>
                {inspected && <div className="scout-inspection">
                  <div><span className="label">Recommended next step</span><h4>Scope before implementation</h4><p>{suggestion.recommendation || 'No implementation plan was generated. Review the linked sources and define the smallest testable next step.'}</p></div>
                  <div><span className="label">Evidence</span><h4>{suggestion.evidence.length} linked source{suggestion.evidence.length === 1 ? '' : 's'}</h4><div className="scout-evidence-list">{suggestion.evidence.length === 0 && <p className="scout-no-evidence">This proposal has no safely linked evidence yet. Do not turn it into work until the source is attached.</p>}{suggestion.evidence.map((evidence, index) => <div className="scout-evidence" key={`${suggestion.id}-evidence-${index}`}><strong>{evidence.title}</strong>{evidence.url && <a href={evidence.url} target="_blank" rel="noreferrer">Open source ↗</a>}{evidence.excerpt && <p>{evidence.excerpt}</p>}<small>{[evidence.publisher, evidence.publishedAt ? formatDate(evidence.publishedAt) : null].filter(Boolean).join(' · ') || 'Publisher/date not supplied'}</small></div>)}</div></div>
                  <div className="scout-goal-picker"><label><span className="label">Project for Goal</span><select className="field" value={goalProjectId} onChange={(event) => setGoalProjectId(event.target.value)} disabled={creating}>{projects.length === 0 && <option value="">No projects available</option>}{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><p>A Goal records the source evidence and an acceptance contract. It does not make a code change or launch an agent.</p><div className="scout-actions">{goalId ? <button className="btn btn-primary" type="button" onClick={() => openGoal(goalId)}>Open Goal in Control →</button> : suggestion.status === 'dismissed' ? <span className="faint">Reopen this proposal before creating work from it.</span> : <button className="btn btn-primary" type="button" disabled={busy !== null || !goalProjectId || suggestion.evidence.length === 0} onClick={() => void createGoal(suggestion)}>{creating ? 'Creating Goal…' : 'Create linked Goal'}</button>}</div></div>
                </div>}
              </article>;
            })}
          </section>
        </div>
      </div>
    </div>
  );
}
