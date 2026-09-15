/**
 * Splitting an operator's message into asks, and laying evidence beside each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsIn, draftFollowUp, earnsChecklist, filesIn, hintsFor, splitAsks } from './ask-items.ts';

const texts = (m: string) => splitAsks(m).map((i) => i.text);

test('one ask is the whole message and earns no checklist', () => {
  const one = splitAsks('Fix the flaky retry test in src/checkout.test.ts. It started failing after the upgrade.');
  assert.equal(one.length, 1);
  assert.equal(earnsChecklist(one), false);
  assert.deepEqual(one[0].files, ['src/checkout.test.ts']);
  assert.equal(earnsChecklist(splitAsks('')), false);
  assert.equal(earnsChecklist(splitAsks('thanks!')), false);
});

test('numbered and bulleted lines are one item each, with their continuation lines', () => {
  const items = splitAsks([
    'A few things before the release:',
    '1. Bump the version in package.json',
    '2) Update CHANGELOG.md with the retry fix',
    '   and mention the new flag',
    '- run `npm test`',
    '* check the docs build',
  ].join('\n'));
  assert.deepEqual(items.map((i) => i.text), [
    'Bump the version in package.json',
    'Update CHANGELOG.md with the retry fix and mention the new flag',
    'run `npm test`',
    'check the docs build',
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['list', 'list', 'list', 'list']);
  assert.deepEqual(items[2].commands, ['npm test']);
  assert.ok(earnsChecklist(items));
});

test('each question is its own item; statements between them stay together', () => {
  assert.deepEqual(texts('Why does login redirect twice? Fix it in auth/session.ts. It is blocking QA. Is the cookie domain wrong?'), [
    'Why does login redirect twice?',
    'Fix it in auth/session.ts. It is blocking QA.',
    'Is the cookie domain wrong?',
  ]);
});

test('clauses split on "and also", "then" and semicolons, but not the then of an if', () => {
  assert.deepEqual(texts('Rename the helper and also update its callers'), ['Rename the helper', 'update its callers']);
  assert.deepEqual(texts('Add the migration, then run the smoke suite'), ['Add the migration', 'run the smoke suite']);
  assert.deepEqual(texts('Fix the parser; add a test for empty input'), ['Fix the parser', 'add a test for empty input']);
  assert.deepEqual(texts('Write the fixture. Then wire it into smoke.ts.'), ['Write the fixture.', 'wire it into smoke.ts.']);
  assert.deepEqual(texts('If the build fails then retry it once'), ['If the build fails then retry it once']);
  assert.deepEqual(texts('Tidy the imports; if lint fails, then fix it; and also bump the version'), [
    'Tidy the imports', 'if lint fails, then fix it', 'bump the version',
  ]);
  // A piece too short to be an ask folds back rather than becoming one.
  assert.deepEqual(texts('Update the docs; thanks'), ['Update the docs; thanks']);
});

test('code is never split: inline spans stay whole and fenced blocks are skipped', () => {
  const items = splitAsks('Run `cd app; npm test` and also explain the failure\n```\nfoo; bar\nthen baz\n```');
  assert.deepEqual(items.map((i) => i.text), ['Run `cd app; npm test`', 'explain the failure']);
  assert.deepEqual(items[0].commands, ['npm test']);
});

test('abbreviations do not end a sentence', () => {
  assert.deepEqual(texts('Use a stable id, e.g. the order number. Is that unique?'), [
    'Use a stable id, e.g. the order number.', 'Is that unique?',
  ]);
});

test('files: slashes and known extensions, not URLs, dates or and/or', () => {
  assert.deepEqual(filesIn('Edit src/main/hooks.ts:120 and README.md, see https://example.com/a/b on 9/14/2026, and/or `docs/guide.md`'), [
    'docs/guide.md', 'src/main/hooks.ts', 'README.md',
  ]);
  assert.deepEqual(filesIn('nothing here'), []);
});

test('commands: backticked programs, and a bare program with its words up to a connector', () => {
  assert.deepEqual(commandsIn('run npm test and fix what fails'), ['npm test']);
  assert.deepEqual(commandsIn('`git rebase -i main` then `ls`'), ['git rebase -i main']);
  assert.deepEqual(commandsIn('check git'), []);
  assert.deepEqual(commandsIn('then run pytest'), ['pytest']);
});

test('hints: files by path suffix, commands at word boundaries with the newest exit code', () => {
  const item = { files: ['auth/login.ts', 'missing.ts'], commands: ['npm test', 'npm run lint'] };
  const hints = hintsFor(item,
    [{ path: '/repo/src/auth/login.ts', via: 'Edit' }, { path: '/repo/src/other.ts', via: 'Write' }],
    [
      { eventId: 3, at: 100, command: 'cd app && npm test -- --watch=false', ok: false, exitCode: 1 },
      { eventId: 9, at: 200, command: 'npm test', ok: true, exitCode: null },
      { eventId: 12, at: 300, command: 'npm testing', ok: true, exitCode: null },
    ]);
  assert.deepEqual(hints.files, [
    { path: 'auth/login.ts', touched: true, via: 'Edit' },
    { path: 'missing.ts', touched: false, via: null },
  ]);
  assert.equal(hints.commands[0].ran, true);
  assert.equal(hints.commands[0].runs, 2);
  assert.equal(hints.commands[0].latest?.eventId, 9);
  assert.equal(hints.commands[1].ran, false);
  assert.equal(hints.commands[1].latest, null);
});

test('the follow-up draft names each open item as written', () => {
  assert.equal(draftFollowUp([]), '');
  assert.equal(draftFollowUp([{ text: 'update CHANGELOG.md' }]), 'One thing from my last message still looks open: update CHANGELOG.md');
  assert.equal(draftFollowUp([{ text: 'a thing' }, { text: 'b thing' }]), 'These items from my last message still look open:\n1. a thing\n2. b thing');
});

test('deterministic and bounded', () => {
  const long = Array.from({ length: 60 }, (_, i) => `- item number ${i}`).join('\n');
  const a = splitAsks(long);
  assert.equal(a.length, 24);
  assert.deepEqual(splitAsks(long), a);
});
