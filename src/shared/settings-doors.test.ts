/**
 * A refusal that names a Settings section gets a link to that section, and the
 * words main prints are the words the link is found by.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_DOORS, settingsBreadcrumb, settingsDoorIn } from './settings-doors.ts';

test('the session-limit breadcrumb names the tab the Dispatcher section is really on', () => {
  assert.equal(settingsBreadcrumb('Dispatcher'), 'Settings › Automation › Dispatcher');
  const door = settingsDoorIn(`4 of 4 interactive sessions are already running. Stop one, or raise the limit in ${settingsBreadcrumb('Dispatcher')}.`);
  assert.deepEqual(door && { tab: door.tab, section: door.section }, { tab: 'automation', section: 'Dispatcher' });
});

test('the most specific breadcrumb wins, and a message with none has no door', () => {
  assert.equal(settingsDoorIn(`Add that directory under ${settingsBreadcrumb('Accounts')}.`)?.section, 'Accounts');
  assert.equal(settingsDoorIn('Add the key under Settings › Agents, then start again.')?.tab, 'agents');
  assert.equal(settingsDoorIn('Add the key under Settings › Agents, then start again.')?.section, undefined);
  assert.equal(settingsDoorIn('The session exited with code 1.'), null);
  assert.equal(settingsDoorIn(''), null);
  assert.equal(settingsDoorIn(null), null);
});

test('every door is a distinct breadcrumb that starts at Settings', () => {
  assert.equal(new Set(SETTINGS_DOORS.map((door) => door.breadcrumb)).size, SETTINGS_DOORS.length);
  for (const door of SETTINGS_DOORS) assert.match(door.breadcrumb, /^Settings › /);
});
