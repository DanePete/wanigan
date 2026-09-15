import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STALE_LABEL, changeNoteLocation, type ChangeNoteView, type ChangeNotesForReview,
} from '@shared/change-notes';
import { Mark, Note } from './bits';
import '../styles/agent-notes.css';

/**
 * Agent change notes in the code rail (helper sweep · P10): what the session
 * wrote about its own diff, beside the operator's review notes and never mixed
 * with them. Every note carries the same mark — a glyph and the words "written
 * by the agent" — and the session's title, so nothing an agent wrote can be
 * read as something the operator said. The operator can dismiss one, or copy
 * it into a review note of their own; the copy says it quotes the agent.
 */

const POLL_MS = 6_000;

/** The session's notes, re-read on the review's slow beat while the Changes tab is open, and at once on request. */
export function useChangeNotes(sessionId: string | undefined, enabled: boolean, refreshKey: string) {
  const [data, setData] = useState<ChangeNotesForReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!sessionId) { setData(null); return; }
    const ticket = ++seq.current;
    try {
      const next = await window.wanigan.changeNotes.list(sessionId);
      if (ticket !== seq.current) return;
      setData(next); setError(null);
    } catch (e) {
      if (ticket !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);
  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, POLL_MS);
    return () => { window.clearInterval(t); seq.current += 1; };
  }, [reload, enabled, refreshKey]);
  useEffect(() => { setData(null); setError(null); }, [sessionId]);
  return { data, error, reload };
}

/** The mark every agent note carries, wherever it is shown. */
export function WrittenByAgent({ title }: { title: string }) {
  return (
    <span className="an-by">
      <Mark glyph="✦" word="written by the agent" tone="accent" />
      <span className="an-title">{title}</span>
    </span>
  );
}

function StaleMark({ note }: { note: ChangeNoteView }) {
  if (!note.staleness.stale) return null;
  return <span className="an-stale"><Mark glyph="△" word={STALE_LABEL} tone="warn" /> <span className="faint">{note.staleness.because}</span></span>;
}

