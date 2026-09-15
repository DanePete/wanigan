import { useState } from 'react';
import type { BucketTotals, CostPerCommit, SpendYieldReport, YieldBucket } from '@shared/spend-yield';
import { EmptyState, Mark, Note, SectionHead, Stat, ago, num, usd } from './bits';
import '../styles/cost.css';

/**
 * "Where the money went": each project and model's reported spend, split by
 * what happened to the work it paid for.
 *
 * Every figure here is observed — the CLI's own cost, and an outcome Wanigan
 * recorded when it merged or removed the worktree — so nothing on this card
 * carries an estimate mark. What it does carry is the size of every gap: how
 * many sessions have no price, and how many have no recorded outcome and why.
 * A bucket that reads "$0.00" beside "3 unpriced" is saying it could not count,
 * not that the work was free.
 */

const BUCKET: Record<YieldBucket, { glyph: string; word: string; tone: 'ok' | 'warn' | 'quiet' | 'accent' }> = {
  merged: { glyph: '✓', word: 'Merged', tone: 'ok' },
  discarded: { glyph: '✕', word: 'Discarded', tone: 'warn' },
  'removed-clean': { glyph: '○', word: 'No changes', tone: 'quiet' },
  open: { glyph: '◌', word: 'Still open', tone: 'accent' },
  'not-recorded': { glyph: '?', word: 'Not recorded', tone: 'quiet' },
};

const WITHHELD: Record<Extract<CostPerCommit, { status: 'withheld' }>['reason'], string> = {
  'no-merges': 'no merges',
  'unpriced-merge': 'a merged session has no reported cost',
  'commits-not-recorded': 'a merge did not record its commit count',
  'zero-commits': 'merges recorded no commits',
};

function money(t: BucketTotals): string {
  if (t.sessions === 0) return '—';
  if (t.unpricedSessions === t.sessions) return 'not priced';
  return usd(t.costUsd);
}

function Cell({ t, extra }: { t: BucketTotals; extra?: string }) {
  return (
    <td className="n">
      <span className="cost-cell-money">{money(t)}</span>
      {t.sessions > 0 && (
        <span className="cost-cell-sub">
          {num(t.sessions)} {t.sessions === 1 ? 'session' : 'sessions'}
          {t.unpricedSessions > 0 && t.unpricedSessions < t.sessions && ` · ${num(t.unpricedSessions)} unpriced`}
          {extra && ` · ${extra}`}
        </span>
      )}
    </td>
  );
}

