// One CodeMirror editor for the drawer, and the open files behind it. Each
// file keeps its own editor state (text, undo history, cursor, scroll) while
// another shows. A file is read through the core, saved through the core with
// the version it was made from, and watched while it is open: an agent's edit
// (the live event names the file at once) or any other program's (noticed by
// polling the file's hash) either reloads an unchanged file, saying who
// changed it, or, when the owner has unsaved changes, says so and offers to
// compare and merge. Unsaved text is kept on this Mac until it is saved or
// thrown away, so closing the window loses nothing.
import { Annotation, EditorState, Transaction, type Extension, type StateEffect, type Text, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { detectIndent, type FileEditor, type FileText } from '@shared/files';
import type { NavSpot } from '@shared/nav-history';
import { bridge, call } from '../../lib/api';
import { PROVIDER_LABEL } from '../../lib/format';
import { editorPrefs } from '../prefs';
import { arrived, forgetPlaces, markUnsaved, type EditorTab, type Reveal } from '../store';
import { languageOf } from './languages';
import { findWords, minimalChange } from './text.ts';
import { baseExtensions, indentation, labelled, readOnly, slots, vimKeys, wrapping } from './setup';

/** Ours: a move the editor made itself (Back, a reveal), not one to remember as a jump. */
const navigating = Annotation.define<boolean>();
/** A reload from disk: not the owner's typing, so not in the undo history either. */
const fromDisk = Annotation.define<boolean>();

const POLL_MS = 2_500;
const DRAFT_MS = 700;
/** Unsaved text larger than this is not kept between windows: storage is small. */
const MAX_DRAFT = 1_000_000;
/** A move of the cursor this many lines or more is a jump Back returns from. */
const JUMP_LINES = 10;

export type Banner =
  | { kind: 'reloaded'; who: string; before: string }
  | { kind: 'changed'; who: string; theirs: FileText }
  | { kind: 'conflict'; who: string; theirs: FileText }
  | { kind: 'draft'; at: number }
  | { kind: 'old-draft'; at: number; text: string }
  | { kind: 'gone' };

/** Two versions side by side: to look at what changed, or to merge (the right side is the result). */
export interface Comparison {
  title: string;
  left: { label: string; text: string };
  right: { label: string; text: string };
  merge: boolean;
  /** For a merge: the version on disk the result replaces. */
  base: FileText | null;
}

export interface DocSession {
  tab: EditorTab;
  status: 'loading' | 'ready' | 'failed';
  error: string | null;
  /** The file as last read or saved: what a save says it was made from. */
  file: FileText | null;
  state: EditorState | null;
  /** The text as on disk, to tell unsaved changes from none. */
  saved: Text | null;
  anyway: boolean;
  banner: Banner | null;
  comparison: Comparison | null;
  saving: boolean;
  language: string;
  scroll: StateEffect<unknown> | null;
  /** When the file was last known to match `file`. */
  syncedAt: number;
  checking: boolean;
  /** The settings this state was last configured with. */
  applied: { wrap: boolean; vim: boolean };
}

const draftKey = (key: string): string => `wanigan.editor.draft:${key}`;

function readDraft(key: string): { hash: string; text: string; at: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(key)) ?? 'null') as { hash?: unknown; text?: unknown; at?: unknown } | null;
    return raw && typeof raw.hash === 'string' && typeof raw.text === 'string' && typeof raw.at === 'number' ? { hash: raw.hash, text: raw.text, at: raw.at } : null;
  } catch { return null; }
}
function writeDraft(key: string, draft: { hash: string; text: string; at: number } | null): void {
  try {
    if (draft && draft.text.length <= MAX_DRAFT) localStorage.setItem(draftKey(key), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(key));
  } catch { /* storage full or unavailable: the text is still in the editor */ }
}

/** Who changed a file, as the banner says it: the agent session whose hook reported it, if it did lately. */
export function whoChanged(editor: FileEditor | null, since: number): string {
  if (editor && editor.at >= since - 5_000) return `${PROVIDER_LABEL[editor.provider]} (${editor.title})`;
  return 'Another program';
}

