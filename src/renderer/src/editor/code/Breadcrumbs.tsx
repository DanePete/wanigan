// Above the editor: Back and Forward (with the places they remember), then
// where the cursor is: the file's folders, the file, and the symbols around
// the cursor (a PHP class and method, a Twig block, a CSS rule, a YAML key).
// Each crumb opens a menu of what sits beside it: a folder's other files and
// folders, a method's sibling methods. Keyboard: ⌘⇧. moves here; ← and →
// move between crumbs; Enter or ↓ opens one; Escape goes back to the text.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { DirEntry } from '@shared/files';
import { recentSpots } from '@shared/nav-history';
import { attempt, call } from '../../lib/api';
import { Icon, type IconName } from '../../components/icons';
import { IconButton, useToast } from '../../components/ui';
import { goBack, goForward, goToRecent, mayGoBack, mayGoForward, navOf, openInEditor, useEditor } from '../store';
import type { Controller, DocSession } from './controller';
import { symbolPath, symbolSiblings, topSymbols, type CodeSymbol, type SymbolKind } from './symbols.ts';

const KIND_ICON: Record<SymbolKind, IconName> = {
  class: 'symbol', interface: 'symbol', trait: 'symbol', enum: 'symbol', method: 'symbol', function: 'symbol',
  block: 'block', macro: 'block', rule: 'brush', 'at-rule': 'brush', key: 'list', item: 'list', heading: 'note', element: 'code',
};
const KIND_WORD: Record<SymbolKind, string> = {
  class: 'class', interface: 'interface', trait: 'trait', enum: 'enum', method: 'method', function: 'function', block: 'block', macro: 'macro',
  rule: 'rule', 'at-rule': 'at-rule', key: 'key', item: 'item', heading: 'heading', element: 'element',
};

type Crumb =
  | { kind: 'root'; label: string }
  | { kind: 'folder'; label: string; dir: string }
  | { kind: 'file'; label: string; dir: string }
  | { kind: 'symbol'; label: string; symbol: CodeSymbol }
  | { kind: 'outline'; label: string };

interface MenuItem { id: string; label: string; detail?: string; icon: IconName; current?: boolean; run: () => void; folder?: string }

