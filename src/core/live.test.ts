// The live view's core: finding a project's local site from its own files,
// choosing the address, and the events the view follows. Fixture folders only;
// nothing reads the owner's projects or starts ddev.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { LiveEvent } from '../shared/live.ts';
import { detect, devPort, excludeFromGit } from './live.ts';
import { testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

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
    assert.ok(readFileSync(join(t.projectDir, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/wp-content/mu-plugins/wanigan-live.php'));
    const gone = await t.owner.call('live.removeHelper', { projectId });
    assert.equal(gone.helper, null);
    assert.equal(existsSync(file), false);
    assert.ok(!readFileSync(join(t.projectDir, '.git', 'info', 'exclude'), 'utf8').includes('wanigan-live.php'));
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

/**
 * A stand-in ddev, put on the test core's own PATH (the owner's ddev is never
 * on it): it writes each call to a log, answers `describe -j` with the state in
 * a file beside it, shaped as ddev 1.25 writes it, and `start` or `restart`
 * prints a few lines (with ddev's colours) and sets that state to running.
 */
const STAND_IN_DDEV = `#!/bin/sh
here=$(dirname "$0")
echo "$PWD|$*" >> "$here/ddev-calls"
state=$(cat "$here/ddev-state" 2>/dev/null || echo paused)
case "$1" in
  describe)
    printf '{"level":"info","msg":"Project: acme","raw":{"approot":"%s","hostname":"acme.ddev.site","hostnames":["acme.ddev.site"],"name":"acme","primary_url":"https://acme.ddev.site","router":"traefik","router_status":"healthy","services":{"web":{"status":"exited"}},"status":"%s","status_desc":"%s","type":"wordpress"},"time":"2026-10-09T21:14:03-05:00"}\\n' "$PWD" "$state" "$state" ;;
  start|restart)
    [ -f "$here/ddev-slow" ] && sleep 1
    if [ "$state" = broken ]; then echo 'Failed to start acme: web container failed to become ready' >&2; exit 1; fi
    echo "Starting acme..."
    printf '\\033[32mContainer ddev-acme-web  Started\\033[0m\\r\\n'
    echo running > "$here/ddev-state"
    echo "Successfully started acme"
    echo "Your project can be reached at https://acme.ddev.site" ;;
  *) echo "the stand-in does not know $1" >&2; exit 2 ;;
esac
`;

describe('whether the site runs, and starting it', () => {
  let t: TestCore;
  let projectId: string;
  let bin: string;
  const runs: { event: string; data: unknown }[] = [];
  const calls = (): string[] => (existsSync(join(bin, 'ddev-calls')) ? readFileSync(join(bin, 'ddev-calls'), 'utf8').trim().split('\n') : []);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme', GIT_AUTHOR_EMAIL: 'dev@example.test', GIT_COMMITTER_NAME: 'Acme', GIT_COMMITTER_EMAIL: 'dev@example.test' };

  before(async () => {
    t = await testCore();
    bin = join(t.dir, 'bin');
    mkdirSync(join(t.projectDir, '.ddev'), { recursive: true });
    writeFileSync(join(t.projectDir, '.ddev', 'config.yaml'), 'name: acme\ntype: wordpress\ndocroot: ""\n');
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    await t.owner.call('live.setSite', { projectId, url: 'https://acme.ddev.site/' });
    t.core.bus.on((event, data) => { if (event === 'liveRun') runs.push({ event, data }); });
  });
  after(async () => { await t?.close(); });

  test('with no ddev on its PATH, Wanigan says so and starts nothing', async () => {
    const status = await t.owner.call('live.status', { projectId });
    assert.deepEqual(status.run, { tool: 'ddev', state: 'no-ddev', said: null, start: 'ddev start', folder: t.projectDir, name: 'acme' });
    await assert.rejects(t.owner.call('live.start', { projectId }), /ddev is not installed/);
  });

  test('a paused site: ddev is asked in the folder the site serves, and its words come back', async () => {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ddev'), STAND_IN_DDEV, { mode: 0o755 });
    const status = await t.owner.call('live.status', { projectId });
    assert.deepEqual(status.run, { tool: 'ddev', state: 'paused', said: 'paused', start: 'ddev start', folder: t.projectDir, name: 'acme' });
    assert.deepEqual(status.hostnames, ['acme.ddev.site']);
    assert.deepEqual(status.certificates, []);
    assert.equal(status.busy, null);
    assert.deepEqual(calls(), [`${t.projectDir}|describe -j`], 'asking is one describe, and nothing else');
  });

  test('a certificate the project keeps where ddev looks: its file, its key, that git tracks it, and what it says of itself', async () => {
    const certs = join(t.projectDir, '.ddev', 'traefik', 'certs');
    mkdirSync(certs, { recursive: true });
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'live-northwind-wildcard.crt'), 'utf8');
    writeFileSync(join(certs, 'northwind.crt'), fixture);
    writeFileSync(join(certs, 'northwind.key'), 'a stand-in for the key that came with it\n');
    writeFileSync(join(certs, 'notes.pem'), 'not a certificate\n');
    execFileSync('git', ['init', '-q'], { cwd: t.projectDir, env: gitEnv });
    execFileSync('git', ['add', '.ddev/traefik/certs/northwind.crt'], { cwd: t.projectDir, env: gitEnv });
    execFileSync('git', ['commit', '-qm', 'Keep the certificate'], { cwd: t.projectDir, env: gitEnv });
    const [kept, ...more] = (await t.owner.call('live.status', { projectId })).certificates;
    assert.equal(more.length, 0, 'a file that is not a certificate is left out');
    assert.deepEqual([kept?.file, kept?.key, kept?.tracked, kept?.generated], ['.ddev/traefik/certs/northwind.crt', '.ddev/traefik/certs/northwind.key', true, true]);
    assert.equal(kept?.certificate.fingerprint, new X509Certificate(fixture.slice(fixture.indexOf('-----BEGIN'))).fingerprint256);
    assert.deepEqual(kept?.certificate.issuer, { cn: 'mkcert pat@northwind-laptop.local', o: 'mkcert development CA', ou: 'pat@northwind-laptop.local (Pat Example)' });
    assert.ok(kept?.certificate.names.includes('*.ddev.site'));
    assert.equal(kept?.certificate.validTo, Date.UTC(2025, 5, 1));
  });

  test('Start it runs ddev start in the site’s folder, says each line as it comes, and answers with the site running', async () => {
    runs.length = 0;
    const done = await t.owner.call('live.start', { projectId });
    assert.equal(done.ok, true);
    assert.equal(done.command, 'ddev start');
    assert.equal(done.folder, t.projectDir);
    assert.deepEqual(done.output, ['Starting acme...', 'Container ddev-acme-web  Started', 'Successfully started acme', 'Your project can be reached at https://acme.ddev.site'], 'colours and carriage returns gone');
    assert.equal(done.status.run.state, 'running');
    assert.equal(done.status.busy, null);
    assert.ok(calls().includes(`${t.projectDir}|start`));
    const events = runs.map((r) => r.data as { line: string | null; done: boolean; ok: boolean | null; command: string; projectId: string });
    assert.deepEqual(events.map((e) => e.line), [null, ...done.output, null]);
    assert.deepEqual(events.at(-1), { projectId, command: 'ddev start', line: null, done: true, ok: true });
    assert.ok(events.slice(0, -1).every((e) => !e.done));
  });

  test('a restart is one at a time; a failed start says so with ddev’s words; a session cannot start a site', async () => {
    writeFileSync(join(bin, 'ddev-slow'), '');
    const first = t.owner.call('live.start', { projectId, restart: true });
    await waitFor('the restart to begin', () => runs.some((r) => (r.data as { command: string }).command === 'ddev restart'));
    assert.equal((await t.owner.call('live.status', { projectId })).busy?.command, 'ddev restart', 'a view opened meanwhile sees it going');
    await assert.rejects(t.owner.call('live.start', { projectId }), /ddev restart is already running for this site/);
    assert.equal((await first).ok, true);
    assert.ok(calls().includes(`${t.projectDir}|restart`));
    rmSync(join(bin, 'ddev-slow'));

    writeFileSync(join(bin, 'ddev-state'), 'broken\n');
    const failed = await t.owner.call('live.start', { projectId });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.output, ['Failed to start acme: web container failed to become ready']);
    assert.equal(failed.status.run.state, 'other');
    assert.equal(failed.status.run.said, 'broken');

    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    try {
      await assert.rejects(agent.call('live.status', { projectId }), /not available to a session/);
      await assert.rejects(agent.call('live.start', { projectId }), /not available to a session/);
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: s.id });
    }
    await assert.rejects(t.owner.call('live.start', { projectId, restart: 'yes' as never }), /restart must be true or false/);
  });

  test('Lando and a dev script are named, never asked or run; a project with no ddev config is not started with ddev', async () => {
    const before = calls().length;
    // Projects are kept by their real path (/var is /private/var).
    const lando = realpathSync(folder({ '.lando.yml': "name: 'harbor'\nrecipe: drupal10\n" }));
    const app = realpathSync(folder({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --port 5174' } }), 'package-lock.json': '{}' }));
    try {
      const landoId = (await t.owner.call('projects.add', { path: lando })).id;
      await t.owner.call('live.setSite', { projectId: landoId, url: 'https://harbor.lndo.site/' });
      assert.deepEqual((await t.owner.call('live.status', { projectId: landoId })).run, { tool: 'lando', state: null, said: null, start: 'lando start', folder: lando, name: null });
      await assert.rejects(t.owner.call('live.start', { projectId: landoId }), /has no ddev config \(\.ddev\/config\.yaml\), so Wanigan cannot start its site with ddev/);
      const appId = (await t.owner.call('projects.add', { path: app })).id;
      await t.owner.call('live.setSite', { projectId: appId, url: 'http://localhost:5174/' });
      assert.deepEqual((await t.owner.call('live.status', { projectId: appId })).run, { tool: 'script', state: null, said: null, start: 'npm run dev', folder: app, name: null });
      await t.owner.call('live.setSite', { projectId: appId, url: 'https://example.test/' });
      assert.equal((await t.owner.call('live.status', { projectId: appId })).run.tool, null, 'an address nothing in the project names: no guess');
      assert.equal(calls().length, before, 'ddev was not asked');
    } finally { for (const r of [lando, app]) rmSync(r, { recursive: true, force: true }); }
  });
});

describe('a card’s missed before and after', () => {
  let t: TestCore;
  let cardId: string;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  before(async () => {
    t = await testCore();
    const projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    cardId = (await t.owner.call('cards.create', { projectId, type: 'task', title: 'Rename a location' })).id;
  });
  after(async () => { await t?.close(); });

  test('why a screenshot was not taken is kept, one a kind, until one of that kind is', async () => {
    const reason = 'This site isn’t running. ddev says it is paused.';
    const miss = await t.owner.call('live.shotMissed', { cardId, sessionId: null, kind: 'before', url: 'https://acme.ddev.site/', reason });
    assert.deepEqual([miss.kind, miss.reason, miss.url], ['before', reason, 'https://acme.ddev.site/']);
    await t.owner.call('live.shotMissed', { cardId, sessionId: null, kind: 'before', url: 'https://acme.ddev.site/', reason: 'Nothing answered at acme.ddev.site.' });
    await t.owner.call('live.shotMissed', { cardId, sessionId: null, kind: 'after', url: 'https://acme.ddev.site/', reason });
    assert.deepEqual((await t.owner.call('live.shotMisses', { cardId })).map((m) => [m.kind, m.reason]).sort(),
      [['after', reason], ['before', 'Nothing answered at acme.ddev.site.']], 'the newer reason replaced the older');
    await t.owner.call('live.saveShot', { cardId, sessionId: null, kind: 'before', url: 'https://acme.ddev.site/', data: png, width: 1, height: 1 });
    assert.deepEqual((await t.owner.call('live.shotMisses', { cardId })).map((m) => m.kind), ['after'], 'a before taken clears the missed before');
    await assert.rejects(t.owner.call('live.shotMissed', { cardId, sessionId: null, kind: 'during' as never, url: 'https://acme.ddev.site/', reason }), /needs its kind/);
    await assert.rejects(t.owner.call('live.shotMissed', { cardId, sessionId: null, kind: 'after', url: 'https://acme.ddev.site/', reason: '   ' }), /needs its kind/);
  });
});
