/**
 * Codex hook events, the pure half. The listing fixtures below are shaped
 * exactly like the `hooks/list` answer Codex 0.154.0's app-server gave the
 * trust probe (scripts/probe-codex-hook-trust.mjs) on 15 Sep 2026: the same
 * seventeen fields per hook, the same scope fields, the same keys, sources and
 * trust words, and the same order (preToolUse first, stop last). Only the hash
 * values are invented, because this file tests what Wanigan does with a hash,
 * never how Codex computes one.
 *
 * The subject is "can it lie": pick someone else's hook as Wanigan's, trust a
 * hash that was not confirmed, or keep text the event store must never hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_HOOK_COMMAND, CODEX_HOOK_EVENTS, CODEX_HOOK_HEADERS_ENV, CODEX_HOOK_URL_ENV,
  codexEventName, codexHookConfigArgs, codexHookInput, codexHookKey, codexVersionLabel,
  decideCodexHookTrust, observeOnlyHooksSentence, readCodexHookList,
  type CodexHookEvent, type CodexHookExchange,
} from './codex-hooks.ts';

const hashOf = (event: string, salt = 'a') => `sha256:${Buffer.from(`${salt}:${event}`).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const HASHES = Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, hashOf(event)])) as Record<CodexHookEvent, string>;
const camel = (event: string) => `${event[0].toLowerCase()}${event.slice(1)}`;

type Entry = Record<string, unknown>;
/** The order Codex 0.154.0 listed them in, which is not the order they were passed. */
const LISTED: CodexHookEvent[] = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'];
const wanigan = (event: CodexHookEvent, over: Entry = {}): Entry => ({
  key: codexHookKey(event), eventName: camel(event), handlerType: 'command', command: CODEX_HOOK_COMMAND,
  async: false, matcher: null, timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
  sourcePath: '/<session-flags>/config.toml', source: 'sessionFlags', pluginId: null,
  displayOrder: LISTED.indexOf(event), enabled: true, isManaged: false,
  currentHash: HASHES[event], trustStatus: 'untrusted', ...over,
});
const listing = (hooks: Entry[]) => ({ id: 2, result: { data: [{ cwd: '/private/tmp/work', hooks, warnings: [], errors: [] }] } });
const allSix = (over: (event: CodexHookEvent) => Entry = () => ({})) => LISTED.map((event) => wanigan(event, over(event)));

