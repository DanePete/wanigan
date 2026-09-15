import type { CostCausesReport } from '@shared/cost-types';
import { Note, ago, num } from './bits';
import '../styles/cost.css';

/**
 * Cost by cause. Four blocks, four numbers, each with its own label and its
 * own rows to drill into — deliberately not summed and never scored. A capped
 * attribution is an estimate and says so; counts of tool calls and recorded
 * reasons are observed.
 */

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

function OpenButton({ id, live, onOpenSession }: { id: string | null; live: boolean; onOpenSession?: (id: string) => void }) {
  if (!id || !live || !onOpenSession) return null;
  return <button type="button" onClick={() => onOpenSession(id)}>open</button>;
}

export default function CostCauses({ report, error, onOpenSession }: {
  report: CostCausesReport | null; error: string | null; onOpenSession?: (id: string) => void;
}) {
  if (error && !report) {
    return <section className="chart-card cost-card" aria-label="Cost by cause"><h3>Cost by cause</h3><Note tone="warn">{error}</Note></section>;
  }
  if (!report) return null;
  const { idle, reads, mcp, cacheMiss } = report;
  return (
    <section className="chart-card cost-card" aria-label="Cost by cause">
      <h3>Cost by cause</h3>
      <p className="sub">
        Four causes an operator can change, each measured on its own from local transcripts and hook events over the last {report.days} days.
        They overlap and are not added together.
      </p>
      <div className="cost-causes">
        <div className="cost-cause">
          <h4>Cache rewritten after idle gaps</h4>
          <div className="cost-cause-value">~{num(idle.cappedTokens)} tokens <span className="cost-est">est.</span></div>
          <p className="faint cost-fine">
            {num(idle.gaps)} requests wrote to the prompt cache after a gap of 5 min or more, capped at what the previous request had cached.
            Uncapped upper bound: {num(idle.uncappedTokens)} observed cache-write tokens.{idle.truncated ? ' Only the first 200,000 requests were read.' : ''}
          </p>
          <ul className="cost-cause-list">
            {idle.conversations.slice(0, 8).map((c) => (
              <li key={c.conversation}>
                <span className="trunc">{c.title ?? c.where ?? c.conversation.slice(0, 8)}</span>
                <span className="mono">~{num(c.cappedTokens)}</span>
                <span className="faint">{num(c.gaps)} gaps · longest {minutes(c.longestGapMs)}</span>
                <OpenButton id={c.sessionId} live={c.live} onOpenSession={onOpenSession} />
              </li>
            ))}
          </ul>
        </div>

        <div className="cost-cause">
          <h4>Files read again and again</h4>
          <div className="cost-cause-value">{num(reads.extraReads)} reads past the second</div>
          <p className="faint cost-fine">
            {num(reads.files)} files in {num(reads.sessions)} sessions were read more than twice with no edit to them in between (observed tool calls).
          </p>
          <ul className="cost-cause-list">
            {reads.rows.slice(0, 8).map((r) => (
              <li key={`${r.sessionId}:${r.path}`}>
                <span className="trunc mono">{r.path.split('/').slice(-2).join('/')}</span>
                <span className="mono">×{r.reads}</span>
                <span className="faint trunc">{r.title ?? r.where ?? ''}</span>
                <OpenButton id={r.sessionId} live={r.live} onOpenSession={onOpenSession} />
              </li>
            ))}
          </ul>
        </div>

        <div className="cost-cause">
          <h4>MCP servers never called</h4>
          <div className="cost-cause-value">{num(mcp.unused.length)} of {num(mcp.configured)} configured</div>
          <p className="faint cost-fine">Enabled in Wanigan’s MCP registry with no tool call in {mcp.days} days. {mcp.hooklessNote}</p>
          <ul className="cost-cause-list">
            {mcp.unused.slice(0, 8).map((s) => (
              <li key={s.id}>
                <span className="trunc mono">{s.name}</span>
                <span className="faint">{s.lastCalledAt ? `last called ${ago(s.lastCalledAt)}` : 'never called'}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="cost-cause">
          <h4>Cache misses Claude Code named</h4>
          <div className="cost-cause-value">{cacheMiss.recorded ? `${num(cacheMiss.types.reduce((n, t) => n + t.count, 0))} recorded` : 'not recorded'}</div>
          <p className="faint cost-fine">
            {cacheMiss.note} Read {num(cacheMiss.transcriptsScanned)} of {num(cacheMiss.sessionsConsidered)} session transcripts
            {cacheMiss.cliVersions.length ? `; CLI ${cacheMiss.cliVersions.join(', ')}` : ''}.
            {cacheMiss.missedTokens ? ` ${num(cacheMiss.missedTokens)} missed input tokens reported.` : ''}
          </p>
          <ul className="cost-cause-list">
            {cacheMiss.types.map((t) => (
              <li key={t.type}><span className="trunc mono">{t.type}</span><span className="mono">{num(t.count)}</span></li>
            ))}
            {cacheMiss.sessions.slice(0, 5).map((s) => (
              <li key={s.sessionId}>
                <span className="trunc">{s.title ?? s.where}</span>
                <span className="faint">{Object.entries(s.types).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
                <OpenButton id={s.sessionId} live={s.live} onOpenSession={onOpenSession} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
