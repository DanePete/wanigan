/**
 * Rebindable keyboard shortcuts, the part that needs no process: reading a
 * chord, printing it, laying a person's keymap over the default table, and
 * deciding whether a rebinding may stand. The main process stores the keymap
 * and runs every write through `validateRebinding` before it reaches SQLite;
 * the renderer matches key events, prints the cheat sheet and publishes
 * aria-keyshortcuts from `effectiveKeymap`; the menu bar prints
 * `menuAccelerator` of the same record. One overlay, three readers — so a
 * changed chord is printed, published and pressed as one string, which is the
 * promise shared/bindings.ts makes for the defaults.
 *
 * What no keymap can reach:
 *
 *  - Which binding skips the terminal. `skipsTerminal` is copied from the
 *    default table and a stored keymap holds nothing but chords, so no value in
 *    the database can make a chord take a key the PTY owns. The interrupt keeps
 *    the flag whatever its chord; nothing else can gain it.
 *  - A binding whose handler does not read this map. Rebinding one of those
 *    would print a chord that does nothing and leave the old one working, which
 *    is worse than a fixed chord. They are `rebindable: false`, with the reason
 *    in words, and main refuses a write to them by that reason.
 *
 * A chord is matched exactly. Meta, Control and Alt must be held exactly as
 * written, and so must Shift for a letter, a digit or a named key; for any
 * other character the layout already spent Shift producing it (`?` is ⇧/). So
 * two chords are the same presses exactly when their canonical text is equal,
 * which is what lets a conflict be decided by comparing strings.
 */
import { BINDINGS, BINDING_GROUPS, type BindingGroup, type BindingId, type BindingScope } from './bindings.ts';
import { TAB_SHORTCUTS, VIEW_SHORTCUT_ORDER, labelForTab } from './routes.ts';

export type Platform = 'mac' | 'other';

/** One chord: a key and exactly the modifiers held with it. */
export type Chord = {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  /** An upper-case letter, a digit, one other character, or a named key in aria spelling. */
  key: string;
};

/** The fields of a KeyboardEvent a chord reads; a plain record in tests. */
export type KeyEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Binding id → canonical chord text, holding only the chords that differ from the default. */
export type Keymap = Record<string, string>;

export type KeymapRefusalReason = 'unknown-binding' | 'fixed' | 'unparseable' | 'reserved' | 'bare-key' | 'conflict';

export type KeymapRefusal = {
  reason: KeymapRefusalReason;
  /** A sentence for the row that asked: what was refused, and why. */
  message: string;
  /** The binding that already holds the chord, for `conflict`; null otherwise. */
  conflict: { id: string; name: string } | null;
};

/** A stored entry the overlay did not apply, and the refusal it would get as a write today. */
export type IgnoredKeybinding = { id: string; chord: string; refusal: KeymapRefusal };

/** What main hands the renderer: the rebindings in effect, and what was stored but not applied. */
export type KeymapState = {
  keymap: Keymap;
  ignored: IgnoredKeybinding[];
  /** Why the stored value could not be read at all; null when it could. */
  unreadable: string | null;
};

export type KeymapWrite =
  | { applied: true; state: KeymapState }
  | { applied: false; refusal: KeymapRefusal; state: KeymapState };

export type KeymapChange = { ok: true; keymap: Keymap } | { ok: false; refusal: KeymapRefusal };

/* ── chords ─────────────────────────────────────────────────────────────── */

/**
 * The named keys a chord may use, in aria-keyshortcuts spelling: the set the
 * matcher accepted before the keymap existed, plus Plus, which aria spells as a
 * word because `+` is what joins the parts.
 */
const NAMED_KEYS = new Map(
  ['Enter', 'Escape', 'Tab', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Space', 'Plus']
    .map((name) => [name.toLowerCase(), name] as const),
);

const MODIFIERS = new Map<string, 'ctrl' | 'alt' | 'meta' | 'shift'>([
  ['control', 'ctrl'], ['alt', 'alt'], ['meta', 'meta'], ['shift', 'shift'],
]);

/** Keys that are only ever held with another key. A capture waits past them. */
const MODIFIER_KEYS = new Set([
  'Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'Symbol', 'SymbolLock', 'NumLock', 'ScrollLock',
]);

function canonicalKey(raw: string): string | null {
  if (raw === ' ') return 'Space';
  if (raw === '+') return 'Plus';
  const named = NAMED_KEYS.get(raw.toLowerCase());
  if (named) return named;
  if (raw.length !== 1) return null;
  // A control, format or separator character is not a key anyone can read
  // back on a settings row, and a bidirectional override would reorder the
  // sentence it is printed in.
  if (/[\p{Cc}\p{Cf}\p{Z}]/u.test(raw)) return null;
  return /^[a-z]$/i.test(raw) ? raw.toUpperCase() : raw;
}

/** Shift is part of the chord for a letter, a digit or a named key; Plus is typed with Shift on most layouts. */
function shiftCounts(key: string): boolean {
  return /^[A-Z0-9]$/.test(key) || (key !== 'Plus' && NAMED_KEYS.has(key.toLowerCase()));
}

function normalise(chord: Chord): Chord {
  return shiftCounts(chord.key) ? chord : { ...chord, shift: false };
}

/** A short, printable echo of untrusted text for a refusal sentence. */
function clip(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, '?');
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat;
}

