/**
 * "Always ask before history-rewriting git commands, even at Trusted", per project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type RuleEnv } from './policy-rules.ts';
import type { HookInput, TrustLevel } from './types.ts';

const env: RuleEnv = { home: '/home/me', realish: (p) => p, cwd: '/repo' };
const bash = (command: string): HookInput => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const decide = (trust: TrustLevel, command: string, on: boolean) => evaluate({ trust, projectPath: '/repo', alwaysAskHistoryRewrite: on }, bash(command), env).decision;

test('with the setting on, destructive rewrites ask at every trust level, however they are wrapped', () => {
  for (const cmd of ['git push --force origin feat', 'git push origin +feat', 'git push --delete origin old', 'git reset --hard HEAD~2', 'git branch -D spike',
    'git tag -d v1', 'git update-ref -d refs/heads/x', 'git filter-repo --invert-paths --path secrets', 'bash -c "git filter-branch --tree-filter true HEAD"', 'nohup git -C api push -f']) {
    for (const trust of ['trusted', 'project'] as TrustLevel[]) {
      const d = decide(trust, cmd, true);
      assert.equal(d.decision, 'ask', `${trust}: ${cmd}`);
      assert.equal(d.rule, 'git.history-rewrite-always-ask', `${trust}: ${cmd}`);
    }
  }
  assert.match(decide('trusted', 'git reset --hard', true).reason, /always asks before a history-rewriting git command, even at Trusted/);
});

test('off by default, and routine git is never asked about', () => {
  assert.equal(decide('trusted', 'git push --force origin feat', false).decision, 'allow');
  assert.equal(evaluate({ trust: 'trusted', projectPath: '/repo' }, bash('git reset --hard'), env).decision.decision, 'allow');
  for (const cmd of ['git push origin feat', 'git rebase -i main', 'git commit --amend --no-edit', 'git branch -d merged', 'git reset --soft HEAD~1', 'git status']) {
    assert.equal(decide('trusted', cmd, true).decision, 'allow', cmd);
  }
});

test('never softens a stricter answer', () => {
  // A fork bomb beside a force push is still denied at Project trust.
  assert.equal(decide('project', ':(){ :|:& };: ; git push -f', true).decision, 'deny');
  // Read only already asks for every command; the rewrite does not change who decides.
  assert.equal(decide('readonly', 'git push -f', true).decision, 'ask');
});

test('the trace names the rewrite that asked', () => {
  const t = evaluate({ trust: 'trusted', projectPath: '/repo', alwaysAskHistoryRewrite: true }, bash('npm test && git push --force-with-lease'), env).trace;
  assert.ok(t.steps.some((s) => s.rule === 'git.history-rewrite-always-ask' && s.text.startsWith('git push')));
});