export interface ControllerOptions {
  mac: boolean;
  /** ⌥Z in the editor: wrap long lines, or not (a setting of the editor, kept by the drawer). */
  toggleWrap: () => void;
  hintId: string;
  toast: (message: string, tone?: 'info' | 'error') => void;
}

export class Controller {
  readonly view: EditorView;
  readonly sessions = new Map<string, DocSession>();
  activeKey: string | null = null;
  /** Bumped when anything the surface shows changes; `cursor` when only the cursor moved. */
  version = 0;
  cursor = 0;
  private readonly listeners = new Set<() => void>();
  private readonly cursorListeners = new Set<() => void>();
  private readonly options: ControllerOptions;
  private readonly timers = new Map<string, number>();
  private poller: number | null = null;
  private offEvents: (() => void) | null = null;
  private cursorFrame = 0;
  private vim: Extension | null = null;

  constructor(host: HTMLElement, options: ControllerOptions) {
    this.options = options;
    this.view = new EditorView({ parent: host, state: EditorState.create({ doc: '' }) });
    this.poller = window.setInterval(() => { if (document.hasFocus()) this.checkAll(); }, POLL_MS);
    const onFocus = (): void => this.checkAll();
    window.addEventListener('focus', onFocus);
    const off = bridge().on((event, data) => {
      // An agent wrote files: those open here are looked at now, not at the next poll.
      if (event === 'live') {
        const e = data as { kind: string; paths: string[]; sessionId: string | null };
        if (e.kind !== 'edit' || e.sessionId === null) return;
        for (const s of this.sessions.values()) {
          if (s.file && e.paths.includes(`${s.file.root}/${s.tab.path}`)) window.setTimeout(() => void this.check(s), 150);
        }
      }
    });
    this.offEvents = () => { off(); window.removeEventListener('focus', onFocus); };
  }

  destroy(): void {
    if (this.poller !== null) window.clearInterval(this.poller);
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.offEvents?.();
    cancelAnimationFrame(this.cursorFrame);
    this.view.destroy();
  }

  /* ── subscriptions for the surface ─────────────────────────────────── */

  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  snapshot = (): number => this.version;
  subscribeCursor = (l: () => void): (() => void) => { this.cursorListeners.add(l); return () => this.cursorListeners.delete(l); };
  cursorSnapshot = (): number => this.cursor;

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
  private moved(): void {
    cancelAnimationFrame(this.cursorFrame);
    this.cursorFrame = requestAnimationFrame(() => { this.cursor++; for (const l of this.cursorListeners) l(); });
  }

  get active(): DocSession | null {
    return this.activeKey ? this.sessions.get(this.activeKey) ?? null : null;
  }

  /** A session's current state: the view's, for the one showing. */
  stateOf(s: DocSession): EditorState | null {
    return s.tab.key === this.activeKey && s.status === 'ready' ? this.view.state : s.state;
  }

  private dispatch(s: DocSession, spec: TransactionSpec): void {
    if (s.tab.key === this.activeKey && s.status === 'ready') this.view.dispatch(spec);
    else if (s.state) s.state = s.state.update(spec).state;
  }

  isUnsaved(s: DocSession): boolean {
    const state = this.stateOf(s);
    return !!state && !!s.saved && !state.doc.eq(s.saved);
  }

  /* ── showing a file ─────────────────────────────────────────────────── */

  /** Show a file, reading it first if it is not open yet. */
  show(tab: EditorTab | null): void {
    if (tab?.key === this.activeKey) return;
    const leaving = this.active;
    if (leaving?.status === 'ready') {
      leaving.state = this.view.state;
      leaving.scroll = this.view.scrollSnapshot();
    }
    this.activeKey = tab?.key ?? null;
    if (!tab) { this.changed(); return; }
    let s = this.sessions.get(tab.key);
    if (!s) {
      s = {
        tab, status: 'loading', error: null, file: null, state: null, saved: null, anyway: false, banner: null, comparison: null,
        saving: false, language: languageOf(tab.path)?.label ?? 'Plain text', scroll: null, syncedAt: Date.now(), checking: false,
        applied: { wrap: false, vim: false },
      };
      this.sessions.set(tab.key, s);
      void this.load(s);
    } else if (s.status === 'ready') {
      this.mount(s);
    }
    this.changed();
  }

