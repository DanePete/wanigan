import type { CodexCreditsReport } from '@shared/cost-types';
import { Note, SectionHead, Stat, ago, num } from './bits';
import '../styles/cost.css';

/**
 * Codex plan sessions in credits — an estimate, beside the dollar figures and
 * never inside them. Every figure here is arithmetic over a dated rate card, so
 * every figure carries "~" and says so; the tier column says whether Fast was
 * recorded, assumed away, or changed mid-session.
 */

const credits = (n: number) => `~${num(Math.round(n))}`;

export default function CodexCredits({ report, error }: { report: CodexCreditsReport | null; error: string | null }) {
  if (error && !report) {
    return <section className="chart-card cost-card" aria-label="Codex credits"><h3>Codex plan sessions in credits</h3><Note tone="warn">{error}</Note></section>;
  }
  if (!report || report.sessions.length === 0) return null;
  const card = `estimate from OpenAI’s rate card, ${report.rateCard.readOn}`;
  return (
    <section className="chart-card cost-card" aria-label="Codex credits">
      <h3>Codex plan sessions in credits</h3>
      <p className="sub">
        Codex sessions have no dollar cost on record and stay unpriced in the totals above. Where their token counts are
        recorded they are estimated here in credits, the unit a ChatGPT plan spends — kept apart from dollars.
      </p>
      <div className="stat-grid">
        <Stat label="Credits" value={<>{credits(report.totalCredits)} <span className="cost-est">est.</span></>}
          sub={report.upperCredits > report.totalCredits ? `up to ${credits(report.upperCredits)} if every tier change ran Fast` : card} />
        <Stat label="Sessions estimated" value={num(report.estimatedSessions)} sub={`of ${num(report.sessions.length)} Codex sessions in ${report.days} days`} />
        <Stat label="Tier not recorded" value={num(report.tierNotRecorded)} sub="estimated at the standard rate; Fast would be 2.5×" />
        <Stat label="No estimate" value={num(report.unestimated)} sub="no counts, no published rate, or an API-key account" />
      </div>
      <SectionHead label="Sessions" count={report.sessions.length} />
      <div className="cost-table-wrap">
        <table className="viz-table cost-table">
          <thead><tr><th>Session</th><th>Model</th><th>Tier</th><th className="ins-th-r">Input · cached · output</th><th className="ins-th-r">Credits</th></tr></thead>
          <tbody>
            {report.sessions.map((s) => (
              <tr key={s.sessionId}>
                <td><span className="trunc">{s.title || 'Untitled session'}</span><span className="cost-cell-sub">{s.projectName ?? 'no project'} · {ago(s.startedAt)}</span></td>
                <td className="mono">{s.estimate.model ?? '—'}</td>
                <td>{s.estimate.status === 'estimated' ? s.estimate.tierNote : '—'}</td>
                <td className="n">{s.tokens ? `${num(s.tokens.input)} · ${num(s.tokens.cached)} · ${num(s.tokens.output)}` : '—'}</td>
                <td className="n">
                  {s.estimate.status === 'estimated'
                    ? <><span className="cost-cell-money">{s.estimate.range ? `${credits(s.estimate.range[0])}–${num(Math.round(s.estimate.range[1]))}` : credits(s.estimate.credits)}</span><span className="cost-cell-sub">est.</span></>
                    : <span className="cost-cell-sub">{s.estimate.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint cost-fine">
        Rates per 1M tokens, {report.rateCard.source}, read {report.rateCard.readOn}: {Object.entries(report.rateCard.models)
          .map(([model, r]) => `${model} ${r.input}/${r.cached}/${r.output}`).join(' · ')} (input/cached/output); Fast ×{report.rateCard.fastMultiplier}.
        Model and tier are what each rollout recorded, not the current config.
      </p>
    </section>
  );
}
