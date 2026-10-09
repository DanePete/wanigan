// A site's hosted environments, found in a made-up project's own files and
// kept by the owner; and the areas comparisons ignore. Nothing here reaches a
// site: the files are fixtures (acme, northwind), and the core only reads them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { detectEnvs } from './live-envs.ts';
import { testCore, tokenOf, type TestCore } from './test-support.ts';

/** A made-up Drupal project on Pantheon, as its repository would have it. */
const ACME: Record<string, string> = {
  '.ddev/config.yaml': 'name: acme\ntype: drupal11\ndocroot: web\nweb_environment:\n  - STAGE_FILE_PROXY_URL=https://www.acme.example\n  - PROD_URL=https://www.acme.example\n',
  '.ddev/providers/pantheon.yaml': '#ddev-generated\n# project: yourproject.dev\nenvironment_variables:\n  project: acme.live\n',
  'pantheon.yml': 'api_version: 1\nphp_version: 8.3\n',
  'drush/sites/acme.site.yml': 'live:\n  host: appserver.live.acme.example\n  uri: https://www.acme.example\nlocal:\n  uri: https://acme.ddev.site\n',
  'web/sites/default/settings.php': "<?php\n$config['stage_file_proxy.settings']['origin'] = 'https://www.acme.example';\n",
  'web/core/lib/Drupal.php': '<?php',
  'README.md': '# Acme\n\n| Environment | Address |\n|---|---|\n| Staging | https://staging.acme.example |\n',
  '.env': 'PROD_URL=https://secret.acme.example\nAPI_TOKEN=never-read\n',
};

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wg-envs-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('every environment the project’s files name, each with the file it is in; never a .env file', () => {
  const root = folder(ACME);
  try {
    const found = detectEnvs(root);
    assert.deepEqual(found.map((c) => [c.name, c.url, c.file]), [
      ['Live', 'https://www.acme.example/', 'drush/sites/acme.site.yml'],
      ['Dev', 'https://dev-acme.pantheonsite.io/', '.ddev/providers/pantheon.yaml'],
      ['Test', 'https://test-acme.pantheonsite.io/', '.ddev/providers/pantheon.yaml'],
      ['Live', 'https://live-acme.pantheonsite.io/', '.ddev/providers/pantheon.yaml'],
      ['Live', 'https://www.acme.example/', 'web/sites/default/settings.php'],
      ['Live', 'https://www.acme.example/', '.ddev/config.yaml'],
      ['Prod', 'https://www.acme.example/', '.ddev/config.yaml'],
      ['Staging', 'https://staging.acme.example/', 'README.md'],
    ]);
    assert.ok(!found.some((c) => c.url.includes('secret')), 'a .env file is never read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a WordPress project’s WP-CLI aliases and a compose file’s variables; a link out of the project is not followed', () => {
  const outside = folder({ 'wp-cli.yml': '@production:\n  url: https://outside.example\n' });
  const root = folder({
    'wp-cli.yml': '@staging:\n  url: https://staging.northwind.example\n@production:\n  url: https://northwind.example\n',
    'docker-compose.yml': 'services:\n  web:\n    environment:\n      - LIVE_URL=https://northwind.example\n',
  });
  mkdirSync(join(root, 'drush', 'sites'), { recursive: true });
  symlinkSync(join(outside, 'wp-cli.yml'), join(root, 'drush', 'sites', 'away.site.yml'));
  try {
    assert.deepEqual(detectEnvs(root).map((c) => [c.name, c.url, c.file]), [
      ['Staging', 'https://staging.northwind.example/', 'wp-cli.yml'],
      ['Production', 'https://northwind.example/', 'wp-cli.yml'],
      ['Live', 'https://northwind.example/', 'docker-compose.yml'],
    ]);
  } finally { for (const r of [root, outside]) rmSync(r, { recursive: true, force: true }); }
});

describe('kept environments', () => {
  let t: TestCore;
  let projectId: string;
  const events: string[] = [];

  before(async () => {
    t = await testCore();
    for (const [name, text] of Object.entries(ACME)) {
      mkdirSync(join(t.projectDir, name, '..'), { recursive: true });
      writeFileSync(join(t.projectDir, name), text);
    }
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    await t.owner.call('live.setSite', { projectId, url: 'https://acme.ddev.site/' });
    t.core.bus.on((event, data) => { if (event === 'liveSite' && (data as { projectId: string }).projectId === projectId) events.push(event); });
  });
  after(async () => { await t?.close(); });

  test('until the owner keeps one, the files offer candidates in tab order, one per address, and there are no tabs', async () => {
    const envs = await t.owner.call('live.envs', { projectId });
    assert.deepEqual(envs.envs, []);
    assert.deepEqual(envs.candidates.map((c) => [c.name, c.url]), [
      ['Dev', 'https://dev-acme.pantheonsite.io/'],
      ['Test', 'https://test-acme.pantheonsite.io/'],
      ['Staging', 'https://staging.acme.example/'],
      ['Live', 'https://www.acme.example/'],
      ['Live', 'https://live-acme.pantheonsite.io/'],
    ]);
    assert.equal(envs.candidates[3]?.file, 'drush/sites/acme.site.yml', 'the first file to name an address is the one shown');
    assert.deepEqual(envs.masks, []);
  });

  test('kept, they are tabs in Dev, Test, Live order, saying where each was found; kept ones are no longer offered', async () => {
    events.length = 0;
    await t.owner.call('live.setEnv', { projectId, name: 'Live', url: 'https://live-acme.pantheonsite.io' });
    await t.owner.call('live.setEnv', { projectId, name: 'Dev', url: 'https://dev-acme.pantheonsite.io/' });
    const envs = await t.owner.call('live.setEnv', { projectId, name: 'Shop', url: 'https://shop.acme.example/' });
    assert.deepEqual(envs.envs.map((e) => [e.name, e.url]), [['Dev', 'https://dev-acme.pantheonsite.io/'], ['Live', 'https://live-acme.pantheonsite.io/'], ['Shop', 'https://shop.acme.example/']]);
    assert.match(envs.envs[0]?.found ?? '', /^\.ddev\/providers\/pantheon\.yaml: Pantheon’s dev address/);
    assert.equal(envs.envs[2]?.found, null, 'a typed address says so');
    assert.ok(!envs.candidates.some((c) => c.url === 'https://dev-acme.pantheonsite.io/'));
    assert.equal(events.length, 3, 'each change tells the window');
  });

  test('renamed and readdressed in place; names and addresses are each kept once', async () => {
    const shop = (await t.owner.call('live.envs', { projectId })).envs.find((e) => e.name === 'Shop')!;
    const renamed = await t.owner.call('live.setEnv', { projectId, id: shop.id, name: 'Test', url: 'https://test-acme.pantheonsite.io/' });
    assert.deepEqual(renamed.envs.map((e) => e.name), ['Dev', 'Test', 'Live']);
    assert.match(renamed.envs[1]?.found ?? '', /Pantheon’s test address/, 'a new address that the files name says which file');
    await assert.rejects(t.owner.call('live.setEnv', { projectId, name: 'live', url: 'https://other.acme.example' }), /already an environment called live/);
    await assert.rejects(t.owner.call('live.setEnv', { projectId, name: 'Prod', url: 'https://live-acme.pantheonsite.io/' }), /Live already has that address/);
    await assert.rejects(t.owner.call('live.setEnv', { projectId, id: 'nope', name: 'X', url: 'https://x.acme.example' }), /No such environment/);
  });

  test('only https, no credentials, no query, never this Mac or the local site', async () => {
    const no = (url: string, why: RegExp) => assert.rejects(t.owner.call('live.setEnv', { projectId, name: 'Other', url }), why);
    await no('http://www.acme.example', /must be https/);
    await no('https://admin:secret@www.acme.example', /user name and password/);
    await no('https://www.acme.example/?key=1', /query/);
    await no('https://localhost:8443', /on this Mac/);
    await no('https://acme.ddev.site', /on this Mac/);
    await assert.rejects(t.owner.call('live.setEnv', { projectId, name: 'Local', url: 'https://www.acme.example' }), /Local is the site on this Mac/);
    assert.equal((await t.owner.call('live.envs', { projectId })).envs.length, 3, 'nothing refused was kept');
  });

  test('removed, an environment is a candidate again', async () => {
    const dev = (await t.owner.call('live.envs', { projectId })).envs.find((e) => e.name === 'Dev')!;
    const after = await t.owner.call('live.removeEnv', { projectId, id: dev.id });
    assert.deepEqual(after.envs.map((e) => e.name), ['Test', 'Live']);
    assert.ok(after.candidates.some((c) => c.url === 'https://dev-acme.pantheonsite.io/'));
    await assert.rejects(t.owner.call('live.removeEnv', { projectId, id: dev.id }), /No such environment/);
  });

  test('ignored areas: one page or every page, at one width, whole pixels; removed by id', async () => {
    const one = await t.owner.call('live.mask', { projectId, path: '/news', width: 1440, rect: { x: 0, y: 120, width: 1440, height: 400 }, label: 'Slideshow' });
    const every = await t.owner.call('live.mask', { projectId, path: null, width: 390, rect: { x: 10, y: 2000, width: 200, height: 20 } });
    assert.deepEqual(one.masks.map((m) => [m.path, m.width, m.label]), [['/news', 1440, 'Slideshow']]);
    assert.deepEqual(every.masks.map((m) => [m.path, m.rect]), [['/news', { x: 0, y: 120, width: 1440, height: 400 }], [null, { x: 10, y: 2000, width: 200, height: 20 }]]);
    await assert.rejects(t.owner.call('live.mask', { projectId, path: 'news', width: 1440, rect: { x: 0, y: 0, width: 1, height: 1 } }), /begins with a slash/);
    await assert.rejects(t.owner.call('live.mask', { projectId, path: null, width: 1000, rect: { x: 0, y: 0, width: 1, height: 1 } }), /390, 768, 1440/);
    await assert.rejects(t.owner.call('live.mask', { projectId, path: null, width: 768, rect: { x: 0, y: 0, width: 0.5, height: 1 } }), /whole pixels/);
    const left = await t.owner.call('live.unmask', { projectId, id: one.masks[0]!.id });
    assert.equal(left.masks.length, 1);
    await assert.rejects(t.owner.call('live.unmask', { projectId, id: one.masks[0]!.id }), /No such ignored area/);
  });

  test('environments are the owner’s: a session can neither read nor change them', async () => {
    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    try {
      await assert.rejects(agent.call('live.envs', { projectId }), /not available to a session/);
      await assert.rejects(agent.call('live.setEnv', { projectId, name: 'Live', url: 'https://www.acme.example' }), /not available to a session/);
      await assert.rejects(agent.call('live.mask', { projectId, path: null, width: 1440, rect: { x: 0, y: 0, width: 1, height: 1 } }), /not available to a session/);
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: s.id });
    }
  });
});
