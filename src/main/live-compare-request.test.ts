// What the window may ask for a hosted environment or a comparison, checked
// before any window or session is made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRequest, envId, hostedPage } from './live-compare-request.ts';

const TOKEN = 'a'.repeat(48);

test('a hosted page is https only, never with a user name or password', () => {
  assert.equal(hostedPage('https://live-acme.pantheonsite.io/news?page=2'), 'https://live-acme.pantheonsite.io/news?page=2');
  assert.equal(hostedPage('http://www.acme.example/'), null);
  assert.equal(hostedPage('https://editor:secret@www.acme.example/'), null);
  assert.equal(hostedPage('javascript:alert(1)'), null);
  assert.equal(envId('9f1c2d3e-0000-4000-8000-000000000001'), '9f1c2d3e-0000-4000-8000-000000000001');
  assert.equal(envId('../escape'), null);
  assert.equal(envId(42), null);
});

test('a comparison’s picture: the local side may carry the helper’s token, a hosted one never does', () => {
  const local = compareRequest({ projectId: 'p1', url: 'https://acme.ddev.site/news', env: null, width: 1440, token: TOKEN, scan: true });
  assert.deepEqual(local, { projectId: 'p1', url: 'https://acme.ddev.site/news', env: null, width: 1440, token: TOKEN, scan: true });
  const hosted = compareRequest({ projectId: 'p1', url: 'https://www.acme.example/news', env: 'e1', width: 390, token: TOKEN, scan: true });
  assert.equal(hosted?.token, null, 'the token is dropped for a hosted environment');
  assert.equal(hosted?.env, 'e1');
  assert.equal(compareRequest({ projectId: 'p1', url: 'http://www.acme.example/', env: 'e1', width: 1440 }), null, 'hosted is https');
  assert.equal(compareRequest({ projectId: 'p1', url: 'http://acme.ddev.site/', env: null, width: 1440 })?.url, 'http://acme.ddev.site/', 'the local site may be http');
  assert.equal(compareRequest({ projectId: 'p1', url: 'https://acme.ddev.site/', env: null, width: 1000 }), null, 'only the three widths');
  assert.equal(compareRequest({ projectId: 'p1', url: 'https://acme.ddev.site/', env: '../x', width: 1440 }), null);
  assert.equal(compareRequest({ projectId: '', url: 'https://acme.ddev.site/', env: null, width: 1440 }), null);
  assert.equal(compareRequest(null), null);
  assert.equal(compareRequest({ projectId: 'p1', url: 'https://acme.ddev.site/', env: null, width: 768, token: 'not-hex' })?.token, null);
});
