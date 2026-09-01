import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attention, AttentionKind, Session } from '@shared/types';
import { ago } from './bits';

/**
 * Which of nine agents needs a human, and which has needed one longest.
 *
 * This replaces judging by unread byte count, which ranks an agent that is
 * talking a lot above one that has sat on a permission prompt for four minutes.
 * The main process classifies and ranks — worst kind first, then longest wait —
 * and this strip renders that order untouched. Re-sorting here would let the two
 * sides disagree about the same fleet.
 *
 * Colour never carries the state. Every chip is a glyph plus a word plus a
 * project, because green against red measures ΔE 4.1 under deuteranopia, and the
 * "blocked, waiting for you" mark is the one signal in the app that must never
 * be invisible. Hue is laid over a chip that already reads without it.
 */

const SPEC: Record<AttentionKind, { glyph: string; color: string; soft: string; waits: boolean }> = {
  // Distinct shapes, not just distinct hues — the glyph survives greyscale.
  permission: { glyph: '?', color: 'var(--critical)',   soft: 'var(--critical-soft)', waits: true },
  error:      { glyph: '✕', color: 'var(--serious)',    soft: 'var(--serious-soft)',  waits: true },
  finished:   { glyph: '✓', color: 'var(--good)',       soft: 'var(--good-soft)',     waits: true },
  idle:       { glyph: '◦', color: 'var(--warning)',    soft: 'var(--warning-soft)',  waits: true },
  // Working is the only kind whose clock is runtime rather than a wait, so it
  // never escalates: an agent forty tools into your prompt is not stuck.
  working:    { glyph: '▸', color: 'var(--text-dim)',   soft: 'var(--bg-sunk)',       waits: false },
};

/**
 * The default queue. Idle and working are states, not requests — a queue that
 * lists every session is a session list with extra steps, and the two chips that
 * matter stop being findable at a glance.
 */
const NEEDS_YOU: AttentionKind[] = ['permission', 'error', 'finished'];

/** A minute is where a wait stops being a blink and starts being a queue. */
const WARM_MS = 60_000;
/** Five minutes: somebody has walked away from a blocked agent. */
const HOT_MS = 5 * 60_000;

const POLL_MS = 2_000;
/** Hook events arrive in bursts of a dozen; one refresh covers all of them. */
const BURST_MS = 250;
const PREF = 'wanigan.attention.all';

