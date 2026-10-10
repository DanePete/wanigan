// Writing notes on the live page and sending them to an agent: the box under a
// chosen part, the list of notes waiting (the dock's Notes tab, with the words
// saved by hand), and the one message they become.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LayerSnapshot } from '@shared/design-layer';
import type { LiveComponent, LiveEdit } from '@shared/live';
import type { ProjectSummary, Session } from '@shared/model';
import { nameOf } from '@shared/live-names';
import { isAddKey, isSendKey } from '@shared/live-keys';
import { keyLabel } from '@shared/shortcuts';
import { attempt, bridge, call, forProject, useQuery } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { heldInLayer } from '../../lib/live-layer';
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

/**
 * Queue notes to a session as one message, each part's picture attached in
 * order. True once queued: `attempt` answers undefined only for a failure, so
 * a send that answered nothing would read as one that failed.
 */
async function send(notes: readonly LiveNote[], to: Session, components: Map<string, LiveComponent>): Promise<true> {
  const ids: string[] = [];
  const save = async (name: string, data: string): Promise<void> => { ids.push((await call('attachments.save', { to: { session: to.id }, name, data })).id); };
  for (const [i, n] of notes.entries()) {
    // A snap's picture, or a part's; then the order wanted; then a recording's key frames (pictures only: never its video).
    if (n.shot) await save(n.kind === 'snap' ? `live-snap-${i + 1}.png` : `live-note-${i + 1}.png`, n.shot);
    if (n.shot && n.after) await save(`live-note-${i + 1}-wanted.png`, n.after);
    for (const [k, frame] of (n.frames ?? []).entries()) await save(`live-recording-${i + 1}-frame-${k + 1}.jpg`, frame);
  }
  await call('sessions.queue', { id: to.id, text: notesText(notes, (id) => components.get(id)?.dir ?? null), attachments: ids });
  return true;
}

/** Who notes go to: the session followed, or the one asked for, else the project's only agent. */
function SendTo({ agents, value, onChange }: { agents: Session[]; value: string; onChange: (id: string) => void }) {
  if (agents.length < 2) return null;
  return <Select<string> label="Send to" size="s" value={value} onChange={onChange} options={agents.map((s) => ({ value: s.id, label: sessionLabel(s) }))} />;
}

/** What a snap or a recording hands the composer: its pictures, the words it fills in, and what is said about it. */
export interface ComposeWith {
  kind: 'snap' | 'recording';
  /** The marked-up picture (a snap's), PNG base64. */
  shot?: string | null;
  /** Key frames (a recording's), JPEG base64, in time order. */
  frames?: string[];
  /** The context it fills in: shown, and the owner's to edit. */
  context: string;
  /** Said under the boxes: what an agent gets (a recording: no video). */
  notice?: ReactNode;
}

/**
 * The box under a chosen part: what should change, kept as a note or sent at
 * once. A change tried by hand (new words, a style) rides along in the draft.
 * A snap or a recording opens it `with` its pictures and context: the owner's
 * explanation goes first, the context (theirs to edit) under it, and `voice`
 * sits beside the explanation box (where voice input goes; empty until it is
 * built).
 */
