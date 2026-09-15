/**
 * Naming templates: a title and a branch rendered from the launch prompt, with
 * the branch held to git's ref rules and no template able to smuggle a
 * character git refuses into `git worktree add -b`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TEMPLATES, normaliseTemplates, parseStoredTemplates, previewNames, refProblem, renderBranch, renderTitle, templateProblems, ticketFrom,
} from './naming-templates.ts';

const input = (over: Partial<Parameters<typeof renderTitle>[1]> = {}) => ({
  prompt: 'JIRA-123 Fix the checkout total rounding\nmore detail here',
  projectName: 'Store Front', projectBranch: 'main', sessionId: 's_01HZX9ABCDEF', now: Date.UTC(2026, 8, 14), ...over,
});

test('with no template the names are exactly what Wanigan already produced', () => {
  assert.equal(renderTitle(null, input()), 'JIRA-123 Fix the checkout total rounding');
  assert.equal(renderBranch(null, input()), 'wanigan/store-front-abcdef');
  assert.equal(renderTitle(null, input({ prompt: null })), null, 'no prompt, no derived title');
  const long = 'x'.repeat(200);
  assert.equal(renderTitle(null, input({ prompt: long }))?.length, 80);
});

test('a ticket comes from the prompt first, then from the checkout branch', () => {
  assert.equal(ticketFrom('please fix PAY-42 today', 'feature/OPS-9-x'), 'PAY-42');
  assert.equal(ticketFrom('fix the thing', 'feature/ops-9-login'), 'OPS-9');
  assert.equal(ticketFrom('fix the thing', 'main'), null);
  assert.equal(ticketFrom('see issue #42 and pr-7', null), null, 'a bare number or a lower-case key in the prompt is not a ticket');
});

test('a title template fills its tokens and tidies what a missing ticket leaves behind', () => {
  assert.equal(renderTitle('{ticket}: {summary}', input()), 'JIRA-123: JIRA-123 Fix the checkout total rounding');
  assert.equal(renderTitle('{ticket}: {summary}', input({ prompt: 'Fix the rounding', projectBranch: 'main' })), 'Fix the rounding');
  assert.equal(renderTitle('[{project}] {summary} — {date}', input({ prompt: 'Tidy logs' })), '[Store Front] Tidy logs — 2026-09-14');
  assert.equal(renderTitle('{ticket}', input({ prompt: 'no ticket here' })), 'no ticket here', 'a template that renders empty falls back to the plain title');
});

test('a branch template renders a valid ref, with the session suffix added when the template has none', () => {
  assert.equal(renderBranch('feature/{ticket}-{summary}', input()), 'feature/JIRA-123-jira-123-fix-the-checkout-total-rounding-abcdef');
  assert.equal(renderBranch('JIRA-123/{summary}-{short}', input({ prompt: 'Fix login' })), 'JIRA-123/fix-login-abcdef');
  assert.equal(renderBranch('feature/{ticket}-{summary}', input({ prompt: 'Fix login', projectBranch: 'main' })), 'feature/fix-login-abcdef',
    'a missing ticket leaves no leading dash on a path segment');
  assert.equal(renderBranch('{ticket}/{summary}', input({ prompt: 'Fix login', projectBranch: 'main' })), 'fix-login-abcdef',
    'an empty leading segment collapses rather than starting the ref with a slash');
  for (const t of ['feature/{ticket}-{summary}', '{project}/{date}/{summary}', 'wip.{short}', '{ticket}/{summary}']) {
    assert.equal(refProblem(renderBranch(t, input())), null, t);
    assert.equal(refProblem(renderBranch(t, input({ prompt: '..//:~^?*[ weird \\ prompt @{' }))), null, `${t} with a hostile prompt`);
  }
});

test('templates are refused for unknown tokens, stray braces and characters a ref cannot hold', () => {
  assert.deepEqual(templateProblems(NO_TEMPLATES), []);
  const cases: [Partial<{ title: string | null; branch: string | null }>, RegExp][] = [
    [{ title: '{tickets}: {summary}' }, /Unknown token \{tickets\}/],
    [{ title: '{summary} {' }, /brace/],
    [{ title: '{short} {summary}' }, /belongs in a branch/],
    [{ branch: 'feature branch/{summary}' }, /letters, digits/],
    [{ branch: 'fix:{summary}' }, /letters, digits/],
    [{ branch: 'a..b/{summary}' }, /\.\./],
    [{ branch: '/lead/{summary}' }, /begin or end with a slash/],
    [{ branch: 'x/.hidden-{summary}' }, /begin with a dot/],
    [{ branch: 'x/{summary}.lock/y' }, /\.lock/],
    [{ branch: '   ' }, /Leave it empty/],
    [{ title: 'x'.repeat(121) }, /at most 120/],
  ];
  for (const [t, pattern] of cases) {
    const problems = templateProblems({ title: null, branch: null, ...t });
    assert.ok(problems.some((p) => pattern.test(p.message)), `${JSON.stringify(t)} → ${JSON.stringify(problems)}`);
  }
  assert.throws(() => normaliseTemplates({ title: 1 }), /is text/);
  assert.deepEqual(normaliseTemplates({ title: '  ', branch: '' }), NO_TEMPLATES, 'empty means use the default');
  assert.deepEqual(normaliseTemplates({ title: '{ticket}: {summary}', branch: 'feature/{summary}' }), { title: '{ticket}: {summary}', branch: 'feature/{summary}' });
});

test('git ref rules, one per clause of check-ref-format', () => {
  for (const bad of ['', '@', '-x', 'a/', '/a', 'a//b', 'a..b', 'a@{b', 'a.', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', 'a\x01b']) {
    assert.notEqual(refProblem(bad), null, JSON.stringify(bad));
  }
  for (const good of ['a', 'feature/JIRA-123-fix', 'wanigan/x-1a2b3c', 'a.b', 'a@b', 'a_b/c-d']) {
    assert.equal(refProblem(good), null, good);
  }
});

test('a stored template that no longer validates is not applied', () => {
  assert.deepEqual(parseStoredTemplates('{"title":"{nope}","branch":null}'), NO_TEMPLATES);
  assert.deepEqual(parseStoredTemplates('garbage'), NO_TEMPLATES);
  assert.deepEqual(parseStoredTemplates(null), NO_TEMPLATES);
  const p = previewNames({ title: '{ticket}: {summary}', branch: 'feature/{ticket}-{summary}' }, input({ prompt: 'PAY-7 refund flow' }));
  assert.deepEqual(p, { title: 'PAY-7: PAY-7 refund flow', branch: 'feature/PAY-7-pay-7-refund-flow-abcdef', branchProblem: null, ticket: 'PAY-7' });
});
