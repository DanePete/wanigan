// How the code editor is laid out and behaves, remembered on this computer: the
// drawer's height (or width beside the view), whether it is open and which of
// its tabs it shows (it is the live view's dock too: Code, Notes, Problems,
// Request), soft wrap, Vim keys, and whether the Code tab shows the files. Never required: without storage the
// choices last as long as the window.
import { useSyncExternalStore } from 'react';

export interface EditorPrefs {
  dock: 'bottom' | 'right';
  /** The drawer's height beneath the view, in CSS pixels. */
  height: number;
  /** Its width beside the view. */
  width: number;
  /** Open (beneath or beside the view), as it was left. */
  open: boolean;
  /** The tab it shows: `code`, or one a view adds to it (the live view's notes, problems, request). */
  shows: string;
  wrap: boolean;
  vim: boolean;
  /** The Code tab's files, beside the editor. */
  tree: boolean;
}

const KEY = 'wanigan.editor.prefs';
const DEFAULTS: EditorPrefs = { dock: 'bottom', height: 340, width: 480, open: false, shows: 'code', wrap: false, vim: false, tree: true };
export const MIN_SIZE = 160;

function read(): EditorPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof EditorPrefs, unknown>>;
    const size = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= MIN_SIZE && v <= 4000 ? Math.round(v) : d);
    return {
      dock: raw.dock === 'right' ? 'right' : 'bottom',
      height: size(raw.height, DEFAULTS.height),
      width: size(raw.width, DEFAULTS.width),
      open: raw.open === true,
      shows: typeof raw.shows === 'string' && /^[a-z][a-z-]{0,31}$/.test(raw.shows) ? raw.shows : DEFAULTS.shows,
      wrap: raw.wrap === true,
      vim: raw.vim === true,
      tree: raw.tree !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

export function setPrefs(patch: Partial<EditorPrefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage unavailable: the choice lasts this window */ }
  for (const l of listeners) l();
}

export const editorPrefs = (): EditorPrefs => prefs;

export function useEditorPrefs(): EditorPrefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => prefs);
}
