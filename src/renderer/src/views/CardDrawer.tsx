import { Branch, ProjectChanges } from './CardGit';
import { AiReviewSection } from './CardReview';
import { CardShots } from '../components/live/Shots';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CARD_TYPES, COLUMNS, LIVE_STATES, PRIORITIES, type CardDetail, type CardType, type Priority, type Session } from '@shared/model';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { useDraft } from '../lib/draft';
import { href } from '../lib/router';
import { PROVIDER_LABEL, STATE_LABEL, TYPE_LABEL, actorName, ago } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, IconButton, Segmented, StateMark, TypeMark, useSingleFlight, useToast } from '../components/ui';
import { keyLabel } from '@shared/shortcuts';
import { SessionRow } from './ProjectView';
import { JevSection } from '../components/Jev';
import { orbPlay } from '../components/Orb';
import { CardTokens } from '../components/Tokens';
import type { JevMode } from '@shared/jev';
import { cardTerminal } from '@shared/card-terminal';
import type { DialogState } from '../App';

const STAGE_LABEL = { inbox: 'Inbox', ready: 'Ready', working: 'Working', review: 'Review', done: 'Done' } as const;

export function CardDrawer({ cardKey, onClose, setDialog }: { cardKey: string; onClose: () => void; setDialog: (d: DialogState) => void }) {
  const card = useQuery('cards.get', { id: cardKey }, ['board', 'sessions']);
  const projects = useQuery('projects.list', {}, ['projects']);
  const sessions = useQuery('sessions.list', card.data ? { projectId: card.data.projectId } : null, ['sessions']);
  const sessionMap = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s])), [sessions.data]);
  const project = projects.data?.find((p) => p.id === card.data?.projectId);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Escape belongs to whatever modal is open over the drawer (a dialog, the palette).
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA)$/.test(t.tagName) && t.closest('.drawer')) { t.blur(); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { panel.current?.focus(); }, [cardKey]);

  return (
    <aside className="drawer" aria-label={`Card ${cardKey}`} ref={panel} tabIndex={-1}>
      {card.error ? (
        <div className="drawer-pad">
          <div className="drawer-head"><span /><IconButton icon="close" label="Close card" onClick={onClose} /></div>
          <p className="error-text">{card.error.message}</p>
        </div>
      ) : !card.data ? (
        <div className="drawer-pad faint">Loading {cardKey}…</div>
      ) : (
        // Until the projects arrive, the card's own key says whose it is (NS-12 is NS's), so no link reads #/p//.
        <CardBody card={card.data} projectKey={project?.key ?? card.data.key.slice(0, card.data.key.lastIndexOf('-'))} projectPath={project?.path ?? ''} jevMode={project?.jev ?? 'off'} sessionMap={sessionMap} onClose={onClose} setDialog={setDialog} />
      )}
    </aside>
  );
}

