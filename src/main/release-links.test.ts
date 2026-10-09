import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the README download and source clone select the packaged version', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const download = readme.match(/\[Download the DMG or zip\]\(([^)]+)\)/)?.[1];
  assert.equal(download, `https://github.com/DanePete/wanigan/releases/tag/v${version}`);
  const clone = readme.match(/^git clone --branch (\S+) https:\/\/github\.com\/DanePete\/wanigan\.git$/m)?.[1];
  assert.equal(clone, `v${version}`, 'following Try it must build the same release as the download');
});


test('the README describes manual updates without inventing a platform restriction or zero-metadata request', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /sends nothing else|working with Apple|macOS lets an app replace itself only/i);
  assert.match(readme, /connection metadata/);
  assert.match(readme, /automatic installation is not implemented/i);
});