export type ParsedChord = { ok: true; chord: Chord } | { ok: false; detail: string };

/** One aria-keyshortcuts alternative (`Meta+Shift+N`) as a canonical chord. */
export function parseChord(text: unknown): ParsedChord {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 || /\s/.test(text)) {
    return { ok: false, detail: 'A chord is written as its keys joined by +, such as Meta+Shift+N.' };
  }
  const parts = text.split('+');
  let key = parts.pop() ?? '';
  // "Meta++" names the plus key itself: splitting leaves an empty part before it.
  if (key === '' && parts.length > 0 && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }
  const chord: Chord = { ctrl: false, alt: false, meta: false, shift: false, key: '' };
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (!modifier) return { ok: false, detail: `“${clip(part)}” is not a modifier: a chord holds Control, Alt, Meta and Shift.` };
    if (chord[modifier]) return { ok: false, detail: `${clip(part)} is written twice in one chord.` };
    chord[modifier] = true;
  }
  const canonical = canonicalKey(key);
  if (!canonical) {
    return { ok: false, detail: `${key ? `“${clip(key)}”` : 'That'} is not a key a shortcut can use: a letter, a digit, a punctuation key, an arrow, Enter, Escape, Tab, Home, End, Backspace, Delete, Space or Plus.` };
  }
  return { ok: true, chord: normalise({ ...chord, key: canonical }) };
}

/** The canonical aria spelling: Control, Alt, Meta, Shift, then the key — the order the table already uses. */
export function chordText(chord: Chord): string {
  return [chord.ctrl && 'Control', chord.alt && 'Alt', chord.meta && 'Meta', chord.shift && 'Shift', chord.key]
    .filter(Boolean).join('+');
}

export function sameChord(a: Chord, b: Chord): boolean {
  return chordText(a) === chordText(b);
}

/**
 * The key a keydown means, for capture and for matching alike. With Option
 * held, a macOS layout turns a letter or digit into another character (⌥S is
 * ß) or into a dead key that several letters share, so a chord recorded from
 * `key` alone could not be told apart from its neighbours. The physical key is
 * the chord a person pressed; reading it here, in the one function both paths
 * call, keeps what was recorded and what is later matched in agreement.
 */
export function keyOfEvent(e: KeyEventLike): string {
  if (e.altKey && e.code) {
    const physical = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit([0-9])$/.exec(e.code)?.[1];
    if (physical && !/^[a-z0-9]$/i.test(e.key)) return physical;
  }
  return e.key;
}

/**
 * The chord a keydown spells, as canonical text, or null while only modifiers
 * are down. A key no chord can use is returned as written, so the refusal can
 * name it instead of the capture silently waiting for a key that never counts.
 */
export function chordTextFromEvent(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyOfEvent(e);
  const canonical = canonicalKey(key);
  const mods = { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey };
  if (canonical === null) {
    return chordText({ ...mods, key: key.replace(/[+\s]/g, '') || 'Unidentified' });
  }
  return chordText(normalise({ ...mods, key: canonical }));
}

export function chordMatchesEvent(chord: Chord, e: KeyEventLike): boolean {
  if (canonicalKey(keyOfEvent(e)) !== chord.key) return false;
  if (chord.meta !== e.metaKey || chord.ctrl !== e.ctrlKey || chord.alt !== e.altKey) return false;
  return !shiftCounts(chord.key) || chord.shift === e.shiftKey;
}

/* ── printing ───────────────────────────────────────────────────────────── */

const MAC_KEY: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Plus: '+',
};
const OTHER_KEY: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc',
};