export function Breadcrumbs({ controller, session, rootLabel, focusSignal, mac }: {
  controller: Controller; session: DocSession; rootLabel: string; focusSignal: number; mac: boolean;
}) {
  const projectId = session.tab.projectId;
  // Back and Forward change with the history, and with where the cursor is.
  useEditor();
  useSyncExternalStore(controller.subscribeCursor, controller.cursorSnapshot);
  const state = controller.stateOf(session);
  const head = state?.selection.main.head ?? 0;
  const symbols = useMemo(() => (state && session.status === 'ready' ? symbolPath(state, head) : []), [state, head, session.status]);
  const parts = session.tab.path.split('/');
  const crumbs: Crumb[] = [
    { kind: 'root', label: rootLabel },
    ...parts.slice(0, -1).map((label, i): Crumb => ({ kind: 'folder', label, dir: parts.slice(0, i + 1).join('/') })),
    { kind: 'file', label: parts.at(-1) ?? session.tab.path, dir: parts.slice(0, -1).join('/') },
    ...(symbols.length
      ? symbols.map((symbol): Crumb => ({ kind: 'symbol', label: symbol.name, symbol }))
      : state && topSymbols(state).length ? [{ kind: 'outline', label: '…' } as Crumb] : []),
  ];
  const [focus, setFocus] = useState(crumbs.length - 1);
  const [menu, setMenu] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const at = Math.min(focus, crumbs.length - 1);

  // ⌘⇧.: focus lands on the last crumb, the one nearest the cursor.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setFocus(crumbs.length - 1);
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLButtonElement>('.crumb-button')[crumbs.length - 1]?.focus());
  }, [focusSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // The end of the path stays in view as it grows.
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollLeft = el.scrollWidth; }, [session.tab.path, symbols.length]);

  const move = (to: number): void => {
    const next = (to + crumbs.length) % crumbs.length;
    setFocus(next);
    list.current?.querySelectorAll<HTMLButtonElement>('.crumb-button')[next]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number): void => {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(crumbs.length - 1); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMenu(i); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); controller.view.focus(); }
  };

  return (
    <div className="crumbs">
      <NavButtons projectId={projectId} mac={mac} />
      <nav className="crumbs-path" aria-label="Breadcrumbs: where the cursor is">
        <ol ref={list}>
          {crumbs.map((c, i) => (
            <li key={`${c.kind}-${i}-${c.label}`} className={`crumb crumb-${c.kind}`}>
              {i ? <Icon name="chevron" size={12} className="crumb-sep" /> : null}
              <button type="button" className="crumb-button" tabIndex={i === at ? 0 : -1} aria-haspopup="listbox" aria-expanded={menu === i}
                aria-label={crumbLabel(c)} onFocus={() => setFocus(i)} onKeyDown={(e) => onKey(e, i)} onClick={() => setMenu(menu === i ? null : i)}>
                {c.kind === 'symbol' ? <Icon name={KIND_ICON[c.symbol.kind]} size={12} /> : c.kind === 'root' ? <Icon name="folder" size={12} /> : null}
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {menu !== null && crumbs[menu] ? (
        // Drawn outside the path, which scrolls sideways and would clip it, under the crumb it belongs to.
        <CrumbMenu crumb={crumbs[menu] as Crumb} session={session} controller={controller} place={placeUnder(list.current?.querySelectorAll<HTMLButtonElement>('.crumb-button')[menu] ?? null)}
          onClose={(refocus) => {
            const i = menu;
            setMenu(null);
            if (refocus) requestAnimationFrame(() => list.current?.querySelectorAll<HTMLButtonElement>('.crumb-button')[i]?.focus());
          }} />
      ) : null}
    </div>
  );
}

interface Place { left: number; top: number; maxHeight: number }

/** Where a menu goes: just under its crumb, inside the window. */
function placeUnder(button: HTMLElement | null): Place | undefined {
  if (!button) return undefined;
  const r = button.getBoundingClientRect();
  const width = 340;
  return {
    left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
    top: r.bottom + 4,
    maxHeight: Math.max(160, Math.min(320, window.innerHeight - r.bottom - 16)),
  };
}

function crumbLabel(c: Crumb): string {
  switch (c.kind) {
    case 'root': return `${c.label}: its files`;
    case 'folder': return `Folder ${c.label}: what is beside it`;
    case 'file': return `File ${c.label}: the files beside it`;
    case 'symbol': return `${KIND_WORD[c.symbol.kind]} ${c.label}: what is beside it`;
    case 'outline': return 'Symbols in this file';
  }
}

/** Back, Forward, and the places they remember (long-press or right-click either, or the clock). */
function NavButtons({ projectId, mac }: { projectId: string; mac: boolean }) {
  const [recent, setRecent] = useState(false);
  const press = useRef<number | null>(null);
  const hold = {
    onPointerDown: () => { press.current = window.setTimeout(() => { press.current = null; setRecent(true); }, 450); },
    onPointerUp: () => { if (press.current !== null) window.clearTimeout(press.current); },
    onPointerLeave: () => { if (press.current !== null) window.clearTimeout(press.current); },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setRecent(true); },
  };
  const back = mac ? '⌃-' : 'Alt+←';
  const forward = mac ? '⌃⇧-' : 'Alt+→';
  return (
    <div className="crumbs-nav" role="group" aria-label="Back and forward">
      <IconButton icon="back" label={`Back (${back}); hold for recent places`} disabled={!mayGoBack(projectId)} onClick={() => { if (!recent) goBack(projectId); }} {...hold} />
      <IconButton icon="forward" label={`Forward (${forward}); hold for recent places`} disabled={!mayGoForward(projectId)} onClick={() => { if (!recent) goForward(projectId); }} {...hold} />
      <IconButton icon="clock" label="Recent places" aria-haspopup="listbox" aria-expanded={recent} onClick={() => setRecent((r) => !r)} />
      {recent ? <RecentMenu projectId={projectId} onClose={() => setRecent(false)} /> : null}
    </div>
  );
}

function RecentMenu({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const items: MenuItem[] = recentSpots(navOf(projectId)).map(({ spot, index, current }) => {
    const name = spot.path.split('/').pop() ?? spot.path;
    return {
      id: `${index}`, label: `${name}:${spot.line}`, detail: spot.path.includes('/') ? spot.path.slice(0, spot.path.lastIndexOf('/')) : '',
      icon: current ? 'check' : 'file', current, run: () => goToRecent(projectId, index),
    };
  });
  return <PopupList label="Recent places" items={items} empty="No places yet: open a file or jump within one." onClose={onClose} className="crumbs-recent" filter={false} />;
}

/** What a crumb's menu offers: a folder's entries (folders open in place), or the symbols at a symbol's level. */
function CrumbMenu({ crumb, session, controller, place, onClose }: { crumb: Crumb; session: DocSession; controller: Controller; place: Place | undefined; onClose: (refocus: boolean) => void }) {
  const toast = useToast();
  const startDir = crumb.kind === 'root' ? '' : crumb.kind === 'folder' ? crumb.dir.split('/').slice(0, -1).join('/') : crumb.kind === 'file' ? crumb.dir : null;
  const [dir, setDir] = useState<string | null>(startDir);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    if (dir === null) return;
    let current = true;
    setEntries(null);
    void attempt(() => call('files.dir', { projectId: session.tab.projectId, cardId: session.tab.cardId, path: dir }), (m) => toast(m, 'error'))
      .then((d) => { if (current && d) { setEntries(d.entries); setCut(d.cut); } });
    return () => { current = false; };
  }, [dir, session.tab.projectId, session.tab.cardId, toast]);

  if (dir !== null) {
    const here = crumb.kind === 'folder' ? crumb.dir : crumb.kind === 'file' ? session.tab.path : null;
    const join = (name: string): string => (dir ? `${dir}/${name}` : name);
    const items: MenuItem[] = [
      ...(dir ? [{ id: '..', label: '..', detail: `Up to ${dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : 'the top'}`, icon: 'back' as IconName, folder: dir.split('/').slice(0, -1).join('/'), run: () => {} }] : []),
      ...(entries ?? []).map((e): MenuItem => e.kind === 'dir'
        ? { id: `d:${e.name}`, label: `${e.name}/`, icon: 'folder', folder: join(e.name), current: join(e.name) === here, run: () => {} }
        : {
          id: `f:${e.name}`, label: e.name, icon: 'file', current: join(e.name) === here,
          run: () => openInEditor({ projectId: session.tab.projectId, cardId: session.tab.cardId, path: join(e.name) }),
        }),
    ];
    return (
      <PopupList label={dir ? `${dir}/` : 'The top folder'} items={items} loading={!entries} onClose={onClose} onFolder={setDir} place={place}
        empty="This folder is empty." note={cut ? 'Only the first thousand are listed.' : null} />
    );
  }
  const state = controller.stateOf(session);
  if (!state) return null;
  const level = crumb.kind === 'symbol' ? symbolSiblings(state, crumb.symbol) : topSymbols(state);
  const items: MenuItem[] = level.map((s, i) => ({
    id: `${i}:${s.from}`, label: s.name, detail: `${KIND_WORD[s.kind]} · line ${state.doc.lineAt(s.select).number}`, icon: KIND_ICON[s.kind],
    current: crumb.kind === 'symbol' && s.from === crumb.symbol.from,
    run: () => controller.jump(s.select),
  }));
  return <PopupList label={crumb.kind === 'symbol' ? `Beside ${crumb.label}` : 'Symbols in this file'} items={items} onClose={onClose} empty="Nothing else at this level." place={place} />;
}

