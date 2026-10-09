// Named, saved views of a board: which one the board shows (and whether it has
// changed since), and a small panel to apply, save, rename and delete them.
// The views are the owner's, kept by the core; the board only remembers which
// one it was last set from. Keys 1–9 apply them from the board itself.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MAX_VIEWS, MAX_VIEW_NAME, shownView, viewNameKey, type BoardSort, type BoardView, type SavedBoardView } from '@shared/board-views';
import { attempt, call, type Query } from '../lib/api';
import { PROVIDER_LABEL, TYPE_LABEL } from '../lib/format';
import { useCoversLive } from '../lib/live';
import { Icon } from '../components/icons';
import { Button, IconButton, useFocusTrap, useSingleFlight, useToast } from '../components/ui';

const SORT_PHRASE: Record<BoardSort, string> = {
  manual: 'your order', priority: 'by priority', newest: 'newest first', oldest: 'oldest first',
  stuck: 'longest in column first', jev: 'what matters most to Jev first',
};

const and = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** What a view shows, in a line: "Bugs, P1 · by priority". */
export function describeView(v: BoardView): string {
  const what = [
    v.types.length ? and(v.types.map((t, i) => `${i ? TYPE_LABEL[t].toLowerCase() : TYPE_LABEL[t]}s`)) : null,
    v.priority === 'any' ? null : `P${v.priority}`,
    v.agent === 'any' ? null : v.agent === 'none' ? 'no agent on it' : PROVIDER_LABEL[v.agent],
    v.filter.trim() ? `“${v.filter.trim()}”` : null,
  ].filter(Boolean);
  return `${what.length ? what.join(', ') : 'All cards'} · ${SORT_PHRASE[v.sort]}`;
}

/** Why a name cannot be used here, or null when it can. */
function nameProblem(name: string, views: readonly SavedBoardView[], self: SavedBoardView | null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name the view first';
  if (self && trimmed === self.name) return 'That is its name now';
  const taken = views.find((v) => v.id !== self?.id && viewNameKey(v.name) === viewNameKey(trimmed));
  return taken ? `This board already has a view called “${taken.name}”` : null;
}

