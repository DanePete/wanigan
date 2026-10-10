// The code editor's drawer: beneath the view (or beside it), opened and
// closed with ⌘J, resized by its edge (or the arrow keys on it), with a tab
// for each open file and a dot on the unsaved ones. Closing an unsaved file
// asks first. The editor inside loads the first time a file shows, and stays
// loaded while the window is open, so every file keeps its undo history.
//
// On a project's Code tab (`page`) the same drawer is the view: it fills the
// project's view area beside the project's files, and the drawer's own open
// or closed, height and dock are left as they were, to come back when the tab
// is left. One editor, never a second: nothing here remounts between the two.
//
// In the live view the drawer is its dock: tabs for Code and for what the view
// adds (its notes, problems and request, drawn here by components/live/Dock.tsx
// through `useDockHost`). Closed there, a strip of those tabs stays under the
// page; ⇧[ and ⇧] open it, then step through them. ⌘J stays the code editor's.
// Design: docs/design/2026-10-09-code-editor.md, docs/design/2026-10-08-live-view.md.
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { ProjectSummary } from '@shared/model';
import { shortcutFor } from '@shared/shortcuts';
import { bridge, useQuery } from '../lib/api';
import { Icon } from '../components/icons';
import { Button, Dialog, Empty, IconButton, KeyCaps, Segmented } from '../components/ui';
import { ViewBoundary } from '../components/ViewBoundary';
import { FileTree, focusFileTree } from './FileTree';
import { MIN_SIZE, setPrefs, useEditorPrefs } from './prefs';
import { QuickOpen } from './QuickOpen';
import {
  CODE_TAB, closeQuickOpen, closeTab, currentSurface, dockShows, dockTabs, focusBreadcrumbs, goBack, goForward, openQuickOpen, setDockHost, setEditorOpen, setEditorPage,
  showDock, showTab, toggleEditor, useEditor, type EditorTab,
} from './store';
import '../styles/editor.css';

const CodeSurface = lazy(() => import('./code/CodeSurface'));
const STEP = 24;

