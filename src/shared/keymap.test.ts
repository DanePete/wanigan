/**
 * The keymap's pure half. The subject is what a rebinding may not do: take a
 * key the terminal owns, take a key macOS or a text field owns, sit on a chord
 * another binding already holds, or print a chord that is not the one pressed.
 * Every fixture chord is written the way aria-keyshortcuts spells it, because
 * that string is what the renderer publishes and matches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDINGS } from './bindings.ts';
import { TAB_SHORTCUTS, TABS } from './routes.ts';
import {
  KEYMAP_RULES, chordMatchesEvent, chordText, chordTextFromEvent, effectiveKeymap, formatChord, glyphsFor, keymapGroups,
  keysFor, menuAccelerator, parseChord, resetRebinding, resolveKeymap, scopesOverlap, speakChord, spokenFor,
  validateRebinding, type Chord, type KeyEventLike,
} from './keymap.ts';

const chord = (text: string): Chord => {
  const parsed = parseChord(text);
  assert.ok(parsed.ok, `${text} parses`);
  return parsed.chord;
};
const press = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const refusalOf = (keymap: unknown, id: unknown, text: unknown) => {
  const result = validateRebinding(keymap, id, text);
  assert.equal(result.ok, false, `${String(id)} → ${String(text)} is refused`);
  return result.ok ? null : result.refusal;
};
const accept = (keymap: unknown, id: string, text: string) => {
  const result = validateRebinding(keymap, id, text);
  assert.ok(result.ok, `${id} → ${text} is accepted: ${result.ok ? '' : result.refusal.message}`);
  return result.ok ? result.keymap : {};
};

test('with nothing rebound, every row publishes and prints exactly what the table says', () => {
  const map = effectiveKeymap({});
  for (const binding of BINDINGS) {
    const row = map.byId.get(binding.id);
    assert.equal(row?.aria, binding.aria, binding.id);
    assert.equal(row?.keys, binding.keys, binding.id);
    assert.equal(row?.rebound, false);
  }
  for (const tab of TABS) {
    const row = map.byId.get(`view:${tab.id}`);
    assert.equal(row?.aria, TAB_SHORTCUTS[tab.id].aria, tab.id);
    assert.equal(row?.keys, TAB_SHORTCUTS[tab.id].label, tab.id);
  }
  assert.deepEqual(map.retired, []);
});

test('every default chord is one a person could have chosen: parseable, unreserved and conflict-free', () => {
  // Validating each default as though it were a write runs every rule against
  // the table itself. A default that failed would make its own Reset refuse.
  const map = effectiveKeymap({});
  for (const binding of map.bindings) {
    for (const alt of binding.alternatives) assert.equal(chordText(alt), chordText(chord(chordText(alt))));
    if (!binding.rebindable) continue;
    const result = validateRebinding({}, binding.id, binding.defaultChord);
    assert.ok(result.ok, `${binding.id}: ${result.ok ? '' : result.refusal.message}`);
    assert.deepEqual(result.ok && result.keymap, {});
  }
});

test('every binding in the table carries a decision, and a fixed one says why in words', () => {
  for (const binding of BINDINGS) {
    const rule = KEYMAP_RULES[binding.id];
    assert.ok(rule, binding.id);
    if (!rule.rebindable) assert.ok(rule.reason.length > 40, `${binding.id} explains itself`);
  }
});

test('a chord is normalised to one spelling, whichever way it was written', () => {
  assert.equal(chordText(chord('shift+meta+n')), 'Meta+Shift+N');
  assert.equal(chordText(chord('Alt+Control+Meta+k')), 'Control+Alt+Meta+K');
  // The layout spent Shift producing ?, so ⌘⇧/ and ⌘? are the same presses.
  assert.equal(chordText(chord('Meta+Shift+?')), 'Meta+?');
  assert.equal(chordText(chord('Meta++')), 'Meta+Plus');
  assert.equal(chordText(chord('meta+arrowleft')), 'Meta+ArrowLeft');
  assert.equal(chordText(chord('Shift+Enter')), 'Shift+Enter');
});

test('what is not a chord is refused with a reason, including characters that would reorder a sentence', () => {
  for (const text of ['', 'Meta+', 'Hyper+N', 'Meta+Meta+N', 'Meta+F5', 'Meta+Dead', 'Meta N', 'Meta+\u202e', 'Meta+\u0000', 42, null]) {
    const parsed = parseChord(text);
    assert.equal(parsed.ok, false, JSON.stringify(text));
  }
  const refusal = refusalOf({}, 'new-session', 'Meta+F5');
  assert.equal(refusal?.reason, 'unparseable');
  assert.match(refusal?.message ?? '', /F5/);
});

test('capture reads a keydown as the matcher will, and waits past modifiers held alone', () => {
  assert.equal(chordTextFromEvent(press('Meta', { metaKey: true })), null);
  assert.equal(chordTextFromEvent(press('Shift', { shiftKey: true, metaKey: true })), null);
  assert.equal(chordTextFromEvent(press('n', { metaKey: true })), 'Meta+N');
  assert.equal(chordTextFromEvent(press('N', { metaKey: true, shiftKey: true })), 'Meta+Shift+N');
  assert.equal(chordTextFromEvent(press('?', { metaKey: true, shiftKey: true })), 'Meta+?');
  assert.equal(chordTextFromEvent(press(' ', { ctrlKey: true })), 'Control+Space');
  // ⌥S is ß on a Mac layout and ⌥N a dead key several letters share; the
  // physical key is the chord, for capture and matching alike.
  assert.equal(chordTextFromEvent(press('ß', { code: 'KeyS', altKey: true, metaKey: true })), 'Alt+Meta+S');
  assert.equal(chordTextFromEvent(press('Dead', { code: 'KeyN', altKey: true, metaKey: true })), 'Alt+Meta+N');
  assert.ok(chordMatchesEvent(chord('Alt+Meta+S'), press('ß', { code: 'KeyS', altKey: true, metaKey: true })));
  // A key no chord can use comes back as written, so the refusal can name it.
  assert.equal(chordTextFromEvent(press('F5', { metaKey: true })), 'Meta+F5');
});

test('a chord matches exactly the presses it names', () => {
  assert.ok(chordMatchesEvent(chord('Meta+K'), press('k', { metaKey: true })));
  assert.equal(chordMatchesEvent(chord('Meta+K'), press('k', { metaKey: true, ctrlKey: true })), false);
  assert.equal(chordMatchesEvent(chord('Meta+S'), press('S', { metaKey: true, shiftKey: true })), false);
  assert.equal(chordMatchesEvent(chord('Alt+Meta+ArrowLeft'), press('ArrowLeft', { altKey: true, metaKey: true, shiftKey: true })), false);
  assert.ok(chordMatchesEvent(chord('?'), press('?', { shiftKey: true })));
  assert.equal(chordMatchesEvent(chord('?'), press('?', { shiftKey: true, metaKey: true })), false);
});

test('a chord prints in the table’s Mac spelling, in words elsewhere, and speaks as the header does', () => {
  assert.equal(formatChord(chord('Meta+Shift+D')), '⌘⇧D');
  assert.equal(formatChord(chord('Alt+Meta+S')), '⌥⌘S');
  assert.equal(formatChord(chord('Control+Alt+Meta+Shift+ArrowLeft')), '⌃⌥⌘⇧←');
  assert.equal(formatChord(chord('Control+Shift+D'), 'other'), 'Ctrl+Shift+D');
  assert.equal(speakChord(chord('Alt+Meta+S')), 'Option Command S');
  assert.equal(speakChord(chord('Meta+/')), 'Command Slash');
  assert.equal(speakChord(chord('Control+K'), 'other'), 'Control K');
  const map = effectiveKeymap({});
  // Where the table lists ⌘ and ⌃ as one binding, each platform prints its own.
  assert.equal(keysFor(map.byId.get('palette')!, 'other'), 'Ctrl+K');
  assert.equal(keysFor(map.byId.get('sheet')!, 'other'), '?  ·  Ctrl+/');
  assert.equal(glyphsFor(map.byId.get('sheet')), '⌘/');
  assert.equal(spokenFor(map.byId.get('new-session')), 'Command T');
});

test('each refusal is named: unknown, fixed, unparseable, reserved, bare key, conflict', () => {
  assert.equal(refusalOf({}, 'no-such-binding', 'Meta+N')?.reason, 'unknown-binding');
  assert.equal(refusalOf({}, 42, 'Meta+N')?.reason, 'unknown-binding');
  assert.equal(refusalOf({}, 'send', 'Meta+N')?.reason, 'fixed');
  assert.equal(refusalOf({}, 'rail-move', 'Meta+N')?.reason, 'fixed');
  assert.equal(refusalOf({}, 'new-session', 'Meta+Hyper')?.reason, 'unparseable');

  for (const text of ['Meta+Q', 'Meta+W', 'Meta+H', 'Meta+M', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+Z', 'Meta+Shift+Z', 'Meta+A', 'Enter', 'Shift+Enter']) {
    assert.equal(refusalOf({}, 'new-session', text)?.reason, 'reserved', text);
  }
  assert.match(refusalOf({}, 'new-session', 'Meta+Q')?.message ?? '', /^⌘Q quits Wanigan/);
  // ⌃C on a binding the table lists both ways is published as ⌘C too.
  assert.equal(refusalOf({}, 'demo', 'Control+C')?.reason, 'reserved');

  for (const text of ['N', 'Shift+N', 'Alt+N', 'ArrowDown', 'Space']) {
    assert.equal(refusalOf({}, 'new-session', text)?.reason, 'bare-key', text);
  }

  const taken = refusalOf({}, 'new-session', 'Meta+K');
  assert.equal(taken?.reason, 'conflict');
  assert.deepEqual(taken?.conflict, { id: 'palette', name: 'Command palette' });
  assert.match(taken?.message ?? '', /⌘K already belongs to Command palette/);
  assert.deepEqual(refusalOf({}, 'view:fleet', 'Meta+1')?.conflict, { id: 'view:sessions', name: 'Open Sessions' });
  // The composer is outside the terminal, so every shell chord is live in it.
  assert.deepEqual(refusalOf({}, 'stash', 'Meta+Shift+S')?.conflict, { id: 'view:skills', name: 'Open Skills' });
});

test('the interrupt keeps skipping the terminal, and no rebinding lets another binding do it', () => {
  assert.equal(refusalOf({}, 'interrupt', 'Meta+I')?.reason, 'fixed');
  // A stored entry for it — written by hand, or by some other build — is not applied.
  const resolved = resolveKeymap({ interrupt: 'Meta+I' });
  assert.deepEqual(resolved.keymap, {});
  assert.equal(resolved.ignored[0]?.refusal.reason, 'fixed');
  const free = ['Meta+J', 'Meta+L', 'Meta+N', 'Meta+O', 'Meta+P', 'Meta+Y', 'Meta+G', 'Meta+Shift+J', 'Meta+Shift+L'];
  let keymap = {};
  for (const [index, id] of ['palette', 'new-session', 'demo', 'sheet', 'sidebar', 'session-prev', 'session-next', 'stash', 'view:fleet'].entries()) {
    keymap = accept(keymap, id, free[index]);
  }
  const map = effectiveKeymap(keymap);
  assert.deepEqual(map.bindings.filter((b) => b.skipsTerminal).map((b) => b.id), ['interrupt']);
  assert.equal(map.byId.get('interrupt')?.aria, 'Meta+. Control+.');
});

test('a valid rebinding is published both ways, printed once, and retires the old chord', () => {
  const keymap = accept({}, 'new-session', 'Meta+N');
  assert.deepEqual(keymap, { 'new-session': 'Meta+N' });
  const map = effectiveKeymap(keymap);
  const row = map.byId.get('new-session');
  assert.equal(row?.aria, 'Meta+N Control+N');
  assert.equal(row?.keys, '⌘N');
  assert.equal(row?.rebound, true);
  assert.deepEqual(map.retired.map(chordText), ['Meta+T', 'Control+T']);
  assert.ok(!map.bindings.some((b) => b.alternatives.some((alt) => chordText(alt) === 'Meta+T')));
  // A ⌃ capture of a binding listed both ways is stored as its ⌘ form.
  assert.deepEqual(accept({}, 'new-session', 'Control+N'), { 'new-session': 'Meta+N' });
  // A binding listed with ⌘ alone keeps exactly the chord it was given.
  assert.equal(effectiveKeymap(accept({}, 'sidebar', 'Control+Alt+L')).byId.get('sidebar')?.aria, 'Control+Alt+L');
});

test('a freed default can be taken, and the chord that was moved becomes free for it', () => {
  let keymap = accept({}, 'new-session', 'Meta+N');
  keymap = accept(keymap, 'view:fleet', 'Meta+T');
  const map = effectiveKeymap(keymap);
  assert.equal(map.byId.get('view:fleet')?.aria, 'Meta+T Control+T');
  // ⌘T is claimed again, so it is no longer retired, and ⌘2 is.
  assert.deepEqual(map.retired.map(chordText), ['Meta+2', 'Control+2']);
});

test('reset restores the default, unless another binding has taken it since, which it names', () => {
  let keymap = accept({}, 'new-session', 'Meta+N');
  const reset = resetRebinding(keymap, 'new-session');
  assert.ok(reset.ok);
  assert.deepEqual(reset.ok && reset.keymap, {});
  keymap = accept(keymap, 'view:fleet', 'Meta+T');
  const refused = resetRebinding(keymap, 'new-session');
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.refusal.conflict, { id: 'view:fleet', name: 'Open Fleet' });
  assert.equal(resetRebinding(keymap, 'nope').ok, false);
  // Choosing the default by hand is the same as Reset: nothing is stored.
  assert.deepEqual(accept({ 'new-session': 'Meta+N' }, 'new-session', 'Meta+T'), {});
});

test('the palette’s close chord follows the palette, and is not a conflict with it', () => {
  const map = effectiveKeymap(accept({}, 'palette', 'Meta+P'));
  assert.equal(map.byId.get('palette')?.aria, 'Meta+P Control+P');
  assert.equal(map.byId.get('palette-close')?.aria, 'Escape Meta+P Control+P');
  assert.equal(map.byId.get('palette-close')?.keys, 'Esc  ·  ⌘P');
  assert.deepEqual(map.retired.map(chordText), ['Meta+K', 'Control+K']);
});

test('the cheat sheet keeps its bare ? when its chord moves', () => {
  const map = effectiveKeymap(accept({}, 'sheet', 'Meta+J'));
  assert.equal(map.byId.get('sheet')?.aria, '? Meta+J Control+J');
  assert.equal(map.byId.get('sheet')?.keys, '?  ·  ⌘J');
  assert.equal(refusalOf({}, 'sheet', '?')?.reason, 'bare-key');
});

test('a stored keymap applies only what this build can honour, and says what it left out', () => {
  assert.equal(resolveKeymap('not an object').ignored[0]?.refusal.reason, 'unparseable');
  assert.equal(resolveKeymap([]).ignored.length, 1);
  const resolved = resolveKeymap({
    'from-a-newer-build': 'Meta+N', 'new-session': 'Meta+Q', demo: 'Meta+J', send: 'Meta+Enter', stash: 42,
  });
  assert.deepEqual(resolved.keymap, { demo: 'Meta+J' });
  assert.deepEqual(resolved.ignored.map((entry) => [entry.id, entry.refusal.reason]).sort(),
    [['from-a-newer-build', 'unknown-binding'], ['new-session', 'reserved'], ['send', 'fixed'], ['stash', 'unparseable']]);
  // Two stored entries on one chord: the later row in the sheet yields,
  // whichever order the JSON happened to list them in.
  for (const stored of [{ demo: 'Meta+J', sidebar: 'Meta+J' }, { sidebar: 'Meta+J', demo: 'Meta+J' }]) {
    const clash = resolveKeymap(stored);
    assert.deepEqual(clash.keymap, { demo: 'Meta+J' });
    assert.deepEqual(clash.ignored.map((entry) => [entry.id, entry.refusal.conflict?.id]), [['sidebar', 'demo']]);
  }
  // A rebinding onto a chord a default still holds yields to the default.
  const ontoDefault = resolveKeymap({ demo: 'Meta+K' });
  assert.deepEqual(ontoDefault.keymap, {});
  assert.equal(ontoDefault.ignored[0]?.refusal.conflict?.id, 'palette');
});

test('the menu bar prints the effective chord in Electron’s spelling, and nothing it cannot spell', () => {
  const map = effectiveKeymap({});
  assert.equal(menuAccelerator(map.byId.get('new-session')), 'CommandOrControl+T');
  assert.equal(menuAccelerator(map.byId.get('sidebar')), 'Alt+CommandOrControl+S');
  assert.equal(menuAccelerator(map.byId.get('view:settings')), 'CommandOrControl+,');
  assert.equal(menuAccelerator(map.byId.get('view:skills')), 'CommandOrControl+Shift+S');
  assert.equal(menuAccelerator(map.byId.get('sheet')), 'CommandOrControl+/');
  assert.equal(menuAccelerator(effectiveKeymap(accept({}, 'new-session', 'Meta+N')).byId.get('new-session')), 'CommandOrControl+N');
  // ⌘+ is View › Zoom In; with ⌥ it is free, and Electron spells the key as a word.
  assert.equal(refusalOf({}, 'new-session', 'Meta+Plus')?.reason, 'reserved');
  assert.equal(menuAccelerator(effectiveKeymap(accept({}, 'new-session', 'Alt+Meta+Plus')).byId.get('new-session')), 'Alt+CommandOrControl+Plus');
  assert.equal(menuAccelerator(effectiveKeymap(accept({}, 'new-session', 'Meta+ß')).byId.get('new-session')), undefined);
  assert.equal(menuAccelerator(undefined), undefined);
});

test('the palette cannot collide with anything outside itself; every other scope can', () => {
  assert.equal(scopesOverlap('palette', 'sessions'), false);
  assert.equal(scopesOverlap('palette', 'palette'), true);
  assert.equal(scopesOverlap('composer', 'not-terminal'), true);
  assert.equal(scopesOverlap('sessions', 'not-field'), true);
});

test('Settings and the sheet read one grouping, in the sheet’s order', () => {
  const groups = keymapGroups(effectiveKeymap({}));
  assert.deepEqual(groups.map((group) => group.title), ['Anywhere', 'Destination list', 'Sessions view', 'Composer', 'Command palette']);
  const anywhere = groups[0].bindings.map((binding) => binding.id);
  assert.deepEqual(anywhere.slice(0, 3), ['palette', 'new-session', 'view:sessions']);
  assert.deepEqual(anywhere.slice(-3), ['demo', 'sheet', 'sidebar']);
  assert.equal(groups.reduce((sum, group) => sum + group.bindings.length, 0), BINDINGS.length + TABS.length);
});
