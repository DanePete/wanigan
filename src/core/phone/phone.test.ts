// Phone access through the real core and its gateway, over HTTP as a phone
// sends it. No Tailscale (a stand-in reports it missing) and any free port.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACCESS } from '../../shared/protocol.ts';
import { PHONE_ACTS } from '../../shared/phone.ts';
import { Core } from '../core.ts';
import { testCore, waitFor, type TestCore } from '../test-support.ts';
import { Tailscale } from './tailscale.ts';

interface Reply { status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string } } }

async function phoneCore(): Promise<TestCore & { port: number; http: (path: string, init?: { method?: string; body?: unknown; token?: string; host?: string; origin?: string }) => Promise<Reply> }> {
  const t = await testCore();
  const page = join(t.dir, 'renderer');
  mkdirSync(join(page, 'assets'), { recursive: true });
  writeFileSync(join(page, 'phone.html'), '<!doctype html><title>Wanigan</title>');
  writeFileSync(join(page, 'assets', 'phone-1.js'), 'console.log(1)');
  writeFileSync(join(page, 'window.html'), '<!doctype html><title>The Mac window</title>');
  await t.owner.call('phone.enable', {});
  const port = t.core.phone.listeningPort!;
  // node:http rather than fetch, which will not send another Host.
  const http = (path: string, init: { method?: string; body?: unknown; token?: string; host?: string; origin?: string } = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = request({
      host: '127.0.0.1', port, path, method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Host: init.host ?? `127.0.0.1:${port}`,
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.origin ? { Origin: init.origin } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => {
        let parsed: Reply['body'];
        try { parsed = JSON.parse(text) as Reply['body']; } catch { parsed = { ok: (res.statusCode ?? 500) < 400, result: text }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  return Object.assign(t, { port, http });
}

async function paired(t: Awaited<ReturnType<typeof phoneCore>>, name = 'Test iPhone'): Promise<string> {
  const { code } = await t.owner.call('phone.pairCode', {});
  const r = await t.http('/wanigan/api/pair', { body: { code, name } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.result as { token: string }).token;
}

const rpc = (t: Awaited<ReturnType<typeof phoneCore>>, token: string, method: string, params: unknown = {}) => t.http('/wanigan/api/rpc', { token, body: { method, params } });

test('a pairing code works once, for one phone, and is refused after it is used or replaced', async () => {
  const t = await phoneCore();
  try {
    const { code, url, expiresAt } = await t.owner.call('phone.pairCode', {});
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'no 0, O, 1, I or L to misread');
    assert.equal(url, null, 'no Tailscale address yet, so nothing for a QR code');
    assert.ok(expiresAt > Date.now());
    const first = await t.http('/api/pair', { body: { code: code.toLowerCase(), name: '  Dane’s iPhone\u0007  ' } });
    assert.equal(first.status, 200);
    assert.equal((first.body.result as { device: { name: string; control: boolean } }).device.name, 'Dane’s iPhone', 'trimmed, control characters gone');
    assert.equal((first.body.result as { device: { control: boolean } }).device.control, true, 'it may act, as the owner chose');
    assert.equal((await t.http('/api/pair', { body: { code, name: 'Another' } })).status, 401, 'spent');
    const next = await t.owner.call('phone.pairCode', {});
    await t.owner.call('phone.pairCode', {});
    assert.equal((await t.http('/api/pair', { body: { code: next.code } })).status, 401, 'a newer code replaces an older one');
    assert.deepEqual((await t.owner.call('phone.status', {})).devices.map((d) => d.name), ['Dane’s iPhone']);
  } finally { await t.close(); }
});

test('guessing pairing codes is slowed: ten wrong ones and pairing waits', async () => {
  const t = await phoneCore();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await t.http('/api/pair', { body: { code: `WRNG-${String(i).padStart(4, '2')}` } })).status, 401);
    const { code } = await t.owner.call('phone.pairCode', {});
    const r = await t.http('/api/pair', { body: { code } });
    assert.equal(r.status, 409);
    assert.match(r.body.error!.message, /Too many wrong pairing codes/);
  } finally { await t.close(); }
});

test('a paired phone reads and acts as the owner, and Activity says it was from that phone', async () => {
  const t = await phoneCore();
  try {
    const token = await paired(t);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const me = await rpc(t, token, 'phone.me');
    assert.equal((me.body.result as { device: { name: string } }).device.name, 'Test iPhone');
    assert.match((me.body.result as { pushKey: string }).pushKey, /^B[A-Za-z0-9_-]{86}$/, 'an uncompressed P-256 key for its notifications');
    const projects = await rpc(t, token, 'projects.list');
    assert.deepEqual((projects.body.result as { id: string }[]).map((p) => p.id), [project.id]);
    const card = await rpc(t, token, 'cards.create', { projectId: project.id, title: 'From the train', type: 'task' });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    const session = await rpc(t, token, 'sessions.start', { projectId: project.id, provider: 'shell' });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const id = (session.body.result as { id: string }).id;
    assert.equal((await rpc(t, token, 'sessions.input', { id, data: 'echo phone-$((6*7))\n' })).status, 200);
    await waitFor('the shell to answer', async () => /phone-42/.test((await t.owner.call('sessions.watch', { id })).replay));
    const activity = await t.owner.call('activity.list', { projectId: project.id });
    const fromPhone = activity.filter((a) => a.actor === 'phone:Test iPhone').map((a) => a.verb);
    assert.ok(fromPhone.some((v) => /created/.test(v)) && fromPhone.some((v) => /started/.test(v)), JSON.stringify(activity.map((a) => [a.actor, a.verb])));
  } finally { await t.close(); }
});

test('a phone never reaches settings, accounts, git, keys or pairing; one allowed only to read cannot act', async () => {
  const t = await phoneCore();
  try {
    const token = await paired(t);
    for (const method of ['git.status', 'accounts.add', 'accounts.signIn', 'jev.setKey', 'skills.copy', 'mcp.add', 'phone.pairCode', 'phone.forget', 'projects.add', 'attachments.save', 'core.stopIfIdle']) {
      const r = await rpc(t, token, method, {});
      assert.equal(r.status, 403, method);
      assert.match(r.body.error!.message, /not available to a phone/, method);
    }
    const device = (await t.owner.call('phone.status', {})).devices[0]!;
    await t.owner.call('phone.setControl', { id: device.id, control: false });
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    assert.equal((await rpc(t, token, 'needs.list')).status, 200, 'it still reads');
    const start = await rpc(t, token, 'sessions.start', { projectId: project.id, provider: 'shell' });
    assert.equal(start.status, 403);
    assert.match(start.body.error!.message, /Test iPhone may only read/);
    await t.owner.call('phone.forget', { id: device.id });
    assert.equal((await rpc(t, token, 'needs.list')).status, 401, 'a forgotten phone’s token stops working at once');
  } finally { await t.close(); }
});

test('what a phone may do is the phone’s list in the protocol, and nothing privileged is on it', () => {
  for (const method of PHONE_ACTS) assert.ok((ACCESS as Record<string, readonly string[]>)[method]?.includes('phone'), method);
  const phoneMethods = Object.entries(ACCESS).filter(([, roles]) => (roles as readonly string[]).includes('phone')).map(([m]) => m);
  assert.deepEqual(phoneMethods.filter((m) => /^(git|accounts\.(?!list)|jev|skills|mcp|attachments|chat|history|projects\.(?!list)|core\.stop|phone\.(?!me|subscribe))/.test(m)), []);
});

test('the gateway serves the page and its files, and refuses another host, another origin, and paths out of its folder', async () => {
  const t = await phoneCore();
  try {
    const page = await t.http('/wanigan/');
    assert.equal(page.status, 200);
    assert.match(String(page.body.result), /<title>Wanigan<\/title>/);
    assert.equal((await t.http('/wanigan/assets/phone-1.js')).status, 200);
    assert.equal((await t.http('/wanigan/window.html')).status, 404, 'only the phone page’s own files');
    assert.equal((await t.http('/wanigan/%E0%A4%A')).status, 404, 'a malformed name is not found, not an error');
    assert.equal((await t.http('/wanigan/../../etc/passwd')).status, 404);
    assert.equal((await t.http('/wanigan/assets/..%2f..%2fphone.html')).status, 404);
    assert.equal((await t.http('/wanigan/', { host: 'evil.example' })).status, 403, 'a name a page elsewhere could point here');
    const { code } = await t.owner.call('phone.pairCode', {});
    assert.equal((await t.http('/api/pair', { body: { code }, origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.http('/api/rpc', { body: { method: 'needs.list' } })).status, 401, 'no token');
  } finally { await t.close(); }
});

test('the event stream carries the core’s news, and a terminal’s output only when asked for', async () => {
  const t = await phoneCore();
  try {
    const token = await paired(t);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const shell = (await rpc(t, token, 'sessions.start', { projectId: project.id, provider: 'shell' })).body.result as { id: string };
    const other = (await rpc(t, token, 'sessions.start', { projectId: project.id, provider: 'shell' })).body.result as { id: string };
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${t.port}/wanigan/api/events?watch=${shell.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    let seen = '';
    const read = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += new TextDecoder().decode(value); } })().catch(() => {});
    await rpc(t, token, 'cards.create', { projectId: project.id, title: 'News', type: 'task' });
    await rpc(t, token, 'sessions.input', { id: shell.id, data: 'echo watched-$((2*21))\n' });
    await rpc(t, token, 'sessions.input', { id: other.id, data: 'echo unwatched-$((2*21))\n' });
    await waitFor('the stream', async () => /"event":"board"/.test(seen) && /watched-42/.test(seen));
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(seen, /unwatched-42/, 'another terminal is not sent');
    const device = (await t.owner.call('phone.status', {})).devices[0]!;
    await t.owner.call('phone.forget', { id: device.id });
    await waitFor('a forgotten phone’s stream to end', async () => (await Promise.race([read.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))])) as boolean);
    controller.abort();
  } finally { await t.close(); }
});