  /** Put a ready session's state in the view, with the settings as they are now. */
  private mount(s: DocSession): void {
    if (!s.state) return;
    this.view.setState(s.state);
    if (s.scroll) this.view.dispatch({ effects: s.scroll });
    void this.applyPrefs(s);
    this.moved();
  }

  private async load(s: DocSession): Promise<void> {
    s.status = 'loading';
    s.error = null;
    this.changed();
    let file: FileText;
    try {
      file = await call('files.read', { projectId: s.tab.projectId, cardId: s.tab.cardId, path: s.tab.path });
    } catch (error) {
      s.status = 'failed';
      s.error = (error as Error).message;
      this.changed();
      return;
    }
    s.file = file;
    s.syncedAt = Date.now();
    const indent = detectIndent(file.text);
    const label = `${s.tab.path}, ${s.language}`;
    let doc = file.text;
    const draft = readDraft(s.tab.key);
    if (draft && draft.text !== file.text) {
      if (draft.hash === file.hash) { doc = draft.text; s.banner = { kind: 'draft', at: draft.at }; }
      else s.banner = { kind: 'old-draft', at: draft.at, text: draft.text };
    } else if (draft) writeDraft(s.tab.key, null);
    const state = EditorState.create({
      doc,
      extensions: [
        baseExtensions({ save: () => void this.save(s.tab.key), toggleWrap: this.options.toggleWrap, mac: this.options.mac, label, describedBy: this.options.hintId }),
        EditorView.updateListener.of((u) => this.onUpdate(s, u)),
      ],
    });
    s.saved = EditorState.create({ doc: file.text }).doc;
    s.state = state.update({ effects: [
      slots.indent.reconfigure(indentation(indent.unit, indent.tabSize)),
      slots.readOnly.reconfigure(readOnly(!!file.readOnly && !s.anyway)),
      slots.label.reconfigure(labelled(label, this.options.hintId)),
    ] }).state;
    s.status = 'ready';
    markUnsaved(s.tab.key, doc !== file.text);
    if (s.tab.key === this.activeKey) this.mount(s);
    this.changed();
    const lang = languageOf(s.tab.path);
    if (lang) {
      try {
        const ext = await lang.load();
        this.dispatch(s, { effects: slots.language.reconfigure(ext) });
      } catch { /* a language that fails to load leaves the file plain, still editable */ }
    }
  }

  /** Read a file that failed to open, again. */
  retry(key: string): void {
    const s = this.sessions.get(key);
    if (s) void this.load(s);
  }

  /** Wrap and Vim are settings of the editor, not of a file: a file shown again gets them as they are now. */
  async applyPrefs(s: DocSession): Promise<void> {
    const prefs = editorPrefs();
    const effects: StateEffect<unknown>[] = [];
    if (s.applied.wrap !== prefs.wrap) effects.push(slots.wrap.reconfigure(wrapping(prefs.wrap)));
    if (s.applied.vim !== prefs.vim) {
      if (prefs.vim && !this.vim) {
        try { this.vim = await vimKeys(); } catch { this.options.toast('Vim keys could not be loaded.', 'error'); return; }
      }
      effects.push(slots.vim.reconfigure(prefs.vim && this.vim ? this.vim : []));
    }
    s.applied = { wrap: prefs.wrap, vim: prefs.vim };
    if (effects.length) this.dispatch(s, { effects });
  }


  /* ── moving around ──────────────────────────────────────────────────── */

