// One changed file's diff: syntax colour, unified or side by side, notes on
// lines for the agent, and a Viewed box that folds the file away. Reads the
// diff itself, so any view can show one file's changes with just its props.
// In the git workbench it also carries the file's actions, each hunk's, and a
// column of boxes for picking lines to stage, unstage or discard.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { ChangedFile } from '@shared/model';
import type { DiffArea } from '@shared/git';
import { diffHash, highlightDiff, noteTarget, parseDiff, pieces, splitRows, type DiffLine } from '@shared/diff';
import type { ReviewNote } from '@shared/review-notes';
import { bridge, useQuery } from '../lib/api';
import { keyLabel } from '@shared/shortcuts';
import { Icon } from './icons';
import { Button } from './ui';

export const STATUS_LABEL: Record<ChangedFile['status'], string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'New, untracked', U: 'Conflicted' };

export type DiffLayout = 'unified' | 'split';

type Target = { line: number; side: 'new' | 'old' };
const keyOf = (t: Target): string => `${t.side}:${t.line}`;

/** A changed line's key for picking: a removed line by its old number, an added one by its new. */
export const pickKey = (l: DiffLine): string | null => (l.kind === 'add' ? `n${l.new}` : l.kind === 'del' ? `o${l.old}` : null);

/** Lines picked in the workbench, and how to change the pick. */
export interface LinePicking {
  picked: ReadonlySet<string>;
  /** Pick (or unpick) these lines: one, or a Shift-click range from the last one clicked. */
  onPick: (keys: string[], on: boolean) => void;
}

/** A hunk's changed lines as the core picks them: removed lines by old number, added by new. */
export interface HunkPick { old: number[]; new: number[] }

