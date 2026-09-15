/**
 * Shortcut search and the code rail window's addressing, the pure half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordEventInit, shortcutQuery, shortcutRunnability } from './shortcut-search.ts';
import { CODE_RAIL_CHANNELS, codeRailMayCall, codeRailQuery, codeRailSessionFromQuery } from './code-rail-window.ts';

test('? and "shortcut" narrow the palette to bindings, and what follows still searches', () => {
  assert.deepEqual(shortcutQuery('?'), { onlyShortcuts: true, rest: '' });
  assert.deepEqual(shortcutQuery('  ? close'), { onlyShortcuts: true, rest: 'close' });
  assert.deepEqual(shortcutQuery('shortcuts'), { onlyShortcuts: true, rest: '' });
  assert.deepEqual(shortcutQuery('Keyboard shortcut interrupt'), { onlyShortcuts: true, rest: 'interrupt' });
  assert.deepEqual(shortcutQuery('shortcutting'), { onlyShortcuts: false, rest: 'shortcutting' });
  assert.deepEqual(shortcutQuery('fleet'), { onlyShortcuts: false, rest: 'fleet' });
});

test('a chord in a field or the palette is listed but not run', () => {
  assert.deepEqual(shortcutRunnability({ id: 'send', aria: 'Enter', scope: 'composer' }).runnable, false);
  assert.deepEqual(shortcutRunnability({ id: 'palette', aria: 'Meta+K Control+K', scope: 'not-terminal' }).runnable, false);
  assert.deepEqual(shortcutRunnability({ id: 'rail-move', aria: 'ArrowUp ArrowDown Home End', scope: 'not-terminal' }).runnable, false);
  assert.deepEqual(shortcutRunnability({ id: 'side-panel', aria: 'Meta+B Control+B', scope: 'sessions' }), { runnable: true, needsSessions: true });
  assert.deepEqual(shortcutRunnability({ id: 'session-prev', aria: 'Alt+Meta+ArrowLeft', scope: 'sessions' }), { runnable: true, needsSessions: true });
  assert.deepEqual(shortcutRunnability({ id: 'demo', aria: 'Meta+Shift+D Control+Shift+D', scope: 'not-terminal' }), { runnable: true, needsSessions: false });
});

test('a chord becomes the key event its first command alternative describes', () => {
  assert.deepEqual(chordEventInit('Meta+Shift+T Control+Shift+T'), { key: 't', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true });
  assert.deepEqual(chordEventInit('Alt+Meta+ArrowLeft'), { key: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false });
  assert.deepEqual(chordEventInit("Meta+' Control+'"), { key: "'", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
  assert.equal(chordEventInit('Enter'), null);
});

test('a code rail window is addressed by a query main builds and the renderer only reads', () => {
  const q = codeRailQuery('s_1a2b-c');
  assert.equal(codeRailSessionFromQuery(`?${q}`), 's_1a2b-c');
  assert.equal(codeRailSessionFromQuery('view=code-rail&session=../../etc'), null);
  assert.equal(codeRailSessionFromQuery('view=sessions&session=s1'), null);
  assert.equal(codeRailSessionFromQuery(''), null);
});

test('the code rail window may call its panel’s channels and nothing that writes to a PTY, launches or reads secrets', () => {
  for (const ch of ['code:read', 'code:diff', 'checkpoints:list', 'revert:plan', 'ux:railSession']) assert.equal(codeRailMayCall(ch), true, ch);
  for (const ch of ['sessions:write', 'sessions:create', 'sessions:kill', 'key:set', 'settings:set', 'shell:openExternal', 'browse:open', 'ux:copyText', 'transcripts:get']) {
    assert.equal(codeRailMayCall(ch), false, ch);
  }
  assert.ok(CODE_RAIL_CHANNELS.size < 20);
});