test('the forwarding command is one fixed string that names both variables and no per-session value', () => {
  assert.equal(CODEX_HOOK_COMMAND,
    '/bin/sh -c \'/usr/bin/curl -q -sS --noproxy "*" --max-time 5 -H @"$WANIGAN_CODEX_HOOK_HEADERS" '
    + '--data-binary @- "$WANIGAN_CODEX_HOOK_URL" >/dev/null 2>&1; exit 0\'');
  assert.ok(CODEX_HOOK_COMMAND.includes(`$${CODEX_HOOK_URL_ENV}`) && CODEX_HOOK_COMMAND.includes(`$${CODEX_HOOK_HEADERS_ENV}`));
  // -q is only honoured as curl's first argument; anywhere else ~/.curlrc is read.
  assert.match(CODEX_HOOK_COMMAND, /^\/bin\/sh -c '\/usr\/bin\/curl -q /);
  assert.doesNotMatch(CODEX_HOOK_COMMAND, /Bearer|127\.0\.0\.1|\d{4,5}\/hook/);
});

test('each key is the session-flags layer, the snake-cased event, and group and handler zero', () => {
  assert.deepEqual(CODEX_HOOK_EVENTS.map(codexHookKey), [
    '/<session-flags>/config.toml:session_start:0:0',
    '/<session-flags>/config.toml:user_prompt_submit:0:0',
    '/<session-flags>/config.toml:pre_tool_use:0:0',
    '/<session-flags>/config.toml:post_tool_use:0:0',
    '/<session-flags>/config.toml:permission_request:0:0',
    '/<session-flags>/config.toml:stop:0:0',
  ]);
});

test('the definition is one --config per event, each a TOML array holding the command as a TOML string', () => {
  const args = codexHookConfigArgs();
  assert.equal(args.length, 12);
  assert.deepEqual(args.filter((_, index) => index % 2 === 0), Array(6).fill('--config'));
  assert.equal(args[11], `hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(CODEX_HOOK_COMMAND)}}]}]`);
  // The command's double quotes are escaped for TOML, and nothing else changes.
  assert.ok(args[11].includes('--noproxy \\"*\\"') && args[11].includes('-H @\\"$WANIGAN_CODEX_HOOK_HEADERS\\"'));
});

test('trust adds exactly one hooks.state entry keyed and hashed per event, and nothing that skips trust', () => {
  const args = codexHookConfigArgs(HASHES);
  assert.equal(args.length, 14);
  assert.deepEqual(args.slice(0, 12), codexHookConfigArgs());
  assert.equal(args[12], '--config');
  assert.equal(args[13], `hooks.state={${CODEX_HOOK_EVENTS.map((event) => `"${codexHookKey(event)}"={trusted_hash="${HASHES[event]}"}`).join(',')}}`);
  assert.ok(args.every((value) => !/bypass|dangerous/i.test(value)));
});

test('a stored hash that is not a sha256 digest is refused before it can be written into TOML', () => {
  assert.throws(() => codexHookConfigArgs({ ...HASHES, Stop: 'sha256:abc"},evil={trusted_hash="x' }), /not a sha256 digest/);
  assert.throws(() => codexHookConfigArgs({ ...HASHES, Stop: HASHES.Stop.toUpperCase() }), /not a sha256 digest/);
  const partial: Partial<Record<CodexHookEvent, string>> = { ...HASHES };
  delete partial.PreToolUse;
  assert.throws(() => codexHookConfigArgs(partial as Record<CodexHookEvent, string>), /PreToolUse/);
});

test('the listing picks all six of Wanigan\'s hooks and reads each hash and trust word', () => {
  const read = readCodexHookList(listing(allSix()));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.others, 0);
  assert.deepEqual(read.entries.Stop, { event: 'Stop', key: codexHookKey('Stop'), hash: HASHES.Stop, trust: 'untrusted', enabled: true });
});

test('another source\'s hook is never picked, even on the same event with the same command', () => {
  const copied = wanigan('Stop', { source: 'user', key: '/Users/x/.codex/config.toml:stop:0:0', trustStatus: 'trusted', currentHash: hashOf('Stop', 'user') });
  const repo = wanigan('PreToolUse', { source: 'project', key: '/repo/.codex/config.toml:pre_tool_use:0:0', command: '/usr/bin/true' });
  const read = readCodexHookList(listing([copied, repo, ...allSix()]));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.others, 2);
  assert.equal(read.entries.Stop.hash, HASHES.Stop);
  assert.equal(read.entries.Stop.trust, 'untrusted');

  // Without Wanigan's own Stop, the operator's copy does not stand in for it.
  const onlyCopy = readCodexHookList(listing([copied, ...allSix().filter((hook) => hook.eventName !== 'stop')]));
  assert.deepEqual(onlyCopy, { ok: false, reason: 'hook-missing', detail: 'Codex did not list Wanigan\'s Stop hook.' });
});

test('a session-flags hook running some other command is not Wanigan\'s, so Wanigan\'s is missing', () => {
  const read = readCodexHookList(listing(allSix((event) => (event === 'PermissionRequest' ? { command: '/usr/bin/true' } : {}))));
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, 'hook-missing');
  assert.match(read.detail, /PermissionRequest/);
});

test('a missing hook carries Codex\'s own complaint when the scope reported one', () => {
  const response = listing(allSix().slice(1));
  (response.result.data[0].errors as unknown[]).push({ message: 'invalid hook definition in /<session-flags>/config.toml' });
  const read = readCodexHookList(response);
  assert.ok(!read.ok && read.reason === 'hook-missing' && /Codex reported: invalid hook definition/.test(read.detail), JSON.stringify(read));
});

