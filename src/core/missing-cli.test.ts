// What a new user hits before anything is installed: a missing CLI says how to
// install it, and leaves nothing behind; a missing folder says the folder is
// missing, not the CLI; git missing is not "not a repository"; and an agent
// whose CLI is not installed never reads as found.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreError } from '../shared/protocol.ts';
import { changes, repoProblem, setGitEnvironment } from './git.ts';
import { launcher, sh, testCore } from './test-support.ts';
import { ensureWorktree } from './worktrees.ts';

const ID = '-c user.email=t@t -c user.name=t';

test('a session whose CLI is missing is refused with its install command, before a branch or worktree is made', async () => {
  // As if `which codex` found nothing on the login PATH.
  const t = await testCore({ launcher: (provider) => (provider === 'codex' ? null : launcher(provider)) });
  try {
    await sh(`git init -q -b main && git ${ID} commit -q --allow-empty -m init`, t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Add a footer', status: 'ready' });

    await assert.rejects(
      t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id, isolate: true }),
      (e: CoreError) => e.code === 'refused' && /^Codex is not installed/.test(e.message)
        && e.message.includes('`npm install -g @openai/codex`') && e.message.includes('`brew install --cask codex`'),
    );
    assert.equal((await sh('git branch --list "wanigan/*"', t.projectDir)).trim(), '', 'no branch was made for it');
    assert.equal(existsSync(join(t.core.paths.dataDir, 'worktrees')), false, 'no worktree was made for it');
    assert.equal((await t.owner.call('cards.get', { id: card.id })).worktree, null);
    assert.equal((await t.owner.call('sessions.list', {})).length, 0, 'no session was recorded');
  } finally {
    await t.close();
  }
});

test('a missing folder is named as missing, not as a missing CLI', async () => {
  // A Claude Code that is there: only the folder is wrong.
  const t = await testCore({ claudeBinary: '/usr/bin/true', mcpBinaries: { claude: '/usr/bin/true', codex: '/usr/bin/true' } });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Fix the header' });
    const gone = join(t.dir, 'removed-worktree');
    t.core.board.setWorktree(card.id, { path: gone, branch: 'wanigan/x-1', base: 'main' });
    await assert.rejects(t.owner.call('cards.aiReview', { id: card.id }),
      { code: 'refused', message: `The folder ${gone} is missing, so Claude Code cannot run there.` });

    // Wanigan's own folder for asking the CLIs, gone: `claude mcp list` cannot run there.
    const [claude] = (await t.owner.call('accounts.list', {})).filter((a) => a.provider === 'claude');
    rmSync(join(t.core.paths.dataDir, 'probe'), { recursive: true });
    await assert.rejects(t.owner.call('mcp.check', { accountId: claude!.id }), { code: 'refused', message: /^The folder .*probe is missing, so Claude Code cannot run there\.$/ });

    rmSync(t.projectDir, { recursive: true });
    await assert.rejects(t.owner.call('cards.draft', { projectId: project.id, note: 'a footer' }),
      { code: 'refused', message: `The folder ${t.projectDir} is missing, so Claude Code cannot run there.` });
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' }),
      { code: 'refused', message: `The folder ${t.projectDir} is missing, so Claude Code cannot run there.` });
  } finally {
    await t.close();
  }
});

test('git missing says to install it; a folder git does not track is still "not a repository"', async () => {
  const t = await testCore();
  try {
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    // What /usr/bin/git says on a Mac without Apple's command line tools.
    writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "xcode-select: note: No developer tools were found, requesting install." >&2\nexit 1\n');
    chmodSync(join(bin, 'git'), 0o755);
    const missing = (e: CoreError): boolean => e.code === 'refused' && /^git is not installed/.test(e.message) && e.message.includes('`xcode-select --install`');

    // Every git the core runs looks on the login shell's PATH; the variables the core gives git can set another.
    setGitEnvironment({ PATH: bin });
    await assert.rejects(changes(t.projectDir), missing, 'the command line tools stand-in');
    await assert.rejects(ensureWorktree(t.projectDir, join(t.dir, 'wt'), 'X-1'), missing, 'a card branch says so too');
    assert.deepEqual(await repoProblem(t.projectDir), { kind: 'no-git' }, 'the workbench says so too');
    setGitEnvironment({ PATH: join(t.dir, 'nothing-here') });
    await assert.rejects(changes(t.projectDir), missing, 'no git on the PATH at all');
    assert.deepEqual(await repoProblem(t.projectDir), { kind: 'no-git' });

    setGitEnvironment({});
    assert.deepEqual(await changes(t.projectDir), { git: false, branch: null, head: null, files: [], additions: 0, deletions: 0, omitted: 0 });
    assert.deepEqual(await repoProblem(t.projectDir), { kind: 'not-repo' });
  } finally {
    setGitEnvironment({});
    await t.close();
  }
});

test('an agent whose CLI is not installed reads as not installed, and is still known so after a restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wg-home-')));
  const t = await testCore({
    accounts: {
      home,
      prober: async (provider) => (provider === 'codex'
        ? { signedIn: 'unknown', identity: null, plan: null, installed: false }
        : { signedIn: 'yes', identity: 'me@example.com', plan: 'max', installed: true }),
      usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
    },
  });
  try {
    await t.core.accounts.refresh();
    const accounts = await t.owner.call('accounts.list', {});
    const by = (provider: string) => accounts.filter((a) => a.provider === provider).map((a) => [a.label, a.installed, a.signedIn]);
    assert.deepEqual(by('codex'), [['Default', false, 'unknown']]);
    assert.deepEqual(by('claude'), [['Default', true, 'yes']]);
    const row = t.core.db.prepare("SELECT installed FROM accounts WHERE provider = 'codex'").get() as { installed: number | null };
    assert.equal(row.installed, 0, 'kept, so a restart does not read it as found before it checks again');
  } finally {
    await t.close();
    rmSync(home, { recursive: true, force: true });
  }
});
