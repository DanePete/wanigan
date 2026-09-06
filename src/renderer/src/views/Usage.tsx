import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountLimits, ConsumptionPoint, LimitWindow, ModelConsumption, UsageSnapshot } from '@shared/types';
import { harnessLabel } from '@shared/types';
import { EmptyState, Note } from '../components/bits';

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

/**
 * The consumption windows the picker offers, and the one the page opens on.
 *
 * Fourteen days is the main process's own default — usage.ts DEFAULT_DAYS — so
 * it has to appear on this list. It did not: the page opened on 14 while the
 * picker offered 7, 30 and 90, and a <select> whose value matches no <option>
 * renders with nothing selected. The screen then showed a blank picker above a
 * heading that read "last 14 days", so neither half could be trusted to say
 * which window the figures below it covered. Keep the default a member of this
 * list, and keep the list in step with usage.ts.
 */
const WINDOWS = [7, 14, 30, 90];
const DEFAULT_WINDOW = 14;

const compact = (n: number): string =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
        : String(Math.round(n));

/** A colour per window severity: status tokens for the two bands that mean
 *  something, a data hue for the rest. The accent marks actionable things and a
 *  quiet reading is not one; the old --danger token was never defined. */
function tone(percent: number): string {
  if (percent >= 95) return 'var(--critical)';
  if (percent >= 75) return 'var(--warning)';
  return 'var(--series-1)';
}

/**
 * "resets in 2h 14m", the provider's own words when the date did not parse, or
 * nothing at all when it named no reset — which is what a window with nothing
 * used yet looks like. An empty string is the honest answer there; inventing
 * "resets soon" would be a claim the agent did not make.
 *
 * The verbatim text is never discarded, so a countdown is a bonus rather than
 * something the screen depends on being able to compute.
 */
