import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBundleName, lastLines, scrubForDiagnostics } from './diagnostics.ts';

const noRedact = (s: string) => s;

test('secret-named keys lose their values; booleans and empties keep theirs', () => {
  const scrubbed = scrubForDiagnostics({
    theme: 'dark', pushTopic: 'wanigan-abc123', mobile: { token: 'x', pushServer: 'https://ntfy.sh', webPushEnabled: true },
    apiKey: '', telemetry: true, nested: [{ authToken: 'y', label: 'Work' }],
  }, '/Users/dane', noRedact) as Record<string, unknown>;
  assert.equal(scrubbed.theme, 'dark');
  assert.equal(scrubbed.pushTopic, '[redacted]');
  assert.deepEqual(scrubbed.mobile, { token: '[redacted]', pushServer: 'https://ntfy.sh', webPushEnabled: true });
  assert.equal(scrubbed.apiKey, '');
  assert.equal(scrubbed.telemetry, true);
  assert.deepEqual(scrubbed.nested, [{ authToken: '[redacted]', label: 'Work' }]);
});

test('the home directory becomes ~ and strings pass through the credential redactor', () => {
  const out = scrubForDiagnostics({ dir: '/Users/dane/.codex', note: 'sk-abcdefghijkl' }, '/Users/dane',
    (s) => s.replace(/sk-[a-z]+/g, '[REDACTED CREDENTIAL]')) as Record<string, unknown>;
  assert.equal(out.dir, '~/.codex');
  assert.equal(out.note, '[REDACTED CREDENTIAL]');
});

test('last lines keep the tail and its newline; an empty log is empty', () => {
  assert.equal(lastLines('a\nb\nc\n', 2), 'b\nc\n');
  assert.equal(lastLines('a\nb', 5), 'a\nb\n');
  assert.equal(lastLines('', 5), '');
});

test('bundle names are Wanigan’s own, never a path', () => {
  assert.equal(isBundleName('table-counts.json'), true);
  assert.equal(isBundleName('../etc/passwd.txt'), false);
  assert.equal(isBundleName('main.log'), false);
  assert.equal(isBundleName('README.txt'), false);
});
