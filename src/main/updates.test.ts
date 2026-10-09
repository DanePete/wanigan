// The update check against a stand-in GitHub: what it sends, what it keeps,
// and when it asks by itself. No network and no Electron.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECK_EVERY_MS, RELEASES_API, type UpdateChecks } from '../shared/updates.ts';
import { UpdateChecker, type Fetch, type FetchReply } from './updates.ts';

const TAG = 'v2.0.0-alpha.3';
const LIST = [{
  tag_name: TAG,
  name: '2.0.0-alpha.3: updates',
  draft: false,
  prerelease: true,
  html_url: `https://github.com/DanePete/wanigan/releases/tag/${TAG}`,
  published_at: '2026-10-09T10:00:00Z',
  assets: [{ name: 'Wanigan-2-2.0.0-alpha.3-mac-arm64.dmg', browser_download_url: `https://github.com/DanePete/wanigan/releases/download/${TAG}/Wanigan-2-2.0.0-alpha.3-mac-arm64.dmg` }],
}];

function reply(status: number, body: string, headers: Record<string, string> = {}): FetchReply {
  return new Response(body, { status, headers });
}

function setup(answer: () => Promise<FetchReply>, { current = '2.0.0-alpha.2', checks = 'daily' as UpdateChecks } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-updates-'));
  const file = join(dir, 'updates.json');
  const asked: { url: string; headers: Record<string, string> }[] = [];
  let now = Date.UTC(2026, 9, 9, 12);
  let choice = checks;
  const fetch: Fetch = async (url, init) => { asked.push({ url, headers: init.headers }); return answer(); };
  const make = () => new UpdateChecker({ current, file, fetch, checks: () => choice, now: () => now });
  return {
    dir, file, asked, make,
    tick: (ms: number) => { now += ms; },
    choose: (c: UpdateChecks) => { choice = c; },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a check asks GitHub’s releases list, says only what is asking, and keeps what it found', async () => {
  const t = setup(async () => reply(200, JSON.stringify(LIST)));
  try {
    const checker = t.make();
    assert.deepEqual(checker.status, { state: 'never' });
    const found = await checker.check();
    assert.equal(found.state, 'available');
    assert.equal(found.state === 'available' && found.release.version, '2.0.0-alpha.3');
    assert.equal(t.asked.length, 1);
    assert.equal(t.asked[0]?.url, RELEASES_API);
    assert.deepEqual(t.asked[0]?.headers, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Wanigan-2-update-check',
    }, 'no version, no identifier: just what is asking');
    assert.equal(statSync(t.file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')), { ...found, checkedVersion: '2.0.0-alpha.2' });
    assert.deepEqual(t.make().status, found, 'the next launch remembers it without asking');
  } finally { t.done(); }
});

test('two checks at once are one request', async () => {
  let release!: () => void;
  const t = setup(() => new Promise((resolve) => { release = () => resolve(reply(200, '[]')); }));
  try {
    const checker = t.make();
    const a = checker.check();
    const b = checker.check();
    assert.equal(checker.status.state, 'checking');
    release();
    assert.deepEqual(await a, await b);
    assert.equal(t.asked.length, 1);
    assert.equal((await a).state, 'current');
  } finally { t.done(); }
});

test('every way GitHub can fail is a failure with its reason, never "up to date"', async () => {
  const cases: [string, () => Promise<FetchReply>, RegExp][] = [
    ['offline', async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); }, /^Could not reach GitHub: net::ERR_INTERNET_DISCONNECTED$/],
    ['timeout', async () => { throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); }, /did not answer in time/],
    ['rate limit', async () => reply(403, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 9, 9, 12, 30) / 1000) }), /try again in 30 minutes/],
    ['server error', async () => reply(502, 'Bad gateway'), /^GitHub answered 502\.$/],
    ['not JSON', async () => reply(200, '<html>'), /not readable/],
    ['not a list', async () => reply(200, '{"message":"Moved"}'), /list of releases/],
    ['too large by header', async () => reply(200, '[]', { 'content-length': String(3 * 1024 * 1024) }), /too large/],
    ['too large by body', async () => reply(200, `[${' '.repeat(3 * 1024 * 1024)}]`), /too large/],
  ];
  for (const [name, answer, want] of cases) {
    const t = setup(answer);
    try {
      const s = await t.make().check();
      assert.equal(s.state, 'failed', name);
      assert.match(s.state === 'failed' ? s.message : '', want, name);
    } finally { t.done(); }
  }
});

