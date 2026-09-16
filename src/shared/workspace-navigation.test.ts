import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, SIDEBAR_GROUPS, TAB_SHORTCUTS } from './routes.ts';
import { SPACE_AREAS, areaDestination, rememberDestination, projectScopeFor } from './spaces.ts';
import { filterPalette } from './palette.ts';
import { sessionName } from './session-name.ts';

test('area switching returns to the selected destination without resetting the project view', () => {
  const memory = rememberDestination(rememberDestination({}, 'git'), 'usage');
  assert.equal(areaDestination('work', memory), 'git');
  assert.equal(areaDestination('fleet', memory), 'usage');
  assert.equal(areaDestination('automation', memory), 'runs');
  assert.equal(areaDestination('work', { work: 'usage' }), 'sessions');
  assert.equal(projectScopeFor('git'), 'required');
  assert.equal(projectScopeFor('sessions'), 'optional');
  assert.equal(projectScopeFor('fleet'), 'workspace');
});

test('the same area map reaches every route once and preserves established keyboard routes', () => {
  assert.deepEqual(SIDEBAR_GROUPS, SPACE_AREAS.map(area => ({ group: area.label, tabs: area.tabs })));
  const routes = SPACE_AREAS.flatMap(area => [...area.tabs]);
  assert.equal(new Set(routes).size, TABS.length);
  assert.equal(routes.length, TABS.length);
  assert.deepEqual(TABS.slice(0, 9).map(route => route.id), ['sessions', 'fleet', 'control', 'batches', 'insights', 'learning', 'plugins', 'schedules', 'git']);
  assert.equal(TAB_SHORTCUTS.git.label, '⌘9');
});

test('current destination labels and legacy names both resolve in command search', () => {
  const entries = TABS.map(item => ({ key: item.id, title: item.label, hint: `${item.group} · ${item.hint}`, meta: '', group: 'Views', haystack: `${item.label} ${item.group} ${item.keywords}` }));
  for (const [query, route] of [['Changes', 'git'], ['Git', 'git'], ['Home', 'mission'], ['Mission room', 'mission'], ['Automation', 'batches']]) {
    assert.ok(filterPalette(entries, query).some(item => item.key === route), `${query} finds ${route}`);
  }
});

test('session names consistently prefer user-visible identity and omit absent values', () => {
  assert.equal(sessionName({ displayTitle: ' AuroraQuantumFox ', title: 'Old prompt', projectName: 'Pine' }), 'AuroraQuantumFox');
  assert.equal(sessionName({ displayTitle: ' ', title: 'Old prompt', projectName: 'Pine' }), 'Old prompt');
  assert.equal(sessionName({ title: null, projectName: 'Pine' }), 'Pine');
  assert.equal(sessionName({}, 'Archived session'), 'Archived session');
  assert.equal(sessionName({}), 'Untitled session');
});
