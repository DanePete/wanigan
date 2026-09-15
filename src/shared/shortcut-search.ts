/**
 * Shortcut search in the command palette, the pure half.
 *
 * The palette lists every binding the cheat sheet lists, from the same table,
 * and a query of `?` or one starting "shortcut" narrows it to bindings alone —
 * the same two words someone reaching for a key is likely to type. What
 * follows the prefix still searches, so "shortcut close" finds ⌘⌫.
 *
 * A row is runnable from the palette only when running it means pressing a
 * chord somewhere the chord already works. A key that belongs to a text field
 * (Enter in the composer, the arrows in the palette itself) is listed and
 * explained, not run: pressing Enter on "Send" from a palette that is not the
 * composer would send nothing, and pretending otherwise would be the sheet
 * printing a claim.
 */

export type ShortcutQuery = { onlyShortcuts: boolean; rest: string };

export function shortcutQuery(query: string): ShortcutQuery {
  const q = query.trimStart();
  if (q.startsWith('?')) return { onlyShortcuts: true, rest: q.slice(1).trim() };
  const m = /^(?:keyboard\s+)?shortcuts?\b\s*/i.exec(q);
  if (m) return { onlyShortcuts: true, rest: q.slice(m[0].length).trim() };
  return { onlyShortcuts: false, rest: query };
}

export type ShortcutScope = 'anywhere' | 'not-terminal' | 'not-field' | 'sessions' | 'composer' | 'palette';

export type ShortcutRunnability =
  | { runnable: true; needsSessions: boolean }
  | { runnable: false; why: string };

/**
 * Whether a binding can be run from the palette. The palette's own chords are
 * never run from inside it, and a chord with no ⌘ or ⌃ alternative is a key a
 * field or a list owns.
 */
export function shortcutRunnability(binding: { id: string; aria: string; scope: ShortcutScope }): ShortcutRunnability {
  if (binding.scope === 'composer') return { runnable: false, why: 'Works inside the composer’s message box.' };
  if (binding.scope === 'palette' || binding.id === 'palette') return { runnable: false, why: 'Works inside this palette.' };
  const hasModifierChord = binding.aria.split(/\s+/).some((alt) => /^(?:Alt\+)?(?:Meta|Control)\+/.test(alt));
  if (!hasModifierChord) return { runnable: false, why: 'A key for moving focus in a list, not an action to run.' };
  return { runnable: true, needsSessions: binding.scope === 'sessions' };
}

/** The KeyboardEvent a chord's first ⌘ alternative describes, for running it where it works. */
export function chordEventInit(aria: string): { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } | null {
  const alt = aria.split(/\s+/).find((a) => a.includes('Meta+')) ?? aria.split(/\s+/).find((a) => a.includes('Control+'));
  if (!alt) return null;
  const parts = alt.split('+');
  const key = parts.pop() ?? '';
  if (!key) return null;
  const mods = new Set(parts);
  const named: Record<string, string> = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', Backspace: 'Backspace', Enter: 'Enter', Escape: 'Escape' };
  return {
    key: named[key] ?? (key.length === 1 ? key.toLowerCase() : key),
    metaKey: mods.has('Meta'), ctrlKey: mods.has('Control'), altKey: mods.has('Alt'), shiftKey: mods.has('Shift'),
  };
}
