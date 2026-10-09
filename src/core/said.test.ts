// Searching what agents said: real stand-in sessions print known text, with
// colour and cursor codes, into the core's real scrollback files.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { Provider } from '../shared/model.ts';
import { ACCESS } from '../shared/protocol.ts';
import { SAID_CAPS } from '../shared/said.ts';
import { searchSaid } from './said.ts';
import { launcher, testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

/** What each stand-in shell prints, in the order they start; then it waits. */
const SAYS = [
  // Coloured, with a cursor move between two words and a window title.
  "printf '\\033]0;deploy\\007\\033[1;31mDeploy\\033[0m\\033[1Cfinished: \\033[32mall green\\033[0m\\r\\n'",
  "printf 'the needle is here\\r\\n'",
  "printf 'another needle, said twice\\r\\nanother needle, said twice\\r\\n'",
  // Old words, a long middle, new words: only the newest bytes are read.
  "printf 'OLD-MARKER\\r\\n'; i=0; while [ $i -lt 120 ]; do printf 'filler line %s ....................................\\r\\n' $i; i=$((i+1)); done; printf 'NEW-MARKER\\r\\n'",
  "printf 'a secret typed here: KEY-0042\\r\\n'",
];

describe('what agents said', () => {
  let t: TestCore;
  let projectId: string;
  const ids: string[] = [];
  let next = 0;

  before(async () => {
    t = await testCore({
      launcher: (provider: Provider) => (provider === 'shell'
        ? { file: '/bin/sh', args: ['-c', `${SAYS[next++ % SAYS.length]}; exec cat`] }
        : launcher(provider)),
    });
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    const titles = ['Deploy check', 'Haystack', 'Echoes', 'Long run'];
    for (const title of titles) {
      const s = await t.owner.call('sessions.start', { projectId, provider: 'shell', title });
      ids.push(s.id);
    }
    // A terminal a key may be typed into, as the MCP page opens: never searched.
    ids.push((await t.core.sessions.start({ projectId, provider: 'shell', title: 'Key entry', ephemeral: true })).id);
    for (const [i, word] of ['all green', 'needle is here', 'said twice', 'NEW-MARKER', 'KEY-0042'].entries()) {
      await waitFor(word, () => t.core.sessions.replay(ids[i] as string).replay.includes(word));
    }
  });
  after(async () => { await t.close(); });

  test('finds words in what a session printed, in any case, with its escape codes gone', async () => {
    const found = await t.owner.call('sessions.search', { query: 'DEPLOY FINISHED' });
    const hit = found.hits.find((h) => h.in === 'output');
    assert.ok(hit, JSON.stringify(found));
    assert.equal(hit.sessionId, ids[0]);
    assert.equal(hit.sessionTitle, 'Deploy check');
    assert.equal(hit.projectId, projectId);
    assert.equal(hit.snippet.match, 'Deploy finished');
    assert.equal(`${hit.snippet.before}${hit.snippet.match}${hit.snippet.after}`.trim(), 'Deploy finished: all green');
    assert.ok(!/\x1b|\[1;31m|\[0m/.test(JSON.stringify(hit.snippet)), 'no escape codes reach the snippet');
    assert.equal(hit.endedAt, null, 'still live');
    assert.ok(hit.lastOutputAt && hit.lastOutputAt >= hit.startedAt - 1000);
    assert.deepEqual(found.cut, []);
  });

  test('a session’s title is searched too, and a line drawn twice is found once', async () => {
    const title = await t.owner.call('sessions.search', { query: 'haystack' });
    assert.deepEqual(title.hits.map((h) => [h.in, h.sessionId, h.snippet.match]), [['title', ids[1], 'Haystack']]);
    const twice = await t.owner.call('sessions.search', { query: 'said twice' });
    assert.equal(twice.hits.filter((h) => h.sessionId === ids[2]).length, 1);
  });

  test('a match limit is kept, and saying so', async () => {
    const all = await t.owner.call('sessions.search', { query: 'needle' });
    assert.equal(all.hits.length, 2);
    const one = await t.owner.call('sessions.search', { query: 'needle', limit: 1 });
    assert.equal(one.hits.length, 1);
    assert.deepEqual(one.cut, ['results']);
  });

  test('only the newest bytes of a long output are read, and the search says so', async () => {
    const ctx = { db: t.core.db, now: Date.now, emit: t.core.bus.emit };
    const files = (id: string) => t.core.sessions.outputFile(id);
    const small = { ...SAID_CAPS, bytesPerFile: 1024 };
    const recent = await searchSaid(ctx, { query: 'new-marker' }, files, small);
    assert.equal(recent.hits[0]?.sessionId, ids[3]);
    assert.ok(recent.cut.includes('bytes'));
    const old = await searchSaid(ctx, { query: 'old-marker' }, files, small);
    assert.deepEqual(old.hits, [], 'the old words were beyond what was read');
    assert.ok(old.cut.includes('bytes'));
    // With room to read it all, the old words are there.
    assert.equal((await searchSaid(ctx, { query: 'old-marker' }, files)).hits[0]?.sessionId, ids[3]);
    // A budget across sessions stops reading when it is spent.
    const spent = await searchSaid(ctx, { query: 'needle' }, files, { ...SAID_CAPS, totalBytes: 10 });
    assert.ok(spent.cut.includes('bytes'));
  });

  test('time and session bounds stop the search and say so', async () => {
    const ctx = { db: t.core.db, now: Date.now, emit: t.core.bus.emit };
    const files = (id: string) => t.core.sessions.outputFile(id);
    let now = 0;
    const slow = await searchSaid(ctx, { query: 'needle' }, files, { ...SAID_CAPS, timeMs: 50 }, () => (now += 40));
    assert.equal(slow.searched, 1, 'one session read before time ran out');
    assert.deepEqual(slow.cut, ['time']);
    const few = await searchSaid(ctx, { query: 'needle' }, files, { ...SAID_CAPS, sessions: 2 });
    assert.equal(few.searched, 2);
    assert.ok(few.cut.includes('sessions'));
  });

  test('a terminal a key may have been typed into is not read', async () => {
    assert.equal(t.core.sessions.outputFile(ids[4] as string), null);
    assert.deepEqual((await t.owner.call('sessions.search', { query: 'KEY-0042' })).hits, []);
    assert.equal((await t.owner.call('sessions.search', { query: 'key entry' })).hits[0]?.in, 'title', 'its title is not secret');
  });

  test('a short query is refused rather than matching everything', async () => {
    await assert.rejects(t.owner.call('sessions.search', { query: 'ab' }), /at least 3 characters/);
    await assert.rejects(t.owner.call('sessions.search', { query: '   ' }), /at least 3 characters/);
    await assert.rejects(t.owner.call('sessions.search', { query: 'x'.repeat(201) }), /at most 200/);
  });

  test('only the owner can search what agents said', async () => {
    assert.deepEqual(ACCESS['sessions.search'], ['owner']);
    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    try {
      await assert.rejects(agent.call('sessions.search', { query: 'needle' }), /not available to a session/);
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: s.id });
    }
  });
});
