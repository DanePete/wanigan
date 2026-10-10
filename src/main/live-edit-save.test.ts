// Saving a schema edit target (live-edit-save.ts) against a stand-in site: what is sent, and when it is sent again.
// What it proves: a target that shows beyond this page, which the window and the layer ask about before they save, is
// sent again once with the token a helper's first answer gave (the Drupal Webform adapter asks again for the default
// every form shows); a target that shows nowhere else, an answer with no token, or a second refusal is not sent again.
// Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditTarget } from '../shared/live-trace.ts';
import { saveSchemaEdit } from './live-edit-save.ts';

const TOKEN = 'a'.repeat(32);

const target = (over: Partial<EditTarget> = {}): EditTarget => ({
  id: 'words.webform_default.default_submit_button_label', kind: 'config', label: 'Every webform’s submit button (the site’s default)', via: 'schema',
  schema: { type: 'string', title: 'Submit button', minLength: 1 }, value: 'Submit',
  shows: 'every webform that does not give its submit button words of its own (2 of 3 forms)', ...over,
});

/** A stand-in site answering each POST in turn, and what it was sent. */
function site(answers: { status: number; body: unknown }[]) {
  const sent: { path: string; body: unknown }[] = [];
  let reloads = 0;
  return {
    sent, reloads: () => reloads,
    at: (t: EditTarget) => ({
      trace: '0123456789abcdef', target: t, reload: () => { reloads++; },
      post: async (path: string, body: string) => {
        sent.push({ path, body: JSON.parse(body) as unknown });
        const a = answers[sent.length - 1] ?? { status: 500, body: { ok: false, error: 'No more answers.' } };
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
      },
    }),
  };
}

const asks = { status: 409, body: { ok: false, error: 'These are the site’s default words for every webform: saving them changes them on every form without its own (2 of 3), not only this one.', confirm: TOKEN } };

test('a target shown beyond this page is sent again once with the token the site’s first answer gave', async () => {
  const s = site([asks, { status: 200, body: { ok: true, note: 'Saved as the site’s default for every webform.' } }]);
  const saved = await saveSchemaEdit(s.at(target()), 'Send', { noSiteAi: true });
  assert.deepEqual(saved, { ok: true, error: null, revision: null, ai: null });
  assert.deepEqual(s.sent.map((x) => x.body), [
    { trace: '0123456789abcdef', value: 'Send', noSiteAi: true },
    { trace: '0123456789abcdef', value: 'Send', noSiteAi: true, confirm: TOKEN },
  ], 'the same value, with the token');
  assert.equal(s.sent[1]!.path, '/_wanigan/edit/words.webform_default.default_submit_button_label');
  assert.equal(s.reloads(), 1, 'the page is shown again once the site saved');
});

test('a target that shows nowhere else is not sent again: the site’s question is the answer', async () => {
  const s = site([asks]);
  const saved = await saveSchemaEdit(s.at(target({ shows: undefined })), 'Send');
  assert.deepEqual([saved.ok, saved.error, s.sent.length, s.reloads()], [false, asks.body.error, 1, 0]);
});

test('no token, a token that is not one, or a second refusal: nothing more is sent, and the site’s words are said', async () => {
  const none = site([{ status: 409, body: { ok: false, error: 'This changed since the page loaded. Reload, and try again.' } }]);
  assert.equal((await saveSchemaEdit(none.at(target()), 'Send')).error, 'This changed since the page loaded. Reload, and try again.');
  assert.equal(none.sent.length, 1);
  const odd = site([{ status: 409, body: { ok: false, error: 'Asked.', confirm: 'not-a-token' } }]);
  assert.equal((await saveSchemaEdit(odd.at(target()), 'Send')).error, 'Asked.');
  assert.equal(odd.sent.length, 1);
  const twice = site([asks, { ...asks, body: { ...asks.body, error: 'Still asking.' } }]);
  const saved = await saveSchemaEdit(twice.at(target()), 'Send');
  assert.deepEqual([saved.ok, saved.error, twice.sent.length, twice.reloads()], [false, 'Still asking.', 2, 0], 'sent again once, never more');
});