/**
 * A chord as the sheet prints it. On a Mac, glyphs in the order the table
 * already writes them (⌃⌥⌘⇧, so ⌘⇧D and ⌥⌘S), which puts a rebound row in the
 * same spelling as the default rows beside it; elsewhere, words joined by +.
 */
export function formatChord(chord: Chord, platform: Platform = 'mac'): string {
  if (platform === 'mac') {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.meta ? '⌘' : ''}${chord.shift ? '⇧' : ''}${MAC_KEY[chord.key] ?? chord.key}`;
  }
  return [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.meta && 'Meta', chord.shift && 'Shift', OTHER_KEY[chord.key] ?? chord.key]
    .filter(Boolean).join('+');
}

const SPOKEN_KEY: Record<string, string> = {
  ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow',
  Escape: 'Escape', Space: 'Space', Tab: 'Tab', Home: 'Home', End: 'End', Plus: 'Plus',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '?': 'Question Mark', '$': 'Dollar Sign', ';': 'Semicolon', ':': 'Colon',
  "'": 'Quote', '"': 'Double Quote', '[': 'Left Bracket', ']': 'Right Bracket', '\\': 'Backslash', '-': 'Minus',
  '=': 'Equals', '`': 'Grave Accent', '!': 'Exclamation Mark', '#': 'Number Sign', '&': 'Ampersand', '*': 'Asterisk',
};

/** A chord in words for an aria-label: "Option Command S", as the header already speaks ⌥⌘S. */
export function speakChord(chord: Chord, platform: Platform = 'mac'): string {
  const mac = platform === 'mac';
  const key = chord.key === 'Enter' ? (mac ? 'Return' : 'Enter')
    : chord.key === 'Backspace' ? (mac ? 'Delete' : 'Backspace')
      : chord.key === 'Delete' ? (mac ? 'Forward Delete' : 'Delete')
        : SPOKEN_KEY[chord.key] ?? chord.key;
  return [chord.ctrl && 'Control', chord.alt && (mac ? 'Option' : 'Alt'), chord.meta && (mac ? 'Command' : 'Meta'), chord.shift && 'Shift', key]
    .filter(Boolean).join(' ');
}

/** True for the Meta form and the Control form of one chord — one binding on two keyboards. */
function aliasPair(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.alt === b.alt && a.shift === b.shift
    && ((a.meta && !a.ctrl && b.ctrl && !b.meta) || (b.meta && !b.ctrl && a.ctrl && !a.meta));
}

/**
 * Where the table lists a chord twice, once with Meta and once with Control,
 * keep the one this platform's keyboard has: ⌘ on a Mac, Ctrl elsewhere.
 */
function forPlatform(chords: readonly Chord[], platform: Platform): Chord[] {
  const keep = platform === 'mac' ? 'meta' : 'ctrl';
  return chords.filter((chord) => !chords.some((other) => other !== chord && aliasPair(chord, other)) || chord[keep]);
}

/* ── the rows a keymap lays over ────────────────────────────────────────── */

export type KeymapRule =
  | { rebindable: true; name: string; companions?: readonly string[] }
  | { rebindable: false; name: string; reason: string; mirrors?: BindingId };

const SESSIONS_HANDLER = 'The Sessions view answers this chord in a key handler of its own that does not read the keymap yet, so a new chord would be printed here and never pressed — and the old one would keep working.';
const PALETTE_FIELD = 'A key inside the command palette’s search field, where it moves through results or runs one; it is the field’s own navigation rather than a shortcut.';
const TEXT_FIELD_ENTER = 'Enter and ⇧Enter belong to the text field they are typed in: one sends, the other starts a new line.';

/**
 * What each row of the default table allows. A Record over BindingId, so a
 * binding added to shared/bindings.ts without a decision here fails the
 * typecheck rather than arriving silently rebindable.
 */