export default function SpendYield({ report, error, onOpenSession }: {
  report: SpendYieldReport | null;
  error: string | null;
  onOpenSession?: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (error && !report) {
    return (
      <section className="chart-card cost-card" aria-label="Where the money went">
        <h3>Where the money went</h3>
        <Note tone="warn"><strong>Outcomes could not be read.</strong> {error}</Note>
      </section>
    );
  }
  if (!report) return null;

  const groups = report.groups;
  const sum = (pick: (g: SpendYieldReport['groups'][number]) => BucketTotals) => groups.reduce(
    (acc, g) => ({ sessions: acc.sessions + pick(g).sessions, costUsd: acc.costUsd + pick(g).costUsd, unpricedSessions: acc.unpricedSessions + pick(g).unpricedSessions }),
    { sessions: 0, costUsd: 0, unpricedSessions: 0 });
  const merged = sum((g) => g.merged);
  const reverted = sum((g) => g.reverted);
  const discarded = sum((g) => g.discarded);
  const clean = sum((g) => g.removedClean);
  const still = sum((g) => g.open);
  const unknown = sum((g) => g.notRecorded);
  const noWorktree = groups.reduce((n, g) => n + g.notRecorded.noWorktree, 0);
  const historical = groups.reduce((n, g) => n + g.notRecorded.historical, 0);

  return (
    <section className="chart-card cost-card" aria-label="Where the money went">
      <h3>Where the money went</h3>
      <p className="sub">
        Sessions and headless runs started in the last {report.days} days, by what happened to their worktree.
        Costs are the CLI’s reported figures; sessions without one are counted, not added as $0.
      </p>
      {groups.length === 0 ? (
        <EmptyState posture="nothing-in-scope" title={`No sessions started in the last ${report.days} days.`}
          cue="Outcomes appear here once a session runs in its own worktree and is merged, discarded or left open." />
      ) : (
        <>
          <div className="stat-grid cost-stats">
            <Stat label="Merged" value={money(merged)} sub={`${num(merged.sessions)} sessions${reverted.sessions ? ` · ${num(reverted.sessions)} later reverted` : ''}`} />
            <Stat label="Discarded" value={money(discarded)} sub={`${num(discarded.sessions)} sessions · ${num(clean.sessions)} more with no changes`} />
            <Stat label="Still open" value={money(still)} sub={`${num(still.sessions)} worktrees not yet merged or removed`} />
            <Stat label="Not recorded" value={money(unknown)} sub={`${num(noWorktree)} without a worktree · ${num(historical)} removed before outcomes were recorded`} />
          </div>
          <div className="cost-table-wrap">
            <table className="viz-table cost-table">
              <thead>
                <tr>
                  <th>Project · model</th>
                  <th className="ins-th-r">Merged</th>
                  <th className="ins-th-r">Discarded</th>
                  <th className="ins-th-r">No changes</th>
                  <th className="ins-th-r">Still open</th>
                  <th className="ins-th-r">Not recorded</th>
                  <th className="ins-th-r">Per merged commit</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const key = `${g.projectId ?? g.projectName}|${g.model ?? ''}`;
                  const expanded = open === key;
                  const ratio = g.costPerMergedCommit;
                  return [
                    <tr key={key}>
                      <td>
                        <button type="button" className="cost-row-toggle" aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : key)}>
                          <span className="trunc">{g.projectName}</span>
                          <span className="cost-model mono">{g.model ?? 'model not recorded'}</span>
                        </button>
                        {g.repositories.length > 0 && (
                          <span className="cost-cell-sub">CLI reported: {g.repositories.join(', ')}</span>
                        )}
                      </td>
                      <Cell t={g.merged} extra={g.reverted.sessions ? `${num(g.reverted.sessions)} reverted` : undefined} />
                      <Cell t={g.discarded} />
                      <Cell t={g.removedClean} />
                      <Cell t={g.open} />
                      <Cell t={g.notRecorded} />
                      <td className="n">
                        {ratio.status === 'observed'
                          ? <><span className="cost-cell-money">{usd(ratio.usdPerCommit)}</span>
                            <span className="cost-cell-sub">{num(ratio.commits)} commits</span></>
                          : <span className="cost-cell-sub">withheld: {WITHHELD[ratio.reason]}</span>}
                      </td>
                    </tr>,
                    expanded && (
                      <tr key={`${key}:sessions`} className="cost-drill">
                        <td colSpan={7}>
                          <ul className="cost-drill-list" aria-label={`Sessions for ${g.projectName}`}>
                            {g.sessions.map((s) => {
                              const d = report.detail[s.sessionId];
                              const b = BUCKET[s.bucket];
                              return (
                                <li key={s.sessionId}>
                                  <Mark glyph={s.reverted ? '↺' : b.glyph} word={s.reverted ? 'Merged, then reverted' : b.word} tone={s.reverted ? 'warn' : b.tone} />
                                  <span className="trunc">{d?.title || (s.source === 'headless' ? 'Headless run' : 'Untitled session')}</span>
                                  <span className="faint">{d?.startedAt ? ago(d.startedAt) : ''}</span>
                                  <span className="mono faint">{d?.branch ?? (d?.worktree ? '' : 'no worktree')}</span>
                                  <span className="mono">{s.priced ? usd(s.costUsd) : 'not priced'}</span>
                                  {d?.mergeSha && <span className="mono faint">{d.mergeSha.slice(0, 9)}</span>}
                                  {d?.live && onOpenSession && (
                                    <button type="button" className="btn btn-sm" onClick={() => onOpenSession(s.sessionId)}>Open</button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SectionHead label="How this is recorded" />
      <p className="faint cost-fine">{report.note}</p>
    </section>
  );
}
