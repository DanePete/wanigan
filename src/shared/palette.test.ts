import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPalette, groupPalette, type PaletteEntry } from './palette.ts';

const row = (key: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({
  key, title: key, hint: '', meta: '', haystack: '', group: 'Views', ...extra,
});
const keys = (rows: PaletteEntry[]) => rows.map((item) => item.key);

test('search finds all words in any order across title, description, and aliases', () => {
  const items = [
    row('restore', { title: 'Restore a backup', hint: 'Put a saved copy back in place', haystack: 'recovery' }),
    row('create', { title: 'Create a backup', hint: 'Write a verified copy', haystack: 'export' }),
  ];
  assert.deepEqual(keys(filterPalette(items, 'backup restore')), ['restore']);
  assert.deepEqual(keys(filterPalette(items, 'RECOVERY \t saved\n BACKUP')), ['restore']);
  assert.deepEqual(keys(filterPalette(items, 'backup missing')), [], 'every word is required');
});

test('exact and prefix title matches rank before reordered title words and description matches', () => {
  const items = [
    row('description', { title: 'Accounts', hint: 'Provider usage details' }),
    row('reordered', { title: 'Details for provider usage' }),
    row('prefix', { title: 'Usage details by account' }),
    row('exact', { title: 'Usage details' }),
    row('unrelated', { title: 'Skills' }),
  ];
  assert.deepEqual(keys(filterPalette(items, 'usage details')), ['exact', 'prefix', 'reordered', 'description']);
});

test('title ranking normalizes case and whitespace in both the row and query', () => {
  const items = [
    row('prefix', { title: 'Session history search' }),
    row('exact', { title: '  SESSION\t history  ' }),
  ];
  assert.deepEqual(keys(filterPalette(items, ' \n session   HISTORY\t')), ['exact', 'prefix']);
});

test('equally relevant entries retain their original order and identity without mutating input', () => {
  const items = [
    row('second-alphabetically', { title: 'Work', hint: 'Inspect project changes' }),
    row('first-alphabetically', { title: 'Review', haystack: 'project changes' }),
    row('title', { title: 'Changes' }),
  ];
  const before = [...items];
  const result = filterPalette(items, 'changes');
  assert.deepEqual(keys(result), ['title', 'second-alphabetically', 'first-alphabetically']);
  assert.deepEqual(items, before);
  assert.equal(result[0], items[2]);
  assert.equal(result[1], items[0]);
});

test('archive matches survive local matching and keep the index order after local destinations', () => {
  const items = [
    row('hit-second-alphabetically', { title: 'A conversation', hint: 'A stemmed match', group: 'Transcripts', prefiltered: true }),
    row('local', { title: 'Restore a backup' }),
    row('hit-first-alphabetically', { title: 'backup restore', hint: 'Different index score', group: 'Transcripts', prefiltered: true }),
  ];
  assert.deepEqual(keys(filterPalette(items, 'backup restore')), ['local', 'hit-second-alphabetically', 'hit-first-alphabetically']);
  assert.deepEqual(keys(filterPalette(items, 'words no snippet contains')), ['hit-second-alphabetically', 'hit-first-alphabetically']);
});

test('empty queries omit detailed settings and archive answers while retaining ordinary menu order', () => {
  const items = [
    row('start', { group: 'Actions', primary: true }),
    row('privacy', { group: 'Settings', searchOnly: true }),
    row('sessions'),
    row('transcript', { group: 'Transcripts', prefiltered: true }),
  ];
  assert.deepEqual(keys(filterPalette(items, ' \n\t')), ['start', 'sessions']);
  assert.deepEqual(keys(filterPalette(items, 'privacy')), ['privacy', 'transcript']);
});

test('a settings item explicitly recalled through Recent can remain visible before search', () => {
  const setting = row('backup', { title: 'Restore a backup', group: 'Settings', searchOnly: true });
  const recent = { ...setting, key: 'recent:backup', group: 'Recent', searchOnly: false };
  assert.deepEqual(keys(filterPalette([recent, setting], '')), ['recent:backup']);
  assert.deepEqual(keys(filterPalette([recent, setting], 'restore')), ['recent:backup', 'backup']);
});

test('group headings follow the strongest matching result and retain ranked members', () => {
  const items = [
    row('view', { title: 'Settings', hint: 'Search account preferences', group: 'Manage' }),
    row('account-prefix', { title: 'Accounts and runtimes', group: 'Settings' }),
    row('account-exact', { title: 'Accounts', group: 'Settings' }),
  ];
  const grouped = groupPalette(filterPalette(items, 'accounts'));
  assert.deepEqual(grouped.map((group) => ({ label: group.label, keys: keys(group.items) })), [
    { label: 'Settings', keys: ['account-exact', 'account-prefix'] },
  ]);
  const acrossGroups = groupPalette(filterPalette(items, 'account'));
  assert.deepEqual(acrossGroups.map((group) => group.label), ['Settings', 'Manage']);
});
