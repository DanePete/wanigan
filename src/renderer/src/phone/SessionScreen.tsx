// One session on the phone: its terminal, keys a phone keyboard lacks, a
// message for an agent (sent when it is idle, as on the Mac), and Stop.
//
// The terminal is drawn at the size the session has, scaled to fit, so the Mac
// is not disturbed; "Fit to this phone" resizes it on purpose.
import { useRef, useState, type FormEvent } from 'react';
import { LIVE_STATES } from '@shared/model';
import { localModelLabel } from '@shared/local-models';
import { Terminal } from '../components/Terminal';
import { Button, StateMark, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import { PROVIDER_LABEL } from '../lib/format';
import { useNav } from './nav';

/** What each key sends: the bytes a terminal would. */
const KEYS: { label: string; data: string; name: string }[] = [
  { label: 'Esc', data: '\x1b', name: 'Escape' },
  { label: 'Tab', data: '\t', name: 'Tab' },
  { label: '↑', data: '\x1b[A', name: 'Up' },
  { label: '↓', data: '\x1b[B', name: 'Down' },
  { label: '←', data: '\x1b[D', name: 'Left' },
  { label: '→', data: '\x1b[C', name: 'Right' },
  { label: '1', data: '1', name: '1' },
  { label: '2', data: '2', name: '2' },
  { label: '3', data: '3', name: '3' },
  { label: '⏎', data: '\r', name: 'Enter' },
  { label: '^C', data: '\x03', name: 'Control C' },
];

export function SessionScreen({ id }: { id: string }) {
  const nav = useNav();
  const toast = useToast();
  const got = useQuery('sessions.get', { id }, ['sessions'], (_e, d) => (d as { sessionId?: string })?.sessionId === id);
  const [fit, setFit] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const focus = useRef<(() => void) | null>(null);
  const session = got.data?.session;
  if (!session) return got.error ? <p className="phone-empty">{got.error.message}</p> : null;
  const live = LIVE_STATES.has(session.state);
  const send = (data: string): void => void attempt(() => call('sessions.input', { id, data }), (m) => toast(m, 'error'));
  const stop = async (): Promise<void> => {
    if (await attempt(() => call('sessions.stop', { id }), (m) => toast(m, 'error'))) { toast(`${session.title} stopped.`); setConfirmStop(false); }
  };

  return (
    <section className="phone-session" aria-labelledby="session-title">
      <header className="phone-session-head">
        {nav.canGoBack ? <Button tone="quiet" icon="back" aria-label="Back" onClick={nav.back} /> : null}
        <div>
          <h1 id="session-title" className="phone-title small">{session.title}</h1>
          <p className="faint small">{PROVIDER_LABEL[session.provider]}{session.model ? ` · ${localModelLabel(session.model) ?? session.model}` : ''} <StateMark state={session.state} /></p>
        </div>
      </header>
      <div className={`phone-terminal${fit ? ' fit' : ''}`} onClick={() => focus.current?.()}>
        <Terminal key={fit ? 'fit' : 'scaled'} sessionId={id} live={live} fixedSize={!fit} focusRef={focus} />
      </div>
      {live ? (
        <>
          <div className="phone-keys" role="group" aria-label="Keys">
            {KEYS.map((k) => <button key={k.name} type="button" aria-label={k.name} onClick={() => send(k.data)}>{k.label}</button>)}
          </div>
          {session.provider !== 'shell' ? <Message id={id} /> : null}
          <div className="phone-actions">
            <Button onClick={() => setFit((f) => !f)}>{fit ? 'Back to its own size' : 'Fit to this phone'}</Button>
            {confirmStop
              ? <><Button tone="danger" icon="stop" onClick={stop}>Stop it</Button><Button tone="quiet" onClick={() => setConfirmStop(false)}>Keep it</Button></>
              : <Button tone="quiet" icon="stop" onClick={() => setConfirmStop(true)}>Stop</Button>}
          </div>
          {fit ? <p className="faint small">Fitted to this phone, the session is that size on your Mac too until it is fitted there again.</p> : null}
        </>
      ) : <p className="phone-empty">This session has ended.</p>}
    </section>
  );
}

/** A message for the agent, typed in when it is next at its prompt. */
function Message({ id }: { id: string }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const r = await attempt(() => call('sessions.queue', { id, text: text.trim() }), (m) => toast(m, 'error'));
    if (!r) return;
    setText('');
    toast(r.queued ? 'Queued until it finishes its turn.' : 'Sent.');
  };
  return (
    <form className="phone-message" onSubmit={(e) => void send(e)}>
      <textarea aria-label="Message the agent" placeholder="Message the agent. It is sent when the agent is idle." value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <Button type="submit" tone="primary" icon="send" disabled={!text.trim()}>Send</Button>
    </form>
  );
}
