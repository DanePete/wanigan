import { useSyncExternalStore } from 'react';
import {
  chordMatchesEvent, effectiveKeymap, glyphsFor, keysFor, spokenFor,
  type EffectiveKeymap, type KeymapState, type Platform,
} from '@shared/keymap';

export { BINDING_GROUPS, type BindingGroup } from '@shared/bindings';

/**
 * The renderer's half of the key table: where focus is, and whether a keydown
 * fires a binding. The rows themselves live in shared/bindings.ts and the
 * rebindings laid over them in shared/keymap.ts, because the main process has
 * to validate a rebinding against the same rows before it stores one and print
 * the result in the menu bar.
 *
 * This window holds one effective keymap. bindingMatches reads it from plain
 * keydown listeners, and components read the same record through useKeymap —
 * the cheat sheet, Settings, and every chord printed on a control — so a
 * changed chord is printed, published and pressed from one object, and all
 * three change on the same frame.
 *
 * The two load-bearing rules are unchanged by rebinding. The PTY owns its
 * keystrokes: inside a terminal only the binding the default table marks
 * skipsTerminal matches, and no keymap can mark another. A bare printable key
 * is never taken inside a text field.
 */

export type KeymapSnapshot = {
  state: KeymapState;
  map: EffectiveKeymap;
  /** 'loading' until main answers; 'failed' when it could not — and then the defaults are what the keys do. */
  read: 'loading' | 'ready' | 'failed';
  error: string | null;
};

const EMPTY_STATE: KeymapState = { keymap: {}, ignored: [], unreadable: null };
let snapshot: KeymapSnapshot = { state: EMPTY_STATE, map: effectiveKeymap({}), read: 'loading', error: null };
const listeners = new Set<() => void>();

function publish(next: KeymapSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Take the state main returned from a read or a write. The overlay is rebuilt here, never trusted from the wire. */
export function applyKeymapState(state: KeymapState): void {
  publish({ state, map: effectiveKeymap(state.keymap), read: 'ready', error: null });
}

/**
 * Read the stored keymap once for this window. A failed read leaves the
 * defaults in force and says so, rather than presenting them as the stored
 * answer: Settings prints the failure beside the rows.
 */
export async function loadKeymap(): Promise<void> {
  try {
    applyKeymapState(await window.wanigan.keymap.get());
  } catch (error) {
    publish({ ...snapshot, read: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useKeymap(): KeymapSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * The app ships for macOS and prints ⌘ there. Anywhere else, a binding the
 * table lists as both ⌘ and ⌃ prints its Control form instead of a key that
 * keyboard does not have.
 */
const PLATFORM: Platform = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other';

export type ChordLabels = {
  /** The sheet's key column: every alternative a reader can press ("?  ·  ⌘/"). */
  keys: string;
  /** The rebindable chord alone ("⌘/"), for a hint printed on a control. */
  glyphs: string;
  /** aria-keyshortcuts. */
  aria: string;
  /** The rebindable chord in words ("Command Slash"), for an aria-label. */
  spoken: string;
};

export function chordLabels(map: EffectiveKeymap, id: string): ChordLabels {
  const binding = map.byId.get(id);
  return {
    keys: binding ? keysFor(binding, PLATFORM) : '',
    glyphs: glyphsFor(binding, PLATFORM),
    aria: binding?.aria ?? '',
    spoken: spokenFor(binding, PLATFORM),
  };
}

/** The labels for one binding, re-rendered when the keymap changes. */
export function useChord(id: string): ChordLabels {
  return chordLabels(useKeymap().map, id);
}

/** The labels as they stand right now, for a sentence composed in an event handler rather than a render. */
export function chordNow(id: string): ChordLabels {
  return chordLabels(snapshot.map, id);
}

/**
 * While Settings records a chord, nothing matches: the keys pressed are the
 * answer to "which chord?", not commands — ⌘T pressed to be recorded must not
 * also open New session. A flag on the root element rather than module state,
 * so a probe can see it and a reload clears it.
 */
export function setChordCapture(on: boolean): void {
  if (on) document.documentElement.dataset.chordCapture = 'true';
  else delete document.documentElement.dataset.chordCapture;
}

function capturing(): boolean {
  return document.documentElement.dataset.chordCapture === 'true';
}

/** True while focus is inside a terminal host: the PTY owns the keystroke. */
export function inTerminal(el: Element | null = document.activeElement): boolean {
  return !!el && !!(el as HTMLElement).closest?.('.terminal-host');
}

/** True while focus sits in something that consumes typing. */
export function inField(el: Element | null = document.activeElement): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * True while any dialog owns the keyboard. Two signals, either suffices: the
 * flag useDialog sets on the root element, and any aria-modal dialog in the
 * document — which also covers dialogs not yet ported onto the hook.
 */
export function modalOpen(): boolean {
  return document.documentElement.dataset.modalOpen === 'true'
    || document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Does this event fire the binding `id`, given where focus is? `id` is a row
 * of shared/bindings.ts or `view:<tab>` for a route from shared/routes.ts, and
 * the chords tested are the effective ones — a rebinding replaces the default
 * here, in the one place every handler asks. Owns the two focus guards every
 * handler used to copy: inside a terminal only the `skipsTerminal` chord
 * matches; inside a text field a bare printable key never does. Whether an
 * open dialog blocks the chord is the caller's call — ⌘K closes the palette it
 * opened and `?` closes the sheet — via modalOpen().
 */
export function bindingMatches(e: KeyboardEvent, id: string): boolean {
  if (capturing()) return false;
  const binding = snapshot.map.byId.get(id);
  if (!binding) return false;
  const alt = binding.alternatives.find((candidate) => chordMatchesEvent(candidate, e));
  if (!alt) return false;
  const el = document.activeElement;
  if (inTerminal(el) && !binding.skipsTerminal) return false;
  const bare = !alt.meta && !alt.ctrl;
  const fieldIsTheTarget = binding.scope === 'composer' || binding.scope === 'palette';
  if (bare && !fieldIsTheTarget && inField(el)) return false;
  return true;
}

/**
 * True when this keydown is a default chord a rebinding moved away from, and
 * nothing now claims it. A handler written before the keymap can still be
 * testing that chord by hand — the Sessions view opens its own New session
 * dialog on ⌘T, a branch the shell used to reach first and stop — so the
 * shell stops these too, and the old chord does nothing anywhere. Never inside
 * a terminal, whose keys the PTY owns, and never while a dialog owns the
 * keyboard, where no such handler acts.
 */
export function retiredChordPressed(e: KeyboardEvent): boolean {
  if (capturing() || modalOpen() || inTerminal()) return false;
  return snapshot.map.retired.some((chord) => chordMatchesEvent(chord, e));
}
