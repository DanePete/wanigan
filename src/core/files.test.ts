// The code editor's core: what a file read gives, what a save writes, and
// every rule between them (confinement, text only, size, someone else's code,
// a save over someone else's change), each proved on disk through the owner's
// own socket. Fixture folders only; made-up names.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { LiveEvent } from '../shared/live.ts';
import { cleanPath, detectIndent, lineEndings } from '../shared/files.ts';
import { decodeText, encodeText, guardOf } from './files.ts';
import { testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

const put = (root: string, rel: string, content: string | Buffer): string => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const sh = (cwd: string, cmd: string): Promise<string> => new Promise((ok, fail) => execFile('/bin/sh', ['-c', cmd], { cwd }, (e, out) => (e ? fail(e) : ok(String(out)))));
const GIT = '-c user.email=dev@example.test -c user.name=Dev';

test('a path is clean only when it stays relative and names nothing of git’s', () => {
  assert.equal(cleanPath('web/themes/acme/acme.theme'), 'web/themes/acme/acme.theme');
  assert.equal(cleanPath('./src/app.ts'), 'src/app.ts');
  for (const bad of ['', '/etc/passwd', '../outside.txt', 'web/../../x', 'a//b', 'a/./b', '.git/config', 'web/.git/HEAD', 'a\0b', 42, null]) {
    assert.equal(cleanPath(bad), null, `${JSON.stringify(bad)} is refused`);
  }
  assert.equal(cleanPath('', { allowRoot: true }), '', 'the root folder itself, for listing');
});

test('line endings, byte order marks and final newlines come back exactly as they were', () => {
  for (const [label, bytes] of [
    ['LF', Buffer.from('a\nb\n')],
    ['CRLF', Buffer.from('a\r\nb\r\n')],
    ['BOM and CRLF, no final newline', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?php\r\necho 1;')])],
  ] as const) {
    const d = decodeText(bytes);
    assert.ok(!d.text.includes('\r'), `${label}: the editor sees \\n only`);
    assert.deepEqual(encodeText(d.text, d), bytes, `${label}: written back byte for byte`);
  }
  assert.deepEqual(lineEndings('a\r\nb\r\nc\n'), { eol: 'crlf', mixed: true }, 'mixed: the commoner one is kept');
  assert.throws(() => decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])), /binary/);
  assert.throws(() => decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), /not UTF-8/, 'Latin-1 is not opened as if it were UTF-8');
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00])), /UTF-16/);
});

test('indentation is read from the file: tabs, two or four spaces, not a doc comment’s star', () => {
  assert.deepEqual(detectIndent('<?php\nfunction a() {\n\treturn 1;\n}\n'), { unit: '\t', tabSize: 4 });
  assert.deepEqual(detectIndent('a:\n  b:\n    c: 1\n  d: 2\n'), { unit: '  ', tabSize: 2 });
  assert.deepEqual(detectIndent('function a() {\n    if (x) {\n        y();\n    }\n}\n/**\n * doc\n */\n'), { unit: '    ', tabSize: 4 });
  assert.deepEqual(detectIndent('one line\n'), { unit: '  ', tabSize: 2 }, 'nothing indented yet: two spaces');
});