export function EditorDrawer({ project, page = false }: {
  project: ProjectSummary | null;
  /** The project's Code tab is showing: the editor is the view. */
  page?: boolean;
}) {
  const editor = useEditor();
  const prefs = useEditorPrefs();
  const mac = bridge().platform === 'darwin';
  const tabs = project ? editor.tabs.filter((t) => t.projectId === project.id) : [];
  const activeKey = project ? editor.active[project.id] ?? null : null;
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const onPage = !!project && page;
  // The dock's tab here (null: one only another view has, so the drawer steps aside until that view is back).
  const shows = dockShows(editor);
  const docked = dockTabs(editor);
  const visible = !!project && (onPage || (editor.open && shows !== null));
  // The code editor itself shows: on the Code tab, or in the drawer on its Code tab.
  const code = onPage || shows === CODE_TAB.id;
  const codeShown = visible && code;
  const what = docked.length > 1 ? 'dock' : 'editor';
  // Before paint, so a file opened from the tab's tree never opens the drawer behind it.
  useLayoutEffect(() => { setEditorPage(onPage); }, [onPage]);
  const cards = useQuery('cards.list', project && tabs.some((t) => t.cardId) ? { projectId: project.id } : null, ['board']);
  const [closing, setClosing] = useState<EditorTab | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (codeShown && active) setLoaded(true); }, [codeShown, active]);

  // ⌘⇧. moves to the breadcrumbs from anywhere while a file is open.
  useEffect(() => {
    if (!codeShown || !active) return undefined;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.code === 'Period' || e.key === '>' || e.key === '.')) { e.preventDefault(); focusBreadcrumbs(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [codeShown, active, mac]);

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
    // On another of the dock's tabs these keys are that tab's.
    if (!project || !code) return;
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
    if (!project || !code || (e.button !== 3 && e.button !== 4)) return;
    e.preventDefault();
    if (e.type === 'mouseup') { if (e.button === 3) goBack(project.id); else goForward(project.id); }
  };

  const files = tabs.length === 1 ? (tabs[0]?.path.split('/').pop() ?? '') : `${tabs.length} files`;
  return (
    <>
      {project && !visible && !onPage && docked.length > 1 ? (
        // The live view's dock, closed: its tabs stay under the page, each opening it there.
        <div className="dock-collapsed dock-tabs" role="group" aria-label="The dock beneath the page, closed: open it on">
          {docked.map((t) => (
            <button key={t.id} type="button" className="dock-collapsed-tab" onClick={() => showDock(t.id)}
              title={t.id === CODE_TAB.id ? `The code editor (${mac ? '⌘J' : 'Ctrl+J'})` : t.hint ?? `Open the dock on ${t.label}`}>
              {t.id === CODE_TAB.id ? <Icon name="code" size={14} /> : null}
              <span>{t.id === CODE_TAB.id && tabs.length ? `Code · ${files}` : t.label}</span>
              {t.id === CODE_TAB.id && unsavedHere ? <span className="editor-collapsed-unsaved">{unsavedHere} unsaved</span> : null}
            </button>
          ))}
          <span className="dock-collapsed-keys faint" aria-hidden="true"><kbd>⇧[</kbd> <kbd>⇧]</kbd></span>
        </div>
      ) : project && !visible && !onPage && tabs.length ? (
        <button type="button" className="editor-collapsed" onClick={() => showDock(CODE_TAB.id)} title={`Show the code editor (${mac ? '⌘J' : 'Ctrl+J'})`}>
          <Icon name="code" size={14} />
          <span>Code · {files}</span>
          {unsavedHere ? <span className="editor-collapsed-unsaved">{unsavedHere} unsaved</span> : null}
          <kbd>{mac ? '⌘J' : 'Ctrl+J'}</kbd>
        </button>
      ) : null}
      <section className="editor-drawer" data-mode={onPage ? 'page' : 'drawer'} data-dock={onPage ? undefined : prefs.dock} data-shows={onPage ? undefined : shows ?? undefined}
        hidden={!visible} aria-label={what === 'dock' ? 'The dock beneath the page' : 'Code editor'}
        style={onPage ? undefined : prefs.dock === 'bottom' ? { height: prefs.height } : { width: prefs.width }}
        onKeyDown={onKey} onMouseDown={onMouse} onMouseUp={onMouse}>
        {/* Each child keeps its place in both modes, so the editor below is never mounted again. */}
        {project && !onPage ? <Resizer dock={prefs.dock} size={prefs.dock === 'bottom' ? prefs.height : prefs.width} what={what} /> : null}
        {project && onPage ? (
          // Its own boundary: if the files break, the editor beside them (and anything unsaved in it) stays.
          <ViewBoundary name="The project’s files" compact resetKey={`${project.id}|${active?.cardId ?? ''}`} frame={(panel) => <div className="code-tree">{panel}</div>}>
            <FileTree key={`${project.id}|${active?.cardId ?? ''}`} projectId={project.id} cardId={active?.cardId ?? null}
              label={rootLabel(active)} activePath={active?.path ?? null} />
          </ViewBoundary>
        ) : null}
        {project ? (
          <header className="editor-head">
            {!onPage && docked.length > 1 ? (
              <div className="dock-tabs">
                <Segmented<string> size="s" label="Show in the dock" value={shows ?? CODE_TAB.id} options={docked.map((t) => ({ value: t.id, label: t.label, hint: t.hint }))} onChange={showDock} />
              </div>
            ) : null}
            {code ? (
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
            ) : <span className="dock-head-fill" />}
            <div className="editor-actions">
              {code ? (
                <>
                  <IconButton icon="search" label={`Open a file (${mac ? '⌘P' : 'Ctrl+P'})`} onClick={() => openQuickOpen(null)} />
                  <IconButton icon="save" label={`Save (${mac ? '⌘S' : 'Ctrl+S'})`} disabled={!active || !editor.unsaved.has(active.key)}
                    onClick={() => { if (active) void currentSurface()?.save(active.key); }} />
                  <IconButton icon="undo" label="Revert to the saved file" disabled={!active || !editor.unsaved.has(active.key)}
                    onClick={() => { if (active) currentSurface()?.revert(active.key); }} />
                </>
              ) : null}
              {onPage ? null : (
                <>
                  <IconButton icon={prefs.dock === 'bottom' ? 'dockRight' : 'dockBottom'} label={prefs.dock === 'bottom' ? `Put the ${what} beside the view` : `Put the ${what} beneath the view`}
                    onClick={() => setPrefs({ dock: prefs.dock === 'bottom' ? 'right' : 'bottom' })} />
                  {/* ⌘J is the code editor's: from another tab it shows the editor, so the dock's own Hide says no key there. */}
                  <IconButton icon={prefs.dock === 'bottom' ? 'down' : 'forward'} label={code ? `Hide the ${what} (${mac ? '⌘J' : 'Ctrl+J'})` : 'Hide the dock'}
                    onClick={() => (code ? toggleEditor() : setEditorOpen(false))} />
                </>
              )}
            </div>
          </header>
        ) : null}
        {/* Always here, so the editor and its open files survive moving between views and projects. */}
        <div className="editor-body" hidden={!code}>
          {loaded ? (
            <Suspense fallback={<p className="editor-placeholder faint">Loading the editor…</p>}>
              <div className="editor-slot" hidden={!active}><CodeSurface tab={codeShown ? active : null} rootLabel={rootLabel(active)} layout={onPage ? 'page' : 'drawer'} /></div>
            </Suspense>
          ) : null}
          {project && !active && onPage ? (
            // The tab with nothing open: one line, and the two ways to open something.
            <p className="code-empty">
              No file open. <button type="button" className="linkish" onClick={() => openQuickOpen(null)}>Find one by name</button>{' '}
              <KeyCaps shortcut={shortcutFor('quick-open')!} mac={mac} />, or{' '}
              <button type="button" className="linkish" onClick={focusFileTree}>choose one from the files</button>.
            </p>
          ) : project && !active ? (
            <Empty title="No file open" action={<Button tone="primary" icon="search" onClick={() => openQuickOpen(null)}>Open a file…</Button>}>
              {mac ? '⌘P' : 'Ctrl+P'} finds any file in {project.name}. Files open here from Changes, from a turn’s changes, and from a part picked in the live view.
            </Empty>
          ) : null}
        </div>
        {/* What the view on screen shows in its own dock tab (the live view's notes, problems, request): drawn here through a portal. */}
        <div className="dock-panel" ref={setDockHost} hidden={code} role="region" aria-label={docked.find((t) => t.id === shows)?.label.replace(/\s\d+$/, '') ?? 'The dock'} />
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
function Resizer({ dock, size, what }: { dock: 'bottom' | 'right'; size: number; what: 'dock' | 'editor' }) {
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
      aria-label={what === 'dock' ? 'Resize the dock' : 'Resize the code editor'} aria-valuenow={shown} aria-valuemin={MIN_SIZE} aria-valuemax={limit()}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={onKey}
      onDoubleClick={() => commit(size > 480 ? 340 : limit())} />
  );
}
