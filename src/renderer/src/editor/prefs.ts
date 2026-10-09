// How the code editor is laid out and behaves, remembered on this Mac: the
// drawer's height (or width beside the view), soft wrap, and Vim keys. Never
// required: without storage the choices last as long as the window.
import { useSyncExternalStore } from 'react';

export interface EditorPrefs {
  dock: 'bottom' | 'right';
  /** The drawer's height beneath the view, in CSS pixels. */
  height: number;
  /** Its width beside the view. */
  width: number;
  wrap: boolean;
  vim: boolean;
}

const KEY = 'wanigan.editor.prefs';
const DEFAULTS: EditorPrefs = { dock: 'bottom', height: 340, width: 480, wrap: false, vim: false };
export const MIN_SIZE = 160;

function read(): EditorPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof EditorPrefs, unknown>>;
    const size = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= MIN_SIZE && v <= 4000 ? Math.round(v) : d);
    return {
      dock: raw.dock === 'right' ? 'right' : 'bottom',
      height: size(raw.height, DEFAULTS.height),
      width: size(raw.width, DEFAULTS.width),
      wrap: raw.wrap === true,
      vim: raw.vim === true,
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