test('someone else’s code is told by what is on disk, not by a folder’s name alone', async () => {
  const t = await testCore();
  try {
    const r = t.projectDir;
    put(r, 'web/core/lib/Drupal.php', '<?php');
    put(r, 'wp/wp-includes/version.php', '<?php');
    put(r, 'composer.json', '{}');
    assert.equal(guardOf(r, 'web/core/modules/system/templates/page.html.twig')?.guard, 'drupal-core');
    assert.match(guardOf(r, 'web/core/lib/Drupal.php')?.reason ?? '', /lost when Drupal updates\. Override it in your theme/);
    assert.equal(guardOf(r, 'src/core/state.ts'), null, 'a folder called core with no Drupal in it is the owner’s');
    assert.equal(guardOf(r, 'web/modules/contrib/token/token.module')?.guard, 'contrib');
    assert.equal(guardOf(r, 'web/themes/contrib/olivero/olivero.theme')?.guard, 'contrib');
    assert.equal(guardOf(r, 'web/modules/custom/acme/acme.module'), null);
    assert.match(guardOf(r, 'vendor/drush/drush/drush.php')?.reason ?? '', /Composer’s vendor folder/);
    assert.equal(guardOf(r, 'node_modules/react/index.js')?.guard, 'node_modules');
    assert.equal(guardOf(r, 'wp/wp-includes/functions.php')?.guard, 'wordpress-core');
    assert.equal(guardOf(r, 'wp/wp-content/plugins/forms/forms.php')?.guard, 'wordpress-plugin');
    assert.equal(guardOf(r, 'wp/wp-content/mu-plugins/acme.php'), null, 'must-use plugins are the site’s own code');
    assert.equal(guardOf(r, 'wp/wp-content/themes/acme/functions.php'), null);
  } finally { await t.close(); }
});

