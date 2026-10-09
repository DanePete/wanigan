// Writing notes on the live page and sending them to an agent: the box under a
// chosen part, the list of notes waiting, and the one message they become.
import { useState } from 'react';
import type { LiveComponent } from '@shared/live';
import type { ProjectSummary, Session } from '@shared/model';
import { nameOf } from '@shared/live-names';
import { keyLabel } from '@shared/shortcuts';
import { attempt, bridge, call, forProject, useQuery } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { Select } from '../Select';
import { Button, IconButton, useToast } from '../ui';
import { Icon } from '../icons';
import { KIND_ICON } from './Layers';
import { addNote, clearNotes, notesText, removeNote, useNotes, type LiveNote } from './note-store';

type Draft = Omit<LiveNote, 'id' | 'at' | 'text' | 'shot'>;

/** The project's agent sessions that can take a message now. */
function useAgents(project: ProjectSummary): Session[] {
  const sessions = useQuery('sessions.list', { projectId: project.id, live: true }, ['sessions'], forProject(project.id));
  return (sessions.data ?? []).filter((s) => s.provider !== 'shell');
}

const sessionLabel = (s: Session): string => (s.cardKey ? `${s.cardKey} · ${s.title}` : s.title);

/** Queue notes to a session as one message, each part's picture attached in order. */
async function send(notes: readonly LiveNote[], to: Session, components: Map<string, LiveComponent>): Promise<void> {
  const ids: string[] = [];
  for (const [i, n] of notes.entries()) {
    if (!n.shot) continue;
    ids.push((await call('attachments.save', { to: { session: to.id }, name: `live-note-${i + 1}.png`, data: n.shot })).id);
    if (n.after) ids.push((await call('attachments.save', { to: { session: to.id }, name: `live-note-${i + 1}-wanted.png`, data: n.after })).id);
  }
  await call('sessions.queue', { id: to.id, text: notesText(notes, (id) => components.get(id)?.dir ?? null), attachments: ids });
}

/** Who notes go to: the session followed, or the one asked for, else the project's only agent. */
function SendTo({ agents, value, onChange }: { agents: Session[]; value: string; onChange: (id: string) => void }) {
  if (agents.length < 2) return null;
  return <Select<string> label="Send to" size="s" value={value} onChange={onChange} options={agents.map((s) => ({ value: s.id, label: sessionLabel(s) }))} />;
}

/**
 * The box under a chosen part: what should change, kept as a note or sent at
 * once. A change tried by hand (new words, a style) rides along in the draft.
 */
export function NoteComposer({ project, draft, components, prefer, compact = false, onDone }: {
  project: ProjectSummary;
  draft: Draft;
  components: Map<string, LiveComponent>;
  prefer: string | null;
  compact?: boolean;
  onDone?: () => void;
}) {
  const toast = useToast();
  const agents = useAgents(project);
  const [text, setText] = useState('');
  const [to, setTo] = useState(prefer ?? '');
  const target = agents.find((s) => s.id === to) ?? agents.find((s) => s.id === prefer) ?? agents[0];
  const mac = bridge().platform === 'darwin';
  const hasChange = !!draft.words || draft.style.length > 0;
  const ready = text.trim().length > 0 || hasChange;

  const note = async (): Promise<LiveNote> => ({ ...draft, text: text.trim(), shot: await liveBridge()?.capture() ?? null, id: '', at: Date.now() });
  const keep = async (): Promise<void> => {
    if (!ready) return;
    const n = await note();
    addNote(project.id, n);
    setText('');
    toast('Added to the notes. Send them together from the Notes tab.');
    onDone?.();
  };
  const now = async (): Promise<void> => {
    if (!ready || !target) return;
    const n = await note();
    const ok = await attempt(() => send([n], target, components), (m) => toast(m, 'error'));
    if (ok === undefined) return;
    setText('');
    toast(`Sent to ${target.cardKey ?? target.title}. It arrives when the agent is next idle.`);
    onDone?.();
  };

  return (
    <form className={`live-compose${compact ? ' compact' : ''}`} onSubmit={(e) => { e.preventDefault(); void keep(); }}>
      <textarea aria-label="What should change here?" rows={compact ? 1 : 3} value={text}
        placeholder={hasChange ? 'Anything to add? (optional)' : 'What should change here?'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void keep(); }
        }} />
      <div className="live-compose-actions">
        <Button size="s" tone="primary" type="submit" icon="note" disabled={!ready}>Add to notes</Button>
        {agents.length ? (
          <>
            <SendTo agents={agents} value={target?.id ?? ''} onChange={setTo} />
            <Button size="s" tone="quiet" icon="send" disabled={!ready} onClick={now}>
              {agents.length > 1 ? 'Send now' : `Send to ${target?.cardKey ?? 'the session'} now`}
            </Button>
          </>
        ) : null}
      </div>
      {!compact ? (
        <p className="faint small">
          {keyLabel('Mod', mac)}{mac ? '' : '+'}{keyLabel('Enter', mac)} adds it. Notes go to an agent together, with a picture of each part.
          {agents.length ? '' : ` Start a session in ${project.name} to send them.`}
        </p>
      ) : null}
    </form>
  );
}