export function SavedViews({ projectId, views, current, appliedId, onApply, setApplied }: {
  projectId: string;
  views: Query<SavedBoardView[]>;
  /** What the board shows now. */
  current: BoardView;
  /** The saved view the board was last set from, if any. */
  appliedId: string | null;
  onApply: (saved: SavedBoardView) => void;
  setApplied: (id: string | null) => void;
}) {
  const toast = useToast();
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const shown = shownView(views.data ?? [], current, appliedId);
  const name = shown?.view.name;

  const update = async (): Promise<void> => {
    if (!shown) return;
    const done = await attempt(() => call('boardViews.update', { id: shown.view.id, view: current }), (m) => toast(m, 'error'));
    if (done) { setApplied(done.id); toast(`Updated “${done.name}” to show the board as it is.`); }
  };

  return (
    <div className="views-bar">
      <button
        ref={trigger}
        type="button"
        className={`select select-s views-trigger${shown && !shown.changed ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={shown ? `Saved views: ${name}${shown.changed ? ', changed' : ''}` : 'Saved views'}
        title={shown?.changed ? `The board has changed since you applied “${name}”` : shown ? `The board shows “${name}”` : 'Save this view of the board, or apply one you saved'}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
      >
        <span className="views-glyph" aria-hidden="true"><Icon name="layers" size={14} /></span>
        <span className="select-value">{name ?? 'Views'}</span>
        {shown?.changed ? <span className="views-changed">changed</span> : null}
        <Icon name="chevron" size={14} />
      </button>
      {shown?.changed ? (
        <>
          <Button size="s" tone="quiet" onClick={update} aria-label={`Update “${name}” to show the board as it is`} title={`Save the board as it is now as “${name}”`}>Update</Button>
          <Button size="s" tone="quiet" onClick={() => onApply(shown.view)} aria-label={`Put the board back to “${name}”`} title={`Put the board back to “${name}”`}>Revert</Button>
        </>
      ) : null}
      {open ? (
        <ViewsPanel
          id={panelId}
          anchor={trigger}
          projectId={projectId}
          views={views}
          current={current}
          shownId={shown && !shown.changed ? shown.view.id : null}
          onApply={(v) => { onApply(v); setOpen(false); }}
          onSaved={(id) => setApplied(id)}
          onDeleted={(id) => { if (id === appliedId) setApplied(null); }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

type Editing = { id: string; mode: 'rename' | 'delete' } | null;

function ViewsPanel({ id, anchor, projectId, views, current, shownId, onApply, onSaved, onDeleted, onClose }: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  projectId: string;
  views: Query<SavedBoardView[]>;
  current: BoardView;
  /** The saved view the board matches now; null while it has changed from one. */
  shownId: string | null;
  onApply: (v: SavedBoardView) => void;
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const list = views.data ?? [];
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const focusRow = (viewId: string | null): void => {
    requestAnimationFrame(() => {
      const rows = [...(box.current?.querySelectorAll<HTMLElement>('.views-apply') ?? [])];
      (rows.find((r) => r.dataset.view === viewId) ?? rows[0] ?? box.current?.querySelector<HTMLElement>('.views-save input'))?.focus();
    });
  };
  // Escape steps out of a rename or a delete first, then closes the panel.
  useFocusTrap(box, () => {
    const now = editingRef.current;
    if (now) { setEditing(null); focusRow(now.id); } else onClose();
  }, '.views-apply, .views-save input');
  useCoversLive();

  // Under the button, its right edge on the button's, inside the window.
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    const width = box.current?.offsetWidth ?? 360;
    if (!r) return;
    const top = r.bottom + 6;
    setPlace({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top, maxHeight: Math.max(240, window.innerHeight - top - 16) });
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t) && !(t instanceof Element && t.closest('.toasts'))) onClose();
    };
    const moved = (): void => onClose();
    document.addEventListener('mousedown', away, true);
    window.addEventListener('resize', moved);
    return () => { document.removeEventListener('mousedown', away, true); window.removeEventListener('resize', moved); };
  }, [anchor, onClose]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (editing || target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) {
      const v = list[Number(e.key) - 1];
      if (v) { e.preventDefault(); onApply(v); }
      return;
    }
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('.views-apply') ?? [])];
    const at = rows.indexOf(target.closest('.views-row')?.querySelector<HTMLElement>('.views-apply') ?? target);
    const go = (i: number): void => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus(); };
    if (e.key === 'ArrowDown') go(at < 0 ? 0 : at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? rows.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
  };

  const autofocus = shownId ?? list[0]?.id ?? null;
  return createPortal(
    <div
      ref={box}
      id={id}
      className="views-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ left: place?.left ?? -9999, top: place?.top ?? 0, maxHeight: place?.maxHeight }}
      onKeyDown={onKey}
    >
      <header className="views-head">
        <h2 id={titleId}>Saved views</h2>
        {list.length ? <span className="views-keys">Keys <kbd>1</kbd>–<kbd>{Math.min(9, list.length)}</kbd> on the board</span> : null}
      </header>
      {views.error ? (
        <div className="views-problem" role="alert">
          <p>The saved views could not be read: {views.error.message}</p>
          <Button size="s" icon="refresh" onClick={views.reload}>Retry</Button>
        </div>
      ) : !views.data ? null : list.length === 0 ? (
        <p className="views-empty">No views saved on this board yet. Set the filter, types and order you want, then name it below.</p>
      ) : (
        <ol className="views-list">
          {list.map((v, i) => (
            <li key={v.id} className={`views-row${v.id === shownId ? ' on' : ''}`}>
              {editing?.id === v.id && editing.mode === 'rename' ? (
                <Rename view={v} views={list} onDone={() => { setEditing(null); focusRow(v.id); }} />
              ) : editing?.id === v.id && editing.mode === 'delete' ? (
                <ConfirmDelete view={v} onCancel={() => { setEditing(null); focusRow(v.id); }} onDeleted={() => {
                  setEditing(null);
                  onDeleted(v.id);
                  toast(`Deleted “${v.name}”.`);
                  focusRow(list[i + 1]?.id ?? list[i - 1]?.id ?? null);
                }} />
              ) : (
                <>
                  <button
                    type="button"
                    className="views-apply"
                    data-view={v.id}
                    data-autofocus={v.id === autofocus ? '' : undefined}
                    aria-current={v.id === shownId ? 'true' : undefined}
                    aria-label={v.name}
                    aria-describedby={`${id}-d${i}`}
                    aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                    onClick={() => onApply(v)}
                  >
                    <span className="views-check" aria-hidden="true">{v.id === shownId ? <Icon name="check" size={13} /> : null}</span>
                    <span className="views-text">
                      <span className="views-name">{v.name}</span>
                      <span className="views-detail" id={`${id}-d${i}`}>{describeView(v.view)}</span>
                    </span>
                    {i < 9 ? <kbd aria-hidden="true">{i + 1}</kbd> : null}
                  </button>
                  <IconButton icon="pencil" label={`Rename “${v.name}”`} onClick={() => setEditing({ id: v.id, mode: 'rename' })} />
                  <IconButton icon="trash" label={`Delete “${v.name}”`} onClick={() => setEditing({ id: v.id, mode: 'delete' })} />
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <SaveCurrent projectId={projectId} views={list} loaded={!!views.data} current={current} onSaved={(v) => { onSaved(v.id); onClose(); }} />
    </div>,
    document.body,
  );
}

function Rename({ view, views, onDone }: { view: SavedBoardView; views: readonly SavedBoardView[]; onDone: () => void }) {
  const toast = useToast();
  const once = useSingleFlight();
  const [name, setName] = useState(view.name);
  const why = nameProblem(name, views, view);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  // A refused rename stays open with its words, to try again.
  const save = (): Promise<void> => once(async () => {
    if (why) return;
    const done = await attempt(() => call('boardViews.update', { id: view.id, name: name.trim() }), (m) => toast(m, 'error'));
    if (done) { toast(`Renamed to “${done.name}”.`); onDone(); }
  });
  return (
    <form className="views-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input ref={input} value={name} maxLength={MAX_VIEW_NAME} aria-label={`New name for “${view.name}”`} onChange={(e) => setName(e.target.value)} />
      <Button size="s" tone="primary" type="submit" disabled={!!why} title={why ?? undefined}>Rename</Button>
      <Button size="s" tone="quiet" onClick={onDone}>Cancel</Button>
    </form>
  );
}

function ConfirmDelete({ view, onCancel, onDeleted }: { view: SavedBoardView; onCancel: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const keep = useRef<HTMLDivElement>(null);
  // The safe choice has the keys: a second Enter keeps the view.
  useEffect(() => { keep.current?.querySelector<HTMLButtonElement>('[data-keep]')?.focus(); }, []);
  const remove = async (): Promise<void> => {
    const done = await attempt(() => call('boardViews.remove', { id: view.id }), (m) => toast(m, 'error'));
    if (done) onDeleted();
  };
  return (
    <div className="views-edit views-confirm" role="group" aria-label={`Delete “${view.name}”?`} ref={keep}>
      <span className="views-confirm-text">Delete “{view.name}”?</span>
      <Button size="s" tone="danger" onClick={remove}>Delete it</Button>
      <Button size="s" tone="quiet" data-keep="" onClick={onCancel}>Keep it</Button>
    </div>
  );
}

function SaveCurrent({ projectId, views, loaded, current, onSaved }: {
  projectId: string;
  views: readonly SavedBoardView[];
  loaded: boolean;
  current: BoardView;
  onSaved: (v: SavedBoardView) => void;
}) {
  const toast = useToast();
  const once = useSingleFlight();
  const id = useId();
  const [name, setName] = useState('');
  const why = !loaded ? 'The saved views have not been read yet'
    : views.length >= MAX_VIEWS ? `A board keeps at most ${MAX_VIEWS} saved views. Delete one first`
      : nameProblem(name, views, null);
  const save = (): Promise<void> => once(async () => {
    if (why) return;
    const done = await attempt(() => call('boardViews.save', { projectId, name: name.trim(), view: current }), (m) => toast(m, 'error'));
    const key = views.length + 1;
    if (done) { setName(''); toast(key <= 9 ? `Saved “${done.name}”. Press ${key} on the board to apply it.` : `Saved “${done.name}”.`); onSaved(done); }
  });
  return (
    <form className="views-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label htmlFor={id}>Save the board as it is now</label>
      <div className="views-save-row">
        <input id={id} value={name} maxLength={MAX_VIEW_NAME} placeholder="Name this view" autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <Button size="s" tone="primary" type="submit" disabled={!!why} title={why ?? undefined}>Save</Button>
      </div>
      <p className="views-hint">{describeView(current)}</p>
    </form>
  );
}
