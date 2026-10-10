import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { COMMAND_IDS, SHORTCUTS, ariaKeys, isDevtoolsKey, keySets, keysOn, matchKey, menuAccelerator, menuSequence, shortcutFor, shortcutText, type KeyInput, type KeyState } from './shortcuts.ts';
import { windowTitle } from './views.ts';

const key = (k: string, over: Partial<KeyInput> = {}): KeyInput => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const at = (over: Partial<KeyState> = {}): KeyState => ({ mac: true, typing: false, dialog: false, afterG: false, ...over });

test('app chords work anywhere, a focused terminal included', () => {
  for (const typing of [false, true]) {
    assert.deepEqual(matchKey(key('k', { metaKey: true }), at({ typing })), { id: 'palette' });
    assert.deepEqual(matchKey(key('t', { metaKey: true }), at({ typing })), { id: 'new-session' });
    assert.deepEqual(matchKey(key('3', { metaKey: true }), at({ typing })), { id: 'project-3' });
    assert.deepEqual(matchKey(key('/', { metaKey: true }), at({ typing })), { id: 'shortcuts' });
    assert.deepEqual(matchKey(key(',', { metaKey: true }), at({ typing })), { id: 'settings' });
  }
});

test('on a Mac, Control belongs to the terminal and the text field', () => {
  for (const k of ['k', 't', '1', '/']) assert.equal(matchKey(key(k, { ctrlKey: true }), at({ typing: true })), null, `Ctrl-${k}`);
  assert.equal(matchKey(key('k', { ctrlKey: true }), at()), null);
  // Elsewhere Control is the app's modifier, and ⌘ (the Windows key) is not.
  assert.deepEqual(matchKey(key('k', { ctrlKey: true }), at({ mac: false })), { id: 'palette' });
  assert.equal(matchKey(key('k', { metaKey: true }), at({ mac: false })), null);
});

test('single keys only when nothing is being typed and no dialog is open', () => {
  assert.deepEqual(matchKey(key('c'), at()), { id: 'new-card' });
  assert.deepEqual(matchKey(key('?', { shiftKey: true }), at()), { id: 'shortcuts' });
  assert.deepEqual(matchKey(key('Escape'), at()), { id: 'close-card' });
  for (const k of ['c', '?', 'g', 'Escape']) {
    assert.equal(matchKey(key(k), at({ typing: true })), null, `${k} while typing`);
    assert.equal(matchKey(key(k), at({ dialog: true })), null, `${k} in a dialog`);
  }
  assert.equal(matchKey(key('c', { altKey: true }), at()), null);
});

test('G then a letter goes somewhere; G then C is Changes, not a new card', () => {
  assert.deepEqual(matchKey(key('g'), at()), { pending: 'g' });
  assert.deepEqual(matchKey(key('n'), at({ afterG: true })), { id: 'go-needs' });
  assert.deepEqual(matchKey(key('r'), at({ afterG: true })), { id: 'go-running' });
  assert.deepEqual(matchKey(key('b'), at({ afterG: true })), { id: 'go-board' });
  assert.deepEqual(matchKey(key('c'), at({ afterG: true })), { id: 'go-changes' });
  assert.deepEqual(matchKey(key('e'), at({ afterG: true })), { id: 'go-code' });
  assert.equal(matchKey(key('z'), at({ afterG: true })), null);
});

test('the Code tab is G then E, a key no other view or command after G uses', () => {
  assert.equal(shortcutText(shortcutFor('go-code')!, true), 'G then E');
  assert.equal(menuSequence('go-code', true), 'G then E');
  assert.equal(shortcutFor('go-code')?.label, 'Code of the open project');
  // After G each letter goes to one place only.
  const afterG = 'abcdefghijklmnopqrstuvwxyz'.split('').flatMap((k) => {
    const m = matchKey(key(k), at({ afterG: true }));
    return m && 'id' in m ? [m.id] : [];
  });
  assert.equal(new Set(afterG).size, afterG.length, `a place reached by two letters: ${afterG.join(', ')}`);
  assert.ok(afterG.includes('go-code'));
  // E alone stays nobody's: a stray E on the board does nothing.
  assert.equal(matchKey(key('e'), at()), null);
});

