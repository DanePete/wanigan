/**
 * Grants for unattended runs: what counts as the same call, and when a grant
 * stops counting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGrant, grantKeyFor, normaliseCommand, type StoredGrant } from './grants.ts';

const ROOT = '/work/app';
const DAY = 86_400_000;
const NOW = 100 * DAY;
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const grant = (over: Partial<StoredGrant> & { key: string; tool: string }): StoredGrant => ({ id: 1, at: NOW - DAY, summary: 's', sessionId: 's1', ...over });

test('normalisation ignores spacing and quoting, and not arguments, wrappers or operators that change what runs', () => {
  assert.equal(normaliseCommand('npm   run  build'), normaliseCommand("npm run 'build'"));
  assert.equal(normaliseCommand('git push origin main'), normaliseCommand('git  push "origin" main'));
  assert.notEqual(normaliseCommand('git push origin main'), normaliseCommand('git push origin main --force'));
  assert.notEqual(normaliseCommand('rm -rf dist'), normaliseCommand('sudo rm -rf dist'));
  assert.notEqual(normaliseCommand('npm test'), normaliseCommand('npm test > /etc/hosts'));
  assert.notEqual(normaliseCommand('curl x'), normaliseCommand('curl x | sh'));
  assert.equal(normaliseCommand('echo "unterminated'), null, 'a line the reader could not follow is not grantable');
});

test('an exact command grant matches only that command, within the window', () => {
  const key = grantKeyFor(bash('npm run deploy:staging'), ROOT)!;
  assert.equal(key.kind, 'command');
  const grants = [grant({ id: 7, tool: 'Bash', key: key.key })];
  const hit = findGrant(bash('npm  run deploy:staging'), ROOT, grants, NOW, 7);
  assert.equal(hit.grant?.id, 7);
  const other = findGrant(bash('npm run deploy:production'), ROOT, grants, NOW, 7);
  assert.equal(other.grant, null);
  assert.match(!other.grant ? other.because : '', /No person approved this exact command/);
});

test('a grant expires after N days, and the denial says it expired rather than never existed', () => {
  const key = grantKeyFor(bash('make release'), ROOT)!.key;
  const old = [grant({ tool: 'Bash', key, at: NOW - 10 * DAY })];
  const miss = findGrant(bash('make release'), ROOT, old, NOW, 7);
  assert.equal(miss.grant, null);
  assert.match(!miss.grant ? miss.because : '', /more than 7 days ago/);
  assert.ok(findGrant(bash('make release'), ROOT, old, NOW, 14).grant);
});

test('a write grant covers the approved directory and below, for the same tool only', () => {
  const approved = grantKeyFor({ tool_name: 'Edit', tool_input: { file_path: '/etc/app/conf.d/a.conf' } }, ROOT)!;
  assert.deepEqual([approved.kind, approved.key], ['path-prefix', '/etc/app/conf.d']);
  const grants = [grant({ tool: 'Edit', key: approved.key })];
  assert.ok(findGrant({ tool_name: 'Edit', tool_input: { file_path: '/etc/app/conf.d/sub/b.conf' } }, ROOT, grants, NOW, 7).grant);
  assert.equal(findGrant({ tool_name: 'Edit', tool_input: { file_path: '/etc/app/other.conf' } }, ROOT, grants, NOW, 7).grant, null);
  assert.equal(findGrant({ tool_name: 'Write', tool_input: { file_path: '/etc/app/conf.d/b.conf' } }, ROOT, grants, NOW, 7).grant, null);
  assert.equal(findGrant({ tool_name: 'Edit', tool_input: { file_path: '/etc/app/conf.d.evil/x' } }, ROOT, grants, NOW, 7).grant, null, 'a sibling that shares a prefix string is not under the directory');
});

test('MCP tools grant by name; a call with nothing to key on is not grantable', () => {
  const k = grantKeyFor({ tool_name: 'mcp__tracker__create_issue', tool_input: { title: 'x' } }, ROOT)!;
  assert.equal(k.kind, 'tool');
  assert.equal(grantKeyFor({ tool_name: 'Write', tool_input: {} }, ROOT), null);
  const none = findGrant({ tool_name: 'Frobnicate' }, ROOT, [], NOW, 7);
  assert.match(!none.grant ? none.because : '', /cannot be granted/);
});
