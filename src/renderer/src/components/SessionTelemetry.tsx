import { MISS_CAUSE_LABELS, type SessionStatusLine } from '@shared/status-line';
import type { SessionTraces, TraceInteraction, WaterfallKind, WaterfallRow } from '@shared/trace-spans';
import { Mark, Section, Stat, ago, dur, num } from './bits';

/**
 * Two things a session reports about itself that the hook rail cannot see: its
 * prompt cache, as its status line states it, and — behind the beta switch —
 * a per-prompt trace that separates the model's time from the tools' from the
 * operator's. Both are the CLI's own measurements, and both say so.
 */

/* ── prompt cache ────────────────────────────────────────────────────── */

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The folded summary's right-hand words: the hit ratio and misses, or the absence as itself. */
export function cacheSummary(reading: SessionStatusLine | null | undefined, error: string | null): string {
  if (error) return 'could not read';
  if (reading === undefined) return 'reading…';
  if (!reading) return 'no status line reading';
  const c = reading.cache;
  if (!c) return 'no cache figures reported';
  const ratio = c.hitRatio === null ? 'hit ratio not reported' : `${Math.round(c.hitRatio * 100)}% hit`;
  return c.misses === null ? ratio : `${ratio} · ${num(c.misses)} miss${c.misses === 1 ? '' : 'es'}`;
}

function cause(name: string): string {
  const words = MISS_CAUSE_LABELS[name];
  return words && words !== name ? `${name} (${words})` : name;
}

export function PromptCacheReadout({ reading, error }: {
  /** Undefined while the first read is out; null when the session sent no reading. */
  reading: SessionStatusLine | null | undefined;
  error: string | null;
}) {
  if (error) {
    return <p className="tl-p pc-line"><Mark glyph="✕" word="could not read" tone="serious" /> {error}</p>;
  }
  if (reading === undefined) return <p className="tl-p faint pc-line">Reading this session’s status line…</p>;
  if (!reading) {
    return (
      <p className="tl-p pc-line">
        No status line reading from this session. Wanigan’s relay records one each time the CLI draws its status
        line, for sessions launched with Status line readings and the hook bus on.
      </p>
    );
  }
  const c = reading.cache;
  const provenance = `From this session’s status line · reported ${ago(reading.observedAt)}${reading.cliVersion ? ` · CLI ${reading.cliVersion}` : ''}`;
  if (!c) {
    return (
      <p className="tl-p pc-line">
        This session’s status line carried no prompt cache figures; the CLI reports them for the main conversation
        only. <span className="faint">{provenance}</span>
      </p>
    );
  }
  const expired = c.expiresAt !== null && c.expiresAt <= Date.now();
  return (
    <Section title="What the prompt cache did" hint="The CLI’s own figures for the main conversation; subagents are not in them.">
      <div className="row3 tl-stats">
        <Stat label="Hit ratio" value={c.hitRatio === null ? '—' : `${Math.round(c.hitRatio * 100)}%`}
              sub={c.hitRatio === null ? 'not reported' : 'cache reads ÷ all input'} />
        <Stat label="Misses" value={c.misses === null ? '—' : num(c.misses)}
              sub={c.requests === null ? 'requests not reported' : `of ${num(c.requests)} requests`} />
        <Stat label="TTL" value={c.ttl ?? '—'}
              sub={c.expiresAt === null ? 'expiry not reported' : `${expired ? 'expired' : 'expires'} ${clock(c.expiresAt)}`} />
      </div>
      <p className="tl-p pc-line">
        {c.warm === null ? null : c.warm
          ? <Mark glyph="●" word="warm" tone="ok" />
          : <Mark glyph="○" word="cold" tone="quiet" />}
        {c.cachingObserved === false && ' The provider reported no cache tokens at all, which is not the same as a cold cache.'}
        {c.recacheTokensIfCold !== null && ` If it goes cold, the CLI expects to re-cache ${num(c.recacheTokensIfCold)} tokens.`}
      </p>
      {c.missCauses.length > 0 ? (
        <ul className="pc-causes">
          {c.missCauses.map((m) => (
            <li key={m.cause}><span className="mono">{cause(m.cause)}</span> <span className="faint">×{num(m.count)}</span></li>
          ))}
        </ul>
      ) : c.misses ? (
        <p className="tl-p pc-line faint">The CLI counted misses but diagnosed no cause for them.</p>
      ) : null}
      {c.lastMissAt !== null && (
        <p className="tl-p pc-line">
          Last miss {clock(c.lastMissAt)}{c.lastMissCauses.length ? `: ${c.lastMissCauses.map(cause).join(', ')}` : ', cause not diagnosed'}.
        </p>
      )}
      <p className="tl-p pc-line faint">{provenance}</p>
    </Section>
  );
}

/* ── per-prompt traces ───────────────────────────────────────────────── */

const KIND: Record<WaterfallKind, { glyph: string; word: string; bar: string }> = {
  llm_request: { glyph: '◆', word: 'model', bar: 'tt-bar tt-llm' },
  tool: { glyph: '▸', word: 'tool', bar: 'tt-bar tt-tool' },
  blocked: { glyph: '⏸', word: 'waiting on you', bar: 'tt-bar tt-blocked' },
  execution: { glyph: '▹', word: 'running', bar: 'tt-bar tt-exec' },
  hook: { glyph: '↪', word: 'hook', bar: 'tt-bar tt-hook' },
  other: { glyph: '·', word: 'span', bar: 'tt-bar tt-other' },
};