test('a hook found under a key other than the derived one is a parse failure, never trusted by that key', () => {
  const read = readCodexHookList(listing(allSix((event) => (event === 'Stop' ? { key: '/<session-flags>/config.toml:stop:1:0' } : {}))));
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, 'parse-failure');
  assert.match(read.detail, /stop:1:0/);
});

test('a malformed answer is a parse failure with Codex\'s own words, never an empty listing', () => {
  const failures = [
    null, 'text', { id: 2 }, { id: 2, result: { data: 'nope' } }, { id: 2, result: { data: [{ cwd: '/x' }] } },
    { id: 2, error: { code: -32601, message: 'method not found: hooks/list' } },
    listing(allSix((event) => (event === 'Stop' ? { currentHash: 'md5:1234' } : {}))),
    listing(allSix((event) => (event === 'Stop' ? { trustStatus: 7 } : {}))),
    listing([...allSix(), wanigan('Stop', { trustStatus: 'trusted' })]),
  ];
  for (const response of failures) {
    const read = readCodexHookList(response);
    assert.equal(read.ok, false, JSON.stringify(response));
    if (!read.ok) assert.equal(read.reason, 'parse-failure', JSON.stringify(response));
  }
  const refused = readCodexHookList(failures[5]);
  assert.ok(!refused.ok && /method not found: hooks\/list/.test(refused.detail));
});

test('the same hook listed once per scope with the same answer is one hook', () => {
  const twice = { id: 2, result: { data: [{ cwd: '/a', hooks: allSix(), warnings: [], errors: [] }, { cwd: '/b', hooks: allSix(), warnings: [], errors: [] }] } };
  assert.equal(readCodexHookList(twice).ok, true);
});

/** A scripted app-server: each call answers with the next response, and the args it was given are kept. */
function scripted(...answers: Array<CodexHookExchange | ((args: string[]) => CodexHookExchange)>) {
  const calls: string[][] = [];
  const exchange = async (args: string[]): Promise<CodexHookExchange> => {
    calls.push(args);
    const next = answers.shift();
    if (!next) throw new Error('called more often than scripted');
    return typeof next === 'function' ? next(args) : next;
  };
  return { calls, exchange };
}
const answered = (hooks: Entry[]): CodexHookExchange => ({ outcome: 'answered', response: listing(hooks) });

test('trust is granted only when the second run, given the first run\'s hashes, reads all six as trusted', async () => {
  const { calls, exchange } = scripted(answered(allSix()), answered(allSix(() => ({ trustStatus: 'trusted' }))));
  assert.deepEqual(await decideCodexHookTrust(exchange), { state: 'trusted', hashes: HASHES });
  assert.deepEqual(calls, [codexHookConfigArgs(), codexHookConfigArgs(HASHES)]);
});

test('untrusted, modified, disabled or re-hashed on the second run is trust not granted, and says which', async () => {
  const cases: Array<[(event: CodexHookEvent) => Entry, RegExp]> = [
    [(event) => ({ trustStatus: event === 'Stop' ? 'untrusted' : 'trusted' }), /Stop untrusted/],
    [(event) => ({ trustStatus: event === 'PreToolUse' ? 'modified' : 'trusted' }), /PreToolUse modified/],
    [(event) => ({ trustStatus: 'trusted', enabled: event !== 'SessionStart' }), /SessionStart disabled/],
    [(event) => ({ trustStatus: 'trusted', currentHash: event === 'UserPromptSubmit' ? hashOf(event, 'b') : HASHES[event] }), /UserPromptSubmit rehashed/],
    [() => ({ trustStatus: 'managed' }), /SessionStart managed/],
  ];
  for (const [second, said] of cases) {
    const { exchange } = scripted(answered(allSix()), answered(allSix(second)));
    const answer = await decideCodexHookTrust(exchange);
    assert.equal(answer.state, 'unavailable');
    if (answer.state === 'unavailable') {
      assert.equal(answer.reason, 'trust-not-granted');
      assert.match(answer.detail, said);
    }
  }
});

