import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionEvent } from '@shared/types';
import { Note, Section, Stat, ago, num } from './bits';

/**
 * What the agent DID, beside the terminal that says what it claimed.
 *
 * The terminal is a stream of prose the agent wrote about itself. This rail is
 * the hook bus's own record: every tool call the CLI actually made, how long it
 * took, and whether it came back. When the two disagree, this one is right.
 *
 * Three rules shape the surface:
 *  - Duration is the axis of interest. "What is this session spending its
 *    wall-clock on" is the question a timeline gets asked, so the tool table is
 *    sorted by total time and long rows are physically taller than short ones.
 *    A 90-second test run is findable without reading a word.
 *  - Status never rides on hue. Every mark carries a glyph AND a word; the
 *    colour is the third copy, not the message. A session blocked on a
 *    permission prompt is the one signal that must never be missable.
 *  - Volume is budgeted. A long session emits thousands of events; we render
 *    200 at a time and always say how many we are not showing.
 */

/** The main process clamps its own query here; asking for more is a lie. */
const FETCH = 2000;
/** One screenful of rail, several times over. Paged, never silently truncated. */
const PAGE = 200;

/** Above these, a row is worth noticing from across the panel. */
const TIER_MS = [1_000, 5_000, 30_000];

type ToolStat = { toolName: string; calls: number; totalMs: number; failures: number };
type Live = { tool: string | null; since: number; blocked: boolean; lastAt: number | null };

