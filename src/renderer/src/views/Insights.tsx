import { useEffect, useState } from 'react';
import { num, usd } from '../components/bits';

/**
 * Charts are hand-rolled SVG: the renderer runs under a strict CSP with no
 * external hosts, and four small charts do not justify a charting library.
 *
 * Colour rules that are load-bearing, not taste:
 *  - Categorical hues are assigned by SLOT in fixed order. Reordering them to
 *    suit meaning puts yellow beside orange, a pair that fails both the CVD and
 *    normal-vision separation floors.
 *  - Status marks (succeeded / failed) always carry an icon and a text label.
 *    Green vs red measures ΔE 4.1 under deuteranopia — hue alone is unreadable.
 *  - Every chart has a table underneath, so identity never depends on colour.
 */

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

type Insights = {
  perRun: Record<string, number | string>[];
  byModel: Record<string, number | string>[];
  totals: Record<string, number>;
  outcomes: { status: string; n: number }[];
};

export default function InsightsView({ onOpenRun }: { onOpenRun?: (id: string) => void }) {
  const [d, setD] = useState<Insights | null>(null);

  useEffect(() => {
    const load = () => window.foreman.batch.insights().then(setD).catch(() => {});
    void load();
    const off = window.foreman.on.batchChanged(load);
    const t = setInterval(load, 15_000);
    return () => { off(); clearInterval(t); };
  }, []);

  if (!d) return <div className="pane"><p className="dim">Loading…</p></div>;

  const t = d.totals;
  const hasData = (t.runs ?? 0) > 0;

  // Cache economics. A cached prefix costs 0.1x base input to read; without the
  // cache those tokens would have been billed at full input rate.
  const cacheableTotal = (t.cache_read ?? 0) + (t.cache_write ?? 0);
  const hitRate = cacheableTotal > 0 ? (t.cache_read ?? 0) / cacheableTotal : 0;

  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h1>Insights</h1>
          <p className="dim">Where the tokens and the money actually went.</p>
        </div>
      </div>

      {!hasData ? (
        <div className="card chart-empty">
          No submitted runs yet. Charts appear once a batch has been submitted.
        </div>
      ) : (
        <>
          <div className="chart-grid">
            <HeroCard
              title="Total spend"
              hero={usd(t.cost ?? 0)}
              sub={<>Batch rates are exactly half of list, so the same work run synchronously
                    would have cost <strong>{usd((t.cost ?? 0) * 2)}</strong>.</>}
            >
              <SavingsBar spent={t.cost ?? 0} />
            </HeroCard>

            <HeroCard
              title="Cache hit rate"
              hero={cacheableTotal ? `${Math.round(hitRate * 100)}%` : '—'}
              sub={cacheableTotal
                ? <>{num(t.cache_read)} tokens read from cache at a tenth of the input rate,
                     {' '}{num(t.cache_write)} written. Hits inside a batch are best-effort.</>
                : <>No cached prefix in any run yet. Mark a system block as cached in the builder
                     and the shared context is billed once instead of per row.</>}
            >
              {cacheableTotal > 0 && <Gauge value={hitRate} />}
            </HeroCard>
          </div>

          <TokenFlow totals={t} />
          <SpendByModel rows={d.byModel} />
          <Outcomes rows={d.outcomes} />
          <SpendOverTime runs={d.perRun} onOpenRun={onOpenRun} />
        </>
      )}
    </div>
  );
}

function HeroCard({ title, hero, sub, children }: {
  title: string; hero: string; sub: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="hero" style={{ marginTop: 8 }}>{hero}</div>
      <div className="hero-sub">{sub}</div>
      {children}
    </div>
  );
}

