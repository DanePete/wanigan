// A card's screenshots ask whether the site runs before taking one, and say
// why one was not taken in the live view's own words. A stand-in core and a
// stand-in screenshot window; every project, host and person is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveFailure, LiveRun, LiveStatus } from '../shared/live-site.ts';
import { certificateOf } from '../shared/live-site.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import { wireLiveShots } from './live-shots.ts';
import type { LiveViewWiring } from './live-view.ts';

const RUN: LiveRun = { tool: 'ddev', state: 'running', said: 'running', start: 'ddev start', folder: '/Users/sam/Sites/acme', name: 'acme' };

function world(run: Partial<LiveRun>, shot: Awaited<ReturnType<LiveViewWiring['shoot']>>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const shots: string[] = [];
  const status: LiveStatus = { projectId: 'p1', run: { ...RUN, ...run }, hostnames: ['acme.ddev.site'], certificates: [], busy: null, checkedAt: 0 };
  const client = {
    async callRaw(method: string, params: unknown): Promise<unknown> {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === 'live.site') return { url: 'https://acme.ddev.site/', platform: 'wordpress', token: null };
      if (method === 'live.page') return { url: null };
      if (method === 'live.siteStatus') return status;
      return null;
    },
  };
  const wired = wireLiveShots({
    client: async () => client,
    settings: () => ({ ...DEFAULT_SETTINGS, liveView: true, liveShots: true }),
    shoot: async (_id, url) => { shots.push(url); return shot; },
  });
  const begin = async (): Promise<void> => {
    wired.onEvent('live', { projectId: 'p1', sessionId: 's1', cardId: 'c1', paths: [], kind: 'session-start', at: 1 });
    for (let i = 0; i < 50 && !calls.some((c) => c.method === 'live.shotMissed' || c.method === 'live.saveShot'); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { calls, shots, begin };
}

test('a site ddev says is paused is not photographed, and the card is told why', async () => {
  const w = world({ state: 'paused', said: 'paused' }, null);
  await w.begin();
  assert.deepEqual(w.shots, [], 'no window was opened on the router’s answer');
  const missed = w.calls.find((c) => c.method === 'live.shotMissed');
  assert.deepEqual(missed?.params, { cardId: 'c1', sessionId: 's1', kind: 'before', url: 'https://acme.ddev.site/', reason: 'This site isn’t running. ddev says it is paused.' });
});

test('a page that did not load: the card says why in the view’s words, never the old certificate advice', async () => {
  const certificate = certificateOf({
    subject: 'O=mkcert development certificate', issuer: 'O=mkcert development CA\nOU=pat@northwind-laptop.local (Pat Example)\nCN=mkcert pat@northwind-laptop.local',
    subjectAltName: 'DNS:acme.ddev.site', validFrom: 'Jan  1 00:00:00 2026 GMT', validTo: 'Jan  1 00:00:00 2028 GMT', fingerprint256: 'AB:CD',
  });
  const failure: LiveFailure = {
    code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', url: 'https://acme.ddev.site/',
    certificate: { certificate, local: false, authority: { cn: 'mkcert sam@acme-mac.local', o: 'mkcert development CA', ou: 'sam@acme-mac.local (Sam Sample)' }, caroot: '/x', verdict: 'net::ERR_CERT_AUTHORITY_INVALID' },
  };
  const w = world({}, { failure });
  await w.begin();
  assert.deepEqual(w.shots, ['https://acme.ddev.site/']);
  const reason = String(w.calls.find((c) => c.method === 'live.shotMissed')?.params.reason);
  assert.match(reason, /^This certificate was made on another machine\. It was issued by the mkcert authority of “pat@northwind-laptop\.local \(Pat Example\)”, another machine’s/);
  assert.doesNotMatch(reason, /mkcert -install|from somewhere else/);
});

test('a running site’s page is kept as before', async () => {
  const w = world({}, { data: 'iVBORw0KGgo=', width: 1, height: 1 });
  await w.begin();
  assert.deepEqual(w.calls.find((c) => c.method === 'live.saveShot')?.params, { cardId: 'c1', sessionId: 's1', kind: 'before', url: 'https://acme.ddev.site/', data: 'iVBORw0KGgo=', width: 1, height: 1 });
  assert.ok(!w.calls.some((c) => c.method === 'live.shotMissed'));
});
