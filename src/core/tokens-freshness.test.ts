import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Tokens } from './tokens.ts';

const THREAD = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const line = (value: object): string => JSON.stringify(value) + '\n';
const total = (input: number): string => line({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, total_tokens: input + 10 },
  last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, total_tokens: 11 }, model_context_window: 1000,
} } });
const content = (input: number): string => line({ type: 'session_meta', payload: { id: THREAD } }) + total(input);

function fixture(context: TestContext, bytes = content(100)) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-token-freshness-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'codex');
  const path = join(home, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-00-00-${THREAD}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const accounts = { folder: () => home, list: () => [] } as never;
  const session = { provider: 'codex', conversationId: THREAD, transcriptPath: path, accountId: null } as never;
  const tokens = new Tokens(accounts);
  return { path, tokens, session, read: () => tokens.ofSession(session), fresh: () => new Tokens(accounts).ofSession(session) };
}

test('cached tokens reread a same-size atomic rollout replacement', async (context) => {
  const t = fixture(context);
  assert.equal((await t.read()).usage?.input, 100);
  const before = statSync(t.path), next = t.path + '.replacement';
  writeFileSync(next, content(250), { flag: 'wx', mode: 0o600 });
  renameSync(next, t.path);
  const after = statSync(t.path);
  assert.equal(after.size, before.size); assert.notEqual(after.ino, before.ino);
  assert.equal((await t.fresh()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250, 'the old cache must not return on a later read');
});

test('cached tokens reread a same-size in-place rewrite with changed mtime', async (context) => {
  const t = fixture(context);
  assert.equal((await t.read()).usage?.input, 100);
  const before = statSync(t.path);
  writeFileSync(t.path, content(250));
  utimesSync(t.path, new Date(before.atimeMs), new Date(before.mtimeMs + 2000));
  const after = statSync(t.path);
  assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.equal((await t.fresh()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250);
});

test('cached tokens use ctime when an in-place writer preserves mtime', async (context) => {
  const t = fixture(context);
  // Integer seconds survive the platform's timestamp conversion without rounding.
  utimesSync(t.path, 1700000000, 1700000000);
  assert.equal((await t.read()).usage?.input, 100);
  const before = statSync(t.path);
  writeFileSync(t.path, content(250));
  utimesSync(t.path, 1700000000, 1700000000);
  const after = statSync(t.path);
  assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.ctimeMs, before.ctimeMs, 'the owned rewrite must produce the ctime signal under test');
  assert.equal((await t.fresh()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250);
});

test('a larger atomic replacement is reread from its new beginning', async (context) => {
  const t = fixture(context);
  assert.equal((await t.read()).usage?.input, 100);
  const before = statSync(t.path), next = t.path + '.replacement';
  writeFileSync(next, content(250) + line({ type: 'ignored', text: 'owned extra row' }), { flag: 'wx', mode: 0o600 });
  renameSync(next, t.path);
  const after = statSync(t.path);
  assert.ok(after.size > before.size); assert.notEqual(after.ino, before.ino);
  assert.equal((await t.fresh()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250);
});

test('shrinkage beyond the previous whole-line offset still invalidates cached totals', async (context) => {
  const prefix = '{"type":"ignored","padding":"';
  const t = fixture(context, content(100) + prefix + 'a'.repeat(1024));
  assert.equal((await t.read()).usage?.input, 100);
  const before = statSync(t.path);
  writeFileSync(t.path, content(250) + prefix + 'b'.repeat(100));
  const after = statSync(t.path);
  assert.equal(after.ino, before.ino); assert.ok(after.size < before.size);
  assert.ok(after.size > Buffer.byteLength(content(100)), 'new size remains above the old complete-line offset');
  assert.equal((await t.fresh()).usage?.input, 250);
  assert.equal((await t.read()).usage?.input, 250);
  appendFileSync(t.path, '"}\n');
  assert.equal((await t.read()).usage?.input, 250, 'completing the ignored partial tail must not restore stale totals');
});

test('normal appends, incomplete lines and concurrent reads keep their existing counts', async (context) => {
  const t = fixture(context);
  assert.equal((await t.read()).usage?.input, 100);
  const next = total(250), cut = 40;
  appendFileSync(t.path, next.slice(0, cut));
  assert.equal((await t.read()).usage?.input, 100, 'incomplete token row is not yet counted');
  assert.equal((await t.read()).usage?.input, 100, 'unchanged partial tail remains unread');
  appendFileSync(t.path, next.slice(cut) + total(400));
  const [a, b] = await Promise.all([t.read(), t.read()]);
  assert.equal(a.usage?.input, 400); assert.equal(b.usage?.input, 400);
  assert.deepEqual(await t.read(), await t.fresh());
});
