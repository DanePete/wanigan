// A real owned HTTP body spans an owner permission change. The source of truth
// must be checked when dispatch is ready, not frozen while the body is arriving.
// Only a temporary core/project and stand-in shell; no real services or models.
import assert from 'node:assert/strict';
import { request, type ClientRequest } from 'node:http';
import { test } from 'node:test';
import type { PhoneDevice } from '../../shared/phone.ts';
import { testCore } from '../test-support.ts';

interface Reply { status: number; body: { ok: boolean; result?: { id: string }; error?: { code: string } } }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const t = await testCore();
  await t.owner.call('phone.enable', {});
  const project = await t.owner.call('projects.add', { path: t.projectDir });
  await t.owner.call('cards.create', { projectId: project.id, title: 'Preserve the existing card', type: 'task' });
  const port = t.core.phone.listeningPort!;
  const { code } = await t.owner.call('phone.pairCode', {});
  const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Delayed body fixture' }),
  });
  assert.equal(response.status, 200);
  const { result: { token, device } } = await response.json() as { result: { token: string; device: PhoneDevice } };
  const gateway = (t.core.phone as unknown as { gateway: { options: { device: (token: string) => PhoneDevice | null } } }).gateway;
  const byToken = gateway.options.device;
  const pending = new Set<ClientRequest>();
  const start = (method: string, params: unknown, suppliedToken = token) => {
    const authenticated = deferred<PhoneDevice | null>();
    gateway.options.device = (given) => { const current = byToken(given); authenticated.resolve(current); return current; };
    const text = JSON.stringify({ method, params });
    let req!: ClientRequest;
    const reply = new Promise<Reply>((resolve, reject) => {
      req = request({ hostname: '127.0.0.1', port, path: '/api/rpc', method: 'POST', agent: false,
        headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${suppliedToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
      }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => { pending.delete(req); resolve({ status: res.statusCode!, body: JSON.parse(body) as Reply['body'] }); });
      });
      req.on('error', reject); pending.add(req); req.write(text.slice(0, -1));
    });
    return { authenticated: authenticated.promise, reply, finish: () => req.end(text.slice(-1)) };
  };
  const snapshot = () => ({ cards: t.core.db.prepare('SELECT * FROM cards ORDER BY id').all(), sessions: t.core.db.prepare('SELECT * FROM sessions ORDER BY id').all() });
  const fresh = async (method: string, params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() as Reply['body'] };
  };
  return { ...t, project, device, token, start, fresh, snapshot, async close() { for (const req of pending) req.destroy(); await t.close(); } };
}

for (const permission of ['read-only', 'forgotten'] as const) {
  for (const method of ['cards.create', 'sessions.start'] as const) {
    test(`a body held across ${permission} cannot dispatch ${method} with stale authority`, async () => {
      const t = await fixture();
      try {
        const params = method === 'cards.create'
          ? { projectId: t.project.id, title: 'Must not be created', type: 'task' }
          : { projectId: t.project.id, provider: 'shell', title: 'Must not be started' };
        const before = t.snapshot();
        const held = t.start(method, params);
        assert.equal((await held.authenticated)?.control, true, 'the request was admitted while it could act');
        if (permission === 'read-only') await t.owner.call('phone.setControl', { id: t.device.id, control: false });
        else await t.owner.call('phone.forget', { id: t.device.id });
        const current = (await t.owner.call('phone.status', {})).devices.find((d) => d.id === t.device.id);
        assert.equal(current?.control ?? null, permission === 'read-only' ? false : null, 'owner change committed before body completion');
        held.finish();
        const response = await held.reply;
        assert.equal(response.status, permission === 'read-only' ? 403 : 401);
        assert.equal(response.body.error?.code, permission === 'read-only' ? 'forbidden' : 'unauthorized');
        assert.deepEqual(t.snapshot(), before, 'exact card and session rows are unchanged');
        assert.equal((await t.fresh(method, params)).status, response.status, 'fresh and delayed requests use the same current authority');
        assert.deepEqual(t.snapshot(), before, 'fresh refusal also has no side effects');
        assert.equal((await t.owner.call('projects.list', {})).length, 1, 'the owner still answers');
        if (permission === 'read-only') {
          assert.equal((await t.fresh('cards.list', { projectId: t.project.id })).status, 200, 'read-only remains able to read');
          await t.owner.call('phone.setControl', { id: t.device.id, control: true });
          const recovered = await t.fresh(method, params);
          assert.equal(recovered.status, 200, 'explicitly restoring control permits new work');
          const after = t.snapshot();
          if (method === 'cards.create') { assert.equal(after.cards.length, before.cards.length + 1); assert.deepEqual(after.sessions, before.sessions); }
          else { assert.equal(after.sessions.length, before.sessions.length + 1); assert.deepEqual(after.cards, before.cards); await t.owner.call('sessions.stop', { id: recovered.body.result!.id }); }
        }
      } finally { await t.close(); }
    });
  }
}

test('a still-authorized held body dispatches once, and an unpaired token is refused before its body ends', async () => {
  const t = await fixture();
  try {
    const before = t.snapshot();
    const held = t.start('cards.create', { projectId: t.project.id, title: 'A valid delayed card', type: 'task' });
    assert.equal((await held.authenticated)?.control, true);
    held.finish();
    assert.equal((await held.reply).status, 200);
    const after = t.snapshot();
    assert.equal(after.cards.length, before.cards.length + 1);
    assert.equal((after.cards as { title: string }[]).filter((c) => c.title === 'A valid delayed card').length, 1);
    assert.deepEqual(after.sessions, before.sessions);
    const invalid = t.start('cards.create', { projectId: t.project.id, title: 'Invalid token', type: 'task' }, 'unpaired-fixture-token');
    assert.equal(await invalid.authenticated, null);
    assert.equal((await invalid.reply).status, 401, 'early auth does not wait for the held body');
    assert.deepEqual(t.snapshot(), after);
  } finally { await t.close(); }
});