/**
 * A small list under a crumb: type to narrow it, ↑ and ↓ to choose, Enter to
 * open, → into a folder and ← out of it, Escape to close.
 */
function PopupList({ label, items, onClose, onFolder, loading = false, empty, note = null, className = '', filter = true, place }: {
  label: string; items: MenuItem[]; onClose: (refocus: boolean) => void; onFolder?: (dir: string) => void;
  loading?: boolean; empty: string; note?: ReactNode; className?: string; filter?: boolean; place?: Place;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { setActive(Math.max(0, shown.findIndex((i) => i.current))); }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { (filter ? input.current : listRef.current)?.focus(); }, [filter]);
  useEffect(() => { listRef.current?.querySelector(`#${id}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, id]);
  // A click anywhere else closes it.
  useEffect(() => {
    const away = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) onClose(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  const choose = (item: MenuItem | undefined): void => {
    if (!item) return;
    if (item.folder !== undefined && onFolder) { onFolder(item.folder); setQuery(''); return; }
    onClose(false);
    item.run();
  };
  const onKey = (e: KeyboardEvent): void => {
    const item = shown[active];
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home' && !query) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !query) { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(item); }
    else if (e.key === 'ArrowRight' && item?.folder !== undefined && item.id !== '..') { e.preventDefault(); choose(item); }
    else if ((e.key === 'ArrowLeft' || (e.key === 'Backspace' && !query)) && onFolder && items[0]?.id === '..') { e.preventDefault(); choose(items[0]); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose(true); }
  };

  return (
    <div className={`crumb-menu${place ? ' crumb-menu-placed' : ''} ${className}`} ref={box} onKeyDown={onKey}
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : undefined}>
      {filter ? (
        <input ref={input} className="crumb-menu-filter" value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          aria-label={`Narrow ${label}`} placeholder={label} role="combobox" aria-expanded="true" aria-controls={`${id}-list`}
          aria-activedescendant={shown[active] ? `${id}-${active}` : undefined} spellCheck={false} autoComplete="off" />
      ) : <p className="crumb-menu-title">{label}</p>}
      <ul className="crumb-menu-list" id={`${id}-list`} role="listbox" aria-label={label} ref={listRef} tabIndex={filter ? -1 : 0}
        aria-activedescendant={!filter && shown[active] ? `${id}-${active}` : undefined}>
        {loading ? <li className="crumb-menu-note faint">Reading the folder…</li> : null}
        {!loading && !shown.length ? <li className="crumb-menu-note faint">{query ? `Nothing here matches “${query}”.` : empty}</li> : null}
        {shown.map((item, i) => (
          <li key={item.id} id={`${id}-${i}`} role="option" aria-selected={i === active} aria-current={item.current || undefined}
            className={`crumb-menu-item${i === active ? ' active' : ''}${item.current ? ' current' : ''}`}
            onPointerMove={() => setActive(i)} onClick={() => choose(item)}>
            <Icon name={item.icon} size={13} />
            <span className="crumb-menu-label">{item.label}</span>
            {item.detail ? <span className="crumb-menu-detail">{item.detail}</span> : null}
          </li>
        ))}
      </ul>
      {note ? <p className="crumb-menu-note faint small">{note}</p> : null}
    </div>
  );
}