/** The count line above the file list, with the walk and the full list one click away. */
export function AgentNotesBar({ data, error, onWalk, onOpen }: {
  data: ChangeNotesForReview | null;
  error: string | null;
  onWalk: () => void;
  onOpen: (note: ChangeNoteView) => void;
}) {
  if (error && !data) return <div className="an-bar"><Note tone="error">The agent's notes could not be read: {error}</Note></div>;
  if (!data || (data.notes.length === 0 && data.withdrawn === 0)) return null;
  const open = data.notes.filter((n) => n.dismissedAt === null);
  const stale = open.filter((n) => n.staleness.stale).length;
  const dismissed = data.notes.length - open.length;
  return (
    <section className="an-bar" aria-label="The agent's notes">
      <div className="an-bar-line">
        <Mark glyph="✦" word={`${open.length} note${open.length === 1 ? '' : 's'} written by the agent`} tone="accent" />
        {stale > 0 && <Mark glyph="△" word={`${stale} where the code changed since`} tone="warn" />}
        {dismissed > 0 && <span className="faint">{dismissed} dismissed</span>}
        {data.withdrawn > 0 && <span className="faint">{data.withdrawn} withdrawn by the agent</span>}
        <button type="button" className="btn btn-sm an-walk-start" disabled={open.length === 0} onClick={onWalk}>
          Walk the agent's notes
        </button>
      </div>
      {data.notes.length > 0 && (
        <details className="an-list">
          <summary>All notes from {data.sessionTitle}, in file order</summary>
          <ol>
            {data.notes.map((n) => (
              <li key={n.id}>
                <button type="button" className="an-list-item" onClick={() => onOpen(n)}>
                  <span className="mono">{n.path}</span> <span className="faint">{changeNoteLocation(n)}</span>
                  {n.dismissedAt !== null && <> <Mark glyph="–" word="dismissed" tone="dead" /></>}
                  {n.staleness.stale && <> <Mark glyph="△" word={STALE_LABEL} tone="warn" /></>}
                  <span className="an-list-body">{n.body.split('\n')[0]}</span>
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** One note inside the diff, under the last line it covers. */
export function AgentNoteInline({ note, title, current, onDismiss, onQuote }: {
  note: ChangeNoteView;
  title: string;
  /** The note the walk is on: brought into view and outlined. */
  current: boolean;
  onDismiss: (note: ChangeNoteView) => void;
  onQuote: (note: ChangeNoteView) => void;
}) {
  const el = useRef<HTMLElement>(null);
  useEffect(() => { if (current) el.current?.scrollIntoView({ block: 'center' }); }, [current]);
  return (
    <aside ref={el} className={`an-inline${current ? ' an-current' : ''}${note.staleness.stale ? ' an-is-stale' : ''}`}
           aria-label={`Note written by the agent on ${note.path}, ${changeNoteLocation(note)}`} data-agent-note={note.id}>
      <div className="an-inline-top">
        <WrittenByAgent title={title} />
        <span className="an-where">{changeNoteLocation(note)}</span>
      </div>
      <StaleMark note={note} />
      <p className="an-body">{note.body}</p>
      <div className="an-actions">
        {note.quotedAt !== null
          ? <Mark glyph="✓" word="quoted into your review notes" tone="ok" />
          : <button type="button" className="btn btn-sm" onClick={() => onQuote(note)}>Make it my review note</button>}
        <button type="button" className="btn btn-sm" onClick={() => onDismiss(note)}>Dismiss note</button>
      </div>
    </aside>
  );
}

/** Notes whose lines are not in the diff on screen any more, listed above it rather than lost. */
export function DetachedAgentNotes({ notes, title, onDismiss, onQuote, currentId }: {
  notes: readonly ChangeNoteView[];
  title: string;
  onDismiss: (note: ChangeNoteView) => void;
  onQuote: (note: ChangeNoteView) => void;
  currentId: string | null;
}) {
  if (!notes.length) return null;
  return (
    <div className="an-detached">
      <p className="an-detached-lead faint">
        {notes.length === 1 ? 'This note points at lines' : `These ${notes.length} notes point at lines`} this diff no longer shows.
      </p>
      {notes.map((n) => <AgentNoteInline key={n.id} note={n} title={title} current={currentId === n.id} onDismiss={onDismiss} onQuote={onQuote} />)}
    </div>
  );
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'j', 'n']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'k', 'p']);

/**
 * "Walk the agent's notes": one note at a time in file and line order, the
 * file's diff opened at its hunk below. The region takes focus when the walk
 * starts, so the arrow keys, j/k or n/p step through and Escape ends it.
 */
export function AgentNotesWalk({ notes, index, title, onStep, onEnd }: {
  notes: readonly ChangeNoteView[];
  index: number;
  title: string;
  onStep: (next: number) => void;
  onEnd: () => void;
}) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus(); }, []);
  const note = notes[index];
  if (!note) return null;
  const step = (delta: number) => { const next = index + delta; if (next >= 0 && next < notes.length) onStep(next); };
  return (
    <section ref={region} tabIndex={-1} className="an-walk" aria-label="Walking the agent's notes" aria-roledescription="guided walk"
             onKeyDown={(e) => {
               if (e.metaKey || e.ctrlKey || e.altKey) return;
               const target = e.target as HTMLElement;
               if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
               // Handled keys stop here, so Escape ends the walk and not whatever surface holds the rail.
               if (NEXT_KEYS.has(e.key)) { e.preventDefault(); e.stopPropagation(); step(1); }
               else if (PREVIOUS_KEYS.has(e.key)) { e.preventDefault(); e.stopPropagation(); step(-1); }
               else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEnd(); }
             }}>
      <div className="an-walk-line">
        <strong role="status">Note {index + 1} of {notes.length}</strong>
        <span className="mono an-walk-path">{note.path}</span>
        <span className="faint">{changeNoteLocation(note)}</span>
        <span className="an-walk-nav">
          <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => step(-1)} aria-keyshortcuts="ArrowLeft K P">← Previous</button>
          <button type="button" className="btn btn-sm" disabled={index === notes.length - 1} onClick={() => step(1)} aria-keyshortcuts="ArrowRight J N">Next →</button>
          <button type="button" className="btn btn-sm" onClick={onEnd} aria-keyshortcuts="Escape">End walk</button>
        </span>
      </div>
      <WrittenByAgent title={title} />
      <StaleMark note={note} />
      <p className="an-body">{note.body}</p>
      <p className="an-walk-keys faint">← → or j k to step · Esc ends the walk</p>
    </section>
  );
}
