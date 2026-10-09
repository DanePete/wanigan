// The live view's core: finding a project's local site from its own files,
// choosing the address, and the events the view follows. Fixture folders only;
// nothing reads the owner's projects or starts ddev.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { LiveEvent } from '../shared/live.ts';
import { detect, devPort, excludeFromGit } from './live.ts';
import { testCore, tokenOf, type TestCore } from './test-support.ts';

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wg-live-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('a ddev Drupal site is found from its own config, with its extra hostnames', () => {
  const root = folder({
    '.ddev/config.yaml': 'name: northwind\ntype: drupal11\ndocroot: web\nadditional_hostnames: [shop]\n',
    '.ddev/config.local.yaml': 'router_https_port: "8443"\n',
    'web/core/lib/Drupal.php': '<?php',
  });
  try {
    const { candidates, ddev } = detect(root);
    assert.equal(ddev?.name, 'northwind');
    assert.deepEqual(candidates.map((c) => [c.url, c.platform, c.source]), [
      ['https://northwind.ddev.site:8443/', 'drupal', 'ddev'],
      ['https://shop.ddev.site/', 'drupal', 'ddev'],
    ]);
    assert.match(candidates[0]?.why ?? '', /ddev project “northwind” \(drupal11\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a WordPress site is found from WP_HOME, a JS app from its dev script, a Lando site from its name', () => {
  const wp = folder({ 'wp-config.php': "<?php\ndefine( 'WP_HOME', 'https://acme.ddev.site' );\ndefine('WP_SITEURL', 'https://acme.ddev.site');\n", 'wp-includes/version.php': '<?php' });
  const app = folder({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --host' } }) });
  const lando = folder({ '.lando.yml': "name: 'harbor'\nrecipe: drupal10\n", 'core/lib/Drupal.php': '<?php' });
  try {
    assert.deepEqual(detect(wp).candidates.map((c) => [c.url, c.platform, c.why]), [['https://acme.ddev.site/', 'wordpress', 'WP_HOME in wp-config.php']]);
    assert.deepEqual(detect(app).candidates.map((c) => [c.url, c.platform]), [['http://localhost:5173/', 'site']]);
    assert.deepEqual(detect(lando).candidates.map((c) => [c.url, c.platform]), [['https://harbor.lndo.site/', 'drupal']]);
    assert.deepEqual(detect(folder({})).candidates, [], 'an empty folder offers nothing');
  } finally { for (const r of [wp, app, lando]) rmSync(r, { recursive: true, force: true }); }
});

test('the port a dev script listens on', () => {
  assert.equal(devPort('vite'), 5173);
  assert.equal(devPort('next dev -p 4000'), 4000);
  assert.equal(devPort('astro dev --port=8080'), 8080);
  assert.equal(devPort('nuxi dev'), 3000);
  assert.equal(devPort('node server.js'), null);
});

describe('live site', () => {
  let t: TestCore;
  let projectId: string;
  const events: { event: string; data: unknown }[] = [];

  before(async () => {
    t = await testCore();
    writeFileSync(join(t.projectDir, 'wp-config.php'), "<?php define('WP_HOME', 'https://shop.ddev.site');");
    mkdirSync(join(t.projectDir, '.ddev'));
    writeFileSync(join(t.projectDir, '.ddev', 'config.yaml'), 'name: shop\ntype: wordpress\n');
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    t.core.bus.on((event, data) => { if (event === 'live' || event === 'liveSite') events.push({ event, data }); });
  });
  after(async () => { await t?.close(); });

  test('until the owner chooses, the site offers what its folder says and opens nothing', async () => {
    const site = await t.owner.call('live.site', { projectId });
    assert.equal(site.url, null);
    assert.equal(site.platform, null);
    assert.equal(site.ddev?.name, 'shop');
    assert.deepEqual(site.candidates.map((c) => c.url), ['https://shop.ddev.site/']);
  });

  test('choosing an address keeps it, guesses the platform from what was found, and says so', async () => {
    const chosen = await t.owner.call('live.setSite', { projectId, url: 'https://shop.ddev.site/' });
    assert.equal(chosen.url, 'https://shop.ddev.site/');
    assert.equal(chosen.platform, 'wordpress');
    assert.deepEqual(events.at(-1), { event: 'liveSite', data: { projectId } });
    const typed = await t.owner.call('live.setSite', { projectId, url: 'localhost:8080', platform: 'site' });
    assert.equal(typed.url, 'https://localhost:8080/', 'a bare host is https');
    assert.equal(typed.platform, 'site');
    await assert.rejects(t.owner.call('live.setSite', { projectId, url: 'file:///etc/passwd' }), /not an http or https address/);
    await assert.rejects(t.owner.call('live.setSite', { projectId, url: 'https://x.test', platform: 'joomla' as never }), /drupal, wordpress or site/);
    const forgotten = await t.owner.call('live.setSite', { projectId, url: null });
    assert.equal(forgotten.url, null);
    assert.equal(forgotten.platform, null);
  });

  test('an agent’s edits, turns and start reach the live view as events, with every file named', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'shell', title: 'Edits' });
    events.length = 0;
    const patch = '*** Begin Patch\n*** Update File: wp-content/themes/astra-child/header.php\n*** Add File: wp-content/themes/astra-child/style.css\n*** End Patch';
    t.core.sessions.hook(s.id, 'UserPromptSubmit', {});
    t.core.sessions.hook(s.id, 'PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } });
    t.core.sessions.hook(s.id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    t.core.sessions.hook(s.id, 'Stop', {});
    const live = events.filter((e) => e.event === 'live').map((e) => e.data as LiveEvent);
    assert.deepEqual(live.map((e) => e.kind), ['turn-start', 'edit', 'turn-end'], 'a command that names no file is not an edit');
    assert.deepEqual(live[1]?.paths, [join(t.projectDir, 'wp-content/themes/astra-child/header.php'), join(t.projectDir, 'wp-content/themes/astra-child/style.css')]);
    assert.ok(live.every((e) => e.projectId === projectId && e.sessionId === s.id && e.cardId === null));
    await t.owner.call('sessions.stop', { id: s.id });
  });

  test('the live view is the owner’s: a session cannot read or change it', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    try {
      await assert.rejects(agent.call('live.site', { projectId }), /not available to a session/);
      await assert.rejects(agent.call('live.setSite', { projectId, url: 'https://x.test' }), /not available to a session/);
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: s.id });
    }
  });
});

describe('words changed by hand', () => {
  let t: TestCore;
  let projectId: string;
  const theme = 'web/themes/custom/acme/templates/block/block--hero.html.twig';
  const contrib = 'web/themes/contrib/basis/basis_base/templates/field/field.html.twig';

  before(async () => {
    t = await testCore();
    mkdirSync(join(t.projectDir, 'web', 'core', 'lib'), { recursive: true });
    writeFileSync(join(t.projectDir, 'web', 'core', 'lib', 'Drupal.php'), '<?php');
    for (const [file, text] of [
      [theme, '<section class="hero">\n  <h2>Don&rsquo;t miss\n    our open house</h2>\n  <a href="/register">{{ \'Register today\'|t }}</a>\n  <p>Free shipping</p><p>Free shipping</p>\n</section>\n'],
      [contrib, '<div>{{ label }}</div>\n'],
    ] as const) {
      mkdirSync(join(t.projectDir, file, '..'), { recursive: true });
      writeFileSync(join(t.projectDir, file), text);
    }
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
  });
  after(async () => { await t?.close(); });

  const read = (): string => readFileSync(join(t.projectDir, theme), 'utf8');

  test('the words are found as the page shows them: any whitespace, the entities a template writes', async () => {
    const found = await t.owner.call('live.findText', { projectId, file: 'themes/custom/acme/templates/block/block--hero.html.twig', text: 'Don’t miss our open house' });
    assert.deepEqual([found.count, found.line, found.refused], [1, 2, null]);
    assert.equal(found.path, realpathSync(join(t.projectDir, theme)));
  });

  test('saved once, with the old words kept so they can be put back; refused where it cannot be sure', async () => {
    const file = 'themes/custom/acme/templates/block/block--hero.html.twig';
    const edit = await t.owner.call('live.saveText', { projectId, file, before: 'Don’t miss our open house', after: 'Join us for the open house & more' });
    assert.match(read(), /<h2>Join us for the open house &amp; more<\/h2>/);
    assert.deepEqual([edit.before, edit.after, edit.line, edit.revertable], ['Don’t miss our open house', 'Join us for the open house & more', 2, true]);
    const twice = await t.owner.call('live.findText', { projectId, file, text: 'Free shipping' });
    assert.match(twice.refused ?? '', /2 times/);
    await assert.rejects(t.owner.call('live.saveText', { projectId, file, before: 'Free shipping', after: 'Fast shipping' }), /2 times/);
    await assert.rejects(t.owner.call('live.saveText', { projectId, file, before: 'Not on the page', after: 'x' }), /content, configuration or a variable/);
    await assert.rejects(t.owner.call('live.saveText', { projectId, file: 'themes/contrib/basis/basis_base/templates/field/field.html.twig', before: 'label', after: 'x' }), /contributed project/);
    await assert.rejects(t.owner.call('live.saveText', { projectId, file: '../../etc/hosts.twig', before: 'x', after: 'y' }), /not in this project/);
    await assert.rejects(t.owner.call('live.saveText', { projectId, file, before: 'Register today', after: "Don't wait" }), /string in the template’s Twig code/);
    const inCode = await t.owner.call('live.saveText', { projectId, file, before: 'Register today', after: 'Sign up now' });
    assert.match(read(), /\{\{ 'Sign up now'\|t \}\}/, 'a Twig string is written as it is: Twig escapes it');
    await t.owner.call('live.revert', { id: inCode.id });
    const back = await t.owner.call('live.revert', { id: edit.id });
    assert.equal(back.revertedAt !== null, true);
    assert.match(read(), /<h2>Don&rsquo;t miss\n {4}our open house<\/h2>/, 'exactly what was there, entity and line break included');
    await assert.rejects(t.owner.call('live.revert', { id: edit.id }), /already put back/);
  });

  test('a revert never undoes later work: the file must be as the edit left it', async () => {
    const file = 'themes/custom/acme/templates/block/block--hero.html.twig';
    const edit = await t.owner.call('live.saveText', { projectId, file, before: 'Don’t miss our open house', after: 'Open house' });
    writeFileSync(join(t.projectDir, theme), `${read()}<!-- an agent was here -->\n`);
    const listed = await t.owner.call('live.edits', { projectId });
    assert.equal(listed[0]?.id, edit.id);
    assert.equal(listed[0]?.revertable, false);
    await assert.rejects(t.owner.call('live.revert', { id: edit.id }), /changed since that edit/);
  });
});

describe('a card’s before and after', () => {
  let t: TestCore;
  let cardId: string;
  let projectId: string;
  /** The smallest PNG there is: one transparent pixel. */
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  before(async () => {
    t = await testCore();
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    cardId = (await t.owner.call('cards.create', { projectId, type: 'task', title: 'Rename a location' })).id;
  });
  after(async () => { await t?.close(); });

  test('a session’s first before is kept, its last after replaces the one before it, and the image comes back as it went in', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'shell', cardId, title: 'Shots' });
    const shot = (kind: 'before' | 'after') => t.owner.call('live.saveShot', { cardId, sessionId: s.id, kind, url: 'https://shop.ddev.site/', data: png, width: 1, height: 1 });
    const first = await shot('before');
    assert.equal(first?.kind, 'before');
    assert.equal(await shot('before'), null, 'a second before for the same session is not kept');
    const a1 = await shot('after');
    const a2 = await shot('after');
    const list = await t.owner.call('live.shots', { cardId });
    assert.deepEqual(list.map((x) => [x.kind, x.id]), [['before', first?.id], ['after', a2?.id]], 'the newer after replaced the older');
    assert.ok(a1 && !list.some((x) => x.id === a1.id));
    assert.equal((await t.owner.call('live.shotImage', { id: first!.id })).data, png);
    await assert.rejects(t.owner.call('live.shotImage', { id: a1!.id }), /No such screenshot/);
    await assert.rejects(t.owner.call('live.saveShot', { cardId, sessionId: s.id, kind: 'after', url: 'https://shop.ddev.site/', data: Buffer.from('not a png').toString('base64'), width: 1, height: 1 }), /not a PNG/);
    await assert.rejects(t.owner.call('live.saveShot', { cardId, sessionId: s.id, kind: 'after', url: 'file:///etc/passwd', data: png, width: 1, height: 1 }), /needs a kind, the page/);
    await t.owner.call('sessions.stop', { id: s.id });
  });

  test('the page a card’s screenshots are of: the site’s address until the owner chooses another', async () => {
    assert.deepEqual(await t.owner.call('live.page', { cardId }), { url: null });
    assert.deepEqual(await t.owner.call('live.setPage', { cardId, url: 'https://shop.ddev.site/checkout' }), { url: 'https://shop.ddev.site/checkout' });
    assert.deepEqual(await t.owner.call('live.page', { cardId }), { url: 'https://shop.ddev.site/checkout' });
    assert.deepEqual(await t.owner.call('live.setPage', { cardId, url: null }), { url: null });
    await assert.rejects(t.owner.call('live.setPage', { cardId, url: 'javascript:alert(1)' }), /not an http or https address/);
  });
});