export const KEYMAP_RULES: Record<BindingId, KeymapRule> = {
  palette: { rebindable: true, name: 'Command palette' },
  'new-session': { rebindable: true, name: 'New session' },
  demo: { rebindable: true, name: 'Demo mode' },
  // `?` stays: it is the bare key for where typing it is free, and a bare key
  // is never something a rebinding may choose. The ⌘/ half is what moves.
  sheet: { rebindable: true, name: 'Keyboard cheat sheet', companions: ['?'] },
  sidebar: { rebindable: true, name: 'Show or hide the destination list' },
  'rail-move': { rebindable: false, name: 'Move through the destination list',
    reason: 'The arrow keys, Home and End move focus inside a list that already has it. They are how the list works, not a shortcut that could live somewhere else.' },
  'side-panel': { rebindable: false, name: 'Side panel', reason: SESSIONS_HANDLER },
  composer: { rebindable: false, name: 'Composer', reason: SESSIONS_HANDLER },
  'close-tab': { rebindable: false, name: 'Close an exited session tab', reason: SESSIONS_HANDLER },
  'session-prev': { rebindable: true, name: 'Previous session' },
  'session-next': { rebindable: true, name: 'Next session' },
  interrupt: { rebindable: false, name: 'Interrupt the running agent', reason: SESSIONS_HANDLER },
  send: { rebindable: false, name: 'Send', reason: TEXT_FIELD_ENTER },
  newline: { rebindable: false, name: 'New line', reason: TEXT_FIELD_ENTER },
  stash: { rebindable: true, name: 'Stash the draft' },
  'skill-menu': { rebindable: false, name: 'Insert a skill',
    reason: 'Typing $ in the composer opens the menu because the draft now holds a $. It is a character in the text, not a key the shell listens for.' },
  'palette-move': { rebindable: false, name: 'Move the palette highlight', reason: PALETTE_FIELD },
  'palette-ends': { rebindable: false, name: 'First or last palette result', reason: PALETTE_FIELD },
  'palette-run': { rebindable: false, name: 'Run the highlighted result', reason: PALETTE_FIELD },
  // Escape closes every dialog. The ⌘K half is not a second binding but the
  // palette's own chord seen from inside it, so it follows that one.
  'palette-close': { rebindable: false, name: 'Close the command palette', mirrors: 'palette',
    reason: 'Escape closes every dialog. The other half is the command palette’s own chord, so it changes when that one does.' },
};

/**
 * Chords a shortcut may not take. System and menu-bar chords first: macOS and
 * the standard App, Edit, View and Window menus claim them, and a second menu
 * item printing the same chord would leave a reader guessing which one runs.
 * ⌘0 is absent on purpose — View › Actual Size prints it, but it has been the
 * Runs route since before this table, and taking it away is a separate
 * decision. Then the chords a text field owns: Enter and ⇧Enter everywhere,
 * and ⌘Enter, which submits the field it is typed in (a code note, an
 * interview answer, the New session form) and which a shell chord matched in
 * the capture phase would take first.
 */
const RESERVED: readonly { chord: string; does: string }[] = [
  { chord: 'Meta+Q', does: 'quits Wanigan' },
  { chord: 'Meta+W', does: 'closes the window' },
  { chord: 'Meta+H', does: 'hides Wanigan' },
  { chord: 'Alt+Meta+H', does: 'hides every other app' },
  { chord: 'Meta+M', does: 'minimises the window' },
  { chord: 'Control+Meta+F', does: 'enters full screen' },
  { chord: 'Meta+C', does: 'copies' },
  { chord: 'Meta+V', does: 'pastes' },
  { chord: 'Alt+Meta+Shift+V', does: 'pastes and matches style' },
  { chord: 'Meta+X', does: 'cuts' },
  { chord: 'Meta+Z', does: 'undoes' },
  { chord: 'Meta+Shift+Z', does: 'redoes' },
  { chord: 'Meta+A', does: 'selects all' },
  { chord: 'Meta+Plus', does: 'zooms in' },
  { chord: 'Meta+=', does: 'zooms in' },
  { chord: 'Meta+-', does: 'zooms out' },
  { chord: 'Alt+Meta+I', does: 'opens the developer tools' },
  { chord: 'Enter', does: 'belongs to the text field it is typed in' },
  { chord: 'Shift+Enter', does: 'belongs to the text field it is typed in' },
  { chord: 'Meta+Enter', does: 'submits the text field it is typed in' },
];

const RESERVED_CHORDS = RESERVED.map((entry) => {
  const parsed = parseChord(entry.chord);
  if (!parsed.ok) throw new Error(`reserved chord ${entry.chord} does not parse`);
  return { chord: parsed.chord, does: entry.does };
});

type Row = {
  id: string;
  group: BindingGroup;
  name: string;
  does: string;
  scope: BindingScope;
  skipsTerminal: boolean;
  rebindable: boolean;
  fixedReason: string | null;
  mirrors: string | null;
  defaultAria: string;
  defaultKeys: string;
  /** Alternatives no rebinding replaces. */
  companions: Chord[];
  /** The alternatives a rebinding replaces, as the table writes them. */
  defaultChords: Chord[];
  /** Listed as a Meta form and a Control form: a rebinding is published both ways too. */
  aliased: boolean;
};

