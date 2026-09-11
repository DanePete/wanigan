import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@shared/types';
import { EmptyState, Explainer, Note, PageHead, Reading, SectionHead, Segmented } from '../components/bits';
import { useViewMemory } from '../components/viewMemory';
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

/** One scan. The main process has always returned this; the view discarded it. */
type ScoutRun = {
  id: string;
  mode: string;
  status: 'running' | 'completed' | 'blocked' | 'failed' | 'unknown';
  networkAllowed: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  suggestionCount: number;
  error: string | null;
  /** Why a run was blocked. Main records it here with `error` left null. */
  detail: string | null;
};

type ScoutOverview = {
  enabled: boolean;
  weeklyEnabled: boolean;
  networkEnabled: boolean;
  cadenceLabel: string;
  /** The most recent scan, outcome included. `lastRunAt` is only its clock. */
  latestRun: ScoutRun | null;
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
  latestRun: null,
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

/** Glyph first, then the word. Colour is the third channel here, never the only one. */
const RUN_GLYPH: Record<ScoutRun['status'], string> = {
  running: '◐', completed: '✓', blocked: '⁃', failed: '✕', unknown: '?',
};

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

/**
 * A scan's own account of itself. `status` is the field that matters: the main
 * process reports 'blocked' when a consent gate stopped the scan and 'failed'
 * when it broke, and this view used to read neither — so both looked exactly
 * like a completed run, on the banner and on the "Last scan" card alike.
 */
function normalizeRun(value: unknown): ScoutRun {
  const raw = asRecord(value) ?? {};
  const status = string(raw.status, 'unknown');
  return {
    id: string(raw.id),
    mode: string(raw.mode, 'manual'),
    status: (['running', 'completed', 'blocked', 'failed'].includes(status) ? status : 'unknown') as ScoutRun['status'],
    networkAllowed: bool(raw.networkAllowed ?? raw.allowNetwork),
    startedAt: timestamp(raw.startedAt ?? raw.started_at),
    finishedAt: timestamp(raw.finishedAt ?? raw.finished_at),
    suggestionCount: numeric(raw.suggestionCount ?? raw.suggestions, 0) ?? 0,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    // Every blocked outcome carries its reason here, not in `error`: main calls
    // finish('blocked', { detail: … }) with error null. Dropping it left the
    // card printing the bare word 'blocked' for a scan whose reason was
    // recorded, and which the phone has been showing all along.
    detail: typeof raw.detail === 'string' && raw.detail ? raw.detail : null,
  };
}

function normalizeOverview(value: unknown): ScoutOverview {
  const raw = asRecord(value) ?? {};
  return {
    latestRun: raw.latestRun === null || raw.latestRun === undefined ? null : normalizeRun(raw.latestRun),
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
  return status.replace(/[_-]/g, ' ');
}

function formatWhen(at: number | null): string {
  if (!at) return 'not yet';
  return new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDate(at: number | null): string {
  if (!at) return 'date not supplied';
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Confidence is a deterministic rule-table output, not a measurement, so it
 * renders as a plain 0–1 value beside its basis instead of as a headline
 * percentage — the same grammar the Learning surfaces already use. A proposal
 * the rules gave no confidence says so rather than printing a bare dash.
 */
function ruleConfidence(value: number | null): string {
  return value === null ? 'not derived' : Math.max(0, Math.min(1, value)).toFixed(2);
}

function goalHref(id: string): string {
  return `#goal=${encodeURIComponent(id)}`;
}

/**
 * Effort arrives as free text, so ordering it alphabetically put 'high' above
 * 'low' above 'medium' and interleaved 'Unestimated' — a ranking that ranked
 * nothing. Known words sort smallest first; anything unrecognised sorts last
 * rather than claiming a size it was never given.
 */
const EFFORT_RANK: Record<string, number> = {
  trivial: 0, tiny: 0, xs: 0,
  small: 1, low: 1, s: 1,
  medium: 2, moderate: 2, m: 2,
  large: 3, high: 3, l: 3,
  xl: 4, huge: 4,
};

function effortRank(effort: string): number {
  const known = EFFORT_RANK[effort.trim().toLowerCase()];
  return known === undefined ? Number.MAX_SAFE_INTEGER : known;
}

type ScoutArea = 'proposals' | 'sources' | 'watch';
type ReaderArea = 'brief' | 'evidence' | 'goal';

export default function ImprovementScout({ projects, onOpenGoal }: {
  projects: Project[];
  onOpenGoal?: (id: string) => void;
}) {
  const [overview, setOverview] = useState<ScoutOverview>(EMPTY_OVERVIEW);
  const [settings, setSettings] = useState<ScoutSettings>(EMPTY_SETTINGS);
  const [sources, setSources] = useState<ScoutSource[]>([]);
  const [suggestions, setSuggestions] = useState<ScoutSuggestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [area, setArea] = useViewMemory<ScoutArea>('area', 'proposals');
  const [readerArea, setReaderArea] = useViewMemory<ReaderArea>('reader-area', 'brief');
  const [status, setStatus] = useViewMemory('status', 'all');
  const [query, setQuery] = useViewMemory('query', '');
  const [sort, setSort] = useViewMemory<'newest' | 'effort'>('sort', 'newest');
  const [selectedId, setSelectedId] = useViewMemory<string | null>('selected', null);
  const [goalProjectId, setGoalProjectId] = useViewMemory('goal-project', projects[0]?.id ?? '');
  const [goalIds, setGoalIds] = useViewMemory<Record<string, string>>('goal-receipts', {});
  const alive = useRef(true), sequence = useRef(0), actionLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const load = useCallback(async () => {
    if (!alive.current) return;
    const mine = ++sequence.current;
    setLoading(true);
    try {
      const api = scout();
      const [nextOverview, nextSettings, nextSources, nextSuggestions] = await Promise.all([
        api.overview(), api.settings(), api.sources(), api.suggestions({ limit: 150 }),
      ]);
      if (!alive.current || mine !== sequence.current) return;
      setOverview(normalizeOverview(nextOverview));
      setSettings(normalizeSettings(nextSettings));
      setSources(array(nextSources).map(normalizeSource));
      setSuggestions(array(nextSuggestions).map(normalizeSuggestion));
      setReadError(null);
      setLoaded(true);
    } catch (reason) {
      if (alive.current && mine === sequence.current) setReadError(errorText(reason));
    } finally {
      if (alive.current && mine === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const disabled = !loaded || loading || !!readError || busy !== null;
  const act = useCallback(async (key: string, work: () => Promise<void>, message?: Notice) => {
    if (actionLock.current || disabled) return;
    actionLock.current = true;
    setBusy(key); setError(null); setNotice(null);
    try {
      await work();
      if (alive.current && message) setNotice(message);
    } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { actionLock.current = false; if (alive.current) setBusy(null); }
  }, [disabled]);
  const patchSettings = (patch: JsonObject, message: string) => act('settings', async () => {
    await scout().setSettings(patch); await load();
  }, { message });
  const toggleSource = (source: ScoutSource, enabled: boolean) => act(`source-${source.id}`, async () => {
    await scout().setSourceEnabled(source.id, enabled); await load();
  }, { message: `${source.label} is ${enabled ? 'included' : 'excluded'} from future scans.` });
  const run = (mode: 'manual' | 'preview') => act(`run-${mode}`, async () => {
    // Manual is one explicit online pass; preview can never inherit saved consent.
    const result = normalizeRun(await scout().run(mode === 'manual' ? { mode, allowNetwork: true } : { mode }));
    await load();
    if (result.status === 'blocked' || result.status === 'failed' || result.status === 'unknown') {
      throw new Error(result.error ?? result.detail ?? `The scan outcome is ${result.status}. Refresh to read its recorded result.`);
    }
    if (alive.current) setNotice({ message: result.status === 'running'
      ? 'Scout is still running. Refresh to read its recorded result.'
      : `${mode === 'preview' ? 'Local preview' : 'Online check'} completed. ${result.detail ?? 'Review the recorded proposals below.'}` });
  });
  const updateSuggestion = (suggestion: ScoutSuggestion, nextStatus: string, message: string) => act(`suggestion-${suggestion.id}`, async () => {
    await scout().updateSuggestion(suggestion.id, { status: nextStatus }); await load();
  }, { message });
  const createGoal = (suggestion: ScoutSuggestion) => act(`goal-${suggestion.id}`, async () => {
    if (!projects.some(project => project.id === goalProjectId)) throw new Error('Choose an available project for this Goal.');
    const api = scout();
    // Only this endpoint verifies retained official evidence and links the Goal.
    if (!api.createGoal) throw new Error('Scout Goal linking needs a Wanigan restart to finish updating its local services.');
    const receipt = await api.createGoal(suggestion.id, { projectId: goalProjectId });
    if (!alive.current) return;
    setGoalIds(previous => ({ ...previous, [suggestion.id]: receipt.goalId }));
    await load();
    if (alive.current) setNotice({ message: 'Goal created with this proposal and its evidence. No agent was started.', goalId: receipt.goalId });
  });
  const openGoal = (id: string) => {
    const link = goalHref(id);
    if (window.location.hash !== link) window.history.replaceState(null, '', link);
    onOpenGoal?.(id);
  };
  const statuses = useMemo(() => ['all', ...new Set(suggestions.map(item => item.status))], [suggestions]);
  useEffect(() => { if (loaded && !statuses.includes(status)) setStatus('all'); }, [loaded, statuses, status, setStatus]);
  const filteredSuggestions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return suggestions.filter(item => (status === 'all' || item.status === status) && (!normalized ||
      [item.title, item.summary, item.category, item.whyNow, item.recommendation].some(part => part.toLowerCase().includes(normalized))))
      .sort((a, b) => (sort === 'effort' ? effortRank(a.effort) - effortRank(b.effort) : 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [query, sort, status, suggestions]);
  const selected = filteredSuggestions.find(item => item.id === selectedId) ?? filteredSuggestions[0] ?? null;
  const linkedGoal = selected ? goalIds[selected.id] ?? selected.goalId : null;
  const needsSetup = !settings.enabled || sources.every(source => !source.enabled);
  const filterStatus = useMemo(() => {
    if (loading) return 'Reading local Scout records…';
    if (suggestions.length === 0) return 'Nothing proposed yet.';
    if (filteredSuggestions.length === 0) return 'No proposal matches these filters.';
    return `Showing ${filteredSuggestions.length} of ${suggestions.length}.`;
  }, [filteredSuggestions.length, loading, suggestions.length]);
  const watchLabel = !settings.enabled ? 'Scout paused' : settings.networkEnabled && settings.weeklyEnabled
    ? `Weekly · ${WEEKDAYS[settings.weekday]}` : 'Watch off';
  const clearFilters = () => { setQuery(''); setStatus('all'); };

  return <div className="pane wide scout-view">
    <PageHead compact eyebrow="Knowledge" title="Scout" lead="A watchful eye on what’s next. You decide what’s worth pursuing."
      actions={<>
        <button className="btn" disabled={loading || busy !== null} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        <button className="btn" disabled={disabled || !settings.enabled} onClick={() => void run('preview')} title="Refresh the local inventory without contacting a source.">{busy === 'run-preview' ? 'Previewing…' : 'Preview locally'}</button>
        <button className="btn btn-primary" disabled={disabled || !settings.enabled} onClick={() => void run('manual')} title="One explicit online check of enabled official sources. Does not enable the weekly watch.">{busy === 'run-manual' ? 'Checking sources…' : 'Run scout now'}</button>
      </>} />
    <div className="scout-workspace">
      <div className="scout-navigation">
        <Segmented<ScoutArea> label="Scout workspace" value={area} onChange={setArea} options={[{ value: 'proposals', label: 'Proposals' }, { value: 'sources', label: 'Sources' }, { value: 'watch', label: 'Watch' }]} />
        <div className="scout-watch-label">{loaded ? <><span className="scout-watch-dot" data-active={settings.enabled && settings.networkEnabled && settings.weeklyEnabled} aria-hidden="true" />{watchLabel}<span className="dim">{overview.analysisMethod === 'deterministic-rules' ? 'Local rules' : overview.analysisMethod}</span></> : 'Waiting for local records'}</div>
      </div>
      <div className="scout-feedback">
        {readError && <Note tone="error" action={!loading && busy === null ? { label: 'Read again', run: load } : undefined}>{loaded ? 'The last successful read is still shown. Refresh before making changes.' : 'Scout records could not be read.'} {readError}</Note>}
        {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
        <Note tone="ok" role="status" onDismiss={notice ? () => setNotice(null) : undefined}>{notice?.message}{notice?.goalId && <button className="link" onClick={() => openGoal(notice.goalId!)}>Open linked Goal →</button>}</Note>
      </div>
      {!loaded ? <div className="scout-scroll">{loading ? <Reading what="local Scout records" /> : <EmptyState posture="could-not-read" title="Your proposals are unavailable" cue="Try reading the local records again." />}</div> : <div className="scout-scroll" data-area={area}>
        {area === 'proposals' && <>
          {needsSetup && <Note role="none" action={{ label: !settings.enabled ? 'Set up watch' : 'Choose sources', run: () => setArea(!settings.enabled ? 'watch' : 'sources') }}>{!settings.enabled ? 'Scout is paused. Your saved proposals remain here to review.' : 'Choose at least one official source before an online check.'}</Note>}
          <div className="scout-review">
            <div className="scout-directory">
              <SectionHead label="Proposals" count={suggestions.length} />
              <input className="field" type="search" aria-label="Find proposals" placeholder="Find an idea…" value={query} onChange={event => setQuery(event.target.value)} />
              <div className="scout-filters">
                <select className="field" aria-label="Proposal status" value={status} onChange={event => setStatus(event.target.value)}>{statuses.map(value => <option key={value} value={value}>{value === 'all' ? 'All statuses' : displayStatus(value)}</option>)}</select>
                <select className="field" aria-label="Proposal order" value={sort} onChange={event => setSort(event.target.value as 'newest' | 'effort')}><option value="newest">Newest first</option><option value="effort">Smallest effort</option></select>
              </div>
              <div className="scout-count"><p className="scout-filter-status" role="status">{filterStatus}</p>{(query || status !== 'all') && <button className="link" onClick={clearFilters}>Clear filters</button>}</div>
              <section className="scout-results">
                {filteredSuggestions.map(item => <button key={item.id} className="scout-entry" aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
                  <span className="scout-entry-meta"><span>{item.category}</span><span>{displayStatus(item.status)}</span></span>
                  <strong>{item.title}</strong><span className="scout-entry-summary">{item.summary}</span>
                  <span className="scout-entry-meta"><span>{item.evidence.length} {item.evidence.length === 1 ? 'source' : 'sources'} · {item.effort} effort</span><span>{formatDate(item.createdAt)}</span></span>
                </button>)}
                {!filteredSuggestions.length && <EmptyState posture={suggestions.length ? 'nothing-in-scope' : 'nothing-yet'} title={suggestions.length ? 'No matching proposals' : 'Room for the next idea'} cue={suggestions.length ? 'Try a different phrase or status.' : 'An explicit check of your enabled sources can add proposals here.'} />}
              </section>
              <p className="scout-limit">Up to 150 stored proposals. Ordering applies to this loaded set.</p>
            </div>
            {selected ? <article className="scout-reader" aria-label="Selected proposal">
              <div className="scout-reader-intro"><div className="scout-entry-meta"><span>{selected.category}</span><span>{displayStatus(selected.status)}</span></div><h2>{selected.title}</h2><p>{selected.summary}</p></div>
              <Segmented<ReaderArea> label="Proposal reader section" value={readerArea} onChange={setReaderArea} options={[{ value: 'brief', label: 'Brief' }, { value: 'evidence', label: `Evidence · ${selected.evidence.length}` }, { value: 'goal', label: 'Goal' }]} />
              <div className="scout-reading" key={`${selected.id}/${readerArea}`} tabIndex={0} role="region" aria-label="Proposal content">
                {readerArea === 'brief' && <div className="scout-brief">
                  <dl className="scout-reasons"><div><dt>Effort</dt><dd>{selected.effort}</dd></div><div><dt>Risk</dt><dd>{selected.risk}</dd></div><div><dt>Rule confidence</dt><dd>{ruleConfidence(selected.confidence)}<small>Rule-derived · not measured</small></dd></div></dl>
                  <section><SectionHead label="Why now" /><p>{selected.whyNow || 'No timing rationale was recorded.'}</p></section>
                  <section><SectionHead label="Proposed work" /><p className="scout-prose">{selected.recommendation || 'No recommendation was recorded.'}</p></section>
                  <button className="link" onClick={() => setReaderArea('evidence')}>Read the evidence →</button>
                </div>}
                {readerArea === 'evidence' && <div className="scout-evidence">
                  <SectionHead label="Retained sources" count={selected.evidence.length} />
                  {selected.evidence.length ? selected.evidence.map((evidence, index) => <section className="scout-citation" key={`${evidence.url}/${index}`}>
                    <span className="scout-citation-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><div className="scout-entry-meta"><span>{evidence.publisher || 'Publisher not supplied'}</span><span>{formatDate(evidence.publishedAt)}</span></div><h3>{evidence.url ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.title} ↗</a> : evidence.title}</h3><p>{evidence.excerpt || 'No excerpt was retained.'}</p>{evidence.url && <span className="scout-citation-url">{new URL(evidence.url).hostname}</span>}</div>
                  </section>) : <EmptyState posture="nothing-yet" title="No retained evidence" cue="A linked Goal requires evidence verified by Scout’s local service." />}
                </div>}
                {readerArea === 'goal' && <div className="scout-goal">
                  <SectionHead label="From idea to work" />
                  <h3>{linkedGoal ? 'This idea has a home.' : 'Give this idea a destination.'}</h3>
                  <p>Create a Goal with this proposal and its retained evidence. Starting an agent is a separate action in Review.</p>
                  {linkedGoal ? <button className="btn btn-primary" onClick={() => openGoal(linkedGoal)}>Open linked Goal →</button> : selected.status === 'dismissed' ? <Note role="none">Reopen this proposal before creating a Goal.</Note> : <>
                    <label className="scout-project"><span className="label">Project for Goal</span><select className="field" aria-label="Project for Goal" value={projects.some(project => project.id === goalProjectId) ? goalProjectId : ''} disabled={disabled} onChange={event => setGoalProjectId(event.target.value)}><option value="">Choose a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                    {!selected.evidence.length && <Note role="none">This proposal has no retained evidence. A linked Goal is unavailable.</Note>}
                    <button className="btn btn-primary" disabled={disabled || !projects.some(project => project.id === goalProjectId) || !selected.evidence.length} onClick={() => void createGoal(selected)}>{busy === `goal-${selected.id}` ? 'Creating Goal…' : 'Create linked Goal'}</button>
                  </>}
                </div>}
              </div>
              <div className="scout-review-actions">
                <span className="scout-limit">Your call.</span>
                {selected.status === 'new' && <button className="btn btn-sm" disabled={disabled} onClick={() => void updateSuggestion(selected, 'reviewed', 'Proposal marked reviewed.')}>Mark reviewed</button>}
                {selected.status === 'reviewed' && <button className="btn btn-sm" disabled={disabled} onClick={() => void updateSuggestion(selected, 'snoozed', 'Proposal snoozed.')}>Snooze</button>}
                {(selected.status === 'snoozed' || selected.status === 'dismissed') && <button className="btn btn-sm" disabled={disabled} onClick={() => void updateSuggestion(selected, 'new', 'Proposal reopened.')}>Reopen</button>}
                {!linkedGoal && selected.status !== 'dismissed' && <button className="btn btn-sm" disabled={disabled} onClick={() => void updateSuggestion(selected, 'dismissed', 'Proposal dismissed.')}>Dismiss proposal</button>}
                {linkedGoal && readerArea !== 'goal' && <button className="link" onClick={() => openGoal(linkedGoal)}>Open linked Goal →</button>}
              </div>
            </article> : <div className="scout-reader-empty"><EmptyState posture={suggestions.length ? 'nothing-in-scope' : 'nothing-yet'} title="An idea, with its receipts." cue="Select a proposal to read the recommendation, inspect its sources, and decide what happens next." /></div>}
          </div>
        </>}
        {area === 'sources' && <div className="scout-settings-layout">
          <div className="scout-introduction"><span className="label">Official sources</span><h2>Choose where<br />Scout looks.</h2><p>Only the enabled sources below are eligible for online checks. Each proposal keeps its evidence close.</p><div className="scout-source-total"><strong>{sources.filter(source => source.enabled).length}</strong><span>of {sources.length} sources enabled</span></div><p className="scout-limit">Opening a source visits its website. It does not change your selection.</p></div>
          <div className="scout-sources"><SectionHead label="Source directory" count={sources.length} />{sources.map(source => <div className="scout-source" key={source.id}>
            <label><input type="checkbox" disabled={disabled} checked={source.enabled} onChange={event => void toggleSource(source, event.target.checked)} /><span><strong>{source.label}</strong><span>{source.description}</span></span></label>
            {source.url && <a className="link" href={source.url} target="_blank" rel="noreferrer" aria-label={`Visit ${source.label}`}>Visit source ↗</a>}
          </div>)}{!sources.length && <EmptyState posture="nothing-yet" title="No sources were returned" cue="Refresh to check the local source directory." />}</div>
        </div>}
        {area === 'watch' && <div className="scout-settings-layout">
          <div className="scout-introduction"><span className="label">On your terms</span><h2>A little<br />forward thinking.</h2><p>Set the rhythm. Scout checks selected official sources and leaves proposals for you to review.</p><div className="scout-next"><span className="label">Next scheduled check</span><strong>{overview.nextRunAt ? formatWhen(overview.nextRunAt) : 'Not scheduled'}</strong><span className="scout-limit">Local time · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><Explainer id="scout-safety" title="Ideas are not updates" defaultHidden><p>Scout uses local deterministic rules. It does not call a model, modify code, install packages, or start an agent. A Goal is created only when you choose it; execution is a separate step.</p></Explainer></div>
          <div className="scout-watch-settings">
            <SectionHead label="Workspace & permissions" />
            <label className="scout-switch"><span><strong>Enable Scout workspace</strong><small>Allow local previews and explicit source checks. Saved permissions are retained when paused.</small></span><input type="checkbox" checked={settings.enabled} disabled={disabled} onChange={event => void patchSettings({ enabled: event.target.checked }, event.target.checked ? 'Scout workspace enabled. Saved watch permissions are shown below.' : 'Scout workspace paused.')} /></label>
            <label className="scout-switch"><span><strong>Allow unattended official-source checks</strong><small>Permission for scheduled network access. “Run scout now” requests a single online check separately.</small></span><input type="checkbox" checked={settings.networkEnabled} disabled={disabled || !settings.enabled} onChange={event => void patchSettings({ networkEnabled: event.target.checked }, 'Unattended network permission updated.')} /></label>
            <label className="scout-switch"><span><strong>Weekly watch</strong><small>A scheduled check needs both unattended permission and an enabled source.</small></span><input type="checkbox" checked={settings.weeklyEnabled} disabled={disabled || !settings.enabled || !settings.networkEnabled} onChange={event => void patchSettings({ weeklyEnabled: event.target.checked }, 'Weekly watch updated.')} /></label>
            <div className="scout-schedule"><label><span className="label">Day</span><select className="field" aria-label="Weekly watch day" disabled={disabled || !settings.enabled} value={settings.weekday} onChange={event => void patchSettings({ weekday: Number(event.target.value) }, 'Watch day updated.')}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label><span className="label">Local time</span><select className="field" aria-label="Weekly watch time" disabled={disabled || !settings.enabled} value={settings.hour} onChange={event => void patchSettings({ hour: Number(event.target.value) }, 'Watch time updated.')}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label></div>
            <section className="scout-last-run"><SectionHead label="Last recorded scan" /><div className="scout-run-outcome"><strong>{overview.latestRun ? `${RUN_GLYPH[overview.latestRun.status]} ${overview.latestRun.status}` : 'No scan recorded'}</strong><span>{formatWhen(overview.latestRun?.finishedAt ?? overview.lastRunAt)}</span></div>{overview.latestRun && <><p>{overview.latestRun.error ?? overview.latestRun.detail ?? 'No run detail was recorded.'}</p><span className="scout-limit">{overview.latestRun.networkAllowed ? 'Network allowed' : 'Local only'} · {overview.latestRun.suggestionCount} proposals recorded</span></>}</section>
          </div>
        </div>}
      </div>}
    </div>
  </div>;
}
