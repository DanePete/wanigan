import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountLimits, ConsumptionPoint, LimitWindow, ModelConsumption, UsageSnapshot } from '@shared/types';

/**
 * What is left, and what was spent — kept visibly apart.
 *
 * The two halves of this screen come from different places and carry different
 * weight. The limit windows are a live reading from the provider, because a
 * token counter on this machine cannot answer "what is left": compaction,
 * cached input and plan-specific limits make every such calculation a guess.
 * The consumption below is Wanigan's own exact record of what happened. Showing
 * them in one continuous run of charts would invite the reader to treat the
 * second as evidence for the first, which is the error the whole screen exists
 * to avoid — so they are separated, labelled, and never share an axis.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = new Intl.NumberFormat();

const compact = (n: number): string =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
        : String(Math.round(n));

/** A colour per window severity. Semantic, and separate from the accent. */
function tone(percent: number): string {
  if (percent >= 95) return 'var(--danger, #c2453a)';
  if (percent >= 75) return 'var(--warn, #b7791f)';
  return 'var(--accent)';
}

/**
 * "resets in 2h 14m", or the provider's own words when the date did not parse.
 *
 * The verbatim text is never discarded, so a countdown is a bonus rather than
 * something the screen depends on being able to compute.
 */
function resetLabel(window: LimitWindow, now: number): string {
  if (window.resetsAt === null) return `resets ${window.resetsAtText}`;
  const left = window.resetsAt - now;
  if (left <= 0) return 'resetting now';
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `resets in ${days}d ${hours % 24}h`;
  if (hours >= 1) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function windowTitle(window: LimitWindow): string {
  const kind = window.kind === 'session' ? 'Session' : window.kind === 'week' ? 'This week' : window.kind;
  return window.scope ? `${kind} · ${window.scope}` : kind;
}

/** The bar grows from zero on mount, so the page reads as a measurement being taken. */
function Meter({ window, now, delay }: { window: LimitWindow; now: number; delay: number }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const timer = window.usedPercent >= 0 ? setTimeout(() => setGrown(true), 40 + delay) : null;
    return () => { if (timer) clearTimeout(timer); };
  }, [delay, window.usedPercent]);
  const colour = tone(window.usedPercent);
  const exhausted = window.usedPercent >= 100;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <span style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>{windowTitle(window)}</span>
        <span className="mono" style={{ fontSize: 'var(--t-micro)', color: colour, fontVariantNumeric: 'tabular-nums' }}>
          {window.usedPercent}% used
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-sunk, rgba(127,127,127,.18))', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${grown ? window.usedPercent : 0}%`, background: colour, borderRadius: 2,
          transition: 'width 900ms cubic-bezier(.22,.8,.3,1)',
        }} />
      </div>
      <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
        {exhausted ? 'exhausted · ' : ''}{resetLabel(window, now)}
      </span>
    </div>
  );
}

