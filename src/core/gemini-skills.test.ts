// Gemini CLI's skills against a pretend home, read where Gemini CLI 0.46 reads
// them (its SkillManager; `gemini skills list` run against a throwaway home):
// ~/.gemini/skills and ~/.agents/skills, and a project's .gemini/skills and
// .agents/skills once the folder is trusted, one level deep, by frontmatter name.
// Nothing here reads or writes the real home.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Skill, SkillsListing } from '../shared/skills.ts';
import { testCore, waitFor } from './test-support.ts';

function skill(dir: string, front: string, body = '# Steps\n\nDo the thing.\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `${front}\n${body}`);
}
const front = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n`;
const FAKE_GEMINI = 'echo "TOKEN=$WANIGAN_TOKEN HOME=${GEMINI_CLI_HOME-unset} ARGS=$*"; exec cat';
const launcher = (provider: string) => (provider === 'gemini' ? { file: '/bin/sh', args: ['-c', FAKE_GEMINI, 'fake-gemini'] } : null);

test('Gemini CLI’s skills are listed where it reads them, by its own rules, beside Codex’s for the folder they share', async () => {
  const t = await testCore({ launcher });
  try {
    const home = join(t.dir, 'home');
    skill(join(home, '.gemini', 'skills', 'style'), front('acme:style guide', 'Write in the Acme house style.'));
    skill(join(home, '.gemini', 'skills', 'bare'), '# No frontmatter\n');
    skill(join(home, '.gemini', 'skills', 'group', 'deeper'), front('deeper', 'Gemini does not walk into folders.'));
    skill(join(home, '.agents', 'skills', 'shared-one'), front('shared-one', 'Codex and Gemini both read this.'));
    skill(join(t.projectDir, '.gemini', 'skills', 'release'), front('release', 'Cut a release of the Acme storefront.'));
    skill(join(t.projectDir, '.agents', 'skills', 'review'), front('review', 'Review a change.'));
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const listing: SkillsListing = await t.owner.call('skills.list', {});
    const gemini = listing.groups.filter((g) => g.agent === 'gemini');
    const where = (g: (typeof gemini)[number]): string => `${g.source}/${g.title}/${g.where}`;
    assert.deepEqual(gemini.map(where), ['personal/Personal/~/.gemini/skills', 'personal/Personal/~/.agents/skills', 'project/site/.gemini/skills', 'project/site/.agents/skills']);
    const all: Skill[] = gemini.flatMap((g) => g.skills);
    const byName = (name: string): Skill => { const s = all.find((x) => x.name === name); assert.ok(s, `${name} listed for Gemini`); return s; };

    const style = byName('acme-style guide');
    assert.equal(style.invoke, '/acme-style-guide', 'its frontmatter name, and the slash command Gemini makes of it');
    assert.equal(style.description, 'Write in the Acme house style.');
    assert.deepEqual([style.accountIds, style.projectIds, style.removable], ['all', 'all', true]);
    const bare = byName('bare');
    assert.match(bare.description, /Gemini CLI skips this one/, 'without a name and description Gemini does not load it, and the listing says so');
    assert.equal(bare.invoke, null);
    assert.ok(!all.some((s) => s.name === 'deeper'), 'one level only');
    assert.ok(listing.groups.some((g) => g.agent === 'codex' && g.skills.some((s) => s.name === 'deeper')) === false, 'nor is it Codex’s: it is not in a Codex folder');

    const shared = gemini.find((g) => g.where === '~/.agents/skills');
    assert.equal(shared?.note, 'Codex reads this folder too.');
    assert.equal(listing.groups.find((g) => g.agent === 'codex' && g.where === '~/.agents/skills')?.note, 'Gemini CLI reads this folder too.');
    assert.deepEqual(byName('release').projectIds, [project.id]);
    assert.ok(byName('review'));
    assert.ok(listing.notes.some((n) => /Gemini CLI’s built-in skills/.test(n) && /only in a folder it trusts/.test(n)));
    const read = await t.owner.call('skills.read', { id: style.id });
    assert.match(read.text, /house style/);

    // Copies go where Gemini reads them: ~/.gemini/skills, or the project's .gemini/skills.
    const review = byName('review');
    const mine = await t.owner.call('skills.copy', { id: review.id, to: { agent: 'gemini' }, preview: true });
    assert.equal(mine.plan.displayDest, '~/.gemini/skills/review');
    assert.equal((await t.owner.call('skills.copy', { id: review.id, to: { agent: 'gemini' }, planId: mine.plan.planId })).done, true);
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'review', 'SKILL.md')));
    const repo = await t.owner.call('skills.copy', { id: style.id, to: { agent: 'gemini', projectId: project.id }, preview: true });
    assert.equal(repo.plan.dest, join(t.projectDir, '.gemini', 'skills', 'style'));
    assert.equal(repo.plan.inProject, true);
    await assert.rejects(t.owner.call('skills.copy', { id: style.id, to: { agent: 'grok' } as never, preview: true }), /which agent/);
  } finally { await t.close(); }
});

test('Gemini sessions read the owner’s own skill folders through links in Wanigan’s Gemini home, which follow the folders and never replace a real one', async () => {
  const t = await testCore({ launcher });
  try {
    const home = join(t.dir, 'home');
    const geminiHome = join(t.core.paths.dataDir, 'gemini-home');
    const start = async () => {
      const project = await t.owner.call('projects.add', { path: t.projectDir }).catch(async () => (await t.owner.call('projects.list', {}))[0]!);
      const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'gemini' });
      await waitFor('the stand-in', async () => /ARGS=/.test((await t.owner.call('sessions.watch', { id: s.id })).replay));
      await t.owner.call('sessions.stop', { id: s.id });
    };
    // No folders of the owner's: no links.
    await start();
    assert.equal(existsSync(join(geminiHome, '.gemini', 'skills')), false);
    assert.equal(existsSync(join(geminiHome, '.agents', 'skills')), false);

    skill(join(home, '.gemini', 'skills', 'style'), front('style', 'House style.'));
    skill(join(home, '.agents', 'skills', 'shared-one'), front('shared-one', 'Shared.'));
    const before = readFileSync(join(home, '.gemini', 'skills', 'style', 'SKILL.md'), 'utf8');
    await start();
    assert.ok(lstatSync(join(geminiHome, '.gemini', 'skills')).isSymbolicLink());
    assert.equal(readlinkSync(join(geminiHome, '.gemini', 'skills')), join(home, '.gemini', 'skills'));
    assert.equal(readlinkSync(join(geminiHome, '.agents', 'skills')), join(home, '.agents', 'skills'));
    assert.ok(existsSync(join(geminiHome, '.gemini', 'skills', 'style', 'SKILL.md')), 'Gemini finds the owner’s skill through it');
    assert.equal(readFileSync(join(home, '.gemini', 'skills', 'style', 'SKILL.md'), 'utf8'), before, 'nothing of the owner’s was written');

    // The owner's folder gone: the link goes with it, so Gemini meets no dangling one.
    const { rmSync } = await import('node:fs');
    rmSync(join(home, '.agents', 'skills'), { recursive: true });
    await start();
    assert.throws(() => lstatSync(join(geminiHome, '.agents', 'skills')));
    // A real folder Gemini made in its home is left as it is.
    mkdirSync(join(geminiHome, '.agents', 'skills', 'made-by-gemini'), { recursive: true });
    skill(join(home, '.agents', 'skills', 'back'), front('back', 'Back again.'));
    await start();
    assert.ok(lstatSync(join(geminiHome, '.agents', 'skills')).isDirectory());
    assert.ok(existsSync(join(geminiHome, '.agents', 'skills', 'made-by-gemini')));
  } finally { await t.close(); }
});