export default function AttentionQueue({ onJump }: { onJump: (sessionId: string) => void }) {
  const [items, setItems] = useState<Attention[] | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(() => {
    try { return localStorage.getItem(PREF) === '1'; } catch { return false; }
  });

  const alive = useRef(true);
  const burst = useRef<number | null>(null);

  // Attention carries a session id, not a project name — the name lives on the
  // session. Both reads are cheap and must describe the same instant, so they go
  // together rather than as two independently-timed polls.
  const load = useCallback(async () => {
    try {
      const [list, live] = await Promise.all([
        window.wanigan.attention.list(),
        window.wanigan.sessions.list(),
      ]);
      if (!alive.current) return;
      setItems(list);
      setSessions(Object.fromEntries(live.map((s) => [s.id, s] as const)));
      setErr(null);
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // A hidden window is a window nobody is reading, and this is the fastest
    // poll in the app — two IPC round trips every two seconds, forever, to rank
    // a strip that is not on screen. Fleet and Pet already stop; so does this.
    // Coming back is not left to the next beat: `onVisible` below re-reads at
    // once, because a stale ranking is exactly what this strip must never show.
    const t = setInterval(() => { if (document.hidden) return; void load(); }, POLL_MS);
    const off = window.wanigan.on.sessionEvent(() => {
      if (burst.current !== null) return;
      burst.current = window.setTimeout(() => { burst.current = null; void load(); }, BURST_MS);
    });
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(t);
      off();
      document.removeEventListener('visibilitychange', onVisible);
      if (burst.current !== null) { window.clearTimeout(burst.current); burst.current = null; }
    };
  }, [load]);

  const setFilter = useCallback((next: boolean) => {
    setShowAll(next);
    try { localStorage.setItem(PREF, next ? '1' : '0'); } catch { /* storage can be blocked */ }
  }, []);

  // Loading is not empty: the queue has not answered yet, and saying "nothing
  // waiting" before it does is a lie that lasts exactly as long as the first read.
  if (items === null) {
    return (
      <div className="atq atq-quiet" role="region" aria-label="Attention queue">
        <span className="label">Attention</span>
        {err
          ? <Failure msg={err} onRetry={() => void load()} />
          : <span className="atq-none">Reading the queue…</span>}
      </div>
    );
  }

  const shown = showAll ? items : items.filter((a) => NEEDS_YOU.includes(a.kind));
  const hidden = items.length - shown.length;

  if (shown.length === 0) {
    return (
      <div className="atq atq-quiet" role="region" aria-label="Attention queue">
        <span className="label">Attention</span>
        <span className="atq-none">Nothing waiting.</span>
        {items.length === 0 ? (
          // Empty: no agents exist yet, so say how one gets here.
          <span className="atq-hint">
            No sessions running. Start one with ⌘T and it appears here the moment it blocks.
          </span>
        ) : (
          // Zero results: the filter excluded everything, so hand back the way in.
          <>
            <span className="atq-hint">
              {hidden} {hidden === 1 ? 'session is' : 'sessions are'} working or idle, none blocked.
            </span>
            <button className="atq-toggle" onClick={() => setFilter(true)}>
              Show all <span className="atq-n">{items.length}</span>
            </button>
          </>
        )}
        {err && <Failure msg={err} onRetry={() => void load()} />}
      </div>
    );
  }

  // Counts read off the rendered list, worded by the label the main process
  // gave each kind, so the summary can never drift from the chips.
  const counts: { kind: AttentionKind; n: number; word: string }[] = [];
  for (const a of shown) {
    const seen = counts.find((c) => c.kind === a.kind);
    if (seen) seen.n += 1;
    else counts.push({ kind: a.kind, n: 1, word: a.label.toLowerCase() });
  }

  return (
    <div className="atq" role="region" aria-label="Attention queue">
      <div className="atq-lead">
        <span className="label">Attention</span>
        <span className="atq-count" aria-live="polite">
          {counts.map((c) => `${c.n} ${c.word}`).join(' · ')}
          {hidden > 0 && <span className="atq-quiet-n"> · {hidden} hidden</span>}
        </span>
      </div>

      {/* Its own scroller: nine chips are wider than the window, and the page
          body never scrolls sideways to accommodate them. */}
      <div className="atq-scroll">
        {shown.map((a) => (
          <Chip key={a.sessionId} a={a} session={sessions[a.sessionId]} onJump={onJump} />
        ))}
        {err && <Failure msg={err} onRetry={() => void load()} />}
      </div>

      <button
        className="atq-toggle"
        aria-pressed={showAll}
        title={showAll
          ? 'Show only sessions that want something from you'
          : 'Also show sessions that are working or have gone quiet'}
        onClick={() => setFilter(!showAll)}
      >
        {showAll ? '− idle & working' : '+ idle & working'}
        {!showAll && hidden > 0 && <span className="atq-n">{hidden}</span>}
      </button>
    </div>
  );
}

function Chip({ a, session, onJump }: {
  a: Attention; session: Session | undefined; onJump: (sessionId: string) => void;
}) {
  const s = SPEC[a.kind] ?? SPEC.working;
  const waited = Math.max(0, Date.now() - a.since);
  // Weight escalates with the wait, so the strip is legible as a ranking even
  // before you read a single word of it.
  const tier = !s.waits ? '' : waited >= HOT_MS ? ' hot' : waited >= WARM_MS ? ' warm' : '';
  const project = session?.projectName ?? `session ${a.sessionId.slice(0, 6)}`;
  const verb = s.waits ? 'waiting' : 'running';
  const detail = a.detail ?? '';

  return (
    <button
      className={`atq-chip${tier}`}
      style={{ '--k': s.color, '--k-soft': s.soft } as React.CSSProperties}
      onClick={() => onJump(a.sessionId)}
      title={`${a.label} · ${project}\n${verb} ${dur(waited)}${detail ? `\n${detail}` : ''}\nClick to open this session.`}
      aria-label={`${a.label}: ${project}, ${verb} ${dur(waited)}.${detail ? ` ${detail}.` : ''} Open this session.`}
    >
      <span className="atq-glyph" aria-hidden="true">{s.glyph}</span>
      <span className="atq-body">
        <span className="atq-top">
          <span className="atq-word">{a.label}</span>
          <span className="atq-wait">{ago(a.since)}</span>
        </span>
        <span className="atq-sub">
          {project}
          {a.tool && <span className="mono"> · {a.tool}</span>}
        </span>
      </span>
    </button>
  );
}

/**
 * A failed read is not an empty queue. The sessions are untouched — only this
 * ranking is stale — so the message says that and offers the one useful action.
 */
function Failure({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <span className="atq-fail" role="status">
      <span className="atq-glyph" aria-hidden="true">✕</span>
      <span className="atq-fail-text">
        Ranking is stale — {msg}. Your sessions keep running; only this strip stopped updating.
      </span>
      <button className="atq-retry" onClick={onRetry}>Retry</button>
    </span>
  );
}

/** "3m 12s", never a bare 192. Used where the exact wait matters more than the glance. */
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
