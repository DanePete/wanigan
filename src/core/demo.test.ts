// The demo is its own world: every agent, CLI, account folder, project and
// answer it uses is a stand-in under its own folder, and what would reach the
// owner's own is refused.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROVIDERS } from '../shared/model.ts';
import { demoOptions, seedDemo } from './demo.ts';
import { testCore, waitFor } from './test-support.ts';

test('the demo runs on stand-ins kept in its own folder, and nothing it starts or reads is the owner’s', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wg-demo-')));
  const options = demoOptions(base);
  const t = await testCore({ ...options, demo: true });
  const inside = (path: string | null | undefined): boolean => typeof path === 'string' && (path.startsWith(`${base}/`) || path.startsWith(`${t.dir}/`));
  try {
    for (const path of [options.claudeBinary, options.ghBinary, options.mcpBinaries?.claude, options.mcpBinaries?.codex, options.accounts?.home]) {
      assert.ok(inside(path), `${path} is the demo’s`);
    }
    for (const provider of PROVIDERS) assert.equal(options.launcher?.(provider, '/usr/bin:/bin')?.file, '/bin/sh', `${provider} is a stand-in`);
    assert.equal(options.codexHookProbe, null);
    assert.equal(typeof options.jev?.answer, 'function', 'Jev answers locally');

    await seedDemo(t.core, base);
    const projects = await t.owner.call('projects.list', {});
    assert.deepEqual(projects.map((p) => p.key).sort(), ['FIE', 'NS', 'OA']);
    assert.ok(projects.every((p) => inside(p.path)), 'its projects are its own folders');
    const accounts = await t.owner.call('accounts.list', {});
    assert.ok(accounts.length >= 4 && accounts.every((a) => a.configDir === null || inside(a.configDir)), 'its accounts are folders in its own home');
    const sessions = await t.owner.call('sessions.list', {});
    assert.ok(sessions.length >= 5 && sessions.every((s) => inside(s.cwd)), 'its sessions run in its own folders');

    // What would start the owner's own CLIs answers from the stand-ins instead.
    const codex = await t.owner.call('sessions.models', { provider: 'codex', projectId: projects[0]!.id });
    assert.deepEqual([codex.source, codex.models.filter((m) => !m.local).map((m) => m.value)], ['live', ['gpt-5.5', 'gpt-5.5-mini']]);
    // Its LM Studio is a stand-in in its own folder: the owner's models and Ollama are never read, and it downloads nothing.
    const local = await t.owner.call('local.status', {});
    assert.deepEqual(local.lmstudio.models.map((m) => m.id), ['qwen/qwen3-coder-30b']);
    assert.equal(local.ollama.running, false);
    await assert.rejects(t.owner.call('local.download', { module: 'qwen3-coder-30b' }), /The demo downloads nothing/);
    const ns = projects.find((p) => p.key === 'NS')!;
    const card = (await t.owner.call('cards.list', { projectId: ns.id })).find((c) => c.status === 'ready')!;
    await t.owner.call('cards.aiReview', { id: card.id });
    const review = await waitFor('review', async () => (await t.owner.call('cards.get', { id: card.id })).reviews.find((r) => r.state !== 'running'));
    assert.equal(review.state, 'done', 'the stand-in Claude reviewed it');
    assert.equal((await t.owner.call('jev.status', {})).model, 'jev-demo');

    const [account] = accounts;
    await assert.rejects(t.owner.call('accounts.signIn', { id: account!.id }), /demo signs nothing in/);
    await assert.rejects(t.owner.call('mcp.terminal', { catalogId: 'github', accountId: account!.id, scope: 'user' }), /demo opens no terminal/);
    assert.equal((await t.owner.call('core.hello', {})).demo, true, 'and it says it is the demo');
  } finally {
    await t.close();
    rmSync(base, { recursive: true, force: true });
  }
});