/** The notes waiting to be sent, and sending them. */
export function NotesTab({ project, components, prefer, onShow }: {
  project: ProjectSummary;
  components: Map<string, LiveComponent>;
  prefer: string | null;
  /** Point at a note's part on the page (null: stop). */
  onShow: (note: LiveNote | null) => void;
}) {
  const toast = useToast();
  const notes = useNotes(project.id);
  const agents = useAgents(project);
  const [to, setTo] = useState(prefer ?? '');
  const target = agents.find((s) => s.id === to) ?? agents.find((s) => s.id === prefer) ?? agents[0];

  if (!notes.length) {
    return (
      <div className="live-side-block">
        <p className="small">No notes yet.</p>
        <p className="faint small">
          Choose a part (or Pick one on the page), say what should change, and Add to notes. Collect as many as you like across pages, then send them to
          an agent as one message, each with a picture of its part.
        </p>
      </div>
    );
  }

  const sendAll = async (): Promise<void> => {
    if (!target) return;
    const ok = await attempt(() => send(notes, target, components), (m) => toast(m, 'error'));
    if (ok === undefined) return;
    clearNotes(project.id);
    toast(`Sent ${notes.length === 1 ? 'the note' : `${notes.length} notes`} to ${target.cardKey ?? target.title}. They arrive when the agent is next idle.`);
  };

  return (
    <div className="live-side-block">
      <ol className="live-notes" onMouseLeave={() => onShow(null)}>
        {notes.map((n, i) => {
          const inner = n.regions[0];
          const name = inner ? nameOf(inner, inner.component ? components.get(inner.component)?.name ?? null : null) : null;
          return (
            <li key={n.id} className="live-note-item" onMouseEnter={() => onShow(n)}>
              <span className="live-note-num" aria-hidden="true">{i + 1}</span>
              <div className="live-note-body">
                <span className="live-note-what">
                  {name ? <Icon name={KIND_ICON[name.icon]} size={13} /> : null}
                  {name?.title ?? n.pick?.tag ?? 'Part'}
                </span>
                {n.text ? <span className="small">{n.text}</span> : null}
                {n.words ? <span className="small faint">“{n.words.before}” → “{n.words.after}”</span> : null}
                {n.style.length ? <span className="small faint">{n.style.map((s) => `${s.property} ${s.to}`).join(' · ')}</span> : null}
              </div>
              {n.shot ? <img className="live-note-shot" src={`data:image/png;base64,${n.shot}`} alt="" /> : null}
              <IconButton icon="close" label={`Remove note ${i + 1}`} onClick={() => removeNote(project.id, n.id)} />
            </li>
          );
        })}
      </ol>
      {agents.length ? (
        <div className="live-send">
          <SendTo agents={agents} value={target?.id ?? ''} onChange={setTo} />
          <Button size="s" tone="primary" icon="send" onClick={sendAll}>
            Send {notes.length === 1 ? 'the note' : `${notes.length} notes`}{agents.length > 1 ? '' : ` to ${target?.cardKey ?? target?.title ?? 'the session'}`}
          </Button>
          <Button size="s" tone="quiet" onClick={() => clearNotes(project.id)}>Clear</Button>
        </div>
      ) : (
        <p className="faint small">Start a session in {project.name} to send these. They wait here until then (while Wanigan stays open).</p>
      )}
    </div>
  );
}

/** A note for a part with nothing tried by hand yet. */
export function draftFor(url: string, selection: { regions: Draft['regions']; pick: Draft['pick'] }): Draft {
  return { url, regions: selection.regions, pick: selection.pick, words: null, style: [] };
}