describe('the Drupal helper, before anything is written', () => {
  let t: TestCore;
  let projectId: string;

  before(async () => {
    t = await testCore();
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
  });
  after(async () => { await t?.close(); });

  test('the plan says what it would write and run, and why it cannot when it cannot', async () => {
    await t.owner.call('live.setSite', { projectId, url: 'https://shop.ddev.site/', platform: 'drupal' });
    const none = await t.owner.call('live.site', { projectId });
    assert.match(none.helperPlan?.refused ?? '', /cannot find Drupal/);
    assert.equal(none.helper, null);
    assert.equal(none.token, null, 'no helper, no token');
    mkdirSync(join(t.projectDir, 'web', 'core', 'lib'), { recursive: true });
    writeFileSync(join(t.projectDir, 'web', 'core', 'lib', 'Drupal.php'), '<?php');
    assert.match((await t.owner.call('live.site', { projectId })).helperPlan?.refused ?? '', /no \.ddev folder/);
    mkdirSync(join(t.projectDir, '.ddev'), { recursive: true });
    writeFileSync(join(t.projectDir, '.ddev', 'config.yaml'), 'name: shop\ntype: drupal11\ndocroot: web\n');
    const plan = (await t.owner.call('live.site', { projectId })).helperPlan;
    assert.equal(plan?.refused, null);
    assert.equal(plan?.folder, join(t.projectDir, 'web', 'modules', 'custom', 'wanigan_live'));
    assert.equal(plan?.exclude, '/web/modules/custom/wanigan_live/');
    assert.ok(plan?.files.includes('wanigan_live.info.yml') && plan.files.includes('src/Controller/LiveController.php'));
    assert.ok(plan?.runs.some((r) => r.startsWith('ddev drush pm:install wanigan_live')));
    assert.ok(plan?.runs.every((r) => !/[0-9a-f]{32}/.test(r)), 'the token is never shown');
  });

  test('installing refuses a site with no helper, and a WordPress site with no WordPress in its folder', async () => {
    await t.owner.call('live.setSite', { projectId, url: 'https://shop.ddev.site/', platform: 'site' });
    await assert.rejects(t.owner.call('live.installHelper', { projectId }), /for Drupal and WordPress sites/);
    await t.owner.call('live.setSite', { projectId, url: 'https://shop.ddev.site/', platform: 'wordpress' });
    assert.match((await t.owner.call('live.site', { projectId })).helperPlan?.refused ?? '', /cannot find WordPress/);
    await assert.rejects(t.owner.call('live.installHelper', { projectId }), /cannot find WordPress/);
    await assert.rejects(t.owner.call('live.removeHelper', { projectId }), /no helper to remove/);
  });

  test('the WordPress helper: one file with its token, kept out of git, and gone again', async () => {
    writeFileSync(join(t.projectDir, 'wp-config.php'), '<?php');
    mkdirSync(join(t.projectDir, 'wp-content', 'mu-plugins'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: t.projectDir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const plan = (await t.owner.call('live.site', { projectId })).helperPlan;
    assert.deepEqual([plan?.refused, plan?.files, plan?.runs, plan?.exclude], [null, ['wanigan-live.php'], [], '/wp-content/mu-plugins/wanigan-live.php']);
    const file = join(t.projectDir, 'wp-content', 'mu-plugins', 'wanigan-live.php');
    writeFileSync(file, '<?php // someone else’s');
    await assert.rejects(t.owner.call('live.installHelper', { projectId }), /Wanigan did not write it/);
    rmSync(file);
    const site = await t.owner.call('live.installHelper', { projectId });
    assert.equal(site.helper?.kind, 'wordpress');
    assert.match(site.token ?? '', /^[0-9a-f]{48}$/);
    assert.ok(readFileSync(file, 'utf8').includes(`WANIGAN_LIVE_TOKEN = '${site.token}'`));
    assert.ok(readFileSync(file, 'utf8').includes("WANIGAN_LIVE_SITE_DIR = '';"), 'WordPress is the project’s own folder');
    assert.deepEqual([site.helper?.version, site.helper?.outdated], [2, false]);
    // A helper an older Wanigan wrote says this one writes a newer one.
    t.core.db.prepare('UPDATE live_sites SET helper = ? WHERE project_id = ?').run(JSON.stringify({ kind: 'wordpress', version: 1 }), projectId);
    assert.equal((await t.owner.call('live.site', { projectId })).helper?.outdated, true);
    assert.ok(readFileSync(join(t.projectDir, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/wp-content/mu-plugins/wanigan-live.php'));
    const gone = await t.owner.call('live.removeHelper', { projectId });
    assert.equal(gone.helper, null);
    assert.equal(existsSync(file), false);
    assert.ok(!readFileSync(join(t.projectDir, '.git', 'info', 'exclude'), 'utf8').includes('wanigan-live.php'));
  });

  test('a WordPress in a docroot folder is told where it sits, so its trace names files from the project’s root', async () => {
    const w = await testCore();
    try {
      const id = (await w.owner.call('projects.add', { path: w.projectDir })).id;
      mkdirSync(join(w.projectDir, '.ddev'), { recursive: true });
      writeFileSync(join(w.projectDir, '.ddev', 'config.yaml'), 'name: northwind\ntype: wordpress\ndocroot: web\n');
      mkdirSync(join(w.projectDir, 'web', 'wp-content'), { recursive: true });
      writeFileSync(join(w.projectDir, 'web', 'wp-config.php'), '<?php');
      await w.owner.call('live.setSite', { projectId: id, url: 'https://northwind.ddev.site/', platform: 'wordpress' });
      const plan = (await w.owner.call('live.site', { projectId: id })).helperPlan;
      assert.equal(plan?.folder, join(w.projectDir, 'web', 'wp-content', 'mu-plugins'));
      await w.owner.call('live.installHelper', { projectId: id });
      assert.ok(readFileSync(join(plan?.folder ?? '', 'wanigan-live.php'), 'utf8').includes("WANIGAN_LIVE_SITE_DIR = 'web';"));
      await w.owner.call('live.removeHelper', { projectId: id });
      assert.equal(existsSync(join(plan?.folder ?? '', 'wanigan-live.php')), false);
    } finally { await w.close(); }
  });

  test('the exclude line goes into the repository’s own exclude file, once, and comes out again', async () => {
    const repo = folder({ 'web/index.php': '<?php' });
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      const exclude = join(repo, '.git', 'info', 'exclude');
      writeFileSync(exclude, '# the owner’s own\n.worktrees/\n');
      const module = join(repo, 'web', 'modules', 'custom', 'wanigan_live');
      await excludeFromGit(repo, module);
      await excludeFromGit(repo, module);
      const added = readFileSync(exclude, 'utf8');
      assert.equal(added.split('\n').filter((l) => l === '/web/modules/custom/wanigan_live/').length, 1);
      assert.match(added, /^# the owner’s own\n\.worktrees\//, 'what was there stays');
      await excludeFromGit(repo, module, false);
      assert.equal(readFileSync(exclude, 'utf8').trimEnd(), '# the owner’s own\n.worktrees/');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