function LimitCard({ limits, now }: { limits: AccountLimits; now: number }) {
  const stale = limits.fetchedAt !== null && now - limits.fetchedAt > 10 * 60_000;
  return (
    <div className="sunk" style={{ padding: '14px 16px', display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--t-body)' }}>{limits.accountLabel}</strong>
        {limits.plan && <span className="pill">{limits.plan}</span>}
        {stale && <span className="pill" title="Older than ten minutes; press Refresh for a current reading.">stale</span>}
      </div>
      {/* Who this directory is actually signed in as. The label is the operator's
          name for the account; this is the agent's answer, and the two can
          disagree — which is exactly when you want to see it. */}
      {limits.identity && (limits.identity.email || limits.identity.orgName) && (
        <div className="faint mono trunc" style={{ fontSize: 'var(--t-micro)' }}
             title={[limits.identity.email, limits.identity.orgName].filter(Boolean).join(' · ')}>
          {limits.identity.email ?? limits.identity.orgName}
        </div>
      )}
      {limits.state === 'ok' ? (
        <div style={{ display: 'grid', gap: 14 }}>
          {limits.windows.map((window, index) => (
            <Meter key={`${window.kind}:${window.scope ?? 'all'}`} window={window} now={now} delay={index * 110} />
          ))}
        </div>
      ) : (
        <p className="dim" style={{ margin: 0, fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          {limits.detail ?? 'No reading.'}
        </p>
      )}
      {limits.fetchedAt !== null && (
        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>
          read {new Date(limits.fetchedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

/**
 * Tokens per day, stacked by model, one column per day.
 *
 * Drawn from one scale so every column is comparable, with the axis labelled by
 * a value the chart actually reaches rather than a rounded ceiling nothing
 * touches.
 */
function DailyChart({ points, accountLabel }: { points: ConsumptionPoint[]; accountLabel: string }) {
  const mine = points.filter((p) => p.accountLabel === accountLabel);
  const days = [...new Set(mine.map((p) => p.day))].sort();
  const models = [...new Set(mine.map((p) => p.model))].sort();
  const byDay = new Map<string, Map<string, number>>();
  for (const point of mine) {
    if (!byDay.has(point.day)) byDay.set(point.day, new Map());
    const bucket = byDay.get(point.day)!;
    bucket.set(point.model, (bucket.get(point.model) ?? 0) + point.tokens);
  }
  const totals = days.map((day) => [...(byDay.get(day)?.values() ?? [])].reduce((a, b) => a + b, 0));
  const peak = Math.max(1, ...totals);
  const palette = ['var(--accent)', 'var(--codex, #6a9bcc)', '#7f9f7f', '#b08a5a', '#9a7fae', '#5f9ea0'];

  if (!days.length) {
    return <p className="faint" style={{ fontSize: 'var(--t-small)', margin: 0 }}>No recorded requests for {accountLabel} in this window.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 116, overflowX: 'auto' }}>
        {days.map((day, dayIndex) => {
          const bucket = byDay.get(day) ?? new Map();
          const total = totals[dayIndex];
          return (
            <div key={day} title={`${day} · ${fmt.format(total)} tokens`}
                 style={{ flex: '1 0 14px', minWidth: 14, display: 'flex', flexDirection: 'column',
                          justifyContent: 'flex-end', height: '100%' }}>
              {models.map((model, modelIndex) => {
                const value = bucket.get(model) ?? 0;
                if (!value) return null;
                return (
                  <div key={model}
                       style={{ height: `${(value / peak) * 100}%`, background: palette[modelIndex % palette.length],
                                animation: 'wanigan-rise 700ms cubic-bezier(.22,.8,.3,1) both',
                                animationDelay: `${dayIndex * 18}ms` }} />
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>{days[0]}</span>
        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>peak {compact(peak)} tokens/day</span>
        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>{days[days.length - 1]}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {models.map((model, index) => (
          <span key={model} className="faint" style={{ fontSize: 'var(--t-micro)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 9, height: 9, background: palette[index % palette.length], display: 'inline-block' }} />
            {model}
          </span>
        ))}
      </div>
    </div>
  );
}

function ConsumptionTable({ rows }: { rows: ModelConsumption[] }) {
  if (!rows.length) return <p className="faint" style={{ fontSize: 'var(--t-small)' }}>Nothing recorded in this window.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560, fontSize: 'var(--t-small)' }}>
        <thead>
          <tr>
            {['Account', 'Model', 'Requests', 'In', 'Out', 'Cached', 'Cost'].map((head) => (
              <th key={head} className="label" style={{ textAlign: head === 'Account' || head === 'Model' ? 'left' : 'right', padding: '6px 10px' }}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.accountId ?? 'none'}:${row.model}`} style={{ borderTop: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '6px 10px' }}>{row.accountLabel}</td>
              <td className="mono" style={{ padding: '6px 10px' }}>{row.model}</td>
              <td className="mono" style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt.format(row.requests)}</td>
              <td className="mono" style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{compact(row.inTokens)}</td>
              <td className="mono" style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{compact(row.outTokens)}</td>
              <td className="mono" style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{compact(row.cacheRead)}</td>
              <td className="mono" style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  title={row.costStatus === 'reported' ? 'Every request carried a provider cost.'
                    : row.costStatus === 'partial' ? 'Some requests carried no provider cost, so this total is a floor.'
                      : 'This provider reported no cost, so there is no figure to show.'}>
                {row.costStatus === 'unreported' ? '—' : `${row.costStatus === 'partial' ? '≥' : ''}$${row.costUsd.toFixed(2)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Usage() {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(14);
  const [now, setNow] = useState(Date.now());

  const load = useCallback((force: boolean) => {
    setBusy(true); setErr(null);
    window.wanigan.usage.snapshot({ days, force })
      .then((next) => { setSnap(next); setNow(Date.now()); })
      .catch((e) => setErr(msg(e)))
      .finally(() => setBusy(false));
  }, [days]);

  useEffect(() => { load(false); }, [load]);
  // Only the countdown ticks on its own. Re-probing on a timer would start a
  // real CLI process behind the operator's back, so a fresh reading is always
  // something they asked for.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const accountLabels = useMemo(
    () => [...new Set([...(snap?.limits ?? []).map((l) => l.accountLabel),
                       ...(snap?.consumption ?? []).map((c) => c.accountLabel)])],
    [snap],
  );

  return (
    <div className="view">
      <style>{'@keyframes wanigan-rise{from{transform:scaleY(0);transform-origin:bottom}to{transform:scaleY(1);transform-origin:bottom}}'}</style>
      <header style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div className="label">Usage</div>
          <h1 style={{ margin: '2px 0 6px' }}>What is left, and what you spent</h1>
          <p className="dim" style={{ margin: 0, maxWidth: '70ch', lineHeight: 1.5 }}>
            Limits are read live from each account, because a token count on this machine cannot tell you what a
            plan has left. Consumption below is Wanigan's own record of what actually ran.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}
                  style={{ width: 'auto' }} aria-label="Consumption window">
            {[7, 14, 30, 90].map((value) => <option key={value} value={value}>Last {value} days</option>)}
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={() => load(true)}>
            {busy ? 'Reading…' : 'Refresh limits'}
          </button>
        </div>
      </header>

      {err && <div className="note error" style={{ marginTop: 14 }}>{err}</div>}

      <section style={{ marginTop: 22 }}>
        <div className="label">What is left</div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', marginTop: 8 }}>
          {(snap?.limits ?? []).map((limits) => <LimitCard key={limits.accountId} limits={limits} now={now} />)}
          {snap && snap.limits.length === 0 && (
            <p className="faint" style={{ fontSize: 'var(--t-small)' }}>No accounts are configured yet.</p>
          )}
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <div className="label">What you spent · last {snap?.days ?? days} days</div>
        {snap && snap.consumption.length === 0 ? (
          // One explanation, not a per-account chart plus an empty table plus a
          // note all saying the same thing. An empty state repeated three times
          // reads as three separate problems.
          <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 8, lineHeight: 1.55, maxWidth: '78ch' }}>
            Nothing recorded yet. These figures come from agent telemetry Wanigan collects for the sessions it
            starts, so a session run outside Wanigan — or before telemetry was switched on — leaves no row here.
            The limit windows above are unaffected: they are read from the provider, not from this.
          </p>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 20, marginTop: 8 }}>
              {accountLabels
                .filter((label) => (snap?.daily ?? []).some((point) => point.accountLabel === label))
                .map((label) => (
                  <div key={label}>
                    <div style={{ fontSize: 'var(--t-small)', fontWeight: 600, marginBottom: 6 }}>{label}</div>
                    <DailyChart points={snap?.daily ?? []} accountLabel={label} />
                  </div>
                ))}
            </div>
            <div style={{ marginTop: 16 }}>
              <ConsumptionTable rows={snap?.consumption ?? []} />
            </div>
          </>
        )}
      </section>

      {(snap?.limits ?? []).some((l) => l.factors.length > 0) && (
        <section style={{ marginTop: 28 }}>
          <div className="label">What contributed</div>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', margin: '4px 0 10px', lineHeight: 1.5, maxWidth: '80ch' }}>
            The agent's own breakdown, quoted as given. It describes this as approximate and based only on sessions
            on this machine — it does not include other devices or claude.ai — so it is shown as written rather
            than reformatted into figures it did not claim.
          </p>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
            {(snap?.limits ?? []).flatMap((limits) => limits.factors.map((period) => (
              <div key={`${limits.accountId}:${period.label}`} className="sunk" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>
                  {limits.accountLabel} · {period.label}
                </div>
                <div className="faint mono" style={{ fontSize: 'var(--t-micro)', margin: '3px 0 8px' }}>
                  {period.requests !== null ? `${fmt.format(period.requests)} requests` : ''}
                  {period.sessions !== null ? ` · ${fmt.format(period.sessions)} sessions` : ''}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                  {period.lines.map((line) => (
                    <li key={line} className="dim" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>{line}</li>
                  ))}
                </ul>
              </div>
            )))}
          </div>
        </section>
      )}
    </div>
  );
}