export function NoteComposer({ project, draft, components, prefer, compact = false, picture = true, with: given, voice, onDone }: {
  project: ProjectSummary;
  draft: Draft;
  components: Map<string, LiveComponent>;
  prefer: string | null;
  compact?: boolean;
  /** Attach a picture of the view: false when the view shows another page than the one the note is about. */
  picture?: boolean;
  /** A snap's or a recording's pictures and context, in place of a picture of the view. */
  with?: ComposeWith;
  /** A control beside the explanation box: voice input. */
  voice?: ReactNode;
  onDone?: () => void;
}) {
  const toast = useToast();
  const agents = useAgents(project);
  const [text, setText] = useState('');
  const [context, setContext] = useState(given?.context ?? '');
  const [to, setTo] = useState(prefer ?? '');
  const target = agents.find((s) => s.id === to) ?? agents.find((s) => s.id === prefer) ?? agents[0];
  const mac = bridge().platform === 'darwin';
  const hasChange = !!draft.words || draft.style.length > 0;
  const ready = text.trim().length > 0 || hasChange || (!!given && context.trim().length > 0);
  const said = (): string => (given ? [text.trim(), context.trim()].filter(Boolean).join('\n\n') : text.trim());

  const note = async (): Promise<LiveNote> => (given
    ? { ...draft, text: said(), kind: given.kind, shot: given.shot ?? null, frames: given.frames ?? [], id: '', at: Date.now() }
    : { ...draft, text: text.trim(), shot: picture ? await liveBridge()?.capture() ?? null : null, id: '', at: Date.now() });
  const keep = async (): Promise<void> => {
    if (!ready) return;
    const n = await note();
    addNote(project.id, n);
    setText('');
    toast(given ? `Saved to Notes, ${given.kind === 'snap' ? 'with the picture' : `with ${given.frames?.length ?? 0} key frames`}. Send it from the Notes tab.`
      : 'Added to the notes. Send them together from the Notes tab.');
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

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // ⇧⌘↩ sends it now (the live view's key for sending); ⌘↩ keeps it with the others.
    if (isSendKey(e, mac)) { e.preventDefault(); e.stopPropagation(); if (agents.length) void now(); else toast(`Start a session in ${project.name} to send it.`, 'error'); }
    else if (isAddKey(e, mac)) { e.preventDefault(); void keep(); }
  };
  const chord = (...k: string[]): string => k.map((x) => keyLabel(x, mac)).join(mac ? '' : '+');
  const explain = (
    <textarea aria-label={given ? 'What is wrong, in your words' : 'What should change here?'} rows={compact ? 1 : 3} value={text}
      placeholder={given ? `Explain what is wrong${given.kind === 'recording' ? ' and what you expected' : ''}` : hasChange ? 'Anything to add? (optional)' : 'What should change here?'}
      onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
  );
  return (
    <form className={`live-compose${compact ? ' compact' : ''}${given ? ' with' : ''}`} onSubmit={(e) => { e.preventDefault(); void keep(); }}>
      {given ? (
        <>
          {/* The explanation, with voice input's place beside it (data-slot="voice"). */}
          <div className="live-compose-say">
            {explain}
            <div className="live-compose-voice" data-slot="voice">{voice}</div>
          </div>
          <label className="live-compose-context">
            <span className="small faint">Sent with it, yours to edit</span>
            <textarea aria-label="Context sent with it" rows={8} value={context} spellCheck={false} className="mono"
              onChange={(e) => setContext(e.target.value)} onKeyDown={keys} />
          </label>
          {given.notice ? <p className="small faint live-compose-notice">{given.notice}</p> : null}
        </>
      ) : explain}
      <div className="live-compose-actions">
        <Button size="s" tone="primary" type="submit" icon="note" disabled={!ready} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
          title={`${chord('Mod', 'Enter')} ${given ? 'saves it to Notes without sending' : 'adds it to the notes'}`}>{given ? 'Save to Notes' : 'Add to notes'}</Button>
        {agents.length ? (
          <>
            <SendTo agents={agents} value={target?.id ?? ''} onChange={setTo} />
            <Button size="s" tone="quiet" icon="send" disabled={!ready} onClick={now}>
              {agents.length > 1 ? 'Send now' : `Send to ${target?.cardKey ?? 'the session'} now`}
            </Button>
          </>
        ) : null}
      </div>
      {given ? (
        <p className="faint small">
          {chord('Mod', 'Enter')} saves it to Notes{agents.length ? <>, {chord('Shift', 'Mod', 'Enter')} sends it now</> : null}.
          {agents.length ? '' : ` Start a session in ${project.name} to send it; until then it waits in Notes.`}
        </p>
      ) : !compact ? (
        <p className="faint small">
          {keyLabel('Mod', mac)}{mac ? '' : '+'}{keyLabel('Enter', mac)} adds it{agents.length ? <>, {keyLabel('Shift', mac)}{mac ? '' : '+'}{keyLabel('Mod', mac)}{mac ? '' : '+'}{keyLabel('Enter', mac)} sends it now</> : null}. Notes go to an agent together, with a picture of each part.
          {agents.length ? '' : ` Start a session in ${project.name} to send them.`}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Sending the notes waiting: to the session chosen in the Notes tab, else the
 * one followed, else the project's only agent. The tab's Send button and the
 * live view's ⇧⌘↩ both use it, so they send the same notes to the same place.
 */
export function useNotesSender(project: ProjectSummary, components: Map<string, LiveComponent>, prefer: string | null) {
  const toast = useToast();
  const notes = useNotes(project.id);
  const agents = useAgents(project);
  const [to, setTo] = useState(prefer ?? '');
  const target = agents.find((s) => s.id === to) ?? agents.find((s) => s.id === prefer) ?? agents[0];
  const sendAll = async (): Promise<void> => {
    if (!notes.length) { toast('No notes are waiting to be sent.'); return; }
    if (!target) { toast(`Start a session in ${project.name} to send the notes.`, 'error'); return; }
    const ok = await attempt(() => send(notes, target, components), (m) => toast(m, 'error'));
    if (ok === undefined) return;
    clearNotes(project.id);
    toast(`Sent ${notes.length === 1 ? 'the note' : `${notes.length} notes`} to ${target.cardKey ?? target.title}. They arrive when the agent is next idle.`);
  };
  return { notes, agents, target, setTo, sendAll };
}

/** The notes waiting to be sent, and sending them. */
export function NotesTab({ project, components, sender, onShow }: {
  project: ProjectSummary;
  components: Map<string, LiveComponent>;
  sender: ReturnType<typeof useNotesSender>;
  /** Point at a note's part on the page (null: stop). */
  onShow: (note: LiveNote | null) => void;
}) {
  const { notes, agents, target, setTo, sendAll } = sender;
  const mac = bridge().platform === 'darwin';

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
                  {n.kind ? <Icon name={n.kind === 'snap' ? 'camera' : 'record'} size={13} /> : name ? <Icon name={KIND_ICON[name.icon]} size={13} /> : null}
                  {n.kind === 'snap' ? 'Snap' : n.kind === 'recording' ? `Recording, ${n.frames?.length ?? 0} key ${n.frames?.length === 1 ? 'frame' : 'frames'}` : name?.title ?? n.pick?.tag ?? 'Part'}
                </span>
                {/* A snap's or a recording's words run long (its context, its step log): their first line here. */}
                {n.text ? <span className="small">{n.kind ? n.text.split('\n')[0] : n.text}</span> : null}
                {n.words ? <span className="small faint">“{n.words.before}” → “{n.words.after}”</span> : null}
                {n.style.length ? <span className="small faint">{n.style.map((s) => `${s.property} ${s.to}`).join(' · ')}</span> : null}
              </div>
              {n.shot ? <img className="live-note-shot" src={`data:image/png;base64,${n.shot}`} alt="" />
                : n.frames?.[0] ? <img className="live-note-shot" src={`data:image/jpeg;base64,${n.frames[0]}`} alt="" /> : null}
              <IconButton icon="close" label={`Remove note ${i + 1}`} onClick={() => removeNote(project.id, n.id)} />
            </li>
          );
        })}
      </ol>
      {agents.length ? (
        <div className="live-send">
          <SendTo agents={agents} value={target?.id ?? ''} onChange={setTo} />
          <Button size="s" tone="primary" icon="send" onClick={sendAll} aria-keyshortcuts={mac ? 'Shift+Meta+Enter' : 'Shift+Control+Enter'}
            title={`${keyLabel('Shift', mac)}${keyLabel('Mod', mac)}${keyLabel('Enter', mac)} sends them from anywhere in the live view`}>
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

/**
 * Words saved by hand to templates, newest first, each put back with one click while the file is as it left it, and
 * while the design layer does not hold them as in the site (`layer`: the project's layer).
 */
export function EditsList({ project, layer }: { project: ProjectSummary; layer: LayerSnapshot | null }) {
  const toast = useToast();
  const edits = useQuery('live.edits', { projectId: project.id }, ['liveEdits'], (_e, d) => (d as { projectId?: string }).projectId === project.id);
  const list = (edits.data ?? []).slice(0, 8);
  if (!list.length) return null;
  const revert = async (e: LiveEdit): Promise<void> => {
    const done = await attempt(() => call('live.revert', { id: e.id }), (m) => toast(m, 'error'));
    if (done) { toast(`Put back “${e.before}”.`); void liveBridge()?.reload(); }
  };
  return (
    <div className="live-side-block live-edits">
      <h3 className="live-section-title">Saved by hand</h3>
      <ul className="live-made">
        {list.map((e) => (
          <li key={e.id}>
            <span className="small">“{e.before}” → “{e.after}”</span>
            <span className="mono small faint" title={e.path}>{e.path.split('/').pop() ?? e.path}:{e.line}</span>
            {e.revertedAt ? <span className="faint small">Put back</span>
              // The core never takes an edit in the site back out of the layer: put back, the layer would say the site has these words.
              : heldInLayer(e, layer) ? <span className="faint small">In the design layer as in the site, which it never takes back: put back by hand</span>
              : e.revertable ? <Button size="s" tone="quiet" icon="undo" onClick={() => revert(e)}>Put back</Button>
                : <span className="faint small">Changed since: put back by hand</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
