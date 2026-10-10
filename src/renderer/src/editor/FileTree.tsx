// The Code tab's files: a checkout's folders as a tree beside the editor, read
// one folder at a time through the core's `files.dir` (the same call, and the
// same confinement to the project, as the breadcrumbs' menus), with the open
// file marked. Choosing a file opens it as ⌘P does; the core decides, as it
// does for every file, whether it opens read-only (Drupal core, vendor…).
// Keys follow the WAI-ARIA tree pattern: ↑ ↓ Home End move, → opens a folder
// or steps into it, ← closes it or steps out; Enter opens a file (the cursor
// goes into it) or a folder; Space opens a file and keeps the keyboard here;
// typing a name jumps to it.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { DirEntry } from '@shared/files';
import { bridge, call } from '../lib/api';
import { Icon } from '../components/icons';
import { Button, IconButton } from '../components/ui';
import { Panel } from '../components/Panel';
import { openInEditor } from './store';

/** Installed code: listed, quieter, and opened read-only by the core. */
const INSTALLED = new Set(['vendor', 'node_modules']);
/** Letters typed within this long of each other are one name to jump to. */
const TYPE_AHEAD_MS = 700;

interface Folder {
  entries: DirEntry[] | null;
  cut: boolean;
  error: string | null;
}

interface Row {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  depth: number;
  /** The folder it is in ('' is the top). */
  parent: string;
  size: number;
  at: number;
}

/**
 * What each checkout's tree had open and read, kept while the window is open,
 * so the Code tab comes back as it was left. Keyed by project and card.
 */
const remembered = new Map<string, { open: Set<string>; focus: string | null; folders: Map<string, Folder> }>();

/** The folders a path is inside, outermost first: `a/b/c.php` is in `a` and `a/b`. */
const foldersOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/** The rows as shown, top to bottom: what the arrow keys walk. */
function rowsOf(folders: ReadonlyMap<string, Folder>, open: ReadonlySet<string>, dir = '', depth = 0): Row[] {
  const entries = folders.get(dir)?.entries ?? [];
  const out: Row[] = [];
  entries.forEach((e, i) => {
    const path = dir ? `${dir}/${e.name}` : e.name;
    out.push({ path, name: e.name, kind: e.kind, depth, parent: dir, size: entries.length, at: i + 1 });
    if (e.kind === 'dir' && open.has(path)) out.push(...rowsOf(folders, open, path, depth + 1));
  });
  return out;
}

/** Put the keyboard on the tree (on the row it was last on): the Code tab's "choose one from the files". */
export function focusFileTree(): void {
  document.querySelector<HTMLElement>('.code-tree [role="treeitem"][tabindex="0"]')?.focus();
}