  spotOf(s: DocSession, state = this.stateOf(s)): NavSpot | null {
    if (!state) return null;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { key: s.tab.key, path: s.tab.path, line: line.number, col: head - line.from + 1 };
  }

  /** Where the cursor is in the file showing, if that file is in `projectId`. */
  spot(projectId: string): NavSpot | null {
    const s = this.active;
    return s && s.tab.projectId === projectId && s.status === 'ready' ? this.spotOf(s) : null;
  }

  /** Put the cursor where a reveal asks, once the file is ready, and remember the jump. */
  async reveal(r: Reveal): Promise<void> {
    const s = this.sessions.get(r.key);
    if (!s) return;
    for (let i = 0; s.status === 'loading' && i < 200; i++) await new Promise((done) => window.setTimeout(done, 25));
    if (s.status !== 'ready' || !s.state) return;
    const state = this.stateOf(s) as EditorState;
    let pos: number | null = null;
    if (r.line) {
      const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, r.line)));
      pos = line.from + Math.max(0, Math.min(line.length, (r.col ?? 1) - 1));
    } else if (r.find) {
      pos = findWords(state.doc.toString(), r.find);
    }
    if (pos !== null) {
      this.dispatch(s, {
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        annotations: navigating.of(true),
      });
    }
    if (r.record) {
      const to = this.spotOf(s);
      if (to) arrived(s.tab.projectId, r.from, to);
    }
  }

  /** A jump inside the showing file (a breadcrumb, a symbol): move there and remember it. */
  jump(pos: number, select?: { from: number; to: number }): void {
    const s = this.active;
    if (!s || s.status !== 'ready') return;
    const from = this.spotOf(s);
    this.view.dispatch({
      selection: select ? { anchor: select.from, head: select.to } : { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      annotations: navigating.of(true),
    });
    const to = this.spotOf(s);
    if (to) arrived(s.tab.projectId, from, to);
    this.view.focus();
  }

  private onUpdate(s: DocSession, u: ViewUpdate): void {
    if (u.docChanged) this.later(`dirty:${s.tab.key}`, 120, () => this.noteUnsaved(s));
    // The breadcrumbs follow the cursor, and the parse as it finishes in the background.
    if (u.selectionSet || u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.moved();
    if (!u.selectionSet || u.docChanged) return;
    // Long moves, search results and go to line are jumps Back returns from; typing and a nudge are not.
    for (const tr of u.transactions) {
      if (!tr.selection || tr.annotation(navigating) || tr.annotation(fromDisk)) continue;
      const event = tr.annotation(Transaction.userEvent);
      const before = tr.startState.doc.lineAt(tr.startState.selection.main.head).number;
      const after = tr.state.doc.lineAt(tr.state.selection.main.head).number;
      if (before === after) continue;
      const jump = event === 'select.search' || event === undefined || Math.abs(after - before) >= JUMP_LINES;
      if (!jump || event?.startsWith('input')) continue;
      const from = this.spotOf(s, tr.startState);
      const to = this.spotOf(s, tr.state);
      if (from && to) arrived(s.tab.projectId, from, to);
    }
  }

  private later(id: string, ms: number, run: () => void): void {
    const t = this.timers.get(id);
    if (t !== undefined) window.clearTimeout(t);
    this.timers.set(id, window.setTimeout(() => { this.timers.delete(id); run(); }, ms));
  }

  private noteUnsaved(s: DocSession): void {
    const unsaved = this.isUnsaved(s);
    markUnsaved(s.tab.key, unsaved);
    this.later(`draft:${s.tab.key}`, DRAFT_MS, () => {
      const state = this.stateOf(s);
      if (!state || !s.file) return;
      writeDraft(s.tab.key, this.isUnsaved(s) ? { hash: s.file.hash, text: state.doc.toString(), at: Date.now() } : null);
    });
    this.changed();
  }

  /* ── saving ─────────────────────────────────────────────────────────── */

  /** Save a file; false when nothing was written (refused, or someone else's change came first). */
  async save(key: string, over: FileText | null = null): Promise<boolean> {
    const s = this.sessions.get(key);
    const state = s ? this.stateOf(s) : null;
    if (!s || !s.file || !state || s.saving) return false;
    if (s.file.readOnly && !s.anyway) {
      this.options.toast(`${s.tab.path} is read-only: ${s.file.readOnly}`, 'error');
      return false;
    }
    const doc = state.doc;
    s.saving = true;
    this.changed();
    try {
      const result = await call('files.write', {
        projectId: s.tab.projectId, cardId: s.tab.cardId, path: s.tab.path, text: doc.toString(),
        baseHash: (over ?? s.file).hash, ...(s.anyway ? { anyway: true } : {}),
      });
      if (!result.saved) {
        s.banner = { kind: 'conflict', who: whoChanged(result.current.lastEdit, s.syncedAt), theirs: result.current };
        this.openMerge(s, result.current);
        return false;
      }
      s.file = { ...(over ?? s.file), text: doc.toString(), hash: result.hash, size: result.size, mtime: result.mtime };
      s.saved = doc;
      s.syncedAt = Date.now();
      if (s.banner && s.banner.kind !== 'gone') s.banner = null;
      writeDraft(key, this.isUnsaved(s) ? { hash: result.hash, text: (this.stateOf(s) as EditorState).doc.toString(), at: Date.now() } : null);
      markUnsaved(key, this.isUnsaved(s));
      return true;
    } catch (error) {
      this.options.toast((error as Error).message, 'error');
      return false;
    } finally {
      s.saving = false;
      this.changed();
    }
  }

  /** Put the file back as it is saved. Undo brings the changes back. */
  revert(key: string): void {
    const s = this.sessions.get(key);
    const state = s ? this.stateOf(s) : null;
    if (!s || !state || !s.saved) return;
    this.dispatch(s, { changes: minimalChange(state.doc.toString(), s.saved.toString()), userEvent: 'input.revert' });
    writeDraft(key, null);
    this.noteUnsaved(s);
  }

  /** A closed file: its unsaved text is thrown away for good. */
  discard(key: string): void {
    writeDraft(key, null);
    this.sessions.delete(key);
    if (this.activeKey === key) this.activeKey = null;
    this.changed();
  }

  editAnyway(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.anyway = true;
    this.dispatch(s, { effects: slots.readOnly.reconfigure(readOnly(false)) });
    this.changed();
    if (key === this.activeKey) this.view.focus();
  }

  dismiss(key: string): void {
    const s = this.sessions.get(key);
    if (s) { s.banner = null; this.changed(); }
  }

  /* ── someone else's changes ─────────────────────────────────────────── */

  private checkAll(): void {
    for (const s of this.sessions.values()) void this.check(s);
  }

  /** Has the file changed on disk since it was read or saved here? */
  async check(s: DocSession): Promise<void> {
    if (s.status !== 'ready' || !s.file || s.checking || s.saving) return;
    s.checking = true;
    try {
      const now = await call('files.stat', { projectId: s.tab.projectId, cardId: s.tab.cardId, path: s.tab.path });
      if (now.hash === s.file.hash) return;
      if (now.hash === null) {
        if (s.banner?.kind !== 'gone') { s.banner = { kind: 'gone' }; forgetPlaces(s.tab.projectId, s.tab.key); this.changed(); }
        return;
      }
      const theirs = await call('files.read', { projectId: s.tab.projectId, cardId: s.tab.cardId, path: s.tab.path });
      if (theirs.hash === s.file.hash || (s.banner && 'theirs' in s.banner && s.banner.theirs.hash === theirs.hash)) return;
      this.external(s, theirs);
    } catch {
      /* the core is busy or the file is mid-write: the next look will see it */
    } finally {
      s.checking = false;
    }
  }

  /** The file changed on disk: reload it when nothing here is unsaved, otherwise say so and keep the owner's text. */
  private external(s: DocSession, theirs: FileText): void {
    const who = whoChanged(theirs.lastEdit, s.syncedAt);
    const state = this.stateOf(s);
    if (!state || !s.file) return;
    if (!this.isUnsaved(s)) {
      const before = state.doc.toString();
      this.dispatch(s, { changes: minimalChange(before, theirs.text), annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)] });
      s.file = theirs;
      s.saved = (this.stateOf(s) as EditorState).doc;
      s.syncedAt = Date.now();
      s.banner = { kind: 'reloaded', who, before };
      markUnsaved(s.tab.key, false);
    } else {
      s.banner = { kind: 'changed', who, theirs };
    }
    this.changed();
  }

  /** Take the version on disk instead of the owner's; Undo brings theirs back. */
  useTheirs(key: string): void {
    const s = this.sessions.get(key);
    const state = s ? this.stateOf(s) : null;
    if (!s || !state || !s.banner || !('theirs' in s.banner)) return;
    const theirs = s.banner.theirs;
    this.dispatch(s, { changes: minimalChange(state.doc.toString(), theirs.text), userEvent: 'input.reload' });
    s.file = theirs;
    s.saved = (this.stateOf(s) as EditorState).doc;
    s.syncedAt = Date.now();
    s.banner = null;
    s.comparison = null;
    writeDraft(key, null);
    markUnsaved(key, false);
    this.changed();
  }

  /** Write the owner's text over the version on disk, on their say-so. */
  async overwrite(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s?.banner || !('theirs' in s.banner)) return;
    await this.save(key, s.banner.theirs);
  }

  openMerge(s: DocSession, theirs: FileText): void {
    const state = this.stateOf(s);
    if (!state) return;
    s.comparison = {
      title: `${s.tab.path} changed on disk while you were editing it`,
      left: { label: 'On disk now', text: theirs.text },
      right: { label: 'Yours: the result', text: state.doc.toString() },
      merge: true,
      base: theirs,
    };
    this.changed();
  }

  /** Compare what a banner is about: the change a reload brought, theirs and yours, or an old draft. */
  compare(key: string): void {
    const s = this.sessions.get(key);
    const state = s ? this.stateOf(s) : null;
    if (!s || !state || !s.banner || !s.file) return;
    const b = s.banner;
    if (b.kind === 'reloaded') {
      s.comparison = { title: `What ${b.who} changed`, left: { label: 'Before', text: b.before }, right: { label: 'Now', text: state.doc.toString() }, merge: false, base: null };
    } else if (b.kind === 'changed' || b.kind === 'conflict') {
      this.openMerge(s, b.theirs);
      return;
    } else if (b.kind === 'old-draft') {
      s.comparison = {
        title: 'Your unsaved changes were made to an older version of this file',
        left: { label: 'On disk now', text: state.doc.toString() }, right: { label: 'Your unsaved version: the result', text: b.text }, merge: true, base: s.file,
      };
    }
    this.changed();
  }

  closeComparison(key: string): void {
    const s = this.sessions.get(key);
    if (s) { s.comparison = null; this.changed(); }
    if (key === this.activeKey) requestAnimationFrame(() => this.view.focus());
  }

  /** A merge's result becomes the file's text, made from the version on disk, and is saved. */
  async finishMerge(key: string, text: string): Promise<void> {
    const s = this.sessions.get(key);
    const state = s ? this.stateOf(s) : null;
    if (!s || !state || !s.comparison?.base) return;
    const base = s.comparison.base;
    this.dispatch(s, { changes: minimalChange(state.doc.toString(), text), userEvent: 'input.merge' });
    s.file = base;
    s.saved = EditorState.create({ doc: base.text }).doc;
    s.syncedAt = Date.now();
    s.comparison = null;
    s.banner = null;
    this.noteUnsaved(s);
    if (await this.save(key)) this.options.toast(`Saved ${s.tab.path.split('/').pop()} with both changes.`);
  }

  forgetDraft(key: string): void {
    writeDraft(key, null);
    this.dismiss(key);
  }
}
