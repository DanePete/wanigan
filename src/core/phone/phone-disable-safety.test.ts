// Off must close actual HTTP and SSE before an external unmount can stall or
// reject. No installed Tailscale or real model is called; the notification
// recovery case runs only its owned shell and injected push service.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { testCore, waitFor } from '../test-support.ts';
import { Tailscale } from './tailscale.ts';

for (const rejects of [false, true]) {
  test(`turning Phone off ends HTTP and SSE before ${rejects ? 'a rejected' : 'a slow, unsuccessful'} Tailscale unmount, preserving pairing for recovery`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      release = () => rejects ? reject(new Error('fixture unmount rejected')) : resolve({ code: 1, stdout: '', stderr: 'fixture unmount failed' });
    });
    const unmountStarted = new Promise<void>(resolve => { entered = resolve; });
    const tailscale = new Tailscale({ bin: 'never-executed-fixture', run: async (_bin, args) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' };
      assert.deepEqual(args, ['serve', '--https=443', '--set-path=/wanigan', 'off']);
      entered();
      return pending;
    } });
    const t = await testCore({ phone: { port: 0, tailscale } });
    const controller = new AbortController();
    let disable: Promise<{ ok: boolean; message?: string; enabled?: boolean; listening?: boolean }> | undefined;
    let read: Promise<void> | undefined;
    let offEvent = (): void => {};
    try {
      await t.owner.call('phone.enable', {});
      const port = t.core.phone.listeningPort!;
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const { code } = await t.owner.call('phone.pairCode', {});
      const paired = await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Fixture phone' }),
      });
      assert.equal(paired.status, 200);
      const { result: { token, device } } = await paired.json() as { result: { token: string; device: { id: string; name: string } } };
      const cardsBefore = await t.owner.call('cards.list', { projectId: project.id });
      const streams = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      assert.equal(streams.status, 200);
      const reader = streams.body!.getReader();
      let ended = false;
      read = (async () => { while (!(await reader.read()).done) { /* drain owned events */ } ended = true; })().catch(() => {});
      let phoneEvents = 0;
      offEvent = t.owner.on(event => { if (event === 'phone') phoneEvents++; });
      disable = t.owner.call('phone.disable', {}).then(value => ({ ok: true, enabled: value.enabled, listening: value.listening }),
        error => ({ ok: false, message: (error as Error).message }));
      await unmountStarted;
      const whileUnmounting = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'cards.create', params: { projectId: project.id, title: 'Must not be created after Off', type: 'task' } }),
        signal: AbortSignal.timeout(1000),
      }).then(response => ({ answered: true, status: response.status }), () => ({ answered: false, status: null }));
      assert.equal(whileUnmounting.answered, false, JSON.stringify(whileUnmounting));
      await waitFor('the existing SSE stream to end before unmount settles', () => ended, 1000);
      await waitFor('the owner to hear the locally disabled state', () => phoneEvents > 0, 1000);
      assert.equal(t.core.phone.enabled, false);
      assert.equal(t.core.phone.listeningPort, null);
      assert.deepEqual(await t.owner.call('cards.list', { projectId: project.id }), cardsBefore);
      assert.deepEqual(await t.owner.call('sessions.list', {}), []);
      release();
      const result = await disable;
      assert.deepEqual(result, rejects ? { ok: false, message: 'fixture unmount rejected' } : { ok: true, enabled: false, listening: false });
      assert.equal(t.core.phone.listeningPort, null, 'external errors cannot reopen the listener');
      assert.deepEqual(t.core.phone.devices.list().map(d => [d.id, d.name]), [[device.id, device.name]], 'Off does not forget the phone');

      const on = await t.owner.call('phone.enable', {});
      assert.equal(on.enabled, true); assert.equal(on.listening, true);
      const recovered = await fetch(`http://127.0.0.1:${t.core.phone.listeningPort!}/api/rpc`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'needs.list', params: {} }),
      });
      assert.equal(recovered.status, 200, 'the existing token works after deliberate re-enable');
      assert.deepEqual(await t.owner.call('cards.list', { projectId: project.id }), cardsBefore);
    } finally {
      release(); await disable;
      offEvent(); controller.abort(); await read;
      await t.close();
    }
  });
}

test('Phone notifications recover after Off cancels a pending needs timer and access is enabled again', async () => {
  const sent: { url: string; bytes: number }[] = [];
  const t = await testCore({ phone: { port: 0, tailscale: new Tailscale({ bin: null }),
    pushFetch: async (url, init) => { sent.push({ url, bytes: init.body.length }); return { status: 201 }; },
  } });
  try {
    await t.core.phone.enable();
    const { code } = await t.owner.call('phone.pairCode', {});
    const { device } = t.core.phone.devices.pair(code, 'Notification fixture');
    const key = createECDH('prime256v1'); key.generateKeys();
    const endpoint = 'https://push.fixture.invalid/owned-test';
    t.core.phone.subscribe(device.id, { endpoint, p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') });
    assert.equal(await t.core.phone.testPush(), 1, 'the actual push pipeline reaches only the injected service');
    assert.equal(sent.length, 1);

    // The listener schedules a real debounce timer. Disable immediately in the
    // same turn, before it can run; no private timer fields are inspected.
    t.core.bus.emit('needs', {});
    await t.core.phone.disable();
    assert.equal(t.core.phone.listeningPort, null);
    await t.core.phone.enable();
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', title: 'Owned failing shell' });
    await t.owner.call('sessions.input', { id: session.id, data: 'exit 3\n' });
    await waitFor('the owned shell failure to appear in real needs', async () => (await t.owner.call('needs.list', {})).some(need => need.sessionId === session.id && need.kind === 'failed'));
    await waitFor('the new need to reach the injected push service after re-enable', () => sent.length === 2, 2500);
    assert.deepEqual(sent.map(s => s.url), [endpoint, endpoint]);
    assert.ok(sent.every(s => s.bytes > 0), 'both notifications contain encrypted payloads');
    assert.deepEqual(t.core.phone.devices.list().map(d => [d.id, d.push]), [[device.id, true]], 'the saved subscription survives');
  } finally { await t.close(); }
});