function parseAria(aria: string): Chord[] {
  return aria.split(/\s+/).filter(Boolean).map((alt) => {
    const parsed = parseChord(alt);
    if (!parsed.ok) throw new Error(`default chord ${alt} does not parse: ${parsed.detail}`);
    return parsed.chord;
  });
}

function rowFor(id: string, group: BindingGroup, does: string, scope: BindingScope, skipsTerminal: boolean,
  aria: string, keys: string, rule: KeymapRule): Row {
  const all = parseAria(aria);
  const mirrored = !rule.rebindable && rule.mirrors
    ? parseAria(BINDINGS.find((b) => b.id === rule.mirrors)?.aria ?? '') : [];
  const companionTexts = new Set(rule.rebindable ? rule.companions ?? [] : []);
  const companions = rule.rebindable
    ? all.filter((chord) => companionTexts.has(chordText(chord)))
    : all.filter((chord) => !mirrored.some((m) => sameChord(m, chord)));
  const defaultChords = rule.rebindable
    ? all.filter((chord) => !companionTexts.has(chordText(chord)))
    : mirrored;
  return {
    id, group, name: rule.name, does, scope, skipsTerminal,
    rebindable: rule.rebindable, fixedReason: rule.rebindable ? null : rule.reason,
    mirrors: !rule.rebindable && rule.mirrors ? rule.mirrors : null,
    defaultAria: aria, defaultKeys: keys, companions, defaultChords,
    aliased: defaultChords.length === 2 && aliasPair(defaultChords[0], defaultChords[1]),
  };
}

/**
 * Every row in the order the cheat sheet reads them: Anywhere opens with the
 * palette and New session, then the view routes, then the rest of the group;
 * the other groups follow in table order. Settings lists the same rows in the
 * same order, which is what "grouped as the sheet groups them" means.
 */
const ROWS: readonly Row[] = (() => {
  const binding = (b: (typeof BINDINGS)[number]) =>
    rowFor(b.id, b.group, b.does, b.scope, b.skipsTerminal, b.aria, b.keys, KEYMAP_RULES[b.id]);
  const anywhere = BINDINGS.filter((b) => b.group === 'Anywhere');
  const lead = anywhere.filter((b) => b.id === 'palette' || b.id === 'new-session').map(binding);
  const views = VIEW_SHORTCUT_ORDER.map((tab) => rowFor(`view:${tab}`, 'Anywhere', labelForTab(tab), 'not-terminal', false,
    TAB_SHORTCUTS[tab].aria, TAB_SHORTCUTS[tab].label, { rebindable: true, name: `Open ${labelForTab(tab)}` }));
  const rest = anywhere.filter((b) => b.id !== 'palette' && b.id !== 'new-session').map(binding);
  const others = BINDING_GROUPS.filter((group) => group !== 'Anywhere')
    .flatMap((group) => BINDINGS.filter((b) => b.group === group).map(binding));
  return [...lead, ...views, ...rest, ...others];
})();

const ROW_BY_ID = new Map(ROWS.map((row) => [row.id, row]));

/** The primary form of a chord list: the Meta one where the table lists both. */
function primary(chords: readonly Chord[]): Chord | null {
  return forPlatform(chords, 'mac')[0] ?? null;
}

/** A rebinding for an aliased row is published as both forms, and stored as the Meta one. */
function expand(chord: Chord, aliased: boolean): Chord[] {
  if (!aliased || chord.meta === chord.ctrl) return [chord];
  return [{ ...chord, meta: true, ctrl: false }, { ...chord, meta: false, ctrl: true }];
}

function storedForm(chord: Chord, row: Row): Chord {
  return expand(chord, row.aliased)[0];
}

/* ── the overlay ────────────────────────────────────────────────────────── */

export type EffectiveBinding = {
  /** A shared/bindings.ts id, or view:<tab> for a route from shared/routes.ts. */
  id: string;
  group: BindingGroup;
  /** A short name for a settings row or a refusal sentence. */
  name: string;
  /** What the cheat sheet prints beside the keys. */
  does: string;
  scope: BindingScope;
  /** From the default table, never from a keymap. */
  skipsTerminal: boolean;
  rebindable: boolean;
  fixedReason: string | null;
  /** The binding whose chord this one repeats (palette-close repeats the palette's). */
  mirrors: string | null;
  /** aria-keyshortcuts, every alternative — also exactly what the matcher tests. */
  aria: string;
  /** What the sheet prints, in the table's Mac spelling. */
  keys: string;
  /** What the sheet printed before any rebinding, as the table writes it. */
  defaultKeys: string;
  alternatives: readonly Chord[];
  /** The alternatives a rebinding replaces, as they stand now. */
  chords: readonly Chord[];
  /** Canonical text of the rebindable chord in effect; null for a fixed binding. */
  chord: string | null;
  defaultChord: string | null;
  /** True when a rebinding, not the default, is in effect. */
  rebound: boolean;
};