function resetLabel(window: LimitWindow, now: number): string {
  if (window.resetsAtText === null && window.resetsAt === null) return '';
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

/** A limit reading is a value, not a measurement being taken, so the bar is
 *  drawn at its value: .mo-fill scales on the compositor and is still when
 *  motion is off. The percent word beside it carries the state. */
function Meter({ window, now }: { window: LimitWindow; now: number; delay: number }) {
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
      <div style={{ height: 8, background: 'var(--bg)', border: '1px solid var(--line-soft)', borderRadius: 2, overflow: 'hidden' }}>
        <div className="mo-fill" style={{ height: '100%', width: '100%', background: colour, borderRadius: 2,
                                          ['--mo-p' as string]: Math.max(0, Math.min(1, window.usedPercent / 100)) } as React.CSSProperties} />
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
        {/* Which agent this login belongs to. "Personal" is the operator's word
            and two agents can both have one; without the harness the two cards
            are the same card twice. */}
        <span className="pill">{harnessLabel(limits.harness)}</span>
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
          {/* A reading can be complete and still carry something the meters do
              not say. Codex reports a spend control separately from its
              percentages, and it is the fact that explains a refused run while
              every window still looks fine. */}
          {limits.detail && <Note tone="warn">{limits.detail}</Note>}
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
                       style={{ height: `${(value / peak) * 100}%`, background: palette[modelIndex % palette.length] }} />
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
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
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

  /**
   * Where an exhausted window still has room on another account.
   *
   * Both readings are live, so this compares like with like: the same harness,
   * the same window kind and the same model scope. The harness clause is not a
   * detail — a Codex login has room on its own weekly window every hour of the
   * day, and offering it as somewhere to run an exhausted Claude model would be
   * a suggestion that cannot work. It reports only a real pairing — 100% here,
   * under 100% there — and picks the emptiest alternative so the sentence names
   * one account rather than listing every candidate.
   */
  const relief = useMemo(() => {
    const ok = (snap?.limits ?? []).filter((l) => l.state === 'ok');
    const key = (w: LimitWindow) => `${w.kind}:${w.scope ?? 'all'}`;
    const out: { exhausted: string; window: string; spare: string; sparePercent: number }[] = [];
    for (const account of ok) {
      for (const window of account.windows) {
        if (window.usedPercent < 100) continue;
        const alternatives = ok
          .filter((other) => other.accountId !== account.accountId && other.harness === account.harness)
          .flatMap((other) => other.windows
            .filter((w) => key(w) === key(window) && w.usedPercent < 100)
            .map((w) => ({ label: other.accountLabel, percent: w.usedPercent })));
        if (alternatives.length === 0) continue;
        const best = alternatives.reduce((a, b) => (b.percent < a.percent ? b : a));
        out.push({
          exhausted: account.accountLabel, window: windowTitle(window),
          spare: best.label, sparePercent: best.percent,
        });
      }
    }
    return out;
  }, [snap]);

  const accountLabels = useMemo(
    () => [...new Set([...(snap?.limits ?? []).map((l) => l.accountLabel),
                       ...(snap?.consumption ?? []).map((c) => c.accountLabel)])],
    [snap],
  );

  return (
    <div className="pane">
      {/* Roots on the shared pane frame so the gutter, title size and compact
          breakpoints match every other document view; the old root class had
          no rule anywhere and rendered flush to the window edge. */}
      <header className="pane-head">
        <div>
          <div className="label-stencil">What is left, and what you spent</div>
          <h1>Usage</h1>
          <p className="dim" style={{ margin: 0, maxWidth: '70ch', lineHeight: 1.5 }}>
            Limits are read live from each account, because a token count on this machine cannot tell you what a
            plan has left. Consumption below is Wanigan's own record of what actually ran.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}
                  style={{ width: 'auto' }} aria-label="Consumption window">
            {WINDOWS.map((value) => <option key={value} value={value}>Last {value} days</option>)}
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={() => load(true)}>
            {busy ? 'Reading…' : 'Refresh limits'}
          </button>
        </div>
      </header>

      {/* An error beside the data, not instead of it: a refresh that fails after
          a good read must not throw away the reading already on screen. When the
          very first read fails there is nothing to keep, and the two sections
          below say so themselves rather than claiming emptiness. */}
      {err && (
        <Note tone="error" action={{ label: busy ? 'Reading…' : 'Try again', run: () => load(true) }}>
          {err}
        </Note>
      )}

      {/* An exhausted window is only bad news if it is the only account you
          have. This page already holds a live reading for each one, so it can
          answer the question the red bar provokes — "can I keep working?" —
          instead of leaving the operator to compare two cards themselves. It
          names the account and the window, and says nothing at all unless a
          window is genuinely exhausted on one account and genuinely has room on
          another; a guess about which account you *should* use is not on
          offer. */}
      {relief.length > 0 && (
        <Note tone="ok">
          {relief.map((item) => (
            <span key={`${item.exhausted}:${item.window}`} className="us-relief-line">
              <strong>{item.exhausted}</strong> has nothing left on {item.window}.{' '}
              <strong>{item.spare}</strong> is at {item.sparePercent}% on the same window.
            </span>
          ))}
          <span className="faint us-relief-how">
            Choose the account in the New session dialog, or per project in Settings › Projects.
          </span>
        </Note>
      )}

      <section>
        <div className="label">What is left</div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', marginTop: 8 }}>
          {/* Loading is not empty: until the first probe returns there is nothing
              to say about any account, so say that instead of an empty grid. */}
          {snap === null && !err && (
            <p className="faint" style={{ fontSize: 'var(--t-small)' }}>Reading each account…</p>
          )}
          {snap === null && err && (
            <EmptyState posture="could-not-read" title="Could not read your accounts" cue={err} />
          )}
          {(snap?.limits ?? []).map((limits) => <LimitCard key={limits.accountId} limits={limits} now={now} />)}
          {snap && snap.limits.length === 0 && (
            <p className="faint" style={{ fontSize: 'var(--t-small)' }}>No accounts are configured yet.</p>
          )}
        </div>
      </section>

      <section>
        <div className="label">What you spent · last {snap?.days ?? days} days</div>
        {snap === null && err ? (
          // Three states, not two. Without this branch a rejected read left
          // "Reading Wanigan's records…" on screen for good: a claim that a read
          // is still in progress, made by a page that had already given up.
          <EmptyState posture="could-not-read" title="Could not read what you spent" cue={err} />
        ) : snap === null ? (
          <p className="faint" style={{ fontSize: 'var(--t-small)', marginTop: 8 }}>
            Reading Wanigan's records for the last {days} days…
          </p>
        ) : snap.consumption.length === 0 ? (
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
        <section>
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