/** The SVG track is 1000 units wide whatever its pixels; a span too short to see still gets a sliver. */
const TRACK = 1000;

function Row({ row, total }: { row: WaterfallRow; total: number }) {
  const kind = KIND[row.kind];
  const x = Math.min(TRACK - 2, Math.max(0, (row.offsetMs / total) * TRACK));
  const w = row.durationMs === null ? 2 : Math.min(TRACK - x, Math.max(2, (row.durationMs / total) * TRACK));
  return (
    <li className={`tt-row tt-d${Math.min(row.depth, 3)}`}>
      <div className="tt-line">
        <span className="tt-label">
          <span aria-hidden="true">{kind.glyph}</span> {kind.word}
          {/* A wait and an execution are named by their kind alone; saying it twice is not a label. */}
          {row.label !== kind.word && <> <span className="mono">{row.label}</span></>}
        </span>
        <span className="tt-time mono">+{dur(row.offsetMs)} · {row.durationMs === null ? 'no end' : dur(row.durationMs)}</span>
      </div>
      <svg className="tt-track" viewBox={`0 0 ${TRACK} 10`} preserveAspectRatio="none" aria-hidden="true">
        {/* The whole turn as a faint rail, so a bar's place in it can be read. */}
        <rect className="tt-rail" x="0" y="4" width={TRACK} height="2" />
        <rect className={row.durationMs === null ? `${kind.bar} is-open` : kind.bar} x={x} y="1" width={w} height="8" />
      </svg>
      {(row.incomplete || row.error || row.facts.length > 0 || row.agentId) && (
        <p className="tt-facts">
          {row.incomplete && <><Mark glyph="◌" word="incomplete" tone="warn" /> {row.incomplete}. </>}
          {row.error && <><Mark glyph="✕" word="error" tone="serious" />{' '}</>}
          {row.agentId && <span>subagent · </span>}
          {row.facts.join(' · ')}
        </p>
      )}
    </li>
  );
}

/**
 * One kind's share of the turn, or null when the turn has no span of that kind.
 * A span that never ended is time nobody measured, so it is said as unfinished
 * rather than added in as nothing: "tools 0ms" over a tool call killed
 * mid-flight would be a false zero.
 */
function share(trace: TraceInteraction, kind: WaterfallKind, word: string, ms: number): string | null {
  const rows = trace.rows.filter((r) => r.kind === kind);
  if (!rows.length) return null;
  if (rows.every((r) => r.durationMs === null)) return `${word} unfinished`;
  return `${word} ${dur(ms)}${rows.some((r) => r.durationMs === null) ? ' + unfinished' : ''}`;
}

function Waterfall({ trace }: { trace: TraceInteraction }) {
  const reach = trace.rows.reduce((m, r) => Math.max(m, r.offsetMs + (r.durationMs ?? 0)), 0);
  const total = Math.max(1, trace.durationMs ?? reach);
  const totals = [
    share(trace, 'llm_request', 'model', trace.totals.llmMs),
    share(trace, 'tool', 'tools', trace.totals.toolMs),
    share(trace, 'blocked', 'waiting on you', trace.totals.blockedMs),
    trace.durationMs === null ? null : `turn ${dur(trace.durationMs)}`,
  ].filter((part): part is string => part !== null);
  return (
    <section className="tt" aria-label={`Per-prompt trace, ${trace.durationMs === null ? 'incomplete' : dur(trace.durationMs)}`}>
      <div className="tt-head">
        <span className="label">Trace</span>
        <span className="tt-totals mono">{totals.join(' · ')}</span>
        {trace.incomplete && <Mark glyph="◌" word="incomplete" tone="warn" />}
      </div>
      {trace.rootMissing && (
        <p className="tt-facts">The prompt’s interaction span was not recorded, so offsets are from the earliest span that was.</p>
      )}
      {trace.rows.length === 0 ? (
        <p className="tt-facts">The interaction was recorded with no model, tool or wait inside it.</p>
      ) : (
        <ol className="tt-rows">
          {trace.rows.map((row) => <Row key={row.spanId} row={row} total={total} />)}
        </ol>
      )}
    </section>
  );
}

/**
 * One turn's traces, or the sentence for their absence. A session launched with
 * traces off has nothing missing, so it says nothing per turn; the Timeline
 * says that once, above the turns.
 */
export function TurnTrace({ traces, error, interactions }: {
  traces: SessionTraces | null;
  error: string | null;
  interactions: TraceInteraction[] | undefined;
}) {
  if (error) return <p className="tt-note"><Mark glyph="✕" word="could not read" tone="serious" /> Traces: {error}</p>;
  if (!traces) return null;
  if (!interactions || interactions.length === 0) {
    return traces.requested ? <p className="tt-note">No trace recorded for this turn.</p> : null;
  }
  return <>{interactions.map((trace) => <Waterfall key={trace.traceId} trace={trace} />)}</>;
}
