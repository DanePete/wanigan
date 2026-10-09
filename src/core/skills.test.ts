// Skills against a pretend home: Claude accounts with personal, synced and
// plugin skills, Codex's folders, and a project with skills for both agents.
// Nothing here reads or writes the real home.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { Skill, SkillsListing } from '../shared/skills.ts';
import { testCore, tokenOf, type TestCore } from './test-support.ts';

const ORG = '78d13bab-7b05-4e56-af70-0bb0c4a1e340';
const ACCT = '90f03edf-c9b2-47b9-867e-f33af4485734';

function skill(dir: string, name: string, description: string, body = `# ${name}\n\nDo the thing.\n`): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
}

/** Every file and folder under a path, for proving nothing else was written. */
function tree(root: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      out.push(`${relative(root, p)}${st.isDirectory() ? '/' : st.isSymbolicLink() ? '@' : `:${createHash('md5').update(readFileSync(p)).digest('hex').slice(0, 8)}`}`);
      if (st.isDirectory()) visit(p);
    }
  };
  visit(root);
  return out.sort();
}

describe('skills', () => {
  let t: TestCore;
  let fixture: string;
  let home: string;
  let outside: string;
  let projectId: string;
  let listing: SkillsListing;
  const all = (): Skill[] => listing.groups.flatMap((g) => g.skills);
  const named = (name: string, agent?: string): Skill => {
    const s = all().find((x) => x.name === name && (!agent || x.agent === agent));
    assert.ok(s, `skill ${name} listed`);
    return s;
  };

  before(async () => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'wg-skills-')));
    home = join(fixture, 'home');
    outside = join(fixture, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'not yours to read\n');

    // Claude, default account.
    const claude = join(home, '.claude');
    skill(join(claude, 'skills', 'brainstorming'), 'brainstorming', 'Explore intent before building.');
    mkdirSync(join(claude, 'skills', 'brainstorming', 'scripts'));
    writeFileSync(join(claude, 'skills', 'brainstorming', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    symlinkSync(join(outside, 'secret.txt'), join(claude, 'skills', 'brainstorming', 'notes.txt'));
    writeFileSync(join(claude, 'skills', 'brainstorming', '.DS_Store'), 'x');
    mkdirSync(join(claude, 'skills', 'sneaky'), { recursive: true });
    symlinkSync(join(outside, 'secret.txt'), join(claude, 'skills', 'sneaky', 'SKILL.md'));
    skill(join(outside, 'shared-skill'), 'linked', 'Lives elsewhere, linked in.');
    symlinkSync(join(outside, 'shared-skill'), join(claude, 'skills', 'linked'));
    skill(join(claude, 'skills', 'synced', `${ORG}_${ACCT}`, 'morning'), 'morning', 'A morning brief.');
    skill(join(claude, 'skills', 'synced', 'aaaaaaaa-0000-0000-0000-000000000000_bbbbbbbb-0000-0000-0000-000000000000', 'other-login'), 'other-login', 'Someone else’s.');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, accountUuid: ACCT, emailAddress: 'me@example.com' } }));
    const install = join(claude, 'plugins', 'cache', 'market', 'helper', '1.0.0');
    skill(join(install, 'skills', 'plug-skill'), 'plug-skill', 'From a plugin.');
    skill(join(install, 'extra', 'deep-one'), 'deep-one', 'Declared in the manifest.');
    mkdirSync(join(install, '.claude-plugin'), { recursive: true });
    writeFileSync(join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'helper', skills: ['./extra/deep-one', '../../../../../../outside'] }));
    skill(join(claude, 'plugins', 'cache', 'market', 'helper', '0.9.0', 'skills', 'old-skill'), 'old-skill', 'A stale cached version.');
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'helper@market': [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@market': false } }));

    // Claude, a second account.
    skill(join(home, '.claude_work', 'skills', 'work-only'), 'work-only', 'Only the work account sees this.');
    writeFileSync(join(home, '.claude_work', 'settings.json'), '{}');

    // Codex.
    skill(join(home, '.agents', 'skills', 'shared-one'), 'shared-one', 'Every Codex account sees this.');
    skill(join(home, '.agents', 'skills', 'group', 'nested'), 'nested', 'Codex walks into folders.');
    skill(join(home, '.codex', 'skills', 'codex-own'), 'codex-own', 'In CODEX_HOME.');
    skill(join(home, '.codex', 'skills', '.system', 'imagegen'), 'imagegen', 'Built in.');
    writeFileSync(join(home, '.codex', 'config.toml'), '');

    t = await testCore({
      accounts: {
        home,
        prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
        usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
      },
    });
    skill(join(t.projectDir, '.claude', 'skills', 'deploy'), 'deploy', 'Ship the site.');
    skill(join(t.projectDir, '.agents', 'skills', 'review'), 'review', 'Review a change.');
    skill(join(t.projectDir, '.codex', 'skills', 'lint'), 'lint', 'Lint it.');
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    listing = await t.owner.call('skills.list', {});
  });

  after(async () => {
    await t?.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  test('every skill is listed by where it lives, for the agent that reads it', () => {
    const where = (name: string, agent?: string): string => {
      const s = named(name, agent);
      const g = listing.groups.find((x) => x.skills.includes(s))!;
      return `${g.agent}/${g.source}/${g.title}${g.account ? `/${g.account}` : ''}`;
    };
    assert.equal(where('brainstorming'), 'claude/personal/Personal/Default');
    assert.equal(where('work-only'), 'claude/personal/Personal/work');
    assert.equal(where('morning'), 'claude/synced/Synced from claude.ai/Default');
    assert.equal(where('plug-skill'), 'claude/plugin/Plugins/Default');
    assert.equal(where('deep-one'), 'claude/plugin/Plugins/Default');
    assert.equal(where('deploy'), 'claude/project/site');
    assert.equal(where('shared-one'), 'codex/personal/Personal/every Codex account');
    assert.equal(where('nested'), 'codex/personal/Personal/every Codex account');
    assert.equal(where('codex-own'), 'codex/personal/Personal/Default');
    assert.equal(where('review'), 'codex/project/site');
    assert.equal(where('lint'), 'codex/project/site');
    const names = all().map((s) => s.name);
    for (const absent of ['old-skill', 'imagegen', 'other-login', 'synced']) assert.ok(!names.includes(absent), `${absent} is not listed`);
    assert.ok(!all().some((s) => s.agent === 'codex' && s.name === 'deploy'), 'Codex does not read .claude/skills');
  });

  test('each skill says what it is, who sees it and what can be done with it', () => {
    const b = named('brainstorming');
    assert.equal(b.description, 'Explore intent before building.');
    assert.equal(b.invoke, '/brainstorming');
    assert.equal(b.displayDir, '~/.claude/skills/brainstorming');
    assert.equal(b.files, 3, 'SKILL.md, run.sh and .DS_Store; the link is not counted');
    assert.ok(b.bytes > 0 && b.modified > 0);
    assert.equal(b.removable, true);
    assert.equal(b.projectIds, 'all');
    const plugin = named('plug-skill');
    assert.equal(plugin.invoke, '/helper:plug-skill');
    assert.equal(plugin.plugin, 'helper@market');
    assert.equal(plugin.enabled, false, 'the plugin is switched off in settings.json');
    assert.equal(plugin.removable, false);
    assert.equal(named('morning').removable, false);
    assert.equal(named('linked').linkedTo, join(outside, 'shared-skill'));
    const deploy = named('deploy');
    assert.deepEqual(deploy.projectIds, [projectId]);
    assert.equal(deploy.accountIds, 'all');
    assert.equal(named('shared-one').accountIds, 'all');
  });

  test('listing a skill whose SKILL.md links outside its folder reveals none of the target text', async () => {
    const listed = await t.owner.call('skills.list', {});
    assert.doesNotMatch(JSON.stringify(listed), /not yours to read/);
    const sneaky = listed.groups.flatMap((g) => g.skills).find((s) => s.name === 'sneaky');
    assert.ok(sneaky, 'an unreadable skill remains listed so the owner can remove it');
    assert.match(sneaky.description, /links outside its folder/);
  });

  test('a SKILL.md is read whole; one that links out of its folder is refused', async () => {
    const read = await t.owner.call('skills.read', { id: named('brainstorming').id });
    assert.match(read.text, /^---\nname: brainstorming/);
    assert.equal(read.truncated, false);
    const sneaky = all().find((s) => s.name === 'sneaky');
    assert.ok(sneaky, 'a skill whose SKILL.md is a link is still listed');
    await assert.rejects(t.owner.call('skills.read', { id: sneaky.id }), /links outside its folder/);
    await assert.rejects(t.owner.call('skills.read', { id: 'no-such-skill' }), /no longer there/);
  });

  test('listing, reading and previewing write nothing', async () => {
    const before = [tree(home), tree(t.projectDir), tree(outside)];
    await t.owner.call('skills.list', {});
    await t.owner.call('skills.read', { id: named('deploy').id });
    const { plan, done } = await t.owner.call('skills.copy', { id: named('brainstorming').id, to: { agent: 'claude', projectId }, preview: true });
    assert.equal(done, false);
    assert.equal(plan.displayDest, `${t.projectDir}/.claude/skills/brainstorming`);
    assert.deepEqual([tree(home), tree(t.projectDir), tree(outside)], before);
  });

  test('a copy writes exactly the files it listed, and nothing it did not', async () => {
    const id = named('brainstorming').id;
    const to = { agent: 'codex' as const, projectId };
    const { plan } = await t.owner.call('skills.copy', { id, to, preview: true });
    assert.deepEqual(plan.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.sh']);
    assert.deepEqual(plan.skipped.map((s) => `${s.path} (${s.why})`).sort(), ['.DS_Store (Finder file)', 'notes.txt (a link)']);
    assert.equal(plan.replaces, null);
    assert.equal(plan.inProject, true);
    const homeBefore = tree(home);
    const projectBefore = tree(t.projectDir);
    await assert.rejects(t.owner.call('skills.copy', { id, to }), /changed since you looked/, 'applying needs the plan');
    const { done } = await t.owner.call('skills.copy', { id, to, planId: plan.planId });
    assert.equal(done, true);
    const dest = join(t.projectDir, '.agents', 'skills', 'brainstorming');
    assert.deepEqual(tree(dest).filter((p) => !p.endsWith('/')).map((p) => p.split(':')[0]).sort(), ['SKILL.md', 'scripts/run.sh']);
    assert.equal(statSync(join(dest, 'scripts', 'run.sh')).mode & 0o777, 0o755, 'a script stays runnable');
    const added = tree(t.projectDir).filter((p) => !projectBefore.includes(p));
    assert.deepEqual(added.map((p) => p.split(':')[0]).sort(), [
      '.agents/skills/brainstorming/', '.agents/skills/brainstorming/SKILL.md', '.agents/skills/brainstorming/scripts/', '.agents/skills/brainstorming/scripts/run.sh',
    ]);
    assert.deepEqual(tree(home), homeBefore, 'the source is untouched');
    const activity = await t.owner.call('activity.list', { projectId });
    assert.ok(activity.some((a) => a.verb === 'copied a skill into the project'));
  });

  test('a copy never overwrites without asking, and what it replaces goes to the trash', async () => {
    const id = named('shared-one').id;
    const to = { agent: 'claude' as const, accountId: null };
    const first = await t.owner.call('skills.copy', { id, to, preview: true });
    assert.equal(first.plan.displayDest, '~/.claude/skills/shared-one');
    await t.owner.call('skills.copy', { id, to, planId: first.plan.planId });
    writeFileSync(join(home, '.claude', 'skills', 'shared-one', 'local-notes.md'), 'mine\n');
    const again = await t.owner.call('skills.copy', { id, to, preview: true });
    assert.deepEqual(again.plan.replaces, { files: 2, linkedTo: null });
    await assert.rejects(t.owner.call('skills.copy', { id, to, planId: again.plan.planId }), /already exists/);
    await t.owner.call('skills.copy', { id, to, planId: again.plan.planId, overwrite: true });
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'shared-one', 'local-notes.md')));
    const trash = join(t.core.paths.dataDir, 'trash', 'skills');
    const kept = readdirSync(trash).find((n) => n.endsWith('-shared-one'));
    assert.ok(kept && existsSync(join(trash, kept, 'local-notes.md')), 'the replaced folder is kept in the trash');
  });

  test('a destination that leads out of its root through a link is refused, and nothing is written', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'wg-skills-p2-')));
    try {
      mkdirSync(join(outside, 'elsewhere'), { recursive: true });
      symlinkSync(join(outside, 'elsewhere'), join(other, '.claude'));
      const p2 = await t.owner.call('projects.add', { path: other });
      const before = tree(outside);
      await assert.rejects(
        t.owner.call('skills.copy', { id: named('brainstorming').id, to: { agent: 'claude', projectId: p2.id }, preview: true }),
        /through a link/,
      );
      assert.deepEqual(tree(outside), before);
      await t.owner.call('projects.archive', { id: p2.id });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    await assert.rejects(t.owner.call('skills.copy', { id: named('deploy').id, to: { agent: 'claude', projectId: 'nope' }, preview: true }), /No such project/);
    await assert.rejects(t.owner.call('skills.copy', { id: named('deploy').id, to: { agent: 'shell' } as never, preview: true }), /which agent/);
    await assert.rejects(t.owner.call('skills.copy', { id: named('deploy').id, to: { agent: 'claude', projectId }, preview: true }), /already there/);
  });

  test('a plugin’s skill path that climbs out of the plugin is ignored', () => {
    assert.ok(!all().some((s) => s.dir.startsWith(outside) && s.source === 'plugin'));
  });

  test('remove moves a hand-managed skill to the trash, and refuses plugin and synced skills', async () => {
    await assert.rejects(t.owner.call('skills.remove', { id: named('plug-skill').id }), /belongs to a plugin/);
    await assert.rejects(t.owner.call('skills.remove', { id: named('morning').id }), /only removes/);
    const deploy = named('deploy');
    const result = await t.owner.call('skills.remove', { id: deploy.id });
    assert.equal(result.removed, deploy.displayDir);
    assert.ok(!existsSync(deploy.dir));
    assert.ok(result.keptAt && existsSync(join(t.core.paths.dataDir, 'trash', 'skills', result.keptAt.split('/').pop()!, 'SKILL.md')));
    const linked = named('linked');
    await t.owner.call('skills.remove', { id: linked.id });
    assert.ok(!existsSync(linked.dir), 'the link is gone');
    assert.ok(existsSync(join(outside, 'shared-skill', 'SKILL.md')), 'what it linked to is untouched');
    listing = await t.owner.call('skills.list', {});
    assert.ok(!all().some((s) => s.name === 'deploy' && s.agent === 'claude'));
  });

  test('skills are the owner’s: a session cannot list, read, copy or remove them', async () => {
    const session = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    try {
      for (const [method, params] of [['skills.list', {}], ['skills.read', { id: 'x' }], ['skills.copy', { id: 'x', to: { agent: 'claude' } }], ['skills.remove', { id: 'x' }]] as const) {
        await assert.rejects(agent.call(method as 'skills.list', params as never), /not available to a session/);
      }
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: session.id });
    }
  });
});
