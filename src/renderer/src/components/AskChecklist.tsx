import { useCallback, useEffect, useState } from 'react';
import { draftFollowUp, type AskMessage, type StoredAskItem } from '@shared/ask-items';
import { Icon, Mark, ago, num } from './bits';
import { appendToComposerDraft } from './Composer';
import '../styles/depth.css';

/**
 * "Asks in this turn": the items the operator's own message split into, laid
 * out at the turn's Stop with what the recorded evidence says beside each.
 *
 * The hints are hints. A file that was touched was not necessarily changed the
 * way the item asked, and a command that exited 0 may have run the wrong
 * suite, so nothing here ticks an item; the operator does. Unticked items can
 * be put in the message box as one drafted follow-up, which the operator reads
 * and sends — nothing is typed into the agent from here.
 *
 * Hidden when the session has no recorded message with two or more asks, which
 * is most sessions: one ask is the message itself.
 */

export default function AskChecklist({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<number | null>(null);

  const read = useCallback(() => {
    window.wanigan.depth.asks.list(sessionId)
      .then((m) => { setMessages(m); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    setMessages([]); setDrafted(null);
    read();
    let timer: number | undefined;
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.event !== 'Stop' && e.event !== 'StopFailure' && e.event !== 'UserPromptSubmit' && e.event !== 'PostToolUse' && e.event !== 'PostToolUseFailure') return;
      if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; read(); }, 900);
    });
    return () => { off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [read, sessionId]);

  const tick = (item: StoredAskItem, on: boolean) => {
    setMessages((all) => all.map((m) => ({ ...m, items: m.items.map((i) => (i.id === item.id ? { ...i, tickedAt: on ? Date.now() : null } : i)) })));
    window.wanigan.depth.asks.tick(item.id, on).catch((e) => { setError(e instanceof Error ? e.message : String(e)); read(); });
  };

  if (!messages.length) return error ? <p className="faint dp-fine dp-pad">Recorded asks could not be read: {error}</p> : null;

  const due = messages.filter((m) => m.state === 'ended' || m.state === 'unobserved');
  const pending = messages.filter((m) => m.state === 'waiting' || m.state === 'running');
  const newest = due[0] ?? null;
  const open = newest ? newest.items.filter((i) => i.tickedAt === null).length : 0;

  return (
    <details className="tl-summary dp-asks" open={!!newest && open > 0}>
      <summary>
        <span>Asks in this turn</span>
        <span>
          {newest ? `${num(newest.items.length - open)} of ${num(newest.items.length)} ticked` : `${num(pending[0]?.items.length ?? 0)} recorded, turn not ended`}
          <Icon name="chevron-down" />
        </span>
      </summary>
      {pending.length > 0 && (
        <p className="faint dp-fine dp-pad">
          {num(pending[0].items.length)} asks from your last message are recorded. Their checklist appears here when the turn ends.
        </p>
      )}
      {due.map((m, i) => (
        <MessageChecklist key={m.id} message={m} first={i === 0} drafted={drafted === m.id}
          onTick={tick}
          onDraft={() => {
            const unticked = m.items.filter((item) => item.tickedAt === null);
            if (!unticked.length) return;
            appendToComposerDraft(sessionId, draftFollowUp(unticked), `Drafted a follow-up for ${unticked.length} unticked ${unticked.length === 1 ? 'ask' : 'asks'}. Read it, then send it yourself.`);
            setDrafted(m.id);
          }} />
      ))}
      {error && <p className="faint dp-fine dp-pad">{error}</p>}
    </details>
  );
}

function MessageChecklist({ message, first, drafted, onTick, onDraft }: {
  message: AskMessage; first: boolean; drafted: boolean;
  onTick: (item: StoredAskItem, on: boolean) => void; onDraft: () => void;
}) {
  const unticked = message.items.filter((i) => i.tickedAt === null).length;
  const body = (
    <>
      <p className="faint dp-fine">
        {message.source === 'phone' ? 'Sent from the phone' : 'Sent from the composer'} {ago(message.sentAt)}
        {message.state === 'unobserved'
          ? ' · no turn was recorded for this message, so there are no hints to show'
          : message.stopFailed ? ' · the turn ended in a failure' : ' · the turn ended'}
        . Hints come from recorded tool calls and are not a verdict; the tick is yours.
      </p>
      <ol className="dp-ask-list">
        {message.items.map((item) => <AskRow key={item.id} item={item} onTick={onTick} />)}
      </ol>
      <div className="dp-ask-actions">
        <button type="button" className="btn" disabled={unticked === 0} onClick={onDraft}>
          {unticked === 0 ? 'Every ask is ticked' : `Draft a follow-up for ${unticked} unticked`}
        </button>
        {drafted && <span className="faint dp-fine">In the message box, not sent.</span>}
      </div>
    </>
  );
  if (first) return <div className="dp-ask-message">{body}</div>;
  return (
    <details className="dp-ask-older">
      <summary>Earlier message · {ago(message.sentAt)} · {message.items.length - unticked} of {message.items.length} ticked</summary>
      <div className="dp-ask-message">{body}</div>
    </details>
  );
}

function AskRow({ item, onTick }: { item: StoredAskItem; onTick: (item: StoredAskItem, on: boolean) => void }) {
  const id = `ask-${item.id}`;
  const hints = item.hints;
  return (
    <li className="dp-ask" data-ticked={item.tickedAt !== null}>
      <input id={id} type="checkbox" checked={item.tickedAt !== null} onChange={(e) => onTick(item, e.target.checked)} />
      <div className="dp-ask-body">
        <label htmlFor={id} className="dp-ask-text">{item.text}</label>
        {hints && (hints.files.length > 0 || hints.commands.length > 0) && (
          <ul className="dp-hints">
            {hints.files.map((f) => (
              <li key={`f:${f.path}`}>
                {f.touched
                  ? <Mark glyph="✓" word={f.via ?? 'touched'} tone="ok" />
                  : <Mark glyph="·" word="not touched this turn" tone="quiet" />}
                <code>{f.path}</code>
              </li>
            ))}
            {hints.commands.map((c) => (
              <li key={`c:${c.command}`}>
                {!c.latest
                  ? <Mark glyph="·" word="not run this turn" tone="quiet" />
                  : c.latest.ok === false
                    ? <Mark glyph="✕" word={c.latest.exitCode !== null ? `ran · exit ${c.latest.exitCode}` : 'ran · failed'} tone="bad" />
                    : <Mark glyph="✓" word={c.latest.exitCode !== null ? `ran · exit ${c.latest.exitCode}` : 'ran · succeeded'} tone="ok" />}
                <code>{c.command}</code>
                {c.runs > 1 && <span className="faint dp-fine">{c.runs} runs, newest shown</span>}
              </li>
            ))}
          </ul>
        )}
        {hints && !hints.files.length && !hints.commands.length && (
          <span className="faint dp-fine">Names no file or command, so there is nothing recorded to lay beside it.</span>
        )}
      </div>
    </li>
  );
}