function CardBody({ card, projectKey, projectPath, jevMode, sessionMap, onClose, setDialog }: {
  card: CardDetail;
  projectKey: string;
  projectPath: string;
  jevMode: JevMode;
  sessionMap: ReadonlyMap<string, Session>;
  onClose: () => void;
  setDialog: (d: DialogState) => void;
}) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const update = (fields: { title?: string; body?: string; type?: CardType; priority?: Priority }) =>
    attempt(() => call('cards.update', { id: card.id, ...fields }), fail);

  return (
    <div className="drawer-pad">
      <div className="drawer-head">
        <TypeMark type={card.type} />
        <button type="button" className="mono drawer-key" title="Copy the key" onClick={() => {
          void navigator.clipboard.writeText(card.key).then(() => toast(`Copied ${card.key}.`), () => toast('Could not copy.', 'error'));
        }}>{card.key}</button>
        <span className="faint drawer-when">Created {ago(card.createdAt)} by {actorName(card.createdBy, sessionMap)}</span>
        <IconButton icon="close" label="Close card" onClick={onClose} />
      </div>

      <EditableText
        className="drawer-title"
        label="Title"
        value={card.title}
        onSave={(title) => update({ title })}
        singleLine
      />

      <Stages status={card.status} />
      <div className="drawer-actions">
        <StageActions card={card} projectKey={projectKey} setDialog={setDialog} />
      </div>
      {card.claim ? <ClaimFacts card={card} /> : null}
      {card.reopened ? <p className="flag-line flag-red">Reopened as not fixed. The newest criterion says what is still wrong.</p> : null}
      {card.sentBack ? <p className="flag-line flag-amber">Sent back with changes requested. Your note is in the conversation below.</p> : null}

      <div className="drawer-fields">
        <div className="drawer-field">
          <span className="drawer-label" id="type-label">Type</span>
          <Segmented<CardType> label="Type" size="s" value={card.type} onChange={(type) => void update({ type })}
            options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </div>
        <div className="drawer-field">
          <span className="drawer-label">Priority</span>
          <Segmented<Priority> label="Priority" size="s" value={card.priority} onChange={(priority) => void update({ priority })}
            options={PRIORITIES.map((p) => ({ value: p, label: `P${p}`, hint: p === 0 ? 'Most urgent' : p === 3 ? 'Whenever' : undefined }))} />
        </div>
      </div>

      <section className="drawer-section">
        <h3>Description</h3>
        <EditableText className="drawer-body" label="Description" value={card.body} placeholder="What needs doing, and why. Agents read this." onSave={(body) => update({ body })} />
      </section>

      <Criteria card={card} />

      <JevSection card={card} mode={jevMode} />

      {card.status === 'review' || card.status === 'done' || card.reviews.length ? <AiReviewSection card={card} /> : null}

      {card.worktree ? <Branch card={card} projectKey={projectKey}
        folderAgents={[...sessionMap.values()].filter((s) => s.provider !== 'shell' && LIVE_STATES.has(s.state) && !!projectPath && s.cwd === projectPath)} />
        : card.status === 'review' || card.status === 'working' ? <ProjectChanges projectId={card.projectId} projectKey={projectKey} /> : null}

      <CardShots card={card} />

      {card.evidence.length ? (
        <section className="drawer-section">
          <h3>Evidence</h3>
          <ul className="evidence">
            {card.evidence.map((e) => (
              <li key={e.id}>
                <Icon name={e.kind === 'file' ? 'file' : e.kind === 'link' ? 'link' : 'note'} size={14} />
                {e.kind === 'link' ? <a href={e.value} target="_blank" rel="noreferrer">{e.value}</a>
                  : e.kind === 'file' ? <button type="button" className="linkish mono" onClick={() => void bridge().openPath(e.value)} title={`${e.value}\nShow in Finder`}>{relativeTo(e.value, projectPath)}</button>
                    : <span>{e.value}</span>}
                {e.kind === 'file' && e.existed === false ? <span className="flag flag-red">missing when offered</span> : null}
                <span className="faint evidence-by">{actorName(e.addedBy, sessionMap)}, {ago(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {card.sessions.length ? (
        <section className="drawer-section">
          <h3>Sessions <CardTokens cardId={card.id} /></h3>
          <div className="srows">{card.sessions.map((s) => <SessionRow key={s.id} session={s} projectKey={projectKey} inCard />)}</div>
        </section>
      ) : null}

      <Conversation card={card} sessionMap={sessionMap} />

      <details className="drawer-section drawer-history">
        <summary><h3>History</h3><span className="faint">{card.activity.length}</span></summary>
        <ol className="history">
          {card.activity.map((a) => (
            <li key={a.id}><span className="faint">{ago(a.at)}</span> {actorName(a.actor, sessionMap)} {a.verb}{a.detail ? <span className="faint"> {a.detail}</span> : null}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** Who holds the card, whether they are running, and what they last said about it. */
function ClaimFacts({ card }: { card: CardDetail }) {
  const claim = card.claim;
  if (!claim) return null;
  const holder = card.holder;
  const running = holder ? LIVE_STATES.has(holder.state) : false;
  return (
    <p className="claim-facts">
      {holder ? <StateMark state={holder.state} label={false} /> : <span className="state-dot" aria-hidden="true" />}
      <span>
        Held by <strong>{holder ? `${PROVIDER_LABEL[holder.provider]}${holder.title ? ` · ${holder.title}` : ''}` : 'a session'}</strong>
        {running ? `, ${STATE_LABEL[holder!.state].toLowerCase()}` : ', not running'}.
        {' '}{running ? 'The claim renews while it runs.' : `The claim lapses ${ago(claim.expiresAt)}.`}
        {claim.note ? <> Its note: <q>{claim.note}</q></> : null}
      </span>
    </p>
  );
}

function Stages({ status }: { status: CardDetail['status'] }) {
  const at = COLUMNS.indexOf(status as (typeof COLUMNS)[number]);
  return (
    <ol className="stages" aria-label={`Status: ${status}`}>
      {COLUMNS.map((s, i) => (
        <li key={s} className={i < at ? 'past' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="stage-bar" aria-hidden="true" />
          <span className="stage-label">{STAGE_LABEL[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function StageActions({ card, projectKey, setDialog }: { card: CardDetail; projectKey: string; setDialog: (d: DialogState) => void }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [note, setNote] = useState<null | 'sendBack' | 'reopen'>(null);
  const [text, setText] = useState('');
  const start = (): void => setDialog({ kind: 'session', projectId: card.projectId, cardId: card.id });

  if (note) {
    const sendBack = note === 'sendBack';
    return (
      <form className="note-form" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void attempt(() => (sendBack ? call('cards.sendBack', { id: card.id, note: text }) : call('cards.reopen', { id: card.id, stillWrong: text })), fail)
          .then((r) => { if (r) { toast(sendBack ? `${card.key} sent back.` : `${card.key} reopened.`); setNote(null); setText(''); } });
      }}>
        <label htmlFor="stage-note">{sendBack ? 'What should change?' : 'What is still wrong?'}</label>
        <textarea id="stage-note" value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
          placeholder={sendBack ? 'The agent sees this when it picks the card up again.' : 'This becomes a new acceptance criterion.'} />
        <div className="row-gap">
          <Button tone={sendBack ? 'primary' : 'danger'} type="submit" disabled={!text.trim()}>{sendBack ? 'Send back' : 'Reopen'}</Button>
          <Button tone="quiet" onClick={() => setNote(null)}>Cancel</Button>
        </div>
      </form>
    );
  }

  // A card sent back or reopened may still have its agent running: open that, never start a second.
  const terminal = cardTerminal(card);
  const open = (tone: 'primary' | 'plain'): ReactNode => (terminal.kind === 'open'
    ? <a className={`btn btn-${tone} btn-m`} href={href({ name: 'session', projectKey, sessionId: terminal.sessionId })}><Icon name="terminal" /><span>Open terminal</span></a>
    : null);
  switch (card.status) {
    case 'inbox':
      return (
        <>
          <Button tone="primary" icon="check" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'ready' }), fail)}>Accept to Ready</Button>
          {open('plain') ?? <Button icon="terminal" onClick={start}>Start a session</Button>}
          <Button tone="quiet" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'archived' }), fail)}>Archive</Button>
        </>
      );
    case 'ready':
      return (
        <>
          {open('primary') ?? <Button tone="primary" icon="terminal" onClick={start}>Start a session</Button>}
          <Button tone="quiet" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'archived' }), fail)}>Archive</Button>
        </>
      );
    case 'working':
      return (
        <>
          {open('primary') ?? <span className="faint">Held by a session that is not running.</span>}
          <Button tone="quiet" onClick={() => attempt(() => call('cards.release', { id: card.id, note: 'Taken back by the owner' }), fail)}>Take back</Button>
        </>
      );
    case 'review':
      return (
        <>
          <Button tone="primary" icon="check" onClick={() => attempt(() => call('cards.approve', { id: card.id }), fail).then((r) => { if (r) { toast(`${card.key} approved.`); orbPlay(document.querySelector('.rail-orb'), 'burst'); } })}>Approve</Button>
          <Button onClick={() => setNote('sendBack')}>Send back…</Button>
        </>
      );
    case 'done':
      return (
        <>
          <Button icon="reopen" onClick={() => setNote('reopen')}>Reopen as not fixed…</Button>
          <Button tone="quiet" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'archived' }), fail)}>Archive</Button>
        </>
      );
    default:
      return <span className="faint">Archived.</span>;
  }
}

function Criteria({ card }: { card: CardDetail }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const { text, setText, clear } = useDraft();
  const once = useSingleFlight();
  const done = card.criteria.filter((c) => c.done).length;
  return (
    <section className="drawer-section">
      <h3>Acceptance criteria {card.criteria.length ? <span className="faint">{done} of {card.criteria.length}</span> : null}</h3>
      {card.criteria.length ? (
        <ul className="criteria">
          {card.criteria.map((c) => (
            <li key={c.id} className={c.done ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={c.done} onChange={(e) => void attempt(() => call('criteria.update', { id: c.id, done: e.target.checked }), fail)} />
                <span>{c.text}</span>
              </label>
              <IconButton icon="close" label={`Remove “${c.text}”`} onClick={() => attempt(() => call('criteria.remove', { id: c.id }), fail)} />
            </li>
          ))}
        </ul>
      ) : <p className="faint small">What has to be true for this to be done. Agents check their work against these.</p>}
      <form className="inline-add" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void once(() => attempt(() => call('criteria.add', { cardId: card.id, text }), fail).then((r) => { if (r) clear(); }));
      }}>
        <label className="visually-hidden" htmlFor="criterion-new">New criterion</label>
        <input id="criterion-new" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a criterion, then Enter" />
      </form>
    </section>
  );
}

