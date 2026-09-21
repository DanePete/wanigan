import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readImprovedPrompt, readPromptImproveRequest } from './prompt-improve.ts';

const request = {
  requestId: 'fe1fb087-8f13-42c8-a66e-fd6b02bc793c',
  draft: '  fix the login; keep the existing API\nDo not change auth providers.  ',
  purpose: 'session follow-up', maxLength: 500, model: 'claude-haiku-4-5-20251001',
};

test('prompt improvement receives only the supplied draft and bounded destination metadata', () => {
  assert.deepEqual(readPromptImproveRequest({ ...request, transcript: 'private conversation', path: '/private' }), request);
  for (const change of [
    { requestId: '../another-request' }, { draft: '  ' }, { draft: 'x'.repeat(16_001) },
    { draft: 'secret\0suffix' }, { purpose: '' }, { purpose: 'x'.repeat(81) },
    { purpose: 'session\nnew instructions' }, { maxLength: 0 }, { maxLength: 24_001 },
    { maxLength: 12.5 }, { model: '--shell' }, { model: 'x'.repeat(129) },
  ]) assert.throws(() => readPromptImproveRequest({ ...request, ...change }));
  for (const value of [null, [], false, 'a draft']) assert.throws(() => readPromptImproveRequest(value));
});

test('a suggestion keeps unanswered questions separate and respects the destination capacity', () => {
  assert.deepEqual(readImprovedPrompt('```json\n{"prompt":"Fix login while preserving the API.","questions":["Which login failure should change?"]}\n```', 100), {
    prompt: 'Fix login while preserving the API.', questions: ['Which login failure should change?'],
  });
  assert.deepEqual(readImprovedPrompt('{"prompt":"  Fix login.  ","questions":[]}', 100), { prompt: 'Fix login.', questions: [] });
  for (const value of [
    null, '{"prompt":', 'null', '[]', '{}', '{"prompt":"","questions":[]}',
    JSON.stringify({ prompt: 'x'.repeat(101), questions: [] }),
    JSON.stringify({ prompt: 'Valid', questions: ['x'.repeat(401)] }),
    JSON.stringify({ prompt: 'Valid', questions: Array(6).fill('Which input?') }),
    JSON.stringify({ prompt: 'Valid', questions: [false] }),
    JSON.stringify({ prompt: 'Valid', questions: [], execute: true }),
    JSON.stringify({ prompt: 'Valid\0suffix', questions: [] }),
  ]) assert.throws(() => readImprovedPrompt(value, 100));
  assert.throws(() => readImprovedPrompt(JSON.stringify({ prompt: 'x'.repeat(24_001), questions: [] }), 50_000));
  assert.throws(() => readImprovedPrompt('{"prompt":"Fix login.","questions":[]}', Number.NaN));
});

test('text destined for a session never acquires terminal escape or editing controls', () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const control = String.fromCharCode(code);
    const draft = `fix${control}login`;
    const answer = JSON.stringify({ prompt: draft, questions: [`which${control}login?`] });
    if ([9, 10, 13].includes(code)) {
      assert.equal(readPromptImproveRequest({ ...request, draft }).draft, draft);
      assert.equal(readImprovedPrompt(answer, 100).prompt, draft);
    } else {
      assert.throws(() => readPromptImproveRequest({ ...request, draft }));
      assert.throws(() => readImprovedPrompt(answer, 100));
      assert.throws(() => readImprovedPrompt(JSON.stringify({ prompt: 'Fix login.', questions: [`which${control}login?`] }), 100));
    }
  }
});