describe('files', () => {
  let t: TestCore;
  let projectId: string;
  const events: { event: string; data: unknown }[] = [];
  const where = (): { projectId: string } => ({ projectId });

  before(async () => {
    t = await testCore();
    put(t.projectDir, 'web/themes/custom/acme/templates/hero.html.twig', '<section class="hero">\n  <h2>{{ title }}</h2>\n</section>\n');
    put(t.projectDir, 'web/themes/custom/acme/css/hero.css', '.hero {\r\n  color: navy;\r\n}\r\n');
    put(t.projectDir, 'web/core/lib/Drupal.php', '<?php\nclass Drupal {}\n');
    put(t.projectDir, 'web/core/modules/system/templates/page.html.twig', '<main>{{ page.content }}</main>\n');
    put(t.projectDir, 'scripts/deploy.sh', '#!/bin/sh\necho deploy\n');
    chmodSync(join(t.projectDir, 'scripts/deploy.sh'), 0o754);
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    t.core.bus.on((event, data) => { if (event === 'live' || event === 'files' || event === 'git') events.push({ event, data }); });
  });
  after(async () => { await t?.close(); });

  test('a read gives the text with \\n line endings, its hash, and how to write it back', async () => {
    const css = await t.owner.call('files.read', { ...where(), path: 'web/themes/custom/acme/css/hero.css' });
    assert.equal(css.text, '.hero {\n  color: navy;\n}\n');
    assert.equal(css.eol, 'crlf');
    assert.equal(css.finalNewline, true);
    assert.equal(css.bom, false);
    assert.equal(css.readOnly, null);
    assert.equal(css.root, t.projectDir);
    assert.equal(css.hash, (await import('node:crypto')).createHash('sha256').update(readFileSync(join(t.projectDir, 'web/themes/custom/acme/css/hero.css'))).digest('hex'));
  });

  test('a save writes the file atomically, keeping its line endings and mode, and leaves no temporary file', async () => {
    const path = 'web/themes/custom/acme/css/hero.css';
    const read = await t.owner.call('files.read', { ...where(), path });
    const saved = await t.owner.call('files.write', { ...where(), path, text: '.hero {\n  color: teal;\n}\n', baseHash: read.hash });
    assert.equal(saved.saved, true);
    assert.equal(readFileSync(join(t.projectDir, path), 'utf8'), '.hero {\r\n  color: teal;\r\n}\r\n', 'CRLF kept');
    assert.deepEqual(readdirSync(join(t.projectDir, 'web/themes/custom/acme/css')), ['hero.css'], 'no temporary file left behind');

    const script = await t.owner.call('files.read', { ...where(), path: 'scripts/deploy.sh' });
    await t.owner.call('files.write', { ...where(), path: 'scripts/deploy.sh', text: '#!/bin/sh\necho deploy now\n', baseHash: script.hash });
    assert.equal(statSync(join(t.projectDir, 'scripts/deploy.sh')).mode & 0o777, 0o754, 'an executable script stays executable, group bits and all');
  });

  test('every save is in the activity, and announced as the live view hears an agent’s edit', async () => {
    events.length = 0;
    const path = 'web/themes/custom/acme/templates/hero.html.twig';
    const read = await t.owner.call('files.read', { ...where(), path });
    await t.owner.call('files.write', { ...where(), path, text: read.text.replace('h2', 'h1').replace('h2', 'h1'), baseHash: read.hash });
    const live = events.filter((e) => e.event === 'live').map((e) => e.data as LiveEvent);
    assert.deepEqual(live, [{ projectId, sessionId: null, cardId: null, paths: [join(t.projectDir, path)], kind: 'edit', at: live[0]?.at }]);
    assert.deepEqual(events.find((e) => e.event === 'files')?.data, { projectId, cardId: null, path });
    assert.ok(events.some((e) => e.event === 'git'), 'the Changes view refetches');
    const activity = await t.owner.call('activity.list', { projectId, limit: 5 });
    assert.equal(activity[0]?.actor, 'owner');
    assert.equal(activity[0]?.verb, 'edited');
    assert.equal(activity[0]?.detail, path);
  });

  test('a save made from an older version writes nothing and hands back the file as it is now', async () => {
    const path = 'web/themes/custom/acme/templates/hero.html.twig';
    const mine = await t.owner.call('files.read', { ...where(), path });
    writeFileSync(join(t.projectDir, path), '<section class="hero hero--wide">\n</section>\n'); // an agent, meanwhile
    const result = await t.owner.call('files.write', { ...where(), path, text: 'mine\n', baseHash: mine.hash });
    assert.equal(result.saved, false);
    assert.ok(!result.saved && result.current.text === '<section class="hero hero--wide">\n</section>\n', 'what is there now comes back');
    assert.equal(readFileSync(join(t.projectDir, path), 'utf8'), '<section class="hero hero--wide">\n</section>\n', 'theirs is untouched');
    await assert.rejects(t.owner.call('files.write', { ...where(), path, text: 'x', baseHash: 'not-a-hash' }), /names the version/);
  });

  test('stat notices a change without the editor reading the file again, and a file that is gone', async () => {
    const path = 'web/themes/custom/acme/templates/hero.html.twig';
    const now = await t.owner.call('files.read', { ...where(), path });
    assert.equal((await t.owner.call('files.stat', { ...where(), path })).hash, now.hash);
    writeFileSync(join(t.projectDir, path), 'changed by another editor, longer than before\n');
    assert.notEqual((await t.owner.call('files.stat', { ...where(), path })).hash, now.hash);
    assert.equal((await t.owner.call('files.stat', { ...where(), path: 'web/themes/custom/acme/gone.twig' })).hash, null);
  });

  test('nothing outside the project, through a link or of git’s own is read or written', async () => {
    put(t.dir, 'elsewhere/secret.txt', 'not the project’s\n');
    symlinkSync(join(t.dir, 'elsewhere/secret.txt'), join(t.projectDir, 'secret-link.txt'));
    symlinkSync(join(t.dir, 'elsewhere'), join(t.projectDir, 'outside'));
    mkdirSync(join(t.projectDir, '.git'), { recursive: true });
    writeFileSync(join(t.projectDir, '.git', 'config'), '[core]\n');
    symlinkSync(join(t.projectDir, '.git', 'config'), join(t.projectDir, 'git-config'));
    symlinkSync(join(t.projectDir, 'web/themes/custom/acme/css/hero.css'), join(t.projectDir, 'hero-link.css'));
    await assert.rejects(t.owner.call('files.read', { ...where(), path: '../elsewhere/secret.txt' }), /not a file in this project/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: join(t.dir, 'elsewhere/secret.txt') }), /not a file in this project/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'secret-link.txt' }), /outside the project through a link/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'outside/secret.txt' }), /outside the project through a link/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: '.git/config' }), /not a file in this project/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'git-config' }), /git’s own records/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'web/themes' }), /is not a file/);
    // A link that stays inside is the file it points to; a save replaces that file, not the link.
    const linked = await t.owner.call('files.read', { ...where(), path: 'hero-link.css' });
    await t.owner.call('files.write', { ...where(), path: 'hero-link.css', text: linked.text.replace('teal', 'plum'), baseHash: linked.hash });
    assert.match(readFileSync(join(t.projectDir, 'web/themes/custom/acme/css/hero.css'), 'utf8'), /plum/);
    assert.ok(statSync(join(t.projectDir, 'hero-link.css'), { throwIfNoEntry: false }) && readdirSync(t.projectDir).includes('hero-link.css'));
    await assert.rejects(t.owner.call('files.dir', { ...where(), path: 'outside' }), /outside the project through a link/);
    await assert.rejects(t.owner.call('files.dir', { ...where(), path: '..' }), /not a folder in this project/);
  });

  test('only text the editor can show opens, up to 2 MB', async () => {
    put(t.projectDir, 'web/themes/custom/acme/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    put(t.projectDir, 'dump.sql', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41));
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'web/themes/custom/acme/logo.png' }), /binary file/);
    await assert.rejects(t.owner.call('files.read', { ...where(), path: 'dump.sql' }), /larger than 2 MB/);
    const small = await t.owner.call('files.read', { ...where(), path: 'scripts/deploy.sh' });
    await assert.rejects(t.owner.call('files.write', { ...where(), path: 'scripts/deploy.sh', text: 'x'.repeat(2 * 1024 * 1024 + 1), baseHash: small.hash }), /larger than the editor writes/);
  });

  test('Drupal core opens read-only with the reason, and is written only when the owner says so', async () => {
    const path = 'web/core/modules/system/templates/page.html.twig';
    const core = await t.owner.call('files.read', { ...where(), path });
    assert.equal(core.guard, 'drupal-core');
    assert.match(core.readOnly ?? '', /^Drupal core: changes here are lost when Drupal updates/);
    await assert.rejects(t.owner.call('files.write', { ...where(), path, text: '<main class="x">{{ page.content }}</main>\n', baseHash: core.hash }), /Choose Edit anyway/);
    assert.equal(readFileSync(join(t.projectDir, path), 'utf8'), '<main>{{ page.content }}</main>\n');
    const saved = await t.owner.call('files.write', { ...where(), path, text: '<main class="x">{{ page.content }}</main>\n', baseHash: core.hash, anyway: true });
    assert.equal(saved.saved, true);
    const activity = await t.owner.call('activity.list', { projectId, limit: 1 });
    assert.equal(activity[0]?.detail, `${path} (someone else’s code, edited anyway)`);
    await assert.rejects(t.owner.call('files.write', { ...where(), path, text: 'x', baseHash: core.hash, anyway: 'yes' as never }), /anyway must be true or false/);
  });

  test('a file the disk will not let the owner write says so, and Edit anyway does not change that', async () => {
    const path = put(t.projectDir, 'locked.txt', 'locked\n');
    chmodSync(path, 0o444);
    const read = await t.owner.call('files.read', { ...where(), path: 'locked.txt' });
    assert.equal(read.guard, 'unwritable');
    await assert.rejects(t.owner.call('files.write', { ...where(), path: 'locked.txt', text: 'x\n', baseHash: read.hash, anyway: true }), /read-only on disk/);
    chmodSync(path, 0o644);
  });

  test('the file names the agent session that last wrote it', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'shell', title: 'Hero spacing' });
    t.core.sessions.hook(s.id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(t.projectDir, 'web/themes/custom/acme/css/hero.css') } });
    const read = await t.owner.call('files.read', { ...where(), path: 'web/themes/custom/acme/css/hero.css' });
    assert.equal(read.lastEdit?.sessionId, s.id);
    assert.equal(read.lastEdit?.title, 'Hero spacing');
    assert.equal(read.lastEdit?.provider, 'shell');
    await t.owner.call('sessions.stop', { id: s.id });
  });

  test('a folder lists folders first, never git’s own', async () => {
    const dir = await t.owner.call('files.dir', { ...where(), path: '' });
    const names = dir.entries.map((e) => `${e.kind}:${e.name}`);
    assert.ok(!names.some((n) => n.endsWith(':.git')));
    assert.ok(names.indexOf('dir:web') < names.indexOf('file:dump.sql'), names.join(' '));
    assert.deepEqual((await t.owner.call('files.dir', { ...where(), path: 'web/themes/custom/acme' })).entries.map((e) => e.name), ['css', 'templates', 'logo.png']);
  });

  test('the editor is the owner’s: a session cannot read or write a file through it', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    try {
      await assert.rejects(agent.call('files.read', { projectId, path: 'scripts/deploy.sh' }), /not available to a session/);
      await assert.rejects(agent.call('files.write', { projectId, path: 'scripts/deploy.sh', text: 'x', baseHash: '0'.repeat(64) }), /not available to a session/);
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: s.id });
    }
  });
});

