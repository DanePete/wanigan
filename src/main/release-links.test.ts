import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// The README's quick start and its setup guide (docs/guide/try-it.md) both say where to download and how to build.
const INSTALL = ['README.md', 'docs/guide/try-it.md'];

test('the README download and source clone select the packaged version', () => {
  const { version } = JSON.parse(read('package.json')) as { version: string };
  for (const file of INSTALL) {
    const text = read(file);
    const download = text.match(/\[Download the DMG or zip\]\(([^)]+)\)/)?.[1];
    assert.equal(download, `https://github.com/DanePete/wanigan/releases/tag/v${version}`, file);
    const clone = text.match(/^git clone --branch (\S+) https:\/\/github\.com\/DanePete\/wanigan\.git$/m)?.[1];
    assert.equal(clone, `v${version}`, `${file}: following it must build the same release as the download`);
    for (const [, tag] of text.matchAll(/github\.com\/DanePete\/wanigan\/releases\/tag\/([^\s)"'<>]+)/g)) {
      assert.equal(tag, `v${version}`, `${file}: every release link names the packaged version`);
    }
  }
  // The release badge says the same version (shields writes a dash in a badge's words as two).
  const badge = read('README.md').match(/img\.shields\.io\/badge\/release-(.+?)-[0-9A-Fa-f]{6}"/)?.[1];
  assert.equal(badge?.replaceAll('--', '-'), `v${version}`, 'the README’s release badge');
});


test('the README describes manual updates without inventing a platform restriction or zero-metadata request', () => {
  const updating = read('docs/guide/updating.md');
  for (const text of [read('README.md'), updating]) {
    assert.doesNotMatch(text, /sends nothing else|working with Apple|macOS lets an app replace itself only/i);
  }
  assert.match(updating, /connection metadata/);
  assert.match(updating, /automatic installation is not implemented/i);
});
