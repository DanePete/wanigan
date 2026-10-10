// The card drawer (Studio): the right panel beside the work, resizable, its key
// and close in its head. What the card is and what to do next stay at the top
// (its title, its stage, the stage's actions); underline tabs below say the
// rest: Overview (the card itself and the conversation), Review (the AI review,
// the evidence, the sessions), Branch (its own branch, merging, the pull
// request) and Looks (what agents saw in the live view).
import { Branch, ProjectChanges } from './CardGit';
import { AiReviewSection } from './CardReview';
import { CardShots } from '../components/live/Shots';
import { CardLooks } from '../components/live/Looks';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CARD_TYPES, COLUMNS, LIVE_STATES, PRIORITIES, type CardDetail, type CardType, type Priority, type Session } from '@shared/model';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { useDraft } from '../lib/draft';
import { href } from '../lib/router';
import { PROVIDER_LABEL, STATE_LABEL, STATUS_LABEL, TYPE_LABEL, actorName, ago, fileManager, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, CopyButton, Disclosure, EmptyState, Field, IconButton, Segmented, StateMark, TypeMark, isMac, tipProps, useSingleFlight, useToast } from '../components/ui';
import { Panel, Section } from '../components/Panel';
import { TabPanel, Tabs } from '../components/Tabs';
import { keyLabel } from '@shared/shortcuts';
import { SessionRow } from './SessionsView';
import { JevSection } from '../components/Jev';
import { orbPlay } from '../components/Orb';
import { CardTokens } from '../components/Tokens';
import type { JevMode } from '@shared/jev';
import { cardTerminal } from '@shared/card-terminal';
import type { DialogState } from '../App';

type Tab = 'overview' | 'review' | 'branch' | 'looks';

/** How wide the drawer opens on this window, before it is resized (then its own width, kept on this computer). */
const openingWidth = (): number => Math.round(Math.max(360, Math.min(520, window.innerWidth * 0.32)));
/** The most it can take: the view beside it keeps room to work. */
const widest = (): number => Math.max(400, Math.min(760, window.innerWidth - 620));

export function CardDrawer({ cardKey, onClose, setDialog }: { cardKey: string; onClose: () => void; setDialog: (d: DialogState) => void }) {
  const card = useQuery('cards.get', { id: cardKey }, ['board', 'sessions']);
  const projects = useQuery('projects.list', {}, ['projects']);
  const sessions = useQuery('sessions.list', card.data ? { projectId: card.data.projectId } : null, ['sessions']);
  const sessionMap = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s])), [sessions.data]);
  const project = projects.data?.find((p) => p.id === card.data?.projectId);
  const [size] = useState(openingWidth);
  const shown = useRef(cardKey);
  shown.current = cardKey;

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

  // The keys move into the drawer when a card opens in it.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('aside.drawer');
    if (!el) return;
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }, [cardKey]);

  // The drawer's width is the frame's --drawer-w while it is open, so what sits beside it (Talk to Wanigan) follows a
  // resize. Closed, the keys go back to the card on the board or the List, where there is one.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('aside.drawer');
    const app = el?.closest<HTMLElement>('.app');
    if (!el || !app) return undefined;
    const watch = new ResizeObserver(() => app.style.setProperty('--drawer-w', `${Math.round(el.getBoundingClientRect().width)}px`));
    watch.observe(el);
    return () => {
      watch.disconnect();
      app.style.removeProperty('--drawer-w');
      const key = shown.current;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.querySelector<HTMLElement>(`.card[data-key="${CSS.escape(key)}"], .list-table tr[data-key="${CSS.escape(key)}"]`)?.focus();
      });
    };
  }, []);

  return (
    <Panel side="right" className="drawer" label={`Card ${cardKey}`} resizable size={size} minSize={320} maxSize={widest()} sizeKey="card-drawer"
      title={<span className="drawer-key">{card.data ? <TypeMark type={card.data.type} /> : null}<span className="mono">{cardKey}</span></span>}
      actions={<CopyButton text={cardKey} label={`Copy ${cardKey}`} what={cardKey} />}
      onClose={onClose} closeKeys="close-card">
      {card.error ? (
        <p className="error-text" role="alert">{card.error.message}</p>
      ) : !card.data ? (
        <div className="drawer-loading" aria-busy="true"><span className="visually-hidden">Loading {cardKey}</span><span /><span /><span /></div>
      ) : (
        // Until the projects arrive, the card's own key says whose it is (NS-12 is NS's), so no link reads #/p//.
        <CardBody key={card.data.id} card={card.data} projectKey={project?.key ?? card.data.key.slice(0, card.data.key.lastIndexOf('-'))} projectPath={project?.path ?? ''}
          jevMode={project?.jev ?? 'off'} sessionMap={sessionMap} setDialog={setDialog} />
      )}
    </Panel>
  );
}

