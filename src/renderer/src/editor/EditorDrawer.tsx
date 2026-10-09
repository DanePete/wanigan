// The code editor's drawer: beneath the view (or beside it), opened and
// closed with ⌘J, resized by its edge (or the arrow keys on it), with a tab
// for each open file and a dot on the unsaved ones. Closing an unsaved file
// asks first. The editor inside loads the first time a file shows, and stays
// loaded while the window is open, so every file keeps its undo history.
// Design: docs/design/2026-10-09-code-editor.md.
import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { ProjectSummary } from '@shared/model';
import { bridge, useQuery } from '../lib/api';
import { Icon } from '../components/icons';
import { Button, Dialog, Empty, IconButton } from '../components/ui';
import { MIN_SIZE, setPrefs, useEditorPrefs } from './prefs';
import { QuickOpen } from './QuickOpen';
import {
  closeQuickOpen, closeTab, currentSurface, focusBreadcrumbs, goBack, goForward, openQuickOpen, setEditorOpen, showTab, toggleEditor, useEditor,
  type EditorTab,
} from './store';
import '../styles/editor.css';

const CodeSurface = lazy(() => import('./code/CodeSurface'));
const STEP = 24;

export function EditorDrawer({ project }: { project: ProjectSummary | null }) {
  const editor = useEditor();
  const prefs = useEditorPrefs();
  const mac = bridge().platform === 'darwin';
  const tabs = project ? editor.tabs.filter((t) => t.projectId === project.id) : [];
  const activeKey = project ? editor.active[project.id] ?? null : null;
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const visible = !!project && editor.open;
  const cards = useQuery('cards.list', project && tabs.some((t) => t.cardId) ? { projectId: project.id } : null, ['board']);
  const [closing, setClosing] = useState<EditorTab | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (visible && active) setLoaded(true); }, [visible, active]);

  // ⌘⇧. moves to the breadcrumbs from anywhere while a file is open.
  useEffect(() => {
    if (!visible || !active) return undefined;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.code === 'Period' || e.key === '>' || e.key === '.')) { e.preventDefault(); focusBreadcrumbs(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, active, mac]);

  const rootLabel = (tab: EditorTab | null): string => {
    if (!project) return '';
    if (!tab?.cardId) return project.name;
    const key = cards.data?.find((c) => c.id === tab.cardId)?.key;
    return key ? `${key}’s worktree` : 'Card worktree';
  };
  const names = new Map<string, number>();
  for (const t of tabs) { const n = t.path.split('/').pop() ?? t.path; names.set(n, (names.get(n) ?? 0) + 1); }
  const unsavedHere = tabs.filter((t) => editor.unsaved.has(t.key)).length;

  const askClose = (tab: EditorTab): void => {
    if (editor.unsaved.has(tab.key)) { setClosing(tab); return; }
    currentSurface()?.discard(tab.key);
    closeTab(tab.key);
  };
  // Back and Forward: ⌃- and ⌃⇧- on a Mac (Alt+← and Alt+→ elsewhere), and the mouse's own back and forward buttons.
  const onKey = (e: KeyboardEvent): void => {
    if (!project) return;
    const minus = e.code === 'Minus' || e.key === '-' || e.key === '_';
    const back = mac ? e.ctrlKey && !e.metaKey && !e.altKey && minus && !e.shiftKey : e.altKey && e.key === 'ArrowLeft';
    const forward = mac ? e.ctrlKey && !e.metaKey && !e.altKey && minus && e.shiftKey : e.altKey && e.key === 'ArrowRight';
    if (back || forward) {
      e.preventDefault();
      if (back) goBack(project.id); else goForward(project.id);
      return;
    }
    // ⌘S from the tabs or the breadcrumbs, not only from the text.
    if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's' && active && !(e.target as HTMLElement).closest('.cm-editor')) {
      e.preventDefault();
      void currentSurface()?.save(active.key);
    }
  };
  const onMouse = (e: MouseEvent): void => {
    if (!project || (e.button !== 3 && e.button !== 4)) return;
    e.preventDefault();
    if (e.type === 'mouseup') { if (e.button === 3) goBack(project.id); else goForward(project.id); }
  };

  return (
    <>
      {project && !editor.open && tabs.length ? (
        <button type="button" className="editor-collapsed" onClick={() => setEditorOpen(true)} title={`Show the code editor (${mac ? '⌘J' : 'Ctrl+J'})`}>
          <Icon name="code" size={14} />
          <span>Code · {tabs.length === 1 ? (tabs[0]?.path.split('/').pop() ?? '') : `${tabs.length} files`}</span>
          {unsavedHere ? <span className="editor-collapsed-unsaved">{unsavedHere} unsaved</span> : null}
          <kbd>{mac ? '⌘J' : 'Ctrl+J'}</kbd>
        </button>
      ) : null}
      <section className="editor-drawer" data-dock={prefs.dock} hidden={!visible} aria-label="Code editor"
        style={prefs.dock === 'bottom' ? { height: prefs.height } : { width: prefs.width }}
        onKeyDown={onKey} onMouseDown={onMouse} onMouseUp={onMouse}>
        {project ? <Resizer dock={prefs.dock} size={prefs.dock === 'bottom' ? prefs.height : prefs.width} /> : null}
        {project ? (
          <header className="editor-head">
            <nav className="editor-tabs" aria-label="Open files">
              <ul>
                {tabs.map((t) => {
                  const name = t.path.split('/').pop() ?? t.path;
                  const dir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
                  const unsaved = editor.unsaved.has(t.key);
                  return (
                    <li key={t.key} className={`editor-tab${t.key === activeKey ? ' active' : ''}${unsaved ? ' unsaved' : ''}`}>
                      <button type="button" className="editor-tab-open" aria-current={t.key === activeKey ? 'true' : undefined} title={t.cardId ? `${rootLabel(t)}: ${t.path}` : t.path}
                        onClick={() => showTab(project.id, t.key)} onAuxClick={(e) => { if (e.button === 1) askClose(t); }}>
                        <span className="editor-tab-name">{name}</span>
                        {(names.get(name) ?? 0) > 1 && dir ? <span className="editor-tab-dir">{dir.split('/').pop()}</span> : null}
                        {t.cardId ? <span className="editor-tab-dir">{rootLabel(t).replace(/’s worktree$/, '')}</span> : null}
                        {unsaved ? <span className="editor-dot" aria-hidden="true" /> : null}
                        {unsaved ? <span className="visually-hidden">, unsaved</span> : null}
                      </button>
                      <button type="button" className="editor-tab-close" aria-label={`Close ${name}`} title={`Close ${name}`} onClick={() => askClose(t)}>
                        <Icon name="close" size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <div className="editor-actions">
              <IconButton icon="search" label={`Open a file (${mac ? '⌘P' : 'Ctrl+P'})`} onClick={() => openQuickOpen(null)} />
              <IconButton icon="save" label={`Save (${mac ? '⌘S' : 'Ctrl+S'})`} disabled={!active || !editor.unsaved.has(active.key)}
                onClick={() => { if (active) void currentSurface()?.save(active.key); }} />
              <IconButton icon="undo" label="Revert to the saved file" disabled={!active || !editor.unsaved.has(active.key)}
                onClick={() => { if (active) currentSurface()?.revert(active.key); }} />
              <IconButton icon={prefs.dock === 'bottom' ? 'dockRight' : 'dockBottom'} label={prefs.dock === 'bottom' ? 'Put the editor beside the view' : 'Put the editor beneath the view'}
                onClick={() => setPrefs({ dock: prefs.dock === 'bottom' ? 'right' : 'bottom' })} />
              <IconButton icon={prefs.dock === 'bottom' ? 'down' : 'forward'} label={`Hide the editor (${mac ? '⌘J' : 'Ctrl+J'})`} onClick={toggleEditor} />
            </div>
          </header>
        ) : null}
        {/* Always here, so the editor and its open files survive moving between views and projects. */}
        <div className="editor-body">
          {loaded ? (
            <Suspense fallback={<p className="editor-placeholder faint">Loading the editor…</p>}>
              <div className="editor-slot" hidden={!active}><CodeSurface tab={visible ? active : null} rootLabel={rootLabel(active)} /></div>
            </Suspense>
          ) : null}
          {project && !active ? (
            <Empty title="No file open" action={<Button tone="primary" icon="search" onClick={() => openQuickOpen(null)}>Open a file…</Button>}>
              {mac ? '⌘P' : 'Ctrl+P'} finds any file in {project.name}. Files open here from Changes, from a turn’s changes, and from a part picked in the live view.
            </Empty>
          ) : null}
        </div>
      </section>
      {project && editor.quick ? <QuickOpen project={project} cardKey={editor.quick.cardKey} onClose={closeQuickOpen} /> : null}
      {closing ? (
        <UnsavedDialog tab={closing} onClose={() => setClosing(null)}
          onDiscard={() => { currentSurface()?.discard(closing.key); closeTab(closing.key); setClosing(null); }}
          onSave={async () => {
            if (await currentSurface()?.save(closing.key)) { currentSurface()?.discard(closing.key); closeTab(closing.key); }
            setClosing(null);
          }} />
      ) : null}
    </>
  );
}

function UnsavedDialog({ tab, onClose, onDiscard, onSave }: { tab: EditorTab; onClose: () => void; onDiscard: () => void; onSave: () => Promise<void> }) {
  const name = tab.path.split('/').pop() ?? tab.path;
  return (
    <Dialog title={`Save the changes to ${name}?`} onClose={onClose} width={460} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="quiet" onClick={onDiscard}>Close without saving</Button>
        <Button tone="primary" icon="save" onClick={onSave} data-autofocus>Save and close</Button>
      </>
    )}>
      <p>{tab.path} has changes that are not saved. Closing it without saving throws them away.</p>
    </Dialog>
  );
}

/** The drawer's edge: drag it, or focus it and use the arrow keys, Home and End. */
function Resizer({ dock, size }: { dock: 'bottom' | 'right'; size: number }) {
  const drag = useRef<{ start: number; size: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? size;
  const limit = (): number => {
    const work = document.querySelector('.work')?.getBoundingClientRect();
    const room = work ? (dock === 'bottom' ? work.height : work.width) : 2000;
    // Beside the view, the view keeps room for its own bar and tabs.
    return Math.max(MIN_SIZE, room - (dock === 'bottom' ? MIN_SIZE : 640));
  };
  const clamp = (n: number): number => Math.round(Math.max(MIN_SIZE, Math.min(limit(), n)));
  const commit = (n: number): void => setPrefs(dock === 'bottom' ? { height: clamp(n) } : { width: clamp(n) });
  const apply = (n: number): void => {
    // Straight onto the drawer while dragging; the setting is written once, at the end.
    const el = document.querySelector<HTMLElement>('.editor-drawer:not([hidden])');
    if (el) el.style[dock === 'bottom' ? 'height' : 'width'] = `${clamp(n)}px`;
    setLive(clamp(n));
  };
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: dock === 'bottom' ? e.clientY : e.clientX, size };
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    apply(d.size - ((dock === 'bottom' ? e.clientY : e.clientX) - d.start));
  };
  const up = (): void => {
    if (drag.current && live !== null) commit(live);
    drag.current = null;
    setLive(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const grow = dock === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
    const shrink = dock === 'bottom' ? 'ArrowDown' : 'ArrowRight';
    const next = e.key === grow ? size + STEP : e.key === shrink ? size - STEP : e.key === 'Home' ? MIN_SIZE : e.key === 'End' ? limit() : null;
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };
  return (
    <div className="editor-resizer" role="separator" tabIndex={0} aria-orientation={dock === 'bottom' ? 'horizontal' : 'vertical'}
      aria-label="Resize the code editor" aria-valuenow={shown} aria-valuemin={MIN_SIZE} aria-valuemax={limit()}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={onKey}
      onDoubleClick={() => commit(size > 480 ? 340 : limit())} />
  );
}
