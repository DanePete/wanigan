// The editor inside the drawer, loaded the first time a file shows. One
// CodeMirror view for every open file; above it the breadcrumbs and whatever
// needs saying about the file (someone else's code, someone else's change, an
// unsaved draft brought back), below it where the cursor is and how the file
// is written.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { indentUnit as indentUnitFacet } from '@codemirror/language';
import { gotoLine } from '@codemirror/search';
import { bridge } from '../../lib/api';
import { ago } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, IconButton, useToast } from '../../components/ui';
import { setPrefs, useEditorPrefs } from '../prefs';
import { attachSurface, revealDone, useEditor, type EditorTab } from '../store';
import { Breadcrumbs } from './Breadcrumbs';
import { Comparison } from './Comparison';
import { Controller, type Banner, type DocSession } from './controller';

export default function CodeSurface({ tab, rootLabel }: { tab: EditorTab | null; rootLabel: string }) {
  const toast = useToast();
  const mac = bridge().platform === 'darwin';
  const hintId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const host = useRef<HTMLDivElement>(null);
  const [controller, setController] = useState<Controller | null>(null);
  const prefs = useEditorPrefs();
  const editor = useEditor();
  const wrapRef = useRef(prefs.wrap);
  wrapRef.current = prefs.wrap;

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const c = new Controller(el, { mac, hintId: `${hintId}-hint`, toast, toggleWrap: () => setPrefs({ wrap: !wrapRef.current }) });
    setController(c);
    attachSurface({
      save: (key) => c.save(key),
      revert: (key) => c.revert(key),
      discard: (key) => c.discard(key),
      spot: (projectId) => c.spot(projectId),
    });
    return () => { attachSurface(null); c.destroy(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.snapshot ?? zero);
  useEffect(() => { controller?.show(tab); }, [controller, tab]);
  const session = tab && controller ? controller.sessions.get(tab.key) ?? null : null;

  // A reveal for this project's file: put the cursor there once it is ready.
  const reveal = editor.reveal;
  useEffect(() => {
    if (!controller || !reveal || !tab || reveal.key !== tab.key) return;
    void controller.reveal(reveal).then(() => revealDone(reveal.seq));
  }, [controller, reveal, tab]);

  // Asked to (⌘J, a file opened, Edit code): the cursor goes into the text, once the file is there to type in.
  const wantFocus = useRef(0);
  if (editor.focusEditor !== wantFocus.current && editor.focusEditor > 0) wantFocus.current = editor.focusEditor;
  const focused = useRef(0);
  useEffect(() => {
    if (!controller || session?.status !== 'ready' || session.comparison || focused.current === wantFocus.current) return;
    focused.current = wantFocus.current;
    requestAnimationFrame(() => controller.view.focus());
  }, [controller, session?.status, session?.tab.key, session?.comparison, editor.focusEditor]);

  useEffect(() => { if (controller?.active) void controller.applyPrefs(controller.active); }, [controller, prefs.wrap, prefs.vim, session?.status]);

  const ready = session?.status === 'ready';
  return (
    <div className="editor-surface">
      <p id={`${hintId}-hint`} className="visually-hidden">Escape, then Tab, moves out of the editor. {mac ? '⌘S' : 'Ctrl+S'} saves.</p>
      {session && controller ? <Breadcrumbs controller={controller} session={session} rootLabel={rootLabel} focusSignal={editor.focusCrumbs} mac={mac} /> : null}
      {session && controller ? <Notices controller={controller} session={session} /> : null}
      <div className="editor-code" ref={host} hidden={!ready || !!session?.comparison} />
      {session?.comparison && controller ? (
        <Comparison comparison={session.comparison} path={session.tab.path}
          onSave={(text) => void controller.finishMerge(session.tab.key, text)}
          onTheirs={() => controller.useTheirs(session.tab.key)}
          onClose={() => controller.closeComparison(session.tab.key)} />
      ) : null}
      {session?.status === 'loading' ? <p className="editor-placeholder faint">Opening {session.tab.path}…</p> : null}
      {session?.status === 'failed' && controller ? (
        <div className="editor-placeholder" role="alert">
          <p className="error-text">{session.error}</p>
          <Button size="s" icon="refresh" onClick={() => controller.retry(session.tab.key)}>Try again</Button>
        </div>
      ) : null}
      {ready && controller ? <StatusBar controller={controller} session={session} /> : null}
    </div>
  );
}

const noSubscribe = (): (() => void) => () => {};
const zero = (): number => 0;

/** What needs saying about the file, above its text: never more than one thing, the most important. */
function Notices({ controller, session }: { controller: Controller; session: DocSession }) {
  const key = session.tab.key;
  const file = session.file;
  if (session.comparison) return null;
  const banner = session.banner;
  if (banner) return <Notice banner={banner} controller={controller} tabKey={key} />;
  if (file?.readOnly && !session.anyway) {
    return (
      <div className="editor-notice editor-notice-locked" role="note">
        <Icon name="eye" size={14} />
        <span className="editor-notice-text"><strong>Read-only.</strong> {file.readOnly}</span>
        {file.guard !== 'unwritable' ? <Button size="s" tone="quiet" icon="pencil" onClick={() => controller.editAnyway(key)}>Edit anyway</Button> : null}
      </div>
    );
  }
  if (file?.readOnly && session.anyway) {
    return (
      <div className="editor-notice editor-notice-locked" role="note">
        <Icon name="pencil" size={14} />
        <span className="editor-notice-text">Editing someone else’s code: a change here is lost when it updates.</span>
      </div>
    );
  }
  return null;
}

function Notice({ banner, controller, tabKey }: { banner: Banner; controller: Controller; tabKey: string }) {
  const close = <IconButton icon="close" label="Dismiss" onClick={() => controller.dismiss(tabKey)} />;
  switch (banner.kind) {
    case 'reloaded':
      return (
        <div className="editor-notice" role="status">
          <Icon name="refresh" size={14} />
          <span className="editor-notice-text"><strong>{banner.who} changed this file.</strong> You had nothing unsaved, so it shows the new version.</span>
          <Button size="s" tone="quiet" onClick={() => controller.compare(tabKey)}>Compare</Button>
          {close}
        </div>
      );
    case 'changed':
    case 'conflict':
      return (
        <div className="editor-notice editor-notice-strong" role="alert">
          <Icon name="merge" size={14} />
          <span className="editor-notice-text">
            <strong>{banner.who} changed this file{banner.kind === 'conflict' ? ' before your save' : ' while you were editing it'}.</strong> Your changes are not saved yet.
          </span>
          <Button size="s" tone="primary" onClick={() => controller.compare(tabKey)}>Compare and merge</Button>
          <Button size="s" tone="quiet" onClick={() => controller.useTheirs(tabKey)}>Reload theirs</Button>
          <Button size="s" tone="quiet" onClick={() => void controller.overwrite(tabKey)}>Save mine over it</Button>
        </div>
      );
    case 'draft':
      return (
        <div className="editor-notice" role="status">
          <Icon name="clock" size={14} />
          <span className="editor-notice-text">Your unsaved changes from {ago(banner.at)} are back. Save them, or Revert to the file as saved.</span>
          {close}
        </div>
      );
    case 'old-draft':
      return (
        <div className="editor-notice" role="status">
          <Icon name="clock" size={14} />
          <span className="editor-notice-text">You have unsaved changes from {ago(banner.at)}, made before this file last changed.</span>
          <Button size="s" tone="quiet" onClick={() => controller.compare(tabKey)}>Compare and merge</Button>
          <Button size="s" tone="quiet" onClick={() => controller.forgetDraft(tabKey)}>Throw them away</Button>
        </div>
      );
    case 'gone':
      return (
        <div className="editor-notice editor-notice-strong" role="alert">
          <Icon name="alert" size={14} />
          <span className="editor-notice-text"><strong>This file is gone from disk</strong> (deleted, moved or renamed). Its text is still here to copy; saving cannot bring it back.</span>
          {close}
        </div>
      );
  }
}

/** Where the cursor is and how the file is written; wrap and Vim are switched here. */
function StatusBar({ controller, session }: { controller: Controller; session: DocSession }) {
  useSyncExternalStore(controller.subscribeCursor, controller.cursorSnapshot);
  const prefs = useEditorPrefs();
  const state = controller.stateOf(session);
  if (!state || !session.file) return null;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const count = state.selection.ranges.length;
  const chosen = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  const unit = state.facet(indentUnitFacet);
  const file = session.file;
  return (
    <footer className="editor-status" aria-label="About this file">
      <button type="button" className="editor-status-item linkish" title="Go to a line (⌃G)" onClick={() => { gotoLine(controller.view); }}>
        Line {line.number}, column {main.head - line.from + 1}
      </button>
      {count > 1 ? <span className="editor-status-item">{count} cursors</span> : chosen ? <span className="editor-status-item">{chosen} selected</span> : null}
      <span className="editor-status-item editor-status-saving" aria-live="polite">{session.saving ? 'Saving…' : ''}</span>
      <span className="editor-status-end">
        <span className="editor-status-item">{session.language}</span>
        <span className="editor-status-item" title="Indentation, read from the file">{unit === '\t' ? 'Tabs' : `${unit.length} spaces`}</span>
        <span className="editor-status-item" title={file.mixedEol ? 'This file mixes line endings; it is saved with the commoner one' : 'Line endings, kept as the file has them'}>
          {file.eol === 'crlf' ? 'CRLF' : 'LF'}{file.mixedEol ? ' (mixed)' : ''}
        </span>
        <span className="editor-status-item">UTF-8{file.bom ? ' with BOM' : ''}</span>
        <button type="button" className="editor-status-toggle" aria-pressed={prefs.wrap} title="Wrap long lines (⌥Z)" onClick={() => setPrefs({ wrap: !prefs.wrap })}>
          Wrap
        </button>
        <button type="button" className="editor-status-toggle" aria-pressed={prefs.vim} title="Vim keys" onClick={() => setPrefs({ vim: !prefs.vim })}>
          Vim
        </button>
      </span>
    </footer>
  );
}