test('every command the keys can produce is listed on the sheet', () => {
  const produced = new Set<string>();
  const presses: [KeyInput, KeyState][] = [];
  for (const k of 'abcdefghijklmnopqrstuvwxyz0123456789/,?\\ '.split('').concat(['Escape'])) {
    for (const state of [at(), at({ afterG: true })]) {
      presses.push([key(k), state], [key(k, { metaKey: true }), state], [key(k, { shiftKey: true }), state], [key(k, { metaKey: true, shiftKey: true }), state]);
      // With ⌥ a Mac types another character; the key's code still names the letter.
      if (/^[a-z]$/.test(k)) presses.push([key(k, { metaKey: true, altKey: true, code: `Key${k.toUpperCase()}` }), state]);
    }
  }
  for (const [e, s] of presses) {
    const m = matchKey(e, s);
    if (m && 'id' in m) produced.add(m.id.startsWith('project-') ? 'project-1' : m.id);
  }
  const listed = new Set(SHORTCUTS.flatMap((s) => (s.id ? [s.id] : [])));
  assert.deepEqual([...produced].filter((id) => !listed.has(id as never)), [], 'a key the sheet does not mention');
  assert.deepEqual([...listed].filter((id) => !produced.has(id)), [], 'a listed shortcut no key produces');
  for (const id of produced) assert.ok(COMMAND_IDS.has(id), `${id} can come from the menu`);
});

test('the sheet’s board keys are the keys the board handles', () => {
  // The board and its List keep their own handlers (views/Board.tsx, views/ListView.tsx); this keeps the sheet honest about them.
  const read = (file: string): string => readFileSync(resolve(import.meta.dirname, '../renderer/src/views', file), 'utf8');
  const board = read('Board.tsx') + read('ListView.tsx');
  const named: Record<string, string> = {
    '↓': "'ArrowDown'", '↑': "'ArrowUp'", '←': "'ArrowLeft'", '→': "'ArrowRight'", Enter: "'Enter'", '1–9': '/^[1-9]$/.test(e.key)',
    Home: "'Home'", End: "'End'", PageUp: "'PageUp'", PageDown: "'PageDown'",
  };
  for (const s of SHORTCUTS.filter((x) => x.group === 'On the board')) {
    for (const keys of [s.keys, ...(s.alt ?? [])]) {
      // A Mod chord: the key after Mod, with the board checking ⌘ on a Mac and Ctrl elsewhere.
      const mod = keys[0] === 'Mod';
      const k = (mod ? keys[1] : keys[0]) as string;
      const code = named[k] ?? `'${k.toLowerCase()}'`;
      assert.ok(board.includes(code), `the board does not handle ${keys.join('+')}`);
      if (mod) assert.ok(board.includes('mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey'), `the board does not take ${keys.join('+')} as Mod on each platform`);
    }
  }
  // The saved views' numbers are the board's: the window's own keys leave a bare digit alone.
  for (const d of '123456789') assert.equal(matchKey(key(d), at()), null, `${d} is also an app key`);
});

test('the sheet’s Changes keys are the keys the Changes view handles, and none is an app key', () => {
  const read = (file: string): string => readFileSync(resolve(import.meta.dirname, '../renderer/src/views/git', file), 'utf8');
  const view = read('WorkingTree.tsx');
  const box = read('CommitBox.tsx');
  const listed = SHORTCUTS.filter((x) => x.group === 'In Changes');
  assert.deepEqual(listed.map((s) => s.keys.join()), ['J', 'K', 'V', 'S', 'Mod,Enter']);
  for (const s of listed) {
    if (s.keys[0] === 'Mod') {
      // ⌘↩ belongs to the commit box, and the window's keys leave it alone.
      assert.ok(box.includes("e.key === 'Enter' && (e.metaKey || e.ctrlKey)"), 'the commit box does not commit on ⌘↩');
      assert.equal(matchKey(key('Enter', { metaKey: true }), at({ typing: true })), null, '⌘↩ is also an app key');
      continue;
    }
    const k = (s.keys[0] as string).toLowerCase();
    assert.ok(view.includes(`key === '${k}'`), `the Changes view does not handle ${s.keys[0]}`);
    // The window's own keys must leave these alone, or one press would do two things.
    assert.equal(matchKey(key(k), at()), null, `${k} is also an app key`);
  }
});