/** Two-bar comparison: what you paid vs what synchronous would have cost. */
function SavingsBar({ spent }: { spent: number }) {
  const sync = spent * 2;
  const W = 100;
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} 34`} role="img"
         aria-label={`Batch cost ${usd(spent)} versus synchronous ${usd(sync)}`}>
      <rect x="0" y="2" width={W} height="9" rx="4" fill="var(--bg-sunk)" />
      <rect x="0" y="2" width={W} height="9" rx="4" fill="var(--series-2)" opacity="0.35" />
      <text x="0" y="20" fontSize="5.5" fill="var(--text-faint)">synchronous {usd(sync)}</text>
      <rect x="0" y="23" width={W / 2} height="9" rx="4" fill="var(--series-1)" />
      <text x={W / 2 + 2} y="30" fontSize="5.5" fill="var(--text-dim)">batch {usd(spent)}</text>
    </svg>
  );
}

function Gauge({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <svg className="chart-svg" viewBox="0 0 100 10" role="img"
         aria-label={`Cache hit rate ${Math.round(pct * 100)} percent`}>
      <rect x="0" y="2" width="100" height="6" rx="3" fill="var(--bg-sunk)" />
      <rect x="0" y="2" width={Math.max(1.5, pct * 100)} height="6" rx="3" fill="var(--series-3)" />
    </svg>
  );
}

/**
 * Where the tokens went, as one stacked bar. Cache reads are the interesting
 * segment: they are billed at a tenth of the input rate, so a wide aqua band is
 * the shape you want.
 */
function TokenFlow({ totals }: { totals: Record<string, number> }) {
  const parts = [
    { key: 'Input (uncached)', v: totals.in_tokens ?? 0,    c: SERIES[0] },
    { key: 'Output',           v: totals.out_tokens ?? 0,   c: SERIES[1] },
    { key: 'Cache read',       v: totals.cache_read ?? 0,   c: SERIES[2] },
    { key: 'Cache write',      v: totals.cache_write ?? 0,  c: SERIES[3] },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return null;

  const W = 100, GAP = 0.5;   // 2px surface gap at render scale
  let x = 0;

  return (
    <div className="chart-card">
      <h3>Token flow</h3>
      <p className="sub">
        Every token this workspace has been billed for, by kind. Cache reads cost a tenth
        of the input rate — the wider that band, the more the cached prefix is paying off.
      </p>
      <svg className="chart-svg" viewBox={`0 0 ${W} 16`} role="img"
           aria-label={parts.map((p) => `${p.key} ${num(p.v)}`).join(', ')}>
        {parts.map((p) => {
          const w = (p.v / total) * W;
          const seg = <rect key={p.key} x={x} y="0" width={Math.max(0, w - GAP)} height="11" rx="2" fill={p.c}>
            <title>{`${p.key}: ${num(p.v)} tokens (${((p.v / total) * 100).toFixed(1)}%)`}</title>
          </rect>;
          x += w;
          return seg;
        })}
      </svg>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key} className="legend-item">
            <span className="legend-swatch" style={{ background: p.c }} />
            {p.key} <span className="mono" style={{ color: 'var(--text-faint)' }}>{num(p.v)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** One series, so no legend — the title names it. Bars are direct-labelled. */
function SpendByModel({ rows }: { rows: Record<string, number | string>[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => Number(r.cost)));
  return (
    <div className="chart-card">
      <h3>Spend by model</h3>
      <p className="sub">Total billed per model across every submitted run.</p>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((r) => {
          const cost = Number(r.cost);
          const pct = max > 0 ? (cost / max) * 100 : 0;
          const reqs = Number(r.requests) || 0;
          return (
            <div key={String(r.model)}>
              <div style={{ display: 'flex', fontSize: 11.5, marginBottom: 3 }}>
                <span className="mono">{String(r.model)}</span>
                <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>
                  {usd(cost)}
                  {reqs > 0 && <span style={{ color: 'var(--text-faint)' }}>
                    {'  '}· {usd((cost / reqs) * 1000)}/1k rows
                  </span>}
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: 'var(--bg-sunk)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(pct, 1)}%`, height: '100%', borderRadius: 4,
                              background: 'var(--series-1)' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Outcomes are a status encoding. Green vs red is the classic CVD failure, so
 * each row carries a glyph and a word — colour is decoration here, never the
 * message.
 */
