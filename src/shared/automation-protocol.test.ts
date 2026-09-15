/**
 * The automation socket's parser and its send rule. Every way a line can be
 * wrong gets its own sentence back, and a send is held to the composer's own
 * readiness test — a script is never allowed to answer a permission prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LINE_BYTES, MAX_TEXT_CHARS, clientCommand, decideSend, parseAutomationLine, peerFromLsof, ptyPayload, utf8Bytes,
} from './automation-protocol.ts';

const TOKEN = 'a'.repeat(43);
const line = (o: Record<string, unknown>) => JSON.stringify({ token: TOKEN, ...o });

test('each verb parses into exactly the fields it needs', () => {
  assert.deepEqual(parseAutomationLine(line({ verb: 'list', id: 7 })), { ok: true, request: { verb: 'list', token: TOKEN, id: 7 } });
  assert.deepEqual(parseAutomationLine(line({ verb: 'status', session: 's_1' })),
    { ok: true, request: { verb: 'status', token: TOKEN, id: null, session: 's_1' } });
  const draft = parseAutomationLine(line({ verb: 'draft', session: 's_1', text: 'run the tests\nthen stop' }));
  assert.ok(draft.ok && draft.request.verb === 'draft' && draft.request.text === 'run the tests\nthen stop');
  const send = parseAutomationLine(line({ verb: 'send', session: 's_1', text: 'yes', extra: 'ignored' }));
  assert.ok(send.ok && send.request.verb === 'send');
  const created = parseAutomationLine(line({ verb: 'new', project: 'prj_1', prompt: 'fix CI', provider: 'codex' }));
  assert.deepEqual(created, { ok: true, request: { verb: 'new', token: TOKEN, id: null, project: 'prj_1', prompt: 'fix CI', provider: 'codex' } });
  const defaulted = parseAutomationLine(line({ verb: 'new', project: 'prj_1', prompt: 'fix CI' }));
  assert.ok(defaulted.ok && defaulted.request.verb === 'new' && defaulted.request.provider === null);
});

test('a malformed line is refused with a sentence, and names its verb when it had one', () => {
  const cases: [string, RegExp][] = [
    ['not json', /one JSON object/],
    ['[1,2]', /one JSON object/],
    [JSON.stringify({ verb: 'list' }), /token/],
    [JSON.stringify({ verb: 'list', token: 'short' }), /token/],
    [line({ verb: 'rm -rf' }), /Unknown verb/],
    [line({ verb: 'status' }), /needs "session"/],
    [line({ verb: 'status', session: '../../etc/passwd' }), /needs "session"/],
    [line({ verb: 'draft', session: 's_1' }), /needs "text"/],
    [line({ verb: 'draft', session: 's_1', text: '   ' }), /needs "text"/],
    [line({ verb: 'send', session: 's_1', text: 42 }), /needs "text"/],
    [line({ verb: 'new', prompt: 'x' }), /needs "project"/],
    [line({ verb: 'new', project: 'p', prompt: '' }), /needs "prompt"/],
    [line({ verb: 'new', project: 'p', prompt: 'x', provider: 'claude; rm' }), /provider/],
    [line({ verb: 'draft', session: 's', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), /at most/],
  ];
  for (const [input, pattern] of cases) {
    const r = parseAutomationLine(input);
    assert.equal(r.ok, false, input.slice(0, 80));
    if (!r.ok) assert.match(r.error, pattern, input.slice(0, 80));
  }
  const named = parseAutomationLine(line({ verb: 'draft', session: 's_1', id: 'abc' }));
  assert.ok(!named.ok && named.verb === 'draft' && named.id === 'abc');
  const huge = parseAutomationLine('x'.repeat(MAX_LINE_BYTES + 1));
  assert.ok(!huge.ok && /at most/.test(huge.error));
  assert.equal(utf8Bytes('é😀a'), 2 + 4 + 1);
});

test('the parser never echoes the token back in an error', () => {
  const r = parseAutomationLine(line({ verb: 'nope' }));
  assert.ok(!r.ok && !r.error.includes(TOKEN));
});

test('send writes only at the prompt, queues otherwise, and refuses when scripts may not send', () => {
  assert.deepEqual(decideSend({ allowed: true, halted: false, status: 'running', attention: 'idle' }), { action: 'write' });
  assert.deepEqual(decideSend({ allowed: true, halted: false, status: 'running', attention: 'finished' }), { action: 'write' });
  for (const attention of ['permission', 'error', 'working', null] as const) {
    assert.equal(decideSend({ allowed: true, halted: false, status: 'running', attention }).action, 'queue', String(attention));
  }
  assert.match((decideSend({ allowed: true, halted: false, status: 'running', attention: 'permission' }) as { reason: string }).reason, /permission prompt/);
  assert.equal(decideSend({ allowed: true, halted: false, status: 'starting', attention: null }).action, 'queue');
  assert.equal(decideSend({ allowed: false, halted: false, status: 'running', attention: 'idle' }).action, 'refuse');
  assert.equal(decideSend({ allowed: true, halted: true, status: 'running', attention: 'idle' }).action, 'refuse');
  assert.equal(decideSend({ allowed: true, halted: false, status: 'exited', attention: 'finished' }).action, 'refuse');
  assert.equal(decideSend({ allowed: true, halted: false, status: null, attention: null }).action, 'refuse');
});

test('a send writes the same bytes the composer would', () => {
  assert.deepEqual(ptyPayload('run the tests'), ['run the tests\r']);
  assert.deepEqual(ptyPayload('one\ntwo\n\n'), ['\x1b[200~one\ntwo\x1b[201~', '\r']);
  assert.deepEqual(ptyPayload('\n'), []);
});

test('the reference client turns a command line into a request without a token', () => {
  assert.deepEqual(clientCommand(['list']), { ok: true, request: { verb: 'list', id: null } });
  assert.deepEqual(clientCommand(['draft', 's_1', 'run', 'the', 'tests']),
    { ok: true, request: { verb: 'draft', id: null, session: 's_1', text: 'run the tests' } });
  assert.deepEqual(clientCommand(['new', 'prj', '--provider', 'codex', 'fix', 'CI']),
    { ok: true, request: { verb: 'new', id: null, project: 'prj', prompt: 'fix CI', provider: 'codex' } });
  assert.equal(clientCommand(['send', 's_1']).ok, false);
  assert.equal(clientCommand(['explode']).ok, false);
  assert.equal(clientCommand([]).ok, false);
});

test('the peer is the process whose socket points at our accepted end', () => {
  const own = 'p100\nf14\nd0x7a5860ebeb30dd09\nn/tmp/w.sock\n';
  const all = [
    'p100', 'cnode', 'f14', 'd0x7a5860ebeb30dd09', 'n/tmp/w.sock',
    'p200', 'cPython', 'f3', 'd0xae324cedc00ae8df', 'n->0x7a5860ebeb30dd09',
    'p300', 'cother', 'f4', 'd0x1', 'n->0x2',
  ].join('\n');
  assert.equal(peerFromLsof(own, all, 100), 200);
  assert.equal(peerFromLsof(own, all.replace('n->0x7a5860ebeb30dd09', 'n->0x9'), 100), null, 'no match is an unknown peer, never a guess');
  assert.equal(peerFromLsof('garbage', all, 100), null);
  const selfOnly = ['p100', 'f14', 'd0xabc', 'f15', 'd0xdef', 'n->0xabc'].join('\n');
  assert.equal(peerFromLsof('p100\nf14\nd0xabc\n', selfOnly, 100), 100, 'a client inside this same process is still named');
});
