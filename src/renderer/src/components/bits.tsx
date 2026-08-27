export const STATUS: Record<string, { bg: string; fg: string; label: string }> = {
  draft:       { bg: 'var(--bg-sunk)',    fg: 'var(--text-dim)', label: 'draft' },
  submitting:  { bg: 'var(--accent-soft)',fg: 'var(--accent)',   label: 'submitting' },
  in_progress: { bg: 'var(--accent-soft)',fg: 'var(--accent)',   label: 'in progress' },
  canceling:   { bg: 'var(--warn-soft)',  fg: 'var(--warn)',     label: 'canceling' },
  ended:       { bg: 'var(--ok-soft)',    fg: 'var(--ok)',       label: 'ended' },
  failed:      { bg: 'var(--bad-soft)',   fg: 'var(--bad)',      label: 'failed' },
  succeeded:   { bg: 'var(--ok-soft)',    fg: 'var(--ok)',       label: 'succeeded' },
  errored:     { bg: 'var(--bad-soft)',   fg: 'var(--bad)',      label: 'errored' },
  expired:     { bg: 'var(--dead-soft)',  fg: 'var(--dead)',     label: 'expired' },
  canceled:    { bg: 'var(--warn-soft)',  fg: 'var(--warn)',     label: 'canceled' },
  refused:     { bg: 'var(--serious-soft)', fg: 'var(--serious)', label: 'refused' },
  pending:     { bg: 'var(--bg-sunk)',    fg: 'var(--text-dim)', label: 'pending' },
};

export function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.pending;
  return <span className="pill" style={{ background: s.bg, color: s.fg }}>{s.label}</span>;
}

export function Bar({ succeeded, failed, pending }: { succeeded: number; failed: number; pending: number }) {
  const total = Math.max(1, succeeded + failed + pending);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div style={{ display: 'flex', height: 5, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-sunk)' }}
         title={`${succeeded} succeeded · ${failed} failed · ${pending} pending`}>
      <div style={{ width: pct(succeeded), background: 'var(--ok)' }} />
      <div style={{ width: pct(failed), background: 'var(--bad)' }} />
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="sunk" style={{ padding: '10px 13px' }}>
      <div className="label">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 3, color: tone, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub ? <div className="faint" style={{ fontSize: 11, marginTop: 1 }}>{sub}</div> : null}
    </div>
  );
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  const m = {
    info:  { bg: 'var(--bg-sunk)',   fg: 'var(--text-dim)', bd: 'var(--line)' },
    ok:    { bg: 'var(--ok-soft)',   fg: 'var(--ok)',       bd: 'var(--ok)' },
    warn:  { bg: 'var(--warn-soft)', fg: 'var(--warn)',     bd: 'var(--warn)' },
    error: { bg: 'var(--bad-soft)',  fg: 'var(--bad)',      bd: 'var(--bad)' },
  }[tone];
  return (
    <div style={{ background: m.bg, color: m.fg, borderLeft: `2px solid ${m.bd}`,
                  borderRadius: 6, padding: '7px 11px', fontSize: 12.5, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}

export function Section({ n, title, hint, right, children }: {
  n?: number; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="card" style={{ padding: 15 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 11 }}>
        {n !== undefined && (
          <span style={{ marginTop: 1, width: 19, height: 19, flex: 'none', borderRadius: 999,
                         display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                         background: 'var(--accent-soft)', color: 'var(--accent)' }}>{n}</span>
        )}
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</h2>
          {hint && <p className="dim" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{hint}</p>}
        </div>
        {right && <div style={{ marginLeft: 'auto', flex: 'none' }}>{right}</div>}
      </div>
      {children}
    </section>
  );
}

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

export function usd(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function ago(ts?: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function until(ts?: number | null): { text: string; urgent: boolean } {
  if (!ts) return { text: '—', urgent: false };
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return { text: 'expired', urgent: true };
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return { text: h > 0 ? `${h}h ${m}m` : `${m}m`, urgent: s < 7200 };
}