export function FileTree({ projectId, cardId, label, activePath, onClose }: {
  projectId: string;
  /** A card's own worktree; null is the project folder. */
  cardId: string | null;
  /** What the checkout is called: the project's name, or the card's worktree. */
  label: string;
  /** The file open in the editor, when it is in this checkout. */
  activePath: string | null;
  /** Put the files away (the editor's own button brings them back). */
  onClose?: () => void;
}) {
  const rootKey = `${projectId}|${cardId ?? ''}`;
  const kept = remembered.get(rootKey);
  const [open, setOpen] = useState<Set<string>>(() => kept?.open ?? new Set());
  const [focus, setFocus] = useState<string | null>(() => kept?.focus ?? null);
  const [folders, setFolders] = useState<Map<string, Folder>>(() => kept?.folders ?? new Map());
  const list = useRef<HTMLUListElement>(null);
  /** Folders being read, and whether each is to be read again when it is done. */
  const reading = useRef(new Map<string, boolean>());
  const typed = useRef({ text: '', at: 0 });
  const [reveal, setReveal] = useState<string | null>(activePath);

  useEffect(() => { remembered.set(rootKey, { open, focus, folders }); }, [rootKey, open, focus, folders]);

  /** Read one folder; a folder that has gone is closed. Asked again while it is being read, it is read once more after. */
  const read = useCallback((dir: string): void => {
    if (reading.current.has(dir)) { reading.current.set(dir, true); return; }
    reading.current.set(dir, false);
    call('files.dir', { projectId, cardId, path: dir }).then(
      (d) => setFolders((was) => new Map(was).set(dir, { entries: d.entries, cut: d.cut, error: null })),
      (e: Error & { code?: string }) => {
        setFolders((was) => {
          const next = new Map(was);
          if (dir && e.code === 'not_found') next.delete(dir);
          else next.set(dir, { entries: was.get(dir)?.entries ?? null, cut: false, error: e.message });
          return next;
        });
        if (dir && e.code === 'not_found') setOpen((was) => { const next = new Set(was); next.delete(dir); return next; });
      },
    ).finally(() => {
      const again = reading.current.get(dir);
      reading.current.delete(dir);
      if (again) read(dir);
    });
  }, [projectId, cardId]);

  // Every open folder is read when the tab shows (it may have changed meanwhile), and when one is opened.
  const openRef = useRef(open);
  openRef.current = open;
  const readAll = useCallback((): void => { for (const dir of ['', ...openRef.current]) read(dir); }, [read]);
  useEffect(() => { readAll(); }, [readAll]);
  useEffect(() => { for (const dir of open) if (!folders.has(dir)) read(dir); }, [open, folders, read]);

  // Read again when something here may have added or removed a file: a save, an agent's edit, git.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = bridge().on((event, data) => {
      if (event !== 'files' && event !== 'git' && event !== 'live') return;
      if ((data as { projectId?: string } | null)?.projectId !== projectId) return;
      if (event === 'live' && (data as { kind?: string }).kind !== 'edit') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(readAll, 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [projectId, readAll]);

  // The open file is shown: its folders opened, and scrolled to.
  useEffect(() => {
    if (!activePath) return;
    setOpen((was) => {
      const need = foldersOf(activePath).filter((d) => !was.has(d));
      return need.length ? new Set([...was, ...need]) : was;
    });
    setReveal(activePath);
    // The row to come back to, unless the keyboard is in the tree already.
    if (!list.current?.contains(document.activeElement)) setFocus(activePath);
  }, [activePath]);

  const rows = useMemo(() => rowsOf(folders, open), [folders, open]);
  const current = focus && rows.some((r) => r.path === focus) ? focus
    : activePath && rows.some((r) => r.path === activePath) ? activePath : rows[0]?.path ?? null;

  useEffect(() => {
    if (!reveal || !rows.some((r) => r.path === reveal)) return;
    list.current?.querySelector(`[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'nearest' });
    setReveal(null);
  }, [reveal, rows]);

  const move = (path: string | null | undefined): void => {
    if (!path) return;
    setFocus(path);
    const row = (): HTMLElement | null | undefined => list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    // Every row shown is in the page already; one just opened arrives with the next frame.
    const now = row();
    if (now) now.focus(); else requestAnimationFrame(() => row()?.focus());
  };
  const flip = (path: string, to?: boolean): void => setOpen((was) => {
    const next = new Set(was);
    if (to ?? !next.has(path)) next.add(path); else next.delete(path);
    return next;
  });
  const choose = (row: Row, keepKeys = false): void => {
    setFocus(row.path);
    if (row.kind === 'dir') { flip(row.path); return; }
    openInEditor({ projectId, cardId, path: row.path }, { focus: !keepKeys });
  };

  /** Typing a name: the next row whose name starts with what was typed. */
  const jump = (letter: string, from: number): void => {
    const now = Date.now();
    const more = now - typed.current.at < TYPE_AHEAD_MS;
    typed.current = { text: more ? typed.current.text + letter : letter, at: now };
    const text = typed.current.text.toLowerCase();
    // A second letter keeps looking from the row it is on; a first one starts at the next.
    const start = more ? from : from + 1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[(start + i) % rows.length] as Row;
      if (row.name.toLowerCase().startsWith(text)) { move(row.path); return; }
    }
  };

  const onKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    const at = rows.findIndex((r) => r.path === current);
    const row = rows[at];
    if (!row || e.metaKey || e.ctrlKey || e.altKey) return;
    // Any key but a letter starts the next name typed afresh.
    if (e.key.length !== 1) typed.current.at = 0;
    switch (e.key) {
      case 'ArrowDown': move(rows[Math.min(rows.length - 1, at + 1)]?.path); break;
      case 'ArrowUp': move(rows[Math.max(0, at - 1)]?.path); break;
      case 'Home': move(rows[0]?.path); break;
      case 'End': move(rows.at(-1)?.path); break;
      case 'ArrowRight':
        if (row.kind !== 'dir') break;
        if (!open.has(row.path)) flip(row.path, true);
        else if (rows[at + 1]?.parent === row.path) move(rows[at + 1]?.path);
        break;
      case 'ArrowLeft':
        if (row.kind === 'dir' && open.has(row.path)) flip(row.path, false);
        else move(row.parent || null);
        break;
      case 'Enter': choose(row); break;
      case ' ': choose(row, true); break;
      default:
        // Typing jumps by name. Every letter is taken here, so none is also one of the window's own keys (C, G then…).
        if (e.key.length !== 1) return;
        jump(e.key, at);
    }
    e.preventDefault();
  };

  const top = folders.get('');
  return (
    <Panel side="left" className="code-tree" label="the project’s files" onClose={onClose} resizable sizeKey="code-tree" size={280} minSize={200} maxSize={480}
      title={<span className="code-tree-title" data-tip={label}>{label}</span>}
      actions={(
        <>
          <IconButton icon="refresh" size="s" label="Read the folders again" onClick={readAll} />
          {/* Only while a folder is open: a disabled quiet button still draws a box (the foundation's disabled look). */}
          {open.size ? <IconButton icon="up" size="s" label="Close every folder" onClick={() => { setOpen(new Set()); setFocus(null); }} /> : null}
        </>
      )}>
      {top?.error && !top.entries ? (
        <div className="code-tree-note" role="alert">
          <p className="error-text">{top.error}</p>
          <Button size="s" icon="refresh" onClick={() => read('')}>Try again</Button>
        </div>
      ) : !top?.entries ? <p className="code-tree-note faint">Reading {label}…</p>
        : !rows.length ? <p className="code-tree-note faint">This folder is empty.</p> : null}
      <ul className="code-tree-list" role="tree" aria-label={`Files in ${label}`} ref={list} onKeyDown={onKey} hidden={!rows.length} data-tour="code-files">
        {rows.map((row) => {
          const isOpen = row.kind === 'dir' && open.has(row.path);
          const folder = row.kind === 'dir' ? folders.get(row.path) : undefined;
          const busy = isOpen && !folder?.entries && !folder?.error;
          const installed = row.path.split('/').some((p) => INSTALLED.has(p));
          const marked = row.path === activePath;
          return (
            <li key={row.path} role="treeitem" data-path={row.path} tabIndex={row.path === current ? 0 : -1}
              aria-level={row.depth + 1} aria-setsize={row.size} aria-posinset={row.at}
              aria-expanded={row.kind === 'dir' ? isOpen : undefined} aria-selected={marked} aria-busy={busy || undefined}
              className={`code-tree-row${marked ? ' open-file' : ''}${installed ? ' installed' : ''}`} style={{ '--depth': row.depth } as CSSProperties}
              data-tip={installed ? `${row.path}: installed code, opens read-only` : folder?.error ? `${row.path}: ${folder.error}` : undefined} data-tip-side="right"
              onFocus={() => setFocus(row.path)} onClick={() => choose(row)}>
              <span className="code-tree-twist" aria-hidden="true">{row.kind === 'dir' ? <Icon name="chevron" size={12} /> : null}</span>
              <Icon name={row.kind === 'dir' ? 'folder' : 'file'} size={14} className="code-tree-icon" />
              <span className="code-tree-name">{row.name}</span>
              {busy ? <span className="code-tree-aside">reading…</span> : null}
              {folder?.error ? <span className="code-tree-aside error-text">cannot be read</span> : null}
              {folder?.cut && isOpen ? <span className="code-tree-aside">first 1,000</span> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