export type EffectiveKeymap = {
  bindings: readonly EffectiveBinding[];
  byId: ReadonlyMap<string, EffectiveBinding>;
  /**
   * Default chords a rebinding moved away from that no binding now claims. A
   * handler written before the keymap existed may still test one of these
   * directly; the shell retires them so pressing the old chord does nothing.
   */
  retired: readonly Chord[];
};

/** Builds the overlay from rebindings that have already passed resolveKeymap. */
function build(accepted: Keymap): EffectiveKeymap {
  const bindings: EffectiveBinding[] = ROWS.map((row) => {
    const stored = row.rebindable ? accepted[row.id] : undefined;
    const parsed = stored === undefined ? null : parseChord(stored);
    const main = parsed?.ok ? parsed.chord : null;
    const defaultPrimary = primary(row.defaultChords);
    const rebound = !!main && !!defaultPrimary && !sameChord(main, defaultPrimary);
    const chords = rebound && main ? expand(main, row.aliased) : row.defaultChords;
    const alternatives = [...row.companions, ...chords];
    return {
      id: row.id, group: row.group, name: row.name, does: row.does, scope: row.scope, skipsTerminal: row.skipsTerminal,
      rebindable: row.rebindable, fixedReason: row.fixedReason, mirrors: row.mirrors,
      aria: rebound ? alternatives.map(chordText).join(' ') : row.defaultAria,
      keys: rebound && main ? [...row.companions, main].map((chord) => formatChord(chord)).join('  ·  ') : row.defaultKeys,
      defaultKeys: row.defaultKeys,
      alternatives, chords,
      chord: row.rebindable ? chordText((rebound && main) || defaultPrimary || row.defaultChords[0]) : null,
      defaultChord: row.rebindable && defaultPrimary ? chordText(defaultPrimary) : null,
      rebound,
    };
  });
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  // A mirror follows the binding it repeats: palette-close's ⌘K half is
  // whatever opens the palette now.
  for (const [index, binding] of bindings.entries()) {
    const source = binding.mirrors ? byId.get(binding.mirrors) : undefined;
    if (!source?.rebound) continue;
    const row = ROWS[index];
    const alternatives = [...row.companions, ...source.chords];
    const next = {
      ...binding, alternatives, chords: source.chords,
      aria: alternatives.map(chordText).join(' '),
      keys: [...row.companions.map((chord) => formatChord(chord)), source.keys].join('  ·  '),
    };
    bindings[index] = next;
    byId.set(next.id, next);
  }
  const claimed = bindings.flatMap((binding) => binding.alternatives);
  const retired = bindings.filter((binding) => binding.rebound)
    .flatMap((binding) => ROWS.find((row) => row.id === binding.id)?.defaultChords ?? [])
    .filter((chord) => !claimed.some((other) => sameChord(other, chord)));
  return { bindings, byId, retired };
}

/**
 * Can two scopes be live at the same moment? The palette is a modal dialog:
 * while it is open every other handler stands down, and while it is closed its
 * own keys are bound to nothing. Every other pair can be — the shell's chords
 * are live in the Sessions view and inside the composer alike.
 */
export function scopesOverlap(a: BindingScope, b: BindingScope): boolean {
  if (a === b || a === 'anywhere' || b === 'anywhere') return true;
  return a !== 'palette' && b !== 'palette';
}

/** The first other binding holding one of this binding's rebindable chords where both can be live. */
function conflictOf(map: EffectiveKeymap, id: string): EffectiveBinding | null {
  const self = map.byId.get(id);
  if (!self) return null;
  for (const other of map.bindings) {
    if (other.id === id || other.mirrors === id || self.mirrors === other.id) continue;
    if (!scopesOverlap(self.scope, other.scope)) continue;
    if (other.alternatives.some((alt) => self.chords.some((chord) => sameChord(chord, alt)))) return other;
  }
  return null;
}

function refusal(reason: KeymapRefusalReason, message: string, conflict: EffectiveBinding | null = null): KeymapRefusal {
  return { reason, message, conflict: conflict ? { id: conflict.id, name: conflict.name } : null };
}

