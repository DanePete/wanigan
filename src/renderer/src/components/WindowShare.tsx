import { useEffect, useState } from 'react';
import type { WindowShareReport } from '@shared/cost-types';
import { EmptyState, Mark, Note, SectionHead, num } from './bits';
import '../styles/cost.css';

/**
 * Which session is eating the current 5-hour window, per Claude account. The
 * shares are of tokens Wanigan's own sessions reported, never of the plan's
 * limit — the "What is left" card beside this is the provider's reading, and
 * the two are different instruments.
 */
export default function WindowShare({ accountId, refreshKey }: { accountId: string | null; refreshKey: number }) {
  const [report, setReport] = useState<WindowShareReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.cost.windowShare()
      .then((value) => { if (live) { setReport(value); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [refreshKey]);
  if (error && !report) return <Note tone="warn">The window shares could not be read: {error}</Note>;
  if (!report) return null;
  const accounts = report.accounts.filter((a) => accountId === null || a.accountId === accountId);
  return (
    <section className="cost-card" aria-label="Who is using the 5-hour window">
      <SectionHead label="Who is using the 5-hour window" />
      <p className="u-provenance">{report.note}</p>
      {accounts.length === 0 ? (
        <EmptyState posture="nothing-in-scope" title="No Claude Code account to share out." cue="Shares appear per Claude Code account once a session has reported tokens in its window." />
      ) : accounts.map((a) => (
        <div key={a.accountId} className="cost-cause">
          <h4>{a.label}</h4>
          <p className="faint cost-fine">
            {num(a.totalTokens)} tokens recorded since {new Date(a.windowStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {a.windowFrom === 'reported-reset' ? ' (window start from the provider’s reset time)' : ' (rolling five hours: no reset time reported)'}
            {a.usedPercent !== null ? ` · provider reading ${Math.round(a.usedPercent)}% used` : ''}.
          </p>
          {a.sessions.length === 0 ? <p className="faint cost-fine">No session has reported tokens in this window.</p> : (
            <ul className="cost-cause-list">
              {a.sessions.map((s) => (
                <li key={s.sessionId}>
                  <span className="trunc">{s.title ?? 'Untitled session'}<span className="faint"> · {s.project ?? 'no project'}</span></span>
                  <meter className="cost-meter cost-share-meter" min={0} max={1} value={s.share} aria-label={`${Math.round(s.share * 100)}% of the recorded tokens`} />
                  <span className="mono">{Math.round(s.share * 100)}%</span>
                  {s.live ? <Mark glyph="●" word="live" tone="ok" /> : <Mark glyph="○" word="ended" tone="quiet" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