export function FileDiff({
  projectId, cardId, file, notes, onAdd, onRemove, layout = 'unified', viewed, onViewed, onDigest, load = true, given,
  area, from, actions, hunkActions: givenHunkActions, pick, note,
}: {
  projectId: string; cardId: string | null; file: ChangedFile;
  /** Without `onAdd`, lines take no notes. */
  notes: ReviewNote[]; onAdd?: (note: ReviewNote) => void; onRemove: (note: ReviewNote) => void;
  /** One column, or the old file and the new side by side. */
  layout?: DiffLayout;
  /** When given, the header has a Viewed box, and a viewed file shows only its header. */
  viewed?: boolean;
  onViewed?: (viewed: boolean) => void;
  /** Told the diff's fingerprint whenever it is read, so a viewed mark can be checked against it. */
  onDigest?: (digest: string) => void;
  /** False while the file is far off screen: its diff is not read until it comes near. */
  load?: boolean;
  /** The diff, when the caller already has it (a session's turn); otherwise it is read from the folder. */
  given?: { path: string; diff: string; truncated: boolean };
  /** Read from the git workbench: what is staged, what is not, a new file, a conflict, or a card's commits. */
  area?: DiffArea;
  /** Where a renamed file came from, so its staged diff is read as a rename. */
  from?: string | null;
  /** The file's own buttons, in its header. */
  actions?: ReactNode;
  /** Buttons on a hunk's header, given its changed lines. */
  hunkActions?: (hunk: HunkPick) => ReactNode;
  /** Boxes on changed lines for picking them. */
  pick?: LinePicking;
  /** A line under the header: who changed the file, say. */
  note?: ReactNode;
}) {
  const reading = load && !given;
  const folder = useQuery('projects.diff', reading && !area ? { id: projectId, path: file.path, cardId } : null, ['sessions'],
    (_e, d) => (d as { projectId?: string })?.projectId === projectId);
  const workbench = useQuery('git.diff', reading && area ? { id: projectId, cardId, path: file.path, area, ...(from ? { from } : {}) } : null, ['sessions', 'git'],
    (_e, d) => (d as { projectId?: string })?.projectId === projectId);
  const read = area ? workbench : folder;
  const diff = given ? { data: given, error: null } : read;
  const text = diff.data?.diff;
  const lines = useMemo(() => highlightDiff(parseDiff(text ?? ''), file.path), [text, file.path]);
  /** Each hunk header's changed lines, as the core picks them. */
  const hunkOf = useMemo(() => {
    const m = new Map<DiffLine, HunkPick>();
    let current: HunkPick = { old: [], new: [] };
    for (const l of lines) {
      if (l.kind === 'hunk') { current = { old: [], new: [] }; m.set(l, current); }
      else if (l.kind === 'del' && l.old !== null) current.old.push(l.old);
      else if (l.kind === 'add' && l.new !== null) current.new.push(l.new);
    }
    return m;
  }, [lines]);
  const none: HunkPick = { old: [], new: [] };
  // One hunk is the whole file: its buttons would only repeat the file's own.
  const hunkActions = hunkOf.size > 1 ? givenHunkActions : undefined;
  // A first hunk header that says nothing is left out, unless it holds the hunk's buttons.
  const shown = useMemo(() => lines.filter((l, i) => hunkActions || !(i === 0 && l.kind === 'hunk' && !l.skipped && !l.text)), [lines, hunkActions]);
  const rows = useMemo(() => (layout === 'split' ? splitRows(shown) : null), [layout, shown]);
  const digest = useMemo(() => (text === undefined ? null : diffHash(text)), [text]);
  const tell = useRef(onDigest);
  tell.current = onDigest;
  useEffect(() => { if (digest) tell.current?.(digest); }, [digest]);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const mac = bridge().platform === 'darwin';
  useEffect(() => { setEditing(null); setDraft(''); }, [file.path]);
  const add = (l: DiffLine): void => {
    const at = noteTarget(l);
    if (!at || !draft.trim()) return;
    onAdd?.({ file: file.path, ...at, quote: l.text, text: draft });
    setEditing(null);
    setDraft('');
  };

  /** A line number; on the side a note attaches to, a button that starts one. */
  const number = (l: DiffLine | null, side: 'old' | 'new'): ReactNode => {
    const n = l ? l[side] : null;
    const at = l ? noteTarget(l) : null;
    if (!l || !at || at.side !== side || !onAdd) return n ?? '';
    return (
      <button type="button" className="dl-note-add" aria-label={`Leave a note on ${side === 'old' ? 'removed ' : ''}line ${at.line}`} title="Leave a note on this line"
        onClick={() => { setEditing(keyOf(at)); setDraft(''); }}>{n}</button>
    );
  };

  /** Changed lines in the order they are shown, for Shift-click ranges. */
  const pickable = useMemo(() => shown.flatMap((l) => { const k = pickKey(l); return k ? [k] : []; }), [shown]);
  const lastPicked = useRef<string | null>(null);
  useEffect(() => { lastPicked.current = null; }, [text]);
  /** The box that picks a changed line, or an empty cell. */
  const pickCell = (l: DiffLine | null, extra = ''): ReactNode => {
    if (!pick) return null;
    const key = l ? pickKey(l) : null;
    if (!l || !key) return <td className={`dl-pick${extra}`} />;
    const on = pick.picked.has(key);
    const label = `${on ? 'Unpick' : 'Pick'} ${l.kind === 'add' ? 'added' : 'removed'} line ${l.kind === 'add' ? l.new : l.old}`;
    const click = (e: MouseEvent): void => {
      const from = lastPicked.current;
      if (e.shiftKey && from && from !== key && pickable.includes(from)) {
        const [a, b] = [pickable.indexOf(from), pickable.indexOf(key)].sort((x, y) => x - y) as [number, number];
        pick.onPick(pickable.slice(a, b + 1), !on);
      } else pick.onPick([key], !on);
      lastPicked.current = key;
    };
    return (
      <td className={`dl-pick${extra}`}>
        <button type="button" className={`dl-pick-box${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} title={`${label} (Shift-click picks a range)`} onClick={click}>
          {on ? <Icon name="check" size={10} /> : null}
        </button>
      </td>
    );
  };
  const picked = (l: DiffLine | null): boolean => !!pick && !!l && pick.picked.has(pickKey(l) ?? '');

  /** The notes on a line, and the box for a new one, if it is open there. */
  const notesOn = (l: DiffLine | null): ReactNode => {
    const at = l ? noteTarget(l) : null;
    if (!l || !at) return null;
    const here = notes.filter((n) => n.line === at.line && n.side === at.side);
    const open = editing === keyOf(at);
    if (!here.length && !open) return null;
    return (
      <>
        {here.map((n, k) => (
          <div key={k} className="dl-note-box"><span>{n.text}</span><button type="button" className="linkish small" onClick={() => onRemove(n)}>Remove</button></div>
        ))}
        {open ? (
          <form className="dl-note-box editing" onSubmit={(e) => { e.preventDefault(); add(l); }}>
            <textarea aria-label={`Note on line ${at.line}`} rows={2} autoFocus value={draft} placeholder="What should change here?"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(l); }
                if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
              }} />
            <div className="row-gap">
              <Button size="s" tone="primary" type="submit" disabled={!draft.trim()}>Add note</Button>
              <Button size="s" tone="quiet" onClick={() => setEditing(null)}>Cancel</Button>
              <span className="faint small">{keyLabel('Mod', mac)}{mac ? '' : '+'}{keyLabel('Enter', mac)} adds it. Notes go to the agent together.</span>
            </div>
          </form>
        ) : null}
      </>
    );
  };

  const sign = (l: DiffLine | null): string => (l?.kind === 'add' ? '+' : l?.kind === 'del' ? '−' : '');
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  const estimate = { '--rows': Math.min(400, (file.additions ?? 0) + (file.deletions ?? 0) + 2) } as CSSProperties;
  const lead = pick ? 1 : 0;

  return (
    <section className={`diff${viewed ? ' diff-is-viewed' : ''}${pick ? ' diff-pickable' : ''}`} aria-label={`Changes to ${file.path}`}>
      <header className="diff-head" tabIndex={-1}>
        <span className="diff-path mono" title={file.path}>{dir ? <span className="diff-dir">{dir}</span> : null}{name}</span>
        <span className="faint small">{STATUS_LABEL[file.status]}</span>
        {!file.binary && (file.additions || file.deletions) ? (
          <span className="fcount">
            {file.additions ? <span className="add">+{file.additions}</span> : null}
            {file.deletions ? <span className="del">−{file.deletions}</span> : null}
          </span>
        ) : null}
        {actions || onViewed ? (
          <span className="diff-head-end">
            {actions}
            {onViewed ? (
              <label className="diff-viewed" title="Viewed files fold away. A change to the file unfolds it again.">
                {/* Ticked before the diff is read, the mark waits for it (WorkingTree). */}
                <input type="checkbox" checked={!!viewed} onChange={(e) => onViewed(e.target.checked)} aria-label={`${file.path} viewed`} />
                Viewed
              </label>
            ) : null}
          </span>
        ) : null}
      </header>
      {note && !viewed ? <div className="diff-note">{note}</div> : null}
      {viewed ? null
        : diff.error ? <p className="error-text view-pad">{diff.error.message}</p>
          : file.binary ? <p className="faint view-pad">A binary file; its contents are not shown.</p>
            : !diff.data ? <p className="faint view-pad diff-wait" style={estimate}>Reading the diff…</p>
              : !shown.length ? <p className="faint view-pad">{text ? 'No line changes (for example, only the file mode changed).' : diff.data.truncated ? 'Too much changed here to show this file’s diff.' : 'Nothing to show: the file is empty, or not a regular file.'}</p>
                : rows ? (
                  <table className="diff-lines diff-split">
                    <colgroup>
                      {pick ? <col className="dl-col-pick" /> : null}<col className="dl-col-no" /><col className="dl-col-sign" /><col />
                      {pick ? <col className="dl-col-pick" /> : null}<col className="dl-col-no" /><col className="dl-col-sign" /><col />
                    </colgroup>
                    <tbody>
                      {rows.map((r, i) => {
                        if (r.kind !== 'pair') return <Banner key={i} line={r.line} span={6 + 2 * lead} actions={r.line.kind === 'hunk' ? hunkActions?.(hunkOf.get(r.line) ?? none) : null} />;
                        const left = r.left && r.left !== r.right ? r.left : null; // a context line's note goes on the new side
                        const leftNotes = notesOn(left);
                        const rightNotes = notesOn(r.right);
                        return (
                          <Fragment key={i}>
                            <tr className={`dl${picked(r.left) || picked(r.right) ? ' dl-picked' : ''}`}>
                              {pickCell(r.left && r.left.kind === 'del' ? r.left : null)}
                              <td className={`dl-no dl-${r.left?.kind ?? 'none'}`}>{number(r.left, 'old')}</td>
                              <td className={`dl-sign dl-${r.left?.kind ?? 'none'}`} aria-hidden="true">{sign(r.left)}</td>
                              <td className={`dl-text dl-${r.left?.kind ?? 'none'}${picked(r.left) ? ' dl-text-picked' : ''}`}>{r.left ? <Code line={r.left} /> : null}</td>
                              {pickCell(r.right && r.right.kind === 'add' ? r.right : null, ' dl-half')}
                              <td className={`dl-no ${pick ? '' : 'dl-half '}dl-${r.right?.kind ?? 'none'}`}>{number(r.right, 'new')}</td>
                              <td className={`dl-sign dl-${r.right?.kind ?? 'none'}`} aria-hidden="true">{sign(r.right)}</td>
                              <td className={`dl-text dl-${r.right?.kind ?? 'none'}${picked(r.right) ? ' dl-text-picked' : ''}`}>{r.right ? <Code line={r.right} /> : null}</td>
                            </tr>
                            {leftNotes || rightNotes ? (
                              <tr className="dl-note">
                                <td colSpan={2 + lead} /><td>{leftNotes}</td>
                                <td colSpan={2 + lead} /><td>{rightNotes}</td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table className="diff-lines">
                    <tbody>
                      {shown.map((l, i) => {
                        if (l.kind === 'hunk') return <Banner key={i} line={l} span={4 + lead} actions={hunkActions?.(hunkOf.get(l) ?? none)} />;
                        const below = notesOn(l);
                        return (
                          <Fragment key={i}>
                            <tr className={`dl dl-${l.kind}${picked(l) ? ' dl-picked' : ''}`}>
                              {pickCell(l)}
                              <td className="dl-no">{number(l, 'old')}</td>
                              <td className="dl-no">{number(l, 'new')}</td>
                              <td className="dl-sign" aria-hidden="true">{sign(l)}</td>
                              <td className="dl-text">{l.kind === 'meta' ? l.text : <Code line={l} />}</td>
                            </tr>
                            {below ? (
                              <tr className="dl-note">
                                <td colSpan={3 + lead} />
                                <td>{below}</td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
      {!viewed && diff.data?.truncated ? <p className="faint small view-pad">The diff is long; only the start is shown.</p> : null}
    </section>
  );
}

/** A hunk's header (how many lines it skips, and the function it is in), or git's "no newline" note. */
function Banner({ line, span, actions }: { line: DiffLine; span: number; actions?: ReactNode }) {
  if (line.kind === 'meta') {
    return <tr className="dl dl-meta"><td colSpan={span} className="dl-text">{line.text}</td></tr>;
  }
  const skipped = line.skipped ? `${line.skipped} unchanged line${line.skipped === 1 ? '' : 's'}` : '';
  return (
    <tr className="dl dl-hunk">
      <td colSpan={span}>
        <span className="dl-hunk-row">
          <span className="dl-skip">{skipped || '⋯'}</span>
          {line.text ? <code className="dl-context">{line.text}</code> : null}
          {actions ? <span className="dl-hunk-actions">{actions}</span> : null}
        </span>
      </td>
    </tr>
  );
}

/** A line's code in colour, with the part an edit changed marked. */
function Code({ line }: { line: DiffLine }) {
  const paint = (from: number, to: number): ReactNode[] =>
    pieces(line.text, line.syntax, from, to).map((p, i) => (p.kind ? <span key={i} className={`syn-${p.kind}`}>{p.text}</span> : p.text));
  if (!line.changed) return <>{paint(0, line.text.length)}</>;
  const [s, e] = line.changed;
  return <>{paint(0, s)}<mark className="dl-word">{paint(s, e)}</mark>{paint(e, line.text.length)}</>;
}
