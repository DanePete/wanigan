// Needs you, on the phone: what waits, what it asks, and the one thing that
// answers it — the terminal, a reply, the card, or Resume. The same kinds and
// words as the Mac's (lib/needs.ts), and the same rule for where a reply goes.
import { useState, type FormEvent } from 'react';
import { replyRoute } from '@shared/attention';
import { LIVE_STATES, NEED_KINDS, type Need, type Session } from '@shared/model';
import { Ask } from '../components/Ask';
import { Button, ProjectMark, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import { ago } from '../lib/format';
import { NEED_GROUP } from '../lib/needs';
import { useNav } from './nav';

export function NeedsScreen() {
  const needs = useQuery('needs.list', {}, ['needs']);
  const sessions = useQuery('sessions.list', { live: true }, ['sessions']);
  const byId = new Map((sessions.data ?? []).map((s) => [s.id, s]));
  const list = needs.data ?? [];
  return (
    <section aria-labelledby="needs-title">
      <h1 id="needs-title" className="phone-title">Needs you</h1>
      {needs.data && !list.length ? <p className="phone-empty">Nothing needs you. {byId.size ? `${byId.size} running.` : ''}</p> : null}
      {NEED_KINDS.map((kind) => {
        const items = list.filter((n) => n.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind} className="phone-group" aria-labelledby={`pn-${kind}`}>
            <h2 id={`pn-${kind}`}>{NEED_GROUP[kind].title} <span className="faint">{items.length}</span></h2>
            <ol className="phone-list">
              {items.map((n) => <NeedItem key={`${n.kind}-${n.sessionId ?? ''}-${n.cardId ?? ''}-${n.since}`} need={n} session={n.sessionId ? byId.get(n.sessionId) ?? null : null} />)}
            </ol>
          </section>
        );
      })}
    </section>
  );
}

function NeedItem({ need, session }: { need: Need; session: Session | null }) {
  const nav = useNav();
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const route = replyRoute(need, session ? { provider: session.provider, state: session.state, live: LIVE_STATES.has(session.state), relayed: session.relayed } : null);
  const asks = need.kind === 'permission' ? need.asks ?? [] : [];
  const resume = async (): Promise<void> => {
    const s = await attempt(() => call('sessions.resume', { id: need.sessionId as string }), (m) => toast(m, 'error'));
    if (s) nav.go({ name: 'session', id: s.id });
  };

  let action = null;
  if ((need.kind === 'review' || need.kind === 'question') && need.cardId) action = <Button tone="primary" onClick={() => nav.go({ name: 'card', id: need.cardId! })}>{need.kind === 'review' ? 'Review' : 'Answer'}</Button>;
  else if ((need.kind === 'interrupted' || need.kind === 'failed') && need.sessionId && need.resumable) action = <Button tone="primary" icon="resume" onClick={resume}>Resume</Button>;
  else if (need.sessionId && session) {
    const inTerminal = need.kind === 'permission' || need.kind === 'starting';
    action = <Button tone={inTerminal ? 'attention' : 'plain'} icon="terminal" onClick={() => nav.go({ name: 'session', id: need.sessionId! })}>{inTerminal ? 'Answer in terminal' : 'Open'}</Button>;
  }

  return (
    <li className="phone-item">
      <div className="phone-item-head">
        <ProjectMark projectKey={need.projectKey} size="s" />
        <span className="phone-item-title">{need.cardKey ? <span className="mono">{need.cardKey} </span> : null}{need.title}</span>
        <span className="faint small">{ago(need.since)}</span>
      </div>
      {asks.map((a, i) => <Ask key={i} ask={a} />)}
      {need.detail && !asks.length ? <p className="phone-detail">{need.detail}</p> : null}
      {route && !route.ok ? <p className="phone-detail faint">{route.why}</p> : null}
      <div className="phone-actions">
        {action}
        {route?.ok && !replying ? <Button icon="reply" onClick={() => setReplying(true)}>Reply</Button> : null}
      </div>
      {replying ? <Reply need={need} onDone={() => setReplying(false)} /> : null}
    </li>
  );
}

/** A reply, by the composer's queue; a question is answered on its card too, as on the Mac. */
function Reply({ need, onDone }: { need: Need; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    if (need.kind === 'question' && need.cardId) {
      const answered = await attempt(() => call('cards.comment', { id: need.cardId as string, body }), (m) => toast(m, 'error'));
      if (!answered) return;
    }
    const message = need.kind === 'question' ? `The owner answered your question on ${need.cardKey}: ${body}` : body;
    const r = await attempt(() => call('sessions.queue', { id: need.sessionId as string, text: message }), (m) => toast(m, 'error'));
    if (!r) return;
    toast(r.queued ? 'Queued until it finishes its turn.' : 'Sent.');
    onDone();
  };
  return (
    <form className="phone-reply" onSubmit={(e) => void send(e)}>
      <textarea aria-label={`Reply to ${need.title}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus />
      <div className="phone-actions">
        <Button tone="quiet" onClick={onDone}>Cancel</Button>
        <Button type="submit" tone="primary" icon="send" disabled={!text.trim()}>Send</Button>
      </div>
    </form>
  );
}
