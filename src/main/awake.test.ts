// Keeping the Mac awake, and the settings file it is switched by. No Electron:
// the blocker is a stand-in that records what was asked of it, and the settings
// file lives in a temporary folder.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, liveFor, patchSettings, readSettings } from '../shared/settings.ts';
import { KeepAwake, type Blocker } from './awake.ts';
import { SettingsStore } from './settings.ts';

function fakeBlocker(): Blocker & { calls: string[]; active: Set<number> } {
  let next = 1;
  const active = new Set<number>();
  const calls: string[] = [];
  return {
    calls,
    active,
    start(type) { calls.push(`start ${type}`); active.add(next); return next++; },
    stop(id) { calls.push(`stop ${id}`); active.delete(id); },
  };
}

test('the Mac is held awake exactly while a session is live', () => {
  const b = fakeBlocker();
  const awake = new KeepAwake(b, true);
  assert.equal(awake.holding, false);
  awake.setLive(2);
  assert.equal(awake.holding, true);
  awake.setLive(1);
  awake.setLive(3);
  assert.deepEqual(b.calls, ['start prevent-app-suspension'], 'one blocker, however the count moves');
  awake.setLive(0);
  assert.equal(awake.holding, false);
  assert.equal(b.active.size, 0, 'let go when the last session ends');
});

test('turning the setting off lets go at once, and on again holds again', () => {
  const b = fakeBlocker();
  const awake = new KeepAwake(b, true);
  awake.setLive(1);
  awake.setEnabled(false);
  assert.equal(b.active.size, 0);
  awake.setLive(4);
  assert.equal(b.active.size, 0, 'off means off, whatever is running');
  awake.setEnabled(true);
  assert.equal(b.active.size, 1);
  awake.release();
  assert.equal(b.active.size, 0);
});

test('settings default sensibly and ignore anything they do not know', () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings('nonsense'), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.keepAwake, true, 'keep awake is on by default');
  assert.deepEqual(patchSettings(DEFAULT_SETTINGS, { keepAwake: false, rogue: 1 }), { ...DEFAULT_SETTINGS, keepAwake: false });
  assert.deepEqual(patchSettings(DEFAULT_SETTINGS, { keepAwake: 'no' }), DEFAULT_SETTINGS, 'wrong types are ignored');
  assert.deepEqual(patchSettings(DEFAULT_SETTINGS, [false]), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.liveView, false, 'the live view is off until the owner switches it on');
  assert.equal(DEFAULT_SETTINGS.liveShots, false);
  assert.deepEqual(patchSettings(DEFAULT_SETTINGS, { liveView: true, liveShots: 'yes' }), { ...DEFAULT_SETTINGS, liveView: true });
  const on = { ...DEFAULT_SETTINGS, liveView: true };
  assert.equal(liveFor(DEFAULT_SETTINGS, 'drupal'), false, 'nothing is live while the live view is off');
  assert.equal(liveFor({ ...on, liveWordpress: false }, 'wordpress'), false, 'one kind of site switched off');
  assert.equal(liveFor({ ...on, liveWordpress: false }, 'drupal'), true);
  assert.equal(liveFor({ ...on, liveDrupal: false, liveWordpress: false, liveSites: false }, null), false, 'no kind on: no tab even before a site is chosen');
  assert.equal(DEFAULT_SETTINGS.notifications, 'all', 'notifications are on by default');
  assert.equal(patchSettings(DEFAULT_SETTINGS, { notifications: 'urgent' }).notifications, 'urgent');
  assert.equal(patchSettings(DEFAULT_SETTINGS, { notifications: 'loud' }).notifications, 'all', 'an unknown level is ignored');
});

test('the settings file survives a restart and is readable by its owner only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-settings-'));
  try {
    const file = join(dir, 'electron', 'settings.json');
    const store = new SettingsStore(file);
    assert.deepEqual(store.get(), DEFAULT_SETTINGS, 'no file yet: defaults');
    const heard: unknown[] = [];
    store.onChange((s) => heard.push(s));
    store.update({ keepAwake: false });
    store.update({ keepAwake: false });
    assert.equal(heard.length, 1, 'an unchanged value is not news');
    assert.equal(new SettingsStore(file).get().keepAwake, false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...DEFAULT_SETTINGS, keepAwake: false });
    writeFileSync(file, '{ not json');
    assert.deepEqual(new SettingsStore(file).get(), DEFAULT_SETTINGS, 'a damaged file is the defaults, not a crash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
