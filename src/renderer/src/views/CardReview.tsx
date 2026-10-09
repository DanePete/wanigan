// Requested AI review and its evidence; approval remains an owner action.
import { useState } from 'react';
import type { CardDetail } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { ago, duration } from '../lib/format';
import { Button, useToast } from '../components/ui';
import { Select } from '../components/Select';

const VERDICT: Record<'pass' | 'changes' | 'unsure', { label: string; tone: string }> = {
  pass: { label: 'Looks done', tone: 'green' },
  changes: { label: 'Changes needed', tone: 'red' },
  unsure: { label: 'Needs your judgment', tone: 'amber' },
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
    <section className="drawer-section ai-review">
      <h3>AI review</h3>
      {running ? (
        <p className="ai-running"><span className="state-dot pulse" aria-hidden="true" /> Claude Code is checking the work against each criterion, as {asWho(latest.accountId)}. Started {ago(latest.startedAt)}.</p>
      ) : null}

      {latest?.state === 'done' && latest.result ? (
        <div className="ai-result">
          <p className="ai-verdict">
            <span className={`verdict verdict-${VERDICT[latest.result.verdict].tone}`}>{VERDICT[latest.result.verdict].label}</span>
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
            {latest.result.criteria.map((c, i) => (
              <li key={i} className={`ai-c ai-c-${c.met === true ? 'met' : c.met === false ? 'unmet' : 'unknown'}`}>
                <span className="ai-mark" aria-label={c.met === true ? 'Met' : c.met === false ? 'Not met' : 'Could not tell'}>{c.met === true ? '✓' : c.met === false ? '✕' : '?'}</span>
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
            ))}
          </ul>
          <p className="faint small">
            Checked as {asWho(latest.accountId)} in {latest.finishedAt ? duration(latest.startedAt, latest.finishedAt) : '?'}
            {latest.costUsd !== null ? `; Claude Code reported $${latest.costUsd.toFixed(2)}` : '; no cost was reported'}. It is advice: approving stays with you.
          </p>
        </div>
      ) : null}

      {latest?.state === 'failed' ? <p className="error-text small">{latest.error}</p> : null}

      {!running ? (
        <div className="ai-ask">
          {!latest ? (
            <p className="faint small">Claude Code reads the code and the evidence against each criterion, with read-only tools, and cites what it found. Every quote it cites is checked against the file. It uses a turn of the account’s plan and never moves the card.</p>
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
    </section>
  );
}