test('the daily check waits for a yes, then asks once a day, and sooner after a failure', async () => {
  let fail = false;
  const t = setup(async () => (fail ? reply(502, '') : reply(200, '[]')), { checks: 'ask' });
  try {
    const checker = t.make();
    assert.equal(checker.due(), false, 'not before the owner has answered');
    t.choose('off');
    assert.equal(checker.due(), false, 'not when they said no');
    t.choose('daily');
    assert.equal(checker.due(), true, 'yes, and never checked');
    await checker.check();
    assert.equal(checker.due(), false, 'just checked');
    t.tick(CHECK_EVERY_MS - 60_000);
    assert.equal(checker.due(), false);
    t.tick(60_000);
    assert.equal(checker.due(), true, 'a day later');
    fail = true;
    await checker.check();
    t.tick(30 * 60_000);
    assert.equal(checker.due(), false);
    t.tick(30 * 60_000);
    assert.equal(checker.due(), true, 'an hour after a failure, not a day');
  } finally { t.done(); }
});

test('a damaged results file is "never checked", not a crash', () => {
  const t = setup(async () => reply(200, '[]'));
  try {
    writeFileSync(t.file, '{"state":"available","checkedAt":');
    assert.deepEqual(t.make().status, { state: 'never' });
  } finally { t.done(); }
});

test('an oversized chunked release response is cancelled before the rest is buffered', async () => {
  let consumed = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      consumed++;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (consumed === 16) controller.close();
    },
    cancel() { cancelled = true; },
  }));
  const t = setup(async () => response);
  try {
    const status = await t.make().check();
    assert.equal(status.state, 'failed');
    assert.match(status.state === 'failed' ? status.message : '', /too large/);
    assert.ok(consumed <= 4, `${consumed} MiB consumed`);
    assert.equal(cancelled, true);
  } finally { t.done(); }
});

test('update checks read later pages before claiming there is no stable update', async () => {
  const beta = { ...LIST[0], tag_name: 'v3.0.0-beta.1', prerelease: true };
  const stable = { ...LIST[0], tag_name: 'v2.1.0', prerelease: false };
  const next = `${RELEASES_API}&page=2`;
  let requests = 0;
  const t = setup(async () => ++requests === 1
    ? reply(200, JSON.stringify(Array.from({ length: 20 }, () => beta)), { link: `<${next}>; rel="next"` })
    : reply(200, JSON.stringify([stable])), { current: '2.0.0' });
  try {
    const status = await t.make().check();
    assert.equal(status.state, 'available');
    assert.equal(status.state === 'available' && status.release.version, '2.1.0');
    assert.deepEqual(t.asked.map((r) => r.url), [RELEASES_API, next]);
  } finally { t.done(); }
});

test('an incomplete or untrusted release pagination chain is refused, never current', async () => {
  for (const next of ['https://evil.example/releases?page=2', `${RELEASES_API}&page=2`]) {
    const t = setup(async () => reply(200, '[]', { link: `<${next}>; rel="next"` }));
    try {
      const status = await t.make().check();
      assert.equal(status.state, 'failed');
      assert.ok(t.asked.length <= 10, 'pagination is bounded');
      assert.ok(t.asked.every((r) => new URL(r.url).origin === 'https://api.github.com'));
    } finally { t.done(); }
  }
});

test('valid pagination relation lists and unquoted next relations are followed', async () => {
  for (const rel of ['next', '"next last"', '"last next"']) {
    let requests = 0;
    const t = setup(async () => ++requests === 1
      ? reply(200, '[]', { link: `<${RELEASES_API}&page=2>; rel=${rel}` })
      : reply(200, JSON.stringify(LIST)));
    try {
      assert.equal((await t.make().check()).state, 'available', rel);
      assert.equal(requests, 2);
    } finally { t.done(); }
  }
});

test('a cached current result belongs to the installed version that was actually checked', async () => {
  const t = setup(async () => reply(200, '[]'), { current: '2.1.0', checks: 'off' });
  try {
    assert.equal((await t.make().check()).state, 'current');
    assert.equal(t.make().status.state, 'current', 'the same installation retains its result');
    const older = new UpdateChecker({ current: '2.0.0', file: t.file, checks: () => 'off', fetch: async () => reply(200, '[]') });
    assert.equal(older.status.state, 'never', 'a downgrade has never checked this installed version');
    writeFileSync(t.file, JSON.stringify({ state: 'current', checkedAt: Date.now() }));
    assert.equal(t.make().status.state, 'never', 'a legacy cache cannot identify which installation was checked');
  } finally { t.done(); }
});