function conflictRefusal(chord: Chord, other: EffectiveBinding): KeymapRefusal {
  return refusal('conflict', `${formatChord(chord)} already belongs to ${other.name}. Change that one first, or choose another chord.`, other);
}

type Checked = { ok: true; row: Row; chord: Chord } | { ok: false; refusal: KeymapRefusal };

/** Every rule that does not depend on the other rebindings. */
function checkEntry(id: unknown, text: unknown): Checked {
  const row = typeof id === 'string' ? ROW_BY_ID.get(id) : undefined;
  if (!row) {
    return { ok: false, refusal: refusal('unknown-binding', `Wanigan has no shortcut called “${clip(String(id))}”.`) };
  }
  if (!row.rebindable) return { ok: false, refusal: refusal('fixed', row.fixedReason ?? 'This shortcut is fixed.') };
  const parsed = parseChord(text);
  if (!parsed.ok) return { ok: false, refusal: refusal('unparseable', parsed.detail) };
  const chord = storedForm(parsed.chord, row);
  for (const published of expand(chord, row.aliased)) {
    const reserved = RESERVED_CHORDS.find((entry) => sameChord(entry.chord, published));
    if (reserved) {
      return { ok: false, refusal: refusal('reserved', `${formatChord(published)} ${reserved.does}, so it cannot be a shortcut here.`) };
    }
  }
  const defaultPrimary = primary(row.defaultChords);
  if (defaultPrimary && (defaultPrimary.meta || defaultPrimary.ctrl) && !chord.meta && !chord.ctrl) {
    const printable = chord.key.length === 1 || chord.key === 'Space' || chord.key === 'Plus';
    return { ok: false, refusal: refusal('bare-key', printable
      ? `${formatChord(chord)} types into whatever text field has focus. This shortcut needs ⌘ or ⌃ as well.`
      : `${formatChord(chord)} already moves focus, a caret or a dialog on its own. This shortcut needs ⌘ or ⌃ as well.`) };
  }
  return { ok: true, row, chord };
}

/** At most this many stored entries are read; the table has fewer than fifty rows. */
const MAX_STORED_ENTRIES = 256;

/**
 * A stored keymap, reduced to the rebindings this build can honour. Anything
 * else is kept out of the overlay and listed with the refusal it would get as
 * a write today — a row from a newer build, a chord this build reserves, two
 * entries that collide. Writes are validated one at a time, so a keymap this
 * build wrote never collides with itself; a collision here means the table
 * moved under it, and then the entry later in the sheet yields.
 */
export function resolveKeymap(stored: unknown): { keymap: Keymap; ignored: IgnoredKeybinding[] } {
  if (stored === null || stored === undefined) return { keymap: {}, ignored: [] };
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return { keymap: {}, ignored: [{ id: '', chord: '', refusal: refusal('unparseable', 'The stored keymap is not a set of shortcuts, so every shortcut is at its default.') }] };
  }
  const order = (id: string) => { const at = ROWS.findIndex((row) => row.id === id); return at < 0 ? ROWS.length : at; };
  const entries = Object.entries(stored as Record<string, unknown>).slice(0, MAX_STORED_ENTRIES)
    .sort(([a], [b]) => order(a) - order(b));
  const keymap: Keymap = {};
  const ignored: IgnoredKeybinding[] = [];
  for (const [id, value] of entries) {
    const checked = checkEntry(id, value);
    if (!checked.ok) {
      ignored.push({ id: clip(id), chord: clip(typeof value === 'string' ? value : JSON.stringify(value) ?? ''), refusal: checked.refusal });
      continue;
    }
    const defaultPrimary = primary(checked.row.defaultChords);
    if (defaultPrimary && sameChord(checked.chord, defaultPrimary)) continue;
    keymap[checked.row.id] = chordText(checked.chord);
  }
  for (;;) {
    const map = build(keymap);
    const clash = [...map.bindings].reverse().filter((binding) => binding.rebound)
      .map((binding) => ({ binding, other: conflictOf(map, binding.id) }))
      .find((entry) => entry.other !== null);
    if (!clash?.other) break;
    const chord = parseChord(keymap[clash.binding.id]);
    ignored.push({
      id: clash.binding.id, chord: keymap[clash.binding.id],
      refusal: chord.ok ? conflictRefusal(chord.chord, clash.other) : refusal('unparseable', 'The stored chord does not parse.'),
    });
    delete keymap[clash.binding.id];
  }
  return { keymap, ignored };
}

/** The overlay a stored keymap produces. Resolves first, so nothing unvalidated reaches a matcher or a menu. */
export function effectiveKeymap(stored: unknown): EffectiveKeymap {
  return build(resolveKeymap(stored).keymap);
}