test('phone access is on until turned off, and a pairing code needs it on', async () => {
  const t = await phoneCore();
  try {
    assert.equal((await t.owner.call('phone.status', {})).listening, true);
    assert.equal(t.core.phone.enabled, true);
    // A phone halfway through sending a request does not hold Turn off up: its connection is cut.
    const token = await paired(t);
    const halfway = request({ host: '127.0.0.1', port: t.port, path: '/wanigan/api/rpc', method: 'POST', headers: { Host: `127.0.0.1:${t.port}`, Authorization: `Bearer ${token}`, 'Content-Length': 1000 } });
    const cut = new Promise<string>((resolve) => { halfway.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message)); halfway.on('response', () => resolve('answered')); });
    halfway.write('{"method":');
    await new Promise((r) => setTimeout(r, 100));
    const off = await Promise.race([
      t.owner.call('phone.disable', {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Turn off waited on a phone’s half-sent request')), 2_000)),
    ]);
    assert.equal(await cut, 'ECONNRESET');
    assert.deepEqual([off.enabled, off.listening], [false, false]);
    await assert.rejects(t.owner.call('phone.pairCode', {}), /Turn phone access on first/);
  } finally { await t.close(); }
});

test('phone access and paired phones survive the core restarting', async () => {
  const t = await phoneCore();
  const token = await paired(t);
  t.owner.close();
  await t.core.stop();
  const again = new Core({
    dataDir: t.core.paths.dataDir, codexHookProbe: null, jev: { envKey: null },
    local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
    phone: { port: 0, tailscale: new Tailscale({ bin: null }), rendererDir: join(t.dir, 'renderer') },
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
  });
  try {
    await again.start();
    const port = again.phone.listeningPort;
    assert.ok(port, 'listening again without being asked');
    const res = await fetch(`http://127.0.0.1:${port}/wanigan/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'needs.list', params: {} }),
    });
    assert.equal(res.status, 200, 'the phone is still paired');
  } finally {
    await again.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