test('the sheet’s Code tab key is the key its files handle, and the tree takes typed letters before the window does', () => {
  const tree = readFileSync(resolve(import.meta.dirname, '../renderer/src/editor/FileTree.tsx'), 'utf8');
  const listed = SHORTCUTS.filter((x) => x.group === 'In the code editor' && /Code tab/.test(x.label));
  assert.deepEqual(listed.map((s) => s.keys.join()), ['Space']);
  assert.ok(tree.includes("case ' ': choose(row, true)"), 'the tree does not open a file on Space, keeping the keys');
  for (const k of ["'ArrowDown'", "'ArrowUp'", "'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'", "'Enter'"]) assert.ok(tree.includes(`case ${k}:`), `the tree does not handle ${k}`);
  // Typing a name in the tree must not also be C (a new card) or G then a view: the tree prevents the window's handling.
  assert.ok(/jump\(e\.key, at\);\s*\}\s*e\.preventDefault\(\);/.test(tree), 'a letter typed in the tree reaches the window’s own keys');
});

test('the sheet’s Commits keys are the keys the Commits tab handles', () => {
  const view = readFileSync(resolve(import.meta.dirname, '../renderer/src/views/git/Commits.tsx'), 'utf8');
  const listed = SHORTCUTS.filter((x) => x.group === 'In Commits');
  assert.deepEqual(listed.map((s) => [s.keys.join(), s.alt?.[0]?.join()]), [['J', '↓'], ['K', '↑']]);
  for (const code of ["'j'", "'k'", "'ArrowDown'", "'ArrowUp'"]) assert.ok(view.includes(`e.key === ${code}`), `the Commits tab does not handle ${code}`);
  assert.equal(matchKey(key('j'), at()), null);
});