test('a run that times out or stops answering ends the probe with that reason, and a timeout never runs the second', async () => {
  const timedOut = scripted({ outcome: 'timeout', detail: 'no answer in 10 s' });
  assert.deepEqual(await decideCodexHookTrust(timedOut.exchange), { state: 'unavailable', reason: 'timeout', detail: 'no answer in 10 s' });
  assert.equal(timedOut.calls.length, 1);
  const stopped = scripted(answered(allSix()), { outcome: 'no-answer', detail: 'exited (code 1)' });
  assert.deepEqual(await decideCodexHookTrust(stopped.exchange), { state: 'unavailable', reason: 'no-answer', detail: 'exited (code 1)' });
  const missing = scripted(answered(allSix().slice(1)));
  const answer = await decideCodexHookTrust(missing.exchange);
  assert.equal(answer.state === 'unavailable' && answer.reason, 'hook-missing');
  assert.equal(missing.calls.length, 1);
});

test('a payload keeps the event and what the timeline reads, and never the prompt, a message or a tool response', () => {
  const prompt = codexHookInput({
    hook_event_name: 'UserPromptSubmit', prompt: 'deploy with key sk-live-123', message: 'also this',
    session_id: 'abc', transcript_path: '/Users/x/.codex/sessions/a.jsonl', model: 'gpt-5.5', turn_id: 't1',
  });
  assert.deepEqual(prompt, { event: 'UserPromptSubmit', input: { hook_event_name: 'UserPromptSubmit' } });
  const tool = codexHookInput({
    hook_event_name: 'pre_tool_use', tool_name: 'shell', call_id: 'call_1',
    tool_input: { command: ['bash', '-lc', 'npm test'], workdir: '/repo', justification: 'run tests' },
    tool_response: { output: 'secret file body', is_error: true }, duration_ms: 12,
  });
  assert.deepEqual(tool, {
    event: 'PreToolUse',
    input: {
      hook_event_name: 'PreToolUse', tool_name: 'shell', tool_use_id: 'call_1', duration_ms: 12,
      tool_input: { command: 'bash -lc npm test' }, tool_response: { is_error: true },
    },
  });
  assert.doesNotMatch(JSON.stringify(codexHookInput({ hook_event_name: 'Stop', last_assistant_message: 'model output' })), /model output/);
});

test('an event name is read in any of the spellings Codex uses, and anything that is not a name is Unknown', () => {
  assert.deepEqual(['Stop', 'stop', 'sessionStart', 'session_start', 'PermissionRequest', 'permission_request'].map(codexEventName),
    ['Stop', 'Stop', 'SessionStart', 'SessionStart', 'PermissionRequest', 'PermissionRequest']);
  assert.equal(codexHookInput({ hook_event_name: 'Stop; rm -rf /' }).event, 'Unknown');
  assert.equal(codexHookInput(null).event, 'Unknown');
  assert.equal(codexHookInput(['Stop']).event, 'Unknown');
});

test('the capability line takes exactly its three shapes, and only "observed" names a first event', () => {
  const when = (at: number) => `@${at}`;
  assert.equal(observeOnlyHooksSentence({ state: 'trusted', version: '0.154.0' }, when),
    'injected and trusted on 0.154.0; no event has arrived yet from a real session');
  assert.equal(observeOnlyHooksSentence({ state: 'observed', version: '0.154.0', firstEventAt: 42 }, when),
    'observed on 0.154.0 — first event @42');
  assert.equal(observeOnlyHooksSentence({ state: 'unavailable', version: '0.154.0', reason: 'timeout', detail: null }, when),
    'not available: Codex\'s app-server did not answer hooks/list within 10 seconds');
  assert.equal(codexVersionLabel('codex-cli 0.154.0'), '0.154.0');
  assert.equal(codexVersionLabel(''), null);
});
