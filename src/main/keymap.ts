import { getSetting, setSetting } from './settings';
import {
  resetRebinding, resolveKeymap, validateRebinding,
  type Keymap, type KeymapChange, type KeymapState, type KeymapWrite,
} from '../shared/keymap';

/**
 * The keymap's durable half: one row in the settings table, holding only the
 * chords a person moved, as JSON keyed by binding id. Everything else about a
 * shortcut — its default, its scope, whether it may skip the terminal — is the
 * table in shared/bindings.ts, so the row cannot widen what a chord is allowed
 * to do; it can only choose a different chord for a binding that allows one.
 *
 * Every write goes through shared/keymap.ts before it is stored. The renderer
 * validates nothing on its own authority: an id or a chord arriving over IPC
 * is untrusted text, and a refusal goes back as data with a named reason for
 * the row that asked, not as a thrown IPC error that would read as a failure.
 * There is no cache. Each read parses the row again, so what the menu bar
 * prints, what a window matches and what survives a relaunch are one value.
 */

const KEYMAP_SETTING = 'keymap';

function stored(): { value: unknown; unreadable: string | null } {
  const raw = getSetting(KEYMAP_SETTING, '');
  if (raw === '') return { value: {}, unreadable: null };
  try {
    return { value: JSON.parse(raw) as unknown, unreadable: null };
  } catch {
    // Said, not swallowed: an unreadable row would otherwise present every
    // default as the operator's own choice.
    return { value: {}, unreadable: 'The stored keyboard shortcuts could not be read, so every shortcut is at its default. Changing or resetting one replaces the unreadable value.' };
  }
}

/** The rebindings in effect, and every stored entry that is not, with its reason. */
export function keymapState(): KeymapState {
  const { value, unreadable } = stored();
  const { keymap, ignored } = resolveKeymap(value);
  return { keymap, ignored, unreadable };
}

/**
 * The rebindings in effect, for the menu bar. The menu is built when the
 * window is, and a database that cannot be read must not be what stops a
 * window from getting a menu: the defaults are printed instead, which is also
 * what a window whose own read failed is pressing.
 */
export function effectiveStoredKeymap(): Keymap {
  try {
    return keymapState().keymap;
  } catch (error) {
    console.error('[wanigan] the keymap could not be read for the menu bar; printing the defaults:', error);
    return {};
  }
}

function commit(change: KeymapChange): KeymapWrite {
  if (!change.ok) return { applied: false, refusal: change.refusal, state: keymapState() };
  // Only accepted entries are written, so an entry this build ignored is
  // dropped by the first successful write rather than lying in wait for the
  // table to change under it.
  setSetting(KEYMAP_SETTING, JSON.stringify(change.keymap));
  return { applied: true, state: keymapState() };
}

export function setKeybinding(id: unknown, chord: unknown): KeymapWrite {
  return commit(validateRebinding(stored().value, id, chord));
}

export function resetKeybinding(id: unknown): KeymapWrite {
  return commit(resetRebinding(stored().value, id));
}

/** Always allowed: every default is a valid chord for its own binding, which the shared tests hold. */
export function resetAllKeybindings(): KeymapState {
  setSetting(KEYMAP_SETTING, '{}');
  return keymapState();
}
