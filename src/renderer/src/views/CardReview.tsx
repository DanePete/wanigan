// Requested AI review and its evidence; approval remains an owner action.
import { useState } from 'react';
import type { CardDetail } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { ago, duration } from '../lib/format';
import { Icon, type IconName } from '../components/icons';
import { Badge, Button, useToast } from '../components/ui';
import { Section } from '../components/Panel';
import { Select } from '../components/Select';

/** A verdict as the card says it: green for done, red for a criterion not met; "your call" needs you, so it is amber's words. */
function Verdict({ verdict }: { verdict: 'pass' | 'changes' | 'unsure' }) {
  if (verdict === 'pass') return <Badge tone="green">Looks done</Badge>;
  if (verdict === 'changes') return <Badge tone="red">Changes needed</Badge>;
  return <span className="ai-verdict-unsure">Needs your judgment</span>;
}

const MARK: Record<'met' | 'unmet' | 'unknown', { icon: IconName; label: string }> = {
  met: { icon: 'check', label: 'Met' },
  unmet: { icon: 'close', label: 'Not met' },
  unknown: { icon: 'question', label: 'Could not tell' },
};

/** Claude Code's review of the card, on request. Advice: approving stays with the owner. */
export function AiReviewSection({ card }: { card: CardDetail }) {
  const toast = useToast();
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const projects = useQuery('projects.list', {}, ['projects']);
  const claude = (accounts.data ?? []).filter((a) => a.provider === 'claude');
  const projectAccount = projects.data?.find((p) => p.id === card.projectId)?.accounts.claude;
  const fallback = projectAccount ?? claude.find((a) => a.isDefault)?.id ?? '';
  const [accountId, setAccountId] = useState('');
  const chosen = claude.find((a) => a.id === (accountId || fallback));
  const latest = card.reviews[0];
  const running = latest?.state === 'running';
  const ask = (): Promise<unknown> => attempt(() => call('cards.aiReview', { id: card.id, accountId: chosen?.id ?? null }), (m) => toast(m, 'error'));
  const asWho = (id: string | null): string => claude.find((a) => a.id === id)?.label ?? 'the default account';

  return (
    <Section title="AI review" className="ai-review">
      {running ? (
        <p className="ai-running"><span className="state-dot pulse" aria-hidden="true" /> Claude Code is checking the work against each criterion, as {asWho(latest.accountId)}. Started {ago(latest.startedAt)}.</p>
      ) : null}

      {latest?.state === 'done' && latest.result ? (
        <div className="ai-result">
          <p className="ai-verdict">
            <Verdict verdict={latest.result.verdict} />
            <span className="faint small">{ago(latest.finishedAt)}</span>
          </p>
          {latest.result.summary ? <p className="ai-summary">{latest.result.summary}</p> : null}
          {latest.result.check?.length ? (
            <div className="ai-check">
              <p className="ai-check-title">Check it yourself</p>
              <ol>{latest.result.check.map((step, i) => <li key={i}>{step}</li>)}</ol>
            </div>
          ) : null}
          {latest.result.notes.length ? <p className="ai-notes small">{latest.result.notes.join(' ')} Wanigan downgraded its “done”.</p> : null}
          <ul className="ai-criteria">
            {latest.result.criteria.map((c, i) => {
              const kind = c.met === true ? 'met' : c.met === false ? 'unmet' : 'unknown';
              return (
                <li key={i} className={`ai-c ai-c-${kind}`}>
                  <span className="ai-mark" role="img" aria-label={MARK[kind].label}><Icon name={MARK[kind].icon} size={14} /></span>
                  <div>
                    <p className="ai-criterion">{c.criterion}</p>
                    <p className="ai-proof">{c.proof}</p>
                    {c.file && c.quote ? (
                      <p className="ai-quote">
                        <span className="mono">{c.file}</span>
                        <q className="mono">{c.quote}</q>
                        <span className={c.quoteFound ? 'quote-found' : 'quote-missing'}>{c.quoteFound ? 'found in the file' : 'not in the file'}</span>
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="faint small">
            Checked as {asWho(latest.accountId)} in {latest.finishedAt ? duration(latest.startedAt, latest.finishedAt) : '?'}
            {latest.costUsd !== null ? `; Claude Code reported $${latest.costUsd.toFixed(2)}` : '; no cost was reported'}. It is advice: approving stays with you.
          </p>
        </div>
      ) : null}

      {latest?.state === 'failed' ? <p className="error-text small" role="alert">{latest.error}</p> : null}

      {!running ? (
        <div className="ai-ask">
          {!latest ? (
            <p className="faint small">Claude Code checks the code and the evidence against each criterion with read-only tools, and every quote it cites is checked against its file. It uses a turn of the account’s plan and never moves the card.</p>
          ) : null}
          <div className="row-gap">
            {claude.length > 1 ? (
              <Select label="Account to review with" size="s" value={chosen?.id ?? ''} onChange={setAccountId}
                options={claude.map((a) => ({ value: a.id, label: a.label, ...(a.signedIn === 'no' ? { detail: 'signed out' } : a.identity ? { detail: a.identity } : {}) }))} />
            ) : null}
            <Button size="s" icon="search" onClick={ask}>{latest ? 'Check again' : 'Ask Claude to check it'}</Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