function Conversation({ card, sessionMap }: { card: CardDetail; sessionMap: ReadonlyMap<string, Session> }) {
  const toast = useToast();
  const { text, setText, clear } = useDraft();
  const once = useSingleFlight();
  const mac = bridge().platform === 'darwin';
  const open = card.comments.some((c) => c.kind === 'question' && !c.resolved);
  return (
    <section className="drawer-section">
      <h3>Conversation {card.comments.length ? <span className="faint">{card.comments.length}</span> : null}</h3>
      {card.comments.length ? (
        <ol className="comments">
          {card.comments.map((c) => {
            const question = c.kind === 'question';
            return (
              <li key={c.id} className={`comment${c.author === 'owner' ? ' mine' : ''}${question && !c.resolved ? ' question' : ''}`}>
                <div className="comment-head">
                  <strong>{actorName(c.author, sessionMap)}</strong>
                  {question ? <span className={`flag ${c.resolved ? 'flag-faint' : 'flag-amber'}`}>{c.resolved ? 'Answered' : 'Question'}</span> : null}
                  <span className="faint">{ago(c.createdAt)}</span>
                </div>
                <p>{c.body}</p>
              </li>
            );
          })}
        </ol>
      ) : null}
      <form className="comment-new" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void once(() => attempt(() => call('cards.comment', { id: card.id, body: text }), (m) => toast(m, 'error')).then((r) => { if (r) clear(); }));
      }}>
        <label className="visually-hidden" htmlFor="comment-new">Comment</label>
        <textarea id="comment-new" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`${open ? 'Answer the question' : 'Reply or leave a note'}. ${keyLabel('Mod', mac)}${mac ? '' : '+'}${keyLabel('Enter', mac)} to send.`}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} />
        <Button type="submit" disabled={!text.trim()}>Comment</Button>
      </form>
    </section>
  );
}

/** Text that reads as text until clicked, then edits in place. Saves on blur or ⌘↩. */
function EditableText({ value, onSave, label, placeholder, className, singleLine = false }: {
  value: string;
  onSave: (v: string) => unknown;
  label: string;
  placeholder?: string;
  className?: string;
  singleLine?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Escape blurs to leave, and the blur would save the draft it still holds.
  const cancelled = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = (): void => {
    if (cancelled.current) { cancelled.current = false; setDraft(value); return; }
    const next = singleLine ? draft.replace(/\s*\n\s*/g, ' ').trim() : draft.trim();
    if (next !== value && (next || !singleLine)) void onSave(next);
    else if (!next && singleLine) setDraft(value);
  };
  return (
    <textarea
      ref={ref}
      className={`editable ${className ?? ''}`}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      rows={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (singleLine || e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); e.stopPropagation(); }
      }}
    />
  );
}


/** A path inside the project shown relative to it; anything else in full. */
function relativeTo(path: string, root: string): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
