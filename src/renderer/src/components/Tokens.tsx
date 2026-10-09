// What a conversation cost in tokens, read from the agent's own record of it.
// No dollars: a subscription is not billed per token, and an estimate dressed
// as a bill is the false precision Wanigan does not show.
import type { ConversationUsage } from '@shared/tokens';
import { shortTokens, tokensUsed } from '@shared/tokens';
import { useQuery } from '../lib/api';

const FROM: Record<ConversationUsage['source'], string> = {
  claude: 'Claude Code’s transcript', codex: 'Codex’s rollout', mixed: 'Claude Code’s transcripts and Codex’s rollouts',
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

/** "1.2M tokens · 84k in context", for a session's header. */
export function SessionTokens({ sessionId }: { sessionId: string }) {
  const q = useQuery('sessions.tokens', { id: sessionId }, ['sessions'], (_e, d) => (d as { sessionId?: string })?.sessionId === sessionId);
  const t = q.data;
  if (!t || (!t.usage && !t.note)) return null;
  if (!t.usage) return <span className="faint small" title={t.note ?? undefined}>tokens not counted</span>;
  const u = t.usage;
  return (
    <span className="mono small" title={breakdown(u, 'this conversation')}>
      {shortTokens(tokensUsed(u))} tokens{u.context !== null
        ? <span className="faint"> · {shortTokens(u.context)}{u.contextWindow ? ` of ${shortTokens(u.contextWindow)}` : ''} in context</span> : null}
    </span>
  );
}

/** "1.2M tokens", beside a card's Sessions heading. */
export function CardTokens({ cardId }: { cardId: string }) {
  const q = useQuery('cards.tokens', { id: cardId }, ['sessions']);
  const t = q.data;
  if (!t || (!t.usage && !t.uncounted)) return null;
  const skipped = t.uncounted ? `${t.uncounted} ${t.uncounted === 1 ? 'session' : 'sessions'} not counted: a Codex thread not yet known, or a conversation not saved yet.` : '';
  if (!t.usage) return <span className="faint small" title={skipped}>tokens not counted</span>;
  const what = t.sessions === 1 ? 'this card’s conversation' : `this card’s ${t.sessions} conversations`;
  return (
    <span className="faint small mono" title={[breakdown(t.usage, what), skipped].filter(Boolean).join('\n')}>
      {shortTokens(tokensUsed(t.usage))}{t.uncounted ? '+' : ''} tokens
    </span>
  );
}
