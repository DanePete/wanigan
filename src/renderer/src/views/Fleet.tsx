import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Attention, AttentionKind, Project, ProviderId, Session, SessionUsage, TrustLevel,
} from '@shared/types';
import { ATTENTION_ORDER, EMPTY_USAGE, TRUST_COPY } from '@shared/types';
import { Note, Stat, ago, num, usd } from '../components/bits';

/**
 * The whole crew on one screen — the view you leave open on a second monitor
 * while eight agents work.
 *
 * Two rules drive the layout:
 *  - The question this view answers is "who needs me", so attention rank is the
 *    default order and a blocked agent floats to the top. Spend and age are
 *    there for the other two questions, and both fall back to attention rank as
 *    the tiebreak so the answer never contradicts itself.
 *  - Status is never hue alone. Every mark carries a glyph and a word, because
 *    green against red measures ΔE 4.1 under deuteranopia and "an agent is
 *    blocked waiting for you" is the one signal that must never go invisible.
 */

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)', glm: 'var(--glm)' };
const PROVIDER: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', glm: 'GLM' };

type Mark = { glyph: string; word: string; fg: string; bg: string };

/** Glyph + word + colour, in that order of importance. */
const MARK: Record<AttentionKind, Mark> = {
  permission: { glyph: '?', word: 'Asking',  fg: 'var(--critical)', bg: 'var(--critical-soft)' },
  error:      { glyph: '✕', word: 'Failed',  fg: 'var(--serious)',  bg: 'var(--serious-soft)' },
  finished:   { glyph: '✓', word: 'Done',    fg: 'var(--good)',     bg: 'var(--good-soft)' },
  idle:       { glyph: '◦', word: 'Idle',    fg: 'var(--text-dim)', bg: 'var(--bg-sunk)' },
  working:    { glyph: '▶', word: 'Working', fg: 'var(--accent)',   bg: 'var(--accent-soft)' },
};
const UNKNOWN: Mark = { glyph: '·', word: 'Unknown', fg: 'var(--text-faint)', bg: 'var(--bg-sunk)' };

const TRUST_GLYPH: Record<TrustLevel, string> = { readonly: '◇', project: '◈', trusted: '◆' };

type SortKey = 'attention' | 'spend' | 'age';
const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'attention', label: 'Attention', hint: 'Blocked first, then whoever has waited longest.' },
  { key: 'spend',     label: 'Spend',     hint: 'Most expensive session first.' },
  { key: 'age',       label: 'Age',       hint: 'Longest-running session first.' },
];

const POLL_MS = 3000;
/** Throughput is a whole-session rate; it does not change fast enough to want every tick. */
const SPARK_EVERY = 2;
const BUCKETS = 24;

const rank = (k: AttentionKind | undefined) => {
  const i = ATTENTION_ORDER.indexOf(k as AttentionKind);
  return i < 0 ? ATTENTION_ORDER.length : i;
};

