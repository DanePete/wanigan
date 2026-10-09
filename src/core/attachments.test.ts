// Attachments and Remote Control against stand-ins: agents that record the
// exact bytes typed into them, and a `claude -p` that records what it was sent.
// No real CLI is run and nothing is spent.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES } from '../shared/attachments.ts';
import type { Provider } from '../shared/model.ts';
import { savedConversation, testCore, waitFor, type TestCore } from './test-support.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really pixels')]);
const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64');
const PASTE = (s: string): string => `\x1b[200~${s}\x1b[201~`;

/**
 * How the stand-in agents behave, chosen before each start:
 * - `args`: print the token and each argument, then wait;
 * - `raw`: keep every byte typed in (raw mode) in the file named by $1;
 * - `gated`: as `raw`, and show image markers only when the test releases
 *   each phase, so processing speed cannot masquerade as the image timeout.
 */
let mode: 'args' | 'raw' | 'gated' = 'args';
const RAW = ['out="$1"', ': > "$out"', 'stty raw -echo', "printf 'ready\\r\\n'"].join('\n');
/** Duplicate first-image marks must not count as two images. */
const SHOW_GATED = `( while [ ! -e "$out.first" ]; do sleep 0.01; done; printf '[Image #1] [Image #1] '; while [ ! -e "$out.second" ]; do sleep 0.01; done; printf '[Image #1] [Image #2] ' ) &`;
function standIn(provider: Provider): { file: string; args: string[] } {
  if (provider === 'shell') return { file: '/bin/sh', args: ['-i'] };
  if (mode === 'args') return { file: '/bin/sh', args: ['-c', `echo "TOKEN=$WANIGAN_TOKEN"; printf 'ARG<%s>' "$@"; echo; exec cat`, 'agent'] };
  const out = rawFile;
  const later = mode === 'gated' ? `${SHOW_GATED}\n` : '';
  return { file: '/bin/sh', args: ['-c', `${RAW}\n${later}exec cat >> "$out"`, 'agent', out] };
}
let rawFile = '';

/** A `claude -p` that keeps its arguments and stdin, and answers as stream-json does: messages, then the result. */
function fakeChat(dir: string): string {
  const file = join(dir, 'fake-claude-chat.sh');
  writeFileSync(file, [
    '#!/bin/sh',
    `printf '%s\\0' "$@" > "${dir}/chat.args"`,
    `cat > "${dir}/chat.stdin"`,
    `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"The banner shows under $75.","session_id":"sess-1","total_cost_usd":0.02}'`,
  ].join('\n'), { mode: 0o755 });
  return file;
}