function Outcomes({ rows }: { rows: { status: string; n: number }[] }) {
  const SPEC: Record<string, { label: string; glyph: string; color: string }> = {
    succeeded: { label: 'Succeeded', glyph: '✓', color: 'var(--good)' },
    errored:   { label: 'Errored',   glyph: '✕', color: 'var(--critical)' },
    refused:   { label: 'Refused',   glyph: '⊘', color: 'var(--serious)' },
    expired:   { label: 'Expired',   glyph: '⏱', color: 'var(--warning)' },
    canceled:  { label: 'Canceled',  glyph: '⊖', color: 'var(--text-faint)' },
    pending:   { label: 'Pending',   glyph: '·', color: 'var(--text-faint)' },
  };
  const known = rows.filter((r) => r.n > 0);
  const total = known.reduce((a, r) => a + r.n, 0);
  if (!total) return null;

  const ok = known.find((r) => r.status === 'succeeded')?.n ?? 0;
  const W = 100, GAP = 0.4;
  let x = 0;

  return (
    <div className="chart-card">
      <h3>Request outcomes</h3>
      <p className="sub">
        {num(ok)} of {num(total)} requests succeeded. Refusals are counted as failures, not
        successes — the API returns them as HTTP 200, so treating them as good silently drops rows.
      </p>
      <svg className="chart-svg" viewBox={`0 0 ${W} 12`} role="img"
           aria-label={known.map((r) => `${SPEC[r.status]?.label ?? r.status} ${r.n}`).join(', ')}>
        {known.map((r) => {
          const w = (r.n / total) * W;
          const seg = <rect key={r.status} x={x} y="0" width={Math.max(0, w - GAP)} height="9" rx="2"
                            fill={SPEC[r.status]?.color ?? 'var(--text-faint)'}>
            <title>{`${SPEC[r.status]?.label ?? r.status}: ${num(r.n)}`}</title>
          </rect>;
          x += w;
          return seg;
        })}
      </svg>
      <table className="viz-table">
        <thead><tr><th>Outcome</th><th style={{ textAlign: 'right' }}>Requests</th><th style={{ textAlign: 'right' }}>Share</th></tr></thead>
        <tbody>
          {known.map((r) => {
            const s = SPEC[r.status] ?? { label: r.status, glyph: '·', color: 'var(--text-faint)' };
            return (
              <tr key={r.status}>
                <td>
                  <span style={{ color: s.color, marginRight: 7, fontWeight: 700 }}>{s.glyph}</span>
                  {s.label}
                </td>
                <td className="n">{num(r.n)}</td>
                <td className="n" style={{ color: 'var(--text-dim)' }}>{((r.n / total) * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Cost per run over time. Bars are clickable — the chart is a way into a run. */
function SpendOverTime({ runs, onOpenRun }: {
  runs: Record<string, number | string>[]; onOpenRun?: (id: string) => void;
}) {
  const withCost = runs.filter((r) => Number(r.cost_usd) > 0);
  if (withCost.length < 2) return null;

  const max = Math.max(...withCost.map((r) => Number(r.cost_usd)));
  const models = [...new Set(withCost.map((r) => String(r.model)))];
  const colorFor = (m: string) => SERIES[models.indexOf(m) % SERIES.length];

  const W = 100;
  const bw = Math.min(4, (W / withCost.length) * 0.7);
  const step = W / withCost.length;

  return (
    <div className="chart-card">
      <h3>Cost per run</h3>
      <p className="sub">Oldest to newest. Hover for the run; click to open it.</p>
      <svg className="chart-svg" viewBox={`0 0 ${W} 42`} role="img" aria-label="Cost per run over time">
        <line x1="0" y1="34" x2={W} y2="34" stroke="var(--grid)" strokeWidth="0.3" />
        {withCost.map((r, i) => {
          const c = Number(r.cost_usd);
          const h = Math.max(0.8, (c / max) * 30);
          const x = i * step + (step - bw) / 2;
          return (
            <rect key={String(r.id)} x={x} y={34 - h} width={bw} height={h} rx={Math.min(1, bw / 3)}
                  fill={colorFor(String(r.model))}
                  style={{ cursor: onOpenRun ? 'pointer' : undefined }}
                  onClick={() => onOpenRun?.(String(r.id))}>
              <title>{`${r.name}\n${r.model}\n${usd(c)} · ${num(Number(r.total_requests))} requests`}</title>
            </rect>
          );
        })}
        <text x="0" y="41" fontSize="3.4" fill="var(--text-faint)">oldest</text>
        <text x={W} y="41" fontSize="3.4" fill="var(--text-faint)" textAnchor="end">newest</text>
      </svg>
      {models.length > 1 && (
        <div className="legend">
          {models.map((m) => (
            <span key={m} className="legend-item">
              <span className="legend-swatch" style={{ background: colorFor(m) }} />
              <span className="mono">{m}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