/** "3m 12s" — a bare integer is a puzzle. */
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Output tokens per second, as the collector rounds them. */
const rate = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Fleet({ projects = [], onOpenSession }: {
  projects?: Project[];
  onOpenSession: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [attention, setAttention] = useState<Record<string, Attention>>({});
  const [usage, setUsage] = useState<Record<string, SessionUsage>>({});
  const [spark, setSpark] = useState<Record<string, number[]>>({});
  const [defaultTrust, setDefaultTrust] = useState<TrustLevel>('project');
  const [sort, setSort] = useState<SortKey>('attention');
  const [only, setOnly] = useState<AttentionKind | 'all'>('all');
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  // Re-render on a clock of its own: every "waiting 4m 12s" on screen is stale
  // the second after it is drawn, and the poll alone would only refresh the
  // ones whose numbers happened to change.
  const [, setTick] = useState(0);

  const alive = useRef(true);
  const busy = useRef(false);
  const ticks = useRef(0);
  const sparkIds = useRef<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const again = useRef(false);
  const loadRef = useRef<((withSparks: boolean) => Promise<void>) | null>(null);

  const loadSparks = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const pairs = await Promise.all(ids.map(async (id) => {
      try { return [id, await window.foreman.usage.throughput(id, BUCKETS)] as const; }
      catch { return [id, [] as number[]] as const; }
    }));
    if (!alive.current) return;
    for (const id of ids) sparkIds.current.add(id);
    setSpark((prev) => {
      // Merged, never replaced: a tick that fetches only the new arrivals must
      // not blank the seven cards it did not ask about.
      const next = { ...prev };
      for (const [id, vals] of pairs) next[id] = vals.length ? vals : (next[id] ?? []);
      return next;
    });
  }, []);

  const load = useCallback(async (withSparks: boolean) => {
    // A hook event landing mid-poll must not be swallowed: the whole point of
    // the subscription is that a permission request shows up now rather than on
    // the next beat, so a collided refresh is remembered and re-run.
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try {
      const list = await window.foreman.sessions.list();
      const ids = list.map((s) => s.id);
      const [att, use] = await Promise.all([
        window.foreman.attention.list(),
        ids.length ? window.foreman.usage.many(ids) : Promise.resolve({} as Record<string, SessionUsage>),
      ]);
      if (!alive.current) return;
      setSessions(list);
      const held = new Set(ids);
      sparkIds.current.forEach((id) => { if (!held.has(id)) sparkIds.current.delete(id); });
      setSpark((prev) => {
        const keys = Object.keys(prev);
        if (keys.every((k) => held.has(k))) return prev;   // same object: no re-render
        const kept: Record<string, number[]> = {};
        for (const k of keys) if (held.has(k)) kept[k] = prev[k];
        return kept;
      });
      setAttention(Object.fromEntries(att.map((a) => [a.sessionId, a])));
      setUsage(use);
      setErr(null);
      setUpdatedAt(Date.now());
      setReady(true);
      // A session that appeared since the last tick gets its sparkline now
      // rather than on the next slow beat — an empty cell reads as broken.
      const fresh = ids.filter((id) => !sparkIds.current.has(id));
      if (withSparks || fresh.length) await loadSparks(withSparks ? ids : fresh);
    } catch (e) {
      if (alive.current) { setErr(msg(e)); setReady(true); }
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        if (alive.current) queueMicrotask(() => { void loadRef.current?.(false); });
      }
    }
  }, [loadSparks]);
  loadRef.current = load;

  useEffect(() => {
    alive.current = true;
    void load(true);
    window.foreman.policy.defaultTrust().then(setDefaultTrust).catch(() => {});

    const timer = setInterval(() => {
      // A hidden window is a window nobody is reading; polling it only burns
      // IPC. The subscriptions below still wake it the moment it comes back.
      if (document.hidden) return;
      ticks.current += 1;
      void load(ticks.current % SPARK_EVERY === 0);
    }, POLL_MS);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);

    // Polling alone makes a permission request up to three seconds late. The
    // hook bus knows immediately, so the interval is the floor, not the source.
    const nudge = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(false), 120);
    };
    const onVisible = () => { if (!document.hidden) nudge(); };
    document.addEventListener('visibilitychange', onVisible);
    const offEvent = window.foreman.on.sessionEvent(nudge);
    const offExit = window.foreman.on.exit(nudge);
    const offList = window.foreman.on.sessions((list) => { setSessions(list); nudge(); });

    return () => {
      alive.current = false;
      clearInterval(timer); clearInterval(clock);
      if (debounce.current) clearTimeout(debounce.current);
      document.removeEventListener('visibilitychange', onVisible);
      offEvent(); offExit(); offList();
    };
  }, [load]);

  const branchOf = useMemo(
    () => new Map(projects.map((p) => [p.id, p.branch])),
    [projects],
  );

  const usageOf = useCallback(
    (id: string): SessionUsage => usage[id] ?? { sessionId: id, ...EMPTY_USAGE },
    [usage],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sessions) {
      const k = attention[s.id]?.kind ?? 'idle';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [sessions, attention]);

  const totals = useMemo(() => {
    let cost = 0, requests = 0, added = 0, removed = 0, commits = 0, running = 0;
    for (const s of sessions) {
      const u = usageOf(s.id);
      cost += u.costUsd; requests += u.requests;
      added += u.linesAdded; removed += u.linesRemoved; commits += u.commits;
      if (s.status !== 'exited') running += 1;
    }
    return { cost, requests, added, removed, commits, running, exited: sessions.length - running };
  }, [sessions, usageOf]);

  const blocked = useMemo(
    () => sessions.filter((s) => attention[s.id]?.kind === 'permission')
      .sort((a, b) => (attention[a.id]?.since ?? 0) - (attention[b.id]?.since ?? 0)),
    [sessions, attention],
  );

  const shown = useMemo(() => {
    const visible = only === 'all'
      ? sessions.slice()
      : sessions.filter((s) => (attention[s.id]?.kind ?? 'idle') === only);

    return visible.sort((a, b) => {
      if (sort === 'spend') {
        const d = usageOf(b.id).costUsd - usageOf(a.id).costUsd;
        if (d) return d;
      } else if (sort === 'age') {
        const d = a.createdAt - b.createdAt;
        if (d) return d;
      }
      // Attention rank is the default order and the tiebreak for the others, so
      // two views of the same fleet never disagree about who is worst off.
      const byKind = rank(attention[a.id]?.kind) - rank(attention[b.id]?.kind);
      if (byKind) return byKind;
      const bySince = (attention[a.id]?.since ?? a.createdAt) - (attention[b.id]?.since ?? b.createdAt);
      if (bySince) return bySince;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [sessions, attention, only, sort, usageOf]);

  const head = (
    <div className="pane-head">
      <div>
        <h1>Fleet</h1>
        <p className="dim">Every agent on one screen. Whoever is blocked sorts to the top.</p>
      </div>
      <div className="fleet-controls">
        <div className="fleet-seg" role="group" aria-label="Sort sessions by">
          <span className="label" style={{ paddingRight: 2 }}>Sort</span>
          {SORTS.map((s) => (
            <button key={s.key} className={`fleet-segbtn${sort === s.key ? ' on' : ''}`}
                    aria-pressed={sort === s.key} title={s.hint}
                    onClick={() => setSort(s.key)}>{s.label}</button>
          ))}
        </div>
        <span className="faint fleet-updated">
          {updatedAt ? `updated ${ago(updatedAt)}` : 'never updated'} · every 3s
        </span>
      </div>
    </div>
  );

  if (!ready) {
    return (
      <div className="pane">
        {head}
        <div className="card fleet-blank">
          <p>Reading the fleet…</p>
          <p className="faint">Sessions, attention and usage for each running agent.</p>
        </div>
      </div>
    );
  }

  if (err && !sessions.length) {
    return (
      <div className="pane">
        {head}
        <Note tone="error">
          <strong>Could not read the fleet.</strong> {err}
          <div style={{ marginTop: 6 }}>
            The main process answers these calls; if Foreman is still starting, the database is not
            open yet. Retry, and if it keeps failing reopen the window.
          </div>
          <button className="btn fleet-retry" style={{ marginTop: 8 }} onClick={() => void load(true)}>
            Retry now
          </button>
        </Note>
      </div>
    );
  }

  if (!sessions.length) {
    return (
      <div className="pane">
        {head}
        <div className="card fleet-blank">
          <h2>No agents are running</h2>
          <p className="dim">
            Fleet watches sessions that already exist — it does not start them. Open Sessions and
            press <kbd className="fleet-kbd">⌘T</kbd> to launch one; it appears here within three
            seconds, with its cost, its tokens and what it is waiting on.
          </p>
          <p className="faint">
            Cards fill in as telemetry arrives. Cost and throughput come from the agent's own OTLP
            stream, so the first numbers land after its first API call.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      {head}

      {err && (
        <Note tone="warn">
          <strong>Live updates stalled.</strong> {err} — the cards below are the last good read,
          from {ago(updatedAt)}.{' '}
          <button className="fleet-inline" onClick={() => void load(true)}>Retry now</button>
        </Note>
      )}

      <div aria-live="polite">
        {blocked.length > 0 && (
          <Note tone="error">
            <strong>
              {blocked.length === 1 ? '1 agent is' : `${blocked.length} agents are`} waiting on you.
            </strong>{' '}
            Nothing moves on {blocked.length === 1 ? 'it' : 'them'} until you answer:{' '}
            {blocked.map((s, i) => (
              <span key={s.id}>
                {i > 0 ? ', ' : ''}
                <button className="fleet-inline" onClick={() => onOpenSession(s.id)}>
                  {s.projectName} — {dur(Date.now() - (attention[s.id]?.since ?? Date.now()))}
                </button>
              </span>
            ))}
          </Note>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Agents" value={`${num(totals.running)} running`}
              sub={`${num(totals.exited)} exited · ${num(sessions.length)} cards`} />
        <Stat label="Needs you"
              value={<>{blocked.length > 0 && <span aria-hidden="true">? </span>}{num(blocked.length)}</>}
              tone={blocked.length ? 'var(--critical)' : undefined}
              sub={blocked.length
                ? `longest wait ${dur(Date.now() - (attention[blocked[0].id]?.since ?? Date.now()))}`
                : 'nobody is blocked'} />
        <Stat label="Fleet spend" value={usd(totals.cost)} sub={`${num(totals.requests)} API requests`} />
        <Stat label="Lines changed"
              value={<>+{num(totals.added)} <span className="faint">/</span> −{num(totals.removed)}</>}
              sub={`${num(totals.commits)} commits`} />
      </div>

      <div className="fleet-chips" role="group" aria-label="Filter by status">
        <button className={`fleet-chip${only === 'all' ? ' on' : ''}`} aria-pressed={only === 'all'}
                onClick={() => setOnly('all')}>
          All <span className="fleet-chip-n">{num(sessions.length)}</span>
        </button>
        {ATTENTION_ORDER.filter((k) => counts[k]).map((k) => {
          const m = MARK[k];
          return (
            <button key={k} className={`fleet-chip${only === k ? ' on' : ''}`} aria-pressed={only === k}
                    onClick={() => setOnly(k)}>
              <span aria-hidden="true" style={{ color: m.fg, fontWeight: 700 }}>{m.glyph}</span>
              {m.word} <span className="fleet-chip-n">{num(counts[k])}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div className="card fleet-blank">
          <h2>No session is {MARK[only as AttentionKind]?.word.toLowerCase() ?? 'matching'} right now</h2>
          <p className="dim">
            The filter excluded all {num(sessions.length)} sessions — none of them is in that state
            at the moment. That is usually the good outcome.
          </p>
          <button className="btn fleet-retry" onClick={() => setOnly('all')}>
            Show all {num(sessions.length)} sessions
          </button>
        </div>
      ) : (
        <div className="fleet-grid">
          {shown.map((s) => (
            <Card key={s.id} session={s} att={attention[s.id]} usage={usageOf(s.id)}
                  spark={spark[s.id] ?? []} branch={branchOf.get(s.projectId) ?? null}
                  trust={s.trust ?? defaultTrust} onOpen={() => onOpenSession(s.id)} />
          ))}
        </div>
      )}

      <FleetTable rows={shown} att={attention} usageOf={usageOf} spark={spark}
                  defaultTrust={defaultTrust} onOpen={onOpenSession} />
    </div>
  );
}

/* ── one agent ───────────────────────────────────────────────────────── */

function Card({ session: s, att, usage: u, spark, branch, trust, onOpen }: {
  session: Session; att: Attention | undefined; usage: SessionUsage;
  spark: number[]; branch: string | null; trust: TrustLevel; onOpen: () => void;
}) {
  const kind = att?.kind ?? 'idle';
  const m = MARK[kind] ?? UNKNOWN;
  const word = att?.label || m.word;
  const urgent = kind === 'permission';
  const model = s.model || u.models[0] || null;
  const tokens = u.inTokens + u.outTokens;

  return (
    <button type="button" className={`fleet-card${urgent ? ' urgent' : ''}`} onClick={onOpen}
            aria-label={`${s.projectName}, ${PROVIDER[s.providerId]}, ${word}. Open this session.`}>
      <div className="fleet-row">
        <span className="pill" style={{ background: m.bg, color: m.fg }}>
          <span aria-hidden="true" style={{ fontWeight: 700 }}>{m.glyph}</span>{word}
        </span>
        <span className="faint fleet-since">
          {kind === 'permission' ? 'waiting ' : 'for '}{dur(Date.now() - (att?.since ?? s.createdAt))}
        </span>
        {s.unread > 0 && (
          <span className="pill" style={{ marginLeft: 'auto', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            {s.unread > 99 ? '99+' : s.unread} unread
          </span>
        )}
      </div>

      <div className="fleet-row fleet-title">
        <span className="fleet-name">{s.projectName}</span>
        <span className="pill fleet-prov" style={{ color: TINT[s.providerId] }}>
          {PROVIDER[s.providerId] ?? s.providerId}
        </span>
      </div>

      <div className="fleet-meta mono">
        <span>{model ?? 'CLI default model'}</span>
        <span aria-hidden="true">·</span>
        <span>{s.effort ? `${s.effort} effort` : 'default effort'}</span>
        <span aria-hidden="true">·</span>
        <span title={TRUST_COPY[trust].detail}>
          <span aria-hidden="true">{TRUST_GLYPH[trust]} </span>{TRUST_COPY[trust].label.toLowerCase()}
        </span>
        {branch && <><span aria-hidden="true">·</span><span>{branch}</span></>}
        {s.worktree && <><span aria-hidden="true">·</span><span title={s.worktree}>isolated</span></>}
      </div>

      <span className="fleet-detail">
        {att?.detail ?? (att?.tool ? `Running ${att.tool}.` : 'No hook events for this session yet.')}
      </span>

      <Spark values={spark} live={u.lastAt} />

      <div className="fleet-metrics">
        <Metric label="Cost" value={usd(u.costUsd)} sub={`${num(u.requests)} requests`} />
        <Metric label="Tokens" value={num(tokens)} sub={`${num(u.cacheRead)} cached`} />
        <Metric
          label="Lines"
          value={<><span style={{ color: 'var(--good)' }}>+{num(u.linesAdded)}</span>{' '}
                   <span style={{ color: 'var(--critical)' }}>−{num(u.linesRemoved)}</span></>}
          sub={`${num(u.commits)} commits`} />
      </div>

      <div className="fleet-foot faint">
        <span>
          {s.status === 'exited'
            ? `Exited ${s.exitCode === null ? 'without a code' : `code ${s.exitCode}`} · ${ago(s.endedAt)}`
            : `Running · pid ${s.pid ?? '—'} · started ${ago(s.createdAt)}`}
        </span>
        <span className="fleet-open" aria-hidden="true">open →</span>
      </div>
    </button>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="fleet-metric">
      <span className="label">{label}</span>
      <b>{value}</b>
      <span className="faint">{sub}</span>
    </div>
  );
}

/**
 * Output tokens per second across the session's life, oldest bucket first.
 * Hand-rolled like every chart here: a path, a faint area under it, and an
 * emphasised endpoint. `preserveAspectRatio="none"` lets it stretch to whatever
 * width the grid cell ends up at; `non-scaling-stroke` keeps the line 1px wide
 * when it does, and the endpoint dot is a DOM element so it stays round.
 */
function Spark({ values, live }: { values: number[]; live: number | null }) {
  const peak = values.length ? Math.max(...values) : 0;

  if (!values.length || peak <= 0) {
    return (
      <div className="fleet-spark-wrap">
        <div className="fleet-spark-plot">
          <svg className="fleet-spark" viewBox="0 0 100 28" preserveAspectRatio="none"
               role="img" aria-label="No throughput samples for this session yet">
            <line x1="0" y1="14" x2="100" y2="14" stroke="var(--line)" strokeWidth="1"
                  vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="fleet-nodata">no data{live ? '' : ' yet'}</span>
        </div>
        <span className="fleet-spark-cap">
          <span className="faint">output tok/s</span>
          <span className="mono">{live ? 'waiting on the next turn' : 'telemetry not in yet'}</span>
        </span>
      </div>
    );
  }

  const n = values.length;
  const x = (i: number) => (n === 1 ? 100 : (i / (n - 1)) * 100);
  const y = (v: number) => 26 - (v / peak) * 22;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = values[n - 1];

  return (
    <div className="fleet-spark-wrap">
      <div className="fleet-spark-plot">
        <svg className="fleet-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img"
             aria-label={`Output throughput, ${n} samples oldest to newest. Peak ${rate(peak)} tokens per second, latest ${rate(last)}.`}>
          <path d={`${line} L100,28 L0,28 Z`} fill="var(--series-1)" opacity="0.14" />
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <line x1="100" y1={y(last)} x2="100" y2="28" stroke="var(--series-1)" strokeWidth="1"
                opacity="0.45" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="fleet-spark-dot" style={{ top: `${(y(last) / 28) * 100}%` }} />
      </div>
      <span className="fleet-spark-cap">
        <span className="faint">output tok/s</span>
        <span className="mono">{rate(last)} now · peak {rate(peak)}</span>
      </span>
    </div>
  );
}

/* ── the table under the charts ──────────────────────────────────────── */

function FleetTable({ rows, att, usageOf, spark, defaultTrust, onOpen }: {
  rows: Session[]; att: Record<string, Attention>;
  usageOf: (id: string) => SessionUsage; spark: Record<string, number[]>;
  defaultTrust: TrustLevel; onOpen: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="card" style={{ padding: 15 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600 }}>Every session, in numbers</h3>
      <p className="dim" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>
        The same rows as the cards above, in the same order, including the values each sparkline
        draws — so nothing on this screen is readable only as a shape or a colour.
      </p>
      <div className="fleet-scroll">
        <table className="grid" style={{ marginTop: 10, minWidth: 940 }}>
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>For</th>
              <th>Model</th>
              <th>Effort</th>
              <th>Trust</th>
              <th className="r">Requests</th>
              <th className="r">Cost</th>
              <th className="r">Tokens</th>
              <th className="r">Lines +/−</th>
              <th className="r">tok/s now</th>
              <th className="r">tok/s peak</th>
              <th className="r">Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const a = att[s.id];
              const m = MARK[a?.kind ?? 'idle'] ?? UNKNOWN;
              const u = usageOf(s.id);
              const vals = spark[s.id] ?? [];
              const peak = vals.length ? Math.max(...vals) : 0;
              const last = vals.length ? vals[vals.length - 1] : 0;
              const trust = s.trust ?? defaultTrust;
              return (
                <tr key={s.id} className="clickable" onClick={() => onOpen(s.id)}>
                  <td>
                    <button className="fleet-rowbtn" onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}>
                      {s.projectName}
                    </button>
                    <span className="faint" style={{ marginLeft: 6, color: TINT[s.providerId] }}>
                      {PROVIDER[s.providerId] ?? s.providerId}
                    </span>
                  </td>
                  <td style={{ color: m.fg, whiteSpace: 'nowrap' }}>
                    <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 5 }}>{m.glyph}</span>
                    {a?.label || m.word}
                  </td>
                  <td className="r">{dur(Date.now() - (a?.since ?? s.createdAt))}</td>
                  <td className="mono trunc">{s.model || u.models[0] || 'default'}</td>
                  <td>{s.effort || 'default'}</td>
                  <td title={TRUST_COPY[trust].detail}>
                    <span aria-hidden="true">{TRUST_GLYPH[trust]} </span>{TRUST_COPY[trust].label.toLowerCase()}
                  </td>
                  <td className="r">{num(u.requests)}</td>
                  <td className="r">{usd(u.costUsd)}</td>
                  <td className="r">{num(u.inTokens + u.outTokens)}</td>
                  <td className="r">+{num(u.linesAdded)} / −{num(u.linesRemoved)}</td>
                  <td className="r">{vals.length ? rate(last) : '—'}</td>
                  <td className="r">{peak > 0 ? rate(peak) : '—'}</td>
                  <td className="r">{ago(s.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
        Tokens are input plus output; cached reads are billed at a tenth of the input rate and are
        counted separately on each card. An em dash means the collector has no samples yet, not zero
        throughput.
      </p>
    </div>
  );
}