describe('attachments and Remote Control', () => {
  let t: TestCore;
  let fakes: string;
  let projectId: string;
  const start = async (provider: Provider, extra: Record<string, unknown> = {}) =>
    t.owner.call('sessions.start', { projectId, provider, ...extra });
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message: string }) => e);

  before(async () => {
    fakes = realpathSync(mkdtempSync(join(tmpdir(), 'wg-attach-')));
    t = await testCore({ launcher: standIn, imageWaitMs: 2_500, claudeBinary: fakeChat(fakes) });
    projectId = (await t.owner.call('projects.add', { path: t.projectDir, name: 'Site' })).id;
  });
  after(async () => {
    await t?.close();
    if (fakes) rmSync(fakes, { recursive: true, force: true });
  });

  test('a file is kept 0600 under Wanigan’s data folder, never in the project, and bad input is refused', async () => {
    mode = 'args';
    const session = await start('claude');
    const to = { session: session.id };
    const saved = await t.owner.call('attachments.save', { to, name: '../Screen Shot 1.png', data: b64(PNG) });
    assert.equal(saved.kind, 'image');
    assert.equal(saved.name, 'Screen Shot 1.png');
    assert.equal(saved.path, join(t.core.attachments.root, session.id, '1-Screen-Shot-1.png'));
    assert.ok(!saved.path.startsWith(t.projectDir), 'not in the project');
    assert.equal(statSync(saved.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(saved.path)).mode & 0o777, 0o700);
    assert.equal(statSync(t.core.attachments.root).mode & 0o777, 0o700);
    assert.deepEqual(readFileSync(saved.path), PNG);
    const text = await t.owner.call('attachments.save', { to, name: 'notes.png', data: b64('It is text, whatever its name says.\n') });
    assert.equal(text.kind, 'text');
    assert.match(text.path, /\/2-notes\.png\.txt$/, 'text is never named like an image');
    assert.deepEqual((await t.owner.call('attachments.list', { to })).map((a) => a.id), [saved.id, text.id]);

    const refused = async (params: Record<string, unknown>, pattern: RegExp) => {
      const e = await refusal(t.owner.call('attachments.save', { to, name: 'x', data: '', ...params } as never));
      assert.ok(e, `refused: ${pattern}`);
      assert.match(e.message, pattern);
    };
    await refused({ data: 'not base64!' }, /did not arrive whole/);
    await refused({ data: '' }, /is empty/);
    await refused({ data: 'A'.repeat(Math.ceil((ATTACH_MAX_BYTES + 3) / 3) * 4) }, /at most 20 MB/);
    await refused({ name: 'tool', data: b64(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1])) }, /only PNG, JPEG, GIF and WebP images, PDFs and text files/);
    await refused({ to: { session: 'nope' }, data: b64(PNG) }, /No such session/);
    await refused({ to: { somewhere: 1 }, data: b64(PNG) }, /session or to Talk to Wanigan/);
    const shell = await start('shell');
    await refused({ to: { session: shell.id }, data: b64(PNG) }, /shell takes no attachments/);
    await t.owner.call('sessions.stop', { id: shell.id });

    for (let i = 2; i < ATTACH_MAX_FILES; i++) await t.owner.call('attachments.save', { to, name: `n${i}.txt`, data: b64(`${i}\n`) });
    await refused({ data: b64('one too many\n') }, /10 files at most/);

    // Taken out of the composer, a file is gone from disk too.
    await t.owner.call('attachments.remove', { id: text.id });
    assert.equal(existsSync(text.path), false);
    assert.equal((await t.owner.call('attachments.preview', { id: saved.id })).dataUrl, `data:image/png;base64,${b64(PNG)}`);

    // A session that ends can send nothing more: what waited is deleted.
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: session.id })).session.state === 'ended');
    assert.equal(existsSync(saved.path), false);
    assert.deepEqual(await t.owner.call('attachments.list', { to }), []);
    assert.match((await refusal(t.owner.call('attachments.save', { to, name: 'late.png', data: b64(PNG) })))?.message ?? '', /has ended/);
  });

  test('a session’s own token cannot attach, list or read files', async () => {
    mode = 'args';
    const session = await start('claude');
    const token = await waitFor('token', () => t.core.sessions.replay(session.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    const agent = await CoreClient.connect(t.core.paths.socket, token);
    try {
      for (const [method, params] of [
        ['attachments.save', { to: { session: session.id }, name: 'a.png', data: b64(PNG) }],
        ['attachments.list', { to: { session: session.id } }],
        ['attachments.preview', { id: 'x' }],
        ['attachments.remove', { id: 'x' }],
      ] as const) {
        const e = await refusal(agent.call(method, params as never));
        assert.equal(e?.code, 'forbidden', method);
      }
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: session.id });
    }
  });

  test('Claude Code is typed its images first, waits to see them, then the message and the other files', async () => {
    mode = 'gated';
    rawFile = join(fakes, 'typed-claude.raw');
    const local = await testCore({ launcher: standIn, imageWaitMs: 30_000 });
    try {
      const project = await local.owner.call('projects.add', { path: local.projectDir });
      const session = await local.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
      await waitFor('ready', () => local.core.sessions.replay(session.id).replay.includes('ready'));
      local.core.sessions.hook(session.id, 'SessionStart', {});
      const to = { session: session.id };
      const shot = await local.owner.call('attachments.save', { to, name: 'shot.png', data: b64(PNG) });
      const notes = await local.owner.call('attachments.save', { to, name: 'notes.md', data: b64('# Notes\n') });
      const second = await local.owner.call('attachments.save', { to, name: 'second.png', data: b64(PNG) });
      await local.owner.call('sessions.queue', { id: session.id, text: 'Why is the banner\nmissing here?', attachments: [shot.id, notes.id, second.id] });
      assert.deepEqual(await local.owner.call('attachments.list', { to }), [], 'they left the composer with the message');
      const images = PASTE(`${shot.path}\n${second.path}`);
      await waitFor('image paths', () => readFileSync(rawFile, 'latin1').length >= images.length);
      assert.equal(readFileSync(rawFile, 'latin1'), images, 'no message before either image is shown');
      writeFileSync(`${rawFile}.first`, '');
      await waitFor('first image shown twice', () => local.core.sessions.replay(session.id).replay.includes('[Image #1] [Image #1]'));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(readFileSync(rawFile, 'latin1'), images, 'one distinct image is still not enough');
      writeFileSync(`${rawFile}.second`, '');
      const all = images + PASTE(`Why is the banner\nmissing here?\n\nAttached file: ${notes.path}`) + '\r';
      await waitFor('the message after the second image, before the 30-second fallback', () => readFileSync(rawFile, 'utf8') === all, 5_000);
      await local.owner.call('sessions.stop', { id: session.id });
      assert.ok(existsSync(shot.path), 'a file that was sent stays with its message');
    } finally {
      writeFileSync(`${rawFile}.first`, '');
      writeFileSync(`${rawFile}.second`, '');
      await local.close();
    }
  });

  test('when Claude Code never shows the images, the message still goes, with their paths as text', async () => {
    mode = 'raw';
    rawFile = join(fakes, 'typed-claude-unseen.raw');
    const session = await start('claude');
    await waitFor('ready', () => t.core.sessions.replay(session.id).replay.includes('ready'));
    t.core.sessions.hook(session.id, 'SessionStart', {}); // at its prompt, as Claude reports it
    const shot =await t.owner.call('attachments.save', { to: { session: session.id }, name: 'shot.png', data: b64(PNG) });
    const sent = Date.now();
    await t.owner.call('sessions.queue', { id: session.id, text: 'Here', attachments: [shot.id] });
    await waitFor('the message', () => readFileSync(rawFile, 'utf8') === `${PASTE(shot.path)}${PASTE('Here')}\r`);
    assert.ok(Date.now() - sent >= 2_400, 'after the wait ran out');
    await t.owner.call('sessions.stop', { id: session.id });
  });

  test('Codex is pasted each image as one quoted path, then the message', async () => {
    mode = 'raw';
    rawFile = join(fakes, 'typed-codex.raw');
    const session = await start('codex');
    await waitFor('ready', () => t.core.sessions.replay(session.id).replay.includes('ready'));
    t.core.sessions.hook(session.id, 'Stop', {}); // a turn ended; startup questions are past
    const to = { session: session.id };
    const a = await t.owner.call('attachments.save', { to, name: 'a.png', data: b64(PNG) });
    const b = await t.owner.call('attachments.save', { to, name: 'b.jpg', data: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])) });
    const pdf = await t.owner.call('attachments.save', { to, name: 'spec.pdf', data: b64('%PDF-1.4\n%fake\n') });
    assert.equal(pdf.kind, 'pdf');
    await t.owner.call('sessions.queue', { id: session.id, text: 'Match these', attachments: [a.id, b.id, pdf.id] });
    const all = PASTE(`'${a.path}'`) + PASTE(`'${b.path}'`) + PASTE(`Match these\n\nAttached file: ${pdf.path}`) + '\r';
    await waitFor('the message', () => readFileSync(rawFile, 'utf8') === all);
    // A file that went with a message stays with it.
    assert.match((await refusal(t.owner.call('attachments.remove', { id: a.id })))?.message ?? '', /stays with it/);
    await t.owner.call('sessions.stop', { id: session.id });
  });

  test('a message can name only files that wait in its own composer', async () => {
    mode = 'args';
    const one = await start('claude');
    const two = await start('claude');
    const theirs = await t.owner.call('attachments.save', { to: { session: two.id }, name: 'x.png', data: b64(PNG) });
    const e = await refusal(t.owner.call('sessions.queue', { id: one.id, text: 'hi', attachments: [theirs.id] }));
    assert.match(e?.message ?? '', /no longer waiting/);
    assert.equal(t.core.sessions.pendingCount(one.id), 0, 'and the message was not queued either');
    assert.equal((await t.owner.call('attachments.list', { to: { session: two.id } })).length, 1);
    await t.owner.call('sessions.stop', { id: one.id });
    await t.owner.call('sessions.stop', { id: two.id });
  });

  test('Remote Control is passed, named after the session, only when the owner turns it on', async () => {
    mode = 'args';
    const argsOf = (id: string) => waitFor('args', () => t.core.sessions.replay(id).replay.match(/ARG<[\s\S]*>\r?\n/)?.[0]);
    const on = await start('claude', { remote: true, title: 'Checkout lead' });
    assert.equal(on.remote, true);
    assert.match(await argsOf(on.id), /ARG<--remote-control>ARG<Checkout lead>/);
    const off = await start('claude', { title: 'Quiet one' });
    assert.equal(off.remote, false);
    assert.doesNotMatch(await argsOf(off.id), /remote-control/);
    const dashed = await start('claude', { remote: true, title: '--model evil' });
    assert.match(await argsOf(dashed.id), /ARG<--remote-control>ARG<model evil>/, 'a title is never read as a flag');

    for (const provider of ['codex', 'shell'] as const) {
      const e = await refusal(start(provider, { remote: true }));
      assert.equal(e?.code, 'refused');
      assert.match(e?.message ?? '', /Remote Control is a Claude Code feature/);
    }
    assert.equal((await refusal(start('claude', { remote: 'yes' })))?.code, 'invalid');

    // Resuming carries the owner's choice on, and only theirs.
    for (const s of [on, off, dashed]) await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: off.id })).session.state === 'ended'
      && (await t.owner.call('sessions.get', { id: on.id })).session.state === 'ended');
    for (const s of [on, off]) savedConversation(join(t.dir, 'home'), s);
    const again = await t.owner.call('sessions.resume', { id: on.id });
    assert.equal(again.remote, true);
    assert.match(await argsOf(again.id), /ARG<--remote-control>ARG<Checkout lead>/);
    const quiet = await t.owner.call('sessions.resume', { id: off.id });
    assert.equal(quiet.remote, false);
    assert.doesNotMatch(await argsOf(quiet.id), /remote-control/);
    for (const s of [again, quiet, dashed]) await t.owner.call('sessions.stop', { id: s.id }).catch(() => {});
  });

  test('Talk to Wanigan sends its files inside one stream-json message', async () => {
    const to = { chat: projectId };
    const shot = await t.owner.call('attachments.save', { to, name: 'banner.png', data: b64(PNG) });
    const log = await t.owner.call('attachments.save', { to, name: 'totals.log', data: b64('74.99 shown\n75.00 hidden\n') });
    const big = await refusal(t.owner.call('attachments.save', { to, name: 'big.txt', data: b64('x'.repeat(210 * 1024)) }));
    assert.match(big?.message ?? '', /at most 200 KB/);
    await t.owner.call('chat.send', { projectId, text: 'Is this right?', attachments: [shot.id, log.id] });
    const thread = await waitFor('answer', async () => {
      const th = await t.owner.call('chat.list', { projectId });
      return th.turns.at(-1)?.state === 'done' ? th : null;
    });
    const turn = thread.turns.at(-1)!;
    assert.equal(turn.answer, 'The banner shows under $75.');
    assert.deepEqual(turn.attachments.map((a) => a.name), ['banner.png', 'totals.log']);
    assert.deepEqual(await t.owner.call('attachments.list', { to }), []);

    const args = readFileSync(join(fakes, 'chat.args'), 'utf8').split('\0').slice(0, -1);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag('--input-format'), 'stream-json');
    assert.equal(flag('--output-format'), 'stream-json');
    assert.ok(args.includes('--verbose'), 'stream-json output needs --verbose with -p');
    assert.ok(!args.includes('--add-dir'), 'no folder is opened to Claude for them');
    const stdin = readFileSync(join(fakes, 'chat.stdin'), 'utf8');
    assert.equal(stdin.split('\n').length, 2, 'one line, newline-terminated');
    const message = JSON.parse(stdin) as { type: string; message: { role: string; content: Record<string, unknown>[] } };
    assert.equal(message.type, 'user');
    assert.equal(message.message.role, 'user');
    const [image, text, words] = message.message.content;
    assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(PNG) } });
    assert.deepEqual(text, { type: 'text', text: 'The owner attached totals.log:\n\n74.99 shown\n75.00 hidden\n' });
    assert.match(String(words?.text), /The owner attached banner\.png, totals\.log to this message\.\n\nThe owner asks:\nIs this right\?$/);
    assert.match(String(words?.text), /^<wanigan-state>/);
  });
});
