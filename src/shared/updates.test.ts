import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_EVERY_MS, checkDue, compareVersions, failureMessage, newestRelease, readStatus } from './updates.ts';

const PAGE = 'https://github.com/DanePete/wanigan/releases/tag/';
const DOWNLOAD = 'https://github.com/DanePete/wanigan/releases/download/';

/** A release as GitHub's API lists it, with what this check reads. */
function release(tag: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  const version = tag.replace(/^v/, '');
  return {
    tag_name: tag,
    name: `${version}: notes`,
    draft: false,
    prerelease: version.includes('-'),
    html_url: `${PAGE}${tag}`,
    published_at: '2026-10-07T21:37:45Z',
    assets: [
      { name: `Wanigan-2-${version}-mac-arm64.zip`, browser_download_url: `${DOWNLOAD}${tag}/Wanigan-2-${version}-mac-arm64.zip` },
      { name: `Wanigan-2-${version}-mac-arm64.dmg`, browser_download_url: `${DOWNLOAD}${tag}/Wanigan-2-${version}-mac-arm64.dmg` },
    ],
    ...more,
  };
}

test('versions are ordered as semantic versions, prereleases and all', () => {
  const ordered = ['2.0.0-alpha.1', '2.0.0-alpha.2', '2.0.0-alpha.10', '2.0.0-alpha.beta', '2.0.0-beta', '2.0.0-beta.2', '2.0.0-rc.1', '2.0.0', '2.0.1', '2.1.0', '10.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [a, b] = [ordered[i] as string, ordered[i + 1] as string];
    assert.ok(compareVersions(a, b) < 0, `${a} < ${b}`);
    assert.ok(compareVersions(b, a) > 0, `${b} > ${a}`);
  }
  assert.equal(compareVersions('v2.0.0-alpha.2', '2.0.0-alpha.2'), 0, 'a v prefix is the same version');
  assert.equal(compareVersions('2.0.0+build.7', '2.0.0'), 0, 'build metadata does not order');
  assert.ok(compareVersions('nonsense', '0.0.1') < 0, 'an unreadable version is never newer');
});

test('the newest release after this one is offered; nothing newer means up to date', () => {
  const list = [release('v2.0.0-alpha.2'), release('v2.0.0-alpha.10'), release('v2.0.0-alpha.3'), release('v2.0.0-alpha.0')];
  const found = newestRelease(list, '2.0.0-alpha.2');
  assert.equal(found?.version, '2.0.0-alpha.10', 'alpha.10 is after alpha.3, not before it');
  assert.equal(found?.page, `${PAGE}v2.0.0-alpha.10`);
  assert.equal(found?.dmg, `${DOWNLOAD}v2.0.0-alpha.10/Wanigan-2-2.0.0-alpha.10-mac-arm64.dmg`, 'the disk image, not the zip');
  assert.equal(found?.publishedAt, Date.parse('2026-10-07T21:37:45Z'));
  assert.equal(newestRelease(list, '2.0.0-alpha.10'), null);
  assert.equal(newestRelease([], '2.0.0-alpha.2'), null);
});

test('a prerelease is offered only to someone already running one', () => {
  const list = [release('v2.0.0'), release('v2.1.0-beta.1')];
  assert.equal(newestRelease(list, '2.0.0-alpha.2')?.version, '2.1.0-beta.1');
  assert.equal(newestRelease(list, '2.0.0'), null, 'on a release, a beta is not an update');
  assert.equal(newestRelease([release('v2.0.1', { prerelease: true })], '2.0.0'), null, 'GitHub’s own prerelease flag counts too');
});