describe('quick open and worktrees', () => {
  let t: TestCore;
  let projectId: string;

  before(async () => {
    t = await testCore();
    const r = t.projectDir;
    put(r, 'src/app.ts', 'export {};\n');
    put(r, 'src/old.ts', 'gone soon\n');
    put(r, 'web/themes/custom/acme/acme.theme', '<?php\n');
    put(r, 'vendor/autoload.php', '<?php\n');
    put(r, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
    put(r, 'build/out.js', 'built\n');
    put(r, '.gitignore', 'build/\nvendor/\n');
    await sh(r, `git init -q -b main && git ${GIT} add -A && git ${GIT} commit -qm init && rm src/old.ts`);
    put(r, 'src/new.ts', 'untracked but not ignored\n');
    projectId = (await t.owner.call('projects.add', { path: r })).id;
  });
  after(async () => { await t?.close(); });

  test('quick open lists what git sees, leaving out ignored, deleted and installed files', async () => {
    const list = await t.owner.call('files.list', { projectId });
    assert.equal(list.source, 'git');
    assert.deepEqual(list.files, ['.gitignore', 'src/app.ts', 'src/new.ts', 'web/themes/custom/acme/acme.theme']);
    const all = await t.owner.call('files.list', { projectId, installed: true });
    assert.equal(all.installed, true);
    for (const f of ['vendor/autoload.php', 'node_modules/left-pad/index.js', 'build/out.js']) assert.ok(all.files.includes(f), `${f} is there when asked for`);
    assert.ok(!all.files.some((f) => f.startsWith('.git/')), 'never git’s own folder');
  });

  test('a card’s worktree is a root of its own; a card without one is refused', async () => {
    const card = await t.owner.call('cards.create', { projectId, type: 'feature', title: 'Wide hero' });
    const session = await t.owner.call('sessions.start', { projectId, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree?.path as string;
    put(wt, 'src/app.ts', 'export const wide = true;\n');
    const read = await t.owner.call('files.read', { projectId, cardId: card.id, path: 'src/app.ts' });
    assert.equal(read.root, wt);
    assert.equal(read.text, 'export const wide = true;\n');
    await t.owner.call('files.write', { projectId, cardId: card.id, path: 'src/app.ts', text: 'export const wide = false;\n', baseHash: read.hash });
    assert.equal(readFileSync(join(wt, 'src/app.ts'), 'utf8'), 'export const wide = false;\n');
    assert.equal(readFileSync(join(t.projectDir, 'src/app.ts'), 'utf8'), 'export {};\n', 'the project folder is untouched');
    await assert.rejects(t.owner.call('files.read', { projectId, cardId: card.id, path: '.git' }), /not a file in this project/);
    const plain = await t.owner.call('cards.create', { projectId, type: 'task', title: 'No branch' });
    await assert.rejects(t.owner.call('files.read', { projectId, cardId: plain.id, path: 'src/app.ts' }), /no worktree of its own/);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
  });

  test('a folder that is not a repository is walked, still without installed code', async () => {
    const plain = join(t.dir, 'plain');
    put(plain, 'index.html', '<p>hi</p>\n');
    put(plain, 'node_modules/x/index.js', 'x\n');
    const id = (await t.owner.call('projects.add', { path: plain })).id;
    const list = await t.owner.call('files.list', { projectId: id });
    assert.equal(list.source, 'walk');
    assert.deepEqual(list.files, ['index.html']);
  });
});