function CardBody({ card, projectKey, projectPath, jevMode, sessionMap, setDialog }: {
  card: CardDetail;
  projectKey: string;
  projectPath: string;
  jevMode: JevMode;
  sessionMap: ReadonlyMap<string, Session>;
  setDialog: (d: DialogState) => void;
}) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const update = (fields: { title?: string; body?: string; type?: CardType; priority?: Priority }) =>
    attempt(() => call('cards.update', { id: card.id, ...fields }), fail);
  const [tab, setTab] = useState<Tab>('overview');
  const forCard = (_e: unknown, d: unknown): boolean => (d as { cardId?: string }).cardId === card.id;
  const looks = useQuery('live.looks', { cardId: card.id }, ['liveLooks'], (_e, d) => (d as { projectId?: string }).projectId === card.projectId);
  const shots = useQuery('live.shots', { cardId: card.id }, ['liveShots'], forCard);
  const misses = useQuery('live.shotMisses', { cardId: card.id }, ['liveShots'], forCard);
  const tabsId = `card-${card.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const folderAgents = [...sessionMap.values()].filter((s) => s.provider !== 'shell' && LIVE_STATES.has(s.state) && !!projectPath && s.cwd === projectPath);
  const nothingSeen = looks.data?.length === 0 && shots.data?.length === 0 && misses.data?.length === 0;
  const reviewed = card.status === 'review' || card.status === 'done' || card.reviews.length > 0;

  return (
    <div className="drawer-card">
      <EditableText className="drawer-title" label="Title" value={card.title} onSave={(title) => update({ title })} singleLine />
      <p className="drawer-when">Created {ago(card.createdAt)} by {actorName(card.createdBy, sessionMap)}</p>
      <Stages status={card.status} />
      <div className="drawer-actions">
        <StageActions card={card} projectKey={projectKey} setDialog={setDialog} />
      </div>
      <Tabs id={tabsId} label={`About ${card.key}`} value={tab} onChange={setTab} className="drawer-tabs" tabs={[
        { value: 'overview', label: 'Overview' },
        { value: 'review', label: 'Review', count: card.evidence.length || null },
        { value: 'branch', label: 'Branch' },
        { value: 'looks', label: 'Looks', count: looks.data?.length || null },
      ]} />
      <TabPanel tabs={tabsId} value={tab} className="drawer-panel">
        {tab === 'overview' ? (
          <>
            {card.claim || card.reopened || card.sentBack ? (
              <div className="drawer-notes">
                {card.claim ? <ClaimFacts card={card} /> : null}
                {card.reopened ? <p className="drawer-note drawer-note-red">Reopened as not fixed. The newest criterion says what is still wrong.</p> : null}
                {card.sentBack ? <p className="drawer-note">Sent back with changes requested. Your note is in the conversation below.</p> : null}
              </div>
            ) : null}
            <div className="drawer-fields">
              <Section title="Type">
                <Segmented<CardType> label="Type" size="s" value={card.type} onChange={(type) => void update({ type })}
                  options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
              </Section>
              <Section title="Priority">
                <Segmented<Priority> label="Priority" size="s" value={card.priority} onChange={(priority) => void update({ priority })}
                  options={PRIORITIES.map((p) => ({ value: p, label: `P${p}`, hint: p === 0 ? 'Drop everything' : p === 1 ? 'High' : p === 2 ? 'Normal' : 'Low: whenever' }))} />
              </Section>
            </div>
            <Section title="Description">
              <EditableText className="drawer-body" label="Description" value={card.body} placeholder="What needs doing, and why. Agents read this." onSave={(body) => update({ body })} />
            </Section>
            <Criteria card={card} />
            <JevSection card={card} mode={jevMode} />
            <Conversation card={card} sessionMap={sessionMap} />
            <Disclosure title="History" summary={plural(card.activity.length, 'event')} className="drawer-history">
              <ol className="history">
                {card.activity.map((a) => (
                  <li key={a.id}><span className="faint">{ago(a.at)}</span> {actorName(a.actor, sessionMap)} {a.verb}{a.detail ? <span className="faint"> {a.detail}</span> : null}</li>
                ))}
              </ol>
            </Disclosure>
          </>
        ) : tab === 'review' ? (
          <>
            {reviewed ? <AiReviewSection card={card} /> : null}
            {card.evidence.length ? <Evidence card={card} projectPath={projectPath} sessionMap={sessionMap} /> : null}
            {card.sessions.length ? (
              <Section title={`Sessions · ${card.sessions.length}`} actions={<CardTokens cardId={card.id} />}>
                <div className="srows">{card.sessions.map((s) => <SessionRow key={s.id} session={s} projectKey={projectKey} inCard />)}</div>
              </Section>
            ) : null}
            {!reviewed && !card.evidence.length && !card.sessions.length ? (
              <EmptyState icon="check" title="Nothing to review yet">
                When its agent submits the card with evidence, the evidence, the sessions and the AI review are here.
              </EmptyState>
            ) : null}
          </>
        ) : tab === 'branch' ? (
          card.worktree ? <Branch card={card} projectKey={projectKey} folderAgents={folderAgents} />
            : card.status === 'review' || card.status === 'working' ? (
              <>
                <p className="drawer-note">It works in the project folder, not on a branch of its own.</p>
                <ProjectChanges projectId={card.projectId} projectKey={projectKey} />
              </>
            ) : (
              <EmptyState icon="branch" title="No branch of its own">
                Start a session on its own branch, and what it changes, merging it and its pull request are here.
              </EmptyState>
            )
        ) : (
          <>
            <CardShots card={card} />
            <CardLooks card={card} />
            {nothingSeen ? (
              <EmptyState icon="eye" title="Nothing seen in the live view yet">
                What an agent looks at in the live view while it works on this card is listed here, with pictures from before and after.
              </EmptyState>
            ) : null}
          </>
        )}
      </TabPanel>
    </div>
  );
}

function Evidence({ card, projectPath, sessionMap }: { card: CardDetail; projectPath: string; sessionMap: ReadonlyMap<string, Session> }) {
  const files = fileManager(bridge().platform);
  return (
    <Section title={`Evidence · ${card.evidence.length}`}>
      <ul className="evidence">
        {card.evidence.map((e) => (
          <li key={e.id}>
            <Icon name={e.kind === 'file' ? 'file' : e.kind === 'link' ? 'link' : 'note'} size={14} />
            {e.kind === 'link' ? <a href={e.value} target="_blank" rel="noreferrer">{e.value}</a>
              : e.kind === 'file' ? <button type="button" className="linkish mono" onClick={() => void bridge().openPath(e.value)} {...tipProps(`${e.value} · Show in ${files}`)}>{relativeTo(e.value, projectPath)}</button>
                : <span>{e.value}</span>}
            {e.kind === 'file' && e.existed === false ? <span className="flag flag-red">missing when offered</span> : null}
            <span className="faint evidence-by">{actorName(e.addedBy, sessionMap)}, {ago(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
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
    <ol className="stages" aria-label={`Status: ${STATUS_LABEL[status] ?? status}`}>
      {COLUMNS.map((s, i) => (
        <li key={s} className={i < at ? 'past' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="stage-bar" aria-hidden="true" />
          <span className="stage-label">{STATUS_LABEL[s]}</span>
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
  const archive = (): Promise<unknown> => attempt(() => call('cards.move', { id: card.id, status: 'archived' }), fail).then((r) => { if (r) toast(`${card.key} archived.`); });

  if (note) {
    const sendBack = note === 'sendBack';
    return (
      <form className="note-form" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void attempt(() => (sendBack ? call('cards.sendBack', { id: card.id, note: text }) : call('cards.reopen', { id: card.id, stillWrong: text })), fail)
          .then((r) => { if (r) { toast(sendBack ? `${card.key} sent back.` : `${card.key} reopened.`); setNote(null); setText(''); } });
      }}>
        <Field label={sendBack ? 'What should change?' : 'What is still wrong?'}>{(id) => (
          <textarea id={id} value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
            placeholder={sendBack ? 'The agent sees this when it picks the card up again.' : 'This becomes a new acceptance criterion.'} />
        )}</Field>
        <div className="row-gap">
          <Button tone={sendBack ? 'primary' : 'danger'} size="s" type="submit" disabled={!text.trim()}>{sendBack ? 'Send back' : 'Reopen'}</Button>
          <Button tone="quiet" size="s" onClick={() => setNote(null)}>Cancel</Button>
        </div>
      </form>
    );
  }

  // A card sent back or reopened may still have its agent running: open that, never start a second.
  const terminal = cardTerminal(card);
  const open = (tone: 'primary' | 'plain'): ReactNode => (terminal.kind === 'open'
    ? <a className={`btn btn-${tone} btn-s`} href={href({ name: 'session', projectKey, sessionId: terminal.sessionId })}><Icon name="terminal" size={14} /><span>Open terminal</span></a>
    : null);
  switch (card.status) {
    case 'inbox':
      return (
        <>
          <Button tone="primary" size="s" icon="check" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'ready' }), fail)}>Accept to Ready</Button>
          {open('plain') ?? <Button size="s" icon="terminal" onClick={start}>Start a session</Button>}
          <Button tone="quiet" size="s" onClick={archive}>Archive</Button>
        </>
      );
    case 'ready':
      return (
        <>
          {open('primary') ?? <Button tone="primary" size="s" icon="terminal" onClick={start}>Start a session</Button>}
          <Button tone="quiet" size="s" onClick={archive}>Archive</Button>
        </>
      );
    case 'working':
      return (
        <>
          {open('primary') ?? <span className="faint small">Held by a session that is not running.</span>}
          <Button tone="quiet" size="s" onClick={() => attempt(() => call('cards.release', { id: card.id, note: 'Taken back by the owner' }), fail)}>Take back</Button>
        </>
      );
    case 'review':
      return (
        <>
          <Button tone="primary" size="s" icon="check" onClick={() => attempt(() => call('cards.approve', { id: card.id }), fail).then((r) => { if (r) { toast(`${card.key} approved.`, 'done'); orbPlay(document.querySelector('.rail-orb'), 'burst'); } })}>Approve</Button>
          <Button size="s" onClick={() => setNote('sendBack')}>Send back…</Button>
        </>
      );
    case 'done':
      return (
        <>
          <Button size="s" icon="reopen" onClick={() => setNote('reopen')}>Reopen as not fixed…</Button>
          <Button tone="quiet" size="s" onClick={archive}>Archive</Button>
        </>
      );
    default:
      return <span className="faint small">Archived.</span>;
  }
}

function Criteria({ card }: { card: CardDetail }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const { text, setText, clear } = useDraft();
  const once = useSingleFlight();
  const done = card.criteria.filter((c) => c.done).length;
  return (
    <Section title={card.criteria.length ? `Acceptance criteria · ${done} of ${card.criteria.length}` : 'Acceptance criteria'}>
      {card.criteria.length ? (
        <ul className="criteria">
          {card.criteria.map((c) => (
            <li key={c.id} className={c.done ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={c.done} onChange={(e) => void attempt(() => call('criteria.update', { id: c.id, done: e.target.checked }), fail)} />
                <span>{c.text}</span>
              </label>
              <IconButton icon="close" size="s" label={`Remove “${c.text}”`} onClick={() => attempt(() => call('criteria.remove', { id: c.id }), fail)} />
            </li>
          ))}
        </ul>
      ) : null}
      <form className="inline-add" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void once(() => attempt(() => call('criteria.add', { cardId: card.id, text }), fail).then((r) => { if (r) clear(); }));
      }}>
        <label className="visually-hidden" htmlFor="criterion-new">New criterion</label>
        <input id="criterion-new" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={card.criteria.length ? 'Add a criterion, then Enter' : 'What has to be true for it to be done, then Enter'} />
      </form>
    </Section>
  );
}

function Conversation({ card, sessionMap }: { card: CardDetail; sessionMap: ReadonlyMap<string, Session> }) {
  const toast = useToast();
  const { text, setText, clear } = useDraft();
  const once = useSingleFlight();
  const mac = isMac();
  const open = card.comments.some((c) => c.kind === 'question' && !c.resolved);
  return (
    <Section title={card.comments.length ? `Conversation · ${card.comments.length}` : 'Conversation'}>
      {card.comments.length ? (
        <ol className="comments">
          {card.comments.map((c) => {
            const question = c.kind === 'question';
            return (
              <li key={c.id} className={`comment${question && !c.resolved ? ' question' : ''}`}>
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
        <Button type="submit" size="s" disabled={!text.trim()}>{open ? 'Answer' : 'Comment'}</Button>
      </form>
    </Section>
  );
}

/** Text that reads as text until clicked, then edits in place. Saves on blur or ⌘↩; Escape puts it back. */
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