test('drafts, unreadable tags and links off this repository are never offered', () => {
  const now = '2.0.0-alpha.2';
  assert.equal(newestRelease([release('v2.0.0-alpha.3', { draft: true })], now), null, 'a draft');
  assert.equal(newestRelease([release('latest')], now), null, 'not a version');
  assert.equal(newestRelease([release('v2.0.0-alpha.3', { html_url: 'https://evil.example/DanePete/wanigan/releases/tag/v2.0.0-alpha.3' })], now), null, 'another host');
  assert.equal(newestRelease([release('v2.0.0-alpha.3', { html_url: 'https://github.com/someone/wanigan-2/releases/tag/v2.0.0-alpha.3' })], now), null, 'another repository');
  assert.equal(newestRelease([release('v2.0.0-alpha.3', { html_url: 'http://github.com/DanePete/wanigan/releases/tag/v2.0.0-alpha.3' })], now), null, 'not https');
  assert.equal(newestRelease([release('v2.0.0-alpha.3', { html_url: 'https://user@github.com/DanePete/wanigan/releases/tag/v2.0.0-alpha.3' })], now), null, 'credentials in the link');
  const swapped = newestRelease([release('v2.0.0-alpha.3', { assets: [{ name: 'Wanigan-2-2.0.0-alpha.3-mac-arm64.dmg', browser_download_url: 'https://evil.example/w.dmg' }] })], now);
  assert.equal(swapped?.version, '2.0.0-alpha.3');
  assert.equal(swapped?.dmg, null, 'a disk image hosted elsewhere is dropped; the release page is still offered');
  assert.equal(newestRelease([null, 7, 'x', [], release('v2.0.0-alpha.3')], now)?.version, '2.0.0-alpha.3', 'junk entries are skipped');
});

test('an answer that is not a releases list is a failure, never "up to date"', () => {
  assert.throws(() => newestRelease({ message: 'Not Found' }, '2.0.0'), /list of releases/);
  assert.throws(() => newestRelease(null, '2.0.0'), /list of releases/);
});

test('a daily check is due after a day, or if the clock went back', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  assert.equal(checkDue(null, now), true, 'never checked');
  assert.equal(checkDue(now - CHECK_EVERY_MS + 60_000, now), false);
  assert.equal(checkDue(now - CHECK_EVERY_MS, now), true);
  assert.equal(checkDue(now + 60_000, now), true, 'a check "in the future" means the clock moved');
});

test('the kept result: damaged is never-checked, and an update since installed is forgotten', () => {
  const at = Date.UTC(2026, 9, 8);
  const found = newestRelease([release('v2.0.0-alpha.3')], '2.0.0-alpha.2');
  const kept = JSON.parse(JSON.stringify({ state: 'available', checkedAt: at, release: found }));
  assert.deepEqual(readStatus(kept, '2.0.0-alpha.2'), { state: 'available', checkedAt: at, release: found });
  assert.deepEqual(readStatus(kept, '2.0.0-alpha.3'), { state: 'current', checkedAt: at }, 'installed since');
  assert.deepEqual(readStatus({ ...kept, release: { ...kept.release, page: 'https://evil.example/' } }, '2.0.0-alpha.2'), { state: 'never' }, 'a tampered link is not offered or called current');
  assert.deepEqual(readStatus({ state: 'failed', checkedAt: at, message: 'GitHub answered 502.' }, '2.0.0'), { state: 'failed', checkedAt: at, message: 'GitHub answered 502.' });
  for (const junk of [null, 'x', [], {}, { state: 'current' }, { state: 'current', checkedAt: 'yesterday' }]) {
    assert.deepEqual(readStatus(junk, '2.0.0'), { state: 'never' }, JSON.stringify(junk));
  }
});

test('GitHub’s refusals are said in the owner’s words', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
  assert.equal(
    failureMessage(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), now),
    'GitHub limits how often it can be asked without an account; try again in 10 minutes.',
  );
  assert.equal(failureMessage(403, headers({}), now), 'GitHub answered 403.', 'a 403 that is not the rate limit is not called one');
  assert.match(failureMessage(404, headers({}), now), /no releases at github.com\/DanePete\/wanigan/);
  assert.equal(failureMessage(502, headers({}), now), 'GitHub answered 502.');
});

test('cached update advice obeys the installed release channel and corrupt cache never means current', () => {
  const checkedAt = Date.now();
  const beta = newestRelease([release('v3.0.0-beta.1')], '2.0.0-alpha.4');
  assert.deepEqual(readStatus({ state: 'available', checkedAt, release: beta }, '2.0.0'), { state: 'never' });
});

test('corrupt and interrupted update caches cannot claim the app is current', () => {
  const checkedAt = Date.now();
  const beta = newestRelease([release('v3.0.0-beta.1')], '2.0.0-alpha.4');
  for (const raw of [
    { state: 'garbage', checkedAt }, { state: 'checking', checkedAt },
    { state: 'available', checkedAt, release: null },
    { state: 'available', checkedAt, release: { ...beta, version: 'broken' } },
    { state: 'available', checkedAt, release: { ...beta, page: 'https://evil.example/' } },
  ]) assert.deepEqual(readStatus(raw, '2.0.0-alpha.4'), { state: 'never' });
});