/**
 * One rebinding against a stored keymap. Refusals come in a fixed order —
 * unknown binding, fixed, unparseable, reserved, bare key, conflict — so the
 * reason given is the most basic one that applies.
 */
export function validateRebinding(stored: unknown, id: unknown, chord: unknown): KeymapChange {
  const { keymap } = resolveKeymap(stored);
  const checked = checkEntry(id, chord);
  if (!checked.ok) return checked;
  const next: Keymap = { ...keymap };
  const defaultPrimary = primary(checked.row.defaultChords);
  if (defaultPrimary && sameChord(checked.chord, defaultPrimary)) delete next[checked.row.id];
  else next[checked.row.id] = chordText(checked.chord);
  const map = build(next);
  // A mirror moves with its source, so it is checked too: palette-close's
  // repeated chord must still be free inside the palette.
  for (const binding of map.bindings.filter((b) => b.id === checked.row.id || b.mirrors === checked.row.id)) {
    const other = conflictOf(map, binding.id);
    if (other) return { ok: false, refusal: conflictRefusal(checked.chord, other) };
  }
  return { ok: true, keymap: next };
}

/**
 * Put one binding back on its default. That is a rebinding like any other: a
 * default another binding has since taken is refused by name, not restored on
 * top of it. A fixed binding is already at its default, and resetting it only
 * drops a stored entry that was never applied.
 */
export function resetRebinding(stored: unknown, id: unknown): KeymapChange {
  const row = typeof id === 'string' ? ROW_BY_ID.get(id) : undefined;
  if (!row) return { ok: false, refusal: refusal('unknown-binding', `Wanigan has no shortcut called “${clip(String(id))}”.`) };
  const { keymap } = resolveKeymap(stored);
  const defaultPrimary = primary(row.defaultChords);
  if (!row.rebindable || !defaultPrimary) return { ok: true, keymap };
  return validateRebinding(keymap, id, chordText(defaultPrimary));
}

/** The groups and rows of the cheat sheet and of Settings › App › Keyboard. */
export function keymapGroups(map: EffectiveKeymap): { title: BindingGroup; bindings: EffectiveBinding[] }[] {
  return BINDING_GROUPS.map((title) => ({ title, bindings: map.bindings.filter((binding) => binding.group === title) }))
    .filter((group) => group.bindings.length > 0);
}

/** The sheet's key column for this platform: the table's own Mac spelling, or the Control forms in words. */
export function keysFor(binding: EffectiveBinding, platform: Platform): string {
  if (platform === 'mac') return binding.keys;
  return forPlatform(binding.alternatives, 'other').map((chord) => formatChord(chord, 'other')).join('  ·  ');
}

/** The rebindable chord in words, for an aria-label beside the printed glyphs. */
export function spokenFor(binding: EffectiveBinding | undefined, platform: Platform = 'mac'): string {
  const chord = binding ? forPlatform(binding.chords, platform)[0] : undefined;
  return chord ? speakChord(chord, platform) : '';
}

/** The rebindable chord in glyphs, without companions: ⌘/ rather than "?  ·  ⌘/". */
export function glyphsFor(binding: EffectiveBinding | undefined, platform: Platform = 'mac'): string {
  const chord = binding ? forPlatform(binding.chords, platform)[0] : undefined;
  return chord ? formatChord(chord, platform) : '';
}

const ACCELERATOR_KEY: Record<string, string> = {
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Home: 'Home', End: 'End', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', Plus: 'Plus',
};

/**
 * The Electron accelerator the menu bar prints for a binding, from the same
 * overlay the renderer matches: ⌘ becomes CommandOrControl, as it always was
 * here. A key Electron's accelerator grammar cannot spell (ß, é) prints no
 * accelerator rather than a wrong one.
 */
export function menuAccelerator(binding: EffectiveBinding | undefined): string | undefined {
  const chord = binding ? primary(binding.chords) : null;
  if (!chord) return undefined;
  const key = ACCELERATOR_KEY[chord.key]
    ?? (/^[A-Z0-9]$/.test(chord.key) || /^[\x21-\x2a\x2c-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(chord.key) ? chord.key : null);
  if (!key) return undefined;
  const command = chord.meta ? (chord.ctrl ? 'Command' : 'CommandOrControl') : null;
  return [chord.ctrl && 'Control', chord.alt && 'Alt', command, chord.shift && 'Shift', key].filter(Boolean).join('+');
}
