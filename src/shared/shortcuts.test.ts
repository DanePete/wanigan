import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { COMMAND_IDS, SHORTCUTS, matchKey, menuAccelerator, menuSequence, shortcutFor, shortcutText, type KeyInput, type KeyState } from './shortcuts.ts';
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
    assert.deepEqual(matchKey(key('\\', { metaKey: true }), at({ typing })), { id: 'toggle-rail' });
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
  assert.equal(matchKey(key('z'), at({ afterG: true })), null);
});

test('every command the keys can produce is listed on the sheet', () => {
  const produced = new Set<string>();
  const presses: [KeyInput, KeyState][] = [];
  for (const k of 'abcdefghijklmnopqrstuvwxyz0123456789/,?\\'.split('').concat(['Escape'])) {
    for (const state of [at(), at({ afterG: true })]) {
      presses.push([key(k), state], [key(k, { metaKey: true }), state], [key(k, { shiftKey: true }), state], [key(k, { metaKey: true, shiftKey: true }), state]);
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
  // The board keeps its own handler (views/Board.tsx); this keeps the sheet honest about it.
  const board = readFileSync(resolve(import.meta.dirname, '../renderer/src/views/Board.tsx'), 'utf8');
  for (const s of SHORTCUTS.filter((x) => x.group === 'On the board')) {
    for (const keys of [s.keys, ...(s.alt ?? [])]) {
      const k = keys[0] as string;
      const code = { '↓': "'ArrowDown'", '↑': "'ArrowUp'", '←': "'ArrowLeft'", '→': "'ArrowRight'", Enter: "'Enter'", '1–9': '/^[1-9]$/.test(e.key)' }[k] ?? `'${k.toLowerCase()}'`;
      assert.ok(board.includes(code), `the board does not handle ${k}`);
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

test('the sheet’s Commits keys are the keys the Commits tab handles', () => {
  const view = readFileSync(resolve(import.meta.dirname, '../renderer/src/views/git/Commits.tsx'), 'utf8');
  const listed = SHORTCUTS.filter((x) => x.group === 'In Commits');
  assert.deepEqual(listed.map((s) => [s.keys.join(), s.alt?.[0]?.join()]), [['J', '↓'], ['K', '↑']]);
  for (const code of ["'j'", "'k'", "'ArrowDown'", "'ArrowUp'"]) assert.ok(view.includes(`e.key === ${code}`), `the Commits tab does not handle ${code}`);
  assert.equal(matchKey(key('j'), at()), null);
});

test('git’s chords push, pull, fetch, switch and make a branch, from anywhere in the window', () => {
  for (const typing of [false, true]) {
    assert.deepEqual(matchKey(key('p', { metaKey: true }), at({ typing })), { id: 'git-push' });
    assert.deepEqual(matchKey(key('P', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-pull' });
    assert.deepEqual(matchKey(key('F', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-fetch' });
    assert.deepEqual(matchKey(key('b', { metaKey: true }), at({ typing })), { id: 'git-switch' });
    assert.deepEqual(matchKey(key('B', { metaKey: true, shiftKey: true }), at({ typing })), { id: 'git-branch' });
  }
  assert.equal(matchKey(key('f', { metaKey: true }), at()), null, '⌘F is left for find');
  assert.equal(menuAccelerator('git-push'), 'CmdOrCtrl+P');
  assert.equal(menuAccelerator('git-pull'), 'CmdOrCtrl+Shift+P');
  assert.equal(shortcutText(shortcutFor('git-branch')!, true), '⌘⇧B');
  for (const id of ['git-commit', 'git-stash']) assert.ok(COMMAND_IDS.has(id), `${id} can come from the menu and ⌘K`);
});

test('menus carry the same chords, written for each platform', () => {
  assert.equal(menuAccelerator('palette'), 'CmdOrCtrl+K');
  assert.equal(menuAccelerator('new-session'), 'CmdOrCtrl+T');
  assert.equal(menuAccelerator('shortcuts'), 'CmdOrCtrl+/');
  assert.equal(menuAccelerator('project-4'), 'CmdOrCtrl+4');
  assert.equal(menuAccelerator('toggle-rail'), 'CmdOrCtrl+\\');
  assert.equal(menuAccelerator('go-needs'), undefined, 'a sequence is not an accelerator');
  assert.equal(menuSequence('go-needs', true), 'G then N');
  assert.equal(menuSequence('new-card', true), 'C');
  assert.equal(menuSequence('palette', true), undefined);
  assert.equal(shortcutText(SHORTCUTS.find((s) => s.id === 'shortcuts')!, true), '⌘/ or ?');
  assert.equal(shortcutText(SHORTCUTS.find((s) => s.id === 'palette')!, false), 'Ctrl+K');
});

test('⌘\\ is the sidebar’s alone, and Control-\\ stays with the terminal', () => {
  const chord = (keys: string[]): string => keys.join('+');
  const owners = SHORTCUTS.filter((s) => [s.keys, ...(s.alt ?? [])].some((k) => chord(k) === 'Mod+\\'));
  assert.deepEqual(owners.map((s) => s.id), ['toggle-rail']);
  assert.equal(matchKey(key('\\', { ctrlKey: true }), at({ typing: true })), null, 'Control-\\ quits a shell program');
  assert.equal(matchKey(key('\\'), at()), null);
  assert.equal(shortcutText(shortcutFor('toggle-rail')!, true), '⌘\\');
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