const KINDS = [
  { id: 'all', label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'files', label: 'Files' },
  { id: 'waits', label: 'Waits' },
  { id: 'problems', label: 'Problems' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

export default function Timeline({ sessionId, onOpenFile }: {
  sessionId: string;
  onOpenFile?: (path: string) => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState<SessionEvent[]>([]);
  const [tools, setTools] = useState<ToolStat[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [hooksOn, setHooksOn] = useState<boolean | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [ev, ts, lv] = await Promise.all([
        window.wanigan.events.session(sessionId, FETCH),
        window.wanigan.events.tools(sessionId),
        window.wanigan.events.live(sessionId),
      ]);
      setAll(ev);
      setTools(ts);
      setLive(lv);
      setErr(null);
      setPhase('ready');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [sessionId]);

  useEffect(() => {
    setAll([]); setTools([]); setLive(null);
    setShown(PAGE); setErr(null); setPhase('loading');
    void load();
  }, [load]);

  // Whether the bus is on at all decides which empty state is honest: "nothing
  // happened yet" and "Wanigan is not listening" look identical on the rail.
  useEffect(() => {
    let alive = true;
    window.wanigan.prefs.all()
      .then((s) => { if (alive) setHooksOn(s.hooks); })
      .catch(() => { if (alive) setHooksOn(null); });
    return () => { alive = false; };
  }, []);

  // Live events arrive for every session in the app; only ours belong here.
  useEffect(() => {
    let timer: number | undefined;
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId !== sessionId) return;
      setNow(Date.now());
      setAll((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, FETCH)));
      // Aggregates live in SQLite. A burst of tool calls should cost one query
      // on its trailing edge, not one query per event.
      if (timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          window.wanigan.events.tools(sessionId).then(setTools).catch(() => {});
          window.wanigan.events.live(sessionId).then(setLive).catch(() => {});
        }, 1200);
      }
    });
    return () => { off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [sessionId]);

  // Only tick while something is actually open. A permission prompt that has
  // been waiting four minutes has to say four minutes, but an idle session must
  // not re-render two hundred rows a second for nothing.
  const busy = !!live && (live.blocked || !!live.tool);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const rows = useMemo(() => build(all), [all]);
  const filtered = useMemo(
    () => rows.filter((r) => matches(r, q.trim().toLowerCase(), kind)),
    [rows, q, kind],
  );
  const visible = filtered.slice(0, shown);
  const maxSpan = useMemo(
    () => filtered.reduce((m, r) => Math.max(m, r.spanMs ?? 0), 0),
    [filtered],
  );

  const folded = all.length - rows.length;
  const filtering = kind !== 'all' || q.trim() !== '';
  const clear = () => { setQ(''); setKind('all'); setShown(PAGE); };

  if (phase === 'loading') {
    return (
      <div className="tl tl-pad">
        <p className="dim">Reading this session's event log…</p>
        <p className="faint tl-p">Every tool call the agent has made is on disk; this is a local
          database read, not a network one.</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="tl tl-pad">
        <Note tone="error">
          <strong>Could not read this session's events.</strong> {err}
        </Note>
        <p className="tl-p dim">The event log is a table in Wanigan's own database. Retry below; if it
          keeps failing, another Wanigan window may hold the database open — quit that one first.</p>
        <button className="btn tl-btn" onClick={() => { setPhase('loading'); void load(); }}>Retry</button>
      </div>
    );
  }

  // Empty is not zero-results, and neither is "the feature is switched off".
  if (!all.length && !live?.lastAt) {
    return (
      <div className="tl tl-pad">
        <h2 className="tl-h">Nothing recorded for this session</h2>
        {hooksOn === false ? (
          <>
            <Note tone="warn">
              <span className="tl-glyph-inline" aria-hidden="true">⏸</span>
              <strong>The hook bus is off.</strong> Wanigan only knows what an agent did because the
              CLI posts each tool call to a loopback listener. With hooks off nothing is recorded, so
              this rail stays empty whether the agent is flat out or asleep.
            </Note>
            <p className="tl-p dim">
              Turn on <strong>Settings → Hooks</strong>, then start a <strong>new</strong> session. A
              session already running was launched without the hook config and cannot be instrumented
              in place.
            </p>
          </>
        ) : (
          <>
            <Note tone="info">
              <strong>No events yet.</strong> The first tool call lands here within a second of the
              agent making it.
            </Note>
            <p className="tl-p dim">
              If this session has been working for a while and the rail is still blank, it started
              before the hook bus did. Check <strong>Settings → Hooks</strong> is on and start a new
              session to instrument it.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="tl">
      <div className="tl-scroll">
        <ToolSummary tools={tools} events={all.length} capped={all.length >= FETCH} />

        <div className="tl-sticky">
          <LiveStrip live={live} now={now} />
          <div className="tl-filters">
            <input
              className="field tl-search"
              type="search"
              value={q}
              placeholder="Filter by tool, file or command"
              aria-label="Filter timeline events"
              onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
            />
            <div className="tl-chips" role="group" aria-label="Event kind">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className={`tl-chip${kind === k.id ? ' on' : ''}`}
                  aria-pressed={kind === k.id}
                  onClick={() => { setKind(k.id); setShown(PAGE); }}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="tl-pad">
            <p><strong>No events match this filter.</strong></p>
            <p className="tl-p dim">
              {num(rows.length)} {rows.length === 1 ? 'event is' : 'events are'} recorded for this
              session. {kind === 'all' ? '' : `The ${labelOf(kind)} filter `}
              {kind !== 'all' && q.trim() ? 'and ' : ''}
              {q.trim() ? `“${q.trim()}” ` : ''}
              excluded every one of them.
            </p>
            <button className="btn tl-btn" onClick={clear}>Clear filter</button>
          </div>
        ) : (
          <>
            <div className="tl-count">
              <span>
                Showing <strong>{num(visible.length)}</strong> of {num(filtered.length)}
                {filtering && rows.length !== filtered.length
                  ? <> · {num(rows.length - filtered.length)} filtered out</>
                  : null}
              </span>
              <span className="faint">newest first</span>
            </div>
            {folded > 0 && (
              <p className="tl-note faint">
                {num(folded)} tool {folded === 1 ? 'start is' : 'starts are'} folded into their
                results — one row per call, timed end to end.
              </p>
            )}

            <ol className="tl-rail">
              {visible.map((r, i) => {
                const prev = i > 0 ? visible[i - 1] : null;
                const newDay = !prev || !sameDay(prev.e.at, r.e.at);
                return (
                  <li key={r.e.id} className="tl-li">
                    {newDay && <p className="tl-day"><span>{dayLabel(r.e.at)}</span></p>}
                    <Row r={r} max={maxSpan} now={now} onOpenFile={onOpenFile} />
                  </li>
                );
              })}
            </ol>

            {filtered.length > shown ? (
              <div className="tl-foot">
                <button className="btn tl-btn" onClick={() => setShown((s) => s + PAGE)}>
                  Show {num(Math.min(PAGE, filtered.length - shown))} older
                </button>
                <span className="faint">{num(filtered.length - shown)} older not shown</span>
              </div>
            ) : (
              <div className="tl-foot">
                <span className="faint">
                  {all.length >= FETCH
                    ? `End of the ${num(FETCH)} most recent events. Anything older is still on disk, but not loaded here.`
                    : 'Start of the session.'}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── the rail ────────────────────────────────────────────────────────── */

type Row = {
  e: SessionEvent;
  /** ms, once we know it: a finished tool call, or a resolved wait. */
  spanMs: number | null;
  /** What the span measures — the word next to it has to be true. */
  spanKind: 'ran' | 'waited' | null;
  /** Still open: the span ticks from e.at until something resolves it. */
  open: boolean;
  /** A tool call whose result never arrived — the agent died mid-flight. */
  orphan: boolean;
};

/**
 * Folds each PreToolUse into the PostToolUse that answered it, so a call is one
 * row timed end to end rather than two rows saying the same thing. Pairing is by
 * tool name and summary because tool_use_id is not stored.
 *
 * A Pre with no Post is either in flight (nothing has closed the turn since) or
 * abandoned (a Stop or SessionEnd came after it and the result never landed).
 * Those are different facts and the rail says which.
 */
function build(all: SessionEvent[]): Row[] {
  const out: Row[] = [];
  const closed = new Map<string, number>();
  let turnClosed = false;

  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const key = `${e.toolName ?? ''}|${e.summary ?? ''}`;

    if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') {
      closed.set(key, (closed.get(key) ?? 0) + 1);
      out.push({ e, spanMs: e.durationMs, spanKind: e.durationMs === null ? null : 'ran', open: false, orphan: false });
      continue;
    }

    if (e.event === 'PreToolUse') {
      const n = closed.get(key) ?? 0;
      if (n > 0) { closed.set(key, n - 1); continue; }
      out.push({ e, spanMs: null, spanKind: 'ran', open: !turnClosed, orphan: turnClosed });
      continue;
    }

    if (isWait(e)) {
      // A hook payload has no duration for a question, only for an answer. The
      // wait is the gap to whatever came next — newer events sit at lower indices.
      const next = i > 0 ? all[i - 1] : null;
      out.push({
        e,
        spanMs: next ? Math.max(0, next.at - e.at) : null,
        spanKind: 'waited',
        open: !next,
        orphan: false,
      });
      continue;
    }

    if (e.event === 'Stop' || e.event === 'StopFailure' || e.event === 'SessionEnd') turnClosed = true;
    out.push({ e, spanMs: e.durationMs, spanKind: e.durationMs === null ? null : 'ran', open: false, orphan: false });
  }
  return out;
}

const WAITING = /permission|waiting for your input|needs your|approve|confirm/i;
const REFUSED = /refus|declin/i;

function isWait(e: SessionEvent): boolean {
  return e.event === 'PermissionRequest'
    || (e.event === 'Notification' && WAITING.test(e.summary ?? ''));
}

function isProblem(e: SessionEvent): boolean {
  return e.ok === false
    || e.event === 'PostToolUseFailure'
    || e.event === 'StopFailure'
    || e.event === 'PermissionDenied';
}

function matches(r: Row, q: string, kind: Kind): boolean {
  const e = r.e;
  if (kind === 'tools' && !e.toolName) return false;
  if (kind === 'files' && e.paths.length === 0) return false;
  if (kind === 'waits' && !isWait(e) && e.event !== 'PermissionDenied') return false;
  if (kind === 'problems' && !isProblem(e)) return false;
  if (!q) return true;
  return `${e.toolName ?? ''} ${e.summary ?? ''} ${e.event} ${e.paths.join(' ')}`
    .toLowerCase().includes(q);
}

/**
 * The mark for one event. Glyph and word first, colour third — green against
 * red measures ΔE 4.1 under deuteranopia, so hue can only ever agree with a
 * label that already said it.
 */
type Mark = { glyph: string; word: string; tone: string; soft?: string; loud?: boolean };

function markFor(r: Row): Mark {
  const e = r.e;
  switch (e.event) {
    case 'PostToolUse':
      return e.ok === false
        ? { glyph: '✕', word: 'failed', tone: 'var(--critical)', soft: 'var(--critical-soft)', loud: true }
        : { glyph: '✓', word: 'done', tone: 'var(--good)' };
    case 'PostToolUseFailure':
      return { glyph: '✕', word: 'failed', tone: 'var(--critical)', soft: 'var(--critical-soft)', loud: true };
    case 'PreToolUse':
      return r.orphan
        ? { glyph: '▹', word: 'no result', tone: 'var(--serious)', soft: 'var(--serious-soft)', loud: true }
        : { glyph: '▶', word: 'running', tone: 'var(--accent)', soft: 'var(--accent-soft)', loud: true };
    case 'PermissionRequest':
      return { glyph: '⏸', word: 'asked you', tone: 'var(--warning)', soft: 'var(--warning-soft)', loud: true };
    case 'PermissionResponse':
      return { glyph: '↩', word: 'you responded', tone: 'var(--text-dim)' };
    case 'PermissionDenied':
      return { glyph: '⊘', word: 'denied', tone: 'var(--serious)', soft: 'var(--serious-soft)', loud: true };
    case 'UserPromptSubmit':
      return { glyph: '❯', word: 'you asked', tone: 'var(--accent)' };
    case 'SessionStart':
      return { glyph: '▸', word: 'session started', tone: 'var(--text-faint)' };
    case 'SessionEnd':
      return { glyph: '■', word: 'session ended', tone: 'var(--text-faint)' };
    case 'Stop':
      return { glyph: '◼', word: 'turn ended', tone: 'var(--text-faint)' };
    case 'StopFailure':
      return { glyph: '✕', word: 'turn failed', tone: 'var(--critical)', soft: 'var(--critical-soft)', loud: true };
    case 'PreCompact':
      return { glyph: '⧉', word: 'compacting', tone: 'var(--accent)', soft: 'var(--accent-soft)', loud: true };
    case 'PostCompact':
      return { glyph: '⧉', word: 'compacted', tone: 'var(--accent)' };
    case 'SubagentStart':
      return { glyph: '⌥', word: 'subagent started', tone: 'var(--accent)' };
    case 'SubagentStop':
      return { glyph: '⌥', word: 'subagent ended', tone: 'var(--text-faint)' };
    case 'Notification':
      if (REFUSED.test(e.summary ?? ''))
        return { glyph: '⊘', word: 'refused', tone: 'var(--serious)', soft: 'var(--serious-soft)', loud: true };
      if (WAITING.test(e.summary ?? ''))
        return { glyph: '⏸', word: 'needs you', tone: 'var(--warning)', soft: 'var(--warning-soft)', loud: true };
      return { glyph: '◆', word: 'notice', tone: 'var(--text-dim)' };
    default:
      return { glyph: '·', word: e.event.toLowerCase(), tone: 'var(--text-faint)' };
  }
}

function Row({ r, max, now, onOpenFile }: {
  r: Row; max: number; now: number; onOpenFile?: (path: string) => void;
}) {
  const e = r.e;
  const m = markFor(r);
  const span = r.open ? Math.max(0, now - e.at) : r.spanMs;
  // Absolute tiers, not relative: a 90-second run is slow whether or not
  // something slower happens to be on screen beside it.
  const tier = span === null ? 0 : span >= TIER_MS[2] ? 3 : span >= TIER_MS[1] ? 2 : span >= TIER_MS[0] ? 1 : 0;
  const width = span !== null && max > 0 ? Math.max(3, Math.min(100, (span / max) * 100)) : 0;

  const file = e.paths[0] ?? null;
  const open = file && onOpenFile ? () => onOpenFile(file) : null;

  const hint = r.open && r.spanKind === 'waited' ? 'still waiting'
    : r.orphan ? 'started, no result recorded'
    : e.paths.length > 1 ? `+${e.paths.length - 1} more ${e.paths.length === 2 ? 'file' : 'files'}`
    : null;

  const body = (
    <>
      <span className="tl-glyph" style={{ color: m.tone, borderColor: m.loud ? m.tone : 'var(--line)' }}
            aria-hidden="true">{m.glyph}</span>
      <span className="tl-body" style={{ borderLeftColor: m.loud ? m.tone : 'transparent' }}>
        <span className="tl-line">
          {e.toolName && <span className="tl-name mono">{e.toolName}</span>}
          <span className="tl-word" style={{ color: m.tone, background: m.soft ?? 'transparent' }}>
            {m.word}
          </span>
          {open && <span className="tl-open faint" aria-hidden="true">↗</span>}
        </span>
        {e.summary && <span className="tl-sum mono" title={e.summary}>{e.summary}</span>}
        {hint && <span className="tl-hint faint">{hint}</span>}
      </span>
      <span className="tl-right">
        <span className="tl-clock mono">{clock(e.at)}</span>
        {span !== null && (
          <>
            <span className="tl-dur mono">{dur(span)}</span>
            <span className="tl-track" aria-hidden="true">
              <span className="tl-fill" style={{ width: `${width}%` }} />
            </span>
          </>
        )}
      </span>
    </>
  );

  // Only the clickable row needs a label: a button's accessible name would
  // otherwise be a glyph. The static row is plain readable text already, and an
  // aria-label on a bare div is ignored as often as it is honoured.
  const label = [
    m.word, e.toolName, e.summary,
    span !== null ? `${r.spanKind === 'waited' ? 'waited' : 'took'} ${dur(span)}` : null,
  ].filter(Boolean).join(' · ');

  return open ? (
    <button type="button" className="tl-row tl-row-open" data-tier={tier}
            title={`Open ${e.paths.join('\n')}`} aria-label={`${label} — open ${file}`}
            onClick={open}>
      {body}
    </button>
  ) : (
    <div className="tl-row" data-tier={tier}>{body}</div>
  );
}

/* ── header ──────────────────────────────────────────────────────────── */

/**
 * Where the wall-clock went. The bar IS the chart and the row IS the table —
 * every bar sits beside its own number, so nothing here depends on reading a
 * length, and nothing depends on reading a colour.
 */
function ToolSummary({ tools, events, capped }: { tools: ToolStat[]; events: number; capped: boolean }) {
  const totalMs = tools.reduce((a, t) => a + t.totalMs, 0);
  const calls = tools.reduce((a, t) => a + t.calls, 0);
  const fails = tools.reduce((a, t) => a + t.failures, 0);
  const max = tools.reduce((a, t) => Math.max(a, t.totalMs), 0);
  const top = tools.slice(0, 6);
  const rest = tools.slice(6);
  const restMs = rest.reduce((a, t) => a + t.totalMs, 0);
  const restCalls = rest.reduce((a, t) => a + t.calls, 0);

  return (
    <Section
      title="Where the wall-clock went"
      hint="Finished tool calls only, longest first. Time the model spent thinking is not in here — hooks see tools, not tokens."
    >
      <div className="row3 tl-stats">
        <Stat label="Tool time" value={totalMs ? dur(totalMs) : '—'}
              sub={calls ? `${num(calls)} calls` : 'no calls yet'} />
        <Stat label="Events" value={num(events)}
              sub={capped ? `${num(FETCH)} loaded, the cap` : 'recorded'} />
        <Stat label="Failures" value={num(fails)}
              tone={fails ? 'var(--critical)' : undefined}
              sub={calls ? `${((fails / calls) * 100).toFixed(fails ? 1 : 0)}% of calls` : '—'} />
      </div>

      {tools.length === 0 ? (
        <p className="faint tl-p">No tool call has finished yet. A call in flight has no duration to
          report, so it shows on the rail below and lands here when it returns.</p>
      ) : (
        <div className="tl-x">
          <table className="tl-tools">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="r">Calls</th>
                <th className="r">Total</th>
                <th className="tl-barhead">Share of time</th>
                <th className="r">Fails</th>
              </tr>
            </thead>
            <tbody>
              {top.map((t) => {
                const share = totalMs > 0 ? (t.totalMs / totalMs) * 100 : 0;
                return (
                  <tr key={t.toolName}>
                    <td className="mono tl-tname">{t.toolName}</td>
                    <td className="r">{num(t.calls)}</td>
                    <td className="r">{dur(t.totalMs)}</td>
                    <td className="tl-barcell">
                      <span className="tl-track" title={`${share.toFixed(1)}% of tool time`}>
                        <span className="tl-fill"
                              style={{ width: `${max > 0 ? Math.max(3, (t.totalMs / max) * 100) : 0}%` }} />
                      </span>
                    </td>
                    <td className="r">
                      {t.failures
                        ? <span className="tl-fail">✕ {num(t.failures)}</span>
                        : <span className="faint">0</span>}
                    </td>
                  </tr>
                );
              })}
              {rest.length > 0 && (
                <tr className="tl-rest">
                  <td className="mono">+{num(rest.length)} more tools</td>
                  <td className="r">{num(restCalls)}</td>
                  <td className="r">{dur(restMs)}</td>
                  <td />
                  <td className="r faint">{num(rest.reduce((a, t) => a + t.failures, 0))}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * What is happening right now. A blocked agent is the one state that must never
 * be quiet — it carries a glyph, the word "Waiting on you", the tool it is
 * waiting on, and a clock that keeps counting.
 */
function LiveStrip({ live, now }: { live: Live | null; now: number }) {
  if (!live) return null;

  if (live.blocked) {
    const waited = live.since ? Math.max(0, now - live.since) : 0;
    return (
      <div className="tl-live tl-live-blocked" role="status">
        <span className="tl-live-glyph" aria-hidden="true">⏸</span>
        <span className="tl-live-text">
          <strong>Waiting on you</strong>
          {live.tool && <span className="mono"> · {live.tool}</span>}
        </span>
        <span className="tl-live-time mono" aria-hidden="true">{dur(waited)}</span>
      </div>
    );
  }

  if (live.tool) {
    const running = live.since ? Math.max(0, now - live.since) : 0;
    return (
      <div className="tl-live tl-live-running" role="status">
        <span className="tl-live-glyph" aria-hidden="true">▶</span>
        <span className="tl-live-text">
          Running <span className="mono">{live.tool}</span>
        </span>
        <span className="tl-live-time mono" aria-hidden="true">{dur(running)}</span>
      </div>
    );
  }

  return (
    <div className="tl-live tl-live-idle">
      <span className="tl-live-glyph" aria-hidden="true">·</span>
      <span className="tl-live-text faint">No tool in flight</span>
      <span className="tl-live-time faint">{ago(live.lastAt)}</span>
    </div>
  );
}

/* ── formatting ──────────────────────────────────────────────────────── */

/** A bare integer is a puzzle; every duration here carries its unit. */
function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function labelOf(kind: Kind): string {
  return KINDS.find((k) => k.id === kind)?.label ?? kind;
}
