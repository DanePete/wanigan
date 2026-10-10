// What a conversation cost in tokens, read from the agent's own record of it.
// No dollars: a subscription is not billed per token, and an estimate dressed
// as a bill is the false precision Wanigan does not show.
import type { ConversationUsage } from '@shared/tokens';
import { shortTokens, tokensUsed } from '@shared/tokens';
import { useQuery } from '../lib/api';
import { tipProps } from './ui';

const FROM: Record<ConversationUsage['source'], string> = {
  claude: 'Claude Code’s transcript', codex: 'Codex’s rollout', gemini: 'Gemini CLI’s chat file', mixed: 'each agent’s own record',
};

function breakdown(u: ConversationUsage, what: string): string {
  const n = (x: number): string => x.toLocaleString();
  return [
    `${n(tokensUsed(u))} tokens in ${what}, from ${FROM[u.source]}.`,
    `Input ${n(u.input)} · cache read ${n(u.cacheRead)} · cache write ${n(u.cacheWrite)} · output ${n(u.output)}.`,
    `${n(u.requests)} ${u.requests === 1 ? 'request' : 'requests'}${u.subagents ? `, ${u.subagents} ${u.subagents === 1 ? 'subagent' : 'subagents'} included` : ''}.`,
    u.context !== null
      ? `The latest request sent ${n(u.context)} tokens of context${u.model ? ` to ${u.model}` : ''}${u.contextWindow ? `, whose window is ${n(u.contextWindow)}` : ''}.`
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * A session's tokens, for its details panel: the total, how full the context
 * is (a meter, when the window is known), and each kind, read from the agent's
 * own record and said to be so.
 */
export function SessionUsage({ sessionId }: { sessionId: string }) {
  const q = useQuery('sessions.tokens', { id: sessionId }, ['sessions'], (_e, d) => (d as { sessionId?: string })?.sessionId === sessionId);
  const t = q.data;
  if (q.error) return <p className="usage-note error-text">Wanigan could not read the tokens: {q.error.message}</p>;
  if (!t) return <p className="usage-note faint">Reading the agent’s record…</p>;
  if (!t.usage) return <p className="usage-note faint">{t.note ?? 'Not counted: the agent has not saved this conversation yet.'}</p>;
  const u = t.usage;
  const n = (x: number): string => x.toLocaleString();
  const full = u.context !== null && u.contextWindow ? Math.min(100, Math.round((u.context / u.contextWindow) * 100)) : null;
  return (
    <div className="usage">
      <p className="usage-total"><span className="usage-big">{shortTokens(tokensUsed(u))}</span> tokens</p>
      {u.context !== null ? (
        <div className="usage-context">
          <span className="usage-context-words">
            {shortTokens(u.context)}{u.contextWindow ? ` of ${shortTokens(u.contextWindow)}` : ''} in context{u.model ? <span className="faint"> · {u.model}</span> : null}
          </span>
          {full !== null ? (
            <span className="usage-meter" role="meter" aria-valuenow={full} aria-valuemin={0} aria-valuemax={100}
              aria-label={`Context: ${full}% of the window used`}>
              <span style={{ width: `${full}%` }} />
            </span>
          ) : null}
        </div>
      ) : null}
      <dl className="facts usage-kinds">
        <div><dt>Input</dt><dd className="mono">{n(u.input)}</dd></div>
        <div><dt>Cache read</dt><dd className="mono">{n(u.cacheRead)}</dd></div>
        <div><dt>Cache write</dt><dd className="mono">{n(u.cacheWrite)}</dd></div>
        <div><dt>Output</dt><dd className="mono">{n(u.output)}</dd></div>
        <div><dt>Requests</dt><dd className="mono">{n(u.requests)}{u.subagents ? <span className="faint"> · {u.subagents} {u.subagents === 1 ? 'subagent' : 'subagents'}</span> : null}</dd></div>
      </dl>
      <p className="usage-note faint">From {FROM[u.source]}. A plan is not billed per token, so no cost is shown.</p>
    </div>
  );
}

/** "1.2M tokens", beside a card's Sessions heading. */
export function CardTokens({ cardId }: { cardId: string }) {
  const q = useQuery('cards.tokens', { id: cardId }, ['sessions']);
  const t = q.data;
  if (!t || (!t.usage && !t.uncounted)) return null;
  const skipped = t.uncounted ? `${t.uncounted} ${t.uncounted === 1 ? 'session' : 'sessions'} not counted: a Codex thread not yet known, a conversation not saved yet, or a Gemini chat outside Wanigan’s Gemini home.` : '';
  if (!t.usage) return <span className="faint small" {...tipProps(skipped)}>tokens not counted</span>;
  const what = t.sessions === 1 ? 'this card’s conversation' : `this card’s ${t.sessions} conversations`;
  return (
    <span className="faint small mono" {...tipProps([breakdown(t.usage, what), skipped].filter(Boolean).join('\n'))}>
      {shortTokens(tokensUsed(t.usage))}{t.uncounted ? '+' : ''} tokens
    </span>
  );
}