test('git’s chords push, pull, fetch, switch and make a branch, and ⌘P opens a file, from anywhere in the window', () => {
  for (const typing of [false, true]) {
    assert.deepEqual(matchKey(key('π', { metaKey: true, altKey: true, code: 'KeyP' }), at({ typing })), { id: 'git-push' }, '⌥⌘P, which types π');
    assert.deepEqual(matchKey(key('p', { metaKey: true }), at({ typing })), { id: 'quick-open' });
    assert.deepEqual(matchKey(key('j', { metaKey: true }), at({ typing })), { id: 'toggle-editor' });
    assert.deepEqual(matchKey(key('P', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-pull' });
    assert.deepEqual(matchKey(key('F', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-fetch' });
    assert.deepEqual(matchKey(key('b', { metaKey: true }), at({ typing })), { id: 'git-switch' });
    assert.deepEqual(matchKey(key('B', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-branch' });
  }
  assert.equal(matchKey(key('f', { metaKey: true }), at()), null, '⌘F is left for find');
  assert.equal(menuAccelerator('git-push'), 'CmdOrCtrl+Alt+P');
  assert.equal(shortcutText(shortcutFor('git-push')!, true), '⌘⌥P');
  assert.equal(menuAccelerator('quick-open'), 'CmdOrCtrl+P');
  assert.equal(menuAccelerator('toggle-editor'), 'CmdOrCtrl+J');
  assert.equal(menuAccelerator('git-pull'), 'CmdOrCtrl+Shift+P');
  assert.equal(shortcutText(shortcutFor('git-branch')!, true), '⌘⇧B');
  for (const id of ['git-commit', 'git-stash']) assert.ok(COMMAND_IDS.has(id), `${id} can come from the menu and ⌘K`);
});

test('⌘⇧Space is Go to, from anywhere in the window and while typing; Shift+Space alone is left to the live view', () => {
  for (const typing of [false, true]) assert.deepEqual(matchKey(key(' ', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'live-goto' });
  assert.deepEqual(matchKey(key(' ', { ctrlKey: true, shiftKey: true }), at({ mac: false })), { id: 'live-goto' });
  assert.equal(matchKey(key(' ', { ctrlKey: true, shiftKey: true }), at({ typing: true })), null, 'Control stays with the terminal on a Mac');
  assert.equal(matchKey(key(' ', { metaKey: true }), at()), null, '⌘Space is Spotlight’s');
  assert.equal(matchKey(key(' ', { shiftKey: true }), at()), null, 'the window does not take Shift+Space from typing anywhere');
  assert.equal(menuAccelerator('live-goto'), 'CmdOrCtrl+Shift+Space');
  assert.equal(shortcutText(shortcutFor('live-goto')!, true), '⌘⇧Space');
  // No other chord in the table is ⌘⇧Space.
  const owners = SHORTCUTS.filter((s) => [s.keys, ...(s.alt ?? [])].some((k) => k.join('+') === 'Mod+Shift+Space'));
  assert.deepEqual(owners.map((s) => s.id), ['live-goto']);
});

test('the page’s DevTools is Chrome’s own chord on each platform: ⌥⌘I on a Mac, Ctrl+Shift+I on Windows and Linux, even while typing', () => {
  for (const typing of [false, true]) {
    // ⌥ makes I a dead key on a Mac keyboard: the key's code still names it.
    assert.deepEqual(matchKey(key('Dead', { metaKey: true, altKey: true, code: 'KeyI' }), at({ typing })), { id: 'live-devtools' }, '⌥⌘I');
    assert.deepEqual(matchKey(key('I', { ctrlKey: true, shiftKey: true, code: 'KeyI' }), at({ mac: false, typing })), { id: 'live-devtools' }, 'Ctrl+Shift+I');
  }
  // Each platform's chord only: never the other's, and never a near miss.
  assert.equal(matchKey(key('I', { ctrlKey: true, shiftKey: true, code: 'KeyI' }), at()), null, 'Control+Shift+I belongs to the terminal on a Mac');
  assert.equal(matchKey(key('I', { metaKey: true, shiftKey: true, code: 'KeyI' }), at()), null, '⇧⌘I');
  assert.equal(matchKey(key('i', { ctrlKey: true, altKey: true, code: 'KeyI' }), at({ mac: false })), null, 'Ctrl+Alt+I is AltGr+I on many keyboards');
  assert.equal(matchKey(key('I', { ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyI' }), at({ mac: false })), null);
  assert.ok(!isDevtoolsKey(key('Dead', { metaKey: true, altKey: true, shiftKey: true, code: 'KeyI' }), true), '⌥⇧⌘I is Wanigan’s own DevTools');
  // Written for each platform, from the one table: the sheet, the key caps, the menu and the control's aria-keyshortcuts.
  const s = shortcutFor('live-devtools')!;
  assert.equal(shortcutText(s, true), '⌥⌘I');
  assert.equal(shortcutText(s, false), 'Ctrl+Shift+I');
  assert.deepEqual(keysOn(s, true), ['Alt', 'Mod', 'I']);
  assert.deepEqual(keysOn(s, false), ['Mod', 'Shift', 'I']);
  assert.equal(menuAccelerator('live-devtools', true), 'Alt+CmdOrCtrl+I');
  assert.equal(menuAccelerator('live-devtools', false), 'CmdOrCtrl+Shift+I');
  assert.equal(menuSequence('live-devtools', true), undefined, 'a chord, not a sequence');
  assert.equal(ariaKeys(keysOn(s, true), true), 'Alt+Meta+I');
  assert.equal(ariaKeys(keysOn(s, false), false), 'Control+Shift+I');
  // No other shortcut on the sheet is that chord, on either platform.
  for (const mac of [true, false]) {
    const chord = keysOn(s, mac).join('+');
    const owners = SHORTCUTS.filter((x) => keySets(x, mac).some((k) => k.join('+') === chord));
    assert.deepEqual(owners.map((x) => x.id), ['live-devtools'], mac ? 'macOS' : 'Windows and Linux');
  }
  // Every other shortcut reads the same on both platforms, Mod aside: only Chrome's chord differs.
  assert.deepEqual(SHORTCUTS.filter((x) => x.elsewhere).map((x) => x.id), ['live-devtools']);
});

test('menus carry the same chords, written for each platform', () => {
  assert.equal(menuAccelerator('palette'), 'CmdOrCtrl+K');
  assert.equal(menuAccelerator('new-session'), 'CmdOrCtrl+T');
  assert.equal(menuAccelerator('shortcuts'), 'CmdOrCtrl+/');
  assert.equal(menuAccelerator('project-4'), 'CmdOrCtrl+4');
  assert.equal(menuAccelerator('history'), 'CmdOrCtrl+Shift+T');
  assert.equal(menuAccelerator('go-needs'), undefined, 'a sequence is not an accelerator');
  assert.equal(menuSequence('go-needs', true), 'G then N');
  assert.equal(menuSequence('new-card', true), 'C');
  assert.equal(menuSequence('palette', true), undefined);
  assert.equal(shortcutText(SHORTCUTS.find((s) => s.id === 'shortcuts')!, true), '⌘/ or ?');
  assert.equal(shortcutText(SHORTCUTS.find((s) => s.id === 'palette')!, false), 'Ctrl+K');
});

test('⌘\\ is no one’s: the rail is always its 60 px, and Control-\\ stays with the terminal', () => {
  const chord = (keys: string[]): string => keys.join('+');
  const owners = SHORTCUTS.filter((s) => [s.keys, ...(s.alt ?? [])].some((k) => chord(k) === 'Mod+\\'));
  assert.deepEqual(owners.map((s) => s.id), []);
  for (const typing of [false, true]) assert.equal(matchKey(key('\\', { metaKey: true }), at({ typing })), null, '⌘\\ is not taken from a view or a terminal');
  assert.equal(matchKey(key('\\', { ctrlKey: true }), at({ typing: true })), null, 'Control-\\ quits a shell program');
  assert.equal(matchKey(key('\\'), at()), null);
  assert.equal(COMMAND_IDS.has('toggle-rail'), false, 'the menu cannot send a command that is gone');
});

test('a command’s keys are read from the table, a project’s chord its own digit', () => {
  assert.deepEqual(shortcutFor('new-session')?.keys, ['Mod', 'T']);
  assert.equal(shortcutText(shortcutFor('go-board')!, true), 'G then B');
  assert.deepEqual(shortcutFor('project-3')?.keys, ['Mod', '3']);
  assert.equal(shortcutText(shortcutFor('project-3')!, true), '⌘3');
  assert.equal(shortcutFor('go-accounts'), undefined, 'a command with no key has no caps');
});

test('the window title says where you are, the app last', () => {
  assert.equal(windowTitle({ view: 'Board', project: 'Northstar', session: null, card: null }), 'Northstar · Board — Wanigan');
  assert.equal(windowTitle({ view: 'Board', project: 'Northstar', session: null, card: 'NS-7' }), 'Northstar · Board · NS-7 — Wanigan');
  assert.equal(windowTitle({ view: 'Session', project: 'Northstar', session: 'Checkout lead', card: null }), 'Northstar · Checkout lead — Wanigan');
  assert.equal(windowTitle({ view: 'Needs you', project: null, session: null, card: 'NS-7' }), 'Needs you · NS-7 — Wanigan');
  assert.equal(windowTitle({ view: 'Running', project: null, session: null, card: null }), 'Running — Wanigan');
});
