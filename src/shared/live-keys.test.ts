import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LIVE_KEYS, LIVE_PAGE_KEYS, isAddKey, isLiveKeyId, isSendKey, liveKey } from './live-keys.ts';
import { SHORTCUTS, matchKey, type KeyInput } from './shortcuts.ts';

const press = (keys: string[]): KeyInput => {
  const shift = keys.includes('Shift');
  const mod = keys.includes('Mod');
  const k = keys[keys.length - 1] as string;
  const key = k === 'Enter' ? 'Enter' : shift ? k.toUpperCase() : k.toLowerCase();
  return { key, shiftKey: shift, metaKey: mod, ctrlKey: false, altKey: false };
};

const listed = SHORTCUTS.filter((s) => s.group === 'In the live view');

test('the shortcut sheet lists exactly the live view’s keys, and each does what it says', () => {
  const said = listed.flatMap((s) => [s.keys, ...(s.alt ?? [])].map((keys) => {
    const e = press(keys);
    return `${s.label}: ${liveKey(e) ?? (isSendKey(e, true) ? 'send' : isAddKey(e, true) ? 'add' : 'nothing')}`;
  }));
  assert.deepEqual(said, [
    'Pick a part on the page, or stop picking: pick',
    'Colour the page by a lens: lens',
    'Phone, tablet or full width: width-phone', 'Phone, tablet or full width: width-tablet', 'Phone, tablet or full width: width-full',
    'Previous or next tab of the side panel: tab-previous', 'Previous or next tab of the side panel: tab-next',
    'Compare Local with a hosted environment: compare',
    'Every way to edit the chosen part: edit',
    'Move the chosen part: move',
    'The chosen part’s code, in the code editor: code',
    'Show the chosen part alone: alone',
    'Add the note to the notes (in the note box): add',
    'Send the note now, or the notes waiting: send',
  ]);
  // Every key the live view answers is on the sheet.
  const produced = new Set(listed.flatMap((s) => [s.keys, ...(s.alt ?? [])].map((k) => liveKey(press(k)))).filter(Boolean));
  assert.deepEqual(LIVE_KEYS.map((k) => k.id).filter((id) => !produced.has(id)), []);
});

test('a live view key is never a key the sheet gives to something else', () => {
  const others = SHORTCUTS.filter((s) => s.group !== 'In the live view');
  // The same meaning, said the same way: Compare's 1, 2 and 3 are the same three widths.
  const same = new Set(['1', '2', '3']);
  for (const s of listed) {
    for (const keys of [s.keys, ...(s.alt ?? [])]) {
      const chord = keys.join('+');
      if (same.has(chord)) {
        assert.ok(others.some((o) => o.group === 'Comparing pages' && /width/.test(o.label) && [o.keys, ...(o.alt ?? [])].some((k) => k.join('+') === chord)));
        continue;
      }
      // ⌘↩ in the note box was already its key; listing it does not take it from the dialogs and the commit box, where it means the same: done, keep it.
      if (chord === 'Mod+Enter') continue;
      const owner = others.find((o) => [o.keys, ...(o.alt ?? [])].some((k) => k.join('+') === chord));
      assert.equal(owner, undefined, `${chord} is also ${owner?.label} (${owner?.group})`);
    }
  }
});

test('the window’s own keys leave the live view’s alone, and ⌘R is never one', () => {
  for (const k of LIVE_KEYS) {
    const e = { key: k.shift ? k.key.toUpperCase() : k.key, shiftKey: k.shift, metaKey: false, ctrlKey: false, altKey: false };
    assert.equal(matchKey(e, { mac: true, typing: false, dialog: false, afterG: false }), null, `${k.id} is also an app key`);
  }
  assert.ok(!listed.some((s) => [s.keys, ...(s.alt ?? [])].some((k) => k.join('+') === 'Mod+R')), '⌘R reloads Wanigan’s own window');
  assert.equal(matchKey({ key: 'Enter', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, { mac: true, typing: true, dialog: false, afterG: false }), null);
});

test('modifiers other than Shift are never a live view key, and Shift is part of the key', () => {
  assert.equal(liveKey({ key: 'p', shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }), null, '⌘P opens a file');
  assert.equal(liveKey({ key: 'p', shiftKey: false, metaKey: false, ctrlKey: false, altKey: true }), null);
  assert.equal(liveKey({ key: 'l', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }), null, 'plain L is the board’s');
  assert.equal(liveKey({ key: 'c', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }), null, 'plain C is a new card');
  assert.equal(liveKey({ key: 'a', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }), null);
  assert.equal(liveKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }), null);
  assert.equal(liveKey({ key: 'P', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }), 'pick', 'Caps Lock still picks');
  assert.ok(isSendKey({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: true, altKey: false }, false));
  assert.ok(!isSendKey({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: true, altKey: false }, true), 'Control belongs to the text field on a Mac');
  assert.ok(!isAddKey({ key: 'Enter', shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, true));
});

test('the page gives up only the keys that need no chosen part, and the window handles every key', () => {
  assert.deepEqual(LIVE_PAGE_KEYS.map((k) => k.id), ['pick', 'lens', 'width-phone', 'width-tablet', 'width-full', 'tab-previous', 'tab-next', 'compare']);
  assert.ok(isLiveKeyId('compare') && !isLiveKeyId('goto') && !isLiveKeyId(null));
  const live = readFileSync(resolve(import.meta.dirname, '../renderer/src/components/Live.tsx'), 'utf8');
  for (const k of LIVE_KEYS) assert.ok(live.includes(`case '${k.id}'`), `the live view does not handle ${k.id}`);
});
